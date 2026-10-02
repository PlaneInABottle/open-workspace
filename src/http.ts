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

const proposalSchema = z.object({
  name: z.string().min(1).max(100),
  roots: z.array(z.string().min(1).max(maxProjectRootLength)).min(1).max(maxProjectRoots),
}).strict();
const consentSchema = z.object({ consent: z.literal(true) }).strict();
const disconnectSchema = z.object({}).strict();
const projectRootPickerSchema = z.object({}).strict();
const uuidPath = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const proposalBodyLimit = 512 * 1024;
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
  return (method === 'GET' && pathname === '/api/overview')
    || (method === 'POST' && pathname === '/api/proposals')
    || (method === 'GET' && new RegExp(`^/api/workspaces/${uuidPath}(?:/onboarding)?$`).test(pathname))
    || (method === 'POST' && new RegExp(`^/api/workspaces/${uuidPath}/services$`).test(pathname));
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
          json(response, role === 'mcp' ? 403 : 401, { error: 'This browser session is no longer active.' });
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
        } else if (url.pathname === '/api/proposals' && request.method === 'POST') {
          const input = proposalSchema.parse(await body(request, proposalBodyLimit));
          json(response, 201, await service.propose(input.name, input.roots));
        } else {
          const match = new RegExp(`^/api/(proposals|workspaces)/(${uuidPath})(?:/(approve|reject|onboarding|revoke|services))?$`).exec(url.pathname);
          if (match?.[1] === 'proposals' && request.method === 'POST' && ['approve','reject'].includes(match[3])) {
            const input = await body(request);
            z.object({}).strict().parse(input);
            json(response, 200, match[3] === 'approve' ? await service.approve(match[2]) : await service.reject(match[2]));
          } else if (match?.[1] === 'workspaces' && request.method === 'GET' && (!match[3] || match[3] === 'onboarding')) {
            json(response, 200, match[3] ? await service.onboarding(match[2]) : await service.inspect(match[2]));
          } else if (match?.[1] === 'workspaces' && request.method === 'POST' && match[3] === 'revoke') {
            z.object({}).strict().parse(await body(request));
            json(response, 200, await service.revoke(match[2]));
          } else if (match?.[1] === 'workspaces' && request.method === 'POST' && match[3] === 'services') {
            z.object({}).strict().parse(await body(request));
            json(response, 200, await service.services(match[2]));
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
        'Directory access request not found.', 'Project limit reached.', 'Workspace access not found.',
        'Too many pending requests. Review them first.',
        'Workspace is not approved. Request directory access in the dashboard first.',
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
