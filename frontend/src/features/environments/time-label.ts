/**
 * Tek-kaynak göreli-yaş biçimleyici (zarf `at` / provenance `recordedAt`
 * kayıt-saatinden; ayrıştırılamayan saat asla bayatlık kanıtlamaz).
 * Kova sınırları her dilde aynıdır (1dk / 60dk / 48sa) — dil yalnızca
 * sözcükleri değiştirir, eşikleri değil.
 */
export function ageLabel(at: string | null | undefined, nowMs: number, locale: 'en' | 'tr'): string {
  if (!at) return locale === 'tr' ? 'date unknown' : 'date unknown';
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return locale === 'tr' ? 'date unknown' : 'date unknown';
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return locale === 'tr' ? 'just now' : 'just now';
  if (minutes < 60) return locale === 'tr' ? `${minutes}m ago` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return locale === 'tr' ? `${hours}h ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return locale === 'tr' ? `${days}d ago` : `${days}d ago`;
}

/** Relative age for a stored timestamp; an unparseable timestamp never proves staleness. */
export function checkpointAgeLabel(at: string, nowMs: number = Date.now()): string {
  return ageLabel(at, nowMs, 'en');
}

/** Türkçe göreli yaş — aynı kovalar, Türkçe sözcükler. */
export function yasEtiketi(at: string | null | undefined, nowMs: number = Date.now()): string {
  return ageLabel(at, nowMs, 'tr');
}
