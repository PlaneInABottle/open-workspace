import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connection } from '../src/connection.js';
import { Store, writePrivateJson } from '../src/store.js';

test('private client connection accepts only the distinct MCP credential schema', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-connection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.initialize();
  const path = join(root, 'connection.json');

  await writePrivateJson(path, { origin: 'http://127.0.0.1:4318', mcpToken: 'a'.repeat(64) });
  const local = await connection(root);
  assert.equal(local.origin, 'http://127.0.0.1:4318');
  assert.equal(/^[a-f0-9]{64}$/.test(local.mcpToken), true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writePrivateJson(path, { origin: 'http://127.0.0.1:4318', token: 'b'.repeat(64) });
  await assert.rejects(connection(root));
});
