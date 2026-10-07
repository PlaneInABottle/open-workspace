import { ArrowLeft, Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ApiClient, ObserverSessionMeta } from '@/api';
import { ActivityList } from '@/features/observe/ActivityList';
import { SessionTree } from '@/features/observe/SessionTree';
import { StuckPanel } from '@/features/observe/StuckPanel';
import { formatChanges, formatCost, formatTokens, kindOptions, messageEyebrow, messageEyebrowClass, shortId, sinceOptions } from '@/features/observe/observer-labels';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

type DetailTab = 'tree' | 'activity' | 'mistakes' | 'stuck' | 'prompts' | 'reads';

const tabs: { id: DetailTab; label: string }[] = [
  { id: 'tree', label: 'Task tree' },
  { id: 'activity', label: 'Actions' },
  { id: 'mistakes', label: 'Failures' },
  { id: 'stuck', label: 'Needs attention' },
  { id: 'prompts', label: 'Your messages' },
  { id: 'reads', label: 'Files read' },
];

const pollIntervalMs = 8000;

function MetaStrip({ meta, warning, warnings, loading, error, sessionID, onCopyText }: {
  meta: ObserverSessionMeta | null;
  warning: string | null;
  warnings: string[];
  loading: boolean;
  error: string | null;
  sessionID: string;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
}) {
  if (loading && !meta && !error) {
    return <p role="status" className="text-sm text-muted-foreground">Reading session account…</p>;
  }
  if (!meta) {
    // Single render of the degradation: the envelope warning already is the
    // warnings[] entry, so it must not appear twice.
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {error ?? warning ?? 'No account for this session. The session database may be unreadable; shell records below still work.'}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <WarningsStrip warnings={warnings} />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border px-3 py-2.5">
          <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Session</dt>
          <dd className="mt-0.5 break-words font-mono text-xs font-semibold">{shortId(meta.sessionID)}</dd>
          {meta.title && <dd className="mt-0.5 break-words text-xs text-muted-foreground">{meta.title}</dd>}
          <dd className="mt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { void onCopyText(sessionID, 'Full session id copied.'); }}
            >
              Copy full id
            </Button>
          </dd>
        </div>
        <div className="rounded-lg border border-border px-3 py-2.5">
          <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Cost</dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold">{formatCost(meta.cost)}</dd>
          <dd className="mt-0.5 font-mono text-xs text-muted-foreground">{formatTokens(meta.tokens)}</dd>
        </div>
        <div className="rounded-lg border border-border px-3 py-2.5">
          <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Changes</dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold">{formatChanges(meta.additions, meta.deletions, meta.files)}</dd>
          <dd className="mt-0.5 text-xs text-muted-foreground">{meta.userTurns} user / {meta.assistantTurns} assistant turns</dd>
        </div>
        <div className="rounded-lg border border-border px-3 py-2.5">
          <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Directory</dt>
          <dd className="mt-0.5 break-all font-mono text-xs">{meta.directory ?? '—'}</dd>
          {meta.models.length > 0 && <dd className="mt-0.5 break-words text-xs text-muted-foreground">{meta.models.join(', ')}</dd>}
        </div>
      </dl>
      {meta.lastWord && (
        <div className="rounded-lg border border-border px-3 py-2.5">
          <p className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Last assistant message</p>
          <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{meta.lastWord}</p>
        </div>
      )}
    </div>
  );
}

export function SessionDetailView({ api, sessionID, since, onSinceChange, onCopyText, refreshToken }: {
  api: ApiClient;
  sessionID: string;
  since: string;
  onSinceChange: (since: string) => void;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
  refreshToken: number;
}) {
  const [tab, setTab] = useState<DetailTab>('tree');
  const [treeScope, setTreeScope] = useState(false);
  const [kind, setKind] = useState('');
  const [tool, setTool] = useState('');
  const [appliedTool, setAppliedTool] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => setTick(current => current + 1), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    setTab('tree');
    setTreeScope(false);
    setTick(0);
  }, [sessionID]);

  const metaQuery = useObserverFetch(async () => {
    const result = await api.observerMeta(sessionID);
    return { data: result, warnings: result.warnings };
  }, [sessionID, refreshToken]);

  const recordsActive = tab === 'tree' || tab === 'activity' || tab === 'mistakes';
  const recordsQuery = useObserverFetch(async () => {
    const result = await api.observerRecords(sessionID, {
      since,
      kind: kind || undefined,
      tool: appliedTool || undefined,
      tree: tab === 'tree' ? true : treeScope,
    });
    return { data: result, warnings: result.warnings };
  }, [sessionID, since, kind, appliedTool, refreshToken, tick, treeScope, tab === 'tree'], recordsActive);
  const groups = recordsQuery.data?.groups ?? [];
  const tree = recordsQuery.data?.tree ?? null;

  const stuckQuery = useObserverFetch(async () => {
    const result = await api.observerStuck(sessionID, { since, tree: treeScope });
    return { data: result, warnings: result.warnings };
  }, [sessionID, since, refreshToken, tick, treeScope], tab === 'stuck');

  const promptsQuery = useObserverFetch(async () => {
    const result = await api.observerPrompts(sessionID);
    return { data: result.prompts, warnings: result.warnings };
  }, [sessionID, refreshToken, tick], tab === 'prompts');

  const readsQuery = useObserverFetch(async () => {
    const result = await api.observerReads(sessionID, { since });
    return { data: result.reads, warnings: result.warnings };
  }, [sessionID, since, refreshToken, tick], tab === 'reads');

  function switchToActivityFor(childID: string) {
    if (childID !== sessionID) {
      window.location.hash = `observe/${childID}`;
      return;
    }
    setTab('activity');
  }

  const scopeLabel = tab === 'tree'
    ? 'Showing: this run + its sub-agents'
    : tab === 'prompts' || tab === 'reads'
      ? 'Showing: this run only'
      : treeScope ? 'Showing: this run + its sub-agents' : 'Showing: this run only';
  const scopeToggleVisible = tab === 'activity' || tab === 'mistakes' || tab === 'stuck';

  // Unknown (or window-empty) session: no account, no records, no error.
  // Fall back to the picker with a notice instead of an empty shell.
  const metaLoaded = metaQuery.data !== null || metaQuery.error !== null;
  const recordsLoaded = recordsQuery.data !== null || recordsQuery.error !== null;
  const unknownSession = metaLoaded && recordsLoaded
    && !metaQuery.loading && !recordsQuery.loading
    && !metaQuery.error && !recordsQuery.error
    && metaQuery.data?.meta === null
    && tree === null && groups.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href="#observe" className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <ArrowLeft aria-hidden="true" className="size-3.5" /> Sessions
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <div className="grid gap-1">
            <label htmlFor="detail-since" className="sr-only">Time range</label>
            <select id="detail-since" className="project-select" value={since} onChange={event => onSinceChange(event.currentTarget.value)}>
              {sinceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh(current => !current)}
          >
            {autoRefresh ? <><Pause aria-hidden="true" data-icon="inline-start" /> Pause live</> : <><Play aria-hidden="true" data-icon="inline-start" /> Live</>}
          </Button>
        </div>
      </div>

      <MetaStrip
        meta={metaQuery.data?.meta ?? null}
        warning={metaQuery.data?.warning ?? null}
        warnings={metaQuery.warnings}
        loading={metaQuery.loading}
        error={metaQuery.error}
        sessionID={sessionID}
        onCopyText={onCopyText}
      />

      {unknownSession && (
        <div role="status" className="space-y-2 rounded-lg border border-border px-4 py-3">
          <p className="text-sm font-medium">Unknown session — showing the session picker instead.</p>
          <p className="text-sm text-muted-foreground">
            No account or records for this id in the selected window. It may be mistyped,
            outside the window, or the databases unreadable.
          </p>
          <p><a href="#observe" className="text-sm font-medium text-primary underline-offset-4 hover:underline">Back to sessions</a></p>
        </div>
      )}

      <div role="tablist" aria-label="Session sections" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`session-panel-${entry.id}`}
            id={`session-tab-${entry.id}`}
            className={`min-h-9 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${tab === entry.id ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {scopeToggleVisible && (
          <div role="group" aria-label="Record scope" className="flex flex-wrap items-center gap-1">
            <Button type="button" variant={!treeScope ? 'default' : 'outline'} size="sm" aria-pressed={!treeScope} onClick={() => setTreeScope(false)}>
              This session
            </Button>
            <Button type="button" variant={treeScope ? 'default' : 'outline'} size="sm" aria-pressed={treeScope} onClick={() => setTreeScope(true)}>
              Whole tree
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{scopeLabel}</p>
      </div>

      {(tab === 'tree' || tab === 'activity') && (
        <p className="text-sm text-muted-foreground">Who did this job: the run and its sub-agents, indented.</p>
      )}

      {(tab === 'tree' || tab === 'activity' || tab === 'mistakes') && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label htmlFor="detail-kind" className="text-xs font-medium text-muted-foreground">Type</label>
            <select id="detail-kind" className="project-select" value={kind} onChange={event => setKind(event.currentTarget.value)}>
              {kindOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor="detail-tool" className="text-xs font-medium text-muted-foreground">Tool contains</label>
            <input
              id="detail-tool"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={tool}
              placeholder="mcp, execute, read…"
              onChange={event => setTool(event.currentTarget.value)}
              onKeyDown={event => { if (event.key === 'Enter') setAppliedTool(tool.trim()); }}
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAppliedTool(tool.trim())}>Apply tool</Button>
        </div>
      )}

      {recordsActive && <WarningsStrip warnings={recordsQuery.warnings} />}
      {recordsQuery.error && recordsActive && (
        <p role="alert" className="text-sm text-destructive">{recordsQuery.error}</p>
      )}

      {tab === 'tree' && (
        <div role="tabpanel" id="session-panel-tree" aria-labelledby="session-tab-tree">
          {recordsQuery.error
            ? null
            : recordsQuery.loading && !tree
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading session tree…</p>
              : tree
                ? <SessionTree tree={tree} onViewRecords={switchToActivityFor} />
                : <p role="status" className="py-5 text-sm text-muted-foreground">(no records for this session)</p>}
          {tree && groups.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold">All records in this tree</h3>
              <div className="mt-2"><ActivityList groups={groups} emptyCopy="(no records for this session)" /></div>
            </div>
          )}
        </div>
      )}
      {tab === 'activity' && (
        <div role="tabpanel" id="session-panel-activity" aria-labelledby="session-tab-activity">
          {recordsQuery.error
            ? null
            : recordsQuery.loading && groups.length === 0
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading session activity…</p>
              : <ActivityList groups={groups} emptyCopy="(no records for this session)" />}
        </div>
      )}
      {tab === 'mistakes' && (
        <div role="tabpanel" id="session-panel-mistakes" aria-labelledby="session-tab-mistakes">
          {recordsQuery.error
            ? null
            : recordsQuery.loading && groups.length === 0
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading session failures…</p>
              : <ActivityList groups={groups} failsOnly emptyCopy="No failures recorded for this session in this window." />}
        </div>
      )}
      {tab === 'stuck' && (
        <div role="tabpanel" id="session-panel-stuck" aria-labelledby="session-tab-stuck">
          <WarningsStrip warnings={stuckQuery.warnings} />
          {stuckQuery.error
            ? <p role="alert" className="text-sm text-destructive">{stuckQuery.error}</p>
            : stuckQuery.loading && !stuckQuery.data
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading stuck signals…</p>
              : stuckQuery.data && <StuckPanel report={stuckQuery.data.report} />}
        </div>
      )}
      {tab === 'prompts' && (
        <div role="tabpanel" id="session-panel-prompts" aria-labelledby="session-tab-prompts">
          <WarningsStrip warnings={promptsQuery.warnings} />
          {promptsQuery.error
            ? <p role="alert" className="text-sm text-destructive">{promptsQuery.error}</p>
            : promptsQuery.loading && !promptsQuery.data
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading prompts…</p>
              : promptsQuery.data && promptsQuery.data.length === 0
                ? <p role="status" className="py-5 text-sm text-muted-foreground">No prompts recorded (or the session database is unreadable).</p>
                : <ol className="grid gap-2">{promptsQuery.data?.map((prompt, index) => {
                  const eyebrow = messageEyebrow(prompt.kind, null);
                  return (
                    <li key={index} className="rounded-lg border border-border px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">[{index + 1}]</p>
                      {eyebrow && <p className={`mt-1 ${messageEyebrowClass}`}>{eyebrow}</p>}
                      <p className="mt-1 break-words text-sm leading-6">{prompt.text}</p>
                    </li>
                  );
                })}</ol>}
        </div>
      )}
      {tab === 'reads' && (
        <div role="tabpanel" id="session-panel-reads" aria-labelledby="session-tab-reads">
          <WarningsStrip warnings={readsQuery.warnings} />
          {readsQuery.error
            ? <p role="alert" className="text-sm text-destructive">{readsQuery.error}</p>
            : readsQuery.loading && !readsQuery.data
              ? <p role="status" className="py-5 text-sm text-muted-foreground">Reading file reads…</p>
              : readsQuery.data && readsQuery.data.length === 0
                ? <p role="status" className="py-5 text-sm text-muted-foreground">No file reads recorded in this window.</p>
                : <ul className="divide-y divide-border border-y border-border">{readsQuery.data?.map(stat => (
                  <li key={stat.path} className="py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="min-w-0 flex-1 break-all font-mono text-xs">{stat.path}</p>
                      <Badge variant="outline">{stat.reads}×</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {stat.agents.length > 0 && <>agents: {stat.agents.join(', ')} </>}
                      {stat.ranges.length > 0 && <>lines: {stat.ranges.join(', ')}</>}
                    </p>
                  </li>
                ))}</ul>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Snapshot for the selected window. Toggle Live for newer records.</p>
    </div>
  );
}
