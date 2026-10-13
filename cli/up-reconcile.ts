/** M1 read-only reconcile: expected (ow.yaml) vs running (state+lstart)
 * drift report. Never mutates (witness line) — it only suggests explicit
 * `ow up/restart/down <svc>` commands. exit 0 ok / 1 drift / 2 usage.
 * M3 `--probe` phase: defined probes run client-side one-shot
 * (live+recorded services, total ≤60s soft budget); results are added as
 * `readiness:` lines, they do not change exit (which follows drift). */

import { parseUpFile, PROBE_TIMEOUT_MS, type UpService } from "./up-schema"
import { decodeUtf8Fatal } from "./up-schema"
import { readLstart, readProcessTable, readSupervisorState, upPaths, warnWriteFailed, type ProcessTable, type UpServiceState } from "./up-state"
import { tcpListening } from "./up-net"
import { gitCheckout, resolveCwdAbs } from "./up-provenance"

/** Secret-shaped argv/cmd echo is a masked shape (B3): raw values never
 * enter output/state/log. Rules: a secret word inside `name=value`
 * (`password|secret|api[_-]?key|bearer|token|credential|private_key|
 * authorization`) → `name=***`; the value after a secret flag
 * (`--password hunter2`) → `***`; provider prefixes (ghp_/sk-/xox-) and
 * ≥32-hex bodies → `***`; a bare part containing a secret word → `***`.
 * Shape is preserved (same part count/order), values drop. */
const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/

/** B3 mask list (shared with the P2-A evidence mask; single source). */
export const SECRET_WORD_PATTERN = SECRET_WORD
export const PROVIDER_PREFIX_PATTERN = PROVIDER_PREFIX

/** B3 token mask (shared with the P2-A evidence mask; single source). */
export const maskSecretToken = (token: string, prevIsSecretFlag: boolean): string => {
  if (token.length === 0) return token
  const eq = token.indexOf("=")
  if (eq > 0) {
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (SECRET_WORD.test(key) || SECRET_WORD.test(value) || /^[0-9a-fA-F]{32,}$/.test(value) || PROVIDER_PREFIX.test(value)) {
      return `${key}=***`
    }
    return token
  }
  if (prevIsSecretFlag) return "***"
  if (/^(-{1,2}[A-Za-z0-9_-]*password|^(-{1,2}[A-Za-z0-9_-]*secret)|(-{1,2}[A-Za-z0-9_-]*token))$/i.test(token)) return token
  if (SECRET_WORD.test(token) || /^[0-9a-fA-F]{32,}$/.test(token) || PROVIDER_PREFIX.test(token)) return "***"
  return token
}

const isSecretFlag = (token: string): boolean =>
  /^(-{1,2})?[A-Za-z0-9_-]*(password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization)$/i.test(token) &&
  !token.includes("=")

/** B3 secret-flag test (shared with the P2-A evidence mask; single source). */
export const isSecretFlagToken = isSecretFlag

/** Masked cmd shape: a string is tokenized as-is, an argv list part-by-part. */
export const maskCmdShape = (cmd: string | string[] | undefined): string | undefined => {
  if (cmd === undefined) return undefined
  const parts = Array.isArray(cmd) ? cmd : cmd.split(/\s+/)
  let prevFlag = false
  const masked = parts.map((part) => {
    const out = maskSecretToken(part, prevFlag)
    prevFlag = isSecretFlag(part)
    return out
  })
  return Array.isArray(cmd) ? masked.join(" ") : masked.join(" ")
}

/** Pre-mutation diff lines + JSON diff envelope. `running` null means the
 * service is not recorded (about to start); on a `restart` action this
 * line names a record-less restart (L-2: distinct from the plain `up` line). */
export const diffService = (
  expected: UpService,
  running: UpServiceState | null,
  action: "up" | "restart" = "up",
): { lines: string[]; diff: { cmd?: string; cwd?: string; port?: number; status: string } } => {
  const shape = maskCmdShape(expected.cmd) ?? "(logs)"
  const where = [
    ...(expected.cwd !== undefined ? [`cwd=${expected.cwd}`] : []),
    ...(expected.port !== undefined ? [`port=${expected.port}`] : []),
  ].join(" ")
  if (running === null) {
    const prefix = action === "restart" ? "+ to-start (restart, no record)" : "+ to-start"
    return {
      lines: [`${prefix}: ${expected.name} cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
      diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), ...(expected.cwd !== undefined ? { cwd: expected.cwd } : {}), ...(expected.port !== undefined ? { port: expected.port } : {}), status: "missing" },
    }
  }
  return {
    lines: [`restart: ${expected.name} pid=${running.pid} lstart=matched → cmd=${shape}${where.length > 0 ? ` ${where}` : ""}`],
    diff: { ...(expected.cmd !== undefined ? { cmd: shape } : {}), status: "running" },
  }
}

export type DriftKind =
  | "missing"
  | "extra"
  | "stopped"
  | "config-mismatch"
  | "lstart-mismatch"
  | "foreign-port"
  | "artifact-stale"

export type ReconcileDrift = {
  service: string
  kind: DriftKind
  expected?: Record<string, unknown>
  running?: Record<string, unknown>
  hint: string
  /** Additive: present only on a partially foreign port (one owner is ours,
   * another is not). JSON-only: `formatDrift` never prints it. */
  ownership?: "shared"
}

export type Liveness = "live" | "dead" | "lstart-mismatch" | "unknown"

export type ReconcileInput = {
  name: string
  expected: UpService | null
  running: UpServiceState | null
  /** A recorded exit counts as stopped (liveness is not consulted). */
  liveness: Liveness
  /** Whether a loopback listener exists on the declared port (for a defined port). */
  listening: boolean | undefined
  /** `lsof` best-effort port-owner pids; null = unmeasured. */
  portOwners: number[] | null
  /** Additive optional bounded-descendant owners (subset of `portOwners`
   * proven to descend from the recorded pid via `descendantOwnersOf`).
   * Undefined = unmeasured: the core falls back to legacy exact-match. */
  descendantOwners?: number[]
  /** M-C build identity: probe-declared (basename → full digest) vs the
   * recorded map. Liveness/ok-gating belongs to the caller (the core does a
   * pure comparison); an unrecorded basename produces no drift
   * (record-observation is the caller's job). */
  artifacts?: { declared: Record<string, string>; recorded: Record<string, string> }
}

/** Pure bounded-descendant ownership: which `owners` descend from the
 * recorded pid through the process table (≤16 hops, cycle-safe). Owner
 * pids never enter output — the result is only consumed by the drift
 * predicate. Returns null when ownership cannot be proven (null table,
 * recorded pid absent, or recorded `lstart` mismatch after
 * whitespace normalization): the caller falls back to legacy exact-match
 * and never claims ownership. An owner equal to the recorded pid is
 * exact-match, not a descendant, and is skipped here. A hop ending at
 * ppid<=1 or an unknown pid is not a descendant. */
export const descendantOwnersOf = (
  running: { pid: number; lstart: string },
  owners: number[],
  table: ProcessTable | null,
): number[] | null => {
  if (table === null) return null
  const norm = (value: string): string => value.replace(/\s+/g, " ").trim()
  const self = table.get(running.pid)
  if (self === undefined) return null
  if (running.lstart === "" || norm(self.lstart) !== norm(running.lstart)) return null
  const found: number[] = []
  for (const owner of owners) {
    if (owner === running.pid) continue
    const row = table.get(owner)
    if (row === undefined) continue
    const visited = new Set<number>([owner])
    let current = row
    for (let hop = 0; hop < 16; hop += 1) {
      const parent = current.ppid
      if (parent === running.pid) {
        found.push(owner)
        break
      }
      if (parent <= 1) break
      if (visited.has(parent)) break
      visited.add(parent)
      const next = table.get(parent)
      if (next === undefined) break
      current = next
    }
  }
  return found
}

/** Pure drift core: no I/O, tested with injected inputs. */
export const reconcileOne = (input: ReconcileInput): ReconcileDrift | null => {
  const { name, expected, running, liveness } = input
  if (expected === null && running !== null) {
    return { service: name, kind: "extra", running: { pid: running.pid }, hint: `ow down ${name}` }
  }
  if (expected !== null && running === null) {
    return {
      service: name,
      kind: "missing",
      expected: { cmd: maskCmdShape(expected.cmd), cwd: expected.cwd, port: expected.port },
      hint: `ow up ${name}`,
    }
  }
  if (expected === null || running === null) return null
  if (running.exitCode !== undefined) {
    return { service: name, kind: "stopped", running: { pid: running.pid, exitCode: running.exitCode }, hint: `ow restart ${name}` }
  }
  if (liveness === "lstart-mismatch") {
    return { service: name, kind: "lstart-mismatch", running: { pid: running.pid }, hint: `ow down ${name} then ow up ${name} (suspected pid reuse)` }
  }
  if (liveness === "unknown") {
    return { service: name, kind: "stopped", running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  if (liveness === "dead") {
    return { service: name, kind: "stopped", running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  const diffs: Record<string, unknown> = {}
  const expectedShape = maskCmdShape(expected.cmd)
  const runningShape = maskCmdShape(running.cmd)
  if (expectedShape !== undefined && runningShape !== undefined && expectedShape !== runningShape) {
    diffs["cmd"] = { expected: expectedShape, running: runningShape }
  }
  if (expected.cwd !== undefined && running.cwd !== undefined && expected.cwd !== running.cwd) {
    diffs["cwd"] = { expected: expected.cwd, running: running.cwd }
  }
  if (expected.port !== undefined && running.port !== undefined && expected.port !== running.port) {
    diffs["port"] = { expected: expected.port, running: running.port }
  }
  const expectedEnv = [...(expected.env ? Object.keys(expected.env) : []), ...(expected.requiredEnv ?? [])].sort()
  const runningEnv = [...(running.envNames ?? [])].sort()
  if (running.envNames !== undefined && JSON.stringify(expectedEnv) !== JSON.stringify(runningEnv)) {
    diffs["env"] = { expected: expectedEnv, running: runningEnv }
  }
  const expectedDeps = [...(expected.dependsOn ?? [])].sort()
  const runningDeps = [...(running.dependsOn ?? [])].sort()
  if (running.dependsOn !== undefined && JSON.stringify(expectedDeps) !== JSON.stringify(runningDeps)) {
    diffs["depends_on"] = { expected: expectedDeps, running: runningDeps }
  }
  if (Object.keys(diffs).length > 0) {
    return { service: name, kind: "config-mismatch", expected: diffs, running: { pid: running.pid }, hint: `ow restart ${name}` }
  }
  // M-C artifact-stale: on a live + matching service, if the probe-declared
  // digest contradicts the recorded map (first basename in sort order,
  // deterministic). The digest comparison is case-insensitive (lowercased);
  // wire/human sees ONLY the basename (the full digest never enters
  // expected/running).
  if (input.artifacts !== undefined) {
    const { declared, recorded } = input.artifacts
    for (const base of Object.keys(declared).sort()) {
      const seen = recorded[base]
      if (seen !== undefined && seen.toLowerCase() !== declared[base].toLowerCase()) {
        return {
          service: name,
          kind: "artifact-stale",
          expected: { artifact: base },
          running: { pid: running.pid },
          hint: `rebuild + ow restart ${name}`,
        }
      }
    }
  }
  // Residual (accepted, non-destructive): an owner missing from the
  // snapshot (row cap, short-lived pid) still reports foreign-port rather
  // than claiming ownership it cannot prove. Residual (narrow): the
  // liveness-vs-table window can let the legacy fallback claim ownership
  // when the table lags a respawn the liveness check already passed.
  if (expected.port !== undefined && input.listening === true && input.portOwners !== null) {
    const owners = input.portOwners
    // An empty owner list is no owner evidence (lsof ok, nothing held):
    // never drift on it.
    if (owners.length === 0) return null
    if (owners.includes(running.pid)) return null
    const descendants = new Set(input.descendantOwners ?? [])
    const owned = owners.filter((pid) => descendants.has(pid))
    const foreign = owners.filter((pid) => !descendants.has(pid))
    if (owned.length > 0 && foreign.length === 0) return null
    if (owned.length > 0 && foreign.length > 0) {
      return {
        service: name,
        kind: "foreign-port",
        ownership: "shared",
        running: { pid: running.pid, port: expected.port },
        hint: `port ${expected.port} also held by a foreign listener (UNVERIFIED) — no kill, verify the owner`,
      }
    }
    return {
      service: name,
      kind: "foreign-port",
      running: { pid: running.pid, port: expected.port },
      hint: `port ${expected.port} foreign listener (UNVERIFIED) — no kill, verify the owner`,
    }
  }
  return null
}

/** `lsof -i :<port>` read-only port-owner probe (best-effort,
 * UNVERIFIED: platform output varies). No kill, an error silently
 * returns null. Runs at supervisor spawn + on the reconcile path, never
 * inside `ps`. */
export const portOwners = async (port: number, timeoutMs = 2000): Promise<number[] | null> => {
  try {
    const proc = Bun.spawn(["lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited
    const pids = out.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
    return pids
  } catch {
    return null
  }
}

const DRIFT_EN: Record<DriftKind, string> = {
  missing: "missing",
  extra: "extra",
  stopped: "stopped",
  "config-mismatch": "config-mismatch",
  "lstart-mismatch": "lstart-mismatch",
  "foreign-port": "foreign-port",
  "artifact-stale": "stale-build",
}

/** Locked human template (M-C): `stale-build: <svc> (<base> changed) →
 * rebuild + ow restart <svc>` (suggestion text; no button/automatic action). */
export const formatDrift = (drift: ReconcileDrift): string => {
  if (drift.kind === "artifact-stale") {
    const base = (drift.expected as Record<string, unknown> | undefined)?.["artifact"]
    return `stale-build: ${drift.service} (${typeof base === "string" ? base : "?"} changed) → rebuild + ow restart ${drift.service}`
  }
  return `${DRIFT_EN[drift.kind]}: ${drift.service} → ${drift.hint}`
}

/** M3 probe budget (M1 N3): total ≤60s SOFT wall — the last-starting probe
 * may exceed the budget by one timeout (a running probe is not cut short);
 * on overrun the remaining service is reported `unmeasured (timeout-budget)`,
 * and exit still follows drift. */
export const RECONCILE_PROBE_BUDGET_MS = 60_000

export type ReconcileReadiness = { service: string; ok: boolean; note: string }

/** Read-only `reconcile --check` run: exit 0 sync / 1 drift / 2 usage.
 * With `--probe`, defined probes run client-side one-shot (recorded-live
 * services under a live supervisor); results are added to the drift report
 * as `readiness:` lines, they do not change exit. */
export const runReconcileCheck = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe?: boolean
  /** Injected probe runner (default the real `runProbe`; tests use a fake). */
  runProbeFn?: import("./up-probe").ProbeFn
  /** Total probe budget (default 60s; tests shrink it). */
  probeBudgetMs?: number
  /** Injected process-table reader (default the real `readProcessTable`;
   * tests use a fake or a counter). Called lazily: only when owners are
   * non-empty and the recorded pid is not among them. */
  ownershipTableFn?: () => Promise<ProcessTable | null>
}): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml not found: ${opts.file}`)
    } else {
      console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: unreadable: supervisor.json corrupt — clean with `down --rm`")
      return 1
    }
  }
  const running = state?.services ?? []
  const names = [...new Set([...expected.map((svc) => svc.name), ...running.map((svc) => svc.name)])].sort()
  const drifts: ReconcileDrift[] = []
  // M-C: core inputs are kept (the post-probe artifact pass runs a second
  // time on the same instant inputs — deterministic, no re-measurement).
  const kernelInputs = new Map<string, { exp: UpService | null; run: UpServiceState | null; liveness: Liveness; listening: boolean | undefined; owners: number[] | null; descendants: number[] | undefined }>()
  for (const name of names) {
    const exp = expected.find((svc) => svc.name === name) ?? null
    const run = running.find((svc) => svc.name === name) ?? null
    let liveness: Liveness = "dead"
    let listening: boolean | undefined
    let owners: number[] | null = null
    if (run && run.exitCode === undefined) {
      if (run.lstart === "") {
        liveness = "unknown"
      } else {
        const current = await readLstart(run.pid)
        liveness = current === null ? "dead" : current === run.lstart ? "live" : "lstart-mismatch"
      }
    } else if (run) {
      liveness = "dead"
    }
    const port = exp?.port ?? run?.port
    if (port !== undefined && run && liveness === "live") {
      listening = await tcpListening(port)
      if (listening === true) owners = await portOwners(port)
    }
    // Bounded descendant ownership (lazy: the table is read only when
    // owners are non-empty and the recorded pid is not among them, so
    // the exact-match and unmeasured paths never spawn `ps`).
    let descendants: number[] | undefined
    if (
      port !== undefined &&
      run !== null &&
      liveness === "live" &&
      listening === true &&
      owners !== null &&
      owners.length > 0 &&
      !owners.includes(run.pid)
    ) {
      try {
        const table = await (opts.ownershipTableFn ?? readProcessTable)()
        const proven = descendantOwnersOf({ pid: run.pid, lstart: run.lstart }, owners, table)
        descendants = proven ?? undefined
      } catch {
        descendants = undefined
      }
    }
    const drift = reconcileOne({ name, expected: exp, running: run, liveness, listening, portOwners: owners, descendantOwners: descendants })
    if (drift) drifts.push(drift)
    kernelInputs.set(name, { exp, run, liveness, listening, owners, descendants })
  }
  // M2 revision witness (B4 point b: explicit `--check` one-shot, best
  // effort): recorded rev per service + live checkout rev. Display-only —
  // drift/exit/keys unchanged (`revisions` is additive). ow.yaml carries
  // no checkout pin, so the "new" side is always the live checkout.
  type Revision = { service: string; recordedRev?: string; recordedDirty?: boolean; liveRev?: string; liveDirty?: boolean; match?: boolean }
  const revisions: Revision[] = []
  for (const name of names) {
    const exp = expected.find((svc) => svc.name === name) ?? null
    const run = running.find((svc) => svc.name === name) ?? null
    const recorded = run?.provenance?.checkout
    const live = await gitCheckout(resolveCwdAbs(opts.rootDir, exp?.cwd ?? run?.cwd))
    if (recorded?.rev === undefined && live === null) continue
    const entry: Revision = { service: name }
    if (recorded?.rev !== undefined) {
      entry.recordedRev = recorded.rev
      if (recorded.dirty === true) entry.recordedDirty = true
    }
    if (live !== null) {
      entry.liveRev = live.rev
      if (live.dirty) entry.liveDirty = true
    }
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined) {
      entry.match = entry.recordedRev === entry.liveRev
    }
    revisions.push(entry)
  }
  const revMark = (rev: string, dirty: boolean | undefined): string => (dirty === true ? `${rev}+dirty` : rev)
  const revLines = revisions.map((entry) => {
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined && !entry.match) {
      return `diff: revision ${revMark(entry.recordedRev, entry.recordedDirty)}→${revMark(entry.liveRev, entry.liveDirty)} (${entry.service}; live checkout, no restart needed, report)`
    }
    if (entry.recordedRev !== undefined && entry.liveRev !== undefined) {
      return `rev: ${entry.service} ${revMark(entry.liveRev, entry.liveDirty)} (matched)`
    }
    if (entry.recordedRev !== undefined) return `rev: ${entry.service} ${revMark(entry.recordedRev, entry.recordedDirty)} (recorded; live unreadable)`
    return `rev: ${entry.service} ${revMark(entry.liveRev as string, entry.liveDirty)} (live only; no record)`
  })
  if (!opts.json) {
    for (const line of revLines) console.log(line)
  }
  // M3 `--probe` phase: read-only measurement independent of drift. Only
  // recorded-LIVE + defined services (dead/unknown are skipped — the drift
  // lines already cover them). Recording: via the request channel when a
  // live lock exists (sole-writer supervisor), otherwise skipped (the report
  // is preserved).
  let readiness: ReconcileReadiness[] = []
  // M-C build identity: probe-declared (basename → full digest) vs the
  // recorded map. Mismatch (live + ok entry) → artifact-stale drift; an
  // unrecorded basename → record-observation (request channel, no drift/
  // warning).
  const artifactStale: { service: string; artifact: string }[] = []
  let artifactJson: Record<string, Record<string, string>> | null = null
  if (opts.probe === true) {
    const { runProbeJob, declaredArtifactDigests, reduceArtifactMap } = await import("./up-probe")
    const { resolve: resolvePath } = await import("node:path")
    const runProbeFn = opts.runProbeFn ?? runProbeJob
    const deadline = Date.now() + (opts.probeBudgetMs ?? RECONCILE_PROBE_BUDGET_MS)
    const measured: ReconcileReadiness[] = []
    const toRecord: { service: string; pid: number; ok: boolean; note: string; artifacts?: Record<string, string> }[] = []
    for (const name of names) {
      const exp = expected.find((svc) => svc.name === name) ?? null
      const run = running.find((svc) => svc.name === name) ?? null
      if (exp?.readiness === undefined || run === undefined) continue
      let live = false
      if (run.exitCode === undefined && run.lstart !== "") {
        const current = await readLstart(run.pid)
        live = current !== null && current === run.lstart
      }
      if (!live) continue
      if (Date.now() > deadline) {
        measured.push({ service: name, ok: false, note: "unmeasured: timeout-budget" })
        continue
      }
      const outcome = await runProbeFn({
        probe: exp.readiness.probe,
        timeoutMs: PROBE_TIMEOUT_MS[exp.readiness.timeout],
        cwd: exp.cwd === undefined ? opts.rootDir : resolvePath(opts.rootDir, exp.cwd),
        env: { ...process.env, ...exp.env, OW_SERVICE: name },
      }).catch((): import("./up-probe").ProbeOutcome => ({ ok: false, note: "could-not-run", timedOut: false, code: null }))
      measured.push({ service: name, ok: outcome.ok, note: outcome.note })
      const declared = declaredArtifactDigests(outcome.checks)
      const recorded = run.artifactDigests ?? {}
      const unrecorded: Record<string, string> = {}
      for (const [base, digest] of Object.entries(declared)) {
        if (recorded[base] === undefined) unrecorded[base] = digest
      }
      toRecord.push({
        service: name,
        pid: run.pid,
        ok: outcome.ok,
        note: outcome.note,
        ...(Object.keys(unrecorded).length > 0 ? { artifacts: unrecorded } : {}),
      })
      if (Object.keys(declared).length > 0 && !drifts.some((drift) => drift.service === name)) {
        const prev = kernelInputs.get(name)
        if (prev?.run) {
          const artifactDrift = reconcileOne({
            name,
            expected: prev.exp,
            running: prev.run,
            liveness: prev.liveness,
            listening: prev.listening,
            portOwners: prev.owners,
            descendantOwners: prev.descendants,
            artifacts: { declared, recorded },
          })
          if (artifactDrift?.kind === "artifact-stale") {
            drifts.push(artifactDrift)
            artifactStale.push({ service: name, artifact: ((artifactDrift.expected as Record<string, unknown> | undefined)?.["artifact"] as string) })
          }
        }
      }
    }
    readiness = measured
    await recordReadinessResults(opts.rootDir, opts.file, toRecord, opts.json)
    // JSON wire: recorded maps (reduced short-8) + this round's drifts.
    const recordedJson: Record<string, Record<string, string>> = {}
    for (const svc of running) {
      if (svc.artifactDigests === undefined) continue
      recordedJson[svc.name] = Object.fromEntries(reduceArtifactMap(svc.artifactDigests).shown.map((entry) => [entry.base, entry.digest]))
    }
    artifactJson = recordedJson
  }
  const inSync = drifts.length === 0
  // G11: revision-stale advisory rides the readiness lines (display-only;
  // exits/JSON shapes unchanged — JSON consumers read revisions[].match).
  const revStale = new Set(revisions.filter((entry) => entry.match === false).map((entry) => entry.service))
  const readinessLines = readiness.map((entry) => {
    const stale = revStale.has(entry.service) ? " (revision-stale)" : ""
    return entry.ok
      ? `readiness: ${entry.service} ready${stale}`
      : entry.note.startsWith("unmeasured:")
        ? `readiness: ${entry.service} unmeasured (timeout-budget)${stale}`
        : `readiness: ${entry.service} not-ready (${entry.note})${stale}`
  })
  if (opts.json) {
    console.log(
      JSON.stringify({
        reconcile: { inSync, drifts },
        revisions,
        ...(opts.probe === true ? { readiness } : {}),
        // M-C additive wire (reduced short-8; the raw digest never reaches the wire).
        ...(opts.probe === true ? { artifactDigests: artifactJson ?? {}, artifactStale } : {}),
      }),
    )
  } else if (inSync) {
    console.log(`in-sync: ${expected.length} services (${expected.map((svc) => svc.name).join(", ")})`)
  } else {
    for (const drift of drifts) console.log(formatDrift(drift))
  }
  if (!opts.json) {
    for (const line of revLines) console.log(line)
    for (const line of readinessLines) console.log(line)
  }
  return inSync ? 0 : 1
}

/** Probe verdict records (B1-clean: live lock → request channel; silently
 * skipped when no lock). An ack loss only warns and does not break the verdict. */
export const recordReadinessResults = async (
  rootDir: string,
  file: string,
  results: { service: string; pid: number; ok: boolean; note: string; artifacts?: Record<string, string> }[],
  json: boolean,
): Promise<void> => {
  if (results.length === 0) return
  const { classifyLock, readSupervisorState, upPaths } = await import("./up-state")
  const { writeRequest, waitResult } = await import("./up-requests")
  try {
    const paths = upPaths(rootDir)
    if ((await classifyLock(paths.lockFile)).kind !== "live") return
    const state = await readSupervisorState(paths.supervisorFile)
    const pending: Promise<unknown>[] = []
    for (const result of results) {
      const pid = state?.services.find((entry) => entry.name === result.service)?.pid ?? result.pid
      const at = new Date().toISOString()
      pending.push(
        (async () => {
          try {
            const nonce = await writeRequest(paths.requestsDir, "readiness", result.service, file, {
              readiness: {
                pid,
                ok: result.ok,
                note: result.note,
                at,
                ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
              },
            })
            await waitResult(paths.requestsDir, nonce)
          } catch (error) {
            // M-h: bounded once-per-class (was per-service unbounded).
            if (!json) warnWriteFailed("readiness", `record unverified: ${result.service} (${error instanceof Error ? error.message : String(error)})`)
          }
        })(),
      )
    }
    await Promise.all(pending)
  } catch {
    // best-effort: the verdict has already been reported in every case
  }
}
