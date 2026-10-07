/**
 * Dev-only observer read model: shell/tool activity recorded by the external
 * opencode shell-observer plugin, joined with OpenCode's local session
 * database. Read-only; never writes, never masks (dev-only loopback surface,
 * excerpts served raw as stored).
 *
 * Contracts mirror the `ow --json` envelopes (SessionInfo, TaskGroup /
 * GroupedLine, StuckReport, SessionMeta, ReadStat, TreeNode, DoctorLine) so
 * the CLI stays the reference implementation.
 *
 * Bounds (server-enforced): since defaults to 24h with a 1w max, sessions
 * capped at 50, tree sessions at 40, failures at 100, bounded sqlite LIMIT
 * queries only — never full scans (the database is ~880MB).
 */
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const observerMessages = {
  badSession: 'The observed session id is invalid.',
  noSessionMatch: 'No observed session matches that id. Use more of the full id.',
  ambiguousSession: 'Several observed sessions share that id prefix. Use more characters.',
  badSince: 'The since window is invalid. Use 30m, 3h, 1d or 1w.',
  sinceTooWide: 'The since window is too wide. The maximum window is 1w.',
  badKind: 'The record kind is invalid. Use shell, file-edit, tool-call or permission.',
  badLimit: 'The result limit is invalid.',
} as const;

export const defaultLogPath = () => process.env.OPENWORKSPACE_OBSERVER_LOG
  || join(homedir(), '.local', 'share', 'opencode-shell-log', 'shell-events.jsonl');
export const defaultDbPath = () => process.env.OPENWORKSPACE_OBSERVER_DB
  || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

const DAY_MS = 86_400_000;
export const defaultSinceMs = DAY_MS;
export const maxSinceMs = 7 * DAY_MS;
export const maxSessions = 50;
export const maxTreeSessions = 40;
export const maxFailures = 100;
export const maxRecordsPerSession = 5000;
/** Sidecar tail budget per read: the ring caps at 100MB/50k lines, so a full
 * read per request is unbounded. 8MB (~8k lines at ~1KB/line) covers the
 * default 24h window with headroom; older entries fall out with a warning. */
export const maxSidecarBytes = 8 * 1024 * 1024;
export const maxMessageRows = 2000;

export type SidecarRecord = Record<string, unknown> & { sessionID?: unknown; messageID?: unknown };
export type EnrichedRecord = SidecarRecord & {
  intent: string | null;
  taskRef: string | null;
  model: { id: string; provider: string } | null;
};

export interface SessionInfo {
  sessionID: string;
  title: string | null;
  commands: number;
  fileEdits: number;
  fails: number;
  first: string | null;
  last: string | null;
  workdir: string | null;
  childCount: number;
}

export interface GroupedLine {
  ref: number;
  signature: string;
  outcome: string;
  runs: number;
  agents: string[];
  sessions: string[];
  models: string[];
  failReason: string | null;
  variants: string[];
  excerpts: string[];
  results: string[];
  intents: string[];
  messageIDs: string[];
}

export interface TaskGroup {
  taskRef: string;
  /** Source of the header text: a user instruction, a synthetic subagent
   * briefing, or none when the group has no message context. Derived by
   * prefix match in groupByTask so headers stay attributable. */
  taskRefKind: 'user' | 'briefing' | 'none';
  /** First agent seen in the group; the briefing target when taskRefKind is
   * 'briefing'. Null when no record names an agent. */
  taskRefAgent: string | null;
  runs: number;
  fails: number;
  lines: GroupedLine[];
}

export interface StuckReport {
  retries: { signature: string; runs: number; fails: number }[];
  rereads: { path: string; agent: string; reads: number; depth: number }[];
  slow: { ms: number; command: string }[];
  interruptions: number;
  compactions: number;
  afterInterrupt: string[];
}

export interface SessionMeta {
  sessionID: string;
  title: string | null;
  directory: string | null;
  cost: number | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  userTurns: number;
  assistantTurns: number;
  compactions: number;
  lastWord: string | null;
  models: string[];
}

export interface ReadStat {
  path: string;
  reads: number;
  agents: string[];
  ranges: string[];
}

export type SpawnLink = {
  childSessionID: string;
  agent: string | null;
  description: string | null;
  time: number;
};

export type TreeNode = {
  sessionID: string;
  link: SpawnLink | null;
  children: TreeNode[];
  /** False for spawn-linked children; for link-less children true only when
   * no DB parent_id edge explains the membership (a genuine orphan). */
  orphan: boolean;
};

/** Per-node display metadata for the task tree (bounded, best-effort). */
export type TreeNodeDetail = {
  /** displayTitle chain (stored title → first prompt → workdir → short id). */
  title: string;
  /** Source of the title text: a user instruction, a synthetic subagent
   * briefing, or other when the title is a stored title, workdir or id
   * (not a message, so no attribution label applies). */
  titleKind: 'user' | 'briefing' | 'other';
  /** Spawn-link agent, else the first agent seen in this window's records. */
  agent: string | null;
  /** Records for this session in the current (filtered) window. */
  records: number;
  /** True when session_message holds rows for this session even though the
   * window shows zero sidecar records (pre-recording-era work). */
  hasMessages: boolean;
};

export interface DoctorLine {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MistakeRow {
  sessionID: string;
  at: string | null;
  taskRef: string | null;
  /** Source of taskRef, derived the same way as TaskGroup.taskRefKind. */
  taskRefKind: 'user' | 'briefing' | 'none';
  signature: string;
  outcome: string;
  failReason: string | null;
  excerpt: string | null;
  agent: string | null;
}

export interface CostRow {
  sessionID: string;
  title: string | null;
  directory: string | null;
  cost: number | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  userTurns: number;
  assistantTurns: number;
  compactions: number;
  last: string | null;
}

type Dict = Record<string, unknown>;

const sessionIdPattern = /^ses_[A-Za-z0-9]{5,}$/;
export const validKinds = new Set(['shell', 'file-edit', 'tool-call', 'permission']);

export function parseSessionId(value: string): string {
  const trimmed = value.trim();
  if (!sessionIdPattern.test(trimmed)) throw new Error(observerMessages.badSession);
  return trimmed;
}

/**
 * Resolve a session filter to a full id against the ids known to the
 * sidecar. Exact ids and displayed short ids (prefixes) resolve; ambiguous
 * prefixes and dead ends throw (never silent empty). Note the displayed
 * short id itself matches the full-id pattern, so the known list — not the
 * pattern — decides.
 */
export function resolveSessionPrefix(input: string, knownIDs: string[]): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error(observerMessages.badSession);
  const unique = [...new Set(knownIDs)];
  if (unique.includes(trimmed)) return trimmed;
  const matches = unique.filter(id => id.startsWith(trimmed));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(observerMessages.ambiguousSession);
  throw new Error(observerMessages.noSessionMatch);
}

/** Distinct session ids seen in the sidecar tail (bounded read). */
export async function knownSessionIDs(logPath?: string): Promise<string[]> {
  const path = logPath ?? defaultLogPath();
  let lines: string[];
  try {
    lines = (await readSidecarLines(path)).lines;
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const line of lines) {
    const record = parseLine(line);
    if (record && typeof record.sessionID === 'string') ids.add(record.sessionID);
  }
  return [...ids];
}

/** Parse --since style windows like 30m, 3h, 2d, 1w into milliseconds. */
export function parseSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)\s*([mhdw])$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase() === 'm' ? 60_000
    : match[2].toLowerCase() === 'h' ? 3_600_000
    : match[2].toLowerCase() === 'd' ? DAY_MS : 7 * DAY_MS;
  return n * unit;
}

/** Resolve the since query value: default 24h, reject invalid and >1w. */
export function resolveSince(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return defaultSinceMs;
  const parsed = parseSince(value);
  if (parsed === null) throw new Error(observerMessages.badSince);
  if (parsed > maxSinceMs) throw new Error(observerMessages.sinceTooWide);
  return parsed;
}

function asDict(value: unknown): Dict | undefined {
  return typeof value === 'object' && value !== null ? (value as Dict) : undefined;
}

function timeOf(record: SidecarRecord): number {
  const parsed = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentOf(record: SidecarRecord): string | null {
  return typeof record.agent === 'string' && record.agent.length > 0 ? record.agent : null;
}

/** Bounded tail read of the JSONL ring: only the newest maxSidecarBytes are
 * ever read (stat size, then one positioned read), so a 100MB ring never
 * crosses the whole file through memory per request. Newest bytes win and
 * the partial head line cut by the byte window is dropped. */
export async function readSidecarLines(logPath: string): Promise<{ lines: string[]; truncated: boolean }> {
  let handle;
  try {
    handle = await open(logPath, 'r');
  } catch (error: unknown) {
    throw new Error(`sidecar unreadable: ${String(error).slice(0, 160)}`);
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxSidecarBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    if (start === 0) {
      return { lines: text.split('\n').filter(line => line.trim().length > 0), truncated: false };
    }
    const lines = text.split('\n');
    // First line is a partial record cut by the byte window — drop it.
    lines.shift();
    return { lines: lines.filter(line => line.trim().length > 0), truncated: true };
  } finally {
    await handle.close();
  }
}

function parseLine(line: string): Dict | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asDict(parsed) ?? null;
  } catch {
    return null;
  }
}

/** Best-effort session titles for a bounded id list (one IN query, never throws). */
export async function sessionTitles(options: {
  dbPath?: string;
  sessionIDs: string[];
}): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (options.sessionIDs.length === 0) return titles;
  const db = await openDb(options.dbPath ?? defaultDbPath(), []);
  if (!db) return titles;
  try {
    const placeholders = options.sessionIDs.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, title FROM session_v2 WHERE id IN (${placeholders}) LIMIT ${maxSessions}`).all(...options.sessionIDs) as { id: unknown; title: unknown }[];
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.title === 'string' && row.title.length > 0) {
        titles.set(row.id, row.title);
      }
    }
  } catch {
    // titles are best-effort; rows render without them
  } finally {
    db.close();
  }
  return titles;
}

/** First user prompt per session for a bounded id list (one batched GROUP BY
 * query, never throws). SQLite bare-column rule returns the data of the
 * MIN(seq) row per group — the session's opening instruction. */
export async function sessionFirstPrompts(options: {
  dbPath?: string;
  sessionIDs: string[];
}): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  if (options.sessionIDs.length === 0) return prompts;
  const db = await openDb(options.dbPath ?? defaultDbPath(), []);
  if (!db) return prompts;
  try {
    const placeholders = options.sessionIDs.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, data, MIN(seq) AS m FROM session_message WHERE session_id IN (${placeholders}) AND type = 'user' GROUP BY session_id`,
    ).all(...options.sessionIDs) as { session_id: unknown; data: unknown }[];
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || typeof row.data !== 'string') continue;
      try {
        const data = asDict(JSON.parse(row.data) as unknown);
        const text = data && typeof data.text === 'string' ? clip(data.text, 80) : null;
        if (text) prompts.set(row.session_id, text);
      } catch {
        continue;
      }
    }
  } catch {
    // prompts are best-effort; rows render without them
  } finally {
    db.close();
  }
  return prompts;
}

/** Direct-child counts via parent_id for a bounded id list (one batched
 * GROUP BY query, never throws). */
export async function sessionChildCounts(options: {
  dbPath?: string;
  sessionIDs: string[];
}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (options.sessionIDs.length === 0) return counts;
  const db = await openDb(options.dbPath ?? defaultDbPath(), []);
  if (!db) return counts;
  try {
    const placeholders = options.sessionIDs.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT parent_id, COUNT(*) AS n FROM session_v2 WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
    ).all(...options.sessionIDs) as { parent_id: unknown; n: unknown }[];
    for (const row of rows) {
      if (typeof row.parent_id === 'string' && typeof row.n === 'number') {
        counts.set(row.parent_id, row.n);
      }
    }
  } catch {
    // counts are best-effort; rows render without them
  } finally {
    db.close();
  }
  return counts;
}

/** Message-row presence per session for a bounded id list (one batched
 * COUNT GROUP BY query, never throws). Distinguishes pre-recording-era
 * children (zero sidecar records but real session_message rows) from truly
 * empty sessions. */
export async function sessionMessageCounts(options: {
  dbPath?: string;
  sessionIDs: string[];
}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (options.sessionIDs.length === 0) return counts;
  const db = await openDb(options.dbPath ?? defaultDbPath(), []);
  if (!db) return counts;
  try {
    const placeholders = options.sessionIDs.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, COUNT(*) AS n FROM session_message WHERE session_id IN (${placeholders}) GROUP BY session_id`,
    ).all(...options.sessionIDs) as { session_id: unknown; n: unknown }[];
    for (const row of rows) {
      if (typeof row.session_id === 'string' && typeof row.n === 'number') {
        counts.set(row.session_id, row.n);
      }
    }
  } catch {
    // counts are best-effort; nodes render without them
  } finally {
    db.close();
  }
  return counts;
}

/** Last segment of a workdir path for display (`/a/b/` → `b`). */
export function workdirBasename(workdir: string | null): string | null {
  if (!workdir) return null;
  const base = workdir.split('/').filter(part => part.length > 0).pop() ?? null;
  return base && base.length > 0 ? base : null;
}

/**
 * Human-readable session title fallback chain: stored title → first user
 * prompt (clipped 80 chars, single line) → workdir basename → short id.
 * The short id is the last resort so a row always shows something stable.
 */
export function displayTitle(options: {
  sessionID: string;
  title: string | null;
  prompt: string | null;
  workdir: string | null;
}): string {
  if (options.title && options.title.trim().length > 0) return options.title;
  const prompt = options.prompt ? clip(options.prompt, 80) : null;
  if (prompt) return prompt;
  const base = workdirBasename(options.workdir);
  if (base) return base;
  return options.sessionID.length > 13 ? options.sessionID.slice(0, 13) : options.sessionID;
}
/** Session inventory from the sidecar: id, command/file-edit counts, time span, workdir. */
export async function listSessions(options: {
  logPath?: string;
  dbPath?: string;
  sinceMs?: number | null;
  dir?: string;
  kind?: string;
  now?: number;
}): Promise<{ sessions: SessionInfo[]; warnings: string[] }> {
  const warnings: string[] = [];
  const logPath = options.logPath ?? defaultLogPath();
  let lines: string[];
  let truncated = false;
  try {
    const read = await readSidecarLines(logPath);
    lines = read.lines;
    truncated = read.truncated;
  } catch {
    return { sessions: [], warnings: ['observer not enabled on this machine'] };
  }
  if (truncated) warnings.push('sidecar window truncated to the newest 8MB; older sessions may be missing');
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? defaultSinceMs;
  const cutoff = now - sinceMs;
  const by = new Map<string, { commands: number; fileEdits: number; fails: number; first: string | null; last: string | null; workdir: string | null; kinds: Set<string> }>();
  for (const line of lines) {
    const record = parseLine(line);
    if (!record || typeof record.sessionID !== 'string') continue;
    const ts = typeof record.timestamp === 'string' ? record.timestamp : null;
    const ms = ts ? Date.parse(ts) : NaN;
    if (!ts || !Number.isFinite(ms) || ms < cutoff) continue;
    // Directory filter is a substring match (mirrors the dashboard label).
    if (options.dir && typeof record.workdir === 'string' && !record.workdir.includes(options.dir)) continue;
    const kind = typeof record.kind === 'string' ? record.kind : (typeof record.command === 'string' ? 'shell' : 'unknown');
    const entry = by.get(record.sessionID)
      ?? { commands: 0, fileEdits: 0, fails: 0, first: null, last: null, workdir: null, kinds: new Set<string>() };
    if (record.kind === 'file-edit') entry.fileEdits += 1;
    else entry.commands += 1;
    entry.kinds.add(kind);
    if (record.outcome === 'failure' || record.outcome === 'error') entry.fails += 1;
    if (!entry.first || ts < entry.first) entry.first = ts;
    if (!entry.last || ts > entry.last) entry.last = ts;
    if (!entry.workdir && typeof record.workdir === 'string') entry.workdir = record.workdir;
    by.set(record.sessionID, entry);
  }
  let sessions = [...by.entries()].map(([sessionID, info]) => ({
    sessionID,
    commands: info.commands,
    fileEdits: info.fileEdits,
    fails: info.fails,
    first: info.first,
    last: info.last,
    workdir: info.workdir,
    kinds: info.kinds,
  }));
  if (options.kind) {
    if (!validKinds.has(options.kind)) throw new Error(observerMessages.badKind);
    sessions = sessions.filter(entry => entry.kinds.has(options.kind as string));
  }
  sessions.sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  const cappedIDs = sessions.slice(0, maxSessions).map(entry => entry.sessionID);
  const titles = await sessionTitles({ dbPath: options.dbPath, sessionIDs: cappedIDs });
  // Two more batched enrichment queries (titles above is the third): first
  // user prompts for the title fallback chain, direct-child counts for the
  // row badge. All best-effort; rows render without them.
  const prompts = await sessionFirstPrompts({ dbPath: options.dbPath, sessionIDs: cappedIDs });
  const children = await sessionChildCounts({ dbPath: options.dbPath, sessionIDs: cappedIDs });
  const capped: SessionInfo[] = sessions.slice(0, maxSessions).map(entry => ({
    sessionID: entry.sessionID,
    title: displayTitle({
      sessionID: entry.sessionID,
      title: titles.get(entry.sessionID) ?? null,
      prompt: prompts.get(entry.sessionID) ?? null,
      workdir: entry.workdir,
    }),
    commands: entry.commands,
    fileEdits: entry.fileEdits,
    fails: entry.fails,
    first: entry.first,
    last: entry.last,
    workdir: entry.workdir,
    childCount: children.get(entry.sessionID) ?? 0,
  }));
  if (sessions.length > maxSessions) warnings.push(`session list capped at ${maxSessions}; narrow the window`);
  return { sessions: capped, warnings };
}

/** All sidecar records for one session, oldest first, newest-capped. */
export async function sessionRecords(options: {
  logPath?: string;
  sessionID: string;
}): Promise<{ records: SidecarRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  const logPath = options.logPath ?? defaultLogPath();
  let lines: string[];
  try {
    const read = await readSidecarLines(logPath);
    lines = read.lines;
    if (read.truncated) warnings.push('sidecar window truncated to the newest 8MB; older records may be missing');
  } catch {
    return { records: [], warnings: ['observer not enabled on this machine'] };
  }
  const records: SidecarRecord[] = [];
  for (const line of lines) {
    const record = parseLine(line);
    if (record && record.sessionID === options.sessionID) records.push(record);
  }
  records.sort((a, b) => timeOf(a) - timeOf(b));
  if (records.length > maxRecordsPerSession) {
    warnings.push(`records capped at the newest ${maxRecordsPerSession}`);
    return { records: records.slice(records.length - maxRecordsPerSession), warnings };
  }
  return { records, warnings };
}

// ---------------------------------------------------------------------------
// sqlite access (node:sqlite; degrades when the floor lacks it or DB is unreadable)
// ---------------------------------------------------------------------------

type MessageRow = { id: string; type: string; data: Dict };
type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null | undefined;
async function loadSqlite(): Promise<SqliteModule | null> {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

type Db = { prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] }; close: () => void };

async function openDb(dbPath: string, warnings: string[]): Promise<Db | null> {
  const sqlite = await loadSqlite();
  if (!sqlite) {
    warnings.push('session database unavailable on this runtime; showing shell records only');
    return null;
  }
  try {
    return new sqlite.DatabaseSync(dbPath, { readOnly: true }) as unknown as Db;
  } catch (error) {
    warnings.push(`opencode.db unreadable: ${String(error).slice(0, 120)}`);
    return null;
  }
}

/** Synthetic subagent briefings arrive as user rows with this prefix (the
 * runtime injects them when spawning a child session). Prefix match keeps
 * long briefing headers attributable in every Observe view. */
export const subagentBriefingPrefix = 'You are a subagent spawned';

export type MessageKind = 'user' | 'briefing' | 'none';

/**
 * Source of a message header text: 'none' for missing/empty text and the
 * '(no task)' group key (not a message), 'briefing' for synthetic subagent
 * briefings, 'user' for everything else (direct user instructions).
 */
export function classifyMessage(text: string | null): MessageKind {
  if (!text || text.trim().length === 0 || text === '(no task)') return 'none';
  return text.trimStart().toLowerCase().startsWith(subagentBriefingPrefix.toLowerCase())
    ? 'briefing'
    : 'user';
}

/** A user instruction with its source, for the prompts feed. */
export interface SessionPrompt {
  text: string;
  kind: 'user' | 'briefing';
}

const clip = (value: unknown, limit = 500): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > limit ? single.slice(0, limit) : single;
};

const textParts = (data: Dict): string[] => {
  const content = data.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const text = asDict(part)?.text;
    const clipped = clip(text);
    if (clipped) out.push(clipped);
  }
  return out;
};

/** Nearest preceding user-row text (the task the command serves). */
function precedingUserText(rows: { type: string; data: Dict }[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i].type !== 'user') continue;
    const direct = clip(rows[i].data.text);
    if (direct) return direct;
    return textParts(rows[i].data)[0] ?? null;
  }
  return null;
}

function modelOf(data: Dict): { id: string; provider: string } | null {
  const model = asDict(data.model);
  if (model && typeof model.id === 'string') {
    return { id: model.id, provider: typeof model.providerID === 'string' ? model.providerID : '?' };
  }
  return null;
}

export function attachIntent(sidecar: SidecarRecord, rows: MessageRow[]): EnrichedRecord {
  const messageID = typeof sidecar.messageID === 'string' ? sidecar.messageID : null;
  if (!messageID) return { ...sidecar, intent: null, taskRef: null, model: null };
  const index = rows.findIndex(row => row.id === messageID);
  if (index < 0) return { ...sidecar, intent: null, taskRef: null, model: null };
  const sameRow = textParts(rows[index].data)[0] ?? null;
  const taskRef = precedingUserText(rows, index);
  return { ...sidecar, intent: sameRow ?? taskRef, taskRef, model: modelOf(rows[index].data) };
}

export function loadSessionMessages(db: Db, sessionID: string): MessageRow[] | null {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'").all() as { name: unknown }[];
    if (tables.length === 0) return null;
    const raw = db.prepare('SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?').all(sessionID, maxMessageRows) as { id: unknown; type: unknown; data: unknown }[];
    return raw.flatMap(row => {
      if (typeof row.id !== 'string' || typeof row.type !== 'string' || typeof row.data !== 'string') return [];
      try {
        const dict = asDict(JSON.parse(row.data) as unknown);
        if (!dict) return [];
        return [{ id: row.id, type: row.type, data: dict }];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

export async function joinSession(options: {
  dbPath?: string;
  logPath?: string;
  sessionID: string;
}): Promise<{ records: EnrichedRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { records, warnings: recordWarnings } = await sessionRecords({ logPath: options.logPath, sessionID: options.sessionID });
  warnings.push(...recordWarnings);
  if (records.length === 0 && recordWarnings.includes('observer not enabled on this machine')) {
    return { records: [], warnings };
  }
  const db = await openDb(options.dbPath ?? defaultDbPath(), warnings);
  if (!db) {
    warnings.push('message table unavailable — records emitted without intent');
    return { records: records.map(record => ({ ...record, intent: null, taskRef: null, model: null })), warnings };
  }
  try {
    const rows = loadSessionMessages(db, options.sessionID);
    if (!rows) {
      warnings.push('message table unavailable — records emitted without intent');
      return { records: records.map(record => ({ ...record, intent: null, taskRef: null, model: null })), warnings };
    }
    return { records: records.map(record => attachIntent(record, rows)), warnings };
  } finally {
    db.close();
  }
}

/** Child sessions via parent_id (subagent work), bounded. */
export async function childSessions(options: { dbPath?: string; sessionID: string }): Promise<string[]> {
  const warnings: string[] = [];
  const db = await openDb(options.dbPath ?? defaultDbPath(), warnings);
  if (!db) return [];
  try {
    const found: string[] = [];
    let frontier = [options.sessionID];
    for (let depth = 0; depth < 5 && frontier.length > 0 && found.length < 20; depth += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id FROM session_v2 WHERE parent_id IN (${placeholders}) LIMIT 20`).all(...frontier) as { id: unknown }[];
      frontier = [];
      for (const row of rows) {
        if (typeof row.id === 'string' && row.id !== options.sessionID && !found.includes(row.id)) {
          found.push(row.id);
          frontier.push(row.id);
        }
      }
    }
    return found;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Load every session in a task tree: the parent, childSessions() (DB
 * parent_id walk, capped) union spawn-linked IDs parsed from fetched records,
 * with one expansion round for grandchild links. Still bounded.
 */
export async function loadTreeRecords(options: {
  dbPath?: string;
  logPath?: string;
  sessionID: string;
  maxSessions?: number;
}): Promise<{ by: Map<string, EnrichedRecord[]>; warnings: string[]; childCount: number; parentLinked: string[] }> {
  const max = options.maxSessions ?? maxTreeSessions;
  const by = new Map<string, EnrichedRecord[]>();
  const warnings: string[] = [];  const seenWarnings = new Set<string>();
  const pushWarnings = (list: string[]) => {
    for (const warning of list) {
      if (!seenWarnings.has(warning)) {
        seenWarnings.add(warning);
        warnings.push(warning);
      }
    }
  };
  const fetch = async (id: string): Promise<void> => {
    if (by.has(id)) return;
    const joined = await joinSession({ sessionID: id, dbPath: options.dbPath, logPath: options.logPath });
    by.set(id, joined.records);
    pushWarnings(joined.warnings);
  };
  await fetch(options.sessionID);
  const dbChildren = await childSessions({ dbPath: options.dbPath, sessionID: options.sessionID });
  const linked = (records: EnrichedRecord[]): string[] =>
    parseSpawnLinks(records).map(link => link.childSessionID).filter(id => id !== options.sessionID);
  const firstRound = [...dbChildren, ...linked(by.get(options.sessionID) ?? [])];
  for (const id of firstRound.slice(0, max - 1)) await fetch(id);
  const extra: string[] = [];
  for (const recs of by.values()) {
    for (const id of linked(recs)) {
      if (!by.has(id) && !extra.includes(id)) extra.push(id);
    }
  }
  for (const id of extra.slice(0, Math.max(0, max - by.size))) await fetch(id);
  if (by.size >= max) warnings.push(`tree capped at ${max} sessions`);
  return { by, warnings, childCount: by.size - 1, parentLinked: dbChildren };
}

/** Spawn links live in parent-session tool-call rows: tool=subagent with args JSON of {agent, sessionID, description}. */
export function parseSpawnLinks(records: EnrichedRecord[]): SpawnLink[] {
  const out: SpawnLink[] = [];
  const strField = (text: string, name: string): string | null => {
    const match = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]{1,200})`));
    return match ? match[1] : null;
  };
  for (const record of records) {
    if (record.kind !== 'tool-call' || record.tool !== 'subagent') continue;
    if (typeof record.args !== 'string') continue;
    let childSessionID: string | null = null;
    let agent: string | null = null;
    let description: string | null = null;
    try {
      const dict = asDict(JSON.parse(record.args) as unknown);
      if (dict && typeof dict.sessionID === 'string') {
        childSessionID = dict.sessionID;
        agent = typeof dict.agent === 'string' ? dict.agent : null;
        description = typeof dict.description === 'string' ? dict.description : null;
      }
    } catch {
      // clipped args: recover fields by regex below
    }
    if (!childSessionID) {
      childSessionID = strField(record.args, 'sessionID');
      agent = strField(record.args, 'agent');
      description = strField(record.args, 'description');
    }
    if (!childSessionID || !sessionIdPattern.test(childSessionID)) continue;
    out.push({ childSessionID, agent, description, time: timeOf(record) });
  }
  return out.sort((a, b) => a.time - b.time);
}

const earliest = (records: EnrichedRecord[] | undefined): number => {
  if (!records || records.length === 0) return Number.MAX_SAFE_INTEGER;
  let best = Number.MAX_SAFE_INTEGER;
  for (const record of records) {
    const t = timeOf(record);
    if (t < best) best = t;
  }
  return best;
};

/**
 * Build the task tree for a parent session. Children attach via spawn links
 * parsed from each node's own records; descendants with no spawn link
 * anywhere are still shown as children of the root. viaParent carries the DB
 * parent_id walk (loadTreeRecords parentLinked): link-less children in that
 * set belong to the tree but have no spawn note, while link-less children
 * outside it are genuine orphans.
 */
export function buildTree(parentID: string, recordsBy: Map<string, EnrichedRecord[]>, viaParent?: Set<string>): TreeNode {
  const known = new Set(recordsBy.keys());
  known.add(parentID);
  const visited = new Set<string>([parentID]);
  const childrenOf = (id: string): TreeNode[] => {
    const out: TreeNode[] = [];
    const seen = new Set<string>();
    for (const link of parseSpawnLinks(recordsBy.get(id) ?? [])) {
      if (!known.has(link.childSessionID)) continue;
      if (visited.has(link.childSessionID) || seen.has(link.childSessionID)) continue;
      seen.add(link.childSessionID);
      visited.add(link.childSessionID);
      out.push({ sessionID: link.childSessionID, link, children: childrenOf(link.childSessionID), orphan: false });
    }
    return out;
  };
  const root: TreeNode = { sessionID: parentID, link: null, children: childrenOf(parentID), orphan: false };
  const orphans = [...known].filter(id => !visited.has(id));
  orphans.sort((a, b) => earliest(recordsBy.get(a)) - earliest(recordsBy.get(b)));
  for (const id of orphans) {
    visited.add(id);
    root.children.push({ sessionID: id, link: null, children: childrenOf(id), orphan: !(viaParent?.has(id) ?? false) });
  }
  return root;
}

/**
 * Per-node display metadata for a built tree: title via the displayTitle
 * chain (same as the session list), agent tag, window record count, and
 * message presence (zero-record children with session_message rows predate
 * sidecar recording). Three batched best-effort DB queries (titles + first
 * prompts + message counts, the same paths listSessions uses); workdir/
 * agent/count come from the already-loaded records, so no per-node queries.
 * Nodes missing from the map (untestable degradation) fall back to the
 * short id with zero records.
 */
export async function treeDetails(options: {
  dbPath?: string;
  node: TreeNode;
  recordsBy: Map<string, EnrichedRecord[]>;
}): Promise<Map<string, TreeNodeDetail>> {
  const ids: string[] = [];
  const walk = (node: TreeNode): void => {
    ids.push(node.sessionID);
    for (const child of node.children) walk(child);
  };
  walk(options.node);
  const [titles, prompts, messageCounts] = await Promise.all([
    sessionTitles({ dbPath: options.dbPath, sessionIDs: ids }),
    sessionFirstPrompts({ dbPath: options.dbPath, sessionIDs: ids }),
    sessionMessageCounts({ dbPath: options.dbPath, sessionIDs: ids }),
  ]);
  const details = new Map<string, TreeNodeDetail>();
  const idOf = (node: TreeNode): TreeNodeDetail => {
    const records = options.recordsBy.get(node.sessionID) ?? [];
    let workdir: string | null = null;
    let agent: string | null = node.link?.agent ?? null;
    for (const record of records) {
      if (!workdir && typeof record.workdir === 'string') workdir = record.workdir;
      if (!agent && typeof record.agent === 'string' && record.agent.length > 0) agent = record.agent;
      if (workdir && agent) break;
    }
    const storedTitle = titles.get(node.sessionID) ?? null;
    const prompt = prompts.get(node.sessionID) ?? null;
    // Only a prompt-fallback title is message text; stored titles, workdir
    // basenames and short ids are not attributable to a speaker.
    const titleFromPrompt = (!storedTitle || storedTitle.trim().length === 0) && !!prompt;
    return {
      title: displayTitle({
        sessionID: node.sessionID,
        title: storedTitle,
        prompt,
        workdir,
      }),
      titleKind: !titleFromPrompt || !prompt
        ? 'other'
        : classifyMessage(prompt) === 'briefing' ? 'briefing' : 'user',
      agent,
      records: records.length,
      hasMessages: (messageCounts.get(node.sessionID) ?? 0) > 0,
    };
  };
  const fill = (node: TreeNode): void => {
    details.set(node.sessionID, idOf(node));
    for (const child of node.children) fill(child);
  };
  fill(options.node);
  return details;
}

/** ID-only view of the tree for JSON output (stable English keys). */
export interface TreeIds {
  sessionID: string;
  link: SpawnLink | null;
  children: TreeIds[];
  detail: TreeNodeDetail & { orphan: boolean };
}
export function treeIds(node: TreeNode, details?: Map<string, TreeNodeDetail>): TreeIds {
  const fallback: TreeNodeDetail = { title: node.sessionID.slice(0, 13), titleKind: 'other', agent: node.link?.agent ?? null, records: 0, hasMessages: false };
  const detail = details?.get(node.sessionID) ?? fallback;
  return {
    sessionID: node.sessionID,
    link: node.link,
    children: node.children.map(child => treeIds(child, details)),
    detail: { ...detail, orphan: node.orphan },
  };
}

// ---------------------------------------------------------------------------
// grouping / outcomes
// ---------------------------------------------------------------------------

const outcomeOf = (record: EnrichedRecord): string => {
  if (record.kind === 'permission') return typeof record.effect === 'string' ? record.effect : 'unknown';
  return typeof record.outcome === 'string' ? record.outcome : 'unknown';
};

const rawCommandOf = (record: EnrichedRecord): string | null => {
  if (typeof record.command === 'string') return record.command;
  return null;
};

/** First machine-readable failure reason in a script body: raise X('reason'). */
export function failReason(command: string): string | null {
  const scan = command.length > 20_000 ? command.slice(0, 20_000) : command;
  const match = scan.match(/raise\s+(?:SystemExit|RuntimeError|AssertionError|ValueError)\(\s*['"]([^'"\n)]{1,80})/);
  return match ? match[1] : null;
}

const TEST_RUNNER_HINTS = ['pytest', 'tsx --test', 'pnpm test', 'npm test', 'go test', 'cargo test', 'jest', 'vitest', 'mocha', 'tsc ', 'typecheck'];

/** Test-runner signatures get a verdict line (their last output line). */
export function verdictLine(signatureText: string, excerpt: string | null): string | null {
  if (!excerpt) return null;
  if (!TEST_RUNNER_HINTS.some(hint => signatureText.includes(hint))) return null;
  const lines = excerpt.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  return last.length > 120 ? last.slice(0, 120) : last;
}

export function filterSince(records: EnrichedRecord[], windowMs: number | null, now = Date.now()): EnrichedRecord[] {
  if (!windowMs) return [...records].sort((a, b) => timeOf(a) - timeOf(b));
  const cutoff = now - windowMs;
  return records.filter(record => timeOf(record) >= cutoff).sort((a, b) => timeOf(a) - timeOf(b));
}

/** kind: shell (no kind field or command present), file-edit, tool-call, permission. tool: case-insensitive substring. */
export function filterTools(records: EnrichedRecord[], kind?: string, toolSub?: string): EnrichedRecord[] {
  const sub = toolSub?.toLowerCase();
  return records.filter(record => {
    const k = typeof record.kind === 'string' ? record.kind : (typeof record.command === 'string' ? 'shell' : 'unknown');
    if (kind && k !== kind) return false;
    if (sub) {
      const tool = typeof record.tool === 'string' ? record.tool.toLowerCase() : '';
      const cmd = typeof record.command === 'string' ? record.command.toLowerCase() : '';
      if (!tool.includes(sub) && !cmd.includes(sub)) return false;
    }
    return true;
  });
}

const MAX_STORED_VARIANTS = 50;

export function groupByTask(records: EnrichedRecord[]): TaskGroup[] {
  const groups = new Map<string, EnrichedRecord[]>();
  for (const record of records) {
    const key = typeof record.taskRef === 'string' && record.taskRef.length > 0 ? record.taskRef : '(no task)';
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([taskRef, list]) => {
    const seen = new Map<string, GroupedLine>();
    const lines: GroupedLine[] = [];
    let groupAgent: string | null = null;
    for (const record of list) {
      const permCmd = record.kind === 'permission' && typeof record.action === 'string' ? `permit ${record.action}` : null;
      const toolCallCmd = record.kind === 'tool-call' && typeof record.tool === 'string'
        ? `${record.tool}${typeof record.args === 'string' && record.args.length > 0 ? ` ${record.args}` : ''}`
        : null;
      const fileEditCmd = record.kind === 'file-edit' && typeof record.path === 'string' ? `edit ${record.path}` : null;
      const raw = permCmd ?? toolCallCmd ?? fileEditCmd ?? rawCommandOf(record);
      const full = raw ? raw.replace(/\s+/g, ' ').trim() : 'unknown';
      const sig = signature(raw ?? full);
      const outcome = outcomeOf(record);
      const dupKey = `${sig}\n${outcome}`;
      const existing = seen.get(dupKey);
      const intent = typeof record.intent === 'string' && record.intent.length > 0 ? record.intent : null;
      const messageID = typeof record.messageID === 'string' ? record.messageID : null;
      const agent = agentOf(record);
      if (!groupAgent && agent) groupAgent = agent;
      const sess = typeof record.sessionID === 'string' ? record.sessionID.slice(0, 13) : null;
      const model = record.model && typeof record.model.id === 'string' ? record.model.id : null;
      const excerpt = typeof record.excerpt === 'string' && record.excerpt.length > 0 ? record.excerpt : null;
      const result = typeof record.result === 'string' && record.result.length > 0 ? record.result : null;
      if (existing) {
        existing.runs += 1;
        if (agent && !existing.agents.includes(agent) && existing.agents.length < 3) existing.agents.push(agent);
        if (sess && !existing.sessions.includes(sess) && existing.sessions.length < 5) existing.sessions.push(sess);
        if (model && !existing.models.includes(model) && existing.models.length < 3) existing.models.push(model);
        if (!existing.variants.includes(full) && existing.variants.length < MAX_STORED_VARIANTS) existing.variants.push(full);
        if (excerpt && !existing.excerpts.includes(excerpt) && existing.excerpts.length < 2) existing.excerpts.push(excerpt);
        if (result && !existing.results.includes(result) && existing.results.length < 2) existing.results.push(result);
        if (intent && !existing.intents.includes(intent) && existing.intents.length < 2) existing.intents.push(intent);
        if (messageID && !existing.messageIDs.includes(messageID) && existing.messageIDs.length < 5) existing.messageIDs.push(messageID);
        continue;
      }
      const line: GroupedLine = {
        ref: lines.length + 1,
        signature: sig,
        outcome,
        runs: 1,
        agents: agent ? [agent] : [],
        sessions: sess ? [sess] : [],
        models: model ? [model] : [],
        failReason: typeof record.command === 'string' ? failReason(record.command) : null,
        variants: [full],
        excerpts: excerpt ? [excerpt] : [],
        results: result ? [result] : [],
        intents: intent ? [intent] : [],
        messageIDs: messageID ? [messageID] : [],
      };
      seen.set(dupKey, line);
      lines.push(line);
    }
    return {
      taskRef,
      taskRefKind: classifyMessage(taskRef),
      taskRefAgent: groupAgent,
      runs: list.length,
      fails: list.filter(record => outcomeOf(record) === 'failure' || outcomeOf(record) === 'error').length,
      lines,
    };
  });
}

// ---------------------------------------------------------------------------
// command signatures (shape of a command, not its text)
// ---------------------------------------------------------------------------

const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'npx', 'bun', 'pnpm', 'yarn', 'uv', 'docker', 'pm2',
  'kubectl', 'gh', 'cargo', 'go', 'make', 'just', 'brew', 'apt', 'pip',
  'python', 'python3', 'node', 'deno',
]);
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'xargs', 'sh', 'bash', 'zsh', 'dash']);
const SECOND_LEVEL = new Set(['run', 'exec', 'runCommand']);

function splitTop(command: string, separators: string[]): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    const hit = separators.find(sep => command.startsWith(sep, i));
    if (hit) {
      parts.push(current);
      current = '';
      i += hit.length;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part.length > 0);
}

function tokenize(segment: string): string[] {
  const noRedirect = splitTop(segment, ['>', '<']).filter((_, index) => index === 0);
  const text = noRedirect[0] ?? '';
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

const baseName = (token: string): string => {
  const clean = token.replace(/^["']|["']$/g, '');
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
};

const isPathLike = (token: string): boolean =>
  token.includes('/') || token.startsWith('.') || token.startsWith('~') || /\.(py|ts|js|tsx|jsx|sh|json|md|yaml|yml|toml|sql|txt|log)$/.test(token);

const isUrl = (token: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token);

const placeholder = (token: string): string => {
  const bare = token.replace(/^["']|["']$/g, '');
  if (/^-?[0-9]+$/.test(bare)) return '<n>';
  if (isUrl(bare)) return '<url>';
  if (/^--[a-zA-Z0-9-]+=.+/.test(bare)) return bare.split('=')[0] + '=<v>';
  if (/^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(bare) && !isPathLike(bare)) return bare;
  if (isPathLike(bare)) return '<path>';
  if (/^[A-Z_][A-Z0-9_]*=/.test(bare)) return '<env>';
  return '<arg>';
};

const GENERIC_MODS = new Set([
  'json', 'os', 're', 'sys', 'pathlib', 'subprocess', 'hashlib', 'asyncio',
  'datetime', 'collections', 'tempfile', 'secrets', 'copy', 'time', 'shutil',
  'logging', 'urllib', 'argparse', 'typing',
]);

export function familyMods(mods: string[]): string[] {
  const distinct = [...new Set(mods.filter(m => !GENERIC_MODS.has(m)))].sort();
  if (distinct.length > 0) return distinct.slice(0, 5);
  return [...new Set(mods.filter(m => GENERIC_MODS.has(m)))].sort().slice(0, 3);
}

export function pyModules(text: string, cap = 6): string[] {
  const mods: string[] = [];
  const scan = text.length > 20_000 ? text.slice(0, 20_000) : text;
  for (const seg of scan.split(/[\n;]+/)) {
    const t = seg.trim();
    let m = t.match(/^import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split('.')[0].split(/\s/)[0];
        if (!n || n === '__future__' || /^[{}}*]/.test(n)) continue;
        if (!mods.includes(n)) mods.push(n);
      }
    } else {
      m = t.match(/^from\s+(\S+)\s+import\s+/);
      if (m && !m[1].startsWith('.')) {
        const n = m[1].split('.')[0];
        if (n !== '__future__' && !mods.includes(n)) mods.push(n);
      }
    }
    if (mods.length >= cap) break;
  }
  return mods.slice(0, cap);
}

export function stripHeredoc(text: string): string {
  let out = text;
  for (let i = 0; i < 5; i += 1) {
    const m = out.match(/<<-?\s*['"]?([A-Za-z0-9_]+)['"]?/);
    if (!m || m.index === undefined) break;
    const marker = m[1];
    const afterOpener = m.index + m[0].length;
    const rest = out.slice(afterOpener);
    const close = rest.match(new RegExp(`^${marker}[ \\t]*\r?$`, 'm'));
    if (!close || close.index === undefined) break;
    const next = out.slice(0, afterOpener) + ' <body> ' + rest.slice(close.index + close[0].length);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function signature(command: unknown): string {
  if (typeof command !== 'string' || command.trim().length === 0) return 'unknown';
  const stripped = stripHeredoc(command);
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  const heredoc = collapsed.match(/<<-?\s*['"]?([A-Za-z0-9_]+)['"]?/);
  if (collapsed.length > 4000 && !heredoc) return 'huge-command';
  const chain = splitTop(stripped.replace(/\s+/g, ' ').trim(), ['&&', '||', ';']);
  const last = chain[chain.length - 1] ?? collapsed;
  const sides = splitTop(last, ['|']);
  const signed = sides.map(side => {
    let tokens = tokenize(side);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    while (tokens.length > 1 && WRAPPERS.has(baseName(tokens[0]).toLowerCase())) {
      tokens = tokens.slice(1);
      if ((tokens[0] === '-c' || tokens[0] === '-lc') && tokens.length > 1) {
        const inner = tokens.slice(1).join(' ').replace(/^["']|["']$/g, '');
        return `sh-c:${signature(inner)}`;
      }
    }
    if (tokens.length === 0) return 'empty';
    const head = baseName(tokens[0]).toLowerCase();
    const rest = tokens.slice(1);
    if (rest.length === 0) return head;
    if (SUBCOMMAND_TOOLS.has(head) && rest.length > 0 && !rest[0].startsWith('-')) {
      const sub = baseName(rest[0]).toLowerCase();
      const tail = rest.slice(1);
      if ((head === 'npm' || head === 'bun' || head === 'pnpm' || head === 'yarn') && sub === 'run' && tail.length > 0 && !tail[0].startsWith('-')) {
        return `${head} run ${baseName(tail[0]).toLowerCase()}`;
      }
      if (head === 'uv' && SECOND_LEVEL.has(sub) && tail.length > 0 && !tail[0].startsWith('-')) {
        return `${head} ${sub} ${baseName(tail[0]).toLowerCase()}`;
      }
      const tailSig = tail.map(placeholder);
      return [head, sub, ...tailSig].join(' ');
    }
    return [head, ...rest.map(placeholder)].join(' ');
  });
  const core = signed.join(' | ');
  if (!heredoc) return core;
  if (/python/.test(core)) {
    const mods = familyMods(pyModules(command as string));
    if (mods.length > 0) return `${core} [py:${mods.join(',')}]`;
    return `${core} [heredoc:${heredoc[1]}]`;
  }
  return `${core} [heredoc:${heredoc[1]}]`;
}

// ---------------------------------------------------------------------------
// reads / stuck / meta / prompts
// ---------------------------------------------------------------------------

/** Read digest: which files were read most, by whom, which line ranges. */
export function readDigest(records: EnrichedRecord[]): ReadStat[] {
  const by = new Map<string, { reads: number; agents: Set<string>; ranges: Set<string> }>();
  for (const record of records) {
    if (record.kind !== 'tool-call' || record.tool !== 'read') continue;
    let path: string | null = null;
    let range: string | null = null;
    if (typeof record.args === 'string') {
      try {
        const args = asDict(JSON.parse(record.args) as unknown);
        if (args && typeof args.path === 'string') {
          path = args.path;
          const offset = typeof args.offset === 'number' ? args.offset : null;
          const limit = typeof args.limit === 'number' ? args.limit : null;
          if (offset !== null) range = limit !== null ? `${offset}-${offset + limit}` : `${offset}-`;
        }
      } catch {
        continue;
      }
    }
    if (!path) continue;
    const entry = by.get(path) ?? { reads: 0, agents: new Set<string>(), ranges: new Set<string>() };
    entry.reads += 1;
    const agent = agentOf(record);
    if (agent) entry.agents.add(agent);
    if (range) entry.ranges.add(range);
    by.set(path, entry);
  }
  return [...by.entries()]
    .map(([path, info]) => ({ path, reads: info.reads, agents: [...info.agents], ranges: [...info.ranges].slice(0, 5) }))
    .sort((a, b) => b.reads - a.reads);
}

/** Max number of read windows covering a common line. [-1,-1] = whole-file read, overlaps everything. */
export function maxOverlap(windows: [number, number][]): number {
  const points = new Set<number>();
  for (const [a, b] of windows) {
    if (a < 0) return windows.length;
    points.add(a);
    points.add(Math.max(a, b - 1));
  }
  let best = 1;
  for (const p of points) {
    let depth = 0;
    for (const [a, b] of windows) if (a < 0 || (p >= a && p < b)) depth += 1;
    if (depth > best) best = depth;
  }
  return best;
}

/** Stuck signals for one session: retries, re-reads, slow runs, interruptions. */
export async function stuckReport(options: {
  records: EnrichedRecord[];
  dbPath?: string;
  sessionID: string;
  skipDb?: boolean;
}): Promise<StuckReport> {
  const bySig = new Map<string, { runs: number; fails: number }>();
  const slow: { ms: number; command: string }[] = [];
  for (const record of options.records) {
    const cmd = typeof record.command === 'string' ? record.command : null;
    if (cmd) {
      const sig = signature(cmd);
      const entry = bySig.get(sig) ?? { runs: 0, fails: 0 };
      entry.runs += 1;
      if (record.outcome === 'failure' || record.outcome === 'error') entry.fails += 1;
      bySig.set(sig, entry);
    }
    if (typeof record.durationMs === 'number' && record.durationMs >= 30_000 && cmd) {
      slow.push({ ms: record.durationMs, command: cmd.replace(/\s+/g, ' ').trim().slice(0, 100) });
    }
  }
  const retries = [...bySig.entries()]
    .filter(([, v]) => v.runs >= 3 && v.fails >= 2 && v.fails / v.runs >= 0.25)
    .map(([sig, v]) => ({ signature: sig, ...v }))
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 5);
  slow.sort((a, b) => b.ms - a.ms);
  const rereadKey = new Map<string, { path: string; agent: string; windows: [number, number][] }>();
  for (const record of options.records) {
    if (record.kind !== 'tool-call' || record.tool !== 'read') continue;
    let path: string | null = null;
    let window: [number, number] | null = null;
    if (typeof record.args === 'string') {
      try {
        const args = asDict(JSON.parse(record.args) as unknown);
        if (args && typeof args.path === 'string') {
          path = args.path;
          if (typeof args.offset === 'number' && typeof args.limit === 'number') {
            window = [args.offset, args.offset + args.limit];
          }
        }
      } catch {
        continue;
      }
    }
    if (!path) continue;
    const agent = typeof record.agent === 'string' && record.agent.length > 0 ? record.agent : '?';
    const key = `${agent} ${path}`;
    const entry = rereadKey.get(key) ?? { path: path.split('/').slice(-2).join('/'), agent, windows: [] };
    entry.windows.push(window ?? [-1, -1]);
    rereadKey.set(key, entry);
  }
  const rereads = [...rereadKey.values()]
    .map(e => ({ path: e.path, agent: e.agent, reads: e.windows.length, depth: maxOverlap(e.windows) }))
    .filter(e => e.depth >= 3)
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 5);
  let interruptions = 0;
  let compactions = 0;
  const afterInterrupt: string[] = [];
  const db = options.skipDb ? null : await openDb(options.dbPath ?? defaultDbPath(), []);
  if (db) {
    try {
      const rows = db.prepare('SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type').all(options.sessionID) as { type: unknown; n: unknown }[];
      for (const row of rows) {
        if (row.type === 'compaction' && typeof row.n === 'number') compactions = row.n;
      }
      const intr = db.prepare("SELECT seq FROM session_message WHERE session_id = ? AND data LIKE '%was interrupted%' ORDER BY seq LIMIT 5").all(options.sessionID) as { seq: unknown }[];
      interruptions = intr.length;
      for (const row of intr) {
        if (typeof row.seq !== 'number') continue;
        const next = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' AND seq > ? ORDER BY seq LIMIT 1").get(options.sessionID, row.seq) as { data: unknown } | null;
        if (!next || typeof next.data !== 'string') continue;
        try {
          const data = asDict(JSON.parse(next.data) as unknown);
          const text = data && typeof data.text === 'string' ? data.text : null;
          if (text) {
            const single = text.replace(/\s+/g, ' ').trim();
            afterInterrupt.push(single.length > 200 ? single.slice(0, 200) : single);
          }
        } catch {
          continue;
        }
      }
      if (intr.length === 5) {
        const total = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND data LIKE '%was interrupted%'").get(options.sessionID) as { n: unknown } | null;
        if (total && typeof total.n === 'number') interruptions = total.n;
      }
    } catch {
      // counts are best-effort
    } finally {
      db.close();
    }
  }
  return { retries, rereads, slow: slow.slice(0, 5), interruptions, compactions, afterInterrupt };
}

/** Session meta from opencode.db: title, cost, tokens, line-change summary, turn counts. */
export async function sessionMeta(options: { dbPath?: string; sessionID: string }): Promise<{ meta: SessionMeta | null; warning: string | null }> {
  const empty: SessionMeta = {
    sessionID: options.sessionID, title: null, directory: null, cost: null,
    tokens: null, additions: null, deletions: null, files: null, userTurns: 0, assistantTurns: 0, compactions: 0, lastWord: null, models: [],
  };
  const warnings: string[] = [];
  const db = await openDb(options.dbPath ?? defaultDbPath(), warnings);
  if (!db) return { meta: null, warning: warnings[0] ?? 'session database unavailable' };
  try {
    const row = db.prepare('SELECT title, directory, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, summary_additions, summary_deletions, summary_files FROM session_v2 WHERE id = ?').get(options.sessionID) as Dict | null;
    if (!row) return { meta: null, warning: 'session not in db' };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const meta: SessionMeta = {
      ...empty,
      title: typeof row.title === 'string' ? row.title : null,
      directory: typeof row.directory === 'string' ? row.directory : null,
      cost: num(row.cost),
      tokens: {
        input: num(row.tokens_input) ?? 0, output: num(row.tokens_output) ?? 0,
        reasoning: num(row.tokens_reasoning) ?? 0, cacheRead: num(row.tokens_cache_read) ?? 0,
        cacheWrite: num(row.tokens_cache_write) ?? 0,
      },
      additions: num(row.summary_additions), deletions: num(row.summary_deletions), files: num(row.summary_files),
    };
    try {
      const counts = db.prepare('SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type').all(options.sessionID) as { type: unknown; n: unknown }[];
      for (const c of counts) {
        if (c.type === 'user' && typeof c.n === 'number') meta.userTurns = c.n;
        if (c.type === 'assistant' && typeof c.n === 'number') meta.assistantTurns = c.n;
        if (c.type === 'compaction' && typeof c.n === 'number') meta.compactions = c.n;
      }
    } catch {
      // turn counts are best-effort
    }
    try {
      const lastRows = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 5").all(options.sessionID) as { data: unknown }[];
      for (const lastRow of lastRows) {
        if (typeof lastRow.data !== 'string') continue;
        try {
          const data = asDict(JSON.parse(lastRow.data) as unknown);
          const content = data?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              const text = asDict(part)?.text;
              if (typeof text === 'string' && text.trim().length > 0) {
                const single = text.replace(/\s+/g, ' ').trim();
                meta.lastWord = single.length > 500 ? single.slice(0, 500) : single;
                break;
              }
            }
          }
        } catch {
          continue;
        }
        if (meta.lastWord) break;
      }
    } catch {
      // last word is best-effort
    }
    try {
      const modelRows = db.prepare("SELECT DISTINCT json_extract(data,'$.model.id') AS m FROM session_message WHERE session_id = ? AND type = 'assistant' AND m IS NOT NULL LIMIT 10").all(options.sessionID) as { m: unknown }[];
      for (const modelRow of modelRows) {
        if (typeof modelRow.m === 'string' && !meta.models.includes(modelRow.m)) meta.models.push(modelRow.m);
      }
    } catch {
      // models are best-effort
    }
    return { meta, warning: null };
  } finally {
    db.close();
  }
}

/** User prompts of a session (the instructions given, oldest first). */
export async function sessionPrompts(options: { dbPath?: string; sessionID: string; limit?: number }): Promise<SessionPrompt[]> {
  const warnings: string[] = [];
  const db = await openDb(options.dbPath ?? defaultDbPath(), warnings);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT ?").all(options.sessionID, options.limit ?? 20) as { data: unknown }[];
    return rows.flatMap(row => {
      if (typeof row.data !== 'string') return [];
      try {
        const data = asDict(JSON.parse(row.data) as unknown);
        const text = data && typeof data.text === 'string' ? data.text.replace(/\s+/g, ' ').trim() : null;
        if (!text) return [];
        const clipped = text.length > 300 ? text.slice(0, 300) : text;
        return [{ text: clipped, kind: classifyMessage(clipped) === 'briefing' ? 'briefing' as const : 'user' as const }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** All sidecar records grouped by session in one pass (for cross-session feeds). */
export async function allSessionRecords(options: {
  logPath?: string;
}): Promise<{ by: Map<string, SidecarRecord[]>; truncated: boolean; enabled: boolean }> {
  const logPath = options.logPath ?? defaultLogPath();
  let lines: string[];
  let truncated = false;
  try {
    const read = await readSidecarLines(logPath);
    lines = read.lines;
    truncated = read.truncated;
  } catch {
    return { by: new Map(), truncated: false, enabled: false };
  }
  const by = new Map<string, SidecarRecord[]>();
  for (const line of lines) {
    const record = parseLine(line);
    if (!record || typeof record.sessionID !== 'string') continue;
    const list = by.get(record.sessionID) ?? [];
    list.push(record);
    by.set(record.sessionID, list);
  }
  for (const list of by.values()) list.sort((a, b) => timeOf(a) - timeOf(b));
  return { by, truncated, enabled: true };
}

/** Cross-session stuck feed: per-session signals, entries with no signals omitted. */
export async function globalStuck(options: {
  logPath?: string;
  dbPath?: string;
  sinceMs?: number | null;
  now?: number;
}): Promise<{ entries: { session: string; report: StuckReport }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { by, truncated, enabled } = await allSessionRecords({ logPath: options.logPath });
  if (!enabled) return { entries: [], warnings: ['observer not enabled on this machine'] };
  if (truncated) warnings.push('sidecar window truncated to the newest 8MB; older sessions may be missing');
  const now = options.now ?? Date.now();
  const cutoff = now - (options.sinceMs ?? defaultSinceMs);
  const entries: { session: string; report: StuckReport }[] = [];
  let dbCapped = false;
  let index = 0;
  const ordered = [...by.entries()].sort(([, a], [, b]) => timeOf(b[b.length - 1] ?? {}) - timeOf(a[a.length - 1] ?? {}));
  for (const [sessionID, records] of ordered.slice(0, maxSessions)) {
    const windowed = records.filter(record => timeOf(record) >= cutoff);
    if (windowed.length === 0) continue;
    // Interruptions/compactions need the DB; cap those lookups, keep sidecar signals for all.
    const skipDb = index >= 20;
    if (skipDb) dbCapped = true;
    index += 1;
    const enriched = windowed.map(record => ({ ...record, intent: null, taskRef: null, model: null }));
    const report = await stuckReport({ records: enriched, dbPath: options.dbPath, sessionID, skipDb });
    if (report.retries.length === 0 && report.rereads.length === 0 && report.slow.length === 0 && report.interruptions === 0 && report.compactions === 0) continue;
    entries.push({ session: sessionID, report });
  }
  if (dbCapped) warnings.push('interruption counts capped at 20 sessions; sidecar signals cover all sessions');
  return { entries, warnings };
}

/** Cross-session failure feed, newest first, capped at maxFailures. */
export async function globalMistakes(options: {
  logPath?: string;
  dbPath?: string;
  sinceMs?: number | null;
  session?: string;
  agent?: string;
  limit?: number;
  now?: number;
}): Promise<{ rows: MistakeRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  const logPath = options.logPath ?? defaultLogPath();
  let lines: string[];
  try {
    const read = await readSidecarLines(logPath);
    lines = read.lines;
    if (read.truncated) warnings.push('sidecar window truncated to the newest 8MB; older failures may be missing');
  } catch {
    return { rows: [], warnings: ['observer not enabled on this machine'] };
  }
  const now = options.now ?? Date.now();
  const cutoff = now - (options.sinceMs ?? defaultSinceMs);
  const limit = options.limit ?? maxFailures;
  const failures: { record: SidecarRecord; ms: number }[] = [];
  for (const line of lines) {
    const record = parseLine(line);
    if (!record || typeof record.sessionID !== 'string') continue;
    const outcome = typeof record.outcome === 'string' ? record.outcome : 'unknown';
    if (outcome !== 'failure' && outcome !== 'error') continue;
    if (options.session && record.sessionID !== options.session) continue;
    if (options.agent) {
      const agent = typeof record.agent === 'string' ? record.agent : '';
      if (!agent.toLowerCase().includes(options.agent.toLowerCase())) continue;
    }
    const ms = timeOf(record);
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    failures.push({ record, ms });
  }
  failures.sort((a, b) => b.ms - a.ms);
  const hardCap = Math.min(limit, maxFailures);
  const capped = failures.slice(0, hardCap);
  if (failures.length > hardCap && hardCap >= maxFailures) warnings.push(`failures capped at ${capped.length}; narrow the window`);
  // Attach task refs in bulk: one bounded message load per distinct session (cap 20).
  const distinctSessions = [...new Set(capped.map(entry => entry.record.sessionID as string))];
  const sessionIDs = distinctSessions.slice(0, 20);
  if (sessionIDs.length < distinctSessions.length) {
    warnings.push('task refs capped at 20 sessions; remaining rows show without task context');
  }
  const rowsBySession = new Map<string, MessageRow[]>();
  const dbWarnings: string[] = [];
  const db = await openDb(options.dbPath ?? defaultDbPath(), dbWarnings);
  if (db) {
    try {
      for (const sessionID of sessionIDs) {
        const rows = loadSessionMessages(db, sessionID);
        if (rows) rowsBySession.set(sessionID, rows);
      }
    } finally {
      db.close();
    }
  } else {
    warnings.push(...dbWarnings);
  }
  // Resolve task refs per failure via the loaded rows (messageID -> preceding user text).
  const rows: MistakeRow[] = capped.map(({ record }) => {
    const sessionID = record.sessionID as string;
    const sessionRows = rowsBySession.get(sessionID);
    const taskRef = sessionRows ? attachIntent(record, sessionRows).taskRef : null;
    const command = typeof record.command === 'string' ? record.command : null;
    const toolCmd = record.kind === 'tool-call' && typeof record.tool === 'string'
      ? `${record.tool}${typeof record.args === 'string' && record.args.length > 0 ? ` ${record.args}` : ''}`
      : null;
    const full = (command ?? toolCmd ?? 'unknown').replace(/\s+/g, ' ').trim();
    return {
      sessionID,
      at: typeof record.timestamp === 'string' ? record.timestamp : null,
      taskRef,
      taskRefKind: classifyMessage(taskRef),
      signature: signature(command ?? full),
      outcome: typeof record.outcome === 'string' ? record.outcome : 'unknown',
      failReason: command ? failReason(command) : null,
      excerpt: typeof record.excerpt === 'string' && record.excerpt.length > 0 ? record.excerpt : null,
      agent: agentOf(record),
    };
  });
  return { rows, warnings };
}

/** Cost table: one meta row per session in the window, cost desc. */
export async function costTable(options: {
  logPath?: string;
  dbPath?: string;
  sinceMs?: number | null;
  limit?: number;
  now?: number;
}): Promise<{ rows: CostRow[]; warnings: string[] }> {
  const limit = options.limit ?? maxSessions;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxSessions) throw new Error(observerMessages.badLimit);
  const { sessions, warnings } = await listSessions({ logPath: options.logPath, sinceMs: options.sinceMs, now: options.now });
  const picked = sessions.slice(0, limit);
  const rows: CostRow[] = [];
  for (const session of picked) {
    const { meta, warning } = await sessionMeta({ dbPath: options.dbPath, sessionID: session.sessionID });
    if (!meta) {
      if (warning && !warnings.includes(warning)) warnings.push(warning);
      continue;
    }
    rows.push({
      sessionID: meta.sessionID,
      title: meta.title,
      directory: meta.directory,
      cost: meta.cost,
      tokens: meta.tokens,
      additions: meta.additions,
      deletions: meta.deletions,
      files: meta.files,
      userTurns: meta.userTurns,
      assistantTurns: meta.assistantTurns,
      compactions: meta.compactions,
      last: session.last,
    });
  }
  rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
  return { rows, warnings };
}

/** Local health line: log growth, hook kinds, ring fill, DB readability. */
export async function doctor(options: { logPath?: string; dbPath?: string } = {}): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const logPath = options.logPath ?? defaultLogPath();
  try {
    const info = await stat(logPath);
    const { lines: rows } = await readSidecarLines(logPath);
    const last = rows.length > 0 ? (() => { try { return (parseLine(rows[rows.length - 1])?.timestamp as unknown) ?? null; } catch { return null; } })() : null;
    const age = typeof last === 'string' && Number.isFinite(Date.parse(last))
      ? Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000))
      : null;
    const kinds = new Set<string>();
    for (const line of rows.slice(-500)) {
      const parsed = parseLine(line);
      if (parsed) kinds.add(typeof parsed.kind === 'string' ? parsed.kind : 'shell');
    }
    lines.push({ name: 'log', ok: true, detail: `growing: ${(info.size / 1024).toFixed(0)}KB/${rows.length} lines in window, last line ${age === null ? 'unknown' : `${age}s ago`}` });
    lines.push({ name: 'hooks', ok: kinds.size > 0, detail: kinds.size > 0 ? `flowing types: ${[...kinds].join(', ')}` : 'no records in the last 500 lines' });
    const pctBytes = Math.min(99, Math.round((info.size / (100 * 1024 * 1024)) * 100));
    const pctLines = Math.min(99, Math.round((rows.length / 50_000) * 100));
    const pct = Math.max(pctBytes, pctLines);
    lines.push({ name: 'ring', ok: pct < 90, detail: `${pct}% full (${(info.size / 1024).toFixed(0)}KB/${rows.length} lines; cap 100MB/50k)` });
  } catch (error) {
    lines.push({ name: 'log', ok: false, detail: `unreadable: ${String(error).slice(0, 120)}` });
    lines.push({ name: 'hooks', ok: false, detail: 'no log' });
    lines.push({ name: 'ring', ok: false, detail: 'no log' });
  }
  const warnings: string[] = [];
  const db = await openDb(options.dbPath ?? defaultDbPath(), warnings);
  if (!db) {
    lines.push({ name: 'db', ok: false, detail: warnings[0] ?? 'session database unavailable' });
    return lines;
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_message','session_v2')").all() as { name: unknown }[];
    const names = tables.map(t => t.name);
    const ok = names.includes('session_message') && names.includes('session_v2');
    lines.push({ name: 'db', ok, detail: ok ? 'session_message + session_v2 readable' : `missing tables (have: ${names.join(',') || 'none'})` });
  } catch (error) {
    lines.push({ name: 'db', ok: false, detail: `unreadable: ${String(error).slice(0, 120)}` });
  } finally {
    db.close();
  }
  return lines;
}
