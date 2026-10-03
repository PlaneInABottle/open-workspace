import { useState } from 'react';
import { Check, CircleDashed, RefreshCw } from 'lucide-react';
import type { Inspection, ServiceInventory } from '@/api';

export const NOT_YET_CHECKED_LABEL = 'Henüz kontrol edilmedi · Not yet checked';

interface ProjectStatusBlockProps {
  connected: boolean;
  inspection: Inspection | null;
  inspectionLoading: boolean;
  services: ServiceInventory | null;
  servicesLoading: boolean;
}

type RowState = 'evidenced' | 'checking' | 'unchecked';

interface StatusRow {
  id: 'connection' | 'discovery' | 'readiness';
  title: string;
  state: RowState;
  summary: string;
  detail: React.ReactNode;
}

function StatusIcon({ state }: { state: RowState }) {
  if (state === 'evidenced') return <Check aria-hidden="true" className="size-4 shrink-0 text-success" />;
  if (state === 'checking') return <RefreshCw aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />;
  return <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
}

function buildRows(props: ProjectStatusBlockProps): StatusRow[] {
  const { connected, inspection, inspectionLoading, services, servicesLoading } = props;
  const componentCount = inspection?.roots.reduce((total, root) => total + root.repositories.length, 0) ?? 0;
  const unavailableRoots = (inspection?.roots ?? []).filter(root => root.unavailable);
  const warningCount = (inspection?.roots ?? []).reduce((total, root) => total + root.warnings.length, 0);

  const discoveryState: RowState = inspection ? 'evidenced' : inspectionLoading ? 'checking' : 'unchecked';
  const discoverySummary = inspection
    ? `Checked · inventory produced (${inspection.roots.length} ${inspection.roots.length === 1 ? 'root' : 'roots'}, ${componentCount} ${componentCount === 1 ? 'component' : 'components'})`
    : inspectionLoading
      ? 'Checking…'
      : NOT_YET_CHECKED_LABEL;

  const matchedServices = services?.available ? services.services : [];
  const observations: string[] = [];
  if (servicesLoading) {
    observations.push('Service information is being read…');
  } else if (!services) {
    observations.push('Service information has not been inspected yet.');
  } else if (!services.available) {
    observations.push('PM2 service metadata is unavailable on this machine — not checked, not failed.');
  } else if (matchedServices.length === 0) {
    observations.push(`No PM2 process working directory matches this project (${services.processCount} local ${services.processCount === 1 ? 'process' : 'processes'} scanned). Process state only.`);
  } else {
    observations.push(
      `${matchedServices.length} matched PM2 ${matchedServices.length === 1 ? 'process' : 'processes'} observed (${matchedServices.map(service => `${service.name}: ${service.status}`).join(', ')}). Process state only.`,
    );
  }
  return [
    {
      id: 'connection',
      title: 'Connection',
      state: connected ? 'evidenced' : 'unchecked',
      summary: connected ? 'Connected · this browser tab' : 'Not connected',
      detail: connected
        ? <p>This browser tab holds a temporary dashboard session for project registration and observation. Agents operate through MCP.</p>
        : <p>This browser tab has no dashboard session. Connect this browser to continue.</p>,
    },
    {
      id: 'discovery',
      title: 'Metadata discovery',
      state: discoveryState,
      summary: discoverySummary,
      detail: inspection
        ? (
          <div className="grid gap-1">
            <p>Inventory produced from {inspection.roots.length} {inspection.roots.length === 1 ? 'registered root' : 'registered roots'} · {componentCount} {componentCount === 1 ? 'component' : 'components'}. Nothing was started or probed.</p>
            {unavailableRoots.length > 0 && <p>{unavailableRoots.length} {unavailableRoots.length === 1 ? 'root is' : 'roots are'} unavailable: {unavailableRoots.map(root => root.path).join(', ')}. Other roots remain available.</p>}
            {warningCount > 0 && <p>{warningCount} {warningCount === 1 ? 'metadata warning was' : 'metadata warnings were'} recorded on this inventory.</p>}
          </div>
          )
        : inspectionLoading
          ? <p>Reading registered project metadata…</p>
          : <p>No metadata check has run for this project yet. Nothing is started or probed by checking.</p>,
    },
    {
      id: 'readiness',
      title: 'Runtime readiness',
      state: 'unchecked',
      summary: NOT_YET_CHECKED_LABEL,
      detail: (
        <div className="grid gap-1">
          <p>No readiness probe has run. OpenWorkspace has no per-service healthcheck engine, so nothing here is a serving verdict.</p>
          <ul className="grid gap-1">
            {observations.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ),
    },
  ];
}

export function ProjectStatusBlock(props: ProjectStatusBlockProps) {
  const [openRow, setOpenRow] = useState<StatusRow['id'] | null>(null);
  const rows = buildRows(props);
  return (
    <section aria-labelledby="project-status-heading" className="min-w-0">
      <p className="eyebrow">PROJECT STATUS · THREE SEPARATE CHECKS</p>
      <h2 id="project-status-heading" className="text-base font-semibold">Project status</h2>
      <p className="mt-1 text-sm text-muted-foreground">Connection, discovery and readiness are checked separately. Select a row for its evidence.</p>
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {rows.map(row => {
          const open = openRow === row.id;
          return (
            <li key={row.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 py-3 text-left"
                aria-expanded={open}
                aria-controls={`project-status-detail-${row.id}`}
                onClick={() => setOpenRow(open ? null : row.id)}
              >
                <StatusIcon state={row.state} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{row.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{row.summary}</span>
                </span>
              </button>
              {open && (
                <div id={`project-status-detail-${row.id}`} role="region" aria-label={`${row.title} detail`} className="pb-4 pl-7 text-sm leading-6 text-muted-foreground">
                  {row.detail}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
