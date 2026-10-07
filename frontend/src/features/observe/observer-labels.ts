/** Pure formatters for the observer surface (no React). */

export function shortId(sessionID: string): string {
  return sessionID.length > 13 ? sessionID.slice(0, 13) : sessionID;
}

export function isFailureOutcome(outcome: string): boolean {
  return outcome === 'failure' || outcome === 'error';
}

export function isOkOutcome(outcome: string): boolean {
  return outcome === 'completed' || outcome === 'success' || outcome === 'ok';
}

/** Badge variant for a record outcome: failures destructive, ok default, rest outline. */
export function outcomeVariant(outcome: string): 'default' | 'destructive' | 'outline' {
  if (isFailureOutcome(outcome)) return 'destructive';
  if (isOkOutcome(outcome)) return 'default';
  return 'outline';
}

export function formatCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost)) return '—';
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null): string {
  if (!tokens) return '—';
  return `in ${tokens.input.toLocaleString()} · out ${tokens.output.toLocaleString()}`;
}

export function formatChanges(additions: number | null, deletions: number | null, files: number | null): string {
  if (additions === null && deletions === null) return '—';
  return `+${additions ?? '?'} −${deletions ?? '?'} (${files ?? '?'} files)`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function kindLabel(kind: string): string {
  if (kind === 'shell') return 'shell';
  if (kind === 'file-edit') return 'file edit';
  if (kind === 'tool-call') return 'tool';
  if (kind === 'permission') return 'permission';
  return kind;
}

/**
 * Attribution eyebrow for a message shown as a header/label. User
 * instructions name the asker, synthetic subagent briefings name their
 * target (when known), and unattributed text from degraded payloads falls
 * back to a generic message label. Null means there is no message to
 * attribute (e.g. the "(no task)" bucket or a non-message tree title).
 */
export function messageEyebrow(
  kind: 'user' | 'briefing' | 'none' | 'other' | string | null | undefined,
  agent: string | null | undefined,
): string | null {
  if (kind === 'user') return 'You asked:';
  if (kind === 'briefing') return agent ? `Briefing to ${agent}:` : 'Briefing:';
  if (kind === 'none' || kind === 'other') return null;
  return 'Message:';
}

/** Small-caps eyebrow styling shared by message attribution labels. */
export const messageEyebrowClass = 'text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground';

export const sinceOptions = [
  { value: '30m', label: 'Last 30 minutes' },
  { value: '3h', label: 'Last 3 hours' },
  { value: '1d', label: 'Last 24 hours' },
  { value: '1w', label: 'Last week' },
];

export const kindOptions = [
  { value: '', label: 'All types' },
  { value: 'shell', label: 'Shell' },
  { value: 'file-edit', label: 'File edits' },
  { value: 'tool-call', label: 'Tool calls' },
  { value: 'permission', label: 'Permissions' },
];
