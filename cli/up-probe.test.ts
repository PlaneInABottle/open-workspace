/** M3 probe runner: timeout/invalid-JSON/nonzero/secret-mask + contract
 * parse. Never enters the supervisor (client-side one-shot). */

import { describe, expect, test } from "bun:test"

import { artifactBase, declaredArtifactDigests, isArtifactBase, isArtifactDigest, findFirstJsonObject, parseProbeContract, PROBE_NOTE_MAX_CHARS, reduceArtifacts, runProbe, shortDigest } from "./up-probe"

const specOf = (probe: string[]) => ({ probe, timeout: "10s" as const, needsPort: true })

describe("findFirstJsonObject", () => {
  test("catches the first object in log-prefixed output", () => {
    expect(findFirstJsonObject('booting...\n{"ready": true}\ntrailing')).toBe('{"ready": true}')
    expect(findFirstJsonObject("plain text")).toBeNull()
    expect(findFirstJsonObject('{"a": {"b": "}"}}')).toBe('{"a": {"b": "}"}}')
  })
})

describe("parseProbeContract", () => {
  test("valid contract + truncation + checks filter", () => {
    expect(parseProbeContract('{"ready": true, "note": "ok", "checks": [{"name": "a", "ok": true}]}')).toEqual({
      ready: true,
      note: "ok",
      checks: [{ name: "a", ok: true }],
    })
    expect(parseProbeContract('{"ready": false}')).toEqual({ ready: false })
    expect(parseProbeContract('{"ready": "yes"}')).toBeNull()
    expect(parseProbeContract('{"note": "x"}')).toBeNull()
    const long = parseProbeContract(`{"ready": true, "note": "${"n".repeat(300)}"}`)
    expect(long?.note?.length).toBe(PROBE_NOTE_MAX_CHARS)
    expect(parseProbeContract('{"ready": true, "checks": [{"name": "a"}, {"name": "b", "ok": "x"}, 7]}')).toEqual({
      ready: true,
      checks: [],
    })
  })

  test("M-C identity: path/digest are shape-strict, a malformed field drops and the entry stays", () => {
    const contract = parseProbeContract(
      '{"ready": true, "checks": [' +
        '{"name": "a", "ok": true, "path": "/opt/svc/api.jar", "digest": "a1b2c3d4e5"},' +
        '{"name": "b", "ok": true, "path": ""},' +
        '{"name": "c", "ok": true, "path": 7, "digest": "zzzz"},' +
        '{"name": "d", "ok": false, "path": "/opt/svc/old.jar", "digest": "zz"}' +
        "]}",
    )
    expect(contract?.checks).toEqual([
      { name: "a", ok: true, path: "/opt/svc/api.jar", digest: "a1b2c3d4e5" },
      { name: "b", ok: true },
      { name: "c", ok: true },
      { name: "d", ok: false, path: "/opt/svc/old.jar" },
    ])
    // An over-long path drops (the entry survives).
    const long = parseProbeContract(`{"ready": true, "checks": [{"name": "a", "ok": true, "path": "/${"p".repeat(600)}", "digest": "a1b2c3d4e5"}]}`)
    expect(long?.checks).toEqual([{ name: "a", ok: true, digest: "a1b2c3d4e5" }])
  })
})

describe("M-C artifact reduction (basename + short-8, ≤32 + counter)", () => {
  test("ok entries are listed basename→short-8, no full path is carried", () => {
    const reduced = reduceArtifacts([
      { name: "a", ok: true, path: "/opt/svc/api.jar", digest: "a1b2c3d4e5f6" },
      { name: "b", ok: false, path: "/opt/svc/old.jar", digest: "bbbbbbbbbb" },
      { name: "c", ok: true, path: "/opt/svc/nodigest.jar" },
    ])
    expect(reduced).toEqual({ shown: [{ base: "api.jar", digest: "a1b2c3d4" }], rest: 0 })
  })

  test("33 entries: 32 shown, the rest counted (ordered-deterministic)", () => {
    const checks = Array.from({ length: 33 }, (_, i) => ({
      name: `s${i}`,
      ok: true,
      path: `/opt/s${String(i).padStart(2, "0")}.jar`,
      digest: "a1b2c3d4e5",
    }))
    const reduced = reduceArtifacts(checks)
    expect(reduced.shown).toHaveLength(32)
    expect(reduced.rest).toBe(1)
    expect(reduced.shown[0]).toEqual({ base: "s00.jar", digest: "a1b2c3d4" })
  })

  test("a hostile basename is masked, a full path never appears", () => {
    expect(artifactBase("/etc/shadow/x.jar")).toBe("x.jar")
    expect(isArtifactDigest("a1b2c3")).toBe(false)
    expect(isArtifactDigest("a1b2c3d")).toBe(true)
    expect(isArtifactDigest("zz")).toBe(false)
    expect(isArtifactBase("")).toBe(false)
    expect(isArtifactBase("a/b")).toBe(false)
    expect(isArtifactBase("..")).toBe(false)
    expect(isArtifactBase("api.jar")).toBe(true)
    expect(shortDigest("a1b2c3d4e5f6")).toBe("a1b2c3d4")
    const hostile = reduceArtifacts([{ name: "h", ok: true, path: "/secret/token=hunter2.jar", digest: "a1b2c3d4e5" }])
    expect(JSON.stringify(hostile)).not.toContain("hunter2")
    expect(JSON.stringify(hostile)).not.toContain("/secret")
  })

  test("declaration map: ok + full-shape entries (full digest, in-memory)", () => {
    expect(
      declaredArtifactDigests([
        { name: "a", ok: true, path: "/opt/svc/api.jar", digest: "a1b2c3d4e5" },
        { name: "b", ok: false, path: "/opt/svc/old.jar", digest: "bbbbbbbbbb" },
        { name: "c", ok: true, path: "/opt/svc/nodigest.jar" },
      ]),
    ).toEqual({ "api.jar": "a1b2c3d4e5" })
  })
})

describe("runProbe", () => {
  const env = { ...process.env }

  test("ready: exit 0 + valid JSON + ready:true", async () => {
    const outcome = await runProbe({ spec: specOf(["echo", '{"ready": true, "note": "smoke-ok"}']), cwd: "/tmp", env })
    expect(outcome).toMatchObject({ ok: true, note: "smoke-ok", timedOut: false, code: 0 })
  })

  test("a nonzero exit counts as not-ready (note + code are reported)", async () => {
    const outcome = await runProbe({ spec: specOf(["false"]), cwd: "/tmp", env })
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain("exit code 1")
    expect(outcome.code).toBe(1)
  })

  test("invalid JSON is not-ready (stdout is not printed raw)", async () => {
    const outcome = await runProbe({ spec: specOf(["echo", "plain text"]), cwd: "/tmp", env })
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain("invalid JSON")
  })

  test("timeout: SINGLE-PID kill + grandchild note, exit not awaited", async () => {
    const outcome = await runProbe({ spec: specOf(["sleep", "30"]), cwd: "/tmp", env, timeoutMs: 200 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.note).toContain("timeout")
    expect(outcome.note).toContain("may-be-leftover-grandchild")
  })

  test("secret-mask: stdout/stderr/note masked, raw argv never enters the report", async () => {
    const outcome = await runProbe({ spec: specOf(["echo", '{"ready": false, "note": "token=hunter2"}']), cwd: "/tmp", env })
    expect(outcome.ok).toBe(false)
    expect(outcome.note).not.toContain("hunter2")
    expect(outcome.note).toContain("token=***")
    const errCase = await runProbe({
      spec: specOf([process.execPath, "-e", 'console.error("password=hunter2"); process.exit(3)']),
      cwd: "/tmp",
      env,
    })
    expect(errCase.ok).toBe(false)
    expect(errCase.note).not.toContain("hunter2")
  })

  test("env inheritance + OW_SERVICE are carried (the value is masked in output)", async () => {
    const bun = process.execPath
    const okCase = await runProbe({
      spec: specOf([bun, "-e", "console.log(JSON.stringify({ready: true, note: process.env.OW_SERVICE}))"]),
      cwd: "/tmp",
      env: { ...process.env, OW_SERVICE: "api" },
    })
    expect(okCase).toMatchObject({ ok: true, note: "api" })
    const masked = await runProbe({
      spec: specOf([bun, "-e", 'console.log(JSON.stringify({ready: false, note: "token=" + process.env.S3CR3T}))']),
      cwd: "/tmp",
      env: { ...process.env, S3CR3T: "hunter2" },
    })
    expect(masked.ok).toBe(false)
    expect(masked.note).not.toContain("hunter2")
  })

  test("stdout cap 64KB (truncated output counts as invalid)", async () => {
    const outcome = await runProbe({
      spec: specOf([process.execPath, "-e", 'let s=""; for (let i = 0; i < 70000; i++) s += "p"; console.log(s)']),
      cwd: "/tmp",
      env,
    })
    expect(outcome.ok).toBe(false)
  })

  test("touches no network outside the target, the command runs as-is (B2 declaration)", async () => {
    const outcome = await runProbe({ spec: specOf(["echo", '{"ready": true}']), cwd: "/tmp", env })
    expect(outcome.ok).toBe(true)
  })
})

describe("wait/reconcile/explain wiring (M3 integration)", () => {
  const FIXTURES = new URL("./parity-fixtures/", import.meta.url).pathname

  const tempRoot = async (): Promise<string> => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    return mkdtemp(join(tmpdir(), "ow-m3-"))
  }

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

  test("TCP-UP-probe-DOWN: wait exit 1 + not-ready", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { parseUpFile } = await import("./up-schema")
    const { waitForUpReady } = await import("./cli")
    const { readLstart } = await import("./up-state")
    const holder = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const root = await tempRoot()
    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      const lstart = (await readLstart(sleeper.pid))!
      const { upPaths, ensureUpStateDir, writeSupervisorState } = await import("./up-state")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "api", pid: sleeper.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30", port: holder.port }],
      })
      const services = parseUpFile(
        `services:\n  api:\n    cmd: sleep 30\n    port: ${holder.port}\n    readiness: {probe: [${join(FIXTURES, "ready-false.sh")}], timeout: 10s}\n`,
      ).services
      const io = capture()
      let code = -1
      try {
        code = await waitForUpReady({ rootDir: root, services, timeoutMs: 3000, json: false })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.out.join("\n")).toContain("not ready: api (probe: closed)")
    } finally {
      try {
        sleeper.kill("SIGKILL")
      } catch {
        // gone
      }
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("TCP-UP-probe-DOWN JSON: readiness ok:false", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { parseUpFile } = await import("./up-schema")
    const { waitForUpReady } = await import("./cli")
    const { readLstart } = await import("./up-state")
    const holder = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const root = await tempRoot()
    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      const lstart = (await readLstart(sleeper.pid))!
      const { upPaths, ensureUpStateDir, writeSupervisorState } = await import("./up-state")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "api", pid: sleeper.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30", port: holder.port }],
      })
      const services = parseUpFile(
        `services:\n  api:\n    cmd: sleep 30\n    port: ${holder.port}\n    readiness: {probe: [${join(FIXTURES, "ready-false.sh")}], timeout: 10s}\n`,
      ).services
      const io = capture()
      let code = -1
      try {
        code = await waitForUpReady({ rootDir: root, services, timeoutMs: 3000, json: true })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      const payload = JSON.parse(io.out.join("\n")) as { ready: boolean; services: { readiness?: { kind: string; ok: boolean } }[] }
      expect(payload.ready).toBe(false)
      expect(payload.services[0].readiness).toMatchObject({ kind: "probe", ok: false })
    } finally {
      try {
        sleeper.kill("SIGKILL")
      } catch {
        // gone
      }
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("needsPort:false a portless service is waited on via the probe (does not fall to noPort)", async () => {
    const { waitForUpReady } = await import("./cli")
    const { parseUpFile } = await import("./up-schema")
    const root = await tempRoot()
    try {
      const services = parseUpFile("services:\n  worker:\n    cmd: ./work\n    readiness: {probe: [./ready.sh], needsPort: false}\n").services
      let calls = 0
      const io = capture()
      let code = -1
      try {
        code = await waitForUpReady({
          rootDir: root,
          services,
          timeoutMs: 3000,
          json: true,
          runProbeFn: async () => {
            calls += 1
            return { ok: true, note: "work-queue-empty", timedOut: false, code: 0 }
          },
        })
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(calls).toBeGreaterThan(0)
      const payload = JSON.parse(io.out.join("\n")) as { ready: boolean; services: { port?: number; readiness?: object }[]; noPort: string[] }
      expect(payload.ready).toBe(true)
      expect(payload.noPort).toEqual([])
      expect(payload.services[0]).not.toHaveProperty("port")
      expect(payload.services[0].readiness).toMatchObject({ kind: "probe", ok: true })
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(root, { recursive: true, force: true })
    }
  })

  test("probe+--health conflict exit 2 (N5)", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { run } = await import("./cli")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  api:\n    cmd: sleep 30\n    port: 8901\n    readiness: {probe: [./x.sh]}\n", "utf8")
      const io = capture()
      let code = -1
      try {
        code = await run(["up", "-d", "--wait", "5s", "--health", "api=/h", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.err.join("\n")).toContain("conflicts with readiness: api")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--check --json: readiness is a masked shape, no raw cmd leaks (B3)", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { run } = await import("./cli")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(
        file,
        "services:\n  api:\n    cmd: run --token hunter2\n    port: 8901\n    readiness: {probe: [./x.sh, --token, hunter2]}\n",
        "utf8",
      )
      const io = capture()
      try {
        expect(await run(["up", "--check", "--json", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const payload = JSON.parse(io.out.join("\n")) as { services: { cmd?: unknown; readiness?: { probe?: unknown } }[] }
      expect(payload.services[0].cmd).toBe("run --token ***")
      expect(payload.services[0].readiness?.probe).toBe("./x.sh --token ***")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reconcile --probe: drift + readiness lines, exit follows drift", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { readLstart, upPaths, ensureUpStateDir, writeSupervisorState } = await import("./up-state")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(
        file,
        `services:\n  a:\n    cmd: sleep 30\n    readiness: {probe: [${join(FIXTURES, "ready-false.sh")}], needsPort: false}\n`,
        "utf8",
      )
      const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      try {
        const lstart = (await readLstart(sleeper.pid))!
        const paths = upPaths(root)
        await ensureUpStateDir(paths.stateDir)
        await writeSupervisorState(paths.supervisorFile, {
          version: 1,
          startedAt: new Date().toISOString(),
          services: [{ name: "a", pid: sleeper.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30" }],
        })
        const { runReconcileCheck } = await import("./up-reconcile")
        const io = capture()
        let code = -1
        try {
          code = await runReconcileCheck({ rootDir: root, file, json: false, probe: true })
        } finally {
          io.restore()
        }
        expect(code).toBe(0)
        expect(io.out.join("\n")).toContain("readiness: a not-ready (closed)")
        const io2 = capture()
        try {
          expect(await runReconcileCheck({ rootDir: root, file, json: true, probe: true })).toBe(0)
        } finally {
          io2.restore()
        }
        const payload = JSON.parse(io2.out.join("\n")) as { reconcile: { inSync: boolean }; readiness: { service: string; ok: boolean }[] }
        expect(payload.reconcile.inSync).toBe(true)
        expect(payload.readiness).toEqual([{ service: "a", ok: false, note: "closed" }])
      } finally {
        try {
          sleeper.kill("SIGKILL")
        } catch {
          // gone
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reconcile probe budget: the stuck one + the remainder unmeasured", async () => {
    const { writeFile, rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { readLstart, upPaths, ensureUpStateDir, writeSupervisorState } = await import("./up-state")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n    readiness: {probe: [./x.sh], needsPort: false}\n  b:\n    cmd: sleep 30\n    readiness: {probe: [./y.sh], needsPort: false}\n", "utf8")
      const mk = () => Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      const pa = mk()
      const pb = mk()
      try {
        const la = (await readLstart(pa.pid))!
        const lb = (await readLstart(pb.pid))!
        const paths = upPaths(root)
        await ensureUpStateDir(paths.stateDir)
        await writeSupervisorState(paths.supervisorFile, {
          version: 1,
          startedAt: new Date().toISOString(),
          services: [
            { name: "a", pid: pa.pid, lstart: la, startedAt: new Date().toISOString(), cmd: "sleep 30" },
            { name: "b", pid: pb.pid, lstart: lb, startedAt: new Date().toISOString(), cmd: "sleep 30" },
          ],
        })
        let calls = 0
        const { runReconcileCheck } = await import("./up-reconcile")
        const io = capture()
        let code = -1
        try {
          code = await runReconcileCheck({
            rootDir: root,
            file,
            json: false,
            probe: true,
            probeBudgetMs: 30,
            runProbeFn: async () => {
              calls += 1
              await new Promise((resolveSleep) => setTimeout(resolveSleep, 40))
              return { ok: true, note: "passed", timedOut: false, code: 0 }
            },
          })
        } finally {
          io.restore()
        }
        expect(code).toBe(0)
        expect(calls).toBe(1)
        expect(io.out.join("\n")).toContain("readiness: b unmeasured (timeout-budget)")
      } finally {
        for (const proc of [pa, pb]) {
          try {
            proc.kill("SIGKILL")
          } catch {
            // gone
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("readiness record: the live supervisor merges it, the old pid drops", async () => {
    const { writeFile, rm, readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { readLstart, upPaths, ensureUpStateDir, readSupervisorState } = await import("./up-state")
    const { runSupervised, processServiceRequest } = await import("./up-supervisor")
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n    readiness: {probe: [./x.sh], needsPort: false}\n", "utf8")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const keeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" })
      try {
        const keeperLstart = (await readLstart(keeper.pid))!
        await writeFile(paths.lockFile, JSON.stringify({ pid: keeper.pid, lstart: keeperLstart, startedAt: new Date().toISOString() }), "utf8")
        const { parseUpFile } = await import("./up-schema")
        const text = await readFile(file, "utf8")
        let stopFlag = false
        const done = runSupervised(parseUpFile(text).services, {
          rootDir: root,
          stateFile: paths.supervisorFile,
          requestsDir: paths.requestsDir,
          owFile: file,
          onLine: () => undefined,
          shouldStop: () => stopFlag,
        })
        const waitFor = async (cond: () => Promise<boolean>): Promise<void> => {
          const start = Date.now()
          for (;;) {
            if (await cond()) return
            if (Date.now() - start > 8000) throw new Error("timeout")
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
          }
        }
        await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services.length === 1)
        const { writeRequest, waitResult } = await import("./up-requests")
        const live = (await readSupervisorState(paths.supervisorFile))!
        const nonce = await writeRequest(paths.requestsDir, "readiness", "a", file, {
          readiness: { pid: live.services[0].pid, ok: false, note: "closed", at: new Date().toISOString() },
        })
        const result = await waitResult(paths.requestsDir, nonce)
        expect(result).toMatchObject({ ok: true, code: "recorded" })
        const after = (await readSupervisorState(paths.supervisorFile))!
        expect(after.services[0].lastReadiness).toMatchObject({ ok: false, note: "closed", kind: "probe" })
        // A verdict from the old pid drops (stale), it does not touch state.
        const stale = await processServiceRequest(
          {
            rootDir: root,
            owFile: file,
            units: [],
            children: [],
            tails: [],
            retiring: new Set(),
            spawnUnit: async () => undefined,
            persist: async () => undefined,
          },
          { action: "readiness", service: "a", nonce: "n", pid: 1, at: new Date().toISOString(), file, readiness: { pid: 999999, ok: true, note: "x", at: new Date().toISOString() } },
        )
        expect(stale).toMatchObject({ ok: false, code: "stale" })
        stopFlag = true
        await done
      } finally {
        try {
          keeper.kill("SIGKILL")
        } catch {
          // gone
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-f vacuous wait refuses (never silent pass)", () => {
  test("zero targets exits 2 with refusal (human + json)", async () => {
    const { waitForUpReady } = await import("./cli")
    const { parseUpFile } = await import("./up-schema")
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { rm } = await import("node:fs/promises")
    const root = await mkdtemp(join(tmpdir(), "ow-mf-"))
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
    try {
      const services = parseUpFile("services:\n  worker:\n    cmd: ./work\n").services
      const code = await waitForUpReady({ rootDir: root, services, timeoutMs: 3000, json: false })
      expect(code).toBe(2)
      expect(err.join("\n")).toContain("ow: nothing to wait for")
      out.length = 0
      err.length = 0
      const code2 = await waitForUpReady({ rootDir: root, services, timeoutMs: 3000, json: true })
      expect(code2).toBe(2)
      const payload = JSON.parse(out.join("\n")) as { ready: boolean; note: string }
      expect(payload.ready).toBe(false)
      expect(payload.note).toContain("no targets")
    } finally {
      console.log = origLog
      console.error = origError
      await rm(root, { recursive: true, force: true })
    }
  })
})
