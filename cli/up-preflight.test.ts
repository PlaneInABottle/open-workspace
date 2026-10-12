/** P2-B preflight: read-only gate (no mutation, no gating). M2/M3
 * unlanded: provenance = live-config lens, readiness = recorded
 * lastReadiness (+ `--probe` one-shot TCP). Live exec verified only via
 * the injected TCP counter. */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { tcpListening } from "./up-net"
import { ensureUpStateDir, readLstart, upPaths, writeSupervisorState, type UpServiceState } from "./up-state"
import { evaluatePreflight, measureTcpPorts, runPreflight } from "./up-preflight"

const ownedProcs: { kill: (signal?: string) => void }[] = []
const ownedServers: { stop: (force?: boolean) => void }[] = []

afterEach(async () => {
  for (const proc of ownedProcs.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const srv of ownedServers.splice(0)) {
    try {
      srv.stop(true)
    } catch {
      // already gone
    }
  }
})

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-p2b-"))

const capture = (): { out: string[]; err: string[]; restore: () => void } => {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]): void => {
    out.push(args.map(String).join(" "))
  }
  console.error = (...args: unknown[]): void => {
    err.push(args.map(String).join(" "))
  }
  return { out, err, restore: () => {
    console.log = origLog
    console.error = origError
  } }
}

const sleeper = async (secs = 30): Promise<{ pid: number; lstart: string }> => {
  const proc = Bun.spawn(["sleep", String(secs)], { stdout: "ignore", stderr: "ignore" })
  ownedProcs.push(proc)
  const lstart = (await readLstart(proc.pid))!
  return { pid: proc.pid, lstart }
}

const stateOf = (entries: Record<string, unknown>[]): UpServiceState[] =>
  entries as unknown as UpServiceState[]

const writeState = async (root: string, services: Record<string, unknown>[]): Promise<void> => {
  const paths = upPaths(root)
  await ensureUpStateDir(paths.stateDir)
  await writeSupervisorState(paths.supervisorFile, {
    version: 1,
    startedAt: "2026-10-09T08:00:00.000Z",
    services: stateOf(services),
  })
}

const writeRun = async (root: string, run: string, text: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
  await writeFile(join(root, ".ow", "checkpoints", `${run}.jsonl`), text, "utf8")
}

const FRESH_RUN = [
  `{"stage":"build","status":"confirmed","proof":{"ok":true},"at":"2026-10-09T08:00:00.000Z","by":"runner","code":{"script_hash":"h1","checkout_rev":"r1"},"runtime":{"port":1,"cwd":"/r","provenance_rev":"r1"}}`,
  `{"stage":"test","status":"confirmed","proof":{"ok":true},"at":"2026-10-09T08:05:00.000Z","by":"runner","code":{"script_hash":"h1","checkout_rev":"r1"},"runtime":{"port":1,"cwd":"/r","provenance_rev":"r1"}}`,
].join("\n") + "\n"

const STALE_RUN = [
  `{"stage":"build","status":"confirmed","proof":{"ok":true},"at":"2026-10-09T08:00:00.000Z","by":"runner","code":{"script_hash":"h1","checkout_rev":"r1"},"runtime":{"port":1}}`,
  `{"stage":"build","status":"confirmed","proof":{"ok":true},"at":"2026-10-09T09:00:00.000Z","by":"runner","code":{"script_hash":"h2","checkout_rev":"r1"},"runtime":{"port":1}}`,
].join("\n") + "\n"

describe("measureTcpPorts (budget)", () => {
  test("open port true, closed false", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    ownedServers.push(srv)
    const open = await measureTcpPorts({ ports: [srv.port] })
    expect(open.get(srv.port)).toBe(true)
    srv.stop(true)
    const closed = await measureTcpPorts({ ports: [srv.port] })
    expect(closed.get(srv.port)).toBe(false)
  })

  test("hanging probe hits the budget (unmeasured), rest uncalled", async () => {
    let calls = 0
    const hanging = async (_port: number): Promise<boolean> => {
      calls += 1
      await new Promise(() => undefined)
    }
    const out = await measureTcpPorts({ ports: [48011, 48012], tcpCheck: hanging, budgetMs: 10, perServiceMs: 50 })
    expect(out.get(48011)).toBe("unmeasured")
    expect(out.get(48012)).toBe("unmeasured")
    expect(calls).toBe(1)
  })
})

describe("evaluatePreflight (pure composition)", () => {
  const liveOf = (names: string[]): Map<string, "live"> => new Map(names.map((name) => [name, "live" as const]))

  test("recorded-ready + live TCP → pass", () => {
    const running = [{ name: "a", pid: 1, lstart: "l", startedAt: "t", cmd: "sleep 30", port: 1, lastReadiness: { ok: true } } as unknown as UpServiceState]
    const result = evaluatePreflight({
      expected: [{ name: "a", cmd: "sleep 30", port: 1 }],
      running,
      liveness: liveOf(["a"]) as Map<string, never>,
      tcpResults: new Map([[1, true]]),
      envelopes: [],
    })
    expect(result.pass).toBe(true)
    expect(result.missing).toEqual([])
    // M2 4th gate (boundary): appended LAST - old 3 gates keep shape/order.
    expect(result.gates.map((gate) => gate.pass)).toEqual([true, true, true, true])
  })

  test("TCP closed → port-closed; unmeasured → unmeasured", () => {
    const base = {
      expected: [{ name: "a", cmd: "sleep 30", port: 1 }],
      running: [{ name: "a", pid: 1, lstart: "l", startedAt: "t", cmd: "sleep 30", port: 1, lastReadiness: { ok: true } } as unknown as UpServiceState],
      liveness: liveOf(["a"]) as Map<string, never>,
      envelopes: [],
    }
    const closed = evaluatePreflight({ ...base, tcpResults: new Map([[1, false]]) })
    expect(closed.pass).toBe(false)
    expect(closed.missing).toContain("readiness:a:port-closed")
    const unmeasured = evaluatePreflight({ ...base, tcpResults: new Map([[1, "unmeasured"]]) })
    expect(unmeasured.pass).toBe(false)
    expect(unmeasured.missing).toContain("readiness:a:unmeasured")
  })
})

describe("preflight CLI (fixture composition)", () => {
  const fixture = async (yaml: string): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, yaml, "utf8")
    return { root, file }
  }

  test("sync+fresh → pass/exit 0 (human + json)", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 30\n  b:\n    cmd: sleep 30\n")
    const a = await sleeper()
    const b = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: true } },
        { name: "b", pid: b.pid, lstart: b.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: true } },
      ])
      await writeRun(root, "gece", FRESH_RUN)
      const io = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("ready: environment passed preflight")
      // M2 parity: without new files the human line is byte-identical.
      expect(io.out).toEqual(["ready: environment passed preflight"])
      const io2 = capture()
      try {
        expect(await run(["preflight", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        pass: boolean
        gates: { name: string; pass: boolean; detail: Record<string, unknown> }[]
        missing: unknown[]
        envelopes: unknown[]
      }
      expect(payload.pass).toBe(true)
      // M2 4th gate (boundary): additive - old 3 gates byte-identical in shape.
      expect(payload.gates.map((gate) => gate.name)).toEqual(["reconcile", "provenance", "readiness", "boundary"])
      expect(payload.gates.every((gate) => gate.pass)).toBe(true)
      expect(payload.missing).toEqual([])
      expect(payload.envelopes).toHaveLength(2)
      expect(payload.gates[0].detail).toHaveProperty("inSync", true)
      expect(payload.gates[0].detail).toHaveProperty("drifts", [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("drift → exit 1 + reconcile missing", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 60\n")
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: true } },
      ])
      const io = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as { pass: boolean; missing: string[] }
      expect(payload.pass).toBe(false)
      expect(payload.missing).toContain("reconcile:a:config-mismatch")
      expect(payload.missing).toContain("provenance:a:config-mismatch")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stale envelope → exit 1 + stale missing (reconcile clean)", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 30\n")
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: true } },
      ])
      await writeRun(root, "gece", STALE_RUN)
      const io = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as { pass: boolean; missing: string[]; envelopes: { status: string }[] }
      expect(payload.missing).toContain("stale:build:script_hash")
      expect(payload.envelopes.map((line) => line.status)).toEqual(["confirmed", "stale"])
      const io2 = capture()
      try {
        await run(["preflight", "--file", file])
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).toContain("stale: build (reason: script_hash)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("readiness-false → exit 1 not-ready; absence drops via Q1 unmeasured", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 30\n")
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: false, note: "probe closed" } },
      ])
      const io = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect((JSON.parse(io.out.join("\n")) as { missing: string[] }).missing).toContain("readiness:a:not-ready")
      await writeState(root, [{ name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30" }])
      const io2 = capture()
      try {
        expect(await run(["preflight", "--file", file, "--json"])).toBe(1)
      } finally {
        io2.restore()
      }
      expect((JSON.parse(io2.out.join("\n")) as { missing: string[] }).missing).toContain("readiness:a:unmeasured")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("flagless fake-probe never called (zero-exec proof)", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    ownedServers.push(srv)
    const { root, file } = await fixture(`services:\n  a:\n    cmd: sleep 30\n    port: ${srv.port}\n`)
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", port: srv.port, lastReadiness: { ok: true } },
      ])
      let calls = 0
      const counting: (port: number) => Promise<boolean> = async (port) => {
        calls += 1
        return tcpListening(port)
      }
      const io = capture()
      let code = -1
      try {
        code = await runPreflight({ rootDir: root, file, json: false, probe: false, tcpCheck: counting })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(calls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--probe: open TCP counts, closed drops", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    ownedServers.push(srv)
    const { root, file } = await fixture(`services:\n  a:\n    cmd: sleep 30\n    port: ${srv.port}\n`)
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", port: srv.port, lastReadiness: { ok: true } },
      ])
      let calls = 0
      const counting: (port: number) => Promise<boolean> = async (port) => {
        calls += 1
        return tcpListening(port)
      }
      const io = capture()
      try {
        expect(await runPreflight({ rootDir: root, file, json: true, probe: true, tcpCheck: counting })).toBe(0)
      } finally {
        io.restore()
      }
      expect(calls).toBe(1)
      srv.stop(true)
      const io2 = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file, "--probe"])
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.out.join("\n")).toContain("not-ready: a (port closed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("TCP-open/probe-closed: recorded rejection beats live TCP, no probing", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    ownedServers.push(srv)
    const { root, file } = await fixture(`services:\n  a:\n    cmd: sleep 30\n    port: ${srv.port}\n`)
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", port: srv.port, lastReadiness: { ok: false, note: "probe closed" } },
      ])
      let calls = 0
      const io = capture()
      let code = -1
      try {
        code = await runPreflight({
          rootDir: root,
          file,
          json: false,
          probe: false,
          tcpCheck: async () => {
            calls += 1
            return true
          },
        })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(calls).toBe(0)
      expect(io.out.join("\n")).toContain("not-ready: a (probe closed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("sentinel: record-note masked, no hunter2", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 30\n")
    const a = await sleeper()
    try {
      await writeState(root, [
        { name: "a", pid: a.pid, lstart: a.lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: false, note: "token=hunter2 login failed" } },
      ])
      const io = capture()
      try {
        expect(await run(["preflight", "--file", file, "--json"])).toBe(1)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        await run(["preflight", "--file", file])
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("hunter2")
      expect(io2.out.join("\n")).toContain("not-ready: a (token=*** login failed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt supervisor.json: exit 1, no crash", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: sleep 30\n")
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk{{{", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["preflight", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("supervisor.json corrupt")
      expect((JSON.parse(io.out.join("\n")) as { pass: boolean }).pass).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("usage: positional + --detach exit 2", async () => {
    const { root, file } = await fixture("services:\n  a:\n    cmd: echo hi\n")
    try {
      expect(await run(["preflight", "x", "--file", file])).toBe(2)
      expect(await run(["preflight", "--detach", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("boundary claim dedupe (no double-report)", () => {
  test("duplicate boundary entries collapse to one claim", async () => {
    const { readBoundaryClaims } = await import("./up-preflight")
    const root = await mkdtemp(join(tmpdir(), "ow-dedupe-"))
    try {
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only, real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      const { claims } = await readBoundaryClaims(root)
      expect(claims).toEqual([{ scenario: "cart", service: "api", boundary: "real-read-only" }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-e recency window: newest run per stage gates, older display-only", () => {
  test("historical-stale + later-green for same stage gates green", async () => {
    const { evaluatePreflight } = await import("./up-preflight")
    const staleOld = { stage: "build", status: "stale", at: "2026-01-01T00:00:00.000Z" }
    const greenNew = { stage: "build", status: "confirmed", at: "2026-06-01T00:00:00.000Z" }
    const base = {
      expected: [],
      running: [],
      liveness: new Map(),
      boundary: { claims: [], configVersion: "1" },
    } as never
    const result = evaluatePreflight({ ...base, envelopes: [staleOld, greenNew] as never })
    expect(result.pass).toBe(true)
    const inverted = evaluatePreflight({ ...base, envelopes: [greenNew, staleOld] as never })
    expect(inverted.pass).toBe(true)
  })

  test("newestEnvelopePerStage keeps max at per stage, unparsable sorts oldest", async () => {
    const { newestEnvelopePerStage } = await import("./up-evidence")
    const envelopes = [
      { stage: "a", status: "stale", at: "2026-01-01T00:00:00.000Z" },
      { stage: "a", status: "confirmed", at: "2026-06-01T00:00:00.000Z" },
      { stage: "b", status: "confirmed", at: "not-a-date" },
      { stage: "b", status: "stale", at: "2026-03-01T00:00:00.000Z" },
    ] as never
    const gated = newestEnvelopePerStage(envelopes)
    expect(gated).toHaveLength(2)
    expect(gated.find((e) => (e as { stage: string }).stage === "a")).toMatchObject({ status: "confirmed" })
    expect(gated.find((e) => (e as { stage: string }).stage === "b")).toMatchObject({ status: "stale" })
  })
})

describe("M-f vacuous readiness refuses (never silent pass)", () => {
  test("readiness with zero services exits 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-vac-"))
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services: {}\n", "utf8")
      const { runReadiness } = await import("./up-preflight")
      const io = capture()
      let code = -1
      try {
        code = await runReadiness({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("ow: nothing to check")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
