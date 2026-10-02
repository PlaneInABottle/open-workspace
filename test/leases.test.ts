import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import type { CommandOutcome, CommandRunner } from '../src/verify.js';

const gitMissing: CommandRunner = async (): Promise<CommandOutcome> => ({
  exitCode: 0, timedOut: false, aborted: false, truncated: false,
  stdout: '', stderr: '', durationMs: 1, spawnFailed: true,
});

async function twoStreams(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-leases-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store, undefined, undefined, undefined, gitMissing);
  const proposal = await service.propose('Project', [first, second]);
  const approved = await service.approve(proposal.id);
  const one = await service.createWorkstream({ name: 'One', workspaceId: approved.id, checkouts: [first] });
  const two = await service.createWorkstream({ name: 'Two', workspaceId: approved.id, checkouts: [second] });
  return { service, one, two };
}

test('the first workstream holds a free resource; the second queues visibly', async t => {
  const f = await twoStreams(t);
  const first = await f.service.acquireLease({ resource: 'port:3000', workstreamId: f.one.id });
  assert.equal(first.lease.status, 'held');
  assert.equal(first.position, 0);
  const second = await f.service.acquireLease({ resource: 'port:3000', workstreamId: f.two.id });
  assert.equal(second.lease.status, 'queued');
  assert.equal(second.position, 1);
  const repeated = await f.service.acquireLease({ resource: 'port:3000', workstreamId: f.two.id });
  assert.equal(repeated.lease.status, 'queued');
  assert.equal(repeated.position, 1);
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.resource, lease.status]), [['port:3000', 'held'], ['port:3000', 'queued']]);
});

test('releasing promotes the oldest queued workstream; only the holder can release', async t => {
  const f = await twoStreams(t);
  await f.service.acquireLease({ resource: 'pm2:api', workstreamId: f.one.id });
  await f.service.acquireLease({ resource: 'pm2:api', workstreamId: f.two.id });
  await assert.rejects(
    f.service.releaseLease({ resource: 'pm2:api', workstreamId: f.two.id }),
    /Only the holding workstream/,
  );
  const released = await f.service.releaseLease({ resource: 'pm2:api', workstreamId: f.one.id });
  assert.deepEqual(released, { released: true, promoted: f.two.id });
  const leases = await f.service.listLeases();
  assert.deepEqual(leases.map(lease => [lease.workstreamId, lease.status]), [[f.two.id, 'held']]);
  const final = await f.service.releaseLease({ resource: 'pm2:api', workstreamId: f.two.id });
  assert.deepEqual(final, { released: true, promoted: null });
  assert.deepEqual(await f.service.listLeases(), []);
});

test('leases refuse unknown workstreams, finished workstreams and bad names', async t => {
  const f = await twoStreams(t);
  await assert.rejects(
    f.service.acquireLease({ resource: 'port:3000', workstreamId: '00000000-0000-4000-8000-000000000000' }),
    /Unknown workstream/,
  );
  await f.service.setWorkstreamStatus(f.one.id, 'done');
  await assert.rejects(
    f.service.acquireLease({ resource: 'port:3000', workstreamId: f.one.id }),
    /cannot hold leases/,
  );
  for (const resource of ['', 'PORT:3000', 'has space', 'x'.repeat(81), '../escape']) {
    await assert.rejects(
      f.service.acquireLease({ resource, workstreamId: f.two.id }),
      /Name the resource/,
    );
  }
  await assert.rejects(
    f.service.releaseLease({ resource: 'port:never-held', workstreamId: f.two.id }),
    /Only the holding workstream/,
  );
  assert.deepEqual(await f.service.listLeases(), []);
});
