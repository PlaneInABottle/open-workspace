import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { environmentUp, environmentVerify } from '../src/environment.js';
import { capEnvironmentReceipt, listRecentRuns, persistRunSummary } from '../src/run-summaries.js';
import type { CommandOutcome } from '../src/verify.js';
import type { Pm2ListResult, Pm2Process } from '../src/services.js';

const revision = 'a'.repeat(40);

async function rig(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-receipt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, 'backend');
  const frontend = join(root, 'frontend');
  await mkdir(backend, { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(join(backend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js', check: 'node check.js' },
  }));
  await writeFile(join(frontend, 'package.json'), JSON.stringify({
    scripts: { dev: 'node server.js' },
  }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Stack', [root]);
  const record = await service.environmentSet(workspace.name, {
    name: 'local',
    services: [
      { id: 'backend', repositoryPath: backend, scriptName: 'dev', port: 3201, dependsOn: [], readiness: { kind: 'http-200' } },
      { id: 'frontend', repositoryPath: frontend, scriptName: 'dev', port: 3202, dependsOn: ['backend'], readiness: { kind: 'http-200' } },
    ],
  });
  return { root, backend, frontend, store, service, workspaceName: workspace.name, recordName: record.name, workspaceId: workspace.id, recordId: record.id };
}

function outcome(stdout: string, exitCode: number | null = 0): CommandOutcome {
  return { exitCode, timedOut: false, aborted: false, truncated: false, stdout, stderr: '', durationMs: 7, spawnFailed: false };
}

function gitRunner() {
  return async (command: string, args: string[]) => {
    if (command === 'git' && args[0] === 'rev-parse') return outcome(`${revision}\n`);
    if (command === 'git' && args[0] === 'status') return outcome(' M src/a.ts\n?? new.txt\n');
    if (command === 'git' && args[0] === 'diff') return outcome('diff --git a/src/a.ts b/src/a.ts\n');
    if (command === 'npm') return outcome('e2e ok\n');
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
}

test('environment_verify pins a capped identity receipt surfaced via recent_runs', async t => {
  const r = await rig(t);
  const processes: Pm2Process[] = [];
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: processes.map(p => ({ ...p })) });
  const starter = async (input: { name: string; scriptName: string; cwd: string }) => {
    processes.push({ pmId: 200 + processes.length, name: input.name, namespace: null, status: 'online', cwd: input.cwd, restartCount: 0, startedAt: null });
    return { ok: true } as const;
  };
  let nowMs = 2_000_000;
  await environmentUp(r.store, r.workspaceName, r.recordName, {
    list,
    starter,
    probe: async () => false,
    fetchImpl: (async () => new Response('ok', { status: 200 })) as typeof fetch,
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
    pollIntervalMs: 1000,
  });
  const verified = await environmentVerify(r.store, r.workspaceName, {
    environment: r.recordName,
    repositoryPath: r.backend,
    scriptName: 'check',
  }, { list, runCommand: gitRunner() });
  assert.equal(verified.outcome, 'passed');
  assert.ok(verified.runId, 'receipt persist yields a run id');
  assert.equal(verified.services.length, 2);
  for (const snapshot of verified.services) {
    assert.equal(snapshot.revision, revision);
    assert.deepEqual(snapshot.dirty?.files, ['src/a.ts', 'new.txt']);
    assert.equal(snapshot.dirty?.truncated, false);
    assert.ok(snapshot.pmId >= 200, 'owned pmIds are pinned');
    assert.equal(snapshot.namespace, null);
  }
  assert.deepEqual(verified.services.map(entry => entry.status), ['ready', 'ready']);
  // Surfaced through the existing readers — no new view, no timeline fork.
  const runs = await listRecentRuns(r.store.directory, r.workspaceId, 5, new Set());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, 'openworkspace-run');
  assert.equal(runs[0].environment?.envId, r.recordId);
  assert.equal(runs[0].environment?.envName, 'local');
  assert.equal(runs[0].environment?.services.length, 2);
  assert.ok(runs[0].excerptPreview.length <= 200);
  const viaService = await r.service.recentRuns(r.workspaceName, 5);
  assert.equal(viaService[0].environment?.services[0].revision, revision);
});

test('receipt oversize proof: 10 services × 10 × 256-char names serializes <64KiB with truncation forced', async t => {
  const r = await rig(t);
  const receipt = {
    envId: r.recordId,
    envName: 'n'.repeat(100),
    services: Array.from({ length: 10 }, (_, index) => ({
      serviceId: `svc-${index}`,
      name: `svc-${index}`,
      pmId: index,
      namespace: null,
      status: 'ready',
      revision,
      dirty: { diffHash: 'c'.repeat(64), files: Array.from({ length: 12 }, () => 'f'.repeat(256)), truncated: false },
    })),
  };
  const capped = capEnvironmentReceipt(receipt);
  assert.ok(capped);
  assert.equal(capped.services.length, 10);
  assert.ok(capped.services.every(entry => entry.dirty?.files.length === 10 && entry.dirty.truncated));
  const summary = await persistRunSummary(r.store.directory, {
    workspaceId: r.workspaceId,
    scriptName: 'check',
    outcome: 'passed',
    durationMs: 9,
    output: 'ok\n',
    outputTruncated: false,
    environment: receipt,
  }, r.store);
  const stored = await readFile(join(r.store.directory, 'runs', r.workspaceId, `${summary.id}.json`), 'utf8');
  assert.ok(Buffer.byteLength(stored, 'utf8') < 64 * 1024, `receipt file stays in budget, got ${Buffer.byteLength(stored, 'utf8')}`);
  assert.equal(JSON.parse(stored).environment.services.length, 10);

  // Defensive caps: wide callers are sliced, never fail the persist.
  const wide = capEnvironmentReceipt({
    envId: 'x',
    envName: 'y'.repeat(500),
    services: Array.from({ length: 12 }, (_, index) => ({
      serviceId: `s${index}`, name: `s${index}`, pmId: index, namespace: null, status: 'ready',
      revision: 'not-a-sha',
      dirty: { diffHash: 'd'.repeat(64), files: Array.from({ length: 15 }, (_, file) => `file-${file}`), truncated: false },
    })),
  });
  assert.ok(wide);
  assert.equal(wide.services.length, 10);
  assert.ok(wide.services.every(entry => entry.dirty?.files.length === 10 && entry.dirty.truncated));
  assert.ok(wide.services.every(entry => entry.revision === null), 'non-hex revisions degrade to null');
  assert.equal(wide.envName.length, 100);
  assert.equal(capEnvironmentReceipt(null), null);
});

test('verify refuses unknown environments, repos and scripts with allowlisted errors', async t => {
  const r = await rig(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [] });
  await assert.rejects(
    environmentVerify(r.store, r.workspaceName, { environment: 'Missing env', repositoryPath: r.backend, scriptName: 'check' }, { list }),
    /Environment not found/,
  );
  await assert.rejects(
    environmentVerify(r.store, r.workspaceName, { environment: r.recordName, repositoryPath: r.backend, scriptName: 'nope' }, { list }),
    /no runnable test script/,
  );
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-env-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, 'repo'), { recursive: true });
  await writeFile(join(outside, 'repo', 'package.json'), JSON.stringify({ scripts: { check: 'node x.js' } }));
  await assert.rejects(
    environmentVerify(r.store, r.workspaceName, { environment: r.recordName, repositoryPath: join(outside, 'repo'), scriptName: 'check' }, { list }),
    /not inside/,
  );
});

test('secret blindness: excerpts are masked, orchestration reads no env files or process env', async t => {
  const r = await rig(t);
  const summary = await persistRunSummary(r.store.directory, {
    workspaceId: r.workspaceId,
    scriptName: 'check',
    outcome: 'failed',
    durationMs: 3,
    output: 'password=supersecret email hunter@example.com Bearer abcdefgh1234\nnot ok 1 boom\n',
    outputTruncated: false,
    environment: {
      envId: r.recordId,
      envName: 'local',
      services: [{
        serviceId: 'backend', name: 'backend', pmId: 3, namespace: null, status: 'ready',
        revision, dirty: { diffHash: 'd'.repeat(64), files: ['a.ts'], truncated: false },
      }],
    },
  }, r.store);
  assert.match(summary.failureExcerpt, /\*\*\*/);
  assert.ok(!summary.failureExcerpt.includes('supersecret'));
  assert.ok(!summary.failureExcerpt.includes('hunter@example.com'));
  const environmentSource = readFileSync(new URL('../src/environment.ts', import.meta.url), 'utf8');
  assert.ok(!/process\.env/.test(environmentSource), 'orchestration never reads process env (only injected runners carry bounded env)');
  assert.ok(!/\.env\b/.test(environmentSource), 'orchestration never touches dotenv files');
});
