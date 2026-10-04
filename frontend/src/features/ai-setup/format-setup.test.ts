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

const sectionHeadings = [
  'What to do (one pass):',
  'Step 1 — Identify client:',
  'Generated local MCP entry (secret-free, this machine only):',
  'Step 2 — Skills (no copy by default):',
  'Step 3 — AGENTS.md note (confirmed write):',
  'Step 4 — Reload + Step 5 — Verify (free reads only):',
  'Step 6 — Handoff (≤120 words):',
];

describe('formatSetupRequest', () => {
  it('emits all seven self-install sections within the size cap', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    for (const heading of sectionHeadings) {
      expect(material!.copyText).toContain(heading);
    }
    expect(new TextEncoder().encode(material!.copyText).length).toBeLessThanOrEqual(6 * 1024);
  });

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
    expect(material!.copyText).toContain('workspace_list');
    expect(material!.copyText).toContain('workspace_inspect');
    expect(material!.copyText).toContain('onboarding_plan');
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
    expect(generic?.copyText).toContain('workspace_register with {name, roots}');
    expect(generic?.copyText).toContain('Registration reads bounded metadata immediately');
    expect(generic?.copyText).toContain('the dashboard only records what ran');
    expect(generic?.copyText).toContain('Never infer a shared parent');
    expect(generic?.copyText).not.toContain(selectedId);
    expect(formatSetupRequest(config, 'stale-id')?.copyText).not.toContain('stale-id');
    expect(formatSetupRequest(null, selectedId)).toBeNull();
  });

  it('stays project-local with confirm-before-write guardrails', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('Never write user-wide/global scope unless I explicitly ask');
    expect(material!.copyText).toContain('Ask before any file write and show the exact diff');
    expect(material!.copyText).toContain('Reply yes to apply; nothing is written until you confirm');
    expect(material!.copyText).toContain('tokens never in chat/repo/config');
  });

  it('requires free-read verification and rejects config listings as proof', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('wait until I confirm reload, then call `workspace_list`');
    expect(material!.copyText).toContain('A config listing alone');
    expect(material!.copyText).toContain('is not verification');
    expect(material!.copyText).toContain('Never run project commands, install tools, read secrets, or claim done before these calls succeed');
  });

  it('carries the idempotent marker-block AGENTS.md merge policy preserving personal edits', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('<!-- openworkspace:begin -->');
    expect(material!.copyText).toContain('<!-- openworkspace:end -->');
    expect(material!.copyText).toContain('replace inside markers only (idempotent re-paste)');
    expect(material!.copyText).toContain('Everything outside markers stays byte-identical');
    expect(material!.copyText).toContain('## OpenWorkspace');
    expect(material!.copyText).toContain('Project secrets stay out of chat, config, and repo files.');
    expect(material!.copyText).toContain('`AGENTS.md` → `CLAUDE.md` → `MUSE.md` → `GEMINI.md`');
    expect(material!.copyText).toContain('never write a shared ancestor/parent outside the active project without separate explicit authorization');
  });

  it('defaults skills to MCP-served with no file copy', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('`skill/openworkspace-onboarding`');
    expect(material!.copyText).toContain('Do NOT copy SKILL.md files anywhere unless I explicitly ask');
  });

  it('exposes no legacy manual-adapt flow or collapsed-guide surface', () => {
    const material = formatSetupRequest(config, selectedId);
    expect(material).not.toBeNull();
    expect(material).toEqual({ copyText: expect.any(String) });
    expect('clientGuides' in material!).toBe(false);
  });
});
