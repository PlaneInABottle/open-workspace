import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/api';
import { shortId, sinceOptions } from '@/features/observe/observer-labels';
import { StuckPanel } from '@/features/observe/StuckPanel';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

export function StuckView({ api, since, onSinceChange, refreshToken }: {
  api: ApiClient;
  since: string;
  onSinceChange: (since: string) => void;
  refreshToken: number;
}) {
  const { data, warnings, loading, error, reload } = useObserverFetch(async () => {
    const result = await api.observerStuckGlobal({ since });
    return { data: result.entries, warnings: result.warnings };
  }, [since, refreshToken]);

  const entries = data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Needs attention</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Where runs are struggling: repeats, slow commands, your stops.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor="stuck-since" className="text-xs font-medium text-muted-foreground">Time range</label>
          <select id="stuck-since" className="project-select" value={since} onChange={event => onSinceChange(event.currentTarget.value)}>
            {sinceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && entries.length === 0 && !error && (
        <p role="status" className="py-5 text-sm text-muted-foreground">Reading stuck signals…</p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p role="status" className="py-5 text-sm text-muted-foreground">Clean — no stuck signals in this window.</p>
      )}
      {entries.length > 0 && (
        <ul className="grid gap-6">
          {entries.map(entry => (
            <li key={entry.session} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
              <h3 className="text-sm font-semibold">
                <a className="font-mono underline-offset-4 hover:underline" href={`#observe/${entry.session}`}>{shortId(entry.session)}</a>
              </h3>
              <div className="mt-2"><StuckPanel report={entry.report} /></div>
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{entries.length} {entries.length === 1 ? 'session' : 'sessions'} with signals.</span>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={reload}>
          {loading ? 'Reading…' : 'Refresh signals'}
        </Button>
      </p>
    </div>
  );
}
