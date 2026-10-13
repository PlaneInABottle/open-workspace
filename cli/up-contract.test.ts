/** M5 `ow contract check`: digest-compare + ship-order gate. All paths are
 * pure (no exec anywhere on this verb): fixtures are real files, the record
 * side uses the real `runRecord` with injected probes. Test names English,
 * comments English. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { runContractCheck } from "./up-contract"
import type { ProbeOutcome } from "./up-probe"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m5c-"))

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

const SCENARIOS = "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: ready, argv: [./ready.sh], timeout: 10s}]\n    checkpoints: [approval]\n"

const fakeOutcome = (): ProbeOutcome => ({ ok: true, note: "fake-ready", timedOut: false, code: 0 })

const recordGolden = async (root: string, file: string): Promise<void> => {
  const { runRecord } = await import("./up-replay")
  const io = capture()
  try {
    expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(0)
  } finally {
    io.restore()
  }
}

type ContractJson = {
  pass: boolean
  compared: { scenario: string; hash: string; match: boolean; detail: string }[]
  missing: string[]
}

describe("ow contract check golden round-trip", () => {
  test("record→check green, exit 0, additive JSON shape", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordGolden(root, file)
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("contract: 1 scenarios match")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ContractJson
      expect(Object.keys(payload).sort()).toEqual(["compared", "missing", "pass"])
      expect(payload.pass).toBe(true)
      expect(payload.missing).toEqual([])
      expect(payload.compared).toHaveLength(1)
      expect(payload.compared[0]).toMatchObject({ scenario: "cart", match: true, detail: "match" })
      expect(payload.compared[0].hash).toMatch(/^[0-9a-f]{8}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("tampered definition -> exit 1 contract-mismatch (never silent)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordGolden(root, file)
      await writeFile(file, SCENARIOS.replace("./ready.sh", "./other.sh"), "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.out.join("\n")).toContain("contract-mismatch: cart")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(1)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ContractJson
      expect(payload.pass).toBe(false)
      expect(payload.compared[0]).toMatchObject({ scenario: "cart", match: false, detail: "definition-changed" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown hash -> exit 1 unknown-record (fail-closed, never silent pass)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.out.join("\n")).toContain("unknown-record: cart")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(1)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ContractJson
      expect(payload.pass).toBe(false)
      expect(payload.missing).toEqual(["cart"])
      expect(payload.compared).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("incomplete envelope -> exit 1 provenance-missing (field-level fail-closed)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordGolden(root, file)
      const { replayLocation } = await import("./up-replay")
      const { parseScenarios } = await import("./up-scenarios")
      const parsed = parseScenarios(SCENARIOS)
      const location = replayLocation(root, parsed.scenarios[0])
      if (location === null) throw new Error("test setup: no recordable boundary")
      const raw = await readFile(location.file, "utf8")
      const lines = raw.split("\n")
      const envelope = JSON.parse(lines[0]) as Record<string, unknown>
      const provenance = { ...(envelope["provenance"] as Record<string, unknown>) }
      delete provenance["runnerHash"]
      await writeFile(location.file, [JSON.stringify({ ...envelope, provenance }), ...lines.slice(1)].join("\n"), "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.out.join("\n")).toContain("provenance-missing: cart")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow contract check refusals + usage", () => {
  test("state-changing scenario -> exit 2 naming boundary (never compared)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  safe:\n    services: [api]\n    boundaries: [real-state-changing]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("real-state-changing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unverified-only file passes vacuous (M1 never-fail preserved)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [unverified]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const payload = JSON.parse(io.out.join("\n")) as ContractJson
      expect(payload).toMatchObject({ pass: true, compared: [], missing: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dispatch usage matrix", async () => {
    expect(await run(["contract"])).toBe(2)
    expect(await run(["contract", "check", "extra"])).toBe(2)
    expect(await run(["contract", "bogus"])).toBe(2)
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      expect(await run(["contract", "check", "--file", file, "--probe"])).toBe(2)
      expect(await run(["contract", "check", "--file", join(root, "missing.yaml")])).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("H2 contract digest covers M6/M7 fields", () => {
  test("editing restore.argv flips a recorded contract to mismatch (re-record to heal)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      const withRestore = "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: ready, argv: [./ready.sh], timeout: 10s}]\n    checkpoints: [approval]\n    restore: {argv: [./restore.sh], timeout: 10s}\n"
      await writeFile(file, withRestore, "utf8")
      await recordGolden(root, file)
      const io = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: false })).toBe(0)
      } finally {
        io.restore()
      }
      await writeFile(file, withRestore.replace("./restore.sh", "./restore-v2.sh"), "utf8")
      const io2 = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.out.join("\n")).toContain("contract-mismatch: cart")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("INERT scaffold refuses record and contract (runner parity)", () => {
  test("contract check on INERT exits 2", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      const { INIT_INERT_MARKER } = await import("./up-init")
      await writeFile(file, `${INIT_INERT_MARKER}\nversion: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: inert, argv: [true]}]\n    checkpoints: [ok]\n`, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain(`INERT: ${file}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-b hand-forged runnerHash refuses (definition hash right, runnerHash wrong)", () => {
  test("tampered runnerHash flips match to mismatch", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordGolden(root, file)
      const { replayLocation } = await import("./up-replay")
      const { parseScenarios } = await import("./up-scenarios")
      const parsed = parseScenarios(SCENARIOS)
      const location = replayLocation(root, parsed.scenarios[0])
      if (location === null) throw new Error("expected a replay location")
      const { readReplayFile } = await import("./up-replay")
      const stored = await readReplayFile(location.file)
      if (stored === null) throw new Error("expected a stored record")
      const forged = {
        ...stored.envelope,
        provenance: { ...stored.envelope.provenance, runnerHash: "forged-runner-hash" },
      }
      const lines = [JSON.stringify(forged)]
      for (const line of stored.lines) lines.push(JSON.stringify(line))
      await writeFile(location.file, `${lines.join("\n")}\n`, "utf8")
      // NOTE: rewriting the envelope keeps per-line digests valid, so the
      // reader still parses; the verdict must refuse on runnerHash.
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.out.join("\n")).toContain("contract-mismatch: cart")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

type ClaimsContractJson = ContractJson & {
  compared: (ContractJson["compared"][number] & { claims: unknown; claimsStatus: string })[]
}

const recordWithClaims = async (root: string, file: string): Promise<void> => {
  const { runRecord } = await import("./up-replay")
  const io = capture()
  try {
    expect(
      await runRecord({
        rootDir: root,
        file,
        runName: "cart",
        probeFn: async () => fakeOutcome(),
        claimEntrypoint: "smoke-entry",
        claimBoundary: ["db=fake:stub:v2:extra"],
      }),
    ).toBe(0)
  } finally {
    io.restore()
  }
}

describe("contract claims readback (verbatim witness, never a verdict)", () => {
  test("claimless record reads the unverified gap (human + json, pass kept)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordGolden(root, file)
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("claims: unverified (no caller claims recorded)")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ClaimsContractJson
      expect(payload.pass).toBe(true)
      expect(payload.compared[0].claims).toBeNull()
      expect(payload.compared[0].claimsStatus).toBe("unverified")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("CUT-5: recorded fake claims pass through verbatim without affecting pass", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordWithClaims(root, file)
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("contract: 1 scenarios match")
      expect(text).toContain("claims: entrypoint=smoke-entry")
      expect(text).toContain("claims: boundary db=fake:stub:v2:extra")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ClaimsContractJson
      expect(payload.pass).toBe(true)
      expect(payload.compared[0].claims).toEqual({
        entrypoint: "smoke-entry",
        boundaries: [{ name: "db", kind: "fake", ref: "stub:v2:extra" }],
      })
      expect(payload.compared[0].claimsStatus).toBe("recorded")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("tampered malformed claims read as uninterpretable without gating", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      await recordWithClaims(root, file)
      const { replayLocation, readReplayFile } = await import("./up-replay")
      const { parseScenarios } = await import("./up-scenarios")
      const parsed = parseScenarios(SCENARIOS)
      const location = replayLocation(root, parsed.scenarios[0])
      if (location === null) throw new Error("expected a replay location")
      const stored = await readReplayFile(location.file)
      if (stored === null) throw new Error("expected a stored record")
      // NOTE: envelope-only tamper keeps per-line digests valid, so the
      // reader still parses; only the claims view must degrade.
      const forged = { ...stored.envelope, claims: { entrypoint: 42 } }
      const lines = [JSON.stringify(forged)]
      for (const line of stored.lines) lines.push(JSON.stringify(line))
      await writeFile(location.file, `${lines.join("\n")}\n`, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runContractCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("claims: uninterpretable (UNVERIFIED)")
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as ClaimsContractJson
      expect(payload.pass).toBe(true)
      expect(payload.compared[0].claims).toBeNull()
      expect(payload.compared[0].claimsStatus).toBe("uninterpretable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile claim secrets stay absent from human and json readback", async () => {
    const root = await tempRoot()
    try {
      const hex40 = "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
      const bearerBody = "WxCdefGh0123456789._~-plus-xyz123456789"
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS, "utf8")
      const { runRecord } = await import("./up-replay")
      const io0 = capture()
      try {
        expect(
          await runRecord({
            rootDir: root,
            file,
            runName: "cart",
            probeFn: async () => fakeOutcome(),
            claimEntrypoint: `token=hunter2 ${hex40}`,
            claimBoundary: [`svc=fake:Bearer ${bearerBody}`],
          }),
        ).toBe(0)
      } finally {
        io0.restore()
      }
      const io = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: false })).toBe(0)
      } finally {
        io.restore()
      }
      const io2 = capture()
      try {
        expect(await runContractCheck({ rootDir: root, file, json: true })).toBe(0)
      } finally {
        io2.restore()
      }
      const text = `${io.out.join("\n")}\n${io.err.join("\n")}\n${io2.out.join("\n")}\n${io2.err.join("\n")}`
      for (const secret of ["hunter2", bearerBody, hex40]) {
        expect(text).not.toContain(secret)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
