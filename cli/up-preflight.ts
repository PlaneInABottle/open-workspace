/** P2-B preflight gate: read-only composition (NO mutation).
 * Unflagged: ow.yaml + supervisor state + read-only liveness (ps lstart
 * re-read) + recorded `lastReadiness` + checkpoint envelopes are read;
 * NO live exec (spawn/stop/restart/project-probe/health-HTTP/git/lsof are
 * not run). With `--probe`: one-shot loopback TCP for declared ports
 * (M1 N3 budget: per-service timeout, total ≤60s, on overrun
 * `(unmeasured: timeout-budget)`). M2/M3 did not land: no `ps --explain`
 * (provenance lens = expected/running config identity on live services);
 * with no `lastReadiness` the gate drops with `not_observed` (Q1). NO gating:
 * the gate only reports, the runner decides. */

import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { decodeUtf8Fatal, parseSubsetYaml, parseUpFile, type UpService } from "./up-schema"
import { isLivePid, readLstart, readSupervisorState, upPaths, type UpServiceState } from "./up-state"
import { reconcileOne, type Liveness, type ReconcileDrift } from "./up-reconcile"
import { tcpListening } from "./up-net"
import { maskSecrets, newestEnvelopePerStage } from "./up-evidence"
import { CHECKPOINTS_DIR_NAME, isValidRunName, readCheckpointFile, viewOf } from "./up-checkpoints"
import type { EvidenceEnvelope } from "./up-evidence"
import {
  boundaryGateDetail,
  formatFalseGreen,
  isEvidenceDemanding,
  scanBoundaries,
  type BoundaryClaim,
  type BoundaryGateDetail,
  type BoundaryGateInput,
} from "./up-boundary"
import { normalizeBoundary, parseScenarios, SCENARIOS_FILE_NAME } from "./up-scenarios"

export type PreflightGateName = "reconcile" | "provenance" | "readiness" | "boundary"
export type PreflightGate = { name: PreflightGateName; pass: boolean; detail: object }

/** Total TCP budget (M1 N3) + per-service timeout (lower bounds; the upper is fixed). */
export const PREFLIGHT_BUDGET_MS = 60_000
export const PREFLIGHT_PER_SERVICE_MS = 5_000

/** Injectable TCP probe (default the real loopback; tests provide a fake
 * with a counter — it must NEVER be called on an unflagged run). */
export type TcpCheck = (port: number) => Promise<boolean>

const defaultTcpCheck: TcpCheck = (port) => tcpListening(port)

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

type LivenessOf = (svc: UpServiceState) => Promise<Liveness>

/** Exported for `runReadiness` (same witness, shared liveness reader). */
export const realLiveness: LivenessOf = async (svc) => {
  if (svc.exitCode !== undefined) return "dead"
  if (svc.lstart === "") return "unknown"
  const current = await readLstart(svc.pid)
  return current === null ? "dead" : current === svc.lstart ? "live" : "lstart-mismatch"
}

type LastReadiness = { ok: boolean; note?: string }

/** Tolerant `lastReadiness` read (M3-absent): anything but `{ok: bool}` counts
 * as unmeasured (it does not flip the gate, it produces `unmeasured`). */
const readLastReadiness = (record: UpServiceState): LastReadiness | null => {
  const raw = (record as unknown as Record<string, unknown>)["lastReadiness"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const dict = raw as Record<string, unknown>
  if (typeof dict["ok"] !== "boolean") return null
  return { ok: dict["ok"] as boolean, ...(typeof dict["note"] === "string" ? { note: dict["note"] as string } : {}) }
}

export type PreflightEvaluation = {
  gates: PreflightGate[]
  missing: string[]
  human: string[]
  envelopes: EvidenceEnvelope[]
  pass: boolean
}

/** Pure-composition core (the IO trampoline is `runPreflight`; tests call it
 * directly). `tcpResults`: port → true(open)/false(closed)/
 * "unmeasured" — always empty on an unflagged run (TCP is not touched). */
export const evaluatePreflight = (opts: {
  expected: UpService[]
  running: UpServiceState[]
  liveness: Map<string, Liveness>
  tcpResults?: Map<number, boolean | "unmeasured">
  envelopes: EvidenceEnvelope[]
  /** M2 boundary composition (optional: absent means an empty passing
   * 4th gate - old callers and old 3-gate shapes are unaffected). */
  boundary?: BoundaryGateInput
}): PreflightEvaluation => {
  const missing: string[] = []
  const human: string[] = []
  const runByName = new Map(opts.running.map((svc) => [svc.name, svc]))
  // M-e recency window: gate decisions see newest-per-stage only; the
  // returned envelopes echo the full input (older runs display-only).
  const gated = newestEnvelopePerStage(opts.envelopes)

  // reconcile gate: the M1 pure core, read-only subset (no TCP/lsof →
  // listening/owners empty; foreign-port is NOT PRODUCED in this gate, documented).
  const names = [...new Set([...opts.expected.map((svc) => svc.name), ...opts.running.map((svc) => svc.name)])].sort()
  const drifts: ReconcileDrift[] = []
  for (const name of names) {
    const exp = opts.expected.find((svc) => svc.name === name) ?? null
    const run = runByName.get(name) ?? null
    const drift = reconcileOne({ name, expected: exp, running: run, liveness: run ? (opts.liveness.get(name) ?? "dead") : "dead", listening: undefined, portOwners: null })
    if (drift) {
      drifts.push(drift)
      missing.push(`reconcile:${drift.service}:${drift.kind}`)
      human.push(`missing: ${drift.service} [${drift.kind}] → ${drift.hint}`)
    }
  }
  const inSync = drifts.length === 0

  // provenance gate (M2-absent provisional): expected/running config identity
  // on LIVE services (the reconcile config-mismatch subset; same fact,
  // second lens — dead/unknown records belong to reconcile).
  const liveConfigDiffs = drifts.filter(
    (drift) => drift.kind === "config-mismatch" && opts.liveness.get(drift.service) === "live",
  )
  for (const drift of liveConfigDiffs) {
    missing.push(`provenance:${drift.service}:${drift.kind}`)
    human.push(`missing: ${drift.service} [${drift.kind}] → ${drift.hint}`)
  }

  // readiness gate: recorded `lastReadiness` (Q1: drops if absent) + `--probe`
  // live TCP confirmation (on ported services measurement is MANDATORY: unmeasured = drop).
  const checks: { service: string; ok: boolean; note: string; source: "recorded" | "live-tcp" }[] = []
  for (const svc of opts.expected) {
    const record = runByName.get(svc.name)
    const recorded = record ? readLastReadiness(record) : null
    const tcp = svc.port !== undefined ? opts.tcpResults?.get(svc.port) : undefined
    if (recorded === null) {
      checks.push({ service: svc.name, ok: false, note: "unmeasured", source: tcp === undefined ? "recorded" : "live-tcp" })
      missing.push(`readiness:${svc.name}:unmeasured`)
      human.push(`not-ready: ${svc.name} (unmeasured)`)
      continue
    }
    if (!recorded.ok) {
      const note = recorded.note !== undefined ? maskSecrets(recorded.note) : "not ready"
      checks.push({ service: svc.name, ok: false, note, source: tcp === undefined ? "recorded" : "live-tcp" })
      missing.push(`readiness:${svc.name}:not-ready`)
      human.push(`not-ready: ${svc.name} (${note})`)
      continue
    }
    if (tcp === undefined) {
      checks.push({ service: svc.name, ok: true, note: "recorded: ready", source: "recorded" })
      continue
    }
    if (tcp === "unmeasured") {
      checks.push({ service: svc.name, ok: false, note: "unmeasured: timeout-budget", source: "live-tcp" })
      missing.push(`readiness:${svc.name}:unmeasured`)
      human.push(`not-ready: ${svc.name} (unmeasured: timeout-budget)`)
      continue
    }
    if (!tcp) {
      checks.push({ service: svc.name, ok: false, note: "port closed", source: "live-tcp" })
      missing.push(`readiness:${svc.name}:port-closed`)
      human.push(`not-ready: ${svc.name} (port closed)`)
      continue
    }
    checks.push({ service: svc.name, ok: true, note: "recorded + live TCP", source: "live-tcp" })
  }

  // checkpoint envelopes: stale/not-observed drop the gate (fail-closed witness).
  for (const envelope of gated) {
    if (envelope.status === "stale") {
      missing.push(`stale:${envelope.stage}:${envelope.stale_reason}`)
      human.push(`stale: ${envelope.stage} (reason: ${envelope.stale_reason})`)
    } else if (envelope.status === "not_observed") {
      missing.push(`not-observed:${envelope.stage}`)
      human.push(`missing: ${envelope.stage} (not observed)`)
    }
  }

  const gates: PreflightGate[] = [
    { name: "reconcile", pass: inSync, detail: { inSync, drifts } },
    { name: "provenance", pass: liveConfigDiffs.length === 0, detail: { diffs: liveConfigDiffs } },
    { name: "readiness", pass: checks.every((check) => check.ok), detail: { checks } },
  ]
  // boundary gate (M2): pure scan; empty input passes silently. Finding
  // entries join the top-level `missing`/`human` flow (fail-closed: the
  // runner logs `missing[]` verbatim); traps travel in gate detail + human
  // lines only (`missing[]` stays the missing-finding class).
  const scan = scanBoundaries({
    services: opts.expected,
    claims: opts.boundary?.claims ?? [],
    records: opts.running,
    envelopes: gated,
    declaredArtifacts: opts.boundary?.declaredArtifacts ?? {},
    migrationObserved: opts.boundary?.migrationObserved ?? {},
    configVersion: opts.boundary?.configVersion,
  })
  for (const entry of scan.missing) {
    missing.push(entry)
    human.push(`missing: ${entry}`)
  }
  for (const entry of scan.stale) {
    missing.push(entry)
    human.push(`stale: ${entry}`)
  }
  if (opts.boundary?.scenariosUnreadable === true) {
    missing.unshift("boundary:scenario-file:unreadable")
    human.unshift("missing: boundary:scenario-file:unreadable")
  }
  for (const finding of scan.falseGreens) human.push(formatFalseGreen(finding))
  const detail: BoundaryGateDetail = {
    ...boundaryGateDetail(
      { services: opts.expected, records: opts.running, migrationObserved: opts.boundary?.migrationObserved ?? {} },
      scan,
    ),
    // M11: vacuity note lives in the gate detail (present only when
    // probe-only scenarios exist — parity holds otherwise).
    ...((opts.boundary?.serviceless?.length ?? 0) > 0 ? { serviceless: [...(opts.boundary?.serviceless ?? [])] } : {}),
  }
  gates.push({
    name: "boundary",
    pass:
      scan.missing.length === 0 &&
      scan.stale.length === 0 &&
      scan.falseGreens.length === 0 &&
      opts.boundary?.scenariosUnreadable !== true,
    detail,
  })
  const pass = gates.every((gate) => gate.pass) && !gated.some((envelope) => envelope.status !== "confirmed")
  return { gates, missing, human, envelopes: opts.envelopes, pass }
};

/** One-shot TCP phase (only `--probe`): declared ports, yaml order,
 * sequential. When the budget runs out the remainder pass unmeasured
 * (`tcpCheck` is not called, so the counter proof holds). */
export const measureTcpPorts = async (opts: {
  ports: number[]
  tcpCheck?: TcpCheck
  budgetMs?: number
  perServiceMs?: number
}): Promise<Map<number, boolean | "unmeasured">> => {
  const tcpCheck = opts.tcpCheck ?? defaultTcpCheck
  const budgetMs = opts.budgetMs ?? PREFLIGHT_BUDGET_MS
  const perServiceMs = opts.perServiceMs ?? PREFLIGHT_PER_SERVICE_MS
  const results = new Map<number, boolean | "unmeasured">()
  const deadline = Date.now() + budgetMs
  for (const port of new Set(opts.ports)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      results.set(port, "unmeasured")
      continue
    }
    const verdict = await Promise.race([
      tcpCheck(port).then(
        (open) => ({ open }),
        () => ({ open: false }),
      ),
      sleep(Math.min(perServiceMs, remaining)).then(() => ({ open: false, timeout: true as const })),
    ])
    results.set(port, "timeout" in verdict ? "unmeasured" : verdict.open)
  }
  return results
};

/** Checkpoint envelope context (tolerant: missing dir or corrupt runs read
 * as empty context, never a failure). Shared by `runPreflight`,
 * `runReadiness`, and the data-clock freshness comparison. */
export const readEnvelopeContext = async (stateDir: string): Promise<EvidenceEnvelope[]> => {
  const envelopes: EvidenceEnvelope[] = []
  try {
    const dir = join(stateDir, CHECKPOINTS_DIR_NAME)
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
    // without a checkpoints dir the envelope context is empty (not a failure)
  }
  return envelopes
}

/** Raw ow.yaml `version:` value (tolerant: anything unparsable reads as absent). */
export const readConfigVersion = (text: string): string | undefined => {
  try {
    const raw = parseSubsetYaml(text)["version"]
    return typeof raw === "string" ? raw : undefined
  } catch {
    return undefined
  }
}

/** Scenario boundary claims for the boundary gate (tolerant: a missing
 * scenarios file opts out silently; an unreadable one fails closed via the
 * `scenariosUnreadable` flag - the validator verb owns schema errors and
 * legacy warnings, this path only maps raw values through M1
 * `normalizeBoundary` and keeps evidence-demanding known boundaries). */
/** Scenario boundary claims for the boundary gate (tolerant: a missing
 * scenarios file opts out silently; an unreadable one fails closed via the
 * `scenariosUnreadable` flag - the validator verb owns schema errors and
 * legacy warnings, this path only maps raw values through M1
 * `normalizeBoundary` and keeps evidence-demanding known boundaries).
 * M9: claims resolve through the same overlay helper as every other
 * reader (flag > local convention > base); an overlay refusal is carried
 * as `overlayError` (callers print it and exit — never silent). */
export const readBoundaryClaims = async (rootDir: string, flagPath?: string): Promise<{
  claims: BoundaryClaim[]
  scenariosUnreadable: boolean
  overlayError: string | null
  overlayExit: 1 | 2
  overlay: import("./up-overlay").OverlayInfo | null
  /** M11: merged scenarios declaring no services (probe-only by decision). */
  serviceless: string[]
}> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(join(rootDir, SCENARIOS_FILE_NAME)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claims: [], scenariosUnreadable: false, overlayError: null, overlayExit: 1, overlay: null, serviceless: [] }
    return { claims: [], scenariosUnreadable: true, overlayError: null, overlayExit: 1, overlay: null, serviceless: [] }
  }
  let parsed: { scenarios: { name: string; services: string[]; boundaries: string[] }[] }
  try {
    parsed = parseScenarios(text)
  } catch {
    return { claims: [], scenariosUnreadable: true, overlayError: null, overlayExit: 1, overlay: null, serviceless: [] }
  }
  const { resolveOverlay, OverlayRefusal } = await import("./up-overlay")
  let merged = parsed
  let overlay: import("./up-overlay").OverlayInfo | null = null
  try {
    const resolved = await resolveOverlay({ rootDir, base: parsed, baseText: text, flagPath })
    merged = resolved.merged
    overlay = resolved.overlay
  } catch (error) {
    if (error instanceof OverlayRefusal) {
      return { claims: [], scenariosUnreadable: true, overlayError: error.message, overlayExit: error.exit, overlay: null, serviceless: [] }
    }
    throw error
  }
  const claims: BoundaryClaim[] = []
  const serviceless: string[] = []
  // Claim dedupe: identical scenario/service/boundary triples collapse
  // (a repeated boundary list entry must not double-report downstream).
  const seenClaims = new Set<string>()
  for (const scenario of merged.scenarios) {
    // M11: no services means no service-bound claims (probe-only by
    // decision) — recorded as an explicit vacuity note downstream, never
    // a silent skip.
    if (scenario.services.length === 0) serviceless.push(scenario.name)
    for (const service of scenario.services) {
      for (const raw of scenario.boundaries) {
        const norm = normalizeBoundary(raw)
        if (norm.known && isEvidenceDemanding(norm.normalized)) {
          const key = `${scenario.name}\n${service}\n${norm.normalized}`
          if (seenClaims.has(key)) continue
          seenClaims.add(key)
          claims.push({ scenario: scenario.name, service, boundary: norm.normalized })
        }
      }
    }
  }
  return { claims, scenariosUnreadable: false, overlayError: null, overlayExit: 1, overlay, serviceless }
}
/** `ow preflight [--json] [--probe] [--file]`: exit 0 passed / 1 missing / 2
 * usage (call site). NO mutation. */
export const runPreflight = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe: boolean
  tcpCheck?: TcpCheck
  budgetMs?: number
  perServiceMs?: number
  boundariesFlag?: string
}): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${opts.file}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  let running = state?.services ?? []
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
      running = []
    }
  }
  const liveness = new Map<string, Liveness>()
  for (const svc of running) liveness.set(svc.name, await realLiveness(svc))
  let tcpResults: Map<number, boolean | "unmeasured"> | undefined
  if (opts.probe) {
    const ports = expected.filter((svc) => svc.port !== undefined).map((svc) => svc.port as number)
    tcpResults = await measureTcpPorts({ ports, tcpCheck: opts.tcpCheck, budgetMs: opts.budgetMs, perServiceMs: opts.perServiceMs })
  }
  const envelopes = await readEnvelopeContext(paths.stateDir)
  const claimsInput = await readBoundaryClaims(opts.rootDir, opts.boundariesFlag)
  if (claimsInput.overlayError !== null) {
    console.error(`ow: ${claimsInput.overlayError}`)
    return claimsInput.overlayExit
  }
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
      serviceless: claimsInput.serviceless,
    },
  })
  const overlay = claimsInput.overlay
  const overlayHuman = overlay !== null && overlay.applied
    ? [`overlay-active: ${overlay.file}`, ...overlay.warnings]
    : []
  // M11: vacuous boundary pass is never silent — probe-only scenarios get
  // an explicit unmeasured-style note on every human branch.
  const servicelessHuman = claimsInput.serviceless.length > 0
    ? [`unmeasured: boundary claims (probe-only: ${claimsInput.serviceless.join(", ")})`]
    : []
  if (opts.json) {
    console.log(JSON.stringify({
      pass: result.pass,
      gates: result.gates,
      missing: result.missing,
      envelopes: result.envelopes,
      ...((overlay !== null && overlay.applied)
        ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources, overlayWarnings: overlay.warnings }
        : {}),
    }))
  } else if (result.pass) {
    console.log("ready: environment passed preflight")
    for (const line of overlayHuman) console.log(line)
    for (const line of servicelessHuman) console.log(line)
  } else {
    for (const line of result.human) console.log(line)
    for (const line of overlayHuman) console.log(line)
    for (const line of servicelessHuman) console.log(line)
  }
  return result.pass ? 0 : 1
}

/** `ow readiness [--json] [--probe] [--file]`: exit 0 ready / 1 missing,
 * stale, or false-green / 2 usage or invalid ow.yaml (call site). Full
 * preflight composition (4 gates) + digest/migration report. Read-only:
 * state/checkpoints/scenarios are read, nothing is written, no probe is
 * executed (`--probe` is one-shot loopback TCP on declared ports only).
 * `declaredArtifacts`/`migrationObserved` are injectable (pure observation
 * inputs, following the `tcpCheck` precedent; the call site passes none). */
export const runReadiness = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe: boolean
  tcpCheck?: TcpCheck
  budgetMs?: number
  perServiceMs?: number
  declaredArtifacts?: Record<string, Record<string, string>>
  migrationObserved?: Record<string, boolean>
  boundariesFlag?: string
}): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${opts.file}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  // M-f vacuity refusal: readiness over zero services proves nothing
  // (exit 2 usage, never a silent pass).
  if (expected.length === 0) {
    console.error("ow: nothing to check (ow.yaml declares no services)")
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  let running = state?.services ?? []
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
      running = []
    }
  }
  const liveness = new Map<string, Liveness>()
  for (const svc of running) liveness.set(svc.name, await realLiveness(svc))
  let tcpResults: Map<number, boolean | "unmeasured"> | undefined
  if (opts.probe) {
    const ports = expected.filter((svc) => svc.port !== undefined).map((svc) => svc.port as number)
    tcpResults = await measureTcpPorts({ ports, tcpCheck: opts.tcpCheck, budgetMs: opts.budgetMs, perServiceMs: opts.perServiceMs })
  }
  const envelopes = await readEnvelopeContext(paths.stateDir)
  const claimsInput = await readBoundaryClaims(opts.rootDir, opts.boundariesFlag)
  if (claimsInput.overlayError !== null) {
    console.error(`ow: ${claimsInput.overlayError}`)
    return claimsInput.overlayExit
  }
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
      declaredArtifacts: opts.declaredArtifacts,
      migrationObserved: opts.migrationObserved,
      serviceless: claimsInput.serviceless,
    },
  })
  const boundaryGate = result.gates.find((gate) => gate.name === "boundary")
  const detail = (boundaryGate?.detail ?? { stale: [], falseGreens: [], artifacts: {}, migrations: {} }) as BoundaryGateDetail
  const overlay = claimsInput.overlay
  const overlayHuman = overlay !== null && overlay.applied
    ? [`overlay-active: ${overlay.file}`, ...overlay.warnings]
    : []
  const servicelessHuman = claimsInput.serviceless.length > 0
    ? [`unmeasured: boundary claims (probe-only: ${claimsInput.serviceless.join(", ")})`]
    : []
  if (opts.json) {
    console.log(JSON.stringify({
      ready: result.pass,
      missing: result.missing,
      stale: detail.stale,
      falseGreens: detail.falseGreens,
      gates: result.gates,
      ...((overlay !== null && overlay.applied)
        ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources, overlayWarnings: overlay.warnings }
        : {}),
    }))
    return result.pass ? 0 : 1
  }
  if (result.pass) {
    console.log("ready: readiness passed")
    for (const line of overlayHuman) console.log(line)
    for (const line of servicelessHuman) console.log(line)
    return 0
  }
  for (const line of result.human) console.log(line)
  for (const [service, view] of Object.entries(detail.artifacts)) {
    const parts = view.shown.map((entry) => `${entry.base}@${entry.digest}`)
    console.log(`build: ${service} ${parts.join(", ")}${view.rest > 0 ? ` +${view.rest} more` : ""}`)
  }
  for (const [service, observed] of Object.entries(detail.migrations)) {
    console.log(`migration: ${service} (${observed ? "history recorded" : "history missing"})`)
  }
  for (const line of overlayHuman) console.log(line)
  for (const line of servicelessHuman) console.log(line)
  return 1
}
