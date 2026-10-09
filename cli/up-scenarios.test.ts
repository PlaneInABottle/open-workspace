/** Senaryo validatoru: v1 şema (çalıştırma YOK, probe KOŞMAZ). Salt-okunur:
 * parse+validate + services-referans kontrolü. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"
import { parseScenarios, validateReferences } from "./up-scenarios"

const FIXTURES = resolve(import.meta.dir, "parity-fixtures")

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-sc-"))

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

const OW_YAML = "services:\n  api:\n    cmd: echo hi\n    port: 8901\n"

const TRUCK = [
  "version: 1",
  "scenarios:",
  "  truck-approval:",
  "    services: [api]",
  "    boundaries: [local]",
  "    targets: [http://127.0.0.1:8901/approval]",
  "    probes: [{id: ready, argv: [./scripts/ready-approval.sh, --local], timeout: 10s}]",
  "    checkpoints: [approval-ready]",
  "",
].join("\n")

describe("parseScenarios (truck-approval fixture)", () => {
  test("geçerli dosya parse-ok (şekil + default timeout)", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(join(FIXTURES, "scenarios-truck.yaml"), "utf8")
    const parsed = parseScenarios(text)
    expect(parsed.warnings).toEqual([])
    expect(parsed.scenarios).toHaveLength(1)
    expect(parsed.scenarios[0]).toMatchObject({
      name: "truck-approval",
      services: ["api"],
      boundaries: ["local"],
      targets: ["http://127.0.0.1:8901/approval"],
      checkpoints: ["approval-ready"],
    })
    expect(parsed.scenarios[0].probes).toEqual([
      { id: "ready", argv: ["./scripts/ready-approval.sh", "--local"], timeout: "10s" },
    ])
  })

  test("timeout yoksa 10s defaultlanır", () => {
    const parsed = parseScenarios("version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n")
    expect(parsed.scenarios[0].probes).toEqual([{ id: "p", argv: ["./x.sh"], timeout: "10s" }])
  })

  test("tek skaler liste sayılır; bilinmeyen alan warn-only", () => {
    const parsed = parseScenarios(
      "version: 1\nscenarios:\n  a:\n    services: api\n    probes: [{id: p, argv: [./x.sh], extra: 1}]\n    tuhaf: 1\n",
    )
    expect(parsed.scenarios[0].services).toEqual(["api"])
    expect(parsed.warnings.map((warning) => warning.message)).toContain("a: bilinmeyen alan yoksayıldı: tuhaf")
    expect(parsed.warnings.map((warning) => warning.message)).toContain("a: probe içinde bilinmeyen alan yoksayıldı: extra")
  })
})

describe("parseScenarios negatif matrisi (exit 1 sınıfı)", () => {
  const cases: [string, string][] = [
    ["kötü senaryo adı", "version: 1\nscenarios:\n  KÖTÜ_AD!:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["kötü probe id", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: KÖTÜ!, argv: [./x.sh]}]\n"],
    ["argv >16 parça", `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [${Array.from({ length: 17 }, (_, i) => `a${i}`).join(", ")}]}]\n`],
    ["argv parçası >512B", `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [${"x".repeat(513)}]}]\n`],
    ["shell argv", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [sh, -c, echo hi]}]\n"],
    ["timeout dışı", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh], timeout: 60s}]\n"],
    ["version dışı", "version: 2\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["version yok", "scenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["scenarios harita değil", "version: 1\nscenarios: []\n"],
    ["boş scenarios", "version: 1\nscenarios:\n"],
    ["services yok", "version: 1\nscenarios:\n  a:\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["probes yok", "version: 1\nscenarios:\n  a:\n    services: [api]\n"],
    ["argv yok", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p}]\n"],
    ["probe harita değil", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [duz-yazi]\n"],
  ]
  for (const [label, text] of cases) {
    test(label, () => {
      expect(() => parseScenarios(text)).toThrow()
    })
  }

  test("CLI: şema hatası exit 1", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [sh, -c, echo hi]}]\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("geçersiz senaryo dosyası")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("services-referans warn (fail değil)", () => {
  test("bilinmeyen servis + bilinmeyen boundaries → warn + UNVERIFIED, exit 0", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  a:\n    services: [api, hayalet]\n    boundaries: [local, uzay]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("a: bilinmeyen servis: hayalet (UNVERIFIED)")
      expect(io.err.join("\n")).toContain("a: bilinmeyen boundaries: uzay (UNVERIFIED)")
      expect(io.out.join("\n")).toContain("UNVERIFIED: a: bilinmeyen servis: hayalet")
      expect(io.out.join("\n")).toContain("UNVERIFIED: a: bilinmeyen boundaries: uzay")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { scenarios: unknown[]; warnings: { message: string }[] }
      expect(payload.scenarios).toHaveLength(1)
      expect(payload.warnings.map((warning) => warning.message).join("\n")).toContain("UNVERIFIED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ow.yaml okunamazsa tüm referanslar UNVERIFIED (fail değil)", () => {
    const parsed = parseScenarios(TRUCK)
    const refs = validateReferences(parsed, null)
    expect(refs.unverifiedServices).toEqual(["truck-approval:api"])
  })
})

describe("subset blok-map: satırlı hata + hint", () => {
  test("--check exit 1 + satır + tek-satır örnek", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes:\n      - id: p\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.err.join("\n")).toContain("satır")
      expect(io.err.join("\n")).toContain("tek-satır inline")
      expect(io.err.join("\n")).toContain("ow init")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("sentinel (secret-asla)", () => {
  test("argv/targets/checkpoints maskeli, hunter2 yok", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    targets: [http://h/token=hunter2]\n    probes: [{id: p, argv: [./x.sh, --token, hunter2]}]\n    checkpoints: [token=hunter2]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      expect(io.err.join("\n")).not.toContain("hunter2")
      const payload = JSON.parse(io.out.join("\n")) as {
        scenarios: { probes: { argvShape: string }[]; targets: string[]; checkpoints: string[] }[]
      }
      expect(payload.scenarios[0].probes[0].argvShape).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("exit matrisi", () => {
  test("geçerli truck → 0; dosya yok → 1; kullanım → 2", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, TRUCK, "utf8")
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("senaryo: truck-approval (1 servis, 1 probe)")
      const io2 = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", join(root, "yok.yaml")])
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.err.join("\n")).toContain("senaryo dosyası yok")
      expect(await run(["scenarios", "--file", file])).toBe(2)
      expect(await run(["scenarios", "--check", "fazla", "--file", file])).toBe(2)
      expect(await run(["scenarios", "--check", "--file", file, "--probe"])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
