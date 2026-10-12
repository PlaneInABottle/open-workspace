/** `ow timeline`: one chronological view joining agent sidecar rows with
 * OTLP spans. Agent rows come from the existing show/sessions join
 * (`joinSession`, imported — never reimplemented); spans from the M1 store
 * reader. The M1 writer is the single sanitizer: agent bodies reuse the
 * existing `signature()` shape abstraction and span fields print verbatim
 * from the store, so this read path captures zero raw bodies or values.
 *
 * Linking: an ID found in ≥1 sidecar row links EXACTLY (`exact`); an
 * unreferenced span attaches to its nearest agent row within
 * ±`TIMELINE_FALLBACK_MS` (`estimated`); anything else renders standalone
 * with no link claim (confidence omitted — never invented).
 *
 * `--trace` filtering follows `ow trace` list semantics: an unknown id is
 * honest-empty exit 0 (a listing surface), while malformed/ambiguous ids
 * are usage errors. */

import { joinSession, latestSession, type EnrichedRecord } from "./join"
import { signature } from "./signature"
import { readSpansFile, tracePaths } from "./trace-store"
import { buildTraceTree, formatDur, groupSpansByTrace, HEX_ID } from "./trace-query"
import type { TraceSpan } from "./trace-otlp"
import { truncateLogLine } from "./up-logs"

/** Estimated-link window: nearest agent row within ±10 s. */
export const TIMELINE_FALLBACK_MS = 10_000
export const TIMELINE_DEFAULT_TAIL = 100
export const TIMELINE_MAX_TAIL = 5000
const ID_SCAN_MAX_CHARS = 20_000

/** Candidate trace IDs from sidecar row text (command + intent + output
 * excerpts): W3C `traceparent` middle field plus bare 32-hex. Lowercased
 * to match stored span ids; non-matching candidates are harmless because
 * linking is exact-equality only. */
export const extractTraceIds = (texts: string[]): string[] => {
  const found = new Set<string>()
  const scan = texts.join("\n").slice(0, ID_SCAN_MAX_CHARS)
  for (const match of scan.matchAll(/\b00-([0-9a-fA-F]{32})-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}\b/g)) {
    found.add(match[1].toLowerCase())
  }
  for (const match of scan.matchAll(/\b[0-9a-fA-F]{32}\b/g)) found.add(match[0].toLowerCase())
  return [...found]
}

type AgentRow = { ts: number; body: string; ids: string[] }

const rowTexts = (record: EnrichedRecord): string[] => {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push(value.slice(0, 8000))
    else if (value !== null && typeof value === "object") {
      try {
        out.push(JSON.stringify(value).slice(0, 8000))
      } catch {
        // unserializable command shapes contribute nothing
      }
    }
  }
  push(record.command)
  push(record.intent)
  push(record.taskRef)
  push(record["excerpt"])
  push(record["output"])
  return out
}

const rowTime = (record: EnrichedRecord): number | null => {
  const parsed = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "")
  return Number.isFinite(parsed) ? parsed : null
}

const agentBody = (record: EnrichedRecord): string => {
  const command = typeof record.command === "string" ? record.command : null
  if (command !== null) return truncateLogLine(signature(command))
  const kind = typeof record.kind === "string" && record.kind.length > 0 ? record.kind : "unknown"
  return truncateLogLine(kind)
}

const spanTime = (span: TraceSpan): number => Number(BigInt(span.startNano) / 1_000_000n)

const spanBody = (span: TraceSpan): string =>
  truncateLogLine(`[${span.service}] ${span.name} ${formatDur(span.durMs)}`)

export type TimelineOptions = {
  rootDir: string
  logPath?: string
  dbPath?: string
  sessionID?: string
  traceId?: string
  tail?: number
  sinceMs?: number | null
  json?: boolean
}

export type TimelineResult = { code: number; stdout: string; stderr: string }

type TimelineEvent = {
  ts: number
  kind: "agent" | "trace"
  text: string
  traceId?: string
  confidence?: "exact" | "estimated"
  depth?: number
}

const quietEnvelope = (warnings: string[]): string => JSON.stringify({ events: [], warnings })

export const runTimeline = async (options: TimelineOptions): Promise<TimelineResult> => {
  const json = options.json === true
  const ok = (stdout: string, warnings: string[]): TimelineResult => ({
    code: 0,
    stdout,
    stderr: json ? "" : warnings.join("\n"),
  })
  const fail = (code: number, stderr: string): TimelineResult => ({ code, stdout: "", stderr })
  const quiet = (warnings: string[]): TimelineResult => ok(json ? quietEnvelope(warnings) : "no timeline", warnings)

  const rawId = options.traceId
  let idFilter: string | null = null
  if (rawId !== undefined) {
    const id = rawId.toLowerCase()
    if (id.length < 8 || id.length > 32 || !HEX_ID.test(id)) {
      return fail(2, "ow: invalid trace id")
    }
    idFilter = id
  }

  const logPath = options.logPath
  const sessionID = options.sessionID ?? (logPath === undefined ? null : await latestSession(logPath))
  if (sessionID === null || sessionID === undefined) return quiet([])

  const now = Date.now()
  const { records, warnings } = await joinSession({
    dbPath: options.dbPath,
    logPath,
    sessionID,
    sinceMs: options.sinceMs ?? null,
    now,
  })
  const cutoff = options.sinceMs != null ? now - options.sinceMs : null
  const rows: AgentRow[] = []
  for (const record of records) {
    const ts = rowTime(record)
    if (ts === null) continue
    if (cutoff !== null && ts < cutoff) continue
    rows.push({ ts, body: agentBody(record), ids: extractTraceIds(rowTexts(record)) })
  }
  rows.sort((a, b) => a.ts - b.ts)

  let stored: TraceSpan[]
  try {
    stored = (await readSpansFile(tracePaths(options.rootDir).spansFile)).spans
  } catch (error) {
    return fail(1, `ow: timeline unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
  }
  const groups = groupSpansByTrace(stored)
  const depths = new Map<string, number>()
  const valid: TraceSpan[] = []
  for (const [, spans] of groups) {
    const tree = buildTraceTree(spans)
    for (const node of tree.nodes) depths.set(`${node.span.traceId}:${node.span.spanId}`, node.depth)
    // Depths are best-effort past the render cap; spans themselves are never
    // dropped here (the cap only bounds one tree view, not this listing).
    valid.push(...spans)
  }
  const inWindow = cutoff === null ? valid : valid.filter((span) => Number(BigInt(span.endNano) / 1_000_000n) >= cutoff)

  const mentioned = new Map<string, number[]>()
  rows.forEach((row, index) => {
    for (const id of row.ids) {
      const list = mentioned.get(id)
      if (list) {
        if (!list.includes(index)) list.push(index)
      } else {
        mentioned.set(id, [index])
      }
    }
  })

  // --trace universe: spanned ids plus mentioned-but-spanless ids.
  if (idFilter !== null) {
    const candidates = new Set<string>([...groups.keys(), ...mentioned.keys()])
    const matches = [...candidates].filter((id) => id.startsWith(idFilter as string))
    if (matches.length === 0) {
      return json
        ? ok(quietEnvelope(warnings), warnings)
        : { code: 0, stdout: `no timeline (trace not found: ${rawId})`, stderr: warnings.join("\n") }
    }
    if (matches.length > 1) {
      return fail(2, `ow: multiple traces matched (${matches.length} candidates, narrow the prefix)`)
    }
  }

  type LinkedSpan = { span: TraceSpan; confidence: "exact" | "estimated" | null; rowIndex: number | null }
  const linked: LinkedSpan[] = inWindow.map((span) => {
    const carriers = mentioned.get(span.traceId) ?? []
    if (carriers.length > 0) return { span, confidence: "exact", rowIndex: carriers[0] }
    let best: number | null = null
    let bestGap = TIMELINE_FALLBACK_MS + 1
    const ts = spanTime(span)
    rows.forEach((row, index) => {
      const gap = Math.abs(ts - row.ts)
      if (gap <= TIMELINE_FALLBACK_MS && gap < bestGap) {
        best = index
        bestGap = gap
      }
    })
    return best === null
      ? { span, confidence: null, rowIndex: null }
      : { span, confidence: "estimated", rowIndex: best }
  })

  let keepRows = new Set(rows.map((_, index) => index))
  let keepSpans = linked
  if (idFilter !== null) {
    const id = [...new Set([...groups.keys(), ...mentioned.keys()])].find((candidate) => candidate.startsWith(idFilter as string)) as string
    keepSpans = linked.filter((entry) => entry.span.traceId === id)
    keepRows = new Set<number>()
    for (const index of mentioned.get(id) ?? []) keepRows.add(index)
    for (const entry of keepSpans) {
      if (entry.rowIndex !== null) keepRows.add(entry.rowIndex)
    }
  }

  const events: TimelineEvent[] = []
  rows.forEach((row, index) => {
    if (keepRows.has(index)) events.push({ ts: row.ts, kind: "agent", text: row.body })
  })
  for (const entry of keepSpans) {
    const event: TimelineEvent = {
      ts: spanTime(entry.span),
      kind: "trace",
      text: spanBody(entry.span),
      traceId: entry.span.traceId,
      depth: depths.get(`${entry.span.traceId}:${entry.span.spanId}`) ?? 0,
    }
    if (entry.confidence !== null) event.confidence = entry.confidence
    events.push(event)
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1))

  // Defense-in-depth like the list --tail guard: non-integer tails fall back
  // to the default instead of slicing to an empty page.
  const tail =
    typeof options.tail === "number" && Number.isInteger(options.tail)
      ? Math.min(Math.max(1, options.tail), TIMELINE_MAX_TAIL)
      : TIMELINE_DEFAULT_TAIL
  const page = events.slice(-tail)
  if (page.length === 0) return quiet(warnings)

  if (json) {
    return ok(
      JSON.stringify({
        events: page.map((event) => {
          const row: Record<string, unknown> = { ts: new Date(event.ts).toISOString(), kind: event.kind, text: event.text }
          if (event.traceId !== undefined) row["traceId"] = event.traceId
          if (event.confidence !== undefined) row["confidence"] = event.confidence
          if (event.depth !== undefined) row["depth"] = event.depth
          return row
        }),
        warnings,
      }),
      warnings,
    )
  }
  const lines = page.map((event) => {
    const iso = new Date(event.ts).toISOString()
    if (event.kind === "agent") return `${iso} AGENT ${event.text}`
    const tag = event.confidence === "exact" ? " [exact]" : event.confidence === "estimated" ? " [estimated]" : ""
    return `${iso} TRACE ${event.text}${tag}`
  })
  return ok(lines.join("\n"), warnings)
}
