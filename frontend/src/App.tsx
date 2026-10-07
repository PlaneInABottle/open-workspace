import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Boxes,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiSetupView } from '@/features/ai-setup/AiSetupView';
import { EnvironmentsView } from '@/features/environments/EnvironmentsView';
import { ObserveView } from '@/features/observe/ObserveView';
import { PrivacyView } from '@/features/privacy/PrivacyView';
import { ensureViewHash, hashFor, routeFromHash, type Route, type View } from '@/hash-navigation';
import { useWorkbench } from '@/use-workbench';
import type { Notice } from '@/use-workbench';

const viewLabels: Record<View, string> = {
  observe: 'Activity',
  environments: 'Environments',
  setup: 'Connect your AI',
  privacy: 'Access & privacy',
};

function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    setRoute(ensureViewHash());
    const sync = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const navigate = useCallback((target: View) => {
    const hash = `#${target}`;
    if (window.location.hash === hash) setRoute(routeFromHash(hash));
    else window.location.hash = target;
  }, []);
  const replace = useCallback((next: Route) => {
    const hash = hashFor(next);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    setRoute(next);
  }, []);
  return { route, navigate, replace };
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
    <a href="#observe" className="flex w-fit items-center gap-3 text-sm font-semibold tracking-tight text-foreground no-underline">
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">OW</span>
      OpenWorkspace
    </a>
  );
}

function Navigation({ view }: { view: View }) {
  const links: { view: View; icon: typeof Activity }[] = [
    { view: 'observe', icon: Activity },
    { view: 'environments', icon: Boxes },
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
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span>{viewLabels[target]}</span>
        </a>
      ))}
    </nav>
  );
}

function ProjectRail({ view }: { view: View }) {
  return (
    <aside className="project-rail" aria-label="Workspace rail">
      <Brand />
      <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        Local workspace
      </div>
      <div className="mt-6 border-t border-border" />
      <Navigation view={view} />
      <div className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
        <p className="font-medium text-foreground">This page only records.</p>
        <p>Your assistant runs the commands.</p>
      </div>
    </aside>
  );
}

function MobileNavigation({ view }: { view: View }) {
  return (
    <div className="mobile-navigation">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Brand />
        <Badge variant="outline" className="gap-1.5 font-normal">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Local only
        </Badge>
      </div>
      <Navigation view={view} />
    </div>
  );
}

export function App() {
  const workbench = useWorkbench();
  const { state } = workbench;
  const { route } = useHashRoute();
  const [refreshToken, setRefreshToken] = useState(0);

  const loadActivity = workbench.loadActivity;
  useEffect(() => {
    if (route.view === 'setup' && state.phase === 'connected') void loadActivity();
  }, [route.view, state.phase, loadActivity]);

  async function refreshWorkspace() {
    if (state.refreshing) return;
    if (await workbench.refresh()) {
      setRefreshToken(current => current + 1);
      workbench.setNotice({ kind: 'success', message: 'Workspace refreshed.' });
    }
  }

  if (state.phase !== 'connected') {
    return null;
  }

  return (
    <div className="workbench-shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <ProjectRail view={route.view} />
      <header className="mobile-workspace">
        <MobileNavigation view={route.view} />
      </header>
      <main id="main-content" className="workbench-main" tabIndex={-1}>
        <header className="workbench-topbar">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>Workspace</span><span aria-hidden="true">/</span><span className="truncate font-medium text-foreground">{viewLabels[route.view]}</span>
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
          {route.view === 'observe' && <ObserveView api={workbench.api} route={route.observe} onCopyText={workbench.copyText} refreshToken={refreshToken} />}
          {route.view === 'environments' && <EnvironmentsView api={workbench.api} workspaces={state.workspaces} refreshToken={refreshToken} />}
          {route.view === 'setup' && <AiSetupView state={state} selectedName={null} onCopyText={workbench.copyText} />}
          {route.view === 'privacy' && <PrivacyView workspaces={state.workspaces} busyIds={state.busyIds} onRemove={name => void workbench.removeWorkspace(name)} />}
        </div>
        <footer className="workbench-footer"><LockKeyhole aria-hidden="true" className="size-3.5" />Runs locally · records only, never operates</footer>
      </main>
    </div>
  );
}
