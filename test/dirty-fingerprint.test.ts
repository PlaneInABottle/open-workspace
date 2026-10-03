import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { listRecentRuns } from '../src/run-summaries.js';
import { runVerification, type CommandOutcome, type CommandRunner } from '../src/verify.js';

const SHA = 'b'.repeat(40);

function outcome(partial: Partial<CommandOutcome>): CommandOutcome {
  return {
    exitCode: 0, timedOut: false, aborted: false, truncated: false,
    stdout: '', stderr: '', durationMs: 5, spawnFailed: false, ...partial,
  };
}

async function repoFixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-dirty-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }));
  return { root, project };
}

/** Git-aware stub: rev-parse → SHA, diff → diffStdout, status → statusStdout, npm → pass. */
function stubRun(options: {
  statusStdout?: string;
  diffStdout?: string;
  diffBehavior?: 'ok' | 'timeout' | 'spawn-failed' | 'nonzero' | 'capped';
  git?: boolean;
  calls?: Array<{ command: string; args: string[] }>;
}): CommandRunner {
  return async (command, args) => {
    options.calls?.push({ command, args });
    if (command === 'npm') return outcome({ stdout: 'ok\n' });
    if (command !== 'git') throw new Error(`Unexpected command: ${command}`);
    if (options.git === false) return outcome({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    if (args[0] === 'rev-parse') return outcome({ stdout: `${SHA}\n` });
    if (args[0] === 'diff') {
      if (options.diffBehavior === 'timeout') return outcome({ exitCode: null, timedOut: true, stdout: 'partial' });
      if (options.diffBehavior === 'spawn-failed') return outcome({ spawnFailed: true });
      if (options.diffBehavior === 'nonzero') return outcome({ exitCode: 128, stdout: '', stderr: 'fatal' });
      if (options.diffBehavior === 'capped') {
        return outcome({ exitCode: null, truncated: true, stdout: options.diffStdout ?? '' });
      }
      return outcome({ stdout: options.diffStdout ?? '' });
    }
    return outcome({ stdout: options.statusStdout ?? '' });
  };
}

test('clean tree records no dirty fingerprint', async t => {
  const f = await repoFixture(t);
  const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ statusStdout: '' }),
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.git.revision, SHA);
  assert.equal(result.git.worktree, 'clean');
  assert.equal(result.git.dirty, null);
});

test('dirty tree records a stable fingerprint that changes with the diff', async t => {
  const f = await repoFixture(t);
  const status = ' M src/a.ts\n?? new.ts\n';
  const first = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ statusStdout: status, diffStdout: 'diff --git a/src/a.ts b/src/a.ts\n+one' }),
  });
  const repeat = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ statusStdout: status, diffStdout: 'diff --git a/src/a.ts b/src/a.ts\n+one' }),
  });
  const changed = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ statusStdout: status, diffStdout: 'diff --git a/src/a.ts b/src/a.ts\n+two' }),
  });
  assert.ok(first.git.dirty, 'dirty tree must carry a fingerprint');
  assert.match(first.git.dirty.diffHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.git.dirty.files, ['src/a.ts', 'new.ts']);
  assert.equal(first.git.dirty.truncated, false);
  assert.deepEqual(repeat.git.dirty, first.git.dirty, 'identical trees hash identically');
  assert.notEqual(changed.git.dirty?.diffHash, first.git.dirty.diffHash, 'changed content hashes differently');
});

test('non-git checkout records no dirty fingerprint without failing verification', async t => {
  const f = await repoFixture(t);
  const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ git: false }),
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.git.revisionState, 'unknown');
  assert.equal(result.git.dirty, null);
});

test('diff timeout, spawn failure and nonzero exit degrade to absent without failing verification', async t => {
  const f = await repoFixture(t);
  const status = ' M src/a.ts\n';
  for (const diffBehavior of ['timeout', 'spawn-failed', 'nonzero'] as const) {
    const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
      runCommand: stubRun({ statusStdout: status, diffStdout: 'diff-content', diffBehavior }),
    });
    assert.equal(result.outcome, 'passed', `verify must pass despite diff ${diffBehavior}`);
    assert.equal(result.git.worktree, 'dirty');
    assert.equal(result.git.dirty, null, `diff ${diffBehavior} must degrade to absent`);
  }
});

test('diff command is bounded (5s, 1MiB) and a capped capture stays hashed with truncated set', async t => {
  const f = await repoFixture(t);
  const seen: Array<{ command: string; args: string[] }> = [];
  let diffOptions: { timeoutMs?: number; outputLimit?: number } | undefined;
  const run: CommandRunner = async (command, args, options) => {
    seen.push({ command, args });
    if (command === 'npm') return outcome({ stdout: 'ok\n' });
    if (command === 'git' && args[0] === 'rev-parse') return outcome({ stdout: `${SHA}\n` });
    if (command === 'git' && args[0] === 'diff') {
      diffOptions = { timeoutMs: options.timeoutMs, outputLimit: options.outputLimit };
      return outcome({ exitCode: null, truncated: true, stdout: 'partial-capture' });
    }
    return outcome({ stdout: ' M src/a.ts\n' });
  };
  const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, { runCommand: run });
  assert.deepEqual(diffOptions, { timeoutMs: 5_000, outputLimit: 1024 * 1024 });
  assert.ok(result.git.dirty, 'capped capture still hashes what was captured');
  assert.equal(result.git.dirty.truncated, true);
  assert.match(result.git.dirty.diffHash, /^[0-9a-f]{64}$/);
  assert.ok(seen.some(call => call.command === 'git' && call.args[0] === 'diff' && call.args.includes('--no-color')), 'diff runs without color');
});

test('file list caps at 50 names and only hash plus path names persist', async t => {
  const f = await repoFixture(t);
  const status = Array.from({ length: 60 }, (_, index) => ` M file-${index}.ts\n`).join('');
  const secretDiff = 'diff --git a/x b/x\n+password=hunter2-live-secret';
  const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, {
    runCommand: stubRun({ statusStdout: status, diffStdout: secretDiff }),
  });
  assert.ok(result.git.dirty);
  assert.equal(result.git.dirty.files.length, 50);
  assert.equal(result.git.dirty.truncated, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('hunter2-live-secret'), 'diff content must never persist');
  assert.ok(!serialized.includes('+password='), 'diff lines must never persist');
  assert.ok(serialized.includes(result.git.dirty.diffHash), 'hash persists');
});

test('verify persists revision plus fingerprint and recent_runs carries them; legacy files stay readable', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-dirty-runs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store, undefined, undefined, stubRun({
    statusStdout: ' M src/a.ts\n', diffStdout: 'diff --git a/src/a.ts b/src/a.ts\n+one',
  }));
  const workspace = await service.register('Dirty project', [project]);
  const result = await service.verify(workspace.id, { repositoryPath: project, scriptName: 'check' });
  assert.ok(result.git.dirty);
  const listed = await service.recentRuns(workspace.id, 5);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].revision, SHA);
  assert.deepEqual(listed[0].dirty, result.git.dirty, 'recent_runs entries carry the fingerprint for timeline data');
  const raw = JSON.parse(await readFile(join(store.directory, 'runs', workspace.id, (await readdir(join(store.directory, 'runs', workspace.id)))[0]), 'utf8')) as Record<string, unknown>;
  assert.equal(raw.revision, SHA);
  assert.ok(raw.dirty && typeof raw.dirty === 'object', 'run summary file persists the fingerprint');
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes('+one'), 'persisted summary holds the hash, never diff content');
  // Legacy summary files without the additive fields stay readable.
  await writeFile(
    join(store.directory, 'runs', workspace.id, '9999-legacy.json'),
    JSON.stringify({
      workspaceId: workspace.id, scriptName: 'check', outcome: 'passed', durationMs: 7,
      at: new Date().toISOString(), failingNames: [], failingTruncated: false,
      failureExcerpt: 'ok', excerptTruncated: false, outputTruncated: false, source: 'openworkspace-run',
    }),
  );
  const withLegacy = await listRecentRuns(store.directory, workspace.id, 5);
  assert.ok(withLegacy.some(entry => entry.revision === undefined && entry.dirty === undefined), 'legacy entries read as absent fingerprint');
});
