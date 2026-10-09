/** Raw TCP readiness probe (no application protocol knowledge). Distinct from
 * `up-supervisor.probePort`, which is an HTTP fetch used only to WARN about a
 * pre-existing port occupant before spawning — that fetch can report a
 * non-HTTP listener (Postgres, gRPC) as free. Readiness needs "does something
 * accept a TCP connection here", so this module connects and closes. */

import { createConnection } from "node:net"

/** One bounded TCP connect. `true` = a listener accepted, `false` = refused,
 * unreachable or timed out. Never throws; an invalid port is `false`. The
 * socket is destroyed and the timer cleared on the first settlement. */
export const tcpConnect = (port: number, opts: { host?: string; timeoutMs?: number } = {}): Promise<boolean> => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false)
  const host = opts.host ?? "127.0.0.1"
  const timeoutMs = opts.timeoutMs ?? 400
  return new Promise((resolveProbe) => {
    let settled = false
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => settle(false), timeoutMs)
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolveProbe(value)
    }
    socket.once("connect", () => settle(true))
    socket.once("error", () => settle(false))
  })
}

/** A declared port counts as listening when either loopback family accepts a
 * connection (services may bind IPv4-only or IPv6-only). */
export const tcpListening = async (port: number, timeoutMs = 400): Promise<boolean> => {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await tcpConnect(port, { host, timeoutMs })) return true
  }
  return false
}

/** One-shot loopback HTTP health probe for `up -d --wait --health`: GET the
 * given path on 127.0.0.1 and report 2xx only. Any status outside 2xx, any
 * refusal/timeout, or an invalid port/path is `false`. Never throws; never
 * leaves loopback. */
export const httpHealthOk = async (port: number, path: string, timeoutMs = 1000): Promise<boolean> => {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith("/")) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer().catch(() => undefined)
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}
