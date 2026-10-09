import { describe, expect, test } from "bun:test"

import { tcpConnect, tcpListening, httpHealthOk } from "./up-net"

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

describe("httpHealthOk", () => {
  test("2xx only: 404/503 are false, a later 200 is true (Spring-shaped fixture)", async () => {
    let well = false
    const holder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path === "/actuator/health") return well ? new Response("up") : new Response("down", { status: 503 })
        return new Response("nope", { status: 404 })
      },
    })
    const port = holder.port
    try {
      expect(await httpHealthOk(port, "/actuator/health")).toBe(false) // 503 while booting
      expect(await httpHealthOk(port, "/")).toBe(false) // `/` 404 is normal, never ready
      well = true
      expect(await httpHealthOk(port, "/actuator/health")).toBe(true)
    } finally {
      holder.stop(true)
    }
  })

  test("invalid port/path and closed ports are false, never throw", async () => {
    expect(await httpHealthOk(0, "/health")).toBe(false)
    expect(await httpHealthOk(9999, "health")).toBe(false) // missing leading slash short-circuits
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
    const port = holder.port
    holder.stop(true)
    expect(await httpHealthOk(port, "/health")).toBe(false)
  })
})
