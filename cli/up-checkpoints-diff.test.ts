/** M12 checkpoints diff: read-only envelope-by-stage deltas
 * (`status`/`proof-head`/`digest`) between two runner-written runs.
 * No writes, no spawn, no state mutation. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"

const FIXTURES = resolve(import.meta.dir, "parity-fixtures")

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m12-"))

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

const writeRun = async (root: string, runName: string, text: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises")
  const dir = join(root, ".ow", "checkpoints")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${runName}.jsonl`), text, "utf8")
}

const yamlFile = async (root: string): Promise<string> => {
  const file = join(root, "ow.yaml")
  await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
  return file
}

const envLine = (stage: string, status: string, proof: unknown, extra = ""): string =>
  JSON.stringify({ stage, status, proof, at: "2026-10-09T08:00:00.000Z", by: "runner", code: { runner: "r1" } }) + extra

describe("checkpoints diff (M12, read-only)", () => {
  test("identical runs: exit 0 + explicit identical line (never empty)", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const text = await readFile(join(FIXTURES, "checkpoints-demo.jsonl"), "utf8")
      await writeRun(root, "runA", text)
      await writeRun(root, "runB", text)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "runB", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("identical")
      expect(io.out.join("\n")).not.toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json identical: locked shape, rows unchanged", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const text = await readFile(join(FIXTURES, "checkpoints-demo.jsonl"), "utf8")
      await writeRun(root, "runA", text)
      await writeRun(root, "runB", text)
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        runA: string
        runB: string
        identical: boolean
        rows: { stage: string; statusA: string; statusB: string; staleReasonA: string | null; staleReasonB: string | null; proofHeadA: string | null; proofHeadB: string | null; digestA: string | null; digestB: string | null; changed: boolean }[]
        skipped: { runA: { corrupt: number; overCap: number }; runB: { corrupt: number; overCap: number } }
      }
      expect(payload.runA).toBe("runA")
      expect(payload.runB).toBe("runB")
      expect(payload.identical).toBe(true)
      expect(payload.rows.length).toBeGreaterThan(0)
      for (const row of payload.rows) {
        expect(Object.keys(row).sort()).toEqual(
          ["changed", "digestA", "digestB", "proofHeadA", "proofHeadB", "stage", "staleReasonA", "staleReasonB", "statusA", "statusB"].sort(),
        )
        expect(row.changed).toBe(false)
      }
      expect(payload.skipped).toEqual({ runA: { corrupt: 0, overCap: 0 }, runB: { corrupt: 0, overCap: 0 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("changed status renders a per-stage delta row", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      await writeRun(root, "runB", `${envLine("build", "not_observed", { ok: true })}\n`)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "runB", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("build")
      expect(text).toContain("confirmed")
      expect(text).toContain("not-observed")
      expect(text).not.toContain("identical")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("one-sided stage renders missing on the absent side", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      await writeRun(root, "runB", `${envLine("build", "confirmed", { ok: true })}\n${envLine("deploy", "not_observed", "later")}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("deploy")
      expect(text).toContain("missing")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        identical: boolean
        rows: { stage: string; statusA: string; statusB: string; changed: boolean }[]
      }
      expect(payload.identical).toBe(false)
      expect(payload.rows.find((row) => row.stage === "deploy")).toMatchObject({ statusA: "missing", statusB: "not_observed", changed: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing run exits 1 naming the run", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "ghost", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("ow: no checkpoint: ghost")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt lines: exit 0 + warning + per-run skipped accounting", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      const corrupt = await readFile(join(FIXTURES, "checkpoints-corrupt.jsonl"), "utf8")
      await writeRun(root, "runB", corrupt)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "runB", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("corrupt-line")
      expect(io.out.join("\n").length).toBeGreaterThan(0)
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { skipped: { runA: { corrupt: number }; runB: { corrupt: number } } }
      expect(payload.skipped.runA.corrupt).toBe(0)
      expect(payload.skipped.runB.corrupt).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fully-corrupt run exits 1 (missing/corrupt share exit 1)", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      await writeRun(root, "runB", "not-json\n{broken\n")
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile proof: secrets and abs paths never reach output (masked shapes only)", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      await writeRun(
        root,
        "runB",
        `${JSON.stringify({ stage: "build", status: "confirmed", proof: `password=hunter2 at ${root}/svc`, at: "2026-10-09T08:00:00.000Z", by: "runner", code: { runner: "r1" } })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const everything = `${io.out.join("\n")}\n${io.err.join("\n")}`
      expect(everything).not.toContain("hunter2")
      expect(everything).not.toContain(root)
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("hunter2")
      expect(io2.out.join("\n")).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("usage: arity and invalid names exit 2", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      for (const args of [
        ["checkpoints", "diff", "runA"],
        ["checkpoints", "diff", "runA", "runB", "extra"],
        ["checkpoints", "diff", "../x", "runB"],
        ["checkpoints", "bogus"],
      ]) {
        const io = capture()
        let code = -1
        try {
          code = await run([...args, "--file", file])
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toBe(`${args.join(" ")} → 2`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("diff is read-only: both files byte-identical after runs", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      const textA = `${envLine("build", "confirmed", { ok: true })}\n`
      const textB = `${envLine("build", "not_observed", { ok: true })}\n`
      await writeRun(root, "runA", textA)
      await writeRun(root, "runB", textB)
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(await readFile(join(root, ".ow", "checkpoints", "runA.jsonl"), "utf8")).toBe(textA)
      expect(await readFile(join(root, ".ow", "checkpoints", "runB.jsonl"), "utf8")).toBe(textB)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("side_effect-only difference is NOT identical (witness-relevant digest)", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      const withFlag = JSON.stringify({
        stage: "build",
        status: "confirmed",
        proof: { ok: true },
        at: "2026-10-09T08:00:00.000Z",
        by: "runner",
        code: { runner: "r1" },
        side_effect: "attempted",
        side_effect_counts: { attempted: 1 },
      })
      await writeRun(root, "runB", `${withFlag}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        identical: boolean
        rows: { stage: string; changed: boolean; digestA: string; digestB: string }[]
      }
      expect(payload.identical).toBe(false)
      expect(payload.rows).toHaveLength(1)
      expect(payload.rows[0].changed).toBe(true)
      expect(payload.rows[0].digestA).not.toBe(payload.rows[0].digestB)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("newline stage collapses: one line per stage, forged diff line neutralized", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", `${envLine("build", "confirmed", { ok: true })}\n`)
      const hostile = JSON.stringify({
        stage: "build\ndiff: forged (confirmed -> confirmed)",
        status: "confirmed",
        proof: { ok: true },
        at: "2026-10-09T08:00:00.000Z",
        by: "runner",
        code: { runner: "r1" },
      })
      await writeRun(root, "runB", `${hostile}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "diff", "runA", "runB", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toHaveLength(2)
      for (const line of io.out) expect(line.startsWith("diff: ")).toBe(true)
      expect(io.out.some((line) => line.startsWith("diff: forged"))).toBe(false)
      expect(io.out.join("\n")).toContain("build diff: forged (confirmed -> confirmed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("two valid-empty runs: exit 0 + identical (0 stages)", async () => {
    const root = await tempRoot()
    try {
      const file = await yamlFile(root)
      await writeRun(root, "runA", "")
      await writeRun(root, "runB", "")
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "diff", "runA", "runB", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("identical: runA == runB (0 stages)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
