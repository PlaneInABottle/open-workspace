/** Process supervision: pre-spawn validation, line-buffered capture, graceful
 * shutdown, `down` with lstart-guarded signals. No restart, no healthchecks
 * (v1 non-goals). Lines stream to the caller and persist per-service JSONL
 * via `up-logs` (M3); `logs:` tails run as supervisor siblings (M3/D4). */

import { lstat } from "node:fs/promises"
import { resolve } from "node:path"

import type { TraceConfig, UpService } from "./up-schema"
import { appendLogLine, flushUpLogs } from "./up-logs"
import { startTraceReceiver } from "./trace-receiver"
import { tracePaths } from "./trace-store"
import { clearLock, ensureUpStateDir, isLivePid, readLock, readLstart, readSupervisorState, upPaths, writeSupervisorState } from "./up-state"
import type { UpServiceState } from "./up-state"

export type UpLineStream = "stdout" | "stderr" | "log"
export type UpLineHandler = (service: string, stream: UpLineStream, line: string) => void

export type SpawnedChild = {
  service: UpService
  proc: ReturnType<typeof Bun.spawn>
  lstart: string
  startedAt: string
  exit: { code: number | null; signal: string | null; duringShutdown: boolean } | null
}

/** `logs:` sibling: `sh -c <logs-cmd>` child of the supervisor, stdout+stderr
 * merged into the `log` stream. Early exit is a warn, never a failure. */
export type LogTail = {
  service: UpService
  proc: ReturnType<typeof Bun.spawn>
  lstart: string
  startedAt: string
  exit: { code: number | null; duringShutdown: boolean } | null
}

/** Resolve + validate cwd against the ow.yaml dir. Symlink-escaped targets rejected; throws Turkish usage error. */
export const resolveServiceCwd = async (rootDir: string, cwd: string | undefined): Promise<string | undefined> => {
  if (cwd === undefined) return undefined
  const abs = resolve(rootDir, cwd)
  let info
  try {
    info = await lstat(abs)
  } catch {
    throw new Error(`cwd bulunamadı: ${cwd}`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`cwd gerçek bir dizin olmalı: ${cwd}`)
  return abs
}

/** Warn-only port probe: refused on both stacks → free; any connect (or a
 * hung connect) → occupied (warn). Refusal surfaces as `ECONNREFUSED`
 * (node) or `ConnectionRefused` (Bun fetch, also via `cause.code`) — both
 * count as free. Other stack errors (e.g. missing IPv6) are not occupancy
 * evidence. Residual TOCTOU is accepted by design: the probe is advisory,
 * `up` always spawns (warn-and-spawn). */
export const probePort = async (port: number, timeoutMs = 500): Promise<boolean> => {
  const refused = (error: unknown): boolean => {
    const codes = [
      (error as NodeJS.ErrnoException)?.code,
      ((error as { cause?: unknown })?.cause as NodeJS.ErrnoException | undefined)?.code,
    ]
    return codes.some((code) => code === "ECONNREFUSED" || code === "ConnectionRefused")
  }
  for (const host of ["127.0.0.1", "::1"]) {
    const authority = host.includes(":") ? `[${host}]` : host
    try {
      const res = await fetch(`http://${authority}:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
      await res.arrayBuffer().catch(() => undefined)
      return true
    } catch (error) {
      if (refused(error)) continue
      const name = (error as Error)?.name
      if (name === "AbortError" || name === "TimeoutError") return true
    }
  }
  return false
}

const spawnEnv = (svc: UpService): Record<string, string | undefined> => ({
  ...process.env,
  ...svc.env,
  OW_SERVICE: svc.name,
})

const spawnOne = (svc: UpService, cwd: string | undefined): ReturnType<typeof Bun.spawn> => {
  const target = svc.cmd as string | string[]
  const argv = Array.isArray(target) ? [...target] : ["sh", "-c", target]
  return Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(svc),
  })
};

const spawnTail = (svc: UpService, cwd: string | undefined): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(["sh", "-c", svc.logs as string], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(svc),
  });

const pumpLines = (
  proc: ReturnType<typeof Bun.spawn>,
  name: string,
  source: "stdout" | "stderr",
  display: UpLineStream,
  onLine: UpLineHandler,
  capture?: (line: string) => void,
): void => {
  const pipe = source === "stderr" ? proc.stderr : proc.stdout
  if (!pipe || typeof pipe === "number") return
  const reader = (pipe as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let rest = ""
  const emit = (line: string): void => {
    onLine(name, display, line)
    try {
      capture?.(line)
    } catch {
      // capture must never break the pump
    }
  }
  const loop = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
      const parts = rest.split("\n")
      rest = parts.pop() ?? ""
      for (const line of parts) emit(line)
    }
    const tail = rest + decoder.decode()
    if (tail.length > 0) emit(tail)
  }
  loop().catch(() => undefined)
};

export type UpRunOptions = {
  rootDir: string
  onLine?: UpLineHandler
  shouldStop?: () => boolean
  /** Persisted after spawn and on every child exit (for `ps`/`down`). */
  stateFile?: string
  /** When set, every pumped line is also captured to `<logsDir>/<ad>.jsonl`. */
  logsDir?: string
  /** When present and enabled, an OTLP/HTTP receiver runs for the
   * supervisor's lifetime. Absent → tracing is a no-op (no listener,
   * no `.ow/traces/`, no warnings). Failures are warn-only (D7). */
  trace?: TraceConfig
};

/** Validate all cwds first (zero spawns on failure), probe ports (warn-only),
 * spawn every service plus its `logs:` sibling, stream lines, shut down
 * gracefully on stop. Returns process exit code: 1 only for spontaneous
 * (non-shutdown) failures of main children — `logs:` tails never fail. */
export const runSupervised = async (services: UpService[], options: UpRunOptions): Promise<number> => {
  const onLine = options.onLine ?? (() => undefined)
  for (const svc of services) {
    if (svc.cmd === undefined && svc.logs === undefined) throw new Error(`${svc.name}: cmd ya da logs gerekli`)
  }
  const logsDir = options.logsDir
  if (logsDir) await ensureUpStateDir(logsDir)
  const capture =
    logsDir === undefined
      ? undefined
      : (service: string, stream: "stdout" | "stderr" | "log", line: string): void =>
          appendLogLine(logsDir, service, stream, line)
  const cwds = new Map<string, string | undefined>()
  for (const svc of services) {
    cwds.set(svc.name, await resolveServiceCwd(options.rootDir, svc.cwd))
  }
  // Trace receiver: embedded in the supervisor (D1), started before children
  // so early spans are not missed. Any failure refuses warn-only (D7).
  let traceReceiver: Awaited<ReturnType<typeof startTraceReceiver>> = null
  if (options.trace?.enabled === true) {
    const paths = tracePaths(options.rootDir)
    traceReceiver = await startTraceReceiver({ tracesDir: paths.tracesDir, spansFile: paths.spansFile, port: options.trace.port })
  }
  const children: SpawnedChild[] = []
  const tails: LogTail[] = []
  const portConflicts = new Map<string, boolean>()
  let stopping = false
  const now = () => new Date().toISOString()
  const persist = async (): Promise<void> => {
    if (!options.stateFile) return
    // A fast-exiting tail can trigger persist (via its exit handler) before
    // later services spawn: only spawned units are written, never placeholders.
    const spawned = units.filter((unit) => unit.main !== undefined || unit.tail !== undefined)
    const first = spawned[0]?.main ?? spawned[0]?.tail
    const state = {
      version: 1,
      startedAt: first?.startedAt ?? now(),
      services: spawned.map((unit) => toUnitState(unit.svc, unit.main, unit.tail, portConflicts.get(unit.svc.name) === true)),
    }
    await writeSupervisorState(options.stateFile, state).catch(() => undefined)
  }
  const units: { svc: UpService; main: SpawnedChild | undefined; tail: LogTail | undefined }[] = services.map(
    (svc) => ({ svc, main: undefined, tail: undefined }),
  )
  const unitOf = (name: string): (typeof units)[number] => units.find((unit) => unit.svc.name === name) as (typeof units)[number]
  for (const svc of services) {
    if (svc.port !== undefined && (await probePort(svc.port))) {
      console.error(`uyarı: port çakışması: ${svc.port} dolu (${svc.name} yine de başlatılıyor)`)
      portConflicts.set(svc.name, true)
    }
  }
  for (const svc of services) {
    const cwd = cwds.get(svc.name)
    if (svc.cmd !== undefined) {
      const proc = spawnOne(svc, cwd)
      const lstart = (await readLstart(proc.pid)) ?? ""
      const child: SpawnedChild = { service: svc, proc, lstart, startedAt: now(), exit: null }
      children.push(child)
      unitOf(svc.name).main = child
      pumpLines(proc, svc.name, "stdout", "stdout", onLine, capture ? (line) => capture(svc.name, "stdout", line) : undefined)
      pumpLines(proc, svc.name, "stderr", "stderr", onLine, capture ? (line) => capture(svc.name, "stderr", line) : undefined)
      proc.exited.then((code) => {
        child.exit = { code, signal: null, duringShutdown: stopping }
        void persist()
      }).catch(() => {
        child.exit = { code: null, signal: "unknown", duringShutdown: stopping }
        void persist()
      })
    }
    if (svc.logs !== undefined) {
      const proc = spawnTail(svc, cwd)
      const lstart = (await readLstart(proc.pid)) ?? ""
      const tail: LogTail = { service: svc, proc, lstart, startedAt: now(), exit: null }
      tails.push(tail)
      unitOf(svc.name).tail = tail
      const captureLog = capture ? (line: string): void => capture(svc.name, "log", line) : undefined
      pumpLines(proc, svc.name, "stdout", "log", onLine, captureLog)
      pumpLines(proc, svc.name, "stderr", "log", onLine, captureLog)
      proc.exited.then((code) => {
        tail.exit = { code, duringShutdown: stopping }
        if (!stopping && capture) {
          capture(svc.name, "event", `logs komutu bitti (code=${code ?? "?"})`)
        }
        if (!stopping) console.error(`uyarı: ${svc.name} logs komutu bitti (code=${code ?? "?"})`)
        void persist()
      }).catch(() => {
        tail.exit = { code: null, duringShutdown: stopping }
        void persist()
      })
    }
  }
  await persist()
  type Stoppable = { proc: ReturnType<typeof Bun.spawn>; lstart: string; done: () => boolean; markKilled: () => void }
  const stopEntries = async (entries: Stoppable[]): Promise<void> => {
    for (const entry of entries) {
      if (entry.done()) continue
      // lstart-gated like the SIGKILL path: never signal a recycled pid.
      // A pid that died on its own is left for its exit handler.
      if (!(await isLivePid(entry.proc.pid, entry.lstart))) continue
      try {
        entry.proc.kill("SIGTERM")
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5000
    for (const entry of entries) {
      for (;;) {
        if (entry.done()) break
        if (Date.now() > deadline) break
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
      }
      if (!entry.done()) {
        const live = await isLivePid(entry.proc.pid, entry.lstart)
        if (live) {
          try {
            entry.proc.kill("SIGKILL")
          } catch {
            // gone
          }
        }
        entry.markKilled()
      }
    }
  }
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await stopEntries([
      ...children.map(
        (child): Stoppable => ({
          proc: child.proc,
          lstart: child.lstart,
          done: () => child.exit !== null,
          markKilled: () => {
            child.exit = child.exit ?? { code: null, signal: "SIGKILL", duringShutdown: true }
          },
        }),
      ),
      ...tails.map(
        (tail): Stoppable => ({
          proc: tail.proc,
          lstart: tail.lstart,
          done: () => tail.exit !== null,
          markKilled: () => {
            tail.exit = tail.exit ?? { code: null, duringShutdown: true }
          },
        }),
      ),
    ])
  }
  const onSignal = (): void => {
    void stop()
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  try {
    for (;;) {
      if (options.shouldStop?.()) {
        await stop()
        break
      }
      if (children.length > 0 && children.every((child) => child.exit)) break
      if (children.length === 0 && tails.every((tail) => tail.exit)) break
      if (children.length === 0 && tails.length === 0) break
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    }
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
  await stop()
  // The receiver's lifetime equals the supervisor's: shut down with the
  // children, before the log flush.
  await traceReceiver?.stop().catch(() => undefined)
  traceReceiver = null
  if (logsDir) await flushUpLogs()
  await persist()
  const spontaneous = children.filter(
    (child) => child.exit && !child.exit.duringShutdown && (child.exit.code !== 0 || child.exit.signal),
  )
  return spontaneous.length > 0 ? 1 : 0
};

const toUnitState = (svc: UpService, main: SpawnedChild | undefined, tail: LogTail | undefined, portConflict = false): UpServiceState => {
  const primary = main ?? tail
  if (!primary) throw new Error(`${svc.name}: izlenecek süreç yok`)
  return {
    name: svc.name,
    pid: primary.proc.pid,
    lstart: primary.lstart,
    startedAt: primary.startedAt,
    ...(typeof svc.cmd !== "undefined" ? { cmd: svc.cmd } : {}),
    ...(typeof svc.cwd !== "undefined" ? { cwd: svc.cwd } : {}),
    ...(typeof svc.port !== "undefined" ? { port: svc.port } : {}),
    ...(typeof svc.logs !== "undefined" ? { logsCmd: svc.logs } : {}),
    ...(tail ? { logsPid: tail.proc.pid, logsLstart: tail.lstart } : {}),
    ...(tail?.exit ? { logsEnded: { code: tail.exit.code, at: new Date().toISOString() } } : {}),
    ...(portConflict ? { portConflict: true as const } : {}),
    ...(main?.exit ? { exitCode: main.exit.code ?? -1, exitedAt: new Date().toISOString() } : {}),
  }
}

export const toServiceState = (child: SpawnedChild): UpServiceState => toUnitState(child.service, child, undefined)

export type DownResult = { name: string; stopped: boolean; note: string }

export type DownOutcome = { results: DownResult[]; warnings: string[]; clearedLock: boolean; removedState: boolean }

/** Full `down`: lstart-matched children first, then the supervisor itself
 * (lstart-verified, never self), final state reflects stopped services, lock
 * file cleared last. `rm` also removes supervisor.json; logs always kept. */
export const downAll = async (rootDir: string, rm = false): Promise<DownOutcome> => {
  const warnings: string[] = []
  const paths = upPaths(rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  const lock = await readLock(paths.lockFile)
  const results: DownResult[] = []
  if (state) {
    for (const svc of state.services) {
      results.push(await stopOne(svc))
    }
  }
  if (lock && lock.pid !== process.pid && (await isLivePid(lock.pid, lock.lstart))) {
    try {
      process.kill(lock.pid, "SIGTERM")
      let gone = false
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
        if (!(await isLivePid(lock.pid, lock.lstart))) {
          gone = true
          break
        }
      }
      if (!gone) warnings.push("uyarı: supervisor durmuyor, kilit yine de temizlendi")
    } catch {
      // already gone
    }
  }
  if (state && !rm) {
    const now = new Date().toISOString()
    let dirty = false
    for (const svc of state.services) {
      if (svc.exitCode === undefined && !(await isLivePid(svc.pid, svc.lstart))) {
        svc.exitCode = -1
        svc.exitedAt = now
        dirty = true
      }
    }
    if (dirty) await writeSupervisorState(paths.supervisorFile, state).catch(() => undefined)
  }
  await clearLock(paths.lockFile)
  let removedState = false
  if (rm) {
    const { unlink } = await import("node:fs/promises")
    try {
      await unlink(paths.supervisorFile)
      removedState = true
    } catch {
      // already gone
    }
  }
  return { results, warnings, clearedLock: lock !== null, removedState }
};

type StopStatus = "already" | "stopped" | "refused"

/** SIGTERM → 5 s grace → SIGKILL on one lstart-verified pid. `already` means
 * it was dead before we acted (or vanished mid-sequence); `refused` means it
 * survived SIGKILL. Never signals a mismatched/unreadable lstart. */
const stopPid = async (pid: number, lstart: string): Promise<StopStatus> => {
  if (!(await isLivePid(pid, lstart))) return "already"
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return "already"
  }
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    if (!(await isLivePid(pid, lstart))) return "stopped"
  }
  if (await isLivePid(pid, lstart)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      return "already"
    }
    return (await isLivePid(pid, lstart)) ? "refused" : "stopped"
  }
  return "stopped"
};

const stopOne = async (svc: UpServiceState): Promise<DownResult> => {
  // `logs:` sibling dies with the parent first (same lstart guard; a recorded
  // `logsEnded` means our tail already exited, so its pid is never signaled —
  // it may be recycled by now). A logs-only service records the tail pid as
  // the main pid too; the `logsPid !== pid` guard avoids double-signaling it.
  if (svc.logsPid !== undefined && svc.logsEnded === undefined && svc.logsPid !== svc.pid) {
    const tail = await stopPid(svc.logsPid, svc.logsLstart ?? "")
    if (tail === "refused") return { name: svc.name, stopped: false, note: "logs kuyruğu durmuyor" }
    if (tail === "stopped") {
      if (svc.exitCode !== undefined) return { name: svc.name, stopped: true, note: "durduruldu" }
      const main = await stopPid(svc.pid, svc.lstart)
      if (main === "refused") return { name: svc.name, stopped: false, note: "durmuyor" }
      return { name: svc.name, stopped: true, note: "durduruldu" }
    }
  }
  if (svc.exitCode !== undefined) return { name: svc.name, stopped: true, note: "zaten bitmiş" }
  const main = await stopPid(svc.pid, svc.lstart)
  if (main === "already") return { name: svc.name, stopped: true, note: "çalışmıyor" }
  if (main === "stopped") return { name: svc.name, stopped: true, note: "durduruldu" }
  return { name: svc.name, stopped: false, note: "durmuyor" }
};
