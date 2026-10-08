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

type YamlScalar = string
type YamlNode = YamlScalar | YamlScalar[] | Record<string, YamlNode>

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

const parseFlowList = (raw: string, line: number): YamlScalar[] => {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner.length === 0) return []
  return inner.split(",").map((part) => unquote(part))
}

const indentOf = (line: string): number => line.match(/^ */)?.[0].length ?? 0

/** Minimal indented-subset YAML: `key:` maps (services → service → fields),
 * scalars, `[a, b]` flow lists, inline `{k: v}` flow maps, `#` comments. */
const parseSubsetYaml = (text: string): Record<string, YamlNode> => {
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
      parent[key] = child
      stack.push({ indent, map: child })
      continue
    }
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

const splitTopLevel = (inner: string): string[] => {
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ",") {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** Parse errors never echo the raw entry: flow maps may carry secret values. */
const parseFlowMap = (raw: string, lineNo: number): Record<string, YamlNode> => {
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
    if (typeof value !== "string") throw new UpSchemaError(0, `${serviceName}: env değerleri metin olmalı`)
    if (Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") > ENV_MAX_PAIR_BYTES) {
      throw new UpSchemaError(0, `${serviceName}: env bir çiftinde en fazla ${ENV_MAX_PAIR_BYTES} bayt olabilir`)
    }
    env[key] = value
  }
  return env
}

const asString = (value: YamlNode | undefined): string | null =>
  typeof value === "string" ? value : null

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
      if (parsed !== undefined) port = parsed
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
    for (const key of Object.keys(fields)) {
      if (!["cmd", "command", "cwd", "working_dir", "port", "ports", "logs", "env"].includes(key)) {
        warnings.push({ line: 0, message: `${name}: bilinmeyen alan yoksayıldı: ${key}` })
      }
    }
    const service: UpService = { name, cmd, cwd, port, logs }
    if (env !== undefined) Object.defineProperty(service, "env", { value: env, enumerable: false })
    services.push(service)
  }
  const trace = parseTraceBlock(doc["trace"], warnings)
  return trace === undefined ? { services, warnings } : { services, warnings, trace }
};

/** Human-readable warning lines for stderr (non-JSON mode). */
export const formatUpWarnings = (warnings: UpWarning[]): string[] =>
  warnings.map((w) => (w.line > 0 ? `uyarı (satır ${w.line}): ${w.message}` : `uyarı: ${w.message}`))
