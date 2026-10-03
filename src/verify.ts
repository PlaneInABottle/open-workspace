import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { inspectPm2Services, listPm2Processes, stableRootGroup } from './services.js';

export const verifyCommandTimeoutMs = 120_000;
export const verifySocketTimeoutMs = 180_000;
// Canonical owner of the workspace-not-found family (browser, datastore,
// workspace and http already import this module — zero new edges) plus the
// verification-path messages thrown below. http.ts composes its allowlist
// from this object, so a rename propagates.
export const verifyMessages = {
  notFoundRegister: 'Workspace not found. Register it first.',
  notFoundBare: 'Workspace not found.',
  folderInsideRoot: 'The selected folder is not inside an registered project root.',
  folderRealDirectory: 'The selected folder is not a real directory.',
  noScript: 'This repository has no runnable test script with that name.',
  serviceNotMapped: 'The linked service is not uniquely mapped to a registered root.',
} as const;
const gitCommandTimeoutMs = 10_000;
const dirtyDiffTimeoutMs = 5_000;
const dirtyDiffOutputLimit = 1024 * 1024;
const dirtyFileCap = 50;
const commandOutputLimit = 64 * 1024;
const manifestSizeLimit = 256 * 1024;
const scriptBodyLimit = 8192;
const scriptPreviewLength = 500;

export interface VerificationServiceLink {
  pmId: number | null;
  name: string;
  namespace?: string | null;
}

export interface VerificationRequest {
  repositoryPath: string;
  scriptName: string;
  service?: VerificationServiceLink;
}

export interface VerificationGitContext {
  revision: string | null;
  revisionState: 'observed' | 'unknown';
  worktree: 'clean' | 'dirty' | 'unknown';
  changedEntries: number | null;
  /**
   * Dirty-state fingerprint captured alongside the revision pin. Null when the
   * tree is clean, the checkout is not a git repo, or the bounded diff probe
   * timed out or failed. Only a content hash plus repo-relative path names is
   * ever persisted — diff content itself is never stored.
   */
  dirty: DirtyFingerprint | null;
}

/**
 * Which uncommitted code a verification ran against. `diffHash` is the
 * sha256 hex of the captured `git diff --no-color` output (content never
 * stored); `files` holds up to 50 repo-relative changed paths with no
 * contents or values; `truncated` marks a capped capture (diff output cap or
 * the 50-file cap), in which case `diffHash` covers what was captured.
 */
export interface DirtyFingerprint {
  diffHash: string;
  files: string[];
  truncated: boolean;
}

export interface VerificationServiceContext {
  pmId: number;
  name: string;
  namespace: string | null;
  status: string;
}

export interface VerificationResult {
  verifiedAt: string;
  repositoryPath: string;
  rootPath: string;
  scriptName: string;
  scriptHash: string;
  scriptPreview: string;
  outcome: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
  output: string;
  git: VerificationGitContext;
  service: VerificationServiceContext | null;
  message: string;
}

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  spawnFailed: boolean;
}

export type CommandRunner = (command: string, args: string[], options: {
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  input?: string;
}) => Promise<CommandOutcome>;

export function boundedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ['PATH', process.env.PATH],
    ['HOME', process.env.HOME],
    ['USER', process.env.USER],
    ['LOGNAME', process.env.LOGNAME],
    ['TMPDIR', process.env.TMPDIR],
    ...Object.entries(extra),
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export async function runBoundedCommand(command: string, args: string[], options: {
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  input?: string;
}): Promise<CommandOutcome> {
  const startedAt = Date.now();
  let child;
  try {
    child = (options.spawn ?? spawn)(command, args, {
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env ?? boundedEnvironment(),
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.write(options.input, 'utf8');
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  } catch {
    return { exitCode: null, timedOut: false, aborted: false, truncated: false, stdout: '', stderr: '', durationMs: Date.now() - startedAt, spawnFailed: true };
  }
  return new Promise(resolveOutcome => {
    let settled = false;
    let failure: 'timeout' | 'aborted' | 'overflow' | undefined;
    let truncated = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      options.signal?.removeEventListener('abort', onAbort);
      resolveOutcome(outcome);
    };
    const fail = (status: 'timeout' | 'aborted' | 'overflow') => {
      if (settled || failure) return;
      failure = status;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const onAbort = () => fail('aborted');
    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs);
    if (options.signal?.aborted) {
      fail('aborted');
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
    const consume = (chunk: Buffer | string, target: Buffer[]) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > options.outputLimit) {
        truncated = true;
        fail('overflow');
        return;
      }
      target.push(bytes);
    };
    const text = (chunks: Buffer[]) => new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    child.stdout?.on('data', chunk => consume(chunk, stdoutChunks));
    child.stderr?.on('data', chunk => consume(chunk, stderrChunks));
    child.once('error', () => finish({
      exitCode: null, timedOut: false, aborted: failure === 'aborted', truncated,
      stdout: text(stdoutChunks), stderr: text(stderrChunks), durationMs: Date.now() - startedAt, spawnFailed: true,
    }));
    child.once('close', code => {
      if (settled) return;
      finish({
        exitCode: failure ? null : code,
        timedOut: failure === 'timeout',
        aborted: failure === 'aborted',
        truncated,
        stdout: text(stdoutChunks),
        stderr: text(stderrChunks),
        durationMs: Date.now() - startedAt,
        spawnFailed: false,
      });
    });
  });
}

async function resolveRepository(workspaceRoots: string[], repositoryPath: string): Promise<{ repository: string; root: string }> {
  if (!isAbsolute(repositoryPath) || repositoryPath.includes('\0') || repositoryPath.length > 4096) {
    throw new Error(verifyMessages.folderInsideRoot);
  }
  const resolved = resolve(repositoryPath);
  let canonical: string;
  try {
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(verifyMessages.folderRealDirectory);
    canonical = await realpath(resolved);
    if (canonical !== resolved) throw new Error(verifyMessages.folderRealDirectory);
  } catch (error) {
    if (error instanceof Error && error.message !== verifyMessages.folderRealDirectory) {
      throw new Error(verifyMessages.folderInsideRoot);
    }
    throw error;
  }
  const group = await stableRootGroup(workspaceRoots, canonical);
  // Approval already rejects overlapping roots, so at most one root can own the folder.
  if (group.matchedRoots.length !== 1 || !group.exactRootPath) {
    throw new Error(verifyMessages.folderInsideRoot);
  }
  return { repository: canonical, root: group.exactRootPath };
}

async function readTestScript(repository: string, scriptName: string): Promise<{ body: string; hash: string }> {
  if (!/^[\w:.-]{1,80}$/.test(scriptName)) throw new Error(verifyMessages.noScript);
  const manifestPath = resolve(repository, 'package.json');
  let parsed: unknown;
  try {
    const file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > manifestSizeLimit) throw new Error(verifyMessages.noScript);
      parsed = JSON.parse(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(verifyMessages.noScript);
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const body = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>)[scriptName] : undefined;
  if (typeof body !== 'string' || !body || body.length > scriptBodyLimit) {
    throw new Error(verifyMessages.noScript);
  }
  return { body, hash: createHash('sha256').update(body, 'utf8').digest('hex') };
}

/** Repo-relative changed paths from `git status --porcelain` output, capped at 50 names. */
function dirtyFilesFromStatus(statusStdout: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let total = 0;
  for (const line of statusStdout.split('\n')) {
    if (!line) continue;
    total += 1;
    if (files.length >= dirtyFileCap) continue;
    const entry = line.slice(3);
    const arrow = entry.indexOf(' -> ');
    const raw = arrow >= 0 ? entry.slice(arrow + 4) : entry;
    const name = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (name) files.push(name);
  }
  return { files, truncated: total > files.length };
}

/**
 * Hash-only dirty fingerprint for a worktree already known to be dirty.
 * Returns null (never throws, never fails verification) when the checkout is
 * not a git repo, the bounded diff probe times out, fails, or cannot start.
 * A capped diff capture is still hashed with `truncated` set; only timeouts
 * and failures degrade to absent.
 */
export async function observeDirtyFingerprint(
  repository: string,
  run: CommandRunner,
  statusStdout: string,
): Promise<DirtyFingerprint | null> {
  let diff: CommandOutcome;
  try {
    diff = await run('git', ['diff', '--no-color'], {
      cwd: repository, timeoutMs: dirtyDiffTimeoutMs, outputLimit: dirtyDiffOutputLimit,
      env: boundedEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
    });
  } catch {
    return null;
  }
  if (diff.spawnFailed || diff.timedOut) return null;
  if (diff.exitCode !== 0 && !diff.truncated) return null;
  const { files, truncated } = dirtyFilesFromStatus(statusStdout);
  return {
    diffHash: createHash('sha256').update(diff.stdout, 'utf8').digest('hex'),
    files,
    truncated: truncated || diff.truncated,
  };
}

async function observeGitContext(repository: string, run: CommandRunner): Promise<VerificationGitContext> {
  const unknown: VerificationGitContext = { revision: null, revisionState: 'unknown', worktree: 'clean', changedEntries: null, dirty: null };
  let revision: CommandOutcome;
  try {
    revision = await run('git', ['rev-parse', 'HEAD'], {
      cwd: repository, timeoutMs: gitCommandTimeoutMs, outputLimit: 4096,
      env: boundedEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
    });
  } catch {
    return { ...unknown, worktree: 'unknown' };
  }
  if (revision.spawnFailed || revision.exitCode !== 0) return { ...unknown, worktree: 'unknown' };
  const sha = revision.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ...unknown, worktree: 'unknown' };
  let status: CommandOutcome;
  try {
    status = await run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: repository, timeoutMs: gitCommandTimeoutMs, outputLimit: commandOutputLimit,
      env: boundedEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
    });
  } catch {
    return { revision: sha, revisionState: 'observed', worktree: 'unknown', changedEntries: null, dirty: null };
  }
  if (status.spawnFailed || status.exitCode !== 0) {
    return { revision: sha, revisionState: 'observed', worktree: 'unknown', changedEntries: null, dirty: null };
  }
  const entries = status.stdout.split('\n').filter(line => line.length > 0).length;
  const worktree = entries === 0 ? 'clean' : 'dirty';
  if (worktree !== 'dirty') {
    return { revision: sha, revisionState: 'observed', worktree, changedEntries: entries, dirty: null };
  }
  return { revision: sha, revisionState: 'observed', worktree, changedEntries: entries, dirty: await observeDirtyFingerprint(repository, run, status.stdout) };
}

async function observeServiceLink(
  workspaceRoots: string[],
  link: VerificationServiceLink,
  list: typeof listPm2Processes,
): Promise<VerificationServiceContext> {
  if (typeof link.pmId !== 'number' || !Number.isInteger(link.pmId) || link.pmId < 0 || !link.name.trim() || link.name.length > 200) {
    throw new Error(verifyMessages.serviceNotMapped);
  }
  const listed = await list();
  if (!listed.available) throw new Error(verifyMessages.serviceNotMapped);
  const mapped = await inspectPm2Services(workspaceRoots, listed.processes);
  const service = [...mapped.services, ...mapped.ambiguousServices]
    .find(service => service.pmId === link.pmId && service.name === link.name);
  if (!service?.exactRootPath || (link.namespace && service.namespace && service.namespace !== link.namespace)) {
    throw new Error(verifyMessages.serviceNotMapped);
  }
  return { pmId: service.pmId ?? link.pmId, name: service.name, namespace: service.namespace, status: service.status };
}

export async function runVerification(
  workspaceRoots: string[],
  request: VerificationRequest,
  options: {
    list?: typeof listPm2Processes;
    runCommand?: CommandRunner;
    signal?: AbortSignal;
  } = {},
): Promise<VerificationResult> {
  const run = options.runCommand ?? runBoundedCommand;
  const { repository, root } = await resolveRepository(workspaceRoots, request.repositoryPath);
  const script = await readTestScript(repository, request.scriptName);
  const service = request.service ? await observeServiceLink(workspaceRoots, request.service, options.list ?? listPm2Processes) : null;
  const git = await observeGitContext(repository, run);
  const outcome = await run('npm', ['run', request.scriptName, '--silent'], {
    cwd: repository,
    timeoutMs: verifyCommandTimeoutMs,
    outputLimit: commandOutputLimit,
    signal: options.signal,
    env: boundedEnvironment({ CI: 'true' }),
  });
  const verifiedAt = new Date().toISOString();
  const output = outcome.stderr ? `${outcome.stdout}\n--- stderr ---\n${outcome.stderr}` : outcome.stdout;
  const preview = script.body.length > scriptPreviewLength ? `${script.body.slice(0, scriptPreviewLength)}…` : script.body;
  if (outcome.spawnFailed) {
    return {
      verifiedAt, repositoryPath: repository, rootPath: root, scriptName: request.scriptName,
      scriptHash: script.hash, scriptPreview: preview, outcome: 'error', exitCode: null,
      timedOut: false, aborted: outcome.aborted, truncated: outcome.truncated, durationMs: outcome.durationMs,
      output, git, service,
      message: 'The repository test could not start. npm is unavailable on this machine.',
    };
  }
  if (outcome.aborted) {
    return {
      verifiedAt, repositoryPath: repository, rootPath: root, scriptName: request.scriptName,
      scriptHash: script.hash, scriptPreview: preview, outcome: 'error', exitCode: null,
      timedOut: false, aborted: true, truncated: outcome.truncated, durationMs: outcome.durationMs,
      output, git, service,
      message: 'The verification request was cancelled. Cancellation is not rollback; the repository state is unchanged by OpenWorkspace.',
    };
  }
  if (outcome.exitCode === null && !outcome.aborted && !outcome.timedOut) {
    return {
      verifiedAt, repositoryPath: repository, rootPath: root, scriptName: request.scriptName,
      scriptHash: script.hash, scriptPreview: preview, outcome: 'failed', exitCode: null,
      timedOut: false, aborted: false, truncated: outcome.truncated, durationMs: outcome.durationMs,
      output, git, service,
      message: 'The repository test produced more output than the bounded capture. Rerun a narrower check instead of treating this as a pass.',
    };
  }
  if (outcome.timedOut || outcome.exitCode !== 0) {
    return {
      verifiedAt, repositoryPath: repository, rootPath: root, scriptName: request.scriptName,
      scriptHash: script.hash, scriptPreview: preview, outcome: 'failed', exitCode: outcome.exitCode,
      timedOut: outcome.timedOut, aborted: false, truncated: outcome.truncated, durationMs: outcome.durationMs,
      output, git, service,
      message: outcome.timedOut
        ? 'The repository test did not finish within the bounded runtime. A timeout is a failure, not a pass.'
        : `The repository test exited with code ${outcome.exitCode}. Running, ready and test-passed remain distinct.`,
    };
  }
  return {
    verifiedAt, repositoryPath: repository, rootPath: root, scriptName: request.scriptName,
    scriptHash: script.hash, scriptPreview: preview, outcome: 'passed', exitCode: 0,
    timedOut: false, aborted: false, truncated: outcome.truncated, durationMs: outcome.durationMs,
    output, git, service,
    message: 'The repository test exited 0 in this checkout. This is local diagnostic context, not a CI verdict or end-to-end business verification.',
  };
}
