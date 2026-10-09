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

const BOUNDARIES: ReadonlySet<string> = new Set(["real", "local", "fake", "captured-response", "test"])
const PROBE_TIMEOUTS: ReadonlySet<string> = new Set(["5s", "10s", "30s"])
const PROBE_DEFAULT_TIMEOUT = "10s"
const PROBE_MAX_PARTS = 16
const PROBE_MAX_PART_BYTES = 512
const SHELL_ARGV0: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"])

export type ScenarioProbe = { id: string; argv: string[]; timeout: string }
export type Scenario = {
  name: string
  services: string[]
  boundaries: string[]
  targets: string[]
  probes: ScenarioProbe[]
  checkpoints: string[]
}
export type ScenariosFile = { scenarios: Scenario[]; warnings: UpWarning[] }

const schemaError = (message: string): Error => new UpSchemaError(0, message)

/** Skaler ya da akış-listesi → string dizisi (tek skaler tek-eleman olur). */
const asStringList = (node: YamlNode | undefined, what: string): string[] => {
  if (node === undefined) return []
  if (typeof node === "string") return [node]
  if (Array.isArray(node)) {
    for (const part of node) {
      if (typeof part !== "string") throw schemaError(`${what} metin ya da liste olmalı`)
    }
    return [...node] as string[]
  }
  throw schemaError(`${what} metin ya da liste olmalı`)
}

const checkName = (value: string, what: string): void => {
  if (!SCENARIO_NAME_PATTERN.test(value)) throw schemaError(`${what} adı geçersiz: ${value} ([a-z0-9-_.], en fazla 64 karakter)`)
}

const parseProbe = (raw: string, scenarioName: string, warnings: UpWarning[]): ScenarioProbe => {
  const trimmed = raw.trim()
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    throw schemaError(`${scenarioName}: probe satır-içi harita olmalı (ör. {id: ready, argv: [./x.sh], timeout: 10s})`)
  }
  const map = parseFlowMap(trimmed, 0)
  for (const key of Object.keys(map)) {
    if (!["id", "argv", "timeout"].includes(key)) {
      // unknown-alan warn-only
      warnings.push({ line: 0, message: `${scenarioName}: probe içinde bilinmeyen alan yoksayıldı: ${key}` })
    }
  }
  const id = map["id"]
  if (typeof id !== "string") throw schemaError(`${scenarioName}: probe id metin olmalı`)
  checkName(id, `${scenarioName}: probe id`)
  const argvRaw = map["argv"]
  if (argvRaw === undefined) throw schemaError(`${scenarioName}: probe argv gerekli (id: ${id})`)
  if (!Array.isArray(argvRaw) || argvRaw.length === 0) throw schemaError(`${scenarioName}: probe argv liste olmalı (id: ${id})`)
  if (argvRaw.length > PROBE_MAX_PARTS) throw schemaError(`${scenarioName}: probe argv en fazla ${PROBE_MAX_PARTS} parça olabilir (id: ${id})`)
  const argv = [...argvRaw] as string[]
  for (const part of argv) {
    if (typeof part !== "string") throw schemaError(`${scenarioName}: probe argv parçaları metin olmalı (id: ${id})`)
    if (Buffer.byteLength(part, "utf8") > PROBE_MAX_PART_BYTES) {
      throw schemaError(`${scenarioName}: probe argv parçası en fazla ${PROBE_MAX_PART_BYTES} bayt olabilir (id: ${id})`)
    }
  }
  if (SHELL_ARGV0.has(argv[0])) throw schemaError(`${scenarioName}: probe argv shell ile başlayamaz (id: ${id}, argv listesi verin)`)
  const timeoutRaw = map["timeout"]
  let timeout = PROBE_DEFAULT_TIMEOUT
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string" || !PROBE_TIMEOUTS.has(timeoutRaw)) {
      throw schemaError(`${scenarioName}: probe timeout 5s|10s|30s olmalı (id: ${id})`)
    }
    timeout = timeoutRaw
  }
  return { id, argv, timeout }
}

/** Saf parse+validate: metin → şekil-sıkı dosya (referans kontrolü YOK;
 * çağrı yeri `validateReferences` ile birleştirir). */
export const parseScenarios = (text: string): ScenariosFile => {
  const warnings: UpWarning[] = []
  const doc = parseSubsetYaml(text)
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "scenarios") warnings.push({ line: 0, message: `bilinmeyen üst alan yoksayıldı: ${key}` })
  }
  if (doc["version"] !== SCENARIOS_VERSION) throw schemaError("`version: 1` gerekli")
  const raw = doc["scenarios"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw schemaError("`scenarios:` haritası gerekli")
  const entries = Object.entries(raw as Record<string, YamlNode>)
  if (entries.length === 0) throw schemaError("senaryo yok (`scenarios:` boş)")
  if (entries.length > 32) throw schemaError("en fazla 32 senaryo (v1 sınırı)")
  const scenarios: Scenario[] = []
  for (const [name, node] of entries) {
    checkName(name, "senaryo")
    if (typeof node !== "object" || node === null || Array.isArray(node)) throw schemaError(`${name}: senaryo haritası bekleniyor`)
    const fields = node as Record<string, YamlNode>
    for (const key of Object.keys(fields)) {
      if (!["services", "boundaries", "targets", "probes", "checkpoints"].includes(key)) {
        warnings.push({ line: 0, message: `${name}: bilinmeyen alan yoksayıldı: ${key}` })
      }
    }
    const services = asStringList(fields["services"], `${name}: services`)
    if (services.length === 0) throw schemaError(`${name}: services gerekli (en az bir ow.yaml servis adı)`)
    const boundaries = asStringList(fields["boundaries"], `${name}: boundaries`)
    const targets = asStringList(fields["targets"], `${name}: targets`)
    const checkpoints = asStringList(fields["checkpoints"], `${name}: checkpoints`)
    const probesRaw = fields["probes"]
    if (probesRaw === undefined) throw schemaError(`${name}: probes gerekli (en az bir probe)`)
    if (!Array.isArray(probesRaw) || probesRaw.length === 0) throw schemaError(`${name}: probes liste olmalı (en az bir probe)`)
    const probes = (probesRaw as YamlNode[]).map((entry) => {
      if (typeof entry !== "string") throw schemaError(`${name}: probe satır-içi harita olmalı`)
      return parseProbe(entry, name, warnings)
    })
    scenarios.push({ name, services, boundaries, targets, probes, checkpoints })
  }
  return { scenarios, warnings }
}

export type ReferenceCheck = { warnings: UpWarning[]; unverifiedServices: string[]; unverifiedBoundaries: string[] }

/** Services-referans kontrolü: ow.yaml adları KNOWN ise sessiz; yoksa warn
 * + UNVERIFIED (fail DEĞİL). Bilinmeyen boundaries değeri aynı sınıftır.
 * ow.yaml okunamazsa TÜM referanslar UNVERIFIED olur (fail değil). */
export const validateReferences = (file: ScenariosFile, owYamlText: string | null): ReferenceCheck => {
  const warnings: UpWarning[] = []
  const unverifiedServices: string[] = []
  const unverifiedBoundaries: string[] = []
  let known: Set<string> | null = null
  if (owYamlText !== null) {
    try {
      known = new Set(parseUpFile(owYamlText).services.map((svc) => svc.name))
    } catch {
      known = null
    }
  }
  if (known === null) warnings.push({ line: 0, message: "ow.yaml okunamadı — referanslar doğrulanamadı (UNVERIFIED)" })
  for (const scenario of file.scenarios) {
    for (const svc of scenario.services) {
      if (known !== null && !known.has(svc)) {
        warnings.push({ line: 0, message: `${scenario.name}: bilinmeyen servis: ${svc} (UNVERIFIED)` })
        unverifiedServices.push(`${scenario.name}:${svc}`)
      } else if (known === null) {
        unverifiedServices.push(`${scenario.name}:${svc}`)
      }
    }
    for (const boundary of scenario.boundaries) {
      if (!BOUNDARIES.has(boundary)) {
        warnings.push({ line: 0, message: `${scenario.name}: bilinmeyen boundaries: ${boundary} (UNVERIFIED)` })
        unverifiedBoundaries.push(`${scenario.name}:${boundary}`)
      }
    }
  }
  return { warnings, unverifiedServices, unverifiedBoundaries }
}

export type ScenarioJson = {
  name: string
  services: string[]
  boundaries: string[]
  targets: string[]
  probes: { id: string; argvShape: string; timeout: string }[]
  checkpoints: string[]
}

/** JSON zarfı (additive): argv HAM basılmaz (maskeli-şekil, B3); opak
 * targets/checkpoints secret-maskelidir. */
export const toScenariosJson = (file: ScenariosFile): { scenarios: ScenarioJson[] } => ({
  scenarios: file.scenarios.map((scenario) => ({
    name: scenario.name,
    services: [...scenario.services],
    boundaries: [...scenario.boundaries],
    targets: scenario.targets.map((target) => maskSecrets(target)),
    probes: scenario.probes.map((probe) => ({
      id: probe.id,
      argvShape: maskCmdShape(probe.argv) ?? "",
      timeout: probe.timeout,
    })),
    checkpoints: scenario.checkpoints.map((checkpoint) => maskSecrets(checkpoint)),
  })),
})

/** `ow scenarios --check [--json] [--file]`: exit 0 ok (warn'la da 0),
 * 1 şema hatası, 2 kullanım. Dosya YOKSA exit 1 (`senaryo dosyası yok`):
 * `--check` doğrulama fiilidir — yanlış yolda sessiz 0 geçmemeli
 * (`checkpoints list` envanter fiilidir, yokluk orada veridir; burada
 * yokluk doğrulanacak yapıtın yokluğudur). */
export const runScenariosCheck = async (opts: { file: string; rootDir: string; json: boolean }): Promise<number> => {
  const { readFileSync } = await import("node:fs")
  let text: string
  try {
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: senaryo dosyası yok: ${opts.file}`)
    } else {
      console.error(`ow: geçersiz senaryo dosyası: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 1
  }
  let parsed: ScenariosFile
  try {
    parsed = parseScenarios(text)
  } catch (error) {
    console.error(`ow: geçersiz senaryo dosyası: ${error instanceof Error ? error.message : String(error)}`)
    if (isSubsetNestingError(error)) console.error(subsetNestingHint)
    return 1
  }
  let owYamlText: string | null = null
  try {
    owYamlText = decodeUtf8Fatal(readFileSync(join(opts.rootDir, "ow.yaml")))
  } catch {
    owYamlText = null
  }
  const refs = validateReferences(parsed, owYamlText)
  const warnings = [...parsed.warnings, ...refs.warnings]
  const warnLines = warnings.map((warning) => (warning.line > 0 ? `uyarı (satır ${warning.line}): ${warning.message}` : `uyarı: ${warning.message}`))
  const unverified = new Set([...refs.unverifiedServices, ...refs.unverifiedBoundaries])
  if (opts.json) {
    console.log(JSON.stringify({ file: opts.file, ...toScenariosJson(parsed), warnings }))
    return 0
  }
  for (const line of warnLines) console.error(line)
  for (const scenario of parsed.scenarios) {
    console.log(
      `senaryo: ${scenario.name} (${scenario.services.length} servis, ${scenario.probes.length} probe)`,
    )
    for (const svc of scenario.services) {
      if (unverified.has(`${scenario.name}:${svc}`)) console.log(`UNVERIFIED: ${scenario.name}: bilinmeyen servis: ${svc}`)
    }
    for (const boundary of scenario.boundaries) {
      if (unverified.has(`${scenario.name}:${boundary}`)) console.log(`UNVERIFIED: ${scenario.name}: bilinmeyen boundaries: ${boundary}`)
    }
  }
  return 0
}
