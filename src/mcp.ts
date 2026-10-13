import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { serviceRequest } from './connection.js';
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
  const baseInstructions = 'A local workspace companion, not a coding agent. Projects hold explicit repository roots; workspace_register reads bounded metadata and re-registering replaces roots. The service cannot install tools. The dashboard records what ran. Your harness keeps commands, logs and process control — MCP is only environment orchestration plus memory. Invoke learn-from-mistake on demand to write reusable skill and AGENTS.md guidance; it never runs automatically.';
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
  const environmentName = z.string().min(1).max(100).describe('Environment name within the project.');
  const workspacePath = (name: string, rest = '') => `/api/workspaces/${encodeURIComponent(name)}${rest}`;
  server.registerTool('workspace_list', {
    description: 'Lists registered workspaces and tool availability.',
    annotations: readHints,
  }, () => request('/api/overview'));
  server.registerTool('workspace_register', {
    description: 'Registers a named project with 1–20 explicit repository roots; reads bounded metadata. Re-registering the same name replaces the whole root list.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      roots: z.array(z.string().min(1).max(4096)).min(1).max(20),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ name, roots }) => request('/api/workspaces', { name, roots }));
  server.registerTool('workspace_inspect', {
    description: 'Reads bounded manifest metadata per root group.',
    inputSchema: z.object({ workspace: workspaceName }).strict(), annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace)));
  server.registerTool('onboarding_plan', {
    description: 'Reads observed setup prerequisites and next steps.',
    inputSchema: z.object({ workspace: workspaceName }).strict(), annotations: readHints,
  }, ({ workspace }) => request(workspacePath(workspace, '/onboarding')));
  // M1 environment topology: discovery-proposed candidates (read-only),
  // stored set (full replacement per env name), and read-only status.
  // The client permission model is the authority, and the mutating call
  // itself (visible in activity) is the audit record. Compose files are
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
  // mutating call itself (visible in activity) is the audit record.
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
  server.registerPrompt('workspace_onboarding', {
    description: 'Guide an external assistant through safe local workspace onboarding.',
  }, () => ({ messages: [{ role: 'user', content: { type: 'text', text:
    'Help me prepare my project. Use workspace_list first. If my project is missing, ask me to choose exact folders and a project name, then call workspace_register with {name, roots}. Do not infer a common parent or register roots I did not choose. Then use workspace_inspect and onboarding_plan, reviewing every root group and identifying unavailable roots separately. Jira is optional: only discuss Atlassian MCP if I use Jira. Use environment_status for owned-environment state; keep commands, logs and process control in your own harness. Do not request secrets in chat, change global configuration or install tools. The dashboard records what ran. Setup is done when a tool call succeeds.'
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
