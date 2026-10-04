import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { dashboardSessionStorageKey } from '../api';
import type { ClientConfig, Overview, Workspace } from '../api';

const dashboardToken = 'd'.repeat(64);
const clientConfig: ClientConfig = {
  mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['/opt/openworkspace/mcp.mjs'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state' } } },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function workspace(id: string, name: string, roots: string | string[]): Workspace {
  return { id, name, roots: Array.isArray(roots) ? roots : [roots], createdAt: '2026-01-01T00:00:00.000Z' };
}

function overview(values: Partial<Overview> = {}): Overview {
  return {
    workspaces: [],
    capabilities: [],
    milestone: 'M1 · operate and verify',
    limits: ['No secrets are read', 'Dangerous operations are authorized by your assistant client', 'No tools are installed'],
    ...values,
  };
}

function inspection(project: Workspace, repositoryName: string) {
  return {
    workspace: project,
    target: { id: 'local', kind: 'local' },
    roots: project.roots.map(path => ({
      path,
      repositories: [{
        name: repositoryName,
        path,
        git: true,
        stack: ['Java / Maven'],
        manifests: ['pom.xml'],
        instructions: [],
        scriptNames: [],
        composeFiles: [],
        processState: 'not_connected' as const,
        readiness: 'not_checked' as const,
      }],
      warnings: [],
      unavailable: false,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function installFetch(handler: (path: string, init: RequestInit) => Promise<Response>) {
  const origins: string[] = [];
  const tokens: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    origins.push(url.origin);
    const token = new Headers(init.headers).get('Authorization');
    if (token) tokens.push(token);
    const response = await handler(decodeURI(url.pathname), init);
    if ((url.pathname === '/api/workstreams' || url.pathname === '/api/leases')
      && (init.method ?? 'GET') === 'GET' && response.status === 404) {
      return json([]);
    }
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, origins, tokens };
}

async function connectBrowser() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect this browser' }));
}

async function connectedEmptyWorkspace() {
  sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
  render(<App />);
  return screen.findByRole('heading', { name: 'Projects' });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  sessionStorage.clear();
  window.location.hash = '#overview';
});

describe('project-first workbench', () => {
  it('creates a browser session only after explicit consent without sending or displaying a credential', async () => {
    const token = 'a'.repeat(64);
    let exchangeCalls = 0;
    let exchangeAuthorization: string | null = null;
    const { fetchMock, tokens } = installFetch(async (path, init) => {
      if (path === '/api/dashboard-session' && init.method === 'POST') {
        exchangeCalls++;
        exchangeAuthorization = new Headers(init.headers).get('Authorization');
        return json({ dashboardToken: token, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() }, 201);
      }
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/workspaces' && init.method === 'POST') return json({ id: '11111111-1111-4111-8111-111111111111', name: 'Storefront', roots: ['/tmp/storefront'], createdAt: '2026-01-01T00:00:00.000Z' }, 201);
      return json({ error: 'Not found.' }, 404);
    });

    sessionStorage.setItem('openworkspace.pairing', 'legacy-manual-key');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect this browser' })).toBeEnabled();
    expect(screen.getByText(/register and remove projects/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pairing key|pairing command|password/i);
    expect(sessionStorage.getItem('openworkspace.pairing')).toBeNull();
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await connectBrowser();
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    expect(screen.getByLabelText('Project name')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose folders…' })).toBeVisible();
    expect(screen.getByText('Add folders manually')).toBeVisible();
    expect(screen.getByLabelText('Absolute repository folder path')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Register project' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Use your AI instead/ })).toHaveAttribute('href', '#setup');
    expect(document.body.textContent).not.toContain(token);
    expect(exchangeCalls).toBe(1);
    expect(exchangeAuthorization).toBeNull();
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBe(token);
    expect(tokens.every(value => value === `Bearer ${token}`)).toBe(true);
    const exchange = fetchMock.mock.calls.find(([input]) => new URL(String(input), window.location.href).pathname === '/api/dashboard-session');
    expect(exchange).toBeDefined();
    expect(new Headers(exchange?.[1]?.headers).get('X-OpenWorkspace-Intent')).toBeNull();
    expect(new Headers(exchange?.[1]?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({ consent: true });
    expect(exchange?.[1]?.credentials).toBe('same-origin');
    expect(screen.getByText(/Bounded metadata is read immediately/i)).toBeInTheDocument();
  });

  it('focuses invalid root lists and preserves the project name and folders after a server failure', async () => {
    let rejectRegistration = false;
    let registrationCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/workspaces' && init.method === 'POST') {
        registrationCalls++;
        return rejectRegistration
          ? json({ error: 'Operation could not complete safely. Check the project name and roots, then retry.' }, 400)
          : json({ id: '22222222-2222-4222-8222-222222222222', name: 'Storefront', roots: ['/tmp/storefront'], createdAt: '2026-01-01T00:00:00.000Z' }, 201);
      }
      return json({ error: 'Not found.' }, 404);
    });
    await connectedEmptyWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.click(screen.getByText('Add folders manually'));

    const name = screen.getByLabelText('Project name') as HTMLInputElement;
    const path = screen.getByLabelText('Absolute repository folder path') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Storefront' } });
    fireEvent.change(path, { target: { value: 'relative/storefront' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByText(/absolute path of 4096 characters or fewer/i)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Repository folders' })).toHaveAttribute('aria-describedby', 'project-roots-error');
    expect(registrationCalls).toBe(0);

    rejectRegistration = true;
    fireEvent.change(path, { target: { value: '/tmp/storefront' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not complete safely/i);
    expect(name).toHaveValue('Storefront');
    expect(screen.getByText('/tmp/storefront')).toBeInTheDocument();
    expect(registrationCalls).toBe(1);
  });

  it('preserves a local project draft on picker cancel, adds selected roots, and registers one exact project', async () => {
    const roots = ['/tmp/unrelated web 🌱', "/private/api's root\nwith newline", '/opt/worker'];
    let pickerCalls = 0;
    let registrationBody: unknown;
    let overviewCalls = 0;
    const submitted: Workspace = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Local services',
      roots: [roots[0], roots[2]],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { fetchMock } = installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return json(overview({ workspaces: registrationBody ? [submitted] : [] }));
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/project-root-picker' && init.method === 'POST') {
        pickerCalls++;
        expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${dashboardToken}`);
        expect(new Headers(init.headers).get('X-OpenWorkspace-Intent')).toBeNull();
        expect(JSON.parse(String(init.body))).toEqual({});
        return pickerCalls === 1
          ? json({ status: 'cancelled' })
          : json({ status: 'selected', roots: [roots[1], roots[2]] });
      }
      if (path === '/api/workspaces' && init.method === 'POST') {
        registrationBody = JSON.parse(String(init.body));
        return json(submitted, 201);
      }
      if (path === `/api/workspaces/${submitted.name}` && init.method === 'GET') {
        return json(inspection(submitted, 'local-service'));
      }
      return json({ error: 'Not found.' }, 404);
    });

    await connectedEmptyWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    const name = screen.getByLabelText('Project name') as HTMLInputElement;
    fireEvent.click(screen.getByText('Add folders manually'));
    const manualPath = screen.getByLabelText('Absolute repository folder path') as HTMLInputElement;
    fireEvent.change(name, { target: { value: submitted.name } });
    fireEvent.change(manualPath, { target: { value: roots[0] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));

    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/Folder selection was cancelled/i)).toBeInTheDocument();
    expect(name).toHaveValue(submitted.name);
    expect(screen.getByText(roots[0])).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input, init]) => new URL(String(input), window.location.href).pathname === '/api/workspaces' && init?.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/2 folders added/i)).toBeInTheDocument();
    expect([...document.querySelectorAll('li')].some(item => item.textContent === roots[1])).toBe(true);
    expect(screen.getByText(roots[2])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder 2' }));
    expect(screen.queryByText(roots[1])).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByRole('heading', { level: 1, name: submitted.name })).toBeInTheDocument();
    expect(registrationBody).toEqual({ name: submitted.name, roots: [roots[0], roots[2]] });
    expect(overviewCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('heading', { name: 'Name the project and choose its repositories' })).not.toBeInTheDocument();
    expect((await screen.findAllByText('local-service')).length).toBeGreaterThan(0);
  });

  it('offers manual root entry when the host-native picker is unavailable without registering a project', async () => {
    let registrationCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/project-root-picker' && init.method === 'POST') return json({ status: 'unavailable' });
      if (path === '/api/workspaces' && init.method === 'POST') { registrationCalls++; return json({ id: 'unexpected' }, 201); }
      return json({ error: 'Not found.' }, 404);
    });
    await connectedEmptyWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Manual project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/native folder picker is unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Absolute repository folder path')).toBeVisible();
    expect(registrationCalls).toBe(0);
  });

  it('keeps the project draft unchanged when the host-native picker reports an aborted selection', async () => {
    let registrationCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/project-root-picker' && init.method === 'POST') return json({ status: 'aborted' });
      if (path === '/api/workspaces' && init.method === 'POST') { registrationCalls++; return json({ id: 'unexpected' }, 201); }
      return json({ error: 'Not found.' }, 404);
    });
    await connectedEmptyWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Aborted project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/Folder selection was stopped/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('Aborted project');
    expect(registrationCalls).toBe(0);
  });

  it('does not restore a removed project from an overview response started before the mutation', async () => {
    const registered: Workspace = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Removed fixture', roots: ['/tmp/removed-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview({ workspaces: [registered] }));
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview());
      }
      if (path === `/api/workspaces/${registered.name}` && init.method === 'DELETE') return json({ removed: true });
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect((await screen.findAllByText(registered.name)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Projects & privacy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Remove project registration for ${registered.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(await screen.findByText('No projects are registered in this browser session.')).toBeInTheDocument();
    expect(screen.queryByText(registered.name)).not.toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview({ workspaces: [registered] })));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(registered.name)).not.toBeInTheDocument();
    expect(overviewCalls).toBe(3);
  });

  it('reconciles a registered workspace and inspects it before the pre-registration overview can return', async () => {
    const registered = workspace('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Registered fixture', '/tmp/registered-fixture');
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    let registrationCalls = 0;
    let inspectionCalls = 0;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview());
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview({ workspaces: [registered] }));
      }
      if (path === '/api/workspaces' && init.method === 'POST') { registrationCalls++; return json(registered, 201); }
      if (path === `/api/workspaces/${registered.name}` && init.method !== 'POST') { inspectionCalls++; return json(inspection(registered, 'registered-service')); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: registered.name } });
    fireEvent.click(screen.getByText('Add folders manually'));
    fireEvent.change(screen.getByLabelText('Absolute repository folder path'), { target: { value: registered.roots[0] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(registrationCalls).toBe(1);
    await waitFor(() => expect(inspectionCalls).toBe(1));
    expect(await screen.findByRole('heading', { name: registered.name })).toBeInTheDocument();
    expect((await screen.findAllByText('registered-service')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Connect your AI to prepare this project' })).toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview()));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: registered.name })).toBeInTheDocument();
    expect(overviewCalls).toBe(3);

    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);
    expect(await screen.findByRole('heading', { name: 'Connect your AI' })).toBeInTheDocument();
    const setupPrompt = screen.getByRole('region', { name: 'Setup prompt preview' });
    expect(setupPrompt).toHaveTextContent(registered.name);
    expect(setupPrompt).toHaveTextContent('workspace_list');
    expect(setupPrompt).toHaveTextContent('workspace_inspect');
    expect(setupPrompt).toHaveTextContent('mcpServers');
    expect(setupPrompt).toHaveTextContent('OPENWORKSPACE_HOME');
    expect(setupPrompt).toHaveTextContent('What to do (one pass):');
    expect(setupPrompt).toHaveTextContent('Step 6 — Handoff');
    expect(setupPrompt.textContent).not.toContain(registered.roots[0]);
    expect(screen.getByRole('button', { name: 'Copy setup prompt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy setup request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy MCP configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy onboarding request' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('details')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(setupPrompt.textContent);
    expect(await screen.findByText('Copied the setup prompt. Paste it to your assistant; the dashboard records what ran.')).toBeInTheDocument();
  });

  it('asks for a confirming refresh when registration succeeds but the follow-up refresh fails', async () => {
    const registered = workspace('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Partially refreshed fixture', '/tmp/partially-refreshed');
    let overviewCalls = 0;
    let registrationCalls = 0;
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return overviewCalls === 2
          ? json({ error: 'The overview refresh is temporarily unavailable.' }, 503)
          : json(overview({ workspaces: overviewCalls >= 3 ? [registered] : [] }));
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/workspaces' && init.method === 'POST') {
        registrationCalls++;
        return json(registered, 201);
      }
      if (path === `/api/workspaces/${registered.name}` && init.method !== 'POST') {
        inspectionCalls++;
        return json(inspection(registered, 'confirmed-registered-service'));
      }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: registered.name } });
    fireEvent.click(screen.getByText('Add folders manually'));
    fireEvent.change(screen.getByLabelText('Absolute repository folder path'), { target: { value: registered.roots[0] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));

    await waitFor(() => expect(overviewCalls).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Name the project and choose its repositories' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: registered.name })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start with a project' })).toBeInTheDocument();
    expect(registrationCalls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
    expect(await screen.findByRole('heading', { level: 1, name: registered.name })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Project inventory' })).toBeInTheDocument();
    expect((await screen.findAllByText('confirmed-registered-service')).length).toBeGreaterThan(0);
    expect(screen.getByText('Workspace refreshed.')).toBeInTheDocument();
    expect(overviewCalls).toBe(3);
    expect(inspectionCalls).toBeGreaterThanOrEqual(1);
  });

  it('does not show a registered workspace when the registration POST fails', async () => {
    const name = 'Rejected registration fixture';
    const root = '/tmp/rejected-registration';
    let overviewCalls = 0;
    let registrationCalls = 0;
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return json(overview());
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/workspaces' && init.method === 'POST') {
        registrationCalls++;
        return json({ error: 'The registration could not be confirmed.' }, 500);
      }
      if (path === '/api/workspaces/abababab-abab-4bab-8bab-abababababab' && init.method !== 'POST') inspectionCalls++;
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: name } });
    fireEvent.click(screen.getByText('Add folders manually'));
    fireEvent.change(screen.getByLabelText('Absolute repository folder path'), { target: { value: root } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The registration could not be confirmed.');
    expect(screen.getByRole('heading', { name: 'Name the project and choose its repositories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register project' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project inventory' })).not.toBeInTheDocument();
    expect(registrationCalls).toBe(1);
    expect(overviewCalls).toBe(2);
    expect(inspectionCalls).toBe(0);
  });

  it('renders same-basename roots as separate groups and keeps healthy roots visible when one is unavailable', async () => {
    const roots = ['/tmp/first/services', '/opt/second/services', '/mnt/third/offline'];
    const approved = workspace('abababab-abab-4bab-8bab-abababababab', 'Grouped project', roots);
    const repository = (name: string, path: string) => ({
      name,
      path,
      git: true,
      stack: ['Node.js'],
      manifests: ['package.json'],
      instructions: [],
      scriptNames: [],
      composeFiles: [],
      processState: 'not_connected' as const,
      readiness: 'not_checked' as const,
    });
    const groupedInspection = {
      workspace: approved,
      target: { id: 'local' as const, kind: 'local' as const },
      roots: [
        { path: roots[0], repositories: [repository('web', `${roots[0]}/web`)], warnings: [], unavailable: false },
        { path: roots[1], repositories: [repository('api', `${roots[1]}/api`)], warnings: [], unavailable: false },
        { path: roots[2], repositories: [], warnings: [], unavailable: true, error: 'This registered root is unavailable or its directory identity changed.' },
      ],
    };
    let overviewCalls = 0;
    let removeCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        return overviewCalls === 1 ? json(overview({ workspaces: [approved] })) : json(overview());
      }
      if (path === `/api/workspaces/${approved.name}` && init.method === 'GET') return json(groupedInspection);
      if (path === `/api/workspaces/${approved.name}` && init.method === 'DELETE') { removeCalls++; return json({ removed: true }); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(approved.name) }));

    expect((await screen.findAllByRole('heading', { name: 'services', level: 3 })).length).toBe(2);
    expect(screen.getAllByText(roots[0]).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(roots[1]).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(roots[2]).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('web').length).toBeGreaterThan(0);
    expect(screen.getAllByText('api').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');

    fireEvent.click(screen.getAllByRole('link', { name: 'Projects' })[0]);
    expect(await screen.findByRole('heading', { name: 'Choose a project' })).toBeInTheDocument();
    const connectedProjects = screen.getByRole('region', { name: 'Choose a project' });
    const choice = within(connectedProjects).getByRole('button', { name: /Grouped project/ });
    expect(choice).toHaveTextContent('first/services');
    expect(choice).toHaveTextContent('second/services');

    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Projects & privacy' })).toBeInTheDocument();
    expect(screen.getAllByText(roots[0]).length).toBeGreaterThan(0);
    expect(screen.getAllByText(roots[1]).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: `Remove project registration for ${approved.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(2));
    expect(removeCalls).toBe(1);
    expect(document.body.textContent).not.toContain(roots[0]);
    expect(document.body.textContent).not.toContain(roots[1]);
  });

  it('keeps PM2 service inventory readable without exposing lifecycle controls', async () => {
    const approved = workspace('11111111-1111-4111-8111-111111111111', 'Service fixture', '/tmp/service-fixture');
    const inspection = {
      workspace: approved,
      target: { id: 'local' as const, kind: 'local' as const },
      roots: [],
    };
    const serviceInventory = {
      inspectedAt: '2026-10-02T00:00:00.000Z',
      runner: 'pm2' as const,
      available: true,
      processCount: 3,
      matchedProcessCount: 1,
      unmatchedProcessCount: 2,
      services: [{ name: 'worker', pmId: 4, namespace: 'default', status: 'online', cwd: '/tmp/service-fixture/worker', restartCount: 2, matchedRoots: ['/tmp/service-fixture'], exactRootPath: '/tmp/service-fixture' }],
      ambiguousServices: [],
    };
    let servicesCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === `/api/workspaces/${approved.name}` && init.method === 'GET') return json(inspection);
      if (path === `/api/workspaces/${approved.name}/services` && init.method === 'POST') { servicesCalls++; return json(serviceInventory); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: /Service fixture/ }));

    expect(await screen.findByText('Inspect services')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect services' }));

    expect(await screen.findByText('worker')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText(/Working directory: \/tmp\/service-fixture\/worker/)).toBeInTheDocument();
    expect(screen.queryByText(/no runtime was started or checked/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only PM2 process metadata/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart worker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop worker' })).not.toBeInTheDocument();
    expect(screen.getByText(/3 local processes scanned/)).toBeInTheDocument();
    expect(servicesCalls).toBe(1);
  });

  it('keeps repository inventory visible without a dashboard test runner', async () => {
    const approved = workspace('22222222-2222-4222-8222-222222222222', 'Verify fixture', '/tmp/verify-fixture');
    const nodeInspection = {
      workspace: approved,
      target: { id: 'local' as const, kind: 'local' as const },
      roots: [{
        path: '/tmp/verify-fixture',
        repositories: [{
          name: 'web',
          path: '/tmp/verify-fixture/web',
          git: true,
          stack: ['Node.js'],
          manifests: ['package.json'],
          instructions: [],
          scriptNames: ['check'],
          composeFiles: [],
          processState: 'not_connected' as const,
          readiness: 'not_checked' as const,
        }],
        warnings: [],
        unavailable: false,
      }],
    };
    let verificationCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === `/api/workspaces/${approved.name}` && init.method === 'GET') return json(nodeInspection);
      if (path === `/api/workspaces/${approved.name}/verify` && init.method === 'POST') { verificationCalls++; return json({}); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: /Verify fixture/ }));

    expect(await screen.findByRole('heading', { name: 'Project inventory' })).toBeInTheDocument();
    expect(screen.getAllByText('web').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Run repository test/ })).not.toBeInTheDocument();
    expect(verificationCalls).toBe(0);
  });

  it('shows a concise workstream empty state without operation controls', async () => {
    const approved = workspace('33333333-3333-4333-8333-333333333333', 'Empty stream fixture', '/tmp/empty-stream-fixture');
    const streamInspection = {
      workspace: approved,
      target: { id: 'local' as const, kind: 'local' as const },
      roots: [{ path: '/tmp/empty-stream-fixture', repositories: [], warnings: [], unavailable: false }],
    };
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === `/api/workspaces/${approved.name}` && init.method === 'GET') return json(streamInspection);
      if (path === '/api/workstreams' && init.method === 'GET') return json([]);
      if (path === '/api/leases' && init.method === 'GET') return json([]);
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: /Empty stream fixture/ }));

    const workstreamsRegion = await screen.findByRole('region', { name: 'Workstreams' });
    expect(within(workstreamsRegion).getByText('No workstreams have been recorded for this project.')).toBeInTheDocument();
    expect(within(workstreamsRegion).queryByRole('button')).not.toBeInTheDocument();
    expect(within(workstreamsRegion).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps workstream and lease records readable without operation controls', async () => {
    const approved = workspace('33333333-3333-4333-8333-333333333333', 'Stream fixture', ['/tmp/stream-a', '/tmp/stream-b']);
    const streamInspection = {
      workspace: approved,
      target: { id: 'local' as const, kind: 'local' as const },
      roots: ['/tmp/stream-a', '/tmp/stream-b'].map(path => ({ path, repositories: [], warnings: [], unavailable: false })),
    };
    const workstreams = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Group A',
        workspaceId: approved.id,
        status: 'active',
        checkouts: [{ root: '/tmp/stream-a', revision: 'a'.repeat(40), revisionState: 'observed', observedAt: '2026-10-02T00:00:00.000Z' }],
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Group B',
        workspaceId: approved.id,
        status: 'paused',
        checkouts: [{ root: '/tmp/stream-b', revision: null, revisionState: 'unknown', observedAt: '2026-10-02T00:00:00.000Z' }],
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    ];
    const leases = [
      { resource: 'port:3000', workstreamId: workstreams[0].id, status: 'held', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
      { resource: 'port:3000', workstreamId: workstreams[1].id, status: 'queued', createdAt: '2026-10-02T00:01:00.000Z', updatedAt: '2026-10-02T00:01:00.000Z' },
    ];
    let mutationCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === `/api/workspaces/${approved.name}` && init.method === 'GET') return json(streamInspection);
      if (path === '/api/workstreams' && init.method === 'GET') return json(workstreams);
      if (path === '/api/leases' && init.method === 'GET') return json(leases);
      if (path.startsWith('/api/workstreams') || path.startsWith('/api/leases')) mutationCalls++;
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: /Stream fixture/ }));

    const workstreamsRegion = await screen.findByRole('region', { name: 'Workstreams' });
    expect(within(workstreamsRegion).getByText('Group A')).toBeInTheDocument();
    expect(within(workstreamsRegion).getByText('active')).toBeInTheDocument();
    expect(within(workstreamsRegion).getByText(/rev a{12}…/)).toBeInTheDocument();
    expect(within(workstreamsRegion).getByText(/port:3000 · held/)).toBeInTheDocument();
    expect(within(workstreamsRegion).getByText(/port:3000 · queued \(position 1\)/)).toBeInTheDocument();
    expect(within(workstreamsRegion).queryByRole('button')).not.toBeInTheDocument();
    expect(within(workstreamsRegion).queryByRole('textbox')).not.toBeInTheDocument();
    expect(mutationCalls).toBe(0);
  });

  it('records dashboard and assistant operations in the AI setup activity trail', async () => {
    const registered = workspace('55555555-5555-4555-8555-555555555555', 'Activity fixture', '/tmp/activity-fixture');
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') return json(overview({ workspaces: [registered] }));
      if (path === '/api/activity' && init.method === 'GET') {
        return json([
          { at: '2026-10-02T00:00:00.000Z', actor: 'dashboard', operation: 'register', workspaceId: registered.id, detail: 'Activity fixture' },
          { at: '2026-10-02T00:01:00.000Z', actor: 'mcp', operation: 'verify', workspaceId: registered.id, detail: 'check → passed' },
        ]);
      }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);

    expect(await screen.findByText('What ran here')).toBeInTheDocument();
    const trail = screen.getByRole('heading', { name: 'What ran here' }).closest('section')!;
    expect(within(trail).getByText('register')).toBeInTheDocument();
    expect(within(trail).getByText('verify')).toBeInTheDocument();
    expect(within(trail).getByText('you')).toBeInTheDocument();
    expect(within(trail).getByText('assistant')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(registered.roots[0]);
  });

  it('does not restore removed registration or selected inventory from a pre-removal refresh', async () => {
    const registered = workspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Removal fixture', '/tmp/removal-fixture');
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview({ workspaces: [registered] }));
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview());
      }
      if (path === `/api/workspaces/${registered.name}` && init.method === 'GET') return json(inspection(registered, 'old-sentinel-service'));
      if (path === `/api/workspaces/${registered.name}` && init.method === 'DELETE') return json({ removed: true });
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(registered.name) }));
    expect((await screen.findAllByText('old-sentinel-service')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Projects & privacy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Remove project registration for ${registered.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(await screen.findByText('No projects are registered in this browser session.')).toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview({ workspaces: [registered] })));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(registered.name);
    expect(document.body.textContent).not.toContain('old-sentinel-service');
    expect(screen.queryByRole('button', { name: `Remove project registration for ${registered.name}` })).not.toBeInTheDocument();
  });

  it('clears private state on disconnect and ignores old-session inventory and 401 responses after same-origin reconnect', async () => {
    const previous = workspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Old identity fixture', '/tmp/old-identity');
    const current = workspace('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'New identity fixture', '/tmp/new-identity');
    const oldDashboardToken = 'b'.repeat(64);
    const rejectedDashboardToken = 'e'.repeat(64);
    const newDashboardToken = 'c'.repeat(64);
    const oldInspection = deferred<Response>();
    const oldInspectionStarted = deferred<void>();
    const oldOverview = deferred<Response>();
    const oldOverviewStarted = deferred<void>();
    const oldLogout = deferred<Response>();
    const oldLogoutStarted = deferred<void>();
    let oldInspectionCalls = 0;
    let overviewCalls = 0;
    let dashboardConnectCalls = 0;
    let disconnectCalls = 0;
    let expireNewSession = false;
    const origins: string[] = [];
    const tokens: string[] = [];
    const connectionAuthorizations: (string | null)[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), window.location.href);
      origins.push(url.origin);
      const bearer = new Headers(init.headers).get('Authorization');
      if (bearer) tokens.push(bearer);
      const path = decodeURI(url.pathname);
      if (url.pathname === '/api/dashboard-session' && init.method === 'POST') {
        dashboardConnectCalls++;
        connectionAuthorizations.push(bearer);
        const token = dashboardConnectCalls === 1 ? rejectedDashboardToken : newDashboardToken;
        return json({ dashboardToken: token, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() }, 201);
      }
      if (url.pathname === '/api/dashboard-session' && init.method === 'DELETE') {
        disconnectCalls++;
        oldLogoutStarted.resolve();
        return oldLogout.promise;
      }
      if (url.pathname === '/api/client-config') {
        return bearer === `Bearer ${newDashboardToken}`
          ? json({ mcpServers: { openworkspace: { command: '/usr/bin/node', args: ['MCP_CONFIG_SENTINEL'], env: { OPENWORKSPACE_HOME: '/tmp/fixture-state-b' } } } })
          : json(clientConfig);
      }
      if (url.pathname === '/api/overview') {
        overviewCalls++;
        if (bearer === `Bearer ${oldDashboardToken}`) {
          if (overviewCalls === 1) return json(overview({ workspaces: [previous] }));
          oldOverviewStarted.resolve();
          return oldOverview.promise.then(result => result);
        }
        if (bearer === `Bearer ${rejectedDashboardToken}`) return json({ error: 'Dashboard session expired.' }, 401);
        if (bearer === `Bearer ${newDashboardToken}`) {
          if (expireNewSession) return json({ error: 'Dashboard session expired.' }, 401);
          return json(overview({ workspaces: [current] }));
        }
        return json({ error: 'Connect this browser.' }, 401);
      }
      if (path === `/api/workspaces/${previous.name}` && init.method !== 'POST') {
        oldInspectionCalls++;
        if (oldInspectionCalls === 1) return json(inspection(previous, 'old-sentinel-repository'));
        oldInspectionStarted.resolve();
        return oldInspection.promise;
      }
      if (path === `/api/workspaces/${current.name}` && init.method !== 'POST') return json(inspection(current, 'new-sentinel-repository'));
      return json({ error: 'Not found.' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem(dashboardSessionStorageKey, oldDashboardToken);
    sessionStorage.setItem('openworkspace.pairing', 'legacy-manual-key');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Workspace rail' });
    const oldProject = within(rail).getByRole('button', { name: new RegExp(previous.name) });
    fireEvent.click(oldProject);
    expect((await screen.findAllByText('old-sentinel-repository')).length).toBeGreaterThan(0);

    fireEvent.click(oldProject);
    await waitFor(() => expect(oldInspectionCalls).toBe(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    await oldOverviewStarted.promise;
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect this browser tab' }));
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(previous.name);
    expect(document.body.textContent).not.toContain(previous.roots[0]);
    expect(document.body.textContent).not.toContain('old-sentinel-repository');
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();
    expect(sessionStorage.getItem('openworkspace.pairing')).toBeNull();
    expect(disconnectCalls).toBe(1);
    await oldLogoutStarted.promise;

    await connectBrowser();
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect this browser' })).toBeEnabled());
    expect(document.body.textContent).not.toContain(previous.name);
    expect(document.body.textContent).not.toContain(previous.roots[0]);
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();

    await connectBrowser();
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getAllByText(current.name).length).toBeGreaterThan(0);
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBe(newDashboardToken);
    expect(connectionAuthorizations).toEqual([null, null]);

    await act(async () => {
      oldLogout.resolve(new Response(null, { status: 204 }));
      oldInspection.resolve(json(inspection(previous, 'old-sentinel-repository')));
      oldOverview.resolve(json({ error: 'Expired.' }, 401));
      await Promise.all([oldInspectionStarted.promise, oldOverviewStarted.promise, oldLogoutStarted.promise]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(current.name);
    expect(document.body.textContent).not.toContain(previous.name);
    expect(document.body.textContent).not.toContain(previous.roots[0]);
    expect(document.body.textContent).not.toContain('old-sentinel-repository');
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBe(newDashboardToken);
    expect(origins.length > 0 && origins.every(origin => origin === window.location.origin)).toBe(true);
    expect(tokens.includes(`Bearer ${oldDashboardToken}`) && tokens.includes(`Bearer ${newDashboardToken}`)).toBe(true);

    const currentRail = screen.getByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(currentRail).getByRole('button', { name: new RegExp(current.name) }));
    expect((await screen.findAllByText('new-sentinel-repository')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);
    const newSetupRequest = await screen.findByRole('region', { name: 'Setup prompt preview' });
    expect(newSetupRequest).toHaveTextContent('MCP_CONFIG_SENTINEL');
    expect(newSetupRequest).toHaveTextContent(current.name);
    expect(newSetupRequest.textContent).not.toContain(current.roots[0]);

    expireNewSession = true;
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(current.name);
    expect(document.body.textContent).not.toContain(current.roots[0]);
    expect(document.body.textContent).not.toContain('new-sentinel-repository');
    expect(document.body.textContent).not.toContain('MCP_CONFIG_SENTINEL');
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();
    expect(dashboardConnectCalls).toBe(2);
  });

  it('clears local project state on disconnect for 204 and unreachable-service responses', async () => {
    const first = workspace('12121212-1212-4212-8212-121212121212', 'First session fixture', '/tmp/first-session');
    const second = workspace('34343434-3434-4434-8434-343434343434', 'Second session fixture', '/tmp/second-session');
    const firstToken = '1'.repeat(64);
    const secondToken = '2'.repeat(64);
    let disconnectCalls = 0;
    installFetch(async (path, init) => {
      const bearer = new Headers(init.headers).get('Authorization');
      if (path === '/api/dashboard-session' && init.method === 'POST') {
        return json({ dashboardToken: secondToken, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() }, 201);
      }
      if (path === '/api/dashboard-session' && init.method === 'DELETE') {
        disconnectCalls++;
        if (disconnectCalls === 1) return new Response(null, { status: 204 });
        return Promise.reject(new TypeError('Local service unavailable.'));
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        if (bearer === `Bearer ${firstToken}`) return json(overview({ workspaces: [first] }));
        if (bearer === `Bearer ${secondToken}`) return json(overview({ workspaces: [second] }));
        return json({ error: 'Connect this browser.' }, 401);
      }
      if (path === `/api/workspaces/${first.name}` && init.method === 'GET') return json(inspection(first, 'first-session-service'));
      if (path === `/api/workspaces/${second.name}` && init.method === 'GET') return json(inspection(second, 'second-session-service'));
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, firstToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(first.name) }));
    expect((await screen.findAllByText('first-session-service')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Projects & privacy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect this browser tab' }));

    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(first.name);
    expect(document.body.textContent).not.toContain('first-session-service');
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();

    await connectBrowser();
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const secondRail = screen.getByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(secondRail).getByRole('button', { name: new RegExp(second.name) }));
    expect(await screen.findByRole('heading', { level: 1, name: second.name })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Projects & privacy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect this browser tab' }));
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(second.name);
    expect(document.body.textContent).not.toContain('second-session-service');
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBeNull();
    expect(disconnectCalls).toBe(2);
  });

  it('keeps the last confirmed inventory mounted and focused through a same-project refresh', async () => {
    const approved = workspace('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Smooth refresh fixture', '/tmp/smooth-refresh');
    const update = deferred<Response>();
    const updateStarted = deferred<void>();
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === '/api/client-config') return json(clientConfig);
      if (path === `/api/workspaces/${approved.name}` && init.method !== 'POST') {
        inspectionCalls++;
        if (inspectionCalls === 1) return json(inspection(approved, 'last-confirmed-service'));
        updateStarted.resolve();
        return update.promise;
      }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(approved.name) }));
    expect((await screen.findAllByText('last-confirmed-service')).length).toBeGreaterThan(0);

    const inventoryHeading = screen.getByRole('heading', { name: 'Project inventory' });
    const inventoryRegion = screen.getByRole('region', { name: 'Scrollable repository inventory for /tmp/smooth-refresh' });
    inventoryRegion.focus();
    const refreshButton = screen.getByRole('button', { name: 'Refresh workspace' });
    fireEvent.click(refreshButton);
    await updateStarted.promise;
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Updating registered metadata'));

    expect(screen.getByRole('heading', { name: 'Project inventory' })).toBe(inventoryHeading);
    expect(screen.getAllByText('last-confirmed-service').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Refreshing workspace' })).toBe(refreshButton);
    expect(refreshButton).toHaveAttribute('aria-disabled', 'true');
    expect(refreshButton).toHaveAttribute('aria-busy', 'true');
    expect(document.activeElement).toBe(inventoryRegion);

    await act(async () => update.resolve(json(inspection(approved, 'refreshed-service'))));
    expect((await screen.findAllByText('refreshed-service')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Project inventory' })).toBe(inventoryHeading);
    expect(screen.queryAllByText('last-confirmed-service')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBe(refreshButton);
    expect(refreshButton).toHaveAttribute('aria-disabled', 'false');
    expect(document.activeElement).toBe(inventoryRegion);
  });

  it('returns to all projects from navigation and never restores a late inspection after unselecting', async () => {
    const approved = workspace('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Unselect fixture', '/tmp/unselect-fixture');
    const lateInspection = deferred<Response>();
    const lateStarted = deferred<void>();
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview({ workspaces: [approved] }));
      if (path === '/api/client-config') return json(clientConfig);
      if (path === `/api/workspaces/${approved.name}` && init.method !== 'POST') {
        inspectionCalls++;
        if (inspectionCalls === 1) return json(inspection(approved, 'confirmed-service'));
        if (inspectionCalls === 2) {
          lateStarted.resolve();
          return lateInspection.promise;
        }
        return json(inspection(approved, 'selected-again-service'));
      }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Workspace rail' });
    const railProject = within(rail).getByRole('button', { name: new RegExp(approved.name) });
    fireEvent.click(railProject);
    expect((await screen.findAllByText('confirmed-service')).length).toBeGreaterThan(0);

    fireEvent.click(railProject);
    await lateStarted.promise;
    fireEvent.click(screen.getAllByRole('link', { name: 'Projects' })[0]);
    expect(await screen.findByRole('heading', { name: 'Choose a project' })).toBeInTheDocument();
    expect(railProject).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('heading', { name: 'Project inventory' })).not.toBeInTheDocument();

    await act(async () => lateInspection.resolve(json(inspection(approved, 'stale-service'))));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose a project' })).toBeInTheDocument();
    expect(screen.queryAllByText('stale-service')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Project inventory' })).not.toBeInTheDocument();
    expect(railProject).toHaveAttribute('aria-pressed', 'false');

    const connectedProjects = screen.getByRole('region', { name: 'Choose a project' });
    fireEvent.click(within(connectedProjects).getByRole('button', { name: new RegExp(approved.name) }));
    expect((await screen.findAllByText('selected-again-service')).length).toBeGreaterThan(0);
    const selector = screen.getByLabelText('Select a connected project') as HTMLSelectElement;
    expect(selector).toHaveValue(approved.name);
    fireEvent.change(selector, { target: { value: '' } });
    expect(await screen.findByRole('heading', { name: 'Choose a project' })).toBeInTheDocument();
    expect(selector).toHaveValue('');
    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);
    const genericSetupRequest = await screen.findByRole('region', { name: 'Setup prompt preview' });
    expect(genericSetupRequest).toHaveTextContent('workspace_list first');
    expect(genericSetupRequest).toHaveTextContent('workspace_register with {name, roots}');
    expect(genericSetupRequest.textContent).not.toContain(approved.name);
    expect(genericSetupRequest.textContent).not.toContain(approved.name);
    expect(genericSetupRequest.textContent).not.toContain(approved.roots[0]);
  });
});
