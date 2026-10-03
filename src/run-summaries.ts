import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory, Store } from './store.js';
import type { DirtyFingerprint } from './verify.js';

export type RunSource = 'openworkspace-run' | 'external-import' | 'unknown-source';

/**
 * One environment service pinned to a verification run. Receipt services are
 * capped (≤10 services, ≤10 dirty files each, names sliced) so the worst case
 * stays inside the 64 KiB summary-file budget; `truncated` is forced whenever
 * a slice discards names, and the writer shrinks further rather than failing.
 */
export interface EnvironmentReceiptService {
  serviceId: string;
  name: string;
  pmId: number;
  namespace: string | null;
  status: string;
  revision: string | null;
  dirty: { diffHash: string; files: string[]; truncated: boolean } | null;
}

export interface EnvironmentReceipt {
  envId: string;
  envName: string;
  services: EnvironmentReceiptService[];
}

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
  /**
   * Owned multi-service identity the run verified against (M2
   * `environment_verify` only). Additive: older files omit it and read as
   * null. Never a second verification claim — it reuses the same revision /
   * dirty shapes as the single-service context above.
   */
  environment?: EnvironmentReceipt | null;
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

const maxReceiptServices = 10;
const maxReceiptDirtyFiles = 10;
const maxReceiptNameLength = 256;
const summaryFileLimit = 64 * 1024;

// Defensive receipt cap: services ≤10, dirty files ≤10 each with `truncated`
// forced on any slice, names sliced to 256 chars, non-hex revisions degraded
// to null. A wide or hostile caller cannot inflate the summary file.
export function capEnvironmentReceipt(receipt: EnvironmentReceipt | null): EnvironmentReceipt | null {
  if (!receipt || typeof receipt !== 'object') return null;
  return {
    envId: typeof receipt.envId === 'string' ? receipt.envId.slice(0, 36) : '',
    envName: typeof receipt.envName === 'string' ? receipt.envName.slice(0, 100) : '',
    services: (Array.isArray(receipt.services) ? receipt.services : []).slice(0, maxReceiptServices).map(service => {
      const dirty = service?.dirty === undefined || service?.dirty === null ? null : {
        diffHash: typeof service.dirty.diffHash === 'string' ? service.dirty.diffHash.slice(0, 64) : '',
        files: (Array.isArray(service.dirty.files) ? service.dirty.files : [])
          .filter((file): file is string => typeof file === 'string' && file.length > 0)
          .map(file => file.slice(0, maxReceiptNameLength))
          .slice(0, maxReceiptDirtyFiles),
        truncated: service.dirty.truncated || (Array.isArray(service.dirty.files) && service.dirty.files.length > maxReceiptDirtyFiles),
      };
      return {
        serviceId: typeof service?.serviceId === 'string' ? service.serviceId.slice(0, 80) : '',
        name: typeof service?.name === 'string' ? service.name.slice(0, 200) : '',
        pmId: typeof service?.pmId === 'number' && Number.isInteger(service.pmId) ? service.pmId : -1,
        namespace: typeof service?.namespace === 'string' ? service.namespace.slice(0, 80) : null,
        status: typeof service?.status === 'string' ? service.status.slice(0, 32) : 'unknown',
        revision: typeof service?.revision === 'string' && /^[0-9a-f]{40}$/.test(service.revision) ? service.revision : null,
        dirty,
      };
    }),
  };
}
/**
 * Hard ceiling on stored summary files per scope. The ring keeps the newest
 * 20; runs referenced by a checkpoint note in scope survive eviction, but
 * pins never push a scope past 30 files — older pins evict first once the
 * ceiling is reached. Pins are IDs only, never content.
 */
export const maxPinnedSummariesPerScope = 30;
/**
 * Hard ceiling on scopes examined by the MCP startup scan. Matches the
 * 50-workspace registration limit so live state always fits while orphaned
 * or junk entries cannot grow startup cost without bound.
 */
export const maxScopesPerStartupScan = 50;
const excerptLimit = 2048;
const listExcerptLimit = 200;
const maxFailingNames = 20;
// Prompt after three failed/errored runs among the newest 20 local runs across scanned scopes.
// Exported for the learning rule index, which reuses the same local-only window.
export const maxRecentRunsForLearningSignal = 20;
const failedRunThresholdForLearningSignal = 3;

/** IDs referenced by checkpoint notes or completion checks in scope, exempt from ordinary run-ring eviction. */
export function pinnedRunIds(
  workstreams: Array<{
    workspaceId: string;
    checkpointNote: { evidence?: string[] } | null;
    completions?: Array<{ checks: Array<{ evidenceIds?: string[] }> }>;
  }>,
  workspaceId: string,
): Set<string> {
  const pinned = new Set<string>();
  for (const workstream of workstreams) {
    if (workstream.workspaceId !== workspaceId) continue;
    for (const id of workstream.checkpointNote?.evidence ?? []) pinned.add(id);
    for (const completion of workstream.completions ?? []) {
      for (const check of completion.checks) {
        for (const id of check.evidenceIds ?? []) pinned.add(id);
      }
    }
  }
  return pinned;
}

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
  environment?: EnvironmentReceipt | null;
  pinned?: ReadonlySet<string>;
}, store?: Store): Promise<RunSummary> {
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
    environment: capEnvironmentReceipt(entry.environment ?? null),
  };
  await storeSummaryFile(directory, id, summary, entry.pinned, store);
  return summary;
}

async function pruneStoredSummaries(directory: string, pinned: ReadonlySet<string>): Promise<void> {
  // Newest-first ring: the newest 20 always stay; pinned runs survive past
  // the ring up to the per-scope hard ceiling.
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

async function storeSummaryFile(
  directory: string,
  id: string,
  summary: RunSummary,
  pinned: ReadonlySet<string> = new Set(),
  store?: Store,
): Promise<void> {
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') > summaryFileLimit) {
    // Truncate-never-fail: shrink receipt dirty names first (forcing
    // `truncated`), never the verification outcome or the masked excerpt.
    // Worst case (every name cleared) is a few KiB, so this terminates.
    const receipt = summary.environment;
    if (receipt) {
      let over = true;
      while (over && receipt.services.some(service => (service.dirty?.files.length ?? 0) > 0)) {
        for (const service of receipt.services) {
          if (service.dirty && service.dirty.files.length > 0) {
            service.dirty.files = service.dirty.files.slice(0, Math.floor(service.dirty.files.length / 2));
            service.dirty.truncated = true;
          }
        }
        over = Buffer.byteLength(JSON.stringify(summary), 'utf8') > summaryFileLimit;
      }
      if (over) summary.environment = null;
    } else {
      summary.failureExcerpt = summary.failureExcerpt.slice(0, excerptLimit);
    }
  }
  await writeFile(join(directory, `${id}.json`), JSON.stringify(summary), { mode: 0o600 });
  if (store) {
    // Serialize eviction with completion/checkpoint writes and derive pins from
    // the queued state: a pre-persist snapshot can miss a ref committed while
    // this summary was being written.
    await store.update(async state => {
      await pruneStoredSummaries(directory, pinnedRunIds(state.workstreams, summary.workspaceId));
    });
  } else {
    await pruneStoredSummaries(directory, pinned);
  }
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
export const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

export async function importExternalRun(homeDirectory: string, parsed: ExternalRunImport, pinned: ReadonlySet<string> = new Set(), store?: Store): Promise<RunSummary> {
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
  await storeSummaryFile(directory, id, summary, pinned, store);
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

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatFactor(latest: number, reference: number): string {
  return String(Number((latest / reference).toFixed(1)));
}

/** Pure signal check: durations and the recent run window are newest-first. */
export function evaluateLearningSignal(durationsNewestFirst: number[], recentFailedRuns: number): {
  slowdown?: { factor: string; latestMs: number; medianMs: number };
  recentFailedRuns?: number;
} {
  const signal: { slowdown?: { factor: string; latestMs: number; medianMs: number }; recentFailedRuns?: number } = {};
  if (durationsNewestFirst.length >= 3) {
    const reference = median(durationsNewestFirst.slice(1));
    if (reference > 0 && durationsNewestFirst[0] > 3 * reference) {
      signal.slowdown = { factor: formatFactor(durationsNewestFirst[0], reference), latestMs: durationsNewestFirst[0], medianMs: reference };
    }
  }
  if (recentFailedRuns >= failedRunThresholdForLearningSignal) signal.recentFailedRuns = recentFailedRuns;
  return signal;
}

export function buildLearningLine(signal: ReturnType<typeof evaluateLearningSignal>): string | undefined {
  const parts: string[] = [];
  if (signal.slowdown) {
    parts.push(`last verify run took ${signal.slowdown.factor}x expected (${signal.slowdown.latestMs}ms vs median ${signal.slowdown.medianMs}ms)`);
  }
  if (signal.recentFailedRuns !== undefined) parts.push(`${signal.recentFailedRuns} of the last ${maxRecentRunsForLearningSignal} local verification runs failed or errored`);
  if (parts.length === 0) return undefined;
  return `Note: ${parts.join('; ')} — consider running learn-from-mistake.`;
}

/** One dynamic MCP-instructions line, or undefined when neither threshold is met. */
export async function learningInstructionSuffix(homeDirectory: string): Promise<string | undefined> {
  let registeredScopes: string[] = [];
  try {
    registeredScopes = (await new Store(homeDirectory).read()).workspaces
      .map(workspace => workspace.id)
      .filter(scope => uuidPattern.test(scope));
  } catch {
    // Startup guidance is best-effort when private workspace state is absent or invalid.
  }
  const registeredIds = new Set(registeredScopes.map(scope => scope.toLowerCase()));
  let discoveredScopes: string[] = [];
  try {
    // Registered scopes get first claim on the fixed scan budget; orphaned
    // UUID directories are considered only after all registered scopes.
    discoveredScopes = (await readdir(join(homeDirectory, 'runs'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && uuidPattern.test(entry.name))
      .map(entry => entry.name);
  } catch {
    discoveredScopes = [];
  }
  const scopes = [
    ...registeredScopes,
    ...discoveredScopes.filter(scope => !registeredIds.has(scope.toLowerCase())).sort(),
  ].slice(0, maxScopesPerStartupScan);
  let slowest: { factor: string; latestMs: number; medianMs: number } | undefined;
  const recentRuns: Array<Pick<RunListEntry, 'at' | 'outcome'>> = [];
  for (const scope of scopes) {
    const [durations, runs] = await Promise.all([
      readRunDurations(homeDirectory, scope),
      listRecentRuns(homeDirectory, scope, maxRecentRunsForLearningSignal),
    ]);
    const signal = evaluateLearningSignal(durations, 0);
    if (signal.slowdown && (!slowest || Number(signal.slowdown.factor) > Number(slowest.factor))) slowest = signal.slowdown;
    recentRuns.push(...runs
      .filter(run => run.source === 'openworkspace-run' && Number.isFinite(Date.parse(run.at)))
      .map(({ at, outcome }) => ({ at, outcome })));
  }
  const recentFailureCount = recentRuns
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, maxRecentRunsForLearningSignal)
    .filter(run => run.outcome === 'failed' || run.outcome === 'error').length;
  return buildLearningLine({
    ...(slowest ? { slowdown: slowest } : {}),
    ...(recentFailureCount >= failedRunThresholdForLearningSignal ? { recentFailedRuns: recentFailureCount } : {}),
  });
}
