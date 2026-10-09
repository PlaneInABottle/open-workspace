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
    super(`${message} (satır ${line})`)
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
    throw new UpSchemaError(0, "dosya UTF-8 çözülemedi (bozuk bayt) — dosya kodlamasını düzeltin")
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
      throw new UpSchemaError(lineNo, "blok listesi desteklenmiyor (akış listesi kullanın: [a, b])")
    }
    const colon = trimmed.indexOf(":")
    if (colon < 0) throw new UpSchemaError(lineNo, "anahtar: değer bekleniyor")
    const key = unquote(trimmed.slice(0, colon).trim())
    const rest = trimmed.slice(colon + 1).trim()
    if (key.length === 0) throw new UpSchemaError(lineNo, "boş anahtar")
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].map
    if (rest.length === 0) {
      if (indent === 0 && parent !== root) throw new UpSchemaError(lineNo, `beklenmeyen girinti: ${key}`)
      // A map that only contains a block sequence is really a block list:
      // name the `- ` line instead of failing on depth.
      for (let m = n + 1; m < lines.length; m += 1) {
        const peer = stripComment(lines[m]).trim()
        if (peer.length === 0) continue
        if (peer.startsWith("- ")) {
          throw new UpSchemaError(m + 1, "blok listesi desteklenmiyor (akış listesi kullanın: [a, b])")
        }
        break
      }
      if (stack.length >= 3) throw new UpSchemaError(lineNo, `3. düzey desteklenmiyor: ${key}`)
      const child: Record<string, YamlNode> = {}
      // `hasOwn` (not `in`): `parent` is a plain `{}` so prototype names
      // like `constructor` must not read as duplicates.
      if (Object.hasOwn(parent, key)) throw new UpSchemaError(lineNo, `tekrarlanan anahtar: ${key}`)
      parent[key] = child
      stack.push({ indent, map: child })
      continue
    }
    if (Object.hasOwn(parent, key)) throw new UpSchemaError(lineNo, `tekrarlanan anahtar: ${key}`)
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
    if (colon < 0) throw new UpSchemaError(lineNo, "harita içinde anahtar: değer bekleniyor")
    const key = unquote(part.slice(0, colon).trim())
    const value = part.slice(colon + 1).trim()
    if (key.length === 0 || value.length === 0) throw new UpSchemaError(lineNo, "harita içinde boş anahtar/değer")
    if (key in out) throw new UpSchemaError(lineNo, "harita içinde tekrarlanan anahtar")
    out[key] = parseValue(value, lineNo)
  }
  return out
}

const parseEnvValue = (node: YamlNode | undefined, serviceName: string): Readonly<Record<string, string>> | undefined => {
  if (node === undefined) return undefined
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: env anahtar: değer çiftlerinden oluşan satır içi harita olmalı (ör. env: {A: b})`)
  }
  const entries = Object.entries(node)
  if (entries.length > ENV_MAX_ENTRIES) throw new UpSchemaError(0, `${serviceName}: env en fazla ${ENV_MAX_ENTRIES} anahtar olabilir`)
  const env: Record<string, string> = Object.create(null)
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw new UpSchemaError(0, `${serviceName}: env içinde geçersiz anahtar adı`)
    // Nested flow values (`{A: [x, y]}`, `{A: {B: c}}`) now survive the
    // depth-tracking split intact and arrive here as non-strings: name the
    // nesting explicitly instead of the generic scalar error.
    if (typeof value !== "string") throw new UpSchemaError(0, `${serviceName}: env içinde iç içe değer desteklenmiyor (düz metin kullanın)`)
    if (Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") > ENV_MAX_PAIR_BYTES) {
      throw new UpSchemaError(0, `${serviceName}: env bir çiftinde en fazla ${ENV_MAX_PAIR_BYTES} bayt olabilir`)
    }
    env[key] = value
  }
  return env
}

const asString = (value: YamlNode | undefined): string | null =>
  typeof value === "string" ? value : null

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
    throw new UpSchemaError(0, `${serviceName}: depends_on liste olmalı (ör. depends_on: [api])`)
  }
  if (node.length > DEPENDS_ON_MAX_NAMES) {
    throw new UpSchemaError(0, `${serviceName}: depends_on en fazla ${DEPENDS_ON_MAX_NAMES} servis olabilir`)
  }
  for (const dep of node) {
    if (typeof dep !== "string" || !SERVICE_NAME.test(dep)) {
      throw new UpSchemaError(0, `${serviceName}: depends_on içinde geçersiz servis adı`)
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
      if (dep === svc.name) throw new UpSchemaError(0, `${svc.name}: depends_on kendine olamaz`)
      if (!known.has(dep)) {
        throw new UpSchemaError(0, `${svc.name}: depends_on içinde bilinmeyen servis: ${dep} (bilinenler: ${services.map((s) => s.name).join(", ")})`)
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
    throw new UpSchemaError(0, `depends_on döngüsel: ${leftover.join(", ")} (sıralanamıyor)`)
  }
  return ordered
}

/** `required-env: [A, B]` flow list of env key names. Same key rules as
 * `env:` keys; errors never echo entries (flow lists may name sensitive
 * keys). A scalar or otherwise non-list value is a schema error. */
const parseRequiredEnv = (node: YamlNode | undefined, serviceName: string): readonly string[] | undefined => {
  if (node === undefined) return undefined
  if (!Array.isArray(node)) {
    throw new UpSchemaError(0, `${serviceName}: required-env liste olmalı (ör. required-env: [A, B])`)
  }
  if (node.length > REQUIRED_ENV_MAX_NAMES) {
    throw new UpSchemaError(0, `${serviceName}: required-env en fazla ${REQUIRED_ENV_MAX_NAMES} anahtar olabilir`)
  }
  for (const key of node) {
    if (typeof key !== "string" || !ENV_KEY.test(key)) {
      throw new UpSchemaError(0, `${serviceName}: required-env içinde geçersiz anahtar adı`)
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
    warnings.push({ line: 0, message: "trace haritası bekleniyor, yoksayıldı" })
    return undefined
  }
  let enabled = true
  let port = TRACE_DEFAULT_PORT
  for (const [key, value] of Object.entries(node)) {
    if (key === "enabled") {
      if (value === "true") enabled = true
      else if (value === "false") enabled = false
      else warnings.push({ line: 0, message: "trace: enabled true/false olmalı, yoksayıldı" })
    } else if (key === "port") {
      if (typeof value === "object") {
        warnings.push({ line: 0, message: `trace: iç içe alan yoksayıldı: ${key}` })
        continue
      }
      const parsed = parsePortValue(value, 0, warnings, "trace")
      if (parsed !== undefined) {
        if (parsed === 4318) {
          throw new UpSchemaError(0, "trace: 4318 portu dashboard için ayrılmış (önizleme portu)")
        }
        port = parsed
      }
    } else if (typeof value === "object") {
      warnings.push({ line: 0, message: `trace: iç içe alan yoksayıldı: ${key}` })
    } else {
      warnings.push({ line: 0, message: `trace: bilinmeyen alan yoksayıldı: ${key}` })
    }
  }
  return { enabled, port }
}

const parsePortValue = (value: YamlNode | undefined, line: number, warnings: UpWarning[], serviceName: string): number | undefined => {
  const take = (raw: string): number | undefined => {
    const host = raw.includes(":") ? raw.split(":")[0] : raw
    const num = Number(host.trim())
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new UpSchemaError(line, `geçersiz port: ${raw}`)
    }
    return num
  }
  if (typeof value === "string") return take(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    if (value.length > 1) warnings.push({ line, message: `${serviceName}: birden fazla port, ilki kullanılacak` })
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
    throw new UpSchemaError(0, "`services:` haritası gerekli")
  }
  for (const key of Object.keys(doc)) {
    if (key === "version") {
      warnings.push({ line: 0, message: "version yoksayıldı (v1)" })
    } else if (key !== "services" && key !== "trace") {
      warnings.push({ line: 0, message: `bilinmeyen üst alan yoksayıldı: ${key}` })
    }
  }
  const rawEntries = Object.entries(servicesRaw as Record<string, YamlNode>)
  if (rawEntries.length > 32) throw new UpSchemaError(0, "en fazla 32 servis (v1 sınırı)")
  const services: UpService[] = []
  for (const [name, node] of rawEntries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new UpSchemaError(0, `${name}: geçersiz servis adı ([A-Za-z0-9_-], en fazla 64 karakter)`)
    }
    if (typeof node !== "object" || Array.isArray(node)) {
      throw new UpSchemaError(0, `${name}: servis haritası bekleniyor`)
    }
    const fields = node as Record<string, YamlNode>
    const cmdRaw = fields["cmd"]
    const commandRaw = fields["command"]
    if (cmdRaw !== undefined && commandRaw !== undefined && JSON.stringify(cmdRaw) !== JSON.stringify(commandRaw)) {
      throw new UpSchemaError(0, `${name}: cmd ile command farklı, birini seçin`)
    }
    const cmdNode = cmdRaw ?? commandRaw
    let cmd: string | string[] | undefined
    if (typeof cmdNode === "string") {
      if (Buffer.byteLength(cmdNode, "utf8") > 8192) throw new UpSchemaError(0, `${name}: cmd 8KB sınırını aşıyor`)
      cmd = cmdNode
    } else if (Array.isArray(cmdNode)) {
      if (cmdNode.length > 32) throw new UpSchemaError(0, `${name}: cmd en fazla 32 parça olabilir`)
      cmd = [...cmdNode]
    } else if (cmdNode !== undefined) throw new UpSchemaError(0, `${name}: cmd metin ya da liste olmalı`)
    const cwdRaw = fields["cwd"] ?? fields["working_dir"]
    if (fields["cwd"] !== undefined && fields["working_dir"] !== undefined && fields["cwd"] !== fields["working_dir"]) {
      throw new UpSchemaError(0, `${name}: cwd ile working_dir farklı, birini seçin`)
    }
    const cwd = asString(cwdRaw ?? undefined) ?? undefined
    if (cwdRaw !== undefined && cwd === undefined) throw new UpSchemaError(0, `${name}: cwd metin olmalı`)
    const portRaw = fields["port"] ?? fields["ports"]
    if (fields["port"] !== undefined && fields["ports"] !== undefined) {
      throw new UpSchemaError(0, `${name}: port ile ports birlikte kullanılamaz, birini seçin`)
    }
    const port = portRaw === undefined ? undefined : parsePortValue(portRaw, 0, warnings, name)
    const logs = asString(fields["logs"] ?? undefined) ?? undefined
    if (fields["logs"] !== undefined && logs === undefined) throw new UpSchemaError(0, `${name}: logs metin olmalı`)
    if (cmd === undefined && logs === undefined) {
      throw new UpSchemaError(0, `${name}: cmd ya da logs gerekli`)
    }
    const env = parseEnvValue(fields["env"], name)
    const requiredEnv = parseRequiredEnv(fields["required-env"], name)
    const dependsOn = parseDependsOn(fields["depends_on"], name)
    for (const key of Object.keys(fields)) {
      if (!["cmd", "command", "cwd", "working_dir", "port", "ports", "logs", "env", "required-env", "depends_on"].includes(key)) {
        warnings.push({ line: 0, message: `${name}: bilinmeyen alan yoksayıldı: ${key}` })
      }
    }
    const service: UpService = { name, cmd, cwd, port, logs }
    if (env !== undefined) Object.defineProperty(service, "env", { value: env, enumerable: false })
    if (requiredEnv !== undefined) Object.defineProperty(service, "requiredEnv", { value: requiredEnv, enumerable: false })
    if (dependsOn !== undefined) service.dependsOn = dependsOn
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
  warnings.map((w) => (w.line > 0 ? `uyarı (satır ${w.line}): ${w.message}` : `uyarı: ${w.message}`))

/** True for subset-YAML nesting errors (the single-line inline trap:
 * block lists/sequences, 3rd-level maps, non-inline maps). Callers use
 * this to append the inline example hint; the `(satır N)` in the error
 * itself names the offending line. */
export const isSubsetNestingError = (error: unknown): boolean => {
  if (!(error instanceof UpSchemaError)) return false
  return /blok listesi|3\. düzey|harita içinde|satır içi harita|iç içe/.test(error.message)
}

/** Single-line inline hint for the nesting trap (stderr, Turkish). The
 * `readiness` shape is M3-owned; it appears here only as a second inline
 * example, never as accepted syntax. */
export const subsetNestingHint =
  `ipucu: iç içe haritalar tek-satır inline yazılır (ör. env: {A: "1"} ya da readiness: {probe: [...], timeout: 10s}) — örnek için ow init çıktısına bakın`
