import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { persistRunSummary } from '../src/run-summaries.js';
import {
  entrySituations,
  learningLessonLine,
  learningTotalCap,
  readLearningIndex,
  selectSituationalLessons,
  type LearningRuleEntry,
} from '../src/rule-index.js';

// Retrieval proof in a realistic microservices world: a seeded index of ~11
// lessons (frontend e2e flake, backend migration order, db seed idempotency,
// secret-missing-on-start, docker volume mount, service start order,
// port collision, mailbox lease, checkpoint hygiene, plus 2 unrelated
// decoys) crossed with 5 task contexts. Real function calls throughout
// (recordLearning → workstreamContext/selectSituationalLessons/
// learningLessonLine); no mocks of the ranker. Tags are shapes only.

interface World {
  root: string;
  project: string;
  store: Store;
  service: WorkspaceService;
  workspaceId: string;
  evidenceRef: string;
}

async function seedWorld(prefix: string): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Retrieval proof project', [project]);
  const run = await persistRunSummary(store.directory, {
    workspaceId: workspace.id, scriptName: 'test', outcome: 'failed', durationMs: 120,
    output: 'not ok 1 seed world evidence', outputTruncated: false,
  });
  const ref = run.id!;
  const lessons: Array<Record<string, unknown>> = [
    { title: 'Retry the frontend e2e suite once before digging', file: 'skills/e2e/SKILL.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['frontend e2e flake'] },
    { title: 'Apply backend migrations in dependency order', file: 'skills/backend/SKILL.md', failureSignature: { tests: ['migration order'], errorClasses: [] as string[] }, situations: ['backend migration order'] },
    { title: 'Keep the database seed script idempotent', file: 'skills/db/SKILL.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['database seed idempotency'] },
    { title: 'Confirm settings before starting the service', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['missing setting service start'] },
    { title: 'Mount the docker volume before seeding', file: 'skills/db/SKILL.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['docker volume mount'] },
    { title: 'Start dependencies before the api service', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['service start order'] },
    { title: 'Probe the port before binding on restart', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['port collision retry'] },
    { title: 'Renew the mailbox lease before it expires', file: 'skills/mailbox/SKILL.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['mailbox lease renew'] },
    { title: 'Hand off a short checkpoint note at pause', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['checkpoint handoff log'] },
    { title: 'Schedule freight reviews on fridays', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['freight schedule'] },
    { title: 'Match release notes to the house style', file: 'AGENTS.md', failureSignature: { tests: [], errorClasses: [] as string[] }, situations: ['release notes style'] },
  ];
  for (const lesson of lessons) {
    await service.recordLearning({ ...lesson, evidenceRefs: [ref] });
  }
  return { root, project, store, service, workspaceId: workspace.id, evidenceRef: ref };
}

async function taskLessons(
  world: World,
  task: { name: string; goal: string; blocker: string; next: string },
  environment?: Array<{ id: string; port: number }>,
): Promise<string[]> {
  const workstream = await world.service.createWorkstream({
    name: task.name, workspaceId: world.workspaceId, checkouts: [world.project],
  });
  await world.service.setWorkstreamStatus(workstream.id, 'paused', { ...task, owner: 'agent' });
  if (environment) {
    await world.service.environmentSet(world.workspaceId, {
      name: 'dev',
      services: environment.map(item => ({
        id: item.id, repositoryPath: world.project, scriptName: 'test', port: item.port, readiness: { kind: 'http-200' },
      })),
    });
  }
  return (await world.service.workstreamContext(workstream.id)).situationalLessons;
}

function titlesOf(lines: string[]): string[] {
  return lines.map(line => line.split(' (')[0]);
}

test('bootstrap from scratch surfaces setup lessons and suppresses decoys', async t => {
  const world = await seedWorld('openworkspace-retrieval-bootstrap-');
  t.after(() => rm(world.root, { recursive: true, force: true }));
  const lessons = await taskLessons(
    world,
    {
      name: 'fresh environment bootstrap',
      goal: 'start all services from scratch',
      blocker: 'service will not start without its setting value',
      next: 'confirm settings then start',
    },
    [{ id: 'api', port: 4318 }],
  );
  const titles = titlesOf(lessons);
  assert.ok(titles.includes('Confirm settings before starting the service'), `got: ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('Start dependencies before the api service'), `got: ${JSON.stringify(titles)}`);
  assert.ok(lessons.length <= 3, 'top-3 cap holds');
  for (const decoy of ['Schedule freight reviews on fridays', 'Match release notes to the house style', 'Retry the frontend e2e suite once before digging', 'Keep the database seed script idempotent', 'Apply backend migrations in dependency order']) {
    assert.ok(!titles.includes(decoy), `decoy suppressed: ${decoy}`);
  }
});

test('frontend e2e run surfaces only the e2e lesson', async t => {
  const world = await seedWorld('openworkspace-retrieval-e2e-');
  t.after(() => rm(world.root, { recursive: true, force: true }));
  const lessons = await taskLessons(world, {
    name: 'frontend checkout e2e',
    goal: 'run the frontend e2e suite',
    blocker: 'flake fails one in three runs',
    next: 'run the suite again',
  });
  const titles = titlesOf(lessons);
  assert.deepEqual(titles, ['Retry the frontend e2e suite once before digging'], `got: ${JSON.stringify(titles)}`);
});

test('backend migration: startup line carries the failure match; task context carries the situational pair', async t => {
  const world = await seedWorld('openworkspace-retrieval-migration-');
  t.after(() => rm(world.root, { recursive: true, force: true }));
  await persistRunSummary(world.store.directory, {
    workspaceId: world.workspaceId, scriptName: 'test', outcome: 'failed', durationMs: 90,
    output: 'not ok 1 migration order apply fails', outputTruncated: false,
  });
  const line = await learningLessonLine(world.store.directory, learningTotalCap);
  assert.ok(line?.includes('Apply backend migrations in dependency order'), `failure match injects at startup: ${line}`);
  assert.ok(!line?.includes('Start dependencies before the api service'), 'situational-only lessons never inject at startup');
  assert.ok(!line?.includes('freight') && !line?.includes('release notes'), 'decoys absent');
  const lessons = await taskLessons(world, {
    name: 'backend implementation',
    goal: 'apply the backend migration order',
    blocker: 'migration order fails on start',
    next: 'start the service after migrate',
  });
  const titles = titlesOf(lessons);
  assert.ok(titles.includes('Apply backend migrations in dependency order'), `got: ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('Start dependencies before the api service'), `got: ${JSON.stringify(titles)}`);
  assert.ok(lessons.length <= 3, 'top-3 cap holds');
  for (const decoy of ['Schedule freight reviews on fridays', 'Match release notes to the house style', 'Retry the frontend e2e suite once before digging', 'Keep the database seed script idempotent']) {
    assert.ok(!titles.includes(decoy), `decoy suppressed: ${decoy}`);
  }
});

test('db seed repair surfaces the seed lesson; unrelated docs task returns empty', async t => {
  const world = await seedWorld('openworkspace-retrieval-seed-');
  t.after(() => rm(world.root, { recursive: true, force: true }));
  const seedLessons = await taskLessons(world, {
    name: 'database seed repair',
    goal: 'repair the seed script',
    blocker: 'reseed duplicates rows',
    next: 'make the seed idempotent',
  });
  assert.deepEqual(
    titlesOf(seedLessons),
    ['Keep the database seed script idempotent'],
    `got: ${JSON.stringify(seedLessons)}`,
  );
  const docsLessons = await taskLessons(world, {
    name: 'docs polish',
    goal: 'fix readme spelling',
    blocker: 'none',
    next: 'merge the docs',
  });
  assert.deepEqual(docsLessons, [], `negative control returns empty, got: ${JSON.stringify(docsLessons)}`);
});

test('760B budget holds with 3 long titles and legacy entries still match', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-retrieval-budget-')));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Budget proof project', [project]);
  try {
    await persistRunSummary(store.directory, {
      workspaceId: workspace.id, scriptName: 'test', outcome: 'failed', durationMs: 40,
      output: 'not ok 1 shared budget failure mode', outputTruncated: false,
    });
    const ref = (await service.recentRuns(workspace.id, 1))[0].id;
    for (const suffix of ['alpha', 'bravo', 'gamma']) {
      await service.recordLearning({
        title: `${'Long budget title words '.repeat(3)}${suffix}`.slice(0, 78),
        file: 'skills/very-long-skill-name/SKILL.md',
        evidenceRefs: [ref],
        failureSignature: { tests: ['shared budget failure mode'], errorClasses: [] },
        situations: ['shared budget context'],
      });
    }
    const line = await learningLessonLine(store.directory, learningTotalCap);
    assert.ok(line, 'three long titles still produce a line');
    assert.equal(line.split('; ').length, 3, `all three fit: ${line}`);
    assert.ok(Buffer.byteLength(line, 'utf8') <= learningTotalCap, '760B budget holds');
    // Legacy shape: entry written before the situations extension carries
    // neither field yet still failure-matches and reads as measured.
    const stored = await readLearningIndex(store.directory);
    const legacyShaped = stored.map(({ measured: _m, situations: _s, ...rest }) => rest);
    await writeFile(join(store.directory, 'learnings', 'index.json'), JSON.stringify(legacyShaped));
    const normalized = await readLearningIndex(store.directory);
    assert.ok(normalized.every(entry => entry.measured === true && entrySituations(entry).length === 0));
    const legacyLine = await learningLessonLine(store.directory, learningTotalCap);
    assert.ok(legacyLine?.includes('shared budget failure mode') || legacyLine?.includes('Long budget title'),
      `legacy entries unaffected: ${legacyLine}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('substring-collision decoys stay absent while compound tags still fire', () => {
  const at = new Date().toISOString();
  const decoy = (id: string, title: string, tag: string): LearningRuleEntry => ({
    id, title, file: 'AGENTS.md', evidenceRefs: ['r'],
    failureSignature: { tests: [], errorClasses: [] },
    situations: [tag], measured: false,
    createdAt: at, lastValidatedAt: at, status: 'active' as const,
  });
  // Each trap token substring-matched its decoy tag under the old matcher
  // ('port' in 'support', 'test' in 'latest', 'log' in 'catalog', 'git' in
  // 'digit'); token-equality must keep all four silent.
  const decoys = [
    decoy('d-port', 'Support ticket triage guide', 'support ticket triage'),
    decoy('d-test', 'Documentation polish checklist', 'latest documentation polish'),
    decoy('d-log', 'Catalog page styling notes', 'catalog page styling'),
    decoy('d-git', 'Digit extraction script rules', 'digit extraction script'),
  ];
  for (const context of [
    'probe the port binding order',
    'run the test suite again',
    'tail the service log output',
    'push the git branch now',
  ]) {
    assert.deepEqual(selectSituationalLessons(decoys, context), [], `no collision decoy fires for: ${context}`);
  }
  // Compound tags still fire on either word: word-split equality, not
  // whole-tag equality, so hyphenation costs no recall.
  const compound: LearningRuleEntry[] = [decoy('c-secret', 'Rotate the missing setting first', 'secret-missing')];
  const fired = selectSituationalLessons(compound, 'service failed from a secret missing value');
  assert.equal(fired.length, 1, `hyphenated tag fires: ${JSON.stringify(fired)}`);
  assert.ok(selectSituationalLessons(compound, 'polish the release notes').length === 0, 'unrelated tokens still miss');
  // Light plural recall: normalized equality matches ports↔port without
  // reopening substring looseness (support still misses port).
  const plural: LearningRuleEntry[] = [decoy('c-port', 'Probe the port before binding', 'port collision')];
  assert.deepEqual(
    titlesOf(selectSituationalLessons([...decoys, ...plural], 'probe the service ports binding')),
    ['Probe the port before binding'],
  );
});

test('skill-shortness contract: titles only, one line each, never bodies', async t => {
  const world = await seedWorld('openworkspace-retrieval-shortness-');
  t.after(() => rm(world.root, { recursive: true, force: true }));
  const lessons = await taskLessons(world, {
    name: 'fresh environment bootstrap',
    goal: 'start all services from scratch',
    blocker: 'service will not start without its setting value',
    next: 'confirm settings then start',
  });
  assert.ok(lessons.length > 0, 'scenario fires at least one lesson');
  for (const line of lessons) {
    assert.ok(!line.includes('\n'), `one-line format: ${line}`);
    assert.match(line, /^[^()]+\([^()]+\)( \[(situational|needs-review)\])?$/, `title-only shape: ${line}`);
  }
  // The pure selector agrees with the served context field.
  const stored = await readLearningIndex(world.store.directory);
  const direct = selectSituationalLessons(stored, 'start all services from scratch missing setting value');
  assert.deepEqual(new Set(titlesOf(direct)), new Set(titlesOf(lessons)));
  // The index carries titles/refs/tags only: no body key, no prose.
  const raw = JSON.parse(await readFile(join(world.store.directory, 'learnings', 'index.json'), 'utf8')) as Array<Record<string, unknown>>;
  const allowed = new Set(['id', 'title', 'file', 'evidenceRefs', 'failureSignature', 'situations', 'measured', 'createdAt', 'lastValidatedAt', 'status']);
  for (const entry of raw) {
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `no body key: ${key}`);
    assert.ok(typeof entry.title === 'string' && (entry.title as string).length <= 80);
  }
});
