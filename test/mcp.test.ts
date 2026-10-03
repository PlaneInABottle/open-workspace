import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';
import { consumerSkills } from '../src/consumer-skills.js';

test('real stdio MCP registers and operates without dashboard approval and survives service recreation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-mcp-')));
  const store = new Store(join(root, 'state')); await store.initialize();
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  let app = createApp(new WorkspaceService(store, async () => ({ available: true, processes: [{ pmId: 7, name: 'fixture-api', namespace: 'default', status: 'online', cwd: project, restartCount: 1, startedAt: null }] })), { mcpToken: 'b'.repeat(64), assets: fixtureStaticAssets() });
  let origin = await app.listen(0);
  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-test', version: '1.0.0' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['activity_list','browser_check','datastore_query','lease_acquire','lease_release','lease_touch','local_tool_status','onboarding_plan','recent_runs','run_import','service_control','service_logs','verification_run','workspace_inspect','workspace_leases','workspace_list','workspace_register','workspace_remove','workspace_services','workspace_update_roots','workspace_workstreams','workstream_context','workstream_create','workstream_status']);
    assert.ok(!tools.tools.some(tool => /approve|shell|secret|install|start/.test(tool.name)));
    const registerTool = tools.tools.find(tool => tool.name === 'workspace_register');
    assert.deepEqual(Object.keys((registerTool?.inputSchema.properties || {}) as object).sort(), ['name', 'roots']);
    const listed = await client.callTool({ name: 'workspace_list', arguments: {} });
    assert.ok(!listed.isError);
    const registered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project] } });
    assert.ok(!registered.isError);
    const workspace = JSON.parse((registered.content as Array<{ text: string }>)[0].text) as { id: string };
    const inspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId: workspace.id } });
    assert.ok(!inspected.isError);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /not_checked/);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /"roots"/);
    const services = await client.callTool({ name: 'workspace_services', arguments: { workspaceId: workspace.id } });
    const servicesText = (services.content as Array<{ text: string }>)[0].text;
    assert.ok(!services.isError);
    assert.match(servicesText, /fixture-api/);
    assert.match(servicesText, /"matchedProcessCount": 1/);
    const mcpSessionDenied = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-OpenWorkspace-Intent': 'connect-dashboard',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(mcpSessionDenied.status, 403);
    assert.equal((await fetch(`${origin}/api/client-config`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).status, 403);
    assert.equal((await fetch(`${origin}/api/project-root-picker`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-OpenWorkspace-Intent': 'select-project-roots',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })).status, 403);

    const connected = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(connected.status, 201);
    const dashboardSession = await connected.json() as { dashboardToken: string };
    const removed = await client.callTool({ name: 'workspace_remove', arguments: { workspaceId: workspace.id } });
    assert.ok(!removed.isError);
    const gone = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId: workspace.id } });
    assert.equal(gone.isError, true);
    const reregistered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project] } });
    const workspaceId = (JSON.parse((reregistered.content as Array<{ text: string }>)[0].text) as { id: string }).id;
    const reinspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId } });
    assert.ok(!reinspected.isError);
    assert.match((reinspected.content as Array<{ text: string }>)[0].text, /not_checked/);
    assert.match((reinspected.content as Array<{ text: string }>)[0].text, /"roots"/);
    const plan = await client.callTool({ name: 'onboarding_plan', arguments: { workspaceId } });
    const planText = (plan.content as Array<{ text: string }>)[0].text;
    const planValue = JSON.parse(planText) as { availableSkills: Array<{ name: string; whenToUse: string; fetch: { prompt: string } }> };
    assert.match(planText, /not_implemented/);
    assert.match(planText, /only records what ran/);
    const skillDirectories = await readdir(new URL('../skills/', import.meta.url), { withFileTypes: true });
    const onDiskSkills = [];
    for (const entry of skillDirectories.filter(item => item.isDirectory())) {
      try {
        await readFile(new URL(`../skills/${entry.name}/SKILL.md`, import.meta.url));
        onDiskSkills.push(entry.name);
      } catch { /* A directory without SKILL.md is not a consumer skill. */ }
    }
    assert.deepEqual(planValue.availableSkills.map(skill => skill.name), onDiskSkills.sort());
    assert.deepEqual(planValue.availableSkills.map(skill => skill.name), consumerSkills.map(skill => skill.name));
    for (const skill of planValue.availableSkills) {
      assert.deepEqual(Object.keys(skill).sort(), ['fetch', 'name', 'whenToUse']);
      assert.deepEqual(Object.keys(skill.fetch).sort(), ['prompt']);
      assert.ok(skill.whenToUse.length > 0 && skill.whenToUse.length <= 200 && !/[\r\n]/.test(skill.whenToUse));
      assert.equal(skill.fetch.prompt, `skill/${skill.name}`);
    }
    const leases = await client.callTool({ name: 'workspace_leases', arguments: {} });
    assert.ok(!leases.isError);
    assert.deepEqual(JSON.parse((leases.content as Array<{ text: string }>)[0].text), []);
    const workstream = async (name: string) => {
      const created = await client.callTool({ name: 'workstream_create', arguments: { name, workspaceId, checkouts: [project] } });
      assert.ok(!created.isError);
      return (JSON.parse((created.content as Array<{ text: string }>)[0].text) as { id: string }).id;
    };
    const holderId = await workstream('Lease holder');
    const queuedId = await workstream('Lease waiter');
    const acquired = await client.callTool({ name: 'lease_acquire', arguments: { resource: 'mcp:lease', workstreamId: holderId } });
    assert.ok(!acquired.isError);
    const queued = await client.callTool({ name: 'lease_acquire', arguments: { resource: 'mcp:lease', workstreamId: queuedId } });
    assert.ok(!queued.isError);
    assert.equal((JSON.parse((queued.content as Array<{ text: string }>)[0].text) as { lease: { status: string } }).lease.status, 'queued');
    const refusedTouch = await client.callTool({ name: 'lease_touch', arguments: { resource: 'mcp:lease', workstreamId: queuedId } });
    assert.equal(refusedTouch.isError, true);
    assert.match((refusedTouch.content as Array<{ text: string }>)[0].text, /Only the holding workstream can touch a lease/);
    const renewed = await client.callTool({ name: 'lease_touch', arguments: { resource: 'mcp:lease', workstreamId: holderId } });
    assert.ok(!renewed.isError);
    assert.equal((JSON.parse((renewed.content as Array<{ text: string }>)[0].text) as { resource: string; status: string }).status, 'held');
    const allowedControl = await client.callTool({
      name: 'service_control',
      arguments: { workspaceId, action: 'restart', target: { pmId: 999, name: 'absent-service' } },
    });
    assert.ok(!allowedControl.isError);
    assert.match((allowedControl.content as Array<{ text: string }>)[0].text, /not uniquely mapped to a registered root/);
    const logsTool = tools.tools.find(tool => tool.name === 'service_logs');
    assert.deepEqual(Object.keys((logsTool?.inputSchema.properties || {}) as object).sort(), ['lines', 'stream', 'target', 'workspaceId']);
    const deniedLogs = await client.callTool({
      name: 'service_logs',
      arguments: { workspaceId, target: { pmId: 999, name: 'absent-service' } },
    });
    assert.ok(!deniedLogs.isError);
    assert.match((deniedLogs.content as Array<{ text: string }>)[0].text, /not uniquely mapped to a registered root/);
    assert.match(planText, /every registered root group separately/);
    assert.match(planText, /never infer a common parent/);
    const prompts = (await client.listPrompts()).prompts.map(item => item.name).sort();
    assert.deepEqual(prompts, ['workspace_onboarding', ...consumerSkills.map(skill => `skill/${skill.name}`)].sort());
    const prompt = await client.getPrompt({ name: 'workspace_onboarding' });
    const promptText = (prompt.messages[0].content as { text: string }).text;
    assert.match(promptText, /workspace_register with \{name, roots\}/);
    assert.match(promptText, /Do not infer a common parent/);
    assert.match(promptText, /Jira is optional/);
    const secretPattern = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
    for (const skill of consumerSkills) {
      const fetched = await client.getPrompt({ name: `skill/${skill.name}` });
      const servedText = (fetched.messages[0].content as { text: string }).text;
      assert.equal(servedText, await readFile(new URL(`../skills/${skill.name}/SKILL.md`, import.meta.url), 'utf8'));
      assert.doesNotMatch(servedText, secretPattern);
    }
    await assert.rejects(client.getPrompt({ name: 'skill/missing' }), /unknown prompt|not found|skill\/missing/i);
    await app.close();
    app = createApp(new WorkspaceService(new Store(store.directory), async () => ({ available: true, processes: [{ pmId: 7, name: 'fixture-api', namespace: 'default', status: 'online', cwd: project, restartCount: 1, startedAt: null }] })), { mcpToken: 'c'.repeat(64), assets: fixtureStaticAssets() });
    origin = await app.listen(0);
    await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
    assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${dashboardSession.dashboardToken}` } })).status, 401);
    const resumed = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId } });
    assert.ok(!resumed.isError);
    assert.ok(!stderr.includes('b'.repeat(64)));
    assert.ok(!stderr.includes('c'.repeat(64)));
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
