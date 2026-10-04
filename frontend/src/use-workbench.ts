import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClient,
  ApiError,
  SessionExpiredError,
  type Capability,
  type ClientConfig,
  type EnvironmentRecord,
  type EnvironmentStatus,
  type Inspection,
  type ServiceInventory,
  type ActivityEntry,
  type LearnedLesson,
  type Lease,
  type Learnings,
  type RunListEntry,
  type Workspace,
  type Workstream,
} from './api';
import type { ProjectRequest } from './validation';

export type Notice = { kind: 'success' | 'error' | 'info'; message: string };
export type ConnectionPhase = 'disconnected' | 'connecting' | 'loading' | 'connected';

export interface WorkbenchState {
  phase: ConnectionPhase;
  workspaces: Workspace[];
  capabilities: Capability[];
  clientConfig: ClientConfig | null;
  selectedName: string | null;
  inspection: Inspection | null;
  inspectionError: string | null;
  inspectionLoading: boolean;
  services: ServiceInventory | null;
  servicesError: string | null;
  servicesLoading: boolean;
  workstreams: Workstream[];
  workstreamsError: string | null;
  workstreamsLoading: boolean;
  leases: Lease[];
  leasesError: string | null;
  environments: EnvironmentRecord[];
  environmentStatuses: Record<string, EnvironmentStatus>;
  environmentsLoading: boolean;
  environmentsError: string | null;
  activity: ActivityEntry[];
  activityLoading: boolean;
  learnings: Learnings;
  lessons: LearnedLesson[];
  runs: RunListEntry[];
  recordsLoading: boolean;
  recordsError: string | null;
  recordsUpdatedAt: string | null;
  refreshing: boolean;
  busyIds: ReadonlySet<string>;
  notice: Notice | null;
}

function initialState(phase: ConnectionPhase): WorkbenchState {
  return {
    phase,
    workspaces: [],
    capabilities: [],
    clientConfig: null,
    selectedName: null,
    inspection: null,
    inspectionError: null,
    inspectionLoading: false,
    services: null,
    servicesError: null,
    servicesLoading: false,
    workstreams: [],
    workstreamsError: null,
    workstreamsLoading: false,
    leases: [],
    leasesError: null,
    environments: [],
    environmentStatuses: {},
    environmentsLoading: false,
    environmentsError: null,
    activity: [],
    activityLoading: false,
    learnings: { milestones: [] },
    lessons: [],
    runs: [],
    recordsLoading: false,
    recordsError: null,
    recordsUpdatedAt: null,
    refreshing: false,
    busyIds: new Set(),
    notice: null,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The local service did not respond in time. Check that it is running, then retry.';
  }
  if (error instanceof TypeError) return 'Could not reach the local service. Check that it is running, then retry.';
  return 'The request could not be completed. Retry when the local service is available.';
}

function busyKeyForWorkspace(id: string) { return `workspace:${id}`; }

export function useWorkbench() {
  const [api] = useState(() => new ApiClient());
  const [state, setState] = useState(() => initialState(api.hasSession ? 'loading' : 'disconnected'));
  const stateRef = useRef(state);
  const refreshSequence = useRef(0);
  const mutationRevision = useRef(0);
  const inspectionSequence = useRef(0);
  const servicesSequence = useRef(0);
  const workstreamsSequence = useRef(0);
  const environmentsSequence = useRef(0);
  const recordsSequence = useRef(0);
  const selectionRevision = useRef(0);
  const selectedName = useRef<string | null>(null);

  const commit = useCallback((update: (current: WorkbenchState) => WorkbenchState) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const setNotice = useCallback((notice: Notice | null) => {
    commit(current => ({ ...current, notice }));
  }, [commit]);

  const resetPrivateState = useCallback((phase: ConnectionPhase, notice: Notice | null = null) => {
    refreshSequence.current++;
    mutationRevision.current++;
    inspectionSequence.current++;
    selectionRevision.current++;
    selectedName.current = null;
    commit(() => ({ ...initialState(phase), notice }));
  }, [commit]);

  const handleSessionExpired = useCallback((error: unknown) => {
    if (!(error instanceof SessionExpiredError)) return false;
    if (error.invalidatedCurrentSession && api.sessionGeneration === error.generationAfter) {
      resetPrivateState('disconnected', {
        kind: 'error',
        message: 'This browser session expired or the local service restarted. Connect this browser again to continue.',
      });
    }
    return true;
  }, [api, resetPrivateState]);

  const refresh = useCallback(async (session = api.sessionGeneration, keepRefreshing = false): Promise<boolean> => {
    if (!api.hasSession || !api.isCurrent(session)) return false;
    const request = ++refreshSequence.current;
    const revision = mutationRevision.current;
    commit(current => ({ ...current, refreshing: true, notice: null }));
    try {
      const [overview, clientConfig] = await Promise.all([api.overview(), api.clientConfig()]);
      if (!api.isCurrent(session) || request !== refreshSequence.current || revision !== mutationRevision.current) return false;

      const currentSelection = selectedName.current;
      const selectionExists = currentSelection !== null && overview.workspaces.some(workspace => workspace.name === currentSelection);
      if (currentSelection && !selectionExists) {
        selectedName.current = null;
        selectionRevision.current++;
        inspectionSequence.current++;
        servicesSequence.current++;
      }
      commit(current => ({
        ...current,
        phase: api.isConfirmed ? 'connected' : current.phase,
        workspaces: overview.workspaces,
        capabilities: overview.capabilities,
        clientConfig,
        selectedName: selectionExists ? currentSelection : null,
        inspection: selectionExists ? current.inspection : null,
        inspectionError: selectionExists ? current.inspectionError : null,
        inspectionLoading: selectionExists ? current.inspectionLoading : false,
        services: selectionExists ? current.services : null,
        servicesError: selectionExists ? current.servicesError : null,
        servicesLoading: selectionExists ? current.servicesLoading : false,
        refreshing: keepRefreshing,
      }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === refreshSequence.current && revision === mutationRevision.current) {
        commit(current => ({ ...current, refreshing: keepRefreshing, notice: { kind: 'error', message: errorMessage(error) } }));
      }
      return false;
    } finally {
      if (!keepRefreshing && api.isCurrent(session) && request === refreshSequence.current && revision === mutationRevision.current) {
        commit(current => current.refreshing ? { ...current, refreshing: false } : current);
      }
    }
  }, [api, commit, handleSessionExpired]);

  useEffect(() => {
    if (api.hasSession) void refresh();
  }, [api, refresh]);

  const connectDashboard = useCallback(async (): Promise<boolean> => {
    const session = api.beginConnection();
    resetPrivateState('connecting');
    try {
      if (!await api.createDashboardSession(session)) return false;
    } catch (error) {
      if (!api.isCurrent(session)) return false;
      api.clearIfCurrent(session);
      resetPrivateState('disconnected', { kind: 'error', message: errorMessage(error) });
      return false;
    }
    if (!api.isCurrent(session)) return false;
    commit(current => ({ ...current, phase: 'loading', notice: null }));
    return refresh(session);
  }, [api, commit, refresh, resetPrivateState]);

  const disconnect = useCallback(() => {
    const revocation = api.disconnectDashboard();
    resetPrivateState('disconnected', { kind: 'info', message: 'This browser tab is disconnected. Registered workspaces remain on this machine.' });
    void revocation;
  }, [api, resetPrivateState]);

  const loadActivity = useCallback(async () => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return false;
    commit(current => ({ ...current, activityLoading: true }));
    try {
      const trail = await api.activity();
      if (!api.isCurrent(session)) return false;
      commit(current => ({ ...current, activity: trail, activityLoading: false }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session)) {
        commit(current => ({ ...current, activityLoading: false }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const loadRecords = useCallback(async (workspace: string) => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return false;
    const request = ++recordsSequence.current;
    commit(current => ({ ...current, recordsLoading: true, recordsError: null }));
    try {
      const [learnings, runs, lessons] = await Promise.all([api.learnings(), api.recentRuns(workspace, undefined), api.lessons()]);
      if (!api.isCurrent(session) || request !== recordsSequence.current || selectedName.current !== workspace) return false;
      commit(current => ({
        ...current,
        learnings,
        lessons,
        runs,
        recordsLoading: false,
        recordsError: null,
        recordsUpdatedAt: new Date().toISOString(),
      }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === recordsSequence.current && selectedName.current === workspace) {
        commit(current => ({ ...current, recordsLoading: false, recordsError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const inspectProject = useCallback(async (workspace: string, preserveInspection = false) => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return false;
    const request = ++inspectionSequence.current;
    selectionRevision.current++;
    selectedName.current = workspace;
    commit(current => {
      const keepCurrent = preserveInspection
        && current.selectedName === workspace
        && current.inspection?.workspace.name === workspace;
      return {
        ...current,
        selectedName: workspace,
        inspection: keepCurrent ? current.inspection : null,
        inspectionError: null,
        inspectionLoading: true,
        services: keepCurrent ? current.services : null,
        servicesError: null,
        servicesLoading: false,
        workstreams: keepCurrent ? current.workstreams : [],
        workstreamsError: null,
        workstreamsLoading: false,
        leases: keepCurrent ? current.leases : [],
        leasesError: null,
        environments: keepCurrent ? current.environments : [],
        environmentStatuses: keepCurrent ? current.environmentStatuses : {},
        environmentsLoading: false,
        environmentsError: null,
        notice: null,
      };
    });
    try {
      const inspection = await api.inspect(workspace);
      if (!api.isCurrent(session) || request !== inspectionSequence.current || selectedName.current !== workspace) return false;
      commit(current => ({ ...current, inspection, inspectionLoading: false }));
      void listWorkstreamsFor(workspace, inspection.workspace.id, session);
      void listEnvironmentsFor(workspace, session);
      // Runs and activity also feed the setup signal, but neither is loaded
      // on the Project tab otherwise (runs via RecordsView mount, activity
      // via the setup view). Fetch both here — existing read-only endpoints,
      // no new backend — so the banner reflects all four signals.
      void loadRecords(workspace);
      void loadActivity();
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === inspectionSequence.current && selectedName.current === workspace) {
        commit(current => ({ ...current, inspectionLoading: false, inspectionError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired, loadActivity, loadRecords]);

  const inspectServices = useCallback(async (workspace: string) => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return false;
    const request = ++servicesSequence.current;
    commit(current => ({
      ...current,
      servicesLoading: true,
      servicesError: null,
    }));
    try {
      const services = await api.services(workspace);
      if (!api.isCurrent(session) || request !== servicesSequence.current || selectedName.current !== workspace) return false;
      commit(current => ({ ...current, services, servicesLoading: false }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === servicesSequence.current && selectedName.current === workspace) {
        commit(current => ({ ...current, servicesLoading: false, servicesError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const listWorkstreamsFor = useCallback(async (workspace: string, workspaceId: string, session: number) => {
    const request = ++workstreamsSequence.current;
    commit(current => ({ ...current, workstreamsLoading: true, workstreamsError: null }));
    try {
      const [workstreams, leases] = await Promise.all([api.workstreams(), api.leases()]);
      if (!api.isCurrent(session) || request !== workstreamsSequence.current || selectedName.current !== workspace) return false;
      commit(current => ({
        ...current,
        workstreamsLoading: false,
        workstreams: workstreams.filter(workstream => workstream.workspaceId === workspaceId),
        leases,
      }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === workstreamsSequence.current && selectedName.current === workspace) {
        commit(current => ({ ...current, workstreamsLoading: false, workstreamsError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const listEnvironmentsFor = useCallback(async (workspace: string, session: number) => {
    const request = ++environmentsSequence.current;
    commit(current => ({ ...current, environmentsLoading: true, environmentsError: null }));
    try {
      const records = await api.environments(workspace);
      // Read-only per-environment live status; a single failing environment
      // degrades to topology-only instead of failing the whole section.
      const settled = await Promise.all(records.map(record =>
        api.environmentStatus(workspace, record.name).catch(() => null),
      ));
      if (!api.isCurrent(session) || request !== environmentsSequence.current || selectedName.current !== workspace) return false;
      const statuses: Record<string, EnvironmentStatus> = {};
      settled.forEach((status, index) => {
        if (status) statuses[records[index].name] = status;
      });
      commit(current => ({
        ...current,
        environmentsLoading: false,
        environments: records,
        environmentStatuses: statuses,
      }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === environmentsSequence.current && selectedName.current === workspace) {
        commit(current => ({ ...current, environmentsLoading: false, environmentsError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const refreshSelected = useCallback(async () => {
    const selection = selectedName.current;
    if (!selection) return refresh();

    const session = api.sessionGeneration;
    const revision = mutationRevision.current;
    const refreshing = refresh(session, true);
    const request = refreshSequence.current;
    const refreshed = await refreshing;
    if (!refreshed) {
      if (api.isCurrent(session) && request === refreshSequence.current && revision === mutationRevision.current) {
        commit(current => ({ ...current, refreshing: false }));
      }
      return false;
    }

    let inspected = true;
    if (selectedName.current === selection && api.isConfirmed) {
      inspected = await inspectProject(selection, true);
    }
    if (api.isCurrent(session) && request === refreshSequence.current && revision === mutationRevision.current) {
      commit(current => current.refreshing ? { ...current, refreshing: false } : current);
    }
    return inspected;
  }, [api, commit, inspectProject, refresh]);

  const clearSelection = useCallback(() => {
    selectionRevision.current++;
    inspectionSequence.current++;
    servicesSequence.current++;
    selectedName.current = null;
    commit(current => ({ ...current, selectedName: null, inspection: null, inspectionError: null, inspectionLoading: false, services: null, servicesError: null, servicesLoading: false, workstreams: [], workstreamsError: null, workstreamsLoading: false, leases: [], leasesError: null }));
  }, [commit]);

  const mutate = useCallback(async <T,>(key: string, action: () => Promise<T>, successMessage: string) => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return { ok: false as const };
    const operationRevision = ++mutationRevision.current;
    refreshSequence.current++;
    commit(current => ({
      ...current,
      refreshing: true,
      notice: null,
      busyIds: new Set(current.busyIds).add(key),
    }));

    let value: T | undefined;
    let failure: unknown;
    try {
      value = await action();
    } catch (error) {
      failure = error;
    }

    if (failure && handleSessionExpired(failure)) return { ok: false as const };

    let reconciled = false;
    let reconciliationFailed = false;
    const reconcileRequest = refreshSequence.current + 1;
    if (api.isCurrent(session)) reconciled = await refresh(session);
    if (api.isCurrent(session)) {
      const superseded = mutationRevision.current !== operationRevision || refreshSequence.current !== reconcileRequest;
      reconciliationFailed = !failure && !reconciled && !superseded;
      if (failure || reconciled || !superseded) {
        const notice = failure
          ? { kind: 'error' as const, message: errorMessage(failure) }
          : reconciled
            ? { kind: 'success' as const, message: successMessage }
            : { kind: 'error' as const, message: 'The action finished, but the workspace could not be refreshed. Refresh to confirm the current state.' };
        commit(current => ({ ...current, notice }));
      }
    }
    if (api.isCurrent(session)) {
      commit(current => {
        const busyIds = new Set(current.busyIds);
        busyIds.delete(key);
        return { ...current, busyIds };
      });
    }
    return failure
      ? { ok: false as const }
      : { ok: true as const, value: value as T, reconciliationFailed };
  }, [api, commit, handleSessionExpired, refresh]);

  const requestProject = useCallback(async (value: ProjectRequest) => {
    const session = api.sessionGeneration;
    const result = await mutate(
      'project-request',
      () => api.register(value.name, value.roots),
      'Project registered. Bounded metadata was read immediately; nothing was started or changed.',
    );
    if (result.ok && api.isCurrent(session)) await inspectProject(result.value.name);
    return result;
  }, [api, inspectProject, mutate]);

  const pickProjectRoots = useCallback(async (signal: AbortSignal) => {
    try {
      return await api.projectRootPicker(signal);
    } catch (error) {
      if (handleSessionExpired(error)) {
        resetPrivateState('disconnected', {
          kind: 'error',
          message: 'This browser session expired or the local service restarted. Connect this browser again to continue.',
        });
      }
      throw error;
    }
  }, [api, handleSessionExpired, resetPrivateState]);

  const removeWorkspace = useCallback(async (workspace: string) => {
    if (selectedName.current === workspace) clearSelection();
    await mutate(busyKeyForWorkspace(workspace), () => api.remove(workspace), 'Project registration removed. No project files or runtime resources were deleted.');
  }, [api, clearSelection, mutate]);

  const copyText = useCallback(async (text: string, successMessage: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: 'success', message: successMessage });
      return true;
    } catch {
      setNotice({ kind: 'error', message: 'Clipboard unavailable. Select and copy the text directly.' });
      return false;
    }
  }, [setNotice]);

  return {
    state,
    refresh,
    refreshSelected,
    connectDashboard,
    disconnect,
    inspectProject,
    inspectServices,
    loadActivity,
    loadRecords,
    clearSelection,
    requestProject,
    pickProjectRoots,
    removeWorkspace,
    copyText,
    setNotice,
  };
}
