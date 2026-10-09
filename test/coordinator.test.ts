// D1 coordinator: dashboard-only aggregate (P1 reconcile + P2 preflight).
// Role gate (MCP 403), wire secret discipline (hunter2 sentinel), runner-file
// bounds (cap/corrupt fail-closed + warnings), error mapping, no activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { buildCoordinatorSnapshot, maskSecrets } from '../src/coordinator.js';
import { environmentMessages } from '../src/environment.js';
import { verifyMessages } from '../src/verify.js';
import type { EnvironmentRecord } from '../src/store.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-coordinator-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, 'backend');
  await mkdir(backend, { recursive: true });
  await writeFile(join(backend, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  // PM2 unavailable in tests: every owned entry reports from its recorded
  // poll, unowned services report down. Deterministic without a daemon.
  const unavailableList = async () => ({ available: false as const, error: 'missing' as const });
  const service = new WorkspaceService(store, unavailableList);
  return { root, backend, store, service };
}

function freeListener(t: { after: (cleanup: () => void | Promise<void>) => void }): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      t.after(() => new Promise<void>(done => server.close(() => done())));
      resolve(port);
    });
  });
}

test('coordinator is dashboard-only: dashboard reads, MCP token gets 403', async t => {
  const f = await fixture(t);
  const port = await freeListener(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [
      { id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'web', repositoryPath: f.backend, scriptName: 'dev', port, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  const mcpToken = 'c'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const path = `/api/workspaces/Coord/coordinator?environment=dev`;
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}` };

  const dashboard = await fetch(`${origin}${path}`);
  assert.equal(dashboard.status, 200);
  const snapshot = await dashboard.json() as {
    reconcile: { inSync: boolean; drifts: unknown[] };
    readiness: Array<{ dir: string | null }>;
    explanation: null; preflight: { pass: boolean; missing: string[] };
    checkpoints: null; scenarios: null; warnings: string[];
    meta: { producedAt: string; snapshotId: string; environment: string };
  };
  assert.equal(snapshot.explanation, null);
  assert.equal(snapshot.checkpoints, null);
  assert.equal(snapshot.scenarios, null);
  assert.equal(snapshot.meta.environment, 'dev');
  assert.match(snapshot.meta.snapshotId, /^[0-9a-f]{8}$/);
  assert.ok(Number.isFinite(Date.parse(snapshot.meta.producedAt)));
  for (const entry of snapshot.readiness) assert.equal(entry.dir, 'backend');

  assert.equal((await fetch(`${origin}${path}`, { headers: mcpHeaders })).status, 403);
  // Unknown bearer never becomes dashboard access.
  assert.equal((await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${'e'.repeat(64)}` } })).status, 401);

  // Name/env mapping mirrors environments/status: empty env and unknown env
  // both surface envNotFound; unknown workspace surfaces notFoundRegister.
  const emptyEnv = await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=%20`);
  assert.equal(emptyEnv.status, 400);
  assert.equal((await emptyEnv.json() as { error: string }).error, environmentMessages.envNotFound);
  const missingEnv = await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=nope`);
  assert.equal(missingEnv.status, 400);
  assert.equal((await missingEnv.json() as { error: string }).error, environmentMessages.envNotFound);
  const missingWorkspace = await fetch(`${origin}/api/workspaces/Nope/coordinator?environment=dev`);
  assert.equal(missingWorkspace.status, 400);
  assert.equal((await missingWorkspace.json() as { error: string }).error, verifyMessages.notFoundRegister);
});

test('down environment is in sync with a passing preflight; drifted env lists expected/actual + missing', async t => {
  const f = await fixture(t);
  const port = await freeListener(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [
      { id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'web', repositoryPath: f.backend, scriptName: 'dev', port, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  // (a) Stopped environment: nothing owned, nothing expected running.
  const sync = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean; drifts: unknown[] };
    preflight: { pass: boolean; missing: string[] };
  };
  assert.equal(sync.reconcile.inSync, true);
  assert.deepEqual(sync.reconcile.drifts, []);
  // The preflight sees the occupied test listener on the declared port.
  assert.equal(sync.preflight.pass, false);
  assert.equal(sync.preflight.missing.length, 1);
  assert.ok(sync.preflight.missing[0].includes(String(port)));

  // (b) Mark the env up with a failed owned entry: both services drift.
  await f.store.update(state => {
    const record = state.environments.flatMap(entry => entry.items).find(item => item.name === 'dev');
    assert.ok(record);
    record.state = 'up';
    record.owned = [{
      serviceId: 'api',
      pmId: 99,
      name: 'api',
      namespace: null,
      expectedRoot: f.backend,
      lastPoll: { status: 'failed', attempts: 1, httpStatus: null, checkedAt: new Date().toISOString() },
    }];
  });
  const drifted = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean; drifts: Array<{ service: string; field: string; expected: string; actual: string }> };
  };
  assert.equal(drifted.reconcile.inSync, false);
  assert.equal(drifted.reconcile.drifts.length, 2);
  for (const drift of drifted.reconcile.drifts) {
    assert.ok(drift.service.length > 0 && drift.field.length > 0);
    assert.ok(drift.expected.length > 0 && drift.actual.length > 0);
  }
  const wire = JSON.stringify(drifted);
  assert.ok(!wire.includes(f.backend), 'absolute root path must never reach the wire');
});

test('viewing the coordinator never records activity', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const before = await f.service.recentActivity();
  assert.equal((await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).status, 200);
  assert.deepEqual(await f.service.recentActivity(), before);
});

test('wire sentinel: hostile free text is masked, cwd collapses to basename', () => {
  const record = {
    name: 'dev',
    state: 'up',
    services: [{
      id: 'api',
      name: 'api',
      repositoryPath: '/Users/x/proj/api',
      scriptName: 'dev',
      port: null,
      dependsOn: [],
      readiness: { kind: 'process-alive' as const },
    }],
  } as unknown as EnvironmentRecord;
  const hostileDetail = 'token=hunter2 --password hunter2 Bearer abcdef123456 sk-live-abcdef123456 note=abcdef0123456789abcdef0123456789';
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: {
      environmentId: 'env', name: 'dev', state: 'up', order: ['api'],
      services: [{
        serviceId: 'api', name: 'api', status: 'failed', detail: hostileDetail,
        owned: { serviceId: 'api', pmId: 99, name: 'api', namespace: null, expectedRoot: '/Users/x/proj/api', lastPoll: null },
      }],
    },
    portOccupied: new Map(),
    freeSuggestion: new Map(),
    checkpointWarnings: ['note: password=hunter2'],
    producedAt: '2026-10-09T12:00:00.000Z',
    snapshotId: 'a3f9c1d2',
  });
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'), 'secret value must not reach the wire');
  assert.ok(!wire.includes('sk-live-abcdef123456'));
  assert.ok(!wire.includes('abcdef0123456789abcdef0123456789'));
  assert.ok(!wire.includes('/Users/x/proj/api'), 'absolute path must not reach the wire');
  assert.ok(wire.includes('***'), 'masking must be visible');
  assert.equal(snapshot.readiness[0].dir, 'api');
  assert.equal(snapshot.meta.snapshotId, 'a3f9c1d2');
  assert.ok(maskSecrets('plain status text').includes('plain'));
});

test('oversized/corrupt checkpoint fixture keeps the section alive with warnings', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const dir = join(f.root, '.ow', 'checkpoints');
  await mkdir(dir, { recursive: true });
  // 600 valid lines (>500 cap) + corrupt lines + a symlink trap.
  const valid = JSON.stringify({ stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T12:00:00.000Z', by: 'runner' });
  const lines = ['not json{{{', '{"stage":', ...Array.from({ length: 600 }, () => valid)].join('\n');
  await writeFile(join(dir, 'big.jsonl'), lines);
  await symlink(join(dir, 'big.jsonl'), join(dir, 'trap.jsonl'));
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const response = await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as {
    reconcile: { inSync: boolean }; warnings: string[]; meta: { snapshotId: string };
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.ok(snapshot.warnings.some(warning => warning.includes('kırpıldı')), `expected a trim warning, got ${JSON.stringify(snapshot.warnings)}`);
  assert.ok(snapshot.warnings.some(warning => warning.includes('bozuk satır')), `expected a corrupt-line warning, got ${JSON.stringify(snapshot.warnings)}`);
  assert.ok(snapshot.warnings.some(warning => warning.includes('symlink')), `expected a symlink warning, got ${JSON.stringify(snapshot.warnings)}`);
});
