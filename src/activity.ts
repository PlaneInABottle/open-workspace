import type { Store } from './store.js';

export interface ActivityEntry {
  at: string;
  actor: 'dashboard' | 'mcp';
  operation: string;
  workspaceId: string | null;
  detail: string;
}

const maxEntries = 50;

/** The dashboard keeps an audit trail of what ran; it never gates execution. */
export async function recordActivity(
  store: Store,
  entry: { actor: 'dashboard' | 'mcp'; operation: string; workspaceId: string | null; detail: string },
): Promise<void> {
  await store.update(state => {
    state.activity.push({ ...entry, at: new Date().toISOString() });
    while (state.activity.length > maxEntries) state.activity.shift();
  });
}

export async function recentActivity(store: Store): Promise<ActivityEntry[]> {
  return (await store.read()).activity;
}
