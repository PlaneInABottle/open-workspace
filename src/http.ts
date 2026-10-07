import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { z } from 'zod';
import { WorkspaceService } from './workspace.js';
import { AmbiguousNameError, nameMessages, parseNameInput, resolveWorkspaceRecord } from './store.js';
import type { StaticAssets } from './static-assets.js';
import { maxProjectRootLength, maxProjectRoots, projectRootMessages } from './project-roots.js';
import { pickProjectRoots, type ProjectRootPickerResult } from './project-root-picker.js';
import { verifyMessages, verifySocketTimeoutMs } from './verify.js';
import { datastoreMessages } from './datastore.js';
import { dockerMetadataMessages } from './services-docker.js';
import { externalImportClaimMessage, externalImportInvalidMessage } from './run-summaries.js';
import { learningMessages } from './rule-index.js';
import { workspaceMessages } from './workspace.js';
import { coerceProposeDraft, environmentDownInput, environmentMessages, environmentSetInput, environmentUpInput, environmentVerifyInput } from './environment.js';
import * as observer from './observer.js';
import { observerMessages } from './observer.js';

const proposalSchema = z.object({
  name: z.string().min(1).max(100),
  roots: z.array(z.string().min(1).max(maxProjectRootLength)).min(1).max(maxProjectRoots),
}).strict();
const rootsUpdateSchema = z.object({
  roots: z.array(z.string().min(1).max(maxProjectRootLength)).min(1).max(maxProjectRoots),
}).strict();
const projectRootPickerSchema = z.object({}).strict();
const learningRecordSchema = z.object({
  title: z.string().min(1).max(80),
  file: z.string().min(1).max(256),
  evidenceRefs: z.array(z.string().max(128)).min(1).max(5),
  failureSignature: z.object({
    tests: z.array(z.string().max(120)).max(10),
    errorClasses: z.array(z.string().max(120)).max(10),
  }).strict(),
  situations: z.array(z.string().min(1).max(40)).max(10).optional(),
}).strict();
const renameSchema = z.object({
  name: z.string().min(1).max(100),
}).strict();
const nameSegment = '[^/]+';
const proposalBodyLimit = 512 * 1024;

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
  workspaceMessages.projectNameTaken,
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
  verifyMessages.folderInsideRoot,
  verifyMessages.folderRealDirectory,
  verifyMessages.noScript,
  verifyMessages.serviceNotMapped,
  externalImportInvalidMessage,
  externalImportClaimMessage,
  ...Object.values(learningMessages),
  datastoreMessages.identifier,
  datastoreMessages.shape,
  datastoreMessages.superuser,
  datastoreMessages.timeout,
  datastoreMessages.failed,
  datastoreMessages.unavailable,
  projectRootMessages.approvedIdentity,
  workspaceMessages.resultLimit,
  ...Object.values(environmentMessages),
  ...Object.values(nameMessages),
  ...Object.values(httpTransportMessages),
  ...Object.values(observerMessages),
];
type ApiRole = 'dashboard' | 'mcp';

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

/**
 * Role gate (dev-only open loopback): requests without a bearer token are
 * the local dashboard — any same-machine process that passes the loopback
 * Host/Origin/fetch-metadata gate above. Requests carrying the MCP token
 * are the MCP bridge. Any other bearer is rejected (401) so a mistyped or
 * stale credential never silently becomes dashboard access.
 */
function apiRole(request: IncomingMessage, mcpToken: string): ApiRole | undefined {
  const token = bearerToken(request);
  if (!token) return 'dashboard';
  return sameToken(token, mcpToken) ? 'mcp' : undefined;
}

function mcpMayCall(role: ApiRole, method: string, pathname: string) {
  if (role === 'dashboard') return true;
  // Observer reads are dashboard-only (dev-only surface, raw excerpts).
  if (pathname === '/api/observer/doctor'
    || pathname === '/api/observer/sessions'
    || pathname === '/api/observer/mistakes'
    || pathname === '/api/observer/stuck'
    || pathname === '/api/observer/cost') return false;
  if (new RegExp(`^/api/observer/sessions/${nameSegment}(?:/(meta|records|stuck|prompts|reads))?$`).test(pathname)) return false;
  // The dashboard is not a permission gate, so the MCP client may use every
  // workspace operation; authority lives in the client's permission model.
  // The native picker and the client configuration stay dashboard-only, as
  // do unknown routes.
  if (method === 'GET' && (pathname === '/api/overview'
    || pathname === '/api/activity'
    || pathname === '/api/learnings'
    || pathname === '/api/lessons'
    || pathname === '/api/runs/recent'
    || new RegExp(`^/api/workspaces/${nameSegment}(?:/onboarding)?$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/environments(?:/status)?$`).test(pathname))) return true;
  if (method === 'POST' && (pathname === '/api/workspaces'
    || pathname === '/api/runs/import'
    || pathname === '/api/learnings/record'
    || new RegExp(`^/api/workspaces/${nameSegment}/rename$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/roots$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/services$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/environments/(propose|set|up|down)$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/environments/[^/]+/rename$`).test(pathname)
    || new RegExp(`^/api/workspaces/${nameSegment}/environment/verify$`).test(pathname))) return true;
  if (method === 'DELETE' && new RegExp(`^/api/workspaces/${nameSegment}$`).test(pathname)) return true;
  return false;
}

function sameCanonicalDashboardRequest(request: IncomingMessage, origin: string) {
  return request.headers.host === new URL(origin).host
    && request.headers.origin === origin
    && request.headers['sec-fetch-site'] === 'same-origin';
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

/**
 * Name-segment decoding (single definition site for the HTTP layer): the
 * client sends encodeURIComponent(name); the server decodes once and applies
 * the shared name contract (trimmed 1–100, no `/`/NUL/controls/`..`,
 * UUID-shaped inputs rejected with the use-the-name guidance).
 */
function decodeNameSegment(raw: string, invalidMessage: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error(invalidMessage);
  }
  return parseNameInput(decoded, invalidMessage);
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
  // Percent-encoded name segments are allowed (the client encodes every
  // name); decoding happens once per segment at the route, which rejects a
  // decoded `/`, NUL or charset violation. Raw backslashes and NUL stay out.
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\\0]/.test(rawPath)) return undefined;
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
  projectRootPicker?: (signal: AbortSignal) => Promise<ProjectRootPickerResult>;
}) {
  const { assets } = options;
  const mcpToken = options.mcpToken ?? randomBytes(32).toString('hex');
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

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const role = apiRole(request, mcpToken);
        if (!role) {
          json(response, 401, { error: 'Use the local MCP client.' });
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
        // Stable-ID scope for activity rows: names resolve to IDs here so the
        // audit trail survives renames. A bad name throws before any mutation.
        const workspaceScopeId = async (name: string): Promise<string> =>
          resolveWorkspaceRecord(await service.store.read(), name, workspaceMessages.projectName, verifyMessages.notFoundRegister).id;
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
        if (url.pathname === '/api/overview' && request.method === 'GET') {
          json(response, 200, await recordRead('workspace-list', null, 'workspace_list', () => service.overview()));
        } else if (url.pathname === '/api/client-config' && request.method === 'GET') {
          json(response, 200, clientConfig(service.store.directory));
        } else if (url.pathname === '/api/project-root-picker' && request.method === 'POST') {
          if (role !== 'dashboard' || !sameCanonicalDashboardRequest(request, origin)) {
            json(response, 403, { error: 'Use the local dashboard to select project folders.' });
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
          if (url.pathname === '/api/runs/import' && request.method === 'POST') {
            const imported = await service.importExternalRun(await body(request));
            // Activity records the script name and trust class only; the
            // pasted excerpt itself is never persisted outside the masked file.
            await record('run-import', imported.workspaceId, `${imported.scriptName} → external-import`);
            json(response, 201, imported);
            return;
          }
          if (url.pathname === '/api/learnings/record' && request.method === 'POST') {
            const recorded = await service.recordLearning(learningRecordSchema.parse(await body(request)));
            // Activity records counts only: evidence-ref count plus outcome
            // class, never the title, file ref or failure text.
            await record('learning-record', null, `${recorded.evidenceRefs.length} evidence refs → ${recorded.status}`);
            json(response, 201, recorded);
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
          if (url.pathname === '/api/lessons' && request.method === 'GET') {
            // Read-only learned-lessons shelf: titles plus source file refs
            // only, never rule bodies. Global like the milestone notes;
            // viewing never records activity and never writes the index.
            json(response, 200, await service.lessonShelf());
            return;
          }
          if (url.pathname === '/api/runs/recent' && request.method === 'GET') {
            // Name-addressed scope: a workspace name. IDs are internal and
            // never accepted.
            const rawWorkspace = url.searchParams.get('workspace');
            if (rawWorkspace === null || !rawWorkspace.trim()) throw new Error(verifyMessages.notFoundRegister);
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? 5 : Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
              throw new Error(workspaceMessages.resultLimit);
            }
            json(response, 200, await service.recentRuns(rawWorkspace, limit));
            return;
          }
          // Observer surface (dev-only, dashboard-role reads only — denied to
          // MCP in mcpMayCall above). Raw excerpts are served as stored; every
          // route returns warnings[] so DB/join degradation is visible, never
          // silent. Viewing never records activity.
          if (url.pathname === '/api/observer/doctor' && request.method === 'GET') {
            json(response, 200, { checks: await observer.doctor(), warnings: [] });
            return;
          }
          if (url.pathname === '/api/observer/sessions' && request.method === 'GET') {
            const since = observer.resolveSince(url.searchParams.get('since'));
            const kind = url.searchParams.get('kind') ?? undefined;
            if (kind !== undefined && !observer.validKinds.has(kind)) throw new Error(observerMessages.badKind);
            const { sessions, warnings } = await observer.listSessions({
              sinceMs: since,
              dir: url.searchParams.get('dir') ?? undefined,
              kind,
            });
            json(response, 200, { sessions, warnings });
            return;
          }
          if (url.pathname === '/api/observer/mistakes' && request.method === 'GET') {
            const since = observer.resolveSince(url.searchParams.get('since'));
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? 100 : Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(observerMessages.badLimit);
            const session = url.searchParams.get('session');
            // Full ids pass through; displayed short ids resolve by prefix.
            // Ambiguous prefixes and dead ends are 400s, never silent empties.
            let resolvedSession: string | undefined;
            if (session !== null && session !== '') {
              // Displayed short ids resolve by prefix against the sidecar;
              // ambiguous prefixes and dead ends are 400s, never silent
              // empties. Known ids with no failures stay legitimately empty.
              resolvedSession = observer.resolveSessionPrefix(session, await observer.knownSessionIDs());
            }
            const { rows, warnings } = await observer.globalMistakes({
              sinceMs: since,
              session: resolvedSession,
              agent: url.searchParams.get('agent') ?? undefined,
              limit,
            });
            json(response, 200, { rows, warnings });
            return;
          }
          if (url.pathname === '/api/observer/stuck' && request.method === 'GET') {
            const since = observer.resolveSince(url.searchParams.get('since'));
            const { entries, warnings } = await observer.globalStuck({ sinceMs: since });
            json(response, 200, { entries, warnings });
            return;
          }
          if (url.pathname === '/api/observer/cost' && request.method === 'GET') {
            const since = observer.resolveSince(url.searchParams.get('since'));
            const limitRaw = url.searchParams.get('limit');
            const limit = limitRaw === null ? 50 : Number(limitRaw);
            if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error(observerMessages.badLimit);
            const { rows, warnings } = await observer.costTable({ sinceMs: since, limit });
            json(response, 200, { rows, warnings });
            return;
          }
          const observerSessionMatch = new RegExp(`^/api/observer/sessions/(${nameSegment})/(meta|records|stuck|prompts|reads)$`).exec(url.pathname);
          if (observerSessionMatch && request.method === 'GET') {
            const sessionID = observer.parseSessionId(observerSessionMatch[1]);
            const leaf = observerSessionMatch[2];
            if (leaf === 'meta') {
              const { meta, warning } = await observer.sessionMeta({ sessionID });
              json(response, 200, { meta, warning, warnings: warning ? [warning] : [] });
              return;
            }
            if (leaf === 'prompts') {
              const prompts = await observer.sessionPrompts({ sessionID });
              json(response, 200, { session: sessionID, prompts, warnings: [] as string[] });
              return;
            }
            const since = observer.resolveSince(url.searchParams.get('since'));
            const kind = url.searchParams.get('kind') ?? undefined;
            if (kind !== undefined && !observer.validKinds.has(kind)) throw new Error(observerMessages.badKind);
            const tool = url.searchParams.get('tool') ?? undefined;
            const tree = url.searchParams.get('tree') === '1' || url.searchParams.get('tree') === 'true';
            const failsOnly = url.searchParams.get('failsOnly') === '1' || url.searchParams.get('failsOnly') === 'true';
            const failFilter = (groups: observer.TaskGroup[]): observer.TaskGroup[] => {
              if (!failsOnly) return groups;
              return groups
                .map(group => ({
                  ...group,
                  lines: group.lines.filter(line => line.outcome === 'failure' || line.outcome === 'error'),
                }))
                .filter(group => group.lines.length > 0);
            };
            if (leaf === 'records') {
              if (tree) {
                const { by, warnings, parentLinked } = await observer.loadTreeRecords({ sessionID, sinceMs: since });
                const filtered = new Map<string, observer.EnrichedRecord[]>();
                for (const [id, recs] of by) filtered.set(id, observer.filterTools(observer.filterSince(recs, since), kind, tool));
                const merged = [...filtered.values()].flat();
                const root = observer.buildTree(sessionID, filtered, new Set(parentLinked));
                json(response, 200, {
                  session: sessionID,
                  warnings,
                  groups: failFilter(await observer.groupByTaskForSessions(undefined, merged)),
                  tree: observer.treeIds(root, await observer.treeDetails({ node: root, recordsBy: filtered })),
                });
                return;
              }
              const { records, warnings } = await observer.joinSession({ sessionID, sinceMs: since });
              const filtered = observer.filterTools(observer.filterSince(records, since), kind, tool);
              json(response, 200, { session: sessionID, warnings, groups: failFilter(await observer.groupByTaskForSessions(undefined, filtered)) });
              return;
            }
            if (leaf === 'reads') {
              const { records, warnings } = await observer.joinSession({ sessionID, sinceMs: since });
              json(response, 200, {
                session: sessionID,
                warnings,
                reads: observer.readDigest(observer.filterSince(records, since)),
              });
              return;
            }
            if (leaf === 'stuck') {
              if (tree) {
                const { by, warnings } = await observer.loadTreeRecords({ sessionID, sinceMs: since });
                const merged = [...by.values()].flat();
                json(response, 200, {
                  session: sessionID,
                  warnings,
                  report: await observer.stuckReport({ records: observer.filterSince(merged, since), sessionID }),
                });
                return;
              }
              const { records, warnings } = await observer.joinSession({ sessionID, sinceMs: since });
              json(response, 200, {
                session: sessionID,
                warnings,
                report: await observer.stuckReport({ records: observer.filterSince(records, since), sessionID }),
              });
              return;
            }
          }
          const workspaceMatch = new RegExp(`^/api/workspaces/(${nameSegment})$`).exec(url.pathname);
          // Full-list root replacement uses POST like the other workspace
          // mutations (services, ...), not PUT: the client helper
          // defaults to POST for bodies and no PUT handling exists.
          const rootsMatch = new RegExp(`^/api/workspaces/(${nameSegment})/roots$`).exec(url.pathname);
          if (rootsMatch && request.method === 'POST') {
            const name = decodeNameSegment(rootsMatch[1], workspaceMessages.projectName);
            const input = rootsUpdateSchema.parse(await body(request, proposalBodyLimit));
            const { workspace, previousRoots } = await service.updateRoots(name, input.roots);
            // Activity records counts only (N→M roots), never raw paths —
            // matching registration, which records the name alone.
            await record('roots-update', workspace.id, `${previousRoots} → ${workspace.roots.length} roots`);
            json(response, 200, workspace);
            return;
          }
          const workspaceRenameMatch = new RegExp(`^/api/workspaces/(${nameSegment})/rename$`).exec(url.pathname);
          if (workspaceRenameMatch && request.method === 'POST') {
            const name = decodeNameSegment(workspaceRenameMatch[1], workspaceMessages.projectName);
            const input = renameSchema.parse(await body(request));
            const renamed = await service.renameWorkspace(name, input.name);
            await record('workspace-rename', renamed.id, renamed.name.slice(0, 100));
            json(response, 200, renamed);
            return;
          }
          // Environment topology and runtime: dashboard and MCP share the same
          // operations; the role allowlist plus service auth are the only
          // gates. No dashboard-only confirmation step stands in front.
          const envProposeMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/propose$`).exec(url.pathname);
          if (envProposeMatch && request.method === 'POST') {
            z.object({}).strict().parse(await body(request));
            const name = decodeNameSegment(envProposeMatch[1], workspaceMessages.projectName);
            json(response, 200, await recordRead('environment-propose', await workspaceScopeId(name).catch(() => null), `environment_propose ${name}`.slice(0, 100), () => service.environmentPropose(name)));
            return;
          }
          const envSetMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/set$`).exec(url.pathname);
          if (envSetMatch && request.method === 'POST') {
            const name = decodeNameSegment(envSetMatch[1], workspaceMessages.projectName);
            // Boundary coercion before the strict parse: raw
            // environment_propose output applies directly (dependsOnSuggest
            // becomes dependsOn; propose-only hints are dropped). The service
            // coerces again idempotently; refusals are unchanged.
            const input = environmentSetInput.parse(coerceProposeDraft(await body(request, proposalBodyLimit)));
            const created = await service.environmentSet(name, input);
            // Activity records the env name and service count only — never
            // paths, ports, or script bodies.
            await record('environment-set', await workspaceScopeId(name), `${created.name.slice(0, 100)} → ${created.services.length} services`);
            json(response, 200, created);
            return;
          }
          const envRenameMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/(${nameSegment})/rename$`).exec(url.pathname);
          if (envRenameMatch && request.method === 'POST') {
            const name = decodeNameSegment(envRenameMatch[1], workspaceMessages.projectName);
            const environment = decodeNameSegment(envRenameMatch[2], environmentMessages.badTopology);
            const input = renameSchema.parse(await body(request));
            const renamed = await service.renameEnvironment(name, environment, input.name);
            await record('environment-rename', await workspaceScopeId(name), renamed.name.slice(0, 100));
            json(response, 200, renamed);
            return;
          }
          const envStatusMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/status$`).exec(url.pathname);
          if (envStatusMatch && request.method === 'GET') {
            const rawEnvironment = url.searchParams.get('environment') ?? '';
            if (!rawEnvironment.trim()) throw new Error(environmentMessages.envNotFound);
            const name = decodeNameSegment(envStatusMatch[1], workspaceMessages.projectName);
            json(response, 200, await recordRead('environment-status', await workspaceScopeId(name).catch(() => null), `environment_status ${name}`.slice(0, 100), () => service.environmentStatus(name, rawEnvironment)));
            return;
          }
          const envListMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments$`).exec(url.pathname);
          if (envListMatch && request.method === 'GET') {
            const name = decodeNameSegment(envListMatch[1], workspaceMessages.projectName);
            json(response, 200, await recordRead('environment-list', await workspaceScopeId(name).catch(() => null), `environment_list ${name}`.slice(0, 100), () => service.environmentList(name)));
            return;
          }
          // M2 runtime: ordered up (readiness-polled), owned-only down, and
          // receipt-bound verify. Dashboard and MCP share the same operation;
          // the role allowlist plus service auth are the only gates.
          const envUpMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/up$`).exec(url.pathname);
          if (envUpMatch && request.method === 'POST') {
            request.setTimeout(verifySocketTimeoutMs);
            const name = decodeNameSegment(envUpMatch[1], workspaceMessages.projectName);
            const input = environmentUpInput.parse(await body(request));
            if (request.aborted || response.destroyed) return;
            const result = await service.environmentUp(name, input.environment);
            const ready = result.services.filter(entry => entry.status === 'ready' || entry.status === 'starting').length;
            await record('environment-up', await workspaceScopeId(name), `${result.name.slice(0, 100)} → ${result.state} (${ready}/${result.services.length} live)`);
            if (!response.destroyed) json(response, 200, result);
            return;
          }
          const envDownMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environments/down$`).exec(url.pathname);
          if (envDownMatch && request.method === 'POST') {
            request.setTimeout(verifySocketTimeoutMs);
            const name = decodeNameSegment(envDownMatch[1], workspaceMessages.projectName);
            const input = environmentDownInput.parse(await body(request));
            if (request.aborted || response.destroyed) return;
            const result = await service.environmentDown(name, input.environment);
            const stopped = result.services.filter(entry => entry.status === 'down').length;
            await record('environment-down', await workspaceScopeId(name), `${result.name.slice(0, 100)} → ${result.state} (${stopped}/${result.services.length} stopped)`);
            if (!response.destroyed) json(response, 200, result);
            return;
          }
          const envVerifyMatch = new RegExp(`^/api/workspaces/(${nameSegment})/environment/verify$`).exec(url.pathname);
          if (envVerifyMatch && request.method === 'POST') {
            request.setTimeout(verifySocketTimeoutMs);
            const name = decodeNameSegment(envVerifyMatch[1], workspaceMessages.projectName);
            const input = environmentVerifyInput.parse(await body(request));
            if (request.aborted || response.destroyed) return;
            const controller = new AbortController();
            const abortIfDisconnected = () => {
              if (!response.writableEnded) controller.abort();
            };
            request.once('aborted', abortIfDisconnected);
            response.once('close', abortIfDisconnected);
            try {
              const result = await service.environmentVerify(name, {
                environment: input.environment,
                repositoryPath: input.repositoryPath,
                scriptName: input.scriptName,
              }, controller.signal);
              await record('environment-verify', await workspaceScopeId(name), `${input.scriptName.slice(0, 80)} → ${result.outcome}`);
              if (!controller.signal.aborted && !response.destroyed) json(response, 200, result);
            } finally {
              request.removeListener('aborted', abortIfDisconnected);
              response.removeListener('close', abortIfDisconnected);
            }
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
            const name = decodeNameSegment(workspaceMatch[1], workspaceMessages.projectName);
            const scopeId = await workspaceScopeId(name);
            const removed = await service.remove(name);
            await record('remove', scopeId, name.slice(0, 100));
            json(response, 200, removed);
            return;
          }
          const match = new RegExp(`^/api/workspaces/(${nameSegment})(?:/(onboarding|services))?$`).exec(url.pathname);
          if (match && request.method === 'GET' && (!match[2] || match[2] === 'onboarding')) {
            const name = decodeNameSegment(match[1], workspaceMessages.projectName);
            const scopeId = await workspaceScopeId(name).catch(() => null);
            json(response, 200, match[2]
              ? await recordRead('onboarding-plan', scopeId, `onboarding_plan ${name}`.slice(0, 100), () => service.onboarding(name))
              : await recordRead('workspace-inspect', scopeId, `workspace_inspect ${name}`.slice(0, 100), () => service.inspect(name)));
          } else if (match && request.method === 'POST' && match[2] === 'services') {
            const name = decodeNameSegment(match[1], workspaceMessages.projectName);
            const input = z.object({ includeUnmanaged: z.boolean().optional() }).strict().parse(await body(request));
            const scopeId = await workspaceScopeId(name).catch(() => null);
            json(response, 200, await recordRead('workspace-services', scopeId, `workspace_services ${name}`.slice(0, 100), () => service.services(name, input)));
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
      // Ambiguity carries its candidate list to the caller; every other
      // filesystem, schema and SDK error may contain private paths or
      // payloads, so only allowlisted owner messages pass through.
      if (error instanceof AmbiguousNameError) {
        json(response, 400, { error: error.message, candidates: error.candidates });
        return;
      }
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
