import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { operatorCovers } from '../src/operator.js';

async function twoProjects(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-operator-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const firstProposal = await service.propose('First', [first]);
  const secondProposal = await service.propose('Second', [second]);
  const one = await service.approve(firstProposal.id);
  const two = await service.approve(secondProposal.id);
  return { service, one, two };
}

test('operator delegation starts empty and covers only granted workspaces', async t => {
  const f = await twoProjects(t);
  assert.equal(await f.service.operatorScope(), null);
  assert.equal(await f.service.operatorCovers(f.one.id), false);
  const scope = await f.service.setOperatorScope([f.one.id]);
  assert.deepEqual(scope?.workspaceIds, [f.one.id]);
  assert.equal(await f.service.operatorCovers(f.one.id), true);
  assert.equal(await f.service.operatorCovers(f.two.id), false);
  assert.equal(operatorCovers(null, f.one.id), false);
});

test('delegation replaces the set; empty revokes; unknown workspaces rejected', async t => {
  const f = await twoProjects(t);
  await f.service.setOperatorScope([f.one.id, f.two.id, f.one.id]);
  assert.deepEqual((await f.service.operatorScope())?.workspaceIds, [f.one.id, f.two.id]);
  assert.equal(await f.service.setOperatorScope([]), null);
  assert.equal(await f.service.operatorScope(), null);
  await assert.rejects(
    f.service.setOperatorScope(['00000000-0000-4000-8000-000000000000']),
    /approved workspaces only/,
  );
  assert.equal(await f.service.operatorScope(), null);
});

test('revoking a workspace prunes it from the delegation', async t => {
  const f = await twoProjects(t);
  await f.service.setOperatorScope([f.one.id, f.two.id]);
  await f.service.revoke(f.one.id);
  assert.deepEqual((await f.service.operatorScope())?.workspaceIds, [f.two.id]);
  await f.service.revoke(f.two.id);
  assert.equal(await f.service.operatorScope(), null);
});

test('mutations record actor activity with a bounded trail', async t => {
  const f = await twoProjects(t);
  await f.service.recordActivity({ actor: 'dashboard', operation: 'approve', workspaceId: f.one.id, detail: 'first' });
  await f.service.recordActivity({ actor: 'mcp-operator', operation: 'verify', workspaceId: null, detail: 'check' });
  const trail = await f.service.recentActivity();
  assert.equal(trail.length, 2);
  assert.equal(trail[0].actor, 'dashboard');
  assert.equal(trail[1].operation, 'verify');
  assert.ok(trail.every(entry => Number.isFinite(Date.parse(entry.at))));
  for (let index = 0; index < 60; index++) {
    await f.service.recordActivity({ actor: 'dashboard', operation: `op-${index}`, workspaceId: null, detail: '' });
  }
  const capped = await f.service.recentActivity();
  assert.equal(capped.length, 50);
  assert.equal(capped[0].operation, 'op-10');
});
