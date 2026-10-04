import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { controlPm2Service, runPm2Start, startPm2Service, type Pm2ListResult, type Pm2Process } from '../src/services.js';

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

