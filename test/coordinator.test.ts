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
import { buildCoordinatorSnapshot, buildWorktreeAdvisories, maskSecrets, normalizeCheckpointEnvelope, normalizeSupervisorService, readScenariosSource, readWorktreeLedger } from '../src/coordinator.js';
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
  // Hostile: the envelope stays valid (fail-safe) but the rev is masked.
  for (const rev of ['token=hunter2-abcdef1234', 'api_key=hunter2', 'Bearer abcdef', 'sk-live-abc123', '--token hunter2']) {
    const out = envelopeWith(rev);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.envelope.checkoutRev, '***');
  }
  // Legitimate real shapes pass as-is (hex SHA incl. 40-hex, short ids).
  for (const rev of ['a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4', 'a1b2c3d', 'rev1', 'abc123', 'r1', 'NEW']) {
    const out = envelopeWith(rev);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.envelope.checkoutRev, rev);
  }
  // The supervisor rev path goes through the same mask.
  const rec = normalizeSupervisorService({
    name: 'api', provenance: { checkout: { rev: 'token=hunter2-abcdef' }, recordedAt: '2026-10-09T09:00:00.000Z' },
  });
  assert.ok(rec);
  assert.equal(rec.rev, '***');
  // Wire: the masked rev is carried as ***, hunter2 appears nowhere.
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
  // Same basename ("api") but a different full path → fail-open closed.
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
      { id: 'orphan', name: 'orphan', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  // Latest-run checkpoint file: basis confirmed, same-basis confirmed,
  // changed-rev confirmed (→ stale script_hash: M-B code-map mismatch), then a hostile gap.
  const revA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  const revB = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';
  const dir = join(f.root, '.ow', 'checkpoints');
  await mkdir(dir, { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  await writeFile(join(dir, 'demo.jsonl'), [
    line({ stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revA }, runtime: { port: 3100, cwd: '/Users/x/proj/api' } }),
    line({ stage: 'test', status: 'confirmed', proof: 'ok', at: '2026-10-09T11:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revA }, runtime: { port: 3100, cwd: '/Users/x/proj/api' } }),
    line({ stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T12:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: revB }, runtime: { port: 3100, cwd: '/Users/x/proj/api' }, safe_next_action: 'token=hunter2 --password hunter2 run' }),
    line({ stage: 'deploy', status: 'not_observed', proof: 'none', at: '2026-10-09T12:30:00.000Z', by: 'ow-probe' }),
    'corrupt-line{{{',
  ].join('\n'));
  // Supervisor spawn records: api has a recorded rev, ghost does not.
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
  // Live status: api is recorded failed, ghost unmeasured.
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
  // Secret discipline: hostile free text + absolute path are absent from the wire.
  assert.ok(!wire.includes('hunter2'), 'secret value must not reach the wire');
  assert.ok(!wire.includes('/Users/x/proj/api'), 'absolute path must not reach the wire');
  assert.ok(wire.includes('***'), 'masking must be visible');

  // P3: freshness-applied aggregate.
  assert.ok(snapshot.checkpoints);
  assert.equal(snapshot.checkpoints.run, 'demo');
  assert.equal(snapshot.checkpoints.stages.length, 4);
  assert.deepEqual(snapshot.checkpoints.summary, { confirmed: 2, stale: 1, notObserved: 1 });
  assert.equal(snapshot.checkpoints.stages[2].status, 'stale');
  assert.equal(snapshot.checkpoints.stages[2].staleReason, 'script_hash');
  assert.equal(snapshot.checkpoints.lastVerified?.stage, 'test');
  // first_gap = the first non-confirmed after the last confirmed (stale build).
  assert.equal(snapshot.checkpoints.firstGap?.stage, 'build');
  assert.equal(snapshot.checkpoints.firstGap?.staleReason, 'script_hash');
  assert.ok(snapshot.checkpoints.safeNextAction && !snapshot.checkpoints.safeNextAction.includes('hunter2'));
  assert.ok(snapshot.checkpoints.safeNextAction.includes('***'));
  assert.ok(snapshot.warnings.some(warning => warning.includes('corrupt line')), `expected a corrupt-line warning, got ${JSON.stringify(snapshot.warnings)}`);

  // P4: expected/running + rev short/full distinction.
  assert.ok(snapshot.explanation);
  const api = snapshot.explanation.entries.find(entry => entry.service === 'api');
  assert.ok(api);
  assert.equal(api.expected?.dir, 'backend');
  // Without PM2 the recorded ownership cannot match the live list: running
  // drops to "down + unmeasured" (same basis as the D1 drift precedent).
  assert.equal(api.running?.status, 'down');
  assert.equal(api.revShort, revA.slice(0, 7));
  assert.equal(api.revFull, revA);
  assert.equal(api.revRecorded, true);
  assert.equal(api.revDirty, true);
  assert.ok(api.diffs.some(diff => diff.includes('dirty checkout')));
  const ghost = snapshot.explanation.entries.find(entry => entry.service === 'ghost');
  assert.ok(ghost);
  // Empty supervisor record: no rev → unverified, the note describes liveness.
  assert.equal(ghost.revShort, null);
  assert.equal(ghost.revRecorded, false);
  const orphan = snapshot.explanation.entries.find(entry => entry.service === 'orphan');
  assert.ok(orphan);
  assert.ok(orphan.expected);
  assert.ok(orphan.note.includes('no record'));
  // Rev strip: an unrecorded envelope rev is also carried (dim), the newest is selected.
  const stripB = snapshot.explanation.revisions.find(revision => revision.full === revB);
  assert.ok(stripB);
  assert.equal(stripB.recorded, false);
  assert.equal(stripB.short, revB.slice(0, 7));
  const current = snapshot.explanation.revisions.filter(revision => revision.current);
  assert.equal(current.length, 1);
  // The full rev is carried on the wire (the copy button's clipboard payload) — not
  // writing it to the DOM is the frontend scan-test's job.
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
  await writeFile(join(f.root, '.ow', 'supervisor.json'), 'corrupt{{{');
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean }; explanation: null; warnings: string[];
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.equal(snapshot.explanation, null);
  assert.ok(snapshot.warnings.some(warning => warning.includes('provenance unreadable')), `expected a provenance warning, got ${JSON.stringify(snapshot.warnings)}`);
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
  assert.ok(snapshot.warnings.some(warning => warning.includes('truncated')), `expected a trim warning, got ${JSON.stringify(snapshot.warnings)}`);
  assert.ok(snapshot.warnings.some(warning => warning.includes('corrupt line')), `expected a corrupt-line warning, got ${JSON.stringify(snapshot.warnings)}`);
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
    line({ stage: 'approval', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: 'r1' } }),
    line({ stage: 'deploy', status: 'stale', stale_reason: 'runtime', proof: 'ok', at: '2026-10-09T11:00:00.000Z', by: 'runner', code: { script_hash: 's1', checkout_rev: 'r1' } }),
  ].join('\n'));
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  basket:',
    '    services: [api]',
    '    boundaries: [local, test]',
    '    targets: [http://x/token=hunter2]',
    '    probes: [{id: ready, argv: [./x.sh, --token, hunter2]}]',
    '    checkpoints: [approval]',
    '  payment:',
    '    services: [api, foreign]',
    '    boundaries: [real, fake-boundary]',
    '    probes: [{id: health, argv: [./y.sh], timeout: 5s}]',
    '    checkpoints: [deploy, missing-stage]',
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
  assert.deepEqual(snapshot.scenarios.columns, ['real-read-only', 'real-state-changing', 'unverified', 'fake-boundary']);
  const basket = snapshot.scenarios.rows.find(row => row.name === 'basket');
  assert.ok(basket);
  assert.deepEqual(basket.probes, [{ id: 'ready', timeout: '10s' }]);
  assert.deepEqual(basket.unverifiedServices, []);
  assert.equal(basket.cells['real-read-only'], 'pass');
  assert.equal(basket.cells['unverified'], 'pass');
  assert.equal(basket.cells['real-state-changing'], 'uncovered');
  const payment = snapshot.scenarios.rows.find(row => row.name === 'payment');
  assert.ok(payment);
  assert.deepEqual(payment.unverifiedServices, ['foreign']);
  assert.equal(payment.cells['real-state-changing'], 'stale');
  assert.equal(payment.cells['fake-boundary'], 'unverified');
  assert.equal(payment.cells['real-read-only'], 'uncovered');
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
  await writeFile(join(f.root, 'ow.scenarios.yaml'), 'version: 1\nscenarios:\n  - block list forbidden\n');
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
  assert.ok(snapshot.warnings.some(warning => warning.includes('scenario corrupt')), `expected a scenarios-corrupt warning, got ${JSON.stringify(snapshot.warnings)}`);
});

test('M11 serviceless row: explicit services [] renders with empty services cell', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  audit:',
    '    services: []',
    '    boundaries: [subscribed]',
    '    probes: [{id: envcheck, argv: [./scripts/env-audit.sh]}]',
    '    checkpoints: [env-audited]',
    '',
  ].join('\n'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    reconcile: { inSync: boolean };
    scenarios: {
      file: string; columns: string[];
      rows: Array<{ name: string; services: string[]; unverifiedServices: string[]; cells: Record<string, string> }>;
      warnings: string[]; error: string | null;
    } | null;
  };
  assert.equal(snapshot.reconcile.inSync, true);
  assert.ok(snapshot.scenarios);
  assert.equal(snapshot.scenarios.error, null);
  const audit = snapshot.scenarios.rows.find(row => row.name === 'audit');
  assert.ok(audit);
  assert.deepEqual(audit.services, []);
  assert.deepEqual(audit.unverifiedServices, []);
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
  await writeFile(join(dir, 'old.jsonl'), line({ stage: 'setup', status: 'confirmed', proof: 'ok', at: '2026-10-08T10:00:00.000Z', by: 'runner', code: { script_hash: 's0' } }));
  await writeFile(join(dir, 'new.jsonl'), line({ stage: 'run', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 's1' } }));
  // mtime order is deterministic: the old file is deliberately moved back.
  await utimes(join(dir, 'old.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  type CheckpointWire = { run: string; runs: string[]; stages: Array<{ stage: string }> } | null;

  const latest = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(latest.checkpoints?.run, 'new');
  assert.deepEqual(latest.checkpoints?.runs, ['new', 'old']);

  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=old`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(explicit.checkpoints?.run, 'old');
  assert.equal(explicit.checkpoints?.stages[0].stage, 'setup');

  const bogus = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=../escape`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(bogus.checkpoints?.run, 'new');
  assert.ok(bogus.warnings.some(warning => warning.includes('requested run invalid')), `expected an invalid-run warning, got ${JSON.stringify(bogus.warnings)}`);

  const missing = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=missing`)).json() as { checkpoints: CheckpointWire; warnings: string[] };
  assert.equal(missing.checkpoints?.run, 'new');
  assert.ok(missing.warnings.some(warning => warning.includes('requested run missing')), `expected a missing-run warning, got ${JSON.stringify(missing.warnings)}`);
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
  await writeFile(join(otherDir, 'old.jsonl'), JSON.stringify({ stage: 'setup', status: 'confirmed', proof: 'ok', at: '2026-10-08T10:00:00.000Z', by: 'runner', code: { script_hash: 's0' } }));
  await writeFile(join(dir, 'new.jsonl'), '');
  await utimes(join(otherDir, 'old.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    checkpoints: { run: string; runs: string[] } | null; runs: string[]; warnings: string[];
  };
  assert.equal(snapshot.checkpoints?.run, 'old');
  assert.deepEqual(snapshot.runs, ['new', 'old']);
  assert.ok(snapshot.warnings.some(warning => warning.includes('checkpoint empty: new')), `expected an empty-newest warning, got ${JSON.stringify(snapshot.warnings)}`);

  // A single empty file: the section stays null (D1 behavior) + a basket line drops —
  // but the top-level runs list feeds the selector.
  await rm(join(otherDir, 'old.jsonl'));
  const single = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    checkpoints: unknown; runs: string[]; warnings: string[];
  };
  assert.equal(single.checkpoints, null);
  assert.deepEqual(single.runs, ['new']);
  assert.ok(single.warnings.some(warning => warning.includes('checkpoint empty: new')), `expected an empty-file warning, got ${JSON.stringify(single.warnings)}`);

  // Explicit empty-run request: null + runs list (the selector does not disappear).
  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=new`)).json() as {
    checkpoints: unknown; runs: string[]; warnings: string[];
  };
  assert.equal(explicit.checkpoints, null);
  assert.deepEqual(explicit.runs, ['new']);
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
  await writeFile(join(dirA, 'demo.jsonl'), envelope('a-content', '2026-10-08T10:00:00.000Z'));
  await writeFile(join(dirB, 'demo.jsonl'), envelope('b-content', '2026-10-09T10:00:00.000Z'));
  await utimes(join(dirA, 'demo.jsonl'), new Date('2026-10-08T10:00:00.000Z'), new Date('2026-10-08T10:00:00.000Z'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  type CheckpointWire = { run: string; runs: string[]; stages: Array<{ stage: string }> } | null;

  // Same name in two roots: the explicit request and default-latest hit the NEW content, the name is listed once.
  const explicit = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=demo`)).json() as { checkpoints: CheckpointWire; runs: string[] };
  assert.equal(explicit.checkpoints?.run, 'demo');
  assert.equal(explicit.checkpoints?.stages[0].stage, 'b-content');
  const latest = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; runs: string[]; warnings: string[] };
  assert.equal(latest.checkpoints?.run, 'demo');
  assert.equal(latest.checkpoints?.stages[0].stage, 'b-content');
  assert.deepEqual(latest.runs, ['demo']);

  // If the new file empties: the default falls back to the OLD content + warning; the explicit request stays fail-closed null.
  await writeFile(join(dirB, 'demo.jsonl'), '');
  const fallback = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as { checkpoints: CheckpointWire; runs: string[]; warnings: string[] };
  assert.equal(fallback.checkpoints?.run, 'demo');
  assert.equal(fallback.checkpoints?.stages[0].stage, 'a-content');
  assert.ok(fallback.warnings.some(warning => warning.includes('checkpoint empty: demo')), `expected an empty-newest warning, got ${JSON.stringify(fallback.warnings)}`);
  const explicitEmpty = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev&run=demo`)).json() as { checkpoints: CheckpointWire; runs: string[] };
  assert.equal(explicitEmpty.checkpoints, null);
  assert.deepEqual(explicitEmpty.runs, ['demo']);
});

test('M-A side_effect/lineage mirror: normalize lockstep, hostile corrupt, freshness ignores', () => {
  const base = { stage: 'build', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner' };
  const good = normalizeCheckpointEnvelope({
    ...base, side_effect: 'attempted', side_effect_counts: { attempted: 2 },
    scenario: 'night', attempt: 2, step_signature: 'test-signature',
  });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.envelope.sideEffect, 'attempted');
  assert.deepEqual(good.envelope.sideEffectCounts, { attempted: 2 });
  assert.equal(good.envelope.scenario, 'night');
  assert.equal(good.envelope.attempt, 2);
  assert.equal(good.envelope.stepSignature, 'test-signature');
  // Missing fields pass (wire mirror: null/undefined, render unknown).
  const bare = normalizeCheckpointEnvelope(base);
  assert.equal(bare.ok, true);
  if (!bare.ok) return;
  assert.equal(bare.envelope.sideEffect, null);
  // Hostile: the same fail-closed set as the CLI.
  const bad: unknown[] = [
    { ...base, side_effect: 'maybe' },
    { ...base, side_effect: 42 },
    { ...base, side_effect_counts: { attempted: 1000000 } },
    { ...base, side_effect_counts: { confirmed: -1 } },
    { ...base, side_effect_counts: { attempted: 1.5 } },
    { ...base, scenario: '../escape' },
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
  const first = mk({ side_effect: 'attempted', scenario: 'night', attempt: 1 });
  const second = mk({ at: '2026-10-09T11:00:00.000Z', side_effect: 'attempted', scenario: 'night', attempt: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const record = { name: 'dev', state: 'down', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'down', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    checkpoint: { run: 'night-attempt2', envelopes: [first.envelope, second.envelope], runs: ['night-attempt2'] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Freshness ignores the new fields: both envelopes stay confirmed.
  assert.equal(snapshot.checkpoints?.stages[1].status, 'confirmed');
  assert.equal(snapshot.checkpoints?.stages[0].sideEffect, 'attempted');
  assert.equal(snapshot.checkpoints?.stages[1].scenario, 'night');
  assert.equal(snapshot.checkpoints?.stages[1].attempt, 2);
  // Attempted-unconfirmed → the retry-hint flag.
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
  // A legacy equivalent maps to the same slots.
  const legacy = normalizeCheckpointEnvelope({ ...base, code: { script_hash: 's1', checkout_rev: 'r1' } });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(legacy.envelope.scriptHash, 's1');
  assert.equal(legacy.envelope.checkoutRev, 'r1');
  // Conflict + undisciplined slot → corrupt (fail-closed).
  const bad: unknown[] = [
    { ...base, code: { script_hash: 's1', body: 's1' } },
    { ...base, code: { checkout_rev: 'r1', runner: 'r1' } },
    { ...base, code: { body: 'x'.repeat(65) } },
    { ...base, code: { runner: '' } },
    { ...base, code: { fixture: 42 } },
    { ...base, code: { unknown: 1 } },
  ];
  for (const raw of bad) assert.equal(normalizeCheckpointEnvelope(raw).ok, false);
  // A secret-shaped slot fails safe to masked.
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
    checkpoint: { run: 'map', envelopes: [basis.envelope, sameNewNames.envelope, diverged.envelope], runs: ['map'] },
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  // Legacy-new same value is stable; the first deviation stales a single script_hash.
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
      '../escape': 'a1b2c3d4e5',
      'short': 'zz',
      'number': 42,
      '': 'a1b2c3d4e5',
    },
  });
  assert.ok(rec);
  assert.deepEqual(rec?.artifactDigests, { 'api.jar': 'a1b2c3d4e5' });
  const badMap = normalizeSupervisorService({ name: 'api', artifactDigests: ['x'] });
  assert.ok(badMap);
  assert.equal(badMap?.artifactDigests, undefined);
});

test('M1 worktree identity: single-root snapshots carry no worktree/rootBase (NO-WORKTREE-NO-FRICTION)', async t => {
  const f = await fixture(t);
  await f.service.register('Coord', [f.root]);
  await f.service.environmentSet('Coord', {
    name: 'dev',
    services: [
      { id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/Coord/coordinator?environment=dev`)).json() as {
    readiness: Array<Record<string, unknown>>;
  };
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('worktree'), 'single-root wire must not mention worktree');
  assert.ok(!wire.includes('rootBase'), 'single-root wire must not mention rootBase');
  for (const entry of snapshot.readiness) assert.ok(!('worktree' in entry));
});

test('M1 worktree wire: map present → readiness carries rootBase + short-7, missing rev → null', () => {
  const record = {
    name: 'dev',
    state: 'up',
    services: [
      { id: 'api', name: 'api', repositoryPath: '/farm/wt-a', scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'web', name: 'web', repositoryPath: '/farm/wt-b', scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  } as unknown as EnvironmentRecord;
  const statusOf = (services: { serviceId: string; name: string }[]) => ({
    environmentId: 'env', name: 'dev', state: 'up' as const, order: services.map(s => s.serviceId),
    services: services.map(s => ({
      serviceId: s.serviceId, name: s.name, status: 'ready' as const, detail: 'ok',
      owned: { serviceId: s.serviceId, pmId: 1, name: s.name, namespace: null, expectedRoot: '/x', lastPoll: null },
    })),
  });
  const names = [{ serviceId: 'api', name: 'api' }, { serviceId: 'web', name: 'web' }];
  // Without the map: byte-identical to today (no worktree key at all).
  const bare = buildCoordinatorSnapshot({
    record,
    status: statusOf(names),
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  assert.ok(!JSON.stringify(bare).includes('worktree'));
  // With the map: basename + short-7; web has no rev → null (basename-only chip).
  const scoped = buildCoordinatorSnapshot({
    record,
    status: statusOf(names),
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    worktreeByService: new Map([
      ['api', { rootBase: 'wt-a', revShort: '0123456' }],
      ['web', { rootBase: 'wt-b', revShort: null }],
    ]),
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  assert.deepEqual(scoped.readiness.map(e => e.worktree), [
    { rootBase: 'wt-a', revShort: '0123456' },
    { rootBase: 'wt-b', revShort: null },
  ]);
  const wire = JSON.stringify(scoped);
  assert.ok(!wire.includes('/farm/wt-a'), 'absolute root must not reach the wire');
});

test('M1 supervisor record: rootBase basename only, hostile cmd masked on wire', () => {
  const rec = normalizeSupervisorService({ name: 'api', port: 3000, provenance: { checkout: { rev: '0123456789abcdef0123456789abcdef01234567' } } });
  assert.ok(rec);
  const record = { name: 'dev', state: 'up', services: [] } as unknown as EnvironmentRecord;
  const snapshot = buildCoordinatorSnapshot({
    record,
    status: { environmentId: 'env', name: 'dev', state: 'up', order: [], services: [] },
    portOccupied: new Map(), freeSuggestion: new Map(), checkpointWarnings: [],
    supervisor: [{ ...(rec as object), rootBase: 'wt-a' } as typeof rec],
    producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2',
  });
  const entry = snapshot.explanation?.entries.find(item => item.service === 'api');
  assert.ok(entry);
  assert.equal(entry.revShort, '0123456');
  // Full rev travels on the wire ONLY as the copy-button clipboard payload
  // (existing discipline) — DOM/title/aria render short-7 (frontend test).
  assert.equal(entry.revFull, '0123456789abcdef0123456789abcdef01234567');
  const wire = JSON.stringify(snapshot);
  assert.ok(wire.includes('0123456'), 'short-7 renders');
});

test('M2 ledger: two roots share a service name and port → two rows, merged records order untouched, advisories advisory-only', async t => {
  const f = await fixture(t);
  const ra = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-a-')));
  const rb = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-b-')));
  t.after(() => rm(ra, { recursive: true, force: true }));
  t.after(() => rm(rb, { recursive: true, force: true }));
  for (const root of [ra, rb]) {
    await mkdir(join(root, 'backend'), { recursive: true });
    await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    await mkdir(join(root, '.ow'), { recursive: true });
  }
  await writeFile(join(ra, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z',
    services: [{ name: 'api', port: 4101 }, { name: 'web', port: 4102 }],
  }));
  await writeFile(join(rb, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z',
    services: [{ name: 'api', port: 4101 }, { name: 'svc2', port: 4103 }],
  }));
  await writeFile(join(ra, '.ow', 'supervisor.lock'), JSON.stringify({ pid: process.pid, lstart: 't', startedAt: '2026-10-10T00:00:00.000Z' }));
  await writeFile(join(rb, '.ow', 'supervisor.lock'), JSON.stringify({ pid: 1 << 30, lstart: 't', startedAt: '2026-10-10T00:00:00.000Z' }));
  await mkdir(join(ra, '.git'), { recursive: true });
  await writeFile(join(ra, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(rb, '.git'), { recursive: true });
  await writeFile(join(rb, '.git', 'HEAD'), `${'b'.repeat(40)}\n`);
  await f.service.register('M2', [ra, rb]);
  await f.service.environmentSet('M2', {
    name: 'dev',
    services: [
      { id: 'api', repositoryPath: join(ra, 'backend'), scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'web', repositoryPath: join(rb, 'backend'), scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/M2/coordinator?environment=dev`)).json() as {
    worktrees: { rootBase: string; revShort: string | null; branch: string | null; lock: string; liveServices: string[]; state: string }[];
    warnings: string[];
    preflight: { pass: boolean; missing: string[] };
  };
  const baseA = ra.split('/').pop() as string;
  const baseB = rb.split('/').pop() as string;
  // Ledger: one row per root, roots order, per-root scoping (no collapse).
  assert.deepEqual(snapshot.worktrees, [
    { rootBase: baseA, revShort: null, branch: 'main', lock: 'live', liveServices: ['api', 'web'], state: 'ok' },
    { rootBase: baseB, revShort: 'bbbbbbb', branch: null, lock: 'stale', liveServices: ['api', 'svc2'], state: 'ok' },
  ]);
  // Advisories: shared port + double-owned service, scoped + non-gating wording.
  const portLine = `warning: port 4101 is busy — worktree:${baseA} + worktree:${baseB} (informational, no blocking)`;
  const svcLine = `warning: api is registered in more than one worktree — worktree:${baseA} + worktree:${baseB} (informational, no blocking)`;
  assert.ok(snapshot.warnings.includes(portLine), `missing port advisory, got ${JSON.stringify(snapshot.warnings)}`);
  assert.ok(snapshot.warnings.includes(svcLine), `missing service advisory, got ${JSON.stringify(snapshot.warnings)}`);
  // Advisory-only separation: preflight gates never carry matrix text.
  for (const line of snapshot.preflight.missing) {
    assert.ok(!line.includes('worktree:') && !line.includes('(informational'), `matrix leaked into preflight: ${line}`);
  }
});

test('M2 merged records keep first-wins order while ledger scopes per root', async t => {
  const f = await fixture(t);
  const ra = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-c-')));
  const rb = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-d-')));
  t.after(() => rm(ra, { recursive: true, force: true }));
  t.after(() => rm(rb, { recursive: true, force: true }));
  for (const root of [ra, rb]) await mkdir(join(root, '.ow'), { recursive: true });
  await mkdir(join(ra, 'backend'), { recursive: true });
  await writeFile(join(ra, 'backend', 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  await writeFile(join(ra, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z', services: [{ name: 'api', port: 4101 }],
  }));
  await writeFile(join(rb, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z', services: [{ name: 'api', port: 4102 }, { name: 'web', port: 4103 }],
  }));
  await f.service.register('M2order', [ra, rb]);
  await f.service.environmentSet('M2order', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: join(ra, 'backend'), scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/M2order/coordinator?environment=dev`)).json() as {
    worktrees: { rootBase: string; liveServices: string[] }[];
  };
  // Ledger lists the same name under both roots; the (unseen here) merged
  // path still collapses — provenance rows covered by the unit below.
  assert.equal(snapshot.worktrees.length, 2);
  assert.deepEqual(snapshot.worktrees.map(row => row.liveServices), [['api'], ['api', 'web']]);
});

test('M2 corrupt root: that row is corrupt + warning, siblings intact', async t => {
  const f = await fixture(t);
  const ra = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-e-')));
  const rb = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-f-')));
  t.after(() => rm(ra, { recursive: true, force: true }));
  t.after(() => rm(rb, { recursive: true, force: true }));
  for (const root of [ra, rb]) await mkdir(join(root, '.ow'), { recursive: true });
  await mkdir(join(ra, 'backend'), { recursive: true });
  await writeFile(join(ra, 'backend', 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  await writeFile(join(ra, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z', services: [{ name: 'api', port: 4101 }],
  }));
  await writeFile(join(rb, '.ow', 'supervisor.json'), 'corrupt{{{');
  await f.service.register('M2corrupt', [ra, rb]);
  await f.service.environmentSet('M2corrupt', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: join(ra, 'backend'), scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/M2corrupt/coordinator?environment=dev`)).json() as {
    worktrees: { rootBase: string; lock: string; liveServices: string[]; state: string }[];
    warnings: string[];
  };
  assert.equal(snapshot.worktrees.length, 2);
  assert.equal(snapshot.worktrees[0].state, 'ok');
  assert.deepEqual(snapshot.worktrees[0].liveServices, ['api']);
  assert.equal(snapshot.worktrees[1].state, 'corrupt');
  assert.deepEqual(snapshot.worktrees[1].liveServices, []);
  assert.ok(snapshot.warnings.some(warning => warning.includes('provenance unreadable')), `expected corrupt warning, got ${JSON.stringify(snapshot.warnings)}`);
});

test('M2 hostile: secret-shaped rootBase and service name never reach the wire', async t => {
  const f = await fixture(t);
  const ra = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-g-')));
  const rb = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-token-hunter2-')));
  t.after(() => rm(ra, { recursive: true, force: true }));
  t.after(() => rm(rb, { recursive: true, force: true }));
  for (const root of [ra, rb]) await mkdir(join(root, '.ow'), { recursive: true });
  await mkdir(join(ra, 'backend'), { recursive: true });
  await writeFile(join(ra, 'backend', 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  await writeFile(join(ra, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z', services: [{ name: 'api', port: 4101 }],
  }));
  await writeFile(join(rb, '.ow', 'supervisor.json'), JSON.stringify({
    version: 1, startedAt: '2026-10-10T00:00:00.000Z', services: [{ name: 'api token=hunter2', port: 4101 }],
  }));
  await f.service.register('M2hostile', [ra, rb]);
  await f.service.environmentSet('M2hostile', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: join(ra, 'backend'), scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/M2hostile/coordinator?environment=dev`)).json();
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'), 'secret value must not reach the wire');
  assert.ok(wire.includes('***'), 'masking must be visible');
});

test('M2 single-root: no worktrees key, no matrix warnings (softened no-friction)', async t => {
  const f = await fixture(t);
  await f.service.register('M2single', [f.root]);
  await f.service.environmentSet('M2single', {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
  });
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const snapshot = await (await fetch(`${origin}/api/workspaces/M2single/coordinator?environment=dev`)).json() as {
    warnings: string[];
  };
  assert.ok(!('worktrees' in snapshot), 'single-root snapshot must not carry worktrees');
  assert.ok(!JSON.stringify(snapshot).includes('worktree:'));
  assert.ok(!snapshot.warnings.some(warning => warning.includes('(informational')));
});

test('M2 lock states: live/stale/absent/corrupt classify without exec', async t => {
  const mk = async (prefix: string): Promise<string> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    await mkdir(join(root, '.ow'), { recursive: true });
    return root;
  };
  const live = await mk('openworkspace-m2-live-');
  const stale = await mk('openworkspace-m2-stale-');
  const absent = await mk('openworkspace-m2-absent-');
  const corrupt = await mk('openworkspace-m2-corrupt-');
  try {
    await writeFile(join(live, '.ow', 'supervisor.lock'), JSON.stringify({ pid: process.pid, lstart: 't', startedAt: '2026-10-10T00:00:00.000Z' }));
    await writeFile(join(stale, '.ow', 'supervisor.lock'), JSON.stringify({ pid: 1 << 30, lstart: 't', startedAt: '2026-10-10T00:00:00.000Z' }));
    await writeFile(join(corrupt, '.ow', 'supervisor.lock'), 'corrupt{{{');
    const { rows } = await readWorktreeLedger([live, stale, absent, corrupt]);
    assert.deepEqual(rows.map(row => row.lock), ['live', 'stale', 'absent', 'corrupt']);
    assert.ok(rows.every(row => row.state === 'missing'));
  } finally {
    for (const root of [live, stale, absent, corrupt]) await rm(root, { recursive: true, force: true });
  }
});

test('M2 caps: advisories truncate at 10 lines, ledger at 20 rows', async t => {
  const perRoot = [
    { rootBase: 'wt-a', records: Array.from({ length: 12 }, (_, index) => ({ name: `svc${index}`, port: 5000 + index })) },
    { rootBase: 'wt-b', records: Array.from({ length: 12 }, (_, index) => ({ name: `svc${index}`, port: 5000 + index })) },
  ];
  const lines = buildWorktreeAdvisories(perRoot);
  assert.equal(lines.length, 11);
  assert.ok(lines[10].includes('…[truncated: 14 warnings]'), `expected truncation line, got ${lines[10]}`);
  assert.ok(lines.slice(0, 10).every(line => line.includes('(informational, no blocking)')));
  const roots: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    roots.push(await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-m2-cap-'))));
  }
  try {
    const ledger = await readWorktreeLedger(roots);
    assert.equal(ledger.rows.length, 20);
    assert.ok(ledger.warnings.some(warning => warning.includes('worktree list truncated (20 root limit)')));
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});

test('M8 strip wire: boundary rollup + last-run + gate, scrubbed shapes only', async t => {
  const f = await fixture(t);
  await f.service.register('Strip', [f.root]);
  await f.service.environmentSet('Strip', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  await mkdir(join(f.root, '.ow', 'checkpoints'), { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  await writeFile(join(f.root, '.ow', 'checkpoints', 'demo.jsonl'), [
    line({ stage: 'ok-stage', status: 'confirmed', proof: 'ok', at: '2026-10-09T10:00:00.000Z', by: 'runner', code: { script_hash: 'aa11bb22cc33dd44ee55ff66', checkout_rev: 'r1' } }),
    line({ stage: 'old-stage', status: 'confirmed', proof: 'ok', at: '2026-10-09T11:00:00.000Z', by: 'runner', code: { script_hash: 'aa11bb22cc33dd44ee55ff66', checkout_rev: 'r1' } }),
    line({ stage: 'old-stage', status: 'confirmed', proof: 'ok', at: '2026-10-09T12:00:00.000Z', by: 'runner', code: { script_hash: 'ff66ee55dd44cc33bb22aa11', checkout_rev: 'r1' } }),
  ].join('\n'));
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh, --token, hunter2]}]',
    '    checkpoints: [ok-stage]',
    '  rollout:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: healthy, argv: [./y.sh]}]',
    '    checkpoints: [old-stage]',
    '  sneak:',
    '    services: [api]',
    '    boundaries: [token=hunter2]',
    '    probes: [{id: quiet, argv: [./z.sh]}]',
    '    checkpoints: []',
    '',
  ].join('\n'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Strip/coordinator?environment=dev`)).json() as {
    scenarios: { columns: string[] } | null;
    boundaryList?: Array<{ boundary: string; status: string }>;
    lastRun?: { id: string; at: string | null; pass: boolean } | null;
    readinessGate?: { pass: boolean; missing: string[] } | null;
  };
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes('hunter2'), 'hostile boundary/argv must not reach the wire');
  assert.ok(!wire.includes('--token'), 'probe argv must not reach the strip wire');
  assert.ok(!wire.includes('./x.sh'), 'probe argv must not reach the strip wire');
  assert.ok(!wire.includes('aa11bb22cc33dd44ee55ff66'), 'full digests must not reach the strip wire');
  assert.ok(!wire.includes('ff66ee55dd44cc33bb22aa11'), 'rotated digests must not reach the strip wire');

  assert.ok(snapshot.scenarios);
  assert.deepEqual(snapshot.boundaryList, [
    { boundary: 'real-read-only', status: 'stale' },
    { boundary: 'token=***', status: 'unverified' },
  ]);
  assert.deepEqual(snapshot.lastRun, { id: 'demo', at: '2026-10-09T11:00:00.000Z', pass: false });
  assert.equal(typeof snapshot.readinessGate?.pass, 'boolean');
  assert.ok(Array.isArray(snapshot.readinessGate?.missing));
});

test('M8 strip wire absent without scenarios file (byte-identical, no crash)', async t => {
  const f = await fixture(t);
  await f.service.register('Bare', [f.root]);
  await f.service.environmentSet('Bare', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Bare/coordinator?environment=dev`)).json() as Record<string, unknown>;
  assert.equal(snapshot['scenarios'], null);
  assert.ok(!('boundaryList' in snapshot), 'no strip content without scenarios');
  assert.ok(!('lastRun' in snapshot), 'no strip content without scenarios');
  assert.ok(!('readinessGate' in snapshot), 'no strip content without scenarios');
});

test('M8 strip wire: scenarios present without checkpoints keeps lastRun null', async t => {
  const f = await fixture(t);
  await f.service.register('Nocheck', [f.root]);
  await f.service.environmentSet('Nocheck', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/Nocheck/coordinator?environment=dev`)).json() as {
    boundaryList?: Array<{ boundary: string; status: string }>;
    lastRun?: { id: string; at: string | null; pass: boolean } | null;
    readinessGate?: { pass: boolean; missing: string[] } | null;
  };
  assert.deepEqual(snapshot.boundaryList, [{ boundary: 'real-read-only', status: 'skipped' }]);
  assert.equal(snapshot.lastRun, null);
  assert.equal(typeof snapshot.readinessGate?.pass, 'boolean');
});

test('M9 overlay convention: REPLACE merge + sources + applied tags', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '  other:',
    '    services: [api]',
    '    boundaries: [test]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    boundaries: [real]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.error, null);
  assert.equal(read.overlayApplied, true);
  assert.equal(read.overlayFile, 'boundaries.local.yaml');
  assert.equal(read.overlayError, null);
  const cart = read.scenarios?.find(scenario => scenario.name === 'cart');
  assert.ok(cart);
  assert.deepEqual(cart.boundaries, ['real-state-changing']);
  const other = read.scenarios?.find(scenario => scenario.name === 'other');
  assert.ok(other);
  assert.deepEqual(other.boundaries, ['unverified']);
  assert.ok(read.boundarySources.some(entry => entry.scenario === 'cart' && entry.boundary === 'real-state-changing' && entry.source === 'local'));
  assert.ok(read.boundarySources.some(entry => entry.scenario === 'other' && entry.boundary === 'unverified' && entry.source === 'base'));
});

test('M9 overlay invalid: base matrix survives + error box, never a crash', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  ghost:',
    '    boundaries: [real]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.ok(read.scenarios && read.scenarios.length === 1, 'base rows survive');
  assert.deepEqual(read.scenarios[0].boundaries, ['real-read-only']);
  assert.equal(read.overlayApplied, false);
  assert.ok(read.overlayError?.includes('overlay-dangling: ghost (refused)'));
  assert.ok(read.warnings.some(warning => warning.includes('overlay-dangling')));
});

test('M9 overlay secret-smuggle: refused, never leaks', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    boundaries: [token=hunter2]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.deepEqual(read.scenarios?.[0].boundaries, ['real-read-only']);
  assert.ok(read.overlayError?.includes('overlay-refused: boundaries.local.yaml (secret-shaped value)'));
  assert.ok(!JSON.stringify(read).includes('hunter2'), 'secret never reaches the read result');
});

test('M9 overlay stale-shadow: digest-pin mismatch advises, never fails', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'baseDigest: deadbeef',
    'scenarios:',
    '  cart:',
    '    boundaries: [real]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.overlayApplied, true);
  assert.equal(read.overlayError, null);
  assert.deepEqual(read.scenarios?.[0].boundaries, ['real-state-changing']);
  assert.ok(read.warnings.some(warning => warning.includes('overlay-stale: base changed since deadbeef (warning)')));
});

test('M9 overlay absent: wire carries no overlay keys (byte-identical)', async t => {
  const f = await fixture(t);
  await f.service.register('NoOverlay', [f.root]);
  await f.service.environmentSet('NoOverlay', {
    name: 'dev',
    services: [
      { id: 'api', name: 'api', repositoryPath: f.backend, scriptName: 'dev', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const snapshot = await (await fetch(`${origin}/api/workspaces/NoOverlay/coordinator?environment=dev`)).json() as {
    scenarios: Record<string, unknown> | null;
  };
  assert.ok(snapshot.scenarios);
  assert.ok(!('overlayApplied' in (snapshot.scenarios as Record<string, unknown>)), 'absent overlay adds no wire keys');
  assert.ok(!('boundarySources' in (snapshot.scenarios as Record<string, unknown>)), 'absent overlay adds no wire keys');
  assert.ok(!('overlayError' in (snapshot.scenarios as Record<string, unknown>)), 'absent overlay adds no wire keys');
  assert.ok(!JSON.stringify(snapshot).includes('overlay'));
});

test('HIGH-1 overlay absent boundaries key refuses (explicit [] stays allowed)', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [local]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    notboundaries: [real]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.overlayApplied, false);
  assert.ok(read.overlayError?.includes('boundaries required in cart'), `absent key refuses, got: ${read.overlayError}`);
  assert.deepEqual(read.scenarios?.[0].boundaries, ['real-read-only'], 'base survives normalized');
});

test('F2 hostile overlay name sanitizes in refusal echo (no path leak)', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [real-read-only]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  ../../etc/passwd:',
    '    boundaries: [real-read-only]',
    '',
  ].join('\n'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.overlayApplied, false);
  assert.ok(read.overlayError?.includes('overlay-dangling:'), `dangling refusal, got: ${read.overlayError}`);
  assert.ok(!read.overlayError?.includes('../'), 'no raw path traversal in echo');
  assert.ok(!read.overlayError?.includes('/etc/passwd'), 'no raw path in echo');
});

test('server realpath containment: symlinked .ow dir outside refuses overlay', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [real-read-only]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-coordinator-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, 'stolen'), { recursive: true });
  await writeFile(join(outside, 'stolen', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    boundaries: [network-deny]',
    '',
  ].join('\n'));
  await symlink(join(outside, 'stolen'), join(f.root, '.ow'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.overlayApplied, false);
  assert.ok(read.overlayError?.includes('outside root'), `expected outside-root refusal, got: ${read.overlayError}`);
  assert.deepEqual(read.scenarios?.[0].boundaries, ['real-read-only'], 'base survives');
});

test('server gitignore lstat guard: symlinked .gitignore skips mention check silently', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'ow.scenarios.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    services: [api]',
    '    boundaries: [real-read-only]',
    '    probes: [{id: ready, argv: [./x.sh]}]',
    '    checkpoints: [ok-stage]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.ow'), { recursive: true });
  await writeFile(join(f.root, '.ow', 'boundaries.local.yaml'), [
    'version: 1',
    'scenarios:',
    '  cart:',
    '    boundaries: [network-deny]',
    '',
  ].join('\n'));
  await mkdir(join(f.root, '.git'), { recursive: true });
  await writeFile(join(f.root, 'outside-ignore'), 'other\n', 'utf8');
  await symlink(join(f.root, 'outside-ignore'), join(f.root, '.gitignore'));
  const read = await readScenariosSource([f.root]);
  assert.equal(read.overlayApplied, true);
  assert.ok(!read.warnings.some(warning => warning.includes('overlay-gitignore-missing')), 'symlinked gitignore stays silent');
  assert.deepEqual(read.scenarios?.[0].boundaries, ['network-deny']);
});
