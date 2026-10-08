/** M2 acceptance (`cli/trace-cli.test.ts`): `ow trace` list/tree views,
 * filters, `--json` envelopes, quiet-when-unconfigured, exit codes, caps,
 * corruption tolerance, secret-sentinel absence, and the doctor line. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { doctorFails, helpText, parseArgs } from "./cli"
import { doctor, formatDoctor } from "./doctor"
import { createTraceStore } from "./trace-store"
import { checkTraceDoctor, runTrace } from "./trace-cli"
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
  test("no .ow → honest empty, exit 0", async () => {
    const root = await tempRoot()
    try {
      const human = await runTrace(opts(root))
      expect(human.code).toBe(0)
      expect(human.stdout).toBe("izleme yok (.ow/ bulunamadı)")
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
  test("writer-masked values stay masked through list, tree, and json output", async () => {
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
        const resource = [...lenField(1, kv("service.name", "api")), ...lenField(2, scope)]
        return new Uint8Array(lenField(1, resource))
      })()
      const store = createTraceStore(spansFile)
      for (const span of decodeTraceRequest(encoded)) store.append(span)
      await store.flush()
      expect(await readFile(spansFile, "utf8")).not.toContain(sentinel)
      const outputs = [
        (await runTrace(opts(root))).stdout,
        (await runTrace(opts(root, { json: true }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A }))).stdout,
        (await runTrace(opts(root, { traceId: TRACE_A, json: true }))).stdout,
      ]
      for (const output of outputs) expect(output).not.toContain(sentinel)
      expect(outputs[2]).toContain("GET /reset/:id")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace doctor line", () => {
  test("configured with spans → açık; missing block → kapalı; missing jar named", async () => {
    const root = await tempRoot()
    try {
      const now = Date.now()
      await seedRows(root, [
        makeSpan({ traceId: TRACE_A, spanId: "a1".padEnd(16, "0"), startNano: ns(now - 5_000), endNano: ns(now - 4_000) }),
      ])
      const noJar = await checkTraceDoctor(root)
      expect(noJar.ok).toBe(false)
      expect(noJar.detail).toContain("javaagent jar yok")
      await mkdir(join(root, ".ow", "otel"), { recursive: true })
      await writeFile(join(root, ".ow", "otel", "opentelemetry-javaagent.jar"), "")
      const open = await checkTraceDoctor(root)
      expect(open.ok).toBe(true)
      expect(open.detail).toMatch(/açık \(port 4319, 1 span, son span .* önce\)/)
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
})
