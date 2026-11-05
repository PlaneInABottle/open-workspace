/** Doctor observer health: log/hook/ring/db lines. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { doctor } from "./doctor"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-doctor-"))

const fixtureDb = (path: string): void => {
  const db = new Database(path)
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY)")
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  db.close()
}

describe("doctor observer lines", () => {
  test("names exactly log/hook/ring/db, never an up line", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "shell-events.jsonl")
      await writeFile(log, `${JSON.stringify({ kind: "shell", command: "echo hi", timestamp: new Date().toISOString() })}\n`, "utf8")
      const db = join(root, "opencode.db")
      fixtureDb(db)
      const lines = await doctor({ logPath: log, dbPath: db })
      expect(lines.map((l) => l.name)).toEqual(["log", "hook", "ring", "db"])
      expect(lines.every((l) => l.ok)).toBe(true)
      expect(lines.find((l) => l.name === "hook")?.detail).toContain("shell")
      expect(lines.find((l) => l.name === "db")?.detail).toContain("session_message + session_v2 readable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing log and db fail their own lines with honest detail", async () => {
    const root = await tempRoot()
    try {
      const lines = await doctor({ logPath: join(root, "missing.jsonl"), dbPath: join(root, "missing.db") })
      expect(lines.map((l) => l.name)).toEqual(["log", "hook", "ring", "db"])
      const byName = new Map(lines.map((l) => [l.name, l]))
      expect(byName.get("log")?.ok).toBe(false)
      expect(byName.get("log")?.detail).toContain("unreadable")
      expect(byName.get("hook")?.detail).toBe("no log")
      expect(byName.get("ring")?.detail).toBe("no log")
      expect(byName.get("db")?.ok).toBe(false)
      expect(byName.get("db")?.detail).toContain("cannot open")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ring reports the oldest and newest record, the binding cap and unparseable lines", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "shell-events.jsonl")
      const rows = ["2026-11-01T10:00:00.000Z", "2026-11-03T10:00:00.000Z"].map((timestamp) =>
        JSON.stringify({ kind: "shell", command: "echo", timestamp }),
      )
      await writeFile(log, `${rows[0]}\n${"\u0000".repeat(468)}\n${rows[1]}\n`, "utf8")
      const ring = (await doctor({ logPath: log, dbPath: join(root, "none.db") })).find((l) => l.name === "ring")
      expect(ring?.detail).toContain("binding line cap 50k")
      expect(ring?.detail).toContain("oldest 2026-11-01T10:00:00.000Z, newest 2026-11-03T10:00:00.000Z")
      expect(ring?.detail).toContain("1 unparseable line(s)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ring names the byte cap when bytes, not lines, are the closer limit", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "sparse.jsonl")
      // Sparse file: ~100 MB apparent size, a few KB on disk; line count stays at 2.
      const handle = await Bun.file(log).writer()
      await handle.write(`${JSON.stringify({ kind: "shell", command: "x", timestamp: "2026-11-01T10:00:00.000Z" })}\n`)
      await handle.end()
      await truncate(log, 100 * 1024 * 1024)
      const ring = (await doctor({ logPath: log, dbPath: join(root, "none.db") })).find((l) => l.name === "ring")
      expect(ring?.detail).toContain("binding byte cap 100MB")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("db with missing tables is a db failure, never silent", async () => {
    const root = await tempRoot()
    try {
      const db = join(root, "opencode.db")
      new Database(db).close()
      const lines = await doctor({ logPath: join(root, "missing.jsonl"), dbPath: db })
      const entry = lines.find((l) => l.name === "db")
      expect(entry?.ok).toBe(false)
      expect(entry?.detail).toContain("missing tables")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
