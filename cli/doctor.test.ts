/** Doctor up-line stale-supervisor hint: pure compare unit coverage plus
 * silent-path integration (missing record/sidecar never hints, corrupt
 * state keeps its existing path). The mismatch-through-`doctor()` path is
 * unreachable under bun (no sidecar beside the test runner) — the pure
 * helper carries those assertions instead. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { doctor } from "./doctor"
import { DEFAULT_DB_PATH as DOCTOR_DB_PATH, DEFAULT_LOG_PATH as DOCTOR_LOG_PATH, staleSupervisorHint } from "./doctor"
import { DEFAULT_DB_PATH as JOIN_DB_PATH, DEFAULT_LOG_PATH as JOIN_LOG_PATH } from "./join"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-doctor-"))

describe("default paths single source", () => {
  test("doctor defaults equal the join exports (no drift)", () => {
    expect(DOCTOR_LOG_PATH).toBe(JOIN_LOG_PATH)
    expect(DOCTOR_DB_PATH).toBe(JOIN_DB_PATH)
  })
})

describe("staleSupervisorHint", () => {
  test("match, either side missing, or empty digests → silent", () => {
    const built = { sha: "s", digest: "d", time: "2026-10-08T07:00:00Z" }
    expect(staleSupervisorHint(built, { ...built })).toBe("")
    expect(staleSupervisorHint(undefined, { ...built })).toBe("")
    expect(staleSupervisorHint(null, { ...built })).toBe("")
    expect(staleSupervisorHint(built, null)).toBe("")
    expect(staleSupervisorHint({ ...built, digest: "" }, { ...built, digest: "" })).toBe("")
  })

  test("digest mismatch names both times, the scope, and the effective remedy", () => {
    const hint = staleSupervisorHint(
      { sha: "old", digest: "d-old", time: "2026-10-07T07:00:00Z" },
      { sha: "new", digest: "d-new", time: "2026-10-08T07:00:00Z" },
      ["api", "web"],
    )
    expect(hint).toContain("stale")
    expect(hint).toContain("2026-10-07T07:00:00Z")
    expect(hint).toContain("2026-10-08T07:00:00Z")
    expect(hint).toContain("affecting 2 services (api, web)")
    expect(hint).toContain("restart the supervisor itself (ow down, then ow up) to refresh")
    expect(hint).toContain("per-service restart does not refresh a stale supervisor")
    expect(hint).not.toContain("ow restart api")
    expect(hint).not.toContain("blanket root down/up")
  })

  test("scope caps names, singularizes one service, and reads absent lists as unrecorded", () => {
    const built = (digest: string) => ({ sha: "s", digest, time: "2026-10-08T07:00:00Z" })
    const many = staleSupervisorHint(built("d-old"), built("d-new"), ["a", "b", "c", "d", "e", "f", "g"])
    expect(many).toContain("affecting 7 services (a, b, c, d, e (+2 more))")
    const one = staleSupervisorHint(built("d-old"), built("d-new"), ["solo"])
    expect(one).toContain("affecting 1 service (solo)")
    expect(one).not.toContain("ow restart solo")
    expect(one).toContain("per-service restart does not refresh a stale supervisor")
    const bare = staleSupervisorHint(built("d-old"), built("d-new"))
    expect(bare).toContain("(no recorded services)")
    expect(bare).toContain("restart the supervisor itself (ow down, then ow up) to refresh")
    expect(bare).toContain("per-service restart does not refresh a stale supervisor")
  })
})

describe("doctor up line without sidecars", () => {
  test("no recorded build and no disk sidecar stays silent (existing wording)", async () => {
    const root = await tempRoot()
    try {
      const lines = await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db"), upRoot: root })
      const up = lines.find((line) => line.name === "up")
      expect(up?.detail).toBe("idle (no running supervisor) — hint: ow reconcile --check")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-live up details carry the reconcile hint, live does not", async () => {
    const root = await tempRoot()
    try {
      const { mkdir, writeFile: write } = await import("node:fs/promises")
      const { readLstart, upPaths } = await import("./up-state")
      const paths = upPaths(root)
      await mkdir(paths.stateDir, { recursive: true })
      // Stale lock (dead pid) → `stale` + hint.
      await write(paths.lockFile, JSON.stringify({ pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }), "utf8")
      const stale = (await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db"), upRoot: root })).find(
        (line) => line.name === "up",
      )
      expect(stale?.ok).toBe(false)
      expect(stale?.detail).toContain("stale")
      expect(stale?.detail).toContain("hint: ow reconcile --check")
      // Corrupt lock → `unverifiable` + hint.
      await write(paths.lockFile, "corrupt{{{", "utf8")
      const corrupt = (await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db"), upRoot: root })).find(
        (line) => line.name === "up",
      )
      expect(corrupt?.detail).toContain("unverifiable")
      expect(corrupt?.detail).toContain("hint: ow reconcile --check")
      // Live lock, no state → hint-free live wording.
      const keeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      try {
        const lstart = (await readLstart(keeper.pid))!
        await write(paths.lockFile, JSON.stringify({ pid: keeper.pid, lstart, startedAt: new Date().toISOString() }), "utf8")
        const live = (await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db"), upRoot: root })).find(
          (line) => line.name === "up",
        )
        expect(live?.ok).toBe(true)
        expect(live?.detail).toBe("running (no state)")
      } finally {
        keeper.kill("SIGKILL")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt supervisor state keeps its existing path", async () => {
    const root = await tempRoot()
    try {
      const { mkdir, writeFile: write } = await import("node:fs/promises")
      const { acquireLock, upPaths } = await import("./up-state")
      const paths = upPaths(root)
      await mkdir(paths.stateDir, { recursive: true })
      await write(paths.supervisorFile, "corrupt{{{")
      await acquireLock(paths.lockFile, [])
      const lines = await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db"), upRoot: root })
      const up = lines.find((line) => line.name === "up")
      expect(up?.detail).toBe("running (no state)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
