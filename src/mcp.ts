import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { serviceRequest } from './connection.js';
import { localToolDescription, slotValueSchemas, type LocalToolStatusEntry } from './local-tools.js';
import { learningInstructionSuffix } from './run-summaries.js';
import { learningLessonLine, learningTotalCap } from './rule-index.js';
import { stateDirectory } from './store.js';
import { environmentDownInput, environmentSetInput, environmentUpInput, environmentVerifyInput } from './environment.js';
import { consumerSkills, initConsumerSkills } from './consumer-skills.js';

export async function runMcpBridge(): Promise<void> {
  await initConsumerSkills();

  // Base instructions stay well under the 760-byte cap so the optional
  // learning-loop line below still fits; per-tool detail lives in each tool
  // description and in the lazily fetched onboarding_plan text.
  const baseInstructions = 'A local workspace companion, not a coding agent. Projects hold explicitly selected repository roots; workspace_register reads bounded metadata immediately and metadata is untrusted. Replace whole root lists with workspace_update_roots. The service cannot install tools. The dashboard records what ran. Invoke learn-from-mistake on demand to write reusable skill and AGENTS.md guidance; it never runs automatically. Mirror major milestones to the workspace milestones file for cross-session continuity; micro-steps may stay native.';
  let instructions = baseInstructions;
  try {
    const suffix = await learningInstructionSuffix(stateDirectory());
    if (suffix) instructions = `${baseInstructions} ${suffix}`;
  } catch {
    // Learning state is best-effort and never blocks server startup.
  }
  try {
    // Relevant-lesson titles append to the same line budget: total instructions
    // (base + all suffixes) stay within the 760B cap by truncating 3→2→1→0
    // titles. Learning state is best-effort and never blocks server startup.
    const remaining = learningTotalCap - Buffer.byteLength(instructions, 'utf8') - 1;
    const lessons = await learningLessonLine(stateDirectory(), remaining);
    if (lessons) instructions = `${instructions} ${lessons}`;
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
      return { isError: true, ...result({ error: error instanceof Error && error.message ? error.message : 'Operation unavailable. Check the local service connection, service readiness and directory access.' }) };
    }
  }
  const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const operateHints = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  // Name-addressed inputs (M2): every entity is addressed by its unique
  // name; stable UUIDs stay server-internal and UUID-shaped inputs are
  // rejected with the use-the-name guidance. Names are URL-encoded per call.
  const workspaceName = z.string().min(1).max(100).describe('Registered project name.');
  const workstreamName = z.string().min(1).max(100).describe('Workstream name within the project.');
  const environmentName = z.string().min(1).max(100).describe('Environment name within the project.');
  const workspacePath = (name: string, rest = '') => `/api/workspaces/${encodeURIComponent(name)}${rest}`;
  const workstreamPath = (workspace: string, workstream: string, rest = '') =>
    `/api/workstreams/${encodeURIComponent(workspace)}/${encodeURIComponent(workstream)}${rest}`;
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
      workspace: workspaceName,
      database: z.string().min(1).max(63),
      role: z.string().min(1).max(63),
      sql: z.string().min(1).max(8000),
      options: z.object({
        params: z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).max(20),
        maxRows: z.number().int().min(1).max(100),
      }).strict().partial().optional(),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, database, role, sql, options }) => request(workspacePath(workspace, '/datastore/query'), {
    database, role, sql,
    ...(options?.params !== undefined ? { params: options.params } : {}),
    ...(options?.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
  }, 45_000));
  server.registerTool('workspace_services', {
    description: 'Bounded PM2/Docker metadata: Compose labels map exact roots; explicit links map Docker IDs. Unmanaged counts only unless includeUnmanaged=true (names/images). No env/args; readiness unknown.',
    inputSchema: z.object({
      workspace: workspaceName,
      includeUnmanaged: z.boolean().describe('Include names and images for unmanaged containers; default false.').optional(),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, includeUnmanaged }) => request(workspacePath(workspace, '/services'), {
    ...(includeUnmanaged !== undefined ? { includeUnmanaged } : {}),
  }));
  server.registerTool('workspace_container_link', {
    description: 'Link/unlink a Docker container by full ID or unique 12+ hex-character prefix. No name guessing. Link requires a present container; unlink can remove stale links.',
    inputSchema: z.object({
      workspace: workspaceName,
      action: z.enum(['link', 'unlink']).describe('Explicitly link to or unlink from this workspace.'),
      containerId: z.string().regex(/^[a-f\d]{12,64}$/i).describe('Full 64-hex ID or unique prefix of at least 12 hex characters; no names.'),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, action, containerId }) => request(workspacePath(workspace, '/containers/link'), { action, containerId }));
  server.registerTool('workspace_remove', {
    description: 'Remove a registered project and its private state (never repository files). Refused while workstreams reference it.',
    inputSchema: z.object({ workspace: workspaceName }).strict(),
    annotations: operateHints,
  }, ({ workspace }) => request(workspacePath(workspace), undefined, undefined, 'DELETE'));
  server.registerTool('workspace_rename', {
    description: 'Rename a registered project, preserving its ID and owned state. Refused when the name is taken.',
    inputSchema: z.object({
      workspace: workspaceName.describe('Current project name.'),
      name: z.string().min(1).max(100).describe('New project name.'),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, name }) => request(workspacePath(workspace, '/rename'), { name }));
  server.registerTool('workspace_update_roots', {
    description: 'Replace the full root list of a registered project with 1–20 explicitly selected absolute repository roots. Supply the complete new list: worktrees come and go, but this is a full replacement, not a delta. Validated exactly like registration; all roots must be valid or nothing changes. The project identity, leases, workstreams and activity are preserved. Never infer or register a common parent.',
    inputSchema: z.object({
      workspace: workspaceName,
      roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, roots }) => request(workspacePath(workspace, '/roots'), { roots }));
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
    description: 'List recent bounded run summaries for a workspace or workstream scope, each labeled source openworkspace-run (executed here) or external-import (pasted on trust, not verified here). Excerpts are capped at 200 chars per entry. Reading runs never records activity.',
    inputSchema: z.object({
      workspace: workspaceName,
      workstream: workstreamName.describe('Optional workstream within the project.').optional(),
      limit: z.number().int().min(1).max(20).optional().describe('Summaries to return, default 5.'),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, workstream, limit }) => {
    const params = new URLSearchParams({ workspace });
    if (workstream !== undefined) params.set('workstream', workstream);
    if (limit !== undefined) params.set('limit', String(limit));
    return request(`/api/runs/recent?${params}`);
  });
  server.registerTool('workspace_inspect', {
    description: 'Inspect bounded manifest metadata separately for every registered root and its immediate repositories. A replaced or redirected root is reported unavailable without hiding other roots. Never reads env files or executes code. Unknown runtime readiness stays unknown.',
    inputSchema: z.object({ workspace: workspaceName }).strict(), annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace)));
  server.registerTool('onboarding_plan', {
    description: 'Get observed prerequisites and next setup steps for a registered workspace. Jira is optional; installs and credential handling are future work.',
    inputSchema: z.object({ workspace: workspaceName }).strict(), annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace, '/onboarding')));
  const serviceTarget = z.object({
    pmId: z.number().int().nonnegative().nullable(),
    name: z.string().min(1).max(200),
    namespace: z.string().max(80).nullable().optional(),
  }).strict();
  // service_control carries restart/stop and start in one tool: restart/stop
  // address an exactly mapped process via target, while start launches one
  // existing package.json script as a PM2 process via start. The strict
  // object schema is advertised (ZodEffects JSON Schema conversion drops
  // properties) and the cross-field XOR is enforced when the handler parses.
  const serviceStartInput = z.object({
    repositoryPath: z.string().min(1).max(4096),
    scriptName: z.string().min(1).max(80),
    name: z.string().min(1).max(80).optional(),
  }).strict();
  const serviceControlObjectSchema = z.object({
    workspace: workspaceName,
    action: z.enum(['restart', 'stop', 'start']),
    target: serviceTarget.optional(),
    start: serviceStartInput.optional(),
  }).strict();
  const serviceControlSchema = serviceControlObjectSchema.refine(input =>
    (input.action === 'start' && input.start !== undefined && input.target === undefined)
    || (input.action !== 'start' && input.target !== undefined && input.start === undefined));
  server.registerTool('service_control', {
    description: 'Control an exactly mapped PM2 service: restart/stop it, or start one existing package.json script as a PM2 process. Dashboard records it.',
    inputSchema: serviceControlObjectSchema,
    annotations: operateHints,
  }, args => {
    const { workspace, action, target, start } = serviceControlSchema.parse(args);
    return action === 'start'
      ? request(workspacePath(workspace, '/services/start'), start)
      : request(workspacePath(workspace, `/services/${action}`), target);
  });
  server.registerTool('service_logs', {
    description: 'Read bounded PM2 tails for mapped services and Docker tails for mapped or explicitly linked containers. Docker streams are combined. Logs may contain app-printed secrets and are never persisted.',
    inputSchema: z.object({
      workspace: workspaceName,
      target: z.union([serviceTarget, z.object({
        runner: z.literal('docker'),
        containerId: z.string().regex(/^[a-f\d]{64}$/i),
        name: z.string().min(1).max(256),
      }).strict()]),
      lines: z.number().int().min(1).max(200).optional().describe('Lines to tail, default 100 (PM2 per stream; Docker combined).'),
      stream: z.enum(['out', 'err', 'both']).optional().describe('Log stream, default both.'),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, target, lines, stream }) => request(workspacePath(workspace, '/services/logs'), {
    target, ...(lines !== undefined ? { lines } : {}), ...(stream !== undefined ? { stream } : {}),
  }));
  server.registerTool('browser_check', {
    description: 'Load one loopback URL in an owned browser session and return its bounded text snapshot with an optional substring check.',
    inputSchema: z.object({
      workspace: workspaceName,
      url: z.string().min(1).max(2000).describe('Loopback http(s) URL to snapshot.'),
      assertText: z.string().min(1).max(500).optional().describe('Optional substring to look for in the snapshot.'),
      timeoutMs: z.number().int().min(5000).max(60000).optional().describe('Bounded runtime in ms, default 30000.'),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, url, assertText, timeoutMs }) => request(workspacePath(workspace, '/browser/check'), {
    url, ...(assertText !== undefined ? { assertText } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }, 95_000));
  server.registerTool('verification_run', {
    description: 'Run one existing package.json test script of a registered repository with bounded runtime and record revision/worktree/service/time context.',
    inputSchema: z.object({
      workspace: workspaceName,
      repositoryPath: z.string().min(1).max(4096),
      scriptName: z.string().min(1).max(80),
      service: serviceTarget.optional(),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, repositoryPath, scriptName, service }) => request(workspacePath(workspace, '/verify'), { repositoryPath, scriptName, ...(service ? { service } : {}) }, 170_000));
  // M1 environment topology: discovery-proposed candidates (read-only),
  // stored set (full replacement per env name), and read-only status.
  // The client permission model is the authority, and the mutating call
  // itself (visible in activity_list) is the audit record. Compose files are
  // presence-only, never controlled; readiness/E2E stay loopback-only.
  // Tool schemas reuse the canonical environment inputs (single definition
  // site in environment.ts): the set tool spreads environmentSetInput's
  // shape alongside the path-scoped workspace name, so charset/caps/defaults
  // cannot diverge between MCP and HTTP.
  server.registerTool('environment_propose', {
    description: 'Derive owned multi-service topology candidates from workspace discovery (scripts, compose presence, Procfile/Makefile/port hints). Read-only: nothing is executed, stored or spawned.',
    inputSchema: z.object({ workspace: workspaceName }).strict(),
    annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace, '/environments/propose'), {}));
  server.registerTool('environment_set', {
    description: 'Persist the environment topology (full replacement per env name). Propose output is a starting draft; this call applies it and is the record.',
    inputSchema: z.object({ workspace: workspaceName, ...environmentSetInput.shape }).strict(),
    annotations: operateHints,
  }, ({ workspace, name, services }) => request(workspacePath(workspace, '/environments/set'), { name, services }));
  server.registerTool('environment_status', {
    description: 'Read per-service environment status (down/starting/ready/failed/skipped/stale; never starts or stops anything). Process-alive services report at most starting.',
    inputSchema: z.object({
      workspace: workspaceName,
      environment: environmentName,
    }).strict(),
    annotations: readHints,
  }, ({ workspace, environment }) => request(`${workspacePath(workspace, '/environments/status')}?environment=${encodeURIComponent(environment)}`));
  // M2 runtime (owned-only + loopback-only; Compose is presence-only, never
  // controlled). The client permission model is the authority, and each
  // mutating call itself (visible in activity_list) is the audit record.
  server.registerTool('environment_up', {
    description: 'Start an owned multi-service environment in dependency order with port preflight (refuse, never kill) and http-200/process-alive readiness. This call applies the stored topology and is the record.',
    inputSchema: z.object({ workspace: workspaceName, ...environmentUpInput.shape }).strict(),
    annotations: operateHints,
  }, ({ workspace, environment }) => request(workspacePath(workspace, '/environments/up'), { environment }, 170_000));
  server.registerTool('environment_down', {
    description: 'Stop exactly the owned processes of an environment in reverse dependency order (expectedRoot-checked; stale clears without a stop call; foreign processes and listeners are never touched).',
    inputSchema: z.object({ workspace: workspaceName, ...environmentDownInput.shape }).strict(),
    annotations: operateHints,
  }, ({ workspace, environment }) => request(workspacePath(workspace, '/environments/down'), { environment }, 60_000));
  server.registerTool('environment_verify', {
    description: 'Run one repo-native script against the live owned environment and pin a capped identity receipt to the run. Readiness targets are loopback-only; the script itself runs the existing bounded npm path.',
    inputSchema: z.object({ workspace: workspaceName, ...environmentVerifyInput.shape }).strict(),
    annotations: operateHints,
  }, ({ workspace, environment, repositoryPath, scriptName }) => request(workspacePath(workspace, '/environment/verify'), { environment, repositoryPath, scriptName }, 170_000));
  server.registerTool('environment_rename', {
    description: 'Rename a stored environment, preserving its ID, owned processes and lifecycle state. Refused when the name is taken.',
    inputSchema: z.object({
      workspace: workspaceName,
      environment: environmentName.describe('Current environment name.'),
      name: z.string().min(1).max(100).describe('New environment name.'),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, environment, name }) => request(`${workspacePath(workspace, '/environments')}/${encodeURIComponent(environment)}/rename`, { name }));
  server.registerTool('lease_acquire', {
    description: 'Hold a named exclusive resource for a workstream, or join its visible queue when busy.',
    inputSchema: z.object({
      resource: z.string().min(1).max(80),
      workspace: workspaceName,
      workstream: workstreamName,
    }).strict(),
    annotations: operateHints,
  }, ({ resource, workspace, workstream }) => request('/api/leases/acquire', { resource, workspace, workstream }));
  server.registerTool('lease_release', {
    description: 'Release a resource lease held by a workstream; the oldest queued workstream is promoted.',
    inputSchema: z.object({
      resource: z.string().min(1).max(80),
      workspace: workspaceName,
      workstream: workstreamName,
    }).strict(),
    annotations: operateHints,
  }, ({ resource, workspace, workstream }) => request('/api/leases/release', { resource, workspace, workstream }));
  server.registerTool('lease_touch', {
    description: 'Renew a held lease for ten minutes per touch; renewable indefinitely while holder lives. Queue progresses on crash/stop/finish/release. Only the holder may touch.',
    inputSchema: z.object({
      resource: z.string().min(1).max(80),
      workspace: workspaceName,
      workstream: workstreamName,
    }).strict(),
    annotations: operateHints,
  }, ({ resource, workspace, workstream }) => request('/api/leases/touch', { resource, workspace, workstream }));
  server.registerTool('workstream_create', {
    description: 'Create a workstream binding registered roots of one workspace with pinned revisions.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      workspace: workspaceName,
      checkouts: z.array(z.string().min(1).max(4096)).min(1).max(20),
    }).strict(),
    annotations: operateHints,
  }, ({ name, workspace, checkouts }) => request('/api/workstreams', { name, workspace, checkouts }));
  server.registerTool('workstream_rename', {
    description: 'Rename a workstream, preserving its ID, checkouts, history and leases. Refused when the name is taken in the project.',
    inputSchema: z.object({
      workspace: workspaceName,
      workstream: workstreamName.describe('Current workstream name.'),
      name: z.string().min(1).max(100).describe('New workstream name.'),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, workstream, name }) => request(workstreamPath(workspace, workstream, '/rename'), { name }));
  const workstreamStatusObjectSchema = z.object({
      workspace: workspaceName,
      workstream: workstreamName,
      status: z.enum(['active', 'paused', 'done']).describe('Status[+note] only; never combine with completion.').optional(),
      note: z.object({
        goal: z.string().min(1).max(1000),
        blocker: z.string().max(1000),
        next: z.string().min(1).max(1000),
        owner: z.enum(['agent', 'user']),
        evidence: z.array(z.string().max(256)).max(50).optional(),
      }).strict().describe('Optional only with status; never combine with completion.').optional(),
      completion: z.object({
        assignmentId: z.string().min(1).max(128).describe('Optional; omission means a solo completion.').optional(),
        completionId: z.string().uuid().describe('Required with outcome and checks in the completion call shape.'),
        outcome: z.enum(['passed', 'blocked', 'failed']).describe('Required with completionId and checks.'),
        revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
        dirty: z.boolean().nullable(),
        dirtyFingerprint: z.object({
          diffHash: z.string().regex(/^[0-9a-f]{64}$/),
          files: z.array(z.string().min(1).max(256)).max(50),
          truncated: z.boolean(),
        }).strict().nullable().describe('Required revision/dirty metadata for a completion.'),
        checks: z.array(z.object({
          name: z.string().min(1).max(80),
          result: z.enum(['passed', 'failed', 'error']),
          environment: z.string().min(1).max(200),
          evidenceIds: z.array(z.string().max(128)).max(5).optional(),
        }).strict()).min(1).max(20).describe('Required with completionId and outcome; include at least one check.'),
      }).strict().describe('Requires completionId, outcome, checks and revision/dirty data; no status/note.').optional(),
  }).strict();
  const workstreamStatusSchema = workstreamStatusObjectSchema.refine(input =>
    (input.status !== undefined && input.completion === undefined)
    || (input.status === undefined && input.completion !== undefined && input.note === undefined),
  );
  server.registerTool('workstream_status', {
    description: 'Use status[+note] OR completion, never both. Completion requires completionId, outcome, checks and revision/dirty data; assignmentId is optional for solo work. Agent-reported, not verified.',
    // Keep the advertised strict object schema separate from the cross-field XOR
    // refinement; the SDK's ZodEffects JSON Schema conversion drops properties.
    inputSchema: workstreamStatusObjectSchema,
    annotations: operateHints,
  }, args => {
    const { workspace, workstream, status, note, completion } = workstreamStatusSchema.parse(args);
    return request(workstreamPath(workspace, workstream, '/status'), completion
      ? { completion }
      : note === undefined ? { status } : { status, note });
  });
  server.registerTool('workstream_context', {
    description: 'One-call handoff: checkpoint, assignment completions by ID/latest, checkouts, scoped recent runs plus situational lessons matched to this task. Read-only.',
    inputSchema: z.object({
      workspace: workspaceName,
      workstream: workstreamName,
      limit: z.number().int().min(1).max(20).optional().describe('Recent runs to include, default 5.'),
      assignmentId: z.string().min(1).max(128).optional().describe('Coordinator-issued ID to query present/missing completion.'),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, workstream, limit, assignmentId }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (assignmentId !== undefined) params.set('assignmentId', assignmentId);
    const query = params.size ? `?${params}` : '';
    return request(`${workstreamPath(workspace, workstream, '/context')}${query}`);
  });
  server.registerTool('run_import', {
    description: 'Record a pasted external result as external-import: accepted on trust, NEVER presented as verified here. Strict bounded fields with a masked excerpt; verification claims are refused.',
    inputSchema: z.object({
      workspace: workspaceName,
      scriptName: z.string().min(1).max(80),
      outcome: z.enum(['passed', 'failed', 'error']),
      durationMs: z.number().finite().min(0).max(86_400_000),
      excerpt: z.string().max(500),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, scriptName, outcome, durationMs, excerpt }) => request('/api/runs/import', { workspace, scriptName, outcome, durationMs, excerpt }));
  server.registerTool('learning_record', {
    description: 'Index one reusable lesson by title and file ref with triggering run evidence, failure signature and optional situation tags. Titles/refs only, never rule bodies or secrets.',
    inputSchema: z.object({
      title: z.string().min(1).max(80),
      file: z.string().min(1).max(256),
      evidenceRefs: z.array(z.string().max(128)).min(1).max(5),
      failureSignature: z.object({
        tests: z.array(z.string().max(120)).max(10),
        errorClasses: z.array(z.string().max(120)).max(10),
      }).strict(),
      situations: z.array(z.string().min(1).max(40)).max(10).optional().describe('Lowercase setup-detour tags; empty failure signature allowed only with tags.'),
    }).strict(),
    annotations: operateHints,
  }, ({ title, file, evidenceRefs, failureSignature, situations }) => request('/api/learnings/record', {
    title, file, evidenceRefs, failureSignature,
    ...(situations !== undefined ? { situations } : {}),
  }));
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
          inputSchema: z.object({ workspace: workspaceName, ...slotValueSchemas(slots) }).strict(),
          annotations: readHints,
        }, ({ workspace, ...inputs }) => request(workspacePath(workspace, '/local-tools/call'), { tool: toolName, inputs }, 45_000));
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
    'Help me prepare my project. Use workspace_list first. If my project is missing, ask me to choose exact folders and a project name, then call workspace_register with {name, roots}. Do not infer a common parent or register roots I did not choose. Then use workspace_inspect and onboarding_plan, reviewing every root group and identifying unavailable roots separately. Jira is optional: only discuss Atlassian MCP if I use Jira. Use datastore_query for one read-only query, service_logs for a bounded log tail, and browser_check for one loopback text snapshot. Do not request secrets in chat, change global configuration or install tools. The dashboard records what ran. Do not claim setup is done before a tool call succeeds.'
  } }] }));
  for (const skill of consumerSkills) {
    server.registerPrompt(`skill/${skill.name}`, {
      description: skill.description,
    }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: skill.text } }] }));
  }
  await server.connect(new StdioServerTransport());
}

// Dual-entry guard: direct tsx invocation runs the bridge; plain import is
// side-effect-free. Suffix comparison only — fileURLToPath(import.meta.url) is
// undefined under a CJS bundle and must never be used here.
const mcpEntry = process.argv[1] ?? '';
if (mcpEntry.endsWith('/mcp.ts') || mcpEntry.endsWith('\\mcp.ts') || mcpEntry === 'mcp.ts') {
  void runMcpBridge();
}
