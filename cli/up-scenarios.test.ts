/** Scenario validator: v1 schema (never runs, probes never execute). Read-only:
 * parse+validate + services-reference check. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"
import { normalizeBoundary, parseScenarios, validateReferences } from "./up-scenarios"

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
  test("valid file parses ok (shape + default timeout)", async () => {
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

  test("missing timeout defaults to 10s", () => {
    const parsed = parseScenarios("version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n")
    expect(parsed.scenarios[0].probes).toEqual([{ id: "p", argv: ["./x.sh"], timeout: "10s" }])
  })

  test("single scalar counts as list; unknown field warn-only", () => {
    const parsed = parseScenarios(
      "version: 1\nscenarios:\n  a:\n    services: api\n    probes: [{id: p, argv: [./x.sh], extra: 1}]\n    tuhaf: 1\n",
    )
    expect(parsed.scenarios[0].services).toEqual(["api"])
    expect(parsed.warnings.map((warning) => warning.message)).toContain("a: unknown field ignored: tuhaf")
    expect(parsed.warnings.map((warning) => warning.message)).toContain("a: unknown field ignored inside probe: extra")
  })
})

describe("parseScenarios negative matrix (exit 1 class)", () => {
  const cases: [string, string][] = [
    ["bad scenario name", "version: 1\nscenarios:\n  BAD_NAME!:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["bad probe id", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: BAD!, argv: [./x.sh]}]\n"],
    ["argv over 16 parts", `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [${Array.from({ length: 17 }, (_, i) => `a${i}`).join(", ")}]}]\n`],
    ["argv part over 512B", `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [${"x".repeat(513)}]}]\n`],
    ["shell argv", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [sh, -c, echo hi]}]\n"],
    ["off-list timeout", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh], timeout: 60s}]\n"],
    ["off-list version", "version: 2\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["missing version", "scenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["scenarios not a map", "version: 1\nscenarios: []\n"],
    ["empty scenarios", "version: 1\nscenarios:\n"],
    ["missing services", "version: 1\nscenarios:\n  a:\n    probes: [{id: p, argv: [./x.sh]}]\n"],
    ["missing probes", "version: 1\nscenarios:\n  a:\n    services: [api]\n"],
    ["missing argv", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p}]\n"],
    ["probe not a map", "version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [duz-yazi]\n"],
  ]
  for (const [label, text] of cases) {
    test(label, () => {
      expect(() => parseScenarios(text)).toThrow()
    })
  }

  test("CLI: schema error exit 1", async () => {
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
      expect(io.err.join("\n")).toContain("invalid scenarios file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("services-reference warn (never fails)", () => {
  test("unknown service + unknown boundaries → warn + UNVERIFIED, exit 0", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  a:\n    services: [api, ghost]\n    boundaries: [local, outer-space]\n    probes: [{id: p, argv: [./x.sh]}]\n",
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
      expect(io.err.join("\n")).toContain("a: unknown service: ghost (UNVERIFIED)")
      expect(io.err.join("\n")).toContain("a: unknown boundaries: outer-space (UNVERIFIED)")
      expect(io.out.join("\n")).toContain("UNVERIFIED: a: unknown service: ghost")
      expect(io.out.join("\n")).toContain("UNVERIFIED: a: unknown boundaries: outer-space")
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

  test("unreadable ow.yaml marks all references UNVERIFIED (never fails)", () => {
    const parsed = parseScenarios(TRUCK)
    const refs = validateReferences(parsed, null)
    expect(refs.unverifiedServices).toEqual(["truck-approval:api"])
  })
})

describe("subset block-map: line-numbered error + hint", () => {
  test("--check exit 1 + line + single-line example", async () => {
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
      expect(io.err.join("\n")).toContain("line")
      expect(io.err.join("\n")).toContain("single-line inline")
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
  // M1 C-break carve-out (sole justified exception): the legacy `local`
  // value now dual-reads with a mapping warning to `real-read-only`; the
  // `legacy-boundary` line below is the deliberate golden update in this file
  // (the single byte-identical exception in the program).
  test("valid truck → 0 (+1 legacy warning); missing file → 1; usage → 2", async () => {
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
      expect(io.out.join("\n")).toContain("scenario: truck-approval (1 services, 1 probes)")
      expect(io.err.join("\n")).toContain("legacy-boundary: local → real-read-only (warning)")
      const io2 = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", join(root, "yok.yaml")])
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.err.join("\n")).toContain("scenario file missing")
      expect(await run(["scenarios", "--file", file])).toBe(2)
      expect(await run(["scenarios", "--check", "fazla", "--file", file])).toBe(2)
      expect(await run(["scenarios", "--check", "--file", file, "--probe"])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M1 boundaries taxonomy (C break)", () => {
  const LEGACY_MAP: [string, string][] = [
    ["real", "real-state-changing"],
    ["local", "real-read-only"],
    ["captured-response", "subscribed"],
    ["fake", "unverified"],
    ["test", "unverified"],
  ]

  const writePair = async (root: string, scenarios: string): Promise<string> => {
    const file = join(root, "ow.scenarios.yaml")
    await writeFile(file, scenarios, "utf8")
    await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
    return file
  }

  test("legacy 5-value dual-read: 5 legacy-boundary warns, exit 0, mapped normalize", async () => {
    const root = await tempRoot()
    try {
      const file = await writePair(
        root,
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [real, local, captured-response, fake, test]\n    probes: [{id: p, argv: [./x.sh]}]\n",
      )
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const err = io.err.join("\n")
      for (const [legacy, mapped] of LEGACY_MAP) {
        expect(err).toContain(`legacy-boundary: ${legacy} → ${mapped} (warning)`)
      }
      expect(err.split("legacy-boundary").length - 1).toBe(5)
      expect(io.out.join("\n")).not.toContain("UNVERIFIED")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        scenarios: { boundaries: string[] }[]
        warnings: { message: string }[]
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
        boundaryWarnings: string[]
      }
      // Old key raw (unchanged); new key normalized.
      expect(payload.scenarios[0].boundaries).toEqual(["real", "local", "captured-response", "fake", "test"])
      expect(payload.boundariesNormalized).toEqual([
        { scenario: "a", boundaries: ["real-state-changing", "real-read-only", "subscribed", "unverified", "unverified"] },
      ])
      expect(payload.boundaryWarnings).toHaveLength(5)
      expect(payload.warnings.map((warning) => warning.message).join("\n")).toContain("legacy-boundary")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("repeated legacy value warns once per file", async () => {
    const root = await tempRoot()
    try {
      const file = await writePair(
        root,
        "version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [local]\n    probes: [{id: p, argv: [./x.sh]}]\n  b:\n    services: [api]\n    boundaries: [local, real]\n    probes: [{id: p, argv: [./x.sh]}]\n",
      )
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const err = io.err.join("\n")
      expect(err.split("legacy-boundary: local → real-read-only (warning)").length - 1).toBe(1)
      expect(err.split("legacy-boundary").length - 1).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("new-taxonomy file: exit 0, zero warnings", async () => {
    const root = await tempRoot()
    try {
      const file = await writePair(
        root,
        'version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [real-read-only, real-state-changing, network-deny, subscribed, unverified, blocked:"maintenance work"]\n    probes: [{id: p, argv: [./x.sh]}]\n',
      )
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toBe("")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
        boundaryWarnings: string[]
        warnings: unknown[]
      }
      expect(payload.boundariesNormalized).toEqual([
        {
          scenario: "a",
          boundaries: [
            "real-read-only",
            "real-state-changing",
            "network-deny",
            "subscribed",
            "unverified",
            "blocked:maintenance work",
          ],
        },
      ])
      expect(payload.boundaryWarnings).toEqual([])
      expect(payload.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown/empty value → unverified + UNVERIFIED warning, exit 0 (never silent/failing)", async () => {
    const root = await tempRoot()
    try {
      const file = await writePair(
        root,
        'version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [outer-space, ""]\n    probes: [{id: p, argv: [./x.sh]}]\n',
      )
      const io = capture()
      let code = -1
      try {
        code = await run(["scenarios", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.err.join("\n")).toContain("a: unknown boundaries: outer-space (UNVERIFIED)")
      expect(io.err.join("\n")).toContain("(UNVERIFIED)")
      expect(io.out.join("\n")).toContain("UNVERIFIED: a: unknown boundaries: outer-space")
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        boundariesNormalized: { scenario: string; boundaries: string[] }[]
      }
      expect(payload.boundariesNormalized).toEqual([{ scenario: "a", boundaries: ["unverified", "unverified"] }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reasonless/empty/long blocked → schema error exit 1; quoted reason valid", async () => {
    const root = await tempRoot()
    try {
      for (const boundaries of ["[blocked]", '[blocked:""]', `[blocked:${"x".repeat(129)}]`]) {
        const file = await writePair(
          root,
          `version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: ${boundaries}\n    probes: [{id: p, argv: [./x.sh]}]\n`,
        )
        const io = capture()
        let code = -1
        try {
          code = await run(["scenarios", "--check", "--file", file])
        } finally {
          io.restore()
        }
        expect(code).toBe(1)
        expect(io.err.join("\n")).toContain("invalid scenarios file")
        expect(io.err.join("\n")).toContain("blocked")
      }
      const quoted = await writePair(
        root,
        'version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [blocked:"reason, with comma 1"]\n    probes: [{id: p, argv: [./x.sh]}]\n',
      )
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", quoted])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hostile boundary values never leak through the real validation path (masked)", async () => {
    const root = await tempRoot()
    const hex40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    const bearerBody = "AbCdefGh0123456789._~-plus-xyz123456789"
    try {
      const file = await writePair(
        root,
        `version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [token=hunter2, ${hex40}, carrier Bearer ${bearerBody}, blocked:"token=hunter2"]\n    probes: [{id: p, argv: [./x.sh]}]\n`,
      )
      const io = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      const text = `${io.out.join("\n")}\n${io.err.join("\n")}`
      expect(text).not.toContain("hunter2")
      expect(text).not.toContain(hex40)
      expect(text).not.toContain(bearerBody)
      const io2 = capture()
      try {
        expect(await run(["scenarios", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const json = io2.out.join("\n")
      expect(json).not.toContain("hunter2")
      expect(json).not.toContain(hex40)
      expect(json).not.toContain(bearerBody)
      expect(json).toContain("boundariesNormalized")
      expect(json).toContain("boundaryWarnings")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M7 scenario data + env_file schema (validated-only)", () => {
  test("data block parses with known keys; env_file parses as names-only reference", async () => {
    const { parseScenarios } = await import("./up-scenarios")
    const parsed = parseScenarios(
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    data: {db_identity: maindb, seed_rev: 3}\n    env_file: conf.env\n",
    )
    expect(parsed.scenarios[0].data).toEqual({ db_identity: "maindb", seed_rev: "3" })
    expect(parsed.scenarios[0].env_file).toBe("conf.env")
    expect(parsed.warnings).toEqual([])
  })

  test("unknown data keys warn-only; malformed data/env_file fail closed", async () => {
    const { parseScenarios } = await import("./up-scenarios")
    const warned = parseScenarios(
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    data: {db_identity: maindb, future_key: 1}\n",
    )
    expect(warned.scenarios[0].data).toEqual({ db_identity: "maindb" })
    expect(warned.warnings.map((warning) => warning.message).join("\n")).toContain("unknown data key")
    for (const body of [
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    data: {db_identity: [maindb]}\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    data: {db_identity: x}\n".replace("db_identity: x", `db_identity: ${"y".repeat(65)}`),
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    env_file: /abs/path.env\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    env_file: ../escape.env\n",
      "version: 1\nscenarios:\n  cart:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    env_file: \n",
    ]) {
      expect(() => parseScenarios(body)).toThrow()
    }
  })
})

describe("H1 CLI↔server boundary parity (same fixture, identical verdicts)", () => {
  test("normalizeBoundary and server normalizeScenarioBoundary agree", async () => {
    const server = await import("../src/coordinator")
    const values = [
      "real-read-only",
      "real-state-changing",
      "network-deny",
      "subscribed",
      "unverified",
      "real",
      "local",
      "captured-response",
      "fake",
      "test",
      `blocked:"down for maintenance"`,
      "bogus-value",
      "",
    ]
    for (const raw of values) {
      const cli = normalizeBoundary(raw)
      const srv = server.normalizeScenarioBoundary(raw)
      expect(srv.known).toBe(cli.known)
      if (cli.known) expect(srv.normalized).toBe(cli.normalized)
    }
  })

  test("parseScenarios and server normalizeScenarios agree on normalized lists + legacy warnings", async () => {
    const server = await import("../src/coordinator")
    const text = [
      "version: 1",
      "scenarios:",
      "  mixed:",
      "    services: [api]",
      '    boundaries: [real-read-only, real, local, blocked:"down for maintenance", bogus-value]',
      "    probes: [{id: ready, argv: [./x.sh]}]",
      "    checkpoints: [ok-stage]",
      "",
    ].join("\n")
    const cliParsed = parseScenarios(text)
    expect(cliParsed.scenarios).toHaveLength(1)
    const serverParsed = server.normalizeScenarios(text)
    expect(serverParsed.scenarios).toHaveLength(1)
    expect(serverParsed.scenarios[0].boundaries).toEqual(
      cliParsed.scenarios[0].boundaries.map((boundary) => {
        const norm = normalizeBoundary(boundary)
        return norm.known ? norm.normalized : boundary
      }),
    )
    expect(serverParsed.warnings.some((warning) => warning.includes("legacy-boundary: real → real-state-changing (warning)"))).toBe(true)
    expect(serverParsed.warnings.some((warning) => warning.includes("legacy-boundary: local → real-read-only (warning)"))).toBe(true)
  })
})

describe("M-c parity corpus: blocked-shape, non-goal, shell-argv0, unknown-folding agree", () => {
  test("malformed blocked rejects on both (bare, empty, oversize)", async () => {
    const server = await import("../src/coordinator")
    for (const bad of ["blocked", "blocked:", `blocked:${"x".repeat(129)}`]) {
      const text = `version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [${bad}]\n    probes: [{id: p, argv: [./x.sh]}]\n`
      expect(() => parseScenarios(text)).toThrow(/blocked:<reason> required/)
      expect(() => server.normalizeScenarios(text)).toThrow(/blocked:<reason> required/)
    }
  })

  test("non-goal keys reject on both", async () => {
    const server = await import("../src/coordinator")
    for (const key of ["fault-inject", "soak-test", "load-test", "schedule", "deploy"]) {
      const text = `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n    ${key}: [x]\n`
      expect(() => parseScenarios(text)).toThrow(/non-goal rejected/)
      expect(() => server.normalizeScenarios(text)).toThrow(/non-goal rejected/)
    }
  })

  test("shell argv0 rejects on both", async () => {
    const server = await import("../src/coordinator")
    const text = `version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [sh, -c, echo]}]\n`
    expect(() => parseScenarios(text)).toThrow(/must not start with a shell/)
    expect(() => server.normalizeScenarios(text)).toThrow(/must not start with a shell/)
  })

  test("unknown boundaries fold to unverified verdicts on both", async () => {
    const server = await import("../src/coordinator")
    const text = `version: 1\nscenarios:\n  a:\n    services: [api]\n    boundaries: [mystery-value]\n    probes: [{id: p, argv: [./x.sh]}]\n`
    const cliParsed = parseScenarios(text)
    expect(normalizeBoundary("mystery-value").known).toBe(false)
    const serverParsed = server.normalizeScenarios(text)
    expect(serverParsed.scenarios[0].boundaries).toEqual(["mystery-value"])
    expect(server.normalizeScenarioBoundary("mystery-value").known).toBe(false)
    expect(cliParsed.scenarios[0].boundaries).toEqual(["mystery-value"])
  })
})

describe("M-d vacuity: no-op argv0 warns, INERT header-block scan", () => {
  test("true/:/exit argv0 warns (never fails)", async () => {
    const { parseScenarios: parse } = await import("./up-scenarios")
    for (const argv0 of ["true", ":", "exit"]) {
      const parsed = parse(`version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [${argv0}]}]\n`)
      expect(parsed.warnings.some((w) => w.message.includes("no-op probe argv0 (vacuity): p"))).toBe(true)
    }
    const clean = parse(`version: 1\nscenarios:\n  a:\n    services: [api]\n    probes: [{id: p, argv: [./x.sh]}]\n`)
    expect(clean.warnings.some((w) => w.message.includes("no-op probe argv0"))).toBe(false)
  })

  test("INERT marker below leading comments still refuses (header-block scan)", async () => {
    const { hasInertMarker } = await import("./up-init")
    const { INIT_INERT_MARKER } = await import("./up-init")
    expect(hasInertMarker(`${INIT_INERT_MARKER}\nversion: 1\nscenarios:\n`)).toBe(true)
    expect(hasInertMarker(`# user comment\n# another\n${INIT_INERT_MARKER}\nversion: 1\nscenarios:\n`)).toBe(true)
    expect(hasInertMarker(`version: 1\nscenarios:\n  a:\n    services: [api]\n`)).toBe(false)
  })
})
