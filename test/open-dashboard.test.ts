import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboardOpenerEnvironment, openDashboard } from '../src/open-dashboard.js';

class OpenChild extends EventEmitter {
  unrefCalls = 0;
  unref() { this.unrefCalls++; }
}

const origin = 'http://127.0.0.1:4318';

test('Darwin launch request uses the verified absolute system tool and strips caller environment', { skip: process.platform !== 'darwin' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-opener-path-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shimDirectory = join(root, 'caller-bin');
  const marker = join(root, 'path-shim-invoked');
  await mkdir(shimDirectory);
  await writeFile(join(shimDirectory, 'open'), `#!/bin/sh\nprintf invoked > "$OPENWORKSPACE_TEST_OPENER_MARKER"\n`, { mode: 0o700 });

  const environmentKeys = ['PATH', 'BROWSER', 'OPENWORKSPACE_TEST_OPENER_MARKER', 'OPENWORKSPACE_OPENER_CANARY', 'MCP_TOKEN'] as const;
  const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.PATH = `${shimDirectory}:${process.env.PATH || ''}`;
  process.env.BROWSER = join(shimDirectory, 'browser-shim');
  process.env.OPENWORKSPACE_TEST_OPENER_MARKER = marker;
  process.env.OPENWORKSPACE_OPENER_CANARY = 'SYNTHETIC_OPENER_ENV_SENTINEL';
  process.env.MCP_TOKEN = 'SYNTHETIC_MCP_TOKEN_SENTINEL';

  try {
    const child = new OpenChild();
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const warnings: string[] = [];
    assert.equal(openDashboard(origin, {
      warn: message => warnings.push(message),
      spawn: ((command, args, options) => {
        calls.push({ command, args, options });
        return child as unknown as Pick<ChildProcess, 'once' | 'unref'>;
      }),
    }), true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/open');
    assert.deepEqual(calls[0].args, [origin]);
    assert.equal(calls[0].options.shell, false);
    const forwardedEnvironment = calls[0].options.env || {};
    assert.deepEqual(Object.keys(forwardedEnvironment), []);
    for (const key of environmentKeys) assert.ok(!Object.hasOwn(forwardedEnvironment, key), `caller environment key ${key} was forwarded`);
    assert.equal(child.unrefCalls, 1);
    assert.equal(existsSync(marker), false);
    child.emit('exit', 0, null);
    assert.deepEqual(warnings, []);
  } finally {
    for (const key of environmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Linux opener receives a fixed system PATH and only desktop session variables', () => {
  const source = {
    PATH: '/tmp/caller-bin:/usr/bin',
    BROWSER: '/tmp/caller-bin/browser',
    HOME: '/tmp/user-home',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/tmp/xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CURRENT_DESKTOP: 'GNOME',
    XDG_SESSION_TYPE: 'wayland',
    XDG_SESSION_DESKTOP: 'gnome',
    OPENWORKSPACE_HOME: '/tmp/private-state',
    OPENWORKSPACE_OPENER_CANARY: 'SYNTHETIC_OPENER_ENV_SENTINEL',
    MCP_TOKEN: 'SYNTHETIC_MCP_TOKEN_SENTINEL',
  };

  const linuxEnvironment = buildDashboardOpenerEnvironment('linux', source);
  assert.deepEqual(Object.keys(linuxEnvironment).sort(), [
    'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'PATH', 'WAYLAND_DISPLAY', 'XAUTHORITY',
    'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE',
  ].sort());
  assert.ok(linuxEnvironment.PATH === '/usr/bin:/bin');
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP'] as const) {
    assert.ok(linuxEnvironment[key] === source[key], `allowed desktop variable ${key} was not retained`);
  }
  for (const key of ['BROWSER', 'HOME', 'OPENWORKSPACE_HOME', 'OPENWORKSPACE_OPENER_CANARY', 'MCP_TOKEN'] as const) {
    assert.ok(!Object.hasOwn(linuxEnvironment, key), `untrusted environment key ${key} was forwarded`);
  }
  assert.deepEqual(Object.keys(buildDashboardOpenerEnvironment('darwin')), []);
  assert.deepEqual(Object.keys(buildDashboardOpenerEnvironment('win32')), []);
});

test('Windows and unknown platforms use manual URL fallback without trusting SystemRoot', () => {
  const originalSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = '/tmp/untrusted-system-root';
  try {
    const warnings: string[] = [];
    let spawnCalls = 0;
    assert.equal(openDashboard(origin, {
      platform: 'win32',
      warn: message => warnings.push(message),
      spawn: () => { spawnCalls++; return new OpenChild() as unknown as Pick<ChildProcess, 'once' | 'unref'>; },
    }), false);
    assert.equal(openDashboard(origin, { platform: 'freebsd', warn: message => warnings.push(message) }), false);
    assert.equal(spawnCalls, 0);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(message => message.includes(origin) && message.includes('manually')));
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
});

test('opener failure is non-fatal, warns safely, and rejects non-canonical URLs', { skip: process.platform !== 'darwin' }, () => {
  const warnings: string[] = [];
  let spawnCalls = 0;
  assert.equal(openDashboard(origin, {
    platform: 'darwin',
    warn: message => warnings.push(message),
    spawn: () => {
      spawnCalls++;
      throw new Error('PRIVATE_OPENER_ERROR_SENTINEL');
    },
  }), false);
  assert.equal(spawnCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /http:\/\/127\.0\.0\.1:4318/);
  assert.match(warnings[0], /Open the dashboard URL manually/);
  assert.ok(!warnings[0].includes('PRIVATE_OPENER_ERROR_SENTINEL'));

  const invalidUrls = [
    'https://outside.example',
    'http://localhost:4318',
    'http://127.0.0.1:4318/path',
    'http://127.0.0.1:4318/?token=SYNTHETIC_URL_TOKEN_SENTINEL',
    'http://127.0.0.1:4318/#SYNTHETIC_URL_TOKEN_SENTINEL',
  ];
  for (const invalidUrl of invalidUrls) {
    assert.equal(openDashboard(invalidUrl, {
      platform: 'darwin',
      warn: message => warnings.push(message),
      spawn: () => { spawnCalls++; return new OpenChild() as unknown as Pick<ChildProcess, 'once' | 'unref'>; },
    }), false);
  }
  assert.equal(spawnCalls, 1);
  assert.equal(warnings.length, invalidUrls.length + 1);
  assert.ok(warnings.slice(1).every(message => !message.includes('SYNTHETIC_URL_TOKEN_SENTINEL')));
  assert.ok(warnings.slice(1).every(message => !message.includes('https://outside.example')));
});

test('asynchronous opener failure reports once without changing the successful spawn result', { skip: process.platform !== 'darwin' }, () => {
  const child = new OpenChild();
  const warnings: string[] = [];
  assert.equal(openDashboard(origin, {
    warn: message => warnings.push(message),
    spawn: () => child as unknown as Pick<ChildProcess, 'once' | 'unref'>,
  }), true);
  child.emit('error', new Error('PRIVATE_ASYNC_OPENER_ERROR_SENTINEL'));
  child.emit('exit', 1, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Open the dashboard URL manually/);
  assert.ok(!warnings[0].includes('PRIVATE_ASYNC_OPENER_ERROR_SENTINEL'));
});
