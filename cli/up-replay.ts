/** M5 replay store + `ow record`: envelope/provenance/caps/scrubber.
 * Store shape `.ow/replay/<boundary>/<hash>.jsonl` (0600, 256KB/500-line
 * caps, oldest-trimmed by the writer, atomic tmp+rename). Line 0 is the
 * provenance envelope, the rest are probe-outcome lines. The writer stores
 * outcome digests, masked shapes, and scrubbed notes - raw argv, raw
 * stdout, and absolute paths never land in the store (digest inputs live
 * in memory only). `replayedFrom` is always null on capture; it is the
 * SOLE replay-linkage mechanism (a linkage-absent record reads as live).
 * `X-Ow-Replay` is future-HTTP-only and never interpreted here: even an
 * exported `X-Ow-Replay` env value cannot become linkage. */

import { createHash } from "node:crypto"
import { chmod, mkdir, open, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { decodeUtf8Fatal, PROBE_TIMEOUT_MS } from "./up-schema"
import { normalizeBoundary as normalizeScenarioBoundary, parseScenarios } from "./up-scenarios"
import { maskCmdShape } from "./up-reconcile"
import { maskSecrets } from "./up-evidence"
import { isArtifactDigest, runProbeJob, type ProbeFn, type ProbeOutcome } from "./up-probe"

export const REPLAY_DIR_NAME = "replay"
export const REPLAY_MAX_BYTES = 256 * 1024
export const REPLAY_MAX_LINES = 500
const REPLAY_HASH_SEED = "ow-replay-v1"
const REPLAY_NOTE_MAX_CHARS = 500

/** Boundaries eligible for capture (never state-changing, never gated). */
const RECORDABLE: ReadonlySet<string> = new Set(["real-read-only", "subscribed", "network-deny"])

export const isRecordableBoundary = (normalized: string): boolean => RECORDABLE.has(normalized)

const isRefusedBoundary = (normalized: string): boolean =>
  normalized === "real-state-changing" || normalized.startsWith("blocked:")

/** sha256 hex (digests, never rendered in full outside the 0600 store). */
export const sha256hex = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex")

/** CWD-absolute paths fold to `<root>` (structural canonicalization).
 * Applied AFTER value masking (mask-before-fold): secret values die first
 * even inside paths; the residual cwd literal folds after. Digests and
 * enum literals never match either pass and travel verbatim. */
export const foldCwd = (text: string, cwd: string): string => {
  const root = cwd.endsWith("/") && cwd.length > 1 ? cwd.slice(0, -1) : cwd
  return text.split(`${root}/`).join("<root>/").split(root).join("<root>")
}

/** Canonical scenario bytes (fixed key order, file array order, raw
 * values): any definition edit changes the digest. Digest inputs stay in
 * memory - the file keeps the hex only. */
export const canonicalScenario = (scenario: {
  name: string
  services: string[]
  boundaries: string[]
  targets: string[]
  probes: { id: string; argv: string[]; timeout: string }[]
  checkpoints: string[]
}): string =>
  JSON.stringify({
    name: scenario.name,
    services: scenario.services,
    boundaries: scenario.boundaries,
    targets: scenario.targets,
    probes: scenario.probes.map((probe) => ({ id: probe.id, argv: probe.argv, timeout: probe.timeout })),
    checkpoints: scenario.checkpoints,
  })

export const scenarioDefinitionHash = (scenario: Parameters<typeof canonicalScenario>[0]): string =>
  sha256hex(canonicalScenario(scenario))

/** Runner hash: digest of the record-side runner inputs (the declared
 * probe set) that produced the fixture, computed at record time. */
export const runnerHashFor = (probes: { id: string; argv: string[]; timeout: string }[]): string =>
  sha256hex(JSON.stringify({ probes: probes.map((probe) => ({ id: probe.id, argv: probe.argv, timeout: probe.timeout })) }))

export type ReplayProvenance = {
  checkout: string
  head: string
  interpreter: string
  runnerHash: string
}

export type ReplayEnvelope = {
  v: 1
  at: string
  scenario: string
  attempt: number
  boundary: string
  boundaries: string[]
  provenance: ReplayProvenance
  replayedFrom: null | { hash: string; at: string }
  contract: { hash: string }
}

export type ReplayProbeLine = {
  id: string
  argvShape: string
  timeout: string
  ok: boolean
  note: string
  digest: string
  checks: { name: string; ok: boolean; digest?: string }[]
}

/** Fail-closed provenance gate: all four fields must be non-empty strings. */
export const validateProvenance = (value: unknown): value is ReplayProvenance => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record["checkout"] === "string" &&
    (record["checkout"] as string).length > 0 &&
    typeof record["head"] === "string" &&
    (record["head"] as string).length > 0 &&
    typeof record["interpreter"] === "string" &&
    (record["interpreter"] as string).length > 0 &&
    typeof record["runnerHash"] === "string" &&
    (record["runnerHash"] as string).length > 0
  )
}

const sanitizeDir = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_")

/** Single definition site for store placement (record + contract + M6
 * share it): dir = first recordable boundary (file order), filename binds
 * scenario name + full recordable set (sorted) - stable across definition
 * edits, so a tampered file still resolves to its record. */
export const replayLocation = (rootDir: string, scenario: { name: string; boundaries: string[] }): { dir: string; file: string; primary: string; recordable: string[] } | null => {
  const recordable: string[] = []
  for (const raw of scenario.boundaries) {
    const norm = normalizeScenarioBoundary(raw)
    if (norm.known && isRecordableBoundary(norm.normalized) && !recordable.includes(norm.normalized)) {
      recordable.push(norm.normalized)
    }
  }
  if (recordable.length === 0) return null
  const primary = recordable[0]
  const dir = join(rootDir, ".ow", REPLAY_DIR_NAME, sanitizeDir(primary))
  const hash = sha256hex(`${REPLAY_HASH_SEED}\n${scenario.name}\n${[...recordable].sort().join(",")}`)
  return { dir, file: join(dir, `${hash}.jsonl`), primary, recordable }
}

/** Atomic tmp+rename write, 0600, oldest-data-first trim to caps (the
 * envelope line is never trimmed). */
export const writeReplayFile = async (path: string, envelope: ReplayEnvelope, lines: ReplayProbeLine[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let body = [JSON.stringify(envelope), ...lines.map((line) => JSON.stringify(line))].join("\n") + "\n"
  let parts = body.split("\n")
  const over = (): boolean =>
    Buffer.byteLength(body, "utf8") > REPLAY_MAX_BYTES || parts.filter((part) => part.length > 0).length > REPLAY_MAX_LINES
  while (over() && parts.length > 2) {
    parts.splice(1, 1)
    body = `${parts.join("\n")}\n`
  }
  const temporary = join(dirname(path), `.ow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Bounded read (256KB / 500 lines): absent, over-cap-unparseable, or
 * malformed content reads as null (fail-closed upstream). Envelope
 * completeness is NOT checked here - readers distinguish the unknown-hash
 * case (null) from the provenance-missing case (present). */
export const readReplayFile = async (path: string): Promise<{ envelope: ReplayEnvelope; lines: ReplayProbeLine[] } | null> => {
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(REPLAY_MAX_BYTES + 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    const raw = text.split("\n").filter((part) => part.length > 0).slice(0, REPLAY_MAX_LINES)
    if (raw.length === 0) return null
    let envelope: ReplayEnvelope
    try {
      envelope = JSON.parse(raw[0]) as ReplayEnvelope
    } catch {
      return null
    }
    if (typeof envelope !== "object" || envelope === null) return null
    const lines: ReplayProbeLine[] = []
    for (const part of raw.slice(1)) {
      try {
        lines.push(JSON.parse(part) as ReplayProbeLine)
      } catch {
        return null
      }
    }
    return { envelope, lines }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const bunInterpreter = (): string => {
  try {
    const version = (Bun as unknown as { version?: unknown }).version
    if (typeof version === "string" && version.length > 0) return `bun/${version}`
  } catch {
    // fall through to the honest fallback below
  }
  return "bun/unknown"
}

const outcomeDigest = (line: Omit<ReplayProbeLine, "digest">): string =>
  sha256hex(JSON.stringify({ id: line.id, argvShape: line.argvShape, timeout: line.timeout, ok: line.ok, note: line.note, checks: line.checks }))

/** `ow record <run-name> [--file]`: capture one deterministic scenario's
 * declared probes once (bounded one-shot exec of declared argv only -
 * never app code beyond that) into `.ow/replay/`. Exit 0 captured /
 * 1 file-or-write problem / 2 usage-or-refusal (unknown scenario,
 * state-changing/blocked boundary, nothing deterministic). Human-only
 * output (no `--json` on this verb). */
export const runRecord = async (opts: {
  rootDir: string
  file: string
  runName: string
  probeFn?: ProbeFn
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
  // M9: capture resolves through the shared overlay helper (flag > local
  // convention > base); the merged view feeds lookup, refusal gates, and
  // store placement identically in every reader.
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
  const scenario = parsed.scenarios.find((entry) => entry.name === opts.runName)
  if (scenario === undefined) {
    console.error(`ow: scenario not found: ${opts.runName}`)
    if (banner !== null) console.log(banner)
    return 2
  }
  for (const raw of scenario.boundaries) {
    const norm = normalizeScenarioBoundary(raw)
    if (norm.known && isRefusedBoundary(norm.normalized)) {
      console.error(`ow: no replay: ${scenario.name} (${maskSecrets(norm.normalized)}) — state-changing boundaries are not recorded`)
      if (banner !== null) console.log(banner)
      return 2
    }
  }
  const location = replayLocation(opts.rootDir, scenario)
  if (location === null) {
    console.error(`ow: no deterministic boundary to record: ${scenario.name}`)
    if (banner !== null) console.log(banner)
    return 2
  }
  const runProbe = opts.probeFn ?? runProbeJob
  const outcomes: ReplayProbeLine[] = []
  for (const probe of scenario.probes) {
    const timeoutMs = PROBE_TIMEOUT_MS[probe.timeout as keyof typeof PROBE_TIMEOUT_MS] ?? PROBE_TIMEOUT_MS["10s"]
    let outcome: ProbeOutcome
    try {
      outcome = await runProbe({ probe: probe.argv, timeoutMs, cwd: opts.rootDir, env: { ...process.env } })
    } catch {
      outcome = { ok: false, note: "could not run", timedOut: false, code: null }
    }
    const line: Omit<ReplayProbeLine, "digest"> = {
      id: probe.id,
      argvShape: foldCwd(maskCmdShape(probe.argv) ?? "", opts.rootDir),
      timeout: probe.timeout,
      ok: outcome.ok,
      note: foldCwd(maskSecrets(outcome.note ?? ""), opts.rootDir).slice(0, REPLAY_NOTE_MAX_CHARS),
      checks: (outcome.checks ?? [])
        .filter((check) => typeof check.name === "string" && typeof check.ok === "boolean")
        .map((check) => ({
          name: foldCwd(maskSecrets(check.name), opts.rootDir),
          ok: check.ok,
          ...(check.digest !== undefined && isArtifactDigest(check.digest) ? { digest: check.digest } : {}),
        })),
    }
    outcomes.push({ ...line, digest: outcomeDigest(line) })
  }
  const previous = await readReplayFile(location.file)
  const previousAttempt = previous?.envelope
  const attempt =
    typeof previousAttempt?.attempt === "number" && Number.isInteger(previousAttempt.attempt) && previousAttempt.attempt >= 1
      ? previousAttempt.attempt + 1
      : 1
  const envelope: ReplayEnvelope = {
    v: 1,
    at: new Date().toISOString(),
    scenario: scenario.name,
    attempt,
    boundary: location.primary,
    boundaries: [...location.recordable].sort(),
    provenance: {
      checkout: maskSecrets(basename(opts.rootDir)),
      head: sha256hex(text).slice(0, 8),
      interpreter: bunInterpreter(),
      runnerHash: runnerHashFor(scenario.probes),
    },
    replayedFrom: null,
    contract: { hash: scenarioDefinitionHash(scenario) },
  }
  if (!validateProvenance(envelope.provenance)) {
    console.error(`ow: provenance-missing: ${scenario.name}`)
    return 1
  }
  // All free text above is scrubbed at construction (masked shapes, masked
  // + folded notes/names); digests, enum literals, and numbers travel
  // verbatim - serializing here cannot break structure.
  try {
    await writeReplayFile(location.file, envelope, outcomes)
  } catch (error) {
    console.error(`ow: cannot write record: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  console.log(`record: ${scenario.name} (${outcomes.length} probes, ${envelope.contract.hash.slice(0, 8)})`)
  // M9 forgotten-overlay banner: provenance-bearing output emitted while
  // an overlay is active names it (absent overlay prints nothing new).
  if (overlay !== null && overlay.applied) console.log(`overlay-active: ${overlay.file}`)
  return 0
}
