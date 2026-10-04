import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { persistRunSummary } from '../src/run-summaries.js';
import { maxLearningEntries, type LearningRuleEntry } from '../src/rule-index.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

async function registeredFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Lesson shelf project', [project]);
  return { root, project, store, service, workspace };
}

function headers(app: { mcpToken: string }) {
  return { Authorization: `Bearer ${app.mcpToken}` };
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

function seedEntry(overrides: Partial<LearningRuleEntry> & { id: string; title: string }): LearningRuleEntry {
  return {
    file: 'AGENTS.md',
    evidenceRefs: [],
    failureSignature: { tests: ['login flow'], errorClasses: [] },
    situations: [],
    measured: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastValidatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

test('GET /api/lessons returns the title-only projection and leaves milestones untouched', async t => {
  const f = await registeredFixture('openworkspace-lesson-shelf-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);

  const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow');
  const recorded = await f.service.recordLearning({
    title: 'Quote identifiers in helper queries',
    file: 'AGENTS.md',
    evidenceRefs: [run.id],
    failureSignature: { tests: ['login flow'], errorClasses: [] },
  });

  const response = await fetch(`${origin}/api/lessons`, { headers: headers(app) });
  assert.equal(response.status, 200);
  const shelf = await response.json() as Array<Record<string, unknown>>;
  assert.equal(shelf.length, 1);
  assert.deepEqual(Object.keys(shelf[0]).sort(), ['file', 'measured', 'recurrenceCount', 'status', 'title']);
  assert.deepEqual(shelf[0], {
    title: 'Quote identifiers in helper queries',
    file: 'AGENTS.md',
    measured: true,
    status: 'active',
    recurrenceCount: 0,
  });
  assert.equal(recorded.title, 'Quote identifiers in helper queries');

  // The wire carries no bodies, evidence refs, failure signatures or literals.
  const wire = JSON.stringify(shelf);
  assert.ok(!wire.includes('evidenceRefs'), 'no evidence refs on the wire');
  assert.ok(!wire.includes('failureSignature'), 'no failure signatures on the wire');
  assert.ok(!wire.includes('login flow'), 'signature text never leaks beyond the title');

  // Milestone notes path untouched: same shape as before.
  const learnings = await (await fetch(`${origin}/api/learnings`, { headers: headers(app) })).json();
  assert.deepEqual(learnings, { milestones: [] });
});

test('shelf sorts suspects first then newest with situational and recurrence badges', async t => {
  const f = await registeredFixture('openworkspace-lesson-shelf-sort-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);

  // A later matching run makes the measured entries recur within the window.
  await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow');
  await mkdir(join(f.store.directory, 'learnings'), { recursive: true });
  await writePrivateJson(join(f.store.directory, 'learnings', 'index.json'), [
    seedEntry({ id: '11111111-1111-4111-8111-111111111111', title: 'Active old measured', createdAt: '2026-01-01T00:00:00.000Z' }),
    seedEntry({ id: '22222222-2222-4222-8222-222222222222', title: 'Suspect middle', status: 'suspect', createdAt: '2026-02-01T00:00:00.000Z' }),
    seedEntry({
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Active new situational',
      measured: false,
      situations: ['setup-detour'],
      failureSignature: { tests: [], errorClasses: [] },
      createdAt: '2026-03-01T00:00:00.000Z',
    }),
  ]);

  const shelf = await (await fetch(`${origin}/api/lessons`, { headers: headers(app) })).json() as Array<{
    title: string; file: string; measured: boolean; status: string; recurrenceCount: number;
  }>;
  assert.deepEqual(shelf.map(entry => entry.title), ['Suspect middle', 'Active new situational', 'Active old measured']);
  assert.deepEqual(shelf.map(entry => entry.measured), [true, false, true]);
  assert.deepEqual(shelf.map(entry => entry.status), ['suspect', 'active', 'active']);
  // Measured entries with a later matching run recur; the situational one never does.
  assert.deepEqual(shelf.map(entry => entry.recurrenceCount), [1, 0, 1]);
});

test('shelf caps at the index ceiling and requires authentication', async t => {
  const f = await registeredFixture('openworkspace-lesson-shelf-cap-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const app = createApp(f.service, { mcpToken: 'e'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);

  const run = await failedRun(f.store.directory, f.workspace.id, 'not ok 1 login flow');
  for (let index = 0; index < maxLearningEntries + 1; index++) {
    await f.service.recordLearning({
      title: `Lesson number ${index} recorded for the shelf cap`,
      file: 'AGENTS.md',
      evidenceRefs: [run.id],
      failureSignature: { tests: ['login flow'], errorClasses: [] },
    });
  }
  const shelf = await (await fetch(`${origin}/api/lessons`, { headers: headers(app) })).json() as unknown[];
  assert.equal(shelf.length, maxLearningEntries);

  const denied = await fetch(`${origin}/api/lessons`);
  assert.equal(denied.status, 401);
});
