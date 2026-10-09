/** M2 runtime provenance: spawn-anında gözlem kaydı (supervisor içinde,
 * best-effort) + kayıtlı-değer render yardımcıları. Ham argv YOK (B3:
 * yalnızca maskeli-şekil/sayı/ad); env İÇERİKLERİ asla (dosya ADLARI +
 * env:/required-env ADLARI); secret değer ve tam komut-satırı state'e
 * girmez. `python -V` gibi sürüm exec'i YOK (inferred disiplini).
 * Yürütme YERİ (B4): buradaki exec'ler YALNIZCA supervisor spawn-anı +
 * explicit `reconcile --check` yolundan çağrılır; `ps`/`ps --explain`
 * bu modülün exec'lerine dokunmaz (saf render). */

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

/** Enjekte edilebilir exec (default gerçek spawn; testler sayaçlı sahte
 * verir — ps yolunun git/lsof ÇALIŞTIRMADIĞI böyle kanıtlanır). Best-effort:
 * timeout/zaman-aşımı/hata → null, asla throw. */
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

/** `git rev-parse HEAD` + `status --porcelain` (kayıt-anı observed).
 * Repo değilse/hataysa null → checkout alanı atlanır (UNVERIFIED render). */
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

/** Process-cwd best-effort (`lsof -a -p <pid> -d cwd -Fn`; `-a` AND
 * demektir — onsuz `-p`/`-d` OR birleşir ve ilk sürecin cwd'si döner).
 * Platform çıktısı değişkendir (UNVERIFIED) — parse tutmazsa null. Kill
 * YOK, read-only. */
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

/** Maskeli argv-şekli (observed-şekil): parça sayısı/sırası korunur,
 * değerler düşer. */
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

/** argv-şekilden interpreter eşleşmesi = inferred (`python -V`
 * ÇALIŞTIRILMAZ). Eşleşme yoksa alan atlanır. */
export const inferInterpreter = (cmd: string | string[] | undefined): ProvenanceInterpreter | undefined => {
  if (cmd === undefined) return undefined
  const first = (Array.isArray(cmd) ? cmd[0] : cmd.split(/\s+/)[0] ?? "").trim()
  if (!first) return undefined
  const base = basename(first).toLowerCase()
  if (!INTERPRETER_PATTERN.test(base)) return undefined
  return { name: basename(first), source: "inferred" }
}

/** `-cp`/`-classpath` girdileri + `-jar` adı (sayı + JAR ADLARI,
 * inferred). Yalnızca java interpreter'ında; kanıt yoksa atlanır. */
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

/** cwd'deki `.env*` DOSYA ADLARI (içerik ASLA okunmaz). Hata → atlanır. */
export const envFilesOf = async (cwdAbs: string): Promise<string[] | undefined> => {
  try {
    const names = (await readdir(cwdAbs)).filter((name) => name.startsWith(".env")).sort().slice(0, 16)
    return names
  } catch {
    return undefined
  }
}

const stripTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

/** Spawn-anı provenance kaydı (supervisor içinde, best-effort ≤2s/exec).
 * Asla throw etmez: exec/readdir hatası ilgili alanı düşürür (spawn
 * devam eder). procCwd lsof-karşılaştırması tutmazsa `cwdAbs`
 * düşürülür → explain `cwd-doğrulanamadı(UNVERIFIED)` render eder. */
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
  // cwdAbs: resolve edilmiş observed değer; lsof karşı-doğrulaması
  // çelişirse vouch edilemez → düşür (explain UNVERIFIED gösterir).
  // Karşılaştırma realpath-normalized (macOS /private toleransı);
  // altyapı hatasında düşürme YOK (fail-safe: şüphe vouch'u bozmaz,
  // yalnızca kanıtlanmış çelişki düşürür).
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

/** Service-cwd çözümleme (resolve edilmiş observed taban). */
export const resolveCwdAbs = (rootDir: string, cwd: string | undefined): string =>
  cwd === undefined ? resolve(rootDir) : resolve(rootDir, cwd)
