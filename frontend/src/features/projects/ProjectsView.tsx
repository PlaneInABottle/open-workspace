import { useState } from 'react';
import { ArrowRight, Check, CircleDashed, FolderKanban, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ProjectRequestForm } from '@/features/projects/ProjectRequestForm';
import { ProjectStatusBlock } from '@/features/projects/ProjectStatusBlock';
import { projectRootLabel } from '@/features/projects/root-label';
import { RecordsView } from '@/features/records/RecordsView';
import type { ActivityEntry, Capability, Inspection, Learnings, Lease, ProjectRootPickerResult, RunListEntry, ServiceInventory, Workspace, Workstream } from '@/api';
import type { WorkbenchState } from '@/use-workbench';
import type { ProjectRequest } from '@/validation';

interface OverviewViewProps {
  state: WorkbenchState;
  onProjectRequest: (value: ProjectRequest) => Promise<{ ok: boolean }>;
  onPickRoots: (signal: AbortSignal) => Promise<ProjectRootPickerResult>;
  onSelectProject: (id: string) => void;
  onRetryInspection: (id: string) => void;
  onInspectServices: (id: string) => void;
  onGoToAi: () => void;
  onLoadRecords: (id: string) => void;
}

export function OverviewView({ state, onProjectRequest, onPickRoots, onSelectProject, onRetryInspection, onInspectServices, onGoToAi, onLoadRecords }: OverviewViewProps) {
  const [creating, setCreating] = useState(false);
  const selectProject = (id: string) => {
    setCreating(false);
    onSelectProject(id);
  };
  const selected = state.workspaces.find(workspace => workspace.id === state.selectedId);
  const title = selected?.name || 'Projects';
  const description = selected
    ? 'Registered metadata inventory · no application has been started or health-checked.'
    : state.workspaces.length
      ? 'Choose a project to view its registered repository groups.'
      : 'Create a named project from the repository folders you choose. Bounded metadata is read immediately.';

  return (
    <div className="space-y-8">
      <header className="border-b border-border pb-5">
        <div className="min-w-0">
          <p className="eyebrow">{selected ? 'SELECTED PROJECT' : state.workspaces.length ? 'WORKSPACE' : 'FIRST PROJECT'}</p>
          <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </header>

      {selected ? (
        <ProjectInventory
          connected={state.phase === 'connected'}
          inspection={state.inspection}
          loading={state.inspectionLoading}
          error={state.inspectionError}
          services={state.services}
          servicesLoading={state.servicesLoading}
          servicesError={state.servicesError}
          workstreams={state.workstreams}
          workstreamsLoading={state.workstreamsLoading}
          workstreamsError={state.workstreamsError}
          leases={state.leases}
          onRetry={() => onRetryInspection(selected.id)}
          onInspectServices={() => onInspectServices(selected.id)}
          onGoToAi={onGoToAi}
          activity={state.activity}
          learnings={state.learnings}
          runs={state.runs}
          recordsLoading={state.recordsLoading}
          recordsError={state.recordsError}
          recordsUpdatedAt={state.recordsUpdatedAt}
          onLoadRecords={onLoadRecords}
        />
      ) : state.workspaces.length > 0 ? (
        <section aria-labelledby="project-selection-heading" className="max-w-4xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="project-selection-heading" className="text-base font-semibold">Choose a project</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Select a project to review its registered repository folders.</p>
            </div>
            <Button type="button" onClick={() => setCreating(true)} disabled={creating}>
              <Plus aria-hidden="true" data-icon="inline-start" />Create new project
            </Button>
          </div>
          <div className="mt-4 divide-y divide-border border-y border-border">
            {state.workspaces.map(workspace => <ProjectChoice key={workspace.id} workspace={workspace} onSelect={selectProject} />)}
          </div>
        </section>
      ) : (
        <section className="max-w-4xl" aria-labelledby="first-project-heading">
          <div className="mb-5 flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
              <FolderKanban aria-hidden="true" className="size-[18px]" />
            </span>
            <div>
              <h2 id="first-project-heading" className="text-lg font-semibold tracking-tight">Start with a project</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Group only the repository folders you choose. Their locations do not need to share a parent.</p>
            </div>
          </div>
          {!creating && <Button type="button" onClick={() => setCreating(true)}><Plus aria-hidden="true" data-icon="inline-start" />Create new project</Button>}
        </section>
      )}

      {creating && (
        <section aria-labelledby="create-project-heading" className="max-w-4xl border-t border-border pt-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">NEW PROJECT</p>
              <h2 id="create-project-heading" className="text-base font-semibold">Name the project and choose its repositories</h2>
            </div>
          </div>
          <ProjectRequestForm
            onSubmit={async value => {
              const result = await onProjectRequest(value);
              if (result.ok) setCreating(false);
              return result.ok;
            }}
            onPickRoots={onPickRoots}
            onCancel={() => setCreating(false)}
          />
        </section>
      )}

      {state.workspaces.length === 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Prefer to start from your assistant?</span>
          <a className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" href="#setup">
            Use your AI instead <ArrowRight aria-hidden="true" className="size-3.5" />
          </a>
        </p>
      )}

      {state.capabilities.length > 0 && <CapabilityList capabilities={state.capabilities} />}
    </div>
  );
}

function ProjectChoice({ workspace, onSelect }: { workspace: Workspace; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="project-choice" onClick={() => onSelect(workspace.id)}>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{workspace.name}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{workspace.roots.length} {workspace.roots.length === 1 ? 'repository folder' : 'repository folders'}</span>
        <span className="mt-1 block" title={workspace.roots.join('\n')}>
          {workspace.roots.slice(0, 2).map(root => <span key={root} className="block truncate font-mono text-[0.7rem] leading-5 text-muted-foreground">…/{projectRootLabel(root)}</span>)}
          {workspace.roots.length > 2 && <span className="block text-[0.7rem] text-muted-foreground">+{workspace.roots.length - 2} more folders</span>}
        </span>
      </span>
      <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function StateText({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1.5">
      <dt className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function RepositorySource({ repository }: { repository: Inspection['roots'][number]['repositories'][number] }) {
  const sources = [
    ...repository.manifests,
    ...repository.composeFiles,
    ...repository.instructions.map(file => `Guidance: ${file}`),
    ...(repository.git ? ['Git repository'] : []),
  ];
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{repository.name}</p>
      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{sources.length ? sources.join(' · ') : 'No manifest detected'}</p>
    </div>
  );
}

function ProjectInventory({ connected, inspection, loading, error, services, servicesLoading, servicesError, workstreams, workstreamsLoading, workstreamsError, leases, activity, learnings, runs, recordsLoading, recordsError, recordsUpdatedAt, onRetry, onInspectServices, onGoToAi, onLoadRecords }: {
  connected: boolean;
  inspection: Inspection | null;
  loading: boolean;
  error: string | null;
  services: ServiceInventory | null;
  servicesLoading: boolean;
  servicesError: string | null;
  workstreams: Workstream[];
  workstreamsLoading: boolean;
  workstreamsError: string | null;
  leases: Lease[];
  activity: ActivityEntry[];
  learnings: Learnings;
  runs: RunListEntry[];
  recordsLoading: boolean;
  recordsError: string | null;
  recordsUpdatedAt: string | null;
  onRetry: () => void;
  onInspectServices: () => void;
  onGoToAi: () => void;
  onLoadRecords: (id: string) => void;
}) {
  const [tab, setTab] = useState<'project' | 'records'>('project');
  const componentCount = inspection?.roots.reduce((total, root) => total + root.repositories.length, 0) || 0;
  const unavailableCount = inspection?.roots.filter(root => root.unavailable).length || 0;
  if (!inspection && loading) return <p role="status" className="border-y border-border py-5 text-sm text-muted-foreground">Reading registered project metadata…</p>;
  if (!inspection) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-4 border-y border-destructive/40 py-5">
        <p className="text-sm text-destructive">{error || 'Select a registered project to inspect its metadata.'}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry inspection</Button>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">Updating registered metadata; showing the last confirmed inventory.</p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 border-y border-destructive/40 py-3">
          <p className="text-sm text-destructive">Could not refresh this inventory: {error} The last confirmed inventory is still shown.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry inspection</Button>
        </div>
      )}
      <div role="tablist" aria-label="Project sections" className="flex gap-1 border-b border-border">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'project'}
          aria-controls="project-panel"
          id="project-tab"
          className={`min-h-9 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${tab === 'project' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('project')}
        >
          Project
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'records'}
          aria-controls="records-panel"
          id="records-tab"
          className={`min-h-9 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${tab === 'records' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('records')}
        >
          Kayıtlar
        </button>
      </div>
      {tab === 'records' ? (
        <div role="tabpanel" id="records-panel" aria-labelledby="records-tab">
          <RecordsView
            workspaceId={inspection.workspace.id}
            activity={activity}
            learnings={learnings}
            runs={runs}
            loading={recordsLoading}
            error={recordsError}
            updatedAt={recordsUpdatedAt}
            onReload={onLoadRecords}
          />
        </div>
      ) : (
      <div role="tabpanel" id="project-panel" aria-labelledby="project-tab" className="space-y-7">
      <ProjectStatusBlock
        connected={connected}
        inspection={inspection}
        inspectionLoading={loading}
        services={services}
        servicesLoading={servicesLoading}
      />
      <section aria-labelledby="project-inventory-heading" className="min-w-0">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <p className="eyebrow">REGISTERED METADATA</p>
            <h2 id="project-inventory-heading" className="text-base font-semibold">Project inventory</h2>
            <p className="mt-1 text-sm text-muted-foreground">{inspection.roots.length} {inspection.roots.length === 1 ? 'root' : 'roots'} · {componentCount} {componentCount === 1 ? 'component' : 'components'} · no application was started or health-checked.</p>
          </div>
          <Badge variant="outline">{unavailableCount ? `${unavailableCount} roots unavailable` : 'Metadata only'}</Badge>
        </header>
        <div className="divide-y divide-border">
          {inspection.roots.map((root, rootIndex) => (
            <RootInventory key={root.path} root={root} index={rootIndex} />
          ))}
        </div>
      </section>
      <ServicesPanel
        services={services}
        loading={servicesLoading}
        error={servicesError}
        onInspectServices={onInspectServices}
      />
      {inspection && (
        <WorkstreamsSection
          workstreams={workstreams}
          leases={leases}
          loading={workstreamsLoading}
          error={workstreamsError}
        />
      )}
      <section className="next-step" aria-labelledby="project-next-step-heading">
        <div className="min-w-0">
          <p className="eyebrow">NEXT STEP</p>
          <h2 id="project-next-step-heading" className="text-base font-semibold">Connect your AI to prepare this project</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Technical setup has not been performed. Your assistant can explain and propose next steps; nothing starts automatically.</p>
        </div>
        <Button type="button" onClick={onGoToAi} className="shrink-0">Connect your AI <ArrowRight aria-hidden="true" data-icon="inline-end" /></Button>
      </section>
      </div>
      )}
    </div>
  );
}

function rootDisplayName(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

function RootInventory({ root, index }: { root: Inspection['roots'][number]; index: number }) {
  const headingId = `root-inventory-heading-${index}`;
  return (
    <section aria-labelledby={`${headingId} ${headingId}-path`} className="min-w-0 py-5 first:pt-4 last:pb-0">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold">{rootDisplayName(root.path)}</h3>
          <p id={`${headingId}-path`} className="mt-1 whitespace-pre-wrap break-all font-mono text-xs leading-5 text-muted-foreground">{root.path}</p>
        </div>
        <Badge variant="outline">{root.unavailable ? 'Unavailable' : 'Registered root'}</Badge>
      </header>
      {root.unavailable ? (
        <p role="alert" className="mt-3 border-l-2 border-destructive px-3 py-2 text-sm text-destructive">{root.error || 'This registered root is unavailable. Other project roots remain available.'}</p>
      ) : (
        <>
          {root.warnings.length > 0 && (
            <div role="status" className="mt-3 border-l-2 border-warning bg-warning-background px-4 py-3 text-sm text-warning">
              <h4 className="font-semibold">Some metadata could not be read in this root</h4>
              <ul className="mt-2 grid gap-1 text-xs leading-5">{root.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
            </div>
          )}
          {root.repositories.length === 0 ? (
            <p className="border-b border-border py-4 text-sm text-muted-foreground">No supported manifests or Git repositories were found in this root or its immediate subdirectories.</p>
          ) : (
            <>
              <p id={`${headingId}-scroll-hint`} className="sr-only md:not-sr-only md:py-2 md:text-xs md:text-muted-foreground">This comparison table scrolls horizontally at narrow widths.</p>
              <Table wrapperProps={{
                tabIndex: 0,
                role: 'region',
                'aria-label': `Scrollable repository inventory for ${root.path}`,
                'aria-describedby': `${headingId}-scroll-hint`,
                className: 'hidden md:block',
              }} className="min-w-[480px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="w-[55%]">Repository / component</TableHead>
                    <TableHead scope="col" className="w-[45%]">Stack</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {root.repositories.map(repository => (
                    <TableRow key={repository.path}>
                      <TableCell className="whitespace-normal"><RepositorySource repository={repository} /></TableCell>
                      <TableCell className="whitespace-normal text-sm">{repository.stack.join(' + ') || 'Not detected'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="divide-y divide-border border-y border-border md:hidden">
                {root.repositories.map(repository => (
                  <article key={repository.path} className="py-4">
                    <RepositorySource repository={repository} />
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
                      <StateText label="Stack" value={repository.stack.join(' + ') || 'Not detected'} />
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function WorkstreamEntry({ workstream, leases }: {
  workstream: Workstream;
  leases: Lease[];
}) {
  const mine = leases.filter(lease => lease.workstreamId === workstream.id);
  const queuePosition = (target: Lease) => leases
    .filter(lease => lease.resource === target.resource && lease.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .findIndex(lease => lease.workstreamId === target.workstreamId && lease.createdAt === target.createdAt) + 1;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{workstream.name}</p>
        <Badge variant="outline">{workstream.status}</Badge>
      </div>
      <ul className="mt-1 grid gap-1">
        {workstream.checkouts.map(checkout => (
          <li key={checkout.root} className="break-all font-mono text-xs text-muted-foreground">
            {checkout.root} · rev {checkout.revision ? `${checkout.revision.slice(0, 12)}…` : 'unknown'}
          </li>
        ))}
      </ul>
      {mine.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {mine.map(lease => (
            <li key={`${lease.resource}-${lease.createdAt}`} className="break-all font-mono text-xs text-muted-foreground">
              <span>{lease.resource} · {lease.status}{lease.status === 'queued' ? ` (position ${queuePosition(lease)})` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkstreamsSection({ workstreams, leases, loading, error }: {
  workstreams: Workstream[];
  leases: Lease[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <section aria-labelledby="workstreams-heading" className="border-t border-border pt-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">PARALLEL WORKSTREAMS</p>
          <h2 id="workstreams-heading" className="text-base font-semibold">Workstreams</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Recorded workstreams group registered roots with pinned revisions. OpenWorkspace does not create checkouts or mutate repositories.
          </p>
        </div>
      </header>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">Workstreams could not be read: {error}</p>
      )}
      {workstreams.length > 0 && (
        <ul className="mt-4 divide-y divide-border border-y border-border">
          {workstreams.map(workstream => (
            <WorkstreamEntry
              key={workstream.id}
              workstream={workstream}
              leases={leases}
            />
          ))}
        </ul>
      )}
      {workstreams.length === 0 && !loading && !error && (
        <p className="mt-4 text-sm text-muted-foreground">No workstreams have been recorded for this project.</p>
      )}
    </section>
  );
}

function ServicesPanel({ services, loading, error, onInspectServices }: {
  services: ServiceInventory | null;
  loading: boolean;
  error: string | null;
  onInspectServices: () => void;
}) {
  return (
    <section aria-labelledby="service-inspection-heading" className="border-t border-border pt-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">LOCAL SERVICES</p>
          <h2 id="service-inspection-heading" className="text-base font-semibold">Connected services</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Read-only PM2 process metadata for services mapped to this project. Process state does not prove health or readiness.</p>
        </div>
        <Button type="button" variant="outline" onClick={onInspectServices} disabled={loading}>
          {loading ? 'Inspecting…' : services ? 'Refresh service information' : 'Inspect services'}
        </Button>
      </header>
      {error && !services && (
        <p role="alert" className="mt-3 text-sm text-destructive">Service information could not be read: {error}</p>
      )}
      {services && !services.available && (
        <p role="status" className="mt-4 text-sm text-muted-foreground">PM2 service metadata is unavailable on this machine. It has not been checked; install or start PM2 if you need this capability.</p>
      )}
      {services?.available && (
        <div className="mt-4 space-y-4">
          {services.services.length > 0 && (
            <ul className="divide-y divide-border border-y border-border">
              {services.services.map(service => (
                <li key={`${service.name}-${service.pmId}-${service.cwd}`} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{service.name}</p>
                    <Badge variant="outline">{service.status}</Badge>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{service.exactRootPath || service.matchedRoots.join(', ')}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">Working directory: {service.cwd}</p>
                </li>
              ))}
            </ul>
          )}
          {services.ambiguousServices.length > 0 && (
            <div role="status" className="border-l-2 border-warning bg-warning-background px-4 py-3 text-sm text-warning">
              <p className="font-semibold">Some services are not clearly owned by one project root.</p>
              <ul className="mt-2 grid gap-1 text-xs leading-5">
                {services.ambiguousServices.map(service => (
                  <li key={`${service.name}-${service.pmId}`}>{service.name}: candidate roots {service.matchedRoots.join(', ')}</li>
                ))}
              </ul>
            </div>
          )}
          {services.services.length === 0 && services.ambiguousServices.length === 0 && (
            <p className="text-sm text-muted-foreground">No PM2 process working directory matches a registered project root.</p>
          )}
          <p className="text-xs text-muted-foreground">
            {services.processCount} local {services.processCount === 1 ? 'process' : 'processes'} scanned · {services.matchedProcessCount} matched this project · {services.unmatchedProcessCount} outside the project scope. Metadata is read-only.
          </p>
        </div>
      )}
    </section>
  );
}

function CapabilityList({ capabilities }: { capabilities: Capability[] }) {
  return (
    <section className="border-t border-border pt-5" aria-labelledby="tools-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tools-heading" className="text-sm font-semibold">Tools on this machine</h2>
        <p className="text-xs text-muted-foreground">Availability is not runtime readiness. No commands are executed.</p>
      </div>
      <ul className="mt-3 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
        {capabilities.map(capability => (
          <li key={capability.id} className="border-t border-border py-3">
            <p className="text-sm font-medium">{capability.name}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{capability.purpose}</p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium">
              {capability.status === 'found'
                ? <><Check aria-hidden="true" className="size-3.5 text-success" />Found · not verified</>
                : <><CircleDashed aria-hidden="true" className="size-3.5 text-muted-foreground" />Not found · {capability.required ? 'needed for Git operations' : 'optional'}</>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
