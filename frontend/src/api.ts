export interface Workspace {
  id: string;
  name: string;
  roots: string[];
  createdAt: string;
}

export interface Capability {
  id: string;
  name: string;
  purpose: string;
  required: boolean;
  status: 'found' | 'missing';
  verified: false;
}

export interface Overview {
  workspaces: Workspace[];
  capabilities: Capability[];
  milestone: string;
  limits: string[];
}

export interface Repository {
  name: string;
  path: string;
  git: boolean;
  stack: string[];
  manifests: string[];
  instructions: string[];
  scriptNames: string[];
  composeFiles: string[];
  processState: 'not_connected';
  readiness: 'not_checked';
}

export interface Inspection {
  workspace: Workspace;
  target: { id: 'local'; kind: 'local' };
  roots: RootInspection[];
}

export interface RootInspection {
  path: string;
  repositories: Repository[];
  warnings: string[];
  unavailable: boolean;
  error?: string;
}

export interface ServiceRecord {
  name: string;
  pmId: number | null;
  namespace: string | null;
  status: string;
  cwd: string;
  restartCount: number;
  matchedRoots: string[];
  exactRootPath: string | null;
}

export interface ServiceInventory {
  inspectedAt: string;
  runner: 'pm2';
  available: boolean;
  error?: 'missing' | 'failed' | 'timeout' | 'invalid';
  processCount: number;
  matchedProcessCount: number;
  unmatchedProcessCount: number;
  services: ServiceRecord[];
  ambiguousServices: ServiceRecord[];
}

export interface WorkstreamCheckout {
  root: string;
  revision: string | null;
  revisionState: 'observed' | 'unknown';
  observedAt: string;
}

export interface CheckpointNote {
  goal: string;
  blocker: string;
  next: string;
  owner: 'agent' | 'user';
  at: string;
  evidence: string[];
}

export interface WorkstreamCompletionCheck {
  name: string;
  result: 'passed' | 'failed' | 'error';
  environment: string;
  evidenceIds: string[];
  evidenceSource: string;
  evidenceLabel: string;
}

export interface WorkstreamCompletion {
  assignmentId: string;
  completionId: string;
  outcome: 'passed' | 'blocked' | 'failed';
  revision: string | null;
  dirty: boolean | null;
  dirtyFingerprint: { diffHash: string; files: string[]; truncated: boolean } | null;
  checks: WorkstreamCompletionCheck[];
  recordedAt: string;
}

export interface Workstream {
  id: string;
  name: string;
  workspaceId: string;
  checkouts: WorkstreamCheckout[];
  status: 'active' | 'paused' | 'done';
  /** Latest checkpoint entry; absent on older server responses. */
  checkpointNote?: CheckpointNote | null;
  /** Append-only bounded history (oldest-first); absent on older server responses. */
  checkpointHistory?: CheckpointNote[];
  /** Independent bounded completion ring; absent on older server responses. */
  completions?: WorkstreamCompletion[];
  createdAt: string;
  updatedAt: string;
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

export interface Lease {
  resource: string;
  workstreamId: string;
  status: 'held' | 'queued';
  /** Renewal deadline for held leases; absent on older server responses. */
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  at: string;
  actor: 'dashboard' | 'mcp';
  operation: string;
  workspaceId: string | null;
  detail: string;
}

export interface MilestoneNote {
  at: string;
  text: string;
  source: string;
}

export interface Learnings {
  milestones: MilestoneNote[];
}

/**
 * Read-only projection of GET /api/lessons: lesson titles plus source file
 * refs only, never rule bodies. File refs are relative names (AGENTS.md,
 * skills/...) enforced server-side — never absolute paths.
 */
export interface LearnedLesson {
  title: string;
  file: string;
  measured: boolean;
  status: 'active' | 'suspect';
  recurrenceCount: number;
}

export interface RunListEntry {
  /** Stable opaque summary ID within its scope. Older servers omit it. */
  id?: string;
  workspaceId: string;
  scriptName: string;
  outcome: 'passed' | 'failed' | 'error';
  durationMs: number;
  at: string;
  failingNames: string[];
  failingTruncated: boolean;
  excerptPreview: string;
  excerptTruncated: boolean;
  outputTruncated: boolean;
  /** True when a checkpoint note in this scope references this run. Older servers omit it. */
  pinnedByNote?: boolean;
  /** Evidence source: executed here vs pasted on trust. Older fixtures may omit it. */
  source?: 'openworkspace-run' | 'external-import' | 'unknown-source';
  /** Distinct human wording for the source; never a verification claim for imports. */
  sourceLabel?: string;
  /** HEAD revision the run verified against, when observed. Older entries omit it. */
  revision?: string | null;
  /** Dirty-state fingerprint (content hash plus path names only); null/absent when clean or degraded. */
  dirty?: { diffHash: string; files: string[]; truncated: boolean } | null;
}

export type ProjectRootPickerResult =
  | { status: 'selected'; roots: string[] }
  // 'aborted' mirrors the server picker's disconnect/abort outcome
  // (project-root-picker.ts); the form treats it like a cancellation.
  | { status: 'cancelled' | 'unavailable' | 'timeout' | 'error' | 'aborted' };

export interface ProjectRootRequest {
  name: string;
  roots: string[];
}

export interface ClientConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const dashboardSessionStorageKey = 'openworkspace.dashboard-session';
const legacyPairingStorageKey = 'openworkspace.pairing';
const dashboardTokenPattern = /^[a-f0-9]{64}$/;

function safeName(name: string) {
  if (typeof name !== 'string') throw new ApiError('The workspace name is invalid.');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100 || /[/\0-\x1f\x7f-\x9f]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new ApiError('The workspace name is invalid.');
  }
  return encodeURIComponent(name);
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class SessionExpiredError extends ApiError {
  constructor(readonly invalidatedCurrentSession: boolean, readonly generationAfter: number) {
    super('Reconnect this browser to the local workspace.', 401);
    this.name = 'SessionExpiredError';
  }
}

export class ApiClient {
  private token: string;
  private generation = 0;
  private confirmed: boolean;

  constructor(private readonly storage: StorageLike = window.sessionStorage) {
    storage.removeItem(legacyPairingStorageKey);
    const stored = storage.getItem(dashboardSessionStorageKey) || '';
    this.token = dashboardTokenPattern.test(stored) ? stored : '';
    if (!this.token && stored) storage.removeItem(dashboardSessionStorageKey);
    this.confirmed = Boolean(this.token);
  }

  get sessionGeneration() { return this.generation; }
  get hasSession() { return Boolean(this.token); }
  get isConfirmed() { return this.confirmed; }

  isCurrent(generation: number) {
    return this.generation === generation;
  }

  beginConnection() {
    return this.clearSession();
  }

  async createDashboardSession(generation: number) {
    if (!this.isCurrent(generation)) return false;
    const response = await fetch('/api/dashboard-session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ consent: true }),
      signal: AbortSignal.timeout(12_000),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? result.error : 'The browser session could not be created. Retry when the local service is available.';
      throw new ApiError(message, response.status);
    }
    const value = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
    const dashboardToken = value.dashboardToken;
    const expiresAt = value.expiresAt;
    if (typeof dashboardToken !== 'string' || !dashboardTokenPattern.test(dashboardToken)
      || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new ApiError('The local service returned an invalid browser session.');
    }
    if (!this.isCurrent(generation)) {
      void this.revokeDashboardSession(dashboardToken);
      return false;
    }
    try {
      this.storage.setItem(dashboardSessionStorageKey, dashboardToken);
    } catch (error) {
      void this.revokeDashboardSession(dashboardToken);
      throw error;
    }
    this.token = dashboardToken;
    this.confirmed = true;
    return true;
  }

  clearIfCurrent(generation: number) {
    if (!this.isCurrent(generation)) return false;
    this.clearSession();
    return true;
  }

  clearSession() {
    this.storage.removeItem(dashboardSessionStorageKey);
    this.storage.removeItem(legacyPairingStorageKey);
    this.token = '';
    this.confirmed = false;
    this.generation++;
    return this.generation;
  }

  disconnectDashboard(): Promise<void> {
    const token = this.token;
    this.clearSession();
    return token ? this.revokeDashboardSession(token) : Promise.resolve();
  }

  overview() { return this.request<Overview>('/api/overview'); }
  clientConfig() { return this.request<ClientConfig>('/api/client-config'); }
  inspect(workspace: string) { return this.request<Inspection>(`/api/workspaces/${safeName(workspace)}`); }
  register(name: string, roots: string[]) { return this.request<Workspace>('/api/workspaces', { name, roots }); }
  updateRoots(workspace: string, roots: string[]) {
    return this.request<Workspace>(`/api/workspaces/${safeName(workspace)}/roots`, { roots });
  }
  remove(workspace: string) {
    return this.request<{ removed: true }>(`/api/workspaces/${safeName(workspace)}`, undefined, { method: 'DELETE' });
  }
  async projectRootPicker(signal: AbortSignal): Promise<ProjectRootPickerResult> {
    const result = await this.request<ProjectRootPickerResult>('/api/project-root-picker', {}, {
      timeoutMs: 305_000,
      signal,
    });
    if (typeof result !== 'object' || result === null || !['selected', 'cancelled', 'unavailable', 'timeout', 'error', 'aborted'].includes(result.status)) {
      throw new ApiError('The local folder picker returned an invalid response.');
    }
    if (result.status === 'selected' && (!Array.isArray(result.roots) || result.roots.some(root => typeof root !== 'string'))) {
      throw new ApiError('The local folder picker returned invalid folder paths.');
    }
    return result;
  }
  services(workspace: string) { return this.request<ServiceInventory>(`/api/workspaces/${safeName(workspace)}/services`, {}); }
  workstreams() { return this.request<Workstream[]>('/api/workstreams'); }
  workstream(workspace: string, workstream: string) {
    return this.request<Workstream>(`/api/workstreams/${safeName(workspace)}/${safeName(workstream)}`);
  }
  createWorkstream(input: { name: string; workspace: string; checkouts: string[] }) {
    return this.request<Workstream>('/api/workstreams', input);
  }
  setWorkstreamStatus(workspace: string, workstream: string, status: Workstream['status']) {
    return this.request<Workstream>(`/api/workstreams/${safeName(workspace)}/${safeName(workstream)}/status`, { status });
  }
  leases() { return this.request<Lease[]>('/api/leases'); }
  acquireLease(resource: string, workspace: string, workstream: string) {
    return this.request<{ lease: Lease; position: number }>('/api/leases/acquire', { resource, workspace, workstream });
  }
  releaseLease(resource: string, workspace: string, workstream: string) {
    return this.request<{ released: boolean; promoted: string | null }>('/api/leases/release', { resource, workspace, workstream });
  }
  activity() { return this.request<ActivityEntry[]>('/api/activity'); }
  learnings() { return this.request<Learnings>('/api/learnings'); }
  lessons() { return this.request<LearnedLesson[]>('/api/lessons'); }
  recentRuns(workspace: string, workstream: string | undefined, limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 20;
    const params = new URLSearchParams({ workspace, limit: String(bounded) });
    if (workstream !== undefined) params.set('workstream', workstream);
    return this.request<RunListEntry[]>(`/api/runs/recent?${params}`);
  }
  /** Read-only environment topology for one project (M1 topology + store). */
  environments(workspace: string) {
    return this.request<EnvironmentRecord[]>(`/api/workspaces/${safeName(workspace)}/environments`);
  }
  /** Read-only live status for one named environment. */
  environmentStatus(workspace: string, environment: string) {
    const params = new URLSearchParams({ environment });
    return this.request<EnvironmentStatus>(`/api/workspaces/${safeName(workspace)}/environments/status?${params}`);
  }

  private async revokeDashboardSession(token: string): Promise<void> {
    try {
      await fetch('/api/dashboard-session', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Local state is cleared immediately; the server session also has a fixed expiry.
    }
  }

  private async request<T>(path: string, data?: unknown, options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    method?: string;
  } = {}): Promise<T> {
    const generation = this.generation;
    const token = this.token;
    const response = await fetch(path, {
      method: options.method ?? (data === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)])
        : AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 401) {
      const invalidatedCurrentSession = generation === this.generation && token === this.token;
      if (invalidatedCurrentSession) this.clearSession();
      throw new SessionExpiredError(invalidatedCurrentSession, this.generation);
    }
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? result.error : 'The request could not be completed.';
      throw new ApiError(message, response.status);
    }
    return result as T;
  }
}
