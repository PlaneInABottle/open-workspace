import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ensurePrivateDirectory, writePrivateJson } from './store.js';
import { maskSecrets } from './run-summaries.js';
import { boundedEnvironment, runBoundedCommand, type CommandRunner } from './verify.js';
import {
  bindParams,
  checkDenied,
  checkShape,
  datastoreErrorStage,
  runDatastoreQuery,
  singleStatement,
  type DatastoreQueryResult,
} from './datastore.js';
import { localToolClasses, localToolProbeTimeoutMs, type LocalToolClass } from './local-tools-allowlist.js';

// Declarative local tools: untrusted JSON declarations executed solely by the
// hardened datastore path. This module adds no process-start site of its own:
// every run delegates to runDatastoreQuery with a server-owned argv vector and
// a canonical absolute executable path.

// --- Closed slot classes (server-defined only; no free text, no custom regex) ---

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const enumValuePattern = /^[A-Za-z0-9][A-Za-z0-9_.,:]{0,63}$/;
const slotKeyPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const toolNamePattern = /^[a-z][a-z0-9_]{0,39}$/;
const reservedNamePrefixes = ['workspace_', 'service_', 'verification_', 'lease_', 'workstream_',
  'activity_', 'recent_', 'onboarding_', 'browser_', 'datastore_', 'local_'];
const sourceDraftPattern = /^[a-z0-9-]{1,80}\.md$/;
const declarationSizeLimit = 8 * 1024;
const toolCountLimit = 20;
const quarantineThreshold = 3;

export type SlotDecl =
  | { kind: 'identifier' }
  | { kind: 'slug' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: string[] };

const slotDeclSchema = z.union([
  z.object({ kind: z.literal('identifier') }).strict(),
  z.object({ kind: z.literal('slug') }).strict(),
  // F1: argv-bound integers are never negative; bounds stay within ±1e9.
  z.object({ kind: z.literal('integer'), min: z.number().int(), max: z.number().int() }).strict()
    .refine(value => value.min <= value.max && value.min >= 0 && Math.abs(value.max) <= 1e9),
  z.object({ kind: z.literal('enum'), values: z.array(z.string().regex(enumValuePattern)).min(2).max(20) }).strict(),
]);

const declarationSchema = z.object({
  name: z.string(),
  description: z.string(),
  executable: z.string(),
  slots: z.record(z.string(), slotDeclSchema)
    .refine(slots => Object.keys(slots).length <= 5)
    .refine(slots => Object.keys(slots).every(key => slotKeyPattern.test(key))),
  statement: z.string(),
  caps: z.object({ maxRows: z.number().int().optional() }).strict().optional().default({}),
  provenance: z.object({
    origin: z.enum(['handwritten', 'scaffolded']),
    sourceDraft: z.string().optional(),
    createdAt: z.string().datetime(),
  }).strict(),
}).strict();

export type LocalToolDeclaration = {
  name: string;
  description: string;
  executable: string;
  slots: Record<string, SlotDecl>;
  statement: string;
  maxRows: number;
  origin: 'handwritten' | 'scaffolded';
  createdAt: string;
};

// --- Closed gate/call vocabularies (every string below joins the http safe list) ---

export const localToolGateMessages = {
  unreadable: 'Local tool file could not be read safely.',
  notJson: 'Local tool declaration is not valid JSON.',
  invalid: 'Local tool declaration failed validation.',
  badName: 'Local tool name is not allowed.',
  badDescription: 'Local tool description is not allowed.',
  notAllowlisted: 'Local tool executable is not allowlisted.',
  slotMismatch: 'Local tool inputs do not match the executable class.',
  badShape: 'Local tool command shape is not allowed.',
  badLimits: 'Local tool limits are out of range.',
  limitReached: 'Local tool limit reached.',
} as const;

export const localToolCallMessages = {
  notAvailable: 'Local tool is not available.',
  invalidCall: 'Local tool call is not valid.',
  invalidInputs: 'Local tool inputs are not valid.',
} as const;

export type LocalToolReasonCode = 'gate-shape' | 'gate-executable' | 'gate-inputs'
  | 'gate-limits' | 'gate-provenance' | 'gate-description' | 'runtime-failures';

function reasonCodeForGateError(message: string): LocalToolReasonCode {
  if (message === localToolGateMessages.notAllowlisted) return 'gate-executable';
  if (message === localToolGateMessages.slotMismatch) return 'gate-inputs';
  if (message === localToolGateMessages.badLimits || message === localToolGateMessages.limitReached) return 'gate-limits';
  if (message === localToolGateMessages.badDescription) return 'gate-description';
  if (message === localToolGateMessages.invalid) return 'gate-provenance';
  return 'gate-shape';
}

// Status key for a file that failed to gate: prefer the declared name when the
// file parsed to an object carrying one, otherwise fall back to the filename.
function displayName(raw: unknown, file: string): string {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    && typeof (raw as { name?: unknown }).name === 'string'
    && (raw as { name: string }).name.length > 0) {
    return (raw as { name: string }).name.slice(0, 100);
  }
  return file.slice(0, -'.json'.length);
}

// Description confinement (F5/G6): the description is untrusted data rendered
// in the MCP description field only. Pattern refusal is defense-in-depth and
// explicitly non-exhaustive; field-confinement is the primary control.
const forbiddenDescriptionPatterns = [
  /```/,
  /\[[^\]]*\]\([^)]*\)/,
  /https?:\/\//i,
  /www\./i,
  /ignore|disregard|forget.{0,40}(previous|prior|above|instructions|rules)/i,
  /you are (now|a)/i,
  /system prompt/i,
];

function checkDescription(description: string) {
  if (description.length < 1 || description.length > 200
    || /[\0-\x1f\x7f]/.test(description)
    || forbiddenDescriptionPatterns.some(pattern => pattern.test(description))) {
    throw new Error(localToolGateMessages.badDescription);
  }
}

// --- Call body schema (route-level; failures map to invalidCall, never raw zod) ---

export const localToolCallBodySchema = z.object({
  tool: z.string().regex(toolNamePattern),
  inputs: z.record(z.string(), z.unknown()),
}).strict().refine(body => Object.keys(body.inputs).length <= 5);

// --- Slot translation (strict zod per tool; ZodError caught at this boundary) ---

export function slotValueSchemas(slots: Record<string, SlotDecl>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.kind === 'identifier') shape[key] = z.string().min(1).max(63).regex(identifierPattern);
    else if (slot.kind === 'slug') shape[key] = z.string().regex(slugPattern);
    else if (slot.kind === 'integer') shape[key] = z.number().int().min(slot.min).max(slot.max);
    else shape[key] = z.enum(slot.values as [string, ...string[]]);
  }
  return shape;
}

// Universal post-substitution rule (F1): after slot placement every
// slot-derived value is re-matched to its class AND must not begin with '-',
// so flag smuggling is refused pre-run regardless of class. Checked at every
// invocation; the gate guarantees only closed classes can reach this point.
export function checkSlotValues(decl: LocalToolDeclaration, values: Record<string, unknown>) {
  for (const [key, slot] of Object.entries(decl.slots)) {
    const value = values[key];
    if (slot.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < slot.min || value > slot.max) {
        throw new Error(localToolCallMessages.invalidInputs);
      }
    } else {
      if (typeof value !== 'string') throw new Error(localToolCallMessages.invalidInputs);
      const pattern = slot.kind === 'identifier' ? identifierPattern
        : slot.kind === 'slug' ? slugPattern : enumValuePattern;
      if (!pattern.test(value)
        || (slot.kind === 'enum' && !(slot.values as string[]).includes(value))
        || value.startsWith('-')) {
        throw new Error(localToolCallMessages.invalidInputs);
      }
    }
  }
}

/** MCP presentation: server prefix, description field only, never instructions/SQL/argv. */
export function localToolDescription(name: string, description: string): string {
  return `Local tool ${name}: ${description}`;
}

// --- Canonical executable resolution (same PATH model as toolAvailability) ---

async function verifyCanonicalBinary(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return false;
  }
  if (!info.isFile() || info.isSymbolicLink()) return false;
  if ((info.mode & 0o022) !== 0) return false;
  if (process.getuid && info.uid !== process.getuid() && info.uid !== 0) return false;
  try {
    await access(path, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

export async function resolveCanonicalBinary(binary: string, searchPath: string): Promise<string | undefined> {
  for (const directory of searchPath.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, binary);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    try {
      const canonical = await realpath(candidate);
      if (await verifyCanonicalBinary(canonical)) return canonical;
    } catch {
      continue;
    }
  }
  return undefined;
}

// --- Loader + gate (service-side only; first failure wins, safe error) ---

export interface GatedDeclaration extends LocalToolDeclaration {
  className: string;
  canonical: string;
  available: boolean;
}

async function readDeclarationFile(directory: string, fileName: string): Promise<unknown> {
  const path = join(directory, fileName);
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(localToolGateMessages.unreadable);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > declarationSizeLimit
    || (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(localToolGateMessages.unreadable);
  }
  let parsed: unknown;
  try {
    const bytes = await readFile(path);
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(localToolGateMessages.notJson);
  }
  return parsed;
}

export async function gateDeclaration(
  raw: unknown,
  options: {
    homeDir: string;
    acceptedCount: number;
    probe: (canonical: string, toolClass: LocalToolClass) => Promise<boolean>;
    searchPath: string;
  },
): Promise<GatedDeclaration> {
  const envelope = declarationSchema.safeParse(raw);
  if (!envelope.success) throw new Error(localToolGateMessages.invalid);
  const decl = envelope.data;
  if (!toolNamePattern.test(decl.name) || reservedNamePrefixes.some(prefix => decl.name.startsWith(prefix))) {
    throw new Error(localToolGateMessages.badName);
  }
  checkDescription(decl.description);
  const toolClass = /^[a-z][a-z0-9-]{0,63}$/.test(decl.executable)
    ? localToolClasses[decl.executable]
    : undefined;
  if (!toolClass) throw new Error(localToolGateMessages.notAllowlisted);
  const specKeys = Object.keys(toolClass.slotSpec).sort();
  const slotKeys = Object.keys(decl.slots).sort();
  if (slotKeys.length !== specKeys.length
    || !slotKeys.every((key, index) => key === specKeys[index] && (decl.slots[key] as SlotDecl).kind === toolClass.slotSpec[key])) {
    throw new Error(localToolGateMessages.slotMismatch);
  }
  // G4: the fixed statement carries zero placeholders and zero interpolation
  // points; bindParams(statement, []) rejects any surviving $n here at gate,
  // and runDatastoreQuery re-validates the final text at runtime.
  if (decl.statement.length < 1 || decl.statement.length > 8000 || decl.statement.includes('{{')) {
    throw new Error(localToolGateMessages.badShape);
  }
  try {
    const finalText = singleStatement(bindParams(decl.statement, []));
    checkShape(finalText);
    checkDenied(finalText);
  } catch {
    throw new Error(localToolGateMessages.badShape);
  }
  const maxRows = decl.caps.maxRows ?? 50;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100) {
    throw new Error(localToolGateMessages.badLimits);
  }
  if (decl.provenance.origin === 'scaffolded') {
    if (!decl.provenance.sourceDraft || !sourceDraftPattern.test(decl.provenance.sourceDraft)) {
      throw new Error(localToolGateMessages.invalid);
    }
    try {
      const draftInfo = await lstat(join(options.homeDir, 'learnings', '_drafts', decl.provenance.sourceDraft));
      if (!draftInfo.isFile() || draftInfo.isSymbolicLink()) throw new Error(localToolGateMessages.invalid);
    } catch {
      throw new Error(localToolGateMessages.invalid);
    }
  } else if (decl.provenance.sourceDraft !== undefined) {
    throw new Error(localToolGateMessages.invalid);
  }
  // M2: the count cap is enforced before any resolve/probe work so excess
  // declarations are refused without spawning probes.
  if (options.acceptedCount >= toolCountLimit) throw new Error(localToolGateMessages.limitReached);
  const canonical = await resolveCanonicalBinary(toolClass.binary, options.searchPath);
  const available = canonical !== undefined && await options.probe(canonical, toolClass);
  return {
    name: decl.name,
    description: decl.description,
    executable: decl.executable,
    slots: decl.slots as Record<string, SlotDecl>,
    statement: decl.statement,
    maxRows,
    origin: decl.provenance.origin,
    createdAt: decl.provenance.createdAt,
    className: toolClass.name,
    canonical: canonical ?? '',
    available,
  };
}

// --- Registry ---

export interface LocalToolStatusEntry {
  name: string;
  status: 'active' | 'pending' | 'quarantined';
  available: boolean;
  description: string;
  slots: Record<string, SlotDecl>;
  reasonCode?: LocalToolReasonCode;
  origin: 'handwritten' | 'scaffolded';
  createdAt: string;
  useCount: number;
  lastUseAt?: string;
  consecFailures: number;
  quarantinePending?: boolean;
}

interface ToolRecord {
  decl: GatedDeclaration;
  status: 'active' | 'pending' | 'quarantined';
  reasonCode?: LocalToolReasonCode;
  useCount: number;
  lastUseAt?: string;
  consecFailures: number;
  quarantinePending?: boolean;
}

export class LocalToolRegistry {
  private tools = new Map<string, ToolRecord>();
  private quarantinePending = new Set<string>();

  constructor(
    private readonly homeDir: string,
    private readonly deps: {
      run?: CommandRunner;
      recordActivity: (entry: { actor: 'dashboard' | 'mcp'; operation: string; workspaceId: string | null; detail: string }) => Promise<void>;
    },
  ) {}

  private get run(): CommandRunner {
    return this.deps.run ?? runBoundedCommand;
  }

  private directories() {
    const base = join(this.homeDir, 'local-tools');
    return { base, pending: join(base, 'pending'), active: join(base, 'active'), quarantined: join(base, 'quarantined') };
  }

  private async probeBinary(canonical: string, toolClass: LocalToolClass): Promise<boolean> {
    try {
      const outcome = await this.run(canonical, toolClass.probeArgs, {
        cwd: this.homeDir,
        timeoutMs: localToolProbeTimeoutMs,
        outputLimit: 4096,
        env: boundedEnvironment(),
      });
      return !outcome.spawnFailed && outcome.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async listDeclarations(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('.reason.json')).sort();
    } catch {
      return [];
    }
  }

  /** Service-side rescan: gate pending/active files, promote or quarantine, swap atomically. */
  async rescan(actor: 'dashboard' | 'mcp' = 'mcp'): Promise<void> {
    const dirs = this.directories();
    await ensurePrivateDirectory(dirs.pending);
    await ensurePrivateDirectory(dirs.active);
    await ensurePrivateDirectory(dirs.quarantined);
    // Retry previously failed quarantine renames before re-gating.
    for (const name of [...this.quarantinePending]) {
      const prior = this.tools.get(name);
      try {
        if (prior?.reasonCode) {
          await writePrivateJson(join(dirs.quarantined, `${name}.reason.json`),
            { code: prior.reasonCode, at: new Date().toISOString(), failures: prior.consecFailures });
        }
        await rename(join(dirs.active, `${name}.json`), join(dirs.quarantined, `${name}.json`));
        this.quarantinePending.delete(name);
      } catch {
        continue;
      }
    }
    const next = new Map<string, ToolRecord>();
    const keep = (name: string): Pick<ToolRecord, 'useCount' | 'lastUseAt' | 'consecFailures'> => {
      const prior = this.tools.get(name);
      return { useCount: prior?.useCount ?? 0, lastUseAt: prior?.lastUseAt, consecFailures: prior?.consecFailures ?? 0 };
    };
    const searchPath = process.env.PATH ?? '';
    const gateOne = async (directory: string, file: string, acceptedCount: number) => {
      const raw = await readDeclarationFile(directory, file);
      return gateDeclaration(raw, {
        homeDir: this.homeDir,
        acceptedCount,
        searchPath,
        probe: (canonical, toolClass) => this.probeBinary(canonical, toolClass),
      });
    };
    let accepted = 0;
    const pendingFiles = await this.listDeclarations(dirs.pending);
    const activeFiles = await this.listDeclarations(dirs.active);
    // M2: reserve budget for on-disk active files, so pending work beyond the
    // 20-tool cap is refused without any probe. M1: a pending declaration
    // whose name already maps to an active record is refused as a bad name;
    // the active tool and its file stay untouched. A stale prior-active entry
    // whose file was deleted self-heals on the following rescan; the pending
    // file is preserved, never promoted over it. Cold start included: on-disk
    // active names are reserved before the pending pass, when memory is empty.
    let pendingBudget = Math.max(0, toolCountLimit - activeFiles.length);
    const priorActive = (name: string): boolean => this.tools.get(name)?.status === 'active';
    // Cold-start reservation: on-disk active declarations reserve their names
    // before the pending pass, so a clashing pending file can never promote
    // and clobber the active file via rename — even when in-memory state is
    // empty. Names come from file content (filename on read failure); content
    // is fully re-gated in the active pass below.
    const reservedActiveNames = new Set<string>();
    for (const file of activeFiles) {
      try {
        reservedActiveNames.add(displayName(await readDeclarationFile(dirs.active, file), file));
      } catch {
        reservedActiveNames.add(this.fileNameHint(file));
      }
    }
    const notePendingFailure = (file: string, raw: unknown, message: string) => {
      const name = displayName(raw, file);
      // A refused file that shares its name with a live or already-noted
      // record is keyed by filename so the later active pass cannot overwrite
      // it; both entries stay visible in status under the same tool name.
      const key = (next.has(name) || priorActive(name) || reservedActiveNames.has(name)) ? `file:${file}` : name;
      next.set(key, {
        decl: this.pendingDeclHint(name, next.get(name) ?? this.tools.get(name)),
        status: 'pending',
        reasonCode: reasonCodeForGateError(message),
        ...keep(name),
      });
    };
    for (const file of pendingFiles) {
      if (pendingBudget <= 0) {
        const raw = await readDeclarationFile(dirs.pending, file).catch(() => undefined);
        notePendingFailure(file, raw, localToolGateMessages.limitReached);
        continue;
      }
      const raw = await readDeclarationFile(dirs.pending, file).catch(() => undefined);
      let gated: GatedDeclaration;
      try {
        if (raw === undefined) throw new Error(localToolGateMessages.unreadable);
        gated = await gateDeclaration(raw, {
          homeDir: this.homeDir,
          acceptedCount: activeFiles.length + accepted,
          searchPath,
          probe: (canonical, toolClass) => this.probeBinary(canonical, toolClass),
        });
        if (next.has(gated.name) || priorActive(gated.name) || reservedActiveNames.has(gated.name)) {
          throw new Error(localToolGateMessages.badName);
        }
      } catch (error) {
        notePendingFailure(file, raw, error instanceof Error ? error.message : '');
        continue;
      }
      accepted += 1;
      pendingBudget -= 1;
      try {
        await rename(join(dirs.pending, file), join(dirs.active, `${gated.name}.json`));
      } catch {
        next.set(gated.name, { decl: gated, status: 'pending', ...keep(gated.name) });
        continue;
      }
      next.set(gated.name, { decl: gated, status: 'active', ...keep(gated.name) });
    }
    for (const file of activeFiles) {
      const existing = next.get(this.fileNameHint(file));
      if (existing?.status === 'active') continue;
      let gated: GatedDeclaration;
      try {
        gated = await gateOne(dirs.active, file, accepted);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const code = reasonCodeForGateError(message);
        const record: ToolRecord = {
          decl: this.activeDeclHint(file, next),
          status: 'quarantined',
          reasonCode: code,
          ...keep(this.fileNameHint(file)),
        };
        try {
          await writePrivateJson(join(dirs.quarantined, `${record.decl.name}.reason.json`),
            { code, at: new Date().toISOString() });
          await rename(join(dirs.active, file), join(dirs.quarantined, `${record.decl.name}.json`));
        } catch {
          record.quarantinePending = true;
          this.quarantinePending.add(record.decl.name);
          console.error(`Local tool quarantine rename failed for ${record.decl.name}; will retry.`);
        }
        // L1: a gate-fail quarantine surfaces via status AND activity_list
        // (counts/codes only — never file text, slot values or stderr).
        await this.deps.recordActivity({
          actor, operation: 'local-tool-quarantine', workspaceId: null,
          detail: `${record.decl.name} → quarantined (${code})`,
        }).catch(error => {
          console.error('Activity record failed:', error instanceof Error ? error.message : error);
        });
        next.set(record.decl.name, record);
        continue;
      }
      accepted += 1;
      next.set(gated.name, { decl: gated, status: 'active', ...keep(gated.name) });
    }
    for (const file of await this.listDeclarations(dirs.quarantined)) {
      const name = this.fileNameHint(file);
      if (next.has(name)) continue;
      let reasonCode: LocalToolReasonCode | undefined;
      try {
        const bytes = await readFile(join(dirs.quarantined, `${name}.reason.json`), 'utf8');
        const code = (JSON.parse(bytes) as { code?: unknown }).code;
        if (code === 'gate-shape' || code === 'gate-executable' || code === 'gate-inputs'
          || code === 'gate-limits' || code === 'gate-provenance' || code === 'gate-description'
          || code === 'runtime-failures') reasonCode = code;
      } catch {
        reasonCode = undefined;
      }
      let gated: GatedDeclaration | undefined;
      try {
        // Quarantined files are never re-activated by a rescan (human moves
        // them to pending/ for re-gate), so the count cap does not apply here.
        gated = await gateOne(dirs.quarantined, file, 0);
      } catch {
        gated = undefined;
      }
      if (!gated) continue;
      next.set(name, {
        decl: gated,
        status: 'quarantined',
        reasonCode,
        ...keep(name),
        ...(this.quarantinePending.has(name) ? { quarantinePending: true as const } : {}),
      });
    }
    for (const name of this.quarantinePending) {
      if ([...next.values()].some(record => record.decl.name === name)) continue;
      const prior = this.tools.get(name);
      if (prior) next.set(name, { ...prior, status: 'quarantined', quarantinePending: true });
    }
    this.tools = next;
  }

  private fileNameHint(file: string): string {
    return file.slice(0, -'.json'.length);
  }

  private pendingDeclHint(name: string, prior: ToolRecord | undefined): GatedDeclaration {
    if (prior) return prior.decl;
    return {
      name, description: '', executable: '', slots: {}, statement: '', maxRows: 50,
      origin: 'handwritten', createdAt: new Date(0).toISOString(),
      className: '', canonical: '', available: false,
    };
  }

  private activeDeclHint(file: string, next: Map<string, ToolRecord>): GatedDeclaration {
    const existing = next.get(this.fileNameHint(file)) ?? this.tools.get(this.fileNameHint(file));
    if (existing) return existing.decl;
    return this.pendingDeclHint(this.fileNameHint(file), undefined);
  }

  snapshot(): LocalToolStatusEntry[] {
    return [...this.tools.values()]
      .sort((a, b) => a.decl.name.localeCompare(b.decl.name))
      .map(record => ({
        name: record.decl.name,
        status: record.status,
        available: record.status === 'active' ? record.decl.available : false,
        description: record.decl.description,
        slots: record.decl.slots,
        ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
        origin: record.decl.origin,
        createdAt: record.decl.createdAt,
        useCount: record.useCount,
        ...(record.lastUseAt ? { lastUseAt: record.lastUseAt } : {}),
        consecFailures: record.consecFailures,
        ...(record.quarantinePending ? { quarantinePending: true as const } : {}),
      }));
  }

  /** Execute one active tool. Throws only closed-vocabulary safe messages. */
  async call(
    workspaceId: string,
    workspaceRoots: string[],
    body: unknown,
    options: { actor?: 'dashboard' | 'mcp' } = {},
  ): Promise<DatastoreQueryResult> {
    const actor = options.actor ?? 'mcp';
    const parsed = localToolCallBodySchema.safeParse(body);
    if (!parsed.success) throw new Error(localToolCallMessages.invalidCall);
    const record = this.tools.get(parsed.data.tool);
    if (!record || record.status !== 'active') throw new Error(localToolCallMessages.notAvailable);
    const decl = record.decl;
    const toolClass = localToolClasses[decl.className];
    if (!toolClass) throw new Error(localToolCallMessages.notAvailable);
    let values: Record<string, unknown>;
    try {
      values = z.object(slotValueSchemas(decl.slots)).strict().parse(parsed.data.inputs);
    } catch {
      // The ZodError is caught at this translation boundary and replaced;
      // raw zod text and paths never leave the server (G3).
      throw new Error(localToolCallMessages.invalidInputs);
    }
    try {
      checkSlotValues(decl, values);
    } catch {
      throw new Error(localToolCallMessages.invalidInputs);
    }
    // Per-invocation canonical re-resolution: re-verification failure or a
    // canonical-path change is honest-unavailable, never a bare-name fallback.
    const canonical = await resolveCanonicalBinary(toolClass.binary, process.env.PATH ?? '');
    if (!canonical || canonical !== decl.canonical) {
      throw new Error('PostgreSQL client is unavailable.');
    }
    try {
      const outcome = await runDatastoreQuery(workspaceRoots, {
        database: values['database'],
        role: values['role'],
        sql: decl.statement,
        maxRows: decl.maxRows,
      }, { run: this.run, executablePath: canonical });
      // Output passes through the shared secret masker (cells and headers);
      // hostile text stays inert display text, never re-executed.
      const masked: DatastoreQueryResult = {
        ...outcome,
        columns: outcome.columns.map(maskSecrets),
        rows: outcome.rows.map(row => row.map(cell => cell === null ? null : maskSecrets(cell))),
      };
      // R1 reset rule: a call whose query stage completes successfully resets
      // consecFailures to 0; a successful probe alone does not reset.
      record.consecFailures = 0;
      record.useCount += 1;
      record.lastUseAt = new Date().toISOString();
      await this.deps.recordActivity({
        actor, operation: 'local-tool-call', workspaceId, detail: `${decl.name} → ${masked.rowCount} rows`,
      }).catch(error => {
        console.error('Activity record failed:', error instanceof Error ? error.message : error);
      });
      return masked;
    } catch (error) {
      // G5 classification: ONLY query-stage failures increment the quarantine
      // counter. Connect/probe-stage failures, caller-side slot refusals and
      // run-time unavailable (however staged) never increment.
      const stage = datastoreErrorStage(error);
      const message = error instanceof Error ? error.message : '';
      if (stage === 'query' && message !== 'PostgreSQL client is unavailable.') {
        record.consecFailures += 1;
        if (record.consecFailures >= quarantineThreshold) {
          await this.quarantineForRuntimeFailures(workspaceId, actor, record);
        }
      }
      throw error;
    }
  }

  private async quarantineForRuntimeFailures(
    workspaceId: string,
    actor: 'dashboard' | 'mcp',
    record: ToolRecord,
  ): Promise<void> {
    const dirs = this.directories();
    const name = record.decl.name;
    // Drop the in-memory registration FIRST so the tool stops immediately,
    // then persist the rename; a rename failure retries on the next rescan.
    this.tools.delete(name);
    const reason = { code: 'runtime-failures' as const, at: new Date().toISOString(), failures: record.consecFailures };
    let pending = false;
    try {
      await writePrivateJson(join(dirs.quarantined, `${name}.reason.json`), reason);
      await rename(join(dirs.active, `${name}.json`), join(dirs.quarantined, `${name}.json`));
    } catch (error) {
      pending = true;
      this.quarantinePending.add(name);
      console.error(`Local tool quarantine rename failed for ${name}; will retry.`,
        error instanceof Error ? error.message : error);
    }
    this.tools.set(name, {
      ...record,
      status: 'quarantined',
      reasonCode: 'runtime-failures',
      ...(pending ? { quarantinePending: true as const } : {}),
    });
    await this.deps.recordActivity({
      actor, operation: 'local-tool-quarantine', workspaceId, detail: `${name} → quarantined`,
    }).catch(error => {
      console.error('Activity record failed:', error instanceof Error ? error.message : error);
    });
  }
}
