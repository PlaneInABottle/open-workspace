import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { attachIntent, filterSince, formatGrouped, groupByTask, joinSession, loadSessionMessages, parseSince, showLine } from "./join"
import { signature } from "./signature"

const fixtureDb = (path: string) => {
  const db = new Database(path)
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
  const insert = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
  const rows: [string, string, string, number, string][] = [
    ["msg_user1", "ses_fix", "user", 1, JSON.stringify({ text: "make the tests pass" })],
    ["msg_tool1", "ses_fix", "assistant", 2, JSON.stringify({ content: [{ type: "text", text: "Trying the suite" }, { type: "tool", name: "shell" }] })],
    ["msg_tool2", "ses_fix", "assistant", 3, JSON.stringify({ content: [{ type: "tool", name: "shell" }] })],
  ]
  for (const [id, session, type, seq, data] of rows) insert.run(id, session, type, seq, 0, 0, data)
  db.close()
}

describe("join", () => {
  test("attaches same-row intent, falls back to preceding user text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "join-test-"))
    const dbPath = join(directory, "opencode.db")
    fixtureDb(dbPath)
    const db = new Database(dbPath, { readonly: true })
    const rows = loadSessionMessages(db, "ses_fix")
    db.close()
    expect(rows?.length).toBe(3)
    const withIntent = attachIntent({ messageID: "msg_tool1" }, rows ?? [])
    expect(withIntent.intent).toBe("Trying the suite")
    expect(withIntent.taskRef).toBe("make the tests pass")
    const fallback = attachIntent({ messageID: "msg_tool2" }, rows ?? [])
    expect(fallback.intent).toBe("make the tests pass")
    const missing = attachIntent({ messageID: "msg_nope" }, rows ?? [])
    expect(missing.intent).toBeNull()
    const noID = attachIntent({}, rows ?? [])
    expect(noID.intent).toBeNull()
  })

  test("joinSession emits intent-less records when the message table is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "join-test-"))
    const logPath = join(directory, "events.jsonl")
    await writeFile(logPath, JSON.stringify({ sessionID: "ses_x", messageID: "msg_1", command: "echo hi" }) + "\n")
    const emptyDb = join(directory, "empty.db")
    new Database(emptyDb).close()
    const { records, warnings } = await joinSession({ dbPath: emptyDb, logPath, sessionID: "ses_x" })
    expect(records.length).toBe(1)
    expect(records[0].intent).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("narrow window keeps intent: referenced rows and user context are pinned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "join-test-"))
    const dbPath = join(directory, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const now = Date.now()
    insert.run("msg-old-task", "ses_pin", "user", 10, now - 12 * 3600_000, 0, JSON.stringify({ text: "Old intent task" }))
    insert.run("msg-new-run", "ses_pin", "assistant", 11, now - 600_000, 0, JSON.stringify({ content: [{ type: "text", text: "Running now" }] }))
    db.close()
    const logPath = join(directory, "events.jsonl")
    await writeFile(logPath, JSON.stringify({ sessionID: "ses_pin", messageID: "msg-new-run", command: "pnpm verify" }) + "\n")
    const { records } = await joinSession({ dbPath, logPath, sessionID: "ses_pin", sinceMs: 30 * 60_000, now })
    expect(records.length).toBe(1)
    expect(records[0].taskRef).toBe("Old intent task")
  })

  test("loadSessionMessages windows by sinceMs instead of head-capping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "join-test-"))
    const dbPath = join(directory, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const now = Date.now()
    insert.run("m_old", "ses_win", "user", 1, now - 48 * 3600_000, 0, JSON.stringify({ text: "old task" }))
    insert.run("m_new", "ses_win", "user", 2, now - 3600_000, 0, JSON.stringify({ text: "new task" }))
    db.close()
    const ro = new Database(dbPath, { readonly: true })
    const windowed = loadSessionMessages(ro, "ses_win", 24 * 3600_000, now)
    expect(windowed?.map((r) => r.id)).toEqual(["m_new"])
    const all = loadSessionMessages(ro, "ses_win")
    expect(all?.length).toBe(2)
    ro.close()
  })

  test("loadSessionMessages cap keeps newest rows in ascending order", async () => {
    const { MAX_MESSAGE_ROWS } = await import("./join")
    const directory = await mkdtemp(join(tmpdir(), "join-test-"))
    const dbPath = join(directory, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const now = Date.now()
    for (let i = 1; i <= MAX_MESSAGE_ROWS + 1; i += 1) {
      insert.run(`m${i}`, "ses_cap", "user", i, now - 3600_000, 0, JSON.stringify({ text: `task ${i}` }))
    }
    db.close()
    const ro = new Database(dbPath, { readonly: true })
    const rows = loadSessionMessages(ro, "ses_cap", 24 * 3600_000, now)
    expect(rows?.length).toBe(MAX_MESSAGE_ROWS)
    expect(rows?.[0]?.id).toBe("m2")
    expect(rows?.[rows.length - 1]?.id).toBe(`m${MAX_MESSAGE_ROWS + 1}`)
    ro.close()
  })
})

describe("signature", () => {
  test("folds variants of the same shape", () => {
    expect(signature("  UV   run  Pytest X ")).toBe("uv run pytest")
    expect(signature("uv run pytest tests/a.py -x")).toBe(signature("uv run pytest tests/b.py"))
    expect(signature("git log --oneline -20")).toBe(signature("git log --oneline -50"))
    expect(signature(undefined)).toBe("unknown")
  })

  test("drops redirection-only pipe sides", () => {
    expect(signature("2>&1 | tail -5")).toBe("tail <n>")
    expect(signature("FOO=bar | cat")).toBe("cat")
  })

  test("backslash escapes survive splitting", () => {
    expect(signature('grep "a\\" | b" f | head')).toBe("grep <arg> <arg> | head")
    expect(signature("echo a\\ b | head")).toBe("echo <arg> | head")
  })
})

describe("groupByTask", () => {
  test("shows one taskRef header and collapses repeats with xN", () => {
    const records = [
      { command: "uv run pytest a", outcome: "failure", intent: "attempt 1", messageID: "m1", taskRef: "pass the tests" },
      { command: "uv run pytest a", outcome: "failure", intent: "attempt 2", messageID: "m2", taskRef: "pass the tests" },
      { command: "uv run pytest a", outcome: "success", intent: "done", messageID: "m3", taskRef: "pass the tests" },
      { command: "echo hi", outcome: "success", intent: null, messageID: null, taskRef: null },
    ]
    const groups = groupByTask(records)
    expect(groups.length).toBe(2)
    // newest task first: the null-taskRef record came last
    expect(groups[0].taskRef).toBe("(no task)")
    expect(groups[1].taskRef).toBe("pass the tests")
    expect(groups[1].runs).toBe(3)
    expect(groups[1].fails).toBe(2)
    expect(groups[1].lines.length).toBe(2)
    expect(groups[1].lines[0].runs).toBe(1)
    expect(groups[1].lines[1].runs).toBe(2)
    const text = formatGrouped(groups)
    expect(text).toContain("task: pass the tests (3 records, 2 failed)")
    expect(text).toContain("x2")
    expect(text.match(/task: pass the tests/g)?.length).toBe(1)
  })

  test("collapses by signature and strips env prefix for display", () => {
    const pad = "A".repeat(200)
    const records = [
      { command: `RUN_DIR=/x PYTHONPATH=/y uv run pytest ${pad} one`, outcome: "success", intent: null, messageID: "m1", taskRef: "t" },
      { command: `RUN_DIR=/x PYTHONPATH=/y uv run pytest ${pad} two`, outcome: "success", intent: null, messageID: "m2", taskRef: "t" },
    ]
    const groups = groupByTask(records)
    expect(groups[0].lines.length).toBe(1)
    expect(groups[0].lines[0].runs).toBe(2)
    expect(groups[0].lines[0].signature).toBe("uv run pytest")
    const text = formatGrouped(groups)
    expect(text).toContain("uv run pytest")
    expect(text).not.toContain("RUN_DIR")
  })

  test("lists distinct variants under one signature line", () => {    const records = [
      { command: "uv run pytest tests/a.py", outcome: "failure", intent: "one", messageID: "m1", taskRef: "t" },
      { command: "uv run pytest tests/b.py", outcome: "failure", intent: "two", messageID: "m2", taskRef: "t" },
      { command: "uv run pytest tests/c.py", outcome: "failure", intent: "three", messageID: "m3", taskRef: "t" },
      { command: "uv run pytest tests/d.py", outcome: "failure", intent: "four", messageID: "m4", taskRef: "t" },
    ]
    const groups = groupByTask(records)
    expect(groups[0].lines.length).toBe(1)
    expect(groups[0].lines[0].variants.length).toBe(4)
    expect(formatGrouped(groups)).toContain("more records --show 1")
    expect(showLine(groups, 1)).toContain("uv run pytest tests/d.py")
    expect(showLine(groups, 99)).toContain("line not found")
  })

  test("feeds raw multiline commands to signature so heredoc bodies never leak", () => {    const records = [
      { command: "uv run python - <<'PY'\nimport json\ntrial={'a':1}; x=1\nprint(trial)\nPY", outcome: "completed", intent: null, messageID: "m1", taskRef: "t" },
    ]
    const groups = groupByTask(records)
    expect(groups[0].lines.length).toBe(1)
    expect(groups[0].lines[0].signature).toBe("uv run python [py:json]")
    expect(groups[0].lines[0].signature).not.toContain("trial")
  })
})

describe("failure reasons (outcome-gated, multi, masked)", () => {
  const fail = (command: string, messageID: string) => ({ command, outcome: "failure", intent: null, messageID, taskRef: "t" })

  test("the outcome gate skips success records carrying raise text (RED-before: reason set)", () => {
    const groups = groupByTask([
      { command: `python -c "raise RuntimeError('boom')"`, outcome: "success", intent: null, messageID: "m1", taskRef: "t" },
    ])
    const line = groups[0].lines[0]
    expect(line.failReason).toBeNull()
    expect(line.failReasons).toEqual([])
    expect(line.failReasonCount).toBe(0)
    expect(line.failReasonSource).toBeNull()
    expect(formatGrouped(groups)).not.toContain("(reason:")
  })

  test("a single reason keeps the exact legacy string", () => {
    const groups = groupByTask([fail(`python -c "raise RuntimeError('boom')"`, "m1")])
    const line = groups[0].lines[0]
    expect(line.failReason).toBe("boom")
    expect(line.failReasons).toEqual(["boom"])
    expect(line.failReasonCount).toBe(1)
    expect(line.failReasonSource).toBe("command-text")
    expect(formatGrouped(groups)).toContain("(reason: boom)")
    expect(formatGrouped(groups)).not.toContain("+1 more")
  })

  test("merged distinct reasons collapse to first + count", () => {
    const groups = groupByTask([
      fail(`uv run pytest a; python -c "raise RuntimeError('db down')"`, "m1"),
      fail(`uv run pytest b; python -c "raise RuntimeError('timeout')"`, "m2"),
    ])
    expect(groups[0].lines.length).toBe(1)
    const line = groups[0].lines[0]
    expect(line.runs).toBe(2)
    expect(line.failReason).toBe("db down")
    expect(line.failReasons).toEqual(["db down", "timeout"])
    expect(line.failReasonCount).toBe(2)
    expect(formatGrouped(groups)).toContain("(reason: db down; +1 more)")
  })

  test("a third distinct reason counts beyond the stored cap", () => {
    const groups = groupByTask([
      fail(`uv run pytest a; python -c "raise RuntimeError('one')"`, "m1"),
      fail(`uv run pytest b; python -c "raise RuntimeError('two')"`, "m2"),
      fail(`uv run pytest c; python -c "raise RuntimeError('three')"`, "m3"),
    ])
    const line = groups[0].lines[0]
    expect(line.failReasons).toEqual(["one", "two"])
    expect(line.failReasonCount).toBe(3)
    expect(formatGrouped(groups)).toContain("(reason: one; +2 more)")
    const drill = showLine(groups, 1)
    expect(drill).toContain("--- reasons (from command text) ---")
    expect(drill).toContain("- one")
    expect(drill).toContain("- two")
    expect(drill).toContain("(+1 more)")
  })

  test("reasons are masked before emit (secret shapes never reach reason output)", () => {
    const groups = groupByTask([fail(`python -c "raise ValueError('token=hunter2 bad')"`, "m1")])
    const line = groups[0].lines[0]
    expect(line.failReason).toBe("token=*** bad")
    expect(line.failReasons).toEqual(["token=*** bad"])
    const drill = showLine(groups, 1)
    expect(drill).toContain("- token=*** bad")
    // (The raw `record:` variant keeps pre-existing raw-command behavior;
    // the masked invariant covers the new reason surfaces only.)
    expect(formatGrouped(groups)).toContain("(reason: token=*** bad)")
    const wire = JSON.parse(JSON.stringify(line)) as Record<string, unknown>
    expect(JSON.stringify([wire["failReason"], wire["failReasons"]])).not.toContain("hunter2")
  })

  test("wire carries the additive reason keys", () => {
    const groups = groupByTask([fail(`python -c "raise RuntimeError('boom')"`, "m1")])
    const wire = JSON.parse(JSON.stringify(groups[0].lines[0])) as Record<string, unknown>
    expect(wire["failReason"]).toBe("boom")
    expect(wire["failReasons"]).toEqual(["boom"])
    expect(wire["failReasonCount"]).toBe(1)
    expect(wire["failReasonSource"]).toBe("command-text")
  })
})

describe("grouped units (records + durationMs scope)", () => {
  test("reconciliation: group runs sum to the command + file-edit record count", () => {
    const records = [
      { command: "uv run pytest a", outcome: "failure", intent: null, messageID: "m1", taskRef: "t" },
      { command: "uv run pytest b", outcome: "success", intent: null, messageID: "m2", taskRef: "t" },
      { kind: "file-edit", tool: "edit", path: "src/a.ts", outcome: "completed", messageID: "m3", taskRef: "t" },
      { kind: "file-edit", tool: "edit", path: "src/b.ts", outcome: "completed", messageID: "m4", taskRef: "t" },
    ]
    const groups = groupByTask(records)
    const runs = groups.reduce((sum, group) => sum + group.runs, 0)
    const lineRuns = groups.flatMap((group) => group.lines).reduce((sum, line) => sum + line.runs, 0)
    expect(runs).toBe(4)
    expect(lineRuns).toBe(4)
    expect(formatGrouped(groups)).toContain("(4 records, 1 failed)")
  })
})

describe("joinSession sidecar prefilter (parse-cost only, completeness identical)", () => {
  const adversarialLog = (target: string): string => {
    const rows: string[] = [
      // File-head old-session records (a tail bound would drop these).
      JSON.stringify({ sessionID: target, messageID: "m-old-1", command: "echo ancient", outcome: "success" }),
      JSON.stringify({ sessionID: target, messageID: "m-old-2", command: "echo older", outcome: "failure" }),
      // Foreign sessions (key present, value differs → parse-then-reject).
      JSON.stringify({ sessionID: "ses_other", messageID: "m-x", command: "echo hi" }),
      // Our id as a substring of another field (key present → parsed, rejected).
      JSON.stringify({ sessionID: "ses_other", command: `uses ${target} id`, outcome: "success" }),
      // Keyless lines (skipped without parse; contributed nothing before either).
      JSON.stringify({ command: "no key here", outcome: "success" }),
      JSON.stringify({ note: `${target} mentioned without a key` }),
      // Broken lines (one carries the key substring → parse attempt, still []).
      "{{{corrupt",
      '{"sessionID": ',
      // Unicode bodies, keyed and keyless.
      JSON.stringify({ sessionID: target, messageID: "m-uni", command: "echo héllo wörld ✓", outcome: "success" }),
      JSON.stringify({ note: "çırağan monument ünïcode" }),
      "",
      "   ",
    ]
    return `${rows.join("\n")}\n`
  }

  test("EQUIVALENCE: prefilter output byte-identical to full parse on adversarial input", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { writeFile } = await import("node:fs/promises")
    const target = "ses_target"
    const dir = await mkdtemp(joinPath(tmpdir(), "prefilter-equiv-"))
    try {
      const log = joinPath(dir, "events.jsonl")
      await writeFile(log, adversarialLog(target), "utf8")
      // Reference: parse every non-blank line, exact-match filter (pre-prefilter semantics).
      const { readFile } = await import("node:fs/promises")
      const text = await readFile(log, "utf8")
      const expected = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as unknown
            const dict = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
            return dict && dict["sessionID"] === target ? [dict] : []
          } catch {
            return []
          }
        })
      const { joinSession } = await import("./join")
      const actual = await joinSession({ sessionID: target, logPath: log, dbPath: joinPath(dir, "missing.db") })
      expect(actual.records).toHaveLength(expected.length)
      expect(JSON.stringify(actual.records.map(({ intent: _i, taskRef: _t, ...rest }) => rest))).toBe(JSON.stringify(expected))
      expect(expected.length).toBe(3)
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("parse-count: 10k keyless + 100 relevant lines → exactly 100 parses", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const target = "ses_count"
    const dir = await mkdtemp(joinPath(tmpdir(), "prefilter-count-"))
    try {
      const lines: string[] = []
      for (let i = 0; i < 10_000; i += 1) lines.push(JSON.stringify({ note: `filler ${i}`, outcome: "success" }))
      for (let i = 0; i < 100; i += 1) {
        lines.push(JSON.stringify({ sessionID: target, messageID: `m-${i}`, command: `echo ${i}`, outcome: "success" }))
      }
      await writeFile(joinPath(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8")
      let parses = 0
      const realParse = JSON.parse
      JSON.parse = ((...args: [string, ...unknown[]]): unknown => {
        parses += 1
        return (realParse as (...a: unknown[]) => unknown)(...args)
      }) as typeof JSON.parse
      try {
        const { joinSession } = await import("./join")
        const actual = await joinSession({ sessionID: target, logPath: joinPath(dir, "events.jsonl"), dbPath: joinPath(dir, "missing.db") })
        expect(actual.records).toHaveLength(100)
      } finally {
        JSON.parse = realParse
      }
      expect(parses).toBe(100)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("since filter and agent tags", () => {
  test("parseSince accepts m/h/d windows", () => {
    expect(parseSince("30m")).toBe(30 * 60_000)
    expect(parseSince("3h")).toBe(3 * 3_600_000)
    expect(parseSince("2d")).toBe(2 * 86_400_000)
    expect(parseSince("1w")).toBe(604_800_000)
    expect(parseSince("bogus")).toBeNull()
    expect(parseSince(undefined)).toBeNull()
  })

  test("filterSince keeps recent rows in chronological order", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z")
    const records = [
      { command: "new", timestamp: "2026-10-05T11:30:00.000Z" },
      { command: "old", timestamp: "2026-10-05T01:00:00.000Z" },
      { command: "newest", timestamp: "2026-10-05T11:45:00.000Z" },
    ]
    const kept = filterSince(records, parseSince("3h"), now)
    expect(kept.map((r) => r.command)).toEqual(["new", "newest"])
  })

  test("lines carry the running agent tag", () => {
    const records = [
      { command: "uv run pytest a", outcome: "success", intent: null, messageID: "m1", taskRef: "t", agent: "implementer" },
      { command: "uv run pytest b", outcome: "success", intent: null, messageID: "m2", taskRef: "t", agent: "coordinator" },
    ]
    const text = formatGrouped(groupByTask(records))
    expect(text).toContain("(implementer+coordinator)")
  })
})

describe("show-fails", () => {
  test("showLine lists full variants with intents", () => {
    const records = [
      { command: "uv run pytest a", outcome: "failure", intent: "dene", messageID: "m1", taskRef: "t" },
    ]
    const groups = groupByTask(records)
    const text = showLine(groups, 1)
    expect(text).toContain("uv run pytest a")
    expect(text).toContain("dene")
    expect(text).toContain("m1")
  })
})

describe("excerpts", () => {
  test("failure lines carry output excerpt in summary and full in show", () => {
    const records = [
      { command: "uv run pytest a", outcome: "failure", intent: null, messageID: "m1", taskRef: "t", excerpt: "FAILED test_x - assert 1==2" },
    ]
    const groups = groupByTask(records)
    expect(groups[0].lines[0].excerpts).toEqual(["FAILED test_x - assert 1==2"])
    expect(formatGrouped(groups)).toContain("output: FAILED test_x - assert 1==2")
    expect(showLine(groups, 1)).toContain("FAILED test_x - assert 1==2")
  })
})

describe("file-edit", () => {
  test("groupByTask shows file edits as edit lines", () => {
    const records = [
      { kind: "file-edit", tool: "edit", path: "src/a.ts", outcome: "completed", messageID: "m1", taskRef: "t" },
      { command: "uv run pytest a", outcome: "success", messageID: "m2", taskRef: "t" },
    ]
    const text = formatGrouped(groupByTask(records))
    expect(text).toContain("edit <path>")
  })
})

describe("listSessions", () => {
  test("lists sessions with counts, time span and dir filter", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const dir = await mkdtemp(joinPath(tmpdir(), "list-test-"))
    const logPath = joinPath(dir, "events.jsonl")
    const lines = [
      { sessionID: "s1", timestamp: "2026-10-05T10:00:00.000Z", workdir: "/a/resai", command: "echo hi", outcome: "success" },
      { sessionID: "s1", timestamp: "2026-10-05T11:00:00.000Z", workdir: "/a/resai", kind: "file-edit", path: "x.ts", outcome: "completed" },
      { sessionID: "s2", timestamp: "2026-10-05T11:30:00.000Z", workdir: "/b/other", command: "bad", outcome: "failure" },
    ]
    await writeFile(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    const { listSessions } = await import("./join")
    const all = await listSessions({ logPath })
    expect(all.length).toBe(2)
    expect(all[0].sessionID).toBe("s2")
    expect(all.find((s) => s.sessionID === "s1")).toMatchObject({ commands: 1, fileEdits: 1, fails: 0 })
    expect(all.find((s) => s.sessionID === "s2")).toMatchObject({ fails: 1 })
    const filtered = await listSessions({ logPath, dir: "/a/resai" })
    expect(filtered.map((s) => s.sessionID)).toEqual(["s1"])
  })

  test("dir filter applies to stored fallback too (workdir-less rows don't leak)", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { Database } = await import("bun:sqlite")
    const dir = await mkdtemp(joinPath(tmpdir(), "list-test-"))
    const logPath = joinPath(dir, "events.jsonl")
    await writeFile(logPath, JSON.stringify({ sessionID: "s9", timestamp: "2026-10-05T10:00:00.000Z", kind: "tool-call", tool: "subagent", outcome: "completed" }) + "\n")
    const dbPath = joinPath(dir, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)")
    db.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run("s9", "/elsewhere/proj")
    db.close()
    const { listSessions } = await import("./join")
    expect((await listSessions({ logPath, dbPath, dir: "/a/resai" })).length).toBe(0)
    expect((await listSessions({ logPath, dbPath, dir: "/elsewhere" })).map((s) => s.sessionID)).toEqual(["s9"])
  })

  test("falls back to stored directory when sidecar rows lack workdir", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { Database } = await import("bun:sqlite")
    const dir = await mkdtemp(joinPath(tmpdir(), "list-test-"))
    const logPath = joinPath(dir, "events.jsonl")
    await writeFile(logPath, JSON.stringify({ sessionID: "s9", timestamp: "2026-10-05T10:00:00.000Z", kind: "tool-call", tool: "subagent", outcome: "completed" }) + "\n")
    const dbPath = joinPath(dir, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)")
    db.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run("s9", "/stored/dir")
    db.close()
    const { listSessions } = await import("./join")
    const all = await listSessions({ logPath, dbPath })
    expect(all.length).toBe(1)
    expect(all[0].workdir).toBe("/stored/dir")
  })
})

describe("tool-call", () => {
  test("filterTools selects kind and tool substring", () => {
    const { filterTools } = require("./join") as typeof import("./join")
    const records = [
      { command: "echo hi", outcome: "success" },
      { kind: "file-edit", path: "a.ts", outcome: "completed" },
      { kind: "tool-call", tool: "mcp__ctx__resolve", outcome: "completed" },
    ]
    expect(filterTools(records, "tool-call").length).toBe(1)
    expect(filterTools(records, undefined, "mcp").length).toBe(1)
    expect(filterTools(records, "shell").length).toBe(1)
    expect(filterTools(records).length).toBe(3)
  })
})

describe("readDigest", () => {
  test("aggregates reads by path with agents and ranges", () => {
    const { readDigest, formatReads } = require("./join") as typeof import("./join")
    const records = [
      { kind: "tool-call", tool: "read", args: JSON.stringify({ path: "a.ts", offset: 1, limit: 50 }), agent: "explore" },
      { kind: "tool-call", tool: "read", args: JSON.stringify({ path: "a.ts", offset: 51, limit: 50 }), agent: "explore" },
      { kind: "tool-call", tool: "read", args: JSON.stringify({ path: "b.ts" }), agent: "build" },
      { command: "echo hi", outcome: "success" },
    ]
    const stats = readDigest(records)
    expect(stats.length).toBe(2)
    expect(stats[0]).toMatchObject({ path: "a.ts", reads: 2, agents: ["explore"] })
    expect(stats[0].ranges).toEqual(["1-51", "51-101"])
    expect(formatReads(stats)).toContain("2x a.ts (explore) [lines: 1-51, 51-101]")
  })
})

describe("sessionMeta", () => {
  test("reads cost, tokens and change summary from fixture db", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { Database } = await import("bun:sqlite")
    const { sessionMeta, formatMeta } = await import("./join")
    const dir = await mkdtemp(joinPath(tmpdir(), "meta-test-"))
    const dbPath = joinPath(dir, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL)")
    db.run("INSERT INTO session_v2 (id, project_id, slug, directory, version, title, cost, tokens_input, tokens_output, summary_additions, summary_deletions, summary_files) VALUES ('s1','p','slug','/w','v','Test job',0.0123,1000,200,45,12,3)")
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    db.run("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('m1','s1','user',1,0,0,'{\"text\":\"do the thing\"}')")
    db.run("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('m2','s1','assistant',2,0,0,'{}')")
    db.close()
    const { meta, warning } = await sessionMeta({ dbPath, sessionID: "s1" })
    expect(warning).toBeNull()
    expect(meta).toMatchObject({ title: "Test job", cost: 0.0123, additions: 45, deletions: 12, files: 3, userTurns: 1, assistantTurns: 1 })
    expect(meta?.tokens).toMatchObject({ input: 1000, output: 200 })
    expect(formatMeta(meta!)).toContain("+45 -12 (3 files)")
    const missing = await sessionMeta({ dbPath, sessionID: "nope" })
    expect(missing.meta).toBeNull()
  })
})

describe("byte budget", () => {
  test("parseBytes accepts plain, k and m", async () => {
    const { parseBytes } = await import("./join")
    expect(parseBytes("512")).toBe(512)
    expect(parseBytes("1k")).toBe(1024)
    expect(parseBytes("2M")).toBe(2 * 1024 * 1024)
    expect(parseBytes("bogus")).toBeNull()
    expect(parseBytes(undefined)).toBeNull()
  })

  test("showLine clips sections to budget with remainder note", async () => {
    const { groupByTask, showLine } = await import("./join")
    const groups = groupByTask([
      { command: "uv run pytest a", outcome: "failure", intent: null, messageID: "m1", taskRef: "t", excerpt: "E".repeat(3000) },
    ])
    const full = showLine(groups, 1)
    expect(full).toContain("E".repeat(100))
    const clipped = showLine(groups, 1, 100)
    expect(clipped).toContain("more chars")
    expect(clipped.length).toBeLessThan(full.length)
  })
})

describe("verdictLine", () => {
  test("shows last output line for test runners only", async () => {
    const { verdictLine } = await import("./join")
    expect(verdictLine("uv run pytest", "collected 3\n4 passed in 1.1s =====")).toBe("4 passed in 1.1s =====")
    expect(verdictLine("ls <path>", "a\nb")).toBeNull()
    expect(verdictLine("uv run pytest", null)).toBeNull()
  })
})

describe("models", () => {
  test("attachIntent carries the message model, meta lists session models", async () => {
    const { attachIntent, sessionMeta } = await import("./join")
    const rows = [{ id: "m1", type: "assistant", data: { content: [{ type: "text", text: "hi" }], model: { id: "m-x", providerID: "p" } } }]
    const rec = attachIntent({ messageID: "m1" }, rows as any)
    expect(rec.model).toEqual({ id: "m-x", provider: "p" })
    expect(attachIntent({}, []).model).toBeNull()
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { Database } = await import("bun:sqlite")
    const dir = await mkdtemp(joinPath(tmpdir(), "model-test-"))
    const dbPath = joinPath(dir, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT NOT NULL, version TEXT NOT NULL, title TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER)")
    db.run("INSERT INTO session_v2 (id, project_id, slug, directory, version) VALUES ('s1','p','s','/w','v')")
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    db.run("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('m1','s1','assistant',1,0,0,'{\"content\":[],\"model\":{\"id\":\"m-x\",\"providerID\":\"p\"}}')")
    db.close()
    const { meta } = await sessionMeta({ dbPath, sessionID: "s1" })
    expect(meta?.models).toEqual(["m-x"])
  })
})

describe("doctor", () => {
  test("reports log, hooks, ring and db health", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { Database } = await import("bun:sqlite")
    const { doctor } = await import("./doctor")
    const dir = await mkdtemp(joinPath(tmpdir(), "doctor-test-"))
    const logPath = joinPath(dir, "events.jsonl")
    await writeFile(logPath, [
      JSON.stringify({ timestamp: new Date().toISOString(), sessionID: "s", command: "echo hi", kind: undefined }),
      JSON.stringify({ timestamp: new Date().toISOString(), sessionID: "s", kind: "file-edit", path: "a.ts" }),
    ].join("\n") + "\n")
    const dbPath = joinPath(dir, "opencode.db")
    const db = new Database(dbPath)
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY)")
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
    db.close()
    const lines = await doctor({ logPath, dbPath })
    const by = Object.fromEntries(lines.map((l) => [l.name, l]))
    expect(by.log.ok).toBe(true)
    expect(by.hook.detail).toContain("shell")
    expect(by.hook.detail).toContain("file-edit")
    expect(by.ring.ok).toBe(true)
    expect(by.db.ok).toBe(true)
    const missing = await doctor({ logPath: joinPath(dir, "missing.jsonl"), dbPath: joinPath(dir, "missing.db") })
    expect(missing.every((l) => !l.ok)).toBe(true)
  })

  test("up: line is informational (absent ok:false, live ok:true, stale ok:false)", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { doctor } = await import("./doctor")
    const { acquireLock, clearLock, upPaths } = await import("./up-state")
    const { ensureUpStateDir } = await import("./up-state")
    const dir = await mkdtemp(joinPath(tmpdir(), "doctor-up-"))
    const paths = upPaths(dir)
    await ensureUpStateDir(paths.stateDir)
    const absent = await doctor({ logPath: joinPath(dir, "missing.jsonl"), dbPath: joinPath(dir, "missing.db"), upRoot: dir })
    const upAbsent = absent.find((l) => l.name === "up")
    expect(upAbsent?.ok).toBe(false)
    expect(upAbsent?.detail).toContain("idle")
    await acquireLock(paths.lockFile, [])
    const live = await doctor({ logPath: joinPath(dir, "missing.jsonl"), dbPath: joinPath(dir, "missing.db"), upRoot: dir })
    expect(live.find((l) => l.name === "up")?.ok).toBe(true)
    expect(live.find((l) => l.name === "up")?.detail).toContain("running")
    await clearLock(paths.lockFile)
    await writeFile(
      paths.lockFile,
      JSON.stringify({ pid: 2147483647, lstart: "bogus", startedAt: new Date().toISOString() }),
      "utf8",
    )
    const stale = await doctor({ logPath: joinPath(dir, "missing.jsonl"), dbPath: joinPath(dir, "missing.db"), upRoot: dir })
    const upStale = stale.find((l) => l.name === "up")
    expect(upStale?.ok).toBe(false)
    expect(upStale?.detail).toContain("stale")
    await clearLock(paths.lockFile)
  })
})

describe("doctor build identity", () => {
  test("shape: installed shorts + supervisor record + match (match 3-ways)", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { doctorIdentity } = await import("./doctor")
    const { ensureUpStateDir, upPaths, writeSupervisorState } = await import("./up-state")
    const dir = await mkdtemp(joinPath(tmpdir(), "doctor-id-"))
    const paths = upPaths(dir)
    await ensureUpStateDir(paths.stateDir)
    const installed = { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f90", digest: "d".repeat(64), time: "2026-10-01T00:00:00Z", dirty: false }
    // No state file → supervisor absent, match unknown.
    expect(await doctorIdentity({ upRoot: dir, installed })).toEqual({
      installed: { sha8: "a1b2c3d4", dirty: false, time: "2026-10-01T00:00:00Z", binary8: "d".repeat(8) },
      supervisor: { state: "absent", startedAt: null, sha8: null, time: null },
      match: null,
    })
    await writeSupervisorState(paths.supervisorFile, {
      version: 1,
      startedAt: "2026-10-07T00:00:00.000Z",
      services: [],
      build: { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f90", digest: "d".repeat(64), time: "2026-10-07T00:00:00Z" },
    })
    // Same digest → match.
    const same = await doctorIdentity({ upRoot: dir, installed })
    expect(same.supervisor).toMatchObject({ state: "recorded", startedAt: "2026-10-07T00:00:00.000Z", sha8: "a1b2c3d4" })
    expect(same.match).toBe(true)
    // Differing digest → mismatch (compared internally, shorts on the wire).
    const other = await doctorIdentity({ upRoot: dir, installed: { ...installed, digest: "e".repeat(64) } })
    expect(other.match).toBe(false)
    expect(other.installed?.binary8).toBe("e".repeat(8))
    // Recorded but nothing installed → unknown.
    const none = await doctorIdentity({ upRoot: dir, installed: null })
    expect(none.installed).toBeNull()
    expect(none.match).toBeNull()
  })

  test("missing sidecar reads null installed; dirty flag parses", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { doctorIdentity, formatIdentity } = await import("./doctor")
    const { readBuildSidecar } = await import("./up-state")
    const dir = await mkdtemp(joinPath(tmpdir(), "doctor-id-"))
    expect(await readBuildSidecar(joinPath(dir, "missing-bin"))).toBeNull()
    const withDirty = await (async () => {
      const binDir = await mkdtemp(joinPath(tmpdir(), "doctor-bin-"))
      await writeFile(
        joinPath(binDir, "ow.build.json"),
        JSON.stringify({ sha: "s".repeat(40), digest: "d".repeat(64), time: "2026-10-01T00:00:00Z", dirty: true }),
        "utf8",
      )
      await writeFile(joinPath(binDir, "fake-ow"), "", "utf8")
      return readBuildSidecar(joinPath(binDir, "fake-ow"))
    })()
    expect(withDirty?.dirty).toBe(true)
    const identity = await doctorIdentity({ upRoot: dir, installed: null })
    expect(identity.installed).toBeNull()
    expect(formatIdentity(identity)).toEqual(["identity: installed unknown (no sidecar)", "identity: supervisor absent: unknown"])
  })

  test("NEGATIVE: no paths/execPath/secrets or full digests in identity JSON; exit unchanged", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join: joinPath } = await import("node:path")
    const { doctorFails } = await import("./cli")
    const { doctor, doctorIdentity } = await import("./doctor")
    const { ensureUpStateDir, upPaths, writeSupervisorState } = await import("./up-state")
    const dir = await mkdtemp(joinPath(tmpdir(), "doctor-id-"))
    const paths = upPaths(dir)
    await ensureUpStateDir(paths.stateDir)
    const secretSha = `token=hunter2${"a".repeat(28)}`
    await writeSupervisorState(paths.supervisorFile, {
      version: 1,
      startedAt: "2026-10-07T00:00:00.000Z",
      services: [],
      build: { sha: secretSha, digest: "d".repeat(64), time: "2026-10-07T00:00:00Z" },
    })
    const installed = { sha: "b".repeat(40), digest: "e".repeat(64), time: "2026-10-01T00:00:00Z" }
    const identity = await doctorIdentity({ upRoot: dir, installed })
    const wire = JSON.stringify(identity)
    expect(wire).not.toContain(process.execPath)
    expect(wire).not.toContain(secretSha)
    expect(wire).not.toContain("d".repeat(64))
    expect(wire).not.toContain("e".repeat(64))
    expect(wire).not.toContain(dir)
    // Human lines carry shorts only; identity never enters `lines`, so the
    // exit rule (which filters `lines`) is unchanged by identity.
    const lines = await doctor({ logPath: joinPath(dir, "missing.jsonl"), dbPath: joinPath(dir, "missing.db"), upRoot: dir })
    expect(lines.every((l) => l.name !== "identity")).toBe(true)
    const { formatIdentity } = await import("./doctor")
    const human = formatIdentity(identity)
    expect(human.length).toBe(2)
    expect(human.join("\n")).not.toContain("d".repeat(64))
    expect(doctorFails(lines)).toBe(doctorFails(lines.filter((l) => l.name !== "identity")))
  })
})

describe("prompts verb retired (refusal, English, sibling-shaped)", () => {
  test("ow prompts is an unknown command (exit 2 with the usage list, never silent)", async () => {
    const { run } = await import("./cli")
    const dir = await mkdtemp(join(tmpdir(), "ow-prompts-retired-"))
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
    let code = -1
    try {
      code = await run(["prompts", "sess-missing", "--db", join(dir, "nope.db")])
    } finally {
      console.log = origLog
      console.error = origError
    }
    expect(code).toBe(2)
    expect(`${out.join("\n")}\n${err.join("\n")}`).toContain("usage")
  })
})
