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

export type InitOptions = { rootDir: string; force?: boolean }
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
  notes.push(`required-env list capped at ${REQUIRED_ENV_CAP}`)
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

/** Strip line comments and C-style block comments before the Spring-marker
 * test, so a comment like `// note: spring-boot` never
 * emits `bootRun`. String literals are KEPT verbatim: the real marker lives
 * inside a quoted plugin id (`id 'org.springframework.boot'`), so stripping
 * literals would erase the strong signal itself. Comment markers inside
 * strings are not treated as comments.
 * (escapes: backslash inside a literal quotes the next char; Groovy doubled
 * quotes are not honored — a rare false comment inside one only weakens a
 * marker test toward checklist-only, never invents a command.) */
const stripBuildComments = (text: string): string => {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote) {
      out += ch
      if (ch === "\\") {
        if (next !== undefined) out += next
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
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
  if (gradle !== undefined && entries.includes("pom.xml")) notes.push("pom.xml skipped (build.gradle used)")
  const buildText = (await readCapped(join(rootDir, buildFile))) ?? ""
  const spring = SPRING_MARKER.test(stripBuildComments(buildText))
  const isGradle = buildFile.startsWith("build.gradle")
  const wrapper = isGradle ? "gradlew" : "mvnw"
  const wrapperCmd = `./${wrapper}`
  const systemCmd = isGradle ? "gradle" : "mvn"
  const task = isGradle ? "bootRun" : "spring-boot:run"
  if (!spring) {
    notes.push(`${isGradle ? "gradle" : "maven"} build found but no Spring marker — no runnable command`)
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
    notes.push("python project found but no entry point ([project.scripts]/main.py/app.py) — service skipped")
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
    notes.push("package.json unreadable — skipped")
    return null
  }
  const picked = typeof scripts["dev"] === "string" && scripts["dev"] !== "" ? "dev" : typeof scripts["start"] === "string" && scripts["start"] !== "" ? "start" : null
  if (picked === null) {
    notes.push("package.json found but no run script (dev/start) — service skipped")
    return null
  }
  // Vite ports attach ONLY to vite-driven scripts: an unrelated `vite.config.*`
  // next to an `echo` dev script must not harvest its port. Mismatch is a
  // checklist note, not silence.
  const pickedBody = String(scripts[picked])
  const viteConfigs = entries.filter((entry) => /^vite\.config\.(js|ts|mjs|cjs|mts|cts)$/.test(entry)).sort()
  let port: number | undefined
  if (pickedBody.includes("vite")) {
    for (const name of viteConfigs) {
      const vite = (await readCapped(join(rootDir, name))) ?? ""
      const block = VITE_SERVER_BLOCK.exec(vite)?.[1]
      const candidate = validPort(block === undefined ? null : VITE_PORT.exec(block)?.[1])
      if (candidate !== undefined) {
        port = candidate
        break
      }
    }
  } else if (viteConfigs.length > 0) {
    notes.push(`vite.config.* found but ${picked} script does not use vite — port skipped`)
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
        ? `${name} (${services.join(", ")}) external — ow does not manage it`
        : `${name} found — ow does not manage its services`,
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

export const renderInitYaml = (detection: InitDetection): string => {
  const lines: string[] = []
  if (detection.skipped.length > 0) {
    lines.push("# ow init notes (weak signals, not written to the file):")
    for (const note of detection.skipped) lines.push(`# - ${note}`)
  }
  lines.push("services:")
  for (const service of detection.services) {
    lines.push(`  ${service.name}:`)
    lines.push(`    cmd: ${service.cmd}`)
    if (service.port !== undefined) lines.push(`    port: ${service.port}`)
    if (service.requiredEnv.length > 0) lines.push(`    required-env: [${service.requiredEnv.join(", ")}]`)
  }
  return `${lines.join("\n")}\n`
}

/** Test seam for the L4 validate-before-write order proof: production passes
 * nothing and gets `renderInitYaml`; tests may inject a faulty renderer to
 * force a validation failure and assert the disk was untouched. */
export type InitRenderInject = {
  renderYaml?: (detection: InitDetection) => string
}

/** Bounded question catalog (<=3 fixed kinds, `question:`-prefixed checklist, never
 * interactive): cwd/port confirms per service, required-env names once.
 * Free-text answers may only ever fill names/ports,
 * never commands (no answer mechanism exists in this milestone - the catalog
 * freezes the surface). */
const initQuestions = (detection: InitDetection): string[] => {
  const out: string[] = []
  for (const service of detection.services) {
    out.push(`question: is the working directory (cwd) correct for ${service.name}? If not, fix it in ow.yaml.`)
  }
  for (const service of detection.services) {
    if (service.port !== undefined) {
      out.push(`question: is port ${service.port} correct for ${service.name}? If not, fix it in ow.yaml.`)
    }
  }
  const requiredNames = [...new Set(detection.services.flatMap((service) => service.requiredEnv))]
  if (requiredNames.length > 0) {
    out.push(`question: are the required variables (${requiredNames.join(", ")}) defined in the environment?`)
  }
  return out
}

export const runInit = async (options: InitOptions, inject?: InitRenderInject): Promise<InitResult> => {
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
    return { code: 2, stdout: "", stderr: `ow: directory not found: ${rootDir}` }
  }
  const detection = await detectRepo(rootDir)
  if (detection.services.length > MAX_SERVICES) {
    return { code: 2, stdout: "", stderr: `ow: found ${detection.services.length} services, at most ${MAX_SERVICES} supported` }
  }
  if (detection.services.length === 0) {
    const notes = [...detection.skipped, ...detection.compose]
    const honest =
      detection.compose.length > 0
        ? "no runnable service recognized, no empty skeleton written"
        : "nothing recognized, no empty skeleton written"
    return { code: 0, stdout: [...notes, honest].join("\n"), stderr: "" }
  }
  let yamlExisted = false
  try {
    await readFile(yamlPath, "utf8")
    yamlExisted = true
  } catch {
    yamlExisted = false
  }
  if (yamlExisted && options.force !== true) {
    return { code: 2, stdout: "", stderr: "ow: ow.yaml already exists — use --force to overwrite" }
  }
  // Validate BEFORE touching disk (L4): render -> parse -> only
  // then backup + write. A validation failure leaves the original and
  // creates no .bak.
  const renderYaml = inject?.renderYaml ?? renderInitYaml
  const text = renderYaml(detection)
  let parsed: ReturnType<typeof parseUpFile>
  try {
    parsed = parseUpFile(text)
  } catch (error) {
    return { code: 2, stdout: "", stderr: `ow: invalid skeleton: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (yamlExisted) {
    const backup = join(rootDir, "ow.yaml.bak")
    await unlink(backup).catch(() => undefined)
    await rename(yamlPath, backup)
  }
  try {
    await writeFile(yamlPath, text, { encoding: "utf8" })
  } catch (error) {
    return { code: 1, stdout: "", stderr: `ow: cannot write ow.yaml: ${error instanceof Error ? error.message : String(error)}` }
  }
  const missing = missingRequiredEnv(parsed.services)
  const missingNames = [...new Set(missing.flatMap((entry) => entry.vars))]
  const validity =
    missingNames.length === 0
      ? `ow.yaml valid: ${parsed.services.length} services, no missing required vars`
      : `ow.yaml valid: ${parsed.services.length} services, ${missingNames.length} missing required vars: ${missingNames.join(", ")}`
  const checklist: string[] = []
  for (const note of detection.skipped) checklist.push(note)
  for (const service of detection.services) {
    if (service.port === undefined) checklist.push(`${service.name}: port not found — add port: N if needed`)
  }
  const requiredNames = [...new Set(detection.services.flatMap((service) => service.requiredEnv))]
  if (requiredNames.length > 0) checklist.push(`up will not run until required vars are set: ${requiredNames.join(", ")}`)
  for (const line of detection.compose) checklist.push(line)
  const stderrLines = formatUpWarnings(parsed.warnings)
  return {
    code: 0,
    stdout: [
      `wrote: ${yamlPath} (${parsed.services.length} services: ${parsed.services.map((s) => s.name).join(", ")})`,
      validity,
      ...checklist,
      ...initQuestions(detection),
    ].join("\n"),
    stderr: stderrLines.join("\n"),
  }
}
