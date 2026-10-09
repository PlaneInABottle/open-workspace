/** Process supervision: pre-spawn validation, line-buffered capture, graceful
 * shutdown, `down` with lstart-guarded signals. No restart, no healthchecks
 * (v1 non-goals). Lines stream to the caller and persist per-service JSONL
 * via `up-logs` (M3); `logs:` tails run as supervisor siblings (M3/D4). */

import { lstat } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { TraceConfig, UpService } from "./up-schema"
import { decodeUtf8Fatal, parseUpFile } from "./up-schema"
import { maskCmdShape } from "./up-reconcile"
import type { ExecFn, Provenance } from "./up-provenance"
import { recordProvenance } from "./up-provenance"
import { completeRequest, scanRequests, sweepStaleResults, type ServiceRequest, type ServiceResult } from "./up-requests"
import { appendLogLine, flushUpLogs } from "./up-logs"
import { startTraceReceiver } from "./trace-receiver"
import { tracePaths } from "./trace-store"
import { clearLock, classifySupervisorFile, ensureUpStateDir, isLivePid, readLock, readLstart, readOwnBuildSidecar, readSupervisorState, upPaths, writeSupervisorState } from "./up-state"
import type { UpBuildInfo, UpServiceState } from "./up-state"

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

/** One supervised service slot: fresh config plus its live handles. */
export type LiveUnit = {
  svc: UpService
  main: SpawnedChild | undefined
  tail: LogTail | undefined
  /** M2 spawn-time provenance (best-effort; absent when recording failed). */
  provenance?: Provenance
}

/** Live-supervisor execution context for M1 service requests (B1: the
 * supervisor executes, persists, and answers; the client only writes the
 * request and collects the result). */
export type SupervisorCtx = {
  rootDir: string
  owFile: string
  units: LiveUnit[]
  children: SpawnedChild[]
  tails: LogTail[]
  retiring: Set<object>
  spawnUnit: (svc: UpService, cwd: string | undefined, probeFirst: boolean) => Promise<void>
  persist: () => Promise<void>
}

/** Resolve + validate cwd against the ow.yaml dir. Symlink-escaped targets rejected; throws Turkish usage error. */export const resolveServiceCwd = async (rootDir: string, cwd: string | undefined): Promise<string | undefined> => {
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
  /** M1 request channel: when set, the supervisor loop scans this dir FIFO
   * (100ms) and executes `up/restart/down <svc>` itself — the sole writer
   * while live (B1). Unset (tests, one-shot runs) disables the scan. */
  requestsDir?: string
  /** ow.yaml path the request handler re-parses (defaults to
   * `<rootDir>/ow.yaml`). Threaded from the original `--file`. */
  owFile?: string
  /** M2 provenance exec override (default: real git/lsof, best-effort).
   * Tests inject a counting fake to prove the spawn path observes while
   * the ps path never executes. */
  provenanceExec?: ExecFn
  /** Build identity recorded into supervisor state. Explicit value wins
   * (lets embedders/tests pin it); `undefined` reads the running binary's
   * sidecar, `null`/missing sidecar records nothing. */
  build?: UpBuildInfo | null
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
  // Build identity for supervisor state: explicit option wins, otherwise
  // the running binary's sidecar (absent under dev/test runners → nothing
  // recorded, never a failure). Resolved once; every persist carries it.
  const build = options.build !== undefined ? options.build : await readOwnBuildSidecar()
  const children: SpawnedChild[] = []
  const tails: LogTail[] = []
  const portConflicts = new Map<string, boolean>()
  let stopping = false
  /** Restart/down victims: their exits are supervisor-induced, never
   * spontaneous failures (and never `logs komutu bitti` noise). */
  const retiring = new Set<object>()
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
      services: spawned.map((unit) => toUnitState(unit.svc, unit.main, unit.tail, portConflicts.get(unit.svc.name) === true, unit.provenance)),
      ...(build === null ? {} : { build }),
    }
    // Merge-on-write (M3): an exit handler may have persisted behind our
    // back; never clobber its settled fields with our older snapshot.
    await persistMerged(options.stateFile, state).catch(() => undefined)
  }
  const units: LiveUnit[] = services.map((svc) => ({ svc, main: undefined, tail: undefined }))
  const unitOf = (name: string): LiveUnit | undefined => units.find((unit) => unit.svc.name === name)
  const unitOfOrThrow = (name: string): LiveUnit => unitOf(name) as LiveUnit
  for (const svc of services) {
    if (svc.port !== undefined && (await probePort(svc.port))) {
      console.error(`uyarı: port çakışması: ${svc.port} dolu (${svc.name} yine de başlatılıyor)`)
      portConflicts.set(svc.name, true)
    }
  }
  /** Spawn one service's main child and/or `logs:` sibling into its unit
   * slot (M1: initial spawn and live `up/restart <svc>` share this path).
   * `probeFirst` runs the warn-only port probe (live path); the initial
   * path probes up-front instead, so each service still warns exactly once. */
  const spawnUnit = async (svc: UpService, cwd: string | undefined, probeFirst: boolean): Promise<void> => {
    if (probeFirst && svc.port !== undefined && (await probePort(svc.port))) {
      console.error(`uyarı: port çakışması: ${svc.port} dolu (${svc.name} yine de başlatılıyor)`)
      portConflicts.set(svc.name, true)
    }
    if (svc.cmd !== undefined) {
      const proc = spawnOne(svc, cwd)
      const lstart = (await readLstart(proc.pid)) ?? ""
      const child: SpawnedChild = { service: svc, proc, lstart, startedAt: now(), exit: null }
      children.push(child)
      unitOfOrThrow(svc.name).main = child
      pumpLines(proc, svc.name, "stdout", "stdout", onLine, capture ? (line) => capture(svc.name, "stdout", line) : undefined)
      pumpLines(proc, svc.name, "stderr", "stderr", onLine, capture ? (line) => capture(svc.name, "stderr", line) : undefined)
      proc.exited.then((code) => {
        child.exit = { code, signal: null, duringShutdown: stopping || retiring.has(child) }
        void persist()
      }).catch(() => {
        child.exit = { code: null, signal: "unknown", duringShutdown: stopping || retiring.has(child) }
        void persist()
      })
    }
    if (svc.logs !== undefined) {
      const proc = spawnTail(svc, cwd)
      const lstart = (await readLstart(proc.pid)) ?? ""
      const tail: LogTail = { service: svc, proc, lstart, startedAt: now(), exit: null }
      tails.push(tail)
      unitOfOrThrow(svc.name).tail = tail
      const captureLog = capture ? (line: string): void => capture(svc.name, "log", line) : undefined
      pumpLines(proc, svc.name, "stdout", "log", onLine, captureLog)
      pumpLines(proc, svc.name, "stderr", "log", onLine, captureLog)
      proc.exited.then((code) => {
        tail.exit = { code, duringShutdown: stopping || retiring.has(tail) }
        if (!stopping && !retiring.has(tail) && capture) {
          capture(svc.name, "event", `logs komutu bitti (code=${code ?? "?"})`)
        }
        if (!stopping && !retiring.has(tail)) console.error(`uyarı: ${svc.name} logs komutu bitti (code=${code ?? "?"})`)
        void persist()
      }).catch(() => {
        tail.exit = { code: null, duringShutdown: stopping || retiring.has(tail) }
        void persist()
      })
    }
    // M2 spawn-time provenance (best-effort, never fails the spawn): git +
    // lsof run here — and ONLY here on the supervisor side — plus local
    // readdir; every failure degrades to an omitted field.
    try {
      const unit = unitOfOrThrow(svc.name)
      const pid = unit.main?.proc.pid ?? unit.tail?.proc.pid
      unit.provenance = await recordProvenance({
        svc,
        cwdAbs: cwd ?? resolve(options.rootDir),
        ...(pid === undefined ? {} : { pid }),
        ...(options.provenanceExec === undefined ? {} : { exec: options.provenanceExec }),
      })
    } catch {
      // recording must never break the spawn
    }
  }
  for (const svc of services) {
    await spawnUnit(svc, cwds.get(svc.name), false)
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
  // M1 request channel (B1): the live supervisor is the sole executor.
  const requestsDir = options.requestsDir
  const owFile = options.owFile ?? join(options.rootDir, "ow.yaml")
  if (requestsDir) {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(requestsDir, "results"), { recursive: true, mode: 0o700 }).catch(() => undefined)
  }
  const ctx: SupervisorCtx = { rootDir: options.rootDir, owFile, units, children, tails, retiring, spawnUnit, persist }
  let scans = 0
  try {
    for (;;) {
      if (options.shouldStop?.()) {
        await stop()
        break
      }
      if (requestsDir) {
        for (const { file, request } of await scanRequests(requestsDir)) {
          try {
            const result = await processServiceRequest(ctx, request)
            await completeRequest(requestsDir, file, result)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await completeRequest(requestsDir, file, {
              action: request.action,
              service: request.service,
              nonce: request.nonce,
              ok: false,
              code: "refused",
              message: `ow: ${message}`,
            }).catch(() => undefined)
          }
        }
        // L-1 TTL sweep, throttled (~60s): client leftovers never accumulate.
        scans += 1
        if (scans % 600 === 0) await sweepStaleResults(requestsDir).catch(() => undefined)
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

/** Merge-on-write: `persist` (spawn/exit path) and `down` (final mark path)
 * both rewrite the whole file, so each re-reads first and preserves settled
 * fields the in-memory copy never saw (`exitCode`/`exitedAt`,
 * `logsEnded`). Name-keyed union: on-disk-only services are kept (never
 * dropped), defined-wins per field, and process-bound facts (`exitCode`/
 * `exitedAt`, `logsEnded`, `lstartUnknown`, `logsPid`/`logsLstart`,
 * `portConflict`, `envNames`/`dependsOn`) are only inherited when the
 * process identity (pid+lstart) matches — a respawned service never
 * inherits its predecessor's settlement, stale liveness flags, recycled
 * handles, or phantom config (the latter would fake `config-farklı`
 * drift). An inherited `cmd`/`logsCmd` is re-masked (B3). `startedAt`
 * likewise follows the fresh record on identity change. No new lock
 * files — the supervisor is the sole writer while live, `down` only marks
 * the dead. */
export const mergePreservingSettled = (onDisk: UpServiceState[], fresh: UpServiceState[]): UpServiceState[] => {
  const diskByName = new Map(onDisk.map((svc) => [svc.name, svc]))
  const freshNames = new Set(fresh.map((svc) => svc.name))
  const merged = fresh.map((svc) => {
    const prior = diskByName.get(svc.name)
    if (!prior) return svc
    const sameIdentity = prior.pid === svc.pid && prior.lstart === svc.lstart
    const out: UpServiceState = { ...svc }
    // Defined-wins for every optional field the fresh record omits — but
    // never across an identity change for process-bound facts: a respawned
    // service starts clean, or stale flags/handles/config would haunt the
    // new process (resurrected settlement, phantom `lstartUnknown`, a
    // recycled `logsPid`, a `portConflict` that predates the new bind, or
    // `envNames`/`dependsOn` faking a `config-farklı` drift in reconcile,
    // or `provenance` haunting a new pid with the old process's checkout).
    const staleOnRespawn: ReadonlySet<keyof UpServiceState> = new Set([
      "exitCode",
      "exitedAt",
      "logsEnded",
      "lstartUnknown",
      "logsPid",
      "logsLstart",
      "portConflict",
      "envNames",
      "dependsOn",
      "provenance",
    ])
    for (const [key, value] of Object.entries(prior) as [keyof UpServiceState, unknown][]) {
      if ((out as Record<string, unknown>)[key as string] === undefined && value !== undefined) {
        if (!sameIdentity && staleOnRespawn.has(key)) continue
        ;(out as Record<string, unknown>)[key as string] = value
      }
    }
    // L-3: an inherited `cmd`/`logsCmd` is re-masked (legacy records may
    // predate masked-shape recording; secret values never linger in state).
    if (typeof out.cmd === "string") out.cmd = maskCmdShape(out.cmd) ?? out.cmd
    if (typeof out.logsCmd === "string") out.logsCmd = maskCmdShape(out.logsCmd) ?? out.logsCmd
    // `startedAt` follows the process: same identity keeps the original
    // boot time (down-path stale snapshots must not rewind it), a new
    // identity takes the fresh spawn time.
    if (sameIdentity && prior.startedAt !== undefined) out.startedAt = prior.startedAt
    return out
  })
  for (const svc of onDisk) {
    if (!freshNames.has(svc.name)) merged.push(svc)
  }
  return merged
}

/** Read-modify-write with settlement preservation; missing/corrupt on-disk
 * state falls back to a plain write (callers own the fail-closed decision).
 * A recorded build block survives from either side (fresh wins, else kept). */
export const persistMerged = async (supervisorFile: string, state: { version: 1; startedAt: string; services: UpServiceState[]; build?: UpBuildInfo }): Promise<void> => {
  const onDisk = await readSupervisorState(supervisorFile)
  if (!onDisk) {
    await writeSupervisorState(supervisorFile, state)
    return
  }
  const build = state.build ?? onDisk.build
  await writeSupervisorState(supervisorFile, {
    ...state,
    startedAt: onDisk.startedAt,
    services: mergePreservingSettled(onDisk.services, state.services),
    ...(build === undefined ? {} : { build }),
  })
}

/** Spawn-time record: an empty `lstart` means `readLstart` failed at spawn,
 * so the pid guard is blind for this unit — recorded as `lstartUnknown` so
 * `down` refuses (never reports success) and `ps` shows unknown.
 * B3: `cmd`/`logsCmd` land masked-shape-only (secret values never reach
 * state); `envNames` carries key names only. Masking is deterministic, so
 * `reconcile --check` can still compare expected vs running shapes. */
const toUnitState = (svc: UpService, main: SpawnedChild | undefined, tail: LogTail | undefined, portConflict = false, provenance?: Provenance): UpServiceState => {
  const primary = main ?? tail
  if (!primary) throw new Error(`${svc.name}: izlenecek süreç yok`)
  const maskedCmd = maskCmdShape(svc.cmd)
  const maskedLogs = svc.logs === undefined ? undefined : (maskCmdShape(svc.logs) ?? svc.logs)
  const envNames = svc.env === undefined && svc.requiredEnv === undefined ? undefined : [...new Set([...Object.keys(svc.env ?? {}), ...(svc.requiredEnv ?? [])])].sort()
  return {
    name: svc.name,
    pid: primary.proc.pid,
    lstart: primary.lstart,
    startedAt: primary.startedAt,
    ...(maskedCmd === undefined ? {} : { cmd: maskedCmd }),
    ...(typeof svc.cwd !== "undefined" ? { cwd: svc.cwd } : {}),
    ...(typeof svc.port !== "undefined" ? { port: svc.port } : {}),
    ...(typeof maskedLogs !== "undefined" ? { logsCmd: maskedLogs } : {}),
    ...(tail ? { logsPid: tail.proc.pid, logsLstart: tail.lstart } : {}),
    ...(tail?.exit ? { logsEnded: { code: tail.exit.code, at: new Date().toISOString() } } : {}),
    ...(portConflict ? { portConflict: true as const } : {}),
    ...(main?.exit ? { exitCode: main.exit.code ?? -1, exitedAt: new Date().toISOString() } : {}),
    ...(primary.lstart === "" ? { lstartUnknown: true as const } : {}),
    ...(envNames === undefined ? {} : { envNames }),
    ...(svc.dependsOn === undefined ? {} : { dependsOn: [...svc.dependsOn] }),
    ...(provenance === undefined ? {} : { provenance }),
  }
}

export const toServiceState = (child: SpawnedChild): UpServiceState => toUnitState(child.service, child, undefined)

/** Live children of a dead supervisor. Refuse-with-message is chosen over
 * adoption: attaching to foreign pids without the original supervisor's
 * shutdown wiring risks double-signaling and pid confusion — `ow down`
 * (lstart-verified) is the explicit, safe path. Entries with an empty
 * `lstart` or a recorded `exitCode` are skipped: the former is unverifiable
 * (H5 unknown), the latter is already settled. */
export const findLiveOrphans = async (rootDir: string): Promise<UpServiceState[]> => {
  const paths = upPaths(rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  if (!state) return []
  const orphans: UpServiceState[] = []
  for (const svc of state.services) {
    if (svc.exitCode !== undefined || svc.lstart === "") continue
    if (await isLivePid(svc.pid, svc.lstart)) orphans.push(svc)
  }
  return orphans
}

/** Throw a Turkish usage error naming live orphans, or resolve silently. */
export const assertNoLiveOrphans = async (rootDir: string): Promise<void> => {
  const orphans = await findLiveOrphans(rootDir)
  if (orphans.length === 0) return
  const names = orphans.map((svc) => `${svc.name} (pid ${svc.pid})`).join(", ")
  throw new Error(`yetim süreçler çalışıyor: ${names} — önce \`ow down\` ile durdurun (eski supervisor ölü; ölü kalıntıysa \`ow down --rm\`)`)
}

export type DownResult = { name: string; stopped: boolean; note: string }

export type DownOutcome = { results: DownResult[]; warnings: string[]; clearedLock: boolean; removedState: boolean }

/** Full `down`: lstart-matched children first, then the supervisor itself
 * (lstart-verified, never self), final state reflects stopped services, lock
 * file cleared last. `rm` also removes supervisor.json; logs always kept. */
export const downAll = async (rootDir: string, rm = false): Promise<DownOutcome> => {
  const warnings: string[] = []
  const paths = upPaths(rootDir)
  // Classify first (M1): a present-but-unparseable file must fail closed
  // here too, not read as empty with a cleared lock. `--rm` bypasses: it is
  // the explicit cleanup path for exactly this situation.
  if (!rm) {
    const fileStatus = await classifySupervisorFile(paths.supervisorFile)
    if (fileStatus === "corrupt") throw new Error("supervisor.json bozuk — `down --rm` ile temizleyin")
    if (fileStatus === "bad-version") throw new Error("supervisor.json sürüm uyuşmazlığı — `down --rm` ile temizleyin")
  }
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
      if (svc.exitCode === undefined && svc.lstart !== "" && !(await isLivePid(svc.pid, svc.lstart))) {
        svc.exitCode = -1
        svc.exitedAt = now
        dirty = true
      }
    }
    // Merge-on-write (M3): the supervisor may have persisted behind our
    // back; re-read and preserve its newer settlements. Unknown-lstart
    // units are never marked dead here: the guard is blind for them.
    if (dirty) await persistMerged(paths.supervisorFile, state).catch(() => undefined)
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
 * survived SIGKILL — or its `lstart` is empty (unknown): an unverifiable pid
 * is never signaled and never reported as stopped (H5). Never signals a
 * mismatched/unreadable lstart. */
const stopPid = async (pid: number, lstart: string): Promise<StopStatus> => {
  if (lstart === "") return "refused"
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

/** Single-service stop over a recorded state entry (exported: `ow down
 * <svc>` reuses the same lstart guard; the guard itself is untouched). */
export const stopOne = async (svc: UpServiceState): Promise<DownResult> => {
  // Empty `lstart` (spawn-time `readLstart` failure) means the pid guard is
  // blind: refusing loudly beats the old false `stopped: true` on a process
  // that may still be live. The process is deliberately left untouched.
  if (svc.lstart === "") {
    return { name: svc.name, stopped: false, note: "lstart bilinmiyor — güvenli durdurma yok (pid doğrulanamaz)" }
  }
  // `logs:` sibling dies with the parent first (same lstart guard; a recorded
  // `logsEnded` means our tail already exited, so its pid is never signaled —
  // it may be recycled by now). A logs-only service records the tail pid as
  // the main pid too; the `logsPid !== pid` guard avoids double-signaling it.
  if (svc.logsPid !== undefined && svc.logsEnded === undefined && svc.logsPid !== svc.pid) {
    if ((svc.logsLstart ?? "") === "") {
      return { name: svc.name, stopped: false, note: "logs lstart bilinmiyor — güvenli durdurma yok" }
    }
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

/** Drop a unit's dead handles from the supervisor's wait lists so a
 * respawned slot is waited on exactly once (the exit tally stays honest). */
const pruneUnitHandles = (ctx: SupervisorCtx, unit: LiveUnit): void => {
  if (unit.main) {
    const index = ctx.children.indexOf(unit.main)
    if (index >= 0) ctx.children.splice(index, 1)
    unit.main = undefined
  }
  if (unit.tail) {
    const index = ctx.tails.indexOf(unit.tail)
    if (index >= 0) ctx.tails.splice(index, 1)
    unit.tail = undefined
  }
}

const unitIsLive = async (unit: LiveUnit): Promise<boolean> => {
  if (unit.main && unit.main.lstart !== "" && (await isLivePid(unit.main.proc.pid, unit.main.lstart))) return true
  if (unit.tail && !unit.tail.exit && unit.tail.lstart !== "" && (await isLivePid(unit.tail.proc.pid, unit.tail.lstart))) return true
  return false
}

const unitLstartUnknown = (unit: LiveUnit): boolean =>
  (unit.main !== undefined && unit.main.lstart === "") || (unit.tail !== undefined && !unit.tail.exit && (unit.tail.lstart ?? "") === "")

/** Execute one M1 service request inside the live supervisor (sole writer).
 * Healthy units are never touched: `up` spawns only into a free slot,
 * `restart`/`down` signal only the target's lstart-verified pids. Every
 * path ends with `persist()`; the caller publishes the returned result. */
export const processServiceRequest = async (ctx: SupervisorCtx, request: ServiceRequest): Promise<ServiceResult> => {
  const fail = (code: string, message: string): ServiceResult => ({ action: request.action, service: request.service, nonce: request.nonce, ok: false, code, message })
  let services: UpService[]
  try {
    const { readFileSync } = await import("node:fs")
    services = parseUpFile(decodeUtf8Fatal(readFileSync(ctx.owFile))).services
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail("invalid-config", `ow: geçersiz ow.yaml: ${message}`)
  }
  const svc = services.find((entry) => entry.name === request.service)
  if (!svc) {
    const known = services.map((entry) => entry.name).join(", ")
    return fail("unknown-service", `ow: bilinmeyen servis: ${request.service}${known.length > 0 ? ` (bilinenler: ${known})` : ""}`)
  }
  const existing = ctx.units.find((unit) => unit.svc.name === request.service)
  if (request.action === "up") {
    if (existing && (await unitIsLive(existing))) {
      const pid = existing.main?.proc.pid ?? existing.tail?.proc.pid ?? 0
      return { action: request.action, service: request.service, nonce: request.nonce, ok: false, code: "already-running", message: `zaten çalışıyor: ${request.service} (pid ${pid})`, pid }
    }
    // Blind unit (spawn-time `readLstart` failure): the guard cannot verify
    // the recorded pid, so the slot is never treated as free — spawning
    // here would orphan the blind child and duplicate the service. Report
    // already-running (exit 2, no spawn), never prune + respawn.
    if (existing && unitLstartUnknown(existing)) {
      const pid = existing.main?.proc.pid ?? existing.tail?.proc.pid ?? 0
      return { action: request.action, service: request.service, nonce: request.nonce, ok: false, code: "already-running", message: `zaten çalışıyor olabilir: ${request.service} (pid ${pid}, lstart bilinmiyor — doğrulanamaz, spawn yapılmadı)`, pid }
    }
    let cwd: string | undefined
    try {
      cwd = await resolveServiceCwd(ctx.rootDir, svc.cwd)
    } catch (error) {
      return fail("invalid-config", `ow: ${error instanceof Error ? error.message : String(error)}`)
    }
    let unit = existing
    if (!unit) {
      unit = { svc, main: undefined, tail: undefined }
      ctx.units.push(unit)
    } else {
      pruneUnitHandles(ctx, unit)
    }
    unit.svc = svc
    await ctx.spawnUnit(svc, cwd, true)
    await ctx.persist()
    const live = ctx.units.find((unit) => unit.svc.name === request.service) as LiveUnit
    const pid = live.main?.proc.pid ?? live.tail?.proc.pid ?? 0
    return { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "started", message: `başlatıldı: ${request.service} (pid ${pid})`, pid }
  }
  if (request.action === "restart") {
    if (!existing) {
      // Unknown to the live supervisor but declared: start it (same as up).
      let cwd: string | undefined
      try {
        cwd = await resolveServiceCwd(ctx.rootDir, svc.cwd)
      } catch (error) {
        return fail("invalid-config", `ow: ${error instanceof Error ? error.message : String(error)}`)
      }
      const unit: LiveUnit = { svc, main: undefined, tail: undefined }
      ctx.units.push(unit)
      await ctx.spawnUnit(svc, cwd, true)
      await ctx.persist()
      const pid = unit.main?.proc.pid ?? unit.tail?.proc.pid ?? 0
      return { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "started", message: `başlatıldı: ${request.service} (pid ${pid})`, pid }
    }
    if (unitLstartUnknown(existing)) {
      return fail("refused", `güvenli durdurma yok: ${request.service} (lstart bilinmiyor — pid doğrulanamaz)`)
    }
    const oldPid = existing.main?.proc.pid ?? existing.tail?.proc.pid ?? 0
    if (existing.main && (await isLivePid(existing.main.proc.pid, existing.main.lstart))) {
      ctx.retiring.add(existing.main)
      const stopped = await stopPid(existing.main.proc.pid, existing.main.lstart)
      if (stopped === "refused") return fail("refused", `durmuyor: ${request.service} (pid ${oldPid})`)
    }
    if (existing.tail && !existing.tail.exit && existing.tail.proc.pid !== oldPid) {
      if ((existing.tail.lstart ?? "") === "") return fail("refused", `güvenli durdurma yok: ${request.service} (logs lstart bilinmiyor)`)
      if (await isLivePid(existing.tail.proc.pid, existing.tail.lstart)) {
        ctx.retiring.add(existing.tail)
        const stopped = await stopPid(existing.tail.proc.pid, existing.tail.lstart)
        if (stopped === "refused") return fail("refused", `durmuyor: ${request.service} (logs kuyruğu)`)
      }
    }
    let cwd: string | undefined
    try {
      cwd = await resolveServiceCwd(ctx.rootDir, svc.cwd)
    } catch (error) {
      return fail("invalid-config", `ow: ${error instanceof Error ? error.message : String(error)}`)
    }
    pruneUnitHandles(ctx, existing)
    existing.svc = svc
    await ctx.spawnUnit(svc, cwd, true)
    await ctx.persist()
    const pid = existing.main?.proc.pid ?? existing.tail?.proc.pid ?? 0
    return { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "restarted", message: `yeniden başlatıldı: ${request.service} (pid ${oldPid} → ${pid})`, pid }
  }
  // down: stop only the target, keep its settled record for ps/reconcile.
  if (!existing) {
    return { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "already-stopped", message: `çalışmıyor: ${request.service}` }
  }
  if (unitLstartUnknown(existing)) {
    return fail("refused", `güvenli durdurma yok: ${request.service} (lstart bilinmiyor — pid doğrulanamaz)`)
  }
  let touched = false
  if (existing.main && (await isLivePid(existing.main.proc.pid, existing.main.lstart))) {
    ctx.retiring.add(existing.main)
    const stopped = await stopPid(existing.main.proc.pid, existing.main.lstart)
    if (stopped === "refused") return fail("refused", `durmuyor: ${request.service}`)
    touched = true
  }
  if (existing.tail && !existing.tail.exit && existing.tail.proc.pid !== (existing.main?.proc.pid ?? -1)) {
    if ((existing.tail.lstart ?? "") === "") return fail("refused", `güvenli durdurma yok: ${request.service} (logs lstart bilinmiyor)`)
    if (await isLivePid(existing.tail.proc.pid, existing.tail.lstart)) {
      ctx.retiring.add(existing.tail)
      const stopped = await stopPid(existing.tail.proc.pid, existing.tail.lstart)
      if (stopped === "refused") return fail("refused", `durmuyor: ${request.service} (logs kuyruğu)`)
      touched = true
    }
  }
  await ctx.persist()
  return touched
    ? { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "stopped", message: `durduruldu: ${request.service}` }
    : { action: request.action, service: request.service, nonce: request.nonce, ok: true, code: "already-stopped", message: `çalışmıyor: ${request.service}` }
};
