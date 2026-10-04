import { fireEvent, render, screen, within } from '@testing-library/react';import { describe, expect, it, vi } from 'vitest';
import { RecordsView } from '../features/records/RecordsView';
import { buildTimeline, filterTimeline, summarizeTimeline } from '../features/records/timeline';
import type { ActivityEntry, Learnings, RunListEntry, Workspace } from '../api';

const workspace: Workspace = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Records fixture', roots: ['/tmp/records-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };
const workspaceId = workspace.id;

const learnings: Learnings = {
  milestones: [{ at: '2026-10-02T00:05:00.000Z', text: 'Checkout flow live for reviewers.', source: '1700000000-checkout.md' }],
};

const activity: ActivityEntry[] = [
  { at: '2026-10-02T00:01:00.000Z', actor: 'mcp', operation: 'verify', workspaceId, detail: 'check → passed' },
  { at: '2026-10-02T00:02:00.000Z', actor: 'dashboard', operation: 'service-restart', workspaceId, detail: 'worker → completed' },
  { at: '2026-10-02T00:03:00.000Z', actor: 'mcp', operation: 'verify', workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', detail: 'other → passed' },
];

const runs: RunListEntry[] = [
  {
    workspaceId,
    scriptName: 'check',
    outcome: 'failed',
    durationMs: 410,
    at: '2026-10-02T00:04:00.000Z',
    failingNames: ['checkout totals'],
    failingTruncated: false,
    excerptPreview: 'not ok 1 checkout totals (Bearer ***)',
    excerptTruncated: false,
    outputTruncated: false,
  },
  {
    workspaceId,
    scriptName: 'lint',
    outcome: 'passed',
    durationMs: 90,
    at: '2026-10-02T00:00:00.000Z',
    failingNames: [],
    failingTruncated: false,
    excerptPreview: '',
    excerptTruncated: false,
    outputTruncated: false,
  },
];

function renderRecords(overrides: Partial<Parameters<typeof RecordsView>[0]> = {}) {
  const onReload = vi.fn();
  render(
    <RecordsView
      workspace={workspace}
      activity={activity}
      learnings={learnings}
      runs={runs}
      loading={false}
      error={null}
      updatedAt="2026-10-02T00:06:00.000Z"
      onReload={onReload}
      {...overrides}
    />,
  );
  return { onReload };
}

describe('records timeline', () => {
  it('merges notes, receipts and runs newest-first without a draft strip', () => {
    const { onReload } = renderRecords();
    expect(onReload).toHaveBeenCalledWith(workspace.name);

    const summary = screen.getByRole('heading', { name: 'Record summary', hidden: true }).closest('section')!;
    expect(within(summary).getByText('Runs')).toBeInTheDocument();
    expect(within(summary).getByText('50%')).toBeInTheDocument();
    expect(within(summary).getByText('Notes')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/draft|unprocessed learnings/i);

    const timeline = screen.getByRole('heading', { name: 'What happened here' }).closest('section')!;
    const items = within(timeline).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Checkout flow live for reviewers.');
    expect(items[1]).toHaveTextContent('check → failed');
    expect(within(timeline).queryByText(/other → passed/)).not.toBeInTheDocument();
  });

  it('filters by kind and outcome and expands red rows to the masked fail summary', () => {
    renderRecords();
    const timeline = screen.getByRole('heading', { name: 'What happened here' }).closest('section')!;

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'verify' } });
    expect(within(timeline).queryByText(/Checkout flow live/)).not.toBeInTheDocument();
    expect(within(timeline).getByText(/check → failed/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'fail' } });
    expect(within(timeline).queryByText(/check → passed/)).not.toBeInTheDocument();
    expect(within(timeline).getByText(/check → failed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show failure summary for check' }));
    expect(screen.getByText('checkout totals')).toBeInTheDocument();
    expect(screen.getByText(/Bearer \*\*\*/)).toBeInTheDocument();
  });

  it('shows empty states and the no-notes honesty hint', () => {
    renderRecords({ activity: [], learnings: { milestones: [] }, runs: [] });
    expect(screen.getByText(/Nothing recorded for this project yet/)).toBeInTheDocument();

    renderRecords({ learnings: { milestones: [] } });
    expect(screen.getByText(/No agent notes in this interval/)).toBeInTheDocument();
  });

  it('never renders fields outside the sanitized allowlist', () => {
    const tainted = {
      ...runs[0],
      output: 'RAW_SECRET_SENTINEL output with password=hunter2',
      failureExcerpt: 'FULL_EXCERPT_SENTINEL should stay server-side',
    } as unknown as RunListEntry;
    renderRecords({ runs: [tainted] });
    fireEvent.click(screen.getByRole('button', { name: 'Show failure summary for check' }));
    expect(document.body.textContent).not.toContain('RAW_SECRET_SENTINEL');
    expect(document.body.textContent).not.toContain('FULL_EXCERPT_SENTINEL');
    expect(document.body.textContent).not.toContain('hunter2');
  });

  it('keeps the poll subscription stable across callback identity changes', () => {
    vi.useFakeTimers();
    try {
      const first = vi.fn();
      const base = {
        workspace,
        activity: [] as ActivityEntry[],
        learnings: { milestones: [] } as Learnings,
        runs: [] as RunListEntry[],
        loading: false,
        error: null,
        updatedAt: null,
      };
      const { rerender } = render(<RecordsView {...base} onReload={first} />);
      expect(first).toHaveBeenCalledTimes(1);

      // A fresh callback identity (e.g. after a workbench state commit) must
      // not resubscribe or refire the loader.
      const second = vi.fn();
      rerender(<RecordsView {...base} onReload={second} />);
      expect(second).not.toHaveBeenCalled();
      expect(first).toHaveBeenCalledTimes(1);

      // Polling continues on the original interval with the latest callback.
      vi.advanceTimersByTime(8000);
      expect(second).toHaveBeenCalledTimes(1);

      // Switching workspaces reloads immediately.
      rerender(<RecordsView {...base} workspace={{ ...workspace, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Other fixture' }} onReload={second} />);
      expect(second).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds timeline purely from sanitized fields with unknown operations degrading safely', () => {
    const rows = buildTimeline(
      [],
      [{ at: '2026-10-02T00:01:00.000Z', actor: 'mcp', operation: 'future-op', workspaceId, detail: 'x → ok' }],
      [],
      workspaceId,
    );
    expect(rows[0].kind).toBe('other');
    expect(rows[0].outcome).toBe('ok');
    expect(filterTimeline(rows, { kind: 'verify', outcome: 'all' })).toHaveLength(0);
    expect(summarizeTimeline([], 0)).toEqual({ runCount: 0, passRate: null, noteCount: 0 });
  });

  it('renders pasted results as imported, never verified, and excludes them from pass rate', () => {
    const imported: RunListEntry = {
      workspaceId,
      scriptName: 'upstream-check',
      outcome: 'passed',
      durationMs: 1200,
      at: '2026-10-02T00:07:00.000Z',
      failingNames: [],
      failingTruncated: false,
      excerptPreview: 'upstream green',
      excerptTruncated: false,
      outputTruncated: true,
      source: 'external-import',
      sourceLabel: 'Pasted result — not verified here',
    };
    const tampered: RunListEntry = { ...imported, scriptName: 'odd-check', at: '2026-10-02T00:08:00.000Z', source: 'unknown-source', sourceLabel: 'Unknown source — not verified here' };
    const rows = buildTimeline([], [], [imported, tampered], workspaceId);
    for (const row of rows) {
      expect(row.kind).toBe('import');
      expect(row.outcome).toBe('neutral');
    }
    expect(rows[0].summary).toContain('Unknown source — not verified here');
    expect(rows[1].summary).toContain('Pasted result — not verified here');
    expect(filterTimeline(rows, { kind: 'verify', outcome: 'all' })).toHaveLength(0);
    expect(filterTimeline(rows, { kind: 'import', outcome: 'all' })).toHaveLength(2);
    // One executed pass plus two pasted passes/failures: the rate covers the
    // executed run only while the count still reports every receipt.
    const mixed: RunListEntry[] = [
      { ...imported, source: undefined, sourceLabel: undefined, scriptName: 'check', outcome: 'passed', at: '2026-10-02T00:06:00.000Z' },
      imported,
      { ...imported, outcome: 'failed', at: '2026-10-02T00:09:00.000Z' },
    ];
    expect(summarizeTimeline(mixed, 0)).toEqual({ runCount: 3, passRate: 100, noteCount: 0 });
    expect(summarizeTimeline([imported, tampered], 0).passRate).toBeNull();

    renderRecords({ runs: [imported] });
    const pasted = within(screen.getByRole('heading', { name: 'What happened here' }).closest('section')!)
      .getAllByRole('listitem')
      .find(item => within(item).queryByText(/upstream-check → passed/));
    if (!pasted) throw new Error('expected the pasted run row to render');
    expect(within(pasted).getByText('imported')).toBeInTheDocument();
    expect(within(pasted).getByText(/Pasted result — not verified here/)).toBeInTheDocument();
    expect(within(pasted).queryByText('verify')).not.toBeInTheDocument();
  });
});
