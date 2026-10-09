/** Provision `--check`: shape-only filesystem witness (never actor).
 * Presence/shape only: `.env` symlink target exists (lstat+readlink, never
 * read contents), `.venv/bin/python` exists (lstat, never run), HEAD via
 * `.git/HEAD` file read (ref text or detached short-7, never `git` exec;
 * linked-worktree `.git` gitdir files resolve to their HEAD file, still a
 * bounded file read), plus in-process `evaluatePreflight` pure-composition
 * (read-only, no `--probe` unless flag passed — never `runPreflight`: no
 * double-print/exit-coupling). NEVER reads secret values, NEVER
 * copies/auto-provisions env, NEVER installs tools, NEVER spawns/kills/
 * lock-breaks, NEVER writes (no checkpoint/supervisor mutation). Every
 * `note`/`missing`/`human` string passes through `maskSecrets()`. Notes
 * truncate past 200 chars + `…[kesildi]`. */

import { lstat, readFile, readlink } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { decodeUtf8Fatal, parseUpFile, type UpService } from "./up-schema"
import { readLstart, readSupervisorState, upPaths, type UpServiceState } from "./up-state"
import { evaluatePreflight, measureTcpPorts, PREFLIGHT_BUDGET_MS, PREFLIGHT_PER_SERVICE_MS, type TcpCheck } from "./up-preflight"
import { CHECKPOINTS_DIR_NAME, isValidRunName, readCheckpointFile, viewOf } from "./up-checkpoints"
import { maskSecrets, TRUNCATION_MARK, type EvidenceEnvelope } from "./up-evidence"
import type { Liveness } from "./up-reconcile"

export type ProvisionCheckName = "envSymlink" | "venv" | "head" | "preflight"
export type ProvisionCheck = { name: ProvisionCheckName; ok: boolean; note: string }

export type ProvisionResult = {
  pass: boolean
  /** Absolute root — ONLY in local `--json` stdout, never wire/DOM. */
  root: string
  rootBase: string
  revShort: string | null
  branch: string | null
  checks: ProvisionCheck[]
  missing: string[]
  human: string[]
  /** Reserved seam, ALWAYS null (no reader; future source needs a plan amendment). */
  portBase: null
}

const NOTE_MAX_CHARS = 200

/** Mask first, then cap (evidence precedent: mask BEFORE cap). */
const capNote = (text: string): string => {
  const masked = maskSecrets(text)
  return masked.length <= NOTE_MAX_CHARS ? masked : masked.slice(0, Math.max(0, NOTE_MAX_CHARS - TRUNCATION_MARK.length)) + TRUNCATION_MARK
}

const HEAD_MAX_BYTES = 4096
const HEX_REV = /^[0-9a-fA-F]{4,64}$/

export type HeadIdentity = { revShort: string | null; branch: string | null; note: string }

/** `.git/HEAD` (or linked-worktree gitdir `HEAD`) bounded file read. Never
 * fails: unreadable/unshaped → nulls + warn note. Never `git` exec. */
export const readHeadIdentity = async (rootDir: string): Promise<HeadIdentity> => {
  const readCapped = async (path: string): Promise<string | null> => {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      return null
    }
    return text.slice(0, HEAD_MAX_BYTES)
  }
  let head = await readCapped(join(rootDir, ".git", "HEAD"))
  if (head === null) {
    // Linked worktree: `.git` is a file holding `gitdir: <path>`.
    const pointer = await readCapped(join(rootDir, ".git"))
    if (pointer !== null) {
      const first = pointer.split("\n", 1)[0].trim()
      if (first.startsWith("gitdir: ")) {
        const gitDir = resolve(rootDir, first.slice("gitdir: ".length).trim())
        head = await readCapped(join(gitDir, "HEAD"))
      }
    }
  }
  if (head === null) return { revShort: null, branch: null, note: capNote("HEAD okunamadı (rev yok sayıldı)") }
  const line = head.split("\n", 1)[0].trim()
  if (line.startsWith("ref: ")) {
    const ref = line.slice("ref: ".length).trim()
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
    if (branch.length === 0) return { revShort: null, branch: null, note: capNote("HEAD boş ref (rev yok sayıldı)") }
    return { revShort: null, branch, note: capNote(`dal: ${branch}`) }
  }
  if (HEX_REV.test(line)) return { revShort: line.slice(0, 7), branch: null, note: capNote(`ayrık HEAD: ${line.slice(0, 7)}`) }
  return { revShort: null, branch: null, note: capNote("HEAD şekilsiz (rev yok sayıldı)") }
}

export type ShapeCheck = { ok: boolean; note: string; missingReason: string | null }

/** `.env` must be a symlink whose target exists. Contents never read. */
export const checkEnvSymlink = async (rootDir: string): Promise<ShapeCheck> => {
  const path = join(rootDir, ".env")
  let info
  try {
    info = await lstat(path)
  } catch {
    return { ok: false, note: capNote(".env yok"), missingReason: "envSymlink:missing" }
  }
  if (!info.isSymbolicLink()) {
    return { ok: false, note: capNote(".env symlink olmalı (dosya/dizin bulundu)"), missingReason: "envSymlink:not-symlink" }
  }
  let target: string
  try {
    target = await readlink(path)
  } catch {
    return { ok: false, note: capNote(".env hedefi okunamadı"), missingReason: "envSymlink:broken" }
  }
  try {
    await lstat(resolve(rootDir, target))
  } catch {
    return { ok: false, note: capNote(`.env hedefi yok: ${basename(target)}`), missingReason: "envSymlink:broken" }
  }
  return { ok: true, note: capNote(`.env bağlantısı sağlam (${basename(target)})`), missingReason: null }
}

/** `.venv/bin/python` must exist (lstat only, never run). */
export const checkVenv = async (rootDir: string): Promise<ShapeCheck> => {
  const path = join(rootDir, ".venv", "bin", "python")
  let info
  try {
    info = await lstat(path)
  } catch {
    return { ok: false, note: capNote(".venv/bin/python yok"), missingReason: "venv:missing" }
  }
  if (!info.isFile()) {
    return { ok: false, note: capNote(".venv/bin/python dosya değil"), missingReason: "venv:not-file" }
  }
  return { ok: true, note: capNote(".venv/bin/python var"), missingReason: null }
}

const realLiveness = async (svc: UpServiceState): Promise<Liveness> => {
  if (svc.exitCode !== undefined) return "dead"
  if (svc.lstart === "") return "unknown"
  const current = await readLstart(svc.pid)
  return current === null ? "dead" : current === svc.lstart ? "live" : "lstart-mismatch"
}

/** Preflight pure-composition mirror of `runPreflight`'s read path (bounded
 * checkpoint scan included) feeding `evaluatePreflight` — never
 * `runPreflight` (no double-print/exit-coupling). No spawn/fetch except the
 * optional injected `--probe` TCP path under the same budget caps. */
export const checkPreflightGate = async (opts: {
  rootDir: string
  file: string
  probe: boolean
  tcpCheck?: TcpCheck
}): Promise<{ ok: boolean; note: string; missing: string[] }> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch {
    return { ok: false, note: capNote("ow.yaml okunamadı"), missing: ["preflight:ow-yaml-unreadable"] }
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    return { ok: false, note: capNote(`ow.yaml geçersiz: ${error instanceof Error ? error.message : String(error)}`), missing: ["preflight:ow-yaml-invalid"] }
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  const running = state?.services ?? []
  const liveness = new Map<string, Liveness>()
  for (const svc of running) liveness.set(svc.name, await realLiveness(svc))
  let tcpResults: Map<number, boolean | "unmeasured"> | undefined
  if (opts.probe) {
    const ports = expected.filter((svc) => svc.port !== undefined).map((svc) => svc.port as number)
    tcpResults = await measureTcpPorts({ ports, tcpCheck: opts.tcpCheck, budgetMs: PREFLIGHT_BUDGET_MS, perServiceMs: PREFLIGHT_PER_SERVICE_MS })
  }
  const envelopes: EvidenceEnvelope[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    const dir = join(paths.stateDir, CHECKPOINTS_DIR_NAME)
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
    for (const file of files) {
      const run = file.slice(0, -".jsonl".length)
      if (!isValidRunName(run)) continue
      try {
        envelopes.push(...viewOf(run, await readCheckpointFile(join(dir, file))).envelopes)
      } catch {
        continue
      }
    }
  } catch {
    // Without a checkpoints dir the envelope context is empty (not a failure).
  }
  const result = evaluatePreflight({ expected, running, liveness, tcpResults, envelopes })
  if (result.pass) return { ok: true, note: capNote("ön-kapı geçti"), missing: [] }
  return {
    ok: false,
    note: capNote(`ön-kapı geçemedi (${result.missing.length} eksik)`),
    missing: result.missing.map((line) => maskSecrets(line)),
  }
}

const REMEDY: Record<ProvisionCheckName, string> = {
  envSymlink: "çiftlik .env'sine symlink yapın",
  venv: ".venv kurun",
  head: "git durumuna bakın",
  preflight: "ow preflight ile ayrıntıya bakın",
}

/** `ow provision --check [--file] [--json] [--probe]`: exit 0 all-ok / 1
 * any-fail. Human lines Turkish, frozen shape: one line per check
 * (`ok: <ad> …` / `eksik: <ad> … → …`) + summary (`provision geçti` /
 * `provision eksik: N`) — never `hazır:`. JSON English keys frozen
 * (`{pass,root,rootBase,revShort,branch,checks,missing,human,portBase}`;
 * `portBase` ALWAYS null). Writes nothing. */
export const runProvisionCheck = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe: boolean
  tcpCheck?: TcpCheck
}): Promise<number> => {
  const root = resolve(opts.rootDir)
  const rootBase = basename(root)
  const [env, venv, head, gate] = await Promise.all([
    checkEnvSymlink(root),
    checkVenv(root),
    readHeadIdentity(root),
    checkPreflightGate({ rootDir: root, file: opts.file, probe: opts.probe, tcpCheck: opts.tcpCheck }),
  ])
  const checks: ProvisionCheck[] = [
    { name: "envSymlink", ok: env.ok, note: env.note },
    { name: "venv", ok: venv.ok, note: venv.note },
    { name: "head", ok: true, note: head.note },
    { name: "preflight", ok: gate.ok, note: gate.note },
  ]
  const missing: string[] = [
    ...(env.missingReason === null ? [] : [maskSecrets(env.missingReason)]),
    ...(venv.missingReason === null ? [] : [maskSecrets(venv.missingReason)]),
    ...gate.missing,
  ]
  const human: string[] = checks.map((check) =>
    maskSecrets(check.ok ? `ok: ${check.name} ${check.note}` : `eksik: ${check.name} ${check.note} → ${REMEDY[check.name]}`),
  )
  const pass = checks.every((check) => check.ok)
  const summary = maskSecrets(pass ? "provision geçti" : `provision eksik: ${checks.filter((check) => !check.ok).length}`)
  const result: ProvisionResult = {
    pass,
    root,
    rootBase,
    revShort: head.revShort,
    branch: head.branch,
    checks,
    missing,
    human: [...human, summary],
    portBase: null,
  }
  if (opts.json) {
    console.log(JSON.stringify(result))
  } else {
    for (const line of human) console.log(line)
    console.log(summary)
  }
  return pass ? 0 : 1
}
