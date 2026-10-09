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
import { buildCoordinatorSnapshot, maskSecrets, normalizeCheckpointEnvelope, normalizeSupervisorService } from '../src/coordinator.js';
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

test('D2 hostile rev: secret-shaped revs mask to ***, legit shapes pass through', () => {
  const envelopeWith = (rev: unknown) => normalizeCheckpointEnvelope({
    stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner',
    code: { script_hash: 's1', checkout_rev: rev }, runtime: { port: 1, cwd: '/r' },
  });
  // Hostile: zarf geçerli kalır (fail-safe) ama rev maskelenir.
  for (const rev of ['token=hunter2-abcdef1234', 'api_key=hunter2', 'Bearer abcdef', 'sk-live-abc123', '--token hunter2']) {
    const out = envelopeWith(rev);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.envelope.checkoutRev, '***');
  }
  // Meşru gerçek şekiller aynen geçer (hex SHA incl. 40-hex, kısa id'ler).
  for (const rev of ['a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4', 'a1b2c3d', 'rev1', 'abc123', 'r1', 'YENI']) {
    const out = envelopeWith(rev);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.envelope.checkoutRev, rev);
  }
  // Supervisor rev yolu da aynı maskeden geçer.
  const rec = normalizeSupervisorService({
    name: 'api', provenance: { checkout: { rev: 'token=hunter2-abcdef' }, recordedAt: '2026-10-09T09:00:00.000Z' },
  });
  assert.ok(rec);
  assert.equal(rec.rev, '***');
  // Wire: maskeli rev *** olarak taşınır, hunter2 hiçbir yerde yok.
  const hostileOut = envelopeWith('token=hunter2-abcdef1234');
  assert.equal(hostileOut.ok, true);
  if (!hostileOut.ok || !rec) return;
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'demo', envelopes: [hostileOut.envelope] },
    supervisor: [rec],
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'), 'hostile rev must not reach the wire');
  assert.equal(snapshot.checkpoints?.stages[0].status, 'confirmed');
  assert.equal(snapshot.explanation?.entries[0].revFull, '***');
  assert.equal(snapshot.explanation?.entries[0].revShort, '***');
  assert.equal(snapshot.explanation?.revisions[0].full, '***');
});

test('D2 cwd compare: same basename on different full paths goes stale/runtime', () => {
  const mk = (at: string, cwd: string) => normalizeCheckpointEnvelope({
    stage: 'build', status: 'confirmed', proof: 'ok', at, by: 'runner',
    code: { script_hash: 's1', checkout_rev: 'r1' }, runtime: { port: 1, cwd },
  });
  const first = mk('2026-10-09T10:00:00.000Z', '/a/api');
  const second = mk('2026-10-09T11:00:00.000Z', '/b/api');
  const third = mk('2026-10-09T12:00:00.000Z', '/a/api');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  if (!first.ok || !second.ok || !third.ok) return;
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'demo', envelopes: [first.envelope, second.envelope] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Basename aynı ("api") ama tam-yol farklı → fail-open kapandı.
  assert.equal(snapshot.checkpoints?.stages[1].status, 'stale');
  assert.equal(snapshot.checkpoints?.stages[1].staleReason, 'runtime');
  const same = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'demo', envelopes: [first.envelope, third.envelope] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  assert.equal(same.checkpoints?.stages[1].status, 'confirmed');
});

test('D2 checkpoints+explanation: latest run aggregate, masked, basename-only, rev short/full split', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: 3100, dependsOn: [], readiness: { kind: 'http-200' } },
      { id: 'ghost', name: 'ghost', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'sahipsiz', name: 'sahipsiz', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  // Latest-run checkpoint file: basis confirmed, same-basis confirmed,
  // changed-rev confirmed (→ stale checkout_rev), then a hostile gap.
  const revA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  const revB = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';
  const dir = join(f.root, '.ow', 'checkpoints');
  await mkdir(dir, { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  await writeFile(join(dir, 'demo.jsonl'), [
    line({ stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revA }, runtime: { port: 3100, cwd: '/Users/x/proj/api' } }),
    line({ stage: 'test', status: 'confirmed', proof: 'ok', at: '2026-10-09T11:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revA }, runtime: { port: 3100, cwd: '/Users/x/proj/api' } }),
    line({ stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T12:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revB }, runtime: { port: 3100, cwd: '/Users/x/proj/api' }, safe_next_action: 'token=hunter2 --password hunter2 çalıştır' }),
    line({ stage: 'deploy', status: 'not_observed', proof: 'yok', at: '2026-10-09T12:30:00.000Z', by: 'ow-probe' }),
    'bozuk-satır{{{',
  ].join('\n'));
  // Supervisor spawn-kayıtları: api kayıtlı rev'li, ghost kayıtsız.
  await writeFile(join(f.root, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1,
    startedAt: '2026-10-09T09:00:00.000Z',
    services: [
      {
        name: 'api', port: 3100,
        provenance: { cwdAbs: '/Users/x/proj/api', checkout: { rev: revA, dirty: true }, recordedAt: '2026-10-09T09:30:00.000Z' },
        lastReadiness: { ok: true, note: 'token=hunter2', at: '2026-10-09T11:30:00.000Z' },
      },
      { name: 'ghost' },
    ],
  }));
  // Canlı durum: api failed kayıtlı, ghost ölçülmedi.
  await f.store.update(state => {
    const record = state.environments.flatMap(entry => entry.items).find(item => item.name === 'dev');
    assert.ok(record);
    record.state = 'up';
    record.owned = [{
      serviceId: 'api', pmId: 99, name: 'api', namespace: null, expectedRoot: f.backend,
      lastPoll: { status: 'failed', attempts: 1, httpStatus: null, checkedAt: new Date().toISOString() },
    }];
  });
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const response = await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as {
    checkpoints: {
      run: string;
      stages: Array<{ stage: string; status: string; staleReason: string | null; at: string }>;
      summary: { confirmed: number; stale: number; notObserved: number };
      lastVerified: { stage: string; at: string } | null;
      firstGap: { stage: string; status: string; staleReason: string | null; at: string } | null;
      safeNextAction: string | null;
    } | null;
    explanation: {
      entries: Array<{
        service: string; expected: { cmd: string | null; dir: string | null; port: number | null } | null;
        running: { status: string; detail: string } | null;
        revShort: string | null; revFull: string | null; revAt: string | null; revDirty: boolean; revRecorded: boolean;
        diffs: string[]; note: string;
      }>;
      revisions: Array<{ short: string; full: string; at: string | null; current: boolean; recorded: boolean }>;
    } | null;
    warnings: string[];
  };
  const wire = JSON.stringify(snapshot);
  // Secret disiplini: hostile serbest-metin + mutlak path wire'da yok.
  assert.ok(!wire.includes('hunter2'), 'secret value must not reach the wire');
  assert.ok(!wire.includes('/Users/x/proj/api'), 'absolute path must not reach the wire');
  assert.ok(wire.includes('***'), 'masking must be visible');

  // P3: tazelik uygulanmış aggregate.
  assert.ok(snapshot.checkpoints);
  assert.equal(snapshot.checkpoints.run, 'demo');
  assert.equal(snapshot.checkpoints.stages.length, 4);
  assert.deepEqual(snapshot.checkpoints.summary, { confirmed: 2, stale: 1, notObserved: 1 });
  assert.equal(snapshot.checkpoints.stages[2].status, 'stale');
  assert.equal(snapshot.checkpoints.stages[2].staleReason, 'checkout_rev');
  assert.equal(snapshot.checkpoints.lastVerified?.stage, 'test');
  // first_gap = son confirmed sonrasındaki ilk non-confirmed (stale build).
  assert.equal(snapshot.checkpoints.firstGap?.stage, 'build');
  assert.equal(snapshot.checkpoints.firstGap?.staleReason, 'checkout_rev');
  assert.ok(snapshot.checkpoints.safeNextAction && !snapshot.checkpoints.safeNextAction.includes('hunter2'));
  assert.ok(snapshot.checkpoints.safeNextAction.includes('***'));
  assert.ok(snapshot.warnings.some(warning => warning.includes('bozuk satır')), `expected a corrupt-line warning, got ${JSON.stringify(snapshot.warnings)}`);

  // P4: beklenen/çalışan + rev short/full ayrımı.
  assert.ok(snapshot.explanation);
  const api = snapshot.explanation.entries.find(entry => entry.service === 'api');
  assert.ok(api);
  assert.equal(api.expected?.dir, 'backend');
  // PM2 yokluğunda kayıtlı sahiplik canlı listeyle eşleşemez: çalışan
  // "down + ölçülmedi" düşer (D1 drift-emsaliyle aynı zemin).
  assert.equal(api.running?.status, 'down');
  assert.equal(api.revShort, revA.slice(0, 7));
  assert.equal(api.revFull, revA);
  assert.equal(api.revRecorded, true);
  assert.equal(api.revDirty, true);
  assert.ok(api.diffs.some(diff => diff.includes('kirli checkout')));
  const ghost = snapshot.explanation.entries.find(entry => entry.service === 'ghost');
  assert.ok(ghost);
  // Boş supervisor kaydı: rev yok → doğrulanamadı, note canlılığı anlatır.
  assert.equal(ghost.revShort, null);
  assert.equal(ghost.revRecorded, false);
  const sahipsiz = snapshot.explanation.entries.find(entry => entry.service === 'sahipsiz');
  assert.ok(sahipsiz);
  assert.ok(sahipsiz.expected);
  assert.ok(sahipsiz.note.includes('kayıt yok'));
  // Rev şeridi: kayıtsız zarf rev'i de taşınır (soluk), en yeni seçili.
  const stripB = snapshot.explanation.revisions.find(revision => revision.full === revB);
  assert.ok(stripB);
  assert.equal(stripB.recorded, false);
  assert.equal(stripB.short, revB.slice(0, 7));
  const current = snapshot.explanation.revisions.filter(revision => revision.current);
  assert.equal(current.length, 1);
  // Tam rev wire'da taşınır (kopyala-butonu clipboard payload'ı) — DOM'a
  // yazılmaması frontend tara-testinin işidir.
  assert.ok(wire.includes(revA));
});

test('D2 empty: no runner files keeps the section alive with empty panels', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean }; checkpoints: null; explanation: null; warnings: string[];
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.equal(snapshot.checkpoints, null);
  assert.equal(snapshot.explanation, null);
});

test('D2 corrupt supervisor keeps the section alive with a warning', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'supervisor.json'), 'bozuk{{{');
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean }; explanation: null; warnings: string[];
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.equal(snapshot.explanation, null);
  assert.ok(snapshot.warnings.some(warning => warning.includes('provenance okunamadı')), `expected a provenance warning, got ${JSON.stringify(snapshot.warnings)}`);
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
