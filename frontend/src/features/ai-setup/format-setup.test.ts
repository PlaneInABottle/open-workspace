import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '@/api';
import { formatSetupRequest } from './format-setup';

const selectedId = '12345678-abcd-4abc-8def-1234567890ab';
const projectName = 'SYNTHETIC_PROJECT_NAME_SENTINEL';
const projectPath = '/tmp/SYNTHETIC_PROJECT_PATH_SENTINEL';
const mcpToken = 'SYNTHETIC_MCP_TOKEN_SENTINEL';
const dashboardToken = 'SYNTHETIC_DASHBOARD_TOKEN_SENTINEL';
const statePath = "/tmp/private state 'quoted'\\folder/\"double\"";
const command = '/opt/local node/bin/node';
const args = ['/opt/open workspace/mcp bridge.mjs', "/tmp/project's MCP path.mjs"];

const config: ClientConfig = {
  mcpServers: {
    openworkspace: {
      command,
      args,
      env: {
        OPENWORKSPACE_HOME: statePath,
        DASHBOARD_TOKEN: dashboardToken,
        MCP_TOKEN: mcpToken,
      },
    },
  },
};

describe('formatSetupRequest', () => {
  it('copies one secret-free generated entry and targets only the selected UUID', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    const generated = material!.copyText.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(generated).toBeDefined();
    expect(JSON.parse(generated!)).toEqual({
      mcpServers: {
        openworkspace: { command, args, env: { OPENWORKSPACE_HOME: statePath } },
      },
    });
    expect(material!.copyText).toContain(selectedId);
    expect(material!.copyText).toContain('Verify the MCP connection with workspace_list');
    expect(material!.copyText).toContain('workspace_inspect and onboarding_plan');
    expect(material!.copyText).toContain('repository roots');
    expect(material!.copyText).toContain('every returned root group separately');
    expect(material!.copyText).not.toContain(projectName);
    expect(material!.copyText).not.toContain(projectPath);
    expect(material!.copyText).not.toContain(mcpToken);
    expect(material!.copyText).not.toContain(dashboardToken);
    expect(material!.copyText).not.toContain('DASHBOARD_TOKEN');
    expect(material!.copyText).not.toContain('MCP_TOKEN');
  });

  it('uses generic list-first context when no workspace is selected and emits no material while configuration is missing', () => {
    const generic = formatSetupRequest(config, null);
    expect(generic?.copyText).toContain('workspace_list first');
    expect(generic?.copyText).toContain('workspace_propose with {name, roots}');
    expect(generic?.copyText).toContain('separate approval of every requested root');
    expect(generic?.copyText).toContain('Never infer a shared parent');
    expect(generic?.copyText).not.toContain(selectedId);
    expect(formatSetupRequest(config, 'stale-id')?.copyText).not.toContain(selectedId);
    expect(formatSetupRequest(null, selectedId)).toBeNull();
  });

  it('renders accurate client formats including TOML-safe paths and collapsed-guide data', () => {
    const guides = formatSetupRequest(config, selectedId)?.clientGuides;
    expect(guides?.map(guide => guide.id)).toEqual(['vscode-copilot', 'claude-code', 'opencode-v2', 'codex']);

    const vscode = JSON.parse(guides![0].configuration) as { mcpServers: { openworkspace: { type: string } } };
    const claude = JSON.parse(guides![1].configuration) as { mcpServers: { openworkspace: { type: string } } };
    expect(vscode.mcpServers.openworkspace.type).toBe('stdio');
    expect(claude.mcpServers.openworkspace.type).toBe('stdio');
    expect(guides![0].location).toContain('.mcp.json');
    expect(guides![0].guidance.join(' ')).toContain('MCP: Add Server');
    expect(guides![0].guidance.join(' ')).toContain('MCP: List Servers');
    expect(guides![0].sourceUrl).toBe('https://code.visualstudio.com/docs/agent-customization/mcp-servers');
    expect(guides![1].guidance.join(' ')).toContain('claude mcp list');
    expect(guides![1].sourceUrl).toBe('https://code.claude.com/docs/en/mcp');

    const openCode = JSON.parse(guides![2].configuration) as {
      $schema: string;
      mcp: { servers: { openworkspace: { type: string; command: string[]; environment: Record<string, string> } } };
      mcpServers?: unknown;
    };
    expect(openCode.$schema).toBe('https://opencode.ai/config.json');
    expect(openCode.mcp.servers.openworkspace.type).toBe('local');
    expect(openCode.mcp.servers.openworkspace.command).toEqual([command, ...args]);
    expect(openCode.mcp.servers.openworkspace.environment).toEqual({ OPENWORKSPACE_HOME: statePath });
    expect(openCode.mcpServers).toBeUndefined();
    expect(guides![2].title).toContain('v2');
    expect(guides![2].sourceUrl).toBe('https://opencode.ai/v2/docs/mcp-servers');

    const expectedToml = String.raw`OPENWORKSPACE_HOME = "/tmp/private state 'quoted'\\folder/\"double\""`;
    expect(guides![3].configuration).toContain(`command = "${command}"`);
    expect(guides![3].configuration).toContain(`args = ["${args[0]}", "/tmp/project's MCP path.mjs"]`);
    expect(guides![3].configuration).toContain(expectedToml);
    expect(guides![3].location).toContain('.codex/config.toml');
    expect(guides![3].guidance.join(' ')).toContain('/mcp');
    expect(guides![3].sourceUrl).toBe('https://developers.openai.com/codex/extend/mcp');
    expect(guides!.every(guide => !guide.configuration.includes(mcpToken) && !guide.configuration.includes(dashboardToken))).toBe(true);
  });
});
