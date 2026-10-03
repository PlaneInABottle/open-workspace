import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { discover, readProposalHints, type ProposalHints, type Repository } from './discovery.js';
import { inspectPm2Services, listPm2Processes, readStartScripts, stableRootGroup } from './services.js';
import { Store, privateJsonLimit, type EnvironmentOwned, type EnvironmentRecord, type EnvironmentService } from './store.js';
import { verifyMessages } from './verify.js';

// Canonical owner of every user-visible environment-topology message.
// http.ts composes its allowlist from this object, so a rename propagates.
export const environmentMessages = {
  envNotFound: 'Environment not found. Propose and set its topology first.',
  envLimit: 'Environment limit reached for this workspace.',
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

export type EnvironmentServiceDraft = z.infer<typeof environmentServiceInput>;

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
  workspaceId: string,
  input: unknown,
  readScripts: typeof readStartScripts = readStartScripts,
): Promise<EnvironmentRecord> {
  const parsed = environmentSetInput.parse(input);
  const state = await store.read();
  const workspace = state.workspaces.find(workspace => workspace.id === workspaceId);
  if (!workspace) throw new Error(verifyMessages.notFoundRegister);
  const services = await validatedServices(workspace.roots, parsed.services, readScripts);
  return store.update(state => {
    let entry = state.environments.find(entry => entry.workspaceId === workspaceId);
    if (!entry) {
      if (state.environments.length >= maxEnvironmentEntries) throw new Error(environmentMessages.outerLimit);
      entry = { workspaceId, items: [] };
      state.environments.push(entry);
    }
    const existing = entry.items.find(item => item.name === parsed.name);
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
      record = { id: randomUUID(), name: parsed.name, services, owned: [], state: 'down', updatedAt: now };
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

export async function getEnvironment(store: Store, workspaceId: string, environmentId: string): Promise<EnvironmentRecord> {
  const state = await store.read();
  if (!state.workspaces.some(workspace => workspace.id === workspaceId)) {
    throw new Error(verifyMessages.notFoundRegister);
  }
  const record = state.environments
    .find(entry => entry.workspaceId === workspaceId)?.items
    .find(item => item.id === environmentId);
  if (!record) throw new Error(environmentMessages.envNotFound);
  return record;
}

export async function listEnvironments(store: Store, workspaceId: string): Promise<EnvironmentRecord[]> {
  const state = await store.read();
  if (!state.workspaces.some(workspace => workspace.id === workspaceId)) {
    throw new Error(verifyMessages.notFoundRegister);
  }
  return state.environments.find(entry => entry.workspaceId === workspaceId)?.items ?? [];
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
// through the injected list seam (same as workspace_services). Nothing is
// started, stopped, or probed. M1 ceiling is 'starting' for alive-but-unpolled
// processes — without the M2 readiness poll no service is reported
// 'ready'/'skipped'; terminal PM2 states map honestly to 'down'/'failed'.
export async function environmentStatus(
  store: Store,
  workspaceId: string,
  environmentId: string,
  list: typeof listPm2Processes = listPm2Processes,
): Promise<EnvironmentStatus> {
  const state = await store.read();
  const workspace = state.workspaces.find(workspace => workspace.id === workspaceId);
  if (!workspace) throw new Error(verifyMessages.notFoundRegister);
  const record = state.environments
    .find(entry => entry.workspaceId === workspaceId)?.items
    .find(item => item.id === environmentId);
  if (!record) throw new Error(environmentMessages.envNotFound);
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
  workspaceId: string,
): Promise<{ services: ProposedService[]; order: string[] }> {
  const state = await store.read();
  const workspace = state.workspaces.find(workspace => workspace.id === workspaceId);
  if (!workspace) throw new Error(verifyMessages.notFoundRegister);
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
