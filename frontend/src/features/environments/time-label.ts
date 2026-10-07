/** Relative age for a stored timestamp; an unparseable timestamp never proves staleness. */
export function checkpointAgeLabel(at: string, nowMs: number = Date.now()): string {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return 'date unknown';
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
