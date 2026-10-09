/** Supervisor state under `<root>/.ow/`: atomic JSON + lock with PID-reuse guard.
 * Every stored pid is paired with its `lstart` string captured at spawn; any
 * later signal path re-reads `lstart` and treats mismatch as stale/dead.
 * Small local copies of the observer-core dir/file discipline (attribution:
 * `shell-observer-core.ts` privateDirectory/replaceLog shape). */

import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { closeSync, openSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { Provenance } from "./up-provenance"

export const UP_STATE_VERSION = 1

export type UpServiceState = {
  name: string
  pid: number
  lstart: string
  startedAt: string
  cmd?: string | string[]
  cwd?: string
  port?: number
  logsCmd?: string
  logsPid?: number
  logsLstart?: string
  logsEnded?: { code: number | null; at: string }
  portConflict?: boolean
  exitCode?: number
  exitedAt?: string
  /** Spawn-time `readLstart` failure marker: the pid guard is blind for this
   * unit, so `down`/`ps` must treat it as unknown, never as stoppable/dead. */
  lstartUnknown?: boolean
  /** Spawn-time recorded env KEY names (values never stored) + declared
   * `depends_on`, for M1 `reconcile --check` config drift. Absent on older
   * records: the compare skips rather than drifting. */
  envNames?: string[]
  dependsOn?: string[]
  /** M2 spawn-time provenance (observed/inferred, ham argv yok). Absent on
   * older records and on best-effort recording failure. */
  provenance?: Provenance
  /** M3 last-known readiness (P2-B tolerant okur; yoksa `not_observed`).
   * Yalnızca istemci-tarafı probe kayıtları yazar (supervisor asla
   * çalıştırmaz); respawn'da diriltilmez (aşağıdaki skip-listesi). */
  lastReadiness?: {
    ok: boolean
    note?: string
    at: string
    kind?: string
  }
  /** M-C probe-beyanlı derleme kimliği: basename → tam-digest (ham;
   * tel/insan YALNIZCA basename + kısa-8 indirgenmiş görür). Yalnızca
   * supervisor istek-kanalı yazar (tek-yazar); respawn'da diriltilmez
   * (ölü pid'in yüklediği derleme yeni pid'e bulaşmaz). */
  artifactDigests?: Record<string, string>
}

/** M-C: servis-başı derleme-harita cap'i (önerilen 200 — kilitli). */
export const ARTIFACT_DIGESTS_MAX = 200

export type UpSupervisorState = {
  version: number
  startedAt: string
  services: UpServiceState[]
  /** Build identity of the binary that started this supervisor, copied from
   * its `ow.build.json` sidecar. Absent when the sidecar was unreadable
   * (dev runs, missing file) — never a failure. */
  build?: UpBuildInfo
}

/** Build identity stamped into the binary at `pnpm ow:build` time. */
export type UpBuildInfo = { sha: string; digest: string; time: string }

/** Read an `ow.build.json` sidecar sitting next to the given binary path,
 * resolving symlinks first (covers a `~/.local/bin/ow` shim). Returns the
 * identity triple, or null when missing/unreadable/invalid — never throws. */
export const readBuildSidecar = async (execPath: string): Promise<UpBuildInfo | null> => {
  try {
    const dir = dirname(await realpath(execPath))
    const parsed = JSON.parse(await readFile(join(dir, "ow.build.json"), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const { sha, digest, time } = record
    if (typeof sha !== "string" || typeof digest !== "string" || typeof time !== "string") return null
    if (sha.length === 0 || digest.length === 0 || time.length === 0) return null
    return { sha, digest, time }
  } catch {
    return null
  }
}

/** Sidecar of the currently running binary (what a same-version `doctor`
 * compares its recorded state against). */
export const readOwnBuildSidecar = async (): Promise<UpBuildInfo | null> => readBuildSidecar(process.execPath)

export type UpLock = { pid: number; lstart: string; startedAt: string }

export const upPaths = (rootDir: string) => ({
  stateDir: join(rootDir, ".ow"),
  supervisorFile: join(rootDir, ".ow", "supervisor.json"),
  lockFile: join(rootDir, ".ow", "supervisor.lock"),
  logsDir: join(rootDir, ".ow", "logs"),
  /** M1 service-request channel (B1): client writes, supervisor executes. */
  requestsDir: join(rootDir, ".ow", "requests"),
  resultsDir: join(rootDir, ".ow", "requests", "results"),
})

/** Upward-walk budget: filesystem root or 32 levels, whichever first. */
const WORKSPACE_WALK_MAX_LEVELS = 32

/** Resolve the enclosing workspace for READING commands: walk up from
 * `startDir`, nearest real `.ow/` directory wins (nested workspaces resolve
 * to the inner one, git-style). A `.ow` that is a file, a symlink, or
 * otherwise not a real directory is skipped, never followed. Unreadable
 * levels are skipped, never fatal. Falls back to `startDir` when nothing
 * is found — callers keep their honest-empty messages, now naming the
 * searched start. Creation paths (`ow up`) must NOT use this. */
export const resolveWorkspaceRoot = async (startDir: string): Promise<string> => {
  let dir = resolve(startDir)
  const start = dir
  for (let level = 0; level <= WORKSPACE_WALK_MAX_LEVELS; level += 1) {
    try {
      const info = await lstat(join(dir, ".ow"))
      if (info.isDirectory() && !info.isSymbolicLink()) return dir
    } catch {
      // missing or unreadable here: keep walking outward
    }
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
  return start
}

/** Honest-empty suffix naming the searched reality: the start dir plus one
 * directive clause. Paths are operator-known (same as `dizin:` lines);
 * never env values or span/log bodies. */
export const noStateNote = (startDir: string): string =>
  `.ow/ bulunamadı — aranan: ${startDir}; workspace kökünden çalıştırın ya da --file verin`

/** `0700` real directory, symlink-rejected (observer-core discipline). */
export const ensureUpStateDir = async (stateDir: string): Promise<void> => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const info = await lstat(stateDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(".ow dizini gerçek bir dizin olmalı")
  await chmod(stateDir, 0o700)
}

const OW_GITIGNORE_ENTRY = ".ow/"

/** Keep tooling state (supervisor.json/lock, logs, traces: pids, absolute
 * paths, commands, span data) out of version control: ensure the repo-root
 * `.gitignore` covers `.ow/`. Create-or-append, never touching unrelated
 * lines; byte-identical when an equivalent entry is already present.
 * Returns a warning line when the file cannot be read or written, null on
 * success. Never throws: `up` must not fail for this. */
export const ensureOwGitignore = async (rootDir: string): Promise<string | null> => {
  const ignorePath = join(rootDir, ".gitignore")
  let text: string | null = null
  try {
    text = await readFile(ignorePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "uyarı: .gitignore okunamıyor (.ow/ girdisi eklenemedi)"
    }
  }
  if (text === null) {
    try {
      await writeFile(ignorePath, `${OW_GITIGNORE_ENTRY}\n`, { encoding: "utf8" })
      return null
    } catch {
      return "uyarı: .gitignore yazılamıyor (.ow/ girdisi eklenemedi)"
    }
  }
  const covered = text.split("\n").some((line) => {
    const entry = line.trim()
    return entry === ".ow/" || entry === ".ow" || entry === "/.ow/" || entry === "/.ow"
  })
  if (covered) return null
  const suffix = text.length === 0 || text.endsWith("\n") ? "" : "\n"
  try {
    await writeFile(ignorePath, `${text}${suffix}${OW_GITIGNORE_ENTRY}\n`, { encoding: "utf8" })
    return null
  } catch {
    return "uyarı: .gitignore yazılamıyor (.ow/ girdisi eklenemedi)"
  }
}

/** Atomic tmp+rename write, `0600` (observer-core discipline). */
const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  const temporary = join(dirname(path), `.ow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export const writeSupervisorState = async (supervisorFile: string, state: UpSupervisorState): Promise<void> => {
  await atomicWriteJson(supervisorFile, state)
}

export const readSupervisorState = async (supervisorFile: string): Promise<UpSupervisorState | null> => {
  try {
    const text = await readFile(supervisorFile, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const dict = parsed as Record<string, unknown>
    if (dict["version"] !== UP_STATE_VERSION || !Array.isArray(dict["services"])) return null
    return parsed as UpSupervisorState
  } catch {
    return null
  }
}

export type SupervisorFileStatus = "missing" | "ok" | "corrupt" | "bad-version"

/** Present-but-unparseable (or versioned) state must fail closed (exit 1),
 * never read as empty: callers distinguish it from genuinely missing state. */
export const classifySupervisorFile = async (supervisorFile: string): Promise<SupervisorFileStatus> => {
  let text: string
  try {
    text = await readFile(supervisorFile, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt"
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return "corrupt"
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "corrupt"
  const dict = parsed as Record<string, unknown>
  if (typeof dict["version"] !== "number") return "corrupt"
  if (dict["version"] !== UP_STATE_VERSION) return "bad-version"
  if (!Array.isArray(dict["services"])) return "corrupt"
  return "ok"
}

const runPs = async (args: string[], timeoutMs = 2000): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited
    return out
  } catch {
    return null
  }
}

/** `lstart` string for a pid, or null when unreadable (dead pid, denied, non-macOS). */
export const readLstart = async (pid: number): Promise<string | null> => {
  const out = await runPs(["-o", "lstart=", "-p", String(pid)])
  if (!out) return null
  const line = out.trim()
  return line.length > 0 ? line : null
}

/** True only when the pid exists AND its `lstart` matches (PID-reuse guard). */
export const isLivePid = async (pid: number, lstart: string): Promise<boolean> => {
  const current = await readLstart(pid)
  return current !== null && current === lstart
}

export type LockStatus =
  | { kind: "absent" }
  | { kind: "live"; lock: UpLock }
  | { kind: "stale"; lock: UpLock; reason: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "unknown"; lock: UpLock; reason: string }

export type LockFileShape = "absent" | "corrupt" | "ok"

/** Shape check without liveness: `ENOENT` → absent, present-but-unparseable
 * (or wrong shape) → corrupt. Lets callers reclaim corrupt locks with a
 * warning instead of silently overwriting them as "absent". */
export const lockFileShape = async (lockFile: string): Promise<LockFileShape> => {
  let text: string
  try {
    text = await readFile(lockFile, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "corrupt"
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return "corrupt"
    const dict = parsed as Record<string, unknown>
    if (typeof dict["pid"] !== "number" || typeof dict["lstart"] !== "string") return "corrupt"
    return "ok"
  } catch {
    return "corrupt"
  }
}

export const readLock = async (lockFile: string): Promise<UpLock | null> => {
  try {
    const text = await readFile(lockFile, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const dict = parsed as Record<string, unknown>
    if (typeof dict["pid"] !== "number" || typeof dict["lstart"] !== "string") return null
    return parsed as UpLock
  } catch {
    return null
  }
};

/** Classify an existing lock. Present-but-unparseable files are `corrupt`
 * (reclaimed with a warning, never silently treated as absent). When even
 * our own `lstart` is unreadable the guard itself is blind (no `ps`/no
 * `lstart` support): treat live and refuse, never reclaim blindly. */
export const classifyLock = async (lockFile: string): Promise<LockStatus> => {
  const shape = await lockFileShape(lockFile)
  if (shape === "absent") return { kind: "absent" }
  if (shape === "corrupt") return { kind: "corrupt", reason: "kilit dosyası bozuk" }
  const lock = (await readLock(lockFile)) as UpLock
  const selfCheck = await readLstart(process.pid)
  if (selfCheck === null) return { kind: "unknown", lock, reason: "lstart okunamıyor, doğrulanamaz" }
  const current = await readLstart(lock.pid)
  if (current === null) return { kind: "stale", lock, reason: "pid yok" }
  if (current === lock.lstart) return { kind: "live", lock }
  return { kind: "stale", lock, reason: "lstart uyuşmazlığı (pid geri dönüşümü)" }
};

/** Exclusive (`O_CREAT|O_EXCL`) lock write: the double-`up` check-then-act
 * window is closed here, not at the caller. Returns true when created. */
const writeLockExclusive = (lockFile: string, lock: UpLock): boolean => {
  try {
    const fd = openSync(lockFile, "wx", 0o600)
    try {
      writeFileSync(fd, JSON.stringify(lock), "utf8")
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
};

/** Acquire the single-supervisor lock or throw a Turkish usage error. Stale
 * AND corrupt locks are reclaimed with a warning (warn-only spirit kept:
 * the supervisor is dead, only its marker is broken). Creation is
 * exclusive: a lost creation race re-classifies — a now-live/unknown lock
 * refuses, only a still-stale/corrupt one is reclaimed. Residual risk: two
 * racers that both see stale can still both reclaim (documented, same as
 * before); the common live/absent double-`up` race is closed. */
export const acquireLock = async (lockFile: string, warnings: string[]): Promise<UpLock> => {
  const status = await classifyLock(lockFile)
  if (status.kind === "live") throw new Error("zaten çalışıyor (ow ps)")
  if (status.kind === "unknown") throw new Error("kilit doğrulanamadı, çalışıyor sayılıyor — önce ow down")
  const reclaimNote =
    status.kind === "stale"
      ? `uyarı: bayat kilit devralındı (${status.reason})`
      : status.kind === "corrupt"
        ? `uyarı: bozuk kilit devralındı (${status.reason})`
        : null
  const self = await readLstart(process.pid)
  const lock: UpLock = { pid: process.pid, lstart: self ?? "", startedAt: new Date().toISOString() }
  if (writeLockExclusive(lockFile, lock)) {
    if (reclaimNote) warnings.push(reclaimNote)
    return lock
  }
  const again = await classifyLock(lockFile)
  if (again.kind === "live") throw new Error("zaten çalışıyor (ow ps)")
  if (again.kind === "unknown") throw new Error("kilit doğrulanamadı, çalışıyor sayılıyor — önce ow down")
  if (again.kind === "corrupt") warnings.push(`uyarı: bozuk kilit devralındı (yarış sonrası, ${again.reason})`)
  else if (again.kind === "stale") warnings.push(`uyarı: bayat kilit devralındı (yarış sonrası, ${again.reason})`)
  await atomicWriteJson(lockFile, lock)
  return lock
};

export const clearLock = async (lockFile: string): Promise<void> => {
  await unlink(lockFile).catch(() => undefined)
};
