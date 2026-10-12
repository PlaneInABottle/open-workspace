/** M9 overlay boundaries: local convention + explicit flag (read-only).
 * Convention auto-load, flag override, guards, per-scenario REPLACE,
 * source tags, six-reader fan-out, absent-overlay parity. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { runContractCheck } from "./up-contract"
import { overlayBaseDigest } from "./up-overlay"
import { runPreflight, runReadiness } from "./up-preflight"
import { runProvisionCheck } from "./up-provision"
import { runRecord } from "./up-replay"
import { runScenarioRun } from "./up-scenario-run"
import { runScenariosCheck } from "./up-scenarios"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-ov-"))

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

const BASE = [
  "version: 1",
  "scenarios:",
  "  demo:",
  "    services: [api]",
  "    boundaries: [real-read-only]",
  "    probes: [{id: p, argv: [./x.sh]}]",
  "  other:",
  "    services: [api]",
  "    boundaries: [subscribed]",
  "    probes: [{id: p, argv: [./x.sh]}]",
  "",
].join("\n")

const writeBase = async (root: string): Promise<string> => {
  const file = join(root, "ow.scenarios.yaml")
  await writeFile(file, BASE, "utf8")
  await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
  return file
}

const writeLocal = async (root: string, body: string): Promise<string> => {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(root, ".ow"), { recursive: true })
  const file = join(root, ".ow", "boundaries.local.yaml")
  await writeFile(file, body, "utf8")
  return file
}

const okProbe = async (): Promise<{ ok: boolean; note: string; timedOut: boolean; code: number | null }> =>
  ({ ok: true, note: "ready", timedOut: false, code: 0 })

const okRestore = async (): Promise<{ ok: boolean; note: string }> => ({ ok: true, note: "restored" })

describe("overlay resolution (fail-before RED: ignored without wiring)", () => {
  test("convention overlay changes the merged view + [overlay] suffix + JSON tags", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n")
      const io = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("scenario: demo (1 services, 1 probes) [overlay]")
      expect(io.out.join("\n")).toContain("scenario: other (1 services, 1 probes)")
      expect(io.out.join("\n")).not.toContain("other (1 services, 1 probes) [overlay]")
      const io2 = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
        overlayApplied: boolean
        overlayFile: string
        boundarySources: { scenario: string; boundary: string; source: string }[]
      }
      expect(payload.overlayApplied).toBe(true)
      expect(payload.overlayFile).toBe("boundaries.local.yaml")
      expect(payload.boundariesNormalized).toContainEqual({ scenario: "demo", boundaries: ["network-deny"] })
      expect(payload.boundariesNormalized).toContainEqual({ scenario: "other", boundaries: ["subscribed"] })
      expect(payload.boundarySources).toContainEqual({ scenario: "demo", boundary: "network-deny", source: "local" })
      expect(payload.boundarySources).toContainEqual({ scenario: "other", boundary: "subscribed", source: "base" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("absent overlay is byte-identical to pre-M9 shape (no overlay keys, no suffix)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n") + io.err.join("\n")).not.toContain("overlay")
      expect(io.out.join("\n") + io.err.join("\n")).not.toContain("[overlay]")
      const io2 = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(
        ["boundariesNormalized", "boundaryWarnings", "file", "scenarios", "warnings"].sort(),
      )
      expect(JSON.stringify(payload)).not.toContain("overlay")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("overlay precedence + REPLACE (never union)", () => {
  test("flag wins over local wins over base", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n")
      const flagFile = join(root, "flag-ov.yaml")
      await writeFile(flagFile, "version: 1\nscenarios:\n  demo:\n    boundaries: [subscribed]\n", "utf8")
      const io = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: true, boundariesFlag: "flag-ov.yaml" })).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
        overlayFile: string
        boundarySources: { scenario: string; boundary: string; source: string }[]
      }
      expect(payload.overlayFile).toBe("flag-ov.yaml")
      expect(payload.boundariesNormalized).toContainEqual({ scenario: "demo", boundaries: ["subscribed"] })
      expect(payload.boundarySources).toContainEqual({ scenario: "demo", boundary: "subscribed", source: "flag" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("overlay replaces wholesale: multi-value base collapses to the overlay list", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only, subscribed]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n")
      const io = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: true })).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
      }
      // No union: exactly the overlay list, never base leftovers.
      expect(payload.boundariesNormalized).toEqual([{ scenario: "demo", boundaries: ["network-deny"] }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("legacy warn fires once across both files (shared seenLegacy)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [local]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [local]\n")
      const io = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n").split("legacy-boundary: local").length - 1).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("overlay hostile corpus", () => {
  test("traversal flag refuses exit 2, basename only", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file, "--boundaries", "../../etc/x.yaml"])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("overlay-refused: x.yaml (path must be root-relative)")
      expect(io.err.join("\n") + io.out.join("\n")).not.toContain("../../etc/x.yaml")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("absolute flag path refuses exit 2, basename only", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file, "--boundaries", "/etc/overlay.yaml"])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("overlay-refused: overlay.yaml (path must be root-relative)")
      expect(io.err.join("\n") + io.out.join("\n")).not.toContain("/etc/overlay.yaml")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("secret-smuggle overlay refuses exit 1, never leaks, writes nothing", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [token=hunter2]\n")
      const before = new Set(await readdir(join(root, ".ow")))
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const text = `${io.out.join("\n")}\n${io.err.join("\n")}`
      expect(text).toContain("overlay-refused: boundaries.local.yaml (secret-shaped value)")
      expect(text).not.toContain("hunter2")
      const after = new Set(await readdir(join(root, ".ow")))
      expect([...after]).toEqual([...before])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stale-shadow: digest-pin mismatch advises, never fails", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const { readFile } = await import("node:fs/promises")
      const digest = overlayBaseDigest(await readFile(file, "utf8"))
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      await writeLocal(root, `version: 1\nbaseDigest: deadbeef\nscenarios:\n  demo:\n    boundaries: [network-deny]\n`)
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("overlay-stale: base changed since deadbeef (warning)")
      expect(io.out.join("\n")).toContain("[overlay]")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dangling scenario refuses exit 1 with overlay-dangling", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  ghost:\n    boundaries: [network-deny]\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("overlay-dangling: ghost (refused)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("comma-unquoted blocked reason splits the flow list (quoting trap)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      // Unquoted comma: two flow entries — the tail warns UNVERIFIED.
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [blocked:fix, later]\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("demo: unknown boundaries: later (UNVERIFIED)")
      // Quoted comma: one boundary, no warning.
      await writeLocal(root, 'version: 1\nscenarios:\n  demo:\n    boundaries: [blocked:"fix, later"]\n')
      const io2 = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).not.toContain("UNVERIFIED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown overlay value warns UNVERIFIED, never refuses", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [outer-space]\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("demo: unknown boundaries: outer-space (UNVERIFIED)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("invalid overlay under --check refuses exit 1 naming overlay-refused", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  - blok liste yasak\n")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("overlay-refused: boundaries.local.yaml")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("overlay gitignore guard", () => {
  test("warns iff git present without an ignore entry; silent when gitless or ignored", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n")
      // Gitless: silent.
      const silent = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        silent.restore()
      }
      expect(silent.err.join("\n")).not.toContain("overlay-gitignore-missing")
      // Git present, no gitignore: warns.
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(root, ".git"), { recursive: true })
      const warns = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        warns.restore()
      }
      expect(warns.err.join("\n")).toContain("overlay-gitignore-missing: boundaries.local.yaml (warning)")
      // Git present with an ignore entry: silent again.
      await writeFile(join(root, ".gitignore"), "node_modules\n.ow/boundaries.local.yaml\n", "utf8")
      const quiet = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: false })).toBe(0)
      } finally {
        quiet.restore()
      }
      expect(quiet.err.join("\n")).not.toContain("overlay-gitignore-missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("overlay six-reader integration (identical merged view)", () => {
  const setup = async (root: string): Promise<string> => {
    const file = join(root, "ow.scenarios.yaml")
    await writeFile(
      file,
      "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n",
      "utf8",
    )
    await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
    await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [subscribed]\n")
    return file
  }

  test("all six readers agree on the merged view + source tags + banner", async () => {
    const root = await tempRoot()
    try {
      const file = await setup(root)
      const sources: unknown[] = []
      // 1. scenarios --check.
      const c1 = capture()
      try {
        expect(await runScenariosCheck({ file, rootDir: root, json: true })).toBe(0)
      } finally {
        c1.restore()
      }
      const check = JSON.parse(c1.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
        overlayApplied: boolean
        boundarySources: unknown
      }
      expect(check.boundariesNormalized).toEqual([{ scenario: "demo", boundaries: ["subscribed"] }])
      expect(check.overlayApplied).toBe(true)
      sources.push(check.boundarySources)
      // 2. preflight + 3. readiness share readBoundaryClaims.
      for (const runner of [
        (json: boolean) => runPreflight({ rootDir: root, file: join(root, "ow.yaml"), json, probe: false }),
        (json: boolean) => runReadiness({ rootDir: root, file: join(root, "ow.yaml"), json, probe: false }),
      ]) {
        const c = capture()
        try {
          await runner(true)
        } finally {
          c.restore()
        }
        const payload = JSON.parse(c.out.join("\n")) as { overlayApplied: boolean; boundarySources: unknown }
        expect(payload.overlayApplied).toBe(true)
        sources.push(payload.boundarySources)
      }
      // 4. provision.
      const c4 = capture()
      try {
        await runProvisionCheck({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false })
      } finally {
        c4.restore()
      }
      const provision = JSON.parse(c4.out.join("\n")) as { overlayApplied: boolean; boundarySources: unknown }
      expect(provision.overlayApplied).toBe(true)
      sources.push(provision.boundarySources)
      // 5. record (stubbed probe) carries the forgotten-overlay banner.
      const c5 = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "demo", probeFn: okProbe })).toBe(0)
      } finally {
        c5.restore()
      }
      expect(c5.out.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      // 6. contract matches the overlay-recorded definition + tags.
      const c6 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        c6.restore()
      }
      const contract = JSON.parse(c6.out.join("\n")) as {
        pass: boolean
        overlayApplied: boolean
        boundarySources: unknown
      }
      expect(contract.pass).toBe(true)
      expect(contract.overlayApplied).toBe(true)
      sources.push(contract.boundarySources)
      // 7. scenario run (stubbed probe + runner) reports overlay tags.
      const c7 = capture()
      try {
        expect(
          await runScenarioRun({ rootDir: root, file, name: "demo", json: true, probeFn: okProbe, runner: okRestore }),
        ).toBe(0)
      } finally {
        c7.restore()
      }
      const runPayload = JSON.parse(c7.out.join("\n")) as {
        overlayApplied: boolean
        boundarySources: unknown
        phases: { name: string }[]
      }
      expect(runPayload.overlayApplied).toBe(true)
      expect(runPayload.phases.map((phase) => phase.name)).toEqual(["setup", "run", "assert", "restore", "report"])
      sources.push(runPayload.boundarySources)
      // Identical merged view across every JSON reader.
      for (const entry of sources) {
        expect(entry).toEqual([{ scenario: "demo", boundary: "subscribed", source: "local" }])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--boundaries on a non-reader command is exit 2", async () => {
    const io = capture()
    let code = -1
    try {
      code = await run(["ps", "--boundaries", "x.yaml"])
    } finally {
      io.restore()
    }
    expect(code).toBe(2)
    expect(io.err.join("\n")).toContain("--boundaries can only be used with")
  })
})

describe("F1 hostile base secret masked in boundarySources (all JSON readers)", () => {
  test("base boundaries: [token=hunter2] + active overlay → zero hits", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [token=hunter2]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n  other:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  other:\n    boundaries: [subscribed]\n")
      const texts: string[] = []
      const runJson = async (invoke: () => Promise<number>): Promise<string> => {
        const io = capture()
        try {
          await invoke()
        } finally {
          io.restore()
        }
        const text = `${io.out.join("\n")}\n${io.err.join("\n")}`
        texts.push(text)
        return io.out.join("\n")
      }
      const checkOut = await runJson(() => runScenariosCheck({ file, rootDir: root, json: true }))
      const checkPayload = JSON.parse(checkOut) as {
        boundarySources: { scenario: string; boundary: string; source: string }[]
      }
      expect(checkPayload.boundarySources).toContainEqual({ scenario: "demo", boundary: "token=***", source: "base" })
      expect(checkPayload.boundarySources).toContainEqual({ scenario: "other", boundary: "subscribed", source: "local" })
      await runJson(() => runPreflight({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false }))
      await runJson(() => runReadiness({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false }))
      await runJson(() => runProvisionCheck({ rootDir: root, file: join(root, "ow.yaml"), json: true, probe: false }))
      await runJson(() => runContractCheck({ rootDir: root, file, json: true }))
      await runJson(() =>
        runScenarioRun({ rootDir: root, file, name: "other", json: true, probeFn: okProbe, runner: okRestore }),
      )
      const record = capture()
      try {
        await runRecord({ rootDir: root, file, runName: "other", probeFn: okProbe })
      } finally {
        record.restore()
      }
      texts.push(`${record.out.join("\n")}\n${record.err.join("\n")}`)
      for (const text of texts) expect(text).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("F2 forgotten-overlay banner on merged-view refusal paths", () => {
  const REFUSAL_BASE = (boundaries: string, extra = ""): string =>
    `version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: ${boundaries}\n    probes: [{id: p, argv: [./x.sh]}]\n${extra}`

  test("contract state-changing refusal banners when overlay active, silent without", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, REFUSAL_BASE("[real-read-only]", "    restore: {argv: [./restore.sh]}\n"), "utf8")
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [real-state-changing]\n")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("no contract: demo")
      expect(io.out.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      // Absent overlay: same refusal, no new banner.
      const bare = await tempRoot()
      try {
        const bareFile = join(bare, "ow.scenarios.yaml")
        await writeFile(bareFile, REFUSAL_BASE("[real-state-changing]", "    restore: {argv: [./restore.sh]}\n"), "utf8")
        await writeFile(join(bare, "ow.yaml"), OW_YAML, "utf8")
        const io2 = capture()
        let code2 = -1
        try {
          code2 = await runContractCheck({ rootDir: bare, file: bareFile, json: false })
        } finally {
          io2.restore()
        }
        expect(code2).toBe(2)
        expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("overlay-active")
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("scenario run refusals banner when overlay active, silent without", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  sc-refuse:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n  sc-nodet:\n    services: [api]\n    boundaries: [unverified]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n  sc-norestore:\n    services: [api]\n    boundaries: [subscribed]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  sc-refuse:\n    boundaries: [real-state-changing]\n")
      for (const [name, marker] of [
        ["sc-refuse", "state-changing boundaries are out of scope"],
        ["sc-nodet", "no deterministic boundary"],
        ["sc-norestore", "no restore declared"],
      ] as const) {
        const io = capture()
        let code = -1
        try {
          code = await runScenarioRun({ rootDir: root, file, name, json: false, probeFn: okProbe, runner: okRestore })
        } finally {
          io.restore()
        }
        expect(code).toBe(2)
        expect(io.err.join("\n")).toContain(marker)
        expect(io.out.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      }
      // Absent overlay: same refusal, no new banner (bare root, no
      // convention file, no flag).
      const bare = await tempRoot()
      try {
        const bareFile = join(bare, "ow.scenarios.yaml")
        await writeFile(
          bareFile,
          "version: 1\nscenarios:\n  sc-norestore:\n    services: [api]\n    boundaries: [subscribed]\n    probes: [{id: p, argv: [./x.sh]}]\n",
          "utf8",
        )
        await writeFile(join(bare, "ow.yaml"), OW_YAML, "utf8")
        const io3 = capture()
        let code3 = -1
        try {
          code3 = await runScenarioRun({ rootDir: bare, file: bareFile, name: "sc-norestore", json: false, probeFn: okProbe, runner: okRestore })
        } finally {
          io3.restore()
        }
        expect(code3).toBe(2)
        expect(io3.out.join("\n") + io3.err.join("\n")).not.toContain("overlay-active")
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("record refusals banner when overlay active, silent without", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n  nodet:\n    services: [api]\n    boundaries: [unverified]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [real-state-changing]\n")
      for (const [runName, marker] of [
        ["demo", "state-changing boundaries are not recorded"],
        ["nodet", "no deterministic boundary to record"],
        ["ghost", "scenario not found"],
      ] as const) {
        const io = capture()
        let code = -1
        try {
          code = await runRecord({ rootDir: root, file, runName, probeFn: okProbe })
        } finally {
          io.restore()
        }
        expect(code).toBe(2)
        expect(io.err.join("\n")).toContain(marker)
        expect(io.out.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      }
      // Absent overlay: same refusal, no new banner.
      const bare = await tempRoot()
      try {
        const bareFile = join(bare, "ow.scenarios.yaml")
        await writeFile(
          bareFile,
          "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-state-changing]\n    probes: [{id: p, argv: [./x.sh]}]\n",
          "utf8",
        )
        await writeFile(join(bare, "ow.yaml"), OW_YAML, "utf8")
        const io2 = capture()
        let code2 = -1
        try {
          code2 = await runRecord({ rootDir: bare, file: bareFile, runName: "demo", probeFn: okProbe })
        } finally {
          io2.restore()
        }
        expect(code2).toBe(2)
        expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("overlay-active")
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("overlay banner channel on refusal paths (stdout stays JSON-clean)", () => {
  test("contract refusal + json: banner on stderr, stdout empty", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [real-state-changing]\n")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.out.join("\n")).not.toContain("overlay-active")
      expect(io.err.join("\n")).toContain("overlay-active: boundaries.local.yaml")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("scenario run refusals + json: banner on stderr, stdout empty", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  sc-refuse:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    restore: {argv: [./restore.sh]}\n  sc-norestore:\n    services: [api]\n    boundaries: [subscribed]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      await writeLocal(root, "version: 1\nscenarios:\n  sc-refuse:\n    boundaries: [real-state-changing]\n")
      for (const name of ["sc-refuse", "sc-norestore"] as const) {
        const io = capture()
        let code = -1
        try {
          code = await runScenarioRun({ rootDir: root, file, name, json: true, probeFn: okProbe, runner: okRestore })
        } finally {
          io.restore()
        }
        expect(code).toBe(2)
        expect(io.out.join("\n")).not.toContain("overlay-active")
        expect(io.err.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("HIGH-1 absent boundaries key refuses (explicit [] stays allowed)", () => {
  test("absent key refuses exit 1, base untouched", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    notboundaries: [network-deny]\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("boundaries required in demo")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("explicit [] replaces with empty (intentional, distinguishable)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: []\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const payload = JSON.parse(io.out.join("\n")) as { scenarios: { name: string; boundaries: string[] }[] }
      expect(payload.scenarios.find((scenario) => scenario.name === "demo")?.boundaries).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("MEDIUM-4 symlinked .gitignore skips the mention check silently", () => {
  test("symlink .gitignore yields no gitignore warning (unverifiable, not missing)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n")
      const { mkdir, symlink } = await import("node:fs/promises")
      await mkdir(join(root, ".git"), { recursive: true })
      await writeFile(join(root, "outside-ignore"), "other\n", "utf8")
      await symlink(join(root, "outside-ignore"), join(root, ".gitignore"))
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const payload = JSON.parse(io.out.join("\n")) as { warnings: { message: string }[] }
      expect(payload.warnings.some((w) => w.message.includes("overlay-gitignore-missing"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("MEDIUM-7 intermediate symlink outside root refuses", () => {
  test("flag path through a symlinked dir refuses (outside root)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const outside = await mkdtemp(join(tmpdir(), "ow-ov-out-"))
      try {
        await writeFile(join(outside, "evil.yaml"), "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n", "utf8")
        const { symlink } = await import("node:fs/promises")
        await symlink(outside, join(root, "linkdir"))
        const io = capture()
        let code = -1
        try {
          code = await runScenariosCheck({ file, rootDir: root, json: false, boundariesFlag: "linkdir/evil.yaml" })
        } finally {
          io.restore()
        }
        expect(code).toBe(1)
        expect(io.err.join("\n")).toContain("outside root")
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("CLI raw-echo parity: hostile overlay names sanitize (no path leak)", () => {
  test("traversal scenario key refuses with basename echo, no ../ leak", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      await writeLocal(root, "version: 1\nscenarios:\n  ../../etc/passwd:\n    boundaries: [network-deny]\n")
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const err = io.err.join("\n")
      expect(err).toContain("overlay-dangling: passwd (refused)")
      expect(err).not.toContain("../")
      expect(err).not.toContain("/etc/passwd")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-i flag pointing at base file refuses (no self-merge)", () => {
  test("--boundaries ow.scenarios.yaml exits 1 naming self-reference", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      let code = -1
      try {
        code = await runScenariosCheck({ file, rootDir: root, json: false, boundariesFlag: "ow.scenarios.yaml" })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("must not point at the base file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
