import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { DashboardSessions } from '../src/dashboard-sessions.js';
import { createApp } from '../src/http.js';
import { leaseTtlMs } from '../src/leases.js';
import type { CommandOutcome, CommandRunner } from '../src/verify.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const gitMissing: CommandRunner = async (): Promise<CommandOutcome> => ({
  exitCode: 0, timedOut: false, aborted: false, truncated: false,
  stdout: '', stderr: '', durationMs: 1, spawnFailed: true,
});

async function twoStreams(t: { after: (cleanup: () => void | Promise<void>) => void }, initialNow = Date.now()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-leases-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();
  let now = initialNow;
  const service = new WorkspaceService(store, undefined, undefined, undefined, gitMissing, undefined, undefined, () => now);
  const approved = await service.register('Project', [first, second]);
  const one = await service.createWorkstream({ name: 'One', workspace: approved.name, checkouts: [first] });
  const two = await service.createWorkstream({ name: 'Two', workspace: approved.name, checkouts: [second] });
  return { service, one, two, setNow: (value: number) => { now = value; } };
}

test('the first workstream holds a free resource; the second queues visibly', async t => {
  const f = await twoStreams(t);
  const first = await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'One' });
  assert.equal(first.lease.status, 'held');
  assert.equal(first.position, 0);
  const second = await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'Two' });
  assert.equal(second.lease.status, 'queued');
  assert.equal(second.position, 1);
  const repeated = await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'Two' });
  assert.equal(repeated.lease.status, 'queued');
  assert.equal(repeated.position, 1);
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.resource, lease.status]), [['port:3000', 'held'], ['port:3000', 'queued']]);
});

test('releasing promotes the oldest queued workstream; only the holder can release', async t => {
  const f = await twoStreams(t);
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' });
  await assert.rejects(
    f.service.releaseLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' }),
    /Only the holding workstream/,
  );
  const released = await f.service.releaseLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  assert.deepEqual(released, { released: true, promoted: f.two.id });
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  const final = await f.service.releaseLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' });
  assert.deepEqual(final, { released: true, promoted: null });
  assert.deepEqual(await f.service.listLeases(), []);
});

test('leases refuse unknown workstreams, finished workstreams and bad names', async t => {
  const f = await twoStreams(t);
  await assert.rejects(
    f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'Missing stream' }),
    /Unknown workstream/,
  );
  await f.service.setWorkstreamStatus('Project', 'One', 'done');
  await assert.rejects(
    f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'One' }),
    /cannot hold leases/,
  );
  for (const resource of ['', 'PORT:3000', 'has space', 'x'.repeat(81), '../escape']) {
    await assert.rejects(
      f.service.acquireLease({ resource, workspace: 'Project', workstream: 'Two' }),
      /Name the resource/,
    );
  }
  await assert.rejects(
    f.service.releaseLease({ resource: 'port:never-held', workspace: 'Project', workstream: 'Two' }),
    /Only the holding workstream/,
  );
  assert.deepEqual(await f.service.listLeases(), []);
});

test('reads without an expiry leave state.json untouched; expiry still rewrites and records', async t => {
  const f = await twoStreams(t);
  await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'One' });
  const path = join(f.service.store.directory, 'state.json');
  const before = (await stat(path)).mtimeMs;
  await f.service.listLeases();
  await f.service.listLeases();
  assert.equal((await stat(path)).mtimeMs, before, 'no rewrite without an expiry');
  assert.equal((await f.service.store.read()).activity.some(entry => entry.operation === 'lease-expiry'), false);
  f.setNow(Date.now() + leaseTtlMs + 1);
  const leases = await f.service.listLeases();
  assert.deepEqual(leases, [], 'the held lease expired');
  assert.ok((await stat(path)).mtimeMs >= before, 'expiry rewrites state');
  assert.equal(
    (await f.service.store.read()).activity.filter(entry => entry.operation === 'lease-expiry').length,
    1,
    'expiry still records its counts-only activity',
  );
});

test('a crashed holder expires lazily, promotes FIFO and records counts-only activity', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  const held = await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'One' });
  const queued = await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'Two' });
  assert.equal(held.lease.expiresAt, new Date(startedAt + leaseTtlMs).toISOString());
  assert.equal(queued.lease.expiresAt, null);

  f.setNow(startedAt + leaseTtlMs);
  const leases = await f.service.listLeases('dashboard');
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  assert.equal(leases[0].expiresAt, new Date(startedAt + leaseTtlMs * 2).toISOString());
  const expiry = (await f.service.store.read()).activity.at(-1);
  assert.deepEqual(expiry, {
    at: new Date(startedAt + leaseTtlMs).toISOString(),
    actor: 'dashboard',
    operation: 'lease-expiry',
    workspaceId: null,
    detail: '1 expired, 1 promoted',
  });
  assert.equal(JSON.stringify(expiry).includes('port:3000'), false);
  assert.equal(JSON.stringify(expiry).includes(f.one.id), false);
});

test('workspace_list overview expires stale leases before returning them', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'port:3000', workspace: 'Project', workstream: 'Two' });
  f.setNow(startedAt + leaseTtlMs);
  const mcpToken = 'c'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const response = await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${mcpToken}` } });
  assert.equal(response.status, 200);
  const overview = await response.json() as { leases: Array<{ workstreamId: string; status: string }> };
  assert.deepEqual(overview.leases.map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  const expiry = (await f.service.store.read()).activity.find(entry => entry.operation === 'lease-expiry');
  assert.deepEqual(expiry && { operation: expiry.operation, detail: expiry.detail }, {
    operation: 'lease-expiry', detail: '1 expired, 1 promoted',
  });
});

test('heartbeat extends the TTL, rejects non-holders and expires at the renewed deadline', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  const held = await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' });
  f.setNow(startedAt + leaseTtlMs - 1);
  await assert.rejects(
    f.service.touchLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' }),
    /Only the holding workstream can touch a lease/,
  );
  const touched = await f.service.touchLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  assert.equal(touched.expiresAt, new Date(startedAt + leaseTtlMs * 2 - 1).toISOString());

  f.setNow(startedAt + leaseTtlMs);
  assert.deepEqual((await f.service.listLeases()).map(lease => [lease.workstreamId, lease.status]), [
    [f.one.id, 'held'], [f.two.id, 'queued'],
  ]);
  f.setNow(Date.parse(touched.expiresAt!));
  assert.deepEqual((await f.service.listLeases()).map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  assert.notEqual(touched.expiresAt, held.lease.expiresAt);
});

test('a live holder may renew repeatedly beyond the original lease tenure', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' });
  let expiresAt = startedAt + leaseTtlMs;

  for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
    f.setNow(expiresAt - 1);
    const renewed = await f.service.touchLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
    expiresAt = Date.parse(renewed.expiresAt!);
  }

  f.setNow(startedAt + leaseTtlMs * 3);
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status]), [
    [f.one.id, 'held'], [f.two.id, 'queued'],
  ]);
  assert.equal(Date.parse(leases[0].expiresAt!), expiresAt);
});

test('touch refuses a finished holder even when legacy state still contains its lease', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  await f.service.store.update(state => {
    state.workstreams.find(workstream => workstream.id === f.one.id)!.status = 'done';
  });

  await assert.rejects(
    f.service.touchLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' }),
    /A finished workstream cannot hold leases/,
  );
  assert.equal((await f.service.listLeases())[0].workstreamId, f.one.id);
});

test('finishing a holder releases its lease, promotes FIFO and records counts only', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'pm2:api', workspace: 'Project', workstream: 'Two' });

  await f.service.setWorkstreamStatus('Project', 'One', 'done');
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  assert.equal((await f.service.workstream('Project', 'One')).status, 'done');
  const finished = (await f.service.store.read()).activity.find(entry => entry.operation === 'lease-finish');
  assert.equal(finished?.detail, '1 released, 1 promoted, 0 queued removed');
  assert.equal(JSON.stringify(finished).includes('pm2:api'), false);
  assert.equal(JSON.stringify(finished).includes(f.one.id), false);
  assert.equal(JSON.stringify(finished).includes(f.two.id), false);
});

test('legacy held leases without expiresAt keep their non-expiring behavior', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  await f.service.acquireLease({ resource: 'legacy:lock', workspace: 'Project', workstream: 'One' });
  await f.service.acquireLease({ resource: 'legacy:lock', workspace: 'Project', workstream: 'Two' });
  const path = join(f.service.store.directory, 'state.json');
  const legacyState = JSON.parse(await readFile(path, 'utf8')) as { leases: Array<Record<string, unknown>> };
  delete legacyState.leases[0].expiresAt;
  await writeFile(path, JSON.stringify(legacyState));

  f.setNow(startedAt + 365 * 24 * 60 * 60 * 1000);
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status, lease.expiresAt]), [
    [f.one.id, 'held', null], [f.two.id, 'queued', null],
  ]);
  assert.equal((await f.service.store.read()).activity.some(entry => entry.operation === 'lease-expiry'), false);
});

test('HTTP heartbeat is MCP-callable, dashboard-gated, strict and returns safe holder errors', async t => {
  const startedAt = 1_800_000_000_000;
  const f = await twoStreams(t, startedAt);
  const mcpToken = 'a'.repeat(64);
  const sessions = new DashboardSessions(() => startedAt, () => 'b'.repeat(64));
  const session = sessions.issue();
  assert.ok(session);
  const app = createApp(f.service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json' };
  const dashboardHeaders = {
    Authorization: `Bearer ${session.dashboardToken}`,
    'Content-Type': 'application/json',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
  };
  const bareDashboardHeaders = {
    Authorization: `Bearer ${session.dashboardToken}`,
    'Content-Type': 'application/json',
  };

  const invalid = await fetch(`${origin}/api/leases/acquire`, {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ resource: 'port:3000', workspace: 'Project', workstream: 'One', ttlMs: 1 }),
  });
  assert.equal(invalid.status, 400);
  const acquired = await fetch(`${origin}/api/leases/acquire`, {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ resource: 'port:3000', workspace: 'Project', workstream: 'One' }),
  });
  assert.equal(acquired.status, 200);
  assert.equal((await acquired.json() as { lease: { expiresAt: string } }).lease.expiresAt,
    new Date(startedAt + leaseTtlMs).toISOString());

  const touchPath = `${origin}/api/leases/touch`;
  const touchBody = JSON.stringify({ resource: 'port:3000', workspace: 'Project', workstream: 'One' });
  assert.equal((await fetch(touchPath, { method: 'POST', headers: bareDashboardHeaders, body: touchBody })).status, 403);
  const touched = await fetch(touchPath, {
    method: 'POST', headers: dashboardHeaders, body: touchBody,
  });
  assert.equal(touched.status, 200);
  assert.equal((await touched.json() as { expiresAt: string }).expiresAt, new Date(startedAt + leaseTtlMs).toISOString());

  const nonHolder = await fetch(touchPath, {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ resource: 'port:3000', workspace: 'Project', workstream: 'Two' }),
  });
  assert.equal(nonHolder.status, 400);
  assert.deepEqual(await nonHolder.json(), { error: 'Only the holding workstream can touch a lease.' });
  assert.equal((await fetch(touchPath, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ resource: 'port:3000', workspace: 'Project', workstream: 'One', extra: true }) })).status, 400);
});
