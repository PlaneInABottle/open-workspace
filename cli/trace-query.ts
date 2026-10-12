/** `ow trace` read model: group stored spans into traces, summarize for the
 * list view, and assemble parent/child trees. Pure logic over `TraceSpan`
 * rows — no console, no process exit. All bounds live here: malformed rows
 * are filtered (never throw), tree rendering is capped newest-friendly.
 *
 * Read-path secret rule: stored values are printed verbatim because the
 * writer already sanitized them (S1–S5); this module adds no raw-body,
 * header, or env capture of its own. */

import type { TraceSpan } from "./trace-otlp"

/** Render cap for one `ow trace <id>` tree (plan-fixed). */
export const TRACE_RENDER_MAX_SPANS = 2000

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/
const NANO = /^[0-9]+$/

/** Loose hex run for CLI id/prefix validation (shared by trace + timeline). */
export const HEX_ID = /^[0-9a-fA-F]+$/

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === "string")
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

/** Rows the writer contract guarantees. Anything else (hand-edited,
 * foreign, or truncated rows) is skipped so one bad line can never crash
 * a query with a stack dump. Repeated exporter retransmits can store one
 * `spanId` twice within a trace: first occurrence per `traceId:spanId`
 * wins, so row counts and the emitted set below always agree and the cap
 * marker stays honest — while a spanId reused by a DIFFERENT trace still
 * renders fully (M1). The additive-optional exception fields (`errorType`,
 * `errorMessage`, `errorFrames`) pass through untouched when absent, and
 * are shape-checked when present, so old rows parse exactly as before. */
export const selectValidSpans = (spans: TraceSpan[]): TraceSpan[] => {
  const seen = new Set<string>()
  return spans.filter((span) => {
    const valid =
      typeof span === "object" &&
      span !== null &&
      HEX32.test(span.traceId) &&
      HEX16.test(span.spanId) &&
      (span.parentSpanId === null || HEX16.test(span.parentSpanId)) &&
      typeof span.service === "string" &&
      typeof span.name === "string" &&
      typeof span.kind === "string" &&
      NANO.test(span.startNano) &&
      NANO.test(span.endNano) &&
      typeof span.durMs === "number" &&
      Number.isFinite(span.durMs) &&
      (span.status === "unset" || span.status === "ok" || span.status === "error") &&
      typeof span.t === "string" &&
      isStringRecord(span.attrs) &&
      (span.errorType === undefined || typeof span.errorType === "string") &&
      (span.errorMessage === undefined || typeof span.errorMessage === "string") &&
      (span.errorFrames === undefined || isStringArray(span.errorFrames))
    const identity = `${span.traceId}:${span.spanId}`
    if (!valid || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export const groupSpansByTrace = (spans: TraceSpan[]): Map<string, TraceSpan[]> => {
  const groups = new Map<string, TraceSpan[]>()
  for (const span of selectValidSpans(spans)) {
    const list = groups.get(span.traceId)
    if (list) list.push(span)
    else groups.set(span.traceId, [span])
  }
  return groups
}

export type TraceSummary = {
  traceId: string
  root: string
  services: string[]
  spans: number
  durMs: number
  startedAt: string
  status: "ok" | "error"
  firstStart: bigint
  lastEnd: bigint
}

const compareSpans = (a: TraceSpan, b: TraceSpan): number => {
  const startA = BigInt(a.startNano)
  const startB = BigInt(b.startNano)
  if (startA < startB) return -1
  if (startA > startB) return 1
  return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0
}

export const summarizeTrace = (traceId: string, spans: TraceSpan[]): TraceSummary => {
  let firstStart: bigint | null = null
  let lastEnd: bigint | null = null
  let error = false
  const services = new Set<string>()
  for (const span of spans) {
    const start = BigInt(span.startNano)
    const end = BigInt(span.endNano)
    if (firstStart === null || start < firstStart) firstStart = start
    if (lastEnd === null || end > lastEnd) lastEnd = end
    if (span.status === "error") error = true
    services.add(span.service)
  }
  const start = firstStart ?? 0n
  const end = lastEnd ?? 0n
  const ids = new Set(spans.map((span) => span.spanId))
  const roots = spans.filter((span) => span.parentSpanId === null || !ids.has(span.parentSpanId)).sort(compareSpans)
  const rootSpan = roots.length > 0 ? roots[0] : [...spans].sort(compareSpans)[0]
  return {
    traceId,
    root: rootSpan?.name ?? "",
    services: [...services].sort(),
    spans: spans.length,
    durMs: end >= start ? Number(end - start) / 1e6 : 0,
    startedAt: new Date(Number(start / 1_000_000n)).toISOString(),
    status: error ? "error" : "ok",
    firstStart: start,
    lastEnd: end,
  }
}

export type TraceTreeNode = { span: TraceSpan; depth: number; orphan: boolean }

/** Parent/child assembly, exact-`traceId` only (no cross-trace leakage):
 * - spans whose parent is absent are orphan roots at depth 0 (never dropped);
 * - parent cycles break by first-seen-wins (the repeated edge is not
 *   re-descended, so rendering always terminates);
 * - siblings order by `startNano`;
 * - emission stops at `maxNodes`; the remainder counts as dropped. */
export const buildTraceTree = (
  spans: TraceSpan[],
  maxNodes: number = TRACE_RENDER_MAX_SPANS,
): { nodes: TraceTreeNode[]; truncated: boolean; dropped: number } => {
  const valid = selectValidSpans(spans)
  const byId = new Map(valid.map((span) => [span.spanId, span]))
  const children = new Map<string, TraceSpan[]>()
  const roots: TraceSpan[] = []
  for (const span of valid) {
    const parent = span.parentSpanId
    if (parent === null || !byId.has(parent)) {
      roots.push(span)
    } else {
      const list = children.get(parent)
      if (list) list.push(span)
      else children.set(parent, [span])
    }
  }
  for (const list of children.values()) list.sort(compareSpans)
  const nodes: TraceTreeNode[] = []
  const emitted = new Set<string>()
  const onPath = new Set<string>()
  let stopped = false
  type Frame = { span: TraceSpan; depth: number; orphan: boolean; childIndex: number; entered: boolean }
  // Iterative preorder: tree depth is unbounded input (a 20k-deep chain must
  // not overflow the call stack), so the on-path cycle set is managed on an
  // explicit stack instead of recursion.
  const stack: Frame[] = []
  const push = (span: TraceSpan, depth: number, orphan: boolean): void => {
    if (!stopped && !emitted.has(span.spanId)) {
      stack.push({ span, depth, orphan, childIndex: 0, entered: false })
    }
  }
  const drain = (): void => {
    while (stack.length > 0 && !stopped) {
      const frame = stack[stack.length - 1]
      if (!frame.entered) {
        frame.entered = true
        if (nodes.length >= maxNodes) {
          stopped = true
          break
        }
        nodes.push({ span: frame.span, depth: frame.depth, orphan: frame.orphan })
        emitted.add(frame.span.spanId)
        onPath.add(frame.span.spanId)
      }
      const kids = children.get(frame.span.spanId) ?? []
      while (
        frame.childIndex < kids.length &&
        (emitted.has(kids[frame.childIndex].spanId) || onPath.has(kids[frame.childIndex].spanId))
      ) {
        frame.childIndex += 1
      }
      if (frame.childIndex < kids.length) {
        const child = kids[frame.childIndex]
        frame.childIndex += 1
        stack.push({ span: child, depth: frame.depth + 1, orphan: false, childIndex: 0, entered: false })
      } else {
        onPath.delete(frame.span.spanId)
        stack.pop()
      }
    }
  }
  const orderedRoots = [...roots].sort(compareSpans)
  if (orderedRoots.length === 0 && valid.length > 0) {
    const earliest = [...valid].sort(compareSpans)[0]
    push(earliest, 0, true)
    drain()
  } else {
    for (const root of orderedRoots) {
      push(root, 0, root.parentSpanId !== null)
      drain()
      if (stopped) break
    }
  }
  if (!stopped) {
    for (const span of [...valid].sort(compareSpans)) {
      if (!emitted.has(span.spanId)) {
        push(span, 0, true)
        drain()
      }
      if (stopped) break
    }
  }
  const dropped = valid.length - emitted.size
  return { nodes, truncated: dropped > 0, dropped }
}

/** Delegated wording: compact durations (`412ms`, `12.4ms`, `1.2s`). */
export const formatDur = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) {
    const rounded = Math.round(ms * 10) / 10
    return `${rounded}ms`
  }
  return `${Math.round((ms / 1000) * 10) / 10}s`
}

/** Delegated wording: compact recency (`4s ago`, `3m ago`). */
export const formatAgo = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
