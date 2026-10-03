import type { ActivityEntry, MilestoneNote, RunListEntry } from '@/api';

export type TimelineKind = 'note' | 'verify' | 'service' | 'data' | 'log' | 'browser' | 'other';
export type TimelineOutcome = 'ok' | 'fail' | 'neutral';

export interface TimelineRow {
  key: string;
  at: string;
  kind: TimelineKind;
  outcome: TimelineOutcome;
  /** One-line summary; only sanitized source fields ever reach here. */
  summary: string;
  run?: RunListEntry;
}

export function kindOfOperation(operation: string): TimelineKind {
  if (operation === 'verify') return 'verify';
  if (operation === 'service-logs') return 'log';
  if (operation.startsWith('service-')) return 'service';
  if (operation === 'datastore-query') return 'data';
  if (operation === 'browser-check') return 'browser';
  return 'other';
}

export function outcomeOfDetail(detail: string): TimelineOutcome {
  const tail = detail.slice(detail.lastIndexOf('→') + 1).trim().toLowerCase();
  if (!detail.includes('→')) return 'neutral';
  if (['ok', 'passed', 'completed', 'held', 'found'].includes(tail)) return 'ok';
  if (['failed', 'error', 'denied', 'not found'].includes(tail)) return 'fail';
  return 'neutral';
}

function operationLabel(operation: string) {
  return operation.replace(/-/g, ' ');
}

/**
 * Merge the three record sources newest-first. Only sanitized fields are
 * read: milestone text, activity operation/detail, run outcome/duration/
 * failing names/masked excerpt. Unknown activity operations degrade to
 * kind 'other' rather than disappearing.
 */
export function buildTimeline(milestones: MilestoneNote[], activity: ActivityEntry[], runs: RunListEntry[], workspaceId: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const note of milestones) {
    rows.push({
      key: `note-${note.source}-${note.at}`,
      at: note.at,
      kind: 'note',
      outcome: 'neutral',
      summary: note.text,
    });
  }
  for (const entry of activity) {
    if (entry.workspaceId !== null && entry.workspaceId !== workspaceId) continue;
    rows.push({
      key: `activity-${entry.at}-${entry.operation}-${entry.detail}`,
      at: entry.at,
      kind: kindOfOperation(entry.operation),
      outcome: outcomeOfDetail(entry.detail),
      summary: entry.detail ? `${operationLabel(entry.operation)} · ${entry.detail}` : operationLabel(entry.operation),
    });
  }
  for (const run of runs) {
    rows.push({
      key: `run-${run.at}-${run.scriptName}`,
      at: run.at,
      kind: 'verify',
      outcome: run.outcome === 'passed' ? 'ok' : 'fail',
      summary: `${run.scriptName} → ${run.outcome} (${run.durationMs}ms)`,
      run,
    });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface TimelineFilter {
  kind: 'all' | TimelineKind;
  outcome: 'all' | TimelineOutcome;
}

export function filterTimeline(rows: TimelineRow[], filter: TimelineFilter): TimelineRow[] {
  return rows.filter(row =>
    (filter.kind === 'all' || row.kind === filter.kind)
    && (filter.outcome === 'all' || row.outcome === filter.outcome),
  );
}

export function summarizeTimeline(runs: RunListEntry[], draftCount: number, noteCount: number): {
  runCount: number;
  passRate: number | null;
  draftCount: number;
  noteCount: number;
} {
  const outcomes = runs.filter(run => run.outcome === 'passed' || run.outcome === 'failed');
  return {
    runCount: runs.length,
    passRate: outcomes.length === 0 ? null : Math.round((outcomes.filter(run => run.outcome === 'passed').length / outcomes.length) * 100),
    draftCount,
    noteCount,
  };
}
