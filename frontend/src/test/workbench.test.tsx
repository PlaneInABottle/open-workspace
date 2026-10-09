import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { ClientConfig, Overview, Workspace } from '../api';

const clientConfig: ClientConfig = {
  mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['/opt/openworkspace/mcp.mjs'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state' } } },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function workspace(name: string): Workspace {
  return { id: `id-${name}`, name, roots: [`/tmp/${name}`], createdAt: '2026-01-01T00:00:00.000Z' };
}

function overview(values: Partial<Overview> = {}): Overview {
  return {
    workspaces: [],
    milestone: 'M0',
    limits: [],
    ...values,
  };
}

function installFetch(handler: (path: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    return handler(decodeURI(url.pathname) + url.search, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  sessionStorage.clear();
  window.location.hash = '#observe';
});

describe('observer-first workbench', () => {
  it('loads the workspace immediately with no connect step and no credential storage', async () => {
    const fetchMock = installFetch(async path => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path.startsWith('/api/observer/doctor')) return json({ checks: [], warnings: [] });
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: [] });
      return json({ error: 'Not found.' }, 404);
    });

    sessionStorage.setItem('openworkspace.pairing', 'legacy-manual-key');
    sessionStorage.setItem('openworkspace.dashboard-session', 'stale-token');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'What your AI did' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password|pairing key/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pairing key|pairing command|password|Connect this browser/i);
    // Legacy stored credentials are cleared and never sent.
    expect(sessionStorage.getItem('openworkspace.pairing')).toBeNull();
    expect(sessionStorage.getItem('openworkspace.dashboard-session')).toBeNull();
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
      expect(headers.get('Authorization')).toBeNull();
    }
  });

  it('shows four navigation areas with Observe first and no project registration UI', async () => {
    installFetch(async path => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path.startsWith('/api/observer/doctor')) return json({ checks: [], warnings: [] });
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: [] });
      return json({ error: 'Not found.' }, 404);
    });
    render(<App />);
    const navs = await screen.findAllByRole('navigation', { name: 'Primary navigation' });
    expect(navs.length).toBeGreaterThan(0);
    const nav = navs[0];
    expect(nav.textContent).toMatch(/Activity/);
    expect(nav.textContent).toMatch(/Environments/);
    expect(nav.textContent).toMatch(/Connect your AI/);
    expect(nav.textContent).toMatch(/Access & privacy/);
    expect(document.body.textContent).not.toMatch(/Create new project|Choose a project|Learned lessons|What happened here/i);
  });

  it('renders the honest empty state when the observer is not enabled', async () => {
    installFetch(async path => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path.startsWith('/api/observer/doctor')) {
        return json({ checks: [{ name: 'log', ok: false, detail: 'unreadable' }], warnings: [] });
      }
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: ['observer not enabled on this machine'] });
      return json({ error: 'Not found.' }, 404);
    });
    render(<App />);
    expect(await screen.findByText(/Nothing recorded yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your AI →' })).toHaveAttribute('href', '#setup');
    expect(await screen.findByText(/observer not enabled on this machine/i)).toBeInTheDocument();
  });

  it('keeps environments behind a local project scope without workbench selection', async () => {
    installFetch(async path => {
      if (path === '/api/overview') return json(overview({ workspaces: [workspace('alpha')] }));
      if (path === '/api/client-config') return json(clientConfig);
      if (path.startsWith('/api/observer/doctor')) return json({ checks: [], warnings: [] });
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: [] });
      if (path === '/api/workspaces/alpha/environments') {
        return json([{ id: 'env-1', name: 'dev', services: [], state: 'down', updatedAt: '2026-10-06T00:00:00.000Z' }]);
      }
      if (path.startsWith('/api/workspaces/alpha/environments/status')) return json({ environmentId: 'env-1', name: 'dev', state: 'down', order: [], services: [] });
      if (path.startsWith('/api/workspaces/alpha/coordinator')) {
        return json({
          reconcile: { inSync: true, drifts: [] },
          readiness: [],
          explanation: null,
          preflight: { pass: true, gates: [], missing: [] },
          checkpoints: null,
          scenarios: null,
          warnings: [],
          meta: { producedAt: '2026-10-09T12:00:00.000Z', snapshotId: 'a3f9c1d2', environment: 'dev' },
        });
      }
      return json({ error: 'Not found.' }, 404);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getAllByRole('link', { name: /Environments/ })[0]);
    expect(await screen.findByText(/Select a project to review its recorded environments/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Project/), { target: { value: 'alpha' } });
    const environments = await screen.findByRole('region', { name: 'Environments' });
    expect(within(environments).getByText('dev')).toBeInTheDocument();
    // The coordinator section follows the same one-shot refresh with its own
    // environment scope and witness line.
    expect(await screen.findByRole('region', { name: 'Koordinatör' })).toBeInTheDocument();
    expect(await screen.findByText('eşleşiyor')).toBeInTheDocument();
  });

  it('renders the setup prompt without a project selection and lists registered projects', async () => {
    installFetch(async path => {
      if (path === '/api/overview') return json(overview({ workspaces: [workspace('alpha')] }));
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/activity') return json([]);
      if (path.startsWith('/api/observer/doctor')) return json({ checks: [], warnings: [] });
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: [] });
      return json({ error: 'Not found.' }, 404);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getAllByRole('link', { name: /Connect your AI/ })[0]);
    expect(await screen.findByRole('button', { name: /Copy setup prompt/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('link', { name: /Access & privacy/ })[0]);
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect this browser tab/ })).not.toBeInTheDocument();
  });

  it('surfaces service errors without a reconnect prompt', async () => {
    installFetch(async path => {
      if (path === '/api/overview') return json({ error: 'Operation could not complete safely.' }, 400);
      if (path === '/api/client-config') return json(clientConfig);
      return json({ error: 'Not found.' }, 404);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Operation could not complete safely/)).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/Connect this browser/i);
    expect(act).toBeDefined();
  });
});
