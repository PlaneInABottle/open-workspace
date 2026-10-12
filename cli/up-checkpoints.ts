/** P2-A checkpoint konvensiyonu + salt-okunur render. Runner YAZAR
 * (`<root>/.ow/checkpoints/<run>.jsonl`, atomic tmp+rename, ≤256KB/≤500
 * satır — aşımda runner en-eskiden budar), ow YALNIZCA OKUR (budamaz,
 * yazmaz). Canlı exec YOK (probe/health/git/lsof çalıştırılmaz). */

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { applyFreshness, normalizeEnvelope, summarizeFresh, type EvidenceEnvelope, type FreshSummary } from "./up-evidence"
import { upPaths } from "./up-state"

export const CHECKPOINTS_DIR_NAME = "checkpoints"
export const CHECKPOINT_MAX_LINES = 500
export const CHECKPOINT_MAX_BYTES = 256 * 1024

/** Run adı allowlist (path-traversal yok: `/` ve `..` reddedilir). */
export const isValidRunName = (run: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(run)

export const checkpointFile = (rootDir: string, run: string): string =>
  join(upPaths(rootDir).stateDir, CHECKPOINTS_DIR_NAME, `${run}.jsonl`)

export type CheckpointRead = {
  envelopes: EvidenceEnvelope[]
  totalLines: number
  skipped: { corrupt: number; overCap: number }
}

/** Satır-satır jsonl okuma: boş satırlar sessiz geçilir; bozuk satırlar +
 * cap-aşımı (500 satır / 256KB, hangisi önce dolarsa) `skipped` ile
 * sayılır, dosya ASLA değiştirilmez. */
export const readCheckpointFile = async (file: string): Promise<CheckpointRead> => {
  const text = await readFile(file, "utf8")
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
  // Cap-aşımı = cap penceresi dışında kalan DOLU satırlar (boş satırlar
  // sayılmaz; bozuk satırlar ayrı sayılır).
  const nonBlankTotal = lines.filter((line) => line.trim().length > 0).length
  return { envelopes, totalLines, skipped: { corrupt, overCap: Math.max(0, nonBlankTotal - processed) } }
}

const STALE_TR: Record<string, string> = {
  script_hash: "script_hash",
  checkout_rev: "checkout_rev",
  runtime: "runtime",
  missing_basis: "missing_basis",
}

/** M-A (#2): yan-etki Türkçe sözcüğü. Eksik (`undefined`) ≡ `unknown`
 * → `bilinmiyor` (uyarısız). Ham İngilizce enum asla render edilmez. */
const SIDE_EFFECT_TR: Record<string, string> = {
  none: "none",
  attempted: "attempted",
  confirmed: "confirmed",
  unknown: "unknown",
}

const sideEffectWord = (envelope: EvidenceEnvelope): string =>
  SIDE_EFFECT_TR[envelope.side_effect ?? "unknown"] ?? "unknown"

/** Zarf bayrak satırı (Türkçe, yorum yok; sayımlar render-only passthrough). */
export const formatSideEffectLine = (envelope: EvidenceEnvelope): string => {
  const parts = [`side-effect: ${envelope.stage} (${sideEffectWord(envelope)}`]
  const counts: string[] = []
  if (envelope.side_effect_counts?.attempted !== undefined) counts.push(`attempted: ${envelope.side_effect_counts.attempted}`)
  if (envelope.side_effect_counts?.confirmed !== undefined) counts.push(`confirmed: ${envelope.side_effect_counts.confirmed}`)
  return counts.length > 0 ? `${parts[0]}, ${counts.join(", ")})` : `${parts[0]})`
}

/** M-A (#2): reconcile-öncesi-retry ipucu (kilitli metin; düğme/otomatik
 * eylem yok — salt-okunur öneri). */
export const RETRY_HINT = "before-retry: ow reconcile --check"

/** Aynı stage'de `attempted` sonrası `confirmed` yoksa doğrulanmamış
 * sayılır (dosya sırası = zaman sırası). */
export const isAttemptedUnconfirmed = (envelopes: EvidenceEnvelope[], index: number): boolean => {
  const envelope = envelopes[index]
  if (envelope.side_effect !== "attempted") return false
  for (let i = index + 1; i < envelopes.length; i += 1) {
    if (envelopes[i].stage === envelope.stage && envelopes[i].side_effect === "confirmed") return false
  }
  return true
}

/** Herhangi bir zarf doğrulanmamış-deneme taşıyorsa ipucu gerekir (tek satır). */
export const needsRetryHint = (envelopes: EvidenceEnvelope[]): boolean =>
  envelopes.some((_, index) => isAttemptedUnconfirmed(envelopes, index))

/** M-A (#3): koşu-adı sonek ayrıştırması (`<senaryo>-attempt<N>` /
 * `<senaryo>-deneme<N>`, N 1..999). Açık alanlar her zaman kazanır;
 * ayrıştırma yalnızca yedektir. */
export const parseAttemptSuffix = (run: string): { scenario: string; attempt: number } | null => {
  const match = /^(.*)-(?:attempt|deneme)(\d{1,3})$/.exec(run)
  if (!match) return null
  const scenario = match[1]
  const attempt = Number.parseInt(match[2], 10)
  if (scenario.length === 0 || !Number.isInteger(attempt) || attempt < 1 || attempt > 999) return null
  return { scenario, attempt }
}

export type LineageOf = { scenario: string | null; attempt: number | null }

/** Soy-çözümü (alan-bazında açık-kazanır): açık `scenario`/`attempt`
 * varsa o; yoksa koşu-adı soneği; ikisi de yoksa sahipsiz (düz, grupsuz). */
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

/** M-A (#3): `senaryo → deneme → stage` ağacı. Sahipsiz satırlar ağaca
 * girmez (düz listede kalır — gruplama yok). Kilitli sözcükler: `senaryo`,
 * `deneme`, `doğrulanmadı` (yalnızca doğrulanmamış-deneme yaprağında). */
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

/** Zarf insan satırı (Türkçe, yorum yok). */
export const formatEnvelopeLine = (envelope: EvidenceEnvelope): string => {
  if (envelope.status === "confirmed") return `confirmed: ${envelope.stage} (${envelope.at})`
  if (envelope.status === "not_observed") return `not-observed: ${envelope.stage}`
  return `stale: ${envelope.stage} (reason: ${STALE_TR[envelope.stale_reason as string] ?? envelope.stale_reason})`
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

/** `ow checkpoints list [--json]`: run adı + zarf sayısı + özet + son `at`.
 * Salt-okunur, dizin yoksa boş liste; exit her zaman 0. */
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

/** `ow checkpoints show <run> [--json]`: dosya yoksa exit 1, geçersiz
 * run adı exit 2, bozuk satırlar atlanır (fail değil). */
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
    return 0
  }
  if (view.envelopes.length === 0) {
    console.log(`checkpoint empty: ${opts.run}`)
    return 0
  }
  for (const envelope of view.envelopes) console.log(formatEnvelopeLine(envelope))
  for (const envelope of view.envelopes) console.log(formatSideEffectLine(envelope))
  console.log(view.last_verified ? `last confirmed: ${view.last_verified.stage} (${view.last_verified.at})` : "last confirmed: none")
  if (view.first_gap) {
    const why =
      view.first_gap.status === "not_observed" ? "not-observed" : `stale: ${STALE_TR[view.first_gap.stale_reason as string] ?? view.first_gap.stale_reason}`
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
