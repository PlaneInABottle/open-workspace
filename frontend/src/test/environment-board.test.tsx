import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { type EnvironmentRecord, type EnvironmentStatus } from '../api';
import {
  EnvironmentsSection,
  lastPollLabel,
  readinessLabel,
  serviceChainLabel,
} from '../features/environments/environment-board';

function topology(): EnvironmentRecord {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'dev',
    state: 'partial',
    updatedAt: '2026-10-04T10:00:00.000Z',
    services: [
      {
        id: 'web',
        name: 'web',
        port: 3000,
        dependsOn: ['api'],
        readiness: { kind: 'http-200', path: '/healthz', timeoutSecs: 30 },
      },
      {
        id: 'api',
        name: 'api',
        port: null,
        dependsOn: [],
        readiness: { kind: 'process-alive' },
      },
    ],
  };
}

function status(): EnvironmentStatus {
  return {
    environmentId: '66666666-6666-4666-8666-666666666666',
    name: 'dev',
    state: 'partial',
    order: ['api', 'web'],
    services: [
      {
        serviceId: 'api',
        name: 'api',
        status: 'starting',
        detail: 'The worker process is alive; process-alive services report at most starting.',
        owned: {
          serviceId: 'api',
          name: 'api',
          lastPoll: { status: 'starting', attempts: 2, httpStatus: null, checkedAt: '2026-10-04T11:00:00.000Z' },
        },
      },
      {
        serviceId: 'web',
        name: 'web',
        status: 'ready',
        detail: 'The last readiness poll succeeded.',
        owned: {
          serviceId: 'web',
          name: 'web',
          lastPoll: { status: 'ready', attempts: 3, httpStatus: 200, checkedAt: '2026-10-04T11:30:00.000Z' },
        },
      },
      {
        serviceId: 'old-worker',
        name: 'old-worker',
        status: 'stale',
        detail: 'The service left the topology; its old process is tracked, never stopped here.',
        owned: { serviceId: 'old-worker', name: 'old-worker', lastPoll: null },
      },
    ],
  };
}

describe('environment helpers', () => {
  it('states readiness kind with the process-alive ceiling', () => {
    const [web, api] = topology().services;
    expect(readinessLabel(web)).toBe('http-200 → /healthz');
    expect(readinessLabel(api)).toBe('process-alive (reports at most starting)');
  });
  it('chains port plus dependencies as text', () => {
    const [web, api] = topology().services;
    expect(serviceChainLabel(web)).toBe('port 3000 · depends on api');
    expect(serviceChainLabel(api)).toBe('no port · no dependencies');
  });
  it('summarizes the last poll receipt and stays quiet without one', () => {
    const [api, , stale] = status().services;
    expect(lastPollLabel(api)).toMatch(/^last poll starting · 2 attempts · /);
    expect(lastPollLabel(stale)).toBeNull();
  });
});

describe('EnvironmentsSection', () => {
  it('renders services in topological order with chips, chains, receipts and a muted stale subsection', () => {
    render(<EnvironmentsSection environments={[topology()]} statuses={{ dev: status() }} loading={false} error={null} />);
    const section = screen.getByRole('region', { name: 'Environments' });
    expect(within(section).getByText('dev')).toBeInTheDocument();
    expect(within(section).getByText('partial')).toBeInTheDocument();
    // Topological order: api before web, even though the topology lists web first.
    const names = within(section).getAllByText(/^(api|web)$/).map(node => node.textContent);
    expect(names).toEqual(['api', 'web']);
    expect(within(section).getByText('depends on: api')).toBeInTheDocument();
    expect(within(section).getByText('depends on: nothing')).toBeInTheDocument();
    expect(within(section).getByText('starting')).toBeInTheDocument();
    expect(within(section).getByText('ready')).toBeInTheDocument();
    expect(within(section).getByText(/port 3000 · depends on api · http-200 → \/healthz/)).toBeInTheDocument();
    expect(within(section).getByText(/no port · no dependencies · process-alive/)).toBeInTheDocument();
    expect(within(section).getByText('The last readiness poll succeeded.')).toBeInTheDocument();
    expect(within(section).getByText(/last poll ready · 3 attempts · HTTP 200/)).toBeInTheDocument();
    expect(within(section).getByText('Stale entries')).toBeInTheDocument();
    expect(within(section).getByText('The service left the topology; its old process is tracked, never stopped here.')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByText(/dirty/i)).not.toBeInTheDocument();
  });

  it('degrades to topology-only when live status is missing', () => {
    render(<EnvironmentsSection environments={[topology()]} statuses={{}} loading={false} error={null} />);
    const section = screen.getByRole('region', { name: 'Environments' });
    expect(within(section).getAllByText('status unavailable')).toHaveLength(2);
    expect(within(section).getByText(/port 3000 · depends on api/)).toBeInTheDocument();
  });

  it('covers loading, error and empty states without controls', () => {
    const { rerender } = render(<EnvironmentsSection environments={[]} statuses={{}} loading error={null} />);
    expect(screen.getByText('Reading environment status…')).toBeInTheDocument();
    rerender(<EnvironmentsSection environments={[]} statuses={{}} loading={false} error="boom" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Environments could not be read: boom');
    rerender(<EnvironmentsSection environments={[]} statuses={{}} loading={false} error={null} />);
    expect(screen.getByText('No environments have been recorded for this project.')).toBeInTheDocument();
  });
});

const clientConfig = {
  mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['/opt/openworkspace/mcp.mjs'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state' } } },
};

function json(body: unknown, statusCode = 200) {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
}

describe('environment read-only wiring', () => {
  it('fetches topology plus per-environment status with GET only and never renders paths', async () => {
    const approved = { id: '77777777-7777-4777-8777-777777777777', name: 'Env fixture', roots: ['/tmp/env-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };
    const record = {
      ...topology(),
      id: '77777777-7777-4777-8777-777777777778',
      services: topology().services.map(service => ({ ...service, repositoryPath: '/tmp/secret-repo', scriptName: 'dev' })),
    };
    const seen: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), window.location.href);
      seen.push({ url: `${url.pathname}${url.search}`, method: init.method ?? 'GET' });
      const path = decodeURI(url.pathname);
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json({ workspaces: [approved], milestone: 'M1', limits: [] });
      if (path === `/api/workspaces/${approved.name}/environments` && (init.method ?? 'GET') === 'GET') return json([record]);
      if (path === `/api/workspaces/${approved.name}/environments/status` && (init.method ?? 'GET') === 'GET') {
        expect(url.searchParams.get('environment')).toBe('dev');
        return json(status());
      }
      if (path.startsWith('/api/observer/doctor')) return json({ checks: [], warnings: [] });
      if (path.startsWith('/api/observer/sessions')) return json({ sessions: [], warnings: [] });
      return json({ error: 'Not found.' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'What your AI did' });
    fireEvent.click(screen.getAllByRole('link', { name: 'Environments' })[0]);
    const projectSelect = await screen.findByRole('combobox', { name: 'Project' });
    fireEvent.change(projectSelect, { target: { value: 'Env fixture' } });

    const section = await screen.findByRole('region', { name: 'Environments' });
    expect(within(section).getByText('dev')).toBeInTheDocument();
    expect(within(section).getByText(/port 3000 · depends on api/)).toBeInTheDocument();
    // Absolute repository paths travel on the wire but never reach the document.
    expect(within(section).queryByText(/\/tmp\/secret-repo/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\/tmp\/secret-repo/);
    const envCalls = seen.filter(call => call.url.includes('/environments'));
    expect(envCalls.length).toBeGreaterThan(0);
    expect(envCalls.every(call => call.method === 'GET')).toBe(true);
    expect(seen.some(call => call.url.includes('/environments/up') || call.url.includes('/environments/down') || call.url.includes('/environment/verify'))).toBe(false);
  });
});
