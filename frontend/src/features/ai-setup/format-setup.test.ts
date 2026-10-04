import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '@/api';
import { formatSetupRequest } from './format-setup';

const selectedName = 'Selected Project';
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
  'Step 2 — Skills (fetch via MCP, save project-local):',
  'Step 3 — AGENTS.md note:',
  'Step 4 — Reload + Step 5 — Verify (free reads only):',
  'Step 6 — Handoff (≤120 words):',
];

describe('formatSetupRequest', () => {
  it('emits all seven self-install sections within the size cap', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    for (const heading of sectionHeadings) {
      expect(material!.copyText).toContain(heading);
    }
    expect(new TextEncoder().encode(material!.copyText).length).toBeLessThanOrEqual(6 * 1024);
  });

  it('copies one secret-free generated entry and targets only the selected name', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    const generated = material!.copyText.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(generated).toBeDefined();
    expect(JSON.parse(generated!)).toEqual({
      mcpServers: {
        openworkspace: { command, args, env: { OPENWORKSPACE_HOME: statePath } },
      },
    });
    expect(material!.copyText).toContain(selectedName);
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
    expect(generic?.copyText).toContain('The dashboard records what ran');
    expect(generic?.copyText).toContain('Never infer a shared parent');
    expect(generic?.copyText).not.toContain(selectedName);
    expect(formatSetupRequest(config, '')?.copyText).not.toContain('Selected Project');
    expect(formatSetupRequest(null, selectedName)).toBeNull();
  });

  it('stays project-local with record-only guardrails', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('Never write user-wide/global scope unless I explicitly ask');
    expect(material!.copyText).toContain('Show the exact diff for any file write');
    expect(material!.copyText).toContain('the dashboard records what ran');
    expect(material!.copyText).toContain('tokens never in chat/repo/config');
    expect(material!.copyText).not.toContain('Ask before any file write');
    expect(material!.copyText).not.toContain('Reply yes to apply');
    expect(material!.copyText).not.toContain('nothing is written until you confirm');
    expect(material!.copyText).not.toContain('approve each write');
    expect(material!.copyText).not.toContain('need my approval');
  });

  it('requires free-read verification and rejects config listings as proof', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('then call `workspace_list` after reload');
    expect(material!.copyText).toContain('Success = those calls return without error');
    expect(material!.copyText).toContain('A config listing alone');
    expect(material!.copyText).toContain('is not verification');
    expect(material!.copyText).toContain('Never run project commands, install tools, or read secrets.');
    expect(material!.copyText).not.toContain('wait until I confirm reload');
  });

  it('carries the idempotent marker-block AGENTS.md merge policy preserving personal edits', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('<!-- openworkspace:begin -->');
    expect(material!.copyText).toContain('<!-- openworkspace:end -->');
    expect(material!.copyText).toContain('replace inside markers only (idempotent re-paste)');
    expect(material!.copyText).toContain('Everything outside markers stays byte-identical');
    expect(material!.copyText).toContain('## OpenWorkspace');
    expect(material!.copyText).toContain('Project secrets stay out of chat, config, and repo files.');
    expect(material!.copyText).toContain('`AGENTS.md` → `CLAUDE.md` → `MUSE.md` → `GEMINI.md`');
    expect(material!.copyText).toContain("under your client\u2019s normal write flow");
    expect(material!.copyText).not.toContain('Show the exact diff first, then apply it');
    expect(material!.copyText).not.toContain('If I decline');
    expect(material!.copyText).toContain('never write a shared ancestor/parent outside the active project without separate explicit authorization');
  });

  it('fetches skills via MCP then saves them verbatim project-local', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    expect(material!.copyText).toContain('fetch each skill fresh via its MCP prompt');
    expect(material!.copyText).toContain('`skill/browser-qa`');
    expect(material!.copyText).toContain('`skill/learn-from-mistake`');
    expect(material!.copyText).toContain('`skill/new-task`');
    expect(material!.copyText).toContain('`skill/openworkspace-onboarding`');
    expect(material!.copyText).toContain('`skill/scaffold-local-tool`');
    expect(material!.copyText).toContain('Save each fetched text verbatim, project-local only');
    expect(material!.copyText).toContain('`.claude/commands/openworkspace-<name>.md`');
    expect(material!.copyText).toContain('`.opencode/commands/openworkspace-<name>.md`');
    expect(material!.copyText).toContain('`.agents/skills/openworkspace-<name>/SKILL.md`');
    expect(material!.copyText).toContain('`.github/skills/openworkspace-<name>/SKILL.md`');
    expect(material!.copyText).toContain('merge preserving every existing setting');
    expect(material!.copyText).toContain('never write user-wide scope');
    expect(material!.copyText).toContain('re-fetch the same prompt on update');
    expect(material!.copyText).toContain('MCP-served stays the fallback and refresh source');
    expect(material!.copyText).toContain('Delete saved copies to return to MCP-served');
    expect(material!.copyText).toContain('UNVERIFIED until run');
    expect(material!.copyText).not.toContain('`plugins/<client>/`');
    expect(material!.copyText).not.toContain('copy the generated pack verbatim');
    expect(material!.copyText).not.toContain('pinned slash commands');
    expect(material!.copyText).not.toContain('re-copy the same paths');
  });

  it('exposes no legacy manual-adapt flow or collapsed-guide surface', () => {
    const material = formatSetupRequest(config, selectedName);
    expect(material).not.toBeNull();
    expect(material).toEqual({ copyText: expect.any(String) });
    expect('clientGuides' in material!).toBe(false);
  });
});
