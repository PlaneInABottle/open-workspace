/** P2-A evidence envelope: schema + mask/cap + freshness matrix (fixture-first,
 * pure module — no live exec). */

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
  test("full + minimal envelope pass", () => {
    expect(normalizeEnvelope(basis()).ok).toBe(true)
    const minimal = normalizeEnvelope({ stage: "x", status: "not_observed", proof: "none", at: "2026-10-09T08:00:00.000Z", by: "runner" })
    expect(minimal.ok).toBe(true)
  })

  test("malformed shapes are rejected (fail-closed)", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...basis(), stage: "" },
      { ...basis(), status: "unknown" },
      { ...basis(), at: "yesterday" },
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

  test("known sub-fields are taken, a legacy equivalent maps to the new slot, extra fields drop", () => {
    const raw = { ...basis(), code: { script_hash: "h", extra: "drop" }, runtime: { port: 1 } }
    const normalized = normalizeEnvelope(raw)
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ body: "h" })
      expect(normalized.envelope.runtime).toEqual({ port: 1 })
    }
  })
})

describe("maskSecrets + caps (secret-never)", () => {
  test("shaped secrets are masked, structure is preserved", () => {
    expect(maskSecrets("token=hunter2")).toBe("token=***")
    expect(maskSecrets('{"token": "hunter2", "ok": true}')).toBe('{"token": "***", "ok": true}')
    expect(maskSecrets("Authorization: Bearer xyz789")).toBe("Authorization: *** ***")
    expect(maskSecrets("run --password hunter2 ok")).toBe("run --password *** ok")
    expect(maskSecrets("key deadbeefdeadbeefdeadbeefdeadbeef done")).toBe("key *** done")
    expect(maskSecrets("plain text stays")).toBe("plain text stays")
  })

  test("a shapeless bare value is not masked (by design; the sentinel is placed in a shape)", () => {
    expect(maskSecrets("hunter2")).toBe("hunter2")
  })

  test("the sentinel never appears in masked output", () => {
    const proof = normalizeProof({ token: "hunter2", nested: { api_key: "hunter2" }, list: ["a", "bearer hunter2"] })
    expect(proof.ok).toBe(true)
    if (proof.ok) expect(JSON.stringify(proof.proof)).not.toContain("hunter2")
    const action = normalizeEnvelope({ ...basis(), safe_next_action: "retry --token hunter2" })
    expect(action.ok).toBe(true)
    if (action.ok) expect(action.envelope.safe_next_action ?? "").not.toContain("hunter2")
  })

  test("cap: proof 8KB + mark, action 512 + mark", () => {
    const big = normalizeProof("x".repeat(9000))
    expect(big.ok).toBe(true)
    if (big.ok) {
      expect((big.proof as string).length).toBeLessThanOrEqual(8192)
      expect(big.proof as string).toContain("…[truncated]")
    }
    const capped = capText("y".repeat(600), 512)
    expect(capped.length).toBeLessThanOrEqual(512)
    expect(capped).toContain("…[truncated]")
    expect(capText("short", 512)).toBe("short")
  })
})

describe("applyFreshness (freshness matrix)", () => {
  const fresh = (lines: EvidenceEnvelope[]): EvidenceEnvelope[] => applyFreshness(lines.map((line) => normalizeEnvelope(line).ok ? (normalizeEnvelope(line) as { ok: true; envelope: EvidenceEnvelope }).envelope : line))

  test("the same basis stays confirmed", () => {
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z" }])
    expect(out.map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })

  test("code-map mismatch (every slot) → script_hash; runtime separate", () => {
    // M-B: the 4 slots are compared in fixed order (runner → fixture → body
    // → provider_contract); any code-slot difference stales it to the
    // enum-constant `script_hash` (code-map mismatch).
    const diverged = (code: Record<string, string>): EvidenceEnvelope => ({
      ...basis(),
      at: "2026-10-09T09:00:00.000Z",
      code: code as EvidenceEnvelope["code"],
    })
    const cases: Record<string, string>[] = [
      { runner: "rev2" },
      { fixture: "f1" },
      { body: "NEW" },
      { provider_contract: "pc1" },
    ]
    for (const code of cases) {
      const out = fresh([basis(), diverged(code)])
      expect(out[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
    }
    const out2 = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { runner: "rev1", body: "abc123" }, runtime: { port: 9090 } }])
    expect(out2[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
    // The code map comes before runtime: if both differ the reason is script_hash.
    const out3 = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { body: "NEW" }, runtime: { port: 9090 } }])
    expect(out3[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
  })

  test("runtime sub-field changes (port/cwd/provenance_rev)", () => {
    for (const runtime of [{ port: 9090, cwd: "/repo/svc", provenance_rev: "rev1" }, { port: 8080, cwd: "/baska", provenance_rev: "rev1" }, { port: 8080, cwd: "/repo/svc", provenance_rev: "rev2" }]) {
      const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", runtime }])
      expect(out[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
    }
  })

  test("when BOTH code+runtime are absent missing_basis WINS", () => {
    const bare = normalizeEnvelope({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T09:00:00.000Z", by: "runner" })
    expect(bare.ok).toBe(true)
    const out = fresh([basis(), (bare as { ok: true; envelope: EvidenceEnvelope }).envelope])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "missing_basis" })
  })

  test("when the basis itself has no basis it becomes missing_basis", () => {
    const bare = (normalizeEnvelope({ stage: "build", status: "confirmed", proof: "x", at: "2026-10-09T08:00:00.000Z", by: "runner" }) as { ok: true; envelope: EvidenceEnvelope }).envelope
    expect(applyFreshness([bare])[0]).toMatchObject({ status: "stale", stale_reason: "missing_basis" })
  })

  test("a one-sided runtime loss counts as runtime-stale", () => {
    const out = fresh([basis(), { ...basis(), at: "2026-10-09T09:00:00.000Z", runtime: undefined, code: { runner: "rev1", body: "abc123" } }])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "runtime" })
  })

  test("a written stale/not_observed passes as-is (no synthesis)", () => {
    const out = fresh([
      { ...basis(), status: "stale", stale_reason: "checkout_rev" as const },
      { ...basis(), stage: "deploy", status: "not_observed", at: "2026-10-09T09:00:00.000Z" },
    ])
    expect(out[0]).toMatchObject({ status: "stale", stale_reason: "checkout_rev" })
    expect(out[1].status).toBe("not_observed")
  })

  test("the basis is per-stage (another stage is unaffected)", () => {
    const out = fresh([basis(), { ...basis(), stage: "test", code: { body: "BAM" }, at: "2026-10-09T09:00:00.000Z" }])
    expect(out[1].status).toBe("confirmed")
  })
})

describe("summarizeFresh (last_verified/first_gap)", () => {
  test("confirmed→stale→not_observed selection", () => {
    const lines = applyFreshness([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", code: { body: "NEW", runner: "rev1" } },
      { ...basis(), stage: "deploy", status: "not_observed", at: "2026-10-09T09:05:00.000Z" },
    ])
    const { summary, last_verified, first_gap } = summarizeFresh(lines)
    expect(summary).toEqual({ confirmed: 1, stale: 1, not_observed: 1 })
    expect(last_verified?.stage).toBe("build")
    expect(last_verified?.at).toBe("2026-10-09T08:00:00.000Z")
    expect(first_gap).toMatchObject({ stage: "build", status: "stale", stale_reason: "script_hash" })
  })

  test("all confirmed: first_gap null; with no confirmed last null + first line", () => {
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

  test("confirmed after a gap: first_gap closes", () => {
    const { last_verified, first_gap } = summarizeFresh(applyFreshness([
      { ...basis(), status: "stale", stale_reason: "runtime" as const },
      { ...basis(), stage: "test", at: "2026-10-09T09:00:00.000Z" },
    ]))
    expect(last_verified?.stage).toBe("test")
    expect(first_gap).toBeNull()
  })
})

describe("M-A side_effect/counts/scenario/attempt/step_signature (additive)", () => {
  test("valid new fields pass as-is", () => {
    const raw = {
      ...basis(),
      side_effect: "attempted",
      side_effect_counts: { attempted: 2, confirmed: 1 },
      scenario: "night-run",
      attempt: 3,
      step_signature: "build-step-1",
    }
    const normalized = normalizeEnvelope(raw)
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.side_effect).toBe("attempted")
      expect(normalized.envelope.side_effect_counts).toEqual({ attempted: 2, confirmed: 1 })
      expect(normalized.envelope.scenario).toBe("night-run")
      expect(normalized.envelope.attempt).toBe(3)
      expect(normalized.envelope.step_signature).toBe("build-step-1")
    }
  })

  test("missing side_effect/count/scenario/attempt/signature pass (unknown-tolerant)", () => {
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

  test("malformed new fields break the line (fail-closed, never coerced)", () => {
    const bad: unknown[] = [
      { ...basis(), side_effect: "maybe" },
      { ...basis(), side_effect: "NONE" },
      { ...basis(), side_effect: 42 },
      { ...basis(), side_effect_counts: { attempted: 1000000 } },
      { ...basis(), side_effect_counts: { confirmed: -1 } },
      { ...basis(), side_effect_counts: { attempted: 1.5 } },
      { ...basis(), side_effect_counts: { attempted: "2" } },
      { ...basis(), side_effect_counts: "many" },
      { ...basis(), side_effect_counts: [] },
      { ...basis(), scenario: "" },
      { ...basis(), scenario: "../escape" },
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

  test("scenario/signature are carried mask-before-cap (no secret shape leaks)", () => {
    const masked = normalizeEnvelope({ ...basis(), scenario: "night", step_signature: "token=hunter2" })
    expect(masked.ok).toBe(true)
    if (masked.ok) {
      expect(masked.envelope.scenario).toBe("night")
      expect(masked.envelope.step_signature).toBe("token=***")
      expect(JSON.stringify(masked.envelope)).not.toContain("hunter2")
    }
  })

  test("freshness ignores the new fields (orthogonal)", () => {
    const out = applyFreshness([
      basis(),
      { ...basis(), at: "2026-10-09T09:00:00.000Z", side_effect: "attempted", side_effect_counts: { attempted: 2 }, scenario: "night", attempt: 2, step_signature: "x" },
    ])
    expect(out.map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })
})

describe("M-B code map (runner/fixture/body/provider_contract + legacy equivalent)", () => {
  const rawBasis = {
    stage: "build",
    status: "confirmed",
    proof: { ok: true },
    at: "2026-10-09T08:00:00.000Z",
    by: "runner",
    runtime: { port: 8080, cwd: "/repo/svc", provenance_rev: "rev1" },
  }

  test("the four new slots pass as-is", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { runner: "r1", fixture: "f1", body: "s1", provider_contract: "pc1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ runner: "r1", fixture: "f1", body: "s1", provider_contract: "pc1" })
    }
  })

  test("a legacy equivalent maps (script_hash→body, checkout_rev→runner)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", checkout_rev: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.envelope.code).toEqual({ runner: "r1", body: "s1" })
  })

  test("if the same slot arrives under two names the line is corrupt (fail-closed, no silent win)", () => {
    for (const code of [
      { script_hash: "s1", body: "s1" },
      { script_hash: "s1", body: "s2" },
      { checkout_rev: "r1", runner: "r1" },
      { checkout_rev: "r1", runner: "r2" },
    ]) {
      expect(normalizeEnvelope({ ...rawBasis, code }).ok).toBe(false)
    }
  })

  test("different slots may be carried under mixed names (no conflict)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", runner: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.envelope.code).toEqual({ runner: "r1", body: "s1" })
  })

  test("a secret-shaped slot fails safe to masked (***)", () => {
    const normalized = normalizeEnvelope({ ...rawBasis, code: { body: "token=hunter2-abcdef1234", runner: "r1" } })
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.envelope.code).toEqual({ runner: "r1", body: "***" })
      expect(JSON.stringify(normalized.envelope)).not.toContain("hunter2")
    }
  })

  test("an undisciplined slot breaks the line (long/empty/shapeless)", () => {
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

  test("legacy-new same value: freshness stays confirmed-stable (equivalence-stable)", () => {
    const oldBasis = normalizeEnvelope({ ...rawBasis, code: { script_hash: "s1", checkout_rev: "r1" } })
    const newSame = normalizeEnvelope({ ...rawBasis, at: "2026-10-09T09:00:00.000Z", code: { runner: "r1", body: "s1" } })
    expect(oldBasis.ok).toBe(true)
    expect(newSame.ok).toBe(true)
    if (!oldBasis.ok || !newSame.ok) return
    expect(applyFreshness([oldBasis.envelope, newSame.envelope]).map((line) => line.status)).toEqual(["confirmed", "confirmed"])
  })

  test("one-sided code loss → script_hash (code-map mismatch)", () => {
    const runtimeOnly = normalizeEnvelope({ ...rawBasis, runtime: { port: 1 } })
    expect(runtimeOnly.ok).toBe(true)
    if (!runtimeOnly.ok) return
    // One-sided code loss: the basis has code, the line does not → code-map mismatch.
    const out = applyFreshness([basis(), runtimeOnly.envelope])
    expect(out[1]).toMatchObject({ status: "stale", stale_reason: "script_hash" })
  })
})
