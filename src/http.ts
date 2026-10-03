import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DashboardSessions } from './dashboard-sessions.js';
import { WorkspaceService } from './workspace.js';
import type { StaticAssets } from './static-assets.js';
import { maxProjectRootLength, maxProjectRoots } from './project-roots.js';
import { pickProjectRoots, type ProjectRootPickerResult } from './project-root-picker.js';
import { verifySocketTimeoutMs } from './verify.js';
import { datastoreQuerySchema, datastoreSocketTimeoutMs } from './datastore.js';
import { browserCheckSchema, browserSocketTimeoutMs } from './browser.js';

const proposalSchema = z.object({
  name: z.string().min(1).max(100),
  roots: z.array(z.string().min(1).max(maxProjectRootLength)).min(1).max(maxProjectRoots),
}).strict();
const consentSchema = z.object({ consent: z.literal(true) }).strict();
const disconnectSchema = z.object({}).strict();
const projectRootPickerSchema = z.object({}).strict();
const serviceTargetSchema = z.object({
  pmId: z.number().int().nonnegative().nullable(),
  name: z.string().min(1).max(200),
  namespace: z.string().max(80).nullable().optional(),
}).strict();
const serviceActionSchema = serviceTargetSchema;
const serviceLogsSchema = z.object({
  target: serviceTargetSchema,
  lines: z.number().int().min(1).max(200).optional(),
  stream: z.enum(['out', 'err', 'both']).optional(),
}).strict();
const verificationSchema = z.object({
  repositoryPath: z.string().min(1).max(4096),
  scriptName: z.string().min(1).max(80),
  service: z.object({
    pmId: z.number().int().nonnegative().nullable(),
    name: z.string().min(1).max(200),
    namespace: z.string().max(80).nullable().optional(),
  }).strict().optional(),
}).strict();
const workstreamSchema = z.object({
  name: z.string().min(1).max(100),
  workspaceId: z.string().uuid(),
  checkouts: z.array(z.string().min(1).max(4096)).min(1).max(20),
}).strict();
const workstreamStatusSchema = z.object({
  status: z.enum(['active', 'paused', 'done']),
}).strict();
const leaseSchema = z.object({
  resource: z.string().min(1).max(80),
  workstreamId: z.string().uuid(),
}).strict();
const uuidPath = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const proposalBodyLimit = 512 * 1024;
// Schema-valid datastore calls carry up to 8000 SQL chars plus 20 params of
// up to 1000 chars, so the default 8 KiB JSON cap would reject them.
const datastoreBodyLimit = 32 * 1024;
type ApiRole = 'dashboard' | 'mcp';

function hasAuthorizationHeader(request: IncomingMessage) {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'authorization') return true;
  }
  return false;
}

function bearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  return match?.[1];
}

function sameToken(supplied: string, expected: string) {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function apiRole(request: IncomingMessage, mcpToken: string, sessions: DashboardSessions): ApiRole | undefined {
  const token = bearerToken(request);
  if (!token) return undefined;
  if (sameToken(token, mcpToken)) return 'mcp';
  return sessions.isActive(token) ? 'dashboard' : undefined;
}

function mcpMayCall(role: ApiRole, method: string, pathname: string) {
  if (role === 'dashboard') return true;
  // The dashboard is not a permission gate, so the MCP client may use every
  // workspace operation; authority lives in the client's permission model.
  // Browser-session management, the native picker and the client configuration
  // stay dashboard-only, as do unknown routes.
  if (method === 'GET' && (pathname === '/api/overview'
    || pathname === '/api/leases'
    || pathname === '/api/activity'
    || new RegExp(`^/api/workspaces/${uuidPath}(?:/onboarding)?$`).test(pathname)
    || new RegExp(`^/api/workstreams(?:/${uuidPath})?$`).test(pathname))) return true;
  if (method === 'POST' && (pathname === '/api/workspaces'
    || new RegExp(`^/api/workspaces/${uuidPath}/services$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/services/(restart|stop|logs)$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/verify$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/browser/check$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/datastore/query$`).test(pathname)
    || pathname === '/api/workstreams'
    || new RegExp(`^/api/workstreams/${uuidPath}/status$`).test(pathname)
    || /^\/api\/leases\/(acquire|release)$/.test(pathname))) return true;
  if (method === 'DELETE' && new RegExp(`^/api/workspaces/${uuidPath}$`).test(pathname)) return true;
  return false;
}

function sameCanonicalDashboardRequest(request: IncomingMessage, origin: string) {
  return request.headers.host === new URL(origin).host
    && request.headers.origin === origin
    && request.headers['sec-fetch-site'] === 'same-origin';
}

function hasIntent(request: IncomingMessage, intent: string) {
  return request.headers['x-openworkspace-intent'] === intent;
}

async function body(request: IncomingMessage, limit = 8192): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') throw new Error('Use application/json.');
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (byteLength + bytes.length > limit) throw new Error('Request body is too large.');
    byteLength += bytes.length;
    chunks.push(bytes);
  }
  const data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteLength));
  return JSON.parse(data);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function parseRequestUrl(target: string, origin: string): URL | undefined {
  const rawPath = target.split(/[?#]/, 1)[0];
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[%\\\0]/.test(rawPath)) return undefined;
  if (rawPath !== '/' && rawPath.split('/').slice(1).some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  try {
    const url = new URL(target, origin);
    return url.origin === origin ? url : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(service: WorkspaceService, options: {
  assets: StaticAssets;
  mcpToken?: string;
  dashboardSessions?: DashboardSessions;
  projectRootPicker?: (signal: AbortSignal) => Promise<ProjectRootPickerResult>;
}) {
  const { assets } = options;
  const mcpToken = options.mcpToken ?? randomBytes(32).toString('hex');
  const sessions = options.dashboardSessions ?? new DashboardSessions();
  const projectRootPicker = options.projectRootPicker ?? (signal => pickProjectRoots(signal));
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const port = (server.address() as { port: number } | null)?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const suppliedOrigin = request.headers.origin;
    if (!allowedHosts.has(request.headers.host || '')
      || (suppliedOrigin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(suppliedOrigin))
      || request.headers['sec-fetch-site'] === 'cross-site') {
      json(response, 403, { error: 'Only the local dashboard and authorized local clients may connect.' });
      return;
    }
    try {
      const url = parseRequestUrl(request.url || '/', origin);
      if (!url) {
        json(response, 404, { error: 'Resource not found.' });
        return;
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        json(response, 200, { status: 'ready', product: 'OpenWorkspace', milestone: 'M0' });
        return;
      }

      if (url.pathname === '/api/dashboard-session' && request.method === 'POST') {
        if (!sameCanonicalDashboardRequest(request, origin)
          || !hasIntent(request, 'connect-dashboard')
          || hasAuthorizationHeader(request)) {
          json(response, 403, { error: 'Use the local browser consent action to connect this dashboard.' });
          return;
        }
        consentSchema.parse(await body(request));
        const session = sessions.issue(mcpToken);
        if (!session) {
          json(response, 429, { error: 'Too many browser sessions are active. Disconnect one and try again.' });
          return;
        }
        json(response, 201, session);
        return;
      }

      if (url.pathname === '/api/dashboard-session' && request.method === 'DELETE') {
        if (!sameCanonicalDashboardRequest(request, origin)
          || !hasIntent(request, 'disconnect-dashboard')) {
          json(response, 403, { error: 'Use the local browser to disconnect this dashboard.' });
          return;
        }
        const role = apiRole(request, mcpToken, sessions);
        const token = bearerToken(request);
        if (role !== 'dashboard' || !token) {
          json(response, role === undefined ? 401 : 403, { error: 'This browser session is no longer active.' });
          return;
        }
        disconnectSchema.parse(await body(request));
        sessions.revoke(token);
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const role = apiRole(request, mcpToken, sessions);
        if (!role) {
          json(response, 401, { error: 'Connect this browser or use the local MCP client.' });
          return;
        }
        if (!mcpMayCall(role, request.method || 'GET', url.pathname)) {
          json(response, 403, { error: 'The local MCP client is not authorized for this dashboard operation.' });
          return;
        }
        const actor = role === 'dashboard' ? 'dashboard' : 'mcp';
        // Activity is committed before the response so teardown/tests never outrun the write.
        // A logging failure is loud in server logs but never fails the operation that succeeded.
        const record = (operation: string, workspaceId: string | null, detail: string) =>
          service.recordActivity({ actor, operation, workspaceId, detail }).catch((error: unknown) => {
            console.error('Activity record failed:', error instanceof Error ? error.message : error);
          });
        if (url.pathname === '/api/overview' && request.method === 'GET') {
          json(response, 200, await service.overview());
        } else if (url.pathname === '/api/client-config' && request.method === 'GET') {
          json(response, 200, {
            mcpServers: { openworkspace: {
              command: process.execPath,
              args: [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
                fileURLToPath(new URL('./mcp.ts', import.meta.url))],
              env: { OPENWORKSPACE_HOME: service.store.directory },
            } },
          });
        } else if (url.pathname === '/api/project-root-picker' && request.method === 'POST') {
          if (role !== 'dashboard' || !sameCanonicalDashboardRequest(request, origin)
            || !hasIntent(request, 'select-project-roots')) {
            json(response, 403, { error: 'Use the connected local dashboard to select project folders.' });
            return;
          }
          projectRootPickerSchema.parse(await body(request));
          if (request.aborted || response.destroyed) return;
          const controller = new AbortController();
          const abortIfDisconnected = () => {
            if (!response.writableEnded) controller.abort();
          };
          request.once('aborted', abortIfDisconnected);
          response.once('close', abortIfDisconnected);
          try {
            let result: ProjectRootPickerResult;
            try {
              result = await projectRootPicker(controller.signal);
            } catch {
              result = { status: 'error' };
            }
            if (!controller.signal.aborted && !response.destroyed) json(response, 200, result);
          } finally {
            request.removeListener('aborted', abortIfDisconnected);
            response.removeListener('close', abortIfDisconnected);
          }
        } else {
          const serviceLogsMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/services\/logs$/.exec(url.pathname);
          if (serviceLogsMatch && request.method === 'POST') {
            const input = serviceLogsSchema.parse(await body(request));
            const result = await service.serviceLogs(serviceLogsMatch[1], input.target, { lines: input.lines, stream: input.stream });
            // Activity records counts only; raw log text is never persisted.
            await record('service-logs', serviceLogsMatch[1], `${input.target.name} → ${result.linesReturned} lines${result.truncated ? ' (truncated)' : ''}`);
            json(response, 200, result);
            return;
          }
          const serviceActionMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/services\/(restart|stop)$/.exec(url.pathname);
          if (serviceActionMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'control-service'))) {
              json(response, 403, { error: 'Service actions require the connected dashboard.' });
              return;
            }
            const input = serviceActionSchema.parse(await body(request));
            const result = await service.serviceAction(serviceActionMatch[1], serviceActionMatch[2] as 'restart' | 'stop', input);
            await record(`service-${serviceActionMatch[2]}`, serviceActionMatch[1], `${input.name} → ${result.status}`);
            json(response, 200, result);
            return;
          }
          const verificationMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/verify$/.exec(url.pathname);
          if (verificationMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'run-verification'))) {
              json(response, 403, { error: 'Repository verification requires the connected dashboard.' });
              return;
            }
            request.setTimeout(verifySocketTimeoutMs);
            const input = verificationSchema.parse(await body(request));
            if (request.aborted || response.destroyed) return;
            const controller = new AbortController();
            const abortIfDisconnected = () => {
              if (!response.writableEnded) controller.abort();
            };
            request.once('aborted', abortIfDisconnected);
            response.once('close', abortIfDisconnected);
            try {
              const result = await service.verify(verificationMatch[1], input, controller.signal);
              await record('verify', verificationMatch[1], `${input.scriptName} → ${result.outcome}`);
              if (!controller.signal.aborted && !response.destroyed) json(response, 200, result);
            } finally {
              request.removeListener('aborted', abortIfDisconnected);
              response.removeListener('close', abortIfDisconnected);
            }
            return;
          }
          const browserMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/browser\/check$/.exec(url.pathname);
          if (browserMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'check-browser'))) {
              json(response, 403, { error: 'Browser checks require the connected dashboard.' });
              return;
            }
            request.setTimeout(browserSocketTimeoutMs);
            const input = browserCheckSchema.parse(await body(request));
            if (request.aborted || response.destroyed) return;
            const result = await service.browserCheck(browserMatch[1], input);
            // Activity records sizes only; the URL may carry secrets and the
            // snapshot text is never persisted.
            await record('browser-check', browserMatch[1], `snapshot ${result.snapshotText.length} chars${result.truncated ? ' (truncated)' : ''}, assert ${result.assertFound === null ? 'unchecked' : result.assertFound ? 'found' : 'not found'}`);
            if (!response.destroyed) json(response, 200, result);
            return;
          }
          const datastoreMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/datastore\/query$/.exec(url.pathname);
          if (datastoreMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'query-datastore'))) {
              json(response, 403, { error: 'Datastore queries require the connected dashboard.' });
              return;
            }
            request.setTimeout(datastoreSocketTimeoutMs);
            const input = datastoreQuerySchema.parse(await body(request, datastoreBodyLimit));
            if (request.aborted || response.destroyed) return;
            const result = await service.datastoreQuery(datastoreMatch[1], input);
            await record('datastore-query', datastoreMatch[1], `${result.database} → ${result.rowCount} rows`);
            if (!response.destroyed) json(response, 200, result);
            return;
          }
          const workstreamMatch = new RegExp(`^/api/workstreams(?:/(${uuidPath}))?$`).exec(url.pathname);
          if (workstreamMatch && request.method === 'GET') {
            json(response, 200, workstreamMatch[1] ? await service.workstream(workstreamMatch[1]) : await service.listWorkstreams());
            return;
          }
          if (workstreamMatch && !workstreamMatch[1] && request.method === 'POST' && url.pathname === '/api/workstreams') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'create-workstream'))) {
              json(response, 403, { error: 'Workstream creation requires the connected dashboard.' });
              return;
            }
            const input = workstreamSchema.parse(await body(request));
            const created = await service.createWorkstream(input);
            await record('workstream-create', created.workspaceId, created.name.slice(0, 100));
            json(response, 201, created);
            return;
          }
          const workstreamStatusMatch = new RegExp(`^/api/workstreams/(${uuidPath})/status$`).exec(url.pathname);
          if (workstreamStatusMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'update-workstream'))) {
              json(response, 403, { error: 'Workstream updates require the connected dashboard.' });
              return;
            }
            const input = workstreamStatusSchema.parse(await body(request));
            const updated = await service.setWorkstreamStatus(workstreamStatusMatch[1], input.status);
            await record('workstream-status', updated.workspaceId, `${updated.name.slice(0, 80)} → ${updated.status}`);
            json(response, 200, updated);
            return;
          }
          if (url.pathname === '/api/leases' && request.method === 'GET') {
            json(response, 200, await service.listLeases());
            return;
          }
          const leaseMatch = /^\/api\/leases\/(acquire|release)$/.exec(url.pathname);
          if (leaseMatch && request.method === 'POST') {
            const intent = leaseMatch[1] === 'acquire' ? 'acquire-lease' : 'release-lease';
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, intent))) {
              json(response, 403, { error: 'Lease changes require the connected dashboard.' });
              return;
            }
            const input = leaseSchema.parse(await body(request));
            const result = leaseMatch[1] === 'acquire' ? await service.acquireLease(input) : await service.releaseLease(input);
            const owner = await service.workstream(input.workstreamId).then(workstream => workstream.workspaceId).catch(() => null);
            await record(`lease-${leaseMatch[1]}`, owner, `${input.resource} → ${input.workstreamId.slice(0, 8)}`);
            json(response, 200, result);
            return;
          }
          if (url.pathname === '/api/activity' && request.method === 'GET') {
            json(response, 200, await service.recentActivity());
            return;
          }
          const workspaceMatch = new RegExp(`^/api/workspaces/(${uuidPath})$`).exec(url.pathname);
          if (url.pathname === '/api/workspaces' && request.method === 'POST') {
            const input = proposalSchema.parse(await body(request, proposalBodyLimit));
            const registered = await service.register(input.name, input.roots);
            await record('register', registered.id, registered.name.slice(0, 100));
            json(response, 201, registered);
            return;
          }
          if (workspaceMatch && request.method === 'DELETE') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'remove-workspace'))) {
              json(response, 403, { error: 'Removing a project requires the connected dashboard.' });
              return;
            }
            const removed = await service.remove(workspaceMatch[1]);
            await record('remove', workspaceMatch[1], workspaceMatch[1].slice(0, 8));
            json(response, 200, removed);
            return;
          }
          const match = new RegExp(`^/api/workspaces/(${uuidPath})(?:/(onboarding|services))?$`).exec(url.pathname);
          if (match && request.method === 'GET' && (!match[2] || match[2] === 'onboarding')) {
            json(response, 200, match[2] ? await service.onboarding(match[1]) : await service.inspect(match[1]));
          } else if (match && request.method === 'POST' && match[2] === 'services') {
            z.object({}).strict().parse(await body(request));
            json(response, 200, await service.services(match[1]));
          } else {
            json(response, 404, { error: 'Operation not found.' });
          }
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(assets.indexHtml);
        return;
      }
      if (request.method === 'GET') {
        const asset = assets.files.get(url.pathname);
        if (asset) {
          response.writeHead(200, { 'content-type': asset.contentType });
          response.end(asset.body);
          return;
        }
      }
      json(response, 404, { error: 'Resource not found.' });
    } catch (error) {
      // Filesystem, schema and SDK errors may contain private paths or payloads.
      const safeMessages = [
        'Provide a project name with 100 characters or fewer.', 'Use an absolute project directory.',
        'Choose a project, not your home or filesystem root.', 'Choose a real directory, not a symlink.',
        'Select at least one repository folder.', 'Select no more than 20 repository folders.',
        'Each repository folder must be an absolute path of 4096 characters or fewer.',
        'Choose distinct folders without selecting a parent and its child.',
        'Project limit reached.',
        'Workspace not found. Register it first.',
        'Workspace not found.',
        'Remove its workstreams first.',
        'The selected folder is not inside an registered project root.',
        'The selected folder is not a real directory.',
        'This repository has no runnable test script with that name.',
        'The linked service is not uniquely mapped to a registered root.',
        'Provide a workstream name with 100 characters or fewer.',
        'Select at least one checkout and no more than twenty.',
        'Checkouts must be registered roots of this workspace.',
        'Unknown workstream.',
        'Unknown workstream status.',
        'A finished workstream cannot be reopened.',
        'Workstream limit reached.',
        'Name the resource with 1–80 lowercase letters, digits or :._- characters.',
        'Only the holding workstream can release a lease.',
        'A finished workstream cannot hold leases.',
        'Lease limit reached.',
        'Provide a database and role using 1–63 letters, digits or underscores.',
        'Only a single read-only SELECT-style statement is allowed.',
        'Superuser database roles cannot be used for read-only queries.',
        'The database query did not finish within the bounded runtime.',
        'The database query failed without returning rows.',
        'PostgreSQL client is unavailable.',
        'Provide an http(s) loopback URL.',
        'The page redirected outside loopback; refused.',
        'Browser check is unavailable.',
        'The browser check did not finish within the bounded runtime.',
        'The browser navigation failed safely without a snapshot.',
        'Approved directory identity changed. Request access again.',
        'Use application/json.', 'Request body is too large.',
      ];
      const message = error instanceof Error && safeMessages.includes(error.message)
        ? error.message : 'Operation could not complete safely. Check the directory and input, then retry.';
      json(response, 400, { error: message });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    server, mcpToken,
    async listen(port = 4318) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return origin;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
