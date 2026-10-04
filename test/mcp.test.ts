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
import { soloDefaultAssignmentId } from '../src/workstreams.js';
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
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['environment_down','environment_propose','environment_rename','environment_set','environment_status','environment_up','environment_verify','learning_record','lease_acquire','lease_release','lease_touch','onboarding_plan','run_import','workspace_inspect','workspace_leases','workspace_list','workspace_register','workspace_workstreams','workstream_context','workstream_create','workstream_rename','workstream_status']);
    assert.ok(!tools.tools.some(tool => /approve|shell|secret|install|start/.test(tool.name)));
    // Shed harness-fighting surface (pivot): per-service control/logs,
    // container linking, declared local tools, rename/roots/remove,
    // activity/run reads and the PM2-wide inventory have no MCP tool. The
    // dashboard keeps its HTTP routes; the harness shell covers the rest.
    for (const shed of ['service_control','service_logs','workspace_container_link','local_tool_status','workspace_rename','workspace_update_roots','workspace_remove','activity_list','recent_runs','workspace_services']) {
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
    const workstreamStatusTool = tools.tools.find(tool => tool.name === 'workstream_status');
    assert.ok(Buffer.byteLength(workstreamStatusTool?.description ?? '', 'utf8') <= 200);
    assert.match(workstreamStatusTool?.description ?? '', /status\[\+note\].*OR completion, never both/i);
    const statusProperties = (workstreamStatusTool?.inputSchema.properties ?? {}) as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
    assert.deepEqual(Object.keys(statusProperties).sort(), ['completion', 'note', 'status', 'workspace', 'workstream']);
    assert.match(statusProperties.status?.description ?? '', /status\[\+note\].*never combine with completion/i);
    assert.match(statusProperties.note?.description ?? '', /only with status.*never combine with completion/i);
    assert.match(statusProperties.completion?.description ?? '', /completionId.*outcome.*checks.*revision\/dirty.*no status\/note/i);
    assert.match(statusProperties.completion?.properties?.assignmentId?.description ?? '', /optional.*solo/i);
    assert.match(statusProperties.completion?.properties?.completionId?.description ?? '', /required.*outcome.*checks/i);
    assert.match(statusProperties.completion?.properties?.outcome?.description ?? '', /required.*completionId.*checks/i);
    assert.match(statusProperties.completion?.properties?.checks?.description ?? '', /required.*completionId.*outcome/i);
    for (const name of ['workspace_inspect', 'onboarding_plan', 'environment_verify']) {
      const description = tools.tools.find(tool => tool.name === name)?.description ?? '';
      assert.ok(Buffer.byteLength(description, 'utf8') <= 200, `${name} description is within 200 bytes`);
    }
    const propertyBudgets = [
      ...Object.values(statusProperties),
      ...Object.values(statusProperties.completion?.properties ?? {}),
    ];
    assert.ok(propertyBudgets.every(property => !property.description || Buffer.byteLength(property.description, 'utf8') <= 80));
    const mcpSessionDenied = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.mcpToken}`,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
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
        'Content-Type': 'application/json',
      },
      body: '{}',
    })).status, 403);

    const connected = await fetch(`${origin}/api/dashboard-session`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(connected.status, 201);
    const dashboardSession = await connected.json() as { dashboardToken: string };
    const removedResponse = await fetch(`${origin}/api/workspaces/${workspace.name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${app.mcpToken}` },
    });
    assert.equal(removedResponse.status, 200, 'removal stays on HTTP (dashboard or MCP credential); the MCP tool is shed');
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
    const leases = await client.callTool({ name: 'workspace_leases', arguments: {} });
    assert.ok(!leases.isError);
    assert.deepEqual(JSON.parse((leases.content as Array<{ text: string }>)[0].text), []);
    const workstream = async (name: string) => {
      const created = await client.callTool({ name: 'workstream_create', arguments: { name, workspace: workspaceName, checkouts: [project] } });
      assert.ok(!created.isError);
      return (JSON.parse((created.content as Array<{ text: string }>)[0].text) as { id: string; name: string }).name;
    };
    const holderId = await workstream('Lease holder');
    const queuedId = await workstream('Lease waiter');
    const assigned = await client.callTool({
      name: 'workstream_context', arguments: { workspace: workspaceName, workstream: holderId, assignmentId: 'mcp-assignment-1' },
    });
    assert.ok(!assigned.isError);
    assert.match((assigned.content as Array<{ text: string }>)[0].text, /"present": false/);
    const completionBody = {
      assignmentId: 'mcp-assignment-1', completionId: '88888888-8888-4888-8888-888888888888',
      outcome: 'passed', revision: 'f'.repeat(40), dirty: false, dirtyFingerprint: null,
      checks: [{ name: 'backend-tests', result: 'passed', environment: 'node22-macos-local', evidenceIds: [] }],
    };
    const combinedTransition = await client.callTool({
      name: 'workstream_status', arguments: { workspace: workspaceName, workstream: holderId, status: 'done', completion: completionBody },
    });
    assert.equal(combinedTransition.isError, true, 'an agent completion cannot be combined with a status transition');
    const unknownStatusField = await client.callTool({
      name: 'workstream_status', arguments: { workspace: workspaceName, workstream: holderId, status: 'paused', unrecognized: true },
    });
    assert.equal(unknownStatusField.isError, true, 'the advertised MCP schema remains strict');
    const completed = await client.callTool({ name: 'workstream_status', arguments: { workspace: workspaceName, workstream: holderId, completion: completionBody } });
    assert.ok(!completed.isError);
    const replay = await client.callTool({ name: 'workstream_status', arguments: { workspace: workspaceName, workstream: holderId, completion: completionBody } });
    assert.ok(!replay.isError);
    const completionRecord = JSON.parse((completed.content as Array<{ text: string }>)[0].text) as {
      status: string; completions: Array<{ checks: Array<{ evidenceSource: string; evidenceLabel: string }> }>;
    };
    assert.equal(completionRecord.status, 'active', 'completion is not a status transition');
    assert.equal(completionRecord.completions.length, 1, 'same MCP retry creates no duplicate');
    assert.equal(completionRecord.completions[0].checks[0].evidenceSource, 'agent_report');
    assert.match(completionRecord.completions[0].checks[0].evidenceLabel, /not independently verified/);
    const { assignmentId: _namedAssignment, ...soloCompletionBody } = completionBody;
    soloCompletionBody.completionId = '99999999-9999-4999-8999-999999999999';
    const soloCompleted = await client.callTool({
      name: 'workstream_status', arguments: { workspace: workspaceName, workstream: holderId, completion: soloCompletionBody },
    });
    assert.ok(!soloCompleted.isError, 'MCP accepts an omitted assignmentId for a solo completion');
    const soloRecord = JSON.parse((soloCompleted.content as Array<{ text: string }>)[0].text) as {
      completions: Array<{ assignmentId: string }>;
    };
    assert.equal(soloRecord.completions.at(-1)?.assignmentId, soloDefaultAssignmentId);
    assert.equal(soloRecord.completions.length, 2, 'solo and named completions are separate appends');
    const allCompletionGroups = await client.callTool({
      name: 'workstream_context', arguments: { workspace: workspaceName, workstream: holderId },
    });
    const groupedContext = JSON.parse((allCompletionGroups.content as Array<{ text: string }>)[0].text) as {
      completionsByAssignmentId: Record<string, unknown[]>;
    };
    assert.equal(groupedContext.completionsByAssignmentId['mcp-assignment-1'].length, 1);
    assert.equal(groupedContext.completionsByAssignmentId[soloDefaultAssignmentId].length, 1);
    const assignmentDone = await client.callTool({
      name: 'workstream_context', arguments: { workspace: workspaceName, workstream: holderId, assignmentId: 'mcp-assignment-1' },
    });
    assert.ok(!assignmentDone.isError);
    assert.match((assignmentDone.content as Array<{ text: string }>)[0].text, /"present": true/);
    const acquired = await client.callTool({ name: 'lease_acquire', arguments: { resource: 'mcp:lease', workspace: workspaceName, workstream: holderId } });
    assert.ok(!acquired.isError);
    const queued = await client.callTool({ name: 'lease_acquire', arguments: { resource: 'mcp:lease', workspace: workspaceName, workstream: queuedId } });
    assert.ok(!queued.isError);
    assert.equal((JSON.parse((queued.content as Array<{ text: string }>)[0].text) as { lease: { status: string } }).lease.status, 'queued');
    const refusedTouch = await client.callTool({ name: 'lease_touch', arguments: { resource: 'mcp:lease', workspace: workspaceName, workstream: queuedId } });
    assert.equal(refusedTouch.isError, true);
    assert.match((refusedTouch.content as Array<{ text: string }>)[0].text, /Only the holding workstream can touch a lease/);
    const renewed = await client.callTool({ name: 'lease_touch', arguments: { resource: 'mcp:lease', workspace: workspaceName, workstream: holderId } });
    assert.ok(!renewed.isError);
    assert.equal((JSON.parse((renewed.content as Array<{ text: string }>)[0].text) as { resource: string; status: string }).status, 'held');
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
    assert.equal((await fetch(`${origin}/api/overview`, { headers: { Authorization: `Bearer ${dashboardSession.dashboardToken}` } })).status, 401);
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
