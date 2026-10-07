// Open-loopback dashboard auth: no browser token exists. Requests without a
// bearer are the local dashboard; the MCP bearer is the bridge; any other
// bearer is rejected. Loopback Host/Origin/fetch-metadata checks stay intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function rawRequest(origin: string, pathname: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}) {
  const url = new URL(pathname, origin);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: options.method || 'GET', headers: options.headers }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: responseBody,
      }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function rawChunkRequest(origin: string, pathname: string, headers: Record<string, string>, chunks: Buffer[]) {
  const url = new URL(pathname, origin);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body: responseBody }));
    });
    request.on('error', reject);
    request.flushHeaders();
    void (async () => {
      try {
        for (const chunk of chunks) {
          await new Promise<void>((resolve, reject) => request.write(chunk, error => error ? reject(error) : resolve()));
        }
        request.end();
      } catch (error) { reject(error); }
    })();
  });
}

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-dashboard-auth-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, project, store, service: new WorkspaceService(store) };
}

test('dashboard routes respond loopback without a token; unknown bearers are rejected', async t => {
  const f = await fixture(t);
  const mcpToken = 'f'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  // No token: the open-loopback dashboard reads and writes.
  assert.equal((await fetch(`${origin}/api/overview`)).status, 200);
  const registration = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Dashboard project', roots: [f.project] }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { id: string; name: string };
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.name}`)).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.name}`, { method: 'DELETE' })).status, 200);

  // The MCP bearer keeps working for workspace operations.
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders };
  const mcpRegistration = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'MCP project', roots: [f.project] }),
  });
  assert.equal(mcpRegistration.status, 201);

  // An unknown bearer is never dashboard access. A malformed Authorization
  // header carries no valid bearer, so it is ignored like no header.
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${'e'.repeat(64)}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: 'malformed authorization' } })).status, 200);

  // The removed session routes are gone: the dashboard falls through to 404
  // while the MCP credential fails closed at the role gate (403).
  assert.equal((await fetch(`${origin}/api/dashboard-session`, { method: 'POST', headers: jsonHeaders, body: '{}' })).status, 404);
  assert.equal((await fetch(`${origin}/api/dashboard-session`, { method: 'POST', headers: mcpHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/dashboard-session`, { method: 'DELETE', headers: mcpHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: mcpHeaders })).status, 403);

  // Loopback Host/Origin/fetch-metadata checks still deny outsiders.
  const differentHost = await rawRequest(origin, '/api/overview', {
    headers: { Host: `127.0.0.1:${Number(new URL(origin).port) + 1}` },
  });
  assert.equal(differentHost.status, 403);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

  // No credential is echoed into the served page.
  const page = await fetch(origin);
  const html = await page.text();
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.ok(!html.includes(mcpToken));
});

test('dashboard and MCP share workspace operations; picker and client config stay dashboard-only', async t => {
  const f = await fixture(t);
  const mcpToken = 'a'.repeat(64);
  let app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  let origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  assert.equal((await fetch(`${origin}/api/overview`, { headers: mcpHeaders })).status, 200);
  const clientConfig = await fetch(`${origin}/api/client-config`);
  assert.equal(clientConfig.status, 200);
  assert.equal((await clientConfig.text()).includes(mcpToken), false);
  assert.equal((await fetch(`${origin}/api/client-config`, { headers: mcpHeaders })).status, 403);
  assert.equal((await fetch(`${origin}/api/workspaces/ffffffff-ffff-4fff-8fff-ffffffffffff`, { headers: mcpHeaders })).status, 400);

  const registrationResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'MCP project', roots: [f.project] }),
  });
  assert.equal(registrationResponse.status, 201);
  const registered = await registrationResponse.json() as { id: string; name: string };
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.name}`, { headers: mcpHeaders })).status, 200);

  // Shed per-service control surface (pivot): retired paths fail closed at
  // the role gate for the MCP credential (403) and fall through to 404 for
  // the dashboard — nothing is served anywhere.
  const retiredServicePath = `/api/workspaces/${registered.name}/services/restart`;
  const retiredBody = JSON.stringify({ pmId: 1, name: 'api', namespace: 'default' });
  assert.equal((await fetch(`${origin}${retiredServicePath}`, {
    method: 'POST', headers: mcpHeaders, body: retiredBody,
  })).status, 403);
  assert.equal((await fetch(`${origin}${retiredServicePath}`, {
    method: 'POST', headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: retiredBody,
  })).status, 404);
  assert.equal((await fetch(`${origin}/api/project-root-picker`, {
    method: 'POST', headers: mcpHeaders, body: '{}',
  })).status, 403);

  // Restart rotates the MCP credential while dashboard access stays open
  // loopback. The t.after closure below closes the current server: it is
  // reassigned here so teardown targets the second instance, not the first.
  await app.close();
  const secondMcpToken = 'b'.repeat(64);
  app = createApp(new WorkspaceService(new Store(f.store.directory)), { mcpToken: secondMcpToken, assets: fixtureStaticAssets() });
  origin = await app.listen(0);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${mcpToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${secondMcpToken}` } })).status, 200);
  assert.equal((await fetch(`${origin}/api/overview`)).status, 200);
});

test('retired container link route stays gone on every role', async t => {
  const f = await fixture(t);
  const containerId = 'a'.repeat(64);
  const service = new WorkspaceService(f.store);
  const mcpToken = 'd'.repeat(64);
  const app = createApp(service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const registered = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'Link gate project', roots: [f.project] }),
  });
  assert.equal(registered.status, 201);
  const workspace = await registered.json() as { id: string; name: string };
  const path = `${origin}/api/workspaces/${workspace.name}/containers/link`;
  const linkBody = JSON.stringify({ action: 'link', containerId });

  assert.equal((await fetch(path, { method: 'POST', headers: mcpHeaders, body: linkBody })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: linkBody })).status, 404);
});

test('registration bodies are byte-bounded and decoded once with fatal UTF-8', async t => {
  const f = await fixture(t);
  const app = createApp(f.service, { mcpToken: '9'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const root = join(f.root, 'Unicode 🌱\nrepository');
  await mkdir(root, { recursive: true });
  const unicodeBody = Buffer.from(JSON.stringify({ name: '🌱 Unicode project', roots: [root] }));
  const emojiOffset = unicodeBody.indexOf(Buffer.from('🌱'));
  assert.ok(emojiOffset > 0);
  const splitResponse = await rawChunkRequest(origin, '/api/workspaces', mcpHeaders, [
    unicodeBody.subarray(0, emojiOffset + 2),
    unicodeBody.subarray(emojiOffset + 2),
  ]);
  assert.equal(splitResponse.status, 201);
  const registered = JSON.parse(splitResponse.body) as { id: string; name: string; roots: string[] };
  assert.equal(registered.name, '🌱 Unicode project');
  assert.deepEqual(registered.roots, [root]);

  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"name":"invalid'),
    Buffer.from([0xff]),
    Buffer.from('","roots":["/tmp/invalid"]}'),
  ]);
  const invalidResponse = await rawChunkRequest(origin, '/api/workspaces', mcpHeaders, [invalidUtf8]);
  assert.equal(invalidResponse.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 1);

  const limitRoot = join(f.root, 'body-limit');
  await mkdir(limitRoot, { recursive: true });
  const exactLimitPrefix = JSON.stringify({ name: 'Maximum body', roots: [limitRoot] });
  const exactLimit = Buffer.from(`${exactLimitPrefix}${' '.repeat(512 * 1024 - Buffer.byteLength(exactLimitPrefix))}`);
  assert.equal(exactLimit.byteLength, 512 * 1024);
  const exactResponse = await fetch(`${origin}/api/workspaces`, { method: 'POST', headers: mcpHeaders, body: exactLimit });
  assert.equal(exactResponse.status, 201);

  const oversized = Buffer.from(`${exactLimitPrefix}${' '.repeat(512 * 1024 + 1 - Buffer.byteLength(exactLimitPrefix))}`);
  const oversizedResponse = await fetch(`${origin}/api/workspaces`, { method: 'POST', headers: mcpHeaders, body: oversized });
  assert.equal(oversizedResponse.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 2);

  // The open-loopback dashboard shares the same ordinary 8KiB body bound.
  const ordinaryBody = Buffer.from(`{}${' '.repeat(8192)}`);
  const ordinaryOperation = await fetch(`${origin}/api/workspaces`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    body: ordinaryBody,
  });
  assert.equal(ordinaryOperation.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 2);
});

test('native project-root picker requires canonical dashboard context and never grants roots', async t => {
  const f = await fixture(t);
  const selectedRoots = ['/tmp/Picker 🌿\nroot-a', "/tmp/other user's root-b"];
  let pickerCalls = 0;
  let passedSignal: AbortSignal | undefined;
  const app = createApp(f.service, {
    mcpToken: '8'.repeat(64),
    assets: fixtureStaticAssets(),
    projectRootPicker: async signal => {
      pickerCalls++;
      passedSignal = signal;
      return { status: 'selected', roots: selectedRoots };
    },
  });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const dashboardHeaders = { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const endpoint = `${origin}/api/project-root-picker`;

  assert.equal((await fetch(endpoint, { method: 'POST', headers: mcpHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...dashboardHeaders, Origin: 'http://localhost:4318' }, body: '{}' })).status, 403);
  assert.equal((await rawRequest(origin, '/api/project-root-picker', {
    method: 'POST', headers: { ...dashboardHeaders, Host: `localhost:${new URL(origin).port}` }, body: '{}',
  })).status, 403);
  const missingFetchSite = { ...dashboardHeaders };
  delete (missingFetchSite as Record<string, string>)['Sec-Fetch-Site'];
  assert.equal((await fetch(endpoint, { method: 'POST', headers: missingFetchSite, body: '{}' })).status, 403);
  const { Origin: _droppedOrigin, 'Sec-Fetch-Site': _droppedFetchSite, ...bareHeaders } = dashboardHeaders;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: bareHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ roots: ['/tmp/extra'] }) })).status, 400);
  assert.equal(pickerCalls, 0);

  const response = await fetch(endpoint, { method: 'POST', headers: dashboardHeaders, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'selected', roots: selectedRoots });
  assert.equal(pickerCalls, 1);
  assert.equal(passedSignal?.aborted, false);
  const state = await f.store.read();
  assert.equal(state.workspaces.length, 0);
});

test('closing a dashboard picker request aborts only its pending picker operation', async t => {
  const f = await fixture(t);
  let started!: () => void;
  let aborted!: () => void;
  const pickerStarted = new Promise<void>(resolve => { started = resolve; });
  const pickerAborted = new Promise<void>(resolve => { aborted = resolve; });
  let passedSignal: AbortSignal | undefined;
  const app = createApp(new WorkspaceService(f.store), {
    mcpToken: '7'.repeat(64),
    assets: fixtureStaticAssets(),
    projectRootPicker: signal => {
      passedSignal = signal;
      started();
      return new Promise(resolve => {
        const onAbort = () => {
          aborted();
          resolve({ status: 'aborted' });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const { request: httpRequestFn } = await import('node:http');
  const request = httpRequestFn(new URL('/api/project-root-picker', origin), {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
  });
  request.on('error', () => {});
  request.end('{}');
  await pickerStarted;
  request.destroy();
  let timer: NodeJS.Timeout | undefined;
  const abortedInTime = await Promise.race([
    pickerAborted.then(() => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
  ]);
  if (timer) clearTimeout(timer);
  assert.equal(abortedInTime, true);
  assert.equal(passedSignal?.aborted, true);
  assert.equal((await f.store.read()).workspaces.length, 0);
});
