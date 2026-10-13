/** `ow trace` command: list recent traces or render one parent/child tree,
 * plus the informational `doctor` trace line. Quiet-when-unconfigured is
 * exit 0 with the plan-pinned strings; usage errors exit 2; structural
 * (read/resolve) failures exit 1 with a bounded one-line message — never a
 * stack dump. `--service` filters the list only; it never prunes a tree. */

import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"

import type { TraceSpan } from "./trace-otlp"
import { readSpansFile, TRACE_DEFAULT_PORT, tracePaths } from "./trace-store"
import {
  buildTraceTree,
  formatAgo,
  formatDur,
  groupSpansByTrace,
  HEX_ID,
  selectValidSpans,
  summarizeTrace,
  type TraceSummary,
} from "./trace-query"
import { parseAmountUnit, sinceWindow, windowNotice, type SinceWindow } from "./join"
import { parseUpFile } from "./up-schema"
import { noStateNote } from "./up-state"

/** Default list tail: 100 newest traces (~7KB real-shape at ~69B/line;
 * the pilot store holds thousands, so 20 showed under 1%). */
export const TRACE_LIST_DEFAULT_TAIL = 100

/** `--wait` polling discipline: 500 ms steps, 5-minute ceiling. */
export const TRACE_WAIT_POLL_MS = 500
export const TRACE_WAIT_MAX_MS = 300_000

/** `--wait` durations: `<amount>s|m|h|d|w` within (0, 5m]. Null when unusable. */
export const parseWaitDuration = (raw: string): number | null => {
  const ms = parseAmountUnit(raw, /^(\d+)(s|m|h|d|w)$/, { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 })
  if (ms === null || !Number.isSafeInteger(ms) || ms <= 0 || ms > TRACE_WAIT_MAX_MS) return null
  return ms
}

export type TraceRunOptions = {
  rootDir: string
  owYamlPath: string
  traceId?: string
  tail?: number
  sinceMs?: number | null
  /** Raw `--since` flag (echoed in the human-only window notice + JSON window). */
  since?: string
  /** Injected clock for the window envelope (default live; tests pin it). */
  now?: number
  service?: string
  json?: boolean
  /** Poll `spans.jsonl` this long for a newly arriving matching span before
   * rendering once. Programmatic milliseconds; the CLI bounds `--wait` to
   * (0, 5m] and clamps anything else here. */
  waitMs?: number
  /** List-view interest floor: traces with fewer spans are hidden, except
   * error traces which always render. `undefined` (CLI default) hides only
   * parentless ok/unset singletons; `1` shows everything. Tree lookups and
   * exact-ID queries ignore it entirely. */
  minSpans?: number
  /** Directory the upward `.ow/` search started from (defaults to rootDir).
   * Names the searched reality in the honest-empty message only. */
  searchStart?: string
}

export type TraceRunResult = { code: number; stdout: string; stderr: string }

const quietJson = (window: SinceWindow | null): string => JSON.stringify({ traces: [], window })

/** Store-backed quiet shape (scoped to the store/no-span path only —
 * unconfigured exits keep the bare quiet above): `stored` is the raw span
 * count read, `reason` disambiguates an empty store from stored-but-invalid
 * spans. */
const quietStoreJson = (stored: number, reason: string, window: SinceWindow | null): string =>
  JSON.stringify({ traces: [], stored, reason, window })

/** Newest activity first, traceId ascending as the deterministic tiebreak. */
const byRecency = (a: TraceSummary, b: TraceSummary): number =>
  a.lastEnd > b.lastEnd ? -1 : a.lastEnd < b.lastEnd ? 1 : a.traceId < b.traceId ? -1 : 1

/** Programmatic-number guard core: non-number or out-of-rule input yields the
 * caller's fallback (0 / undefined / list default — each preserved exactly).
 * Integer sites stay `isInteger`; `--wait` stays finite-only so fractional
 * milliseconds behave exactly as before. Unbounded sites pass +Infinity. */
const clampNumber = <F extends number | undefined>(
  value: unknown,
  rule: { integer: boolean; min: number; max: number },
  fallback: F,
): number | F => {
  if (typeof value !== "number") return fallback
  if (rule.integer ? !Number.isInteger(value) : !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, rule.min), rule.max)
}

const toListJson = (summaries: TraceSummary[], returned: number, total: number, window: SinceWindow | null): string =>
  JSON.stringify({
    traces: summaries.map((summary) => ({
      traceId: summary.traceId,
      root: summary.root,
      services: summary.services,
      spans: summary.spans,
      durMs: summary.durMs,
      startedAt: summary.startedAt,
      status: summary.status,
    })),
    returned,
    total,
    window,
  })

const formatListLine = (summary: TraceSummary, now: number): string => {
  const agoMs = Math.max(0, now - Number(summary.lastEnd / 1_000_000n))
  return [
    summary.traceId.slice(0, 8),
    formatAgo(agoMs),
    summary.root,
    `${summary.services.length} services`,
    `${summary.spans} span`,
    formatDur(summary.durMs),
    summary.status === "error" ? "✗" : "✓",
  ].join("  ")
}

const formatTreeView = (summary: TraceSummary, spans: TraceSpan[]): string => {
  const tree = buildTraceTree(spans)
  const lines = [
    `trace ${summary.traceId.slice(0, 12)}...  ${summary.spans} span, ${summary.services.length} services, ${formatDur(summary.durMs)}`,
  ]
  for (const node of tree.nodes) {
    const span = node.span
    const offsetMs = Number((BigInt(span.startNano) - summary.firstStart) / 1_000_000n)
    const attrs = Object.entries(span.attrs)
      .map(([key, value]) => ` ${key}=${value}`)
      .join("")
    // Error detail: the stored errorType joins the status word ONLY when no
    // error.type attr already says it (never two competing presentations —
    // attr-backed display wins as the established shape); a message snippet
    // (80 chars) appends whenever present; full frames live in --json only.
    const errorBits: string[] = []
    if (span.status === "error") {
      errorBits.push(span.errorType !== undefined && !("error.type" in span.attrs) ? `error ${span.errorType}` : "error")
      if (span.errorMessage !== undefined && span.errorMessage.length > 0) {
        errorBits.push(`"${span.errorMessage.length > 80 ? `${span.errorMessage.slice(0, 80)}…` : span.errorMessage}"`)
      }
    }
    const statusText = errorBits.length > 0 ? errorBits.join(" ") : span.status
    lines.push(
      `${"  ".repeat(node.depth)}[${span.service}] ${span.name} ${offsetMs}ms +${formatDur(span.durMs)} ${statusText}${attrs}${node.orphan ? " (no root)" : ""}`,
    )
  }
  if (tree.truncated) lines.push(`…[truncated: ${tree.dropped} spans]…`)
  return lines.join("\n")
}

export const runTrace = async (options: TraceRunOptions): Promise<TraceRunResult> => {
  const json = options.json === true
  const ok = (stdout: string): TraceRunResult => ({ code: 0, stdout, stderr: "" })
  const fail = (code: number, stderr: string): TraceRunResult => ({ code, stdout: "", stderr })
  // Single clock (injectable for the deterministic window envelope).
  const now = options.now ?? Date.now()
  const traceWindow = sinceWindow(options.since, options.sinceMs ?? null, now)

  const rawId = options.traceId
  let idFilter: string | null = null
  if (rawId !== undefined) {
    const id = rawId.toLowerCase()
    if (id.length < 8 || id.length > 32 || !HEX_ID.test(id)) {
      return fail(2, "ow: invalid trace id")
    }
    idFilter = id
  }

  if (!existsSync(join(options.rootDir, ".ow"))) {
    return ok(json ? quietJson(traceWindow) : `no traces (${noStateNote(options.searchStart ?? options.rootDir)})`)
  }

  try {
    const text = readFileSync(options.owYamlPath, "utf8")
    const parsed = parseUpFile(text)
    if (parsed.trace === undefined) {
      return ok(json ? quietJson(traceWindow) : "tracing off (no trace: block in ow.yaml)")
    }
    if (!parsed.trace.enabled) {
      return ok(json ? quietJson(traceWindow) : "tracing off (trace disabled)")
    }
  } catch {
    return ok(json ? quietJson(traceWindow) : "tracing off (no trace: block in ow.yaml)")
  }

  let stored: TraceSpan[]
  const spansFile = tracePaths(options.rootDir).spansFile
  try {
    stored = (await readSpansFile(spansFile)).spans
  } catch (error) {
    return fail(1, `ow: traces unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
  }

  // `--wait`: poll until a newly arriving span matching the current filter
  // (trace id / service / since) shows up, then render once. Unconfigured
  // and unreadable states return immediately above; an expired deadline
  // renders current state with an honest stderr line (exit 0 — waiting is
  // not failure). The since cutoff freezes at entry so aging traces cannot
  // spuriously trip the "new arrival" signature mid-wait.
  const waitMs = clampNumber(options.waitMs, { integer: false, min: 0, max: TRACE_WAIT_MAX_MS }, 0)
  const sinceCutoff = options.sinceMs != null ? now - options.sinceMs : null
  const matchingSignature = (rows: TraceSpan[]): string => {
    const summaries = [...groupSpansByTrace(rows)].map(([traceId, spans]) => summarizeTrace(traceId, spans))
    summaries.sort(byRecency)
    let relevant = summaries
    if (idFilter !== null) {
      relevant = relevant.filter((summary) => summary.traceId.startsWith(idFilter as string))
    } else {
      if (sinceCutoff !== null) {
        relevant = relevant.filter((summary) => Number(summary.lastEnd / 1_000_000n) >= sinceCutoff)
      }
      if (options.service !== undefined && options.service !== "") {
        relevant = relevant.filter((summary) => summary.services.includes(options.service as string))
      }
    }
    return relevant.map((summary) => `${summary.traceId}:${summary.spans}:${summary.lastEnd}`).join("|")
  }
  let waitExpired = false
  if (waitMs > 0) {
    const before = matchingSignature(stored)
    const deadline = Date.now() + waitMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        waitExpired = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(TRACE_WAIT_POLL_MS, remaining)))
      try {
        const rows = (await readSpansFile(spansFile)).spans
        if (matchingSignature(rows) !== before) {
          stored = rows
          break
        }
      } catch {
        // transient read failure: keep polling until the deadline
      }
    }
    if (waitExpired) {
      try {
        stored = (await readSpansFile(spansFile)).spans
      } catch {
        // render the last good read below
      }
    }
  }
  // Human-only per-verb cutoff notice (post-read renders only — the
  // unconfigured exits above stay exactly quiet).
  const windowNote = !json && traceWindow !== null ? windowNotice(traceWindow) : ""
  const done = (stdout: string): TraceRunResult => {
    if (!waitExpired) return windowNote.length > 0 ? { code: 0, stdout, stderr: windowNote } : ok(stdout)
    return { code: 0, stdout, stderr: ["warning: wait expired (no new spans)", windowNote].filter((line) => line.length > 0).join("\n") }
  }

  if (selectValidSpans(stored).length === 0) {
    // FALSE-EMPTY split: the store itself holds no valid spans (true
    // empty, human string unchanged); filter empties split below.
    return done(json ? quietStoreJson(stored.length, stored.length === 0 ? "empty-store" : "no-valid-spans", traceWindow) : "no traces (no spans yet)")
  }

  const groups = groupSpansByTrace(stored)
  const all = [...groups].map(([traceId, spans]) => summarizeTrace(traceId, spans))
  all.sort(byRecency)

  if (idFilter !== null) {
    const matches = all.filter((summary) => summary.traceId.startsWith(idFilter as string))
    if (matches.length === 0) return fail(1, `ow: trace not found: ${rawId}`)
    if (matches.length > 1) {
      return fail(2, `ow: multiple traces matched (${matches.length} candidates, narrow the prefix)`)
    }
    const summary = matches[0]
    const spans = groups.get(summary.traceId) ?? []
    if (json) {
      const tree = buildTraceTree(spans)
      return done(
        JSON.stringify({
          trace: summary.traceId,
          spans: tree.nodes.map((node) => ({ ...node.span, depth: node.depth })),
          truncated: tree.truncated,
          returned: tree.nodes.length,
          total: spans.length,
          window: traceWindow,
        }),
      )
    }
    return done(formatTreeView(summary, spans))
  }

  let listed = all
  if (options.sinceMs != null) {
    const cutoff = now - options.sinceMs
    listed = listed.filter((summary) => Number(summary.lastEnd / 1_000_000n) >= cutoff)
  }
  if (options.service !== undefined && options.service !== "") {
    listed = listed.filter((summary) => summary.services.includes(options.service as string))
  }
  // LIST NOISE: the list is "interesting first", not "everything". By
  // default only parentless ok/unset singletons hide (SQL-orphan noise);
  // `--min-spans 1` restores show-all, `--min-spans N` keeps ≥N-span
  // traces. Error traces always render regardless. Exact-ID tree lookups
  // above never filter. A lone span whose parent is set-but-absent
  // (dangling continuity) still renders — only true roots hide.
  const minSpans = clampNumber(options.minSpans, { integer: true, min: 1, max: Number.POSITIVE_INFINITY }, undefined)
  if (minSpans === undefined) {
    listed = listed.filter((summary) => {
      if (summary.spans !== 1 || summary.status === "error") return true
      const spans = groups.get(summary.traceId) ?? []
      return spans.length !== 1 || spans[0].parentSpanId !== null
    })
  } else if (minSpans > 1) {
    listed = listed.filter((summary) => summary.spans >= minSpans || summary.status === "error")
  }
  // Defense-in-depth for programmatic callers (CLI parsing already bounds
  // --tail to 1-5000): a non-integer tail falls back to the default instead
  // of slicing to an empty page.
  const tail = clampNumber(options.tail, { integer: true, min: 1, max: Number.POSITIVE_INFINITY }, TRACE_LIST_DEFAULT_TAIL)
  const page = listed.slice(0, tail)
  if (json) return done(toListJson(page, page.length, listed.length, traceWindow))
  // FALSE-EMPTY split: valid spans exist but every filter hid them — name
  // the stored count instead of claiming nothing exists yet.
  if (page.length === 0) return done(`no traces (no matches; ${selectValidSpans(stored).length} spans stored)`)
  const lines = page.map((summary) => formatListLine(summary, now))
  if (listed.length > page.length) lines.push(`(omitted: ${listed.length - page.length} older traces (raise --tail))`)
  return done(lines.join("\n"))
}

export type TraceDoctorCheck = { ok: boolean; detail: string }

/** Short bounded liveness probe for the doctor line: one TCP connect to the
 * configured port with an explicit timeout, socket destroyed on settle, no
 * retries — doctor must never hang on this. Any error (refused, timeout,
 * unreachable) resolves false; the function never throws. */
/* The probe target is ALWAYS loopback: the receiver only ever binds
 * TRACE_BIND_HOST (127.0.0.1), so a remote host is never probed here. */
export const TRACE_PROBE_TIMEOUT_MS = 500

export const isTracePortListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    let done = false
    let socket: ReturnType<typeof connect> | null = null
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        // already closed
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), TRACE_PROBE_TIMEOUT_MS)
    try {
      socket = connect({ host: "127.0.0.1", port })
    } catch {
      finish(false)
      return
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
  })

/** Informational only: excluded from the `ow doctor` exit rule like `up`. */
export const checkTraceDoctor = async (rootDir: string): Promise<TraceDoctorCheck> => {
  let enabled = false
  let port = TRACE_DEFAULT_PORT
  let services: { cmd?: string | string[]; env?: Readonly<Record<string, string>> }[] = []
  try {
    const parsed = parseUpFile(readFileSync(join(rootDir, "ow.yaml"), "utf8"))
    if (parsed.trace !== undefined && parsed.trace.enabled) {
      enabled = true
      port = parsed.trace.port
      services = parsed.services
    }
  } catch {
    enabled = false
  }
  if (!enabled) return { ok: false, detail: "off (no trace: in ow.yaml)" }
  const listening = await isTracePortListening(port)
  // Static directive only; the port number is operator-configured. Appended
  // to whichever enabled-state line was computed — a listening receiver
  // keeps its exact historical wording (locked by test).
  const silentSuffix = listening
    ? ""
    : `. hint: receiver :${port} not listening — another process may hold the port or the receiver failed to start`
  let count = 0
  let lastEnd: bigint | null = null
  let unnamed = false
  try {
    for (const span of selectValidSpans((await readSpansFile(tracePaths(rootDir).spansFile)).spans)) {
      count += 1
      if (span.service === "unknown") unnamed = true
      const end = BigInt(span.endNano)
      if (lastEnd === null || end > lastEnd) lastEnd = end
    }
  } catch {
    count = 0
    lastEnd = null
    unnamed = false
  }
  // The jar note is a silence diagnostic for Java setups only: spans flowing
  // means the pipeline works, so an open report never carries the jar note.
  // Java use is detected from ow.yaml services OR the inherited environment
  // (D4 forbids injection, but the operator's own exported
  // JAVA_TOOL_OPTIONS still counts as Java use for this diagnostic).
  const jarMissing = !existsSync(join(rootDir, ".ow", "otel", "opentelemetry-javaagent.jar"))
  const javaInvolved = services.some(usesJavaAgent) || (process.env.JAVA_TOOL_OPTIONS?.includes("javaagent") ?? false)
  if (count === 0 && jarMissing && javaInvolved) {
    return { ok: false, detail: `no javaagent jar (.ow/otel/opentelemetry-javaagent.jar)${silentSuffix}` }
  }
  if (count === 0 || lastEnd === null) {
    return { ok: true, detail: `open (port ${port}, 0 spans retained). hint: no spans — is the service up? ow ps${silentSuffix}` }
  }
  const agoMs = Math.max(0, Date.now() - Number(lastEnd / 1_000_000n))
  const open = `open (port ${port}, ${count} spans retained, last span ${formatAgo(agoMs)})${silentSuffix}`
  // Sibling of the 0-span hint: a stored `unknown` service means the
  // exporter never sent `service.name`. Static text only, same pattern.
  // The two hints never co-fire (unnamed needs ≥1 span by construction).
  return unnamed
    ? { ok: true, detail: `${open}. hint: unnamed spans present — OTEL_SERVICE_NAME may be unset` }
    : { ok: true, detail: open }
}

/** True when a service launches through the Java agent (recipe `env:`). */
const usesJavaAgent = (service: { cmd?: string | string[]; env?: Readonly<Record<string, string>> }): boolean => {
  const cmd = Array.isArray(service.cmd) ? service.cmd.join(" ") : (service.cmd ?? "")
  if (cmd.includes("javaagent") || cmd.includes("JAVA_TOOL_OPTIONS")) return true
  const env = service.env ?? {}
  if ("JAVA_TOOL_OPTIONS" in env) return true
  return Object.values(env).some((value) => value.includes("javaagent"))
}
