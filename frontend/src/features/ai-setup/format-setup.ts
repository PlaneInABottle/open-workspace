import type { ClientConfig } from '@/api';

export interface SetupRequestMaterial {
  copyText: string;
}

interface LocalStdioServer {
  command: string;
  args: string[];
  env: { OPENWORKSPACE_HOME: string };
}

const workspaceNamePattern = /^(?!\s*$)(?!.*[/\0-\x1f\x7f-\x9f])(?!\.$)(?!\.\.$).{1,100}$/s;

function localStdioServer(configuration: ClientConfig | null): LocalStdioServer | null {
  const candidate = configuration?.mcpServers?.openworkspace;
  if (!candidate || typeof candidate.command !== 'string' || candidate.command.length === 0
    || !Array.isArray(candidate.args) || candidate.args.some(argument => typeof argument !== 'string')
    || !candidate.env || typeof candidate.env.OPENWORKSPACE_HOME !== 'string' || candidate.env.OPENWORKSPACE_HOME.length === 0) {
    return null;
  }
  return {
    command: candidate.command,
    args: [...candidate.args],
    env: { OPENWORKSPACE_HOME: candidate.env.OPENWORKSPACE_HOME },
  };
}

function jsonConfig(server: LocalStdioServer) {
  return JSON.stringify({
    mcpServers: {
      openworkspace: {
        command: server.command,
        args: server.args,
        env: server.env,
      },
    },
  }, null, 2);
}

const agentsNote = [
  '## OpenWorkspace',
  'Use OpenWorkspace MCP for local workspace inventory and verification (workspace_list, workspace_inspect, onboarding_plan).',
  'Reads run immediately. The dashboard records what ran.',
  'Project secrets stay out of chat, config, and repo files.',
].join('\n');

export function formatSetupRequest(configuration: ClientConfig | null, selectedName: string | null): SetupRequestMaterial | null {
  const server = localStdioServer(configuration);
  if (!server) return null;

  const boundContext = selectedName && workspaceNamePattern.test(selectedName)
    ? `Context: the project named ${JSON.stringify(selectedName)} is registered with an explicit set of repository roots. Verify the MCP connection with workspace_list, then call workspace_inspect and onboarding_plan for this name only. Review every returned root group separately; do not infer or include the project name or root paths in setup instructions.`
    : 'Context: verify the MCP connection with workspace_list first. If my project is absent, ask me to choose its name and exact repository folders, then call workspace_register with {name, roots}. Registration reads bounded metadata immediately. Never infer a shared parent. The dashboard records what ran.';
  const copyText = [
    'Paste this whole message to your own coding assistant. It installs the OpenWorkspace MCP connection for this project; your agent installs it and the dashboard records what ran.',
    'What to do (one pass): identify my client, install the MCP entry project-local, set skills to MCP-served, propose the AGENTS.md note, tell me to reload, verify with free reads, then hand off short. Show the exact diff for any file write.',
    'Step 1 — Identify client: detect the client from these files/config (or ask me if ambiguous): Claude Code (local scope, private to this project in `~/.claude.json`), Codex (`.codex/config.toml` project, `~/.codex/config.toml` only if I ask user-wide), VS Code/Copilot (`.mcp.json` project root), OpenCode v2 (`opencode.jsonc`). Use that client\u2019s documented project-local format as of today; if docs moved, follow current official docs and say so. Never write user-wide/global scope unless I explicitly ask. References to check: Claude Code https://code.claude.com/docs/en/mcp, Codex https://developers.openai.com/codex/extend/mcp, VS Code/Copilot https://code.visualstudio.com/docs/agent-customization/mcp-servers, OpenCode v2 https://opencode.ai/v2/docs/mcp-servers. Live per-client install paths are UNVERIFIED until run.',
    'Generated local MCP entry (secret-free, this machine only):\n```json\n'
    + `${jsonConfig(server)}\n`
    + '```\nMerge `mcpServers.openworkspace` preserving every existing server/setting. `OPENWORKSPACE_HOME` is machine-local; never commit it as a team path. No tokens are involved; never ask for or paste any.',
    'Step 2 — Skills (MCP-served by default): use the MCP-served skill prompts directly (`skill/browser-qa`, `skill/learn-from-mistake`, `skill/new-task`, `skill/onboarding`, `skill/update`, `skill/scaffold-local-tool` — fetch only what the task needs; `skill/onboarding` first). You know your own harness: use your own client\u2019s command/skill paths with no detection round-trip; check config files only as a tiebreak when this project genuinely has several client setups: Claude Code → project `.claude/commands/ow-<name>.md`; OpenCode → project `.opencode/commands/ow-<name>.md`; Codex → project `.agents/skills/ow-<name>/SKILL.md`; VS Code/Copilot → project `.github/skills/ow-<name>/SKILL.md`. If this session has no prompts/get interface, stay MCP-served-only (no local install) and say so. Local copies only when I explicitly ask: save each fetched text verbatim, project-local only, at your own client\u2019s path above. Copy rule: byte-identical → skip silently; tool-owned and locally unmodified → overwrite and report the diff; a personal edit is present → show the diff and let me decide before writing. Never write user-wide scope. Saved copies rot: re-fetch the same prompt on update; MCP-served stays the refresh source. Delete saved copies to return to pure MCP-served. Refresh later via installed `/ow-update`, or re-paste this prompt. Live per-client install paths are UNVERIFIED until run.',
    `Step 3 — AGENTS.md note: write this note in the user-named repo root (default: first registered root when I defer) under your client\u2019s normal write flow. Target the first existing file in order \`AGENTS.md\` → \`CLAUDE.md\` → \`MUSE.md\` → \`GEMINI.md\`, else create \`AGENTS.md\` at that root. Ask which file when ambiguous; never write a shared ancestor/parent outside the active project without separate explicit authorization.\n${agentsNote}\nMerge with marker block \`<!-- openworkspace:begin -->\` … note … \`<!-- openworkspace:end -->\`; absent → append with one blank-line separator; present → replace inside markers only (idempotent re-paste). Everything outside markers stays byte-identical. Personal content outside the marked block is preserved. If the root/file is ambiguous, the target is not a regular writable text file, or an ancestor write lacks explicit authorization, report which and stop that step; other verified steps stand.`,
    `${'Step 4 — Reload + Step 5 — Verify (free reads only): tell me the client\u2019s MCP reload step, then call `workspace_list` after reload.'
    + ` ${boundContext} Success = those calls return without error. A config listing alone (\`claude mcp list\`, \`MCP: List Servers\`, \`/mcps\`, \`/mcp\`) is not verification. Never run project commands, install tools, or read secrets.`
    + ' Already connected? Re-paste the current prompt and re-merge the entry, re-apply the AGENTS.md block idempotently, and re-verify with workspace_list.'}`,
    'Step 6 — Handoff (≤120 words): report client + scope file; AGENTS.md file; verification calls + one-line results; skills mode (`MCP-served` unless I asked for local copies, then list them); next human action; limitation/unverified note. Guardrails: POSIX-only; no global writes unless I explicitly ask; personal edits outside the marked block stay byte-identical; tokens never in chat/repo/config; Jira is optional (discuss Atlassian MCP only if I use Jira). This preview needs the existing OpenWorkspace Node runtime; it is not a Node-free installer.',
  ].join('\n\n');

  return { copyText };
}
