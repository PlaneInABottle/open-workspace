import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { controlPm2Service, runPm2Start, startPm2Service, type Pm2ListResult, type Pm2Process, type Pm2StartRunner } from '../src/services.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function approvedProject(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-service-start-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const outside = join(root, 'other');
  await mkdir(project, { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js', worker: 'node worker.js' } }));
  await writeFile(join(outside, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, project, outside, store };
}

function process(cwd: string, overrides: Partial<Pm2Process> = {}): Pm2Process {
  return { pmId: 7, name: 'dev', namespace: 'default', status: 'online', cwd, restartCount: 0, startedAt: null, ...overrides };
}

function emptyDocker() {
  return async () => ({ available: true as const, containers: [] });
}

function fakeSpawn(captured: Array<{ command: string; args: string[]; options: unknown }>, code: number): typeof spawn {
  const fake = (command: string, args: string[] = [], options: unknown) => {
    captured.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', code));
    return child as never;
  };
  return fake as unknown as typeof spawn;
}

test('service start launches one existing package.json script as an owned PM2 process', async t => {
  const f = await approvedProject(t);
  let running = false;
  const starterInputs: Array<{ name: string; scriptName: string; cwd: string }> = [];
  const starter: Pm2StartRunner = async input => {
    starterInputs.push(input);
    running = true;
    return { ok: true };
  };
  const list = async (): Promise<Pm2ListResult> => ({
    available: true,
    processes: running ? [process(f.project)] : [],
  });
  const service = new WorkspaceService(f.store, list, undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, starter);
  const approved = await service.register('Project', [f.project]);

  const result = await service.serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.deepEqual(starterInputs, [{ name: 'dev', scriptName: 'dev', cwd: f.project }]);
  assert.equal(result.action, 'start');
  assert.equal(result.status, 'completed');
  assert.equal(result.scriptName, 'dev');
  assert.equal(result.repositoryPath, f.project);
  assert.equal(result.rootPath, approved.roots[0]);
  assert.equal(result.target.pmId, 7);
  assert.equal(result.target.name, 'dev');
  assert.match(result.message, /not readiness/);

  const inventory = await service.services(approved.id);
  assert.equal(inventory.services.length, 1);
  assert.equal(inventory.services[0].pmId, 7);
  assert.equal(inventory.services[0].exactRootPath, approved.roots[0]);
});

test('runPm2Start uses a fixed pm2 argv with cwd confinement and no shell', async t => {
  const f = await approvedProject(t);
  const captured: Array<{ command: string; args: string[]; options: unknown }> = [];
  const result = await runPm2Start({ name: 'dev', scriptName: 'dev', cwd: f.project }, { spawn: fakeSpawn(captured, 0) });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].command, 'pm2');
  assert.deepEqual(captured[0].args, ['start', 'npm', '--name', 'dev', '--', 'run', 'dev', '--silent']);
  const options = captured[0].options as { shell: boolean; cwd: string; env: NodeJS.ProcessEnv };
  assert.equal(options.shell, false);
  assert.equal(options.cwd, f.project);

  // Even a hostile-looking script value travels as one argv element with no
  // shell at the spawn layer; the service layer refuses it before this point.
  const hostile: Array<{ command: string; args: string[]; options: unknown }> = [];
  await runPm2Start({ name: 'x', scriptName: 'a;touch /tmp/pwned', cwd: f.project }, { spawn: fakeSpawn(hostile, 0) });
  assert.equal(hostile[0].args.filter(arg => arg === 'a;touch /tmp/pwned').length, 1);
  assert.equal((hostile[0].options as { shell: boolean }).shell, false);
});

test('started services keep stop/restart continuity on the same inventory path', async t => {
  const f = await approvedProject(t);
  const calls: Array<{ action: string; pmId: number }> = [];
  const foreign = process(f.outside, { pmId: 9, name: 'other' });
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.project), foreign] });
  const service = new WorkspaceService(f.store, list, async (action, pmId) => {
    calls.push({ action, pmId });
    return { ok: true };
  }, undefined, undefined, undefined, undefined, Date.now, emptyDocker());
  const approved = await service.register('Project', [f.project]);

  const stopped = await service.serviceAction(approved.id, 'stop', { pmId: 7, name: 'dev', namespace: 'default' });
  assert.equal(stopped.status, 'completed');
  const restarted = await service.serviceAction(approved.id, 'restart', { pmId: 7, name: 'dev', namespace: 'default' });
  assert.equal(restarted.status, 'completed');
  // Owned-only teardown: exactly the owned pmId was addressed; the foreign
  // listener (synthetic outside process) was never passed to the runner.
  assert.deepEqual(calls, [{ action: 'stop', pmId: 7 }, { action: 'restart', pmId: 7 }]);
});

test('service start refuses unknown scripts, malformed names, out-of-root and ambiguous folders', async t => {
  const f = await approvedProject(t);
  let starterCalls = 0;
  const starter: Pm2StartRunner = async () => {
    starterCalls += 1;
    return { ok: true };
  };
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [] });
  const service = new WorkspaceService(f.store, list, undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, starter);
  const approved = await service.register('Project', [f.project]);

  const unknown = await service.serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'missing' });
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.message, /no runnable script/);

  for (const scriptName of ['rm -rf /', '../evil', 'a;b', '']) {
    const malformed = await service.serviceStart(approved.id, { repositoryPath: f.project, scriptName });
    assert.equal(malformed.status, 'failed', scriptName);
    assert.match(malformed.message, /no runnable script/, scriptName);
  }

  const outsideRoot = await service.serviceStart(approved.id, { repositoryPath: f.outside, scriptName: 'dev' });
  assert.equal(outsideRoot.status, 'failed');
  assert.match(outsideRoot.message, /registered project root/);

  const missing = await service.serviceStart(approved.id, { repositoryPath: join(f.project, 'nope'), scriptName: 'dev' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.message, /registered project root/);

  const badName = await service.serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev', name: 'bad name!' });
  assert.equal(badName.status, 'failed');
  assert.match(badName.message, /service name/);

  assert.equal(starterCalls, 0, 'no refusal may reach the PM2 starter');
});

test('service start refuses ambiguous nested roots without invoking PM2', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-service-start-ambiguous-')));
  try {
    const child = join(parent, 'service');
    await mkdir(child);
    await writeFile(join(child, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    let starterCalls = 0;
    const result = await startPm2Service([parent, child], { repositoryPath: child, scriptName: 'dev' },
      async (): Promise<Pm2ListResult> => ({ available: true, processes: [] }),
      async () => {
        starterCalls += 1;
        return { ok: true };
      });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /registered project root/);
    assert.equal(starterCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('service start has no explicit-argv path: extra command fields never reach the starter', async t => {
  const f = await approvedProject(t);
  const starterInputs: unknown[] = [];
  const starter: Pm2StartRunner = async input => {
    starterInputs.push(input);
    return { ok: true };
  };
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.project)] });
  const service = new WorkspaceService(f.store, list, undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, starter);
  const approved = await service.register('Project', [f.project]);

  // Arbitrary shell, out-of-root binary and non-allowlisted interpreter
  // attempts arrive as unknown extra fields; the fixed npm/pm2 argv wins.
  const hostile = {
    repositoryPath: f.project,
    scriptName: 'dev',
    argv: ['rm', '-rf', '/'],
    command: 'bash -c "rm -rf /"',
    interpreter: 'bash',
    shell: true,
  } as unknown as { repositoryPath: string; scriptName: string };
  const result = await service.serviceStart(approved.id, hostile);
  assert.equal(result.status, 'completed');
  assert.equal(starterInputs.length, 1);
  assert.deepEqual(Object.keys(starterInputs[0] as object).sort(), ['cwd', 'name', 'scriptName']);
  assert.deepEqual(starterInputs[0], { name: 'dev', scriptName: 'dev', cwd: f.project });
});

test('service start reports starter and metadata failures honestly', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [] });
  const reads = (store: Store, starter: Pm2StartRunner) =>
    new WorkspaceService(store, list, undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, starter);
  const approved = await reads(f.store, async () => ({ ok: true })).register('Project', [f.project]);

  const missing = await reads(f.store, async () => ({ ok: false, error: 'missing' }))
    .serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.message, /PM2 is unavailable/);

  const timedOut = await reads(f.store, async () => ({ ok: false, error: 'timeout' }))
    .serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.message, /bounded runtime/);

  const failed = await reads(f.store, async () => ({ ok: false, error: 'failed' }))
    .serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /did not start/);

  const stale = new WorkspaceService(f.store, async (): Promise<Pm2ListResult> => ({ available: false, error: 'timeout' }),
    undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, async () => ({ ok: true }));
  const unknown = await stale.serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.message, /fresh service metadata is unavailable/);

  const unmatched = new WorkspaceService(f.store, async (): Promise<Pm2ListResult> => ({ available: true, processes: [] }),
    undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined, async () => ({ ok: true }));
  const ghost = await unmatched.serviceStart(approved.id, { repositoryPath: f.project, scriptName: 'dev' });
  assert.equal(ghost.status, 'unknown');
  assert.match(ghost.message, /could not be matched/);
});

test('controlPm2Service still refuses foreign and anonymous targets after a start', async t => {
  const f = await approvedProject(t);
  let runnerCalls = 0;
  const list = async (): Promise<Pm2ListResult> => ({
    available: true,
    processes: [process(f.project), process(f.outside, { pmId: 9, name: 'other' })],
  });
  const foreign = await controlPm2Service([f.project], 'stop', { pmId: 9, name: 'other', namespace: 'default' }, list, async () => {
    runnerCalls += 1;
    return { ok: true };
  });
  assert.equal(foreign.status, 'failed');
  const anonymous = await controlPm2Service([f.project], 'restart', { pmId: null, name: 'dev' }, list, async () => {
    runnerCalls += 1;
    return { ok: true };
  });
  assert.equal(anonymous.status, 'failed');
  assert.equal(runnerCalls, 0);
});

test('service start route shares the control-service intent gate and audits names only', async t => {
  const f = await approvedProject(t);
  let running = false;
  const service = new WorkspaceService(f.store,
    async (): Promise<Pm2ListResult> => ({ available: true, processes: running ? [process(f.project)] : [] }),
    undefined, undefined, undefined, undefined, undefined, Date.now, emptyDocker(), undefined,
    async () => {
      running = true;
      return { ok: true };
    });
  const mcpToken = 'a'.repeat(64);
  const app = createApp(service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const approved = await service.register('Project', [f.project]);
  const path = `/api/workspaces/${approved.id}/services/start`;
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const startBody = JSON.stringify({ repositoryPath: f.project, scriptName: 'dev' });

  const started = await fetch(`${origin}${path}`, { method: 'POST', headers: mcpHeaders, body: startBody });
  assert.equal(started.status, 200);
  assert.equal((await started.json() as { status: string }).status, 'completed');

  const activity = await service.recentActivity();
  const entry = activity.find(item => item.operation === 'service-start');
  assert.ok(entry, 'start is recorded in activity');
  assert.equal(entry?.detail, 'dev → completed');
  assert.ok(!JSON.stringify(entry).includes('node server.js'), 'script bodies never enter activity');

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(issued.status, 201);
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers: dashboardHeaders, body: startBody })).status, 403);
  assert.equal((await fetch(`${origin}${path}`, {
    method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'wrong' }, body: startBody,
  })).status, 403);
  const dashboardStart = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'control-service' }, body: startBody,
  });
  assert.equal(dashboardStart.status, 200);
  assert.equal((await dashboardStart.json() as { status: string }).status, 'completed');
});
