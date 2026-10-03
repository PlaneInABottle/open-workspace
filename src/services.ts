import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { dockerContainerInventory, dockerFailureMessage, listDockerContainers, runDockerLogs, type DockerContainerInventory, type DockerLogResult, type DockerServiceLogTarget } from './services-docker.js';

const pm2MetadataTimeoutMs = 5_000;
const maximumPm2MetadataBytes = 2 * 1024 * 1024;
const maximumPm2Processes = 500;

const pm2ProcessSchema = z.object({
  name: z.string().max(200),
  pid: z.number().int().nonnegative().nullable().optional(),
  pm2_env: z.object({
    pm_id: z.number().int().nonnegative().optional(),
    name: z.string().max(200).optional(),
    status: z.string().max(64).optional(),
    pm_cwd: z.string().max(4096),
    namespace: z.string().max(80).nullable().optional(),
    restart_time: z.number().int().nonnegative().optional(),
    pm_uptime: z.number().int().nonnegative().optional(),
  }).strip(),
}).strip();

export interface Pm2Process {
  pmId: number | null;
  name: string;
  namespace: string | null;
  status: string;
  cwd: string;
  restartCount: number;
  startedAt: string | null;
}

export type ServiceAction = 'restart' | 'stop';

export interface ServiceStartRequest {
  repositoryPath: string;
  scriptName: string;
  name?: string;
}

export interface ServiceStartResult {
  action: 'start';
  target: { pmId: number; name: string; namespace: string | null };
  repositoryPath: string;
  rootPath: string;
  scriptName: string;
  status: 'completed' | 'failed' | 'unknown';
  serviceStatus: string | null;
  message: string;
}

export interface ServiceActionTarget {
  pmId: number | null;
  name: string;
  namespace?: string | null;
}

export interface ServiceActionResult {
  action: ServiceAction;
  target: { pmId: number; name: string; namespace: string | null };
  status: 'completed' | 'failed' | 'unknown';
  serviceStatus: string | null;
  message: string;
}

export type Pm2ListResult =
  | { available: true; processes: Pm2Process[] }
  | { available: false; error: 'missing' | 'failed' | 'timeout' | 'invalid' };

export interface ServiceRecord {
  runner: 'pm2';
  name: string;
  pmId: number | null;
  namespace: string | null;
  status: string;
  cwd: string;
  restartCount: number;
  matchedRoots: string[];
  exactRootPath: string | null;
}

export interface ServiceInventory {
  inspectedAt: string;
  runner: 'pm2';
  available: boolean;
  error?: 'missing' | 'failed' | 'timeout' | 'invalid';
  processCount: number;
  matchedProcessCount: number;
  unmatchedProcessCount: number;
  services: ServiceRecord[];
  ambiguousServices: ServiceRecord[];
  docker: DockerContainerInventory;
}

function safePm2Environment() {
  return Object.fromEntries([
    ['PATH', process.env.PATH],
    ['HOME', process.env.HOME],
    ['USER', process.env.USER],
    ['LOGNAME', process.env.LOGNAME],
    ['TMPDIR', process.env.TMPDIR],
    ['PM2_HOME', process.env.PM2_HOME],
    ['PM2_USAGE', '0'],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function startDate(uptime: number | undefined): string | null {
  if (!Number.isFinite(uptime) || !uptime) return null;
  return new Date(uptime).toISOString();
}

export async function listPm2Processes(options: {
  spawn?: typeof spawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<Pm2ListResult> {
  const command = 'pm2';
  let child;
  try {
    child = (options.spawn ?? spawn)(command, ['jlist'], {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? safePm2Environment(),
    });
  } catch {
    return { available: false, error: 'missing' };
  }
  return new Promise(resolveResult => {
    let settled = false;
    let forceStatus: 'timeout' | 'failed' | 'invalid' | undefined;
    let outputBytes = 0;
    let outputError = false;
    const chunks: Buffer[] = [];
    const finish = (value: Pm2ListResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolveResult(value);
    };
    const fail = (status?: 'timeout' | 'failed' | 'invalid' | 'missing') => {
      if (settled || forceStatus) return;
      forceStatus = status === 'missing' ? undefined : status;
      child.kill('SIGTERM');
      if (status) killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs ?? pm2MetadataTimeoutMs);

    const readChunk = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      if (forceStatus) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maximumPm2MetadataBytes) {
        outputError = true;
        fail('invalid');
        return;
      }
      if (stream === 'stdout') chunks.push(bytes);
    };
    child.stdout?.on('data', chunk => readChunk(chunk, 'stdout'));
    child.stderr?.on('data', chunk => readChunk(chunk, 'stderr'));
    child.once('error', () => finish({ available: false, error: 'missing' }));
    child.once('close', code => {
      if (settled) return;
      if (forceStatus) {
        finish({ available: false, error: forceStatus });
        return;
      }
      if (code !== 0 || outputError) {
        finish({ available: false, error: 'failed' });
        return;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, outputBytes));
        const value: unknown = JSON.parse(text);
        if (!Array.isArray(value) || value.length > maximumPm2Processes) throw new Error('Invalid PM2 metadata.');
        const processes: Pm2Process[] = value.map((entry: unknown) => {
          const parsed = pm2ProcessSchema.parse(entry);
          const env = parsed.pm2_env;
          if (!isAbsolute(env.pm_cwd) || env.pm_cwd.includes('\0')) throw new Error('Invalid PM2 cwd.');
          const cwd = resolve(env.pm_cwd);
          return {
            pmId: env.pm_id ?? null,
            name: env.name || parsed.name,
            namespace: typeof env.namespace === 'string' && env.namespace ? env.namespace : null,
            status: typeof env.status === 'string' && env.status ? env.status : 'unknown',
            cwd,
            restartCount: env.restart_time ?? 0,
            startedAt: startDate(env.pm_uptime),
          };
        });
        finish({ available: true, processes });
      } catch {
        finish({ available: false, error: 'invalid' });
      }
    });
  });
}

export type Pm2ActionRunner = (action: ServiceAction, pmId: number, options?: { spawn?: typeof spawn; timeoutMs?: number }) => Promise<{ ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }>;

export type ServiceLogStream = 'out' | 'err' | 'both';

export async function runPm2Action(action: ServiceAction, pmId: number, options: { spawn?: typeof spawn; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }> {
  let child;
  try {
    child = (options.spawn ?? spawn)('pm2', [action, String(pmId)], {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safePm2Environment(),
    });
  } catch {
    return { ok: false, error: 'missing' };
  }
  return new Promise(resolveResult => {
    let settled = false;
    let failure: 'timeout' | 'failed' | undefined;
    let outputError = false;
    let totalBytes = 0;
    const finish = (value: { ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolveResult(value);
    };
    const fail = (status: 'timeout' | 'failed') => {
      if (settled || failure) return;
      failure = status;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs ?? pm2MetadataTimeoutMs);
    const consume = (chunk: Buffer | string) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maximumPm2MetadataBytes) {
        outputError = true;
        fail('failed');
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', () => finish({ ok: false, error: 'missing' }));
    child.once('close', code => {
      if (settled) return;
      if (failure) return finish({ ok: false, error: failure });
      if (code !== 0 || outputError) return finish({ ok: false, error: 'failed' });
      finish({ ok: true });
    });
  });
}

function cwdInside(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(`${root}${sep}`);
}

export async function stableRootGroup(workspaceRoots: string[], cwd: string): Promise<{
  matchedRoots: string[];
  exactRootPath: string | null;
}> {
  let cwdPath: string;
  try {
    cwdPath = resolve(await realpath(cwd));
  } catch {
    return { matchedRoots: [], exactRootPath: null };
  }
  const matchedRoots = await Promise.all(workspaceRoots.map(async root => {
    try {
      const resolvedRoot = resolve(await realpath(root));
      return cwdInside(resolvedRoot, cwdPath) ? root : null;
    } catch {
      return null;
    }
  }));
  const roots = matchedRoots.filter((root): root is string => Boolean(root));
  return { matchedRoots: roots, exactRootPath: roots.length === 1 ? roots[0] : null };
}

export async function inspectPm2Services(workspaceRoots: string[], processes: Pm2Process[]): Promise<{ services: ServiceRecord[]; ambiguousServices: ServiceRecord[]; unmatchedProcessCount: number }> {
  const services: ServiceRecord[] = [];
  const ambiguousServices: ServiceRecord[] = [];
  let unmatchedProcessCount = 0;
  for (const process of processes) {
    const match = await stableRootGroup(workspaceRoots, process.cwd);
    if (match.matchedRoots.length === 0) {
      unmatchedProcessCount += 1;
      continue;
    }
    const service: ServiceRecord = {
      runner: 'pm2',
      name: process.name,
      pmId: process.pmId,
      namespace: process.namespace,
      status: process.status,
      cwd: process.cwd,
      restartCount: process.restartCount,
      matchedRoots: match.matchedRoots,
      exactRootPath: match.exactRootPath,
    };
    if (match.exactRootPath) services.push(service);
    else ambiguousServices.push(service);
  }
  services.sort((a, b) => a.name.localeCompare(b.name) || (a.pmId ?? -1) - (b.pmId ?? -1));
  ambiguousServices.sort((a, b) => a.name.localeCompare(b.name) || (a.pmId ?? -1) - (b.pmId ?? -1));
  return { services, ambiguousServices, unmatchedProcessCount };
}

export async function serviceInventory(workspaceRoots: string[], list = listPm2Processes, listDocker = listDockerContainers, options: {
  linkedContainerIds?: string[];
  includeUnmanaged?: boolean;
} = {}): Promise<ServiceInventory> {
  const [listResult, docker] = await Promise.all([list(), dockerContainerInventory(workspaceRoots, listDocker, options)]);
  const timestamp = new Date().toISOString();
  if (!listResult.available) {
    return {
      inspectedAt: timestamp,
      runner: 'pm2',
      available: false,
      error: listResult.error,
      processCount: 0,
      matchedProcessCount: 0,
      unmatchedProcessCount: 0,
      services: [],
      ambiguousServices: [],
      docker,
    };
  }
  const mapped = await inspectPm2Services(workspaceRoots, listResult.processes);
  return {
    inspectedAt: timestamp,
    runner: 'pm2',
    available: true,
    processCount: listResult.processes.length,
    matchedProcessCount: mapped.services.length + mapped.ambiguousServices.length,
    unmatchedProcessCount: mapped.unmatchedProcessCount,
    services: mapped.services,
    ambiguousServices: mapped.ambiguousServices,
    docker,
  };
}

export async function controlPm2Service(workspaceRoots: string[], action: ServiceAction, target: ServiceActionTarget, list = listPm2Processes, runner: Pm2ActionRunner = runPm2Action): Promise<ServiceActionResult> {
  const fail = (message: string, status: ServiceActionResult['status']): ServiceActionResult => ({
    action,
    target: { pmId: target.pmId ?? -1, name: target.name, namespace: target.namespace ?? null },
    status,
    serviceStatus: null,
    message,
  });
  if (typeof target.pmId !== 'number' || !Number.isInteger(target.pmId) || target.pmId < 0) return fail('PM2 process identity is unavailable.', 'failed');
  if (!target.name.trim() || target.name.length > 200) return fail('Service name is invalid.', 'failed');
  const before = await list();
  if (!before.available) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? null }, status: 'failed', serviceStatus: null, message: 'PM2 service metadata could not be read before the action.' };
  const mapped = await inspectPm2Services(workspaceRoots, before.processes);
  const candidates = [...mapped.services, ...mapped.ambiguousServices];
  const service = candidates.find(service => service.pmId === target.pmId && service.name === target.name);
  // Ambiguous roots are not controllable until the human resolves the service owner.
  if (!service || !service.exactRootPath || (target.namespace && service.pmId === null)) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? null }, status: 'failed', serviceStatus: null, message: 'That PM2 service is not uniquely mapped to a registered root.' };
  if (target.namespace && service.namespace && service.namespace !== target.namespace) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace }, status: 'failed', serviceStatus: service.status, message: 'The service identity changed; review it again in the dashboard.' };
  const result = await runner(action, target.pmId);
  if (!result.ok) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? service.namespace }, status: 'failed', serviceStatus: service.status, message: result.error === 'missing' ? 'PM2 is unavailable.' : 'The PM2 action did not complete.' };
  const after = await list();
  if (!after.available) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? service.namespace }, status: 'unknown', serviceStatus: null, message: 'The PM2 action finished; fresh service metadata is unavailable.' };
  const afterMapped = await inspectPm2Services(workspaceRoots, after.processes);
  const matchedAfter = [...afterMapped.services, ...afterMapped.ambiguousServices].find(service => service.pmId === target.pmId && service.name === target.name);
  if (matchedAfter?.exactRootPath !== service.exactRootPath) return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? service.namespace }, status: 'unknown', serviceStatus: matchedAfter?.status ?? null, message: 'The service could not be uniquely matched after the action.' };
  return { action, target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? service.namespace }, status: 'completed', serviceStatus: matchedAfter?.status ?? null, message: action === 'restart' ? 'PM2 accepted the restart. Process state is not readiness.' : 'PM2 accepted the stop request.' };
}

const pm2StartTimeoutMs = 15_000;
const serviceStartNamePattern = /^[\w:.-]{1,80}$/;
const serviceStartScriptPattern = /^[\w:.-]{1,80}$/;
const serviceStartManifestLimit = 256 * 1024;

export type Pm2StartRunner = (input: {
  name: string;
  scriptName: string;
  cwd: string;
}, options?: { spawn?: typeof spawn; timeoutMs?: number }) => Promise<{ ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }>;

export async function readStartScripts(manifestPath: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > serviceStartManifestLimit) return null;
      const scripts = (JSON.parse(await file.readFile('utf8')) as { scripts?: unknown }).scripts;
      return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
        ? scripts as Record<string, unknown> : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export async function runPm2Start(input: {
  name: string;
  scriptName: string;
  cwd: string;
}, options: { spawn?: typeof spawn; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }> {
  // Fixed argv shape: `pm2 start npm --name <name> -- run <script> --silent`.
  // The script body never reaches argv — only its manifest-listed name does —
  // so a hostile package.json script value cannot inject flags or commands.
  const args = ['start', 'npm', '--name', input.name, '--', 'run', input.scriptName, '--silent'];
  let child;
  try {
    child = (options.spawn ?? spawn)('pm2', args, {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: input.cwd,
      env: safePm2Environment(),
    });
  } catch {
    return { ok: false, error: 'missing' };
  }
  return new Promise(resolveResult => {
    let settled = false;
    let failure: 'timeout' | 'failed' | undefined;
    let totalBytes = 0;
    const finish = (value: { ok: true } | { ok: false; error: 'missing' | 'failed' | 'timeout' }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolveResult(value);
    };
    const fail = (status: 'timeout' | 'failed') => {
      if (settled || failure) return;
      failure = status;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs ?? pm2StartTimeoutMs);
    const consume = (chunk: Buffer | string) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maximumPm2MetadataBytes) {
        fail('failed');
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', () => finish({ ok: false, error: 'missing' }));
    child.once('close', code => {
      if (settled) return;
      if (failure) return finish({ ok: false, error: failure });
      if (code !== 0) return finish({ ok: false, error: 'failed' });
      finish({ ok: true });
    });
  });
}

// Service start derives the command from an already-registered,
// already-discovered source only: an existing package.json script name in a
// repository inside exactly one registered root (the verification_run
// precedent). There is deliberately no explicit-argv path: no caller field
// ever reaches a shell or an interpreter choice, so arbitrary shell,
// out-of-root binaries and non-allowlisted interpreters are refused by
// construction — the runner stays `pm2`, cwd is the owning repository, and
// the started process re-enters the same inventory/mapping/log path as every
// other PM2 service. Readiness is not polled here: a completed start means
// PM2 accepted the process, not that it is ready.
export async function startPm2Service(workspaceRoots: string[], request: ServiceStartRequest, list = listPm2Processes, starter: Pm2StartRunner = runPm2Start): Promise<ServiceStartResult> {
  const name = (request.name ?? request.scriptName).trim();
  const fail = (message: string, status: ServiceStartResult['status']): ServiceStartResult => ({
    action: 'start',
    target: { pmId: -1, name: name.slice(0, 200) || request.scriptName.slice(0, 80), namespace: null },
    repositoryPath: typeof request.repositoryPath === 'string' ? request.repositoryPath.slice(0, 4096) : '',
    rootPath: '',
    scriptName: typeof request.scriptName === 'string' ? request.scriptName.slice(0, 80) : '',
    status,
    serviceStatus: null,
    message,
  });
  if (typeof request.repositoryPath !== 'string' || !isAbsolute(request.repositoryPath)
    || request.repositoryPath.includes('\0') || request.repositoryPath.length > 4096) {
    return fail('The selected folder is not inside a registered project root.', 'failed');
  }
  if (typeof request.scriptName !== 'string' || !serviceStartScriptPattern.test(request.scriptName)) {
    return fail('This repository has no runnable script with that name.', 'failed');
  }
  if (!serviceStartNamePattern.test(name)) {
    return fail('Provide a service name with 80 characters or fewer.', 'failed');
  }
  const resolved = resolve(request.repositoryPath);
  let repository: string;
  try {
    repository = resolve(await realpath(resolved));
  } catch {
    return fail('The selected folder is not inside a registered project root.', 'failed');
  }
  const group = await stableRootGroup(workspaceRoots, repository);
  // Approval already rejects overlapping roots, so at most one root can own
  // the folder; nested registrations stay ambiguous and unstartable.
  if (group.matchedRoots.length !== 1 || !group.exactRootPath) {
    return fail('The selected folder is not inside a registered project root.', 'failed');
  }
  const manifestPath = resolve(repository, 'package.json');
  const scripts = await readStartScripts(manifestPath);
  if (!scripts) {
    return fail('This repository has no runnable script with that name.', 'failed');
  }
  const body = scripts[request.scriptName];
  if (typeof body !== 'string' || !body) {
    return fail('This repository has no runnable script with that name.', 'failed');
  }
  const started = await starter({ name, scriptName: request.scriptName, cwd: repository });
  const resolvedTarget = (pmId: number, namespace: string | null, serviceStatus: string | null, status: ServiceStartResult['status'], message: string): ServiceStartResult => ({
    action: 'start',
    target: { pmId, name, namespace },
    repositoryPath: repository,
    rootPath: group.exactRootPath as string,
    scriptName: request.scriptName,
    status,
    serviceStatus,
    message,
  });
  if (!started.ok) {
    return resolvedTarget(-1, null, null, 'failed', started.error === 'missing' ? 'PM2 is unavailable.' : started.error === 'timeout' ? 'The PM2 start did not finish within the bounded runtime.' : 'PM2 did not start the service.');
  }
  const after = await list();
  if (!after.available) {
    return resolvedTarget(-1, null, null, 'unknown', 'PM2 accepted the start; fresh service metadata is unavailable.');
  }
  const mapped = await inspectPm2Services(workspaceRoots, after.processes);
  const matched = [...mapped.services, ...mapped.ambiguousServices]
    .filter(service => service.name === name && service.exactRootPath === group.exactRootPath)
    .sort((a, b) => (b.pmId ?? -1) - (a.pmId ?? -1))[0];
  if (!matched || matched.pmId === null) {
    return resolvedTarget(-1, null, null, 'unknown', 'PM2 accepted the start; the new service could not be matched to its root.');
  }
  return resolvedTarget(matched.pmId, matched.namespace, matched.status, 'completed', 'PM2 accepted the start. Process state is not readiness.');
}

const pm2LogTimeoutMs = 10_000;
const maximumPm2LogBytes = 64 * 1024;
export const maximumServiceLogLines = 200;
export const defaultServiceLogLines = 100;

export type Pm2LogRunner = (pmId: number, stream: ServiceLogStream, lines: number, options?: { spawn?: typeof spawn; timeoutMs?: number }) => Promise<{ ok: true; output: string; truncated: boolean } | { ok: false; error: 'missing' | 'failed' | 'timeout' }>;

export async function runPm2Logs(pmId: number, stream: ServiceLogStream, lines: number, options: { spawn?: typeof spawn; timeoutMs?: number } = {}): Promise<{ ok: true; output: string; truncated: boolean } | { ok: false; error: 'missing' | 'failed' | 'timeout' }> {
  const args = ['logs', String(pmId), '--nostream', '--lines', String(lines)];
  if (stream === 'out') args.push('--out');
  else if (stream === 'err') args.push('--err');
  let child;
  try {
    child = (options.spawn ?? spawn)('pm2', args, {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safePm2Environment(),
    });
  } catch {
    return { ok: false, error: 'missing' };
  }
  return new Promise(resolveResult => {
    let settled = false;
    let failure: 'timeout' | 'failed' | undefined;
    let truncated = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    const finish = (value: { ok: true; output: string; truncated: boolean } | { ok: false; error: 'missing' | 'failed' | 'timeout' }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolveResult(value);
    };
    const fail = (status: 'timeout' | 'failed') => {
      if (settled || failure) return;
      failure = status;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs ?? pm2LogTimeoutMs);
    const consume = (chunk: Buffer | string) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      totalBytes += bytes.length;
      if (totalBytes > maximumPm2LogBytes) {
        // pm2 emits the oldest records first, so drop from the front: the
        // newest records (usually the tail of the requested window) are kept.
        // Log text may contain app-printed secrets, so the kept window is
        // flagged truncated and never persisted anywhere.
        truncated = true;
        let excess = totalBytes - maximumPm2LogBytes;
        while (excess > 0 && chunks.length > 0) {
          const oldest = chunks[0];
          if (oldest.length <= excess) {
            chunks.shift();
            totalBytes -= oldest.length;
            excess -= oldest.length;
          } else {
            chunks[0] = oldest.subarray(excess);
            totalBytes -= excess;
            excess = 0;
          }
        }
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', () => finish({ ok: false, error: 'missing' }));
    child.once('close', code => {
      if (settled) return;
      if (failure) return finish({ ok: false, error: failure });
      if (code !== 0) return finish({ ok: false, error: 'failed' });
      const decode = () => new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks, totalBytes)).replace(/\n+$/, '');
      finish({ ok: true, output: decode(), truncated });
    });
  });
}

export interface ServiceLogTarget {
  pmId: number | null;
  name: string;
  namespace?: string | null;
}

export type AnyServiceLogTarget = ServiceLogTarget | DockerServiceLogTarget;

const pm2AnsiPattern = /\x1b\[[0-9;]*[A-Za-z]/g;
const pm2BannerPattern = /^\[TAILING\] Tailing last \d+ lines? for \[.*\] process.*$/;
const pm2SectionHeaderPattern = /^.+\.log last \d+ lines?:$/;

// pm2 --nostream decorates its tail with CLI chrome: a [TAILING] banner, one
// "<abs path> last N lines:" header per tailed file, and a "<pmId>|<name> | "
// prefix on every record line, all wrapped in ANSI color codes. Only genuine
// log records are returned: headers would otherwise leak absolute PM2 log
// paths and inflate line counts, and a service with no output would report
// chrome as content. Blank separator lines between pm2 sections carry no
// record content and are dropped. The record prefix is removed for this
// service's own pmId, accepting pm2's truncation of long process names (the
// printed name must match this service's name in either truncation direction),
// so lookalike record text from other processes survives.
export function stripPm2LogChrome(raw: string, pmId: number, name: string): string {
  const exactPrefix = `${pmId}|${name} | `;
  const loosePrefixPattern = /^(\d+)\|([^|]*) \| /;
  const records: string[] = [];
  for (const line of raw.split('\n')) {
    const plain = line.replace(pm2AnsiPattern, '').replace(/\r$/, '');
    if (!plain || pm2BannerPattern.test(plain) || pm2SectionHeaderPattern.test(plain)) continue;
    if (plain.startsWith(exactPrefix)) {
      records.push(plain.slice(exactPrefix.length));
      continue;
    }
    const loose = loosePrefixPattern.exec(plain);
    if (loose && Number(loose[1]) === pmId && loose[2] && (name.startsWith(loose[2]) || loose[2].startsWith(name))) {
      records.push(plain.slice(loose[0].length));
      continue;
    }
    records.push(plain);
  }
  return records.join('\n');
}

export interface ServiceLogResult {
  target: { pmId: number; name: string; namespace: string | null } | DockerServiceLogTarget;
  stream: ServiceLogStream;
  linesRequested: number;
  linesReturned: number;
  truncated: boolean;
  output: string;
  message: string;
}

export async function readPm2ServiceLogs(workspaceRoots: string[], target: ServiceLogTarget, options: { lines?: number; stream?: ServiceLogStream; list?: typeof listPm2Processes; runner?: Pm2LogRunner } = {}): Promise<ServiceLogResult> {
  const lines = options.lines ?? defaultServiceLogLines;
  const stream = options.stream ?? 'both';
  const validStream = stream === 'out' || stream === 'err' || stream === 'both';
  const validLines = Number.isInteger(lines) && (lines as number) >= 1 && (lines as number) <= maximumServiceLogLines;
  const fail = (message: string): ServiceLogResult => ({
    target: { pmId: target.pmId ?? -1, name: target.name, namespace: target.namespace ?? null },
    stream: validStream ? stream : 'both',
    linesRequested: validLines ? (lines as number) : defaultServiceLogLines,
    linesReturned: 0,
    truncated: false,
    output: '',
    message,
  });
  if (typeof target.pmId !== 'number' || !Number.isInteger(target.pmId) || target.pmId < 0) return fail('PM2 process identity is unavailable.');
  if (!target.name.trim() || target.name.length > 200) return fail('Service name is invalid.');
  if (!validLines) return fail(`Request between 1 and ${maximumServiceLogLines} log lines.`);
  if (!validStream) return fail('Select the out, err or combined log stream.');
  const list = options.list ?? listPm2Processes;
  const runner = options.runner ?? runPm2Logs;
  const before = await list();
  if (!before.available) return fail('PM2 service metadata could not be read before the log tail.');
  const mapped = await inspectPm2Services(workspaceRoots, before.processes);
  const candidates = [...mapped.services, ...mapped.ambiguousServices];
  const service = candidates.find(candidate => candidate.pmId === target.pmId && candidate.name === target.name);
  // Ambiguous roots are not readable until the human resolves the service owner.
  if (!service || !service.exactRootPath) return { ...fail('That PM2 service is not uniquely mapped to a registered root.'), target: { pmId: target.pmId, name: target.name, namespace: target.namespace ?? null } };
  if (target.namespace && service.namespace && service.namespace !== target.namespace) return { ...fail('The service identity changed; review it again in the dashboard.'), target: { pmId: target.pmId, name: target.name, namespace: target.namespace } };
  const result = await runner(target.pmId, stream, lines as number);
  const resolvedTarget = { pmId: target.pmId, name: target.name, namespace: target.namespace ?? service.namespace };
  if (!result.ok) return {
    target: resolvedTarget, stream, linesRequested: lines as number, linesReturned: 0, truncated: false, output: '',
    message: result.error === 'missing' ? 'PM2 is unavailable.' : result.error === 'timeout' ? 'The PM2 log tail did not finish within the bounded runtime.' : 'The PM2 log tail did not complete.',
  };
  const output = stripPm2LogChrome(result.output, target.pmId, target.name);
  const linesReturned = output === '' ? 0 : output.split('\n').length;
  return {
    target: resolvedTarget, stream, linesRequested: lines as number, linesReturned, truncated: result.truncated, output,
    message: linesReturned === 0 ? 'PM2 returned no log output for this service.' : 'PM2 returned a bounded log tail.',
  };
}

export async function readDockerServiceLogs(workspaceRoots: string[], target: DockerServiceLogTarget, options: {
  lines?: number;
  stream?: ServiceLogStream;
  list?: typeof listDockerContainers;
  runner?: (containerId: string, lines: number) => Promise<DockerLogResult>;
  linkedContainerIds?: string[];
} = {}): Promise<ServiceLogResult> {
  const lines = options.lines ?? defaultServiceLogLines;
  const stream = options.stream ?? 'both';
  const fail = (message: string): ServiceLogResult => ({
    target,
    stream: stream === 'out' || stream === 'err' || stream === 'both' ? stream : 'both',
    linesRequested: Number.isInteger(lines) && lines >= 1 && lines <= maximumServiceLogLines ? lines : defaultServiceLogLines,
    linesReturned: 0,
    truncated: false,
    output: '',
    message,
  });
  if (!/^[a-f\d]{64}$/i.test(target.containerId) || !target.name.trim() || target.name.length > 256) return fail('Docker container identity is invalid.');
  if (!Number.isInteger(lines) || lines < 1 || lines > maximumServiceLogLines) return fail(`Request between 1 and ${maximumServiceLogLines} log lines.`);
  if (stream !== 'both') return fail('Docker returns combined container logs; select the both stream.');
  const list = options.list ?? listDockerContainers;
  const before = await list();
  if (!before.available) return fail(dockerFailureMessage(before.error, 'metadata'));
  const linked = (options.linkedContainerIds ?? []).some(id => id.toLowerCase() === target.containerId.toLowerCase());
  if (linked && !before.containers.some(container => container.id.toLowerCase() === target.containerId.toLowerCase())) {
    return fail('The linked Docker container is no longer available.');
  }
  const mapped = await dockerContainerInventory(workspaceRoots, async () => before, { linkedContainerIds: options.linkedContainerIds });
  const container = mapped.services.find(service => service.containerId.toLowerCase() === target.containerId.toLowerCase() && service.name === target.name);
  if (!container || (!container.exactRootPath && container.mappingSource !== 'explicit-link')) return fail('That Docker container is not uniquely mapped to a registered root or explicitly linked to this workspace.');
  const runner = options.runner ?? runDockerLogs;
  const result = await runner(container.containerId, lines);
  if (!result.ok) return {
    target,
    stream,
    linesRequested: lines,
    linesReturned: 0,
    truncated: false,
    output: '',
    message: dockerFailureMessage(result.error, 'logs'),
  };
  const linesReturned = result.output === '' ? 0 : result.output.split('\n').length;
  return {
    target,
    stream,
    linesRequested: lines,
    linesReturned,
    truncated: result.truncated,
    output: result.output,
    message: linesReturned === 0 ? 'Docker returned no log output for this container.' : 'Docker returned a bounded log tail.',
  };
}
