/** Bounded readiness wait for `ow up -d --wait <süre>`: poll each declared
 * service `port` until a TCP listener accepts, a service exits, or the window
 * elapses. This is not a healthcheck/restart system (still explicit
 * non-goals) — it only answers "did the ports come up", which operators
 * otherwise fabricate with `sleep 90; curl`. */

import { readSupervisorState, upPaths } from "./up-state"

export type ReadyTarget = { name: string; port: number }
export type ReadyStatus = "ready" | "timeout" | "exited"
export type ReadyResult = { name: string; port: number; status: ReadyStatus; waitedSec: number; exitCode?: number }

const defaultSleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Pure orchestration (probe/exited/now/sleep injected): ready when every
 * target's port accepts; a recorded supervisor exit fails that target fast —
 * waiting out the full window for a service that already died is noise. */
export const waitForReady = async (opts: {
  targets: ReadyTarget[]
  timeoutMs: number
  exited: () => Promise<Map<string, number>>
  probe: (port: number) => Promise<boolean>
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<ReadyResult[]> => {
  if (opts.targets.length === 0) return []
  const now = opts.now ?? Date.now
  const sleepFn = opts.sleep ?? defaultSleep
  const interval = opts.intervalMs ?? 500
  const start = now()
  const elapsed = (): number => Math.max(0, Math.round((now() - start) / 1000))
  const done = new Map<string, ReadyResult>()
  for (;;) {
    const probes = await Promise.all(opts.targets.map((t) => opts.probe(t.port).catch(() => false)))
    const exited = await opts.exited().catch(() => new Map<string, number>())
    let pending = false
    opts.targets.forEach((target, index) => {
      if (done.has(target.name)) return
      const exitCode = exited.get(target.name)
      if (exitCode !== undefined) {
        done.set(target.name, { name: target.name, port: target.port, status: "exited", waitedSec: elapsed(), exitCode })
      } else if (probes[index]) {
        done.set(target.name, { name: target.name, port: target.port, status: "ready", waitedSec: elapsed() })
      } else {
        pending = true
      }
    })
    if (!pending) return opts.targets.map((target) => done.get(target.name)!)
    if (now() - start >= opts.timeoutMs) {
      for (const target of opts.targets) {
        if (!done.has(target.name)) {
          done.set(target.name, { name: target.name, port: target.port, status: "timeout", waitedSec: elapsed() })
        }
      }
      return opts.targets.map((target) => done.get(target.name)!)
    }
    await sleepFn(interval)
  }
}

/** Supervisor-recorded exit codes by service name (fail-fast input for
 * `waitForReady`). Missing/foreign state yields an empty map, never throws. */
export const exitedServices = async (rootDir: string): Promise<Map<string, number>> => {
  const state = await readSupervisorState(upPaths(rootDir).supervisorFile)
  const codes = new Map<string, number>()
  for (const svc of state?.services ?? []) {
    if (svc.exitCode !== undefined) codes.set(svc.name, svc.exitCode)
  }
  return codes
}
