import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CheckpointNote, Lease, RunListEntry, Workstream } from '@/api';
import { projectRootLabel } from '@/features/projects/root-label';

/**
 * Hours without a new checkpoint before an active, blocked workstream reads
 * as needing attention. Client-side date math only; 24h keeps overnight
 * stalls visible without flagging a normal workday pause.
 */
export const STUCK_AFTER_HOURS = 24;
const stuckAfterMs = STUCK_AFTER_HOURS * 3_600_000;

/**
 * An active workstream with a non-empty blocker and no new checkpoint within
 * STUCK_AFTER_HOURS reads as stuck. An unparseable timestamp never proves
 * staleness, so it reads as not stuck.
 */
export function isWorkstreamStuck(
  status: Workstream['status'],
  note: CheckpointNote | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (status !== 'active') return false;
  if (!note || !note.blocker.trim()) return false;
  const at = Date.parse(note.at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at > stuckAfterMs;
}

export function checkpointAgeLabel(at: string, nowMs: number = Date.now()): string {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return 'date unknown';
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Evidence refs are opaque run IDs; truncate long ones so only a masked ref renders. */
export function maskEvidenceRef(ref: string): string {
  return ref.length > 24 ? `${ref.slice(0, 24)}…` : ref;
}

function EvidenceChips({ evidence, runs }: { evidence: string[]; runs: RunListEntry[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Linked runs">
      {evidence.map(ref => {
        const run = runs.find(candidate => candidate.id === ref);
        const pinned = run?.pinnedByNote === true;
        return (
          <li key={ref}>
            <span
              title={ref}
              className={`inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-[0.7rem] leading-5 ${pinned ? 'border-success/50 bg-success/10 text-success' : 'border-border text-muted-foreground'}`}
            >
              {pinned && run ? `linked run · ${run.scriptName} → ${run.outcome}` : maskEvidenceRef(ref)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CheckpointHistory({ workstream, runs }: { workstream: Workstream; runs: RunListEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const history = workstream.checkpointHistory ?? [];
  if (history.length === 0) return null;
  const regionId = `checkpoint-history-${workstream.id}`;
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded(current => !current)}
      >
        {expanded ? `Hide checkpoint history (${history.length})` : `Show checkpoint history (${history.length})`}
      </Button>
      {expanded && (
        <ol id={regionId} className="mt-1 divide-y divide-border border-y border-border">
          {history.map(entry => (
            <li key={`${entry.at}-${entry.owner}-${entry.goal}`} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant="outline">{entry.owner}</Badge>
                <time dateTime={entry.at} title={Number.isNaN(Date.parse(entry.at)) ? entry.at : new Date(entry.at).toLocaleString()} className="text-xs text-muted-foreground">
                  {checkpointAgeLabel(entry.at)}
                </time>
              </div>
              <p className="mt-1 break-words text-sm leading-6">{entry.goal || 'No goal recorded.'}</p>
              <EvidenceChips evidence={entry.evidence} runs={runs} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function WorkstreamCard({ workstream, leases, runs }: {
  workstream: Workstream;
  leases: Lease[];
  runs: RunListEntry[];
}) {
  const mine = leases.filter(lease => lease.workstreamId === workstream.id);
  const queuePosition = (target: Lease) => leases
    .filter(lease => lease.resource === target.resource && lease.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .findIndex(lease => lease.workstreamId === target.workstreamId && lease.createdAt === target.createdAt) + 1;
  const stuck = isWorkstreamStuck(workstream.status, workstream.checkpointNote);
  const note = workstream.checkpointNote;
  const latestCompletion = workstream.completions?.length ? workstream.completions[workstream.completions.length - 1] : null;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{workstream.name}</p>
        <span className="flex flex-wrap items-center gap-1.5">
          {latestCompletion && <Badge variant="outline">Completion: {latestCompletion.outcome}</Badge>}
          <Badge variant="outline">{workstream.status}</Badge>
        </span>
      </div>
      {stuck && (
        <p role="status" className="mt-2 border-l-2 border-warning bg-warning-background px-3 py-2 text-xs leading-5 text-warning">
          <strong className="font-semibold">Needs you</strong> — blocked with no new checkpoint in the last {STUCK_AFTER_HOURS}h.
        </p>
      )}
      <ul className="mt-1 grid gap-1">
        {workstream.checkouts.map(checkout => (
          <li key={checkout.root} className="break-all font-mono text-xs text-muted-foreground">
            …/{projectRootLabel(checkout.root)} · rev {checkout.revision ? `${checkout.revision.slice(0, 12)}…` : 'unknown'}
          </li>
        ))}
      </ul>
      {note ? (
        <dl className="mt-2 grid gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <dt className="sr-only">Checkpoint owner and age</dt>
            <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge variant="outline">{note.owner}</Badge>
              <time dateTime={note.at} title={Number.isNaN(Date.parse(note.at)) ? note.at : new Date(note.at).toLocaleString()}>
                {checkpointAgeLabel(note.at)}
              </time>
            </dd>
          </div>
          <div><dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Goal</dt><dd className="break-words text-sm leading-6">{note.goal || 'No goal recorded.'}</dd></div>
          <div><dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Blocker</dt><dd className="break-words text-sm leading-6">{note.blocker || 'None.'}</dd></div>
          <div><dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Next</dt><dd className="break-words text-sm leading-6">{note.next || 'Nothing queued.'}</dd></div>
          <EvidenceChips evidence={note.evidence} runs={runs} />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No checkpoint recorded yet.</p>
      )}
      {mine.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {mine.map(lease => (
            <li key={`${lease.resource}-${lease.createdAt}`} className="break-all font-mono text-xs text-muted-foreground">
              <span>{lease.resource} · {lease.status}{lease.status === 'queued' ? ` (position ${queuePosition(lease)})` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <CheckpointHistory workstream={workstream} runs={runs} />
    </li>
  );
}
