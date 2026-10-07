import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { ClientConfig, Overview } from '../api';

const clientConfig: ClientConfig = {
  mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['m'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state' } } },
};

const PARENT = 'ses_aaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = 'ses_bbbbbbbbbbbbbbbbbbbbbbbb';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(handler: (path: string) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.href);
    return handler(decodeURI(url.pathname) + url.search);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sessionsPayload = {
  sessions: [
    { sessionID: PARENT, title: 'List title alpha', commands: 7, fileEdits: 0, fails: 3, first: '2026-10-06T10:00:00.000Z', last: '2026-10-06T11:00:00.000Z', workdir: '/tmp/fixture-alpha', childCount: 1 },
    { sessionID: CHILD, title: 'Do the beta thing', commands: 1, fileEdits: 1, fails: 0, first: '2026-10-06T10:05:00.000Z', last: '2026-10-06T10:06:00.000Z', workdir: '/tmp/fixture-beta', childCount: 0 },
  ],
  warnings: [],
};

const recordsPayload = {
  session: PARENT,
  warnings: [],
  groups: [
    {
      taskRef: 'Fix the failing check',
      taskRefKind: 'user',
      taskRefAgent: 'implementer',
      runs: 3,
      fails: 3,
      lines: [
        {
          ref: 1, signature: 'pnpm test', outcome: 'failure', runs: 3,
          agents: ['implementer'], sessions: [PARENT.slice(0, 13)], models: [],
          failReason: null, variants: ['pnpm test'], excerpts: ['FAIL example.test.ts'], results: [],
          intents: ['Running the check now'], messageIDs: [],
        },
      ],
    },
  ],
  tree: {
    sessionID: PARENT,
    link: null,
    children: [{ sessionID: CHILD, link: { childSessionID: CHILD, agent: 'explore', description: 'explore fixtures', time: 1000 }, children: [], detail: { title: 'Do the beta thing', titleKind: 'other', agent: 'explore', records: 2, orphan: false } }],
  },
};

const metaPayload = {
  meta: {
    sessionID: PARENT, title: 'Parent fixture', directory: '/tmp/fixture-alpha', cost: 1.5,
    tokens: { input: 100, output: 50, reasoning: 5, cacheRead: 10, cacheWrite: 2 },
    additions: 3, deletions: 1, files: 1, userTurns: 1, assistantTurns: 2, compactions: 0,
    lastWord: null, models: ['fixture-model'],
  },
  warning: null,
  warnings: [],
};

function baseHandler(path: string): Promise<Response> {
  const overview: Overview = { workspaces: [], milestone: 'M0', limits: [] };
  if (path === '/api/overview') return Promise.resolve(json(overview));
  if (path === '/api/client-config') return Promise.resolve(json(clientConfig));
  if (path.startsWith('/api/observer/doctor')) return Promise.resolve(json({ checks: [{ name: 'log', ok: true, detail: 'growing' }], warnings: [] }));
  if (path.startsWith('/api/observer/sessions?') || path === '/api/observer/sessions') return Promise.resolve(json(sessionsPayload));
  if (path === `/api/observer/sessions/${PARENT}/meta`) return Promise.resolve(json(metaPayload));
  if (path.startsWith(`/api/observer/sessions/${PARENT}/records`)) return Promise.resolve(json(recordsPayload));
  if (path.startsWith(`/api/observer/sessions/${PARENT}/stuck`)) {
    return Promise.resolve(json({ session: PARENT, warnings: [], report: { retries: [{ signature: 'pnpm test', runs: 3, fails: 3 }], rereads: [], slow: [], interruptions: 0, compactions: 0, afterInterrupt: [] } }));
  }
  if (path.startsWith(`/api/observer/sessions/${PARENT}/prompts`)) return Promise.resolve(json({ session: PARENT, prompts: [{ text: 'Fix the failing check', kind: 'user' }], warnings: [] }));
  if (path.startsWith(`/api/observer/sessions/${PARENT}/reads`)) {
    return Promise.resolve(json({ session: PARENT, warnings: [], reads: [{ path: '/tmp/fixture-alpha/a.ts', reads: 3, agents: ['implementer'], ranges: ['10-30'] }] }));
  }
  if (path.startsWith('/api/observer/mistakes')) {
    return Promise.resolve(json({
      rows: [{ sessionID: PARENT, at: '2026-10-06T10:00:00.000Z', taskRef: 'Fix the failing check', taskRefKind: 'user', signature: 'pnpm test', outcome: 'failure', failReason: null, excerpt: 'FAIL example.test.ts', agent: 'implementer' }],
      warnings: [],
    }));
  }
  if (path.startsWith('/api/observer/stuck')) {
    return Promise.resolve(json({
      entries: [{ session: PARENT, report: { retries: [{ signature: 'pnpm test', runs: 3, fails: 3 }], rereads: [], slow: [], interruptions: 0, compactions: 0, afterInterrupt: [] } }],
      warnings: [],
    }));
  }
  if (path.startsWith('/api/observer/cost')) {
    return Promise.resolve(json({
      rows: [{ sessionID: PARENT, title: 'Parent fixture', directory: '/tmp/fixture-alpha', cost: 1.5, tokens: metaPayload.meta.tokens, additions: 3, deletions: 1, files: 1, userTurns: 1, assistantTurns: 2, compactions: 0, last: '2026-10-06T11:00:00.000Z' }],
      warnings: [],
    }));
  }
  return Promise.resolve(json({ error: 'Not found.' }, 404));
}

async function connectedApp() {
  installFetch(baseHandler);
  render(<App />);
  await screen.findByRole('heading', { name: 'What your AI did' });
}

afterEach(() => {
  sessionStorage.clear();
  window.location.hash = '#observe';
});

describe('observe views', () => {
  it('lists sessions with counts, workdir and health line', async () => {
    await connectedApp();
    expect(await screen.findByText('ses_aaaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('List title alpha')).toBeInTheDocument();
    expect(screen.getByText('Do the beta thing')).toBeInTheDocument();
    expect(screen.getByText('↳ 1 sub')).toBeInTheDocument();
    expect(screen.queryByText('↳ 0 sub')).not.toBeInTheDocument();
    expect(screen.getAllByText('/tmp/fixture-alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('7 commands')).toBeInTheDocument();
    expect(screen.getByText('3 failed')).toBeInTheDocument();
    expect(screen.getAllByText(/last activity/).length).toBe(2);
    expect(screen.getByText(/Recording: active/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/✓ log: growing/)).toBeInTheDocument();
    expect(screen.getByText('Recorder is working')).toBeInTheDocument();
    expect(screen.getByText(/2 sessions in window/)).toBeInTheDocument();
    expect(screen.getByText(/2 sessions · 1 failure · \$1\.50 · 1 stuck in window/)).toBeInTheDocument();
  });

  it('renders the short id as the row title when the server has no title', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/sessions?') || path === '/api/observer/sessions') {
        return Promise.resolve(json({
          sessions: [
            { sessionID: CHILD, title: null, commands: 1, fileEdits: 1, fails: 0, first: '2026-10-06T10:05:00.000Z', last: '2026-10-06T10:06:00.000Z', workdir: '/tmp/fixture-beta', childCount: 0 },
          ],
          warnings: [],
        }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    // Primary title falls back to the short id and the secondary still shows
    // it, so the row stays identifiable without any other id to read.
    expect((await screen.findAllByText('ses_bbbbbbbbb')).length).toBeGreaterThanOrEqual(2);
  });

  it('opens the session detail with tree default, meta strip and tab panels', async () => {
    await connectedApp();
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    expect(await screen.findByText('Parent fixture')).toBeInTheDocument();
    expect(screen.getByText('$1.50')).toBeInTheDocument();
    // Tree (default tab) starts collapsed: the toggle names the child count
    // and the linked child stays hidden until expanded.
    expect(screen.getByText(/1 sub-session/)).toBeInTheDocument();
    expect(screen.queryByText(/explore fixtures/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand sub-sessions/ }));
    // Expanded child shows title, agent tag and window record count — never
    // an opaque "(unlinked)" id.
    expect(await screen.findByText(/Do the beta thing/)).toBeInTheDocument();
    expect(screen.getByText(/\[explore\]/)).toBeInTheDocument();
    expect(screen.getByText(/2 records/)).toBeInTheDocument();
    expect(screen.getByText(/explore fixtures/)).toBeInTheDocument();
    // The spawn description is the parent's briefing note for the subagent.
    expect(screen.getByText('Briefing to explore:')).toBeInTheDocument();
    expect(screen.queryByText(/unlinked/)).not.toBeInTheDocument();
    const detailTabs = within(screen.getByRole('tablist', { name: 'Session sections' }));
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Actions' }));
    expect(await screen.findByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('Fix the failing check')).toBeInTheDocument();
    // The user-message group header carries an attribution eyebrow.
    expect(screen.getByText('You asked:')).toBeInTheDocument();
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Failures' }));
    expect((await screen.findAllByText('pnpm test')).length).toBeGreaterThan(0);
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText('Repeated commands')).toBeInTheDocument();
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Your messages' }));
    expect(await screen.findByText('Fix the failing check')).toBeInTheDocument();
    expect(screen.getByText('You asked:')).toBeInTheDocument();
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Files read' }));
    expect(await screen.findByText('/tmp/fixture-alpha/a.ts')).toBeInTheDocument();
  });

  it('attributes briefing headers to their subagent target above the clamped text', async () => {
    const briefing = 'You are a subagent spawned by another session to explore fixtures far away in a distant directory with a very long description';
    installFetch(path => {
      if (path.startsWith(`/api/observer/sessions/${PARENT}/records`)) {
        return Promise.resolve(json({
          ...recordsPayload,
          groups: [{
            taskRef: briefing,
            taskRefKind: 'briefing',
            taskRefAgent: 'explore',
            runs: 1,
            fails: 0,
            lines: [{
              ref: 1, signature: 'git status', outcome: 'completed', runs: 1,
              agents: ['explore'], sessions: [PARENT.slice(0, 13)], models: [],
              failReason: null, variants: ['git status'], excerpts: [], results: [],
              intents: [], messageIDs: [],
            }],
          }],
        }));
      }
      if (path.startsWith(`/api/observer/sessions/${PARENT}/prompts`)) {
        return Promise.resolve(json({ session: PARENT, prompts: [{ text: briefing, kind: 'briefing' }], warnings: [] }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    // Tree tab renders the briefing group under "All records in this tree":
    // the eyebrow is a separate element above the clamped H3, never inside it.
    const header = await screen.findByText(briefing);
    expect(header.tagName).toBe('H3');
    expect(header).toHaveClass('line-clamp-1');
    expect(header.previousElementSibling?.textContent).toBe('Briefing to explore:');
    const detailTabs = within(screen.getByRole('tablist', { name: 'Session sections' }));
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Your messages' }));
    expect(await screen.findByText(briefing)).toBeInTheDocument();
    expect(screen.getByText('Briefing:')).toBeInTheDocument();
  });

  it('marks only genuine orphans and never calls parent-linked children unlinked', async () => {
    const ORPHAN = 'ses_oooooooooooooooooooooooo';
    installFetch(path => {
      if (path.startsWith(`/api/observer/sessions/${PARENT}/records`)) {
        return Promise.resolve(json({
          ...recordsPayload,
          tree: {
            sessionID: PARENT,
            link: null,
            children: [
              { sessionID: CHILD, link: null, children: [], detail: { title: 'Parent-linked worker', agent: 'general', records: 3, orphan: false } },
              { sessionID: ORPHAN, link: null, children: [], detail: { title: ORPHAN.slice(0, 13), agent: null, records: 0, hasMessages: false, orphan: true } },
            ],
          },
        }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    expect(await screen.findByText(/2 sub-sessions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand sub-sessions/ }));
    expect(await screen.findByText(/Parent-linked worker/)).toBeInTheDocument();
    expect(screen.getByText(/no spawn note/)).toBeInTheDocument();
    expect(screen.getByText(/\(empty session\)/)).toBeInTheDocument();
    expect(screen.getByText(/orphaned — no parent link/)).toBeInTheDocument();
    expect(screen.queryByText(/unlinked/)).not.toBeInTheDocument();
  });

  it('labels pre-recording zero-record children distinctly from empty sessions', async () => {
    const PRE = 'ses_pppppppppppppppppppppppp';
    const EMPTY = 'ses_qqqqqqqqqqqqqqqqqqqqqqqq';
    installFetch(path => {
      if (path.startsWith(`/api/observer/sessions/${PARENT}/records`)) {
        return Promise.resolve(json({
          ...recordsPayload,
          tree: {
            sessionID: PARENT,
            link: null,
            children: [
              { sessionID: PRE, link: null, children: [], detail: { title: 'Verify workspace dashboard flow', agent: null, records: 0, hasMessages: true, orphan: false } },
              { sessionID: EMPTY, link: null, children: [], detail: { title: EMPTY.slice(0, 13), agent: null, records: 0, hasMessages: false, orphan: false } },
            ],
          },
        }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    expect(await screen.findByText(/2 sub-sessions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand sub-sessions/ }));
    expect(await screen.findByText(/\(before recording started\)/)).toBeInTheDocument();
    expect(screen.getByText(/\(empty session\)/)).toBeInTheDocument();
    expect(screen.queryByText(/no spawn note/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 records/)).not.toBeInTheDocument();
  });

  it('shows the global mistakes, stuck and cost views', async () => {
    await connectedApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Failures' }));
    expect(await screen.findByText('1 failure · newest first.')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    // Failure-feed task refs carry the same attribution as group headers.
    expect(screen.getByText('You asked:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText('1 session with signals.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Cost' }));
    expect(await screen.findByText('$1.50')).toBeInTheDocument();
    expect(screen.getByText(/Across 1 session in window/)).toBeInTheDocument();
  });

  it('keeps hash routing for tabs and session detail', async () => {
    await connectedApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Cost' }));
    await screen.findByText(/Across 1 session in window/);
    expect(window.location.hash).toBe('#observe/cost');
    window.location.hash = '#observe/mistakes';
    expect(await screen.findByText('1 failure · newest first.')).toBeInTheDocument();
  });

  it('renders clean stuck and failure-free states honestly', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/stuck')) return Promise.resolve(json({ entries: [], warnings: [] }));
      if (path.startsWith('/api/observer/mistakes')) return Promise.resolve(json({ rows: [], warnings: [] }));
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    const tabs = within(screen.getByRole('tablist', { name: 'Observe sections' }));
    fireEvent.click(tabs.getByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText(/Clean — no stuck signals in this window/)).toBeInTheDocument();
    fireEvent.click(tabs.getByRole('tab', { name: 'Failures' }));
    expect(await screen.findByText(/No failures recorded in this window/)).toBeInTheDocument();
  });

  it('falls back to the picker with a notice for an invalid session id', async () => {
    installFetch(baseHandler);
    window.location.hash = '#observe/not-a-session!!';
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    expect(await screen.findByText(/Unknown session id — showing the session picker instead/)).toBeInTheDocument();
    expect(screen.getByText('ses_aaaaaaaaa')).toBeInTheDocument();
  });

  it('keeps filtered-empty distinct from observer-disabled', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/sessions?')) return Promise.resolve(json({ sessions: [], warnings: [] }));
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    expect(await screen.findByText(/Nothing recorded yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: 'zzz-no-match' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply directory' }));
    expect(await screen.findByText(/No sessions match the current filters/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing recorded yet/)).not.toBeInTheDocument();
  });

  it('defaults detail activity to this session with an explicit scope label', async () => {
    installFetch(baseHandler);
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    const detailTabs = within(await screen.findByRole('tablist', { name: 'Session sections' }));
    fireEvent.click(detailTabs.getByRole('tab', { name: 'Actions' }));
    expect(await screen.findByText('Showing: this run only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Whole tree' }));
    expect(await screen.findByText('Showing: this run + its sub-agents')).toBeInTheDocument();
  });

  it('surfaces a filter-mismatch message instead of a silent empty', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/mistakes') && path.includes('session=ses_nomatch')) {
        return Promise.resolve(json({ error: 'No observed session matches that id. Use more of the full id.' }, 400));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getByRole('tab', { name: 'Failures' }));
    await screen.findByText('1 failure · newest first.');
    fireEvent.change(screen.getByLabelText('Session id or prefix'), { target: { value: 'ses_nomatch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No observed session matches that id');
  });

  it('does not call a compactions-only report clean', async () => {
    const report = { retries: [], rereads: [], slow: [], interruptions: 0, compactions: 2, afterInterrupt: [] };
    installFetch(path => {
      if (path.startsWith('/api/observer/stuck')) return Promise.resolve(json({ entries: [{ session: PARENT, report }], warnings: [] }));
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText(/context resets: 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Clean — no stuck signals/)).not.toBeInTheDocument();
  });

  it('renders a dash total when no session has recorded cost', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/cost')) {
        return Promise.resolve(json({
          rows: [{ sessionID: PARENT, title: null, directory: '/tmp/fixture-alpha', cost: null, tokens: null, additions: null, deletions: null, files: null, userTurns: 0, assistantTurns: 0, compactions: 0, last: null }],
          warnings: [],
        }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getByRole('tab', { name: 'Cost' }));
    expect(await screen.findByText(/total — \(no recorded cost\)/)).toBeInTheDocument();
  });

  it('counts variants past the cap and renders the last word', async () => {
    const variants = Array.from({ length: 12 }, (_, index) => `pnpm test --seed ${index}`);
    installFetch(path => {
      if (path.includes('/records')) {
        return Promise.resolve(json({
          ...recordsPayload,
          groups: [{ ...recordsPayload.groups[0], lines: [{ ...recordsPayload.groups[0].lines[0], variants }] }],
        }));
      }
      if (path.endsWith('/meta')) {
        return Promise.resolve(json({ ...metaPayload, meta: { ...metaPayload.meta, lastWord: 'the final answer here' } }));
      }
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(await screen.findByText('ses_aaaaaaaaa'));
    expect(await screen.findByText('the final answer here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));
    expect(await screen.findByText(/Showing 10 of 12 stored variants/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12 variants' }));
    expect(screen.getByRole('button', { name: 'Show fewer variants' })).toBeInTheDocument();
  });

  it('copies the full session id from the row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await connectedApp();
    const copies = await screen.findAllByRole('button', { name: /Copy full id of session/ });
    fireEvent.click(copies[0]);
    expect(writeText).toHaveBeenCalledWith(PARENT);
    expect(await screen.findByText('Full session id copied.')).toBeInTheDocument();
  });

  it('degrades the doctor line instead of vanishing', async () => {
    installFetch(path => {
      if (path.startsWith('/api/observer/doctor')) return Promise.resolve(json({ error: 'boom' }, 500));
      return baseHandler(path);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    expect(await screen.findByText(/observer health unavailable/)).toBeInTheDocument();
  });
});
