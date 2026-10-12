/** M6 narrowed deterministic scenario-run: 5-phase facade
 * (setup -> run -> assert -> restore -> report). The facade composes existing
 * read paths (config/state/preflight-context/checkpoints) and the shared
 * contract verdict (surfaced, never duplicated); `ow` spawns ONLY declared
 * probe argv (bounded one-shot class). Restore is runner-side: `ow`
 * validates the declared restore argv shape and renders the outcome only -
 * spawning restore inside `ow` is out of contract. try/finally guarantees
 * the restore phase runs even when asserts fail. */

import { join } from "node:path"

import { decodeUtf8Fatal, PROBE_TIMEOUT_MS } from "./up-schema"
import { normalizeBoundary, parseScenarios } from "./up-scenarios"
import type { ScenarioAssert } from "./up-scenarios"
import { maskCmdShape } from "./up-reconcile"
import { maskSecrets } from "./up-evidence"
import { PROBE_RESULT_NOTE_MAX_CHARS, runProbeJob, type ProbeFn, type ProbeOutcome } from "./up-probe"
import { foldCwd } from "./up-replay"
import { checkPreflightGate } from "./up-provision"
import { CHECKPOINTS_DIR_NAME, isValidRunName, readCheckpointFile, viewOf } from "./up-checkpoints"
import type { EvidenceEnvelope } from "./up-evidence"
import { readContractVerdict } from "./up-contract"
import { INIT_INERT_MARKER } from "./up-init"

export type AssertResult = { kind: string; ok: boolean; detail: string }

/** Pure assertion kernel (no I/O): outcomes by probe id, checkpoint
 * envelopes of the selected run, measured run-phase wall ms. */
export const evaluateAsserts = (
  asserts: ScenarioAssert[],
  outcomes: Map<string, ProbeOutcome>,
  envelopes: EvidenceEnvelope[],
  wallMs: number,
): AssertResult[] =>
  asserts.map((assert) => {
    if (assert.kind === "negative") {
      const outcome = outcomes.get(assert.probe)
      const ok = outcome !== undefined && !outcome.ok
      return { kind: assert.kind, ok, detail: ok ? "probe not ready as expected" : `probe ${assert.probe} was ready` }
    }
    if (assert.kind === "readback-by-consumer") {
      const outcome = outcomes.get(assert.probe)
      const confirmed = envelopes.some((envelope) => envelope.stage === assert.stage && envelope.status === "confirmed")
      const ok = outcome !== undefined && outcome.ok && confirmed
      return {
        kind: assert.kind,
        ok,
        detail: ok ? "consumer ready, stage confirmed" : `consumer ${assert.probe} ready=${outcome?.ok ?? "missing"}, stage ${assert.stage} confirmed=${confirmed}`,
      }
    }
    if (assert.kind === "call-count") {
      const found = envelopes.filter((envelope) => envelope.stage === assert.stage).length
      return { kind: assert.kind, ok: found === assert.count, detail: `found ${found}, expected ${assert.count}` }
    }
    return { kind: assert.kind, ok: wallMs <= assert.ms, detail: `wall ${wallMs}ms ${wallMs <= assert.ms ? "within" : "exceeds"} ${assert.ms}ms` }
  })

export type RestoreRunner = (opts: { argv: string[]; scenario: string; rootDir: string }) => Promise<{ ok: boolean; note: string }>

/** Checkpoint runs for assertion/restore reads (tolerant per file). */
const readCheckpointRuns = async (rootDir: string): Promise<{ name: string; envelopes: EvidenceEnvelope[] }[]> => {
  const runs: { name: string; envelopes: EvidenceEnvelope[] }[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    const dir = join(rootDir, ".ow", CHECKPOINTS_DIR_NAME)
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
    for (const file of files) {
      const name = file.slice(0, -".jsonl".length)
      if (!isValidRunName(name)) continue
      try {
        runs.push({ name, envelopes: viewOf(name, await readCheckpointFile(join(dir, file))).envelopes })
      } catch {
        continue
      }
    }
  } catch {
    // No checkpoints dir: empty view, never a failure by itself.
  }
  return runs
}

/** Default restore runner (bare CLI): runner-side outcome read back from
 * the selected run's `restore`-stage envelopes. Absent evidence reads as
 * restore failure - `ow` never spawns restore itself. */
const checkpointRestoreRunner = (envelopes: EvidenceEnvelope[]): RestoreRunner => async () => {
  const restore = envelopes.filter((envelope) => envelope.stage === "restore")
  if (restore.length === 0) return { ok: false, note: "restore evidence absent" }
  const failed = restore.find((envelope) => envelope.status !== "confirmed")
  if (failed !== undefined) return { ok: false, note: `restore stage ${failed.status}` }
  return { ok: true, note: "restore stage confirmed" }
}

export type ScenarioPhase = { name: string; ok: boolean; detail: Record<string, unknown> }

const RECORDABLE_RUN: ReadonlySet<string> = new Set(["real-read-only", "subscribed", "network-deny"])

/** `ow scenario run <name> [--json] [--file] [--run <id>] [--off-local]`:
 * exit 0 pass / 1 assert-or-restore-failure (restore still runs) /
 * 2 usage-or-refusal (unknown scenario, INERT, non-goal, off-local
 * without confirm, out-of-scope boundary, unreadable run). */
export const runScenarioRun = async (opts: {
  rootDir: string
  file: string
  name: string
  runId?: string
  offLocal?: boolean
  json: boolean
  probeFn?: ProbeFn
  runner?: RestoreRunner
  boundariesFlag?: string
}): Promise<number> => {
  const { readFileSync } = await import("node:fs")
  let text: string
  try {
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: scenario file missing: ${opts.file}`)
    } else {
      console.error(`ow: invalid scenarios file: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 1
  }
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (firstLine.trim() === INIT_INERT_MARKER) {
    console.error(`INERT: ${opts.file}`)
    return 2
  }
  let parsed: ReturnType<typeof parseScenarios>
  try {
    parsed = parseScenarios(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("non-goal rejected")) {
      console.error(`ow: ${message}`)
      return 2
    }
    console.error(`ow: invalid scenarios file: ${message}`)
    return 1
  }
  // M9: the runner resolves through the shared overlay helper (flag >
  // local convention > base); the merged view feeds lookup, scope gates,
  // and the contract verdict identically in every reader.
  const { resolveOverlay, OverlayRefusal, overlayBannerLine } = await import("./up-overlay")
  let overlay: import("./up-overlay").OverlayInfo | null = null
  try {
    const resolved = await resolveOverlay({ rootDir: opts.rootDir, base: parsed, baseText: text, flagPath: opts.boundariesFlag })
    parsed = resolved.merged
    overlay = resolved.overlay
  } catch (error) {
    if (error instanceof OverlayRefusal) {
      console.error(`ow: ${error.message}`)
      return error.exit
    }
    throw error
  }
  const banner = overlayBannerLine(overlay)
  const scenario = parsed.scenarios.find((entry) => entry.name === opts.name)
  if (scenario === undefined) {
    console.error(`ow: scenario not found: ${opts.name}`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  if (scenario.mode === "off-local" && opts.offLocal !== true) {
    console.error(`ow: cannot run ${scenario.name} — off-local mode needs --off-local confirm`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  if (scenario.deps.some((dep) => dep.mode === "off-local") && opts.offLocal !== true) {
    console.error(`ow: cannot run ${scenario.name} — off-local dep needs --off-local confirm`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  const normalized = scenario.boundaries.map((raw) => normalizeBoundary(raw))
  const refused = normalized.find((norm) => norm.known && (norm.normalized === "real-state-changing" || norm.normalized.startsWith("blocked:")))
  if (refused !== undefined) {
    console.error(`ow: cannot run ${scenario.name} (${maskSecrets(refused.normalized)}) — state-changing boundaries are out of scope`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  const recordable = normalized.filter((norm) => norm.known && RECORDABLE_RUN.has(norm.normalized))
  if (recordable.length === 0) {
    console.error(`ow: cannot run ${scenario.name} — no deterministic boundary`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  if (scenario.restore === null) {
    console.error(`ow: cannot run ${scenario.name} — no restore declared`)
    if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
    return 2
  }
  // Contract gate first: never run a tampered or unrecorded contract.
  const verdict = await readContractVerdict(opts.rootDir, scenario)
  if (verdict.status !== "match") {
    const line = verdict.status === "unknown"
      ? `unknown-record: ${scenario.name}`
      : verdict.status === "provenance-bad"
        ? `provenance-missing: ${scenario.name}`
        : `contract-mismatch: ${scenario.name}`
    if (opts.json) {
      console.log(JSON.stringify({
        scenario: scenario.name,
        phases: [],
        restored: false,
        contract: { pass: false },
        report: { verdict: line },
        ...((overlay !== null && overlay.applied)
          ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources }
          : {}),
      }))
    } else {
      console.log(line)
      if (overlay !== null && overlay.applied) console.log(`overlay-active: ${overlay.file}`)
    }
    return 1
  }
  // Setup context (report-only): preflight read path + service inventory.
  // A failing preflight never gates the run; the contract verdict above is
  // the only setup gate.
  const gate = await checkPreflightGate({ rootDir: opts.rootDir, file: join(opts.rootDir, "ow.yaml"), probe: false }).catch(() => ({ ok: false as boolean, note: "preflight unreadable", missing: [] as string[] }))
  const runs = await readCheckpointRuns(opts.rootDir)
  let selected: EvidenceEnvelope[]
  if (opts.runId !== undefined) {
    const found = runs.find((run) => run.name === opts.runId)
    if (found === undefined) {
      console.error(`ow: unknown run: ${opts.runId}`)
      if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
      return 2
    }
    selected = found.envelopes
  } else {
    let best: { name: string; envelopes: EvidenceEnvelope[] } | null = null
    let bestAt = Number.NEGATIVE_INFINITY
    for (const run of runs) {
      let at = Number.NEGATIVE_INFINITY
      for (const envelope of run.envelopes) {
        const ms = Date.parse(envelope.at)
        if (Number.isFinite(ms) && ms >= at) at = ms
      }
      if (best === null || at >= bestAt) {
        best = run
        bestAt = at
      }
    }
    selected = best?.envelopes ?? []
  }
  const phases: ScenarioPhase[] = []
  phases.push({
    name: "setup",
    ok: true,
    detail: {
      services: [...scenario.services],
      mode: scenario.mode,
      boundaries: recordable.map((norm) => norm.normalized),
      preflight: { pass: gate.ok, missing: gate.missing },
      contract: { pass: true },
    },
  })
  // Run phase: declared probes only, sequential, wall-clocked.
  const runProbe = opts.probeFn ?? runProbeJob
  const outcomes = new Map<string, ProbeOutcome>()
  const outcomeShapes: { id: string; argvShape: string; timeout: string; ok: boolean; ms: number; note: string }[] = []
  const wallStart = Date.now()
  for (const probe of scenario.probes) {
    const timeoutMs = PROBE_TIMEOUT_MS[probe.timeout as keyof typeof PROBE_TIMEOUT_MS] ?? PROBE_TIMEOUT_MS["10s"]
    const started = Date.now()
    let outcome: ProbeOutcome
    try {
      outcome = await runProbe({ probe: probe.argv, timeoutMs, cwd: opts.rootDir, env: { ...process.env } })
    } catch {
      outcome = { ok: false, note: "could not run", timedOut: false, code: null }
    }
    const ms = Date.now() - started
    outcomes.set(probe.id, outcome)
    outcomeShapes.push({
      id: probe.id,
      argvShape: foldCwd(maskCmdShape(probe.argv) ?? "", opts.rootDir),
      timeout: probe.timeout,
      ok: outcome.ok,
      ms,
      note: foldCwd(maskSecrets(outcome.note ?? ""), opts.rootDir).slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
    })
  }
  const wallMs = Date.now() - wallStart
  const probesOk = outcomeShapes.filter((entry) => entry.ok).length
  // Probes expected to fail (covered by a negative assert) do not fail the
  // run phase; uncovered failures do.
  const negativeCover = new Set(
    scenario.asserts.filter((assert) => assert.kind === "negative").map((assert) => assert.probe),
  )
  const runOk = [...outcomes.entries()].every(([id, outcome]) => outcome.ok || negativeCover.has(id))
  phases.push({ name: "run", ok: runOk, detail: { outcomes: outcomeShapes } })
  // Assert phase: pure kernel over outcomes + selected envelopes + wall clock.
  const assertResults = evaluateAsserts(scenario.asserts, outcomes, selected, wallMs)
  const assertsOk = assertResults.filter((entry) => entry.ok).length
  phases.push({ name: "assert", ok: assertsOk === assertResults.length, detail: { results: assertResults } })
  // Restore phase (mandatory, try/finally shaped): the runner executes the
  // declared restore argv; `ow` validates the shape (already schema-checked
  // at parse) and renders the masked shape + outcome only.
  const restoreShape = foldCwd(maskCmdShape(scenario.restore.argv) ?? "", opts.rootDir)
  const runner = opts.runner ?? checkpointRestoreRunner(selected)
  let restoreOutcome: { ok: boolean; note: string }
  try {
    restoreOutcome = await runner({ argv: [...scenario.restore.argv], scenario: scenario.name, rootDir: opts.rootDir })
  } catch (error) {
    restoreOutcome = { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
  const restored = restoreOutcome.ok
  phases.push({ name: "restore", ok: restored, detail: { argvShape: restoreShape, outcome: { ok: restoreOutcome.ok, note: maskSecrets(restoreOutcome.note) } } })
  const pass = phases.every((phase) => phase.ok)
  phases.push({
    name: "report",
    ok: true,
    detail: {
      probesRun: outcomeShapes.length,
      probesOk,
      assertsOk,
      assertsTotal: assertResults.length,
      restoreNote: maskSecrets(restoreOutcome.note),
    },
  })
  if (opts.json) {
    console.log(JSON.stringify({
      scenario: scenario.name,
      phases: phases.map((phase) => ({ name: phase.name, ok: phase.ok, detail: phase.detail })),
      restored,
      contract: { pass: true },
      report: phases[4].detail,
      ...((overlay !== null && overlay.applied)
        ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources, overlayWarnings: overlay.warnings }
        : {}),
    }))
    return pass ? 0 : 1
  }
  console.log(`setup: ${scenario.name} ok (${scenario.probes.length} probes, ${scenario.asserts.length} asserts)`)
  console.log(`run: ${scenario.name} ${probesOk}/${outcomeShapes.length} probes ok`)
  console.log(
    assertResults.length === 0
      ? `assert: ${scenario.name} ok (no asserts)`
      : `assert: ${scenario.name} ${assertsOk}/${assertResults.length} asserts ok`,
  )
  console.log(`restore: ${restoreShape}`)
  console.log(restored ? `restored: ${scenario.name}` : `restore-failed: ${scenario.name} (${maskSecrets(restoreOutcome.note)})`)
  console.log(`report: ${scenario.name} ${pass ? "pass" : "fail"}`)
  if (overlay !== null && overlay.applied) console.log(`overlay-active: ${overlay.file}`)
  return pass ? 0 : 1
}
