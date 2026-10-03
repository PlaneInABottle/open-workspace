import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from './store.js';
import type { DirtyFingerprint } from './verify.js';

export type RunSource = 'openworkspace-run' | 'external-import' | 'unknown-source';

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
  /**
   * Stable opaque file stem identifying this summary within its scope
   * (IDs only, never content). Newer files carry it; older files omit it
   * and readers fall back to the file stem.
   */
  id?: string;
  /** Evidence source: executed here vs pasted on trust. Older files omit it. */
  source?: RunSource;
  /**
   * HEAD revision the run verified against, when observed. Older files omit it.
   * Additive only: old readers ignore it, new readers treat a missing value
   * the same as null.
   */
  revision?: string | null;
  /**
   * Dirty-state fingerprint (content hash plus path names only, never diff
   * content). Null when the tree was clean, the checkout was not a git repo,
   * or the bounded diff probe degraded. Older files omit it.
   */
  dirty?: DirtyFingerprint | null;
}

export interface RunListEntry extends Omit<RunSummary, 'failureExcerpt'> {
  /** Stable opaque summary ID within its scope (the file stem). */
  id: string;
  /** FailureExcerpt capped at 200 chars for list views. */
  excerptPreview: string;
  /** Evidence source, defaulting to openworkspace-run for older files. */
  source: RunSource;
  /** Distinct human wording for the source; never a verification claim for imports. */
  sourceLabel: string;
  /** True when a checkpoint note in this scope references this run, exempting it from ring eviction. */
  pinnedByNote: boolean;
}

const maxSummariesPerScope = 20;
/**
 * Hard ceiling on stored summary files per scope. The ring keeps the newest
 * 20; runs referenced by a checkpoint note in scope survive eviction, but
 * pins never push a scope past 30 files — older pins evict first once the
 * ceiling is reached. Pins are IDs only, never content.
 */
export const maxPinnedSummariesPerScope = 30;
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
  revision?: string | null;
  dirty?: DirtyFingerprint | null;
  pinned?: ReadonlySet<string>;
}): Promise<RunSummary> {
  const directory = scopeDirectory(homeDirectory, entry.workspaceId);
  await ensurePrivateDirectory(directory);
  const masked = maskSecrets(entry.output);
  const failing = parseFailingNames(masked);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const summary: RunSummary = {
    id,
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
    source: 'openworkspace-run',
    revision: entry.revision ?? null,
    // Hash plus path names only: diff content is never persisted. The
    // producer caps files at 50; re-cap defensively so a wide caller cannot
    // inflate the bounded summary file.
    dirty: entry.dirty === undefined || entry.dirty === null ? null : {
      diffHash: entry.dirty.diffHash,
      files: entry.dirty.files.slice(0, 50),
      truncated: entry.dirty.truncated,
    },
  };
  await storeSummaryFile(directory, id, summary, entry.pinned);
  return summary;
}

async function storeSummaryFile(
  directory: string,
  id: string,
  summary: RunSummary,
  pinned: ReadonlySet<string> = new Set(),
): Promise<void> {
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    summary.failureExcerpt = summary.failureExcerpt.slice(0, excerptLimit);
  }
  await writeFile(join(directory, `${id}.json`), JSON.stringify(summary), { mode: 0o600 });
  // Newest-first ring: the newest 20 always stay; pinned runs referenced by a
  // checkpoint note survive past the ring up to the per-scope hard ceiling.
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort().reverse();
  let kept = 0;
  const stale: string[] = [];
  for (const file of files) {
    if (kept < maxSummariesPerScope || (kept < maxPinnedSummariesPerScope && pinned.has(runIdFromFile(file)))) {
      kept += 1;
    } else {
      stale.push(file);
    }
  }
  await Promise.all(stale.map(staleFile => rm(join(directory, staleFile), { force: true })));
}

/** Opaque summary ID: the file stem, without parsing any content. */
export function runIdFromFile(fileName: string): string {
  return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
}

/** IDs of every stored summary in scope (file stems only, never content). */
export async function listRunIds(homeDirectory: string, workspaceId: string): Promise<Set<string>> {
  let files: string[];
  try {
    files = (await readdir(scopeDirectory(homeDirectory, workspaceId))).filter(name => name.endsWith('.json'));
  } catch {
    return new Set();
  }
  return new Set(files.map(runIdFromFile));
}

/** Distinct wording key for each evidence source; anything not executed here never claims verification. */
export function sourceLabel(source: RunSource): string {
  if (source === 'external-import') return 'Pasted result — not verified here';
  if (source === 'unknown-source') return 'Unknown source — not verified here';
  return 'Executed here — context-stamped';
}

function readSource(raw: unknown): RunSource {
  if (raw === 'external-import') return 'external-import';
  // Legacy omission still defaults to openworkspace-run, but a present
  // unknown value degrades to a distinct unverified source, never a pass.
  if (raw === undefined || raw === null) return 'openworkspace-run';
  return raw === 'openworkspace-run' ? 'openworkspace-run' : 'unknown-source';
}

export const externalImportInvalidMessage = 'Imported results are not valid.';
export const externalImportClaimMessage = 'Imported results are accepted on trust and never marked verified.';

const maxImportExcerpt = 500;
const maxImportDurationMs = 86_400_000;
const allowedImportKeys = ['workspaceId', 'scriptName', 'outcome', 'durationMs', 'excerpt'];
const forbiddenImportKeys = /verif|attest|proof|signatur|revision|hash|trust|certif/i;
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ExternalRunImport {
  workspaceId: string;
  scriptName: string;
  outcome: 'passed' | 'failed' | 'error';
  durationMs: number;
  excerpt: string;
}

/**
 * Strict bounded parse for a pasted external result. Claim-like keys are
 * refused as verification claims (not generic invalid input), every other
 * unknown key is refused outright, and a "verified" assertion in the excerpt
 * is refused: imports are accepted on trust and must never read as
 * verified-by-us.
 */
export function parseExternalRunImport(raw: unknown): ExternalRunImport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(externalImportInvalidMessage);
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (forbiddenImportKeys.test(key)) throw new Error(externalImportClaimMessage);
    if (!allowedImportKeys.includes(key)) throw new Error(externalImportInvalidMessage);
  }
  const { workspaceId, scriptName, outcome, durationMs, excerpt } = record;
  if (typeof workspaceId !== 'string' || !uuidPattern.test(workspaceId)) throw new Error(externalImportInvalidMessage);
  if (typeof scriptName !== 'string' || !/^[\w:.-]{1,80}$/.test(scriptName)) throw new Error(externalImportInvalidMessage);
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'error') throw new Error(externalImportInvalidMessage);
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > maxImportDurationMs) {
    throw new Error(externalImportInvalidMessage);
  }
  if (typeof excerpt !== 'string' || excerpt.length > maxImportExcerpt || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(excerpt)) {
    throw new Error(externalImportInvalidMessage);
  }
  if (/\bverified\b/i.test(excerpt)) throw new Error(externalImportClaimMessage);
  return { workspaceId: workspaceId.toLowerCase(), scriptName, outcome, durationMs, excerpt };
}

export async function importExternalRun(homeDirectory: string, parsed: ExternalRunImport, pinned: ReadonlySet<string> = new Set()): Promise<RunSummary> {
  const directory = scopeDirectory(homeDirectory, parsed.workspaceId);
  await ensurePrivateDirectory(directory);
  const masked = maskSecrets(parsed.excerpt);
  const failing = parseFailingNames(masked);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const summary: RunSummary = {
    id,
    workspaceId: parsed.workspaceId,
    scriptName: parsed.scriptName,
    outcome: parsed.outcome,
    durationMs: parsed.durationMs,
    at: new Date().toISOString(),
    failingNames: failing.names,
    failingTruncated: failing.truncated,
    failureExcerpt: masked.slice(0, maxImportExcerpt),
    excerptTruncated: parsed.excerpt.length > maxImportExcerpt,
    outputTruncated: true,
    source: 'external-import',
  };
  await storeSummaryFile(directory, id, summary, pinned);
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
      const parsed = JSON.parse(await readFile(join(scopeDirectory(homeDirectory, workspaceId), file), 'utf8')) as { durationMs?: unknown; source?: unknown };
      // Pasted external-import durations — and any unknown-source value —
      // never feed the learning signal: the "last verify run" line must only
      // describe runs executed here. Legacy files without a source still count.
      if (parsed.source !== undefined && parsed.source !== null && parsed.source !== 'openworkspace-run') continue;
      if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)) durations.push(parsed.durationMs);
    } catch {
      continue;
    }
  }
  return durations;
}

export async function listRecentRuns(homeDirectory: string, workspaceId: string, limit: number, pinned: ReadonlySet<string> = new Set()): Promise<RunListEntry[]> {
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
      const id = summary.id ?? runIdFromFile(file);
      const source = readSource(summary.source);
      entries.push({ ...rest, id, source, sourceLabel: sourceLabel(source), excerptPreview: (failureExcerpt ?? '').slice(0, listExcerptLimit), pinnedByNote: pinned.has(id) || pinned.has(runIdFromFile(file)) });
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
