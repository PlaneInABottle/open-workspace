/** M5 replay store + `ow record`: envelope/provenance/caps/scrubber,
 * never-replay-state-changing, silent-replay-impossible. Deterministic
 * probe outcomes use an injected fake (the existing `ProbeFn` precedent);
 * live-exec and hostile paths run the real `runProbeJob` against owned
 * fixture scripts. Test names English (file convention), comments English. */

import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import {
  REPLAY_MAX_BYTES,
  REPLAY_MAX_LINES,
  readReplayFile,
  validateProvenance,
  writeReplayFile,
} from "./up-replay"
import type { ProbeOutcome } from "./up-probe"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m5r-"))

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

const withEnv = async <T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

const SCENARIOS = (boundaries: string): string =>
  `version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [${boundaries}]\n    probes: [{id: ready, argv: [./ready.sh], timeout: 10s}]\n    checkpoints: [approval]\n`

const fakeOutcome = (note = "fake-ready"): ProbeOutcome => ({
  ok: true,
  note,
  timedOut: false,
  code: 0,
  checks: [{ name: "build", ok: true, path: "/tmp/x/app.jar", digest: "aaabbbccdd" }],
})

const listAll = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else out.push(full.slice(root.length + 1))
    }
  }
  return out.sort()
}

describe("ow record round-trip (injected probes)", () => {
  test("record writes envelope + outcomes; rerecord bumps attempt", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS("real-read-only"), "utf8")
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("record: cart")
      const files = (await listAll(root)).filter((name) => name.includes(".ow/replay"))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^\.ow\/replay\/real-read-only\/[0-9a-f]{64}\.jsonl$/)
      const first = await readReplayFile(join(root, files[0]))
      expect(first !== null && validateProvenance(first.envelope.provenance)).toBe(true)
      expect(first !== null && first.envelope.replayedFrom).toBeNull()
      expect(first !== null && first.envelope.scenario).toBe("cart")
      expect(first !== null && first.envelope.attempt).toBe(1)
      expect(first !== null && first.envelope.contract.hash).toMatch(/^[0-9a-f]{64}$/)
      // Stored outcomes keep digests, drop raw paths/argv.
      expect(first !== null && first.lines[0].digest).toMatch(/^[0-9a-f]{64}$/)
      expect(first !== null && first.lines[0].argvShape).not.toContain("/tmp/x")
      const io2 = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(0)
      } finally {
        io2.restore()
      }
      const second = await readReplayFile(join(root, files[0]))
      expect(second !== null && second.envelope.attempt).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("live exec records real outcomes (echo probe, no JSON -> honest not-ready)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(
        file,
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [subscribed]\n    probes: [{id: echoer, argv: [echo, hello], timeout: 5s}]\n",
        "utf8",
      )
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart" })).toBe(0)
      } finally {
        io.restore()
      }
      const files = (await listAll(root)).filter((name) => name.includes(".ow/replay"))
      expect(files).toHaveLength(1)
      expect(files[0].startsWith(".ow/replay/subscribed/")).toBe(true)
      const stored = await readReplayFile(join(root, files[0]))
      expect(stored !== null && stored.lines[0].ok).toBe(false)
      expect(stored !== null && stored.lines[0].digest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow record refusals (fail-closed)", () => {
  test("state-changing + blocked refuse exit 2 naming boundary", async () => {
    const root = await tempRoot()
    try {
      const { runRecord } = await import("./up-replay")
      for (const boundaries of ["real-state-changing", "real-read-only, real-state-changing", 'blocked:"maintenance"']) {
        const file = join(root, "ow.scenarios.yaml")
        await writeFile(file, SCENARIOS(boundaries), "utf8")
        const io = capture()
        let code = -1
        try {
          code = await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })
        } finally {
          io.restore()
        }
        expect(code).toBe(2)
        expect(io.err.join("\n")).toContain("no replay: cart")
      }
      expect(await listAll(root)).toEqual(["ow.scenarios.yaml"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown scenario / unverified-only / missing file / corrupt file", async () => {
    const root = await tempRoot()
    try {
      const { runRecord } = await import("./up-replay")
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS("real-read-only"), "utf8")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "missing-scenario", probeFn: async () => fakeOutcome() })).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("scenario not found")
      await writeFile(file, SCENARIOS("unverified"), "utf8")
      const io2 = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(2)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).toContain("no deterministic boundary")
      const io3 = capture()
      try {
        expect(await runRecord({ rootDir: root, file: join(root, "missing.yaml"), runName: "cart" })).toBe(1)
      } finally {
        io3.restore()
      }
      expect(io3.err.join("\n")).toContain("scenario file missing")
      await writeFile(file, "version: 1\nscenarios:\n  - block list forbidden\n", "utf8")
      const io4 = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart" })).toBe(1)
      } finally {
        io4.restore()
      }
      expect(io4.err.join("\n")).toContain("invalid scenarios file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dispatch usage: bare/extra/no-json + no replay verb exists", async () => {
    expect(await run(["record"])).toBe(2)
    expect(await run(["record", "a", "b"])).toBe(2)
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS("real-read-only"), "utf8")
      expect(await run(["record", "cart", "--file", file, "--json"])).toBe(2)
      // Silent replay is structurally impossible: no replay verb exists.
      expect(await run(["replay"])).toBe(2)
      expect(await run(["replay", "anything"])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("replay store: perms/caps/atomicity", () => {
  test("store files are 0600; writer trims oldest-first to caps", async () => {
    const root = await tempRoot()
    try {
      const dir = join(root, ".ow", "replay", "real-read-only")
      await mkdir(dir, { recursive: true })
      const target = join(dir, "aa.jsonl")
      const envelope = { v: 1, at: "t", scenario: "s", attempt: 1, boundary: "real-read-only", boundaries: ["real-read-only"], provenance: { checkout: "c", head: "h", interpreter: "i", runnerHash: "r" }, replayedFrom: null, contract: { hash: "h" } }
      const many = Array.from({ length: REPLAY_MAX_LINES + 1 }, (_, i) => ({ id: `p${i}` }))
      await writeReplayFile(target, envelope as never, many as never)
      const info = await stat(target)
      expect(info.mode & 0o777).toBe(0o600)
      const text = await readFile(target, "utf8")
      const lines = text.split("\n").filter((line) => line.length > 0)
      expect(lines.length).toBeLessThanOrEqual(REPLAY_MAX_LINES)
      expect(JSON.parse(lines[0]).scenario).toBe("s")
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPLAY_MAX_BYTES)
      const big = { id: "x", note: "y".repeat(REPLAY_MAX_BYTES + 1024) }
      await writeReplayFile(target, envelope as never, [big] as never)
      const text2 = await readFile(target, "utf8")
      expect(Buffer.byteLength(text2, "utf8")).toBeLessThanOrEqual(REPLAY_MAX_BYTES)
      expect(JSON.parse(text2.split("\n")[0]).scenario).toBe("s")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("record writes nothing outside .ow/replay (no checkpoints/state)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS("real-read-only"), "utf8")
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(0)
      } finally {
        io.restore()
      }
      expect(await listAll(root)).toEqual([".ow/replay/real-read-only/" + (await listAll(root))[0].split("/").pop(), "ow.scenarios.yaml"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("replay hostile corpus (real exec path)", () => {
  test("password/Bearer/abs-path/argv secrets never land in store or output", async () => {
    const root = await tempRoot()
    try {
      const hex40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
      const bearerBody = "AbCdefGh0123456789._~-plus-xyz123456789"
      const script = join(root, "probe.sh")
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s' '{"ready": true, "note": "token=hunter2 build ${hex40} carrier Bearer ${bearerBody}", "checks": [{"name": "a", "ok": true, "path": "${root}/hidden/app.jar", "digest": "ffffffff"}]}'\n`,
        "utf8",
      )
      await chmod(script, 0o755)
      const file2 = join(root, "ow2.scenarios.yaml")
      await writeFile(
        file2,
        "version: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./probe.sh, --token, hunter2], timeout: 10s}]\n",
        "utf8",
      )
      const { runRecord } = await import("./up-replay")
      const io = capture()
      try {
        expect(await runRecord({ rootDir: root, file: file2, runName: "cart" })).toBe(0)
      } finally {
        io.restore()
      }
      const storeFiles = (await listAll(root)).filter((name) => name.includes(".ow/replay"))
      expect(storeFiles).toHaveLength(1)
      const stored = await readFile(join(root, storeFiles[0]), "utf8")
      for (const secret of ["hunter2", bearerBody, hex40, root, `${root}/hidden/app.jar`]) {
        expect(stored).not.toContain(secret)
      }
      const text = `${io.out.join("\n")}\n${io.err.join("\n")}`
      expect(text).not.toContain("hunter2")
      expect(text).not.toContain(bearerBody)
      expect(text).not.toContain(hex40)
      expect(text).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("X-Ow-Replay in env never becomes linkage (header absent on probes by design)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      await writeFile(file, SCENARIOS("real-read-only"), "utf8")
      const { runRecord } = await import("./up-replay")
      await withEnv("X-Ow-Replay", "1", async () => {
        const io = capture()
        try {
          expect(await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => fakeOutcome() })).toBe(0)
        } finally {
          io.restore()
        }
      })
      const files = (await listAll(root)).filter((name) => name.includes(".ow/replay"))
      const stored = await readReplayFile(join(root, files[0]))
      // Linkage-absent record reads as live: the SOLE replay mechanism.
      expect(stored !== null && stored.envelope.replayedFrom).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("MEDIUM-5 over-cap replay files refuse (never silent truncate)", () => {
  test("over-line-cap file reads as null", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "big.jsonl")
      const envelope = JSON.stringify({ v: 1 })
      const lines = [envelope]
      for (let i = 0; i < REPLAY_MAX_LINES; i += 1) lines.push(JSON.stringify({ id: `p${i}` }))
      await writeFile(file, `${lines.join("\n")}\n`, "utf8")
      expect(await readReplayFile(file)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("over-byte-cap file reads as null", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "big.jsonl")
      const envelope = JSON.stringify({ v: 1 })
      const pad = "x".repeat(1024)
      const lines = [envelope]
      while (Buffer.byteLength(lines.join("\n"), "utf8") <= REPLAY_MAX_BYTES) lines.push(JSON.stringify({ id: "p", note: pad }))
      await writeFile(file, `${lines.join("\n")}\n`, "utf8")
      expect(await readReplayFile(file)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("INERT scaffold refuses record (runner parity)", () => {
  test("record on INERT exits 2 without running probes", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.scenarios.yaml")
      const { INIT_INERT_MARKER } = await import("./up-init")
      await writeFile(file, `${INIT_INERT_MARKER}\nversion: 1\nscenarios:\n  cart:\n    services: [api]\n    boundaries: [real-read-only]\n    probes: [{id: inert, argv: [true]}]\n    checkpoints: [ok]\n`, "utf8")
      const { runRecord } = await import("./up-replay")
      let ran = false
      const io = capture()
      let code = -1
      try {
        code = await runRecord({ rootDir: root, file, runName: "cart", probeFn: async () => {
          ran = true
          return { ok: true, note: "x", timedOut: false as const, code: 0 }
        } })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain(`INERT: ${file}`)
      expect(ran).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-b self-verifying replay reader (hand-forged fixtures refuse)", () => {
  test("tampered line digest reads as null", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "forged.jsonl")
      const envelope = JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", scenario: "cart", attempt: 1, boundary: "real-read-only", boundaries: ["real-read-only"], provenance: { checkout: "x", head: "y", interpreter: "z", runnerHash: "w" }, replayedFrom: null, contract: { hash: "h" } })
      const line = JSON.stringify({ id: "p", argvShape: "./x.sh", timeout: "10s", ok: true, note: "n", checks: [], digest: "wrong-digest-value" })
      await writeFile(file, `${envelope}\n${line}\n`, "utf8")
      expect(await readReplayFile(file)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("symlink and FIFO paths refuse (no hang, no follow)", async () => {
    const root = await tempRoot()
    try {
      const real = join(root, "real.jsonl")
      await writeFile(real, `${JSON.stringify({ v: 1 })}\n`, "utf8")
      const { symlink } = await import("node:fs/promises")
      const link = join(root, "link.jsonl")
      await symlink(real, link)
      expect(await readReplayFile(link)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
