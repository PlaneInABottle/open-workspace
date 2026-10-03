import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerContainerInventory, listDockerContainers, mapDockerContainers, maximumDockerLogBytes, runDockerLogs, type DockerContainer, type DockerSpawn } from '../src/services-docker.js';
import { readDockerServiceLogs, serviceInventory, type Pm2ListResult, type Pm2Process } from '../src/services.js';

const containerId = 'a'.repeat(64);
const otherContainerId = 'b'.repeat(64);

async function rootsFixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-docker-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, 'project');
  const other = join(parent, 'other');
  await mkdir(project);
  await mkdir(other);
  return { parent, project, other };
}

function dockerContainer(id: string, name: string, labels: Record<string, string> = {}): DockerContainer {
  return { id, name, image: 'postgres:17', state: 'running', labels };
}

type FakeOutput = Buffer | string | Array<Buffer | string>;

function emitOutput(stream: EventEmitter, output: FakeOutput | undefined) {
  if (output === undefined) return;
  for (const chunk of Array.isArray(output) ? output : [output]) stream.emit('data', chunk);
}

function scriptedSpawn(responses: Array<{ stdout?: FakeOutput; stderr?: FakeOutput; code?: number; error?: Error }>, calls: Array<{ command: string; args: string[]; shell: unknown }> = []): DockerSpawn {
  const fake = (command: string, args: string[], options: { shell?: boolean }) => {
    calls.push({ command, args, shell: options.shell });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const response = responses.shift();
    queueMicrotask(() => {
      if (!response) return child.emit('close', 1);
      if (response.error) return child.emit('error', response.error);
      emitOutput(child.stdout, response.stdout);
      emitOutput(child.stderr, response.stderr);
      child.emit('close', response.code ?? 0);
    });
    return child as never;
  };
  return fake as unknown as DockerSpawn;
}

function inspectJson(id: string, name: string, labels: Record<string, string>) {
  return JSON.stringify([{
    Id: id,
    Name: `/${name}`,
    Config: { Image: 'postgres:17', Labels: labels },
    State: { Status: 'running' },
  }]);
}

test('Docker mapping uses only exact Compose labels; disagreement is ambiguous and missing labels stay unmanaged', async t => {
  const f = await rootsFixture(t);
  const mapped = await mapDockerContainers([f.project, f.other], [
    dockerContainer(containerId, 'db', { 'com.docker.compose.project.working_dir': f.project }),
    dockerContainer(otherContainerId, 'ambiguous', {
      'com.docker.compose.project.working_dir': f.project,
      'com.docker.compose.project.config_files': `${join(f.other, 'compose.yaml')}`,
    }),
    dockerContainer('c'.repeat(64), 'prefix-only', { 'com.docker.compose.project.working_dir': join(f.project, 'nested') }),
    dockerContainer('d'.repeat(64), 'unlabeled'),
  ]);

  assert.deepEqual(mapped.services.map(service => [service.runner, service.name, service.exactRootPath]), [['docker', 'db', f.project]]);
  assert.equal(mapped.ambiguousContainerCount, 1);
  assert.deepEqual(mapped.unmanagedContainers.map(container => [container.name, container.mappingStatus]), [
    ['ambiguous', 'ambiguous'], ['prefix-only', 'unmatched'], ['unlabeled', 'unmatched'],
  ]);
  assert.deepEqual(mapped.unmanagedContainers[0].matchedRoots, [f.project, f.other]);
  assert.ok(!JSON.stringify(mapped).includes('nested'));
});

test('an explicit exact-ID link overrides label mapping without guessing a root', async t => {
  const f = await rootsFixture(t);
  const mapped = await mapDockerContainers([f.project, f.other], [
    dockerContainer(containerId, 'task-db', {
      'com.docker.compose.project.working_dir': f.project,
      'com.docker.compose.project.config_files': join(f.other, 'compose.yaml'),
    }),
  ], [containerId]);
  assert.equal(mapped.services.length, 1);
  assert.equal(mapped.services[0].mappingSource, 'explicit-link');
  assert.equal(mapped.services[0].exactRootPath, null, 'workspace linkage does not invent a specific root');
  assert.deepEqual(mapped.services[0].matchedRoots, []);
  assert.deepEqual(mapped.unmanagedContainers, []);
  assert.equal(mapped.ambiguousContainerCount, 0);
});

test('Docker list invokes bounded read-only argv and maps inspect metadata without exposing labels', async t => {
  const f = await rootsFixture(t);
  const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
  const labels = { 'com.docker.compose.project.working_dir': f.project, 'private-label': 'must-not-escape' };
  const list = await listDockerContainers({ spawn: scriptedSpawn([
    { stdout: `${containerId}\n` },
    { stdout: inspectJson(containerId, 'db', labels) },
  ], calls) });

  assert.equal(list.available, true);
  if (list.available) {
    assert.deepEqual(list.containers, [{ id: containerId, name: 'db', image: 'postgres:17', state: 'running', labels }]);
  }
  assert.deepEqual(calls, [
    { command: 'docker', args: ['ps', '--all', '--quiet', '--no-trunc'], shell: false },
    { command: 'docker', args: ['inspect', containerId], shell: false },
  ]);
  const defaultInventory = await dockerContainerInventory([], async () => list);
  assert.equal(defaultInventory.unmanagedContainerCount, 1);
  assert.deepEqual(defaultInventory.unmanagedContainers, []);
  assert.ok(!JSON.stringify(defaultInventory).includes('must-not-escape'));
  const detailedInventory = await dockerContainerInventory([], async () => list, { includeUnmanaged: true });
  assert.equal(detailedInventory.unmanagedContainerCount, 1);
  assert.equal(detailedInventory.unmanagedContainers[0].name, 'db');
  assert.equal(detailedInventory.unmanagedContainers[0].image, 'postgres:17');
});

test('missing executable, unreachable daemon, and denied access remain distinct and safe', async () => {
  const missing = await listDockerContainers({ spawn: scriptedSpawn([{ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }]) });
  assert.deepEqual(missing, { available: false, error: 'executable-missing' });
  const daemon = await listDockerContainers({ spawn: scriptedSpawn([{ stderr: 'Cannot connect to the Docker daemon at unix:///private/docker.sock. Is the docker daemon running?', code: 1 }]) });
  assert.deepEqual(daemon, { available: false, error: 'daemon-unreachable' });
  const permission = await listDockerContainers({ spawn: scriptedSpawn([{ stderr: 'Cannot connect to the Docker daemon: permission denied while connecting to docker.sock', code: 1 }]) });
  assert.deepEqual(permission, { available: false, error: 'access-denied' });
  const deniedExecutable = await listDockerContainers({ spawn: scriptedSpawn([{ error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) }]) });
  assert.deepEqual(deniedExecutable, { available: false, error: 'access-denied' });
  const logFailures = await Promise.all([
    runDockerLogs(containerId, 5, { spawn: scriptedSpawn([{ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }]) }),
    runDockerLogs(containerId, 5, { spawn: scriptedSpawn([{ stderr: 'Cannot connect to the Docker daemon; is the docker daemon running?', code: 1 }]) }),
    runDockerLogs(containerId, 5, { spawn: scriptedSpawn([{ stderr: 'Cannot connect to Docker daemon: permission denied', code: 1 }]) }),
  ]);
  assert.deepEqual(logFailures.map(result => result.ok ? null : result.error), [
    'executable-missing', 'daemon-unreachable', 'access-denied',
  ]);

  const inventories = await Promise.all([missing, daemon, permission].map(result => dockerContainerInventory(['/not-used'], async () => result)));
  assert.deepEqual(inventories.map(inventory => inventory.message), [
    'Docker CLI is unavailable.', 'Docker daemon is unreachable.', 'Docker access was denied.',
  ]);
  assert.ok(inventories.every(inventory => inventory.unmanagedContainerCount === 0));
});

test('service inventory keeps PM2 and Docker runners distinct and defaults to unmanaged counts', async t => {
  const f = await rootsFixture(t);
  const pm2: Pm2Process = { pmId: 4, name: 'api', namespace: null, status: 'online', cwd: f.project, restartCount: 0, startedAt: null };
  const listPm2 = async (): Promise<Pm2ListResult> => ({ available: true, processes: [pm2] });
  const listDocker = async () => ({ available: true as const, containers: [
    dockerContainer(containerId, 'postgres', { 'com.docker.compose.project.working_dir': f.project }),
    dockerContainer(otherContainerId, 'independent-cache'),
  ] });
  const inventory = await serviceInventory([f.project], listPm2, listDocker);

  assert.equal(inventory.services[0].runner, 'pm2');
  assert.equal(inventory.docker.available, true);
  assert.equal(inventory.docker.services[0].runner, 'docker');
  assert.equal(inventory.docker.services[0].containerId, containerId);
  assert.deepEqual(inventory.docker.unmanagedContainers, []);
  assert.equal(inventory.docker.unmanagedContainerCount, 1);
  const details = await serviceInventory([f.project], listPm2, listDocker, { includeUnmanaged: true });
  assert.deepEqual(details.docker.unmanagedContainers.map(container => [container.name, container.mappingStatus]), [['independent-cache', 'unmatched']]);
  assert.equal(details.docker.unmanagedContainers[0].runner, 'docker');
});

test('Docker log tail is no-follow, timestamped, combined, and capped to newest 64 KiB', async () => {
  const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
  const output = Buffer.concat([Buffer.from('old-record-marker\n'), Buffer.alloc(70 * 1024, 'x'), Buffer.from('\nnewest-record-marker\n')]);
  const result = await runDockerLogs(containerId, 200, { spawn: scriptedSpawn([{ stdout: output }], calls) });

  assert.deepEqual(calls, [{ command: 'docker', args: ['logs', '--tail', '200', '--timestamps', containerId], shell: false }]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= 64 * 1024);
    assert.ok(result.output.endsWith('newest-record-marker'));
    assert.ok(!result.output.includes('old-record-marker'));
  }
});

test('malformed UTF-8 log expansion is trimmed in bounded linear time', async () => {
  const malformed = Buffer.alloc(maximumDockerLogBytes, 0xff);
  const started = performance.now();
  const result = await runDockerLogs(containerId, 200, { spawn: scriptedSpawn([{ stdout: malformed }]) });
  const elapsedMs = performance.now() - started;

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true, 'decoded replacement characters expand beyond the byte budget');
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= maximumDockerLogBytes);
    assert.ok(result.output.includes('\ufffd'));
  }
  assert.ok(elapsedMs < 2000, `64 KiB malformed tail took ${elapsedMs.toFixed(1)} ms`);
});

test('one-byte log fragments are evicted linearly from stdout and stderr tails', async () => {
  const fragmentCount = maximumDockerLogBytes + 8192;
  const stdoutFragment = Buffer.from('x');
  const stderrFragment = Buffer.from('y');
  const stdout = new Array<Buffer>(fragmentCount).fill(stdoutFragment);
  const stderr = new Array<Buffer>(fragmentCount).fill(stderrFragment);
  stdout[0] = Buffer.from('O');
  stdout[fragmentCount - 1] = Buffer.from('N');
  stderr[0] = Buffer.from('P');
  stderr[fragmentCount - 1] = Buffer.from('Z');

  const started = performance.now();
  const result = await runDockerLogs(containerId, 200, { spawn: scriptedSpawn([{ stdout, stderr }]) });
  const elapsedMs = performance.now() - started;

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= maximumDockerLogBytes);
    assert.ok(result.output.endsWith('Z'), 'the newest stderr fragment is retained');
    assert.ok(!result.output.includes('O') && !result.output.includes('P'), 'oldest fragments are evicted');
  }
  assert.ok(elapsedMs < 2000, `${fragmentCount} one-byte fragments per stream took ${elapsedMs.toFixed(1)} ms`);
});

test('valid UTF-8 split across chunks at the byte-cap edge decodes intact', async () => {
  const result = await runDockerLogs(containerId, 200, { spawn: scriptedSpawn([{ stdout: [
    Buffer.alloc(maximumDockerLogBytes - 1, 0x78),
    Buffer.from([0xf0, 0x9f]),
    Buffer.from([0x8c]),
    Buffer.from([0x9f]),
  ] }]) });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= maximumDockerLogBytes);
    assert.ok(result.output.endsWith('🌟'));
    assert.ok(!result.output.includes('\ufffd'));
  }
});

test('Docker service logs recheck exact root mapping and never tail unmanaged containers', async t => {
  const f = await rootsFixture(t);
  const target = { runner: 'docker' as const, containerId, name: 'db' };
  const list = async () => ({ available: true as const, containers: [dockerContainer(containerId, 'db', { 'com.docker.compose.project.working_dir': f.project })] });
  let calls = 0;
  const result = await readDockerServiceLogs([f.project], target, {
    lines: 7,
    list,
    runner: async (id, lines) => {
      calls += 1;
      assert.equal(id, containerId);
      assert.equal(lines, 7);
      return { ok: true, output: 'one\ntwo', truncated: false };
    },
  });
  assert.equal(result.linesReturned, 2);
  assert.equal(result.output, 'one\ntwo');
  assert.equal('runner' in result.target ? result.target.runner : null, 'docker');

  const unmanaged = await readDockerServiceLogs([f.project], target, {
    list: async () => ({ available: true, containers: [dockerContainer(containerId, 'db')] }),
    runner: async () => { calls += 1; return { ok: true, output: 'wrong', truncated: false }; },
  });
  assert.match(unmanaged.message, /not uniquely mapped/);
  assert.equal(unmanaged.output, '');
  assert.equal(calls, 1);

  const wrongStream = await readDockerServiceLogs([f.project], target, { stream: 'err', list });
  assert.match(wrongStream.message, /combined container logs/);
  assert.equal(wrongStream.output, '');
});

test('explicit container links authorize exact-ID bounded log tails and stale links stay inert', async t => {
  const f = await rootsFixture(t);
  const target = { runner: 'docker' as const, containerId, name: 'task-db' };
  let calls = 0;
  const result = await readDockerServiceLogs([f.project, f.other], target, {
    linkedContainerIds: [containerId],
    lines: 9,
    list: async () => ({ available: true, containers: [
      dockerContainer(containerId, 'task-db', {
        'com.docker.compose.project.working_dir': f.project,
        'com.docker.compose.project.config_files': join(f.other, 'compose.yaml'),
      }),
    ] }),
    runner: async (id, lines) => {
      calls += 1;
      assert.equal(id, containerId);
      assert.equal(lines, 9);
      return { ok: true, output: 'bounded-container-tail', truncated: false };
    },
  });
  assert.equal(result.output, 'bounded-container-tail');
  assert.equal(calls, 1);

  const missing = await readDockerServiceLogs([f.project], target, {
    linkedContainerIds: [containerId],
    list: async () => ({ available: true, containers: [] }),
    runner: async () => { calls += 1; return { ok: true, output: 'wrong', truncated: false }; },
  });
  assert.equal(missing.message, 'The linked Docker container is no longer available.');
  assert.equal(missing.output, '');
  assert.equal(calls, 1, 'a disappeared link never invokes docker logs');
});

test('Docker log results preserve safe failure distinctions through service messages', async t => {
  const f = await rootsFixture(t);
  const target = { runner: 'docker' as const, containerId, name: 'db' };
  const list = async () => ({ available: true as const, containers: [dockerContainer(containerId, 'db', { 'com.docker.compose.project.working_dir': f.project })] });
  const cases = [
    ['executable-missing', 'Docker CLI is unavailable.'],
    ['daemon-unreachable', 'Docker daemon is unreachable.'],
    ['access-denied', 'Docker access was denied.'],
  ] as const;
  const results = await Promise.all(cases.map(([error]) => readDockerServiceLogs([f.project], target, {
    list,
    runner: async () => ({ ok: false as const, error }),
  })));
  assert.deepEqual(results.map(result => result.message), cases.map(([, message]) => message));
  assert.ok(results.every(result => result.output === '' && result.linesReturned === 0));
});

test('Compose config-file labels map directly to the root and log results remain caller-only', async t => {
  const f = await rootsFixture(t);
  const secretLog = 'APP_PRINTED_SECRET_SENTINEL';
  const target = { runner: 'docker' as const, containerId, name: 'db' };
  const result = await readDockerServiceLogs([f.project], target, {
    list: async () => ({ available: true, containers: [dockerContainer(containerId, 'db', { 'com.docker.compose.project.config_files': join(f.project, 'compose.yaml') })] }),
    runner: async () => ({ ok: true, output: secretLog, truncated: true }),
  });
  assert.equal(result.output, secretLog);
  assert.equal(result.truncated, true);
  // The response carries log text to the caller; activity/state are written by
  // the HTTP layer using only the target name and linesReturned, never output.
  assert.equal(JSON.stringify({ target: result.target, linesReturned: result.linesReturned }).includes(secretLog), false);
});
