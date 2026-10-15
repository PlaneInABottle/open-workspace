/** Shared redaction core: mask/cap only (fixture-first, pure module —
 * no live exec). */

import { describe, expect, test } from "bun:test"

import { capText, maskSecrets } from "./up-evidence"

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
    expect(maskSecrets('{"token": "hunter2", "nested": {"api_key": "hunter2"}}')).not.toContain("hunter2")
    expect(maskSecrets("retry --token hunter2")).not.toContain("hunter2")
    expect(maskSecrets("bearer hunter2 down")).not.toContain("hunter2")
  })

  test("cap: mark appended past the bound, short text untouched", () => {
    const capped = capText("y".repeat(600), 512)
    expect(capped.length).toBeLessThanOrEqual(512)
    expect(capped).toContain("…[truncated]")
    expect(capText("short", 512)).toBe("short")
  })
})

describe("maskSecrets structured JSON (compact-safe)", () => {
  test("a whole compact JSON object masks values, stays valid JSON", () => {
    const out = maskSecrets('{"token":"hunter2","a":"b"}')
    expect(out).toBe('{"token":"***","a":"b"}')
    expect(() => JSON.parse(out)).not.toThrow()
    expect((JSON.parse(out) as Record<string, string>)["a"]).toBe("b")
  })

  test("compact JSON nested in a command masks in place, structure kept", () => {
    const out = maskSecrets('mcp {"token":"hunter2","a":"b"} end')
    expect(out).toBe('mcp {"token":"***","a":"b"} end')
    expect(out).not.toContain("hunter2")
  })

  test("benign compact JSON stays byte-identical (no blind rewrite)", () => {
    for (const benign of ['{"a":"b","n":1}', "[1,2]", "uv run pytest a", "plain text stays"]) {
      expect(maskSecrets(benign)).toBe(benign)
    }
  })

  test("nested JSON masks secret keys at depth, keeps numbers/bools", () => {
    const out = maskSecrets('{"outer":{"api_key":"hunter2","n":3,"ok":true},"list":["x"]}')
    const parsed = JSON.parse(out) as Record<string, Record<string, unknown>>
    expect(parsed["outer"]["api_key"]).toBe("***")
    expect(parsed["outer"]["n"]).toBe(3)
    expect(parsed["outer"]["ok"]).toBe(true)
    expect(out).not.toContain("hunter2")
  })

  test("partial JSON tokens keep the existing token-walk behavior", () => {
    // `{"token":` alone is not complete JSON: falls through to key/next-value logic
    expect(maskSecrets('{"token": "hunter2"')).toBe('{"token": "***"')
  })
})

describe("maskSecrets context precedence (flag/key × JSON containers)", () => {
  const V = "fixtureValue42"

  test("P1: explicit post-flag JSON masks opaquely — marked and unmarked keys alike", () => {
    expect(maskSecrets(`run --token {"token":"${V}","value":"${V}"}`)).toBe("run --token ***")
    // arrays, nested objects and empty benign-looking objects under a flag: all opaque
    const mixed = maskSecrets(`run --token {"a":["${V}"],"n":{"x":"${V}"},"e":{}}`)
    expect(mixed).not.toContain(V)
    expect(mixed).toBe("run --token ***")
    // name-value (`key:`) context is equally strong
    expect(maskSecrets(`api_key: {"a":"${V}"}`)).toBe("api_key: ***")
    expect(maskSecrets(`api_key: {"a":"${V}"}`)).not.toContain(V)
  })

  test("P2: secret-keyed containers inherit context, structure stays valid", () => {
    const nested = maskSecrets(`run {"token":{"value":"${V}"}}`)
    expect(nested).toBe(`run {"token":{"value":"***"}}`)
    expect(() => JSON.parse(nested.slice(4))).not.toThrow()
    expect(nested).not.toContain(V)
    // no never-numbers exemption under explicit secret context ...
    expect(maskSecrets('{"token":12345}')).toBe('{"token":"***"}')
    expect(maskSecrets('{"token":true}')).toBe('{"token":"***"}')
    // ... but null stays null (absent value) and benign counts pass
    expect(maskSecrets('{"token":null}')).toBe('{"token":null}')
    expect(maskSecrets('{"n":12345,"ok":true,"counts":[1,2]}')).toBe('{"n":12345,"ok":true,"counts":[1,2]}')
    // deep inheritance keeps sibling structure
    const deep = maskSecrets(`{"outer":{"token":{"deep":"${V}"}},"n":7}`)
    expect(JSON.parse(deep)).toEqual({ outer: { token: { deep: "***" } }, n: 7 })
    // secret-keyed arrays taint every entry
    expect(maskSecrets(`{"tokens":["${V}","x"]}`)).toBe('{"tokens":["***","***"]}')
  })

  test("benign unflagged JSON stays byte-identical when unchanged", () => {
    for (const benign of [
      '{"a":"b","n":1,"ok":true,"e":null}',
      `mcp {"a":"b"} end`,
      `run {"n":7} ok`,
    ]) {
      expect(maskSecrets(benign)).toBe(benign)
    }
  })
})
