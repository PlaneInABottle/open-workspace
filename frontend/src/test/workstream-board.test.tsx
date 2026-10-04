import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunListEntry, Workstream } from '../api';
import {
  STUCK_AFTER_HOURS,
  checkpointAgeLabel,
  isWorkstreamStuck,
  maskEvidenceRef,
  WorkstreamCard,
} from '../features/projects/workstream-board';

const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
const hourMs = 3_600_000;

function note(overrides: Record<string, unknown> = {}) {
  return {
    goal: 'Ship the status board',
    blocker: 'Waiting on review',
    next: 'Record a demo',
    owner: 'agent' as const,
    at: '2026-10-04T11:00:00.000Z',
    evidence: [],
    ...overrides,
  };
}

describe('isWorkstreamStuck', () => {
  it(`flags active + blocker + no checkpoint in ${STUCK_AFTER_HOURS}h`, () => {
    expect(isWorkstreamStuck('active', note({ at: new Date(nowMs - 25 * hourMs).toISOString() }), nowMs)).toBe(true);
  });
  it('stays quiet on a fresh checkpoint', () => {
    expect(isWorkstreamStuck('active', note(), nowMs)).toBe(false);
  });
  it('stays quiet when paused or done', () => {
    const old = note({ at: new Date(nowMs - 72 * hourMs).toISOString() });
    expect(isWorkstreamStuck('paused', old, nowMs)).toBe(false);
    expect(isWorkstreamStuck('done', old, nowMs)).toBe(false);
  });
  it('stays quiet without a blocker or note', () => {
    const old = new Date(nowMs - 72 * hourMs).toISOString();
    expect(isWorkstreamStuck('active', note({ blocker: '  ', at: old }), nowMs)).toBe(false);
    expect(isWorkstreamStuck('active', null, nowMs)).toBe(false);
    expect(isWorkstreamStuck('active', undefined, nowMs)).toBe(false);
  });
  it('never proves staleness from an unparseable timestamp', () => {
    expect(isWorkstreamStuck('active', note({ at: 'not-a-date' }), nowMs)).toBe(false);
  });
});

describe('checkpointAgeLabel', () => {
  it('labels minutes, hours, days and unknown dates', () => {
    expect(checkpointAgeLabel(new Date(nowMs - 30_000).toISOString(), nowMs)).toBe('just now');
    expect(checkpointAgeLabel(new Date(nowMs - 5 * 60_000).toISOString(), nowMs)).toBe('5m ago');
    expect(checkpointAgeLabel(new Date(nowMs - 3 * hourMs).toISOString(), nowMs)).toBe('3h ago');
    expect(checkpointAgeLabel(new Date(nowMs - 3 * 24 * hourMs).toISOString(), nowMs)).toBe('3d ago');
    expect(checkpointAgeLabel('not-a-date', nowMs)).toBe('date unknown');
  });
});

describe('maskEvidenceRef', () => {
  it('keeps short refs and truncates long ones', () => {
    expect(maskEvidenceRef('2000-new')).toBe('2000-new');
    expect(maskEvidenceRef('a'.repeat(40))).toBe(`${'a'.repeat(24)}…`);
  });
});

function workstream(overrides: Partial<Workstream> = {}): Workstream {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Group A',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    status: 'active',
    checkouts: [
      { root: '/tmp/stream-a', revision: 'a'.repeat(40), revisionState: 'observed', observedAt: '2026-10-02T00:00:00.000Z' },
      { root: '/tmp/stream-b', revision: null, revisionState: 'unknown', observedAt: '2026-10-02T00:00:00.000Z' },
    ],
    checkpointNote: note({ evidence: ['2000-new'] }),
    checkpointHistory: [
      note({ goal: 'First goal', at: '2026-10-02T00:00:00.000Z', evidence: [] }),
      note({ goal: 'Second goal', at: '2026-10-03T00:00:00.000Z', evidence: ['2000-new'] }),
    ],
    completions: [{
      assignmentId: 'assign-1',
      completionId: 'done-1',
      outcome: 'passed',
      revision: 'a'.repeat(40),
      dirty: false,
      dirtyFingerprint: null,
      checks: [],
      recordedAt: '2026-10-03T12:00:00.000Z',
    }],
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-04T11:00:00.000Z',
    ...overrides,
  };
}

function pinnedRun(): RunListEntry {
  return {
    id: '2000-new',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    scriptName: 'check',
    outcome: 'passed',
    durationMs: 120,
    at: '2026-10-03T00:00:00.000Z',
    failingNames: [],
    failingTruncated: false,
    excerptPreview: 'ok',
    excerptTruncated: false,
    outputTruncated: false,
    source: 'openworkspace-run',
    sourceLabel: 'Executed here — context-stamped',
    pinnedByNote: true,
  };
}

describe('WorkstreamCard', () => {
  it('renders goal, blocker, next, owner, age, short revs and outcome without absolute paths', () => {
    render(
      <ul><WorkstreamCard workstream={workstream()} leases={[]} runs={[pinnedRun()]} /></ul>,
    );
    const card = screen.getByText('Group A').closest('li')!;
    expect(within(card).getByText('Ship the status board')).toBeInTheDocument();
    expect(within(card).getByText('Waiting on review')).toBeInTheDocument();
    expect(within(card).getByText('Record a demo')).toBeInTheDocument();
    expect(within(card).getByText('agent')).toBeInTheDocument();
    expect(within(card).getByText(/rev a{12}…/)).toBeInTheDocument();
    expect(within(card).getByText(/rev unknown/)).toBeInTheDocument();
    expect(within(card).getByText('Completion: passed')).toBeInTheDocument();
    expect(within(card).getByText('linked run · check → passed')).toBeInTheDocument();
    expect(within(card).queryByText('/tmp/stream-a')).not.toBeInTheDocument();
    expect(within(card).queryByText(/dirty/i)).not.toBeInTheDocument();
    expect(within(card).queryByText(/clean/i)).not.toBeInTheDocument();
  });

  it('shows the needs-you stripe only for a stale blocked workstream', () => {
    const stale = workstream({ checkpointNote: note({ at: new Date(Date.now() - 30 * hourMs).toISOString() }) });
    const { rerender } = render(<ul><WorkstreamCard workstream={stale} leases={[]} runs={[]} /></ul>);
    expect(screen.getByText(/Needs you/)).toBeInTheDocument();
    rerender(<ul><WorkstreamCard workstream={workstream({ status: 'paused' })} leases={[]} runs={[]} /></ul>);
    expect(screen.queryByText(/Needs you/)).not.toBeInTheDocument();
  });

  it('expands checkpoint history oldest first with owner and evidence', () => {
    render(<ul><WorkstreamCard workstream={workstream()} leases={[]} runs={[pinnedRun()]} /></ul>);
    const toggle = screen.getByRole('button', { name: /Show checkpoint history \(2\)/ });
    expect(screen.queryByText('First goal')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Hide checkpoint history \(2\)/ })).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByText(/^(First|Second) goal$/);
    expect(items.map(item => item.textContent)).toEqual(['First goal', 'Second goal']);
  });

  it('renders held and queued leases inline without operation controls', () => {
    const stream = workstream();
    const leases = [
      { resource: 'port:3000', workstreamId: stream.id, status: 'held' as const, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
      { resource: 'port:3000', workstreamId: 'other-stream', status: 'queued' as const, createdAt: '2026-10-02T00:01:00.000Z', updatedAt: '2026-10-02T00:01:00.000Z' },
    ];
    render(<ul><WorkstreamCard workstream={stream} leases={leases} runs={[]} /></ul>);
    expect(screen.getByText(/port:3000 · held/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acquire|release|pause|resume|start|stop/i })).not.toBeInTheDocument();
  });

  it('reads cleanly with no checkpoint, history, or completion', () => {
    render(
      <ul><WorkstreamCard workstream={workstream({ checkpointNote: null, checkpointHistory: [], completions: [] })} leases={[]} runs={[]} /></ul>,
    );
    expect(screen.getByText('No checkpoint recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checkpoint history/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Completion:/)).not.toBeInTheDocument();
  });
});
