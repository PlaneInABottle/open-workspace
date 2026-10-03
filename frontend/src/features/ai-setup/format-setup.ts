import type { ClientConfig } from '@/api';

export interface ClientSetupGuide {
  id: 'vscode-copilot' | 'claude-code' | 'opencode-v2' | 'codex';
  title: string;
  sourceUrl: string;
  location: string;
  guidance: string[];
  configuration: string;
}

export interface SetupRequestMaterial {
  copyText: string;
  clientGuides: ClientSetupGuide[];
}

interface LocalStdioServer {
  command: string;
  args: string[];
  env: { OPENWORKSPACE_HOME: string };
}

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openCodeSchema = 'https://opencode.ai/config.json';

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

function tomlBasicString(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (character === '\b') result += '\\b';
    else if (character === '\t') result += '\\t';
    else if (character === '\n') result += '\\n';
    else if (character === '\f') result += '\\f';
    else if (character === '\r') result += '\\r';
    else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      result += codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : `\\U${codePoint.toString(16).padStart(8, '0')}`;
    } else result += character;
  }
  return `${result}"`;
}

function jsonConfig(server: LocalStdioServer, includeStdioType: boolean) {
  return JSON.stringify({
    mcpServers: {
      openworkspace: {
        ...(includeStdioType ? { type: 'stdio' } : {}),
        command: server.command,
        args: server.args,
        env: server.env,
      },
    },
  }, null, 2);
}

function makeClientGuides(server: LocalStdioServer): ClientSetupGuide[] {
  const json = jsonConfig(server, true);
  const openCode = JSON.stringify({
    $schema: openCodeSchema,
    mcp: {
      servers: {
        openworkspace: {
          type: 'local',
          command: [server.command, ...server.args],
          environment: server.env,
        },
      },
    },
  }, null, 2);
  const codex = [
    '[mcp_servers.openworkspace]',
    `command = ${tomlBasicString(server.command)}`,
    `args = [${server.args.map(tomlBasicString).join(', ')}]`,
    '',
    '[mcp_servers.openworkspace.env]',
    `OPENWORKSPACE_HOME = ${tomlBasicString(server.env.OPENWORKSPACE_HOME)}`,
  ].join('\n');

  return [
    {
      id: 'vscode-copilot',
      title: 'VS Code with GitHub Copilot',
      sourceUrl: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
      location: 'Use .mcp.json at the workspace root for a portable project setting. Copilot Global is optional and applies to your user account.',
      guidance: [
        'Open the Command Palette and run “MCP: Add Server”. Choose .mcp.json for this workspace, or Copilot Global only if you intend a user-wide setting.',
        'Review the proposed merge, preserve existing servers and settings, and trust the local server only if you choose to.',
        'Use “MCP: List Servers” to verify the entry. Organization policy may disable MCP; do not bypass it.',
      ],
      configuration: json,
    },
    {
      id: 'claude-code',
      title: 'Claude Code',
      sourceUrl: 'https://code.claude.com/docs/en/mcp',
      location: 'Use Claude Code local scope for the current project. This is private to you and stored under this project in ~/.claude.json; use .mcp.json only when you deliberately share the entry with the team.',
      guidance: [
        'Use local scope rather than user scope. Preserve existing local entries and project settings, and never replace other servers or settings.',
        'For a project-local .mcp.json, review whether the machine-local Node and OPENWORKSPACE_HOME paths should be shared in version control.',
        'Review the exact change and approve it in Claude Code when prompted.',
        'Run “claude mcp list” to verify the configured entry. An entry in the list does not by itself prove the server is responding.',
      ],
      configuration: json,
    },
    {
      id: 'opencode-v2',
      title: 'OpenCode v2',
      sourceUrl: 'https://opencode.ai/v2/docs/mcp-servers',
      location: 'Use opencode.jsonc at the project root, or .opencode/opencode.jsonc for project configuration. This format is for OpenCode v2 only.',
      guidance: [
        'Merge the mcp.servers.openworkspace object into the existing configuration; preserve unrelated servers and settings.',
        'The command array starts with the generated executable followed by its arguments; the environment map contains only OPENWORKSPACE_HOME.',
        'Use “opencode mcp list” or “/mcps” to check the entry. A listed configuration is not proof of a successful tool call.',
      ],
      configuration: openCode,
    },
    {
      id: 'codex',
      title: 'Codex',
      sourceUrl: 'https://developers.openai.com/codex/extend/mcp',
      location: 'Use .codex/config.toml in the project for project scope. ~/.codex/config.toml is an optional user-wide location.',
      guidance: [
        'Merge these TOML tables into the chosen config file and preserve existing MCP entries. The state-directory path is local to this machine; do not commit it as a reusable team path.',
        'Review the exact change before applying it. Use Codex MCP settings or “/mcp” to verify; a displayed entry alone does not prove successful connection.',
      ],
      configuration: codex,
    },
  ];
}

export function formatSetupRequest(configuration: ClientConfig | null, selectedId: string | null): SetupRequestMaterial | null {
  const server = localStdioServer(configuration);
  if (!server) return null;

  const workspaceContext = selectedId && workspaceIdPattern.test(selectedId)
    ? `Context: This named project is registered (UUID ${selectedId}) with an explicit set of repository roots. Verify the MCP connection with workspace_list, then call workspace_inspect and onboarding_plan for this UUID only. Review every returned root group separately; do not infer or include the project name or root paths in setup instructions.`
    : 'Context: Verify the MCP connection with workspace_list first. If my project is absent, ask me to choose its name and exact repository folders, then call workspace_register with {name, roots}. Registration reads bounded metadata immediately. Never infer a shared parent. Mutations need my approval per my client settings; the dashboard only records what ran.';
  const copyText = [
    'Identify the assistant client I am using and adapt only this generated OpenWorkspace stdio entry to that client’s documented project-local format. Use the current project only; do not write user-wide or global MCP settings. For Claude Code, use Claude’s local scope (private to this project in ~/.claude.json), not user scope or a shared .mcp.json unless I explicitly ask. Preserve every existing server and setting, show the exact proposed change, and ask for my review before writing configuration.',
    'Generated local MCP entry:',
    '```json',
    jsonConfig(server, false),
    '```',
    workspaceContext,
    'This source preview requires the existing OpenWorkspace Node runtime; it is not a Node-free installer. Do not run project commands, install tools, read secrets, write project files, or claim setup is complete. OPENWORKSPACE_HOME is machine-local and must not be committed as a reusable team path.',
    'Jira is optional; discuss Atlassian MCP only if I use Jira.',
  ].join('\n\n');

  return { copyText, clientGuides: makeClientGuides(server) };
}
