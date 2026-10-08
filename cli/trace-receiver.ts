/** Embedded OTLP/HTTP trace receiver (D1): a loopback-only `Bun.serve`
 * living inside the supervisor process. Accepts `POST /v1/traces` with
 * `application/x-protobuf` (D2: JSON is rejected, not parsed), honors
 * `Content-Encoding: gzip` under the inflated cap, answers loopback CORS
 * preflight (D6), and replies with an empty Protobuf
 * `ExportTraceServiceResponse` (V7: zero-byte body = full success).
 *
 * Every failure mode is warn-only (D7): bind failure, oversized body,
 * inflate-over-limit, decode failure, full disk — the supervisor keeps
 * supervising. Rejections are counted by reason (count, never body) so a
 * silently-rejecting receiver stays diagnosable. */

import { gunzipSync } from "node:zlib"

import { decodeTraceRequest, TraceDecodeError } from "./trace-otlp"
import {
  assertSpansFileRegular,
  createTraceStore,
  ensureTracesDir,
  TRACE_BIND_HOST,
  TRACE_DEFAULT_PORT,
  TRACE_MAX_BODY_BYTES,
  TRACE_MAX_INFLATED_BYTES,
  type TraceStoreLimits,
} from "./trace-store"

export type TraceRejectReason = "too-large" | "inflate-too-large" | "decode-failed" | "bad-path"

export type TraceReceiverOptions = {
  tracesDir: string
  spansFile: string
  port?: number
  maxBodyBytes?: number
  maxInflatedBytes?: number
  storeLimits?: TraceStoreLimits
  /** Reject-warning throttle; default one per minute so a misconfigured
   * exporter cannot spam the terminal. Tests pass 0. */
  warnThrottleMs?: number
  onWarn?: (line: string) => void
}

export type TraceReceiver = {
  port: number
  rejected: Record<TraceRejectReason, number>
  stop: () => Promise<void>
}

const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/** Bounded wire read: at most `max+one chunk` is ever materialized; over-cap
 * bodies are reported without being fully read. */
const readBoundedBody = async (req: Request, max: number): Promise<{ bytes: Uint8Array } | { over: true }> => {
  if (!req.body) return { bytes: new Uint8Array(0) }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > max) {
        try {
          await reader.cancel()
        } catch {
          // already closed
        }
        return { over: true }
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: out }
}

const isInflateOverLimit = (error: unknown): boolean =>
  error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE"

export const startTraceReceiver = async (options: TraceReceiverOptions): Promise<TraceReceiver | null> => {
  const warn = options.onWarn ?? ((line: string): void => console.error(line))
  const maxBodyBytes = options.maxBodyBytes ?? TRACE_MAX_BODY_BYTES
  const maxInflatedBytes = options.maxInflatedBytes ?? TRACE_MAX_INFLATED_BYTES
  const warnThrottleMs = options.warnThrottleMs ?? 60_000
  try {
    await ensureTracesDir(options.tracesDir)
    await assertSpansFileRegular(options.spansFile)
  } catch (error) {
    warn(`uyarı: trace kapalı (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
  const store = createTraceStore(options.spansFile, options.storeLimits)
  const rejected: Record<TraceRejectReason, number> = {
    "too-large": 0,
    "inflate-too-large": 0,
    "decode-failed": 0,
    "bad-path": 0,
  }
  let lastWarnAt = 0
  const throttledWarn = (line: string): void => {
    const now = Date.now()
    if (now - lastWarnAt < warnThrottleMs) return
    lastWarnAt = now
    try {
      warn(line)
    } catch {
      // warnings must never break the receiver
    }
  }
  const reject = (reason: TraceRejectReason, status: number, detail: string): Response => {
    rejected[reason] += 1
    throttledWarn(`uyarı: trace isteği reddedildi (${reason}: ${detail})`)
    return new Response(null, { status })
  }
  let server
  try {
    server = Bun.serve({
      hostname: TRACE_BIND_HOST,
      port: options.port ?? TRACE_DEFAULT_PORT,
      fetch: async (req: Request): Promise<Response> => {
        try {
          const url = new URL(req.url)
          if (req.method === "OPTIONS" && url.pathname === "/v1/traces") {
            const origin = req.headers.get("origin") ?? ""
            if (LOOPBACK_ORIGIN.test(origin)) {
              return new Response(null, {
                status: 204,
                headers: {
                  "access-control-allow-origin": origin,
                  "access-control-allow-methods": "POST, OPTIONS",
                  "access-control-allow-headers": "content-type",
                  "access-control-max-age": "600",
                },
              })
            }
            return reject("bad-path", 403, "yabancı origin")
          }
          if (url.pathname !== "/v1/traces" || req.method !== "POST") {
            return reject("bad-path", 404, "404")
          }
          const contentType = req.headers.get("content-type") ?? ""
          if (!contentType.startsWith("application/x-protobuf")) {
            return reject("decode-failed", 415, "415")
          }
          const body = await readBoundedBody(req, maxBodyBytes)
          if ("over" in body) {
            return reject("too-large", 413, `gövde>${maxBodyBytes}b`)
          }
          let payload: Uint8Array = body.bytes
          const encoding = req.headers.get("content-encoding") ?? ""
          if (encoding.toLowerCase().includes("gzip")) {
            try {
              // Bounded inflate only: Bun.gunzipSync is banned here (uncapped).
              payload = gunzipSync(Buffer.from(body.bytes), { maxOutputLength: maxInflatedBytes })
            } catch (error) {
              if (isInflateOverLimit(error)) {
                return reject("inflate-too-large", 413, `şişmiş>${maxInflatedBytes}b`)
              }
              return reject("decode-failed", 400, "bozuk-gzip")
            }
          }
          let spans
          try {
            spans = decodeTraceRequest(payload)
          } catch (error) {
            const detail =
              error instanceof TraceDecodeError
                ? `${error.reason} ${error.path} offset=${error.offset} len=${error.length}`
                : "çözümlenemedi"
            return reject("decode-failed", 400, detail)
          }
          for (const span of spans) store.append(span)
          try {
            await store.flush()
          } catch (error) {
            throttledWarn(`uyarı: trace yazılamadı (${error instanceof Error ? error.message : String(error)})`)
          }
          // V7: echo the request Content-Type; a zero-byte body is a valid
          // fully-successful ExportTraceServiceResponse.
          return new Response(null, { status: 200, headers: { "content-type": "application/x-protobuf" } })
        } catch {
          rejected["decode-failed"] += 1
          return new Response(null, { status: 400 })
        }
      },
    })
  } catch (error) {
    warn(`uyarı: trace alıcısı başlatılamadı (port ${options.port ?? TRACE_DEFAULT_PORT}: ${error instanceof Error ? error.message : String(error)})`)
    return null
  }
  return {
    port: server.port,
    rejected,
    stop: async (): Promise<void> => {
      try {
        server.stop()
      } catch {
        // already stopped
      }
      await store.flush().catch(() => undefined)
    },
  }
}
