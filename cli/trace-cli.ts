/** `ow trace` command: list recent traces or render one parent/child tree,
 * plus the informational `doctor` trace line. Quiet-when-unconfigured is
 * exit 0 with the plan-pinned strings; usage errors exit 2; structural
 * (read/resolve) failures exit 1 with a bounded one-line message — never a
 * stack dump. `--service` filters the list only; it never prunes a tree. */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { TraceSpan } from "./trace-otlp"
import { readSpansFile, tracePaths } from "./trace-store"
import {
  buildTraceTree,
  formatAgo,
  formatDur,
  groupSpansByTrace,
  selectValidSpans,
  summarizeTrace,
  type TraceSummary,
} from "./trace-query"
import { parseUpFile } from "./up-schema"
import { noStateNote } from "./up-state"

export const TRACE_LIST_DEFAULT_TAIL = 20

/** `--wait` polling discipline: 500 ms steps, 5-minute ceiling. */
export const TRACE_WAIT_POLL_MS = 500
export const TRACE_WAIT_MAX_MS = 300_000

/** `--wait` durations: `<amount>s|m|h|d|w` within (0, 5m]. Null when unusable. */
export const parseWaitDuration = (raw: string): number | null => {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(raw.trim())
  if (!match) return null
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "s" | "m" | "h" | "d" | "w"]
  const ms = Number(match[1]) * unitMs
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > TRACE_WAIT_MAX_MS) return null
  return ms
}

const HEX_ID = /^[0-9a-fA-F]+$/

export type TraceRunOptions = {
  rootDir: string
  owYamlPath: string
  traceId?: string
  tail?: number
  sinceMs?: number | null
  service?: string
  json?: boolean
  /** Poll `spans.jsonl` this long for a newly arriving matching span before
   * rendering once. Programmatic milliseconds; the CLI bounds `--wait` to
   * (0, 5m] and clamps anything else here. */
  waitMs?: number
  /** Directory the upward `.ow/` search started from (defaults to rootDir).
   * Names the searched reality in the honest-empty message only. */
  searchStart?: string
}

export type TraceRunResult = { code: number; stdout: string; stderr: string }

const quietJson = (): string => JSON.stringify({ traces: [] })

const toListJson = (summaries: TraceSummary[]): string =>
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
  })

const formatListLine = (summary: TraceSummary, now: number): string => {
  const agoMs = Math.max(0, now - Number(summary.lastEnd / 1_000_000n))
  return [
    summary.traceId.slice(0, 8),
    formatAgo(agoMs),
    summary.root,
    `${summary.services.length} servis`,
    `${summary.spans} span`,
    formatDur(summary.durMs),
    summary.status === "error" ? "✗" : "✓",
  ].join("  ")
}

const formatTreeView = (summary: TraceSummary, spans: TraceSpan[]): string => {
  const tree = buildTraceTree(spans)
  const lines = [
    `izleme ${summary.traceId.slice(0, 12)}...  ${summary.spans} span, ${summary.services.length} servis, ${formatDur(summary.durMs)}`,
  ]
  for (const node of tree.nodes) {
    const span = node.span
    const offsetMs = Number((BigInt(span.startNano) - summary.firstStart) / 1_000_000n)
    const attrs = Object.entries(span.attrs)
      .map(([key, value]) => ` ${key}=${value}`)
      .join("")
    lines.push(
      `${"  ".repeat(node.depth)}[${span.service}] ${span.name} ${offsetMs}ms +${formatDur(span.durMs)} ${span.status}${attrs}${node.orphan ? " (kök yok)" : ""}`,
    )
  }
  if (tree.truncated) lines.push(`…[kesildi: ${tree.dropped} span]…`)
  return lines.join("\n")
}

export const runTrace = async (options: TraceRunOptions): Promise<TraceRunResult> => {
  const json = options.json === true
  const ok = (stdout: string): TraceRunResult => ({ code: 0, stdout, stderr: "" })
  const fail = (code: number, stderr: string): TraceRunResult => ({ code, stdout: "", stderr })

  const rawId = options.traceId
  let idFilter: string | null = null
  if (rawId !== undefined) {
    const id = rawId.toLowerCase()
    if (id.length < 8 || id.length > 32 || !HEX_ID.test(id)) {
      return fail(2, "ow: geçersiz izleme kimliği")
    }
    idFilter = id
  }

  if (!existsSync(join(options.rootDir, ".ow"))) {
    return ok(json ? quietJson() : `izleme yok (${noStateNote(options.searchStart ?? options.rootDir)})`)
  }

  try {
    const text = readFileSync(options.owYamlPath, "utf8")
    const parsed = parseUpFile(text)
    if (parsed.trace === undefined) {
      return ok(json ? quietJson() : "izleme kapalı (ow.yaml içinde trace: bloğu yok)")
    }
    if (!parsed.trace.enabled) {
      return ok(json ? quietJson() : "izleme kapalı (trace devre dışı bırakılmış)")
    }
  } catch {
    return ok(json ? quietJson() : "izleme kapalı (ow.yaml içinde trace: bloğu yok)")
  }

  let stored: TraceSpan[]
  const spansFile = tracePaths(options.rootDir).spansFile
  try {
    stored = (await readSpansFile(spansFile)).spans
  } catch (error) {
    return fail(1, `ow: izleme okunamıyor: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
  }

  // `--wait`: poll until a newly arriving span matching the current filter
  // (trace id / service / since) shows up, then render once. Unconfigured
  // and unreadable states return immediately above; an expired deadline
  // renders current state with an honest stderr line (exit 0 — waiting is
  // not failure). The since cutoff freezes at entry so aging traces cannot
  // spuriously trip the "new arrival" signature mid-wait.
  const waitMs =
    typeof options.waitMs === "number" && Number.isFinite(options.waitMs) && options.waitMs > 0
      ? Math.min(options.waitMs, TRACE_WAIT_MAX_MS)
      : 0
  const sinceCutoff = options.sinceMs != null ? Date.now() - options.sinceMs : null
  const matchingSignature = (rows: TraceSpan[]): string => {
    const summaries = [...groupSpansByTrace(rows)].map(([traceId, spans]) => summarizeTrace(traceId, spans))
    summaries.sort((a, b) =>
      a.lastEnd > b.lastEnd ? -1 : a.lastEnd < b.lastEnd ? 1 : a.traceId < b.traceId ? -1 : 1,
    )
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
  const done = (stdout: string): TraceRunResult =>
    waitExpired ? { code: 0, stdout, stderr: "uyarı: bekleme süresi doldu (yeni span gelmedi)" } : ok(stdout)

  if (selectValidSpans(stored).length === 0) {
    return done(json ? quietJson() : "izleme yok (henüz span gelmedi)")
  }

  const groups = groupSpansByTrace(stored)
  const now = Date.now()
  const all = [...groups].map(([traceId, spans]) => summarizeTrace(traceId, spans))
  all.sort((a, b) =>
    a.lastEnd > b.lastEnd ? -1 : a.lastEnd < b.lastEnd ? 1 : a.traceId < b.traceId ? -1 : 1,
  )

  if (idFilter !== null) {
    const matches = all.filter((summary) => summary.traceId.startsWith(idFilter as string))
    if (matches.length === 0) return fail(1, `ow: izleme bulunamadı: ${rawId}`)
    if (matches.length > 1) {
      return fail(2, `ow: birden fazla izleme eşleşti (${matches.length} aday, öneki daraltın)`)
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
  // Defense-in-depth for programmatic callers (CLI parsing already bounds
  // --tail to 1-5000): a non-integer tail falls back to the default instead
  // of slicing to an empty page.
  const tail = typeof options.tail === "number" && Number.isInteger(options.tail) ? Math.max(1, options.tail) : TRACE_LIST_DEFAULT_TAIL
  const page = listed.slice(0, tail)
  if (json) return done(toListJson(page))
  if (page.length === 0) return done("izleme yok (henüz span gelmedi)")
  return done(page.map((summary) => formatListLine(summary, now)).join("\n"))
}

export type TraceDoctorCheck = { ok: boolean; detail: string }

/** Informational only: excluded from the `ow doctor` exit rule like `up`. */
export const checkTraceDoctor = async (rootDir: string): Promise<TraceDoctorCheck> => {
  let enabled = false
  let port = 4319
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
  if (!enabled) return { ok: false, detail: "kapalı (ow.yaml içinde trace: yok)" }
  let count = 0
  let lastEnd: bigint | null = null
  let unnamed = false
  try {
    for (const span of selectValidSpans((await readSpansFile(tracePaths(rootDir).spansFile)).spans)) {
      count += 1
      if (span.service === "bilinmeyen") unnamed = true
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
    return { ok: false, detail: "javaagent jar yok (.ow/otel/opentelemetry-javaagent.jar)" }
  }
  if (count === 0 || lastEnd === null) {
    return { ok: true, detail: `açık (port ${port}, 0 span). ipucu: span yok — servis ayakta mı? ow ps` }
  }
  const agoMs = Math.max(0, Date.now() - Number(lastEnd / 1_000_000n))
  const open = `açık (port ${port}, ${count} span, son span ${formatAgo(agoMs)})`
  // Sibling of the 0-span hint: a stored `bilinmeyen` service means the
  // exporter never sent `service.name`. Static text only, same pattern.
  // The two hints never co-fire (unnamed needs ≥1 span by construction).
  return unnamed
    ? { ok: true, detail: `${open}. ipucu: isimsiz span var — OTEL_SERVICE_NAME ayarlanmamış olabilir` }
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
