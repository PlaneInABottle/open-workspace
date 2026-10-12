/** M1 salt-okunur reconcile: beklenen (ow.yaml) vs çalışan (state+lstart)
 * drift raporu. Asla mutasyon yapmaz (tanık çizgisi) — yalnızca açık
 * `ow up/restart/down <svc>` komutları önerir. exit 0 ok / 1 drift / 2 kullanım.
 * M3 `--probe` fazı: tanımlı probe'lar istemci-tarafı one-shot çalışır
 * (canlı+kayıtlı servisler, toplam ≤60s soft bütçe); sonuçlar `readiness:`
 * satırları olarak eklenir, çıkışı değiştirmez (drift'e göre). */

import { parseUpFile, PROBE_TIMEOUT_MS, type UpService } from "./up-schema"
import { decodeUtf8Fatal } from "./up-schema"
import { readLstart, readSupervisorState, upPaths, warnWriteFailed, type UpServiceState } from "./up-state"
import { tcpListening } from "./up-net"
import { gitCheckout, resolveCwdAbs } from "./up-provenance"

/** Secret-shaped argv/cmd yankısı maskeli-şekildir (B3): ham değer asla
 * output/state/log'a girmez. Kurallar: `ad=değer` içinde secret-kelime
 * (`password|secret|api[_-]?key|bearer|token|credential|private_key|
 * `authorization`) → `ad=***`; secret-bayrak sonrası değer
 * (`--password hunter2`) → `***`; sağlayıcı-öneki (ghp_/sk-/xox-) ve
 * ≥32-hex gövdeler → `***`; secret-kelime içeren yalın parça → `***`.
 * Şekil korunur (parça sayısı/sırası aynı), değerler düşer. */
const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/

/** B3 maske listesi (P2-A evidence maskesiyle paylaşılır; tek kaynak). */
export const SECRET_WORD_PATTERN = SECRET_WORD
export const PROVIDER_PREFIX_PATTERN = PROVIDER_PREFIX

/** B3 token maskesi (P2-A evidence maskesiyle paylaşılır; tek kaynak). */
export const maskSecretToken = (token: string, prevIsSecretFlag: boolean): string => {
  if (token.length === 0) return token
  const eq = token.indexOf("=")
  if (eq > 0) {
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (SECRET_WORD.test(key) || SECRET_WORD.test(value) || /^[0-9a-fA-F]{32,}$/.test(value) || PROVIDER_PREFIX.test(value)) {
      return `${key}=***`
    }
    return token
  }
  if (prevIsSecretFlag) return "***"
  if (/^(-{1,2}[A-Za-z0-9_-]*password|^(-{1,2}[A-Za-z0-9_-]*secret)|(-{1,2}[A-Za-z0-9_-]*token))$/i.test(token)) return token
  if (SECRET_WORD.test(token) || /^[0-9a-fA-F]{32,}$/.test(token) || PROVIDER_PREFIX.test(token)) return "***"
  return token
}

const isSecretFlag = (token: string): boolean =>
  /^(-{1,2})?[A-Za-z0-9_-]*(password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization)$/i.test(token) &&
  !token.includes("=")

/** B3 secret-bayrak testi (P2-A evidence maskesiyle paylaşılır; tek kaynak). */
export const isSecretFlagToken = isSecretFlag

/** Maskeli cmd-şekli: string aynen tokenize edilir, argv listesi parça-parça. */
export const maskCmdShape = (cmd: string | string[] | undefined): string | undefined => {
  if (cmd === undefined) return undefined
  const parts = Array.isArray(cmd) ? cmd : cmd.split(/\s+/)
  let prevFlag = false
  const masked = parts.map((part) => {
    const out = maskSecretToken(part, prevFlag)
    prevFlag = isSecretFlag(part)
    return out
  })
  return Array.isArray(cmd) ? masked.join(" ") : masked.join(" ")
}

/** Mutasyon-öncesi diff satırları (Türkçe) + JSON diff zarfı. `running`
 * null ise servis kayıtlı değil (başlatılacak); `restart` aksiyonunda bu
 * satır kayıtsız-restart'ı adlandırır (L-2: yalın `up` satırından ayrışır). */
export const diffService = (
  expected: UpService,
  running: UpServiceState | null,
  action: "up" | "restart" = "up",
): { lines: string[]; diff: { cmd?: string; cwd?: string; port?: number; status: string } } => {
  const shape = maskCmdShape(expected.cmd) ?? "(logs)"
  const where = [
    ...(expected.cwd !== undefined ? [`cwd=${expected.cwd}`] : []),
    ...(expected.port !== undefined ? [`port=${expected.port}`] : []),
  ].join(" ")
  if (running === null) {
    const prefix = action === "restart" ? "+ to-start (restart, no record)" : "+ to-start"
    return {
      lines: [`${prefix}: ${expected.name} cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
      diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), ...(expected.cwd !== undefined ? { cwd: expected.cwd } : {}), ...(expected.port !== undefined ? { port: expected.port } : {}), status: "missing" },
    }
  }
  return {
    lines: [`restart: ${expected.name} pid=${running.pid} lstart=matched → cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
    diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), status: "running" },
  }
}

export type DriftKind =
  | "missing"
  | "extra"
  | "stopped"
  | "config-mismatch"
  | "lstart-mismatch"
  | "foreign-port"
  | "artifact-stale"

export type ReconcileDrift = {
  service: string
  kind: DriftKind
  expected?: Record<string, unknown>
  running?: Record<string, unknown>
  hint: string
}

export type Liveness = "live" | "dead" | "lstart-mismatch" | "unknown"

export type ReconcileInput = {
  name: string
  expected: UpService | null
  running: UpServiceState | null
  /** Kayıtlı çıkış varsa `durmus` sayılır (canlılık bakılmaz). */
  liveness: Liveness
  /** Bildirilen portta loopback dinleyici var mı (tanımlı port için). */
  listening: boolean | undefined
  /** `lsof` best-effort port-sahibi pid'leri; null = ölçülemedi. */
  portOwners: number[] | null
  /** M-C derleme kimliği: probe-beyanlı (basename → tam-digest) vs kayıtlı
   * harita. Canlılık/ok-geçidi çağırandadır (çekirdek salt karşılaştırır);
   * kayıtsız basename drift üretmez (kayıt-gözlem çağıranın işi). */
  artifacts?: { declared: Record<string, string>; recorded: Record<string, string> }
}

/** Saf drift çekirdeği: I/O yok, enjekte girdilerle test edilir. */
export const reconcileOne = (input: ReconcileInput): ReconcileDrift | null => {
  const { name, expected, running, liveness } = input
  if (expected === null && running !== null) {
    return { service: name, kind: "extra", running: { pid: running.pid }, hint: `ow down ${name}` }
  }
  if (expected !== null && running === null) {
    return {
      service: name,
      kind: "missing",
      expected: { cmd: maskCmdShape(expected.cmd), cwd: expected.cwd, port: expected.port },
      hint: `ow up ${name}`,
    }
  }
  if (expected === null || running === null) return null
  if (running.exitCode !== undefined) {
    return { service: name, kind: "stopped", running: { pid: running.pid, exitCode: running.exitCode }, hint: `ow restart ${name}` }
  }
  if (liveness === "lstart-mismatch") {
    return { service: name, kind: "lstart-mismatch", running: { pid: running.pid }, hint: `ow down ${name} then ow up ${name} (suspected pid reuse)` }
  }
  if (liveness === "unknown") {
    return { service: name, kind: "stopped", running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  if (liveness === "dead") {
    return { service: name, kind: "stopped", running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  const diffs: Record<string, unknown> = {}
  const expectedShape = maskCmdShape(expected.cmd)
  const runningShape = maskCmdShape(running.cmd)
  if (expectedShape !== undefined && runningShape !== undefined && expectedShape !== runningShape) {
    diffs["cmd"] = { expected: expectedShape, running: runningShape }
  }
  if (expected.cwd !== undefined && running.cwd !== undefined && expected.cwd !== running.cwd) {
    diffs["cwd"] = { expected: expected.cwd, running: running.cwd }
  }
  if (expected.port !== undefined && running.port !== undefined && expected.port !== running.port) {
    diffs["port"] = { expected: expected.port, running: running.port }
  }
  const expectedEnv = [...(expected.env ? Object.keys(expected.env) : []), ...(expected.requiredEnv ?? [])].sort()
  const runningEnv = [...(running.envNames ?? [])].sort()
  if (running.envNames !== undefined && JSON.stringify(expectedEnv) !== JSON.stringify(runningEnv)) {
    diffs["env"] = { expected: expectedEnv, running: runningEnv }
  }
  const expectedDeps = [...(expected.dependsOn ?? [])].sort()
  const runningDeps = [...(running.dependsOn ?? [])].sort()
  if (running.dependsOn !== undefined && JSON.stringify(expectedDeps) !== JSON.stringify(runningDeps)) {
    diffs["depends_on"] = { expected: expectedDeps, running: runningDeps }
  }
  if (Object.keys(diffs).length > 0) {
    return { service: name, kind: "config-mismatch", expected: diffs, running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  // M-C artifact-stale: canlı + uyumlu serviste probe-beyanlı digest ile
  // kayıtlı harita çelişirse (sıralı ilk basename, deterministik). Digest
  // karşılaştırması hex-dışıduyarlıdır (küçük-harfe indirgenir); tel/insan
  // YALNIZCA basename görür (tam-digest expected/running'e girmez).
  if (input.artifacts !== undefined) {
    const { declared, recorded } = input.artifacts
    for (const base of Object.keys(declared).sort()) {
      const seen = recorded[base]
      if (seen !== undefined && seen.toLowerCase() !== declared[base].toLowerCase()) {
        return {
          service: name,
          kind: "artifact-stale",
          expected: { artifact: base },
          running: { pid: running.pid },
          hint: `rebuild + ow restart ${name}`,
        }
      }
    }
  }
  if (
    expected.port !== undefined &&
    input.listening === true &&
    input.portOwners !== null &&
    !input.portOwners.includes(running.pid)
  ) {
    return {
      service: name,
      kind: "foreign-port",
      running: { pid: running.pid, port: expected.port },
      hint: `port ${expected.port} foreign listener (UNVERIFIED) — no kill, verify the owner`,
    }
  }
  return null
}

/** `lsof -i :<port>` read-only port-sahibi yoklaması (best-effort,
 * UNVERIFIED: platform çıktısı değişkendir). Kill yok, hata sessizce
 * null döner. Supervisor spawn-anı + reconcile yolunda çalışır, `ps`
 * içinde asla. */
export const portOwners = async (port: number, timeoutMs = 2000): Promise<number[] | null> => {
  try {
    const proc = Bun.spawn(["lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" })
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
    const pids = out.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
    return pids
  } catch {
    return null
  }
}

const DRIFT_TR: Record<DriftKind, string> = {
  missing: "missing",
  extra: "extra",
  stopped: "stopped",
  "config-mismatch": "config-mismatch",
  "lstart-mismatch": "lstart-mismatch",
  "foreign-port": "foreign-port",
  "artifact-stale": "stale-build",
}

/** Kilitli insan şablonu (M-C): `derleme-eski: <svc> (<base> değişti) →
 * yeniden-derle + ow restart <svc>` (öneri-metni; düğme/otomatik eylem yok). */
export const formatDrift = (drift: ReconcileDrift): string => {
  if (drift.kind === "artifact-stale") {
    const base = (drift.expected as Record<string, unknown> | undefined)?.["artifact"]
    return `stale-build: ${drift.service} (${typeof base === "string" ? base : "?"} changed) → rebuild + ow restart ${drift.service}`
  }
  return `${DRIFT_TR[drift.kind]}: ${drift.service} → ${drift.hint}`
}

/** M3 probe bütçesi (M1 N3): toplam ≤60s SOFT duvar — son başlayan probe
 * bütçeyi tek-timeout kadar aşabilir (koşan probe yarıda kesilmez);
 * aşımda kalan servis `ölçülmedi(timeout-bütçesi)` raporlanır, exit yine
 * drift'e göredir. */
export const RECONCILE_PROBE_BUDGET_MS = 60_000

export type ReconcileReadiness = { service: string; ok: boolean; note: string }

/** Salt-okunur `reconcile --check` koşusu: exit 0 sync / 1 drift / 2 kullanım.
 * `--probe` ile tanımlı probe'lar istemci-tarafı one-shot çalışır (canlı
 * supervisor'da kayıtlı-canlı servisler); sonuçlar drift raporuna
 * `readiness:` satırları olarak eklenir, çıkışı değiştirmez. */
export const runReconcileCheck = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe?: boolean
  /** Enjekte probe çalıştırıcı (default gerçek `runProbe`; testler sahte). */
  runProbeFn?: import("./up-probe").ProbeFn
  /** Toplam probe bütçesi (default 60s; testler küçültür). */
  probeBudgetMs?: number
}): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${opts.file}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
      return 1
    }
  }
  const running = state?.services ?? []
  const names = [...new Set([...expected.map((svc) => svc.name), ...running.map((svc) => svc.name)])].sort()
  const drifts: ReconcileDrift[] = []
  // M-C: çekirdek girdileri saklanır (probe-sonrası artifact-geçidi aynı
  // anlık-girdiyle ikinci kez çalışır — deterministik, yeniden-ölçüm yok).
  const kernelInputs = new Map<string, { exp: UpService | null; run: UpServiceState | null; liveness: Liveness; listening: boolean | undefined; owners: number[] | null }>()
  for (const name of names) {
    const exp = expected.find((svc) => svc.name === name) ?? null
    const run = running.find((svc) => svc.name === name) ?? null
    let liveness: Liveness = "dead"
    let listening: boolean | undefined
    let owners: number[] | null = null
    if (run && run.exitCode === undefined) {
      if (run.lstart === "") {
        liveness = "unknown"
      } else {
        const current = await readLstart(run.pid)
        liveness = current === null ? "dead" : current === run.lstart ? "live" : "lstart-mismatch"
      }
    } else if (run) {
      liveness = "dead"
    }
    const port = exp?.port ?? run?.port
    if (port !== undefined && run && liveness === "live") {
      listening = await tcpListening(port)
      if (listening === true) owners = await portOwners(port)
    }
    const drift = reconcileOne({ name, expected: exp, running: run, liveness, listening, portOwners: owners })
    if (drift) drifts.push(drift)
    kernelInputs.set(name, { exp, run, liveness, listening, owners })
  }
  // M2 revision witness (B4 point b: explicit `--check` one-shot, best
  // effort): recorded rev per service + live checkout rev. Display-only —
  // drift/exit/keys unchanged (`revisions` is additive). ow.yaml carries
  // no checkout pin, so the "new" side is always the live checkout.
  type Revision = { service: string; recordedRev?: string; recordedDirty?: boolean; liveRev?: string; liveDirty?: boolean; match?: boolean }
  const revisions: Revision[] = []
  for (const name of names) {
    const exp = expected.find((svc) => svc.name === name) ?? null
    const run = running.find((svc) => svc.name === name) ?? null
    const recorded = run?.provenance?.checkout
    const live = await gitCheckout(resolveCwdAbs(opts.rootDir, exp?.cwd ?? run?.cwd))
    if (recorded?.rev === undefined && live === null) continue
    const entry: Revision = { service: name }
    if (recorded?.rev !== undefined) {
      entry.recordedRev = recorded.rev
      if (recorded.dirty === true) entry.recordedDirty = true
    }
    if (live !== null) {
      entry.liveRev = live.rev
      if (live.dirty) entry.liveDirty = true
    }
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined) {
      entry.match = entry.recordedRev === entry.liveRev
    }
    revisions.push(entry)
  }
  const revMark = (rev: string, dirty: boolean | undefined): string => (dirty === true ? `${rev}+dirty` : rev)
  const revLines = revisions.map((entry) => {
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined && !entry.match) {
      return `diff: revision ${revMark(entry.recordedRev, entry.recordedDirty)}→${revMark(entry.liveRev, entry.liveDirty)} (${entry.service}; live checkout, no restart needed, report)`
    }
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined) {
      return `rev: ${entry.service} ${revMark(entry.liveRev, entry.liveDirty)} (matched)`
    }
    if (entry.recordedRev !== undefined) return `rev: ${entry.service} ${revMark(entry.recordedRev, entry.recordedDirty)} (recorded; live unreadable)`
    return `rev: ${entry.service} ${revMark(entry.liveRev as string, entry.liveDirty)} (live only; no record)`
  })
  if (!opts.json) {
    for (const line of revLines) console.log(line)
  }
  // M3 `--probe` fazı: drift'ten bağımsız salt-okunur ölçüm. Yalnızca
  // kayıtlı-CANLI + tanımlı servisler (ölü/bilinmeyen atlanır — drift
  // satırları zaten kapsar). Kayıt: canlı kilit varsa istek-kanalıyla
  // (tek yazar supervisor), yoksa atlanır (rapor korunur).
  let readiness: ReconcileReadiness[] = []
  // M-C derleme-kimliği: probe-beyanlı (basename → tam-digest) vs kayıtlı
  // harita. Uyuşmazlık (canlı + ok-girdi) → artifact-stale drift;
  // kayıtsız basename → kayıt-gözlem (istek-kanalı, driftsiz/uyarısız).
  const artifactStale: { service: string; artifact: string }[] = []
  let artifactJson: Record<string, Record<string, string>> | null = null
  if (opts.probe === true) {
    const { runProbeJob, declaredArtifactDigests, reduceArtifactMap } = await import("./up-probe")
    const { resolve: resolvePath } = await import("node:path")
    const runProbeFn = opts.runProbeFn ?? runProbeJob
    const deadline = Date.now() + (opts.probeBudgetMs ?? RECONCILE_PROBE_BUDGET_MS)
    const measured: ReconcileReadiness[] = []
    const toRecord: { service: string; pid: number; ok: boolean; note: string; artifacts?: Record<string, string> }[] = []
    for (const name of names) {
      const exp = expected.find((svc) => svc.name === name) ?? null
      const run = running.find((svc) => svc.name === name) ?? null
      if (exp?.readiness === undefined || run === undefined) continue
      let live = false
      if (run.exitCode === undefined && run.lstart !== "") {
        const current = await readLstart(run.pid)
        live = current !== null && current === run.lstart
      }
      if (!live) continue
      if (Date.now() > deadline) {
        measured.push({ service: name, ok: false, note: "unmeasured: timeout-budget" })
        continue
      }
      const outcome = await runProbeFn({
        probe: exp.readiness.probe,
        timeoutMs: PROBE_TIMEOUT_MS[exp.readiness.timeout],
        cwd: exp.cwd === undefined ? opts.rootDir : resolvePath(opts.rootDir, exp.cwd),
        env: { ...process.env, ...exp.env, OW_SERVICE: name },
      }).catch((): import("./up-probe").ProbeOutcome => ({ ok: false, note: "could-not-run", timedOut: false, code: null }))
      measured.push({ service: name, ok: outcome.ok, note: outcome.note })
      const declared = declaredArtifactDigests(outcome.checks)
      const recorded = run.artifactDigests ?? {}
      const unrecorded: Record<string, string> = {}
      for (const [base, digest] of Object.entries(declared)) {
        if (recorded[base] === undefined) unrecorded[base] = digest
      }
      toRecord.push({
        service: name,
        pid: run.pid,
        ok: outcome.ok,
        note: outcome.note,
        ...(Object.keys(unrecorded).length > 0 ? { artifacts: unrecorded } : {}),
      })
      if (Object.keys(declared).length > 0 && !drifts.some((drift) => drift.service === name)) {
        const prev = kernelInputs.get(name)
        if (prev?.run) {
          const artifactDrift = reconcileOne({
            name,
            expected: prev.exp,
            running: prev.run,
            liveness: prev.liveness,
            listening: prev.listening,
            portOwners: prev.owners,
            artifacts: { declared, recorded },
          })
          if (artifactDrift?.kind === "artifact-stale") {
            drifts.push(artifactDrift)
            artifactStale.push({ service: name, artifact: ((artifactDrift.expected as Record<string, unknown> | undefined)?.["artifact"] as string) })
          }
        }
      }
    }
    readiness = measured
    await recordReadinessResults(opts.rootDir, opts.file, toRecord, opts.json)
    // JSON teli: kayıtlı haritalar (indirgenmiş kısa-8) + bu tur driftleri.
    const recordedJson: Record<string, Record<string, string>> = {}
    for (const svc of running) {
      if (svc.artifactDigests === undefined) continue
      recordedJson[svc.name] = Object.fromEntries(reduceArtifactMap(svc.artifactDigests).shown.map((entry) => [entry.base, entry.digest]))
    }
    artifactJson = recordedJson
  }
  const inSync = drifts.length === 0
  // G11: revision-stale advisory rides the readiness lines (display-only;
  // exits/JSON shapes unchanged — JSON consumers read revisions[].match).
  const revStale = new Set(revisions.filter((entry) => entry.match === false).map((entry) => entry.service))
  const readinessLines = readiness.map((entry) => {
    const stale = revStale.has(entry.service) ? " (revision-stale)" : ""
    return entry.ok
      ? `readiness: ${entry.service} ready${stale}`
      : entry.note.startsWith("unmeasured:")
        ? `readiness: ${entry.service} unmeasured (timeout-budget)${stale}`
        : `readiness: ${entry.service} not-ready (${entry.note})${stale}`
  })
  if (opts.json) {
    console.log(
      JSON.stringify({
        reconcile: { inSync, drifts },
        revisions,
        ...(opts.probe === true ? { readiness } : {}),
        // M-C katkımsal tel (indirgenmiş kısa-8; ham digest tele çıkmaz).
        ...(opts.probe === true ? { artifactDigests: artifactJson ?? {}, artifactStale } : {}),
      }),
    )
  } else if (inSync) {
    console.log(`in-sync: ${expected.length} services (${expected.map((svc) => svc.name).join(", ")})`)
  } else {
    for (const drift of drifts) console.log(formatDrift(drift))
  }
  if (!opts.json) {
    for (const line of revLines) console.log(line)
    for (const line of readinessLines) console.log(line)
  }
  return inSync ? 0 : 1
}

/** Probe verdict kayıtları (B1-temiz: canlı kilit → istek-kanalı; kilit
 * yoksa sessiz atlanır). Ack kaybı yalnızca uyarır, verdict'i bozmaz. */
export const recordReadinessResults = async (
  rootDir: string,
  file: string,
  results: { service: string; pid: number; ok: boolean; note: string; artifacts?: Record<string, string> }[],
  json: boolean,
): Promise<void> => {
  if (results.length === 0) return
  const { classifyLock, readSupervisorState, upPaths } = await import("./up-state")
  const { writeRequest, waitResult } = await import("./up-requests")
  try {
    const paths = upPaths(rootDir)
    if ((await classifyLock(paths.lockFile)).kind !== "live") return
    const state = await readSupervisorState(paths.supervisorFile)
    const pending: Promise<unknown>[] = []
    for (const result of results) {
      const pid = state?.services.find((entry) => entry.name === result.service)?.pid ?? result.pid
      const at = new Date().toISOString()
      pending.push(
        (async () => {
          try {
            const nonce = await writeRequest(paths.requestsDir, "readiness", result.service, file, {
              readiness: {
                pid,
                ok: result.ok,
                note: result.note,
                at,
                ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
              },
            })
            await waitResult(paths.requestsDir, nonce)
          } catch (error) {
            // M-h: bounded once-per-class (was per-service unbounded).
            if (!json) warnWriteFailed("readiness", `record unverified: ${result.service} (${error instanceof Error ? error.message : String(error)})`)
          }
        })(),
      )
    }
    await Promise.all(pending)
  } catch {
    // best-effort: verdict her durumda raporlanmıştır
  }
}
