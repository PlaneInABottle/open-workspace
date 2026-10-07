import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-update-roots-')));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  // A worktree-style second checkout: a real directory that appears later.
  const worktree = join(root, 'project-worktree');
  await mkdir(worktree);
  await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return {
    root,
    project,
    worktree,
    store,
    service: new WorkspaceService(store),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const jsonHeaders = { 'Content-Type': 'application/json' };

test('updateRoots replaces the full list while preserving UUID, name, timestamps and activity', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const workspace = await f.service.register('Project', [f.project]);
  await f.service.recordActivity({ actor: 'mcp', operation: 'register', workspaceId: workspace.id, detail: 'Project' });
  const activityBefore = await f.service.recentActivity();

  const { workspace: updated, previousRoots } = await f.service.updateRoots(workspace.name, [f.project, f.worktree]);
  assert.equal(previousRoots, 1);
  assert.equal(updated.id, workspace.id);
  assert.equal(updated.name, 'Project');
  assert.equal(updated.createdAt, workspace.createdAt);
  assert.deepEqual(updated.roots, [await realpath(f.project), await realpath(f.worktree)]);

  const state = await f.store.read();
  assert.equal(state.workspaces.length, 1);
  assert.deepEqual(state.workspaces[0].roots, updated.roots);
  // Continuity: prior activity entries are intact.
  assert.deepEqual(await f.service.recentActivity(), activityBefore);
});

test('updateRoots failures commit nothing: the state file stays byte-identical and the old list is intact', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const workspace = await f.service.register('Project', [f.project]);
  const stateFile = join(f.store.directory, 'state.json');
  const before = await readFile(stateFile);

  // Unknown/missing root refuses like registration.
  await assert.rejects(f.service.updateRoots(workspace.name, [f.project, join(f.root, 'not-created')]), /real directory, not a symlink/);
  // Within-project overlap (parent + child, duplicates) refuses.
  await assert.rejects(f.service.updateRoots(workspace.name, [f.project, join(f.project, 'child')]), /parent and its child/);
  await assert.rejects(f.service.updateRoots(workspace.name, [f.project, `${f.project}/.`]), /parent and its child/);
  // Symlink root refuses.
  const outside = join(f.root, 'outside'); await mkdir(outside);
  const alias = join(f.root, 'alias'); await symlink(outside, alias);
  await assert.rejects(f.service.updateRoots(workspace.name, [alias]), /real directory, not a symlink/);
  // Count/length parity with registration.
  await assert.rejects(
    f.service.updateRoots(workspace.name, Array.from({ length: 21 }, (_, index) => join(f.root, `candidate-${index}`))),
    /no more than 20/,
  );
  await assert.rejects(f.service.updateRoots(workspace.name, []), /at least one/);
  // Unknown workspace reuses the existing safe error; UUID-shaped input is
  // rejected with the use-the-name guidance (IDs are never accepted).
  await assert.rejects(
    f.service.updateRoots('Missing project', [f.project]),
    /Workspace not found\. Register it first\./,
  );
  await assert.rejects(
    f.service.updateRoots('99999999-9999-4999-8999-999999999999', [f.project]),
    /Provide the registered name, not the ID\./,
  );

  assert.deepEqual(await readFile(stateFile), before);
  assert.deepEqual((await f.store.read()).workspaces[0].roots, [await realpath(f.project)]);
});

test('HTTP roots route serves MCP and the open loopback directly', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const mcpToken = 'd'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };

  const registered = await (await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ name: 'Roots project', roots: [f.project] }),
  })).json() as { id: string; name: string };
  const path = `${origin}/api/workspaces/${registered.name}/roots`;

  // Strict schema: extra keys and empty lists are refused without touching state.
  assert.equal((await fetch(path, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [f.project], extra: true }) })).status, 400);
  assert.equal((await fetch(path, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [] }) })).status, 400);
  assert.equal((await fetch(path, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [join(f.root, 'missing')] }) })).status, 400);
  assert.deepEqual((await f.store.read()).workspaces[0].roots, [await realpath(f.project)]);

  // Unknown workspace reuses the existing safe error over HTTP; UUID-shaped
  // input is rejected with the use-the-name guidance.
  const unknown = await fetch(`${origin}/api/workspaces/Missing%20project/roots`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [f.project] }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json() as { error: string }).error, /Workspace not found/);
  const uuidInput = await fetch(`${origin}/api/workspaces/99999999-9999-4999-8999-999999999999/roots`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [f.project] }),
  });
  assert.equal(uuidInput.status, 400);
  assert.match((await uuidInput.json() as { error: string }).error, /registered name, not the ID/);

  // Happy path over MCP: id preserved, activity records counts only.
  const updated = await fetch(path, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify({ roots: [f.project, f.worktree] }),
  });
  assert.equal(updated.status, 200);
  const body = await updated.json() as { id: string; name: string; roots: string[] };
  assert.equal(body.id, registered.id);
  assert.equal(body.name, 'Roots project');
  assert.deepEqual(body.roots, [await realpath(f.project), await realpath(f.worktree)]);
  const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${mcpToken}` } })).json() as Array<{
    at: string; actor: string; operation: string; workspaceId: string | null; detail: string;
  }>;
  const entry = activity.find(candidate => candidate.operation === 'roots-update');
  assert.deepEqual(entry, { at: entry?.at, actor: 'mcp', operation: 'roots-update', workspaceId: registered.id, detail: '1 → 2 roots' });
  assert.ok(!entry.detail.includes(f.project), 'activity must carry counts only, never raw paths');

  // Open loopback needs no token and no canonical headers.
  const allowed = await fetch(path, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ roots: [f.project] }),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json() as { id: string }).id, registered.id);
});

test('MCP register upserts roots for an existing project end to end', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-update-roots-mcp-')));
  const store = new Store(join(root, 'state')); await store.initialize();
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const worktree = join(root, 'project-worktree'); await mkdir(worktree);
  await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const app = createApp(new WorkspaceService(store), { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    // The update-roots MCP tool is shed (pivot): re-registering the same
    // name replaces the root list in place, preserving the stable ID.
    const tools = await client.listTools();
    assert.ok(!tools.tools.some(candidate => candidate.name === 'workspace_update_roots'), 'workspace_update_roots is not served over MCP');

    const registered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project] } });
    assert.ok(!registered.isError);
    const workspace = JSON.parse((registered.content as Array<{ text: string }>)[0].text) as { id: string; name: string; roots: string[] };

    const upserted = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project, worktree] } });
    assert.ok(!upserted.isError);
    const body = JSON.parse((upserted.content as Array<{ text: string }>)[0].text) as { id: string; name: string; roots: string[] };
    assert.equal(body.id, workspace.id, 'upsert preserves the stable ID');
    assert.deepEqual(body.roots, [await realpath(project), await realpath(worktree)]);

    const invalid = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [join(root, 'missing')] } });
    assert.equal(invalid.isError, true);
    const inspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspace: workspace.name } });
    assert.ok(!inspected.isError);
    assert.deepEqual(JSON.parse((inspected.content as Array<{ text: string }>)[0].text).workspace.roots, body.roots);
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
