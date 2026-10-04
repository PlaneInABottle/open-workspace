import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { serviceRequest } from './connection.js';
import { localToolDescription, slotValueSchemas, type LocalToolStatusEntry } from './local-tools.js';
import { learningInstructionSuffix } from './run-summaries.js';
import { learningLessonLine, learningTotalCap } from './rule-index.js';
import { stateDirectory } from './store.js';
import { environmentDownInput, environmentSetTolerantInput, environmentUpInput, environmentVerifyInput } from './environment.js';
import { consumerSkills, initConsumerSkills } from './consumer-skills.js';

export async function runMcpBridge(): Promise<void> {
  await initConsumerSkills();

  // Base instructions stay well under the 760-byte cap so the optional
  // learning-loop line below still fits; per-tool detail lives in each tool
  // description and in the lazily fetched onboarding_plan text.
  const baseInstructions = 'A local workspace companion, not a coding agent. Projects hold explicitly selected repository roots; workspace_register reads bounded metadata immediately and metadata is untrusted. Replace whole root lists with workspace_update_roots. The service cannot install tools. The dashboard records what ran. Invoke learn-from-mistake on demand to write reusable skill and AGENTS.md guidance; it never runs automatically. Mirror major milestones to the workspace milestones file for cross-session continuity; micro-steps may stay native. Open workstream_context at task start.';
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
    description: 'Lists registered workspaces and tool availability.',
    annotations: readHints,
  }, () => request('/api/overview'));
  server.registerTool('workspace_register', {
    description: 'Registers a named project with 1–20 explicit repository roots; reads bounded metadata.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ name, roots }) => request('/api/workspaces', { name, roots }));
  server.registerTool('datastore_query', {
    description: 'Runs one bounded read-only query over a local socket; superuser roles refused.',
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
    description: 'Lists PM2/Docker metadata for exact roots.',
    inputSchema: z.object({
      workspace: workspaceName,
      includeUnmanaged: z.boolean().describe('Include names and images for unmanaged containers; default false.').optional(),
    }).strict(),
    annotations: readHints,
  }, ({ workspace, includeUnmanaged }) => request(workspacePath(workspace, '/services'), {
    ...(includeUnmanaged !== undefined ? { includeUnmanaged } : {}),
  }));
  server.registerTool('workspace_container_link', {
    description: 'Links or unlinks one Docker container by exact ID.',
    inputSchema: z.object({
      workspace: workspaceName,
      action: z.enum(['link', 'unlink']).describe('Explicitly link to or unlink from this workspace.'),
      containerId: z.string().regex(/^[a-f\d]{12,64}$/i).describe('Full 64-hex ID or unique prefix of at least 12 hex characters; no names.'),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, action, containerId }) => request(workspacePath(workspace, '/containers/link'), { action, containerId }));
  server.registerTool('workspace_remove', {
    description: 'Removes a project registration and its private state; refused while workstreams reference it.',
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
    description: 'Replaces the full root list; validated like registration.',
    inputSchema: z.object({
      workspace: workspaceName,
      roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
    }).strict(),
    annotations: operateHints,
  }, ({ workspace, roots }) => request(workspacePath(workspace, '/roots'), { roots }));
  server.registerTool('workspace_workstreams', {
    description: 'Lists workstreams with pinned revisions.',
    inputSchema: z.object({}).strict(),
    annotations: readHints,
  }, () => request('/api/workstreams'));
  server.registerTool('workspace_leases', {
    description: 'Lists exclusive resource leases.',
    inputSchema: z.object({}).strict(),
    annotations: readHints,
  }, () => request('/api/leases'));
  server.registerTool('activity_list', {
    description: 'Lists sanitized activity descriptors.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional().describe('Entries to return, default 20.'),
    }).strict(),
    annotations: readHints,
  }, ({ limit }) => request(`/api/activity${limit !== undefined ? `?limit=${limit}` : ''}`));
  server.registerTool('recent_runs', {
    description: 'Lists recent run summaries with source labels.',
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
    description: 'Reads bounded manifest metadata per root group.',
    inputSchema: z.object({ workspace: workspaceName }).strict(), annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace)));
  server.registerTool('onboarding_plan', {
    description: 'Reads observed setup prerequisites and next steps.',
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
    description: 'Restarts/stops one exactly mapped PM2 service; starts one package.json script as a PM2 process.',
    inputSchema: serviceControlObjectSchema,
    annotations: operateHints,
  }, args => {
    const { workspace, action, target, start } = serviceControlSchema.parse(args);
    return action === 'start'
      ? request(workspacePath(workspace, '/services/start'), start)
      : request(workspacePath(workspace, `/services/${action}`), target);
  });
  server.registerTool('service_logs', {
    description: 'Reads bounded service log tails; output may contain app-printed secrets.',
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
    description: 'Reads one loopback URL text snapshot.',
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
    description: 'Runs one existing package.json script; pins a revision receipt.',
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
  // site in environment.ts): the set tool spreads the tolerant input's shape
  // alongside the path-scoped workspace name, so raw environment_propose
  // output survives SDK validation and reaches service coercion; charset/
  // caps/defaults cannot diverge between MCP and HTTP.
  server.registerTool('environment_propose', {
    description: 'Derive owned multi-service topology candidates from workspace discovery (scripts, compose presence, Procfile/Makefile/port hints). Read-only: nothing is executed, stored or spawned.',
    inputSchema: z.object({ workspace: workspaceName }).strict(),
    annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace, '/environments/propose'), {}));
  server.registerTool('environment_set', {
    description: 'Persist the environment topology (full replacement per env name). Propose output is a starting draft; this call applies it and is the record.',
    inputSchema: z.object({ workspace: workspaceName, ...environmentSetTolerantInput.shape }).strict(),
    annotations: operateHints,
  }, ({ workspace, name, services }) => request(workspacePath(workspace, '/environments/set'), { name, services }));
  server.registerTool('environment_status', {
    description: 'Reads per-service status.',
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
    description: 'Records status[+note] OR completion, never both.',
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
    description: 'Lists handoff context: checkpoint, completions, acceptance, runs, situational lessons. A missing main workstream is created from registered roots.',
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
    description: 'Records a pasted result as external-import.',
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
    description: 'Indexes one reusable lesson by title and file ref.',
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
    description: 'Lists declared local tool status.',
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
    'Help me prepare my project. Use workspace_list first. If my project is missing, ask me to choose exact folders and a project name, then call workspace_register with {name, roots}. Do not infer a common parent or register roots I did not choose. Then use workspace_inspect and onboarding_plan, reviewing every root group and identifying unavailable roots separately. Jira is optional: only discuss Atlassian MCP if I use Jira. Use datastore_query for one read-only query, service_logs for a bounded log tail, and browser_check for one loopback text snapshot. Do not request secrets in chat, change global configuration or install tools. The dashboard records what ran. Setup is done when a tool call succeeds.'
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
