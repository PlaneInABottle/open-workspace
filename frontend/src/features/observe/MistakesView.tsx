import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/api';
import { MistakeRowItem } from '@/features/observe/ActivityList';
import { sinceOptions } from '@/features/observe/observer-labels';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

export function MistakesView({ api, since, onSinceChange, refreshToken }: {
  api: ApiClient;
  since: string;
  onSinceChange: (since: string) => void;
  refreshToken: number;
}) {
  const [session, setSession] = useState('');
  const [agent, setAgent] = useState('');
  const [applied, setApplied] = useState({ session: '', agent: '' });

  const { data, warnings, loading, error, reload } = useObserverFetch(async () => {
    const result = await api.observerMistakes({
      since,
      session: applied.session || undefined,
      agent: applied.agent || undefined,
    });
    return { data: result.rows, warnings: result.warnings };
  }, [since, applied, refreshToken]);

  const rows = data ?? [];
  const filtering = applied.session !== '' || applied.agent !== '';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Failures</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">What broke and why. Same reason twice means one problem, not two.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor="mistakes-since" className="text-xs font-medium text-muted-foreground">Time range</label>
          <select id="mistakes-since" className="project-select" value={since} onChange={event => onSinceChange(event.currentTarget.value)}>
            {sinceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="grid gap-1">
          <label htmlFor="mistakes-session" className="text-xs font-medium text-muted-foreground">Session id or prefix</label>
          <Input id="mistakes-session" value={session} placeholder="ses_… (full id or short prefix)" onChange={event => setSession(event.currentTarget.value)} />
        </div>
        <div className="grid gap-1">
          <label htmlFor="mistakes-agent" className="text-xs font-medium text-muted-foreground">Agent contains</label>
          <Input id="mistakes-agent" value={agent} placeholder="implementer…" onChange={event => setAgent(event.currentTarget.value)} />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setApplied({ session: session.trim(), agent: agent.trim() })}>Apply filters</Button>
      </div>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && rows.length === 0 && !error && (
        <p role="status" className="py-5 text-sm text-muted-foreground">Reading failures…</p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p role="status" className="py-5 text-sm text-muted-foreground">
          {filtering
            ? 'No failures match the current filters in this window. Clear the session or agent filter to see everything.'
            : 'No failures recorded in this window.'}
        </p>
      )}
      {!error && rows.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {rows.map((row, index) => <MistakeRowItem key={`${row.sessionID}-${row.at}-${index}`} row={row} />)}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {!error && <span>{rows.length} {rows.length === 1 ? 'failure' : 'failures'} · newest first.</span>}
        {error && <span>Feed unavailable while the filter error stands.</span>}
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={reload}>
          {loading ? 'Reading…' : 'Refresh feed'}
        </Button>
      </p>
    </div>
  );
}
