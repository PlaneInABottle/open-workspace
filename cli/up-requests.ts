/** M1 service-request channel: one-shot client↔supervisor file protocol.
 * Live-lock discipline (B1): while the supervisor lock is live the client
 * never spawns, acquires the lock, or writes `supervisor.json` — it only
 * writes a request file and waits for the supervisor's result file.
 * The supervisor (sole writer) scans FIFO, executes, persists itself,
 * deletes the request, and leaves the result for the client to collect.
 * Request names `up-<svc>.<pid>.<nonce>.json` /
 * `restart-<svc>.<pid>.<nonce>.json` / `down-<svc>.<pid>.<nonce>.json` /
 * `readiness-<svc>.<pid>.<nonce>.json` (M3 verdict recording);
 * results live in `requests/results/<nonce>.json`. All writes are
 * tmp+rename atomic. A client that sees no result within the window exits
 * 1 (`request unanswered`) and never assumes a half-spawn. */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type ServiceAction = "up" | "restart" | "down" | "readiness"

/** Readiness observation payload (M3): the probed pid plus the verdict.
 * The supervisor records it only when the pid still matches the live
 * unit (stale results are dropped, never merged). */
export type ReadinessOutcome = {
  /** Supervisor-recorded pid the probe verdict belongs to. */
  pid: number
  ok: boolean
  note?: string
  at: string
  /** M-C probe-declared build identity (basename → full digest, raw):
   * carried in the same envelope as the readiness request (the sole-writer
   * supervisor merges it; cap + shape discipline live on the supervisor side). */
  artifacts?: Record<string, string>
}

export type ServiceRequest = {
  action: ServiceAction
  service: string
  /** Unique per request; the result file carries the same nonce. */
  nonce: string
  pid: number
  at: string
  /** Absolute ow.yaml path the supervisor re-parses (client never inlines
   * config: the file stays the single source of truth). Unused by the
   * `readiness` action (outcome travels in-body). */
  file: string
  /** Present only on `readiness` requests (client-observed verdict). */
  readiness?: ReadinessOutcome
}

export type ServiceResult = {
  action: ServiceAction
  service: string
  nonce: string
  ok: boolean
  /** Machine-stable outcome: `started` | `already-running` | `restarted` |
   * `stopped` | `already-stopped` | `refused` | `unknown-service` |
   * `invalid-config` | `recorded` | `stale`. */
  code: string
  /** Human line (already formatted for stdout/stderr). */
  message: string
  pid?: number
}

export const REQUEST_TIMEOUT_MS = 10_000

/** One-shot wait window; tests override via `OW_REQUEST_WAIT_MS` (ms). */
export const requestWaitMs = (): number => {
  const raw = process.env.OW_REQUEST_WAIT_MS
  if (raw === undefined) return REQUEST_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : REQUEST_TIMEOUT_MS
}

export const requestFileName = (action: ServiceAction, service: string, pid: number, nonce: string): string =>
  `${action}-${service}.${pid}.${nonce}.json`

export const resultFileName = (nonce: string): string => `${nonce}.json`

export const parseRequestFileName = (file: string): { action: ServiceAction; service: string; pid: number; nonce: string } | null => {
  const match = /^(up|restart|down|readiness)-([A-Za-z0-9_-]{1,64})\.(\d+)\.([A-Za-z0-9_-]{1,64})\.json$/.exec(file)
  if (!match) return null
  return { action: match[1] as ServiceAction, service: match[2], pid: Number(match[3]), nonce: match[4] }
}

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Client-side: write the request atomically, return the nonce to wait on.
 * `extra` carries action-specific payloads (M3 `readiness` outcome). */
export const writeRequest = async (
  requestsDir: string,
  action: ServiceAction,
  service: string,
  file: string,
  extra?: { readiness?: ReadinessOutcome },
): Promise<string> => {
  await mkdir(join(requestsDir, "results"), { recursive: true, mode: 0o700 })
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const request: ServiceRequest = {
    action,
    service,
    nonce,
    pid: process.pid,
    at: new Date().toISOString(),
    file,
    ...(extra?.readiness === undefined ? {} : { readiness: extra.readiness }),
  }
  await atomicWriteJson(join(requestsDir, requestFileName(action, service, process.pid, nonce)), request)
  return nonce
}

/** Client-side: poll for the result, then read-and-delete it. Null on
 * timeout (L-1: best-effort delete before returning, so a result that
 * lands between the last poll and the deadline does not linger). */
export const waitResult = async (requestsDir: string, nonce: string, timeoutMs = requestWaitMs()): Promise<ServiceResult | null> => {
  const path = join(requestsDir, "results", resultFileName(nonce))
  const start = Date.now()
  for (;;) {
    try {
      const result = JSON.parse(await readFile(path, "utf8")) as ServiceResult
      await unlink(path).catch(() => undefined)
      return result
    } catch {
      // not yet written
    }
    if (Date.now() - start >= timeoutMs) {
      await unlink(path).catch(() => undefined)
      return null
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
}

/** Supervisor-side TTL sweep: results older than `maxAgeMs` are client
 * leftovers (a client waits at most 10s, so 60s is a safe margin) and are
 * unlinked best-effort. Called throttled from the supervisor loop — never
 * on the hot path per iteration. */
export const sweepStaleResults = async (requestsDir: string, maxAgeMs = 60_000): Promise<number> => {
  let swept = 0
  let entries: string[]
  try {
    entries = await readdir(join(requestsDir, "results"))
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]{1,96}\.json$/.test(entry)) continue
    try {
      const info = await stat(join(requestsDir, "results", entry))
      if (Date.now() - info.mtimeMs > maxAgeMs) {
        await unlink(join(requestsDir, "results", entry)).catch(() => undefined)
        swept += 1
      }
    } catch {
      // vanished between reads
    }
  }
  return swept
}

/** Supervisor-side: FIFO scan (file-mtime, then nonce/name order). */
export const scanRequests = async (requestsDir: string): Promise<{ file: string; request: ServiceRequest }[]> => {
  let entries: string[]
  try {
    entries = await readdir(requestsDir)
  } catch {
    return []
  }
  const out: { file: string; request: ServiceRequest; mtime: number }[] = []
  for (const entry of entries) {
    if (parseRequestFileName(entry) === null) continue
    try {
      const [text, info] = await Promise.all([readFile(join(requestsDir, entry), "utf8"), stat(join(requestsDir, entry))])
      const parsed = JSON.parse(text) as ServiceRequest
      if (typeof parsed !== "object" || parsed === null || typeof parsed.nonce !== "string") throw new Error("bad-shape")
      out.push({ file: entry, request: parsed, mtime: info.mtimeMs })
    } catch {
      // Half-written: the writer is atomic (tmp+rename), so a persistent
      // failure means a poison file — sweep it after 60s so the scan never
      // spins on it (its client already timed out with exit 1).
      try {
        const info = await stat(join(requestsDir, entry))
        if (Date.now() - info.mtimeMs > 60_000) await unlink(join(requestsDir, entry)).catch(() => undefined)
      } catch {
        // vanished between reads
      }
    }
  }
  out.sort((a, b) => a.mtime - b.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return out.map(({ file, request }) => ({ file, request }))
}

/** Supervisor-side: publish the result first, then delete the request. */
export const completeRequest = async (requestsDir: string, file: string, result: ServiceResult): Promise<void> => {
  await mkdir(join(requestsDir, "results"), { recursive: true, mode: 0o700 })
  await atomicWriteJson(join(requestsDir, "results", resultFileName(result.nonce)), result)
  await unlink(join(requestsDir, file)).catch(() => undefined)
}
