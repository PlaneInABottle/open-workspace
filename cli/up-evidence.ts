/** P2-A evidence zarfı: saf şema + maske/cap + tazelik. ow zarfın `proof`
 * içeriğini yorumlamaz (business bilmez) — yalnızca maske/cap uygular ve
 * tazelik kuralını işletir. Runner yazar, ow okur/gösterir. Canlı exec yok. */

import { isSecretFlagToken, maskSecretToken, PROVIDER_PREFIX_PATTERN, SECRET_WORD_PATTERN } from "./up-reconcile"

export type EnvelopeStatus = "confirmed" | "not_observed" | "stale"
export type StaleReason = "script_hash" | "checkout_rev" | "runtime" | "missing_basis"
export type EnvelopeBy = "runner" | "ow-preflight" | "ow-reconcile" | "ow-probe"

export type EvidenceEnvelope = {
  stage: string
  status: EnvelopeStatus
  stale_reason?: StaleReason
  safe_next_action?: string
  proof: unknown
  at: string
  by: EnvelopeBy
  code?: { script_hash?: string; checkout_rev?: string }
  runtime?: { port?: number; cwd?: string; provenance_rev?: string }
}

/** Cap'ler (üst sınırlar planda sabit; altı implementere bırakıldı — aynen alındı). */
export const PROOF_MAX_CHARS = 8192
export const SAFE_NEXT_ACTION_MAX_CHARS = 512
export const TRUNCATION_MARK = "…[kesildi]"

/** Serbest metin secret-maskesi (B3 listesi, tek kaynak): önce `Bearer`
 * gövdesi (değer yandaki tokendadır), sonra boşluk-korumalı token
 * yürüyüşü — `ad=değer` (tırnaklı JSON dahil), `ad:` + sonraki değer,
 * bayrak-sonrası değer, yalın secret-kelime, sağlayıcı-öneki, uzun-hex.
 * Tüm regex'ler lineerdir (O(n²) backtracking yok). Şekilsiz `hunter2`
 * gibi çıplak değerler maskelenmez — sentinel testleri şekilli yerleştirir. */
export const maskSecrets = (text: string): string => {
  const afterBearer = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
  const looksSecretKey = (token: string): boolean =>
    SECRET_WORD_PATTERN.test(token.replace(/^["']+|["':=]+$/g, ""))
  /** Değeri maskelerken çevreleyen tırnak/noktalamayı korur (`"hunter2",`
   * → `"***",`; yapı bütünlüğü için). */
  const maskWord = (token: string): string => {
    const match = /^(\W*)(.*?)(\W*)$/.exec(token)
    if (!match || match[2].length === 0) return "***"
    return `${match[1]}***${match[3]}`
  }
  const parts = afterBearer.split(/(\s+)/)
  let prev = ""
  let maskNext = false
  return parts
    .map((part) => {
      if (part.length === 0 || /^\s+$/.test(part)) return part
      let masked: string
      if (maskNext) {
        masked = maskWord(part)
        maskNext = false
      } else if (part.includes("=") && !/^[:=]+$/.test(part)) {
        masked = maskSecretToken(part, isSecretFlagToken(prev))
      } else if (/^[:=]+$/.test(part)) {
        if (looksSecretKey(prev)) maskNext = true
        masked = part
      } else if (/[:=]["']?$/.test(part)) {
        if (looksSecretKey(part)) maskNext = true
        masked = part
      } else if (isSecretFlagToken(part)) {
        masked = part
        maskNext = true
      } else if (
        SECRET_WORD_PATTERN.test(part) ||
        /^[0-9a-fA-F]{32,}$/.test(part) ||
        PROVIDER_PREFIX_PATTERN.test(part)
      ) {
        masked = maskWord(part)
      } else {
        masked = part
      }
      prev = part
      return masked
    })
    .join("")
}

/** Cap + kesme işareti (karakter sayımı; maske ÖNCE uygulanır). */
export const capText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length)) + TRUNCATION_MARK

/** `proof` normalizasyonu: string aynen; object stringify→maske→cap→
 * yapıyı koruyorsa geri-parse, kesildiyse işaretli string. */
export const normalizeProof = (proof: unknown): { ok: true; proof: unknown } | { ok: false } => {
  if (typeof proof === "string") return { ok: true, proof: capText(maskSecrets(proof), PROOF_MAX_CHARS) }
  if (typeof proof === "object" && proof !== null) {
    let json: string
    try {
      json = JSON.stringify(proof) ?? ""
    } catch {
      return { ok: false }
    }
    const masked = capText(maskSecrets(json), PROOF_MAX_CHARS)
    try {
      return { ok: true, proof: JSON.parse(masked) }
    } catch {
      return { ok: true, proof: masked }
    }
  }
  return { ok: false }
}

const STALE_REASONS: ReadonlySet<string> = new Set(["script_hash", "checkout_rev", "runtime", "missing_basis"])
const BY_VALUES: ReadonlySet<string> = new Set(["runner", "ow-preflight", "ow-reconcile", "ow-probe"])

/** Satır normalizasyonu: şekil-sıkı (fail-closed). `stale` geçerli
 * `stale_reason` ZORUNLU taşır; `stale_reason` başka statüde satırı bozar.
 * `code`/`runtime` ek alanları atılır (bilinen alt-alanlar alınır). */
export const normalizeEnvelope = (raw: unknown): { ok: true; envelope: EvidenceEnvelope } | { ok: false } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false }
  const dict = raw as Record<string, unknown>
  if (typeof dict["stage"] !== "string" || (dict["stage"] as string).trim().length === 0) return { ok: false }
  if (dict["status"] !== "confirmed" && dict["status"] !== "not_observed" && dict["status"] !== "stale") return { ok: false }
  if (typeof dict["at"] !== "string" || !Number.isFinite(Date.parse(dict["at"] as string))) return { ok: false }
  if (typeof dict["by"] !== "string" || !BY_VALUES.has(dict["by"] as string)) return { ok: false }
  const status = dict["status"] as EnvelopeStatus
  const reason = dict["stale_reason"]
  if (status === "stale") {
    if (typeof reason !== "string" || !STALE_REASONS.has(reason)) return { ok: false }
  } else if (reason !== undefined) {
    return { ok: false }
  }
  const proof = normalizeProof(dict["proof"])
  if (!proof.ok) return { ok: false }
  const envelope: EvidenceEnvelope = {
    stage: dict["stage"] as string,
    status,
    ...(status === "stale" ? { stale_reason: reason as StaleReason } : {}),
    proof: proof.proof,
    at: dict["at"] as string,
    by: dict["by"] as EnvelopeBy,
  }
  if (typeof dict["safe_next_action"] === "string") {
    envelope.safe_next_action = capText(maskSecrets(dict["safe_next_action"] as string), SAFE_NEXT_ACTION_MAX_CHARS)
  } else if (dict["safe_next_action"] !== undefined) {
    return { ok: false }
  }
  if (dict["code"] !== undefined) {
    if (typeof dict["code"] !== "object" || dict["code"] === null || Array.isArray(dict["code"])) return { ok: false }
    const code = dict["code"] as Record<string, unknown>
    const picked: NonNullable<EvidenceEnvelope["code"]> = {}
    if (typeof code["script_hash"] === "string") picked.script_hash = code["script_hash"]
    if (typeof code["checkout_rev"] === "string") picked.checkout_rev = code["checkout_rev"]
    if (Object.keys(picked).length > 0) envelope.code = picked
    else if (Object.keys(code).length > 0) return { ok: false }
  }
  if (dict["runtime"] !== undefined) {
    if (typeof dict["runtime"] !== "object" || dict["runtime"] === null || Array.isArray(dict["runtime"])) return { ok: false }
    const runtime = dict["runtime"] as Record<string, unknown>
    const picked: NonNullable<EvidenceEnvelope["runtime"]> = {}
    if (typeof runtime["port"] === "number") picked.port = runtime["port"]
    if (typeof runtime["cwd"] === "string") picked.cwd = runtime["cwd"]
    if (typeof runtime["provenance_rev"] === "string") picked.provenance_rev = runtime["provenance_rev"]
    if (Object.keys(picked).length > 0) envelope.runtime = picked
    else if (Object.keys(runtime).length > 0) return { ok: false }
  }
  return { ok: true, envelope }
}

type BasisSlots = {
  script_hash: string | undefined
  checkout_rev: string | undefined
  port: number | undefined
  cwd: string | undefined
  provenance_rev: string | undefined
}

const slotsOf = (envelope: EvidenceEnvelope): BasisSlots => ({
  script_hash: envelope.code?.script_hash,
  checkout_rev: envelope.code?.checkout_rev,
  port: envelope.runtime?.port,
  cwd: envelope.runtime?.cwd,
  provenance_rev: envelope.runtime?.provenance_rev,
})

/** Tazelik: baz = dosyada o stage'in dosya-sırasına göre İLK confirmed
 * zarfı. Yazılı `not_observed`/`stale` (geçerli nedenli) aynen geçer;
 * yazılı `confirmed` baza karşı alan-bazında (script_hash →
 * checkout_rev → runtime) karşılaştırılır; `code`+`runtime` İKİSİ de
 * yoksa `missing_basis` KAZANIR. `not_observed` ow tarafından
 * SENTEZLENMEZ (o stage'e hiç zarf yoksa satır yoktur). */
export const applyFreshness = (envelopes: EvidenceEnvelope[]): EvidenceEnvelope[] => {
  const basisByStage = new Map<string, EvidenceEnvelope>()
  for (const envelope of envelopes) {
    if (envelope.status === "confirmed" && !basisByStage.has(envelope.stage)) basisByStage.set(envelope.stage, envelope)
  }
  return envelopes.map((envelope) => {
    if (envelope.status !== "confirmed") return { ...envelope }
    if (envelope.code === undefined && envelope.runtime === undefined) {
      return { ...envelope, status: "stale" as const, stale_reason: "missing_basis" as const }
    }
    const basis = basisByStage.get(envelope.stage) as EvidenceEnvelope
    const a = slotsOf(basis)
    const b = slotsOf(envelope)
    const stale = (reason: StaleReason): EvidenceEnvelope => ({ ...envelope, status: "stale", stale_reason: reason })
    if (a.script_hash !== b.script_hash) return stale("script_hash")
    if (a.checkout_rev !== b.checkout_rev) return stale("checkout_rev")
    if (a.port !== b.port || a.cwd !== b.cwd || a.provenance_rev !== b.provenance_rev) return stale("runtime")
    const { stale_reason: _dropped, ...rest } = envelope
    void _dropped
    return { ...rest, status: "confirmed" }
  })
}

export type FreshSummary = { confirmed: number; stale: number; not_observed: number }

/** Özet + `last_verified` (dosya-sırasında SON confirmed) + `first_gap`
 * (ondan sonraki İLK non-confirmed; confirmed yoksa ilk satır). */
export const summarizeFresh = (
  envelopes: EvidenceEnvelope[],
): { summary: FreshSummary; last_verified: EvidenceEnvelope | null; first_gap: EvidenceEnvelope | null } => {
  const summary: FreshSummary = { confirmed: 0, stale: 0, not_observed: 0 }
  for (const envelope of envelopes) summary[envelope.status] += 1
  let lastIndex = -1
  for (let i = 0; i < envelopes.length; i += 1) {
    if (envelopes[i].status === "confirmed") lastIndex = i
  }
  const last_verified = lastIndex >= 0 ? envelopes[lastIndex] : null
  const first_gap = envelopes.find((envelope, index) => index > lastIndex && envelope.status !== "confirmed") ?? null
  return { summary, last_verified, first_gap }
}
