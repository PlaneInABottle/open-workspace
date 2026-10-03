import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

const templatePath = fileURLToPath(new URL('../scripts/agent-browser-shim.sh', import.meta.url));
const installerPath = fileURLToPath(new URL('../scripts/install-browser-shim.sh', import.meta.url));
const FAKE_VERSION = 'agent-browser 9.99-shimtest';

const fakeSource = `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' "\${FAKE_VERSION:-${FAKE_VERSION}}"; exit 0; fi
if [ "\${FAKE_MAKE_ARTIFACT:-}" = "1" ]; then umask >"\${FAKE_ARTIFACT}.umask"; printf data >"$FAKE_ARTIFACT"; fi
if [ -n "\${FAKE_SLEEP:-}" ]; then printf '%s' "$$" >"$FAKE_PIDFILE"; sleep "$FAKE_SLEEP"; exit 0; fi
if [ "\${FAKE_SIGNAL:-}" = "TERM" ]; then kill -TERM $$; exit 1; fi
if [ -n "\${FAKE_EXIT:-}" ]; then printf 'fake-out\\n'; printf 'fake-err tag=%s\\n' "\${FAKE_TAG:-x}" >&2; exit "$FAKE_EXIT"; fi
printf 'FAKE-ARGV:'
for a in "$@"; do printf ' <%s>' "$a"; done
printf '\\n'
printf 'BIN:\\000\\377\\376END\\n'
printf 'EBIN:\\000\\376\\377END\\n' >&2
if [ -n "\${FAKE_FILL_BYTES:-}" ]; then head -c "$FAKE_FILL_BYTES" /dev/zero | LC_ALL=C tr '\\000' 'x'; printf '\\n'; fi
cat
exit 0
`;

interface Fixture {
  root: string;
  fake: string;
  shim: string;
  logdir: string;
}

async function fixture(pinned = FAKE_VERSION, owner?: string, real?: string): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ow-bshim-')));
  const fake = join(root, 'real-agent-browser');
  await writeFile(fake, fakeSource, { mode: 0o755 });
  await chmod(fake, 0o755);
  const resolvedOwner = owner ?? userInfo().username;
  const template = await readFile(templatePath, 'utf8');
  const rendered = template
    .replaceAll('__OW_SHIM_REAL_BIN__', real ?? fake)
    .replaceAll('__OW_SHIM_PINNED_VERSION__', pinned)
    .replaceAll('__OW_SHIM_REAL_OWNER__', resolvedOwner);
  const shim = join(root, 'shim-agent-browser');
  await writeFile(shim, rendered, { mode: 0o755 });
  await chmod(shim, 0o755);
  return { root, fake, shim, logdir: join(root, 'logs') };
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENWORKSPACE_SESSION;
  delete env.OW_AGENT_BROWSER_REAL;
  delete env.OW_BROWSER_SHIM_CAPTURE;
  delete env.OPENWORKSPACE_HOME;
  delete env.OW_BROWSER_SHIM_LOG_DIR;
  return { ...env, ...extra };
}

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runShim(shim: string, args: string[], env: NodeJS.ProcessEnv, stdin?: Buffer): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shim, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk as Buffer));
    child.stderr.on('data', chunk => err.push(chunk as Buffer));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function logLines(logdir: string, file = 'agent-browser-observations.jsonl'): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(logdir, file), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true });
}

test('metadata-only default: byte-identical passthrough, log carries no values', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const token = `ghp_${'A'.repeat(36)}`;
  const args = ['open', 'https://user:s3cret@example.com:8443/app/path?q=1#frag', '--session', 'ow-sess1',
    'fill', 'input[name=q]', 'topsecret-value', 'type', '@e2', 'hunter2', '--password', 'pw123', token];
  const stdin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, ...Buffer.from('hello-stdin\n')]);
  const result = await runShim(f.shim, args, cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }), stdin);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  const expectedArgv = `FAKE-ARGV:${args.map(a => ` <${a}>`).join('')}\n`;
  const expected = Buffer.concat([
    Buffer.from(expectedArgv, 'utf8'),
    Buffer.from([0x42, 0x49, 0x4e, 0x3a, 0x00, 0xff, 0xfe, 0x45, 0x4e, 0x44, 0x0a]),
    stdin,
  ]);
  assert.deepEqual(result.stdout, expected);
  assert.deepEqual(result.stderr, Buffer.from([0x45, 0x42, 0x49, 0x4e, 0x3a, 0x00, 0xfe, 0xff, 0x45, 0x4e, 0x44, 0x0a]));
  const entries = await logLines(f.logdir);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.type, 'observation');
  assert.equal(entry.action, 'open');
  assert.deepEqual(entry.flags, ['--session', '--password']);
  assert.equal(entry.targetHost, 'example.com');
  assert.equal(entry.session, 'ow-sess1');
  assert.equal(entry.mode, 'metadata');
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.outcome, 'ok');
  assert.ok(typeof entry.durationMs === 'number' && (entry.durationMs as number) >= 0);
  assert.ok(!('argv' in entry) && !('stdoutExcerpt' in entry) && !('output' in entry));
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  for (const secret of ['s3cret', 'topsecret-value', 'hunter2', 'pw123', token, 'user:', '/app/path', 'q=1', '#frag', 'input[name=q]', '@e2']) {
    assert.ok(!raw.includes(secret), `log must not contain ${secret}`);
  }
  assert.ok(raw.includes('example.com'));
});

test('unknown first positional and flag =values are never logged by value', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const result = await runShim(f.shim, ['supersecretdata', '--format=json', '--token=abc123', '--session=ow-s2', 'snapshot'],
    cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(result.code, 0);
  const entries = await logLines(f.logdir);
  assert.equal(entries[0].action, 'unknown');
  assert.deepEqual(entries[0].flags, ['--format', '--token', '--session']);
  assert.equal(entries[0].session, 'ow-s2');
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  for (const secret of ['supersecretdata', 'abc123']) {
    assert.ok(!raw.includes(secret), `log must not contain ${secret}`);
  }
});

test('env session tags the entry; capture stays off by default even for batch', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const result = await runShim(f.shim, ['batch', '--json'], cleanEnv({
    OW_BROWSER_SHIM_LOG_DIR: f.logdir,
    OPENWORKSPACE_SESSION: 'env-sess-1',
    FAKE_FILL_BYTES: '200000',
  }));
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length > 200000, 'big piped output streams fully');
  const entries = await logLines(f.logdir);
  assert.equal(entries[0].session, 'env-sess-1');
  assert.equal(entries[0].mode, 'metadata');
  await assert.rejects(readFile(join(f.logdir, 'agent-browser-captures.jsonl')));
});

test('opt-in capture writes bounded excerpts to the short-retention file', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const result = await runShim(f.shim, ['batch', '--json'], cleanEnv({
    OW_BROWSER_SHIM_LOG_DIR: f.logdir,
    OW_BROWSER_SHIM_CAPTURE: '1',
    FAKE_FILL_BYTES: '200000',
  }));
  assert.equal(result.code, 0);
  const argvLine = 'FAKE-ARGV: <batch> <--json>\n';
  const expectedStdout = argvLine.length + 'BIN:\0\xff\xfeEND\n'.length + 200000 + 1;
  assert.equal(result.stdout.length, expectedStdout);
  const observations = await logLines(f.logdir);
  assert.equal(observations[0].mode, 'capture');
  assert.ok(!('stdoutExcerpt' in observations[0]), 'observations stay metadata-only');
  const capRaw = await readFile(join(f.logdir, 'agent-browser-captures.jsonl'), 'latin1');
  const captures = capRaw.trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].type, 'capture');
  assert.equal(captures[0].stdoutBytes, expectedStdout);
  assert.equal(captures[0].stdoutTruncated, true);
  // Excerpt is the 64KiB raw prefix with C0 controls (except \t\n\r)
  // stripped and newlines JSON-escaped; decode must match that transform.
  const rawPrefix = [...result.stdout.subarray(0, 65536)]
    .filter(byte => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f));
  assert.equal(JSON.parse(`"${captures[0].stdoutExcerpt as string}"`), Buffer.from(rawPrefix).toString('latin1'));
});

test('exit codes and outcome classes pass through the supervisor', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const failed = await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, FAKE_EXIT: '42', FAKE_TAG: 't1' }));
  assert.equal(failed.code, 42);
  assert.equal(failed.stdout.toString(), 'fake-out\n');
  assert.equal(failed.stderr.toString(), 'fake-err tag=t1\n');
  const entries = await logLines(f.logdir);
  assert.equal(entries[0].exitCode, 42);
  assert.equal(entries[0].outcome, 'error');
});

test('child killed by a signal is observed as signal death, not just 128+N', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const result = await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, FAKE_SIGNAL: 'TERM' }));
  assert.equal(result.signal, 'SIGTERM');
  const entries = await logLines(f.logdir);
  assert.equal(entries[0].outcome, 'signal-15');
  assert.equal(entries[0].exitCode, 143);
});

test('unwritable log never stalls the call; drops are counted and reported', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  await mkdir(f.logdir, { recursive: true });
  await mkdir(join(f.logdir, 'agent-browser-observations.jsonl'));
  const blocked = await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(blocked.code, 0);
  assert.ok(blocked.stdout.includes('FAKE-ARGV:'), 'stdout still streams');
  assert.ok(blocked.stderr.includes('EBIN:'), 'stderr separation kept');
  assert.equal(await readFile(join(f.logdir, '.dropped-count'), 'utf8'), '1');
  await rmdir(join(f.logdir, 'agent-browser-observations.jsonl'));
  const recovered = await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(recovered.code, 0);
  const entries = await logLines(f.logdir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].dropped, 1);
  await assert.rejects(stat(join(f.logdir, '.dropped-count')));
});

test('missing pinned binary fails loudly with no PATH fallback', async t => {
  const f = await fixture(FAKE_VERSION, userInfo().username, '/nonexistent/ow-pinned-agent-browser');
  t.after(() => cleanup(f.root));
  const decoyDir = join(f.root, 'decoy');
  await mkdir(decoyDir);
  const marker = join(f.root, 'decoy-ran');
  await writeFile(join(decoyDir, 'agent-browser'), `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`, { mode: 0o755 });
  const result = await runShim(f.shim, ['snapshot'], cleanEnv({
    OW_BROWSER_SHIM_LOG_DIR: f.logdir,
    PATH: `${decoyDir}:/usr/bin:/bin`,
  }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString(), /Refusing to fall back/);
  assert.match(result.stderr.toString(), /install-browser-shim/);
  await assert.rejects(stat(marker), 'PATH decoy must never run');
});

test('world-writable and owner-changed pins fail loudly', async t => {
  const writable = await fixture();
  t.after(() => cleanup(writable.root));
  await chmod(writable.fake, 0o777);
  const refused = await runShim(writable.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: writable.logdir }));
  assert.equal(refused.code, 127);
  assert.match(refused.stderr.toString(), /world-writable/);
  const moved = await fixture(FAKE_VERSION, 'no-such-owner-xyz');
  t.after(() => cleanup(moved.root));
  const changed = await runShim(moved.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: moved.logdir }));
  assert.equal(changed.code, 127);
  assert.match(changed.stderr.toString(), /owner changed/);
});

test('version drift warns to the log only, once per day', async t => {
  const f = await fixture('agent-browser 0.0-old');
  t.after(() => cleanup(f.root));
  const first = await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(first.code, 0);
  assert.deepEqual(first.stderr, Buffer.from([0x45, 0x42, 0x49, 0x4e, 0x3a, 0x00, 0xfe, 0xff, 0x45, 0x4e, 0x44, 0x0a]));
  const lines = (await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8')).trim().split('\n');
  const drift = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(e => e.type === 'version-drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].pinned, 'agent-browser 0.0-old');
  assert.equal(drift[0].observed, FAKE_VERSION);
  await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  const again = (await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>).filter(e => e.type === 'version-drift');
  assert.equal(again.length, 1);
});

test('rotation caps the owned log', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  await mkdir(f.logdir, { recursive: true });
  const filler = `{"type":"observation","ts":"2020-01-01T00:00:00Z","pad":"${'p'.repeat(780)}"}\n`;
  const repeats = Math.ceil(1_250_000 / filler.length);
  await writeFile(join(f.logdir, 'agent-browser-observations.jsonl'), filler.repeat(repeats));
  const before = (await stat(join(f.logdir, 'agent-browser-observations.jsonl'))).size;
  assert.ok(before > 1_048_576);
  const result = await runShim(f.shim, ['snapshot', 'probe-rotation'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(result.code, 0);
  const entries = await logLines(f.logdir);
  assert.ok(entries.length <= 1000, `lines capped, got ${entries.length}`);
  assert.ok((await stat(join(f.logdir, 'agent-browser-observations.jsonl'))).size <= 1_048_576);
  assert.equal(entries[entries.length - 1].action, 'snapshot');
});

test('host extractor cuts at first / ? or # after userinfo strip', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const vectors: Array<[string, string, string[]]> = [
    ['https://host?token=SECRET', 'host', ['token=SECRET']],
    ['https://host#frag', 'host', ['#frag']],
    ['https://user:pass@host?x', 'host', ['user:pass', '?x']],
    ['https://user:pw@example.com:8080/a?b=c#d', 'example.com', ['user:pw', '/a', '?b=c', '#d']],
  ];
  for (const [url, host, leaks] of vectors) {
    await runShim(f.shim, ['open', url], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  }
  const entries = await logLines(f.logdir);
  assert.equal(entries.length, vectors.length);
  entries.forEach((entry, i) => assert.equal(entry.targetHost, vectors[i][1], vectors[i][0]));
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  for (const [, , leaks] of vectors) {
    for (const leak of leaks) assert.ok(!raw.includes(leak), `log must not contain ${leak}`);
  }
});

test('single-dash values are stripped; attached values on s/d/p masked', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const result = await runShim(f.shim, ['snapshot', '-s=#password-field', '-d2', '-vq'],
    cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  assert.equal(result.code, 0);
  const entries = await logLines(f.logdir);
  assert.deepEqual(entries[0].flags, ['-s', '-d', '-vq']);
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  for (const leak of ['#password-field', '-s=#password-field', '-d2']) {
    assert.ok(!raw.includes(leak), `log must not contain ${leak}`);
  }
});

test('real verb vocabulary is recorded; values stay dropped', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const cases: Array<[string[], string]> = [
    [['get', 'url'], 'get'],
    [['find', 'role', 'submit', 'click'], 'find'],
    [['set', 'viewport', '800', '600'], 'set'],
    [['tab', 'list'], 'tab'],
    [['auth', 'list'], 'auth'],
    [['cookies', 'get'], 'cookies'],
    [['network', 'requests'], 'network'],
  ];
  for (const [args] of cases) {
    await runShim(f.shim, args, cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir }));
  }
  const entries = await logLines(f.logdir);
  assert.deepEqual(entries.map(e => e.action), cases.map(([, action]) => action));
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  for (const leak of ['submit', '800', 'viewport']) {
    assert.ok(!raw.includes(leak), `log must not contain ${leak}`);
  }
});

test('token-shaped env session is masked like --session', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const secret = `sk_${'B'.repeat(40)}`;
  await runShim(f.shim, ['snapshot'], cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, OPENWORKSPACE_SESSION: secret }));
  const entries = await logLines(f.logdir);
  assert.equal(entries[0].session, '[REDACTED_TOKEN]');
  const raw = await readFile(join(f.logdir, 'agent-browser-observations.jsonl'), 'utf8');
  assert.ok(!raw.includes(secret));
});

test('caller umask governs CLI artifacts; shim-owned log stays 0600', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const artifact = join(f.root, 'shot.png');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', 'umask 022; exec "$@"', '_', f.shim, 'snapshot'],
      { env: cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, FAKE_MAKE_ARTIFACT: '1', FAKE_ARTIFACT: artifact }) });
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`rc=${code}`))));
    child.stdin.end();
  });
  assert.equal((await stat(artifact)).mode & 0o777, 0o644);
  assert.equal((await readFile(`${artifact}.umask`, 'utf8')).trim(), '0022');
  assert.equal((await stat(join(f.logdir, 'agent-browser-observations.jsonl'))).mode & 0o777, 0o600);
});

test('TERM to the shim forwards to the child: no orphan, receipt logged', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  const pidfile = join(f.root, 'fake.pid');
  const child = spawn(f.shim, ['snapshot'], {
    env: cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, FAKE_SLEEP: '30', FAKE_PIDFILE: pidfile }),
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  try {
    const deadline = Date.now() + 10_000;
    let fakePid = 0;
    while (Date.now() < deadline) {
      try {
        fakePid = Number(await readFile(pidfile, 'utf8'));
        if (fakePid > 0) break;
      } catch { /* not started yet */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(fakePid > 0, 'fake child started');
    child.kill('SIGTERM');
    const closed = await new Promise<RunResult | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 15_000);
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code, signal }); });
    });
    assert.ok(closed !== null, 'shim exited after TERM (harness recorded)');
    assert.ok(closed.signal === 'SIGTERM' || closed.code === 143, `shim died by TERM, got ${closed.signal ?? closed.code}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.throws(() => process.kill(fakePid, 0), 'forwarded TERM killed the child, no orphan');
    const entries = await logLines(f.logdir);
    assert.equal(entries[entries.length - 1].outcome, 'signal-15');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
test('TTY forces metadata-only even with capture opt-in', async t => {
  const f = await fixture();
  t.after(() => cleanup(f.root));
  try {
    let command: string;
    let args: string[];
    if (process.platform === 'darwin') {
      command = 'script';
      args = ['-q', '/dev/null', f.shim, 'batch', '--json'];
    } else {
      command = 'script';
      args = ['-qec', `'${f.shim}' batch --json`, '/dev/null'];
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        env: cleanEnv({ OW_BROWSER_SHIM_LOG_DIR: f.logdir, OW_BROWSER_SHIM_CAPTURE: '1' }),
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', code => (code === 0 ? resolve() : reject(new Error(`script rc=${code}`))));
    });
    const entries = await logLines(f.logdir);
    assert.equal(entries[entries.length - 1].mode, 'metadata');
    await assert.rejects(readFile(join(f.logdir, 'agent-browser-captures.jsonl')));
  } catch (error) {
    if ((error as Error).message.includes('ENOENT')) {
      t.skip('script(1) unavailable');
      return;
    }
    throw error;
  }
});

test('installer installs with probe, verifies, refuses bad pins, uninstalls', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ow-bshim-install-')));
  t.after(() => cleanup(root));
  const fake = join(root, 'agent-browser');
  await writeFile(fake, fakeSource, { mode: 0o755 });
  await chmod(fake, 0o755);
  const home = join(root, 'home');
  const prefix = join(root, 'prefix');
  const baseEnv = cleanEnv({ HOME: home, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}`, FAKE_VERSION });
  const runInstaller = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(installerPath, args, { encoding: 'utf8', env: { ...baseEnv, ...extra } });
  const out = runInstaller(['--prefix', prefix, '--real', fake, '--yes']);
  assert.match(out, /Preview/);
  assert.match(out, /metadata-only/);
  assert.match(out, /probe: observed via shim/);
  const target = join(prefix, 'bin', 'agent-browser');
  assert.equal((await stat(target)).mode & 0o777, 0o755);
  assert.ok((await readFile(target, 'utf8')).includes('OW_AGENT_BROWSER_OBSERVER_SHIM_V1'));
  const sidecar = JSON.parse(await readFile(join(prefix, 'bin', '.agent-browser-shim.json'), 'utf8')) as Record<string, string>;
  assert.equal(sidecar.pinnedVersion, FAKE_VERSION);
  assert.equal(sidecar.real, fake);
  assert.deepEqual(await readdir(home).catch(() => [] as string[]), [], 'installer writes nothing under HOME');
  const logText = await readFile(join(prefix, 'browser-shim-logs', 'agent-browser-observations.jsonl'), 'utf8');
  assert.ok(logText.split('\n').filter(Boolean).some(line =>
    ((JSON.parse(line) as Record<string, unknown>).session as string ?? '').startsWith('shim-probe-')));
  const verifyActive = runInstaller(['--prefix', prefix, '--verify'], { PATH: `${join(prefix, 'bin')}:/usr/bin:/bin` });
  assert.match(verifyActive, /path: ACTIVE/);
  const verifyOff = runInstaller(['--prefix', prefix, '--verify'], { PATH: '/usr/bin:/bin' });
  assert.match(verifyOff, /observation off/);
  await chmod(fake, 0o777);
  assert.throws(() => runInstaller(['--prefix', join(root, 'prefix2'), '--real', fake, '--yes']), /world-writable/);
  await chmod(fake, 0o755);
  assert.throws(() => runInstaller(['--prefix', join(root, 'prefix3'), '--real', target, '--yes']), /already the shim/);
  const occupied = join(root, 'prefix4');
  await mkdir(join(occupied, 'bin'), { recursive: true });
  await writeFile(join(occupied, 'bin', 'agent-browser'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.throws(() => runInstaller(['--prefix', occupied, '--real', fake, '--yes']), /is not a shim/);
  const forced = runInstaller(['--prefix', occupied, '--real', fake, '--yes', '--force']);
  assert.match(forced, /probe: observed via shim/);
  assert.ok((await readFile(join(occupied, 'bin', 'agent-browser'), 'utf8')).includes('OW_AGENT_BROWSER_OBSERVER_SHIM_V1'));
  const uninstall = runInstaller(['--prefix', prefix, '--uninstall']);
  assert.match(uninstall, /uninstalled/);
  await assert.rejects(stat(target));
  assert.ok((await stat(join(prefix, 'browser-shim-logs'))).isDirectory(), 'logs kept on uninstall');
});
