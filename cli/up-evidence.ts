/** P2-A evidence zarfı: saf şema + maske/cap + tazelik. ow zarfın `proof`
 * içeriğini yorumlamaz (business bilmez) — yalnızca maske/cap uygular ve
 * tazelik kuralını işletir. Runner yazar, ow okur/gösterir. Canlı exec yok. */

import { isSecretFlagToken, maskSecretToken, PROVIDER_PREFIX_PATTERN, SECRET_WORD_PATTERN } from "./up-reconcile"

export type EnvelopeStatus = "confirmed" | "not_observed" | "stale"
export type StaleReason = "script_hash" | "checkout_rev" | "runtime" | "missing_basis"
export type EnvelopeBy = "runner" | "ow-preflight" | "ow-reconcile" | "ow-probe"
/** M-A (#2): yan-etki bayrağı. Eksik alan ≡ `unknown` (render
 * `bilinmiyor`, uyarısız) — telde eksik taşınır, ow tamamlamaz. */
export type EnvelopeSideEffect = "none" | "attempted" | "confirmed" | "unknown"

export type EvidenceEnvelope = {
  stage: string
  status: EnvelopeStatus
  stale_reason?: StaleReason
  safe_next_action?: string
  proof: unknown
  at: string
  by: EnvelopeBy
  code?: { runner?: string; fixture?: string; body?: string; provider_contract?: string }
  runtime?: { port?: number; cwd?: string; provenance_rev?: string }
  side_effect?: EnvelopeSideEffect
  /** Render-only sayaçlar (ow HESAPLAMAZ — runner yazar, ow gösterir). */
  side_effect_counts?: { attempted?: number; confirmed?: number }
  /** M-A (#3): runner-beyanlı soy (koşu-adı sonek ayrıştırması yedektir). */
  scenario?: string
  attempt?: number
  /** M-A (+M-D fails-verb grup anahtarı): opak adım imzası. */
  step_signature?: string
}

/** Cap'ler (üst sınırlar planda sabit; altı implementere bırakıldı — aynen alındı). */
export const PROOF_MAX_CHARS = 8192
export const SAFE_NEXT_ACTION_MAX_CHARS = 512
export const TRUNCATION_MARK = "…[kesildi]"
/** M-A cap'leri: sayaç 0..999999, senaryo 64ch (RUN_NAME_PATTERN şekli),
 * deneme 1..999, adım-imzası 128ch. */
export const SIDE_EFFECT_COUNT_MAX = 999999
export const SCENARIO_MAX_CHARS = 64
export const ATTEMPT_MIN = 1
export const ATTEMPT_MAX = 999
export const STEP_SIGNATURE_MAX_CHARS = 128
/** M-B (#5): kod-slotu cap'i — 4 slotun her biri 1..64ch (`revField` disiplini). */
export const CODE_SLOT_MAX_CHARS = 64

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
const SIDE_EFFECTS: ReadonlySet<string> = new Set(["none", "attempted", "confirmed", "unknown"])
/** Senaryo adı şekli = koşu-adı allowlist'iyle aynı (M-A kilidi). */
const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SIDE_EFFECT_COUNT_MAX

/** M-B (#5): tek kod-slotu okuma (coordinator `revField` aynası — kırp →
 * boş/64-aşkın/şekilsiz geçersiz; secret-şekilli fail-safe `***`).
 * Anahtar yoksa `{present:false}`; varsa disiplin sonucu taşınır. */
const readCodeSlot = (table: Record<string, unknown>, key: string): { present: boolean; value: string | undefined } => {
  if (table[key] === undefined) return { present: false, value: undefined }
  const raw = table[key]
  if (typeof raw !== "string") return { present: true, value: undefined }
  const rev = raw.trim()
  if (rev.length === 0 || rev.length > CODE_SLOT_MAX_CHARS) return { present: true, value: undefined }
  if (SECRET_WORD_PATTERN.test(rev) || PROVIDER_PREFIX_PATTERN.test(rev)) return { present: true, value: "***" }
  return { present: true, value: rev }
}

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
    // M-B (#5): 4 slot + legacy eşdeğer (script_hash→body,
    // checkout_rev→runner). Aynı slot iki adla gelirse satır bozuktur
    // (fail-closed — sessiz-kazanım/new-wins yok); present-ama-disiplinsiz
    // (uzun/boş/şekilsiz) değer de satırı bozar.
    const runner = readCodeSlot(code, "runner")
    const fixture = readCodeSlot(code, "fixture")
    const body = readCodeSlot(code, "body")
    const providerContract = readCodeSlot(code, "provider_contract")
    const legacyHash = readCodeSlot(code, "script_hash")
    const legacyRev = readCodeSlot(code, "checkout_rev")
    if ((legacyHash.present && body.present) || (legacyRev.present && runner.present)) return { ok: false }
    const picked: NonNullable<EvidenceEnvelope["code"]> = {}
    const resolve = (fresh: { present: boolean; value: string | undefined }, legacy: { present: boolean; value: string | undefined }): string | undefined | null => {
      const present = fresh.present || legacy.present
      const value = fresh.present ? fresh.value : legacy.value
      if (present && value === undefined) return null
      return value
    }
    const runnerValue = resolve(runner, legacyRev)
    const fixtureValue = resolve(fixture, { present: false, value: undefined })
    const bodyValue = resolve(body, legacyHash)
    const providerContractValue = resolve(providerContract, { present: false, value: undefined })
    if (runnerValue === null || fixtureValue === null || bodyValue === null || providerContractValue === null) return { ok: false }
    if (runnerValue !== undefined) picked.runner = runnerValue
    if (fixtureValue !== undefined) picked.fixture = fixtureValue
    if (bodyValue !== undefined) picked.body = bodyValue
    if (providerContractValue !== undefined) picked.provider_contract = providerContractValue
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
  // M-A (#2): yan-etki bayrağı — geçersiz enum satırı bozar (asla zorlama).
  if (dict["side_effect"] !== undefined) {
    if (typeof dict["side_effect"] !== "string" || !SIDE_EFFECTS.has(dict["side_effect"] as string)) return { ok: false }
    envelope.side_effect = dict["side_effect"] as EnvelopeSideEffect
  }
  // M-A (#2): sayaçlar render-only'dir (ow hesaplamaz); aralık-dışı /
  // tamsayı-dışı / şekilsiz değer satırı bozar.
  if (dict["side_effect_counts"] !== undefined) {
    if (typeof dict["side_effect_counts"] !== "object" || dict["side_effect_counts"] === null || Array.isArray(dict["side_effect_counts"])) {
      return { ok: false }
    }
    const counts = dict["side_effect_counts"] as Record<string, unknown>
    const picked: NonNullable<EvidenceEnvelope["side_effect_counts"]> = {}
    if (counts["attempted"] !== undefined) {
      if (!isCount(counts["attempted"])) return { ok: false }
      picked.attempted = counts["attempted"] as number
    }
    if (counts["confirmed"] !== undefined) {
      if (!isCount(counts["confirmed"])) return { ok: false }
      picked.confirmed = counts["confirmed"] as number
    }
    if (Object.keys(picked).length > 0) envelope.side_effect_counts = picked
    else if (Object.keys(counts).length > 0) return { ok: false }
  }
  // M-A (#3): soy — senaryo RUN_NAME_PATTERN şekli, deneme 1..999 tamsayı.
  if (dict["scenario"] !== undefined) {
    if (typeof dict["scenario"] !== "string" || !SCENARIO_PATTERN.test(dict["scenario"] as string)) return { ok: false }
    envelope.scenario = maskSecrets(dict["scenario"] as string)
  }
  if (dict["attempt"] !== undefined) {
    if (typeof dict["attempt"] !== "number" || !Number.isInteger(dict["attempt"]) || (dict["attempt"] as number) < ATTEMPT_MIN || (dict["attempt"] as number) > ATTEMPT_MAX) {
      return { ok: false }
    }
    envelope.attempt = dict["attempt"] as number
  }
  // M-A (+M-D): adım imzası 1..128ch opak dize (maske-önce-cap).
  if (dict["step_signature"] !== undefined) {
    if (typeof dict["step_signature"] !== "string" || (dict["step_signature"] as string).length === 0 || (dict["step_signature"] as string).length > STEP_SIGNATURE_MAX_CHARS) {
      return { ok: false }
    }
    envelope.step_signature = capText(maskSecrets(dict["step_signature"] as string), STEP_SIGNATURE_MAX_CHARS)
  }
  return { ok: true, envelope }
}

type BasisSlots = {
  runner: string | undefined
  fixture: string | undefined
  body: string | undefined
  provider_contract: string | undefined
  port: number | undefined
  cwd: string | undefined
  provenance_rev: string | undefined
}

const slotsOf = (envelope: EvidenceEnvelope): BasisSlots => ({
  runner: envelope.code?.runner,
  fixture: envelope.code?.fixture,
  body: envelope.code?.body,
  provider_contract: envelope.code?.provider_contract,
  port: envelope.runtime?.port,
  cwd: envelope.runtime?.cwd,
  provenance_rev: envelope.runtime?.provenance_rev,
})

/** Tazelik: baz = dosyada o stage'in dosya-sırasına göre İLK confirmed
 * zarfı. Yazılı `not_observed`/`stale` (geçerli nedenli) aynen geçer;
 * yazılı `confirmed` baza karşı alan-bazında karşılaştırılır — M-B (#5):
 * 4 kod-slotu sabit sırada (runner → fixture → body → provider_contract);
 * herhangi bir kod-slotu uyuşmazlığı enum-sabit `script_hash` bayatlatır
 * (kod-harita uyuşmazlığı; yeni `stale_reason` yok), sonra runtime;
 * `code`+`runtime` İKİSİ de yoksa `missing_basis` KAZANIR. `not_observed`
 * ow tarafından SENTEZLENMEZ (o stage'e hiç zarf yoksa satır yoktur).
 * M-A notu: `side_effect`/`side_effect_counts`/`scenario`/`attempt`/
 * `step_signature` tazeliğe ORTOGONALDIR (burada yoksayılır). */
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
    if (a.runner !== b.runner || a.fixture !== b.fixture || a.body !== b.body || a.provider_contract !== b.provider_contract) {
      return stale("script_hash")
    }
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
