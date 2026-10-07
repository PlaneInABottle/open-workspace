import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ObserverGroupedLine, ObserverMistakeRow, ObserverTaskGroup } from '@/api';
import { formatTime, isFailureOutcome, messageEyebrow, messageEyebrowClass, outcomeVariant, shortId } from '@/features/observe/observer-labels';

export function GroupedLineRow({ line, defaultExpanded }: { line: ObserverGroupedLine; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [showAllVariants, setShowAllVariants] = useState(false);
  const failed = isFailureOutcome(line.outcome);
  const visibleVariants = showAllVariants ? line.variants : line.variants.slice(0, 10);
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs text-muted-foreground">[{line.ref}]</span>
        <p className="min-w-0 flex-1 truncate font-mono text-xs leading-5 sm:text-[0.8rem]" title={line.signature}>{line.signature}</p>
        <Badge variant={outcomeVariant(line.outcome)}>{line.outcome}{line.runs > 1 ? ` ×${line.runs}` : ''}</Badge>
        {line.agents.length > 0 && <span className="text-xs text-muted-foreground">{line.agents.join(', ')}</span>}
        {failed && line.failReason && <span className="truncate text-xs font-medium text-destructive">· {line.failReason}</span>}
        {line.sessions.length > 0 && <span className="truncate text-xs text-muted-foreground">· {line.sessions.map(shortId).join(', ')}</span>}
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(current => !current)} className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {expanded ? 'hide' : 'detail'}
        </button>
      </div>
      <div className="mt-1">
        {expanded && (
          <div className="mt-2 space-y-2">
            {visibleVariants.map((variant, index) => (
              <pre key={index} className="max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs leading-5">record: {variant}</pre>
            ))}
            {line.variants.length > 10 && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  Showing {visibleVariants.length} of {line.variants.length} stored variants · {line.runs} total runs.
                </p>
                <Button type="button" variant="ghost" size="sm" aria-expanded={showAllVariants} onClick={() => setShowAllVariants(current => !current)}>
                  {showAllVariants ? 'Show fewer variants' : `Show all ${line.variants.length} variants`}
                </Button>
              </div>
            )}
            {line.intents.map((intent, index) => (
              <p key={index} className="break-words text-xs leading-5 text-muted-foreground">intent: {intent}</p>
            ))}
            {line.excerpts.map((excerpt, index) => (
              <pre key={index} className={`max-h-40 overflow-auto rounded border p-2 font-mono text-xs leading-5 ${failed ? 'border-destructive/40' : 'border-border bg-muted/40'}`}>{excerpt}</pre>
            ))}
            {line.results.map((result, index) => (
              <pre key={index} className="max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs leading-5">result: {result}</pre>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function TaskGroupSection({ group, failsOnly }: { group: ObserverTaskGroup; failsOnly?: boolean }) {
  const lines = failsOnly ? group.lines.filter(line => isFailureOutcome(line.outcome)) : group.lines;
  if (lines.length === 0) return null;
  // The attribution eyebrow sits above the clamped header text (never
  // prepended inside it) so the speaker survives truncation.
  const eyebrow = messageEyebrow(group.taskRefKind, group.taskRefAgent);
  return (
    <section aria-label={`Task: ${group.taskRef}`} className="py-2 first:pt-0">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <div className="min-w-0 flex-1">
          {eyebrow && <p className={messageEyebrowClass}>{eyebrow}</p>}
          <h3 className="min-w-0 flex-1 break-words text-sm font-semibold line-clamp-1">{group.taskRef}</h3>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {group.runs} {group.runs === 1 ? 'record' : 'records'}{group.fails > 0 && <> · <span className="font-medium text-destructive">{group.fails} failed</span></>}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {lines.map(line => <GroupedLineRow key={line.ref} line={line} />)}
      </ul>
    </section>
  );
}

export function ActivityList({ groups, failsOnly, emptyCopy }: {
  groups: ObserverTaskGroup[];
  failsOnly?: boolean;
  emptyCopy: string;
}) {
  const visible = failsOnly
    ? groups.map(group => ({ ...group, lines: group.lines.filter(line => isFailureOutcome(line.outcome)) })).filter(group => group.lines.length > 0)
    : groups;
  if (visible.length === 0) {
    return <p role="status" className="py-5 text-sm text-muted-foreground">{emptyCopy}</p>;
  }
  return (
    <div className="divide-y divide-border border-y border-border">
      {visible.map(group => <TaskGroupSection key={group.taskRef} group={group} />)}
    </div>
  );
}

export function MistakeRowItem({ row }: {
  row: ObserverMistakeRow;
}) {
  const [expanded, setExpanded] = useState(false);
  const eyebrow = row.taskRef ? messageEyebrow(row.taskRefKind, row.agent) : null;
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 self-center text-destructive" />
        <p className="min-w-0 flex-1 truncate font-mono text-xs leading-5 sm:text-[0.8rem]" title={row.signature}>{row.signature}</p>
        <Badge variant={outcomeVariant(row.outcome)}>{row.outcome}</Badge>
        {row.excerpt && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(current => !current)} className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            {expanded ? 'hide' : 'output'}
          </button>
        )}
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <a className="font-mono underline-offset-4 hover:underline" href={`#observe/${row.sessionID}`}>{shortId(row.sessionID)}</a>
        {row.at && <span>{formatTime(row.at)}</span>}
        {row.agent && <span>{row.agent}</span>}
        {row.failReason && <span className="truncate font-medium text-destructive">· {row.failReason}</span>}
      </p>
      {row.taskRef && (
        <p className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground" title={row.taskRef}>
          {eyebrow ? `${eyebrow} ` : ''}{row.taskRef}
        </p>
      )}
      {expanded && row.excerpt && <pre className="mt-1 max-h-40 overflow-auto rounded border border-destructive/40 p-2 font-mono text-xs leading-5">{row.excerpt}</pre>}
    </li>
  );
}
