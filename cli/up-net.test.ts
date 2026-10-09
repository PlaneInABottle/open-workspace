import { describe, expect, test } from "bun:test"

import { tcpConnect, tcpListening } from "./up-net"

describe("tcpConnect", () => {
  test("accepts against a live listener, refuses after it stops", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
    const port = holder.port
    try {
      expect(await tcpConnect(port)).toBe(true)
      expect(await tcpListening(port)).toBe(true)
    } finally {
      holder.stop(true)
    }
    expect(await tcpConnect(port)).toBe(false)
    expect(await tcpListening(port)).toBe(false)
  })

  test("invalid ports are false, never throw", async () => {
    expect(await tcpConnect(0)).toBe(false)
    expect(await tcpConnect(70000)).toBe(false)
    expect(await tcpConnect(3.5)).toBe(false)
    expect(await tcpListening(-1)).toBe(false)
  })

  test("an unbound loopback port is false within the timeout budget", async () => {
    // Pick a closed port by binding then releasing it.
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
    const port = holder.port
    holder.stop(true)
    const start = Date.now()
    expect(await tcpConnect(port, { timeoutMs: 300 })).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
