/** M5 `ow contract check`: digest-compare + ship-order gate. Pure witness
 * (no exec anywhere on this verb): recompute each deterministic scenario's
 * definition digest from the file and compare against the recorded
 * contract hash. Unknown hash and incomplete provenance fail closed;
 * state-changing/blocked scenarios refuse the whole command (exit 2).
 * Unverified-only scenarios pass vacuous (M1 never-fail preserved). */

import { decodeUtf8Fatal } from "./up-schema"
import { normalizeBoundary, parseScenarios } from "./up-scenarios"
import { maskSecrets } from "./up-evidence"
import {
  readReplayFile,
  replayLocation,
  scenarioDefinitionHash,
  validateProvenance,
} from "./up-replay"

export type ContractVerdict =
  | { status: "match"; expected: string; recorded: string }
  | { status: "mismatch"; expected: string; recorded: string }
  | { status: "unknown" }
  | { status: "provenance-bad" }

/** Shared compare kernel (single definition site for `contract check`
 * and `scenario run` — the runner surfaces but never duplicates this
 * logic): resolve the record by scenario name + boundary set, validate
 * provenance, compare definition digests. No rendering here. */
export const readContractVerdict = async (
  rootDir: string,
  scenario: { name: string; boundaries: string[]; services: string[]; targets: string[]; probes: { id: string; argv: string[]; timeout: string }[]; checkpoints: string[] },
): Promise<ContractVerdict> => {
  const location = replayLocation(rootDir, scenario)
  if (location === null) return { status: "unknown" }
  const digest = scenarioDefinitionHash(scenario)
  const stored = await readReplayFile(location.file)
  if (stored === null) return { status: "unknown" }
  const provenance = (stored.envelope as { provenance?: unknown } | null)?.provenance
  if (!validateProvenance(provenance)) return { status: "provenance-bad" }
  const recorded = (stored.envelope.contract as { hash?: unknown } | undefined)?.hash
  if (recorded === digest) return { status: "match", expected: digest, recorded: digest }
  return { status: "mismatch", expected: digest, recorded: typeof recorded === "string" ? recorded : "" }
}

const isRefusedBoundary = (normalized: string): boolean =>
  normalized === "real-state-changing" || normalized.startsWith("blocked:")

/** `ow contract check [--json] [--file]`: exit 0 match / 1 mismatch or
 * unknown hash / 2 usage or state-changing request (call site). */
export const runContractCheck = async (opts: {
  rootDir: string
  file: string
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
  let parsed: ReturnType<typeof parseScenarios>
  try {
    parsed = parseScenarios(text)
  } catch (error) {
    console.error(`ow: invalid scenarios file: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  // M9: the gate resolves through the shared overlay helper (flag > local
  // convention > base); refusals exit here with their guard code.
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
  const banner = overlayBannerLine(overlay)
  // State-changing/blocked anywhere in scope refuses the whole command:
  // a file that cannot be fully gated is never partially blessed.
  for (const scenario of parsed.scenarios) {
    for (const raw of scenario.boundaries) {
      const norm = normalizeBoundary(raw)
      if (norm.known && isRefusedBoundary(norm.normalized)) {
        console.error(`ow: no contract: ${scenario.name} (${maskSecrets(norm.normalized)}) — state-changing boundaries are not compared`)
        if (banner !== null) {
        if (opts.json) console.error(banner)
        else console.log(banner)
      }
        return 2
      }
    }
  }
  const compared: { scenario: string; hash: string; match: boolean; detail: string }[] = []
  const missing: string[] = []
  const human: string[] = []
  for (const scenario of parsed.scenarios) {
    const location = replayLocation(opts.rootDir, scenario)
    if (location === null) continue
    const verdict = await readContractVerdict(opts.rootDir, scenario)
    if (verdict.status === "unknown") {
      missing.push(scenario.name)
      human.push(`unknown-record: ${scenario.name}`)
      continue
    }
    if (verdict.status === "provenance-bad") {
      missing.push(scenario.name)
      human.push(`provenance-missing: ${scenario.name}`)
      continue
    }
    if (verdict.status === "match") {
      compared.push({ scenario: scenario.name, hash: verdict.expected.slice(0, 8), match: true, detail: "match" })
    } else {
      compared.push({ scenario: scenario.name, hash: verdict.expected.slice(0, 8), match: false, detail: "definition-changed" })
      human.push(`contract-mismatch: ${scenario.name}`)
    }
  }
  const pass = compared.every((entry) => entry.match) && missing.length === 0
  const overlayTags = overlay !== null && overlay.applied
    ? { overlayApplied: true, overlayFile: overlay.file, boundarySources: overlay.sources, overlayWarnings: overlay.warnings }
    : {}
  const overlayBanner = banner !== null ? [banner] : []
  if (opts.json) {
    console.log(JSON.stringify({ pass, compared, missing, ...overlayTags }))
    return pass ? 0 : 1
  }
  if (pass) {
    console.log(`contract: ${compared.length} scenarios match`)
    for (const line of overlayBanner) console.log(line)
    return 0
  }
  for (const line of human) console.log(line)
  for (const line of overlayBanner) console.log(line)
  return 1
}
