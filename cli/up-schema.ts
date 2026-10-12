/** `ow.yaml` supervisor schema: subset YAML parser + validator, no dependencies.
 * Accepted subset: top-level `services:` map, 2-level service maps, scalar
 * values (plain/quoted), `[a, b]` flow lists, `#` comments. Block sequences
 * (`- item`) are rejected with a line-naming error. Unknown fields warn,
 * never fail. */

import { TRACE_DEFAULT_PORT } from "./trace-store"

export type UpService = {
  name: string
  cmd?: string | string[]
  cwd?: string
  port?: number
  logs?: string
  /** Per-service environment, merged over the inherited env. Non-enumerable so
   * serialized service listings (`up --check --json`) never carry its values. */
  env?: Readonly<Record<string, string>>
  /** Declared-must-exist env key names (`required-env: [A, B]`). Checked
   * against the merged env by `up`; non-enumerable so listings never carry
   * the field. Key names (never values) may appear in the missing-var error. */
  requiredEnv?: readonly string[]
  /** Order-only startup sequencing (`depends_on: [a, b]`): this service
   * spawns after the named services. No waiting, no health gating — a
   * dependency only sorts earlier in spawn order. Plain enumerable: names
   * are not secrets, so `up --check --json` shows them and errors name them. */
  dependsOn?: readonly string[]
  /** Project-defined readiness probe (M3, additive): single-line inline
   * flow-map only (`readiness: {probe: [...], timeout: 10s}`). Non-enumerable
   * like `env`: the raw argv may carry secrets — listings render only the
   * masked shape, never the raw argv. */
  readiness?: UpReadiness
}

/** M3 readiness definition: mandatory argv probe (≤16 parts, ≤512B each,
 * no shell), optional timeout pin, order-only TCP gate flag. */
export type UpReadiness = {
  probe: readonly string[]
  timeout: "5s" | "10s" | "30s"
  needsPort: boolean
}

export const PROBE_TIMEOUT_MS: Record<UpReadiness["timeout"], number> = { "5s": 5000, "10s": 10000, "30s": 30000 }

const PROBE_MAX_PARTS = 16
const PROBE_MAX_PART_BYTES = 512
// POSIX shell ailesi (argv[0] bunlara eşitse probe bir shell binary'sidir
// ve `-c` ile shell-semantiği kazanır — Bun.spawn kendisi yorumlamaz).
// powershell|cmd REDDEDİLDİ (gerekçe): platform macOS+Linux (POSIX,
// ROADMAP'ta Windows deferred); genişlerse liste gözden geçirilir.
const SHELL_ARGV0: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh"])

/** Shell-binary tespiti: path basename + lowercase + `.exe` sıyırma
 * (`/bin/sh`, `Sh`, `sh.exe` hepsi yakalanır; POSIX'te ters-bölü dosya
 * adıdır, ayraç sayılmaz). */
export const isShellArgv0 = (argv0: string): boolean => {
  const base = argv0.split("/").pop() ?? argv0
  return SHELL_ARGV0.has(base.toLowerCase().replace(/\.exe$/, ""))
}

/** Flat `trace:` block (`enabled`, `port` only). Absent block → undefined
 * (tracing off, a no-op); `enabled: false` → parsed but no listener. */
export type TraceConfig = { enabled: boolean; port: number }

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_MAX_ENTRIES = 64
const ENV_MAX_PAIR_BYTES = 4096

export type UpWarning = { line: number; message: string }

export type UpFile = { services: UpService[]; warnings: UpWarning[]; trace?: TraceConfig }

export class UpSchemaError extends Error {
  readonly line: number
  constructor(line: number, message: string) {
    super(`${message} (line ${line})`)
    this.name = "UpSchemaError"
    this.line = line
  }
}

export type YamlScalar = string
export type YamlNode = YamlScalar | YamlScalar[] | Record<string, YamlNode>

const stripComment = (line: string): string => {
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "#") return line.slice(0, i)
  }
  return line
}

const unquote = (raw: string): string => {
  const t = raw.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** Fatal UTF-8 decode for `ow.yaml` reads: `Buffer.toString("utf8")` silently
 * replaces undecodable bytes with U+FFFD, hiding corrupt config. Callers
 * read raw bytes and route failures to a schema/encoding error (exit 2)
 * before parsing. */
export const decodeUtf8Fatal = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new UpSchemaError(0, "file is not decodable UTF-8 (bad bytes) — fix the file encoding")
  }
}

const parseFlowList = (raw: string, line: number): YamlScalar[] => {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner.length === 0) return []
  // Quote-aware: quoted commas/empty strings/whitespace survive exactly;
  // `unquote` trims only outside the quotes, never inside.
  return splitTopLevel(inner).map((part) => unquote(part))
}

const indentOf = (line: string): number => line.match(/^ */)?.[0].length ?? 0

/** Minimal indented-subset YAML: `key:` maps (services → service → fields),
 * scalars, `[a, b]` flow lists, inline `{k: v}` flow maps, `#` comments. Exported
 * for sibling-file validation (scenarios); parsing behavior unchanged. */
export const parseSubsetYaml = (text: string): Record<string, YamlNode> => {
  const root: Record<string, YamlNode> = {}
  const stack: { indent: number; map: Record<string, YamlNode> }[] = [{ indent: -1, map: root }]
  const lines = text.split("\n")
  for (let n = 0; n < lines.length; n += 1) {
    const lineNo = n + 1
    const bare = stripComment(lines[n]).replace(/\s+$/, "")
    if (bare.trim().length === 0) continue
    const indent = indentOf(bare)
    const trimmed = bare.trim()
    if (trimmed.startsWith("- ")) {
      throw new UpSchemaError(lineNo, "block lists unsupported (use a flow list: [a, b])")
    }
    const colon = trimmed.indexOf(":")
    if (colon < 0) throw new UpSchemaError(lineNo, "key: value expected")
    const key = unquote(trimmed.slice(0, colon).trim())
    const rest = trimmed.slice(colon + 1).trim()
    if (key.length === 0) throw new UpSchemaError(lineNo, "empty key")
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].map
    if (rest.length === 0) {
      if (indent === 0 && parent !== root) throw new UpSchemaError(lineNo, `unexpected indent: ${key}`)
      // A map that only contains a block sequence is really a block list:
      // name the `- ` line instead of failing on depth.
      for (let m = n + 1; m < lines.length; m += 1) {
        const peer = stripComment(lines[m]).trim()
        if (peer.length === 0) continue
        if (peer.startsWith("- ")) {
          throw new UpSchemaError(m + 1, "block lists unsupported (use a flow list: [a, b])")
        }
        break
      }
      if (stack.length >= 3) throw new UpSchemaError(lineNo, `level 3 unsupported: ${key}`)
      const child: Record<string, YamlNode> = {}
      // `hasOwn` (not `in`): `parent` is a plain `{}` so prototype names
      // like `constructor` must not read as duplicates.
      if (Object.hasOwn(parent, key)) throw new UpSchemaError(lineNo, `duplicate key: ${key}`)
      parent[key] = child
      stack.push({ indent, map: child })
      continue
    }
    if (Object.hasOwn(parent, key)) throw new UpSchemaError(lineNo, `duplicate key: ${key}`)
    parent[key] = parseValue(rest, lineNo)
  }
  return root
}

/** Scalar, `[a, b]` flow list, or inline `{k: v, ...}` flow map (flat only). */
const parseValue = (rest: string, lineNo: number): YamlNode => {
  if (rest.startsWith("[") && rest.endsWith("]")) return parseFlowList(rest, lineNo)
  if (rest.startsWith("{") && rest.endsWith("}")) return parseFlowMap(rest, lineNo)
  return unquote(rest)
}

/** Top-level comma split: tracks `[]`/`{}` depth so nested flow values never
 * break the outer split, and only treats a quote as opening when it starts a
 * value (empty current or after whitespace/`:`/`[`/`{`/`,`). A lone quote
 * inside an unquoted token (e.g. `it's`) stays literal, so it can never
 * swallow the rest of the map. An unbalanced quote that DID open a value
 * stays literal too (no error): the value runs to end-of-input unchanged. */
const splitTopLevel = (inner: string): string[] => {
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  let depth = 0
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      if (current.length === 0 || /[\s:\[{,]$/.test(current)) {
        quote = ch
      }
      current += ch
      continue
    }
    if (ch === "[" || ch === "{") depth += 1
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1)
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** Parse errors never echo the raw entry: flow maps may carry secret values. Exported
 * for sibling-file validation (scenario probe maps); behavior unchanged. */
export const parseFlowMap = (raw: string, lineNo: number): Record<string, YamlNode> => {
  const inner = raw.trim().slice(1, -1).trim()
  const out: Record<string, YamlNode> = Object.create(null)
  if (inner.length === 0) return out
  for (const part of splitTopLevel(inner)) {
    const colon = part.indexOf(":")
    if (colon < 0) throw new UpSchemaError(lineNo, "key: value expected inside map")
    const key = unquote(part.slice(0, colon).trim())
    const value = part.slice(colon + 1).trim()
    if (key.length === 0 || value.length === 0) throw new UpSchemaError(lineNo, "empty key/value inside map")
    if (key in out) throw new UpSchemaError(lineNo, "duplicate key inside map")
    out[key] = parseValue(value, lineNo)
  }
  return out
}

const parseEnvValue = (node: YamlNode | undefined, serviceName: string): Readonly<Record<string, string>> | undefined => {
  if (node === undefined) return undefined
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: env must be an inline map of key: value pairs (e.g. env: {A: b})`)
  }
  const entries = Object.entries(node)
  if (entries.length > ENV_MAX_ENTRIES) throw new UpSchemaError(0, `${serviceName}: env may have at most ${ENV_MAX_ENTRIES} keys`)
  const env: Record<string, string> = Object.create(null)
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw new UpSchemaError(0, `${serviceName}: invalid key name inside env`)
    // Nested flow values (`{A: [x, y]}`, `{A: {B: c}}`) now survive the
    // depth-tracking split intact and arrive here as non-strings: name the
    // nesting explicitly instead of the generic scalar error.
    if (typeof value !== "string") throw new UpSchemaError(0, `${serviceName}: nested values unsupported inside env (use plain text)`)
    if (Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") > ENV_MAX_PAIR_BYTES) {
      throw new UpSchemaError(0, `${serviceName}: one env pair may be at most ${ENV_MAX_PAIR_BYTES} bytes`)
    }
    env[key] = value
  }
  return env
}

const asString = (value: YamlNode | undefined): string | null =>
  typeof value === "string" ? value : null

/** `readiness: {probe: [...], timeout: 10s, needsPort: true}` — M3, YALNIZCA
 * tek-satır inline flow-map (N1: blok-map yazımı subset-YAML 3. düzey
 * yasağına takılır — parse hatası, exit 2). `probe` zorunlu argv listesi
 * (shell yok); `timeout` 5s|10s|30s (default 10s); `needsPort` default true
 * ve portsuz serviste şema hatasıdır. Ham argv state'e değil, yalnızca
 * çalıştırıcıya gider (listelemeler maskeli-şekil gösterir). */
const parseReadiness = (node: YamlNode | undefined, serviceName: string, port: number | undefined, warnings: UpWarning[]): UpReadiness | undefined => {
  if (node === undefined) return undefined
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: readiness must be an inline map (e.g. readiness: {probe: [./ready.sh], timeout: 10s})`)
  }
  const fields = node as Record<string, YamlNode>
  for (const key of Object.keys(fields)) {
    if (!["probe", "timeout", "needsPort"].includes(key)) {
      warnings.push({ line: 0, message: `${serviceName}: unknown field ignored inside readiness: ${key}` })
    }
  }
  const probeRaw = fields["probe"]
  if (!Array.isArray(probeRaw) || probeRaw.length === 0) {
    throw new UpSchemaError(0, `${serviceName}: readiness probe must be a list (e.g. probe: [./ready.sh, --local])`)
  }
  if (probeRaw.length > PROBE_MAX_PARTS) {
    throw new UpSchemaError(0, `${serviceName}: readiness probe may have at most ${PROBE_MAX_PARTS} parts`)
  }
  const probe = [...probeRaw]
  for (const part of probe) {
    if (typeof part !== "string") throw new UpSchemaError(0, `${serviceName}: readiness probe parts must be text`)
    if (Buffer.byteLength(part, "utf8") > PROBE_MAX_PART_BYTES) {
      throw new UpSchemaError(0, `${serviceName}: one readiness probe part may be at most ${PROBE_MAX_PART_BYTES} bytes`)
    }
  }
  if (isShellArgv0(probe[0])) {
    throw new UpSchemaError(0, `${serviceName}: readiness probe must not start with a shell (pass an argv list, no sh -c)`)
  }
  let timeout: UpReadiness["timeout"] = "10s"
  if (fields["timeout"] !== undefined) {
    const raw = fields["timeout"]
    if (raw !== "5s" && raw !== "10s" && raw !== "30s") {
      throw new UpSchemaError(0, `${serviceName}: readiness timeout must be 5s|10s|30s`)
    }
    timeout = raw
  }
  let needsPort = true
  if (fields["needsPort"] !== undefined) {
    const raw = fields["needsPort"]
    if (raw !== "true" && raw !== "false") {
      throw new UpSchemaError(0, `${serviceName}: readiness needsPort must be true/false`)
    }
    needsPort = raw === "true"
  }
  if (needsPort && port === undefined) {
    throw new UpSchemaError(0, `${serviceName}: with readiness needsPort on, no port is defined (add a port or write needsPort: false)`)
  }
  return { probe, timeout, needsPort }
}

const REQUIRED_ENV_MAX_NAMES = 32

const SERVICE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const DEPENDS_ON_MAX_NAMES = 32

/** `depends_on: [a, b]` flow list of service names (order-only spawn
 * sequencing). Same list discipline as `required-env`; unlike env keys,
 * entries name services, so errors echo them. A scalar or otherwise
 * non-list value is a schema error. */
const parseDependsOn = (node: YamlNode | undefined, serviceName: string): readonly string[] | undefined => {
  if (node === undefined) return undefined
  if (!Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: depends_on must be a list (e.g. depends_on: [api])`)
  }
  if (node.length > DEPENDS_ON_MAX_NAMES) {
    throw new UpSchemaError(0, `${serviceName}: depends_on may have at most ${DEPENDS_ON_MAX_NAMES} services`)
  }
  for (const dep of node) {
    if (typeof dep !== "string" || !SERVICE_NAME.test(dep)) {
      throw new UpSchemaError(0, `${serviceName}: invalid service name inside depends_on`)
    }
  }
  return [...node]
}

/** Unknown/self dependencies fail with the service (and the unknown name)
 * named. Runs after the full service list is known, still inside
 * `parseUpFile` — every `up` path parses before spawning anything. */
const validateDependsOn = (services: UpService[]): void => {
  const known = new Set(services.map((svc) => svc.name))
  for (const svc of services) {
    for (const dep of svc.dependsOn ?? []) {
      if (dep === svc.name) throw new UpSchemaError(0, `${svc.name}: depends_on cannot reference itself`)
      if (!known.has(dep)) {
        throw new UpSchemaError(0, `${svc.name}: unknown service inside depends_on: ${dep} (known: ${services.map((s) => s.name).join(", ")})`)
      }
    }
  }
}

/** Stable topological order (Kahn's, lowest YAML index first): dependency
 * order where declared, plain YAML order everywhere else — dep-less files
 * spawn exactly as before. Duplicate edges count once. A leftover set means
 * a dependency cycle and names its members. */
const orderServicesTopo = (services: UpService[]): UpService[] => {
  const byName = new Map(services.map((svc) => [svc.name, svc]))
  const remaining = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const svc of services) {
    const unique = [...new Set(svc.dependsOn ?? [])]
    remaining.set(svc.name, unique.length)
    for (const dep of unique) {
      const list = dependents.get(dep) ?? []
      list.push(svc.name)
      dependents.set(dep, list)
    }
  }
  const done = new Set<string>()
  const ordered: UpService[] = []
  for (;;) {
    const next = services.find((svc) => !done.has(svc.name) && (remaining.get(svc.name) ?? 0) === 0)
    if (next === undefined) break
    done.add(next.name)
    ordered.push(byName.get(next.name)!)
    for (const dependent of dependents.get(next.name) ?? []) {
      remaining.set(dependent, (remaining.get(dependent) ?? 1) - 1)
    }
  }
  if (ordered.length !== services.length) {
    const leftover = services.filter((svc) => !done.has(svc.name)).map((svc) => svc.name)
    throw new UpSchemaError(0, `depends_on is circular: ${leftover.join(", ")} (cannot be ordered)`)
  }
  return ordered
}

/** `required-env: [A, B]` flow list of env key names. Same key rules as
 * `env:` keys; errors never echo entries (flow lists may name sensitive
 * keys). A scalar or otherwise non-list value is a schema error. */
const parseRequiredEnv = (node: YamlNode | undefined, serviceName: string): readonly string[] | undefined => {
  if (node === undefined) return undefined
  if (!Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: required-env must be a list (e.g. required-env: [A, B])`)
  }
  if (node.length > REQUIRED_ENV_MAX_NAMES) {
    throw new UpSchemaError(0, `${serviceName}: required-env may have at most ${REQUIRED_ENV_MAX_NAMES} keys`)
  }
  for (const key of node) {
    if (typeof key !== "string" || !ENV_KEY.test(key)) {
      throw new UpSchemaError(0, `${serviceName}: invalid key name inside required-env`)
    }
  }
  return [...node]
}

/** Flat `trace:` block only (2nd level scalars). A non-map block, an unknown
 * key or a nested map warns and is ignored; only an invalid `port` reuses
 * the existing `geçersiz port:` hard error. */
const parseTraceBlock = (node: YamlNode | undefined, warnings: UpWarning[]): TraceConfig | undefined => {
  if (node === undefined) return undefined
  if (typeof node !== "object" || Array.isArray(node)) {
    warnings.push({ line: 0, message: "trace map expected, ignored" })
    return undefined
  }
  let enabled = true
  let port = TRACE_DEFAULT_PORT
  for (const [key, value] of Object.entries(node)) {
    if (key === "enabled") {
      if (value === "true") enabled = true
      else if (value === "false") enabled = false
      else warnings.push({ line: 0, message: "trace: enabled must be true/false, ignored" })
    } else if (key === "port") {
      if (typeof value === "object") {
        warnings.push({ line: 0, message: `trace: nested field ignored: ${key}` })
        continue
      }
      const parsed = parsePortValue(value, 0, warnings, "trace")
      if (parsed !== undefined) {
        if (parsed === 4318) {
          throw new UpSchemaError(0, "trace: port 4318 is reserved for the dashboard (preview port)")
        }
        port = parsed
      }
    } else if (typeof value === "object") {
      warnings.push({ line: 0, message: `trace: nested field ignored: ${key}` })
    } else {
      warnings.push({ line: 0, message: `trace: unknown field ignored: ${key}` })
    }
  }
  return { enabled, port }
}

const parsePortValue = (value: YamlNode | undefined, line: number, warnings: UpWarning[], serviceName: string): number | undefined => {
  const take = (raw: string): number | undefined => {
    const host = raw.includes(":") ? raw.split(":")[0] : raw
    const num = Number(host.trim())
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new UpSchemaError(line, `invalid port: ${raw}`)
    }
    return num
  }
  if (typeof value === "string") return take(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    if (value.length > 1) warnings.push({ line, message: `${serviceName}: multiple ports, the first will be used` })
    return take(value[0])
  }
  return undefined
}

/** Parse + validate `ow.yaml` text. Unknown fields warn; structural problems throw UpSchemaError. */
export const parseUpFile = (text: string): UpFile => {
  const warnings: UpWarning[] = []
  const doc = parseSubsetYaml(text)
  const servicesRaw = doc["services"]
  if (servicesRaw === undefined || typeof servicesRaw !== "object" || Array.isArray(servicesRaw)) {
    throw new UpSchemaError(0, "`services:` map required")
  }
  for (const key of Object.keys(doc)) {
    if (key === "version") {
      warnings.push({ line: 0, message: "version ignored (v1)" })
    } else if (key !== "services" && key !== "trace") {
      warnings.push({ line: 0, message: `unknown top-level field ignored: ${key}` })
    }
  }
  const rawEntries = Object.entries(servicesRaw as Record<string, YamlNode>)
  if (rawEntries.length > 32) throw new UpSchemaError(0, "at most 32 services (v1 limit)")
  const services: UpService[] = []
  for (const [name, node] of rawEntries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new UpSchemaError(0, `${name}: invalid service name ([A-Za-z0-9_-], at most 64 characters)`)
    }
    if (typeof node !== "object" || Array.isArray(node)) {
      throw new UpSchemaError(0, `${name}: service map expected`)
    }
    const fields = node as Record<string, YamlNode>
    const cmdRaw = fields["cmd"]
    const commandRaw = fields["command"]
    if (cmdRaw !== undefined && commandRaw !== undefined && JSON.stringify(cmdRaw) !== JSON.stringify(commandRaw)) {
      throw new UpSchemaError(0, `${name}: cmd and command differ, pick one`)
    }
    const cmdNode = cmdRaw ?? commandRaw
    let cmd: string | string[] | undefined
    if (typeof cmdNode === "string") {
      if (Buffer.byteLength(cmdNode, "utf8") > 8192) throw new UpSchemaError(0, `${name}: cmd exceeds the 8KB limit`)
      cmd = cmdNode
    } else if (Array.isArray(cmdNode)) {
      if (cmdNode.length > 32) throw new UpSchemaError(0, `${name}: cmd may have at most 32 parts`)
      cmd = [...cmdNode]
    } else if (cmdNode !== undefined) throw new UpSchemaError(0, `${name}: cmd must be text or a list`)
    const cwdRaw = fields["cwd"] ?? fields["working_dir"]
    if (fields["cwd"] !== undefined && fields["working_dir"] !== undefined && fields["cwd"] !== fields["working_dir"]) {
      throw new UpSchemaError(0, `${name}: cwd and working_dir differ, pick one`)
    }
    const cwd = asString(cwdRaw ?? undefined) ?? undefined
    if (cwdRaw !== undefined && cwd === undefined) throw new UpSchemaError(0, `${name}: cwd must be text`)
    const portRaw = fields["port"] ?? fields["ports"]
    if (fields["port"] !== undefined && fields["ports"] !== undefined) {
      throw new UpSchemaError(0, `${name}: port and ports cannot be combined, pick one`)
    }
    const port = portRaw === undefined ? undefined : parsePortValue(portRaw, 0, warnings, name)
    const logs = asString(fields["logs"] ?? undefined) ?? undefined
    if (fields["logs"] !== undefined && logs === undefined) throw new UpSchemaError(0, `${name}: logs must be text`)
    if (cmd === undefined && logs === undefined) {
      throw new UpSchemaError(0, `${name}: cmd ya da logs gerekli`)
    }
    const env = parseEnvValue(fields["env"], name)
    const requiredEnv = parseRequiredEnv(fields["required-env"], name)
    const dependsOn = parseDependsOn(fields["depends_on"], name)
    const readiness = parseReadiness(fields["readiness"], name, port, warnings)
    for (const key of Object.keys(fields)) {
      if (!["cmd", "command", "cwd", "working_dir", "port", "ports", "logs", "env", "required-env", "depends_on", "readiness"].includes(key)) {
        warnings.push({ line: 0, message: `${name}: unknown field ignored: ${key}` })
      }
    }
    const service: UpService = { name, cmd, cwd, port, logs }
    if (env !== undefined) Object.defineProperty(service, "env", { value: env, enumerable: false })
    if (requiredEnv !== undefined) Object.defineProperty(service, "requiredEnv", { value: requiredEnv, enumerable: false })
    if (dependsOn !== undefined) service.dependsOn = dependsOn
    if (readiness !== undefined) Object.defineProperty(service, "readiness", { value: readiness, enumerable: false })
    services.push(service)
  }
  // Order-only sequencing resolves here (the single choke point: every `up`
  // path — foreground, detached parent reporting, detached child spawning —
  // parses before touching processes), so spawn order is topo order and
  // dep-less files keep exact YAML order.
  validateDependsOn(services)
  const ordered = orderServicesTopo(services)
  const trace = parseTraceBlock(doc["trace"], warnings)
  return trace === undefined ? { services: ordered, warnings } : { services: ordered, warnings, trace }
};

/** Declared-contract check: every `required-env` name must exist in the
 * merged env (`process.env` under service `env:`). Returns service/var
 * pairs for the missing ones — key names only, never values. Services
 * without a declaration behave exactly as before. */
export const missingRequiredEnv = (services: UpService[]): { service: string; vars: string[] }[] => {
  const missing: { service: string; vars: string[] }[] = []
  for (const svc of services) {
    const required = svc.requiredEnv
    if (required === undefined || required.length === 0) continue
    const merged: Record<string, string | undefined> = { ...process.env, ...svc.env }
    const absent = required.filter((key) => merged[key] === undefined)
    if (absent.length > 0) missing.push({ service: svc.name, vars: [...absent] })
  }
  return missing
}

/** Human-readable warning lines for stderr (non-JSON mode). */
export const formatUpWarnings = (warnings: UpWarning[]): string[] =>
  warnings.map((w) => (w.line > 0 ? `warning (line ${w.line}): ${w.message}` : `warning: ${w.message}`))

/** True for subset-YAML nesting errors (the single-line inline trap:
 * block lists/sequences, 3rd-level maps, non-inline maps). Callers use
 * this to append the inline example hint; the `(satır N)` in the error
 * itself names the offending line. */
export const isSubsetNestingError = (error: unknown): boolean => {
  if (!(error instanceof UpSchemaError)) return false
  return /block lists|level 3|inside map|inline map|nested/.test(error.message)
}

/** Single-line inline hint for the nesting trap (stderr, Turkish). The
 * `readiness` shape is M3-owned; it appears here only as a second inline
 * example, never as accepted syntax. */
export const subsetNestingHint =
  `hint: nested maps must be written single-line inline (e.g. env: {A: "1"} or readiness: {probe: [...], timeout: 10s}) — see ow init output for an example`
