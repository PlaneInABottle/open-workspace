import type { State, Store } from './store.js';

export type LeaseStatus = 'held' | 'queued';

export interface Lease {
  resource: string;
  workstreamId: string;
  status: LeaseStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

const maxLeases = 50;
// There is no cumulative tenure cap: a live holder may renew by this TTL indefinitely.
export const leaseTtlMs = 10 * 60 * 1000;
const resourcePattern = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
export type LeaseActor = 'dashboard' | 'mcp';
type Clock = () => number;

function validResource(resource: unknown): resource is string {
  return typeof resource === 'string' && resourcePattern.test(resource);
}

function expireLeases(state: State, actor: LeaseActor, now: number) {
  const expired = state.leases.filter(lease => lease.status === 'held'
    && lease.expiresAt !== null && Date.parse(lease.expiresAt) <= now);
  if (!expired.length) return;

  let promoted = 0;
  for (const lease of expired) {
    const index = state.leases.indexOf(lease);
    if (index === -1) continue;
    state.leases.splice(index, 1);
    const next = state.leases
      .filter(entry => entry.resource === lease.resource && entry.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) {
      next.status = 'held';
      next.updatedAt = new Date(now).toISOString();
      next.expiresAt = new Date(now + leaseTtlMs).toISOString();
      promoted++;
    }
  }

  state.activity.push({
    at: new Date(now).toISOString(),
    actor,
    operation: 'lease-expiry',
    workspaceId: null,
    detail: `${expired.length} expired, ${promoted} promoted`,
  });
  while (state.activity.length > 50) state.activity.shift();
}

export async function expireLeasesOnRead(
  store: Store,
  actor: LeaseActor = 'mcp',
  clock: Clock = Date.now,
): Promise<State> {
  const now = clock();
  return store.update(state => {
    expireLeases(state, actor, now);
    return state;
  });
}

export async function acquireLease(
  store: Store,
  input: { resource: string; workstreamId: string },
  actor: LeaseActor = 'mcp',
  clock: Clock = Date.now,
): Promise<{ lease: Lease; position: number }> {
  if (!validResource(input.resource)) throw new Error('Name the resource with 1–80 lowercase letters, digits or :._- characters.');
  const now = clock();
  const result = await store.update(state => {
    expireLeases(state, actor, now);
    const workstream = state.workstreams.find(workstream => workstream.id === input.workstreamId);
    if (!workstream) return { error: 'Unknown workstream.' } as const;
    if (workstream.status === 'done') return { error: 'A finished workstream cannot hold leases.' } as const;
    if (state.leases.length >= maxLeases) return { error: 'Lease limit reached.' } as const;
    const entries = state.leases.filter(lease => lease.resource === input.resource);
    const existing = entries.find(lease => lease.workstreamId === input.workstreamId);
    if (existing) {
      const position = existing.status === 'held'
        ? 0
        : entries.filter(lease => lease.status === 'queued' && lease.createdAt <= existing.createdAt).length;
      return { lease: existing, position } as const;
    }
    const timestamp = new Date(now).toISOString();
    const held = entries.some(lease => lease.status === 'held');
    const lease: Lease = {
      resource: input.resource,
      workstreamId: input.workstreamId,
      status: held ? 'queued' : 'held',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: held ? null : new Date(now + leaseTtlMs).toISOString(),
    };
    state.leases.push(lease);
    const position = lease.status === 'held'
      ? 0
      : entries.filter(lease => lease.status === 'queued').length + 1;
    return { lease, position } as const;
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

export async function listLeases(
  store: Store,
  actor: LeaseActor = 'mcp',
  clock: Clock = Date.now,
): Promise<Lease[]> {
  return (await expireLeasesOnRead(store, actor, clock)).leases;
}

export async function touchLease(
  store: Store,
  input: { resource: string; workstreamId: string },
  actor: LeaseActor = 'mcp',
  clock: Clock = Date.now,
): Promise<Lease> {
  if (!validResource(input.resource)) throw new Error('Name the resource with 1–80 lowercase letters, digits or :._- characters.');
  const now = clock();
  const result = await store.update(state => {
    expireLeases(state, actor, now);
    const lease = state.leases.find(entry => entry.resource === input.resource
      && entry.workstreamId === input.workstreamId && entry.status === 'held');
    if (!lease) return { error: 'Only the holding workstream can touch a lease.' } as const;
    if (state.workstreams.find(workstream => workstream.id === input.workstreamId)?.status === 'done') {
      return { error: 'A finished workstream cannot hold leases.' } as const;
    }
    lease.updatedAt = new Date(now).toISOString();
    lease.expiresAt = new Date(now + leaseTtlMs).toISOString();
    return { lease } as const;
  });
  if ('error' in result) throw new Error(result.error);
  return result.lease;
}

export function finishWorkstreamLeasesInState(
  state: State,
  workstreamId: string,
  actor: LeaseActor,
  now: number,
): void {
  // A terminal workstream relinquishes its resources so FIFO waiters can proceed.
  const queuedRemoved = state.leases.filter(lease => lease.workstreamId === workstreamId && lease.status === 'queued').length;
  if (queuedRemoved) state.leases = state.leases.filter(lease => !(lease.workstreamId === workstreamId && lease.status === 'queued'));
  expireLeases(state, actor, now);

  const held = state.leases.filter(lease => lease.workstreamId === workstreamId && lease.status === 'held');
  let promoted = 0;
  for (const lease of held) {
    const index = state.leases.indexOf(lease);
    if (index === -1) continue;
    state.leases.splice(index, 1);
    const next = state.leases
      .filter(entry => entry.resource === lease.resource && entry.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) {
      next.status = 'held';
      next.updatedAt = new Date(now).toISOString();
      next.expiresAt = new Date(now + leaseTtlMs).toISOString();
      promoted++;
    }
  }

  if (!held.length && !queuedRemoved) return;
  state.activity.push({
    at: new Date(now).toISOString(),
    actor,
    operation: 'lease-finish',
    workspaceId: null,
    detail: `${held.length} released, ${promoted} promoted, ${queuedRemoved} queued removed`,
  });
  while (state.activity.length > 50) state.activity.shift();
}

export async function releaseLease(
  store: Store,
  input: { resource: string; workstreamId: string },
  actor: LeaseActor = 'mcp',
  clock: Clock = Date.now,
): Promise<{ released: boolean; promoted: string | null }> {
  if (!validResource(input.resource)) throw new Error('Name the resource with 1–80 lowercase letters, digits or :._- characters.');
  const now = clock();
  const result = await store.update(state => {
    expireLeases(state, actor, now);
    const index = state.leases.findIndex(
      lease => lease.resource === input.resource && lease.workstreamId === input.workstreamId && lease.status === 'held',
    );
    if (index === -1) return { error: 'Only the holding workstream can release a lease.' } as const;
    state.leases.splice(index, 1);
    const next = state.leases
      .filter(lease => lease.resource === input.resource && lease.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) {
      next.status = 'held';
      next.updatedAt = new Date(now).toISOString();
      next.expiresAt = new Date(now + leaseTtlMs).toISOString();
      return { released: true, promoted: next.workstreamId } as const;
    }
    return { released: true, promoted: null } as const;
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}
