import {
  DEFAULT_DB_PATH,
  DEFAULT_LOG_PATH,
  filterSince,
  filterTools,
  formatGrouped,
  formatMeta,
  formatReads,
  formatSessions,
  formatStuck,
  groupByTask,
  joinSession,
  latestSession,
  listSessions,
  parseBytes,
  parseSince,
  readDigest,
  sessionMeta,
  sessionPrompts,
  showLine,
  SINCE_TOKENS,
  sinceWindow,
  storeWindow,
  stuckReport,
  windowNotice,
  type EnrichedRecord,
  type SinceWindow,
} from "./join"
import { doctor, formatDoctor, formatIdentity, doctorIdentity } from "./doctor"
import { buildTree, formatTree, loadTreeRecords, treeIds } from "./tree"
import { parseWaitDuration } from "./trace-cli"
import { decodeUtf8Fatal, formatUpWarnings, isSubsetNestingError, missingRequiredEnv, parseUpFile, PROBE_TIMEOUT_MS, subsetNestingHint } from "./up-schema"
import { isSecretFlagToken, maskCmdShape, maskSecretToken } from "./up-reconcile"
import { maskSecrets } from "./up-evidence"
import type { UpService } from "./up-schema"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export const COMMANDS = ["doctor", "sessions", "show", "stuck", "meta", "prompts", "reads", "up", "restart", "down", "reconcile", "ps", "logs", "trace", "timeline", "init", "checkpoints", "preflight", "readiness", "provision", "scenarios", "failures", "record", "contract", "scenario", "export"] as const
export type Command = (typeof COMMANDS)[number]

/** The overlay readers (single source for help + the fail-loud guard +
 * refusal below; the help-coverage test derives from this). `scenario`
 * covers both subverbs — see OVERLAY_READER_LABELS for the eight names. */
export const OVERLAY_READERS = ["scenarios", "preflight", "readiness", "provision", "record", "contract", "scenario"] as const

/** All eight reader names for help/refusal (`scenario` splits in two). */
export const OVERLAY_READER_LABELS = ["scenarios", "preflight", "readiness", "provision", "record", "contract", "scenario run", "scenario env"] as const

/** The eight `--since` readers (single source for help + the fail-loud
 * cross-verb guard below; the help-coverage test derives from this). */
export const SINCE_READERS = ["sessions", "show", "stuck", "reads", "logs", "failures", "trace", "timeline"] as const
const ALIASES: Record<string, Command> = { list: "sessions" }

const VALUE_FLAGS = new Set(["--db", "--log", "--since", "--dir", "--kind", "--tool", "--show", "--bytes", "--file", "--tail", "--grep", "--service", "--wait", "--health", "--trace", "--min-spans", "--run", "--boundaries", "--out", "--claim-entrypoint", "--claim-boundary"])
const BOOL_FLAGS = new Set(["--json", "--full", "--tree", "--flat", "--show-fails", "--help", "-h", "--check", "--detach", "--rm", "--force", "--tracing", "--probe", "--explain", "--off-local", "--bundle", "--resume"])

export type ParsedArgs = {
  command: Command | null
  sessionID: string | undefined
  /** `--health` and `--claim-boundary` are repeatable and accumulate
   * into a string array; every other value flag holds a single string. */
  flags: Record<string, string | boolean | string[]>
  error: string | null
  /** Second and later positionals (`checkpoints show <run> /
   * `checkpoints diff <runA> <runB>` / `scenario run <name>`). Any other
   * command rejects them with the pre-existing usage error. */
  extra: string[]
}

export const helpText = (): string =>
  [
    "ow — shell-observer CLI (read-only, non-interactive)",
    "",
    "usage: ow <command> [session] [options]",
    "",
    "commands:",
    "  doctor                        health: log/hook/ring/db/up",
    "  sessions [--since] [--dir]    session list (id, count, range, dir)",
    "  show [session] [--since] [--full] [--bytes] [--tree] [--kind ..] [--tool ..] [--show N] [--show-fails]",
    "                                task summary; --tree shows the subtask tree",
    "  stuck [session] [--since] [--tree]  stuck report (joined records)",
    "  meta [session]                cost/token/changes/turns",
    "  prompts [session]             last 50 user prompts (oldest first)",
    "  reads [session] [--since]     read summary",
    "  up [service] [--file] [--check] [-d|--detach] [--wait 120s] [--health svc=/path]  start services (ow.yaml); --check only validates;",
  "                                -d with --wait: wait until declared ports open (exit: 1 when not ready);",
  "                                --health <name>=<path> (repeatable, only with --wait): that service waits for HTTP 2xx after TCP",
  "                                single service (up <name> [--wait 120s] [--health <name>=<path>]): added to the live supervisor by request, healthy ones unaffected; --wait waits one-shot (live only, -d ignored)",
    "  restart <service> [--file] [--wait 120s] [--health <name>=<path>]   restart one service on the live supervisor + waited (live only; exit 2 without lock)",
    "  down [service] [--file] [--rm]  stop services (--rm only with bulk down; exit 2 for a single service)",
    "  reconcile --check [--json] [--probe] [--file]  read-only drift report (no mutation; exit 1 on drift, 0 in sync)",
    "  ps [--file]                   service status (pid, uptime, cpu, memory, port, listen)",
    "  ps --explain [service] [--file] [--json]  expected/running witness view (read-only)",
    "  logs [service] [--file] [--tail] [--grep] [--since]  service logs",
    "  checkpoints list [--file] [--json]  recorded evidence runs (read-only)",
    "  checkpoints show <run> [--file] [--json] [--resume]  shows envelopes as confirmed/stale/not-observed (+ resume view)",
    "  checkpoints diff <runA> <runB> [--file] [--json]  envelope-by-stage status/proof/digest deltas (read-only)",
    "  failures [--since 30m|3h|1d|1w] [--file] [--json]  repeated findings (read-only, mechanical)",
    "  preflight [--file] [--json] [--probe]  read-only gate (no mutation; exit 1 when failing)",
    "  readiness [--file] [--json] [--probe]  boundary-witnessed readiness (false-green hunt; exit 0 ready / 1 not)",
  "  provision --check [--file] [--json] [--probe]  workspace checklist (.env symlink + .venv + HEAD + pre-gate; read-only, exit 0 pass / 1 missing)",
    "  scenarios --check [--file] [--json]  ow.scenarios.yaml v1 schema validation (no runs; probe-only lanes: record + contract check)",
    "  record <scenario> [--file] [--claim-entrypoint <text>] [--claim-boundary <name>=<kind>:<ref>]  declarative deterministic scenario capture (.ow/replay; no state-changing)",
    "                                --claim-boundary <name>=<kind>:<ref> (repeatable, record-only; kind real|fake; opaque caller claims, stored + rendered verbatim)",
    "  contract check [--file] [--json]  recorded contract summary (exit 0 match / 1 mismatch-unrecorded)",
    "  scenario run <name> [--file] [--json] [--run <id>] [--off-local]  narrowed deterministic run (5 phases, restore mandatory; probe-only lanes without restore: record + contract check)",
    "  scenario env <name> [--file] [--json] [--boundaries <path>]  boundary matrix as OW_BOUNDARY_* lines (read-only render)",
    "  export --bundle [<run>] [--file] [--out <path>]  one redacted snapshot file for tickets (read-only composition)",
    "  trace [trace] [--file] [--tail] [--since] [--service] [--wait] [--min-spans]  traces; one tree per trace; --wait 15s waits for new spans",
  "  timeline [session] [--trace] [--since] [--tail]  agent lines + trace spans as a joined timeline",
  "  init [--force] [--tracing]  starter ow.yaml skeleton from a repo scan (--force keeps a single ow.yaml.bak)",
    `  --boundaries <path>  overlay file (root-relative; flag wins over .ow/boundaries.local.yaml; ${OVERLAY_READER_LABELS.map((label) => label.replace(" ", "-")).join("/")} only)`,
    "",
    "general: --db <path> --log <path> --json --help",
    `  --since  window: ${SINCE_TOKENS} (${SINCE_READERS.join("/")})`,
    "  --json  machine output (English keys): doctor/show/stuck/meta/sessions/reads/prompts/ps/logs/down/trace/timeline/reconcile/checkpoints/failures/preflight/readiness/provision/scenarios/contract/scenario (+ up --check)",
    "exit: 0 ok, 1 structural error, 2 usage error",
    "",
    "example: ow show <session> --tree --since 1d",
  ].join("\n")

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean | string[]> = {}
  let command: Command | null = null
  let sessionID: string | undefined
  const extra: string[] = []
  const fail = (error: string): ParsedArgs => ({ command, sessionID, flags, error, extra })
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "-d") {
      flags["--detach"] = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      flags["--help"] = true
      continue
    }
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("--")) return fail(`value expected: ${arg}`)
        if (arg === "--health" || arg === "--claim-boundary") {
          const prior = flags[arg]
          flags[arg] = [...(Array.isArray(prior) ? prior : prior !== undefined ? [prior as string] : []), value]
        } else {
          flags[arg] = value
        }
        i += 1
        continue
      }
      if (BOOL_FLAGS.has(arg)) {
        flags[arg] = true
        continue
      }
      return fail(`unknown option: ${arg}`)
    }
    if (!command && (COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command
      continue
    }
    if (!command && ALIASES[arg]) {
      command = ALIASES[arg]
      continue
    }
    if (command && sessionID === undefined) {
      sessionID = arg
      continue
    }
    // P2-A: only `checkpoints` takes a second positional (`show <run>`);
    // every other surface keeps the pre-existing usage error (same text).
    // M5 note: `record <run-name>` and `contract check` ride the first
    // positional (sessionID) slot with dispatch-side validation below, so
    // this rule needs no change - a second positional stays a usage error.
    // M6: `scenario run <name>` follows the `checkpoints show <run>` shape:
    // subverb in the sessionID slot, target in extra.
    if (command === "checkpoints" || command === "scenario") {
      extra.push(arg)
      continue
    }
    return fail(`unexpected argument: ${arg}`)
  }
  if (flags["--help"]) return { command, sessionID, flags, error: null, extra }
  if (!command) return fail("command expected: doctor|sessions|show|stuck|meta|prompts|reads|up|down|ps|logs|trace|timeline|init (--help)")
  const since = typeof flags["--since"] === "string" ? parseSince(flags["--since"]) : undefined
  if (typeof flags["--since"] === "string" && since === null) return fail(`invalid --since: ${flags["--since"]} (${SINCE_TOKENS})`)
  const bytes = typeof flags["--bytes"] === "string" ? parseBytes(flags["--bytes"]) : undefined
  if (typeof flags["--bytes"] === "string" && bytes === null) return fail(`invalid --bytes: ${flags["--bytes"]} (512|1k|4k|1m)`)
  if (typeof flags["--show"] === "string" && !Number.isFinite(Number(flags["--show"]))) {
    return fail(`invalid --show: ${flags["--show"]} (line number expected)`)
  }
  if (typeof flags["--tail"] === "string") {
    const tail = Number(flags["--tail"])
    if (!Number.isInteger(tail) || tail < 1 || tail > 5000) return fail(`invalid --tail: ${flags["--tail"]} (1-5000 expected)`)
  }
  if (typeof flags["--min-spans"] === "string") {
    const minSpans = Number(flags["--min-spans"])
    if (!Number.isInteger(minSpans) || minSpans < 1 || minSpans > 5000) return fail(`invalid --min-spans: ${flags["--min-spans"]} (1-5000 expected)`)
  }
  if (typeof flags["--wait"] === "string" && parseWaitDuration(flags["--wait"]) === null) {
    return fail(`invalid --wait: ${flags["--wait"]} (e.g. 15s, at most 5m)`)
  }
  if (typeof flags["--grep"] === "string" && flags["--grep"].length > 256) {
    return fail("invalid --grep: at most 256 characters")
  }
  return { command, sessionID, flags, error: null, extra }
}

// --json envelopes: stable English keys; human views keep plain English labels.
// `window` is the additive `--since` envelope ({since, cutoff} or null).
export const toSessionsJson = (sessions: Awaited<ReturnType<typeof listSessions>>, window: SinceWindow | null = null) => ({ sessions, window })
export const toShowJson = (
  sessionID: string,
  warnings: string[],
  groups: ReturnType<typeof groupByTask>,
  tree?: ReturnType<typeof treeIds>,
  window: SinceWindow | null = null,
) => (tree ? { session: sessionID, warnings, groups, tree, window } : { session: sessionID, warnings, groups, window })
export const toStuckJson = (sessionID: string, report: Awaited<ReturnType<typeof stuckReport>>, window: SinceWindow | null = null) => ({
  session: sessionID,
  report,
  window,
})

/** `doctor` exit rule: `up` and `trace` lines are informational only. */
export const doctorFails = (lines: { name: string; ok: boolean }[]): boolean =>
  lines.filter((l) => l.name !== "up" && l.name !== "trace").some((l) => !l.ok)

/** Supervisor root: the --file directory or cwd; state/logs live under <root>/.ow. */
export const upRootDir = (flags: Record<string, string | boolean | string[]>): string => {
  const file = flag(flags, "--file")
  return file ? dirname(resolve(file)) : process.cwd()
}
export const upFilePath = (flags: Record<string, string | boolean | string[]>): string => {
  const file = flag(flags, "--file")
  return file ? resolve(file) : join(process.cwd(), "ow.yaml")
}
export const upStateDir = (rootDir: string): string => join(rootDir, ".ow")

/** `ow up -d --wait <duration> [--health <name>=<path> ...]`: block until every
 * declared `port` accepts a TCP connection, a service exits, or the window
 * elapses. A service named in `health` additionally waits for HTTP 2xx on
 * `http://127.0.0.1:<port><path>` after its TCP gate (unflagged services keep
 * pure TCP). M3: a service with a `readiness:` definition additionally runs
 * its project probe (argv-only, one-shot per throttle window) after its TCP
 * gate (or directly when `needsPort: false`); a failing probe keeps the
 * target pending until the window elapses (no retry/restart outside the
 * wait itself). Exit 0 only when all waited targets are ready; portless
 * services without a probe are named but not waited on (nothing to probe).
 * JSON mirrors the trace/ps English-key discipline, with `healthPath`
 * echoed per flagged service and an additive per-service `readiness`
 * envelope (`{kind: tcp|http-health|probe, ok, note?, waitedSec}`); existing
 * keys (`ready/services/noPort`) are untouched. */
export type WaitReadiness = { kind: "tcp" | "http-health" | "probe"; ok: boolean; note?: string; waitedSec: number }

/** Captured wait verdict (lets single-service verbs merge it into their
 * own single JSON object instead of printing a second one). */
export type WaitVerdict = { ready: boolean; services: Array<Record<string, unknown>>; noPort: string[] }

export const waitForUpReady = async (opts: {
  rootDir: string
  services: UpService[]
  timeoutMs: number
  json: boolean
  health?: Record<string, string>
  /** Injected project-probe runner (default: real `runProbe`). Tests pass a
   * fake; the throttle below bounds how often it fires per target. */
  runProbeFn?: import("./up-probe").ProbeFn
  /** Captured verdict instead of printing (single-service --json merges it
   * into its own single object; two objects would violate the stdout
   * channel). When set, every verdict — including the empty-targets
   * vacuity refusal below — rides onPayload and nothing prints here. */
  onPayload?: (payload: WaitVerdict) => void
}): Promise<number> => {
  const { exitedServices, waitForReady } = await import("./up-ready")
  const { httpHealthOk, tcpListening } = await import("./up-net")
  const { runProbeJob } = await import("./up-probe")
  const { resolve: resolvePath } = await import("node:path")
  const runProbeFn = opts.runProbeFn ?? runProbeJob
  const health = opts.health ?? {}
  const byName = new Map(opts.services.map((svc) => [svc.name, svc]))
  const targets = opts.services
    .filter((svc) => svc.port !== undefined || svc.readiness !== undefined)
    .map((svc) => ({
      name: svc.name,
      ...(svc.port === undefined ? {} : { port: svc.port }),
      ...(health[svc.name] === undefined ? {} : { healthPath: health[svc.name] }),
    }))
  const noPort = opts.services.filter((svc) => svc.port === undefined && svc.readiness === undefined).map((svc) => svc.name)
  if (targets.length === 0) {
    // M-f vacuity refusal: nothing to wait on is a caller error (exit 2),
    // never a silent pass. With onPayload the verdict rides the single
    // merged object instead of printing here (no double-print).
    const vacuous: WaitVerdict = { ready: false, services: [], noPort }
    if (opts.onPayload !== undefined) {
      opts.onPayload(vacuous)
    } else if (opts.json) {
      console.log(JSON.stringify({ ...vacuous, note: "no targets to wait for" }))
    } else {
      console.error("ow: nothing to wait for (no services declare ports or probes)")
    }
    return 2
  }
  // Per-target probe tracker (N6: probe-function composition — the loop in
  // up-ready.ts is untouched). Project probes fire at most once per 2s per
  // target (a 500ms spawn loop would drown the project script otherwise);
  // TCP/health keep their every-poll cadence.
  const track = new Map<string, { tcpOk: boolean; probe?: { ran: boolean; ok: boolean; note: string; at: number } }>()
  const tracked = (name: string): { tcpOk: boolean; probe?: { ran: boolean; ok: boolean; note: string; at: number } } => {
    let entry = track.get(name)
    if (!entry) {
      entry = { tcpOk: false }
      track.set(name, entry)
    }
    return entry
  }
  const results = await waitForReady({
    targets,
    timeoutMs: opts.timeoutMs,
    probe: async (target) => {
      const svc = byName.get(target.name)
      const st = tracked(target.name)
      const needTcp = target.port !== undefined && (svc?.readiness === undefined || svc.readiness.needsPort)
      if (needTcp && !(await tcpListening(target.port as number))) return false
      st.tcpOk = true
      const path = health[target.name]
      if (path !== undefined) return httpHealthOk(target.port as number, path)
      const spec = svc?.readiness
      if (spec === undefined) return true
      if (st.probe !== undefined && Date.now() - st.probe.at < 2000) return st.probe.ok
      const outcome = await runProbeFn({
        probe: spec.probe,
        timeoutMs: PROBE_TIMEOUT_MS[spec.timeout],
        cwd: svc?.cwd === undefined ? opts.rootDir : resolvePath(opts.rootDir, svc.cwd),
        env: { ...process.env, ...svc?.env, OW_SERVICE: target.name },
      }).catch((): import("./up-probe").ProbeOutcome => ({ ok: false, note: "could-not-run", timedOut: false, code: null }))
      st.probe = { ran: true, ok: outcome.ok, note: outcome.note, at: Date.now() }
      return outcome.ok
    },
    exited: () => exitedServices(opts.rootDir),
  })
  const readinessOf = (result: { name: string; status: string; waitedSec: number }): WaitReadiness | undefined => {
    const svc = byName.get(result.name)
    const st = track.get(result.name)
    if (health[result.name] !== undefined) {
      return { kind: "http-health", ok: result.status === "ready", waitedSec: result.waitedSec }
    }
    if (svc?.readiness === undefined) {
      if (result.status === "exited") return undefined
      return { kind: "tcp", ok: result.status === "ready", waitedSec: result.waitedSec }
    }
    if (st?.probe !== undefined) return { kind: "probe", ok: st.probe.ok && result.status === "ready", note: st.probe.note, waitedSec: result.waitedSec }
    return { kind: "probe", ok: false, note: "unmeasured", waitedSec: result.waitedSec }
  }
  const ready = results.every((result) => result.status === "ready")
  const where = (result: { port?: number; healthPath?: string }): string =>
    result.port === undefined ? "" : result.healthPath === undefined ? `:${result.port}` : `:${result.port}${result.healthPath}`
  const withReadiness = results.map((result) => {
    const readiness = readinessOf(result)
    return { ...result, ...(readiness === undefined ? {} : { readiness }) }
  })
  if (opts.onPayload !== undefined) {
    opts.onPayload({ ready, services: withReadiness, noPort })
  } else if (opts.json) {
    console.log(JSON.stringify({ ready, services: withReadiness, noPort }))
  } else {
    for (const result of withReadiness) {
      const readiness = (result as { readiness?: WaitReadiness }).readiness
      if (result.status === "ready") console.log(`ready: ${result.name}${where(result)} (${result.waitedSec}s)`)
      else if (result.status === "exited") console.log(`exited: ${result.name} (exit code ${result.exitCode ?? "?"}) — ow logs ${result.name}`)
      else if (readiness?.kind === "probe") console.log(`not ready: ${result.name} (probe: ${readiness.note ?? "not ready"})`)
      else console.log(`timeout: ${result.name}${where(result)} (${result.waitedSec}s)`)
    }
    if (noPort.length > 0) console.log(`port undefined (not waited): ${noPort.join(", ")}`)
  }
  // M3 last-known persistence (B1-clean: request channel, sole writer stays
  // the supervisor; ack loss only warns, never fails the verdict).
  const { classifyLock, readSupervisorState, upPaths } = await import("./up-state")
  const { writeRequest, waitResult } = await import("./up-requests")
  try {
    if ((await classifyLock(upPaths(opts.rootDir).lockFile)).kind === "live") {
      const state = await readSupervisorState(upPaths(opts.rootDir).supervisorFile)
      const pending: Promise<unknown>[] = []
      for (const svc of opts.services) {
        if (svc.readiness === undefined) continue
        const readiness = readinessOf(results.find((result) => result.name === svc.name) ?? { name: svc.name, status: "timeout", waitedSec: 0 })
        if (readiness?.kind !== "probe" || readiness.note === "unmeasured") continue
        const pid = state?.services.find((entry) => entry.name === svc.name)?.pid
        if (pid === undefined) continue
        const at = new Date().toISOString()
        const note = readiness.note
        const ok = readiness.ok
        pending.push(
          (async () => {
            try {
              const nonce = await writeRequest(upPaths(opts.rootDir).requestsDir, "readiness", svc.name, join(opts.rootDir, "ow.yaml"), {
                readiness: { pid, ok, ...(note === undefined ? {} : { note }), at },
              })
              await waitResult(upPaths(opts.rootDir).requestsDir, nonce)
            } catch {
              if (!opts.json) console.error(`warning: readiness record unverified: ${svc.name}`)
            }
          })(),
        )
      }
      await Promise.all(pending)
    }
  } catch {
    // recording is best-effort; the verdict above stands regardless
  }
  return ready ? 0 : 1
}

/** Parse repeatable `--health <name>=<path>` values into a service→path map
 * (last wins per service; one occurrence may hold comma-separated pairs).
 * Throws an English usage error when an entry lacks `=`, the path does not
 * start with `/`, the service is unknown, or it declares no port (health
 * needs a TCP gate to build on). */
export const parseHealthFlags = (
  raw: string | string[] | undefined,
  services: UpService[],
): Record<string, string> => {
  const map: Record<string, string> = {}
  if (raw === undefined) return map
  const entries = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => value.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const entry of entries) {
    const eq = entry.indexOf("=")
    if (eq <= 0 || eq === entry.length - 1) throw new Error(`invalid --health: ${entry} (<service>=<path> expected)`)
    const name = entry.slice(0, eq).trim()
    const path = entry.slice(eq + 1).trim()
    if (!path.startsWith("/")) throw new Error(`invalid --health: ${entry} (path must start with /)`)
    const svc = services.find((s) => s.name === name)
    if (!svc) {
      const known = services.map((s) => s.name).join(", ")
      throw new Error(`unknown service: ${name} (--health${known.length > 0 ? `; known: ${known}` : ""})`)
    }
    if (svc.port === undefined) throw new Error(`--health cannot be used on a portless service: ${name} (no port defined)`)
    map[name] = path
  }
  return map
}

const flag = (flags: Record<string, string | boolean | string[]>, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined

/** `up --check --json` service listings: byte-identical key order to the
 * raw serialization for clean configs, with B3 masking applied — `cmd` /
 * `logs` are never printed raw, `readiness` carries a masked shape rather
 * than raw argv (`env`/`requiredEnv` are already hidden because they stay
 * non-enumerable). */
export const toCheckServicesJson = (services: UpService[]): Record<string, unknown>[] => {
  const maskCmd = (cmd: string | string[] | undefined): string | string[] | undefined => {
    if (cmd === undefined) return undefined
    if (typeof cmd === "string") return maskCmdShape(cmd)
    let prevFlag = false
    return cmd.map((part) => {
      const out = maskSecretToken(part, prevFlag)
      prevFlag = isSecretFlagToken(part)
      return out
    })
  }
  return services.map((svc) => ({
    name: svc.name,
    ...(svc.cmd === undefined ? {} : { cmd: maskCmd(svc.cmd) }),
    ...(svc.cwd === undefined ? {} : { cwd: svc.cwd }),
    ...(svc.port === undefined ? {} : { port: svc.port }),
    ...(svc.logs === undefined ? {} : { logs: maskCmdShape(svc.logs) }),
    ...(svc.dependsOn === undefined ? {} : { dependsOn: [...svc.dependsOn] }),
    ...(svc.readiness === undefined
      ? {}
      : {
          readiness: {
            probe: maskCmdShape([...svc.readiness.probe]) ?? "",
            timeout: svc.readiness.timeout,
            needsPort: svc.readiness.needsPort,
          },
        }),
  }))
}

/** M1 single-service client flow over the B1 request channel. Live lock →
 * diff + atomic request + one-shot (10s) result wait; the client never
 * spawns, acquires, or persists. Returns null only for `up` with no live
 * supervisor (caller falls back to classic bulk `up`); `restart` refuses
 * (exit 2) and `down` stops directly without touching the lock file (B5). */
export const runSingleServiceRequest = async (opts: {
  rootDir: string
  file: string
  action: "up" | "restart" | "down"
  service: string
  json: boolean
  /** `--wait` duration for single up/restart (live supervisor only): the
   * action runs first, then readiness waits one-shot for the target alone
   * through the shared waitForUpReady loop (same TCP→HTTP/probe discipline). */
  wait?: string
  /** Repeatable `--health <name>=<path>` (target-only; shared parse). */
  health?: string | string[]
  /** Injected project-probe runner (default: real `runProbe`; tests pass a
   * fake and assert single-target invocation). */
  runProbeFn?: import("./up-probe").ProbeFn
}): Promise<number | null> => {
  let text: string
  try {
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${opts.file}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const svc = parsed.services.find((entry) => entry.name === opts.service)
  if (!svc) {
    const known = parsed.services.map((entry) => entry.name).join(", ")
    console.error(`ow: unknown service: ${opts.service}${known.length > 0 ? ` (known: ${known})` : ""}`)
    return 2
  }
  // `down` skips the env gate (stopping must never wait on credentials).
  if (opts.action !== "down") {
    const missing = missingRequiredEnv([svc])
    if (missing.length > 0) {
      for (const entry of missing) {
        console.error(`ow: ${entry.service} missing required environment variables: ${entry.vars.join(", ")}`)
      }
      return 2
    }
  }
  const { classifyLock, readSupervisorState, upPaths } = await import("./up-state")
  const paths = upPaths(opts.rootDir)
  let status: Awaited<ReturnType<typeof classifyLock>>
  try {
    status = await classifyLock(paths.lockFile)
  } catch {
    status = { kind: "absent" }
  }
  if (status.kind !== "live") {
    if (opts.action === "restart") {
      console.error("ow: no running supervisor for restart — run `ow up` first")
      return 2
    }
    if (opts.action === "down") return runDirectSingleDown(opts.rootDir, opts.service, opts.json)
    return null
  }
  // Single-service --wait/--health pre-request guards (exit 2, before any
  // request write): the wait runs only on the live path, after a
  // successful action, for the named target alone.
  let waitMs: number | undefined
  let waitHealth: Record<string, string> = {}
  if ((opts.action === "up" || opts.action === "restart") && (opts.wait !== undefined || opts.health !== undefined)) {
    if (opts.health !== undefined && opts.wait === undefined) {
      console.error("ow: --health works only with --wait (--wait <duration> required)")
      return 2
    }
    if (opts.wait !== undefined) {
      const parsed = parseWaitDuration(opts.wait)
      if (parsed === null) {
        console.error(`ow: invalid --wait: ${opts.wait} (e.g. 15s, at most 5m)`)
        return 2
      }
      waitMs = parsed
    }
    if (opts.health !== undefined) {
      try {
        waitHealth = parseHealthFlags(opts.health, parsed.services)
      } catch (error) {
        console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
        return 2
      }
      for (const name of Object.keys(waitHealth)) {
        if (name !== opts.service) {
          console.error(`ow: --health must name the target service: ${opts.service} (got: ${name})`)
          return 2
        }
      }
      if (waitHealth[opts.service] !== undefined && svc.readiness !== undefined) {
        console.error(`ow: --health conflicts with readiness: ${svc.name} (pick one)`)
        return 2
      }
    }
    if (waitMs !== undefined && svc.port === undefined && svc.readiness === undefined) {
      console.error(`ow: nothing to wait for: ${svc.name} (no port or probe declared)`)
      return 2
    }
  }
  const state = await readSupervisorState(paths.supervisorFile)
  const running = state?.services.find((entry) => entry.name === opts.service) ?? null
  const { diffService } = await import("./up-reconcile")
  const pre =
    opts.action === "down"
      ? { lines: [`to-stop: ${opts.service}${running ? ` pid=${running.pid}` : ""}`], diff: { status: running ? "running" : "missing" } }
      : diffService(svc, running, opts.action === "restart" ? "restart" : "up")
  if (!opts.json) for (const line of pre.lines) console.log(line)
  const { waitResult, writeRequest } = await import("./up-requests")
  let nonce: string
  try {
    nonce = await writeRequest(paths.requestsDir, opts.action, opts.service, opts.file)
  } catch (error) {
    console.error(`ow: request could not be written: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const result = await waitResult(paths.requestsDir, nonce)
  if (!result) {
    console.error("ow: request unanswered — verify with `ow ps`")
    return 1
  }
  // Single-service wait: the action already succeeded; readiness waits
  // one-shot for the target alone (same loop as bulk, target-only
  // record). --json merges into ONE object (existing keys unchanged) via
  // onPayload, which carries every verdict including vacuity — nothing
  // prints inside waitForUpReady, so the channel holds exactly one object.
  if (waitMs !== undefined && result.ok) {
    if (opts.json) {
      let verdict: WaitVerdict | null = null
      const code = await waitForUpReady({
        rootDir: opts.rootDir,
        services: [svc],
        timeoutMs: waitMs,
        json: true,
        health: waitHealth,
        runProbeFn: opts.runProbeFn,
        onPayload: (payload) => {
          verdict = payload
        },
      })
      const seen = verdict ?? { ready: false, services: [], noPort: [] }
      console.log(
        JSON.stringify({
          service: opts.service,
          action: opts.action,
          ...(result.pid !== undefined ? { pid: result.pid } : {}),
          diff: pre.diff,
          ready: seen.ready,
          services: seen.services,
          noPort: seen.noPort,
        }),
      )
      return code
    }
    return waitForUpReady({
      rootDir: opts.rootDir,
      services: [svc],
      timeoutMs: waitMs,
      json: false,
      health: waitHealth,
      runProbeFn: opts.runProbeFn,
    })
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        service: opts.service,
        action: opts.action,
        ...(result.pid !== undefined ? { pid: result.pid } : {}),
        diff: pre.diff,
        // Post-stop confirmation (down-only: the pre-shape `diff` above
        // goes stale once the process is gone, and down carries no
        // post-handle pid — unlike up/restart, whose result pid already
        // confirms post-state — so the confirmation + ps pointer below
        // close the loop instead).
        ...(opts.action === "down" ? { confirmed: { stopped: result.ok, code: result.code } } : {}),
        ...(result.ok ? {} : { code: result.code }),
      }),
    )
  } else if (result.ok) {
    console.log(result.message)
  } else {
    console.error(`ow: ${result.message}`)
  }
  if (opts.action === "down" && !opts.json) console.log(`follow-up: ow ps ${opts.service} (confirm state)`)
  if (result.ok) return 0
  if (result.code === "already-running" || result.code === "unknown-service" || result.code === "invalid-config") return 2
  return 1
}

/** Lock-less `down <svc>`: only the target pid is stopped (shared `stopOne`
 * guard) and the record is merge-marked; the lock file is never touched
 * and `supervisor.json` is never deleted (B5). `--rm` never reaches here
 * (single `down --rm` is exit 2 at the call site). */
export const runDirectSingleDown = async (rootDir: string, service: string, json: boolean): Promise<number> => {
  const { classifySupervisorFile, isLivePid, readSupervisorState, upPaths, warnWriteFailed } = await import("./up-state")
  const { persistMerged, stopOne } = await import("./up-supervisor")
  const paths = upPaths(rootDir)
  const fileStatus = await classifySupervisorFile(paths.supervisorFile)
  if (fileStatus === "corrupt") {
    console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
    return 1
  }
  if (fileStatus === "bad-version") {
    console.error("ow: unreadable: supervisor.json version mismatch — clean with `down --rm`")
    return 1
  }
  if (fileStatus === "missing") {
    console.error("ow: no processes to stop")
    return 2
  }
  const state = await readSupervisorState(paths.supervisorFile)
  const record = state?.services.find((entry) => entry.name === service)
  if (!record) {
    const known = (state?.services ?? []).map((entry) => entry.name).join(", ")
    console.error(`ow: unknown service: ${service}${known.length > 0 ? ` (known: ${known})` : ""}`)
    return 2
  }
  const outcome = await stopOne(record)
  if (outcome.stopped) {
    const fresh = await readSupervisorState(paths.supervisorFile)
    const entry = fresh?.services.find((candidate) => candidate.name === service)
    if (fresh && entry && entry.exitCode === undefined && entry.lstart !== "" && !(await isLivePid(entry.pid, entry.lstart))) {
      entry.exitCode = -1
      entry.exitedAt = new Date().toISOString()
      await persistMerged(paths.supervisorFile, fresh).catch((error) => warnWriteFailed("persist", error instanceof Error ? error.message : String(error)))
    }
  }
  if (!json) {
    console.log(`${outcome.stopped ? "stopped" : "will not stop"}: ${outcome.name} (${outcome.note})`)
  } else {
    console.log(JSON.stringify({ stopped: [outcome], warnings: [] }))
  }
  return outcome.stopped ? 0 : 1
}

const resolveSession = async (
  positional: string | undefined,
  logPath: string,
): Promise<string | null> => positional ?? (await latestSession(logPath))

/** Nested-state warning (basename check + ancestor scan): writers stay
 * put in rootDir, so a `.ow`-named root or an ancestor workspace means the
 * new state nests inside another world — readers walk up, writers do not.
 * Null when standalone. */
const nestedStateWarning = async (rootDir: string): Promise<string | null> => {
  if (basename(rootDir) === ".ow") return `warning: nested state dir: ${rootDir} is itself a .ow dir (writers stay put)`
  const { lstat } = await import("node:fs/promises")
  let dir = dirname(rootDir)
  for (let level = 0; level < 32; level += 1) {
    try {
      const info = await lstat(join(dir, ".ow"))
      if (info.isDirectory() && !info.isSymbolicLink()) {
        return `warning: nested state dir: ${join(rootDir, ".ow")} sits inside workspace ${dir} (writers stay put; readers walk up)`
      }
    } catch {
      // missing/unreadable here: keep walking outward
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

export const run = async (argv: string[]): Promise<number> => {
  if (argv[0] === "__supervise") {
    const fileIndex = argv.indexOf("--file")
    const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined
    if (!file || file.startsWith("--")) {
      console.error("ow: __supervise is for internal use (--file required)")
      return 2
    }
    const { runSuperviseFile } = await import("./up-supervisor-cli")
    return runSuperviseFile(file, { quiet: true })
  }
  const parsed = parseArgs(argv)
  if (parsed.flags["--help"] || parsed.command === null) {
    console.log(helpText())
    return parsed.command === null && !parsed.flags["--help"] ? 2 : 0
  }
  if (parsed.error) {
    console.error(`ow: ${parsed.error}`)
    console.error(helpText())
    return 2
  }
  const { command, sessionID: positional, flags } = parsed
  // P2-A: extra positionals belong to `checkpoints show <run>` and
  // `checkpoints diff <runA> <runB>` (M12), plus `scenario run <name>`
  // (M6, same subverb-plus-target shape).
  // M9: `--boundaries <path>` rides the value-flag slot and is consumed
  // only by the eight overlay readers below (scenarios, preflight,
  // readiness, provision, record, contract, scenario run, scenario env);
  // anywhere else it is a usage error (exit 2), never a silent no-op.
  // Single source: OVERLAY_READERS drives this guard, OVERLAY_READER_LABELS
  // the help line above and the refusal below.
  const boundariesFlag = flag(flags, "--boundaries")
  if (boundariesFlag !== undefined) {
    if (!(OVERLAY_READERS as readonly string[]).includes(command)) {
      console.error(`ow: --boundaries can only be used with ${OVERLAY_READER_LABELS.join(", ")}`)
      return 2
    }
  }
  // `--since` outside the eight readers refuses (exit 2), never a silent
  // no-op on any command (single source: SINCE_READERS drives this guard
  // and the help line above).
  if (flags["--since"] !== undefined && !(SINCE_READERS as readonly string[]).includes(command)) {
    console.error(`ow: --since can only be used with ${SINCE_READERS.join(", ")}`)
    return 2
  }
  // LOW-2: scenario-run flags outside `scenario run` refuse (exit 2), never
  // a silent no-op on any command (`scenario env` rejects them per-verb below).
  if ((flags["--run"] !== undefined || flags["--off-local"] === true) && command !== "scenario") {
    console.error("ow: --run/--off-local work only with scenario run")
    return 2
  }
  // Caller-claim flags belong to `record` only (same fail-loud
  // precedent: a narrowed flag elsewhere is a usage error, never silent).
  if ((flags["--claim-entrypoint"] !== undefined || flags["--claim-boundary"] !== undefined) && command !== "record") {
    console.error("ow: --claim-entrypoint/--claim-boundary work only with record")
    return 2
  }
  if (command !== "checkpoints" && command !== "scenario" && parsed.extra.length > 0) {
    console.error(`ow: unexpected argument: ${parsed.extra[0]}`)
    console.error(helpText())
    return 2
  }
  // M2: `--explain` renders only in `ps` (M-C precedent: unknown flags fail
  // loudly instead of silently doing nothing elsewhere).
  if (command !== "ps" && flags["--explain"] === true) {
    console.error("ow: --explain works only with ps")
    return 2
  }
  // M13: `--bundle`/`--out` belong only to `export` (same fail-loud
  // precedent: `ow down --bundle` must refuse, never stop services).
  if (command !== "export" && (flags["--bundle"] === true || flags["--out"] !== undefined)) {
    console.error("ow: --bundle/--out work only with export")
    return 2
  }
  // `--resume` renders only in `checkpoints show` (same fail-loud
  // precedent: a narrowed flag elsewhere is a usage error, never silent).
  if (flags["--resume"] === true && !(command === "checkpoints" && positional === "show")) {
    console.error("ow: --resume works only with checkpoints show")
    return 2
  }
  const dbPath = flag(flags, "--db") ?? DEFAULT_DB_PATH
  const logPath = flag(flags, "--log") ?? DEFAULT_LOG_PATH
  const json = flags["--json"] === true
  const warn = (message: string): void => {
    if (!json) console.error(message)
  }

  if (command === "doctor") {
    const { resolveWorkspaceRoot } = await import("./up-state")
    const upRoot =
      flag(flags, "--file") !== undefined ? upRootDir(flags) : await resolveWorkspaceRoot(process.cwd())
    const lines = await doctor({ logPath, dbPath, upRoot })
    const identity = await doctorIdentity({ upRoot })
    if (json) {
      console.log(JSON.stringify({ checks: lines, identity }))
    } else {
      console.log(formatDoctor(lines))
      for (const line of formatIdentity(identity)) console.log(line)
    }
    return doctorFails(lines) ? 1 : 0
  }

  if (command === "sessions") {
    const sinceRaw = flag(flags, "--since")
    const sinceMs = parseSince(sinceRaw)
    const window = sinceWindow(sinceRaw, sinceMs, Date.now())
    if (window !== null) warn(windowNotice(window))
    const sessions = await listSessions({
      logPath,
      dbPath: flag(flags, "--db"),
      sinceMs,
      dir: flag(flags, "--dir"),
    })
    if (json) {
      console.log(JSON.stringify(toSessionsJson(sessions, window)))
    } else {
      console.log(sessions.length > 0 ? formatSessions(sessions) : "no sessions")
    }
    return 0
  }

  if (command === "init") {
    if (positional !== undefined) {
      console.error("ow: init takes no positional arguments")
      return 2
    }
    const { runInit } = await import("./up-init")
    const result = await runInit({
      rootDir: typeof flags["--file"] === "string" ? dirname(resolve(flags["--file"] as string)) : process.cwd(),
      force: flags["--force"] === true,
      tracing: flags["--tracing"] === true,
    })
    if (result.stdout.length > 0) console.log(result.stdout)
    if (result.stderr.length > 0) console.error(result.stderr)
    return result.code
  }

  if (command === "up" || command === "restart" || command === "down" || command === "reconcile" || command === "checkpoints" || command === "preflight" || command === "readiness" || command === "provision" || command === "scenarios" || command === "ps" || command === "logs" || command === "trace" || command === "timeline" || command === "failures" || command === "record" || command === "contract" || command === "scenario" || command === "export") {
    // Readers walk upward to the enclosing workspace; bulk `up` (which
    // CREATES state, no positional) and any explicit --file stay exactly
    // where pointed. `--check` rides the `up` (creation-anchored) path: it
    // never walks. Single-service `up <svc>` walks like a reader: it must
    // find the live supervisor's root, never spawn a sibling world.
    const explicitFile = flag(flags, "--file") !== undefined
    const bulkUp = command === "up" && positional === undefined
    let rootDir = upRootDir(flags)
    if (!bulkUp && !explicitFile) {
      const { resolveWorkspaceRoot } = await import("./up-state")
      rootDir = await resolveWorkspaceRoot(process.cwd())
    }
    const stateDir = upStateDir(rootDir)
    const searchStart = process.cwd()
    const { noStateNote } = await import("./up-state")
    // State-root announce (writers only): the exact state dir on stderr,
    // suppressed under --json so stdout stays parse-clean. `up --check`
    // never writes and stays silent; scenario env only reads.
    const announcesStateDir =
      command === "restart" ||
      command === "down" ||
      command === "record" ||
      command === "contract" ||
      (command === "up" && flags["--check"] !== true) ||
      (command === "scenario" && positional === "run")
    if (announcesStateDir && !json) console.error(`state dir: ${stateDir}`)
    if (announcesStateDir) {
      const nested = await nestedStateWarning(rootDir)
      if (nested !== null) warn(nested)
    }
    // Config reads follow the same rule: explicit --file or bulk `up` read
    // the pointed/cwd file; single-service and reader commands without
    // --file read the walked root's file.
    const yamlForRead = explicitFile || bulkUp ? upFilePath(flags) : join(rootDir, "ow.yaml")
    if (command === "trace") {
      const { runTrace } = await import("./trace-cli")
      const tailFlag = flag(flags, "--tail")
      const serviceFlag = flag(flags, "--service")
      const waitFlag = flag(flags, "--wait")
      const minSpansFlag = flag(flags, "--min-spans")
      const result = await runTrace({
        rootDir,
        owYamlPath: yamlForRead,
        traceId: positional,
        tail: tailFlag === undefined ? undefined : Number(tailFlag),
        sinceMs: parseSince(flag(flags, "--since")),
        since: flag(flags, "--since"),
        service: serviceFlag,
        json,
        waitMs: waitFlag === undefined ? undefined : (parseWaitDuration(waitFlag) ?? undefined),
        minSpans: minSpansFlag === undefined ? undefined : Number(minSpansFlag),
        searchStart,
      })
      if (result.stdout.length > 0) console.log(result.stdout)
      if (result.stderr.length > 0) console.error(result.stderr)
      return result.code
    }
    if (command === "timeline") {
      const { runTimeline } = await import("./trace-timeline")
      const traceFlag = flag(flags, "--trace")
      const tailFlag = flag(flags, "--tail")
      const sid = await resolveSession(positional, logPath)
      const result = await runTimeline({
        rootDir,
        logPath,
        dbPath: flag(flags, "--db"),
        sessionID: sid ?? undefined,
        traceId: traceFlag,
        tail: tailFlag === undefined ? undefined : Number(tailFlag),
        sinceMs: parseSince(flag(flags, "--since")),
        since: flag(flags, "--since"),
        json,
      })
      if (result.stdout.length > 0) console.log(result.stdout)
      if (result.stderr.length > 0) console.error(result.stderr)
      return result.code
    }
    if (command === "up") {
      const file = upFilePath(flags)
      let text: string
      try {
        // Raw bytes + fatal decode (L2): undecodable config fails here with
        // a schema/encoding error (exit 2), never parsed with U+FFFD holes.
        text = decodeUtf8Fatal(readFileSync(file))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(`ow: ow.yaml not found: ${file}`)
        } else {
          console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
        }
        return 2
      }
      let parsed: ReturnType<typeof parseUpFile>
      try {
        parsed = parseUpFile(text)
      } catch (error) {
        console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
        // Polish (friction 2): the nesting trap bites hardest at validation
        // time — show the inline example only on the `--check` path.
        if (flags["--check"] === true && isSubsetNestingError(error)) console.error(subsetNestingHint)
        return 2
      }
      // `--probe` belongs to the witness verbs (reconcile, preflight,
      // readiness, provision): anywhere else it is a usage error (exit 2),
      // never a silent no-op. One guard covers bulk and single `up`.
      if (flags["--probe"] === true) {
        console.error("ow: --probe works only with reconcile, preflight, readiness, provision")
        return 2
      }
      if (positional !== undefined) {
        // M1 single-service `up`: live supervisor → request channel, then an
        // optional one-shot `--wait`/`--health` readiness wait for the target
        // alone (OW-012; same loop as bulk). `-d` stays ignored (no detach
        // on the request path). No live lock → classic bulk behavior
        // (plan M1), anchored at this root.
        if (flags["--check"] === true) {
          console.error("ow: --check cannot be used with a single service (validates the whole file)")
          return 2
        }
        if (flags["--health"] !== undefined && flags["--wait"] === undefined) {
          console.error("ow: --health works only with --wait (--wait <duration> required)")
          return 2
        }
        const single = await runSingleServiceRequest({
          rootDir,
          file: yamlForRead,
          action: "up",
          service: positional,
          json,
          wait: flag(flags, "--wait"),
          health: flags["--health"] as string | string[] | undefined,
        })
        if (single !== null) return single
        warn(`no live supervisor — bulk starting (requested: ${positional})`)
      }
      if (flags["--check"] === true && flags["--wait"] !== undefined) {
        console.error("ow: --wait cannot be used with --check (validation does not wait)")
        return 2
      }
      if (flags["--wait"] !== undefined && flags["--detach"] !== true) {
        console.error("ow: --wait works only with -d/--detach (preview)")
        return 2
      }
      const healthRaw = flags["--health"] as string | string[] | undefined
      if (healthRaw !== undefined && flags["--check"] === true) {
        console.error("ow: --health cannot be used with --check (validation does not wait)")
        return 2
      }
      if (healthRaw !== undefined && flags["--wait"] === undefined) {
        console.error("ow: --health works only with --wait (--wait <duration> required)")
        return 2
      }
      if (healthRaw !== undefined && flags["--detach"] !== true) {
        console.error("ow: --health works only with -d/--detach (preview)")
        return 2
      }
      let health: Record<string, string> = {}
      if (healthRaw !== undefined) {
        try {
          health = parseHealthFlags(healthRaw, parsed.services)
        } catch (error) {
          console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
          return 2
        }
      }
      // N5: a defined probe and --health cannot race on the same service (no two sources).
      for (const svc of parsed.services) {
        if (health[svc.name] !== undefined && svc.readiness !== undefined) {
          console.error(`ow: --health conflicts with readiness: ${svc.name} (pick one)`)
          return 2
        }
      }
      if (flags["--check"] === true) {
        for (const line of formatUpWarnings(parsed.warnings)) warn(line)
        const missing = missingRequiredEnv(parsed.services)
        if (missing.length > 0) {
          for (const entry of missing) {
            console.error(`ow: ${entry.service} missing required environment variables: ${entry.vars.join(", ")}`)
          }
          return 2
        }
        // Polish (friction 5): `--check` prints the resolved spawn order
        // (already topo-sorted by the parser) plus the order-only reminder.
        // Dep-less files keep exact YAML order — and byte-identical output,
        // since both lines print only when some service declares depends_on.
        const hasDeps = parsed.services.some((svc) => (svc.dependsOn?.length ?? 0) > 0)
        const order = parsed.services.map((svc) => svc.name)
        if (!json) {
          console.log(`ow.yaml valid: ${parsed.services.length} services (${order.join(", ")})`)
          if (hasDeps) {
            console.log(`start order: ${order.join(", ")}`)
            console.log(`depends_on does not gate (order-only)`)
          }
        } else {
          console.log(JSON.stringify({ file, services: toCheckServicesJson(parsed.services), warnings: parsed.warnings, ...(hasDeps ? { spawnOrder: order } : {}) }))
        }
        return 0
      }
      const missing = missingRequiredEnv(parsed.services)
      if (missing.length > 0) {
        for (const entry of missing) {
          console.error(`ow: ${entry.service} missing required environment variables: ${entry.vars.join(", ")}`)
        }
        return 2
      }
      const { classifyLock, ensureUpStateDir, upPaths } = await import("./up-state")
      const paths = upPaths(rootDir)
      try {
        await ensureUpStateDir(stateDir)
      } catch (error) {
        console.error(`ow: .ow unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      const status = await classifyLock(paths.lockFile)
      if (status.kind === "live") {
        console.error("ow: already running (ow ps)")
        return 2
      }
      if (status.kind === "unknown") {
        console.error(`ow: lock unverifiable (${status.reason}) — treated as running`)
        return 2
      }
      if (status.kind === "stale") warn(`warning: stale lock will be adopted (${status.reason})`)
      if (status.kind === "corrupt") warn(`warning: corrupt lock will be adopted (${status.reason})`)
      // Orphan probe (H6): lock says free but recorded children may still be
      // live from a crashed supervisor — refuse instead of duplicating them.
      // (Adoption is riskier: no shutdown wiring for foreign pids.)
      try {
        const { assertNoLiveOrphans } = await import("./up-supervisor")
        await assertNoLiveOrphans(rootDir)
      } catch (error) {
        console.error(`ow: ${maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
        return 2
      }
      if (flags["--detach"] === true) {
        const { detachSupervised } = await import("./up-supervisor-cli")
        const code = await detachSupervised(file, rootDir)
        if (code !== 0) return code
        const waitFlag = flag(flags, "--wait")
        if (waitFlag === undefined) return 0
        return waitForUpReady({ rootDir, services: parsed.services, timeoutMs: parseWaitDuration(waitFlag) ?? 0, json, health })
      }
      const { runSuperviseFile } = await import("./up-supervisor-cli")
      return runSuperviseFile(file)
    }
    // `--probe` belongs to the witness verbs: `ps`/`logs` reject it before
    // the honest-empty branch (exit 2 with or without state), matching the
    // `up`/`down`/`checkpoints` guards below.
    if ((command === "ps" || command === "logs") && flags["--probe"] === true) {
      console.error("ow: --probe works only with reconcile, preflight, readiness, provision")
      return 2
    }
    // `restart`/`reconcile`/single-service `down` produce their own honest
    // exit even without a state directory (no-lock restart exit 2, reconcile
    // missing exit 1, single `down --rm` usage error) — the early empty branch
    // belongs only to bulk `down` and the classic readers.
    const earlyEmpty = (command === "down" && positional === undefined) || command === "ps" || command === "logs"
    if (!existsSync(stateDir) && earlyEmpty) {
      if (command === "down") {
        console.error(`ow: no processes to stop (${noStateNote(searchStart)})`)
        return 2
      }
      if (command === "ps") {
        if (json) console.log(JSON.stringify({ services: [] }))
        else console.log(`no state ${storeWindow(stateDir, null)} (${noStateNote(searchStart)})`)
        return 0
      }
      const service = positional ?? null
      if (json) console.log(JSON.stringify({ service, lines: [] }))
      else {
        const logsWindow = sinceWindow(flag(flags, "--since"), parseSince(flag(flags, "--since")), Date.now())
        console.log(`no log ${storeWindow(stateDir, logsWindow)} (${noStateNote(searchStart)})`)
      }
      return 0
    }
    if (command === "down") {
      if (flags["--probe"] === true) {
        console.error("ow: --probe works only with reconcile, preflight, readiness, provision")
        return 2
      }
      if (positional !== undefined && flags["--rm"] === true) {
        console.error("ow: --rm works only with bulk down (single service `down <name> --rm` exits 2)")
        return 2
      }
      if (positional !== undefined) {
        const single = await runSingleServiceRequest({ rootDir, file: yamlForRead, action: "down", service: positional, json })
        // `down` never falls back to bulk: null is unreachable here.
        return single ?? 2
      }
      const { classifySupervisorFile, upPaths } = await import("./up-state")
      const { downAll } = await import("./up-supervisor")
      const rm = flags["--rm"] === true
      if (!rm) {
        const fileStatus = await classifySupervisorFile(upPaths(rootDir).supervisorFile)
        if (fileStatus === "corrupt") {
          console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
          return 1
        }
        if (fileStatus === "bad-version") {
          console.error("ow: unreadable: supervisor.json version mismatch — clean with `down --rm`")
          return 1
        }
      }
      const outcome = await downAll(rootDir, rm)
      for (const line of outcome.warnings) warn(line)
      if (outcome.results.length === 0) {
        if (outcome.clearedLock) {
          if (!json) console.log("lock cleared")
          else console.log(JSON.stringify({ stopped: [], warnings: outcome.warnings }))
          return 0
        }
        if (outcome.removedState) {
          if (!json) console.log("cleared")
          else console.log(JSON.stringify({ stopped: [], warnings: outcome.warnings }))
          return 0
        }
        console.error("ow: no processes to stop")
        return 2
      }
      if (!json) {
        for (const result of outcome.results) {
          console.log(`${result.stopped ? "stopped" : "will not stop"}: ${result.name} (${result.note})`)
        }
      } else {
        console.log(JSON.stringify({ stopped: outcome.results, warnings: outcome.warnings }))
      }
      return outcome.results.every((result) => result.stopped) ? 0 : 1
    }
    if (command === "restart") {
      if (positional === undefined) {
        console.error("ow: restart expects a service name (e.g. ow restart api)")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--detach", "--probe"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with restart`)
          return 2
        }
      }
      const single = await runSingleServiceRequest({
        rootDir,
        file: yamlForRead,
        action: "restart",
        service: positional,
        json,
        wait: flag(flags, "--wait"),
        health: flags["--health"] as string | string[] | undefined,
      })
      return single ?? 2
    }
    if (command === "reconcile") {
      if (positional !== undefined) {
        console.error("ow: reconcile takes no positional arguments (--check suffices)")
        return 2
      }
      if (flags["--check"] !== true) {
        console.error("ow: use reconcile with --check (read-only report, no mutation)")
        return 2
      }
      // M3: `--probe`-flagged reconcile runs defined probes client-side
      // one-shot (M1 N3 budget); it never mutates, exit follows drift.
      const { runReconcileCheck } = await import("./up-reconcile")
      return runReconcileCheck({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true })
    }
    if (command === "checkpoints") {
      // P2-A: runner-writes/ow-reads; read-only, no mutation, no live exec.
      if (flags["--probe"] === true) {
        console.error("ow: --probe works only with reconcile, preflight, readiness, provision")
        return 2
      }
      const { runCheckpointsDiff, runCheckpointsList, runCheckpointsShow } = await import("./up-checkpoints")
      if (positional === undefined || (positional !== "list" && positional !== "show" && positional !== "diff")) {
        console.error("ow: checkpoints list|show|diff expected (e.g. ow checkpoints show <run>)")
        return 2
      }
      if (positional === "list") {
        if (parsed.extra.length > 0) {
          console.error(`ow: unexpected argument: ${parsed.extra[0]}`)
          return 2
        }
        return runCheckpointsList({ rootDir, json })
      }
      if (positional === "show") {
        if (parsed.extra.length !== 1) {
          console.error(
            parsed.extra.length === 0 ? "ow: checkpoints show expects a run name (e.g. ow checkpoints show <run>)" : `ow: unexpected argument: ${parsed.extra[1]}`,
          )
          return 2
        }
        return runCheckpointsShow({ rootDir, run: parsed.extra[0], json, resume: flags["--resume"] === true })
      }
      if (parsed.extra.length !== 2) {
        console.error(
          parsed.extra.length < 2
            ? "ow: checkpoints diff expects two run names (e.g. ow checkpoints diff <runA> <runB>)"
            : `ow: unexpected argument: ${parsed.extra[2]}`,
        )
        return 2
      }
      return runCheckpointsDiff({ rootDir, runA: parsed.extra[0], runB: parsed.extra[1], json })
    }
    if (command === "failures") {
      // M-D: read-only mechanical finding list — no exec/prune, exit 0
      // except corrupt-only evidence (exit 1); usage errors exit 2.
      // --since outside the locked set is 2.
      if (positional !== undefined) {
        console.error("ow: failures takes no positional arguments")
        return 2
      }
      const { runFailures } = await import("./up-failures")
      return runFailures({ rootDir, since: flags["--since"], json })
    }
    if (command === "preflight") {
      // P2-B: read-only gate — spawn/stop/restart/probe/health/git/lsof are
      // not called (unflagged); `--probe` only adds one-shot loopback TCP for
      // declared ports (budgeted). Here `--probe` is not the M3 flag, it is the
      // gate's own live-confirmation path.
      if (positional !== undefined) {
        console.error("ow: preflight takes no positional arguments")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with preflight`)
          return 2
        }
      }
      const { runPreflight } = await import("./up-preflight")
      return runPreflight({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true, boundariesFlag })
    }
    if (command === "readiness") {
      // M2: boundary-witnessed readiness - full preflight composition
      // (4 gates) + digest/migration report. Read-only; `--probe` is
      // one-shot loopback TCP on declared ports only (M1 N3 budget).
      if (positional !== undefined) {
        console.error("ow: readiness takes no positional arguments")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with readiness`)
          return 2
        }
      }
      const { runReadiness } = await import("./up-preflight")
      return runReadiness({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true, boundariesFlag })
    }
    if (command === "provision") {
      // Worktree checklist: witness-only, never gates up/ps/reconcile/
      // preflight (those paths are untouched). `--check` required, bare
      // `provision` is a usage error (exit 2).
      if (positional !== undefined) {
        console.error("ow: provision takes no positional arguments (ow provision --check [--file])")
        return 2
      }
      if (flags["--check"] !== true) {
        console.error("ow: provision --check is required (read-only checklist, no mutation)")
        return 2
      }
      for (const unsupported of ["--rm", "--wait", "--health", "--detach"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with provision`)
          return 2
        }
      }
      const { runProvisionCheck } = await import("./up-provision")
      return runProvisionCheck({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true, boundariesFlag })
    }
    if (command === "scenarios") {
      // Scenario validator: read-only (runs no probe, no exec). `--file`
      // points at the scenario file (default <root>/ow.scenarios.yaml);
      // service references resolve against the same root's ow.yaml.
      if (positional !== undefined) {
        console.error("ow: scenarios takes no positional arguments")
        return 2
      }
      if (flags["--check"] !== true) {
        console.error("ow: use scenarios with --check (read-only validation, no runs)")
        return 2
      }
      for (const unsupported of ["--probe", "--wait", "--health", "--detach", "--rm"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with scenarios`)
          return 2
        }
      }
      const { runScenariosCheck, SCENARIOS_FILE_NAME } = await import("./up-scenarios")
      const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
      return runScenariosCheck({ file: scenariosFile, rootDir, json, boundariesFlag })
    }
    if (command === "record") {
      // M5: run-name-singular capture - the positional names the scenario.
      // Human-only output (no `--json` on this verb); probes run bounded
      // one-shot, nothing else executes. (Second positionals never reach
      // here: rejected globally above.)
      if (positional === undefined) {
        console.error("ow: use as record <scenario-name> [--file] (single positional)")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach", "--probe", "--json"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with record`)
          return 2
        }
      }
      const { runRecord } = await import("./up-replay")
      const { SCENARIOS_FILE_NAME } = await import("./up-scenarios")
      const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
      return runRecord({
        rootDir,
        file: scenariosFile,
        runName: positional,
        boundariesFlag,
        claimEntrypoint: flag(flags, "--claim-entrypoint"),
        claimBoundary: flags["--claim-boundary"] as string | string[] | undefined,
      })
    }
    if (command === "contract") {
      // M5: digest-compare + ship-order gate. `check` is the only second
      // word (first-positional slot); pure witness, no exec on this verb.
      if (positional !== "check") {
        console.error("ow: use as contract check [--file] [--json]")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach", "--probe"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} cannot be used with contract`)
          return 2
        }
      }
      const { runContractCheck } = await import("./up-contract")
      const { SCENARIOS_FILE_NAME } = await import("./up-scenarios")
      const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
      return runContractCheck({ rootDir, file: scenariosFile, json, boundariesFlag })
    }
    if (command === "scenario") {
      // M6: narrowed deterministic run — `run` subverb in the sessionID
      // slot, scenario name in extra (checkpoints-shape precedent). Runner
      // owns restore exec; `ow` spawns declared probes only.
      // M10: `env` subverb renders the decided boundary matrix as
      // eval-clean `OW_BOUNDARY_*` lines (read-only, never spawns).
      if (positional === "run" && parsed.extra.length === 1) {
        for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach", "--probe", "--tracing", "--force"]) {
          if (flags[unsupported] !== undefined) {
            console.error(`ow: ${unsupported} cannot be used with scenario run`)
            return 2
          }
        }
        const runId = flag(flags, "--run")
        if (runId !== undefined) {
          const { isValidRunName } = await import("./up-checkpoints")
          if (!isValidRunName(runId)) {
            console.error(`ow: invalid run id: ${runId}`)
            return 2
          }
        }
        const { runScenarioRun } = await import("./up-scenario-run")
        const { SCENARIOS_FILE_NAME } = await import("./up-scenarios")
        const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
        return runScenarioRun({
          rootDir,
          file: scenariosFile,
          name: parsed.extra[0],
          runId,
          offLocal: flags["--off-local"] === true,
          json,
          boundariesFlag,
        })
      }
      if (positional === "env" && parsed.extra.length === 1) {
        for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach", "--probe", "--tracing", "--force", "--run", "--off-local"]) {
          if (flags[unsupported] !== undefined) {
            console.error(`ow: ${unsupported} cannot be used with scenario env`)
            return 2
          }
        }
        const { runScenarioEnv } = await import("./up-scenario-env")
        const { SCENARIOS_FILE_NAME } = await import("./up-scenarios")
        const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
        return runScenarioEnv({ rootDir, file: scenariosFile, name: parsed.extra[0], json, boundariesFlag })
      }
      console.error("ow: use as scenario run <name> [--file] [--json] [--run <id>] [--off-local]")
      return 2
    }
    if (command === "ps") {
      if (flags["--explain"] === true) {
        const { runPsExplain } = await import("./up-ps")
        return runPsExplain({ rootDir, file: yamlForRead, ...(positional === undefined ? {} : { service: positional }), json })
      }
      const { formatPsLine, queryPs, toPsServiceJson } = await import("./up-ps")
      let services: Awaited<ReturnType<typeof queryPs>>
      try {
        services = await queryPs(rootDir)
      } catch (error) {
        console.error(`ow: ${maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
        return 1
      }
      if (!json) {
        console.log(services.length > 0 ? services.map(formatPsLine).join("\n") : "no state")
      } else {
        console.log(JSON.stringify({ services: services.map(toPsServiceJson) }))
      }
      return 0
    }
    if (command === "logs") {
      const tail = Number(flag(flags, "--tail") ?? 200)
      const grep = flag(flags, "--grep")
      const sinceMs = parseSince(flag(flags, "--since"))
      const logsWindow = sinceWindow(flag(flags, "--since"), sinceMs, Date.now())
      if (logsWindow !== null) warn(windowNotice(logsWindow))
      const { classifySupervisorFile, upPaths } = await import("./up-state")
      const fileStatus = await classifySupervisorFile(upPaths(rootDir).supervisorFile)
      if (fileStatus === "corrupt" || fileStatus === "bad-version") {
        console.error("ow: supervisor state corrupt — clean with ow down --rm")
        return 1
      }
      let names: string[] = []
      try {
        names = parseUpFile(readFileSync(yamlForRead, "utf8")).services.map((svc) => svc.name)
      } catch {
        const { readSupervisorState } = await import("./up-state")
        const state = await readSupervisorState(upPaths(rootDir).supervisorFile)
        names = state?.services.map((svc) => svc.name) ?? []
      }
      if (positional !== undefined && !names.includes(positional)) {
        console.error(`ow: unknown service: ${positional}${names.length > 0 ? ` (${names.join(", ")})` : ""}`)
        return 2
      }
      const { queryLogs, UP_LOG_MAX_FILES } = await import("./up-logs")
      let result: Awaited<ReturnType<typeof queryLogs>>
      try {
        result = await queryLogs({ logsDir: join(stateDir, "logs"), service: positional, tail, grep, sinceMs })
      } catch (error) {
        console.error(`ow: log unreadable: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      const rows = result.rows
      // G12 log-omit notice: capped output names what was left out.
      const omitBits: string[] = []
      if (result.omittedRows > 0) omitBits.push(`${result.omittedRows} older rows (raise --tail)`)
      if (result.omittedFiles > 0) omitBits.push(`${result.omittedFiles} service files (cap ${UP_LOG_MAX_FILES})`)
      if (!json) {
        if (rows.length === 0) {
          console.log("no log")
        } else {
          for (const row of rows) console.log(`[${row.service}|${row.stream}] ${row.line}`)
        }
        if (omitBits.length > 0) console.log(`(omitted: ${omitBits.join("; ")})`)
      } else {
        console.log(JSON.stringify({ service: positional ?? null, lines: rows, omittedRows: result.omittedRows, omittedFiles: result.omittedFiles, window: logsWindow }))
      }
      return 0
    }
    if (command === "export") {
      // M13: read-only bundle composition of existing readers. Only
      // --file/--out/--bundle (+ global --db/--log/--help) belong here;
      // anything else is a usage error, never a silent no-op.
      if (flags["--bundle"] !== true) {
        console.error("ow: export needs --bundle (e.g. ow export --bundle [<run>] [--out <path>])")
        return 2
      }
      for (const key of Object.keys(flags)) {
        if (!["--file", "--out", "--bundle", "--help", "--db", "--log"].includes(key)) {
          console.error(`ow: ${key} cannot be used with export`)
          return 2
        }
      }
      const { runExport } = await import("./up-export")
      return runExport({
        rootDir,
        file: yamlForRead,
        ...(positional === undefined ? {} : { run: positional }),
        ...(flag(flags, "--out") === undefined ? {} : { out: flag(flags, "--out") as string }),
      })
    }
  }

  const sid = await resolveSession(positional, logPath)
  if (!sid) {
    console.error("session not found")
    return 2
  }

  if (command === "meta") {
    const result = await sessionMeta({ dbPath, sessionID: sid })
    if (result.warning) warn(`warn: ${result.warning}`)
    if (!result.meta) return 1
    console.log(json ? JSON.stringify({ meta: result.meta, warning: result.warning }) : formatMeta(result.meta))
    return 0
  }

  if (command === "prompts") {
    const prompts = await sessionPrompts({ dbPath, sessionID: sid })
    if (json) {
      console.log(JSON.stringify({ session: sid, prompts }))
    } else if (prompts.length > 0) {
      prompts.forEach((p, i) => console.log(`[${i + 1}] ${p}`))
    } else {
      console.log("no prompts")
    }
    return 0
  }

  const treeMode = flags["--tree"] === true
  const windowMs = parseSince(flag(flags, "--since"))
  // One per-verb cutoff notice for the joined readers (human only via
  // warn; stuck/show/reads share this region).
  const window = sinceWindow(flag(flags, "--since"), windowMs, Date.now())
  if (window !== null) warn(windowNotice(window))

  if (command === "stuck") {
    let records: EnrichedRecord[]
    if (treeMode) {
      const { by, warnings, childCount } = await loadTreeRecords({ dbPath: flag(flags, "--db"), logPath, sessionID: sid, sinceMs: windowMs })
      if (childCount > 0) warn(`tree: ${childCount + 1} sessions (${childCount} children)`)
      for (const w of warnings) warn(`warn: ${w}`)
      records = [...by.values()].flat()
    } else {
      const r = await joinSession({ sessionID: sid, dbPath: flag(flags, "--db"), logPath, sinceMs: windowMs })
      for (const w of r.warnings) warn(`warn: ${w}`)
      records = r.records
    }
    const windowed = filterSince(records, windowMs)
    const report = await stuckReport({ records: windowed, dbPath: flag(flags, "--db"), sessionID: sid })
    console.log(json ? JSON.stringify(toStuckJson(sid, report, window)) : formatStuck(report))
    return 0
  }

  // show + reads share the joined records
  let by: Map<string, EnrichedRecord[]>
  let warnings: string[]
  if (treeMode) {
    const { by: loaded, warnings: treeWarnings, childCount } = await loadTreeRecords({ dbPath: flag(flags, "--db"), logPath, sessionID: sid, sinceMs: windowMs })
    if (childCount > 0) warn(`tree: ${childCount + 1} sessions (${childCount} children)`)
    by = loaded
    warnings = treeWarnings
  } else {
    const r = await joinSession({ sessionID: sid, dbPath: flag(flags, "--db"), logPath, sinceMs: windowMs })
    by = new Map([[sid, r.records]])
    warnings = r.warnings
  }
  for (const w of warnings) warn(`warn: ${w}`)
  const kind = flag(flags, "--kind")
  const tool = flag(flags, "--tool")
  const filtered = new Map<string, EnrichedRecord[]>()
  for (const [id, recs] of by) filtered.set(id, filterTools(filterSince(recs, windowMs), kind, tool))
  const merged = [...filtered.values()].flat()

  if (command === "reads") {
    const stats = readDigest(merged)
    if (json) {
      console.log(JSON.stringify({ session: sid, reads: stats, window }))
    } else {
      const text = formatReads(stats)
      console.log(text.length > 0 ? text : "no read records")
    }
    return 0
  }

  // show
  const full = flags["--full"] === true
  const sectionBudget = parseBytes(flag(flags, "--bytes")) ?? undefined
  const showRef = flag(flags, "--show")
  const showFails = flags["--show-fails"] === true
  const flat = flags["--flat"] === true
  const groups = groupByTask(merged)

  if (showRef) {
    const text = showLine(groups, Number(showRef), sectionBudget)
    console.log(json ? JSON.stringify({ session: sid, detail: text }) : text)
    return 0
  }
  if (showFails) {
    const out: string[] = []
    for (const group of groups) {
      for (const line of group.lines) {
        if (line.outcome !== "failure" && line.outcome !== "error") continue
        out.push(showLine([group], line.ref, sectionBudget))
      }
    }
    if (out.length > 0) {
      const text = out.join("\n")
      console.log(json ? JSON.stringify({ session: sid, detail: text }) : text)
    } else {
      warn("no failed lines")
    }
    return 0
  }
  if (flat) {
    for (const record of merged) console.log(JSON.stringify(record))
    return 0
  }
  if (treeMode) {
    if (json) {
      console.log(JSON.stringify(toShowJson(sid, warnings, groups, treeIds(buildTree(sid, filtered)), window)))
    } else {
      const text = formatTree(buildTree(sid, filtered), filtered, { full, sectionBudget })
      // Honest empty (grouped/tree only — --flat streams records, never a line).
      if (text.length > 0) console.log(text)
      else console.log(`no records ${storeWindow(logPath, window)}`)
      if (full) warn(`(full text: ${text.length} chars)`)
    }
    return 0
  }
  const text = formatGrouped(groups, full, false, sectionBudget)
  if (json) {
    console.log(JSON.stringify(toShowJson(sid, warnings, groups, undefined, window)))
  } else {
    if (text.length > 0) console.log(text)
    else console.log(`no records ${storeWindow(logPath, window)}`)
    if (full) warn(`(full text: ${text.length} chars)`)
  }
  return 0
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
