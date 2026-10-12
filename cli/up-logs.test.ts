import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import {
  appendLogLine,
  createUpLogWriter,
  flushUpLogs,
  queryLogs,
  resetUpLogWriters,
  truncateLogLine,
  UP_LOG_MAX_BYTES,
  UP_LOG_MAX_LINES,
  UP_LOG_LINE_MAX_BYTES,
} from "./up-logs"
import { runSupervised, type UpLineHandler } from "./up-supervisor"
import { ensureUpStateDir, readSupervisorState, upPaths } from "./up-state"

const tempRoot = async (): Promise<string> => {
  resetUpLogWriters()
  return mkdtemp(join(tmpdir(), "ow-m3-"))
}

const collectLines = (): { lines: string[]; onLine: UpLineHandler } => {
  const lines: string[] = []
  const onLine: UpLineHandler = (service, stream, line) => {
    lines.push(`[${service}|${stream}] ${line}`)
  }
  return { lines, onLine }
}

describe("up-log caps", () => {
  test("cap constants match the plan contract", () => {
    expect(UP_LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(UP_LOG_MAX_LINES).toBe(10_000)
    expect(UP_LOG_LINE_MAX_BYTES).toBe(8 * 1024)
  })

  test("8 KB line cap keeps the head plus the kesildi marker", async () => {
    const root = await tempRoot()
    try {
      const logsDir = join(root, ".ow", "logs")
      appendLogLine(logsDir, "web", "stdout", `elma:${"x".repeat(20_000)}:kuyruk`)
      await flushUpLogs()
      const rows = await queryLogs({ logsDir, service: "web" })
      expect(rows).toHaveLength(1)
      expect(Buffer.byteLength(rows[0].line, "utf8")).toBeLessThanOrEqual(UP_LOG_LINE_MAX_BYTES + 32)
      expect(rows[0].line).toContain("…[truncated]…")
      expect(rows[0].line.startsWith("elma:")).toBe(true)
      expect(rows[0].line.includes("kuyruk")).toBe(false)
      expect(truncateLogLine("kısa")).toBe("kısa")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rotation keeps newest rows under small caps", async () => {
    const root = await tempRoot()
    try {
      const path = join(root, "kucuk.jsonl")
      const writer = createUpLogWriter(path, { maxLines: 10, maxBytes: 64 * 1024 })
      for (let i = 0; i < 50; i += 1) {
        writer.append({ t: new Date(Date.now() + i).toISOString(), stream: "stdout", line: `satir-${i}` })
      }
      await writer.flush()
      const text = await readFile(path, "utf8")
      const lines = text.split("\n").filter((line) => line.length > 0)
      expect(lines.length).toBeLessThanOrEqual(10)
      expect(lines[lines.length - 1]).toContain("satir-49")
      expect(lines[0]).toContain("satir-40")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("byte cap triggers rotation even with few lines", async () => {
    const root = await tempRoot()
    try {
      const path = join(root, "siskin.jsonl")
      const writer = createUpLogWriter(path, { maxBytes: 400, maxLines: 10_000 })
      for (let i = 0; i < 20; i += 1) {
        writer.append({ t: new Date().toISOString(), stream: "stdout", line: `dolgu-${i}-` + "y".repeat(40) })
      }
      await writer.flush()
      const text = await readFile(path, "utf8")
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(400 + 256)
      expect(text).toContain("dolgu-19-")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("line bursts absorb into batches without drops", async () => {
    const root = await tempRoot()
    try {
      const path = join(root, "patlama.jsonl")
      const writer = createUpLogWriter(path)
      for (let i = 0; i < 5000; i += 1) {
        writer.append({ t: new Date().toISOString(), stream: "stdout", line: `satir-${i}` })
      }
      await writer.flush()
      const text = await readFile(path, "utf8")
      const rows = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line))
      expect(rows.filter((row) => row.stream === "event")).toHaveLength(0)
      expect(rows.filter((row) => row.stream === "stdout")).toHaveLength(5000)
      expect(rows[rows.length - 1].line).toBe("satir-4999")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("backpressure drops with an event counter instead of blocking", async () => {
    const root = await tempRoot()
    try {
      const path = join(root, "baski.jsonl")
      const writer = createUpLogWriter(path, { maxPendingBytes: 200 })
      for (let i = 0; i < 10; i += 1) {
        writer.append({ t: new Date().toISOString(), stream: "stdout", line: `satir-${i}` })
      }
      await writer.flush()
      const text = await readFile(path, "utf8")
      const rows = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line))
      const events = rows.filter((row) => row.stream === "event")
      const data = rows.filter((row) => row.stream === "stdout")
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events.map((row) => row.line).join(" ")).toContain("dropped")
      const total = Number((events.map((row) => row.line).join(" ").match(/dropped: (\d+) lines/) ?? ["", "0"])[1])
      expect(data.length + total).toBe(10)
      expect(total).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("queryLogs", () => {
  test("merged view sorts ascending across services", async () => {
    const root = await tempRoot()
    try {
      const logsDir = join(root, ".ow", "logs")
      await ensureUpStateDir(logsDir)
      appendLogLine(logsDir, "b", "stdout", "ikinci")
      appendLogLine(logsDir, "a", "stdout", "birinci")
      await flushUpLogs()
      // rewrite with deterministic timestamps (append order is not time order here)
      const t0 = Date.now()
      await writeFile(
        join(logsDir, "a.jsonl"),
        `${JSON.stringify({ t: new Date(t0).toISOString(), stream: "stdout", line: "birinci" })}\n`,
        "utf8",
      )
      await writeFile(
        join(logsDir, "b.jsonl"),
        `${JSON.stringify({ t: new Date(t0 + 1000).toISOString(), stream: "stdout", line: "ikinci" })}\n`,
        "utf8",
      )
      const rows = await queryLogs({ logsDir })
      expect(rows.map((row) => `${row.service}:${row.line}`)).toEqual(["a:birinci", "b:ikinci"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("grep/since/tail filters compose", async () => {
    const root = await tempRoot()
    try {
      const logsDir = join(root, ".ow", "logs")
      await ensureUpStateDir(logsDir)
      const base = Date.now()
      const lines = [
        { t: new Date(base - 3_600_000).toISOString(), stream: "stdout", line: "elma eski" },
        { t: new Date(base - 60_000).toISOString(), stream: "stdout", line: "armut taze" },
        { t: new Date(base - 30_000).toISOString(), stream: "stderr", line: "elma taze" },
        { t: new Date(base - 10_000).toISOString(), stream: "stdout", line: "elma en-taze" },
      ]
      await writeFile(join(logsDir, "m.jsonl"), lines.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8")
      const grep = await queryLogs({ logsDir, service: "m", grep: "elma" })
      expect(grep.map((row) => row.line)).toEqual(["elma eski", "elma taze", "elma en-taze"])
      const since = await queryLogs({ logsDir, service: "m", grep: "elma", sinceMs: 5 * 60_000 })
      expect(since.map((row) => row.line)).toEqual(["elma taze", "elma en-taze"])
      const tail = await queryLogs({ logsDir, service: "m", grep: "elma", sinceMs: 5 * 60_000, tail: 1 })
      expect(tail.map((row) => row.line)).toEqual(["elma en-taze"])
      expect(tail[0]).toMatchObject({ service: "m", stream: "stdout" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("malformed lines are skipped, missing dir/file is honest-empty", async () => {
    const root = await tempRoot()
    try {
      const logsDir = join(root, ".ow", "logs")
      expect(await queryLogs({ logsDir })).toEqual([])
      expect(await queryLogs({ logsDir, service: "yok" })).toEqual([])
      await ensureUpStateDir(logsDir)
      await writeFile(join(logsDir, "k.jsonl"), 'bozuk satır\n{"t":1}\n{"t":"x","stream":"bogus","line":"y"}\n', "utf8")
      expect(await queryLogs({ logsDir, service: "k" })).toEqual([])
      expect(await queryLogs({ logsDir })).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("logs: sibling lifecycle", () => {
  test("logs-only service is captured as log stream, no main failure", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      const code = await runSupervised([{ name: "dis", logs: "echo ext1; echo ext2" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        logsDir: paths.logsDir,
        onLine,
      })
      expect(code).toBe(0)
      expect(lines).toContain("[dis|log] ext1")
      expect(lines).toContain("[dis|log] ext2")
      const rows = await queryLogs({ logsDir: paths.logsDir, service: "dis" })
      expect(rows.filter((row) => row.stream === "log").map((row) => row.line).sort()).toEqual(["ext1", "ext2"])
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services[0]).toMatchObject({ name: "dis", logsCmd: "echo ext1; echo ext2" })
      expect(state?.services[0]?.logsEnded).toMatchObject({ code: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("early-exiting tail warns, records logsEnded, siblings survive", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      const started = Date.now()
      const code = await runSupervised(
        [
          { name: "erken", cmd: "sleep 30", logs: "exit 3" },
          { name: "kardes", cmd: "echo yasiyor" },
        ],
        {
          rootDir: root,
          stateFile: paths.supervisorFile,
          logsDir: paths.logsDir,
          onLine,
          shouldStop: () => Date.now() - started > 800,
        },
      )
      expect(code).toBe(0)
      expect(lines).toContain("[kardes|stdout] yasiyor")
      const rows = await queryLogs({ logsDir: paths.logsDir, service: "erken" })
      const events = rows.filter((row) => row.stream === "event")
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events.map((row) => row.line).join(" ")).toContain("logs command exited (code=3)")
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services.find((svc) => svc.name === "erken")?.logsEnded).toMatchObject({ code: 3 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("main capture persists stdout+stderr rows and keeps streaming", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      const code = await runSupervised([{ name: "ana", cmd: "echo disari; echo hata >&2" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        logsDir: paths.logsDir,
        onLine,
      })
      expect(code).toBe(0)
      expect(lines).toContain("[ana|stdout] disari")
      expect(lines).toContain("[ana|stderr] hata")
      const rows = await queryLogs({ logsDir: paths.logsDir, service: "ana" })
      expect(rows).toMatchObject([
        { service: "ana", stream: "stdout", line: "disari" },
        { service: "ana", stream: "stderr", line: "hata" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow logs branch", () => {
  const fixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  web:\n    cmd: echo merhaba\n", "utf8")
    return { root, file }
  }

  test("missing .ow/ is honest-empty with exit 0", async () => {
    const { file } = await fixture().then(async (f) => {
      await rm(join(f.root, ".ow"), { recursive: true, force: true })
      return f
    })
    const root = join(file, "..")
    expect(await run(["logs", "--file", file])).toBe(0)
    expect(await run(["logs", "web", "--file", file, "--json"])).toBe(0)
    await rm(root, { recursive: true, force: true })
  })

  test("unknown service exits 2", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      expect(await run(["logs", "yabanci", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt supervisor.json fails closed with exit 1", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      expect(await run(["logs", "web", "--file", file])).toBe(1)
      expect(await run(["logs", "--file", file, "--json"])).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("filters read captured rows with stable json keys", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { onLine } = collectLines()
      await runSupervised([{ name: "web", cmd: "echo merhaba; echo dunya" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        logsDir: paths.logsDir,
        onLine,
      })
      expect(await run(["logs", "web", "--file", file, "--tail", "1"])).toBe(0)
      expect(await run(["logs", "web", "--file", file, "--grep", "dunya", "--json"])).toBe(0)
      expect(await run(["logs", "--file", file, "--since", "30m"])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
