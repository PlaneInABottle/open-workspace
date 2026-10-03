import type { ActivityEntry, MilestoneNote, RunListEntry } from '@/api';

export type TimelineKind = 'note' | 'verify' | 'import' | 'service' | 'data' | 'log' | 'browser' | 'other';
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
 * failing names/masked excerpt plus the run source label. Pasted
 * external-import runs never read as verify/ok: they use kind 'import' with
 * a neutral tone and carry their not-verified wording in the summary.
 * Unknown activity operations degrade to kind 'other' rather than
 * disappearing. Runs without a source (legacy files) count as executed here.
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
    // Only runs executed here (or legacy runs without a source) read as
    // verify: pasted and unknown-source runs use kind 'import' with a neutral
    // tone and carry their not-verified wording in the summary.
    const executed = run.source === undefined || run.source === 'openworkspace-run';
    rows.push({
      key: `run-${run.at}-${run.scriptName}`,
      at: run.at,
      kind: executed ? 'verify' : 'import',
      outcome: !executed ? 'neutral' : run.outcome === 'passed' ? 'ok' : 'fail',
      summary: executed
        ? `${run.scriptName} → ${run.outcome} (${run.durationMs}ms)`
        : `${run.scriptName} → ${run.outcome} (${run.durationMs}ms) · ${run.sourceLabel || 'Pasted result — not verified here'}`,
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

export function summarizeTimeline(runs: RunListEntry[], noteCount: number): {
  runCount: number;
  passRate: number | null;
  noteCount: number;
} {
  // Pass rate covers executed runs only: pasted external-import results — and
  // any unknown-source value — are accepted on trust at best and must never
  // inflate or dilute a verification stat. Legacy runs without a source count
  // as executed here.
  const verified = runs.filter(run => run.source === undefined || run.source === 'openworkspace-run');
  const outcomes = verified.filter(run => run.outcome === 'passed' || run.outcome === 'failed');
  return {
    runCount: runs.length,
    passRate: outcomes.length === 0 ? null : Math.round((outcomes.filter(run => run.outcome === 'passed').length / outcomes.length) * 100),
    noteCount,
  };
}
