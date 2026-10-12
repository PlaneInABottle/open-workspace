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

import { lstat, readFile, readlink, stat } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"

import { decodeUtf8Fatal, parseUpFile, type UpService } from "./up-schema"
import { readLstart, readSupervisorState, upPaths, type UpServiceState } from "./up-state"
import { evaluatePreflight, measureTcpPorts, PREFLIGHT_BUDGET_MS, PREFLIGHT_PER_SERVICE_MS, readBoundaryClaims, readConfigVersion, readEnvelopeContext, type TcpCheck } from "./up-preflight"
import { CHECKPOINTS_DIR_NAME, isValidRunName, readCheckpointFile, viewOf } from "./up-checkpoints"
import { maskSecrets, TRUNCATION_MARK, type EvidenceEnvelope } from "./up-evidence"
import type { Liveness } from "./up-reconcile"
import { parseScenarios, SCENARIOS_FILE_NAME } from "./up-scenarios"
import {
  dataWireOf,
  findCollisions,
  formatDataClock,
  formatLedgerChip,
  parseDataClock,
  readDataClockFile,
  readScopeClock,
  selectDataState,
  type DataClockData,
} from "./up-data-clock"

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
  /** M7 additive data-clock witness (never gates: absent from `checks`
   * and `pass` by construction). */
  dataClock: {
    state: "fresh" | "stale-ignored" | "missing" | "oversize" | "invalid"
    identity: string | null
    head: string | null
    profile: string | null
    seedRev: string | null
    at: string | null
    ledger: { scope: string; identity: string; seed: string; migration: string }[]
    collisions: string[]
    mismatches: string[]
  }
  /** M9 additive overlay source tags (present only when an overlay is
   * active — absent overlay keeps the JSON byte-identical). */
  overlayApplied?: boolean
  overlayFile?: string | null
  boundarySources?: { scenario: string; boundary: string; source: string }[]
  overlayWarnings?: string[]
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
  if (head === null) return { revShort: null, branch: null, note: capNote("HEAD unreadable (rev ignored)") }
  const line = head.split("\n", 1)[0].trim()
  if (line.startsWith("ref: ")) {
    const ref = line.slice("ref: ".length).trim()
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
    if (branch.length === 0) return { revShort: null, branch: null, note: capNote("HEAD empty ref (rev ignored)") }
    return { revShort: null, branch, note: capNote(`branch: ${branch}`) }
  }
  if (HEX_REV.test(line)) return { revShort: line.slice(0, 7), branch: null, note: capNote(`detached HEAD: ${line.slice(0, 7)}`) }
  return { revShort: null, branch: null, note: capNote("HEAD malformed (rev ignored)") }
}

export type ShapeCheck = { ok: boolean; note: string; missingReason: string | null }

/** `.env` must be a symlink whose target exists. Contents never read. */
export const checkEnvSymlink = async (rootDir: string): Promise<ShapeCheck> => {
  const path = join(rootDir, ".env")
  let info
  try {
    info = await lstat(path)
  } catch {
    return { ok: false, note: capNote(".env missing"), missingReason: "envSymlink:missing" }
  }
  if (!info.isSymbolicLink()) {
    return { ok: false, note: capNote(".env must be a symlink (file/dir found)"), missingReason: "envSymlink:not-symlink" }
  }
  let target: string
  try {
    target = await readlink(path)
  } catch {
    return { ok: false, note: capNote(".env target unreadable"), missingReason: "envSymlink:broken" }
  }
  try {
    await lstat(resolve(rootDir, target))
  } catch {
    return { ok: false, note: capNote(`.env target missing: ${basename(target)}`), missingReason: "envSymlink:broken" }
  }
  return { ok: true, note: capNote(`.env link healthy (${basename(target)})`), missingReason: null }
}

/** `.venv/bin/python` must exist (lstat only, never run). */
export const checkVenv = async (rootDir: string): Promise<ShapeCheck> => {
  const path = join(rootDir, ".venv", "bin", "python")
  let info
  try {
    info = await lstat(path)
  } catch {
    return { ok: false, note: capNote(".venv/bin/python missing"), missingReason: "venv:missing" }
  }
  if (!info.isFile()) {
    return { ok: false, note: capNote(".venv/bin/python is not a file"), missingReason: "venv:not-file" }
  }
  return { ok: true, note: capNote(".venv/bin/python present"), missingReason: null }
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
  boundariesFlag?: string
}): Promise<{ ok: boolean; note: string; missing: string[] }> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch {
    return { ok: false, note: capNote("ow.yaml unreadable"), missing: ["preflight:ow-yaml-unreadable"] }
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    return { ok: false, note: capNote(`ow.yaml invalid: ${error instanceof Error ? error.message : String(error)}`), missing: ["preflight:ow-yaml-invalid"] }
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
  let evidenceIncomplete = false
  try {
    const { readdir } = await import("node:fs/promises")
    const dir = join(paths.stateDir, CHECKPOINTS_DIR_NAME)
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
    for (const file of files) {
      const run = file.slice(0, -".jsonl".length)
      if (!isValidRunName(run)) continue
      try {
        const view = viewOf(run, await readCheckpointFile(join(dir, file)))
        envelopes.push(...view.envelopes)
        // MEDIUM-6: truncated reads cannot prove readiness — surface before
        // the gate consumes the partial evidence (fail-closed missing entry).
        if (view.skipped.corrupt > 0 || view.skipped.overCap > 0) evidenceIncomplete = true
      } catch {
        continue
      }
    }
  } catch {
    // Without a checkpoints dir the envelope context is empty (not a failure).
  }
  // MEDIUM-3: the provision "preflight" check runs the full 4-gate
  // composition (boundary claims included), not a 3-gate subset.
  const claimsInput = await readBoundaryClaims(opts.rootDir, opts.boundariesFlag)
  const result = evaluatePreflight({
    expected,
    running,
    liveness,
    tcpResults,
    envelopes,
    boundary: {
      claims: claimsInput.claims,
      scenariosUnreadable: claimsInput.scenariosUnreadable,
      configVersion: readConfigVersion(text),
    },
  })
  const missing = [...result.missing]
  if (evidenceIncomplete) missing.push("readiness:evidence-incomplete")
  if (result.pass && !evidenceIncomplete) return { ok: true, note: capNote("pre-gate passed"), missing: [] }
  return {
    ok: false,
    note: capNote(`pre-gate failed (${missing.length} missing)`),
    missing: missing.map((line) => maskSecrets(line)),
  }
}

const REMEDY: Record<ProvisionCheckName, string> = {
  envSymlink: "symlink to the farm .env",
  venv: "install .venv",
  head: "check git status",
  preflight: "see details with ow preflight",
}

/** `ow provision --check [--file] [--json] [--probe]`: exit 0 all-ok / 1
 * any-fail / 2 declared-env-file-missing. Human check lines keep their
 * frozen shape; the M7 additive data-clock block (line, ledger chips,
 * advisories — never gating) lands before the summary line, which stays
 * last. JSON English keys frozen + additive M7 `dataClock`
 * (`{pass,root,rootBase,revShort,branch,checks,missing,human,portBase,dataClock}`;
 * `portBase` ALWAYS null). Writes nothing. */
export const runProvisionCheck = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe: boolean
  tcpCheck?: TcpCheck
  boundariesFlag?: string
}): Promise<number> => {
  const root = resolve(opts.rootDir)
  const rootBase = basename(root)
  // Scenario-declared env files (M7, names-only): presence validated here,
  // contents never read. A declared-but-missing file refuses upfront.
  // M9: declarations resolve through the same overlay helper as every
  // other reader (flag > local convention > base).
  let scenarios: { name: string; env_file: string | null; data: Record<string, string> | null }[] = []
  let overlay: import("./up-overlay").OverlayInfo | null = null
  // MEDIUM-2: a missing scenarios file is silent-empty (optional input),
  // but a present-but-corrupt file warns (env_file/data checks skip) —
  // never a silent swallow like other readers' fail-closed paths.
  let scenariosText: string | null = null
  try {
    scenariosText = await readFile(join(root, SCENARIOS_FILE_NAME), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`ow: scenarios file unreadable: ${join(root, SCENARIOS_FILE_NAME)} (env_file/data checks skipped)`)
    }
  }
  if (scenariosText !== null) {
    try {
      const baseParsed = parseScenarios(scenariosText)
      const { resolveOverlay, OverlayRefusal } = await import("./up-overlay")
      try {
        const resolved = await resolveOverlay({ rootDir: root, base: baseParsed, baseText: scenariosText, flagPath: opts.boundariesFlag })
        scenarios = resolved.merged.scenarios
        overlay = resolved.overlay
      } catch (error) {
        if (error instanceof OverlayRefusal) {
          console.error(`ow: ${error.message}`)
          return error.exit
        }
        throw error
      }
    } catch (error) {
      console.error(`ow: invalid scenarios file: ${error instanceof Error ? error.message : String(error)} (env_file/data checks skipped)`)
    }
  }
  for (const scenario of scenarios) {
    if (scenario.env_file === null) continue
    let present = false
    try {
      const info = await stat(join(root, scenario.env_file))
      present = info.isFile()
    } catch {
      present = false
    }
    if (!present) {
      console.error(`ow: env file missing: ${maskSecrets(scenario.env_file)} (declared by ${scenario.name})`)
      return 2
    }
  }
  const [env, venv, head, gate] = await Promise.all([
    checkEnvSymlink(root),
    checkVenv(root),
    readHeadIdentity(root),
    checkPreflightGate({ rootDir: root, file: opts.file, probe: opts.probe, tcpCheck: opts.tcpCheck, boundariesFlag: opts.boundariesFlag }),
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
    maskSecrets(check.ok ? `ok: ${check.name} ${check.note}` : `missing: ${check.name} ${check.note} → ${REMEDY[check.name]}`),
  )
  const pass = checks.every((check) => check.ok)
  const summary = maskSecrets(pass ? "provision passed" : `provision missing: ${checks.filter((check) => !check.ok).length}`)
  // M7 data-clock witness (advisory only — never feeds `pass`/`missing`).
  // Root file drives the dataClock line; service-cwd files feed the ledger
  // and collision scan. Everything here is presence/shape witnessing.
  const clockOutcome = await readDataClockFile(join(root, ".ow", "data-clock.json"))
  const rootParsed = "bytes" in clockOutcome
    ? parseDataClock(clockOutcome.bytes)
    : "oversize" in clockOutcome
      ? { ok: false as const, reason: "oversize" }
      : null
  let expectedServices: UpService[] = []
  try {
    expectedServices = parseUpFile(decodeUtf8Fatal(await readFile(opts.file))).services
  } catch {
    expectedServices = []
  }
  const scopes: { scope: string; data: DataClockData }[] = []
  if (rootParsed !== null && rootParsed.ok) scopes.push({ scope: "root", data: rootParsed.data })
  for (const svc of expectedServices) {
    if (svc.cwd === undefined || isAbsolute(svc.cwd) || svc.cwd.split("/").includes("..")) continue
    const sub = await readScopeClock(join(root, svc.cwd), svc.name)
    if (sub !== null) scopes.push(sub)
  }
  let newestAt: number | null = null
  try {
    for (const envelope of await readEnvelopeContext(upPaths(root).stateDir)) {
      const ms = Date.parse(envelope.at)
      if (Number.isFinite(ms) && (newestAt === null || ms > newestAt)) newestAt = ms
    }
  } catch {
    newestAt = null
  }
  const read = selectDataState(rootParsed, newestAt)
  const mismatches: string[] = []
  if (rootParsed !== null && rootParsed.ok) {
    for (const scenario of scenarios) {
      if (scenario.data === null) continue
      for (const [key, value] of Object.entries(scenario.data)) {
        if (rootParsed.data[key] !== undefined && rootParsed.data[key] !== value) {
          mismatches.push(`${scenario.name}: data mismatch: ${key} (UNVERIFIED)`)
        }
      }
    }
  }
  const collisions = findCollisions(scopes)
  const wire = read.state === "fresh" || read.state === "stale-ignored" ? dataWireOf(read.data) : null
  const dataClock = {
    state: read.state,
    identity: wire?.db_identity ?? null,
    head: wire?.applied_head ?? null,
    profile: wire?.seed_profile ?? null,
    seedRev: wire?.seed_rev ?? null,
    at: wire?.at ?? null,
    ledger: scopes.map((entry) => ({
      scope: entry.scope,
      identity: maskSecrets(entry.data.db_identity),
      seed: `${maskSecrets(entry.data.seed_profile)}/${maskSecrets(entry.data.seed_rev)}`,
      migration: maskSecrets(entry.data.applied_head),
    })),
    collisions: collisions.map((id) => maskSecrets(id)),
    mismatches: [...mismatches],
  }
  const dataHuman = [
    formatDataClock(read),
    ...scopes.map((entry) => formatLedgerChip(entry.scope, entry.data)),
    ...collisions.map((id) => `collision-warning: ${maskSecrets(id)} in two checkouts`),
    ...mismatches,
  ]
  // M9 source tags (absent overlay adds nothing — byte-identical outputs).
  const overlayHuman = overlay !== null && overlay.applied
    ? [`overlay-active: ${overlay.file}`, ...overlay.warnings]
    : []
  const result: ProvisionResult = {
    pass,
    root,
    rootBase,
    revShort: head.revShort,
    branch: head.branch,
    checks,
    missing,
    human: [...human, ...dataHuman, ...overlayHuman, summary],
    portBase: null,
    dataClock,
    ...((overlay !== null && overlay.applied)
      ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources, overlayWarnings: overlay.warnings }
      : {}),
  }
  if (opts.json) {
    console.log(JSON.stringify(result))
  } else {
    for (const line of result.human) console.log(line)
  }
  return pass ? 0 : 1
}
