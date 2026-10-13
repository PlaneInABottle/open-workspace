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

  test("ungrouped-negative: run-name `-deneme<N>` no longer groups (removed alias)", async () => {
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
      expect(text).not.toContain("scenario: night")
      expect(text).not.toContain("attempt 2:")
      expect(text).toContain("confirmed: build")
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

describe("checkpoints show --resume (resume/first-gap view)", () => {
  const T1 = "2026-10-09T08:00:00.000Z"
  const T2 = "2026-10-09T09:00:00.000Z"
  const T3 = "2026-10-09T10:00:00.000Z"
  const SCENARIOS = "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: ready, argv: [./ready.sh], timeout: 10s}]\n    checkpoints: [approval]\n"

  const envLine = (stage: string, status: string, at: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ stage, status, proof: `proof-${stage}`, at, by: "runner", code: { runner: "r1" }, ...extra })

  const resumeRoot = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    return { root, file }
  }

  const recordCart = async (root: string): Promise<void> => {
    const scenarios = join(root, "ow.scenarios.yaml")
    await writeFile(scenarios, SCENARIOS, "utf8")
    const { runRecord } = await import("./up-replay")
    const io = capture()
    try {
      expect(
        await runRecord({
          rootDir: root,
          file: scenarios,
          runName: "cart",
          probeFn: async () => ({ ok: true, note: "fake-ready", timedOut: false, code: 0 }),
        }),
      ).toBe(0)
    } finally {
      io.restore()
    }
  }

  test("last-pass selection prefers newest gapless run, checkpoints-only labeled, existing lines first", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "old", `${envLine("build", "confirmed", T1)}\n${envLine("deploy", "confirmed", T1)}\n`)
      await writeRun(root, "new", `${envLine("build", "confirmed", T2)}\n${envLine("deploy", "confirmed", T2)}\n`)
      await writeRun(root, "now", `${envLine("build", "confirmed", T3)}\n${envLine("deploy", "not_observed", T3)}\n`)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "now", "--resume", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("last confirmed: build")
      expect(text).toContain("first missing: deploy (not-observed)")
      expect(text.indexOf("first missing:")).toBeLessThan(text.indexOf("resume: last-pass"))
      expect(text).toContain(`resume: last-pass new (${T2}, checkpoints-only)`)
      expect(text).toContain("resume: invalidated-by diff: deploy (confirmed -> not-observed), digest: dfda8621 -> ae875609")
      expect(text).toContain("resume: first-gap deploy (not-observed)")
      expect(text).toContain("resume: next-action external-side-effect (side_effect: absent)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("invalidation lines verbatim; identical target yields none", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "base", `${envLine("build", "confirmed", T1, { proof: "proof-X" })}\n`)
      await writeRun(root, "tip", `${envLine("build", "confirmed", T2, { proof: "proof-Y" })}\n${envLine("deploy", "not_observed", T3)}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "tip", "--resume", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain(
        "resume: invalidated-by diff: build (confirmed -> confirmed), proof: proof-X -> proof-Y, digest: 296c6b15 -> bd1a096a",
      )
      expect(text).toContain("resume: invalidated-by diff: deploy (missing -> not-observed)")
      // Identical: the target itself is the newest pass — no invalidation lines.
      await writeRun(root, "solo", `${envLine("build", "confirmed", T2)}\n`)
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "solo", "--resume", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const solo = io2.out.join("\n")
      expect(solo).toContain(`resume: last-pass solo (${T2}, checkpoints-only)`)
      expect(solo).not.toContain("resume: invalidated-by")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("first-gap mirrors first-missing (stale variant)", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "pass", `${envLine("build", "confirmed", T1)}\n`)
      await writeRun(
        root,
        "stale",
        `${envLine("build", "confirmed", T2)}\n${JSON.stringify({ stage: "build", status: "stale", stale_reason: "script_hash", proof: "proof-build", at: T3, by: "runner", code: { runner: "r1" } })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "stale", "--resume", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("first missing: build (stale: script_hash)")
      expect(text).toContain("resume: first-gap build (stale: script_hash)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("next-action mapping table (unit)", async () => {
    const { classifyNextAction } = await import("./up-checkpoints")
    const cases: [string | undefined, string | undefined, boolean, boolean, string, string][] = [
      ["none", "run ow restart api", false, false, "read-only", "side_effect: none"],
      ["none", undefined, false, false, "read-only", "side_effect: none"],
      ["attempted", "run ow reconcile --check", false, false, "read-only", "safe_next_action: run ow reconcile --check"],
      ["attempted", "ow ps", false, false, "read-only", "safe_next_action: ow ps"],
      ["attempted", "run ow restart api", false, false, "permitted-write", "side_effect: attempted, safe_next_action: run ow restart api"],
      ["confirmed", "run ow restart api", true, false, "permitted-write", "side_effect: confirmed, safe_next_action: run ow restart api"],
      ["confirmed", "run ow restart api", false, false, "external-side-effect", "side_effect: confirmed without restore evidence"],
      ["confirmed", "ow scenario run nightly", true, false, "permitted-write", "side_effect: confirmed, safe_next_action: ow scenario run nightly"],
      ["attempted", "ow scenario env nightly", false, false, "read-only", "safe_next_action: ow scenario env nightly"],
      ["attempted", undefined, false, false, "external-side-effect", "side_effect: attempted, no action named"],
      ["attempted", "pin the script and rerun", false, false, "external-side-effect", "side_effect: attempted, no classifiable action"],
      ["attempted", "walk down the road slowly", false, false, "external-side-effect", "side_effect: attempted, no classifiable action"],
      ["unknown", "run ow ps", false, false, "external-side-effect", "side_effect: unknown"],
      [undefined, "run ow ps", false, false, "external-side-effect", "side_effect: absent"],
      ["attempted", "run ow ps", false, true, "external-side-effect", "incomplete evidence (skipped or unreadable runs)"],
      ["none", "run ow restart api", false, true, "external-side-effect", "incomplete evidence (skipped or unreadable runs)"],
    ]
    for (const [sideEffect, action, restore, incomplete, cls, basis] of cases) {
      expect(classifyNextAction(sideEffect, action, restore, incomplete)).toEqual({ class: cls, basis })
    }
  })

  test("corrupt sibling warns + forces external; fully-unreadable siblings exit 1", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "now", `${envLine("build", "confirmed", T1)}\n${envLine("deploy", "confirmed", T1)}\n`)
      await writeRun(root, "messy", `${envLine("build", "confirmed", T1)}\n{{{corrupt\n`)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "now", "--resume", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const payload = JSON.parse(io.out.join("\n")) as {
        resume: { evidenceIncomplete: boolean; nextAction: { class: string; basis: string } }
      }
      expect(payload.resume.evidenceIncomplete).toBe(true)
      expect(payload.resume.nextAction).toEqual({
        class: "external-side-effect",
        basis: "incomplete evidence (skipped or unreadable runs)",
      })
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "now", "--resume", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).toContain("corrupt-line: messy: 1 (skipped)")
      expect(io2.out.join("\n")).toContain("resume: next-action external-side-effect (incomplete evidence (skipped or unreadable runs))")
      // Fully-unreadable sibling set: a directory shaped like a run file.
      const { mkdir } = await import("node:fs/promises")
      await rm(join(root, ".ow", "checkpoints", "messy.jsonl"), { force: true })
      await mkdir(join(root, ".ow", "checkpoints", "bad.jsonl"), { recursive: true })
      const io3 = capture()
      try {
        code = await run(["checkpoints", "show", "now", "--resume", "--file", file])
      } finally {
        io3.restore()
      }
      expect(code).toBe(1)
      expect(io3.err.join("\n")).toContain("ow: unreadable checkpoint: bad")
      expect(io3.out.join("\n")).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unreadable sibling names itself in warnings + forces external (exit stays 0)", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "now", `${envLine("build", "confirmed", T1)}\n${envLine("deploy", "confirmed", T1, { side_effect: "none" })}\n`)
      await writeRun(root, "good", `${envLine("build", "confirmed", T1)}\n`)
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(root, ".ow", "checkpoints", "bad.jsonl"), { recursive: true })
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "now", "--resume", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("unreadable: bad (skipped)")
      expect(io.out.join("\n")).toContain("resume: next-action external-side-effect (incomplete evidence (skipped or unreadable runs))")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "now", "--resume", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        resume: { evidenceIncomplete: boolean; nextAction: { class: string } }
      }
      expect(payload.resume.evidenceIncomplete).toBe(true)
      expect(payload.resume.nextAction.class).toBe("external-side-effect")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json single object with additive resume, existing keys unchanged", async () => {    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "now", `${envLine("build", "confirmed", T1)}\n${envLine("deploy", "not_observed", T2)}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "now", "--resume", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(["envelopes", "first_gap", "last_verified", "resume", "run", "skipped", "summary"])
      const resume = payload["resume"] as Record<string, unknown>
      expect(Object.keys(resume).sort()).toEqual(["evidenceIncomplete", "firstGap", "invalidatedBy", "lastPass", "nextAction"])
      expect(resume["lastPass"]).toBeNull()
      expect(resume["evidenceIncomplete"]).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile secret-absence (shaped proof/stage/action, folded paths)", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "pass", `${envLine("build", "confirmed", T1)}\n`)
      await writeRun(
        root,
        "evil",
        `${JSON.stringify({ stage: "build", status: "confirmed", proof: "/var/log/app/server.log token=hunter2", at: T1, by: "runner", code: { runner: "r1" } })}\n${JSON.stringify({ stage: "deploy api_key=hunter2", status: "not_observed", proof: "proof-deploy", at: T2, by: "runner", code: { runner: "r1" }, side_effect: "none", safe_next_action: "retry --token hunter2" })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "evil", "--resume", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      // Existing show keys carry raw stage shapes by design (locked) — the
      // resume subtree must not carry secret shapes. Non-root abs paths in
      // proof cells follow the existing proofHead render (root-fold only,
      // shared verbatim with `checkpoints diff` — pinned below).
      const payload = JSON.parse(io.out.join("\n")) as { resume: Record<string, unknown> }
      expect(JSON.stringify(payload["resume"])).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "evil", "--resume", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const lines = io2.out.join("\n").split("\n")
      const resumeLines = lines.filter((line) => line.startsWith("resume:"))
      expect(resumeLines.join("\n")).not.toContain("hunter2")
      expect(resumeLines.join("\n")).toContain("resume: first-gap deploy api_key=*** (not-observed)")
      // side_effect none wins before verb parsing (locked mapping order).
      expect(resumeLines.join("\n")).toContain("resume: next-action read-only (side_effect: none)")
      expect(io2.out.join("\n")).toContain("next: retry --token ***")
      // Verbatim reuse: the diff verb renders the identical build row.
      const ioDiff = capture()
      try {
        expect(await run(["checkpoints", "diff", "pass", "evil", "--file", file])).toBe(0)
      } finally {
        ioDiff.restore()
      }
      const diffBuild = ioDiff.out
        .join("\n")
        .split("\n")
        .find((line) => line.startsWith("diff: build (confirmed -> confirmed)"))!
      expect(diffBuild).toContain("proof: proof-build -> /var/log/app/server.log token=***")
      expect(resumeLines.join("\n")).toContain(`resume: invalidated-by ${diffBuild}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("contract-verified last-pass wins; mismatch/missing fall to none", async () => {
    const { root, file } = await resumeRoot()
    const scenarios = join(root, "ow.scenarios.yaml")
    try {
      await recordCart(root)
      await writeRun(root, "gold", `${envLine("build", "confirmed", T1, { scenario: "cart" })}\n${envLine("deploy", "confirmed", T1, { scenario: "cart" })}\n`)
      await writeRun(root, "cur", `${envLine("build", "confirmed", T2, { scenario: "cart" })}\n${envLine("deploy", "not_observed", T3, { scenario: "cart" })}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "cur", "--resume", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain(`resume: last-pass gold (${T1})`)
      expect(text).not.toContain("checkpoints-only")
      // Break the recorded contract: the linked run no longer verifies.
      await writeFile(scenarios, SCENARIOS.replace("./ready.sh", "./changed.sh"), "utf8")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "cur", "--resume", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).toContain("resume: last-pass none")
      // Missing scenarios file: lineage present but unverifiable → none.
      await rm(scenarios, { force: true })
      const io3 = capture()
      try {
        expect(await run(["checkpoints", "show", "cur", "--resume", "--file", file])).toBe(0)
      } finally {
        io3.restore()
      }
      expect(io3.out.join("\n")).toContain("resume: last-pass none")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--resume outside show refuses; show without --resume has no resume lines", async () => {
    const { root, file } = await resumeRoot()
    try {
      await writeRun(root, "demo", `${envLine("build", "confirmed", T1)}\n`)
      for (const args of [
        ["checkpoints", "list", "--file", file, "--resume"],
        ["checkpoints", "diff", "demo", "demo", "--file", file, "--resume"],
        ["ps", "--file", file, "--resume"],
      ]) {
        const io = capture()
        let code = -1
        try {
          code = await run(args)
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toBe(`${args.join(" ")} → 2`)
        expect(io.err.join("\n")).toContain("ow: --resume works only with checkpoints show")
      }
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "demo", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("resume:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
