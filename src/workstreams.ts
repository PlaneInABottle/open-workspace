import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { runBoundedCommand, type CommandRunner } from './verify.js';

export type WorkstreamStatus = 'active' | 'paused' | 'done';

export interface WorkstreamCheckout {
  root: string;
  revision: string | null;
  revisionState: 'observed' | 'unknown';
  observedAt: string;
}

export interface Workstream {
  id: string;
  name: string;
  workspaceId: string;
  checkouts: WorkstreamCheckout[];
  status: WorkstreamStatus;
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
      status: 'active', createdAt: now, updatedAt: now,
    };
    state.workstreams.push(workstream);
    return workstream;
  });
}

export async function setWorkstreamStatus(store: Store, id: string, status: WorkstreamStatus): Promise<Workstream> {
  if (status !== 'active' && status !== 'paused' && status !== 'done') throw new Error('Unknown workstream status.');
  return store.update(state => {
    const workstream = state.workstreams.find(workstream => workstream.id === id);
    if (!workstream) throw new Error('Unknown workstream.');
    if (workstream.status === 'done' && status !== 'done') throw new Error('A finished workstream cannot be reopened.');
    workstream.status = status;
    workstream.updatedAt = new Date().toISOString();
    return workstream;
  });
}
