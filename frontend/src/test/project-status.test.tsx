import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { dashboardSessionStorageKey } from '../api';
import { NOT_YET_CHECKED_LABEL, ProjectStatusBlock } from '../features/projects/ProjectStatusBlock';

const dashboardToken = 'e'.repeat(64);
const clientConfig = {
  mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['/opt/openworkspace/mcp.mjs'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state' } } },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function overview(workspaces: unknown[] = []) {
  return { workspaces, capabilities: [], milestone: 'M1 · operate and verify', limits: [] };
}

const approved = { id: '33333333-3333-4333-8333-333333333333', name: 'Status fixture', roots: ['/tmp/status-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };

function statusInspection() {
  return {
    workspace: approved,
    target: { id: 'local' as const, kind: 'local' as const },
    roots: [{
      path: '/tmp/status-fixture',
      repositories: [{
        name: 'web',
        path: '/tmp/status-fixture/web',
        git: true,
        stack: ['Node.js'],
        manifests: ['package.json'],
        instructions: [],
        scriptNames: [],
        composeFiles: [],
        processState: 'not_connected' as const,
        readiness: 'not_checked' as const,
      }],
      warnings: [],
      unavailable: false,
    }],
  };
}

function serviceInventory() {
  return {
    inspectedAt: '2026-10-02T00:00:00.000Z',
    runner: 'pm2' as const,
    available: true,
    processCount: 2,
    matchedProcessCount: 1,
    unmatchedProcessCount: 1,
    services: [{ name: 'web', pmId: 7, namespace: 'default', status: 'online', cwd: '/tmp/status-fixture/web', restartCount: 0, matchedRoots: ['/tmp/status-fixture'], exactRootPath: '/tmp/status-fixture' }],
    ambiguousServices: [],
  };
}

function installFetch(handler: (path: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    const response = await handler(url.pathname, init);
    if ((url.pathname === '/api/workstreams' || url.pathname === '/api/leases')
      && (init.method ?? 'GET') === 'GET' && response.status === 404) {
      return json([]);
    }
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  sessionStorage.clear();
  window.location.hash = '#overview';
});

describe('project status block', () => {
  it('separates connection, discovery and readiness with honest unchecked language', () => {
    render(
      <ProjectStatusBlock
        connected
        inspection={statusInspection()}
        inspectionLoading={false}
        services={null}
        servicesLoading={false}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Project status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connection.*Connected · this browser tab/s })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Metadata discovery.*inventory produced/s })).toBeInTheDocument();
    const readiness = screen.getByRole('button', { name: new RegExp(`Runtime readiness.*${NOT_YET_CHECKED_LABEL.replace(/[·]/g, '.')}`, 's') });
    expect(readiness).toHaveAttribute('aria-expanded', 'false');
    expect(document.body.textContent).not.toMatch(/not ready/i);
  });

  it('never claims readiness success from process state', () => {
    render(
      <ProjectStatusBlock
        connected
        inspection={statusInspection()}
        inspectionLoading={false}
        services={serviceInventory()}
        servicesLoading={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Runtime readiness.*Not yet checked/s })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not ready|ready ·|ready ✓|serving/i);
    fireEvent.click(screen.getByRole('button', { name: /Runtime readiness/s }));
    const detail = screen.getByRole('region', { name: 'Runtime readiness detail' });
    expect(detail).toHaveTextContent(/no readiness probe has run/i);
    expect(detail).toHaveTextContent(/web: online/i);
    expect(detail).toHaveTextContent(/process state only/i);
  });

  it('expands row detail on click and collapses on a second click', () => {
    render(
      <ProjectStatusBlock
        connected
        inspection={statusInspection()}
        inspectionLoading={false}
        services={null}
        servicesLoading={false}
      />,
    );
    const discovery = screen.getByRole('button', { name: /Metadata discovery/s });
    expect(discovery).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Metadata discovery detail' })).not.toBeInTheDocument();
    fireEvent.click(discovery);
    expect(discovery).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Metadata discovery detail' })).toHaveTextContent(/inventory produced from 1 registered root/i);
    fireEvent.click(discovery);
    expect(discovery).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Metadata discovery detail' })).not.toBeInTheDocument();
  });

  it('shows not-yet-checked for discovery and readiness when nothing was inspected, without failure language', () => {
    render(
      <ProjectStatusBlock
        connected
        inspection={null}
        inspectionLoading={false}
        services={null}
        servicesLoading={false}
      />,
    );
    expect(screen.getAllByText(NOT_YET_CHECKED_LABEL)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Metadata discovery/s }));
    expect(screen.getByRole('region', { name: 'Metadata discovery detail' })).toHaveTextContent(/no metadata check has run/i);
    fireEvent.click(screen.getByRole('button', { name: /Runtime readiness/s }));
    expect(screen.getByRole('region', { name: 'Runtime readiness detail' })).toHaveTextContent(/service information has not been inspected yet/i);
    expect(document.body.textContent).not.toMatch(/not ready|failed|unavailable|error/i);
  });

  it('renders the status block for a selected project without per-repository status noise', async () => {
    installFetch(async path => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview([approved]));
      if (path === `/api/workspaces/${approved.id}`) return json(statusInspection());
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: /Status fixture/ }));
    expect(await screen.findByRole('heading', { name: 'Project status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Runtime readiness.*Not yet checked/s })).toBeInTheDocument();
    expect(screen.queryByText('Application runner')).not.toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not ready/i);
  });
});
