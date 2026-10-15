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
      expect(await readSupervisorState(join(paths.stateDir, "missing.json"))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("corrupt supervisor.json fails closed (null, never throws)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
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
      await expect(acquireLock(paths.lockFile, [])).rejects.toThrow("already running")
      sleeper.kill("SIGKILL")
      for (let i = 0; i < 30 && (await readLstart(sleeper.pid)) !== null; i += 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
      }
      expect((await classifyLock(paths.lockFile)).kind).toBe("stale")
      const warnings: string[] = []
      const lock = await acquireLock(paths.lockFile, warnings)
      expect(lock.pid).toBe(process.pid)
      expect(warnings.join(" ")).toContain("stale lock")
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
        services: [{ name: "foreign", pid: sleeper.pid, lstart: "bogus-lstart-never-matches", startedAt: new Date().toISOString() }],
      })
      expect(await isLivePid(sleeper.pid, "bogus-lstart-never-matches")).toBe(false)
      const outcome = await downAll(root)
      expect(outcome.results).toHaveLength(1)
      expect(outcome.results[0]).toMatchObject({ name: "foreign", stopped: true })
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
        services: [{ name: "ghost", pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }],
      })
      expect(await isLivePid(987654321, "bogus")).toBe(false)
      const outcome = await downAll(root)
      expect(outcome.results[0]).toMatchObject({ name: "ghost", stopped: true, note: "not running" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("spawn and exit codes", () => {
  test("spontaneous nonzero exit is recorded in state and yields exit 1", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { lines, onLine } = collectLines()
      const code = await runSupervised(
        [
          { name: "hello", cmd: "echo ok" },
          { name: "broken", cmd: "exit 3" },
        ],
        { rootDir: root, stateFile: paths.supervisorFile, onLine },
      )
      expect(code).toBe(1)
      expect(lines).toContain("[hello|stdout] ok")
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services.find((svc) => svc.name === "broken")?.exitCode).toBe(3)
      expect(state?.services.find((svc) => svc.name === "hello")?.exitCode).toBe(0)
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
            { name: "good", cmd: "echo never" },
            { name: "badfolder", cmd: "echo hi", cwd: "no-such-dir" },
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
      const code = await runSupervised([{ name: "sleep", cmd: "sleep 30" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        shouldStop: () => Date.now() - started > 400,
      })
      expect(code).toBe(0)
      const state = await readSupervisorState(paths.supervisorFile)
      const recorded = state?.services.find((svc) => svc.name === "sleep")
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
          { name: "finished", pid: 1, lstart: "bogus", startedAt: new Date().toISOString(), exitCode: 0, exitedAt: new Date().toISOString() },
        ],
      })
      await writeFile(join(paths.logsDir, "finished.jsonl"), '{"t":"x","stream":"stdout","line":"hello"}\n', "utf8")
      await writeFile(paths.lockFile, JSON.stringify({ pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }), "utf8")
      const outcome = await downAll(root, true)
      expect(outcome.results).toHaveLength(1)
      expect(existsSync(paths.supervisorFile)).toBe(false)
      expect(existsSync(paths.lockFile)).toBe(false)
      expect(await readFile(join(paths.logsDir, "finished.jsonl"), "utf8")).toContain("hello")
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
        services: [{ name: "short", pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }],
      })
      const outcome = await downAll(root)
      expect(outcome.results[0]).toMatchObject({ name: "short", stopped: true })
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
      await runSupervised([{ name: "single", cmd: "echo hi", port: holder.port }], { rootDir: root })
    } finally {
      console.error = orig
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
    expect(errors.filter((line) => line.includes("port conflict"))).toHaveLength(1)
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
      await runSupervised([{ name: "empty", cmd: "echo hi", port }], { rootDir: root })
    } finally {
      console.error = orig
      await rm(root, { recursive: true, force: true })
    }
    expect(errors.filter((line) => line.includes("port conflict"))).toHaveLength(0)
  })
})

describe("supervisor file classification", () => {
  test("missing/ok/corrupt/bad-version distinguish", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      expect(await classifySupervisorFile(paths.supervisorFile)).toBe("missing")
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
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
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
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
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
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

describe("ow up --check with a retired depends_on", () => {
  test("retired key fails (exit 2) before any state exists", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    depends_on: [configuration]\n  configuration:\n    cmd: echo hi\n", "utf8")
      expect(await run(["up", "--check", "--file", file])).toBe(2)
      expect(await run(["up", "-d", "--file", file])).toBe(2)
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown and circular depends_on configs fail as unknown option", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    depends_on: [missing]\n", "utf8")
      expect(await run(["up", "--check", "--file", file])).toBe(2)
      expect(existsSync(join(root, ".ow"))).toBe(false)
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n    depends_on: [b]\n  b:\n    cmd: echo hi\n    depends_on: [a]\n", "utf8")
      const err: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        err.push(args.map(String).join(" "))
      }
      try {
        expect(await run(["up", "--check", "--file", file])).toBe(2)
      } finally {
        console.error = savedError
      }
      expect(err.join("\n")).toContain("unknown service option: depends_on")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("polish: --check order + nesting hint", () => {
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

  test("dep-less --check output stays byte-identical (text + json)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  b:\n    cmd: echo hi\n  a:\n    cmd: echo hi\n", "utf8")
      const io = capture()
      try {
        expect(await run(["up", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out).toEqual(["ow.yaml valid: 2 services (b, a)"])
      const io2 = capture()
      try {
        expect(await run(["up", "--check", "--json", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as Record<string, unknown>
      expect(payload).not.toHaveProperty("spawnOrder")
      expect(Object.keys(payload).sort()).toEqual(["file", "services", "warnings"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("nesting trap in --check: exit 2 with inline example + ow init pointer", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n    env:\n      A: b\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["up", "--check", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("invalid ow.yaml")
      expect(io.err.join("\n")).toContain('env: {A: "1"}')
      expect(io.err.join("\n")).toContain("ow init")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-nesting schema error carries no inline hint; bulk up stays hint-free", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    depends_on: [missing]\n", "utf8")
      const io = capture()
      try {
        expect(await run(["up", "--check", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.err.join("\n")).toContain("unknown service")
      expect(io.err.join("\n")).not.toContain("single-line inline")
      // Same nesting trap through bulk `up` (no --check): gated, no hint.
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n    env:\n      A: b\n", "utf8")
      const io2 = capture()
      try {
        expect(await run(["up", "--file", file])).toBe(2)
      } finally {
        io2.restore()
      }
      expect(io2.err.join("\n")).toContain("invalid ow.yaml")
      expect(io2.err.join("\n")).not.toContain("single-line inline")
    } finally {
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
        services: [{ name: "blind", pid: sleeper.pid, lstart: "", startedAt: new Date().toISOString() }],
      })
      const outcome = await downAll(root)
      expect(outcome.results).toHaveLength(1)
      expect(outcome.results[0].stopped).toBe(false)
      expect(outcome.results[0].note).toMatch(/lstart unknown/)
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
            name: "tail",
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
      expect(outcome.results[0].note).toMatch(/logs lstart unknown/)
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
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
      await expect(downAll(root)).rejects.toThrow(/corrupt/)
      expect(existsSync(paths.supervisorFile)).toBe(true)
      await writeFile(paths.supervisorFile, JSON.stringify({ version: 99, services: [] }), "utf8")
      await expect(downAll(root)).rejects.toThrow(/version/)
      await writeFile(paths.supervisorFile, "corrupt {{{", "utf8")
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
      await writeFile(paths.lockFile, "corrupt {{{", "utf8")
      expect(await lockFileShape(paths.lockFile)).toBe("corrupt")
      expect((await classifyLock(paths.lockFile)).kind).toBe("corrupt")
      const warnings: string[] = []
      const lock = await acquireLock(paths.lockFile, warnings)
      expect(lock.pid).toBe(process.pid)
      expect(warnings.join(" ")).toContain("corrupt lock")
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
      await expect(acquireLock(paths.lockFile, [])).rejects.toThrow("already running")
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
      expect(errors.join("\n")).toContain("orphaned processes")
      expect(errors.join("\n")).toContain("web")
      expect(await isLivePid(sleeper.pid, lstart)).toBe(true)
      await expect(assertNoLiveOrphans(root)).rejects.toThrow(/orphaned processes/)
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

describe("top-level startedAt is the supervisor boot clock", () => {
  const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> => {
    const start = Date.now()
    for (;;) {
      if (await cond()) return
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    }
  }

  test("persistMerged: fresh top-level startedAt wins (RED-before: sticky on-disk)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [],
      })
      await persistMerged(paths.supervisorFile, { version: 1, startedAt: "2026-10-08T00:00:00.000Z", services: [] })
      expect((await readSupervisorState(paths.supervisorFile))?.startedAt).toBe("2026-10-08T00:00:00.000Z")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("old-file parse: a first-unit-derived top level still reads, then normalizes", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:01.000Z",
        services: [{ name: "a", pid: 1, lstart: "x", startedAt: "2026-10-07T00:00:01.000Z" }],
      })
      expect((await readSupervisorState(paths.supervisorFile))?.startedAt).toBe("2026-10-07T00:00:01.000Z")
      await persistMerged(paths.supervisorFile, { version: 1, startedAt: "2026-10-09T00:00:00.000Z", services: [] })
      expect((await readSupervisorState(paths.supervisorFile))?.startedAt).toBe("2026-10-09T00:00:00.000Z")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("live restart moves only the service clock; the top level stays boot", async () => {
    const root = await tempRoot()
    let stopFlag = false
    let done: Promise<number> | null = null
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const keeper = spawnSleep(60)
      const keeperLstart = (await readLstart(keeper.pid))!
      await writeFile(paths.lockFile, JSON.stringify({ pid: keeper.pid, lstart: keeperLstart, startedAt: new Date().toISOString() }), "utf8")
      done = runSupervised(parseUpFile("services:\n  a:\n    cmd: sleep 30\n").services, {
        rootDir: root,
        stateFile: paths.supervisorFile,
        requestsDir: paths.requestsDir,
        owFile: file,
        onLine: () => undefined,
        shouldStop: () => stopFlag,
        supervisorStartedAt: "2026-10-07T00:00:00.000Z",
      })
      await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 1)
      const before = (await readSupervisorState(paths.supervisorFile))!
      expect(before.startedAt).toBe("2026-10-07T00:00:00.000Z")
      expect(await run(["restart", "a", "--file", file])).toBe(0)
      await waitFor(async () => {
        const state = await readSupervisorState(paths.supervisorFile)
        return state?.services.find((svc) => svc.name === "a")?.pid !== before.services.find((svc) => svc.name === "a")?.pid
      })
      const after = (await readSupervisorState(paths.supervisorFile))!
      expect(after.startedAt).toBe("2026-10-07T00:00:00.000Z")
      expect(after.services.find((svc) => svc.name === "a")?.startedAt).not.toBe(
        before.services.find((svc) => svc.name === "a")?.startedAt,
      )
    } finally {
      stopFlag = true
      if (done !== null) await done.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("downAll preserves the top-level startedAt byte-identically", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [{ name: "ghost", pid: 987654321, lstart: "bogus", startedAt: "2026-10-07T00:00:00.000Z" }],
      })
      const outcome = await downAll(root, false)
      expect(outcome.results).toHaveLength(1)
      expect((await readSupervisorState(paths.supervisorFile))?.startedAt).toBe("2026-10-07T00:00:00.000Z")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("single down preserves the top-level startedAt byte-identically", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: "2026-10-07T00:00:00.000Z",
        services: [{ name: "ghost", pid: 987654321, lstart: "bogus", startedAt: "2026-10-07T00:00:00.000Z" }],
      })
      const { runDirectSingleDown } = await import("./cli")
      expect(await runDirectSingleDown(root, "ghost", true)).toBe(0)
      expect((await readSupervisorState(paths.supervisorFile))?.startedAt).toBe("2026-10-07T00:00:00.000Z")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("H-b detached start freshness gate (no stale-file false-green)", () => {
  test("unwritable stale supervisor.json never reads as started", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: sleep 30\n", "utf8")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(root, ".ow", "supervisor.json"), { recursive: true })
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
      let code = -1
      try {
        code = await run(["up", "-d", "--file", file])
      } finally {
        console.log = origLog
        console.error = origError
      }
      expect(code).not.toBe(0)
      expect(out.join("\n")).not.toContain("started:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
})

describe("H-b evidence: healthy detached start reports started:", () => {
  test("isFreshSupervisorFile decides ties fail-closed (same-tick stale, newer fresh, missing false)", async () => {
    const { isFreshSupervisorFile } = await import("./up-supervisor-cli")
    const root = await tempRoot()
    try {
      const file = join(root, "sup.json")
      await writeFile(file, "{}", "utf8")
      const wall = Date.now()
      const { utimes } = await import("node:fs/promises")
      const past = new Date(wall - 5000)
      await utimes(file, past, past)
      expect(isFreshSupervisorFile(file, wall)).toBe(false)
      const same = new Date(wall)
      await utimes(file, same, same)
      expect(isFreshSupervisorFile(file, wall)).toBe(false)
      const future = new Date(wall + 5000)
      await utimes(file, future, future)
      expect(isFreshSupervisorFile(file, wall)).toBe(true)
      expect(isFreshSupervisorFile(join(root, "missing.json"), wall)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("healthy detach reports started: with exit 0 (freshness gate passes live writes)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: sleep 30\n", "utf8")
      const out: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "))
      }
      let code = -1
      try {
        code = await run(["up", "-d", "--file", file])
      } finally {
        console.log = origLog
      }
      expect(code).toBe(0)
      expect(out.join("\n")).toContain("started:")
    } finally {
      try {
        await run(["down", "--file", join(root, "ow.yaml"), "--rm"])
      } catch {
        // cleanup best-effort; rm below reaps the temp dir regardless
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
