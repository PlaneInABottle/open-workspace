import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp, safeMessages } from '../src/http.js';
import { persistRunSummary } from '../src/run-summaries.js';
import {
  appendLearningRule,
  countRecurrences,
  collectRecentLocalRuns,
  evictLearningEntries,
  learningLessonLine,
  learningMessages,
  learningTotalCap,
  maxLearningEntries,
  readLearningIndex,
  sanitizeLearningRecord,
  type LearningRuleEntry,
} from '../src/rule-index.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';
import { selectSituationalLessons, tokenizeContext } from '../src/rule-index.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

function sleepMs(value: number) {
  return new Promise<void>(resolve => { setTimeout(resolve, value); });
}

async function registeredFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Learning index project', [project]);
  return { root, project, store, service, workspace };
}

async function failedRun(home: string, workspaceId: string, output: string) {
  return persistRunSummary(home, {
    workspaceId,
    scriptName: 'test',
    outcome: 'failed',
    durationMs: 120,
    output,
    outputTruncated: false,
  });
}

function recordBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Quote identifiers in helper queries',
    file: 'AGENTS.md',
    evidenceRefs: ['placeholder'],
    failureSignature: { tests: ['login flow'], errorClasses: [] as string[] },
    ...overrides,
  };
}

test('sanitize enforces strict bounds and shape', () => {
  const valid = sanitizeLearningRecord(recordBody({ evidenceRefs: ['abc-1'] }));
  assert.equal(valid.title, 'Quote identifiers in helper queries');
  assert.throws(() => sanitizeLearningRecord(recordBody({ title: 'x'.repeat(81) })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ file: 'x'.repeat(257) })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ evidenceRefs: [] })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ evidenceRefs: ['a', 'b', 'c', 'd', 'e', 'f'] })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ evidenceRefs: ['has space'] })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ failureSignature: { tests: [], errorClasses: [] } })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ failureSignature: { tests: Array.from({ length: 11 }, (_, index) => `case ${index}`), errorClasses: [] } })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ failureSignature: { tests: ['x'.repeat(121)], errorClasses: [] } })), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord({ ...recordBody({ evidenceRefs: ['a'] }), extra: 1 }), new RegExp(escapeRegExp(learningMessages.bounds)));
  assert.throws(() => sanitizeLearningRecord(recordBody({ failureSignature: { tests: ['ok'], errorClasses: [], extra: 1 } })), new RegExp(escapeRegExp(learningMessages.bounds)));
  for (const message of Object.values(learningMessages)) {
    assert.ok((safeMessages as readonly string[]).includes(message), `${message} is allowlisted`);
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('secret-shaped and absolute-path content is refused', async t => {
  const f = await registeredFixture('openworkspace-learning-refuse-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow');
  const accessible = new Set([run.id!]);
  await assert.rejects(
    appendLearningRule(f.store.directory, recordBody({ title: 'rotate token=sk-live-12345 now', evidenceRefs: [run.id] }), async () => accessible),
    new RegExp(escapeRegExp(learningMessages.pattern)),
  );
  await assert.rejects(
    appendLearningRule(f.store.directory, recordBody({ title: 'contact someone@example.com first', evidenceRefs: [run.id] }), async () => accessible),
    new RegExp(escapeRegExp(learningMessages.pattern)),
  );
  await assert.rejects(
    appendLearningRule(f.store.directory, recordBody({ file: '/abs/path/AGENTS.md', evidenceRefs: [run.id] }), async () => accessible),
    new RegExp(escapeRegExp(learningMessages.pattern)),
  );
  await assert.rejects(
    appendLearningRule(f.store.directory, recordBody({ file: '../escape.md', evidenceRefs: [run.id] }), async () => accessible),
    new RegExp(escapeRegExp(learningMessages.pattern)),
  );
  await assert.rejects(
    appendLearningRule(f.store.directory, recordBody({ evidenceRefs: ['missing-run-id'] }), async () => accessible),
    new RegExp(escapeRegExp(learningMessages.evidence)),
  );
  assert.deepEqual(await readLearningIndex(f.store.directory), [], 'refusals persist nothing');
});

test('index stores server-stamped entries with 0600 perms and evicts oldest non-suspect first', async t => {
  const f = await registeredFixture('openworkspace-learning-evict-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 alpha case');
  const entries: LearningRuleEntry[] = [];
  for (let index = 0; index < maxLearningEntries; index++) {
    entries.push(await f.service.recordLearning({
      title: `Rule number ${index}`,
      file: 'AGENTS.md',
      evidenceRefs: [run.id],
      failureSignature: { tests: [`unique case ${index}`], errorClasses: [] },
    }));
  }
  let stored = await readLearningIndex(f.store.directory);
  assert.equal(stored.length, maxLearningEntries);
  const first = stored[0];
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.status, 'active');
  assert.ok(first.createdAt && first.lastValidatedAt, 'server stamps both timestamps');
  assert.ok(!('signature' in first) && Array.isArray(first.failureSignature.tests));
  const mode = (await stat(join(f.store.directory, 'learnings', 'index.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  const serialized = await readFile(join(f.store.directory, 'learnings', 'index.json'), 'utf8');
  assert.ok(!serialized.includes('rule bodies'), 'index carries titles and refs only');
  // Flip the oldest entry to suspect via a genuine recurrence, then overflow.
  // The recurrence run lands strictly after creation (millisecond clock).
  await sleepMs(10);
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 unique case 0');
  const line = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.match(line ?? '', /Rule number 0.*\[needs-review\]/);
  stored = await readLearningIndex(f.store.directory);
  assert.equal(stored.find(entry => entry.id === entries[0].id)?.status, 'suspect');
  await f.service.recordLearning({
    title: 'Overflow rule',
    file: 'AGENTS.md',
    evidenceRefs: [run.id],
    failureSignature: { tests: ['overflow case'], errorClasses: [] },
  });
  stored = await readLearningIndex(f.store.directory);
  assert.equal(stored.length, maxLearningEntries);
  assert.ok(stored.some(entry => entry.id === entries[0].id), 'suspect survives eviction');
  assert.ok(!stored.some(entry => entry.id === entries[1].id), 'oldest non-suspect evicts first');
  assert.ok(stored.some(entry => entry.title === 'Overflow rule'));
});

test('evictLearningEntries drops oldest first with a deterministic tiebreak', () => {
  const at = new Date().toISOString();
  const entry = (id: string, status: 'active' | 'suspect'): LearningRuleEntry => ({
    id, title: id, file: 'AGENTS.md', evidenceRefs: ['r'],
    failureSignature: { tests: ['t'], errorClasses: [] },
    createdAt: at, lastValidatedAt: at, status,
  });
  const many = Array.from({ length: maxLearningEntries + 2 }, (_, index) =>
    entry(`id-${String(index).padStart(3, '0')}`, index === 0 ? 'suspect' : 'active'));
  const kept = evictLearningEntries(many);
  assert.equal(kept.length, maxLearningEntries);
  assert.ok(kept.some(candidate => candidate.id === 'id-000'), 'suspect evicts last');
  assert.ok(!kept.some(candidate => candidate.id === 'id-001'));
  assert.ok(!kept.some(candidate => candidate.id === 'id-002'));
});

test('injection ranks exact test-name hits above error-class hits and caps at three', async t => {
  const f = await registeredFixture('openworkspace-learning-match-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow\nError TimeoutExpired boom');
  const runs = await f.service.recentRuns(f.workspace.id, 5);
  const ref = runs[0].id;
  const bodies = [
    { title: 'Login rule one', file: 'AGENTS.md', evidenceRefs: [ref], failureSignature: { tests: ['login flow'], errorClasses: [] } },
    { title: 'Login rule two', file: 'AGENTS.md', evidenceRefs: [ref], failureSignature: { tests: ['login flow'], errorClasses: [] } },
    { title: 'Timeout error rule', file: 'skills/db/SKILL.md', evidenceRefs: [ref], failureSignature: { tests: [], errorClasses: ['timeoutexpired'] } },
    { title: 'Unrelated rule', file: 'AGENTS.md', evidenceRefs: [ref], failureSignature: { tests: ['no such case'], errorClasses: ['no such class'] } },
  ];
  for (const body of bodies) await f.service.recordLearning(body);
  const line = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.ok(line?.startsWith('Relevant past lessons: '));
  assert.ok(!line!.includes('Unrelated rule'), 'non-matching entries never inject');
  const titles = line!.slice('Relevant past lessons: '.length, -1).split('; ');
  assert.equal(titles.length, 3, 'all three matches inject');
  const loginPositions = titles.map((title, index) => (title.includes('Login rule') ? index : -1)).filter(index => index >= 0);
  const timeoutPosition = titles.findIndex(title => title.includes('Timeout error rule'));
  assert.ok(timeoutPosition >= 0 && loginPositions.every(position => position < timeoutPosition), 'test-name hits outrank error-class hits');
  // A fourth match pushes the lowest-ranked title out of the top 3.
  await f.service.recordLearning({
    title: 'Login rule three', file: 'AGENTS.md', evidenceRefs: [ref],
    failureSignature: { tests: ['login flow'], errorClasses: [] },
  });
  const capped = await learningLessonLine(f.store.directory, learningTotalCap);
  const cappedTitles = capped!.slice('Relevant past lessons: '.length, -1).split('; ');
  assert.equal(cappedTitles.length, 3, 'top-3 cap holds');
  assert.ok(!capped!.includes('Timeout error rule'), 'the error-class hit yields to three test-name hits');
});

test('injection truncates titles to fit the remaining budget and yields on zero budget', async t => {
  const f = await registeredFixture('openworkspace-learning-budget-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 shared failure mode');
  const ref = (await f.service.recentRuns(f.workspace.id, 1))[0].id;
  for (const suffix of ['a', 'b', 'c']) {
    await f.service.recordLearning({
      title: `${'Long title words '.repeat(4)}${suffix}`,
      file: 'skills/very-long-skill-name/SKILL.md',
      evidenceRefs: [ref],
      failureSignature: { tests: ['shared failure mode'], errorClasses: [] },
    });
  }
  assert.equal(await learningLessonLine(f.store.directory, 0), undefined);
  assert.equal(await learningLessonLine(f.store.directory, -5), undefined);
  const full = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.ok(full && Buffer.byteLength(full, 'utf8') <= learningTotalCap);
  assert.equal(full!.split('; ').length, 3, 'all three fit a full budget');
  // Shrinking budgets monotonically drop titles and never exceed the budget.
  const counts: number[] = [];
  for (const budget of [400, 300, 220, 160, 120, 60]) {
    const candidate = await learningLessonLine(f.store.directory, budget);
    if (candidate !== undefined) {
      assert.ok(Buffer.byteLength(candidate, 'utf8') <= budget, `line fits a ${budget}B budget`);
    }
    counts.push(candidate === undefined ? 0 : candidate.split('; ').length);
  }
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'title counts shrink monotonically with the budget');
  assert.ok(counts[0] === 3 && counts[counts.length - 1] === 0, 'full budget keeps three titles, tiny budget yields');
});

test('recurrence signal: holding at zero, suspect on first repeat, flagged in the line', async t => {
  const f = await registeredFixture('openworkspace-learning-signal-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 checkout flow');
  const ref = (await f.service.recentRuns(f.workspace.id, 1))[0].id;
  await f.service.recordLearning({
    title: 'Checkout flow guard',
    file: 'AGENTS.md',
    evidenceRefs: [ref],
    failureSignature: { tests: ['checkout flow'], errorClasses: [] },
  });
  await f.service.recordLearning({
    title: 'Other area guard',
    file: 'AGENTS.md',
    evidenceRefs: [ref],
    failureSignature: { tests: ['other area'], errorClasses: [] },
  });
  const corpus = await collectRecentLocalRuns(f.store.directory);
  const stored = await readLearningIndex(f.store.directory);
  assert.equal(countRecurrences(stored[0], corpus), 0, 'the triggering run predates creation: holding');
  assert.equal(stored[0].status, 'active');
  const holding = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.ok(holding?.includes('Checkout flow guard'));
  assert.ok(!holding?.includes('[needs-review]'), 'holding entries carry no flag');
  await sleepMs(10);
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 checkout flow again');
  const recurred = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.match(recurred ?? '', /Checkout flow guard \(AGENTS\.md\) \[needs-review\]/);
  const after = await readLearningIndex(f.store.directory);
  assert.equal(after.find(entry => entry.title === 'Checkout flow guard')?.status, 'suspect');
  assert.equal(after.find(entry => entry.title === 'Other area guard')?.status, 'active');
});

test('legacy homes without an index inject nothing and never crash', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-legacy-')));
  try {
    assert.deepEqual(await readLearningIndex(home), []);
    assert.equal(await learningLessonLine(home, learningTotalCap), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  const corruptHome = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-corrupt-')));
  try {
    await mkdir(join(corruptHome, 'learnings'), { recursive: true });
    await writeFile(join(corruptHome, 'learnings', 'index.json'), '{"entries": [oops');
    assert.deepEqual(await readLearningIndex(corruptHome), []);
    assert.equal(await learningLessonLine(corruptHome, learningTotalCap), undefined);
  } finally {
    await rm(corruptHome, { recursive: true, force: true });
  }
});

test('HTTP record round-trip gates dashboard intent and keeps activity counts-only', async t => {
  const f = await registeredFixture('openworkspace-learning-http-');
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  try {
    const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders };
    const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 http round trip');
    const body = {
      title: 'HTTP round trip rule',
      file: 'AGENTS.md',
      evidenceRefs: [run.id],
      failureSignature: { tests: ['http round trip'], errorClasses: [] },
    };
    const created = await fetch(`${origin}/api/learnings/record`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(body) });
    assert.equal(created.status, 201, 'MCP stays intent-free');
    const entry = await created.json() as LearningRuleEntry;
    assert.equal(entry.status, 'active');
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    // Dashboard callers need the canonical context plus the record-learning intent.
    const connected = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: { ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard' },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(connected.status, 201);
    const { dashboardToken } = await connected.json() as { dashboardToken: string };
    const dashboardHeaders = { Authorization: `Bearer ${dashboardToken}`, ...jsonHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    const missingIntent = await fetch(`${origin}/api/learnings/record`, { method: 'POST', headers: dashboardHeaders, body: JSON.stringify(body) });
    assert.equal(missingIntent.status, 403);
    const dashboardCreated = await fetch(`${origin}/api/learnings/record`, {
      method: 'POST',
      headers: { ...dashboardHeaders, 'X-OpenWorkspace-Intent': 'record-learning' },
      body: JSON.stringify({ ...body, title: 'Dashboard gated rule' }),
    });
    assert.equal(dashboardCreated.status, 201);
    // Safe errors: unknown evidence and secret content fail with safe messages only.
    const unknownEvidence = await fetch(`${origin}/api/learnings/record`, {
      method: 'POST', headers: mcpHeaders, body: JSON.stringify({ ...body, title: 'Unknown evidence rule', evidenceRefs: ['no-such-run'] }),
    });
    assert.equal(unknownEvidence.status, 400);
    assert.deepEqual(await unknownEvidence.json(), { error: learningMessages.evidence });
    const secretTitle = await fetch(`${origin}/api/learnings/record`, {
      method: 'POST', headers: mcpHeaders, body: JSON.stringify({ ...body, title: 'leak password=hunter2-now', evidenceRefs: [run.id] }),
    });
    assert.equal(secretTitle.status, 400);
    assert.deepEqual(await secretTitle.json(), { error: learningMessages.pattern });
    const malformed = await fetch(`${origin}/api/learnings/record`, {
      method: 'POST', headers: mcpHeaders, body: JSON.stringify({ ...body, evidenceRefs: [], unexpected: true }),
    });
    assert.equal(malformed.status, 400);
    // Activity hygiene: counts only, never titles, files or failure text.
    const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).json() as Array<{ operation: string; detail: string }>;
    const records = activity.filter(item => item.operation === 'learning-record');
    assert.equal(records.length, 2);
    for (const item of records) {
      assert.match(item.detail, /^\d+ evidence refs → (active|suspect)$/);
    }
    assert.ok(!JSON.stringify(records).includes('HTTP round trip rule'));
  } finally {
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('real stdio MCP learning_record round-trips through the service', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-learning-mcp-')));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const service = new WorkspaceService(store);
  const workspace = await service.register('MCP learning project', [project]);
  const app = createApp(service, { mcpToken: 'f'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const run = await failedRun(store.directory, workspace.id, 'not ok 1 mcp round trip');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'learning_record'));
    const recorded = await client.callTool({
      name: 'learning_record',
      arguments: {
        title: 'MCP round trip rule',
        file: 'AGENTS.md',
        evidenceRefs: [run.id],
        failureSignature: { tests: ['mcp round trip'], errorClasses: [] },
      },
    });
    assert.ok(!recorded.isError);
    assert.match((recorded.content as Array<{ text: string }>)[0].text, /"status": "active"/);
    const refused = await client.callTool({
      name: 'learning_record',
      arguments: {
        title: 'Unknown evidence rule',
        file: 'AGENTS.md',
        evidenceRefs: ['no-such-run'],
        failureSignature: { tests: ['mcp round trip'], errorClasses: [] },
      },
    });
    assert.ok(refused.isError);
    assert.match((refused.content as Array<{ text: string }>)[0].text, new RegExp(escapeRegExp(learningMessages.evidence)));
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('situations sanitize: normalize, bound, pattern-clean and refuse client measured', () => {
  const tagged = sanitizeLearningRecord(recordBody({
    evidenceRefs: ['abc-1'],
    failureSignature: { tests: [], errorClasses: [] as string[] },
    situations: ['  Missing Secret ', 'missing secret', 'service start'],
  }));
  assert.deepEqual(tagged.situations, ['missing secret', 'service start'], 'trimmed, lowercased and deduped');
  assert.deepEqual(tagged.failureSignature, { tests: [], errorClasses: [] });
  // Acceptance rule: situations alone satisfy the >=1 requirement.
  assert.deepEqual(sanitizeLearningRecord(recordBody()).situations, [], 'absent situations read as none');
  assert.throws(() => sanitizeLearningRecord(recordBody({
    failureSignature: { tests: [], errorClasses: [] as string[] },
  })), new RegExp(escapeRegExp(learningMessages.bounds)), 'empty signature without tags is refused');
  assert.throws(() => sanitizeLearningRecord(recordBody({
    situations: Array.from({ length: 11 }, (_, index) => `tag number ${index}`),
  })), new RegExp(escapeRegExp(learningMessages.bounds)), 'at most 10 tags');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: ['ab'] })), new RegExp(escapeRegExp(learningMessages.bounds)), 'tags need 3+ chars');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: ['x'.repeat(41)] })), new RegExp(escapeRegExp(learningMessages.bounds)), 'tags cap at 40 chars');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: [42] as unknown as string })), new RegExp(escapeRegExp(learningMessages.bounds)), 'tags must be strings');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: ['token=sk-live-12345'] })), new RegExp(escapeRegExp(learningMessages.pattern)), 'secret-shaped tags refused');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: ['see /abs/path now'] })), new RegExp(escapeRegExp(learningMessages.pattern)), 'absolute-path tags refused');
  assert.throws(() => sanitizeLearningRecord(recordBody({ situations: ['bad\x07tag'] })), new RegExp(escapeRegExp(learningMessages.pattern)), 'control-char tags refused');
  assert.throws(() => sanitizeLearningRecord({ ...recordBody(), measured: true }), new RegExp(escapeRegExp(learningMessages.bounds)), 'measured is server-stamped, never client-settable');
});

test('server stamps measured and legacy entries normalize measured with no tags', async t => {
  const f = await registeredFixture('openworkspace-learning-measured-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 measured case');
  const accessible = new Set([run.id!]);
  const read = async () => accessible;
  const measured = await appendLearningRule(f.store.directory, recordBody({ evidenceRefs: [run.id] }), read);
  assert.equal(measured.measured, true, 'tests present means measured');
  assert.deepEqual(measured.situations, [], 'absent tags stored as none');
  const waste = await appendLearningRule(f.store.directory, recordBody({
    title: 'Confirm settings before starting the service',
    evidenceRefs: [run.id],
    failureSignature: { tests: [], errorClasses: [] as string[] },
    situations: ['missing secret'],
  }), read);
  assert.equal(waste.measured, false, 'tags-only means unmeasured');
  // Legacy shape: entries written before the extension carry neither field.
  const stored = await readLearningIndex(f.store.directory);
  const legacyShaped = stored.map(({ measured: _measured, situations: _situations, ...rest }) => rest);
  assert.ok(legacyShaped.every(entry => !('measured' in entry) && !('situations' in entry)));
  await writeFile(join(f.store.directory, 'learnings', 'index.json'), JSON.stringify(legacyShaped));
  const normalized = await readLearningIndex(f.store.directory);
  assert.equal(normalized.length, legacyShaped.length);
  assert.ok(normalized.every(entry => entry.measured === true && Array.isArray(entry.situations) && entry.situations.length === 0),
    'legacy entries read as measured with no tags');
});

test('tokenizeContext is pure: lowercase, bounded and stop-word free', () => {
  assert.deepEqual(tokenizeContext('Service START missing-secret, service!'), ['service', 'start', 'missing', 'secret']);
  assert.deepEqual(tokenizeContext('the and for with from that this'), [], 'stop-words and short fragments drop out');
  assert.deepEqual(tokenizeContext('it is an up'), [], 'fragments under 3 chars drop out');
  const many = Array.from({ length: 100 }, (_, index) => `token${index}`).join(' ');
  assert.equal(tokenizeContext(many).length, 50, 'tokens cap at 50');
  assert.deepEqual(selectSituationalLessons([], 'anything here'), []);
  assert.deepEqual(selectSituationalLessons([{
    id: 'x', title: 't', file: 'AGENTS.md', evidenceRefs: ['r'],
    failureSignature: { tests: [], errorClasses: [] },
    situations: ['missing secret'], measured: false,
    createdAt: new Date().toISOString(), lastValidatedAt: new Date().toISOString(), status: 'active',
  }], undefined), [], 'no context selects nothing');
});

test('situation matches qualify only with context and rank below failure hits', async t => {
  const f = await registeredFixture('openworkspace-learning-situation-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow');
  const ref = (await f.service.recentRuns(f.workspace.id, 1))[0].id;
  await f.service.recordLearning({
    title: 'Login guard', file: 'AGENTS.md', evidenceRefs: [ref],
    failureSignature: { tests: ['login flow'], errorClasses: [] },
  });
  await f.service.recordLearning({
    title: 'Confirm settings before starting the service', file: 'AGENTS.md', evidenceRefs: [ref],
    failureSignature: { tests: [], errorClasses: [] },
    situations: ['service start missing setting'],
  });
  const context = 'starting the service needs a missing setting value';
  const withContext = await learningLessonLine(f.store.directory, learningTotalCap, context);
  assert.ok(withContext?.includes('Login guard'), 'failure hit still injects with context');
  assert.ok(withContext?.includes('Confirm settings before starting the service (AGENTS.md) [situational]'),
    'unmeasured situation hit renders with the situational suffix');
  assert.ok((withContext?.indexOf('Login guard') ?? 0) < (withContext?.indexOf('Confirm settings') ?? 0),
    'situation tier ranks below failure hits');
  // No-context behavior is byte-identical legacy: the unmeasured entry can
  // never failure-match, and an empty context tokenizes to the same nothing.
  const without = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.ok(without?.includes('Login guard'));
  assert.ok(!without?.includes('Confirm settings'), 'unmeasured entries never inject without context');
  assert.equal(await learningLessonLine(f.store.directory, learningTotalCap, ''), without, 'empty context matches no-context bytes');
});

test('unmeasured entries never recur, never flag and evict after measured-active', async t => {
  const f = await registeredFixture('openworkspace-learning-lifecycle-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 setup detour case');
  const ref = (await f.service.recentRuns(f.workspace.id, 1))[0].id;
  const waste = await f.service.recordLearning({
    title: 'Setup detour guard', file: 'AGENTS.md', evidenceRefs: [ref],
    failureSignature: { tests: [], errorClasses: [] },
    situations: ['setup detour'],
  });
  assert.equal(waste.measured, false);
  await sleepMs(10);
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 setup detour case again');
  const corpus = await collectRecentLocalRuns(f.store.directory);
  const stored = await readLearningIndex(f.store.directory);
  assert.equal(countRecurrences(stored[0], corpus), 0, 'unmeasured recurrences always read zero');
  assert.equal((await readLearningIndex(f.store.directory))[0].status, 'active', 'no auto-flag without a failure signature');
  const line = await learningLessonLine(f.store.directory, learningTotalCap);
  assert.ok(!line?.includes('[needs-review]'), 'holding unmeasured entries carry no flag');
  // Three-tier eviction: measured-active oldest-first, then unmeasured-active, suspects last.
  const at = new Date().toISOString();
  const entry = (id: string, status: 'active' | 'suspect', measured: boolean | undefined): LearningRuleEntry => ({
    id, title: id, file: 'AGENTS.md', evidenceRefs: ['r'],
    failureSignature: { tests: measured === false ? [] : ['t'], errorClasses: [] },
    ...(measured === undefined ? {} : { measured, situations: measured ? [] : ['setup detour'] }),
    createdAt: at, lastValidatedAt: at, status,
  });
  const many = [
    entry('id-suspect', 'suspect', true),
    entry('id-unmeasured', 'active', false),
    entry('id-z-legacy', 'active', undefined),
    ...Array.from({ length: maxLearningEntries }, (_, index) => entry(`id-m-${String(index).padStart(3, '0')}`, 'active', true)),
  ];
  const kept = evictLearningEntries(many);
  assert.equal(kept.length, maxLearningEntries);
  assert.ok(kept.some(candidate => candidate.id === 'id-suspect'), 'suspect evicts last');
  assert.ok(kept.some(candidate => candidate.id === 'id-unmeasured'), 'unmeasured-active survives measured-active eviction');
  assert.ok(kept.some(candidate => candidate.id === 'id-z-legacy'), 'legacy entries count as measured-active');
  assert.ok(!kept.some(candidate => candidate.id === 'id-m-000'), 'oldest measured-active evicts first');
});

test('situational injection honors the byte budget and truncates monotonically', async t => {
  const at = new Date().toISOString();
  const entries: LearningRuleEntry[] = Array.from({ length: 5 }, (_, index) => ({
    id: `sit-${index}`, title: `Setup lesson number ${index} with a long reusable title`, file: 'AGENTS.md',
    evidenceRefs: ['r'], failureSignature: { tests: [], errorClasses: [] },
    situations: ['service start'], measured: false,
    createdAt: at, lastValidatedAt: at, status: 'active' as const,
  }));
  const picked = selectSituationalLessons(entries, 'starting the service now');
  assert.equal(picked.length, 3, 'situational selection caps at three');
  assert.ok(picked.every(title => title.endsWith('[situational]')), 'every unmeasured title carries the suffix');
});

test('HTTP and MCP record round-trips carry situations and refuse client measured', async t => {
  const f = await registeredFixture('openworkspace-learning-situations-http-');
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  try {
    const mcpHeaders = { Authorization: `Bearer ${app.mcpToken}`, ...jsonHeaders };
    const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 situations round trip');
    const body = {
      title: 'Situations round trip rule',
      file: 'AGENTS.md',
      evidenceRefs: [run.id],
      failureSignature: { tests: [], errorClasses: [] },
      situations: ['Missing Setting'],
    };
    const created = await fetch(`${origin}/api/learnings/record`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const entry = await created.json() as LearningRuleEntry;
    assert.equal(entry.measured, false, 'tags-only records stamp unmeasured');
    assert.deepEqual(entry.situations, ['missing setting'], 'tags normalize server-side');
    const measured = await fetch(`${origin}/api/learnings/record`, {
      method: 'POST', headers: mcpHeaders, body: JSON.stringify({ ...body, title: 'Measured key smuggle', measured: true }),
    });
    assert.equal(measured.status, 400, 'strict keys refuse client measured');
    // Activity hygiene holds for waste lessons: counts only, never tags.
    const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).json() as Array<{ operation: string; detail: string }>;
    const records = activity.filter(item => item.operation === 'learning-record');
    assert.equal(records.length, 1);
    assert.match(records[0].detail, /^\d+ evidence refs → (active|suspect)$/);
    assert.ok(!JSON.stringify(records).includes('missing setting'));
  } finally {
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('MCP learning_record advertises situations and forwards them to the same route', async () => {
  const mcpSource = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const block = mcpSource.slice(mcpSource.indexOf("server.registerTool('learning_record'"));
  assert.ok(block.includes('situations'), 'learning_record schema carries situations');
  assert.ok(block.includes('/api/learnings/record'), 'MCP forwards to the shared record route');
});
