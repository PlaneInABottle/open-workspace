import { describe, expect, test } from "bun:test"

import { helpText, parseArgs, toSessionsJson, toShowJson, toStuckJson } from "./cli"
import { buildTree, formatTree, parseSpawnLinks, treeIds } from "./tree"
import { groupByTask, type EnrichedRecord } from "./join"

const rec = (over: Record<string, unknown>): EnrichedRecord => over as EnrichedRecord

const subagentRow = (child: string, agent: string, description: string, ts: string) =>
  rec({
    kind: "tool-call",
    tool: "subagent",
    args: JSON.stringify({ agent, sessionID: child, description }),
    timestamp: ts,
    outcome: "completed",
    sessionID: "ses_parent",
  })

describe("cli routing", () => {
  test("help lists every subcommand, --json and exit codes", () => {
    const text = helpText()
    for (const word of ["doctor", "sessions", "show", "stuck", "meta", "prompts", "reads", "up", "down", "ps", "logs", "--json", "--help", "--rm", "--check", "--detach"]) {
      expect(text).toContain(word)
    }
    expect(text).toContain("0 ok, 1 structural error, 2 usage error")
    expect(text).toContain("30m|3h|1d|1w")
    expect(text).toContain("show/stuck/meta/sessions/reads/prompts")
  })

  test("parseArgs routes subcommand, session and flags", () => {
    const parsed = parseArgs(["show", "abc123", "--tree", "--since", "1d", "--json"])
    expect(parsed.error).toBeNull()
    expect(parsed.command).toBe("show")
    expect(parsed.sessionID).toBe("abc123")
    expect(parsed.flags["--tree"]).toBe(true)
    expect(parsed.flags["--json"]).toBe(true)
    expect(parsed.flags["--since"]).toBe("1d")
  })

  test("parseArgs accepts the list alias and stuck flags", () => {
    const listed = parseArgs(["list", "--since", "3h"])
    expect(listed.error).toBeNull()
    expect(listed.command).toBe("sessions")
    const stuck = parseArgs(["stuck", "ses_x", "--tree"])
    expect(stuck.error).toBeNull()
    expect(stuck.command).toBe("stuck")
    expect(stuck.sessionID).toBe("ses_x")
  })

  test("parseArgs rejects unknown commands, flags and bad windows", () => {
    expect(parseArgs(["frobnicate"]).error).not.toBeNull()
    expect(parseArgs(["show", "--bogus"]).error).toContain("unknown option")
    expect(parseArgs(["show", "--since", "bogus"]).error).toContain("invalid --since")
    expect(parseArgs(["show", "--since", "30s"]).error).toContain("invalid --since")
    expect(parseArgs(["show", "--bytes", "bogus"]).error).toContain("invalid --bytes")
    expect(parseArgs([]).error).toContain("command expected")
  })

  test("parseArgs routes up/down/ps/logs flags and -d alias", () => {
    const up = parseArgs(["up", "--check", "--file", "ow.yaml"])
    expect(up.error).toBeNull()
    expect(up.command).toBe("up")
    const detached = parseArgs(["up", "-d"])
    expect(detached.error).toBeNull()
    expect(detached.flags["--detach"]).toBe(true)
    const logs = parseArgs(["logs", "web", "--tail", "50", "--grep", "err"])
    expect(logs.error).toBeNull()
    expect(logs.command).toBe("logs")
    expect(logs.sessionID).toBe("web")
    expect(parseArgs(["logs", "--tail", "bogus"]).error).toContain("invalid --tail")
    expect(parseArgs(["logs", "--tail", "99999"]).error).toContain("invalid --tail")
  })
})

describe("cli --json shapes", () => {
  test("sessions envelope keeps stable English keys", () => {
    const payload = toSessionsJson([
      { sessionID: "s1", commands: 2, fileEdits: 1, fails: 0, first: "a", last: "b", workdir: "/w" },
    ])
    expect(Object.keys(payload)).toEqual(["sessions"])
    expect(Object.keys(payload.sessions[0]).sort()).toEqual(
      ["commands", "fails", "fileEdits", "first", "last", "sessionID", "workdir"].sort(),
    )
    expect(() => JSON.stringify(payload)).not.toThrow()
  })

  test("show envelope carries session, warnings and groups", () => {
    const groups = groupByTask([rec({ command: "echo hi", outcome: "success", taskRef: "t" })])
    const payload = toShowJson("ses_p", ["w1"], groups)
    expect(Object.keys(payload).sort()).toEqual(["groups", "session", "warnings"].sort())
    expect(payload.session).toBe("ses_p")
  })

  test("stuck envelope carries session and report", () => {
    const payload = toStuckJson("ses_p", { retries: [], rereads: [], slow: [], interruptions: 0, compactions: 0, afterInterrupt: [] })
    expect(Object.keys(payload).sort()).toEqual(["report", "session"].sort())
    expect(Object.keys(payload.report).sort()).toEqual(
      ["afterInterrupt", "compactions", "interruptions", "rereads", "retries", "slow"].sort(),
    )
  })
})

describe("tree builder", () => {
  const fixture = () => {
    const by = new Map<string, EnrichedRecord[]>()
    by.set("ses_parent", [
      rec({ command: "echo start", outcome: "success", taskRef: "iş", timestamp: "2026-10-05T10:00:00.000Z" }),
      subagentRow("ses_child_b", "implementer", "ikinci iş", "2026-10-05T10:02:00.000Z"),
      subagentRow("ses_child_a", "explore", "ilk iş", "2026-10-05T10:01:00.000Z"),
    ])
    by.set("ses_child_a", [
      rec({ command: "grep x", outcome: "success", taskRef: "ara", timestamp: "2026-10-05T10:03:00.000Z", sessionID: "ses_child_a" }),
    ])
    by.set("ses_child_b", [
      rec({ command: "ls", outcome: "success", taskRef: "listele", timestamp: "2026-10-05T10:04:00.000Z", sessionID: "ses_child_b" }),
    ])
    return by
  }

  test("spawn links match agent+sessionID+description in chronological order", () => {
    const links = parseSpawnLinks(fixture().get("ses_parent")!)
    expect(links.map((l) => l.childSessionID)).toEqual(["ses_child_a", "ses_child_b"])
    expect(links[0]).toMatchObject({ agent: "explore", description: "ilk iş" })
    expect(links[1]).toMatchObject({ agent: "implementer", description: "ikinci iş" })
  })

  test("children nest under spawn points, orphans still shown", () => {
    const by = fixture()
    by.set("ses_orphan", [rec({ command: "echo sahipsiz", outcome: "success", taskRef: "kayıp" })])
    const root = buildTree("ses_parent", by)
    expect(root.children.map((c) => c.sessionID)).toEqual(["ses_child_a", "ses_child_b", "ses_orphan"])
    expect(root.children[2].link).toBeNull()
    const text = formatTree(root, by)
    expect(text).toContain("session ses_parent")
    expect(text).toContain("↳ child [explore] ilk iş — ses_child_a")
    expect(text).toContain("↳ child [implementer] ikinci iş — ses_child_b")
    expect(text).toContain("(unlinked)")
    // child sections reuse grouped lines with short-id tags, indented
    expect(text).toContain("  task: ara")
    expect(text).toContain("[ses_child_a]")
  })

  test("subtrees deeper than 2 collapse to a ... line", () => {
    const by = new Map<string, EnrichedRecord[]>()
    const chain = ["ses_0", "ses_1", "ses_2", "ses_3"] as const
    by.set("ses_0", [subagentRow("ses_1", "a", "bir", "2026-10-05T10:00:00.000Z")])
    // fix parent tag on the spawn row (helper defaults to ses_parent)
    ;(by.get("ses_0")![0] as Record<string, unknown>).sessionID = "ses_0"
    by.set("ses_1", [rec({ kind: "tool-call", tool: "subagent", args: JSON.stringify({ agent: "a", sessionID: "ses_2", description: "iki" }), timestamp: "2026-10-05T10:01:00.000Z", outcome: "completed", sessionID: "ses_1" })])
    by.set("ses_2", [rec({ kind: "tool-call", tool: "subagent", args: JSON.stringify({ agent: "a", sessionID: "ses_3", description: "üç" }), timestamp: "2026-10-05T10:02:00.000Z", outcome: "completed", sessionID: "ses_2" })])
    by.set("ses_3", [rec({ command: "echo derin", outcome: "success", taskRef: "derin", sessionID: "ses_3" })])
    const root = buildTree("ses_0", by)
    expect(root.children[0].children[0].children[0].sessionID).toBe("ses_3")
    const text = formatTree(root, by)
    expect(text).toContain("...")
    expect(text).not.toContain("echo derin")
    expect(treeIds(root)).toEqual({
      sessionID: "ses_0",
      children: [
        { sessionID: "ses_1", children: [{ sessionID: "ses_2", children: [{ sessionID: "ses_3", children: [] }] }] },
      ],
    })
  })

  test("malformed subagent args never break the tree", () => {
    const by = new Map<string, EnrichedRecord[]>()
    by.set("ses_p", [
      rec({ kind: "tool-call", tool: "subagent", args: "not-json", timestamp: "2026-10-05T10:00:00.000Z" }),
      rec({ kind: "tool-call", tool: "subagent", args: JSON.stringify({ agent: "x" }), timestamp: "2026-10-05T10:01:00.000Z" }),
      rec({ command: "echo ok", outcome: "success", taskRef: "t" }),
    ])
    expect(parseSpawnLinks(by.get("ses_p")!)).toEqual([])
    const text = formatTree(buildTree("ses_p", by), by)
    expect(text).toContain("session ses_p")
  })

  test("clipped subagent args still yield spawn links via field fallback", () => {
    const full = JSON.stringify({
      agent: "implementer",
      sessionID: "ses_clipped_child",
      model: "opencode-go/deepseek-v4.1-flash",
      description: "Add the missing guard",
      prompt: "x".repeat(900),
    })
    const clipped = full.slice(0, 500) // capture clips args; JSON.parse fails
    expect(() => JSON.parse(clipped)).toThrow()
    const links = parseSpawnLinks([
      rec({ kind: "tool-call", tool: "subagent", args: clipped, timestamp: "2026-10-05T10:00:00.000Z" }),
    ])
    expect(links).toEqual([
      { childSessionID: "ses_clipped_child", agent: "implementer", description: "Add the missing guard", time: links[0].time },
    ])
  })
})
