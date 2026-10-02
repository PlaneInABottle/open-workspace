import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickProjectRoots, projectRootPickerScript, projectRootPickerTimeoutMs } from '../src/project-root-picker.js';
import { trustedSystemPath } from '../src/trusted-system.js';

class PickerChild extends EventEmitter {
  stdout = new PassThrough();
  killCalls: string[] = [];
  kill(signal: string) {
    this.killCalls.push(signal);
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

const selectedRoots = ['/tmp/Repository 🌿\nwith newline', "/tmp/other user's repository"];

function injectedPicker(child: PickerChild, capture: { command?: string; args?: string[]; options?: SpawnOptions }) {
  return pickProjectRoots(undefined, {
    platform: 'darwin',
    spawn: ((command, args, options) => {
      capture.command = command;
      capture.args = args;
      capture.options = options;
      return child as unknown as Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream };
    }),
  });
}

test('picker uses only the trusted absolute macOS helper, static script and minimal process options', { skip: process.platform !== 'darwin' }, async () => {
  const script = new Function(projectRootPickerScript);
  assert.equal(typeof script, 'function');
  assert.match(projectRootPickerScript, /chooseFolder/);
  assert.match(projectRootPickerScript, /multipleSelectionsAllowed:\s*true/);
  assert.match(projectRootPickerScript, /JSON\.stringify/);
  assert.doesNotMatch(projectRootPickerScript, /do shell script|process\.env|ARGV/);

  const child = new PickerChild();
  const capture: { command?: string; args?: string[]; options?: SpawnOptions } = {};
  const result = injectedPicker(child, capture);
  const output = Buffer.from(JSON.stringify({ status: 'selected', roots: selectedRoots }));
  const emoji = Buffer.from('🌿');
  const splitAt = output.indexOf(emoji) + 1;
  child.stdout.write(output.subarray(0, splitAt));
  child.stdout.end(output.subarray(splitAt));
  setImmediate(() => child.emit('close', 0, null));

  assert.deepEqual(await result, { status: 'selected', roots: selectedRoots });
  assert.equal(capture.command, '/usr/bin/osascript');
  assert.deepEqual(capture.args?.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(capture.args?.[3], projectRootPickerScript);
  assert.equal(capture.options?.shell, false);
  assert.equal(capture.options?.detached, false);
  assert.deepEqual(capture.options?.stdio, ['ignore', 'pipe', 'ignore']);
  assert.deepEqual(Object.keys(capture.options?.env || {}), []);
  assert.deepEqual(child.killCalls, []);
});

test('trusted osascript parses the static JXA and JSON-serializes Unicode and newline paths without opening a dialog', { skip: process.platform !== 'darwin' }, () => {
  const executable = trustedSystemPath('/usr/bin/osascript', 'file');
  assert.ok(executable);
  const compile = `Function(${JSON.stringify(projectRootPickerScript)}); "compiled";`;
  const parsed = spawnSync(executable, ['-l', 'JavaScript', '-e', compile], { shell: false, env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 2048 });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.status, 0);
  assert.equal(parsed.stdout.trim(), 'compiled');

  const samplePath = '/tmp/JXA Unicode 🌿\nroot';
  const serialize = `const path = Path(${JSON.stringify(samplePath)}); JSON.stringify({status:"selected", roots:[path.toString()]});`;
  const serialized = spawnSync(executable, ['-l', 'JavaScript', '-e', serialize], { shell: false, env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 2048 });
  assert.equal(serialized.error, undefined);
  assert.equal(serialized.status, 0);
  assert.deepEqual(JSON.parse(serialized.stdout.trim()), { status: 'selected', roots: [samplePath] });
  assert.equal(serialized.stderr, '');
});

test('system process trust rejects a task-owned executable and its writable ancestors', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-untrusted-bin-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'osascript');
  await writeFile(candidate, '#!/bin/sh\nexit 0\n');
  await chmod(candidate, 0o700);
  assert.equal(trustedSystemPath(candidate, 'file'), undefined);
  assert.equal(trustedSystemPath(root, 'directory'), undefined);
});

test('native chooser cancellation and malformed output never become a proposal', { skip: process.platform !== 'darwin' }, async () => {
  const cancelled = new PickerChild();
  const cancelledResult = injectedPicker(cancelled, {});
  cancelled.stdout.end(JSON.stringify({ status: 'cancelled' }));
  setImmediate(() => cancelled.emit('close', 0, null));
  assert.deepEqual(await cancelledResult, { status: 'cancelled' });

  const malformed = new PickerChild();
  const malformedResult = injectedPicker(malformed, {});
  malformed.stdout.end(Buffer.concat([
    Buffer.from('{"status":"selected","roots":["/tmp/'),
    Buffer.from([0xff]),
    Buffer.from('"]}'),
  ]));
  setImmediate(() => malformed.emit('close', 0, null));
  assert.deepEqual(await malformedResult, { status: 'error' });

  const invalidRoots = new PickerChild();
  const invalidRootsResult = injectedPicker(invalidRoots, {});
  invalidRoots.stdout.end(JSON.stringify({ status: 'selected', roots: ['/tmp/parent', '/tmp/parent/child'] }));
  setImmediate(() => invalidRoots.emit('close', 0, null));
  assert.deepEqual(await invalidRootsResult, { status: 'error' });
});

test('unsupported hosts remain unavailable regardless of user-controlled SystemRoot', async () => {
  let spawnCalls = 0;
  const originalSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = '/tmp/untrusted-system-root';
  try {
    for (const platform of ['linux', 'win32'] as const) {
      const result = await pickProjectRoots(undefined, {
        platform,
        spawn: () => { spawnCalls++; return new PickerChild() as unknown as Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream }; },
      });
      assert.deepEqual(result, { status: 'unavailable' });
    }
    assert.equal(spawnCalls, 0);
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
});

test('the five-minute deadline and request abort terminate only the owned helper', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(projectRootPickerTimeoutMs, 5 * 60 * 1000);
  const timedChild = new PickerChild();
  const timedResult = await pickProjectRoots(undefined, {
    platform: 'darwin',
    timeoutMs: 10,
    spawn: () => timedChild as unknown as Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream },
  });
  assert.deepEqual(timedResult, { status: 'timeout' });
  assert.deepEqual(timedChild.killCalls, ['SIGTERM']);

  const controller = new AbortController();
  const abortedChild = new PickerChild();
  const abortedPromise = pickProjectRoots(controller.signal, {
    platform: 'darwin',
    spawn: () => abortedChild as unknown as Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream },
  });
  controller.abort();
  assert.deepEqual(await abortedPromise, { status: 'aborted' });
  assert.deepEqual(abortedChild.killCalls, ['SIGTERM']);
});

test('oversized native helper output is rejected and terminates only that helper', { skip: process.platform !== 'darwin' }, async () => {
  const child = new PickerChild();
  const result = pickProjectRoots(undefined, {
    platform: 'darwin',
    spawn: () => child as unknown as Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream },
  });
  child.stdout.write(Buffer.alloc(512 * 1024 + 1, 0x20));
  assert.deepEqual(await result, { status: 'error' });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});
