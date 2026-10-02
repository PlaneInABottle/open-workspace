import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { controlPm2Service, inspectPm2Services, serviceInventory, type Pm2ListResult, type Pm2Process } from '../src/services.js';

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

test('service control runs only against an exactly mapped PM2 process', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner), process(f.outside, 'outside')] });
  const calls: Array<{ action: string; pmId: number }> = [];
  const service = new WorkspaceService(f.store, list, async (action, pmId) => {
    calls.push({ action, pmId });
    return { ok: true };
  });
  const proposal = await service.propose('Project', [f.project]);
  const approved = await service.approve(proposal.id);

  const result = await service.serviceAction(approved.id, 'restart', { pmId: 1, name: 'api', namespace: 'default' });
  assert.deepEqual(calls, [{ action: 'restart', pmId: 1 }]);
  assert.equal(result.status, 'completed');
  assert.equal(result.serviceStatus, 'online');
  assert.match(result.message, /not readiness/);

  const stopped = await service.serviceAction(approved.id, 'stop', { pmId: 1, name: 'api', namespace: 'default' });
  assert.deepEqual(calls[1], { action: 'stop', pmId: 1 });
  assert.equal(stopped.status, 'completed');
});

test('service control refuses targets that are outside approved or ambiguous roots', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner), process(f.outside, 'outside')] });
  let runnerCalls = 0;
  const service = new WorkspaceService(f.store, list, async () => {
    runnerCalls += 1;
    return { ok: true };
  });
  const proposal = await service.propose('Project', [f.project]);
  const approved = await service.approve(proposal.id);

  const outside = await service.serviceAction(approved.id, 'stop', { pmId: 1, name: 'outside', namespace: 'default' });
  assert.equal(outside.status, 'failed');
  const renamed = await service.serviceAction(approved.id, 'restart', { pmId: 99, name: 'api', namespace: 'default' });
  assert.equal(renamed.status, 'failed');
  const anonymous = await service.serviceAction(approved.id, 'restart', { pmId: null, name: 'api' });
  assert.equal(anonymous.status, 'failed');
  assert.equal(runnerCalls, 0);
});

test('service control does not claim success when PM2 or fresh metadata is unavailable', async t => {
  const f = await approvedProject(t);
  const proposal = await serviceWithState(f.store, f.project);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });
  const failing = new WorkspaceService(f.store, list, async () => ({ ok: false, error: 'missing' }));
  const failed = await failing.serviceAction(proposal.id, 'restart', { pmId: 1, name: 'api', namespace: 'default' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.serviceStatus, 'online');

  let reads = 0;
  const flaky = new WorkspaceService(f.store, async (): Promise<Pm2ListResult> => {
    reads += 1;
    return reads === 1 ? { available: true, processes: [process(f.inner)] } : { available: false, error: 'timeout' };
  }, async () => ({ ok: true }));
  const unknown = await flaky.serviceAction(proposal.id, 'restart', { pmId: 1, name: 'api', namespace: 'default' });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.message, /fresh service metadata is unavailable/);
});

async function serviceWithState(store: Store, root: string) {
  const service = new WorkspaceService(store, async (): Promise<Pm2ListResult> => ({ available: true, processes: [] }));
  const proposal = await service.propose('Project', [root]);
  const approved = await service.approve(proposal.id);
  return approved;
}

test('service control refuses ambiguous nested roots even with a matching process id', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-services-control-')));
  try {
    const child = join(parent, 'service');
    await mkdir(child);
    let runnerCalls = 0;
    const result = await controlPm2Service([parent, child], 'restart', { pmId: 1, name: 'api', namespace: 'default' }, async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(child)] }), async () => {
      runnerCalls += 1;
      return { ok: true };
    });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /not uniquely mapped/);
    assert.equal(runnerCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('controlPm2Service rejects a namespace mismatch without invoking PM2', async t => {
  const f = await approvedProject(t);
  let runnerCalls = 0;
  const result = await controlPm2Service([f.project], 'restart', { pmId: 1, name: 'api', namespace: 'other' }, async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] }), async () => {
    runnerCalls += 1;
    return { ok: true };
  });
  assert.equal(result.status, 'failed');
  assert.equal(runnerCalls, 0);
});

test('service inspection reports missing PM2 as unavailable without claiming a service state', async t => {
  const inventory = await serviceInventory(['/tmp'], async () => ({ available: false, error: 'missing' }));
  assert.equal(inventory.available, false);
  assert.equal(inventory.error, 'missing');
  assert.equal(inventory.services.length, 0);
  assert.equal(inventory.processCount, 0);
});
