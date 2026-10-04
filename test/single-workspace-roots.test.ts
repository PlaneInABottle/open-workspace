import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

// Single-workspace-multi-root walkthrough: one workspace named for the whole
// endeavor holds three repo roots, and every follow-up call addresses it by
// that single name with zero workspace_list (/api/overview) calls.
test('one endeavor workspace with three roots serves inspect, onboarding and workstream context by single name', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-single-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repos = ['frontend', 'backend', 'db'];
  const paths: string[] = [];
  for (const name of repos) {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), '{"scripts":{"test":"node --test"}}');
    paths.push(path);
  }
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const app = createApp(service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  let overviewCalls = 0;
  const call = async (path: string, init?: RequestInit) => {
    if (path === '/api/overview') overviewCalls += 1;
    const response = await fetch(`${origin}${path}`, { headers, ...init });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  // Register ONE workspace holding all three repos as roots.
  const registered = await call('/api/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'Endeavor', roots: paths }),
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body['name'], 'Endeavor');
  assert.equal((await store.read()).workspaces.length, 1);

  // Inspect groups all three roots under the single name.
  const inspected = await call('/api/workspaces/Endeavor');
  assert.equal(inspected.status, 200);
  const roots = inspected.body['roots'] as Array<{ path: string }>;
  assert.equal(roots.length, 3);
  assert.deepEqual(
    roots.map(entry => entry.path).sort(),
    (await Promise.all(paths.map(path => realpath(path)))).sort(),
  );

  // Onboarding (verify-shaped read) addresses the same single name.
  const plan = await call('/api/workspaces/Endeavor/onboarding');
  assert.equal(plan.status, 200);
  assert.equal((plan.body['roots'] as unknown[]).length, 3);

  // Workstream context flows through the single workspace name too.
  const created = await call('/api/workstreams', {
    method: 'POST',
    body: JSON.stringify({ name: 'First slice', workspace: 'Endeavor', checkouts: [paths[0]] }),
  });
  assert.equal(created.status, 201);
  const context = await call('/api/workstreams/Endeavor/First%20slice/context');
  assert.equal(context.status, 200);
  assert.equal(context.body['workstreamId'], created.body['id']);
  assert.equal(context.body['name'], 'First slice');

  // The whole flow never needed a workspace list: the caller already knew
  // the one endeavor name.
  assert.equal(overviewCalls, 0);
});
