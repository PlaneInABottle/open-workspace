import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, readPrivateJson, writePrivateJson } from '../src/store.js';

const companion = fileURLToPath(new URL('../bin/openworkspace.mjs', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, connectionFile: string) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const port = Number(env.OPENWORKSPACE_PORT);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`OpenWorkspace exited before readiness (${child.exitCode ?? child.signalCode}): ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      let connectionReady = false;
      if (existsSync(connectionFile)) {
        try {
          const connection = await readPrivateJson(connectionFile) as Record<string, unknown>;
          connectionReady = Object.keys(connection).sort().join(',') === 'mcpToken,origin'
            && connection.origin === `http://127.0.0.1:${port}`
            && typeof connection.mcpToken === 'string';
        } catch {
          connectionReady = false;
        }
      }
      if (response.ok && (await response.json() as { status?: string }).status === 'ready' && connectionReady) {
        return {
          child,
          exited,
          stdout: () => stdout,
          stderr: () => stderr,
          async stop() {
            if (child.exitCode === null) child.kill('SIGTERM');
            await exited;
          },
        };
      }
    } catch {
      // The service is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
  throw new Error(`OpenWorkspace did not become ready: ${stderr}`);
}

async function fakeOpener(root: string, command: string, source: string) {
  const directory = join(root, 'fake-opener-bin');
  await mkdir(directory);
  const executable = join(directory, command);
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return directory;
}

async function openerInterception(root: string, command: string) {
  const capture = join(root, 'opener-calls.jsonl');
  const marker = join(root, 'path-shim-invoked');
  const preload = join(root, 'opener-preload.mjs');
  const preloadReady = join(root, 'opener-preload-ready.json');
  const fakeBin = await fakeOpener(root, command, '#!/bin/sh\nprintf invoked > "$OPENWORKSPACE_TEST_OPENER_MARKER"\n');
  await writeFile(preload, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

const realSpawn = childProcess.spawn;
let readyLogged = false;
const realConsoleLog = console.log;
console.log = function(...values) {
  if (typeof values[0] === 'string' && values[0].startsWith('OpenWorkspace is ready at http://127.0.0.1:')) readyLogged = true;
  return realConsoleLog.apply(this, values);
};
childProcess.spawn = function(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const origin = argv.find(value => typeof value === 'string' && value.startsWith('http://127.0.0.1:'));
  if (!origin) return realSpawn.call(this, command, args, options);
  const environment = options?.env || {};
  const home = process.env.OPENWORKSPACE_HOME || '';
  const record = {
    command: String(command),
    args: argv,
    shell: options?.shell,
    detached: options?.detached,
    stdio: options?.stdio,
    environmentKeys: Object.keys(environment).sort(),
    callerPathForwarded: Object.hasOwn(environment, 'PATH') && environment.PATH !== '/usr/bin:/bin',
    browserForwarded: Object.hasOwn(environment, 'BROWSER'),
    canaryForwarded: Object.hasOwn(environment, 'OPENWORKSPACE_TEST_OPENER_CANARY'),
    credentialForwarded: Object.hasOwn(environment, 'MCP_TOKEN') || Object.hasOwn(environment, 'DASHBOARD_TOKEN'),
    stateHomeForwarded: Object.hasOwn(environment, 'OPENWORKSPACE_HOME'),
    connectionWritten: Boolean(home) && existsSync(join(home, 'connection.json')),
    readyLogged,
    fail: process.env.OPENWORKSPACE_TEST_OPENER_FAILURE === '1',
  };
  appendFileSync(process.env.OPENWORKSPACE_TEST_OPENER_CAPTURE, JSON.stringify(record) + '\\n', { encoding: 'utf8', mode: 0o600 });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => {
    if (record.fail) child.emit('error', new Error('SYNTHETIC_OPENER_FAILURE'));
    else child.emit('exit', 0, null);
  });
  return child;
};
syncBuiltinESMExports();
const namedChildProcess = await import('node:child_process');
const readyPath = process.env.OPENWORKSPACE_TEST_PRELOAD_READY;
if (readyPath) writeFileSync(readyPath, JSON.stringify({ namedBindingPatched: namedChildProcess.spawn === childProcess.spawn }), { mode: 0o600 });
`);
  return { capture, marker, preload, preloadReady, fakeBin };
}

function openerPreloadOptions(preload: string) {
  return `--import=${preload}`;
}

async function assertOpenerInterceptionReady(root: string, opener: Awaited<ReturnType<typeof openerInterception>>) {
  let stderr = '';
  const child = spawn(process.execPath, ['--import', opener.preload, '-e', ''], {
    cwd: root,
    env: {
      ...process.env,
      OPENWORKSPACE_TEST_OPENER_CAPTURE: opener.capture,
      OPENWORKSPACE_TEST_PRELOAD_READY: opener.preloadReady,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0, stderr);
  const readiness = JSON.parse(await readFile(opener.preloadReady, 'utf8')) as { namedBindingPatched?: boolean };
  assert.equal(readiness.namedBindingPatched, true);
}

function openCommandForCurrentPlatform() {
  return process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
}

test('source companion starts headlessly from a Java checkout and writes a secret-free MCP connection', async t => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.pair, undefined);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-start-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const java = join(root, 'java-only');
  await mkdir(java);
  await writeFile(join(java, 'pom.xml'), '<project/>');
  const home = join(root, "private state with spaces and ' quote");
  await new Store(home).initialize();
  const legacyMcpToken = 'f'.repeat(64);
  await writePrivateJson(join(home, 'connection.json'), { origin: 'http://127.0.0.1:4318', token: legacyMcpToken });
  const stateBefore = await readFile(join(home, 'state.json'));
  const openCommand = openCommandForCurrentPlatform();
  if (openCommand) {
    const opener = await openerInterception(root, openCommand);
    await assertOpenerInterceptionReady(root, opener);
    const port = await unusedPort();
    const service = await start(process.execPath, [companion, 'start', '--state-directory', home, '--port', String(port), '--no-open'], java, {
      ...process.env,
      PATH: `${opener.fakeBin}:/no-node-or-pnpm-in-path`,
      HOME: root,
      OPENWORKSPACE_NO_OPEN: '0',
      OPENWORKSPACE_TEST_OPENER_MARKER: opener.marker,
      OPENWORKSPACE_TEST_OPENER_CAPTURE: opener.capture,
      OPENWORKSPACE_TEST_PRELOAD_READY: opener.preloadReady,
      NODE_OPTIONS: openerPreloadOptions(opener.preload),
      OPENWORKSPACE_PORT: String(port),
    }, join(home, 'connection.json'));
    try {
      const origin = `http://127.0.0.1:${port}`;
      const connection = await readPrivateJson(join(home, 'connection.json')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(connection).sort(), ['mcpToken', 'origin']);
      assert.equal(connection.origin, origin);
      const mcpToken = connection.mcpToken;
      assert.equal(typeof mcpToken === 'string' && /^[a-f0-9]{64}$/.test(mcpToken), true);
      assert.equal(mcpToken === legacyMcpToken, false);
      assert.equal(typeof mcpToken === 'string' && service.stdout().includes(mcpToken), false);
      assert.equal(typeof mcpToken === 'string' && service.stderr().includes(mcpToken), false);
      assert.match(service.stdout(), new RegExp(origin.replaceAll('.', '\\.')));
      assert.equal(existsSync(opener.marker), false);
      assert.equal(existsSync(opener.capture), false);
      assert.deepEqual(await readFile(join(home, 'state.json')), stateBefore);
      assert.equal(await readFile(join(java, 'pom.xml'), 'utf8'), '<project/>');
      await assert.rejects(readFile(join(java, 'package.json')));
      assert.equal((await stat(join(home, 'connection.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(home)).mode & 0o777, 0o700);
    } finally {
      await service.stop();
    }
  }
  await assert.rejects(
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [companion, 'pair'], { cwd: java, env: { ...process.env, HOME: root }, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(code) : reject(new Error('removed pair command was still accepted')));
    }),
  );
});

test('OPENWORKSPACE_NO_OPEN keeps a direct headless main launch from invoking the system opener', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-headless-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const openCommand = openCommandForCurrentPlatform();
  if (!openCommand) return;
  const opener = await openerInterception(root, openCommand);
  await assertOpenerInterceptionReady(root, opener);
  const home = join(root, 'isolated state');
  const port = await unusedPort();
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const service = await start(process.execPath, [tsx, main], root, {
    ...process.env,
    HOME: root,
    PATH: `${opener.fakeBin}:${process.env.PATH || ''}`,
    OPENWORKSPACE_HOME: home,
    OPENWORKSPACE_NO_OPEN: '1',
    OPENWORKSPACE_TEST_OPENER_MARKER: opener.marker,
    OPENWORKSPACE_TEST_OPENER_CAPTURE: opener.capture,
    OPENWORKSPACE_TEST_PRELOAD_READY: opener.preloadReady,
    NODE_OPTIONS: openerPreloadOptions(opener.preload),
    OPENWORKSPACE_PORT: String(port),
  }, join(home, 'connection.json'));
  try {
    assert.equal(existsSync(opener.marker), false);
    assert.equal(existsSync(opener.capture), false);
    assert.equal((await readPrivateJson(join(home, 'connection.json')) as Record<string, unknown>).origin, `http://127.0.0.1:${port}`);
  } finally {
    await service.stop();
  }
});

test('a failed automatic opener is attempted once after connection publication and cannot block readiness', { skip: process.platform !== 'darwin' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-opener-failure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opener = await openerInterception(root, 'open');
  await assertOpenerInterceptionReady(root, opener);
  const home = join(root, 'isolated state');
  const port = await unusedPort();
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const service = await start(process.execPath, [tsx, main], root, {
    ...process.env,
    HOME: root,
    PATH: `${opener.fakeBin}:${process.env.PATH || ''}`,
    BROWSER: join(opener.fakeBin, 'browser'),
    OPENWORKSPACE_HOME: home,
    OPENWORKSPACE_NO_OPEN: '0',
    OPENWORKSPACE_PORT: String(port),
    OPENWORKSPACE_TEST_OPENER_MARKER: opener.marker,
    OPENWORKSPACE_TEST_OPENER_CAPTURE: opener.capture,
    OPENWORKSPACE_TEST_PRELOAD_READY: opener.preloadReady,
    OPENWORKSPACE_TEST_OPENER_CANARY: 'SYNTHETIC_OPENER_ENV_SENTINEL',
    OPENWORKSPACE_TEST_OPENER_FAILURE: '1',
    MCP_TOKEN: 'SYNTHETIC_MCP_TOKEN_SENTINEL',
    NODE_OPTIONS: openerPreloadOptions(opener.preload),
  }, join(home, 'connection.json'));
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !service.stderr().includes('OpenWorkspace could not safely open')) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    const records = (await readFile(opener.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      command: string;
      args: string[];
      shell: boolean;
      detached: boolean;
      stdio: string;
      environmentKeys: string[];
      callerPathForwarded: boolean;
      browserForwarded: boolean;
      canaryForwarded: boolean;
      credentialForwarded: boolean;
      stateHomeForwarded: boolean;
      connectionWritten: boolean;
      readyLogged: boolean;
      fail: boolean;
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].command, '/usr/bin/open');
    assert.deepEqual(records[0].args, [`http://127.0.0.1:${port}`]);
    assert.equal(records[0].shell, false);
    assert.equal(records[0].detached, true);
    assert.equal(records[0].stdio, 'ignore');
    assert.deepEqual(records[0].environmentKeys, []);
    for (const key of ['callerPathForwarded', 'browserForwarded', 'canaryForwarded', 'credentialForwarded', 'stateHomeForwarded'] as const) {
      assert.equal(records[0][key], false, `unsafe opener environment category ${key} was forwarded`);
    }
    assert.equal(records[0].connectionWritten, true);
    assert.equal(records[0].readyLogged, true);
    assert.equal(records[0].fail, true);
    assert.equal(existsSync(opener.marker), false);
    assert.match(service.stdout(), new RegExp(`OpenWorkspace is ready at http://127\\.0\\.0\\.1:${port}`));
    assert.match(service.stderr(), new RegExp(`OpenWorkspace could not safely open http://127\\.0\\.0\\.1:${port}`));
    assert.match(service.stderr(), /Open the dashboard URL manually/);
    assert.ok(!service.stderr().includes('SYNTHETIC_OPENER_FAILURE'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await service.stop();
  }
});
