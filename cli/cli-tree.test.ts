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
    for (const word of ["doctor", "sessions", "show", "meta", "reads", "up", "down", "ps", "logs", "--json", "--help", "--rm", "--check", "--detach"]) {
      expect(text).toContain(word)
    }
    expect(text).toContain("0 ok, 1 structural error, 2 usage error")
    expect(text).toContain("30m|3h|1d|1w")
    expect(text).toContain("show/meta/sessions/reads")
    expect(text).toContain("up <name> [--wait 120s] [--health <name>=<path>]")
    expect(text).toContain("restart <service> [--file] [--wait 120s] [--health <name>=<path>]")
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
      ["ps", "--since", "1d"],
      ["doctor", "--since", "1d"],
      ["meta", "ses_x", "--since", "1d"],
    ]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
      expect(io.err.join("\n")).toContain("ow: --since can only be used with sessions, show, reads, logs")
    }
  })

  test("the guard + help derive from SINCE_READERS (four readers, shared tokens)", () => {
    expect([...SINCE_READERS]).toEqual(["sessions", "show", "reads", "logs"])
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
    // run()-level over the committed sidecar fixture (failures/trace pin
    // theirs in their own suites; logs pins its main path below — the
    // no-state early-empty envelope carries no window).
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
    // Logs main path carries window (null unwindowed here).
    const dir = await mkdtemp(join(tmpdir(), "window-universal-"))
    try {
      const file = join(dir, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(dir, ".ow", "logs"), { recursive: true })
      await writeFile(join(dir, ".ow", "logs", "a.jsonl"), `${JSON.stringify({ t: "2026-10-05T11:00:00.000Z", stream: "stdout", line: "hi" })}\n`, "utf8")
      const logged = await runJson(["logs", "a", "--json", "--file", file])
      expect(logged.code).toBe(0)
      expect(logged.payload).toHaveProperty("window")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removed overlay/scenario flags fail loud as unknown options (exit 2, never silent)", async () => {
    for (const argv of [
      ["ps", "--boundaries", "x.yaml"],
      ["up", "--check", "--boundaries", "x.yaml"],
      ["ps", "--run", "x"],
      ["up", "--check", "--off-local"],
      ["ps", "--resume"],
      ["ps", "--claim-entrypoint", "x"],
      ["ps", "--trace", "abc123"],
      ["logs", "--trace", "abc123"],
      ["ps", "--min-spans", "2"],
      ["init", "--tracing"],
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
    for (const argv of [["trace"], ["trace", "abc123"], ["checkpoints"], ["failures"], ["scenarios", "--check"], ["preflight"], ["readiness"], ["provision", "--check"], ["prompts"], ["prompts", "ses_x"], ["stuck"], ["stuck", "ses_x"], ["timeline"], ["timeline", "ses_x"], ["export"], ["export", "--bundle"]]) {
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

describe("writer state-dir announce + nested warning", () => {
  const capture = (): { out: string[]; err: string[]; restore: () => void } => {
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
    return { out, err, restore: () => {
      console.log = savedLog
      console.error = savedError
    } }
  }

  test("writers announce the state dir on stderr (readers stay silent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "state-announce-"))
    try {
      const file = join(dir, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      const io = capture()
      try {
        expect(await run(["down", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain(`state dir: ${join(dir, ".ow")}`)
      const io2 = capture()
      try {
        expect(await run(["ps", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).not.toContain("state dir:")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--json keeps stdout parse-clean (announce rides stderr)", async () => {
    const { ensureUpStateDir, upPaths, writeSupervisorState } = await import("./up-state")
    const dir = await mkdtemp(join(tmpdir(), "state-announce-"))
    try {
      const file = join(dir, "ow.yaml")
      await writeFile(file, "services:\n  ghost:\n    cmd: echo hi\n", "utf8")
      const paths = upPaths(dir)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [{ name: "ghost", pid: 987654321, lstart: "bogus", startedAt: "2026-10-07T00:00:00.000Z" }],
      })
      const io = capture()
      try {
        expect(await run(["down", "--json", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(() => JSON.parse(io.out.join("\n"))).not.toThrow()
      // Suppressed under --json: stdout stays parse-clean, stderr clean too.
      expect(io.err.join("\n")).not.toContain("state dir:")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("nested state dir warns (ancestor workspace)", async () => {
    const { ensureUpStateDir, upPaths } = await import("./up-state")
    const parent = await mkdtemp(join(tmpdir(), "state-nested-"))
    try {
      await ensureUpStateDir(upPaths(parent).stateDir)
      const child = join(parent, "child")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(child, { recursive: true })
      const file = join(child, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      const io = capture()
      try {
        expect(await run(["down", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      const err = io.err.join("\n")
      expect(err).toContain("nested state dir:")
      expect(err).toContain("writers stay put")
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("cli --json shapes", () => {
  test("sessions envelope keeps stable English keys", () => {
    const payload = toSessionsJson([
      { sessionID: "s1", commands: 2, fileEdits: 1, fails: 0, first: "a", last: "b", workdir: "/w" },
    ])
    expect(Object.keys(payload)).toEqual(["sessions", "window"])
    expect(payload.window).toBeNull()
    expect(Object.keys(payload.sessions[0]).sort()).toEqual(
      ["commands", "fails", "fileEdits", "first", "last", "sessionID", "workdir"].sort(),
    )
    expect(() => JSON.stringify(payload)).not.toThrow()
  })

  test("show envelope carries session, warnings, groups and status", () => {
    const groups = groupByTask([rec({ command: "echo hi", outcome: "success", taskRef: "t" })])
    const payload = toShowJson("ses_p", ["w1"], groups)
    expect(Object.keys(payload).sort()).toEqual(["groups", "session", "status", "warnings", "window"].sort())
    expect(payload.session).toBe("ses_p")
    expect(payload.window).toBeNull()
    expect(payload.status).toBeNull()
    const withStatus = toShowJson("ses_p", [], groups, undefined, null, {
      outcome: "failed",
      at: "2026-10-01T11:00:00.000Z",
      scope: "latest-observed",
      source: "session_v2.idle_outcome+time_idle",
    })
    expect(withStatus.status).toMatchObject({ outcome: "failed", scope: "latest-observed" })
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

describe("removed scenario-run flags fail loud as unknown options", () => {
  test("--run on ps exits 2 (never silent)", async () => {
    expect(await run(["ps", "--run", "x"])).toBe(2)
  })
  test("--off-local on up exits 2 (never silent)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-low2-"))
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      expect(await run(["up", "--check", "--file", file, "--off-local"])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

describe("refusal echoes mask secret shapes (mask-before-cap)", () => {
  test("invalid flag values echo masked, benign values verbatim", async () => {
    const { parseArgs } = await import("./cli")
    expect(parseArgs(["show", "--show", "token=hunter2"]).error ?? "").not.toContain("hunter2")
    expect(parseArgs(["show", "--show", "token=hunter2"]).error ?? "").toContain("token=***")
    expect(parseArgs(["show", "--show", "bogus"]).error).toContain("invalid --show: bogus")
    expect(parseArgs(["show", "--bogus", "token=hunter2"]).error ?? "").not.toContain("hunter2")
  })
})
