import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

const dockerMetadataTimeoutMs = 5_000;
const dockerLogTimeoutMs = 10_000;
const maximumDockerMetadataBytes = 2 * 1024 * 1024;
const maximumDockerContainers = 500;
export const maximumDockerLogBytes = 64 * 1024;

const containerSchema = z.object({
  Id: z.string().regex(/^[a-f\d]{12,64}$/i),
  Name: z.string().max(256),
  Config: z.object({
    Image: z.string().max(512).optional(),
    Labels: z.record(z.string(), z.string().max(4096)).nullable().optional(),
  }).strip(),
  State: z.object({ Status: z.string().max(64) }).strip(),
}).strip();

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
}

export type DockerListResult =
  | { available: true; containers: DockerContainer[] }
  | { available: false; error: DockerFailure };

export type DockerLogResult =
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; error: DockerFailure };

export type DockerFailure = 'executable-missing' | 'daemon-unreachable' | 'access-denied' | 'failed' | 'timeout' | 'invalid';

export interface DockerMappedContainer {
  runner: 'docker';
  containerId: string;
  name: string;
  image: string;
  state: string;
  mappingSource: 'compose-label' | 'explicit-link';
  matchedRoots: string[];
  exactRootPath: string | null;
}

export interface DockerContainerInventory {
  available: boolean;
  error?: DockerFailure;
  message: string;
  containerCount: number;
  matchedContainerCount: number;
  ambiguousContainerCount: number;
  unmanagedContainerCount: number;
  services: DockerMappedContainer[];
  unmanagedContainers: Array<Pick<DockerMappedContainer, 'runner' | 'containerId' | 'name' | 'image' | 'state'> & {
    mappingStatus: 'unmatched' | 'ambiguous';
    matchedRoots: string[];
  }>;
}

export type DockerServiceLogTarget = {
  runner: 'docker';
  containerId: string;
  name: string;
};

export type DockerSpawn = typeof spawn;

function safeDockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION'];
  return Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}

type CommandResult = { ok: true; stdout: Buffer; stderr: Buffer; output?: Buffer; truncated: boolean } | { ok: false; error: DockerFailure };

function dockerFailureFromStderr(stderr: Buffer): DockerFailure {
  const message = stderr.toString('utf8');
  if (/permission denied|access denied|operation not permitted/i.test(message)) return 'access-denied';
  if (/cannot connect to (?:the )?docker (?:daemon|api)|error during connect|is the docker daemon running|docker\.sock[^\n]*(?:no such file|connect)|context [^\n]* not found/i.test(message)) return 'daemon-unreachable';
  return 'failed';
}

function dockerFailureFromSpawn(error: unknown): DockerFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'executable-missing';
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  return 'failed';
}

// Canonical Docker-path messages. The metadata family is client-visible via
// the http allowlist (composed in http.ts); the log-tail family is returned
// directly in log-result bodies, never via throw→allowlist, and is recorded
// out-of-allowlist in test/safe-messages.test.ts.
export const dockerMetadataMessages = {
  cliUnavailable: 'Docker CLI is unavailable.',
  daemonUnreachable: 'Docker daemon is unreachable.',
  accessDenied: 'Docker access was denied.',
  metadataTimeout: 'Docker metadata did not finish within the bounded runtime.',
  metadataInvalid: 'Docker metadata was invalid or exceeded its bound.',
  metadataUnreadable: 'Docker metadata could not be read.',
} as const;

export const dockerLogMessages = {
  logTimeout: 'The Docker log tail did not finish within the bounded runtime.',
  logInvalid: 'The Docker log tail was invalid.',
  logIncomplete: 'The Docker log tail did not complete.',
} as const;

export function dockerFailureMessage(error: DockerFailure, operation: 'metadata' | 'logs'): string {
  switch (error) {
    case 'executable-missing': return dockerMetadataMessages.cliUnavailable;
    case 'daemon-unreachable': return dockerMetadataMessages.daemonUnreachable;
    case 'access-denied': return dockerMetadataMessages.accessDenied;
    case 'timeout': return operation === 'metadata' ? dockerMetadataMessages.metadataTimeout : dockerLogMessages.logTimeout;
    case 'invalid': return operation === 'metadata' ? dockerMetadataMessages.metadataInvalid : dockerLogMessages.logInvalid;
    case 'failed': return operation === 'metadata' ? dockerMetadataMessages.metadataUnreadable : dockerLogMessages.logIncomplete;
  }
}

// A fixed-size circular byte deque bounds both retained bytes and fragmented-chunk references.
class BoundedByteTail {
  private chunks: Array<Buffer | undefined>;
  private head = 0;
  private count = 0;
  private retainedBytes = 0;

  constructor(private readonly maximumBytes: number) {
    this.chunks = new Array(maximumBytes + 1);
  }

  append(chunk: Buffer): boolean {
    if (chunk.length === 0) return false;
    if (chunk.length >= this.maximumBytes) {
      const truncated = this.retainedBytes > 0 || chunk.length > this.maximumBytes;
      this.chunks = new Array(this.maximumBytes + 1);
      const newest = Buffer.from(chunk.subarray(Math.max(0, chunk.length - this.maximumBytes)));
      this.chunks[0] = newest;
      this.head = 0;
      this.count = 1;
      this.retainedBytes = newest.length;
      return truncated;
    }

    const tail = (this.head + this.count) % this.chunks.length;
    this.chunks[tail] = chunk;
    this.count += 1;
    this.retainedBytes += chunk.length;
    let truncated = false;
    while (this.retainedBytes > this.maximumBytes) {
      const excess = this.retainedBytes - this.maximumBytes;
      const oldest = this.chunks[this.head]!;
      if (oldest.length <= excess) {
        this.chunks[this.head] = undefined;
        this.head = (this.head + 1) % this.chunks.length;
        this.count -= 1;
        this.retainedBytes -= oldest.length;
      } else {
        this.chunks[this.head] = oldest.subarray(excess);
        this.retainedBytes -= excess;
      }
      truncated = true;
    }
    return truncated;
  }

  toBuffer(): Buffer {
    const ordered: Buffer[] = [];
    for (let index = 0; index < this.count; index += 1) {
      ordered.push(this.chunks[(this.head + index) % this.chunks.length]!);
    }
    return Buffer.concat(ordered, this.retainedBytes);
  }
}

function runDockerCommand(args: string[], options: {
  spawn?: DockerSpawn;
  timeoutMs: number;
  maximumBytes: number;
  keepNewest?: boolean;
}): Promise<CommandResult> {
  let child;
  try {
    child = (options.spawn ?? spawn)('docker', args, {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeDockerEnvironment(),
    });
  } catch (error) {
    return Promise.resolve({ ok: false, error: dockerFailureFromSpawn(error) });
  }

  return new Promise(resolveResult => {
    let settled = false;
    let failure: DockerFailure | undefined;
    let totalBytes = 0;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const diagnosticChunks = options.keepNewest ? new BoundedByteTail(64 * 1024) : undefined;
    const orderedChunks = options.keepNewest ? new BoundedByteTail(options.maximumBytes) : undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolveResult(result);
    };
    const fail = (reason: DockerFailure) => {
      if (settled || failure) return;
      failure = reason;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs);
    const consume = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (options.keepNewest) {
        truncated = orderedChunks!.append(bytes) || truncated;
        if (stream === 'stderr') diagnosticChunks!.append(bytes);
        return;
      }
      totalBytes += bytes.length;
      if (totalBytes > options.maximumBytes) {
        fail('invalid');
        return;
      }
      (stream === 'stdout' ? stdoutChunks : stderrChunks).push(bytes);
    };
    child.stdout?.on('data', chunk => consume(chunk, 'stdout'));
    child.stderr?.on('data', chunk => consume(chunk, 'stderr'));
    child.once('error', error => finish({ ok: false, error: dockerFailureFromSpawn(error) }));
    child.once('close', code => {
      if (settled) return;
      if (failure) return finish({ ok: false, error: failure });
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (code !== 0) {
        const diagnostic = diagnosticChunks?.toBuffer() ?? stderr;
        return finish({ ok: false, error: dockerFailureFromStderr(diagnostic) });
      }
      if (options.keepNewest) {
        finish({ ok: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: orderedChunks!.toBuffer(), truncated });
      } else {
        finish({ ok: true, stdout, stderr, truncated: false });
      }
    });
  });
}

export async function listDockerContainers(options: { spawn?: DockerSpawn; timeoutMs?: number } = {}): Promise<DockerListResult> {
  const idsResult = await runDockerCommand(['ps', '--all', '--quiet', '--no-trunc'], {
    spawn: options.spawn,
    timeoutMs: options.timeoutMs ?? dockerMetadataTimeoutMs,
    maximumBytes: maximumDockerMetadataBytes,
  });
  if (!idsResult.ok) return { available: false, error: idsResult.error };
  let ids: string[];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(idsResult.stdout).trim();
    ids = text ? text.split(/\r?\n/) : [];
    if (ids.length > maximumDockerContainers || ids.some(id => !/^[a-f\d]{64}$/i.test(id))) throw new Error('Invalid Docker container IDs.');
  } catch {
    return { available: false, error: 'invalid' };
  }
  if (ids.length === 0) return { available: true, containers: [] };

  const inspectResult = await runDockerCommand(['inspect', ...ids], {
    spawn: options.spawn,
    timeoutMs: options.timeoutMs ?? dockerMetadataTimeoutMs,
    maximumBytes: maximumDockerMetadataBytes,
  });
  if (!inspectResult.ok) return { available: false, error: inspectResult.error };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(inspectResult.stdout);
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== ids.length) throw new Error('Invalid Docker inspect result.');
    const containers = value.map((entry: unknown): DockerContainer => {
      const parsed = containerSchema.parse(entry);
      if (!ids.includes(parsed.Id)) throw new Error('Unexpected Docker container identity.');
      const labels = parsed.Config.Labels ?? {};
      return {
        id: parsed.Id.toLowerCase(),
        name: parsed.Name.replace(/^\//, ''),
        image: parsed.Config.Image ?? '',
        state: parsed.State.Status || 'unknown',
        labels,
      };
    });
    return { available: true, containers };
  } catch {
    return { available: false, error: 'invalid' };
  }
}

async function canonicalRoots(roots: string[]): Promise<Map<string, string>> {
  const canonical = new Map<string, string>();
  for (const root of roots) {
    try {
      const path = await realpath(root);
      if (path === root) canonical.set(path, root);
    } catch { /* A stale registered root cannot be mapped. */ }
  }
  return canonical;
}

function exactLabelPaths(labels: Record<string, string>): string[] {
  const candidates: string[] = [];
  // Compose labels are a convention, not proof: another container can spoof these keys.
  const workingDirectory = labels['com.docker.compose.project.working_dir'];
  if (workingDirectory && isAbsolute(workingDirectory) && workingDirectory.length <= 4096 && !workingDirectory.includes('\0')) {
    candidates.push(resolve(workingDirectory));
  }
  // Compose stores its config file list as comma-separated absolute paths.
  // Only a config file directly inside an approved root is strong enough to
  // map; nested/parent containment is deliberately not inferred.
  const configFiles = labels['com.docker.compose.project.config_files'];
  if (configFiles && configFiles.length <= 16_384) {
    for (const file of configFiles.split(',').slice(0, 20)) {
      if (!isAbsolute(file) || file.length > 4096 || file.includes('\0')) continue;
      candidates.push(dirname(resolve(file)));
    }
  }
  return candidates;
}

export async function mapDockerContainers(roots: string[], containers: DockerContainer[], linkedContainerIds: string[] = []): Promise<{
  services: DockerMappedContainer[];
  ambiguousContainerCount: number;
  unmanagedContainers: DockerContainerInventory['unmanagedContainers'];
}> {
  const rootPaths = await canonicalRoots(roots);
  const linkedIds = new Set(linkedContainerIds.map(id => id.toLowerCase()));
  const services: DockerMappedContainer[] = [];
  let ambiguousContainerCount = 0;
  const unmanagedContainers: DockerContainerInventory['unmanagedContainers'] = [];
  for (const container of containers) {
    const explicitlyLinked = linkedIds.has(container.id.toLowerCase());
    const matchedRoots = [...new Set(exactLabelPaths(container.labels).flatMap(candidate => {
      const root = rootPaths.get(candidate);
      return root ? [root] : [];
    }))];
    if (explicitlyLinked) matchedRoots.length = 0;
    const safe = {
      runner: 'docker' as const,
      containerId: container.id,
      name: container.name,
      image: container.image,
      state: container.state,
      mappingSource: explicitlyLinked ? 'explicit-link' as const : 'compose-label' as const,
      matchedRoots,
      exactRootPath: explicitlyLinked ? null : matchedRoots.length === 1 ? matchedRoots[0] : null,
    };
    if (explicitlyLinked || matchedRoots.length === 1) services.push(safe);
    else {
      if (matchedRoots.length > 1) ambiguousContainerCount += 1;
      unmanagedContainers.push({
        runner: 'docker', containerId: container.id, name: container.name, image: container.image, state: container.state,
        mappingStatus: matchedRoots.length > 1 ? 'ambiguous' : 'unmatched', matchedRoots,
      });
    }
  }
  const sort = (a: DockerMappedContainer, b: DockerMappedContainer) => a.name.localeCompare(b.name) || a.containerId.localeCompare(b.containerId);
  services.sort(sort);
  unmanagedContainers.sort((a, b) => a.name.localeCompare(b.name) || a.containerId.localeCompare(b.containerId));
  return { services, ambiguousContainerCount, unmanagedContainers };
}

export async function dockerContainerInventory(roots: string[], list = listDockerContainers, options: {
  linkedContainerIds?: string[];
  includeUnmanaged?: boolean;
} = {}): Promise<DockerContainerInventory> {
  const result = await list();
  if (!result.available) {
    return {
      available: false,
      error: result.error,
      message: dockerFailureMessage(result.error, 'metadata'),
      containerCount: 0,
      matchedContainerCount: 0,
      ambiguousContainerCount: 0,
      unmanagedContainerCount: 0,
      services: [],
      unmanagedContainers: [],
    };
  }
  const mapped = await mapDockerContainers(roots, result.containers, options.linkedContainerIds);
  return {
    available: true,
    message: 'Docker returned bounded metadata. Unmatched and ambiguous containers are counted as unmanaged; details are opt-in and they are not actionable unless explicitly linked.',
    containerCount: result.containers.length,
    matchedContainerCount: mapped.services.length,
    unmanagedContainerCount: mapped.unmanagedContainers.length,
    ambiguousContainerCount: mapped.ambiguousContainerCount,
    services: mapped.services,
    unmanagedContainers: options.includeUnmanaged ? mapped.unmanagedContainers : [],
  };
}

export async function runDockerLogs(containerId: string, lines: number, options: { spawn?: DockerSpawn; timeoutMs?: number } = {}): Promise<DockerLogResult> {
  if (!/^[a-f\d]{64}$/i.test(containerId) || !Number.isInteger(lines) || lines < 1 || lines > 200) return { ok: false, error: 'invalid' };
  const result = await runDockerCommand(['logs', '--tail', String(lines), '--timestamps', containerId], {
    spawn: options.spawn,
    timeoutMs: options.timeoutMs ?? dockerLogTimeoutMs,
    maximumBytes: maximumDockerLogBytes,
    keepNewest: true,
  });
  if (!result.ok) return result;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(result.output).replace(/\n+$/, '');
  let start = decoded.length;
  let suffixBytes = 0;
  while (start > 0) {
    let codePoint = decoded.charCodeAt(start - 1);
    let width = 1;
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff && start > 1) {
      const high = decoded.charCodeAt(start - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        codePoint = 0x10000 + ((high - 0xd800) << 10) + (codePoint - 0xdc00);
        width = 2;
      }
    }
    const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (suffixBytes + codePointBytes > maximumDockerLogBytes) break;
    suffixBytes += codePointBytes;
    start -= width;
  }
  return { ok: true, output: start === 0 ? decoded : decoded.slice(start), truncated: result.truncated || start > 0 };
}
