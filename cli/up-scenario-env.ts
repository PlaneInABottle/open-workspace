/** M10 `ow scenario env <name>`: the decided boundary matrix as
 * environment lines for app-side resolvers. ow decides, app substitutes:
 * one `OW_BOUNDARY_<NAME>=<mode>` line per boundary of the named
 * scenario, trivially eval-able by shell (`eval $(ow scenario env <name>)`).
 * Modes are closed-vocabulary only — `real-read-only | real-state-changing
 * | network-deny | subscribed | blocked | unverified` — NEVER secret
 * values, NEVER reasons, NEVER paths. Reads the MERGED matrix through the
 * M9 `resolveOverlay()` helper (flag > local convention > base; source
 * tags honored) — no reimplementation. Witness-not-actor: read-only
 * render, never spawns, never writes. */

import { join } from "node:path"

import { decodeUtf8Fatal } from "./up-schema"
import { normalizeBoundary, parseScenarios, validateReferences } from "./up-scenarios"
import { maskSecrets } from "./up-evidence"
import { INIT_INERT_MARKER } from "./up-init"

/** Closed mode vocabulary (every emitted value is a member — asserted). */
export const ENV_MODES: ReadonlySet<string> = new Set([
  "real-read-only",
  "real-state-changing",
  "network-deny",
  "subscribed",
  "blocked",
  "unverified",
])

/** Env-key transform (exact): `OW_BOUNDARY_` + uppercased mode with every
 * non-alphanumeric character folded to `_`. `real-read-only` becomes
 * `OW_BOUNDARY_REAL_READ_ONLY`; `blocked:<reason>` renders mode `blocked`
 * (the reason never reaches the key or the value). */
export const envKeyOf = (mode: string): string =>
  `OW_BOUNDARY_${mode.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

/** Raw boundary → closed mode: `blocked:<reason>` collapses to `blocked`
 * (reason stays out of env; full reasons live in `scenarios --check`);
 * unknown/empty values fall to `unverified` (M1, never a failure). */
export const modeOfBoundary = (raw: string): string => {
  const norm = normalizeBoundary(raw)
  if (norm.normalized.startsWith("blocked:")) return "blocked"
  return norm.normalized
}

export type EnvEntry = { key: string; mode: string }

/** `ow scenario env <name> [--json] [--file] [--boundaries <path>]`:
 * exit 0 render / 1 missing-or-invalid file or key collision /
 * 2 usage, unknown scenario, INERT file, or overlay-guard refusal code.
 * Human stdout stays plain `KEY=value` (eval-clean): warnings, advisories,
 * and the forgotten-overlay banner all go to stderr. `--json` prints
 * `{scenario, env}` (+ overlay source tags when applied) and nothing else
 * on stdout. */
export const runScenarioEnv = async (opts: {
  rootDir: string
  file: string
  name: string
  json: boolean
  boundariesFlag?: string
}): Promise<number> => {
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
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (firstLine.trim() === INIT_INERT_MARKER) {
    console.error(`INERT: ${opts.file}`)
    return 2
  }
  let parsed: ReturnType<typeof parseScenarios>
  try {
    parsed = parseScenarios(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("non-goal rejected")) {
      console.error(`ow: ${message}`)
      return 2
    }
    console.error(`ow: invalid scenarios file: ${message}`)
    return 1
  }
  const { resolveOverlay, OverlayRefusal, overlayBannerLine } = await import("./up-overlay")
  let overlay: import("./up-overlay").OverlayInfo | null = null
  try {
    const resolved = await resolveOverlay({ rootDir: opts.rootDir, base: parsed, baseText: text, flagPath: opts.boundariesFlag })
    parsed = resolved.merged
    overlay = resolved.overlay
  } catch (error) {
    if (error instanceof OverlayRefusal) {
      console.error(`ow: ${error.message}`)
      return error.exit
    }
    throw error
  }
  const scenario = parsed.scenarios.find((entry) => entry.name === opts.name)
  if (scenario === undefined) {
    console.error(`ow: scenario not found: ${opts.name}`)
    const banner = overlayBannerLine(overlay)
    if (banner !== null) console.error(banner)
    return 2
  }
  // Closed-vocabulary render with the exact collision rule: two boundaries
  // mapping to the same key (e.g. `[local, real-read-only]` or two
  // `blocked:` reasons) refuse exit 1 naming both sources.
  const seen = new Map<string, string>()
  const entries: EnvEntry[] = []
  for (const raw of scenario.boundaries) {
    const mode = modeOfBoundary(raw)
    if (!ENV_MODES.has(mode)) {
      console.error(`ow: internal mode error: ${maskSecrets(mode)}`)
      return 1
    }
    const key = envKeyOf(mode)
    const prior = seen.get(key)
    if (prior !== undefined) {
      console.error(`ow: duplicate env key: ${key} (from ${maskSecrets(prior)} and ${maskSecrets(raw)})`)
      return 1
    }
    seen.set(key, raw)
    entries.push({ key, mode })
  }
  let owYamlText: string | null = null
  try {
    owYamlText = decodeUtf8Fatal(readFileSync(join(opts.rootDir, "ow.yaml")))
  } catch {
    owYamlText = null
  }
  const refs = validateReferences(parsed, owYamlText)
  for (const warning of [...parsed.warnings, ...refs.warnings]) {
    console.error(warning.line > 0 ? `warning (line ${warning.line}): ${warning.message}` : `warning: ${warning.message}`)
  }
  const overlayWarnings = overlay?.warnings ?? []
  for (const line of overlayWarnings) console.error(`warning: ${line}`)
  const banner = overlayBannerLine(overlay)
  if (banner !== null) console.error(banner)
  if (opts.json) {
    console.log(JSON.stringify({
      scenario: scenario.name,
      env: Object.fromEntries(entries.map((entry) => [entry.key, entry.mode])),
      ...((overlay !== null && overlay.applied)
        ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources }
        : {}),
    }))
    return 0
  }
  for (const entry of entries) console.log(`${entry.key}=${entry.mode}`)
  return 0
}
