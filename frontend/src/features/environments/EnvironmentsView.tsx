import { useState } from 'react';
import type { ApiClient, EnvironmentRecord, EnvironmentStatus, Workspace } from '@/api';
import { EnvironmentsSection } from '@/features/environments/environment-board';
import { CoordinatorSection } from '@/features/environments/coordinator-section';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';

interface WorkspaceEnvironments {
  workspace: string;
  environments: EnvironmentRecord[];
  statuses: Record<string, EnvironmentStatus>;
}

/**
 * Environments picker: the observer-first shell keeps no project selection,
 * so the workspace scope lives in this view's local state. Read-only —
 * nothing here starts, stops, or edits anything.
 */
export function EnvironmentsView({ api, workspaces, refreshToken }: {
  api: ApiClient;
  workspaces: Workspace[];
  refreshToken: number;
}) {
  const [selected, setSelected] = useState('');
  const [coordinatorEnvironment, setCoordinatorEnvironment] = useState('');
  const selectWorkspace = (name: string) => {
    setSelected(name);
    setCoordinatorEnvironment('');
  };

  const { data, warnings, loading, error } = useObserverFetch<WorkspaceEnvironments | null>(async () => {
    if (!selected) return { data: null, warnings: [] };
    const records = await api.environments(selected);
    const settled = await Promise.all(records.map(record =>
      api.environmentStatus(selected, record.name).catch(() => null),
    ));
    const statuses: Record<string, EnvironmentStatus> = {};
    settled.forEach((status, index) => {
      if (status) statuses[records[index].name] = status;
    });
    return { data: { workspace: selected, environments: records, statuses }, warnings: [] };
  }, [selected, refreshToken]);

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-5">
        <p className="eyebrow">LOCAL ENVIRONMENTS</p>
        <h1 className="text-2xl font-semibold tracking-tight">Environments</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          Read-only service topology with live status per registered project. Nothing here starts, stops, or edits anything.
        </p>
      </header>

      {workspaces.length === 0 ? (
        <div className="space-y-2 py-5">
          <p role="status" className="text-sm text-muted-foreground">
            No projects registered yet. Connect your assistant on the &quot;Connect your AI&quot; page — it registers a project for you, and its services appear here.
          </p>
          <p><a href="#setup" className="text-sm font-medium text-primary underline-offset-4 hover:underline">Connect your AI →</a></p>
        </div>
      ) : (
        <div className="grid max-w-xl gap-1">
          <label htmlFor="environments-workspace" className="text-xs font-medium text-muted-foreground">Project</label>
          <select
            id="environments-workspace"
            className="project-select"
            value={selected}
            onChange={event => selectWorkspace(event.currentTarget.value)}
          >
            <option value="">Select a project…</option>
            {workspaces.map(workspace => <option key={workspace.name} value={workspace.name}>{workspace.name}</option>)}
          </select>
        </div>
      )}

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {selected === '' && workspaces.length > 0 && (
        <p className="text-sm text-muted-foreground">Select a project to review its recorded environments.</p>
      )}
      {selected !== '' && loading && !data && !error && (
        <p role="status" className="text-sm text-muted-foreground">Reading environment status…</p>
      )}
      {data && (
        <>
          <EnvironmentsSection
            environments={data.environments}
            statuses={data.statuses}
            loading={loading}
            error={null}
          />
          {data.environments.length > 0 && (
            <>
              <div className="grid max-w-xl gap-1">
                <label htmlFor="coordinator-environment" className="text-xs font-medium text-muted-foreground">Coordinator environment</label>
                <select
                  id="coordinator-environment"
                  className="project-select"
                  value={coordinatorEnvironment || data.environments[0].name}
                  onChange={event => setCoordinatorEnvironment(event.currentTarget.value)}
                >
                  {data.environments.map(record => <option key={record.id} value={record.name}>{record.name}</option>)}
                </select>
              </div>
              <CoordinatorSection
                api={api}
                workspace={data.workspace}
                environment={coordinatorEnvironment || data.environments[0].name}
                refreshToken={refreshToken}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
