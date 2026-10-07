import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClient,
  ApiError,
  type ActivityEntry,
  type ClientConfig,
  type Workspace,
} from './api';

export type Notice = { kind: 'success' | 'error' | 'info'; message: string };
export type ConnectionPhase = 'connected';

export interface WorkbenchState {
  phase: ConnectionPhase;
  workspaces: Workspace[];
  clientConfig: ClientConfig | null;
  activity: ActivityEntry[];
  activityLoading: boolean;
  refreshing: boolean;
  busyIds: ReadonlySet<string>;
  notice: Notice | null;
}

function initialState(): WorkbenchState {
  return {
    phase: 'connected',
    workspaces: [],
    clientConfig: null,
    activity: [],
    activityLoading: false,
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
  const [state, setState] = useState(() => initialState());
  const stateRef = useRef(state);
  const refreshSequence = useRef(0);
  const mutationRevision = useRef(0);

  const commit = useCallback((update: (current: WorkbenchState) => WorkbenchState) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const setNotice = useCallback((notice: Notice | null) => {
    commit(current => ({ ...current, notice }));
  }, [commit]);

  const refresh = useCallback(async (keepRefreshing = false): Promise<boolean> => {
    const request = ++refreshSequence.current;
    const revision = mutationRevision.current;
    commit(current => ({ ...current, refreshing: true, notice: null }));
    try {
      const [overview, clientConfig] = await Promise.all([api.overview(), api.clientConfig()]);
      if (request !== refreshSequence.current || revision !== mutationRevision.current) return false;
      commit(current => ({
        ...current,
        workspaces: overview.workspaces,
        clientConfig,
        refreshing: keepRefreshing,
      }));
      return true;
    } catch (error) {
      if (request === refreshSequence.current && revision === mutationRevision.current) {
        commit(current => ({ ...current, refreshing: keepRefreshing, notice: { kind: 'error', message: errorMessage(error) } }));
      }
      return false;
    } finally {
      if (!keepRefreshing && request === refreshSequence.current && revision === mutationRevision.current) {
        commit(current => current.refreshing ? { ...current, refreshing: false } : current);
      }
    }
  }, [api, commit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadActivity = useCallback(async () => {
    commit(current => ({ ...current, activityLoading: true }));
    try {
      const trail = await api.activity();
      commit(current => ({ ...current, activity: trail, activityLoading: false }));
      return true;
    } catch {
      commit(current => ({ ...current, activityLoading: false }));
      return false;
    }
  }, [api, commit]);

  const mutate = useCallback(async <T,>(key: string, action: () => Promise<T>, successMessage: string) => {
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

    let reconciled = false;
    let reconciliationFailed = false;
    const reconcileRequest = refreshSequence.current + 1;
    reconciled = await refresh();
    {
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
    commit(current => {
      const busyIds = new Set(current.busyIds);
      busyIds.delete(key);
      return { ...current, busyIds };
    });
    return failure
      ? { ok: false as const }
      : { ok: true as const, value: value as T, reconciliationFailed };
  }, [commit, refresh]);

  const removeWorkspace = useCallback(async (workspace: string) => {
    await mutate(busyKeyForWorkspace(workspace), () => api.remove(workspace), 'Project registration removed. No project files or runtime resources were deleted.');
  }, [api, mutate]);

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
    api,
    refresh,
    loadActivity,
    removeWorkspace,
    copyText,
    setNotice,
  };
}
