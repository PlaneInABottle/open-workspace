/** M13 `ow export --bundle [<run>] [--out <path>]`: read-only composition
 * of existing readers (ps --explain, per-service logs tails, failures,
 * preflight --json, checkpoints show for `--run` only) into ONE redacted
 * snapshot file for ticket/PR attachment. No new data collection: every
 * section reuses the real reader entry point via the CLI dispatcher, and
 * only captured stdout is embedded (stderr stays live on the console).
 *
 * Redaction by default on all free text: trace/span/traceparent shapes
 * first, then labeled revs/digests shorten to 8 chars (so full revs render
 * short-8 instead of being masked away), then `maskSecrets` (secret
 * key=value, Bearer/provider tokens, bare 32+ hex), then abs-path folding
 * (`<root>` for the workspace root, `<elsewhere>/<basename>` for any other
 * absolute path — sibling directory chains are never emitted), then any
 * surviving bare 9+ hex run shortens to 8. Fence injection (` ``` `) is
 * neutralized. Trace readers are never composed, so trace IDs/spans never
 * enter as readings; trace-shaped values are masked wherever they appear.
 *
 * The preflight fence is special: the captured JSON is parsed FIRST and
 * redaction walks each string value with explicit serialization, so the
 * whitespace-token masker can never corrupt JSON structure. A present
 * preflight section whose output is not valid JSON fails loud (exit 1,
 * bundle refused) instead of embedding invalid text. */

import { chmod, rename, unlink, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { maskSecrets } from "./up-evidence"
import { foldCwd } from "./up-replay"
import { isValidRunName } from "./up-checkpoints"
import { ensureUpStateDir, upPaths } from "./up-state"

export const EXPORT_TAIL = 50
export const EXPORT_SINCE = "24h"
/** Default composition deadline (generous: normal exports finish in well
 * under a second on fixtures; the guard exists so export can never hang
 * forever, not to race healthy runs). Tests inject milliseconds. */
export const EXPORT_TIMEOUT_MS = 60_000
/** Env flag selecting the in-process composer inside the guard child (the
 * child is a plain `export` re-invocation — no hidden verb, no cli.ts
 * change — that skips re-spawning). Never printed, only compared. */
export const EXPORT_CHILD_ENV = "OW_EXPORT_COMPOSE_CHILD"
/** Env-carried composition deadline (epoch ms), timeout (ms) and clock
 * (ISO) from parent to child. Parsed fail-safe (absent/invalid = unset). */
export const EXPORT_DEADLINE_ENV = "OW_EXPORT_DEADLINE"
export const EXPORT_TIMEOUT_ENV = "OW_EXPORT_TIMEOUT_MS"
export const EXPORT_NOW_ENV = "OW_EXPORT_NOW"

/** Killable composition child (parent-owned deadline enforcement). */
export type ExportChildResult = { code: number; stdout: string; stderr: string }
export type ExportSpawnedChild = { result: Promise<ExportChildResult>; kill: () => void }
export type ExportSpawnFn = (argv: string[], env: Record<string, string | undefined>) => ExportSpawnedChild

/** Explicit guard failure line (single source for parent + composer). */
export const exportTimeoutLine = (timeoutMs: number): string => `export: timed out after ${timeoutMs}ms (no bundle written)`

export const BUNDLE_HEADER = "# ow export bundle"
export const BUNDLE_REDACTION_LINE = "redaction: secrets-masked, paths-folded, revs-short-8, traces-excluded"

/** Trace/span-shaped value masking (runs before the generic secret
 * masker): W3C `traceparent` values (`00-<32hex>-<16hex>-01`) die
 * regardless of key, and any `trace`/`span`/`traceparent`-shaped key
 * (`trace=`, `trace_id:`, `span-id=`, …) masks its whole value. Bare
 * `trace`/`span` prose without `:`/`=` never matches. Bounded linear
 * regexes only. */
const TRACE_KEY_PATTERN = /^(?:traceparent|(?:trace|span)(?:[_-]?(?:id|parent))?)$/i

export const maskTraceShapes = (text: string): string =>
  text
    .replace(/\b[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\b/g, "***")
    .replace(
      /((?:^|[\s(,;-])(?:traceparent|(?:trace|span)(?:[_-]?(?:id|parent))?)\s*[:=]\s*)(\S+)/gim,
      "$1***",
    )

/** Labeled rev/digest shortening (runs BEFORE masking so full revs render
 * short-8 instead of `***`; labels need a boundary so `preview=` never
 * matches. Bounded linear regexes only. */
const shortLabeledHex = (text: string): string =>
  text.replace(
    /((?:^|[\s(,;])(?:rev|revision|digest|sha|checkout|head)\s*[:=]\s*)([0-9a-f]{9,128})/gim,
    (_, prefix: string, hash: string) => `${prefix}${hash.slice(0, 8)}`,
  )

/** Surviving bare hex runs (post-mask: no 32+ secret hex left) shorten to
 * 8. Already-short digests (8 chars) pass through. */
const shortBareHex = (text: string): string =>
  text.replace(/\b[0-9a-f]{9,64}\b/g, (hash) => hash.slice(0, 8))

/** Non-root absolute paths fold to `<elsewhere>/<basename>` (the root
 * itself already folded to `<root>` beforehand, protected by the `>`
 * lookbehind; `//` URLs never match via the single-slash guard). */
const foldElsewhere = (text: string): string =>
  text.replace(/(?<![\w<>:/])\/(?!\/)[^\s"'`,;()\[\]{}]*/g, (path) => {
    const clean = path.replace(/[.,:]+$/, "")
    if (clean === "/") return path
    const base = clean.split("/").pop() as string
    return `<elsewhere>/${base}${path.slice(clean.length)}`
  })

/** Single free-text redaction pipeline shared by human sections (whole
 * text) and JSON fence values (per string). */
const redactFreeString = (text: string, rootDir: string): string =>
  shortBareHex(foldElsewhere(foldCwd(maskSecrets(shortLabeledHex(maskTraceShapes(text))), rootDir)))

/** Uniform bundle redaction for human sections: shared pipeline plus
 * fence-injection neutralization. */
export const redactBundleText = (text: string, rootDir: string): string =>
  redactFreeString(text, rootDir).replaceAll("```", "'''")

/** JSON-value redaction with explicit serialization: strings run the
 * shared pipeline (trace-shaped KEYS mask the whole value); structure
 * (keys, nesting, punctuation) is never masked, so output stays valid
 * JSON by construction. */
export const redactJsonValue = (value: unknown, rootDir: string): unknown => {
  if (typeof value === "string") return redactFreeString(value, rootDir)
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, rootDir))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = TRACE_KEY_PATTERN.test(key) ? "***" : redactJsonValue(item, rootDir)
    }
    return out
  }
  return value
}

/** Preflight fence composer: absent sections pass their fixed placeholder
 * through text redaction; present sections MUST parse (parse-first, then
 * per-value redaction with explicit serialization). A present-but-invalid
 * fence fails loud instead of embedding broken text. */
export const composePreflightFence = (
  body: string,
  present: boolean,
  rootDir: string,
): { ok: true; text: string } | { ok: false; reason: string } => {
  if (!present) return { ok: true, text: redactBundleText(body, rootDir) }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: "preflight output is not valid JSON" }
  }
  return { ok: true, text: JSON.stringify(redactJsonValue(parsed, rootDir), null, 2).replaceAll("```", "'''") }
}

type Captured = { code: number; out: string }

/** Child base for re-driving the CLI (dev/test: source file when present,
 * prod binary otherwise — no hidden verb, so cli.ts stays untouched). */
const exportChildBase = (): string[] => {
  const cliSource = join(dirname(fileURLToPath(import.meta.url)), "cli.ts")
  return existsSync(cliSource) ? [process.execPath, cliSource] : [process.execPath]
}

/** Section capture in a killable child (never an in-process import of
 * `./cli`: that runtime self-import edge back-edges into mid-evaluation
 * cli.ts and spins forever inside the compiled binary — the OW-011 root
 * cause, proven by marker bisection (zero markers before the composer
 * body). Only captured stdout is embedded (stderr stays live). */
const captureRun = async (argv: string[]): Promise<Captured> => {
  const child = spawnExportChild([...exportChildBase(), ...argv], { ...process.env })
  const outcome = await child.result
  if (outcome.stderr.replace(/\n$/, "").length > 0) console.error(outcome.stderr.replace(/\n$/, ""))
  return { code: outcome.code, out: outcome.stdout.replace(/\n$/, "") }
}

const blank = (text: string): boolean => text.trim().length === 0

type Section = { title: string; body: string; present: boolean }

const placeholder = (title: string, reason: string): Section => ({ title, body: `empty: ${reason}`, present: false })

const live = (title: string, body: string): Section => ({ title, body, present: true })

const explainSection = async (file: string): Promise<Section> => {
  const title = "## ps --explain"
  const result = await captureRun(["ps", "--explain", "--file", file])
  const text = result.out.trim()
  if (blank(text) || text === "no state" || text.startsWith("no state (")) return placeholder(title, "no state")
  return live(title, result.out)
}

const serviceNames = async (file: string, rootDir: string): Promise<string[]> => {
  try {
    const { parseUpFile } = await import("./up-schema")
    return parseUpFile(readFileSync(file, "utf8")).services.map((svc) => svc.name)
  } catch {
    const { readSupervisorState } = await import("./up-state")
    const state = await readSupervisorState(upPaths(rootDir).supervisorFile)
    return state?.services.map((svc) => svc.name) ?? []
  }
}

const logsSection = async (file: string, rootDir: string): Promise<Section> => {
  const title = `## logs (tail ${EXPORT_TAIL} per service)`
  const bodies: string[] = []
  for (const name of await serviceNames(file, rootDir)) {
    const result = await captureRun(["logs", name, "--tail", String(EXPORT_TAIL), "--file", file])
    if (!blank(result.out) && result.out.trim() !== "no log" && !result.out.trim().startsWith("no log (")) {
      bodies.push(result.out)
    }
  }
  if (bodies.length === 0) return placeholder(title, "no logs")
  return live(title, bodies.join("\n"))
}

const failuresSection = async (file: string): Promise<Section> => {
  const title = `## failures (since ${EXPORT_SINCE})`
  const result = await captureRun(["failures", "--since", EXPORT_SINCE, "--file", file])
  if (blank(result.out) || result.out.trim().startsWith("no findings")) return placeholder(title, "no findings")
  return live(title, result.out)
}

const preflightSection = async (file: string): Promise<Section> => {
  const title = "## preflight --json"
  const result = await captureRun(["preflight", "--json", "--file", file])
  if (result.code === 2 || blank(result.out)) return placeholder(title, "preflight unavailable")
  return live(title, result.out)
}

const checkpointsSection = async (file: string, run: string): Promise<Section> => {
  const title = `## checkpoints show ${run}`
  const result = await captureRun(["checkpoints", "show", run, "--file", file])
  if (blank(result.out) || result.out.trim().startsWith("checkpoint empty:")) {
    return { title, body: `empty: no checkpoint: ${run}`, present: false }
  }
  return live(title, result.out)
}

/** `--out` refusal carrying its exit code (2 usage, 1 structural). */
class ExportRefusal extends Error {
  code: 1 | 2
  constructor(message: string, code: 1 | 2) {
    super(message)
    this.code = code
  }
}

/** `--out` containment (root-anchored, overlay-guard mirror): empty, `.`,
 * absolute paths and any `..`/`~` escape refuse with exit 2 echoing the
 * basename only; existing directories (and non-file nodes) refuse as
 * not-a-file; a symlinked parent escaping the root refuses as outside.
 * All validation happens BEFORE any tmp file is created (the tmp lives
 * inside the target dir only at write time). Returns the resolved path. */
const resolveOut = async (rootDir: string, raw: string): Promise<string> => {
  const base = raw === "" ? "(empty)" : basename(raw)
  if (raw.trim() === "") throw new ExportRefusal(`export-refused: ${base} (path must be root-relative)`, 2)
  const segments = raw.split("/").flatMap((part) => part.split("\\"))
  const root = resolve(rootDir)
  const resolved = resolve(root, raw)
  if (isAbsolute(raw) || segments.includes("..") || segments.includes("~") || (resolved !== root && !resolved.startsWith(root + sep))) {
    throw new ExportRefusal(`export-refused: ${base} (path must be root-relative)`, 2)
  }
  if (resolved === root) throw new ExportRefusal(`export-refused: ${base} (not a file)`, 2)
  try {
    const { lstat } = await import("node:fs/promises")
    const entry = await lstat(resolved)
    if (entry.isDirectory() || (!entry.isFile() && !entry.isSymbolicLink())) {
      throw new ExportRefusal(`export-refused: ${base} (not a file)`, 2)
    }
  } catch (error) {
    if (error instanceof ExportRefusal) throw error
    // Absent target: falls through to the parent checks below.
  }
  let realParent: string
  let realRoot: string
  try {
    const { realpath } = await import("node:fs/promises")
    realParent = await realpath(dirname(resolved))
    realRoot = await realpath(root)
  } catch {
    throw new ExportRefusal(`export cannot write: ${base} (directory missing)`, 1)
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new ExportRefusal(`export-refused: ${base} (outside root)`, 2)
  }
  return resolved
}

export const bundleFileName = (now: Date): string =>
  `bundle-${now.toISOString().replace(/[:.]/g, "-")}.md`

/** Atomic tmp+rename write, `0600` (observer-core discipline). */
const atomicWriteText0600 = async (path: string, text: string): Promise<void> => {
  const temporary = join(dirname(path), `.ow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export type ExportOptions = {
  rootDir: string
  file: string
  run?: string
  out?: string
  now?: Date
  /** Composition deadline (parent default EXPORT_TIMEOUT_MS; tests inject
   * milliseconds). The in-process composer also honors `deadlineMs`. */
  timeoutMs?: number
  /** Injected child spawner (default: real killable Bun.spawn; tests pass
   * a hanging fake for the RED-proof). Ignored inside the guard child. */
  spawnFn?: ExportSpawnFn
  /** Absolute composition deadline (epoch ms) for cooperative phase
   * checks. The guard child reads it from the environment. */
  deadlineMs?: number
}

/** Default killable spawner: stdio-piped child, SIGKILL on parent demand. */
const spawnExportChild: ExportSpawnFn = (argv, env) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env })
  let stdout = ""
  let stderr = ""
  const pump = async (stream: "stdout" | "stderr"): Promise<void> => {
    const pipe = stream === "stdout" ? proc.stdout : proc.stderr
    if (!pipe || typeof pipe === "number") return
    const reader = (pipe as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) break
      stdout += stream === "stdout" ? decoder.decode(next.value as Uint8Array, { stream: true }) : ""
      stderr += stream === "stderr" ? decoder.decode(next.value as Uint8Array, { stream: true }) : ""
    }
    const tail = decoder.decode()
    if (stream === "stdout") stdout += tail
    else stderr += tail
  }
  const result = (async (): Promise<ExportChildResult> => {
    const [code] = await Promise.all([proc.exited.catch(() => null), pump("stdout"), pump("stderr")])
    return { code: typeof code === "number" ? code : 1, stdout, stderr }
  })()
  return { result, kill: () => {
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  } }
}

/** Child argv: the same public `export` invocation on the shared child
 * base (no hidden verb, so cli.ts stays untouched). */
const exportChildArgv = (opts: ExportOptions): string[] => [
  ...exportChildBase(),
  "export",
  "--bundle",
  ...(opts.run === undefined ? [] : [opts.run]),
  "--file",
  opts.file,
  ...(opts.out === undefined ? [] : ["--out", opts.out]),
]

const readDeadlineEnv = (): number | null => {
  const raw = process.env[EXPORT_DEADLINE_ENV]
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

const readTimeoutEnv = (): number | null => {
  const raw = process.env[EXPORT_TIMEOUT_ENV]
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

const readNowEnv = (): Date | null => {
  const raw = process.env[EXPORT_NOW_ENV]
  if (raw === undefined) return null
  const time = Date.parse(raw)
  return Number.isFinite(time) ? new Date(time) : null
}

/** Guard parent: the composition runs in a killable child under a
 * deadline. A same-process timer alone is PROVEN unsound against
 * synchronous in-process spin (it cannot interrupt a spinning regex) —
 * SIGKILL on a child can. Timeout → explicit line, exit 1, no file
 * (the child writes atomically tmp+rename only at the very end, so a
 * kill before that leaves no bundle behind). Residual: killing the
 * composer can orphan its in-flight section children; those are bounded
 * reader computations that exit on their own and write nothing. */
export const runExport = async (opts: ExportOptions): Promise<number> => {
  if (process.env[EXPORT_CHILD_ENV] === "1") return runExportInProcess(opts)
  const timeoutMs = opts.timeoutMs ?? EXPORT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const argv = exportChildArgv(opts)
  const env: Record<string, string | undefined> = {
    ...process.env,
    [EXPORT_CHILD_ENV]: "1",
    [EXPORT_DEADLINE_ENV]: String(deadline),
    [EXPORT_TIMEOUT_ENV]: String(timeoutMs),
    ...(opts.now === undefined ? {} : { [EXPORT_NOW_ENV]: opts.now.toISOString() }),
  }
  let child: ExportSpawnedChild
  try {
    child = (opts.spawnFn ?? spawnExportChild)(argv, env)
  } catch (error) {
    console.error(`export: cannot start composition (${error instanceof Error ? error.message : String(error)}) (no bundle written)`)
    return 1
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      child.result.then((result) => ({ ...result, timedOut: false as const })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // already gone
          }
          resolve({ timedOut: true })
        }, timeoutMs)
      }),
    ])
    if (outcome.timedOut) {
      console.error(exportTimeoutLine(timeoutMs))
      return 1
    }
    // Relay verbatim (single calls; trailing newline folded so captured
    // shapes match the in-process composition byte for byte).
    if (outcome.stdout.replace(/\n$/, "").length > 0) console.log(outcome.stdout.replace(/\n$/, ""))
    if (outcome.stderr.replace(/\n$/, "").length > 0) console.error(outcome.stderr.replace(/\n$/, ""))
    return outcome.code
  } finally {
    clearTimeout(timer)
  }
}

export const runExportInProcess = async (opts: ExportOptions): Promise<number> => {
  // Cooperative phase checks (defense in depth beside the parent's
  // SIGKILL: a slow-but-moving composition aborts at phase boundaries
  // instead of burning the whole deadline; a true single-call spin is
  // still only stoppable by the parent's kill — documented, not claimed).
  const now = opts.now ?? readNowEnv() ?? new Date()
  const timeoutMs = opts.timeoutMs ?? readTimeoutEnv() ?? EXPORT_TIMEOUT_MS
  const deadlineMs = opts.deadlineMs ?? readDeadlineEnv()
  const timedOut = (): boolean => deadlineMs !== null && deadlineMs !== undefined && Date.now() > deadlineMs
  const abort = (): number => {
    console.error(exportTimeoutLine(timeoutMs))
    return 1
  }
  if (opts.run !== undefined && !isValidRunName(opts.run)) {
    console.error(`ow: invalid run name: ${opts.run} (allowed: [A-Za-z0-9_.-], at most 64 characters)`)
    return 2
  }
  let target: string
  if (opts.out === undefined) {
    target = join(upPaths(opts.rootDir).stateDir, bundleFileName(now))
  } else {
    try {
      target = await resolveOut(opts.rootDir, opts.out)
    } catch (error) {
      const code = error instanceof ExportRefusal ? error.code : 1
      console.error(`ow: ${error instanceof Error ? error.message : String(error)}`)
      return code
    }
  }
  const sections: Section[] = []
  sections.push(await explainSection(opts.file))
  if (timedOut()) return abort()
  sections.push(await logsSection(opts.file, opts.rootDir))
  if (timedOut()) return abort()
  sections.push(await failuresSection(opts.file))
  if (timedOut()) return abort()
  if (opts.run !== undefined) {
    sections.push(await checkpointsSection(opts.file, opts.run))
    if (timedOut()) return abort()
  }
  sections.push(await preflightSection(opts.file))
  if (timedOut()) return abort()
  if (!sections.some((section) => section.present)) {
    console.error("export: nothing readable (no state, no checkpoints, no findings)")
    return 1
  }
  const fence = sections[sections.length - 1]
  const composed = composePreflightFence(fence.body, fence.present, opts.rootDir)
  if (!composed.ok) {
    console.error(`export: ${composed.reason} (bundle refused)`)
    return 1
  }
  const fenceBody = composed.text
  const lines = [
    BUNDLE_HEADER,
    `generated: ${now.toISOString()}`,
    "root: <root>",
    `run: ${opts.run ?? "none"}`,
    BUNDLE_REDACTION_LINE,
    "",
  ]
  for (const section of sections.slice(0, -1)) {
    lines.push(section.title, section.present ? redactBundleText(section.body, opts.rootDir) : section.body, "")
  }
  // Fence contract: the ```json wrapper holds valid JSON only. An absent
  // preflight section renders as a plain `empty:` line instead, so parsing
  // consumers never meet non-JSON inside a json fence.
  if (fence.present) {
    lines.push(fence.title, "```json", fenceBody, "```", "")
  } else {
    lines.push(fence.title, fenceBody, "")
  }
  const text = `${lines.join("\n")}`
  if (timedOut()) return abort()
  try {
    if (opts.out === undefined) await ensureUpStateDir(upPaths(opts.rootDir).stateDir)
    await atomicWriteText0600(target, text)
  } catch (error) {
    console.error(`ow: export cannot write: ${basename(target)} (${error instanceof Error ? error.message : String(error)})`)
    return 1
  }
  console.log(`bundle: ${relative(opts.rootDir, target)}`)
  return 0
}
