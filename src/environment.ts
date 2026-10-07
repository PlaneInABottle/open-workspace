import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { discover, readProposalHints, type ProposalHints, type Repository } from './discovery.js';
import {
  controlPm2Service,
  inspectPm2Services,
  listPm2Processes,
  readStartScripts,
  runPm2Action,
  runPm2Start,
  stableRootGroup,
  startPm2Service,
  type Pm2ActionRunner,
  type Pm2StartRunner,
  type ServiceRecord,
} from './services.js';
import {
  boundedEnvironment,
  observeDirtyFingerprint,
  runBoundedCommand,
  runVerification,
  type CommandRunner,
  type DirtyFingerprint,
} from './verify.js';
import { persistRunSummary, type EnvironmentReceipt } from './run-summaries.js';
import { Store, privateJsonLimit, foldName, parseNameInput, resolveEnvironmentRecord, resolveWorkspaceRecord, type EnvironmentOwned, type EnvironmentRecord, type EnvironmentService } from './store.js';
import { verifyMessages } from './verify.js';

// Canonical owner of every user-visible environment-topology message.
// http.ts composes its allowlist from this object, so a rename propagates.
export const environmentMessages = {
  envNotFound: 'Environment not found. Propose and set its topology first.',
  envLimit: 'Environment limit reached for this workspace.',
  envNameTaken: 'An environment with this name already exists in this workspace.',
  serviceLimit: 'An environment holds at most 10 services.',
  outerLimit: 'Environment registry is full.',
  oversize: 'Environment topology would exceed the private state size limit.',
  cyclic: 'Service dependencies must not form a cycle.',
  unknownDepends: 'A service depends on an unknown service id.',
  selfDepends: 'A service cannot depend on itself.',
  unknownScript: 'This repository has no runnable script with that name.',
  folderInsideRoot: 'The selected folder is not inside a registered project root.',
  kindPort: 'Services with http-200 readiness need a port; process-alive services must set port to null.',
  badTopology: 'Environment topology is invalid.',
  pmUnavailable: 'PM2 is unavailable on this machine.',
  startFailed: 'PM2 did not start the service.',
  portOccupied: 'The declared port is already occupied; the occupant was not stopped.',
  ambiguousOrphan: 'More than one live process matches this owned service; nothing was started or stopped.',
  stopFailed: 'The PM2 stop did not complete.',
  staleCleared: 'The owned process identity no longer maps to its recorded root; cleared without a stop call.',
} as const;

// 1 readiness kind in the live gate: 'http-200' is the only ready-capable
// kind. 'process-alive' is the honest non-HTTP kind — its ceiling is
// 'starting' (PM2 accepted + still exactly-mapped + alive at poll end) and
// it is NEVER reported 'ready'. Its aliveness watch uses this fixed default
// window (stated explicitly; no per-service timeout field on the kind).
export const processAliveWatchSecs = 30;

export const maxEnvironmentsPerWorkspace = 5;
export const maxServicesPerEnvironment = 10;
export const maxEnvironmentEntries = 50;

const serviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/;
const namePattern = /^[\w:.-]{1,80}$/;

const readinessInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http-200'),
    path: z.string().min(1).max(256).regex(/^\/\S*$/).optional().default('/'),
    timeoutSecs: z.number().int().min(5).max(120).optional().default(30),
  }).strict(),
  z.object({ kind: z.literal('process-alive') }).strict(),
]);

export const environmentServiceInput = z.object({
  id: z.string().regex(serviceIdPattern),
  name: z.string().regex(namePattern).optional(),
  repositoryPath: z.string().min(1).max(4096),
  scriptName: z.string().regex(namePattern),
  port: z.number().int().min(1).max(65535).nullable(),
  dependsOn: z.array(z.string().regex(serviceIdPattern)).max(10).optional().default([]),
  readiness: readinessInput,
}).strict();

export const environmentSetInput = z.object({
  name: z.string().min(1).max(100),
  services: z.array(environmentServiceInput).min(1).max(maxServicesPerEnvironment),
}).strict();

// Propose-only hint fields (single definition site): environment_propose
// output carries these per service. The tolerant inputs below accept them so
// raw propose output survives the strict SDK/HTTP boundary; set-side
// coercion (coerceProposeDraft) then applies or drops them before the
// canonical strict validation refuses unknown scripts, ghost/cyclic
// dependencies and kind/port mismatches. Bounds stay tight so oversized
// hint payloads cannot smuggle arbitrary data through.
const proposeOnlyServiceFields = {
  dependsOnSuggest: z.array(z.string().max(80)).max(10).optional(),
  scriptAlternatives: z.array(z.string().max(80)).max(10).optional(),
  portSource: z.enum(['script', 'procfile', 'none']).optional(),
  notes: z.array(z.string().max(500)).max(10).optional(),
  // dependsOn WITHOUT its [] default: the MCP SDK parses before the handler
  // runs, and an early default would read as explicit and mask a suggestion
  // from coercion. The canonical strict input still defaults [] after
  // coercion, so an explicit [] keeps winning over suggestions.
  dependsOn: z.array(z.string().regex(serviceIdPattern)).max(10).optional(),
};

export const environmentSetTolerantServiceInput = environmentServiceInput.extend(proposeOnlyServiceFields);

export const environmentSetTolerantInput = environmentSetInput.extend({
  services: z.array(environmentSetTolerantServiceInput).min(1).max(maxServicesPerEnvironment),
});

export type EnvironmentServiceDraft = z.infer<typeof environmentServiceInput>;

/**
 * Propose→set pass-through: environment_propose output feeds environment_set
 * without hand-mapping. `dependsOnSuggest` becomes `dependsOn` (an explicit
 * `dependsOn` always wins); propose-only hints (`scriptAlternatives`,
 * `portSource`, `notes`) are dropped. Everything else passes through
 * untouched, so set-side refusals stay intact — including the empty
 * `scriptName` of a no-script proposal, unknown/cyclic dependencies, and
 * port-vs-kind mismatches.
 */
export function coerceProposeDraft(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.services)) return input;
  return {
    ...record,
    services: record.services.map(service => {
      if (!service || typeof service !== 'object' || Array.isArray(service)) return service;
      const entry = { ...(service as Record<string, unknown>) };
      if (entry.dependsOn === undefined && entry.dependsOnSuggest !== undefined) {
        entry.dependsOn = entry.dependsOnSuggest;
      }
      delete entry.dependsOnSuggest;
      delete entry.scriptAlternatives;
      delete entry.portSource;
      delete entry.notes;
      return entry;
    }),
  };
}

export type ServiceStatus = 'down' | 'starting' | 'ready' | 'failed' | 'skipped' | 'stale';

export interface ProposedService {
  id: string;
  name: string;
  repositoryPath: string;
  scriptName: string;
  scriptAlternatives: string[];
  port: number | null;
  portSource: 'script' | 'procfile' | 'none';
  dependsOnSuggest: string[];
  readiness: { kind: 'http-200'; path: string; timeoutSecs: number } | { kind: 'process-alive' };
  notes: string[];
}

// First valid 1–65535 port across the bounded hint texts, in order. Every
// match of every spelling is considered (an out-of-range match never blocks
// a later valid one); the earliest valid match in a text wins, and the first
// text containing one wins overall.
const portPatternSources = [/:(\d{2,5})/, /PORT=(\d{2,5})/, /--port[= ](\d{2,5})/];
export function extractPortHint(texts: string[]): number | null {
  for (const text of texts) {
    let best: { index: number; port: number } | null = null;
    for (const source of portPatternSources) {
      for (const match of text.matchAll(new RegExp(source.source, 'g'))) {
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const index = match.index ?? 0;
        if (!best || index < best.index) best = { index, port };
        break;
      }
    }
    if (best) return best.port;
  }
  return null;
}

function preferredScript(scripts: Record<string, string>): { primary: string | null; alternatives: string[] } {
  const names = Object.keys(scripts);
  const preferred = ['dev', 'start', 'serve', 'server', 'web', 'api'];
  const primary = preferred.find(name => names.includes(name))
    ?? names.find(name => /dev|start|serve/i.test(name))
    ?? names[0]
    ?? null;
  return { primary, alternatives: names.filter(name => name !== primary).slice(0, 10) };
}

// Pure derivation: discovery output in, candidates out. Nothing is executed,
// stored, or spawned here — a Procfile command with no matching package.json
// script proposes as unmapped, never as an executable command.
export function proposeEnvironment(
  candidates: Array<{ repository: Repository; hints: ProposalHints }>,
): { services: ProposedService[]; order: string[] } {
  const services: ProposedService[] = [];
  for (const { repository, hints } of candidates) {
    const { primary, alternatives } = preferredScript(hints.scripts);
    const notes: string[] = [];
    if (repository.composeFiles.length > 0) {
      notes.push(`Compose is presence-only (${repository.composeFiles.join(', ')} is not controlled).`);
    }
    for (const entry of hints.procfile) {
      const mapped = Object.keys(hints.scripts).some(script =>
        script === entry.name || hints.scripts[script].includes(entry.command.slice(0, 40)));
      if (!mapped) notes.push(`Procfile "${entry.name}" is unmapped — pick the npm script that runs it.`);
    }
    if (hints.makefileTargets.length > 0) {
      notes.push(`Makefile targets are hints only (${hints.makefileTargets.slice(0, 5).join(', ')}${hints.makefileTargets.length > 5 ? ', …' : ''}); execution stays on npm scripts.`);
    }
    const scriptBodies = Object.values(hints.scripts);
    const procfileText = hints.procfile.map(entry => `${entry.name}: ${entry.command}`);
    const port = primary === null ? null : extractPortHint([...scriptBodies, ...procfileText]);
    const portSource = port === null ? 'none'
      : extractPortHint(scriptBodies) !== null ? 'script' : 'procfile';
    if (primary === null) {
      services.push({
        id: repository.name,
        name: repository.name.slice(0, 80),
        repositoryPath: repository.path,
        scriptName: '',
        scriptAlternatives: [],
        port: null,
        portSource: 'none',
        dependsOnSuggest: [],
        readiness: { kind: 'process-alive' },
        notes: [...notes, 'No runnable npm script found — set a script before up.'],
      });
      continue;
    }
    services.push({
      id: repository.name,
      name: repository.name.slice(0, 80),
      repositoryPath: repository.path,
      scriptName: primary,
      scriptAlternatives: alternatives,
      port,
      portSource,
      dependsOnSuggest: [],
      readiness: port === null
        ? { kind: 'process-alive' }
        : { kind: 'http-200', path: '/', timeoutSecs: 30 },
      notes,
    });
  }
  // Basename collisions across roots (two `backend/` dirs) would otherwise
  // produce duplicate ids: order would silently drop one and set would
  // refuse the pair as badTopology. Choice: deterministic `--2`, `--3`
  // qualification on collision (first keeps the bare name), applied to both
  // id and PM2 name before dependency suggestions and ordering are derived.
  const usedIds = new Set<string>();
  for (const service of services) {
    if (!usedIds.has(service.id)) {
      usedIds.add(service.id);
      continue;
    }
    let counter = 2;
    while (usedIds.has(`${service.id}--${counter}`)) counter += 1;
    service.id = `${service.id}--${counter}`;
    service.name = `${service.name}--${counter}`.slice(0, 80);
    usedIds.add(service.id);
  }
  // Dependency suggestion: a frontend-like service likely starts after a
  // backend-like one. Suggestions only — set validates the final DAG.
  // (De-duplicated ids above are final, so suggestions reference them.)
  const frontend = services.find(service => /front|web|client|ui/i.test(service.id));
  const backend = services.find(service => /back|api|server/i.test(service.id) && service !== frontend);
  if (frontend && backend && frontend !== backend) {
    frontend.dependsOnSuggest = [backend.id];
  }
  return { services, order: topologicalOrder(services.map(service => ({ id: service.id, dependsOn: service.dependsOnSuggest }))) };
}

export function topologicalOrder(services: Array<{ id: string; dependsOn: string[] }>): string[] {
  const ids = new Set(services.map(service => service.id));
  const visited = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const visit = (id: string) => {
    const state = visited.get(id);
    if (state === 'done') return;
    if (state === 'visiting') throw new Error(environmentMessages.cyclic);
    visited.set(id, 'visiting');
    for (const dep of services.find(service => service.id === id)?.dependsOn ?? []) {
      if (ids.has(dep)) visit(dep);
    }
    visited.set(id, 'done');
    order.push(id);
  };
  for (const service of services) visit(service.id);
  return order;
}

async function canonicalRepository(workspaceRoots: string[], repositoryPath: string): Promise<{ repository: string; exactRoot: string }> {
  if (typeof repositoryPath !== 'string' || !isAbsolute(repositoryPath)
    || repositoryPath.includes('\0') || repositoryPath.length > 4096) {
    throw new Error(environmentMessages.folderInsideRoot);
  }
  let repository: string;
  try {
    repository = resolve(await realpath(resolve(repositoryPath)));
  } catch {
    throw new Error(environmentMessages.folderInsideRoot);
  }
  const group = await stableRootGroup(workspaceRoots, repository);
  if (group.matchedRoots.length !== 1 || !group.exactRootPath) {
    throw new Error(environmentMessages.folderInsideRoot);
  }
  return { repository, exactRoot: group.exactRootPath };
}

async function validatedServices(
  workspaceRoots: string[],
  drafts: EnvironmentServiceDraft[],
  readScripts: typeof readStartScripts = readStartScripts,
): Promise<EnvironmentService[]> {
  const ids = new Set(drafts.map(draft => draft.id));
  if (ids.size !== drafts.length) throw new Error(environmentMessages.badTopology);
  const services: EnvironmentService[] = [];
  for (const draft of drafts) {
    const dependsOn = draft.dependsOn ?? [];
    for (const dep of dependsOn) {
      if (dep === draft.id) throw new Error(environmentMessages.selfDepends);
      if (!ids.has(dep)) throw new Error(environmentMessages.unknownDepends);
    }
    // Port-vs-kind cross-check: http-200 requires a port, process-alive
    // forbids one. Reuses the startPm2Service script-validation path below
    // (exported readStartScripts — no divergent reimplementation).
    if (draft.readiness.kind === 'http-200' ? draft.port === null : draft.port !== null) {
      throw new Error(environmentMessages.kindPort);
    }
    const { repository } = await canonicalRepository(workspaceRoots, draft.repositoryPath);
    const scripts = await readScripts(resolve(repository, 'package.json'));
    const body = scripts?.[draft.scriptName];
    if (typeof body !== 'string' || !body) throw new Error(environmentMessages.unknownScript);
    services.push({
      id: draft.id,
      ...(draft.name === undefined ? {} : { name: draft.name }),
      repositoryPath: repository,
      scriptName: draft.scriptName,
      port: draft.port,
      dependsOn,
      readiness: draft.readiness.kind === 'http-200'
        ? { kind: 'http-200' as const, path: draft.readiness.path ?? '/', timeoutSecs: draft.readiness.timeoutSecs ?? 30 }
        : { kind: 'process-alive' as const },
    });
  }
  topologicalOrder(services);
  return services;
}

export async function setEnvironment(
  store: Store,
  workspaceName: string,
  input: unknown,
  readScripts: typeof readStartScripts = readStartScripts,
): Promise<EnvironmentRecord> {
  const parsed = environmentSetInput.parse(coerceProposeDraft(input));
  // Validate before matching/storing: an unresolvable name (UUID-shaped,
  // bad charset, blank) must never persist and occupy an env slot.
  const name = parseNameInput(parsed.name, environmentMessages.badTopology);
  const state = await store.read();
  const workspace = resolveWorkspaceRecord(state, workspaceName, verifyMessages.notFoundRegister, verifyMessages.notFoundRegister);
  const workspaceId = workspace.id;
  const services = await validatedServices(workspace.roots, parsed.services, readScripts);
  return store.update(state => {
    let entry = state.environments.find(entry => entry.workspaceId === workspaceId);
    if (!entry) {
      if (state.environments.length >= maxEnvironmentEntries) throw new Error(environmentMessages.outerLimit);
      entry = { workspaceId, items: [] };
      state.environments.push(entry);
    }
    // Names match case-insensitively: set replaces per name, so `Local`
    // never duplicates `local`. Stored casing is preserved; rename is the
    // explicit path for changing it.
    const existing = entry.items.find(item => foldName(item.name) === foldName(name));
    if (!existing && entry.items.length >= maxEnvironmentsPerWorkspace) {
      throw new Error(environmentMessages.envLimit);
    }
    const now = new Date().toISOString();
    let record: EnvironmentRecord;
    if (existing) {
      // Services-only replacement: owned intent and lifecycle state are
      // preserved. A topology change while state != down leaves the old
      // process stale-tracked (reported, never killed — M2 down reconciles).
      existing.services = services;
      existing.updatedAt = now;
      record = existing;
    } else {
      record = { name, id: randomUUID(), services, owned: [], state: 'down', updatedAt: now, createdAt: now };
      entry.items.push(record);
    }
    // Pre-commit serialized-size refusal: the file stays byte-identical when
    // the write would exceed the private-state ceiling (no cap raise, ever).
    // Measured with the writer's exact serialization (2-space pretty print).
    const serialized = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > privateJsonLimit) throw new Error(environmentMessages.oversize);
    return record;
  });
}

export async function getEnvironment(store: Store, workspaceName: string, environmentName: string): Promise<EnvironmentRecord> {
  const state = await store.read();
  return resolveEnvironmentRecord(state, workspaceName, environmentName, {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  }).record;
}

export async function listEnvironments(store: Store, workspaceName: string): Promise<EnvironmentRecord[]> {
  const state = await store.read();
  const workspace = resolveWorkspaceRecord(state, workspaceName, verifyMessages.notFoundRegister, verifyMessages.notFoundRegister);
  return state.environments.find(entry => entry.workspaceId === workspace.id)?.items ?? [];
}

/**
 * Explicit rename: the new name validates like creation, conflicts with a
 * taken sibling name are refused, and the ID plus owned processes,
 * lifecycle state, services and timestamps are preserved untouched.
 */
export async function renameEnvironment(
  store: Store,
  workspaceName: string,
  environmentName: string,
  newName: string,
): Promise<EnvironmentRecord> {
  const trimmed = parseNameInput(newName, environmentMessages.badTopology);
  const messages = {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  };
  return store.update(state => {
    const { workspace, record } = resolveEnvironmentRecord(state, workspaceName, environmentName, messages);
    const items = state.environments.find(entry => entry.workspaceId === workspace.id)?.items ?? [];
    if (foldName(record.name) !== foldName(trimmed)
      && items.some(item => foldName(item.name) === foldName(trimmed))) {
      throw new Error(environmentMessages.envNameTaken);
    }
    record.name = trimmed;
    record.updatedAt = new Date().toISOString();
    return record;
  });
}

export interface ServiceStatusEntry {
  serviceId: string;
  name: string;
  status: ServiceStatus;
  detail: string;
  owned: EnvironmentOwned | null;
}

export interface EnvironmentStatus {
  environmentId: string;
  name: string;
  state: EnvironmentRecord['state'];
  order: string[];
  services: ServiceStatusEntry[];
}

// Read-only status: the only process contact is read-only `pm2 jlist`
// through the injected list seam (same as the dashboard services inventory). Nothing is
// started, stopped, or probed. M1 ceiling is 'starting' for alive-but-unpolled
// processes — without the M2 readiness poll no service is reported
// 'ready'/'skipped'; terminal PM2 states map honestly to 'down'/'failed'.
export async function environmentStatus(
  store: Store,
  workspaceName: string,
  environmentName: string,
  list: typeof listPm2Processes = listPm2Processes,
): Promise<EnvironmentStatus> {
  const state = await store.read();
  const { workspace, record } = resolveEnvironmentRecord(state, workspaceName, environmentName, {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  });
  const listed = await list();
  const live = listed.available ? await inspectPm2Services(workspace.roots, listed.processes) : null;
  const known = live ? [...live.services, ...live.ambiguousServices] : [];
  const entries: ServiceStatusEntry[] = record.services.map(service => {
    const owned = record.owned.find(entry => entry.serviceId === service.id) ?? null;
    if (!owned || !live) {
      return {
        serviceId: service.id,
        name: service.name ?? service.id,
        status: 'down',
        detail: owned ? 'Service metadata is unavailable.' : 'No owned process is recorded.',
        owned,
      };
    }
    if (owned.pmId === null) {
      // A recorded poll outranks the bare intent: port-refused and
      // start-failed up paths persist lastPoll failed with pmId null (no
      // process was ever recorded), and status must not mask that as
      // starting. A bare intent with no poll is still starting.
      if (owned.lastPoll?.status === 'failed') {
        return {
          serviceId: service.id,
          name: owned.name,
          status: 'failed',
          detail: 'The recorded start did not succeed; no owned process is running.',
          owned,
        };
      }
      if (owned.lastPoll?.status === 'skipped') {
        return {
          serviceId: service.id,
          name: owned.name,
          status: 'skipped',
          detail: 'The service was skipped because a dependency did not start.',
          owned,
        };
      }
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'starting',
        detail: 'Start intent is recorded; the starter has not reported back.',
        owned,
      };
    }
    // Recycled-pmId guard: pmId alone proves nothing. The fresh mapping must
    // match pmId + name with a canonical root equal to the frozen
    // expectedRoot and a symmetric namespace, or the entry is stale and
    // never touched. The namespace compare is symmetric (not "both set and
    // differ"): phase (b) fills the actual namespace before pmId is non-null,
    // so a live null against an owned 'prod' (or vice versa) is an identity
    // change, not a match.
    const match = known.find(candidate => candidate.pmId === owned.pmId && candidate.name === owned.name);
    if (!match || match.exactRootPath !== owned.expectedRoot || match.namespace !== owned.namespace) {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'stale',
        detail: 'The owned process identity no longer maps to its recorded root.',
        owned,
      };
    }
    // Terminal PM2 states are reported honestly, not collapsed to starting:
    // a stopped owned process is down, an errored one failed. Anything else
    // alive-but-unpolled stays starting (M1 performs no readiness poll, so
    // ready/skipped are still M2-only).
    if (match.status === 'stopped') {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'down',
        detail: 'The owned process is stopped.',
        owned,
      };
    }
    if (match.status === 'errored') {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'failed',
        detail: 'The owned process errored.',
        owned,
      };
    }
    // M2 phase-(c) honesty: a mapped, alive process reports its last polled
    // outcome. Without a poll (null) the ceiling stays 'starting' — M1
    // behavior is preserved for pre-M2 owned entries.
    if (owned.lastPoll?.status === 'ready') {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'ready',
        detail: 'The last readiness poll succeeded.',
        owned,
      };
    }
    if (owned.lastPoll?.status === 'failed') {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'failed',
        detail: 'The last readiness poll did not succeed.',
        owned,
      };
    }
    if (owned.lastPoll?.status === 'skipped') {
      return {
        serviceId: service.id,
        name: owned.name,
        status: 'skipped',
        detail: 'The service was skipped because a dependency did not start.',
        owned,
      };
    }
    return {
      serviceId: service.id,
      name: owned.name,
      status: 'starting',
      detail: service.readiness.kind === 'process-alive'
        ? 'The worker process is alive; process-alive services report at most starting.'
        : 'The process is mapped; readiness is polled on up.',
      owned,
    };
  });
  // Owned entries whose service left the topology stay stale-tracked:
  // reported, never killed.
  for (const owned of record.owned) {
    if (record.services.some(service => service.id === owned.serviceId)) continue;
    entries.push({
      serviceId: owned.serviceId,
      name: owned.name,
      status: 'stale',
      detail: 'The service left the topology; its old process is tracked, never stopped here.',
      owned,
    });
  }
  return {
    environmentId: record.id,
    name: record.name,
    state: record.state,
    order: topologicalOrder(record.services),
    services: entries,
  };
}

export async function proposeForWorkspace(
  store: Store,
  workspaceName: string,
): Promise<{ services: ProposedService[]; order: string[] }> {
  const state = await store.read();
  const workspace = resolveWorkspaceRecord(state, workspaceName, verifyMessages.notFoundRegister, verifyMessages.notFoundRegister);
  const roots = await Promise.all(workspace.roots.map(async root => {
    try {
      return await discover(root);
    } catch {
      return null;
    }
  }));
  const candidates: Array<{ repository: Repository; hints: ProposalHints }> = [];
  for (const inspection of roots) {
    if (!inspection) continue;
    for (const repository of inspection.repositories) {
      if (candidates.length >= maxServicesPerEnvironment) break;
      candidates.push({ repository, hints: await readProposalHints(repository.path) });
    }
  }
  return proposeEnvironment(candidates);
}

// ---------------------------------------------------------------------------
// Milestone 2: ordered up + readiness + owned-only down + receipt-bound E2E.
// All runtime seams are injectable (same fake-able shape as
// services-start.test.ts); production passes the real runners through
// WorkspaceService. Nothing here kills by port or name, and foreign
// processes/listeners are never addressed: stops go only to owned pmIds that
// still match pmId + name + namespace + frozen expectedRoot.
// ---------------------------------------------------------------------------

export const environmentUpInput = z.object({ environment: z.string().min(1).max(100) }).strict();
export const environmentDownInput = z.object({ environment: z.string().min(1).max(100) }).strict();
export const environmentVerifyInput = z.object({
  environment: z.string().min(1).max(100),
  repositoryPath: z.string().min(1).max(4096),
  scriptName: z.string().min(1).max(80),
}).strict();

export type EnvironmentUpServiceStatus = 'ready' | 'starting' | 'failed' | 'skipped';

export interface EnvironmentUpServiceResult {
  serviceId: string;
  name: string;
  status: EnvironmentUpServiceStatus;
  detail: string;
  attempts: number;
  lastStatus: number | null;
  pmId: number | null;
  adopted: boolean;
}

export interface EnvironmentUpResult {
  environmentId: string;
  name: string;
  state: EnvironmentRecord['state'];
  order: string[];
  services: EnvironmentUpServiceResult[];
}

export interface EnvironmentDownServiceResult {
  serviceId: string;
  name: string;
  status: 'down' | 'stale' | 'failed';
  detail: string;
  pmId: number | null;
  adopted: boolean;
}

export interface EnvironmentDownResult {
  environmentId: string;
  name: string;
  state: EnvironmentRecord['state'];
  order: string[];
  services: EnvironmentDownServiceResult[];
}

export interface EnvironmentVerifyServiceSnapshot {
  serviceId: string;
  name: string;
  pmId: number;
  namespace: string | null;
  status: string;
  revision: string | null;
  dirty: DirtyFingerprint | null;
}

export interface EnvironmentVerifyResult {
  environmentId: string;
  name: string;
  outcome: 'passed' | 'failed' | 'error';
  runId: string | null;
  repositoryPath: string;
  scriptName: string;
  services: EnvironmentVerifyServiceSnapshot[];
  message: string;
}

export interface EnvironmentRuntime {
  list?: typeof listPm2Processes;
  starter?: Pm2StartRunner;
  runner?: Pm2ActionRunner;
  /** Returns true when a loopback TCP connect succeeds (port occupied). No payload is ever sent. */
  probe?: (port: number) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  runCommand?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  /** Readiness poll cadence, default 1000 ms. */
  pollIntervalMs?: number;
  /** process-alive aliveness watch, default processAliveWatchSecs. */
  processAliveWatchMs?: number;
  /** Abort for the receipt E2E command (wired from the HTTP socket close). */
  signal?: AbortSignal;
}

const portProbeTimeoutMs = 500;
const readinessAttemptTimeoutMs = 3000;
const defaultPollIntervalMs = 1000;
const suggestionScanWidth = 10;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Loopback TCP preflight: a successful connect means occupied. The socket is
// destroyed immediately and no payload is sent — this never disturbs the
// occupant, foreign or owned.
export function probeTcpPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (occupied: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // Destruction is best-effort; the probe answer stands.
      }
      resolve(occupied);
    };
    const socket = connect({ host: '127.0.0.1', port, timeout: portProbeTimeoutMs });
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function suggestFreePort(
  port: number,
  probe: (port: number) => Promise<boolean> = probeTcpPort,
): Promise<number | null> {
  for (let candidate = port + 1; candidate <= port + suggestionScanWidth; candidate += 1) {
    if (candidate > 65535) return null;
    try {
      if (!(await probe(candidate))) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower === '127.0.0.1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  if (lower === '::ffff:127.0.0.1' || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  return false;
}

export interface ReadinessPollResult {
  ok: boolean;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  latencyMs: number | null;
}

// http-200 readiness: GET http://127.0.0.1:<port><path> expects 200–299
// within the bounded window. Redirects are never followed blindly: a
// loopback target is followed as a new attempt, an outside-loopback target
// is a failed attempt. One success marks ready; attempts + last status +
// latency are reported either way. Port-open is never ready by itself.
export async function pollHttpReadiness(input: {
  port: number;
  path: string;
  timeoutMs: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  attemptTimeoutMs?: number;
}): Promise<ReadinessPollResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? defaultPollIntervalMs;
  const attemptTimeoutMs = input.attemptTimeoutMs ?? readinessAttemptTimeoutMs;
  let target = `http://127.0.0.1:${input.port}${input.path}`;
  const deadline = now() + input.timeoutMs;
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  for (;;) {
    if (now() >= deadline) break;
    attempts += 1;
    const started = now();
    try {
      const response = await fetchImpl(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, attempts, lastStatus: response.status, lastError: null, latencyMs: now() - started };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          try {
            const next = new URL(location, target);
            if ((next.protocol === 'http:' || next.protocol === 'https:') && isLoopbackHostname(next.hostname)) {
              target = next.toString();
              lastStatus = response.status;
              lastError = null;
            } else {
              lastStatus = response.status;
              lastError = 'redirect-outside-loopback';
            }
          } catch {
            lastStatus = response.status;
            lastError = 'redirect-unparseable';
          }
        } else {
          lastStatus = response.status;
          lastError = null;
        }
      } else {
        lastStatus = response.status;
        lastError = null;
      }
    } catch (error) {
      // Error class only (e.g. TimeoutError, TypeError on refused) — no body
      // or payload is ever captured or persisted.
      lastStatus = null;
      lastError = error instanceof Error ? error.name.slice(0, 64) : 'fetch-error';
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return { ok: false, attempts, lastStatus, lastError, latencyMs: null };
}

// process-alive honesty watch: no HTTP surface exists, so the ceiling is
// `starting` while the exactly-mapped process stays alive through the
// bounded window. Absence or a terminal state at any poll means failed.
export async function watchProcessAlive(input: {
  list: typeof listPm2Processes;
  workspaceRoots: string[];
  pmId: number;
  name: string;
  expectedRoot: string;
  watchMs: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<{ alive: boolean; attempts: number }> {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? defaultPollIntervalMs;
  const deadline = now() + input.watchMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let alive = false;
    try {
      const listed = await input.list();
      if (listed.available) {
        const mapped = await inspectPm2Services(input.workspaceRoots, listed.processes);
        const match = [...mapped.services, ...mapped.ambiguousServices]
          .find(service => service.pmId === input.pmId && service.name === input.name);
        alive = Boolean(match)
          && match?.exactRootPath === input.expectedRoot
          && match?.status !== 'stopped'
          && match?.status !== 'errored';
      }
    } catch {
      alive = false;
    }
    if (!alive) return { alive: false, attempts };
    if (now() >= deadline) return { alive: true, attempts };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

async function expectedRootOf(workspaceRoots: string[], repositoryPath: string): Promise<string> {
  const group = await stableRootGroup(workspaceRoots, resolve(repositoryPath));
  if (group.matchedRoots.length !== 1 || !group.exactRootPath) {
    throw new Error(environmentMessages.folderInsideRoot);
  }
  return group.exactRootPath;
}

async function withEnvironmentRecord<T>(
  store: Store,
  workspaceName: string,
  environmentName: string,
  change: (record: EnvironmentRecord) => T | Promise<T>,
  options: { write: boolean } = { write: true },
): Promise<{ workspaceRoots: string[]; workspaceId: string; environmentId: string; result: Awaited<T> }> {
  const messages = {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  };
  if (options.write) {
    return store.update(async state => {
      const { workspace, record } = resolveEnvironmentRecord(state, workspaceName, environmentName, messages);
      return {
        workspaceRoots: [...workspace.roots],
        workspaceId: workspace.id,
        environmentId: record.id,
        result: await change(record),
      };
    });
  }
  const state = await store.read();
  const { workspace, record } = resolveEnvironmentRecord(state, workspaceName, environmentName, messages);
  return {
    workspaceRoots: [...workspace.roots],
    workspaceId: workspace.id,
    environmentId: record.id,
    result: await change(record),
  };
}

function upsertOwned(
  record: EnvironmentRecord,
  entry: EnvironmentRecord['owned'][number],
): void {
  const index = record.owned.findIndex(existing => existing.serviceId === entry.serviceId);
  if (index >= 0) record.owned[index] = entry;
  else record.owned.push(entry);
  record.updatedAt = new Date().toISOString();
}

function clearOwned(record: EnvironmentRecord, serviceId: string): void {
  record.owned = record.owned.filter(existing => existing.serviceId !== serviceId);
  record.updatedAt = new Date().toISOString();
}

function liveMatch(
  known: ServiceRecord[],
  pmId: number,
  name: string,
  expectedRoot: string,
  namespace: string | null,
): ServiceRecord | null {
  const candidate = known.find(service => service.pmId === pmId && service.name === name);
  if (!candidate || candidate.exactRootPath !== expectedRoot || candidate.namespace !== namespace) return null;
  return candidate;
}

function isTerminalStatus(status: string): boolean {
  return status === 'stopped' || status === 'errored';
}

export async function environmentUp(
  store: Store,
  workspaceName: string,
  environmentName: string,
  runtime: EnvironmentRuntime = {},
): Promise<EnvironmentUpResult> {
  const list = runtime.list ?? listPm2Processes;
  const starter = runtime.starter ?? runPm2Start;
  const probe = runtime.probe ?? probeTcpPort;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const sleep = runtime.sleep ?? defaultSleep;
  const now = runtime.now ?? Date.now;
  const intervalMs = runtime.pollIntervalMs ?? defaultPollIntervalMs;
  const aliveWatchMs = runtime.processAliveWatchMs ?? processAliveWatchSecs * 1000;
  const { workspaceRoots, result: plan } = await withEnvironmentRecord(store, workspaceName, environmentName, record => ({
    name: record.name,
    order: topologicalOrder(record.services),
    services: record.services.map(service => ({ ...service })),
    owned: record.owned.map(entry => ({ ...entry })),
  }), { write: false });
  const byId = new Map(plan.services.map(service => [service.id, service]));
  const ownedById = new Map(plan.owned.map(entry => [entry.serviceId, entry]));
  const outcomes = new Map<string, EnvironmentUpServiceStatus>();
  const results: EnvironmentUpServiceResult[] = [];
  // Byte-identical refusal: when nothing owned changes (PM2 unreadable, every
  // service skipped/refused before any intent), the final state write is
  // skipped so the file is untouched.
  let mutated = false;
  const commit = async (change: (record: EnvironmentRecord) => void): Promise<void> => {
    await withEnvironmentRecord(store, workspaceName, environmentName, record => { change(record); });
    mutated = true;
  };
  for (const serviceId of plan.order) {
    const service = byId.get(serviceId);
    if (!service) continue;
    const failed = (status: EnvironmentUpServiceStatus, detail: string, extra: Partial<EnvironmentUpServiceResult> = {}) => {
      outcomes.set(serviceId, status);
      results.push({
        serviceId,
        name: service.name ?? service.id,
        status,
        detail,
        attempts: 0,
        lastStatus: null,
        pmId: ownedById.get(serviceId)?.pmId ?? null,
        adopted: false,
        ...extra,
      });
    };
    if (service.dependsOn.some(dep => outcomes.get(dep) !== 'ready' && outcomes.get(dep) !== 'starting')) {
      failed('skipped', `A dependency did not start; ${serviceId} was never started.`);
      continue;
    }
    let expectedRoot: string;
    try {
      expectedRoot = await expectedRootOf(workspaceRoots, service.repositoryPath);
    } catch {
      failed('failed', environmentMessages.folderInsideRoot);
      continue;
    }
    const pmName = service.name ?? service.id;
    const listed = await list();
    if (!listed.available) {
      failed('failed', environmentMessages.pmUnavailable);
      continue;
    }
    const mapped = await inspectPm2Services(workspaceRoots, listed.processes);
    const known = [...mapped.services, ...mapped.ambiguousServices];
    const owned = ownedById.get(serviceId);
    let pmId: number | null = null;
    let adopted = false;
    let adoptName = owned?.name ?? pmName;
    if (owned && owned.pmId !== null) {
      const match = liveMatch(known, owned.pmId, owned.name, owned.expectedRoot, owned.namespace);
      if (match && !isTerminalStatus(match.status)) {
        pmId = owned.pmId;
      } else {
        // Stale-owned (pmId absent, mapping ambiguous/foreign, root drift, or
        // terminal): cleared WITHOUT any kill, then reconciled below.
        await commit(record => clearOwned(record, serviceId));
        ownedById.delete(serviceId);
      }
    }
    if (pmId === null) {
      // Single-match adoption (F3): a stored intent with pmId null (crash
      // between spawn and fill) — or a just-cleared stale entry — plus
      // exactly one live process with our name + frozen root is ours.
      // Terminal (stopped/errored) processes are never adopted: a dead
      // orphan is a zero-match, so the next step starts fresh instead of
      // recording a pmId that can never become ready.
      const candidates = mapped.services.filter(
        service => service.name === adoptName && service.exactRootPath === expectedRoot && !isTerminalStatus(service.status),
      );
      if (candidates.length === 1 && candidates[0].pmId !== null) {
        pmId = candidates[0].pmId;
        adopted = true;
        adoptName = candidates[0].name;
        const filled = {
          serviceId,
          pmId,
          name: candidates[0].name,
          namespace: candidates[0].namespace,
          expectedRoot,
          lastPoll: null,
        } as EnvironmentRecord['owned'][number];
        await commit(record => upsertOwned(record, filled));
        ownedById.set(serviceId, { ...filled });
      } else if (candidates.length >= 2) {
        failed('failed', environmentMessages.ambiguousOrphan);
        continue;
      }
    }
    if (pmId === null) {
      // Fresh start: phase (a) persists the intent BEFORE spawning so a
      // crash here leaves an adoptable intent, never a duplicate.
      const intent = {
        serviceId,
        pmId: null,
        name: pmName,
        namespace: null,
        expectedRoot,
        lastPoll: null,
      } as EnvironmentRecord['owned'][number];
      await commit(record => upsertOwned(record, intent));
      ownedById.set(serviceId, { ...intent });
      adoptName = pmName;
      if (service.readiness.kind === 'http-200' && typeof service.port === 'number') {
        let occupied = false;
        try {
          occupied = await probe(service.port);
        } catch {
          occupied = false;
        }
        if (occupied) {
          const suggestion = await suggestFreePort(service.port, probe);
          const detail = suggestion === null
            ? `${environmentMessages.portOccupied} Port ${service.port} is already occupied; no free port was found nearby.`
            : `${environmentMessages.portOccupied} Port ${service.port} is already occupied; ${suggestion} looks free (change the topology — no auto-rebind).`;
          await commit(record => {
            const entry = record.owned.find(existing => existing.serviceId === serviceId);
            if (entry) entry.lastPoll = { status: 'failed', attempts: 0, httpStatus: null, checkedAt: new Date().toISOString() };
          });
          failed('failed', detail);
          continue;
        }
      }
      const started = await startPm2Service(
        workspaceRoots,
        { repositoryPath: service.repositoryPath, scriptName: service.scriptName, name: pmName },
        list,
        starter,
      );
      if (started.status !== 'completed') {
        await commit(record => {
          const entry = record.owned.find(existing => existing.serviceId === serviceId);
          if (entry) entry.lastPoll = { status: 'failed', attempts: 0, httpStatus: null, checkedAt: new Date().toISOString() };
        });
        failed('failed', started.message === 'PM2 is unavailable.' ? environmentMessages.pmUnavailable : environmentMessages.startFailed);
        continue;
      }
      // Phase (b): fill pmId/namespace IMMEDIATELY after the starter
      // returns, before any dependent probe or readiness poll.
      pmId = started.target.pmId;
      const filled = {
        serviceId,
        pmId,
        name: pmName,
        namespace: started.target.namespace,
        expectedRoot,
        lastPoll: null,
      } as EnvironmentRecord['owned'][number];
      await commit(record => upsertOwned(record, filled));
      ownedById.set(serviceId, { ...filled });
    }
    if (pmId === null) {
      failed('failed', environmentMessages.startFailed);
      continue;
    }
    const currentPmId: number = pmId;
    if (service.readiness.kind === 'process-alive') {
      // process-alive aliveness watch within the same window: staying alive
      // reports starting (never ready); exiting reports failed.
      const watch = await watchProcessAlive({
        list, workspaceRoots, pmId: currentPmId, name: adoptName, expectedRoot,
        watchMs: aliveWatchMs, intervalMs, sleep, now,
      });
      const status = watch.alive ? 'starting' : 'failed';
      const detail = watch.alive
        ? `${adopted ? 'Adopted the single matching live process; ' : ''}the worker stayed alive for the bounded watch — process-alive services report at most starting, never ready.`
        : 'The worker process exited during the bounded aliveness watch.';
      await commit(record => {
        const entry = record.owned.find(existing => existing.serviceId === serviceId);
        if (entry) {
          entry.name = adoptName;
          entry.lastPoll = { status, attempts: watch.attempts, httpStatus: null, checkedAt: new Date().toISOString() };
        }
      });
      outcomes.set(serviceId, status);
      results.push({
        serviceId, name: adoptName, status, detail,
        attempts: watch.attempts, lastStatus: null, pmId: currentPmId, adopted,
      });
      continue;
    }
    const timeoutSecs = service.readiness.kind === 'http-200' ? service.readiness.timeoutSecs : 30;
    const path = service.readiness.kind === 'http-200' ? service.readiness.path : '/';
    const port = service.port;
    if (typeof port !== 'number') {
      failed('failed', environmentMessages.kindPort);
      continue;
    }
    const poll = await pollHttpReadiness({ port, path, timeoutMs: timeoutSecs * 1000, intervalMs, fetchImpl, sleep, now });
    const status = poll.ok ? 'ready' : 'failed';
    const detail = poll.ok
      ? `${adopted ? 'Adopted the single matching live process; ' : ''}readiness probe returned ${poll.lastStatus} after ${poll.attempts} attempt(s).`
      : `Readiness probe did not return 2xx within ${timeoutSecs}s (attempts: ${poll.attempts}, last status: ${poll.lastStatus ?? poll.lastError ?? 'none'}).`;
    await commit(record => {
      const entry = record.owned.find(existing => existing.serviceId === serviceId);
      if (entry) {
        entry.name = adoptName;
        entry.lastPoll = { status, attempts: poll.attempts, httpStatus: poll.lastStatus, checkedAt: new Date().toISOString() };
      }
    });
    outcomes.set(serviceId, status);
    results.push({
      serviceId, name: adoptName, status, detail,
      attempts: poll.attempts, lastStatus: poll.lastStatus, pmId: currentPmId, adopted,
    });
  }
  const live = results.filter(entry => entry.status === 'ready' || entry.status === 'starting');
  const stored = await withEnvironmentRecord(store, workspaceName, environmentName, record => ({
    state: record.state,
  }), { write: false });
  const nextState: EnvironmentRecord['state'] = live.length === results.length && results.length > 0
    ? 'up'
    : live.length > 0 ? 'partial' : 'down';
  // No evidence, no state change: when nothing owned was written (PM2
  // unreadable, every service refused before any intent), the stored state
  // stands and the file is untouched.
  if (mutated) {
    await withEnvironmentRecord(store, workspaceName, environmentName, record => {
      record.state = nextState;
      record.updatedAt = new Date().toISOString();
    });
  }
  return { environmentId: stored.environmentId, name: plan.name, state: mutated ? nextState : stored.result.state, order: plan.order, services: results };
}

export async function environmentDown(
  store: Store,
  workspaceName: string,
  environmentName: string,
  runtime: EnvironmentRuntime = {},
): Promise<EnvironmentDownResult> {
  const list = runtime.list ?? listPm2Processes;
  const stopRunner = runtime.runner ?? runPm2Action;
  const { workspaceRoots, result: plan } = await withEnvironmentRecord(store, workspaceName, environmentName, record => ({
    name: record.name,
    order: topologicalOrder(record.services).reverse(),
    owned: record.owned.map(entry => ({ ...entry })),
  }), { write: false });
  const knownIds = new Set(plan.order);
  const ordered = [
    ...plan.owned.filter(entry => knownIds.has(entry.serviceId))
      .sort((a, b) => plan.order.indexOf(a.serviceId) - plan.order.indexOf(b.serviceId)),
    ...plan.owned.filter(entry => !knownIds.has(entry.serviceId)).reverse(),
  ];
  const results: EnvironmentDownServiceResult[] = [];
  let mutated = false;
  const commit = async (change: (record: EnvironmentRecord) => void): Promise<void> => {
    await withEnvironmentRecord(store, workspaceName, environmentName, record => { change(record); });
    mutated = true;
  };
  for (const owned of ordered) {
    const done = (status: EnvironmentDownServiceResult['status'], detail: string, adopted = false) => {
      results.push({ serviceId: owned.serviceId, name: owned.name, status, detail, pmId: owned.pmId, adopted });
    };
    const listed = await list();
    if (!listed.available) {
      done('failed', environmentMessages.pmUnavailable);
      continue;
    }
    const mapped = await inspectPm2Services(workspaceRoots, listed.processes);
    const known = [...mapped.services, ...mapped.ambiguousServices];
    if (owned.pmId === null) {
      // Leftover pre-spawn intent: only a single live name + root match is
      // adoptable; anything else clears without touching anything.
      const candidates = mapped.services.filter(
        service => service.name === owned.name && service.exactRootPath === owned.expectedRoot,
      );
      if (candidates.length === 1 && candidates[0].pmId !== null) {
        const target = { pmId: candidates[0].pmId, name: candidates[0].name, namespace: candidates[0].namespace };
        const stopped = await controlPm2Service(workspaceRoots, 'stop', target, list, stopRunner);
        if (stopped.status === 'completed') {
          await commit(record => clearOwned(record, owned.serviceId));
          results.push({ serviceId: owned.serviceId, name: owned.name, status: 'down', detail: 'Adopted the single matching live process and stopped it.', pmId: target.pmId, adopted: true });
        } else {
          done('failed', environmentMessages.stopFailed, true);
        }
      } else {
        await commit(record => clearOwned(record, owned.serviceId));
        done('stale', environmentMessages.staleCleared);
      }
      continue;
    }
    const match = liveMatch(known, owned.pmId, owned.name, owned.expectedRoot, owned.namespace);
    if (!match) {
      // Recycled-pmId guard: pmId alone proves nothing. Mismatch, drift, or
      // absence clears WITHOUT any kill — zero runner calls on this path.
      await commit(record => clearOwned(record, owned.serviceId));
      done('stale', environmentMessages.staleCleared);
      continue;
    }
    if (isTerminalStatus(match.status)) {
      await commit(record => clearOwned(record, owned.serviceId));
      done('down', `The owned process is already ${match.status}; cleared without a stop call.`);
      continue;
    }
    // Owned-only stop: the expectedRoot comparison above ran BEFORE any
    // runner call, and only this matched owned pmId is addressed — never a
    // port-kill, never a name-only match, never pm2 kill.
    const stopped = await controlPm2Service(
      workspaceRoots, 'stop',
      { pmId: owned.pmId, name: owned.name, namespace: owned.namespace },
      list,
      stopRunner,
    );
    if (stopped.status === 'completed') {
      await commit(record => clearOwned(record, owned.serviceId));
      done('down', 'PM2 accepted the stop.');
    } else {
      done('failed', environmentMessages.stopFailed);
    }
  }
  const stored = await withEnvironmentRecord(store, workspaceName, environmentName, record => ({
    state: record.state,
    owned: record.owned.length,
  }), { write: false });
  const nextState: EnvironmentRecord['state'] = stored.result.owned === 0 ? 'down' : 'partial';
  // No evidence, no state change: when PM2 is unreadable nothing is stopped
  // or cleared, so the stored state stands and the file is untouched.
  if (mutated) {
    await withEnvironmentRecord(store, workspaceName, environmentName, record => {
      record.state = nextState;
      record.updatedAt = new Date().toISOString();
    });
  }
  return { environmentId: stored.environmentId, name: plan.name, state: mutated ? nextState : stored.result.state, order: plan.order, services: results };
}

async function observeRepoGit(
  repository: string,
  run: CommandRunner,
): Promise<{ revision: string | null; dirty: DirtyFingerprint | null }> {
  try {
    const revision = await run('git', ['rev-parse', 'HEAD'], {
      cwd: repository, timeoutMs: 10_000, outputLimit: 4096,
      env: boundedEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
    });
    if (revision.spawnFailed || revision.exitCode !== 0) return { revision: null, dirty: null };
    const sha = revision.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { revision: null, dirty: null };
    let status;
    try {
      status = await run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
        cwd: repository, timeoutMs: 10_000, outputLimit: 64 * 1024,
        env: boundedEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
      });
    } catch {
      return { revision: sha, dirty: null };
    }
    if (status.spawnFailed || status.exitCode !== 0) return { revision: sha, dirty: null };
    if (status.stdout.split('\n').filter(line => line.length > 0).length === 0) {
      return { revision: sha, dirty: null };
    }
    try {
      return { revision: sha, dirty: await observeDirtyFingerprint(repository, run, status.stdout) };
    } catch {
      return { revision: sha, dirty: null };
    }
  } catch {
    return { revision: null, dirty: null };
  }
}

// Receipt-bound E2E: snapshot owned identities + per-service git context,
// run one repo-native script, persist a single RunSummary carrying the capped
// environment receipt. Surfaces through the existing recent-runs
// reader — no new view, no timeline fork.
export async function environmentVerify(
  store: Store,
  workspaceName: string,
  input: { environment: string; repositoryPath: string; scriptName: string },
  runtime: EnvironmentRuntime = {},
): Promise<EnvironmentVerifyResult> {
  const parsed = environmentVerifyInput.parse(input);
  const list = runtime.list ?? listPm2Processes;
  const runCommand = runtime.runCommand ?? runBoundedCommand;
  const { workspaceRoots, workspaceId, environmentId, result: plan } = await withEnvironmentRecord(store, workspaceName, parsed.environment, record => ({
    name: record.name,
    services: record.services.map(service => ({ ...service })),
    owned: record.owned.map(entry => ({ ...entry })),
  }), { write: false });
  const listed = await list();
  const inspected = listed.available ? await inspectPm2Services(workspaceRoots, listed.processes) : null;
  const known = inspected ? [...inspected.services, ...inspected.ambiguousServices] : [];
  const gitByRepo = new Map<string, { revision: string | null; dirty: DirtyFingerprint | null }>();
  const services: EnvironmentVerifyServiceSnapshot[] = [];
  for (const service of plan.services.slice(0, maxServicesPerEnvironment)) {
    const owned = plan.owned.find(entry => entry.serviceId === service.id) ?? null;
    const match = owned && owned.pmId !== null
      ? liveMatch(known, owned.pmId, owned.name, owned.expectedRoot, owned.namespace)
      : null;
    let status: string;
    if (match) {
      status = isTerminalStatus(match.status)
        ? (match.status === 'stopped' ? 'down' : 'failed')
        : (owned?.lastPoll?.status ?? 'starting');
    } else {
      status = owned ? 'stale' : 'down';
    }
    if (!gitByRepo.has(service.repositoryPath)) {
      gitByRepo.set(service.repositoryPath, await observeRepoGit(service.repositoryPath, runCommand));
    }
    const git = gitByRepo.get(service.repositoryPath) ?? { revision: null, dirty: null };
    services.push({
      serviceId: service.id,
      name: owned?.name ?? service.name ?? service.id,
      pmId: owned?.pmId ?? -1,
      namespace: owned?.namespace ?? match?.namespace ?? null,
      status,
      revision: git.revision,
      dirty: git.dirty,
    });
  }
  const receipt: EnvironmentReceipt = { envId: environmentId, envName: plan.name, services };
  const verification = await runVerification(
    workspaceRoots,
    { repositoryPath: parsed.repositoryPath, scriptName: parsed.scriptName },
    { list, runCommand, signal: runtime.signal },
  );
  let runId: string | null = null;
  try {
    // A persist failure is loud in server logs but never fails the
    // verification that succeeded (same pattern as workspace.verify).
    const summary = await persistRunSummary(store.directory, {
      workspaceId,
      scriptName: parsed.scriptName,
      outcome: verification.outcome,
      durationMs: verification.durationMs,
      output: verification.output,
      outputTruncated: verification.truncated,
      revision: verification.git.revision,
      dirty: verification.git.dirty,
      environment: receipt,
    }, store);
    runId = summary.id ?? null;
  } catch (error) {
    console.error('Run summary persist failed:', error instanceof Error ? error.message : error);
  }
  return {
    environmentId,
    name: plan.name,
    outcome: verification.outcome,
    runId,
    repositoryPath: verification.repositoryPath,
    scriptName: parsed.scriptName,
    services,
    message: verification.message,
  };
}
