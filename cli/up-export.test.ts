/** M13 export bundle: read-only composition of existing readers
 * (ps --explain, logs tails, failures, preflight --json, checkpoints show)
 * into ONE redacted snapshot file. No new data collection. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { composePreflightFence } from "./up-export"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m13-"))

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

const yamlFile = async (root: string): Promise<string> => {
  const file = join(root, "ow.yaml")
  await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
  return file
}

const logRow = (line: string): string =>
  JSON.stringify({ t: "2026-10-09T08:00:00.000Z", stream: "stdout", line })

const envelope = (stage: string, status: string, proof: unknown, at: string): string =>
  JSON.stringify({ stage, status, proof, at, by: "runner", code: { runner: "r1" } })

/** Full fixture: every section has something to show (no supervisor). */
const fullFixture = async (): Promise<{ root: string; file: string }> => {
  const root = await tempRoot()
  const file = await yamlFile(root)
  await mkdir(join(root, ".ow", "logs"), { recursive: true })
  await writeFile(
    join(root, ".ow", "logs", "a.jsonl"),
    `${logRow("listening on 3000")}\n${logRow("ready")}\n`,
    "utf8",
  )
  const now = new Date().toISOString()
  await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
  await writeFile(
    join(root, ".ow", "checkpoints", "nightly.jsonl"),
    `${envelope("build", "not_observed", "pending", now)}\n${envelope("build", "not_observed", "pending", now)}\n`,
    "utf8",
  )
  return { root, file }
}

describe("export --bundle (M13, read-only composition)", () => {
  test("composition: exit 0 + one file with every section + 0600", async () => {
    const { root, file } = await fullFixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toBe("bundle: bundle.md")
      const text = await readFile(join(root, "bundle.md"), "utf8")
      for (const title of ["# ow export bundle", "## ps --explain", "## logs (tail 50 per service)", "## failures (since 24h)", "## preflight --json"]) {
        expect(text).toContain(title)
      }
      expect(text).toContain("listening on 3000")
      expect(text).toContain("finding: build (not-observed")
      expect(text).toContain("```json")
      const fence = text.split("```json")[1].split("```")[0]
      expect(() => JSON.parse(fence)).not.toThrow()
      const mode = (await stat(join(root, "bundle.md"))).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--run includes checkpoints show for that run only", async () => {
    const { root, file } = await fullFixture()
    try {
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "nightly", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).toContain("## checkpoints show nightly")
      expect(text).toContain("not-observed: build")
      expect(text).toContain("run: nightly")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("default --out lands in .ow with timestamp name (relative echo, no abs path)", async () => {
    const { root, file } = await fullFixture()
    try {
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const line = io.out.join("\n")
      expect(line.startsWith("bundle: .ow/bundle-")).toBe(true)
      expect(line.endsWith(".md")).toBe(true)
      expect(line).not.toContain(root)
      const names = await readdir(join(root, ".ow"))
      expect(names.some((name) => name.startsWith("bundle-") && name.endsWith(".md"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile fixture: secrets, full revs/digests, abs paths, trace ids absent; short-8 rev present", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const rev40 = "9f2c41ab".repeat(5)
      const trace32 = "deadbeef".repeat(4)
      const traceB = "cafef00d".repeat(4)
      await mkdir(join(root, ".ow", "logs"), { recursive: true })
      await writeFile(
        join(root, ".ow", "logs", "a.jsonl"),
        `${logRow(`login attempt password=hunter2 token=abc123 rev=${rev40} trace=${trace32} dir=${root}/svc`)}\n`,
        "utf8",
      )
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      const now = new Date().toISOString()
      await writeFile(
        join(root, ".ow", "checkpoints", "evil.jsonl"),
        `${JSON.stringify({ stage: "auth", status: "confirmed", proof: { token: "hunter2", nested: { api_key: "hunter2" }, path: `${root}/svc/x`, trace: traceB }, safe_next_action: "retry with password=hunter2", at: now, by: "runner", code: { runner: "r1" } })}\n`,
        "utf8",
      )
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "evil", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).not.toContain("hunter2")
      expect(text).not.toContain(rev40)
      expect(text).not.toContain(trace32)
      expect(text).not.toContain(traceB)
      expect(text).not.toContain(root)
      expect(text).toContain("9f2c41ab")
      expect(text).toContain("<root>/svc")
      const everything = `${io.out.join("\n")}\n${io.err.join("\n")}`
      expect(everything).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing everything: exit 1, explicit, nothing written", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      const io = capture()
      let code = -1
      try {
        code = await run(["export", "--bundle", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("export: nothing readable")
      await expect(readFile(join(root, ".ow", "bundle-x.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("traversal --out refused exit 2 with basename echo only", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      for (const bad of ["../evil.md", "/tmp/evil.md", "sub/../../evil.md"]) {
        const io = capture()
        let code = -1
        try {
          code = await run(["export", "--bundle", "--file", file, "--out", bad])
        } finally {
          io.restore()
        }
        expect(`${bad} → ${code}`).toBe(`${bad} → 2`)
        expect(io.err.join("\n")).toContain("export-refused: evil.md")
        expect(io.err.join("\n")).not.toContain(root)
      }
      await expect(readFile(join(tmpdir(), "evil.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("usage: missing --bundle, bad run name, extra positional, foreign flag → exit 2", async () => {
    const { root, file } = await fullFixture()
    try {
      const cases: string[][] = [
        ["export", "--file", file],
        ["export", "--bundle", "../x", "--file", file],
        ["export", "--bundle", "a", "b", "--file", file],
        ["export", "--bundle", "--file", file, "--json"],
        ["export", "--bundle", "--file", file, "--tail", "10"],
      ]
      for (const args of cases) {
        const io = capture()
        let code = -1
        try {
          code = await run(args)
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toContain("→ 2")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("byte shape: header lines, order, empty placeholders", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      const lines = text.split("\n")
      expect(lines[0]).toBe("# ow export bundle")
      expect(lines[1].startsWith("generated: 2")).toBe(true)
      expect(lines[2]).toBe("root: <root>")
      expect(lines[3]).toBe("run: none")
      expect(lines[4]).toBe("redaction: secrets-masked, paths-folded, revs-short-8, traces-excluded")
      const order = ["## ps --explain", "## logs (tail 50 per service)", "## failures (since 24h)", "## preflight --json"]
      let at = -1
      for (const title of order) {
        const found = text.indexOf(title)
        expect(found).toBeGreaterThan(at)
        at = found
      }
      expect(text).toContain("empty: no logs")
      expect(text).toContain("empty: no findings")
      expect(text).not.toContain("checkpoints show")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("export review findings (M13 follow-ups)", () => {
  test("HIGH 2a: token-check stage keeps fence valid JSON + masked, exit 0", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const now = new Date().toISOString()
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      await writeFile(
        join(root, ".ow", "checkpoints", "nightly.jsonl"),
        `${envelope("token-check", "confirmed", { ok: true }, now)}\n${envelope("token-check", "not_observed", "pending", now)}\n`,
        "utf8",
      )
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).not.toContain("token-check")
      const fence = text.split("```json")[1].split("```")[0]
      const payload = JSON.parse(fence) as { envelopes: { stage: string }[] }
      expect(payload.envelopes.length).toBeGreaterThan(0)
      expect(payload.envelopes.some((entry) => entry.stage === "***")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("HIGH 2a unit: present-but-unparsable fence fails loud (never silent exit 0)", () => {
    const bad = composePreflightFence("not json at all", true, "/root")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain("not valid JSON")
    const good = composePreflightFence('{"a":1}', true, "/root")
    expect(good.ok).toBe(true)
    if (good.ok) expect(JSON.parse(good.text)).toEqual({ a: 1 })
    const absent = composePreflightFence("empty: preflight unavailable", false, "/root")
    expect(absent.ok).toBe(true)
  })

  test("MEDIUM 2b: trace/span/traceparent shapes masked, traces-excluded claim kept", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const id32 = "deadbeef".repeat(4)
      const span16 = "cafef00dcafef00d"
      const parent = `00-${id32}-${span16}-01`
      await mkdir(join(root, ".ow", "logs"), { recursive: true })
      await writeFile(
        join(root, ".ow", "logs", "a.jsonl"),
        `${logRow(`trace_id=${id32} span_id=${span16} traceparent=${parent}`)}\n${logRow(`saw ${parent} on the wire`)}\n`,
        "utf8",
      )
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).not.toContain(id32)
      expect(text).not.toContain(span16)
      expect(text).not.toContain(parent)
      expect(text).toContain("redaction: secrets-masked, paths-folded, revs-short-8, traces-excluded")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("MEDIUM 2c: outside-root cwd never emitted (elsewhere discipline)", async () => {
    const root = await tempRoot()
    const outside = await mkdtemp(join(tmpdir(), "ow-m13-outside-"))
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  a:\n    cmd: echo hi\n    cwd: ${outside}\n`, "utf8")
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).not.toContain(outside)
      expect(text).toContain("<elsewhere>/")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("MEDIUM 3: dot/empty/dir --out refused exit 2 before any tmp creation", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await mkdir(join(root, "sub"), { recursive: true })
      const before = new Set(await readdir(root))
      for (const bad of [".", "", "sub"]) {
        const io = capture()
        let code = -1
        try {
          code = await run(["export", "--bundle", "--file", file, "--out", bad])
        } finally {
          io.restore()
        }
        expect(`${JSON.stringify(bad)} → ${code}`).toBe(`${JSON.stringify(bad)} → 2`)
        expect(io.err.join("\n")).toContain("export-refused")
      }
      const after = await readdir(root)
      expect(after.filter((name) => name.startsWith(".ow-") && name.endsWith(".tmp"))).toEqual([])
      expect(new Set(after)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("MEDIUM 3: symlinked parent escapes refused, no outside write", async () => {
    const root = await tempRoot()
    const outside = await mkdtemp(join(tmpdir(), "ow-m13-esc-"))
    try {
      const file = await yamlFile(root)
      await symlink(outside, join(root, "link"))
      const io = capture()
      let code = -1
      try {
        code = await run(["export", "--bundle", "--file", file, "--out", "link/bundle.md"])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("export-refused: bundle.md")
      expect(io.err.join("\n")).toContain("outside root")
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("MEDIUM 7: --bundle/--out on other verbs exit 2 without acting", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const supervisor = JSON.stringify({ version: 1, services: [] })
      await mkdir(join(root, ".ow"), { recursive: true })
      await writeFile(join(root, ".ow", "supervisor.json"), supervisor, "utf8")
      const io = capture()
      try {
        expect(await run(["down", "--bundle", "--rm", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(await readFile(join(root, ".ow", "supervisor.json"), "utf8")).toBe(supervisor)
      const io2 = capture()
      try {
        expect(await run(["up", "--check", "--bundle", "--file", file])).toBe(2)
      } finally {
        io2.restore()
      }
      const io3 = capture()
      try {
        expect(await run(["ps", "--out", "x.md", "--file", file])).toBe(2)
      } finally {
        io3.restore()
      }
      expect(io3.err.join("\n")).toContain("ow: --bundle/--out work only with export")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("export absent-preflight fence (follow-up)", () => {
  test("preflight absent renders plain empty line, no json fence", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "not: [valid, yaml\n", "utf8")
      const now = new Date().toISOString()
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      await writeFile(
        join(root, ".ow", "checkpoints", "nightly.jsonl"),
        `${envelope("build", "not_observed", "pending", now)}\n${envelope("build", "not_observed", "pending", now)}\n`,
        "utf8",
      )
      const io = capture()
      try {
        expect(await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = await readFile(join(root, "bundle.md"), "utf8")
      expect(text).toContain("## preflight --json")
      expect(text).toContain("empty: preflight unavailable")
      expect(text.includes("```json")).toBe(false)
      expect(text).toContain("finding: build (not-observed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("export composition guard OW-011 (killable child + deadline)", () => {
  test("timeout RED-proof: a hanging composition is killed — explicit line, exit 1, no file", async () => {
    const { runExport } = await import("./up-export")
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      let killed = false
      const hanging = (): { result: Promise<{ code: number; stdout: string; stderr: string }>; kill: () => void } => ({
        result: new Promise(() => undefined),
        kill: () => {
          killed = true
        },
      })
      const io = capture()
      const start = Date.now()
      let code = -1
      try {
        code = await runExport({ rootDir: root, file, out: "bundle.md", timeoutMs: 200, spawnFn: hanging })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(Date.now() - start).toBeLessThan(5000)
      expect(killed).toBe(true)
      expect(io.err.join("\n")).toContain("export: timed out after 200ms (no bundle written)")
      expect(io.out.join("\n")).toBe("")
      const { existsSync } = await import("node:fs")
      expect(existsSync(join(root, "bundle.md"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cooperative deadline: a past deadline aborts in-process before any write", async () => {
    const { runExportInProcess } = await import("./up-export")
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const io = capture()
      let code = -1
      try {
        code = await runExportInProcess({ rootDir: root, file, out: "bundle.md", timeoutMs: 200, deadlineMs: Date.now() - 1 })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("export: timed out after 200ms (no bundle written)")
      const { existsSync } = await import("node:fs")
      expect(existsSync(join(root, "bundle.md"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("empty-witness through the guarded path: nothing readable, exit 1, no file", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "not: [valid, yaml\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["export", "--bundle", "--file", file, "--out", "bundle.md"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("export: nothing readable (no state, no checkpoints, no findings)")
      const { existsSync } = await import("node:fs")
      expect(existsSync(join(root, "bundle.md"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
