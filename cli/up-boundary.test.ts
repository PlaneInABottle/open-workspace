/** M2 readiness with teeth: boundary-scan 4th gate + `ow readiness` verb +
 * known-false-green catalog. Pure kernel (`scanBoundaries`) has zero mocks:
 * crafted inputs ARE the real path. CLI tests drive the real file paths
 * (injectable `declaredArtifacts`/`migrationObserved` mirror the existing
 * `tcpCheck` injection precedent in `runPreflight`). */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { scanBoundaries, type BoundaryScanInput } from "./up-boundary"
import { evaluatePreflight } from "./up-preflight"
import { ensureUpStateDir, upPaths, writeSupervisorState, type UpServiceState } from "./up-state"
import type { EvidenceEnvelope } from "./up-evidence"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m2-"))

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

const envelope = (stage: string, status: EvidenceEnvelope["status"]): EvidenceEnvelope => ({
  stage,
  status,
  proof: { ok: true },
  at: "2026-10-09T08:00:00.000Z",
  by: "runner",
})

const baseInput = (): BoundaryScanInput => ({
  services: [],
  claims: [],
  records: [],
  envelopes: [],
  declaredArtifacts: {},
  migrationObserved: {},
  configVersion: undefined,
})

const recordOf = (entry: Record<string, unknown>): UpServiceState => entry as unknown as UpServiceState

describe("scanBoundaries: stale-jar catalog", () => {
  const recorded = { "app.jar": "aaabbbccdd" }

  test("digest mismatch -> stale-jar falseGreen", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "java -jar app.jar" }],
      records: [recordOf({ name: "api", pid: 7, artifactDigests: recorded })],
      declaredArtifacts: { api: { "app.jar": "fff000111" } },
    })
    expect(scan.falseGreens).toHaveLength(1)
    expect(scan.falseGreens[0]).toMatchObject({ kind: "stale-jar", service: "api" })
    expect(scan.falseGreens[0].hint).toContain("ow restart api")
    expect(scan.missing).toEqual([])
    expect(scan.stale).toEqual([])
  })

  test("precision: equal digests / absent declarations stay silent", () => {
    const services = [{ name: "api", cmd: "java -jar app.jar" }]
    const records = [recordOf({ name: "api", pid: 7, artifactDigests: recorded })]
    const same = scanBoundaries({ ...baseInput(), services, records, declaredArtifacts: { api: { ...recorded } } })
    expect(same).toEqual({ missing: [], stale: [], falseGreens: [] })
    const absent = scanBoundaries({ ...baseInput(), services, records })
    expect(absent).toEqual({ missing: [], stale: [], falseGreens: [] })
    const unrelated = scanBoundaries({
      ...baseInput(),
      services,
      records,
      declaredArtifacts: { api: { "other.jar": "fff000111" } },
    })
    expect(unrelated).toEqual({ missing: [], stale: [], falseGreens: [] })
  })
})

describe("scanBoundaries: boundary evidence (missing[])", () => {
  test("real-state-changing without backing evidence -> boundary: missing", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      claims: [{ scenario: "cart", service: "api", boundary: "real-state-changing" }],
    })
    expect(scan.missing).toEqual(["boundary:api:no-evidence"])
  })

  test("recorded readiness backs real-* claims (clean)", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      claims: [
        { scenario: "cart", service: "api", boundary: "real-read-only" },
        { scenario: "safe", service: "api", boundary: "real-state-changing" },
      ],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
    })
    expect(scan).toEqual({ missing: [], stale: [], falseGreens: [] })
  })

  test("subscribed needs confirmed checkpoint envelopes", () => {
    const input = {
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      claims: [{ scenario: "cart", service: "api", boundary: "subscribed" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
    }
    expect(scanBoundaries(input).missing).toEqual(["boundary:api:no-subscription"])
    const withProof = scanBoundaries({ ...input, envelopes: [envelope("approval", "confirmed")] })
    expect(withProof).toEqual({ missing: [], stale: [], falseGreens: [] })
  })

  test("unknown services + unverified/network-deny/blocked never fail (M1 preservation)", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      claims: [
        { scenario: "x", service: "ghost", boundary: "real-state-changing" },
        { scenario: "x", service: "api", boundary: "unverified" },
        { scenario: "x", service: "api", boundary: "network-deny" },
        { scenario: "x", service: "api", boundary: "blocked:maintenance" },
      ],
      records: [recordOf({ name: "api", pid: 7 })],
    })
    expect(scan).toEqual({ missing: [], stale: [], falseGreens: [] })
  })
})

describe("scanBoundaries: origin-403 discrimination", () => {
  test("403 note flags origin-gate (not down)", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: false, note: "not ready (exit code 7) — 403 foreign origin" } })],
    })
    expect(scan.falseGreens).toHaveLength(1)
    expect(scan.falseGreens[0]).toMatchObject({ kind: "origin-403", service: "api" })
  })

  test("precision: non-403 notes stay silent (real-down untouched)", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: false, note: "port closed" } })],
    })
    expect(scan.falseGreens).toEqual([])
  })
})

describe("scanBoundaries: msw-vite trap", () => {
  test("MSW marker + vite-preview flag the trap", () => {
    const msw = scanBoundaries({
      ...baseInput(),
      services: [{ name: "web", cmd: "node server.mjs --msw" }],
      records: [recordOf({ name: "web", pid: 7 })],
    })
    expect(msw.falseGreens).toHaveLength(1)
    expect(msw.falseGreens[0]).toMatchObject({ kind: "msw-vite-trap", service: "web" })
    const preview = scanBoundaries({
      ...baseInput(),
      services: [{ name: "web", cmd: "vite preview --port 8901" }],
      records: [recordOf({ name: "web", pid: 7 })],
    })
    expect(preview.falseGreens).toHaveLength(1)
    expect(preview.falseGreens[0].kind).toBe("msw-vite-trap")
  })

  test("precision: vite dev / echo / gradlew stay silent", () => {
    for (const cmd of ["vite dev --port 8901", "echo hi", "./gradlew bootRun"]) {
      const scan = scanBoundaries({
        ...baseInput(),
        services: [{ name: "web", cmd }],
        records: [recordOf({ name: "web", pid: 7 })],
      })
      expect(scan.falseGreens).toEqual([])
    }
  })
})

describe("scanBoundaries: v5 confusion", () => {
  test("non-v1 ow.yaml version flags every service", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }, { name: "web", cmd: "echo hi" }],
      records: [],
      configVersion: "5",
    })
    expect(scan.falseGreens).toHaveLength(2)
    expect(scan.falseGreens[0]).toMatchObject({ kind: "v5-confusion", service: "api" })
    expect(scan.falseGreens[1].service).toBe("web")
  })

  test("precision: absent/version-1 stays silent", () => {
    for (const configVersion of [undefined, "1"]) {
      const scan = scanBoundaries({
        ...baseInput(),
        services: [{ name: "api", cmd: "echo hi" }],
        configVersion,
      })
      expect(scan.falseGreens).toEqual([])
    }
  })
})

describe("scanBoundaries: migration history + record freshness", () => {
  test("migration markers without observed history -> missing (real-state-changing only)", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "prisma migrate deploy && node srv.js" }],
      claims: [{ scenario: "safe", service: "api", boundary: "real-state-changing" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
    })
    expect(scan.missing).toEqual(["boundary:api:no-migration-evidence"])
  })

  test("precision: observed history / no markers / read-only stay silent", () => {
    const observed = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "prisma migrate deploy && node srv.js" }],
      claims: [{ scenario: "safe", service: "api", boundary: "real-state-changing" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
      migrationObserved: { api: true },
    })
    expect(observed).toEqual({ missing: [], stale: [], falseGreens: [] })
    const noMarkers = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "node srv.js" }],
      claims: [{ scenario: "safe", service: "api", boundary: "real-state-changing" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
    })
    expect(noMarkers).toEqual({ missing: [], stale: [], falseGreens: [] })
    const readOnly = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "prisma migrate deploy && node srv.js" }],
      claims: [{ scenario: "safe", service: "api", boundary: "real-read-only" }],
      records: [recordOf({ name: "api", pid: 7, lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" } })],
    })
    expect(readOnly).toEqual({ missing: [], stale: [], falseGreens: [] })
  })

  test("record older than process -> stale-record", () => {
    const scan = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      records: [
        recordOf({
          name: "api",
          pid: 7,
          startedAt: "2026-10-09T09:00:00.000Z",
          lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" },
        }),
      ],
    })
    expect(scan.stale).toEqual(["boundary:api:stale-record"])
    expect(scan.missing).toEqual([])
  })

  test("precision: fresh/undated records stay silent", () => {
    const fresh = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      records: [
        recordOf({
          name: "api",
          pid: 7,
          startedAt: "2026-10-09T08:00:00.000Z",
          lastReadiness: { ok: true, at: "2026-10-09T09:00:00.000Z" },
        }),
      ],
    })
    expect(fresh.stale).toEqual([])
    const undated = scanBoundaries({
      ...baseInput(),
      services: [{ name: "api", cmd: "echo hi" }],
      records: [recordOf({ name: "api", pid: 7, startedAt: "t", lastReadiness: { ok: true } })],
    })
    expect(undated.stale).toEqual([])
  })
})

describe("evaluatePreflight 4th gate (boundary composition)", () => {
  test("boundary input absent -> 4th gate passes empty, old gates intact", () => {
    const result = evaluatePreflight({ expected: [], running: [], liveness: new Map(), envelopes: [] })
    expect(result.gates.map((gate) => gate.name)).toEqual(["reconcile", "provenance", "readiness", "boundary"])
    expect(result.gates.map((gate) => gate.pass)).toEqual([true, true, true, true])
    expect(result.pass).toBe(true)
    expect(result.missing).toEqual([])
  })

  test("boundary findings fail the gate and land in missing[]", () => {
    const result = evaluatePreflight({
      expected: [{ name: "api", cmd: "echo hi" }],
      running: [],
      liveness: new Map(),
      envelopes: [],
      boundary: {
        claims: [{ scenario: "safe", service: "api", boundary: "real-state-changing" }],
        declaredArtifacts: {},
        migrationObserved: {},
        configVersion: undefined,
      },
    })
    expect(result.pass).toBe(false)
    expect(result.gates[3]).toMatchObject({ name: "boundary", pass: false })
    expect(result.missing).toContain("boundary:api:no-evidence")
  })
})

describe("ow readiness CLI (real file paths)", () => {
  const OW_YAML = "services:\n  api:\n    cmd: sleep 30\n  db:\n    cmd: sleep 30\n"

  const writeState = async (root: string, services: Record<string, unknown>[]): Promise<void> => {
    const paths = upPaths(root)
    await ensureUpStateDir(paths.stateDir)
    await writeSupervisorState(paths.supervisorFile, {
      version: 1,
      startedAt: "2026-10-09T08:00:00.000Z",
      services: services as unknown as UpServiceState[],
    })
  }

  test("stale artifact + missing boundary -> exit 1 naming boundary: + stale-build (E1-a converges the shared drift line)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, OW_YAML, "utf8")
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  kasa:\n    services: [api, db]\n    boundaries: [real-state-changing]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeState(root, [
        {
          name: "api",
          pid: 4242,
          lstart: "fake",
          startedAt: "2026-10-09T08:00:00.000Z",
          cmd: "sleep 30",
          lastReadiness: { ok: true, at: "2026-10-09T08:00:00.000Z" },
          artifactDigests: { "app.jar": "aaabbbccdd" },
        },
      ])
      const { runReadiness } = await import("./up-preflight")
      const io = capture()
      let code = -1
      try {
        code = await runReadiness({
          rootDir: root,
          file,
          json: false,
          probe: false,
          declaredArtifacts: { api: { "app.jar": "fff000111" } },
        })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const text = io.out.join("\n")
      expect(text).toContain("boundary:db:no-evidence")
      expect(text).toContain("stale-build: api")
      const io2 = capture()
      try {
        expect(
          await runReadiness({ rootDir: root, file, json: true, probe: false, declaredArtifacts: { api: { "app.jar": "fff000111" } } }),
        ).toBe(1)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        ready: boolean
        missing: string[]
        stale: string[]
        falseGreens: { kind: string; service: string; hint: string }[]
        gates: { name: string }[]
      }
      expect(payload.ready).toBe(false)
      expect(payload.missing).toContain("boundary:db:no-evidence")
      expect(payload.falseGreens.map((entry) => entry.kind)).toContain("stale-jar")
      expect(payload.gates.map((gate) => gate.name)).toEqual(["reconcile", "provenance", "readiness", "boundary"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("clean fixture -> exit 0 (single pass line)", async () => {
    const root = await tempRoot()
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  api:\n    cmd: sleep 30\n", "utf8")
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      const { readLstart } = await import("./up-state")
      const lstart = (await readLstart(proc.pid)) ?? ""
      await writeState(root, [
        {
          name: "api",
          pid: proc.pid,
          lstart,
          startedAt: "2026-10-09T08:00:00.000Z",
          cmd: "sleep 30",
          lastReadiness: { ok: true, at: "2026-10-09T09:00:00.000Z" },
        },
      ])
      const io = capture()
      try {
        expect(await run(["readiness", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toEqual(["ready: readiness passed"])
    } finally {
      try {
        proc.kill("SIGKILL")
      } catch {
        // already gone
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test("usage: positional / --check -> exit 2; missing file -> exit 2", async () => {
    expect(await run(["readiness", "extra"])).toBe(2)
    const root = await tempRoot()
    try {
      expect(await run(["readiness", "--check"])).toBe(2)
      expect(await run(["readiness", "--file", join(root, "missing.yaml")])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile boundary values never leak (text + json + state untouched)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  api:\n    cmd: sleep 30\n", "utf8")
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [blocked:\"token=hunter2\", secret-token=hunter2, a1b2c3d4e5f60718293a4b5c6d7e8f9012345678]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeState(root, [])
      const paths = upPaths(root)
      const before = await readFile(paths.supervisorFile, "utf8")
      const { runReadiness } = await import("./up-preflight")
      const io = capture()
      try {
        await runReadiness({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      const io2 = capture()
      try {
        await runReadiness({ rootDir: root, file, json: true, probe: false })
      } finally {
        io2.restore()
      }
      const text = `${io.out.join("\n")}\n${io.err.join("\n")}\n${io2.out.join("\n")}\n${io2.err.join("\n")}`
      expect(text).not.toContain("hunter2")
      expect(text).not.toContain("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")
      expect(await readFile(paths.supervisorFile, "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
