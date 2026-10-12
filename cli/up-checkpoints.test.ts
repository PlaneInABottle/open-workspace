/** P2-A checkpoints: file convention + list/show (fixture-first).
 * Read-only (ow never writes/prunes); no live exec. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"
import { isValidRunName, readCheckpointFile } from "./up-checkpoints"

const FIXTURES = resolve(import.meta.dir, "parity-fixtures")

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-p2a-"))

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

const writeRun = async (root: string, run: string, text: string): Promise<string> => {
  const { mkdir } = await import("node:fs/promises")
  const dir = join(root, ".ow", "checkpoints")
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${run}.jsonl`)
  await writeFile(file, text, "utf8")
  return file
}

const demoText = async (): Promise<string> => readFile(join(FIXTURES, "checkpoints-demo.jsonl"), "utf8")

describe("isValidRunName (no traversal)", () => {
  test("valid/invalid names", () => {
    for (const ok of ["night-run", "a", "A1_.x-y", "x".repeat(64)]) expect(isValidRunName(ok)).toBe(true)
    for (const bad of ["", "../x", "a/b", ".hidden", "-x", "a b", "x".repeat(65), "café", "a.json/../b"]) {
      expect(isValidRunName(bad)).toBe(false)
    }
  })
})

describe("readCheckpointFile (fixture-first)", () => {
  test("demo: 3 envelopes, skipped 0", async () => {
    const root = await tempRoot()
    try {
      const file = await writeRun(root, "demo", await demoText())
      const read = await readCheckpointFile(file)
      expect(read.envelopes).toHaveLength(3)
      expect(read.skipped).toEqual({ corrupt: 0, overCap: 0 })
      expect(read.totalLines).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt: 2 envelopes + corrupt 2 (parse + shape)", async () => {
    const root = await tempRoot()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-corrupt.jsonl"), "utf8")
      const file = await writeRun(root, "corrupt", text)
      const read = await readCheckpointFile(file)
      expect(read.envelopes).toHaveLength(2)
      expect(read.skipped.corrupt).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cap: 505 lines → 500 processed, skipped(5)", async () => {
    const root = await tempRoot()
    try {
      const line = `{"stage":"s","status":"not_observed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner"}\n`
      const file = await writeRun(root, "siskin", line.repeat(505))
      const read = await readCheckpointFile(file)
      expect(read.envelopes).toHaveLength(500)
      expect(read.skipped.overCap).toBe(5)
      expect(read.totalLines).toBe(505)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cap: a 256KB overflow is counted (few lines, bloated proof)", async () => {
    const root = await tempRoot()
    try {
      const big = `{"stage":"s","status":"not_observed","proof":"${"z".repeat(30000)}","at":"2026-10-09T08:00:00.000Z","by":"runner"}\n`
      const file = await writeRun(root, "siskin", big.repeat(10))
      const read = await readCheckpointFile(file)
      expect(read.skipped.overCap).toBeGreaterThan(0)
      expect(read.envelopes.length).toBeLessThan(10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("checkpoints show (CLI)", () => {
  const fixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    await writeRun(root, "demo", await demoText())
    return { root, file }
  }

  test("human output: confirmed/stale/not-observed + last/first + next", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "demo", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("confirmed: build (2026-10-09T08:00:00.000Z)")
      expect(text).toContain("stale: build (reason: script_hash)")
      expect(text).toContain("not-observed: deploy")
      expect(text).toContain("last confirmed: build (2026-10-09T08:00:00.000Z)")
      expect(text).toContain("first missing: build (stale: script_hash)")
      expect(text).toContain("next: pin the script and rerun")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json: envelope + summary + last_verified/first_gap", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "demo", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        run: string
        envelopes: { stage: string; status: string; stale_reason?: string }[]
        summary: { confirmed: number; stale: number; not_observed: number }
        last_verified: { stage: string } | null
        first_gap: { stage: string; stale_reason?: string } | null
        skipped: { corrupt: number; overCap: number }
      }
      expect(payload.run).toBe("demo")
      expect(payload.summary).toEqual({ confirmed: 1, stale: 1, not_observed: 1 })
      expect(payload.envelopes.map((line) => line.status)).toEqual(["confirmed", "stale", "not_observed"])
      expect(payload.envelopes[1].stale_reason).toBe("script_hash")
      expect(payload.last_verified?.stage).toBe("build")
      expect(payload.first_gap).toMatchObject({ stage: "build", stale_reason: "script_hash" })
      expect(payload.skipped).toEqual({ corrupt: 0, overCap: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt lines: exit 0 + warning + skipped count", async () => {
    const { root, file } = await fixture()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-corrupt.jsonl"), "utf8")
      await writeRun(root, "corrupt", text)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "corrupt", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("corrupt-line: 2 (skipped)")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "corrupt", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect((JSON.parse(io2.out.join("\n")) as { skipped: unknown }).skipped).toEqual({ corrupt: 2, overCap: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("sentinel: proof/action masked, no hunter2", async () => {
    const { root, file } = await fixture()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-sentinel.jsonl"), "utf8")
      await writeRun(root, "hidden", text)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "hidden", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "hidden", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const human = io2.out.join("\n") + "\n" + io2.err.join("\n")
      expect(human).not.toContain("hunter2")
      expect(io2.out.join("\n")).toContain("next:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing file exit 1; invalid run name exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "missing", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("ow: no checkpoint: missing")
      for (const args of [["checkpoints", "show", "../x"], ["checkpoints", "show", "a/b"], ["checkpoints"], ["checkpoints", "bogus"], ["checkpoints", "show"], ["checkpoints", "list", "extra"]]) {
        const io2 = capture()
        let code2 = -1
        try {
          code2 = await run([...args, "--file", file])
        } finally {
          io2.restore()
        }
        expect(`${args.join(" ")} → ${code2}`).toBe(`${args.join(" ")} → 2`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("checkpoints list (CLI)", () => {
  test("empty directory: exit 0 + honest-empty", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "list", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("no checkpoints")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runs: name + count + summary + last at (text + json)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await writeRun(root, "demo", await demoText())
      const io = capture()
      try {
        expect(await run(["checkpoints", "list", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("demo (3 envelopes: 1 confirmed, 1 stale, 1 not-observed; last: 2026-10-09T09:05:00.000Z)")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "list", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { runs: { run: string; count: number; summary: unknown; lastAt: string }[] }
      expect(payload.runs).toHaveLength(1)
      expect(payload.runs[0]).toMatchObject({ run: "demo", count: 3, lastAt: "2026-10-09T09:05:00.000Z" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-A side_effect flags + retry hint + attempt tree", () => {
  const sideFixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    await writeRun(root, "effect", await readFile(join(FIXTURES, "checkpoints-side-effect.jsonl"), "utf8"))
    await writeRun(root, "lineage", await readFile(join(FIXTURES, "checkpoints-lineage.jsonl"), "utf8"))
    await writeRun(root, "corrupt-ma", await readFile(join(FIXTURES, "checkpoints-hostile-ma.jsonl"), "utf8"))
    return { root, file }
  }

  test("flag lines: none/attempted/confirmed/unknown + counts", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "effect", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("side-effect: build (none)")
      expect(text).toContain("side-effect: test (attempted, attempted: 2)")
      expect(text).toContain("side-effect: deploy (confirmed, attempted: 1, confirmed: 1)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a missing side_effect renders unknown (no warning)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "lineage", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("side-effect: build (unknown)")
      expect(io.err.join("\n")).not.toContain("bilinmiyor")
      expect(io.err.join("\n")).not.toMatch(/[\u00e7\u011f\u0131\u015f\u00f6\u00fc\u00c7\u011e\u0130\u015e\u00d6\u00dc]/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("attempted-unconfirmed retry hint (locked text, single)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "lineage", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const hint = "before-retry: ow reconcile --check"
      const hits = io.out.join("\n").split(hint).length - 1
      expect(hits).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a later confirmed attempt extinguishes the hint (read-only, no exec)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await writeRun(root, "kapanan", [
        `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner","side_effect":"attempted"}`,
        `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T09:00:00.000Z","by":"runner","side_effect":"confirmed"}`,
      ].join("\n") + "\n")
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "kapanan", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("before-retry:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("explicit-field tree: scenario → attempt (locked words + unconfirmed)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "lineage", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("scenario: night")
      expect(text).toContain("attempt 1: build (confirmed)")
      expect(text).toContain("attempt 2: test (confirmed, unconfirmed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("suffix: run-name suffix + unattributed-flat (ungrouped)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await writeRun(root, "night-attempt2", `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner","code":{"script_hash":"s1","checkout_rev":"r1"},"runtime":{"port":1}}\n`)
      await writeRun(root, "flat", `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner"}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "night-attempt2", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const suffixText = io.out.join("\n")
      expect(suffixText).toContain("scenario: night")
      expect(suffixText).toContain("attempt 2: build (confirmed)")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "flat", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("scenario:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("suffix alias: run-name `-deneme<N>` groups the same as `-attempt<N>`", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await writeRun(root, "night-deneme2", `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner","code":{"script_hash":"s1","checkout_rev":"r1"},"runtime":{"port":1}}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "night-deneme2", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("scenario: night")
      expect(text).toContain("attempt 2: build (confirmed)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile M-A: all 13 lines count as corrupt (fail-closed)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "corrupt-ma", "--file", file, "--json"])).toBe(1)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as { envelopes: unknown[]; skipped: { corrupt: number } }
      expect(payload.envelopes).toHaveLength(0)
      expect(payload.skipped.corrupt).toBe(13)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json carries the new fields (flag/count/lineage)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "effect", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        envelopes: { side_effect?: string; side_effect_counts?: unknown; scenario?: string; attempt?: number; step_signature?: string }[]
      }
      expect(payload.envelopes[0]).toMatchObject({ side_effect: "none", scenario: "night", attempt: 1, step_signature: "build-signature" })
      expect(payload.envelopes[1]).toMatchObject({ side_effect: "attempted", side_effect_counts: { attempted: 2 }, attempt: 2 })
      expect(payload.envelopes[2]).toMatchObject({ side_effect: "confirmed" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-B code-map gate (legacy-stable + single-deviation)", () => {
  const codeFixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    await writeRun(root, "map", await readFile(join(FIXTURES, "checkpoints-code-map.jsonl"), "utf8"))
    await writeRun(root, "corrupt-mb", await readFile(join(FIXTURES, "checkpoints-hostile-mb.jsonl"), "utf8"))
    return { root, file }
  }

  test("mixed old/new array: confirmed, confirmed, single script_hash-deviation", async () => {
    const { root, file } = await codeFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "map", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        envelopes: { status: string; stale_reason?: string; code?: unknown }[]
        summary: { confirmed: number; stale: number; not_observed: number }
      }
      expect(payload.envelopes.map((line) => line.status)).toEqual(["confirmed", "confirmed", "stale"])
      expect(payload.envelopes[2].stale_reason).toBe("script_hash")
      expect(payload.envelopes[1].code).toEqual({ runner: "r1", body: "s1" })
      expect(payload.envelopes[2].code).toEqual({ runner: "r1", fixture: "f1", body: "s2", provider_contract: "pc1" })
      expect(payload.summary).toEqual({ confirmed: 2, stale: 1, not_observed: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile M-B: all 6 lines count as corrupt (conflict + undisciplined slot)", async () => {
    const { root, file } = await codeFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "corrupt-mb", "--file", file, "--json"])).toBe(1)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as { envelopes: unknown[]; skipped: { corrupt: number } }
      expect(payload.envelopes).toHaveLength(0)
      expect(payload.skipped.corrupt).toBe(6)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("positional grammar preserved", () => {
  test("in other commands a second positional still exits 2", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      const io = capture()
      try {
        expect(await run(["up", "a", "b", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("unexpected argument: b")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M7 envelope data passthrough (opaque, read-only)", () => {
  test("data object survives the read path verbatim; malformed data drops, envelope lives", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-m7-"))
    try {
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      const good = JSON.stringify({
        stage: "build",
        status: "confirmed",
        proof: { ok: true },
        at: "2026-10-09T08:00:00.000Z",
        by: "runner",
        data: { revField: "r1", "freshness-ignores": true },
      })
      const bad = JSON.stringify({
        stage: "test",
        status: "confirmed",
        proof: { ok: true },
        at: "2026-10-09T08:05:00.000Z",
        by: "runner",
        data: ["not", "an", "object"],
      })
      await writeFile(join(root, ".ow", "checkpoints", "nightly.jsonl"), `${good}\n${bad}\n`, "utf8")
      const read = await readCheckpointFile(join(root, ".ow", "checkpoints", "nightly.jsonl"))
      expect(read.envelopes).toHaveLength(2)
      expect(read.envelopes[0].data).toEqual({ revField: "r1", "freshness-ignores": true })
      expect(read.envelopes[1].data).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-j checkpoint reader refuses non-regular files (no hang, no follow)", () => {
  test("symlinked checkpoint file throws (fail-closed upstream)", async () => {
    const root = await tempRoot()
    try {
      const real = join(root, "real.jsonl")
      await writeFile(real, `${JSON.stringify({ stage: "build", status: "confirmed", proof: { ok: true }, at: "2026-10-09T08:00:00.000Z", by: "runner" })}\n`, "utf8")
      const { symlink } = await import("node:fs/promises")
      const link = join(root, "link.jsonl")
      await symlink(real, link)
      const { readCheckpointFile } = await import("./up-checkpoints")
      await expect(readCheckpointFile(link)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
