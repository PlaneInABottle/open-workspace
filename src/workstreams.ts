import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { maskSecrets } from './run-summaries.js';
import { runBoundedCommand, type CommandRunner } from './verify.js';

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

export interface Workstream {
  id: string;
  name: string;
  workspaceId: string;
  checkouts: WorkstreamCheckout[];
  status: WorkstreamStatus;
  /** Bounded pattern-only pause note so later sessions resume; never literals. */
  checkpointNote: CheckpointNote | null;
  createdAt: string;
  updatedAt: string;
}

const revisionTimeoutMs = 10_000;
const maxCheckouts = 20;
const maxWorkstreams = 50;

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
      status: 'active', checkpointNote: null, createdAt: now, updatedAt: now,
    };
    state.workstreams.push(workstream);
    return workstream;
  });
}

export const checkpointBoundsMessage = 'Checkpoint notes hold 2000 characters or fewer.';
export const checkpointPatternMessage = 'Checkpoint notes accept patterns only, never secrets or literals.';
export const checkpointEvidenceMessage = 'Checkpoint evidence must reference existing runs in this workspace.';

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

/** IDs of runs pinned by any checkpoint note in scope; pinned runs survive ring eviction. */
export function pinnedRunIds(
  workstreams: Array<{ workspaceId: string; checkpointNote: { evidence?: string[] } | null }>,
  workspaceId: string,
): Set<string> {
  const pinned = new Set<string>();
  for (const workstream of workstreams) {
    if (workstream.workspaceId !== workspaceId || !workstream.checkpointNote) continue;
    for (const id of workstream.checkpointNote.evidence ?? []) pinned.add(id);
  }
  return pinned;
}

export async function setWorkstreamStatus(
  store: Store,
  id: string,
  status: WorkstreamStatus,
  note?: { goal: unknown; blocker: unknown; next: unknown; owner: unknown; evidence?: unknown },
): Promise<Workstream> {
  if (status !== 'active' && status !== 'paused' && status !== 'done') throw new Error('Unknown workstream status.');
  const sanitized = note === undefined ? undefined : sanitizeCheckpointNote(note);
  return store.update(state => {
    const workstream = state.workstreams.find(workstream => workstream.id === id);
    if (!workstream) throw new Error('Unknown workstream.');
    if (workstream.status === 'done' && status !== 'done') throw new Error('A finished workstream cannot be reopened.');
    workstream.status = status;
    // A supplied note replaces the previous one; omitting it preserves the
    // pause context across resume so a later session still finds it.
    if (sanitized !== undefined) {
      workstream.checkpointNote = { ...sanitized, at: new Date().toISOString() };
    }
    workstream.updatedAt = new Date().toISOString();
    return workstream;
  });
}
