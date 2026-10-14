import { stat } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { classifyLock, classifySupervisorFile, readOwnBuildSidecar, readSupervisorState, upPaths, type UpBuildInfo } from "./up-state"
import { DEFAULT_DB_PATH, DEFAULT_LOG_PATH } from "./join"

export { DEFAULT_DB_PATH, DEFAULT_LOG_PATH }

export const RING_MAX_BYTES = 100 * 1024 * 1024
export const RING_MAX_LINES = 50_000

export type DoctorLine = { name: string; ok: boolean; detail: string }

/** Stale-supervisor compare, pure for testability: names both build times
 * plus the affected scope (count + names, capped) when a recorded digest
 * differs from the current binary's, else silent. Empty digests and
 * either side missing mean "cannot tell" → silent. Service names are
 * operator-local (never secrets); absent/empty service lists read as
 * unrecorded, never as zero. */
export const staleSupervisorHint = (
  recorded: UpBuildInfo | null | undefined,
  current: UpBuildInfo | null,
  serviceNames: string[] = [],
): string => {
  if (!recorded || !current) return ""
  if (recorded.digest.length === 0 || current.digest.length === 0) return ""
  if (recorded.digest === current.digest) return ""
  const shown = serviceNames.slice(0, 5).join(", ")
  const more = serviceNames.length > 5 ? ` (+${serviceNames.length - 5} more)` : ""
  const scope =
    serviceNames.length > 0
      ? ` affecting ${serviceNames.length} service${serviceNames.length === 1 ? "" : "s"} (${shown}${more})`
      : " (no recorded services)"
  return `. hint: running supervisor stale (running ${recorded.time}, installed ${current.time})${scope} — restart the supervisor itself (ow down, then ow up) to refresh; per-service restart does not refresh a stale supervisor`
}

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
    lines.push({ name: "log", ok: true, detail: `growing: ${(info.size / 1024).toFixed(0)}KB/${rows.length} lines, last line ${age === null ? "unknown" : `${age}s ago`}` })
    lines.push({ name: "hook", ok: kinds.size > 0, detail: kinds.size > 0 ? `flowing kinds: ${[...kinds].join(", ")}` : "no records in last 500 lines" })
    const pctBytes = Math.min(99, Math.round((info.size / RING_MAX_BYTES) * 100))
    const pctLines = Math.min(99, Math.round((rows.length / RING_MAX_LINES) * 100))
    const pct = Math.max(pctBytes, pctLines)
    lines.push({ name: "ring", ok: pct < 90, detail: `%${pct} full (${(info.size / 1024).toFixed(0)}KB/${rows.length} lines; cap 100MB/50k)` })
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
  // Informational only: never feeds the `ow doctor` exit rule (cli.ts filters
  // `up` out). ok:true solely for a lock-verified live supervisor.
  // A build mismatch appends a bounded refresh hint; any compare failure
  // stays silent (missing sidecars must not fail or reword doctor).
  // Polish (friction 9): every non-live `up` detail ends with the
  // reconcile pointer (live needs no action).
  const reconcileHint = " — hint: ow reconcile --check"
  try {
    const paths = upPaths(options.upRoot ?? process.cwd())
    const status = await classifyLock(paths.lockFile)
    if (status.kind === "live") {
      const state = await readSupervisorState(paths.supervisorFile)
      const total = state?.services.length ?? 0
      const done = state?.services.filter((svc) => svc.exitCode !== undefined).length ?? 0
      let detail = total > 0 ? `running (${total} services${done > 0 ? `, ${done} exited` : ""})` : "running (no state)"
      try {
        // Absent service lists (old builds) stay tolerated: unrecorded scope.
        detail += staleSupervisorHint(state?.build, await readOwnBuildSidecar(), state?.services?.map((svc) => svc.name))
      } catch {
        // compare must never throw; silence on any failure
      }
      lines.push({ name: "up", ok: true, detail })
    } else if (status.kind === "absent") {
      lines.push({ name: "up", ok: false, detail: `idle (no running supervisor)${reconcileHint}` })
    } else if (status.kind === "stale") {
      lines.push({ name: "up", ok: false, detail: `stale (${status.reason})${reconcileHint}` })
    } else {
      lines.push({ name: "up", ok: false, detail: `unverifiable (${status.reason})${reconcileHint}` })
    }
  } catch (error) {
    lines.push({ name: "up", ok: false, detail: `unreadable: ${String(error).slice(0, 80)}${reconcileHint}` })
  }
  return lines
}

export const formatDoctor = (lines: DoctorLine[]): string =>
  lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.name}: ${l.detail}`).join("\n")

/** Additive `doctor --json` build identity (digests compared internally,
 * only short-8 forms reach the wire — full sha/digest never emitted, no
 * paths/execPath/secrets). `match`: true (same digest), false (differ),
 * null (either side missing/uncomparable). */
export type DoctorIdentity = {
  installed: { sha8: string; dirty: boolean; time: string; binary8: string } | null
  supervisor: { state: "recorded" | "absent" | "unreadable"; startedAt: string | null; sha8: string | null; time: string | null }
  match: boolean | null
}

export const doctorIdentity = async (options: { upRoot?: string; installed?: UpBuildInfo | null } = {}): Promise<DoctorIdentity> => {
  const installed = options.installed !== undefined ? options.installed : await readOwnBuildSidecar()
  const state = await readSupervisorState(upPaths(options.upRoot ?? process.cwd()).supervisorFile)
  if (!state) {
    const status = await classifySupervisorFile(upPaths(options.upRoot ?? process.cwd()).supervisorFile)
    return {
      installed: installed === null ? null : { sha8: installed.sha.slice(0, 8), dirty: installed.dirty ?? false, time: installed.time, binary8: installed.digest.slice(0, 8) },
      supervisor: { state: status === "missing" ? "absent" : "unreadable", startedAt: null, sha8: null, time: null },
      match: null,
    }
  }
  const recorded = state.build ?? null
  return {
    installed: installed === null ? null : { sha8: installed.sha.slice(0, 8), dirty: installed.dirty ?? false, time: installed.time, binary8: installed.digest.slice(0, 8) },
    supervisor: {
      state: recorded === null ? "absent" : "recorded",
      startedAt: state.startedAt,
      sha8: recorded === null ? null : recorded.sha.slice(0, 8),
      time: recorded?.time ?? null,
    },
    match:
      installed !== null && recorded !== null && installed.digest.length > 0 && recorded.digest.length > 0
        ? installed.digest === recorded.digest
        : null,
  }
}

/** Plain human identity lines (printed outside `lines`, so the exit rule
 * in cli.ts — which filters `lines` — never sees them). */
export const formatIdentity = (identity: DoctorIdentity): string[] => {
  const first =
    identity.installed === null
      ? "identity: installed unknown (no sidecar)"
      : `identity: installed ${identity.installed.sha8} (binary ${identity.installed.binary8}, ${identity.installed.time}${identity.installed.dirty ? ", dirty" : ""})`
  const sup = identity.supervisor
  const verdict = identity.match === null ? "unknown" : identity.match ? "match" : "mismatch"
  const second =
    sup.state === "recorded" && sup.sha8 !== null
      ? `identity: supervisor recorded ${sup.sha8} (started ${sup.startedAt ?? "?"}): ${verdict}`
      : `identity: supervisor ${sup.state}: ${verdict}`
  return [first, second]
}

if (import.meta.main) {
  const results = await doctor()
  console.log(formatDoctor(results))
  if (results.filter((l) => l.name !== "up").some((l) => !l.ok)) process.exit(1)
}
