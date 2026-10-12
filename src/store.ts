import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { maxProjectRootLength, maxProjectRoots, projectRootsError } from './project-roots.js';

export const privateJsonLimit = 1024 * 1024;
const name = z.string().min(1).max(100);
const rootPath = z.string().min(1).max(maxProjectRootLength).refine(value => isAbsolute(value) && !value.includes('\0'));
const registration = z.object({
  id: z.string().uuid(),
  name,
  roots: z.array(rootPath).min(1).max(maxProjectRoots).superRefine((roots, context) => {
    const error = projectRootsError(roots);
    if (error) context.addIssue({ code: 'custom', message: error });
  }),
  // Additive exact Docker ID links live with the project registration so they
  // share its private, atomic persistence and disappear with the registration.
  linkedContainers: z.array(z.string().regex(/^[a-f\d]{64}$/i)).max(20).optional().default([]).superRefine((ids, context) => {
    if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Linked Docker container IDs must be unique.' });
    }
  }),
  createdAt: z.string().datetime(),
}).strict();
const activityEntry = z.object({
  at: z.string().datetime(),
  actor: z.enum(['dashboard', 'mcp']),
  operation: z.string().min(1).max(80),
  workspaceId: z.string().uuid().nullable(),
  detail: z.string().max(200),
}).strict();
// Local environment orchestration (M1: topology + store only, no runtime).
// All additive, optional-with-default so files written before environments
// parse with an empty list; unknown shapes still fail closed. Readiness is an
// explicit union: 'process-alive' is the honest non-HTTP kind and is NEVER
// reported 'ready' (ceiling: 'starting').
const environmentReadiness = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http-200'),
    path: z.string().min(1).max(256).regex(/^\/\S*$/).optional().default('/'),
    timeoutSecs: z.number().int().min(5).max(120).optional().default(30),
  }).strict(),
  z.object({
    kind: z.literal('process-alive'),
  }).strict(),
]);
const environmentService = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/),
  name: z.string().regex(/^[\w:.-]{1,80}$/).optional(),
  repositoryPath: rootPath,
  scriptName: z.string().regex(/^[\w:.-]{1,80}$/),
  port: z.number().int().min(1).max(65535).nullable(),
  dependsOn: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/)).max(10).optional().default([]),
  readiness: environmentReadiness,
}).strict();
// Owned persists expectedRoot (canonical exactRootPath frozen at start time):
// stop-time compares fresh exactRootPath === expectedRoot BEFORE any runner
// call, because the topology's repositoryPath is user-supplied
// pre-canonicalization and may be re-set between up and down. pmId null is
// the pre-spawn intent (phase a); it never addresses a runner.
const environmentOwned = z.object({
  serviceId: z.string().min(1).max(80),
  pmId: z.number().int().nonnegative().nullable(),
  name: z.string().min(1).max(200),
  namespace: z.string().max(80).nullable(),
  expectedRoot: rootPath,
  // M2 phase-(c) record: the last readiness outcome for this owned process
  // (ready|starting|failed|skipped with attempt count and last HTTP status).
  // Additive, optional-with-default — files written before it read as null and
  // status keeps its M1 ceiling. Never a second process identity: mapping
  // still compares pmId + name + namespace + expectedRoot first.
  lastPoll: z.object({
    status: z.enum(['ready', 'starting', 'failed', 'skipped']),
    attempts: z.number().int().nonnegative(),
    httpStatus: z.number().int().nonnegative().nullable(),
    checkedAt: z.string().datetime(),
  }).strict().nullable().optional().default(null),
}).strict();
const environmentRecord = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  services: z.array(environmentService).min(1).max(10),
  owned: z.array(environmentOwned).max(10).optional().default([]),
  state: z.enum(['down', 'partial', 'up']).optional().default('down'),
  updatedAt: z.string().datetime(),
  // Additive: records written before creation timestamps parse without one;
  // rename/ambiguity evidence falls back to updatedAt when absent.
  createdAt: z.string().datetime().optional(),
}).strict();
const workspaceEnvironments = z.object({
  workspaceId: z.string().uuid(),
  items: z.array(environmentRecord).max(5),
}).strict();
const stateSchema = z.object({
  workspaces: z.array(registration).max(50),
  activity: z.array(activityEntry).max(50).optional().default([]),
  environments: z.array(workspaceEnvironments).max(50).optional().default([]),
}).strict().superRefine((state, context) => {
  const linkedIds = new Set<string>();
  state.workspaces.forEach((workspace, workspaceIndex) => {
    workspace.linkedContainers.forEach(id => {
      const normalizedId = id.toLowerCase();
      if (linkedIds.has(normalizedId)) {
        context.addIssue({ code: 'custom', path: ['workspaces', workspaceIndex, 'linkedContainers'], message: 'A Docker container can be linked to only one workspace.' });
      }
      linkedIds.add(normalizedId);
    });
  });
});
export type Registration = z.infer<typeof registration>;
export type EnvironmentService = z.infer<typeof environmentService>;
export type EnvironmentOwned = z.infer<typeof environmentOwned>;
export type EnvironmentRecord = z.infer<typeof environmentRecord>;
export type WorkspaceEnvironments = z.infer<typeof workspaceEnvironments>;
export type State = z.infer<typeof stateSchema>;

// ---------------------------------------------------------------------------
// Name-addressed contract (M2): stable UUIDs underneath, unique names on top.
// Single definition site for name validation and resolution; HTTP, MCP and
// every service reuse these helpers. Names match trimmed and case-insensitively;
// UUID-shaped inputs are always rejected with the use-the-name guidance.
// ---------------------------------------------------------------------------

/** Shared name-contract messages. Composed into http.ts safeMessages. */
export const nameMessages = {
  useTheName: 'Provide the registered name, not the ID.',
  ambiguous: 'This name matches more than one entry. Rename duplicates so every name is unique.',
} as const;

const uuidLikePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Trimmed 1–100; reject empty/whitespace-only, `/`, NUL, C0/C1 controls, `.`/`..`.
const badNamePattern = /[/\0-\x1f\x7f-\x9f]/;

export function isUuidLike(value: string): boolean {
  return uuidLikePattern.test(value);
}

/** Validate a user-supplied name once; returns the trimmed form. */
export function parseNameInput(input: unknown, invalidMessage: string): string {
  if (typeof input !== 'string') throw new Error(invalidMessage);
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 100) throw new Error(invalidMessage);
  if (uuidLikePattern.test(trimmed)) throw new Error(nameMessages.useTheName);
  if (badNamePattern.test(trimmed) || trimmed === '.' || trimmed === '..') throw new Error(invalidMessage);
  return trimmed;
}

/** Case-insensitive comparison form; display preserves user casing. */
export function foldName(name: string): string {
  return name.trim().toLowerCase();
}

export interface AmbiguousNameCandidate {
  name: string;
  rootLabel: string;
  createdAt: string;
}

export class AmbiguousNameError extends Error {
  readonly candidates: AmbiguousNameCandidate[];
  constructor(candidates: AmbiguousNameCandidate[]) {
    // Bounded: at most five candidates, labels truncated. The structured
    // array carries basename-only labels + explicit allowlist fields
    // (name/rootLabel/createdAt) for HTTP; the message string keeps full
    // labels so MCP callers (error-string only) can disambiguate.
    const shortLabel = (label: string): string => {
      const base = label.length > 0 ? basename(label) : '(no root)';
      return base.length > 60 ? `${base.slice(0, 57)}...` : base;
    };
    const listed = candidates.slice(0, 5).map(candidate => ({
      name: candidate.name,
      rootLabel: shortLabel(candidate.rootLabel),
      createdAt: candidate.createdAt,
    }));
    const full = candidates.slice(0, 5).map(candidate => ({
      name: candidate.name,
      rootLabel: candidate.rootLabel.length > 60 ? `${candidate.rootLabel.slice(0, 57)}...` : candidate.rootLabel,
      createdAt: candidate.createdAt,
    }));
    super(`${nameMessages.ambiguous} Candidates: ${full.map(candidate => `"${candidate.name}" — ${candidate.rootLabel || '(no root)'} — ${candidate.createdAt}`).join(' | ')}`);
    this.name = 'AmbiguousNameError';
    this.candidates = listed;
  }
}

export function ambiguousName(candidates: AmbiguousNameCandidate[]): AmbiguousNameError {
  return new AmbiguousNameError(candidates);
}

/** Exact (trimmed, case-insensitive) workspace resolution. */
export function resolveWorkspaceRecord(
  state: State,
  input: unknown,
  invalidMessage: string,
  notFoundMessage: string,
): Registration {
  const name = parseNameInput(input, invalidMessage);
  const folded = foldName(name);
  const matches = state.workspaces.filter(workspace => foldName(workspace.name) === folded);
  if (matches.length > 1) {
    throw ambiguousName(matches.map(workspace => ({
      name: workspace.name,
      rootLabel: workspace.roots[0] ?? '',
      createdAt: workspace.createdAt,
    })));
  }
  const record = matches[0];
  if (!record) throw new Error(notFoundMessage);
  return record;
}

/** Exact (trimmed, case-insensitive) environment resolution within one workspace. */
export function resolveEnvironmentRecord(
  state: State,
  workspaceInput: unknown,
  environmentInput: unknown,
  messages: { workspaceInvalid: string; workspaceNotFound: string; environmentInvalid: string; environmentNotFound: string },
): { workspace: Registration; record: EnvironmentRecord } {
  const workspace = resolveWorkspaceRecord(state, workspaceInput, messages.workspaceInvalid, messages.workspaceNotFound);
  const name = parseNameInput(environmentInput, messages.environmentInvalid);
  const folded = foldName(name);
  const items = state.environments.find(entry => entry.workspaceId === workspace.id)?.items ?? [];
  const matches = items.filter(item => foldName(item.name) === folded);
  if (matches.length > 1) {
    throw ambiguousName(matches.map(item => ({
      name: item.name,
      rootLabel: item.services[0]?.repositoryPath ?? '',
      createdAt: item.createdAt ?? item.updatedAt,
    })));
  }
  const record = matches[0];
  if (!record) throw new Error(messages.environmentNotFound);
  return { workspace, record };
}

export function stateDirectory(): string {
  return resolve(process.env.OPENWORKSPACE_HOME || join(homedir(), '.local/share/openworkspace'));
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  for (let parent = directory; parent !== dirname(parent); parent = dirname(parent)) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error('State directory ancestors must not be symlinks.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('State directory must be owned by you, private (0700), and not a symlink.');
  }
}

export async function acquireStateLock(directory: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(directory);
  const path = join(directory, 'service.lock');
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const identity = await handle.stat();
  await handle.close();
  return async () => {
    const current = await lstat(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Service lock ownership changed.');
    await unlink(path);
  };
}

export async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > privateJsonLimit
      || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe local state file.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()));
  } finally {
    await handle.close();
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > privateJsonLimit) {
    throw new Error('Private state exceeds the size limit.');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe local state destination.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Retired top-level keys from our own pre-pivot state files. */
const legacyTopLevelKeys = ['workstreams', 'leases'] as const;

/** Drop our own retired keys before the strict parse; foreign shapes still fail closed. */
function withoutLegacyTopLevelKeys(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored;
  const copy = { ...(stored as Record<string, unknown>) };
  for (const key of legacyTopLevelKeys) delete copy[key];
  return copy;
}

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const path = join(this.directory, 'state.json');
    let stored: unknown;
    try {
      stored = await readPrivateJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writePrivateJson(path, { workspaces: [] });
      return;
    }

    // Upgrade-tolerated legacy keys: files written before the pivot shed may
    // still carry our own retired top-level `workstreams`/`leases` keys.
    // They are ignored-and-dropped on read (the service starts; the file
    // migrates forward on the next write). Anything else unknown still fails
    // closed and the file is left byte-identical.
    if (!stateSchema.safeParse(withoutLegacyTopLevelKeys(stored)).success) throw new Error('Local workspace state is invalid.');
  }

  async read(): Promise<State> {
    return stateSchema.parse(withoutLegacyTopLevelKeys(await readPrivateJson(join(this.directory, 'state.json'))));
  }

  update<T>(change: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await change(state);
      await writePrivateJson(join(this.directory, 'state.json'), stateSchema.parse(state));
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
