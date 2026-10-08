/** M2 acceptance (`cli/trace-cli.test.ts`): `ow trace` list/tree views,
 * filters, `--json` envelopes, quiet-when-unconfigured, exit codes, caps,
 * corruption tolerance, secret-sentinel absence, and the doctor line. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, appendFile, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { doctorFails, helpText, parseArgs } from "./cli"
import { doctor, formatDoctor } from "./doctor"
import { createTraceStore } from "./trace-store"
import { checkTraceDoctor, parseWaitDuration, runTrace } from "./trace-cli"
import { decodeTraceRequest, type TraceSpan } from "./trace-otlp"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-trace-cli-"))

const TRACE_YAML = "trace:\n  port: 4319\nservices:\n  a:\n    cmd: x\n"

const makeSpan = (over: Partial<TraceSpan> & { traceId: string; spanId: string }): TraceSpan => ({
  t: "2026-10-08T00:00:00.000Z",
  parentSpanId: null,
  service: "api",
  name: "GET /x",
  kind: "server",
  startNano: "1000000000",
  endNano: "1012000000",
  durMs: 12,
  status: "ok",
  attrs: {},
  ...over,
})

const ns = (ms: number): string => (BigInt(ms) * 1_000_000n).toString()

const seedRows = async (root: string, rows: TraceSpan[], extraLines: string[] = [], yaml: string = TRACE_YAML): Promise<void> => {
  await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
  const lines = [...rows.map((row) => JSON.stringify(row)), ...extraLines]
  await writeFile(join(root, ".ow", "traces", "spans.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 })
  await writeFile(join(root, "ow.yaml"), yaml)
}

const opts = (rootDir: string, extra: Record<string, unknown> = {}) => ({
  rootDir,
  owYamlPath: join(rootDir, "ow.yaml"),
  ...extra,
})

const TRACE_A = `a1b2c3d4${"0".repeat(24)}`
const TRACE_B = `b1b2c3d4${"0".repeat(24)}`
const TRACE_C = `c1b2c3d4${"0".repeat(24)}`

describe("trace list view", () => {
  test("three traces list newest first; --tail 2 returns two", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), startNano: ns(now - 300_000), endNano: ns(now - 299_000) }),
        makeSpan({ traceId: TRACE_B, spanId: "b1".padEnd(16, "0"), startNano: ns(now - 200_000), endNano: ns(now - 199_000) }),
        makeSpan({ traceId: TRACE_C, spanId: "c1".padEnd(16, "0"), startNano: ns(now - 100_000), endNano: ns(now - 99_000) }),
      ])
      const all = await runTrace(opts(root))
      expect(all.code).toBe(0)
      const lines = all.stdout.split("\n")
      expect(lines.length).toBe(3)
      expect(lines[0].startsWith("c1b2c3d4")).toBe(true)
      expect(lines[1].startsWith("b1b2c3d4")).toBe(true)
      expect(lines[2].startsWith("a1b2c3d4")).toBe(true)
      const tailed = await runTrace(opts(root, { tail: 2 }))
      expect(tailed.code).toBe(0)
      expect(tailed.stdout.split("\n").length).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("list row carries root, service/span counts, duration and error mark", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({
          traceId: TRACE_A,
          spanId: "a1".padEnd(16, "0"),
          service: "web",
          name: "GET /orders/{id}",
          startNano: ns(now - 60_000),
          endNano: ns(now - 59_000),
          durMs: 1000,
          status: "error",
          attrs: { "error.type": "invalid_token" },
        }),
        makeSpan({
          traceId: TRACE_A,
          spanId: "a2".padEnd(16, "0"),
          parentSpanId: "a1".padEnd(16, "0"),
          service: "api",
          name: "SELECT orders",
          startNano: ns(now - 59_900),
          endNano: ns(now - 59_500),
          durMs: 400,
        }),
      ])
      const result = await runTrace(opts(root))
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("GET /orders/{id}")
      expect(result.stdout).toContain("2 servis")
      expect(result.stdout).toContain("2 span")
      expect(result.stdout.endsWith("✗")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--service filters the list; --since drops stale traces", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), service: "api", startNano: ns(now - 60_000), endNano: ns(now - 59_000) }),
        makeSpan({
          traceId: TRACE_B,
          spanId: "b1".padEnd(16, "0"),
          service: "web",
          startNano: ns(Date.parse("2020-01-01T00:00:00.000Z")),
          endNano: ns(Date.parse("2020-01-01T00:00:01.000Z")),
        }),
      ])
      const byService = await runTrace(opts(root, { service: "api" }))
      expect(byService.code).toBe(0)
      expect(byService.stdout.startsWith("a1b2c3d4")).toBe(true)
      expect(byService.stdout).not.toContain("b1b2c3d4")
      const bySince = await runTrace(opts(root, { sinceMs: 3_600_000 }))
      expect(bySince.code).toBe(0)
      expect(bySince.stdout.startsWith("a1b2c3d4")).toBe(true)
      expect(bySince.stdout).not.toContain("b1b2c3d4")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("NaN tail falls back to the default instead of silent empty", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0") }),
        makeSpan({ traceId: TRACE_B, spanId: "b1".padEnd(16, "0") }),
        makeSpan({ traceId: TRACE_C, spanId: "c1".padEnd(16, "0") }),
      ])
      const result = await runTrace(opts(root, { tail: NaN }))
      expect(result.code).toBe(0)
      expect(result.stdout.split("\n").length).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace tree view", () => {
  const seedTwoService = async (root: string): Promise<void> => {
    await seedRows(root, [
      makeSpan({
        traceId: TRACE_A,
        spanId: "11".repeat(8),
        service: "web",
        name: "GET /orders",
        startNano: "1000000000",
        endNano: "1118000000",
        durMs: 118,
      }),
      // filed before its earlier sibling: render order follows startNano
      makeSpan({
        traceId: TRACE_A,
        spanId: "33".repeat(8),
        parentSpanId: "11".repeat(8),
        service: "api",
        name: "GET /orders/{id}",
        startNano: "1024000000",
        endNano: "1100000000",
        durMs: 76,
        attrs: { "http.route": "/orders/{id}" },
      }),
      makeSpan({
        traceId: TRACE_A,
        spanId: "22".repeat(8),
        parentSpanId: "11".repeat(8),
        service: "auth",
        name: "POST /verify",
        startNano: "1012000000",
        endNano: "1108000000",
        durMs: 96,
        status: "error",
        attrs: { "error.type": "invalid_token" },
      }),
    ])
  }

  test("child indents under parent; siblings order by startNano; attrs appended", async () => {
    const root = await tempRoot()
    try {
      await seedTwoService(root)
      const result = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      expect(lines[0]).toBe(`izleme ${TRACE_A.slice(0, 12)}...  3 span, 3 servis, 118ms`)
      expect(lines[1]).toBe("[web] GET /orders 0ms +118ms ok")
      expect(lines[2]).toBe("  [auth] POST /verify 12ms +96ms error error.type=invalid_token")
      expect(lines[3]).toBe("  [api] GET /orders/{id} 24ms +76ms ok http.route=/orders/{id}")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("8-hex prefix resolves; 7-hex and non-hex exit 2; unknown exits 1", async () => {
    const root = await tempRoot()
    try {
      await seedTwoService(root)
      expect((await runTrace(opts(root, { traceId: TRACE_A }))).code).toBe(0)
      expect((await runTrace(opts(root, { traceId: TRACE_A.slice(0, 8) }))).code).toBe(0)
      const short = await runTrace(opts(root, { traceId: TRACE_A.slice(0, 7) }))
      expect(short.code).toBe(2)
      expect(short.stderr).toContain("geçersiz izleme kimliği")
      const nonHex = await runTrace(opts(root, { traceId: "zzzzzzzz" }))
      expect(nonHex.code).toBe(2)
      expect(nonHex.stderr).toContain("geçersiz izleme kimliği")
      const unknown = await runTrace(opts(root, { traceId: `d${"e".repeat(31)}` }))
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain("izleme bulunamadı")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ambiguous prefix exits 2 naming the candidate count", async () => {
    const root = await tempRoot()
    try {
      const shared = "a1b2c3d4"
      await seedRows(root, [
        makeSpan({ traceId: `${shared}${"0".repeat(24)}`, spanId: "a1".padEnd(16, "0") }),
        makeSpan({ traceId: `${shared}${"f".repeat(24)}`, spanId: "a2".padEnd(16, "0") }),
      ])
      const result = await runTrace(opts(root, { traceId: shared }))
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("2 aday")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("no cross-trace leakage: interleaved file, tree holds one trace only", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0") }),
        makeSpan({ traceId: TRACE_B, spanId: "b1".padEnd(16, "0") }),
        makeSpan({ traceId: TRACE_A, spanId: "a2".padEnd(16, "0"), parentSpanId: "a1".padEnd(16, "0") }),
        makeSpan({ traceId: TRACE_B, spanId: "b2".padEnd(16, "0"), parentSpanId: "b1".padEnd(16, "0") }),
      ])
      const result = await runTrace(opts(root, { traceId: TRACE_A, json: true }))
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { trace: string; spans: { traceId: string; spanId: string }[] }
      expect(parsed.trace).toBe(TRACE_A)
      expect(parsed.spans.length).toBe(2)
      expect(parsed.spans.every((span) => span.traceId === TRACE_A)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("orphan root renders at depth 0 with a note, never dropped", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), parentSpanId: "f".repeat(16) }),
      ])
      const result = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      expect(lines.length).toBe(2)
      expect(lines[1].startsWith("[api]")).toBe(true)
      expect(lines[1]).toContain("(kök yok)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("parent cycle terminates with one orphan root", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), parentSpanId: "b1".padEnd(16, "0"), startNano: "1000000000", endNano: "1001000000", durMs: 1 }),
        makeSpan({ traceId: TRACE_A, spanId: "b1".padEnd(16, "0"), parentSpanId: "a1".padEnd(16, "0"), startNano: "1000001000", endNano: "1002000000", durMs: 1 }),
      ])
      const result = await runTrace(opts(root, { traceId: TRACE_A, json: true }))
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { spans: { spanId: string; depth: number }[]; truncated: boolean }
      expect(parsed.spans.length).toBe(2)
      expect(parsed.spans.map((span) => span.depth).sort()).toEqual([0, 1])
      expect(parsed.truncated).toBe(false)
      const human = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(human.stdout).toContain("(kök yok)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--service does not prune a tree", async () => {
    const root = await tempRoot()
    try {
      await seedTwoService(root)
      const result = await runTrace(opts(root, { traceId: TRACE_A, service: "yok-servis" }))
      expect(result.code).toBe(0)
      expect(result.stdout.split("\n").length).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("duplicate spanIds do not report false truncation", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), name: "first" }),
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), name: "second" }),
      ])
      const human = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(human.code).toBe(0)
      expect(human.stdout).toContain("first")
      expect(human.stdout).not.toContain("kesildi")
      const asJson = await runTrace(opts(root, { traceId: TRACE_A, json: true }))
      const parsed = JSON.parse(asJson.stdout) as { spans: { name: string }[]; truncated: boolean }
      expect(parsed.truncated).toBe(false)
      expect(parsed.spans.length).toBe(1)
      expect(parsed.spans[0].name).toBe("first")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("render cap: 2100 spans → truncated with kesildi marker", async () => {
    const root = await tempRoot()
    try {
      const rows: TraceSpan[] = []
      for (let i = 0; i < 2100; i += 1) {
        rows.push(
          makeSpan({
            traceId: TRACE_A,
            spanId: i.toString(16).padStart(16, "0"),
            startNano: (1_000_000_000n + BigInt(i) * 1000n).toString(),
            endNano: (1_000_000_500n + BigInt(i) * 1000n).toString(),
            durMs: 0.0005,
          }),
        )
      }
      await seedRows(root, rows)
      const asJson = await runTrace(opts(root, { traceId: TRACE_A, json: true }))
      expect(asJson.code).toBe(0)
      const parsed = JSON.parse(asJson.stdout) as { spans: unknown[]; truncated: boolean }
      expect(parsed.truncated).toBe(true)
      expect(parsed.spans.length).toBe(2000)
      const human = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(human.stdout).toContain("…[kesildi: 100 span]…")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt lines and invalid rows are skipped, rest renders", async () => {
    const root = await tempRoot()
    try {
      await seedRows(
        root,
        [makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0") })],
        ['bozuk-satır{{{', JSON.stringify({ traceId: "kısa", spanId: "zz" })],
      )
      const result = await runTrace(opts(root, { traceId: TRACE_A, json: true }))
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { spans: unknown[] }
      expect(parsed.spans.length).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unreadable spans file exits 1 with a bounded message, no stack", async () => {
    const root = await tempRoot()
    try {
      await mkdir(join(root, ".ow", "traces", "spans.jsonl"), { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const result = await runTrace(opts(root))
      expect(result.code).toBe(1)
      expect(result.stderr.startsWith("ow: izleme okunamıyor")).toBe(true)
      expect(result.stderr).not.toContain("\n    at ")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace quiet paths", () => {
  test("no .ow → honest empty naming the searched start, exit 0", async () => {
    const root = await tempRoot()
    try {
      const human = await runTrace(opts(root))
      expect(human.code).toBe(0)
      expect(human.stdout).toBe(`izleme yok (.ow/ bulunamadı — aranan: ${root}; workspace kökünden çalıştırın ya da --file verin)`)
      const asJson = await runTrace(opts(root, { json: true }))
      expect(asJson.code).toBe(0)
      expect(asJson.stdout).toBe('{"traces":[]}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(".ow without trace block → kapalı, exit 0", async () => {
    const root = await tempRoot()
    try {
      await mkdir(join(root, ".ow"), { recursive: true })
      await writeFile(join(root, "ow.yaml"), "services:\n  a:\n    cmd: x\n")
      const human = await runTrace(opts(root))
      expect(human.code).toBe(0)
      expect(human.stdout).toBe("izleme kapalı (ow.yaml içinde trace: bloğu yok)")
      const asJson = await runTrace(opts(root, { json: true }))
      expect(asJson.stdout).toBe('{"traces":[]}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("configured with zero spans → henüz span gelmedi, exit 0", async () => {
    const root = await tempRoot()
    try {
      await mkdir(join(root, ".ow", "traces"), { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const human = await runTrace(opts(root))
      expect(human.code).toBe(0)
      expect(human.stdout).toBe("izleme yok (henüz span gelmedi)")
      const asJson = await runTrace(opts(root, { json: true }))
      expect(asJson.stdout).toBe('{"traces":[]}')
      const withId = await runTrace(opts(root, { traceId: TRACE_A }))
      expect(withId.code).toBe(0)
      expect(withId.stdout).toBe("izleme yok (henüz span gelmedi)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace --json envelopes", () => {
  test("list and tree keys are stable English; no Turkish keys", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({
          traceId: TRACE_A,
          spanId: "a1".padEnd(16, "0"),
          service: "web",
          name: "GET /orders/{id}",
          startNano: ns(now - 60_000),
          endNano: ns(now - 59_000),
        }),
      ])
      const list = JSON.parse((await runTrace(opts(root, { json: true }))).stdout) as {
        traces: Record<string, unknown>[]
      }
      expect(Object.keys(list).sort()).toEqual(["traces"])
      expect(Object.keys(list.traces[0]).sort()).toEqual(
        ["durMs", "root", "services", "spans", "startedAt", "status", "traceId"].sort(),
      )
      const tree = JSON.parse((await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout) as {
        trace: string
        spans: Record<string, unknown>[]
        truncated: boolean
      }
      expect(Object.keys(tree).sort()).toEqual(["spans", "trace", "truncated"])
      expect(Object.keys(tree.spans[0]).sort()).toEqual(
        ["attrs", "depth", "durMs", "endNano", "kind", "name", "parentSpanId", "service", "spanId", "startNano", "status", "t", "traceId"].sort(),
      )
      expect(JSON.stringify(list)).not.toContain("servis")
      expect(JSON.stringify(tree)).not.toContain("izleme")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace secret safety on the read path", () => {
  test("writer-masked credential shapes stay masked; short-ID structure is kept verbatim", async () => {
    const root = await tempRoot()
    const sentinel = "ZZSENTINELZZ"
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8(`GET /reset/${sentinel}9f3c1a7b`)),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("url.path", `/reset/${sentinel}9f3c1a7b`)),
          ...lenField(9, kv("http.route", `Bearer ${sentinel}`)),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      // doctrine-C: the 20-char mixed segment is structure (short ID), kept verbatim;
      // the Bearer credential value stays masked — it is the only sentinel-free guarantee here.
      expect(await readFile(spansFile, "utf8")).toContain(`/reset/${sentinel}9f3c1a7b`)
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) {
        expect(output).toContain(`/reset/${sentinel}9f3c1a7b`)
        expect(output).not.toContain(`Bearer ${sentinel}`)
      }
      expect(outputs[2]).toContain("Bearer ***")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("embedded key=value inside a path segment is masked in every output shape", async () => {
    const root = await tempRoot()
    const sentinel = "ZZSENTINELZZ"
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8(`GET /reset/token=${sentinel}`)),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("url.path", `/reset/token=${sentinel}`)),
          ...lenField(9, kv("http.route", `/reset/token=${sentinel}`)),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      expect(onDisk).not.toContain(sentinel)
      expect(onDisk).toContain("/reset/***")
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) expect(output).not.toContain(sentinel)
      expect(outputs[2]).toContain("GET /reset/***")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("percent-encoded separators are decoded before masking, in every output shape", async () => {
    const root = await tempRoot()
    const sentinel = "ZZSENTINELZZ"
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8(`GET /reset/token%3D${sentinel}`)),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("url.path", `/reset/token%3d${sentinel}`)),
          ...lenField(9, kv("http.route", `/login/auth%3A${sentinel}`)),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      expect(onDisk).not.toContain(sentinel)
      expect(onDisk).toContain("/reset/***")
      expect(onDisk).toContain("/login/***")
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) expect(output).not.toContain(sentinel)
      expect(outputs[2]).toContain("GET /reset/***")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("business attributes render across list/tree human+json; denied keys absent", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const kvInt = (key: string, n: number): number[] => [...lenField(1, utf8(key)), ...lenField(2, [...tag(3, 0), ...encVarint(n)])]
        const kvBool = (key: string, b: boolean): number[] => [...lenField(1, utf8(key)), ...lenField(2, [...tag(2, 0), ...encVarint(b ? 1 : 0)])]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8("GET /jobs/run")),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("silent_dequeue_reason", "SENDER_NOT_ALLOWED")),
          ...lenField(9, kvBool("conversion_successful", false)),
          ...lenField(9, kvInt("token_count", 150)),
          ...lenField(9, kv("http.route", "/jobs/{id}")),
          ...lenField(9, kv("password", "hunter2")),
          ...lenField(9, kv("db.statement", "SELECT 1")),
          ...lenField(9, kv("session_token", "sess-abc-123")),
          ...lenField(9, kv("deploy_key", "ghp_abc123DEF456")),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      for (const needle of ["SENDER_NOT_ALLOWED", '"conversion_successful":"false"', '"token_count":"150"']) {
        expect(onDisk).toContain(needle)
      }
      for (const needle of ["hunter2", "SELECT 1", "password", "sess-abc-123", "ghp_abc123DEF456"]) {
        expect(onDisk).not.toContain(needle)
      }
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      expect(outputs[0]).toContain("GET /jobs/run")
      expect(outputs[1]).toContain(TRACE_A)
      expect(outputs[2]).toContain("silent_dequeue_reason=SENDER_NOT_ALLOWED")
      expect(outputs[2]).toContain("conversion_successful=false")
      expect(outputs[2]).toContain("token_count=150")
      expect(outputs[2]).toContain("deploy_key=***")
      const treeJson = JSON.parse(outputs[3]) as { spans: { attrs: Record<string, string> }[] }
      expect(treeJson.spans[0].attrs["silent_dequeue_reason"]).toBe("SENDER_NOT_ALLOWED")
      expect(treeJson.spans[0].attrs["token_count"]).toBe("150")
      expect(treeJson.spans[0].attrs["deploy_key"]).toBe("***")
      expect(treeJson.spans[0].attrs).not.toHaveProperty("password")
      expect(treeJson.spans[0].attrs).not.toHaveProperty("db.statement")
      expect(treeJson.spans[0].attrs).not.toHaveProperty("session_token")
      for (const output of outputs) {
        expect(output).not.toContain("hunter2")
        expect(output).not.toContain("SELECT 1")
        expect(output).not.toContain("sess-abc-123")
        expect(output).not.toContain("ghp_abc123DEF456")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("route words survive verbatim in name and url.path across all four shapes", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8("POST /api/v1/stations/query")),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("http.route", "/<path:path>")),
          ...lenField(9, kv("url.path", "/api/v1/stations/query")),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      expect(onDisk).toContain("POST /api/v1/stations/query")
      expect(onDisk).toContain("/<path:path>")
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) {
        expect(output).toContain("POST /api/v1/stations/query")
        expect(output).toContain("/api/v1/stations/query")
      }
      // http.route renders as an attr: tree shapes only, never the list rows
      expect(outputs[2]).toContain("/<path:path>")
      expect(outputs[3]).toContain("/<path:path>")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctrine-C: short structure verbatim, ≥32-hex still masks, mixed case included", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const one = (id: string, name: string, route: string): number[] => {
          const span: number[] = [
            ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
            ...lenField(2, Array.from(Buffer.from(id, "hex"))),
            ...lenField(5, utf8(name)),
            ...tag(6, 0),
            ...encVarint(2),
            ...lenField(9, kv("http.route", route)),
            ...lenField(9, kv("url.path", name.replace(/^[A-Z]+ /, ""))),
          ]
          return lenField(2, span)
        }
        const scope = [
          ...one("cd".repeat(8), "GET /archive/2024/03/report", "/archive/2024/03/report"),
          // doctrine-C: the 20-hex segment below is structure (short ID), kept verbatim.
          ...one("ce".repeat(8), "GET /api/users/9f3c1a7b2e4d8c6fa1b2/profile", "/api/users/{id}/profile"),
          // doctrine-C rule 3: a ≥32-hex run is an opaque identifier → :id.
          ...one("cf".repeat(8), "GET /f/9f3c1a7b2e4d8c6f1a2b3c4d5e6f7081/end", "/f/{id}/end"),
        ]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      expect(onDisk).toContain("GET /archive/2024/03/report")
      expect(onDisk).toContain("GET /api/users/9f3c1a7b2e4d8c6fa1b2/profile")
      expect(onDisk).toContain("GET /f/:id/end")
      expect(onDisk).not.toContain("9f3c1a7b2e4d8c6f1a2b3c4d5e6f7081")
      const tree = (await runTrace(opts(root, { traceId: TRACE_A }))).stdout
      expect(tree).toContain("GET /archive/2024/03/report")
      expect(tree).toContain("GET /api/users/9f3c1a7b2e4d8c6fa1b2/profile")
      expect(tree).toContain("GET /f/:id/end")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctrine-C rule 3: UUID path masks to :id across all four shapes", async () => {
    const root = await tempRoot()
    const uuid = "9f3c1a7b-2e4d-4c6f-8234-56789abcdef0"
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8(`GET /o/${uuid}/end`)),
          ...tag(6, 0),
          ...encVarint(2),
          ...lenField(9, kv("url.path", `/o/${uuid}/end`)),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const onDisk = await readFile(spansFile, "utf8")
      expect(onDisk).toContain("GET /o/:id/end")
      expect(onDisk).not.toContain(uuid)
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) {
        expect(output).toContain("/o/:id/end")
        expect(output).not.toContain(uuid)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace doctor line", () => {
  const JAVA_YAML =
    "trace:\n  port: 4319\nservices:\n  api:\n    cmd: java -jar app.jar\n    env: {JAVA_TOOL_OPTIONS: \"-javaagent:.ow/otel/opentelemetry-javaagent.jar\"}\n"

  test("spans report açık regardless of jar; jar note is Java-only and silence-scoped", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), startNano: ns(now - 5_000), endNano: ns(now - 4_000) }),
      ])
      // Python-only setup (no java markers), spans present, jar absent → açık, no jar note
      const open = await checkTraceDoctor(root)
      expect(open.ok).toBe(true)
      expect(open.detail).toMatch(/açık \(port 4319, 1 span, son span .* önce\)/)
      expect(open.detail).not.toContain("jar")
      const bare = await tempRoot()
      try {
        await writeFile(join(bare, "ow.yaml"), "services:\n  a:\n    cmd: x\n")
        const closed = await checkTraceDoctor(bare)
        expect(closed.ok).toBe(false)
        expect(closed.detail).toContain("kapalı (ow.yaml içinde trace: yok)")
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("Java service with zero spans and no jar names the jar; jar present stays açık", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [], [], JAVA_YAML)
      const missing = await checkTraceDoctor(root)
      expect(missing.ok).toBe(false)
      expect(missing.detail).toContain("javaagent jar yok")
      await mkdir(join(root, ".ow", "otel"), { recursive: true })
      await writeFile(join(root, ".ow", "otel", "opentelemetry-javaagent.jar"), "")
      const open = await checkTraceDoctor(root)
      expect(open.ok).toBe(true)
      expect(open.detail).toContain("açık (port 4319, 0 span)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("zero spans carry a bounded liveness hint; flowing spans carry none", async () => {
    const root = await tempRoot()
    try {
      await seedRows(root, [], [], TRACE_YAML)
      const silent = await checkTraceDoctor(root)
      expect(silent.ok).toBe(true)
      expect(silent.detail).toBe("açık (port 4319, 0 span). ipucu: span yok — servis ayakta mı? ow ps")
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), name: "GET /gizli-hint-kanarya", startNano: ns(now - 5_000), endNano: ns(now - 4_000) }),
      ])
      const flowing = await checkTraceDoctor(root)
      expect(flowing.ok).toBe(true)
      expect(flowing.detail).not.toContain("ipucu")
      expect(flowing.detail).not.toContain("gizli-hint-kanarya")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("inherited JAVA_TOOL_OPTIONS with javaagent triggers the jar note", async () => {
    const root = await tempRoot()
    const saved = process.env.JAVA_TOOL_OPTIONS
    process.env.JAVA_TOOL_OPTIONS = "-javaagent:/tmp/fake-agent.jar"
    try {
      await seedRows(root, [])
      const missing = await checkTraceDoctor(root)
      expect(missing.ok).toBe(false)
      expect(missing.detail).toContain("javaagent jar yok")
    } finally {
      if (saved === undefined) delete process.env.JAVA_TOOL_OPTIONS
      else process.env.JAVA_TOOL_OPTIONS = saved
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bilinmeyen service appends the OTEL_SERVICE_NAME hint; named spans stay clean", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const encoded = (() => {
        const encVarint = (n: number): number[] => {
          let v = BigInt(n)
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
        const lenField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...encVarint(payload.length), ...payload]
        const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))
        const kv = (key: string, value: string): number[] => [...lenField(1, utf8(key)), ...lenField(2, lenField(1, utf8(value)))]
        const span: number[] = [
          ...lenField(1, Array.from(Buffer.from(TRACE_A, "hex"))),
          ...lenField(2, Array.from(Buffer.from("cd".repeat(8), "hex"))),
          ...lenField(5, utf8("GET /gizli-kanarya-bilinmeyen")),
          ...tag(6, 0),
          ...encVarint(2),
        ]
        const scope = [...lenField(2, span)]
        const resource = [...lenField(1, lenField(1, kv("host.name", "testbox"))), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      const hinted = await checkTraceDoctor(root)
      expect(hinted.ok).toBe(true)
      expect(hinted.detail).toContain("isimsiz span var")
      expect(hinted.detail).toContain("OTEL_SERVICE_NAME")
      expect(hinted.detail).not.toContain("span yok")
      expect(hinted.detail).not.toContain("gizli-kanarya")
      const named = await tempRoot()
      try {
        await mkdir(join(named, ".ow", "traces"), { recursive: true, mode: 0o700 })
        await writeFile(join(named, "ow.yaml"), TRACE_YAML)
        await seedRows(named, [
          makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), service: "api" }),
        ])
        // seedRows rewrites ow.yaml identically; spans carry service api.
        const clean = await checkTraceDoctor(named)
        expect(clean.ok).toBe(true)
        expect(clean.detail).not.toContain("ipucu")
      } finally {
        await rm(named, { recursive: true, force: true })
      }
      const empty = await tempRoot()
      try {
        await writeFile(join(empty, "ow.yaml"), TRACE_YAML)
        const silent = await checkTraceDoctor(empty)
        expect(silent.detail).toContain("span yok")
        expect(silent.detail).not.toContain("isimsiz")
      } finally {
        await rm(empty, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("trace line is present in doctor output and excluded from the exit rule", async () => {
    const root = await tempRoot()
    try {
      await mkdir(join(root, ".ow"), { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      const lines = await doctor({ upRoot: root })
      const trace = lines.find((line) => line.name === "trace")
      expect(trace).toBeDefined()
      expect(formatDoctor([trace!])).toMatch(/^[✓✗] trace: /)
      expect(doctorFails([{ name: "trace", ok: false }])).toBe(false)
      expect(doctorFails([{ name: "trace", ok: false }, { name: "db", ok: false }])).toBe(true)
      expect(doctorFails([{ name: "trace", ok: true }, { name: "db", ok: true }])).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace command registration", () => {
  test("parseArgs accepts trace with id and flags; help names it", () => {
    const parsed = parseArgs(["trace", TRACE_A.slice(0, 8), "--tail", "5", "--service", "api", "--json"])
    expect(parsed.error).toBeNull()
    expect(parsed.command).toBe("trace")
    expect(parsed.sessionID).toBe(TRACE_A.slice(0, 8))
    expect(parsed.flags["--service"]).toBe("api")
    expect(helpText()).toContain("trace [iz]")
    expect(parseArgs(["trace", "--nope"]).error).toContain("bilinmeyen seçenek")
  })

  test("parseArgs validates --wait; parseWaitDuration maps units with a 5m cap", () => {
    expect(parseWaitDuration("15s")).toBe(15_000)
    expect(parseWaitDuration("1m")).toBe(60_000)
    expect(parseWaitDuration("5m")).toBe(300_000)
    expect(parseWaitDuration("0s")).toBeNull()
    expect(parseWaitDuration("6m")).toBeNull()
    expect(parseWaitDuration("1h")).toBeNull()
    expect(parseWaitDuration("bogus")).toBeNull()
    expect(parseWaitDuration("15")).toBeNull()
    const ok = parseArgs(["trace", "--wait", "15s"])
    expect(ok.error).toBeNull()
    expect(ok.flags["--wait"]).toBe("15s")
    expect(parseArgs(["trace", "--wait", "0s"]).error).toContain("geçersiz --wait")
    expect(parseArgs(["trace", "--wait", "bogus"]).error).toContain("geçersiz --wait")
    expect(parseArgs(["trace", "--wait", "6m"]).error).toContain("geçersiz --wait")
    expect(helpText()).toContain("--wait")
  })
})

describe("trace --wait", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  test("span appended mid-wait is picked up and rendered", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), startNano: ns(now - 60_000), endNano: ns(now - 59_000) }),
      ])
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const pending = runTrace(opts(root, { waitMs: 8000 }))
      await sleep(400)
      await appendFile(spansFile, `${JSON.stringify(makeSpan({ traceId: TRACE_A, spanId: "a2".padEnd(16, "0"), startNano: ns(now - 1_000), endNano: ns(now) }))}\n`)
      const result = await pending
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("2 span")
      expect(result.stderr).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("deadline expiry renders current state plus the expiry line, exit 0", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), startNano: ns(now - 60_000), endNano: ns(now - 59_000) }),
      ])
      const result = await runTrace(opts(root, { waitMs: 600 }))
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("1 span")
      expect(result.stderr).toContain("bekleme süresi doldu")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
