import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { findLast, maskCommand } from "./last"

type Row = { t: string; command: string; workdir?: string; exitCode?: number | null }
const log = (rows: Row[]): string =>
  rows
    .map((r) =>
      JSON.stringify({ timestamp: r.t, sessionID: "ses_x", command: r.command, workdir: r.workdir ?? "/w", exitCode: r.exitCode === undefined ? 0 : r.exitCode }),
    )
    .join("\n")

const rows: Row[] = [
  { t: "2026-10-01T10:00:00Z", command: "mvn -q package" },
  { t: "2026-10-02T10:00:00Z", command: "MVN -q package -s s.xml", workdir: "/w/a" },
  { t: "2026-10-03T10:00:00Z", command: "mvn -q package", exitCode: 1 },
  { t: "2026-10-04T10:00:00Z", command: "mvn -q package" },
  { t: "2026-10-05T10:00:00Z", command: "mvn -q package", workdir: "/w/b", exitCode: null },
  { t: "2026-10-06T10:00:00Z", command: "ls" },
]

describe("findLast", () => {
  test("newest successful match first, case-insensitive, exit 0 only", () => {
    const out = findLast(log(rows), { pattern: "mvn", count: 5 })
    expect(out.map((m) => [m.timestamp, m.workdir])).toEqual([
      ["2026-10-04T10:00:00Z", "/w"],
      ["2026-10-02T10:00:00Z", "/w/a"],
    ])
  })

  test("-n dedupes identical command+cwd and keeps the newest of each", () => {
    expect(findLast(log(rows), { pattern: "mvn", count: 1 })).toHaveLength(1)
    const out = findLast(log(rows), { pattern: "package", count: 5 })
    expect(out.map((m) => m.timestamp)).toEqual(["2026-10-04T10:00:00Z", "2026-10-02T10:00:00Z"])
  })

  test("--failed returns the newest non-zero exit with its code", () => {
    const out = findLast(log(rows), { pattern: "mvn", count: 1, failed: true })
    expect(out).toHaveLength(1)
    expect(out[0].exitCode).toBe(1)
  })

  test("--dir and --since narrow the scope", () => {
    expect(findLast(log(rows), { pattern: "mvn", count: 5, dir: "/w/a" })).toHaveLength(1)
    const now = Date.parse("2026-10-06T12:00:00Z")
    expect(findLast(log(rows), { pattern: "mvn", count: 5, sinceMs: 3 * 86_400_000, now })).toHaveLength(1)
  })

  test("malformed lines are skipped", () => {
    expect(findLast(`not json\n${log(rows)}`, { pattern: "ls", count: 1 })).toHaveLength(1)
  })
})

describe("secret masking", () => {
  const hostile = [
    'GH_PACKAGES_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 mvn package',
    'export DB_PASSWORD="hunter2 with space" && run',
    "API_KEY='s3cr3t-value' run",
    "MY_SECRET=plainvalue123 run",
  ]
  test("credential assignments keep the name and drop the value", () => {
    expect(maskCommand(hostile[0])).toBe("GH_PACKAGES_TOKEN=*** mvn package")
    expect(maskCommand(hostile[1])).toBe("export DB_PASSWORD=*** && run")
    expect(maskCommand(hostile[2])).toBe("API_KEY=*** run")
    expect(maskCommand(hostile[3])).toBe("MY_SECRET=*** run")
  })

  test("value references stay re-runnable", () => {
    const cmd = 'GH_PACKAGES_USERNAME="$login" GH_PACKAGES_TOKEN="$(gh auth token)" mvn -B package'
    expect(maskCommand(cmd)).toBe(cmd)
  })

  test("non-secret commands are untouched", () => {
    const cmd = "JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn -s /w/settings.xml package"
    expect(maskCommand(cmd)).toBe(cmd)
  })

  test("real binary path: ow last never prints the raw value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "last-test-"))
    const path = join(dir, "log.jsonl")
    await writeFile(path, log(hostile.map((command, i) => ({ t: `2026-10-0${i + 1}T10:00:00Z`, command }))))
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => void lines.push(a.join(" "))
    try {
      expect(await run(["last", "run", "-n", "5", "--log", path])).toBe(0)
    } finally {
      console.log = orig
    }
    const text = lines.join("\n")
    for (const leak of ["hunter2", "s3cr3t", "plainvalue123"]) expect(text).not.toContain(leak)
    expect(text).toContain("DB_PASSWORD=***")
  })
})

describe("ow last CLI", () => {
  test("no match exits 1 with a clear message; missing pattern and bad -n exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "last-test-"))
    const path = join(dir, "log.jsonl")
    await writeFile(path, log(rows))
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void errs.push(a.join(" "))
    try {
      expect(await run(["last", "nope-nothing", "--log", path])).toBe(1)
      expect(await run(["last", "--log", path])).toBe(2)
      expect(await run(["last", "ls", "-n", "0", "--log", path])).toBe(2)
      expect(await run(["last", "ls", "--json", "--log", path])).toBe(2)
    } finally {
      console.error = orig
    }
    expect(errs.join("\n")).toContain('no successful command matching "nope-nothing"')
  })
})
