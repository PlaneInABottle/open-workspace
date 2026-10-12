import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { nameMessages } from '../src/store.js';
import { workspaceMessages } from '../src/workspace.js';
import { environmentMessages } from '../src/environment.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }, name = 'names-fixture') {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"check":"node check.js"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  return { root, project, store, service };
}

test('workspace names are unique globally, case-insensitively, with UUID/charset refusal', async t => {
  const f = await fixture(t);
  const first = await f.service.register('Gate Project', [f.project]);
  assert.equal(first.name, 'Gate Project');
  // Upsert (harness-first pivot): re-registering a taken name replaces its
  // roots in place instead of refusing — the agent's path for fixing roots.
  const same = await f.service.register('gate project', [f.project]);
  assert.equal(same.id, first.id, 'same name upserts onto the stable ID');
  assert.equal(same.name, 'Gate Project', 'stored casing preserved');
  const padded = await f.service.register('  Gate Project  ', [f.project]);
  assert.equal(padded.id, first.id);
  assert.equal((await f.store.read()).workspaces.length, 1, 'upsert never duplicates');
  await assert.rejects(
    f.service.register('12345678-1234-4234-8234-1234567890ab', [f.project]),
    new RegExp(escapeRegExp(nameMessages.useTheName)),
  );
  for (const bad of ['', '   ', 'has/slash', '.', '..', 'has\0nul', 'has\nnewline']) {
    await assert.rejects(f.service.register(bad, [f.project]), new RegExp(escapeRegExp(workspaceMessages.projectName)));
  }
  assert.equal((await f.store.read()).workspaces.length, 1);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('environment set replaces case-insensitively instead of duplicating', async t => {
  const f = await fixture(t);
  await f.service.register('Stack', [f.project]);
  const draft = {
    services: [{ id: 'api', repositoryPath: f.project, scriptName: 'check', port: null as number | null, readiness: { kind: 'process-alive' as const } }],
  };
  const first = await f.service.environmentSet('Stack', { name: 'local', ...draft });
  const second = await f.service.environmentSet('STACK', { name: 'LOCAL', ...draft });
  assert.equal(second.id, first.id, 'same record replaced in place');
  assert.equal(second.name, 'local', 'stored casing preserved; rename is the explicit path');
  assert.equal((await f.service.environmentList('Stack')).length, 1);
});

test('workspace rename preserves identity, roots, runs and activity', async t => {
  const f = await fixture(t);
  const registered = await f.service.register('Before', [f.project]);
  await f.service.recordActivity({ actor: 'mcp', operation: 'register', workspaceId: registered.id, detail: 'Before' });
  const renamed = await f.service.renameWorkspace('before', 'After');
  assert.equal(renamed.id, registered.id, 'stable ID preserved');
  assert.equal(renamed.name, 'After');
  assert.deepEqual(renamed.roots, [registered.roots[0]]);
  const state = await f.store.read();
  assert.equal(state.workspaces[0].id, registered.id);
  assert.ok(state.activity.some(entry => entry.workspaceId === registered.id), 'activity still keyed by stable ID');
  await assert.rejects(f.service.inspect('Before'), /Workspace not found/);
  assert.equal((await f.service.inspect('After')).workspace.id, registered.id);
});

test('workspace rename to a taken name is refused; casing-only rename works', async t => {
  const f = await fixture(t);
  const second = join(f.root, 'second');
  await mkdir(second, { recursive: true });
  await f.service.register('Alpha', [f.project]);
  await f.service.register('Beta', [second]);
  await assert.rejects(f.service.renameWorkspace('Alpha', 'beta'), new RegExp(escapeRegExp(workspaceMessages.projectNameTaken)));
  const recased = await f.service.renameWorkspace('Alpha', 'ALPHA');
  assert.equal(recased.name, 'ALPHA');
});

test('environment rename preserves owned and lifecycle', async t => {
  const f = await fixture(t);
  await f.service.register('Stack', [f.project]);
  const env = await f.service.environmentSet('Stack', {
    name: 'local',
    services: [{ id: 'api', repositoryPath: f.project, scriptName: 'check', port: null as number | null, readiness: { kind: 'process-alive' as const } }],
  });
  const renamedEnv = await f.service.renameEnvironment('Stack', 'LOCAL', 'dev');
  assert.equal(renamedEnv.id, env.id, 'stable env ID preserved');
  assert.deepEqual(renamedEnv.owned, env.owned, 'owned processes preserved');
  assert.equal(renamedEnv.state, env.state, 'lifecycle state preserved');
  await f.service.environmentSet('Stack', {
    name: 'other',
    services: [{ id: 'web', repositoryPath: f.project, scriptName: 'check', port: null as number | null, readiness: { kind: 'process-alive' as const } }],
  });
  await assert.rejects(
    f.service.renameEnvironment('Stack', 'dev', 'OTHER'),
    new RegExp(escapeRegExp(environmentMessages.envNameTaken)),
  );
});

test('legacy duplicate names resolve to an ambiguity error carrying candidates', async t => {
  const f = await fixture(t);
  const second = join(f.root, 'second');
  await mkdir(second, { recursive: true });
  const at = new Date().toISOString();
  await writePrivateJson(join(f.store.directory, 'state.json'), {
    workspaces: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Dupe', roots: [f.project], linkedContainers: [], createdAt: at },
      { id: '22222222-2222-4222-8222-222222222222', name: 'dupe', roots: [second], linkedContainers: [], createdAt: at },
    ],
  });
  const service = new WorkspaceService(f.store);
  const error = await service.inspect('DUPE').catch((error: unknown) => error);
  assert.ok(error instanceof Error);
  assert.match(error.message, new RegExp(`^${escapeRegExp(nameMessages.ambiguous)} Candidates: `));
  assert.match(error.message, /"Dupe"/);
  assert.match(error.message, /"dupe"/);
  const candidates = (error as { candidates?: Array<{ name: string; rootLabel: string; createdAt: string }> }).candidates;
  assert.equal(candidates?.length, 2);
  assert.deepEqual(candidates?.map(candidate => candidate.name).sort(), ['Dupe', 'dupe']);
  assert.ok(candidates?.every(candidate => typeof candidate.rootLabel === 'string' && typeof candidate.createdAt === 'string'));
});

test('HTTP boundary: names round-trip encoded, UUID inputs rejected, ambiguity lists candidates', async t => {
  const f = await fixture(t, 'names-http');
  const spaced = join(f.root, 'my project');
  await mkdir(spaced, { recursive: true });
  await writeFile(join(spaced, 'package.json'), '{"scripts":{"check":"node check.js"}}');
  const service = f.service;
  const app = createApp(service, { mcpToken: 'c'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcp = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };

  const registered = await (await fetch(`${origin}/api/workspaces`, {
    method: 'POST', headers: mcp, body: JSON.stringify({ name: 'Spaced Project', roots: [spaced] }),
  })).json() as { id: string; name: string };
  assert.equal(registered.name, 'Spaced Project');

  // URL-encoded space round-trip through inspect, update-roots and remove paths.
  const encoded = `${origin}/api/workspaces/${encodeURIComponent('Spaced Project')}`;
  assert.equal((await fetch(encoded, { headers: mcp })).status, 200);
  assert.equal((await fetch(`${origin}/api/workspaces/Spaced%20Project/roots`, {
    method: 'POST', headers: mcp, body: JSON.stringify({ roots: [spaced] }),
  })).status, 200);

  // UUID-shaped inputs are rejected with the use-the-name guidance everywhere.
  const setDraft = {
    services: [{ id: 'api', repositoryPath: spaced, scriptName: 'check', port: null as number | null, readiness: { kind: 'process-alive' as const } }],
  };
  const uuidCases: Array<{ path: string; method: string; body?: unknown }> = [
    { path: `${origin}/api/workspaces/11111111-1111-4111-8111-111111111111`, method: 'GET' },
    { path: `${origin}/api/workspaces/11111111-1111-4111-8111-111111111111/roots`, method: 'POST', body: { roots: [spaced] } },
    { path: `${origin}/api/workspaces/11111111-1111-4111-8111-111111111111/rename`, method: 'POST', body: { name: 'Elsewhere' } },
    { path: `${origin}/api/workspaces/11111111-1111-4111-8111-111111111111/environments/status?environment=local`, method: 'GET' },
    { path: `${origin}/api/workspaces/${encodeURIComponent('Spaced Project')}/environments/set`, method: 'POST', body: { name: '11111111-1111-4111-8111-111111111111', ...setDraft } },
  ];
  for (const { path, method, body } of uuidCases) {
    const denied = await fetch(path, { method, headers: mcp, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(denied.status, 400, path);
    assert.deepEqual(await denied.json(), { error: nameMessages.useTheName }, path);
  }
  // Malformed env names never persist or occupy a slot.
  for (const bad of ['has/slash', '..', '  ']) {
    const refused = await fetch(`${origin}/api/workspaces/${encodeURIComponent('Spaced Project')}/environments/set`, {
      method: 'POST', headers: mcp, body: JSON.stringify({ name: bad, ...setDraft }),
    });
    assert.equal(refused.status, 400, bad);
    assert.deepEqual(await refused.json(), { error: environmentMessages.badTopology }, bad);
  }
  assert.deepEqual(await service.environmentList('Spaced Project'), [], 'refused sets store nothing');

  // Rename over HTTP preserves the ID; the old name stops resolving.
  const renamed = await (await fetch(`${encoded}/rename`, {
    method: 'POST', headers: mcp, body: JSON.stringify({ name: 'Renamed Project' }),
  })).json() as { id: string; name: string };
  assert.equal(renamed.id, registered.id);
  assert.equal(renamed.name, 'Renamed Project');
  assert.equal((await fetch(encoded, { headers: mcp })).status, 400);
  assert.equal((await fetch(`${origin}/api/workspaces/${encodeURIComponent('Renamed Project')}`, { headers: mcp })).status, 200);

  // Legacy duplicates surface the candidate list over HTTP.
  const at = new Date().toISOString();
  await writePrivateJson(join(f.store.directory, 'state.json'), {
    workspaces: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Dupe', roots: [spaced], linkedContainers: [], createdAt: at },
      { id: '22222222-2222-4222-8222-222222222222', name: 'dupe', roots: [spaced], linkedContainers: [], createdAt: at },
    ],
  });
  const ambiguous = await fetch(`${origin}/api/workspaces/dupe`, { headers: mcp });
  assert.equal(ambiguous.status, 400);
  const ambiguousBody = await ambiguous.json() as { error: string; candidates: Array<{ name: string; rootLabel: string; createdAt: string }> };
  assert.match(ambiguousBody.error, new RegExp(`^${escapeRegExp(nameMessages.ambiguous)} Candidates: `));
  assert.deepEqual(ambiguousBody.candidates.map(candidate => candidate.name), ['Dupe', 'dupe']);
  assert.ok(ambiguousBody.candidates.every(candidate => candidate.createdAt === at));
  assert.ok(ambiguousBody.candidates.every(candidate => candidate.rootLabel.length <= 60), 'labels truncated');
});

test('end-to-end run addressed only by name keeps receipts intact across a rename', async t => {
  const f = await fixture(t, 'names-e2e');
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const mcp = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const call = async (path: string, body?: unknown) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: mcp, body: JSON.stringify(body ?? {}) });

  const registered = await (await call('/api/workspaces', { name: 'Journey', roots: [f.project] })).json() as { id: string };
  const setBody = {
    name: 'local',
    services: [{ id: 'api', repositoryPath: f.project, scriptName: 'check', port: null, readiness: { kind: 'process-alive' } }],
  };
  assert.equal((await call(`/api/workspaces/${encodeURIComponent('Journey')}/environments/set`, setBody)).status, 200);
  const status = await (await fetch(
    `${origin}/api/workspaces/${encodeURIComponent('Journey')}/environments/status?environment=${encodeURIComponent('local')}`,
    { headers: mcp },
  )).json() as { environmentId: string };
  assert.ok(status.environmentId, 'status carries the stable internal ID');
  const imported = await (await call('/api/runs/import', {
    workspace: 'Journey', scriptName: 'check', outcome: 'passed', durationMs: 7, excerpt: 'upstream ok',
  })).json() as { workspaceId: string };
  assert.equal(imported.workspaceId, registered.id, 'runs stay keyed by the stable ID');
  const runs = await (await fetch(
    `${origin}/api/runs/recent?workspace=${encodeURIComponent('Journey')}`,
    { headers: mcp },
  )).json() as Array<{ workspaceId: string }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].workspaceId, registered.id);

  // Rename mid-journey: receipts follow the stable IDs.
  assert.equal((await call(`/api/workspaces/${encodeURIComponent('Journey')}/rename`, { name: 'Odyssey' })).status, 200);
  const after = await (await fetch(
    `${origin}/api/runs/recent?workspace=${encodeURIComponent('Odyssey')}`,
    { headers: mcp },
  )).json() as Array<{ workspaceId: string }>;
  assert.equal(after.length, 1, 'runs intact across the rename');
  assert.equal(after[0].workspaceId, registered.id);
  const activity = await (await fetch(`${origin}/api/activity`, { headers: mcp })).json() as Array<{ operation: string; detail: string; workspaceId: string | null }>;
  for (const operation of ['register', 'environment-set', 'run-import', 'workspace-rename']) {
    assert.ok(activity.some(entry => entry.operation === operation), `activity records ${operation}`);
  }
  assert.ok(activity.every(entry => entry.workspaceId === registered.id || entry.workspaceId === null),
    'activity stays keyed by the stable ID across renames');
});

test('M-a ambiguity candidates: structured array basename-only, message keeps full labels', async () => {
  const { AmbiguousNameError } = await import('../src/store.js');
  const error = new AmbiguousNameError([
    { name: 'api', rootLabel: '/Users/x/proj/backend', createdAt: '2026-01-01' },
    { name: 'api', rootLabel: '/Users/x/other/backend', createdAt: '2026-01-02' },
  ]);
  assert.deepEqual(error.candidates, [
    { name: 'api', rootLabel: 'backend', createdAt: '2026-01-01' },
    { name: 'api', rootLabel: 'backend', createdAt: '2026-01-02' },
  ]);
  assert.ok(error.message.includes('/Users/x/proj/backend'), 'MCP string keeps full label');
  assert.ok(!JSON.stringify(error.candidates).includes('/Users/x/'), 'structured array carries no full paths');
});
