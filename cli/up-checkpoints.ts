/** P2-A checkpoint convention + read-only render. The runner WRITES
 * (`<root>/.ow/checkpoints/<run>.jsonl`, atomic tmp+rename, ≤256KB/≤500
 * lines — on overrun the runner prunes oldest-first), ow ONLY READS (never
 * prunes, never writes). No live exec (probe/health/git/lsof are not run). */

import { readdir, readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"

import { applyFreshness, capText, maskSecrets, normalizeEnvelope, summarizeFresh, type EvidenceEnvelope, type FreshSummary } from "./up-evidence"
import { upPaths } from "./up-state"

export const CHECKPOINTS_DIR_NAME = "checkpoints"
export const CHECKPOINT_MAX_LINES = 500
export const CHECKPOINT_MAX_BYTES = 256 * 1024

/** Run-name allowlist (no path traversal: `/` and `..` are rejected). */
export const isValidRunName = (run: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(run)

export const checkpointFile = (rootDir: string, run: string): string =>
  join(upPaths(rootDir).stateDir, CHECKPOINTS_DIR_NAME, `${run}.jsonl`)

export type CheckpointRead = {
  envelopes: EvidenceEnvelope[]
  totalLines: number
  skipped: { corrupt: number; overCap: number }
}

/** Line-by-line jsonl read: blank lines pass silently; corrupt lines +
 * cap overflow (500 lines / 256KB, whichever fills first) are counted as
 * `skipped`, the file is NEVER modified. */
export const readCheckpointFile = async (file: string): Promise<CheckpointRead> => {
  // M-j FIFO/hang guard (partial): lstat regular-file-only upfront, then
  // O_NONBLOCK open + fstat dev/ino pin (cheap TOCTOU narrowing; the
  // residual parent-dir swap window is documented, not closed — runner
  // writes are trusted but verified, hostile mounts are out of scope).
  const { lstat: lstatFile, open: openFile } = await import("node:fs/promises")
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = await import("node:constants")
  const entry = await lstatFile(file)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`checkpoint unreadable: ${file}`)
  const handle = await openFile(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  let text: string
  try {
    const pinned = await handle.stat()
    if (!pinned.isFile() || pinned.dev !== entry.dev || pinned.ino !== entry.ino) {
      throw new Error(`checkpoint unreadable: ${file}`)
    }
    text = await handle.readFile("utf8")
  } finally {
    await handle.close().catch(() => undefined)
  }
  const lines = text.split("\n")
  const totalLines = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  const envelopes: EvidenceEnvelope[] = []
  let corrupt = 0
  let processed = 0
  let bytes = 0
  for (const line of lines) {
    if (line.trim().length === 0) continue
    if (processed >= CHECKPOINT_MAX_LINES || bytes >= CHECKPOINT_MAX_BYTES) break
    bytes += Buffer.byteLength(line, "utf8") + 1
    processed += 1
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      corrupt += 1
      continue
    }
    const normalized = normalizeEnvelope(raw)
    if (!normalized.ok) {
      corrupt += 1
      continue
    }
    envelopes.push(normalized.envelope)
  }
  // Cap overflow = NON-BLANK lines beyond the cap window (blank lines do not
  // count; corrupt lines are counted separately).
  const nonBlankTotal = lines.filter((line) => line.trim().length > 0).length
  return { envelopes, totalLines, skipped: { corrupt, overCap: Math.max(0, nonBlankTotal - processed) } }
}

const STALE_EN: Record<string, string> = {
  script_hash: "script_hash",
  checkout_rev: "checkout_rev",
  runtime: "runtime",
  missing_basis: "missing_basis",
}

/** M-A (#2): side-effect word. A missing field (`undefined`) ≡ `unknown`
 * (no warning). The rendered word is always one of the English enum values. */
const SIDE_EFFECT_EN: Record<string, string> = {
  none: "none",
  attempted: "attempted",
  confirmed: "confirmed",
  unknown: "unknown",
}

const sideEffectWord = (envelope: EvidenceEnvelope): string =>
  SIDE_EFFECT_EN[envelope.side_effect ?? "unknown"] ?? "unknown"

/** Envelope flag line (English, no comments; counts are render-only passthrough). */
export const formatSideEffectLine = (envelope: EvidenceEnvelope): string => {
  const parts = [`side-effect: ${envelope.stage} (${sideEffectWord(envelope)}`]
  const counts: string[] = []
  if (envelope.side_effect_counts?.attempted !== undefined) counts.push(`attempted: ${envelope.side_effect_counts.attempted}`)
  if (envelope.side_effect_counts?.confirmed !== undefined) counts.push(`confirmed: ${envelope.side_effect_counts.confirmed}`)
  return counts.length > 0 ? `${parts[0]}, ${counts.join(", ")})` : `${parts[0]})`
}

/** M-A (#2): pre-reconcile retry hint (locked text; no button/automatic
 * action — a read-only suggestion). */
export const RETRY_HINT = "before-retry: ow reconcile --check"

/** If a stage has `attempted` with no following `confirmed` it counts as
 * unconfirmed (file order = time order). */
export const isAttemptedUnconfirmed = (envelopes: EvidenceEnvelope[], index: number): boolean => {
  const envelope = envelopes[index]
  if (envelope.side_effect !== "attempted") return false
  for (let i = index + 1; i < envelopes.length; i += 1) {
    if (envelopes[i].stage === envelope.stage && envelopes[i].side_effect === "confirmed") return false
  }
  return true
}

/** If any envelope carries an attempted-unconfirmed, the hint is needed (one line). */
export const needsRetryHint = (envelopes: EvidenceEnvelope[]): boolean =>
  envelopes.some((_, index) => isAttemptedUnconfirmed(envelopes, index))

/** M-A (#3): run-name suffix parsing (`<scenario>-attempt<N>`,
 * N 1..999). Explicit fields always win; the parse is only a fallback.
 * A removed non-English alias stays unattributed by decision
 * (flat, ungrouped — covered by the ungrouped-negative test). */
export const parseAttemptSuffix = (run: string): { scenario: string; attempt: number } | null => {
  const match = /^(.*)-attempt(\d{1,3})$/.exec(run)
  if (!match) return null
  const scenario = match[1]
  const attempt = Number.parseInt(match[2], 10)
  if (scenario.length === 0 || !Number.isInteger(attempt) || attempt < 1 || attempt > 999) return null
  return { scenario, attempt }
}

export type LineageOf = { scenario: string | null; attempt: number | null }

/** Lineage resolution (explicit-wins per field): the explicit `scenario`/`attempt`
 * if present; otherwise the run-name suffix; if neither, unattributed (flat, ungrouped). */
export const lineageOf = (envelope: EvidenceEnvelope, run: string): LineageOf => {
  const fallback = parseAttemptSuffix(run)
  return {
    scenario: envelope.scenario ?? fallback?.scenario ?? null,
    attempt: envelope.attempt ?? fallback?.attempt ?? null,
  }
}

const STATUS_WORD: Record<string, string> = {
  confirmed: "confirmed",
  not_observed: "not-observed",
  stale: "stale",
}

const leafWords = (envelopes: EvidenceEnvelope[], index: number): string => {
  const envelope = envelopes[index]
  const words = [STATUS_WORD[envelope.status] ?? envelope.status]
  if (isAttemptedUnconfirmed(envelopes, index)) words.push("unconfirmed")
  return words.join(", ")
}

/** M-A (#3): `scenario → attempt → stage` tree. Unattributed lines do not
 * enter the tree (they stay in the flat list — no grouping). Locked words:
 * `scenario`, `attempt`, `unconfirmed` (only on an attempted-unconfirmed leaf). */
export const formatAttemptTree = (run: string, envelopes: EvidenceEnvelope[]): string[] => {
  const byScenario = new Map<string, { attempts: Map<number, number[]>; flat: number[] }>()
  envelopes.forEach((envelope, index) => {
    const { scenario, attempt } = lineageOf(envelope, run)
    if (scenario === null) return
    let group = byScenario.get(scenario)
    if (!group) {
      group = { attempts: new Map(), flat: [] }
      byScenario.set(scenario, group)
    }
    if (attempt === null) group.flat.push(index)
    else {
      const bucket = group.attempts.get(attempt) ?? []
      bucket.push(index)
      group.attempts.set(attempt, bucket)
    }
  })
  const lines: string[] = []
  for (const [scenario, group] of byScenario) {
    lines.push(`scenario: ${scenario}`)
    for (const attempt of [...group.attempts.keys()].sort((a, b) => a - b)) {
      for (const index of group.attempts.get(attempt) as number[]) {
        lines.push(`  attempt ${attempt}: ${envelopes[index].stage} (${leafWords(envelopes, index)})`)
      }
    }
    for (const index of group.flat) {
      lines.push(`  ${envelopes[index].stage} (${leafWords(envelopes, index)})`)
    }
  }
  return lines
}

/** Envelope human line (English, no comments). */
export const formatEnvelopeLine = (envelope: EvidenceEnvelope): string => {
  if (envelope.status === "confirmed") return `confirmed: ${envelope.stage} (${envelope.at})`
  if (envelope.status === "not_observed") return `not-observed: ${envelope.stage}`
  return `stale: ${envelope.stage} (reason: ${STALE_EN[envelope.stale_reason as string] ?? envelope.stale_reason})`
}

const singleLine = (text: string): string => text.replace(/[\r\n]+/g, " ")

export type CheckpointView = {
  run: string
  envelopes: EvidenceEnvelope[]
  summary: FreshSummary
  last_verified: EvidenceEnvelope | null
  first_gap: EvidenceEnvelope | null
  skipped: { corrupt: number; overCap: number }
}

export const viewOf = (run: string, read: CheckpointRead): CheckpointView => {
  const fresh = applyFreshness(read.envelopes)
  const { summary, last_verified, first_gap } = summarizeFresh(fresh)
  return { run, envelopes: fresh, summary, last_verified, first_gap, skipped: read.skipped }
}

const warnSkipped = (json: boolean, skipped: { corrupt: number; overCap: number }): void => {
  if (skipped.corrupt > 0 && !json) console.error(`corrupt-line: ${skipped.corrupt} (skipped)`)
  if (skipped.overCap > 0 && !json) console.error(`skipped(${skipped.overCap}): over cap (file read within 500-line/256KB limit)`)
}

/** `ow checkpoints list [--json]`: run name + envelope count + summary + last `at`.
 * Read-only, an empty list if the directory is missing; exit is always 0. */
export const runCheckpointsList = async (opts: { rootDir: string; json: boolean }): Promise<number> => {
  const dir = join(upPaths(opts.rootDir).stateDir, CHECKPOINTS_DIR_NAME)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
  } catch {
    files = []
  }
  const runs: { run: string; count: number; summary: FreshSummary; lastAt: string | null; skipped: { corrupt: number; overCap: number } }[] = []
  for (const file of files) {
    const run = file.slice(0, -".jsonl".length)
    if (!isValidRunName(run)) continue
    let read: CheckpointRead
    try {
      read = await readCheckpointFile(join(dir, file))
    } catch {
      continue
    }
    const view = viewOf(run, read)
    let lastAt: string | null = null
    for (const envelope of view.envelopes) {
      if (lastAt === null || Date.parse(envelope.at) > Date.parse(lastAt)) lastAt = envelope.at
    }
    runs.push({ run, count: view.envelopes.length, summary: view.summary, lastAt, skipped: view.skipped })
  }
  if (opts.json) {
    console.log(JSON.stringify({ runs }))
  } else if (runs.length === 0) {
    console.log("no checkpoints")
  } else {
    for (const entry of runs) {
      console.log(
        `${entry.run} (${entry.count} envelopes: ${entry.summary.confirmed} confirmed, ${entry.summary.stale} stale, ${entry.summary.not_observed} not-observed; last: ${entry.lastAt ?? "none"})`,
      )
    }
  }
  return 0
}

/** `ow checkpoints show <run> [--json]`: exit 1 if the file is missing, exit 2
 * for an invalid run name, corrupt lines are skipped (not a failure). */
export const runCheckpointsShow = async (opts: { rootDir: string; run: string; json: boolean }): Promise<number> => {
  if (!isValidRunName(opts.run)) {
    console.error(`ow: invalid run name: ${opts.run} (allowed: [A-Za-z0-9_.-], at most 64 characters)`)
    return 2
  }
  const file = checkpointFile(opts.rootDir, opts.run)
  let read: CheckpointRead
  try {
    await stat(file)
    read = await readCheckpointFile(file)
  } catch {
    console.error(`ow: no checkpoint: ${opts.run}`)
    return 1
  }
  const view = viewOf(opts.run, read)
  warnSkipped(opts.json, view.skipped)
  // M-g: nothing readable (all lines corrupt/over-cap) exits 1 like a
  // missing file — "checkpoint empty" exit 0 is reserved for genuinely
  // empty-but-valid runs. Skipped counts already warned above (or ride
  // in JSON below); the exit code is the machine signal.
  const nothingReadable = view.envelopes.length === 0 && (view.skipped.corrupt > 0 || view.skipped.overCap > 0)
  if (opts.json) {
    console.log(
      JSON.stringify({
        run: view.run,
        envelopes: view.envelopes,
        summary: view.summary,
        last_verified: view.last_verified,
        first_gap: view.first_gap,
        skipped: view.skipped,
      }),
    )
    return nothingReadable ? 1 : 0
  }
  if (view.envelopes.length === 0) {
    console.log(`checkpoint empty: ${opts.run}`)
    return nothingReadable ? 1 : 0
  }
  for (const envelope of view.envelopes) console.log(formatEnvelopeLine(envelope))
  for (const envelope of view.envelopes) console.log(formatSideEffectLine(envelope))
  console.log(view.last_verified ? `last confirmed: ${view.last_verified.stage} (${view.last_verified.at})` : "last confirmed: none")
  if (view.first_gap) {
    const why =
      view.first_gap.status === "not_observed" ? "not-observed" : `stale: ${STALE_EN[view.first_gap.stale_reason as string] ?? view.first_gap.stale_reason}`
    console.log(`first missing: ${view.first_gap.stage} (${why})`)
  } else {
    console.log("first missing: none")
  }
  const actionSource = view.first_gap ?? view.envelopes[view.envelopes.length - 1]
  if (actionSource.safe_next_action !== undefined) console.log(`next: ${singleLine(actionSource.safe_next_action)}`)
  if (needsRetryHint(view.envelopes)) console.log(RETRY_HINT)
  for (const line of formatAttemptTree(view.run, view.envelopes)) console.log(line)
  return 0
}

/** M12 `ow checkpoints diff <runA> <runB>`: read-only envelope-by-stage
 * table (status / proof-head / digest deltas). Runner WRITES both runs,
 * ow only READS (bounded per-file caps, no spawn, no mutation).
 * Proof is already secret-masked at read time; heads are masked again +
 * root-folded before render (masked shapes only — secrets/abs-paths never
 * reach output). Digests render short-8 (human and JSON alike). */

export const PROOF_HEAD_MAX_CHARS = 80

/** sha256 short-8 (digests travel reduced only, never full). */
export const shortDigestOf = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)

/** Root-absolute paths fold to `<root>` (structural canonicalization,
 * applied AFTER value masking — `up-replay.ts` `foldCwd` mirror kept
 * local so checkpoints stay free of the replay dependency chain). */
const foldRootDir = (text: string, rootDir: string): string => {
  const root = rootDir.endsWith("/") && rootDir.length > 1 ? rootDir.slice(0, -1) : rootDir
  return text.split(`${root}/`).join("<root>/").split(root).join("<root>")
}

/** Masked + folded + single-line proof head (cap 80, truncation marked).
 * Object proofs stringify first; the read path already masked values, so
 * this second pass is defense-in-depth (idempotent on clean text). */
export const proofHeadOf = (proof: unknown, rootDir: string): string =>
  capText(singleLine(foldRootDir(maskSecrets(typeof proof === "string" ? proof : (JSON.stringify(proof) ?? "")), rootDir)), PROOF_HEAD_MAX_CHARS)

/** Render-safe stage label (free text: mask + fold + newline-collapse, so
 * the one-line-per-stage table holds even for hostile stage names; plain
 * names pass through). */
export const diffStageOf = (stage: string, rootDir: string): string =>
  singleLine(foldRootDir(maskSecrets(stage), rootDir))

/** Digest input: post-freshness envelope subset (stable key order).
 * Covers status + stale reason + proof + code/runtime slots + the
 * freshness-orthogonal witness fields (side_effect, side_effect_counts,
 * scenario, attempt, step_signature, data), so any witness-relevant
 * change flips the digest. Freshness orthogonality is about status
 * derivation only — it never exempts a field from diff identity. */
export const digestInputOf = (envelope: EvidenceEnvelope): string =>
  JSON.stringify({
    stage: envelope.stage,
    status: envelope.status,
    stale_reason: envelope.status === "stale" ? envelope.stale_reason : null,
    proof: envelope.proof,
    code: envelope.code ?? null,
    runtime: envelope.runtime ?? null,
    side_effect: envelope.side_effect ?? null,
    side_effect_counts: envelope.side_effect_counts ?? null,
    scenario: envelope.scenario ?? null,
    attempt: envelope.attempt ?? null,
    step_signature: envelope.step_signature ?? null,
    data: envelope.data ?? null,
  })

export type CheckpointDiffRow = {
  stage: string
  statusA: string
  statusB: string
  staleReasonA: string | null
  staleReasonB: string | null
  proofHeadA: string | null
  proofHeadB: string | null
  digestA: string | null
  digestB: string | null
  changed: boolean
}

export type CheckpointDiff = {
  runA: string
  runB: string
  identical: boolean
  rows: CheckpointDiffRow[]
  skipped: { runA: { corrupt: number; overCap: number }; runB: { corrupt: number; overCap: number } }
}

const MISSING_WORD = "missing"
const MISSING_CELL = "-"

/** Locked status word: stale carries its reason (`stale:script_hash`). */
export const diffStatusWord = (status: string, staleReason: string | null): string =>
  status === "not_observed" ? "not-observed" : status === "stale" ? `stale:${staleReason ?? "unknown"}` : status

/** Pure fold: two post-freshness envelope lists → stage-union rows
 * (file order = time: last envelope per stage wins, sorted by stage). */
export const foldDiff = (envelopesA: EvidenceEnvelope[], envelopesB: EvidenceEnvelope[], rootDir: string): CheckpointDiffRow[] => {
  const lastA = new Map<string, EvidenceEnvelope>()
  for (const envelope of envelopesA) lastA.set(envelope.stage, envelope)
  const lastB = new Map<string, EvidenceEnvelope>()
  for (const envelope of envelopesB) lastB.set(envelope.stage, envelope)
  const stages = [...new Set([...lastA.keys(), ...lastB.keys()])].sort()
  return stages.map((stage) => {
    const a = lastA.get(stage) ?? null
    const b = lastB.get(stage) ?? null
    const row: CheckpointDiffRow = {
      stage: diffStageOf(stage, rootDir),
      statusA: a?.status ?? MISSING_WORD,
      statusB: b?.status ?? MISSING_WORD,
      staleReasonA: a?.status === "stale" ? (a.stale_reason as string) : null,
      staleReasonB: b?.status === "stale" ? (b.stale_reason as string) : null,
      proofHeadA: a ? proofHeadOf(a.proof, rootDir) : null,
      proofHeadB: b ? proofHeadOf(b.proof, rootDir) : null,
      digestA: a ? shortDigestOf(digestInputOf(a)) : null,
      digestB: b ? shortDigestOf(digestInputOf(b)) : null,
      changed: false,
    }
    row.changed = row.statusA !== row.statusB || row.proofHeadA !== row.proofHeadB || row.digestA !== row.digestB
    return row
  })
}

/** Locked human row: always the status delta; proof/digest cells render
 * only when they differ (unchanged sides repeat the same value). */
export const formatDiffRow = (row: CheckpointDiffRow): string => {
  const wordA = row.statusA === MISSING_WORD ? MISSING_WORD : diffStatusWord(row.statusA, row.staleReasonA)
  const wordB = row.statusB === MISSING_WORD ? MISSING_WORD : diffStatusWord(row.statusB, row.staleReasonB)
  const parts = [`diff: ${row.stage} (${wordA} -> ${wordB})`]
  if (row.proofHeadA !== row.proofHeadB) parts.push(`proof: ${row.proofHeadA ?? MISSING_CELL} -> ${row.proofHeadB ?? MISSING_CELL}`)
  if (row.digestA !== row.digestB) parts.push(`digest: ${row.digestA ?? MISSING_CELL} -> ${row.digestB ?? MISSING_CELL}`)
  return parts.join(", ")
}

/** Locked identical line (explicit, never empty output). */
export const identicalLine = (runA: string, runB: string, stages: number): string =>
  `identical: ${runA} == ${runB} (${stages} stages)`

/** `ow checkpoints diff <runA> <runB> [--json]`: exit 0 with the table
 * (identical runs print the identical line), exit 1 when a run is
 * missing/unreadable/fully-corrupt, exit 2 on invalid names (usage). */
export const runCheckpointsDiff = async (opts: { rootDir: string; runA: string; runB: string; json: boolean }): Promise<number> => {
  for (const runName of [opts.runA, opts.runB]) {
    if (!isValidRunName(runName)) {
      console.error(`ow: invalid run name: ${runName} (allowed: [A-Za-z0-9_.-], at most 64 characters)`)
      return 2
    }
  }
  const reads: { run: string; read: CheckpointRead }[] = []
  for (const runName of [opts.runA, opts.runB]) {
    let read: CheckpointRead
    try {
      await stat(checkpointFile(opts.rootDir, runName))
      read = await readCheckpointFile(checkpointFile(opts.rootDir, runName))
    } catch {
      console.error(`ow: no checkpoint: ${runName}`)
      return 1
    }
    reads.push({ run: runName, read })
  }
  // Fully-unreadable run (all lines corrupt/capped) exits 1 like a missing
  // file — the `show` M-g precedent. Partial skips only warn below.
  for (const entry of reads) {
    if (entry.read.envelopes.length === 0 && (entry.read.skipped.corrupt > 0 || entry.read.skipped.overCap > 0)) {
      if (opts.json) {
        console.log(
          JSON.stringify({
            runA: opts.runA,
            runB: opts.runB,
            identical: false,
            rows: [],
            skipped: { runA: reads[0].read.skipped, runB: reads[1].read.skipped },
          } satisfies CheckpointDiff),
        )
      } else {
        for (const other of reads) {
          if (other.read.skipped.corrupt > 0) console.error(`corrupt-line: ${other.run}: ${other.read.skipped.corrupt} (skipped)`)
          if (other.read.skipped.overCap > 0) {
            console.error(`skipped(${other.run}: ${other.read.skipped.overCap}): over cap (file read within 500-line/256KB limit)`)
          }
        }
        console.error(`ow: unreadable checkpoint: ${entry.run}`)
      }
      return 1
    }
  }
  const viewA = viewOf(opts.runA, reads[0].read)
  const viewB = viewOf(opts.runB, reads[1].read)
  const rows = foldDiff(viewA.envelopes, viewB.envelopes, opts.rootDir)
  const diff: CheckpointDiff = {
    runA: opts.runA,
    runB: opts.runB,
    identical: rows.every((row) => !row.changed),
    rows,
    skipped: { runA: reads[0].read.skipped, runB: reads[1].read.skipped },
  }
  if (opts.json) {
    console.log(JSON.stringify(diff))
    return 0
  }
  if (diff.skipped.runA.corrupt > 0) console.error(`corrupt-line: ${opts.runA}: ${diff.skipped.runA.corrupt} (skipped)`)
  if (diff.skipped.runA.overCap > 0) {
    console.error(`skipped(${opts.runA}: ${diff.skipped.runA.overCap}): over cap (file read within 500-line/256KB limit)`)
  }
  if (diff.skipped.runB.corrupt > 0) console.error(`corrupt-line: ${opts.runB}: ${diff.skipped.runB.corrupt} (skipped)`)
  if (diff.skipped.runB.overCap > 0) {
    console.error(`skipped(${opts.runB}: ${diff.skipped.runB.overCap}): over cap (file read within 500-line/256KB limit)`)
  }
  if (diff.identical) {
    console.log(identicalLine(opts.runA, opts.runB, diff.rows.length))
  } else {
    for (const row of diff.rows) console.log(formatDiffRow(row))
  }
  return 0
}
