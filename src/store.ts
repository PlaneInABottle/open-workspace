import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { maxProjectRootLength, maxProjectRoots, projectRootsError } from './project-roots.js';

const privateJsonLimit = 1024 * 1024;
const name = z.string().min(1).max(100);
const rootPath = z.string().min(1).max(maxProjectRootLength).refine(value => isAbsolute(value) && !value.includes('\0'));
const registration = z.object({
  id: z.string().uuid(),
  name,
  roots: z.array(rootPath).min(1).max(maxProjectRoots).superRefine((roots, context) => {
    const error = projectRootsError(roots);
    if (error) context.addIssue({ code: 'custom', message: error });
  }),
  createdAt: z.string().datetime(),
}).strict();
const workstreamCheckout = z.object({
  root: rootPath,
  revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  revisionState: z.enum(['observed', 'unknown']),
  observedAt: z.string().datetime(),
}).strict();
const workstream = z.object({
  id: z.string().uuid(),
  name,
  workspaceId: z.string().uuid(),
  checkouts: z.array(workstreamCheckout).min(1).max(20),
  status: z.enum(['active', 'paused', 'done']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const lease = z.object({
  resource: z.string().min(1).max(80),
  workstreamId: z.string().uuid(),
  status: z.enum(['held', 'queued']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const stateSchema = z.object({
  workspaces: z.array(registration).max(50),
  proposals: z.array(registration).max(50),
  workstreams: z.array(workstream).max(50),
  leases: z.array(lease).max(50).optional().default([]),
}).strict();
export type Registration = z.infer<typeof registration>;
export type WorkstreamRecord = z.infer<typeof workstream>;
export type LeaseRecord = z.infer<typeof lease>;
export type State = z.infer<typeof stateSchema>;

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
      await writePrivateJson(path, { workspaces: [], proposals: [], workstreams: [] });
      return;
    }

    // No versioned upgrades: unknown shapes fail closed and the file is left byte-identical.
    if (!stateSchema.safeParse(stored).success) throw new Error('Local workspace state is invalid.');
  }

  async read(): Promise<State> {
    return stateSchema.parse(await readPrivateJson(join(this.directory, 'state.json')));
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
