/** M11 serviceless scenarios: explicit `services: []` means no services
 * by decision (probes still required). Missing `services:` key stays a
 * schema error. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { parseScenarios } from "./up-scenarios"
import { normalizeScenarios } from "../src/coordinator"
import { runScenarioRun } from "./up-scenario-run"
import { runRecord } from "./up-replay"
import { runContractCheck } from "./up-contract"
import { runPreflight } from "./up-preflight"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-serviceless-"))

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

const OW_YAML = "services:\n  api:\n    cmd: echo hi\n    port: 8901\n"

const SERVICELESS = [
  "version: 1",
  "scenarios:",
  "  audit:",
  "    services: []",
  "    boundaries: [subscribed]",
  "    probes: [{id: envcheck, argv: [./scripts/env-audit.sh], timeout: 10s}]",
  "    checkpoints: [env-audited]",
  "    restore: {argv: [./scripts/restore-audit.sh]}",
  "",
].join("\n")

const writeServiceless = async (root: string): Promise<string> => {
  const file = join(root, "ow.scenarios.yaml")
  await writeFile(file, SERVICELESS, "utf8")
  await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
  return file
}

describe("M11 schema: explicit empty services", () => {
  test("acceptance 1: --check on services: [] + 1 probe exits 0 with no UNVERIFIED", async () => {
    const root = await tempRoot()
    try {
      const file = await writeServiceless(root)
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("scenario: audit (0 services, 1 probes)")
      expect(io.out.join("\n") + io.err.join("\n")).not.toContain("UNVERIFIED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acceptance 2: missing services: key stays a schema error (exit 1)", async () => {
    expect(() =>
      parseScenarios("version: 1\nscenarios:\n  a:\n    probes: [{id: p, argv: [./x.sh]}]\n"),
    ).toThrow(/services required/)
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, "version: 1\nscenarios:\n  a:\n    probes: [{id: p, argv: [./x.sh]}]\n", "utf8")
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acceptance 3: services: [] with zero probes refuses (exit 1)", async () => {
    for (const body of [
      "version: 1\nscenarios:\n  a:\n    services: []\n",
      "version: 1\nscenarios:\n  a:\n    services: []\n    probes: []\n",
    ]) {
      expect(() => parseScenarios(body)).toThrow()
    }
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, "version: 1\nscenarios:\n  a:\n    services: []\n    probes: []\n", "utf8")
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M11 readers: empty means nothing to bring up", () => {
  test("acceptance 4: run executes probes with no supervisor spawn, restore rendered", async () => {
    const root = await tempRoot()
    try {
      const file = await writeServiceless(root)
      const probed: string[][] = []
      const probeFn = async (opts: { probe: readonly string[] }): Promise<{ ok: boolean; note: string; timedOut: boolean; code: number | null }> => {
        probed.push([...opts.probe])
        return { ok: true, note: "env ok", timedOut: false, code: 0 }
      }
      const restored: string[][] = []
      const runner = async (opts: { argv: string[] }): Promise<{ ok: boolean; note: string }> => {
        restored.push(opts.argv)
        return { ok: true, note: "restore noop with evidence" }
      }
      const io = capture()
      let recordCode = -1
      try {
        recordCode = await runRecord({ rootDir: root, file, runName: "audit", probeFn: probeFn as never })
      } finally {
        io.restore()
      }
      expect(recordCode).toBe(0)
      expect(probed).toEqual([["./scripts/env-audit.sh"]])
      const io2 = capture()
      let code = -1
      try {
        code = await runScenarioRun({ rootDir: root, file, name: "audit", json: false, probeFn: probeFn as never, runner: runner as never })
      } finally {
        io2.restore()
      }
      expect(code).toBe(0)
      expect(probed).toEqual([["./scripts/env-audit.sh"], ["./scripts/env-audit.sh"]])
      expect(restored).toEqual([["./scripts/restore-audit.sh"]])
      const text = io2.out.join("\n")
      expect(text).toContain("restore: ./scripts/restore-audit.sh")
      expect(text).toContain("restored: audit")
      // Witness-not-actor: no supervisor state was ever created.
      const owDir: string[] = await readdir(join(root, ".ow")).catch(() => [])
      expect(owDir).not.toContain("supervisor.json")
      expect(owDir).not.toContain("supervisor.lock")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acceptance 5: tamper (add a service) flips the contract digest", async () => {
    const root = await tempRoot()
    try {
      const file = await writeServiceless(root)
      const probeFn = async (): Promise<{ ok: boolean; note: string; timedOut: boolean; code: number | null }> =>
        ({ ok: true, note: "env ok", timedOut: false, code: 0 })
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "audit", probeFn: probeFn as never })).toBe(0)
      } finally {
        io.restore()
      }
      await writeFile(
        file,
        SERVICELESS.replace("    services: []", "    services: [api]"),
        "utf8",
      )
      const io2 = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.out.join("\n")).toContain("contract-mismatch: audit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preflight boundary gate passes vacuously with an explicit probe-only note", async () => {
    const root = await tempRoot()
    try {
      const file = await writeServiceless(root)
      const io = capture()
      try {
        await runPreflight({ rootDir: root, file: join(root, "ow.yaml"), json: false, probe: false })
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("probe-only: audit")
      expect(text).not.toContain("missing: boundary:scenario-file:unreadable")
      void file
      const io2 = capture()
      try {
        await runPreflight({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false })
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        gates: { name: string; pass: boolean; detail: Record<string, unknown> }[]
      }
      const boundary = payload.gates.find((gate) => gate.name === "boundary")
      expect(boundary?.pass).toBe(true)
      expect(boundary?.detail["serviceless"]).toEqual(["audit"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acceptance 7: secret-shaped probe argv in serviceless file stays masked", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  audit:\n    services: []\n    probes: [{id: p, argv: [./x.sh, --token, hunter2]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n") + io.err.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acceptance 8: non-serviceless files carry no probe-only/serviceless markers", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [subscribed]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      try {
        await runPreflight({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false })
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("probe-only")
      expect(io.out.join("\n")).not.toContain("serviceless")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("probe-only")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M11 cross-parser parity: one fixture through both parsers (B1+B2)", () => {
  // Single identical fixture string fed to parseScenarios (cli) and
  // normalizeScenarios (dashboard mirror). Both must agree on all three
  // M11 verdicts: explicit [] accepted, missing key refused, vacuity refused.
  const SHARED = [
    "version: 1",
    "scenarios:",
    "  audit:",
    "    services: []",
    "    boundaries: [subscribed]",
    "    probes: [{id: envcheck, argv: [./scripts/env-audit.sh], timeout: 10s}]",
    "    checkpoints: [env-audited]",
    "",
  ].join("\n")

  test("(a) services [] with one probe accepted by both, services equal []", () => {
    const cli = parseScenarios(SHARED)
    expect(cli.scenarios).toHaveLength(1)
    expect(cli.scenarios[0].services).toEqual([])
    const mirror = normalizeScenarios(SHARED)
    expect(mirror.scenarios).toHaveLength(1)
    expect(mirror.scenarios[0].services).toEqual([])
    expect(mirror.scenarios[0].name).toBe(cli.scenarios[0].name)
  })

  test("(b) missing services key throws in both", () => {
    const body = "version: 1\nscenarios:\n  a:\n    probes: [{id: p, argv: [./x.sh]}]\n"
    expect(() => parseScenarios(body)).toThrow(/services required/)
    expect(() => normalizeScenarios(body)).toThrow(/services required/)
  })

  test("(c) services [] with zero probes throws in both", () => {
    for (const body of [
      "version: 1\nscenarios:\n  a:\n    services: []\n",
      "version: 1\nscenarios:\n  a:\n    services: []\n    probes: []\n",
    ]) {
      expect(() => parseScenarios(body)).toThrow()
      expect(() => normalizeScenarios(body)).toThrow()
    }
  })
})
