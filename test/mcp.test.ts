import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, writePrivateJson } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { createApp } from '../src/http.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';

test('real stdio MCP shares service state, cannot approve access and survives service recreation', async () => {
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
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['onboarding_plan','workspace_inspect','workspace_list','workspace_propose','workspace_services']);
    assert.ok(!tools.tools.some(tool => /approve|shell|secret|install|start/.test(tool.name)));
    const proposalTool = tools.tools.find(tool => tool.name === 'workspace_propose');
    assert.deepEqual(Object.keys((proposalTool?.inputSchema.properties || {}) as object).sort(), ['name', 'roots']);
    const listed = await client.callTool({ name: 'workspace_list', arguments: {} });
    assert.ok(!listed.isError);
    const requested = await client.callTool({ name: 'workspace_propose', arguments: { name: 'Fixture', roots: [project] } });
    const proposal = JSON.parse((requested.content as Array<{ text: string }>)[0].text) as { id: string };
    const denied = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId: proposal.id } });
    assert.equal(denied.isError, true);
    const deniedServices = await client.callTool({ name: 'workspace_services', arguments: { workspaceId: proposal.id } });
    assert.equal(deniedServices.isError, true);
    const mcpApproval = await fetch(`${origin}/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(mcpApproval.status, 403);
    assert.equal((await fetch(`${origin}/api/client-config`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).status, 403);

    const connected = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenWorkspace-Intent': 'connect-dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(connected.status, 201);
    const dashboardSession = await connected.json() as { dashboardToken: string };
    const approval = await fetch(`${origin}/api/proposals/${proposal.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${dashboardSession.dashboardToken}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(approval.status, 200);
    const inspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId: proposal.id } });
    assert.ok(!inspected.isError);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /not_checked/);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /"roots"/);
    const services = await client.callTool({ name: 'workspace_services', arguments: { workspaceId: proposal.id } });
    const servicesText = (services.content as Array<{ text: string }>)[0].text;
    assert.ok(!services.isError);
    assert.match(servicesText, /fixture-api/);
    assert.match(servicesText, /"matchedProcessCount": 1/);
    const plan = await client.callTool({ name: 'onboarding_plan', arguments: { workspaceId: proposal.id } });
    const planText = (plan.content as Array<{ text: string }>)[0].text;
    assert.match(planText, /not_implemented/);
    assert.match(planText, /every approved root group separately/);
    assert.match(planText, /never infer a common parent/);
    assert.equal((await client.listPrompts()).prompts[0].name, 'workspace_onboarding');
    const prompt = await client.getPrompt({ name: 'workspace_onboarding' });
    const promptText = (prompt.messages[0].content as { text: string }).text;
    assert.match(promptText, /workspace_propose with \{name, roots\}/);
    assert.match(promptText, /Do not infer a common parent/);
    assert.match(promptText, /Jira is optional/);
    await app.close();
    app = createApp(new WorkspaceService(new Store(store.directory), async () => ({ available: true, processes: [{ pmId: 7, name: 'fixture-api', namespace: 'default', status: 'online', cwd: project, restartCount: 1, startedAt: null }] })), { mcpToken: 'c'.repeat(64), assets: fixtureStaticAssets() });
    origin = await app.listen(0);
    await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
    assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${dashboardSession.dashboardToken}` } })).status, 401);
    const resumed = await client.callTool({ name: 'workspace_inspect', arguments: { workspaceId: proposal.id } });
    assert.ok(!resumed.isError);
    assert.ok(!stderr.includes('b'.repeat(64)));
    assert.ok(!stderr.includes('c'.repeat(64)));
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
