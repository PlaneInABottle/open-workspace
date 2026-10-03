import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CommandOutcome, CommandRunner } from '../src/verify.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const US = '\x1f';
const RS = '\x1e';

function okOutcome(stdout: string): CommandOutcome {
  return { exitCode: 0, timedOut: false, aborted: false, truncated: false, stdout, stderr: '', durationMs: 1, spawnFailed: false };
}

function failOutcome(stderr: string, extra: Partial<CommandOutcome> = {}): CommandOutcome {
  return { exitCode: 1, timedOut: false, aborted: false, truncated: false, stdout: '', stderr, durationMs: 1, spawnFailed: false, ...extra };
}

interface CapturedCall {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

// The superuser probe is always the first runner call; validation refuses
// before any call, so refused statements are never executed.
function scriptedRunner(script: { probe: CommandOutcome; main: CommandOutcome | ((input: string) => CommandOutcome) }) {
  const calls: CapturedCall[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env, input: options.input });
    if (calls.length === 1) return script.probe;
    return typeof script.main === 'function' ? script.main(options.input ?? '') : script.main;
  };
  return { run, calls };
}

const probeOk = okOutcome(`usesuper\nf\n(1 row)\n`);
const rowsOk = okOutcome(`id${US}val\n1${US}a\n2${US}\n3${US}${RS}\n(3 rows)\n`);

async function registeredService(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-datastore-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  await mkdir(first);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Data project', [first]);
  return { root, first, store, service, workspace };
}

test('datastore query sends flags-only argv with SQL on stdin and honors bounds', async t => {
  const f = await registeredService(t);
  const second = join(f.root, 'second');
  await mkdir(second);
  const anchored = await f.service.register('Anchored project', [f.first, second]);
  const { run, calls } = scriptedRunner({ probe: probeOk, main: rowsOk });
  const result = await f.service.datastoreQuery(anchored.id,
    { database: 'ow_test', role: 'ow_read', sql: 'SELECT id, val FROM t ORDER BY id' },
    { run });
  assert.deepEqual(result.columns, ['id', 'val']);
  assert.deepEqual(result.rows, [['1', 'a'], ['2', ''], ['3', null]]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.database, 'ow_test');
  assert.equal(result.role, 'ow_read');
  assert.equal(result.nullMarker, 'U+001E');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'psql');
    assert.ok(!call.args.some(arg => arg.includes('SELECT')), 'argv must carry flags only, never SQL');
    assert.ok(!call.args.includes('-c'), 'no -c command flag; SQL travels on stdin');
    assert.ok(call.args.includes('-X') && call.args.includes('-w') && call.args.includes('-A'));
    assert.ok(call.args.includes('-f') && call.args[call.args.length - 1] === '-');
    assert.deepEqual(call.args.slice(call.args.indexOf('-d'), call.args.indexOf('-d') + 2), ['-d', 'ow_test']);
    assert.deepEqual(call.args.slice(call.args.indexOf('-U'), call.args.indexOf('-U') + 2), ['-U', 'ow_read']);
    assert.equal(call.cwd, f.first);
    assert.ok(call.env && !('PGHOST' in call.env), 'PGHOST stays unset');
    assert.equal(call.env?.PGCONNECT_TIMEOUT, '5');
    assert.equal(call.env?.PGAPPNAME, 'openworkspace-datastore');
    assert.ok(call.env && !('PGPASSWORD' in call.env) && !('DATABASE_URL' in call.env));
  }
  assert.match(calls[0].input ?? '', /usesuper/);
  assert.match(calls[1].input ?? '', /BEGIN READ ONLY/);
  assert.match(calls[1].input ?? '', /SET LOCAL statement_timeout = '8s'/);
  assert.match(calls[1].input ?? '', /SELECT id, val FROM t ORDER BY id/);
});

test('superuser roles are refused before the main query runs', async t => {
  const f = await registeredService(t);
  const { run, calls } = scriptedRunner({ probe: okOutcome(`usesuper\nt\n(1 row)\n`), main: rowsOk });
  await assert.rejects(
    f.service.datastoreQuery(f.workspace.id, { database: 'ow_test', role: 'postgres', sql: 'SELECT 1' }, { run }),
    /Superuser database roles cannot be used for read-only queries\./,
  );
  assert.equal(calls.length, 1);
});

test('non-read and multi-statement shapes are refused before execution', async t => {
  const refused = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'CREATE TABLE x (a int)',
    'ALTER TABLE t ADD COLUMN b int',
    'TRUNCATE t',
    'GRANT SELECT ON t TO ow_read',
    'VACUUM t',
    'CALL do_something()',
    'SELECT 1; SELECT 2',
    'SELECT 1; DROP TABLE t',
    '/* leading */ SELECT 1; SELECT 2',
    "SELECT pg_read_file('pg_hba.conf')",
    "SELECT pg_read_binary_file('x')",
    'SELECT * FROM dblink(\'c\', \'SELECT 1\') AS t(a int)',
    'COPY t TO STDOUT',
    '\\copy t to stdout',
    '\\! ls',
    '\\include /tmp/x.sql',
    'SELECT lo_import(123)',
    'SELECT lo_export(1, \'/tmp/x\')',
    "SELECT set_config('a', 'b', false)",
    'SET statement_timeout = \'1s\'',
    'RESET ALL',
    'BEGIN; SELECT 1',
    'COMMIT',
    'EXPLAIN ANALYZE SELECT 1',
    'EXPLAIN DELETE FROM t',
    'SELECT 1 -- ;\n; SELECT 2',
    // Escape string constants: a backslash escapes the next character, so a
    // naive ''-only tokenizer misreads the literal end and misses the
    // injected second statement and transaction control.
    'SELECT E\'\\\'\'; COMMIT; DROP TABLE t; --',
    'select e\'\\\'\'; COMMIT; SELECT 1; --',
    'SELECT U&\'\\0027\'; COMMIT; DROP TABLE t; --',
    'SELECT 1 AS U&"x"; COMMIT; SELECT pg_read_file(\'p\'); --',
    'SELECT E\'a\\\\b\'; DROP TABLE t',
    'SELECT U&\'d83d\' UESCAPE \'!\'',
  ];
  for (const sql of refused) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-datastore-neg-')));
    try {
      const project = join(root, 'project');
      await mkdir(project);
      const store = new Store(join(root, 'state'));
      await store.initialize();
      const service = new WorkspaceService(store);
      const workspace = await service.register('Neg', [project]);
      const { run, calls } = scriptedRunner({ probe: probeOk, main: rowsOk });
      await assert.rejects(
        service.datastoreQuery(workspace.id, { database: 'ow_test', role: 'ow_read', sql }, { run }),
        /Only a single read-only SELECT-style statement is allowed\./,
        sql,
      );
      assert.equal(calls.length, 0, `refused statement must not start a process: ${sql}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('read-only shapes are accepted', async t => {
  const allowed = [
    'SELECT 1',
    'select 1;',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1, 2)',
    'TABLE t',
    'SHOW server_version',
    'EXPLAIN SELECT 1',
    "SELECT 'drop table -- ; /* insert */'",
    "SELECT E'a\\nb'",
    "SELECT U&'\\0041'",
    "SELECT 'plain \\\\ backslash'",
  ];
  for (const sql of allowed) {
    const f = await registeredService(t);
    const { run, calls } = scriptedRunner({ probe: probeOk, main: okOutcome(`a\n1\n(1 row)\n`) });
    const result = await f.service.datastoreQuery(f.workspace.id, { database: 'ow_test', role: 'ow_read', sql }, { run });
    assert.equal(result.rowCount, 1, sql);
    assert.equal(calls.length, 2, sql);
  }
});

test('hostile parameter values cannot form a second statement', async t => {
  const f = await registeredService(t);
  let seen = '';
  const { run, calls } = scriptedRunner({
    probe: probeOk,
    main: input => { seen = input; return okOutcome(`a\n1\n(1 row)\n`); },
  });
  const result = await f.service.datastoreQuery(f.workspace.id,
    { database: 'ow_test', role: 'ow_read', sql: 'SELECT $1, $2', params: ["'; DROP TABLE t; --", 7] }, { run });
  assert.equal(result.rowCount, 1);
  assert.equal(calls.length, 2);
  assert.match(seen, /'''.*; DROP TABLE t; --'/);
  assert.ok(!seen.includes('; DROP TABLE t;\n'), 'injected semicolons stay inside the quoted literal');

  const hostile = await registeredService(t);
  const second = scriptedRunner({ probe: probeOk, main: rowsOk });
  await assert.rejects(
    hostile.service.datastoreQuery(hostile.workspace.id,
      { database: 'ow_test', role: 'ow_read', sql: '$1', params: ['SELECT 1'] }, { run: second.run }),
    /Only a single read-only SELECT-style statement is allowed\./,
  );
  assert.equal(second.calls.length, 0);

  const missing = scriptedRunner({ probe: probeOk, main: rowsOk });
  await assert.rejects(
    hostile.service.datastoreQuery(hostile.workspace.id,
      { database: 'ow_test', role: 'ow_read', sql: 'SELECT $2', params: ['a'] }, { run: missing.run }),
    /Only a single read-only SELECT-style statement is allowed\./,
  );
  assert.equal(missing.calls.length, 0);
});

test('rows truncate to maxRows with counts preserved', async t => {  const f = await registeredService(t);
  const lines = ['n', ...Array.from({ length: 5 }, (_, i) => String(i + 1)), '(5 rows)'];
  const { run } = scriptedRunner({ probe: probeOk, main: okOutcome(`${lines.join('\n')}\n`) });
  const result = await f.service.datastoreQuery(f.workspace.id,
    { database: 'ow_test', role: 'ow_read', sql: 'SELECT n FROM big', maxRows: 2 }, { run });
  assert.deepEqual(result.rows, [['1'], ['2']]);
  assert.equal(result.rowCount, 5);
  assert.equal(result.truncated, true);
});

test('wire newlines in values parse as extra rows (documented limitation)', async t => {
  // Unaligned psql output has no quoting: a newline inside a text value is
  // indistinguishable on the wire from a row boundary. Values stay inert
  // display text and the capture/row caps still bound the result.
  const f = await registeredService(t);
  const { run } = scriptedRunner({ probe: probeOk, main: okOutcome('a\nline1\nline2\n(2 rows)\n') });
  const result = await f.service.datastoreQuery(f.workspace.id,
    { database: 'ow_test', role: 'ow_read', sql: 'SELECT a FROM t' }, { run });
  assert.deepEqual(result.rows, [['line1'], ['line2']]);
  assert.equal(result.rowCount, 2);
});

test('schema rejects connection fields and bad identifiers', async t => {
  const f = await registeredService(t);
  const { run, calls } = scriptedRunner({ probe: probeOk, main: rowsOk });
  const valid = { database: 'ow_test', role: 'ow_read', sql: 'SELECT 1' };
  await assert.rejects(f.service.datastoreQuery(f.workspace.id, { ...valid, host: 'x' }, { run }));
  await assert.rejects(f.service.datastoreQuery(f.workspace.id, { ...valid, port: 5432 }, { run }));
  await assert.rejects(f.service.datastoreQuery(f.workspace.id, { ...valid, socketDir: '/tmp' }, { run }));
  await assert.rejects(f.service.datastoreQuery(f.workspace.id, { ...valid, url: 'postgres://x' }, { run }));
  await assert.rejects(
    f.service.datastoreQuery(f.workspace.id, { ...valid, database: 'bad-name!' }, { run }),
    /Provide a database and role using 1–63 letters, digits or underscores\./,
  );
  await assert.rejects(
    f.service.datastoreQuery(f.workspace.id, { ...valid, role: '' }, { run }),
    /Provide a database and role using 1–63 letters, digits or underscores\./,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    f.service.datastoreQuery('00000000-0000-4000-8000-000000000000', valid, { run }),
    /Workspace not found\. Register it first\./,
  );
});

test('timeouts and client failures map to safe messages', async t => {
  const cases: Array<{ main: CommandOutcome; message: RegExp }> = [
    { main: failOutcome('ERROR:  canceling statement due to statement timeout'), message: /did not finish within the bounded runtime/ },
    { main: failOutcome('', { timedOut: true }), message: /did not finish within the bounded runtime/ },
    { main: failOutcome('FATAL:  database "missing" does not exist'), message: /failed without returning rows/ },
    { main: { ...failOutcome(''), spawnFailed: true }, message: /PostgreSQL client is unavailable/ },
  ];
  for (const { main, message } of cases) {
    const f = await registeredService(t);
    const { run } = scriptedRunner({ probe: probeOk, main });
    await assert.rejects(
      f.service.datastoreQuery(f.workspace.id, { database: 'ow_test', role: 'ow_read', sql: 'SELECT 1' }, { run }),
      message,
    );
  }
});

// --- Bounded real-PostgreSQL fixture: least-privilege role, socket-only. ---

function postgresBinariesAvailable(): boolean {
  for (const bin of ['initdb', 'postgres', 'psql']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
    } catch {
      return false;
    }
  }
  return true;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

interface RealPostgres {
  socketDir: string;
  port: number;
  count: () => string;
}

async function ensureRealPostgres(t: TestContext): Promise<RealPostgres | undefined> {
  if (!postgresBinariesAvailable()) return undefined;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-datastore-pg-')));
  const dataDir = join(root, 'data');
  // Unix-socket paths are capped near 100 bytes and TMPDIR runs long, so the
  // socket directory lives directly under /tmp with a short unique name.
  const socketDir = await realpath(await mkdtemp('/tmp/ow-pg-'));
  t.after(() => rm(socketDir, { recursive: true, force: true }));
  await mkdir(dataDir);
  execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  const port = await freePort();
  const child: ChildProcess = spawn('postgres',
    ['-D', dataDir, '-k', socketDir, '-p', String(port), '-c', 'listen_addresses='],
    { stdio: 'ignore' });
  const stop = async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolve => child.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ]);
    try { child.kill('SIGKILL'); } catch { /* Already stopped. */ }
    await rm(root, { recursive: true, force: true });
  };
  t.after(stop);
  const psql = (db: string, user: string, sql: string) =>
    execFileSync('psql', ['-h', socketDir, '-p', String(port), '-U', user, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8', timeout: 10_000 });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try {
      if (psql('postgres', 'postgres', 'SELECT 1').trim() === '1') ready = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error('The fixture database did not become ready.');
  psql('postgres', 'postgres', 'CREATE ROLE ow_read LOGIN');
  psql('postgres', 'postgres', 'CREATE DATABASE ow_test');
  psql('ow_test', 'postgres', 'CREATE TABLE items(id int primary key, name text)');
  psql('ow_test', 'postgres', "INSERT INTO items VALUES (1, 'a'), (2, 'b')");
  psql('ow_test', 'postgres', 'CREATE TABLE big AS SELECT generate_series(1, 500) AS n');
  psql('ow_test', 'postgres', 'GRANT SELECT ON items TO ow_read');
  psql('ow_test', 'postgres', 'GRANT SELECT ON big TO ow_read');
  const count = () => psql('ow_test', 'postgres', 'SELECT count(*) FROM items').trim();
  return { socketDir, port, count };
}

test('real PostgreSQL: bounded read-only behavior with honest skip', async t => {
  const pg = await ensureRealPostgres(t);
  if (!pg) {
    t.skip('PostgreSQL binaries are absent; honest skip, not a pass.');
    return;
  }
  const count = pg.count;
  const f = await registeredService(t);
  const via = (input: unknown) => f.service.datastoreQuery(f.workspace.id, input, { socketDir: pg.socketDir, port: pg.port });

  const selected = await via({ database: 'ow_test', role: 'ow_read', sql: 'SELECT id, name FROM items ORDER BY id' }) as {
    columns: string[]; rows: (string | null)[][]; rowCount: number; truncated: boolean; timedOut: boolean;
  };
  assert.deepEqual(selected.columns, ['id', 'name']);
  assert.deepEqual(selected.rows, [['1', 'a'], ['2', 'b']]);
  assert.equal(selected.rowCount, 2);
  assert.equal(selected.truncated, false);
  assert.equal(selected.timedOut, false);

  const explained = await via({ database: 'ow_test', role: 'ow_read', sql: 'EXPLAIN SELECT 1' }) as { columns: string[]; rowCount: number };
  assert.deepEqual(explained.columns, ['QUERY PLAN']);
  assert.ok(explained.rowCount >= 1);

  await assert.rejects(via({ database: 'ow_test', role: 'ow_read', sql: "INSERT INTO items VALUES (3, 'c')" }),
    /Only a single read-only SELECT-style statement is allowed\./);
  await assert.rejects(via({ database: 'ow_test', role: 'ow_read', sql: 'DROP TABLE items' }),
    /Only a single read-only SELECT-style statement is allowed\./);
  await assert.rejects(via({ database: 'ow_test', role: 'ow_read', sql: "SELECT pg_read_file('pg_hba.conf')" }),
    /Only a single read-only SELECT-style statement is allowed\./);
  assert.equal(count(), '2');

  // Escape-string injection is refused live; the table is untouched.
  await assert.rejects(via({ database: 'ow_test', role: 'ow_read', sql: "SELECT E'\\''; COMMIT; INSERT INTO items VALUES (3, 'c')" }),
    /Only a single read-only SELECT-style statement is allowed\./);
  assert.equal(count(), '2');

  // A legit escape string runs, and its embedded newline surfaces as the
  // documented wire-level extra row.
  const escaped = await via({ database: 'ow_test', role: 'ow_read', sql: "SELECT E'a\\nb' AS v" }) as {
    rows: string[][]; rowCount: number;
  };
  assert.deepEqual(escaped.rows, [['a'], ['b']]);
  assert.equal(escaped.rowCount, 2);

  const startedAt = Date.now();
  await assert.rejects(via({ database: 'ow_test', role: 'ow_read', sql: 'SELECT pg_sleep(10)' }),
    /The database query did not finish within the bounded runtime\./);
  const elapsedMs = Date.now() - startedAt;
  // The 8s server statement_timeout fires first; the 15s runner backstop never fires.
  assert.ok(elapsedMs >= 6000 && elapsedMs < 14_500, `expected server-side cancel, elapsed ${elapsedMs}ms`);

  const big = await via({ database: 'ow_test', role: 'ow_read', sql: 'SELECT n FROM big ORDER BY n', maxRows: 50 }) as {
    rows: string[][]; rowCount: number; truncated: boolean;
  };
  assert.equal(big.rowCount, 500);
  assert.equal(big.truncated, true);
  assert.equal(big.rows.length, 50);
  assert.deepEqual(big.rows[0], ['1']);

  await assert.rejects(via({ database: 'ow_test', role: 'postgres', sql: 'SELECT 1' }),
    /Superuser database roles cannot be used for read-only queries\./);
});

// --- Real stdio MCP + HTTP with a controlled psql stand-in. ---

test('real stdio MCP and HTTP serve datastore_query without leaking SQL', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-datastore-fake-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  await writeFile(join(binDir, 'psql'),
    '#!/bin/sh\ninput=$(cat)\ncase "$input" in\n*usesuper*) printf "usesuper\\nf\\n(1 row)\\n";;\n*) printf "id\\037val\\n1\\037a\\n(1 row)\\n";;\nesac\n');
  await chmod(join(binDir, 'psql'), 0o755);
  const savedPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });

  const project = join(root, 'project');
  await mkdir(project);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Data project', [project]);
  const app = createApp(service, { mcpToken: 'd'.repeat(64), assets: fixtureStaticAssets() });
  t.after(() => app.close());
  const origin = await app.listen(0);
  const mcpHeaders = {
    Authorization: `Bearer ${app.mcpToken}`,
    'Content-Type': 'application/json',
  };

  const queried = await fetch(`${origin}/api/workspaces/${workspace.id}/datastore/query`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ database: 'appdb', role: 'appreader', sql: 'SELECT 1' }),
  });
  assert.equal(queried.status, 200);
  const result = await queried.json() as { columns: string[]; rows: string[][]; rowCount: number };
  assert.deepEqual(result.columns, ['id', 'val']);
  assert.deepEqual(result.rows, [['1', 'a']]);
  assert.equal(result.rowCount, 1);

  const activity = await (await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).json() as Array<{ detail: string }>;
  assert.ok(activity.some(entry => entry.detail === 'appdb → 1 rows'));
  assert.ok(!JSON.stringify(activity).includes('SELECT 1'), 'activity must never carry SQL');

  assert.equal((await fetch(`${origin}/api/workspaces/${workspace.id}/datastore/query`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ database: 'appdb', role: 'appreader', sql: 'SELECT 1', host: 'remote' }),
  })).status, 400);

  // A schema-valid call with 20 full-size params is ~20 KiB: above the default
  // 8 KiB JSON cap, inside the datastore 32 KiB limit.
  const wide = await fetch(`${origin}/api/workspaces/${workspace.id}/datastore/query`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ database: 'appdb', role: 'appreader', sql: 'SELECT 1', params: Array.from({ length: 20 }, () => 'x'.repeat(1000)) }),
  });
  assert.equal(wide.status, 200);
  assert.equal(((await wide.json()) as { rowCount: number }).rowCount, 1);

  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-datastore-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  const registered = tools.tools.find(tool => tool.name === 'datastore_query');
  assert.ok(registered, 'datastore_query is advertised');
  assert.ok(!tools.tools.some(tool => /browser_check/.test(tool.name)), 'M3 browser check stays unadvertised');
  assert.ok(Object.keys((registered?.inputSchema as { properties: object }).properties).length <= 5);
  const called = await client.callTool({
    name: 'datastore_query',
    arguments: { workspaceId: workspace.id, database: 'appdb', role: 'appreader', sql: 'SELECT 1', options: { maxRows: 10 } },
  });
  assert.ok(!called.isError);
  assert.match((called.content as Array<{ text: string }>)[0].text, /"rowCount": 1/);
  const refused = await client.callTool({
    name: 'datastore_query',
    arguments: { workspaceId: workspace.id, database: 'appdb', role: 'appreader', sql: 'DROP TABLE t' },
  });
  assert.equal(refused.isError, true);
});
