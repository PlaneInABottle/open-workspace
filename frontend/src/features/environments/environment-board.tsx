import { Badge } from '@/components/ui/badge';
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentServiceTopology, ServiceStatusEntry } from '@/api';
import { checkpointAgeLabel } from '@/features/environments/time-label';

/** Readiness kind in plain words; process-alive never reports ready (ceiling: starting). */
export function readinessLabel(service: EnvironmentServiceTopology): string {
  return service.readiness.kind === 'http-200'
    ? `http-200 → ${service.readiness.path}`
    : 'process-alive (reports at most starting)';
}

/** Port plus dependency chain as one text line; never renders paths. */
export function serviceChainLabel(service: EnvironmentServiceTopology): string {
  const port = typeof service.port === 'number' ? `port ${service.port}` : 'no port';
  const deps = service.dependsOn.length === 0 ? 'no dependencies' : `depends on ${service.dependsOn.join(', ')}`;
  return `${port} · ${deps}`;
}

/**
 * Last up/down receipt summary. The backend persists no separate last-up /
 * last-down timestamp, so the honest receipt is the owned entry's last
 * readiness poll (plus the status detail line rendered next to it).
 */
export function lastPollLabel(entry: ServiceStatusEntry): string | null {
  const poll = entry.owned?.lastPoll;
  if (!poll) return null;
  const http = poll.httpStatus === null ? '' : ` · HTTP ${poll.httpStatus}`;
  return `last poll ${poll.status} · ${poll.attempts} ${poll.attempts === 1 ? 'attempt' : 'attempts'}${http} · ${checkpointAgeLabel(poll.checkedAt)}`;
}

function ServiceRow({ service, entry }: {
  service: EnvironmentServiceTopology | undefined;
  entry: ServiceStatusEntry | undefined;
}) {
  const name = entry?.name ?? service?.name ?? service?.id ?? entry?.serviceId ?? 'unknown service';
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {service && service.dependsOn.length > 0 ? `depends on: ${service.dependsOn.join(', ')}` : 'depends on: nothing'}
          </p>
        </div>
        {entry
          ? <Badge variant="outline">{entry.status}</Badge>
          : <span className="text-xs text-muted-foreground">status unavailable</span>}
      </div>
      {service && (
        <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{serviceChainLabel(service)} · {readinessLabel(service)}</p>
      )}
      {entry && (
        <>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{entry.detail}</p>
          {lastPollLabel(entry) && (
            <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{lastPollLabel(entry)}</p>
          )}
        </>
      )}
    </li>
  );
}

function EnvironmentBlock({ record, status }: {
  record: EnvironmentRecord;
  status: EnvironmentStatus | undefined;
}) {
  const byId = new Map((status?.services ?? []).map(entry => [entry.serviceId, entry]));
  const orderedIds = status ? status.order : record.services.map(service => service.id);
  const live = orderedIds.filter(id => byId.get(id)?.status !== 'stale');
  const stale = (status?.services ?? []).filter(entry => entry.status === 'stale');
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{record.name}</p>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{status?.state ?? record.state}</Badge>
          <span className="text-xs text-muted-foreground">updated {checkpointAgeLabel(record.updatedAt)}</span>
        </span>
      </div>
      {live.length > 0 ? (
        <ul className="mt-1 divide-y divide-border">
          {live.map(id => (
            <ServiceRow
              key={id}
              service={record.services.find(service => service.id === id)}
              entry={byId.get(id)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">No live services in this environment.</p>
      )}
      {stale.length > 0 && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2">
          <p className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">Stale entries</p>
          <ul className="mt-1 divide-y divide-border">
            {stale.map(entry => (
              <li key={entry.serviceId} className="py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">{entry.name}</p>
                  <Badge variant="outline">stale</Badge>
                </div>
                <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{entry.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function EnvironmentsSection({ environments, statuses, loading, error }: {
  environments: EnvironmentRecord[];
  statuses: Record<string, EnvironmentStatus>;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section aria-labelledby="environments-heading" className="border-t border-border pt-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">LOCAL ENVIRONMENTS</p>
          <h2 id="environments-heading" className="text-base font-semibold">Environments</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Read-only service topology with live status. Nothing here starts, stops, or edits anything.
          </p>
        </div>
      </header>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">Environments could not be read: {error}</p>
      )}
      {loading && environments.length === 0 && !error && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">Reading environment status…</p>
      )}
      {environments.length > 0 && (
        <ul className="mt-2 divide-y divide-border border-y border-border">
          {environments.map(record => (
            <EnvironmentBlock key={record.id} record={record} status={statuses[record.name]} />
          ))}
        </ul>
      )}
      {environments.length === 0 && !loading && !error && (
        <p className="mt-3 text-sm text-muted-foreground">No environments have been recorded for this project.</p>
      )}
    </section>
  );
}
