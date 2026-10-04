import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writePrivateJson, type State } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { checkpointHistoryOf, maxCheckpointHistory, maxWorkstreamCompletions, pinnedRunIds, soloDefaultAssignmentId, type CompletionInput } from '../src/workstreams.js';
import { listRunIds, persistRunSummary } from '../src/run-summaries.js';
import { runVerification, type CommandRunner } from '../src/verify.js';
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
    name: 'Stream', workspace: workspace.name, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

const coordinatorNote = {
  goal: 'finish the checkout mapping review', blocker: 'waiting on service probe', next: 'rerun the bounded check', owner: 'user',
};
const subagentNote = {
  goal: 'probe the mapped service logs', blocker: 'tail truncated once', next: 'hand the excerpt back up', owner: 'agent',
};

type CompletionRequest = Omit<CompletionInput, 'assignmentId'> & Partial<Pick<CompletionInput, 'assignmentId'>>;

function completion(assignmentId?: string, completionId: string = randomUUID()): CompletionRequest {
  return {
    ...(assignmentId === undefined ? {} : { assignmentId }),
    completionId,
    outcome: 'passed' as const,
    revision: 'f'.repeat(40),
    dirty: true,
    dirtyFingerprint: { diffHash: 'a'.repeat(64), files: ['src/workstreams.ts'], truncated: false },
    checks: [{ name: 'backend-tests', result: 'passed' as const, environment: 'node22-macos-local', evidenceIds: [] }],
  };
}

test('coordinator-then-subagent notes append without clobbering; latest keeps its shape', async t => {
  const f = await approvedFixture('openworkspace-subagent-append-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', coordinatorNote);
  assert.equal(first.checkpointNote?.goal, coordinatorNote.goal);
  assert.deepEqual(checkpointHistoryOf(first).map(entry => entry.goal), [coordinatorNote.goal]);

  const second = await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', subagentNote);
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
  const resumed = await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'active');
  assert.deepEqual(resumed.checkpointNote, second.checkpointNote);
  assert.deepEqual(checkpointHistoryOf(resumed), history);
});

test('history evicts oldest past ten entries and refuses oversized appends', async t => {
  const f = await approvedFixture('openworkspace-subagent-bound-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(maxCheckpointHistory, 10);
  for (let index = 0; index < 12; index++) {
    await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', {
      ...coordinatorNote, goal: `checkpoint goal number ${index}`,
    });
  }
  const reread = await f.service.workstream(f.workspace.name, f.workstream.name);
  const history = checkpointHistoryOf(reread);
  assert.equal(history.length, 10);
  assert.deepEqual(
    history.map(entry => entry.goal),
    Array.from({ length: 10 }, (_, offset) => `checkpoint goal number ${offset + 2}`),
  );
  assert.equal(reread.checkpointNote?.goal, 'checkpoint goal number 11', 'latest still reads as the single note');
  // Per-entry budgets still apply to appends: a refused note stores nothing new.
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', { ...coordinatorNote, goal: 'g'.repeat(1001) }),
    /2000 characters or fewer/,
  );
  assert.equal(checkpointHistoryOf(await f.service.workstream(f.workspace.name, f.workstream.name)).length, 10);
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
    const loaded = await service.workstream('Old', 'Old stream');
    assert.equal(loaded.checkpointNote?.goal, 'old coordinator goal');
    assert.deepEqual(loaded.completions, [], 'legacy workstreams parse with an empty additive completion ring');
    assert.deepEqual(checkpointHistoryOf(loaded).map(entry => entry.goal), ['old coordinator goal']);
    const bundle = await service.workstreamContext('Old', 'Old stream');
    assert.equal(bundle.checkpoint.historyCount, 1, 'legacy note counts as one history entry');
    assert.equal(bundle.checkpoint.latest?.goal, 'old coordinator goal');

    // First new append seeds the legacy note instead of dropping it.
    const updated = await service.setWorkstreamStatus('Old', 'Old stream', 'paused', subagentNote);
    assert.deepEqual(
      checkpointHistoryOf(updated).map(entry => entry.goal),
      ['old coordinator goal', subagentNote.goal],
    );
    assert.equal(updated.checkpointNote?.goal, subagentNote.goal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workstream_context bundles checkpoint, revision and runs in one read-only call', async t => {
  const f = await approvedFixture('openworkspace-subagent-bundle-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', coordinatorNote);
  await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', subagentNote);
  const summary = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 5, output: 'ok', outputTruncated: false,
  });
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.equal(bundle.workstreamId, f.workstream.id);
  assert.equal(bundle.name, 'Stream');
  assert.equal(bundle.status, 'paused');
  assert.equal(bundle.checkpoint.latest?.goal, subagentNote.goal, 'latest is the current single-note shape');
  assert.equal(bundle.checkpoint.historyCount, 2);
  assert.deepEqual(bundle.open, { blocker: subagentNote.blocker, next: subagentNote.next });
  assert.ok(bundle.checkouts.length >= 1 && bundle.checkouts.every(checkout => typeof checkout.root === 'string'));
  assert.ok(bundle.recentRuns.some(entry => entry.id === summary.id), 'scoped recent runs included');
  assert.ok(bundle.recentRuns.every(entry => entry.excerptPreview.length <= 200), 'existing run caps apply');

  // Limit passthrough honors existing recent_runs caps.
  assert.equal((await f.service.workstreamContext(f.workspace.name, f.workstream.name, 1)).recentRuns.length, 1);
  await assert.rejects(f.service.workstreamContext(f.workspace.name, f.workstream.name, 21), /allowed range/);
  await assert.rejects(
    f.service.workstreamContext('Missing project', 'Missing stream'),
    /Workspace access not found/,
  );
});

test('completion records are assignment-scoped, idempotent claims and never close the workstream', async t => {
  const f = await approvedFixture('openworkspace-completion-append-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidence = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'backend-tests', outcome: 'passed', durationMs: 3,
    output: 'ok', outputTruncated: false, revision: 'f'.repeat(40), dirty: { diffHash: 'a'.repeat(64), files: ['src/workstreams.ts'], truncated: false },
  });
  const pasted = await f.service.importExternalRun({
    workspace: f.workspace.name, scriptName: 'remote-check', outcome: 'passed', durationMs: 4, excerpt: 'passed elsewhere',
  });
  const input = completion('assignment-alpha');
  input.checks[0].evidenceIds = [evidence.id!];
  const first = await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, input);
  const replay = await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, input);
  assert.equal(first.status, 'active');
  assert.equal(replay.status, 'active');
  assert.equal(first.completions.length, 1);
  assert.equal(replay.completions.length, 1, 'same completionId retry appends no duplicate');
  assert.deepEqual(first.completions[0].dirtyFingerprint, input.dirtyFingerprint);
  assert.equal(first.completions[0].dirty, true);
  assert.equal(first.completions[0].revision, 'f'.repeat(40));
  assert.equal(first.completions[0].checks[0].evidenceSource, 'agent_report');
  assert.equal(first.completions[0].checks[0].evidenceLabel, 'Agent-reported — not independently verified here');
  assert.deepEqual(first.completions[0].checks[0].evidenceIds, [evidence.id]);
  assert.equal(first.completions[0].recordedAt, replay.completions[0].recordedAt);

  const uppercaseId = randomUUID().toUpperCase();
  const uppercase = await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, completion('uuid-case', uppercaseId));
  assert.equal(uppercase.completions.at(-1)?.completionId, uppercaseId.toLowerCase(), 'UUIDs are stored canonically');
  // Simulate a pre-fix state record to ensure comparison also tolerates UUID case variants.
  await f.store.update(state => {
    const legacyRecord = state.workstreams.find(entry => entry.id === f.workstream.id)!.completions.at(-1)!;
    legacyRecord.completionId = uppercaseId;
  });
  const caseVariantRetry = await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, completion('uuid-case', uppercaseId.toLowerCase()));
  assert.equal(caseVariantRetry.completions.length, uppercase.completions.length, 'UUID case variants retry the same append');
  assert.equal(caseVariantRetry.completions.at(-1)?.completionId, uppercaseId, 'retry matches an existing uppercase UUID without appending');

  await assert.rejects(
    f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, { ...input, outcome: 'failed' }),
    /Completion ID already exists with different content/,
  );
  await assert.rejects(
    f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, {
      ...completion('secret-attempt'), checks: [{ name: 'backend-tests', result: 'passed', environment: 'password=hidden' }],
    }),
    /safe metadata only/,
  );
  await assert.rejects(
    f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, {
      ...completion('source-forgery'), checks: [{ name: 'backend-tests', result: 'passed', environment: 'local', evidenceSource: 'openworkspace_run' }],
    } as unknown as CompletionInput),
    /Completion records exceed the allowed bounds/,
  );
  await assert.rejects(
    f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, {
      ...completion('assignment-unknown'), checks: [{ ...completion('assignment-unknown').checks[0], evidenceIds: ['missing-run-id'] }],
    }),
    /Completion evidence must reference existing runs/,
  );

  const second = await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, completion('constructor'));
  assert.equal(second.completions.length, 3);
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name, 5, 'assignment-alpha');
  assert.equal(bundle.completionsByAssignmentId['assignment-alpha'].length, 1);
  assert.equal(bundle.completionsByAssignmentId['uuid-case'].length, 1);
  assert.equal(bundle.completionsByAssignmentId.constructor.length, 1);
  assert.equal(bundle.latestCompletion?.assignmentId, 'constructor');
  assert.deepEqual(bundle.assignmentCompletion, {
    assignmentId: 'assignment-alpha', present: true, records: bundle.completionsByAssignmentId['assignment-alpha'],
  });
  assert.equal(bundle.recentRuns.find(run => run.id === evidence.id)?.evidenceSource, 'openworkspace_run');
  assert.match(bundle.recentRuns.find(run => run.id === evidence.id)?.sourceLabel ?? '', /Executed here/);
  assert.equal(bundle.recentRuns.find(run => run.id === pasted.id)?.evidenceSource, 'external_import');
  assert.match(bundle.recentRuns.find(run => run.id === pasted.id)?.sourceLabel ?? '', /not verified here/);
  const missing = await f.service.workstreamContext(f.workspace.name, f.workstream.name, 5, 'assignment-not-recorded');
  assert.deepEqual(missing.assignmentCompletion, { assignmentId: 'assignment-not-recorded', present: false, records: [] });
  assert.equal((await f.service.workstream(f.workspace.name, f.workstream.name)).status, 'active');
});

test('completion history has an independent twenty-record bound', async t => {
  const f = await approvedFixture('openworkspace-completion-bound-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(maxWorkstreamCompletions, 20);
  for (let index = 0; index < 22; index++) {
    await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, completion(`assignment-${index}`));
  }
  const stored = await f.service.workstream(f.workspace.name, f.workstream.name);
  assert.equal(stored.completions.length, 20);
  assert.equal(stored.completions[0].assignmentId, 'assignment-2');
  assert.equal(stored.completions.at(-1)?.assignmentId, 'assignment-21');
  assert.deepEqual((await f.service.workstreamContext(f.workspace.name, f.workstream.name)).recentRuns, [], 'agent claims do not create executed-run evidence');
});

test('completion evidence is revalidated at the queued write after run-summary eviction', async t => {
  const f = await approvedFixture('openworkspace-completion-eviction-race-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const oldEvidenceId = '0000000000000-old-run';
  const runsDirectory = join(f.store.directory, 'runs', f.workspace.id);
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(runsDirectory, `${oldEvidenceId}.json`), '{}', { mode: 0o600 });
  assert.ok((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId));

  let releaseBlocker!: () => void;
  let enterBlocker!: () => void;
  const blockerEntered = new Promise<void>(resolve => { enterBlocker = resolve; });
  const blockedUpdate = f.store.update(async () => {
    enterBlocker();
    await new Promise<void>(resolve => { releaseBlocker = resolve; });
  });
  await blockerEntered;

  let notifyQueuedAppend!: () => void;
  const appendQueued = new Promise<void>(resolve => { notifyQueuedAppend = resolve; });
  const originalUpdate = f.store.update.bind(f.store);
  f.store.update = function <T>(change: (state: State) => T | Promise<T>): Promise<T> {
    notifyQueuedAppend();
    return originalUpdate(change);
  };
  const input = completion('eviction-race');
  input.checks[0].evidenceIds = [oldEvidenceId];
  const append = f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, input);
  try {
    await appendQueued;
    f.store.update = originalUpdate;
    for (let index = 0; index < 20; index++) {
      await persistRunSummary(f.store.directory, {
        workspaceId: f.workspace.id, scriptName: `ring-${index}`, outcome: 'passed', durationMs: 1,
        output: 'ok', outputTruncated: false,
      });
    }
    assert.equal((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId), false, 'the concurrent ring persist evicted the old ref');
    releaseBlocker();
    await blockedUpdate;
    await assert.rejects(append, /Completion evidence must reference existing runs/);
    assert.deepEqual((await f.service.workstream(f.workspace.name, f.workstream.name)).completions, [], 'no completion stores a dangling evidence reference');
  } finally {
    releaseBlocker();
    await blockedUpdate;
    f.store.update = originalUpdate;
  }
});

test('verification prune refreshes pins after a completion commits against its stale snapshot', async t => {
  const f = await approvedFixture('openworkspace-completion-stale-prune-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const oldEvidenceId = '0000000000000-old-pinned-run';
  const runsDirectory = join(f.store.directory, 'runs', f.workspace.id);
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(runsDirectory, `${oldEvidenceId}.json`), '{}', { mode: 0o600 });
  for (let index = 0; index < 19; index++) {
    await persistRunSummary(f.store.directory, {
      workspaceId: f.workspace.id, scriptName: `seed-${index}`, outcome: 'passed', durationMs: 1,
      output: 'ok', outputTruncated: false,
    });
  }
  assert.equal((await listRunIds(f.store.directory, f.workspace.id)).size, 20);
  assert.ok((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId));
  assert.deepEqual(pinnedRunIds((await f.store.read()).workstreams, f.workspace.id), new Set(), 'verification begins with a stale empty pin snapshot');

  const verificationRunner: CommandRunner = async (command, args) => ({
    exitCode: 0, timedOut: false, aborted: false, truncated: false,
    stdout: command === 'git' && args[0] === 'rev-parse' ? 'f'.repeat(40) : '',
    stderr: '', durationMs: 1, spawnFailed: false,
  });
  const runAndPersist = async () => {
    const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'test' }, { runCommand: verificationRunner });
    await persistRunSummary(f.store.directory, {
      workspaceId: f.workspace.id, scriptName: 'test', outcome: result.outcome, durationMs: result.durationMs,
      output: result.output, outputTruncated: result.truncated, revision: result.git.revision, dirty: result.git.dirty,
    }, f.store);
    return result;
  };
  let releasePrune!: () => void;
  let notifyPrune!: () => void;
  const pruneReached = new Promise<void>(resolve => { notifyPrune = resolve; });
  const resumePrune = new Promise<void>(resolve => { releasePrune = resolve; });
  let deferFirstUpdate = true;
  const originalUpdate = f.store.update.bind(f.store);
  f.store.update = function <T>(change: (state: State) => T | Promise<T>): Promise<T> {
    if (deferFirstUpdate) {
      deferFirstUpdate = false;
      notifyPrune();
      return resumePrune.then(() => originalUpdate(change));
    }
    return originalUpdate(change);
  };

  const verification = runAndPersist();
  try {
    await pruneReached;
    const input = completion('verify-pin-race');
    input.checks[0].evidenceIds = [oldEvidenceId];
    await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, input);
    releasePrune();
    assert.equal((await verification).outcome, 'passed');
    assert.ok((await listRunIds(f.store.directory, f.workspace.id)).has(oldEvidenceId), 'the queued prune observes the committed completion pin');
    const stored = await f.service.workstream(f.workspace.name, f.workstream.name);
    assert.deepEqual(stored.completions[0].checks[0].evidenceIds, [oldEvidenceId]);
  } finally {
    releasePrune();
    f.store.update = originalUpdate;
    await verification.catch(() => undefined);
  }
});

test('workstream_context travels HTTP GET without recording activity and within budgets', async t => {
  const f = await approvedFixture('openworkspace-subagent-http-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', coordinatorNote);
  const app = createApp(f.service, { mcpToken: 'a'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const largeCompletion = completion('http-assignment');
  largeCompletion.dirtyFingerprint = {
    diffHash: 'b'.repeat(64),
    files: Array.from({ length: 50 }, (_, index) => `src/${index}-${'a'.repeat(240)}`),
    truncated: false,
  };
  const completionBody = JSON.stringify({ completion: largeCompletion });
  assert.ok(Buffer.byteLength(completionBody, 'utf8') > 8192, 'completion exercises the bounded extended request-body budget');
  const written = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/status`, {
    method: 'POST', headers, body: completionBody,
  });
  assert.equal(written.status, 200);
  assert.equal(((await written.json()) as { status: string }).status, 'paused', 'completion preserves the coordinator-owned status');
  const soloWrite = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/status`, {
    method: 'POST', headers, body: JSON.stringify({ completion: completion(undefined, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') }),
  });
  assert.equal(soloWrite.status, 200, 'HTTP accepts an omitted assignmentId for solo completion');
  const secondSoloWrite = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/status`, {
    method: 'POST', headers, body: JSON.stringify({ completion: completion(undefined, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') }),
  });
  assert.equal(secondSoloWrite.status, 200);
  const assignmentGroups = (await f.service.workstreamContext(f.workspace.name, f.workstream.name)).completionsByAssignmentId;
  assert.equal(assignmentGroups['http-assignment'].length, 1, 'explicit assignments remain in their own group');
  assert.equal(assignmentGroups[soloDefaultAssignmentId].length, 2, 'omitted IDs share the stable solo group without clobbering named work');
  const combined = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'done', completion: completion('combined-assignment') }),
  });
  assert.equal(combined.status, 400, 'completion and coordinator status transition are separate operations');
  assert.equal((await f.service.workstream(f.workspace.name, f.workstream.name)).status, 'paused');
  assert.deepEqual((await f.service.workstream(f.workspace.name, f.workstream.name)).completions.map(entry => entry.assignmentId), [
    'http-assignment', soloDefaultAssignmentId, soloDefaultAssignmentId,
  ]);

  const before = await (await fetch(`${origin}/api/activity`, { headers })).json();
  const bundled = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context`, { headers });
  assert.equal(bundled.status, 200);
  const body = await bundled.json() as { checkpoint: { historyCount: number }; open: { blocker: string } };
  assert.equal(body.checkpoint.historyCount, 1);
  assert.equal(body.open.blocker, coordinatorNote.blocker);
  const after = await (await fetch(`${origin}/api/activity`, { headers })).json();
  assert.deepEqual(after, before, 'context reads never record activity');

  // Minting the stable default over GET is the one mutation this route
  // performs, and it audits as a workstream-create.
  const mint = await fetch(`${origin}/api/workstreams/${f.workspace.name}/main/context`, { headers });
  assert.equal(mint.status, 200);
  const minted = await mint.json() as { workstreamId: string; mintedDefaultWorkstream: boolean };
  assert.equal(minted.mintedDefaultWorkstream, true);
  const reread = await (await fetch(`${origin}/api/workstreams/${f.workspace.name}/main/context`, { headers })).json() as {
    workstreamId: string; mintedDefaultWorkstream: boolean;
  };
  assert.equal(reread.workstreamId, minted.workstreamId);
  assert.equal(reread.mintedDefaultWorkstream, false, 'the re-read records nothing new');
  const creations = (await (await fetch(`${origin}/api/activity`, { headers })).json() as Array<{ operation: string; detail: string }>)
    .filter(entry => entry.operation === 'workstream-create' && entry.detail === 'main');
  assert.equal(creations.length, 1, 'the mint records exactly one bounded workstream-create row');

  const limited = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context?limit=1`, { headers });
  assert.equal(limited.status, 200);
  assert.equal(((await limited.json()) as { recentRuns: unknown[] }).recentRuns.length <= 1, true);
  const assignment = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context?assignmentId=http-assignment`, { headers });
  assert.equal(assignment.status, 200);
  assert.equal(((await assignment.json()) as { assignmentCompletion: { present: boolean } }).assignmentCompletion.present, true);
  const badLimit = await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context?limit=21`, { headers });
  assert.equal(badLimit.status, 400);
  assert.deepEqual(await badLimit.json(), { error: 'Use a result limit within the allowed range.' });
  const unknown = await fetch(`${origin}/api/workstreams/Missing%20project/Missing%20stream/context`, { headers });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'Workspace access not found.' });

  // Format budgets: the new tool description stays small and the schema minimal.
  const mcpSource = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const description = mcpSource.match(/workstream_context', \{\n\s+description: '((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(description, 'workstream_context description found');
  assert.ok(Buffer.byteLength(description, 'utf8') <= 200, `context tool description stays within 200B (got ${Buffer.byteLength(description, 'utf8')}B)`);
  assert.doesNotMatch(description, /draft/i, 'context description covers only fields that are returned');
  assert.match(mcpSource, /workstream: workstreamName,\n\s+limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)\.optional\(\)/);
});

test('workstream_context surfaces situational lessons for the task and stays read-only', async t => {
  const f = await approvedFixture('openworkspace-situational-context-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', {
    goal: 'start the api service', blocker: 'missing setting value', next: 'confirm settings then retry', owner: 'agent',
  });
  const run = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'dev', outcome: 'failed', durationMs: 5,
    output: 'missing setting value', outputTruncated: false,
  });
  await f.service.recordLearning({
    title: 'Confirm settings before starting the service', file: 'AGENTS.md', evidenceRefs: [run.id],
    failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['missing setting'],
  });
  await f.service.environmentSet(f.workspace.name, {
    name: 'dev',
    services: [{ id: 'api', repositoryPath: f.project, scriptName: 'test', port: 4318, readiness: { kind: 'http-200' } }],
  });
  await f.service.recordLearning({
    title: 'Api port guard', file: 'AGENTS.md', evidenceRefs: [run.id],
    failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['api service'],
  });
  await f.service.recordLearning({
    title: 'Freight schedule guard', file: 'AGENTS.md', evidenceRefs: [run.id],
    failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['freight schedule'],
  });
  const before = await f.service.recentActivity();
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.ok(Array.isArray(bundle.situationalLessons), 'context carries the additive field');
  assert.ok(bundle.situationalLessons.length <= 3, 'at most three situational titles');
  assert.ok(bundle.situationalLessons.some(title => title.includes('Confirm settings before starting the service (AGENTS.md) [situational]')),
    'checkpoint wording matches the setup lesson');
  assert.ok(bundle.situationalLessons.some(title => title.includes('Api port guard') && title.includes('[situational]')),
    'environment service names feed the task context');
  assert.ok(!bundle.situationalLessons.some(title => title.includes('Freight schedule')),
    'mismatched tags stay silent on this task');
  assert.ok(!JSON.stringify(bundle.situationalLessons).includes(f.project), 'no repository paths leak into lessons');
  assert.deepEqual(await f.service.recentActivity(), before, 'context reads still record no activity');

  // The field travels the HTTP route unchanged.
  const app = createApp(f.service, { mcpToken: 'b'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}` };
  const overHttp = await (await fetch(`${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context`, { headers })).json() as { situationalLessons: string[] };
  assert.deepEqual(overHttp.situationalLessons, bundle.situationalLessons);

  // The updated tool description names the field and stays within budget.
  const mcpSource = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const description = mcpSource.match(/workstream_context', \{\n\s+description: '((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(description?.includes('situational lessons'), 'description names situational lessons');
  assert.ok(Buffer.byteLength(description ?? '', 'utf8') <= 200, 'description stays within 200B');
});

test('workstream_context task tokens ignore other workspaces activity', async t => {
  const f = await approvedFixture('openworkspace-subagent-activity-scope-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const otherProject = join(f.root, 'other');
  await mkdir(otherProject, { recursive: true });
  const otherWorkspace = await f.service.register('Other project', [otherProject]);
  await f.service.setWorkstreamStatus(f.workspace.name, f.workstream.name, 'paused', {
    goal: 'polish the docs', blocker: 'none', next: 'merge', owner: 'agent',
  });
  const run = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'failed', durationMs: 5,
    output: 'not ok 1 freight audit trail', outputTruncated: false,
  });
  await f.service.recordLearning({
    title: 'Freight audit guard', file: 'AGENTS.md', evidenceRefs: [run.id],
    failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['freight schedule'],
  });
  await f.service.recordActivity({ actor: 'mcp', operation: 'freight-audit', workspaceId: otherWorkspace.id, detail: 'ok' });
  assert.deepEqual(
    (await f.service.workstreamContext(f.workspace.name, f.workstream.name)).situationalLessons,
    [],
    'other-workspace activity never surfaces lessons here',
  );
  await f.service.recordActivity({ actor: 'mcp', operation: 'freight-audit', workspaceId: f.workspace.id, detail: 'ok' });
  assert.ok(
    (await f.service.workstreamContext(f.workspace.name, f.workstream.name)).situationalLessons.some(title => title.includes('Freight audit guard')),
    'same-workspace activity still feeds the task context',
  );
});

test('completion write returns its open IDs and reads back by assignment', async t => {
  const f = await approvedFixture('openworkspace-completion-id-roundtrip-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const statusUrl = `${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/status`;
  const id = randomUUID();
  const written = await fetch(statusUrl, {
    method: 'POST', headers, body: JSON.stringify({ completion: completion('roundtrip-assignment', id) }),
  });
  assert.equal(written.status, 200);
  const receipt = await written.json() as { completionId: string; assignmentId: string; status: string };
  assert.equal(receipt.completionId, id.toLowerCase(), 'success response carries the stored completion ID');
  assert.equal(receipt.assignmentId, 'roundtrip-assignment', 'success response carries the resolved assignment group');
  assert.equal(receipt.status, 'active', 'completion still never transitions status');
  // Same-ID retry is idempotent and returns the same open IDs.
  const replay = await (await fetch(statusUrl, {
    method: 'POST', headers, body: JSON.stringify({ completion: completion('roundtrip-assignment', id.toUpperCase()) }),
  })).json() as { completionId: string; assignmentId: string };
  assert.equal(replay.completionId, id.toLowerCase());
  assert.equal(replay.assignmentId, 'roundtrip-assignment');
  assert.equal((await f.service.workstream(f.workspace.name, f.workstream.name)).completions.length, 1);
  // Coordinator read-back by the same assignment shows the persisted ID.
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name, 5, 'roundtrip-assignment');
  assert.equal(bundle.assignmentCompletion?.present, true);
  assert.equal(bundle.assignmentCompletion?.records[0].completionId, id.toLowerCase());
  const overHttp = await (await fetch(
    `${origin}/api/workstreams/${f.workspace.name}/${f.workstream.name}/context?assignmentId=roundtrip-assignment`,
    { headers },
  )).json() as { assignmentCompletion: { present: boolean; records: Array<{ completionId: string }> } };
  assert.equal(overHttp.assignmentCompletion.present, true);
  assert.equal(overHttp.assignmentCompletion.records[0].completionId, id.toLowerCase());
});

test('workstream_context separates assignment acceptance from workstream-wide acceptance', async t => {
  const f = await approvedFixture('openworkspace-acceptance-split-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = completion('assignment-one');
  first.checks = [
    { name: 'backend-tests', result: 'passed' as const, environment: 'node22-macos-local', evidenceIds: [] },
    { name: 'frontend-tests', result: 'failed' as const, environment: 'node22-macos-local', evidenceIds: [] },
  ];
  await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, first);
  await f.service.appendWorkstreamCompletion(f.workspace.name, f.workstream.name, completion('assignment-two'));
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name, 5, 'assignment-one');
  assert.equal(bundle.acceptance.assignment?.assignmentId, 'assignment-one');
  assert.equal(bundle.acceptance.assignment?.present, true);
  assert.deepEqual(
    bundle.acceptance.assignment?.criteria.map(criterion => [criterion.name, criterion.result]),
    [['backend-tests', 'passed'], ['frontend-tests', 'failed']],
    'assignment block carries only this assignment’s criteria',
  );
  assert.ok(bundle.acceptance.assignment?.criteria.every(criterion =>
    criterion.completionId === first.completionId.toLowerCase() && criterion.outcome === 'passed'));
  assert.equal(bundle.acceptance.general.latestOutcome, 'passed');
  assert.equal(bundle.acceptance.general.latestAssignmentId, 'assignment-two');
  assert.equal(bundle.acceptance.general.totalCompletions, 2);
  assert.deepEqual(bundle.acceptance.general.assignmentIds.sort(), ['assignment-one', 'assignment-two']);
  const unqueried = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.equal(unqueried.acceptance.assignment, null, 'no assignment query means no assignment block');
  assert.equal(unqueried.acceptance.general.totalCompletions, 2, 'general block needs no query');
  const missing = await f.service.workstreamContext(f.workspace.name, f.workstream.name, 5, 'assignment-absent');
  assert.deepEqual(missing.acceptance.assignment, { assignmentId: 'assignment-absent', present: false, criteria: [] });
});

test('workstream_context auto-creates the stable default but still refuses other missing names', async t => {
  const f = await approvedFixture('openworkspace-subagent-default-');
  t.after(() => rm(f.root, { recursive: true, force: true }));

  // First context call for the default needs no explicit create: it binds
  // every registered root and is immediately usable.
  const first = await f.service.workstreamContext(f.workspace.name, 'main');
  assert.equal(first.name, 'main');
  assert.equal(first.status, 'active');
  assert.deepEqual(first.checkouts.map(checkout => checkout.root), [f.project]);
  assert.equal(first.mintedDefaultWorkstream, true, 'the minting call flags itself for the audit');

  // A second call reuses the same workstream instead of minting a duplicate.
  const second = await f.service.workstreamContext(f.workspace.name, 'main');
  assert.equal(second.workstreamId, first.workstreamId);
  assert.equal(second.mintedDefaultWorkstream, false, 'pure re-reads claim no mint');

  // An existing workstream never claims a mint either.
  const existing = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.equal(existing.mintedDefaultWorkstream, false);

  // Explicit named creation is unaffected.
  const named = await f.service.createWorkstream({
    name: 'Custom', workspace: f.workspace.name, checkouts: [f.project],
  });
  assert.equal(named.name, 'Custom');

  // Any other missing name stays a refusal (typos must not mint workstreams).
  await assert.rejects(f.service.workstreamContext(f.workspace.name, 'mian'), /Unknown workstream/);
  await assert.rejects(f.service.workstreamContext('Missing project', 'main'), /Workspace access not found/);
});
