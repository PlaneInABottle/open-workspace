import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import {
  environmentDown,
  environmentStatus,
  environmentUp,
} from '../src/environment.js';
import type { Pm2ListResult, Pm2Process } from '../src/services.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

interface Rig {
  root: string;
  backend: string;
  frontend: string;
  foreignRoot: string;
  store: Store;
  service: WorkspaceService;
  workspaceId: string;
  recordId: string;
  processes: Pm2Process[];
  starterCalls: string[];
  intentSnapshots: unknown[];
  stopCalls: number[];
  probeCalls: number[];
  fetchLog: string[];
}

async function rig(t: { after: (cleanup: () => void | Promise<void>) => void }, roots = 1): Promise<Rig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-updown-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, 'backend');
  const frontend = join(root, 'frontend');
  await mkdir(backend, { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(join(backend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js', worker: 'node worker.js' },
  }));
  await writeFile(join(frontend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js' },
  }));
  let foreignRoot = '';
  if (roots === 2) {
    foreignRoot = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-foreign-')));
    t.after(() => rm(foreignRoot, { recursive: true, force: true }));
    await mkdir(join(foreignRoot, 'other'), { recursive: true });
  }
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Stack', roots === 2 ? [root, foreignRoot] : [root]);
  const record = await service.environmentSet(workspace.id, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
      { id: 'frontend', repositoryPath: frontend, scriptName: 'dev', port: 3102, dependsOn: ['backend'], readiness: { kind: 'http-200' } },
    ],
  });
  const state: Rig = {
    root, backend, frontend, foreignRoot, store, service,
    workspaceId: workspace.id, recordId: record.id,
    processes: [], starterCalls: [], intentSnapshots: [], stopCalls: [], probeCalls: [], fetchLog: [],
  };
  return state;
}

function liveProcess(cwd: string, overrides: Partial<Pm2Process> = {}): Pm2Process {
  return { pmId: 3, name: 'backend', namespace: null, status: 'online', cwd, restartCount: 0, startedAt: null, ...overrides };
}

function listOf(r: Rig): () => Promise<Pm2ListResult> {
  return async () => ({ available: true, processes: r.processes.map(process => ({ ...process })) });
}

function starterOf(r: Rig, status: string = 'online') {
  return async (input: { name: string; scriptName: string; cwd: string }) => {
    r.starterCalls.push(input.name);
    // Phase-(a) proof: the intent (pmId null) is already persisted while the
    // starter runs, before it returns.
    const snapshot = await r.store.read();
    r.intentSnapshots.push(JSON.parse(JSON.stringify(
      snapshot.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId)?.owned ?? null,
    )));
    r.processes.push({ pmId: 100 + r.starterCalls.length, name: input.name, namespace: null, status, cwd: input.cwd, restartCount: 0, startedAt: null });
    return { ok: true } as const;
  };
}

function runnerOf(r: Rig) {
  return async (action: 'restart' | 'stop', pmId: number) => {
    r.stopCalls.push(pmId);
    const proc = r.processes.find(process => process.pmId === pmId);
    if (proc) proc.status = 'stopped';
    return { ok: true } as const;
  };
}

function probeOf(r: Rig, occupied: number[]) {
  return async (port: number) => {
    r.probeCalls.push(port);
    return occupied.includes(port);
  };
}

function fetchOf(r: Rig, script: Array<{ status: number } | { error: string }>) {
  let index = 0;
  const stub = async (url: string) => {
    r.fetchLog.push(`fetch:${url}`);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//, 'readiness fetches loopback only');
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if ('error' in step) throw Object.assign(new Error(step.error), { name: 'TypeError' });
    return new Response('ok', { status: step.status });
  };
  return stub as typeof fetch;
}

function clocks() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
  };
}

test('ordered up: backend→frontend, flaky 500,500,200 → ready with attempts=3, intent persisted pre-spawn', async t => {
  const r = await rig(t);
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 500 }, { status: 500 }, { status: 200 }, { status: 200 }]),
    ...clock,
    pollIntervalMs: 1000,
  });
  assert.equal(result.state, 'up');
  assert.deepEqual(result.order, ['backend', 'frontend']);
  assert.deepEqual(r.starterCalls, ['backend', 'frontend'], 'strict dependency order');
  const backend = result.services.find(entry => entry.serviceId === 'backend');
  const frontend = result.services.find(entry => entry.serviceId === 'frontend');
  assert.equal(backend?.status, 'ready');
  assert.equal(backend?.attempts, 3, 'honest attempt log, not consecutive-N gating');
  assert.equal(backend?.lastStatus, 200);
  assert.equal(backend?.adopted, false);
  assert.equal(frontend?.status, 'ready');
  // Frontend was never started (or polled) until the backend went ready: the
  // last backend fetch precedes the first frontend fetch and the frontend
  // starter call.
  const lastBackendFetch = r.fetchLog.map((entry, i) => entry.includes(':3101') ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  const firstFrontendFetch = r.fetchLog.findIndex(entry => entry.includes(':3102'));
  assert.ok(lastBackendFetch >= 0 && firstFrontendFetch > lastBackendFetch, `backend poll completes first: ${r.fetchLog.join(' ')}`);
  // Phase-(a) evidence: while the backend starter ran, the owned intent with
  // pmId null was already persisted.
  const backendIntent = (r.intentSnapshots[0] as Array<{ serviceId: string; pmId: number | null }>)
    .find(entry => entry.serviceId === 'backend');
  assert.equal(backendIntent?.pmId, null);
  // Phase-(c) is visible to the read-only status path: mapped + alive + ready.
  const status = await environmentStatus(r.store, r.workspaceId, r.recordId, listOf(r));
  assert.equal(status.services.find(entry => entry.serviceId === 'backend')?.status, 'ready');
  assert.equal(status.services.find(entry => entry.serviceId === 'frontend')?.status, 'ready');
});

test('timeout honesty: never-ready → failed, dependent skipped unstarted, no ready claim', async t => {
  const r = await rig(t);
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 500 }]),
    ...clock,
    pollIntervalMs: 1000,
  });
  assert.equal(result.state, 'down', 'nothing is live');
  const backend = result.services.find(entry => entry.serviceId === 'backend');
  const frontend = result.services.find(entry => entry.serviceId === 'frontend');
  assert.equal(backend?.status, 'failed');
  assert.ok((backend?.attempts ?? 0) >= 5, `bounded window polled, got ${backend?.attempts}`);
  assert.equal(backend?.lastStatus, 500);
  assert.equal(frontend?.status, 'skipped');
  assert.deepEqual(r.starterCalls, ['backend'], 'skipped services are never started');
  assert.ok(!result.services.some(entry => entry.status === 'ready'));
});

test('process-alive honesty: starting lets the dependent start but is never ready; exited worker fails', async t => {
  const r = await rig(t);
  await r.service.environmentSet(r.workspaceId, {
    name: 'local',
    services: [
      { id: 'worker', repositoryPath: r.backend, scriptName: 'worker', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
      { id: 'frontend', repositoryPath: r.frontend, scriptName: 'dev', port: 3102, dependsOn: ['worker'], readiness: { kind: 'http-200' } },
    ],
  });
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
    pollIntervalMs: 1000,
    processAliveWatchMs: 3000,
  });
  const worker = result.services.find(entry => entry.serviceId === 'worker');
  const frontend = result.services.find(entry => entry.serviceId === 'frontend');
  assert.equal(worker?.status, 'starting', 'starting satisfies the dependent but is recorded distinctly from ready');
  assert.ok(!result.services.some(entry => entry.serviceId === 'worker' && entry.status === 'ready'));
  assert.equal(frontend?.status, 'ready', 'dependent of a starting worker MAY start');
  assert.deepEqual(r.starterCalls, ['worker', 'frontend']);
  assert.deepEqual(r.probeCalls, [3102], 'process-alive services skip the port probe');
  const status = await environmentStatus(r.store, r.workspaceId, r.recordId, listOf(r));
  assert.equal(status.services.find(entry => entry.serviceId === 'worker')?.status, 'starting');

  // Exited worker: the starter delivers an already-errored process.
  const r2 = await rig(t);
  await r2.service.environmentSet(r2.workspaceId, {
    name: 'local',
    services: [
      { id: 'worker', repositoryPath: r2.backend, scriptName: 'worker', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  const clock2 = clocks();
  const failed = await environmentUp(r2.store, r2.workspaceId, r2.recordId, {
    list: listOf(r2),
    starter: starterOf(r2, 'errored'),
    probe: probeOf(r2, []),
    fetchImpl: fetchOf(r2, [{ status: 200 }]),
    ...clock2,
    pollIntervalMs: 1000,
    processAliveWatchMs: 3000,
  });
  assert.equal(failed.services[0].status, 'failed');
});

test('port preflight refuses without killing: suggestion bounded, dependents skipped, starter untouched', async t => {
  const r = await rig(t);
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, [3101]),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  const backend = result.services.find(entry => entry.serviceId === 'backend');
  assert.equal(backend?.status, 'failed');
  assert.match(backend?.detail ?? '', /already occupied/);
  assert.match(backend?.detail ?? '', /3102/, 'first free port in +1..+10 is suggested, never auto-bound');
  assert.equal(result.services.find(entry => entry.serviceId === 'frontend')?.status, 'skipped');
  assert.deepEqual(r.starterCalls, [], 'refuse means refuse: nothing spawned');
  assert.deepEqual(r.fetchLog, [], 'no readiness poll for a refused service');
});

test('down is owned-only in reverse order: foreign proc and listener untouched', async t => {
  const r = await rig(t);
  const clock = clocks();
  const up = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  assert.equal(up.state, 'up');
  const backendPmId = up.services.find(entry => entry.serviceId === 'backend')?.pmId;
  const frontendPmId = up.services.find(entry => entry.serviceId === 'frontend')?.pmId;
  assert.ok(typeof backendPmId === 'number' && typeof frontendPmId === 'number');
  // A foreign PM2 process (same pmId namespace, unowned name) plus a foreign
  // TCP listener are present while down runs.
  r.processes.push(liveProcess('/definitely/not/a/root', { pmId: 99, name: 'intruder' }));
  const probeBefore = r.probeCalls.length;
  const down = await environmentDown(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    runner: runnerOf(r),
  });
  assert.equal(down.state, 'down');
  assert.deepEqual(r.stopCalls, [frontendPmId, backendPmId], 'reverse dependency order, owned pmIds only');
  assert.equal(r.probeCalls.length, probeBefore, 'down never probes ports (never kill-by-port)');
  assert.ok(r.processes.some(process => process.pmId === 99 && process.status === 'online'), 'foreign process untouched');
  assert.ok(down.services.every(entry => entry.status === 'down'));
  const reread = await r.store.read();
  const owned = reread.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId)?.owned ?? [];
  assert.deepEqual(owned, [], 'stopped owned entries are cleared');
});

test('recycled pmId with a different root reports stale with zero runner calls', async t => {
  const r = await rig(t, 2);
  const otherDir = join(r.foreignRoot, 'other');
  await r.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: 3, name: 'backend', namespace: null, expectedRoot: r.root, lastPoll: null }];
    item.state = 'partial';
  });
  // Same pmId + name, but the live process belongs to the OTHER root: the
  // recycled-pmId guard must refuse it without touching anything.
  r.processes.push(liveProcess(otherDir, { pmId: 3, name: 'backend' }));
  const down = await environmentDown(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    runner: runnerOf(r),
  });
  assert.equal(down.services[0].status, 'stale');
  assert.deepEqual(r.stopCalls, [], 'zero runner calls on the stale path');
  assert.ok(r.processes.some(process => process.pmId === 3 && process.status === 'online'), 'foreign-root process survives');
});

test('crash orphan: vanished pmId is stale with no kill; next up restarts fresh', async t => {
  const r = await rig(t);
  const clock = clocks();
  await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  assert.equal(r.starterCalls.length, 2);
  r.processes.length = 0; // crash: owned pmIds disappear from jlist.
  const down = await environmentDown(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    runner: runnerOf(r),
  });
  assert.ok(down.services.every(entry => entry.status === 'stale'));
  assert.deepEqual(r.stopCalls, [], 'nothing to stop, nothing killed');
  // Next up reconciles: zero live matches → fresh start, no duplicates.
  const clock2 = clocks();
  const again = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock2,
  });
  assert.equal(r.starterCalls.length, 4);
  assert.ok(again.services.every(entry => entry.status === 'ready'));
});

test('mid-up crash adoption: pmId-null intent + one live match adopts without duplicate start', async t => {
  const r = await rig(t);
  await r.service.environmentSet(r.workspaceId, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: r.backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  await r.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId);
    assert.ok(item);
    // Phase (a) survived a crash between spawn and fill: intent only.
    item.owned = [{ serviceId: 'backend', pmId: null, name: 'backend', namespace: null, expectedRoot: r.root, lastPoll: null }];
  });
  r.processes.push(liveProcess(r.backend, { pmId: 7, name: 'backend' }));
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  const backend = result.services[0];
  assert.equal(backend.status, 'ready');
  assert.equal(backend.adopted, true);
  assert.equal(backend.pmId, 7, 'the orphan pmId is adopted');
  assert.deepEqual(r.starterCalls, [], 'no duplicate start');
});

test('mid-up crash with zero matches starts fresh; with ≥2 matches fails ambiguous and touches nothing', async t => {
  const r = await rig(t);
  await r.service.environmentSet(r.workspaceId, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: r.backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  const intent = async () => r.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: null, name: 'backend', namespace: null, expectedRoot: r.root, lastPoll: null }];
  });
  await intent();
  const clock = clocks();
  const fresh = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  assert.equal(fresh.services[0].status, 'ready');
  assert.equal(fresh.services[0].adopted, false);
  assert.deepEqual(r.starterCalls, ['backend'], 'zero matches → fresh start');

  const r2 = await rig(t);
  await r2.service.environmentSet(r2.workspaceId, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: r2.backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  await r2.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r2.recordId);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: null, name: 'backend', namespace: null, expectedRoot: r2.root, lastPoll: null }];
  });
  r2.processes.push(liveProcess(r2.backend, { pmId: 7, name: 'backend' }));
  r2.processes.push(liveProcess(r2.backend, { pmId: 8, name: 'backend' }));
  const clock2 = clocks();
  const ambiguous = await environmentUp(r2.store, r2.workspaceId, r2.recordId, {
    list: listOf(r2),
    starter: starterOf(r2),
    probe: probeOf(r2, []),
    fetchImpl: fetchOf(r2, [{ status: 200 }]),
    ...clock2,
  });
  assert.equal(ambiguous.services[0].status, 'failed');
  assert.match(ambiguous.services[0].detail, /nothing was started or stopped/);
  assert.deepEqual(r2.starterCalls, [], 'ambiguous orphans are never duplicated');
  assert.deepEqual(r2.stopCalls, [], 'ambiguous orphans are never killed');
});

test('status after a refused start reports failed, not starting; bare intent stays starting', async t => {
  const r = await rig(t);
  const clock = clocks();
  await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, [3101]),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  const status = await environmentStatus(r.store, r.workspaceId, r.recordId, listOf(r));
  const backend = status.services.find(entry => entry.serviceId === 'backend');
  assert.equal(backend?.status, 'failed', 'port-refused lastPoll (pmId null) must not read as starting');
  assert.match(backend?.detail ?? '', /did not succeed/);

  // A bare intent with no poll recorded is still starting.
  const r2 = await rig(t);
  await r2.service.environmentSet(r2.workspaceId, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: r2.backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  await r2.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r2.recordId);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: null, name: 'backend', namespace: null, expectedRoot: r2.root, lastPoll: null }];
  });
  const bare = await environmentStatus(r2.store, r2.workspaceId, r2.recordId, listOf(r2));
  assert.equal(bare.services[0].status, 'starting');
  assert.match(bare.services[0].detail, /has not reported back/);
});

test('terminal orphan is never adopted: fresh start, dead process untouched', async t => {
  const r = await rig(t);
  await r.service.environmentSet(r.workspaceId, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: r.backend, scriptName: 'dev', port: 3101, dependsOn: [], readiness: { kind: 'http-200' } },
    ],
  });
  await r.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === r.recordId);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: null, name: 'backend', namespace: null, expectedRoot: r.root, lastPoll: null }];
  });
  // A same-name, same-root process exists but is stopped: adopting its pmId
  // could never become ready, so it counts as zero matches.
  r.processes.push(liveProcess(r.backend, { pmId: 7, name: 'backend', status: 'stopped' }));
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  const backend = result.services[0];
  assert.equal(backend.status, 'ready');
  assert.equal(backend.adopted, false, 'terminal orphan is not adoptable');
  assert.notEqual(backend.pmId, 7, 'fresh pmId, not the dead orphan');
  assert.deepEqual(r.starterCalls, ['backend'], 'zero live matches → fresh start');
  const orphan = r.processes.find(process => process.pmId === 7);
  assert.equal(orphan?.status, 'stopped', 'the dead orphan is untouched');
});

test('down with PM2 unavailable fails closed: no stops, state and owned untouched', async t => {
  const r = await rig(t);
  const clock = clocks();
  const up = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  assert.equal(up.state, 'up');
  const before = await r.store.read();
  const down = await environmentDown(r.store, r.workspaceId, r.recordId, {
    list: async () => ({ available: false, error: 'missing' }),
    runner: runnerOf(r),
  });
  assert.ok(down.services.every(entry => entry.status === 'failed'));
  assert.match(down.services[0].detail, /PM2 is unavailable/);
  assert.deepEqual(r.stopCalls, [], 'zero runner calls when PM2 cannot be read');
  assert.deepEqual(await r.store.read(), before, 'no evidence, no state change: file byte-identical');
  assert.equal(down.state, 'up', 'stored state stands when nothing could be verified');
});

test('up route completes boundedly with dashboard intent when PM2 is unavailable', async t => {
  const r = await rig(t);
  const blindService = new WorkspaceService(r.store, async () => ({ available: false, error: 'missing' as const }));
  const app = createApp(blindService, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(connected.status, 201);
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  // The up route carries no abort wiring (unlike verify), so the contract is
  // bounded completion: a fast unavailable report, never a hung socket.
  const started = Date.now();
  const response = await fetch(`${origin}/api/workspaces/${r.workspaceId}/environments/up`, {
    method: 'POST',
    headers: { ...jsonHeaders, Authorization: `Bearer ${dashboardToken}`, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'manage-environment' },
    body: JSON.stringify({ environmentId: r.recordId }),
  });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  const body = await response.json() as { state: string; services: Array<{ serviceId: string; status: string }> };
  assert.equal(body.services.find(entry => entry.serviceId === 'backend')?.status, 'failed');
  assert.equal(body.services.find(entry => entry.serviceId === 'frontend')?.status, 'skipped');
  assert.ok(elapsed < 15_000, `up completed boundedly in ${elapsed}ms`);
});

test('pm2 missing: up reports actionable unavailable, persists nothing', async t => {
  const r = await rig(t);
  const before = await r.store.read();
  const clock = clocks();
  const result = await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: async () => ({ available: false, error: 'missing' }),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  assert.equal(result.services.find(entry => entry.serviceId === 'backend')?.status, 'failed');
  assert.equal(result.services.find(entry => entry.serviceId === 'frontend')?.status, 'skipped');
  assert.match(result.services[0].detail, /PM2 is unavailable/);
  assert.deepEqual(r.starterCalls, []);
  assert.deepEqual(await r.store.read(), before, 'no owned intent is written when PM2 cannot be read');
});

test('down clears an already-stopped process without a stop call', async t => {
  const r = await rig(t);
  const clock = clocks();
  await environmentUp(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    starter: starterOf(r),
    probe: probeOf(r, []),
    fetchImpl: fetchOf(r, [{ status: 200 }]),
    ...clock,
  });
  for (const process of r.processes) process.status = 'stopped';
  const down = await environmentDown(r.store, r.workspaceId, r.recordId, {
    list: listOf(r),
    runner: runnerOf(r),
  });
  assert.ok(down.services.every(entry => entry.status === 'down'));
  assert.deepEqual(r.stopCalls, [], 'already-stopped needs no runner call');
  assert.equal(down.state, 'down');
});

test('dashboard up/down/verify require intent; MCP stays intent-free for reads', async t => {
  const r = await rig(t);
  const mcpToken = 'e'.repeat(64);
  const app = createApp(r.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(connected.status, 201);
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const upPath = `${origin}/api/workspaces/${r.workspaceId}/environments/up`;
  const downPath = `${origin}/api/workspaces/${r.workspaceId}/environments/down`;
  const verifyPath = `${origin}/api/workspaces/${r.workspaceId}/environment/verify`;
  const upBody = JSON.stringify({ environmentId: r.recordId });
  const verifyBody = JSON.stringify({ environmentId: r.recordId, repositoryPath: r.backend, scriptName: 'dev' });

  assert.equal((await fetch(upPath, { method: 'POST', headers: dashboardHeaders, body: upBody })).status, 403);
  assert.equal((await fetch(downPath, { method: 'POST', headers: dashboardHeaders, body: upBody })).status, 403);
  assert.equal((await fetch(verifyPath, { method: 'POST', headers: dashboardHeaders, body: verifyBody })).status, 403);
  const wrongIntent = await fetch(upPath, {
    method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'control-service' }, body: upBody,
  });
  assert.equal(wrongIntent.status, 403);
  const wrongVerify = await fetch(verifyPath, {
    method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'manage-environment' }, body: verifyBody,
  });
  assert.equal(wrongVerify.status, 403, 'verify keeps its own verify-environment gate');

  // MCP reads stay intent-free; mutating calls are not exercised here because
  // they would spawn real processes (covered at the service level above).
  const mcpStatus = await fetch(
    `${origin}/api/workspaces/${r.workspaceId}/environments/status?environmentId=${r.recordId}`,
    { headers: mcpHeaders },
  );
  assert.equal(mcpStatus.status, 200);
});
