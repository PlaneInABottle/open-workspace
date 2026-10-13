/** `ow ps`: on-demand metrics snapshot over supervisor state. One `ps` call
 * per invocation (2 s timeout); every parse failure degrades to `unknown`,
 * never throws, exit stays 0. PID-reuse guard: a snapshot lstart that does
 * not match state is reported, never attributed.
 * `ps --explain` renders ONLY recorded provenance + this snapshot + TCP
 * flags below — child-process inspection beyond `ps(1)` never happens here
 * (see up-provenance.ts for the spawn-time observation point). */

import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { tcpListening } from "./up-net"
import { readSupervisorState, upPaths } from "./up-state"
import type { UpServiceState } from "./up-state"
import { decodeUtf8Fatal, parseUpFile, type UpService } from "./up-schema"
import { maskCmdShape } from "./up-reconcile"
import { reduceArtifactMap } from "./up-probe"
import type { Provenance } from "./up-provenance"

export type PsStatus = "running" | "exited" | "stopped" | "unknown"

export type PsService = {
  name: string
  status: PsStatus
  pid: number
  uptimeSec: number | null
  cpuPct: number | null
  memBytes: number | null
  port?: number
  /** Live TCP probe of the declared `port` (present only with `port`):
   * true = a listener accepts, false = nothing listening. */
  listening?: boolean
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

const toPsService = (
  svc: UpServiceState,
  snap: Map<number, PsSnapshotRow> | null,
  listening: boolean | undefined,
): PsServiceView => {
  const base = {
    name: svc.name,
    pid: svc.pid,
    uptimeSec: uptimeOf(svc.startedAt),
    ...(svc.port !== undefined ? { port: svc.port } : {}),
    ...(svc.port !== undefined && listening !== undefined ? { listening } : {}),
    ...(svc.exitCode !== undefined ? { exitCode: svc.exitCode } : {}),
  }
  const notes: string[] = []
  if (svc.portConflict === true) notes.push("port conflict")
  if (svc.logsEnded !== undefined) notes.push(`logs ended (code=${svc.logsEnded.code ?? "?"})`)
  // Spawn-time `readLstart` failure (`lstartUnknown`): the pid guard is
  // blind, so a live snapshot row can never be attributed and absence can
  // never mean dead — always `unknown` unless a settlement was recorded.
  const lstartUnknown = svc.lstart === "" || svc.lstartUnknown === true
  if (lstartUnknown) notes.push("lstart unknown")
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
    if (!lstartUnknown) notes.push("lstart mismatch")
    return { ...base, status: "unknown", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  if (snap === null && svc.exitCode === undefined) {
    notes.push("unmeasured")
    return { ...base, status: "unknown", cpuPct: null, memBytes: null, note: notes.join("; ") }
  }
  // Dead pid: a recorded numeric exit is `exited`; killed (-1) or unrecorded
  // death is `stopped`. Recorded exits stand even when `ps` itself failed —
  // and even with an unknown lstart (the supervisor recorded the reap).
  if (svc.exitCode !== undefined && svc.exitCode >= 0) {
    notes.push(`exit code ${svc.exitCode}`)
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
 * `supervisor.json` → honest empty; corrupt/versioned → English error
 * (exit 1, suggests `down --rm`). */
export const queryPs = async (rootDir: string): Promise<PsServiceView[]> => {
  const paths = upPaths(rootDir)
  let text: string
  try {
    text = await readFile(paths.supervisorFile, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`unreadable: supervisor.json (${String(error).slice(0, 80)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("unreadable: supervisor.json corrupt — clean with `down --rm`")
  }
  const dict = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  if (dict["version"] !== 1 || !Array.isArray(dict["services"])) {
    throw new Error("unreadable: supervisor.json version mismatch — clean with `down --rm`")
  }
  const services = dict["services"] as UpServiceState[]
  const [snap, probes] = await Promise.all([
    runSnapshot(services.map((svc) => svc.pid)),
    Promise.all(services.map((svc) => (svc.port !== undefined ? tcpListening(svc.port) : Promise.resolve(undefined)))),
  ])
  return services.map((svc, i) => toPsService(svc, snap, probes[i]))
}

const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return "?"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

const formatMem = (bytes: number | null): string => {
  if (bytes === null) return "?"
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

const STATUS_EN: Record<PsStatus, string> = { running: "running", exited: "exited", stopped: "stopped", unknown: "unknown" }

/** Human line: `web: running pid=123 uptime=2min cpu=%0.0 mem=12.3MB port=3000 (port conflict)`. */
export const formatPsLine = (svc: PsServiceView): string => {
  const parts = [
    `${svc.name}: ${STATUS_EN[svc.status]}`,
    `pid=${svc.pid}`,
    `uptime=${formatDuration(svc.uptimeSec)}`,
    `cpu=${svc.cpuPct === null ? "?" : `%${svc.cpuPct}`}`,
    `mem=${formatMem(svc.memBytes)}`,
  ]
  if (svc.port !== undefined) {
    parts.push(`port=${svc.port}`)
    if (svc.listening !== undefined) parts.push(`listen=${svc.listening ? "yes" : "no"}`)
  }
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
  ...(svc.port !== undefined && svc.listening !== undefined ? { listening: svc.listening } : {}),
  ...(svc.exitCode !== undefined ? { exitCode: svc.exitCode } : {}),
})

/** M2 `--explain`: expected (ow.yaml) vs running (recorded state +
 * snapshot/TCP view) witness render. Pure: takes data, never executes.
 * Inferred/UNVERIFIED provenance renders as-is — never a gate input. */
export type ExplainLstart = "matched" | "mismatch" | "unknown" | "dead" | "absent"

export type ExplainExpected = {
  cmdShape?: string
  cwd?: string
  port?: number
  /** Manifest-declared env key names only (ow.yaml `env:`/`requiredEnv`);
   * never the effective process environment — renders as `env(declared)`. */
  envNames?: string[]
} | null

export type ExplainRunning = {
  pid: number
  status: PsStatus
  lstart: ExplainLstart
  listening?: boolean
  /** Resolved running cwd (from provenance); its absence renders as UNVERIFIED
   * (a counter-check mismatch or a missing record). */
  cwd?: string
} | null

/** M3 readiness view: definition (masked) + last-known result (recorded
 * `lastReadiness`; tolerant read — `unmeasured` if shapeless). Explain does
 * NOT run the probe (it renders the definition + record). */
export type ExplainReadiness = {
  defined: boolean
  probe?: string
  timeout?: string
  needsPort?: boolean
  last: { ok: boolean; note?: string; at?: string } | null
}

const readRecordedReadiness = (rec: UpServiceState | undefined): ExplainReadiness["last"] => {
  const raw = (rec as unknown as Record<string, unknown> | undefined)?.["lastReadiness"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const dict = raw as Record<string, unknown>
  if (typeof dict["ok"] !== "boolean") return null
  return {
    ok: dict["ok"] as boolean,
    ...(typeof dict["note"] === "string" ? { note: dict["note"] as string } : {}),
    ...(typeof dict["at"] === "string" ? { at: dict["at"] as string } : {}),
  }
}

export type Explanation = {
  expected: ExplainExpected
  running: ExplainRunning
  /** Diff lines (human `diff:` body, no prefix). */
  diffs: string[]
  /** Recorded provenance verbatim (masked shapes/names by construction). */
  provenance: Provenance | null
  /** Single reason line (human `reason:` body, no prefix). */
  reason: string
  /** M3 readiness: masked definition + last-known result (never executed). */
  readiness: ExplainReadiness
  /** M-C build identity (reduced from the recorded map: masked-basename +
   * short-8, first 32 in order + counter; never a full path/full digest). */
  artifacts: { shown: { base: string; digest: string }[]; rest: number }
}

export type ServiceExplanation = { service: string; explanation: Explanation }

const LSTART_EN: Record<ExplainLstart, string> = {
  matched: "matched",
  mismatch: "mismatch",
  unknown: "unknown",
  dead: "dead",
  absent: "",
}

const expectedEnvNames = (svc: UpService): string[] | undefined =>
  svc.env === undefined && svc.requiredEnv === undefined
    ? undefined
    : [...new Set([...Object.keys(svc.env ?? {}), ...(svc.requiredEnv ?? [])])].sort()

export const explainServices = (opts: {
  rootDir: string
  expected: UpService[]
  views: PsServiceView[]
  records: UpServiceState[]
  /** False when the `ps(1)` snapshot itself failed (unknown ≠ mismatch). */
  snapshotOk: boolean
}): ServiceExplanation[] => {
  const viewByName = new Map(opts.views.map((view) => [view.name, view]))
  const recordByName = new Map(opts.records.map((record) => [record.name, record]))
  const names = [...opts.records.map((record) => record.name)]
  for (const svc of opts.expected) {
    if (!recordByName.has(svc.name)) names.push(svc.name)
  }
  return names.map((name) => {
    const exp = opts.expected.find((svc) => svc.name === name)
    const rec = recordByName.get(name)
    const view = rec ? viewByName.get(name) : undefined
    const expected: ExplainExpected =
      exp === undefined
        ? null
        : {
            ...(maskCmdShape(exp.cmd) === undefined ? {} : { cmdShape: maskCmdShape(exp.cmd) as string }),
            ...(exp.cwd === undefined ? {} : { cwd: exp.cwd }),
            ...(exp.port === undefined ? {} : { port: exp.port }),
            ...(expectedEnvNames(exp) === undefined ? {} : { envNames: expectedEnvNames(exp) as string[] }),
          }
    let verdict: ExplainLstart = "absent"
    if (rec !== undefined) {
      if (rec.exitCode !== undefined) verdict = "dead"
      else if (rec.lstart === "") verdict = "unknown"
      else if (view === undefined || view.status === "exited" || view.status === "stopped") verdict = "dead"
      else if (view.status === "running") verdict = "matched"
      else verdict = opts.snapshotOk ? "mismatch" : "unknown"
    }
    const running: ExplainRunning =
      rec === undefined || view === undefined
        ? null
        : {
            pid: rec.pid,
            status: view.status,
            lstart: verdict,
            ...(view.listening === undefined ? {} : { listening: view.listening }),
            ...(rec?.provenance?.cwdAbs === undefined ? {} : { cwd: rec.provenance.cwdAbs }),
          }
    const provenance = rec?.provenance ?? null
    const diffs: string[] = []
    if (rec !== undefined && exp !== undefined) {
      const expShape = maskCmdShape(exp.cmd)
      const runShape = rec.cmd === undefined ? undefined : maskCmdShape(rec.cmd)
      if (expShape !== undefined && runShape !== undefined && expShape !== runShape) {
        diffs.push(`command changed (recorded: ${runShape})`)
      }
      if (exp.cwd !== undefined) {
        const runCwd = provenance?.cwdAbs ?? (rec.cwd === undefined ? undefined : resolve(opts.rootDir, rec.cwd))
        const expCwd = resolve(opts.rootDir, exp.cwd)
        if (runCwd !== undefined && runCwd !== expCwd) diffs.push(`cwd changed (expected: ${exp.cwd}, running: ${runCwd})`)
      }
      if (exp.port !== undefined && rec.port !== undefined && exp.port !== rec.port) {
        diffs.push(`port changed (expected: ${exp.port}, running: ${rec.port})`)
      }
      const expEnv = expectedEnvNames(exp)
      if (expEnv !== undefined && rec.envNames !== undefined && JSON.stringify(expEnv) !== JSON.stringify([...rec.envNames].sort())) {
        diffs.push(`env names changed (declared; expected: [${expEnv.join(", ")}], running: [${rec.envNames.join(", ")}])`)
      }
    }
    if (verdict === "mismatch") diffs.push("lstart mismatch — suspected pid reuse")
    if (verdict === "unknown" && rec !== undefined && rec.exitCode === undefined) diffs.push("pid unverifiable (lstart unknown)")
    if (verdict === "dead" && rec !== undefined) {
      diffs.push(rec.exitCode !== undefined ? `process exited (exit code ${rec.exitCode})` : `process not running (status: ${STATUS_EN[view?.status ?? "stopped"]})`)
    }
    if (verdict === "matched" && rec?.port !== undefined && view?.listening === false) {
      diffs.push(`port ${rec.port} not listening`)
    }
    const rev = provenance?.checkout?.rev
    if (rev !== undefined && provenance?.checkout?.dirty === true) diffs.push(`started with dirty checkout (rev=${rev})`)
    const hasConfigDiff = diffs.some((line) => line.startsWith("command changed") || line.startsWith("cwd changed") || line.startsWith("port changed") || line.startsWith("env names changed"))
    let reason: string
    if (rec === undefined) reason = `no record → start with ow up ${name}`
    else if (exp === undefined) reason = `not in definition → stop with ow down ${name}`
    else if (verdict === "mismatch") reason = "lstart mismatch — suspected pid reuse, clean with ow down"
    else if (verdict === "dead") reason = `not running → inspect with ow logs ${name}, refresh with ow restart ${name}`
    else if (verdict === "unknown") reason = "pid unverifiable (lstart unknown) — no safe action"
    else if (hasConfigDiff) reason = `recorded command/cwd/port changed → refresh with ow restart ${name}`
    else if (view?.status === "running" && rec.port !== undefined) reason = "UP but no /endpoint → readiness undefined, add an M3 probe"
    else if (view?.status === "running") reason = "running (port undefined, no TCP expected)"
    else reason = "running, no known issues"
    const spec = exp?.readiness
    const readiness: ExplainReadiness =
      spec === undefined
        ? { defined: false, last: readRecordedReadiness(rec) }
        : {
            defined: true,
            probe: maskCmdShape([...spec.probe]) ?? "",
            timeout: spec.timeout,
            needsPort: spec.needsPort,
            last: readRecordedReadiness(rec),
          }
    return { service: name, explanation: { expected, running, diffs, provenance, reason, readiness, artifacts: reduceArtifactMap(rec?.artifactDigests) } }
  })
}

/** Human block for one explanation (English labels, no secrets: shapes,
 * names, counts and revs only). */
export const formatExplanation = (item: ServiceExplanation): string[] => {
  const { service, explanation } = item
  const lines = [`${service}:`]
  if (explanation.expected === null) {
    lines.push("  expected: unknown (ow.yaml unreadable)")
  } else {
    const parts = [
      ...(explanation.expected.cmdShape === undefined ? [] : [`cmd=${explanation.expected.cmdShape}`]),
      ...(explanation.expected.cwd === undefined ? [] : [`cwd=${explanation.expected.cwd}`]),
      ...(explanation.expected.port === undefined ? [] : [`port=${explanation.expected.port}`]),
      ...(explanation.expected.envNames === undefined ? [] : [`env(declared)=[${explanation.expected.envNames.join(", ")}]`]),
    ]
    lines.push(`  expected: ${parts.length > 0 ? parts.join(" ") : "-"}`)
  }
  const readiness = explanation.readiness
  if (readiness.defined) {
    const last =
      readiness.last === null
        ? "unmeasured"
        : readiness.last.ok
          ? `ready (${readiness.last.at ?? "?"})`
          : `not-ready (${readiness.last.note ?? "not ready"})`
    lines.push(`  readiness: ${readiness.probe} (${readiness.timeout}) → ${last}`)
  }
  if (explanation.running === null) {
    lines.push("  running: none (no record)")
  } else {
    const parts = [
      `pid=${explanation.running.pid}`,
      STATUS_EN[explanation.running.status],
      `lstart=${LSTART_EN[explanation.running.lstart]}`,
    ]
    if (explanation.running.listening !== undefined) parts.push(`listen=${explanation.running.listening ? "yes" : "no"}`)
    parts.push(explanation.running.cwd === undefined ? "cwd=unverifiable(UNVERIFIED)" : `cwd=${explanation.running.cwd}`)
    const rev = explanation.provenance?.checkout?.rev
    parts.push(
      rev === undefined
        ? "rev=unverifiable(UNVERIFIED)"
        : `rev=${rev}(observed)${explanation.provenance?.checkout?.dirty === true ? "+dirty" : ""}`,
    )
    const interpreter = explanation.provenance?.interpreter?.name
    parts.push(interpreter === undefined ? "interpreter=-" : `interpreter=${interpreter}(inferred)`)
    lines.push(`  running: ${parts.join(" ")}`)
  }
  for (const diff of explanation.diffs) lines.push(`  diff: ${diff}`)
  if (explanation.artifacts.shown.length > 0) {
    const chips = explanation.artifacts.shown.map((entry) => `${entry.base}@${entry.digest}`).join(", ")
    lines.push(`  build: ${chips}${explanation.artifacts.rest > 0 ? ` (+${explanation.artifacts.rest} more)` : ""}`)
  }
  lines.push(`  reason: ${explanation.reason}`)
  return lines
}

/** `ow ps --explain [svc] [--json]`: recorded render (exit 0 ok / 1
 * structural / 2 usage). Unknown service → exit 2. */
export const runPsExplain = async (opts: { rootDir: string; file: string; service?: string; json: boolean }): Promise<number> => {
  let views: PsServiceView[]
  try {
    views = await queryPs(opts.rootDir)
  } catch (error) {
    console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  let records: UpServiceState[] = []
  try {
    const text = await readFile(upPaths(opts.rootDir).supervisorFile, "utf8")
    const parsed = JSON.parse(text) as { services?: UpServiceState[] }
    if (Array.isArray(parsed.services)) records = parsed.services
  } catch {
    records = []
  }
  let expected: UpService[] | null = null
  try {
    expected = parseUpFile(decodeUtf8Fatal(readFileSync(opts.file))).services
  } catch {
    if (!opts.json) console.error("warning: ow.yaml unreadable (expected unknown)")
  }
  const known = [...new Set([...(expected ?? []).map((svc) => svc.name), ...records.map((svc) => svc.name)])]
  if (opts.service !== undefined && !known.includes(opts.service)) {
    console.error(`ow: unknown service: ${opts.service}${known.length > 0 ? ` (${known.join(", ")})` : ""}`)
    return 2
  }
  // Snapshot health for the lstart verdict: `ps(1)` ran inside queryPs;
  // unknown-without-measurement must not read as mismatch. Any view whose
  // note carries the measurement-failure marker proves a blind snapshot.
  const snapshotOk = !views.some((view) => view.note !== undefined && view.note.includes("unmeasured"))
  const items = explainServices({ rootDir: opts.rootDir, expected: expected ?? [], views, records }).filter(
    (item) => opts.service === undefined || item.service === opts.service,
  )
  if (opts.json) {
    console.log(
      JSON.stringify({
        services: views
          .filter((view) => opts.service === undefined || view.name === opts.service)
          .map(toPsServiceJson),
        explanations: items.map((item) => ({ service: item.service, explanation: item.explanation })),
      }),
    )
    return 0
  }
  if (items.length === 0) {
    console.log("no state")
    return 0
  }
  console.log(items.flatMap(formatExplanation).join("\n"))
  return 0
}
