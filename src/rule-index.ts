import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory, writePrivateJson } from './store.js';
import {
  listRecentRuns,
  maskSecrets,
  maxRecentRunsForLearningSignal,
  uuidPattern,
  type RunListEntry,
} from './run-summaries.js';
import { readdir } from 'node:fs/promises';
import { Store } from './store.js';

// Learning rule index: the platform does NOT own lessons (they live in user
// AGENTS.md/skills files). It only indexes titles plus source refs plus
// evidence links, injects relevant titles at session start, measures
// recurrence and flags suspects. Index carries titles/file refs only, never
// rule bodies.
//
// Matching is case-insensitive substring on normalized tokens, NOT
// vector/semantic search: at most 50 entries against at most 20 recent runs,
// substring is deterministic, bounded and explainable, and needs no model,
// embeddings store or extra dependency.
//
// Lifecycle choice (per plan): suspect flips persist from an explicit bounded
// recompute called on the injection path (learningLessonLine below), in the
// same queued index write — not lazily on every read. lastValidatedAt is
// stamped at creation and never refreshed: recording the same title+file
// again creates a NEW entry (no upsert) and the old one stays until eviction.
// The learning_record append itself is mechanical bookkeeping, outside the
// skill's 5-rule cap.

export const learningMessages = {
  bounds: 'Learning record fields are out of range.',
  pattern: 'Learning records accept titles and references only, never secrets or literals.',
  evidence: 'Learning evidence must reference existing runs in this workspace.',
} as const;

export interface LearningFailureSignature {
  tests: string[];
  errorClasses: string[];
}

export interface LearningRuleEntry {
  id: string;
  title: string;
  file: string;
  evidenceRefs: string[];
  failureSignature: LearningFailureSignature;
  createdAt: string;
  lastValidatedAt: string;
  status: 'active' | 'suspect';
}

/** Hard ceiling on stored entries. Suspects evict last (see evictLearningEntries). */
export const maxLearningEntries = 50;
export const maxLearningTitle = 80;
export const maxLearningFile = 256;
export const maxEvidenceRefs = 5;
export const maxSignatureItems = 10;
export const maxSignatureItemLength = 120;
/** Total MCP instructions budget shared with the base + learning suffix. */
export const learningTotalCap = 760;
const maxLessonTitlesPerLine = 3;

// Mirrors workstreams.ts: opaque run-summary stems only (never slashes,
// whitespace or secret-shaped content). Shape refusal is a bounds error;
// well-formed but unknown IDs are refused separately against stored runs.
const evidenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Mirrors workstreams.ts absolutePathPattern: pattern-only text never carries
// filesystem literals (leading / after a boundary, drive prefixes, UNC).
const absolutePathPattern = /(^|[\s"'=(])(\/[^\s"';)]+|[A-Za-z]:[\\/][^\s]*|\\\\[^\s]+)/i;

function indexPath(homeDirectory: string): string {
  return join(homeDirectory, 'learnings', 'index.json');
}

function isPatternClean(value: string): boolean {
  return !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    && maskSecrets(value) === value
    && !absolutePathPattern.test(value);
}

function learningField(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(learningMessages.bounds);
  }
  if (!isPatternClean(value)) throw new Error(learningMessages.pattern);
  return value;
}

function signatureList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maxSignatureItems) throw new Error(learningMessages.bounds);
  return value.map(item => learningField(item, maxSignatureItemLength));
}

export interface SanitizedLearningRecord {
  title: string;
  file: string;
  evidenceRefs: string[];
  failureSignature: LearningFailureSignature;
}

/**
 * Strict assignment-free parse of the client-supplied record (mirrors the
 * entry minus server-stamped id/createdAt/lastValidatedAt/status). Evidence
 * existence is checked by the service against the scope's stored runs.
 * Evidence is required: a record with no triggering evidence is refused.
 */
export function sanitizeLearningRecord(raw: unknown): SanitizedLearningRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(learningMessages.bounds);
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some(key => !['title', 'file', 'evidenceRefs', 'failureSignature'].includes(key))) {
    throw new Error(learningMessages.bounds);
  }
  const title = learningField(record.title, maxLearningTitle);
  const file = learningField(record.file, maxLearningFile);
  if (file.includes('\\') || file.split('/').some(segment => segment === '..')) {
    throw new Error(learningMessages.pattern);
  }
  const refs = record.evidenceRefs;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > maxEvidenceRefs) {
    throw new Error(learningMessages.bounds);
  }
  const evidenceRefs: string[] = [];
  for (const entry of refs) {
    if (typeof entry !== 'string' || !evidenceIdPattern.test(entry)) throw new Error(learningMessages.bounds);
    if (!evidenceRefs.includes(entry)) evidenceRefs.push(entry);
  }
  const signature = record.failureSignature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new Error(learningMessages.bounds);
  }
  const signatureRecord = signature as Record<string, unknown>;
  if (Object.keys(signatureRecord).some(key => !['tests', 'errorClasses'].includes(key))) {
    throw new Error(learningMessages.bounds);
  }
  const tests = signatureList(signatureRecord.tests);
  const errorClasses = signatureList(signatureRecord.errorClasses);
  if (tests.length === 0 && errorClasses.length === 0) throw new Error(learningMessages.bounds);
  return { title, file, evidenceRefs, failureSignature: { tests, errorClasses } };
}

function isLearningEntry(raw: unknown): raw is LearningRuleEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.file !== 'string') return false;
  if (!Array.isArray(entry.evidenceRefs)) return false;
  const signature = entry.signature ?? entry.failureSignature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false;
  const sig = signature as Record<string, unknown>;
  if (!Array.isArray(sig.tests) || !Array.isArray(sig.errorClasses)) return false;
  if (typeof entry.createdAt !== 'string' || typeof entry.lastValidatedAt !== 'string') return false;
  return entry.status === 'active' || entry.status === 'suspect';
}

/**
 * Fail-closed read: a missing file reads as empty; a corrupt/invalid file
 * logs honestly and reads as empty — startup/injection never crashes.
 */
export async function readLearningIndex(homeDirectory: string): Promise<LearningRuleEntry[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath(homeDirectory), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Learning index unreadable, starting empty.');
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Learning index corrupt, starting empty.');
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every(isLearningEntry)) {
    console.error('Learning index has an unexpected shape, starting empty.');
    return [];
  }
  return parsed.map(entry => ({
    ...entry,
    failureSignature: (entry.failureSignature ?? (entry as { signature?: LearningFailureSignature }).signature)!,
  }));
}

async function writeLearningIndex(homeDirectory: string, entries: LearningRuleEntry[]): Promise<void> {
  await ensurePrivateDirectory(join(homeDirectory, 'learnings'));
  // Atomic tmp+rename with 0600 perms via the shared private writer; the
  // index is additive-only state (state.json untouched).
  await writePrivateJson(indexPath(homeDirectory), entries);
}

/**
 * Evict down to the cap. Oldest non-suspect entries go first; suspects evict
 * last so a flagged rule is never dropped while a healthy one survives.
 * Tiebreak: older createdAt first, then lexical id for determinism.
 */
export function evictLearningEntries(entries: LearningRuleEntry[]): LearningRuleEntry[] {
  if (entries.length <= maxLearningEntries) return entries;
  const ordered = [...entries].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drop = entries.length - maxLearningEntries;
  const victims = new Set<string>();
  for (const entry of ordered.filter(entry => entry.status !== 'suspect')) {
    if (victims.size >= drop) break;
    victims.add(entry.id);
  }
  for (const entry of ordered) {
    if (victims.size >= drop) break;
    victims.add(entry.id);
  }
  return entries.filter(entry => !victims.has(entry.id));
}

// Serializes index read-modify-write cycles (record + recompute) the way
// Store.update serializes state.json: callers pass an existence reader that
// runs inside the queue so a run-ring eviction while queued is refused rather
// than leaving a dangling reference.
let learningWriteQueue: Promise<unknown> = Promise.resolve();

function queuedLearningWrite<T>(work: () => Promise<T>): Promise<T> {
  const operation = learningWriteQueue.then(work);
  learningWriteQueue = operation.catch(() => undefined);
  return operation;
}

export async function appendLearningRule(
  homeDirectory: string,
  raw: unknown,
  readAccessibleRunIds: () => Promise<ReadonlySet<string>>,
): Promise<LearningRuleEntry> {
  const sanitized = sanitizeLearningRecord(raw);
  return queuedLearningWrite(async () => {
    const accessible = await readAccessibleRunIds();
    for (const ref of sanitized.evidenceRefs) {
      if (!accessible.has(ref)) throw new Error(learningMessages.evidence);
    }
    const now = new Date().toISOString();
    const entry: LearningRuleEntry = {
      id: randomUUID(),
      title: sanitized.title,
      file: sanitized.file,
      evidenceRefs: sanitized.evidenceRefs,
      failureSignature: sanitized.failureSignature,
      createdAt: now,
      lastValidatedAt: now,
      status: 'active',
    };
    const stored = evictLearningEntries([...await readLearningIndex(homeDirectory), entry]);
    await writeLearningIndex(homeDirectory, stored);
    return entry;
  });
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function signatureMatches(entry: LearningRuleEntry, runs: Array<Pick<RunListEntry, 'failingNames' | 'excerptPreview'>>): {
  testHit: boolean;
  errorHit: boolean;
} {
  let testHit = false;
  let errorHit = false;
  for (const run of runs) {
    const names = run.failingNames.map(normalized);
    const haystack = `${names.join('\n')}\n${normalized(run.excerptPreview)}`;
    for (const test of entry.failureSignature.tests) {
      const token = normalized(test);
      if (names.some(name => name.includes(token) || token.includes(name))) testHit = true;
    }
    for (const errorClass of entry.failureSignature.errorClasses) {
      const token = normalized(errorClass);
      if (token && haystack.includes(token)) errorHit = true;
    }
    if (testHit && errorHit) break;
  }
  return { testHit, errorHit };
}

export interface RecentFailureCorpus {
  /** Newest-first local runs in the bounded window (imports excluded). */
  runs: RunListEntry[];
  /** All runs in the window with parsed timestamps (for recurrence gating). */
  timed: Array<RunListEntry & { time: number }>;
}

/** Last-20 LOCAL runs across registered scopes; imports excluded via source filter. */
export async function collectRecentLocalRuns(homeDirectory: string): Promise<RecentFailureCorpus> {
  let registeredScopes: string[] = [];
  try {
    registeredScopes = (await new Store(homeDirectory).read()).workspaces.map(workspace => workspace.id);
  } catch {
    // Best-effort like the learning signal: absent/invalid state still scans discovered scopes.
  }
  const registeredIds = new Set(registeredScopes.map(scope => scope.toLowerCase()));
  let discoveredScopes: string[] = [];
  try {
    discoveredScopes = (await readdir(join(homeDirectory, 'runs'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && uuidPattern.test(entry.name))
      .map(entry => entry.name);
  } catch {
    discoveredScopes = [];
  }
  const scopes = [
    ...registeredScopes,
    ...discoveredScopes.filter(scope => !registeredIds.has(scope.toLowerCase())).sort(),
  ].slice(0, 50);
  const collected: RunListEntry[] = [];
  for (const scope of scopes) {
    const runs = await listRecentRuns(homeDirectory, scope, maxRecentRunsForLearningSignal);
    collected.push(...runs.filter(run => run.source === 'openworkspace-run'));
  }
  const timed = collected
    .map(run => ({ ...run, time: Date.parse(run.at) }))
    .filter(run => Number.isFinite(run.time))
    .sort((a, b) => b.time - a.time)
    .slice(0, maxRecentRunsForLearningSignal);
  return { runs: timed, timed };
}

/**
 * Proxy measurement, never claimed as proof: runs after the entry's creation
 * with the same failure signature count as recurrences within the last-20
 * window. Zero recurrences = holding; ≥1 = recurred.
 */
export function countRecurrences(entry: LearningRuleEntry, corpus: RecentFailureCorpus): number {
  const created = Date.parse(entry.createdAt);
  const after = corpus.timed.filter(run => Number.isFinite(created) && run.time > created);
  if (after.length === 0) return 0;
  const { testHit, errorHit } = signatureMatches(entry, after);
  return testHit || errorHit ? 1 : 0;
}

/**
 * Bounded recompute: flip active→suspect on first recurrence and persist in
 * the same queued write. Never auto-deletes; eviction handles space.
 */
export async function recomputeLearningSuspects(homeDirectory: string, corpus: RecentFailureCorpus): Promise<LearningRuleEntry[]> {
  const entries = await readLearningIndex(homeDirectory);
  if (entries.length === 0) return entries;
  let changed = false;
  const updated = entries.map(entry => {
    if (entry.status === 'active' && countRecurrences(entry, corpus) >= 1) {
      changed = true;
      return { ...entry, status: 'suspect' as const };
    }
    return entry;
  });
  if (changed) {
    await queuedLearningWrite(async () => {
      const current = await readLearningIndex(homeDirectory);
      const suspectIds = new Set(updated.filter(entry => entry.status === 'suspect').map(entry => entry.id));
      const merged = current.map(entry => suspectIds.has(entry.id) ? { ...entry, status: 'suspect' as const } : entry);
      await writeLearningIndex(homeDirectory, merged);
    });
    return updated;
  }
  return entries;
}

function renderLesson(entry: LearningRuleEntry): string {
  return `${entry.title} (${entry.file})${entry.status === 'suspect' ? ' [needs-review]' : ''}`;
}

/**
 * Injection line for the MCP instructions build. Matches recent failure
 * signatures against index titles + failureSignature (case-insensitive
 * substring; exact test-name hit > error-class hit > recency; top 3) and
 * truncates 3→2→1→0 titles until the line fits the remaining total budget.
 * Returns undefined when nothing matches, nothing fits, or no index exists.
 */
export async function learningLessonLine(homeDirectory: string, remainingBudgetBytes: number): Promise<string | undefined> {
  if (remainingBudgetBytes <= 0) return undefined;
  const corpus = await collectRecentLocalRuns(homeDirectory);
  const entries = await recomputeLearningSuspects(homeDirectory, corpus);
  if (entries.length === 0 || corpus.timed.length === 0) return undefined;
  const ranked = entries
    .map(entry => ({ entry, ...signatureMatches(entry, corpus.timed) }))
    .filter(candidate => candidate.testHit || candidate.errorHit)
    .sort((a, b) => {
      const scoreA = (a.testHit ? 2 : 0) + (a.errorHit ? 1 : 0);
      const scoreB = (b.testHit ? 2 : 0) + (b.errorHit ? 1 : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if (a.entry.createdAt !== b.entry.createdAt) return a.entry.createdAt < b.entry.createdAt ? 1 : -1;
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    })
    .slice(0, maxLessonTitlesPerLine)
    .map(candidate => candidate.entry);
  if (ranked.length === 0) return undefined;
  for (let count = ranked.length; count >= 1; count -= 1) {
    const line = `Relevant past lessons: ${ranked.slice(0, count).map(renderLesson).join('; ')}.`;
    if (Buffer.byteLength(line, 'utf8') <= remainingBudgetBytes) return line;
  }
  return undefined;
}
