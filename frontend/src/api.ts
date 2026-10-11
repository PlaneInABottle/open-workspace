export interface Workspace {
  id: string;
  name: string;
  roots: string[];
  createdAt: string;
}

export interface Overview {
  workspaces: Workspace[];
  milestone: string;
  limits: string[];
}

/**
 * Minimal read-only projection of the backend environment topology
 * (GET /api/workspaces/:name/environments returns EnvironmentRecord[]).
 * Absolute repository paths exist on the wire but are deliberately not
 * declared here: the dashboard never renders them.
 */
export interface EnvironmentServiceTopology {
  id: string;
  name?: string;
  port: number | null;
  dependsOn: string[];
  readiness: { kind: 'http-200'; path: string; timeoutSecs: number } | { kind: 'process-alive' };
}

export interface EnvironmentLastPoll {
  status: 'ready' | 'starting' | 'failed' | 'skipped';
  attempts: number;
  httpStatus: number | null;
  checkedAt: string;
}

export interface EnvironmentRecord {
  id: string;
  name: string;
  services: EnvironmentServiceTopology[];
  state: 'down' | 'partial' | 'up';
  updatedAt: string;
  createdAt?: string;
}

/**
 * Minimal read-only projection of GET
 * /api/workspaces/:name/environments/status?environment=X. Status vocabulary
 * (down/starting/ready/failed/skipped/stale) and the per-entry detail line
 * come straight from the backend; the owned projection keeps only the
 * identity plus the last readiness poll (the up/down receipt summary).
 */
export interface ServiceStatusEntry {
  serviceId: string;
  name: string;
  status: 'down' | 'starting' | 'ready' | 'failed' | 'skipped' | 'stale';
  detail: string;
  owned: { serviceId: string; name: string; lastPoll: EnvironmentLastPoll | null } | null;
}

export interface EnvironmentStatus {
  environmentId: string;
  name: string;
  state: 'down' | 'partial' | 'up';
  order: string[];
  services: ServiceStatusEntry[];
}

// ---------------------------------------------------------------------------
// Coordinator snapshot (GET /api/workspaces/:name/coordinator?environment=X,
// dashboard-only). Read-only P1 reconcile + P2 preflight + P3 checkpoints +
// P4 explanation + P5 scenarios aggregate. Free text arrives server-masked;
// absolute paths arrive as basenames only (probe argv and scenario targets
// never leave the file). Full revs travel on the wire for the copy-button
// clipboard payload only — they are never rendered (short-hash + badges +
// age on screen).
// ---------------------------------------------------------------------------

export interface CoordinatorDrift {
  service: string;
  field: string;
  expected: string;
  actual: string;
}

export interface CoordinatorReadinessEntry {
  serviceId: string;
  name: string;
  /** Kayıtlı kökün dizin adı — tam path asla wire'a girmez. */
  dir: string | null;
  status: string;
  detail: string;
  lastPoll: EnvironmentLastPoll | null;
  /** Worktree identity (additive-optional): carried only when >1 root is registered. */
  worktree?: { rootBase: string; revShort: string | null };
}

export interface CoordinatorPreflightGate {
  service: string;
  port: number | null;
  free: boolean;
  note: string;
}

export interface CoordinatorPreflight {
  pass: boolean;
  gates: CoordinatorPreflightGate[];
  missing: string[];
}

export interface CoordinatorMeta {
  producedAt: string;
  snapshotId: string;
  environment: string;
}

export type CheckpointStageStatus = 'confirmed' | 'not_observed' | 'stale';

export interface CoordinatorCheckpointStage {
  stage: string;
  status: CheckpointStageStatus;
  staleReason: string | null;
  /** Zarf kayıt saati (stage yaşı kaynağı). */
  at: string;
  /** M-A (#2): ham İngilizce bayrak (`null` ≡ eksik → `bilinmiyor`). */
  sideEffect: string | null;
  sideEffectAttempted: number | null;
  sideEffectConfirmed: number | null;
  /** M-A (#3): soy (ikisi de `null` → sahipsiz, ağaç-dışı). */
  scenario: string | null;
  attempt: number | null;
  stepSignature: string | null;
}

export interface CoordinatorCheckpoints {
  run: string;
  /** Keşfedilen run adları (yeni→eski); ?run= seçimi buradan yapılır. */
  runs: string[];
  stages: CoordinatorCheckpointStage[];
  summary: { confirmed: number; stale: number; notObserved: number };
  lastVerified: { stage: string; at: string } | null;
  firstGap: { stage: string; status: CheckpointStageStatus; staleReason: string | null; at: string } | null;
  /** Salt-metin öneri — butona bağlanmaz. */
  safeNextAction: string | null;
  /** M-A (#2): true → kilitli `tekrar-öncesi` metni (eylem yok). */
  retryHint: boolean;
}

export interface CoordinatorRevision {
  /** Ekrandaki tek temsil (7 karakter). */
  short: string;
  /** YALNIZCA kopyala-butonu clipboard payload'ı — DOM'a yazılmaz. */
  full: string;
  at: string | null;
  current: boolean;
  recorded: boolean;
}

export interface CoordinatorExplanationEntry {
  service: string;
  expected: { cmd: string | null; dir: string | null; port: number | null } | null;
  running: { status: string; detail: string } | null;
  revShort: string | null;
  revFull: string | null;
  revAt: string | null;
  revDirty: boolean;
  revRecorded: boolean;
  diffs: string[];
  note: string;
  /** M-C derleme kimliği (indirgenmiş: maskeli-basename + kısa-8). */
  artifacts: { base: string; digest: string }[];
  artifactRest: number;
}

export interface CoordinatorExplanation {
  entries: CoordinatorExplanationEntry[];
  revisions: CoordinatorRevision[];
}

export type ScenarioVerdict = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';

export interface ScenarioMatrixRow {
  name: string;
  services: string[];
  unverifiedServices: string[];
  /** YALNIZCA id + timeout: probe argv dosyada kalır, wire'a çıkmaz. */
  probes: { id: string; timeout: string }[];
  checkpoints: string[];
  /** Sütun adından hücre hükmüne (sıra `columns` dizisindedir). */
  cells: Record<string, ScenarioVerdict>;
}

export interface CoordinatorScenarios {
  /** Dosya adı (path değil) — köklerde hep `ow.scenarios.yaml`. */
  file: string;
  columns: string[];
  rows: ScenarioMatrixRow[];
  warnings: string[];
  /** Bozuk dosya: satırlar boş + neden burada (diğer paneller sağlam). */
  error: string | null;
}

/** Readiness-strip chip: masked boundary name + rolled-up cell verdict. */
export type BoundaryChipStatus = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';
export interface CoordinatorBoundaryChip {
  boundary: string;
  status: BoundaryChipStatus;
}

/** Readiness-strip last-run line: selected run id, last verified time
 * (null when nothing verified), and the all-green verdict. */
export interface CoordinatorLastRun {
  id: string;
  at: string | null;
  pass: boolean;
}

/** Readiness-strip gate line: preflight pass + missing entries. */
export interface CoordinatorReadinessGate {
  pass: boolean;
  missing: string[];
}

/** Ownership ledger row: read-only identity per registered root +
 * lock + recorded services. Missing `worktrees` is the "no record" branch. */
export interface CoordinatorWorktreeEntry {
  rootBase: string;
  revShort: string | null;
  branch: string | null;
  lock: 'live' | 'stale' | 'absent' | 'corrupt' | 'unknown';
  liveServices: string[];
  state: 'ok' | 'missing' | 'corrupt' | 'bad-version';
}

export interface CoordinatorSnapshot {
  reconcile: { inSync: boolean; drifts: CoordinatorDrift[] };
  readiness: CoordinatorReadinessEntry[];
  explanation: CoordinatorExplanation | null;
  preflight: CoordinatorPreflight;
  checkpoints: CoordinatorCheckpoints | null;
  /**
   * Keşfedilen checkpoint run adları (yeni→eski) — checkpoints null iken
   * bile dolu olabilir; null dalındaki çalışma seçici buradan beslenir.
   */
  runs: string[];
  /**
   * Dosya yoksa null ("senaryo dosyası bağlı değil"); bozuk dosya
   * error'lu nesne (hata kutusu).
   */
  scenarios: CoordinatorScenarios | null;
  /** Readiness strip (M8, additive-optional): absent without a bound
   * scenarios file - the strip renders the `unmeasured` placeholder. */
  boundaryList?: CoordinatorBoundaryChip[];
  lastRun?: CoordinatorLastRun | null;
  readinessGate?: CoordinatorReadinessGate | null;
  /** Ownership ledger — absence is the "no record" branch (single-root wire). */
  worktrees?: CoordinatorWorktreeEntry[];
  warnings: string[];
  meta: CoordinatorMeta;
}

export interface ActivityEntry {
  at: string;
  actor: 'dashboard' | 'mcp';
  operation: string;
  workspaceId: string | null;
  detail: string;
}

// ---------------------------------------------------------------------------
// Observer surface (GET /api/observer/*). Contracts mirror the ow --json
// envelopes (stable English keys). Excerpts are served raw as stored:
// dev-only loopback surface, personal use.
// ---------------------------------------------------------------------------

export interface ObserverSessionInfo {
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

export interface ObserverGroupedLine {
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

export interface ObserverTaskGroup {
  taskRef: string;
  taskRefKind: 'user' | 'briefing' | 'none';
  taskRefAgent: string | null;
  runs: number;
  fails: number;
  lines: ObserverGroupedLine[];
}

export interface ObserverSpawnLink {
  childSessionID: string;
  agent: string | null;
  description: string | null;
  time: number;
}

export interface ObserverTreeNodeDetail {
  title: string;
  titleKind: 'user' | 'briefing' | 'other';
  agent: string | null;
  records: number;
  /** True when the session has message rows but zero window records
   * (pre-recording-era work). Absent on degraded/older payloads. */
  hasMessages?: boolean;
  orphan: boolean;
}

export interface ObserverTreeNode {
  sessionID: string;
  link: ObserverSpawnLink | null;
  children: ObserverTreeNode[];
  /** Enriched row metadata; absent on degraded payloads (falls back to id). */
  detail?: ObserverTreeNodeDetail;
}

export interface ObserverStuckReport {
  retries: { signature: string; runs: number; fails: number }[];
  rereads: { path: string; agent: string; reads: number; depth: number }[];
  slow: { ms: number; command: string }[];
  interruptions: number;
  compactions: number;
  afterInterrupt: string[];
}

export interface ObserverSessionMeta {
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

export interface ObserverReadStat {
  path: string;
  reads: number;
  agents: string[];
  ranges: string[];
}

export interface ObserverDoctorLine {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ObserverMistakeRow {
  sessionID: string;
  at: string | null;
  taskRef: string | null;
  taskRefKind: 'user' | 'briefing' | 'none';
  signature: string;
  outcome: string;
  failReason: string | null;
  excerpt: string | null;
  agent: string | null;
}

export interface ObserverPrompt {
  text: string;
  kind: 'user' | 'briefing';
}

export interface ObserverCostRow {
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

export interface ObserverStuckEntry {
  session: string;
  report: ObserverStuckReport;
}

export interface ClientConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const legacyPairingStorageKey = 'openworkspace.pairing';
const legacyDashboardSessionStorageKey = 'openworkspace.dashboard-session';

function safeName(name: string) {
  if (typeof name !== 'string') throw new ApiError('The workspace name is invalid.');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100 || /[/\0-\x1f\x7f-\x9f]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new ApiError('The workspace name is invalid.');
  }
  return encodeURIComponent(name);
}

function observerParams(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  return search.toString();
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(private readonly storage: StorageLike = window.sessionStorage) {
    // Past connect-flow state is inert: clear any stored legacy credentials so
    // a stale tab token can never be sent again.
    storage.removeItem(legacyPairingStorageKey);
    storage.removeItem(legacyDashboardSessionStorageKey);
  }

  overview() { return this.request<Overview>('/api/overview'); }
  clientConfig() { return this.request<ClientConfig>('/api/client-config'); }
  remove(workspace: string) {
    return this.request<{ removed: true }>(`/api/workspaces/${safeName(workspace)}`, undefined, { method: 'DELETE' });
  }
  activity() { return this.request<ActivityEntry[]>('/api/activity'); }
  /** Read-only environment topology for one project (M1 topology + store). */
  environments(workspace: string) {
    return this.request<EnvironmentRecord[]>(`/api/workspaces/${safeName(workspace)}/environments`);
  }
  /** Read-only live status for one named environment. */
  environmentStatus(workspace: string, environment: string) {
    const params = new URLSearchParams({ environment });
    return this.request<EnvironmentStatus>(`/api/workspaces/${safeName(workspace)}/environments/status?${params}`);
  }
  /** Read-only coordinator snapshot for one named environment; `run` selects a checkpoint run (absent = latest). */
  coordinator(workspace: string, environment: string, run?: string) {
    const params = new URLSearchParams({ environment });
    if (run !== undefined && run.trim().length > 0) params.set('run', run);
    return this.request<CoordinatorSnapshot>(`/api/workspaces/${safeName(workspace)}/coordinator?${params}`);
  }

  // Observer reads (GET /api/observer/*, dashboard role only).
  observerDoctor() { return this.request<{ checks: ObserverDoctorLine[]; warnings: string[] }>('/api/observer/doctor'); }
  observerSessions(params: { since?: string; dir?: string; kind?: string } = {}) {
    return this.request<{ sessions: ObserverSessionInfo[]; warnings: string[] }>(`/api/observer/sessions?${observerParams(params)}`);
  }
  observerMeta(sessionID: string) {
    return this.request<{ meta: ObserverSessionMeta | null; warning: string | null; warnings: string[] }>(`/api/observer/sessions/${encodeURIComponent(sessionID)}/meta`);
  }
  observerRecords(sessionID: string, params: { since?: string; kind?: string; tool?: string; tree?: boolean; failsOnly?: boolean } = {}) {
    return this.request<{ session: string; warnings: string[]; groups: ObserverTaskGroup[]; tree?: ObserverTreeNode }>(
      `/api/observer/sessions/${encodeURIComponent(sessionID)}/records?${observerParams(params)}`,
    );
  }
  observerStuck(sessionID: string, params: { since?: string; tree?: boolean } = {}) {
    return this.request<{ session: string; warnings: string[]; report: ObserverStuckReport }>(
      `/api/observer/sessions/${encodeURIComponent(sessionID)}/stuck?${observerParams(params)}`,
    );
  }
  observerStuckGlobal(params: { since?: string } = {}) {
    return this.request<{ entries: ObserverStuckEntry[]; warnings: string[] }>(`/api/observer/stuck?${observerParams(params)}`);
  }
  observerMistakes(params: { since?: string; session?: string; agent?: string; limit?: number } = {}) {
    return this.request<{ rows: ObserverMistakeRow[]; warnings: string[] }>(`/api/observer/mistakes?${observerParams(params)}`);
  }
  observerPrompts(sessionID: string) {
    return this.request<{ session: string; prompts: ObserverPrompt[]; warnings: string[] }>(`/api/observer/sessions/${encodeURIComponent(sessionID)}/prompts`);
  }
  observerReads(sessionID: string, params: { since?: string } = {}) {
    return this.request<{ session: string; reads: ObserverReadStat[]; warnings: string[] }>(
      `/api/observer/sessions/${encodeURIComponent(sessionID)}/reads?${observerParams(params)}`,
    );
  }
  observerCost(params: { since?: string; limit?: number } = {}) {
    return this.request<{ rows: ObserverCostRow[]; warnings: string[] }>(`/api/observer/cost?${observerParams(params)}`);
  }

  private async request<T>(path: string, data?: unknown, options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    method?: string;
  } = {}): Promise<T> {
    // Dev-only open loopback: no browser credential is stored or sent. The
    // server's loopback Host/Origin/fetch-metadata gate is the boundary; a
    // 401 here means a stale bearer was supplied (e.g. an MCP token on a
    // dashboard-only route), never an expired browser session.
    const response = await fetch(path, {
      method: options.method ?? (data === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)])
        : AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? result.error : 'The request could not be completed.';
      throw new ApiError(message, response.status);
    }
    return result as T;
  }
}
