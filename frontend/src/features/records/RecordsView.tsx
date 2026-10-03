import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  CircleDot,
  ClipboardPaste,
  Database,
  Globe,
  RotateCw,
  ScrollText,
  StickyNote,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ActivityEntry, Learnings, RunListEntry } from '@/api';
import {
  buildTimeline,
  filterTimeline,
  summarizeTimeline,
  type TimelineFilter,
  type TimelineKind,
  type TimelineRow,
} from '@/features/records/timeline';

const pollIntervalMs = 8000;

const kindIcons: Record<TimelineKind, typeof CircleDot> = {
  note: StickyNote,
  verify: BadgeCheck,
  import: ClipboardPaste,
  service: RotateCw,
  data: Database,
  log: ScrollText,
  browser: Globe,
  other: CircleDot,
};

const kindLabels: Record<TimelineKind, string> = {
  note: 'note',
  verify: 'verify',
  import: 'imported',
  service: 'service',
  data: 'data',
  log: 'log',
  browser: 'browser',
  other: 'other',
};

function rowTone(row: TimelineRow) {
  if (row.kind === 'note') return 'text-warning';
  // Pasted results stay warning-toned with explicit not-verified wording in
  // the summary: tone plus text, never color alone.
  if (row.kind === 'import') return 'text-warning';
  if (row.outcome === 'ok') return 'text-success';
  if (row.outcome === 'fail') return 'text-destructive';
  if (row.kind === 'service') return 'text-muted-foreground';
  return row.kind === 'other' ? 'text-muted-foreground' : 'text-foreground';
}

function TimelineItem({ row, expanded, onToggle }: { row: TimelineRow; expanded: boolean; onToggle: () => void }) {
  const Icon = kindIcons[row.kind];
  const expandable = row.outcome === 'fail' && row.run;
  return (
    <li className="flex gap-3 py-2.5">
      <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-background ${rowTone(row)}`} aria-hidden="true">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Badge variant="outline" className="font-normal">{kindLabels[row.kind]}</Badge>
          <p className="min-w-0 flex-1 break-words text-sm leading-6">{row.summary}</p>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{Number.isNaN(Date.parse(row.at)) ? row.at : new Date(row.at).toLocaleString()}</p>
        {expandable && (
          <div className="mt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} failure summary for ${row.run?.scriptName}`}
              onClick={onToggle}
            >
              {expanded ? 'Hide failure summary' : 'Show failure summary'}
            </Button>
            {expanded && row.run && (
              <div className="mt-2 rounded-md border border-destructive/40 px-3 py-2">
                {row.run.failingNames.length > 0 ? (
                  <ul className="grid gap-1 text-xs leading-5">
                    {row.run.failingNames.map(name => <li key={name} className="break-words font-mono">{name}</li>)}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No failing test names were extracted.</p>
                )}
                {row.run.excerptPreview && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs leading-5">{row.run.excerptPreview}</pre>
                )}
                <p className="mt-1 text-xs text-muted-foreground">Masked excerpt, capped at 200 characters.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function RecordsView({ workspaceId, activity, learnings, runs, loading, error, updatedAt, onReload }: {
  workspaceId: string;
  activity: ActivityEntry[];
  learnings: Learnings;
  runs: RunListEntry[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
  onReload: (workspaceId: string) => void;
}) {
  const [filter, setFilter] = useState<TimelineFilter>({ kind: 'all', outcome: 'all' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The reload callback identity changes on every workbench state commit
  // (loadRecords commits loading/results). Holding it in a ref keeps the
  // poll subscription stable so refreshes wait the full interval instead of
  // resubscribing — and refiring — on every commit, including errors.
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;

  useEffect(() => {
    reloadRef.current(workspaceId);
    const timer = window.setInterval(() => reloadRef.current(workspaceId), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  const rows = useMemo(() => buildTimeline(learnings.milestones, activity, runs, workspaceId), [learnings, activity, runs, workspaceId]);
  const visible = useMemo(() => filterTimeline(rows, filter), [rows, filter]);
  const summary = useMemo(() => summarizeTimeline(runs, learnings.drafts.length, learnings.milestones.length), [runs, learnings]);

  const toggleExpanded = (key: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="records-summary-heading" className="max-w-4xl">
        <h2 id="records-summary-heading" className="sr-only">Record summary</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border px-3 py-2.5">
            <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Runs</dt>
            <dd className="mt-0.5 text-lg font-semibold">{summary.runCount}</dd>
          </div>
          <div className="rounded-lg border border-border px-3 py-2.5">
            <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Pass rate</dt>
            <dd className="mt-0.5 text-lg font-semibold">{summary.passRate === null ? '—' : `${summary.passRate}%`}</dd>
          </div>
          <div className="rounded-lg border border-border px-3 py-2.5">
            <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Drafts</dt>
            <dd className="mt-0.5 text-lg font-semibold">{summary.draftCount}</dd>
          </div>
          <div className="rounded-lg border border-border px-3 py-2.5">
            <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Notes</dt>
            <dd className="mt-0.5 text-lg font-semibold">{summary.noteCount}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="draft-strip-heading" className="max-w-4xl rounded-lg border border-warning/50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="draft-strip-heading" className="text-sm font-semibold">Unprocessed learnings</h2>
          <Badge variant="outline">{learnings.drafts.length} pending</Badge>
        </div>
        {learnings.drafts.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">No unprocessed drafts. Surprises become drafts via the learn-from-mistake skill.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {learnings.drafts.map(draft => (
              <li key={draft.name} className="break-words text-sm leading-6">
                <span aria-hidden="true" className="mr-2 inline-block size-1.5 rounded-full bg-warning" />
                {draft.title}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Read-only in this view. A draft becomes shared guidance only when you approve it in chat with your assistant.</p>
      </section>

      <section aria-labelledby="records-timeline-heading" className="max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <p className="eyebrow">RECORD</p>
            <h2 id="records-timeline-heading" className="text-base font-semibold">What happened here</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Agent notes first, then the recorded receipts. {updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}.` : 'Loading…'}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <label htmlFor="records-kind-filter" className="text-xs font-medium text-muted-foreground">Kind</label>
              <select
                id="records-kind-filter"
                className="project-select"
                value={filter.kind}
                onChange={event => setFilter(current => ({ ...current, kind: event.target.value as TimelineFilter['kind'] }))}
              >
                <option value="all">All kinds</option>
                <option value="note">Notes</option>
                <option value="verify">Verify</option>
                <option value="import">Imported</option>
                <option value="service">Service</option>
                <option value="data">Data</option>
                <option value="log">Logs</option>
                <option value="browser">Browser</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor="records-outcome-filter" className="text-xs font-medium text-muted-foreground">Outcome</label>
              <select
                id="records-outcome-filter"
                className="project-select"
                value={filter.outcome}
                onChange={event => setFilter(current => ({ ...current, outcome: event.target.value as TimelineFilter['outcome'] }))}
              >
                <option value="all">All outcomes</option>
                <option value="ok">Passed / ok</option>
                <option value="fail">Failed / denied</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => onReload(workspaceId)}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">Records could not be refreshed: {error}</p>
        )}
        {learnings.milestones.length === 0 && rows.length > 0 && (
          <p role="status" className="mt-3 border-l-2 border-border px-3 py-1 text-xs text-muted-foreground">
            No agent notes in this interval — the receipts below are the complete record.
          </p>
        )}
        {visible.length === 0 ? (
          <p role="status" className="py-5 text-sm text-muted-foreground">
            {rows.length === 0 ? 'Nothing recorded for this project yet. Run a verification or ask your assistant to note a milestone.' : 'No rows match these filters.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map(row => (
              <TimelineItem key={row.key} row={row} expanded={expanded.has(row.key)} onToggle={() => toggleExpanded(row.key)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
