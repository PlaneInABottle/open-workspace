import { useState } from 'react';
import { ArrowRight, Check, CircleAlert, CircleDashed, CircleDot, FolderKanban, Plus } from 'lucide-react';
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
import { projectRootLabel } from '@/features/projects/root-label';
import type { Capability, Inspection, ProjectRootPickerResult, Proposal, Workspace } from '@/api';
import type { WorkbenchState } from '@/use-workbench';
import type { ProjectRequest } from '@/validation';

interface OverviewViewProps {
  state: WorkbenchState;
  onProjectRequest: (value: ProjectRequest) => Promise<{ ok: boolean }>;
  onPickRoots: (signal: AbortSignal) => Promise<ProjectRootPickerResult>;
  onSelectProject: (id: string) => void;
  onRetryInspection: (id: string) => void;
  onGoToAi: () => void;
}

interface PendingRequestsProps {
  proposals: Proposal[];
  busyIds: ReadonlySet<string>;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}

export function PendingRequests({ proposals, busyIds, onApprove, onDecline }: PendingRequestsProps) {
  if (!proposals.length) return null;
  return (
    <section aria-labelledby="pending-requests-heading" className="mb-8 border-y border-warning/35 bg-warning-background/70 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <h2 id="pending-requests-heading" className="text-sm font-semibold">Waiting for your approval</h2>
        <span className="text-xs text-muted-foreground">{proposals.length}</span>
      </div>
      <ul className="mt-3 divide-y divide-warning/20">
        {proposals.map(proposal => {
          const busy = busyIds.has(`proposal:${proposal.id}`);
          return (
            <li key={proposal.id} className="grid gap-3 py-4 first:pt-1 last:pb-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">{proposal.name}</h3>
                <ul aria-label="Requested repository folders" className="mt-2 grid gap-1">
                  {proposal.roots.map(root => <li key={root} className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-muted-foreground">{root}</li>)}
                </ul>
                <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">Approval allows bounded metadata discovery in each listed folder only. It does not include a common parent, secret reads, commands, installs, or file changes.</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(proposal.id)} aria-label={`Approve project access for ${proposal.name}`}>
                  {busy ? 'Updating…' : 'Approve access'}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecline(proposal.id)} aria-label={`Decline project request for ${proposal.name}`}>
                  Decline
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function OverviewView({ state, onProjectRequest, onPickRoots, onSelectProject, onRetryInspection, onGoToAi }: OverviewViewProps) {
  const [creating, setCreating] = useState(false);
  const selectProject = (id: string) => {
    setCreating(false);
    onSelectProject(id);
  };
  const selected = state.workspaces.find(workspace => workspace.id === state.selectedId);
  const title = selected?.name || 'Projects';
  const description = selected
    ? 'Approved metadata inventory · no application has been started or health-checked.'
    : state.workspaces.length
      ? 'Choose a project to view its approved repository groups.'
      : 'Create a named project from the repository folders you choose. Nothing is read until you approve the complete request.';

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
          inspection={state.inspection}
          loading={state.inspectionLoading}
          error={state.inspectionError}
          onRetry={() => onRetryInspection(selected.id)}
          onGoToAi={onGoToAi}
        />
      ) : state.workspaces.length > 0 ? (
        <section aria-labelledby="project-selection-heading" className="max-w-4xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="project-selection-heading" className="text-base font-semibold">Choose a project</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Select a project to review its approved repository folders.</p>
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

function ProjectInventory({ inspection, loading, error, onRetry, onGoToAi }: {
  inspection: Inspection | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onGoToAi: () => void;
}) {
  const componentCount = inspection?.roots.reduce((total, root) => total + root.repositories.length, 0) || 0;
  const unavailableCount = inspection?.roots.filter(root => root.unavailable).length || 0;
  if (!inspection && loading) return <p role="status" className="border-y border-border py-5 text-sm text-muted-foreground">Reading approved project metadata…</p>;
  if (!inspection) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-4 border-y border-destructive/40 py-5">
        <p className="text-sm text-destructive">{error || 'Select an approved project to inspect its metadata.'}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry inspection</Button>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">Updating approved metadata; showing the last confirmed inventory.</p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 border-y border-destructive/40 py-3">
          <p className="text-sm text-destructive">Could not refresh this inventory: {error} The last confirmed inventory is still shown.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry inspection</Button>
        </div>
      )}
      <section aria-labelledby="project-inventory-heading" className="min-w-0">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <p className="eyebrow">APPROVED METADATA</p>
            <h2 id="project-inventory-heading" className="text-base font-semibold">Project inventory</h2>
            <p className="mt-1 text-sm text-muted-foreground">{inspection.roots.length} {inspection.roots.length === 1 ? 'root' : 'roots'} · {componentCount} {componentCount === 1 ? 'component' : 'components'} · no runtime was started or checked.</p>
          </div>
          <Badge variant="outline">{unavailableCount ? `${unavailableCount} roots unavailable` : 'Metadata only'}</Badge>
        </header>
        <div className="divide-y divide-border">
          {inspection.roots.map((root, rootIndex) => (
            <RootInventory key={root.path} root={root} index={rootIndex} />
          ))}
        </div>
      </section>
      <section className="next-step" aria-labelledby="project-next-step-heading">
        <div className="min-w-0">
          <p className="eyebrow">NEXT STEP</p>
          <h2 id="project-next-step-heading" className="text-base font-semibold">Connect your AI to prepare this project</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Technical setup has not been performed. Your assistant can explain and propose next steps; nothing starts automatically.</p>
        </div>
        <Button type="button" onClick={onGoToAi} className="shrink-0">Connect your AI <ArrowRight aria-hidden="true" data-icon="inline-end" /></Button>
      </section>
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
        <Badge variant="outline">{root.unavailable ? 'Unavailable' : 'Approved root'}</Badge>
      </header>
      {root.unavailable ? (
        <p role="alert" className="mt-3 border-l-2 border-destructive px-3 py-2 text-sm text-destructive">{root.error || 'This approved root is unavailable. Other project roots remain available.'}</p>
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
              }} className="min-w-[720px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="w-[34%]">Repository / component</TableHead>
                    <TableHead scope="col" className="w-[24%]">Stack</TableHead>
                    <TableHead scope="col" className="w-[21%]">Application runner</TableHead>
                    <TableHead scope="col" className="w-[21%]">Readiness</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {root.repositories.map(repository => (
                    <TableRow key={repository.path}>
                      <TableCell className="whitespace-normal"><RepositorySource repository={repository} /></TableCell>
                      <TableCell className="whitespace-normal text-sm">{repository.stack.join(' + ') || 'Not detected'}</TableCell>
                      <TableCell><StatusLabel icon="connected" label="Not connected" /></TableCell>
                      <TableCell><StatusLabel icon="readiness" label="Not checked" /></TableCell>
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
                      <StateText label="Application runner" value="Not connected" />
                      <StateText label="Readiness" value="Not checked" />
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

function StatusLabel({ icon, label }: { icon: 'connected' | 'readiness'; label: string }) {
  const Icon = icon === 'connected' ? CircleDot : CircleDashed;
  return <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><Icon aria-hidden="true" className="size-3.5 shrink-0" />{label}</span>;
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
