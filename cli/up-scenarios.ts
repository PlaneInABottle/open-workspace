/** P2 senaryo validatoru: `<root>/ow.scenarios.yaml` v1 şema doğrulama.
 * Salt-okunur: parse + validate + services-referans kontrolü (ow.yaml
 * okunur, başka exec YOK); probe ÇALIŞTIRILMAZ, checkpoint
 * üretilmez/tüketilmez. ow.yaml şişmez — senaryolar ayrı dosyadadır.
 * Subset-YAML tek-satır kuralı geçerlidir (blok-map yazımı satırlı hata +
 * inline örnek verir). */

import { join } from "node:path"

import {
  decodeUtf8Fatal,
  isSubsetNestingError,
  parseFlowMap,
  parseSubsetYaml,
  parseUpFile,
  subsetNestingHint,
  UpSchemaError,
  type UpWarning,
  type YamlNode,
} from "./up-schema"
import { maskCmdShape } from "./up-reconcile"
import { maskSecrets } from "./up-evidence"

export const SCENARIOS_FILE_NAME = "ow.scenarios.yaml"
export const SCENARIOS_VERSION = "1"

/** Senaryo/probe adı (opak string; küçük harf ailesi). */
export const SCENARIO_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/

const BOUNDARY_NEW_BASE: ReadonlySet<string> = new Set([
  "real-read-only",
  "real-state-changing",
  "network-deny",
  "subscribed",
  "unverified",
])
/** Legacy dual-read mapping (unconditional; one `legacy-boundary` warning
 * per value per file, never a failure). */
export const BOUNDARY_LEGACY_MAP: Readonly<Record<string, string>> = {
  real: "real-state-changing",
  local: "real-read-only",
  "captured-response": "subscribed",
  fake: "unverified",
  test: "unverified",
}
/** `blocked:<reason>` suffix: reason is 1..128 chars (char count). */
export const BLOCKED_REASON_MAX_CHARS = 128
const BLOCKED_PREFIX = "blocked:"

export type NormalizedBoundary = { normalized: string; legacySource: string | null; known: boolean }

/** Reason unquoting (`blocked:"a, b"` becomes `a, b`; quoting is optional). */
const unquoteReason = (reason: string): string => {
  const t = reason.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Pure normalize (never throws): new-enum passes through, legacy maps,
 * `blocked:<reason>` is preserved, unknown/empty/malformed-blocked falls
 * back to `unverified`. Strict blocked-shape checks live in `parseScenarios`
 * (throws -> exit 1); this is the warn-class of the references step. */
export const normalizeBoundary = (raw: string): NormalizedBoundary => {
  const value = raw.trim()
  if (value.startsWith(BLOCKED_PREFIX)) {
    const reason = unquoteReason(value.slice(BLOCKED_PREFIX.length))
    if (reason.length > 0 && [...reason].length <= BLOCKED_REASON_MAX_CHARS) {
      return { normalized: `${BLOCKED_PREFIX}${reason}`, legacySource: null, known: true }
    }
    return { normalized: "unverified", legacySource: null, known: false }
  }
  if (BOUNDARY_NEW_BASE.has(value)) return { normalized: value, legacySource: null, known: true }
  const mapped = BOUNDARY_LEGACY_MAP[value]
  if (mapped !== undefined) return { normalized: mapped, legacySource: value, known: true }
  return { normalized: "unverified", legacySource: null, known: false }
}

/** Strict blocked-shape check: bare `blocked`, an empty reason, or a
 * reason over 128 chars is a schema error (exit-1 class). */
const assertBlockedShape = (raw: string, scenarioName: string): void => {
  const value = raw.trim()
  if (value !== "blocked" && !value.startsWith(BLOCKED_PREFIX)) return
  const reason = value === "blocked" ? "" : unquoteReason(value.slice(BLOCKED_PREFIX.length))
  if (reason.length === 0 || [...reason].length > BLOCKED_REASON_MAX_CHARS) {
    throw schemaError(`${scenarioName}: blocked:<reason> required (1-${BLOCKED_REASON_MAX_CHARS} chars, e.g. blocked:"maintenance work")`)
  }
}
const PROBE_TIMEOUTS: ReadonlySet<string> = new Set(["5s", "10s", "30s"])
const PROBE_DEFAULT_TIMEOUT = "10s"
const PROBE_MAX_PARTS = 16
const PROBE_MAX_PART_BYTES = 512
const SHELL_ARGV0: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"])

export type ScenarioProbe = { id: string; argv: string[]; timeout: string }

/** M6 narrowed-runner declarations (all additive, validated-only unless
 * the runner consumes them): execution mode, runner-side restore argv,
 * assertion list, and opaque track fields (async/frontend tracks read
 * their own; `ow` never acts on them). */
export type ScenarioMode = "local" | "off-local"
const SCENARIO_MODES: ReadonlySet<string> = new Set(["local", "off-local"])
export type ScenarioRestore = { argv: string[]; timeout: string }
export type ScenarioAssert =
  | { kind: "negative"; probe: string }
  | { kind: "readback-by-consumer"; probe: string; stage: string }
  | { kind: "call-count"; stage: string; count: number }
  | { kind: "budget"; ms: number }
const ASSERT_KINDS: ReadonlySet<string> = new Set(["negative", "readback-by-consumer", "call-count", "budget"])
export type ScenarioDep = { mode: ScenarioMode }

/** Explicit non-goals: these scenario keys are out of the narrowed
 * contract. Parse rejects them (schema error carrying the `non-goal:`
 * marker, which the runner maps to exit 2); `--check` reports exit 1. */
const NON_GOAL_PREFIXES: readonly string[] = ["fault", "soak", "load-test", "schedul", "deploy"]
export const isNonGoalKey = (key: string): boolean => NON_GOAL_PREFIXES.some((prefix) => key.startsWith(prefix))

const SCENARIO_KNOWN_FIELDS: readonly string[] = [
  "services",
  "boundaries",
  "targets",
  "probes",
  "checkpoints",
  "mode",
  "restore",
  "assert",
  "triggers",
  "queue",
  "webhook",
  "deps",
  "proxies",
  "apiMode",
  "browser",
  "viewport",
  "seed",
  "artifact",
  "data",
  "env_file",
]

export type Scenario = {
  name: string
  services: string[]
  boundaries: string[]
  targets: string[]
  probes: ScenarioProbe[]
  checkpoints: string[]
  mode: ScenarioMode
  restore: ScenarioRestore | null
  asserts: ScenarioAssert[]
  triggers: string[]
  queue: string | null
  webhook: string[]
  deps: ScenarioDep[]
  proxies: string[]
  apiMode: string[]
  browser: string[]
  viewport: string[]
  seed: string[]
  artifact: string[]
  data: Record<string, string> | null
  env_file: string | null
}
export type ScenariosFile = { scenarios: Scenario[]; warnings: UpWarning[] }

/** M7 data-clock expectation block (validated-only): known keys carry
 * tight 1..64ch whitespace-free strings; unknown keys warn (never
 * connect); the values are compared against the data-clock file by
 * callers, mismatches warn UNVERIFIED without changing exits. */
export const SCENARIO_DATA_KEYS: readonly string[] = [
  "schema_hash",
  "applied_head",
  "seed_profile",
  "seed_rev",
  "db_identity",
  "at",
]
export const REV_FIELD_MAX_CHARS = 64

const parseScenarioData = (
  node: YamlNode | undefined,
  name: string,
  warnings: UpWarning[],
): Record<string, string> | null => {
  if (node === undefined) return null
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw schemaError(`${name}: data must be an inline map (e.g. data: {seed_rev: 3})`)
  }
  const fields = node as Record<string, YamlNode>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!(SCENARIO_DATA_KEYS as readonly string[]).includes(key)) {
      warnings.push({ line: 0, message: `${name}: unknown data key ignored: ${key}` })
      continue
    }
    if (typeof value !== "string" || value.length === 0 || value.length > REV_FIELD_MAX_CHARS || /[\s\x00-\x1f\x7f]/.test(value)) {
      throw schemaError(`${name}: data.${key} must be a tight 1..64ch whitespace-free string`)
    }
    out[key] = value
  }
  return out
}

/** M7 scenario-level env file reference (names-only): a relative
 * in-project path. Callers validate presence and never read contents;
 * values never reach wire, state, or replay. */
const parseEnvFile = (node: YamlNode | undefined, name: string): string | null => {
  if (node === undefined) return null
  if (typeof node !== "string" || node.length === 0 || node.startsWith("/") || node.split("/").includes("..")) {
    throw schemaError(`${name}: env_file must be a relative in-project path (e.g. env_file: conf.env)`)
  }
  return node
}

const schemaError = (message: string): Error => new UpSchemaError(0, message)

/** Restore argv shape (probe limits, masked-shape log rule downstream).
 * Validated only — `ow` never spawns restore itself. Takes the parsed map
 * (a direct `restore:` value arrives pre-parsed, unlike probes nested in
 * flow lists, which stay raw strings). */
const parseRestore = (node: YamlNode | undefined, name: string): ScenarioRestore | null => {
  if (node === undefined) return null
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw schemaError(`${name}: restore must be an inline map (e.g. restore: {argv: [./restore.sh]})`)
  }
  const map = node as Record<string, YamlNode>
  const argvRaw = map["argv"]
  if (!Array.isArray(argvRaw) || argvRaw.length === 0) throw schemaError(`${name}: restore argv must be a list (at least one part)`)
  if (argvRaw.length > PROBE_MAX_PARTS) throw schemaError(`${name}: restore argv holds at most ${PROBE_MAX_PARTS} parts`)
  const argv = [...argvRaw] as string[]
  for (const part of argv) {
    if (typeof part !== "string") throw schemaError(`${name}: restore argv parts must be text`)
    if (Buffer.byteLength(part, "utf8") > PROBE_MAX_PART_BYTES) {
      throw schemaError(`${name}: restore argv part holds at most ${PROBE_MAX_PART_BYTES} bytes`)
    }
  }
  if (SHELL_ARGV0.has(argv[0])) throw schemaError(`${name}: restore argv must not start with a shell (argv list only)`)
  let timeout = PROBE_DEFAULT_TIMEOUT
  const timeoutRaw = map["timeout"]
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string" || !PROBE_TIMEOUTS.has(timeoutRaw)) {
      throw schemaError(`${name}: restore timeout must be 5s|10s|30s`)
    }
    timeout = timeoutRaw
  }
  return { argv, timeout }
}

/** Assertion declaration validation (shape + dangling probe refs fail
 * closed; unknown kinds never silently pass). */
const parseAsserts = (node: YamlNode | undefined, name: string, probeIds: Set<string>): ScenarioAssert[] => {
  if (node === undefined) return []
  if (!Array.isArray(node)) throw schemaError(`${name}: assert must be a list of inline maps`)
  return (node as YamlNode[]).map((entry) => {
    if (typeof entry !== "string") throw schemaError(`${name}: assert entry must be an inline map`)
    const trimmed = entry.trim()
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      throw schemaError(`${name}: assert entry must be an inline map (e.g. {kind: negative, probe: p})`)
    }
    const map = parseFlowMap(trimmed, 0)
    const kind = map["kind"]
    if (typeof kind !== "string" || !ASSERT_KINDS.has(kind)) {
      throw schemaError(`${name}: assert kind must be negative|readback-by-consumer|call-count|budget`)
    }
    const probeRef = (key: string): string => {
      const value = map[key]
      if (typeof value !== "string" || value.length === 0) throw schemaError(`${name}: assert ${kind} needs ${key}`)
      if (!probeIds.has(value)) throw schemaError(`${name}: assert ${kind} names unknown probe: ${value}`)
      return value
    }
    const stageOf = (): string => {
      const value = map["stage"]
      if (typeof value !== "string" || value.length === 0) throw schemaError(`${name}: assert ${kind} needs stage`)
      return value
    }
    const countOf = (key: string): number => {
      const value = map[key]
      const num = typeof value === "string" ? Number(value) : NaN
      if (!Number.isInteger(num) || num < 0) throw schemaError(`${name}: assert ${kind} needs ${key} as a non-negative integer`)
      return num
    }
    if (kind === "negative") return { kind, probe: probeRef("probe") }
    if (kind === "readback-by-consumer") return { kind, probe: probeRef("probe"), stage: stageOf() }
    if (kind === "call-count") return { kind, stage: stageOf(), count: countOf("count") }
    return { kind: "budget", ms: countOf("ms") }
  })
}

/** Async-track dep entries (mode validated, everything else opaque). */
const parseDeps = (node: YamlNode | undefined, name: string, warnings: UpWarning[]): ScenarioDep[] => {
  if (node === undefined) return []
  if (!Array.isArray(node)) throw schemaError(`${name}: deps must be a list of inline maps`)
  return (node as YamlNode[]).map((entry) => {
    if (typeof entry !== "string") throw schemaError(`${name}: deps entry must be an inline map`)
    const trimmed = entry.trim()
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      throw schemaError(`${name}: deps entry must be an inline map (e.g. {mode: local})`)
    }
    const map = parseFlowMap(trimmed, 0)
    for (const key of Object.keys(map)) {
      if (key !== "mode") warnings.push({ line: 0, message: `${name}: unknown deps field ignored: ${key}` })
    }
    const mode = map["mode"] ?? "local"
    if (typeof mode !== "string" || !SCENARIO_MODES.has(mode)) {
      throw schemaError(`${name}: deps mode must be local|off-local`)
    }
    return { mode: mode as ScenarioMode }
  })
}

/** Scalar or flow-list → string array (one scalar becomes one element). */
const asStringList = (node: YamlNode | undefined, what: string): string[] => {
  if (node === undefined) return []
  if (typeof node === "string") return [node]
  if (Array.isArray(node)) {
    for (const part of node) {
      if (typeof part !== "string") throw schemaError(`${what} must be text or a list`)
    }
    return [...node] as string[]
  }
  throw schemaError(`${what} must be text or a list`)
}

const checkName = (value: string, what: string): void => {
  if (!SCENARIO_NAME_PATTERN.test(value)) throw schemaError(`${what} name invalid: ${value} ([a-z0-9-_.], at most 64 characters)`)
}

const parseProbe = (raw: string, scenarioName: string, warnings: UpWarning[]): ScenarioProbe => {
  const trimmed = raw.trim()
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    throw schemaError(`${scenarioName}: probe must be an inline map (e.g. {id: ready, argv: [./x.sh], timeout: 10s})`)
  }
  const map = parseFlowMap(trimmed, 0)
  for (const key of Object.keys(map)) {
    if (!["id", "argv", "timeout"].includes(key)) {
      // unknown-field warn-only
      warnings.push({ line: 0, message: `${scenarioName}: unknown field ignored inside probe: ${key}` })
    }
  }
  const id = map["id"]
  if (typeof id !== "string") throw schemaError(`${scenarioName}: probe id must be text`)
  checkName(id, `${scenarioName}: probe id`)
  const argvRaw = map["argv"]
  if (argvRaw === undefined) throw schemaError(`${scenarioName}: probe argv required (id: ${id})`)
  if (!Array.isArray(argvRaw) || argvRaw.length === 0) throw schemaError(`${scenarioName}: probe argv must be a list (id: ${id})`)
  if (argvRaw.length > PROBE_MAX_PARTS) throw schemaError(`${scenarioName}: probe argv holds at most ${PROBE_MAX_PARTS} parts (id: ${id})`)
  const argv = [...argvRaw] as string[]
  for (const part of argv) {
    if (typeof part !== "string") throw schemaError(`${scenarioName}: probe argv parts must be text (id: ${id})`)
    if (Buffer.byteLength(part, "utf8") > PROBE_MAX_PART_BYTES) {
      throw schemaError(`${scenarioName}: probe argv part holds at most ${PROBE_MAX_PART_BYTES} bytes (id: ${id})`)
    }
  }
  if (SHELL_ARGV0.has(argv[0])) throw schemaError(`${scenarioName}: probe argv must not start with a shell (id: ${id}, give an argv list)`)
  const timeoutRaw = map["timeout"]
  let timeout = PROBE_DEFAULT_TIMEOUT
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string" || !PROBE_TIMEOUTS.has(timeoutRaw)) {
      throw schemaError(`${scenarioName}: probe timeout must be 5s|10s|30s (id: ${id})`)
    }
    timeout = timeoutRaw
  }
  return { id, argv, timeout }
}

/** Pure parse+validate: text → strictly-shaped file (no reference check;
 * callers combine with `validateReferences`). */
export const parseScenarios = (text: string): ScenariosFile => {
  const warnings: UpWarning[] = []
  const doc = parseSubsetYaml(text)
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "scenarios") warnings.push({ line: 0, message: `unknown top-level field ignored: ${key}` })
  }
  if (doc["version"] !== SCENARIOS_VERSION) throw schemaError("`version: 1` required")
  const raw = doc["scenarios"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw schemaError("`scenarios:` map required")
  const entries = Object.entries(raw as Record<string, YamlNode>)
  if (entries.length === 0) throw schemaError("no scenarios (empty `scenarios:`)")
  if (entries.length > 32) throw schemaError("at most 32 scenarios (v1 limit)")
  const scenarios: Scenario[] = []
  for (const [name, node] of entries) {
    checkName(name, "scenario")
    if (typeof node !== "object" || node === null || Array.isArray(node)) throw schemaError(`${name}: scenario map expected`)
    const fields = node as Record<string, YamlNode>
    for (const key of Object.keys(fields)) {
      if (isNonGoalKey(key)) {
        throw schemaError(`${name}: non-goal rejected: ${key} (fault/soak/load-test/schedule/deploy are out of scope)`)
      }
      if (!SCENARIO_KNOWN_FIELDS.includes(key)) {
        warnings.push({ line: 0, message: `${name}: unknown field ignored: ${key}` })
      }
    }
    if (fields["services"] === undefined) {
      throw schemaError(`${name}: services required (at least one ow.yaml service name)`)
    }
    const services = asStringList(fields["services"], `${name}: services`)
    // M11: explicit `services: []` is valid (no services by decision).
    // Probes stay required below, so a vacuous scenario still fails closed.
    const boundaries = asStringList(fields["boundaries"], `${name}: boundaries`)
    for (const boundary of boundaries) assertBlockedShape(boundary, name)
    const targets = asStringList(fields["targets"], `${name}: targets`)
    const checkpoints = asStringList(fields["checkpoints"], `${name}: checkpoints`)
    const probesRaw = fields["probes"]
    if (probesRaw === undefined) throw schemaError(`${name}: probes required (at least one probe)`)
    if (!Array.isArray(probesRaw) || probesRaw.length === 0) throw schemaError(`${name}: probes must be a list (at least one probe)`)
    const probes = (probesRaw as YamlNode[]).map((entry) => {
      if (typeof entry !== "string") throw schemaError(`${name}: probe must be an inline map`)
      return parseProbe(entry, name, warnings)
    })
    const probeIds = new Set(probes.map((probe) => probe.id))
    const modeRaw = fields["mode"]
    let mode: ScenarioMode = "local"
    if (modeRaw !== undefined) {
      if (typeof modeRaw !== "string" || !SCENARIO_MODES.has(modeRaw)) {
        throw schemaError(`${name}: mode must be local|off-local`)
      }
      mode = modeRaw as ScenarioMode
    }
    const restore = parseRestore(fields["restore"], name)
    const asserts = parseAsserts(fields["assert"], name, probeIds)
    const triggers = asStringList(fields["triggers"], `${name}: triggers`)
    const queueRaw = fields["queue"]
    let queue: string | null = null
    if (queueRaw !== undefined) {
      if (typeof queueRaw !== "string" || queueRaw.length === 0) throw schemaError(`${name}: queue must name a declared probe`)
      if (!probeIds.has(queueRaw)) throw schemaError(`${name}: queue names unknown probe: ${queueRaw}`)
      queue = queueRaw
    }
    const webhook = asStringList(fields["webhook"], `${name}: webhook`)
    const deps = parseDeps(fields["deps"], name, warnings)
    const proxies = asStringList(fields["proxies"], `${name}: proxies`)
    const apiMode = asStringList(fields["apiMode"], `${name}: apiMode`)
    const browser = asStringList(fields["browser"], `${name}: browser`)
    const viewport = asStringList(fields["viewport"], `${name}: viewport`)
    const seed = asStringList(fields["seed"], `${name}: seed`)
    const artifact = asStringList(fields["artifact"], `${name}: artifact`)
    const data = parseScenarioData(fields["data"], name, warnings)
    const envFile = parseEnvFile(fields["env_file"], name)
    scenarios.push({
      name, services, boundaries, targets, probes, checkpoints,
      mode, restore, asserts, triggers, queue, webhook, deps,
      proxies, apiMode, browser, viewport, seed, artifact,
      data, env_file: envFile,
    })
  }
  return { scenarios, warnings }
}

export type ReferenceCheck = {
  warnings: UpWarning[]
  unverifiedServices: string[]
  unverifiedBoundaries: string[]
  /** Per-scenario normalized boundaries (raw `boundaries` stays as-is;
   * feeds the additive `boundariesNormalized` `--json` key). */
  boundariesNormalized: { scenario: string; boundaries: string[] }[]
  /** Boundary-warning texts only (the additive `boundaryWarnings` `--json` key). */
  boundaryWarnings: string[]
}

/** Services-referans kontrolü: ow.yaml adları KNOWN ise sessiz; yoksa warn
 * + UNVERIFIED (never a failure). Boundaries are normalized to the M1
 * taxonomy: legacy values map + one `legacy-boundary` warning per value per
 * file; unknown/empty falls back to `unverified` + UNVERIFIED warning (never
 * a failure, never silent). When ow.yaml is unreadable, ALL service
 * references become UNVERIFIED (still not a failure). */
export const validateReferences = (file: ScenariosFile, owYamlText: string | null): ReferenceCheck => {
  const warnings: UpWarning[] = []
  const unverifiedServices: string[] = []
  const unverifiedBoundaries: string[] = []
  const boundariesNormalized: { scenario: string; boundaries: string[] }[] = []
  const boundaryWarnings: string[] = []
  const seenLegacy = new Set<string>()
  let known: Set<string> | null = null
  if (owYamlText !== null) {
    try {
      known = new Set(parseUpFile(owYamlText).services.map((svc) => svc.name))
    } catch {
      known = null
    }
  }
  if (known === null) warnings.push({ line: 0, message: "ow.yaml unreadable — references unverified (UNVERIFIED)" })
  for (const scenario of file.scenarios) {
    for (const svc of scenario.services) {
      if (known !== null && !known.has(svc)) {
        warnings.push({ line: 0, message: `${scenario.name}: unknown service: ${svc} (UNVERIFIED)` })
        unverifiedServices.push(`${scenario.name}:${svc}`)
      } else if (known === null) {
        unverifiedServices.push(`${scenario.name}:${svc}`)
      }
    }
    const normalized: string[] = []
    for (const boundary of scenario.boundaries) {
      const norm = normalizeBoundary(boundary)
      normalized.push(norm.normalized)
      if (norm.legacySource !== null && !seenLegacy.has(norm.legacySource)) {
        seenLegacy.add(norm.legacySource)
        const message = `legacy-boundary: ${norm.legacySource} → ${norm.normalized} (warning)`
        warnings.push({ line: 0, message })
        boundaryWarnings.push(message)
      }
      if (!norm.known) {
        // Raw value is echoed - secret-masked (unshaped values pass through).
        const message = `${scenario.name}: unknown boundaries: ${maskSecrets(boundary)} (UNVERIFIED)`
        warnings.push({ line: 0, message })
        boundaryWarnings.push(message)
        unverifiedBoundaries.push(`${scenario.name}:${boundary}`)
      }
    }
    boundariesNormalized.push({ scenario: scenario.name, boundaries: normalized })
  }
  return { warnings, unverifiedServices, unverifiedBoundaries, boundariesNormalized, boundaryWarnings }
}

export type ScenarioJson = {
  name: string
  services: string[]
  boundaries: string[]
  targets: string[]
  probes: { id: string; argvShape: string; timeout: string }[]
  checkpoints: string[]
  mode: string
  restore: { argvShape: string; timeout: string } | null
  asserts: ScenarioAssert[]
  triggers: string[]
  queue: string | null
  webhook: string[]
  deps: { mode: string }[]
  proxies: string[]
  apiMode: string[]
  browser: string[]
 viewport: string[]
  seed: string[]
  artifact: string[]
  data: Record<string, string> | null
  env_file: string | null
}

/** JSON envelope (additive): raw argv never prints (masked shape, B3);
 * targets/checkpoints are secret-masked. `boundaries` is the raw file value
 * (M1: old key unchanged - only secret-masking applied, byte-identical for
 * unshaped values); the normalized view lives in the additive
 * `boundariesNormalized` key of the `runScenariosCheck` `--json` envelope. */
export const toScenariosJson = (file: ScenariosFile): { scenarios: ScenarioJson[] } => ({
  scenarios: file.scenarios.map((scenario) => ({
    name: scenario.name,
    services: [...scenario.services],
    boundaries: scenario.boundaries.map((boundary) => maskSecrets(boundary)),
    targets: scenario.targets.map((target) => maskSecrets(target)),
    probes: scenario.probes.map((probe) => ({
      id: probe.id,
      argvShape: maskCmdShape(probe.argv) ?? "",
      timeout: probe.timeout,
    })),
    checkpoints: scenario.checkpoints.map((checkpoint) => maskSecrets(checkpoint)),
    mode: scenario.mode,
    restore: scenario.restore === null
      ? null
      : { argvShape: maskCmdShape(scenario.restore.argv) ?? "", timeout: scenario.restore.timeout },
    asserts: scenario.asserts,
    triggers: scenario.triggers.map((entry) => maskSecrets(entry)),
    queue: scenario.queue,
    webhook: scenario.webhook.map((entry) => maskSecrets(entry)),
    deps: scenario.deps.map((dep) => ({ mode: dep.mode })),
    proxies: scenario.proxies.map((entry) => maskSecrets(entry)),
    apiMode: scenario.apiMode.map((entry) => maskSecrets(entry)),
    browser: scenario.browser.map((entry) => maskSecrets(entry)),
    viewport: scenario.viewport.map((entry) => maskSecrets(entry)),
    seed: scenario.seed.map((entry) => maskSecrets(entry)),
    artifact: scenario.artifact.map((entry) => maskSecrets(entry)),
    data: scenario.data === null
      ? null
      : Object.fromEntries(Object.entries(scenario.data).map(([key, value]) => [key, maskSecrets(value)])),
    env_file: scenario.env_file === null ? null : maskSecrets(scenario.env_file),
  })),
})

/** `ow scenarios --check [--json] [--file]`: exit 0 ok (warn'la da 0),
 * 1 şema hatası, 2 kullanım. Dosya YOKSA exit 1 (`senaryo dosyası yok`):
 * `--check` doğrulama fiilidir — yanlış yolda sessiz 0 geçmemeli
 * (`checkpoints list` envanter fiilidir, yokluk orada veridir; burada
 * yokluk doğrulanacak yapıtın yokluğudur). */
export const runScenariosCheck = async (opts: { file: string; rootDir: string; json: boolean; boundariesFlag?: string }): Promise<number> => {
  const { readFileSync } = await import("node:fs")
  let text: string
  try {
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: scenario file missing: ${opts.file}`)
    } else {
      console.error(`ow: invalid scenarios file: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 1
  }
  let parsed: ScenariosFile
  try {
    parsed = parseScenarios(text)
  } catch (error) {
    console.error(`ow: invalid scenarios file: ${error instanceof Error ? error.message : String(error)}`)
    if (isSubsetNestingError(error)) console.error(subsetNestingHint)
    return 1
  }
  // M9 overlay merge hook (post-parse): flag > local convention > base.
  // Absent overlay returns the base file untouched (byte-identical
  // outputs); refusals exit here (invalid overlay under `--check` is
  // exit 1, flag misuse is exit 2).
  const { resolveOverlay, OverlayRefusal } = await import("./up-overlay")
  let merged = parsed
  let overlay: import("./up-overlay").OverlayInfo | null = null
  try {
    const resolved = await resolveOverlay({ rootDir: opts.rootDir, base: parsed, baseText: text, flagPath: opts.boundariesFlag })
    merged = resolved.merged
    overlay = resolved.overlay
  } catch (error) {
    if (error instanceof OverlayRefusal) {
      console.error(`ow: ${error.message}`)
      return error.exit
    }
    throw error
  }
  let owYamlText: string | null = null
  try {
    owYamlText = decodeUtf8Fatal(readFileSync(join(opts.rootDir, "ow.yaml")))
  } catch {
    owYamlText = null
  }
  const refs = validateReferences(merged, owYamlText)
  // `seenLegacy` is scoped across BOTH files: validation runs once over
  // the merged view, so a legacy value mapped in base never warns again
  // from the overlay (no double-warn).
  const warnings = [
    ...merged.warnings,
    ...refs.warnings,
    ...(overlay?.warnings ?? []).map((message) => ({ line: 0, message })),
  ]
  const warnLines = warnings.map((warning) => (warning.line > 0 ? `warning (line ${warning.line}): ${warning.message}` : `warning: ${warning.message}`))
  const unverified = new Set([...refs.unverifiedServices, ...refs.unverifiedBoundaries])
  const replaced = new Set(overlay?.replaced ?? [])
  if (opts.json) {
    console.log(JSON.stringify({
      file: opts.file,
      ...toScenariosJson(merged),
      boundariesNormalized: refs.boundariesNormalized.map((entry) => ({
        scenario: entry.scenario,
        boundaries: entry.boundaries.map((boundary) => maskSecrets(boundary)),
      })),
      boundaryWarnings: refs.boundaryWarnings,
      warnings,
      ...((overlay !== null && overlay.applied)
        ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources }
        : {}),
    }))
    return 0
  }
  for (const line of warnLines) console.error(line)
  for (const scenario of merged.scenarios) {
    console.log(
      `scenario: ${scenario.name} (${scenario.services.length} services, ${scenario.probes.length} probes)${replaced.has(scenario.name) ? " [overlay]" : ""}`,
    )
    for (const svc of scenario.services) {
      if (unverified.has(`${scenario.name}:${svc}`)) console.log(`UNVERIFIED: ${scenario.name}: unknown service: ${svc}`)
    }
    for (const boundary of scenario.boundaries) {
      if (unverified.has(`${scenario.name}:${boundary}`)) {
        console.log(`UNVERIFIED: ${scenario.name}: unknown boundaries: ${maskSecrets(boundary)}`)
      }
    }
  }
  return 0
}
