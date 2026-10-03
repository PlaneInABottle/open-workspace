import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ensurePrivateDirectory, writePrivateJson, type State } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import {
  listRecentRuns,
  listRunIds,
  maxPinnedSummariesPerScope,
  persistRunSummary,
  runIdFromFile,
} from '../src/run-summaries.js';
import {
  checkpointBoundsMessage,
  checkpointEvidenceMessage,
  pinnedRunIds,
} from '../src/workstreams.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const SHA = 'd'.repeat(40);

async function approvedFixture(prefix: string, withVerifyRunner = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const stubRun = withVerifyRunner
    ? (async () => ({
        exitCode: 0, timedOut: false, aborted: false, truncated: false,
        stdout: 'ok 1 fine', stderr: '', durationMs: 11, spawnFailed: false,
      }))
    : undefined;
  const service = new WorkspaceService(store, undefined, undefined, stubRun);
  const workspace = await service.register('Pin project', [project]);
  const workstream = await service.createWorkstream({
    name: 'Stream', workspaceId: workspace.id, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

const note = (partial: Record<string, unknown> = {}) => ({
  goal: 'finish checkout review', blocker: 'waiting on mapping probe', next: 'rerun the bounded check', owner: 'agent',
  ...partial,
});

async function runFiles(store: Store, workspaceId: string): Promise<string[]> {
  return (await readdir(join(store.directory, 'runs', workspaceId))).filter(name => name.endsWith('.json')).sort();
}

test('evidence links pin a run past the 20-file ring with flags both ways', async t => {
  const f = await approvedFixture('openworkspace-pin-ring-', true);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await f.service.verify(f.workspace.id, { repositoryPath: f.project, scriptName: 'test' });
  assert.equal(first.outcome, 'passed');
  const [seeded] = await f.service.recentRuns(f.workspace.id, 5);
  assert.ok(seeded.id, 'run entries carry a stable opaque ID');
  const pinned = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: [seeded.id] }));
  assert.deepEqual(pinned.checkpointNote?.evidence, [seeded.id]);

  // Correlation both ways: the note names the ID, the run entry flags the pin.
  const flaggedEarly = await f.service.recentRuns(f.workspace.id, 20);
  assert.equal(flaggedEarly.find(entry => entry.id === seeded.id)?.pinnedByNote, true);
  assert.ok(flaggedEarly.filter(entry => entry.id !== seeded.id).every(entry => entry.pinnedByNote === false));

  // 21 more verifies push the ring past 20; the pinned run must survive while
  // the oldest unpinned run evicts.
  for (let index = 0; index < 21; index++) {
    await f.service.verify(f.workspace.id, { repositoryPath: f.project, scriptName: 'test' });
  }
  const files = await runFiles(f.store, f.workspace.id);
  assert.equal(files.length, 21, 'ring holds 20 plus the one pin');
  assert.ok(files.includes(`${seeded.id}.json`), 'pinned run survives eviction');

  const reread = await f.service.workstream(f.workstream.id);
  assert.deepEqual(reread.checkpointNote?.evidence, [seeded.id], 'note → run link survives');
  // Secret-free: IDs only, no excerpts or content duplicated into the note.
  assert.ok(!JSON.stringify(reread.checkpointNote).includes('ok 1 fine'));
});

test('unknown and out-of-scope run IDs are refused with a safe error', async t => {
  const f = await approvedFixture('openworkspace-pin-unknown-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: ['0000-deadbeef'] })),
    (error: unknown) => {
      assert.equal((error as Error).message, checkpointEvidenceMessage);
      return true;
    },
  );
  // A run from another workspace is unknown in this scope.
  const otherProject = join(f.root, 'other');
  await mkdir(otherProject, { recursive: true });
  const other = await f.service.register('Other project', [otherProject]);
  const foreign = await persistRunSummary(f.store.directory, {
    workspaceId: other.id, scriptName: 'test', outcome: 'passed', durationMs: 3, output: 'ok', outputTruncated: false,
  });
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: [foreign.id] })),
    (error: unknown) => {
      assert.equal((error as Error).message, checkpointEvidenceMessage);
      return true;
    },
  );
  assert.equal((await f.service.workstream(f.workstream.id)).checkpointNote, null, 'refused note stores nothing');
});

test('checkpoint evidence is revalidated inside queued status writes after pruning', async t => {
  for (const status of ['paused', 'done'] as const) {
    const f = await approvedFixture(`openworkspace-checkpoint-prune-race-${status}-`);
    const oldEvidenceId = `0000000000000-old-${status}`;
    const runsDirectory = join(f.store.directory, 'runs', f.workspace.id);
    const originalUpdate = f.store.update.bind(f.store);
    try {
      await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(runsDirectory, `${oldEvidenceId}.json`), '{}', { mode: 0o600 });
      for (let index = 0; index < 19; index++) {
        await persistRunSummary(f.store.directory, {
          workspaceId: f.workspace.id, scriptName: `seed-${index}`, outcome: 'passed', durationMs: 1,
          output: 'ok', outputTruncated: false,
        });
      }
      assert.ok((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId));

      let injectPrune = true;
      f.store.update = function <T>(change: (state: State) => T | Promise<T>): Promise<T> {
        if (injectPrune) {
          injectPrune = false;
          // Run the ring prune before the note/status update is queued, matching
          // the old validation-then-queue interleave.
          return persistRunSummary(f.store.directory, {
            workspaceId: f.workspace.id, scriptName: 'concurrent-prune', outcome: 'passed', durationMs: 1,
            output: 'ok', outputTruncated: false,
          }, f.store).then(() => originalUpdate(change));
        }
        return originalUpdate(change);
      };
      await assert.rejects(
        f.service.setWorkstreamStatus(f.workstream.id, status, note({ evidence: [oldEvidenceId] })),
        (error: unknown) => {
          assert.equal((error as Error).message, checkpointEvidenceMessage);
          return true;
        },
        `${status} update must reject evidence evicted before its queued commit`,
      );
      assert.equal((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId), false, 'the competing prune evicted the unpinned run');
      const unchanged = await f.service.workstream(f.workstream.id);
      assert.equal(unchanged.status, 'active');
      assert.equal(unchanged.checkpointNote, null, 'no dangling note is committed');
    } finally {
      f.store.update = originalUpdate;
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('evidence holds at most five well-formed IDs', async t => {
  const f = await approvedFixture('openworkspace-pin-bounds-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    const summary = await persistRunSummary(f.store.directory, {
      workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: index, output: 'ok', outputTruncated: false,
    });
    ids.push(summary.id as string);
  }
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: ids })),
    (error: unknown) => {
      assert.equal((error as Error).message, checkpointBoundsMessage);
      return true;
    },
  );
  for (const malformed of ['/etc/passwd', '..\\escape', 'has space', '', 'x'.repeat(129)]) {
    await assert.rejects(
      f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: [malformed] })),
      (error: unknown) => {
        assert.equal((error as Error).message, checkpointBoundsMessage);
        return true;
      },
      `must refuse ${malformed.slice(0, 20)}`,
    );
  }
  const five = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: ids.slice(0, 5) }));
  assert.deepEqual(five.checkpointNote?.evidence, ids.slice(0, 5));
  const flagged = await f.service.recentRuns(f.workspace.id, 20);
  assert.equal(flagged.filter(entry => entry.pinnedByNote).length, 5);
});

test('editing the note to drop a ref unpins and re-enables eviction', async t => {
  const f = await approvedFixture('openworkspace-pin-unpin-', true);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.verify(f.workspace.id, { repositoryPath: f.project, scriptName: 'test' });
  const [seeded] = await f.service.recentRuns(f.workspace.id, 5);
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: [seeded.id] }));
  for (let index = 0; index < 21; index++) {
    await f.service.verify(f.workspace.id, { repositoryPath: f.project, scriptName: 'test' });
  }
  assert.ok((await runFiles(f.store, f.workspace.id)).includes(`${seeded.id}.json`), 'pinned survives first');

  // No separate unpin tool: rewriting the note without evidence drops the pin.
  const edited = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note());
  assert.deepEqual(edited.checkpointNote?.evidence, [], 'omitted evidence means no links');
  for (let index = 0; index < 21; index++) {
    await f.service.verify(f.workspace.id, { repositoryPath: f.project, scriptName: 'test' });
  }
  const files = await runFiles(f.store, f.workspace.id);
  assert.equal(files.length, 20, 'ring returns to 20 with no pins');
  assert.ok(!files.includes(`${seeded.id}.json`), 'unpinned run evicts again');
  assert.ok((await f.service.recentRuns(f.workspace.id, 20)).every(entry => entry.pinnedByNote === false));
});

test('pins never push a scope past the 30-file hard ceiling', async t => {
  const f = await approvedFixture('openworkspace-pin-ceiling-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(maxPinnedSummariesPerScope, 30);
  const runsDir = join(f.store.directory, 'runs', f.workspace.id);
  await ensurePrivateDirectory(runsDir);
  const summary = (at: string) => JSON.stringify({
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5,
    at, failingNames: [], failingTruncated: false, failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false,
  });
  // 12 pinned files older than 25 unpinned ones; names sort oldest-first.
  const pinnedStems: string[] = [];
  for (let index = 0; index < 12; index++) {
    const stem = `100${index}-pin${String(index).padStart(2, '0')}`;
    pinnedStems.push(stem);
    await writeFile(join(runsDir, `${stem}.json`), summary('2026-09-01T00:00:00.000Z'));
  }
  for (let index = 0; index < 25; index++) {
    await writeFile(join(runsDir, `2000-new${String(index).padStart(2, '0')}.json`), summary('2026-09-02T00:00:00.000Z'));
  }
  const pins = new Set(pinnedStems);
  assert.equal(pinnedRunIds([{ workspaceId: f.workspace.id, checkpointNote: { evidence: [...pins] } }], f.workspace.id).size, 12);
  await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false, pinned: pins,
  });
  const files = await runFiles(f.store, f.workspace.id);
  assert.equal(files.length, 30, 'hard ceiling holds despite 12 pins');
  // The two oldest pins yield first; the ten newer pins survive.
  assert.ok(!files.includes('1000-pin00.json') && !files.includes('1001-pin01.json'), 'oldest pins evict past the ceiling');
  for (const stem of pinnedStems.slice(2)) assert.ok(files.includes(`${stem}.json`), `${stem} survives`);
  // Only the six oldest unpinned files yield: 25 + 1 trigger keep the newest 20.
  for (let index = 6; index < 25; index++) {
    assert.ok(files.includes(`2000-new${String(index).padStart(2, '0')}.json`), `new${index} survives`);
  }
});

test('notes written before evidence links parse with no links', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-pin-compat-')));
  try {
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const store = new Store(join(root, 'state'));
    await store.initialize();
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const workstreamId = '22222222-2222-4222-8222-222222222222';
    const at = new Date().toISOString();
    await writePrivateJson(join(store.directory, 'state.json'), {
      workspaces: [{ id: workspaceId, name: 'Old', roots: [project], createdAt: at }],
      workstreams: [{
        id: workstreamId, name: 'Old stream', workspaceId,
        checkouts: [{ root: project, revision: SHA, revisionState: 'observed', observedAt: at }],
        status: 'paused', createdAt: at, updatedAt: at,
        checkpointNote: { goal: 'old goal', blocker: '', next: 'old next', owner: 'agent', at },
      }],
    });
    const service = new WorkspaceService(store);
    const loaded = await service.workstream(workstreamId);
    assert.deepEqual(loaded.checkpointNote?.evidence, [], 'old notes read as no links');
    assert.deepEqual(pinnedRunIds((await store.read()).workstreams, workspaceId), new Set());
    // Legacy run files without an id field fall back to the file stem.
    const runsDir = join(store.directory, 'runs', workspaceId);
    await ensurePrivateDirectory(runsDir);
    await writeFile(join(runsDir, '9999-legacy.json'), JSON.stringify({
      workspaceId, scriptName: 'test', outcome: 'passed', durationMs: 7,
      at, failingNames: [], failingTruncated: false,
      failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false,
    }));
    const [listed] = await listRecentRuns(store.directory, workspaceId, 5);
    assert.equal(listed.id, '9999-legacy');
    assert.equal(listed.pinnedByNote, false);
    assert.equal(runIdFromFile('9999-legacy.json'), '9999-legacy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removal cleans up the scope dir, including pinned runs', async t => {
  const f = await approvedFixture('openworkspace-pin-removal-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const summary = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: [summary.id] }));
  // No workstream removal exists: workspace removal is refused while any
  // workstream references it, so pins only clear via note edit.
  await assert.rejects(f.service.remove(f.workspace.id), /Remove its workstreams first/);
  const bare = await approvedFixture('openworkspace-pin-removal-bare-');
  t.after(() => rm(bare.root, { recursive: true, force: true }));
  await persistRunSummary(bare.store.directory, {
    workspaceId: bare.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  const before = await runFiles(bare.store, bare.workspace.id);
  assert.equal(before.length, 1);
  // Remove the workstream record directly (no workstream-removal operation
  // exists), then remove the workspace: the scope dir — pins included, since
  // pinned runs live under the workspace scope — is removed with it.
  await bare.store.update(state => {
    state.workstreams = state.workstreams.filter(workstream => workstream.workspaceId !== bare.workspace.id);
  });
  await bare.service.remove(bare.workspace.id);
  await assert.rejects(readdir(join(bare.store.directory, 'runs', bare.workspace.id)), /ENOENT/);
  assert.deepEqual(await listRunIds(bare.store.directory, bare.workspace.id), new Set());
});

test('evidence links travel the HTTP boundary with safe errors', async t => {
  const f = await approvedFixture('openworkspace-pin-http-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const summary = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  const linked = await fetch(`${origin}/api/workstreams/${f.workstream.id}/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'paused', note: { ...note(), evidence: [summary.id] } }),
  });
  assert.equal(linked.status, 200);
  assert.deepEqual((await linked.json() as { checkpointNote: { evidence: string[] } }).checkpointNote.evidence, [summary.id]);
  const unknown = await fetch(`${origin}/api/workstreams/${f.workstream.id}/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'paused', note: { ...note(), evidence: ['0000-deadbeef'] } }),
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: checkpointEvidenceMessage });
  const oversized = await fetch(`${origin}/api/workstreams/${f.workstream.id}/status`, {
    method: 'POST', headers,
    body: JSON.stringify({ status: 'paused', note: { ...note(), evidence: [summary.id, summary.id, 'a', 'b', 'c', 'd'] } }),
  });
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: checkpointBoundsMessage });
  const recent = await (await fetch(`${origin}/api/runs/recent?scope=${f.workspace.id}`, { headers })).json() as Array<{ id: string; pinnedByNote: boolean }>;
  assert.equal(recent.find(entry => entry.id === summary.id)?.pinnedByNote, true);
});

test('recent runs stay newest-first so linked rows sit adjacent in the timeline merge', async t => {
  const f = await approvedFixture('openworkspace-pin-order-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const runsDir = join(f.store.directory, 'runs', f.workspace.id);
  await ensurePrivateDirectory(runsDir);
  const summary = (at: string) => JSON.stringify({
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5,
    at, failingNames: [], failingTruncated: false, failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false,
  });
  await writeFile(join(runsDir, '1000-old.json'), summary('2026-09-01T00:00:00.000Z'));
  await writeFile(join(runsDir, '2000-new.json'), summary('2026-09-03T00:00:00.000Z'));
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ evidence: ['2000-new'] }));
  const listed = await f.service.recentRuns(f.workspace.id, 5);
  assert.deepEqual(listed.map(entry => entry.id), ['2000-new', '1000-old'], 'newest-first without rebuilding the merge');
  assert.deepEqual(listed.map(entry => entry.pinnedByNote), [true, false]);
  // The pinned run carries its evidence ID back to the note: the merge key.
  const reread = await f.service.workstream(f.workstream.id);
  assert.ok(reread.checkpointNote && listed[0].id !== undefined && reread.checkpointNote.evidence.includes(listed[0].id));
  const raw = await readFile(join(runsDir, '2000-new.json'), 'utf8');
  assert.ok(!raw.includes('finish checkout review'), 'run files never duplicate note content');
});
