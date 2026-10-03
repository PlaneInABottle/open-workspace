import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import {
  learningInstructionSuffix,
  listRunIds,
  maxScopesPerStartupScan,
  persistRunSummary,
} from '../src/run-summaries.js';

async function registeredFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Cleanup project', [project]);
  return { root, project, store, service, workspace };
}

test('workspace removal deletes its runs scope dir', async t => {
  const f = await registeredFixture('openworkspace-scope-cleanup-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  assert.equal((await readdir(join(f.store.directory, 'runs', f.workspace.id))).length, 1);
  await f.service.remove(f.workspace.id);
  await assert.rejects(readdir(join(f.store.directory, 'runs', f.workspace.id)), /ENOENT/);
  assert.deepEqual(await listRunIds(f.store.directory, f.workspace.id), new Set());
  assert.equal((await f.store.read()).workspaces.length, 0);
});

test('workspace removal succeeds when scope cleanup fails, logging paths only', async t => {
  const f = await registeredFixture('openworkspace-scope-cleanup-fails-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const marker = 'MARKER-scope-content-never-logged';
  await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: `ok ${marker}`, outputTruncated: false,
  });
  const scopeDir = join(f.store.directory, 'runs', f.workspace.id);
  // Revoke write on the scope dir so recursive content deletion fails.
  await chmod(scopeDir, 0o500);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const result = await f.service.remove(f.workspace.id);
    assert.deepEqual(result, { removed: true });
  } finally {
    console.error = originalError;
    await chmod(scopeDir, 0o700).catch(() => {});
  }
  assert.equal((await f.store.read()).workspaces.length, 0, 'state commit stands despite cleanup failure');
  assert.ok(logged.length >= 1, 'cleanup failure is logged honestly');
  assert.ok(!logged.join('\n').includes(marker), 'cleanup log carries paths only, never run content');
});

test('startup scan stays bounded with many orphan dirs present', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-scan-bounds-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(maxScopesPerStartupScan, 50, 'scan cap tracks the 50-workspace registration limit');
  const summary = (durationMs: number, scope: string) => JSON.stringify({
    workspaceId: scope, scriptName: 'test', outcome: 'passed', durationMs,
    at: new Date().toISOString(), failingNames: [], failingTruncated: false,
    failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false,
  });
  const slowFiles = async (scope: string) => {
    const dir = join(home, 'runs', scope);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '1000.json'), summary(2000, scope));
    await writeFile(join(dir, '2000.json'), summary(2100, scope));
    await writeFile(join(dir, '3000.json'), summary(9000, scope));
  };
  // A non-scope directory holding slow-looking runs must not feed the signal.
  await slowFiles('not-a-scope');
  assert.equal(await learningInstructionSuffix(home), undefined, 'non-UUID entries are skipped');
  // A stray file in runs/ is skipped as well.
  await writeFile(join(home, 'runs', 'stray.json'), '{}');
  // Live slow scope sorts first; orphans sort after it.
  const live = '00000001-0001-4001-8001-000000000001';
  await slowFiles(live);
  for (let index = 0; index < 200; index++) {
    const orphan = `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`;
    await mkdir(join(home, 'runs', orphan), { recursive: true });
  }
  const suffix = await learningInstructionSuffix(home);
  assert.match(suffix ?? '', /4\.4x expected.*learn-from-mistake/, 'live signal found despite 200 orphans');
  assert.ok(Buffer.byteLength(suffix ?? '', 'utf8') <= 200, 'suffix keeps total instructions under budget');
});

test('registered scopes are scanned before 50+ lexically earlier orphan directories', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-scan-priority-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  await mkdir(project);
  const store = new Store(home);
  await store.initialize();
  const service = new WorkspaceService(store);
  await service.register('Live workspace', [project]);
  const live = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await store.update(state => { state.workspaces[0].id = live; });

  const runsDir = join(home, 'runs', live);
  await mkdir(runsDir, { recursive: true });
  const summary = (durationMs: number) => JSON.stringify({
    workspaceId: live, scriptName: 'test', outcome: 'passed', durationMs,
    at: new Date().toISOString(), failingNames: [], failingTruncated: false,
    failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false,
  });
  await writeFile(join(runsDir, '1000.json'), summary(2000));
  await writeFile(join(runsDir, '2000.json'), summary(2100));
  await writeFile(join(runsDir, '3000.json'), summary(9000));

  for (let index = 0; index < maxScopesPerStartupScan + 5; index++) {
    const orphan = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await mkdir(join(home, 'runs', orphan), { recursive: true });
  }
  const suffix = await learningInstructionSuffix(home);
  assert.match(suffix ?? '', /4\.4x expected.*learn-from-mistake/, 'registered live scope wins before lexically earlier orphan scopes');
});
