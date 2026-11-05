/** Reader tolerance: a store copy holding one NUL line (the live store has
 * one mid-file) must not break show/sessions/reads/last. Runs against a temp
 * copy via --log; the live log is never opened. */

import { describe, expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { run } from "./cli"

const FIXTURE_LOG = join(import.meta.dir, "parity-fixtures", "shell-events.jsonl")
const NUL_LINE = "\u0000".repeat(468)
const SESSION = "ses_fix"

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
  return {
    out,
    err,
    restore: () => {
      console.log = origLog
      console.error = origError
    },
  }
}

describe("reader tolerance for a store with a corrupt line", () => {
  test("show, sessions, reads and last exit 0 and keep the valid records", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-corrupt-"))
    try {
      // Copy of the fixture with a NUL line between the two valid records.
      const lines = (await readFile(FIXTURE_LOG, "utf8")).split("\n").filter((l) => l.trim().length > 0)
      const log = join(root, "shell-events.jsonl")
      await writeFile(log, [lines[0], NUL_LINE, ...lines.slice(1)].join("\n") + "\n", "utf8")

      // Intent DB with the real session_message schema (no intent rows needed).
      const db = join(root, "opencode.db")
      const handle = new Database(db)
      handle.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
      handle.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)")
      handle.close()

      const cases: Array<{ name: string; argv: string[]; expectInOut: string }> = [
        { name: "show", argv: ["show", SESSION, "--log", log, "--db", db], expectInOut: "echo hi" },
        { name: "sessions", argv: ["sessions", "--log", log, "--db", db, "--json"], expectInOut: SESSION },
        { name: "reads", argv: ["reads", SESSION, "--log", log, "--db", db], expectInOut: "" },
        { name: "last", argv: ["last", "echo", "--log", log], expectInOut: "echo hi" },
      ]
      for (const testCase of cases) {
        const io = capture()
        let code: number
        try {
          code = await run(testCase.argv)
        } finally {
          io.restore()
        }
        expect({ verb: testCase.name, code }).toEqual({ verb: testCase.name, code: 0 })
        expect(io.out.join("\n")).toContain(testCase.expectInOut)
      }

      // The corrupt line must not hide the valid records from the JSON reader either.
      const io = capture()
      try {
        await run(["sessions", "--log", log, "--db", db, "--json"])
      } finally {
        io.restore()
      }
      const parsed = JSON.parse(io.out.join("\n")) as { sessions: { sessionID: string; commands: number }[] }
      expect(parsed.sessions.map((s) => s.sessionID).sort()).toEqual(["ses_diger", "ses_fix"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the live store path is never written by these readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-corrupt-ro-"))
    try {
      const log = join(root, "shell-events.jsonl")
      await copyFile(FIXTURE_LOG, log)
      const before = await readFile(log, "utf8")
      const io = capture()
      try {
        await run(["sessions", "--log", log, "--db", join(root, "none.db"), "--json"])
      } finally {
        io.restore()
      }
      expect(await readFile(log, "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
