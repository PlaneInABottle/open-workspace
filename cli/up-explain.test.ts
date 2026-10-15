/** M2 explain: recorded-value render (the ps path does not run git/lsof) +
 * reconcile rev lines + checkout-change gate evidence. */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"
import { explainServices, formatExplanation, runPsExplain, type PsServiceView } from "./up-ps"
import { runReconcileCheck } from "./up-reconcile"
import { ensureUpStateDir, readLstart, upPaths, writeSupervisorState, type UpServiceState } from "./up-state"

const ownedProcs: { kill: (signal?: string) => void }[] = []
const savedPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = savedPath
  for (const proc of ownedProcs.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
})

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m2exp-"))

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

const liveView = (name: string, pid: number, overrides: Partial<PsServiceView> = {}): PsServiceView => ({
  name,
  status: "running",
  pid,
  uptimeSec: 5,
  cpuPct: 0,
  memBytes: 1024,
  ...overrides,
})

const recordOf = (entry: Record<string, unknown>): UpServiceState => entry as unknown as UpServiceState

describe("explainServices (saf)", () => {
  test("matching service, no probe defined: port-only reason (no probe configured)", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000 }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000 })],
      snapshotOk: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].explanation.diffs).toEqual([])
    expect(items[0].explanation.running).toMatchObject({ lstart: "matched" })
    expect(items[0].explanation.reason).toBe("running (no project probe configured — port-only evidence)")
  })

  test("probe defined but unmeasured: configured-not-measured reason", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000, readiness: { probe: ["./ready.sh"], timeout: "10s", needsPort: true } }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000 })],
      snapshotOk: true,
    })
    expect(items[0].explanation.reason).toBe("running (project probe configured, not yet measured)")
  })

  test("probe defined, last recorded pass: recorded-pass reason (not fresh health)", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000, readiness: { probe: ["./ready.sh"], timeout: "10s", needsPort: true } }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000, lastReadiness: { ok: true, at: "2026-10-14T00:00:00Z" } })],
      snapshotOk: true,
    })
    expect(items[0].explanation.reason).toBe("running (last recorded probe passed — recorded state, not fresh health)")
  })

  test("probe defined, last recorded fail: recorded-fail reason with safe actions", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000, readiness: { probe: ["./ready.sh"], timeout: "10s", needsPort: true } }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000, lastReadiness: { ok: false, note: "closed", at: "2026-10-14T00:00:00Z" } })],
      snapshotOk: true,
    })
    expect(items[0].explanation.reason).toBe("running (last recorded probe failed → inspect with ow logs a, refresh with ow restart a)")
  })

  test("hostile recorded note never reaches the reason (static strings only)", () => {
    const secret = "hunter2-secret-note"
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000, readiness: { probe: ["./ready.sh"], timeout: "10s", needsPort: true } }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000, lastReadiness: { ok: false, note: secret, at: "2026-10-14T00:00:00Z" } })],
      snapshotOk: true,
    })
    expect(items[0].explanation.reason).toBe("running (last recorded probe failed → inspect with ow logs a, refresh with ow restart a)")
    expect(items[0].explanation.reason).not.toContain(secret)
    // The recorded note stays in its existing readiness field (unchanged);
    // only the reason must be static.
    expect(items[0].explanation.readiness.last).toMatchObject({ ok: false, note: secret })
  })

  test("config diffs + reason priority", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 60", cwd: ".", port: 3001, env: { A: "x" } as never }],
      views: [liveView("a", 11, { port: 3002, listening: false })],
      records: [
        recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3002, envNames: ["A"] }),
      ],
      snapshotOk: true,
    })
    const diffs = items[0].explanation.diffs.join("\n")
    expect(diffs).toContain("command changed")
    expect(diffs).toContain("port changed")
    expect(diffs).toContain("port 3002 not listening")
    expect(items[0].explanation.reason).toContain("ow restart a")
  })

  test("declared-env label + wrapped interpreter render; fallback interpreter=- unchanged", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: ["env", "FOO=bar", "node", "app.js"], env: {} as never }],
      views: [liveView("a", 11)],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "l",
          startedAt: "t",
          cmd: ["env", "FOO=bar", "node", "app.js"],
          envNames: [],
          provenance: { recordedAt: "t", interpreter: { name: "node", source: "inferred" } },
        }),
      ],
      snapshotOk: true,
    })
    const text = formatExplanation(items[0]).join("\n")
    expect(text).toContain("env(declared)=[]")
    expect(text).toContain("interpreter=node(inferred)")
    expect(text).not.toContain("env=[")
    const bare = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(formatExplanation(bare[0]).join("\n")).toContain("interpreter=-")
  })

  test("wrapper secrets never reach human or json render", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: ["env", "TOKEN=hunter2", "node", "app.js"], env: { TOKEN: "x" } as never }],
      views: [liveView("a", 11)],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "l",
          startedAt: "t",
          cmd: ["env", "TOKEN=***", "node", "app.js"],
          envNames: ["TOKEN"],
          provenance: { recordedAt: "t", interpreter: { name: "node", source: "inferred" } },
        }),
      ],
      snapshotOk: true,
    })
    const human = formatExplanation(items[0]).join("\n")
    expect(human).toContain("env(declared)=[TOKEN]")
    expect(human).toContain("interpreter=node(inferred)")
    expect(human).not.toContain("hunter2")
    expect(JSON.stringify(items[0])).not.toContain("hunter2")
  })

  test("dead/unrecorded/undefined + lstart verdicts", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 1" }, { name: "new", cmd: "echo hi" }],
      views: [
        { name: "a", status: "stopped", pid: 11, uptimeSec: 1, cpuPct: null, memBytes: null },
        { name: "ghost", status: "unknown", pid: 12, uptimeSec: 1, cpuPct: null, memBytes: null },
      ],
      records: [
        recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 1" }),
        recordOf({ name: "ghost", pid: 12, lstart: "foreign", startedAt: "t", cmd: "sleep 1" }),
      ],
      snapshotOk: true,
    })
    const byName = new Map(items.map((item) => [item.service, item.explanation]))
    expect(byName.get("a")?.running).toMatchObject({ lstart: "dead" })
    expect(byName.get("a")?.reason).toContain("ow restart a")
    expect(byName.get("ghost")?.running).toMatchObject({ lstart: "mismatch" })
    expect(byName.get("ghost")?.diffs.join("\n")).toContain("lstart mismatch")
    expect(byName.get("new")?.running).toBeNull()
    expect(byName.get("new")?.reason).toContain("ow up new")
    expect(byName.get("ghost")?.expected).toBeNull()
    expect(byName.get("ghost")?.reason).toContain("ow down ghost")
  })

  test("blind lstart + dirty checkout + UNVERIFIED rev", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [{ name: "a", status: "unknown", pid: 11, uptimeSec: 1, cpuPct: null, memBytes: null, note: "lstart unknown" }],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "",
          startedAt: "t",
          cmd: "sleep 30",
          lstartUnknown: true,
          provenance: { checkout: { rev: "abc", dirty: true, source: "observed" }, recordedAt: "t" },
        }),
      ],
      snapshotOk: true,
    })
    expect(items[0].explanation.running).toMatchObject({ lstart: "unknown" })
    expect(items[0].explanation.diffs.join("\n")).toContain("started with dirty checkout (rev=abc)")
    expect(items[0].explanation.reason).toContain("no safe action")
    const lines = formatExplanation(items[0])
    expect(lines.join("\n")).toContain("rev=abc(observed)+dirty")
    const noRev = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(formatExplanation(noRev[0]).join("\n")).toContain("rev=unverifiable(UNVERIFIED)")
  })

  test("readiness definition + last-known (masked, never runs it)", () => {
    const spec = { probe: ["./x.sh", "--token", "hunter2"], timeout: "10s" as const, needsPort: true }
    const defined = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", readiness: spec }],
      views: [liveView("a", 11)],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "l",
          startedAt: "t",
          cmd: "sleep 30",
          lastReadiness: { ok: true, note: "smoke", at: "2026-10-09T00:00:00.000Z", kind: "probe" },
        }),
      ],
      snapshotOk: true,
    })
    expect(defined[0].explanation.readiness).toMatchObject({
      defined: true,
      timeout: "10s",
      needsPort: true,
      last: { ok: true },
    })
    expect(defined[0].explanation.readiness.probe).not.toContain("hunter2")
    const text = formatExplanation(defined[0]).join("\n")
    expect(text).toContain("readiness:")
    expect(text).toContain("ready (2026-10-09T00:00:00.000Z)")
    expect(text).not.toContain("hunter2")
    const missing = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", readiness: spec }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(missing[0].explanation.readiness.last).toBeNull()
    expect(formatExplanation(missing[0]).join("\n")).toContain("unmeasured")
    const plain = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(plain[0].explanation.readiness).toMatchObject({ defined: false, last: null })
    expect(formatExplanation(plain[0]).join("\n")).not.toContain("readiness:")
  })
})

describe("ps --explain CLI", () => {
  const fixture = async (): Promise<{ root: string; file: string; pid: number; lstart: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n    port: 3000\n", "utf8")
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    ownedProcs.push(proc)
    const lstart = (await readLstart(proc.pid))!
    const paths = upPaths(root)
    await ensureUpStateDir(paths.stateDir)
    await writeSupervisorState(paths.supervisorFile, {
      version: 1,
      startedAt: new Date().toISOString(),
      services: [
        recordOf({
          name: "a",
          pid: proc.pid,
          lstart,
          startedAt: new Date().toISOString(),
          cmd: "sleep 30",
          port: 3000,
          provenance: {
            cwdAbs: root,
            checkout: { rev: "abc123", dirty: false, source: "observed" },
            argvShape: ["sleep", "30"],
            recordedAt: "2026-10-09T00:00:00.000Z",
          },
        }),
      ],
    })
    return { root, file, pid: proc.pid, lstart }
  }

  test("human block: expected/running/diff/reason", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["ps", "--explain", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("a:")
      expect(text).toContain("expected: cmd=sleep 30 port=3000")
      expect(text).toContain("lstart=matched")
      expect(text).toContain("rev=abc123(observed)")
      expect(text).toContain("reason:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json: explanation envelope, no raw argv, no sentinel", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        services: { name: string }[]
        explanations: { service: string; explanation: { expected: unknown; running: unknown; diffs: unknown[]; provenance: Record<string, unknown>; reason: string } }[]
      }
      expect(payload.services.map((svc) => svc.name)).toEqual(["a"])
      expect(payload.explanations).toHaveLength(1)
      const explanation = payload.explanations[0].explanation
      expect(Object.keys(explanation).sort()).toEqual(["artifacts", "diffs", "expected", "provenance", "readiness", "reason", "running"])
      expect(JSON.stringify(payload)).not.toContain("hunter2")
      expect(JSON.stringify(explanation.provenance)).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("single-service filter + unknown service exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "a", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("a:")
      expect(await run(["ps", "--explain", "missing", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the running line renders cwd; UNVERIFIED if dropped", () => {
    const withCwd = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { cwdAbs: "/r/app", recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(withCwd[0].explanation.running).toMatchObject({ cwd: "/r/app" })
    expect(formatExplanation(withCwd[0]).join("\n")).toContain("cwd=/r/app")
    const dropped = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(dropped[0].explanation.running).not.toHaveProperty("cwd")
    expect(formatExplanation(dropped[0]).join("\n")).toContain("cwd=unverifiable(UNVERIFIED)")
  })

  test("--explain is read only in the ps branch (M-C precedent guards)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      for (const args of [
        ["up", "--check", "--explain", "--file", file],
        ["down", "--explain", "--file", file],
        ["reconcile", "--check", "--explain", "--file", file],
        ["show", "missing-session", "--explain"],
      ]) {
        const io = capture()
        let code = -1
        try {
          code = await run(args)
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toBe(`${args.join(" ")} → 2`)
        expect(io.err.join("\n")).toContain("--explain works only with ps")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a secret env value enters no path (.env content + env value)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: run --token hunter2\n    env: {API_KEY: hunter2}\n", "utf8")
      await writeFile(join(root, ".env"), "TOKEN=hunter2\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      ownedProcs.push(proc)
      const lstart = (await readLstart(proc.pid))!
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { recordProvenance } = await import("./up-provenance")
      const provenance = await recordProvenance({ svc: { name: "a", cmd: "run --token hunter2" }, cwdAbs: root })
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [recordOf({ name: "a", pid: proc.pid, lstart, startedAt: new Date().toISOString(), cmd: "run --token ***", provenance })],
      })
      const raw = await readFile(paths.supervisorFile, "utf8")
      expect(raw).not.toContain("hunter2")
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("B4: the ps path does not run git/lsof (counter proof)", () => {
  const fakeBin = async (): Promise<{ dir: string; countFile: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "ow-fakebin-"))
    const countFile = join(dir, "count.log")
    await writeFile(countFile, "", "utf8")
    for (const tool of ["git", "lsof"]) {
      await writeFile(
        join(dir, tool),
        `#!/bin/sh\necho "$0 $@" >> "${countFile}"\nif [ "${tool}" = "git" ]; then echo "deadbeef1234"; fi\n`,
        { mode: 0o755 },
      )
    }
    return { dir, countFile }
  }

  test("explain does not touch the fake git/lsof (counter 0)", async () => {
    const root = await tempRoot()
    const { dir, countFile } = await fakeBin()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      ownedProcs.push(proc)
      const lstart = (await readLstart(proc.pid))!
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [recordOf({ name: "a", pid: proc.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30" })],
      })
      process.env.PATH = `${dir}:${savedPath}`
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
        expect(await run(["ps", "--file", file])).toBe(0)
        expect(await run(["reconcile", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      // reconcile --check LEGALLY runs git (B4-b); the ps paths do not.
      const log = await readFile(countFile, "utf8")
      expect(log).not.toMatch(/lsof/)
      const io2 = capture()
      try {
        await run(["ps", "--explain", "--file", file])
      } finally {
        io2.restore()
      }
      expect((await readFile(countFile, "utf8")).split("\n").filter((line) => line.includes("lsof"))).toEqual([])
    } finally {
      process.env.PATH = savedPath
      await rm(root, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the spawn path calls the same fake git (injection works)", async () => {
    const root = await tempRoot()
    const { dir, countFile } = await fakeBin()
    try {
      process.env.PATH = `${dir}:${savedPath}`
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const code = await runSupervised([{ name: "a", cmd: "echo hi", cwd: "." }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine: () => undefined,
      })
      expect(code).toBe(0)
      const log = await readFile(countFile, "utf8")
      expect(log).toContain("rev-parse")
    } finally {
      process.env.PATH = savedPath
      await rm(root, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no git/lsof exec trace in the up-ps.ts source (guardrail)", async () => {
    const src = await readFile(resolve(import.meta.dir, "up-ps.ts"), "utf8")
    expect(src).not.toContain("lsof")
    expect(src).not.toMatch(/["']git["']/)
    expect(src).not.toContain("probe(")
    expect(src).not.toContain("health(")
  })
})

describe("gate: a checkout change shows the old rev without restart", () => {
  const hasGit = async (): Promise<boolean> => {
    try {
      const proc = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" })
      await proc.exited
      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  const git = async (root: string, args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root },
    })
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
  }

  test("reconcile diff line + explain recorded rev (no restart)", async () => {
    if (!(await hasGit())) {
      console.log("skipped: no git")
      return
    }
    const root = await tempRoot()
    let stop = false
    let done: Promise<number> | null = null
    try {
      await git(root, ["init", "-q"])
      await writeFile(join(root, "ow.yaml"), "services:\n  a:\n    cmd: sleep 30\n    cwd: .\n", "utf8")
      await writeFile(join(root, "iz.txt"), "v1\n", "utf8")
      await git(root, ["add", "-A"])
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev1"])
      const { ensureUpStateDir, readSupervisorState, upPaths } = await import("./up-state")
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      done = runSupervised([{ name: "a", cmd: "sleep 30", cwd: "." }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        logsDir: paths.logsDir,
        onLine: () => undefined,
        shouldStop: () => stop,
      })
      const waitFor = async (cond: () => Promise<boolean>): Promise<void> => {
        const start = Date.now()
        for (;;) {
          if (await cond()) return
          if (Date.now() - start > 15000) throw new Error("supervisor record could not be awaited")
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
        }
      }
      await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services[0]?.provenance !== undefined)
      const rev1 = (await readSupervisorState(paths.supervisorFile))?.services[0]?.provenance?.checkout?.rev
      expect(rev1).toMatch(/^[0-9a-f]{40}$/)
      // The checkout changes, NO restart.
      await writeFile(join(root, "iz.txt"), "v2\n", "utf8")
      await git(root, ["add", "-A"])
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev2"])
      const file = join(root, "ow.yaml")
      const io = capture()
      let reconcileCode = -1
      try {
        reconcileCode = await runReconcileCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(reconcileCode).toBe(0)
      expect(io.out.join("\n")).toContain(`diff: revision ${rev1}→`)
      const io2 = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        explanations: { explanation: { provenance: { checkout?: { rev?: string } } } }[]
      }
      expect(payload.explanations[0].explanation.provenance.checkout?.rev).toBe(rev1)
      stop = true
      await done
    } finally {
      stop = true
      if (done !== null) await Promise.race([done, new Promise((resolveSleep) => setTimeout(resolveSleep, 8000))])
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})

describe("merge: provenance drops on respawn", () => {
  test("a new identity does not revive the old checkout", async () => {
    const { mergePreservingSettled } = await import("./up-supervisor")
    const merged = mergePreservingSettled(
      [
        {
          name: "a",
          pid: 1,
          lstart: "x",
          startedAt: "t",
          provenance: { checkout: { rev: "old", source: "observed" as const }, recordedAt: "t" },
        },
      ],
      [{ name: "a", pid: 2, lstart: "y", startedAt: "t2" }],
    )
    expect(merged[0].provenance).toBeUndefined()
    const same = mergePreservingSettled(
      [
        {
          name: "a",
          pid: 1,
          lstart: "x",
          startedAt: "t",
          provenance: { checkout: { rev: "old", source: "observed" as const }, recordedAt: "t" },
        },
      ],
      [{ name: "a", pid: 1, lstart: "x", startedAt: "t2" }],
    )
    expect(same[0].provenance).toMatchObject({ checkout: { rev: "old" } })
  })
})

describe("M-C explain build identity (basename + short-8)", () => {
  test("the recorded map is listed reduced (≤32 + counter)", () => {
    const digests: Record<string, string> = { "api.jar": "a1b2c3d4e5f6", "extra.jar": "ffffffffffff" }
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", artifactDigests: digests })],
      snapshotOk: true,
    })
    expect(items[0].explanation.artifacts.shown).toEqual([
      { base: "api.jar", digest: "a1b2c3d4" },
      { base: "extra.jar", digest: "ffffffff" },
    ])
    expect(items[0].explanation.artifacts.rest).toBe(0)
    const lines = formatExplanation(items[0])
    expect(lines.join("\n")).toContain("build: api.jar@a1b2c3d4, extra.jar@ffffffff")
    expect(lines.join("\n")).not.toContain("a1b2c3d4e5f6")
  })

  test("33 records: 32 + counter; unrecorded: no line", () => {
    const digests: Record<string, string> = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`s${String(i).padStart(2, "0")}.jar`, "a1b2c3d4e5"]),
    )
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", artifactDigests: digests })],
      snapshotOk: true,
    })
    expect(items[0].explanation.artifacts.shown).toHaveLength(32)
    expect(items[0].explanation.artifacts.rest).toBe(1)
    expect(formatExplanation(items[0]).join("\n")).toContain("(+1 more)")
    const bare = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(bare[0].explanation.artifacts).toEqual({ shown: [], rest: 0 })
    expect(formatExplanation(bare[0]).join("\n")).not.toContain("build:")
  })

  test("JSON carries additive artifacts (reduced)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "a", pid: 1, lstart: "", startedAt: "t", artifactDigests: { "api.jar": "a1b2c3d4e5f6" } }],
      })
      const io = capture()
      try {
        expect(await runPsExplain({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        explanations: { explanation: { artifacts: { shown: { base: string; digest: string }[]; rest: number } } }[]
      }
      expect(payload.explanations[0].explanation.artifacts).toEqual({ shown: [{ base: "api.jar", digest: "a1b2c3d4" }], rest: 0 })
      expect(io.out.join("\n")).not.toContain("a1b2c3d4e5f6")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
