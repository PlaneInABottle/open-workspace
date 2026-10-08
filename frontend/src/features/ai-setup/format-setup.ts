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
  'Use OpenWorkspace MCP for environment orchestration and memory — list the tools first.',
  'Keep shell-native work in your own shell: commands, log tails and process control never go through MCP.',
  'Track tasks in your own harness; close with verification receipts.',
  'Reads run immediately. The dashboard records what ran.',
  'Project secrets stay out of chat, config, and repo files.',
].join('\n');

export function formatSetupRequest(configuration: ClientConfig | null, selectedName: string | null): SetupRequestMaterial | null {
  const server = localStdioServer(configuration);
  if (!server) return null;

  const boundContext = selectedName && workspaceNamePattern.test(selectedName)
    ? `Context: the workspace named ${JSON.stringify(selectedName)} covers the whole endeavor with all its repository roots (up to 20). Verify the MCP connection with workspace_list, then call workspace_inspect and onboarding_plan for this name only. Review every returned root group separately; new repos join this workspace as roots, not as new workspaces; do not infer or include the project name or root paths in setup instructions.`
    : 'Context: verify the MCP connection with workspace_list first. If my project is absent, ask me to choose one workspace name for the whole endeavor (e.g. ResAI) and all its repository folders (up to 20 roots), then call workspace_register with {name, roots}. New repos join as roots; do not open a new workspace per repo. Registration reads bounded metadata immediately. Never infer a shared parent. The dashboard records what ran.';
  const copyText = [
    'Paste this whole message to your own coding assistant. Your agent installs it; the dashboard records what ran.',
    'What to do (one pass): identify my client, install the MCP entry project-local, set skills to MCP-served, propose the AGENTS.md note, tell me to reload, verify with free reads, then hand off short. Show the exact diff for any file write.',
    'Step 1 — Identify client: apply the shared marker table (install-dir hit wins; a config-file hit is only a fallback signal): Claude Code — install dir `.claude/`, fallback `~/.claude.json`; OpenCode — install dir `.opencode/`, fallback `opencode.jsonc`; Codex — detect `.agents/skills/` or fallback `.codex/config.toml`, install to `.agents/skills/`; VS Code/Copilot — install dir `.github/`, fallback `.mcp.json`. When several clients genuinely coexist, ask which one before writing. Use that client\u2019s documented project-local format as of today; if docs moved, follow current official docs and say so. Never write user-wide/global scope unless I explicitly ask. Live per-client install paths are UNVERIFIED until run.',
    'Generated local MCP entry (secret-free, this machine only):\n```json\n'
    + `${jsonConfig(server)}\n`
    + '```\nMerge `mcpServers.openworkspace` preserving every existing server/setting. `OPENWORKSPACE_HOME` is machine-local; never commit it as a team path. No tokens are involved; never ask for or paste any.',
    'Step 2 — Skills (MCP-served by default): use the MCP-served skill prompts directly (`skill/learn-from-mistake`, `skill/onboarding`, `skill/ow`, `skill/ow-debug`, `skill/setup-ow`, `skill/setup-tracing`, `skill/update` — fetch only what the task needs; `skill/onboarding` first). You know your own harness: use your own client\u2019s command/skill paths with no detection round-trip; check config files only as a tiebreak when this project genuinely has several client setups: Claude Code → project `.claude/commands/ow-<name>.md`; OpenCode → project `.opencode/commands/ow-<name>.md`; Codex → project `.agents/skills/ow-<name>/SKILL.md`; VS Code/Copilot → project `.github/skills/ow-<name>/SKILL.md`. Local copies only when I explicitly ask: install source is this checkout\u2019s `plugins/<client>/` packs — checkout root is the path before `bin/openworkspace.mjs` above (Claude Code: `plugins/claude/commands/`). Copy all seven verbatim (`ow-learn-from-mistake`, `ow-onboarding`, `ow-ow`, `ow-ow-debug`, `ow-setup-ow`, `ow-setup-tracing`, `ow-update`; frontmatter already namespace-normalized), project-local only at your client\u2019s path above. Copy rule: byte-identical → skip silently; tool-owned unmodified → overwrite and report the diff; personal edit → show the diff, let me decide before writing. Never write user-wide scope. Saved copies rot: MCP-served stays the refresh source and fallback. Neither checkout packs nor prompts/get available → stay MCP-served-only (no local install); say so. Delete saved copies to return to pure MCP-served. Refresh later via installed `/ow-update`, or re-paste this prompt.',
    `Step 3 — AGENTS.md note: write this note in the user-named repo root (default: first registered root when I defer) under your client\u2019s normal write flow. Target the first existing file in order \`AGENTS.md\` → \`CLAUDE.md\` → \`MUSE.md\` → \`GEMINI.md\`, else create \`AGENTS.md\` at that root. Ask which file when ambiguous; never write a shared ancestor/parent outside the active project without separate explicit authorization.\n${agentsNote}\nMerge with marker block \`<!-- openworkspace:begin -->\` … note … \`<!-- openworkspace:end -->\`; absent → append with one blank-line separator; present → replace inside markers only (idempotent re-paste). Everything outside markers stays byte-identical. Personal content outside the marked block is preserved. If the root/file is ambiguous, the target is not a regular writable text file, or an ancestor write lacks explicit authorization, report which and stop that step; other verified steps stand.`,
    `${'Step 4 — Reload + Step 5 — Verify (free reads only): tell me the client\u2019s MCP reload step, then call `workspace_list` after reload.'
    + ` ${boundContext} Success = workspace_list plus workspace_inspect and onboarding_plan free reads return without error. A config listing alone (\`claude mcp list\`, \`MCP: List Servers\`, \`/mcps\`, \`/mcp\`) is not verification. Setup runs no project command, installs nothing, and reads no secret file.`
    + ' Already connected? Re-paste the current prompt and re-merge the entry, re-apply the AGENTS.md block idempotently, and re-verify with workspace_list.'}`,
    'Step 6 — Handoff (≤120 words): report client + scope file; AGENTS.md file; verification calls + one-line results; skills mode (`MCP-served` unless I asked for local copies, then list them); next human action; limitation/unverified note. Guardrails: POSIX-only; tokens never in chat/repo/config; Jira is optional (discuss Atlassian MCP only if I use Jira). This preview needs the existing OpenWorkspace Node runtime; it is not a Node-free installer.',
  ].join('\n\n');

  return { copyText };
}
