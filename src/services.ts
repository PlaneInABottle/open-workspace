import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

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

export type Pm2ListResult =
  | { available: true; processes: Pm2Process[] }
  | { available: false; error: 'missing' | 'failed' | 'timeout' | 'invalid' };

export interface ServiceRecord {
  name: string;
  pmId: number | null;
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

function cwdInside(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(`${root}${sep}`);
}

async function stableRootGroup(workspaceRoots: string[], cwd: string): Promise<{
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
      name: process.name,
      pmId: process.pmId,
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

export async function serviceInventory(workspaceRoots: string[], list = listPm2Processes): Promise<ServiceInventory> {
  const listResult = await list();
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
  };
}
