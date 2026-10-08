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

export const TRACE_LIST_DEFAULT_TAIL = 20

const HEX_ID = /^[0-9a-fA-F]+$/

export type TraceRunOptions = {
  rootDir: string
  owYamlPath: string
  traceId?: string
  tail?: number
  sinceMs?: number | null
  service?: string
  json?: boolean
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
    return ok(json ? quietJson() : "izleme yok (.ow/ bulunamadı)")
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
  try {
    stored = (await readSpansFile(tracePaths(options.rootDir).spansFile)).spans
  } catch (error) {
    return fail(1, `ow: izleme okunamıyor: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
  }
  if (selectValidSpans(stored).length === 0) {
    return ok(json ? quietJson() : "izleme yok (henüz span gelmedi)")
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
      return ok(
        JSON.stringify({
          trace: summary.traceId,
          spans: tree.nodes.map((node) => ({ ...node.span, depth: node.depth })),
          truncated: tree.truncated,
        }),
      )
    }
    return ok(formatTreeView(summary, spans))
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
  if (json) return ok(toListJson(page))
  if (page.length === 0) return ok("izleme yok (henüz span gelmedi)")
  return ok(page.map((summary) => formatListLine(summary, now)).join("\n"))
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
  try {
    for (const span of selectValidSpans((await readSpansFile(tracePaths(rootDir).spansFile)).spans)) {
      count += 1
      const end = BigInt(span.endNano)
      if (lastEnd === null || end > lastEnd) lastEnd = end
    }
  } catch {
    count = 0
    lastEnd = null
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
  if (count === 0 || lastEnd === null) return { ok: true, detail: `açık (port ${port}, 0 span)` }
  const agoMs = Math.max(0, Date.now() - Number(lastEnd / 1_000_000n))
  return { ok: true, detail: `açık (port ${port}, ${count} span, son span ${formatAgo(agoMs)})` }
}

/** True when a service launches through the Java agent (recipe `env:`). */
const usesJavaAgent = (service: { cmd?: string | string[]; env?: Readonly<Record<string, string>> }): boolean => {
  const cmd = Array.isArray(service.cmd) ? service.cmd.join(" ") : (service.cmd ?? "")
  if (cmd.includes("javaagent") || cmd.includes("JAVA_TOOL_OPTIONS")) return true
  const env = service.env ?? {}
  if ("JAVA_TOOL_OPTIONS" in env) return true
  return Object.values(env).some((value) => value.includes("javaagent"))
}
