/** M1 acceptance: receiver behavior over real HTTP (caps, CORS, filesystem
 * boundary, wire-in) plus the `trace:` schema block. All fixtures use
 * system-temp dirs, removed afterward. */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startTraceReceiver } from "./trace-receiver"
import { createTraceStore, readSpansFile } from "./trace-store"
import { parseUpFile } from "./up-schema"
import { runSupervised, type UpLineHandler } from "./up-supervisor"

// --- Minimal protobuf encoder (same V8 field map as trace-otlp.test.ts) ---

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

const validBody = (name = "GET /api/x", attrs: [string, string][] = []): Uint8Array => {
  const span: number[] = [
    ...lenField(1, rawHex("ab".repeat(16))),
    ...lenField(2, rawHex("cd".repeat(8))),
    ...lenField(5, utf8(name)),
    ...tag(6, 0),
    ...encVarint(2),
    ...tag(7, 1),
    ...fixed64(1_000_000_000n),
    ...tag(8, 1),
    ...fixed64(1_012_400_000n),
    ...attrs.flatMap(([k, v]) => lenField(9, kv(k, v))),
  ]
  const resource: number[] = [...lenField(1, lenField(1, kv("service.name", "api"))), ...lenField(2, lenField(2, span))]
  return new Uint8Array(lenField(1, resource))
}

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-trace-rx-"))

const startTestReceiver = async (root: string, overrides: Record<string, unknown> = {}) => {
  const warnings: string[] = []
  const receiver = await startTraceReceiver({
    tracesDir: join(root, ".ow", "traces"),
    spansFile: join(root, ".ow", "traces", "spans.jsonl"),
    port: 0,
    warnThrottleMs: 0,
    onWarn: (line: string): void => {
      warnings.push(line)
    },
    ...overrides,
  })
  if (!receiver) throw new Error(`receiver did not start: ${warnings.join("; ")}`)
  return { receiver, warnings }
}

const postTraces = (port: number, body: BodyInit | null | undefined, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", ...headers },
    body,
  })

const captureConsole = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = []
  const savedError = console.error
  const savedLog = console.log
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "))
  }
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "))
  }
  return {
    lines,
    restore: (): void => {
      console.error = savedError
      console.log = savedLog
    },
  }
}

const grepTree = async (dir: string, needle: string): Promise<string[]> => {
  const hits: string[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        const text = await readFile(full, "utf8").catch(() => "")
        if (text.includes(needle)) hits.push(full)
      }
    }
  }
  await walk(dir)
  return hits
}

describe("trace-receiver HTTP contract", () => {
  test("response shape: 200, echoed protobuf content-type, zero-byte body", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const res = await postTraces(receiver.port, validBody())
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe("application/x-protobuf")
        expect((await res.arrayBuffer()).byteLength).toBe(0)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans.length).toBe(1)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("gzip body decodes identically to the plain body", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const body = validBody()
        expect((await postTraces(receiver.port, body)).status).toBe(200)
        const gzipped = Bun.gzipSync(body)
        const res = await postTraces(receiver.port, gzipped, { "content-encoding": "gzip" })
        expect(res.status).toBe(200)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans.length).toBe(2)
        expect(spans[1]).toEqual(spans[0])
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("gzip expansion bomb → 413, file identical, receiver alive, counter set", async () => {
    const root = await tempRoot()
    try {
      const { receiver, warnings } = await startTestReceiver(root)
      try {
        const bomb = Bun.gzipSync(Buffer.alloc(50 * 1024 * 1024))
        expect(bomb.length).toBeLessThan(4 * 1024 * 1024)
        const before = await readFile(join(root, ".ow", "traces", "spans.jsonl"), "utf8").catch(() => null)
        const res = await postTraces(receiver.port, bomb, { "content-encoding": "gzip" })
        expect(res.status).toBe(413)
        const after = await readFile(join(root, ".ow", "traces", "spans.jsonl"), "utf8").catch(() => null)
        expect(after).toBe(before)
        expect(receiver.rejected["inflate-too-large"]).toBe(1)
        expect(warnings.join("\n")).toContain("inflate-too-large")
        // still alive and supervising: a valid export lands normally
        expect((await postTraces(receiver.port, validBody())).status).toBe(200)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans.length).toBe(1)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("inflate under the limit → 200 with spans stored", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root, { maxInflatedBytes: 2048 })
      try {
        const small = Bun.gzipSync(validBody())
        expect((await postTraces(receiver.port, small, { "content-encoding": "gzip" })).status).toBe(200)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans.length).toBe(1)
        const big = Bun.gzipSync(Buffer.alloc(3000, 65))
        expect((await postTraces(receiver.port, big, { "content-encoding": "gzip" })).status).toBe(413)
        expect(receiver.rejected["inflate-too-large"]).toBe(1)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("5 MiB wire body → 413, file unchanged", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const res = await postTraces(receiver.port, Buffer.alloc(5 * 1024 * 1024, 7))
        expect(res.status).toBe(413)
        expect(receiver.rejected["too-large"]).toBe(1)
        expect(existsSync(join(root, ".ow", "traces", "spans.jsonl"))).toBe(false)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("truncated body → 400 with bounded diagnostics, no payload bytes", async () => {
    const root = await tempRoot()
    try {
      const { receiver, warnings } = await startTestReceiver(root)
      try {
        const full = validBody("gizli-payload-RX7q2")
        const res = await postTraces(receiver.port, full.subarray(0, full.length - 5))
        expect(res.status).toBe(400)
        expect(receiver.rejected["decode-failed"]).toBe(1)
        const text = warnings.join("\n")
        expect(text).toContain("decode-failed")
        expect(text).toContain("offset=")
        expect(text).not.toContain("gizli-payload-RX7q2")
        expect(existsSync(join(root, ".ow", "traces", "spans.jsonl"))).toBe(false)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("JSON content-type is rejected, not parsed", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const res = await postTraces(receiver.port, Buffer.from("{}"), { "content-type": "application/json" })
        expect(res.status).toBe(415)
        expect(receiver.rejected["decode-failed"]).toBe(1)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown path and method → 404, nothing written", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const res = await fetch(`http://127.0.0.1:${receiver.port}/v1/metrics`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body: validBody(),
        })
        expect(res.status).toBe(404)
        expect((await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`)).status).toBe(404)
        expect(receiver.rejected["bad-path"]).toBe(2)
        expect(existsSync(join(root, ".ow", "traces", "spans.jsonl"))).toBe(false)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejection warnings carry reason and status only, never request bytes", async () => {
    const root = await tempRoot()
    const sentinel = "ZZSENTINELZZ"
    try {
      const { receiver, warnings } = await startTestReceiver(root)
      try {
        const badPath = await fetch(`http://127.0.0.1:${receiver.port}/v1/${sentinel}`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body: validBody(),
        })
        expect(badPath.status).toBe(404)
        const badType = await postTraces(receiver.port, validBody(), { "content-type": `application/x-${sentinel}` })
        expect(badType.status).toBe(415)
        expect(receiver.rejected["bad-path"]).toBe(1)
        expect(receiver.rejected["decode-failed"]).toBe(1)
        expect(warnings.length).toBeGreaterThan(0)
        expect(warnings.join("\n")).not.toContain(sentinel)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("CORS: loopback origin allowed, foreign origin refused without headers", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const good = await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`, {
          method: "OPTIONS",
          headers: { origin: "http://localhost:5173" },
        })
        expect(good.status).toBe(204)
        expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
        const evil = await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`, {
          method: "OPTIONS",
          headers: { origin: "https://evil.example" },
        })
        expect(evil.headers.get("access-control-allow-origin")).toBeNull()
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rotation under small caps keeps newest, drops oldest, file parses", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const store = createTraceStore(spansFile, { maxBytes: 4096, maxSpans: 50 })
      for (let i = 0; i < 100; i += 1) {
        const id = i.toString(16).padStart(16, "0")
        store.append({
          t: "2026-10-08T00:00:00.000Z",
          traceId: "ab".repeat(16),
          spanId: id,
          parentSpanId: null,
          service: "api",
          name: `span ${i}`,
          kind: "server",
          startNano: "1000",
          endNano: "2000",
          durMs: 0.001,
          status: "unset",
          attrs: {},
        })
      }
      await store.flush()
      const { spans, corrupt } = await readSpansFile(spansFile)
      expect(corrupt).toBe(0)
      expect(spans.length).toBeLessThanOrEqual(50)
      expect(spans.length).toBeGreaterThan(0)
      const ids = new Set(spans.map((s) => s.spanId))
      expect(ids.has("0000000000000063")).toBe(true)
      expect(ids.has("0000000000000000")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("concurrent behind-the-back writes are never compacted away", async () => {
    const root = await tempRoot()
    try {
      const spansFile = join(root, ".ow", "traces", "spans.jsonl")
      const row = (i: number) => ({
        t: "2026-10-08T00:00:00.000Z",
        traceId: "ab".repeat(16),
        spanId: i.toString(16).padStart(16, "0"),
        parentSpanId: null,
        service: "api",
        name: `span ${i}`,
        kind: "server",
        startNano: "1000",
        endNano: "2000",
        durMs: 0.001,
        status: "unset" as const,
        attrs: {},
      })
      const store = createTraceStore(spansFile, { maxSpans: 50 })
      for (let i = 0; i < 10; i += 1) store.append(row(i))
      await store.flush()
      // Another writer appends behind this store's back (simulates a second
      // store instance on the same file — no cross-process lock exists).
      for (let i = 100; i < 105; i += 1) await appendFile(spansFile, `${JSON.stringify(row(i))}\n`)
      for (let i = 10; i < 55; i += 1) store.append(row(i))
      await store.flush()
      const { spans, corrupt } = await readSpansFile(spansFile)
      expect(corrupt).toBe(0)
      expect(spans.length).toBe(60)
      const ids = new Set(spans.map((s) => s.spanId))
      for (const i of [0, 9, 54, 104]) expect(ids.has(i.toString(16).padStart(16, "0"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("content-type must match exactly modulo ;-parameters", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        const evil = await postTraces(receiver.port, validBody(), { "content-type": "application/x-protobuf-malicious" })
        expect(evil.status).toBe(415)
        expect(receiver.rejected["decode-failed"]).toBe(1)
        expect(existsSync(join(root, ".ow", "traces", "spans.jsonl"))).toBe(false)
        const params = await postTraces(receiver.port, validBody(), { "content-type": "application/x-protobuf; charset=utf-8" })
        expect(params.status).toBe(200)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans.length).toBe(1)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("perms: traces dir 0700, spans file 0600", async () => {
    const root = await tempRoot()
    try {
      const { receiver } = await startTestReceiver(root)
      try {
        expect((await postTraces(receiver.port, validBody())).status).toBe(200)
        expect((await stat(join(root, ".ow", "traces"))).mode & 0o777).toBe(0o700)
        expect((await stat(join(root, ".ow", "traces", "spans.jsonl"))).mode & 0o777).toBe(0o600)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("secret sentinel e2e: credential shapes masked, short-ID structure kept (doctrine-C)", async () => {
    const root = await tempRoot()
    const sentinel = "ZZSENTINELZZ"
    try {
      const { receiver, warnings } = await startTestReceiver(root)
      try {
        const body = validBody(`GET /reset/${sentinel}9f3c1a7b`, [
          ["url.path", `/reset/${sentinel}9f3c1a7b`],
          ["http.route", `Bearer ${sentinel}`],
        ])
        expect((await postTraces(receiver.port, body)).status).toBe(200)
        expect(warnings.join("\n")).not.toContain(sentinel)
        // doctrine-C: the 20-char mixed segment is structure (short ID) — visible on
        // disk by design; the Bearer credential value must appear nowhere.
        const hits = await grepTree(join(root, ".ow"), sentinel)
        expect(hits).toEqual([join(root, ".ow", "traces", "spans.jsonl")])
        expect(await readFile(join(root, ".ow", "traces", "spans.jsonl"), "utf8")).not.toContain(`Bearer ${sentinel}`)
        const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
        expect(spans[0].attrs["url.path"]).toBe(`/reset/${sentinel}9f3c1a7b`)
      } finally {
        await receiver.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace supervisor wire-in", () => {
  const echoService = [{ name: "a", cmd: "echo hi" }]

  const collectLines = (): { lines: string[]; onLine: UpLineHandler } => {
    const lines: string[] = []
    return { lines, onLine: (service, stream, line) => lines.push(`[${service}|${stream}] ${line}`) }
  }

  test("tracing off: no .ow/traces, no new stderr, up --check --json shape unchanged", async () => {
    const root = await tempRoot()
    const spy = captureConsole()
    try {
      const { lines, onLine } = collectLines()
      const code = await runSupervised(echoService, { rootDir: root, onLine })
      expect(code).toBe(0)
      expect(lines).toContain("[a|stdout] hi")
      expect(existsSync(join(root, ".ow", "traces"))).toBe(false)
      expect(spy.lines.some((line) => line.includes("trace"))).toBe(false)
    } finally {
      spy.restore()
      await rm(root, { recursive: true, force: true })
    }
    const file = parseUpFile("services:\n  a:\n    cmd: x\n")
    expect("trace" in file).toBe(false)
    expect(Object.keys(file).sort()).toEqual(["services", "warnings"])
  })

  test("symlinked traces dir → refusal, nothing through the link, up still supervises", async () => {
    const root = await tempRoot()
    const target = await tempRoot()
    await mkdir(join(root, ".ow"), { recursive: true })
    await symlink(target, join(root, ".ow", "traces"))
    const spy = captureConsole()
    try {
      const { lines, onLine } = collectLines()
      const code = await runSupervised(echoService, {
        rootDir: root,
        onLine,
        trace: { enabled: true, port: 0 },
      })
      expect(code).toBe(0)
      expect(lines).toContain("[a|stdout] hi")
      expect(spy.lines.some((line) => line.includes("trace"))).toBe(true)
      expect(await readdir(target)).toEqual([])
    } finally {
      spy.restore()
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  test("symlinked spans file → refusal, link target byte-identical", async () => {
    const root = await tempRoot()
    const target = await tempRoot()
    const targetFile = join(target, "other.jsonl")
    await writeFile(targetFile, "orig\n")
    await mkdir(join(root, ".ow", "traces"), { recursive: true })
    await symlink(targetFile, join(root, ".ow", "traces", "spans.jsonl"))
    const spy = captureConsole()
    try {
      const { onLine } = collectLines()
      const code = await runSupervised(echoService, {
        rootDir: root,
        onLine,
        trace: { enabled: true, port: 0 },
      })
      expect(code).toBe(0)
      expect(spy.lines.some((line) => line.includes("trace"))).toBe(true)
      expect(await readFile(targetFile, "utf8")).toBe("orig\n")
    } finally {
      spy.restore()
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  test("bind failure names host+port with directive; services still spawn", async () => {
    const root = await tempRoot()
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("meşgul") })
    const warnings: string[] = []
    try {
      const receiver = await startTraceReceiver({
        tracesDir: join(root, ".ow", "traces"),
        spansFile: join(root, ".ow", "traces", "spans.jsonl"),
        port: blocker.port,
        warnThrottleMs: 0,
        onWarn: (line: string): void => {
          warnings.push(line)
        },
      })
      expect(receiver).toBeNull()
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain(`127.0.0.1:${blocker.port}`)
      expect(warnings[0]).toContain("lsof -i")
    } finally {
      blocker.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bind failure → one warning, services still spawn on the normal rule", async () => {
    const root = await tempRoot()
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("meşgul") })
    const spy = captureConsole()
    try {
      const { lines, onLine } = collectLines()
      const code = await runSupervised(echoService, {
        rootDir: root,
        onLine,
        trace: { enabled: true, port: blocker.port },
      })
      expect(code).toBe(0)
      expect(lines).toContain("[a|stdout] hi")
      expect(spy.lines.some((line) => line.includes(`127.0.0.1:${blocker.port}`))).toBe(true)
      expect(existsSync(join(root, ".ow", "traces", "spans.jsonl"))).toBe(false)
    } finally {
      spy.restore()
      blocker.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("enabled trace receives spans through the supervised receiver", async () => {
    const root = await tempRoot()
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
    const probePort = blocker.port
    blocker.stop()
    const spy = captureConsole()
    try {
      const { onLine } = collectLines()
      let code = -1
      const run = runSupervised([{ name: "a", cmd: "sleep 5" }], {
        rootDir: root,
        onLine,
        trace: { enabled: true, port: probePort },
        shouldStop: () => code !== -1,
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const res = await postTraces(probePort, validBody())
      expect(res.status).toBe(200)
      code = 99
      // shouldStop trips the loop; the run resolves after shutdown
      const finalCode = await run
      expect(finalCode).toBe(0)
      const { spans } = await readSpansFile(join(root, ".ow", "traces", "spans.jsonl"))
      expect(spans.length).toBe(1)
      expect(spans[0].service).toBe("api")
    } finally {
      spy.restore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("trace: schema block", () => {
  const services = "services:\n  a:\n    cmd: x\n"

  test("absent block → undefined, no new warning", () => {
    const file = parseUpFile(services)
    expect(file.trace).toBeUndefined()
    expect(file.warnings).toEqual([])
  })

  test("flat block parses with defaults; empty block enables", () => {
    expect(parseUpFile(`trace:\n  enabled: true\n  port: 4319\n${services}`).trace).toEqual({
      enabled: true,
      port: 4319,
    })
    expect(parseUpFile(`trace:\n${services}`).trace).toEqual({ enabled: true, port: 4319 })
    expect(parseUpFile(`trace: {enabled: false, port: 4320}\n${services}`).trace).toEqual({
      enabled: false,
      port: 4320,
    })
  })

  test("non-map block warns without failing; unknown keys warn; nested maps warn", () => {
    const scalar = parseUpFile(`trace: yo\n${services}`)
    expect(scalar.trace).toBeUndefined()
    expect(scalar.warnings.map((w) => w.message)).toContain("trace map expected, ignored")

    const unknown = parseUpFile(`trace:\n  endpoint: x\n${services}`)
    expect(unknown.trace).toEqual({ enabled: true, port: 4319 })
    expect(unknown.warnings.map((w) => w.message)).toContain("trace: unknown field ignored: endpoint")

    const nested = parseUpFile(`trace:\n  exporter:\n    port: 4319\n${services}`)
    expect(nested.trace).toEqual({ enabled: true, port: 4319 })
    expect(nested.warnings.map((w) => w.message)).toContain("trace: nested field ignored: exporter")
  })

  test("bad enabled value warns and stays enabled", () => {
    const file = parseUpFile(`trace:\n  enabled: maybe\n${services}`)
    expect(file.trace).toEqual({ enabled: true, port: 4319 })
    expect(file.warnings.map((w) => w.message)).toContain("trace: enabled must be true/false, ignored")
  })

  test("invalid port reuses the geçersiz port hard error", () => {
    expect(() => parseUpFile(`trace:\n  port: abc\n${services}`)).toThrow(/invalid port/)
    expect(() => parseUpFile(`trace:\n  port: 99999\n${services}`)).toThrow(/invalid port/)
  })

  test("trace block no longer warns as an unknown top-level field", () => {
    const file = parseUpFile(`trace:\n  enabled: true\n${services}`)
    expect(file.warnings.map((w) => w.message).some((m) => m.includes("unknown top-level field"))).toBe(false)
  })
})
