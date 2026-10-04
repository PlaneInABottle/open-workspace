import { render, screen, within } from '@testing-library/react';import { describe, expect, it, vi } from 'vitest';
import { RecordsView } from '../features/records/RecordsView';
import type { LearnedLesson, Workspace } from '../api';

const workspace: Workspace = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Shelf fixture', roots: ['/tmp/shelf-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };

const lessons: LearnedLesson[] = [
  { title: 'Suspect lesson first', file: 'AGENTS.md', measured: true, status: 'suspect', recurrenceCount: 1 },
  { title: 'Situational lesson', file: 'skills/review/SKILL.md', measured: false, status: 'active', recurrenceCount: 0 },
  { title: 'Quiet measured lesson', file: 'AGENTS.md', measured: true, status: 'active', recurrenceCount: 0 },
];

function renderShelf(overrides: Partial<Parameters<typeof RecordsView>[0]> = {}) {
  const onReload = vi.fn();
  render(
    <RecordsView
      workspace={workspace}
      activity={[]}
      learnings={{ milestones: [] }}
      lessons={lessons}
      runs={[]}
      loading={false}
      error={null}
      updatedAt={null}
      onReload={onReload}
      {...overrides}
    />,
  );
  return { onReload };
}

describe('learned lessons shelf', () => {
  it('renders titles with file refs, badges and the manual-review caption in server order', () => {
    renderShelf();
    const shelf = screen.getByRole('heading', { name: 'What the workspace learned' }).closest('section')!;
    expect(within(shelf).getByText(/review is manual/i)).toBeInTheDocument();

    const items = within(shelf).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toMatchObject([
      expect.stringContaining('Suspect lesson first'),
      expect.stringContaining('Situational lesson'),
      expect.stringContaining('Quiet measured lesson'),
    ]);
    expect(items[0]).toHaveTextContent('AGENTS.md');
    expect(items[1]).toHaveTextContent('skills/review/SKILL.md');

    expect(within(items[0]).getByText('needs-review')).toBeInTheDocument();
    expect(within(items[0]).getByText('measured')).toBeInTheDocument();
    expect(within(items[0]).getByText('recurred 1× in last 20 runs')).toBeInTheDocument();
    expect(within(items[1]).getByText('situational')).toBeInTheDocument();
    expect(within(items[1]).getByText('active')).toBeInTheDocument();
    expect(within(items[1]).getByText('no recurrence in last 20 runs')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/prune|delete|dismiss|keep/i);
  });

  it('never renders body or evidence fields outside the projection', () => {
    const tainted = {
      ...lessons[0],
      body: 'BODY_SENTINEL must never render',
      evidenceRefs: ['EVIDENCE_SENTINEL'],
      failureSignature: { tests: ['SIGNATURE_SENTINEL'], errorClasses: [] },
    } as unknown as LearnedLesson;
    renderShelf({ lessons: [tainted] });
    expect(document.body.textContent).not.toContain('BODY_SENTINEL');
    expect(document.body.textContent).not.toContain('EVIDENCE_SENTINEL');
    expect(document.body.textContent).not.toContain('SIGNATURE_SENTINEL');
  });

  it('covers loading and empty states', () => {
    renderShelf({ lessons: [], loading: true });
    expect(screen.getByText('Reading learned lessons…')).toBeInTheDocument();

    renderShelf({ lessons: [], loading: false });
    expect(screen.getByText(/No lessons recorded yet/)).toBeInTheDocument();
  });
});
