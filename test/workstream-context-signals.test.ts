import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import {
  buildGoldenLine,
  detourChainMinutes,
  detourFailCount,
  detourFailWindow,
  detourLeaseMinutes,
  evaluateDetourSignal,
  evaluateGoldenSignal,
} from '../src/signals.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

async function approvedFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Signal project', [project]);
  const workstream = await service.createWorkstream({
    name: 'Stream', workspace: workspace.name, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

interface SeedRunOptions {
  ts: number;
  suffix: string;
  outcome?: 'passed' | 'failed' | 'error';
  durationMs?: number;
  scriptName?: string;
  source?: 'openworkspace-run' | 'external-import';
  envName?: string | null;
  excerpt?: string;
  failingNames?: string[];
}

async function seedRun(storeDir: string, workspaceId: string, opts: SeedRunOptions): Promise<void> {
  const dir = join(storeDir, 'runs', workspaceId);
  await mkdir(dir, { recursive: true });
  const id = `${String(opts.ts).padStart(13, '0')}-${opts.suffix}`;
  const summary = {
    id,
    workspaceId,
    scriptName: opts.scriptName ?? 'test',
    outcome: opts.outcome ?? 'passed',
    durationMs: opts.durationMs ?? 100,
    at: new Date(opts.ts).toISOString(),
    failingNames: opts.failingNames ?? [],
    failingTruncated: false,
    failureExcerpt: opts.excerpt ?? 'ok',
    excerptTruncated: false,
    outputTruncated: false,
    source: opts.source ?? 'openworkspace-run',
    revision: null,
    dirty: null,
    environment: opts.envName ? { envId: 'env-1', envName: opts.envName, services: [] } : null,
  };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(summary), { mode: 0o600 });
}

// ---- Pure golden predicate ----

test('golden fires at exactly half the median with five priors', () => {
  assert.deepEqual(
    evaluateGoldenSignal([100, 200, 200, 200, 200, 200]),
    { durationMs: 100, medianMs: 200 },
  );
});

test('golden stays silent with four priors or above half the median', () => {
  assert.equal(evaluateGoldenSignal([100, 200, 200, 200, 200]), undefined);
  assert.equal(evaluateGoldenSignal([101, 200, 200, 200, 200, 200]), undefined);
  assert.equal(evaluateGoldenSignal([]), undefined);
  assert.equal(evaluateGoldenSignal([0, 0, 0, 0, 0, 0]), undefined);
  assert.equal(evaluateGoldenSignal([100, 200, 200, 200, 200, Number.NaN]), undefined);
});

test('golden examines a bounded newest-first window', () => {
  assert.deepEqual(
    evaluateGoldenSignal([100, ...Array(24).fill(200)]),
    { durationMs: 100, medianMs: 200 },
  );
});

test('golden line names the script, span and environment label', () => {
  assert.equal(buildGoldenLine({ scriptName: 'test', durationMs: 9000, envName: 'dev' }), 'Last time test took ~9s (dev).');
  assert.equal(buildGoldenLine({ scriptName: 'test', durationMs: 9000, envName: null }), 'Last time test took ~9s.');
});

// ---- Pure detour triggers ----

test('detour chain trigger fires at twenty minutes and stays silent below', () => {
  const minute = 60_000;
  const firing = evaluateDetourSignal({ chainMs: 22 * minute, recentFails: 0, leaseWaitMs: null });
  assert.ok(firing?.includes('~22 min'), 'chain line quotes the span');
  assert.equal(evaluateDetourSignal({ chainMs: 19 * minute, recentFails: 0, leaseWaitMs: null }), undefined);
  assert.equal(evaluateDetourSignal({ chainMs: null, recentFails: 0, leaseWaitMs: null }), undefined);
  assert.equal(detourChainMinutes, 20);
});

test('detour fail trigger fires at three in twenty and stays silent at two', () => {
  const firing = evaluateDetourSignal({ chainMs: null, recentFails: 3, leaseWaitMs: null });
  assert.ok(firing?.includes(`3 of the last ${detourFailWindow}`), 'fail line quotes the count');
  assert.equal(evaluateDetourSignal({ chainMs: null, recentFails: 2, leaseWaitMs: null }), undefined);
  assert.equal(detourFailCount, 3);
});

test('detour lease trigger fires at eleven queued minutes and stays silent at nine', () => {
  const minute = 60_000;
  const firing = evaluateDetourSignal({ chainMs: null, recentFails: 0, leaseWaitMs: 11 * minute });
  assert.ok(firing?.includes('~11 min'), 'lease line quotes the wait');
  assert.equal(evaluateDetourSignal({ chainMs: null, recentFails: 0, leaseWaitMs: 9 * minute }), undefined);
  assert.equal(detourLeaseMinutes, 10);
});

test('detour first firing wins in chain, fails, lease order and fails closed', () => {
  const minute = 60_000;
  const all = evaluateDetourSignal({ chainMs: 25 * minute, recentFails: 5, leaseWaitMs: 15 * minute });
  assert.ok(all?.includes('Setup in this workspace'), 'chain wins over fails and lease');
  const failsOverLease = evaluateDetourSignal({ chainMs: null, recentFails: 4, leaseWaitMs: 15 * minute });
  assert.ok(failsOverLease?.includes('of the last 20'), 'fails win over lease');
  assert.equal(evaluateDetourSignal({ chainMs: -5, recentFails: Number.NaN, leaseWaitMs: -1 }), undefined);
});

test('detour and golden lines stay within byte budgets', () => {
  const minute = 60_000;
  for (const line of [
    evaluateDetourSignal({ chainMs: 22 * minute, recentFails: 0, leaseWaitMs: null }),
    evaluateDetourSignal({ chainMs: null, recentFails: 20, leaseWaitMs: null }),
    evaluateDetourSignal({ chainMs: null, recentFails: 0, leaseWaitMs: 59 * minute }),
    buildGoldenLine({ scriptName: 'test', durationMs: 9000, envName: 'dev' }),
  ]) {
    assert.ok(line, 'line exists');
    assert.ok(Buffer.byteLength(line, 'utf8') <= 200, `line stays within 200B (got ${Buffer.byteLength(line, 'utf8')}B)`);
  }
});

// ---- No-transcript and no-blame guards on the signal module ----

test('signal module touches only allowed metadata fields and no blame wording', async () => {
  const source = await readFile(new URL('../src/signals.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /failureExcerpt|excerptPreview|failingNames|service_logs|detail/, 'no transcript/log/activity-text reads');
  assert.doesNotMatch(source, /wast|scold|slow|fault/, 'no blame language in the line builders');
});

// ---- Read-path derivation through the real workstreamContext op ----

test('goldenPath derives through workstreamContext with the env label and bounded size', async t => {
  const f = await approvedFixture('openworkspace-signals-golden-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  for (let index = 0; index < 5; index++) {
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base - (index + 1) * 1000, suffix: `p${index}`, outcome: 'passed', durationMs: 200,
    });
  }
  await seedRun(f.store.directory, f.workspace.id, {
    ts: base, suffix: 'latest', outcome: 'passed', durationMs: 100, envName: 'dev',
  });
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.deepEqual(bundle.goldenPath, {
    runId: `${String(base).padStart(13, '0')}-latest`,
    scriptName: 'test',
    envName: 'dev',
    durationMs: 100,
    medianMs: 200,
    at: new Date(base).toISOString(),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bundle.goldenPath), 'utf8') <= 300, 'goldenPath response growth stays within 300B');
  // A full-window caller reuses its own scan and reaches the same signal.
  assert.deepEqual(
    (await f.service.workstreamContext(f.workspace.name, f.workstream.name, 20)).goldenPath,
    bundle.goldenPath,
  );
});

test('signal windows reuse the exported constants in a single scan', async () => {
  const source = await readFile(new URL('../src/workspace.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('const signalLimit = Math.max(limit, goldenWindow, detourFailWindow)'),
    'one bounded fetch covers the response limit plus both signal windows',
  );
  assert.ok(source.includes('passedLocal.slice(0, goldenWindow)'), 'golden derivation uses its window constant');
  assert.ok(source.includes('.slice(0, detourFailWindow)'), 'detour derivation uses its window constant');
  assert.ok(source.includes('runs.slice(0, limit)'), 'response stays limit-scoped off the shared scan');
  assert.doesNotMatch(source, /limit >= 20/, 'no literal window comparison remains in the derivation');
  assert.doesNotMatch(source, /slice\(0, 20\)/, 'no literal window slice remains in the derivation');
});

test('goldenPath holds its 300B budget at max-length labels', async t => {
  const f = await approvedFixture('openworkspace-signals-maxlabels-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  const longScript = 's'.repeat(80);
  for (let index = 0; index < 5; index++) {
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base - (index + 1) * 1000, suffix: `p${index}`, outcome: 'passed',
      durationMs: 200, scriptName: longScript,
    });
  }
  // A 100-char receipt label exercises the derivation cap (64), not the store cap.
  await seedRun(f.store.directory, f.workspace.id, {
    ts: base, suffix: 'latest', outcome: 'passed', durationMs: 100,
    scriptName: longScript, envName: 'e'.repeat(100),
  });
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.ok(bundle.goldenPath, 'golden still fires at max-length labels');
  assert.equal(bundle.goldenPath?.scriptName.length, 80);
  assert.equal(bundle.goldenPath?.envName?.length, 64, 'env label caps at 64 for the 300B budget');
  assert.ok(
    Buffer.byteLength(JSON.stringify(bundle.goldenPath), 'utf8') <= 300,
    `max-length goldenPath stays within 300B (got ${Buffer.byteLength(JSON.stringify(bundle.goldenPath), 'utf8')}B)`,
  );
});
test('goldenPath carries a null env label without a receipt and stays silent without priors', async t => {
  const f = await approvedFixture('openworkspace-signals-golden-null-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  for (let index = 0; index < 5; index++) {
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base - (index + 1) * 1000, suffix: `p${index}`, outcome: 'passed', durationMs: 200,
    });
  }
  await seedRun(f.store.directory, f.workspace.id, { ts: base, suffix: 'latest', outcome: 'passed', durationMs: 100 });
  assert.equal((await f.service.workstreamContext(f.workspace.name, f.workstream.name)).goldenPath?.envName, null);

  const thin = await approvedFixture('openworkspace-signals-golden-thin-');
  t.after(() => rm(thin.root, { recursive: true, force: true }));
  for (let index = 0; index < 4; index++) {
    await seedRun(thin.store.directory, thin.workspace.id, {
      ts: base - (index + 1) * 1000, suffix: `p${index}`, outcome: 'passed', durationMs: 200,
    });
  }
  await seedRun(thin.store.directory, thin.workspace.id, { ts: base, suffix: 'latest', outcome: 'passed', durationMs: 100 });
  const thinBundle = await thin.service.workstreamContext(thin.workspace.name, thin.workstream.name);
  assert.equal(thinBundle.goldenPath, undefined, 'four priors stay silent');
});

test('goldenPath stays silent on an all-imports window', async t => {
  const f = await approvedFixture('openworkspace-signals-imports-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  for (let index = 0; index < 6; index++) {
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base - index * 1000, suffix: `i${index}`, outcome: 'passed',
      durationMs: index === 0 ? 10 : 200, source: 'external-import',
    });
  }
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.equal(bundle.goldenPath, undefined, 'pasted results never feed the golden reference');
  assert.equal(bundle.detourNudge, undefined, 'imports count for neither signal');
});

test('detour chain fires through workstreamContext and ignores excerpt swaps', async t => {
  async function chainFixture(prefix: string, excerpt: string, failingNames: string[]) {
    const f = await approvedFixture(prefix);
    const base = Date.now();
    await f.service.recordActivity({ actor: 'mcp', operation: 'environment-up', workspaceId: f.workspace.id, detail: 'up ok' });
    await f.store.update(state => {
      const entry = state.activity.find(item => item.operation === 'environment-up' && item.workspaceId === f.workspace.id);
      if (!entry) throw new Error('expected the up activity');
      entry.at = new Date(base - 22 * 60_000).toISOString();
      return entry;
    });
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base, suffix: 'verify', outcome: 'passed', durationMs: 100, excerpt, failingNames,
    });
    return { f, base };
  }
  const first = await chainFixture('openworkspace-signals-chain-a-', 'alpha verify output with test names', ['alpha test']);
  const second = await chainFixture('openworkspace-signals-chain-b-', 'beta entirely different output', ['beta other', 'beta another']);
  try {
    const a = await first.f.service.workstreamContext(first.f.workspace.name, first.f.workstream.name);
    const b = await second.f.service.workstreamContext(second.f.workspace.name, second.f.workstream.name);
    assert.ok(a.detourNudge?.includes('~22 min'), 'chain line quotes the setup span');
    assert.equal(a.detourNudge, b.detourNudge, 'excerpt-swapped fixtures produce the identical line: no transcript read');
    assert.ok(Buffer.byteLength(a.detourNudge ?? '', 'utf8') <= 200, 'detourNudge stays within 200B');
  } finally {
    await rm(first.f.root, { recursive: true, force: true });
    await rm(second.f.root, { recursive: true, force: true });
  }
});

test('detour fail count fires at three and stays silent at two through workstreamContext', async t => {
  const f = await approvedFixture('openworkspace-signals-fails-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  await seedRun(f.store.directory, f.workspace.id, { ts: base - 3000, suffix: 'f0', outcome: 'failed', durationMs: 50 });
  await seedRun(f.store.directory, f.workspace.id, { ts: base - 2000, suffix: 'f1', outcome: 'error', durationMs: 60 });
  await seedRun(f.store.directory, f.workspace.id, { ts: base - 1000, suffix: 'ok', outcome: 'passed', durationMs: 70 });
  assert.equal(
    (await f.service.workstreamContext(f.workspace.name, f.workstream.name)).detourNudge,
    undefined,
    'two failures stay silent',
  );
  await seedRun(f.store.directory, f.workspace.id, { ts: base, suffix: 'f2', outcome: 'failed', durationMs: 55 });
  const firing = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.ok(firing.detourNudge?.includes('3 of the last 20'), 'three failures fire the advisory line');
});

test('detour queued-lease wait fires at eleven minutes and stays silent at nine', async t => {
  async function leaseFixture(prefix: string, waitMinutes: number) {
    const f = await approvedFixture(prefix);
    const waiter = await f.service.createWorkstream({
      name: 'Waiter', workspace: f.workspace.name, checkouts: [f.project],
    });
    await f.service.acquireLease({ resource: 'test-db', workspace: f.workspace.name, workstream: f.workstream.name });
    await f.service.acquireLease({ resource: 'test-db', workspace: f.workspace.name, workstream: waiter.name });
    await f.store.update(state => {
      const lease = state.leases.find(entry => entry.workstreamId === waiter.id && entry.status === 'queued');
      if (!lease) throw new Error('expected the queued lease');
      lease.createdAt = new Date(Date.now() - waitMinutes * 60_000).toISOString();
      return lease;
    });
    return { f, waiter };
  }
  const short = await leaseFixture('openworkspace-signals-lease-short-', 9);
  try {
    assert.equal(
      (await short.f.service.workstreamContext(short.f.workspace.name, short.waiter.name)).detourNudge,
      undefined,
      'nine queued minutes stay silent',
    );
  } finally {
    await rm(short.f.root, { recursive: true, force: true });
  }
  const long = await leaseFixture('openworkspace-signals-lease-long-', 11);
  try {
    const bundle = await long.f.service.workstreamContext(long.f.workspace.name, long.waiter.name);
    assert.ok(bundle.detourNudge?.includes('~11 min'), 'eleven queued minutes fire the advisory line');
    assert.equal(bundle.goldenPath, undefined, 'lease-only fixture carries no golden reference');
  } finally {
    await rm(long.f.root, { recursive: true, force: true });
  }
});

test('corrupt run files stay silent: both fields absent and the call succeeds', async t => {
  const f = await approvedFixture('openworkspace-signals-corrupt-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = join(f.store.directory, 'runs', f.workspace.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'garbage.json'), 'not json{{{', { mode: 0o600 });
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.equal(bundle.goldenPath, undefined);
  assert.equal(bundle.detourNudge, undefined);
  assert.ok(bundle.workstreamId, 'the handoff bundle still succeeds');
});

test('golden and detour travel the HTTP context route unchanged', async t => {
  const f = await approvedFixture('openworkspace-signals-http-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const base = Date.now();
  for (let index = 0; index < 5; index++) {
    await seedRun(f.store.directory, f.workspace.id, {
      ts: base - (index + 1) * 1000 - 22 * 60_000, suffix: `p${index}`, outcome: 'passed', durationMs: 200,
    });
  }
  await f.service.recordActivity({ actor: 'mcp', operation: 'environment-up', workspaceId: f.workspace.id, detail: 'up ok' });
  await f.store.update(state => {
    const entry = state.activity.find(item => item.operation === 'environment-up' && item.workspaceId === f.workspace.id);
    if (!entry) throw new Error('expected the up activity');
    entry.at = new Date(base - 22 * 60_000).toISOString();
    return entry;
  });
  await seedRun(f.store.directory, f.workspace.id, {
    ts: base, suffix: 'latest', outcome: 'passed', durationMs: 100, envName: 'dev',
  });
  const bundle = await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.ok(bundle.goldenPath, 'golden fires in the walkthrough fixture');
  assert.ok(bundle.detourNudge, 'detour fires in the walkthrough fixture');
  const app = createApp(f.service, { mcpToken: 'b'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const overHttp = await (await fetch(
    `${origin}/api/workstreams/${encodeURIComponent(f.workspace.name)}/${encodeURIComponent(f.workstream.name)}/context`,
    { headers: { Authorization: `Bearer ${app.mcpToken}` } },
  )).json() as typeof bundle;
  assert.deepEqual(overHttp.goldenPath, bundle.goldenPath, 'goldenPath travels HTTP unchanged');
  assert.equal(overHttp.detourNudge, bundle.detourNudge, 'detourNudge travels HTTP unchanged');
});
