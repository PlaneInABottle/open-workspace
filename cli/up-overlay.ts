/** M9 overlay boundaries: local convention + explicit flag (read-only).
 * The user owns overlay files; `ow` only reads them. Three layers, fixed
 * precedence: `--boundaries <path>` flag > `<root>/.ow/boundaries.local.yaml`
 * convention > base `ow.scenarios.yaml`. Merge rule is per-scenario
 * boundaries-REPLACE (overlay lists replace base lists wholesale per
 * scenario, never union), applied post-parse through the M1
 * `normalizeBoundary` shape (values still warn+UNVERIFIED, never refuse).
 * This module is the SOLE overlay-resolution site: all six CLI readers
 * (`runScenariosCheck`, `readBoundaryClaims`/preflight+readiness,
 * provision, record, contract, scenario run) resolve through
 * `resolveOverlay()` — no per-reader reimplementation. The dashboard
 * second-read mirrors this file in `src/coordinator.ts` (CLI modules are
 * bun-only, so the server keeps a marked mirror; the flag channel does
 * not exist server-side by design).
 * Writes nothing: refusal paths never persist (validate-before-touch —
 * no `.bak`, no write of any kind). */

import { createHash } from "node:crypto"
import { lstat, open, readFile } from "node:fs/promises"
import { basename, isAbsolute, join, resolve, sep } from "node:path"

import { parseSubsetYaml, type YamlNode } from "./up-schema"
import { maskSecrets } from "./up-evidence"
import { type ScenariosFile } from "./up-scenarios"

export const OVERLAY_LOCAL_FILE = "boundaries.local.yaml"
export const OVERLAY_CONVENTION_DIR = ".ow"
/** Same kernel as the replay store (M5 shared helpers). */
export const OVERLAY_MAX_BYTES = 256 * 1024
export const OVERLAY_MAX_LINES = 500
const BLOCKED_REASON_MAX_CHARS = 128

export type OverlaySource = "base" | "local" | "flag"
export type BoundarySource = { scenario: string; boundary: string; source: OverlaySource }

export type OverlayInfo = {
  applied: boolean
  /** Basename only — raw paths never reach output. */
  file: string | null
  /** Scenario names whose boundaries came from the overlay. */
  replaced: string[]
  sources: BoundarySource[]
  /** Non-gating advisories (digest-pin drift, gitignore) — warn-only. */
  warnings: string[]
  baseDigest: string
}

/** Refusal carrying its exit: 2 = flag usage (traversal/abs/not-found),
 * 1 = overlay content refusal (secret/dangling/invalid/oversize). */
export class OverlayRefusal extends Error {
  readonly exit: 1 | 2
  constructor(message: string, exit: 1 | 2) {
    super(message)
    this.name = "OverlayRefusal"
    this.exit = exit
  }
}

export const overlayBaseDigest = (baseText: string): string =>
  createHash("sha256").update(baseText, "utf8").digest("hex")

export const overlayConventionPath = (rootDir: string): string =>
  join(rootDir, OVERLAY_CONVENTION_DIR, OVERLAY_LOCAL_FILE)

/** Path-safe overlay name echo (src/coordinator.ts safeOverlayName mirror):
 * basename segment + 64ch cap + secret-mask. Valid scenario names pass
 * through unchanged (pattern forbids separators); only malformed names
 * sanitize, and those can never match base (dangling). */
export const safeOverlayName = (name: string): string => {
  const base = name.split("/").flatMap((part) => part.split("\\")).filter((part) => part.length > 0).pop() ?? "(empty)"
  const capped = base.length > 64 ? `${base.slice(0, 64)}…` : base
  return maskSecrets(capped)
}

/** Flag-path containment guard (root-anchored): absolute paths and any
 * `..` escape refuse with exit 2, echoing the basename only (never the
 * raw path). Returns the root-anchored resolved path. */
const checkFlagPath = (rootDir: string, flagPath: string): string => {
  const base = basename(flagPath)
  const segments = flagPath.split("/").flatMap((part) => part.split("\\"))
  if (isAbsolute(flagPath) || segments.includes("..") || segments.includes("~")) {
    throw new OverlayRefusal(`overlay-refused: ${base} (path must be root-relative)`, 2)
  }
  const root = resolve(rootDir)
  const resolved = resolve(root, flagPath)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new OverlayRefusal(`overlay-refused: ${base} (path must be root-relative)`, 2)
  }
  return resolved
}

/** Bounded read (caps kernel): symlink/directory refuse, oversize
 * refuses, undecodable refuses. MEDIUM-7 symlink-aware containment: the
 * realpath must stay under rootDir (intermediate symlinks pointing
 * outside refuse even when the lexical path checks pass). No persistence
 * anywhere on this path. */
const readOverlayText = async (path: string, display: string, rootDir: string): Promise<string> => {
  let entry
  try {
    entry = await lstat(path)
  } catch {
    throw new OverlayRefusal(`overlay-refused: ${display} (not found)`, 1)
  }
  if (entry.isSymbolicLink()) throw new OverlayRefusal(`overlay-refused: ${display} (symlink not followed)`, 1)
  if (!entry.isFile()) throw new OverlayRefusal(`overlay-refused: ${display} (not a file)`, 1)
  try {
    const { realpath } = await import("node:fs/promises")
    const root = await realpath(resolve(rootDir))
    const real = await realpath(path)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new OverlayRefusal(`overlay-refused: ${display} (outside root)`, 1)
    }
  } catch (error) {
    if (error instanceof OverlayRefusal) throw error
    // Unresolvable path: the open below fails safely with (not found).
  }
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    throw new OverlayRefusal(`overlay-refused: ${display} (not found)`, 1)
  }
  try {
    const buffer = Buffer.alloc(OVERLAY_MAX_BYTES + 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > OVERLAY_MAX_BYTES) throw new OverlayRefusal(`overlay-refused: ${display} (oversize)`, 1)
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw new OverlayRefusal(`overlay-refused: ${display} (undecodable)`, 1)
    }
    if (text.split("\n").length > OVERLAY_MAX_LINES + 1) {
      throw new OverlayRefusal(`overlay-refused: ${display} (oversize)`, 1)
    }
    return text
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const blockedReasonOf = (value: string): string | null => {
  const trimmed = value.trim()
  if (trimmed !== "blocked" && !trimmed.startsWith("blocked:")) return null
  const raw = trimmed === "blocked" ? "" : trimmed.slice("blocked:".length).trim()
  const unquoted =
    raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1).trim()
      : raw
  return unquoted
}

/** Strict blocked-shape gate for overlay values (M1 `assertBlockedShape`
 * mirror): bare `blocked`, an empty reason, or a reason over 128 chars
 * refuses the overlay (exit 1). Unknown non-blocked values never refuse
 * (M1 warn+UNVERIFIED downstream). */
const checkBlockedShape = (value: string, scenario: string, display: string): void => {
  const reason = blockedReasonOf(value)
  if (reason === null) return
  if (reason.length === 0 || [...reason].length > BLOCKED_REASON_MAX_CHARS) {
    throw new OverlayRefusal(`overlay-refused: ${display} (invalid blocked shape in ${safeOverlayName(scenario)})`, 1)
  }
}

const asStringList = (node: YamlNode | undefined, scenario: string, display: string): string[] | null => {
  if (node === undefined) return null
  if (typeof node === "string") return [node]
  if (Array.isArray(node)) {
    for (const part of node) {
      if (typeof part !== "string") {
        throw new OverlayRefusal(`overlay-refused: ${display} (invalid boundaries in ${safeOverlayName(scenario)})`, 1)
      }
    }
    return [...node] as string[]
  }
  throw new OverlayRefusal(`overlay-refused: ${display} (invalid boundaries in ${safeOverlayName(scenario)})`, 1)
}

export type ParsedOverlay = {
  replacements: Map<string, string[]>
  warnings: string[]
  baseDigest: string | null
}

/** Pure overlay parse+validate (no I/O): shape errors refuse exit 1;
 * secret-shaped values refuse exit 1 (never persist-then-mask). Unknown
 * boundary VALUES are kept (M1 warn+UNVERIFIED downstream — values never
 * refuse); unknown overlay FIELDS warn-only. */
export const parseOverlayText = (text: string, display: string): ParsedOverlay => {
  const warnings: string[] = []
  let doc: Record<string, YamlNode>
  try {
    doc = parseSubsetYaml(text)
  } catch (error) {
    throw new OverlayRefusal(
      `overlay-refused: ${display} (invalid overlay file: ${maskSecrets(error instanceof Error ? error.message : String(error))})`,
      1,
    )
  }
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "scenarios" && key !== "baseDigest") {
      warnings.push(`unknown overlay field ignored: ${maskSecrets(key)}`)
    }
  }
  const version = doc["version"]
  if (version !== undefined && version !== "1") {
    throw new OverlayRefusal(`overlay-refused: ${display} (unsupported overlay version)`, 1)
  }
  const digestRaw = doc["baseDigest"]
  let baseDigest: string | null = null
  if (digestRaw !== undefined) {
    if (typeof digestRaw !== "string" || digestRaw.length === 0 || digestRaw.length > 128) {
      throw new OverlayRefusal(`overlay-refused: ${display} (invalid baseDigest)`, 1)
    }
    baseDigest = digestRaw
  }
  const raw = doc["scenarios"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OverlayRefusal(`overlay-refused: ${display} (scenarios map required)`, 1)
  }
  const entries = Object.entries(raw as Record<string, YamlNode>)
  if (entries.length === 0) throw new OverlayRefusal(`overlay-refused: ${display} (no scenarios)`, 1)
  if (entries.length > 32) throw new OverlayRefusal(`overlay-refused: ${display} (at most 32 scenarios)`, 1)
  const replacements = new Map<string, string[]>()
  for (const [name, node] of entries) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new OverlayRefusal(`overlay-refused: ${display} (scenario map expected: ${safeOverlayName(name)})`, 1)
    }
    const fields = node as Record<string, YamlNode>
    for (const key of Object.keys(fields)) {
      if (key !== "boundaries") warnings.push(`${safeOverlayName(name)}: unknown overlay field ignored: ${maskSecrets(key)}`)
    }
    // HIGH-1 fail-closed: an absent boundaries key refuses (silent emptying
    // is never intended); an explicit [] stays allowed as intentional empty.
    const boundariesRaw = asStringList(fields["boundaries"], name, display)
    if (boundariesRaw === null) {
      throw new OverlayRefusal(`overlay-refused: ${display} (boundaries required in ${safeOverlayName(name)})`, 1)
    }
    const boundaries = boundariesRaw
    for (const boundary of boundaries) {
      // Validate-before-touch: secret-shaped values refuse (exit 1) and
      // are never written anywhere (this module has no write path).
      if (maskSecrets(boundary) !== boundary) {
        throw new OverlayRefusal(`overlay-refused: ${display} (secret-shaped value)`, 1)
      }
      checkBlockedShape(boundary, name, display)
    }
    replacements.set(name, boundaries)
  }
  return { replacements, warnings, baseDigest }
}

/** Git-presence guard: when the convention file is active under a git
 * checkout whose `.gitignore` does not mention it, warn (the local file
 * is easy to forget). Gitless roots stay silent. Flag overlays are
 * explicit per invocation and never warn. */
const gitignoreWarning = async (rootDir: string): Promise<string | null> => {
  try {
    await lstat(join(rootDir, ".git"))
  } catch {
    return null
  }
  // MEDIUM-4: lstat-guarded read (a symlinked .gitignore is unverifiable —
  // skip silently rather than trusting outside content for the mention check).
  try {
    if ((await lstat(join(rootDir, ".gitignore"))).isSymbolicLink()) return null
  } catch {
    return `overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`
  }
  let ignore = ""
  try {
    ignore = (await readFile(join(rootDir, ".gitignore"), "utf8")).slice(0, 64 * 1024)
  } catch {
    return `overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`
  }
  const mentioned = ignore.split("\n").some((line) => line.trim() === OVERLAY_LOCAL_FILE || line.includes(OVERLAY_LOCAL_FILE))
  return mentioned ? null : `overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`
}

/** Forgotten-overlay banner line (null when no overlay is active):
 * provenance-bearing output emitted while an overlay is active names it.
 * Every early return after a successful resolution emits it — including
 * refusal paths derived from the merged view. */
export const overlayBannerLine = (overlay: OverlayInfo | null): string | null =>
  overlay !== null && overlay.applied && overlay.file !== null ? `overlay-active: ${overlay.file}` : null

/** Single overlay-resolution site for all six CLI readers. Returns the
 * merged file (per-scenario boundaries-REPLACE) plus source-tag info.
 * Absent overlay (no flag, no convention file) returns the base file
 * untouched (byte-identical outputs downstream). Throws OverlayRefusal
 * (exit-coded) on any guard trip. */
export const resolveOverlay = async (opts: {
  rootDir: string
  base: ScenariosFile
  baseText: string
  flagPath?: string
}): Promise<{ merged: ScenariosFile; overlay: OverlayInfo }> => {
  const baseDigest = overlayBaseDigest(opts.baseText)
  // Mask-before-emit (M5 kernel, coordinator parity): base boundaries are
  // masked everywhere pre-M9, so source tags mask at this single producer
  // — all eight readers inherit it, raw secret-shaped values never leak.
  const baseSources: BoundarySource[] = opts.base.scenarios.flatMap((scenario) =>
    scenario.boundaries.map((boundary) => ({
      scenario: maskSecrets(scenario.name),
      boundary: maskSecrets(boundary),
      source: "base" as OverlaySource,
    })),
  )
  const idle: OverlayInfo = {
    applied: false,
    file: null,
    replaced: [],
    sources: baseSources,
    warnings: [],
    baseDigest,
  }
  let text: string
  let display: string
  let kind: OverlaySource
  if (opts.flagPath !== undefined) {
    const resolved = checkFlagPath(opts.rootDir, opts.flagPath)
    display = basename(opts.flagPath)
    try {
      text = await readOverlayText(resolved, display, opts.rootDir)
    } catch (error) {
      // A missing explicit flag path is a usage error (exit 2), never a
      // silent base-only fallthrough.
      if (error instanceof OverlayRefusal && error.message.endsWith("(not found)")) {
        throw new OverlayRefusal(`overlay-refused: ${display} (not found)`, 2)
      }
      throw error
    }
    // M-i self-reference refusal: the flag must not point at the base file
    // itself (content equality — catches copies too; a self-merge would
    // falsely claim overlay-active on an identity merge).
    if (text === opts.baseText) {
      throw new OverlayRefusal(`overlay-refused: ${display} (must not point at the base file)`, 1)
    }
    kind = "flag"
  } else {
    const convention = overlayConventionPath(opts.rootDir)
    let present = true
    try {
      await lstat(convention)
    } catch {
      present = false
    }
    if (!present) return { merged: opts.base, overlay: idle }
    display = OVERLAY_LOCAL_FILE
    text = await readOverlayText(convention, display, opts.rootDir)
    kind = "local"
  }
  const parsed = parseOverlayText(text, display)
  const baseNames = new Set(opts.base.scenarios.map((scenario) => scenario.name))
  for (const name of parsed.replacements.keys()) {
    if (!baseNames.has(name)) throw new OverlayRefusal(`overlay-dangling: ${safeOverlayName(name)} (refused)`, 1)
  }
  const merged = {
    scenarios: opts.base.scenarios.map((scenario) => {
      const replacement = parsed.replacements.get(scenario.name)
      return replacement === undefined ? scenario : { ...scenario, boundaries: [...replacement] }
    }),
    warnings: opts.base.warnings,
  }
  const replaced = [...parsed.replacements.keys()]
  const sources: BoundarySource[] = merged.scenarios.flatMap((scenario) =>
    scenario.boundaries.map((boundary) => ({
      scenario: maskSecrets(scenario.name),
      boundary: maskSecrets(boundary),
      source: (replaced.includes(scenario.name) ? kind : "base") as OverlaySource,
    })),
  )
  const warnings = [...parsed.warnings]
  // Digest pin (advisory only — never fails): the overlay optionally
  // records the base digest it was written against.
  if (parsed.baseDigest !== null && parsed.baseDigest !== baseDigest) {
    warnings.push(`overlay-stale: base changed since ${parsed.baseDigest.slice(0, 8)} (warning)`)
  }
  if (kind === "local") {
    const gitWarn = await gitignoreWarning(opts.rootDir)
    if (gitWarn !== null) warnings.push(gitWarn)
  }
  return { merged, overlay: { applied: true, file: display, replaced, sources, warnings, baseDigest } }
}
