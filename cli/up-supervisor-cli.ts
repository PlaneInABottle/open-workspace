/** Detached/foreground entry points for `ow up`.
 * Foreground (`runSuperviseFile`) acquires the lock in-process, streams
 * `[ad|akış] satır` lines to stdout and clears the lock last. Detach
 * (`detachSupervised`) re-spawns a hidden `__supervise` via nohup and polls
 * for `supervisor.json` (bounded: 3 s). */

import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { formatUpWarnings, parseUpFile } from "./up-schema"
import { acquireLock, clearLock, ensureUpStateDir, readSupervisorState, upPaths } from "./up-state"
import { runSupervised } from "./up-supervisor"

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Foreground supervision of one file. Returns the process exit code.
 * `quiet` (detached `__supervise`) suppresses per-line stdout streaming —
 * lines already persist to per-service JSONL via capture — while startup
 * warnings/errors still land in supervisor.out (bounded, a handful). */
export const runSuperviseFile = async (file: string, opts?: { quiet?: boolean }): Promise<number> => {
  const abs = resolve(file)
  let text: string
  try {
    text = readFileSync(abs, "utf8")
  } catch {
    console.error(`ow: ow.yaml bulunamadı: ${abs}`)
    return 2
  }
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const rootDir = dirname(abs)
  const paths = upPaths(rootDir)
  try {
    await ensureUpStateDir(paths.stateDir)
  } catch (error) {
    console.error(`ow: .ow kullanılamıyor: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const warnings: string[] = []
  try {
    await acquireLock(paths.lockFile, warnings)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  for (const line of [...warnings, ...formatUpWarnings(parsed.warnings)]) console.error(line)
  let code = 0
  try {
    code = await runSupervised(parsed.services, {
      rootDir,
      stateFile: paths.supervisorFile,
      logsDir: paths.logsDir,
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
    if (svc.exitCode !== undefined) console.log(`çıkış: ${svc.name} code=${svc.exitCode}`)
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

/** Detached supervision: spawn hidden `__supervise`, wait for state, exit 0/1. */
export const detachSupervised = async (file: string, rootDir: string): Promise<number> => {
  const abs = resolve(file)
  const paths = upPaths(rootDir)
  await ensureUpStateDir(paths.stateDir)
  const outFile = join(paths.stateDir, "supervisor.out")
  const underBun = process.execPath.includes("bun")
  const shell = superviseShell(
    process.execPath,
    underBun ? fileURLToPath(import.meta.url).replace(/up-supervisor-cli\.(ts|js)$/, "cli.ts") : null,
    abs,
    outFile,
  )
  const proc = Bun.spawn(["sh", "-c", shell], { stdout: "pipe", stderr: "ignore" })
  const pidText = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error("ow: supervisor başlatılamadı")
    for (const line of await tailFile(outFile, 20)) console.error(line)
    return 1
  }
  const start = Date.now()
  let seen = false
  while (Date.now() - start < 3000) {
    if (existsSync(paths.supervisorFile)) {
      seen = true
      break
    }
    await sleep(100)
  }
  if (!seen) {
    console.error("ow: supervisor başlamadı (supervisor.json yok)")
    for (const line of await tailFile(outFile, 20)) console.error(line)
    return 1
  }
  let names: string[] = []
  try {
    names = parseUpFile(readFileSync(abs, "utf8")).services.map((svc) => svc.name)
  } catch {
    names = []
  }
  console.log(names.length > 0 ? `başlatıldı: ${names.length} servis (${names.join(", ")})` : `başlatıldı: pid ${pid}`)
  return 0
}
