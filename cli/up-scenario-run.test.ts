/** M6 narrowed deterministic scenario-run: 5-phase facade
 * (setup->run->assert->restore->report) with mandatory runner-side restore.
 * Deterministic probe/restore outcomes use injected fakes (the `ProbeFn`
 * precedent); live-exec and hostile paths run the real `runProbeJob`
 * against owned fixtures. Test names English, comments English. */

import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { evaluateAsserts } from "./up-scenario-run"
import type { ProbeOutcome } from "./up-probe"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m6-"))

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

const GREEN = [
  "version: 1",
  "scenarios:",
  "  cart:",
  "    services: [api]",
  "    boundaries: [real-read-only]",
  "    targets: [http://127.0.0.1:8901/cart]",
  "    probes: [{id: ready, argv: [./ready.sh], timeout: 10s}]",
  "    checkpoints: [approval]",
  "    restore: {argv: [./restore.sh]}",
  "    assert: [{kind: call-count, stage: approval, count: 0}]",
  "",
].join("\n")

const okProbe = (): ProbeOutcome => ({ ok: true, note: "fake-ready", timedOut: false, code: 0 })

const restoringRunner = (calls: string[][]) => async (opts: { argv: string[] }): Promise<{ ok: boolean; note: string }> => {
  calls.push([...opts.argv])
  return { ok: true, note: "runner-restored" }
}

const writeRun = async (root: string, run: string, lines: string[]): Promise<void> => {
  await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
  await writeFile(join(root, ".ow", "checkpoints", `${run}.jsonl`), `${lines.join("\n")}\n`, "utf8")
}

const confirmedLine = (stage: string, at: string): string =>
  JSON.stringify({ stage, status: "confirmed", proof: { ok: true }, at, by: "runner", code: { script_hash: "h1", checkout_rev: "r1" }, runtime: { port: 1 } })

describe("ow scenario run green path", () => {
  test("deterministic green fixture exits 0 with 5 ordered phases", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN, "utf8")
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const calls: string[][] = []
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({
          rootDir: root,
          file,
          name: "cart",
          json: false,
          probeFn: async () => okProbe(),
          runner: restoringRunner(calls),
        })
      } finally {
        io2.restore()
      }
      expect(code).toBe(0)
      expect(calls).toEqual([["./restore.sh"]])
      const text = io2.out.join("\n")
      for (const line of ["setup: cart ok", "run: cart 1/1 probes ok", "assert: cart 1/1 asserts ok", "restored: cart", "report: cart pass"]) {
        expect(text).toContain(line)
      }
      const io3 = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file, name: "cart", json: true, probeFn: async () => okProbe(), runner: restoringRunner([]) })).toBe(0)
      } finally {
        io3.restore()
      }
      const payload = JSON.parse(io3.out.join("\n")) as {
        scenario: string
        phases: { name: string; ok: boolean }[]
        restored: boolean
        contract: { pass: boolean }
        report: unknown
      }
      expect(Object.keys(payload).sort()).toEqual(["contract", "phases", "report", "restored", "scenario"])
      expect(payload.scenario).toBe("cart")
      expect(payload.phases.map((phase) => phase.name)).toEqual(["setup", "run", "assert", "restore", "report"])
      expect(payload.phases.every((phase) => phase.ok)).toBe(true)
      expect(payload.restored).toBe(true)
      expect(payload.contract).toEqual({ pass: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("failing assert exits 1 AND restore still runs (marker present)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        GREEN.replace("count: 0", "count: 2"),
        "utf8",
      )
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      // Tampering would break the contract; re-record the tampered definition
      // so this run fails purely on the assertion, not the contract.
      const ioR = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        ioR.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const calls: string[][] = []
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "cart", json: false, probeFn: async () => okProbe(), runner: restoringRunner(calls) })
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(calls).toEqual([["./restore.sh"]])
      expect(io2.out.join("\n")).toContain("assert: cart 0/1 asserts ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("restore failure exits 1 with restore-failed suffix", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN, "utf8")
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({
          rootDir: root,
          file,
          name: "cart",
          json: false,
          probeFn: async () => okProbe(),
          runner: async () => ({ ok: false, note: "runner-broken" }),
        })
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.out.join("\n")).toContain("restore-failed: cart (runner-broken)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow scenario run refusals", () => {
  test("INERT scaffold exits 2 naming the file", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "# INERT — ow scenarios --check passes, ow scenario run refuses until uncommented\nversion: 1\nscenarios:\n  first-scenario:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: inert, argv: [true]}]\n    checkpoints: [api-ready]\n",
        "utf8",
      )
      const { runScenarioRun } = await import("./up-scenario-run")
      const io = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "first-scenario", json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain(`INERT: ${file}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("tampered contract exits 1 without executing probes", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN, "utf8")
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      await writeFile(file, GREEN.replace("./ready.sh", "./changed.sh"), "utf8")
      const { runScenarioRun } = await import("./up-scenario-run")
      let probed = false
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({
          rootDir: root,
          file,
          name: "cart",
          json: false,
          probeFn: async () => {
            probed = true
            return okProbe()
          },
          runner: restoringRunner([]),
        })
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(probed).toBe(false)
      expect(io2.out.join("\n")).toContain("contract-mismatch: cart")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("off-local without flag exits 2; with flag proceeds past the gate", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN.replace("    checkpoints: [approval]", "    checkpoints: [approval]\n    mode: off-local"), "utf8")
      const { runScenarioRun } = await import("./up-scenario-run")
      const io = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "cart", json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("--off-local")
      const io2 = capture()
      let code2 = -1
      try {
        code2 = await runScenarioRun({ rootDir: root, file, name: "cart", json: false, offLocal: true, probeFn: async () => okProbe(), runner: restoringRunner([]) })
      } finally {
        io2.restore()
      }
      // Past the off-local gate: fails later on the missing contract (exit 1), never exit 2.
      expect(code2).toBe(1)
      expect(io2.out.join("\n")).toContain("unknown-record: cart")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-goal keys exit 2 naming the non-goal (--check still exits 1)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN.replace("    checkpoints: [approval]", "    checkpoints: [approval]\n    soak: [nightly]"), "utf8")
      const { runScenarioRun } = await import("./up-scenario-run")
      const io = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "cart", json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("soak")
      const { runScenariosCheck } = await import("./up-scenarios")
      const io2 = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(1)
      } finally {
        io2.restore()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown scenario / state-changing / unverified-only / bad files", async () => {
    const root = await tempRoot()
    try {
      const { runScenarioRun } = await import("./up-scenario-run")
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN, "utf8")
      const io = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file, name: "ghost", json: false })).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("scenario not found")
      for (const boundaries of ["[real-state-changing]", '[blocked:"maintenance"]', "[unverified]"]) {
        await writeFile(
          file,
          `version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: ${boundaries}\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n`,
          "utf8",
        )
        const ioN = capture()
        try {
          expect(await runScenarioRun({ rootDir: root, file, name: "cart", json: false })).toBe(2)
        } finally {
          ioN.restore()
        }
      }
      const io2 = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file: join(root, "missing.yaml"), name: "cart", json: false })).toBe(1)
      } finally {
        io2.restore()
      }
      await writeFile(file, "version: 1\nscenarios:\n  - block list forbidden\n", "utf8")
      const io3 = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file, name: "cart", json: false })).toBe(1)
      } finally {
        io3.restore()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dispatch usage matrix", async () => {
    expect(await run(["scenario"])).toBe(2)
    expect(await run(["scenario", "run"])).toBe(2)
    expect(await run(["scenario", "frob"])).toBe(2)
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, GREEN, "utf8")
      expect(await run(["scenario", "run", "cart", "extra", "--file", file])).toBe(2)
      expect(await run(["scenario", "run", "cart", "--file", file, "--probe"])).toBe(2)
      expect(await run(["scenario", "run", "cart", "--file", file, "--run", "bad!name"])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("assertion primitives (pure units + live paths)", () => {
  test("negative passes on failing probes, fails on ready ones", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: down, argv: [./down.sh]}, {id: up, argv: [./up.sh]}]\n    restore: {argv: [./restore.sh]}\n    assert: [{kind: negative, probe: down}]\n",
        "utf8",
      )
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(
          await runRecord({
            rootDir: root,
            file,
            runName: "cart",
            probeFn: async (spec) => (spec.probe[0] === "./down.sh" ? { ok: false, note: "down", timedOut: false, code: 1 } : okProbe()),
          }),
        ).toBe(0)
      } finally {
        io.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({
          rootDir: root,
          file,
          name: "cart",
          json: false,
          probeFn: async (spec) => (spec.probe[0] === "./down.sh" ? { ok: false, note: "down", timedOut: false, code: 1 } : okProbe()),
          runner: restoringRunner([]),
        })
      } finally {
        io2.restore()
      }
      expect(code).toBe(0)
      expect(io2.out.join("\n")).toContain("assert: cart 1/1 asserts ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("readback-by-consumer needs a ready consumer plus a confirmed stage", () => {
    const results = evaluateAsserts(
      [{ kind: "readback-by-consumer", probe: "reader", stage: "approval" }],
      new Map([["reader", { ok: true, note: "", timedOut: false, code: 0 }]]),
      [{ stage: "approval", status: "confirmed" } as never],
      5,
    )
    expect(results).toEqual([{ kind: "readback-by-consumer", ok: true, detail: "consumer ready, stage confirmed" }])
    const missing = evaluateAsserts(
      [{ kind: "readback-by-consumer", probe: "reader", stage: "ghost-stage" }],
      new Map([["reader", { ok: true, note: "", timedOut: false, code: 0 }]]),
      [{ stage: "approval", status: "confirmed" } as never],
      5,
    )
    expect(missing[0].ok).toBe(false)
    const down = evaluateAsserts(
      [{ kind: "readback-by-consumer", probe: "reader", stage: "approval" }],
      new Map([["reader", { ok: false, note: "down", timedOut: false, code: 1 }]]),
      [{ stage: "approval", status: "confirmed" } as never],
      5,
    )
    expect(down[0].ok).toBe(false)
  })

  test("call-count is exact; budget is wall-clock", () => {
    const counted = evaluateAsserts(
      [{ kind: "call-count", stage: "approval", count: 2 }],
      new Map(),
      [
        { stage: "approval", status: "confirmed" },
        { stage: "approval", status: "stale" },
      ] as never,
      5,
    )
    expect(counted).toEqual([{ kind: "call-count", ok: true, detail: "found 2, expected 2" }])
    const short = evaluateAsserts([{ kind: "call-count", stage: "approval", count: 3 }], new Map(), [] as never, 5)
    expect(short[0]).toMatchObject({ ok: false })
    const budgeted = evaluateAsserts([{ kind: "budget", ms: 60000 }], new Map(), [] as never, 12)
    expect(budgeted).toEqual([{ kind: "budget", ok: true, detail: "wall 12ms within 60000ms" }])
    const blown = evaluateAsserts([{ kind: "budget", ms: 5 }], new Map(), [] as never, 12)
    expect(blown).toEqual([{ kind: "budget", ok: false, detail: "wall 12ms exceeds 5ms" }])
  })

  test("readback over a real checkpoint run file", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: reader, argv: [./reader.sh]}]\n    restore: {argv: [./restore.sh]}\n    assert: [{kind: readback-by-consumer, probe: reader, stage: approval}]\n",
        "utf8",
      )
      await writeRun(root, "nightly", [confirmedLine("approval", "2026-10-09T08:00:00.000Z")])
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "cart", json: false, runId: "nightly", probeFn: async () => okProbe(), runner: restoringRunner([]) })
      } finally {
        io2.restore()
      }
      expect(code).toBe(0)
      const io3 = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file, name: "cart", json: false, runId: "ghost-run", probeFn: async () => okProbe(), runner: restoringRunner([]) })).toBe(2)
      } finally {
        io3.restore()
      }
      expect(io3.err.join("\n")).toContain("ghost-run")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("hostile run path (real exec, masked everywhere)", () => {
  test("secret argv/notes/paths never leak via human or json", async () => {
    const root = await tempRoot()
    const hex40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    const bearerBody = "AbCdefGh0123456789._~-plus-xyz123456789"
    try {
      const script = join(root, "spy.sh")
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s' '{"ready": true, "note": "token=hunter2 build ${hex40} carrier Bearer ${bearerBody} at ${root}", "checks": []}'\n`,
        "utf8",
      )
      await chmod(script, 0o755)
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./spy.sh, --token, hunter2], timeout: 10s}]\n    restore: {argv: [./restore.sh, --token, hunter2]}\n",
        "utf8",
      )
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => okProbe() })).toBe(0)
      } finally {
        io.restore()
      }
      const { runScenarioRun } = await import("./up-scenario-run")
      const calls: string[][] = []
      const io2 = capture()
      try {
        expect(
          await runScenarioRun({ rootDir: root, file, name: "cart", json: false, runner: restoringRunner(calls) }),
        ).toBe(0)
      } finally {
        io2.restore()
      }
      // Runner receives RAW argv (execution needs it); ow's own lines stay masked.
      expect(calls[0]).toEqual(["./restore.sh", "--token", "hunter2"])
      const io3 = capture()
      try {
        expect(await runScenarioRun({ rootDir: root, file, name: "cart", json: true, runner: restoringRunner([]) })).toBe(0)
      } finally {
        io3.restore()
      }
      const everything = `${io2.out.join("\n")}\n${io2.err.join("\n")}\n${io3.out.join("\n")}\n${io3.err.join("\n")}`
      for (const secret of ["hunter2", bearerBody, hex40, root]) {
        expect(everything).not.toContain(secret)
      }
      expect(everything).toContain("<root>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("additive scenario schema (M6 track fields)", () => {
  test("new keys parse with defaults; bad values fail closed", async () => {
    const { parseScenarios } = await import("./up-scenarios")
    const parsed = parseScenarios(
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    mode: off-local\n    restore: {argv: [./restore.sh], timeout: 5s}\n    assert: [{kind: negative, probe: p}]\n    triggers: [nightly]\n    queue: p\n    webhook: [{url: http://127.0.0.1:9999/hook}]\n    deps: [{mode: local}]\n    proxies: [api]\n    apiMode: [rest]\n    browser: [chromium]\n    viewport: [1280x720]\n    seed: [seed-7]\n    artifact: [build-id]\n",
    )
    const scenario = parsed.scenarios[0]
    expect(scenario.mode).toBe("off-local")
    expect(scenario.restore).toEqual({ argv: ["./restore.sh"], timeout: "5s" })
    expect(scenario.asserts).toEqual([{ kind: "negative", probe: "p" }])
    expect(scenario.triggers).toEqual(["nightly"])
    expect(scenario.queue).toBe("p")
    expect(scenario.deps).toEqual([{ mode: "local" }])
    expect(scenario.proxies).toEqual(["api"])
    expect(scenario.seed).toEqual(["seed-7"])
    for (const bad of [
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    mode: orbital\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [sh, -c, x]}\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    assert: [{kind: bogus, probe: p}]\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    assert: [{kind: negative, probe: ghost}]\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    queue: ghost\n",
    ]) {
      expect(() => parseScenarios(bad)).toThrow()
    }
  })

  test("non-goal keys fail closed with the non-goal marker", async () => {
    const { parseScenarios } = await import("./up-scenarios")
    for (const key of ["fault", "soak", "load-test", "schedule", "deploy"]) {
      expect(() => parseScenarios(`version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    ${key}: [x]\n`)).toThrow(/non-goal rejected/)
    }
  })
})
