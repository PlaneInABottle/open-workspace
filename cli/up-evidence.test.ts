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
  code: { script_hash: "abc123", checkout_rev: "rev1" },
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
      { ...basis(), code: { bilinmeyen: 1 } },
      { ...basis(), runtime: [8080] },
    ]
    for (const raw of bad) expect(normalizeEnvelope(raw).ok).toBe(false)
  })

  test("bilinen alt-alanlar alınır, ek alanlar atılır", () => {
    const raw = { ...basis(), code: { script_hash: "h", extra: "drop" }, runtime: { port: 1 } }
    const normalized = normalizeEnvelope(raw)
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ script_hash: "h" })
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
      expect(big.proof as string).toContain("…[kesildi]")
    }
    const capped = capText("y".repeat(600), 512)
    expect(capped.length).toBeLessThanOrEqual(512)
    expect(capped).toContain("…[kesildi]")
    expect(capText("kısa", 512)).toBe("kısa")
  })
})

describe("applyFreshness (tazelik matrisi)", () => {
  const fresh = (lines: EvidenceEnvelope[]): EvidenceEnvelope[] => applyFreshness(lines.map((line) => normalizeEnvelope(line).ok ? (normalizeEnvelope(line) as { ok: true; envelope: EvidenceEnvelope }).envelope : line))

  test("aynı baz confirmed kalır", () => {
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z" }])
    expect(out.map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })

  test("öncelik script_hash > checkout_rev > runtime", () => {
    const out = fresh([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { script_hash: "YENI", checkout_rev: "rev2" }, runtime: { port: 9090, cwd: "/baska", provenance_rev: "rev2" } },
    ])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
    const out2 = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { script_hash: "abc123", checkout_rev: "rev2" }, runtime: { port: 9090 } }])
    expect(out2[1]).toMatchObject({ status: "stale", stale_reason: "checkout_rev" })
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
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", runtime: undefined, code: { script_hash: "abc123", checkout_rev: "rev1" } }])
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
    const out = fresh([basis(), { ...basis(), stage: "test", code: { script_hash: "BAM" }, at: "2026-10-09T09:00:00.000Z" }])
    expect(out[1].status).toBe("confirmed")
  })
})

describe("summarizeFresh (last_verified/first_gap)", () => {
  test("confirmed→stale→not_observed seçimi", () => {
    const lines = applyFreshness([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { script_hash: "YENI", checkout_rev: "rev1" } },
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
