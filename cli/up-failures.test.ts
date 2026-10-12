/** M-D failures: mekanik demet + iki-deneme kuralı + since filtresi.
 * Salt-okunur (dosya okuma dışında I/O yok); sınıflandırma yok. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m4-"))

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

const writeRun = async (root: string, run: string, text: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises")
  const dir = join(root, ".ow", "checkpoints")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${run}.jsonl`), text, "utf8")
}

const fixture = async (): Promise<{ root: string; file: string }> => {
  const root = await tempRoot()
  const file = join(root, "ow.yaml")
  await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
  return { root, file }
}

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry)

describe("failures boş + kullanım", () => {
  test("boş dizin: exit 0 + bulgu yok (metin + json)", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("no findings")
      const io2 = capture()
      try {
        expect(await run(["failures", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(JSON.parse(io2.out.join("\n"))).toEqual({ groups: [], singletons: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--since çöpü exit 2 (kilitli küme dışı)", async () => {
    const { root, file } = await fixture()
    try {
      for (const since of ["30d", "x", "", "1H", "24"]) {
        const io = capture()
        let code = -1
        try {
          code = await run(["failures", "--file", file, "--since", since])
        } finally {
          io.restore()
        }
        expect(`${since} → ${code}`).toBe(`${since} → 2`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("konumsal argüman exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["failures", "bogus", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("failures mekanik demet", () => {
  const staleBuild = (at: string, extra: Record<string, unknown> = {}): string =>
    line({ stage: "build", status: "stale", stale_reason: "script_hash", proof: "x", at, by: "runner", ...extra })

  test("aynı demet sayılır, adım-imzası ayırır, eksik adım '-' olur", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(root, "kosu1", `${staleBuild(at, { scenario: "gece", attempt: 1, step_signature: "imza-1" })}\n`)
      await writeRun(root, "kosu2", `${staleBuild(at, { scenario: "gece", attempt: 2, step_signature: "imza-1" })}\n${staleBuild(at, { scenario: "gece", attempt: 2, step_signature: "imza-2" })}\n`)
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("finding: build (stale, reason: script_hash, step: imza-1) ×2")
      expect(text).toContain("finding: build (stale, reason: script_hash, step: imza-2) ×1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing step bucket renders '-' in human output, null in json", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(root, "kosu1", `${staleBuild(at, { scenario: "gece", attempt: 1 })}\n`)
      await writeRun(root, "kosu2", `${staleBuild(at, { scenario: "gece", attempt: 2 })}\n`)
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("finding: build (stale, reason: script_hash, step: -) ×2")
      const io2 = capture()
      try {
        expect(await run(["failures", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { groups: { step: string | null }[] }
      expect(payload.groups).toEqual([
        { stage: "build", status: "stale", stale_reason: "script_hash", step: null, count: 2 },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json anahtarları İngilizce + katkımsal (demet + tekil-sayım)", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(root, "kosu1", `${staleBuild(at, { scenario: "gece", attempt: 1 })}\n`)
      await writeRun(root, "kosu2", `${staleBuild(at, { scenario: "gece", attempt: 2 })}\n`)
      const io = capture()
      try {
        expect(await run(["failures", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        groups: { stage: string; status: string; stale_reason: string | null; step: string | null; count: number }[]
        singletons: number
      }
      expect(Object.keys(payload).sort()).toEqual(["groups", "singletons"])
      expect(payload.groups).toEqual([
        { stage: "build", status: "stale", stale_reason: "script_hash", step: null, count: 2 },
      ])
      expect(payload.singletons).toBe(0)
      expect(io.out.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doğrulanmış zarflar asla listelenmez", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(
        root,
        "saglam",
        `${line({ stage: "build", status: "confirmed", proof: "x", at, by: "runner", code: { runner: "r1", body: "s1" }, runtime: { port: 1 }, scenario: "gece", attempt: 1 })}\n` +
          `${line({ stage: "build", status: "confirmed", proof: "x", at, by: "runner", code: { runner: "r1", body: "s1" }, runtime: { port: 1 }, scenario: "gece", attempt: 2 })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("no findings")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("tazelik-hesaplı bayat demete girer", async () => {
    const { root, file } = await fixture()
    try {
      await writeRun(
        root,
        "taze",
        `${line({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T08:00:00.000Z", by: "runner", code: { runner: "r1", body: "s1" }, runtime: { port: 1 }, scenario: "gece", attempt: 1 })}\n` +
          `${line({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T09:00:00.000Z", by: "runner", code: { runner: "r1", body: "s2" }, runtime: { port: 1 }, scenario: "gece", attempt: 2 })}\n` +
          `${line({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T10:00:00.000Z", by: "runner", code: { runner: "r1", body: "s2" }, runtime: { port: 1 }, scenario: "gece", attempt: 3 })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("finding: build (stale, reason: script_hash, step: -) ×2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("failures iki-deneme kuralı (burada, show'da değil)", () => {
  const gap = (scenario: string, attempt: number, at: string): string =>
    line({ stage: "build", status: "not_observed", proof: "x", at, by: "runner", scenario, attempt })

  test("tekil bastırılır, ikinci deneme listeler (sonek-yeğlemeli)", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(root, "gece-attempt1", `${gap("gece", 1, at)}\n`)
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("no-repeat: 1 unique findings unlisted")
      expect(io.out.join("\n")).not.toContain("finding: build")
      // Sonek-çözümlü ikinci deneme (açık alan yok — koşu-adı yedeği).
      await writeRun(root, "gece-attempt2", `${line({ stage: "build", status: "not_observed", proof: "x", at, by: "runner" })}\n`)
      const io2 = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const text = io2.out.join("\n")
      expect(text).toContain("finding: build (not-observed, step: -) ×2")
      expect(text).not.toContain("no-repeat")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("demet + tekil bir arada (özet satırı korunur)", async () => {
    const { root, file } = await fixture()
    try {
      const at = new Date().toISOString()
      await writeRun(root, "gece-attempt1", `${gap("gece", 1, at)}\n`)
      await writeRun(root, "gece-attempt2", `${gap("gece", 2, at)}\n`)
      await writeRun(root, "yalniz", `${line({ stage: "deploy", status: "not_observed", proof: "x", at, by: "runner" })}\n`)
      const io = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("finding: build (not-observed, step: -) ×2")
      expect(text).toContain("no-repeat: 1 unique findings unlisted")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("failures --since filtresi (kilitli küme)", () => {
  test("eski zarflar elenir, taze kalır (1h|24h|7d)", async () => {
    const { root, file } = await fixture()
    try {
      const now = Date.now()
      const old = "2026-01-01T00:00:00.000Z"
      const recent = new Date(now - 30 * 60_000).toISOString()
      await writeRun(
        root,
        "karisik",
        `${line({ stage: "build", status: "not_observed", proof: "x", at: old, by: "runner", scenario: "eski", attempt: 1 })}\n` +
          `${line({ stage: "build", status: "not_observed", proof: "x", at: old, by: "runner", scenario: "eski", attempt: 2 })}\n` +
          `${line({ stage: "test", status: "not_observed", proof: "x", at: recent, by: "runner", scenario: "yeni", attempt: 1 })}\n` +
          `${line({ stage: "test", status: "not_observed", proof: "x", at: recent, by: "runner", scenario: "yeni", attempt: 2 })}\n`,
      )
      const io = capture()
      try {
        expect(await run(["failures", "--file", file, "--since", "1h"])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("finding: test (not-observed, step: -) ×2")
      expect(text).not.toContain("finding: build")
      const io2 = capture()
      try {
        expect(await run(["failures", "--file", file, "--since", "7d"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("finding: build")
      const io3 = capture()
      try {
        expect(await run(["failures", "--file", file])).toBe(0)
      } finally {
        io3.restore()
      }
      expect(io3.out.join("\n")).toContain("finding: build (not-observed, step: -) ×2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("failures mekanik-denetim (sınıflandırma yok, exec yok)", () => {
  const FORBIDDEN = [
    "severity",
    "kritik",
    "önem",
    "şiddet",
    "sınıf",
    "klas",
    "küme",
    "cluster",
    "eğilim",
    "trend",
    "tavsiye",
    "öner",
    "suggest",
    "keyword",
    "etiket",
    "label",
    "öncelik",
    "priorit",
  ]

  test("fiil uydurma-sınıflandırma sözcüğü taşımaz", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile(resolve(import.meta.dir, "up-failures.ts"), "utf8")
    for (const stem of FORBIDDEN) {
      const hit = new RegExp(`\\b${stem}`).exec(source)
      expect(`${stem} → ${hit?.[0] ?? "yok"}`).toBe(`${stem} → yok`)
    }
  })

  test("fiil exec/budama çağrısı taşımaz (salt-okunur)", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile(resolve(import.meta.dir, "up-failures.ts"), "utf8")
    for (const pattern of ["spawn", "exec", "unlink", "writeFile", "rename", "child_process", "fork"] as const) {
      expect(source.includes(pattern)).toBe(false)
    }
  })
})
