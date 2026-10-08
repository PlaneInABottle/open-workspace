/** M1 acceptance: protobuf decode + redaction/sanitization (S1–S6, A3).
 * Hand-encoded `ExportTraceServiceRequest` fixtures (V8 field map) prove a
 * real exporter's bytes land as exact span rows. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decodeTraceRequest, TraceDecodeError } from "./trace-otlp"
import { createTraceStore, readSpansFile } from "./trace-store"

// --- Minimal protobuf encoder for fixtures (V8 field numbers) ---

const encVarint = (n: number | bigint): number[] => {
  let v = typeof n === "bigint" ? n : BigInt(n)
  const out: number[] = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v !== 0n) byte |= 0x80
    out.push(byte)
  } while (v !== 0n)
  return out
}

const tag = (field: number, wire: number): number[] => encVarint((field << 3) | wire)

const lenField = (field: number, payload: number[] | Uint8Array): number[] => {
  const bytes = Array.from(payload)
  return [...tag(field, 2), ...encVarint(bytes.length), ...bytes]
}

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
const rawHex = (hex: string): number[] => Array.from(Buffer.from(hex, "hex"))

const fixed64 = (n: bigint): number[] => {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, n, true)
  return Array.from(buf)
}

const anyString = (value: string): number[] => lenField(1, utf8(value))
const anyInt = (value: number): number[] => [...tag(3, 0), ...encVarint(value)]
const kv = (key: string, anyValue: number[]): number[] => [...lenField(1, utf8(key)), ...lenField(2, anyValue)]

const TRACE_ID = "ab".repeat(16)
const SPAN_ID = "cd".repeat(8)
const PARENT_ID = "ef".repeat(8)

type SpanOpts = {
  traceId?: string | null
  spanId?: string | null
  parent?: string | null
  name?: string
  kind?: number
  start?: bigint
  end?: bigint
  attrs?: [string, number[]][]
  status?: number
}

const spanBytes = (o: SpanOpts): number[] => [
  ...(o.traceId === null ? [] : lenField(1, rawHex(o.traceId ?? TRACE_ID))),
  ...(o.spanId === null ? [] : lenField(2, rawHex(o.spanId ?? SPAN_ID))),
  ...(o.parent ? lenField(4, rawHex(o.parent)) : []),
  ...lenField(5, utf8(o.name ?? "GET /api/x")),
  ...tag(6, 0),
  ...encVarint(o.kind ?? 2),
  ...tag(7, 1),
  ...fixed64(o.start ?? 1_000_000_000n),
  ...tag(8, 1),
  ...fixed64(o.end ?? 1_012_400_000n),
  ...(o.attrs ?? []).flatMap(([k, v]) => lenField(9, kv(k, v))),
  ...(o.status === undefined ? [] : lenField(15, [...tag(3, 0), ...encVarint(o.status)])),
]

const scopeSpans = (service: string | null, spans: number[][]): number[] => [
  ...(service === null ? [] : lenField(1, lenField(1, kv("service.name", anyString(service))))),
  ...lenField(2, spans.flatMap((s) => lenField(2, s))),
]

const requestBytes = (...resources: number[][]): Uint8Array =>
  new Uint8Array(resources.flatMap((r) => lenField(1, r)))

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-trace-otlp-"))

describe("trace-otlp decode fixture", () => {
  test("hand-encoded request yields exactly one span with exact fields", () => {
    const spans = decodeTraceRequest(requestBytes(scopeSpans("api", [spanBytes({ spanId: SPAN_ID, parent: PARENT_ID })])))
    expect(spans.length).toBe(1)
    const span = spans[0]
    expect(span.traceId).toBe(TRACE_ID)
    expect(span.spanId).toBe(SPAN_ID)
    expect(span.parentSpanId).toBe(PARENT_ID)
    expect(span.name).toBe("GET /api/x")
    expect(span.kind).toBe("server")
    expect(span.service).toBe("api")
    expect(span.status).toBe("unset")
    expect(span.durMs).toBe(12.4)
    expect(span.t).toBe("1970-01-01T00:00:01.000Z")
  })

  test("nanosecond epochs keep full precision as decimal strings", () => {
    const start = 1719999999123456789n
    const end = 1719999999567890123n
    const spans = decodeTraceRequest(requestBytes(scopeSpans("api", [spanBytes({ start, end })])))
    expect(spans[0].startNano).toBe("1719999999123456789")
    expect(spans[0].endNano).toBe("1719999999567890123")
    expect(spans[0].durMs).toBeCloseTo(444.433334, 6)
  })

  test("kind and status codes map; unknown kind degrades to unspecified", () => {
    const spans = decodeTraceRequest(
      requestBytes(
        scopeSpans("api", [
          spanBytes({ spanId: "11".repeat(8), kind: 3, status: 1 }),
          spanBytes({ spanId: "22".repeat(8), kind: 9, status: 2 }),
        ]),
      ),
    )
    expect(spans.map((s) => [s.kind, s.status])).toEqual([
      ["client", "ok"],
      ["unspecified", "error"],
    ])
  })

  test("missing resource → bilinmeyen; missing trace id → span skipped", () => {
    const spans = decodeTraceRequest(
      requestBytes(scopeSpans(null, [spanBytes({}), spanBytes({ traceId: null })])),
    )
    expect(spans.length).toBe(1)
    expect(spans[0].service).toBe("bilinmeyen")
  })

  test("two services share one traceId with parent linkage", () => {
    const spans = decodeTraceRequest(
      requestBytes(
        scopeSpans("web", [spanBytes({ spanId: SPAN_ID })]),
        scopeSpans("worker", [spanBytes({ spanId: "99".repeat(8), parent: SPAN_ID })]),
      ),
    )
    expect(spans.length).toBe(2)
    expect(spans.map((s) => s.service)).toEqual(["web", "worker"])
    expect(spans[1].parentSpanId).toBe(spans[0].spanId)
    expect(spans[1].traceId).toBe(spans[0].traceId)
  })

  test("unknown fields are skipped by wire type, never fatal", () => {
    const span = spanBytes({})
    const withUnknown: number[] = [
      ...lenField(1, rawHex(TRACE_ID)),
      ...lenField(2, rawHex(SPAN_ID)),
      ...tag(77, 0),
      ...encVarint(12345),
      ...tag(78, 2),
      ...encVarint(3),
      9, 9, 9,
      ...tag(79, 1),
      1, 2, 3, 4, 5, 6, 7, 8,
      ...tag(80, 5),
      1, 2, 3, 4,
      ...lenField(5, utf8("GET /api/x")),
      ...tag(6, 0),
      ...encVarint(2),
      ...tag(7, 1),
      ...fixed64(1000n),
      ...tag(8, 1),
      ...fixed64(2000n),
      ...lenField(99, utf8("gelecek-alan")),
    ]
    void span
    const spans = decodeTraceRequest(requestBytes(scopeSpans("api", [withUnknown])))
    expect(spans.length).toBe(1)
    expect(spans[0].name).toBe("GET /api/x")
  })

  test("attribute count is capped at 16", () => {
    const attrs: [string, number[]][] = [
      "http.request.method",
      "http.response.status_code",
      "http.route",
      "url.path",
      "url.scheme",
      "server.address",
      "server.port",
      "db.system.name",
      "db.namespace",
      "db.operation.name",
      "db.collection.name",
      "rpc.system",
      "rpc.service",
      "rpc.method",
      "messaging.system",
      "messaging.operation.name",
      "error.type",
    ].map((key) => [key, anyString("v")] as [string, number[]])
    const spans = decodeTraceRequest(requestBytes(scopeSpans("api", [spanBytes({ attrs })])))
    expect(Object.keys(spans[0].attrs).length).toBe(16)
  })
})

describe("trace-otlp redaction (A3 + S1–S5)", () => {
  const storeAndRead = async (body: Uint8Array): Promise<{ text: string; spans: ReturnType<typeof decodeTraceRequest> }> => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile)
      const spans = decodeTraceRequest(body)
      for (const span of spans) store.append(span)
      await store.flush()
      return { text: await readFile(spansFile, "utf8"), spans }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("dropped keys and their values never reach spans.jsonl; allowlisted keys survive", async () => {
    const body = requestBytes(
      scopeSpans("api", [
        spanBytes({
          attrs: [
            ["url.full", anyString("https://x.example/full?token=abc")],
            ["db.query.text", anyString("SELECT * FROM users")],
            ["http.request.header.authorization", anyString("Bearer abc")],
            ["exception.message", anyString("boom_patlama")],
            ["http.route", anyString("/orders/{id}")],
            ["http.response.status_code", anyInt(200)],
            ["url.path", anyString("/health")],
          ],
        }),
      ]),
    )
    const { text, spans } = await storeAndRead(body)
    for (const needle of [
      "url.full",
      "db.query.text",
      "http.request.header.authorization",
      "exception.message",
      "https://x.example/full?token=abc",
      "SELECT * FROM users",
      "boom_patlama",
    ]) {
      expect(text).not.toContain(needle)
    }
    expect(spans[0].attrs["http.route"]).toBe("/orders/{id}")
    expect(spans[0].attrs["http.response.status_code"]).toBe("200")
    expect(spans[0].attrs["url.path"]).toBe("/health")
    expect(text).toContain("/orders/{id}")
  })

  test("S1: query strings are stripped from name and values", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(scopeSpans("api", [spanBytes({ name: "GET /x?token=abc", attrs: [["url.path", anyString("/x?token=abc")]] })])),
    )
    expect(spans[0].name).toBe("GET /x")
    expect(spans[0].attrs["url.path"]).toBe("/x")
    expect(text).not.toContain("abc")
  })

  test("S2/S3 sentinel: secrets inside allowed fields never reach disk", async () => {
    const sentinel = "ZZSENTINELZZ"
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            name: `GET /reset/${sentinel}9f3c1a7b`,
            attrs: [
              ["url.path", anyString(`/reset/${sentinel}9f3c1a7b`)],
              ["http.route", anyString(`Bearer ${sentinel}`)],
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].name).toBe("GET /reset/:id")
    expect(spans[0].attrs["url.path"]).toBe("/reset/:id")
    expect(spans[0].attrs["http.route"]).toBe("Bearer ***")
    expect(text).not.toContain(sentinel)
  })

  test("S2: identifiers masked, templates and route words kept", async () => {
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({ name: "GET /orders/12345" }),
          spanBytes({ name: "GET /orders/{id}" }),
          spanBytes({ name: "GET /health" }),
        ]),
      ),
    )
    expect(spans.map((s) => s.name)).toEqual(["GET /orders/:id", "GET /orders/{id}", "GET /health"])
  })

  test("hostile service name is stripped/masked like span names; sentinel never reaches disk", async () => {
    const sentinel = "ZZSENTINELZZ"
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile)
      const body = requestBytes(scopeSpans(`/reset/${sentinel}9f3c1a7b?token=abc`, [spanBytes({})]))
      const spans = decodeTraceRequest(body)
      for (const span of spans) store.append(span)
      await store.flush()
      expect(spans[0].service).toBe("/reset/:id")
      expect(await readFile(spansFile, "utf8")).not.toContain(sentinel)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-otlp decode failures (S6)", () => {
  test("truncated body reports reason + field path + offset/length, never content", () => {
    const full = requestBytes(scopeSpans("api", [spanBytes({ name: "gizli-payload-M1x9" })]))
    const truncated = full.subarray(0, full.length - 5)
    let error: unknown
    try {
      decodeTraceRequest(truncated)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TraceDecodeError)
    const decoded = error as TraceDecodeError
    expect(["bad-wiretype", "truncated-varint", "unexpected-eof"]).toContain(decoded.reason)
    expect(decoded.path).toContain("resource_spans")
    expect(decoded.message).toContain("offset=")
    expect(decoded.message).toContain("len=")
    expect(decoded.message).not.toContain("gizli-payload-M1x9")
    expect(JSON.stringify(error)).not.toContain("gizli-payload-M1x9")
  })

  test("garbage bytes fail bounded; illegal wire type names bad-wiretype", () => {
    let garbage: unknown
    try {
      decodeTraceRequest(new Uint8Array(Buffer.alloc(20, 0xff)))
    } catch (caught) {
      garbage = caught
    }
    expect(garbage).toBeInstanceOf(TraceDecodeError)
    expect((garbage as TraceDecodeError).reason).toBe("truncated-varint")

    let wire: unknown
    try {
      decodeTraceRequest(new Uint8Array([...encVarint((1 << 3) | 6), 0x00]))
    } catch (caught) {
      wire = caught
    }
    expect(wire).toBeInstanceOf(TraceDecodeError)
    expect((wire as TraceDecodeError).reason).toBe("bad-wiretype")
  })

  test("too-deep guard reports a bounded reason with no payload bytes", () => {
    const nest = (depth: number): number[] => (depth === 0 ? utf8("gizli-derinlik-P9q4") : lenField(1, nest(depth - 1)))
    const deep = new Uint8Array(lenField(1, nest(40)))
    // default limits: total decoder, hostile nesting never throws
    expect(decodeTraceRequest(deep)).toEqual([])
    // forced shallow limit hits the guard with a bounded descriptor
    const body = requestBytes(scopeSpans("api", [spanBytes({ name: "gizli-derinlik-P9q4" })]))
    let error: unknown
    try {
      decodeTraceRequest(body, { maxDepth: 2 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TraceDecodeError)
    const bounded = error as TraceDecodeError
    expect(bounded.reason).toBe("too-deep")
    expect(bounded.path).toContain("resource_spans")
    expect(bounded.message).toContain("offset=")
    expect(bounded.message).not.toContain("gizli-derinlik-P9q4")
  })

  test("decode never writes files anywhere", async () => {
    const root = await tempRoot()
    try {
      const full = requestBytes(scopeSpans("api", [spanBytes({})]))
      decodeTraceRequest(full.subarray(0, full.length - 5))
    } catch {
      // expected
    }
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test("corrupt stored lines are skipped by the reader, never fatal", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(requestBytes(scopeSpans("api", [spanBytes({})])))) store.append(span)
      await store.flush()
      const { appendFile } = await import("node:fs/promises")
      await appendFile(spansFile, "bozuk-satır{{{not-json\n")
      const { spans, corrupt } = await readSpansFile(spansFile)
      expect(spans.length).toBe(1)
      expect(corrupt).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
