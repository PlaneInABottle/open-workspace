/** M1 acceptance: protobuf decode + redaction/sanitization (S1–S6, A3).
 * Hand-encoded `ExportTraceServiceRequest` fixtures (V8 field map) prove a
 * real exporter's bytes land as exact span rows. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decodeTraceRequest, TraceDecodeError, type TraceSpan } from "./trace-otlp"
import { selectValidSpans } from "./trace-query"
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
  events?: { name: string; attrs: [string, number[]][] }[]
}

const eventBytes = (name: string, attrs: [string, number[]][]): number[] => [
  ...lenField(2, utf8(name)),
  ...attrs.flatMap(([k, v]) => lenField(3, kv(k, v))),
]

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
  ...(o.events ?? []).map((event) => lenField(11, eventBytes(event.name, event.attrs))).flat(),
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

  test("business attributes stored verbatim; secret keys dropped; token_count survives", async () => {
    const anyBool = (value: boolean): number[] => [...tag(2, 0), ...encVarint(value ? 1 : 0)]
    const body = requestBytes(
      scopeSpans("api", [
        spanBytes({
          attrs: [
            ["silent_dequeue_reason", anyString("SENDER_NOT_ALLOWED")],
            ["conversion_successful", anyBool(false)],
            ["token_count", anyInt(150)],
            ["shard", anyString("db-01")],
            ["password", anyString("hunter2")],
            ["api_key", anyString("AKIAIOSFODNN7EXAMPLE")],
            ["Authorization", anyString("Bearer xyz")],
            ["client_secret", anyString("shh")],
          ],
        }),
      ]),
    )
    const { text, spans } = await storeAndRead(body)
    expect(spans[0].attrs["silent_dequeue_reason"]).toBe("SENDER_NOT_ALLOWED")
    expect(spans[0].attrs["conversion_successful"]).toBe("false")
    expect(spans[0].attrs["token_count"]).toBe("150")
    expect(spans[0].attrs["shard"]).toBe("db-01")
    for (const needle of ["hunter2", "AKIAIOSFODNN7EXAMPLE", "Bearer xyz", "shh"]) {
      expect(text).not.toContain(needle)
    }
    for (const key of ["password", "api_key", "Authorization", "client_secret"]) {
      expect(spans[0].attrs).not.toHaveProperty(key)
    }
  })

  test("credential-shaped values mask; plain values survive verbatim", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"
    const hex40 = "9f3c1a7b2e4d8c6f1a2b3c4d5e6f708199aabbcc"
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            attrs: [
              ["auth_header", anyString("Bearer tok-abc")],
              ["id_token", anyString(jwt)],
              ["trace_seed", anyString(hex40)],
              ["note", anyString("ref=abc token=hunter2-x")],
              ["attempt", anyInt(42)],
            ],
          }),
        ]),
      ),
    )
    // H1: `auth` as a key segment denies outright (drop ⊃ mask — strictly
    // stronger, documented here like the earlier id_token migration).
    expect(spans[0].attrs).not.toHaveProperty("auth_header")
    // H1: token-family keys are denied outright (drop ⊃ mask — strictly stronger,
    // documented here, not silently weakened).
    expect(spans[0].attrs).not.toHaveProperty("id_token")
    expect(spans[0].attrs["trace_seed"]).toBe(":id")
    expect(spans[0].attrs["note"]).toBe("***")
    expect(spans[0].attrs["attempt"]).toBe("42")
  })

  test("H1+H3: token-family and synonym keys denied; token_count exempt", async () => {
    const body = requestBytes(
      scopeSpans("api", [
        spanBytes({
          attrs: [
            ["access_token", anyString("ya29.abc")],
            ["refresh_token", anyString("1//def")],
            ["session_token", anyString("sess-abc")],
            ["auth_token", anyString("aut-abc")],
            ["aws.access_key_id", anyString("AKIAIOSFODNN7EXAMPLE")],
            ["pwd", anyString("hunter2")],
            ["passphrase", anyString("correct horse")],
            ["token_count", anyInt(150)],
          ],
        }),
      ]),
    )
    const { text, spans } = await storeAndRead(body)
    for (const key of ["access_token", "refresh_token", "session_token", "auth_token", "aws.access_key_id", "pwd", "passphrase"]) {
      expect(spans[0].attrs).not.toHaveProperty(key)
    }
    // token_count is metadata, not a secret: exact-name exemption, locked here.
    expect(spans[0].attrs["token_count"]).toBe("150")
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("H2: provider credentials and PEM blocks mask to ***", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            attrs: [
              ["deploy_key", anyString("ghp_abc123DEF456")],
              ["stripe_key", anyString("sk_live_abc123XYZ")],
              ["aws_id", anyString("AKIAIOSFODNN7EXAMPLE")],
              ["tls_bundle", anyString(pem)],
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].attrs["deploy_key"]).toBe("***")
    expect(spans[0].attrs["stripe_key"]).toBe("***")
    expect(spans[0].attrs["aws_id"]).toBe("***")
    expect(spans[0].attrs["tls_bundle"]).toBe("***")
  })

  test("S1: query strings are stripped from name and values", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(scopeSpans("api", [spanBytes({ name: "GET /x?token=abc", attrs: [["url.path", anyString("/x?token=abc")]] })])),
    )
    expect(spans[0].name).toBe("GET /x")
    expect(spans[0].attrs["url.path"]).toBe("/x")
    expect(text).not.toContain("abc")
  })

  test("HIGH: dotted credential pairs mask; filename-line shapes survive", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            attrs: [
              ["cfg1", anyString("secret.value=hunter2")],
              ["cfg2", anyString("password.value=hunter2")],
              ["cfg3", anyString("auth.realm:hunter2")],
              ["src", anyString("Auth.java:7")],
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].attrs["cfg1"]).toBe("***")
    expect(spans[0].attrs["cfg2"]).toBe("***")
    expect(spans[0].attrs["cfg3"]).toBe("***")
    expect(spans[0].attrs["src"]).toBe("Auth.java:7")
    expect(text).not.toContain("hunter2")
  })

  test("S2/S3 sentinel: credential shapes never reach disk; short-ID structure is kept", async () => {
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
    // doctrine-C: the 20-char mixed segment is structure (short ID), kept verbatim;
    // the Bearer credential shape is a value and stays masked.
    expect(spans[0].name).toBe(`GET /reset/${sentinel}9f3c1a7b`)
    expect(spans[0].attrs["url.path"]).toBe(`/reset/${sentinel}9f3c1a7b`)
    expect(spans[0].attrs["http.route"]).toBe("Bearer ***")
    expect(text).toContain(sentinel)
  })

  test("doctrine-C: short IDs, slugs and words kept verbatim; templates pass through", async () => {
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({ name: "GET /orders/12345" }),
          spanBytes({ name: "GET /orders/{id}" }),
          spanBytes({ name: "GET /health" }),
          spanBytes({ name: "GET /api/v1/stations/query" }),
          spanBytes({ name: "GET /archive/2024/03/report" }),
        ]),
      ),
    )
    // doctrine-C: structure always — short numeric segments are route words, not IDs.
    expect(spans.map((s) => s.name)).toEqual([
      "GET /orders/12345",
      "GET /orders/{id}",
      "GET /health",
      "GET /api/v1/stations/query",
      "GET /archive/2024/03/report",
    ])
  })

  test("doctrine-C rule 3: UUID and ≥32-hex runs mask; slugs and short runs survive", async () => {
    const longHex = "9f3c1a7b2e4d8c6f1a2b3c4d5e6f7081"
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({ name: "GET /o/9f3c1a7b-2e4d-4c6f-8234-56789abcdef0/end" }),
          spanBytes({ name: `GET /f/${longHex}/end` }),
          spanBytes({ name: "GET /orders/42" }),
          spanBytes({ name: "GET /blog/hello-world-2024" }),
          spanBytes({ name: "GET /api/v2/status" }),
        ]),
      ),
    )
    expect(spans.map((s) => s.name)).toEqual([
      "GET /o/:id/end",
      "GET /f/:id/end",
      "GET /orders/42",
      "GET /blog/hello-world-2024",
      "GET /api/v2/status",
    ])
  })

  test("MEDIUM: hostile errorType masks; dotted class names verbatim", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({ events: [{ name: "exception", attrs: [["exception.type", anyString("password=hunter2")]] }] }),
          spanBytes({ spanId: "dd".repeat(8), events: [{ name: "exception", attrs: [["exception.type", anyString("com.example.Auth")]] }] }),
        ]),
      ),
    )
    expect(spans[0].errorType).toBe("***")
    expect(spans[1].errorType).toBe("com.example.Auth")
    expect(text).not.toContain("hunter2")
  })

  test("H2: double-encoded separators mask to fixpoint; lone-% never throws", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            name: "GET /login",
            attrs: [
              ["url.path", anyString("/reset/token%253Dabc123")],
              ["note", anyString("auth%253Dsekret")],
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].attrs["url.path"]).toBe("/reset/***")
    expect(spans[0].attrs["note"]).toBe("***")
    expect(text).not.toContain("%253D")
    expect(text).not.toContain("abc123")
  })

  test("H3: credential split across adjacent segments masks; normal paths verbatim", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            name: "GET /reset/password/s3cr3t-hunter-ABC",
            attrs: [["url.path", anyString("/reset/password/s3cr3t-hunter-ABC")]],
          }),
          spanBytes({ name: "GET /api/v1/stations/query" }),
          spanBytes({ name: "GET /oauth/token" }),
        ]),
      ),
    )
    expect(spans[0].name).toBe("GET /reset/***/***")
    expect(spans[0].attrs["url.path"]).toBe("/reset/***/***")
    expect(spans[1].name).toBe("GET /api/v1/stations/query")
    // oauth contains "auth" but never as a bounded word: protocol words survive.
    expect(spans[2].name).toBe("GET /oauth/token")
    expect(text).not.toContain("s3cr3t-hunter-ABC")
  })

  test("H4: card-number int dropped; plain counter and short expiry verbatim", async () => {
    const { spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            attrs: [
              ["card_number", anyInt(4111111111111111)],
              ["count", anyInt(12345)],
              ["card_exp_month", anyString("12")],
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].attrs).not.toHaveProperty("card_number")
    expect(spans[0].attrs["count"]).toBe("12345")
    expect(spans[0].attrs["card_exp_month"]).toBe("12")
  })

  test("exception event decodes type/message/frames sanitized; other events dropped", async () => {
    const stack = [
      "java.lang.NullPointerException: boom",
      "\tat com.example.Orders.get(Orders.java:42)",
      "\tat com.example.Auth.login(Auth.java:7) // Bearer tok-abc",
      "\tat com.example.Main.main(Main.java:3)",
    ].join("\n")
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            status: 2,
            events: [
              { name: "click", attrs: [["foo", anyString("bar")]] },
              {
                name: "exception",
                attrs: [
                  ["exception.type", anyString("java.lang.NullPointerException")],
                  ["exception.message", anyString("login failed for password=hunter2")],
                  ["exception.stacktrace", anyString(stack)],
                ],
              },
            ],
          }),
        ]),
      ),
    )
    expect(spans[0].status).toBe("error")
    expect(spans[0].errorType).toBe("java.lang.NullPointerException")
    expect(spans[0].errorMessage).toBe("***")
    expect(spans[0].errorFrames).toEqual([
      "Orders.java:42 in com.example.Orders.get",
      "Auth.java:7 in com.example.Auth.login",
      "Main.java:3 in com.example.Main.main",
    ])
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("tok-abc")
    expect(text).not.toContain("boom")
  })

  test("python stacktrace reduces to file:line in function; only first 4 events kept", async () => {
    const stack = (n: number): string =>
      `Traceback (most recent call last):\n${Array.from({ length: n }, (_, i) => `  File "/app/svc.py", line ${10 + i}, in handle\n    do_${i}()`).join("\n")}`
    const events = Array.from({ length: 6 }, (_, i) => ({
      name: "exception",
      attrs: [
        ["exception.type", anyString(i === 0 ? "ValueError" : "Other")],
        ["exception.stacktrace", anyString(stack(4))],
      ] as [string, number[]][],
    }))
    const { spans } = await storeAndRead(requestBytes(scopeSpans("api", [spanBytes({ events })])))
    expect(spans[0].errorType).toBe("ValueError")
    expect(spans[0].errorFrames?.slice(0, 5)).toEqual([
      "/app/svc.py:10 in handle",
      "/app/svc.py:11 in handle",
      "/app/svc.py:12 in handle",
      "/app/svc.py:13 in handle",
      "/app/svc.py:10 in handle",
    ])
    // 6 events × 4 frames, first 4 events kept (16 parsed): whole events past
    // the cap never parse, matching the silent 16-attr-cap precedent.
    expect(spans[0].errorFrames?.at(-1)).toBe("+11")
  })

  test("hostile frame shapes mask: key=value function, provider token, long hex path", async () => {
    const hex = "9f3c1a7b2e4d8c6f1a2b3c4d5e6f708199aabbcc"
    const stack = [
      `  File "/app/pay.py", line 4, in password=hunter2`,
      `  File "/app/ghp_abcdefghijklmnopqrstuvwxyz0123/x.py", line 5, in charge`,
      `  File "/app/${hex}/y.py", line 6, in save`,
    ].join("\n")
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            status: 2,
            events: [{ name: "exception", attrs: [["exception.stacktrace", anyString(stack)]] }],
          }),
        ]),
      ),
    )
    expect(spans[0].errorFrames).toEqual(["/app/***", "/app/***/x.py:5 in charge", "/app/:id/y.py:6 in save"])
    for (const needle of ["hunter2", "ghp_abcdef", hex]) expect(text).not.toContain(needle)
  })

  test("hostile message shapes mask: Bearer, long token", async () => {
    const { text, spans } = await storeAndRead(
      requestBytes(
        scopeSpans("api", [
          spanBytes({
            events: [{ name: "exception", attrs: [["exception.message", anyString("auth failed: Bearer tok-abc")]] }],
          }),
          spanBytes({
            spanId: "dd".repeat(8),
            events: [
              {
                name: "exception",
                attrs: [["exception.message", anyString("seed 9f3c1a7b2e4d8c6f1a2b3c4d5e6f708199aabbcc end")]],
              },
            ],
          }),
        ]),
      ),
    )
    // First-nonempty message wins per span; both hostile values mask.
    expect(spans[0].errorMessage).toBe("auth failed: Bearer ***")
    expect(spans[1].errorMessage).toBe("seed :id end")
    expect(text).not.toContain("tok-abc")
    expect(text).not.toContain("9f3c1a7b2e4d8c6f1a2b3c4d5e6f708199aabbcc")
  })

  test("rows without exception fields parse exactly as before (additive-optional)", async () => {
    const spans = decodeTraceRequest(requestBytes(scopeSpans("api", [spanBytes({})])))
    expect(spans.length).toBe(1)
    expect("errorType" in spans[0]).toBe(false)
    expect("errorMessage" in spans[0]).toBe(false)
    expect("errorFrames" in spans[0]).toBe(false)
    const frozen = JSON.parse(
      '{"t":"2026-10-08T00:00:01.000Z","traceId":"abababababababababababababababab","spanId":"cdcdcdcdcdcdcdcd","parentSpanId":null,"service":"api","name":"GET /api/x","kind":"server","startNano":"1000000000","endNano":"1012400000","durMs":12.4,"status":"unset","attrs":{}}',
    ) as TraceSpan
    expect(selectValidSpans([frozen])).toEqual([frozen])
  })

  test("lone or malformed % never throws and is stored verbatim", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile)
      const decoded = decodeTraceRequest(
        requestBytes(
          scopeSpans("api", [spanBytes({ name: "GET /100% legit" }), spanBytes({ name: "GET /x%ZZy" })]),
        ),
      )
      for (const span of decoded) store.append(span)
      await store.flush()
      expect(decoded.map((s) => s.name)).toEqual(["GET /100% legit", "GET /x%ZZy"])
      expect(await readFile(spansFile, "utf8")).toContain("GET /100% legit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile service name: query stripped, credential shapes masked, short-ID structure kept", async () => {
    const sentinel = "ZZSENTINELZZ"
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile)
      const body = requestBytes(scopeSpans(`/reset/${sentinel}9f3c1a7b?token=abc`, [spanBytes({})]))
      const spans = decodeTraceRequest(body)
      for (const span of spans) store.append(span)
      await store.flush()
      // doctrine-C: S1 strips ?token=abc; the remaining 20-char segment is structure, kept verbatim.
      expect(spans[0].service).toBe(`/reset/${sentinel}9f3c1a7b`)
      expect(await readFile(spansFile, "utf8")).not.toContain("token=abc")
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
