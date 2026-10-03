import type { Store } from './store.js';

export type ApiActor = 'dashboard' | 'mcp' | 'operator';

export interface OperatorScope {
  workspaceIds: string[];
  updatedAt: string;
}

export interface ActivityEntry {
  at: string;
  actor: 'dashboard' | 'mcp-operator';
  operation: string;
  workspaceId: string | null;
  detail: string;
}

/** Replace the operator delegation set. Empty list revokes delegation. */
export async function setOperatorScope(store: Store, workspaceIds: string[]): Promise<OperatorScope | null> {
  const unique = [...new Set(workspaceIds)];
  return store.update(state => {
    if (unique.length > 50) throw new Error('Operator access covers at most fifty workspaces.');
    for (const id of unique) {
      if (!state.workspaces.some(workspace => workspace.id === id)) throw new Error('Operator access covers approved workspaces only.');
    }
    if (unique.length === 0) {
      state.operatorScope = null;
      return null;
    }
    const scope: OperatorScope = { workspaceIds: unique, updatedAt: new Date().toISOString() };
    state.operatorScope = scope;
    return scope;
  });
}

export function operatorCovers(scope: OperatorScope | null, workspaceId: string): boolean {
  return scope !== null && scope.workspaceIds.includes(workspaceId);
}

/** Drop revoked workspaces from the delegation so scope never names dead access. */
export async function pruneOperatorScope(store: Store, workspaceId: string): Promise<void> {
  await store.update(state => {
    if (!state.operatorScope) return;
    state.operatorScope.workspaceIds = state.operatorScope.workspaceIds.filter(id => id !== workspaceId);
    if (state.operatorScope.workspaceIds.length === 0) state.operatorScope = null;
  });
}

export async function recordActivity(
  store: Store,
  entry: { actor: 'dashboard' | 'mcp-operator'; operation: string; workspaceId: string | null; detail: string },
): Promise<void> {
  await store.update(state => {
    state.activity.push({ ...entry, at: new Date().toISOString() });
    while (state.activity.length > 50) state.activity.shift();
  });
}
