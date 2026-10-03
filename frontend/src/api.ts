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

export interface ServiceActionResult {
  action: 'restart' | 'stop';
  target: { pmId: number; name: string; namespace: string | null };
  status: 'completed' | 'failed' | 'unknown';
  serviceStatus: string | null;
  message: string;
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
  git: {
    revision: string | null;
    revisionState: 'observed' | 'unknown';
    worktree: 'clean' | 'dirty' | 'unknown';
    changedEntries: number | null;
    /** Dirty-state fingerprint (content hash plus path names only); null/absent when clean or degraded. */
    dirty?: { diffHash: string; files: string[]; truncated: boolean } | null;
  };
  service: { pmId: number; name: string; namespace: string | null; status: string } | null;
  message: string;
}

export interface VerificationRequest {
  repositoryPath: string;
  scriptName: string;
  service?: { pmId: number | null; name: string; namespace?: string | null };
}

export interface WorkstreamCheckout {
  root: string;
  revision: string | null;
  revisionState: 'observed' | 'unknown';
  observedAt: string;
}

export interface Workstream {
  id: string;
  name: string;
  workspaceId: string;
  checkouts: WorkstreamCheckout[];
  status: 'active' | 'paused' | 'done';
  createdAt: string;
  updatedAt: string;
}

export interface Lease {
  resource: string;
  workstreamId: string;
  status: 'held' | 'queued';
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
  | { status: 'cancelled' | 'unavailable' | 'timeout' | 'error' };

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
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeId(id: string) {
  if (!workspaceIdPattern.test(id)) throw new ApiError('The workspace identifier is invalid.');
  return encodeURIComponent(id);
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
        'X-OpenWorkspace-Intent': 'connect-dashboard',
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
  inspect(workspaceId: string) { return this.request<Inspection>(`/api/workspaces/${safeId(workspaceId)}`); }
  register(name: string, roots: string[]) { return this.request<Workspace>('/api/workspaces', { name, roots }); }
  updateRoots(workspaceId: string, roots: string[]) {
    return this.request<Workspace>(`/api/workspaces/${safeId(workspaceId)}/roots`, { roots }, { intent: 'update-workspace-roots' });
  }
  remove(workspaceId: string) {
    return this.request<{ removed: true }>(`/api/workspaces/${safeId(workspaceId)}`, undefined, { method: 'DELETE', intent: 'remove-workspace' });
  }
  async projectRootPicker(signal: AbortSignal): Promise<ProjectRootPickerResult> {
    const result = await this.request<ProjectRootPickerResult>('/api/project-root-picker', {}, {
      timeoutMs: 305_000,
      signal,
      intent: 'select-project-roots',
    });
    if (typeof result !== 'object' || result === null || !['selected', 'cancelled', 'unavailable', 'timeout', 'error'].includes(result.status)) {
      throw new ApiError('The local folder picker returned an invalid response.');
    }
    if (result.status === 'selected' && (!Array.isArray(result.roots) || result.roots.some(root => typeof root !== 'string'))) {
      throw new ApiError('The local folder picker returned invalid folder paths.');
    }
    return result;
  }
  services(workspaceId: string) { return this.request<ServiceInventory>(`/api/workspaces/${safeId(workspaceId)}/services`, {}, { intent: 'inspect-services' }); }
  serviceAction(workspaceId: string, action: 'restart' | 'stop', target: { pmId: number | null; name: string; namespace?: string | null }) {
    return this.request<ServiceActionResult>(`/api/workspaces/${safeId(workspaceId)}/services/${action}`, target, { intent: 'control-service' });
  }
  verify(workspaceId: string, verification: VerificationRequest) {
    return this.request<VerificationResult>(`/api/workspaces/${safeId(workspaceId)}/verify`, verification, { intent: 'run-verification', timeoutMs: 170_000 });
  }
  workstreams() { return this.request<Workstream[]>('/api/workstreams'); }
  workstream(id: string) { return this.request<Workstream>(`/api/workstreams/${safeId(id)}`); }
  createWorkstream(input: { name: string; workspaceId: string; checkouts: string[] }) {
    return this.request<Workstream>('/api/workstreams', input, { intent: 'create-workstream' });
  }
  setWorkstreamStatus(id: string, status: Workstream['status']) {
    return this.request<Workstream>(`/api/workstreams/${safeId(id)}/status`, { status }, { intent: 'update-workstream' });
  }
  leases() { return this.request<Lease[]>('/api/leases'); }
  acquireLease(resource: string, workstreamId: string) {
    return this.request<{ lease: Lease; position: number }>('/api/leases/acquire', { resource, workstreamId }, { intent: 'acquire-lease' });
  }
  releaseLease(resource: string, workstreamId: string) {
    return this.request<{ released: boolean; promoted: string | null }>('/api/leases/release', { resource, workstreamId }, { intent: 'release-lease' });
  }
  activity() { return this.request<ActivityEntry[]>('/api/activity'); }
  learnings() { return this.request<Learnings>('/api/learnings'); }
  recentRuns(scope: string, limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 20;
    return this.request<RunListEntry[]>(`/api/runs/recent?scope=${safeId(scope)}&limit=${bounded}`);
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
          'X-OpenWorkspace-Intent': 'disconnect-dashboard',
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
    intent?: string;
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
        ...(options.intent ? { 'X-OpenWorkspace-Intent': options.intent } : {}),
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
