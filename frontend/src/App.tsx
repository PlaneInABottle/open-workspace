import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderKanban,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConnectionView } from '@/features/connection/ConnectionView';
import { AiSetupView } from '@/features/ai-setup/AiSetupView';
import { projectRootLabel } from '@/features/projects/root-label';
import { OverviewView } from '@/features/projects/ProjectsView';
import { PrivacyView } from '@/features/privacy/PrivacyView';
import { ensureViewHash, viewFromHash, type View } from '@/hash-navigation';
import { useWorkbench } from '@/use-workbench';
import type { Notice } from '@/use-workbench';

const viewLabels: Record<View, string> = {
  overview: 'Projects',
  setup: 'Connect your AI',
  privacy: 'Access & privacy',
};

function useHashView() {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  useEffect(() => {
    setView(ensureViewHash());
    const sync = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const navigate = useCallback((target: View) => {
    if (window.location.hash === `#${target}`) setView(target);
    else window.location.hash = target;
  }, []);
  const replace = useCallback((target: View) => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${target}`);
    setView(target);
  }, []);
  return { view, navigate, replace };
}

function NoticeBanner({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  const isError = notice.kind === 'error';
  return (
    <div
      className={`notice-banner ${isError ? 'notice-error' : ''}`}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span>{notice.message}</span>
      <button type="button" className="notice-dismiss" aria-label="Dismiss message" onClick={dismiss}>
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

function Brand() {
  return (
    <a href="#overview" className="flex w-fit items-center gap-3 text-sm font-semibold tracking-tight text-foreground no-underline">
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">OW</span>
      OpenWorkspace
    </a>
  );
}

function Navigation({ view, onShowAllProjects }: { view: View; onShowAllProjects: () => void }) {
  const links: { view: View; icon: typeof FolderKanban }[] = [
    { view: 'overview', icon: FolderKanban },
    { view: 'setup', icon: Settings2 },
    { view: 'privacy', icon: ShieldCheck },
  ];
  return (
    <nav aria-label="Primary navigation" className="nav-links">
      {links.map(({ view: target, icon: Icon }) => (
        <a
          key={target}
          href={`#${target}`}
          aria-current={view === target ? 'page' : undefined}
          className="nav-link"
          onClick={target === 'overview' ? onShowAllProjects : undefined}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span>{viewLabels[target]}</span>
        </a>
      ))}
    </nav>
  );
}

function ProjectRail({
  view,
  workspaces,
  selectedId,
  onSelect,
  onShowAllProjects,
}: {
  view: View;
  workspaces: ReturnType<typeof useWorkbench>['state']['workspaces'];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onShowAllProjects: () => void;
}) {
  return (
    <aside className="project-rail" aria-label="Workspace rail">
      <Brand />
      <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        Local workspace
      </div>
      <div className="mt-6 border-t border-border" />
      <Navigation view={view} onShowAllProjects={onShowAllProjects} />
      <section className="mt-8 min-h-0 flex-1" aria-labelledby="rail-projects-heading">
        <div className="flex items-center justify-between gap-2 px-2">
          <h2 id="rail-projects-heading" className="eyebrow">CONNECTED PROJECTS</h2>
          {workspaces.length > 0 && <span className="text-[0.7rem] text-muted-foreground">{workspaces.length}</span>}
        </div>
        {workspaces.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">Projects appear here after you register their folders.</p>
        ) : (
          <ul className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
            {workspaces.map(workspace => (
              <li key={workspace.id} className="min-w-0">
                <button
                  type="button"
                  className={`rail-project ${selectedId === workspace.id ? 'rail-project-selected' : ''}`}
                  aria-pressed={selectedId === workspace.id}
                  onClick={() => onSelect(workspace.id)}
                >
                  <FolderKanban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{workspace.name}</span>
                   <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-muted-foreground" title={workspace.roots.join('\n')}>
                     {workspace.roots.length} {workspace.roots.length === 1 ? 'root' : 'roots'} · {projectRootLabel(workspace.roots[0])}
                   </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
        <p className="font-medium text-foreground">Local workspace</p>
        <p>Reads metadata; runs only what you confirm.</p>
      </div>
    </aside>
  );
}

function MobileNavigation({
  view,
  workspaces,
  selectedId,
  onSelect,
  onShowAllProjects,
  onClearSelection,
}: {
  view: View;
  workspaces: ReturnType<typeof useWorkbench>['state']['workspaces'];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onShowAllProjects: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="mobile-navigation">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Brand />
        <Badge variant="outline" className="gap-1.5 font-normal">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Local only
        </Badge>
      </div>
      {workspaces.length > 0 && (
        <div className="px-4 pb-3 sm:px-6">
          <label htmlFor="mobile-project-selector" className="sr-only">Select a connected project</label>
          <select
            id="mobile-project-selector"
            className="project-select"
            value={selectedId || ''}
            onChange={event => {
              if (event.currentTarget.value) onSelect(event.currentTarget.value);
              else onClearSelection();
            }}
          >
            <option value="">Select a project…</option>
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.roots.length} {workspace.roots.length === 1 ? 'folder' : 'folders'} · {projectRootLabel(workspace.roots[0])}
            </option>)}
          </select>
        </div>
      )}
      <Navigation view={view} onShowAllProjects={onShowAllProjects} />
    </div>
  );
}

export function App() {
  const workbench = useWorkbench();
  const { state } = workbench;
  const { view, navigate, replace } = useHashView();
  const wasConnected = useRef(state.phase === 'connected');

  useEffect(() => {
    if (wasConnected.current && state.phase === 'disconnected') replace('overview');
    wasConnected.current = state.phase === 'connected';
  }, [replace, state.phase]);

  const loadActivity = workbench.loadActivity;
  useEffect(() => {
    if (view === 'setup' && state.phase === 'connected') void loadActivity();
  }, [view, state.phase, loadActivity]);

  function selectProject(id: string) {
    navigate('overview');
    void workbench.inspectProject(id);
  }

  function showAllProjects() {
    workbench.clearSelection();
    navigate('overview');
  }

  async function refreshWorkspace() {
    if (state.refreshing) return;
    if (await workbench.refreshSelected()) workbench.setNotice({ kind: 'success', message: 'Workspace refreshed.' });
  }

  if (state.phase === 'loading') {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-center">
        <div className="max-w-md text-center">
          <div role="status" aria-live="polite">
            <span aria-hidden="true" className="loading-mark" />
            <h1 className="mt-4 text-lg font-semibold">Opening your local workspace</h1>
            {!state.notice && <p className="mt-1 text-sm text-muted-foreground">Checking this browser tab’s connection…</p>}
          </div>
          {state.notice && <div className="mt-5 text-left"><NoticeBanner notice={state.notice} dismiss={() => workbench.setNotice(null)} /></div>}
          {state.notice && (
            <Button type="button" variant="outline" className="mt-2" disabled={state.refreshing} onClick={() => void workbench.refresh()}>
              {state.refreshing ? 'Checking…' : 'Retry connection'}
            </Button>
          )}
        </div>
      </main>
    );
  }

  if (state.phase !== 'connected') {
    return (
      <>
        {state.notice && <div className="connection-notice"><NoticeBanner notice={state.notice} dismiss={() => workbench.setNotice(null)} /></div>}
        <ConnectionView state={state} onConnect={() => void workbench.connectDashboard()} />
      </>
    );
  }

  return (
    <div className="workbench-shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <ProjectRail view={view} workspaces={state.workspaces} selectedId={state.selectedId} onSelect={selectProject} onShowAllProjects={showAllProjects} />
      <header className="mobile-workspace">
        <MobileNavigation
          view={view}
          workspaces={state.workspaces}
          selectedId={state.selectedId}
          onSelect={selectProject}
          onShowAllProjects={showAllProjects}
          onClearSelection={showAllProjects}
        />
      </header>
      <main id="main-content" className="workbench-main" tabIndex={-1}>
        <header className="workbench-topbar">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>Workspace</span><span aria-hidden="true">/</span><span className="truncate font-medium text-foreground">{viewLabels[view]}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" className="hidden gap-1.5 font-normal sm:inline-flex">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              Local only
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={state.refreshing ? 'Refreshing workspace' : 'Refresh workspace'}
              aria-disabled={state.refreshing}
              aria-busy={state.refreshing}
              onClick={() => { if (!state.refreshing) void refreshWorkspace(); }}
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" className={state.refreshing ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{state.refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          </div>
        </header>
        <div className="workbench-content">
          {state.notice && <NoticeBanner notice={state.notice} dismiss={() => workbench.setNotice(null)} />}
          {view === 'overview' && (
            <OverviewView
              state={state}
              onProjectRequest={workbench.requestProject}
              onPickRoots={workbench.pickProjectRoots}
              onSelectProject={selectProject}
              onRetryInspection={id => { void workbench.inspectProject(id, true); }}
              onInspectServices={id => { void workbench.inspectServices(id); }}
              onGoToAi={() => navigate('setup')}
              onLoadRecords={workbench.loadRecords}
            />
          )}
          {view === 'setup' && <AiSetupView state={state} selectedId={state.selectedId} onCopyText={workbench.copyText} />}
          {view === 'privacy' && <PrivacyView workspaces={state.workspaces} busyIds={state.busyIds} onRemove={id => void workbench.removeWorkspace(id)} onDisconnect={() => { replace('overview'); workbench.disconnect(); }} />}
        </div>
        <footer className="workbench-footer"><LockKeyhole aria-hidden="true" className="size-3.5" />Local service · register and observe here; agents operate through MCP</footer>
      </main>
    </div>
  );
}
