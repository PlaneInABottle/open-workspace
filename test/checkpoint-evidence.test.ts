import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import {
  externalImportClaimMessage,
  externalImportInvalidMessage,
  listRecentRuns,
  parseExternalRunImport,
  persistRunSummary,
} from '../src/run-summaries.js';
import { checkpointBoundsMessage, checkpointPatternMessage } from '../src/workstreams.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const SHA = 'c'.repeat(40);

async function approvedFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Checkpoint project', [project]);
  const workstream = await service.createWorkstream({
    name: 'Stream', workspaceId: workspace.id, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

const note = (partial: Record<string, unknown> = {}) => ({
  goal: 'finish checkout review', blocker: 'waiting on mapping probe', next: 'rerun the bounded check', owner: 'agent',
  ...partial,
});

test('checkpoint notes refuse oversized, empty and control-char input', async t => {
  const f = await approvedFixture('openworkspace-checkpoint-bounds-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ goal: 'g'.repeat(501) })),
    new RegExp(checkpointBoundsMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)),
  );
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ goal: 'g'.repeat(300), next: 'n'.repeat(300) })),
    /500 characters or fewer/,
  );
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ goal: '   ' })),
    /500 characters or fewer/,
  );
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ next: 'line\u0007bell' })),
    new RegExp('patterns only'),
  );
  await assert.rejects(
    f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ owner: 'bot' })),
    /500 characters or fewer/,
  );
  assert.equal((await f.service.workstream(f.workstream.id)).checkpointNote, null);
  assert.equal(checkpointBoundsMessage, 'Checkpoint notes hold 500 characters or fewer.');
});

test('checkpoint notes refuse secret-shaped and literal paths', async t => {
  const f = await approvedFixture('openworkspace-checkpoint-secrets-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const secret of [
    note({ blocker: 'api_key=sk-live-12345' }),
    note({ goal: 'retry with Bearer abcdefgh1234' }),
    note({ next: 'ask someone@example.com' }),
    note({ goal: 'read /Users/someone/.env first' }),
    note({ blocker: 'wrap -----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY----- wrap' }),
  ]) {
    await assert.rejects(f.service.setWorkstreamStatus(f.workstream.id, 'paused', secret), new RegExp('patterns only'));
  }
  assert.equal((await f.service.workstream(f.workstream.id)).checkpointNote, null);
  assert.equal(checkpointPatternMessage, 'Checkpoint notes accept patterns only, never secrets or literals.');
});

test('checkpoint notes round-trip across pause, resume and finish', async t => {
  const f = await approvedFixture('openworkspace-checkpoint-roundtrip-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal((await f.service.workstream(f.workstream.id)).checkpointNote, null);
  const paused = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note());
  assert.equal(paused.status, 'paused');
  assert.deepEqual(
    { goal: paused.checkpointNote?.goal, blocker: paused.checkpointNote?.blocker, next: paused.checkpointNote?.next, owner: paused.checkpointNote?.owner },
    { goal: 'finish checkout review', blocker: 'waiting on mapping probe', next: 'rerun the bounded check', owner: 'agent' },
  );
  assert.ok(paused.checkpointNote?.at && Number.isFinite(Date.parse(paused.checkpointNote.at)));
  const resumed = await f.service.setWorkstreamStatus(f.workstream.id, 'active');
  assert.equal(resumed.status, 'active');
  assert.deepEqual(resumed.checkpointNote, paused.checkpointNote);
  const done = await f.service.setWorkstreamStatus(f.workstream.id, 'done');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.checkpointNote, paused.checkpointNote);
  await assert.rejects(f.service.setWorkstreamStatus(f.workstream.id, 'active'), /cannot be reopened/);
});

test('workstreams stored before checkpoint notes still parse with a null note', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-checkpoint-compat-')));
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
      }],
    });
    const service = new WorkspaceService(store);
    const loaded = await service.workstream(workstreamId);
    assert.equal(loaded.status, 'paused');
    assert.equal(loaded.checkpointNote, null);
    const resumed = await service.setWorkstreamStatus(workstreamId, 'active');
    assert.equal(resumed.checkpointNote, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executed runs carry the openworkspace-run source and label', async t => {
  const f = await approvedFixture('openworkspace-source-own-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const summary = await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 41,
    output: 'ok 1 fine', outputTruncated: false,
  });
  assert.equal(summary.source, 'openworkspace-run');
  const [listed] = await listRecentRuns(f.store.directory, f.workspace.id, 5);
  assert.equal(listed.source, 'openworkspace-run');
  assert.equal(listed.sourceLabel, 'Executed here — context-stamped');
});

test('run files stored before source labels read as openworkspace-run', async t => {
  const f = await approvedFixture('openworkspace-source-legacy-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.store.directory, 'runs', f.workspace.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '9999-legacy.json'), JSON.stringify({
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'failed', durationMs: 7,
    at: new Date().toISOString(), failingNames: [], failingTruncated: false,
    failureExcerpt: 'not ok 1 legacy', excerptTruncated: false, outputTruncated: false,
  }));
  const [listed] = await listRecentRuns(f.store.directory, f.workspace.id, 5);
  assert.equal(listed.source, 'openworkspace-run');
  assert.equal(listed.sourceLabel, 'Executed here — context-stamped');
});

test('checkpoint notes refuse non-listed roots, case variants and UNC shares', async t => {
  const f = await approvedFixture('openworkspace-checkpoint-paths-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const literal of [
    'stage under /opt/tool/bin first',
    'clear /root/.cache next',
    'mount at /srv/data today',
    'check /mnt/disk capacity',
    'open /Applications/App.app now',
    'install /Library/Fonts/x soon',
    'boot /System/file twice',
    'read /USERS/someone/desktop instead',
    'open \\\\server\\share\\file now',
    'run C:/tools/check next',
  ]) {
    await assert.rejects(
      f.service.setWorkstreamStatus(f.workstream.id, 'paused', note({ next: literal })),
      /patterns only/,
      `must refuse ${literal}`,
    );
  }
  const allowed = await f.service.setWorkstreamStatus(f.workstream.id, 'paused', note());
  assert.equal(allowed.checkpointNote?.goal, 'finish checkout review');
});

test('imported and unknown-source durations never feed the learning signal', async t => {
  const f = await approvedFixture('openworkspace-signal-sources-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await persistRunSummary(f.store.directory, {
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 100,
    output: 'ok', outputTruncated: false,
  });
  await f.service.importExternalRun({
    workspaceId: f.workspace.id, scriptName: 'check', outcome: 'passed', durationMs: 9_999_999, excerpt: 'upstream green',
  });
  const { readRunDurations } = await import('../src/run-summaries.js');
  assert.deepEqual(await readRunDurations(f.store.directory, f.workspace.id), [100]);
});

test('present-but-unknown run sources degrade to a distinct unverified label', async t => {
  const f = await approvedFixture('openworkspace-source-unknown-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.store.directory, 'runs', f.workspace.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '9999-tampered.json'), JSON.stringify({
    workspaceId: f.workspace.id, scriptName: 'test', outcome: 'passed', durationMs: 7,
    at: new Date().toISOString(), failingNames: [], failingTruncated: false,
    failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false, source: 'tampered-value',
  }));
  const [listed] = await listRecentRuns(f.store.directory, f.workspace.id, 5);
  assert.equal(listed.source, 'unknown-source');
  assert.equal(listed.sourceLabel, 'Unknown source — not verified here');
  const { readRunDurations, sourceLabel } = await import('../src/run-summaries.js');
  assert.equal(sourceLabel('unknown-source'), 'Unknown source — not verified here');
  assert.deepEqual(await readRunDurations(f.store.directory, f.workspace.id), []);
});

test('imported runs are labeled external-import, masked and never verified-as-ours', async t => {
  const f = await approvedFixture('openworkspace-source-import-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const imported = await f.service.importExternalRun({
    workspaceId: f.workspace.id, scriptName: 'check', outcome: 'failed', durationMs: 12,
    excerpt: 'not ok 1 login, contact helper@example.com, token abcdefgh12345678',
  });
  assert.equal(imported.source, 'external-import');
  assert.ok(!imported.failureExcerpt.includes('helper@example.com'), 'excerpt is masked');
  const [listed] = await f.service.recentRuns(f.workspace.id, 5);
  assert.equal(listed.source, 'external-import');
  assert.equal(listed.sourceLabel, 'Pasted result — not verified here');
  assert.match(listed.sourceLabel, /not verified/i);
  assert.ok(!/executed here/i.test(listed.sourceLabel), 'import label stays distinct from executed runs');
  const serialized = JSON.stringify(imported);
  assert.ok(!serialized.includes('verified'), 'imports never carry a verification claim');
  await assert.rejects(
    f.service.importExternalRun({ workspaceId: '33333333-3333-4333-8333-333333333333', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'ok' }),
    /Workspace not found/,
  );
});

test('imported input refuses verification claims, unknown keys and out-of-range fields', async t => {
  assert.throws(
    () => parseExternalRunImport({ workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'ok', verifiedAt: 'now' }),
    new RegExp(externalImportClaimMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.throws(
    () => parseExternalRunImport({ workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'ok', extra: 'nope' }),
    new RegExp(externalImportInvalidMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.throws(
    () => parseExternalRunImport({ workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'Verified by OpenWorkspace, all green' }),
    new RegExp(externalImportClaimMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(externalImportClaimMessage, 'Imported results are accepted on trust and never marked verified.');
  for (const raw of [
    { workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'x'.repeat(501) },
    { workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'maybe', durationMs: 1, excerpt: 'ok' },
    { workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: 'check', outcome: 'passed', durationMs: -1, excerpt: 'ok' },
    { workspaceId: 'not-a-uuid', scriptName: 'check', outcome: 'passed', durationMs: 1, excerpt: 'ok' },
    { workspaceId: '44444444-4444-4444-8444-444444444444', scriptName: '../escape', outcome: 'passed', durationMs: 1, excerpt: 'ok' },
  ]) {
    assert.throws(() => parseExternalRunImport(raw), /Imported results are not valid/);
  }
});

test('status notes and run imports travel the HTTP boundary with safe errors', async t => {
  const f = await approvedFixture('openworkspace-checkpoint-http-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  const paused = await fetch(`${origin}/api/workstreams/${f.workstream.id}/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'paused', note: note() }),
  });
  assert.equal(paused.status, 200);
  const pausedBody = await paused.json() as { checkpointNote: { goal: string } };
  assert.equal(pausedBody.checkpointNote.goal, 'finish checkout review');
  const secretNote = await fetch(`${origin}/api/workstreams/${f.workstream.id}/status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'paused', note: note({ blocker: 'password=hunter2-secret' }) }),
  });
  assert.equal(secretNote.status, 400);
  assert.deepEqual(await secretNote.json(), { error: checkpointPatternMessage });
  const imported = await fetch(`${origin}/api/runs/import`, {
    method: 'POST', headers,
    body: JSON.stringify({ workspaceId: f.workspace.id, scriptName: 'check', outcome: 'passed', durationMs: 9, excerpt: 'all green upstream' }),
  });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json() as { source: string }).source, 'external-import');
  const claimed = await fetch(`${origin}/api/runs/import`, {
    method: 'POST', headers,
    body: JSON.stringify({ workspaceId: f.workspace.id, scriptName: 'check', outcome: 'passed', durationMs: 9, excerpt: 'Verified upstream run' }),
  });
  assert.equal(claimed.status, 400);
  assert.deepEqual(await claimed.json(), { error: externalImportClaimMessage });
  const recent = await (await fetch(`${origin}/api/runs/recent?scope=${f.workspace.id}`, { headers })).json() as Array<{ source: string; sourceLabel: string }>;
  assert.equal(recent[0].source, 'external-import');
  assert.equal(recent[0].sourceLabel, 'Pasted result — not verified here');
  const activity = await (await fetch(`${origin}/api/activity`, { headers })).json() as Array<{ operation: string; detail: string }>;
  assert.ok(activity.some(entry => entry.operation === 'run-import' && entry.detail.endsWith('→ external-import')));
  assert.ok(!JSON.stringify(activity).includes('all green upstream'), 'activity never carries pasted excerpts');
});

test('run imports require the dashboard intent while MCP stays intent-free', async t => {
  const f = await approvedFixture('openworkspace-import-intent-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const issued = await fetch(`${origin}/api/dashboard-session`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(issued.status, 201);
  const { dashboardToken } = await issued.json() as { dashboardToken: string };
  const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const payload = { workspaceId: f.workspace.id, scriptName: 'check', outcome: 'passed', durationMs: 3, excerpt: 'upstream ok' };
  const denied = await fetch(`${origin}/api/runs/import`, { method: 'POST', headers: dashboardHeaders, body: JSON.stringify(payload) });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'Recording a pasted result requires the connected dashboard.' });
  const allowed = await fetch(`${origin}/api/runs/import`, {
    method: 'POST', headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'import-run' }, body: JSON.stringify(payload),
  });
  assert.equal(allowed.status, 201);
  assert.equal((await allowed.json() as { source: string }).source, 'external-import');
});
