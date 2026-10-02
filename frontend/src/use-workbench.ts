import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClient,
  ApiError,
  SessionExpiredError,
  type Capability,
  type ClientConfig,
  type Inspection,
  type Proposal,
  type Workspace,
} from './api';
import type { ProjectRequest } from './validation';

export type Notice = { kind: 'success' | 'error' | 'info'; message: string };
export type ConnectionPhase = 'disconnected' | 'connecting' | 'loading' | 'connected';

export interface WorkbenchState {
  phase: ConnectionPhase;
  proposals: Proposal[];
  workspaces: Workspace[];
  capabilities: Capability[];
  clientConfig: ClientConfig | null;
  selectedId: string | null;
  inspection: Inspection | null;
  inspectionError: string | null;
  inspectionLoading: boolean;
  refreshing: boolean;
  busyIds: ReadonlySet<string>;
  notice: Notice | null;
}

function initialState(phase: ConnectionPhase): WorkbenchState {
  return {
    phase,
    proposals: [],
    workspaces: [],
    capabilities: [],
    clientConfig: null,
    selectedId: null,
    inspection: null,
    inspectionError: null,
    inspectionLoading: false,
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

function busyKeyForProposal(id: string) { return `proposal:${id}`; }
function busyKeyForWorkspace(id: string) { return `workspace:${id}`; }

export function useWorkbench() {
  const [api] = useState(() => new ApiClient());
  const [state, setState] = useState(() => initialState(api.hasSession ? 'loading' : 'disconnected'));
  const stateRef = useRef(state);
  const refreshSequence = useRef(0);
  const mutationRevision = useRef(0);
  const inspectionSequence = useRef(0);
  const selectionRevision = useRef(0);
  const selectedId = useRef<string | null>(null);

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
    selectedId.current = null;
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

      const currentSelection = selectedId.current;
      const selectionExists = currentSelection !== null && overview.workspaces.some(workspace => workspace.id === currentSelection);
      if (currentSelection && !selectionExists) {
        selectedId.current = null;
        selectionRevision.current++;
        inspectionSequence.current++;
      }
      commit(current => ({
        ...current,
        phase: api.isConfirmed ? 'connected' : current.phase,
        proposals: overview.proposals,
        workspaces: overview.workspaces,
        capabilities: overview.capabilities,
        clientConfig,
        selectedId: selectionExists ? currentSelection : null,
        inspection: selectionExists ? current.inspection : null,
        inspectionError: selectionExists ? current.inspectionError : null,
        inspectionLoading: selectionExists ? current.inspectionLoading : false,
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
    resetPrivateState('disconnected', { kind: 'info', message: 'This browser tab is disconnected. Approved workspaces remain on this machine.' });
    void revocation;
  }, [api, resetPrivateState]);

  const inspectProject = useCallback(async (workspaceId: string, preserveInspection = false) => {
    const session = api.sessionGeneration;
    if (!api.isConfirmed) return false;
    const request = ++inspectionSequence.current;
    selectionRevision.current++;
    selectedId.current = workspaceId;
    commit(current => {
      const keepCurrent = preserveInspection
        && current.selectedId === workspaceId
        && current.inspection?.workspace.id === workspaceId;
      return {
        ...current,
        selectedId: workspaceId,
        inspection: keepCurrent ? current.inspection : null,
        inspectionError: null,
        inspectionLoading: true,
        notice: null,
      };
    });
    try {
      const inspection = await api.inspect(workspaceId);
      if (!api.isCurrent(session) || request !== inspectionSequence.current || selectedId.current !== workspaceId) return false;
      commit(current => ({ ...current, inspection, inspectionLoading: false }));
      return true;
    } catch (error) {
      if (handleSessionExpired(error)) return false;
      if (api.isCurrent(session) && request === inspectionSequence.current && selectedId.current === workspaceId) {
        commit(current => ({ ...current, inspectionLoading: false, inspectionError: errorMessage(error) }));
      }
      return false;
    }
  }, [api, commit, handleSessionExpired]);

  const refreshSelected = useCallback(async () => {
    const selection = selectedId.current;
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
    if (selectedId.current === selection && api.isConfirmed) {
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
    selectedId.current = null;
    commit(current => ({ ...current, selectedId: null, inspection: null, inspectionError: null, inspectionLoading: false }));
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

  const requestProject = useCallback((value: ProjectRequest) => mutate(
    'project-request',
    () => api.propose(value.name, value.roots),
    'Project access requested. Review and approve every listed root before metadata is read.',
  ), [api, mutate]);

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

  const approve = useCallback(async (proposalId: string) => {
    const session = api.sessionGeneration;
    const selectionAtStart = selectionRevision.current;
    const mutation = mutate(busyKeyForProposal(proposalId), () => api.approve(proposalId), 'Project access approved for all selected roots. Metadata only; nothing was started or changed.');
    const operationRevision = mutationRevision.current;
    const result = await mutation;
    if (!result.ok || !api.isCurrent(session)) return;

    if (result.reconciliationFailed) {
      if (mutationRevision.current !== operationRevision) return;
      const approved = result.value;
      commit(current => ({
        ...current,
        workspaces: [...current.workspaces.filter(workspace => workspace.id !== approved.id), approved],
        proposals: current.proposals.filter(proposal => proposal.id !== proposalId),
      }));
    }

    if (result.value && selectionRevision.current === selectionAtStart) {
      const inspection = inspectProject(result.value.id);
      const inspectionSelectionRevision = selectionRevision.current;
      await inspection;
      if (result.reconciliationFailed
        && api.isCurrent(session)
        && mutationRevision.current === operationRevision
        && selectionRevision.current === inspectionSelectionRevision) {
        setNotice({
          kind: 'error',
           message: 'Project access was approved, but the workspace could not be refreshed. The approved roots are shown from the approval response; refresh to confirm the current state.',
        });
      }
    }
  }, [api, commit, inspectProject, mutate, setNotice]);

  const decline = useCallback((proposalId: string) => mutate(
    busyKeyForProposal(proposalId),
    () => api.decline(proposalId),
    'Project access request declined.',
  ), [api, mutate]);

  const revoke = useCallback(async (workspaceId: string) => {
    if (selectedId.current === workspaceId) clearSelection();
    await mutate(busyKeyForWorkspace(workspaceId), () => api.revoke(workspaceId), 'All project roots were revoked. No project files or runtime resources were deleted.');
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
    clearSelection,
    requestProject,
    pickProjectRoots,
    approve,
    decline,
    revoke,
    copyText,
    setNotice,
  };
}
