import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { parseUpFile } from "./up-schema"
import {
  completeRequest,
  parseRequestFileName,
  requestFileName,
  scanRequests,
  sweepStaleResults,
  waitResult,
  writeRequest,
} from "./up-requests"
import { diffService, formatDrift, maskCmdShape, reconcileOne, runReconcileCheck } from "./up-reconcile"
import { mergePreservingSettled, processServiceRequest, runSupervised, type LiveUnit } from "./up-supervisor"
import { ensureUpStateDir, isLivePid, readLstart, readSupervisorState, upPaths } from "./up-state"

const owned: { kill: (signal?: string) => void }[] = []

afterEach(async () => {
  for (const proc of owned.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
  delete process.env.OW_REQUEST_WAIT_MS
})

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m1-"))

const spawnSleep = (seconds = 30): { pid: number; kill: (signal?: string) => void } => {
  const proc = Bun.spawn(["sleep", String(seconds)], { stdout: "ignore", stderr: "ignore" })
  owned.push(proc)
  return proc
}

const captureIo = (): { logs: string[]; errors: string[]; restore: () => void } => {
  const logs: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "))
  }
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "))
  }
  return { logs, errors, restore: () => {
    console.log = origLog
    console.error = origError
  } }
}

const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> => {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
}

describe("maskCmdShape (B3)", () => {
  test("masks key=value secrets, preserves the shape", () => {
    expect(maskCmdShape("deploy --env production TOKEN=hunter2 PORT=3000")).toBe("deploy --env production TOKEN=*** PORT=3000")
    expect(maskCmdShape("run --password hunter2 --verbose")).toBe("run --password *** --verbose")
    expect(maskCmdShape(["./app", "--token", "hunter2", "--port", "3000"])).toBe("./app --token *** --port 3000")
  })

  test("provider prefix and long hex are masked", () => {
    expect(maskCmdShape("curl -H Authorization: ghp_abcdef1234567890")).toBe("curl -H *** ***")
    expect(maskCmdShape("run deadbeefdeadbeefdeadbeefdeadbeef ok")).toBe("run *** ok")
  })

  test("a secret-free command stays as-is", () => {
    expect(maskCmdShape("sleep 30")).toBe("sleep 30")
    expect(maskCmdShape(["echo", "hi"])).toBe("echo hi")
    expect(maskCmdShape(undefined)).toBeUndefined()
  })

  test("the sentinel never appears in masked output", () => {
    const shapes = [
      maskCmdShape("deploy TOKEN=hunter2")!,
      maskCmdShape("run --password hunter2")!,
      maskCmdShape(["./app", "--api-key", "hunter2"])!,
      maskCmdShape("curl -H Authorization: Bearer hunter2")!,
    ]
    for (const shape of shapes) expect(shape).not.toContain("hunter2")
  })
})

describe("diffService", () => {
  test("an unrecorded service prints a to-start line (cmd masked)", () => {
    const { lines, diff } = diffService(parseUpFile("services:\n  api:\n    cmd: run --token hunter2\n    port: 3000\n").services[0], null)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("+ to-start: api")
    expect(lines[0]).not.toContain("hunter2")
    expect(diff).toMatchObject({ status: "missing", port: 3000 })
  })

  test("a recorded service prints a restart line", () => {
    const { lines } = diffService(parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0], {
      name: "api",
      pid: 4242,
      lstart: "Mon Oct  6 00:00:00 2026",
      startedAt: "t",
    })
    expect(lines[0]).toContain("restart: api pid=4242")
  })

  test("restart on an unrecorded service prints a restart-aware line (L-2)", () => {
    const svc = parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0]
    expect(diffService(svc, null, "restart").lines[0]).toContain("+ to-start (restart, no record): api")
    expect(diffService(svc, null).lines[0]).toContain("+ to-start: api")
  })
})

describe("mergePreservingSettled union (B1)", () => {
  test("on-disk-only services are preserved (drop-bug fix)", () => {
    const merged = mergePreservingSettled(
      [{ name: "old", pid: 9, lstart: "l", startedAt: "t" }],
      [{ name: "new", pid: 10, lstart: "m", startedAt: "t2" }],
    )
    expect(merged.map((svc) => svc.name).sort()).toEqual(["new", "old"])
  })

  test("on the same identity startedAt + settlement are preserved", () => {
    const merged = mergePreservingSettled(
      [{ name: "a", pid: 1, lstart: "x", startedAt: "first", exitCode: 3, exitedAt: "e" }],
      [{ name: "a", pid: 1, lstart: "x", startedAt: "stale" }],
    )
    expect(merged[0]).toMatchObject({ startedAt: "first", exitCode: 3, exitedAt: "e" })
  })

  test("on a new identity settlement is not revived, startedAt refreshes", () => {
    const merged = mergePreservingSettled(
      [{ name: "a", pid: 1, lstart: "x", startedAt: "first", exitCode: 3, exitedAt: "e" }],
      [{ name: "a", pid: 2, lstart: "y", startedAt: "respawned" }],
    )
    expect(merged[0]).toMatchObject({ pid: 2, startedAt: "respawned" })
    expect(merged[0].exitCode).toBeUndefined()
    expect(merged[0].exitedAt).toBeUndefined()
  })

  test("M-B: respawn does not inherit stale process records (lstartUnknown/logs/portConflict/env/depends)", () => {
    const prior = {
      name: "a",
      pid: 1,
      lstart: "x",
      startedAt: "first",
      lstartUnknown: true as const,
    }
    const merged = mergePreservingSettled([prior], [
      { name: "a", pid: 2, lstart: "y", startedAt: "respawned" },
    ])
    expect(merged[0].lstartUnknown).toBeUndefined()
    expect(merged[0].logsPid).toBeUndefined()
    expect(merged[0].logsLstart).toBeUndefined()
    expect(merged[0].portConflict).toBeUndefined()
    expect(merged[0].envNames).toBeUndefined()
    expect(merged[0].dependsOn).toBeUndefined()
  })

  test("M-B: on the same identity process records are preserved (control)", () => {
    const prior = {
      name: "a",
      pid: 1,
      lstart: "x",
      startedAt: "first",
      logsPid: 11,
      logsLstart: "tail",
      portConflict: true as const,
      envNames: ["A"],
      dependsOn: ["db"],
    }
    const merged = mergePreservingSettled([prior], [{ name: "a", pid: 1, lstart: "x", startedAt: "stale" }])
    expect(merged[0]).toMatchObject({ startedAt: "first", logsPid: 11, portConflict: true, envNames: ["A"], dependsOn: ["db"] })
  })

  test("L-3: an inherited raw cmd/logsCmd is re-masked (no sentinel)", () => {
    const merged = mergePreservingSettled(
      [{ name: "a", pid: 1, lstart: "x", startedAt: "first", cmd: "run --token hunter2", logsCmd: "tail API_KEY=hunter2" }],
      [{ name: "a", pid: 1, lstart: "x", startedAt: "stale" }],
    )
    expect(JSON.stringify(merged[0])).not.toContain("hunter2")
    expect(merged[0].cmd).toBe("run --token ***")
  })

  test("M-C: artifactDigests are preserved on the same identity, drop on respawn (no fake drift)", () => {
    const prior = {
      name: "a",
      pid: 1,
      lstart: "x",
      startedAt: "first",
      artifactDigests: { "api.jar": "a1b2c3d4e5" },
    }
    const same = mergePreservingSettled([prior], [{ name: "a", pid: 1, lstart: "x", startedAt: "new" }])
    expect(same[0].artifactDigests).toEqual({ "api.jar": "a1b2c3d4e5" })
    const respawned = mergePreservingSettled([prior], [{ name: "a", pid: 2, lstart: "y", startedAt: "respawned" }])
    expect(respawned[0].artifactDigests).toBeUndefined()
  })
})

describe("request/result contract", () => {
  test("atomic write + FIFO scan + result read/delete", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const nonce1 = await writeRequest(paths.requestsDir, "up", "a", join(root, "ow.yaml"))
      const nonce2 = await writeRequest(paths.requestsDir, "restart", "b", join(root, "ow.yaml"))
      // Deterministic FIFO: explicit mtimes (nonce order is random).
      const files = await scanRequests(paths.requestsDir)
      expect(files).toHaveLength(2)
      await utimes(join(paths.requestsDir, files[0].file), new Date(1000), new Date(1000))
      await utimes(join(paths.requestsDir, files[1].file), new Date(2000), new Date(2000))
      const ordered = await scanRequests(paths.requestsDir)
      expect(ordered[0].file).toBe(files[0].file)
      const target = ordered.find((entry) => entry.request.nonce === nonce1)!
      expect(target.request).toMatchObject({ action: "up", service: "a" })
      await completeRequest(paths.requestsDir, target.file, {
        action: "up",
        service: "a",
        nonce: nonce1,
        ok: true,
        code: "started",
        message: "started: a (pid 1)",
        pid: 1,
      })
      expect(existsSync(join(paths.requestsDir, target.file))).toBe(false)
      const result = await waitResult(paths.requestsDir, nonce1)
      expect(result).toMatchObject({ ok: true, code: "started", pid: 1 })
      expect(existsSync(join(paths.resultsDir, `${nonce1}.json`))).toBe(false)
      void nonce2
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an unanswered request returns null (the client yields exit 1)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      process.env.OW_REQUEST_WAIT_MS = "250"
      const started = Date.now()
      expect(await waitResult(paths.requestsDir, "missing-nonce")).toBeNull()
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("foreign file names are not scanned", () => {
    expect(parseRequestFileName("up-a.json")).toBeNull()
    expect(parseRequestFileName("../up-a.1.n.json")).toBeNull()
    expect(parseRequestFileName("up-a.1.n.json.bak")).toBeNull()
    expect(parseRequestFileName("delete-a.1.n.json")).toBeNull()
    expect(parseRequestFileName(requestFileName("up", "a", 12, "n1"))).toMatchObject({ action: "up", service: "a", pid: 12, nonce: "n1" })
  })

  test("L-1: best-effort deletes timeout leftovers + the TTL sweep collects old ones", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { mkdir } = await import("node:fs/promises")
      await mkdir(paths.resultsDir, { recursive: true, mode: 0o700 })
      // Corrupt result file: unreadable, deleted on timeout.
      await writeFile(join(paths.resultsDir, "corrupt-nonce.json"), "{{{corrupt", "utf8")
      process.env.OW_REQUEST_WAIT_MS = "250"
      expect(await waitResult(paths.requestsDir, "corrupt-nonce")).toBeNull()
      expect(existsSync(join(paths.resultsDir, "corrupt-nonce.json"))).toBe(false)
      // TTL sweep: old ones are collected, fresh ones remain.
      await writeFile(join(paths.resultsDir, "old-result.json"), "{}", "utf8")
      await writeFile(join(paths.resultsDir, "fresh-result.json"), "{}", "utf8")
      const old = new Date(Date.now() - 120_000)
      await utimes(join(paths.resultsDir, "old-result.json"), old, old)
      expect(await sweepStaleResults(paths.requestsDir)).toBe(1)
      expect(existsSync(join(paths.resultsDir, "old-result.json"))).toBe(false)
      expect(existsSync(join(paths.resultsDir, "fresh-result.json"))).toBe(true)
      expect(await sweepStaleResults(join(root, "missing-dir"))).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("reconcileOne (pure core)", () => {
  const base = { liveness: "live" as const, listening: undefined, portOwners: null as number[] | null }

  test("names missing/extra + suggests an explicit command", () => {
    const exp = parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0]
    expect(reconcileOne({ name: "api", expected: exp, running: null, ...base })).toMatchObject({
      kind: "missing",
      hint: "ow up api",
    })
    expect(
      reconcileOne({ name: "removed", expected: null, running: { name: "removed", pid: 1, lstart: "l", startedAt: "t" }, ...base }),
    ).toMatchObject({ kind: "extra", hint: "ow down removed" })
  })

  test("stopped/lstart-mismatch", () => {
    const exp = parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0]
    const run = { name: "api", pid: 1, lstart: "l", startedAt: "t" }
    expect(reconcileOne({ name: "api", expected: exp, running: { ...run, exitCode: 1 }, ...base })).toMatchObject({ kind: "stopped" })
    expect(reconcileOne({ name: "api", expected: exp, running: run, ...base, liveness: "dead" })).toMatchObject({ kind: "stopped" })
    expect(reconcileOne({ name: "api", expected: exp, running: run, ...base, liveness: "lstart-mismatch" })).toMatchObject({
      kind: "lstart-mismatch",
    })
  })

  test("config-mismatch: cmd-shape/cwd/port/env-names/depends_on", () => {
    const services = parseUpFile(
      "services:\n  api:\n    cmd: sleep 60\n    cwd: .\n    port: 3001\n    env: {A: b}\n    depends_on: [db]\n  db:\n    cmd: sleep 30\n",
    ).services
    const exp = services.find((svc) => svc.name === "api")!
    const run = {
      name: "api",
      pid: 1,
      lstart: "l",
      startedAt: "t",
      cmd: "sleep 30",
      cwd: ".",
      port: 3001,
      envNames: ["A"],
      dependsOn: ["db"],
    }
    const drift = reconcileOne({ name: "api", expected: exp, running: run, ...base })
    expect(drift?.kind).toBe("config-mismatch")
    expect(Object.keys(drift?.expected ?? {})).toContain("cmd")
    const same = reconcileOne({
      name: "api",
      expected: exp,
      running: { ...run, cmd: "sleep 60" },
      ...base,
    })
    expect(same).toBeNull()
  })

  test("foreign-port: a listener exists but we are not the owner (no kill, report)", () => {
    const exp = parseUpFile("services:\n  api:\n    cmd: sleep 30\n    port: 3000\n").services[0]
    const drift = reconcileOne({
      name: "api",
      expected: exp,
      running: { name: "api", pid: 111, lstart: "l", startedAt: "t", port: 3000 },
      liveness: "live",
      listening: true,
      portOwners: [99999],
    })
    expect(drift).toMatchObject({ kind: "foreign-port" })
  })

  test("a matching record returns null", () => {
    const exp = parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0]
    expect(
      reconcileOne({ name: "api", expected: exp, running: { name: "api", pid: 1, lstart: "l", startedAt: "t", cmd: "sleep 30" }, ...base }),
    ).toBeNull()
  })
})

describe("CLI usage exits (exit 2/1)", () => {
  const fixture = async (): Promise<{ root: string; file: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n  b:\n    cmd: sleep 30\n", "utf8")
    return { root, file }
  }

  test("down <svc> --rm exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = captureIo()
      try {
        expect(await run(["down", "a", "--file", file, "--rm"])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.errors.join("\n")).toContain("--rm")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("restart without a lock exits 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = captureIo()
      try {
        expect(await run(["restart", "a", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.errors.join("\n")).toContain("run `ow up` first")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("restart without a positional argument exits 2", async () => {
    const { root, file } = await fixture()
    try {
      expect(await run(["restart", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown service exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = captureIo()
      try {
        expect(await run(["up", "missing", "--file", file])).toBe(2)
      } finally {
        io.restore()
      }
      expect(io.errors.join("\n")).toContain("unknown service")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reconcile without a flag exits 2; --probe opens the unflag-probe path (M3)", async () => {
    const { root, file } = await fixture()
    try {
      expect(await run(["reconcile", "--file", file])).toBe(2)
      // With undefined services the probe path ends with an empty measurement: drift exists → exit 1.
      const io = captureIo()
      let code = -1
      try {
        code = await run(["reconcile", "--check", "--probe", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.logs.join("\n")).toContain("missing: a → ow up a")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fail-loud: --probe outside the witness verbs exits 2 (never silently ignored)", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const cases: string[][] = [
        ["up", "--check", "--file", file, "--probe"],
        ["up", "a", "--file", file, "--probe"],
        ["down", "--file", file, "--probe"],
        ["down", "a", "--file", file, "--probe"],
        ["ps", "--file", file, "--probe"],
        ["logs", "--file", file, "--probe"],
      ]
      for (const args of cases) {
        const io = captureIo()
        let code = -1
        try {
          code = await run(args)
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toBe(`${args.join(" ")} → 2`)
        expect(io.errors.join("\n")).toContain("--probe works only with reconcile, preflight, readiness, provision")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("down <svc> without a lock stops the target, does not delete the lock or supervisor.json", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = (await readLstart(sleeper.pid))!
      await writeFile(paths.lockFile, JSON.stringify({ pid: 987654321, lstart: "bogus", startedAt: new Date().toISOString() }), "utf8")
      const lockBefore = await readFile(paths.lockFile, "utf8")
      const { writeSupervisorState } = await import("./up-state")
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "a", pid: sleeper.pid, lstart, startedAt: new Date().toISOString() }],
      })
      const io = captureIo()
      let code = -1
      try {
        code = await run(["down", "a", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.logs.join("\n")).toContain("stopped: a")
      expect(await readFile(paths.lockFile, "utf8")).toBe(lockBefore)
      expect(existsSync(paths.supervisorFile)).toBe(true)
      expect(await isLivePid(sleeper.pid, lstart)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lstartUnknown down <svc> refuses exit 1, does not touch the process", async () => {
    const { root, file } = await fixture()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const real = (await readLstart(sleeper.pid))!
      const { writeSupervisorState } = await import("./up-state")
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "a", pid: sleeper.pid, lstart: "", startedAt: new Date().toISOString() }],
      })
      const io = captureIo()
      let code = -1
      try {
        code = await run(["down", "a", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(await isLivePid(sleeper.pid, real)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("live supervisor single-service flow", () => {
  const twoService = "services:\n  a:\n    cmd: sleep 30\n  b:\n    cmd: sleep 30\n"

  const startLive = async (): Promise<{ root: string; file: string; stop: () => void; done: Promise<number> }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, twoService, "utf8")
    const paths = upPaths(root)
    await ensureUpStateDir(paths.stateDir)
    // Live-lock marker so the client takes the request channel (a helper
    // sleeper stands in for the supervisor pid; the real executor is the
    // in-process runSupervised loop below).
    const keeper = spawnSleep(60)
    const keeperLstart = (await readLstart(keeper.pid))!
    await writeFile(paths.lockFile, JSON.stringify({ pid: keeper.pid, lstart: keeperLstart, startedAt: new Date().toISOString() }), "utf8")
    let stopFlag = false
    const done = runSupervised(parseUpFile(twoService).services, {
      rootDir: root,
      stateFile: paths.supervisorFile,
      requestsDir: paths.requestsDir,
      owFile: file,
      onLine: () => undefined,
      shouldStop: () => stopFlag,
    })
    await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 2)
    return { root, file, stop: () => {
      stopFlag = true
    }, done }
  }

  test("during restart b, a's pid/lstart stay fixed, b's pid changes", async () => {
    const live = await startLive()
    try {
      const paths = upPaths(live.root)
      const before = (await readSupervisorState(paths.supervisorFile))!
      const io = captureIo()
      let code = -1
      try {
        code = await run(["restart", "b", "--file", live.file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.logs.join("\n")).toContain("restarted: b")
      await waitFor(async () => {
        const state = await readSupervisorState(paths.supervisorFile)
        return state?.services.find((svc) => svc.name === "b")?.pid !== before.services.find((svc) => svc.name === "b")?.pid
      })
      const after = (await readSupervisorState(paths.supervisorFile))!
      const aBefore = before.services.find((svc) => svc.name === "a")!
      const aAfter = after.services.find((svc) => svc.name === "a")!
      expect(aAfter.pid).toBe(aBefore.pid)
      expect(aAfter.lstart).toBe(aBefore.lstart)
      expect(aAfter.exitCode).toBeUndefined()
      const bAfter = after.services.find((svc) => svc.name === "b")!
      expect(bAfter.exitCode).toBeUndefined()
      expect(await isLivePid(aAfter.pid, aAfter.lstart)).toBe(true)
      expect(await isLivePid(bAfter.pid, bAfter.lstart)).toBe(true)
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("up <new> is added live, already-running exits 2", async () => {
    const live = await startLive()
    try {
      const paths = upPaths(live.root)
      await writeFile(live.file, `${twoService}  c:\n    cmd: sleep 30\n`, "utf8")
      const io = captureIo()
      try {
        expect(await run(["up", "c", "--file", live.file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.logs.join("\n")).toContain("to-start: c")
      await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 3)
      const io2 = captureIo()
      try {
        expect(await run(["up", "a", "--file", live.file])).toBe(2)
      } finally {
        io2.restore()
      }
      expect(io2.errors.join("\n")).toContain("already running: a")
      expect((await readSupervisorState(paths.supervisorFile))?.services).toHaveLength(3)
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("down <svc> live stops only the target", async () => {
    const live = await startLive()
    try {
      const paths = upPaths(live.root)
      const io = captureIo()
      try {
        expect(await run(["down", "b", "--file", live.file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.logs.join("\n")).toContain("to-stop: b")
      await waitFor(async () => {
        const state = await readSupervisorState(paths.supervisorFile)
        const b = state?.services.find((svc) => svc.name === "b")
        return b !== undefined && !(await isLivePid(b.pid, b.lstart))
      })
      const state = (await readSupervisorState(paths.supervisorFile))!
      const a = state.services.find((svc) => svc.name === "a")!
      expect(await isLivePid(a.pid, a.lstart)).toBe(true)
      expect(existsSync(paths.lockFile)).toBe(true)
      expect(existsSync(paths.supervisorFile)).toBe(true)
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("down <svc> live --json carries additive post-stop confirmation (pre diff intact)", async () => {
    const live = await startLive()
    try {
      const io = captureIo()
      let code = -1
      try {
        code = await run(["down", "b", "--json", "--file", live.file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const payload = JSON.parse(io.logs.join("\n")) as Record<string, unknown>
      expect(payload).toMatchObject({ service: "b", action: "down", diff: { status: "running" } })
      expect(payload["confirmed"]).toEqual({ stopped: true, code: "stopped" })
      // A second down confirms already-stopped distinctly (same additive key).
      const io2 = captureIo()
      try {
        code = await run(["down", "b", "--json", "--file", live.file])
      } finally {
        io2.restore()
      }
      expect(code).toBe(0)
      expect((JSON.parse(io2.logs.join("\n")) as Record<string, unknown>)["confirmed"]).toEqual({
        stopped: true,
        code: "already-stopped",
      })
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("down <svc> live human output points at the ps follow-up reader", async () => {
    const live = await startLive()
    try {
      const io = captureIo()
      try {
        expect(await run(["down", "b", "--file", live.file])).toBe(0)
      } finally {
        io.restore()
      }
      const out = io.logs.join("\n")
      expect(out).toContain("to-stop: b")
      expect(out).toContain("stopped: b")
      expect(out).toContain("follow-up: ow ps b (confirm state)")
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("reconcile sync exit 0, service-removal extra exit 1 (no stop)", async () => {
    const live = await startLive()
    try {
      expect(await run(["reconcile", "--check", "--file", live.file])).toBe(0)
      const io = captureIo()
      let code = -1
      try {
        code = await run(["reconcile", "--check", "--json", "--file", live.file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(JSON.parse(io.logs.join("\n")).reconcile).toMatchObject({ inSync: true, drifts: [] })
      // Remove b from the definition: `extra`, nothing is stopped.
      await writeFile(live.file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const io2 = captureIo()
      try {
        code = await run(["reconcile", "--check", "--file", live.file])
      } finally {
        io2.restore()
      }
      expect(code).toBe(1)
      expect(io2.logs.join("\n")).toContain("extra: b → ow down b")
      const paths = upPaths(live.root)
      const b = (await readSupervisorState(paths.supervisorFile))!.services.find((svc) => svc.name === "b")!
      expect(await isLivePid(b.pid, b.lstart)).toBe(true)
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("M-A: blind unit up => already-running, no spawn, slot preserved", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  x:\n    cmd: sleep 30\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      owned.push(proc)
      const main = { service: { name: "x", cmd: "sleep 30" }, proc, lstart: "", startedAt: new Date().toISOString(), exit: null }
      const unit: LiveUnit = { svc: { name: "x", cmd: "sleep 30" }, main, tail: undefined }
      const children = [main]
      let spawned = 0
      const result = await processServiceRequest(
        {
          rootDir: root,
          owFile: file,
          units: [unit],
          children,
          tails: [],
          retiring: new Set(),
          spawnUnit: async () => {
            spawned += 1
          },
          persist: async () => undefined,
        },
        { action: "up", service: "x", nonce: "n-blind", pid: 1, at: new Date().toISOString(), file },
      )
      expect(result.ok).toBe(false)
      expect(result.code).toBe("already-running")
      expect(result.message).toContain("lstart unknown")
      expect(spawned).toBe(0)
      expect(unit.main).toBe(main)
      expect(children).toHaveLength(1)
      expect((await readLstart(proc.pid)) === null).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lstartUnknown restart refuses: no signal, the process survives", async () => {    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  x:\n    cmd: sleep 30\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      owned.push(proc)
      const unit: LiveUnit = {
        svc: { name: "x", cmd: "sleep 30" },
        main: { service: { name: "x", cmd: "sleep 30" }, proc, lstart: "", startedAt: new Date().toISOString(), exit: null },
        tail: undefined,
      }
      const result = await processServiceRequest(
        {
          rootDir: root,
          owFile: file,
          units: [unit],
          children: [],
          tails: [],
          retiring: new Set(),
          spawnUnit: async () => {
            throw new Error("must not spawn")
          },
          persist: async () => undefined,
        },
        { action: "restart", service: "x", nonce: "n1", pid: 1, at: new Date().toISOString(), file },
      )
      expect(result.ok).toBe(false)
      expect(result.code).toBe("refused")
      expect((await readLstart(proc.pid)) === null).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("state contains no secret (cmd masked shape, no sentinel)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const code = await runSupervised([{ name: "hidden", cmd: "true --token hunter2" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine: () => undefined,
      })
      expect(code).toBe(0)
      const raw = await readFile(paths.supervisorFile, "utf8")
      expect(raw).not.toContain("hunter2")
      const state = (await readSupervisorState(paths.supervisorFile))!
      expect(state.services[0].cmd).toBe("true --token ***")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("runReconcileCheck exits", () => {
  test("without state the expected are missing (exit 1)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await runReconcileCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.logs.join("\n")).toContain("missing: a → ow up a")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-C artifact-stale core (pure)", () => {
  const liveBase = { liveness: "live" as const, listening: undefined, portOwners: null as number[] | null }

  const exp = () => parseUpFile("services:\n  api:\n    cmd: sleep 30\n").services[0]
  const run = { name: "api", pid: 1, lstart: "l", startedAt: "t", cmd: "sleep 30" }

  test("mismatch → artifact-stale (locked template)", () => {
    const drift = reconcileOne({
      name: "api",
      expected: exp(),
      running: run,
      ...liveBase,
      artifacts: { declared: { "api.jar": "a1b2c3d4e5" }, recorded: { "api.jar": "ffffffffff" } },
    })
    expect(drift?.kind).toBe("artifact-stale")
    expect(drift).toMatchObject({ service: "api", expected: { artifact: "api.jar" }, hint: "rebuild + ow restart api" })
    expect(formatDrift(drift!)).toBe("stale-build: api (api.jar changed) → rebuild + ow restart api")
    // The full digest is absent from the line (reduced wire).
    expect(JSON.stringify(drift)).not.toContain("a1b2c3d4e5")
    expect(JSON.stringify(drift)).not.toContain("ffffffffff")
  })

  test("a match + no record produce no drift (recording is the caller's job)", () => {
    const same = reconcileOne({
      name: "api",
      expected: exp(),
      running: run,
      ...liveBase,
      artifacts: { declared: { "api.jar": "a1b2c3d4e5" }, recorded: { "api.jar": "a1b2c3d4e5" } },
    })
    expect(same).toBeNull()
    const unrecorded = reconcileOne({
      name: "api",
      expected: exp(),
      running: run,
      ...liveBase,
      artifacts: { declared: { "api.jar": "a1b2c3d4e5" }, recorded: {} },
    })
    expect(unrecorded).toBeNull()
  })

  test("input with no map keeps the old behavior (null, foreign-port order preserved)", () => {
    expect(reconcileOne({ name: "api", expected: exp(), running: run, ...liveBase })).toBeNull()
  })
})

describe("M-C live record-observation + drift (real request channel)", () => {
  const probedService = "services:\n  api:\n    cmd: sleep 30\n    readiness: {probe: [./ready.sh], timeout: 10s, needsPort: false}\n"

  const startProbedLive = async (): Promise<{ root: string; file: string; stop: () => void; done: Promise<number> }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, probedService, "utf8")
    const paths = upPaths(root)
    await ensureUpStateDir(paths.stateDir)
    const keeper = spawnSleep(60)
    const keeperLstart = (await readLstart(keeper.pid))!
    await writeFile(paths.lockFile, JSON.stringify({ pid: keeper.pid, lstart: keeperLstart, startedAt: new Date().toISOString() }), "utf8")
    let stopFlag = false
    const done = runSupervised(parseUpFile(probedService).services, {
      rootDir: root,
      stateFile: paths.supervisorFile,
      requestsDir: paths.requestsDir,
      owFile: file,
      onLine: () => undefined,
      shouldStop: () => stopFlag,
    })
    await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 1)
    return { root, file, stop: () => {
      stopFlag = true
    }, done }
  }

  const fakeProbe = (checks: { name: string; ok: boolean; path?: string; digest?: string }[]) => async () => ({
    ok: true,
    note: "ready",
    checks,
    timedOut: false,
    code: 0,
  })

  const DIGEST_1 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
  const DIGEST_2 = "ffffffffffffffffffffffffffffffffffffffff"

  test("record-observation: first round no drift + raw record, second round a single stale-build", async () => {
    const live = await startProbedLive()
    try {
      const io = captureIo()
      let code = -1
      try {
        code = await runReconcileCheck({
          rootDir: live.root,
          file: live.file,
          json: false,
          probe: true,
          runProbeFn: fakeProbe([{ name: "mod", ok: true, path: "/opt/svc/api.jar", digest: DIGEST_1 }]),
        })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.logs.join("\n")).not.toContain("stale-build")
      // Record-observation: a basename key + raw digest in the state file (sole-writer supervisor).
      await waitFor(async () =>
        (await readSupervisorState(upPaths(live.root).supervisorFile))?.services.find((svc) => svc.name === "api")?.artifactDigests?.["api.jar"] === DIGEST_1,
      )
      // Second round: the digest changed → a single locked drift line, exit 1; no full path/full digest in the line.
      const io2 = captureIo()
      let code2 = -1
      try {
        code2 = await runReconcileCheck({
          rootDir: live.root,
          file: live.file,
          json: false,
          probe: true,
          runProbeFn: fakeProbe([{ name: "mod", ok: true, path: "/opt/svc/api.jar", digest: DIGEST_2 }]),
        })
      } finally {
        io2.restore()
      }
      expect(code2).toBe(1)
      const out = io2.logs.join("\n")
      expect(out).toContain("stale-build: api (api.jar changed) → rebuild + ow restart api")
      expect(out).not.toContain(DIGEST_1)
      expect(out).not.toContain(DIGEST_2)
      expect(out).not.toContain("/opt/svc")
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("--json additive keys (reduced short-8, no raw)", async () => {
    const live = await startProbedLive()
    try {
      const runCheck = (digest: string, json: boolean) => {
        const io = captureIo()
        return (async () => {
          try {
            return {
              code: await runReconcileCheck({
                rootDir: live.root,
                file: live.file,
                json,
                probe: true,
                runProbeFn: fakeProbe([{ name: "mod", ok: true, path: "/opt/svc/api.jar", digest }]),
              }),
              out: io.logs.join("\n"),
            }
          } finally {
            io.restore()
          }
        })()
      }
      await runCheck(DIGEST_1, false)
      await waitFor(async () =>
        (await readSupervisorState(upPaths(live.root).supervisorFile))?.services.find((svc) => svc.name === "api")?.artifactDigests?.["api.jar"] === DIGEST_1,
      )
      const second = await runCheck(DIGEST_2, true)
      expect(second.code).toBe(1)
      expect(second.out).not.toContain(DIGEST_1)
      expect(second.out).not.toContain(DIGEST_2)
      const payload = JSON.parse(second.out) as {
        artifactDigests: Record<string, Record<string, string>>
        artifactStale: { service: string; artifact: string }[]
      }
      expect(payload.artifactDigests).toEqual({ api: { "api.jar": DIGEST_1.slice(0, 8) } })
      expect(payload.artifactStale).toEqual([{ service: "api", artifact: "api.jar" }])
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })

  test("hostile path: no absolute path leaks (record + human + wire basename)", async () => {
    const live = await startProbedLive()
    try {
      const io = captureIo()
      try {
        await runReconcileCheck({
          rootDir: live.root,
          file: live.file,
          json: false,
          probe: true,
          runProbeFn: fakeProbe([{ name: "h", ok: true, path: "/etc/shadow/hidden.jar", digest: DIGEST_1 }]),
        })
      } finally {
        io.restore()
      }
      const out = io.logs.join("\n")
      expect(out).not.toContain("/etc/shadow")
      await waitFor(async () =>
        (await readSupervisorState(upPaths(live.root).supervisorFile))?.services.find((svc) => svc.name === "api")?.artifactDigests?.["hidden.jar"] === DIGEST_1,
      )
      const state = (await readSupervisorState(upPaths(live.root).supervisorFile))!
      expect(JSON.stringify(state.services.find((svc) => svc.name === "api")?.artifactDigests)).not.toContain("/etc/shadow")
    } finally {
      live.stop()
      await live.done
      await rm(live.root, { recursive: true, force: true })
    }
  })
})

describe("G11 revision-stale advisory rides readiness lines (display-only)", () => {
  test("recorded rev != live rev appends (revision-stale) without changing exit", async () => {
    const gitCheck = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" })
    await gitCheck.exited
    if (gitCheck.exitCode !== 0) {
      console.log("skipped: git unavailable")
      return
    }
    const root = await tempRoot()
    let stop = false
    let done: Promise<number> | null = null
    try {
      const git = async (args: string[]): Promise<void> => {
        const proc = Bun.spawn(["git", ...args], {
          cwd: root,
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root },
        })
        await proc.exited
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
      }
      await git(["init", "-q"])
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  api:\n    cmd: sleep 30\n    readiness: {probe: [./ready.sh], timeout: 10s, needsPort: false}\n", "utf8")
      await writeFile(join(root, "v.txt"), "v1\n", "utf8")
      await git(["add", "-A"])
      await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev1"])
      const { upPaths, ensureUpStateDir, readSupervisorState } = await import("./up-state")
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      done = runSupervised([{ name: "api", cmd: "sleep 30" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine: () => undefined,
        shouldStop: () => stop,
      })
      await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 1)
      await writeFile(join(root, "v.txt"), "v2\n", "utf8")
      await git(["add", "-A"])
      await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev2"])
      const io = captureIo()
      let code = -1
      try {
        code = await runReconcileCheck({
          rootDir: root,
          file,
          json: false,
          probe: true,
          runProbeFn: async () => ({ ok: true, note: "fake-ready", checks: [], timedOut: false, code: 0 }),
        })
      } finally {
        io.restore()
      }
      expect(io.logs.join("\n")).toContain("(revision-stale)")
    } finally {
      stop = true
      if (done !== null) await done.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
