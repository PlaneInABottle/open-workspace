/** OTLP/HTTP protobuf decode: `ExportTraceServiceRequest` → `TraceSpan[]`.
 * Generic wire-format walker (no codegen, no dependency): only the V8 field
 * numbers are interpreted, unknown fields are skipped by wire type, never
 * fatal. Key allowlist (A3) + value sanitizer (S1–S6) run here, before the
 * byte cap, so nothing secret-bearing reaches the store.
 *
 * Wire input is untrusted: every read is bounds-checked and failures throw
 * `TraceDecodeError` carrying only a reason code, a field-number path and
 * byte offset/length — never payload bytes (S6). */

export type TraceSpanStatus = "unset" | "ok" | "error"

export type TraceSpan = {
  t: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  service: string
  name: string
  kind: string
  startNano: string
  endNano: string
  durMs: number
  status: TraceSpanStatus
  attrs: Record<string, string>
}

/** Bounded decode failure: reason code + field-number path + offset/length.
 * The message embeds numbers and tags only — never body content (S6). */
export class TraceDecodeError extends Error {
  readonly reason: string
  readonly path: string
  readonly offset: number
  readonly length: number
  constructor(reason: string, path: string, offset: number, length: number) {
    super(`trace çözümlenemedi: ${reason} (${path}, offset=${offset}, len=${length})`)
    this.name = "TraceDecodeError"
    this.reason = reason
    this.path = path
    this.offset = offset
    this.length = length
  }
}

/** Recursion guard: legitimate OTLP nests ≤6 deep; deeper means hostile or
 * malformed input. A fourth bounded code (the S6 list names the three
 * content-driven ones); still numbers-and-tags only, never content. */
const MAX_MESSAGE_DEPTH = 32

class Reader {
  readonly buf: Uint8Array
  pos = 0
  constructor(
    buf: Uint8Array,
    readonly path: string,
    readonly depth: number = 0,
    readonly maxDepth: number = MAX_MESSAGE_DEPTH,
  ) {
    this.buf = buf
  }
  eof(): boolean {
    return this.pos >= this.buf.length
  }
  readVarint(field: string): bigint {
    let shift = 0n
    let result = 0n
    for (let i = 0; i < 10; i += 1) {
      if (this.pos >= this.buf.length) {
        throw new TraceDecodeError("truncated-varint", `${this.path}.${field}`, this.pos, this.buf.length - this.pos)
      }
      const byte = this.buf[this.pos]
      this.pos += 1
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
    throw new TraceDecodeError("truncated-varint", `${this.path}.${field}`, this.pos, 0)
  }
  readFixed64(field: string): bigint {
    if (this.pos + 8 > this.buf.length) {
      throw new TraceDecodeError("unexpected-eof", `${this.path}.${field}`, this.pos, this.buf.length - this.pos)
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8)
    this.pos += 8
    return view.getBigUint64(0, true)
  }
  readLen(field: string): Uint8Array {
    const length = this.readVarint(field)
    if (length > BigInt(this.buf.length)) {
      throw new TraceDecodeError("unexpected-eof", `${this.path}.${field}`, this.pos, this.buf.length - this.pos)
    }
    const end = this.pos + Number(length)
    if (end > this.buf.length) {
      throw new TraceDecodeError("unexpected-eof", `${this.path}.${field}`, this.pos, this.buf.length - this.pos)
    }
    const out = this.buf.subarray(this.pos, end)
    this.pos = end
    return out
  }
  skip(wire: number, field: number): void {
    if (wire === 0) {
      this.readVarint(`field=${field}`)
      return
    }
    if (wire === 1) {
      if (this.pos + 8 > this.buf.length) {
        throw new TraceDecodeError("unexpected-eof", `${this.path}.field=${field}`, this.pos, this.buf.length - this.pos)
      }
      this.pos += 8
      return
    }
    if (wire === 2) {
      this.readLen(`field=${field}`)
      return
    }
    if (wire === 5) {
      if (this.pos + 4 > this.buf.length) {
        throw new TraceDecodeError("unexpected-eof", `${this.path}.field=${field}`, this.pos, this.buf.length - this.pos)
      }
      this.pos += 4
      return
    }
    throw new TraceDecodeError("bad-wiretype", `${this.path}.field=${field}`, this.pos, this.buf.length - this.pos)
  }
  child(bytes: Uint8Array, path: string): Reader {
    if (this.depth + 1 > this.maxDepth) {
      throw new TraceDecodeError("too-deep", path, 0, bytes.length)
    }
    return new Reader(bytes, path, this.depth + 1, this.maxDepth)
  }
}

type Field = { field: number; wire: number; varint: bigint | null; fixed: bigint | null; bytes: Uint8Array | null }

/** Eagerly parse one message's fields; unknown fields are consumed by wire
 * type (their values discarded). Throws only on truncated data or an
 * illegal wire type (6/7). A known field with an unexpected wire type is
 * left in place and ignored by the typed decoder — never fatal. */
const readFields = (reader: Reader): Field[] => {
  const out: Field[] = []
  while (!reader.eof()) {
    const tag = reader.readVarint("tag")
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      out.push({ field, wire, varint: reader.readVarint(`field=${field}`), fixed: null, bytes: null })
    } else if (wire === 1) {
      out.push({ field, wire, varint: null, fixed: reader.readFixed64(`field=${field}`), bytes: null })
    } else if (wire === 2) {
      out.push({ field, wire, varint: null, fixed: null, bytes: reader.readLen(`field=${field}`) })
    } else if (wire === 5) {
      reader.skip(5, field)
      out.push({ field, wire, varint: null, fixed: null, bytes: null })
    } else {
      throw new TraceDecodeError("bad-wiretype", `${reader.path}.field=${field}`, reader.pos, reader.buf.length - reader.pos)
    }
  }
  return out
}

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex")

const firstLen = (fields: Field[], field: number): Uint8Array | null => {
  for (const entry of fields) {
    if (entry.field === field && entry.wire === 2 && entry.bytes !== null) return entry.bytes
  }
  return null
}

const firstVarint = (fields: Field[], field: number): bigint | null => {
  for (const entry of fields) {
    if (entry.field === field && entry.wire === 0 && entry.varint !== null) return entry.varint
  }
  return null
}

const firstFixed = (fields: Field[], field: number): bigint | null => {
  for (const entry of fields) {
    if (entry.field === field && entry.wire === 1 && entry.fixed !== null) return entry.fixed
  }
  return null
}

/** A3 — exact-key allowlist. Everything else (url.full, db.query.text,
 * http.request.header.*, exception.message, …) is dropped before storage. */
const ATTR_ALLOWLIST = new Set([
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
  "exception.type",
])

/** S1 — strip everything from the first `?` or `#`. */
const stripQuery = (value: string): string => {
  const query = value.indexOf("?")
  const fragment = value.indexOf("#")
  const cut = query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment)
  return cut < 0 ? value : value.slice(0, cut)
}

const looksTemplated = (segment: string): boolean =>
  segment === "*" || /^\{[^/{}]*\}$/.test(segment) || /^:[A-Za-z0-9_]+$/.test(segment)

/** S2 — a `/`-separated segment is an identifier (→ `:id`) when it is pure
 * digits, hex ≥8 chars, a UUID, or length ≥16 mixed alphanumerics. Route
 * words and already-templated segments pass through. Lossy by design. */
const isIdentifierSegment = (segment: string): boolean => {
  if (segment.length === 0 || looksTemplated(segment)) return false
  if (/^[0-9]+$/.test(segment)) return true
  if (/^[0-9a-fA-F]{8,}$/.test(segment)) return true
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) return true
  if (segment.length >= 16 && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)) {
    return true
  }
  return false
}

const maskPathSegments = (value: string): string =>
  value
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ":id" : segment))
    .join("/")

/** S3 — credential-bearing forms masked wholesale: `Bearer <token>` keeps
 * only the scheme word, `key=secret`-shaped values and `user:pass@host`
 * authorities become `***`. */
const maskCredentials = (value: string): string => {
  if (/^\s*Bearer\s+\S/.test(value)) return "Bearer ***"
  if (/^[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth|credential)[A-Za-z0-9_.-]*\s*[:=]\s*\S+\s*$/i.test(value)) {
    return "***"
  }
  if (/\/\/[^/\s]*:[^@/\s]+@[^\s/]+/.test(value) || /^\S+:\S+@\S+$/.test(value)) return "***"
  return value
}

/** S5 — byte cap last (mirrors the `truncateLogLine` shape), so truncation
 * can never be the thing that "hides" a secret. */
const truncateBytes = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let output = ""
  for (const ch of value) {
    if (Buffer.byteLength(output + ch, "utf8") > maxBytes) break
    output += ch
  }
  return `${output}…[kesildi]…`
}

const sanitizeName = (name: string, maxBytes: number): string =>
  truncateBytes(maskCredentials(maskPathSegments(stripQuery(name))), maxBytes)

const sanitizeAttrValue = (key: string, value: string, maxBytes: number): string => {
  const stripped = stripQuery(value)
  const shaped = key === "url.path" ? maskPathSegments(stripped) : stripped
  return truncateBytes(maskCredentials(shaped), maxBytes)
}

/** AnyValue → scalar string, or null for composite (array/kvlist) values,
 * which are dropped. Bools and numbers become their decimal text (S4: enum
 * and numeric values pass through unchanged). */
const decodeAnyValue = (reader: Reader, bytes: Uint8Array): string | null => {
  const fields = readFields(reader.child(bytes, `${reader.path}.value`))
  for (const entry of fields) {
    if (entry.field === 1 && entry.wire === 2 && entry.bytes !== null) return textOf(entry.bytes)
    if (entry.field === 2 && entry.wire === 0 && entry.varint !== null) return entry.varint === 0n ? "false" : "true"
    if (entry.field === 3 && entry.wire === 0 && entry.varint !== null) {
      const signed = entry.varint >= 1n << 63n ? entry.varint - (1n << 64n) : entry.varint
      return signed.toString()
    }
    if (entry.field === 4 && entry.wire === 1 && entry.fixed !== null) {
      const view = new DataView(new ArrayBuffer(8))
      view.setBigUint64(0, entry.fixed, true)
      return String(view.getFloat64(0, true))
    }
  }
  return null
}

const decodeKeyValue = (reader: Reader, bytes: Uint8Array): { key: string; value: string } | null => {
  const fields = readFields(reader.child(bytes, `${reader.path}.attr`))
  const keyBytes = firstLen(fields, 1)
  const valueBytes = firstLen(fields, 2)
  if (keyBytes === null || valueBytes === null) return null
  const value = decodeAnyValue(reader, valueBytes)
  if (value === null) return null
  return { key: textOf(keyBytes), value }
}

/** Status.code is field 3; the message is dropped (code only). */
const decodeStatus = (reader: Reader, bytes: Uint8Array): TraceSpanStatus => {
  const fields = readFields(reader.child(bytes, `${reader.path}.status`))
  const code = firstVarint(fields, 3)
  if (code === 1n) return "ok"
  if (code === 2n) return "error"
  return "unset"
}

const KIND_NAMES = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const

const decodeSpan = (
  reader: Reader,
  bytes: Uint8Array,
  index: number,
  service: string,
  attrMaxCount: number,
  attrValueMaxBytes: number,
  nameMaxBytes: number,
): TraceSpan | null => {
  const path = `${reader.path}.spans[${index}]`
  const fields = readFields(reader.child(bytes, path))
  const traceBytes = firstLen(fields, 1)
  const spanBytes = firstLen(fields, 2)
  if (traceBytes === null || traceBytes.length === 0 || spanBytes === null || spanBytes.length === 0) return null
  const parentBytes = firstLen(fields, 4)
  const nameBytes = firstLen(fields, 5)
  const kind = firstVarint(fields, 6)
  const start = firstFixed(fields, 7) ?? 0n
  const end = firstFixed(fields, 8) ?? 0n
  const attrs: Record<string, string> = {}
  let kept = 0
  for (const entry of fields) {
    if (entry.field !== 9 || entry.wire !== 2 || entry.bytes === null || kept >= attrMaxCount) continue
    let pair: { key: string; value: string } | null
    try {
      pair = decodeKeyValue(reader, entry.bytes)
    } catch {
      continue
    }
    if (pair === null || !ATTR_ALLOWLIST.has(pair.key) || pair.key in attrs) continue
    attrs[pair.key] = sanitizeAttrValue(pair.key, pair.value, attrValueMaxBytes)
    kept += 1
  }
  let status: TraceSpanStatus = "unset"
  const statusBytes = firstLen(fields, 15)
  if (statusBytes !== null) {
    try {
      status = decodeStatus(reader, statusBytes)
    } catch {
      status = "unset"
    }
  }
  const kindIndex = kind === null ? 0 : Number(kind)
  const startNano = start.toString()
  const endNano = end.toString()
  return {
    t: new Date(Number(start / 1_000_000n)).toISOString(),
    traceId: hexOf(traceBytes),
    spanId: hexOf(spanBytes),
    parentSpanId: parentBytes === null || parentBytes.length === 0 ? null : hexOf(parentBytes),
    service,
    name: sanitizeName(nameBytes === null ? "" : textOf(nameBytes), nameMaxBytes),
    kind: KIND_NAMES[kindIndex] ?? "unspecified",
    startNano,
    endNano,
    durMs: end >= start ? Number(end - start) / 1e6 : 0,
    status,
    attrs,
  }
}

/** ResourceSpans field-1 is the `Resource` message (a sequence of
 * field-1 `KeyValue` entries); decode each entry directly. The service name
 * runs the same sanitize shape as span names (S1 strip, S2 segment
 * masking, S3 credential masking, S5 byte cap). Best-effort: failures keep
 * the `"bilinmeyen"` fallback and the spans still decode. */
const decodeServiceName = (reader: Reader, resourceBytes: Uint8Array, attrValueMaxBytes: number): string => {
  let fields: Field[]
  try {
    fields = readFields(reader.child(resourceBytes, `${reader.path}.resource`))
  } catch {
    return "bilinmeyen"
  }
  for (const entry of fields) {
    if (entry.field !== 1 || entry.wire !== 2 || entry.bytes === null) continue
    try {
      const pair = decodeKeyValue(reader, entry.bytes)
      if (pair !== null && pair.key === "service.name" && pair.value.length > 0) {
        return sanitizeName(pair.value, attrValueMaxBytes)
      }
    } catch {
      // best-effort; the spans still decode
    }
  }
  return "bilinmeyen"
}

export type TraceDecodeLimits = {
  attrMaxCount?: number
  attrValueMaxBytes?: number
  nameMaxBytes?: number
  /** Message-nesting guard, default 32. Legitimate OTLP nests ≤6 deep, so
   * the default is unreachable through `decodeTraceRequest` (deeper bytes
   * are skipped iteratively); the override exists to keep the guard itself
   * test-covered. */
  maxDepth?: number
}

/** Decode a full `ExportTraceServiceRequest` body. Spans without a trace or
 * span id are skipped (they cannot group); everything else degrades to
 * defaults. Unknown fields are ignored. Throws `TraceDecodeError` only. */
export const decodeTraceRequest = (body: Uint8Array, limits: TraceDecodeLimits = {}): TraceSpan[] => {
  const attrMaxCount = limits.attrMaxCount ?? 16
  const attrValueMaxBytes = limits.attrValueMaxBytes ?? 256
  const nameMaxBytes = limits.nameMaxBytes ?? 256
  const reader = new Reader(body, "resource_spans", 0, limits.maxDepth ?? MAX_MESSAGE_DEPTH)
  const spans: TraceSpan[] = []
  let resourceIndex = 0
  for (const entry of readFields(reader)) {
    if (entry.field !== 1 || entry.wire !== 2 || entry.bytes === null) continue
    const resourcePath = `resource_spans[${resourceIndex}]`
    resourceIndex += 1
    const resourceReader = reader.child(entry.bytes, resourcePath)
    const resourceFields = readFields(resourceReader)
    const resourceBytes = firstLen(resourceFields, 1)
    const service = resourceBytes === null ? "bilinmeyen" : decodeServiceName(resourceReader, resourceBytes, attrValueMaxBytes)
    let scopeIndex = 0
    for (const scopeEntry of resourceFields) {
      if (scopeEntry.field !== 2 || scopeEntry.wire !== 2 || scopeEntry.bytes === null) continue
      const scopePath = `${resourcePath}.scope_spans[${scopeIndex}]`
      scopeIndex += 1
      const scopeReader = resourceReader.child(scopeEntry.bytes, scopePath)
      let spanIndex = 0
      for (const spanEntry of readFields(scopeReader)) {
        if (spanEntry.field !== 2 || spanEntry.wire !== 2 || spanEntry.bytes === null) continue
        const span = decodeSpan(scopeReader, spanEntry.bytes, spanIndex, service, attrMaxCount, attrValueMaxBytes, nameMaxBytes)
        spanIndex += 1
        if (span !== null) spans.push(span)
      }
    }
  }
  return spans
}
