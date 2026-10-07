/** Per-service JSONL log capture + query for `ow logs`.
 * Rows are `{t, stream, line}` with stream ∈ `stdout|stderr|log|event`,
 * stored at `<root>/.ow/logs/<service>.jsonl` (0600, atomic rotation).
 * Small local copies of the observer-core tail/compact discipline
 * (attribution: `shell-observer-core.ts` readTail/fitRecentLines shape —
 * those helpers are module-private there, so they are re-implemented here
 * with the smaller supervisor caps). */

import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ensureUpStateDir } from "./up-state"

export const UP_LOG_MAX_BYTES = 5 * 1024 * 1024
export const UP_LOG_MAX_LINES = 10_000
export const UP_LOG_LINE_MAX_BYTES = 8 * 1024
export const UP_LOG_MAX_FILES = 32

const SERVICE_FILE = /^[A-Za-z0-9_-]{1,64}\.jsonl$/
const SERVICE_NAME = /^[A-Za-z0-9_-]{1,64}$/

export type UpLogStream = "stdout" | "stderr" | "log" | "event"
export type UpLogRow = { t: string; stream: UpLogStream; line: string }
export type UpLogQueryRow = { t: string; service: string; stream: string; line: string }

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

/** Copy of the observer-core tail shape: last `maxBytes` with the partial
 * first line dropped; missing file → empty (honest-empty query rule). */
const readTail = async (path: string, maxBytes: number): Promise<{ text: string; size: number; truncated: boolean }> => {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("log dosyası normal dosya olmalı")
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

/** Copy of the observer-core newest-wins compact shape. */
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

const replaceLog = async (path: string, text: string): Promise<void> => {
  const temporary = join(dirname(path), `.ow-log-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** 8 KB cap on line content; overflow keeps the head plus a marker. */
export const truncateLogLine = (line: string): string => {
  if (byteLength(line) <= UP_LOG_LINE_MAX_BYTES) return line
  let output = ""
  for (const ch of line) {
    if (byteLength(output + ch) > UP_LOG_LINE_MAX_BYTES) break
    output += ch
  }
  return `${output}…[kesildi]…`
}

export type UpLogWriterLimits = { maxBytes?: number; maxLines?: number; maxPendingBytes?: number }

/** Bound on unflushed rows: bursts absorb into memory, sustained overload
 * drops with a visible counter (never blocks the child). */
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024

type WriterState = {
  chain: Promise<void>
  scheduled: boolean
  pending: UpLogRow[]
  pendingBytes: number
  dropped: number
  bytes: number
  lines: number
  initialized: boolean
  maxBytes: number
  maxLines: number
  maxPendingBytes: number
}

/** Non-blocking file writer: appends accumulate into a bounded in-memory
 * batch; one chain step writes the whole batch in a single open/write/close,
 * so line bursts absorb without a syscall per row. When the pending batch is
 * full the row is dropped and a counter is kept — the next executed batch
 * flushes one `event` row with the count, so the child is never blocked and
 * loss stays visible. */
export const createUpLogWriter = (path: string, limits: UpLogWriterLimits = {}) => {
  const state: WriterState = {
    chain: Promise.resolve(),
    scheduled: false,
    pending: [],
    pendingBytes: 0,
    dropped: 0,
    bytes: 0,
    lines: 0,
    initialized: false,
    maxBytes: Math.max(1, limits.maxBytes ?? UP_LOG_MAX_BYTES),
    maxLines: Math.max(1, limits.maxLines ?? UP_LOG_MAX_LINES),
    maxPendingBytes: Math.max(1, limits.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES),
  }

  const initialize = async (): Promise<void> => {
    if (state.initialized) return
    await ensureUpStateDir(dirname(path))
    const current = await readTail(path, state.maxBytes)
    let text = current.text
    if (current.truncated || current.size > state.maxBytes || lineCount(text) > state.maxLines) {
      text = fitRecentLines(text, state.maxBytes, state.maxLines)
      await replaceLog(path, text)
    } else if (current.size > 0) {
      await chmod(path, 0o600).catch(() => undefined)
    }
    state.bytes = byteLength(text)
    state.lines = lineCount(text)
    state.initialized = true
  }

  const writeBatch = async (rows: UpLogRow[]): Promise<void> => {
    await initialize()
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("")
    const textBytes = byteLength(text)
    if (state.bytes + textBytes > state.maxBytes || state.lines + rows.length > state.maxLines) {
      const current = await readTail(path, state.maxBytes)
      const compacted = fitRecentLines(`${current.text}${text}`, state.maxBytes, state.maxLines)
      await replaceLog(path, compacted)
      state.bytes = byteLength(compacted)
      state.lines = lineCount(compacted)
      return
    }
    const file = await open(path, "a", 0o600)
    try {
      await file.writeFile(text, "utf8")
    } finally {
      await file.close()
    }
    state.bytes += textBytes
    state.lines += rows.length
  }

  const flushScheduled = async (): Promise<void> => {
    const rows = state.pending
    state.pending = []
    state.pendingBytes = 0
    if (state.dropped > 0) {
      const count = state.dropped
      state.dropped = 0
      rows.unshift({ t: new Date().toISOString(), stream: "event", line: `…[atıldı: ${count} satır]…` })
    }
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

  const append = (row: UpLogRow): void => {
    const rowBytes = byteLength(row.line) + 64
    if (state.pendingBytes + rowBytes > state.maxPendingBytes) {
      state.dropped += 1
      return
    }
    state.pending.push(row)
    state.pendingBytes += rowBytes
    schedule()
  }

  const flush = async (): Promise<void> => {
    for (;;) {
      await state.chain
      if (!state.scheduled && state.pending.length === 0) break
    }
  }

  return { append, flush }
}

const sharedWriters = new Map<string, ReturnType<typeof createUpLogWriter>>()

/** Supervisor hot-path entry: never blocks, never throws. */
export const appendLogLine = (logsDir: string, service: string, stream: UpLogStream, line: string): void => {
  if (!SERVICE_NAME.test(service)) return
  try {
    const path = join(logsDir, `${service}.jsonl`)
    let writer = sharedWriters.get(path)
    if (!writer) {
      writer = createUpLogWriter(path)
      sharedWriters.set(path, writer)
    }
    writer.append({ t: new Date().toISOString(), stream, line: truncateLogLine(line) })
  } catch {
    // capture must never break supervision
  }
}

export const flushUpLogs = async (): Promise<void> => {
  await Promise.all([...sharedWriters.values()].map((writer) => writer.flush()))
}

/** Test hygiene: drop cached shared writers (temp dirs per test). */
export const resetUpLogWriters = (): void => {
  sharedWriters.clear()
}

const parseRow = (text: string): UpLogRow | null => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const dict = parsed as Record<string, unknown>
    if (typeof dict["t"] !== "string") return null
    if (dict["stream"] !== "stdout" && dict["stream"] !== "stderr" && dict["stream"] !== "log" && dict["stream"] !== "event") {
      return null
    }
    if (typeof dict["line"] !== "string") return null
    return { t: dict["t"], stream: dict["stream"], line: dict["line"] }
  } catch {
    return null
  }
}

const readServiceRows = async (path: string, service: string, maxLines: number): Promise<UpLogQueryRow[]> => {
  let text: string
  try {
    if (maxLines === Number.POSITIVE_INFINITY) {
      text = await readFile(path, "utf8")
    } else {
      // Per-file line budget keeps the ≤32-file merged view bounded; the
      // single-service path reads the whole (capped) file for exact filters.
      const tail = await readTail(path, Math.min(Math.max(64 * 1024, maxLines * 1024), 2 * 1024 * 1024))
      text = tail.text
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const raw = text.split("\n")
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop()
  const windowed = raw.length > maxLines ? raw.slice(raw.length - maxLines) : raw
  const rows: UpLogQueryRow[] = []
  for (const item of windowed) {
    if (item.length === 0) continue
    const row = parseRow(item)
    if (!row) continue // corrupt lines skipped silently
    rows.push({ t: row.t, service, stream: row.stream, line: row.line })
  }
  return rows
}

export type UpLogQuery = {
  logsDir: string
  service?: string
  tail?: number
  grep?: string
  sinceMs?: number | null
}

/** Newest-first-cap-then-ascending merge: per-file recent rows are merged,
 * filtered (literal substring grep, since window) and the final `tail` rows
 * are returned oldest-first. Missing dir/file → honest empty result. */
export const queryLogs = async (query: UpLogQuery): Promise<UpLogQueryRow[]> => {
  const tail = Math.min(Math.max(query.tail ?? 200, 1), 5000)
  let files: { service: string; path: string }[]
  if (query.service !== undefined) {
    if (!SERVICE_NAME.test(query.service)) return []
    files = [{ service: query.service, path: join(query.logsDir, `${query.service}.jsonl`) }]
  } else {
    let entries: string[]
    try {
      entries = await readdir(query.logsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    files = entries
      .filter((entry) => SERVICE_FILE.test(entry))
      .sort()
      .slice(0, UP_LOG_MAX_FILES)
      .map((entry) => ({ service: entry.slice(0, -".jsonl".length), path: join(query.logsDir, entry) }))
  }
  const perFile = query.service !== undefined ? Number.POSITIVE_INFINITY : tail
  const merged: UpLogQueryRow[] = []
  for (const file of files) {
    merged.push(...(await readServiceRows(file.path, file.service, perFile)))
  }
  const now = Date.now()
  const filtered = merged.filter((row) => {
    if (query.grep !== undefined && query.grep !== "" && !row.line.includes(query.grep)) return false
    if (query.sinceMs != null) {
      const when = Date.parse(row.t)
      if (!Number.isFinite(when) || when < now - query.sinceMs) return false
    }
    return true
  })
  filtered.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  return filtered.slice(-tail)
}
