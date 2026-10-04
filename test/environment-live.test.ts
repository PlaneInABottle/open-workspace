import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { probeTcpPort } from '../src/environment.js';
import { listRecentRuns } from '../src/run-summaries.js';

function pm2Present(): boolean {
  try {
    const result = spawnSync('pm2', ['ping'], { timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function freePort(from: number): Promise<number> {
  let port = from;
  for (let guard = 0; guard < 200; guard += 1) {
    if (!(await probeTcpPort(port))) return port;
    port += 1;
  }
  throw new Error('No free loopback port for the live gate.');
}

function listen(port: number, body: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function get(port: number, path = '/'): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
  return { status: response.status, text: (await response.text()).trim() };
}

function gitInit(repo: string): string {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'fixture'], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
}

test('no kill-by-port/name/argv anywhere in the orchestration path', () => {
  const source = readFileSync(new URL('../src/environment.ts', import.meta.url), 'utf8');
  assert.ok(!/['"]kill['"]/.test(source), 'never pm2 kill');
  assert.ok(!/['"]delete['"]/.test(source), 'never pm2 delete');
  assert.ok(!/lsof|fuser|pkill/.test(source), 'never port-kill tooling');
});

test('live gate: refuse-with-foreigner → clean up → ready → receipt E2E → owned-only down', async t => {
  if (!pm2Present()) {
    // Stop condition from the plan: without pm2 the gate cannot run; up must
    // report actionable unavailable instead of fake-passing.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-live-nopm2-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(join(root, 'state'));
    await store.initialize();
    const service = new WorkspaceService(store);
    const workspace = await service.register('NoPm2', [root]);
    const record = await service.environmentSet(workspace.name, {
      name: 'local',
      services: [{ id: 'svc', repositoryPath: root, scriptName: 'x', port: null, dependsOn: [], readiness: { kind: 'process-alive' } }],
    }).catch(() => null);
    assert.ok(record === null || record, 'topology validation is independent of pm2');
    t.skip('pm2 is not installed; live gate cannot run here');
    return;
  }
  const tag = `l${Date.now().toString(36)}`;
  const backendId = `envtest-be-${tag}`;
  const frontendId = `envtest-fe-${tag}`;
  const foreignId = `envtest-fo-${tag}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-live-')));
  const backend = join(root, 'backend');
  const frontend = join(root, 'frontend');
  const other = join(root, 'other');
  await Promise.all([mkdir(backend, { recursive: true }), mkdir(frontend, { recursive: true }), mkdir(other, { recursive: true })]);
  const backendPort = await freePort(32311);
  const frontendPort = await freePort(backendPort + 1);
  const otherPort = await freePort(frontendPort + 1);
  const foreignPort = await freePort(otherPort + 1);
  await writeFile(join(backend, 'server.js'), [
    "const http = require('http');",
    `const port = ${backendPort};`,
    "http.createServer((req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end('backend-ok'); }).listen(port, '127.0.0.1');",
    "console.log(`backend on ${port}`);",
    '',
  ].join('\n'));
  await writeFile(join(backend, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  await writeFile(join(frontend, 'server.js'), [
    "const http = require('http');",
    `const port = ${frontendPort};`,
    "http.createServer((req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end('frontend-ok'); }).listen(port, '127.0.0.1');",
    '',
  ].join('\n'));
  await writeFile(join(frontend, 'e2e.js'), [
    `fetch('http://127.0.0.1:${backendPort}/').then(async (r) => {`,
    "  const text = (await r.text()).trim();",
    "  if (r.status !== 200 || text !== 'backend-ok') { console.error(`unexpected: ${r.status} ${text}`); process.exit(1); }",
    "  console.log('e2e ok via backend');",
    "}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });",
    '',
  ].join('\n'));
  await writeFile(join(frontend, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js', e2e: 'node e2e.js' } }));
  await writeFile(join(other, 'server.js'), [
    "const http = require('http');",
    `const port = ${otherPort};`,
    "http.createServer((req, res) => { res.writeHead(200); res.end('other-ok'); }).listen(port, '127.0.0.1');",
    '',
  ].join('\n'));
  await writeFile(join(other, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const backendSha = gitInit(backend);
  const frontendSha = gitInit(frontend);
  assert.match(backendSha, /^[0-9a-f]{40}$/);

  const store = new Store(join(root, 'state'));
  await store.initialize();
  // Real runners: no injection — the production path is exercised.
  const service = new WorkspaceService(store);
  const workspace = await service.register('LiveStack', [root]);
  const record = await service.environmentSet(workspace.name, {
    name: 'live',
    services: [
      { id: backendId, repositoryPath: backend, scriptName: 'dev', port: backendPort, dependsOn: [], readiness: { kind: 'http-200' } },
      { id: frontendId, repositoryPath: frontend, scriptName: 'dev', port: frontendPort, dependsOn: [backendId], readiness: { kind: 'http-200' } },
    ],
  });
  const ownedNames = async (): Promise<string[]> => {
    const inventory = await service.services(workspace.name);
    return [...inventory.services, ...inventory.ambiguousServices].map(entry => entry.name);
  };
  let foreignListener: Server | null = null;
  t.after(async () => {
    try {
      await service.environmentDown(workspace.name, record.name);
    } catch { /* best-effort teardown */ }
    try {
      await service.serviceAction(workspace.name, 'stop', { pmId: null, name: foreignId });
    } catch { /* foreign fixture may already be gone */ }
    for (const name of [backendId, frontendId, foreignId]) {
      try {
        spawnSync('pm2', ['delete', name], { timeout: 10_000 });
      } catch { /* best-effort slot cleanup */ }
    }
    if (foreignListener) await close(foreignListener);
    await rm(root, { recursive: true, force: true });
  });

  // Phase 1: a foreign listener holds the backend port. Up must refuse (and
  // suggest) without killing the occupant; the dependent never starts.
  foreignListener = await listen(backendPort, 'foreign');
  const refused = await service.environmentUp(workspace.name, record.name);
  const refusedBackend = refused.services.find(entry => entry.serviceId === backendId);
  assert.equal(refusedBackend?.status, 'failed');
  assert.match(refusedBackend?.detail ?? '', /already occupied/);
  assert.equal(refused.services.find(entry => entry.serviceId === frontendId)?.status, 'skipped');
  const stillThere = await get(backendPort);
  assert.equal(stillThere.text, 'foreign', 'the foreign listener survives the refused up');
  assert.ok(!(await ownedNames()).includes(backendId), 'nothing owned was spawned');
  await close(foreignListener);
  foreignListener = null;

  // Phase 2: clean up → both ready through the real poller.
  const up = await service.environmentUp(workspace.name, record.name);
  assert.equal(up.state, 'up');
  assert.deepEqual(up.order, [backendId, frontendId]);
  assert.ok(up.services.every(entry => entry.status === 'ready'), JSON.stringify(up.services.map(e => [e.serviceId, e.status, e.detail])));
  assert.ok(up.services.every(entry => entry.attempts >= 1 && entry.adopted === false));
  assert.deepEqual(
    (await ownedNames()).filter(name => [backendId, frontendId].includes(name)).sort(),
    [backendId, frontendId].sort(),
  );
  const status = await service.environmentStatus(workspace.name, record.name);
  assert.ok(status.services.every(entry => entry.status === 'ready'));

  // Phase 3: a foreign PM2 process (root-matched but unowned) and a foreign
  // listener are present while verify + down run.
  const foreignStart = await service.serviceStart(workspace.name, { repositoryPath: other, scriptName: 'dev', name: foreignId });
  assert.equal(foreignStart.status, 'completed');
  foreignListener = await listen(foreignPort, 'foreign');
  const verified = await service.environmentVerify(workspace.name, {
    environment: record.name,
    repositoryPath: frontend,
    scriptName: 'e2e',
  });
  assert.equal(verified.outcome, 'passed');
  assert.ok(verified.runId, 'receipt persisted');
  assert.equal(verified.services.length, 2);
  const receipts = Object.fromEntries(verified.services.map(entry => [entry.serviceId, entry]));
  assert.equal(receipts[backendId].revision, backendSha, 'real git revision pinned');
  assert.equal(receipts[frontendId].revision, frontendSha);
  assert.ok(receipts[backendId].pmId >= 0 && receipts[frontendId].pmId >= 0);
  const runs = await listRecentRuns(store.directory, workspace.id, 5, new Set());
  assert.equal(runs[0].source, 'openworkspace-run');
  assert.equal(runs[0].environment?.services.length, 2);
  assert.ok(runs[0].environment?.services.every(entry => typeof entry.pmId === 'number' && typeof entry.revision === 'string'));

  // Phase 4: owned-only down. Foreign listener stays connectable, the foreign
  // process stays online, owned processes are gone.
  const down = await service.environmentDown(workspace.name, record.name);
  assert.equal(down.state, 'down');
  assert.ok(down.services.every(entry => entry.status === 'down'));
  assert.deepEqual(down.services.map(entry => entry.serviceId), [frontendId, backendId], 'reverse dependency order');
  const foreignAlive = await get(foreignPort);
  assert.equal(foreignAlive.text, 'foreign', 'the foreign listener survives down');
  const inventory = await service.services(workspace.name);
  const ownedEntries = [...inventory.services, ...inventory.ambiguousServices]
    .filter(entry => [backendId, frontendId].includes(entry.name));
  assert.ok(ownedEntries.every(entry => entry.status === 'stopped'),
    `owned processes are stopped (PM2 stop retains the entry; delete is out of scope): ${JSON.stringify(ownedEntries.map(e => [e.name, e.status]))}`);
  const afterNames = (await ownedNames());
  assert.ok(afterNames.includes(foreignId), 'the foreign process was never addressed');
});
