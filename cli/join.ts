import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { signature } from "./signature"
import { maskSecrets } from "./up-evidence"

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
        try {
          const parsed = JSON.parse(line) as unknown
          const dict = asDict(parsed)
          return dict && dict.sessionID === options.sessionID ? [dict] : []
        } catch {
          return []
        }
      })
  } catch (error) {
    warnings.push(`sidecar unreadable: ${String(error).slice(0, 160)}`)
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
    warnings.push(`opencode.db unreadable: ${String(error).slice(0, 160)}`)
  }
  if (!rows) {
    warnings.push("message table unavailable — records emitted without intent")
    return { records: sidecar.map((record) => ({ ...record, intent: null, taskRef: null })), warnings }
  }
  return { records: sidecar.map((record) => attachIntent(record, rows)), warnings }
}

export type GroupedLine = {
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

/** Max number of read windows covering a common line. [-1,-1] = whole-file read, overlaps everything. */
export const maxOverlap = (windows: [number, number][]): number => {
  const points = new Set<number>()
  for (const [a, b] of windows) {
    if (a < 0) return windows.length
    points.add(a)
    points.add(Math.max(a, b - 1))
  }
  let best = 1
  for (const p of points) {
    let depth = 0
    for (const [a, b] of windows) if (a < 0 || (p >= a && p < b)) depth += 1
    if (depth > best) best = depth
  }
  return best
}

/** Stuck signals for one session: retries, re-reads, slow runs, interruptions. */
export type StuckReport = {
  retries: { signature: string; runs: number; fails: number }[]
  rereads: { path: string; agent: string; reads: number; depth: number }[]
  slow: { ms: number; command: string }[]
  interruptions: number
  compactions: number
  afterInterrupt: string[]
}

export const stuckReport = async (options: {
  records: EnrichedRecord[]
  dbPath?: string
  sessionID: string
}): Promise<StuckReport> => {
  const bySig = new Map<string, { runs: number; fails: number }>()
  const slow: { ms: number; command: string }[] = []
  for (const record of options.records) {
    const cmd = typeof record.command === "string" ? record.command : null
    if (cmd) {
      const sig = signature(cmd)
      const entry = bySig.get(sig) ?? { runs: 0, fails: 0 }
      entry.runs += 1
      if (record.outcome === "failure" || record.outcome === "error") entry.fails += 1
      bySig.set(sig, entry)
    }
    if (typeof record.durationMs === "number" && record.durationMs >= 30_000 && cmd) {
      slow.push({ ms: record.durationMs, command: cmd.replace(/\s+/g, " ").trim().slice(0, 100) })
    }
  }
  const retries = [...bySig.entries()]
    .filter(([, v]) => v.runs >= 3 && v.fails >= 2 && v.fails / v.runs >= 0.25)
    .map(([signature, v]) => ({ signature, ...v }))
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 5)
  slow.sort((a, b) => b.ms - a.ms)
  // re-reads count per (agent, path) with OVERLAPPING windows: same agent
  // re-reading the same ~lines is circling; scanning different parts is work.
  const rereadKey = new Map<string, { path: string; agent: string; windows: [number, number][] }>()
  for (const record of options.records) {
    if (record.kind !== "tool-call" || record.tool !== "read") continue
    let path: string | null = null
    let window: [number, number] | null = null
    if (typeof record.args === "string") {
      try {
        const args = JSON.parse(record.args) as unknown
        const dict = (typeof args === "object" && args !== null ? args : null) as Record<string, unknown> | null
        if (dict && typeof dict.path === "string") {
          path = dict.path
          if (typeof dict.offset === "number" && typeof dict.limit === "number") {
            window = [dict.offset, dict.offset + dict.limit]
          }
        }
      } catch {
        continue
      }
    }
    if (!path) continue
    const agent = (typeof record.agent === "string" && record.agent.length > 0 ? record.agent : "?")
    const key = `${agent} ${path}`
    const entry = rereadKey.get(key) ?? { path: path.split("/").slice(-2).join("/"), agent, windows: [] }
    if (window) entry.windows.push(window)
    else entry.windows.push([-1, -1])
    rereadKey.set(key, entry)
  }
  const rereads = [...rereadKey.values()]
    .map((e) => ({ path: e.path, agent: e.agent, reads: e.windows.length, depth: maxOverlap(e.windows) }))
    .filter((e) => e.depth >= 3)
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 5)
  let interruptions = 0
  let compactions = 0
  const afterInterrupt: string[] = []
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const rows = db.query("SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type").all(options.sessionID) as { type: unknown; n: unknown }[]
      for (const row of rows) {
        if (row.type === "compaction" && typeof row.n === "number") compactions = row.n
      }
      const intr = db.query("SELECT seq FROM session_message WHERE session_id = ? AND data LIKE '%was interrupted%' ORDER BY seq LIMIT 5").all(options.sessionID) as { seq: unknown }[]
      interruptions = intr.length
      // what the user wanted right after each interruption
      for (const row of intr) {
        if (typeof row.seq !== "number") continue
        const next = db.query("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' AND seq > ? ORDER BY seq LIMIT 1").get(options.sessionID, row.seq) as { data: unknown } | null
        if (!next || typeof next.data !== "string") continue
        try {
          const data = JSON.parse(next.data) as unknown
          const text = typeof (data as Dict)?.text === "string" ? ((data as Dict).text as string) : null
          if (text) {
            const single = text.replace(/\s+/g, " ").trim()
            afterInterrupt.push(single.length > 200 ? single.slice(0, 200) : single)
          }
        } catch {
          continue
        }
      }
      if (intr.length === 5) {
        const total = db.query("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND data LIKE '%was interrupted%'").get(options.sessionID) as { n: unknown } | null
        if (total && typeof total.n === "number") interruptions = total.n
      }
    } finally {
      db.close()
    }
  } catch {
    // counts are best-effort
  }
  return { retries, rereads, slow: slow.slice(0, 5), interruptions, compactions, afterInterrupt }
}

export const formatStuck = (report: StuckReport): string => {
  const out = ["stuck report:"]
  out.push(`interrupts: ${report.interruptions} | compaction: ${report.compactions}`)
  for (const msg of report.afterInterrupt) out.push(`  post-interrupt user: ${msg}`)
  if (report.retries.length > 0) {
    out.push("retries:")
    for (const r of report.retries) out.push(`  ${r.runs}x (${r.fails} failed) ${r.signature.slice(0, 100)}`)
  }
  if (report.rereads.length > 0) {
    out.push("revisited files (same agent, overlapping lines):")
    for (const r of report.rereads) out.push(`  ${r.reads}x (depth ${r.depth}) [${r.agent}] ${r.path}`)
  }
  if (report.slow.length > 0) {
    out.push("slow:")
    for (const s of report.slow) out.push(`  ${Math.round(s.ms / 1000)}s ${s.command.slice(0, 100)}`)
  }
  if (report.retries.length === 0 && report.rereads.length === 0 && report.slow.length === 0 && report.interruptions === 0) {
    out.push("clean — no stuck signals")
  }
  return out.join("\n")
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
      return { meta, warning: null }
    } finally {
      db.close()
    }
  } catch (error) {
    return { meta: null, warning: `meta unreadable: ${String(error).slice(0, 120)}` }
  }
}

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

/** User prompts of a session: latest N, returned chronological. */
export const sessionPrompts = async (options: { dbPath?: string; sessionID: string; limit?: number }): Promise<string[]> => {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const rows = (db.query("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT ?").all(options.sessionID, options.limit ?? 20) as { data: unknown }[]).reverse()
      return rows.flatMap((row) => {
        if (typeof row.data !== "string") return []
        try {
          const data = JSON.parse(row.data) as unknown
          const dict = asDict(data)
          const text = dict && typeof dict.text === "string" ? dict.text.replace(/\s+/g, " ").trim() : null
          return text ? [text.length > 300 ? text.slice(0, 300) : text] : []
        } catch {
          return []
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

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
  return [...groups.entries()].reverse().map(([taskRef, list]) => {
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
      if (existing) {
        existing.runs += 1
        if (agent && !existing.agents.includes(agent) && existing.agents.length < 3) existing.agents.push(agent)
        if (sess && !existing.sessions.includes(sess) && existing.sessions.length < 5) existing.sessions.push(sess)
        if (model && !existing.models.includes(model) && existing.models.length < 3) existing.models.push(model)
        if (!existing.variants.includes(full) && existing.variants.length < MAX_STORED_VARIANTS) existing.variants.push(full)
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
}

export const formatGrouped = (groups: TaskGroup[], full = false, withSession = false, sectionBudget?: number): string => {
  const clipText = (text: string, limit: number): string => {
    const stripped = stripEnvPrefix(text.replace(/\s+/g, " ").trim())
    const cap = sectionBudget ?? limit
    return stripped.length > cap ? stripped.slice(0, cap) : stripped
  }
  const out: string[] = []
  for (const group of groups) {
    out.push(`task: ${group.taskRef} (${group.runs} records${group.fails > 0 ? `, ${group.fails} failed` : ""})`)
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
      out.push(`  [${line.ref}]${who} ${line.signature} — ${line.outcome}${repeat}${reason}${where}`)
      const rawMode = full && !sectionBudget
      for (const variant of line.variants.slice(0, full ? line.variants.length : MAX_SHOWN_VARIANTS)) {
        out.push(`      record: ${rawMode ? variant : clipText(variant, 130)}`)
      }
      if (!full && line.variants.length > MAX_SHOWN_VARIANTS) out.push(`      (+${line.variants.length - MAX_SHOWN_VARIANTS} more records --show ${line.ref})`)
      for (const intent of line.intents) out.push(`      intent: ${rawMode ? intent : clipText(intent, 160)}`)
      if ((line.outcome === "failure" || line.outcome === "error") && line.excerpts.length > 0) {
        const clip = line.excerpts[0].replace(/\s+/g, " ").trim()
        out.push(`      output: ${rawMode ? clip : clipText(clip, 300)}`)
      } else if (line.excerpts.length > 0) {
        const verdict = verdictLine(line.signature, line.excerpts[0])
        if (verdict) out.push(`      result: ${verdict}`)
      }
    }
  }
  return out.join("\n")
}

/** Parse byte budgets like 512, 1k, 4k, 1m. */
export const parseBytes = (value: string | undefined): number | null =>
  parseAmountUnit(value, /^(\d+)\s*([km]?)$/i, { "": 1, k: 1024, m: 1024 * 1024 })

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
      `[${line.ref}] ${line.signature} — ${line.outcome} x${line.runs} (${group.taskRef})`,
    ]
    line.variants.forEach((variant, i) => {
      out.push(`--- record ${i + 1}/${line.variants.length} ---`)
      out.push(showBody(variant))
    })
    if ((line.outcome === "failure" || line.outcome === "error") && line.failReasons.length > 0) {
      out.push(`--- reasons (from command text) ---`)
      for (const item of line.failReasons) out.push(`- ${item}`)
      if (line.failReasonCount > line.failReasons.length) out.push(`(+${line.failReasonCount - line.failReasons.length} more)`)
    }
    if (line.intents.length > 0) {
      out.push(`--- intents ---`)
      for (const intent of line.intents) out.push(`- ${intent}`)
    }
    if (line.excerpts.length > 0) {
      line.excerpts.forEach((excerpt, i) => {
        out.push(`--- output ${i + 1}/${line.excerpts.length} ---`)
        out.push(showBody(excerpt))
      })
    }
    if (line.results.length > 0) {
      line.results.forEach((res, i) => {
        out.push(`--- result ${i + 1}/${line.results.length} ---`)
        out.push(showBody(res))
      })
    }
    if (line.messageIDs.length > 0) out.push(`messageIDs: ${line.messageIDs.join(",")}`)
    if (line.models.length > 0) out.push(`models: ${line.models.join(", ")}`)
    return out.join("\n")
  }
  return `line not found: ${ref}`
}

