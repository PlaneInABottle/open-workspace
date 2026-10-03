import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import {
  buildLearningLine,
  evaluateLearningSignal,
  learningInstructionSuffix,
  listRecentRuns,
  maskSecrets,
  median,
  parseFailingNames,
  persistRunSummary,
} from '../src/run-summaries.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

async function registeredFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Learning project', [project]);
  return { root, project, store, service, workspace };
}

test('learn-from-mistake skill exists, stays small and is referenced', async () => {
  const skill = await readFile(new URL('../skills/learn-from-mistake/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /name: learn-from-mistake/);
  assert.ok(skill.split('\n').length < 300, 'skill must stay under 300 lines');
  for (const required of [
    'visible session transcript', 'activity_list', 'recent_runs', 'different task',
    'one-off flukes', 'runId', 'activity timestamp', 'test name', 'do not copy evidence content',
    'no more than **5 rules per invocation**',
    'active project', 'project-root `AGENTS.md`', 'shared ancestor outside the project requires explicit user authorization',
    'refuse that edit and report the boundary', 'skip the citation; never invent one',
    'nearest existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`', 'never runs automatically',
    'secrets', 'absolute user paths', 'customer data', 'SQL literals', 'log/transcript content',
  ]) {
    assert.ok(skill.includes(required), `skill must cover ${required}`);
  }
  assert.ok(!/sk-|Bearer |@example\.com|\/Users\/|password\s*[:=]/.test(skill), 'skill carries no literal secrets or path values');
  assert.ok(!skill.includes('learnings/_drafts') && !skill.includes('Status: draft'), 'learning guidance writes directly without a draft pipeline');
  const onboarding = await readFile(new URL('../skills/openworkspace-onboarding/SKILL.md', import.meta.url), 'utf8');
  assert.ok(onboarding.includes('learn-from-mistake'), 'onboarding skill references learn-from-mistake');
  assert.ok(onboarding.includes('never runs automatically') && onboarding.includes('creates no drafts'));
  const mcpSource = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  assert.ok(mcpSource.includes('learn-from-mistake'), 'MCP instructions reference learn-from-mistake');
  assert.ok(mcpSource.includes('never runs automatically'));
  assert.ok(mcpSource.includes('Mirror major milestones'), 'MCP instructions mirror major milestones');
  const base = mcpSource.match(/const baseInstructions = '((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(base, 'base instructions literal found');
  const baseBytes = Buffer.byteLength(base, 'utf8');
  assert.ok(baseBytes <= 600, `base instructions leave room for the dynamic line (got ${baseBytes}B)`);
  const worst = buildLearningLine({ slowdown: { factor: '99.9', latestMs: 120000, medianMs: 1 }, recentFailedRuns: 20 });
  assert.ok(worst && baseBytes + 1 + Buffer.byteLength(worst, 'utf8') <= 760, 'instructions total stays within 760B');
  // listTools byte note (folded from the retired declarative-tools plan, measured
  // 2026-10-03 over a real stdio session): 12,497 B with no declared tool vs
  // 13,169 B with db_tables active — a 672 B delta for one tool. The binding
  // budget stays the 760 B base-instructions cap asserted above, not this note.
  const prompt = mcpSource.match(/text:\n\s+'((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(prompt && Buffer.byteLength(prompt, 'utf8') <= 860, 'prompt stays within 860B');
});

test('reads record sanitized descriptors and failures never leak literals', async t => {
  const f = await registeredFixture('openworkspace-learning-reads-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const headers = { Authorization: `Bearer ${app.mcpToken}`, 'Content-Type': 'application/json' };
  await fetch(`${origin}/api/overview`, { headers });
  await fetch(`${origin}/api/workspaces/${f.workspace.id}`, { headers });
  await fetch(`${origin}/api/workspaces/${f.workspace.id}/onboarding`, { headers });
  await fetch(`${origin}/api/workspaces/${f.workspace.id}/services`, { method: 'POST', headers, body: '{}' });
  await fetch(`${origin}/api/workstreams`, { headers });
  await fetch(`${origin}/api/leases`, { headers });
  const learnings = await fetch(`${origin}/api/learnings`, { headers });
  assert.deepEqual(await learnings.json(), { milestones: [] }, 'the read API returns narrative notes only');
  const denied = await fetch(`${origin}/api/workspaces/00000000-0000-4000-8000-000000000000`, { headers });
  assert.equal(denied.status, 400);
  // Failed mutation attempts carrying secrets must not reach activity either.
  const secretSql = 'SELECT * FROM users WHERE email = \'someone@example.com\'';
  const secretUrl = 'http://127.0.0.1:9/?token=sk-test-secret-marker';
  await fetch(`${origin}/api/workspaces/${f.workspace.id}/datastore/query`, {
    method: 'POST', headers, body: JSON.stringify({ database: 'appdb', role: 'reader', sql: secretSql }),
  });
  await fetch(`${origin}/api/workspaces/${f.workspace.id}/browser/check`, {
    method: 'POST', headers, body: JSON.stringify({ url: secretUrl }),
  });
  const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).json() as Array<{ operation: string; detail: string; workspaceId: string | null }>;
  const details = activity.map(entry => entry.detail);
  assert.ok(details.some(detail => detail === 'workspace_list → ok'));
  assert.ok(details.some(detail => detail === `workspace_inspect ${f.workspace.id.slice(0, 8)} → ok`));
  assert.ok(details.some(detail => detail === `onboarding_plan ${f.workspace.id.slice(0, 8)} → ok`));
  assert.ok(details.some(detail => detail === `workspace_services ${f.workspace.id.slice(0, 8)} → ok`));
  assert.ok(details.some(detail => detail === 'workspace_workstreams → ok'));
  assert.ok(details.some(detail => detail === 'workspace_leases → ok'));
  assert.ok(details.some(detail => detail === 'workspace_inspect 00000000 → denied'));
  const serialized = JSON.stringify(activity);
  for (const leaked of [secretSql, 'sk-test-secret-marker', 'someone@example.com', '127.0.0.1:9']) {
    assert.ok(!serialized.includes(leaked), `activity must never carry ${leaked}`);
  }
  assert.ok(activity.every(entry => entry.detail.length <= 200), 'detail cap holds');
});

test('maskSecrets covers email, bearer, api-key and private-key shapes', () => {
  assert.equal(maskSecrets('contact someone@example.com today'), 'contact ***@*** today');
  assert.equal(maskSecrets('Authorization: Bearer abcdefgh1234'), 'Authorization: Bearer ***');
  assert.equal(maskSecrets('api_key=sk-live-12345'), 'api_key=***');
  assert.equal(maskSecrets('token: secret-value-here'), 'token: ***');
  const keyed = '-----BEGIN RSA PRIVATE KEY-----\nMIIBPAIBAAJB\n-----END RSA PRIVATE KEY-----';
  assert.equal(maskSecrets(`wrap ${keyed} wrap`), 'wrap *** wrap');
  assert.equal(maskSecrets('/plain/path and 42'), '/plain/path and 42');
});

test('failing names parse best-effort with a 20-name cap', () => {
  const output = ['not ok 3 login rejects bad password', '✖ renders empty state (app.test.js)', 'FAIL suites/api.test.ts', 'ok 1 fine'].join('\n');
  const parsed = parseFailingNames(output);
  assert.deepEqual(parsed.names, ['login rejects bad password', 'renders empty state (app.test.js)', 'suites/api.test.ts']);
  assert.equal(parsed.truncated, false);
  const many = Array.from({ length: 25 }, (_, index) => `not ok ${index + 1} case ${index}`).join('\n');
  const capped = parseFailingNames(many);
  assert.equal(capped.names.length, 20);
  assert.equal(capped.truncated, true);
});

test('run summaries persist masked excerpts with a 20-per-scope ring', async t => {
  const f = await registeredFixture('openworkspace-learning-runs-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (let index = 0; index < 22; index++) {
    await persistRunSummary(f.store.directory, {
      workspaceId: f.workspace.id,
      scriptName: 'test',
      outcome: index % 2 === 0 ? 'failed' : 'passed',
      durationMs: 100 + index,
      output: `not ok ${index} case contact-${index}@example.com with Bearer tokenvalue${index}abcdef`,
      outputTruncated: false,
    });
  }
  const files = (await readdir(join(f.store.directory, 'runs', f.workspace.id))).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 20);
  const listed = await listRecentRuns(f.store.directory, f.workspace.id, 20);
  assert.equal(listed.length, 20);
  assert.ok(listed.every(entry => entry.excerptPreview.length <= 200), 'list excerpts capped at 200 chars');
  assert.ok(!JSON.stringify(listed).includes('@example.com'), 'excerpts are masked');
  assert.ok(!JSON.stringify(listed).includes('tokenvalue'), 'excerpts are masked');
});

test('verify persists a bounded summary and recent_runs resolves scopes with caps', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-verify-')));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const runners = { runCommand: async () => ({ exitCode: 1, timedOut: false, aborted: false, truncated: false, stdout: 'not ok 1 login flow', stderr: '', durationMs: 321, spawnFailed: false }) };
  const service = new WorkspaceService(store, undefined, undefined, runners.runCommand);
  const workspace = await service.register('Learning project', [project]);
  try {
    const result = await service.verify(workspace.id, { repositoryPath: project, scriptName: 'test' });
    assert.equal(result.outcome, 'failed');
    const listed = await service.recentRuns(workspace.id, 5);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].scriptName, 'test');
    assert.equal(listed[0].durationMs, 321);
    assert.deepEqual(listed[0].failingNames, ['login flow']);
    // Workstream scopes resolve to their workspace runs.
    const workstreamId = '11111111-1111-4111-8111-111111111111';
    await store.update(state => {
      state.workstreams.push({
        id: workstreamId, name: 'Stream', workspaceId: workspace.id,
        checkouts: [{ root: project, revision: null, revisionState: 'unknown', observedAt: new Date().toISOString() }],
        status: 'active', checkpointNote: null, checkpointHistory: [], completions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    assert.equal((await service.recentRuns(workstreamId, 5)).length, 1);
    await assert.rejects(service.recentRuns('22222222-2222-4222-8222-222222222222', 5), /Workspace not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read tools enforce caps and never self-record', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-caps-')));
  const project = join(root, 'project');
  await mkdir(project);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Learning project', [project]);
  const app = createApp(service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  try {
    const headers = { Authorization: `Bearer ${app.mcpToken}` };
    const before = ((await (await fetch(`${origin}/api/activity`, { headers })).json()) as unknown[]).length;
    assert.equal((await (await fetch(`${origin}/api/activity?limit=5`, { headers })).json() as unknown[]).length, Math.min(5, before));
    assert.equal((await fetch(`${origin}/api/activity?limit=51`, { headers })).status, 400);
    assert.equal((await fetch(`${origin}/api/activity?limit=0`, { headers })).status, 400);
    assert.deepEqual(await (await fetch(`${origin}/api/activity?limit=not-a-number`, { headers })).json(), { error: 'Use a result limit within the allowed range.' });
    const runs = await fetch(`${origin}/api/runs/recent?scope=${workspace.id}`, { headers });
    assert.equal(runs.status, 200);
    assert.deepEqual(await runs.json(), []);
    assert.equal((await fetch(`${origin}/api/runs/recent?scope=${workspace.id}&limit=21`, { headers })).status, 400);
    assert.equal((await fetch(`${origin}/api/runs/recent?scope=nope`, { headers })).status, 400);
    assert.deepEqual(await (await fetch(`${origin}/api/runs/recent?scope=33333333-3333-4333-8333-333333333333`, { headers })).json(), { error: 'Workspace not found. Register it first.' });
    const after = ((await (await fetch(`${origin}/api/activity`, { headers })).json()) as unknown[]).length;
    assert.equal(after, before);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('learning signal fires on a slowdown or at least three failed runs in the recent window', () => {
  assert.equal(median([3000, 1000, 2000]), 2000);
  assert.equal(median([3000, 1000]), 2000);
  const slow = evaluateLearningSignal([9000, 2000, 2100], 0);
  assert.ok(slow.slowdown, 'latest above 3x median of prior runs');
  assert.match(buildLearningLine(slow) ?? '', /4\.4x expected.*learn-from-mistake/);
  assert.equal(buildLearningLine(evaluateLearningSignal([100, 2000, 2100], 0)), undefined);
  assert.equal(buildLearningLine(evaluateLearningSignal([9000, 2000], 0)), undefined);
  assert.equal(buildLearningLine(evaluateLearningSignal([100, 100, 100], 2)), undefined);
  const failures = evaluateLearningSignal([100, 100, 100], 3);
  assert.equal(failures.recentFailedRuns, 3);
  assert.match(buildLearningLine(failures) ?? '', /3 of the last 20 local verification runs failed or errored/);
});

test('instruction suffix reads slowdown and the last 20 local run outcomes', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-signal-')));
  try {
    assert.equal(await learningInstructionSuffix(home), undefined);
    const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const runsDir = join(home, 'runs', scope);
    await mkdir(runsDir, { recursive: true });
    const summary = (index: number, outcome: 'passed' | 'failed' | 'error', source = 'openworkspace-run', durationMs = 100) => JSON.stringify({
      workspaceId: scope, scriptName: 'test', outcome, durationMs,
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      failingNames: [], failingTruncated: false, failureExcerpt: 'ok', excerptTruncated: false,
      outputTruncated: false, source,
    });
    const writeRun = (index: number, outcome: 'passed' | 'failed' | 'error', source?: string) =>
      writeFile(join(runsDir, `${Date.UTC(2026, 0, 1, 0, index)}-${String(index).padStart(2, '0')}.json`), summary(index, outcome, source));
    await writeFile(join(runsDir, '1000.json'), summary(0, 'passed', 'openworkspace-run', 2000));
    await writeFile(join(runsDir, '2000.json'), summary(1, 'passed', 'openworkspace-run', 2100));
    await writeFile(join(runsDir, '3000.json'), summary(2, 'passed', 'openworkspace-run', 9000));
    const slow = await learningInstructionSuffix(home);
    assert.match(slow ?? '', /4\.4x expected.*learn-from-mistake/);
    assert.ok(Buffer.byteLength(slow ?? '', 'utf8') <= 200, 'suffix keeps total instructions under budget');

    await rm(runsDir, { recursive: true, force: true });
    await mkdir(runsDir, { recursive: true });
    await Promise.all(Array.from({ length: 17 }, (_, index) => writeRun(index, 'passed')));
    await writeRun(17, 'failed');
    await writeRun(18, 'error');
    await writeRun(19, 'failed', 'external-import');
    assert.equal(await learningInstructionSuffix(home), undefined, 'two non-passing local runs and an imported failure do not trigger');
    await writeRun(20, 'failed');
    assert.match(await learningInstructionSuffix(home) ?? '', /3 of the last 20 local verification runs failed or errored/);

    await Promise.all(Array.from({ length: 18 }, (_, offset) => writeRun(21 + offset, 'passed')));
    assert.equal(await learningInstructionSuffix(home), undefined, 'failures roll out of the latest-20 local-run window');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
