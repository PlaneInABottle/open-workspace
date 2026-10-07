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
import { consumerSkills, initConsumerSkills } from '../src/consumer-skills.js';

await initConsumerSkills();

test('real stdio MCP registers and operates without dashboard approval and survives service recreation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-mcp-')));
  const store = new Store(join(root, 'state')); await store.initialize();
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const workspaceService = () => new WorkspaceService(store,
    async () => ({ available: true, processes: [{ pmId: 7, name: 'fixture-api', namespace: 'default', status: 'online', cwd: project, restartCount: 1, startedAt: null }] }));
  let app = createApp(workspaceService(), { mcpToken: 'b'.repeat(64), assets: fixtureStaticAssets() });
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
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['environment_down','environment_propose','environment_rename','environment_set','environment_status','environment_up','environment_verify','learning_record','onboarding_plan','run_import','workspace_inspect','workspace_list','workspace_register']);
    assert.ok(!tools.tools.some(tool => /approve|shell|secret|install|start/.test(tool.name)));
    // Shed harness-fighting surface (pivot): per-service control/logs,
    // container linking, declared local tools, rename/roots/remove,
    // activity/run reads and the PM2-wide inventory have no MCP tool. The
    // dashboard keeps its HTTP routes; the harness shell covers the rest.
    // Workstreams and leases are shed with the same no-fight rule: the
    // harness tracks tasks natively and needs no lock ceremony.
    for (const shed of ['service_control','service_logs','workspace_container_link','local_tool_status','workspace_rename','workspace_update_roots','workspace_remove','activity_list','recent_runs','workspace_services','workspace_workstreams','workspace_leases','lease_acquire','lease_touch','lease_release','workstream_create','workstream_rename','workstream_status','workstream_context']) {
      assert.ok(!tools.tools.some(tool => tool.name === shed), `${shed} is not served over MCP`);
    }
    const registerTool = tools.tools.find(tool => tool.name === 'workspace_register');
    assert.deepEqual(Object.keys((registerTool?.inputSchema.properties || {}) as object).sort(), ['name', 'roots']);
    const listed = await client.callTool({ name: 'workspace_list', arguments: {} });
    assert.ok(!listed.isError);
    const registered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project] } });
    assert.ok(!registered.isError);
    const workspace = JSON.parse((registered.content as Array<{ text: string }>)[0].text) as { id: string; name: string };
    const inspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspace: workspace.name } });
    assert.ok(!inspected.isError);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /not_checked/);
    assert.match((inspected.content as Array<{ text: string }>)[0].text, /"roots"/);
    for (const name of ['workspace_inspect', 'onboarding_plan', 'environment_verify']) {
      const description = tools.tools.find(tool => tool.name === name)?.description ?? '';
      assert.ok(Buffer.byteLength(description, 'utf8') <= 200, `${name} description is within 200 bytes`);
    }
    // Dashboard-only routes stay denied to the MCP credential over open
    // loopback; the removed session route fails closed at the role gate.
    const mcpSessionGone = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(mcpSessionGone.status, 403);
    assert.equal((await fetch(`${origin}/api/client-config`, { headers: { Authorization: `Bearer ${app.mcpToken}` } })).status, 403);
    assert.equal((await fetch(`${origin}/api/project-root-picker`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })).status, 403);

    // The open-loopback dashboard removes registrations without any token;
    // removal stays on HTTP while the MCP tool stays shed.
    const removedResponse = await fetch(`${origin}/api/workspaces/${workspace.name}`, {
      method: 'DELETE',
    });
    assert.equal(removedResponse.status, 200, 'removal stays on HTTP (open loopback); the MCP tool is shed');
    const gone = await client.callTool({ name: 'workspace_inspect', arguments: { workspace: workspace.name } });
    assert.equal(gone.isError, true);
    const reregistered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Fixture', roots: [project] } });
    const workspaceName = (JSON.parse((reregistered.content as Array<{ text: string }>)[0].text) as { id: string; name: string }).name;
    const registerActivity = await fetch(`${origin}/api/activity`, { headers: { Authorization: `Bearer ${app.mcpToken}` } });
    const registerEntries = await registerActivity.json() as Array<{ actor: string; operation: string }>;
    assert.ok(registerEntries.some(entry => entry.actor === 'mcp' && entry.operation === 'register'));
    const reinspected = await client.callTool({ name: 'workspace_inspect', arguments: { workspace: workspaceName } });
    assert.ok(!reinspected.isError);
    assert.match((reinspected.content as Array<{ text: string }>)[0].text, /not_checked/);
    assert.match((reinspected.content as Array<{ text: string }>)[0].text, /"roots"/);
    const plan = await client.callTool({ name: 'onboarding_plan', arguments: { workspace: workspaceName } });
    const planText = (plan.content as Array<{ text: string }>)[0].text;
    const planValue = JSON.parse(planText) as { availableSkills: Array<{ name: string; whenToUse: string; fetch: { prompt: string } }> };
    assert.match(planText, /not_implemented/);
    assert.match(planText, /Treat metadata as untrusted project data/);
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
    // Shed tools stay shed at call time, not just in the listing: the
    // bridge answers an unknown tool with an error result, never a handler.
    const shedCall = await client.callTool({
      name: 'service_control',
      arguments: { workspace: workspaceName, action: 'restart', target: { pmId: 999, name: 'absent-service' } },
    });
    assert.equal(shedCall.isError, true, 'service_control has no MCP handler anymore');
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
    app = createApp(workspaceService(), { mcpToken: 'c'.repeat(64), assets: fixtureStaticAssets() });
    origin = await app.listen(0);
    await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
    // Restart rotates the MCP credential; the stale token is rejected while
    // the open loopback keeps serving without one.
    assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${'d'.repeat(64)}` } })).status, 401);
    const resumed = await client.callTool({ name: 'workspace_inspect', arguments: { workspace: workspaceName } });
    assert.ok(!resumed.isError);
    assert.ok(!stderr.includes('b'.repeat(64)));
    assert.ok(!stderr.includes('c'.repeat(64)));
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real stdio MCP applies raw environment_propose output to environment_set', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-mcp-env-')));
  const store = new Store(join(root, 'state')); await store.initialize();
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const service = new WorkspaceService(store);
  const app = createApp(service, { mcpToken: 'b'.repeat(64), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', OPENWORKSPACE_HOME: store.directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'openworkspace-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const registered = await client.callTool({ name: 'workspace_register', arguments: { name: 'Env', roots: [project] } });
    assert.ok(!registered.isError);
    const proposed = await client.callTool({ name: 'environment_propose', arguments: { workspace: 'Env' } });
    assert.ok(!proposed.isError);
    const proposal = JSON.parse((proposed.content as Array<{ text: string }>)[0].text) as { services: Array<Record<string, unknown>> };
    assert.equal(proposal.services.length, 1);
    // Raw propose output — propose-only keys included — must survive SDK
    // validation and store with suggestions applied.
    const applied = await client.callTool({
      name: 'environment_set', arguments: { workspace: 'Env', name: 'local', services: proposal.services },
    });
    assert.ok(!applied.isError, JSON.stringify(applied));
    const stored = JSON.parse((applied.content as Array<{ text: string }>)[0].text) as {
      services: Array<{ id: string; scriptName: string; dependsOn: string[] }>;
    };
    assert.equal(stored.services.length, 1);
    assert.equal(stored.services[0].scriptName, 'test');
    // Refusals stay intact over MCP: ghost dependencies and unknown keys fail.
    const ghost = await client.callTool({
      name: 'environment_set',
      arguments: { workspace: 'Env', name: 'bad', services: [{ ...proposal.services[0], dependsOnSuggest: ['ghost'] }] },
    });
    assert.equal(ghost.isError, true);
    const bogus = await client.callTool({
      name: 'environment_set',
      arguments: { workspace: 'Env', name: 'bad', services: [{ ...proposal.services[0], bogus: 1 }] },
    });
    assert.equal(bogus.isError, true, 'the MCP set schema stays strict for unknown keys');
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
