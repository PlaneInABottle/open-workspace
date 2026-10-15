/** Doctor observer health: log/hook/ring/db lines. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
