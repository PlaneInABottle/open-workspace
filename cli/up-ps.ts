/** `ow ps`: on-demand metrics snapshot over supervisor state. One `ps` call
 * per invocation (2 s timeout); every parse failure degrades to `unknown`,
 * never throws, exit stays 0. PID-reuse guard: a snapshot lstart that does
 * not match state is reported, never attributed. */

import { readFile } from "node:fs/promises"

import { upPaths } from "./up-state"
import type { UpServiceState } from "./up-state"

export type PsStatus = "running" | "exited" | "stopped" | "unknown"

export type PsService = {
  name: string
  status: PsStatus
  pid: number
  uptimeSec: number | null
  cpuPct: number | null
  memBytes: number | null
  port?: number
  exitCode?: number
}

/** `[[dd-]hh:]mm:ss` (macOS + Linux `ps -o etime=`) → seconds. Null when foreign. */
export const parseEtime = (raw: string): number | null => {
  const match = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (![days, hours, minutes, seconds].every(Number.isInteger) || minutes >= 60 || seconds >= 60) return null
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds
}

export type PsSnapshotRow = { etimeSec: number; rssKb: number; pcpu: number; lstart: string }

/** Parse `ps -o pid=,etime=,rss=,pcpu=,lstart=` rows. Foreign lines are
 * skipped; never throws (empty map on garbage). */
export const parsePsSnapshot = (output: string): Map<number, PsSnapshotRow> => {
  const rows = new Map<number, PsSnapshotRow>()
  try {
    for (const line of output.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Split only the four leading fixed columns; the lstart tail keeps its
      // native internal padding (`Oct  7` two spaces) so it compares equal to
      // `readLstart`, which trims ends only. Never split/join the tail.
      const match = trimmed.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
      if (!match) continue
      const pid = Number(match[1])
      if (!Number.isInteger(pid) || pid <= 0) continue
      const etimeSec = parseEtime(match[2])
      if (etimeSec === null) continue
      const rssKb = Number(match[3])
      if (!Number.isFinite(rssKb) || rssKb < 0) continue
      const pcpu = Number(match[4])
      if (!Number.isFinite(pcpu)) continue
      rows.set(pid, { etimeSec, rssKb, pcpu, lstart: match[5] })
    }
  } catch {
    // fall through with what parsed
  }
  return rows
}

/** Single snapshot for the given pids. Null when `ps` itself fails or times
 * out (callers degrade to `unknown`); empty map when simply nobody is alive. */
const runSnapshot = async (pids: number[], timeoutMs = 2000): Promise<Map<number, PsSnapshotRow> | null> => {
  if (pids.length === 0) return new Map()
  try {
    const proc = Bun.spawn(["ps", "-o", "pid=,etime=,rss=,pcpu=,lstart=", "-p", pids.join(",")], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited
    return parsePsSnapshot(out)
  } catch {
    return null
  }
}

const uptimeOf = (startedAt: string): number | null => {
  const when = Date.parse(startedAt)
  if (!Number.isFinite(when)) return null
  return Math.max(0, Math.round((Date.now() - when) / 1000))
}

export type PsServiceView = PsService & { note?: string }

const toPsService = (svc: UpServiceState, snap: Map<number, PsSnapshotRow> | null): PsServiceView => {
  const base = {
    name: svc.name,
    pid: svc.pid,
    uptimeSec: uptimeOf(svc.startedAt),
    ...(svc.port !== undefined ? { port: svc.port } : {}),
    ...(svc.exitCode !== undefined ? { exitCode: svc.exitCode } : {}),
  }
  const notes: string[] = []
  if (svc.portConflict === true) notes.push("port çakışması")
  if (svc.logsEnded !== undefined) notes.push(`logs bitti (code=${svc.logsEnded.code ?? "?"})`)
  // Spawn-time `readLstart` failure (`lstartUnknown`): the pid guard is
  // blind, so a live snapshot row can never be attributed and absence can
  // never mean dead — always `unknown` unless a settlement was recorded.
  const lstartUnknown = svc.lstart === "" || svc.lstartUnknown === true
  if (lstartUnknown) notes.push("lstart bilinmiyor")
  const row = snap?.get(svc.pid)
  if (row !== undefined && !lstartUnknown && row.lstart === svc.lstart) {
    return {
      ...base,
      status: "running",
      cpuPct: row.pcpu,
      memBytes: Math.round(row.rssKb * 1024),
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    }
  }
  if (row !== undefined) {
    // Live pid with a foreign (or unverifiable) lstart: never attribute.
    if (!lstartUnknown) notes.push("lstart uyuşmazlığı")
    return { ...base, status: "unknown", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  if (snap === null && svc.exitCode === undefined) {
    notes.push("ölçüm alınamadı")
    return { ...base, status: "unknown", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  // Dead pid: a recorded numeric exit is `exited`; killed (-1) or unrecorded
  // death is `stopped`. Recorded exits stand even when `ps` itself failed —
  // and even with an unknown lstart (the supervisor recorded the reap).
  if (svc.exitCode !== undefined && svc.exitCode >= 0) {
    notes.push(`çıkış kodu ${svc.exitCode}`)
    return { ...base, status: "exited", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  if (lstartUnknown) {
    return { ...base, status: "unknown", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  return {
    ...base,
    status: "stopped",
    cpuPct: null,
    memBytes: null,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  }
}

/** State-authoritative service list with one live snapshot attached. Missing
 * `supervisor.json` → honest empty; corrupt/versioned → Turkish error
 * (exit 1, suggests `down --rm`). */
export const queryPs = async (rootDir: string): Promise<PsServiceView[]> => {
  const paths = upPaths(rootDir)
  let text: string
  try {
    text = await readFile(paths.supervisorFile, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`okunamıyor: supervisor.json (${String(error).slice(0, 80)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("okunamıyor: supervisor.json bozuk — `down --rm` ile temizleyin")
  }
  const dict = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  if (dict["version"] !== 1 || !Array.isArray(dict["services"])) {
    throw new Error("okunamıyor: supervisor.json sürüm uyuşmazlığı — `down --rm` ile temizleyin")
  }
  const services = dict["services"] as UpServiceState[]
  const snap = await runSnapshot(services.map((svc) => svc.pid))
  return services.map((svc) => toPsService(svc, snap))
}

const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return "?"
  if (seconds < 60) return `${seconds}sn`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}sa`
  return `${Math.floor(seconds / 86400)}gün`
}

const formatMem = (bytes: number | null): string => {
  if (bytes === null) return "?"
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

const STATUS_TR: Record<PsStatus, string> = { running: "çalışıyor", exited: "bitti", stopped: "durdu", unknown: "bilinmiyor" }

/** Human line: `web: çalışıyor pid=123 süre=2dk cpu=%0.0 mem=12.3MB port=3000 (port çakışması)`. */
export const formatPsLine = (svc: PsServiceView): string => {
  const parts = [
    `${svc.name}: ${STATUS_TR[svc.status]}`,
    `pid=${svc.pid}`,
    `süre=${formatDuration(svc.uptimeSec)}`,
    `cpu=${svc.cpuPct === null ? "?" : `%${svc.cpuPct}`}`,
    `mem=${formatMem(svc.memBytes)}`,
  ]
  if (svc.port !== undefined) parts.push(`port=${svc.port}`)
  return svc.note ? `${parts.join(" ")} (${svc.note})` : parts.join(" ")
}

/** JSON contract: exactly the documented English keys (note is human-only). */
export const toPsServiceJson = (svc: PsServiceView): PsService => ({
  name: svc.name,
  status: svc.status,
  pid: svc.pid,
  uptimeSec: svc.uptimeSec,
  cpuPct: svc.cpuPct,
  memBytes: svc.memBytes,
  ...(svc.port !== undefined ? { port: svc.port } : {}),
  ...(svc.exitCode !== undefined ? { exitCode: svc.exitCode } : {}),
})
