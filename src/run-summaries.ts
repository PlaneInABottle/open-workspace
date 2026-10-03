import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from './store.js';

export interface RunSummary {
  workspaceId: string;
  scriptName: string;
  outcome: 'passed' | 'failed' | 'error';
  durationMs: number;
  at: string;
  failingNames: string[];
  failingTruncated: boolean;
  /** Secret-masked first 2 KiB of combined output. */
  failureExcerpt: string;
  excerptTruncated: boolean;
  outputTruncated: boolean;
}

export interface RunListEntry extends Omit<RunSummary, 'failureExcerpt'> {
  /** failureExcerpt capped at 200 chars for list views. */
  excerptPreview: string;
}

const maxSummariesPerScope = 20;
const excerptLimit = 2048;
const listExcerptLimit = 200;
const maxFailingNames = 20;

/** Mask secret-shaped text while keeping paths and structure readable. */
export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, 'Bearer ***')
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)\s*[:=]\s*)['"]?[^\s'";,]+/gi, '$1***');
}

/** Best-effort failing-test-name extraction across TAP, node:test, jest and mocha shapes. */
export function parseFailingNames(output: string): { names: string[]; truncated: boolean } {
  const names: string[] = [];
  const patterns = [/^\s*not ok \d+\s+(.+?)\s*$/i, /^\s*[✖✕×]\s+(.+?)\s*$/, /^\s*FAIL\s+(.+?)\s*$/i];
  for (const line of output.split('\n')) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        const name = match[1].length > 120 ? `${match[1].slice(0, 120)}…` : match[1];
        if (!names.includes(name)) names.push(name);
        break;
      }
    }
    if (names.length >= maxFailingNames) break;
  }
  const total = output.split('\n').reduce((count, line) =>
    count + (patterns.some(pattern => pattern.test(line)) ? 1 : 0), 0);
  return { names, truncated: total > names.length };
}

function scopeDirectory(homeDirectory: string, workspaceId: string): string {
  return join(homeDirectory, 'runs', workspaceId);
}

export async function persistRunSummary(homeDirectory: string, entry: {
  workspaceId: string;
  scriptName: string;
  outcome: 'passed' | 'failed' | 'error';
  durationMs: number;
  output: string;
  outputTruncated: boolean;
}): Promise<RunSummary> {
  const directory = scopeDirectory(homeDirectory, entry.workspaceId);
  await ensurePrivateDirectory(directory);
  const masked = maskSecrets(entry.output);
  const failing = parseFailingNames(masked);
  const summary: RunSummary = {
    workspaceId: entry.workspaceId,
    scriptName: entry.scriptName,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    at: new Date().toISOString(),
    failingNames: failing.names,
    failingTruncated: failing.truncated,
    failureExcerpt: masked.slice(0, excerptLimit),
    excerptTruncated: masked.length > excerptLimit,
    outputTruncated: entry.outputTruncated,
  };
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    summary.failureExcerpt = summary.failureExcerpt.slice(0, excerptLimit);
  }
  await writeFile(join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}.json`), JSON.stringify(summary), { mode: 0o600 });
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort().reverse();
  await Promise.all(files.slice(maxSummariesPerScope).map(stale => rm(join(directory, stale), { force: true })));
  return summary;
}

export async function readRunDurations(homeDirectory: string, workspaceId: string): Promise<number[]> {
  let files: string[];
  try {
    files = (await readdir(scopeDirectory(homeDirectory, workspaceId))).filter(name => name.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const durations: number[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(join(scopeDirectory(homeDirectory, workspaceId), file), 'utf8')) as { durationMs?: unknown };
      if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)) durations.push(parsed.durationMs);
    } catch {
      continue;
    }
  }
  return durations;
}

export async function listRecentRuns(homeDirectory: string, workspaceId: string, limit: number): Promise<RunListEntry[]> {
  let files: string[];
  try {
    files = (await readdir(scopeDirectory(homeDirectory, workspaceId))).filter(name => name.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const entries: RunListEntry[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const summary = JSON.parse(await readFile(join(scopeDirectory(homeDirectory, workspaceId), file), 'utf8')) as RunSummary;
      const { failureExcerpt, ...rest } = summary;
      entries.push({ ...rest, excerptPreview: (failureExcerpt ?? '').slice(0, listExcerptLimit) });
    } catch {
      continue;
    }
  }
  return entries;
}

export async function countDrafts(homeDirectory: string): Promise<number> {
  try {
    return (await readdir(join(homeDirectory, 'learnings', '_drafts'))).filter(name => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatFactor(latest: number, reference: number): string {
  return String(Number((latest / reference).toFixed(1)));
}

/** Pure signal check: durations are newest-first. */
export function evaluateLearningSignal(durationsNewestFirst: number[], draftCount: number): {
  slowdown?: { factor: string; latestMs: number; medianMs: number };
  draftsPending?: number;
} {
  const signal: { slowdown?: { factor: string; latestMs: number; medianMs: number }; draftsPending?: number } = {};
  if (durationsNewestFirst.length >= 3) {
    const reference = median(durationsNewestFirst.slice(1));
    if (reference > 0 && durationsNewestFirst[0] > 3 * reference) {
      signal.slowdown = { factor: formatFactor(durationsNewestFirst[0], reference), latestMs: durationsNewestFirst[0], medianMs: reference };
    }
  }
  if (draftCount >= 3) signal.draftsPending = draftCount;
  return signal;
}

export function buildLearningLine(signal: ReturnType<typeof evaluateLearningSignal>): string | undefined {
  const parts: string[] = [];
  if (signal.slowdown) {
    parts.push(`last verify run took ${signal.slowdown.factor}x expected (${signal.slowdown.latestMs}ms vs median ${signal.slowdown.medianMs}ms)`);
  }
  if (signal.draftsPending !== undefined) parts.push(`${signal.draftsPending} unprocessed learning drafts pending`);
  if (parts.length === 0) return undefined;
  return `Note: ${parts.join('; ')} — consider running learn-from-mistake.`;
}

/** One dynamic MCP-instructions line, or undefined when neither threshold is met. */
export async function learningInstructionSuffix(homeDirectory: string): Promise<string | undefined> {
  let scopes: string[];
  try {
    scopes = await readdir(join(homeDirectory, 'runs'));
  } catch {
    scopes = [];
  }
  let slowest: { factor: string; latestMs: number; medianMs: number } | undefined;
  for (const scope of scopes) {
    const durations = await readRunDurations(homeDirectory, scope);
    const signal = evaluateLearningSignal(durations, 0);
    if (signal.slowdown && (!slowest || Number(signal.slowdown.factor) > Number(slowest.factor))) slowest = signal.slowdown;
  }
  const drafts = await countDrafts(homeDirectory);
  return buildLearningLine({ ...(slowest ? { slowdown: slowest } : {}), ...(drafts >= 3 ? { draftsPending: drafts } : {}) });
}
