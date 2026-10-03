import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { z } from 'zod';
import { DashboardSessions } from './dashboard-sessions.js';
import { WorkspaceService } from './workspace.js';
import type { StaticAssets } from './static-assets.js';
import { maxProjectRootLength, maxProjectRoots, projectRootMessages } from './project-roots.js';
import { pickProjectRoots, type ProjectRootPickerResult } from './project-root-picker.js';
import { verifyMessages, verifySocketTimeoutMs } from './verify.js';
import { datastoreMessages, datastoreQuerySchema, datastoreSocketTimeoutMs } from './datastore.js';
import { localToolSocketTimeoutMs } from './local-tools-allowlist.js';
import { localToolCallBodySchema, localToolCallMessages, localToolGateMessages } from './local-tools.js';
import { browserCheckSchema, browserMessages, browserSocketTimeoutMs } from './browser.js';
import { dockerMetadataMessages } from './services-docker.js';
import { leaseMessages } from './leases.js';
import { externalImportClaimMessage, externalImportInvalidMessage } from './run-summaries.js';
import { learningMessages } from './rule-index.js';
import { workspaceMessages } from './workspace.js';
import {
  checkpointBoundsMessage,
  checkpointEvidenceMessage,
  checkpointPatternMessage,
  completionBoundsMessage,
  completionEvidenceMessage,
  completionIdConflictMessage,
  completionPatternMessage,
  unknownWorkstreamMessage,
  unknownWorkstreamStatusMessage,
  workspaceAccessMessage,
  workstreamCheckoutCountMessage,
  workstreamCheckoutRootMessage,
  workstreamLimitMessage,
  workstreamNameMessage,
  workstreamReopenMessage,
} from './workstreams.js';

const proposalSchema = z.object({
  name: z.string().min(1).max(100),
  roots: z.array(z.string().min(1).max(maxProjectRootLength)).min(1).max(maxProjectRoots),
}).strict();
const rootsUpdateSchema = z.object({
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
const serviceStartSchema = z.object({
  repositoryPath: z.string().min(1).max(4096),
  scriptName: z.string().min(1).max(80),
  name: z.string().min(1).max(80).optional(),
}).strict();
const serviceLogsSchema = z.object({
  target: z.union([
    serviceTargetSchema,
    z.object({
      runner: z.literal('docker'),
      containerId: z.string().regex(/^[a-f\d]{64}$/i),
      name: z.string().min(1).max(256),
    }).strict(),
  ]),
  lines: z.number().int().min(1).max(200).optional(),
  stream: z.enum(['out', 'err', 'both']).optional(),
}).strict();
const containerLinkSchema = z.object({
  action: z.enum(['link', 'unlink']),
  containerId: z.string().regex(/^[a-f\d]{12,64}$/i),
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
  status: z.enum(['active', 'paused', 'done']).optional(),
  note: z.object({
    goal: z.string(),
    blocker: z.string(),
    next: z.string(),
    owner: z.enum(['agent', 'user']),
    // Transport-level cap only; the service enforces max 5 plus ID shape and
    // existence with safe errors.
    evidence: z.array(z.string().max(256)).max(50).optional(),
  }).strict().optional(),
  completion: z.object({
    assignmentId: z.string().min(1).max(128).optional(),
    completionId: z.string().uuid(),
    outcome: z.enum(['passed', 'blocked', 'failed']),
    revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    dirty: z.boolean().nullable(),
    dirtyFingerprint: z.object({
      diffHash: z.string().regex(/^[0-9a-f]{64}$/),
      files: z.array(z.string().min(1).max(256)).max(50),
      truncated: z.boolean(),
    }).strict().nullable(),
    checks: z.array(z.object({
      name: z.string().min(1).max(80),
      result: z.enum(['passed', 'failed', 'error']),
      environment: z.string().min(1).max(200),
      evidenceIds: z.array(z.string().max(128)).max(5).optional(),
    }).strict()).min(1).max(20),
  }).strict().optional(),
}).strict().refine(input =>
  (input.status !== undefined && input.completion === undefined)
  || (input.status === undefined && input.completion !== undefined && input.note === undefined),
);
const leaseSchema = z.object({
  resource: z.string().min(1).max(80),
  workstreamId: z.string().uuid(),
}).strict();
const learningRecordSchema = z.object({
  title: z.string().min(1).max(80),
  file: z.string().min(1).max(256),
  evidenceRefs: z.array(z.string().max(128)).min(1).max(5),
  failureSignature: z.object({
    tests: z.array(z.string().max(120)).max(10),
    errorClasses: z.array(z.string().max(120)).max(10),
  }).strict(),
}).strict();
const uuidPath = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const proposalBodyLimit = 512 * 1024;
const workstreamStatusBodyLimit = 64 * 1024;
// Schema-valid datastore calls carry up to 8000 SQL chars plus 20 params of
// up to 1000 chars, so the default 8 KiB JSON cap would reject them.
const datastoreBodyLimit = 32 * 1024;

// Transport-owned messages: the only allowlist entries defined in this
// module (thrown by body() above). Everything else is composed from owner
// exports so a rename propagates instead of degrading to the generic error.
export const httpTransportMessages = {
  json: 'Use application/json.',
  bodyTooLarge: 'Request body is too large.',
} as const;

// Rename-proof allowlist: every entry traces to exactly one owner export
// (definition-site guard in test/safe-messages.test.ts). No hand-copied
// literals here — Object.values plus explicit owner-const references.
export const safeMessages: readonly string[] = [
  workspaceMessages.projectName,
  projectRootMessages.absoluteDir,
  projectRootMessages.homeRoot,
  projectRootMessages.symlink,
  projectRootMessages.empty,
  projectRootMessages.tooMany,
  projectRootMessages.badPath,
  projectRootMessages.overlap,
  workspaceMessages.projectLimit,
  verifyMessages.notFoundRegister,
  verifyMessages.notFoundBare,
  workspaceMessages.containerIdShape,
  workspaceMessages.containerNotFound,
  workspaceMessages.containerAmbiguous,
  workspaceMessages.containerLinkedElsewhere,
  workspaceMessages.containerNotLinked,
  workspaceMessages.containerLinkLimit,
  ...Object.values(dockerMetadataMessages),
  workspaceMessages.removeBlocked,
  verifyMessages.folderInsideRoot,
  verifyMessages.folderRealDirectory,
  verifyMessages.noScript,
  verifyMessages.serviceNotMapped,
  workstreamNameMessage,
  workstreamCheckoutCountMessage,
  workstreamCheckoutRootMessage,
  unknownWorkstreamMessage,
  workspaceAccessMessage,
  unknownWorkstreamStatusMessage,
  workstreamReopenMessage,
  checkpointBoundsMessage,
  checkpointPatternMessage,
  checkpointEvidenceMessage,
  completionBoundsMessage,
  completionPatternMessage,
  completionEvidenceMessage,
  completionIdConflictMessage,
  workspaceMessages.assignmentId,
  externalImportInvalidMessage,
  externalImportClaimMessage,
  ...Object.values(learningMessages),
  workstreamLimitMessage,
  ...Object.values(leaseMessages),
  datastoreMessages.identifier,
  datastoreMessages.shape,
  datastoreMessages.superuser,
  datastoreMessages.timeout,
  datastoreMessages.failed,
  datastoreMessages.unavailable,
  browserMessages.loopbackUrl,
  browserMessages.redirect,
  browserMessages.unavailable,
  browserMessages.timeout,
  browserMessages.navFailed,
  projectRootMessages.approvedIdentity,
  ...Object.values(localToolGateMessages),
  ...Object.values(localToolCallMessages),
  workspaceMessages.resultLimit,
  ...Object.values(httpTransportMessages),
];
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
    || pathname === '/api/learnings'
    || pathname === '/api/runs/recent'
    || pathname === '/api/local-tools/status'
    || new RegExp(`^/api/workspaces/${uuidPath}(?:/onboarding)?$`).test(pathname)
    || new RegExp(`^/api/workstreams(?:/${uuidPath})?$`).test(pathname)
    || new RegExp(`^/api/workstreams/${uuidPath}/context$`).test(pathname))) return true;
  if (method === 'POST' && (pathname === '/api/workspaces'
    || pathname === '/api/runs/import'
    || pathname === '/api/learnings/record'
    || new RegExp(`^/api/workspaces/${uuidPath}/roots$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/services$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/services/(restart|stop|start|logs)$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/containers/link$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/verify$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/browser/check$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/datastore/query$`).test(pathname)
    || new RegExp(`^/api/workspaces/${uuidPath}/local-tools/call$`).test(pathname)
    || pathname === '/api/workstreams'
    || new RegExp(`^/api/workstreams/${uuidPath}/status$`).test(pathname)
    || /^\/api\/leases\/(acquire|touch|release)$/.test(pathname))) return true;
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
  if (request.headers['content-type'] !== 'application/json') throw new Error(httpTransportMessages.json);
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (byteLength + bytes.length > limit) throw new Error(httpTransportMessages.bodyTooLarge);
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

function clientConfig(stateDirectory: string) {
  // The SEA branch comes first: under a CJS bundle import.meta.url is empty,
  // so the companion-script evaluation below must never run inside SEA.
  if (isSea()) {
    return {
      mcpServers: { openworkspace: {
        command: process.execPath,
        args: ['mcp', '--state-directory', stateDirectory],
        env: { OPENWORKSPACE_HOME: stateDirectory },
        sea: true,
      } },
    };
  }
  return {
    mcpServers: { openworkspace: {
      command: process.execPath,
      args: [fileURLToPath(new URL('../bin/openworkspace.mjs', import.meta.url)),
        'mcp', '--state-directory', stateDirectory],
      env: { OPENWORKSPACE_HOME: stateDirectory },
    } },
  };
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
        // Read descriptors carry only the tool name, target ids and an outcome
        // class (ok/denied/failed); literals, SQL, URLs and log text never
        // enter activity. Activity and run reads never record (viewing the
        // audit trail must not append to it — no feedback loop).
        const recordRead = async <T>(operation: string, workspaceId: string | null, descriptor: string, work: () => Promise<T>): Promise<T> => {
          try {
            const value = await work();
            await record(operation, workspaceId, `${descriptor} → ok`.slice(0, 200));
            return value;
          } catch (error) {
            const outcome = error instanceof Error && /not found|Register it first/i.test(error.message) ? 'denied' : 'failed';
            await record(operation, workspaceId, `${descriptor} → ${outcome}`.slice(0, 200));
            throw error;
          }
        };
        const shortId = (id: string) => id.slice(0, 8);
        if (url.pathname === '/api/overview' && request.method === 'GET') {
          json(response, 200, await recordRead('workspace-list', null, 'workspace_list', () => service.overview(actor)));
        } else if (url.pathname === '/api/client-config' && request.method === 'GET') {
          json(response, 200, clientConfig(service.store.directory));
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
          const containerLinkMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/containers\/link$/.exec(url.pathname);
          if (containerLinkMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'manage-container-link'))) {
              json(response, 403, { error: 'Container link changes require the connected dashboard.' });
              return;
            }
            const input = containerLinkSchema.parse(await body(request));
            const result = await service.containerLink(containerLinkMatch[1], input.action, input.containerId);
            await record('container-link', containerLinkMatch[1], `${result.containerId.slice(0, 12)} → ${result.action}${result.changed ? '' : ' (unchanged)'}`);
            json(response, 200, result);
            return;
          }
          const serviceLogsMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/services\/logs$/.exec(url.pathname);
          if (serviceLogsMatch && request.method === 'POST') {
            const input = serviceLogsSchema.parse(await body(request));
            const result = await service.serviceLogs(serviceLogsMatch[1], input.target, { lines: input.lines, stream: input.stream });
            // Activity records counts only; raw log text is never persisted.
            await record('service-logs', serviceLogsMatch[1], `${input.target.name} → ${result.linesReturned} lines${result.truncated ? ' (truncated)' : ''}`);
            json(response, 200, result);
            return;
          }
          const serviceStartMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/services\/start$/.exec(url.pathname);
          if (serviceStartMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'control-service'))) {
              json(response, 403, { error: 'Service actions require the connected dashboard.' });
              return;
            }
            const input = serviceStartSchema.parse(await body(request));
            const result = await service.serviceStart(serviceStartMatch[1], input);
            await record('service-start', serviceStartMatch[1], `${input.scriptName} → ${result.status}`);
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
          const localToolCallMatch = /^\/api\/workspaces\/([a-f0-9-]{36})\/local-tools\/call$/.exec(url.pathname);
          if (localToolCallMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'call-local-tool'))) {
              json(response, 403, { error: 'Local tool calls require the connected dashboard.' });
              return;
            }
            request.setTimeout(localToolSocketTimeoutMs);
            let input: unknown;
            try {
              input = localToolCallBodySchema.parse(await body(request));
            } catch (error) {
              if (error instanceof z.ZodError) throw new Error(localToolCallMessages.invalidCall);
              throw error;
            }
            if (request.aborted || response.destroyed) return;
            const result = await service.localToolCall(localToolCallMatch[1], input, { actor });
            if (!response.destroyed) json(response, 200, result);
            return;
          }
          if (url.pathname === '/api/local-tools/status' && request.method === 'GET') {
            // The read itself never records activity (mirroring activity/run
            // reads); registry transitions the rescan discovers still audit.
            json(response, 200, await service.localToolStatus(actor));
            return;
          }
          const workstreamContextMatch = new RegExp(`^/api/workstreams/(${uuidPath})/context$`).exec(url.pathname);
          if (workstreamContextMatch && request.method === 'GET') {
            // Reader-only handoff bundle: like activity/run/learn reads,
            // reading never records activity (no feedback loop).
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? 5 : Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
              throw new Error(workspaceMessages.resultLimit);
            }
            const assignmentId = url.searchParams.get('assignmentId') ?? undefined;
            json(response, 200, await service.workstreamContext(workstreamContextMatch[1], limit, assignmentId));
            return;
          }
          const workstreamMatch = new RegExp(`^/api/workstreams(?:/(${uuidPath}))?$`).exec(url.pathname);
          if (workstreamMatch && request.method === 'GET') {
            json(response, 200, workstreamMatch[1]
              ? await recordRead('workspace-workstreams', null, `workspace_workstreams ${shortId(workstreamMatch[1])}`, () => service.workstream(workstreamMatch[1] as string))
              : await recordRead('workspace-workstreams', null, 'workspace_workstreams', () => service.listWorkstreams()));
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
            const input = workstreamStatusSchema.parse(await body(request, workstreamStatusBodyLimit));
            const updated = input.completion
              ? await service.appendWorkstreamCompletion(workstreamStatusMatch[1], input.completion)
              : await service.setWorkstreamStatus(workstreamStatusMatch[1], input.status!, input.note, actor);
            if (input.completion) {
              await record('workstream-completion', updated.workspaceId,
                `${input.completion.assignmentId ?? 'solo'} → ${input.completion.outcome}`);
            } else {
              await record('workstream-status', updated.workspaceId, `${updated.name.slice(0, 80)} → ${updated.status}`);
            }
            json(response, 200, updated);
            return;
          }
          if (url.pathname === '/api/runs/import' && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'import-run'))) {
              json(response, 403, { error: 'Recording a pasted result requires the connected dashboard.' });
              return;
            }
            const imported = await service.importExternalRun(await body(request));
            // Activity records the script name and trust class only; the
            // pasted excerpt itself is never persisted outside the masked file.
            await record('run-import', imported.workspaceId, `${imported.scriptName} → external-import`);
            json(response, 201, imported);
            return;
          }
          if (url.pathname === '/api/learnings/record' && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'record-learning'))) {
              json(response, 403, { error: 'Recording a learning rule requires the connected dashboard.' });
              return;
            }
            const recorded = await service.recordLearning(learningRecordSchema.parse(await body(request)));
            // Activity records counts only: evidence-ref count plus outcome
            // class, never the title, file ref or failure text.
            await record('learning-record', null, `${recorded.evidenceRefs.length} evidence refs → ${recorded.status}`);
            json(response, 201, recorded);
            return;
          }
          if (url.pathname === '/api/leases' && request.method === 'GET') {
            json(response, 200, await recordRead('workspace-leases', null, 'workspace_leases', () => service.listLeases(actor)));
            return;
          }
          // Dashboard renewal UI wiring is a follow-up; this route preserves an explicit intent gate.
          const leaseMatch = /^\/api\/leases\/(acquire|touch|release)$/.exec(url.pathname);
          if (leaseMatch && request.method === 'POST') {
            const intent = leaseMatch[1] === 'acquire' ? 'acquire-lease'
              : leaseMatch[1] === 'touch' ? 'touch-lease' : 'release-lease';
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, intent))) {
              json(response, 403, { error: 'Lease changes require the connected dashboard.' });
              return;
            }
            const input = leaseSchema.parse(await body(request));
            const result = leaseMatch[1] === 'acquire' ? await service.acquireLease(input, actor)
              : leaseMatch[1] === 'touch' ? await service.touchLease(input, actor)
                : await service.releaseLease(input, actor);
            const owner = await service.workstream(input.workstreamId).then(workstream => workstream.workspaceId).catch(() => null);
            await record(`lease-${leaseMatch[1]}`, owner, `${input.resource} → ${input.workstreamId.slice(0, 8)}`);
            json(response, 200, result);
            return;
          }
          if (url.pathname === '/api/activity' && request.method === 'GET') {
            const limitRaw = url.searchParams.get('limit');
            const entries = await service.recentActivity();
            if (limitRaw === null) {
              json(response, 200, entries);
              return;
            }
            const limit = Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
              throw new Error(workspaceMessages.resultLimit);
            }
            json(response, 200, entries.slice(-limit));
            return;
          }
          if (url.pathname === '/api/learnings' && request.method === 'GET') {
            // Reader-only narrative spine. Like activity/run reads, viewing
            // these agent-written notes never records activity.
            json(response, 200, await service.learnings());
            return;
          }
          if (url.pathname === '/api/runs/recent' && request.method === 'GET') {
            const scope = url.searchParams.get('scope') ?? '';
            if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(scope)) {
              throw new Error(verifyMessages.notFoundRegister);
            }
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? 5 : Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
              throw new Error(workspaceMessages.resultLimit);
            }
            json(response, 200, await service.recentRuns(scope.toLowerCase(), limit));
            return;
          }
          const workspaceMatch = new RegExp(`^/api/workspaces/(${uuidPath})$`).exec(url.pathname);
          // Full-list root replacement uses POST like the other workspace
          // mutations (services, verify, ...), not PUT: the client helper
          // defaults to POST for bodies and no PUT handling exists.
          const rootsMatch = new RegExp(`^/api/workspaces/(${uuidPath})/roots$`).exec(url.pathname);
          if (rootsMatch && request.method === 'POST') {
            if (role === 'dashboard' && (!sameCanonicalDashboardRequest(request, origin) || !hasIntent(request, 'update-workspace-roots'))) {
              json(response, 403, { error: 'Updating project roots requires the connected dashboard.' });
              return;
            }
            const input = rootsUpdateSchema.parse(await body(request, proposalBodyLimit));
            const { workspace, previousRoots } = await service.updateRoots(rootsMatch[1], input.roots);
            // Activity records counts only (N→M roots), never raw paths —
            // matching registration, which records the name alone.
            await record('roots-update', workspace.id, `${previousRoots} → ${workspace.roots.length} roots`);
            json(response, 200, workspace);
            return;
          }
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
            json(response, 200, match[2]
              ? await recordRead('onboarding-plan', match[1], `onboarding_plan ${shortId(match[1])}`, () => service.onboarding(match[1]))
              : await recordRead('workspace-inspect', match[1], `workspace_inspect ${shortId(match[1])}`, () => service.inspect(match[1])));
          } else if (match && request.method === 'POST' && match[2] === 'services') {
            const input = z.object({ includeUnmanaged: z.boolean().optional() }).strict().parse(await body(request));
            json(response, 200, await recordRead('workspace-services', match[1], `workspace_services ${shortId(match[1])}`, () => service.services(match[1], input)));
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
      // safeMessages is the module-level composed allowlist (owner constants only).
      const message = error instanceof Error && (safeMessages as readonly string[]).includes(error.message)
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
