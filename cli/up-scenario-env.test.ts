/** M10 `ow scenario env`: boundary matrix as eval-clean env lines. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { ENV_MODES, envKeyOf, modeOfBoundary, runScenarioEnv } from "./up-scenario-env"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-env-"))

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

const BASE = [
  "version: 1",
  "scenarios:",
  "  demo:",
  "    services: [api]",
  "    boundaries: [real-read-only, network-deny]",
  "    probes: [{id: p, argv: [./x.sh]}]",
  "  gated:",
  "    services: [api]",
  '    boundaries: [blocked:"maintenance work"]',
  "    probes: [{id: p, argv: [./x.sh]}]",
  "",
].join("\n")

const writeBase = async (root: string): Promise<string> => {
  const file = join(root, "ow.scenarios.yaml")
  await writeFile(file, BASE, "utf8")
  await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
  return file
}

describe("env key transform (exact)", () => {
  test("uppercases + folds every non-alnum to underscore", () => {
    expect(envKeyOf("real-read-only")).toBe("OW_BOUNDARY_REAL_READ_ONLY")
    expect(envKeyOf("real-state-changing")).toBe("OW_BOUNDARY_REAL_STATE_CHANGING")
    expect(envKeyOf("network-deny")).toBe("OW_BOUNDARY_NETWORK_DENY")
    expect(envKeyOf("subscribed")).toBe("OW_BOUNDARY_SUBSCRIBED")
    expect(envKeyOf("blocked")).toBe("OW_BOUNDARY_BLOCKED")
    expect(envKeyOf("unverified")).toBe("OW_BOUNDARY_UNVERIFIED")
  })

  test("modeOfBoundary collapses blocked reasons, falls unknown to unverified", () => {
    expect(modeOfBoundary('blocked:"fix, later"')).toBe("blocked")
    expect(modeOfBoundary("outer-space")).toBe("unverified")
    expect(modeOfBoundary("local")).toBe("real-read-only")
    expect(modeOfBoundary("subscribed")).toBe("subscribed")
  })
})

describe("scenario env render (fail-before RED: unknown subverb without wiring)", () => {
  test("human lines are plain KEY=value, eval-clean, exit 0", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      let code = -1
      try {
        code = await run(["scenario", "env", "demo", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out).toEqual([
        "OW_BOUNDARY_REAL_READ_ONLY=real-read-only",
        "OW_BOUNDARY_NETWORK_DENY=network-deny",
      ])
      for (const line of io.out) expect(line).toMatch(/^OW_BOUNDARY_[A-Z0-9_]+=[a-z-]+$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("blocked renders mode only — reason stays out of env", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      try {
        expect(await run(["scenario", "env", "gated", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toEqual(["OW_BOUNDARY_BLOCKED=blocked"])
      expect(io.out.join("\n") + io.err.join("\n")).not.toContain("maintenance")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json prints the same mapping as an object, modes only", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      try {
        expect(await run(["scenario", "env", "gated", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as Record<string, unknown>
      expect(payload["scenario"]).toBe("gated")
      expect(payload["env"]).toEqual({ OW_BOUNDARY_BLOCKED: "blocked" })
      for (const value of Object.values(payload["env"] as Record<string, unknown>)) {
        expect(ENV_MODES.has(value as string)).toBe(true)
      }
      expect(JSON.stringify(payload)).not.toContain("maintenance")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("scenario env refusals (scenario-run gates mirrored)", () => {
  test("unknown scenario → exit 2; missing file → exit 1; INERT → exit 2", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      try {
        expect(await run(["scenario", "env", "ghost", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("scenario not found: ghost")
      const io2 = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", join(root, "missing.yaml")])).toBe(1)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).toContain("scenario file missing")
      const { INIT_INERT_MARKER } = await import("./up-init")
      await writeFile(file, `${INIT_INERT_MARKER}\n${BASE}`, "utf8")
      const io3 = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file])).toBe(2)
      } finally {
        io3.restore()
      }
      expect(io3.err.join("\n")).toContain(`INERT: ${file}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("usage: bare env, extra positional, and --run/--off-local are exit 2", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      for (const argv of [
        ["scenario", "env", "--file", file],
        ["scenario", "env", "demo", "extra", "--file", file],
        ["scenario", "env", "demo", "--file", file, "--run", "x"],
        ["scenario", "env", "demo", "--file", file, "--off-local"],
      ]) {
        const io = capture()
        try {
          expect(await run(argv)).toBe(2)
        } finally {
          io.restore()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("collision: two boundaries, one key → exit 1 naming both sources", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        'version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [local, real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n  twice:\n    services: [api]\n    boundaries: [blocked:"a", blocked:"b"]\n    probes: [{id: p, argv: [./x.sh]}]\n',
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const io = capture()
      try {
        expect(await runScenarioEnv({ file, rootDir: root, name: "demo", json: false })).toBe(1)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("duplicate env key: OW_BOUNDARY_REAL_READ_ONLY")
      const io2 = capture()
      try {
        expect(await runScenarioEnv({ file, rootDir: root, name: "twice", json: false })).toBe(1)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).toContain("duplicate env key: OW_BOUNDARY_BLOCKED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("scenario env overlay reflection (merged matrix, no reimplementation)", () => {
  test("flag > local > base reflected in env + json source passthrough", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(root, ".ow"), { recursive: true })
      await writeFile(join(root, ".ow", "boundaries.local.yaml"), "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n", "utf8")
      const flagFile = join(root, "flag-ov.yaml")
      await writeFile(flagFile, "version: 1\nscenarios:\n  demo:\n    boundaries: [subscribed]\n", "utf8")
      // Local convention reflected.
      const io = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toEqual(["OW_BOUNDARY_NETWORK_DENY=network-deny"])
      // Flag wins over local.
      const io2 = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file, "--boundaries", "flag-ov.yaml", "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        scenario: string
        env: Record<string, string>
        overlayApplied: boolean
        overlayFile: string
        boundarySources: { scenario: string; boundary: string; source: string }[]
      }
      expect(payload.scenario).toBe("demo")
      expect(payload.env).toEqual({ OW_BOUNDARY_SUBSCRIBED: "subscribed" })
      expect(payload.overlayApplied).toBe(true)
      expect(payload.overlayFile).toBe("flag-ov.yaml")
      expect(payload.boundarySources).toEqual([{ scenario: "demo", boundary: "subscribed", source: "flag" }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("absent overlay: json has no overlay keys (byte-identical shape)", async () => {
    const root = await tempRoot()
    try {
      const file = await writeBase(root)
      const io = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(["env", "scenario"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("overlay banner stays on stderr — stdout stays clean in both modes", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  demo:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n",
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(root, ".ow"), { recursive: true })
      await writeFile(join(root, ".ow", "boundaries.local.yaml"), "version: 1\nscenarios:\n  demo:\n    boundaries: [network-deny]\n", "utf8")
      const io = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toEqual(["OW_BOUNDARY_NETWORK_DENY=network-deny"])
      expect(io.err.join("\n")).toContain("overlay-active: boundaries.local.yaml")
      const io2 = capture()
      try {
        expect(await run(["scenario", "env", "demo", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const parsed = JSON.parse(io2.out.join("\n")) as { env: Record<string, string> }
      expect(parsed.env).toEqual({ OW_BOUNDARY_NETWORK_DENY: "network-deny" })
      expect(io2.err.join("\n")).toContain("overlay-active: boundaries.local.yaml")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("scenario env no-secret proof (modes only, hostile values never raw)", () => {
  test("hostile boundary values never emitted raw in either mode", async () => {
    const root = await tempRoot()
    const hex40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    const bearerBody = "AbCdefGh0123456789._~-plus-xyz123456789"
    try {
      // One hostile value per scenario: each normalizes to a distinct
      // closed mode (unknowns share `unverified`, so they render apart).
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        `version: 1\nscenarios:\n  h1:\n    services: [api]\n    boundaries: [token=hunter2]\n    probes: [{id: p, argv: [./x.sh]}]\n  h2:\n    services: [api]\n    boundaries: [${hex40}]\n    probes: [{id: p, argv: [./x.sh]}]\n  h3:\n    services: [api]\n    boundaries: [carrier Bearer ${bearerBody}]\n    probes: [{id: p, argv: [./x.sh]}]\n  h4:\n    services: [api]\n    boundaries: [blocked:"token=hunter2"]\n    probes: [{id: p, argv: [./x.sh]}]\n`,
        "utf8",
      )
      await writeFile(join(root, "ow.yaml"), OW_YAML, "utf8")
      for (const name of ["h1", "h2", "h3", "h4"]) {
        const io = capture()
        try {
          expect(await run(["scenario", "env", name, "--file", file])).toBe(0)
        } finally {
          io.restore()
        }
        const human = `${io.out.join("\n")}\n${io.err.join("\n")}`
        expect(human).not.toContain("hunter2")
        expect(human).not.toContain(hex40)
        expect(human).not.toContain(bearerBody)
        for (const line of io.out) expect(line).toMatch(/^OW_BOUNDARY_[A-Z0-9_]+=[a-z-]+$/)
        const io2 = capture()
        try {
          expect(await run(["scenario", "env", name, "--file", file, "--json"])).toBe(0)
        } finally {
          io2.restore()
        }
        const text = `${io2.out.join("\n")}\n${io2.err.join("\n")}`
        expect(text).not.toContain("hunter2")
        expect(text).not.toContain(hex40)
        expect(text).not.toContain(bearerBody)
        const payload = JSON.parse(io2.out.join("\n")) as { env: Record<string, string> }
        for (const value of Object.values(payload.env)) expect(ENV_MODES.has(value)).toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
