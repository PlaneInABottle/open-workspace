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
import { formatUpWarnings, parseUpFile } from "./up-schema"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const COMMANDS = ["doctor", "sessions", "show", "stuck", "meta", "prompts", "reads", "up", "down", "ps", "logs", "trace"] as const
export type Command = (typeof COMMANDS)[number]
const ALIASES: Record<string, Command> = { list: "sessions" }

const VALUE_FLAGS = new Set(["--db", "--log", "--since", "--dir", "--kind", "--tool", "--show", "--bytes", "--file", "--tail", "--grep", "--service"])
const BOOL_FLAGS = new Set(["--json", "--full", "--tree", "--flat", "--show-fails", "--help", "-h", "--check", "--detach", "--rm"])

export type ParsedArgs = {
  command: Command | null
  sessionID: string | undefined
  flags: Record<string, string | boolean>
  error: string | null
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
    "  up [--file] [--check] [-d|--detach]  servisleri kaldır (ow.yaml); --check yalnız doğrular",
    "  down [--file] [--rm]          servisleri durdur (--rm durum dosyasını da siler)",
    "  ps [--file]                   servis durumu (pid, süre, cpu, bellek, port)",
    "  logs [servis] [--file] [--tail] [--grep] [--since]  servis logları",
  "  trace [iz] [--file] [--tail] [--since] [--service]  izlemeler; iz ile tek ağaç",
    "",
    "genel: --db <yol> --log <yol> --json --help",
    "  --since  pencere: 30m|3h|1d|1w (varsayılan 1d; sessions/show/stuck/reads)",
    "  --json  makine çıktısı (İngilizce anahtarlar): show/stuck/meta/sessions/reads/prompts/ps/logs/down/trace",
    "çıkış: 0 ok, 1 yapısal hata, 2 kullanım hatası",
    "",
    "örnek: ow show <oturum> --tree --since 1d",
  ].join("\n")

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {}
  let command: Command | null = null
  let sessionID: string | undefined
  const fail = (error: string): ParsedArgs => ({ command, sessionID, flags, error })
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
        flags[arg] = value
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
    return fail(`beklenmeyen argüman: ${arg}`)
  }
  if (flags["--help"]) return { command, sessionID, flags, error: null }
  if (!command) return fail("komut bekleniyor: doctor|sessions|show|stuck|meta|prompts|reads|up|down|ps|logs|trace (--help)")
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
  if (typeof flags["--grep"] === "string" && flags["--grep"].length > 256) {
    return fail("geçersiz --grep: en fazla 256 karakter")
  }
  return { command, sessionID, flags, error: null }
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
export const toMetaJson = (result: Awaited<ReturnType<typeof sessionMeta>>) => ({ meta: result.meta, warning: result.warning })
export const toPromptsJson = (sessionID: string, prompts: string[]) => ({ session: sessionID, prompts })
export const toReadsJson = (sessionID: string, reads: ReturnType<typeof readDigest>) => ({ session: sessionID, reads })
export const toPsJson = (services: unknown[]) => ({ services })
export const toLogsJson = (service: string | null, lines: unknown[]) => ({ service, lines })

/** `doctor` exit rule: `up` and `trace` lines are informational only. */
export const doctorFails = (lines: { name: string; ok: boolean }[]): boolean =>
  lines.filter((l) => l.name !== "up" && l.name !== "trace").some((l) => !l.ok)

/** Supervisor root: --file dizini ya da cwd; state/logs <root>/.ow altında. */
export const upRootDir = (flags: Record<string, string | boolean>): string => {
  const file = flag(flags, "--file")
  return file ? dirname(resolve(file)) : process.cwd()
}
export const upFilePath = (flags: Record<string, string | boolean>): string => {
  const file = flag(flags, "--file")
  return file ? resolve(file) : join(process.cwd(), "ow.yaml")
}
export const upStateDir = (rootDir: string): string => join(rootDir, ".ow")

const flag = (flags: Record<string, string | boolean>, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined

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
  const dbPath = flag(flags, "--db") ?? DEFAULT_DB_PATH
  const logPath = flag(flags, "--log") ?? DEFAULT_LOG_PATH
  const json = flags["--json"] === true
  const warn = (message: string): void => {
    if (!json) console.error(message)
  }

  if (command === "doctor") {
    const lines = await doctor({ logPath, dbPath, upRoot: upRootDir(flags) })
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

  if (command === "up" || command === "down" || command === "ps" || command === "logs" || command === "trace") {
    const rootDir = upRootDir(flags)
    const stateDir = upStateDir(rootDir)
    if (command === "trace") {
      const { runTrace } = await import("./trace-cli")
      const tailFlag = flag(flags, "--tail")
      const serviceFlag = flag(flags, "--service")
      const result = await runTrace({
        rootDir,
        owYamlPath: upFilePath(flags),
        traceId: positional,
        tail: tailFlag === undefined ? undefined : Number(tailFlag),
        sinceMs: parseSince(flag(flags, "--since")),
        service: serviceFlag,
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
        text = readFileSync(file, "utf8")
      } catch {
        console.error(`ow: ow.yaml bulunamadı: ${file}`)
        return 2
      }
      let parsed: ReturnType<typeof parseUpFile>
      try {
        parsed = parseUpFile(text)
      } catch (error) {
        console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
        return 2
      }
      if (flags["--check"] === true) {
        for (const line of formatUpWarnings(parsed.warnings)) warn(line)
        if (!json) {
          console.log(`ow.yaml geçerli: ${parsed.services.length} servis (${parsed.services.map((s) => s.name).join(", ")})`)
        } else {
          console.log(JSON.stringify({ file, services: parsed.services, warnings: parsed.warnings }))
        }
        return 0
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
      if (flags["--detach"] === true) {
        const { detachSupervised } = await import("./up-supervisor-cli")
        return detachSupervised(file, rootDir)
      }
      const { runSuperviseFile } = await import("./up-supervisor-cli")
      return runSuperviseFile(file)
    }
    if (!existsSync(stateDir)) {
      if (command === "down") {
        console.error("ow: durdurulacak süreç yok (.ow/ bulunamadı)")
        return 2
      }
      if (command === "ps") {
        if (json) console.log(JSON.stringify(toPsJson([])))
        else console.log("durum yok (.ow/ bulunamadı)")
        return 0
      }
      const service = positional ?? null
      if (json) console.log(JSON.stringify(toLogsJson(service, [])))
      else console.log("log yok (.ow/ bulunamadı)")
      return 0
    }
    if (command === "down") {
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
    if (command === "ps") {
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
        console.log(JSON.stringify(toPsJson(services.map(toPsServiceJson))))
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
        names = parseUpFile(readFileSync(upFilePath(flags), "utf8")).services.map((svc) => svc.name)
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
        console.log(JSON.stringify(toLogsJson(positional ?? null, rows)))
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
    console.log(json ? JSON.stringify(toMetaJson(result)) : formatMeta(result.meta))
    return 0
  }

  if (command === "prompts") {
    const prompts = await sessionPrompts({ dbPath, sessionID: sid })
    if (json) {
      console.log(JSON.stringify(toPromptsJson(sid, prompts)))
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
      console.log(JSON.stringify(toReadsJson(sid, stats)))
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
