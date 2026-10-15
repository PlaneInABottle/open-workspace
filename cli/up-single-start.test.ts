import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run, runLocklessSingleUp } from "./cli"
import { runSuperviseFile, superviseShell } from "./up-supervisor-cli"
import { readLstart, readSupervisorState, upPaths } from "./up-state"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-singlestart-"))

const captureIo = (): { logs: string[]; errors: string[]; restore: () => void } => {
  const logs: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "))
  }
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "))
  }
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog
      console.error = origErr
    },
  }
}

const freePort = async (): Promise<number> => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
  const port = probe.port
  probe.stop()
  return port
}

const writeBindServer = async (dir: string, name: string, healthPath?: string, always404 = false): Promise<string> => {
  const file = join(dir, name)
  const fetch =
    always404
      ? `fetch: () => new Response("nope", { status: 404 })`
      : healthPath === undefined
        ? `fetch: () => new Response("ok")`
        : `fetch: (req) => new URL(req.url).pathname === ${JSON.stringify(healthPath)} ? new Response("up") : new Response("nope", { status: 404 })`
  await writeFile(file, `const port = Number(process.argv[2]);\nBun.serve({ hostname: "127.0.0.1", port, ${fetch} });\nsetInterval(() => {}, 1000000);\n`, "utf8")
  return file
}

// Single-quoted YAML scalar so the double quotes survive to `sh -c`.
const bindCmd = (srv: string, port: number): string => `'\"${process.execPath}\" \"${srv}\" ${port}'`

const fetchText = async (port: number, path = "/health"): Promise<string | "REFUSED"> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) })
    return await res.text()
  } catch {
    return "REFUSED"
  }
}

const downRm = async (file: string): Promise<void> => {
  const io = captureIo()
  try {
    await run(["down", "--file", file, "--rm"])
  } finally {
    io.restore()
  }
}

describe("lockless single-service start (selection from initial startup)", () => {
  test("up A -d starts only A: B declared but never spawned, port silent", async () => {
    const portA = await freePort()
    const portB = await freePort()
    const stage = await tempRoot()
    const root = await tempRoot()
    const srv = await writeBindServer(stage, "srv.mjs", "/health")
    const file = join(root, "ow.yaml")
    await writeFile(file, `services:\n  svcA:\n    cmd: ${bindCmd(srv, portA)}\n    port: ${portA}\n  svcB:\n    cmd: ${bindCmd(srv, portB)}\n    port: ${portB}\n`, "utf8")
    const io = captureIo()
    let code = -1
    try {
      code = await run(["up", "svcA", "-d", "--file", file, "--wait", "15s", "--health", "svcA=/health"])
    } finally {
      io.restore()
    }
    try {
      expect(code).toBe(0)
      expect(io.logs.join("\n")).toContain("started: 1 services (svcA)")
      expect(io.logs.join("\n")).toContain(`ready: svcA:${portA}/health`)
      const state = (await readSupervisorState(upPaths(root).supervisorFile))!
      expect(state.services.map((svc) => svc.name)).toEqual(["svcA"])
      expect(await fetchText(portA)).toBe("up")
      expect(await fetchText(portB)).toBe("REFUSED")
    } finally {
      await downRm(file)
      await rm(stage, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)

  test("bulk bare up -d still starts every declared service (preservation)", async () => {
    const portA = await freePort()
    const portB = await freePort()
    const stage = await tempRoot()
    const root = await tempRoot()
    const srv = await writeBindServer(stage, "srv.mjs", "/health")
    const file = join(root, "ow.yaml")
    await writeFile(file, `services:\n  svcA:\n    cmd: ${bindCmd(srv, portA)}\n    port: ${portA}\n  svcB:\n    cmd: ${bindCmd(srv, portB)}\n    port: ${portB}\n`, "utf8")
    const io = captureIo()
    let code = -1
    try {
      code = await run(["up", "-d", "--file", file, "--wait", "15s", "--health", `svcA=/health,svcB=/health`])
    } finally {
      io.restore()
    }
    try {
      expect(code).toBe(0)
      expect(io.logs.join("\n")).toContain("started: 2 services (svcA, svcB)")
      const state = (await readSupervisorState(upPaths(root).supervisorFile))!
      expect(state.services.map((svc) => svc.name).sort()).toEqual(["svcA", "svcB"])
      expect(await fetchText(portA)).toBe("up")
      expect(await fetchText(portB)).toBe("up")
    } finally {
      await downRm(file)
      await rm(stage, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)

  test("unknown service fails exit 2 with no children and no state dir", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  svcA:\n    cmd: sleep 30\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await run(["up", "nope", "-d", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.errors.join("\n")).toContain("ow: unknown service: nope (known: svcA)")
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("failed initial --wait stops what it started (exit 1, lock cleared, port silent)", async () => {
    const portA = await freePort()
    const portB = await freePort()
    const stage = await tempRoot()
    const root = await tempRoot()
    // TCP answers but /health never 2xx: the wait must fail after the window.
    const srv = await writeBindServer(stage, "srv-unhealthy.mjs", undefined, true)
    const file = join(root, "ow.yaml")
    await writeFile(file, `services:\n  svcA:\n    cmd: ${bindCmd(srv, portA)}\n    port: ${portA}\n  svcB:\n    cmd: sleep 30\n    port: ${portB}\n`, "utf8")
    const io = captureIo()
    let code = -1
    try {
      code = await run(["up", "svcA", "-d", "--file", file, "--wait", "3s", "--health", "svcA=/health"])
    } finally {
      io.restore()
    }
    try {
      expect(code).toBe(1)
      expect(io.logs.join("\n")).toContain("stopped: svcA (stopped)")
      // Cleanup stopped our process: TCP refuses and the lock is gone, while
      // the settled record + logs stay for ps/reconcile.
      expect(await fetchText(portA)).toBe("REFUSED")
      expect(await fetchText(portB)).toBe("REFUSED")
      const { classifyLock, upPaths: pathsOf } = await import("./up-state")
      expect((await classifyLock(pathsOf(root).lockFile)).kind).toBe("absent")
      const state = (await readSupervisorState(upPaths(root).supervisorFile))!
      expect(state.services.map((svc) => svc.name)).toEqual(["svcA"])
      expect(state.services[0].exitCode).toBeDefined()
    } finally {
      await downRm(file)
      await rm(stage, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)

  test("later live up B joins; live A pid/lstart unchanged", async () => {
    const portA = await freePort()
    const portB = await freePort()
    const stage = await tempRoot()
    const root = await tempRoot()
    const srv = await writeBindServer(stage, "srv.mjs", "/health")
    const file = join(root, "ow.yaml")
    await writeFile(file, `services:\n  svcA:\n    cmd: ${bindCmd(srv, portA)}\n    port: ${portA}\n  svcB:\n    cmd: ${bindCmd(srv, portB)}\n    port: ${portB}\n`, "utf8")
    try {
      const startIo = captureIo()
      try {
        expect(await run(["up", "svcA", "-d", "--file", file, "--wait", "15s", "--health", "svcA=/health"])).toBe(0)
      } finally {
        startIo.restore()
      }
      const before = (await readSupervisorState(upPaths(root).supervisorFile))!
      const aBefore = before.services.find((svc) => svc.name === "svcA")!
      const joinIo = captureIo()
      try {
        expect(await run(["up", "svcB", "--file", file, "--wait", "15s", "--health", "svcB=/health"])).toBe(0)
        expect(joinIo.logs.join("\n")).toContain(`ready: svcB:${portB}/health`)
      } finally {
        joinIo.restore()
      }
      const after = (await readSupervisorState(upPaths(root).supervisorFile))!
      const aAfter = after.services.find((svc) => svc.name === "svcA")!
      expect(aAfter.pid).toBe(aBefore.pid)
      expect(aAfter.lstart).toBe(aBefore.lstart)
      expect(after.services.map((svc) => svc.name).sort()).toEqual(["svcA", "svcB"])
      expect(await fetchText(portA)).toBe("up")
      expect(await fetchText(portB)).toBe("up")
    } finally {
      await downRm(file)
      await rm(stage, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 90000)

  test("foreign listener on the target port is never killed by wait failure cleanup", async () => {
    const portA = await freePort()
    const root = await tempRoot()
    // Foreign holder answers everything 200 — including /health — but it is
    // not our child: the ownership gate must keep our (alive, unbound)
    // target pending until the window elapses, never counting the foreign
    // answer as ready.
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: portA, fetch: () => new Response("foreign-ok") })
    const file = join(root, "ow.yaml")
    await writeFile(file, `services:\n  svcA:\n    cmd: sleep 30\n    port: ${portA}\n`, "utf8")
    try {
      const io = captureIo()
      let code = -1
      try {
        code = await run(["up", "svcA", "-d", "--file", file, "--wait", "3s", "--health", "svcA=/health"])
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.logs.join("\n")).toMatch(/timeout: svcA.*foreign listener/)
      // Cleanup stopped our selected child (settled record kept), but the
      // foreign holder answers on — never signaled.
      const state = (await readSupervisorState(upPaths(root).supervisorFile))!
      expect(state.services.map((svc) => svc.name)).toEqual(["svcA"])
      expect(state.services[0].exitCode).toBeDefined()
      expect(await fetchText(portA)).toBe("foreign-ok")
    } finally {
      foreign.stop()
      await downRm(file)
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)

  test("recorded live orphan refuses the selected start (exit 2, no duplicate)", async () => {
    const root = await tempRoot()
    const keeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      const paths = upPaths(root)
      const { ensureUpStateDir, writeSupervisorState } = await import("./up-state")
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [{ name: "old", pid: keeper.pid, lstart: (await readLstart(keeper.pid))!, startedAt: new Date().toISOString() }],
      })
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  svcA:\n    cmd: sleep 30\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await run(["up", "svcA", "-d", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.errors.join("\n")).toContain("orphaned processes still running: old")
      const state = (await readSupervisorState(paths.supervisorFile))!
      expect(state.services.map((svc) => svc.name)).toEqual(["old"])
    } finally {
      keeper.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})

describe("selected-start entry points", () => {
  test("runSuperviseFile --only runs the target to exit with target-only state", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: exit 3\n  b:\n    cmd: sleep 30\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await runSuperviseFile(file, { only: "a" })
      } finally {
        io.restore()
      }
      expect(code).toBe(1)
      expect(io.logs.join("\n")).toContain("exit: a code=3")
      const state = (await readSupervisorState(upPaths(root).supervisorFile))!
      expect(state.services.map((svc) => svc.name)).toEqual(["a"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("runSuperviseFile --only with an unknown name fails before state exists", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: exit 0\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await runSuperviseFile(file, { only: "nope" })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.errors.join("\n")).toContain("ow: unknown service: nope (known: a)")
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runLocklessSingleUp refuses --wait without -d (exit 2, nothing spawns)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n    port: 18999\n", "utf8")
      const io = captureIo()
      let code = -1
      try {
        code = await runLocklessSingleUp({ rootDir: root, file, service: "a", json: false, detach: false, wait: "5s" })
      } finally {
        io.restore()
      }
      expect(code).toBe(2)
      expect(io.errors.join("\n")).toContain("ow: --wait works only with -d/--detach (preview)")
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("superviseShell threads a quoted --only into __supervise", async () => {
    const shell = superviseShell("/bin/ow", null, "/tmp/ow.yaml", "/tmp/x.out", "svcA")
    expect(shell).toContain("__supervise --file '/tmp/ow.yaml' --only 'svcA'")
    const evil = "a$(touch /tmp/ow-pwned-only)b`c`$HOME'd'e"
    const evilShell = superviseShell("/bin/ow", "/cli/cli.ts", "/tmp/ow.yaml", "/tmp/x.out", evil)
    const { shQuote } = await import("./up-supervisor-cli")
    expect(evilShell).toContain(`--only ${shQuote(evil)}`)
    expect(existsSync("/tmp/ow-pwned-only")).toBe(false)
  })
})

afterEach(async () => {
  // Detached supervisors from these tests are always reaped via down --rm in
  // each test's finally; this only guards against cross-test port holders.
})
