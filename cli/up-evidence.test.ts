/** P2-A evidence zarfı: şema + maske/cap + tazelik matrisi (fixture-first,
 * saf modül — canlı exec yok). */

import { describe, expect, test } from "bun:test"

import {
  applyFreshness,
  capText,
  maskSecrets,
  normalizeEnvelope,
  normalizeProof,
  summarizeFresh,
  type EvidenceEnvelope,
} from "./up-evidence"

const basis = (overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope => ({
  stage: "build",
  status: "confirmed",
  proof: { ok: true },
  at: "2026-10-09T08:00:00.000Z",
  by: "runner",
  code: { runner: "rev1", body: "abc123" },
  runtime: { port: 8080, cwd: "/repo/svc", provenance_rev: "rev1" },
  ...overrides,
})

describe("normalizeEnvelope", () => {
  test("tam + minimal zarf geçer", () => {
    expect(normalizeEnvelope(basis()).ok).toBe(true)
    const minimal = normalizeEnvelope({ stage: "x", status: "not_observed", proof: "yok", at: "2026-10-09T08:00:00.000Z", by: "runner" })
    expect(minimal.ok).toBe(true)
  })

  test("bozuk şekiller reddedilir (fail-closed)", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...basis(), stage: "" },
      { ...basis(), status: "unknown" },
      { ...basis(), at: "dün" },
      { ...basis(), by: "insan" },
      { ...basis(), proof: undefined },
      { ...basis(), proof: 42 },
      { ...basis(), status: "stale" },
      { ...basis(), status: "confirmed", stale_reason: "runtime" },
      { ...basis(), safe_next_action: 7 },
      { ...basis(), code: "abc" },
      { ...basis(), code: { mystery: 1 } },
      { ...basis(), runtime: [8080] },
    ]
    for (const raw of bad) expect(normalizeEnvelope(raw).ok).toBe(false)
  })

  test("bilinen alt-alanlar alınır, legacy eşdeğer yeni slota eşlenir, ek alanlar atılır", () => {
    const raw = { ...basis(), code: { script_hash: "h", extra: "drop" }, runtime: { port: 1 } }
    const normalized = normalizeEnvelope(raw)
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ body: "h" })
      expect(normalized.envelope.runtime).toEqual({ port: 1 })
    }
  })
})

describe("maskSecrets + caps (secret-asla)", () => {
  test("şekilli sırlar maskelenir, yapı korunur", () => {
    expect(maskSecrets("token=hunter2")).toBe("token=***")
    expect(maskSecrets('{"token": "hunter2", "ok": true}')).toBe('{"token": "***", "ok": true}')
    expect(maskSecrets("Authorization: Bearer xyz789")).toBe("Authorization: *** ***")
    expect(maskSecrets("run --password hunter2 ok")).toBe("run --password *** ok")
    expect(maskSecrets("key deadbeefdeadbeefdeadbeefdeadbeef done")).toBe("key *** done")
    expect(maskSecrets("plain text stays")).toBe("plain text stays")
  })

  test("şekilsiz çıplak değer maskelenmez (tasarım; sentinel şekilli yerleşir)", () => {
    expect(maskSecrets("hunter2")).toBe("hunter2")
  })

  test("sentinel hiçbir maskeli çıktıda görünmez", () => {
    const proof = normalizeProof({ token: "hunter2", nested: { api_key: "hunter2" }, list: ["a", "bearer hunter2"] })
    expect(proof.ok).toBe(true)
    if (proof.ok) expect(JSON.stringify(proof.proof)).not.toContain("hunter2")
    const action = normalizeEnvelope({ ...basis(), safe_next_action: "tekrar dene --token hunter2" })
    expect(action.ok).toBe(true)
    if (action.ok) expect(action.envelope.safe_next_action ?? "").not.toContain("hunter2")
  })

  test("cap: proof 8KB + işaret, action 512 + işaret", () => {
    const big = normalizeProof("x".repeat(9000))
    expect(big.ok).toBe(true)
    if (big.ok) {
      expect((big.proof as string).length).toBeLessThanOrEqual(8192)
      expect(big.proof as string).toContain("…[truncated]")
    }
    const capped = capText("y".repeat(600), 512)
    expect(capped.length).toBeLessThanOrEqual(512)
    expect(capped).toContain("…[truncated]")
    expect(capText("kısa", 512)).toBe("kısa")
  })
})

describe("applyFreshness (tazelik matrisi)", () => {
  const fresh = (lines: EvidenceEnvelope[]): EvidenceEnvelope[] => applyFreshness(lines.map((line) => normalizeEnvelope(line).ok ? (normalizeEnvelope(line) as { ok: true; envelope: EvidenceEnvelope }).envelope : line))

  test("aynı baz confirmed kalır", () => {
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z" }])
    expect(out.map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })

  test("kod-harita uyuşmazlığı (her slot) → script_hash; runtime ayrı", () => {
    // M-B: 4 slot sabit sırada (runner → fixture → body → provider_contract)
    // karşılaştırılır; herhangi bir kod-slotu farkı enum-sabit
    // `script_hash` bayatlatır (kod-harita uyuşmazlığı).
    const diverged = (code: Record<string, string>): EvidenceEnvelope => ({
      ...basis(),
      at: "2026-10-09T09:00:00.000Z",
      code: code as EvidenceEnvelope["code"],
    })
    const cases: Record<string, string>[] = [
      { runner: "rev2" },
      { fixture: "f1" },
      { body: "YENI" },
      { provider_contract: "pc1" },
    ]
    for (const code of cases) {
      const out = fresh([basis(), diverged(code)])
      expect(out[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
    }
    const out2 = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { runner: "rev1", body: "abc123" }, runtime: { port: 9090 } }])
    expect(out2[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
    // Kod-harita runtime'tan önce gelir: ikisi birden farklıysa neden script_hash olur.
    const out3 = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { body: "YENI" }, runtime: { port: 9090 } }])
    expect(out3[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
  })

  test("runtime alt-alan değişimleri (port/cwd/provenance_rev)", () => {
    for (const runtime of [{ port: 9090, cwd: "/repo/svc", provenance_rev: "rev1" }, { port: 8080, cwd: "/baska", provenance_rev: "rev1" }, { port: 8080, cwd: "/repo/svc", provenance_rev: "rev2" }]) {
      const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", runtime }])
      expect(out[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
    }
  })

  test("code+runtime İKİSİ yoksa missing_basis KAZANIR", () => {
    const bare = normalizeEnvelope({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T09:00:00.000Z", by: "runner" })
    expect(bare.ok).toBe(true)
    const out = fresh([basis(), (bare as { ok: true; envelope: EvidenceEnvelope }).envelope])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "missing_basis" })
  })

  test("bazın kendisi bassızsa missing_basis olur", () => {
    const bare = (normalizeEnvelope({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T08:00:00.000Z", by: "runner" }) as { ok: true; envelope: EvidenceEnvelope }).envelope
    expect(applyFreshness([bare])[0]).toMatchObject({ status: "stale", stale_reason: "missing_basis" })
  })

  test("tek taraflı runtime kaybı runtime-bayat sayılır", () => {
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", runtime: undefined, code: { runner: "rev1", body: "abc123" } }])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
  })

  test("yazılı stale/not_observed aynen geçer (sentez yok)", () => {
    const out = fresh([
      { ...basis(), status: "stale", stale_reason: "checkout_rev" as const },
      { ...basis(), stage: "deploy", status: "not_observed", at: "2026-10-09T09:00:00.000Z" },
    ])
    expect(out[0]).toMatchObject({ status: "stale", stale_reason: "checkout_rev" })
    expect(out[1].status).toBe("not_observed")
  })

  test("baz stage-bazlıdır (başka stage etkilenmez)", () => {
    const out = fresh([basis(), { ...basis(), stage: "test", code: { body: "BAM" }, at: "2026-10-09T09:00:00.000Z" }])
    expect(out[1].status).toBe("confirmed")
  })
})

describe("summarizeFresh (last_verified/first_gap)", () => {
  test("confirmed→stale→not_observed seçimi", () => {
    const lines = applyFreshness([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { body: "YENI", runner: "rev1" } },
      { ...basis(), stage: "deploy", status: "not_observed", at: "2026-10-09T09:05:00.000Z" },
    ])
    const { summary, last_verified, first_gap } = summarizeFresh(lines)
    expect(summary).toEqual({ confirmed: 1, stale: 1, not_observed: 1 })
    expect(last_verified?.stage).toBe("build")
    expect(last_verified?.at).toBe("2026-10-09T08:00:00.000Z")
    expect(first_gap).toMatchObject({ stage: "build", status: "stale", stale_reason: "script_hash" })
  })

  test("tümü confirmed: first_gap null; confirmed yoksa last null + ilk satır", () => {
    const allOk = summarizeFresh(applyFreshness([basis(), { ...basis(), stage: "test", at: "2026-10-09T09:00:00.000Z" }]))
    expect(allOk.first_gap).toBeNull()
    expect(allOk.last_verified?.stage).toBe("test")
    const noneOk = summarizeFresh(applyFreshness([
      { ...basis(), status: "stale", stale_reason: "runtime" as const },
      { ...basis(), stage: "deploy", status: "not_observed", at: "2026-10-09T09:00:00.000Z" },
    ]))
    expect(noneOk.last_verified).toBeNull()
    expect(noneOk.first_gap?.stage).toBe("build")
  })

  test("boşluk sonrası confirmed: first_gap kapanır", () => {
    const { last_verified, first_gap } = summarizeFresh(applyFreshness([
      { ...basis(), status: "stale", stale_reason: "runtime" as const },
      { ...basis(), stage: "test", at: "2026-10-09T09:00:00.000Z" },
    ]))
    expect(last_verified?.stage).toBe("test")
    expect(first_gap).toBeNull()
  })
})

describe("M-A side_effect/counts/scenario/attempt/step_signature (katkısal)", () => {
  test("geçerli yeni alanlar aynen geçer", () => {
    const raw = {
      ...basis(),
      side_effect: "attempted",
      side_effect_counts: { attempted: 2, confirmed: 1 },
      scenario: "gece-kosusu",
      attempt: 3,
      step_signature: "build-adim-1",
    }
    const normalized = normalizeEnvelope(raw)
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.side_effect).toBe("attempted")
      expect(normalized.envelope.side_effect_counts).toEqual({ attempted: 2, confirmed: 1 })
      expect(normalized.envelope.scenario).toBe("gece-kosusu")
      expect(normalized.envelope.attempt).toBe(3)
      expect(normalized.envelope.step_signature).toBe("build-adim-1")
    }
  })

  test("eksik side_effect/sayım/senaryo/attempt/imza geçer (bilinmiyor-uyumlu)", () => {
    const normalized = normalizeEnvelope(basis())
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.side_effect).toBeUndefined()
      expect(normalized.envelope.side_effect_counts).toBeUndefined()
      expect(normalized.envelope.scenario).toBeUndefined()
      expect(normalized.envelope.attempt).toBeUndefined()
      expect(normalized.envelope.step_signature).toBeUndefined()
    }
  })

  test("bozuk yeni alanlar satırı bozar (fail-closed, asla zorlama)", () => {
    const bad: unknown[] = [
      { ...basis(), side_effect: "maybe" },
      { ...basis(), side_effect: "NONE" },
      { ...basis(), side_effect: 42 },
      { ...basis(), side_effect_counts: { attempted: 1000000 } },
      { ...basis(), side_effect_counts: { confirmed: -1 } },
      { ...basis(), side_effect_counts: { attempted: 1.5 } },
      { ...basis(), side_effect_counts: { attempted: "2" } },
      { ...basis(), side_effect_counts: "cok" },
      { ...basis(), side_effect_counts: [] },
      { ...basis(), scenario: "" },
      { ...basis(), scenario: "../kacis" },
      { ...basis(), scenario: "a/b" },
      { ...basis(), scenario: "x".repeat(65) },
      { ...basis(), scenario: 7 },
      { ...basis(), attempt: 0 },
      { ...basis(), attempt: 1000 },
      { ...basis(), attempt: 1.5 },
      { ...basis(), attempt: "2" },
      { ...basis(), step_signature: "" },
      { ...basis(), step_signature: "x".repeat(129) },
      { ...basis(), step_signature: 7 },
    ]
    for (const raw of bad) expect(normalizeEnvelope(raw).ok).toBe(false)
  })

  test("senaryo/imza maske-önce-cap ile taşınır (gizli-şekil sızmaz)", () => {
    const masked = normalizeEnvelope({ ...basis(), scenario: "gece", step_signature: "token=hunter2" })
    expect(masked.ok).toBe(true)
    if (masked.ok) {
      expect(masked.envelope.scenario).toBe("gece")
      expect(masked.envelope.step_signature).toBe("token=***")
      expect(JSON.stringify(masked.envelope)).not.toContain("hunter2")
    }
  })

  test("tazelik yeni alanları yoksayar (ortogonal)", () => {
    const out = applyFreshness([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", side_effect: "attempted", side_effect_counts: { attempted: 2 }, scenario: "gece", attempt: 2, step_signature: "x" },
    ])
    expect(out.map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })
})

describe("M-B kod haritası (runner/fixture/body/provider_contract + legacy eşdeğer)", () => {
  const rawBasis = {
    stage: "build",
    status: "confirmed",
    proof: { ok: true },
    at: "2026-10-09T08:00:00.000Z",
    by: "runner",
    runtime: { port: 8080, cwd: "/repo/svc", provenance_rev: "rev1" },
  }

  test("dört yeni slot aynen geçer", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { runner: "r1", fixture: "f1", body: "s1", provider_contract: "pc1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ runner: "r1", fixture: "f1", body: "s1", provider_contract: "pc1" })
    }
  })

  test("legacy eşdeğer eşlenir (script_hash→body, checkout_rev→runner)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", checkout_rev: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.envelope.code).toEqual({ runner: "r1", body: "s1" })
  })

  test("aynı slot iki adla gelirse satır bozuktur (fail-closed, sessiz-kazanım yok)", () => {
    for (const code of [
      { script_hash: "s1", body: "s1" },
      { script_hash: "s1", body: "s2" },
      { checkout_rev: "r1", runner: "r1" },
      { checkout_rev: "r1", runner: "r2" },
    ]) {
      expect(normalizeEnvelope({ ...rawBasis, code }).ok).toBe(false)
    }
  })

  test("farklı slotlar karışık adla taşınabilir (çakışma yok)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", runner: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.envelope.code).toEqual({ runner: "r1", body: "s1" })
  })

  test("gizli-şekilli slot fail-safe maskelenir (***)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { body: "token=hunter2-abcdef1234", runner: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ runner: "r1", body: "***" })
      expect(JSON.stringify(normalized.envelope)).not.toContain("hunter2")
    }
  })

  test("disiplinsiz slot satırı bozar (uzun/boş/şekilsiz)", () => {
    const bad: unknown[] = [
      { ...rawBasis, code: { body: "x".repeat(65) } },
      { ...rawBasis, code: { runner: "" } },
      { ...rawBasis, code: { fixture: 42 } },
      { ...rawBasis, code: { provider_contract: "x".repeat(65) } },
      { ...rawBasis, code: { script_hash: "x".repeat(65) } },
      { ...rawBasis, code: { mystery: 1 } },
    ]
    for (const raw of bad) expect(normalizeEnvelope(raw).ok).toBe(false)
  })

  test("legacy-yeni aynı değer: tazelik confirmed-kararlı (eşdeğer-kararlılık)", () => {
    const oldBasis = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", checkout_rev: "r1" } })
    const newSame = normalizeEnvelope({ ...rawBasis, at: "2026-10-09T09:00:00.000Z", code: { runner: "r1", body: "s1" } })
    expect(oldBasis.ok).toBe(true)
    expect(newSame.ok).toBe(true)
    if (!oldBasis.ok || !newSame.ok) return
    expect(applyFreshness([oldBasis.envelope, newSame.envelope]).map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })

  test("tek-taraflı kod kaybı → script_hash (kod-harita uyuşmazlığı)", () => {
    const runtimeOnly = normalizeEnvelope({ ...rawBasis, runtime: { port: 1 } })
    expect(runtimeOnly.ok).toBe(true)
    if (!runtimeOnly.ok) return
    // Tek-taraflı kod kaybı: bazda kod var, satırda yok → kod-harita uyuşmazlığı.
    const out = applyFreshness([basis(), runtimeOnly.envelope])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
  })
})
