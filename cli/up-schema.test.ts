import { describe, expect, test } from "bun:test"

import { formatUpWarnings, parseUpFile, UpSchemaError } from "./up-schema"

describe("up-schema", () => {
  test("parses all aliases, flow-list ports, host:container and logs-only services", () => {
    const text = [
      "version: 1",
      "services:",
      '  web: { cmd: "pnpm dev", cwd: web/, port: 3000 }',
      "  api:",
      "    command: uv run server.py",
      "    working_dir: api/",
      '    ports: [8000, "8001:8001"]',
      "  db:",
      "    logs: docker logs -f mydb",
      "",
    ].join("\n")
    const file = parseUpFile(text)
    expect(file.services.length).toBe(3)
    expect(file.services[0]).toMatchObject({ name: "web", cmd: "pnpm dev", cwd: "web/", port: 3000 })
    expect(file.services[1]).toMatchObject({ name: "api", cmd: "uv run server.py", cwd: "api/", port: 8000 })
    expect(file.services[2]).toMatchObject({ name: "db", logs: "docker logs -f mydb" })
    expect(file.services[2].cmd).toBeUndefined()
    expect(file.warnings.some((w) => w.message.includes("birden fazla port"))).toBe(true)
  })

  test("flat nested maps parse without braces", () => {
    const file = parseUpFile("services:\n  web:\n    cmd: pnpm dev\n    port: 3000\n")
    expect(file.services).toMatchObject([{ name: "web", cmd: "pnpm dev", port: 3000 }])
    expect(file.warnings).toEqual([])
  })

  test("block sequences error naming the line", () => {
    const text = "services:\n  web:\n    cmd: pnpm dev\n    ports:\n      - 3000:3000\n"
    let error: unknown = null
    try {
      parseUpFile(text)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(UpSchemaError)
    expect(String((error as Error).message)).toContain("satır 5")
  })

  test("unknown fields warn, never fail", () => {
    const file = parseUpFile("services:\n  web:\n    cmd: pnpm dev\n    replicas: 3\nmystery: 1\n")
    expect(file.services.length).toBe(1)
    expect(file.warnings.map((w) => w.message)).toContain("web: bilinmeyen alan yoksayıldı: replicas")
    expect(file.warnings.map((w) => w.message)).toContain("bilinmeyen üst alan yoksayıldı: mystery")
  })

  test("conflicting aliases and missing cmd+logs error", () => {
    expect(() => parseUpFile("services:\n  a:\n    cmd: x\n    command: y\n")).toThrow(UpSchemaError)
    expect(() => parseUpFile("services:\n  a:\n    cmd: x\n    cwd: one\n    working_dir: two\n")).toThrow(UpSchemaError)
    expect(() => parseUpFile("services:\n  a:\n    port: 3000\n")).toThrow(/cmd ya da logs/)
    expect(() => parseUpFile("services:\n  a:\n    cmd: x\n    port: 99999\n")).toThrow(/geçersiz port/)
    expect(() => parseUpFile("services: []\n")).toThrow(/haritası gerekli/)
    expect(() => parseUpFile("version: 1\n")).toThrow(/haritası gerekli/)
  })

  test("formatUpWarnings renders line-tagged lines", () => {
    expect(formatUpWarnings([{ line: 5, message: "m" }, { line: 0, message: "n" }])).toEqual([
      "uyarı (satır 5): m",
      "uyarı: n",
    ])
  })

  test("version: is ignored with a warning", () => {
    const file = parseUpFile("version: 1\nservices:\n  a:\n    cmd: x\n")
    expect(file.services.length).toBe(1)
    expect(file.warnings.map((w) => w.message)).toContain("version yoksayıldı (v1)")
  })

  test("service names are bounded to [A-Za-z0-9_-]{1,64}", () => {
    expect(() => parseUpFile("services:\n  '../kac':\n    cmd: x\n")).toThrow(/geçersiz servis adı/)
    expect(() => parseUpFile("services:\n  'a b':\n    cmd: x\n")).toThrow(/geçersiz servis adı/)
    expect(() => parseUpFile(`services:\n  ${"a".repeat(65)}:\n    cmd: x\n`)).toThrow(/geçersiz servis adı/)
    expect(() => parseUpFile("services:\n  'a.b':\n    cmd: x\n")).toThrow(/geçersiz servis adı/)
    const ok = parseUpFile(`services:\n  ${"a".repeat(64)}:\n    cmd: x\n`)
    expect(ok.services[0].name).toBe("a".repeat(64))
    const dashes = parseUpFile("services:\n  a-B_c9:\n    cmd: x\n")
    expect(dashes.services[0].name).toBe("a-B_c9")
  })

  test("at most 32 services", () => {
    const many = ["services:"]
    for (let i = 0; i < 33; i += 1) many.push(`  s${i}:\n    cmd: x`)
    expect(() => parseUpFile(many.join("\n"))).toThrow(/en fazla 32 servis/)
    const edge = ["services:"]
    for (let i = 0; i < 32; i += 1) edge.push(`  s${i}:\n    cmd: x`)
    expect(parseUpFile(edge.join("\n")).services.length).toBe(32)
  })

  test("cmd is bounded to 8KB text / 32 argv items", () => {
    expect(() => parseUpFile(`services:\n  a:\n    cmd: ${"x".repeat(9000)}\n`)).toThrow(/8KB/)
    const argv = Array.from({ length: 33 }, (_, i) => `p${i}`).join(", ")
    expect(() => parseUpFile(`services:\n  a:\n    cmd: [${argv}]\n`)).toThrow(/en fazla 32 par/)
    const okArgv = Array.from({ length: 32 }, (_, i) => `p${i}`).join(", ")
    const ok = parseUpFile(`services:\n  a:\n    cmd: [${okArgv}]\n`)
    expect((ok.services[0].cmd as string[]).length).toBe(32)
  })
})

describe("up-schema per-service env", () => {
  const withEnv = (flow: string): string => `services:\n  a:\n    cmd: x\n    env: ${flow}\n`

  test("inline flow map parses to a scalar string map", () => {
    const file = parseUpFile(withEnv(`{A: b, "C_1": "d,e: f", URL: http://x:9}`))
    expect(file.services[0].env).toEqual({ A: "b", C_1: "d,e: f", URL: "http://x:9" })
    expect(file.warnings).toEqual([])
  })

  test("env is optional and empty map is allowed", () => {
    expect(parseUpFile("services:\n  a:\n    cmd: x\n").services[0].env).toBeUndefined()
    expect(parseUpFile(withEnv("{}")).services[0].env).toEqual({})
  })

  test("env is not enumerable, so serialized service listings omit values", () => {
    const service = parseUpFile(withEnv("{TOKEN: s3cr3t}")).services[0]
    expect(JSON.stringify(service)).not.toContain("s3cr3t")
    expect(JSON.stringify(service)).not.toContain("TOKEN")
    expect(service.env?.TOKEN).toBe("s3cr3t")
  })

  test("non-map env values throw naming the service", () => {
    expect(() => parseUpFile("services:\n  web:\n    cmd: x\n    env: A=b\n")).toThrow(/web: env/)
    expect(() => parseUpFile("services:\n  web:\n    cmd: x\n    env: [A, B]\n")).toThrow(UpSchemaError)
    expect(() => parseUpFile(withEnv("{A: [x]}"))).toThrow(/env değerleri metin|anahtar: değer/)
    expect(() => parseUpFile(withEnv("{A: {B: c}}"))).toThrow(/env değerleri metin/)
  })

  test("block-form env is rejected by the subset parser", () => {
    expect(() => parseUpFile("services:\n  a:\n    cmd: x\n    env:\n      A: b\n")).toThrow(/3\. düzey/)
    expect(() => parseUpFile("services:\n  a:\n    cmd: x\n    env:\n")).toThrow(UpSchemaError)
  })

  test("invalid key names, duplicate keys and oversize pairs throw without echoing values", () => {
    expect(() => parseUpFile(withEnv("{1BAD: v}"))).toThrow(/geçersiz anahtar/)
    expect(() => parseUpFile(withEnv("{A-B: v}"))).toThrow(/geçersiz anahtar/)
    expect(() => parseUpFile(withEnv("{A: v, A: w}"))).toThrow(/tekrarlanan anahtar/)
    expect(() => parseUpFile(withEnv("{notakey secretvalue}"))).toThrow(UpSchemaError)
    try {
      parseUpFile(withEnv("{notakey secretvalue}"))
    } catch (error) {
      expect(String(error)).not.toContain("secretvalue")
    }
    const big = "x".repeat(4096)
    expect(() => parseUpFile(withEnv(`{A: ${big}}`))).toThrow(/4096 bayt/)
    expect(parseUpFile(withEnv(`{A: ${"x".repeat(4094)}}`)).services[0].env?.A.length).toBe(4094)
  })

  test("at most 64 env entries", () => {
    const ok = Array.from({ length: 64 }, (_, i) => `K${i}: v`).join(", ")
    expect(Object.keys(parseUpFile(withEnv(`{${ok}}`)).services[0].env ?? {}).length).toBe(64)
    const many = Array.from({ length: 65 }, (_, i) => `K${i}: v`).join(", ")
    expect(() => parseUpFile(withEnv(`{${many}}`))).toThrow(/en fazla 64/)
  })

  test("unknown sibling fields still warn-and-ignore", () => {
    const file = parseUpFile("services:\n  a:\n    cmd: x\n    replicas: 3\n    env: {A: b}\n")
    expect(file.warnings.map((w) => w.message)).toEqual(["a: bilinmeyen alan yoksayıldı: replicas"])
  })
})
