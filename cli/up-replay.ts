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
import { normalizeBoundary as normalizeScenarioBoundary, parseScenarios, type Scenario } from "./up-scenarios"
import { maskCmdShape } from "./up-reconcile"
import { capText, maskSecrets } from "./up-evidence"
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
 * values): any definition edit changes the digest. M6/M7 fields are
 * covered (restore/asserts/mode/data/env_file plus opaque track fields):
 * editing any of them flips a recorded contract to mismatch (re-record).
 * Digest inputs stay in memory - the file keeps the hex only. */
export const canonicalScenario = (scenario: Scenario): string =>
  JSON.stringify({
    name: scenario.name,
    services: scenario.services,
    boundaries: scenario.boundaries,
    targets: scenario.targets,
    probes: scenario.probes.map((probe) => ({ id: probe.id, argv: probe.argv, timeout: probe.timeout })),
    checkpoints: scenario.checkpoints,
    mode: scenario.mode,
    restore: scenario.restore,
    asserts: scenario.asserts,
    triggers: scenario.triggers,
    queue: scenario.queue,
    webhook: scenario.webhook,
    deps: scenario.deps,
    proxies: scenario.proxies,
    apiMode: scenario.apiMode,
    browser: scenario.browser,
    viewport: scenario.viewport,
    seed: scenario.seed,
    artifact: scenario.artifact,
    data: scenario.data,
    env_file: scenario.env_file,
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

/** Opaque caller claims (boundary witness, APPROVED B): `ow` never
 * judges them — it records the caller's words verbatim and reads them
 * back verbatim. `kind` is stored exactly as flagged (accepted only
 * `real|fake` at the flag gate, never normalized, never routed through
 * `normalizeBoundary` or the legacy map); `name`/`ref` are opaque
 * (never dereferenced, read, or executed). Absence of the field is
 * today's shape: claimless envelopes read exactly as before. */
export type ReplayClaimBoundary = {
  name: string
  kind: string
  ref: string
}

export type ReplayClaims = {
  entrypoint?: string
  boundaries?: ReplayClaimBoundary[]
}

/** Claim caps (opaque, enforced at ingest: mask, then CWD-fold, then
 * cap — the probe-note precedent). Over-long values cap; empty or
 * misshapen values refuse at the flag gate (exit 2, never stored). */
export const CLAIM_ENTRYPOINT_MAX_CHARS = 128
export const CLAIM_BOUNDARIES_MAX = 32
export const CLAIM_NAME_MAX_CHARS = 64
export const CLAIM_REF_MAX_CHARS = 256

/** Accepted claim kinds (flag gate only; stored verbatim, never
 * normalized — `Real`/`FAKE` refuse like any unknown kind). */
const CLAIM_KINDS: ReadonlySet<string> = new Set(["real", "fake"])

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
  claims?: ReplayClaims
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

/** Single `--claim-boundary <name>=<kind>:<ref>` read: name runs to
 * the first `=`, kind to the first `:` after it, ref is the remainder
 * (it may itself contain `:`). Empty parts, a missing separator, or a
 * kind outside `real|fake` refuse with the locked string (exit 2 at
 * the call site, before any probe exec). The echoed flag value is
 * secret-bearing, so it is masked + CWD-folded at construction
 * (mask-before-fold); the `invalid-boundary:` prefix and the grammar
 * hint stay byte-identical. Values stay opaque here —
 * masking/folding/capping of the stored parts happens in
 * `buildReplayClaims`. */
export const parseClaimBoundary = (
  raw: string,
  cwd: string,
): { ok: true; value: { name: string; kind: string; ref: string } } | { ok: false; error: string } => {
  const usage = `invalid-boundary: ${foldCwd(maskSecrets(raw), cwd)} (expected <name>=<kind>:<ref> with kind real|fake)`
  const eq = raw.indexOf("=")
  if (eq <= 0) return { ok: false, error: usage }
  const rest = raw.slice(eq + 1)
  const colon = rest.indexOf(":")
  if (colon <= 0) return { ok: false, error: usage }
  const name = raw.slice(0, eq)
  const kind = rest.slice(0, colon)
  const ref = rest.slice(colon + 1)
  if (name.length === 0 || kind.length === 0 || ref.length === 0) return { ok: false, error: usage }
  if (!CLAIM_KINDS.has(kind)) return { ok: false, error: usage }
  return { ok: true, value: { name, kind, ref } }
}

/** Claim ingest (record path only): validate the flag shapes first
 * (any refusal exits before probes run), then mask, CWD-fold, and cap
 * each opaque value at construction — the stored object is already
 * safe, so the write-echo below can quote it directly. No flags means
 * no field (absence is today's shape, never an empty object). */
export const buildReplayClaims = (opts: {
  entrypoint?: string
  boundary?: string | string[]
  cwd: string
}): { ok: true; claims: ReplayClaims | undefined } | { ok: false; error: string } => {
  const rawBoundaries = opts.boundary === undefined ? [] : Array.isArray(opts.boundary) ? opts.boundary : [opts.boundary]
  if (opts.entrypoint === undefined && rawBoundaries.length === 0) return { ok: true, claims: undefined }
  let entrypoint: string | undefined
  if (opts.entrypoint !== undefined) {
    if (opts.entrypoint.length === 0) {
      return { ok: false, error: `invalid-boundary: ${opts.entrypoint} (claim entrypoint must be 1-${CLAIM_ENTRYPOINT_MAX_CHARS} characters)` }
    }
    entrypoint = capText(foldCwd(maskSecrets(opts.entrypoint), opts.cwd), CLAIM_ENTRYPOINT_MAX_CHARS)
  }
  const boundaries: ReplayClaimBoundary[] = []
  for (const raw of rawBoundaries) {
    const parsed = parseClaimBoundary(raw, opts.cwd)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    boundaries.push({
      name: capText(foldCwd(maskSecrets(parsed.value.name), opts.cwd), CLAIM_NAME_MAX_CHARS),
      kind: parsed.value.kind,
      ref: capText(foldCwd(maskSecrets(parsed.value.ref), opts.cwd), CLAIM_REF_MAX_CHARS),
    })
  }
  return {
    ok: true,
    claims: {
      ...(entrypoint === undefined ? {} : { entrypoint }),
      ...(boundaries.length === 0 ? {} : { boundaries: boundaries.slice(0, CLAIM_BOUNDARIES_MAX) }),
    },
  }
}

/** Stored-claims view (read path only): valid shapes quote verbatim,
 * absent claims are the unverified gap, anything misshapen (tampered
 * or foreign) is uninterpretable — never a crash, never a gate. This
 * is the SOLE claims reader; the contract verdict never consults it. */
export type StoredClaimsView =
  | { status: "recorded"; claims: ReplayClaims }
  | { status: "unverified" }
  | { status: "uninterpretable" }

export const describeStoredClaims = (envelope: unknown): StoredClaimsView => {
  if (typeof envelope !== "object" || envelope === null) return { status: "uninterpretable" }
  const raw = (envelope as { claims?: unknown }).claims
  if (raw === undefined) return { status: "unverified" }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { status: "uninterpretable" }
  const dict = raw as Record<string, unknown>
  let entrypoint: string | undefined
  if (dict["entrypoint"] !== undefined) {
    if (typeof dict["entrypoint"] !== "string" || dict["entrypoint"].length === 0) return { status: "uninterpretable" }
    entrypoint = dict["entrypoint"]
  }
  let boundaries: ReplayClaimBoundary[] | undefined
  if (dict["boundaries"] !== undefined) {
    if (!Array.isArray(dict["boundaries"]) || dict["boundaries"].length > CLAIM_BOUNDARIES_MAX) return { status: "uninterpretable" }
    const picked: ReplayClaimBoundary[] = []
    for (const entry of dict["boundaries"]) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { status: "uninterpretable" }
      const row = entry as Record<string, unknown>
      if (
        typeof row["name"] !== "string" ||
        (row["name"] as string).length === 0 ||
        typeof row["kind"] !== "string" ||
        !CLAIM_KINDS.has(row["kind"] as string) ||
        typeof row["ref"] !== "string" ||
        (row["ref"] as string).length === 0
      ) {
        return { status: "uninterpretable" }
      }
      picked.push({ name: row["name"] as string, kind: row["kind"] as string, ref: row["ref"] as string })
    }
    boundaries = picked
  }
  if (entrypoint === undefined && (boundaries === undefined || boundaries.length === 0)) return { status: "uninterpretable" }
  return { status: "recorded", claims: { ...(entrypoint === undefined ? {} : { entrypoint }), ...(boundaries === undefined ? {} : { boundaries }) } }
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

/** Bounded read (256KB / 500 lines): absent, over-cap, or malformed
 * content reads as null (fail-closed upstream). Over-cap refuses instead
 * of silent truncate (MEDIUM-5): a capped writer never emits over-cap
 * files, so oversize means tampering or corruption. M-b self-verifying:
 * lstat (regular-file-only, no symlink/FIFO) + O_NOFOLLOW|O_NONBLOCK open
 * + fstat dev/ino pin (TOCTOU swap refuses) + per-line outcomeDigest
 * recompute (tampered lines refuse). Envelope completeness is NOT checked
 * here - readers distinguish the unknown-hash case (null) from the
 * provenance-missing case (present). */
export const readReplayFile = async (path: string): Promise<{ envelope: ReplayEnvelope; lines: ReplayProbeLine[] } | null> => {
  const { lstat: lstatFile } = await import("node:fs/promises")
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = await import("node:constants")
  let entry
  try {
    entry = await lstatFile(path)
  } catch {
    return null
  }
  if (!entry.isFile() || entry.isSymbolicLink()) return null
  let handle
  try {
    handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const pinned = await handle.stat()
    if (!pinned.isFile() || pinned.dev !== entry.dev || pinned.ino !== entry.ino) return null
    // LOW-8 short-read guard: a single read may return partial bytes;
    // loop until full, EOF, or cap (oversize still refuses below).
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, REPLAY_MAX_BYTES + 1024 - total))
      if (buffer.length === 0) break
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      if (total > REPLAY_MAX_BYTES) return null
    }
    const text = Buffer.concat(chunks).toString("utf8")
    const parts = text.split("\n").filter((part) => part.length > 0)
    if (parts.length === 0) return null
    if (parts.length > REPLAY_MAX_LINES) return null
    const raw = parts
    let envelope: ReplayEnvelope
    try {
      envelope = JSON.parse(raw[0]) as ReplayEnvelope
    } catch {
      return null
    }
    if (typeof envelope !== "object" || envelope === null) return null
    const lines: ReplayProbeLine[] = []
    for (const part of raw.slice(1)) {
      let line: ReplayProbeLine
      try {
        line = JSON.parse(part) as ReplayProbeLine
      } catch {
        return null
      }
      if (typeof line !== "object" || line === null || typeof line.digest !== "string") return null
      const { digest, ...body } = line
      if (outcomeDigest(body as Omit<ReplayProbeLine, "digest">) !== digest) return null
      lines.push(line)
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
  /** Opaque caller claims (record-only flags; refused elsewhere at the
   * call site). Parsed before any probe exec — a malformed claim exits
   * 2 with zero spawns. */
  claimEntrypoint?: string
  claimBoundary?: string | string[]
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
  // INERT scaffold refuses like the runner (decision: recording a
  // placeholder contract is meaningless — edit real probes first).
  const { hasInertMarker } = await import("./up-init")
  if (hasInertMarker(text)) {
    console.error(`INERT: ${opts.file}`)
    return 2
  }
  // Caller claims ingest (fail-closed, before overlay + probes): a
  // malformed claim exits 2 here, so no probe ever spawns for it. The
  // stored object below is already masked/folded/capped — the echo
  // quotes it directly and the ref is never executed.
  const builtClaims = buildReplayClaims({ entrypoint: opts.claimEntrypoint, boundary: opts.claimBoundary, cwd: opts.rootDir })
  if (!builtClaims.ok) {
    console.error(`ow: ${builtClaims.error}`)
    return 2
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
    ...(builtClaims.claims === undefined ? {} : { claims: builtClaims.claims }),
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
  // Claims write-echo (verbatim quote of the STORED object, after the
  // record line): the caller's words back at them, never a judgment.
  if (envelope.claims?.entrypoint !== undefined) console.log(`claims: entrypoint=${envelope.claims.entrypoint}`)
  for (const boundary of envelope.claims?.boundaries ?? []) {
    console.log(`claims: boundary ${boundary.name}=${boundary.kind}:${boundary.ref}`)
  }
  // Witness-only surfacing: each not-ready probe names itself (exit stays
  // 0 — a not-ready probe is recorded evidence, not a record failure).
  for (const outcome of outcomes) {
    if (!outcome.ok) console.log(`probe not-ready: ${outcome.id} (${outcome.note})`)
  }
  // M9 forgotten-overlay banner: provenance-bearing output emitted while
  // an overlay is active names it (absent overlay prints nothing new).
  if (overlay !== null && overlay.applied) console.log(`overlay-active: ${overlay.file}`)
  return 0
}
