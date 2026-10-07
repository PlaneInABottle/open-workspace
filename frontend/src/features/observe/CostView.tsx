import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/api';
import { CostTable } from '@/features/observe/CostTable';
import { sinceOptions } from '@/features/observe/observer-labels';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

export function CostView({ api, since, onSinceChange, refreshToken }: {
  api: ApiClient;
  since: string;
  onSinceChange: (since: string) => void;
  refreshToken: number;
}) {
  const { data, warnings, loading, error, reload } = useObserverFetch(async () => {
    const result = await api.observerCost({ since });
    return { data: result.rows, warnings: result.warnings };
  }, [since, refreshToken]);

  const rows = data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Cost</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">The bill: what each job burned.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor="cost-since" className="text-xs font-medium text-muted-foreground">Time range</label>
          <select id="cost-since" className="project-select" value={since} onChange={event => onSinceChange(event.currentTarget.value)}>
            {sinceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && rows.length === 0 && !error && (
        <p role="status" className="py-5 text-sm text-muted-foreground">Reading session costs…</p>
      )}
      {(!loading || rows.length > 0) && !error && <CostTable rows={rows} />}
      <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>Recorded cost only — no estimated pricing.</span>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={reload}>
          {loading ? 'Reading…' : 'Refresh costs'}
        </Button>
      </p>
    </div>
  );
}
