/** M1 salt-okunur reconcile: beklenen (ow.yaml) vs çalışan (state+lstart)
 * drift raporu. Asla mutasyon yapmaz (tanık çizgisi) — yalnızca açık
 * `ow up/restart/down <svc>` komutları önerir. exit 0 ok / 1 drift / 2 kullanım.
 * Probe çalıştırmaz (M3'e ait): tanım + son sonuç gösterilmez, yalnızca
 * `--probe` bayrağı M3'e ait olduğu için exit 2 ile reddedilir.
 * N3 bütçe notu: probe yokken ölçülmedi; toplam ≤60s sınırı M3'te uygulanır. */

import { parseUpFile, type UpService } from "./up-schema"
import { decodeUtf8Fatal } from "./up-schema"
import { readLstart, readSupervisorState, upPaths, type UpServiceState } from "./up-state"
import { tcpListening } from "./up-net"

/** Secret-shaped argv/cmd yankısı maskeli-şekildir (B3): ham değer asla
 * output/state/log'a girmez. Kurallar: `ad=değer` içinde secret-kelime
 * (`password|secret|api[_-]?key|bearer|token|credential|private_key|
 * `authorization`) → `ad=***`; secret-bayrak sonrası değer
 * (`--password hunter2`) → `***`; sağlayıcı-öneki (ghp_/sk-/xox-) ve
 * ≥32-hex gövdeler → `***`; secret-kelime içeren yalın parça → `***`.
 * Şekil korunur (parça sayısı/sırası aynı), değerler düşer. */
const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/

const maskToken = (token: string, prevIsSecretFlag: boolean): string => {
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

/** Maskeli cmd-şekli: string aynen tokenize edilir, argv listesi parça-parça. */
export const maskCmdShape = (cmd: string | string[] | undefined): string | undefined => {
  if (cmd === undefined) return undefined
  const parts = Array.isArray(cmd) ? cmd : cmd.split(/\s+/)
  let prevFlag = false
  const masked = parts.map((part) => {
    const out = maskToken(part, prevFlag)
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
    const prefix = action === "restart" ? "+ başlatılacak (restart, kayıt yok)" : "+ başlatılacak"
    return {
      lines: [`${prefix}: ${expected.name} cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
      diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), ...(expected.cwd !== undefined ? { cwd: expected.cwd } : {}), ...(expected.port !== undefined ? { port: expected.port } : {}), status: "missing" },
    }
  }
  return {
    lines: [`yeniden: ${expected.name} pid=${running.pid} lstart=eşleşti → cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
    diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), status: "running" },
  }
}

export type DriftKind =
  | "eksik"
  | "fazla"
  | "durmus"
  | "config-farkli"
  | "lstart-uyusmazligi"
  | "port-yabanci"

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
}

/** Saf drift çekirdeği: I/O yok, enjekte girdilerle test edilir. */
export const reconcileOne = (input: ReconcileInput): ReconcileDrift | null => {
  const { name, expected, running, liveness } = input
  if (expected === null && running !== null) {
    return { service: name, kind: "fazla", running: { pid: running.pid }, hint: `ow down ${name}` }
  }
  if (expected !== null && running === null) {
    return {
      service: name,
      kind: "eksik",
      expected: { cmd: maskCmdShape(expected.cmd), cwd: expected.cwd, port: expected.port },
      hint: `ow up ${name}`,
    }
  }
  if (expected === null || running === null) return null
  if (running.exitCode !== undefined) {
    return { service: name, kind: "durmus", running: { pid: running.pid, exitCode: running.exitCode }, hint: `ow restart ${name}` }
  }
  if (liveness === "lstart-mismatch") {
    return { service: name, kind: "lstart-uyusmazligi", running: { pid: running.pid }, hint: `ow down ${name} sonrası ow up ${name} (pid geri dönüşümü şüphesi)` }
  }
  if (liveness === "unknown") {
    return { service: name, kind: "durmus", running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  if (liveness === "dead") {
    return { service: name, kind: "durmus", running: { pid: running.pid }, hint: `ow restart ${name}` }
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
    return { service: name, kind: "config-farkli", expected: diffs, running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  if (
    expected.port !== undefined &&
    input.listening === true &&
    input.portOwners !== null &&
    !input.portOwners.includes(running.pid)
  ) {
    return {
      service: name,
      kind: "port-yabanci",
      running: { pid: running.pid, port: expected.port },
      hint: `port ${expected.port} yabancı dinleyici (UNVERIFIED) — kill yok, sahibi doğrulayın`,
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
  eksik: "eksik",
  fazla: "fazla",
  durmus: "durmuş",
  "config-farkli": "config-farklı",
  "lstart-uyusmazligi": "lstart-uyuşmazlığı",
  "port-yabanci": "port-yabancı",
}

export const formatDrift = (drift: ReconcileDrift): string =>
  `${DRIFT_TR[drift.kind]}: ${drift.service} → ${drift.hint}`

/** Salt-okunur `reconcile --check` koşusu: exit 0 sync / 1 drift / 2 kullanım. */
export const runReconcileCheck = async (opts: { rootDir: string; file: string; json: boolean }): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml bulunamadı: ${opts.file}`)
    } else {
      console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: okunamıyor: supervisor.json bozuk — `down --rm` ile temizleyin")
      return 1
    }
  }
  const running = state?.services ?? []
  const names = [...new Set([...expected.map((svc) => svc.name), ...running.map((svc) => svc.name)])].sort()
  const drifts: ReconcileDrift[] = []
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
  }
  const inSync = drifts.length === 0
  if (opts.json) {
    console.log(JSON.stringify({ reconcile: { inSync, drifts } }))
  } else if (inSync) {
    console.log(`uyumlu: ${expected.length} servis (${expected.map((svc) => svc.name).join(", ")})`)
  } else {
    for (const drift of drifts) console.log(formatDrift(drift))
  }
  return inSync ? 0 : 1
}
