import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { downAll, probePort, runSupervised, type UpLineHandler } from "./up-supervisor"
import {
  acquireLock,
  classifyLock,
  classifySupervisorFile,
  ensureUpStateDir,
  isLivePid,
  readLstart,
  readSupervisorState,
  upPaths,
  writeSupervisorState,
} from "./up-state"
import { run } from "./cli"

const owned: { kill: (signal?: string) => void }[] = []

afterEach(async () => {
  for (const proc of owned.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
})

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m2-"))

const spawnSleep = (seconds = 30): { pid: number; kill: (signal?: string) => void } => {
  const proc = Bun.spawn(["sleep", String(seconds)], { stdout: "ignore", stderr: "ignore" })
  owned.push(proc)
  return proc
}

const collectLines = (): { lines: string[]; onLine: UpLineHandler } => {
  const lines: string[] = []
  const onLine: UpLineHandler = (service, stream, line) => {
    lines.push(`[${service}|${stream}] ${line}`)
  }
  return { lines, onLine }
}

describe("up state roundtrip", () => {
  test("supervisor.json survives write/read with 0600 atomic discipline", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [{ name: "web", pid: 4242, lstart: "Mon Oct  6 00:00:00 2026", startedAt: "2026-10-07T00:00:00.000Z" }],
      })
      const back = await readSupervisorState(paths.supervisorFile)
      expect(back?.version).toBe(1)
      expect(back?.services[0]).toMatchObject({ name: "web", pid: 4242 })
      expect(await readSupervisorState(join(paths.stateDir, "yok.json"))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt supervisor.json fails closed (null, never throws)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      expect(await readSupervisorState(paths.supervisorFile)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("lock live/stale", () => {
  test("live lock refuses reclaim, dead lock reclaims with warning", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = await readLstart(sleeper.pid)
      expect(lstart).not.toBeNull()
      await writeFile(paths.lockFile, JSON.stringify({ pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }), "utf8")
      expect((await classifyLock(paths.lockFile)).kind).toBe("live")
      await expect(acquireLock(paths.lockFile, [])).rejects.toThrow("zaten çalışıyor")
      sleeper.kill("SIGKILL")
      for (let i = 0; i < 30 && (await readLstart(sleeper.pid)) !== null; i += 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
      }
      expect((await classifyLock(paths.lockFile)).kind).toBe("stale")
      const warnings: string[] = []
      const lock = await acquireLock(paths.lockFile, warnings)
      expect(lock.pid).toBe(process.pid)
      expect(warnings.join(" ")).toContain("bayat kilit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("lstart kill guard", () => {
  test("recycled pid (live pid, mismatched lstart) is never signaled by down", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const real = await readLstart(sleeper.pid)
      expect(real).not.toBeNull()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "yabanci", pid: sleeper.pid, lstart: "bogus-lstart-asla-eslesmez", startedAt: new Date().toISOString() }],
      })
      expect(await isLivePid(sleeper.pid, "bogus-lstart-asla-eslesmez")).toBe(false)
      const outcome = await downAll(root)
      expect(outcome.results).toHaveLength(1)
      expect(outcome.results[0]).toMatchObject({ name: "yabanci", stopped: true })
      // the foreign process survives: the guard never signaled it
      expect(await isLivePid(sleeper.pid, real!)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown pid with bogus lstart is reported, never signaled", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "hayalet", pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }],
      })
      expect(await isLivePid(987654321, "bogus")).toBe(false)
      const outcome = await downAll(root)
      expect(outcome.results[0]).toMatchObject({ name: "hayalet", stopped: true, note: "çalışmıyor" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("spawn and exit codes", () => {
  test("echo service streams lines and exits 0", async () => {
    const root = await tempRoot()
    try {
      const { lines, onLine } = collectLines()
      const code = await runSupervised([{ name: "selam", cmd: "echo ok" }], { rootDir: root, onLine })
      expect(code).toBe(0)
      expect(lines).toContain("[selam|stdout] ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("spontaneous nonzero exit is recorded in state and yields exit 1", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      const code = await runSupervised(
        [
          { name: "selam", cmd: "echo ok" },
          { name: "patlak", cmd: "exit 3" },
        ],
        { rootDir: root, stateFile: paths.supervisorFile, onLine },
      )
      expect(code).toBe(1)
      expect(lines).toContain("[selam|stdout] ok")
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services.find((svc) => svc.name === "patlak")?.exitCode).toBe(3)
      expect(state?.services.find((svc) => svc.name === "selam")?.exitCode).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing cwd aborts pre-spawn with zero spawns", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      await expect(
        runSupervised(
          [
            { name: "iyi", cmd: "echo asla" },
            { name: "kotuklasor", cmd: "echo hi", cwd: "yok-boyle-dizin" },
          ],
          { rootDir: root, stateFile: paths.supervisorFile, onLine },
        ),
      ).rejects.toThrow("cwd")
      expect(lines).toEqual([])
      expect(existsSync(paths.supervisorFile)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("shutdown-caused terminations are excluded from the exit-1 tally", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const started = Date.now()
      const code = await runSupervised([{ name: "uyu", cmd: "sleep 30" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        shouldStop: () => Date.now() - started > 400,
      })
      expect(code).toBe(0)
      const state = await readSupervisorState(paths.supervisorFile)
      const recorded = state?.services.find((svc) => svc.name === "uyu")
      expect(recorded).toBeDefined()
      expect(await isLivePid(recorded!.pid, recorded!.lstart)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("down --rm", () => {
  test("removes supervisor.json and lock, keeps logs", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await ensureUpStateDir(paths.logsDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [
          { name: "bitmis", pid: 1, lstart: "bogus", startedAt: new Date().toISOString(), exitCode: 0, exitedAt: new Date().toISOString() },
        ],
      })
      await writeFile(join(paths.logsDir, "bitmis.jsonl"), '{"t":"x","stream":"stdout","line":"merhaba"}\n', "utf8")
      await writeFile(paths.lockFile, JSON.stringify({ pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }), "utf8")
      const outcome = await downAll(root, true)
      expect(outcome.results).toHaveLength(1)
      expect(existsSync(paths.supervisorFile)).toBe(false)
      expect(existsSync(paths.lockFile)).toBe(false)
      expect(await readFile(join(paths.logsDir, "bitmis.jsonl"), "utf8")).toContain("merhaba")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("down marks newly-dead services so state shows stopped", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = (await readLstart(sleeper.pid))!
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "kisa", pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }],
      })
      const outcome = await downAll(root)
      expect(outcome.results[0]).toMatchObject({ name: "kisa", stopped: true })
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services[0]?.exitCode).toBeDefined()
      expect(await isLivePid(sleeper.pid, lstart)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("probePort", () => {
  test("free port is false, held port is true", async () => {
    const holder = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const port = holder.port
    try {
      expect(await probePort(port)).toBe(true)
    } finally {
      holder.stop(true)
    }
    expect(await probePort(port)).toBe(false)
  })

  test("occupied port warns exactly once per service", async () => {
    const root = await tempRoot()
    const holder = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const errors: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    }
    try {
      await runSupervised([{ name: "tek", cmd: "echo hi", port: holder.port }], { rootDir: root })
    } finally {
      console.error = orig
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
    expect(errors.filter((line) => line.includes("port çakışması"))).toHaveLength(1)
  })

  test("free port warns never", async () => {
    const root = await tempRoot()
    const holder = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const port = holder.port
    holder.stop(true)
    const errors: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    }
    try {
      await runSupervised([{ name: "bos", cmd: "echo hi", port }], { rootDir: root })
    } finally {
      console.error = orig
      await rm(root, { recursive: true, force: true })
    }
    expect(errors.filter((line) => line.includes("port çakışması"))).toHaveLength(0)
  })
})

describe("supervisor file classification", () => {
  test("missing/ok/corrupt/bad-version distinguish", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      expect(await classifySupervisorFile(paths.supervisorFile)).toBe("missing")
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      expect(await classifySupervisorFile(paths.supervisorFile)).toBe("corrupt")
      await writeFile(paths.supervisorFile, JSON.stringify({ version: 99, services: [] }), "utf8")
      expect(await classifySupervisorFile(paths.supervisorFile)).toBe("bad-version")
      await writeSupervisorState(paths.supervisorFile, { version: 1, startedAt: new Date().toISOString(), services: [] })
      expect(await classifySupervisorFile(paths.supervisorFile)).toBe("ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("down exit codes", () => {
  const fixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
    return { root, file }
  }

  test("corrupt supervisor.json fails closed with exit 1", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      expect(await run(["down", "--file", file])).toBe(1)
      expect(existsSync(paths.supervisorFile)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("bad-version supervisor.json fails closed with exit 1", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, JSON.stringify({ version: 99, services: [] }), "utf8")
      expect(await run(["down", "--file", file])).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("down --rm clears corrupt state with exit 0", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      expect(await run(["down", "--file", file, "--rm"])).toBe(0)
      expect(existsSync(paths.supervisorFile)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing supervisor.json is nothing-to-stop with exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      expect(await run(["down", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("detach quoting", () => {
  test("shQuote round-trips $()/backtick/$VAR/quotes unexpanded", async () => {
    const { existsSync: exists } = await import("node:fs")
    const { shQuote, superviseShell } = await import("./up-supervisor-cli")
    const evil = "/tmp/a$(touch /tmp/ow-pwned-fixture)b`c`$HOME'd'e"
    const proc = Bun.spawn(["sh", "-c", `printf '%s' ${shQuote(evil)}`], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toBe(evil)
    expect(exists("/tmp/ow-pwned-fixture")).toBe(false)
    const shell = superviseShell("/bin/ow", null, evil, "/tmp/x.out")
    expect(shell).toContain(shQuote(evil))
    expect(shell).toContain("echo $!")
  })
})
