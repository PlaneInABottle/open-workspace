import { z } from 'zod';
import { boundedEnvironment, runBoundedCommand, verifyMessages, type CommandOutcome, type CommandRunner } from './verify.js';

// Unix-socket-only read-only queries. The API schema carries explicit role and
// database identifiers and rejects host/port/socket/password/URL fields via
// strict parsing; the server selects the local socket itself.
export const datastoreStatementTimeout = '8s';
export const datastoreRunnerTimeoutMs = 15_000;
export const datastoreSocketTimeoutMs = 40_000;
export const datastoreOutputLimit = 64 * 1024;
export const datastoreFieldSeparator = '\x1f';
export const datastoreNullMarker = '\x1e';
export const datastoreNullMarkerLabel = 'U+001E';

const identifier = z.string().min(1).max(63).regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const paramScalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);

export const datastoreQuerySchema = z.object({
  database: identifier,
  role: identifier,
  sql: z.string().min(1).max(8000),
  params: z.array(paramScalar).max(20).optional().default([]),
  maxRows: z.number().int().min(1).max(100).optional().default(50),
}).strict();

export type DatastoreQueryInput = z.infer<typeof datastoreQuerySchema>;
export type DatastoreParam = z.infer<typeof paramScalar>;

export interface DatastoreQueryResult {
  inspectedAt: string;
  database: string;
  role: string;
  columns: string[];
  rows: (string | null)[][];
  nullMarker: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface DatastoreRunnerOptions {
  run?: CommandRunner;
  socketDir?: string;
  port?: number;
  /** Absolute canonical executable path. Absent preserves the historic bare-'psql' behavior. */
  executablePath?: string;
}

// Failure stage travels on a non-message property (never inside the text),
// so every message string below stays byte-identical to its pre-stage form.
// R3: callers read the stage via datastoreErrorStage(); matching on message
// text is forbidden. instanceof Error, .name ('Error') and .message are
// preserved exactly — only the stage marker is added.
export type DatastoreFailureStage = 'connect' | 'query';

export class DatastoreStagedError extends Error {
  readonly stage: DatastoreFailureStage;
  constructor(stage: DatastoreFailureStage, message: string) {
    super(message);
    this.name = 'Error';
    this.stage = stage;
  }
}

export function datastoreErrorStage(error: unknown): DatastoreFailureStage | undefined {
  return error instanceof DatastoreStagedError ? error.stage : undefined;
}

type SegmentKind = 'code' | 'literal' | 'comment';

interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
}

// Single literal-aware tokenizer over single-quoted, double-quoted and
// dollar-quoted segments plus line/block comments. All analysis derives from
// these segments so literals are skipped for structure but never dropped.
function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  let codeStart = 0;
  const flushCode = (end: number) => {
    if (end > codeStart) segments.push({ kind: 'code', start: codeStart, end });
    codeStart = end;
  };
  const dollarTag = (at: number): { tag: string; length: number } | undefined => {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(at));
    return match ? { tag: match[0], length: match[0].length } : undefined;
  };
  const quoted = (open: "'" | '"', at: number, escape: boolean): number => {
    let end = at + 1;
    while (end < text.length) {
      // In escape string constants (E'...', U&'...', U&"...") a backslash
      // escapes the next character, so \' and \\ never terminate the literal.
      if (escape && text[end] === '\\') {
        end += 2;
        continue;
      }
      if (text[end] === open) {
        if (text[end + 1] === open) { end += 2; continue; }
        end += 1;
        break;
      }
      end += 1;
    }
    return end;
  };
  const isIdentChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_$]/.test(char);
  // Escape-string prefix immediately before the opening quote: E'...' or
  // U&'...'/U&"...". A custom UESCAPE character is refused by the deny-list,
  // so backslash is always the escape character here.
  const escapePrefix = (at: number, open: "'" | '"'): boolean => {
    if (open === "'" && (text[at - 1] === 'E' || text[at - 1] === 'e') && !isIdentChar(text[at - 2])) return true;
    if ((text[at - 2] === 'U' || text[at - 2] === 'u') && text[at - 1] === '&' && !isIdentChar(text[at - 3])) return true;
    return false;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const end = quoted(char, index, escapePrefix(index, char));
      flushCode(index);
      segments.push({ kind: 'literal', start: index, end });
      index = end;
      codeStart = index;
      continue;
    }
    if (char === '$') {
      const tag = dollarTag(index);
      if (tag) {
        const close = text.indexOf(tag.tag, index + tag.length);
        const end = close === -1 ? text.length : close + tag.length;
        flushCode(index);
        segments.push({ kind: 'literal', start: index, end });
        index = end;
        codeStart = index;
        continue;
      }
    }
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index + 2);
      flushCode(index);
      segments.push({ kind: 'comment', start: index, end: end === -1 ? text.length : end });
      index = end === -1 ? text.length : end;
      codeStart = index;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      flushCode(index);
      segments.push({ kind: 'comment', start: index, end });
      index = end;
      codeStart = index;
      continue;
    }
    index += 1;
  }
  flushCode(text.length);
  return segments;
}

// Calls back for every region outside literals and comments.
function scanOutsideLiterals(text: string, visit: (chunk: string, start: number, end: number) => void) {
  for (const segment of tokenize(text)) {
    if (segment.kind === 'code') visit(text.slice(segment.start, segment.end), segment.start, segment.end);
  }
}

function stripComments(sql: string): string {
  // Comments are removed; literals are preserved verbatim for execution.
  return tokenize(sql)
    .filter(segment => segment.kind !== 'comment')
    .map(segment => sql.slice(segment.start, segment.end))
    .join('');
}

function maskLiterals(sql: string): string {
  // Outside regions stay intact; literals and comments are blanked so
  // hostile text inside them cannot match structural deny-list patterns.
  return tokenize(sql)
    .map(segment => (segment.kind === 'code' ? sql.slice(segment.start, segment.end) : ' '.repeat(segment.end - segment.start)))
    .join('');
}

function quoteLiteral(value: string): string {
  // standard_conforming_strings is on, so doubling quotes is sufficient.
  return `'${value.replace(/'/g, "''")}'`;
}

function literalFor(param: DatastoreParam): string {
  if (param === null) return 'NULL';
  if (typeof param === 'boolean') return param ? 'TRUE' : 'FALSE';
  if (typeof param === 'number') return String(param);
  return quoteLiteral(param);
}

// Positional $n placeholders are replaced with safely quoted literals.
// Validation always runs on this FINAL text, so a hostile parameter value can
// only ever land inside a string literal and can never form a 2nd statement.
export function bindParams(sql: string, params: DatastoreParam[]): string {
  let bound = '';
  let cursor = 0;
  scanOutsideLiterals(sql, (chunk, start, end) => {
    bound += sql.slice(cursor, start);
    cursor = end;
    bound += chunk.replace(/\$(\d+)/g, (token, digits: string) => {
      const position = Number(digits);
      if (!Number.isInteger(position) || position < 1 || position > params.length) {
        throw new Error(shapeTitle);
      }
      return literalFor(params[position - 1]);
    });
  });
  bound += sql.slice(cursor);
  if (/\$\d/.test(maskLiterals(bound))) {
    throw new Error(shapeTitle);
  }
  return bound;
}

const shapeTitle = 'Only a single read-only SELECT-style statement is allowed.';

// Canonical datastore-path messages (shapeTitle above is the single
// definition site for the shape message). http.ts composes its allowlist
// from this object; the workspace-not-found throw below references
// verifyMessages instead (this module already imports verify.ts).
export const datastoreMessages = {
  shape: shapeTitle,
  identifier: 'Provide a database and role using 1–63 letters, digits or underscores.',
  superuser: 'Superuser database roles cannot be used for read-only queries.',
  timeout: 'The database query did not finish within the bounded runtime.',
  failed: 'The database query failed without returning rows.',
  unavailable: 'PostgreSQL client is unavailable.',
} as const;

export function singleStatement(sql: string): string {
  const stripped = stripComments(sql).trim();
  const withoutTrailing = stripped.endsWith(';') ? stripped.slice(0, -1) : stripped;
  let extra = false;
  scanOutsideLiterals(withoutTrailing, chunk => {
    if (chunk.includes(';')) extra = true;
  });
  if (extra || !withoutTrailing.trim()) throw new Error(shapeTitle);
  return withoutTrailing.trim();
}

export function checkShape(finalSql: string) {
  const upper = finalSql.toUpperCase();
  if (/^SELECT\b/.test(upper)) return;
  if (/^VALUES\b/.test(upper)) return;
  if (/^TABLE\b/.test(upper)) return;
  if (/^SHOW\b/.test(upper)) return;
  if (/^EXPLAIN\s+(SELECT|WITH)\b/.test(upper)) return;
  if (/^WITH\b/.test(upper) && /\bSELECT\b/.test(upper)) return;
  throw new Error(shapeTitle);
}

const deniedPatterns = [
  /\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /\bMERGE\b/,
  /\bCREATE\b/, /\bALTER\b/, /\bDROP\b/, /\bCOMMENT\b/,
  /\bTRUNCATE\b/, /\bGRANT\b/, /\bREVOKE\b/, /\bVACUUM\b/,
  /\bCALL\b/, /\bDO\b/, /\bCOPY\b/,
  /\bCOMMIT\b/, /\bROLLBACK\b/, /\bSAVEPOINT\b/,
  /\bSTART\s+TRANSACTION\b/, /^\s*BEGIN\b/,
  /^\s*SET\b/, /^\s*RESET\b/, /\bSET_CONFIG\b/,
  /\bLISTEN\b/, /\bUNLISTEN\b/, /\bNOTIFY\b/,
  /\bLO_IMPORT\b/, /\bLO_EXPORT\b/,
  /\bUESCAPE\b/,
  /\bPG_READ_FILE\b/, /\bPG_READ_BINARY_FILE\b/, /\bPG_WRITE\b/,
  // Server-side directory/file listing stays refused as defense-in-depth
  // (the boundary itself is least-privilege + READ ONLY + superuser
  // refusal): pg_ls_dir/pg_stat_file plus the pg_monitor-gated log/wal/
  // archive/tmp/summaries listers.
  /\bPG_LS_DIR\b/, /\bPG_STAT_FILE\b/,
  /\bPG_LS_LOGDIR\b/, /\bPG_LS_WALDIR\b/, /\bPG_LS_ARCHIVE_STATUSDIR\b/,
  /\bPG_LS_TMPDIR\b/, /\bPG_LS_SUMMARIESDIR\b/,
  /\bDBLINK\w*\b/,
  /\\/, // No psql meta-commands: literals are masked, so any backslash is one.
];

export function checkDenied(finalSql: string) {
  const masked = maskLiterals(finalSql).toUpperCase();
  for (const pattern of deniedPatterns) {
    if (pattern.test(masked)) throw new Error(shapeTitle);
  }
}

const superuserProbeSql = 'SELECT usesuper FROM pg_user WHERE usename = CURRENT_USER;';

export function psqlArgs(input: DatastoreQueryInput, options: DatastoreRunnerOptions): string[] {
  const args = [
    '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-A',
    '-F', datastoreFieldSeparator,
    '-P', `null=${datastoreNullMarker}`,
    '-P', 'pager=off', '-q',
    '-d', input.database, '-U', input.role,
  ];
  if (options.socketDir) args.push('-h', options.socketDir);
  if (options.port !== undefined) args.push('-p', String(options.port));
  args.push('-f', '-');
  return args;
}

function psqlEnv(): NodeJS.ProcessEnv {
  return boundedEnvironment({ PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'openworkspace-datastore' });
}

// Known limitation: unaligned psql output has no quoting, so a text value
// containing a newline or the field-separator control character parses as
// extra rows or columns. Values stay inert display text (never re-executed),
// and the 64 KiB capture plus maxRows truncation still bound the result.
function parseRows(stdout: string, maxRows: number): { columns: string[]; rows: (string | null)[][]; rowCount: number; truncated: boolean } {
  const lines = stdout.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length && /^\(\d+ rows?\)$/.test(lines[lines.length - 1].trim())) lines.pop();
  if (!lines.length) return { columns: [], rows: [], rowCount: 0, truncated: false };
  const columns = lines[0].split(datastoreFieldSeparator);
  const all = lines.slice(1).map(line =>
    line.split(datastoreFieldSeparator).map(field => (field === datastoreNullMarker ? null : field)));
  return {
    columns,
    rows: all.slice(0, maxRows),
    rowCount: all.length,
    truncated: all.length > maxRows,
  };
}

function timeoutFailure(output: CommandOutcome): boolean {
  if (output.timedOut) return true;
  const combined = `${output.stdout}\n${output.stderr}`;
  return /statement timeout|QueryCanceled|canceling statement/i.test(combined);
}

export async function runDatastoreQuery(
  workspaceRoots: string[],
  raw: unknown,
  options: DatastoreRunnerOptions = {},
): Promise<DatastoreQueryResult> {
  let input: DatastoreQueryInput;
  try {
    input = datastoreQuerySchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError && error.issues.some(issue => issue.path[0] === 'database' || issue.path[0] === 'role')) {
      throw new Error(datastoreMessages.identifier);
    }
    throw error;
  }
  if (!workspaceRoots.length || typeof workspaceRoots[0] !== 'string' || !workspaceRoots[0]) {
    throw new Error(verifyMessages.notFoundRegister);
  }
  const run = options.run ?? runBoundedCommand;
  const anchor = workspaceRoots[0];
  const base = {
    cwd: anchor,
    timeoutMs: datastoreRunnerTimeoutMs,
    outputLimit: datastoreOutputLimit,
    env: psqlEnv(),
  };
  const args = psqlArgs(input, options);
  const executable = options.executablePath ?? 'psql';
  // Shape and deny-list validation runs on the FINAL (parameter-bound) SQL
  // before any process starts, so refused statements are never executed.
  const finalSql = singleStatement(bindParams(input.sql, input.params ?? []));
  checkShape(finalSql);
  checkDenied(finalSql);
  // Stage classification (G5): everything thrown from the superuser probe path
  // below carries stage 'connect' (caller/environment errors — bad database or
  // role, server down, superuser refusal, connect timeouts); everything from
  // the main-query path carries stage 'query' (tool-defect candidates). The
  // probe reuses the exact class argv vector, so compiled-flag breakage
  // surfaces here at probe stage and never auto-quarantines (accepted, G7).
  let probe: CommandOutcome;
  try {
    probe = await run(executable, args, { ...base, input: superuserProbeSql });
  } catch {
    throw new DatastoreStagedError('connect', datastoreMessages.unavailable);
  }
  if (probe.spawnFailed) throw new DatastoreStagedError('connect', datastoreMessages.unavailable);
  if (probe.exitCode !== 0) throw new DatastoreStagedError('connect', datastoreMessages.failed);
  if (/^\s*t\s*$/im.test(probe.stdout)) {
    throw new DatastoreStagedError('connect', datastoreMessages.superuser);
  }
  const wrapped = `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${datastoreStatementTimeout}';\n${finalSql};\nCOMMIT;\n`;
  const startedAt = Date.now();
  let outcome: CommandOutcome;
  try {
    outcome = await run(executable, args, { ...base, input: wrapped });
  } catch {
    throw new DatastoreStagedError('query', datastoreMessages.unavailable);
  }
  const durationMs = Date.now() - startedAt;
  if (outcome.spawnFailed) throw new DatastoreStagedError('query', datastoreMessages.unavailable);
  if (outcome.exitCode !== 0 || outcome.truncated) {
    if (timeoutFailure(outcome)) throw new DatastoreStagedError('query', datastoreMessages.timeout);
    throw new DatastoreStagedError('query', datastoreMessages.failed);
  }
  const parsed = parseRows(new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(outcome.stdout, 'utf8')), input.maxRows ?? 50);
  return {
    inspectedAt: new Date().toISOString(),
    database: input.database,
    role: input.role,
    columns: parsed.columns,
    rows: parsed.rows,
    nullMarker: datastoreNullMarkerLabel,
    rowCount: parsed.rowCount,
    truncated: parsed.truncated || outcome.truncated,
    durationMs,
    timedOut: false,
  };
}
