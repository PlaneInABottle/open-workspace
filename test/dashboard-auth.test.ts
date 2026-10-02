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
    'X-OpenWorkspace-Intent': 'connect-dashboard',
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
    { 'X-OpenWorkspace-Intent': 'wrong-intent' },
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
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
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

test('dashboard and MCP credentials have separate capabilities and restart invalidates both', async t => {
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
  assert.equal((await fetch(`${origin}/api/workspaces/${'f'.repeat(36)}`, { headers: mcpHeaders })).status, 403);

  const overbroadProposal = await fetch(`${origin}/api/proposals`, {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ name: 'Invalid project', roots: [f.project], approve: true }),
  });
  assert.equal(overbroadProposal.status, 400);
  assert.equal((await f.store.read()).proposals.length, 0);
  const legacyPathProposal = await fetch(`${origin}/api/proposals`, {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ name: 'Legacy project', path: f.project }),
  });
  assert.equal(legacyPathProposal.status, 400);
  assert.equal((await f.store.read()).proposals.length, 0);

  const proposalResponse = await fetch(`${origin}/api/proposals`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'MCP project', roots: [f.project] }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as { id: string };
  for (const path of [
    `/api/proposals/${proposal.id}/approve`,
    `/api/proposals/${proposal.id}/reject`,
    `/api/workspaces/${proposal.id}/revoke`,
  ]) {
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers: mcpHeaders, body: '{}' })).status, 403);
  }
  assert.equal((await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: { ...mcpHeaders, 'X-OpenWorkspace-Intent': 'connect-dashboard' }, body: JSON.stringify({ consent: true }),
  })).status, 403);
  assert.equal((await fetch(`${origin}/api/dashboard-session`, {
    method: 'DELETE', headers: { ...mcpHeaders, 'X-OpenWorkspace-Intent': 'disconnect-dashboard' }, body: '{}',
  })).status, 403);

  const approvedResponse = await fetch(`${origin}/api/proposals/${proposal.id}/approve`, {
    method: 'POST', headers: dashboardHeaders, body: '{}',
  });
  assert.equal(approvedResponse.status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${proposal.id}`, { headers: mcpHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${proposal.id}/onboarding`, { headers: mcpHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${proposal.id}/revoke`, {
    method: 'POST', headers: mcpHeaders, body: '{}',
  })).status, 403);

  const secondProposalResponse = await fetch(`${origin}/api/proposals`, {
    method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ name: 'Dashboard project', roots: [f.project] }),
  });
  assert.equal(secondProposalResponse.status, 201);
  const secondProposal = await secondProposalResponse.json() as { id: string };
  assert.equal((await fetch(`${origin}/api/proposals/${secondProposal.id}/reject`, {
    method: 'POST', headers: dashboardHeaders, body: '{}',
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/${proposal.id}/revoke`, {
    method: 'POST', headers: dashboardHeaders, body: '{}',
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
    'X-OpenWorkspace-Intent': 'disconnect-dashboard',
  };
  const deleteWithoutOrigin = Object.fromEntries(Object.entries(disconnectHeaders).filter(([name]) => name !== 'Origin')) as Record<string, string>;
  const deleteWithoutFetchSite = Object.fromEntries(Object.entries(disconnectHeaders).filter(([name]) => name !== 'Sec-Fetch-Site')) as Record<string, string>;
  for (const invalid of [
    { headers: deleteWithoutOrigin, body: '{}' },
    { headers: deleteWithoutFetchSite, body: '{}' },
    { headers: { ...disconnectHeaders, Origin: 'https://evil.example' }, body: '{}' },
    { headers: { ...disconnectHeaders, 'Sec-Fetch-Site': 'same-site' }, body: '{}' },
    { headers: { ...disconnectHeaders, 'X-OpenWorkspace-Intent': 'wrong-intent' }, body: '{}' },
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

test('proposal bodies are byte-bounded and decoded once with fatal UTF-8', async t => {
  const f = await fixture(t);
  const app = createApp(f.service, { mcpToken: '9'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const root = join(f.root, 'Unicode 🌱\nrepository');
  const unicodeBody = Buffer.from(JSON.stringify({ name: '🌱 Unicode project', roots: [root] }));
  const emojiOffset = unicodeBody.indexOf(Buffer.from('🌱'));
  assert.ok(emojiOffset > 0);
  const splitResponse = await rawChunkRequest(origin, '/api/proposals', mcpHeaders, [
    unicodeBody.subarray(0, emojiOffset + 2),
    unicodeBody.subarray(emojiOffset + 2),
  ]);
  assert.equal(splitResponse.status, 201);
  const pending = JSON.parse(splitResponse.body) as { id: string; name: string; roots: string[] };
  assert.equal(pending.name, '🌱 Unicode project');
  assert.deepEqual(pending.roots, [root]);

  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"name":"invalid'),
    Buffer.from([0xff]),
    Buffer.from('","roots":["/tmp/invalid"]}'),
  ]);
  const invalidResponse = await rawChunkRequest(origin, '/api/proposals', mcpHeaders, [invalidUtf8]);
  assert.equal(invalidResponse.status, 400);
  assert.equal((await f.store.read()).proposals.length, 1);

  const exactLimitPrefix = JSON.stringify({ name: 'Maximum body', roots: ['/tmp/body-limit'] });
  const exactLimit = Buffer.from(`${exactLimitPrefix}${' '.repeat(512 * 1024 - Buffer.byteLength(exactLimitPrefix))}`);
  assert.equal(exactLimit.byteLength, 512 * 1024);
  const exactResponse = await fetch(`${origin}/api/proposals`, { method: 'POST', headers: mcpHeaders, body: exactLimit });
  assert.equal(exactResponse.status, 201);

  const oversized = Buffer.from(`${exactLimitPrefix}${' '.repeat(512 * 1024 + 1 - Buffer.byteLength(exactLimitPrefix))}`);
  const oversizedResponse = await fetch(`${origin}/api/proposals`, { method: 'POST', headers: mcpHeaders, body: oversized });
  assert.equal(oversizedResponse.status, 400);
  assert.equal((await f.store.read()).proposals.length, 2);

  const connected = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await connected.json() as { dashboardToken: string };
  const ordinaryBody = Buffer.from(`{}${' '.repeat(8192)}`);
  const ordinaryOperation = await fetch(`${origin}/api/proposals/${pending.id}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders },
    body: ordinaryBody,
  });
  assert.equal(ordinaryOperation.status, 400);
  assert.equal((await f.store.read()).proposals.length, 2);
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
  const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'select-project-roots' };
  const tokenResponse = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST', headers: consentHeaders(origin), body: JSON.stringify({ consent: true }),
  });
  const { dashboardToken } = await tokenResponse.json() as { dashboardToken: string };
  const dashboardHeaders = {
    Authorization: `Bearer ${dashboardToken}`,
    ...jsonHeaders,
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'X-OpenWorkspace-Intent': 'select-project-roots',
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
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'wrong' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: dashboardHeaders, body: JSON.stringify({ roots: ['/tmp/extra'] }) })).status, 400);
  assert.equal(pickerCalls, 0);

  const response = await fetch(endpoint, { method: 'POST', headers: dashboardHeaders, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'selected', roots: selectedRoots });
  assert.equal(pickerCalls, 1);
  assert.equal(passedSignal?.aborted, false);
  const state = await f.store.read();
  assert.equal(state.proposals.length, 0);
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
      'X-OpenWorkspace-Intent': 'select-project-roots',
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
  assert.equal((await f.store.read()).proposals.length, 0);
  assert.equal((await f.store.read()).workspaces.length, 0);
});
