import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/api';
import { formatTime, kindOptions, shortId, sinceOptions } from '@/features/observe/observer-labels';
import type { ObserverSessionInfo } from '@/api';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

function groupByDir(sessions: ObserverSessionInfo[]): { dir: string; sessions: ObserverSessionInfo[] }[] {
  const byDir = new Map<string, ObserverSessionInfo[]>();
  for (const session of sessions) {
    const key = session.workdir ?? '(folder unknown)';
    const list = byDir.get(key) ?? [];
    list.push(session);
    byDir.set(key, list);
  }
  return [...byDir.entries()].map(([dir, dirSessions]) => ({ dir, sessions: dirSessions }));
}

export function SessionList({ api, since, onSinceChange, onCopyText, refreshToken }: {
  api: ApiClient;
  since: string;
  onSinceChange: (since: string) => void;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
  refreshToken: number;
}) {
  const [dir, setDir] = useState('');
  const [kind, setKind] = useState('');
  const [appliedDir, setAppliedDir] = useState('');

  const { data, warnings, loading, error, reload } = useObserverFetch(async () => {
    const result = await api.observerSessions({ since, dir: appliedDir || undefined, kind: kind || undefined });
    return { data: result.sessions, warnings: result.warnings };
  }, [since, appliedDir, kind, refreshToken]);

  const sessions = data ?? [];
  const filtering = appliedDir !== '' || kind !== '';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">What your assistant ran, newest first — red badges mark failures.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor="observe-since" className="text-xs font-medium text-muted-foreground">Time range</label>
          <select id="observe-since" className="project-select" value={since} onChange={event => onSinceChange(event.currentTarget.value)}>
            {sinceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="grid min-w-44 flex-1 gap-1">
          <label htmlFor="observe-dir" className="text-xs font-medium text-muted-foreground">Project folder</label>
          <Input
            id="observe-dir"
            value={dir}
            placeholder="/path/to/project"
            onChange={event => setDir(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Enter') setAppliedDir(dir.trim()); }}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="observe-kind" className="text-xs font-medium text-muted-foreground">Type</label>
          <select id="observe-kind" className="project-select" value={kind} onChange={event => setKind(event.currentTarget.value)}>
            {kindOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setAppliedDir(dir.trim())}>Apply directory</Button>
      </div>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && sessions.length === 0 && !error && (
        <p role="status" className="py-5 text-sm text-muted-foreground">Reading observed sessions…</p>
      )}
      {!loading && !error && sessions.length === 0 && (
        filtering
          ? (
            <p role="status" className="py-5 text-sm text-muted-foreground">
              No sessions match the current filters in this window. Clear the directory or type filter to see everything.
            </p>
          )
          : (
            <div className="space-y-2 py-5">
              <p role="status" className="text-sm text-muted-foreground">
                Nothing recorded yet. If you haven&apos;t connected your assistant, start on the &quot;Connect your AI&quot; page. Then run any task and it will appear here. If you already connected it, make sure the activity recorder (shell-observer plugin) is enabled — without it, this page stays empty.
              </p>
              <p><a href="#setup" className="text-sm font-medium text-primary underline-offset-4 hover:underline">Connect your AI →</a></p>
            </div>
          )
      )}
      {sessions.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {groupByDir(sessions).map(group => (
            <li key={group.dir}>
              <p className="bg-muted/50 px-1 py-1.5 font-mono text-xs text-muted-foreground">{group.dir}</p>
              <ul className="divide-y divide-border">
          {group.sessions.map(session => (
            <li key={session.sessionID} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-3">
              <a
                href={`#observe/${session.sessionID}`}
                className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 text-left no-underline transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{session.title ?? shortId(session.sessionID)}</span>
                <span className="font-mono text-xs text-muted-foreground">{shortId(session.sessionID)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{session.workdir ?? 'workdir unknown'}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>last activity {formatTime(session.last)}</span>
                  <span>{session.commands} commands</span>
                  {session.fileEdits > 0 && <span>+ {session.fileEdits} edits</span>}
                  {session.childCount > 0 && <Badge variant="outline">↳ {session.childCount} sub</Badge>}
                  {session.fails > 0
                    ? <Badge variant="destructive">{session.fails} failed</Badge>
                    : <Badge variant="outline">clean</Badge>}
                </span>
              </a>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Copy full id of session ${shortId(session.sessionID)}`}
                onClick={() => { void onCopyText(session.sessionID, 'Full session id copied.'); }}
              >
                Copy id
              </Button>
            </li>
          ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {!error && <span>{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} in window.</span>}
        {error && <span>Feed unavailable while the filter error stands.</span>}
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={reload}>
          {loading ? 'Reading…' : 'Refresh list'}
        </Button>
      </p>
    </div>
  );
}
