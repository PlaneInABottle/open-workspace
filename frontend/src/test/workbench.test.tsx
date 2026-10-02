import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { dashboardSessionStorageKey } from '../api';
import type { ClientConfig, Overview, Proposal, Workspace } from '../api';

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
    version: 2,
    proposals: [],
    workspaces: [],
    capabilities: [],
    milestone: 'M0 · read-only foundation',
    limits: ['No secrets are read', 'No application is started', 'No tools are installed'],
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
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    origins.push(url.origin);
    const token = new Headers(init.headers).get('Authorization');
    if (token) tokens.push(token);
    return handler(url.pathname, init);
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
      if (path === '/api/proposals' && init.method === 'POST') return json({ id: 'proposal-id', name: 'Storefront', roots: ['/tmp/storefront'], createdAt: '2026-01-01T00:00:00.000Z' }, 201);
      return json({ error: 'Not found.' }, 404);
    });

    sessionStorage.setItem('openworkspace.pairing', 'legacy-manual-key');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Connect to your local workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect this browser' })).toBeEnabled();
    expect(screen.getByText(/does not approve a project or any of its repository folders/i)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Request project access' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Use your AI instead/ })).toHaveAttribute('href', '#setup');
    expect(document.body.textContent).not.toContain(token);
    expect(exchangeCalls).toBe(1);
    expect(exchangeAuthorization).toBeNull();
    expect(sessionStorage.getItem(dashboardSessionStorageKey)).toBe(token);
    expect(tokens.every(value => value === `Bearer ${token}`)).toBe(true);
    const exchange = fetchMock.mock.calls.find(([input]) => new URL(String(input), window.location.href).pathname === '/api/dashboard-session');
    expect(exchange).toBeDefined();
    expect(new Headers(exchange?.[1]?.headers).get('X-OpenWorkspace-Intent')).toBe('connect-dashboard');
    expect(new Headers(exchange?.[1]?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({ consent: true });
    expect(exchange?.[1]?.credentials).toBe('same-origin');
    expect(screen.getByText(/nothing is read until you approve the complete request/i)).toBeInTheDocument();
  });

  it('focuses invalid root lists and preserves the project name and folders after a server failure', async () => {
    let rejectProposal = false;
    let proposalCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/proposals' && init.method === 'POST') {
        proposalCalls++;
        return rejectProposal
          ? json({ error: 'Operation could not complete safely. Check the project name and roots, then retry.' }, 400)
          : json({ id: 'proposal-id', name: 'Storefront', roots: ['/tmp/storefront'], createdAt: '2026-01-01T00:00:00.000Z' }, 201);
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
    expect(proposalCalls).toBe(0);

    rejectProposal = true;
    fireEvent.change(path, { target: { value: '/tmp/storefront' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request project access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not complete safely/i);
    expect(name).toHaveValue('Storefront');
    expect(screen.getByText('/tmp/storefront')).toBeInTheDocument();
    expect(proposalCalls).toBe(1);
  });

  it('preserves a local project draft on picker cancel, adds selected roots, and submits one exact proposal', async () => {
    const roots = ['/tmp/unrelated web 🌱', "/private/api's root\nwith newline", '/opt/worker'];
    let pickerCalls = 0;
    let proposalBody: unknown;
    let overviewCalls = 0;
    const submitted: Proposal = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Local services',
      roots: [roots[0], roots[2]],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { fetchMock } = installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return json(overview({ proposals: proposalBody ? [submitted] : [] }));
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/project-root-picker' && init.method === 'POST') {
        pickerCalls++;
        expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${dashboardToken}`);
        expect(new Headers(init.headers).get('X-OpenWorkspace-Intent')).toBe('select-project-roots');
        expect(JSON.parse(String(init.body))).toEqual({});
        return pickerCalls === 1
          ? json({ status: 'cancelled' })
          : json({ status: 'selected', roots: [roots[1], roots[2]] });
      }
      if (path === '/api/proposals' && init.method === 'POST') {
        proposalBody = JSON.parse(String(init.body));
        return json(submitted, 201);
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
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input), window.location.href).pathname === '/api/proposals')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/2 folders added/i)).toBeInTheDocument();
    expect([...document.querySelectorAll('li')].some(item => item.textContent === roots[1])).toBe(true);
    expect(screen.getByText(roots[2])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder 2' }));
    expect(screen.queryByText(roots[1])).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request project access' }));
    expect(await screen.findByRole('region', { name: 'Waiting for your approval' })).toBeInTheDocument();
    expect(proposalBody).toEqual({ name: submitted.name, roots: [roots[0], roots[2]] });
    expect(overviewCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('heading', { name: 'Name the project and choose its repositories' })).not.toBeInTheDocument();
  });

  it('offers manual root entry when the host-native picker is unavailable without posting a proposal', async () => {
    let proposalCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') return json(overview());
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/project-root-picker' && init.method === 'POST') return json({ status: 'unavailable' });
      if (path === '/api/proposals' && init.method === 'POST') { proposalCalls++; return json({ id: 'unexpected' }, 201); }
      return json({ error: 'Not found.' }, 404);
    });
    await connectedEmptyWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Manual project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose folders…' }));
    expect(await screen.findByText(/native folder picker is unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Absolute repository folder path')).toBeVisible();
    expect(proposalCalls).toBe(0);
  });

  it('does not restore a declined request from an overview response started before the mutation', async () => {
    const proposal: Proposal = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Decline fixture', roots: ['/tmp/decline-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview({ proposals: [proposal] }));
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview());
      }
      if (path === `/api/proposals/${proposal.id}/reject` && init.method === 'POST') return json({ rejected: true });
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByText(proposal.name)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: `Decline project request for ${proposal.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(await screen.findByText('Project access request declined.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Waiting for your approval' })).not.toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview({ proposals: [proposal] })));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(proposal.name)).not.toBeInTheDocument();
    expect(overviewCalls).toBe(3);
  });

  it('reconciles an approved workspace and inspects it before the pre-approval overview can return', async () => {
    const proposal: Proposal = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Approved fixture', roots: ['/tmp/approved-fixture'], createdAt: '2026-01-01T00:00:00.000Z' };
    const approved = workspace(proposal.id, proposal.name, proposal.roots);
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    let approveCalls = 0;
    let inspectionCalls = 0;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview({ proposals: [proposal] }));
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview({ workspaces: [approved] }));
      }
      if (path === `/api/proposals/${proposal.id}/approve` && init.method === 'POST') { approveCalls++; return json(approved); }
      if (path === `/api/workspaces/${approved.id}` && init.method !== 'POST') { inspectionCalls++; return json(inspection(approved, 'approved-service')); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByText(proposal.name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: `Approve project access for ${proposal.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(approveCalls).toBe(1);
    await waitFor(() => expect(inspectionCalls).toBe(1));
    expect(await screen.findByRole('heading', { name: proposal.name })).toBeInTheDocument();
    expect((await screen.findAllByText('approved-service')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Connect your AI to prepare this project' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Waiting for your approval' })).not.toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview({ proposals: [proposal] })));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: proposal.name })).toBeInTheDocument();
    expect(screen.queryByText(proposal.name, { selector: 'li h3' })).not.toBeInTheDocument();
    expect(overviewCalls).toBe(3);

    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);
    expect(await screen.findByRole('heading', { name: 'Connect your AI' })).toBeInTheDocument();
    const setupRequest = screen.getByRole('region', { name: 'Setup request preview' });
    expect(setupRequest).toHaveTextContent(approved.id);
    expect(setupRequest).toHaveTextContent('Verify the MCP connection with workspace_list');
    expect(setupRequest).toHaveTextContent('workspace_inspect and onboarding_plan');
    expect(setupRequest).toHaveTextContent('mcpServers');
    expect(setupRequest).toHaveTextContent('OPENWORKSPACE_HOME');
    expect(setupRequest.textContent).not.toContain(approved.name);
    expect(setupRequest.textContent).not.toContain(approved.roots[0]);
    expect(screen.getByRole('button', { name: 'Copy setup request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy MCP configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy onboarding request' })).not.toBeInTheDocument();
    expect([...document.querySelectorAll('details')].every(details => !details.open)).toBe(true);
    const clientDocLinks = [...document.querySelectorAll<HTMLAnchorElement>('details a[target="_blank"]')];
    expect(clientDocLinks).toHaveLength(4);
    expect(clientDocLinks.every(link => link.rel.includes('noreferrer'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup request' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(setupRequest.textContent);
    expect(await screen.findByText('Copied the setup request. Review the proposed client configuration before applying it.')).toBeInTheDocument();
  });

  it('shows a confirmed approval and inspected inventory when the follow-up workspace refresh fails', async () => {
    const proposal: Proposal = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Partially refreshed fixture', roots: ['/tmp/partially-refreshed'], createdAt: '2026-01-01T00:00:00.000Z' };
    const approved = workspace(proposal.id, proposal.name, proposal.roots);
    let overviewCalls = 0;
    let clientConfigCalls = 0;
    let approveCalls = 0;
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return overviewCalls === 1
          ? json(overview({ proposals: [proposal] }))
          : json({ error: 'The overview refresh is temporarily unavailable.' }, 503);
      }
      if (path === '/api/client-config') {
        clientConfigCalls++;
        return clientConfigCalls === 1
          ? json(clientConfig)
          : json({ error: 'The configuration refresh is temporarily unavailable.' }, 503);
      }
      if (path === `/api/proposals/${proposal.id}/approve` && init.method === 'POST') {
        approveCalls++;
        return json(approved);
      }
      if (path === `/api/workspaces/${approved.id}` && init.method !== 'POST') {
        inspectionCalls++;
        return json(inspection(approved, 'confirmed-approved-service'));
      }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByText(proposal.name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Approve project access for ${proposal.name}` }));

    expect(await screen.findByRole('heading', { level: 1, name: proposal.name })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Project inventory' })).toBeInTheDocument();
    expect((await screen.findAllByText('confirmed-approved-service')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Waiting for your approval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Approve project access for ${proposal.name}` })).not.toBeInTheDocument();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Project access was approved');
    expect(alert).toHaveTextContent('The approved roots are shown from the approval response');
    expect(alert).toHaveTextContent('refresh to confirm the current state');
    expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled();
    expect(approveCalls).toBe(1);
    expect(overviewCalls).toBe(2);
    expect(clientConfigCalls).toBe(2);
    expect(inspectionCalls).toBe(1);
  });

  it('does not show an approved workspace when the approval POST fails', async () => {
    const proposal: Proposal = { id: 'abababab-abab-4bab-8bab-abababababab', name: 'Rejected approval fixture', roots: ['/tmp/rejected-approval'], createdAt: '2026-01-01T00:00:00.000Z' };
    let overviewCalls = 0;
    let approveCalls = 0;
    let inspectionCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/overview') {
        overviewCalls++;
        return json(overview({ proposals: [proposal] }));
      }
      if (path === '/api/client-config') return json(clientConfig);
      if (path === `/api/proposals/${proposal.id}/approve` && init.method === 'POST') {
        approveCalls++;
        return json({ error: 'The approval could not be confirmed.' }, 500);
      }
      if (path === `/api/workspaces/${proposal.id}` && init.method !== 'POST') inspectionCalls++;
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    expect(await screen.findByText(proposal.name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Approve project access for ${proposal.name}` }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The approval could not be confirmed.');
    expect(screen.getByRole('heading', { name: 'Waiting for your approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Approve project access for ${proposal.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: proposal.name })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project inventory' })).not.toBeInTheDocument();
    expect(approveCalls).toBe(1);
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
        { path: roots[2], repositories: [], warnings: [], unavailable: true, error: 'This approved root is unavailable or its directory identity changed.' },
      ],
    };
    let overviewCalls = 0;
    let revokeCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        return overviewCalls === 1 ? json(overview({ workspaces: [approved] })) : json(overview());
      }
      if (path === `/api/workspaces/${approved.id}` && init.method === 'GET') return json(groupedInspection);
      if (path === `/api/workspaces/${approved.id}/revoke` && init.method === 'POST') { revokeCalls++; return json({ revoked: true }); }
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(approved.name) }));

    expect((await screen.findAllByRole('heading', { name: 'services', level: 3 })).length).toBe(2);
    expect(screen.getByText(roots[0])).toBeInTheDocument();
    expect(screen.getByText(roots[1])).toBeInTheDocument();
    expect(screen.getByText(roots[2])).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Access & privacy' })).toBeInTheDocument();
    expect(screen.getAllByText(roots[0]).length).toBeGreaterThan(0);
    expect(screen.getAllByText(roots[1]).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: `Revoke project access for ${approved.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(2));
    expect(revokeCalls).toBe(1);
    expect(document.body.textContent).not.toContain(roots[0]);
    expect(document.body.textContent).not.toContain(roots[1]);
  });

  it('does not restore revoked access or selected inventory from a pre-revocation refresh', async () => {
    const approved = workspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Revocation fixture', '/tmp/revocation-fixture');
    const stale = deferred<Response>();
    const staleStarted = deferred<void>();
    let overviewCalls = 0;
    installFetch(async (path, init) => {
      if (path === '/api/client-config') return json(clientConfig);
      if (path === '/api/overview') {
        overviewCalls++;
        if (overviewCalls === 1) return json(overview({ workspaces: [approved] }));
        if (overviewCalls === 2) return stale.promise.then(result => { staleStarted.resolve(); return result; });
        return json(overview());
      }
      if (path === `/api/workspaces/${approved.id}` && init.method === 'GET') return json(inspection(approved, 'old-sentinel-service'));
      if (path === `/api/workspaces/${approved.id}/revoke` && init.method === 'POST') return json({ revoked: true });
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, dashboardToken);
    render(<App />);
    const rail = await screen.findByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(approved.name) }));
    expect((await screen.findAllByText('old-sentinel-service')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh workspace' })[0]);
    await waitFor(() => expect(overviewCalls).toBe(2));
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Access & privacy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Revoke project access for ${approved.name}` }));
    await waitFor(() => expect(overviewCalls).toBe(3));
    expect(await screen.findByText('No projects are approved in this browser session.')).toBeInTheDocument();

    await act(async () => {
      stale.resolve(json(overview({ workspaces: [approved] })));
      await staleStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(approved.name);
    expect(document.body.textContent).not.toContain('old-sentinel-service');
    expect(screen.queryByRole('button', { name: `Revoke project access for ${approved.name}` })).not.toBeInTheDocument();
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
      if (url.pathname === `/api/workspaces/${previous.id}` && init.method !== 'POST') {
        oldInspectionCalls++;
        if (oldInspectionCalls === 1) return json(inspection(previous, 'old-sentinel-repository'));
        oldInspectionStarted.resolve();
        return oldInspection.promise;
      }
      if (url.pathname === `/api/workspaces/${current.id}` && init.method !== 'POST') return json(inspection(current, 'new-sentinel-repository'));
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
    const newSetupRequest = await screen.findByRole('region', { name: 'Setup request preview' });
    expect(newSetupRequest).toHaveTextContent('MCP_CONFIG_SENTINEL');
    expect(newSetupRequest).toHaveTextContent(current.id);
    expect(newSetupRequest.textContent).not.toContain(current.name);
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
      if (path === `/api/workspaces/${first.id}` && init.method === 'GET') return json(inspection(first, 'first-session-service'));
      if (path === `/api/workspaces/${second.id}` && init.method === 'GET') return json(inspection(second, 'second-session-service'));
      return json({ error: 'Not found.' }, 404);
    });
    sessionStorage.setItem(dashboardSessionStorageKey, firstToken);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Workspace rail' });
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(first.name) }));
    expect((await screen.findAllByText('first-session-service')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('link', { name: 'Access & privacy' })[0]);
    expect(await screen.findByRole('heading', { name: 'Access & privacy' })).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Access & privacy' })).toBeInTheDocument();
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
      if (path === `/api/workspaces/${approved.id}` && init.method !== 'POST') {
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Updating approved metadata'));

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
      if (path === `/api/workspaces/${approved.id}` && init.method !== 'POST') {
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
    expect(selector).toHaveValue(approved.id);
    fireEvent.change(selector, { target: { value: '' } });
    expect(await screen.findByRole('heading', { name: 'Choose a project' })).toBeInTheDocument();
    expect(selector).toHaveValue('');
    fireEvent.click(screen.getAllByRole('link', { name: 'Connect your AI' })[0]);
    const genericSetupRequest = await screen.findByRole('region', { name: 'Setup request preview' });
    expect(genericSetupRequest).toHaveTextContent('workspace_list first');
    expect(genericSetupRequest).toHaveTextContent('workspace_inspect and onboarding_plan only after project approval');
    expect(genericSetupRequest.textContent).not.toContain(approved.id);
    expect(genericSetupRequest.textContent).not.toContain(approved.name);
    expect(genericSetupRequest.textContent).not.toContain(approved.roots[0]);
  });
});
