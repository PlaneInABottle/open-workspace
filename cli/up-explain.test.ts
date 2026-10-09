/** M2 explain: kayıtlı-değer render (ps yolu git/lsof çalıştırmaz) +
 * reconcile rev-satırları + checkout-değişim gate kanıtı. */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { run } from "./cli"
import { explainServices, formatExplanation, runPsExplain, type PsServiceView } from "./up-ps"
import { runReconcileCheck } from "./up-reconcile"
import { ensureUpStateDir, readLstart, upPaths, writeSupervisorState, type UpServiceState } from "./up-state"

const ownedProcs: { kill: (signal?: string) => void }[] = []
const savedPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = savedPath
  for (const proc of ownedProcs.splice(0)) {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }
})

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m2exp-"))

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

const liveView = (name: string, pid: number, overrides: Partial<PsServiceView> = {}): PsServiceView => ({
  name,
  status: "running",
  pid,
  uptimeSec: 5,
  cpuPct: 0,
  memBytes: 1024,
  ...overrides,
})

const recordOf = (entry: Record<string, unknown>): UpServiceState => entry as unknown as UpServiceState

describe("explainServices (saf)", () => {
  test("uyumlu servis: fark yok, M3 nedeni (portlu + UP)", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", cwd: ".", port: 3000 }],
      views: [liveView("a", 11, { port: 3000, listening: true })],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3000 })],
      snapshotOk: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].explanation.diffs).toEqual([])
    expect(items[0].explanation.running).toMatchObject({ lstart: "matched" })
    expect(items[0].explanation.neden).toContain("M3 probe ekleyin")
  })

  test("config farkları + neden önceliği", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 60", cwd: ".", port: 3001, env: { A: "x" } as never }],
      views: [liveView("a", 11, { port: 3002, listening: false })],
      records: [
        recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", cwd: ".", port: 3002, envNames: ["A"] }),
      ],
      snapshotOk: true,
    })
    const diffs = items[0].explanation.diffs.join("\n")
    expect(diffs).toContain("komut değişti")
    expect(diffs).toContain("port değişti")
    expect(diffs).toContain("port 3002 dinlemiyor")
    expect(items[0].explanation.neden).toContain("ow restart a")
  })

  test("ölü/kayıtsız/tanımsız + lstart kararları", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 1" }, { name: "yeni", cmd: "echo hi" }],
      views: [
        { name: "a", status: "stopped", pid: 11, uptimeSec: 1, cpuPct: null, memBytes: null },
        { name: "hayalet", status: "unknown", pid: 12, uptimeSec: 1, cpuPct: null, memBytes: null },
      ],
      records: [
        recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 1" }),
        recordOf({ name: "hayalet", pid: 12, lstart: "yabancı", startedAt: "t", cmd: "sleep 1" }),
      ],
      snapshotOk: true,
    })
    const byName = new Map(items.map((item) => [item.service, item.explanation]))
    expect(byName.get("a")?.running).toMatchObject({ lstart: "dead" })
    expect(byName.get("a")?.neden).toContain("ow restart a")
    expect(byName.get("hayalet")?.running).toMatchObject({ lstart: "mismatch" })
    expect(byName.get("hayalet")?.diffs.join("\n")).toContain("lstart uyuşmazlığı")
    expect(byName.get("yeni")?.running).toBeNull()
    expect(byName.get("yeni")?.neden).toContain("ow up yeni")
    expect(byName.get("hayalet")?.expected).toBeNull()
    expect(byName.get("hayalet")?.neden).toContain("ow down hayalet")
  })

  test("kör lstart + kirli checkout + UNVERIFIED rev", () => {
    const items = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [{ name: "a", status: "unknown", pid: 11, uptimeSec: 1, cpuPct: null, memBytes: null, note: "lstart bilinmiyor" }],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "",
          startedAt: "t",
          cmd: "sleep 30",
          lstartUnknown: true,
          provenance: { checkout: { rev: "abc", dirty: true, source: "observed" }, recordedAt: "t" },
        }),
      ],
      snapshotOk: true,
    })
    expect(items[0].explanation.running).toMatchObject({ lstart: "unknown" })
    expect(items[0].explanation.diffs.join("\n")).toContain("kirli checkout ile başlatıldı (rev=abc)")
    expect(items[0].explanation.neden).toContain("güvenli işlem yok")
    const lines = formatExplanation(items[0])
    expect(lines.join("\n")).toContain("rev=abc(observed)+kirli")
    const noRev = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(formatExplanation(noRev[0]).join("\n")).toContain("rev=doğrulanamadı(UNVERIFIED)")
  })

  test("readiness tanımı + son-bilinen (maskeli, çalıştırmaz)", () => {
    const spec = { probe: ["./x.sh", "--token", "hunter2"], timeout: "10s" as const, needsPort: true }
    const defined = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", readiness: spec }],
      views: [liveView("a", 11)],
      records: [
        recordOf({
          name: "a",
          pid: 11,
          lstart: "l",
          startedAt: "t",
          cmd: "sleep 30",
          lastReadiness: { ok: true, note: "smoke", at: "2026-10-09T00:00:00.000Z", kind: "probe" },
        }),
      ],
      snapshotOk: true,
    })
    expect(defined[0].explanation.readiness).toMatchObject({
      defined: true,
      timeout: "10s",
      needsPort: true,
      last: { ok: true },
    })
    expect(defined[0].explanation.readiness.probe).not.toContain("hunter2")
    const text = formatExplanation(defined[0]).join("\n")
    expect(text).toContain("hazırlık:")
    expect(text).toContain("hazır (2026-10-09T00:00:00.000Z)")
    expect(text).not.toContain("hunter2")
    const missing = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30", readiness: spec }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(missing[0].explanation.readiness.last).toBeNull()
    expect(formatExplanation(missing[0]).join("\n")).toContain("ölçülmedi")
    const plain = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30" })],
      snapshotOk: true,
    })
    expect(plain[0].explanation.readiness).toMatchObject({ defined: false, last: null })
    expect(formatExplanation(plain[0]).join("\n")).not.toContain("hazırlık:")
  })
})

describe("ps --explain CLI", () => {
  const fixture = async (): Promise<{ root: string; file: string; pid: number; lstart: string }> => {
    const root = await tempRoot()
    const file = join(root, "ow.yaml")
    await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n    port: 3000\n", "utf8")
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    ownedProcs.push(proc)
    const lstart = (await readLstart(proc.pid))!
    const paths = upPaths(root)
    await ensureUpStateDir(paths.stateDir)
    await writeSupervisorState(paths.supervisorFile, {
      version: 1,
      startedAt: new Date().toISOString(),
      services: [
        recordOf({
          name: "a",
          pid: proc.pid,
          lstart,
          startedAt: new Date().toISOString(),
          cmd: "sleep 30",
          port: 3000,
          provenance: {
            cwdAbs: root,
            checkout: { rev: "abc123", dirty: false, source: "observed" },
            argvShape: ["sleep", "30"],
            recordedAt: "2026-10-09T00:00:00.000Z",
          },
        }),
      ],
    })
    return { root, file, pid: proc.pid, lstart }
  }

  test("insan bloğu: beklenen/çalışan/fark/neden", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      let code = -1
      try {
        code = await run(["ps", "--explain", "--file", file])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain("a:")
      expect(text).toContain("beklenen: cmd=sleep 30 port=3000")
      expect(text).toContain("lstart=eşleşti")
      expect(text).toContain("rev=abc123(observed)")
      expect(text).toContain("neden:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json: explanation zarfı, ham argv yok, sentinel yok", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      const payload = JSON.parse(io.out.join("\n")) as {
        services: { name: string }[]
        explanations: { service: string; explanation: { expected: unknown; running: unknown; diffs: unknown[]; provenance: Record<string, unknown>; neden: string } }[]
      }
      expect(payload.services.map((svc) => svc.name)).toEqual(["a"])
      expect(payload.explanations).toHaveLength(1)
      const explanation = payload.explanations[0].explanation
      expect(Object.keys(explanation).sort()).toEqual(["diffs", "expected", "neden", "provenance", "readiness", "running"])
      expect(JSON.stringify(payload)).not.toContain("hunter2")
      expect(JSON.stringify(explanation.provenance)).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("tek servis filtresi + bilinmeyen servis exit 2", async () => {
    const { root, file } = await fixture()
    try {
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "a", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).toContain("a:")
      expect(await run(["ps", "--explain", "yok", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--probe ile explain reddedilir (exit 2)", async () => {
    const { root, file } = await fixture()
    try {
      expect(await run(["ps", "--explain", "--probe", "--file", file])).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("çalışan satırı cwd render eder; düşmüşse UNVERIFIED", () => {
    const withCwd = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { cwdAbs: "/r/app", recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(withCwd[0].explanation.running).toMatchObject({ cwd: "/r/app" })
    expect(formatExplanation(withCwd[0]).join("\n")).toContain("cwd=/r/app")
    const dropped = explainServices({
      rootDir: "/r",
      expected: [{ name: "a", cmd: "sleep 30" }],
      views: [liveView("a", 11)],
      records: [recordOf({ name: "a", pid: 11, lstart: "l", startedAt: "t", cmd: "sleep 30", provenance: { recordedAt: "t" } })],
      snapshotOk: true,
    })
    expect(dropped[0].explanation.running).not.toHaveProperty("cwd")
    expect(formatExplanation(dropped[0]).join("\n")).toContain("cwd=doğrulanamadı(UNVERIFIED)")
  })

  test("--explain yalnızca ps dalında okunur (M-C emsali guard'lar)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      for (const args of [
        ["up", "--check", "--explain", "--file", file],
        ["down", "--explain", "--file", file],
        ["reconcile", "--check", "--explain", "--file", file],
        ["show", "yok-oturum", "--explain"],
      ]) {
        const io = capture()
        let code = -1
        try {
          code = await run(args)
        } finally {
          io.restore()
        }
        expect(`${args.join(" ")} → ${code}`).toBe(`${args.join(" ")} → 2`)
        expect(io.err.join("\n")).toContain("--explain yalnızca ps ile kullanılır")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("secret env değeri hiçbir yola girmez (.env içerik + env değeri)", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: run --token hunter2\n    env: {API_KEY: hunter2}\n", "utf8")
      await writeFile(join(root, ".env"), "TOKEN=hunter2\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      ownedProcs.push(proc)
      const lstart = (await readLstart(proc.pid))!
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const { recordProvenance } = await import("./up-provenance")
      const provenance = await recordProvenance({ svc: { name: "a", cmd: "run --token hunter2" }, cwdAbs: root })
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [recordOf({ name: "a", pid: proc.pid, lstart, startedAt: new Date().toISOString(), cmd: "run --token ***", provenance })],
      })
      const raw = await readFile(paths.supervisorFile, "utf8")
      expect(raw).not.toContain("hunter2")
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io.restore()
      }
      expect(io.out.join("\n")).not.toContain("hunter2")
      const io2 = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file])).toBe(0)
      } finally {
        io2.restore()
      }
      expect(io2.out.join("\n") + io2.err.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("B4: ps yolu git/lsof çalıştırmaz (sayaç kanıtı)", () => {
  const fakeBin = async (): Promise<{ dir: string; countFile: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "ow-fakebin-"))
    const countFile = join(dir, "count.log")
    await writeFile(countFile, "", "utf8")
    for (const tool of ["git", "lsof"]) {
      await writeFile(
        join(dir, tool),
        `#!/bin/sh\necho "$0 $@" >> "${countFile}"\nif [ "${tool}" = "git" ]; then echo "deadbeef1234"; fi\n`,
        { mode: 0o755 },
      )
    }
    return { dir, countFile }
  }

  test("explain sahte git/lsof'a dokunmaz (sayaç 0)", async () => {
    const root = await tempRoot()
    const { dir, countFile } = await fakeBin()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: sleep 30\n", "utf8")
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
      ownedProcs.push(proc)
      const lstart = (await readLstart(proc.pid))!
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      await writeSupervisorState(paths.supervisorFile, {
        version: 1,
        startedAt: new Date().toISOString(),
        services: [recordOf({ name: "a", pid: proc.pid, lstart, startedAt: new Date().toISOString(), cmd: "sleep 30" })],
      })
      process.env.PATH = `${dir}:${savedPath}`
      const io = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
        expect(await run(["ps", "--file", file])).toBe(0)
        expect(await run(["reconcile", "--check", "--file", file])).toBe(0)
      } finally {
        io.restore()
      }
      // reconcile --check YASAL olarak git çalıştırır (B4-b); ps yolları çalıştırmaz.
      const log = await readFile(countFile, "utf8")
      expect(log).not.toMatch(/lsof/)
      const io2 = capture()
      try {
        await run(["ps", "--explain", "--file", file])
      } finally {
        io2.restore()
      }
      expect((await readFile(countFile, "utf8")).split("\n").filter((line) => line.includes("lsof"))).toEqual([])
    } finally {
      process.env.PATH = savedPath
      await rm(root, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("spawn yolu aynı sahte git'i çağırır (enjeksiyon çalışıyor)", async () => {
    const root = await tempRoot()
    const { dir, countFile } = await fakeBin()
    try {
      process.env.PATH = `${dir}:${savedPath}`
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const code = await runSupervised([{ name: "a", cmd: "echo hi", cwd: "." }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine: () => undefined,
      })
      expect(code).toBe(0)
      const log = await readFile(countFile, "utf8")
      expect(log).toContain("rev-parse")
    } finally {
      process.env.PATH = savedPath
      await rm(root, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("up-ps.ts kaynağında git/lsof exec izi yok (korkuluk)", async () => {
    const src = await readFile(resolve(import.meta.dir, "up-ps.ts"), "utf8")
    expect(src).not.toContain("lsof")
    expect(src).not.toMatch(/["']git["']/)
    expect(src).not.toContain("probe(")
    expect(src).not.toContain("health(")
  })
})

describe("gate: checkout-değişimi restart-sız eski rev gösterir", () => {
  const hasGit = async (): Promise<boolean> => {
    try {
      const proc = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" })
      await proc.exited
      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  const git = async (root: string, args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root },
    })
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} patladı`)
  }

  test("reconcile fark-satırı + explain kayıtlı rev (restart yok)", async () => {
    if (!(await hasGit())) {
      console.log("atlandı: git yok")
      return
    }
    const root = await tempRoot()
    let stop = false
    let done: Promise<number> | null = null
    try {
      await git(root, ["init", "-q"])
      await writeFile(join(root, "ow.yaml"), "services:\n  a:\n    cmd: sleep 30\n    cwd: .\n", "utf8")
      await writeFile(join(root, "iz.txt"), "v1\n", "utf8")
      await git(root, ["add", "-A"])
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev1"])
      const { ensureUpStateDir, readSupervisorState, upPaths } = await import("./up-state")
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      done = runSupervised([{ name: "a", cmd: "sleep 30", cwd: "." }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        logsDir: paths.logsDir,
        onLine: () => undefined,
        shouldStop: () => stop,
      })
      const waitFor = async (cond: () => Promise<boolean>): Promise<void> => {
        const start = Date.now()
        for (;;) {
          if (await cond()) return
          if (Date.now() - start > 15000) throw new Error("supervisor kaydı beklenemedi")
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
        }
      }
      await waitFor(async () => (await readSupervisorState(paths.supervisorFile))?.services[0]?.provenance !== undefined)
      const rev1 = (await readSupervisorState(paths.supervisorFile))?.services[0]?.provenance?.checkout?.rev
      expect(rev1).toMatch(/^[0-9a-f]{40}$/)
      // Checkout değişir, restart YOK.
      await writeFile(join(root, "iz.txt"), "v2\n", "utf8")
      await git(root, ["add", "-A"])
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev2"])
      const file = join(root, "ow.yaml")
      const io = capture()
      let reconcileCode = -1
      try {
        reconcileCode = await runReconcileCheck({ rootDir: root, file, json: false })
      } finally {
        io.restore()
      }
      expect(reconcileCode).toBe(0)
      expect(io.out.join("\n")).toContain(`fark: revision ${rev1}→`)
      const io2 = capture()
      try {
        expect(await run(["ps", "--explain", "--file", file, "--json"])).toBe(0)
      } finally {
        io2.restore()
      }
      const payload = JSON.parse(io2.out.join("\n")) as {
        explanations: { explanation: { provenance: { checkout?: { rev?: string } } } }[]
      }
      expect(payload.explanations[0].explanation.provenance.checkout?.rev).toBe(rev1)
      stop = true
      await done
    } finally {
      stop = true
      if (done !== null) await Promise.race([done, new Promise((resolveSleep) => setTimeout(resolveSleep, 8000))])
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})

describe("merge: provenance respawn'da düşer", () => {
  test("yeni kimlik eski checkout'u diriltmez", async () => {
    const { mergePreservingSettled } = await import("./up-supervisor")
    const merged = mergePreservingSettled(
      [
        {
          name: "a",
          pid: 1,
          lstart: "x",
          startedAt: "t",
          provenance: { checkout: { rev: "eski", source: "observed" as const }, recordedAt: "t" },
        },
      ],
      [{ name: "a", pid: 2, lstart: "y", startedAt: "t2" }],
    )
    expect(merged[0].provenance).toBeUndefined()
    const same = mergePreservingSettled(
      [
        {
          name: "a",
          pid: 1,
          lstart: "x",
          startedAt: "t",
          provenance: { checkout: { rev: "eski", source: "observed" as const }, recordedAt: "t" },
        },
      ],
      [{ name: "a", pid: 1, lstart: "x", startedAt: "t2" }],
    )
    expect(same[0].provenance).toMatchObject({ checkout: { rev: "eski" } })
  })
})
