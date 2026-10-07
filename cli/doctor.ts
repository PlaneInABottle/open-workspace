import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { classifyLock, readSupervisorState, upPaths } from "./up-state"

const DEFAULT_LOG_PATH = join(homedir(), ".local", "share", "opencode-shell-log", "shell-events.jsonl")
const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")

export const RING_MAX_BYTES = 100 * 1024 * 1024
export const RING_MAX_LINES = 50_000

export type DoctorLine = { name: string; ok: boolean; detail: string }

export const doctor = async (options: { logPath?: string; dbPath?: string; upRoot?: string } = {}): Promise<DoctorLine[]> => {
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
    lines.push({ name: "log", ok: true, detail: `büyüyor: ${(info.size / 1024).toFixed(0)}KB/${rows.length} satır, son satır ${age === null ? "bilinmiyor" : `${age}sn önce`}` })
    lines.push({ name: "kanca", ok: kinds.size > 0, detail: kinds.size > 0 ? `akan tipler: ${[...kinds].join(", ")}` : "son 500 satırda kayıt yok" })
    const pctBytes = Math.min(99, Math.round((info.size / RING_MAX_BYTES) * 100))
    const pctLines = Math.min(99, Math.round((rows.length / RING_MAX_LINES) * 100))
    const pct = Math.max(pctBytes, pctLines)
    lines.push({ name: "halka", ok: pct < 90, detail: `%${pct} dolu (${(info.size / 1024).toFixed(0)}KB/${rows.length} satır; tavan 100MB/50bin)` })
  } catch (error) {
    lines.push({ name: "log", ok: false, detail: `okunamıyor: ${String(error).slice(0, 120)}` })
    lines.push({ name: "kanca", ok: false, detail: "log yok" })
    lines.push({ name: "halka", ok: false, detail: "log yok" })
  }
  try {
    const db = new Database(options.dbPath ?? DEFAULT_DB_PATH, { readonly: true })
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_message','session_v2')").all() as { name: string }[]
      const names = tables.map((t) => t.name)
      const ok = names.includes("session_message") && names.includes("session_v2")
      lines.push({ name: "db", ok, detail: ok ? "session_message + session_v2 okunuyor" : `eksik tablo (var: ${names.join(",") || "hiç"})` })
    } finally {
      db.close()
    }
  } catch (error) {
    lines.push({ name: "db", ok: false, detail: `açılamıyor: ${String(error).slice(0, 120)}` })
  }
  // Informational only: never feeds the `ow doctor` exit rule (cli.ts filters
  // `up` out). ok:true solely for a lock-verified live supervisor.
  try {
    const paths = upPaths(options.upRoot ?? process.cwd())
    const status = await classifyLock(paths.lockFile)
    if (status.kind === "live") {
      const state = await readSupervisorState(paths.supervisorFile)
      const total = state?.services.length ?? 0
      const done = state?.services.filter((svc) => svc.exitCode !== undefined).length ?? 0
      lines.push({
        name: "up",
        ok: true,
        detail: total > 0 ? `çalışıyor (${total} servis${done > 0 ? `, ${done} bitti` : ""})` : "çalışıyor (durum yok)",
      })
    } else if (status.kind === "absent") {
      lines.push({ name: "up", ok: false, detail: "durgun (çalışan supervisor yok)" })
    } else if (status.kind === "stale") {
      lines.push({ name: "up", ok: false, detail: `bayat (${status.reason})` })
    } else {
      lines.push({ name: "up", ok: false, detail: `doğrulanamıyor (${status.reason})` })
    }
  } catch (error) {
    lines.push({ name: "up", ok: false, detail: `okunamıyor: ${String(error).slice(0, 80)}` })
  }
  return lines
}

export const formatDoctor = (lines: DoctorLine[]): string =>
  lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.name}: ${l.detail}`).join("\n")

if (import.meta.main) {
  const results = await doctor()
  console.log(formatDoctor(results))
  if (results.filter((l) => l.name !== "up").some((l) => !l.ok)) process.exit(1)
}
