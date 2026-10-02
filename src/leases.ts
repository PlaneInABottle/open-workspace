import type { Store } from './store.js';

export type LeaseStatus = 'held' | 'queued';

export interface Lease {
  resource: string;
  workstreamId: string;
  status: LeaseStatus;
  createdAt: string;
  updatedAt: string;
}

const maxLeases = 50;
const resourcePattern = /^[a-z0-9][a-z0-9:._-]{0,79}$/;

function validResource(resource: unknown): resource is string {
  return typeof resource === 'string' && resourcePattern.test(resource);
}

export async function acquireLease(
  store: Store,
  input: { resource: string; workstreamId: string },
): Promise<{ lease: Lease; position: number }> {
  if (!validResource(input.resource)) throw new Error('Name the resource with 1–80 lowercase letters, digits or :._- characters.');
  return store.update(state => {
    const workstream = state.workstreams.find(workstream => workstream.id === input.workstreamId);
    if (!workstream) throw new Error('Unknown workstream.');
    if (workstream.status === 'done') throw new Error('A finished workstream cannot hold leases.');
    if (state.leases.length >= maxLeases) throw new Error('Lease limit reached.');
    const entries = state.leases.filter(lease => lease.resource === input.resource);
    const existing = entries.find(lease => lease.workstreamId === input.workstreamId);
    if (existing) {
      const position = existing.status === 'held'
        ? 0
        : entries.filter(lease => lease.status === 'queued' && lease.createdAt <= existing.createdAt).length;
      return { lease: existing, position };
    }
    const now = new Date().toISOString();
    const held = entries.some(lease => lease.status === 'held');
    const lease: Lease = {
      resource: input.resource,
      workstreamId: input.workstreamId,
      status: held ? 'queued' : 'held',
      createdAt: now,
      updatedAt: now,
    };
    state.leases.push(lease);
    const position = lease.status === 'held'
      ? 0
      : entries.filter(lease => lease.status === 'queued').length + 1;
    return { lease, position };
  });
}

export async function releaseLease(
  store: Store,
  input: { resource: string; workstreamId: string },
): Promise<{ released: boolean; promoted: string | null }> {
  if (!validResource(input.resource)) throw new Error('Name the resource with 1–80 lowercase letters, digits or :._- characters.');
  return store.update(state => {
    const index = state.leases.findIndex(
      lease => lease.resource === input.resource && lease.workstreamId === input.workstreamId && lease.status === 'held',
    );
    if (index === -1) throw new Error('Only the holding workstream can release a lease.');
    state.leases.splice(index, 1);
    const next = state.leases
      .filter(lease => lease.resource === input.resource && lease.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) {
      next.status = 'held';
      next.updatedAt = new Date().toISOString();
      return { released: true, promoted: next.workstreamId };
    }
    return { released: true, promoted: null };
  });
}
