import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CommandOutcome, CommandRunner } from '../src/verify.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

function okOutcome(stdout: string, extra: Partial<CommandOutcome> = {}): CommandOutcome {
  return { exitCode: 0, timedOut: false, aborted: false, truncated: false, stdout, stderr: '', durationMs: 1, spawnFailed: false, ...extra };
}

interface CapturedCall {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

// example.com is scripted as public; localhost scripted as loopback-only.
// Real DNS is never consulted by these injected cases.
async function scriptedLookup(host: string): Promise<string[]> {
  if (host === 'localhost') return ['127.0.0.1', '::1'];
  if (host === 'example.com') return ['93.184.216.34'];
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
}

function batchEntry(command: unknown, result: unknown, success = true) {
  return { command, error: null, result, success };
}

function snapshotBatch(url: string, finalUrl: string, snapshot: string) {
  return JSON.stringify([
    batchEntry(['open', url], { url: finalUrl, title: 'Fixture' }),
    batchEntry(['snapshot'], { snapshot, origin: finalUrl }),
    batchEntry(['get', 'url'], { url: finalUrl }),
  ]);
}

function scriptedRunner(stdout: string | ((args: string[]) => string), outcome: Partial<CommandOutcome> = {}) {
  const calls: CapturedCall[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env, input: options.input });
    if (args.includes('close')) return okOutcome('');
    const text = typeof stdout === 'function' ? stdout(args) : stdout;
    return { ...okOutcome(text), ...outcome };
  };
  return { run, calls };
}

async function registeredService(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-browser-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  await mkdir(first);
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  const binary = join(binDir, 'agent-browser');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Browser project', [first]);
  return { root, first, binary, binDir, store, service, workspace };
}

test('browser check denies non-loopback and non-http URLs without spawning', async t => {
  const { service, workspace, binDir } = await registeredService(t);
  const { run, calls } = scriptedRunner('[]');
  const denied = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://127.0.0.1/x',
    'http://example.com/',
    'https://example.com:443/',
    'http://192.0.2.1/',
    'http://[::2]/',
    'http://user:secret@127.0.0.1:3000/',
    'http://unknown.invalid/',
  ];
  for (const url of denied) {
    await assert.rejects(
      service.browserCheck(workspace.name, { url }, { run, lookupHost: scriptedLookup, searchPath: binDir }),
      /Provide an http\(s\) loopback URL\./,
      url,
    );
  }
  assert.equal(calls.length, 0);
});

test('browser check runs one owned batch with exact argv, cwd, minimal env, then closes', async t => {
  const { service, workspace, first, binary, binDir } = await registeredService(t);
  const url = 'http://127.0.0.1:4318/';
  const { run, calls } = scriptedRunner(snapshotBatch(url, url, '- heading "Owned"'));
  process.env.OW_BROWSER_SECRET = 'must-not-leak';
  try {
    const result = await service.browserCheck(workspace.name, { url }, { run, lookupHost: scriptedLookup, searchPath: binDir });
    assert.equal(result.ok, true);
    assert.match(result.snapshotText, /Owned/);
    assert.equal(result.assertFound, null);
    assert.equal(result.truncated, false);
    assert.ok(typeof result.durationMs === 'number');
  } finally {
    delete process.env.OW_BROWSER_SECRET;
  }
  assert.equal(calls.length, 2);
  const [check, close] = calls;
  assert.equal(check.command, binary);
  assert.match(check.args[1], /^ow-[0-9a-f]{12}$/);
  assert.deepEqual(check.args, ['--session', check.args[1], 'batch', '--bail', '--json']);
  assert.deepEqual(JSON.parse(check.input ?? ''), [['open', url], ['snapshot'], ['get', 'url']]);
  assert.equal(check.cwd, first);
  assert.ok(check.env?.PATH);
  assert.ok(!('OW_BROWSER_SECRET' in (check.env ?? {})), 'spawn env stays minimal');
  assert.deepEqual(close.args, ['--session', check.args[1], 'close']);
  assert.equal(close.command, binary);
  assert.equal(close.cwd, first);
});

test('browser check reports the substring predicate', async t => {
  const { service, workspace, binDir } = await registeredService(t);
  const url = 'http://127.0.0.1:4318/';
  const batch = snapshotBatch(url, url, 'welcome to the owned fixture');
  const found = await service.browserCheck(workspace.name, { url, assertText: 'owned' }, {
    run: scriptedRunner(batch).run, lookupHost: scriptedLookup, searchPath: binDir,
  });
  assert.equal(found.assertFound, true);
  const missing = await service.browserCheck(workspace.name, { url, assertText: 'absent' }, {
    run: scriptedRunner(batch).run, lookupHost: scriptedLookup, searchPath: binDir,
  });
  assert.equal(missing.assertFound, false);
});

test('browser check refuses a final URL outside loopback', async t => {
  const { service, workspace, binDir } = await registeredService(t);
  const url = 'http://127.0.0.1:4318/';
  // The browser landed somewhere the pre-check allowed; the post-navigation
  // re-check must still refuse it.
  const batch = snapshotBatch(url, 'http://example.com/', 'elsewhere');
  const { run, calls } = scriptedRunner(batch);
  await assert.rejects(
    service.browserCheck(workspace.name, { url }, { run, lookupHost: scriptedLookup, searchPath: binDir }),
    /redirected outside loopback/,
  );
  assert.equal(calls.length, 2, 'the owned session is still closed on denial');
  assert.deepEqual(calls[1].args.slice(0, 1), ['--session']);
  assert.equal(calls[1].args[2], 'close');
});

test('browser check propagates truncation and timeout flags', async t => {
  const { service, workspace, binDir } = await registeredService(t);
  const url = 'http://127.0.0.1:4318/';
  const batch = snapshotBatch(url, url, 'short');
  const { run } = scriptedRunner(batch, { truncated: true });
  const truncated = await service.browserCheck(workspace.name, { url }, { run, lookupHost: scriptedLookup, searchPath: binDir });
  assert.equal(truncated.truncated, true);
  const long = await service.browserCheck(workspace.name, { url }, {
    run: scriptedRunner(snapshotBatch(url, url, 'x'.repeat(40 * 1024))).run,
    lookupHost: scriptedLookup, searchPath: binDir,
  });
  assert.equal(long.truncated, true);
  assert.ok(long.snapshotText.length <= 32 * 1024);
  const { run: slow } = scriptedRunner(batch, { timedOut: true, exitCode: null });
  await assert.rejects(
    service.browserCheck(workspace.name, { url }, { run: slow, lookupHost: scriptedLookup, searchPath: binDir }),
    /did not finish within the bounded runtime/,
  );
});

test('browser check reports honestly when the binary is missing or fails', async t => {
  const { service, workspace, binDir } = await registeredService(t);
  const fixtureBinDir = binDir;
  const url = 'http://127.0.0.1:4318/';
  const emptyDir = join(workspace.roots[0], '..', 'empty-bin');
  await mkdir(emptyDir);
  await assert.rejects(
    service.browserCheck(workspace.name, { url }, { run: scriptedRunner('[]').run, lookupHost: scriptedLookup, searchPath: emptyDir }),
    /Browser check is unavailable\./,
  );
  const failing: CommandRunner = async () => ({ ...okOutcome(''), spawnFailed: true });
  await assert.rejects(
    service.browserCheck(workspace.name, { url }, { run: failing, lookupHost: scriptedLookup, searchPath: fixtureBinDir }),
    /Browser check is unavailable\./,
  );
});

test('HTTP browser route denies non-loopback with a safe message and clean activity', async t => {
  const { store, service, workspace } = await registeredService(t);
  const app = createApp(service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const denied = await fetch(`${origin}/api/workspaces/${workspace.name}/browser/check`, {
    method: 'POST', headers, body: JSON.stringify({ url: 'http://example.com/' }),
  });
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: 'Provide an http(s) loopback URL.' });
  const unknown = await fetch(`${origin}/api/workspaces/Missing%20project/browser/check`, {
    method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:9/' }),
  });
  assert.equal(unknown.status, 400);
  const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).json() as Array<{ detail: string }>;
  assert.ok(!JSON.stringify(activity).includes('example.com'), 'activity must never carry URLs');
});

test('MCP advertises browser_check within token budgets', async t => {
  const { store } = await registeredService(t);
  const app = createApp(new WorkspaceService(store), { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-browser-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  const tool = tools.tools.find(candidate => candidate.name === 'browser_check');
  assert.ok(tool, 'browser_check is advertised');
  assert.ok((tool.description ?? '').length <= 200, `description ${(tool.description ?? '').length} chars`);
  const properties = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.deepEqual(Object.keys(properties).sort(), ['assertText', 'timeoutMs', 'url', 'workspace']);
  for (const [key, schema] of Object.entries(properties)) {
    assert.ok(!schema.description || schema.description.length <= 80, `${key} description budget`);
  }
  assert.ok(!JSON.stringify(tool).includes('example'), 'listTools carries no examples');
});

test('owned loopback goto and snapshot through the real CLI when present', async t => {
  let binary = false;
  try {
    execFileSync('agent-browser', ['--version'], { stdio: 'ignore' });
    binary = true;
  } catch { /* Honest skip below. */ }
  if (!binary) {
    t.skip('agent-browser is not on PATH');
    return;
  }
  const { service, workspace } = await registeredService(t);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Owned</title></head><body><h1>Owned loopback probe</h1></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  const result = await service.browserCheck(workspace.name, { url, assertText: 'Owned loopback probe' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.assertFound, true);
  assert.match(result.snapshotText, /Owned loopback probe/);
  assert.equal(result.truncated, false);
});
