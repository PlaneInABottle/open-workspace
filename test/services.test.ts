import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { controlPm2Service, inspectPm2Services, readPm2ServiceLogs, runPm2Logs, serviceInventory, type Pm2ListResult, type Pm2Process, type ServiceLogStream } from '../src/services.js';

async function approvedProject(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-services-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const inner = join(project, 'api');
  const outside = join(root, 'other');
  await mkdir(inner, { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, 'package.json'), '{}');
  await writeFile(join(outside, 'package.json'), '{}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, project, inner, outside, store };
}

function process(cwd: string, name = 'api'): Pm2Process {
  return { pmId: 1, name, namespace: 'default', status: 'online', cwd, restartCount: 2, startedAt: null };
}

test('PM2 service metadata is scoped to registered project roots only', async t => {
  const f = await approvedProject(t);
  const service = new WorkspaceService(f.store, async () => ({ available: true, processes: [process(f.inner), process(f.outside, 'outside')] }), undefined, undefined, undefined, undefined, async () => ({ available: true, containers: [] }));
  const approved = await service.register('Project', [f.project]);
  const inventory = await service.services(approved.name);
  assert.equal(inventory.available, true);
  assert.equal(inventory.processCount, 2);
  assert.equal(inventory.matchedProcessCount, 1);
  assert.equal(inventory.unmatchedProcessCount, 1);
  assert.equal(inventory.services[0].cwd, f.inner);
  assert.equal(inventory.services[0].matchedRoots[0], approved.roots[0]);
  assert.equal(inventory.services[0].exactRootPath, approved.roots[0]);
  assert.equal(inventory.ambiguousServices.length, 0);
  assert.ok(!JSON.stringify(inventory).includes(f.outside));
});

test('nested registered roots produce an explicit ambiguous service rather than a fake match', async () => {
  const processPath = await mkdtemp(join(tmpdir(), 'openworkspace-services-ambiguous-'));
  try {
    const parent = await realpath(processPath);
    const child = join(parent, 'service');
    await mkdir(child);
    const mapped = await inspectPm2Services([parent, child], [process(child)]);
    assert.equal(mapped.services.length, 0);
    assert.equal(mapped.ambiguousServices.length, 1);
    assert.equal(mapped.ambiguousServices[0].exactRootPath, null);
    assert.deepEqual(mapped.ambiguousServices[0].matchedRoots, [parent, child]);
    assert.equal(mapped.unmatchedProcessCount, 0);
  } finally {
    await rm(processPath, { recursive: true, force: true });
  }
});

async function serviceWithState(store: Store, root: string) {
  const service = new WorkspaceService(store, async (): Promise<Pm2ListResult> => ({ available: true, processes: [] }));
  const approved = await service.register('Project', [root]);
  return approved;
}

test('service control refuses ambiguous nested roots even with a matching process id', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-services-control-')));
  try {
    const child = join(parent, 'service');
    await mkdir(child);
    let runnerCalls = 0;
    const result = await controlPm2Service([parent, child], 'restart', { pmId: 1, name: 'api', namespace: 'default' }, async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(child)] }), async () => {
      runnerCalls += 1;
      return { ok: true };
    });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /not uniquely mapped/);
    assert.equal(runnerCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('controlPm2Service rejects a namespace mismatch without invoking PM2', async t => {
  const f = await approvedProject(t);
  let runnerCalls = 0;
  const result = await controlPm2Service([f.project], 'restart', { pmId: 1, name: 'api', namespace: 'other' }, async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] }), async () => {
    runnerCalls += 1;
    return { ok: true };
  });
  assert.equal(result.status, 'failed');
  assert.equal(runnerCalls, 0);
});

test('service inspection reports missing PM2 as unavailable without claiming a service state', async t => {
  const inventory = await serviceInventory(['/tmp'], async () => ({ available: false, error: 'missing' }));
  assert.equal(inventory.available, false);
  assert.equal(inventory.error, 'missing');
  assert.equal(inventory.services.length, 0);
  assert.equal(inventory.processCount, 0);
});

test('service logs return a bounded tail only for an exactly mapped process', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });
  const calls: Array<{ pmId: number; stream: ServiceLogStream; lines: number }> = [];
  const logs = async (roots: string[], target: { pmId: number | null; name: string; namespace?: string | null }, options: { lines?: number; stream?: ServiceLogStream } = {}) =>
    readPm2ServiceLogs(roots, target, {
      ...options,
      list,
      runner: async (pmId, stream, lines) => {
        calls.push({ pmId, stream, lines });
        return { ok: true, output: 'first line\nsecond line', truncated: false };
      },
    });

  const result = await logs([f.project], { pmId: 1, name: 'api', namespace: 'default' });
  assert.deepEqual(calls, [{ pmId: 1, stream: 'both', lines: 100 }]);
  assert.equal(result.linesRequested, 100);
  assert.equal(result.linesReturned, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.output, 'first line\nsecond line');
  assert.match(result.message, /bounded log tail/);

  const errOnly = await logs([f.project], { pmId: 1, name: 'api' }, { lines: 10, stream: 'err' });
  assert.deepEqual(calls[1], { pmId: 1, stream: 'err', lines: 10 });
  assert.equal(errOnly.linesRequested, 10);
  assert.equal(errOnly.stream, 'err');
});

test('service logs deny unmapped, renamed, anonymous and namespace-mismatched targets', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner), process(f.outside, 'outside')] });
  let runnerCalls = 0;
  const logs = (roots: string[], target: { pmId: number | null; name: string; namespace?: string | null }) =>
    readPm2ServiceLogs(roots, target, {
      list,
      runner: async () => {
        runnerCalls += 1;
        return { ok: true, output: 'x', truncated: false };
      },
    });

  assert.match((await logs([f.project], { pmId: 1, name: 'outside', namespace: 'default' })).message, /not uniquely mapped/);
  assert.match((await logs([f.project], { pmId: 99, name: 'api', namespace: 'default' })).message, /not uniquely mapped/);
  assert.match((await logs([f.project], { pmId: null, name: 'api' })).message, /identity is unavailable/);
  assert.match((await logs([f.project], { pmId: 1, name: 'api', namespace: 'other' })).message, /identity changed/);
  assert.equal(runnerCalls, 0);
});

test('service logs deny ambiguous nested roots even with a matching process id', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-services-logs-')));
  try {
    const child = join(parent, 'service');
    await mkdir(child);
    let runnerCalls = 0;
    const result = await readPm2ServiceLogs([parent, child], { pmId: 1, name: 'api', namespace: 'default' }, {
      list: async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(child)] }),
      runner: async () => {
        runnerCalls += 1;
        return { ok: true, output: 'x', truncated: false };
      },
    });
    assert.match(result.message, /not uniquely mapped/);
    assert.equal(runnerCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('service logs enforce the line budget and report truncation and empty output honestly', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });
  let runnerCalls = 0;
  const target = { pmId: 1, name: 'api', namespace: 'default' };

  for (const lines of [0, 201, 1000]) {
    const denied = await readPm2ServiceLogs([f.project], target, {
      lines, list, runner: async () => {
        runnerCalls += 1;
        return { ok: true, output: 'x', truncated: false };
      },
    });
    assert.match(denied.message, /between 1 and 200/);
    assert.equal(denied.linesReturned, 0);
  }
  const badStream = await readPm2ServiceLogs([f.project], target, {
    stream: 'follow' as ServiceLogStream, list, runner: async () => ({ ok: true, output: 'x', truncated: false }),
  });
  assert.match(badStream.message, /out, err or combined/);
  assert.equal(runnerCalls, 0);

  const truncated = await readPm2ServiceLogs([f.project], target, {
    list, runner: async () => ({ ok: true, output: 'kept prefix', truncated: true }),
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.output, 'kept prefix');
  assert.equal(truncated.linesReturned, 1);

  const empty = await readPm2ServiceLogs([f.project], target, {
    list, runner: async () => ({ ok: true, output: '', truncated: false }),
  });
  assert.equal(empty.linesReturned, 0);
  assert.match(empty.message, /no log output/);
});

test('service logs report PM2 and runner failures without claiming output', async t => {
  const f = await approvedProject(t);
  const target = { pmId: 1, name: 'api', namespace: 'default' };
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });

  const missing = await readPm2ServiceLogs([f.project], target, { list: async () => ({ available: false, error: 'missing' }) });
  assert.match(missing.message, /could not be read before the log tail/);

  const unavailable = await readPm2ServiceLogs([f.project], target, { list, runner: async () => ({ ok: false, error: 'missing' }) });
  assert.match(unavailable.message, /PM2 is unavailable/);

  const timedOut = await readPm2ServiceLogs([f.project], target, { list, runner: async () => ({ ok: false, error: 'timeout' }) });
  assert.match(timedOut.message, /bounded runtime/);

  const failed = await readPm2ServiceLogs([f.project], target, { list, runner: async () => ({ ok: false, error: 'failed' }) });
  assert.match(failed.message, /did not complete/);
  for (const result of [missing, unavailable, timedOut, failed]) {
    assert.equal(result.output, '');
    assert.equal(result.linesReturned, 0);
  }
});

// Real pm2 --nostream output wraps records in ANSI-colored CLI chrome: a
// [TAILING] banner, one "<abs path> last N lines:" header per tailed file and
// a "<pmId>|<name> | " prefix per record line. The fixture below reproduces
// that shape (ANSI + banner + headers + prefixes) without spawning pm2.
function pm2Raw(banner: string, sections: Array<{ file: string; records: string[] }>): string {
  const lines = [`\x1b[1m\x1b[90m${banner}\x1b[39m\x1b[22m`];
  for (const section of sections) {
    lines.push(`\x1b[90m${section.file} last 5 lines:\x1b[39m`);
    for (const record of section.records) lines.push(record);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

test('service logs strip pm2 CLI chrome and return only genuine records', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });
  const raw = pm2Raw('[TAILING] Tailing last 5 lines for [api] process (change the value with --lines option)', [
    { file: '/Users/test/.pm2/logs/api-error.log', records: ['\x1b[31m1|api | \x1b[39mboom'] },
    { file: '/Users/test/.pm2/logs/api-out.log', records: ['\x1b[32m1|api | \x1b[39mfirst', '\x1b[32m1|api | \x1b[39m\x1b[33mcolored\x1b[39m record', '9|other | lookalike prefix survives'] },
  ]);
  const result = await readPm2ServiceLogs([f.project], { pmId: 1, name: 'api', namespace: 'default' }, {
    list, runner: async () => ({ ok: true, output: raw, truncated: false }),
  });
  assert.equal(result.output, 'boom\nfirst\ncolored record\n9|other | lookalike prefix survives');
  assert.equal(result.linesReturned, 4);
  assert.match(result.message, /bounded log tail/);
  assert.ok(!result.output.includes('.pm2/logs'), 'absolute PM2 log paths must not leak into log text');
  assert.ok(!result.output.includes('[TAILING]'), 'the tailing banner must not leak into log text');
  assert.ok(!result.output.includes('\x1b'), 'ANSI color codes must not leak into log text');
});

test('service logs accept pm2 truncation of long process names in record prefixes', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [{ ...process(f.inner), pmId: 4, name: 'verylong-service-name' }] });
  // Observed real-path shape: pm2 prints only the first 8 name characters.
  const raw = '\x1b[32m4|verylong | \x1b[39mkept\n4|other-id | foreign pmId survives';
  const result = await readPm2ServiceLogs([f.project], { pmId: 4, name: 'verylong-service-name' }, {
    list, runner: async () => ({ ok: true, output: raw, truncated: false }),
  });
  assert.equal(result.output, 'kept\n4|other-id | foreign pmId survives');
  assert.equal(result.linesReturned, 2);
});

test('service logs report chrome-only pm2 output as an empty tail', async t => {
  const f = await approvedProject(t);
  const list = async (): Promise<Pm2ListResult> => ({ available: true, processes: [process(f.inner)] });
  const raw = pm2Raw('[TAILING] Tailing last 5 lines for [api] process (change the value with --lines option)', [
    { file: '/Users/test/.pm2/logs/api-error.log', records: [] },
  ]);
  const result = await readPm2ServiceLogs([f.project], { pmId: 1, name: 'api' }, {
    list, runner: async () => ({ ok: true, output: raw, truncated: false }),
  });
  assert.equal(result.output, '');
  assert.equal(result.linesReturned, 0);
  assert.match(result.message, /no log output/);
});

function fakeSpawn(argsSeen: string[][], chunks: Buffer[], code: number): typeof spawn {
  const fake = (_command: string, args: string[] = []) => {
    argsSeen.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.emit('data', chunk);
      child.emit('close', code);
    });
    return child as never;
  };
  return fake as unknown as typeof spawn;
}

test('runPm2Logs uses a bounded nostream argv without follow and passes small output through', async () => {
  const argsSeen: string[][] = [];
  const result = await runPm2Logs(3, 'err', 25, { spawn: fakeSpawn(argsSeen, [Buffer.from('line one\nline two\n')], 0) });
  assert.deepEqual(argsSeen, [['logs', '3', '--nostream', '--lines', '25', '--err']]);
  assert.ok(!argsSeen[0].some(arg => /follow|tail/i.test(arg)), 'log reads never stream or follow');
  assert.deepEqual(result, { ok: true, output: 'line one\nline two', truncated: false });
});

test('runPm2Logs retains the newest bytes when the tail exceeds 64 KiB', async () => {
  const oldest = Buffer.from(`${'old-record\n'.repeat(4000)}`);
  const newest = Buffer.from('newest-record-marker\n');
  const padding = Buffer.alloc(70 * 1024 - oldest.length - newest.length, 'x');
  const argsSeen: string[][] = [];
  const result = await runPm2Logs(3, 'both', 200, { spawn: fakeSpawn(argsSeen, [oldest, padding, newest], 0) });
  assert.deepEqual(argsSeen, [['logs', '3', '--nostream', '--lines', '200']]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= 64 * 1024, 'kept window stays within the byte cap');
    assert.ok(result.output.endsWith('newest-record-marker'), 'the newest records survive truncation');
    assert.ok(!result.output.startsWith('old-record'), 'the oldest records are dropped first');
  }
});
