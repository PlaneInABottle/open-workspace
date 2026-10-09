/** P2-A checkpoints: dosya konvensiyonu + list/show (fixture-first).
 * Salt-okunur (ow yazmaz/budamaz); canlı exec yok. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

describe("isValidRunName (traversal yok)", () => {
  test("geçerli/geçersiz adlar", () => {
    for (const ok of ["gece-kosusu", "a", "A1_.x-y", "x".repeat(64)]) expect(isValidRunName(ok)).toBe(true)
    for (const bad of ["", "../x", "a/b", ".gizli", "-x", "a b", "x".repeat(65), "günlük", "a.json/../b"]) {
      expect(isValidRunName(bad)).toBe(false)
    }
  })
})

describe("readCheckpointFile (fixture-first)", () => {
  test("demo: 3 zarf, skipped 0", async () => {
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

  test("bozuk: 2 zarf + corrupt 2 (parse + şekil)", async () => {
    const root = await tempRoot()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-bozuk.jsonl"), "utf8")
      const file = await writeRun(root, "bozuk", text)
      const read = await readCheckpointFile(file)
      expect(read.envelopes).toHaveLength(2)
      expect(read.skipped.corrupt).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cap: 505 satır → 500 işlenir, atlandı(5)", async () => {
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

  test("cap: 256KB aşımı sayılır (az satır, şiş proof)", async () => {
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

  test("insan çıktısı: doğrulanmış/bayat/gözlenmedi + son/ilk + sonraki", async () => {
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
      expect(text).toContain("doğrulandı: build (2026-10-09T08:00:00.000Z)")
      expect(text).toContain("bayat: build (neden: script_hash)")
      expect(text).toContain("gözlenmedi: deploy")
      expect(text).toContain("son doğrulanmış: build (2026-10-09T08:00:00.000Z)")
      expect(text).toContain("ilk eksik: build (bayat: script_hash)")
      expect(text).toContain("sonraki: betigi sabitleyip kosumu tekrarlayin")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json: zarf + summary + last_verified/first_gap", async () => {
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

  test("bozuk satırlar: exit 0 + uyarı + skipped sayımı", async () => {
    const { root, file } = await fixture()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-bozuk.jsonl"), "utf8")
      await writeRun(root, "bozuk", text)
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "bozuk", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("bozuk-satır: 2 (atlandı)")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "bozuk", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      expect((JSON.parse(io2.out.join("\n")) as { skipped: unknown }).skipped).toEqual({ corrupt: 2, overCap: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("sentinel: proof/action maskeli, hunter2 yok", async () => {
    const { root, file } = await fixture()
    try {
      const text = await readFile(join(FIXTURES, "checkpoints-sentinel.jsonl"), "utf8")
      await writeRun(root, "gizli", text)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "gizli", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "gizli", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const human = io2.out.join("\n") + "\n" + io2.err.join("\n")
      expect(human).not.toContain("hunter2")
      expect(io2.out.join("\n")).toContain("sonraki:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dosya yok exit 1; geçersiz run adı exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["checkpoints", "show", "yok", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("checkpoint yok: yok")
      for (const args of [["checkpoints", "show", "../x"], ["checkpoints", "show", "a/b"], ["checkpoints"], ["checkpoints", "bogus"], ["checkpoints", "show"], ["checkpoints", "list", "fazla"]]) {
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
  test("boş dizin: exit 0 + honest-boş", async () => {
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
      expect(io.out.join("\n")).toContain("checkpoint yok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("koşular: ad + sayım + özet + son at (metin + json)", async () => {
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
      expect(io.out.join("\n")).toContain("demo (3 zarf: 1 doğrulandı, 1 bayat, 1 gözlenmedi; son: 2026-10-09T09:05:00.000Z)")
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

describe("M-A side_effect bayrakları + retry ipucu + deneme ağacı", () => {
  const sideFixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    await writeRun(root, "etki", await readFile(join(FIXTURES, "checkpoints-side-effect.jsonl"), "utf8"))
    await writeRun(root, "soyagaci", await readFile(join(FIXTURES, "checkpoints-lineage.jsonl"), "utf8"))
    await writeRun(root, "bozuk-ma", await readFile(join(FIXTURES, "checkpoints-hostile-ma.jsonl"), "utf8"))
    return { root, file }
  }

  test("bayrak satırları: yok/denendi/onaylandı/bilinmiyor + sayımlar", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "etki", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("yan-etki: build (yok)")
      expect(text).toContain("yan-etki: test (denendi, denenen: 2)")
      expect(text).toContain("yan-etki: deploy (onaylandı, denenen: 1, onaylanan: 1)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("eksik side_effect bilinmiyor render edilir (uyarısız)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "soyagaci", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("yan-etki: build (bilinmiyor)")
      expect(io.err.join("\n")).not.toContain("bilinmiyor")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("denendi-doğrulanmadı retry ipucu (kilitli metin, tektir)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "soyagaci", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const hint = "tekrar-öncesi: ow reconcile --check"
      const hits = io.out.join("\n").split(hint).length - 1
      expect(hits).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("sonra doğrulanan deneme ipucu söndürür (salt-okunur, exec yok)", async () => {
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
      expect(io.out.join("\n")).not.toContain("tekrar-öncesi:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("açık alan ağacı: senaryo → deneme (kilitli sözcükler + doğrulanmadı)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "soyagaci", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = io.out.join("\n")
      expect(text).toContain("senaryo: gece")
      expect(text).toContain("deneme 1: build (doğrulandı)")
      expect(text).toContain("deneme 2: test (doğrulandı, doğrulanmadı)")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ek-sonuç: run-adı soneki + sahipsiz-düz (grupsuz)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await writeRun(root, "gece-attempt2", `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner","code":{"script_hash":"s1","checkout_rev":"r1"},"runtime":{"port":1}}\n`)
      await writeRun(root, "duz", `{"stage":"build","status":"confirmed","proof":"x","at":"2026-10-09T08:00:00.000Z","by":"runner"}\n`)
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "gece-attempt2", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const suffixText = io.out.join("\n")
      expect(suffixText).toContain("senaryo: gece")
      expect(suffixText).toContain("deneme 2: build (doğrulandı)")
      const io2 = capture()
      try {
        expect(await run(["checkpoints", "show", "duz", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n")).not.toContain("senaryo:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile M-A: 13 satırın tamamı bozuk sayılır (fail-closed)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "bozuk-ma", "--file", file, "--json"])).toBe(0)
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

  test("--json yeni alanları taşır (bayrak/sayım/soyağacı)", async () => {
    const { root, file } = await sideFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "etki", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        envelopes: { side_effect?: string; side_effect_counts?: unknown; scenario?: string; attempt?: number; step_signature?: string }[]
      }
      expect(payload.envelopes[0]).toMatchObject({ side_effect: "none", scenario: "gece", attempt: 1, step_signature: "build-imza" })
      expect(payload.envelopes[1]).toMatchObject({ side_effect: "attempted", side_effect_counts: { attempted: 2 }, attempt: 2 })
      expect(payload.envelopes[2]).toMatchObject({ side_effect: "confirmed" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-B kod haritası geçidi (legacy-kararlı + tek-sapma)", () => {
  const codeFixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
    await writeRun(root, "harita", await readFile(join(FIXTURES, "checkpoints-code-map.jsonl"), "utf8"))
    await writeRun(root, "bozuk-mb", await readFile(join(FIXTURES, "checkpoints-hostile-mb.jsonl"), "utf8"))
    return { root, file }
  }

  test("karışık eski/yeni dizi: confirmed, confirmed, tek script_hash-sapma", async () => {
    const { root, file } = await codeFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "harita", "--file", file, "--json"])).toBe(0)
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

  test("hostile M-B: 6 satırın tamamı bozuk sayılır (çakışma + disiplinsiz slot)", async () => {
    const { root, file } = await codeFixture()
    try {
      const io = capture()
      try {
        expect(await run(["checkpoints", "show", "bozuk-mb", "--file", file, "--json"])).toBe(0)
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

describe("konumsal gramer korunur", () => {
  test("diğer komutlarda ikinci konumsal hâlâ exit 2", async () => {
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
      expect(io.err.join("\n")).toContain("beklenmeyen argüman: b")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
