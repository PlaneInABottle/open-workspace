import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { run } from "./cli"
import { formatPsLine, parseEtime, parsePsSnapshot, queryPs, toPsServiceJson } from "./up-ps"
import { ensureUpStateDir, isLivePid, readLstart, upPaths, writeSupervisorState } from "./up-state"

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

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m4-"))

const spawnSleep = (seconds = 30): { pid: number; kill: (signal?: string) => void } => {
  const proc = Bun.spawn(["sleep", String(seconds)], { stdout: "ignore", stderr: "ignore" })
  owned.push(proc)
  return proc
}

describe("parseEtime", () => {
  test("macOS/Linux variants convert to seconds", () => {
    expect(parseEtime("05:03")).toBe(303)
    expect(parseEtime("1:02:03")).toBe(3723)
    expect(parseEtime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
    expect(parseEtime("00:00")).toBe(0)
    expect(parseEtime("  10:00  ")).toBe(600)
  })

  test("foreign shapes are null, never throw", () => {
    for (const bad of ["", "bilinmiyor", "1:2:3:4", "99:99", "12:34:56:78", "-5:00", "1:60:00", "abc-def"]) {
      expect(parseEtime(bad)).toBeNull()
    }
  })
})

describe("parsePsSnapshot", () => {
  test("macOS sample with spaced lstart parses", () => {
    const out = "  4242  01:02:03   1234  0.0 Wed Oct  7 21:50:48 2026\n  9999     05:03  56789 12.5 Mon Oct  5 09:01:02 2026\n"
    const rows = parsePsSnapshot(out)
    expect(rows.get(4242)).toMatchObject({ etimeSec: 3723, rssKb: 1234, pcpu: 0 })
    expect(rows.get(4242)?.lstart).toContain("2026")
    expect(rows.get(9999)).toMatchObject({ etimeSec: 303, rssKb: 56789, pcpu: 12.5 })
  })

  test("Linux dd-hh:mm:ss variant parses", () => {
    const out = "  111 2-03:04:05  2048  1.5 Tue Oct  6 12:00:00 2026\n"
    const rows = parsePsSnapshot(out)
    expect(rows.get(111)?.etimeSec).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })

  test("empty/foreign output degrades to empty, never throws", () => {
    expect(parsePsSnapshot("")).toEqual(new Map())
    expect(parsePsSnapshot("PID TTY TIME CMD\n")).toEqual(new Map())
    expect(parsePsSnapshot("bozuk satır\n   \n9999 nope x y z\n")).toEqual(new Map())
  })
})

describe("queryPs", () => {
  test("live pid reports running with real metrics", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = (await readLstart(sleeper.pid))!
      const startedAt = new Date(Date.now() - 1000).toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [{ name: "uyu", pid: sleeper.pid, lstart, startedAt, cmd: "sleep 30", port: 4123, portConflict: true }],
      })
      const services = await queryPs(root)
      expect(services).toHaveLength(1)
      const svc = services[0]
      expect(svc).toMatchObject({ name: "uyu", status: "running", pid: sleeper.pid, port: 4123 })
      expect(typeof svc.uptimeSec).toBe("number")
      expect(svc.uptimeSec!).toBeGreaterThanOrEqual(0)
      expect(svc.memBytes!).toBeGreaterThan(0)
      expect(Number.isFinite(svc.cpuPct!)).toBe(true)
      expect(svc.note).toContain("port çakışması")
      expect(formatPsLine(svc)).toContain("çalışıyor")
      // Declared port 4123 has no listener in this fixture → probed false.
      expect(svc.listening).toBe(false)
      expect(formatPsLine(svc)).toContain("listen=hayır")
      expect(toPsServiceJson(svc)).toEqual({
        name: "uyu",
        status: "running",
        pid: sleeper.pid,
        uptimeSec: svc.uptimeSec,
        cpuPct: svc.cpuPct,
        memBytes: svc.memBytes,
        port: 4123,
        listening: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("declared port with a live listener reports listening=true", async () => {
    const root = await tempRoot()
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const lstart = (await readLstart(sleeper.pid))!
      const startedAt = new Date().toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [{ name: "api", pid: sleeper.pid, lstart, startedAt, cmd: "sleep 30", port: holder.port }],
      })
      const [svc] = await queryPs(root)
      expect(svc.listening).toBe(true)
      expect(formatPsLine(svc)).toContain("listen=evet")
      expect(toPsServiceJson(svc)).toMatchObject({ port: holder.port, listening: true })
    } finally {
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("recycled pid (lstart mismatch) is unknown with null metrics", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const startedAt = new Date().toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [{ name: "yabanci", pid: sleeper.pid, lstart: "bogus-lstart", startedAt }],
      })
      const [svc] = await queryPs(root)
      expect(svc.status).toBe("unknown")
      expect(svc.cpuPct).toBeNull()
      expect(svc.memBytes).toBeNull()
      expect(svc.note).toContain("lstart uyuşmazlığı")
      expect(formatPsLine(svc)).toContain("bilinmiyor")
      // foreign process untouched by the query
      expect(await isLivePid(sleeper.pid, (await readLstart(sleeper.pid))!)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dead pids map to exited/stopped honestly", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const startedAt = new Date().toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [
          { name: "biten", pid: 987654321, lstart: "bogus", startedAt, cmd: "exit 0", exitCode: 0 },
          { name: "oldurulen", pid: 987654322, lstart: "bogus", startedAt, cmd: "sleep 30", exitCode: -1 },
          { name: "sessiz", pid: 987654323, lstart: "bogus", startedAt, cmd: "sleep 30" },
        ],
      })
      const services = await queryPs(root)
      const by = Object.fromEntries(services.map((svc) => [svc.name, svc]))
      expect(by["biten"].status).toBe("exited")
      expect(by["oldurulen"].status).toBe("stopped")
      expect(by["sessiz"].status).toBe("stopped")
      expect(formatPsLine(by["biten"])).toContain("bitti")
      expect(formatPsLine(by["sessiz"])).toContain("durdu")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing state is honest-empty, corrupt state fails closed", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      expect(await queryPs(root)).toEqual([])
      await writeFile(paths.supervisorFile, "bozuk {{{", "utf8")
      await expect(queryPs(root)).rejects.toThrow("okunamıyor")
      await writeFile(paths.supervisorFile, JSON.stringify({ version: 99, services: [] }), "utf8")
      await expect(queryPs(root)).rejects.toThrow("sürüm")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H5: empty lstart is unknown with a named note, never running/stopped", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const sleeper = spawnSleep()
      const real = (await readLstart(sleeper.pid))!
      const startedAt = new Date().toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [{ name: "kor", pid: sleeper.pid, lstart: "", startedAt, lstartUnknown: true }],
      })
      const [svc] = await queryPs(root)
      expect(svc.status).toBe("unknown")
      expect(svc.cpuPct).toBeNull()
      expect(svc.memBytes).toBeNull()
      expect(svc.note).toContain("lstart bilinmiyor")
      expect(formatPsLine(svc)).toContain("bilinmiyor")
      expect(await isLivePid(sleeper.pid, real)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H5: unknown lstart + dead pid + no exit stays unknown (never stopped)", async () => {
    const root = await tempRoot()
    try {
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const startedAt = new Date().toISOString()
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt,
        services: [{ name: "hayalet", pid: 987654321, lstart: "", startedAt }],
      })
      const [svc] = await queryPs(root)
      expect(svc.status).toBe("unknown")
      expect(svc.note).toContain("lstart bilinmiyor")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ow ps with missing .ow/ exits 0 with empty envelope", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
      expect(await run(["ps", "--file", file])).toBe(0)
      expect(await run(["ps", "--file", file, "--json"])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ow doctor exit rule excludes the up: line", async () => {
    const dir = await tempRoot()
    try {
      // healthy observer fixtures, but no supervisor under upRoot → up: ok:false
      const logPath = join(dir, "events.jsonl")
      await writeFile(
        logPath,
        [
          JSON.stringify({ timestamp: new Date().toISOString(), sessionID: "s", command: "echo hi" }),
          JSON.stringify({ timestamp: new Date().toISOString(), sessionID: "s", kind: "file-edit", path: "a.ts" }),
        ].join("\n") + "\n",
        "utf8",
      )
      const dbPath = join(dir, "opencode.db")
      const db = new Database(dbPath)
      db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY)")
      db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
      db.close()
      const file = join(dir, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
      // up: reports durgun (ok:false) yet doctor exits 0 — the exclusion holds
      expect(await run(["doctor", "--db", dbPath, "--log", logPath, "--file", file])).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("ow up --wait", () => {
  test("--wait without -d is a usage error (exit 2) and starts nothing", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
      expect(await run(["up", "--wait", "5s", "--file", file])).toBe(2)
      // no supervisor was created by the rejected flag combination
      expect(await run(["ps", "--file", file])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--wait with --check is a usage error (exit 2), even with -d", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n", "utf8")
      expect(await run(["up", "--check", "--wait", "5s", "--file", file])).toBe(2)
      expect(await run(["up", "--check", "-d", "--wait", "5s", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a service without a declared port waits for nothing and exits 0", async () => {
    const root = await tempRoot()
    try {
      const { waitForUpReady } = await import("./cli")
      const { parseUpFile } = await import("./up-schema")
      const services = parseUpFile("services:\n  job:\n    cmd: echo hi\n").services
      const original = console.log
      console.log = () => undefined
      try {
        expect(await waitForUpReady({ rootDir: root, services, timeoutMs: 1000, json: true })).toBe(0)
      } finally {
        console.log = original
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--health without --wait is a usage error (exit 2) and starts nothing", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    port: 39991\n", "utf8")
      expect(await run(["up", "--health", "web=/health", "--file", file])).toBe(2)
      expect(await run(["up", "-d", "--health", "web=/health", "--file", file])).toBe(2)
      // rejected flag combinations spawn nothing
      expect(await run(["ps", "--file", file])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--health with --check is a usage error (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    port: 39991\n", "utf8")
      expect(await run(["up", "--check", "-d", "--wait", "5s", "--health", "web=/health", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--health with unknown service or slash-less path is a usage error (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    port: 39991\n", "utf8")
      expect(await run(["up", "-d", "--wait", "5s", "--health", "yok=/health", "--file", file])).toBe(2)
      expect(await run(["up", "-d", "--wait", "5s", "--health", "web=saglik", "--file", file])).toBe(2)
      expect(await run(["ps", "--file", file])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--health on a port-less service is a usage error (exit 2) and starts nothing", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  job:\n    cmd: echo hi\n", "utf8")
      expect(await run(["up", "-d", "--wait", "5s", "--health", "job=/health", "--file", file])).toBe(2)
      expect(await run(["ps", "--file", file])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--wait plus --health without -d is a usage error (exit 2) and starts nothing", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  web:\n    cmd: echo hi\n    port: 39991\n", "utf8")
      expect(await run(["up", "--wait", "5s", "--health", "web=/health", "--file", file])).toBe(2)
      expect(await run(["ps", "--file", file])).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a health-flagged service passes TCP but waits for HTTP 2xx (exit 0, healthPath in JSON)", async () => {
    let well = false
    const holder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/health") return well ? new Response("up") : new Response("down", { status: 503 })
        return new Response("nope", { status: 404 })
      },
    })
    const timer = setTimeout(() => {
      well = true
    }, 1200)
    const root = await tempRoot()
    try {
      const { waitForUpReady } = await import("./cli")
      const lines: string[] = []
      const original = console.log
      console.log = (line?: unknown): void => void lines.push(String(line))
      let code = 1
      try {
        code = await waitForUpReady({
          rootDir: root,
          services: [{ name: "slow", port: holder.port }],
          timeoutMs: 15000,
          json: true,
          health: { slow: "/health" },
        })
      } finally {
        console.log = original
      }
      expect(code).toBe(0)
      const payload = JSON.parse(lines.join("\n")) as { ready: boolean; services: unknown[] }
      expect(payload.ready).toBe(true)
      expect(payload.services).toEqual([
        { name: "slow", port: holder.port, status: "ready", waitedSec: expect.any(Number), healthPath: "/health" },
      ])
    } finally {
      clearTimeout(timer)
      holder.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
