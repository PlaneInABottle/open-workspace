/** M1 provision `--check`: shape-only witness (never actor). Hostile shape
 * fixtures (secret-valued `.env` target, dangling symlink, detached/missing
 * HEAD), exit-code contract (0/1/2 mirrors preflight), single-root golden
 * outputs (NO-WORKTREE-NO-FRICTION), and no-gating proof (up/preflight
 * untouched by broken provision state). */

import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { readHeadIdentity, runProvisionCheck } from "./up-provision"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-provision-"))

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

/** Ready shape: live pid + recorded readiness, no checkpoints dir. */
const readyFixture = async (): Promise<{ root: string; file: string; cleanup: () => Promise<void> }> => {
  const root = await tempRoot()
  const procs: { kill: (signal?: string) => void }[] = []
  const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
  procs.push(proc)
  const { readLstart, ensureUpStateDir, upPaths, writeSupervisorState } = await import("./up-state")
  const lstart = (await readLstart(proc.pid))!
  const file = join(root, "ow.yaml")
  await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
  const paths = upPaths(root)
  await ensureUpStateDir(paths.stateDir)
  await writeSupervisorState(paths.supervisorFile, {
    version: 1,
    startedAt: "2026-10-09T08:00:00.000Z",
    services: [{ name: "a", pid: proc.pid, lstart, startedAt: "t", cmd: "sleep 30", lastReadiness: { ok: true } }],
  })
  // Farm ritual shape: .env symlink → real target, .venv python, branch HEAD.
  await writeFile(join(root, "shared.env"), "SHARED=1\n", "utf8")
  await symlink(join(root, "shared.env"), join(root, ".env"))
  await mkdir(join(root, ".venv", "bin"), { recursive: true })
  await writeFile(join(root, ".venv", "bin", "python"), "#!/bin/sh\n", "utf8")
  await mkdir(join(root, ".git"), { recursive: true })
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8")
  return { root, file, cleanup: async () => {
    for (const p of procs) {
      try {
        p.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
    await rm(root, { recursive: true, force: true })
  } }
}

const treeSnapshot = async (root: string): Promise<Map<string, number>> => {
  const out = new Map<string, number>()
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(path)
      else out.set(path, info.mtimeMs)
    }
  }
  await walk(root)
  return out
}

describe("provision --check (ready shape)", () => {
  test("exit 0 + frozen human lines + summary (never hazır:)", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      // Exactly one line per check + M7 additive dataClock block + summary.
      // (M7 carve-out, gate-blessed: without a clock file the block is the
      // single `unmeasured` line; exits and old lines are unchanged.)
      expect(io.out).toHaveLength(6)
      expect(io.out[0]).toMatch(/^ok: envSymlink /)
      expect(io.out[1]).toMatch(/^ok: venv /)
      expect(io.out[2]).toMatch(/^ok: head /)
      expect(io.out[3]).toMatch(/^ok: preflight /)
      expect(io.out[4]).toBe("dataClock: unmeasured (no-file)")
      expect(io.out[5]).toBe("provision passed")
      for (const line of io.out) expect(line.startsWith("ready:")).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("JSON keys frozen English; portBase ALWAYS null; root abs + rootBase", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      const io = capture()
      try {
        expect(await runProvisionCheck({ rootDir: root, file, json: true, probe: false })).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as Record<string, unknown>
      // M7 additive key (old keys byte-identical, exits unchanged).
      expect(Object.keys(payload).sort()).toEqual(["branch", "checks", "dataClock", "human", "missing", "pass", "portBase", "revShort", "root", "rootBase"])
      expect(payload["pass"]).toBe(true)
      expect(payload["portBase"]).toBeNull()
      expect(payload["root"]).toBe(root)
      expect(payload["rootBase"]).toBe(root.split("/").pop())
      expect(payload["branch"]).toBe("main")
      expect(payload["revShort"]).toBeNull()
      const checks = payload["checks"] as { name: string; ok: boolean; note: string }[]
      expect(checks.map((c) => c.name)).toEqual(["envSymlink", "venv", "head", "preflight"])
      expect(checks.every((c) => c.ok)).toBe(true)
      expect(payload["missing"]).toEqual([])
      const human = payload["human"] as string[]
      expect(human).toHaveLength(6)
      expect(human[4]).toBe("dataClock: unmeasured (no-file)")
      expect(human[5]).toBe("provision passed")
    } finally {
      await cleanup()
    }
  })

  test("CLI verb: provision --check exits 0; bare provision → usage exit 2", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["provision", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("provision passed")
      const io2 = capture()
      let usage = -1
      try {
        usage = await run(["provision", "--file", file])
      } finally {
        io2.restore()
      }
      expect(usage).toBe(2)
      expect(io2.err.join("\n")).toContain("ow: provision --check is required")
      void root
    } finally {
      await cleanup()
    }
  })
})

describe("provision --check (broken shape)", () => {
  test("dangling .env symlink + missing venv → exit 1 + eksik lines + summary count", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await symlink(join(root, "gone.env"), join(root, ".env"))
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as {
        pass: boolean
        checks: { name: string; ok: boolean }[]
        missing: string[]
        human: string[]
      }
      expect(payload.pass).toBe(false)
      const byName = new Map(payload.checks.map((c) => [c.name, c.ok]))
      expect(byName.get("envSymlink")).toBe(false)
      expect(byName.get("venv")).toBe(false)
      expect(payload.missing).toContain("envSymlink:broken")
      expect(payload.missing).toContain("venv:missing")
      expect(payload.human.filter((l) => l.startsWith("missing: "))).toHaveLength(3)
      expect(payload.human[payload.human.length - 1]).toBe("provision missing: 3")
      for (const line of payload.human) expect(line.startsWith("ready:")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(".env regular file → distinct not-symlink failure", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await writeFile(join(root, ".env"), "X=1\n", "utf8")
      const io = capture()
      try {
        expect(await runProvisionCheck({ rootDir: root, file, json: true, probe: false })).toBe(1)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as { missing: string[] }
      expect(payload.missing).toContain("envSymlink:not-symlink")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("provision HEAD (never git exec, never fail)", () => {
  test("detached HEAD → short-7 revShort; branch HEAD → branch; missing → nulls + exit unaffected", async () => {
    const root = await tempRoot()
    try {
      await mkdir(join(root, ".git"), { recursive: true })
      await writeFile(join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n", "utf8")
      expect((await readHeadIdentity(root)).revShort).toBe("0123456")
      expect((await readHeadIdentity(root)).branch).toBeNull()
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feature-x\n", "utf8")
      const branched = await readHeadIdentity(root)
      expect(branched.branch).toBe("feature-x")
      expect(branched.revShort).toBeNull()
      await rm(join(root, ".git"), { recursive: true, force: true })
      const missing = await readHeadIdentity(root)
      expect(missing.revShort).toBeNull()
      expect(missing.branch).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("linked-worktree .git gitdir file resolves to its HEAD", async () => {
    const root = await tempRoot()
    try {
      const gitDir = join(root, "real-git")
      await mkdir(gitDir, { recursive: true })
      await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/wt-1\n", "utf8")
      await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8")
      const identity = await readHeadIdentity(root)
      expect(identity.branch).toBe("wt-1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("provision hostile (witness-not-actor)", () => {
  test("secret-bearing service cmd + secret .env target: hunter2 never enters stdout JSON, human, or written state", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: TOKEN=hunter2 sleep 30\n", "utf8")
      // Symlink target is a DIRECTORY: lstat-shape passes while any content
      // read of the target would throw — plus the sentinel file inside must
      // never be surfaced.
      const targetDir = join(root, "farm-env")
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, "token"), "token=hunter2 super-secret-value\n", "utf8")
      await symlink(targetDir, join(root, ".env"))
      await mkdir(join(root, ".venv", "bin"), { recursive: true })
      await writeFile(join(root, ".venv", "bin", "python"), "#!/bin/sh\n", "utf8")
      // Supervisor records the hostile cmd shape (real path, like spawn would).
      const { ensureUpStateDir, upPaths, writeSupervisorState } = await import("./up-state")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const before = await treeSnapshot(root)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-09T08:00:00.000Z",
        services: [{ name: "a", pid: 1, lstart: "l", startedAt: "t", cmd: "TOKEN=hunter2 sleep 30" }],
      })
      const frozen = await treeSnapshot(root)
      const runJson = capture()
      let jsonOut = ""
      try {
        await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
        jsonOut = runJson.out.join("\n")
      } finally {
        runJson.restore()
      }
      const runHuman = capture()
      let humanOut = ""
      try {
        await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
        humanOut = runHuman.out.join("\n")
      } finally {
        runHuman.restore()
      }
      expect(jsonOut).not.toContain("hunter2")
      expect(humanOut).not.toContain("hunter2")
      // Provision writes nothing: file set + mtimes identical (supervisor
      // write above is the test's own setup, snapshotted after it).
      expect(await treeSnapshot(root)).toEqual(frozen)
      void before
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bayraksız TCP yoklaması çalışmaz (exec-sıfır kanıtı)", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      let calls = 0
      const io = capture()
      try {
        expect(await runProvisionCheck({ rootDir: root, file, json: true, probe: false, tcpCheck: async () => {
          calls += 1
          return true
        } })).toBe(0)
      } finally {
        io.restore()
      }
      expect(calls).toBe(0)
    } finally {
      await cleanup()
    }
  })
})

describe("NO-WORKTREE-NO-FRICTION (single-root goldens)", () => {
  /** `up --check` outputs on a fixed single-root fixture: provision wiring
   * must leave existing verbs byte-identical (`<root>` normalizes tmpdir). */
  test("up --check human + JSON byte-identical", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const human = capture()
      let code = -1
      try {
        code = await run(["up", "--check", "--file", file])
      } finally {
        human.restore()
      }
      expect(code).toBe(0)
      expect(human.out.join("\n").replaceAll(root, "<root>")).toBe("ow.yaml valid: 1 services (a)")
      const js = capture()
      try {
        expect(await run(["up", "--check", "--file", file, "--json"])).toBe(0)
      } finally {
        js.restore()
      }
      expect(js.out.join("\n").replaceAll(root, "<root>").replaceAll(file, "<root>/ow.yaml")).toBe(
        `{"file":"<root>/ow.yaml","services":[{"name":"a","cmd":"sleep 30"}],"warnings":[]}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("broken provision state never gates up --check or preflight", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await symlink(join(root, "gone.env"), join(root, ".env"))
      const io = capture()
      let code = -1
      try {
        code = await run(["up", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("provision data-clock witness (M7)", () => {
  const CLOCK = {
    schema_hash: "abc1234",
    applied_head: "mig001",
    seed_profile: "dev",
    seed_rev: "3",
    db_identity: "maindb",
    at: "2026-10-09T09:00:00.000Z",
  }

  const writeClock = async (dir: string, value: unknown): Promise<void> => {
    await mkdir(join(dir, ".ow"), { recursive: true })
    await writeFile(join(dir, ".ow", "data-clock.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8")
  }

  test("fresh clock renders ledger line, exits unchanged", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, CLOCK)
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("dataClock: maindb@mig001 (dev/3)")
      expect(io.out.join("\n")).toContain("db:maindb seed:dev/3 mig:mig001 (root)")
      const io2 = capture()
      try {
        expect(await runProvisionCheck({ rootDir: root, file, json: true, probe: false })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { dataClock: { state: string } }
      expect(payload.dataClock.state).toBe("fresh")
    } finally {
      await cleanup()
    }
  })

  test("missing clock renders unmeasured, exits unchanged", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("dataClock: unmeasured (no-file)")
      const io2 = capture()
      try {
        expect(await runProvisionCheck({ rootDir: root, file, json: true, probe: false })).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as { dataClock: { state: string } }
      expect(payload.dataClock.state).toBe("missing")
    } finally {
      await cleanup()
    }
  })

  test("stale clock with newer checkpoints renders stale-ignored, exit unchanged (Q3)", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, { ...CLOCK, at: "2026-10-09T08:00:00.000Z" })
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      await writeFile(
        join(root, ".ow", "checkpoints", "nightly.jsonl"),
        `${JSON.stringify({ stage: "build", status: "confirmed", proof: { ok: true }, at: "2026-10-09T09:00:00.000Z", by: "runner", code: { script_hash: "h1", checkout_rev: "r1" }, runtime: { port: 1 } })}\n`,
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("(stale-ignored)")
    } finally {
      await cleanup()
    }
  })

  test("oversize clock renders unmeasured(data-clock-oversize), exit unchanged", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, `{"schema_hash": "${"x".repeat(5000)}"}`)
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("dataClock: unmeasured (data-clock-oversize)")
    } finally {
      await cleanup()
    }
  })

  test("collision advisory for shared db_identity across scopes", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, CLOCK)
      await mkdir(join(root, "sub", ".ow"), { recursive: true })
      await writeFile(join(root, "sub", ".ow", "data-clock.json"), JSON.stringify({ ...CLOCK, seed_rev: "9" }), "utf8")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n  b:\n    cmd: sleep 30\n    cwd: sub\n", "utf8")
      const io = capture()
      try {
        await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("collision-warning: maindb in two checkouts")
    } finally {
      await cleanup()
    }
  })

  test("env_file missing exits 2 names-only; present file never read", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  cart:\n    services: [a]\n    probes: [{id: p, argv: [./x.sh]}]\n    env_file: missing.env\n",
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("missing.env")
      await writeFile(join(root, "missing.env"), "SECRET=hunter2\n", "utf8")
      const io2 = capture()
      let code2 = -1
      try {
        code2 = await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
      } finally {
        io2.restore()
      }
      expect(code2).toBe(0)
      const io3 = capture()
      try {
        await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io3.restore()
      }
      const everything = `${io2.out.join("\n")}\n${io2.err.join("\n")}\n${io3.out.join("\n")}\n${io3.err.join("\n")}`
      expect(everything).not.toContain("hunter2")
    } finally {
      await cleanup()
    }
  })

  test("scenario data mismatch warns UNVERIFIED, exit unchanged", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, CLOCK)
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  cart:\n    services: [a]\n    probes: [{id: p, argv: [./x.sh]}]\n    data: {seed_rev: 99}\n",
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("data mismatch: seed_rev (UNVERIFIED)")
    } finally {
      await cleanup()
    }
  })

  test("hostile identities masked everywhere; NEVER-list holds over new files", async () => {
    const { root, file, cleanup } = await readyFixture()
    try {
      await writeClock(root, {
        ...CLOCK,
        db_identity: "token=hunter2",
        seed_profile: "carrier",
        seed_rev: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      })
      const io = capture()
      try {
        await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      const io2 = capture()
      try {
        await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
      } finally {
        io2.restore()
      }
      const everything = `${io.out.join("\n")}\n${io.err.join("\n")}\n${io2.out.join("\n")}\n${io2.err.join("\n")}`
      expect(everything).not.toContain("hunter2")
      expect(everything).not.toContain("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")
      const { readFile } = await import("node:fs/promises")
      const { fileURLToPath } = await import("node:url")
      const cliDir = join(fileURLToPath(new URL(".", import.meta.url)))
      for (const source of [await readFile(join(cliDir, "up-data-clock.ts"), "utf8"), await readFile(join(cliDir, "up-provision.ts"), "utf8")]) {
        expect(source).not.toMatch(/Bun\.spawn|spawn\s*\(|exec\s*\(|child_process/)
        expect(source).not.toMatch(/from\s+["'](pg|mysql2?|sqlite3|nodemailer|amqplib|kafkajs|ioredis|bullmq?)["']/)
        expect(source).not.toMatch(/DROP\s|TRUNCATE|DELETE\s+FROM|sendMail|enqueue|createConnection|fetch\s*\(|http\.request/)
        expect(source).not.toMatch(/[^_a-zA-Z]migrate\s*\(|[^_a-zA-Z]seed\s*\(|\.migrate\b|\.seed\b/)
      }
    } finally {
      await cleanup()
    }
  })
})

describe("MEDIUM-2 corrupt scenarios warns, provision continues", () => {
  test("present-but-corrupt scenarios file warns (env_file/data checks skipped), exit follows checks", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await writeFile(join(root, "ow.scenarios.yaml"), "version: 1\nscenarios:\n  bad:\n    services: [api]\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: false, probe: false })
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("ow: invalid scenarios file:")
      expect(io.err.join("\n")).toContain("env_file/data checks skipped")
      expect(typeof code).toBe("number")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("MEDIUM-3 provision preflight gate includes boundary claims", () => {
  test("evidence-demanding boundary without records fails the preflight check", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await writeFile(
        join(root, "ow.scenarios.yaml"),
        "version: 1\nscenarios:\n  cart:\n    services: [a]\n    boundaries: [real-read-only]\n    probes: [{id: p, argv: [./x.sh]}]\n    checkpoints: [ok]\n",
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as { pass: boolean; missing: string[] }
      expect(payload.pass).toBe(false)
      expect(payload.missing.some((line) => line.startsWith("boundary:"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("MEDIUM-6 corrupt checkpoint lines invalidate the preflight gate", () => {
  test("skipped lines surface as readiness:evidence-incomplete missing", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      await mkdir(join(root, ".ow", "checkpoints"), { recursive: true })
      await writeFile(
        join(root, ".ow", "checkpoints", "nightly.jsonl"),
        `${JSON.stringify({ stage: "build", status: "confirmed", proof: { ok: true }, at: "2026-10-09T09:00:00.000Z", by: "runner" })}\nnot-json{{{\n`,
        "utf8",
      )
      const io = capture()
      let code = -1
      try {
        code = await runProvisionCheck({ rootDir: root, file, json: true, probe: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as { pass: boolean; missing: string[] }
      expect(payload.pass).toBe(false)
      expect(payload.missing).toContain("readiness:evidence-incomplete")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
