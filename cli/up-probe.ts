/** M3 project-defined readiness probe runner: client-side one-shot
 * (NEVER inside the supervisor — no gating, no daemon). Arbitrary local command
 * (B2: NO network restriction, the read-only contract is declaration-based —
 * ow does not audit it, it only reports + applies cap/timeout/mask). argv-only:
 * a shell/sh-c form is rejected by the schema, not interpreted here. */

import { basename } from "node:path"

import { maskSecrets } from "./up-evidence"
import { PROBE_TIMEOUT_MS, type UpReadiness } from "./up-schema"

export const PROBE_STDOUT_MAX_BYTES = 64 * 1024
export const PROBE_STDERR_MAX_BYTES = 16 * 1024
export const PROBE_NOTE_MAX_CHARS = 200
export const PROBE_RESULT_NOTE_MAX_CHARS = 500
export const ORPHAN_NOTE = "may-be-leftover-grandchild"

/** M-C (#1): probe-declared code identity — the runner's RESOLVED module path
 * (`path`, ≤512ch) + content digest (`digest`, hex 7..128ch). Both are
 * additive-optional; a malformed field drops, the entry survives. A raw `path`/
 * full `digest`/probe-argv never reaches render/wire/log — only
 * basename + short-8 is carried reduced (the state file keeps them raw). */
export const PROBE_PATH_MAX_CHARS = 512
export const ARTIFACT_DIGEST_PATTERN = /^[0-9a-fA-F]{7,128}$/
/** The most entries shown in a human/wire list; the rest are counted. */
export const ARTIFACT_DISPLAY_MAX = 32

export type ProbeCheck = { name: string; ok: boolean; path?: string; digest?: string }

export type ProbeOutcome = {
  ok: boolean
  note: string
  checks?: ProbeCheck[]
  timedOut: boolean
  code: number | null
}

export type ProbeSpec = {
  probe: readonly string[]
  timeoutMs: number
  cwd: string
  env: Record<string, string | undefined>
}

/** Run with a fully-resolved spec (orchestration default; the `timeout`
 * label is inert — `timeoutMs` wins). */
export const runProbeJob = (spec: ProbeSpec): Promise<ProbeOutcome> =>
  runProbe({
    spec: { probe: spec.probe, timeout: "10s", needsPort: true },
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: spec.timeoutMs,
  })

/** Probe runner fn type (injection point; tests provide a fake). */
export type ProbeFn = (spec: ProbeSpec) => Promise<ProbeOutcome>

/** Find the FIRST JSON object in stdout (depth-counted, string-aware).
 * Catches the contract object in log-prefixed output. */
export const findFirstJsonObject = (text: string): string | null => {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === "}") {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) return text.slice(start, i + 1)
    }
  }
  return null
}

type ParsedContract = { ready: boolean; note?: string; checks?: ProbeCheck[] }

/** `{ready: bool, note?: ≤200ch, checks?: [{name, ok, path?, digest?}]}` contract:
 * ready is a MANDATORY bool (otherwise invalid); note is truncated; checks are
 * taken only from shape-holding entries (malformed entries drop, not fatal).
 * M-C: `path` (1..512ch string) + `digest` (hex 7..128ch) are shape-strict —
 * a malformed field drops, the entry SURVIVES (never a whole-contract fatal). */
export const parseProbeContract = (text: string): ParsedContract | null => {
  const raw = findFirstJsonObject(text)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const dict = parsed as Record<string, unknown>
  if (typeof dict["ready"] !== "boolean") return null
  const out: ParsedContract = { ready: dict["ready"] as boolean }
  if (typeof dict["note"] === "string") out.note = (dict["note"] as string).slice(0, PROBE_NOTE_MAX_CHARS)
  if (Array.isArray(dict["checks"])) {
    const checks: ProbeCheck[] = []
    for (const entry of dict["checks"] as unknown[]) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>
        if (typeof record["name"] === "string" && typeof record["ok"] === "boolean") {
          const check: ProbeCheck = { name: record["name"] as string, ok: record["ok"] as boolean }
          if (typeof record["path"] === "string" && record["path"].length > 0 && record["path"].length <= PROBE_PATH_MAX_CHARS) {
            check.path = record["path"] as string
          }
          if (typeof record["digest"] === "string" && ARTIFACT_DIGEST_PATTERN.test(record["digest"] as string)) {
            check.digest = record["digest"] as string
          }
          checks.push(check)
        }
      }
    }
    out.checks = checks
  }
  return out
}

/** Recorded-map key discipline: basename shape (no separator/`..`). */
export const isArtifactBase = (base: unknown): base is string =>
  typeof base === "string" && base.length > 0 && base.length <= PROBE_PATH_MAX_CHARS && !base.includes("/") && !base.includes("\\") && base !== "." && base !== ".."

/** Recorded-map value discipline: hex 7..128ch. */
export const isArtifactDigest = (digest: unknown): digest is string =>
  typeof digest === "string" && ARTIFACT_DIGEST_PATTERN.test(digest)

/** Non-leaking name of a resolved path (directories drop). */
export const artifactBase = (path: string): string => basename(path)

/** Wire/human view (short-8; the full digest is never rendered). */
export const shortDigest = (digest: string): string => digest.slice(0, 8)

export type ReducedArtifact = { base: string; digest: string }

/** Recorded-map entry selection (shape-strict: a malformed entry drops, a valid one survives). */
export const pickArtifactEntries = (raw: unknown): Record<string, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [base, digest] of Object.entries(raw as Record<string, unknown>)) {
    if (isArtifactBase(base) && isArtifactDigest(digest)) out[base] = digest as string
  }
  return out
}

/** Declaration map (in-memory, for the freshness comparison): the full digests
 * of ok entries. Keyed by raw basename (unmasked — render-excluded); on a
 * repeated basename the FIRST entry wins (deterministic). */
export const declaredArtifactDigests = (checks: ProbeCheck[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const check of checks ?? []) {
    if (!check.ok || check.path === undefined || check.digest === undefined) continue
    const base = artifactBase(check.path)
    if (!isArtifactBase(base) || !isArtifactDigest(check.digest)) continue
    if (out[base] === undefined) out[base] = check.digest
  }
  return out
}

/** Reduced view (wire/human): masked-basename + short-8, first 32 in sorted
 * order shown, the rest counted. A full path/full digest never appears. */
export const reduceArtifacts = (checks: ProbeCheck[] | undefined): { shown: ReducedArtifact[]; rest: number } =>
  reduceArtifactMap(declaredArtifactDigests(checks))

/** Recorded-map reduction (from the state file to wire/human): the same
 * basename + short-8 discipline (mask first). */
export const reduceArtifactMap = (map: Record<string, string> | undefined): { shown: ReducedArtifact[]; rest: number } => {
  const bases = Object.keys(map ?? {}).sort()
  const shown = bases.slice(0, ARTIFACT_DISPLAY_MAX).map((base) => ({ base: maskSecrets(base), digest: shortDigest((map as Record<string, string>)[base]) }))
  return { shown, rest: Math.max(0, bases.length - shown.length) }
}

/** Single probe run: exit 0 + within-timeout + valid JSON + ready:true =
 * ready; everything else is not-ready (NO retry/restart). Timeout is a
 * SINGLE-PID kill (NO group-kill; a grandchild leak is noted). Outputs are
 * masked + capped with the B3 pattern list (shapeless bare values are not
 * masked — a probe must not print a raw secret; the list is fixed from plan
 * B3); raw argv never enters logs. Never throws (carried in the result). */
export const runProbe = async (opts: {
  spec: UpReadiness
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs?: number
}): Promise<ProbeOutcome> => {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS[opts.spec.timeout]
  const fail = (note: string, extra?: Partial<ProbeOutcome>): ProbeOutcome => ({
    ok: false,
    note: maskSecrets(note).slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
    timedOut: false,
    code: null,
    ...extra,
  })
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([...opts.spec.probe], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    })
  } catch (error) {
    return fail(`could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  let stdout = ""
  let stderr = ""
  let truncatedStdout = false
  const pump = async (stream: "stdout" | "stderr"): Promise<void> => {
    const pipe = stream === "stdout" ? proc.stdout : proc.stderr
    if (!pipe || typeof pipe === "number") return
    const reader = (pipe as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const cap = stream === "stdout" ? PROBE_STDOUT_MAX_BYTES : PROBE_STDERR_MAX_BYTES
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (done) break
      buf += decoder.decode(value as Uint8Array, { stream: true })
      if (buf.length > cap) {
        buf = buf.slice(0, cap)
        if (stream === "stdout") truncatedStdout = true
        break
      }
    }
    buf += decoder.decode()
    if (stream === "stdout") stdout = buf.slice(0, cap)
    else stderr = buf.slice(0, cap)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }, timeoutMs)
  const settled = await Promise.all([proc.exited.catch(() => null), pump("stdout"), pump("stderr")])
  const code = settled[0] as number | null
  clearTimeout(timer)
  if (timedOut) {
    return fail(`timeout (${Math.round(timeoutMs / 1000)}s) — note: ${ORPHAN_NOTE}`, { timedOut: true, code })
  }
  if (code !== 0) {
    const contract = parseProbeContract(stdout)
    const errBit = stderr.trim().length > 0 ? ` — stderr: ${stderr.trim().slice(0, 200)}` : ""
    return {
      ok: false,
      note: maskSecrets(`${contract?.note ?? "not ready"} (exit code ${code ?? "?"})${errBit}`).slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
      timedOut: false,
      code,
      ...(contract?.checks === undefined ? {} : { checks: contract.checks }),
    }
  }
  const contract = parseProbeContract(stdout)
  if (contract === null) {
    return fail(`invalid JSON (expected first stdout object)${truncatedStdout ? " — output capped" : ""}`, { code })
  }
  if (!contract.ready) {
    return {
      ok: false,
      note: maskSecrets(contract.note ?? "not ready").slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
      timedOut: false,
      code,
      ...(contract.checks === undefined ? {} : { checks: contract.checks }),
    }
  }
  return {
    ok: true,
    note: maskSecrets(contract.note ?? "ready").slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
    timedOut: false,
    code,
    ...(contract.checks === undefined ? {} : { checks: contract.checks }),
  }
}
