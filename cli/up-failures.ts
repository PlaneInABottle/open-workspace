/** M-D failures: mechanical repeat-class render over runner-written
 * checkpoint runs. Runner WRITES (`<root>/.ow/checkpoints/*.jsonl`), ow
 * only READS (no prune, no write) and SHOWS. Bounded file reads are the
 * only I/O on this path (no subprocess, no mutation).
 *
 * Render discipline: candidates are post-freshness non-confirmed
 * envelopes across every retained run. Exact tuple
 * (stage, status, stale_reason, step_signature) decides the render
 * bucket — missing step renders as `-`. Nothing else decides: no
 * message scan, no inference, no invented ordering beyond the fixed
 * tuple sort. The two-attempt rule lives HERE (never in show): a
 * (scenario, stage) partition renders only with 2+ non-confirmed
 * occurrences; singletons fold into one fixed summary line.
 * Exit is 0 except when files exist but nothing is readable
 * (all corrupt/capped → exit 1); usage errors exit 2 at the dispatcher. */

import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { CHECKPOINTS_DIR_NAME, isValidRunName, lineageOf, readCheckpointFile, viewOf } from "./up-checkpoints"
import type { EvidenceEnvelope } from "./up-evidence"
import { upPaths } from "./up-state"

/** Locked `--since` set (anything else is a usage error). */
export const FAILURES_SINCE_OPTIONS = ["1h", "24h", "7d"] as const

const SINCE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
}

/** `--since` in English units: undefined = every retained envelope;
 * null = outside the locked set (caller reports usage, exit 2). */
export const parseFailuresSince = (raw: string | boolean | undefined): number | undefined | null => {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") return null
  return SINCE_MS[raw] ?? null
}

export type FailureTuple = {
  stage: string
  status: string
  stale_reason: string | null
  step: string | null
  count: number
}

export type FailuresView = {
  groups: FailureTuple[]
  singletons: number
}

type Candidate = { envelope: EvidenceEnvelope; run: string }

/** Fixed tuple render order (stage, status, reason, step). */
const compareTuples = (a: FailureTuple, b: FailureTuple): number =>
  a.stage < b.stage ? -1
  : a.stage > b.stage ? 1
  : a.status < b.status ? -1
  : a.status > b.status ? 1
  : (a.stale_reason ?? "") < (b.stale_reason ?? "") ? -1
  : (a.stale_reason ?? "") > (b.stale_reason ?? "") ? 1
  : (a.step ?? "") < (b.step ?? "") ? -1
  : (a.step ?? "") > (b.step ?? "") ? 1
  : 0

/** Pure fold: candidates → render buckets. Only runner-declared fields
 * decide (tuple + (scenario, stage) occurrence count). */
export const foldFailures = (candidates: Candidate[]): FailuresView => {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    const lineage = lineageOf(candidate.envelope, candidate.run)
    const partition = JSON.stringify([lineage.scenario, candidate.envelope.stage])
    counts.set(partition, (counts.get(partition) ?? 0) + 1)
  }
  const buckets = new Map<string, FailureTuple>()
  let singletons = 0
  for (const candidate of candidates) {
    const lineage = lineageOf(candidate.envelope, candidate.run)
    const partition = JSON.stringify([lineage.scenario, candidate.envelope.stage])
    if ((counts.get(partition) ?? 0) < 2) {
      singletons += 1
      continue
    }
    const { envelope } = candidate
    const staleReason = envelope.status === "stale" ? (envelope.stale_reason as string) : null
    const step = envelope.step_signature ?? null
    const bucket = JSON.stringify([envelope.stage, envelope.status, staleReason, step])
    const known = buckets.get(bucket)
    if (known) {
      known.count += 1
    } else {
      buckets.set(bucket, { stage: envelope.stage, status: envelope.status, stale_reason: staleReason, step, count: 1 })
    }
  }
  return { groups: [...buckets.values()].sort(compareTuples), singletons }
}

const STATUS_WORD: Record<string, string> = {
  confirmed: "confirmed",
  not_observed: "not-observed",
  stale: "stale",
}

/** Locked summary lines live here (exact strings, English). */
export const NO_FINDINGS = "no findings"
export const singletonLine = (count: number): string => `no-repeat: ${count} unique findings unlisted`

/** Mechanical bucket line (English words, runner-declared values only).
 * A missing step renders as `-` (human output only; `--json` carries
 * null so a literal runner-declared `"-"` step stays distinguishable). */
export const formatFailureGroup = (group: FailureTuple): string => {
  const parts = [STATUS_WORD[group.status] ?? group.status]
  if (group.stale_reason !== null) parts.push(`reason: ${group.stale_reason}`)
  parts.push(`step: ${group.step ?? "-"}`)
  return `finding: ${group.stage} (${parts.join(", ")}) ×${group.count}`
}

/** `ow failures [--since <dur>] [--json]`: every retained run is read
 * (bounded per-file caps, corrupt lines counted and skipped — the file
 * is never touched). Empty → `no findings`; exit 0 except when files
 * exist but nothing is readable (exit 1). */
export const runFailures = async (opts: { rootDir: string; since: string | boolean | undefined; json: boolean }): Promise<number> => {
  const sinceMs = parseFailuresSince(opts.since)
  if (sinceMs === null) {
    console.error(`ow: invalid --since: ${typeof opts.since === "string" ? opts.since : ""} (allowed: 1h|24h|7d)`)
    return 2
  }
  const now = Date.now()
  const dir = join(upPaths(opts.rootDir).stateDir, CHECKPOINTS_DIR_NAME)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
  } catch {
    files = []
  }
  const candidates: Candidate[] = []
  let corrupt = 0
  let overCap = 0
  for (const file of files) {
    const run = file.slice(0, -".jsonl".length)
    if (!isValidRunName(run)) continue
    let read
    try {
      read = await readCheckpointFile(join(dir, file))
    } catch {
      continue
    }
    corrupt += read.skipped.corrupt
    overCap += read.skipped.overCap
    const view = viewOf(run, read)
    for (const envelope of view.envelopes) {
      if (envelope.status === "confirmed") continue
      if (sinceMs !== undefined && Date.parse(envelope.at) < now - sinceMs) continue
      candidates.push({ envelope, run })
    }
  }
  if (corrupt > 0 && !opts.json) console.error(`corrupt-line: ${corrupt} (skipped)`)
  if (overCap > 0 && !opts.json) console.error(`skipped(${overCap}): over cap (file read within 500-line/256KB limit)`)
  const folded = foldFailures(candidates)
  if (opts.json) {
    console.log(JSON.stringify({ groups: folded.groups, singletons: folded.singletons, skipped: { corrupt, overCap } }))
    return candidates.length === 0 && (corrupt > 0 || overCap > 0) && files.length > 0 ? 1 : 0
  }
  if (candidates.length === 0) {
    console.log(NO_FINDINGS)
    // M-g: files present but nothing readable (all corrupt/capped) exits
    // 1 — a genuinely empty dir or all-confirmed evidence stays exit 0.
    return corrupt + overCap > 0 && files.length > 0 ? 1 : 0
  }
  for (const group of folded.groups) console.log(formatFailureGroup(group))
  if (folded.singletons > 0) console.log(singletonLine(folded.singletons))
  return 0
}
