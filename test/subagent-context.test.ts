import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { checkpointHistoryOf, maxCheckpointHistory } from '../src/workstreams.js';
import { persistRunSummary } from '../src/run-summaries.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const SHA = 'e'.repeat(40);

async function approvedFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Subagent project', [project]);
  const workstream = await service.createWorkstream({
    name: 'Stream', workspaceId: workspace.id, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

const coordinatorNote = {
  goal: 'finish the checkout mapping review', blocker: 'waiting on service probe', next: 'rerun the bounded check', owner: 'user',
};
const subagentNote = {
  goal: 'probe the mapped service logs', blocker: 'tail truncated once', next: 'hand the excerpt back up', owner: 'agent',
};

test('coordinator-then-subagent notes append without clobbering; latest keeps its shape', async t => {
  const f = await approvedFixture('openworkspace-subagent-append-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', coordinatorNote);
  assert.equal(first.checkpointNote?.goal, coordinatorNote.goal);
  assert.deepEqual(checkpointHistoryOf(first).map(entry => entry.goal), [coordinatorNote.goal]);

  const second = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', subagentNote);
  // Latest entry is exactly the current single-note shape (goal/blocker/next/owner/at/evidence).
  assert.deepEqual(
    { goal: second.checkpointNote?.goal, blocker: second.checkpointNote?.blocker, next: second.checkpointNote?.next, owner: second.checkpointNote?.owner },
    { goal: subagentNote.goal, blocker: subagentNote.blocker, next: subagentNote.next, owner: subagentNote.owner },
  );
  assert.ok(second.checkpointNote?.at && Number.isFinite(Date.parse(second.checkpointNote.at)));
  assert.deepEqual(second.checkpointNote?.evidence, []);
  // Both entries survive with their own owner+timestamp: no clobber.
  const history = checkpointHistoryOf(second);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(entry => entry.goal), [coordinatorNote.goal, subagentNote.goal]);
  assert.deepEqual(history.map(entry => entry.owner), ['user', 'agent']);
  assert.ok(history.every(entry => Number.isFinite(Date.parse(entry.at))));

  // Omitting the note preserves latest AND history across resume.
  const resumed = await f.service.setWorkstreamStatus(f.workstream.id, 'active');
  assert.deepEqual(resumed.checkpointNote, second.checkpointNote);
  assert.deepEqual(checkpointHistoryOf(resumed), history);
});

test('history evicts oldest past ten entries and refuses oversized appends', async t => {
  const f = await approvedFixture('openworkspace-subagent-bound-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(maxCheckpointHistory, 10);
  for (let index = 0; index < 12; index++) {
    await f.service.setWorkstreamStatus(f.workstream.id, 'paused', {
      ...coordinatorNote, goal: `checkpoint goal number ${index}`,
    });
  }
  const reread = await f.service.workstream(f.workstream.id);
  const history = checkpointHistoryOf(reread);
  assert.equal(history.length, 10);
  assert.deepEqual(
    history.map(entry => entry.goal),
    Array.from({ length: 10 }, (_, offset) => `checkpoint goal number ${offset + 2}`),
  );
  assert.equal(reread.checkpointNote?.goal, 'checkpoint goal number 11', 'latest still reads as the single note');
  // Per-entry budgets still apply to appends: a refused note stores nothing new.
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', { ...coordinatorNote, goal: 'g'.repeat(1001) }),
    /2000 characters or fewer/,
  );
  assert.equal(checkpointHistoryOf(await f.service.workstream(f.workstream.id)).length, 10);
});

test('legacy single-note files read history[0] and preserve it on first append', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-subagent-legacy-')));
  try {
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const store = new Store(join(root, 'state'));
    await store.initialize();
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const workstreamId = '22222222-2222-4222-8222-222222222222';
    const at = new Date().toISOString();
    // No checkpointHistory key at all: a file written before history existed.
    await writePrivateJson(join(store.directory, 'state.json'), {
      workspaces: [{ id: workspaceId, name: 'Old', roots: [project], createdAt: at }],
      workstreams: [{
        id: workstreamId, name: 'Old stream', workspaceId,
        checkouts: [{ root: project, revision: SHA, revisionState: 'observed', observedAt: at }],
        status: 'paused', createdAt: at, updatedAt: at,
        checkpointNote: { goal: 'old coordinator goal', blocker: '', next: 'old next', owner: 'user', at },
      }],
    });
    const service = new WorkspaceService(store);
    const loaded = await service.workstream(workstreamId);
    assert.equal(loaded.checkpointNote?.goal, 'old coordinator goal');
    assert.deepEqual(checkpointHistoryOf(loaded).map(entry => entry.goal), ['old coordinator goal']);
    const bundle = await service.workstreamContext(workstreamId);
    assert.equal(bundle.checkpoint.historyCount, 1, 'legacy note counts as one history entry');
    assert.equal(bundle.checkpoint.latest?.goal, 'old coordinator goal');

    // First new append seeds the legacy note instead of dropping it.
    const updated = await service.setWorkstreamStatus(workstreamId, 'paused', subagentNote);
    assert.deepEqual(
      checkpointHistoryOf(updated).map(entry => entry.goal),
      ['old coordinator goal', subagentNote.goal],
    );
    assert.equal(updated.checkpointNote?.goal, subagentNote.goal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workstream_context bundles checkpoint, revision, runs and drafts in one read-only call', async t => {
  const f = await approvedFixture('openworkspace-subagent-bundle-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', coordinatorNote);
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', subagentNote);
  const summary = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  const draftsDir = join(f.store.directory, 'learnings', '_drafts');
  await mkdir(draftsDir, { recursive: true });
  await writeFile(join(draftsDir, 'probe-note.md'), '# Probe retry rule\n\n- Scope: *\n- Rule: retry the mapped probe once\n- Source: test\n- Status: draft\n');

  const bundle = await f.service.workstreamContext(f.workstream.id);
  assert.equal(bundle.workstreamId, f.workstream.id);
  assert.equal(bundle.name, 'Stream');
  assert.equal(bundle.status, 'paused');
  assert.equal(bundle.checkpoint.latest?.goal, subagentNote.goal, 'latest is the current single-note shape');
  assert.equal(bundle.checkpoint.historyCount, 2);
  assert.deepEqual(bundle.open, { blocker: subagentNote.blocker, next: subagentNote.next });
  assert.ok(bundle.checkouts.length >= 1 && bundle.checkouts.every(checkout => typeof checkout.root === 'string'));
  assert.ok(bundle.recentRuns.some(entry => entry.id === summary.id), 'scoped recent runs included');
  assert.ok(bundle.recentRuns.every(entry => entry.excerptPreview.length <= 200), 'existing run caps apply');
  assert.deepEqual(bundle.relatedDrafts, ['Probe retry rule'], 'draft titles only, no bodies');

  // Limit passthrough honors existing recent_runs caps.
  assert.equal((await f.service.workstreamContext(f.workstream.id, 1)).recentRuns.length, 1);
  await assert.rejects(f.service.workstreamContext(f.workstream.id, 21), /allowed range/);
  await assert.rejects(
    f.service.workstreamContext('00000000-0000-4000-8000-000000000000'),
    /Unknown workstream/,
  );
});

test('workstream_context travels HTTP GET without recording activity and within budgets', async t => {
  const f = await approvedFixture('openworkspace-subagent-http-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.setWorkstreamStatus(f.workstream.id, 'paused', coordinatorNote);
  const app = createApp(f.service, { mcpToken: 'a'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };

  const before = await (await fetch(`${origin}/api/activity`, { headers })).json();
  const bundled = await fetch(`${origin}/api/workstreams/${f.workstream.id}/context`, { headers });
  assert.equal(bundled.status, 200);
  const body = await bundled.json() as { checkpoint: { historyCount: number }; open: { blocker: string } };
  assert.equal(body.checkpoint.historyCount, 1);
  assert.equal(body.open.blocker, coordinatorNote.blocker);
  const after = await (await fetch(`${origin}/api/activity`, { headers })).json();
  assert.deepEqual(after, before, 'context reads never record activity');

  const limited = await fetch(`${origin}/api/workstreams/${f.workstream.id}/context?limit=1`, { headers });
  assert.equal(limited.status, 200);
  assert.equal(((await limited.json()) as { recentRuns: unknown[] }).recentRuns.length <= 1, true);
  const badLimit = await fetch(`${origin}/api/workstreams/${f.workstream.id}/context?limit=21`, { headers });
  assert.equal(badLimit.status, 400);
  assert.deepEqual(await badLimit.json(), { error: 'Use a result limit within the allowed range.' });
  const unknown = await fetch(`${origin}/api/workstreams/00000000-0000-4000-8000-000000000000/context`, { headers });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'Unknown workstream.' });

  // Format budgets: the new tool description stays small and the schema minimal.
  const mcpSource = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const description = mcpSource.match(/workstream_context', \{\n\s+description: '((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(description, 'workstream_context description found');
  assert.ok(Buffer.byteLength(description, 'utf8') <= 200, `context tool description stays within 200B (got ${Buffer.byteLength(description, 'utf8')}B)`);
  assert.match(mcpSource, /workstreamId: z\.string\(\)\.uuid\(\),\n\s+limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)\.optional\(\)/);
});
