import type { ObserverStuckReport } from '@/api';
import { formatDurationMs } from '@/features/observe/observer-labels';

export function StuckPanel({ report, emptyCopy }: {
  report: ObserverStuckReport;
  emptyCopy?: string;
}) {
  const clean = report.retries.length === 0 && report.rereads.length === 0
    && report.slow.length === 0 && report.interruptions === 0 && report.compactions === 0;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Signals that a run is thrashing — repeated or slow commands, re-reads, stops, and context resets.
      </p>
      <p className="text-sm text-muted-foreground">
        You stopped it: {report.interruptions} · context resets: {report.compactions}
      </p>
      {report.afterInterrupt.length > 0 && (
        <section aria-label="After interruption">
          <ul className="grid gap-1">
            {report.afterInterrupt.map((line, index) => (
              <li key={index} className="break-words border-l-2 border-border px-3 py-1 text-xs leading-5 text-muted-foreground">
                after interruption: {line}
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.retries.length > 0 && (
        <section aria-label="Repeated commands">
          <h3 className="text-sm font-semibold">Repeated commands</h3>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {report.retries.map(retry => (
              <li key={retry.signature} className="py-2">
                <p className="break-words font-mono text-xs">{retry.signature}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{retry.runs} runs · {retry.fails} failed</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.rereads.length > 0 && (
        <section aria-label="Files read over and over">
          <h3 className="text-sm font-semibold">Files read over and over</h3>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {report.rereads.map(reread => (
              <li key={`${reread.agent} ${reread.path}`} className="py-2">
                <p className="break-words font-mono text-xs">{reread.path}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{reread.reads} reads · {reread.agent}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.slow.length > 0 && (
        <section aria-label="Slow commands">
          <h3 className="text-sm font-semibold">Slow commands</h3>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {report.slow.map(item => (
              <li key={`${item.ms} ${item.command}`} className="py-2">
                <p className="break-words font-mono text-xs">{item.command}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatDurationMs(item.ms)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {clean && <p role="status" className="py-2 text-sm text-muted-foreground">{emptyCopy ?? 'Clean — no stuck signals.'}</p>}
    </div>
  );
}
