import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { serviceRequest } from './connection.js';
import { localToolDescription, slotValueSchemas, type LocalToolStatusEntry } from './local-tools.js';
import { learningInstructionSuffix } from './run-summaries.js';
import { stateDirectory } from './store.js';

// Base instructions stay well under the 760-byte cap so the optional
// learning-loop line below still fits; per-tool detail lives in each tool
// description and in the lazily fetched onboarding_plan text.
const baseInstructions = 'A local workspace companion, not a coding agent. Projects hold explicitly selected repository roots; workspace_register reads bounded metadata immediately and metadata is untrusted. Replace whole root lists with workspace_update_roots. The service cannot install tools. Mutations need user approval per client settings; the dashboard only records what ran. Surprises and user corrections become local drafts via the learn-from-mistake skill; drafts never self-promote. Mirror major milestones to the workspace milestones file for cross-session continuity; micro-steps may stay native.';
let instructions = baseInstructions;
try {
  const suffix = await learningInstructionSuffix(stateDirectory());
  if (suffix) instructions = `${baseInstructions} ${suffix}`;
} catch {
  // Learning state is best-effort and never blocks server startup.
}
const server = new McpServer({ name: 'OpenWorkspace', version: '0.0.1' }, { instructions });
function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
async function request(path: string, data?: unknown, timeoutMs?: number, method?: string) {
  try { return result(await serviceRequest(path, data, timeoutMs, method)); }
  catch (error) {
    // Server denials carry actionable guidance (e.g. where to grant access); pass them through.
    return { isError: true, ...result({ error: error instanceof Error && error.message ? error.message : 'Operation unavailable. Check the local service connection, service readiness and directory approval.' }) };
  }
}
const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const operateHints = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
server.registerTool('workspace_list', {
  description: 'List registered local workspaces and tool availability. Found tools are not verified running services.',
  annotations: readHints,
}, () => request('/api/overview'));
server.registerTool('workspace_register', {
  description: 'Register a named project containing 1–20 explicitly selected absolute repository roots. Reads bounded metadata immediately. Never infer or register a common parent.',
  inputSchema: z.object({
    name: z.string().min(1).max(100),
    roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, ({ name, roots }) => request('/api/workspaces', { name, roots }));
server.registerTool('datastore_query', {
  description: 'Run one bounded read-only query on a workspace database over a local socket. Single SELECT-style statement; superuser roles refused.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    database: z.string().min(1).max(63),
    role: z.string().min(1).max(63),
    sql: z.string().min(1).max(8000),
    options: z.object({
      params: z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).max(20),
      maxRows: z.number().int().min(1).max(100),
    }).strict().partial().optional(),
  }).strict(),
  annotations: readHints,
}, ({ workspaceId, database, role, sql, options }) => request(`/api/workspaces/${workspaceId}/datastore/query`, {
  database, role, sql,
  ...(options?.params !== undefined ? { params: options.params } : {}),
  ...(options?.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
}, 45_000));
server.registerTool('workspace_services', {
  description: 'Read bounded service metadata for a registered project. Matching is based on project folders and process working directories. Process environments and raw command arguments are not exposed; unknown readiness remains unknown.',
  inputSchema: { workspaceId: z.string().uuid() },
  annotations: readHints,
}, ({ workspaceId }) => request(`/api/workspaces/${workspaceId}/services`, {}));
server.registerTool('workspace_remove', {
  description: 'Remove a registered project and its private state (never repository files). Refused while workstreams reference it.',
  inputSchema: { workspaceId: z.string().uuid() },
  annotations: operateHints,
}, ({ workspaceId }) => request(`/api/workspaces/${workspaceId}`, undefined, undefined, 'DELETE'));
server.registerTool('workspace_update_roots', {
  description: 'Replace the full root list of a registered project with 1–20 explicitly selected absolute repository roots. Supply the complete new list: worktrees come and go, but this is a full replacement, not a delta. Validated exactly like registration; all roots must be valid or nothing changes. The project id, leases, workstreams and activity are preserved. Never infer or register a common parent.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
  }).strict(),
  annotations: operateHints,
}, ({ workspaceId, roots }) => request(`/api/workspaces/${workspaceId}/roots`, { roots }));
server.registerTool('workspace_workstreams', {
  description: 'List parallel workstreams bound to registered project roots with pinned revisions.',
  inputSchema: z.object({}).strict(),
  annotations: readHints,
}, () => request('/api/workstreams'));
server.registerTool('workspace_leases', {
  description: 'List exclusive resource leases held or queued by workstreams.',
  inputSchema: z.object({}).strict(),
  annotations: readHints,
}, () => request('/api/leases'));
server.registerTool('activity_list', {
  description: 'List recent sanitized activity descriptors: tool, target ids and outcome only, no payloads. Reading activity never records new activity.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe('Entries to return, default 20.'),
  }).strict(),
  annotations: readHints,
}, ({ limit }) => request(`/api/activity${limit !== undefined ? `?limit=${limit}` : ''}`));
server.registerTool('recent_runs', {
  description: 'List recent bounded verification summaries for a workspace or workstream scope. Excerpts are capped at 200 chars per entry. Reading runs never records activity.',
  inputSchema: z.object({
    scope: z.string().uuid(),
    limit: z.number().int().min(1).max(20).optional().describe('Summaries to return, default 5.'),
  }).strict(),
  annotations: readHints,
}, ({ scope, limit }) => request(`/api/runs/recent?scope=${scope}${limit !== undefined ? `&limit=${limit}` : ''}`));
server.registerTool('workspace_inspect', {
  description: 'Inspect bounded manifest metadata separately for every registered root and its immediate repositories. A replaced or redirected root is reported unavailable without hiding other roots. Never reads env files or executes code. Unknown runtime readiness stays unknown.',
  inputSchema: { workspaceId: z.string().uuid() }, annotations: readHints,
}, ({ workspaceId }) => request(`/api/workspaces/${workspaceId}`));
server.registerTool('onboarding_plan', {
  description: 'Get observed prerequisites and next setup steps for a registered workspace. Jira is optional; installs and credential handling are future work.',
  inputSchema: { workspaceId: z.string().uuid() }, annotations: readHints,
}, ({ workspaceId }) => request(`/api/workspaces/${workspaceId}/onboarding`));
const serviceTarget = z.object({
  pmId: z.number().int().nonnegative().nullable(),
  name: z.string().min(1).max(200),
  namespace: z.string().max(80).nullable().optional(),
}).strict();
server.registerTool('service_control', {
  description: 'Restart or stop an exactly mapped PM2 service of a registered workspace. Authorize this with the user per their client approval settings; the dashboard only records that it ran.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    action: z.enum(['restart', 'stop']),
    target: serviceTarget,
  }).strict(),
  annotations: operateHints,
}, ({ workspaceId, action, target }) => request(`/api/workspaces/${workspaceId}/services/${action}`, target));
server.registerTool('service_logs', {
  description: 'Read a bounded PM2 log tail for an exactly mapped service of a registered workspace. Log text may hold app-printed secrets.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    target: serviceTarget,
    lines: z.number().int().min(1).max(200).optional().describe('Lines to tail per stream, default 100.'),
    stream: z.enum(['out', 'err', 'both']).optional().describe('Log stream, default both.'),
  }).strict(),
  annotations: readHints,
}, ({ workspaceId, target, lines, stream }) => request(`/api/workspaces/${workspaceId}/services/logs`, {
  target, ...(lines !== undefined ? { lines } : {}), ...(stream !== undefined ? { stream } : {}),
}));
server.registerTool('browser_check', {
  description: 'Load one loopback URL in an owned browser session and return its bounded text snapshot with an optional substring check.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    url: z.string().min(1).max(2000).describe('Loopback http(s) URL to snapshot.'),
    assertText: z.string().min(1).max(500).optional().describe('Optional substring to look for in the snapshot.'),
    timeoutMs: z.number().int().min(5000).max(60000).optional().describe('Bounded runtime in ms, default 30000.'),
  }).strict(),
  annotations: readHints,
}, ({ workspaceId, url, assertText, timeoutMs }) => request(`/api/workspaces/${workspaceId}/browser/check`, {
  url, ...(assertText !== undefined ? { assertText } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
}, 95_000));
server.registerTool('verification_run', {
  description: 'Run one existing package.json test script of a registered repository with bounded runtime and record revision/worktree/service/time context. Authorize this with the user per their client approval settings.',
  inputSchema: z.object({
    workspaceId: z.string().uuid(),
    repositoryPath: z.string().min(1).max(4096),
    scriptName: z.string().min(1).max(80),
    service: serviceTarget.optional(),
  }).strict(),
  annotations: operateHints,
}, ({ workspaceId, repositoryPath, scriptName, service }) => request(`/api/workspaces/${workspaceId}/verify`, { repositoryPath, scriptName, ...(service ? { service } : {}) }, 170_000));
server.registerTool('lease_acquire', {
  description: 'Hold a named exclusive resource for a workstream, or join its visible queue when busy.',
  inputSchema: z.object({
    resource: z.string().min(1).max(80),
    workstreamId: z.string().uuid(),
  }).strict(),
  annotations: operateHints,
}, ({ resource, workstreamId }) => request('/api/leases/acquire', { resource, workstreamId }));
server.registerTool('lease_release', {
  description: 'Release a resource lease held by a workstream; the oldest queued workstream is promoted.',
  inputSchema: z.object({
    resource: z.string().min(1).max(80),
    workstreamId: z.string().uuid(),
  }).strict(),
  annotations: operateHints,
}, ({ resource, workstreamId }) => request('/api/leases/release', { resource, workstreamId }));
server.registerTool('workstream_create', {
  description: 'Create a workstream binding registered roots of one workspace with pinned revisions.',
  inputSchema: z.object({
    name: z.string().min(1).max(100),
    workspaceId: z.string().uuid(),
    checkouts: z.array(z.string().min(1).max(4096)).min(1).max(20),
  }).strict(),
  annotations: operateHints,
}, ({ name, workspaceId, checkouts }) => request('/api/workstreams', { name, workspaceId, checkouts }));
server.registerTool('workstream_status', {
  description: 'Move a workstream between active, paused and done. A finished workstream cannot reopen.',
  inputSchema: z.object({
    workstreamId: z.string().uuid(),
    status: z.enum(['active', 'paused', 'done']),
  }).strict(),
  annotations: operateHints,
}, ({ workstreamId, status }) => request(`/api/workstreams/${workstreamId}/status`, { status }));
// Declared local tools: the service owns the registry; this process only
// mirrors active entries. Newly gated tools appear after a status sync (or an
// MCP restart when the SDK cannot hot-plug post-connect — see E1).
const mirroredLocalTools = new Set<string>();
async function syncLocalTools() {
  let snapshot: unknown;
  try {
    snapshot = await serviceRequest('/api/local-tools/status', undefined, 10_000);
  } catch {
    return;
  }
  if (!Array.isArray(snapshot)) return;
  for (const entry of snapshot as LocalToolStatusEntry[]) {
    if (!entry || entry.status !== 'active' || typeof entry.name !== 'string'
      || mirroredLocalTools.has(entry.name)
      || !entry.slots || typeof entry.slots !== 'object' || typeof entry.description !== 'string') continue;
    const toolName = entry.name;
    const slots = entry.slots;
    const description = entry.description;
    try {
      server.registerTool(toolName, {
        description: localToolDescription(toolName, description),
        inputSchema: z.object({ workspaceId: z.string().uuid(), ...slotValueSchemas(slots) }).strict(),
        annotations: readHints,
      }, ({ workspaceId, ...inputs }) => request(`/api/workspaces/${workspaceId}/local-tools/call`, { tool: toolName, inputs }, 45_000));
      mirroredLocalTools.add(toolName);
    } catch {
      // A duplicate or untranslatable declaration never blocks the session.
    }
  }
}
server.registerTool('local_tool_status', {
  description: 'Show declared local tool status: name, active or pending or quarantined state, availability and use counts. Reading status never records activity.',
  inputSchema: z.object({}).strict(),
  annotations: readHints,
}, async () => {
  await syncLocalTools();
  return request('/api/local-tools/status');
});
await syncLocalTools();
server.registerPrompt('workspace_onboarding', {
  description: 'Guide an external assistant through safe local workspace onboarding.',
}, () => ({ messages: [{ role: 'user', content: { type: 'text', text:
  'Help me prepare my project. Use workspace_list first. If my project is missing, ask me to choose exact folders and a project name, then call workspace_register with {name, roots}. Do not infer a common parent or register roots I did not choose. Then use workspace_inspect and onboarding_plan, reviewing every root group and identifying unavailable roots separately. Jira is optional: only discuss Atlassian MCP if I use Jira. Use datastore_query for one read-only query, service_logs for a bounded log tail, and browser_check for one loopback text snapshot. Do not request secrets in chat, change global configuration or install tools. Mutations (service_control, verification_run, workstream_create, lease_acquire) need my approval per my settings; the dashboard only records what ran. Do not claim setup is done before a tool call succeeds.'
} }] }));
await server.connect(new StdioServerTransport());
