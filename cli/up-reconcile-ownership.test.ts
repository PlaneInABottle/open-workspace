import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseUpFile } from "./up-schema"
import { descendantOwnersOf, formatDrift, reconcileOne, runReconcileCheck } from "./up-reconcile"
import { portOwners as lsofPortOwners } from "./up-reconcile"
import { ensureUpStateDir, isLivePid, readLstart, readProcessTable, upPaths, writeSupervisorState, type ProcessTable } from "./up-state"
import { tcpListening } from "./up-net"

const FOREIGN_HINT = (port: number): string => `port ${port} foreign listener (UNVERIFIED) — no kill, verify the owner`
const SHARED_HINT = (port: number): string => `port ${port} also held by a foreign listener (UNVERIFIED) — no kill, verify the owner`

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m1-own-"))

const owned: { kill: (signal?: string) => void }[] = []
const track = <T extends { kill: (signal?: string) => void }>(proc: T): T => {
  owned.push(proc)
  return proc
}

afterEach(async () => {
  for (const proc of owned.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
})

const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 10000): Promise<void> => {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
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

const expPort = (port: number) => parseUpFile(`services:\n  api:\n    cmd: sleep 30\n    port: ${port}\n`).services[0]

const tableOf = (rows: [number, number, string][]): ProcessTable =>
  new Map(rows.map(([pid, ppid, lstart]) => [pid, { ppid, lstart }]))

describe("descendantOwnersOf (pure)", () => {
  test("depth-1 descendant proves ownership", () => {
    const table = tableOf([[100, 1, "L100"], [200, 100, "L200"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [200], table)).toEqual([200])
  })

  test("depth-2 descendant proves ownership", () => {
    const table = tableOf([[100, 1, "L100"], [150, 100, "L150"], [200, 150, "L200"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [200], table)).toEqual([200])
  })

  test("whitespace-normalized lstart still proves descent", () => {
    const table = tableOf([[100, 1, "Mon  Oct   6 00:00:00 2026"], [200, 100, "L200"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "Mon Oct 6 00:00:00 2026" }, [200], table)).toEqual([200])
  })

  test("PID reuse (snapshot lstart differs) proves nothing — legacy fallback", () => {
    const table = tableOf([[100, 1, "NEWLSTART"], [200, 100, "L200"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "OLDLSTART" }, [200], table)).toBeNull()
  })

  test("null table proves nothing — legacy fallback", () => {
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [200], null)).toBeNull()
  })

  test("empty snapshot (recorded pid absent) proves nothing — legacy fallback", () => {
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [200], new Map())).toBeNull()
  })

  test("cyclic table terminates with no ownership claim", () => {
    const table = tableOf([[100, 1, "L100"], [300, 301, "L300"], [301, 300, "L301"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [300], table)).toEqual([])
  })

  test("an owner equal to the recorded pid is exact-match, not a descendant", () => {
    const table = tableOf([[100, 1, "L100"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [100], table)).toEqual([])
  })

  test("a reparented listener (ppid chain ends at init) is not owned — accepted residual", () => {
    const table = tableOf([[100, 1, "L100"], [200, 1, "L200"]])
    expect(descendantOwnersOf({ pid: 100, lstart: "L100" }, [200], table)).toEqual([])
  })
})

describe("reconcileOne ownership predicate (pure)", () => {
  const liveBase = { liveness: "live" as const, listening: true as const }
  const run = { name: "api", pid: 100, lstart: "L100", startedAt: "t", port: 3000 }

  test("depth-1 descendant owner means no drift", () => {
    expect(
      reconcileOne({ name: "api", expected: expPort(3000), running: run, ...liveBase, portOwners: [200], descendantOwners: [200] }),
    ).toBeNull()
  })

  test("empty owner list with a listener is no owner evidence — no drift (RED-before: foreign-port)", () => {
    expect(
      reconcileOne({ name: "api", expected: expPort(3000), running: run, ...liveBase, portOwners: [] }),
    ).toBeNull()
  })

  test("PID reuse falls back to legacy foreign-port with the hint verbatim", () => {
    const drift = reconcileOne({ name: "api", expected: expPort(3000), running: run, ...liveBase, portOwners: [200] })
    expect(drift).toMatchObject({ kind: "foreign-port", hint: FOREIGN_HINT(3000) })
    expect(drift?.hint).toBe(FOREIGN_HINT(3000))
  })

  test("reparented listener with a live recorded pid stays foreign-port — accepted residual", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [200],
      descendantOwners: [],
    })
    expect(drift).toMatchObject({ kind: "foreign-port", hint: FOREIGN_HINT(3000) })
    expect(drift).not.toHaveProperty("ownership")
  })

  test("lost parent with dead liveness reports stopped — the port branch is unreached", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      liveness: "dead",
      listening: true,
      portOwners: [200],
    })
    expect(drift).toMatchObject({ kind: "stopped" })
  })

  test("multi-owner [descendant, foreign] reports shared with the new hint", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [200, 999],
      descendantOwners: [200],
    })
    expect(drift).toMatchObject({ kind: "foreign-port", ownership: "shared", hint: SHARED_HINT(3000) })
    expect(drift?.hint).toBe(SHARED_HINT(3000))
  })

  test("multi-owner [foreign, foreign] stays foreign-port without ownership", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [998, 999],
      descendantOwners: [],
    })
    expect(drift).toMatchObject({ kind: "foreign-port", hint: FOREIGN_HINT(3000) })
    expect(drift).not.toHaveProperty("ownership")
  })

  test("multi-owner [descendant, recorded] means no drift", () => {
    expect(
      reconcileOne({
        name: "api",
        expected: expPort(3000),
        running: run,
        ...liveBase,
        portOwners: [200, 100],
        descendantOwners: [200],
      }),
    ).toBeNull()
  })

  test("shared ownership is JSON-only — absent from the human line", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [200, 999],
      descendantOwners: [200],
    })!
    expect(drift.ownership).toBe("shared")
    const line = formatDrift(drift)
    expect(line).not.toContain("ownership")
    expect(line).not.toContain("shared")
    expect(line).toBe(`foreign-port: api → ${SHARED_HINT(3000)}`)
  })

  test("owner pids never enter the drift output", () => {
    const drift = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [58731],
      descendantOwners: [],
    })!
    expect(JSON.stringify(drift)).not.toContain("58731")
    const shared = reconcileOne({
      name: "api",
      expected: expPort(3000),
      running: run,
      ...liveBase,
      portOwners: [58732, 58733],
      descendantOwners: [58732],
    })!
    expect(JSON.stringify(shared)).not.toContain("58732")
    expect(JSON.stringify(shared)).not.toContain("58733")
  })

  test("true foreign owner keeps the exact legacy hint (no kill wording preserved)", () => {
    const drift = reconcileOne({ name: "api", expected: expPort(3000), running: run, ...liveBase, portOwners: [99999] })
    expect(drift?.hint).toBe("port 3000 foreign listener (UNVERIFIED) — no kill, verify the owner")
  })

})

describe("readProcessTable (real ps)", () => {
  test("the snapshot contains the current process", async () => {
    const table = await readProcessTable()
    expect(table).not.toBeNull()
    expect(table!.has(process.pid)).toBe(true)
  })
})

// Integration: real processes, polling (no fixed sleeps), owned cleanup.
const SERVER_SRC = `const port = Number(process.argv[2]);
Bun.serve({ port, fetch: () => new Response("ok") });
setInterval(() => {}, 1000000);
`

const pickFreePort = async (): Promise<number> => {
  for (let i = 0; i < 50; i += 1) {
    const port = 40000 + Math.floor(Math.random() * 20000)
    if (!(await tcpListening(port))) return port
  }
  throw new Error("no free port found")
}

const writeServerFile = async (root: string): Promise<string> => {
  const file = join(root, "srv.mjs")
  await writeFile(file, SERVER_SRC, "utf8")
  return file
}

const recordService = async (root: string, file: string, name: string, pid: number, port: number): Promise<void> => {
  const paths = upPaths(root)
  await ensureUpStateDir(paths.stateDir)
  const lstart = (await readLstart(pid))!
  await writeSupervisorState(paths.supervisorFile, {
    version: 1,
    startedAt: new Date().toISOString(),
    services: [{ name, pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30", port }],
  })
}

const killListeners = async (port: number): Promise<void> => {
  const owners = (await lsofPortOwners(port).catch(() => null)) ?? null
  if (owners === null) return
  for (const pid of owners) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone or foreign
    }
  }
}

const checkJson = async (root: string, file: string, extra?: Parameters<typeof runReconcileCheck>[0]): Promise<{ code: number; payload: { reconcile: { inSync: boolean; drifts: Record<string, unknown>[] } }; out: string }> => {
  const io = captureIo()
  try {
    const code = await runReconcileCheck({ rootDir: root, file, json: true, ...extra })
    const out = io.logs.join("\n")
    return { code, payload: JSON.parse(out), out }
  } finally {
    io.restore()
  }
}

describe("reconcile ownership integration (real processes)", () => {
  test("forking launcher depth-1 (sh -c 'bun & wait') exits 0 with no drift (RED-before: exit 1)", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const srv = await writeServerFile(root)
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const launcher = track(Bun.spawn(["sh", "-c", `"${process.execPath}" "${srv}" ${port} & wait`], { stdout: "ignore", stderr: "ignore" }))
      try {
        await waitFor(async () => (await tcpListening(port)) && (((await lsofPortOwners(port)) ?? []).length > 0))
        await recordService(root, file, "svc", launcher.pid, port)
        const { code, payload } = await checkJson(root, file)
        expect(code).toBe(0)
        expect(payload.reconcile).toMatchObject({ inSync: true, drifts: [] })
      } finally {
        try {
          launcher.kill("SIGKILL")
        } catch {
          // already gone
        }
        await killListeners(port)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("forking launcher depth-2 (subshell, mvn/node-style fork) exits 0 with no drift (RED-before: exit 1)", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const srv = await writeServerFile(root)
      const middle = join(root, "middle.sh")
      await writeFile(middle, `#!/bin/sh\n"${process.execPath}" "${srv}" "$1" & wait\n`, "utf8")
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const launcher = track(
        Bun.spawn(["sh", "-c", `sh "${middle}" ${port} & wait`], { stdout: "ignore", stderr: "ignore" }),
      )
      try {
        await waitFor(async () => (await tcpListening(port)) && (((await lsofPortOwners(port)) ?? []).length > 0))
        await recordService(root, file, "svc", launcher.pid, port)
        const { code, payload } = await checkJson(root, file)
        expect(code).toBe(0)
        expect(payload.reconcile).toMatchObject({ inSync: true, drifts: [] })
      } finally {
        try {
          launcher.kill("SIGKILL")
        } catch {
          // already gone
        }
        await killListeners(port)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("true foreign listener exits 1 with kind foreign-port and the hint verbatim", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const srv = await writeServerFile(root)
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const foreign = track(Bun.spawn([process.execPath, srv, String(port)], { stdout: "ignore", stderr: "ignore" }))
      const recorded = track(Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" }))
      try {
        await waitFor(async () => (await tcpListening(port)) && (((await lsofPortOwners(port)) ?? []).length > 0))
        await recordService(root, file, "svc", recorded.pid, port)
        const { code, payload } = await checkJson(root, file)
        expect(code).toBe(1)
        expect(payload.reconcile.drifts).toHaveLength(1)
        expect(payload.reconcile.drifts[0]).toMatchObject({
          service: "svc",
          kind: "foreign-port",
          hint: `port ${port} foreign listener (UNVERIFIED) — no kill, verify the owner`,
        })
      } finally {
        try {
          foreign.kill("SIGKILL")
        } catch {
          // already gone
        }
        await killListeners(port)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("real lost parent (launcher killed, grandchild listening) reports stopped, not foreign-port", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const srv = await writeServerFile(root)
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const launcher = track(Bun.spawn(["sh", "-c", `"${process.execPath}" "${srv}" ${port} & wait`], { stdout: "ignore", stderr: "ignore" }))
      try {
        await waitFor(async () => (await tcpListening(port)) && (((await lsofPortOwners(port)) ?? []).length > 0))
        const lstart = (await readLstart(launcher.pid))!
        const paths = upPaths(root)
        await ensureUpStateDir(paths.stateDir)
        await writeSupervisorState(paths.supervisorFile, {
          version: 1,
          startedAt: new Date().toISOString(),
          services: [{ name: "svc", pid: launcher.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30", port }],
        })
        try {
          launcher.kill("SIGKILL")
        } catch {
          // already gone
        }
        await waitFor(async () => !(await isLivePid(launcher.pid, lstart)))
        // The grandchild keeps the port: the drift must still be stopped.
        await waitFor(async () => await tcpListening(port))
        const { code, payload } = await checkJson(root, file)
        expect(code).toBe(1)
        expect(payload.reconcile.drifts).toHaveLength(1)
        expect(payload.reconcile.drifts[0]).toMatchObject({ service: "svc", kind: "stopped" })
      } finally {
        await killListeners(port)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("exec-style owner (pid holds the port) never reads the process table", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const srv = await writeServerFile(root)
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const direct = track(Bun.spawn([process.execPath, srv, String(port)], { stdout: "ignore", stderr: "ignore" }))
      try {
        await waitFor(async () => (await tcpListening(port)) && (((await lsofPortOwners(port)) ?? []).length > 0))
        await recordService(root, file, "svc", direct.pid, port)
        let calls = 0
        const { code, payload } = await checkJson(root, file, {
          ownershipTableFn: async () => {
            calls += 1
            return readProcessTable()
          },
        })
        // Both branches assert meaningfully on the same observed owners:
        // a direct hit never consults ps (calls 0, in sync); a genuine
        // miss consults it exactly once and reports the exact legacy
        // foreign-port drift (verbatim hint, no ownership claim).
        const owners = (await lsofPortOwners(port)) ?? []
        expect(owners.length).toBeGreaterThan(0)
        if (owners.includes(direct.pid)) {
          expect(calls).toBe(0)
          expect(code).toBe(0)
          expect(payload.reconcile).toMatchObject({ inSync: true, drifts: [] })
        } else {
          expect(calls).toBe(1)
          expect(code).toBe(1)
          expect(payload.reconcile.drifts).toHaveLength(1)
          expect(payload.reconcile.drifts[0]).toMatchObject({
            service: "svc",
            kind: "foreign-port",
            hint: `port ${port} foreign listener (UNVERIFIED) — no kill, verify the owner`,
          })
          expect(payload.reconcile.drifts[0]).not.toHaveProperty("ownership")
        }
      } finally {
        try {
          direct.kill("SIGKILL")
        } catch {
          // already gone
        }
        await killListeners(port)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test("no listener on the declared port leaves the output unchanged (in-sync)", async () => {
    const root = await tempRoot()
    const port = await pickFreePort()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, `services:\n  svc:\n    cmd: sleep 30\n    port: ${port}\n`, "utf8")
      const recorded = track(Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" }))
      await recordService(root, file, "svc", recorded.pid, port)
      const io = captureIo()
      try {
        expect(await runReconcileCheck({ rootDir: root, file, json: false })).toBe(0)
        expect(io.logs.join("\n")).toContain("in-sync: 1 services (svc)")
      } finally {
        io.restore()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
