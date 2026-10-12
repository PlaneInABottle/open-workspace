/** P2-A evidence envelope: pure schema + mask/cap + freshness. ow does not
 * interpret the envelope's `proof` content (it has no business knowledge) —
 * it only applies mask/cap and enforces the freshness rule. The runner writes,
 * ow reads/shows. No live exec. */

import { isSecretFlagToken, maskSecretToken, PROVIDER_PREFIX_PATTERN, SECRET_WORD_PATTERN } from "./up-reconcile"

export type EnvelopeStatus = "confirmed" | "not_observed" | "stale"
export type StaleReason = "script_hash" | "checkout_rev" | "runtime" | "missing_basis"
export type EnvelopeBy = "runner" | "ow-preflight" | "ow-reconcile" | "ow-probe"
/** M-A (#2): side-effect flag. A missing field ≡ `unknown` (rendered as
 * `unknown`, without warning) — it travels missing on the wire, ow does not complete it. */
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
  /** Render-only counters (ow does NOT compute — the runner writes, ow shows). */
  side_effect_counts?: { attempted?: number; confirmed?: number }
  /** M-A (#3): runner-declared lineage (run-name suffix parsing is the fallback). */
  scenario?: string
  attempt?: number
  /** M-A (+M-D fails-verb group key): opaque step signature. */
  step_signature?: string
  /** M7 data-clock witness: opaque runner-declared object (conventional
   * keys `revField`, `freshness-ignores`; `ow` never interprets values). */
  data?: Record<string, unknown>
}

/** M7 envelope data cap (telemetry bound; over-capacity drops the field). */
export const DATA_EVIDENCE_MAX_BYTES = 4 * 1024

/** Caps (upper bounds fixed in the plan; the lower bound was left to the implementer — taken as-is). */
export const PROOF_MAX_CHARS = 8192
export const SAFE_NEXT_ACTION_MAX_CHARS = 512
export const TRUNCATION_MARK = "…[truncated]"
/** M-A caps: counter 0..999999, scenario 64ch (RUN_NAME_PATTERN shape),
 * attempt 1..999, step signature 128ch. */
export const SIDE_EFFECT_COUNT_MAX = 999999
export const SCENARIO_MAX_CHARS = 64
export const ATTEMPT_MIN = 1
export const ATTEMPT_MAX = 999
export const STEP_SIGNATURE_MAX_CHARS = 128
/** M-B (#5): code-slot cap — each of the 4 slots 1..64ch (`revField` discipline). */
export const CODE_SLOT_MAX_CHARS = 64

/** Free-text secret mask (B3 list, single source): first the `Bearer`
 * body (the value is the adjacent token), then a whitespace-preserving
 * token walk — `name=value` (including quoted JSON), `name:` + the next
 * value, a post-flag value, a bare secret word, a provider prefix, long hex.
 * All regexes are linear (no O(n²) backtracking). Shapeless bare values
 * like `hunter2` are not masked — sentinel tests place them in a shape. */
export const maskSecrets = (text: string): string => {
  const afterBearer = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
  const looksSecretKey = (token: string): boolean =>
    SECRET_WORD_PATTERN.test(token.replace(/^["']+|["':=]+$/g, ""))
  /** While masking a value, keeps the surrounding quote/punctuation (`"hunter2",`
   * → `"***",`; for structural integrity). */
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

/** Cap + truncation mark (character count; the mask is applied FIRST). */
export const capText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length)) + TRUNCATION_MARK

/** `proof` normalization: a string as-is; an object stringify→mask→cap→
 * re-parse if it preserves structure, otherwise the marked string. */
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
/** Scenario name shape = same as the run-name allowlist (M-A lock). */
const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SIDE_EFFECT_COUNT_MAX

/** M-B (#5): single code-slot read (coordinator `revField` mirror — trim →
 * empty/over-64/shapeless is invalid; secret-shaped fails safe to `***`).
 * With no key `{present:false}`; otherwise the discipline result is carried. */
const readCodeSlot = (table: Record<string, unknown>, key: string): { present: boolean; value: string | undefined } => {
  if (table[key] === undefined) return { present: false, value: undefined }
  const raw = table[key]
  if (typeof raw !== "string") return { present: true, value: undefined }
  const rev = raw.trim()
  if (rev.length === 0 || rev.length > CODE_SLOT_MAX_CHARS) return { present: true, value: undefined }
  if (SECRET_WORD_PATTERN.test(rev) || PROVIDER_PREFIX_PATTERN.test(rev)) return { present: true, value: "***" }
  return { present: true, value: rev }
}

/** Line normalization: shape-strict (fail-closed). `stale` MUST carry a valid
 * `stale_reason`; a `stale_reason` on any other status breaks the line.
 * Extra `code`/`runtime` fields are dropped (known sub-fields are taken). */
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
    // M-B (#5): 4 slots + legacy equivalents (script_hash→body,
    // checkout_rev→runner). If the same slot arrives under both names the line
    // is corrupt (fail-closed — no silent win/new-wins); a present-but-
    // undisciplined (long/empty/shapeless) value also breaks the line.
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
  // M-A (#2): side-effect flag — an invalid enum breaks the line (never coerced).
  if (dict["side_effect"] !== undefined) {
    if (typeof dict["side_effect"] !== "string" || !SIDE_EFFECTS.has(dict["side_effect"] as string)) return { ok: false }
    envelope.side_effect = dict["side_effect"] as EnvelopeSideEffect
  }
  // M-A (#2): the counters are render-only (ow does not compute them); an
  // out-of-range / non-integer / shapeless value breaks the line.
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
  // M7 data-clock witness: opaque `data` object (runner-declared; `ow`
  // never interprets it). Non-object or over-capacity content drops the
  // field while the envelope lives (telemetry-tolerant, M-C precedent).
  if (dict["data"] !== undefined) {
    const raw = dict["data"] as unknown
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      let size = 0
      try {
        size = Buffer.byteLength(JSON.stringify(raw), "utf8")
      } catch {
        size = DATA_EVIDENCE_MAX_BYTES + 1
      }
      if (size <= DATA_EVIDENCE_MAX_BYTES) envelope.data = raw as Record<string, unknown>
    }
  }
  // M-A (#3): lineage — scenario RUN_NAME_PATTERN shape, attempt 1..999 integer.
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
  // M-A (+M-D): step signature 1..128ch opaque string (mask-before-cap).
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

/** Freshness: the basis = the FIRST confirmed envelope of that stage in file
 * order. A written `not_observed`/`stale` (with a valid reason) passes as-is;
 * a written `confirmed` is compared field-by-field against the basis —
 * M-B (#5): the 4 code slots in fixed order (runner → fixture → body →
 * provider_contract); any code-slot mismatch stales it to the enum-constant
 * `script_hash` (code-map mismatch; no new `stale_reason`), then runtime;
 * when BOTH `code`+`runtime` are absent, `missing_basis` WINS. `not_observed`
 * is NOT synthesized by ow (if there is no envelope for that stage, there is no line).
 * M-A note: `side_effect`/`side_effect_counts`/`scenario`/`attempt`/
 * `step_signature` are ORTHOGONAL to freshness (ignored here). */
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

/** Recency window (M-e/G3): newest envelope per stage by `at` (unparsable
 * `at` sorts oldest; ties keep first-seen). Gates consume only the
 * newest per stage — older runs are display-only (checkpoints show/list
 * read full files directly, unaffected). */
export const newestEnvelopePerStage = (envelopes: EvidenceEnvelope[]): EvidenceEnvelope[] => {
  const best = new Map<string, { envelope: EvidenceEnvelope; at: number }>()
  for (const envelope of envelopes) {
    const at = Date.parse(envelope.at)
    const ms = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
    const current = best.get(envelope.stage)
    if (current === undefined || ms > current.at) best.set(envelope.stage, { envelope, at: ms })
  }
  return [...best.values()].map((entry) => entry.envelope)
}

/** Summary + `last_verified` (the LAST confirmed in file order) + `first_gap`
 * (the FIRST non-confirmed after it; the first line if there is no confirmed). */
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
