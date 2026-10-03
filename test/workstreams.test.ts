import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';
import type { CommandOutcome, CommandRunner } from '../src/verify.js';

const SHA = 'b'.repeat(40);

function outcome(partial: Partial<CommandOutcome>): CommandOutcome {
  return {
    exitCode: 0, timedOut: false, aborted: false, truncated: false,
    stdout: '', stderr: '', durationMs: 2, spawnFailed: false, ...partial,
  };
}

const gitSha: CommandRunner = async () => outcome({ stdout: `${SHA}\n` });
const gitMissing: CommandRunner = async () => outcome({ spawnFailed: true });

async function approvedWorkspace(t: { after: (cleanup: () => void | Promise<void>) => void }, roots: string[] = ['repo-a', 'repo-b']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-workstreams-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [];
  for (const name of roots) {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    paths.push(path);
  }
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const approved = await service.register('Project', paths);
  return { root, paths, store, approved };
}

test('workstreams bind registered roots and pin observed revisions', async t => {
  const f = await approvedWorkspace(t);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, gitSha);
  const workstream = await service.createWorkstream({ name: 'Checkout one', workspaceId: f.approved.id, checkouts: [f.paths[0]] });
  assert.equal(workstream.status, 'active');
  assert.equal(workstream.workspaceId, f.approved.id);
  assert.deepEqual(workstream.checkouts.map(checkout => checkout.root), [f.paths[0]]);
  assert.equal(workstream.checkouts[0].revision, SHA);
  assert.equal(workstream.checkouts[0].revisionState, 'observed');
  assert.ok(Number.isFinite(Date.parse(workstream.checkouts[0].observedAt)));
  assert.deepEqual((await service.listWorkstreams()).map(entry => entry.id), [workstream.id]);
  assert.equal((await service.workstream(workstream.id)).name, 'Checkout one');
});

test('workstreams record unknown revisions honestly when git is unavailable', async t => {
  const f = await approvedWorkspace(t);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, gitMissing);
  const workstream = await service.createWorkstream({ name: 'Plain', workspaceId: f.approved.id, checkouts: f.paths });
  assert.equal(workstream.checkouts.length, 2);
  assert.ok(workstream.checkouts.every(checkout => checkout.revision === null && checkout.revisionState === 'unknown'));
});

test('workstreams refuse unapproved, redirected and duplicate checkouts without storing', async t => {
  const f = await approvedWorkspace(t);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, gitSha);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await assert.rejects(
    service.createWorkstream({ name: 'Outside', workspaceId: f.approved.id, checkouts: [outside] }),
    /registered roots/,
  );
  await assert.rejects(
    service.createWorkstream({ name: 'Unknown', workspaceId: '00000000-0000-4000-8000-000000000000', checkouts: [f.paths[0]] }),
    /Workspace access not found/,
  );
  await assert.rejects(
    service.createWorkstream({ name: 'Empty', workspaceId: f.approved.id, checkouts: [] }),
    /at least one checkout/,
  );
  await assert.rejects(
    service.createWorkstream({ name: ' ', workspaceId: f.approved.id, checkouts: [f.paths[0]] }),
    /workstream name/,
  );
  const subdir = join(f.paths[0], 'sub');
  await mkdir(subdir);
  await assert.rejects(
    service.createWorkstream({ name: 'Subdir', workspaceId: f.approved.id, checkouts: [subdir] }),
    /registered roots/,
  );
  const link = join(f.root, 'linked');
  await mkdir(link);
  await symlink(f.paths[1], join(link, 'alias'));
  await assert.rejects(
    service.createWorkstream({ name: 'Linked', workspaceId: f.approved.id, checkouts: [join(link, 'alias')] }),
    /registered roots/,
  );
  const doubled = await service.createWorkstream({ name: 'Doubled', workspaceId: f.approved.id, checkouts: [f.paths[0], f.paths[0]] });
  assert.deepEqual(doubled.checkouts.map(checkout => checkout.root), [f.paths[0]]);
  assert.equal((await service.listWorkstreams()).length, 1);
});

test('workstream status moves forward but a finished workstream cannot reopen', async t => {
  const f = await approvedWorkspace(t);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, gitSha);
  const workstream = await service.createWorkstream({ name: 'Flow', workspaceId: f.approved.id, checkouts: [f.paths[0]] });
  const paused = await service.setWorkstreamStatus(workstream.id, 'paused');
  assert.equal(paused.status, 'paused');
  const resumed = await service.setWorkstreamStatus(workstream.id, 'active');
  assert.equal(resumed.status, 'active');
  const done = await service.setWorkstreamStatus(workstream.id, 'done');
  assert.equal(done.status, 'done');
  await assert.rejects(service.setWorkstreamStatus(workstream.id, 'active'), /cannot be reopened/);
  await assert.rejects(service.setWorkstreamStatus('00000000-0000-4000-8000-000000000000', 'paused'), /Unknown workstream/);
  await assert.rejects(service.workstream('00000000-0000-4000-8000-000000000000'), /Unknown workstream/);
});

test('workstream creation is bounded at fifty entries', async t => {
  const f = await approvedWorkspace(t, ['only']);
  const service = new WorkspaceService(f.store, undefined, undefined, undefined, gitMissing);
  for (let index = 0; index < 50; index++) {
    await service.createWorkstream({ name: `Stream ${index}`, workspaceId: f.approved.id, checkouts: [f.paths[0]] });
  }
  await assert.rejects(
    service.createWorkstream({ name: 'Overflow', workspaceId: f.approved.id, checkouts: [f.paths[0]] }),
    /Workstream limit reached/,
  );
  assert.equal((await service.listWorkstreams()).length, 50);
});

test('HTTP workstream creation surfaces the unregistered-workspace denial instead of the generic fallback', async t => {
  const f = await approvedWorkspace(t);
  const service = new WorkspaceService(f.store);
  const app = createApp(service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const response = await fetch(`${origin}/api/workstreams`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'f'.repeat(64)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Unknown workspace',
      workspaceId: '00000000-0000-4000-8000-000000000000',
      checkouts: [f.paths[0]],
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Workspace access not found.' });
});
