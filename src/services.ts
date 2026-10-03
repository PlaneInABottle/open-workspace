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

export type ServiceAction = 'restart' | 'stop';

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
  target: { pmId: number; name: string; namespace: string | null };
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
