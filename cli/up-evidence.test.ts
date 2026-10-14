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
