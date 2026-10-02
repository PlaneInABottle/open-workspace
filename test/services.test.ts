import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { inspectPm2Services, serviceInventory, type Pm2Process } from '../src/services.js';

async function approvedProject(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-services-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const inner = join(project, 'api');
  const outside = join(root, 'other');
  await mkdir(inner, { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, 'package.json'), '{}');
  await writeFile(join(outside, 'package.json'), '{}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, project, inner, outside, store };
}

function process(cwd: string, name = 'api'): Pm2Process {
  return { pmId: 1, name, namespace: 'default', status: 'online', cwd, restartCount: 2, startedAt: null };
}

test('PM2 service metadata is scoped to approved project roots only', async t => {
  const f = await approvedProject(t);
  const service = new WorkspaceService(f.store, async () => ({ available: true, processes: [process(f.inner), process(f.outside, 'outside')] }));
  const proposal = await service.propose('Project', [f.project]);
  const approved = await service.approve(proposal.id);
  const inventory = await service.services(approved.id);
  assert.equal(inventory.available, true);
  assert.equal(inventory.processCount, 2);
  assert.equal(inventory.matchedProcessCount, 1);
  assert.equal(inventory.unmatchedProcessCount, 1);
  assert.equal(inventory.services[0].cwd, f.inner);
  assert.equal(inventory.services[0].matchedRoots[0], approved.roots[0]);
  assert.equal(inventory.services[0].exactRootPath, approved.roots[0]);
  assert.equal(inventory.ambiguousServices.length, 0);
  assert.ok(!JSON.stringify(inventory).includes(f.outside));
});

test('nested approved roots produce an explicit ambiguous service rather than a fake match', async () => {
  const processPath = await mkdtemp(join(tmpdir(), 'openworkspace-services-ambiguous-'));
  try {
    const parent = await realpath(processPath);
    const child = join(parent, 'service');
    await mkdir(child);
    const mapped = await inspectPm2Services([parent, child], [process(child)]);
    assert.equal(mapped.services.length, 0);
    assert.equal(mapped.ambiguousServices.length, 1);
    assert.equal(mapped.ambiguousServices[0].exactRootPath, null);
    assert.deepEqual(mapped.ambiguousServices[0].matchedRoots, [parent, child]);
    assert.equal(mapped.unmatchedProcessCount, 0);
  } finally {
    await rm(processPath, { recursive: true, force: true });
  }
});

test('service inspection reports missing PM2 as unavailable without claiming a service state', async t => {
  const inventory = await serviceInventory(['/tmp'], async () => ({ available: false, error: 'missing' }));
  assert.equal(inventory.available, false);
  assert.equal(inventory.error, 'missing');
  assert.equal(inventory.services.length, 0);
  assert.equal(inventory.processCount, 0);
});
