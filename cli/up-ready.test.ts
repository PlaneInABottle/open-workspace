import { describe, expect, test } from "bun:test"

import { parseWaitDuration, waitForReady } from "./up-ready"

/** Deterministic clock: `sleep` advances it, so timeout math is exact. */
const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe("waitForReady", () => {
  test("all ports ready on the first probe", async () => {
    const results = await waitForReady({
      targets: [
        { name: "api", port: 1001 },
        { name: "web", port: 1002 },
      ],
      timeoutMs: 1000,
      probe: async () => true,
      exited: async () => new Map(),
    })
    expect(results).toEqual([
      { name: "api", port: 1001, status: "ready", waitedSec: 0 },
      { name: "web", port: 1002, status: "ready", waitedSec: 0 },
    ])
  })

  test("a late listener becomes ready before the window closes", async () => {
    const clock = fakeClock()
    let calls = 0
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001 }],
      timeoutMs: 5000,
      intervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return calls >= 3 // ready on the third poll
      },
      exited: async () => new Map(),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "ready", waitedSec: 1 }])
    expect(calls).toBe(3)
  })

  test("no listener by the deadline marks timeout", async () => {
    const clock = fakeClock()
    let calls = 0
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001 }],
      timeoutMs: 1000,
      intervalMs: 400,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return false
      },
      exited: async () => new Map(),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "timeout", waitedSec: 1 }])
    expect(calls).toBe(4) // probes at t=0/400/800, then the deadline probe at t=1200
  })

  test("a recorded supervisor exit fails that target fast", async () => {
    const clock = fakeClock()
    let calls = 0
    const results = await waitForReady({
      targets: [
        { name: "api", port: 1001 },
        { name: "web", port: 1002 },
      ],
      timeoutMs: 5000,
      intervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return false
      },
      exited: async () => new Map([["web", 1]]),
    })
    // web dies immediately; api keeps polling until its own deadline
    expect(results.find((r) => r.name === "web")).toEqual({ name: "web", port: 1002, status: "exited", waitedSec: 0, exitCode: 1 })
    expect(results.find((r) => r.name === "api")?.status).toBe("timeout")
    expect(calls).toBeGreaterThan(1)
  })

  test("no targets resolves immediately", async () => {
    expect(await waitForReady({ targets: [], timeoutMs: 1000, probe: async () => false, exited: async () => new Map() })).toEqual([])
  })

  test("a health-gated target waits past TCP-accept until HTTP 200", async () => {
    const clock = fakeClock()
    let calls = 0
    const seen: (string | undefined)[] = []
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001, healthPath: "/health" }],
      timeoutMs: 5000,
      intervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      probe: async (target) => {
        calls += 1
        seen.push(target.healthPath)
        return calls >= 3 // TCP accepts at once, HTTP 404s until the third poll
      },
      exited: async () => new Map(),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "ready", waitedSec: 1, healthPath: "/health" }])
    expect(seen).toEqual(["/health", "/health", "/health"])
  })

  test("a health gate that never turns 2xx marks timeout (healthPath echoed)", async () => {
    const clock = fakeClock()
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001, healthPath: "/actuator/health" }],
      timeoutMs: 1000,
      intervalMs: 400,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => false,
      exited: async () => new Map(),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "timeout", waitedSec: 1, healthPath: "/actuator/health" }])
  })

  test("an exit during the health poll fails that target fast", async () => {
    const clock = fakeClock()
    let calls = 0
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001, healthPath: "/health" }],
      timeoutMs: 5000,
      intervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return false
      },
      exited: async () => new Map([["api", 143]]),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "exited", waitedSec: 0, exitCode: 143, healthPath: "/health" }])
    expect(calls).toBe(1)
  })

  test("unflagged targets carry no healthPath", async () => {
    const results = await waitForReady({
      targets: [{ name: "api", port: 1001 }],
      timeoutMs: 1000,
      probe: async () => true,
      exited: async () => new Map(),
    })
    expect(results).toEqual([{ name: "api", port: 1001, status: "ready", waitedSec: 0 }])
  })
})

describe("parseWaitDuration (moved from the retired trace verb; the runtime wait stays)", () => {
  test("maps units with a 5m cap", () => {
    expect(parseWaitDuration("15s")).toBe(15_000)
    expect(parseWaitDuration("1m")).toBe(60_000)
    expect(parseWaitDuration("5m")).toBe(300_000)
    expect(parseWaitDuration("0s")).toBeNull()
    expect(parseWaitDuration("6m")).toBeNull()
    expect(parseWaitDuration("1h")).toBeNull()
    expect(parseWaitDuration("bogus")).toBeNull()
    expect(parseWaitDuration("15")).toBeNull()
  })
})
