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
  stuckReport,
  type EnrichedRecord,
} from "./join"
import { doctor, formatDoctor } from "./doctor"
import { buildTree, formatTree, loadTreeRecords, treeIds } from "./tree"
import { parseWaitDuration } from "./trace-cli"
import { decodeUtf8Fatal, formatUpWarnings, isSubsetNestingError, missingRequiredEnv, parseUpFile, PROBE_TIMEOUT_MS, subsetNestingHint } from "./up-schema"
import { isSecretFlagToken, maskCmdShape, maskSecretToken } from "./up-reconcile"
import type { UpService } from "./up-schema"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const COMMANDS = ["doctor", "sessions", "show", "stuck", "meta", "prompts", "reads", "up", "restart", "down", "reconcile", "ps", "logs", "trace", "timeline", "init", "checkpoints", "preflight", "scenarios"] as const
export type Command = (typeof COMMANDS)[number]
const ALIASES: Record<string, Command> = { list: "sessions" }

const VALUE_FLAGS = new Set(["--db", "--log", "--since", "--dir", "--kind", "--tool", "--show", "--bytes", "--file", "--tail", "--grep", "--service", "--wait", "--health", "--trace", "--min-spans"])
const BOOL_FLAGS = new Set(["--json", "--full", "--tree", "--flat", "--show-fails", "--help", "-h", "--check", "--detach", "--rm", "--force", "--tracing", "--probe", "--explain"])

export type ParsedArgs = {
  command: Command | null
  sessionID: string | undefined
  /** `--health` is repeatable and accumulates into a string array; every
   * other value flag holds a single string. */
  flags: Record<string, string | boolean | string[]>
  error: string | null
  /** Second and later positionals (`checkpoints show <run>`). Any other
   * command rejects them with the pre-existing usage error. */
  extra: string[]
}

export const helpText = (): string =>
  [
    "ow — shell-observer komut satırı (salt-okunur, etkileşimsiz)",
    "",
    "kullanım: ow <komut> [oturum] [seçenekler]",
    "",
    "komutlar:",
    "  doctor                        sağlık: log/kanca/halka/db/up",
    "  sessions [--since] [--dir]    oturum listesi (id, sayı, aralık, dizin)",
    "  show [oturum] [--since] [--full] [--bytes] [--tree] [--kind ..] [--tool ..] [--show N] [--show-fails]",
    "                                görev özeti; --tree altgörev ağacı",
    "  stuck [oturum] [--since] [--tree]  tıkanma raporu (birleşik kayıtlar)",
    "  meta [oturum]                 maliyet/token/değişiklik/tur",
    "  prompts [oturum]              son 20 kullanıcı yönergesi (eskiden yeniye)",
    "  reads [oturum] [--since]      okuma özeti",
    "  up [servis] [--file] [--check] [-d|--detach] [--wait 120s] [--health svc=/yol]  servisleri kaldır (ow.yaml); --check yalnız doğrular;",
  "                                -d ile --wait: bildirilen portlar açılana kadar bekle (çıkış: hazır değilse 1);",
  "                                --health <ad>=<yol> (tekrarlanabilir, yalnız --wait ile): o servis TCP sonrası HTTP 2xx bekler",
  "                                tek servis (up <ad>): canlı supervisora istekle eklenir, sağlıklılar etkilenmez",
    "  restart <servis> [--file]   canlı supervisorda tek servisi yeniden başlat (kilit yoksa çıkış 2)",
    "  down [servis] [--file] [--rm]  servisleri durdur (--rm yalnız toplu down ile; tek serviste çıkış 2)",
    "  reconcile --check [--json] [--probe] [--file]  salt-okunur drift raporu (mutasyon yok; çıkış 1 drift, 0 uyumlu)",
    "  ps [--file]                   servis durumu (pid, süre, cpu, bellek, port, listen)",
    "  ps --explain [servis] [--file] [--json]  beklenen/çalışan tanık görünümü (salt-okunur)",
    "  logs [servis] [--file] [--tail] [--grep] [--since]  servis logları",
    "  checkpoints list [--file] [--json]  kayıtlı kanıt koşuları (salt-okunur)",
    "  checkpoints show <run> [--file] [--json]  zarfları doğrulanmış/bayat/gözlenmedi dilinde gösterir",
    "  preflight [--file] [--json] [--probe]  salt-okunur kapı (mutasyon yok; geçemezse çıkış 1)",
    "  scenarios --check [--file] [--json]  ow.scenarios.yaml v1 şema doğrulama (çalıştırma yok)",
    "  trace [iz] [--file] [--tail] [--since] [--service] [--wait] [--min-spans]  izlemeler; iz ile tek ağaç; --wait 15s yeni span bekler",
  "  timeline [oturum] [--trace] [--since] [--tail]  ajan satırları + izleme spanları birleşik zaman çizelgesi",
  "  init [--force] [--tracing]  repo taramasıyla başlangıç ow.yaml iskeleti (--force tek ow.yaml.bak tutar)",
    "",
    "genel: --db <yol> --log <yol> --json --help",
    "  --since  pencere: 30m|3h|1d|1w (varsayılan 1d; sessions/show/stuck/reads)",
    "  --json  makine çıktısı (İngilizce anahtarlar): show/stuck/meta/sessions/reads/prompts/ps/logs/down/trace",
    "çıkış: 0 ok, 1 yapısal hata, 2 kullanım hatası",
    "",
    "örnek: ow show <oturum> --tree --since 1d",
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
        if (value === undefined || value.startsWith("--")) return fail(`değer bekleniyor: ${arg}`)
        if (arg === "--health") {
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
      return fail(`bilinmeyen seçenek: ${arg}`)
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
    if (command === "checkpoints") {
      extra.push(arg)
      continue
    }
    return fail(`beklenmeyen argüman: ${arg}`)
  }
  if (flags["--help"]) return { command, sessionID, flags, error: null, extra }
  if (!command) return fail("komut bekleniyor: doctor|sessions|show|stuck|meta|prompts|reads|up|down|ps|logs|trace|timeline|init (--help)")
  const since = typeof flags["--since"] === "string" ? parseSince(flags["--since"]) : undefined
  if (typeof flags["--since"] === "string" && since === null) return fail(`geçersiz --since: ${flags["--since"]} (30m|3h|1d|1w)`)
  const bytes = typeof flags["--bytes"] === "string" ? parseBytes(flags["--bytes"]) : undefined
  if (typeof flags["--bytes"] === "string" && bytes === null) return fail(`geçersiz --bytes: ${flags["--bytes"]} (512|1k|4k|1m)`)
  if (typeof flags["--show"] === "string" && !Number.isFinite(Number(flags["--show"]))) {
    return fail(`geçersiz --show: ${flags["--show"]} (satır no bekleniyor)`)
  }
  if (typeof flags["--tail"] === "string") {
    const tail = Number(flags["--tail"])
    if (!Number.isInteger(tail) || tail < 1 || tail > 5000) return fail(`geçersiz --tail: ${flags["--tail"]} (1-5000 bekleniyor)`)
  }
  if (typeof flags["--min-spans"] === "string") {
    const minSpans = Number(flags["--min-spans"])
    if (!Number.isInteger(minSpans) || minSpans < 1 || minSpans > 5000) return fail(`geçersiz --min-spans: ${flags["--min-spans"]} (1-5000 bekleniyor)`)
  }
  if (typeof flags["--wait"] === "string" && parseWaitDuration(flags["--wait"]) === null) {
    return fail(`geçersiz --wait: ${flags["--wait"]} (ör. 15s, en fazla 5m)`)
  }
  if (typeof flags["--grep"] === "string" && flags["--grep"].length > 256) {
    return fail("geçersiz --grep: en fazla 256 karakter")
  }
  return { command, sessionID, flags, error: null, extra }
}

// --json envelopes: stable English keys; human views keep Turkish labels.
export const toSessionsJson = (sessions: Awaited<ReturnType<typeof listSessions>>) => ({ sessions })
export const toShowJson = (
  sessionID: string,
  warnings: string[],
  groups: ReturnType<typeof groupByTask>,
  tree?: ReturnType<typeof treeIds>,
) => (tree ? { session: sessionID, warnings, groups, tree } : { session: sessionID, warnings, groups })
export const toStuckJson = (sessionID: string, report: Awaited<ReturnType<typeof stuckReport>>) => ({
  session: sessionID,
  report,
})

/** `doctor` exit rule: `up` and `trace` lines are informational only. */
export const doctorFails = (lines: { name: string; ok: boolean }[]): boolean =>
  lines.filter((l) => l.name !== "up" && l.name !== "trace").some((l) => !l.ok)

/** Supervisor root: --file dizini ya da cwd; state/logs <root>/.ow altında. */
export const upRootDir = (flags: Record<string, string | boolean | string[]>): string => {
  const file = flag(flags, "--file")
  return file ? dirname(resolve(file)) : process.cwd()
}
export const upFilePath = (flags: Record<string, string | boolean | string[]>): string => {
  const file = flag(flags, "--file")
  return file ? resolve(file) : join(process.cwd(), "ow.yaml")
}
export const upStateDir = (rootDir: string): string => join(rootDir, ".ow")

/** `ow up -d --wait <süre> [--health <ad>=<yol> ...]`: block until every
 * declared `port` accepts a TCP connection, a service exits, or the window
 * elapses. A service named in `health` additionally waits for HTTP 2xx on
 * `http://127.0.0.1:<port><yol>` after its TCP gate (unflagged services keep
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

export const waitForUpReady = async (opts: {
  rootDir: string
  services: UpService[]
  timeoutMs: number
  json: boolean
  health?: Record<string, string>
  /** Injected project-probe runner (default: real `runProbe`). Tests pass a
   * fake; the throttle below bounds how often it fires per target. */
  runProbeFn?: import("./up-probe").ProbeFn
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
    if (opts.json) console.log(JSON.stringify({ ready: true, services: [], noPort, note: "port tanımlı servis yok" }))
    else console.log("beklenecek port yok (servislerde port tanımlı değil)")
    return 0
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
      }).catch((): import("./up-probe").ProbeOutcome => ({ ok: false, note: "çalıştırılamadı", timedOut: false, code: null }))
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
    return { kind: "probe", ok: false, note: "ölçülmedi", waitedSec: result.waitedSec }
  }
  const ready = results.every((result) => result.status === "ready")
  const where = (result: { port?: number; healthPath?: string }): string =>
    result.port === undefined ? "" : result.healthPath === undefined ? `:${result.port}` : `:${result.port}${result.healthPath}`
  const withReadiness = results.map((result) => {
    const readiness = readinessOf(result)
    return { ...result, ...(readiness === undefined ? {} : { readiness }) }
  })
  if (opts.json) {
    console.log(JSON.stringify({ ready, services: withReadiness, noPort }))
  } else {
    for (const result of withReadiness) {
      const readiness = (result as { readiness?: WaitReadiness }).readiness
      if (result.status === "ready") console.log(`hazır: ${result.name}${where(result)} (${result.waitedSec}sn)`)
      else if (result.status === "exited") console.log(`bitti: ${result.name} (çıkış kodu ${result.exitCode ?? "?"}) — ow logs ${result.name}`)
      else if (readiness?.kind === "probe") console.log(`hazır değil: ${result.name} (probe: ${readiness.note ?? "hazır değil"})`)
      else console.log(`zaman aşımı: ${result.name}${where(result)} (${result.waitedSec}sn)`)
    }
    if (noPort.length > 0) console.log(`port tanımsız (beklenmedi): ${noPort.join(", ")}`)
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
        if (readiness?.kind !== "probe" || readiness.note === "ölçülmedi") continue
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
              if (!opts.json) console.error(`uyarı: readiness kaydı doğrulanamadı: ${svc.name}`)
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

/** Parse repeatable `--health <ad>=<yol>` values into a service→path map
 * (last wins per service; one occurrence may hold comma-separated pairs).
 * Throws a Turkish usage error when an entry lacks `=`, the path does not
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
    if (eq <= 0 || eq === entry.length - 1) throw new Error(`geçersiz --health: ${entry} (<hizmet>=<yol> bekleniyor)`)
    const name = entry.slice(0, eq).trim()
    const path = entry.slice(eq + 1).trim()
    if (!path.startsWith("/")) throw new Error(`geçersiz --health: ${entry} (yol / ile başlamalı)`)
    const svc = services.find((s) => s.name === name)
    if (!svc) {
      const known = services.map((s) => s.name).join(", ")
      throw new Error(`bilinmeyen servis: ${name} (--health${known.length > 0 ? `; bilinenler: ${known}` : ""})`)
    }
    if (svc.port === undefined) throw new Error(`--health portsuz serviste kullanılamaz: ${name} (port tanımlı değil)`)
    map[name] = path
  }
  return map
}

const flag = (flags: Record<string, string | boolean | string[]>, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined

/** `up --check --json` service listings: byte-identical key order to the
 * raw serialization for clean configs, with B3 masking applied — `cmd` /
 * `logs` ham basılmaz, `readiness` ham argv değil maskeli-şekil taşır
 * (`env`/`requiredEnv` non-enumerable kaldığı için zaten görünmez). */
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
}): Promise<number | null> => {
  let text: string
  try {
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml bulunamadı: ${opts.file}`)
    } else {
      console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const svc = parsed.services.find((entry) => entry.name === opts.service)
  if (!svc) {
    const known = parsed.services.map((entry) => entry.name).join(", ")
    console.error(`ow: bilinmeyen servis: ${opts.service}${known.length > 0 ? ` (bilinenler: ${known})` : ""}`)
    return 2
  }
  // `down` skips the env gate (stopping must never wait on credentials).
  if (opts.action !== "down") {
    const missing = missingRequiredEnv([svc])
    if (missing.length > 0) {
      for (const entry of missing) {
        console.error(`ow: ${entry.service} gerekli ortam değişkenleri eksik: ${entry.vars.join(", ")}`)
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
      console.error("ow: restart için çalışan supervisor yok — önce `ow up`")
      return 2
    }
    if (opts.action === "down") return runDirectSingleDown(opts.rootDir, opts.service, opts.json)
    return null
  }
  const state = await readSupervisorState(paths.supervisorFile)
  const running = state?.services.find((entry) => entry.name === opts.service) ?? null
  const { diffService } = await import("./up-reconcile")
  const pre =
    opts.action === "down"
      ? { lines: [`durdurulacak: ${opts.service}${running ? ` pid=${running.pid}` : ""}`], diff: { status: running ? "running" : "missing" } }
      : diffService(svc, running, opts.action === "restart" ? "restart" : "up")
  if (!opts.json) for (const line of pre.lines) console.log(line)
  const { waitResult, writeRequest } = await import("./up-requests")
  let nonce: string
  try {
    nonce = await writeRequest(paths.requestsDir, opts.action, opts.service, opts.file)
  } catch (error) {
    console.error(`ow: istek yazılamadı: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const result = await waitResult(paths.requestsDir, nonce)
  if (!result) {
    console.error("ow: istek yanıtsız — `ow ps` ile doğrulayın")
    return 1
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        service: opts.service,
        action: opts.action,
        ...(result.pid !== undefined ? { pid: result.pid } : {}),
        diff: pre.diff,
        ...(result.ok ? {} : { code: result.code }),
      }),
    )
  } else if (result.ok) {
    console.log(result.message)
  } else {
    console.error(`ow: ${result.message}`)
  }
  if (result.ok) return 0
  if (result.code === "already-running" || result.code === "unknown-service" || result.code === "invalid-config") return 2
  return 1
}

/** Lock-yok `down <svc>`: only the target pid is stopped (shared `stopOne`
 * guard) and the record is merge-marked; the lock file is never touched
 * and `supervisor.json` is never deleted (B5). `--rm` never reaches here
 * (single `down --rm` is exit 2 at the call site). */
export const runDirectSingleDown = async (rootDir: string, service: string, json: boolean): Promise<number> => {
  const { classifySupervisorFile, isLivePid, readSupervisorState, upPaths } = await import("./up-state")
  const { persistMerged, stopOne } = await import("./up-supervisor")
  const paths = upPaths(rootDir)
  const fileStatus = await classifySupervisorFile(paths.supervisorFile)
  if (fileStatus === "corrupt") {
    console.error("ow: okunamıyor: supervisor.json bozuk — `down --rm` ile temizleyin")
    return 1
  }
  if (fileStatus === "bad-version") {
    console.error("ow: okunamıyor: supervisor.json sürüm uyuşmazlığı — `down --rm` ile temizleyin")
    return 1
  }
  if (fileStatus === "missing") {
    console.error("ow: durdurulacak süreç yok")
    return 2
  }
  const state = await readSupervisorState(paths.supervisorFile)
  const record = state?.services.find((entry) => entry.name === service)
  if (!record) {
    const known = (state?.services ?? []).map((entry) => entry.name).join(", ")
    console.error(`ow: bilinmeyen servis: ${service}${known.length > 0 ? ` (bilinenler: ${known})` : ""}`)
    return 2
  }
  const outcome = await stopOne(record)
  if (outcome.stopped) {
    const fresh = await readSupervisorState(paths.supervisorFile)
    const entry = fresh?.services.find((candidate) => candidate.name === service)
    if (fresh && entry && entry.exitCode === undefined && entry.lstart !== "" && !(await isLivePid(entry.pid, entry.lstart))) {
      entry.exitCode = -1
      entry.exitedAt = new Date().toISOString()
      await persistMerged(paths.supervisorFile, fresh).catch(() => undefined)
    }
  }
  if (!json) {
    console.log(`${outcome.stopped ? "durduruldu" : "durmuyor"}: ${outcome.name} (${outcome.note})`)
  } else {
    console.log(JSON.stringify({ stopped: [outcome], warnings: [] }))
  }
  return outcome.stopped ? 0 : 1
}

const resolveSession = async (
  positional: string | undefined,
  logPath: string,
): Promise<string | null> => positional ?? (await latestSession(logPath))

export const run = async (argv: string[]): Promise<number> => {
  if (argv[0] === "__supervise") {
    const fileIndex = argv.indexOf("--file")
    const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined
    if (!file || file.startsWith("--")) {
      console.error("ow: __supervise iç kullanım içindir (--file gerekli)")
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
  // P2-A: extra positionals belong only to `checkpoints show <run>`.
  if (command !== "checkpoints" && parsed.extra.length > 0) {
    console.error(`ow: beklenmeyen argüman: ${parsed.extra[0]}`)
    console.error(helpText())
    return 2
  }
  // M2: `--explain` renders only in `ps` (M-C precedent: unknown flags fail
  // loudly instead of silently doing nothing elsewhere).
  if (command !== "ps" && flags["--explain"] === true) {
    console.error("ow: --explain yalnızca ps ile kullanılır")
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
    console.log(json ? JSON.stringify({ checks: lines }) : formatDoctor(lines))
    return doctorFails(lines) ? 1 : 0
  }

  if (command === "sessions") {
    const sessions = await listSessions({
      logPath,
      dbPath: flag(flags, "--db"),
      sinceMs: parseSince(flag(flags, "--since")),
      dir: flag(flags, "--dir"),
    })
    if (json) {
      console.log(JSON.stringify(toSessionsJson(sessions)))
    } else {
      console.log(sessions.length > 0 ? formatSessions(sessions) : "oturum yok")
    }
    return 0
  }

  if (command === "init") {
    if (positional !== undefined) {
      console.error("ow: init konumsal argüman almaz")
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

  if (command === "up" || command === "restart" || command === "down" || command === "reconcile" || command === "checkpoints" || command === "preflight" || command === "scenarios" || command === "ps" || command === "logs" || command === "trace") {
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
          console.error(`ow: ow.yaml bulunamadı: ${file}`)
        } else {
          console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
        }
        return 2
      }
      let parsed: ReturnType<typeof parseUpFile>
      try {
        parsed = parseUpFile(text)
      } catch (error) {
        console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
        // Polish (sürtünme 2): the nesting trap bites hardest at validation
        // time — show the inline example only on the `--check` path.
        if (flags["--check"] === true && isSubsetNestingError(error)) console.error(subsetNestingHint)
        return 2
      }
      // `--probe` is M3-owned: anywhere else it is a usage error (exit 2),
      // never a silent no-op. One guard covers bulk and single `up`.
      if (flags["--probe"] === true) {
        console.error("ow: --probe henüz desteklenmiyor (M3)")
        return 2
      }
      if (positional !== undefined) {
        // M1 single-service `up`: live supervisor → request channel (the
        // `--wait`/`--detach` guards below do not apply: the result wait is
        // a fixed one-shot 10s, independent of `--wait`). No live lock →
        // classic bulk behavior (plan M1), anchored at this root.
        if (flags["--check"] === true) {
          console.error("ow: --check tek servis ile kullanılamaz (dosyanın tümünü doğrular)")
          return 2
        }
        if (flags["--health"] !== undefined) {
          console.error("ow: --health tek-servis up ile kullanılamaz")
          return 2
        }
        const single = await runSingleServiceRequest({ rootDir, file: yamlForRead, action: "up", service: positional, json })
        if (single !== null) return single
        warn(`canlı supervisor yok — toplu başlatılıyor (istenen: ${positional})`)
      }
      if (flags["--check"] === true && flags["--wait"] !== undefined) {
        console.error("ow: --wait --check ile kullanılamaz (doğrulama beklemez)")
        return 2
      }
      if (flags["--wait"] !== undefined && flags["--detach"] !== true) {
        console.error("ow: --wait yalnızca -d/--detach ile kullanılır (önizleme)")
        return 2
      }
      const healthRaw = flags["--health"] as string | string[] | undefined
      if (healthRaw !== undefined && flags["--check"] === true) {
        console.error("ow: --health --check ile kullanılamaz (doğrulama beklemez)")
        return 2
      }
      if (healthRaw !== undefined && flags["--wait"] === undefined) {
        console.error("ow: --health yalnız --wait ile kullanılır (--wait <süre> gerekli)")
        return 2
      }
      if (healthRaw !== undefined && flags["--detach"] !== true) {
        console.error("ow: --health yalnızca -d/--detach ile kullanılır (önizleme)")
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
      // N5: tanımlı probe + --health aynı serviste yarışamaz (iki kaynak yok).
      for (const svc of parsed.services) {
        if (health[svc.name] !== undefined && svc.readiness !== undefined) {
          console.error(`ow: --health ile readiness çakışıyor: ${svc.name} (birini seçin)`)
          return 2
        }
      }
      if (flags["--check"] === true) {
        for (const line of formatUpWarnings(parsed.warnings)) warn(line)
        const missing = missingRequiredEnv(parsed.services)
        if (missing.length > 0) {
          for (const entry of missing) {
            console.error(`ow: ${entry.service} gerekli ortam değişkenleri eksik: ${entry.vars.join(", ")}`)
          }
          return 2
        }
        // Polish (sürtünme 5): `--check` prints the resolved spawn order
        // (already topo-sorted by the parser) plus the order-only reminder.
        // Dep-less files keep exact YAML order — and byte-identical output,
        // since both lines print only when some service declares depends_on.
        const hasDeps = parsed.services.some((svc) => (svc.dependsOn?.length ?? 0) > 0)
        const order = parsed.services.map((svc) => svc.name)
        if (!json) {
          console.log(`ow.yaml geçerli: ${parsed.services.length} servis (${order.join(", ")})`)
          if (hasDeps) {
            console.log(`başlatma sırası: ${order.join(", ")}`)
            console.log(`depends_on bekletmez (order-only)`)
          }
        } else {
          console.log(JSON.stringify({ file, services: toCheckServicesJson(parsed.services), warnings: parsed.warnings, ...(hasDeps ? { spawnOrder: order } : {}) }))
        }
        return 0
      }
      const missing = missingRequiredEnv(parsed.services)
      if (missing.length > 0) {
        for (const entry of missing) {
          console.error(`ow: ${entry.service} gerekli ortam değişkenleri eksik: ${entry.vars.join(", ")}`)
        }
        return 2
      }
      const { classifyLock, ensureUpStateDir, upPaths } = await import("./up-state")
      const paths = upPaths(rootDir)
      try {
        await ensureUpStateDir(stateDir)
      } catch (error) {
        console.error(`ow: .ow kullanılamıyor: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      const status = await classifyLock(paths.lockFile)
      if (status.kind === "live") {
        console.error("ow: zaten çalışıyor (ow ps)")
        return 2
      }
      if (status.kind === "unknown") {
        console.error(`ow: kilit doğrulanamıyor (${status.reason}) — çalışıyor sayılıyor`)
        return 2
      }
      if (status.kind === "stale") warn(`uyarı: bayat kilit devralınacak (${status.reason})`)
      if (status.kind === "corrupt") warn(`uyarı: bozuk kilit devralınacak (${status.reason})`)
      // Orphan probe (H6): lock says free but recorded children may still be
      // live from a crashed supervisor — refuse instead of duplicating them.
      // (Adoption is riskier: no shutdown wiring for foreign pids.)
      try {
        const { assertNoLiveOrphans } = await import("./up-supervisor")
        await assertNoLiveOrphans(rootDir)
      } catch (error) {
        console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
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
    // `--probe` is M3-owned: `ps`/`logs` reject it before the honest-empty
    // branch (exit 2 with or without state), matching the `up`/`down`/
    // `restart`/`reconcile` guards below.
    if ((command === "ps" || command === "logs") && flags["--probe"] === true) {
      console.error("ow: --probe henüz desteklenmiyor (M3)")
      return 2
    }
    // `restart`/`reconcile`/tek-servis `down` state-dizini yokluğunda da
    // kendi honest çıkışını üretir (kilit-yok restart exit 2, reconcile
    // eksik exit 1, tek `down --rm` kullanım hatası) — erken boş-dal
    // yalnızca toplu `down` ile klasik okuyuculara aittir.
    const earlyEmpty = (command === "down" && positional === undefined) || command === "ps" || command === "logs"
    if (!existsSync(stateDir) && earlyEmpty) {
      if (command === "down") {
        console.error(`ow: durdurulacak süreç yok (${noStateNote(searchStart)})`)
        return 2
      }
      if (command === "ps") {
        if (json) console.log(JSON.stringify({ services: [] }))
        else console.log(`durum yok (${noStateNote(searchStart)})`)
        return 0
      }
      const service = positional ?? null
      if (json) console.log(JSON.stringify({ service, lines: [] }))
      else console.log(`log yok (${noStateNote(searchStart)})`)
      return 0
    }
    if (command === "down") {
      if (flags["--probe"] === true) {
        console.error("ow: --probe henüz desteklenmiyor (M3)")
        return 2
      }
      if (positional !== undefined && flags["--rm"] === true) {
        console.error("ow: --rm yalnızca toplu down ile kullanılır (tek serviste `down <ad> --rm` çıkış 2)")
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
          console.error("ow: okunamıyor: supervisor.json bozuk — `down --rm` ile temizleyin")
          return 1
        }
        if (fileStatus === "bad-version") {
          console.error("ow: okunamıyor: supervisor.json sürüm uyuşmazlığı — `down --rm` ile temizleyin")
          return 1
        }
      }
      const outcome = await downAll(rootDir, rm)
      for (const line of outcome.warnings) warn(line)
      if (outcome.results.length === 0) {
        if (outcome.clearedLock) {
          if (!json) console.log("kilit temizlendi")
          else console.log(JSON.stringify({ stopped: [], warnings: outcome.warnings }))
          return 0
        }
        if (outcome.removedState) {
          if (!json) console.log("temizlendi")
          else console.log(JSON.stringify({ stopped: [], warnings: outcome.warnings }))
          return 0
        }
        console.error("ow: durdurulacak süreç yok")
        return 2
      }
      if (!json) {
        for (const result of outcome.results) {
          console.log(`${result.stopped ? "durduruldu" : "durmuyor"}: ${result.name} (${result.note})`)
        }
      } else {
        console.log(JSON.stringify({ stopped: outcome.results, warnings: outcome.warnings }))
      }
      return outcome.results.every((result) => result.stopped) ? 0 : 1
    }
    if (command === "restart") {
      if (positional === undefined) {
        console.error("ow: restart servis adı bekler (ör. ow restart api)")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach", "--probe"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} restart ile kullanılamaz`)
          return 2
        }
      }
      const single = await runSingleServiceRequest({ rootDir, file: yamlForRead, action: "restart", service: positional, json })
      return single ?? 2
    }
    if (command === "reconcile") {
      if (positional !== undefined) {
        console.error("ow: reconcile konumsal argüman almaz (--check yeterli)")
        return 2
      }
      if (flags["--check"] !== true) {
        console.error("ow: reconcile --check ile kullanılır (salt-okunur rapor, mutasyon yok)")
        return 2
      }
      // M3: `--probe` bayraklı reconcile, tanımlı probe'ları istemci-tarafı
      // one-shot çalıştırır (M1 N3 bütçesi); mutasyon yapmaz, çıkış
      // drift'e göredir.
      const { runReconcileCheck } = await import("./up-reconcile")
      return runReconcileCheck({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true })
    }
    if (command === "checkpoints") {
      // P2-A: runner-yazar/ow-okur; salt-okunur, mutasyon yok, canlı exec yok.
      if (flags["--probe"] === true) {
        console.error("ow: --probe henüz desteklenmiyor (M3)")
        return 2
      }
      const { runCheckpointsList, runCheckpointsShow } = await import("./up-checkpoints")
      if (positional === undefined || (positional !== "list" && positional !== "show")) {
        console.error("ow: checkpoints list|show bekleniyor (ör. ow checkpoints show <run>)")
        return 2
      }
      if (positional === "list") {
        if (parsed.extra.length > 0) {
          console.error(`ow: beklenmeyen argüman: ${parsed.extra[0]}`)
          return 2
        }
        return runCheckpointsList({ rootDir, json })
      }
      if (parsed.extra.length !== 1) {
        console.error(
          parsed.extra.length === 0 ? "ow: checkpoints show run adı bekler (ör. ow checkpoints show <run>)" : `ow: beklenmeyen argüman: ${parsed.extra[1]}`,
        )
        return 2
      }
      return runCheckpointsShow({ rootDir, run: parsed.extra[0], json })
    }
    if (command === "preflight") {
      // P2-B: salt-okunur kapı — spawn/stop/restart/probe/health/git/lsof
      // çağrılmaz (bayraksız); `--probe` yalnızca bildirimli portlara
      // one-shot loopback TCP (bütçeli). `--probe` burada M3 bayrağı değil,
      // kapının kendi canlı-onay yoludur.
      if (positional !== undefined) {
        console.error("ow: preflight konumsal argüman almaz")
        return 2
      }
      for (const unsupported of ["--rm", "--check", "--wait", "--health", "--detach"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} preflight ile kullanılamaz`)
          return 2
        }
      }
      const { runPreflight } = await import("./up-preflight")
      return runPreflight({ rootDir, file: yamlForRead, json, probe: flags["--probe"] === true })
    }
    if (command === "scenarios") {
      // Senaryo validatoru: salt-okunur (probe koşmaz, exec yok). `--file`
      // senaryo dosyasını gösterir (varsayılan <root>/ow.scenarios.yaml);
      // services-referansları aynı root'un ow.yaml'ına bakılır.
      if (positional !== undefined) {
        console.error("ow: scenarios konumsal argüman almaz")
        return 2
      }
      if (flags["--check"] !== true) {
        console.error("ow: scenarios --check ile kullanılır (salt-okunur doğrulama, çalıştırma yok)")
        return 2
      }
      for (const unsupported of ["--probe", "--wait", "--health", "--detach", "--rm"]) {
        if (flags[unsupported] !== undefined) {
          console.error(`ow: ${unsupported} scenarios ile kullanılamaz`)
          return 2
        }
      }
      const { runScenariosCheck, SCENARIOS_FILE_NAME } = await import("./up-scenarios")
      const scenariosFile = explicitFile ? upFilePath(flags) : join(rootDir, SCENARIOS_FILE_NAME)
      return runScenariosCheck({ file: scenariosFile, rootDir, json })
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
        console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      if (!json) {
        console.log(services.length > 0 ? services.map(formatPsLine).join("\n") : "durum yok")
      } else {
        console.log(JSON.stringify({ services: services.map(toPsServiceJson) }))
      }
      return 0
    }
    if (command === "logs") {
      const tail = Number(flag(flags, "--tail") ?? 200)
      const grep = flag(flags, "--grep")
      const sinceMs = parseSince(flag(flags, "--since"))
      const { classifySupervisorFile, upPaths } = await import("./up-state")
      const fileStatus = await classifySupervisorFile(upPaths(rootDir).supervisorFile)
      if (fileStatus === "corrupt" || fileStatus === "bad-version") {
        console.error("ow: supervisor durumu bozuk — ow down --rm ile temizleyin")
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
        console.error(`ow: bilinmeyen servis: ${positional}${names.length > 0 ? ` (${names.join(", ")})` : ""}`)
        return 2
      }
      const { queryLogs } = await import("./up-logs")
      let rows: Awaited<ReturnType<typeof queryLogs>>
      try {
        rows = await queryLogs({ logsDir: join(stateDir, "logs"), service: positional, tail, grep, sinceMs })
      } catch (error) {
        console.error(`ow: log okunamıyor: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      if (!json) {
        if (rows.length === 0) {
          console.log("log yok")
        } else {
          for (const row of rows) console.log(`[${row.service}|${row.stream}] ${row.line}`)
        }
      } else {
        console.log(JSON.stringify({ service: positional ?? null, lines: rows }))
      }
      return 0
    }
  }

  const sid = await resolveSession(positional, logPath)
  if (!sid) {
    console.error("oturum bulunamadı")
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
      console.log("prompt yok")
    }
    return 0
  }

  const treeMode = flags["--tree"] === true
  const windowMs = parseSince(flag(flags, "--since"))

  if (command === "stuck") {
    let records: EnrichedRecord[]
    if (treeMode) {
      const { by, warnings, childCount } = await loadTreeRecords({ dbPath: flag(flags, "--db"), logPath, sessionID: sid, sinceMs: windowMs })
      if (childCount > 0) warn(`ağaç: ${childCount + 1} oturum (${childCount} çocuk)`)
      for (const w of warnings) warn(`warn: ${w}`)
      records = [...by.values()].flat()
    } else {
      const r = await joinSession({ sessionID: sid, dbPath: flag(flags, "--db"), logPath, sinceMs: windowMs })
      for (const w of r.warnings) warn(`warn: ${w}`)
      records = r.records
    }
    const windowed = filterSince(records, windowMs)
    const report = await stuckReport({ records: windowed, dbPath: flag(flags, "--db"), sessionID: sid })
    console.log(json ? JSON.stringify(toStuckJson(sid, report)) : formatStuck(report))
    return 0
  }

  // show + reads share the joined records
  let by: Map<string, EnrichedRecord[]>
  let warnings: string[]
  if (treeMode) {
    const { by: loaded, warnings: treeWarnings, childCount } = await loadTreeRecords({ dbPath: flag(flags, "--db"), logPath, sessionID: sid, sinceMs: windowMs })
    if (childCount > 0) warn(`ağaç: ${childCount + 1} oturum (${childCount} çocuk)`)
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
      console.log(JSON.stringify({ session: sid, reads: stats }))
    } else {
      const text = formatReads(stats)
      console.log(text.length > 0 ? text : "okuma kaydı yok")
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
      warn("patlak satır yok")
    }
    return 0
  }
  if (flat) {
    for (const record of merged) console.log(JSON.stringify(record))
    return 0
  }
  if (treeMode) {
    if (json) {
      console.log(JSON.stringify(toShowJson(sid, warnings, groups, treeIds(buildTree(sid, filtered)))))
    } else {
      const text = formatTree(buildTree(sid, filtered), filtered, { full, sectionBudget })
      if (text.length > 0) console.log(text)
      if (full) warn(`(tam metin: ${text.length} karakter)`)
    }
    return 0
  }
  const text = formatGrouped(groups, full, false, sectionBudget)
  if (json) {
    console.log(JSON.stringify(toShowJson(sid, warnings, groups)))
  } else {
    if (text.length > 0) console.log(text)
    if (full) warn(`(tam metin: ${text.length} karakter)`)
  }
  return 0
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
