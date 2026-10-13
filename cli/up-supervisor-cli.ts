/** Detached/foreground entry points for `ow up`.
 * Foreground (`runSuperviseFile`) acquires the lock in-process, streams
 * `[name|stream] line` lines to stdout and clears the lock last. Detach
 * (`detachSupervised`) re-spawns a hidden `__supervise` via nohup and polls
 * for `supervisor.json` (bounded: 3 s). */

import { readFileSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { decodeUtf8Fatal, formatUpWarnings, parseUpFile } from "./up-schema"
import { acquireLock, clearLock, ensureOwGitignore, ensureUpStateDir, readSupervisorState, upPaths } from "./up-state"
import { assertNoLiveOrphans, runSupervised } from "./up-supervisor"

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Foreground supervision of one file. Returns the process exit code.
 * `quiet` (detached `__supervise`) suppresses per-line stdout streaming —
 * lines already persist to per-service JSONL via capture — while startup
 * warnings/errors still land in supervisor.out (bounded, a handful). */
export const runSuperviseFile = async (file: string, opts?: { quiet?: boolean }): Promise<number> => {
  const abs = resolve(file)
  let text: string
  try {
    // Raw bytes + fatal decode: undecodable config fails here (exit 2),
    // never silently parsed with replacement characters.
    text = decodeUtf8Fatal(readFileSync(abs))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${abs}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const rootDir = dirname(abs)
  const paths = upPaths(rootDir)
  try {
    await ensureUpStateDir(paths.stateDir)
  } catch (error) {
    console.error(`ow: .ow unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const warnings: string[] = []
  let lock: import("./up-state").UpLock
  try {
    lock = await acquireLock(paths.lockFile, warnings)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const gitignoreWarning = await ensureOwGitignore(rootDir)
  if (gitignoreWarning) warnings.push(gitignoreWarning)
  for (const line of [...warnings, ...formatUpWarnings(parsed.warnings)]) console.error(line)
  // Orphan probe (H6): the lock said free but recorded children may still be
  // live from a crashed supervisor — refuse instead of duplicating them.
  try {
    await assertNoLiveOrphans(rootDir)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    await clearLock(paths.lockFile)
    return 2
  }
  let code = 0
  try {
    code = await runSupervised(parsed.services, {
      rootDir,
      stateFile: paths.supervisorFile,
      logsDir: paths.logsDir,
      requestsDir: paths.requestsDir,
      owFile: abs,
      trace: parsed.trace,
      supervisorStartedAt: lock.startedAt,
      onLine: opts?.quiet ? () => undefined : (name, stream, line) => console.log(`[${name}|${stream}] ${line}`),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`ow: ${message}`)
    code = message.startsWith("cwd") ? 2 : 1
  } finally {
    await clearLock(paths.lockFile)
  }
  const state = await readSupervisorState(paths.supervisorFile)
  for (const svc of state?.services ?? []) {
    if (svc.exitCode !== undefined) console.log(`exit: ${svc.name} code=${svc.exitCode}`)
  }
  return code
}

/** Single-quote escaping: `$`, backticks and `!` stay literal inside `'...'`.
 * Internal quotes close/reopen (`'\''`) — the only expansion-proof quoting
 * for `sh -c` paths that may contain `$(...)`, backticks or `$VAR`. */
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const tailFile = async (path: string, maxLines: number): Promise<string[]> => {
  try {
    const text = await readFile(path, "utf8")
    const lines = text.split("\n").filter((line) => line.length > 0)
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

/** The exact `sh -c` body detach uses (exported for quoting tests). Only
 * intentional shell syntax stays unquoted: `nohup`, `>`, `2>&1`, `&`, `$!`. */
export const superviseShell = (execPath: string, cliPath: string | null, file: string, outFile: string): string => {
  const inner =
    cliPath !== null
      ? `${shQuote(execPath)} run ${shQuote(cliPath)} __supervise --file ${shQuote(file)}`
      : `${shQuote(execPath)} __supervise --file ${shQuote(file)}`
  return `nohup ${inner} > ${shQuote(outFile)} 2>&1 & echo $!`
}

/** H-b freshness predicate (exported for tests): a supervisor.json counts
 * as fresh only when strictly newer than the pre-spawn wall-clock. Strict
 * `>` (never `>=`) decides mtime-resolution ties fail-closed: on coarse
 * filesystems a same-tick fresh write may read as stale (slow exit 1),
 * but a stale file can never read as fresh (no false "started"). */
export const isFreshSupervisorFile = (path: string, spawnWall: number): boolean => {
  try {
    return statSync(path).mtimeMs > spawnWall
  } catch {
    return false
  }
}

/** Detached supervision: pre-acquire-or-fail, spawn hidden `__supervise`, wait
 * for state, exit 0/1. The parent reserves the lock BEFORE spawning (no
 * spawn-then-poll race: two racing `up --detach` serialize on the exclusive
 * create, the loser never spawns) and releases it immediately after the
 * spawn handshake — the child performs the real exclusive acquire before
 * spawning any service. The handoff window is one synchronous unlink;
 * a child that still sees the parent lock refuses loudly (exit 2 in
 * supervisor.out), never duplicating services. */
export const detachSupervised = async (file: string, rootDir: string): Promise<number> => {
  const abs = resolve(file)
  const paths = upPaths(rootDir)
  await ensureUpStateDir(paths.stateDir)
  const preWarnings: string[] = []
  try {
    await acquireLock(paths.lockFile, preWarnings)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  // Fast-path orphan probe before spawning: the exclusive child acquire is
  // the real mutex, this only saves a doomed spawn round-trip.
  try {
    await assertNoLiveOrphans(rootDir)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    await clearLock(paths.lockFile)
    return 2
  }
  for (const line of preWarnings) console.error(line)
  const outFile = join(paths.stateDir, "supervisor.out")
  const underBun = process.execPath.includes("bun")
  const shell = superviseShell(
    process.execPath,
    underBun ? fileURLToPath(import.meta.url).replace(/up-supervisor-cli\.(ts|js)$/, "cli.ts") : null,
    abs,
    outFile,
  )
  // H-b freshness gate: capture the wall-clock BEFORE spawning; the poll
  // below requires a strictly newer supervisor.json (mtime) via
  // isFreshSupervisorFile, never mere existence — a stale file from a
  // previous run must not read as "started".
  const spawnWall = Date.now()
  const proc = Bun.spawn(["sh", "-c", shell], { stdout: "pipe", stderr: "ignore" })
  const pidText = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  // Reservation handoff: release before polling so the child can perform its
  // own exclusive acquire. From here the child's acquire is the mutex.
  await clearLock(paths.lockFile)
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error("ow: supervisor could not start")
    for (const line of await tailFile(outFile, 20)) console.error(line)
    return 1
  }
  const start = Date.now()
  let seen = false
  while (Date.now() - start < 3000) {
    if (isFreshSupervisorFile(paths.supervisorFile, spawnWall)) {
      seen = true
      break
    }
    await sleep(100)
  }
  if (!seen) {
    console.error("ow: supervisor did not start (no supervisor.json)")
    for (const line of await tailFile(outFile, 20)) console.error(line)
    return 1
  }
  let names: string[] = []
  try {
    names = parseUpFile(decodeUtf8Fatal(readFileSync(abs))).services.map((svc) => svc.name)
  } catch {
    names = []
  }
  console.log(names.length > 0 ? `started: ${names.length} services (${names.join(", ")})` : `started: pid ${pid}`)
  return 0
}
