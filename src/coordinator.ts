/**
 * Dashboard-only coordinator snapshot (D3: P1 environment map + P2 preflight
 * + P3 checkpoint line + P4 provenance card + P5 scenario matrix).
 *
 * Read-only aggregate: recorded topology + reconcile from live status
 * (match/drift) + port preflight + runner-file bounded read
 * (frozen root, symlink not followed, 256KB/500 cap, selected-run read,
 * fail-closed + warnings[]).
 *
 * Sources (all recorded files; NO live exec, no CLI behavior change).
 * - P3: `.ow/checkpoints/<run>.jsonl` selected run — the `?run=` name (allowlist;
 *   empty/invalid/missing → the newest NON-EMPTY file + warning), an explicit request
 *   for an empty/corrupt file → section null + scan warning (no fallback).
 *   Envelope `at` = the stage-age source (D2 decision: envelope `at` +
 *   provenance `recordedAt` are the only clocks).
 * - P4: `.ow/supervisor.json` spawn records (provenance checkout rev +
 *   recordedAt = the recorded-rev age source) + store topology (expected) +
 *   environmentStatus (running). An unrecorded rev is not called
 *   "different live" — reading the live checkout requires a git exec (fail-closed:
 *   "unverified").
 * - P5: `<root>/ow.scenarios.yaml` v1 (subset-YAML mirror; argv/target
 *   raw values stay in the file) + store topology (reference check) +
 *   selected-run freshness (cell verdict).
 *
 * Secret discipline: all free-text fields are masked before they are
 * written to the wire (the mask below mirrors cli/up-reconcile.ts +
 * cli/up-evidence.ts rules on the node side — the CLI is bun-only, so it is not
 * imported, no behavior change); absolute paths reduce to basename.
 * Envelope normalization + freshness follow the same mirroring discipline
 * (cli/up-evidence.ts + cli/up-checkpoints.ts).
 * The full rev is carried on the wire (the copy button's clipboard payload) but is NEVER
 * rendered — only the short hash (7) appears in DOM/title/aria.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Store, resolveEnvironmentRecord, resolveWorkspaceRecord, type EnvironmentRecord } from './store.js';
import { maxProjectRoots } from './project-roots.js';
import { verifyMessages } from './verify.js';
import {
  environmentMessages,
  environmentStatus,
  probeTcpPort,
  suggestFreePort,
  type EnvironmentStatus,
} from './environment.js';

// --- Secret mask (mirror of the cli/up-reconcile.ts B3 list) ---------------

const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i;
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/;

function isSecretFlagToken(token: string): boolean {
  return /^(-{1,2})?[A-Za-z0-9_-]*(password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization)$/i.test(token)
    && !token.includes('=');
}

function maskSecretToken(token: string, prevIsSecretFlag: boolean): string {
  if (token.length === 0) return token;
  const eq = token.indexOf('=');
  if (eq > 0) {
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (SECRET_WORD.test(key) || SECRET_WORD.test(value) || /^[0-9a-fA-F]{32,}$/.test(value) || PROVIDER_PREFIX.test(value)) {
      return `${key}=***`;
    }
    return token;
  }
  if (prevIsSecretFlag) return '***';
  if (/^(-{1,2}[A-Za-z0-9_-]*password|^(-{1,2}[A-Za-z0-9_-]*secret)|(-{1,2}[A-Za-z0-9_-]*token))$/i.test(token)) return token;
  if (SECRET_WORD.test(token) || /^[0-9a-fA-F]{32,}$/.test(token) || PROVIDER_PREFIX.test(token)) return '***';
  return token;
}

/** Free-text secret mask: first the Bearer body, then a whitespace-preserving walk. */
export function maskSecrets(text: string): string {
  const afterBearer = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
  const looksSecretKey = (token: string): boolean =>
    SECRET_WORD.test(token.replace(/^["']+|["':=]+$/g, ''));
  const maskWord = (token: string): string => {
    const match = /^(\W*)(.*?)(\W*)$/.exec(token);
    if (!match || match[2].length === 0) return '***';
    return `${match[1]}***${match[3]}`;
  };
  const parts = afterBearer.split(/(\s+)/);
  let prev = '';
  let maskNext = false;
  return parts
    .map(part => {
      if (part.length === 0 || /^\s+$/.test(part)) return part;
      let masked: string;
      if (maskNext) {
        masked = maskWord(part);
        maskNext = false;
      } else if (part.includes('=') && !/^[:=]+$/.test(part)) {
        masked = maskSecretToken(part, isSecretFlagToken(prev));
      } else if (/^[:=]+$/.test(part)) {
        if (looksSecretKey(prev)) maskNext = true;
        masked = part;
      } else if (/[:=]["']?$/.test(part)) {
        if (looksSecretKey(part)) maskNext = true;
        masked = part;
      } else if (isSecretFlagToken(part)) {
        masked = part;
        maskNext = true;
      } else if (
        SECRET_WORD.test(part)
        || /^[0-9a-fA-F]{32,}$/.test(part)
        || PROVIDER_PREFIX.test(part)
      ) {
        masked = maskWord(part);
      } else {
        masked = part;
      }
      prev = part;
      return masked;
    })
    .join('');
}

// --- Wire tipleri ------------------------------------------------------------

export interface CoordinatorDrift {
  service: string;
  field: string;
  expected: string;
  actual: string;
}

export interface CoordinatorReconcile {
  inSync: boolean;
  drifts: CoordinatorDrift[];
}

export interface CoordinatorReadinessEntry {
  serviceId: string;
  name: string;
  /** Directory name (basename) of the recorded root — a full path never enters the wire. */
  dir: string | null;
  status: string;
  detail: string;
  lastPoll: EnvironmentRecord['owned'][number]['lastPoll'];
  /** Worktree identity (additive-optional): carried only when >1 root is
   * registered; absent from single-root snapshots.
   * `revShort` is null when missing → UI renders a basename-only chip. */
  worktree?: { rootBase: string; revShort: string | null };
}

export interface CoordinatorPreflightGate {
  service: string;
  port: number | null;
  free: boolean;
  note: string;
}

export interface CoordinatorPreflight {
  pass: boolean;
  gates: CoordinatorPreflightGate[];
  missing: string[];
}

export interface CoordinatorMeta {
  producedAt: string;
  snapshotId: string;
  environment: string;
}

export type CheckpointStageStatus = 'confirmed' | 'not_observed' | 'stale';

export interface CoordinatorCheckpointStage {
  stage: string;
  status: CheckpointStageStatus;
  /** Raw English enum (the UI maps it for display — §3). */
  staleReason: string | null;
  /** Envelope record time (the stage-age source). */
  at: string;
  /** M-A (#2): raw English flag (`null` ≡ missing → UI renders `unknown`). */
  sideEffect: string | null;
  sideEffectAttempted: number | null;
  sideEffectConfirmed: number | null;
  /** M-A (#3): lineage (both `null` → unattributed, outside the tree). */
  scenario: string | null;
  attempt: number | null;
  stepSignature: string | null;
}

export interface CoordinatorCheckpoints {
  /** File name (not a path) — the selected run (latest when there is no ?run=). */
  run: string;
  /** Discovered run names (new→old); the ?run= selection comes from here. */
  runs: string[];
  stages: CoordinatorCheckpointStage[];
  summary: { confirmed: number; stale: number; notObserved: number };
  lastVerified: { stage: string; at: string } | null;
  firstGap: { stage: string; status: CheckpointStageStatus; staleReason: string | null; at: string } | null;
  /** Plain-text suggestion (not wired to a button). */
  safeNextAction: string | null;
  /** M-A (#2): true when there is an attempted-unconfirmed → the UI shows the
   * locked `before-retry: ow reconcile --check` text (no action). */
  retryHint: boolean;
}

export interface CoordinatorRevision {
  /** The single on-screen representation (7 characters). */
  short: string;
  /** ONLY the copy button's clipboard payload — never written to the DOM. */
  full: string;
  /** First-seen record time (envelope `at` / provenance `recordedAt`). */
  at: string | null;
  // NOTE: the `services` field is deliberately absent — the strip label is short-hash+age
  // (§3); envelope revs never had a service attribution and the supervisor side carried a single
  // name (lost information). D3 (P5 scenario matrix) does not need a rev-service
  // mapping; add it to the wire if the need arises.
  /** Newest rev (highlighted on the strip). */
  current: boolean;
  /** Matches the supervisor spawn record. */
  recorded: boolean;
}

export interface CoordinatorExplanationEntry {
  service: string;
  expected: { cmd: string | null; dir: string | null; port: number | null } | null;
  running: { status: string; detail: string } | null;
  /** The rev line is never a bare hash: short + badge + age merge in the UI. */
  revShort: string | null;
  revFull: string | null;
  revAt: string | null;
  revDirty: boolean;
  revRecorded: boolean;
  diffs: string[];
  note: string;
  /** M-C build identity (reduced from the recorded map: masked-basename +
   * short-8, first 32 in order; a full path/full digest never reaches the wire). */
  artifacts: { base: string; digest: string }[];
  artifactRest: number;
}

export type ScenarioVerdict = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';

/** M9 overlay source tag (mirror of the CLI `boundarySources` entries:
 * per-scenario boundary provenance — `base` or the `local` convention;
 * there is no flag channel server-side by design). */
export interface OverlayBoundarySource {
  scenario: string;
  boundary: string;
  source: string;
}

export interface ScenarioMatrixRow {
  name: string;
  services: string[];
  /** No counterpart in the topology (UNVERIFIED) — marked with a yellow badge. */
  unverifiedServices: string[];
  /** ONLY id + timeout: the probe argv stays in the file, never reaches the wire. */
  probes: { id: string; timeout: string }[];
  checkpoints: string[];
  /** From the column name to the cell verdict (column order lives in the UI). */
  cells: Record<string, ScenarioVerdict>;
}

export interface CoordinatorScenarios {
  /** File name (not a path) — always `ow.scenarios.yaml` in the roots. */
  file: string;
  /** Boundary columns: known order first, unknown ones alphabetical. */
  columns: string[];
  rows: ScenarioMatrixRow[];
  /** Section warnings (schema warnings + duplicates). */
  warnings: string[];
  /** Corrupt file: lines empty + the reason here (the other panels stay intact). */
  error: string | null;
  /** M9 overlay source tags (additive-optional): present only when the
   * local convention applied in at least one root; absent keeps old
   * readers byte-identical. */
  overlayApplied?: boolean;
  overlayFile?: string | null;
  boundarySources?: OverlayBoundarySource[];
  /** M9 invalid-overlay box (additive-optional): the base matrix still
   * renders; the message names the refusal (never a crash). */
  overlayError?: string | null;
}

export interface CoordinatorExplanation {
  entries: CoordinatorExplanationEntry[];
  revisions: CoordinatorRevision[];
}

/** Readiness-strip chip: boundary name (masked wire value) + rolled-up
 * cell verdict across matrix rows. */
export type BoundaryChipStatus = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';
export interface CoordinatorBoundaryChip {
  boundary: string;
  status: BoundaryChipStatus;
}

/** Readiness-strip last-run line: selected run id, last verified time
 * (null when nothing verified), and the all-green verdict. */
export interface CoordinatorLastRun {
  id: string;
  at: string | null;
  pass: boolean;
}

/** Readiness-strip gate line: preflight pass + missing entries. */
export interface CoordinatorReadinessGate {
  pass: boolean;
  missing: string[];
}

export interface CoordinatorSnapshot {
  reconcile: CoordinatorReconcile;
  readiness: CoordinatorReadinessEntry[];
  /** null when there is no record → the UI shows "no provenance record". */
  explanation: CoordinatorExplanation | null;
  preflight: CoordinatorPreflight;
  /** null when there is no/corrupt record → the UI shows "no checkpoint". */
  checkpoints: CoordinatorCheckpoints | null;
  /**
   * Discovered checkpoint run names (new→old) — may be non-empty even while
   * checkpoints is null; the run selector in the null branch is fed from here.
   * Read-only list, used for a single `?run=` refetch.
   */
  runs: string[];
  /**
   * null when the file is missing → the UI shows "no scenario file attached".
   * Corrupt file: an object with error (error box; the other panels stay intact).
   */
  scenarios: CoordinatorScenarios | null;
  /** Readiness strip (M8, additive-optional): present only when a
   * scenarios file is bound (null file keeps the wire byte-identical).
   * Absent sections render the strip `unmeasured` placeholder, never crash. */
  boundaryList?: CoordinatorBoundaryChip[];
  lastRun?: CoordinatorLastRun | null;
  readinessGate?: CoordinatorReadinessGate | null;
  /** Ownership ledger (additive-optional): carried only when >1 root is
   * registered; absent from single-root snapshots.
   * Absence is the "no record" branch in the UI (old readers skip it). */
  worktrees?: CoordinatorWorktreeEntry[];
  warnings: string[];
  meta: CoordinatorMeta;
}

// --- Checkpoint envelope mirror (cli/up-evidence.ts + cli/up-checkpoints.ts) --
// Shape-strict fail-closed: a corrupt line does not kill the section (counted as corrupt).

const ENVELOPE_BY = new Set(['runner', 'ow-preflight', 'ow-reconcile', 'ow-probe']);
const STALE_REASONS = new Set(['script_hash', 'checkout_rev', 'runtime', 'missing_basis']);
const SAFE_NEXT_ACTION_MAX = 512;
const TRUNCATION_MARK = '…[truncated]';
const REV_MAX_CHARS = 64;
// M-A (#2/#3) cap'leri — CLI `cli/up-evidence.ts` kilidiyle birebir.
const SIDE_EFFECTS = new Set(['none', 'attempted', 'confirmed', 'unknown']);
const SIDE_EFFECT_COUNT_MAX = 999999;
const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ATTEMPT_MIN = 1;
const ATTEMPT_MAX = 999;
const STEP_SIGNATURE_MAX = 128;

export interface ParsedCheckpointEnvelope {
  stage: string;
  status: CheckpointStageStatus;
  staleReason: string | null;
  safeNextAction: string | null;
  at: string;
  /**
   * M-B (#5) code map: wire keys are FIXED (`checkoutRev` = runner
   * slot, `scriptHash` = body slot; legacy `checkout_rev`/`script_hash`
   * map here on read, never written on the wire). New slots `fixture` +
   * `providerContract`. All four undefined + runtime undefined →
   * `missing_basis`; any code-slot mismatch stales to `script_hash`
   * (code-map mismatch; enum constant).
   */
  checkoutRev?: string;
  scriptHash?: string;
  fixture?: string;
  providerContract?: string;
  port?: number;
  /**
   * Fully resolved cwd — an inner slot ONLY for the freshness comparison
   * (CLI `slotsOf` mirror: cwd is compared by full path). Never reaches the wire/output
   * (not even basename reduction — cwd is not rendered in P3/P4).
   */
  cwdFull?: string;
  provenanceRev?: string;
  /**
   * M-A (#2/#3) wire mirror (identical to the CLI `cli/up-evidence.ts` lock):
   * `side_effect`→`sideEffect`, `side_effect_counts`→`sideEffectCounts`,
   * `scenario`→`scenario`, `attempt`→`attempt`,
   * `step_signature`→`stepSignature`. A missing `side_effect` is carried as
   * `null` on the wire (renders as `unknown`). Freshness ignores these fields (orthogonal).
   */
  sideEffect: string | null;
  sideEffectCounts: { attempted?: number; confirmed?: number } | null;
  scenario: string | null;
  attempt: number | null;
  stepSignature: string | null;
}

function revField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const rev = value.trim();
  if (rev.length === 0 || rev.length > REV_MAX_CHARS) return undefined;
  // A secret-shaped rev fails safe to masked (***) — e.g. token=hunter2-….
  // Legitimate shapes (hex SHA incl. 40-hex, short id, branch name) pass as-is:
  // the long-hex rule does not apply (a 40-hex SHA is the primary legitimate shape —
  // maskSecrets' 32+hex rule is invalid here). Real producers
  // write only hex (up-provenance gitCheckout: /^[0-9a-fA-F]{4,64}$/);
  // CLI fixture ids ("rev1", "abc123") contain no secret word.
  if (SECRET_WORD.test(rev) || PROVIDER_PREFIX.test(rev)) return '***';
  return rev;
}

/** Pure envelope normalization (tests inject hostile fixtures through here). */
export function normalizeCheckpointEnvelope(raw: unknown): { ok: true; envelope: ParsedCheckpointEnvelope } | { ok: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const dict = raw as Record<string, unknown>;
  if (typeof dict['stage'] !== 'string' || (dict['stage'] as string).trim().length === 0) return { ok: false };
  if (dict['status'] !== 'confirmed' && dict['status'] !== 'not_observed' && dict['status'] !== 'stale') return { ok: false };
  if (typeof dict['at'] !== 'string' || !Number.isFinite(Date.parse(dict['at'] as string))) return { ok: false };
  if (typeof dict['by'] !== 'string' || !ENVELOPE_BY.has(dict['by'] as string)) return { ok: false };
  const status = dict['status'] as CheckpointStageStatus;
  const reason = dict['stale_reason'];
  if (status === 'stale') {
    if (typeof reason !== 'string' || !STALE_REASONS.has(reason)) return { ok: false };
  } else if (reason !== undefined) {
    return { ok: false };
  }
  const envelope: ParsedCheckpointEnvelope = {
    stage: dict['stage'] as string,
    status,
    staleReason: status === 'stale' ? (reason as string) : null,
    safeNextAction: null,
    at: dict['at'] as string,
    sideEffect: null,
    sideEffectCounts: null,
    scenario: null,
    attempt: null,
    stepSignature: null,
  };
  if (typeof dict['safe_next_action'] === 'string') {
    const text = maskSecrets(dict['safe_next_action'] as string);
    envelope.safeNextAction = text.length <= SAFE_NEXT_ACTION_MAX ? text : `${text.slice(0, SAFE_NEXT_ACTION_MAX - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
  } else if (dict['safe_next_action'] !== undefined) {
    return { ok: false };
  }
  if (dict['code'] !== undefined) {
    if (typeof dict['code'] !== 'object' || dict['code'] === null || Array.isArray(dict['code'])) return { ok: false };
    const code = dict['code'] as Record<string, unknown>;
    // M-B (#5): 4 slots + legacy equivalent (identical to the CLI
    // `cli/up-evidence.ts` lock: script_hash→body, checkout_rev→runner; if the same slot
    // arrives under both names the line is corrupt; a present-but-undisciplined value breaks the line).
    const slot = (key: string): { present: boolean; value: string | undefined } => {
      const raw = code[key];
      if (raw === undefined) return { present: false, value: undefined };
      return { present: true, value: revField(raw) };
    };
    const runner = slot('runner');
    const fixture = slot('fixture');
    const body = slot('body');
    const providerContract = slot('provider_contract');
    const legacyHash = slot('script_hash');
    const legacyRev = slot('checkout_rev');
    if ((legacyHash.present && body.present) || (legacyRev.present && runner.present)) return { ok: false };
    const resolve = (fresh: { present: boolean; value: string | undefined }, legacy: { present: boolean; value: string | undefined }): string | undefined | null => {
      const present = fresh.present || legacy.present;
      const value = fresh.present ? fresh.value : legacy.value;
      if (present && value === undefined) return null;
      return value;
    };
    const runnerValue = resolve(runner, legacyRev);
    const fixtureValue = resolve(fixture, { present: false, value: undefined });
    const bodyValue = resolve(body, legacyHash);
    const providerContractValue = resolve(providerContract, { present: false, value: undefined });
    if (runnerValue === null || fixtureValue === null || bodyValue === null || providerContractValue === null) return { ok: false };
    let known = 0;
    if (runnerValue !== undefined) { envelope.checkoutRev = runnerValue; known += 1; }
    if (fixtureValue !== undefined) { envelope.fixture = fixtureValue; known += 1; }
    if (bodyValue !== undefined) { envelope.scriptHash = bodyValue; known += 1; }
    if (providerContractValue !== undefined) { envelope.providerContract = providerContractValue; known += 1; }
    if (known === 0 && Object.keys(code).length > 0) return { ok: false };
  }
  if (dict['runtime'] !== undefined) {
    if (typeof dict['runtime'] !== 'object' || dict['runtime'] === null || Array.isArray(dict['runtime'])) return { ok: false };
    const runtime = dict['runtime'] as Record<string, unknown>;
    let known = 0;
    if (typeof runtime['port'] === 'number') { envelope.port = runtime['port']; known += 1; }
    if (typeof runtime['cwd'] === 'string') { envelope.cwdFull = resolve(runtime['cwd'] as string); known += 1; }
    const provenanceRev = revField(runtime['provenance_rev']);
    if (provenanceRev !== undefined) { envelope.provenanceRev = provenanceRev; known += 1; }
    if (known === 0 && Object.keys(runtime).length > 0) return { ok: false };
  }
  // M-A (#2): side-effect flag — an invalid enum breaks the line (never coerced).
  if (dict['side_effect'] !== undefined) {
    if (typeof dict['side_effect'] !== 'string' || !SIDE_EFFECTS.has(dict['side_effect'] as string)) return { ok: false };
    envelope.sideEffect = dict['side_effect'] as string;
  }
  // M-A (#2): the counters are render-only (ow does not compute them); an
  // out-of-range / non-integer / shapeless value breaks the line.
  if (dict['side_effect_counts'] !== undefined) {
    const counts = dict['side_effect_counts'];
    if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return { ok: false };
    const table = counts as Record<string, unknown>;
    const picked: { attempted?: number; confirmed?: number } = {};
    for (const key of ['attempted', 'confirmed'] as const) {
      if (table[key] !== undefined) {
        if (typeof table[key] !== 'number' || !Number.isInteger(table[key]) || (table[key] as number) < 0 || (table[key] as number) > SIDE_EFFECT_COUNT_MAX) {
          return { ok: false };
        }
        picked[key] = table[key] as number;
      }
    }
    if (Object.keys(picked).length > 0) envelope.sideEffectCounts = picked;
    else if (Object.keys(table).length > 0) return { ok: false };
  }
  // M-A (#3): lineage — scenario RUN_NAME_PATTERN shape, attempt 1..999 integer.
  if (dict['scenario'] !== undefined) {
    if (typeof dict['scenario'] !== 'string' || !SCENARIO_PATTERN.test(dict['scenario'] as string)) return { ok: false };
    envelope.scenario = maskSecrets(dict['scenario'] as string);
  }
  if (dict['attempt'] !== undefined) {
    if (typeof dict['attempt'] !== 'number' || !Number.isInteger(dict['attempt']) || (dict['attempt'] as number) < ATTEMPT_MIN || (dict['attempt'] as number) > ATTEMPT_MAX) {
      return { ok: false };
    }
    envelope.attempt = dict['attempt'] as number;
  }
  // M-A (+M-D): step signature 1..128ch opaque string (mask-before-cap).
  if (dict['step_signature'] !== undefined) {
    if (typeof dict['step_signature'] !== 'string' || (dict['step_signature'] as string).length === 0 || (dict['step_signature'] as string).length > STEP_SIGNATURE_MAX) {
      return { ok: false };
    }
    const masked = maskSecrets(dict['step_signature'] as string);
    envelope.stepSignature = masked.length <= STEP_SIGNATURE_MAX ? masked : `${masked.slice(0, STEP_SIGNATURE_MAX - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
  }
  return { ok: true, envelope };
}

function applyCheckpointFreshness(envelopes: ParsedCheckpointEnvelope[]): ParsedCheckpointEnvelope[] {
  // M-A notu: sideEffect/sideEffectCounts/scenario/attempt/stepSignature
  // is orthogonal to freshness (ignored here — CLI `applyFreshness` mirror).
  // M-B (#5): the 4 code slots in fixed order (runner → fixture → body →
  // provider_contract); any code-slot mismatch stales to the enum-constant
  // `script_hash` (code-map mismatch).
  const basisByStage = new Map<string, ParsedCheckpointEnvelope>();
  for (const envelope of envelopes) {
    if (envelope.status === 'confirmed' && !basisByStage.has(envelope.stage)) basisByStage.set(envelope.stage, envelope);
  }
  return envelopes.map(envelope => {
    if (envelope.status !== 'confirmed') return { ...envelope };
    if (envelope.scriptHash === undefined && envelope.checkoutRev === undefined && envelope.fixture === undefined && envelope.providerContract === undefined && envelope.port === undefined && envelope.cwdFull === undefined && envelope.provenanceRev === undefined) {
      return { ...envelope, status: 'stale' as const, staleReason: 'missing_basis' };
    }
    const basis = basisByStage.get(envelope.stage) as ParsedCheckpointEnvelope;
    if (basis.checkoutRev !== envelope.checkoutRev || basis.fixture !== envelope.fixture || basis.scriptHash !== envelope.scriptHash || basis.providerContract !== envelope.providerContract) {
      return { ...envelope, status: 'stale' as const, staleReason: 'script_hash' };
    }
    if (basis.port !== envelope.port || basis.cwdFull !== envelope.cwdFull || basis.provenanceRev !== envelope.provenanceRev) {
      return { ...envelope, status: 'stale' as const, staleReason: 'runtime' };
    }
    return { ...envelope, staleReason: null };
  });
}

export interface CheckpointSource {
  run: string;
  envelopes: ParsedCheckpointEnvelope[];
  /** Discovered run names (new→old, ≤50). */
  runs: string[];
}

export interface SupervisorProvenanceRecord {
  name: string;
  port?: number;
  rev?: string;
  dirty?: boolean;
  recordedAt?: string;
  exitCode?: number;
   /** Basename of the reading root (`readSupervisorRecords` fills it; full path never reaches the wire). */
  rootBase?: string;
  /** M-C probe-declared build identity (raw basename → full digest from the
   * state file; carried reduced on the wire). */
  artifactDigests?: Record<string, string>;
  // NOTE: `cwdBase`/`lastReadiness` are deliberately absent — P4 expected/running
  // environmentStatus + the spawn rev; the supervisor cwd and the
  // the lastReadiness record is not rendered. D3 (P5 + a11y) wants neither
  // (§5-D3); if cwd-diff display arises, add it as a full-path inner slot + basename-output
  // pair together.
}

export function shortRev(full: string): string {
  return full.slice(0, 7);
}

// --- Scenario mirror (cli/up-scenarios.ts v1 + cli/up-schema.ts subset) ----
// The CLI is bun-only, so it is not imported; this is a behavior mirror.
// argv NEVER reaches the wire (we do not even carry the CLI masked shape — the matrix
// only counts ids); targets/checkpoints names go through the mask.

export const SCENARIOS_FILE_NAME = 'ow.scenarios.yaml';
const SCENARIOS_VERSION = '1';
const SCENARIO_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
/** M1 taxonomy mirror (cli/up-scenarios.ts): new-enum base set for known
 * classification and column ordering; legacy values map through before
 * classification (never a failure). */
const SCENARIO_BOUNDARY_NEW_BASE: ReadonlySet<string> = new Set([
  'real-read-only',
  'real-state-changing',
  'network-deny',
  'subscribed',
  'unverified',
]);
const SCENARIO_BOUNDARY_LEGACY_MAP: Readonly<Record<string, string>> = {
  real: 'real-state-changing',
  local: 'real-read-only',
  'captured-response': 'subscribed',
  fake: 'unverified',
  test: 'unverified',
};
const SCENARIO_BLOCKED_PREFIX = 'blocked:';
const SCENARIO_BLOCKED_REASON_MAX = 128;
const SCENARIO_BOUNDARIES = ['real-read-only', 'real-state-changing', 'network-deny', 'subscribed', 'blocked', 'unverified'];
const SCENARIO_KNOWN_BOUNDARIES = new Set(SCENARIO_BOUNDARY_NEW_BASE);

/** Known-boundary check mirroring classification: new-enum base plus
 * well-formed `blocked:<reason>` (bare/malformed blocked stays unknown). */
function isKnownScenarioBoundary(value: string): boolean {
  if (SCENARIO_KNOWN_BOUNDARIES.has(value)) return true;
  return normalizeScenarioBoundary(value).known;
}

/** Pure boundary normalize (never throws; cli/normalizeBoundary mirror):
 * new-enum passes through, legacy maps, `blocked:<reason>` is preserved,
 * unknown/empty/malformed-blocked falls back to raw (caller classifies
 * unknown as unverified). Returns normalized value + known flag +
 * legacy source for warn parity. */
export function normalizeScenarioBoundary(raw: string): { normalized: string; known: boolean; legacySource: string | null } {
  const value = raw.trim();
  if (value.startsWith(SCENARIO_BLOCKED_PREFIX)) {
    const unquoted = value.slice(SCENARIO_BLOCKED_PREFIX.length).trim();
    const reason = unquoted.length >= 2 && ((unquoted.startsWith('"') && unquoted.endsWith('"')) || (unquoted.startsWith("'") && unquoted.endsWith("'")))
      ? unquoted.slice(1, -1).trim()
      : unquoted;
    if (reason.length > 0 && [...reason].length <= SCENARIO_BLOCKED_REASON_MAX) {
      return { normalized: `${SCENARIO_BLOCKED_PREFIX}${reason}`, known: true, legacySource: null };
    }
    return { normalized: value, known: false, legacySource: null };
  }
  if (SCENARIO_BOUNDARY_NEW_BASE.has(value)) return { normalized: value, known: true, legacySource: null };
  const mapped = SCENARIO_BOUNDARY_LEGACY_MAP[value];
  if (mapped !== undefined) return { normalized: mapped, known: true, legacySource: value };
  return { normalized: value, known: false, legacySource: null };
}
const SCENARIO_MAX_COUNT = 32;
const SCENARIO_MAX_COLUMNS = 16;
const SCENARIOS_MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUTS = new Set(['5s', '10s', '30s']);
const PROBE_DEFAULT_TIMEOUT = '10s';
const PROBE_MAX_PARTS = 16;
const PROBE_MAX_PART_BYTES = 512;
const SHELL_ARGV0 = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
export const RUN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type YamlScalar = string;
interface YamlMap { [key: string]: YamlNode }
type YamlNode = YamlScalar | YamlScalar[] | YamlMap;

function yamlUnquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function yamlStripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Top-level comma split: `[]`/`{}` depth + quote awareness (CLI mirror). */
function yamlSplitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (current.length === 0 || /[\s:\[{,]$/.test(current)) quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part.length > 0);
}

function yamlParseFlowList(raw: string): YamlScalar[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  return yamlSplitTopLevel(inner).map(part => yamlUnquote(part));
}

function yamlParseFlowMap(raw: string): Record<string, YamlNode> {
  const inner = raw.trim().slice(1, -1).trim();
  const out: Record<string, YamlNode> = Object.create(null);
  if (inner.length === 0) return out;
  for (const part of yamlSplitTopLevel(inner)) {
    const colon = part.indexOf(':');
    if (colon < 0) throw new Error('key: value expected inside map');
    const key = yamlUnquote(part.slice(0, colon).trim());
    const value = part.slice(colon + 1).trim();
    if (key.length === 0 || value.length === 0) throw new Error('empty key/value inside map');
    if (key in out) throw new Error('duplicate key inside map');
    out[key] = yamlParseValue(value);
  }
  return out;
}

function yamlParseValue(rest: string): YamlNode {
  if (rest.startsWith('[') && rest.endsWith(']')) return yamlParseFlowList(rest);
  if (rest.startsWith('{') && rest.endsWith('}')) return yamlParseFlowMap(rest);
  return yamlUnquote(rest);
}

function yamlParseSubset(text: string): Record<string, YamlNode> {
  const root: Record<string, YamlNode> = {};
  const stack: { indent: number; map: Record<string, YamlNode> }[] = [{ indent: -1, map: root }];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const bare = yamlStripComment(lines[n]).replace(/\s+$/, '');
    if (bare.trim().length === 0) continue;
    const indent = bare.match(/^ */)?.[0].length ?? 0;
    const trimmed = bare.trim();
    if (trimmed.startsWith('- ')) throw new Error('block lists unsupported (use a flow list: [a, b])');
    const colon = trimmed.indexOf(':');
    if (colon < 0) throw new Error('key: value expected');
    const key = yamlUnquote(trimmed.slice(0, colon).trim());
    const rest = trimmed.slice(colon + 1).trim();
    if (key.length === 0) throw new Error('empty key');
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].map;
    if (rest.length === 0) {
      if (indent === 0 && parent !== root) throw new Error(`unexpected indent: ${key}`);
      for (let m = n + 1; m < lines.length; m += 1) {
        const peer = yamlStripComment(lines[m]).trim();
        if (peer.length === 0) continue;
        if (peer.startsWith('- ')) throw new Error('block lists unsupported (use a flow list: [a, b])');
        break;
      }
      if (stack.length >= 3) throw new Error(`level 3 unsupported: ${key}`);
      const child: Record<string, YamlNode> = {};
      if (Object.hasOwn(parent, key)) throw new Error(`duplicate key: ${key}`);
      parent[key] = child;
      stack.push({ indent, map: child });
      continue;
    }
    if (Object.hasOwn(parent, key)) throw new Error(`duplicate key: ${key}`);
    parent[key] = yamlParseValue(rest);
  }
  return root;
}

export interface ParsedScenario {
  name: string;
  services: string[];
  boundaries: string[];
  probes: { id: string; timeout: string }[];
  checkpoints: string[];
}

/**
 * Pure v1 scenario normalization: shape-strict fail-closed (throws —
 * the caller turns it into the `error` box). Warnings return in a warn-only list.
 * argv/target raw VALUES drop (id/timeout/name lists remain).
 */
export function normalizeScenarios(text: string): { scenarios: ParsedScenario[]; warnings: string[] } {
  const fileWarnings: string[] = [];
  let doc: Record<string, YamlNode>;
  try {
    doc = yamlParseSubset(text);
  } catch (error) {
    throw new Error(`invalid scenario file: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'scenarios') fileWarnings.push(`unknown top-level field ignored: ${key}`);
  }
  if (doc['version'] !== SCENARIOS_VERSION) throw new Error('invalid scenario file: `version: 1` required');
  const raw = doc['scenarios'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid scenario file: `scenarios:` map required');
  const entries = Object.entries(raw as Record<string, YamlNode>);
  if (entries.length === 0) throw new Error('invalid scenario file: no scenarios (empty `scenarios:`)');
  if (entries.length > SCENARIO_MAX_COUNT) throw new Error(`invalid scenario file: at most ${SCENARIO_MAX_COUNT} scenarios (v1 limit)`);
  const scenarios: ParsedScenario[] = [];
  for (const [name, node] of entries) {
    if (!SCENARIO_NAME_PATTERN.test(name)) throw new Error(`invalid scenario file: invalid scenario name: ${name}`);
    if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error(`invalid scenario file: ${name}: scenario map expected`);
    const fields = node as Record<string, YamlNode>;
    // M-c parity: explicit non-goals reject like the CLI (error box),
    // never warn-and-render.
    for (const key of Object.keys(fields)) {
      if (['fault', 'soak', 'load-test', 'schedul', 'deploy'].some(prefix => key.startsWith(prefix))) {
        throw new Error(`invalid scenario file: ${name}: non-goal rejected: ${key} (fault/soak/load-test/schedule/deploy are out of scope)`);
      }
    }
    for (const key of Object.keys(fields)) {
      if (!['services', 'boundaries', 'targets', 'probes', 'checkpoints'].includes(key)) {
        fileWarnings.push(`${name}: unknown field ignored: ${key}`);
      }
    }
    const asList = (value: YamlNode | undefined, what: string): string[] => {
      if (value === undefined) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) {
        for (const part of value) {
          if (typeof part !== 'string') throw new Error(`invalid scenario file: ${what} must be text or a list`);
        }
        return [...value] as string[];
      }
      throw new Error(`invalid scenario file: ${what} must be text or a list`);
    };
    if (fields['services'] === undefined) throw new Error(`invalid scenario file: ${name}: services required`);
    const services = asList(fields['services'], `${name}: services`);
    // M11 mirror: explicit `services: []` is valid (no services by
    // decision); probes stay required below, so vacuity still fails closed.
    const rawBoundaries = asList(fields['boundaries'], `${name}: boundaries`);
    // M1 dual-read: legacy maps before classification (one legacy-boundary
    // warning per value); known values normalize, unknown stays raw for
    // the unverified cell verdict downstream.
    const seenLegacy = new Set<string>();
    const boundaries = rawBoundaries.map(raw => {
      // M-c parity: malformed blocked rejects like the CLI (bare `blocked`,
      // empty reason, or >128 chars is a schema error, never UNVERIFIED).
      const trimmed = raw.trim();
      if (trimmed === 'blocked' || trimmed.startsWith('blocked:')) {
        const reasonRaw = trimmed === 'blocked' ? '' : trimmed.slice('blocked:'.length).trim();
        const reason = reasonRaw.length >= 2 && ((reasonRaw.startsWith('"') && reasonRaw.endsWith('"')) || (reasonRaw.startsWith("'") && reasonRaw.endsWith("'")))
          ? reasonRaw.slice(1, -1).trim()
          : reasonRaw;
        if (reason.length === 0 || [...reason].length > SCENARIO_BLOCKED_REASON_MAX) {
          throw new Error(`invalid scenario file: ${name}: blocked:<reason> required (1-128 chars)`);
        }
      }
      const norm = normalizeScenarioBoundary(raw);
      if (norm.legacySource !== null && !seenLegacy.has(norm.legacySource)) {
        seenLegacy.add(norm.legacySource);
        fileWarnings.push(`legacy-boundary: ${norm.legacySource} → ${norm.normalized} (warning)`);
      }
      return norm.known ? norm.normalized : raw;
    });
    asList(fields['targets'], `${name}: targets`);
    const checkpoints = asList(fields['checkpoints'], `${name}: checkpoints`);
    const probesRaw = fields['probes'];
    if (probesRaw === undefined) throw new Error(`invalid scenario file: ${name}: probes required`);
    if (!Array.isArray(probesRaw) || probesRaw.length === 0) throw new Error(`invalid scenario file: ${name}: probes must be a list`);
    const probes: { id: string; timeout: string }[] = [];
    for (const entry of probesRaw) {
      if (typeof entry !== 'string') throw new Error(`invalid scenario file: ${name}: probe must be an inline map`);
      const trimmed = entry.trim();
      if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) throw new Error(`invalid scenario file: ${name}: probe must be an inline map`);
      let map: Record<string, YamlNode>;
      try {
        map = yamlParseFlowMap(trimmed);
      } catch {
        throw new Error(`invalid scenario file: ${name}: probe map malformed`);
      }
      for (const key of Object.keys(map)) {
        if (!['id', 'argv', 'timeout'].includes(key)) fileWarnings.push(`${name}: unknown probe field ignored: ${key}`);
      }
      const id = map['id'];
      if (typeof id !== 'string' || !SCENARIO_NAME_PATTERN.test(id)) throw new Error(`invalid scenario file: ${name}: probe id must be text`);
      const argvRaw = map['argv'];
      if (!Array.isArray(argvRaw) || argvRaw.length === 0) throw new Error(`invalid scenario file: ${name}: probe argv must be a list (id: ${id})`);
      if (argvRaw.length > PROBE_MAX_PARTS) throw new Error(`invalid scenario file: ${name}: probe argv holds at most ${PROBE_MAX_PARTS} parts`);
      for (const part of argvRaw) {
        if (typeof part !== 'string') throw new Error(`invalid scenario file: ${name}: probe argv parts must be text`);
        if (Buffer.byteLength(part, 'utf8') > PROBE_MAX_PART_BYTES) throw new Error(`invalid scenario file: ${name}: probe argv part too long`);
      }
      if (SHELL_ARGV0.has((argvRaw as string[])[0])) throw new Error(`invalid scenario file: ${name}: probe argv must not start with a shell`);
      const timeoutRaw = map['timeout'];
      let timeout = PROBE_DEFAULT_TIMEOUT;
      if (timeoutRaw !== undefined) {
        if (typeof timeoutRaw !== 'string' || !PROBE_TIMEOUTS.has(timeoutRaw)) throw new Error(`invalid scenario file: ${name}: probe timeout must be 5s|10s|30s`);
        timeout = timeoutRaw;
      }
      probes.push({ id, timeout });
    }
    scenarios.push({ name, services, boundaries, probes, checkpoints });
  }
  return { scenarios, warnings: fileWarnings };
}

/** Boundary rollup (pure): worst cell verdict per column, with
 * non-covering cells sorting below real verdicts. */
function rollupBoundaryStatus(cells: ScenarioVerdict[]): BoundaryChipStatus {
  const rank: Record<ScenarioVerdict, number> = { stale: 4, unverified: 3, skipped: 2, uncovered: 1, pass: 0 };
  let status: BoundaryChipStatus = 'pass';
  let covered = false;
  for (const verdict of cells) {
    if (verdict === 'uncovered') continue;
    covered = true;
    if (rank[verdict] > rank[status]) status = verdict;
  }
  return covered ? status : 'uncovered';
}

/** Readiness-strip sections (M8, pure): derived from already-built
 * aggregates - no new reads. Boundary chips roll up matrix verdicts;
 * last-run binds the selected checkpoint run (null without checkpoints);
 * the gate mirrors preflight pass + missing (already masked upstream). */
function buildReadinessStrip(
  checkpoints: CoordinatorCheckpoints | null,
  scenarios: CoordinatorScenarios,
  missing: string[],
): { boundaryList: CoordinatorBoundaryChip[]; lastRun: CoordinatorLastRun | null; readinessGate: CoordinatorReadinessGate } {
  const boundaryList = scenarios.columns.map(column => ({
    boundary: column,
    status: rollupBoundaryStatus(scenarios.rows.map(row => row.cells[column] ?? 'skipped')),
  }));
  const lastRun = checkpoints === null ? null : {
    id: checkpoints.run,
    at: checkpoints.lastVerified?.at ?? null,
    pass: checkpoints.summary.stale === 0 && checkpoints.summary.notObserved === 0,
  };
  return { boundaryList, lastRun, readinessGate: { pass: missing.length === 0, missing: [...missing] } };
}

function buildScenarios(
  record: EnvironmentRecord,
  checkpoint: CheckpointSource | null,
  parsed: ParsedScenario[],
  fileWarnings: string[],
  overlay?: { applied: boolean; file: string | null; sources: OverlayBoundarySource[]; error: string | null },
): CoordinatorScenarios {
  const knownServices = new Set(record.services.map(service => service.name ?? service.id));
  // Columns: known order first, unknown ones alphabetical (≤16).
  const seenColumns = new Set<string>();
  for (const scenario of parsed) {
    for (const boundary of scenario.boundaries) seenColumns.add(boundary);
  }
  const columns = [
    ...SCENARIO_BOUNDARIES.filter(boundary => seenColumns.has(boundary)),
    ...[...seenColumns].filter(boundary => !isKnownScenarioBoundary(boundary)).sort(),
  ];
  const warnings = [...fileWarnings];
  if (columns.length > SCENARIO_MAX_COLUMNS) {
    warnings.push(`column truncated (${SCENARIO_MAX_COLUMNS} limit) — matrix limited to the first columns`);
  }
  const shownRaw = columns.slice(0, SCENARIO_MAX_COLUMNS);
  // Wire keys are masked (raw boundary names are user data);
  // known names pass the mask as-is, matching is done against the raw value.
  const shownColumns = shownRaw.map(column => maskSecrets(column));
  // Verdict basis: envelope freshness in the selected run (the last record wins).
  // Without a checkpoint view the covered cell drops to "skipped" (no record).
  const stageStatus = new Map<string, CheckpointStageStatus>();
  if (checkpoint) {
    const fresh = applyCheckpointFreshness(checkpoint.envelopes);
    for (const envelope of fresh) stageStatus.set(envelope.stage, envelope.status);
  }
  const rows: ScenarioMatrixRow[] = parsed.map(scenario => {
    const unverifiedServices = scenario.services.filter(service => !knownServices.has(service));
    let verdict: ScenarioVerdict;
    if (scenario.checkpoints.length === 0 || !checkpoint) {
      verdict = 'skipped';
    } else if (scenario.checkpoints.every(stage => stageStatus.get(stage) === 'confirmed')) {
      verdict = 'pass';
    } else if (scenario.checkpoints.some(stage => stageStatus.get(stage) === 'stale')) {
      verdict = 'stale';
    } else {
      verdict = 'skipped';
    }
    const cells: Record<string, ScenarioVerdict> = {};
    for (let i = 0; i < shownRaw.length; i += 1) {
      const raw = shownRaw[i];
      const column = shownColumns[i];
      if (!scenario.boundaries.includes(raw)) cells[column] = 'uncovered';
      else if (!isKnownScenarioBoundary(raw)) cells[column] = 'unverified';
      else cells[column] = verdict;
    }
    return {
      name: maskSecrets(scenario.name),
      services: scenario.services.map(service => maskSecrets(service)),
      unverifiedServices: unverifiedServices.map(service => maskSecrets(service)),
      probes: scenario.probes.map(probe => ({ id: maskSecrets(probe.id), timeout: probe.timeout })),
      checkpoints: scenario.checkpoints.map(stage => maskSecrets(stage)),
      cells,
    };
  });
  return {
    file: SCENARIOS_FILE_NAME,
    columns: shownColumns,
    rows,
    warnings: warnings.map(warning => maskSecrets(warning)),
    error: null,
    ...(overlay !== undefined && (overlay.applied || overlay.error !== null)
      ? {
        overlayApplied: overlay.applied,
        overlayFile: overlay.file,
        boundarySources: overlay.sources,
        overlayError: overlay.error,
      }
      : {}),
  };
}

// --- Pure core (no I/O; tests inject hostile fixtures) ---------------------

function expectedDescriptor(service: EnvironmentRecord['services'][number]): string {
  const script = service.scriptName || '(no command)';
  const port = typeof service.port === 'number' ? `${service.port} port` : 'portless';
  return `${script} · ${port}`;
}

function buildCheckpoints(source: CheckpointSource | null): CoordinatorCheckpoints | null {
  if (!source || source.envelopes.length === 0) return null;
  const fresh = applyCheckpointFreshness(source.envelopes);
  const stages: CoordinatorCheckpointStage[] = fresh.map(envelope => ({
    stage: maskSecrets(envelope.stage),
    status: envelope.status,
    staleReason: envelope.staleReason,
    at: envelope.at,
    sideEffect: envelope.sideEffect,
    sideEffectAttempted: envelope.sideEffectCounts?.attempted ?? null,
    sideEffectConfirmed: envelope.sideEffectCounts?.confirmed ?? null,
    scenario: envelope.scenario,
    attempt: envelope.attempt,
    stepSignature: envelope.stepSignature,
  }));
  let confirmed = 0;
  let stale = 0;
  let notObserved = 0;
  for (const envelope of fresh) {
    if (envelope.status === 'confirmed') confirmed += 1;
    else if (envelope.status === 'stale') stale += 1;
    else notObserved += 1;
  }
  let lastVerified: CoordinatorCheckpoints['lastVerified'] = null;
  for (const envelope of fresh) {
    if (envelope.status === 'confirmed') lastVerified = { stage: maskSecrets(envelope.stage), at: envelope.at };
  }
  // first_gap = the FIRST non-confirmed after the last confirmed (the first line
  // if there is no confirmed) — cli/summarizeFresh mirror.
  let lastIndex = -1;
  for (let i = 0; i < fresh.length; i += 1) {
    if (fresh[i].status === 'confirmed') lastIndex = i;
  }
  const firstGapRaw = fresh.find((envelope, index) => index > lastIndex && envelope.status !== 'confirmed') ?? null;
  const firstGap = firstGapRaw
    ? { stage: maskSecrets(firstGapRaw.stage), status: firstGapRaw.status, staleReason: firstGapRaw.staleReason, at: firstGapRaw.at }
    : null;
  const actionSource = firstGapRaw ?? fresh[fresh.length - 1];
  // M-A (#2): attempted-unconfirmed rule (CLI `needsRetryHint` mirror:
  // a hint when a stage has attempted with no following confirmed).
  let retryHint = false;
  for (let i = 0; i < fresh.length && !retryHint; i += 1) {
    if (fresh[i].sideEffect !== 'attempted') continue;
    retryHint = !fresh.slice(i + 1).some(later => later.stage === fresh[i].stage && later.sideEffect === 'confirmed');
  }
  return {
    run: source.run,
    runs: source.runs,
    stages,
    summary: { confirmed, stale, notObserved },
    lastVerified,
    firstGap,
    safeNextAction: actionSource?.safeNextAction ?? null,
    retryHint,
  };
}

function buildExplanation(
  record: EnvironmentRecord,
  status: EnvironmentStatus,
  checkpoint: CheckpointSource | null,
  supervisor: SupervisorProvenanceRecord[] | null,
): CoordinatorExplanation | null {
  const records = supervisor ?? [];
  // Envelope revs: only the first-seen `at` is tracked (strip age). There is no
  // service attribution in the envelope — stages/service set is not carried (prune: D3
  // does not want it, no counterpart on the wire).
  const envelopeRevs = new Map<string, string>();
  if (checkpoint) {
    for (const envelope of checkpoint.envelopes) {
      if (envelope.checkoutRev === undefined) continue;
      const seen = envelopeRevs.get(envelope.checkoutRev);
      if (seen === undefined || Date.parse(envelope.at) < Date.parse(seen)) {
        envelopeRevs.set(envelope.checkoutRev, envelope.at);
      }
    }
  }
  if (records.length === 0 && envelopeRevs.size === 0) return null;

  const byId = new Map(status.services.map(entry => [entry.serviceId, entry]));
  const byName = new Map(status.services.map(entry => [entry.name, entry]));
  const storeByName = new Map(record.services.map(service => [service.name ?? service.id, service]));
  const names: string[] = [];
  for (const service of record.services) {
    const key = service.name ?? service.id;
    if (!names.includes(key)) names.push(key);
  }
  for (const rec of records) {
    if (!names.includes(rec.name)) names.push(rec.name);
  }

  const recordedRevs = new Set(records.flatMap(rec => (rec.rev !== undefined ? [rec.rev] : [])));
  const entries: CoordinatorExplanationEntry[] = names.map(name => {
    const storeService = storeByName.get(name);
    const rec = records.find(candidate => candidate.name === name);
    const live = (storeService ? byId.get(storeService.id) : undefined) ?? byName.get(name);
    const expected = storeService
      ? {
        cmd: maskSecrets(storeService.scriptName || '(no command)'),
        dir: basename(resolve(storeService.repositoryPath)),
        port: typeof storeService.port === 'number' ? storeService.port : null,
      }
      : null;
    const running = live ? { status: live.status, detail: maskSecrets(live.detail) } : null;
    const diffs: string[] = [];
    if (rec === undefined) {
      // No record — no diff can be produced, the note covers it.
    } else {
      if (expected === null) {
        diffs.push(maskSecrets('not in definition — no counterpart in the recorded topology'));
      } else if (typeof rec.port === 'number' && typeof expected.port === 'number' && rec.port !== expected.port) {
        diffs.push(maskSecrets(`port changed (expected: ${expected.port}, running: ${rec.port})`));
      }
      if (rec.exitCode !== undefined) diffs.push(maskSecrets(`process exited (exit code ${rec.exitCode})`));
      if (rec.dirty === true) diffs.push(maskSecrets('started with a dirty checkout'));
    }
    let note: string;
    if (rec === undefined) note = 'no record — no provenance record found for this service';
    else if (running === null) note = 'unmeasured — no live status record';
    else if (rec.exitCode !== undefined) note = `not running — exit code ${rec.exitCode}; check the logs with your assistant`;
    else if (running.status === 'starting') note = 'starting — refresh with Refresh';
    else if (running.status === 'stale') note = 'stale — refresh with Refresh';
    else if (running.status === 'ready') note = 'running, no known issues';
    else note = `live status ${running.status} — see the diff lines`;
    const rev = rec?.rev;
    // M-C: the recorded build map is carried reduced (basename + short-8).
    const reduced = reduceArtifactMap(rec?.artifactDigests);
    return {
      service: maskSecrets(name),
      expected,
      running,
      revShort: rev !== undefined ? shortRev(rev) : null,
      // The full rev is only the copy button's clipboard payload — it is not
      // written to the DOM (not even a hover title; scan-test §3).
      revFull: rev ?? null,
      revAt: rec?.recordedAt ?? null,
      revDirty: rec?.dirty === true,
      revRecorded: rev !== undefined,
      diffs,
      note: maskSecrets(note),
      artifacts: reduced.shown,
      artifactRest: reduced.rest,
    };
  });

  // Rev strip: supervisor recorded revs (recordedAt-aged) + unrecorded revs
  // from envelopes (first-seen `at`-aged, dim). The newest is selected.
  const revisions: CoordinatorRevision[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (rec.rev === undefined || seen.has(rec.rev)) continue;
    seen.add(rec.rev);
    revisions.push({
      short: shortRev(rec.rev),
      full: rec.rev,
      at: rec.recordedAt ?? null,
      current: false,
      recorded: true,
    });
  }
  for (const [rev, at] of envelopeRevs) {
    if (seen.has(rev)) {
      const existing = revisions.find(candidate => candidate.full === rev);
      if (existing && existing.at !== null && Date.parse(at) < Date.parse(existing.at)) existing.at = at;
      continue;
    }
    seen.add(rev);
    revisions.push({
      short: shortRev(rev),
      full: rev,
      at,
      current: false,
      recorded: recordedRevs.has(rev),
    });
  }
  revisions.sort((a, b) => {
    const aMs = a.at === null ? Number.NEGATIVE_INFINITY : Date.parse(a.at);
    const bMs = b.at === null ? Number.NEGATIVE_INFINITY : Date.parse(b.at);
    return aMs - bMs;
  });
  if (revisions.length > 0) revisions[revisions.length - 1].current = true;
  return { entries, revisions };
}

function buildScenariosSection(
  record: EnvironmentRecord,
  checkpoint: CheckpointSource | null,
  read: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[]; overlayApplied?: boolean; overlayFile?: string | null; boundarySources?: OverlayBoundarySource[]; overlayError?: string | null } | null,
): CoordinatorScenarios | null {
  if (!read || (read.scenarios === null && read.error === null)) return null;
  if (read.scenarios === null) {
    return {
      file: SCENARIOS_FILE_NAME,
      columns: [],
      rows: [],
      warnings: [],
      error: read.error ?? 'no record',
      ...(read.overlayApplied === true || read.overlayError != null
        ? { overlayApplied: read.overlayApplied === true, overlayFile: read.overlayFile ?? null, boundarySources: read.boundarySources ?? [], overlayError: read.overlayError ?? null }
        : {}),
    };
  }
  return buildScenarios(record, checkpoint, read.scenarios, read.warnings, {
    applied: read.overlayApplied === true,
    file: read.overlayFile ?? null,
    sources: read.boundarySources ?? [],
    error: read.overlayError ?? null,
  });
}

export function buildCoordinatorSnapshot(input: {
  record: EnvironmentRecord;
  status: EnvironmentStatus;
  /** Port → busy? (unmeasured ports are ignored in the map + warning). */
  portOccupied: Map<number, boolean>;
  /** Busy port → suggested free port (null if none). */
  freeSuggestion: Map<number, number | null>;
  /** §0.3 file-read basket (already localized text, still goes through the mask). */
  checkpointWarnings: string[];
  /** Latest-run checkpoint source (null → section `null` + "no checkpoint"). */
  checkpoint?: CheckpointSource | null;
  /** Supervisor spawn records (matched by name; null/empty → no record). */
  supervisor?: SupervisorProvenanceRecord[] | null;
  /** Scenario read result (null → file missing; error → corrupt-file box). */
  scenarioRead?: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[]; overlayApplied?: boolean; overlayFile?: string | null; boundarySources?: OverlayBoundarySource[]; overlayError?: string | null } | null;
  /** Discovered run names — they reach the wire even while checkpoints is null. */
  runs?: string[];
  /** serviceId → {rootBase, revShort} identity (additive-optional).
   * When absent, readiness entries carry no `worktree` field at all
   * (single-root snapshots stay byte-identical). */
  worktreeByService?: Map<string, { rootBase: string; revShort: string | null }>;
  /** Ownership ledger input (additive-optional): `{rows, warnings}`.
   * When absent, the snapshot carries no `worktrees` field and no matrix
   * warning is produced (single-root snapshots stay byte-identical). */
  worktreeLedger?: { rows: CoordinatorWorktreeEntry[]; warnings: string[] };
  unprobedPorts?: number[];
  producedAt?: string;
  snapshotId?: string;
}): CoordinatorSnapshot {
  const warnings = input.checkpointWarnings.map(warning => maskSecrets(warning));
  for (const port of input.unprobedPorts ?? []) {
    warnings.push(`port probe unmeasured: ${port} — preflight counts this port as free`);
  }
  // Ledger warnings arrive masked from their builders; the push site does
  // not re-mask (single mask point per string, like readiness above).
  for (const warning of input.worktreeLedger?.warnings ?? []) warnings.push(warning);
  const byId = new Map(input.status.services.map(entry => [entry.serviceId, entry]));
  const topologyIds = new Set(input.record.services.map(service => service.id));

  // Reconcile: when the environment is down, stopped services are the expected state;
  // in a partial/up environment every down/failed/stale/skipped service is a drift line.
  const drifts: CoordinatorDrift[] = [];
  const stopped = input.record.state === 'down';
  for (const service of input.record.services) {
    const entry = byId.get(service.id);
    if (!entry) {
      drifts.push({
        service: maskSecrets(service.name ?? service.id),
        field: 'status',
        expected: maskSecrets(expectedDescriptor(service)),
        actual: maskSecrets('unmeasured'),
      });
      continue;
    }
    if (stopped) continue;
    if (entry.status === 'ready' || entry.status === 'starting') continue;
    drifts.push({
      service: maskSecrets(entry.name),
      field: 'status',
      expected: maskSecrets(`running (${expectedDescriptor(service)})`),
      actual: maskSecrets(`${entry.status}: ${entry.detail}`),
    });
  }
  for (const entry of input.status.services) {
    if (entry.status !== 'stale' || topologyIds.has(entry.serviceId)) continue;
    drifts.push({
      service: maskSecrets(entry.name),
      field: 'topoloji',
      expected: maskSecrets('recorded topology'),
      actual: maskSecrets('unrecorded process tracked — no counterpart in the topology'),
    });
  }

  const readiness: CoordinatorReadinessEntry[] = input.status.services
    .filter(entry => topologyIds.has(entry.serviceId))
    .map(entry => {
      const service = input.record.services.find(candidate => candidate.id === entry.serviceId);
      const worktree = input.worktreeByService?.get(entry.serviceId);
      return {
        serviceId: maskSecrets(entry.serviceId),
        name: maskSecrets(entry.name),
        dir: service ? basename(resolve(service.repositoryPath)) : null,
        status: entry.status,
        detail: maskSecrets(entry.detail),
        lastPoll: entry.owned?.lastPoll ?? null,
        ...(worktree === undefined ? {} : { worktree: { rootBase: maskSecrets(worktree.rootBase), revShort: worktree.revShort } }),
      };
    });

  const gates: CoordinatorPreflightGate[] = [];
  const missing: string[] = [];
  for (const service of input.record.services) {
    const label = maskSecrets(service.name ?? service.id);
    if (typeof service.port !== 'number') {
      gates.push({ service: label, port: null, free: true, note: 'no port — process tracking' });
      continue;
    }
    if (!input.portOccupied.has(service.port)) {
      gates.push({ service: label, port: service.port, free: true, note: 'unmeasured — counted as free' });
      continue;
    }
    if (!input.portOccupied.get(service.port)) {
      gates.push({ service: label, port: service.port, free: true, note: `${service.port} port is free` });
      continue;
    }
    const suggestion = input.freeSuggestion.get(service.port) ?? null;
    const line = suggestion === null
      ? `${label}: ${service.port} port is busy`
      : `${label}: ${service.port} port is busy (${suggestion} looks free — change the topology, no automatic rebinding)`;
    gates.push({ service: label, port: service.port, free: false, note: maskSecrets(`${service.port} port is busy`) });
    missing.push(maskSecrets(line));
  }

  const scenarios = buildScenariosSection(input.record, input.checkpoint ?? null, input.scenarioRead ?? null);
  const scopedCheckpoints = buildCheckpoints(input.checkpoint ?? null);
  return {
    reconcile: { inSync: drifts.length === 0, drifts },
    readiness,
    explanation: buildExplanation(input.record, input.status, input.checkpoint ?? null, input.supervisor ?? null),
    preflight: { pass: missing.length === 0, gates, missing },
    checkpoints: scopedCheckpoints,
    scenarios,
    runs: input.runs ?? [],
    ...(scenarios === null ? {} : buildReadinessStrip(scopedCheckpoints, scenarios, missing)),
    ...(input.worktreeLedger === undefined ? {} : { worktrees: input.worktreeLedger.rows }),
    warnings,
    meta: {
      producedAt: input.producedAt ?? new Date().toISOString(),
      snapshotId: input.snapshotId ?? randomBytes(4).toString('hex'),
      environment: input.record.name,
    },
  };
}

// --- Runner-file read boundary (§0.3) ---------------------------------------

export const CHECKPOINT_MAX_BYTES = 256 * 1024;
export const CHECKPOINT_MAX_LINES = 500;
const CHECKPOINT_MAX_RUNS = 50;
const runFilePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jsonl$/;

/**
 * `.ow/checkpoints` bounded read: the selected run's envelopes (normalized)
 * + discovered run names + warnings[] basket (truncation/corrupt/
 * symlink/unreadable/empty). The `runs` list is returned even when source is null —
 * the selector in the null branch is fed from here. Selection: the `?run=` name
 * (off-allowlist/missing → latest + warning), otherwise the newest NON-EMPTY file;
 * D1 warning texts are preserved as-is. Escaping the root, symlinks and an
 * oversized file are skipped fail-closed.
 */
export async function readCheckpointSource(roots: string[], requestedRun?: string): Promise<{
  source: CheckpointSource | null;
  /** Discovered run names — may be non-empty even while source is null (selector). */
  runs: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  type Latest = { path: string; run: string; mtimeMs: number };
  const perRoot: Latest[] = [];
  const runFiles = new Map<string, { path: string; mtimeMs: number }>();
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const dir = join(canonicalRoot, '.ow', 'checkpoints');
    if (resolve(dir) !== dir || !dir.startsWith(canonicalRoot + sep)) continue;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    type Candidate = { name: string; mtimeMs: number };
    const candidates: Candidate[] = [];
    for (const name of names) {
      if (!runFilePattern.test(name)) continue;
      const path = join(dir, name);
      if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
      let entry;
      try {
        entry = await lstat(path);
      } catch {
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) warnings.push(`checkpoint skipped (symlink not followed): ${name}`);
        continue;
      }
      const run = name.replace(/\.jsonl$/, '');
      candidates.push({ name, mtimeMs: entry.mtimeMs });
      const known = runFiles.get(run);
      if (!known || entry.mtimeMs > known.mtimeMs) runFiles.set(run, { path, mtimeMs: entry.mtimeMs });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    perRoot.push({ path: join(dir, latest.name), run: latest.name.replace(/\.jsonl$/, ''), mtimeMs: latest.mtimeMs });
  }
  const runs = [...runFiles.entries()]
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .map(([run]) => run);
  if (runs.length > CHECKPOINT_MAX_RUNS) {
    warnings.push(`run list truncated (${CHECKPOINT_MAX_RUNS} names) — the newest are listed`);
  }
  const trimmedRuns = runs.slice(0, CHECKPOINT_MAX_RUNS);
  if (perRoot.length === 0) return { source: null, runs: trimmedRuns, warnings };
  // The warning basket comes from each root's latest (D1 discipline).
  const scanned = new Map<string, ParsedCheckpointEnvelope[]>();
  for (const candidate of perRoot) {
    if (!scanned.has(candidate.path)) {
      scanned.set(candidate.path, await scanCheckpointFile(candidate.path, candidate.run, warnings));
    }
  }
  const envelopesOf = async (path: string, run: string): Promise<ParsedCheckpointEnvelope[]> => {
    const known = scanned.get(path);
    if (known !== undefined) return known;
    const parsed = await scanCheckpointFile(path, run, warnings);
    scanned.set(path, parsed);
    return parsed;
  };
  // Explicit request: an off-allowlist name falls back to latest + warning; the found file
  // is what it is (empty/corrupt → section null + scan warning).
  const requested = (requestedRun ?? '').trim();
  if (requested) {
    if (!RUN_NAME_PATTERN.test(requested)) {
      warnings.push(maskSecrets(`requested run invalid: ${requested} — showing the latest`));
    } else {
      const hit = runFiles.get(requested);
      if (!hit) {
        warnings.push(maskSecrets(`requested run missing: ${requested} — showing the latest`));
      } else {
        const envelopes = await envelopesOf(hit.path, requested);
        if (envelopes.length === 0) return { source: null, runs: trimmedRuns, warnings };
        return { source: { run: requested, envelopes, runs: trimmedRuns }, runs: trimmedRuns, warnings };
      }
    }
  }
  // Latest: the newest NON-EMPTY file (same as D1 single-file behavior). A file that is
  // scanned but stays empty is not passed silently — a basket line drops
  // (an already-warned run name is not warned again).
  const ordered = [...perRoot].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of ordered) {
    const before = warnings.length;
    const envelopes = await envelopesOf(candidate.path, candidate.run);
    if (envelopes.length > 0) return { source: { run: candidate.run, envelopes, runs: trimmedRuns }, runs: trimmedRuns, warnings };
    if (!warnings.slice(before).some(warning => warning.includes(candidate.run))) {
      warnings.push(maskSecrets(`checkpoint empty: ${candidate.run} — section unaffected`));
    }
  }
  return { source: null, runs: trimmedRuns, warnings };
}

/**
 * Bounded scan of a single checkpoint file: 256KB chunk + 500 line cap +
 * shape-strict normalize. Warnings are processed into the basket on every call.
 */
async function scanCheckpointFile(path: string, run: string, warnings: string[]): Promise<ParsedCheckpointEnvelope[]> {
  const envelopes: ParsedCheckpointEnvelope[] = [];
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    warnings.push(`checkpoint unreadable: ${run} — section unaffected`);
    return envelopes;
  }
  try {
    const chunk = Buffer.alloc(CHECKPOINT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
    const truncated = bytesRead > CHECKPOINT_MAX_BYTES;
    const text = chunk.subarray(0, Math.min(bytesRead, CHECKPOINT_MAX_BYTES)).toString('utf8');
    const lines = text.split('\n');
    let processed = 0;
    let corrupt = 0;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      if (processed >= CHECKPOINT_MAX_LINES) break;
      processed += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      const normalized = normalizeCheckpointEnvelope(raw);
      if (!normalized.ok) {
        corrupt += 1;
        continue;
      }
      envelopes.push(normalized.envelope);
    }
    // Non-blank lines beyond the cap window count as overCap.
    const overCap = truncated || processed >= CHECKPOINT_MAX_LINES;
    if (overCap) warnings.push(`checkpoint truncated: ${run} (256KB/500 record limit)`);
    if (corrupt > 0) warnings.push(`checkpoint corrupt line skipped: ${run} (${corrupt})`);
  } catch {
    warnings.push(`checkpoint unreadable: ${run} — section unaffected`);
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
  return envelopes;
}

/** D1 compatibility shell: only the warnings[] basket. */
export async function readCheckpointWarnings(roots: string[]): Promise<string[]> {
  return (await readCheckpointSource(roots)).warnings;
}

export const SUPERVISOR_MAX_BYTES = 256 * 1024;
const SUPERVISOR_MAX_SERVICES = 200;

/**
 * `.ow/supervisor.json` bounded read-only provenance: spawn records
 * (name, port, checkout rev + recordedAt, exitCode). Otherwise a silent null record
 * (UI "no provenance record"); symlink/cap/corrupt fail-closed + a warnings[]
 * line. No live exec. `cwdAbs`/`lastReadiness` are not read (unrendered
 * fields — see the NOTE above).
 */
export async function readSupervisorRecords(roots: string[]): Promise<{ records: SupervisorProvenanceRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  const merged = new Map<string, SupervisorProvenanceRecord>();
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const path = join(canonicalRoot, '.ow', 'supervisor.json');
    if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      warnings.push('provenance skipped (symlink not followed): supervisor.json');
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.size > SUPERVISOR_MAX_BYTES) {
      warnings.push(`provenance truncated: ${basename(canonicalRoot)} (256KB limit) — section unaffected`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      warnings.push(`provenance unreadable: ${basename(canonicalRoot)} — section unaffected`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push(`provenance unreadable: ${basename(canonicalRoot)} — section unaffected`);
      continue;
    }
    const dict = parsed as Record<string, unknown>;
    if (dict['version'] !== 1 || !Array.isArray(dict['services'])) {
      warnings.push(`provenance version mismatch: ${basename(canonicalRoot)} — section unaffected`);
      continue;
    }
    const services = (dict['services'] as unknown[]).slice(0, SUPERVISOR_MAX_SERVICES);
    let corrupt = 0;
    for (const item of services) {
      const record = normalizeSupervisorService(item);
      if (!record) {
        corrupt += 1;
        continue;
      }
      if (!merged.has(record.name)) merged.set(record.name, { ...record, rootBase: basename(canonicalRoot) });
    }
    if (corrupt > 0) warnings.push(`provenance corrupt record skipped: ${basename(canonicalRoot)} (${corrupt})`);
  }
  return { records: [...merged.values()], warnings };
}

// --- Worktree ownership ledger (read-only aggregate, no new exec) ----
// Ledger answers who-is-live-where from already-read state: per-root
// supervisor file + lock classification + bounded HEAD read. Pure file
// reads (lstat/readFile); no spawn, no `git` exec, no farm scan, no writes.
// Same-name services are listed per root (no first-wins collapse at this
// layer); the merged `records` order above is untouched.

export type WorktreeLockState = 'live' | 'stale' | 'absent' | 'corrupt' | 'unknown';
export type WorktreeFileState = 'ok' | 'missing' | 'corrupt' | 'bad-version';

export interface CoordinatorWorktreeEntry {
  rootBase: string;
  revShort: string | null;
  branch: string | null;
  lock: WorktreeLockState;
  /** Spawn-recorded service names not known-dead (no `exitCode`); supervisor
   * liveness itself is the separate `lock` field. */
  liveServices: string[];
  state: WorktreeFileState;
}

export interface WorktreeLedgerPerRoot {
  rootBase: string;
  records: SupervisorProvenanceRecord[];
}

const LEDGER_HEAD_MAX_BYTES = 4096;
const LEDGER_HEX_REV = /^[0-9a-fA-F]{4,64}$/;

/** Bounded HEAD read per root (`.git/HEAD` file or linked-worktree gitdir
 * `HEAD`; ref → branch, detached hex → short-7; anything
 * unreadable/unshaped → nulls, never fail, never `git` exec). */
async function readLedgerHead(canonicalRoot: string): Promise<{ revShort: string | null; branch: string | null }> {
  const capped = async (path: string): Promise<string | null> => {
    try {
      return (await readFile(path, 'utf8')).slice(0, LEDGER_HEAD_MAX_BYTES);
    } catch {
      return null;
    }
  };
  let head = await capped(join(canonicalRoot, '.git', 'HEAD'));
  if (head === null) {
    const pointer = await capped(join(canonicalRoot, '.git'));
    if (pointer !== null) {
      const first = pointer.split('\n', 1)[0].trim();
      if (first.startsWith('gitdir: ')) head = await capped(join(resolve(canonicalRoot, first.slice('gitdir: '.length).trim()), 'HEAD'));
    }
  }
  if (head === null) return { revShort: null, branch: null };
  const line = head.split('\n', 1)[0].trim();
  if (line.startsWith('ref: ')) {
    const ref = line.slice('ref: '.length).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return branch.length > 0 ? { revShort: null, branch } : { revShort: null, branch: null };
  }
  if (LEDGER_HEX_REV.test(line)) return { revShort: line.slice(0, 7), branch: null };
  return { revShort: null, branch: null };
}

/** Supervisor-file classification (CLI `classifySupervisorFile` mirror:
 * missing/ok/corrupt/bad-version) with symlink-reject (fail-closed
 * `corrupt`; the `provenance skipped` warning stays solely with
 * `readSupervisorRecords` — this reader emits no duplicate file warnings). */
async function classifyLedgerSupervisorFile(canonicalRoot: string): Promise<WorktreeFileState> {
  const path = join(canonicalRoot, '.ow', 'supervisor.json');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return 'missing';
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return 'missing';
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return 'corrupt';
  if (entry.size > SUPERVISOR_MAX_BYTES) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return 'corrupt';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'corrupt';
  const dict = parsed as Record<string, unknown>;
  if (typeof dict['version'] !== 'number') return 'corrupt';
  if (dict['version'] !== 1) return 'bad-version';
  if (!Array.isArray(dict['services'])) return 'corrupt';
  return 'ok';
}

/** Bounded per-root record read (same 256KB/200-service caps as
 * `readSupervisorRecords`; invalid entries drop silently here — the merged
 * reader already warns for the file, so no duplicate warning is emitted). */
async function readLedgerRootRecords(canonicalRoot: string): Promise<SupervisorProvenanceRecord[]> {
  const path = join(canonicalRoot, '.ow', 'supervisor.json');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return [];
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return [];
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > SUPERVISOR_MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const dict = parsed as Record<string, unknown>;
  if (dict['version'] !== 1 || !Array.isArray(dict['services'])) return [];
  const out: SupervisorProvenanceRecord[] = [];
  for (const item of (dict['services'] as unknown[]).slice(0, SUPERVISOR_MAX_SERVICES)) {
    const record = normalizeSupervisorService(item);
    if (record) out.push(record);
  }
  return out;
}

/** Lock classification without exec (CLI `classifyLock` cannot run here —
 * it spawns `ps` via Bun): shape check identical, liveness via signal-0
 * existence probe. Existence-only (no `lstart` PID-reuse guard — residual
 * reuse risk documented; advisory ledger only, never a gate). `EPERM`
 * (exists, unverifiable) → `unknown`; dead/invalid pid → `stale`. */
async function classifyLedgerLock(canonicalRoot: string): Promise<WorktreeLockState> {
  const path = join(canonicalRoot, '.ow', 'supervisor.lock');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return 'absent';
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return 'absent';
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return 'corrupt';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'corrupt';
  const dict = parsed as Record<string, unknown>;
  if (typeof dict['pid'] !== 'number' || !Number.isInteger(dict['pid']) || (dict['pid'] as number) <= 0 || typeof dict['lstart'] !== 'string') {
    return 'corrupt';
  }
  try {
    process.kill(dict['pid'] as number, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'unknown' : 'stale';
  }
  return 'live';
}

/** Per-root ledger rows + warnings basket. One row per registered root
 * (cap reuses `maxProjectRoots`, overflow truncates with a warnings[] line).
 * File-condition warnings stay with `readSupervisorRecords`; only ledger-own
 * lines (lock-symlink skip, truncation) are emitted here. */
export async function readWorktreeLedger(roots: string[]): Promise<{
  rows: CoordinatorWorktreeEntry[];
  warnings: string[];
  perRoot: WorktreeLedgerPerRoot[];
}> {
  const warnings: string[] = [];
  const capped = roots.slice(0, maxProjectRoots);
  if (roots.length > capped.length) {
    warnings.push(maskSecrets(`worktree list truncated (${maxProjectRoots} root limit) — the first ${maxProjectRoots} roots are listed`));
  }
  const rows: CoordinatorWorktreeEntry[] = [];
  const perRoot: WorktreeLedgerPerRoot[] = [];
  for (const root of capped) {
    const canonicalRoot = resolve(root);
    const rootBase = basename(canonicalRoot);
    const state = await classifyLedgerSupervisorFile(canonicalRoot);
    const records = state === 'ok' ? await readLedgerRootRecords(canonicalRoot) : [];
    const lock = await classifyLedgerLock(canonicalRoot);
    try {
      const lockEntry = await lstat(join(canonicalRoot, '.ow', 'supervisor.lock'));
      if (lockEntry.isSymbolicLink()) warnings.push(maskSecrets(`lock skipped (symlink not followed): ${rootBase}`));
    } catch {
      // Absent lock needs no warning (honest `missing` in the row).
    }
    const head = await readLedgerHead(canonicalRoot);
    rows.push({
      rootBase: maskSecrets(rootBase),
      revShort: head.revShort,
      branch: head.branch === null ? null : maskSecrets(head.branch),
      lock,
      liveServices: records.filter(record => record.exitCode === undefined).map(record => maskSecrets(record.name)),
      state,
    });
    perRoot.push({ rootBase, records });
  }
  return { rows, warnings, perRoot };
}

const WORKTREE_ADVISORY_MAX_LINES = 10;

/** Warnings-only collision guardrails (pure, advisory text, never a gate):
 * cross-root port sharing (port source = `SupervisorProvenanceRecord.port`
 * only — no `ow.yaml` reads, no farm scan) + same-service double-ownership
 * (recorded without `exitCode` under ≥2 roots). Every line carries
 * `worktree:<base>` scope tags and the non-gating wording; truncation at 10
 * lines + `…[truncated: N warnings]`. Callers emit nothing when ≤1 root. */
export function buildWorktreeAdvisories(perRoot: WorktreeLedgerPerRoot[]): string[] {
  const lines: string[] = [];
  const scope = (bases: string[]): string => bases.map(base => `worktree:${base}`).join(' + ');
  const byPort = new Map<number, string[]>();
  for (const { rootBase, records } of perRoot) {
    for (const record of records) {
      if (typeof record.port !== 'number') continue;
      const bases = byPort.get(record.port) ?? [];
      if (!bases.includes(rootBase)) bases.push(rootBase);
      byPort.set(record.port, bases);
    }
  }
  for (const port of [...byPort.keys()].sort((a, b) => a - b)) {
    const bases = byPort.get(port) as string[];
    if (bases.length < 2) continue;
    lines.push(maskSecrets(`warning: port ${port} is busy — ${scope(bases)} (informational, no blocking)`));
  }
  const byService = new Map<string, string[]>();
  for (const { rootBase, records } of perRoot) {
    for (const record of records) {
      if (record.exitCode !== undefined) continue;
      const bases = byService.get(record.name) ?? [];
      if (!bases.includes(rootBase)) bases.push(rootBase);
      byService.set(record.name, bases);
    }
  }
  for (const name of [...byService.keys()].sort()) {
    const bases = byService.get(name) as string[];
    if (bases.length < 2) continue;
    lines.push(maskSecrets(`warning: ${name} is registered in more than one worktree — ${scope(bases)} (informational, no blocking)`));
  }
  if (lines.length <= WORKTREE_ADVISORY_MAX_LINES) return lines;
  const kept = lines.slice(0, WORKTREE_ADVISORY_MAX_LINES);
  kept.push(maskSecrets(`…[truncated: ${lines.length - WORKTREE_ADVISORY_MAX_LINES} warnings]`));
  return kept;
}

const ARTIFACT_BASE_PATTERN = /^[^/\\]+$/;
const ARTIFACT_DIGEST_PATTERN = /^[0-9a-fA-F]{7,128}$/;

/** M-C recorded-map entry selection (CLI `pickArtifactEntries` mirror:
 * shape-strict, a malformed entry drops; basename ≤512ch, no `..`/`.`). */
function pickArtifactEntries(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [base, digest] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof base !== 'string' || base.length === 0 || base.length > 512) continue;
    if (!ARTIFACT_BASE_PATTERN.test(base) || base === '.' || base === '..') continue;
    if (typeof digest !== 'string' || !ARTIFACT_DIGEST_PATTERN.test(digest)) continue;
    out[base] = digest;
  }
  return out;
}

/** M-C reduced view (CLI `reduceArtifactMap` mirror: masked
 * basename + short-8, first 32 in order + counter; a full path/full digest never reaches the wire). */
function reduceArtifactMap(map: Record<string, string> | undefined): { shown: { base: string; digest: string }[]; rest: number } {
  const bases = Object.keys(map ?? {}).sort();
  const shown = bases.slice(0, 32).map(base => ({ base: maskSecrets(base), digest: (map as Record<string, string>)[base].slice(0, 8) }));
  return { shown, rest: Math.max(0, bases.length - shown.length) };
}

/** Pure supervisor-record normalization (tests inject hostile revs through here). */
export function normalizeSupervisorService(raw: unknown): SupervisorProvenanceRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const dict = raw as Record<string, unknown>;
  if (typeof dict['name'] !== 'string' || (dict['name'] as string).trim().length === 0) return null;
  const record: SupervisorProvenanceRecord = { name: dict['name'] as string };
  if (typeof dict['port'] === 'number') record.port = dict['port'] as number;
  if (typeof dict['exitCode'] === 'number') record.exitCode = dict['exitCode'] as number;
  const provenance = dict['provenance'];
  if (provenance !== undefined) {
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return null;
    const prov = provenance as Record<string, unknown>;
    const checkout = prov['checkout'];
    if (checkout !== undefined) {
      if (typeof checkout !== 'object' || checkout === null || Array.isArray(checkout)) return null;
      const checkoutDict = checkout as Record<string, unknown>;
      const rev = revField(checkoutDict['rev']);
      if (rev !== undefined) record.rev = rev;
      else if (checkoutDict['rev'] !== undefined) return null;
      if (checkoutDict['dirty'] === true) record.dirty = true;
    }
    if (typeof prov['recordedAt'] === 'string' && Number.isFinite(Date.parse(prov['recordedAt'] as string))) {
      record.recordedAt = prov['recordedAt'] as string;
    }
  }
  // M-C: the build map is taken shape-strict (a malformed map drops, the record survives;
  // malformed entries drop, valid ones survive).
  if (dict['artifactDigests'] !== undefined) {
    if (typeof dict['artifactDigests'] === 'object' && dict['artifactDigests'] !== null && !Array.isArray(dict['artifactDigests'])) {
      const picked = pickArtifactEntries(dict['artifactDigests']);
      if (Object.keys(picked).length > 0) record.artifactDigests = picked;
    }
  }
  return record;
}

/**
 * M9 overlay second-read (server-side mirror of `cli/up-overlay.ts` —
 * CLI modules are bun-only, so this path mirrors instead of importing;
 * behavior parity is pinned by `test/coordinator.test.ts`). Convention
 * only: `<root>/.ow/boundaries.local.yaml` (no CLI-flag channel
 * server-side exists — flag-scoped runs render the base convention with
 * `overlayApplied: false`). Per-scenario boundaries-REPLACE, never
 * union. Invalid overlays never crash: the base matrix still renders
 * and the refusal surfaces as `overlayError` (error box). Reads nothing
 * outside the root, writes nothing.
 */
const OVERLAY_LOCAL_FILE = 'boundaries.local.yaml';
const OVERLAY_MAX_BYTES = 256 * 1024;
const OVERLAY_MAX_LINES = 500;
const OVERLAY_BLOCKED_REASON_MAX = 128;

interface RootOverlay {
  applied: boolean;
  replacements: Map<string, string[]>;
  warnings: string[];
  error: string | null;
}

const overlayDigestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function overlayBlockedReason(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed !== 'blocked' && !trimmed.startsWith('blocked:')) return null;
  const raw = trimmed === 'blocked' ? '' : trimmed.slice('blocked:'.length).trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

/** Path-safe overlay name echo: basename segment, 64ch cap, secret-masked.
 * Valid scenario names pass through unchanged (pattern forbids separators);
 * only malformed names sanitize, and those can never match base (dangling). */
function safeOverlayName(name: string): string {
  const base = name.split('/').flatMap(part => part.split('\\')).filter(part => part.length > 0).pop() ?? '(empty)';
  const capped = base.length > 64 ? `${base.slice(0, 64)}…` : base;
  return maskSecrets(capped);
}

async function readRootOverlay(
  canonicalRoot: string,
  baseText: string,
  baseNames: Set<string>,
): Promise<RootOverlay> {
  const idle: RootOverlay = { applied: false, replacements: new Map(), warnings: [], error: null };
  const path = join(canonicalRoot, '.ow', OVERLAY_LOCAL_FILE);
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return idle;
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return idle;
  }
  const refused = (reason: string): RootOverlay => ({
    applied: false,
    replacements: new Map(),
    warnings: [],
    error: `overlay-refused: ${OVERLAY_LOCAL_FILE} (${reason})`,
  });
  if (entry.isSymbolicLink()) return refused('symlink not followed');
  if (!entry.isFile()) return refused('not a file');
  if (entry.size > OVERLAY_MAX_BYTES) return refused('oversize');
  // Symlink-aware containment (cli/up-overlay.ts mirror): the realpath
  // must stay under the realpathed root — an intermediate symlink
  // pointing outside refuses even when lexical checks pass.
  try {
    const root = await realpath(canonicalRoot);
    const real = await realpath(path);
    if (real !== root && !real.startsWith(root + sep)) return refused('outside root');
  } catch {
    return idle;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  } catch {
    return refused('undecodable');
  }
  if (text.split('\n').length > OVERLAY_MAX_LINES + 1) return refused('oversize');
  let doc: Record<string, YamlNode>;
  try {
    doc = yamlParseSubset(text);
  } catch (err) {
    return refused(`invalid overlay file: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
  }
  const warnings: string[] = [];
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'scenarios' && key !== 'baseDigest') {
      warnings.push(`unknown overlay field ignored: ${maskSecrets(key)}`);
    }
  }
  if (doc['version'] !== undefined && doc['version'] !== '1') return refused('unsupported overlay version');
  const digestRaw = doc['baseDigest'];
  if (digestRaw !== undefined && (typeof digestRaw !== 'string' || digestRaw.length === 0 || digestRaw.length > 128)) {
    return refused('invalid baseDigest');
  }
  const raw = doc['scenarios'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refused('scenarios map required');
  const entries = Object.entries(raw as Record<string, YamlNode>);
  if (entries.length === 0) return refused('no scenarios');
  if (entries.length > 32) return refused('at most 32 scenarios');
  const replacements = new Map<string, string[]>();
  for (const [name, node] of entries) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return { applied: false, replacements: new Map(), warnings: [], error: `overlay-dangling: ${safeOverlayName(name)} (refused)` };
    }
    const fields = node as Record<string, YamlNode>;
    for (const key of Object.keys(fields)) {
      if (key !== 'boundaries') warnings.push(`${safeOverlayName(name)}: unknown overlay field ignored: ${maskSecrets(key)}`);
    }
    const listRaw = fields['boundaries'];
    let list: string[];
    // HIGH-1 fail-closed: an absent boundaries key refuses (silent emptying
    // is never intended); an explicit [] stays allowed as intentional empty.
    if (listRaw === undefined) return refused(`boundaries required in ${safeOverlayName(name)}`);
    else if (typeof listRaw === 'string') list = [listRaw];
    else if (Array.isArray(listRaw) && (listRaw as unknown[]).every(part => typeof part === 'string')) {
      list = [...(listRaw as string[])];
    } else {
      return refused(`invalid boundaries in ${safeOverlayName(name)}`);
    }
    for (const boundary of list) {
      if (maskSecrets(boundary) !== boundary) return refused('secret-shaped value');
      const reason = overlayBlockedReason(boundary);
      if (reason !== null && (reason.length === 0 || [...reason].length > OVERLAY_BLOCKED_REASON_MAX)) {
        return refused(`invalid blocked shape in ${safeOverlayName(name)}`);
      }
    }
    if (!baseNames.has(name)) {
      return { applied: false, replacements: new Map(), warnings: [], error: `overlay-dangling: ${safeOverlayName(name)} (refused)` };
    }
    // M1 dual-read: overlay values normalize like base (known→normalized,
    // unknown stays raw for the unverified verdict); legacy warns here.
    const seenOverlayLegacy = new Set<string>();
    const normalized = list.map(raw => {
      const norm = normalizeScenarioBoundary(raw);
      if (norm.legacySource !== null && !seenOverlayLegacy.has(norm.legacySource)) {
        seenOverlayLegacy.add(norm.legacySource);
        warnings.push(`legacy-boundary: ${norm.legacySource} → ${norm.normalized} (warning)`);
      }
      return norm.known ? norm.normalized : raw;
    });
    replacements.set(name, normalized);
  }
  if (typeof digestRaw === 'string' && digestRaw !== overlayDigestOf(baseText)) {
    warnings.push(`overlay-stale: base changed since ${digestRaw.slice(0, 8)} (warning)`);
  }
  try {
    await lstat(join(canonicalRoot, '.git'));
    let ignore = '';
    try {
      // lstat-guarded read (cli/up-overlay.ts mirror): a symlinked
      // .gitignore is unverifiable — skip the mention check silently.
      if ((await lstat(join(canonicalRoot, '.gitignore'))).isSymbolicLink()) {
        return { applied: true, replacements, warnings, error: null };
      }
      ignore = (await readFile(join(canonicalRoot, '.gitignore'), 'utf8')).slice(0, 64 * 1024);
    } catch {
      warnings.push(`overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`);
    }
    if (ignore !== '' && !ignore.split('\n').some(line => line.trim() === OVERLAY_LOCAL_FILE || line.includes(OVERLAY_LOCAL_FILE))) {
      warnings.push(`overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`);
    }
  } catch {
    // Gitless roots stay silent.
  }
  return { applied: true, replacements, warnings, error: null };
}

/**
 * `<root>/ow.scenarios.yaml` bounded read-only scenario-matrix source.
 * Off-root/symlink/cap discipline is the same as §0.3; if the file is MISSING a silent
 * null record (UI "no scenario file attached"), if corrupt an error box
 * (the other panels stay intact). With multiple roots it merges by first-wins name.
 * M9: each root's local overlay convention (`.ow/boundaries.local.yaml`)
 * applies per-scenario REPLACE before the cross-root merge; an invalid
 * overlay keeps the base rows and surfaces `overlayError` (error box,
 * never a crash).
 */
export async function readScenariosSource(roots: string[]): Promise<{
  scenarios: ParsedScenario[] | null;
  error: string | null;
  warnings: string[];
  overlayApplied: boolean;
  overlayFile: string | null;
  boundarySources: OverlayBoundarySource[];
  overlayError: string | null;
}> {
  const warnings: string[] = [];
  const merged = new Map<string, ParsedScenario>();
  const boundarySources: OverlayBoundarySource[] = [];
  let error: string | null = null;
  let found = false;
  let overlayApplied = false;
  let overlayError: string | null = null;
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const path = join(canonicalRoot, SCENARIOS_FILE_NAME);
    if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      warnings.push(`scenario skipped (symlink not followed): ${SCENARIOS_FILE_NAME}`);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.size > SCENARIOS_MAX_BYTES) {
      warnings.push(`scenario truncated: ${basename(canonicalRoot)} (256KB limit) — section unaffected`);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    } catch {
      warnings.push(`scenario unreadable: ${basename(canonicalRoot)} — section unaffected`);
      if (error === null) error = 'file unreadable';
      continue;
    }
    found = true;
    let parsed: { scenarios: ParsedScenario[]; warnings: string[] };
    try {
      parsed = normalizeScenarios(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(maskSecrets(`scenario corrupt: ${basename(canonicalRoot)} (${reason}) — section unaffected`));
      if (error === null) error = maskSecrets(reason);
      continue;
    }
    for (const warning of parsed.warnings) warnings.push(maskSecrets(warning));
    // M9 convention second-read (server-side, local file only): REPLACE
    // this root's scenario boundaries before the cross-root merge.
    const baseNames = new Set(parsed.scenarios.map(scenario => scenario.name));
    const overlay = await readRootOverlay(canonicalRoot, text, baseNames);
    let scoped = parsed.scenarios;
    if (overlay.error !== null) {
      if (overlayError === null) overlayError = overlay.error;
      warnings.push(maskSecrets(overlay.error));
    } else {
      for (const warning of overlay.warnings) warnings.push(maskSecrets(warning));
      if (overlay.applied) {
        overlayApplied = true;
        scoped = parsed.scenarios.map(scenario => {
          const replacement = overlay.replacements.get(scenario.name);
          return replacement === undefined ? scenario : { ...scenario, boundaries: [...replacement] };
        });
        const replaced = new Set(overlay.replacements.keys());
        for (const scenario of scoped) {
          if (!replaced.has(scenario.name)) continue;
          for (const boundary of scenario.boundaries) {
            boundarySources.push({ scenario: maskSecrets(scenario.name), boundary: maskSecrets(boundary), source: 'local' });
          }
        }
      }
    }
    for (const scenario of scoped) {
      if (!merged.has(scenario.name)) {
        merged.set(scenario.name, scenario);
        if (!overlay.replacements.has(scenario.name)) {
          for (const boundary of scenario.boundaries) {
            boundarySources.push({ scenario: maskSecrets(scenario.name), boundary: maskSecrets(boundary), source: 'base' });
          }
        }
      } else warnings.push(maskSecrets(`scenario duplicated: ${scenario.name} (${basename(canonicalRoot)})`));
    }
  }
  const overlayFile = overlayApplied ? OVERLAY_LOCAL_FILE : null;
  if (!found && error === null) return { scenarios: null, error: null, warnings, overlayApplied: false, overlayFile: null, boundarySources: [], overlayError };
  if (merged.size === 0) return { scenarios: null, error: error ?? 'no record', warnings, overlayApplied: false, overlayFile: null, boundarySources: [], overlayError };
  return { scenarios: [...merged.values()], error: null, warnings, overlayApplied, overlayFile, boundarySources, overlayError };
}

// --- Service wire -----------------------------------------------------------

export interface CoordinatorRuntime {
  list?: Parameters<typeof environmentStatus>[3];
  probe?: (port: number) => Promise<boolean>;
}

export async function coordinatorSnapshot(
  store: Store,
  workspaceName: string,
  environmentName: string,
  runtime: CoordinatorRuntime = {},
  run?: string,
): Promise<CoordinatorSnapshot> {
  const state = await store.read();
  const workspace = resolveWorkspaceRecord(state, workspaceName, verifyMessages.notFoundRegister, verifyMessages.notFoundRegister);
  const { record } = resolveEnvironmentRecord(state, workspaceName, environmentName, {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  });
  const roots = [...workspace.roots];
  const [status, checkpointRead, supervisorRead, scenariosRead] = await Promise.all([
    environmentStatus(store, workspaceName, environmentName, runtime.list),
    readCheckpointSource(roots, run),
    readSupervisorRecords(roots),
    readScenariosSource(roots),
  ]);
  const probe = runtime.probe ?? probeTcpPort;
  const ports = [...new Set(record.services.map(service => service.port).filter((port): port is number => typeof port === 'number'))];
  const portOccupied = new Map<number, boolean>();
  const freeSuggestion = new Map<number, number | null>();
  const unprobedPorts: number[] = [];
  await Promise.all(ports.map(async port => {
    try {
      const occupied = await probe(port);
      portOccupied.set(port, occupied);
      if (occupied) {
        try {
          freeSuggestion.set(port, await suggestFreePort(port, probe));
        } catch {
          freeSuggestion.set(port, null);
        }
      }
    } catch {
      unprobedPorts.push(port);
    }
  }));
  // Worktree identity: carried only when >1 root. rootBase comes from the
  // recorded topology, revShort from the same-named supervisor record (null
  // when missing → basename-only chip); no new exec/reads.
  const worktreeByService = roots.length > 1
    ? new Map(record.services.map(service => {
      const key = service.name ?? service.id;
      const rev = supervisorRead.records.find(candidate => candidate.name === key)?.rev;
      return [service.id, { rootBase: basename(resolve(service.repositoryPath)), revShort: rev === undefined ? null : shortRev(rev) }] as const;
    }))
    : undefined;
  // Ledger + advisories: read-only aggregation, >1 root only
  // (single-root snapshots carry neither rows nor warnings). Never gates:
  // preflight gates and spawn paths are untouched (warnings[] text only).
  let worktreeLedger: { rows: CoordinatorWorktreeEntry[]; warnings: string[] } | undefined;
  if (roots.length > 1) {
    const ledger = await readWorktreeLedger(roots);
    worktreeLedger = { rows: ledger.rows, warnings: [...ledger.warnings, ...buildWorktreeAdvisories(ledger.perRoot)] };
  }
  return buildCoordinatorSnapshot({
    record,
    status,
    portOccupied,
    freeSuggestion,
    checkpointWarnings: [...checkpointRead.warnings, ...supervisorRead.warnings, ...scenariosRead.warnings],
    checkpoint: checkpointRead.source,
    supervisor: supervisorRead.records,
    scenarioRead: scenariosRead,
    runs: checkpointRead.runs,
    ...(worktreeByService === undefined ? {} : { worktreeByService }),
    ...(worktreeLedger === undefined ? {} : { worktreeLedger }),
    unprobedPorts,
  });
}
