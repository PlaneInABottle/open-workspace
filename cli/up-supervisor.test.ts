import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseUpFile } from "./up-schema"
import {
  assertNoLiveOrphans,
  downAll,
  findLiveOrphans,
  mergePreservingSettled,
  persistMerged,
  probePort,
  runSupervised,
  type UpLineHandler,
} from "./up-supervisor"
import {
  acquireLock,
  classifyLock,
  classifySupervisorFile,
  ensureUpStateDir,
  isLivePid,
  lockFileShape,
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

describe("per-service env merge", () => {
  test("service env overrides inherited env, OW_SERVICE always wins", async () => {
    const root = await tempRoot()
    const saved = { inherit: process.env.OW_ENV_TEST_INHERIT, over: process.env.OW_ENV_TEST_OVER }
    process.env.OW_ENV_TEST_INHERIT = "from-process"
    process.env.OW_ENV_TEST_OVER = "from-process"
    try {
      const services = parseUpFile(
        "services:\n  app:\n    cmd: echo \"$OW_ENV_TEST_INHERIT|$OW_ENV_TEST_OVER|$OW_ENV_TEST_SVC|$OW_SERVICE\"\n    env: {OW_ENV_TEST_OVER: from-service, OW_ENV_TEST_SVC: svc, OW_SERVICE: spoof}\n",
      ).services
      const { lines, onLine } = collectLines()
      const code = await runSupervised(services, { rootDir: root, onLine })
      expect(code).toBe(0)
      expect(lines).toContain("[app|stdout] from-process|from-service|svc|app")
    } finally {
      for (const [key, value] of [["OW_ENV_TEST_INHERIT", saved.inherit], ["OW_ENV_TEST_OVER", saved.over]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("H5 empty-lstart refusal", () => {
  test("live pid + empty lstart: down refuses, process survives, no false settlement", async () => {
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
        services: [{ name: "kor", pid: sleeper.pid, lstart: "", startedAt: new Date().toISOString() }],
      })
      const outcome = await downAll(root)
      expect(outcome.results).toHaveLength(1)
      expect(outcome.results[0].stopped).toBe(false)
      expect(outcome.results[0].note).toMatch(/lstart bilinmiyor/)
      expect(await isLivePid(sleeper.pid, real!)).toBe(true)
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services[0]?.exitCode).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown tail lstart refuses even when the main pid is verifiable", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const main = spawnSleep()
      const tail = spawnSleep()
      const mainLstart = (await readLstart(main.pid))!
      const tailLstart = (await readLstart(tail.pid))!
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [
          {
            name: "kuyruk",
            pid: main.pid,
            lstart: mainLstart,
            startedAt: new Date().toISOString(),
            logsPid: tail.pid,
            logsLstart: "",
          },
        ],
      })
      const outcome = await downAll(root)
      expect(outcome.results[0].stopped).toBe(false)
      expect(outcome.results[0].note).toMatch(/logs lstart bilinmiyor/)
      expect(await isLivePid(main.pid, mainLstart)).toBe(true)
      expect(await isLivePid(tail.pid, tailLstart)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M1 downAll corrupt gate", () => {
  test("corrupt/bad-version throws without rm; --rm bypass still clears", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      await expect(downAll(root)).rejects.toThrow(/bozuk/)
      expect(existsSync(paths.supervisorFile)).toBe(true)
      await writeFile(paths.supervisorFile, JSON.stringify({ version: 99, services: [] }), "utf8")
      await expect(downAll(root)).rejects.toThrow(/sürüm/)
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      const outcome = await downAll(root, true)
      expect(outcome.removedState).toBe(true)
      expect(existsSync(paths.supervisorFile)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M2 corrupt lock", () => {
  test("corrupt lock classifies corrupt and reclaims with a warning, never silently", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.lockFile, "bozuk {{{", "utf8")
      expect(await lockFileShape(paths.lockFile)).toBe("corrupt")
      expect((await classifyLock(paths.lockFile)).kind).toBe("corrupt")
      const warnings: string[] = []
      const lock = await acquireLock(paths.lockFile, warnings)
      expect(lock.pid).toBe(process.pid)
      expect(warnings.join(" ")).toContain("bozuk kilit")
      expect(await lockFileShape(paths.lockFile)).toBe("ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M3 merge-on-write", () => {
  test("defined settlement wins over fresh absence per service", () => {
    const onDisk = [
      { name: "a", pid: 1, lstart: "x", startedAt: "t", exitCode: 3, exitedAt: "e" },
      { name: "b", pid: 2, lstart: "y", startedAt: "t" },
    ]
    const fresh = [
      { name: "a", pid: 1, lstart: "x", startedAt: "t" },
      { name: "b", pid: 2, lstart: "y", startedAt: "t", exitCode: 0, exitedAt: "f" },
    ]
    const merged = mergePreservingSettled(onDisk, fresh)
    expect(merged.find((svc) => svc.name === "a")).toMatchObject({ exitCode: 3, exitedAt: "e" })
    expect(merged.find((svc) => svc.name === "b")).toMatchObject({ exitCode: 0, exitedAt: "f" })
  })

  test("behind-back write survives a stale persist (deterministic interleave)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const stale = {
        version: 1 as const,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [{ name: "web", pid: 4242, lstart: "Mon Oct  6 00:00:00 2026", startedAt: "2026-10-07T00:00:00.000Z" }],
      }
      await writeSupervisorState(paths.supervisorFile, stale)
      // A concurrent writer settles behind our back…
      await writeSupervisorState(paths.supervisorFile, {
        ...stale,
        services: [
          {
            ...stale.services[0],
            exitCode: 3,
            exitedAt: "2026-10-08T00:00:00.000Z",
            logsEnded: { code: 1, at: "2026-10-08T00:00:00.000Z" },
          },
        ],
      })
      // …then our stale snapshot persists: newer fields must survive.
      await persistMerged(paths.supervisorFile, stale)
      const back = await readSupervisorState(paths.supervisorFile)
      expect(back?.services[0]).toMatchObject({ exitCode: 3, exitedAt: "2026-10-08T00:00:00.000Z" })
      expect(back?.services[0]?.logsEnded).toEqual({ code: 1, at: "2026-10-08T00:00:00.000Z" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("H6 lock exclusivity and orphan probe", () => {
  test("second acquire with a live lock fails and leaves it byte-identical", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = await readLstart(sleeper.pid)
      expect(lstart).not.toBeNull()
      await writeFile(paths.lockFile, JSON.stringify({ pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }), "utf8")
      const before = await readFile(paths.lockFile, "utf8")
      await expect(acquireLock(paths.lockFile, [])).rejects.toThrow("zaten çalışıyor")
      expect(await readFile(paths.lockFile, "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("up refuses when live orphans of a dead supervisor exist (names them)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
      const sleeper = spawnSleep()
      const lstart = (await readLstart(sleeper.pid))!
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "web", pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }],
      })
      // No lock file: dead supervisor, live child — a deterministic orphan.
      expect(await findLiveOrphans(root)).toHaveLength(1)
      const errors: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(" "))
      }
      let code = -1
      try {
        code = await run(["up", "--file", file])
      } finally {
        console.error = savedError
      }
      expect(code).toBe(2)
      expect(errors.join("\n")).toContain("yetim")
      expect(errors.join("\n")).toContain("web")
      expect(await isLivePid(sleeper.pid, lstart)).toBe(true)
      await expect(assertNoLiveOrphans(root)).rejects.toThrow(/yetim/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("L2 non-UTF8 config", () => {
  test("0xFF bytes fail up --check with an encoding error (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, Buffer.concat([Buffer.from("services:\n  a:\n    cmd: ", "utf8"), Buffer.from([0xff]), Buffer.from("\n", "utf8")]))
      const errors: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(" "))
      }
      let code = -1
      try {
        code = await run(["up", "--check", "--file", file])
      } finally {
        console.error = savedError
      }
      expect(code).toBe(2)
      expect(errors.join("\n")).toMatch(/UTF-8/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runSuperviseFile rejects undecodable bytes before creating state", async () => {
    const { runSuperviseFile } = await import("./up-supervisor-cli")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, Buffer.concat([Buffer.from("services:\n  a:\n    cmd: ", "utf8"), Buffer.from([0xff]), Buffer.from("\n", "utf8")]))
      const errors: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(" "))
      }
      try {
        expect(await runSuperviseFile(file, { quiet: true })).toBe(2)
      } finally {
        console.error = savedError
      }
      expect(errors.join("\n")).toMatch(/UTF-8/)
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("supervisor build identity", () => {
  test("explicit build block is recorded into supervisor.json", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { onLine } = collectLines()
      const code = await runSupervised([{ name: "a", cmd: "echo hi" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine,
        build: { sha: "s1", digest: "d-old", time: "2026-10-07T07:00:00Z" },
      })
      expect(code).toBe(0)
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.build).toEqual({ sha: "s1", digest: "d-old", time: "2026-10-07T07:00:00Z" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("no sidecar in test env means no build key (silent path)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { onLine } = collectLines()
      await runSupervised([{ name: "a", cmd: "echo hi" }], { rootDir: root, stateFile: paths.supervisorFile, onLine })
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state).not.toHaveProperty("build")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("persistMerged preserves an on-disk build block it did not write", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [],
        build: { sha: "s1", digest: "d-old", time: "2026-10-07T07:00:00Z" },
      })
      const { persistMerged } = await import("./up-supervisor")
      await persistMerged(paths.supervisorFile, { version: 1, startedAt: "2026-10-08T00:00:00.000Z", services: [] })
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.build).toEqual({ sha: "s1", digest: "d-old", time: "2026-10-07T07:00:00Z" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
