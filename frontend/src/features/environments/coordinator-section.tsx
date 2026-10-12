import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type {
  ApiClient,
  CheckpointStageStatus,
  CoordinatorCheckpoints,
  CoordinatorDrift,
  CoordinatorExplanation,
  CoordinatorReadinessEntry,
  CoordinatorScenarios,
  CoordinatorSnapshot,
  CoordinatorWorktreeEntry,
  ScenarioVerdict,
} from '@/api';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';
import { checkpointAgeLabel } from '@/features/environments/time-label';

const STAGE_EN: Record<CheckpointStageStatus, string> = {
  confirmed: 'confirmed',
  not_observed: 'not-observed',
  stale: 'stale',
};

const STALE_EN: Record<string, string> = {
  script_hash: 'script changed',
  checkout_rev: 'code revision changed',
  runtime: 'runtime changed',
  missing_basis: 'no comparison record',
};

/** M-A (#2): side-effect word (`null` ≡ missing → `unknown`). */
const SIDE_EFFECT_EN: Record<string, string> = {
  none: 'none',
  attempted: 'attempted',
  confirmed: 'confirmed',
  unknown: 'unknown',
};

function sideEffectLabel(sideEffect: string | null): string {
  if (!sideEffect) return 'unknown';
  return SIDE_EFFECT_EN[sideEffect] ?? 'unknown';
}

/** M-A (#2): locked retry text (plain text; no button/link). */
const RETRY_HINT_EN = 'before-retry: ow reconcile --check';

/** M1 boundary taxonomy: new-enum English labels + legacy dual-read
 * labels (old columns may still arrive). `blocked:<reason>` matches by
 * prefix; anything unknown falls back to `unknown` (no raw column name
 * leaks into the DOM, no blank/broken cells). */
const BOUNDARY_EN: Record<string, string> = {
  'real-read-only': 'real read-only',
  'real-state-changing': 'real state-changing',
  'network-deny': 'network deny',
  subscribed: 'subscribed',
  blocked: 'blocked',
  unverified: 'unverified',
  real: 'real',
  local: 'local',
  fake: 'fake',
  'captured-response': 'captured response',
  test: 'test',
};

function boundaryLabel(column: string): string {
  const hit = BOUNDARY_EN[column];
  if (hit !== undefined) return hit;
  if (column.startsWith('blocked:')) return BOUNDARY_EN.blocked;
  return 'unknown';
}

const VERDICT_EN: Record<Exclude<ScenarioVerdict, 'uncovered'>, string> = {
  pass: 'pass',
  stale: 'stale',
  skipped: 'skipped',
  unverified: 'unverified',
};

function staleReasonLabel(staleReason: string | null): string {
  if (!staleReason) return '';
  return STALE_EN[staleReason] ?? staleReason;
}

/**
 * Copy button: `full` is carried ONLY in the clipboard payload at click time
 * — it is not written to DOM text, title or aria (scan-test §3).
 * The full hash is not shown on hover; access is via the click-to-copy path.
 */
function CopyButton({ full, label }: { full: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  // No timer dangles on unmount (one-shot countdown; no polling).
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={copy}
      className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {copied ? '✓ copied' : 'Copy'}
    </button>
  );
}

/** Absolute time + relative age pair; an unparseable time never proves staleness. */
function witnessAgeLabel(producedAt: string, nowMs: number): { time: string; age: string; stale: boolean } {
  const atMs = Date.parse(producedAt);
  if (!Number.isFinite(atMs)) return { time: 'time unknown', age: 'freshness unknown', stale: false };
  const time = new Date(atMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ageMs = Math.max(0, nowMs - atMs);
  const stale = ageMs > 60_000;
  return { time, age: checkpointAgeLabel(producedAt, nowMs), stale };
}

function DiffModal({ drift, onClose }: { drift: CoordinatorDrift; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    // Small focus trap: Tab cycles inside the modal.
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])',
    )].filter(node => !node.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg outline-none"
        onClick={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3 id={titleId} className="text-base font-semibold">Diff: {drift.service}</h3>
        <p className="mt-1 text-xs text-muted-foreground">Read-only preview — runs nothing.</p>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Field</dt>
            <dd>{drift.field}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Expected</dt>
            <dd className="break-words">{drift.expected}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Running</dt>
            <dd className="break-words">{drift.actual}</dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function PreflightPanel({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const { preflight } = snapshot;
  return (
    <article aria-labelledby="koordinator-preflight-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-preflight-heading" className="text-sm font-semibold">Preflight</h3>
        {preflight.pass ? (
          <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> can start</Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-destructive"><span aria-hidden="true">!</span> missing ({preflight.missing.length})</Badge>
        )}
      </div>
      {preflight.missing.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing missing — all known gates are clear.</p>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setOpen(current => !current)}
          >
            {open ? 'Hide missing list' : `Show missing list (${preflight.missing.length})`}
          </button>
          {open && (
            <ul id={regionId} className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {preflight.missing.map(line => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Coordinator section: from a single aggregate snapshot P1 (reconcile summary + drift
 * lines + read-only diff modal) + P2 (preflight badge + missing
 * accordion) + P3 (checkpoint line: stage strip + stale queue +
 * plain-text next step + run selector) + P4 (provenance card:
 * expected/running table + rev strip) + P5 (scenario matrix) + witness
 * line. No action button; data arrives one-shot from the top bar's Refresh
 * (refreshToken). The run selection is a user-triggered single refetch
 * (no timer/polling).
 */
export function CoordinatorSection({ api, workspace, environment, refreshToken }: {
  api: ApiClient;
  workspace: string;
  environment: string;
  refreshToken: number;
}) {
  const [openDrift, setOpenDrift] = useState<CoordinatorDrift | null>(null);
  // Focus return is deterministic: the opening button is captured at click time (the
  // autoFocus race on modal mount disappears).
  const openerRef = useRef<HTMLButtonElement | null>(null);
  // Explicit checkpoint-run request (null = latest); reset when the environment changes.
  const [run, setRun] = useState<string | null>(null);
  // The run list from the last non-empty response: kept in cache so the selector
  // does not disappear on an empty run selection (checkpoints null) —
  // the user can return to a non-empty run with the same selector.
  const [cachedRuns, setCachedRuns] = useState<string[]>([]);
  const { data, warnings, loading, error } = useObserverFetch<CoordinatorSnapshot>(() =>
    api.coordinator(workspace, environment, run ?? undefined).then(snapshot => ({ data: snapshot, warnings: snapshot.warnings })),
  [workspace, environment, refreshToken, run]);

  function closeDrift() {
    setOpenDrift(null);
    openerRef.current?.focus();
  }

  // When the environment changes the open modal closes and the run selection returns to latest.
  useEffect(() => { setOpenDrift(null); setRun(null); setCachedRuns([]); }, [workspace, environment]);

  // The list refreshes as non-empty responses arrive; it is preserved on an empty response.
  // When there is no top-level `runs` (old server) the cache takes over.
  useEffect(() => {
    const listed = data?.runs ?? [];
    if (listed.length > 0) setCachedRuns(listed);
  }, [data]);

  return (
    <section aria-labelledby="koordinator-heading" className="border-t border-border pt-5">
      <header>
        <p className="eyebrow">COORDINATOR</p>
        <h2 id="koordinator-heading" className="text-base font-semibold">Coordinator</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {environment
            ? <>Read-only environment summary: <span className="font-medium text-foreground">{environment}</span>. Starts, stops, or fixes nothing.</>
            : 'The read-only summary appears here once an environment is selected.'}
        </p>
      </header>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="mt-3 text-sm text-destructive">Coordinator snapshot unreadable: {error}</p>}
      {loading && !data && !error && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">Loading coordinator snapshot…</p>
      )}

      {data && (
        <>
          <article aria-labelledby="koordinator-reconcile-heading" className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="koordinator-reconcile-heading" className="text-sm font-semibold">Environment map</h3>
              {data.reconcile.inSync ? (
                <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> in sync</Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-destructive"><span aria-hidden="true">!</span> drifted ({data.reconcile.drifts.length})</Badge>
              )}
            </div>
            {data.reconcile.inSync ? (
              <p className="mt-2 text-sm text-muted-foreground">No diff — expected topology matches running state.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border border-y border-border">
                {data.reconcile.drifts.map(drift => (
                  <li key={`${drift.service}:${drift.field}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <p className="min-w-0 flex-1 break-words text-sm">
                      <span className="font-medium">{drift.service}</span>
                      <span className="text-muted-foreground"> · {drift.field}: </span>
                      <span className="font-mono text-[0.8rem]">{drift.expected} → {drift.actual}</span>
                    </p>
                    <button
                      type="button"
                      className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      onClick={event => { openerRef.current = event.currentTarget; setOpenDrift(drift); }}
                    >
                      Open diff
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <PreflightPanel snapshot={data} />

          <ReadinessStrip snapshot={data} />

          <CheckpointPanel checkpoints={data.checkpoints} runs={data.runs ?? cachedRuns} run={run} onRunChange={setRun} />

          <ProvenancePanel explanation={data.explanation} readiness={data.readiness} />

          <WorktreesPanel worktrees={data.worktrees} />

          <ScenariosPanel scenarios={data.scenarios} producedAt={data.meta.producedAt} />

          <WitnessLine snapshot={data} />
        </>
      )}
      {openDrift && <DiffModal drift={openDrift} onClose={closeDrift} />}
    </section>
  );
}

/**
 * Readiness strip: compact read-only summary inside the coordinator view
 * (no panel/route/fetch of its own - data arrives with the snapshot).
 * Three fixed zones: boundary chips, last-run line, gate line. Missing
 * wire sections render the `unmeasured` placeholder, never a crash.
 * Stale evidence (old snapshot or a stale boundary) dims the strip.
 */
function ReadinessStrip({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [snapshot]);

  const { boundaryList, lastRun, readinessGate } = snapshot;
  if (boundaryList === undefined || lastRun === undefined || readinessGate === undefined || readinessGate === null) {
    return (
      <article aria-labelledby="readiness-strip-heading" className="mt-4 border-t border-border pt-4">
        <h3 id="readiness-strip-heading" className="text-sm font-semibold">Readiness strip</h3>
        <p className="mt-2 text-sm text-muted-foreground">unmeasured — no readiness data bound.</p>
      </article>
    );
  }

  const producedAtMs = Date.parse(snapshot.meta.producedAt);
  const staleSnapshot = Number.isFinite(producedAtMs) && nowMs - producedAtMs > 60_000;
  const staleEvidence = boundaryList.some(entry => entry.status === 'stale');
  const stale = staleSnapshot || staleEvidence;

  return (
    <article aria-labelledby="readiness-strip-heading" className={`mt-4 border-t border-border pt-4${stale ? ' opacity-60' : ''}`}>
      <h3 id="readiness-strip-heading" className="text-sm font-semibold">Readiness strip</h3>
      {stale && <p role="status" className="mt-1 text-xs text-muted-foreground">stale evidence</p>}
      <ul aria-label="Boundaries" className="mt-2 flex flex-wrap gap-1.5">
        {boundaryList.map(entry => (
          <li key={entry.boundary} className="flex items-center gap-1.5">
            <Badge variant="outline" className="gap-1">{boundaryLabel(entry.boundary)}</Badge>
            <span className="text-xs text-muted-foreground">{entry.status}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        {lastRun === null
          ? <span className="font-medium">Last run: no record</span>
          : <span className="font-medium">Last run: {lastRun.id}{lastRun.at ? ` · ${lastRun.at}` : ''} · {lastRun.pass ? 'pass' : 'fail'}</span>}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {readinessGate.pass
          ? <span className="font-medium text-success">Readiness gate: pass</span>
          : <span className="font-medium text-warning">Readiness gate: fail ({readinessGate.missing.length} missing)</span>}
      </p>
    </article>
  );
}

function WitnessLine({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [snapshot]);
  const { time, age, stale } = witnessAgeLabel(snapshot.meta.producedAt, nowMs);
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      coordinator snapshot · {time} · {age} · <span title="snapshot id">#{snapshot.meta.snapshotId}</span>
      {stale && <> · <span className="font-medium text-warning">may be stale — press Refresh</span></>}
    </p>
  );
}

/**
 * P3 checkpoint line: the stage flow is a horizontal `<ol>` strip (completed ✓,
 * next ▸, stale orange border + age) + first_gap "stale queue"
 * (`role=status`) + a plain-text next-step box (no action).
 */
/**
 * Run selector: a labeled native select (keyboard-friendly, triggers a single
 * refetch — no timer/polling). The list comes from the parent; it stays
 * visible even on an empty selection (no dead-end).
 */
function RunPicker({ runs, run, onRunChange }: {
  runs: string[];
  run: string | null;
  onRunChange: (run: string | null) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Run
      <select
        value={run ?? ''}
        onChange={event => onRunChange(event.currentTarget.value === '' ? null : event.currentTarget.value)}
        className="rounded-md border border-border bg-background px-1.5 py-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">latest</option>
        {runs.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function CheckpointPanel({ checkpoints, runs, run, onRunChange }: {
  checkpoints: CoordinatorCheckpoints | null;
  runs: string[];
  run: string | null;
  onRunChange: (run: string | null) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [checkpoints]);

  if (!checkpoints) {
    return (
      <article aria-labelledby="koordinator-checkpoints-heading" className="mt-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="koordinator-checkpoints-heading" className="text-sm font-semibold">Checkpoint line</h3>
          <RunPicker runs={runs} run={run} onRunChange={onRunChange} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">No checkpoints — no runner record found.</p>
      </article>
    );
  }

  const currentStage = checkpoints.firstGap?.stage ?? checkpoints.lastVerified?.stage ?? null;
  const staleStages = checkpoints.stages.filter(stage => stage.status === 'stale');

  // M-A: flag lines (envelope-ordered, plain-text nodes) + attempt tree
  // (scenario → attempt; an unattributed envelope stays outside the tree). The attempted-unconfirmed
  // rule mirrors the CLI `isAttemptedUnconfirmed`.
  const flagText = (stage: CoordinatorCheckpoints['stages'][number]): string => {
    const counts: string[] = [];
    if (stage.sideEffectAttempted !== null) counts.push(`attempted: ${stage.sideEffectAttempted}`);
    if (stage.sideEffectConfirmed !== null) counts.push(`confirmed: ${stage.sideEffectConfirmed}`);
    return counts.length > 0
      ? `side-effect: ${stage.stage} (${sideEffectLabel(stage.sideEffect)}, ${counts.join(', ')})`
      : `side-effect: ${stage.stage} (${sideEffectLabel(stage.sideEffect)})`;
  };
  const unconfirmedAt = (index: number): boolean => {
    const stage = checkpoints.stages[index];
    if (stage.sideEffect !== 'attempted') return false;
    return !checkpoints.stages.slice(index + 1).some(later => later.stage === stage.stage && later.sideEffect === 'confirmed');
  };
  const leafText = (index: number): string => {
    const stage = checkpoints.stages[index];
    const words = [STAGE_EN[stage.status]];
    if (unconfirmedAt(index)) words.push('unconfirmed');
    return `${stage.stage} (${words.join(', ')})`;
  };
  const attemptTree = new Map<string, { attempts: Map<number, number[]>; flat: number[] }>();
  checkpoints.stages.forEach((stage, index) => {
    if (stage.scenario === null) return;
    let group = attemptTree.get(stage.scenario);
    if (!group) {
      group = { attempts: new Map(), flat: [] };
      attemptTree.set(stage.scenario, group);
    }
    if (stage.attempt === null) group.flat.push(index);
    else {
      const bucket = group.attempts.get(stage.attempt) ?? [];
      bucket.push(index);
      group.attempts.set(stage.attempt, bucket);
    }
  });

  return (
    <article aria-labelledby="koordinator-checkpoints-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-checkpoints-heading" className="text-sm font-semibold">Checkpoint line</h3>
        <div className="flex flex-wrap items-center gap-2">
          <RunPicker runs={runs} run={run} onRunChange={onRunChange} />
          <p className="text-xs text-muted-foreground">
            run: <span className="font-medium text-foreground">{checkpoints.run}</span>
            {' · '}{checkpoints.summary.confirmed} confirmed, {checkpoints.summary.stale} stale, {checkpoints.summary.notObserved} not-observed
          </p>
        </div>
      </div>

      <ol aria-label="Checkpoint stages" className="mt-2 flex flex-wrap gap-2">
        {checkpoints.stages.map(stage => {
          const isCurrent = stage.stage === currentStage;
          const marker = stage.status === 'confirmed' ? '✓' : stage.status === 'stale' ? '!' : isCurrent ? '▸' : '○';
          return (
            <li
              key={stage.stage}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${stage.status === 'stale' ? 'border-warning bg-warning/10' : 'border-border'}`}
            >
              <span aria-hidden="true" className={stage.status === 'stale' ? 'font-bold text-warning' : stage.status === 'confirmed' ? 'text-success' : ''}>{marker}</span>
              <span className="font-medium">{stage.stage}</span>
              {stage.status === 'confirmed' ? (
                <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> confirmed</Badge>
              ) : stage.status === 'stale' ? (
                <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">!</span> stale</Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-muted-foreground"><span aria-hidden="true">○</span> not-observed</Badge>
              )}
              <span className="text-xs text-muted-foreground">{checkpointAgeLabel(stage.at, nowMs)}</span>
            </li>
          );
        })}
      </ol>

      {checkpoints.firstGap && (
        <div role="status" className="mt-3 rounded-md border border-border p-3">
          <p className="text-sm">
            First gap: <span className="font-medium">{checkpoints.firstGap.stage}</span>
            {' '}({STAGE_EN[checkpoints.firstGap.status]}{checkpoints.firstGap.staleReason ? ` — ${staleReasonLabel(checkpoints.firstGap.staleReason)}` : ''})
            {' · '}{checkpointAgeLabel(checkpoints.firstGap.at, nowMs)}
          </p>
          {staleStages.length > 0 && (
            <div className="mt-2">
              <h4 className="text-xs font-semibold text-warning">Stale queue</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {staleStages.map(stage => (
                  <li key={stage.stage}>
                    {stage.stage} — {staleReasonLabel(stage.staleReason)} · {checkpointAgeLabel(stage.at, nowMs)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ul aria-label="Side effects" className="mt-3 space-y-1 text-sm text-muted-foreground">
        {checkpoints.stages.map((stage, index) => (
          <li key={`${stage.stage}-${index}`}><span>{flagText(stage)}</span></li>
        ))}
      </ul>

      {checkpoints.retryHint && (
        <div className="mt-3 rounded-md border border-border p-3">
          <p className="text-sm">{RETRY_HINT_EN}</p>
          <p className="mt-1 text-xs text-muted-foreground">This is a suggestion — it runs nothing. Applying it is up to the assistant.</p>
        </div>
      )}

      {attemptTree.size > 0 && (
        <ul aria-label="Attempt tree" className="mt-3 space-y-2 text-sm">
          {[...attemptTree.entries()].map(([scenario, group]) => (
            <li key={scenario}>
              <span className="font-medium">{`scenario: ${scenario}`}</span>
              <ul className="ml-4 mt-1 space-y-1 text-muted-foreground">
                {[...group.attempts.keys()].sort((a, b) => a - b).flatMap(attempt =>
                  (group.attempts.get(attempt) ?? []).map(index => (
                    <li key={`${attempt}-${index}`}><span>{`attempt ${attempt}: ${leafText(index)}`}</span></li>
                  )),
                )}
                {group.flat.map(index => (
                  <li key={`flat-${index}`}><span>{leafText(index)}</span></li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {checkpoints.safeNextAction && (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">Suggested next step</p>
          <p className="mt-1 text-sm">{checkpoints.safeNextAction}</p>
          <p className="mt-1 text-xs text-muted-foreground">This is a suggestion — it runs nothing. Applying it is up to the assistant.</p>
        </div>
      )}
    </article>
  );
}

function expectedCellText(entry: CoordinatorExplanation['entries'][number]): string {
  if (!entry.expected) return 'not in definition';
  const parts = [
    entry.expected.cmd,
    entry.expected.dir,
    entry.expected.port === null ? null : `port ${entry.expected.port}`,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/**
 * Worktree chip text: `<rootBase>@<revShort7>`, or `<rootBase>` when the
 * rev is unknown. Only the `^[^/\\@]{1,64}(@[0-9a-fA-F]{7})?$` shape
 * renders (non-matching input gets no chip — full path/rev never reaches
 * the DOM).
 */
function worktreeChipText(entry: CoordinatorExplanation['entries'][number]): string | null {
  const dir = entry.expected?.dir;
  if (!dir) return null;
  const bare = dir;
  const full = entry.revShort ? `${bare}@${entry.revShort}` : bare;
  if (/^[^/\\@]{1,64}(@[0-9a-fA-F]{7})?$/.test(full)) return full;
  return /^[^/\\@]{1,64}$/.test(bare) ? bare : null;
}

/**
 * P4 provenance card: expected/running `<table>` + rev strip
 * (a dot-time line: selected highlighted, old dim, label short-hash + age)
 * + diff lines. The rev line is never a bare hash; the full hash is only in the
 * copy button's clipboard payload.
 *
 * Chip + `wt:<ad>` filter renders ONLY when discriminating info exists
 * (the `worktree` field on readiness — i.e. >1 root); single-root flows
 * render byte-identical to today.
 */
function ProvenancePanel({ explanation, readiness }: { explanation: CoordinatorExplanation | null; readiness: CoordinatorReadinessEntry[] }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [worktreeFilter, setWorktreeFilter] = useState('');
  useEffect(() => {
    setNowMs(Date.now());
    setSelected(null);
    setWorktreeFilter('');
  }, [explanation]);

  if (!explanation) {
    return (
      <article aria-labelledby="koordinator-provenance-heading" className="mt-4 border-t border-border pt-4">
        <h3 id="koordinator-provenance-heading" className="text-sm font-semibold">Provenance card</h3>
        <p className="mt-2 text-sm text-muted-foreground">No provenance record — no spawn record found.</p>
      </article>
    );
  }

  const showWorktree = readiness.some(entry => entry.worktree !== undefined);
  const token = worktreeFilter.startsWith('wt:') ? worktreeFilter.slice('wt:'.length) : worktreeFilter;
  const visibleEntries = !showWorktree || token.trim() === ''
    ? explanation.entries
    : explanation.entries.filter(entry => (entry.expected?.dir ?? '').toLowerCase().includes(token.trim().toLowerCase()));

  const activeFull = selected ?? explanation.revisions.find(revision => revision.current)?.full ?? null;

  return (
    <article aria-labelledby="koordinator-provenance-heading" className="mt-4 border-t border-border pt-4">
      <h3 id="koordinator-provenance-heading" className="text-sm font-semibold">Provenance card</h3>
      {showWorktree && (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          Worktree filter
          <input
            type="text"
            value={worktreeFilter}
            onChange={event => setWorktreeFilter(event.currentTarget.value)}
            placeholder="wt:<name>"
            aria-label="Worktree filter (wt:<name>)"
            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
      )}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Service</th>
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Expected</th>
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Running</th>
              <th scope="col" className="py-1 text-xs font-medium text-muted-foreground">Rev</th>
            </tr>
          </thead>
          <tbody>
            {visibleEntries.map(entry => (
              <tr
                key={entry.service}
                // data-selected is rendered only when selected (the "false"
                // string does not add DOM noise; the selection is pure-view state).
                {...(entry.revFull !== null && entry.revFull === activeFull ? { 'data-selected': true } : {})}
                className={`border-b border-border last:border-0 ${entry.revFull !== null && entry.revFull === activeFull ? 'bg-muted/60' : ''}`}
              >
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  {entry.service}
                  {showWorktree && worktreeChipText(entry) && (
                    <span className="ml-1.5 inline-block">
                      <Badge variant="outline" className="gap-1 font-mono text-[0.7rem]">{worktreeChipText(entry)}</Badge>
                    </span>
                  )}
                </th>
                <td className="py-2 pr-3">{expectedCellText(entry)}</td>
                <td className="py-2 pr-3">
                  {entry.running ? <>{entry.running.status}: {entry.running.detail}</> : 'unmeasured'}
                </td>
                <td className="py-2">
                  {entry.revShort ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <code translate="no" className="font-mono text-[0.8rem]">{entry.revShort}</code>
                      {entry.revDirty && <span className="text-xs text-muted-foreground">+dirty</span>}
                      {entry.revRecorded ? (
                        <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> recorded</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">?</span> unverified</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {entry.revAt ? `saved ${checkpointAgeLabel(entry.revAt, nowMs)}` : 'no record time'}
                      </span>
                      {entry.revFull && <CopyButton full={entry.revFull} label={`copy ${entry.revShort} rev`} />}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">?</span> unverified</Badge>
                      <span className="text-xs text-muted-foreground">no rev record</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleEntries.filter(entry => entry.diffs.length > 0 || entry.note.length > 0).map(entry => (
        <div key={entry.service} className="mt-2 text-sm">
          <p className="font-medium">{entry.service}</p>
          {entry.diffs.length > 0 && (
            <ul aria-label={`${entry.service} diffs`} className="list-disc pl-5 text-muted-foreground">
              {entry.diffs.map(diff => <li key={diff}>{diff}</li>)}
            </ul>
          )}
          {entry.artifacts.length > 0 && (
            <ul aria-label={`${entry.service} builds`} className="mt-1 flex flex-wrap gap-1.5 text-xs">
              {entry.artifacts.map(artifact => (
                <li key={artifact.base} className="rounded border border-border px-1.5 py-0.5">
                  <code translate="no" data-artifact-digest className="font-mono">{`${artifact.base}@${artifact.digest}`}</code>
                </li>
              ))}
              {entry.artifactRest > 0 && <li className="px-1 py-0.5 text-muted-foreground">+{entry.artifactRest} more</li>}
            </ul>
          )}
          <p className="text-muted-foreground">reason: {entry.note}</p>
        </div>
      ))}

      {explanation.revisions.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground">Rev strip</h4>
          <ol aria-label="Rev strip" className="mt-1 flex flex-wrap items-center gap-2">
            {explanation.revisions.map(revision => {
              const isActive = revision.full === activeFull;
              return (
                <li key={revision.full} className="flex items-center gap-2">
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${isActive ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  <button
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    aria-pressed={isActive}
                    onClick={() => setSelected(revision.full)}
                    className={`rounded border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${isActive ? 'border-primary font-semibold' : 'border-border'} ${revision.recorded ? '' : 'opacity-60'}`}
                  >
                    <span translate="no" className="font-mono">{revision.short}</span>
                    {' · '}
                    <span className="text-muted-foreground">{checkpointAgeLabel(revision.at, nowMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </article>
  );
}

const WORKTREE_LOCK_EN: Record<CoordinatorWorktreeEntry['lock'], string> = {
  live: 'live',
  stale: 'stale',
  absent: 'none',
  corrupt: 'corrupt',
  unknown: 'unverified',
};

const WORKTREE_STATE_EN: Record<Exclude<CoordinatorWorktreeEntry['state'], 'ok'>, string> = {
  missing: 'no record',
  corrupt: 'corrupt record',
  'bad-version': 'version mismatch',
};

/**
 * Ownership ledger: read-only list per registered root (lock +
 * revShort chip + branch + recorded services). No action buttons, no
 * polling; fed from the same snapshot (refreshes with `data` on refetch).
 * Never renders when `worktrees` is missing/empty (single-root flows stay
 * byte-identical).
 */
function WorktreesPanel({ worktrees }: { worktrees: CoordinatorWorktreeEntry[] | undefined }) {
  if (!worktrees || worktrees.length === 0) return null;
  return (
    <article aria-labelledby="koordinator-worktrees-heading" className="mt-4 border-t border-border pt-4">
      <h3 id="koordinator-worktrees-heading" className="text-sm font-semibold">Worktree ownership</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        Read-only root list — which worktree holds what. Starts, stops, or fixes nothing.
      </p>
      <ul className="mt-2 divide-y divide-border border-y border-border">
        {worktrees.map((entry, index) => (
          <li key={`${entry.rootBase}-${index}`} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{entry.rootBase}</p>
              {entry.revShort && (
                <Badge variant="outline" className="gap-1 font-mono text-[0.7rem]">
                  <span translate="no">@{entry.revShort}</span>
                </Badge>
              )}
              <Badge variant="outline" className="gap-1">{WORKTREE_LOCK_EN[entry.lock]}</Badge>
            </div>
            <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
              {entry.branch ? `branch: ${entry.branch} · ` : ''}
              {entry.state !== 'ok' ? `${WORKTREE_STATE_EN[entry.state]} · ` : ''}
              {entry.liveServices.length > 0 ? `recorded: ${entry.liveServices.join(', ')}` : 'no recorded services'}
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ScenarioCell({ verdict }: { verdict: ScenarioVerdict }) {
  if (verdict === 'uncovered') {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">out of scope</span>
      </span>
    );
  }
  return (
    <Badge variant="outline" className={`gap-1 ${verdict === 'pass' ? 'text-success' : verdict === 'stale' ? 'text-warning' : verdict === 'unverified' ? 'text-warning' : 'text-muted-foreground'}`}>
      <span aria-hidden="true">{verdict === 'pass' ? '✓' : verdict === 'stale' ? '!' : verdict === 'unverified' ? '?' : '○'}</span>
      {VERDICT_EN[verdict]}
    </Badge>
  );
}

/**
 * P5 scenario matrix: a real `<table>` (row = scenario, column = boundary),
 * cell = badge text. The verdict comes from checkpoint freshness in the
 * selected run ("skipped" when there is no record); no execution — the matrix shows,
 * it does not run. Order: matrix → warning strip → witness line (focus order).
 */
function ScenariosPanel({ scenarios, producedAt }: { scenarios: CoordinatorScenarios | null; producedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [scenarios, producedAt]);

  if (!scenarios) {
    return (
      <article aria-labelledby="koordinator-scenarios-heading" className="mt-4 border-t border-border pt-4">
        <h3 id="koordinator-scenarios-heading" className="text-sm font-semibold">Scenario matrix</h3>
        <p className="mt-2 text-sm text-muted-foreground">No scenario file attached.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Have your assistant attach the scenario file — <a href="#setup" className="font-medium text-primary underline-offset-4 hover:underline">Connect your AI →</a>
        </p>
      </article>
    );
  }

  const atMs = Date.parse(producedAt);
  const staleSnapshot = Number.isFinite(atMs) && nowMs - atMs > 60_000;
  const snapshotTime = Number.isFinite(atMs)
    ? new Date(atMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'time unknown';

  // M9 source-badge column (additive): per-row overlay provenance from
  // `boundarySources`. Absent on old wire → no column (strip untouched,
  // old snapshots render byte-identical).
  const showSource = scenarios.boundarySources !== undefined;
  const sourceOf = (rowName: string): string => {
    const hit = scenarios.boundarySources?.find(entry => entry.scenario === rowName);
    return hit?.source ?? 'base';
  };

  return (
    <article aria-labelledby="koordinator-scenarios-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-scenarios-heading" className="text-sm font-semibold">Scenario matrix</h3>
        <p className="text-xs text-muted-foreground">
          file: <span className="font-medium text-foreground">{scenarios.file}</span>
          {' · '}{scenarios.rows.length} scenarios, {scenarios.columns.length} boundaries
        </p>
      </div>
      {scenarios.overlayApplied === true && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          overlay active: {scenarios.overlayFile ?? 'boundaries.local.yaml'} — boundary cells marked below come from the local overlay
        </p>
      )}
      {scenarios.overlayError != null && (
        <p role="alert" className="mt-2 text-sm text-destructive">Overlay ignored: {scenarios.overlayError}</p>
      )}
      {staleSnapshot && (
        <div role="status" className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-warning">may be stale — refresh?</span>
          {' · '}{snapshotTime} · {checkpointAgeLabel(producedAt, nowMs)}
        </div>
      )}

      {scenarios.error !== null ? (
        <p role="alert" className="mt-2 text-sm text-destructive">Scenario file unreadable: {scenarios.error}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-xs text-muted-foreground">
              Scenario matrix — {scenarios.file} · rows are scenarios, columns are boundaries; cell verdicts come from the selected run record, nothing runs.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Scenario</th>
                {scenarios.columns.map(column => (
                  <th key={column} scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">
                    {boundaryLabel(column)}
                  </th>
                ))}
                {showSource && (
                  <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Source</th>
                )}
              </tr>
            </thead>
            <tbody>
              {scenarios.rows.map(row => (
                <tr key={row.name} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="break-words py-2 pr-3 text-left font-medium">
                    {row.name}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {row.services.map(service => (
                        <span key={service} className="mr-1.5">
                          {service}
                          {row.unverifiedServices.includes(service) && (
                            <span className="ml-1 font-medium text-warning">? unverified</span>
                          )}
                        </span>
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {row.probes.length} probe ({row.probes.map(probe => probe.id).join(', ')})
                      {' · '}records: {row.checkpoints.length > 0 ? row.checkpoints.join(', ') : 'none'}
                    </span>
                  </th>
                  {scenarios.columns.map(column => (
                    <td key={column} className="py-2 pr-3">
                      <ScenarioCell verdict={row.cells[column] ?? 'skipped'} />
                    </td>
                  ))}
                  {showSource && (
                    <td className="py-2 pr-3">
                      <Badge variant="outline" className="gap-1">{sourceOf(row.name)}</Badge>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <WarningsStrip warnings={scenarios.warnings} />
    </article>
  );
}
