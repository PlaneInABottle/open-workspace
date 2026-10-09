import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ApiClient, CoordinatorDrift, CoordinatorSnapshot } from '@/api';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';
import { checkpointAgeLabel } from '@/features/environments/time-label';

/** Mutlak saat + göreli yaş ikilisi; ayrıştırılamayan saat asla bayatlık kanıtlamaz. */
function witnessAgeLabel(producedAt: string, nowMs: number): { time: string; age: string; stale: boolean } {
  const atMs = Date.parse(producedAt);
  if (!Number.isFinite(atMs)) return { time: 'saat bilinmiyor', age: 'tazelik bilinmiyor', stale: false };
  const time = new Date(atMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ageMs = Math.max(0, nowMs - atMs);
  const stale = ageMs > 60_000;
  return { time, age: checkpointAgeLabel(producedAt, nowMs), stale };
}

function DiffModal({ drift, onClose }: { drift: CoordinatorDrift; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    // Küçük focus-trap: Tab modal içinde döner.
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])',
    )].filter(node => !node.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg outline-none"
        onClick={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3 id={titleId} className="text-base font-semibold">Fark: {drift.service}</h3>
        <p className="mt-1 text-xs text-muted-foreground">Salt-okunur önizleme — hiçbir şey çalıştırmaz.</p>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Alan</dt>
            <dd>{drift.field}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Beklenen</dt>
            <dd className="break-words">{drift.expected}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Çalışan</dt>
            <dd className="break-words">{drift.actual}</dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            onClick={onClose}
          >
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
}

function PreflightPanel({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const { preflight } = snapshot;
  return (
    <article aria-labelledby="koordinator-preflight-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-preflight-heading" className="text-sm font-semibold">Başlatma ön kontrolü</h3>
        {preflight.pass ? (
          <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> başlatılabilir</Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-destructive"><span aria-hidden="true">!</span> eksikler var ({preflight.missing.length})</Badge>
        )}
      </div>
      {preflight.missing.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Eksik yok — bilinen kapıların hepsi boş.</p>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setOpen(current => !current)}
          >
            {open ? 'Eksik listesini gizle' : `Eksik listesini göster (${preflight.missing.length})`}
          </button>
          {open && (
            <ul id={regionId} className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {preflight.missing.map(line => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Koordinatör bölümü: tek aggregate snapshot'tan P1 (reconcile özeti + drift
 * satırları + salt-okunur diff modalı) + P2 (preflight rozeti + eksik
 * akordiyonu) + tanık çizgisi. Eylem butonu yok; veri üst bardaki Yenile ile
 * one-shot gelir (refreshToken).
 */
export function CoordinatorSection({ api, workspace, environment, refreshToken }: {
  api: ApiClient;
  workspace: string;
  environment: string;
  refreshToken: number;
}) {
  const [openDrift, setOpenDrift] = useState<CoordinatorDrift | null>(null);
  // Odak dönüşü deterministik: açan düğme tıklama anında yakalanır (modal
  // mount'undaki autoFocus yarışı ortadan kalkar).
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const { data, warnings, loading, error } = useObserverFetch<CoordinatorSnapshot>(() =>
    api.coordinator(workspace, environment).then(snapshot => ({ data: snapshot, warnings: snapshot.warnings })),
  [workspace, environment, refreshToken]);

  function closeDrift() {
    setOpenDrift(null);
    openerRef.current?.focus();
  }

  // Ortam değişince açık modal kapanır — eski snapshot'ın diff'i kalmaz.
  useEffect(() => { setOpenDrift(null); }, [workspace, environment]);

  return (
    <section aria-labelledby="koordinator-heading" className="border-t border-border pt-5">
      <header>
        <p className="eyebrow">KOORDİNATÖR</p>
        <h2 id="koordinator-heading" className="text-base font-semibold">Koordinatör</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {environment
            ? <>Salt-okunur ortam özeti: <span className="font-medium text-foreground">{environment}</span>. Hiçbir şey başlatmaz, durdurmaz, düzeltmez.</>
            : 'Ortam seçilince salt-okunur özet burada görünür.'}
        </p>
      </header>

      <WarningsStrip warnings={warnings} />
      {error && <p role="alert" className="mt-3 text-sm text-destructive">Koordinatör anlığı okunamadı: {error}</p>}
      {loading && !data && !error && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">Koordinatör anlığı okunuyor…</p>
      )}

      {data && (
        <>
          <article aria-labelledby="koordinator-reconcile-heading" className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="koordinator-reconcile-heading" className="text-sm font-semibold">Ortam haritası</h3>
              {data.reconcile.inSync ? (
                <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> eşleşiyor</Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-destructive"><span aria-hidden="true">!</span> kayık ({data.reconcile.drifts.length})</Badge>
              )}
            </div>
            {data.reconcile.inSync ? (
              <p className="mt-2 text-sm text-muted-foreground">Fark yok — beklenen topoloji ile çalışan durum örtüşüyor.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border border-y border-border">
                {data.reconcile.drifts.map(drift => (
                  <li key={`${drift.service}:${drift.field}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <p className="min-w-0 flex-1 break-words text-sm">
                      <span className="font-medium">{drift.service}</span>
                      <span className="text-muted-foreground"> · {drift.field}: </span>
                      <span className="font-mono text-[0.8rem]">{drift.expected} → {drift.actual}</span>
                    </p>
                    <button
                      type="button"
                      className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
                      onClick={event => { openerRef.current = event.currentTarget; setOpenDrift(drift); }}
                    >
                      Diff&apos;i aç
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <PreflightPanel snapshot={data} />

          <WitnessLine snapshot={data} />
        </>
      )}
      {openDrift && <DiffModal drift={openDrift} onClose={closeDrift} />}
    </section>
  );
}

function WitnessLine({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [snapshot]);
  const { time, age, stale } = witnessAgeLabel(snapshot.meta.producedAt, nowMs);
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      koordinatör anlığı · {time} · {age} · <span title="anlık kimliği">#{snapshot.meta.snapshotId}</span>
      {stale && <> · <span className="font-medium text-warning">bayat olabilir — Yenile&apos;ye bas</span></>}
    </p>
  );
}
