import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.js';
import { Store, privateJsonLimit } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { discover, readProposalHints } from '../src/discovery.js';
import {
  environmentMessages,
  environmentServiceInput,
  environmentSetInput,
  environmentStatus,
  extractPortHint,
  proposeEnvironment,
  setEnvironment,
  topologicalOrder,
} from '../src/environment.js';
import type { Pm2ListResult, Pm2Process } from '../src/services.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function twoRepoFixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-topology-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, 'backend');
  const frontend = join(root, 'frontend');
  await mkdir(backend, { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(join(backend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js --port 3000', worker: 'node worker.js' },
  }));
  await writeFile(join(frontend, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite --port=5173', build: 'vite build' },
  }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Stack', [root]);
  return { root, backend, frontend, store, service, workspace };
}

function liveProcess(cwd: string, overrides: Partial<Pm2Process> = {}): Pm2Process {
  return { pmId: 3, name: 'dev', namespace: null, status: 'online', cwd, restartCount: 0, startedAt: null, ...overrides };
}

function httpService(repositoryPath: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    repositoryPath,
    scriptName: 'dev',
    port: 3000,
    dependsOn: [],
    readiness: { kind: 'http-200' as const },
    ...extra,
  };
}

test('old state files without environments still parse as empty', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-legacy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Legacy', [root]);
  // Simulate a file written before environments existed: strip the additive
  // field raw, then prove the new code still parses it as empty.
  const raw = JSON.parse(await readFile(join(root, 'state', 'state.json'), 'utf8'));
  assert.ok('environments' in raw);
  delete raw.environments;
  await writeFile(join(root, 'state', 'state.json'), JSON.stringify(raw));
  const reread = await new Store(join(root, 'state')).read();
  assert.deepEqual(reread.environments, []);
  assert.deepEqual(await service.environmentList(workspace.name), []);
});

test('propose derives two candidates with ports and a frontend→backend suggestion', async t => {
  const f = await twoRepoFixture(t);
  const inspection = await discover(f.root);
  assert.equal(inspection.repositories.length, 2);
  const candidates = [];
  for (const repository of inspection.repositories) {
    candidates.push({ repository, hints: await readProposalHints(repository.path) });
  }
  const { services, order } = proposeEnvironment(candidates);
  assert.equal(services.length, 2);
  const backend = services.find(service => service.id === 'backend');
  const frontend = services.find(service => service.id === 'frontend');
  assert.equal(backend?.scriptName, 'dev');
  assert.equal(backend?.port, 3000);
  assert.equal(backend?.portSource, 'script');
  assert.deepEqual(backend?.readiness, { kind: 'http-200', path: '/', timeoutSecs: 30 });
  assert.equal(frontend?.port, 5173);
  assert.deepEqual(frontend?.dependsOnSuggest, ['backend']);
  assert.deepEqual(order, ['backend', 'frontend']);
});

test('propose never executes: Procfile commands are hints and unmapped entries are marked', async t => {
  const f = await twoRepoFixture(t);
  const sentinel = join(f.root, 'pwned-by-propose');
  await writeFile(join(f.backend, 'Procfile'), `web: touch ${sentinel}\napi: node server.js --port 3001\n`);
  await writeFile(join(f.backend, 'Makefile'), 'test: node --test\nlint: echo ok\n');
  await writeFile(join(f.backend, 'compose.yaml'), 'services: {}');
  const inspection = await discover(f.root);
  const repository = inspection.repositories.find(repo => repo.name === 'backend');
  assert.ok(repository);
  assert.deepEqual(repository.composeFiles, ['compose.yaml']);
  const { services } = proposeEnvironment([{ repository, hints: await readProposalHints(repository.path) }]);
  assert.equal(services.length, 1);
  const notes = services[0].notes.join('\n');
  assert.match(notes, /presence-only/);
  assert.match(notes, /unmapped/);
  assert.match(notes, /Makefile targets are hints only/);
  await assert.rejects(async () => { await readFile(sentinel, 'utf8'); }, 'Procfile command must never execute');
});

test('proposal hint reads are bounded (20 Procfile lines, 30 Makefile targets)', async t => {
  const f = await twoRepoFixture(t);
  const procfile = Array.from({ length: 25 }, (_, index) => `svc${index}: node s${index}.js`).join('\n');
  const makefile = Array.from({ length: 35 }, (_, index) => `target${index}: deps`).join('\n');
  await writeFile(join(f.backend, 'Procfile'), procfile);
  await writeFile(join(f.backend, 'Makefile'), makefile);
  const hints = await readProposalHints(f.backend);
  assert.equal(hints.procfile.length, 20);
  assert.equal(hints.makefileTargets.length, 30);
});

test('port hints accept :port, PORT= and --port spellings and reject out-of-range values', () => {
  assert.equal(extractPortHint(['serve on :8080']), 8080);
  assert.equal(extractPortHint(['PORT=4321']), 4321);
  assert.equal(extractPortHint(['start --port 9000']), 9000);
  assert.equal(extractPortHint(['start --port=9001']), 9001);
  assert.equal(extractPortHint(['nothing here']), null);
  assert.equal(extractPortHint(['port :99999']), null);
});

test('set persists canonical paths and status before any up reports all down', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'local',
    services: [
      httpService(join(f.root, 'sub', '..', 'backend'), 'backend'),
      { ...httpService(f.frontend, 'frontend', { port: 5173 }), dependsOn: ['backend'] },
    ],
  });
  assert.equal(record.services[0].repositoryPath, f.backend, 'non-canonical input is stored canonical');
  assert.equal(record.state, 'down');
  assert.deepEqual(record.owned, []);
  const stored = await f.service.environmentGet(f.workspace.name, record.name);
  assert.equal(stored.name, 'local');
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [] });
  const status = await environmentStatus(f.store, f.workspace.name, record.name, list);
  assert.deepEqual(status.order, ['backend', 'frontend']);
  assert.ok(status.services.every(entry => entry.status === 'down'));
});

test('set refuses cyclic, self, unknown deps, unknown scripts, out-of-root repos and kind/port mismatches', async t => {
  const f = await twoRepoFixture(t);
  const cyclic = [
    { ...httpService(f.backend, 'a'), dependsOn: ['b'] },
    { ...httpService(f.frontend, 'b', { port: 5173 }), dependsOn: ['a'] },
  ];
  await assert.rejects(f.service.environmentSet(f.workspace.name, { name: 'e', services: cyclic }), /must not form a cycle/);
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e', services: [{ ...httpService(f.backend, 'a'), dependsOn: ['a'] }],
  }), /cannot depend on itself/);
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e', services: [{ ...httpService(f.backend, 'a'), dependsOn: ['ghost'] }],
  }), /unknown service id/);
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e', services: [{ ...httpService(f.backend, 'a'), scriptName: 'nope' }],
  }), /no runnable script with that name/);
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-outside-')));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outside = join(outsideRoot, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'package.json'), JSON.stringify({ scripts: { dev: 'node x.js' } }));
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e', services: [httpService(outside, 'a')],
  }), /not inside a registered project root/);
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e', services: [{ ...httpService(f.backend, 'a'), port: null }],
  }), /need a port/);
  await assert.rejects(f.service.environmentSet(f.workspace.name, {
    name: 'e',
    services: [{ id: 'w', repositoryPath: f.backend, scriptName: 'worker', port: 3000, dependsOn: [], readiness: { kind: 'process-alive' } }],
  }), /must set port to null/);
  assert.equal(topologicalOrder([{ id: 'a', dependsOn: [] }]).join(','), 'a');
});

test('process-alive services report at most starting, never ready', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'mixed',
    services: [
      httpService(f.backend, 'backend'),
      { id: 'worker', repositoryPath: f.backend, scriptName: 'worker', port: null, dependsOn: [], readiness: { kind: 'process-alive' } },
    ],
  });
  // Fixture M2-persisted owned intent: the worker is alive and exactly mapped.
  await f.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === record.id);
    assert.ok(item);
    item.owned = [
      { serviceId: 'backend', pmId: 3, name: 'dev', namespace: null, expectedRoot: f.root, lastPoll: null },
      { serviceId: 'worker', pmId: 4, name: 'worker', namespace: null, expectedRoot: f.root, lastPoll: null },
    ];
    item.state = 'partial';
  });
  const list = async (): Promise<Pm2ListResult> => ({
    available: true,
    processes: [liveProcess(f.backend), liveProcess(f.backend, { pmId: 4, name: 'worker' })],
  });
  const status = await environmentStatus(f.store, f.workspace.name, record.name, list);
  const worker = status.services.find(entry => entry.serviceId === 'worker');
  assert.equal(worker?.status, 'starting');
  assert.ok(!status.services.some(entry => entry.status === 'ready'), 'M1 status never reports ready without a readiness poll');
});

test('stale owned (recycled pmId, different root) reports stale with zero mutations', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'local', services: [httpService(f.backend, 'backend')],
  });
  const foreignRoot = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-foreign-')));
  t.after(() => rm(foreignRoot, { recursive: true, force: true }));
  await f.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === record.id);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: 3, name: 'dev', namespace: null, expectedRoot: f.root, lastPoll: null }];
  });
  let listCalls = 0;
  const list = async (): Promise<Pm2ListResult> => {
    listCalls += 1;
    // Same pmId+name, but the live process belongs to a different root:
    // the recycled-pmId guard must refuse it without touching anything.
    return { available: true, processes: [liveProcess(foreignRoot)] };
  };
  const before = await readFile(join(f.root, 'state', 'state.json'), 'utf8');
  const status = await environmentStatus(f.store, f.workspace.name, record.name, list);
  assert.equal(status.services[0].status, 'stale');
  assert.equal(listCalls, 1, 'status uses the read-only list seam exactly once');
  assert.equal(await readFile(join(f.root, 'state', 'state.json'), 'utf8'), before, 'status mutates nothing');
});

test('set preserves owned intent and lifecycle state; removed services stay stale-tracked, never killed', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'local',
    services: [httpService(f.backend, 'backend'), { ...httpService(f.frontend, 'frontend', { port: 5173 }) }],
  });
  await f.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === record.id);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: 3, name: 'dev', namespace: null, expectedRoot: f.root, lastPoll: null }];
    item.state = 'partial';
  });
  const reset = await f.service.environmentSet(f.workspace.name, {
    name: 'local', services: [{ ...httpService(f.frontend, 'frontend', { port: 5173 }) }],
  });
  assert.equal(reset.id, record.id, 'same env name replaces services in place');
  assert.equal(reset.state, 'partial', 'lifecycle state is preserved across re-set');
  assert.equal(reset.owned.length, 1, 'owned intent survives the topology change');
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [] });
  const status = await environmentStatus(f.store, f.workspace.name, record.name, list);
  const stale = status.services.find(entry => entry.serviceId === 'backend');
  assert.equal(stale?.status, 'stale');
  assert.match(stale?.detail ?? '', /never stopped here/);
});

test('workspace env caps: 5 per workspace enforced', async t => {
  const f = await twoRepoFixture(t);
  for (let index = 0; index < 5; index += 1) {
    await f.service.environmentSet(f.workspace.name, { name: `env-${index}`, services: [httpService(f.backend, 'backend')] });
  }
  await assert.rejects(
    f.service.environmentSet(f.workspace.name, { name: 'env-6', services: [httpService(f.backend, 'backend')] }),
    /Environment limit reached/,
  );
});

test('oversized topology is refused leaving state.json byte-identical', async t => {
  const f = await twoRepoFixture(t);
  // Bulk the state with max-length-root fixture workspaces until just under
  // the 1 MiB ceiling; the next 10-service set must refuse without writing.
  // Coarse full workspaces first, then one tuned root for byte-level control
  // (root strings may be any length 1..4096, so the window is hit exactly).
  const cap = 1024 * 1024;
  const headroom = 800;
  const padRoot = (tag: string, length: number) => `/${tag}-${'r'.repeat(Math.max(length, 8))}`;
  await f.store.update(state => {
    const serialized = () => Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8');
    let index = 0;
    const pushFull = () => {
      index += 1;
      state.workspaces.push({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `bulk-${index}`,
        roots: Array.from({ length: 20 }, (_, rootIndex) => padRoot(`bulk-${index}-${rootIndex}`, 4000)),
        linkedContainers: [],
        createdAt: new Date().toISOString(),
      });
    };
    pushFull();
    while (serialized() < cap - headroom - 80000) pushFull();
    // Remaining gap is ≤ 90 KiB: one workspace with tuned roots (≤20 × 4096
    // covers it). Deterministic fill with a safety margin, so the commit
    // lands strictly under the cap but within one env payload of it.
    let rootsBudget = cap - headroom - serialized() - 250;
    assert.ok(rootsBudget > 0 && rootsBudget <= 90000, `tuned budget ${rootsBudget}`);
    const tuned: string[] = [];
    while (rootsBudget > 60 && tuned.length < 20) {
      const length = Math.min(4000, rootsBudget - 30);
      tuned.push(padRoot(`tuned-${tuned.length}`, length));
      rootsBudget -= length + 30;
    }
    index += 1;
    state.workspaces.push({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `bulk-${index}`,
      roots: tuned.length ? tuned : [padRoot('tuned-fallback', 16)],
      linkedContainers: [],
      createdAt: new Date().toISOString(),
    });
    assert.ok(serialized() <= cap && serialized() > cap - 2500, `bulk size ${serialized()} near cap`);
  });
  const before = await readFile(join(f.root, 'state', 'state.json'), 'utf8');
  const services = Array.from({ length: 10 }, (_, index) => httpService(f.backend, `svc-${index}`, { port: 3000 + index }));
  await assert.rejects(
    setEnvironment(f.store, f.workspace.name, { name: 'too-big', services }),
    /exceed the private state size limit/,
  );
  assert.equal(await readFile(join(f.root, 'state', 'state.json'), 'utf8'), before);
});

test('outer environment-entry cap refuses the 51st entry', async t => {
  const f = await twoRepoFixture(t);
  await f.store.update(state => {
    for (let index = 0; index < 50; index += 1) {
      state.environments.push({
        workspaceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        items: [],
      });
    }
  });
  await assert.rejects(
    f.service.environmentSet(f.workspace.name, { name: 'outer', services: [httpService(f.backend, 'backend')] }),
    /Environment registry is full/,
  );
});

test('dashboard set requires canonical context; reads need none', async t => {
  const f = await twoRepoFixture(t);
  const mcpToken = 'e'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(connected.status, 201);
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const bareDashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const setPath = `${origin}/api/workspaces/${f.workspace.name}/environments/set`;
  const setBody = JSON.stringify({ name: 'local', services: [httpService(f.backend, 'backend')] });

  const missingContext = await fetch(setPath, { method: 'POST', headers: bareDashboardHeaders, body: setBody });
  assert.equal(missingContext.status, 403);
  const dashboardSet = await fetch(setPath, {
    method: 'POST', headers: dashboardHeaders, body: setBody,
  });
  assert.equal(dashboardSet.status, 200);
  const created = await dashboardSet.json() as { id: string; name: string };
  assert.ok(created.id);

  // MCP carries no extra header: the client permission model is the authority,
  // and the call itself is the audit record.
  const mcpSet = await fetch(setPath, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'mcp-env', services: [httpService(f.backend, 'backend')] }),
  });
  assert.equal(mcpSet.status, 200);

  const statusPath = `${origin}/api/workspaces/${f.workspace.name}/environments/status?environment=${created.name}`;
  const dashboardStatus = await fetch(statusPath, { headers: dashboardHeaders });
  assert.equal(dashboardStatus.status, 200);
  const mcpStatus = await fetch(statusPath, { headers: mcpHeaders });
  assert.equal(mcpStatus.status, 200);
  const listed = await fetch(`${origin}/api/workspaces/${f.workspace.name}/environments`, { headers: mcpHeaders });
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as unknown[]).length, 2);
});

test('F1: removing a workspace cascades its environments entry and reclaims the outer cap', async t => {
  const f = await twoRepoFixture(t);
  await f.service.environmentSet(f.workspace.name, {
    name: 'local', services: [httpService(f.backend, 'backend')],
  });
  assert.equal((await f.service.environmentList(f.workspace.name)).length, 1);
  await f.service.remove(f.workspace.name);
  const reread = await f.store.read();
  assert.ok(!reread.environments.some(entry => entry.workspaceId === f.workspace.id), 'no orphan entry');
  // Cap reclaimed: a fresh workspace can take the freed outer slot.
  await f.store.update(state => {
    for (let index = 0; index < 50; index += 1) {
      state.environments.push({
        workspaceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        items: [],
      });
    }
  });
  const other = await f.service.register('Other', [f.root]);
  await assert.rejects(
    f.service.environmentSet(other.name, { name: 'full', services: [httpService(f.backend, 'backend')] }),
    /Environment registry is full/,
  );
  await f.store.update(state => {
    state.environments = state.environments.slice(0, 49);
  });
  const created = await f.service.environmentSet(other.name, { name: 'fits', services: [httpService(f.backend, 'backend')] });
  assert.equal(created.name, 'fits');
});

test('F2: owned namespace prod against a live null namespace reports stale', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'local', services: [httpService(f.backend, 'backend')],
  });
  await f.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === record.id);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: 3, name: 'dev', namespace: 'prod', expectedRoot: f.root, lastPoll: null }];
  });
  const list = async (): Promise<Pm2ListResult> => ({
    available: true,
    processes: [liveProcess(f.backend, { namespace: null })],
  });
  const status = await environmentStatus(f.store, f.workspace.name, record.name, list);
  assert.equal(status.services[0].status, 'stale');
});

test('F3: same-basename repos across roots get deterministic qualified ids', async t => {
  const f = await twoRepoFixture(t);
  const rootB = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-dup-')));
  t.after(() => rm(rootB, { recursive: true, force: true }));
  const dup = join(rootB, 'backend');
  await mkdir(dup, { recursive: true });
  await writeFile(join(dup, 'package.json'), JSON.stringify({ scripts: { dev: 'node other.js --port 4000' } }));
  const collected: Array<{ repository: Awaited<ReturnType<typeof discover>>['repositories'][number]; hints: Awaited<ReturnType<typeof readProposalHints>> }> = [];
  for (const root of [f.root, rootB]) {
    const inspection = await discover(root);
    for (const repository of inspection.repositories.filter(repo => repo.name === 'backend')) {
      collected.push({ repository, hints: await readProposalHints(repository.path) });
    }
  }
  assert.equal(collected.length, 2);
  const { services, order } = proposeEnvironment(collected);
  const ids = services.map(service => service.id).sort();
  assert.deepEqual(ids, ['backend', 'backend--2']);
  assert.deepEqual([...order].sort(), ['backend', 'backend--2']);
  assert.ok(services.every(service => /^[\w:.-]{1,80}$/.test(service.name)));
});

test('F4: MCP set input reuses the canonical schema (no divergent copy)', async t => {
  const mcpSource = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  assert.ok(mcpSource.includes('environmentSetInput'), 'mcp.ts reuses the canonical set input');
  assert.ok(!/const environmentServiceInput/.test(mcpSource), 'no divergent service-input copy in mcp.ts');
  // Canonical charset enforced at the single definition site …
  assert.throws(() => environmentServiceInput.parse({
    id: 'a', repositoryPath: '/x', scriptName: 'bad name!', port: 3000, readiness: { kind: 'http-200' },
  }));
  // … and an 80-char charset-valid script name passes both parse and set.
  const f = await twoRepoFixture(t);
  const longScript = 'a'.repeat(80);
  await writeFile(join(f.backend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js --port 3000', [longScript]: 'node long.js --port 3001' },
  }));
  const parsed = environmentSetInput.parse({
    name: 'e', services: [{ id: 'a', repositoryPath: f.backend, scriptName: longScript, port: 3001, readiness: { kind: 'http-200' } }],
  });
  const record = await f.service.environmentSet(f.workspace.name, parsed);
  assert.equal(record.services[0].scriptName, longScript);
});

test('F5: single private-state limit owned by store.ts', async t => {
  assert.equal(privateJsonLimit, 1024 * 1024);
  const environmentSource = readFileSync(new URL('../src/environment.ts', import.meta.url), 'utf8');
  assert.ok(environmentSource.includes('privateJsonLimit'), 'environment.ts references the shared limit');
  assert.ok(!/const privateJsonLimit/.test(environmentSource), 'no duplicated limit definition');
});

test('F6: terminal PM2 states map honestly (stopped → down, errored → failed)', async t => {
  const f = await twoRepoFixture(t);
  const record = await f.service.environmentSet(f.workspace.name, {
    name: 'local', services: [httpService(f.backend, 'backend')],
  });
  await f.store.update(state => {
    const item = state.environments.flatMap(entry => entry.items).find(item => item.id === record.id);
    assert.ok(item);
    item.owned = [{ serviceId: 'backend', pmId: 3, name: 'dev', namespace: null, expectedRoot: f.root, lastPoll: null }];
  });
  const stopped = await environmentStatus(f.store, f.workspace.name, record.name,
    async () => ({ available: true, processes: [liveProcess(f.backend, { status: 'stopped' })] }));
  assert.equal(stopped.services[0].status, 'down');
  assert.match(stopped.services[0].detail, /stopped/);
  const errored = await environmentStatus(f.store, f.workspace.name, record.name,
    async () => ({ available: true, processes: [liveProcess(f.backend, { status: 'errored' })] }));
  assert.equal(errored.services[0].status, 'failed');
  assert.match(errored.services[0].detail, /errored/);
  const launching = await environmentStatus(f.store, f.workspace.name, record.name,
    async () => ({ available: true, processes: [liveProcess(f.backend, { status: 'launching' })] }));
  assert.equal(launching.services[0].status, 'starting');
});

test('F7: an out-of-range port match never blocks a later valid one', () => {
  assert.equal(extractPortHint(['listen :99999 then :8080']), 8080);
  assert.equal(extractPortHint(['PORT=99999', 'PORT=4321']), 4321);
  assert.equal(extractPortHint(['--port 70000 --port 9000']), 9000);
  assert.equal(extractPortHint([':99999']), null);
});
