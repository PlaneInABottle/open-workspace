import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { signature } from "./signature"
import { capText, maskSecrets } from "./up-evidence"

export const DEFAULT_LOG_PATH = join(homedir(), ".local", "share", "opencode-shell-log", "shell-events.jsonl")
export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
export const MAX_MESSAGE_ROWS = 2_000
export const MAX_TEXT_CHARS = 500

type Dict = Record<string, unknown>

export type SidecarRecord = Dict & { sessionID?: unknown; messageID?: unknown }
export type EnrichedRecord = SidecarRecord & { intent: string | null; taskRef: string | null; model: { id: string; provider: string } | null }

const modelOf = (data: Dict): { id: string; provider: string } | null => {
  const model = asDict(data.model)
  if (model && typeof model.id === "string") {
    return { id: model.id, provider: typeof model.providerID === "string" ? model.providerID : "?" }
  }
  return null
}

const asDict = (value: unknown): Dict | undefined =>
  typeof value === "object" && value !== null ? (value as Dict) : undefined

const clip = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) return null
  const single = value.replace(/\s+/g, " ").trim()
  return single.length > MAX_TEXT_CHARS ? single.slice(0, MAX_TEXT_CHARS) : single
}

const textParts = (data: Dict): string[] => {
  const content = data.content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    const text = asDict(part)?.text
    const clipped = clip(text)
    if (clipped) out.push(clipped)
  }
  return out
}

/** Nearest preceding user-row text (the task the command serves). */
const precedingUserText = (rows: { type: string; data: Dict }[], index: number): string | null => {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i].type !== "user") continue
    const direct = clip(rows[i].data.text)
    if (direct) return direct
    return textParts(rows[i].data)[0] ?? null
  }
  return null
}

export type MessageRow = { id: string; type: string; data: Dict; seq: number }

export const attachIntent = (
  sidecar: SidecarRecord,
  rows: MessageRow[],
): EnrichedRecord => {
  const base = sidecar as EnrichedRecord
  const messageID = typeof sidecar.messageID === "string" ? sidecar.messageID : null
  if (!messageID) return { ...base, intent: null, taskRef: null, model: null }
  const index = rows.findIndex((row) => row.id === messageID)
  if (index < 0) return { ...base, intent: null, taskRef: null, model: null }
  const sameRow = textParts(rows[index].data)[0] ?? null
  const taskRef = precedingUserText(rows, index)
  return { ...base, intent: sameRow ?? taskRef, taskRef, model: modelOf(rows[index].data) }
}

export const loadSessionMessages = (
  db: Database,
  sessionID: string,
  sinceMs?: number | null,
  now = Date.now(),
): MessageRow[] | null => {
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'").all()
    if (tables.length === 0) return null
    const where = sinceMs ? "WHERE session_id = ? AND time_created >= ?" : "WHERE session_id = ?"
    const args = sinceMs ? [sessionID, now - sinceMs] : [sessionID]
    // Newest-first with cap, then reverse to ascending: a head-cap would
    // silently drop the newest rows once the table outgrows the cap.
    const rawDesc = db
      .query(`SELECT id, type, data, seq FROM session_message ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...args, MAX_MESSAGE_ROWS) as { id: unknown; type: unknown; data: unknown; seq: unknown }[]
    const raw = [...rawDesc].reverse()
    return raw.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.data !== "string" || typeof row.seq !== "number") return []
      try {
        const data = JSON.parse(row.data) as unknown
        const dict = asDict(data)
        if (!dict) return []
        return [{ id: row.id, type: row.type, data: dict, seq: row.seq }]
      } catch {
        return []
      }
    })
  } catch {
    return null
  }
}

/** Rows for explicit message ids (the join's pinned references), chunked so
 * a large window stays within the SQLite variable limit. Seq-tagged for
 * merge; never throws (empty on any failure). */
export const loadMessagesByIds = (db: Database, sessionID: string, ids: string[]): MessageRow[] => {
  const distinct = [...new Set(ids.filter((id) => id.length > 0))]
  if (distinct.length === 0) return []
  const out: MessageRow[] = []
  try {
    for (let i = 0; i < distinct.length; i += 400) {
      const batch = distinct.slice(i, i + 400)
      const placeholders = batch.map(() => "?").join(",")
      const rows = db
        .query(`SELECT id, type, data, seq FROM session_message WHERE session_id = ? AND id IN (${placeholders})`)
        .all(sessionID, ...batch) as { id: unknown; type: unknown; data: unknown; seq: unknown }[]
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.data !== "string" || typeof row.seq !== "number") continue
        try {
          const dict = asDict(JSON.parse(row.data) as unknown)
          if (!dict) continue
          out.push({ id: row.id, type: row.type, data: dict, seq: row.seq })
        } catch {
          continue
        }
      }
    }
  } catch {
    // pinned rows are best-effort; the window still renders without them
  }
  return out
}

/** Newest user rows regardless of window: task context (preceding-user
 * lookup) is usually older than a narrow record window. Bounded, seq-tagged
 * for merge, never throws. */
export const loadRecentUserMessages = (db: Database, sessionID: string, limit = 500): MessageRow[] => {
  try {
    const rows = db
      .query("SELECT id, type, data, seq FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT ?")
      .all(sessionID, limit) as { id: unknown; type: unknown; data: unknown; seq: unknown }[]
    return rows.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.data !== "string" || typeof row.seq !== "number") return []
      try {
        const dict = asDict(JSON.parse(row.data) as unknown)
        if (!dict) return []
        return [{ id: row.id, type: row.type, data: dict, seq: row.seq }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** Merge seq-tagged row lists: dedup by id, ascending seq so index-based
 * intent lookup keeps working. */
export const mergeMessageRows = (...lists: MessageRow[][]): MessageRow[] => {
  const byId = new Map<string, MessageRow>()
  for (const list of lists) for (const row of list) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export const joinSession = async (options: {
  dbPath?: string
  logPath?: string
  sessionID: string
  sinceMs?: number | null
  now?: number
}): Promise<{ records: EnrichedRecord[]; warnings: string[] }> => {
  const warnings: string[] = []
  const logPath = options.logPath ?? DEFAULT_LOG_PATH
  let sidecar: SidecarRecord[] = []
  try {
    const text = await readFile(logPath, "utf8")
    sidecar = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        // Parse-cost prefilter only: JSON.parse runs solely on lines
        // carrying the `"sessionID"` key substring. The log is
        // interleaved append-only across sessions, so a positional tail
        // bound would drop file-head records of old sessions — instead
        // the FULL file is still read (completeness byte-identical) and
        // only the parse calls are skipped. The exact-match filter below
        // is unchanged, so id-as-substring rows (our id inside another
        // field's value, or a foreign id) still parse-then-reject exactly
        // as before; keyless/corrupt lines contributed nothing and skip.
        if (!line.includes('"sessionID"')) return []
        try {
          const parsed = JSON.parse(line) as unknown
          const dict = asDict(parsed)
          return dict && dict.sessionID === options.sessionID ? [dict] : []
        } catch {
          return []
        }
      })
  } catch (error) {
    warnings.push(`sidecar unreadable: ${maskSecrets(String(error)).slice(0, 160)}`)
  }
  let rows: MessageRow[] | null = null
  try {
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const sinceMs = options.sinceMs ?? null
      rows = loadSessionMessages(db, options.sessionID, sinceMs, options.now ?? Date.now())
      // Narrow windows drop the messages a record's intent points at (intent
      // time vs execution time differ by hours on long sessions). Pin the
      // referenced rows plus recent user context so the join survives any
      // window; merge stays seq-ordered for index-based lookup.
      if (rows && sinceMs !== null) {
        const referenced = sidecar.map((record) => record.messageID).filter((id): id is string => typeof id === "string")
        rows = mergeMessageRows(rows, loadMessagesByIds(db, options.sessionID, referenced), loadRecentUserMessages(db, options.sessionID))
      }
    } finally {
      db.close()
    }
  } catch (error) {
    warnings.push(`opencode.db unreadable: ${maskSecrets(String(error)).slice(0, 160)}`)
  }
  if (!rows) {
    warnings.push("message table unavailable — records emitted without intent")
    return { records: sidecar.map((record) => ({ ...record, intent: null, taskRef: null })), warnings }
  }
  return { records: sidecar.map((record) => attachIntent(record, rows)), warnings }
}

export type GroupedLine = {
  /** Drill ref: unique positive integer across all groups of one
   * groupByTask result (display order), shared by human and wire output.
   * Ephemeral per query — never a persisted cross-query id. */
  ref: number
  signature: string
  outcome: string
  runs: number
  agents: string[]
  sessions: string[]
  models: string[]
  failReason: string | null
  /** Distinct reasons beyond the first (cap 2 stored; see failReasonCount). */
  failReasons: string[]
  /** Distinct reasons observed across merged records (may exceed stored). */
  failReasonCount: number
  /** Provenance of the reasons; null when no reason was observed. */
  failReasonSource: string | null
  variants: string[]
  /** Wall-clock range across observed runs (sidecar `timestamp`, raw
   * strings); null per side when unparseable/absent. Multi-run human lines
   * render first→last, never one timestamp as all. */
  firstSeen: string | null
  lastSeen: string | null
  /** Per-run wall timestamps, parallel to stored `variants` (same
   * order/length/cap); null per unparseable run. */
  runTimes: (string | null)[]
  /** Per-run process-monotonic durations (sidecar `durationMs`, ms),
   * parallel to stored `variants`; null when the run recorded none. Wall
   * vs monotonic domains are labeled wherever both render. */
  runDurations: (number | null)[]
  excerpts: string[]
  results: string[]
  intents: string[]
  messageIDs: string[]
}

const MAX_STORED_VARIANTS = 50
const MAX_SHOWN_VARIANTS = 3

export type TaskGroup = {
  taskRef: string
  runs: number
  fails: number
  lines: GroupedLine[]
}

const outcomeOf = (record: EnrichedRecord): string => {
  if (record.kind === "permission") return typeof record.effect === "string" ? record.effect : "unknown"
  return typeof record.outcome === "string" ? record.outcome : "unknown"
}

const rawCommandOf = (record: EnrichedRecord): string | null => {
  if (typeof record.command === "string") return record.command
  const obj = typeof record.command === "object" && record.command !== null ? record.command as Dict : null
  const name = obj && typeof obj.command === "string" ? obj.command : null
  if (!name) return null
  const flags = Array.isArray(obj?.flags) ? (obj.flags as unknown[]).filter((f): f is string => typeof f === "string") : []
  return [name, ...flags].join(" ")
}

const stripEnvPrefix = (command: string): string =>
  command.replace(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")

/** Shared `<amount><unit>` core for the duration/size parsers below. Each
 * parser passes its own anchored pattern and unit map, so unit sets never
 * merge: `--since` has no seconds, `--bytes` has no time units, `--wait`
 * keeps its own range rule on top. Matching quirks (trimming, case,
 * optional unit) live in each caller's pattern, exactly as before. */
export const parseAmountUnit = (
  value: string | undefined,
  pattern: RegExp,
  mults: Record<string, number>,
): number | null => {
  if (!value) return null
  const m = value.trim().match(pattern)
  if (!m) return null
  const mult = mults[(m[2] ?? "").toLowerCase()]
  if (mult === undefined) return null
  return Number(m[1]) * mult
}

/** Parse --since windows like 30m, 3h, 2d into milliseconds. */
export const parseSince = (value: string | undefined): number | null =>
  parseAmountUnit(value, /^(\d+)\s*([mhdw])$/i, { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 })

/** Shared `--since` example tokens (single source for help + invalid
 * messages; doc==code greps pin them). The grammar accepts any
 * `<amount>m|h|d|w` — these are the canonical examples, not the limit. */
export const SINCE_TOKENS = "30m|3h|1d|1w"

/** Additive `--since` window envelope: raw flag echo + frozen cutoff ISO.
 * Null when no window was requested (never a vacuous object). */
export type SinceWindow = { since: string; cutoff: string }

/** Freeze a requested window against `now` (injectable for determinism). */
export const sinceWindow = (raw: string | undefined, windowMs: number | null | undefined, now: number): SinceWindow | null => {
  if (raw === undefined || windowMs === null || windowMs === undefined) return null
  return { since: raw, cutoff: new Date(now - windowMs).toISOString() }
}

/** Human-only stderr notice naming the applied window (stdout stays clean). */
export const windowNotice = (window: SinceWindow): string => `window: --since ${window.since} (cutoff ${window.cutoff})`

/** Honest-empty scope chip: names the searched store + the applied window
 * (`all` when unwindowed). Composes with existing suffixes, never replaces. */
export const storeWindow = (store: string, window: SinceWindow | null): string =>
  `(store: ${store}; window: ${window?.since ?? "all"})`

/** Shared chip normalizer for human filter echoes (session/kind/tool):
 * strip ANSI sequences, fold controls/newlines to single-line text, then
 * the existing masker, then cap. Whitespace folding runs before masking so
 * a newline-split secret (`password\nhunter2`) still masks as one value;
 * only separators fold — `= : " '` structure the masker reads is kept, so
 * secret context is never altered. Mask always precedes cap. */
export const chipText = (value: string): string => {
  const noAnsi = value.replace(/\[[0-9;]*[A-Za-z]/g, "")
  const singleLine = noAnsi.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, " ").replace(/\s+/g, " ").trim()
  return capText(maskSecrets(singleLine), 80)
}

/** Honest empty-filter chip for the human `no records` line: names the
 * actually applied session/kind/tool filters (every piece through the
 * shared chipText normalizer — masked-then-capped, single line; the
 * session id is caller text too, matched exactly, never prefix-resolved,
 * so a partial id stays visibly unmatched). Null when no kind/tool
 * filter was provided, so pure-empty and valid-empty-window
 * lines stay byte-identical; JSON is untouched (no new field). */
export const filterChip = (sessionID: string, kind?: string | null, tool?: string | null): string | null => {
  const bits = [`session=${chipText(sessionID)}`]
  if (typeof kind === "string" && kind.length > 0) bits.push(`kind=${chipText(kind)}`)
  if (typeof tool === "string" && tool.length > 0) bits.push(`tool=${chipText(tool)}`)
  if (bits.length < 2) return null
  return `[filters: ${bits.join(", ")}]`
}

export const filterSince = (records: EnrichedRecord[], windowMs: number | null, now = Date.now()): EnrichedRecord[] => {
  if (!windowMs) return [...records].sort((a, b) => timeOf(a) - timeOf(b))
  const cutoff = now - windowMs
  return records.filter((record) => timeOf(record) >= cutoff).sort((a, b) => timeOf(a) - timeOf(b))
}

/** kind: shell (no kind field or command present), file-edit, tool-call. tool: case-insensitive substring over tool name or signature. */
export const filterTools = (records: EnrichedRecord[], kind?: string, toolSub?: string): EnrichedRecord[] => {
  const sub = toolSub?.toLowerCase()
  return records.filter((record) => {
    const k = typeof record.kind === "string" ? record.kind : (typeof record.command === "string" ? "shell" : "unknown")
    if (kind && k !== kind) return false
    if (sub) {
      const tool = typeof record.tool === "string" ? record.tool.toLowerCase() : ""
      const cmd = typeof record.command === "string" ? record.command.toLowerCase() : ""
      if (!tool.includes(sub) && !cmd.includes(sub)) return false
    }
    return true
  })
}

const timeOf = (record: EnrichedRecord): number => {
  const parsed = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "")
  return Number.isFinite(parsed) ? parsed : 0
}

/** Wall-clock instant of one record (sidecar `timestamp`, raw string) or
 * null when absent/unparseable. Raw strings stay byte-faithful; range math
 * parses but never rewrites them. */
const runTimeOf = (record: EnrichedRecord): string | null => {
  if (typeof record.timestamp !== "string") return null
  return Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null
}

/** Process-monotonic duration of one run (sidecar `durationMs`, ms) or null.
 * Monotonic spans pause under OS suspend; never derived from wall stamps. */
const runDurationOf = (record: EnrichedRecord): number | null =>
  typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? record.durationMs : null

const agentOf = (record: EnrichedRecord): string | null =>
  typeof record.agent === "string" && record.agent.length > 0 ? record.agent : null

/** First machine-readable failure reason in a script body: raise X('reason'). */
export const failReason = (command: string): string | null => {
  const scan = command.length > 20_000 ? command.slice(0, 20_000) : command
  const m = scan.match(/raise\s+(?:SystemExit|RuntimeError|AssertionError|ValueError)\(\s*['"]([^'"\n)]{1,80})/)
  return m ? m[1] : null
}

/** Provenance tag for command-text reasons (wire + drill-down). */
export const FAIL_REASON_SOURCE = "command-text"

/** Outcome-gated failure reason: only failure/error records with a command
 * contribute; masked before emit (command text may carry secrets). */
const recordFailReason = (outcome: string, record: EnrichedRecord): string | null => {
  if (outcome !== "failure" && outcome !== "error") return null
  if (typeof record.command !== "string") return null
  const reason = failReason(record.command)
  return reason === null ? null : maskSecrets(reason)
}

/** Latest sessionID from the sidecar tail (newest record wins). */
export const latestSession = async (logPath: string): Promise<string | null> => {
  try {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(logPath, "utf8")
    const lines = text.split("\n").filter((line) => line.trim().length > 0)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as unknown
        const dict = asDict(parsed)
        if (dict && typeof dict.sessionID === "string") return dict.sessionID
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

/** Session inventory from the sidecar: id, command/file-edit counts, time span, workdir. */
export type SessionInfo = {
  sessionID: string
  commands: number
  fileEdits: number
  fails: number
  first: string | null
  last: string | null
  workdir: string | null
}

export const listSessions = async (options: {
  logPath?: string
  dbPath?: string
  sinceMs?: number | null
  dir?: string
  now?: number
}): Promise<SessionInfo[]> => {
  const { readFile } = await import("node:fs/promises")
  const now = options.now ?? Date.now()
  let text: string
  try {
    text = await readFile(options.logPath ?? DEFAULT_LOG_PATH, "utf8")
  } catch {
    return []
  }
  const by = new Map<string, { commands: number; fileEdits: number; fails: number; first: string | null; last: string | null; workdir: string | null }>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: Dict
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const dict = asDict(parsed)
      if (!dict) continue
      record = dict
    } catch {
      continue
    }
    if (typeof record.sessionID !== "string") continue
    const ts = typeof record.timestamp === "string" ? record.timestamp : null
    if (options.sinceMs && (!ts || Date.parse(ts) < now - options.sinceMs)) continue
    if (options.dir && typeof record.workdir === "string" && !record.workdir.startsWith(options.dir)) continue
    if (options.dir && typeof record.workdir !== "string" && record.kind === "file-edit") continue
    const entry = by.get(record.sessionID) ?? { commands: 0, fileEdits: 0, fails: 0, first: null, last: null, workdir: null }
    if (record.kind === "file-edit") entry.fileEdits += 1
    else entry.commands += 1
    if (record.outcome === "failure" || record.outcome === "error") entry.fails += 1
    if (ts && (!entry.first || ts < entry.first)) entry.first = ts
    if (ts && (!entry.last || ts > entry.last)) entry.last = ts
    if (!entry.workdir && typeof record.workdir === "string") entry.workdir = record.workdir
    by.set(record.sessionID, entry)
  }
  // Stored directories fill sidecar gaps (tool-call rows carry no workdir).
  const missing = [...by.entries()].filter(([, info]) => !info.workdir).map(([id]) => id)
  if (missing.length > 0) {
    try {
      const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
      try {
        for (let i = 0; i < missing.length; i += 100) {
          const batch = missing.slice(i, i + 100)
          const placeholders = batch.map(() => "?").join(",")
          const rows = db.query(`SELECT id, directory FROM session_v2 WHERE id IN (${placeholders}) LIMIT 100`).all(...batch) as { id: unknown; directory: unknown }[]
          for (const row of rows) {
            if (typeof row.id !== "string" || typeof row.directory !== "string" || row.directory.length === 0) continue
            const entry = by.get(row.id)
            if (entry && !entry.workdir) entry.workdir = row.directory
          }
        }
      } finally {
        db.close()
      }
    } catch {
      // directories are best-effort; rows render without them
    }
  }
  return [...by.entries()]
    .map(([sessionID, info]) => ({ sessionID, ...info }))
    .filter((entry) => !options.dir || (typeof entry.workdir === "string" && entry.workdir.startsWith(options.dir)))
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))
}

/** Read digest: which files were read most, by whom, which line ranges. */
export type ReadStat = {
  path: string
  reads: number
  agents: string[]
  ranges: string[]
}

export const readDigest = (records: EnrichedRecord[]): ReadStat[] => {
  const by = new Map<string, { reads: number; agents: Set<string>; ranges: Set<string> }>()
  for (const record of records) {
    if (record.kind !== "tool-call" || record.tool !== "read") continue
    let path: string | null = null
    let range: string | null = null
    if (typeof record.args === "string") {
      try {
        const args = JSON.parse(record.args) as unknown
        const dict = asDict(args)
        if (dict && typeof dict.path === "string") {
          path = dict.path
          const offset = typeof dict.offset === "number" ? dict.offset : null
          const limit = typeof dict.limit === "number" ? dict.limit : null
          if (offset !== null) range = limit !== null ? `${offset}-${offset + limit}` : `${offset}-`
        }
      } catch {
        continue
      }
    }
    if (!path) continue
    const entry = by.get(path) ?? { reads: 0, agents: new Set<string>(), ranges: new Set<string>() }
    entry.reads += 1
    const agent = agentOf(record)
    if (agent) entry.agents.add(agent)
    if (range) entry.ranges.add(range)
    by.set(path, entry)
  }
  return [...by.entries()]
    .map(([path, info]) => ({ path, reads: info.reads, agents: [...info.agents], ranges: [...info.ranges].slice(0, 5) }))
    .sort((a, b) => b.reads - a.reads)
}

/** Test-runner signatures get a verdict line (their last output line). */
const TEST_RUNNER_HINTS = ["pytest", "tsx --test", "pnpm test", "npm test", "go test", "cargo test", "jest", "vitest", "mocha", "tsc ", "typecheck"]

export const verdictLine = (signatureText: string, excerpt: string | null): string | null => {
  if (!excerpt) return null
  if (!TEST_RUNNER_HINTS.some((hint) => signatureText.includes(hint))) return null
  const lines = excerpt.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return null
  const last = lines[lines.length - 1]
  return last.length > 120 ? last.slice(0, 120) : last
}

/** Session meta from opencode.db: title, cost, tokens, line-change summary, turn counts. */
export type SessionMeta = {
  sessionID: string
  title: string | null
  directory: string | null
  cost: number | null
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null
  additions: number | null
  deletions: number | null
  files: number | null
  userTurns: number
  assistantTurns: number
  compactions: number
  lastWord: string | null
  models: string[]
}

export const sessionMeta = async (options: { dbPath?: string; sessionID: string }): Promise<{ meta: SessionMeta | null; warning: string | null }> => {
  const empty: SessionMeta = {
    sessionID: options.sessionID, title: null, directory: null, cost: null,
    tokens: null, additions: null, deletions: null, files: null, userTurns: 0, assistantTurns: 0, compactions: 0, lastWord: null, models: [],
  }
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const row = db.query("SELECT title, directory, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, summary_additions, summary_deletions, summary_files FROM session_v2 WHERE id = ?").get(options.sessionID) as Dict | null
      if (!row) return { meta: null, warning: "session not in db" }
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
      const meta: SessionMeta = {
        ...empty,
        title: typeof row.title === "string" ? row.title : null,
        directory: typeof row.directory === "string" ? row.directory : null,
        cost: num(row.cost),
        tokens: {
          input: num(row.tokens_input) ?? 0, output: num(row.tokens_output) ?? 0,
          reasoning: num(row.tokens_reasoning) ?? 0, cacheRead: num(row.tokens_cache_read) ?? 0,
          cacheWrite: num(row.tokens_cache_write) ?? 0,
        },
        additions: num(row.summary_additions), deletions: num(row.summary_deletions), files: num(row.summary_files),
      }
      try {
        const counts = db.query("SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type").all(options.sessionID) as { type: unknown; n: unknown }[]
        for (const c of counts) {
          if (c.type === "user" && typeof c.n === "number") meta.userTurns = c.n
          if (c.type === "assistant" && typeof c.n === "number") meta.assistantTurns = c.n
          if (c.type === "compaction" && typeof c.n === "number") meta.compactions = c.n
        }
      } catch {
        // turn counts are best-effort
      }
      try {
        const lastRows = db.query("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 5").all(options.sessionID) as { data: unknown }[]
        for (const row of lastRows) {
          if (typeof row.data !== "string") continue
          try {
            const data = JSON.parse(row.data) as unknown
            const content = asDict(data)?.content
            if (Array.isArray(content)) {
              for (const part of content) {
                const text = asDict(part)?.text
                if (typeof text === "string" && text.trim().length > 0) {
                  const single = text.replace(/\s+/g, " ").trim()
                  meta.lastWord = single.length > 500 ? single.slice(0, 500) : single
                  break
                }
              }
            }
          } catch {
            continue
          }
          if (meta.lastWord) break
        }
      } catch {
        // last word is best-effort
      }
      try {
        const modelRows = db.query("SELECT DISTINCT json_extract(data,'$.model.id') AS m FROM session_message WHERE session_id = ? AND type = 'assistant' AND m IS NOT NULL LIMIT 10").all(options.sessionID) as { m: unknown }[]
        for (const row of modelRows) {
          if (typeof row.m === "string" && !meta.models.includes(row.m)) meta.models.push(row.m)
        }
      } catch {
        // models are best-effort
      }
      return { meta: maskMetaText(meta), warning: null }
    } finally {
      db.close()
    }
  } catch (error) {
    return { meta: null, warning: `meta unreadable: ${maskSecrets(String(error)).slice(0, 120)}` }
  }
}

/** Join co-present warnings into the single meta `warning` string (schema
 * unchanged: still string|null). Nulls drop out; null when all absent. */
export const joinWarnings = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0)
  return kept.length > 0 ? kept.join("; ") : null
}

/** Masked copy of session meta for output: free-text fields (title,
 * directory, last word, model ids) redact secret shapes; the DB row is
 * untouched. Counts and numeric fields pass through. */
export const maskMetaText = (meta: SessionMeta): SessionMeta => ({
  ...meta,
  title: meta.title === null ? null : maskSecrets(meta.title),
  directory: meta.directory === null ? null : maskSecrets(meta.directory),
  lastWord: meta.lastWord === null ? null : maskSecrets(meta.lastWord),
  models: meta.models.map((m) => maskSecrets(m)),
})

export const formatMeta = (meta: SessionMeta): string => {
  const out = [`session: ${meta.sessionID}`]
  if (meta.title) out.push(`title: ${meta.title}`)
  if (meta.directory) out.push(`dir: ${meta.directory}`)
  if (meta.cost !== null) out.push(`cost: $${meta.cost.toFixed(4)}`)
  if (meta.tokens) out.push(`token: in=${meta.tokens.input} out=${meta.tokens.output} reason=${meta.tokens.reasoning} cache=${meta.tokens.cacheRead}/${meta.tokens.cacheWrite}`)
  if (meta.additions !== null || meta.deletions !== null) out.push(`changes: +${meta.additions ?? "?"} -${meta.deletions ?? "?"} (${meta.files ?? "?"} files)`)
  out.push(`turns: ${meta.userTurns} user / ${meta.assistantTurns} assistant${meta.compactions > 0 ? ` / ${meta.compactions} compaction` : ""}`)
  if (meta.lastWord) out.push(`last word: ${meta.lastWord}`)
  if (meta.models.length > 0) out.push(`models: ${meta.models.join(", ")}`)
  return out.join("\n")
}

/** Latest-observed session outcome from `session_v2` (`idle_outcome` +
 * `time_idle`). Queried against the current read-only DB, never windowed:
 * a `--since` window filters record groups, not this status. Null
 * outcome/at on any unknown (absent/unreadable DB, old schema, missing
 * column/row, null or unexpected outcome) with a sanitized named reason —
 * never a false running/stale claim. `latest-observed` marks the field as
 * the last idle write, not a live claim about right now. */
export type SessionStatus = {
  outcome: "interrupted" | "succeeded" | "failed" | null
  at: string | null
  scope: "latest-observed"
  source: "session_v2.idle_outcome+time_idle"
}

export const SESSION_STATUS_SCOPE = "latest-observed" as const
export const SESSION_STATUS_SOURCE = "session_v2.idle_outcome+time_idle" as const

const blankStatus = (): SessionStatus => ({ outcome: null, at: null, scope: SESSION_STATUS_SCOPE, source: SESSION_STATUS_SOURCE })

export const sessionStatus = async (options: { dbPath?: string; sessionID: string }): Promise<{ status: SessionStatus; warning: string | null }> => {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      let row: Dict | null
      try {
        row = db.query("SELECT idle_outcome, time_idle FROM session_v2 WHERE id = ?").get(options.sessionID) as Dict | null
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("no such table")) return { status: blankStatus(), warning: "session_v2 table missing" }
        if (message.includes("no such column")) return { status: blankStatus(), warning: "old schema: session_v2 lacks idle_outcome/time_idle" }
        return { status: blankStatus(), warning: `status query failed: ${maskSecrets(message).slice(0, 120)}` }
      }
      if (!row) return { status: blankStatus(), warning: "session not in db" }
      const outcome = row.idle_outcome
      if (outcome !== "interrupted" && outcome !== "succeeded" && outcome !== "failed") {
        return { status: blankStatus(), warning: outcome === null || outcome === undefined ? "no idle outcome recorded" : "unexpected idle outcome value" }
      }
      const idle = row.time_idle
      const at = typeof idle === "number" && Number.isFinite(idle) ? new Date(idle).toISOString() : null
      return { status: { ...blankStatus(), outcome, at }, warning: null }
    } finally {
      db.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: blankStatus(), warning: `db unreadable: ${maskSecrets(message).slice(0, 120)}` }
  }
}

/** Human status line: `session-status:<outcome>(<at>)[latest-observed]` or
 * `session-status:unknown(<reason>)`. */
export const formatSessionStatus = (status: SessionStatus, warning: string | null): string =>
  status.outcome !== null
    ? `session-status:${status.outcome}(${status.at ?? "time unknown"})[latest-observed]`
    : `session-status:unknown(${warning ?? "no reason recorded"})`

export const formatReads = (stats: ReadStat[]): string =>
  stats
    .map((s) => `${s.reads}x ${s.path}${s.agents.length > 0 ? ` (${s.agents.join("+")})` : ""}${s.ranges.length > 0 ? ` [lines: ${s.ranges.join(", ")}]` : ""}`)
    .join("\n")

export const formatSessions = (sessions: SessionInfo[]): string => {
  const byDir = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const key = s.workdir ?? "(no dir)"
    const list = byDir.get(key) ?? []
    list.push(s)
    byDir.set(key, list)
  }
  const out: string[] = []
  for (const [dir, list] of byDir) {
    out.push(`## ${dir}`)
    for (const s of list) {
      out.push(`${s.sessionID} — ${s.commands} commands${s.fileEdits > 0 ? ` + ${s.fileEdits} files` : ""}${s.fails > 0 ? `, ${s.fails} failed` : ""} | ${s.first ?? "?"} → ${s.last ?? "?"}`)
    }
  }
  return out.join("\n")
}

/** Child sessions via parent_id (subagent work), bounded. */
export const childSessions = async (options: { dbPath?: string; sessionID: string }): Promise<string[]> => {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const found: string[] = []
      let frontier = [options.sessionID]
      for (let depth = 0; depth < 5 && frontier.length > 0 && found.length < 20; depth += 1) {
        const placeholders = frontier.map(() => "?").join(",")
        const rows = db.query(`SELECT id FROM session_v2 WHERE parent_id IN (${placeholders}) LIMIT 20`).all(...frontier) as { id: unknown }[]
        frontier = []
        for (const row of rows) {
          if (typeof row.id === "string" && row.id !== options.sessionID && !found.includes(row.id)) {
            found.push(row.id)
            frontier.push(row.id)
          }
        }
      }
      return found
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
export const groupByTask = (records: EnrichedRecord[]): TaskGroup[] => {
  const groups = new Map<string, EnrichedRecord[]>()
  for (const record of records) {
    const key = typeof record.taskRef === "string" && record.taskRef.length > 0 ? record.taskRef : "(no task)"
    const list = groups.get(key) ?? []
    list.push(record)
    groups.set(key, list)
  }
  const grouped = [...groups.entries()].reverse().map(([taskRef, list]) => {
    const seen = new Map<string, GroupedLine>()
    const lines: GroupedLine[] = []
    for (const record of list) {
      const permCmd =
        record.kind === "permission" && typeof record.action === "string" ? `permit ${record.action}` : null
      const toolCallCmd =
        record.kind === "tool-call" && typeof record.tool === "string"
          ? `${record.tool}${typeof record.args === "string" && record.args.length > 0 ? ` ${record.args}` : ""}`
          : null
      const fileEditCmd =
        record.kind === "file-edit" && typeof record.path === "string" ? `edit ${record.path}` : null
      const raw = permCmd ?? toolCallCmd ?? fileEditCmd ?? (typeof record.command === "string" ? record.command : null)
      const full = raw ? raw.replace(/\s+/g, " ").trim() : "unknown"
      // signature needs raw newlines for heredoc stripping — never the collapsed form
      const sig = signature(raw ?? full)
      const outcome = outcomeOf(record)
      const dupKey = `${sig}\n${outcome}`
      const existing = seen.get(dupKey)
      const intent = typeof record.intent === "string" && record.intent.length > 0 ? record.intent : null
      const messageID = typeof record.messageID === "string" ? record.messageID : null
      const agent = agentOf(record)
      const sess = typeof record.sessionID === "string" ? record.sessionID.slice(0, 13) : null
      const model = record.model && typeof record.model.id === "string" ? record.model.id : null
      const excerpt = typeof record.excerpt === "string" && record.excerpt.length > 0 ? record.excerpt : null
      const result = typeof record.result === "string" && record.result.length > 0 ? record.result : null
      const runTime = runTimeOf(record)
      const runDuration = runDurationOf(record)
      if (existing) {
        existing.runs += 1
        if (runTime !== null) {
          const parsed = Date.parse(runTime)
          if (existing.firstSeen === null || parsed < Date.parse(existing.firstSeen)) existing.firstSeen = runTime
          if (existing.lastSeen === null || parsed > Date.parse(existing.lastSeen)) existing.lastSeen = runTime
        }
        if (agent && !existing.agents.includes(agent) && existing.agents.length < 3) existing.agents.push(agent)
        if (sess && !existing.sessions.includes(sess) && existing.sessions.length < 5) existing.sessions.push(sess)
        if (model && !existing.models.includes(model) && existing.models.length < 3) existing.models.push(model)
        // runTimes/runDurations stay exactly parallel to stored variants:
        // same push, same order, same MAX_STORED_VARIANTS cap.
        if (!existing.variants.includes(full) && existing.variants.length < MAX_STORED_VARIANTS) {
          existing.variants.push(full)
          existing.runTimes.push(runTime)
          existing.runDurations.push(runDuration)
        }
        if (excerpt && !existing.excerpts.includes(excerpt) && existing.excerpts.length < 2) existing.excerpts.push(excerpt)
        if (result && !existing.results.includes(result) && existing.results.length < 2) existing.results.push(result)
        if (intent && !existing.intents.includes(intent) && existing.intents.length < 2) existing.intents.push(intent)
        if (messageID && !existing.messageIDs.includes(messageID) && existing.messageIDs.length < 5) existing.messageIDs.push(messageID)
        const mergeReason = recordFailReason(outcome, record)
        if (mergeReason !== null && !existing.failReasons.includes(mergeReason)) {
          if (existing.failReasons.length < 2) existing.failReasons.push(mergeReason)
          existing.failReasonCount += 1
        }
        if (existing.failReason === null && mergeReason !== null) {
          existing.failReason = mergeReason
          existing.failReasonSource = FAIL_REASON_SOURCE
        }
        continue
      }
      const reason = recordFailReason(outcome, record)
      const line: GroupedLine = {
        ref: lines.length + 1,
        signature: sig,
        outcome,
        runs: 1,
        agents: agent ? [agent] : [],
        sessions: sess ? [sess] : [],
        models: model ? [model] : [],
        failReason: reason,
        failReasons: reason === null ? [] : [reason],
        failReasonCount: reason === null ? 0 : 1,
        failReasonSource: reason === null ? null : FAIL_REASON_SOURCE,
        variants: [full],
        firstSeen: runTime,
        lastSeen: runTime,
        runTimes: [runTime],
        runDurations: [runDuration],
        excerpts: excerpt ? [excerpt] : [],
        results: result ? [result] : [],
        intents: intent ? [intent] : [],
        messageIDs: messageID ? [messageID] : [],
      }
      seen.set(dupKey, line)
      lines.push(line)
    }
    return {
      taskRef,
      runs: list.length,
      fails: list.filter((record) => outcomeOf(record) === "failure" || outcomeOf(record) === "error").length,
      lines: lines.reverse(),
    }
  })
  // Drill refs are unique positive integers across ALL groups of this
  // result, assigned in display order (group order, then line order as
  // shown). Every displayed [N] selects exactly one line via showLine, on
  // human and wire alike. Refs are ephemeral per query (never persisted);
  // a later query over changed records may number differently.
  let ref = 0
  for (const group of grouped) {
    for (const line of group.lines) line.ref = ++ref
  }
  return grouped
}

export const formatGrouped = (groups: TaskGroup[], full = false, withSession = false, sectionBudget?: number): string => {
  const clipText = (text: string, limit: number): string => {
    const stripped = stripEnvPrefix(text.replace(/\s+/g, " ").trim())
    const cap = sectionBudget ?? limit
    return stripped.length > cap ? stripped.slice(0, cap) : stripped
  }
  /** Display-text pipeline: mask secret shapes FIRST, then the existing
   * strip+cap. Mask-before-cap so a cut can never split a shaped secret
   * into an unrecognizable (leaking) half. Stored sources keep raw strings. */
  const clipMasked = (text: string, limit: number): string => clipText(maskSecrets(text), limit)
  const out: string[] = []
  for (const group of groups) {
    out.push(`task: ${maskSecrets(group.taskRef)} (${group.runs} records${group.fails > 0 ? `, ${group.fails} failed` : ""})`)
    for (const line of group.lines) {
      const repeat = line.runs > 1 ? ` x${line.runs}` : ""
      const who = line.agents.length > 0 ? ` (${line.agents.join("+")})` : ""
      const reason =
        (line.outcome === "failure" || line.outcome === "error") && line.failReason
          ? line.failReasonCount > 1
            ? ` (reason: ${line.failReason}; +${line.failReasonCount - 1} more)`
            : ` (reason: ${line.failReason})`
          : ""
      const where = withSession && line.sessions.length > 0 ? ` [${line.sessions.join(",")}]` : ""
      // Multi-run wall range (sidecar timestamps are wall-clock): first→last,
      // never one timestamp as all. Domain-labeled so a wide wall range is
      // never read as a process duration.
      const span = line.runs > 1 && line.firstSeen !== null && line.lastSeen !== null
        ? ` [wall ${line.firstSeen}→${line.lastSeen}]`
        : ""
      out.push(`  [${line.ref}]${who} ${line.signature} — ${line.outcome}${repeat}${reason}${where}${span}`)
      const rawMode = full && !sectionBudget
      for (const variant of line.variants.slice(0, full ? line.variants.length : MAX_SHOWN_VARIANTS)) {
        out.push(`      record: ${rawMode ? maskSecrets(variant) : clipMasked(variant, 130)}`)
      }
      if (!full && line.variants.length > MAX_SHOWN_VARIANTS) out.push(`      (+${line.variants.length - MAX_SHOWN_VARIANTS} more records --show ${line.ref})`)
      for (const intent of line.intents) out.push(`      intent: ${rawMode ? maskSecrets(intent) : clipMasked(intent, 160)}`)
      if ((line.outcome === "failure" || line.outcome === "error") && line.excerpts.length > 0) {
        const clip = line.excerpts[0].replace(/\s+/g, " ").trim()
        out.push(`      output: ${rawMode ? maskSecrets(clip) : clipMasked(clip, 300)}`)
      } else if (line.excerpts.length > 0) {
        const verdict = verdictLine(line.signature, line.excerpts[0])
        if (verdict) out.push(`      result: ${maskSecrets(verdict)}`)
      }
    }
  }
  return out.join("\n")
}

/** Masked copy of task groups for JSON wire output: caller-controlled text
 * (variants, intents, excerpts, results, taskRef) redacts secret shapes;
 * stored sources keep raw strings for analysis. Keys, counts, times and
 * reasons pass through untouched (reasons are masked at extraction). */
export const maskGroupVariants = (groups: TaskGroup[]): TaskGroup[] =>
  groups.map((group) => ({
    ...group,
    taskRef: maskSecrets(group.taskRef),
    lines: group.lines.map((line) => ({
      ...line,
      variants: line.variants.map((v) => maskSecrets(v)),
      intents: line.intents.map((v) => maskSecrets(v)),
      excerpts: line.excerpts.map((v) => maskSecrets(v)),
      results: line.results.map((v) => maskSecrets(v)),
    })),
  }))

/** Parse byte budgets like 512, 1k, 4k, 1m. */
export const parseBytes = (value: string | undefined): number | null =>
  parseAmountUnit(value, /^(\d+)\s*([km]?)$/i, { "": 1, k: 1024, m: 1024 * 1024 })

/** Per-run clock line for the drill-down: wall instant vs process-monotonic
 * duration, domains labeled. A wide wall gap with short process durations
 * (suspend, queueing) renders as exactly that — never a duration claim. */
export const runClockLine = (at: string | null, durationMs: number | null): string => {
  const wall = at ?? "unknown"
  const process = durationMs === null ? "unknown" : durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
  return `wall: ${wall} · process-monotonic: ${process}`
}

/** Full drill-down for one collapsed line: every stored variant, unclipped unless budgeted. */
export const showLine = (groups: TaskGroup[], ref: number, sectionBudget?: number): string => {
  const clipBody = (text: string): string => {
    const stripped = stripEnvPrefix(text.replace(/\s+/g, " ").trim())
    if (!sectionBudget || stripped.length <= sectionBudget) return stripped
    return stripped.slice(0, sectionBudget) + `\n…[+${stripped.length - sectionBudget} more chars]…`
  }
  const showBody = (text: string): string => (sectionBudget ? clipBody(text) : text)
  for (const group of groups) {
    const line = group.lines.find((l) => l.ref === ref)
    if (!line) continue
    const out: string[] = [
      `[${line.ref}] ${line.signature} — ${line.outcome} x${line.runs} (${maskSecrets(group.taskRef)})`,
    ]
    line.variants.forEach((variant, i) => {
      out.push(`--- record ${i + 1}/${line.variants.length} ---`)
      out.push(runClockLine(line.runTimes[i] ?? null, line.runDurations[i] ?? null))
      out.push(showBody(maskSecrets(variant)))
    })
    if ((line.outcome === "failure" || line.outcome === "error") && line.failReasons.length > 0) {
      out.push(`--- reasons (from command text) ---`)
      for (const item of line.failReasons) out.push(`- ${item}`)
      if (line.failReasonCount > line.failReasons.length) out.push(`(+${line.failReasonCount - line.failReasons.length} more)`)
    }
    if (line.intents.length > 0) {
      out.push(`--- task context (not failure cause) ---`)
      for (const intent of line.intents) out.push(`- ${maskSecrets(intent)}`)
    }
    if (line.excerpts.length > 0) {
      line.excerpts.forEach((excerpt, i) => {
        out.push(`--- output ${i + 1}/${line.excerpts.length} ---`)
        out.push(showBody(maskSecrets(excerpt)))
      })
    }
    if (line.results.length > 0) {
      line.results.forEach((res, i) => {
        out.push(`--- result ${i + 1}/${line.results.length} ---`)
        out.push(showBody(maskSecrets(res)))
      })
    }
    if (line.messageIDs.length > 0) out.push(`messageIDs: ${line.messageIDs.join(",")}`)
    if (line.models.length > 0) out.push(`models: ${line.models.join(", ")}`)
    return out.join("\n")
  }
  return `line not found: ${ref}`
}

