/** `ow timeline` acceptance: join of agent sidecar rows with OTLP spans.
 * All fixtures travel the REAL paths — sidecar JSONL through `joinSession`,
 * spans hand-encoded as protobuf through `decodeTraceRequest` into the real
 * store — against an isolated log file and an unreachable dbPath (the join
 * degrades to records-without-intent with warnings, by design). */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseArgs, run } from "./cli"
import { createTraceStore } from "./trace-store"
import { decodeTraceRequest } from "./trace-otlp"
import { extractTraceIds, runTimeline } from "./trace-timeline"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-timeline-"))

// --- Minimal protobuf encoder (V8 field map, same shape as the trace tests) ---

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
const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, anyString(value))]

type SpanOpts = {
  traceId: string
  spanId: string
  parent?: string
  name: string
  service: string
  startMs: number
  endMs: number
}

const spanBytes = (o: SpanOpts): number[] => [
  ...lenField(1, rawHex(o.traceId)),
  ...lenField(2, rawHex(o.spanId)),
  ...(o.parent ? lenField(4, rawHex(o.parent)) : []),
  ...lenField(5, utf8(o.name)),
  ...tag(6, 0),
  ...encVarint(2),
  ...tag(7, 1),
  ...fixed64(BigInt(o.startMs) * 1_000_000n),
  ...tag(8, 1),
  ...fixed64(BigInt(o.endMs) * 1_000_000n),
]

const requestBytes = (service: string, spans: SpanOpts[]): Uint8Array =>
  new Uint8Array(lenField(1, [...lenField(1, lenField(1, kv("service.name", service))), ...lenField(2, spans.flatMap((s) => lenField(2, spanBytes(s))))]))

const TRACE_A = `a1b2c3d4${"0".repeat(24)}`
const TRACE_B = `b1b2c3d4${"0".repeat(24)}`
const SPAN_A = "11".repeat(8)

type SidecarOpts = { session: string; at: number; command?: string; outcome?: string }

const sidecarRow = (o: SidecarOpts): string =>
  JSON.stringify({ sessionID: o.session, timestamp: new Date(o.at).toISOString(), command: o.command ?? "echo hi", outcome: o.outcome ?? "success" })

const seedSpans = async (root: string, body: Uint8Array, extraLines: string[] = []): Promise<void> => {
  const spansFile = join(root, ".ow", "traces", "spans.jsonl")
  await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
  const store = createTraceStore(spansFile)
  for (const span of decodeTraceRequest(body)) store.append(span)
  await store.flush()
  if (extraLines.length > 0) {
    const { appendFile } = await import("node:fs/promises")
    for (const line of extraLines) await appendFile(spansFile, `${line}\n`)
  }
}

const tlOpts = (root: string, log: string, extra: Record<string, unknown> = {}) => ({
  rootDir: root,
  logPath: log,
  dbPath: join(root, "missing.db"),
  sessionID: "ses_tl",
  ...extra,
})

describe("trace-timeline id extraction", () => {
  test("W3C traceparent yields the middle 32; bare hex too; lowercased", () => {
    const upper = "A1B2C3D4E5F60718293A4B5C6D7E8F90"
    expect(extractTraceIds([`curl -H 'traceparent: 00-${upper}-0102030405060708-01' http://x`])).toEqual([
      upper.toLowerCase(),
    ])
    expect(extractTraceIds([`export TID=${upper} && ./run.sh`])).toEqual([upper.toLowerCase()])
    expect(extractTraceIds(["echo hi"])).toEqual([])
  })
})

describe("trace-timeline exact links", () => {
  test("W3C traceparent in command groups its spans under the agent row (exact)", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(
        log,
        [
          sidecarRow({ session: "ses_tl", at: now - 5000, command: `curl -H 'traceparent: 00-${TRACE_A}-0102030405060708-01' http://127.0.0.1:18081/orders` }),
          sidecarRow({ session: "ses_tl", at: now - 3000, command: "echo plain" }),
        ].join("\n") + "\n",
      )
      await seedSpans(
        root,
        requestBytes("api", [
          { traceId: TRACE_A, spanId: SPAN_A, name: "GET /orders/list", service: "api", startMs: now - 4500, endMs: now - 4000 },
        ]),
      )
      await seedSpans(
        root,
        requestBytes("worker", [
          { traceId: TRACE_A, spanId: "22".repeat(8), parent: SPAN_A, name: "SELECT orders", service: "worker", startMs: now - 4400, endMs: now - 4100 },
        ]),
      )
      const result = await runTimeline(tlOpts(root, log))
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      const agentIdx = lines.findIndex((line) => line.includes("AGENT") && line.includes("curl -H"))
      const span1Idx = lines.findIndex((line) => line.includes("[api] GET /orders/list"))
      const span2Idx = lines.findIndex((line) => line.includes("[worker] SELECT orders"))
      expect(agentIdx).toBeGreaterThanOrEqual(0)
      expect(span1Idx).toBeGreaterThan(agentIdx)
      expect(span2Idx).toBeGreaterThan(span1Idx)
      expect(lines[span1Idx]).toContain("[exact]")
      expect(lines[span2Idx]).toContain("[exact]")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bare 32-hex command groups too", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(log, `${sidecarRow({ session: "ses_tl", at: now - 5000, command: `curl http://127.0.0.1:18081/r/${TRACE_B}` })}\n`)
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_B, spanId: "33".repeat(8), name: "GET /r", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      const result = await runTimeline(tlOpts(root, log))
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("[exact]")
      expect(result.stdout).toContain("curl <url>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-timeline estimated links", () => {
  test("unreferenced span 3s from a row links estimated; 60s away links nothing", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(
        log,
        [
          sidecarRow({ session: "ses_tl", at: now - 90000, command: "echo old" }),
          sidecarRow({ session: "ses_tl", at: now - 3000, command: "echo near" }),
        ].join("\n") + "\n",
      )
      const nearId = `c3c3c3c3${"0".repeat(24)}`
      const farId = `d4d4d4d4${"0".repeat(24)}`
      await seedSpans(root, requestBytes("api", [
        { traceId: nearId, spanId: "44".repeat(8), name: "GET /near", service: "api", startMs: now, endMs: now + 100 },
      ]))
      await seedSpans(root, requestBytes("api", [
        { traceId: farId, spanId: "55".repeat(8), name: "GET /far", service: "api", startMs: now + 60000, endMs: now + 60100 },
      ]))
      const result = await runTimeline(tlOpts(root, log))
      expect(result.code).toBe(0)
      const nearLine = result.stdout.split("\n").find((line) => line.includes("GET /near")) ?? ""
      const farLine = result.stdout.split("\n").find((line) => line.includes("GET /far")) ?? ""
      expect(nearLine).toContain("[estimated]")
      expect(farLine).not.toContain("[estimated]")
      expect(farLine).not.toContain("[exact]")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-timeline --trace filter", () => {
  test("exact id and 8-hex prefix render the linked group", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(log, `${sidecarRow({ session: "ses_tl", at: now - 5000, command: `curl http://127.0.0.1:18081/r/${TRACE_A}` })}\n`)
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_A, spanId: "66".repeat(8), name: "GET /a", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_B, spanId: "77".repeat(8), name: "GET /b", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      for (const id of [TRACE_A, TRACE_A.slice(0, 8)]) {
        const result = await runTimeline(tlOpts(root, log, { traceId: id }))
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("GET /a")
        expect(result.stdout).not.toContain("GET /b")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ambiguous prefix exits 2; unknown id exits 0 quiet-empty", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(log, `${sidecarRow({ session: "ses_tl", at: now - 5000, command: "echo hi" })}\n`)
      const shared = "a1b2c3d4"
      await seedSpans(root, requestBytes("api", [
        { traceId: `${shared}${"0".repeat(24)}`, spanId: "66".repeat(8), name: "GET /a", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      await seedSpans(root, requestBytes("api", [
        { traceId: `${shared}${"f".repeat(24)}`, spanId: "77".repeat(8), name: "GET /b", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      const ambiguous = await runTimeline(tlOpts(root, log, { traceId: shared }))
      expect(ambiguous.code).toBe(2)
      expect(ambiguous.stderr).toContain("2 candidates")
      const unknown = await runTimeline(tlOpts(root, log, { traceId: "deadbeef".repeat(4) }))
      expect(unknown.code).toBe(0)
      expect(unknown.stdout).toContain("trace not found")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("malformed --trace id exits 2 without touching the filesystem", async () => {
    const root = await tempRoot()
    try {
      const bad = await runTimeline(tlOpts(root, join(root, "events.jsonl"), { traceId: "xyz" }))
      expect(bad.code).toBe(2)
      expect(bad.stderr).toContain("invalid trace id")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-timeline json + bounds + empty", () => {
  test("--json keys are exact English; tail caps rendered lines", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(log, `${sidecarRow({ session: "ses_tl", at: now - 5000, command: "echo hi" })}\n`)
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_A, spanId: "88".repeat(8), name: "GET /a", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      const result = await runTimeline(tlOpts(root, log, { json: true }))
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { events: Record<string, unknown>[]; warnings: unknown[] }
      expect(Object.keys(parsed).sort()).toEqual(["events", "warnings"])
      expect(Array.isArray(parsed.warnings)).toBe(true)
      for (const event of parsed.events) {
        expect(Object.keys(event).every((key) => ["ts", "kind", "text", "traceId", "confidence", "depth"].includes(key))).toBe(true)
      }
      expect(JSON.stringify(parsed)).not.toMatch(/izleme|servis|kesin|tahmini|k\u00f6k/)
      expect(JSON.stringify(parsed)).not.toMatch(/[\u00e7\u011f\u0131\u015f\u00f6\u00fc\u00c7\u011e\u0130\u015e\u00d6\u00dc]/)
      const tailed = await runTimeline(tlOpts(root, log, { tail: 1 }))
      expect(tailed.stdout.split("\n").length).toBe(1)
      const nanTail = await runTimeline(tlOpts(root, log, { tail: NaN }))
      expect(nanTail.stdout.split("\n").length).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("empty inputs exit 0 quiet in both shapes", async () => {
    const root = await tempRoot()
    try {
      const human = await runTimeline(tlOpts(root, join(root, "nope.jsonl"), { sessionID: undefined }))
      expect(human.code).toBe(0)
      expect(human.stdout).toBe("no timeline")
      const asJson = await runTimeline(tlOpts(root, join(root, "nope.jsonl"), { sessionID: undefined, json: true }))
      expect(asJson.code).toBe(0)
      expect(asJson.stdout).toBe('{"events":[],"warnings":[]}')
      const noSpans = await runTimeline(tlOpts(root, join(root, "nope2.jsonl")))
      expect(noSpans.code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt span and sidecar lines are skipped, rest renders", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(log, `corrupt-line{{{\n${sidecarRow({ session: "ses_tl", at: now - 5000, command: "echo hi" })}\n`)
      await seedSpans(
        root,
        requestBytes("api", [
          { traceId: TRACE_A, spanId: "99".repeat(8), name: "GET /ok", service: "api", startMs: now - 4500, endMs: now - 4000 },
        ]),
        ["corrupt-span{{{line"],
      )
      const result = await runTimeline(tlOpts(root, log))
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("GET /ok")
      expect(result.stdout).toContain("echo <arg>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("secret-shaped command text never leaks raw values", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(
        log,
        `${sidecarRow({ session: "ses_tl", at: now - 5000, command: `export DB_PASSWORD=hunter2-x && curl http://127.0.0.1:18081/r/${TRACE_A}` })}\n`,
      )
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_A, spanId: "a0".repeat(8), name: "GET /r", service: "api", startMs: now - 4500, endMs: now - 4000 },
      ]))
      const result = await runTimeline(tlOpts(root, log))
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("[exact]")
      expect(result.stdout).not.toContain("hunter2-x")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-timeline LIVE PROOF (scripted end-to-end)", () => {
  test("3 sidecar rows + 2 real-writer spans render one grouped exact block", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      const log = join(root, "events.jsonl")
      await writeFile(
        log,
        [
          sidecarRow({ session: "ses_tl", at: now - 90000, command: `curl -H 'traceparent: 00-${TRACE_A}-0a0b0c0d0e0f1011-01' http://127.0.0.1:18081/orders` }),
          sidecarRow({ session: "ses_tl", at: now - 80000, command: "echo plain" }),
          sidecarRow({ session: "ses_tl", at: now - 20000, command: "echo later" }),
        ].join("\n") + "\n",
      )
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_A, spanId: "b0".repeat(8), name: "GET /orders/list", service: "api", startMs: now - 89000, endMs: now - 88500 },
      ]))
      await seedSpans(root, requestBytes("worker", [
        { traceId: TRACE_A, spanId: "b1".repeat(8), parent: "b0".repeat(8), name: "SELECT orders", service: "worker", startMs: now - 88800, endMs: now - 88600 },
      ]))
      const human = await runTimeline(tlOpts(root, log))
      expect(human.code).toBe(0)
      const lines = human.stdout.split("\n")
      expect(lines.length).toBe(5)
      expect(lines[0]).toContain("AGENT")
      expect(lines[0]).toContain("curl -H")
      expect(lines[1]).toContain("[api] GET /orders/list")
      expect(lines[1]).toContain("[exact]")
      expect(lines[2]).toContain("[worker] SELECT orders")
      expect(lines[2]).toContain("[exact]")
      const asJson = await runTimeline(tlOpts(root, log, { json: true }))
      const parsed = JSON.parse(asJson.stdout) as {
        events: { kind: string; confidence?: string; depth?: number; traceId?: string }[]
      }
      const traces = parsed.events.filter((event) => event.kind === "trace")
      expect(traces.length).toBe(2)
      expect(traces.every((event) => event.confidence === "exact")).toBe(true)
      expect(traces.map((event) => event.depth).sort()).toEqual([0, 1])
      expect(traces.every((event) => event.traceId === TRACE_A)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace-timeline cross-trace depths (L2)", () => {
  test("shared spanId gets per-trace depths, not first-wins", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      // Trace A: shared id is the root (depth 0). Trace B: same id is a child (depth 1).
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_A, spanId: "aa".repeat(8), name: "GET /a-root", service: "api", startMs: now - 9000, endMs: now - 8900 },
        { traceId: TRACE_A, spanId: "ab".repeat(8), parent: "aa".repeat(8), name: "GET /a-child", service: "api", startMs: now - 8900, endMs: now - 8800 },
      ]))
      await seedSpans(root, requestBytes("api", [
        { traceId: TRACE_B, spanId: "bb".repeat(8), name: "GET /b-root", service: "api", startMs: now - 9000, endMs: now - 8900 },
        { traceId: TRACE_B, spanId: "aa".repeat(8), parent: "bb".repeat(8), name: "GET /b-child", service: "api", startMs: now - 8900, endMs: now - 8800 },
      ]))
      const result = await runTimeline(tlOpts(root, join(root, "nope.jsonl"), { json: true }))
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        events: { kind: string; traceId?: string; spanId?: string; depth?: number; text: string }[]
      }
      const depthOf = (traceId: string, name: string): number | undefined =>
        parsed.events.find((e) => e.kind === "trace" && e.traceId === traceId && e.text.includes(name))?.depth
      expect(depthOf(TRACE_A, "/a-root")).toBe(0)
      expect(depthOf(TRACE_B, "/b-child")).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("timeline cli dispatch (outer guard reaches runTimeline)", () => {
  const capture = (): { out: string[]; err: string[]; restore: () => void } => {
    const out: string[] = []
    const err: string[] = []
    const origLog = console.log
    const origError = console.error
    console.log = (...args: unknown[]): void => {
      out.push(args.map(String).join(" "))
    }
    console.error = (...args: unknown[]): void => {
      err.push(args.map(String).join(" "))
    }
    return { out, err, restore: () => {
      console.log = origLog
      console.error = origError
    } }
  }
  const withCwd = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const saved = process.cwd()
    process.chdir(dir)
    try {
      return await fn()
    } finally {
      process.chdir(saved)
    }
  }
  test("ow timeline --json exits 0 with events envelope (not show, not usage)", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "events.jsonl")
      await writeFile(log, "", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await withCwd(root, () => run(["timeline", "--log", log, "--json"]))
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(io.out.join("\n")) as Record<string, unknown>
      expect(Array.isArray(parsed["events"])).toBe(true)
      expect("groups" in parsed).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("ow timeline human empty prints no timeline (exit 0)", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "events.jsonl")
      await writeFile(log, "", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await withCwd(root, () => run(["timeline", "--log", log]))
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("no timeline")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
