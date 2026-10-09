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

/** Zarf insan satırı (Türkçe, yorum yok). */
export const formatEnvelopeLine = (envelope: EvidenceEnvelope): string => {
  if (envelope.status === "confirmed") return `doğrulandı: ${envelope.stage} (${envelope.at})`
  if (envelope.status === "not_observed") return `gözlenmedi: ${envelope.stage}`
  return `bayat: ${envelope.stage} (neden: ${STALE_TR[envelope.stale_reason as string] ?? envelope.stale_reason})`
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
  if (skipped.corrupt > 0 && !json) console.error(`bozuk-satır: ${skipped.corrupt} (atlandı)`)
  if (skipped.overCap > 0 && !json) console.error(`atlandı(${skipped.overCap}): cap aşıldı (dosya 500 satır/256KB sınırında okundu)`)
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
    console.log("checkpoint yok")
  } else {
    for (const entry of runs) {
      console.log(
        `${entry.run} (${entry.count} zarf: ${entry.summary.confirmed} doğrulandı, ${entry.summary.stale} bayat, ${entry.summary.not_observed} gözlenmedi; son: ${entry.lastAt ?? "yok"})`,
      )
    }
  }
  return 0
}

/** `ow checkpoints show <run> [--json]`: dosya yoksa exit 1, geçersiz
 * run adı exit 2, bozuk satırlar atlanır (fail değil). */
export const runCheckpointsShow = async (opts: { rootDir: string; run: string; json: boolean }): Promise<number> => {
  if (!isValidRunName(opts.run)) {
    console.error(`ow: geçersiz run adı: ${opts.run} (izin: [A-Za-z0-9_.-], en fazla 64 karakter)`)
    return 2
  }
  const file = checkpointFile(opts.rootDir, opts.run)
  let read: CheckpointRead
  try {
    await stat(file)
    read = await readCheckpointFile(file)
  } catch {
    console.error(`ow: checkpoint yok: ${opts.run}`)
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
    console.log(`checkpoint boş: ${opts.run}`)
    return 0
  }
  for (const envelope of view.envelopes) console.log(formatEnvelopeLine(envelope))
  console.log(view.last_verified ? `son doğrulanmış: ${view.last_verified.stage} (${view.last_verified.at})` : "son doğrulanmış: yok")
  if (view.first_gap) {
    const why =
      view.first_gap.status === "not_observed" ? "gözlenmedi" : `bayat: ${STALE_TR[view.first_gap.stale_reason as string] ?? view.first_gap.stale_reason}`
    console.log(`ilk eksik: ${view.first_gap.stage} (${why})`)
  } else {
    console.log("ilk eksik: yok")
  }
  const actionSource = view.first_gap ?? view.envelopes[view.envelopes.length - 1]
  if (actionSource.safe_next_action !== undefined) console.log(`sonraki: ${singleLine(actionSource.safe_next_action)}`)
  return 0
}
