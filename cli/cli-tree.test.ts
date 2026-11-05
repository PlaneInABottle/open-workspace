import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { COMMANDS, helpText, parseArgs, run, SINCE_READERS, toSessionsJson, toShowJson } from "./cli"
import { buildTree, formatTree, parseSpawnLinks, treeIds } from "./tree"
import { groupByTask, sinceWindow, windowNotice, type EnrichedRecord } from "./join"

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
    for (const word of ["doctor", "sessions", "show", "meta", "reads", "version", "--json", "--help"]) {
      expect(text).toContain(word)
    }
    expect(text).toContain("0 ok, 1 structural error, 2 usage error")
    expect(text).toContain("30m|3h|1d|1w")
    expect(text).toContain("doctor/show/meta/sessions/reads/version")
    for (const dropped of ["\n  up ", "\n  restart ", "\n  down ", "reconcile", "\n  ps ", "\n  logs ", "init", "render", "where", "ow.yaml"]) {
      expect(text).not.toContain(dropped)
    }
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

  test("parseArgs accepts the list alias; retired stuck verb is rejected", () => {
    const listed = parseArgs(["list", "--since", "3h"])
    expect(listed.error).toBeNull()
    expect(listed.command).toBe("sessions")
    expect(parseArgs(["stuck", "ses_x", "--tree"]).error).not.toBeNull()
  })

  test("parseArgs rejects unknown commands, flags and bad windows", () => {
    expect(parseArgs(["frobnicate"]).error).not.toBeNull()
    expect(parseArgs(["show", "--bogus"]).error).toContain("unknown option")
    expect(parseArgs(["show", "--since", "bogus"]).error).toContain("invalid --since")
    expect(parseArgs(["show", "--since", "30s"]).error).toContain("invalid --since")
    expect(parseArgs(["show", "--bytes", "bogus"]).error).toContain("invalid --bytes")
    expect(parseArgs([]).error).toContain("command expected")
  })

  test("parseArgs rejects retired supervision verbs, flags and the -d alias", () => {
    for (const argv of [["up"], ["up", "--check"], ["restart", "api"], ["down"], ["reconcile", "--check"], ["ps"], ["logs"], ["init"], ["render"], ["where"]]) {
      expect(parseArgs(argv).error).not.toBeNull()
    }
    for (const argv of [["sessions", "--tail", "10"], ["show", "s", "--force"], ["doctor", "--file", "x"], ["reads", "s", "--wait", "5s"]]) {
      expect(parseArgs(argv).error).toContain("unknown option")
    }
  })
})

describe("--since readers guard + window envelope", () => {
  const capture = (): { err: string[]; restore: () => void } => {
    const err: string[] = []
    const saved = console.error
    console.error = (...args: unknown[]): void => {
      err.push(args.map(String).join(" "))
    }
    return { err, restore: () => {
      console.error = saved
    } }
  }

  test("non-reader verbs refuse --since fail-loud (exit 2)", async () => {
    for (const argv of [
      ["doctor", "--since", "1d"],
      ["meta", "ses_x", "--since", "1d"],
      ["version", "--since", "1d"],
    ]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
      expect(io.err.join("\n")).toContain("ow: --since can only be used with sessions, show, reads, last")
    }
  })

  test("the guard + help derive from SINCE_READERS (four readers, shared tokens)", () => {
    expect([...SINCE_READERS]).toEqual(["sessions", "show", "reads", "last"])
    expect(helpText()).toContain(`window: 30m|3h|1d|1w (${SINCE_READERS.join("/")})`)
  })

  test("sinceWindow freezes the cutoff with injected now; null without a window", () => {
    expect(sinceWindow("3h", 3 * 3_600_000, Date.parse("2026-10-05T12:00:00.000Z"))).toEqual({
      since: "3h",
      cutoff: "2026-10-05T09:00:00.000Z",
    })
    expect(sinceWindow(undefined, 1000, 0)).toBeNull()
    expect(sinceWindow("3h", null, 0)).toBeNull()
    expect(windowNotice({ since: "3h", cutoff: "2026-10-05T09:00:00.000Z" })).toBe(
      "window: --since 3h (cutoff 2026-10-05T09:00:00.000Z)",
    )
  })

  test("universal window: every --since reader's --json envelope carries window", async () => {
    // Pure builders: null by default, echoed when passed.
    const w = { since: "1h", cutoff: "2026-10-05T11:00:00.000Z" }
    expect(toSessionsJson([]).window).toBeNull()
    expect(toSessionsJson([], w)).toMatchObject({ window: w })
    const groups = groupByTask([rec({ command: "echo hi", outcome: "success", taskRef: "t" })])
    expect(toShowJson("s", [], groups).window).toBeNull()
    expect(toShowJson("s", [], groups, undefined, w)).toMatchObject({ window: w })
    // run()-level over the committed sidecar fixture.
    const runJson = async (argv: string[]): Promise<{ code: number; payload: Record<string, unknown> }> => {
      const out: string[] = []
      const saved = console.log
      console.log = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "))
      }
      try {
        const code = await run(argv)
        return { code, payload: JSON.parse(out.join("\n")) as Record<string, unknown> }
      } finally {
        console.log = saved
      }
    }
    const log = resolve(import.meta.dir, "parity-fixtures", "shell-events.jsonl")
    for (const argv of [
      ["sessions", "--json", "--log", log],
      ["show", "ses_fix", "--json", "--log", log],
      ["reads", "ses_fix", "--json", "--log", log],
    ]) {
      const { code, payload } = await runJson(argv)
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 0`)
      expect(payload).toHaveProperty("window")
      expect(payload["window"]).toBeNull()
    }
    const windowed = await runJson(["show", "ses_fix", "--json", "--log", log, "--since", "1d"])
    expect(windowed.code).toBe(0)
    expect(windowed.payload["window"]).toMatchObject({ since: "1d" })
  })

  test("sessions --json coverage: bounds of the store, pruned only when the window predates them", async () => {
    const log = resolve(import.meta.dir, "parity-fixtures", "shell-events.jsonl")
    const runJson = async (argv: string[]): Promise<Record<string, unknown>> => {
      const out: string[] = []
      const saved = console.log
      console.log = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "))
      }
      try {
        await run(argv)
      } finally {
        console.log = saved
      }
      return JSON.parse(out.join("\n")) as Record<string, unknown>
    }
    const unwindowed = await runJson(["sessions", "--json", "--log", log])
    expect(unwindowed["coverage"]).toEqual({
      firstTimestamp: "2026-09-01T10:00:00.000Z",
      lastTimestamp: "2026-09-01T11:00:00.000Z",
      pruned: false,
    })
    // A window reaching far before the 2026-09-01 fixture start is pruned.
    const wide = await runJson(["sessions", "--json", "--log", log, "--since", "3650d"])
    expect((wide["coverage"] as { pruned: boolean }).pruned).toBe(true)
  })

  test("removed overlay/scenario flags fail loud as unknown options (exit 2, never silent)", async () => {
    for (const argv of [
      ["sessions", "--boundaries", "x.yaml"],
      ["show", "ses_x", "--run", "x"],
      ["doctor", "--off-local"],
      ["reads", "ses_x", "--resume"],
      ["version", "--claim-entrypoint", "x"],
      ["meta", "ses_x", "--trace", "abc123"],
      ["sessions", "--min-spans", "2"],
      ["show", "ses_x", "--tracing"],
    ]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
      expect(io.err.join("\n")).toContain("unknown option")
    }
  })

  test("removed verbs are unknown commands (exit 2 with the usage list, never silent)", async () => {
    for (const argv of [["trace"], ["trace", "abc123"], ["checkpoints"], ["failures"], ["scenarios", "--check"], ["preflight"], ["readiness"], ["provision", "--check"], ["prompts"], ["prompts", "ses_x"], ["stuck"], ["stuck", "ses_x"], ["timeline"], ["timeline", "ses_x"], ["export"], ["export", "--bundle"], ["up"], ["restart", "api"], ["down"], ["reconcile", "--check"], ["ps"], ["logs"], ["init"], ["render"], ["where"]]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
    }
  })
})

describe("cli --json shapes", () => {
  test("sessions envelope keeps stable English keys", () => {
    const payload = toSessionsJson([
      { sessionID: "s1", commands: 2, fileEdits: 1, fails: 0, first: "a", last: "b", workdir: "/w" },
    ])
    expect(Object.keys(payload)).toEqual(["sessions", "window", "coverage"])
    expect(payload.window).toBeNull()
    expect(payload.coverage).toBeNull()
    expect(Object.keys(payload.sessions[0]).sort()).toEqual(
      ["commands", "fails", "fileEdits", "first", "last", "sessionID", "workdir"].sort(),
    )
    expect(() => JSON.stringify(payload)).not.toThrow()
  })

  test("show envelope carries session, warnings and groups", () => {
    const groups = groupByTask([rec({ command: "echo hi", outcome: "success", taskRef: "t" })])
    const payload = toShowJson("ses_p", ["w1"], groups)
    expect(Object.keys(payload).sort()).toEqual(["groups", "session", "warnings", "window"].sort())
    expect(payload.session).toBe("ses_p")
    expect(payload.window).toBeNull()
  })
})

describe("tree builder", () => {
  const fixture = () => {
    const by = new Map<string, EnrichedRecord[]>()
    by.set("ses_parent", [
      rec({ command: "echo start", outcome: "success", taskRef: "job", timestamp: "2026-10-05T10:00:00.000Z" }),
      subagentRow("ses_child_b", "implementer", "second job", "2026-10-05T10:02:00.000Z"),
      subagentRow("ses_child_a", "explore", "first job", "2026-10-05T10:01:00.000Z"),
    ])
    by.set("ses_child_a", [
      rec({ command: "grep x", outcome: "success", taskRef: "search", timestamp: "2026-10-05T10:03:00.000Z", sessionID: "ses_child_a" }),
    ])
    by.set("ses_child_b", [
      rec({ command: "ls", outcome: "success", taskRef: "list", timestamp: "2026-10-05T10:04:00.000Z", sessionID: "ses_child_b" }),
    ])
    return by
  }

  test("spawn links match agent+sessionID+description in chronological order", () => {
    const links = parseSpawnLinks(fixture().get("ses_parent")!)
    expect(links.map((l) => l.childSessionID)).toEqual(["ses_child_a", "ses_child_b"])
    expect(links[0]).toMatchObject({ agent: "explore", description: "first job" })
    expect(links[1]).toMatchObject({ agent: "implementer", description: "second job" })
  })

  test("children nest under spawn points, orphans still shown", () => {
    const by = fixture()
    by.set("ses_orphan", [rec({ command: "echo orphan", outcome: "success", taskRef: "lost" })])
    const root = buildTree("ses_parent", by)
    expect(root.children.map((c) => c.sessionID)).toEqual(["ses_child_a", "ses_child_b", "ses_orphan"])
    expect(root.children[2].link).toBeNull()
    const text = formatTree(root, by)
    expect(text).toContain("session ses_parent")
    expect(text).toContain("↳ child [explore] first job — ses_child_a")
    expect(text).toContain("↳ child [implementer] second job — ses_child_b")
    expect(text).toContain("(unlinked)")
    // child sections reuse grouped lines with short-id tags, indented
    expect(text).toContain("  task: search")
    expect(text).toContain("[ses_child_a]")
  })

  test("subtrees deeper than 2 collapse to a ... line", () => {
    const by = new Map<string, EnrichedRecord[]>()
    const chain = ["ses_0", "ses_1", "ses_2", "ses_3"] as const
    by.set("ses_0", [subagentRow("ses_1", "a", "one", "2026-10-05T10:00:00.000Z")])
    // fix parent tag on the spawn row (helper defaults to ses_parent)
    ;(by.get("ses_0")![0] as Record<string, unknown>).sessionID = "ses_0"
    by.set("ses_1", [rec({ kind: "tool-call", tool: "subagent", args: JSON.stringify({ agent: "a", sessionID: "ses_2", description: "two" }), timestamp: "2026-10-05T10:01:00.000Z", outcome: "completed", sessionID: "ses_1" })])
    by.set("ses_2", [rec({ kind: "tool-call", tool: "subagent", args: JSON.stringify({ agent: "a", sessionID: "ses_3", description: "three" }), timestamp: "2026-10-05T10:02:00.000Z", outcome: "completed", sessionID: "ses_2" })])
    by.set("ses_3", [rec({ command: "echo deep", outcome: "success", taskRef: "deep", sessionID: "ses_3" })])
    const root = buildTree("ses_0", by)
    expect(root.children[0].children[0].children[0].sessionID).toBe("ses_3")
    const text = formatTree(root, by)
    expect(text).toContain("...")
    expect(text).not.toContain("echo deep")
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

describe("retired session verbs refuse loud (exit 2 with the usage list, never silent)", () => {
  test("stuck/timeline/export print usage and write nothing", async () => {
    const out: string[] = []
    const err: string[] = []
    const savedLog = console.log
    const savedError = console.error
    console.log = (...args: unknown[]): void => {
      out.push(args.map(String).join(" "))
    }
    console.error = (...args: unknown[]): void => {
      err.push(args.map(String).join(" "))
    }
    try {
      for (const argv of [["stuck"], ["timeline"], ["export", "--bundle"]]) {
        expect(await run(argv)).toBe(2)
      }
    } finally {
      console.log = savedLog
      console.error = savedError
    }
    expect(`${out.join("\n")}\n${err.join("\n")}`).toContain("usage: ow <command>")
  })
})
