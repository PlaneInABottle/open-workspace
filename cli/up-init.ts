/** `ow init`: scaffold a starter `ow.yaml` from repo detection. Detection is
 * READ-ONLY and cwd-anchored (never walks up, never execs anything, every
 * inspected file capped): commands are emitted ONLY on strong signals, weak
 * signals become `#` comments plus printed checklist lines, never invented
 * commands. Generated files contain names/commands/ports only — never secret
 * values (`required-env` carries key names, which the schema constrains to
 * identifier characters). After writing, the file is re-parsed with the real
 * `parseUpFile` + `missingRequiredEnv` and reported (reuse, don't
 * reimplement validation). */

import { lstat, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { formatUpWarnings, missingRequiredEnv, parseUpFile } from "./up-schema"

const FILE_CAP = 64 * 1024
const MAX_PY_FILES = 200
const REQUIRED_ENV_CAP = 32
const MAX_SERVICES = 32
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "target",
  "__pycache__",
  "dist",
  "build",
  ".tox",
  ".eggs",
  ".idea",
  ".vscode",
])

const SPRING_MARKER = /spring-boot|org\.springframework\.boot/
const SERVER_PORT_PROPS = /^\s*server\.port\s*[:=]\s*(\d+)\s*$/m
const PLACEHOLDER_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g
const PY_ENV_SUBSCRIPT = /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g
const PY_SCRIPTS_SECTION = /^\[project\.scripts\]\s*$/m
const PY_SCRIPT_ENTRY = /^\s*([A-Za-z0-9_-]+)\s*=\s*["'][^"']+["']\s*$/gm
const VITE_SERVER_BLOCK = /server\s*:\s*\{([^}]*)\}/
const VITE_PORT = /port\s*:\s*(\d+)/
const COMPOSE_SERVICE_LINE = /^ {2}([A-Za-z0-9_-]+):/gm

export type InitServiceKind = "java" | "python" | "node"

export type InitService = {
  name: string
  kind: InitServiceKind
  cmd: string
  port?: number
  requiredEnv: string[]
}

export type InitDetection = {
  services: InitService[]
  /** Weak signals: found but no defensible command — file comments + checklist. */
  skipped: string[]
  /** docker-compose basenames detected (never managed, checklist only). */
  compose: string[]
}

export type InitOptions = { rootDir: string; force?: boolean; tracing?: boolean }
export type InitResult = { code: number; stdout: string; stderr: string }

const readCapped = async (path: string, cap = FILE_CAP): Promise<string | null> => {
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(Math.min(cap, FILE_CAP))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

const validPort = (raw: string | null | undefined): number | undefined => {
  if (raw === null || raw === undefined) return undefined
  const num = Number(raw)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : undefined
}

const portFromProperties = (text: string): number | undefined => {
  const match = SERVER_PORT_PROPS.exec(text)
  return validPort(match?.[1])
}

/** Best-effort `server:` block port from an application yml (profile
 * variants included, exact `application.yml` preferred by caller order). */
const portFromYaml = (text: string): number | undefined => {
  const block = text.match(/^[ \t]*server:[ \t]*\n((?:[ \t]+\S[^\n]*\n?)+)/m)
  if (!block) return undefined
  const match = block[1].match(/^[ \t]*port[ \t]*:[ \t]*(\d+)\s*$/m)
  return validPort(match?.[1])
}

/** `${VAR}` without default → required; `${VAR:default}` is optional. */
const requiredFromPlaceholders = (texts: string[]): string[] => {
  const names: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER_VAR)) {
      if (match[2] === undefined && !names.includes(match[1])) names.push(match[1])
    }
  }
  return names
}

const uniqueServiceName = (base: string, taken: Set<string>): string => {
  let name = base
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}`
  taken.add(name)
  return name
}

const cappedEnvNames = (names: string[], notes: string[]): string[] => {
  if (names.length <= REQUIRED_ENV_CAP) return names
  notes.push(`required-env listesi ${REQUIRED_ENV_CAP} ile sınırlandırıldı`)
  return names.slice(0, REQUIRED_ENV_CAP)
}

const collectPyFiles = async (rootDir: string): Promise<string[]> => {
  const out: string[] = []
  const stack: string[] = [rootDir]
  while (stack.length > 0 && out.length < MAX_PY_FILES) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name.endsWith(".py") && out.length < MAX_PY_FILES) {
        out.push(full)
      }
    }
  }
  return out
}

/** First 64 KiB total across up to 200 `*.py` files; `os.environ["X"]`
 * subscripts are required, `os.getenv` is optional and never matches. */
const requiredFromPython = async (rootDir: string): Promise<string[]> => {
  const files = await collectPyFiles(rootDir)
  let budget = FILE_CAP
  let text = ""
  for (const file of files) {
    if (budget <= 0) break
    const chunk = await readCapped(file, Math.min(budget, FILE_CAP))
    if (chunk === null) continue
    text += chunk
    budget -= Buffer.byteLength(chunk, "utf8")
  }
  const names: string[] = []
  for (const match of text.matchAll(PY_ENV_SUBSCRIPT)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

const detectJava = async (
  rootDir: string,
  entries: string[],
  taken: Set<string>,
  notes: string[],
): Promise<InitService | null> => {
  const gradle = entries.filter((name) => name === "build.gradle" || name === "build.gradle.kts").sort()[0]
  const buildFile = gradle ?? (entries.includes("pom.xml") ? "pom.xml" : undefined)
  if (buildFile === undefined) return null
  if (gradle !== undefined && entries.includes("pom.xml")) notes.push("pom.xml atlandı (build.gradle kullanıldı)")
  const buildText = (await readCapped(join(rootDir, buildFile))) ?? ""
  const spring = SPRING_MARKER.test(buildText)
  const isGradle = buildFile.startsWith("build.gradle")
  const wrapper = isGradle ? "gradlew" : "mvnw"
  const wrapperCmd = `./${wrapper}`
  const systemCmd = isGradle ? "gradle" : "mvn"
  const task = isGradle ? "bootRun" : "spring-boot:run"
  if (!spring) {
    notes.push(`${isGradle ? "gradle" : "maven"} derlemesi bulundu ama Spring işareti yok — çalıştırma komutu çıkarılamadı`)
    return null
  }
  const cmd = (await isExecutableFile(join(rootDir, wrapper))) ? `${wrapperCmd} ${task}` : `${systemCmd} ${task}`
  let port: number | undefined
  const configTexts: string[] = []
  try {
    const resources = await readdir(join(rootDir, "src", "main", "resources"))
    const candidates = resources
      .filter((name) => /^application[^/]*\.(properties|ya?ml)$/.test(name))
      .sort((a, b) => {
        const rank = (name: string): number =>
          name === "application.properties" ? 0 : name === "application.yml" || name === "application.yaml" ? 1 : 2
        return rank(a) - rank(b) || (a < b ? -1 : 1)
      })
    for (const name of candidates) {
      const text = await readCapped(join(rootDir, "src", "main", "resources", name))
      if (text === null) continue
      configTexts.push(text)
      if (port === undefined) {
        port = name.endsWith(".properties") ? portFromProperties(text) : portFromYaml(text)
      }
    }
  } catch {
    // no resources dir — port stays omitted, never guessed
  }
  return {
    name: uniqueServiceName("api", taken),
    kind: "java",
    cmd,
    ...(port === undefined ? {} : { port }),
    requiredEnv: cappedEnvNames(requiredFromPlaceholders(configTexts), notes),
  }
}

const detectPython = async (
  rootDir: string,
  entries: string[],
  taken: Set<string>,
  notes: string[],
): Promise<InitService | null> => {
  const hasPyproject = entries.includes("pyproject.toml")
  const hasRequirements = entries.some((name) => /^requirements.*\.txt$/.test(name))
  const hasSetup = entries.includes("setup.py")
  if (!hasPyproject && !hasRequirements && !hasSetup) return null
  const uv = entries.includes("uv.lock") || entries.includes(".venv")
  let entry: string | null = null
  if (hasPyproject) {
    const text = (await readCapped(join(rootDir, "pyproject.toml"))) ?? ""
    const section = text.match(PY_SCRIPTS_SECTION)
    if (section?.index !== undefined) {
      const rest = text.slice(section.index)
      const nextHeader = rest.slice(1).search(/^\[/m)
      const block = nextHeader < 0 ? rest : rest.slice(0, nextHeader + 1)
      const names: string[] = []
      for (const match of block.matchAll(PY_SCRIPT_ENTRY)) {
        if (!names.includes(match[1])) names.push(match[1])
      }
      if (names.length > 0) entry = names[0]
    }
  }
  if (entry === null) {
    if (entries.includes("main.py")) entry = "main.py"
    else if (entries.includes("app.py")) entry = "app.py"
  }
  if (entry === null) {
    notes.push("python projesi bulundu ama giriş noktası ([project.scripts]/main.py/app.py) yok — servis eklenmedi")
    return null
  }
  const base = entry.endsWith(".py") ? (uv ? `uv run python ${entry}` : `python ${entry}`) : uv ? `uv run ${entry}` : entry
  return {
    name: uniqueServiceName("worker", taken),
    kind: "python",
    cmd: base,
    requiredEnv: cappedEnvNames(await requiredFromPython(rootDir), notes),
  }
}

const detectNode = async (
  rootDir: string,
  entries: string[],
  taken: Set<string>,
  notes: string[],
): Promise<InitService | null> => {
  if (!entries.includes("package.json")) return null
  const text = await readCapped(join(rootDir, "package.json"))
  let scripts: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text ?? "") as unknown
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["scripts"] === "object") {
      scripts = (parsed as Record<string, { scripts: Record<string, unknown> }>)["scripts"] as Record<string, unknown>
    }
  } catch {
    notes.push("package.json okunamadı — atlandı")
    return null
  }
  const picked = typeof scripts["dev"] === "string" && scripts["dev"] !== "" ? "dev" : typeof scripts["start"] === "string" && scripts["start"] !== "" ? "start" : null
  if (picked === null) {
    notes.push("package.json bulundu ama çalıştırma scripti (dev/start) yok — servis eklenmedi")
    return null
  }
  let port: number | undefined
  for (const name of entries.filter((entry) => /^vite\.config\.(js|ts|mjs|cjs|mts|cts)$/.test(entry)).sort()) {
    const vite = (await readCapped(join(rootDir, name))) ?? ""
    const block = VITE_SERVER_BLOCK.exec(vite)?.[1]
    const candidate = validPort(block === undefined ? null : VITE_PORT.exec(block)?.[1])
    if (candidate !== undefined) {
      port = candidate
      break
    }
  }
  return {
    name: uniqueServiceName("web", taken),
    kind: "node",
    cmd: `npm run ${picked}`,
    ...(port === undefined ? {} : { port }),
    requiredEnv: [],
  }
}

const detectCompose = async (rootDir: string, entries: string[]): Promise<string[]> => {
  const notes: string[] = []
  for (const name of entries.filter((entry) => /^docker-compose.*\.ya?ml$/.test(entry)).sort()) {
    const text = (await readCapped(join(rootDir, name))) ?? ""
    const services = [...text.matchAll(COMPOSE_SERVICE_LINE)].map((match) => match[1]).slice(0, 8)
    notes.push(
      services.length > 0
        ? `${name} (${services.join(", ")}) dışarıda — ow yönetmez`
        : `${name} bulundu — içindeki servisler ow tarafından yönetilmez`,
    )
  }
  return notes
}

export const detectRepo = async (rootDir: string): Promise<InitDetection> => {
  let entries: string[] = []
  try {
    entries = await readdir(rootDir)
  } catch {
    return { services: [], skipped: [], compose: [] }
  }
  const taken = new Set<string>()
  const skipped: string[] = []
  const services: InitService[] = []
  for (const service of [await detectJava(rootDir, entries, taken, skipped), await detectPython(rootDir, entries, taken, skipped), await detectNode(rootDir, entries, taken, skipped)]) {
    if (service) services.push(service)
  }
  return { services, skipped, compose: await detectCompose(rootDir, entries) }
}

const JAVA_OTEL_ENV = (service: string): string =>
  `{JAVA_TOOL_OPTIONS: "-javaagent:.ow/otel/opentelemetry-javaagent.jar", OTEL_SERVICE_NAME: ${service}, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319", OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf, OTEL_METRICS_EXPORTER: none, OTEL_LOGS_EXPORTER: none}`

const PYTHON_OTEL_ENV = (service: string): string =>
  `{OTEL_SERVICE_NAME: ${service}, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319", OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf, OTEL_METRICS_EXPORTER: none, OTEL_LOGS_EXPORTER: none}`

const tracedCmd = (service: InitService): string => {
  if (service.kind === "python") {
    // uv resolves the instrument binary inside its own env; pip/venv setups
    // carry it next to python. Checklist names the install when missing.
    return service.cmd.startsWith("uv run ") ? service.cmd.replace(/^uv run /, "uv run opentelemetry-instrument ") : `opentelemetry-instrument ${service.cmd}`
  }
  return service.cmd
}

export const renderInitYaml = (detection: InitDetection, opts: { tracing: boolean }): string => {
  const lines: string[] = []
  if (detection.skipped.length > 0) {
    lines.push("# ow init notları (dosyaya yazılmayan zayıf sinyaller):")
    for (const note of detection.skipped) lines.push(`# - ${note}`)
  }
  if (opts.tracing) lines.push("trace:\n  port: 4319")
  lines.push("services:")
  for (const service of detection.services) {
    lines.push(`  ${service.name}:`)
    lines.push(`    cmd: ${service.kind === "python" && opts.tracing ? tracedCmd(service) : service.cmd}`)
    if (service.port !== undefined) lines.push(`    port: ${service.port}`)
    if (opts.tracing && service.kind === "java") lines.push(`    env: ${JAVA_OTEL_ENV(service.name)}`)
    if (opts.tracing && service.kind === "python") lines.push(`    env: ${PYTHON_OTEL_ENV(service.name)}`)
    if (service.requiredEnv.length > 0) lines.push(`    required-env: [${service.requiredEnv.join(", ")}]`)
  }
  return `${lines.join("\n")}\n`
}

export const runInit = async (options: InitOptions): Promise<InitResult> => {
  const rootDir = options.rootDir
  const yamlPath = join(rootDir, "ow.yaml")
  let rootOk = false
  try {
    const info = await lstat(rootDir)
    rootOk = info.isDirectory() && !info.isSymbolicLink()
  } catch {
    rootOk = false
  }
  if (!rootOk) {
    return { code: 2, stdout: "", stderr: `ow: dizin bulunamadı: ${rootDir}` }
  }
  const detection = await detectRepo(rootDir)
  if (detection.services.length > MAX_SERVICES) {
    return { code: 2, stdout: "", stderr: `ow: ${detection.services.length} servis bulundu, en fazla ${MAX_SERVICES} destekleniyor` }
  }
  if (detection.services.length === 0) {
    const notes = [...detection.skipped, ...detection.compose]
    const honest =
      detection.compose.length > 0
        ? "çalıştırılabilir servis tanınmadı, boş iskelet yazılmadı"
        : "hiçbir şey tanınmadı, boş iskelet yazılmadı"
    return { code: 0, stdout: [...notes, honest].join("\n"), stderr: "" }
  }
  let existed = false
  try {
    await readFile(yamlPath, "utf8")
    existed = true
  } catch {
    existed = false
  }
  if (existed && options.force !== true) {
    return { code: 2, stdout: "", stderr: "ow: ow.yaml zaten var — üzerine yazmak için --force kullanın" }
  }
  if (existed) {
    const backup = join(rootDir, "ow.yaml.bak")
    await unlink(backup).catch(() => undefined)
    await rename(yamlPath, backup)
  }
  const text = renderInitYaml(detection, { tracing: options.tracing === true })
  try {
    await writeFile(yamlPath, text, { encoding: "utf8" })
  } catch (error) {
    return { code: 1, stdout: "", stderr: `ow: ow.yaml yazılamıyor: ${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    return { code: 2, stdout: "", stderr: `ow: geçersiz iskelet: ${error instanceof Error ? error.message : String(error)}` }
  }
  const missing = missingRequiredEnv(parsed.services)
  const missingNames = [...new Set(missing.flatMap((entry) => entry.vars))]
  const validity =
    missingNames.length === 0
      ? `ow.yaml geçerli: ${parsed.services.length} servis, eksik gerekli değişken yok`
      : `ow.yaml geçerli: ${parsed.services.length} servis, ${missingNames.length} eksik gerekli değişken: ${missingNames.join(", ")}`
  const checklist: string[] = []
  for (const note of detection.skipped) checklist.push(note)
  for (const service of detection.services) {
    if (service.port === undefined) checklist.push(`${service.name}: port bulunamadı — gerekirse port: N ekleyin`)
  }
  const requiredNames = [...new Set(detection.services.flatMap((service) => service.requiredEnv))]
  if (requiredNames.length > 0) checklist.push(`gerekli değişkenler doldurulmadan up çalışmaz: ${requiredNames.join(", ")}`)
  const hasJava = detection.services.some((service) => service.kind === "java")
  if (options.tracing === true && hasJava) {
    checklist.push("mkdir -p .ow/otel && curl -L -o .ow/otel/opentelemetry-javaagent.jar https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar")
  }
  for (const line of detection.compose) checklist.push(line)
  if (detection.services.some((service) => service.kind === "node")) {
    checklist.push("web izlemesi kod ister — env yetmez; tracing.ts tarifine bakın (cli/README.md)")
  }
  const stderrLines = formatUpWarnings(parsed.warnings)
  return {
    code: 0,
    stdout: [`yazıldı: ${yamlPath} (${parsed.services.length} servis: ${parsed.services.map((s) => s.name).join(", ")})`, validity, ...checklist].join("\n"),
    stderr: stderrLines.join("\n"),
  }
}
