import {
  DEFAULT_DB_PATH,
  DEFAULT_LOG_PATH,
  filterSince,
  filterTools,
  formatGrouped,
  formatMeta,
  formatReads,
  formatSessions,
  groupByTask,
  joinSession,
  latestSession,
  listSessions,
  logCoverage,
  parseBytes,
  parseSince,
  readDigest,
  readLogBounds,
  sessionMeta,
  showLine,
  timedSummary,
  SINCE_TOKENS,
  sinceWindow,
  storeWindow,
  windowNotice,
  type EnrichedRecord,
  type SinceWindow,
} from "./join"
import { doctor, formatDoctor, formatIdentity, doctorIdentity } from "./doctor"
import { findLast, formatLast, readLog } from "./last"
import { buildTree, formatTree, loadTreeRecords, treeIds } from "./tree"

export const COMMANDS = ["doctor", "sessions", "show", "meta", "reads", "last", "version"] as const
export type Command = (typeof COMMANDS)[number]

/** The three `--since` readers (single source for help + the fail-loud
 * cross-verb guard below; the help-coverage test derives from this). */
export const SINCE_READERS = ["sessions", "show", "reads", "last"] as const
const ALIASES: Record<string, Command> = { list: "sessions" }

const VALUE_FLAGS = new Set(["--db", "--log", "--since", "--dir", "--kind", "--tool", "--show", "--bytes", "-n"])
const BOOL_FLAGS = new Set(["--failed", "--json", "--full", "--tree", "--flat", "--show-fails", "--help", "-h", "--version"])

export type ParsedArgs = {
  command: Command | null
  sessionID: string | undefined
  /** Every value flag holds a single string. */
  flags: Record<string, string | boolean | string[]>
  error: string | null
  /** No command takes a second positional: any extra is a usage error. */
  extra: string[]
}

export const helpText = (): string =>
  [
    "ow — shell-observer CLI (read-only, non-interactive)",
    "",
    "usage: ow <command> [session] [options]",
    "",
    "commands:",
    "  doctor                        health: log/hook/ring/db",
    "  sessions [--since] [--dir]    session list (id, count, range, dir)",
    "  show [session] [--since] [--full] [--bytes] [--tree] [--kind ..] [--tool ..] [--show N] [--show-fails]",
    "                                task summary; --tree shows the subtask tree",
    "  meta [session]                cost/token/changes/turns",
    "  reads [session] [--since]     read summary",
    "  last <pattern> [-n K] [--failed] [--since] [--dir]",
    "                                latest successful command matching <pattern> (re-runnable)",
    "  version [--json]  installed build identity: version + sidecar sha/time (read-only)",
    "",
    "general: --db <path> --log <path> --json --help --version",
    `  --since  window: ${SINCE_TOKENS} (${SINCE_READERS.join("/")})`,
    "  --json  machine output (English keys): doctor/show/meta/sessions/reads/version",
    "exit: 0 ok, 1 structural error, 2 usage error",
    "",
    "example: ow show <session> --tree --since 1d",
  ].join("\n")

/** Per-verb help bodies for `ow <command> --help` / `ow help <command>`.
 * Usage lines are NOT duplicated here: `verbHelpText` derives them from
 * `helpText()` (single source). Each entry adds only flags, exits and one
 * example. Keys cover every COMMANDS entry;
 * the help-coverage test derives from COMMANDS. */
export const VERB_HELP: Record<string, string[]> = {
  doctor: [
    "checks: shell log growth, hook firing, ring buffer, intent DB",
    "flags: --db <path>  intent DB (default OpenCode store)",
    "       --log <path>  shell log (default opencode-shell-log)",
    "exits: 0 ok, 1 failing check, 2 usage",
    "example: ow doctor --json",
  ],
  sessions: [
    "flags: --since 30m|3h|1d|1w, --dir <path>, --json; alias: ow list",
    "exits: 0 ok, 1 unreadable store, 2 usage",
    "example: ow sessions --since 1d --json",
  ],
  show: [
    "flags: --since, --full, --bytes 512|1k|4k|1m, --tree (subagent tree), --flat, --kind/--tool <v>,",
    "       --show <line>, --show-fails, --json",
    "exits: 0 ok, 1 structural, 2 usage",
    "example: ow show <session> --tree --since 1d",
  ],
  meta: ["flags: --json", "exits: 0 ok, 1 no account for the session, 2 usage"],
  reads: ["flags: --since, --json", "exits: 0 ok, 1 structural, 2 usage"],
  last: [
    "prints cwd + the recorded command (secret values masked, names kept) for the newest exit-0 shell",
    "command whose text contains <pattern> (case-insensitive substring); identical command+cwd pairs collapse",
    "flags: -n <K> newest distinct matches (default 1), --failed (non-zero exits instead; adds exit code),",
    "       --since 30m|3h|1d|1w, --dir <path> (cwd prefix), --log <path>",
    "exits: 0 match, 1 no match / unreadable log, 2 usage",
    "example: ow last 'docker compose' -n 3",
  ],
  version: [
    "flags: --json",
    "prints the sidecar identity of the running binary (version + sha8/time/dirty); no sidecar -> rebuild hint",
  ],
}

/** Usage lines derived from `helpText()` for one key (continuation lines are
 * the 32-space-indented follow-ups of the global list). */
export const usageLinesFor = (key: string): string[] => {
  const lines = helpText().split("\n")
  const out: string[] = []
  let collecting = false
  for (const line of lines) {
    if (line.startsWith(" ".repeat(32))) {
      if (collecting) out.push(line.trim())
      continue
    }
    collecting = line.trim() === key || line.trim().startsWith(`${key} `)
    if (collecting) out.push(line.trim())
  }
  return out
}

/** `ow <command> [subverb] --help`: verb-scoped usage + flags + exits (the
 * full command list stays reachable via `ow --help`). */
export const verbHelpText = (command: string, sub?: string): string => {
  const key = sub !== undefined && VERB_HELP[`${command} ${sub}`] !== undefined ? `${command} ${sub}` : command
  const usage = usageLinesFor(key)
  const detail = VERB_HELP[key] ?? ["no per-verb help yet — run `ow --help` for the full command list"]
  const head = usage.length > 0 ? [`usage: ow ${usage[0]}`, ...usage.slice(1).map((line) => `       ${line}`)] : []
  return [`ow ${key}`, ...head, "", ...detail, "", "run `ow --help` for the full command list (all verbs, global flags, exits)"].join("\n")
}

/** `ow version` / `ow --version`: installed build identity. The version
 * string comes from the build sidecar (written by `pnpm ow:build` from
 * package.json), never hardcoded here; a missing sidecar reads as an honest
 * rebuild hint instead of a guessed number. */
export const versionIdentity = async (): Promise<{ line: string; payload: Record<string, unknown> }> => {
  const { readOwnBuildSidecar } = await import("./build-info")
  const sidecar = await readOwnBuildSidecar()
  if (sidecar === null) {
    return {
      line: "ow (no build sidecar — rebuild with pnpm ow:build)",
      payload: { version: null, sha: null, time: null, dirty: null, sidecar: false },
    }
  }
  const version = sidecar.version ?? "unknown"
  return {
    line: `ow ${version} (build ${sidecar.sha.slice(0, 8)}, ${sidecar.time}${sidecar.dirty === true ? ", dirty" : ""})`,
    payload: {
      version: sidecar.version ?? null,
      sha: sidecar.sha.slice(0, 8),
      time: sidecar.time,
      dirty: sidecar.dirty ?? null,
      sidecar: true,
    },
  }
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean | string[]> = {}
  let command: Command | null = null
  let sessionID: string | undefined
  const extra: string[] = []
  const fail = (error: string): ParsedArgs => ({ command, sessionID, flags, error, extra })
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      flags["--help"] = true
      continue
    }
    if (arg.startsWith("--") || arg === "-n") {
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("--")) return fail(`value expected: ${arg}`)
        flags[arg] = value
        i += 1
        continue
      }
      if (BOOL_FLAGS.has(arg)) {
        flags[arg] = true
        continue
      }
      return fail(`unknown option: ${arg}`)
    }
    if (!command && (COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command
      continue
    }
    if (!command && ALIASES[arg]) {
      command = ALIASES[arg]
      continue
    }
    if (command && sessionID === undefined) {
      sessionID = arg
      continue
    }
    // No command takes a second positional: any extra is a usage error
    // (same pre-existing text), never a silent no-op.
    return fail(`unexpected argument: ${arg}`)
  }
  if (flags["--help"]) return { command, sessionID, flags, error: null, extra }
  if (!command) return fail("command expected: doctor|sessions|show|meta|reads|last|version (--help)")
  const since = typeof flags["--since"] === "string" ? parseSince(flags["--since"]) : undefined
  if (typeof flags["--since"] === "string" && since === null) return fail(`invalid --since: ${flags["--since"]} (${SINCE_TOKENS})`)
  const bytes = typeof flags["--bytes"] === "string" ? parseBytes(flags["--bytes"]) : undefined
  if (typeof flags["--bytes"] === "string" && bytes === null) return fail(`invalid --bytes: ${flags["--bytes"]} (512|1k|4k|1m)`)
  if (typeof flags["--show"] === "string" && !Number.isFinite(Number(flags["--show"]))) {
    return fail(`invalid --show: ${flags["--show"]} (line number expected)`)
  }
  return { command, sessionID, flags, error: null, extra }
}

// --json envelopes: stable English keys; human views keep plain English labels.
// `window` is the additive `--since` envelope ({since, cutoff} or null).
// `coverage` is the additive store-coverage object ({firstTimestamp, lastTimestamp, pruned} or null).
export const toSessionsJson = (
  sessions: Awaited<ReturnType<typeof listSessions>>,
  window: SinceWindow | null = null,
  coverage: ReturnType<typeof logCoverage> = null,
  warnings: string[] = [],
) => ({ sessions, window, coverage, warnings })
export const toShowJson = (
  sessionID: string,
  warnings: string[],
  groups: ReturnType<typeof groupByTask>,
  tree?: ReturnType<typeof treeIds>,
  window: SinceWindow | null = null,
) => (tree ? { session: sessionID, warnings, groups, tree, window } : { session: sessionID, warnings, groups, window })

/** `doctor` exit rule: every failing check fails (observer health only). */
export const doctorFails = (lines: { name: string; ok: boolean }[]): boolean =>
  lines.some((l) => !l.ok)

const flag = (flags: Record<string, string | boolean | string[]>, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined

const resolveSession = async (
  positional: string | undefined,
  logPath: string,
): Promise<string | null> => positional ?? (await latestSession(logPath))

export const run = async (argv: string[]): Promise<number> => {
  // `ow help [command]` is the same request as `ow [command] --help`.
  if (argv[0] === "help") argv = [...argv.slice(1), "--help"]
  const parsed = parseArgs(argv)
  if (parsed.flags["--version"] === true) {
    const identity = await versionIdentity()
    if (parsed.flags["--json"] === true) console.log(JSON.stringify(identity.payload))
    else console.log(identity.line)
    return 0
  }
  if (parsed.flags["--help"] || parsed.command === null) {
    if (parsed.command !== null) {
      console.log(verbHelpText(parsed.command, parsed.sessionID))
      return 0
    }
    console.log(helpText())
    return parsed.flags["--help"] ? 0 : 2
  }
  if (parsed.error) {
    console.error(`ow: ${parsed.error}`)
    console.error(helpText())
    return 2
  }
  const { command, sessionID: positional, flags } = parsed
  // No command takes a second positional: any extra is a usage error
  // (exit 2), never a silent no-op.
  // `--since` outside the readers refuses (exit 2), never a silent
  // no-op on any command (single source: SINCE_READERS drives this guard
  // and the help line above).
  if (flags["--since"] !== undefined && !(SINCE_READERS as readonly string[]).includes(command)) {
    console.error(`ow: --since can only be used with ${SINCE_READERS.join(", ")}`)
    return 2
  }
  if (parsed.extra.length > 0) {
    console.error(`ow: unexpected argument: ${parsed.extra[0]}`)
    console.error(helpText())
    return 2
  }
  const dbPath = flag(flags, "--db") ?? DEFAULT_DB_PATH
  const logPath = flag(flags, "--log") ?? DEFAULT_LOG_PATH
  const json = flags["--json"] === true
  // Warnings stay on stderr in every mode (stdout stays parse-clean for
  // --json); suppressing them in JSON mode hid unreadable-store facts.
  const warn = (message: string): void => {
    console.error(message)
  }
  const warnPruned = (firstTimestamp: string): void => warn(`log starts at ${firstTimestamp}; older records were pruned by the ring cap`)

  if (command === "doctor") {
    for (const key of Object.keys(flags)) {
      if (!["--json", "--db", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with doctor`)
        return 2
      }
    }
    const lines = await doctor({ logPath, dbPath })
    const identity = await doctorIdentity()
    if (json) {
      console.log(JSON.stringify({ checks: lines, identity }))
    } else {
      console.log(formatDoctor(lines))
      for (const line of formatIdentity(identity)) console.log(line)
    }
    return doctorFails(lines) ? 1 : 0
  }

  if (command === "version") {
    for (const key of Object.keys(flags)) {
      if (!["--json", "--help"].includes(key)) {
        console.error(`ow: ${key} cannot be used with version`)
        return 2
      }
    }
    const identity = await versionIdentity()
    if (json) console.log(JSON.stringify(identity.payload))
    else console.log(identity.line)
    return 0
  }

  if (command === "sessions") {
    for (const key of Object.keys(flags)) {
      if (!["--since", "--dir", "--json", "--db", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with sessions`)
        return 2
      }
    }
    const sinceRaw = flag(flags, "--since")
    const sinceMs = parseSince(sinceRaw)
    const window = sinceWindow(sinceRaw, sinceMs, Date.now())
    if (window !== null) warn(windowNotice(window))
    const coverage = logCoverage(await readLogBounds(logPath), sinceMs, Date.now())
    if (coverage?.pruned) warnPruned(coverage.firstTimestamp)
    const sessionWarnings: string[] = []
    const sessions = await listSessions({
      logPath,
      dbPath: flag(flags, "--db"),
      sinceMs,
      dir: flag(flags, "--dir"),
      warnings: sessionWarnings,
    })
    for (const message of sessionWarnings) warn(`warn: ${message}`)
    if (json) {
      console.log(JSON.stringify(toSessionsJson(sessions, window, coverage, sessionWarnings)))
    } else if (sessions.length > 0) {
      console.log(formatSessions(sessions))
    } else if (sessionWarnings.length === 0) {
      console.log("no sessions")
    }
    return sessionWarnings.length > 0 ? 1 : 0
  }

  if (command === "last") {
    for (const key of Object.keys(flags)) {
      if (!["-n", "--failed", "--since", "--dir", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with last`)
        return 2
      }
    }
    if (positional === undefined || positional.length === 0) {
      console.error("ow: last needs a <pattern> (usage: ow last <pattern> [-n K] [--failed])")
      return 2
    }
    const countRaw = flag(flags, "-n") ?? "1"
    const count = Number(countRaw)
    if (!/^\d+$/.test(countRaw) || count < 1) {
      console.error(`ow: invalid -n: ${countRaw} (positive integer expected)`)
      return 2
    }
    const text = await readLog(logPath)
    if (text === null) {
      console.error(`ow: shell log unreadable (store: ${logPath})`)
      return 1
    }
    const failed = flags["--failed"] === true
    const sinceRaw = flag(flags, "--since")
    const sinceMs = parseSince(sinceRaw)
    const window = sinceWindow(sinceRaw, sinceMs, Date.now())
    if (window !== null) warn(windowNotice(window))
    const matches = findLast(text, { pattern: positional, count, failed, sinceMs, dir: flag(flags, "--dir") })
    if (matches.length === 0) {
      console.error(`ow: no ${failed ? "failing" : "successful"} command matching "${positional}" ${storeWindow(logPath, window)}`)
      return 1
    }
    console.log(formatLast(matches, failed))
    return 0
  }

  const sid = await resolveSession(positional, logPath)
  if (!sid) {
    console.error("session not found")
    return 2
  }

  if (command === "meta") {
    for (const key of Object.keys(flags)) {
      if (!["--json", "--db", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with meta`)
        return 2
      }
    }
    const result = await sessionMeta({ dbPath, sessionID: sid })
    if (result.warning) warn(`warn: ${result.warning}`)
    if (!result.meta) return 1
    console.log(json ? JSON.stringify({ meta: result.meta, warning: result.warning }) : formatMeta(result.meta))
    return 0
  }

  if (command === "reads") {
    for (const key of Object.keys(flags)) {
      if (!["--since", "--json", "--db", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with reads`)
        return 2
      }
    }
  }

  if (command === "show") {
    for (const key of Object.keys(flags)) {
      if (!["--since", "--full", "--bytes", "--tree", "--flat", "--kind", "--tool", "--show", "--show-fails", "--json", "--db", "--log"].includes(key)) {
        console.error(`ow: ${key} cannot be used with show`)
        return 2
      }
    }
  }

  const treeMode = flags["--tree"] === true
  const windowMs = parseSince(flag(flags, "--since"))
  // One per-verb cutoff notice for the joined readers (human only via
  // warn; show/reads share this region).
  const window = sinceWindow(flag(flags, "--since"), windowMs, Date.now())
  if (window !== null) warn(windowNotice(window))
  if (windowMs !== null) {
    const coverage = logCoverage(await readLogBounds(logPath), windowMs, Date.now())
    if (coverage?.pruned) warnPruned(coverage.firstTimestamp)
  }

  // show + reads share the joined records
  let by: Map<string, EnrichedRecord[]>
  let warnings: string[]
  let logUnreadable = false
  if (treeMode) {
    const { by: loaded, warnings: treeWarnings, childCount } = await loadTreeRecords({ dbPath: flag(flags, "--db"), logPath, sessionID: sid, sinceMs: windowMs })
    if (childCount > 0) warn(`tree: ${childCount + 1} sessions (${childCount} children)`)
    by = loaded
    warnings = treeWarnings
  } else {
    const r = await joinSession({ sessionID: sid, dbPath: flag(flags, "--db"), logPath, sinceMs: windowMs })
    by = new Map([[sid, r.records]])
    warnings = r.warnings
    logUnreadable = r.logUnreadable
  }
  for (const w of warnings) warn(`warn: ${w}`)
  const kind = flag(flags, "--kind")
  const tool = flag(flags, "--tool")
  const filtered = new Map<string, EnrichedRecord[]>()
  for (const [id, recs] of by) filtered.set(id, filterTools(filterSince(recs, windowMs), kind, tool))
  const merged = [...filtered.values()].flat()

  if (command === "reads") {
    const stats = readDigest(merged)
    if (json) {
      console.log(JSON.stringify({ session: sid, reads: stats, window, warnings }))
    } else {
      const text = formatReads(stats)
      if (text.length > 0) console.log(text)
      else if (warnings.length === 0) console.log("no read records")
    }
    return logUnreadable ? 1 : 0
  }

  // show
  const full = flags["--full"] === true
  const sectionBudget = parseBytes(flag(flags, "--bytes")) ?? undefined
  const showRef = flag(flags, "--show")
  const showFails = flags["--show-fails"] === true
  const flat = flags["--flat"] === true
  const groups = groupByTask(merged)

  if (showRef) {
    const text = showLine(groups, Number(showRef), sectionBudget)
    console.log(json ? JSON.stringify({ session: sid, detail: text }) : text)
    return 0
  }
  if (showFails) {
    const out: string[] = []
    for (const group of groups) {
      for (const line of group.lines) {
        if (line.outcome !== "failure" && line.outcome !== "error") continue
        out.push(showLine([group], line.ref, sectionBudget))
      }
    }
    if (out.length > 0) {
      const text = out.join("\n")
      console.log(json ? JSON.stringify({ session: sid, detail: text }) : text)
    } else {
      warn("no failed lines")
    }
    return 0
  }
  if (flat) {
    for (const record of merged) console.log(JSON.stringify(record))
    return 0
  }
  if (treeMode) {
    if (json) {
      console.log(JSON.stringify(toShowJson(sid, warnings, groups, treeIds(buildTree(sid, filtered)), window)))
    } else {
      const text = formatTree(buildTree(sid, filtered), filtered, { full, sectionBudget })
      // Honest empty (grouped/tree only — --flat streams records, never a line).
      if (text.length > 0) console.log(text)
      else console.log(`no records ${storeWindow(logPath, window)}`)
      if (full) warn(`(full text: ${text.length} chars)`)
    }
    return 0
  }
  const text = formatGrouped(groups, full, false, sectionBudget)
  if (json) {
    console.log(JSON.stringify(toShowJson(sid, warnings, groups, undefined, window)))
  } else {
    const timings = timedSummary(groups)
    if (timings !== null) console.log(timings)
    if (text.length > 0) console.log(text)
    else console.log(`no records ${storeWindow(logPath, window)}`)
    if (full) warn(`(full text: ${text.length} chars)`)
  }
  return 0
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
