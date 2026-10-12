/**
 * Single-source relative-age formatter (from the envelope `at` / provenance
 * `recordedAt` record time; an unparseable time never proves staleness).
 * The bucket thresholds are fixed (1m / 60m / 48h).
 */
export function checkpointAgeLabel(at: string | null | undefined, nowMs: number = Date.now()): string {
  if (!at) return 'date unknown';
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return 'date unknown';
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
