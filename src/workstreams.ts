import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { maskSecrets } from './run-summaries.js';
export { pinnedRunIds } from './run-summaries.js';
import { runBoundedCommand, type CommandRunner, type DirtyFingerprint } from './verify.js';

export type WorkstreamStatus = 'active' | 'paused' | 'done';

export interface WorkstreamCheckout {
  root: string;
  revision: string | null;
  revisionState: 'observed' | 'unknown';
  observedAt: string;
}

export interface CheckpointNote {
  goal: string;
  blocker: string;
  next: string;
  owner: 'agent' | 'user';
  at: string;
  /**
   * Bounded references to run summaries in this workstream's workspace
   * (opaque file-stem IDs only, never content). Empty means no links;
   * outside evidence is described in-note, never linked.
   */
  evidence: string[];
}

export type CompletionOutcome = 'passed' | 'blocked' | 'failed';
export type CompletionCheckResult = 'passed' | 'failed' | 'error';

export interface CompletionCheckInput {
  name: string;
  result: CompletionCheckResult;
  environment: string;
  evidenceIds?: string[];
}

export interface CompletionInput {
  assignmentId: string;
  completionId: string;
  outcome: CompletionOutcome;
  revision: string | null;
  dirty: boolean | null;
  dirtyFingerprint: DirtyFingerprint | null;
  checks: CompletionCheckInput[];
}

export interface CompletionCheck extends CompletionCheckInput {
  evidenceIds: string[];
  evidenceSource: 'agent_report';
  evidenceLabel: 'Agent-reported — not independently verified here';
}

export interface CompletionRecord extends Omit<CompletionInput, 'checks'> {
  checks: CompletionCheck[];
  recordedAt: string;
}

export interface Workstream {
  id: string;
  name: string;
  workspaceId: string;
  checkouts: WorkstreamCheckout[];
  status: WorkstreamStatus;
  /** Latest checkpoint entry; all existing readers keep this shape. */
  checkpointNote: CheckpointNote | null;
  /**
   * Append-only bounded history (oldest-first, last 10). Each entry carries
   * its own owner+at, so a subagent completion appends without clobbering
   * the coordinator checkpoint. Legacy files omit this and seed from
   * checkpointNote at read/write time — no migration.
   */
  checkpointHistory: CheckpointNote[];
  /** Independent bounded completion ring; does not share checkpoint-note history. */
  completions: CompletionRecord[];
  createdAt: string;
  updatedAt: string;
}

const revisionTimeoutMs = 10_000;
const maxCheckouts = 20;
const maxWorkstreams = 50;
// Assignment records outlive more checkpoint notes but remain strictly bounded.
export const maxWorkstreamCompletions = 20;

async function canonicalCheckoutRoot(candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || candidate.length > 4096) {
    throw new Error('Checkouts must be registered roots of this workspace.');
  }
  const resolved = resolve(candidate);
  try {
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Checkouts must be registered roots of this workspace.');
    const canonical = await realpath(resolved);
    if (canonical !== resolved) throw new Error('Checkouts must be registered roots of this workspace.');
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === 'Checkouts must be registered roots of this workspace.') throw error;
    throw new Error('Checkouts must be registered roots of this workspace.');
  }
}

async function observeRevision(root: string, run: CommandRunner): Promise<{ revision: string | null; revisionState: 'observed' | 'unknown' }> {
  try {
    const result = await run('git', ['rev-parse', 'HEAD'], {
      cwd: root, timeoutMs: revisionTimeoutMs, outputLimit: 4096,
      env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: '0' },
    });
    const sha = result.stdout.trim();
    if (!result.spawnFailed && result.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) {
      return { revision: sha, revisionState: 'observed' };
    }
  } catch {
    // A missing git or a non-git folder is honest unknown, not a failure.
  }
  return { revision: null, revisionState: 'unknown' };
}

export async function createWorkstream(
  store: Store,
  input: { name: string; workspaceId: string; checkouts: string[] },
  run: CommandRunner = runBoundedCommand,
): Promise<Workstream> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new Error('Provide a workstream name with 100 characters or fewer.');
  if (!Array.isArray(input.checkouts) || input.checkouts.length === 0 || input.checkouts.length > maxCheckouts) {
    throw new Error('Select at least one checkout and no more than twenty.');
  }
  return store.update(async state => {
    const workspace = state.workspaces.find(workspace => workspace.id === input.workspaceId);
    if (!workspace) throw new Error('Workspace access not found.');
    if (state.workstreams.length >= maxWorkstreams) throw new Error('Workstream limit reached.');
    const roots: string[] = [];
    for (const candidate of input.checkouts) {
      const canonical = await canonicalCheckoutRoot(candidate);
      // A workstream binds whole registered roots, never subdirectories: ownership stays unambiguous.
      if (!workspace.roots.includes(canonical)) throw new Error('Checkouts must be registered roots of this workspace.');
      if (!roots.includes(canonical)) roots.push(canonical);
    }
    if (roots.length === 0) throw new Error('Select at least one checkout and no more than twenty.');
    const observedAt = new Date().toISOString();
    const checkouts: WorkstreamCheckout[] = [];
    for (const root of roots) {
      const observed = await observeRevision(root, run);
      checkouts.push({ root, ...observed, observedAt });
    }
    const now = new Date().toISOString();
    const workstream: Workstream = {
      id: randomUUID(), name, workspaceId: workspace.id, checkouts,
      status: 'active', checkpointNote: null, checkpointHistory: [], completions: [], createdAt: now, updatedAt: now,
    };
    state.workstreams.push(workstream);
    return workstream;
  });
}

export const checkpointBoundsMessage = 'Checkpoint notes hold 2000 characters or fewer.';
export const checkpointPatternMessage = 'Checkpoint notes accept patterns only, never secrets or literals.';
export const checkpointEvidenceMessage = 'Checkpoint evidence must reference existing runs in this workspace.';

export function assertCheckpointEvidence(evidence: readonly string[], accessibleRunIds: ReadonlySet<string>): void {
  for (const ref of evidence) {
    if (!accessibleRunIds.has(ref)) throw new Error(checkpointEvidenceMessage);
  }
}

const maxCheckpointTotal = 2000;
const maxCheckpointField = 1000;
// Pattern-only notes never carry filesystem literals: any whitespace- or
// quote-delimited token beginning with /, a drive prefix (C:\ or C:/) or a
// UNC share is refused, case-insensitively, without maintaining a per-root
// allowlist (/opt, /root, /Users and \\server\share all match).
const absolutePathPattern = /(^|[\s"'=(])(\/[^\s"';)]+|[A-Za-z]:[\\/][^\s]*|\\\\[^\s]+)/i;

function checkpointField(name: string, value: unknown, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxCheckpointField) {
    throw new Error(checkpointBoundsMessage);
  }
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    || maskSecrets(value) !== value
    || absolutePathPattern.test(value)) {
    throw new Error(checkpointPatternMessage);
  }
  return value;
}

/** Validate a bounded pattern-only pause note; the caller stamps `at`. */
export function sanitizeCheckpointNote(note: { goal: unknown; blocker: unknown; next: unknown; owner: unknown; evidence?: unknown }): {
  goal: string; blocker: string; next: string; owner: 'agent' | 'user'; evidence: string[];
} {
  if (!note || typeof note !== 'object') throw new Error(checkpointBoundsMessage);
  const goal = checkpointField('goal', note.goal, false);
  const blocker = checkpointField('blocker', note.blocker, true);
  const next = checkpointField('next', note.next, false);
  if (note.owner !== 'agent' && note.owner !== 'user') throw new Error(checkpointBoundsMessage);
  if (goal.length + blocker.length + next.length > maxCheckpointTotal) throw new Error(checkpointBoundsMessage);
  return { goal, blocker, next, owner: note.owner, evidence: sanitizeCheckpointEvidence(note.evidence) };
}

const maxCheckpointEvidence = 5;
// Opaque run-summary stems only: letters, digits and ._- separators, never
// slashes, whitespace or secret-shaped content. Malformed entries are a
// bounds/shape refusal; well-formed but unknown IDs are refused separately
// against the scope's stored runs.
const evidenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Shape-validate optional evidence refs; existence is checked by the service against the scope's stored runs. */
export function sanitizeCheckpointEvidence(evidence: unknown): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > maxCheckpointEvidence) throw new Error(checkpointBoundsMessage);
  const refs: string[] = [];
  for (const entry of evidence) {
    if (typeof entry !== 'string' || !evidenceIdPattern.test(entry)) throw new Error(checkpointBoundsMessage);
    if (!refs.includes(entry)) refs.push(entry);
  }
  return refs;
}

export const completionBoundsMessage = 'Completion records exceed the allowed bounds.';
export const completionPatternMessage = 'Completion records accept safe metadata only, never secrets or literals.';
export const completionEvidenceMessage = 'Completion evidence must reference existing runs in this workspace.';
export const completionIdConflictMessage = 'Completion ID already exists with different content.';
// Invalid as an explicit assignment ID, so callers cannot collide with the implicit solo group.
export const soloDefaultAssignmentId = '__solo__';

const assignmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const completionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validAssignmentId(value: unknown): value is string {
  return typeof value === 'string' && assignmentIdPattern.test(value) && maskSecrets(value) === value;
}

function completionText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(completionBoundsMessage);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || maskSecrets(value) !== value || absolutePathPattern.test(value)) {
    throw new Error(completionPatternMessage);
  }
  return value;
}

function sanitizeDirtyFingerprint(value: unknown): DirtyFingerprint | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(completionBoundsMessage);
  const fingerprint = value as Record<string, unknown>;
  if (Object.keys(fingerprint).some(key => !['diffHash', 'files', 'truncated'].includes(key))
    || typeof fingerprint.diffHash !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint.diffHash)
    || typeof fingerprint.truncated !== 'boolean'
    || !Array.isArray(fingerprint.files) || fingerprint.files.length > 50) {
    throw new Error(completionBoundsMessage);
  }
  const files = fingerprint.files.map(file => {
    const path = completionText(file, 256);
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
      || path.split('/').some(segment => segment === '..')) throw new Error(completionPatternMessage);
    return path;
  });
  return { diffHash: fingerprint.diffHash, files, truncated: fingerprint.truncated };
}

/** Parse a child handoff as a claim; evidence source is stamped by this service, never supplied by the child. */
export function sanitizeCompletion(input: unknown): CompletionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(completionBoundsMessage);
  const record = input as Record<string, unknown>;
  const allowed = ['assignmentId', 'completionId', 'outcome', 'revision', 'dirty', 'dirtyFingerprint', 'checks'];
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error(completionBoundsMessage);
  if ((record.assignmentId !== undefined && !validAssignmentId(record.assignmentId)) || typeof record.completionId !== 'string'
    || !completionIdPattern.test(record.completionId)) throw new Error(completionBoundsMessage);
  if (record.outcome !== 'passed' && record.outcome !== 'blocked' && record.outcome !== 'failed') {
    throw new Error(completionBoundsMessage);
  }
  if (record.revision !== null && (typeof record.revision !== 'string' || !/^[0-9a-f]{40}$/.test(record.revision))) {
    throw new Error(completionBoundsMessage);
  }
  if (record.dirty !== null && typeof record.dirty !== 'boolean') throw new Error(completionBoundsMessage);
  const dirtyFingerprint = sanitizeDirtyFingerprint(record.dirtyFingerprint);
  if (record.dirty === false && dirtyFingerprint !== null) throw new Error(completionBoundsMessage);
  if (!Array.isArray(record.checks) || record.checks.length < 1 || record.checks.length > 20) {
    throw new Error(completionBoundsMessage);
  }
  const checks: CompletionCheckInput[] = record.checks.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(completionBoundsMessage);
    const check = raw as Record<string, unknown>;
    if (Object.keys(check).some(key => !['name', 'result', 'environment', 'evidenceIds'].includes(key))) {
      throw new Error(completionBoundsMessage);
    }
    if (check.result !== 'passed' && check.result !== 'failed' && check.result !== 'error') {
      throw new Error(completionBoundsMessage);
    }
    const name = completionText(check.name, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(name)) throw new Error(completionBoundsMessage);
    const environment = completionText(check.environment, 200);
    const evidenceIds = sanitizeCheckpointEvidence(check.evidenceIds);
    return { name, result: check.result, environment, evidenceIds };
  });
  return {
    assignmentId: record.assignmentId === undefined ? soloDefaultAssignmentId : record.assignmentId as string,
    completionId: record.completionId.toLowerCase(),
    outcome: record.outcome,
    revision: record.revision,
    dirty: record.dirty,
    dirtyFingerprint,
    checks,
  };
}

function sameCompletionPayload(existing: CompletionRecord, input: CompletionInput): boolean {
  return JSON.stringify({
    assignmentId: existing.assignmentId,
    completionId: existing.completionId.toLowerCase(),
    outcome: existing.outcome,
    revision: existing.revision,
    dirty: existing.dirty,
    dirtyFingerprint: existing.dirtyFingerprint,
    checks: existing.checks.map(({ name, result, environment, evidenceIds }) => ({ name, result, environment, evidenceIds })),
  }) === JSON.stringify(input);
}

/** Append assignment-scoped result records only; status remains explicitly coordinator-controlled. */
export async function appendWorkstreamCompletion(
  store: Store,
  id: string,
  input: unknown,
  readAccessibleRunIds: () => Promise<ReadonlySet<string>>,
): Promise<Workstream> {
  const sanitized = sanitizeCompletion(input);
  return store.update(async state => {
    const workstream = state.workstreams.find(entry => entry.id === id);
    if (!workstream) throw new Error('Unknown workstream.');
    const completions = workstream.completions ?? [];
    const duplicate = completions.find(entry => entry.completionId.toLowerCase() === sanitized.completionId);
    if (duplicate) {
      if (!sameCompletionPayload(duplicate, sanitized)) throw new Error(completionIdConflictMessage);
      return workstream;
    }
    // Resolve evidence only once this write reaches the Store queue head. A
    // run-summary ring eviction while the completion waits must be refused,
    // rather than leaving a durable dangling reference.
    const accessibleRunIds = await readAccessibleRunIds();
    for (const check of sanitized.checks) {
      for (const evidenceId of check.evidenceIds ?? []) {
        if (!accessibleRunIds.has(evidenceId)) throw new Error(completionEvidenceMessage);
      }
    }
    const entry: CompletionRecord = {
      ...sanitized,
      checks: sanitized.checks.map(check => ({
        ...check,
        evidenceIds: check.evidenceIds ?? [],
        evidenceSource: 'agent_report',
        evidenceLabel: 'Agent-reported — not independently verified here',
      })),
      recordedAt: new Date().toISOString(),
    };
    workstream.completions = [...completions, entry].slice(-maxWorkstreamCompletions);
    workstream.updatedAt = entry.recordedAt;
    return workstream;
  });
}

/** Bounded history depth: the latest entries survive, oldest evict first. */
export const maxCheckpointHistory = 10;

/**
 * Read view over the append-only history. Files written before history
 * exist carry the single note as history[0]; files with no note read empty.
 * Pure read normalization — never mutates stored state.
 */
export function checkpointHistoryOf(workstream: {
  checkpointNote: CheckpointNote | null;
  checkpointHistory?: CheckpointNote[] | null;
}): CheckpointNote[] {
  const stored = Array.isArray(workstream.checkpointHistory) ? workstream.checkpointHistory : [];
  if (stored.length > 0) return stored;
  return workstream.checkpointNote ? [{ ...workstream.checkpointNote }] : [];
}

export async function setWorkstreamStatus(
  store: Store,
  id: string,
  status: WorkstreamStatus,
  readAccessibleRunIds: (workspaceId: string) => Promise<ReadonlySet<string>>,
  note?: { goal: unknown; blocker: unknown; next: unknown; owner: unknown; evidence?: unknown },
): Promise<Workstream> {
  if (status !== 'active' && status !== 'paused' && status !== 'done') throw new Error('Unknown workstream status.');
  const sanitized = note === undefined ? undefined : sanitizeCheckpointNote(note);
  return store.update(async state => {
    const workstream = state.workstreams.find(workstream => workstream.id === id);
    if (!workstream) throw new Error('Unknown workstream.');
    if (workstream.status === 'done' && status !== 'done') throw new Error('A finished workstream cannot be reopened.');
    if (sanitized?.evidence.length) {
      assertCheckpointEvidence(sanitized.evidence, await readAccessibleRunIds(workstream.workspaceId));
    }
    workstream.status = status;
    // A supplied note appends to the bounded history (oldest-first, last 10)
    // and becomes the latest entry; omitting it preserves both the latest
    // note and the history across resume so a later session still finds them.
    // Legacy files carry only the single note: it seeds history[0] on the
    // first append so the coordinator checkpoint survives a subagent write.
    if (sanitized !== undefined) {
      const previous = workstream.checkpointNote;
      const entry: CheckpointNote = { ...sanitized, at: new Date().toISOString() };
      workstream.checkpointNote = entry;
      const base = Array.isArray(workstream.checkpointHistory) && workstream.checkpointHistory.length > 0
        ? workstream.checkpointHistory
        : previous ? [{ ...previous }] : [];
      workstream.checkpointHistory = [...base, entry].slice(-maxCheckpointHistory);
    }
    workstream.updatedAt = new Date().toISOString();
    return workstream;
  });
}
