import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/api';
import type { ObserveRoute } from '@/hash-navigation';
import { CostView } from '@/features/observe/CostView';
import { MistakesView } from '@/features/observe/MistakesView';
import { formatCost } from '@/features/observe/observer-labels';
import { SessionDetailView } from '@/features/observe/SessionDetailView';
import { SessionList } from '@/features/observe/SessionList';
import { StuckView } from '@/features/observe/StuckView';
import { useObserverFetch } from '@/features/observe/use-observer';

const tabLabels = [
  { tab: 'sessions', label: 'Sessions', href: '#observe' },
  { tab: 'mistakes', label: 'Failures', href: '#observe/mistakes' },
  { tab: 'stuck', label: 'Needs attention', href: '#observe/stuck' },
  { tab: 'cost', label: 'Cost', href: '#observe/cost' },
] as const;

const sessionIdPattern = /^ses_[A-Za-z0-9]{5,}$/;

function activeTab(route: ObserveRoute): string {
  if (route.tab === 'session') return 'sessions';
  return route.tab;
}

function DoctorLine({ api, refreshToken }: { api: ApiClient; refreshToken: number }) {
  const [showDetails, setShowDetails] = useState(false);
  const { data, error, loading } = useObserverFetch(async () => {
    const result = await api.observerDoctor();
    return { data: result.checks, warnings: result.warnings };
  }, [refreshToken]);
  if (loading && !data && !error) return null;
  if (error && !data) {
    return (
      <p role="status" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-destructive">observer health unavailable: {error}</span>
      </p>
    );
  }
  if (!data) return null;
  const failing = data.filter(check => !check.ok);
  const status = failing.length === 0
    ? 'Recording: active — capturing commands, file edits and tool calls.'
    : `Recording: degraded — ${failing.length} ${failing.length === 1 ? 'check' : 'checks'} failing.`;
  return (
    <div className="space-y-1">
      <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={failing.length === 0 ? undefined : 'font-medium text-destructive'}>{status}</span>
        <Button type="button" variant="ghost" size="sm" aria-expanded={showDetails} onClick={() => setShowDetails(current => !current)}>
          {showDetails ? 'Hide details' : 'Details'}
        </Button>
      </p>
      {showDetails && (
        <p role="status" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {data.map(check => (
            <span key={check.name} className={check.ok ? undefined : 'font-medium text-destructive'}>
              {check.ok ? '✓' : '✗'} {check.name}: {check.detail}
            </span>
          ))}
          {failing.length === 0 && <span>Recorder is working</span>}
          {error && <span className="font-medium text-destructive">(refresh failed: {error})</span>}
        </p>
      )}
    </div>
  );
}

function DigestLine({ api, since, refreshToken }: { api: ApiClient; since: string; refreshToken: number }) {
  const { data, warnings, loading, error } = useObserverFetch(async () => {
    const [sessions, mistakes, cost, stuck] = await Promise.all([
      api.observerSessions({ since }),
      api.observerMistakes({ since }),
      api.observerCost({ since }),
      api.observerStuckGlobal({ since }),
    ]);
    const totalCost = cost.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    const anyCost = cost.rows.some(row => row.cost !== null);
    return {
      data: {
        sessions: sessions.sessions.length,
        failures: mistakes.rows.length,
        cost: anyCost ? formatCost(totalCost) : null,
        stuck: stuck.entries.length,
      },
      warnings: [...sessions.warnings, ...mistakes.warnings, ...cost.warnings, ...stuck.warnings].slice(0, 3),
    };
  }, [since, refreshToken]);
  if (loading && !data) {
    return <p role="status" className="mt-1 text-xs text-muted-foreground">Summarizing this window…</p>;
  }
  if (!data) {
    return <p role="status" className="mt-1 text-xs text-muted-foreground">Window summary unavailable{error ? `: ${error}` : '.'}</p>;
  }
  // The counts above are window-rolled: truncation and cap warnings are the
  // indicator that older history fell out of the digest, never silent.
  const digestWarnings = [...new Set(warnings)];
  return (
    <div className="mt-1">
      <p role="status" className="text-xs text-muted-foreground">
        {data.sessions} {data.sessions === 1 ? 'session' : 'sessions'} · {data.failures} {data.failures === 1 ? 'failure' : 'failures'} · {data.cost ?? 'cost unrecorded'} · {data.stuck} stuck in window.
      </p>
      <p role="status" className="mt-0.5 text-xs text-muted-foreground">
        {data.sessions} sessions · {data.failures} failures · {data.cost ?? 'cost unrecorded'} — {data.failures > 0 ? 'start with Failures.' : 'all clear.'}
      </p>
      {digestWarnings.length > 0 && (
        <p role="status" className="mt-1 text-xs text-warning">
          {digestWarnings.map(warning => <span key={warning} className="mr-3">{warning}</span>)}
        </p>
      )}
    </div>
  );
}

export function ObserveView({ api, route, onCopyText, refreshToken }: {
  api: ApiClient;
  route: ObserveRoute;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
  refreshToken: number;
}) {
  // One window for every observe tab, carried into the session detail so the
  // numbers stay comparable across the surface.
  const [since, setSince] = useState('1d');
  const current = activeTab(route);
  const invalidSession = route.tab === 'session' && !sessionIdPattern.test(route.sessionID.trim());

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-5">
        <p className="eyebrow">ACTIVITY ON THIS MACHINE</p>
        <h1 className="text-2xl font-semibold tracking-tight">What your AI did</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          A read-only history of what your assistant ran here — every command, file edit and tool call. Nothing on this page changes anything. Pick a session to inspect it, or use the tabs to find failures, friction and cost.
        </p>
        {route.tab !== 'session' && <DigestLine api={api} since={since} refreshToken={refreshToken} />}
        <div className="mt-3"><DoctorLine api={api} refreshToken={refreshToken} /></div>
      </header>

      <div role="tablist" aria-label="Observe sections" className="flex flex-wrap gap-1 border-b border-border">
        {tabLabels.map(entry => (
          <a
            key={entry.tab}
            href={entry.href}
            role="tab"
            aria-selected={current === entry.tab}
            aria-controls="observe-panel"
            className={`min-h-9 px-3 py-1.5 text-sm font-medium no-underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${current === entry.tab ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {entry.label}
          </a>
        ))}
      </div>

      <div role="tabpanel" id="observe-panel" aria-label="Observe content">
        {invalidSession && (
          <div role="status" className="mb-5 space-y-1 rounded-lg border border-border px-4 py-3">
            <p className="text-sm font-medium">Unknown session id — showing the session picker instead.</p>
            <p className="text-sm text-muted-foreground">“{route.tab === 'session' ? route.sessionID : ''}” is not a session id.</p>
          </div>
        )}
        {route.tab === 'sessions' && <SessionList api={api} since={since} onSinceChange={setSince} onCopyText={onCopyText} refreshToken={refreshToken} />}
        {route.tab === 'session' && !invalidSession && <SessionDetailView api={api} sessionID={route.sessionID} since={since} onSinceChange={setSince} onCopyText={onCopyText} refreshToken={refreshToken} />}
        {route.tab === 'session' && invalidSession && <SessionList api={api} since={since} onSinceChange={setSince} onCopyText={onCopyText} refreshToken={refreshToken} />}
        {route.tab === 'mistakes' && <MistakesView api={api} since={since} onSinceChange={setSince} refreshToken={refreshToken} />}
        {route.tab === 'stuck' && <StuckView api={api} since={since} onSinceChange={setSince} refreshToken={refreshToken} />}
        {route.tab === 'cost' && <CostView api={api} since={since} onSinceChange={setSince} refreshToken={refreshToken} />}
      </div>
    </div>
  );
}
