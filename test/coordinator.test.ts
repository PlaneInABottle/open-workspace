// D1 coordinator: dashboard-only aggregate (P1 reconcile + P2 preflight).
// Role gate (MCP 403), wire secret discipline (hunter2 sentinel), runner-file
// bounds (cap/corrupt fail-closed + warnings), error mapping, no activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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
    checkpoint: { run: 'demo', envelopes: [hostileOut.envelope], runs: ['demo'] },
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
    checkpoint: { run: 'demo', envelopes: [first.envelope, second.envelope], runs: ['demo'] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Basename aynı ("api") ama tam-yol farklı → fail-open kapandı.
  assert.equal(snapshot.checkpoints?.stages[1].status, 'stale');
  assert.equal(snapshot.checkpoints?.stages[1].staleReason, 'runtime');
  const same = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'demo', envelopes: [first.envelope, third.envelope], runs: ['demo'] },
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
  // changed-rev confirmed (→ stale script_hash: M-B kod-harita uyuşmazlığı), then a hostile gap.
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
  assert.equal(snapshot.checkpoints.stages[2].staleReason, 'script_hash');
  assert.equal(snapshot.checkpoints.lastVerified?.stage, 'test');
  // first_gap = son confirmed sonrasındaki ilk non-confirmed (stale build).
  assert.equal(snapshot.checkpoints.firstGap?.stage, 'build');
  assert.equal(snapshot.checkpoints.firstGap?.staleReason, 'script_hash');
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

test('D3 scenarios aggregate: matrix verdicts, masked, argv never on wire', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'web', name: 'web', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  await mkdir(join(f.root, '.ow', 'checkpoints'), { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  await writeFile(join(f.root, '.ow', 'checkpoints', 'demo.jsonl'), [
    line({ stage: 'onay', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: 'r1' } }),
    line({ stage: 'dagitim', status: 'stale', stale_reason: 'runtime', proof: 'ok', at: '2026-10-09T11:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: 'r1' } }),
  ].join('\n'));
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  sepet:',
    '    services: [api]',
    '    boundaries: [local, test]',
    '    targets: [http://x/token=hunter2]',
    '    probes: [{id: hazir, argv: [./x.sh, --token, hunter2]}]',
    '    checkpoints: [onay]',
    '  odeme:',
    '    services: [api, yabanci]',
    '    boundaries: [real, uydurma-sinir]',
    '    probes: [{id: saglik, argv: [./y.sh], timeout: 5s}]',
    '    checkpoints: [dagitim, yok-stage]',
    '',
  ].join('\n'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean };
    scenarios: {
      file: string; columns: string[];
      rows: Array<{
        name: string; services: string[]; unverifiedServices: string[];
        probes: Array<{ id: string; timeout: string }>; checkpoints: string[];
        cells: Record<string, string>;
      }>;
      warnings: string[]; error: string | null;
    } | null;
    warnings: string[];
  };
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'), 'hostile target/argv must not reach the wire');
  assert.ok(!wire.includes('--token'), 'probe argv must not reach the wire');
  assert.ok(!wire.includes('./x.sh'), 'probe argv must not reach the wire');
  assert.ok(!wire.includes('http://x/'), 'targets must not reach the wire');
  assert.ok(snapshot.reconcile.inSync, 'other panels stay alive');

  assert.ok(snapshot.scenarios);
  assert.equal(snapshot.scenarios.file, 'ow.scenarios.yaml');
  assert.equal(snapshot.scenarios.error, null);
  assert.deepEqual(snapshot.scenarios.columns, ['real', 'local', 'test', 'uydurma-sinir']);
  const sepet = snapshot.scenarios.rows.find(row => row.name === 'sepet');
  assert.ok(sepet);
  assert.deepEqual(sepet.probes, [{ id: 'hazir', timeout: '10s' }]);
  assert.deepEqual(sepet.unverifiedServices, []);
  assert.equal(sepet.cells['local'], 'pass');
  assert.equal(sepet.cells['test'], 'pass');
  assert.equal(sepet.cells['real'], 'uncovered');
  const odeme = snapshot.scenarios.rows.find(row => row.name === 'odeme');
  assert.ok(odeme);
  assert.deepEqual(odeme.unverifiedServices, ['yabanci']);
  assert.equal(odeme.cells['real'], 'stale');
  assert.equal(odeme.cells['uydurma-sinir'], 'unverified');
  assert.equal(odeme.cells['local'], 'uncovered');
});

test('D3 scenarios empty: no file keeps the section alive with null', async t => {
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
    reconcile: { inSync: boolean }; scenarios: null; warnings: string[];
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.equal(snapshot.scenarios, null);
});

test('D3 scenarios corrupt: error box payload, other panels alive', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  await writeFile(join(f.root, 'ow.scenarios.yaml'), 'version: 1\nscenarios:\n  - blok liste yasak\n');
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean };
    scenarios: { file: string; columns: string[]; rows: unknown[]; warnings: string[]; error: string | null } | null;
    warnings: string[];
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.ok(snapshot.scenarios);
  assert.equal(snapshot.scenarios.rows.length, 0);
  assert.ok(snapshot.scenarios.error && snapshot.scenarios.error.length > 0);
  assert.ok(snapshot.warnings.some(warning => warning.includes('senaryo bozuk')), `expected a scenarios-corrupt warning, got ${JSON.stringify(snapshot.warnings)}`);
});

test('D3 ?run=: explicit selection, fallback with warning, runs list', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const dir = join(f.root, '.ow', 'checkpoints');
  await mkdir(dir, { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  await writeFile(join(dir, 'eski.jsonl'), line({ stage: 'kur', status: 'confirmed', proof: 'ok', at: '2026-10-08T10:00:00.000Z', by: 'runner', code: { script_hash: 's0' } }));
  await writeFile(join(dir, 'yeni.jsonl'), line({ stage: 'kos', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1' } }));
  // mtime sırası deterministik: eski dosya bilerek geriye alınır.
  await utimes(join(dir, 'eski.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  type CheckpointWire = { run: string; runs: string[]; stages: Array<{ stage: string }> } | null;

  const latest = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(latest.checkpoints?.run, 'yeni');
  assert.deepEqual(latest.checkpoints?.runs, ['yeni', 'eski']);

  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=eski`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(explicit.checkpoints?.run, 'eski');
  assert.equal(explicit.checkpoints?.stages[0].stage, 'kur');

  const bogus = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=../kacis`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(bogus.checkpoints?.run, 'yeni');
  assert.ok(bogus.warnings.some(warning => warning.includes('istenen çalışma geçersiz')), `expected an invalid-run warning, got ${JSON.stringify(bogus.warnings)}`);

  const missing = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=yok`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(missing.checkpoints?.run, 'yeni');
  assert.ok(missing.warnings.some(warning => warning.includes('istenen çalışma yok')), `expected a missing-run warning, got ${JSON.stringify(missing.warnings)}`);
});

test('D3 empty newest run warns and shows older content; single empty file stays null with warning', async t => {
  const f = await fixture(t);
  const other = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-coordinator-other-')));
  t.after(() => rm(other, { recursive: true, force: true }));
  await f.service.register('Coord', [f.root, other]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const dir = join(f.root, '.ow', 'checkpoints');
  const otherDir = join(other, '.ow', 'checkpoints');
  await mkdir(dir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  await writeFile(join(otherDir, 'eski.jsonl'), JSON.stringify({ stage: 'kur', status: 'confirmed', proof: 'ok', at: '2026-10-08T10:00:00.000Z', by: 'runner', code: { script_hash: 's0' } }));
  await writeFile(join(dir, 'yeni.jsonl'), '');
  await utimes(join(otherDir, 'eski.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    checkpoints: { run: string; runs: string[] } | null; runs: string[]; warnings: string[];
  };
  assert.equal(snapshot.checkpoints?.run, 'eski');
  assert.deepEqual(snapshot.runs, ['yeni', 'eski']);
  assert.ok(snapshot.warnings.some(warning => warning.includes('checkpoint boş: yeni')), `expected an empty-newest warning, got ${JSON.stringify(snapshot.warnings)}`);

  // Tek boş dosya: bölüm null kalır (D1 davranışı) + sepet satırı düşer —
  // ama üst-düzey runs listesi seçiciyi besler.
  await rm(join(otherDir, 'eski.jsonl'));
  const single = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    checkpoints: unknown; runs: string[]; warnings: string[];
  };
  assert.equal(single.checkpoints, null);
  assert.deepEqual(single.runs, ['yeni']);
  assert.ok(single.warnings.some(warning => warning.includes('checkpoint boş: yeni')), `expected an empty-file warning, got ${JSON.stringify(single.warnings)}`);

  // Açık boş-run isteği: null + runs listesi (seçici kaybolmaz).
  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=yeni`)).json() as {
    checkpoints: unknown; runs: string[]; warnings: string[];
  };
  assert.equal(explicit.checkpoints, null);
  assert.deepEqual(explicit.runs, ['yeni']);
});

test('D3 same run name in two roots: newest-wins for ?run= and default, runs deduped', async t => {
  const f = await fixture(t);
  const other = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-coordinator-other-')));
  t.after(() => rm(other, { recursive: true, force: true }));
  await f.service.register('Coord', [f.root, other]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const dirA = join(f.root, '.ow', 'checkpoints');
  const dirB = join(other, '.ow', 'checkpoints');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const envelope = (stage: string, at: string) => JSON.stringify({ stage, status: 'confirmed', proof: 'ok', at, by: 'runner', code: { script_hash: 's0' } });
  await writeFile(join(dirA, 'demo.jsonl'), envelope('a-icerik', '2026-10-08T10:00:00.000Z'));
  await writeFile(join(dirB, 'demo.jsonl'), envelope('b-icerik', '2026-10-09T10:00:00.000Z'));
  await utimes(join(dirA, 'demo.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  type CheckpointWire = { run: string; runs: string[]; stages: Array<{ stage: string }> } | null;

  // Aynı ad iki kökte: açık istek ve default-latest YENİ içeriği vurur, ad tek listelenir.
  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=demo`)).json() as { checkpoints: CheckpointWire; runs: string[] };
  assert.equal(explicit.checkpoints?.run, 'demo');
  assert.equal(explicit.checkpoints?.stages[0].stage, 'b-icerik');
  const latest = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; runs: string[]; warnings: string[] };
  assert.equal(latest.checkpoints?.run, 'demo');
  assert.equal(latest.checkpoints?.stages[0].stage, 'b-icerik');
  assert.deepEqual(latest.runs, ['demo']);

  // Yeni dosya boşalırsa: default eski İÇERİĞE düşer + uyarı; açık istek fail-closed null kalır.
  await writeFile(join(dirB, 'demo.jsonl'), '');
  const fallback = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; runs: string[]; warnings: string[] };
  assert.equal(fallback.checkpoints?.run, 'demo');
  assert.equal(fallback.checkpoints?.stages[0].stage, 'a-icerik');
  assert.ok(fallback.warnings.some(warning => warning.includes('checkpoint boş: demo')), `expected an empty-newest warning, got ${JSON.stringify(fallback.warnings)}`);
  const explicitEmpty = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=demo`)).json() as { checkpoints: CheckpointWire; runs: string[] };
  assert.equal(explicitEmpty.checkpoints, null);
  assert.deepEqual(explicitEmpty.runs, ['demo']);
});

test('M-A side_effect/lineage mirror: normalize lockstep, hostile corrupt, freshness ignores', () => {
  const base = { stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner' };
  const good = normalizeCheckpointEnvelope({
    ...base, side_effect: 'attempted', side_effect_counts: { attempted: 2 },
    scenario: 'gece', attempt: 2, step_signature: 'test-imza',
  });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.envelope.sideEffect, 'attempted');
  assert.deepEqual(good.envelope.sideEffectCounts, { attempted: 2 });
  assert.equal(good.envelope.scenario, 'gece');
  assert.equal(good.envelope.attempt, 2);
  assert.equal(good.envelope.stepSignature, 'test-imza');
  // Eksik alanlar geçer (tel aynası: null/s tanımsız, render bilinmiyor).
  const bare = normalizeCheckpointEnvelope(base);
  assert.equal(bare.ok, true);
  if (!bare.ok) return;
  assert.equal(bare.envelope.sideEffect, null);
  // Hostile: CLI ile aynı fail-closed kümesi.
  const bad: unknown[] = [
    { ...base, side_effect: 'maybe' },
    { ...base, side_effect: 42 },
    { ...base, side_effect_counts: { attempted: 1000000 } },
    { ...base, side_effect_counts: { confirmed: -1 } },
    { ...base, side_effect_counts: { attempted: 1.5 } },
    { ...base, scenario: '../kacis' },
    { ...base, scenario: '' },
    { ...base, attempt: 0 },
    { ...base, attempt: 1000 },
    { ...base, step_signature: '' },
    { ...base, step_signature: 'x'.repeat(129) },
  ];
  for (const raw of bad) assert.equal(normalizeCheckpointEnvelope(raw).ok, false);
});

test('M-A P3 mirror: stage flags + retryHint, freshness ignores new fields', () => {
  const mk = (raw: Record<string, unknown>) => normalizeCheckpointEnvelope({
    stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner',
    code: { script_hash: 's1', checkout_rev: 'r1' }, runtime: { port: 1, cwd: '/r' }, ...raw,
  });
  const first = mk({ side_effect: 'attempted', scenario: 'gece', attempt: 1 });
  const second = mk({ at: '2026-10-09T11:00:00.000Z', side_effect: 'attempted', scenario: 'gece', attempt: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'gece-attempt2', envelopes: [first.envelope, second.envelope], runs: ['gece-attempt2'] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Tazelik yeni alanları yoksayar: iki zarf da confirmed kalır.
  assert.equal(snapshot.checkpoints?.stages[1].status, 'confirmed');
  assert.equal(snapshot.checkpoints?.stages[0].sideEffect, 'attempted');
  assert.equal(snapshot.checkpoints?.stages[1].scenario, 'gece');
  assert.equal(snapshot.checkpoints?.stages[1].attempt, 2);
  // Doğrulanmamış deneme → retry ipucu bayrağı.
  assert.equal(snapshot.checkpoints?.retryHint, true);
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'));
});

test('M-B code map mirror: 4 slots, legacy alias, conflict corrupt, freshness code-map mismatch', () => {
  const base = { stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', runtime: { port: 1, cwd: '/r' } };
  const full = normalizeCheckpointEnvelope({ ...base, code: { runner: 'r1', fixture: 'f1', body: 's1', provider_contract: 'pc1' } });
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.equal(full.envelope.checkoutRev, 'r1');
  assert.equal(full.envelope.fixture, 'f1');
  assert.equal(full.envelope.scriptHash, 's1');
  assert.equal(full.envelope.providerContract, 'pc1');
  // Legacy eşdeğer aynı slotlara eşlenir.
  const legacy = normalizeCheckpointEnvelope({ ...base, code: { script_hash: 's1', checkout_rev: 'r1' } });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(legacy.envelope.scriptHash, 's1');
  assert.equal(legacy.envelope.checkoutRev, 'r1');
  // Çakışma + disiplinsiz slot → corrupt (fail-closed).
  const bad: unknown[] = [
    { ...base, code: { script_hash: 's1', body: 's1' } },
    { ...base, code: { checkout_rev: 'r1', runner: 'r1' } },
    { ...base, code: { body: 'x'.repeat(65) } },
    { ...base, code: { runner: '' } },
    { ...base, code: { fixture: 42 } },
    { ...base, code: { bilinmeyen: 1 } },
  ];
  for (const raw of bad) assert.equal(normalizeCheckpointEnvelope(raw).ok, false);
  // Gizli-şekilli slot fail-safe maskelenir.
  const masked = normalizeCheckpointEnvelope({ ...base, code: { body: 'token=hunter2-abcdef1234' } });
  assert.equal(masked.ok, true);
  if (!masked.ok) return;
  assert.equal(masked.envelope.scriptHash, '***');
});

test('M-B P3 freshness: legacy-stable, mixed old/new single divergence, all-absent missing_basis', () => {
  const mk = (raw: Record<string, unknown>) => normalizeCheckpointEnvelope({
    stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner',
    code: { script_hash: 's1', checkout_rev: 'r1' }, runtime: { port: 1, cwd: '/r' }, ...raw,
  });
  const basis = mk({});
  const sameNewNames = mk({ at: '2026-10-09T11:00:00.000Z', code: { runner: 'r1', body: 's1' } });
  const diverged = mk({ at: '2026-10-09T12:00:00.000Z', code: { runner: 'r1', fixture: 'f1', body: 's2', provider_contract: 'pc1' } });
  assert.equal(basis.ok, true);
  assert.equal(sameNewNames.ok, true);
  assert.equal(diverged.ok, true);
  if (!basis.ok || !sameNewNames.ok || !diverged.ok) return;
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'harita', envelopes: [basis.envelope, sameNewNames.envelope, diverged.envelope], runs: ['harita'] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Legacy-yeni aynı değer kararlı; ilk sapmada tek script_hash-bayat.
  assert.deepEqual(snapshot.checkpoints?.stages.map(stage => stage.status), ['confirmed', 'confirmed', 'stale']);
  assert.equal(snapshot.checkpoints?.stages[2].staleReason, 'script_hash');
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'));
});

test('M-C P4 artifacts: recorded map reduced basename+short8, full path/digest never on wire', () => {
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: null,
    supervisor: [{
      name: 'api',
      artifactDigests: {
        'api.jar': 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        'token=hunter2.jar': 'ffffffffffffffffffffffffffffffffffffffff',
      },
    }],
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  const entry = snapshot.explanation?.entries.find(item => item.service === 'api');
  assert.ok(entry);
  assert.deepEqual(entry.artifacts, [
    { base: 'api.jar', digest: 'a1b2c3d4' },
    { base: 'token=***', digest: 'ffffffff' },
  ]);
  assert.equal(entry.artifactRest, 0);
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'), 'full digest must not reach the wire');
  assert.ok(!wire.includes('hunter2'), 'hostile basename must not reach the wire');
});

test('M-C supervisor record: hostile artifact map shape-strict, invalid entries dropped', () => {
  const rec = normalizeSupervisorService({
    name: 'api',
    artifactDigests: {
      'api.jar': 'a1b2c3d4e5',
      '../kacis': 'a1b2c3d4e5',
      'kisa': 'zz',
      'sayi': 42,
      '': 'a1b2c3d4e5',
    },
  });
  assert.ok(rec);
  assert.deepEqual(rec?.artifactDigests, { 'api.jar': 'a1b2c3d4e5' });
  const badMap = normalizeSupervisorService({ name: 'api', artifactDigests: ['x'] });
  assert.ok(badMap);
  assert.equal(badMap?.artifactDigests, undefined);
});
