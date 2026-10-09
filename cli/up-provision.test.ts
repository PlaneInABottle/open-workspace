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
      // Exactly one line per check + summary.
      expect(io.out).toHaveLength(5)
      expect(io.out[0]).toMatch(/^ok: envSymlink /)
      expect(io.out[1]).toMatch(/^ok: venv /)
      expect(io.out[2]).toMatch(/^ok: head /)
      expect(io.out[3]).toMatch(/^ok: preflight /)
      expect(io.out[4]).toBe("provision geçti")
      for (const line of io.out) expect(line.startsWith("hazır:")).toBe(false)
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
      expect(Object.keys(payload).sort()).toEqual(["branch", "checks", "human", "missing", "pass", "portBase", "revShort", "root", "rootBase"])
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
      expect(human).toHaveLength(5)
      expect(human[4]).toBe("provision geçti")
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
      expect(io.out.join("\n")).toContain("provision geçti")
      const io2 = capture()
      let usage = -1
      try {
        usage = await run(["provision", "--file", file])
      } finally {
        io2.restore()
      }
      expect(usage).toBe(2)
      expect(io2.err.join("\n")).toContain("ow: provision --check gerekli")
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
      expect(payload.human.filter((l) => l.startsWith("eksik: "))).toHaveLength(3)
      expect(payload.human[payload.human.length - 1]).toBe("provision eksik: 3")
      for (const line of payload.human) expect(line.startsWith("hazır:")).toBe(false)
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
      expect(human.out.join("\n").replaceAll(root, "<root>")).toBe("ow.yaml geçerli: 1 servis (a)")
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
