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
import { staleSupervisorHint } from "./doctor"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-doctor-"))

describe("staleSupervisorHint", () => {
  test("match, either side missing, or empty digests → silent", () => {
    const built = { sha: "s", digest: "d", time: "2026-10-08T07:00:00Z" }
    expect(staleSupervisorHint(built, { ...built })).toBe("")
    expect(staleSupervisorHint(undefined, { ...built })).toBe("")
    expect(staleSupervisorHint(null, { ...built })).toBe("")
    expect(staleSupervisorHint(built, null)).toBe("")
    expect(staleSupervisorHint({ ...built, digest: "" }, { ...built, digest: "" })).toBe("")
  })

  test("digest mismatch names both times plus the refresh directive", () => {
    const hint = staleSupervisorHint(
      { sha: "old", digest: "d-old", time: "2026-10-07T07:00:00Z" },
      { sha: "new", digest: "d-new", time: "2026-10-08T07:00:00Z" },
    )
    expect(hint).toContain("bayat")
    expect(hint).toContain("2026-10-07T07:00:00Z")
    expect(hint).toContain("2026-10-08T07:00:00Z")
    expect(hint).toContain("ow down && ow up -d")
  })
})

describe("doctor up line without sidecars", () => {
  test("no recorded build and no disk sidecar stays silent (existing wording)", async () => {
    const root = await tempRoot()
    try {
      const lines = await doctor({ logPath: join(root, "yok.jsonl"), dbPath: join(root, "yok.db"), upRoot: root })
      const up = lines.find((line) => line.name === "up")
      expect(up?.detail).toBe("durgun (çalışan supervisor yok)")
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
      await write(paths.supervisorFile, "bozuk{{{")
      await acquireLock(paths.lockFile, [])
      const lines = await doctor({ logPath: join(root, "yok.jsonl"), dbPath: join(root, "yok.db"), upRoot: root })
      const up = lines.find((line) => line.name === "up")
      expect(up?.detail).toBe("çalışıyor (durum yok)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
