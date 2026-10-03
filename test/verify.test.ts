import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { runVerification, type CommandOutcome, type CommandRunner } from '../src/verify.js';
import type { Pm2ListResult } from '../src/services.js';

const SHA = 'a'.repeat(40);

function outcome(partial: Partial<CommandOutcome>): CommandOutcome {
  return {
    exitCode: 0, timedOut: false, aborted: false, truncated: false,
    stdout: '', stderr: '', durationMs: 5, spawnFailed: false, ...partial,
  };
}

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }, scripts: Record<string, string> = { check: 'node check.mjs' }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-verify-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ scripts }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const approved = await service.register('Project', [project]);
  return { root, project, store, approved };
}

function gitRunner(calls: Array<{ command: string; args: string[] }>, statusOutput = ''): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') return outcome({ stdout: `${SHA}\n` });
    if (command === 'git') return outcome({ stdout: statusOutput });
    throw new Error(`Unexpected command: ${command}`);
  };
}

const processFor = (cwd: string) => ({
  pmId: 3, name: 'api', namespace: 'default', status: 'online', cwd, restartCount: 0, startedAt: null,
});

test('verification runs the approved manifest script with git, service and time context', async t => {
  const f = await fixture(t);
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') return outcome({ stdout: `${SHA}\n` });
    if (command === 'git') return outcome({ stdout: ' M src/a.ts\n?? new.ts\n' });
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['run', 'check', '--silent']);
    assert.equal(options.cwd, f.project);
    assert.equal(options.env?.CI, 'true');
    return outcome({ stdout: 'ok\n', durationMs: 42 });
  };
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [processFor(f.project)] });
  const service = new WorkspaceService(f.store, list, undefined, run);
  const result = await service.verify(f.approved.id, {
    repositoryPath: f.project, scriptName: 'check',
    service: { pmId: 3, name: 'api', namespace: 'default' },
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.repositoryPath, f.project);
  assert.equal(result.rootPath, f.project);
  assert.equal(result.scriptName, 'check');
  assert.match(result.scriptHash, /^[0-9a-f]{64}$/);
  assert.equal(result.scriptPreview, 'node check.mjs');
  assert.equal(result.git.revision, SHA);
  assert.equal(result.git.revisionState, 'observed');
  assert.equal(result.git.worktree, 'dirty');
  assert.equal(result.git.changedEntries, 2);
  assert.deepEqual(result.service, { pmId: 3, name: 'api', namespace: 'default', status: 'online' });
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)));
  assert.match(result.message, /not a CI verdict/);
  assert.deepEqual(calls.map(call => `${call.command} ${call.args[0]}`), ['git rev-parse', 'git status', 'git diff', 'npm run']);
});

test('verification refuses paths, scripts and repositories outside the approved scope', async t => {
  const f = await fixture(t);
  let runs = 0;
  const run: CommandRunner = async () => {
    runs += 1;
    return outcome({});
  };
  const service = new WorkspaceService(f.store, undefined, undefined, run);
  await assert.rejects(
    service.verify(f.approved.id, { repositoryPath: join(f.root, 'elsewhere'), scriptName: 'check' }),
    /not inside an registered project root/,
  );
  await assert.rejects(
    service.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'deploy' }),
    /no runnable test script/,
  );
  await assert.rejects(
    service.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'check; rm -rf /' }),
    /no runnable test script/,
  );
  const link = join(f.root, 'linked');
  await mkdir(link);
  await symlink(f.project, join(link, 'alias'));
  await assert.rejects(
    service.verify(f.approved.id, { repositoryPath: join(link, 'alias'), scriptName: 'check' }),
    /not a real directory|not inside an registered project root/,
  );
  assert.equal(runs, 0);
});

test('verification refuses an unmapped service link without running the test', async t => {
  const f = await fixture(t);
  let runs = 0;
  const run: CommandRunner = async (command, args) => {
    runs += 1;
    if (command === 'git' && args[0] === 'rev-parse') return outcome({ stdout: `${SHA}\n` });
    return outcome({ stdout: '' });
  };
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [processFor(outside)] });
  const service = new WorkspaceService(f.store, list, undefined, run);
  await assert.rejects(
    service.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'check', service: { pmId: 3, name: 'api' } }),
    /not uniquely mapped/,
  );
  assert.equal(runs, 0);
});

test('verification reports timeout, missing npm and output overflow honestly', async t => {
  const f = await fixture(t);
  const git = gitRunner([], '');
  const hanging = new WorkspaceService(f.store, undefined, undefined, async (command, args) => {
    if (command === 'npm') return outcome({ exitCode: null, timedOut: true, stdout: 'partial' });
    return git(command, args, { cwd: f.project, timeoutMs: 1, outputLimit: 1 });
  });
  const timedOut = await hanging.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'check' });
  assert.equal(timedOut.outcome, 'failed');
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.message, /not a pass/);

  const missing = new WorkspaceService(f.store, undefined, undefined, async (command, args) => {
    if (command === 'npm') return outcome({ spawnFailed: true });
    return git(command, args, { cwd: f.project, timeoutMs: 1, outputLimit: 1 });
  });
  const unavailable = await missing.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'check' });
  assert.equal(unavailable.outcome, 'error');
  assert.match(unavailable.message, /npm is unavailable/);

  const overflowing = new WorkspaceService(f.store, undefined, undefined, async (command, args) => {
    if (command === 'npm') return outcome({ exitCode: null, truncated: true, stdout: 'x'.repeat(10) });
    return git(command, args, { cwd: f.project, timeoutMs: 1, outputLimit: 1 });
  });
  const overflowed = await overflowing.verify(f.approved.id, { repositoryPath: f.project, scriptName: 'check' });
  assert.equal(overflowed.outcome, 'failed');
  assert.equal(overflowed.truncated, true);
  assert.match(overflowed.message, /bounded capture/);
});

test('runVerification marks a non-git checkout and a missing service link honestly', async t => {
  const f = await fixture(t);
  const run: CommandRunner = async command => {
    if (command === 'git') return outcome({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    return outcome({ stdout: 'ok\n' });
  };
  const result = await runVerification([f.project], { repositoryPath: f.project, scriptName: 'check' }, { runCommand: run });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.git.revisionState, 'unknown');
  assert.equal(result.git.worktree, 'unknown');
  assert.equal(result.service, null);
});
