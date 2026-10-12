/** M2 runtime provenance: observation record at spawn time (inside the
 * supervisor, best-effort) + recorded-value render helpers. NO raw argv (B3:
 * only masked-shape/count/name); NEVER env CONTENTS (file NAMES +
 * env:/required-env NAMES); secret values and the full command line never
 * enter state. NO version exec like `python -V` (inferred discipline).
 * Execution SITE (B4): the execs here are called ONLY from supervisor spawn
 * time + the explicit `reconcile --check` path; `ps`/`ps --explain`
 * never touch this module's execs (pure render). */

import { readdir, realpath } from "node:fs/promises"
import { basename, resolve } from "node:path"

import type { UpService } from "./up-schema"
import { isSecretFlagToken, maskSecretToken } from "./up-reconcile"

export type ProvenanceCheckout = { rev?: string; dirty?: boolean; source: "observed" | "UNVERIFIED" }
export type ProvenanceInterpreter = { name?: string; source: "inferred" | "UNVERIFIED" }
export type ProvenanceJava = { classpathCount?: number; jarNames?: string[]; source: "inferred" | "UNVERIFIED" }

export type Provenance = {
  cwdAbs?: string
  checkout?: ProvenanceCheckout
  argvShape?: string[]
  interpreter?: ProvenanceInterpreter
  java?: ProvenanceJava
  envFiles?: string[]
  recordedAt: string
}

/** Injectable exec (default the real spawn; tests provide a counting fake —
 * this is how the ps path is proven NOT to run git/lsof). Best-effort:
 * timeout/expiry/error → null, never throws. */
export type ExecFn = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string | null>

const runExec: ExecFn = async (argv, opts) => {
  try {
    // Explicit `env`: Bun resolves argv[0] against the startup PATH and
    // ignores later process.env.PATH changes — passing the live env keeps
    // lookup fresh (same values as inherit, no behavior change).
    const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env } })
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        // already gone
      }
    }, opts.timeoutMs)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    const code = await proc.exited
    return code === 0 ? out : null
  } catch {
    return null
  }
}

/** `git rev-parse HEAD` + `status --porcelain` (observed at record time).
 * null if not a repo/on error → the checkout field is dropped (UNVERIFIED render). */
export const gitCheckout = async (
  cwd: string,
  exec: ExecFn = runExec,
  timeoutMs = 2000,
): Promise<{ rev: string; dirty: boolean } | null> => {
  try {
    const revRaw = await exec(["git", "-C", cwd, "rev-parse", "HEAD"], { cwd, timeoutMs })
    const rev = revRaw?.trim() ?? ""
    if (!/^[0-9a-fA-F]{4,64}$/.test(rev)) return null
    const statusRaw = await exec(["git", "-C", cwd, "status", "--porcelain"], { cwd, timeoutMs })
    if (statusRaw === null) return null
    return { rev, dirty: statusRaw.trim().length > 0 }
  } catch {
    return null
  }
}

/** Process-cwd best-effort (`lsof -a -p <pid> -d cwd -Fn`; `-a` means AND
 * — without it `-p`/`-d` combine as OR and the first process's cwd is
 * returned). Platform output varies (UNVERIFIED) — null if the parse fails.
 * NO kill, read-only. */
export const procCwdOf = async (pid: number, exec: ExecFn = runExec, timeoutMs = 2000): Promise<string | null> => {
  try {
    const out = await exec(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { cwd: "/", timeoutMs })
    if (!out) return null
    const lines = out.split("\n")
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === "fcwd" && i + 1 < lines.length) {
        const match = /^n(.+)$/.exec(lines[i + 1].trim())
        if (match && match[1].startsWith("/")) return match[1]
      }
    }
    return null
  } catch {
    return null
  }
}

/** Masked argv shape (observed shape): part count/order is preserved,
 * values drop. */
export const argvShapeOf = (cmd: string | string[] | undefined): string[] | undefined => {
  if (cmd === undefined) return undefined
  const parts = Array.isArray(cmd) ? [...cmd] : cmd.split(/\s+/)
  let prevFlag = false
  return parts.map((part) => {
    const out = maskSecretToken(part, prevFlag)
    prevFlag = isSecretFlagToken(part)
    return out
  })
}

const INTERPRETER_PATTERN = /^(python(\d+(\.\d+)*)?|uv|bun|node(\d+)?|java|gradlew)([^a-zA-Z0-9]|$)/

/** Interpreter match from the argv shape = inferred (`python -V` is NOT
 * run). The field is dropped when there is no match. */
export const inferInterpreter = (cmd: string | string[] | undefined): ProvenanceInterpreter | undefined => {
  if (cmd === undefined) return undefined
  const first = (Array.isArray(cmd) ? cmd[0] : cmd.split(/\s+/)[0] ?? "").trim()
  if (!first) return undefined
  const base = basename(first).toLowerCase()
  if (!INTERPRETER_PATTERN.test(base)) return undefined
  return { name: basename(first), source: "inferred" }
}

/** `-cp`/`-classpath` entries + the `-jar` name (count + JAR NAMES,
 * inferred). Only on the java interpreter; dropped when there is no evidence. */
export const javaInfoOf = (
  cmd: string | string[] | undefined,
  interpreter: ProvenanceInterpreter | undefined,
): ProvenanceJava | undefined => {
  if (interpreter?.name === undefined || basename(interpreter.name).toLowerCase() !== "java") return undefined
  const parts = Array.isArray(cmd) ? [...cmd] : (cmd ?? "").split(/\s+/)
  const entries: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if ((parts[i] === "-cp" || parts[i] === "-classpath") && i + 1 < parts.length) {
      entries.push(...parts[i + 1].split(":").filter((entry) => entry.length > 0))
      i += 1
    } else if (parts[i] === "-jar" && i + 1 < parts.length) {
      entries.push(parts[i + 1])
      i += 1
    }
  }
  if (entries.length === 0) return undefined
  return {
    classpathCount: entries.length,
    jarNames: entries.filter((entry) => entry.toLowerCase().endsWith(".jar")).map((entry) => basename(entry)).slice(0, 32),
    source: "inferred",
  }
}

/** `.env*` FILE NAMES in cwd (contents are NEVER read). On error → dropped. */
export const envFilesOf = async (cwdAbs: string): Promise<string[] | undefined> => {
  try {
    const names = (await readdir(cwdAbs)).filter((name) => name.startsWith(".env")).sort().slice(0, 16)
    return names
  } catch {
    return undefined
  }
}

const stripTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

/** Spawn-time provenance record (inside the supervisor, best-effort ≤2s/exec).
 * Never throws: an exec/readdir error drops the field in question (the spawn
 * continues). If the procCwd lsof comparison does not hold, `cwdAbs` is
 * dropped → explain renders `cwd-unverified (UNVERIFIED)`. */
export const recordProvenance = async (opts: {
  svc: UpService
  cwdAbs: string
  pid?: number
  exec?: ExecFn
  now?: () => string
}): Promise<Provenance> => {
  const exec = opts.exec ?? runExec
  const now = opts.now ?? (() => new Date().toISOString())
  const [checkout, envFiles, procCwd] = await Promise.all([
    gitCheckout(opts.cwdAbs, exec).catch(() => null),
    envFilesOf(opts.cwdAbs),
    opts.pid === undefined ? Promise.resolve(null) : procCwdOf(opts.pid, exec).catch(() => null),
  ])
  // cwdAbs: resolved observed value; if the lsof counter-check contradicts
  // it cannot be vouched for → drop (explain shows UNVERIFIED). The
  // comparison is realpath-normalized (macOS /private tolerance); an
  // infrastructure error does NOT drop it (fail-safe: doubt does not break a
  // vouch, only a proven contradiction drops it).
  let cwdAbs: string | undefined = opts.cwdAbs
  if (procCwd !== null) {
    const [normProc, normAbs] = await Promise.all([
      realpath(procCwd).catch(() => procCwd),
      realpath(opts.cwdAbs).catch(() => opts.cwdAbs),
    ])
    if (stripTrailingSlash(normProc) !== stripTrailingSlash(normAbs)) cwdAbs = undefined
  }
  const interpreter = inferInterpreter(opts.svc.cmd)
  const provenance: Provenance = { recordedAt: now() }
  if (cwdAbs !== undefined) provenance.cwdAbs = cwdAbs
  if (checkout !== null) provenance.checkout = { ...checkout, source: "observed" }
  const argvShape = argvShapeOf(opts.svc.cmd)
  if (argvShape !== undefined) provenance.argvShape = argvShape
  if (interpreter !== undefined) provenance.interpreter = interpreter
  const java = javaInfoOf(opts.svc.cmd, interpreter)
  if (java !== undefined) provenance.java = java
  if (envFiles !== undefined) provenance.envFiles = envFiles
  return provenance
}

/** Service-cwd resolution (resolve against the observed base). */
export const resolveCwdAbs = (rootDir: string, cwd: string | undefined): string =>
  cwd === undefined ? resolve(rootDir) : resolve(rootDir, cwd)
