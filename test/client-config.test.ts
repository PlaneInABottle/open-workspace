import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-client-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, store, service: new WorkspaceService(store) };
}

// Pre-branch pin (SEA plan M1.3): the source-preview client-config response is
// byte-identical in shape — execPath + companion script + mcp args, no `sea` flag.
// The SEA branch adds `sea: true` only; source responses must keep omitting it.
// Client config is dashboard-only over open loopback: no token needed, the MCP
// bearer is denied.
test('source client-config shape: companion mcp launch, no sea flag', async t => {
  const f = await fixture(t);
  const mcpToken = 'c'.repeat(64);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const response = await fetch(`${origin}/api/client-config`);
  assert.equal(response.status, 200);
  const body = await response.json() as unknown;
  assert.deepEqual(Object.keys(body as Record<string, unknown>), ['mcpServers']);
  const entry = (body as { mcpServers: { openworkspace: Record<string, unknown> } }).mcpServers.openworkspace;
  assert.deepEqual(Object.keys(entry).sort(), ['args', 'command', 'env']);
  assert.equal(entry.command, process.execPath);
  assert.ok(Array.isArray(entry.args) && (entry.args as unknown[]).length === 4);
  const [script, ...rest] = entry.args as string[];
  assert.ok(script.endsWith('bin/openworkspace.mjs'), `companion script path, got ${script}`);
  assert.deepEqual(rest, ['mcp', '--state-directory', f.store.directory]);
  assert.deepEqual(entry.env, { OPENWORKSPACE_HOME: f.store.directory });
  assert.ok(!('sea' in entry), 'source responses omit the sea flag');

  const mcpHeaders = { Authorization: `Bearer ${mcpToken}`, ...jsonHeaders };
  assert.equal((await fetch(`${origin}/api/client-config`, { headers: mcpHeaders })).status, 403);
});
