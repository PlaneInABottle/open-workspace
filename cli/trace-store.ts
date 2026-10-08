/** Trace span persistence under `<root>/.ow/traces/spans.jsonl`.
 * Append-mostly JSONL with newest-wins rotation, mirroring the `up-logs`
 * discipline (tail/compact shape, atomic tmp+rename, `0600`), behind the
 * real-directory/regular-file symlink guard: a symlinked `traces/` dir or
 * `spans.jsonl` refuses the trace subsystem instead of following the link.
 * No migration — the file is disposable telemetry; rollback = delete it. */

import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { TraceSpan } from "./trace-otlp"

export const TRACE_DEFAULT_PORT = 4319
export const TRACE_BIND_HOST = "127.0.0.1"
export const TRACE_MAX_BODY_BYTES = 4 * 1024 * 1024
export const TRACE_MAX_INFLATED_BYTES = 8 * 1024 * 1024
export const TRACE_MAX_BYTES = 5 * 1024 * 1024
export const TRACE_MAX_SPANS = 20_000
export const TRACE_ATTR_MAX_COUNT = 16
export const TRACE_ATTR_VALUE_MAX_BYTES = 256
export const TRACE_NAME_MAX_BYTES = 256

export const tracePaths = (rootDir: string) => ({
  tracesDir: join(rootDir, ".ow", "traces"),
  spansFile: join(rootDir, ".ow", "traces", "spans.jsonl"),
})

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

/** `0700` real directory, symlink-rejected (mirrors `ensureUpStateDir`). */
export const ensureTracesDir = async (tracesDir: string): Promise<void> => {
  await mkdir(tracesDir, { recursive: true, mode: 0o700 })
  const info = await lstat(tracesDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(".ow/traces gerçek bir dizin olmalı")
  await chmod(tracesDir, 0o700)
}

/** Regular file, symlink-rejected (mirrors the `up-logs` `readTail`
 * guard); missing file is fine (created on first flush). */
export const assertSpansFileRegular = async (spansFile: string): Promise<void> => {
  let info
  try {
    info = await lstat(spansFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("spans.jsonl normal dosya olmalı")
}

const readTail = async (path: string, maxBytes: number): Promise<{ text: string; size: number; truncated: boolean }> => {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("spans.jsonl normal dosya olmalı")
    const bytesToRead = Math.min(info.size, maxBytes)
    const offset = info.size - bytesToRead
    const file = await open(path, "r")
    try {
      const buffer = Buffer.alloc(bytesToRead)
      await file.read(buffer, 0, bytesToRead, offset)
      const content = buffer.toString("utf8")
      if (offset === 0) return { text: content, size: info.size, truncated: false }
      const firstLineEnd = content.indexOf("\n")
      return { text: firstLineEnd < 0 ? "" : content.slice(firstLineEnd + 1), size: info.size, truncated: true }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", size: 0, truncated: false }
    throw error
  }
}

const lineCount = (text: string): number => {
  if (!text) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

/** Newest-wins compact: keep the most recent whole lines fitting the caps. */
const fitRecentLines = (text: string, maxBytes: number, maxLines: number): string => {
  const lines = text.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1)
  const retained: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0 && retained.length < maxLines; index -= 1) {
    const line = lines[index]
    const lineBytes = byteLength(line) + 1
    if (lineBytes > maxBytes) continue
    if (bytes + lineBytes > maxBytes) break
    retained.push(line)
    bytes += lineBytes
  }
  return retained.reverse().join("\n") + (retained.length > 0 ? "\n" : "")
}

const replaceSpans = async (path: string, text: string): Promise<void> => {
  const temporary = join(dirname(path), `.ow-trace-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export type TraceStoreLimits = { maxBytes?: number; maxSpans?: number }

/** Non-blocking span writer: appends accumulate into an in-memory batch and
 * flush as one write step; over-cap batches compact newest-wins. Never
 * throws out of `append` — the receiver hot path must not break.
 *
 * SINGLETON REQUIREMENT: one store instance owns one spans file. Two
 * instances read-modify-write the same file blindly — the loser's
 * compaction rewrites the winner's rows away. The re-stat guard below turns
 * that race into transient oversize instead of loss, but shared files are
 * still a bug: one supervisor, one receiver, one store. */
export const createTraceStore = (spansFile: string, limits: TraceStoreLimits = {}) => {
  const state = {
    chain: Promise.resolve(),
    scheduled: false,
    pending: [] as string[],
    bytes: 0,
    lines: 0,
    initialized: false,
    maxBytes: Math.max(1, limits.maxBytes ?? TRACE_MAX_BYTES),
    maxSpans: Math.max(1, limits.maxSpans ?? TRACE_MAX_SPANS),
  }

  const initialize = async (): Promise<void> => {
    if (state.initialized) return
    await ensureTracesDir(dirname(spansFile))
    await assertSpansFileRegular(spansFile)
    const current = await readTail(spansFile, state.maxBytes)
    let text = current.text
    if (current.truncated || current.size > state.maxBytes || lineCount(text) > state.maxSpans) {
      text = fitRecentLines(text, state.maxBytes, state.maxSpans)
      await replaceSpans(spansFile, text)
    } else if (current.size > 0) {
      await chmod(spansFile, 0o600).catch(() => undefined)
    }
    state.bytes = byteLength(text)
    state.lines = lineCount(text)
    state.initialized = true
  }

  const appendText = async (text: string, textBytes: number, rowCount: number): Promise<void> => {
    const file = await open(spansFile, "a", 0o600)
    try {
      await file.writeFile(text, "utf8")
    } finally {
      await file.close()
    }
    await chmod(spansFile, 0o600).catch(() => undefined)
    state.bytes += textBytes
    state.lines += rowCount
  }

  const writeBatch = async (rows: string[]): Promise<void> => {
    await initialize()
    const text = rows.join("")
    const textBytes = byteLength(text)
    if (state.bytes + textBytes > state.maxBytes || state.lines + rows.length > state.maxSpans) {
      const current = await readTail(spansFile, state.maxBytes)
      // Defensive re-stat: another writer may have appended concurrently
      // (see singleton requirement above). Compacting from a stale view
      // would rewrite its rows away, so on any size drift skip compaction
      // this round — append-only oversize beats data loss — and resync the
      // byte counter (line accounting stays approximate until the next
      // clean compact recounts the actual file).
      if (current.size !== state.bytes) {
        await appendText(text, textBytes, rows.length)
        state.bytes = current.size + textBytes
        return
      }
      const compacted = fitRecentLines(`${current.text}${text}`, state.maxBytes, state.maxSpans)
      await replaceSpans(spansFile, compacted)
      state.bytes = byteLength(compacted)
      state.lines = lineCount(compacted)
      return
    }
    await appendText(text, textBytes, rows.length)
  }

  const flushScheduled = async (): Promise<void> => {
    const rows = state.pending
    state.pending = []
    if (rows.length === 0) return
    await writeBatch(rows)
  }

  const schedule = (): void => {
    if (state.scheduled) return
    state.scheduled = true
    state.chain = state.chain
      .then(() => flushScheduled())
      .catch(() => undefined)
      .then(() => {
        state.scheduled = false
        if (state.pending.length > 0) schedule()
      })
  }

  const append = (span: TraceSpan): void => {
    try {
      state.pending.push(`${JSON.stringify(span)}\n`)
      schedule()
    } catch {
      // the receiver hot path must never break
    }
  }

  const flush = async (): Promise<void> => {
    for (;;) {
      await state.chain
      if (!state.scheduled && state.pending.length === 0) break
    }
  }

  return { append, flush }
}

const isTraceSpan = (parsed: unknown): parsed is TraceSpan => {
  if (typeof parsed !== "object" || parsed === null) return false
  const dict = parsed as Record<string, unknown>
  return typeof dict["traceId"] === "string" && typeof dict["spanId"] === "string"
}

/** Read all stored spans, skipping corrupt lines (mirrors `queryLogs`). */
export const readSpansFile = async (spansFile: string): Promise<{ spans: TraceSpan[]; corrupt: number }> => {
  let text: string
  try {
    text = await readFile(spansFile, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { spans: [], corrupt: 0 }
    throw error
  }
  const spans: TraceSpan[] = []
  let corrupt = 0
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isTraceSpan(parsed)) {
        corrupt += 1
        continue
      }
      spans.push(parsed)
    } catch {
      corrupt += 1
    }
  }
  return { spans, corrupt }
}
