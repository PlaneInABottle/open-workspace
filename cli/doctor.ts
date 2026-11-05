import { stat } from "node:fs/promises"
import { Database } from "bun:sqlite"

import { readOwnBuildSidecar, type UpBuildInfo } from "./build-info"
import { DEFAULT_DB_PATH, DEFAULT_LOG_PATH, readLogBounds } from "./join"

export { DEFAULT_DB_PATH, DEFAULT_LOG_PATH }

const isJsonLine = (line: string): boolean => {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

export const RING_MAX_BYTES = 100 * 1024 * 1024
export const RING_MAX_LINES = 50_000

export type DoctorLine = { name: string; ok: boolean; detail: string }

/** Observer health: shell log growth, hook firing, ring buffer, intent
 * DB. */
export const doctor = async (options: { logPath?: string; dbPath?: string } = {}): Promise<DoctorLine[]> => {
  const lines: DoctorLine[] = []
  const logPath = options.logPath ?? DEFAULT_LOG_PATH
  try {
    const info = await stat(logPath)
    const text = await Bun.file(logPath).text()
    const rows = text.split("\n").filter((l) => l.trim().length > 0)
    const last = rows.length > 0 ? (() => { try { return (JSON.parse(rows[rows.length - 1]) as { timestamp?: unknown }).timestamp } catch { return null } })() : null
    const age = typeof last === "string" ? Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000)) : null
    const kinds = new Set<string>()
    for (const line of rows.slice(-500)) {
      try {
        const parsed = JSON.parse(line) as { kind?: unknown; command?: unknown }
        kinds.add(typeof parsed.kind === "string" ? parsed.kind : "shell")
      } catch {
        continue
      }
    }
    lines.push({ name: "log", ok: true, detail: `growing: ${(info.size / 1024).toFixed(0)}KB/${rows.length} lines, last line ${age === null ? "unknown" : `${age}s ago`}` })
    lines.push({ name: "hook", ok: kinds.size > 0, detail: kinds.size > 0 ? `flowing kinds: ${[...kinds].join(", ")}` : "no records in last 500 lines" })
    const pctBytes = Math.min(99, Math.round((info.size / RING_MAX_BYTES) * 100))
    const pctLines = Math.min(99, Math.round((rows.length / RING_MAX_LINES) * 100))
    const pct = Math.max(pctBytes, pctLines)
    // Store facts a reader needs to judge coverage. Full scan of the log on
    // purpose: a single pass over ~75 MB measured ~160-200 ms, and a corrupt
    // line can sit anywhere (the live store has one mid-file), so head/tail
    // sampling would miss it. Bounds reuse readLogBounds (single source).
    const bounds = await readLogBounds(logPath)
    const corrupt = rows.length - rows.filter((l) => isJsonLine(l)).length
    const binding = pctLines >= pctBytes ? "line cap 50k" : "byte cap 100MB"
    const span = bounds === null ? "span unknown" : `oldest ${new Date(bounds.firstMs).toISOString()}, newest ${new Date(bounds.lastMs).toISOString()}`
    lines.push({ name: "ring", ok: pct < 90, detail: `%${pct} full (${(info.size / 1024).toFixed(0)}KB/${rows.length} lines; cap 100MB/50k); binding ${binding}; ${span}; ${corrupt} unparseable line(s)` })
  } catch (error) {
    lines.push({ name: "log", ok: false, detail: `unreadable: ${String(error).slice(0, 120)}` })
    lines.push({ name: "hook", ok: false, detail: "no log" })
    lines.push({ name: "ring", ok: false, detail: "no log" })
  }
  try {
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_message','session_v2')").all() as { name: string }[]
      const names = tables.map((t) => t.name)
      const ok = names.includes("session_message") && names.includes("session_v2")
      lines.push({ name: "db", ok, detail: ok ? "session_message + session_v2 readable" : `missing tables (have: ${names.join(",") || "none"})` })
    } finally {
      db.close()
    }
  } catch (error) {
    lines.push({ name: "db", ok: false, detail: `cannot open: ${String(error).slice(0, 120)}` })
  }
  return lines
}

export const formatDoctor = (lines: DoctorLine[]): string =>
  lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.name}: ${l.detail}`).join("\n")

/** `doctor --json` build identity (only short-8 forms reach the wire —
 * full sha/digest never emitted, no paths/execPath/secrets). */
export type DoctorIdentity = {
  installed: { sha8: string; dirty: boolean; time: string; binary8: string } | null
}

export const doctorIdentity = async (options: { installed?: UpBuildInfo | null } = {}): Promise<DoctorIdentity> => {
  const installed = options.installed !== undefined ? options.installed : await readOwnBuildSidecar()
  return {
    installed: installed === null ? null : { sha8: installed.sha.slice(0, 8), dirty: installed.dirty ?? false, time: installed.time, binary8: installed.digest.slice(0, 8) },
  }
}

/** Plain human identity line (printed outside `lines`, so the exit rule
 * in cli.ts never sees it). */
export const formatIdentity = (identity: DoctorIdentity): string[] => [
  identity.installed === null
    ? "identity: installed unknown (no sidecar)"
    : `identity: installed ${identity.installed.sha8} (binary ${identity.installed.binary8}, ${identity.installed.time}${identity.installed.dirty ? ", dirty" : ""})`,
]

if (import.meta.main) {
  const results = await doctor()
  console.log(formatDoctor(results))
  if (results.some((l) => !l.ok)) process.exit(1)
}
