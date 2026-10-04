import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DashboardSessions } from '../src/dashboard-sessions.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

function consentHeaders(origin: string, extra: Record<string, string> = {}) {
  return {
    ...jsonHeaders,
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };
}

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

test('dashboard consent requires exact same-origin browser context and no Authorization header', async t => {
  const f = await fixture(t);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const mcpToken = 'f'.repeat(64);
  const app = createApp(f.service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const url = `${origin}/api/dashboard-session`;

  const connected = await fetch(url, { method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }) });
  assert.equal(connected.status, 201);
  assert.equal(connected.headers.get('cache-control'), 'no-store');
  const session = await connected.json() as { dashboardToken: string; expiresAt: string };
  assert.equal(/^[a-f0-9]{64}$/.test(session.dashboardToken), true);
  assert.equal(session.expiresAt, new Date(now + 12 * 60 * 60 * 1000).toISOString());
  assert.equal(sessions.isActive(session.dashboardToken), true);

  for (const authorization of [
    `Bearer ${mcpToken}`,
    `Bearer ${session.dashboardToken}`,
    `Bearer ${'e'.repeat(64)}`,
    'malformed authorization',
    '',
  ]) {
    const denied = await rawRequest(origin, '/api/dashboard-session', {
      method: 'POST',
      headers: consentHeaders(origin, { Authorization: authorization }),
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(denied.status, 403);
  }

  const wrongContext = [
    { Origin: undefined },
    { Origin: 'null' },
    { Origin: 'https://evil.example' },
    { Origin: `http://localhost:${new URL(origin).port}` },
    { 'Sec-Fetch-Site': undefined },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'none' },
  ];
  for (const replacement of wrongContext) {
    const headers = consentHeaders(origin);
    for (const [key, value] of Object.entries(replacement)) {
      if (value === undefined) delete headers[key as keyof typeof headers];
      else headers[key as keyof typeof headers] = value;
    }
    const denied = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ consent: true }) });
    assert.equal(denied.status, 403);
  }

  const differentPort = await fetch(url, {
    method: 'POST',
    headers: consentHeaders(origin, { Origin: `http://127.0.0.1:${Number(new URL(origin).port) + 1}` }),
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(differentPort.status, 403);
  const differentHost = await rawRequest(origin, '/api/dashboard-session', {
    method: 'POST',
    headers: { ...consentHeaders(origin), Host: `127.0.0.1:${Number(new URL(origin).port) + 1}` },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(differentHost.status, 403);

  for (const invalidBody of [
    '{}',
    JSON.stringify({ consent: false }),
    JSON.stringify({ consent: true, extra: true }),
  ]) {
    const denied = await fetch(url, { method: 'POST', headers: consentHeaders(origin), body: invalidBody });
    assert.equal(denied.status, 400);
  }
  const missingContentType = await fetch(url, {
    method: 'POST',
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(missingContentType.status, 400);

  const page = await fetch(origin);
  const html = await page.text();
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.ok(!html.includes(session.dashboardToken));
  assert.ok(!html.includes(mcpToken));
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { Authorization: `Bearer ${mcpToken}` } })).status, 403);
});

test('dashboard and MCP share workspace operations; only browser session management stays dashboard-only', async t => {
  const f = await fixture(t);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const firstMcpToken = 'a'.repeat(64);
  let app = createApp(f.service, { mcpToken: firstMcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  let origin = await app.listen(0);
  t.after(() => app.close());

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken, expiresAt: dashboardExpiresAt } = await issued.json() as { dashboardToken: string; expiresAt: string };
  const mcpHeaders = { Authorization: `Bearer ${firstMcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };

  assert.equal((await fetch(`${origin}/api/overview`, { headers: mcpHeaders })).status, 200);
  const dashboardConfig = await fetch(`${origin}/api/client-config`, { headers: dashboardHeaders });
  assert.equal(dashboardConfig.status, 200);
  const dashboardConfigText = await dashboardConfig.text();
  assert.equal(dashboardConfigText.includes(firstMcpToken) || dashboardConfigText.includes(dashboardToken), false);
  assert.equal((await fetch(`${origin}/api/client-config`, { headers: mcpHeaders })).status, 403);
  assert.equal((await fetch(`${origin}/api/workspaces/ffffffff-ffff-4fff-8fff-ffffffffffff`, { headers: mcpHeaders })).status, 400);

  const overbroadRegistration = await fetch(`${origin}/api/workspaces`, {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ name: 'Invalid project', roots: [f.project], approve: true }),
  });
  assert.equal(overbroadRegistration.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 0);
  const legacyPathRegistration = await fetch(`${origin}/api/workspaces`, {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ name: 'Legacy project', path: f.project }),
  });
  assert.equal(legacyPathRegistration.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 0);

  const registrationResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'MCP project', roots: [f.project] }),
  });
  assert.equal(registrationResponse.status, 201);
  const registered = await registrationResponse.json() as { id: string };
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.id}`, { headers: mcpHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.id}/onboarding`, { headers: mcpHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.id}`, { method: 'DELETE', headers: mcpHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${registered.id}`, { headers: mcpHeaders })).status, 400);
  assert.equal((await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: { ...mcpHeaders }, body: JSON.stringify({ consent: true }),
  })).status, 403);
  assert.equal((await fetch(`${origin}/api/dashboard-session`, {
    method: 'DELETE', headers: { ...mcpHeaders }, body: '{}',
  })).status, 403);

  const secondRegistration = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ name: 'Dashboard project', roots: [f.project] }),
  });
  assert.equal(secondRegistration.status, 201);
  const secondRegistered = await secondRegistration.json() as { id: string };

  const serviceActionPath = `/api/workspaces/${secondRegistered.id}/services/restart`;
  const serviceBody = JSON.stringify({ pmId: 1, name: 'api', namespace: 'default' });
  const mcpAction = await fetch(`${origin}${serviceActionPath}`, {
    method: 'POST', headers: mcpHeaders, body: serviceBody,
  });
  assert.equal(mcpAction.status, 200);
  assert.equal((await mcpAction.json() as { status: string }).status, 'failed');
  assert.equal((await fetch(`${origin}${serviceActionPath}`, {
    method: 'POST', headers: dashboardHeaders, body: serviceBody,
  })).status, 403);
  assert.equal((await fetch(`${origin}${serviceActionPath}`, {
    method: 'POST',
    headers: { ...dashboardHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    body: serviceBody,
  })).status, 200);
  assert.equal((await fetch(`${origin}${serviceActionPath}`, {
    method: 'POST',
    headers: { ...dashboardHeaders, Origin: 'http://localhost:4318', 'Sec-Fetch-Site': 'same-origin' },
    body: serviceBody,
  })).status, 403);
  assert.equal((await fetch(`${origin}/api/project-root-picker`, {
    method: 'POST', headers: mcpHeaders, body: '{}',
  })).status, 403);
  assert.equal((await fetch(`${origin}/api/workspaces/${secondRegistered.id}`, {
    method: 'DELETE', headers: dashboardHeaders, body: '{}',
  })).status, 403);
  assert.equal((await fetch(`${origin}/api/workspaces/${secondRegistered.id}`, {
    method: 'DELETE', headers: { ...dashboardHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
  })).status, 200);

  const expiresAt = Date.parse(dashboardExpiresAt);
  now = expiresAt - 1;
  assert.equal((await fetch(`${origin}/api/overview`, { headers: dashboardHeaders })).status, 200);
  now = expiresAt;
  assert.equal((await fetch(`${origin}/api/overview`, { headers: dashboardHeaders })).status, 401);

  const reconnect = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  assert.equal(reconnect.status, 201);
  const activeSession = await reconnect.json() as { dashboardToken: string };
  const disconnectHeaders = {
    Authorization: `Bearer ${activeSession.dashboardToken}`,
    ...jsonHeaders,
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
  };
  const deleteWithoutOrigin = Object.fromEntries(Object.entries(disconnectHeaders).filter(([name]) => name !== 'Origin')) as Record<string, string>;
  const deleteWithoutFetchSite = Object.fromEntries(Object.entries(disconnectHeaders).filter(([name]) => name !== 'Sec-Fetch-Site')) as Record<string, string>;
  for (const invalid of [
    { headers: deleteWithoutOrigin, body: '{}' },
    { headers: deleteWithoutFetchSite, body: '{}' },
    { headers: { ...disconnectHeaders, Origin: 'https://evil.example' }, body: '{}' },
    { headers: { ...disconnectHeaders, 'Sec-Fetch-Site': 'same-site' }, body: '{}' },
    { headers: { ...disconnectHeaders, Authorization: `Bearer ${firstMcpToken}` }, body: '{}' },
    { headers: { ...disconnectHeaders, 'Content-Type': 'text/plain' }, body: '{}' },
    { headers: disconnectHeaders, body: JSON.stringify({ extra: true }) },
  ]) {
    const denied = await fetch(`${origin}/api/dashboard-session`, { method: 'DELETE', ...invalid });
    assert.ok(denied.status === 400 || denied.status === 403);
  }
  const stillActive = await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${activeSession.dashboardToken}` } });
  assert.equal(stillActive.status, 200);
  const logout = await fetch(`${origin}/api/dashboard-session`, {
    method: 'DELETE',
    headers: disconnectHeaders,
    body: '{}',
  });
  assert.equal(logout.status, 204);
  assert.equal(await logout.text(), '');
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${activeSession.dashboardToken}` } })).status, 401);

  await app.close();
  const secondMcpToken = 'b'.repeat(64);
  app = createApp(new WorkspaceService(new Store(f.store.directory)), { mcpToken: secondMcpToken, assets: fixtureStaticAssets() });
  origin = await app.listen(0);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${firstMcpToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${activeSession.dashboardToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${secondMcpToken}` } })).status, 200);
});

test('dashboard container link changes require canonical context; MCP needs none', async t => {
  const f = await fixture(t);
  const containerId = 'a'.repeat(64);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, undefined, undefined, undefined, Date.now,
    async () => ({ available: true, containers: [{ id: containerId, name: 'task-db', image: 'postgres:17', state: 'running', labels: {} }] }));
  const mcpToken = 'd'.repeat(64);
  const app = createApp(service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const registered = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'Link gate project', roots: [f.project] }),
  });
  assert.equal(registered.status, 201);
  const workspace = await registered.json() as { id: string };
  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  assert.equal(connected.status, 201);
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const canonicalDashboardHeaders = { ...dashboardHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const path = `${origin}/api/workspaces/${workspace.id}/containers/link`;
  const linkBody = JSON.stringify({ action: 'link', containerId });

  const missingContext = await fetch(path, { method: 'POST', headers: dashboardHeaders, body: linkBody });
  assert.equal(missingContext.status, 403);
  const wrongContext = await fetch(path, {
    method: 'POST',
    headers: { ...canonicalDashboardHeaders, Origin: origin.replace('127.0.0.1', 'localhost') },
    body: linkBody,
  });
  assert.equal(wrongContext.status, 403);
  const allowed = await fetch(path, {
    method: 'POST',
    headers: canonicalDashboardHeaders,
    body: linkBody,
  });
  assert.equal(allowed.status, 200);

  const mcpUnlink = await fetch(path, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ action: 'unlink', containerId }),
  });
  assert.equal(mcpUnlink.status, 200, 'MCP operations carry no intent header');
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

  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  const ordinaryBody = Buffer.from(`{}${' '.repeat(8192)}`);
  const ordinaryOperation = await fetch(`${origin}/api/workstreams`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    body: ordinaryBody,
  });
  assert.equal(ordinaryOperation.status, 400);
  assert.equal((await f.store.read()).workspaces.length, 2);
});

test('native project-root picker requires an exact dashboard session and never grants roots', async t => {
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
  const tokenResponse = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await tokenResponse.json() as { dashboardToken: string };
  const dashboardHeaders = {
    Authorization: `Bearer ${dashboardToken}`,
    ...jsonHeaders,
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
  };
  const endpoint = `${origin}/api/project-root-picker`;

  assert.equal((await fetch(endpoint, { method: 'POST', headers: mcpHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...dashboardHeaders, Origin: 'http://localhost:4318' }, body: '{}' })).status, 403);
  assert.equal((await rawRequest(origin, '/api/project-root-picker', {
    method: 'POST', headers: { ...dashboardHeaders, Host: `localhost:${new URL(origin).port}` }, body: '{}',
  })).status, 403);
  const missingFetchSite = { ...dashboardHeaders };
  delete (missingFetchSite as Record<string, string>)['Sec-Fetch-Site'];
  assert.equal((await fetch(endpoint, { method: 'POST', headers: missingFetchSite, body: '{}' })).status, 403);
  const { Origin: _droppedOrigin, 'Sec-Fetch-Site': _droppedFetchSite, ...bearerOnlyHeaders } = dashboardHeaders;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: bearerOnlyHeaders, body: '{}' })).status, 403);
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
  const session = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await session.json() as { dashboardToken: string };
  const request = httpRequest(new URL('/api/project-root-picker', origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dashboardToken}`,
      ...jsonHeaders,
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
    },
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

test('repository verification runs only the registered manifest script', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-verify-http-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);

  const mcpToken = 'c'.repeat(64);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const app = createApp(service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const bareDashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  const proposalResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: bareDashboardHeaders, body: JSON.stringify({ name: 'Verify project', roots: [project] }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as { id: string };

  const verifyPath = `${origin}/api/workspaces/${proposal.id}/verify`;
  const verifyBody = JSON.stringify({ repositoryPath: project, scriptName: 'check' });
  const fromMcp = await fetch(verifyPath, { method: 'POST', headers: mcpHeaders, body: verifyBody });
  assert.equal(fromMcp.status, 200);
  assert.equal((await fromMcp.json() as { outcome: string }).outcome, 'passed');
  assert.equal((await fetch(verifyPath, { method: 'POST', headers: bareDashboardHeaders, body: verifyBody })).status, 403);

  const allowed = await fetch(verifyPath, {
    method: 'POST', headers: dashboardHeaders, body: verifyBody,
  });
  assert.equal(allowed.status, 200);
  const result = await allowed.json() as {
    outcome: string; exitCode: number; scriptName: string; repositoryPath: string;
    git: { revisionState: string; worktree: string }; service: null; message: string;
  };
  assert.equal(result.outcome, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.scriptName, 'check');
  assert.equal(result.repositoryPath, project);
  assert.equal(result.git.revisionState, 'unknown');
  assert.equal(result.git.worktree, 'unknown');
  assert.equal(result.service, null);
  assert.match(result.message, /not a CI verdict/);

  const unknownScript = await fetch(verifyPath, {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ repositoryPath: project, scriptName: 'deploy' }),
  });
  assert.equal(unknownScript.status, 400);
});

test('workstreams bind registered roots over every surface', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-workstreams-http-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);

  const mcpToken = 'd'.repeat(64);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const app = createApp(service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const bareDashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  const proposalResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: bareDashboardHeaders, body: JSON.stringify({ name: 'Stream project', roots: [project] }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as { id: string };

  const createBody = JSON.stringify({ name: 'First stream', workspaceId: proposal.id, checkouts: [project] });
  const fromMcp = await fetch(`${origin}/api/workstreams`, {
    method: 'POST', headers: mcpHeaders, body: createBody,
  });
  assert.equal(fromMcp.status, 201);
  const firstStream = await fromMcp.json() as { id: string; status: string };
  assert.equal(firstStream.status, 'active');
  assert.equal((await fetch(`${origin}/api/workstreams`, {
    method: 'POST', headers: bareDashboardHeaders, body: createBody,
  })).status, 403);

  const created = await fetch(`${origin}/api/workstreams`, {
    method: 'POST', headers: dashboardHeaders, body: createBody,
  });
  assert.equal(created.status, 201);
  const workstream = await created.json() as { id: string; status: string; checkouts: Array<{ root: string; revisionState: string }> };
  assert.equal(workstream.status, 'active');
  assert.deepEqual(workstream.checkouts.map(checkout => checkout.root), [project]);

  const listed = await fetch(`${origin}/api/workstreams`, { headers: mcpHeaders });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as Array<{ id: string }>).map(entry => entry.id), [firstStream.id, workstream.id]);
  assert.equal((await fetch(`${origin}/api/workstreams/${workstream.id}`, { headers: mcpHeaders })).status, 200);

  const statusPath = `${origin}/api/workstreams/${workstream.id}/status`;
  const pausedByMcp = await fetch(statusPath, {
    method: 'POST', headers: mcpHeaders, body: '{"status":"paused"}',
  });
  assert.equal(pausedByMcp.status, 200);
  assert.equal((await pausedByMcp.json() as { status: string }).status, 'paused');
  const paused = await fetch(statusPath, {
    method: 'POST', headers: dashboardHeaders, body: '{"status":"paused"}',
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json() as { status: string }).status, 'paused');

  const outside = await fetch(`${origin}/api/workstreams`, {
    method: 'POST', headers: dashboardHeaders,
    body: JSON.stringify({ name: 'Outside', workspaceId: proposal.id, checkouts: [root] }),
  });
  assert.equal(outside.status, 400);
});

test('leases serialize shared resources over every surface', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-leases-http-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);

  const mcpToken = 'e'.repeat(64);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const app = createApp(service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  const proposalResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ name: 'Lease project', roots: [first, second] }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as { id: string };

  const makeStream = async (name: string, checkout: string) => {
    const response = await fetch(`${origin}/api/workstreams`, {
      method: 'POST', headers: dashboardHeaders,
      body: JSON.stringify({ name, workspaceId: proposal.id, checkouts: [checkout] }),
    });
    assert.equal(response.status, 201);
    return (await response.json()) as { id: string };
  };
  const one = await makeStream('One', first);
  const two = await makeStream('Two', second);

  const bareDashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const acquire = (token: Record<string, string>, body: unknown) =>
    fetch(`${origin}/api/leases/acquire`, {
      method: 'POST',
      headers: token,
      body: JSON.stringify(body),
    });
  assert.equal((await acquire(mcpHeaders, { resource: 'port:3000', workstreamId: one.id })).status, 200);
  assert.equal((await acquire(bareDashboardHeaders, { resource: 'port:3000', workstreamId: one.id })).status, 403);

  assert.equal((await acquire(dashboardHeaders, { resource: 'port:3000', workstreamId: one.id })).status, 200);
  const queued = await acquire(dashboardHeaders, { resource: 'port:3000', workstreamId: two.id });
  assert.equal(queued.status, 200);
  const queuedBody = await queued.json() as { lease: { status: string }; position: number };
  assert.equal(queuedBody.lease.status, 'queued');
  assert.equal(queuedBody.position, 1);
  const listed = await fetch(`${origin}/api/leases`, { headers: mcpHeaders });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as Array<{ resource: string; status: string }>).map(lease => [lease.resource, lease.status]), [['port:3000', 'held'], ['port:3000', 'queued']]);

  const release = (token: Record<string, string>, body: unknown) =>
    fetch(`${origin}/api/leases/release`, {
      method: 'POST', headers: token, body: JSON.stringify(body),
    });
  assert.equal((await release(dashboardHeaders, { resource: 'port:3000', workstreamId: two.id })).status, 400);
  const released = await release(mcpHeaders, { resource: 'port:3000', workstreamId: one.id });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { released: true, promoted: two.id });
});

test('service control reaches only the designated registered-root process', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-service-action-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'api'), { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();

  const runnerCalls: Array<{ action: string; pmId: number }> = [];
  const service = new WorkspaceService(store, async () => ({
    available: true,
    processes: [{ pmId: 7, name: 'api', namespace: 'default', status: 'online', cwd: join(project, 'api'), restartCount: 0, startedAt: null }],
  }), async (action, pmId) => {
    runnerCalls.push({ action, pmId });
    return { ok: true };
  });

  const mcpToken = 'b'.repeat(64);
  let now = 1_800_000_000_000;
  let counter = 0;
  const sessions = new DashboardSessions(() => now, () => (++counter).toString(16).padStart(64, '0'));
  const app = createApp(service, { mcpToken, dashboardSessions: sessions, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const bareDashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders };
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  const proposalResponse = await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ name: 'Service project', roots: [project] }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as { id: string };

  const actionPath = `${origin}/api/workspaces/${proposal.id}/services/restart`;
  const actionBody = JSON.stringify({ pmId: 7, name: 'api', namespace: 'default' });
  const fromMcp = await fetch(actionPath, { method: 'POST', headers: mcpHeaders, body: actionBody });
  assert.equal(fromMcp.status, 200);
  assert.equal((await fromMcp.json() as { status: string }).status, 'completed');
  assert.equal((await fetch(actionPath, { method: 'POST', headers: bareDashboardHeaders, body: actionBody })).status, 403);
  assert.deepEqual(runnerCalls, [{ action: 'restart', pmId: 7 }]);

  const allowed = await fetch(actionPath, {
    method: 'POST', headers: dashboardHeaders, body: actionBody,
  });
  assert.equal(allowed.status, 200);
  const result = await allowed.json() as { status: string; serviceStatus: string; message: string };
  assert.equal(result.status, 'completed');
  assert.equal(result.serviceStatus, 'online');
  assert.match(result.message, /not readiness/);
  assert.deepEqual(runnerCalls, [{ action: 'restart', pmId: 7 }, { action: 'restart', pmId: 7 }]);
});

test('service logs return bounded output while activity records counts only', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-service-logs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'api'), { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();

  const logCalls: Array<{ pmId: number; stream: string; lines: number }> = [];
  const dockerId = 'c'.repeat(64);
  const dockerLogCalls: Array<{ containerId: string; lines: number }> = [];
  const dockerLogSecret = 'DOCKER_APP_PRINTED_SECRET_SENTINEL';
  const service = new WorkspaceService(store, async () => ({
    available: true,
    processes: [{ pmId: 7, name: 'api', namespace: 'default', status: 'online', cwd: join(project, 'api'), restartCount: 0, startedAt: null }],
  }), undefined, undefined, undefined, undefined, async (pmId, stream, lines) => {
    logCalls.push({ pmId, stream, lines });
    return { ok: true, output: 'hello\nsk-test-secret-marker', truncated: false };
  }, Date.now, async () => ({ available: true, containers: [
    { id: dockerId, name: 'postgres', image: 'postgres:17', state: 'running', labels: { 'com.docker.compose.project.working_dir': project } },
    { id: 'd'.repeat(64), name: 'unmanaged-cache', image: 'redis:7', state: 'running', labels: {} as Record<string, string> },
  ] }), async (containerId, lines) => {
    dockerLogCalls.push({ containerId, lines });
    return { ok: true, output: dockerLogSecret, truncated: false };
  });

  const mcpToken = 'b'.repeat(64);
  const app = createApp(service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json' };

  const proposal = await (await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'Logs project', roots: [project] }),
  })).json() as { id: string };

  const logsPath = `${origin}/api/workspaces/${proposal.id}/services/logs`;
  const denied = await fetch(logsPath, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ target: { pmId: 99, name: 'api' } }),
  });
  assert.equal(denied.status, 200);
  assert.match((await denied.json() as { message: string }).message, /not uniquely mapped/);
  assert.deepEqual(logCalls, []);

  const tailed = await fetch(logsPath, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ target: { pmId: 7, name: 'api', namespace: 'default' }, lines: 10, stream: 'out' }),
  });
  assert.equal(tailed.status, 200);
  const tail = await tailed.json() as { output: string; linesReturned: number; truncated: boolean; stream: string };
  assert.equal(tail.output, 'hello\nsk-test-secret-marker');
  assert.equal(tail.linesReturned, 2);
  assert.equal(tail.truncated, false);
  assert.equal(tail.stream, 'out');
  assert.deepEqual(logCalls, [{ pmId: 7, stream: 'out', lines: 10 }]);

  const services = await fetch(`${origin}/api/workspaces/${proposal.id}/services`, {
    method: 'POST', headers: mcpHeaders, body: '{}',
  });
  assert.equal(services.status, 200);
  const serviceInventory = await services.json() as { docker: { services: Array<{ runner: string; name: string }>; unmanagedContainerCount: number; unmanagedContainers: Array<{ name: string }> } };
  assert.deepEqual(serviceInventory.docker.services.map(entry => [entry.runner, entry.name]), [['docker', 'postgres']]);
  assert.equal(serviceInventory.docker.unmanagedContainerCount, 1);
  assert.deepEqual(serviceInventory.docker.unmanagedContainers, []);
  const detailedServices = await fetch(`${origin}/api/workspaces/${proposal.id}/services`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ includeUnmanaged: true }),
  });
  const detailedInventory = await detailedServices.json() as { docker: { unmanagedContainerCount: number; unmanagedContainers: Array<{ name: string; image: string }> } };
  assert.equal(detailedInventory.docker.unmanagedContainerCount, 1);
  assert.deepEqual(detailedInventory.docker.unmanagedContainers.map(entry => [entry.name, entry.image]), [['unmanaged-cache', 'redis:7']]);

  const dockerTarget = { runner: 'docker', containerId: dockerId, name: 'postgres' };
  const dockerTail = await fetch(logsPath, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ target: dockerTarget, lines: 12 }),
  });
  assert.equal(dockerTail.status, 200);
  const dockerResult = await dockerTail.json() as { output: string; linesReturned: number; target: { runner: string } };
  assert.equal(dockerResult.output, dockerLogSecret);
  assert.equal(dockerResult.linesReturned, 1);
  assert.equal(dockerResult.target.runner, 'docker');
  assert.deepEqual(dockerLogCalls, [{ containerId: dockerId, lines: 12 }]);

  const deniedControl = await fetch(`${origin}/api/workspaces/${proposal.id}/services/stop`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify(dockerTarget),
  });
  assert.equal(deniedControl.status, 400);
  assert.deepEqual(dockerLogCalls, [{ containerId: dockerId, lines: 12 }], 'Docker has no service control path');

  const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${mcpToken}` } })).json() as Array<{ detail: string }>;
  assert.ok(activity.some(entry => entry.detail === 'api → 2 lines'));
  assert.ok(activity.some(entry => entry.detail === 'postgres → 1 lines'));
  assert.ok(!JSON.stringify(activity).includes('sk-test-secret-marker'), 'activity must never carry log text');
  assert.ok(!JSON.stringify(activity).includes(dockerLogSecret), 'Docker activity must never carry log text');
});
