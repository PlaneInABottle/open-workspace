import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type {
  ApiClient,
  CheckpointStageStatus,
  CoordinatorCheckpoints,
  CoordinatorDrift,
  CoordinatorExplanation,
  CoordinatorScenarios,
  CoordinatorSnapshot,
  ScenarioVerdict,
} from '@/api';
import { useObserverFetch, WarningsStrip } from '@/features/observe/use-observer';
import { checkpointAgeLabel, yasEtiketi } from '@/features/environments/time-label';

const STAGE_TR: Record<CheckpointStageStatus, string> = {
  confirmed: 'doğrulandı',
  not_observed: 'gözlenmedi',
  stale: 'bayat',
};

const STALE_TR: Record<string, string> = {
  script_hash: 'betik değişti',
  checkout_rev: 'kod revizyonu değişti',
  runtime: 'çalışma ortamı değişti',
  missing_basis: 'karşılaştırma kaydı yok',
};

const BOUNDARY_TR: Record<string, string> = {
  real: 'gerçek',
  local: 'yerel',
  fake: 'sahte',
  'captured-response': 'kayıtlı yanıt',
  test: 'test',
};

const VERDICT_TR: Record<Exclude<ScenarioVerdict, 'uncovered'>, string> = {
  pass: 'geçti',
  stale: 'bayat',
  skipped: 'atlandı',
  unverified: 'doğrulanamadı',
};

function staleNedeni(staleReason: string | null): string {
  if (!staleReason) return '';
  return STALE_TR[staleReason] ?? staleReason;
}

/**
 * Kopyala düğmesi: `full` YALNIZCA tıklama anındaki clipboard payload'ında
 * taşınır — DOM metnine, title'a ya da aria'ya yazılmaz (tara-test §3).
 * Hover ile tam-hash gösterilmez; erişim tıkla-kopyala yolunadır.
 */
function CopyButton({ full, label }: { full: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Unmount'ta sarkan timer kalmaz (tek atımlık geri-sayım; polling yok).
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={copy}
      className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {copied ? '✓ kopyalandı' : 'Kopyala'}
    </button>
  );
}

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
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
            className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
 * akordiyonu) + P3 (checkpoint çizgisi: stage şeridi + bayat kuyruğu +
 * salt-metin sıradaki-adım + çalışma seçimi) + P4 (provenance kartı:
 * beklenen/çalışan tablosu + rev şeridi) + P5 (senaryo matrisi) + tanık
 * çizgisi. Eylem butonu yok; veri üst bardaki Yenile ile one-shot gelir
 * (refreshToken). Çalışma seçimi kullanıcı-tetikli tekil yeniden-çekmedir
 * (timer/polling yok).
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
  // Açık checkpoint-çalışma isteği (null = latest); ortam değişince sıfırlanır.
  const [run, setRun] = useState<string | null>(null);
  // Son içerikli yanıttaki çalışma listesi: içeriksiz run seçiminde
  // (checkpoints null) seçici kaybolmasın diye önbellekte tutulur —
  // kullanıcı aynı seçiciyle içerikli run'a dönebilir.
  const [cachedRuns, setCachedRuns] = useState<string[]>([]);
  const { data, warnings, loading, error } = useObserverFetch<CoordinatorSnapshot>(() =>
    api.coordinator(workspace, environment, run ?? undefined).then(snapshot => ({ data: snapshot, warnings: snapshot.warnings })),
  [workspace, environment, refreshToken, run]);

  function closeDrift() {
    setOpenDrift(null);
    openerRef.current?.focus();
  }

  // Ortam değişince açık modal kapanır, çalışma seçimi latest'e döner.
  useEffect(() => { setOpenDrift(null); setRun(null); setCachedRuns([]); }, [workspace, environment]);

  // İçerikli yanıt geldikçe liste tazelenir; içeriksiz yanıtta korunur.
  // Üst-düzey `runs` yoksa (eski sunucu) önbellek devreye girer.
  useEffect(() => {
    const listed = data?.runs ?? [];
    if (listed.length > 0) setCachedRuns(listed);
  }, [data]);

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
                      className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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

          <CheckpointPanel checkpoints={data.checkpoints} runs={data.runs ?? cachedRuns} run={run} onRunChange={setRun} />

          <ProvenancePanel explanation={data.explanation} />

          <ScenariosPanel scenarios={data.scenarios} producedAt={data.meta.producedAt} />

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

/**
 * P3 checkpoint çizgisi: stage akışı yatay `<ol>` şeridi (tamamlanan ✓,
 * sıradaki ▸, bayat turuncu çerçeve + yaş) + first_gap "bayat kuyruğu"
 * (`role=status`) + salt-metin sıradaki-adım kutusu (eylem yok).
 */
/**
 * Çalışma seçici: etiketli native select (klavye-dostu, tekil yeniden-çekme
 * tetikler — timer/polling yok). Liste ebeveynden gelir; içeriksiz seçimde
 * bile görünür kalır (dead-end yok).
 */
function RunPicker({ runs, run, onRunChange }: {
  runs: string[];
  run: string | null;
  onRunChange: (run: string | null) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Çalışma
      <select
        value={run ?? ''}
        onChange={event => onRunChange(event.currentTarget.value === '' ? null : event.currentTarget.value)}
        className="rounded-md border border-border bg-background px-1.5 py-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">en güncel</option>
        {runs.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function CheckpointPanel({ checkpoints, runs, run, onRunChange }: {
  checkpoints: CoordinatorCheckpoints | null;
  runs: string[];
  run: string | null;
  onRunChange: (run: string | null) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [checkpoints]);

  if (!checkpoints) {
    return (
      <article aria-labelledby="koordinator-checkpoints-heading" className="mt-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="koordinator-checkpoints-heading" className="text-sm font-semibold">Checkpoint çizgisi</h3>
          <RunPicker runs={runs} run={run} onRunChange={onRunChange} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Checkpoint yok — runner kaydı bulunamadı.</p>
      </article>
    );
  }

  const currentStage = checkpoints.firstGap?.stage ?? checkpoints.lastVerified?.stage ?? null;
  const staleStages = checkpoints.stages.filter(stage => stage.status === 'stale');

  return (
    <article aria-labelledby="koordinator-checkpoints-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-checkpoints-heading" className="text-sm font-semibold">Checkpoint çizgisi</h3>
        <div className="flex flex-wrap items-center gap-2">
          <RunPicker runs={runs} run={run} onRunChange={onRunChange} />
          <p className="text-xs text-muted-foreground">
            çalışma: <span className="font-medium text-foreground">{checkpoints.run}</span>
            {' · '}{checkpoints.summary.confirmed} doğrulandı, {checkpoints.summary.stale} bayat, {checkpoints.summary.notObserved} gözlenmedi
          </p>
        </div>
      </div>

      <ol aria-label="Checkpoint aşamaları" className="mt-2 flex flex-wrap gap-2">
        {checkpoints.stages.map(stage => {
          const isCurrent = stage.stage === currentStage;
          const marker = stage.status === 'confirmed' ? '✓' : stage.status === 'stale' ? '!' : isCurrent ? '▸' : '○';
          return (
            <li
              key={stage.stage}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${stage.status === 'stale' ? 'border-warning bg-warning/10' : 'border-border'}`}
            >
              <span aria-hidden="true" className={stage.status === 'stale' ? 'font-bold text-warning' : stage.status === 'confirmed' ? 'text-success' : ''}>{marker}</span>
              <span className="font-medium">{stage.stage}</span>
              {stage.status === 'confirmed' ? (
                <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> doğrulandı</Badge>
              ) : stage.status === 'stale' ? (
                <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">!</span> bayat</Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-muted-foreground"><span aria-hidden="true">○</span> gözlenmedi</Badge>
              )}
              <span className="text-xs text-muted-foreground">{yasEtiketi(stage.at, nowMs)}</span>
            </li>
          );
        })}
      </ol>

      {checkpoints.firstGap && (
        <div role="status" className="mt-3 rounded-md border border-border p-3">
          <p className="text-sm">
            İlk boşluk: <span className="font-medium">{checkpoints.firstGap.stage}</span>
            {' '}({STAGE_TR[checkpoints.firstGap.status]}{checkpoints.firstGap.staleReason ? ` — ${staleNedeni(checkpoints.firstGap.staleReason)}` : ''})
            {' · '}{yasEtiketi(checkpoints.firstGap.at, nowMs)}
          </p>
          {staleStages.length > 0 && (
            <div className="mt-2">
              <h4 className="text-xs font-semibold text-warning">Bayat kuyruğu</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {staleStages.map(stage => (
                  <li key={stage.stage}>
                    {stage.stage} — {staleNedeni(stage.staleReason)} · {yasEtiketi(stage.at, nowMs)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {checkpoints.safeNextAction && (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">Önerilen sıradaki adım</p>
          <p className="mt-1 text-sm">{checkpoints.safeNextAction}</p>
          <p className="mt-1 text-xs text-muted-foreground">Bu bir öneri — çalıştırmaz. Uygulamak asistana aittir.</p>
        </div>
      )}
    </article>
  );
}

function expectedCellText(entry: CoordinatorExplanation['entries'][number]): string {
  if (!entry.expected) return 'tanımda yok';
  const parts = [
    entry.expected.cmd,
    entry.expected.dir,
    entry.expected.port === null ? null : `${entry.expected.port} portu`,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/**
 * P4 provenance kartı: beklenen/çalışan `<table>`si + rev şeridi
 * (nokta-zaman çizgisi: seçili vurgulu, eski soluk, etiket kısa-hash + yaş)
 * + diff satırları. Rev satırı asla çıplak hash değil; tam-hash yalnızca
 * kopyala-butonu clipboard payload'ındadır.
 */
function ProvenancePanel({ explanation }: { explanation: CoordinatorExplanation | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    setSelected(null);
  }, [explanation]);

  if (!explanation) {
    return (
      <article aria-labelledby="koordinator-provenance-heading" className="mt-4 border-t border-border pt-4">
        <h3 id="koordinator-provenance-heading" className="text-sm font-semibold">Provenance kartı</h3>
        <p className="mt-2 text-sm text-muted-foreground">Provenance kaydı yok — spawn kaydı bulunamadı.</p>
      </article>
    );
  }

  const activeFull = selected ?? explanation.revisions.find(revision => revision.current)?.full ?? null;

  return (
    <article aria-labelledby="koordinator-provenance-heading" className="mt-4 border-t border-border pt-4">
      <h3 id="koordinator-provenance-heading" className="text-sm font-semibold">Provenance kartı</h3>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Servis</th>
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Beklenen</th>
              <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Çalışan</th>
              <th scope="col" className="py-1 text-xs font-medium text-muted-foreground">Rev</th>
            </tr>
          </thead>
          <tbody>
            {explanation.entries.map(entry => (
              <tr
                key={entry.service}
                // data-selected yalnızca seçiliyken render edilir ("false"
                // dizesi DOM'da gürültü yapmaz; seçim saf-görünüm durumudur).
                {...(entry.revFull !== null && entry.revFull === activeFull ? { 'data-selected': true } : {})}
                className={`border-b border-border last:border-0 ${entry.revFull !== null && entry.revFull === activeFull ? 'bg-muted/60' : ''}`}
              >
                <th scope="row" className="py-2 pr-3 text-left font-medium">{entry.service}</th>
                <td className="py-2 pr-3">{expectedCellText(entry)}</td>
                <td className="py-2 pr-3">
                  {entry.running ? <>{entry.running.status}: {entry.running.detail}</> : 'ölçülmedi'}
                </td>
                <td className="py-2">
                  {entry.revShort ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <code translate="no" className="font-mono text-[0.8rem]">{entry.revShort}</code>
                      {entry.revDirty && <span className="text-xs text-muted-foreground">+kirli</span>}
                      {entry.revRecorded ? (
                        <Badge variant="outline" className="gap-1 text-success"><span aria-hidden="true">✓</span> kayıtlı</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">?</span> doğrulanamadı</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {entry.revAt ? `${yasEtiketi(entry.revAt, nowMs)} kaydedildi` : 'kayıt saati yok'}
                      </span>
                      {entry.revFull && <CopyButton full={entry.revFull} label={`${entry.revShort} revini kopyala`} />}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge variant="outline" className="gap-1 text-warning"><span aria-hidden="true">?</span> doğrulanamadı</Badge>
                      <span className="text-xs text-muted-foreground">rev kaydı yok</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {explanation.entries.filter(entry => entry.diffs.length > 0 || entry.note.length > 0).map(entry => (
        <div key={entry.service} className="mt-2 text-sm">
          <p className="font-medium">{entry.service}</p>
          {entry.diffs.length > 0 && (
            <ul aria-label={`${entry.service} farkları`} className="list-disc pl-5 text-muted-foreground">
              {entry.diffs.map(diff => <li key={diff}>{diff}</li>)}
            </ul>
          )}
          <p className="text-muted-foreground">neden: {entry.note}</p>
        </div>
      ))}

      {explanation.revisions.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground">Rev şeridi</h4>
          <ol aria-label="Rev şeridi" className="mt-1 flex flex-wrap items-center gap-2">
            {explanation.revisions.map(revision => {
              const isActive = revision.full === activeFull;
              return (
                <li key={revision.full} className="flex items-center gap-2">
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${isActive ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  <button
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    aria-pressed={isActive}
                    onClick={() => setSelected(revision.full)}
                    className={`rounded border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${isActive ? 'border-primary font-semibold' : 'border-border'} ${revision.recorded ? '' : 'opacity-60'}`}
                  >
                    <span translate="no" className="font-mono">{revision.short}</span>
                    {' · '}
                    <span className="text-muted-foreground">{yasEtiketi(revision.at, nowMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </article>
  );
}

function ScenarioCell({ verdict }: { verdict: ScenarioVerdict }) {
  if (verdict === 'uncovered') {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">kapsam dışı</span>
      </span>
    );
  }
  return (
    <Badge variant="outline" className={`gap-1 ${verdict === 'pass' ? 'text-success' : verdict === 'stale' ? 'text-warning' : verdict === 'unverified' ? 'text-warning' : 'text-muted-foreground'}`}>
      <span aria-hidden="true">{verdict === 'pass' ? '✓' : verdict === 'stale' ? '!' : verdict === 'unverified' ? '?' : '○'}</span>
      {VERDICT_TR[verdict]}
    </Badge>
  );
}

/**
 * P5 senaryo matrisi: gerçek `<table>` (satır = senaryo, sütun = sınır),
 * hücre = rozet metni. Hüküm, seçili run'daki checkpoint tazeliğinden
 * gelir (kayıt yoksa "atlandı"); çalıştırma YOK — matris gösterir,
 * koşturmaz. Sıra: matris → uyarı şeridi → tanık çizgisi (odak sırası).
 */
function ScenariosPanel({ scenarios, producedAt }: { scenarios: CoordinatorScenarios | null; producedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [scenarios, producedAt]);

  if (!scenarios) {
    return (
      <article aria-labelledby="koordinator-scenarios-heading" className="mt-4 border-t border-border pt-4">
        <h3 id="koordinator-scenarios-heading" className="text-sm font-semibold">Senaryo matrisi</h3>
        <p className="mt-2 text-sm text-muted-foreground">Senaryo dosyası bağlı değil.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Senaryo dosyasını asistanına bağlat — <a href="#setup" className="font-medium text-primary underline-offset-4 hover:underline">Connect your AI →</a>
        </p>
      </article>
    );
  }

  const atMs = Date.parse(producedAt);
  const staleSnapshot = Number.isFinite(atMs) && nowMs - atMs > 60_000;
  const snapshotTime = Number.isFinite(atMs)
    ? new Date(atMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'saat bilinmiyor';

  return (
    <article aria-labelledby="koordinator-scenarios-heading" className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="koordinator-scenarios-heading" className="text-sm font-semibold">Senaryo matrisi</h3>
        <p className="text-xs text-muted-foreground">
          dosya: <span className="font-medium text-foreground">{scenarios.file}</span>
          {' · '}{scenarios.rows.length} senaryo, {scenarios.columns.length} sınır
        </p>
      </div>
      {staleSnapshot && (
        <div role="status" className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-warning">bayat olabilir — Yenile?</span>
          {' · '}{snapshotTime} · {yasEtiketi(producedAt, nowMs)}
        </div>
      )}

      {scenarios.error !== null ? (
        <p role="alert" className="mt-2 text-sm text-destructive">Senaryo dosyası okunamadı: {scenarios.error}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-xs text-muted-foreground">
              Senaryo matrisi — {scenarios.file} · satır senaryo, sütun sınır; hücre hükmü seçili run kaydından gelir, çalıştırma yapmaz.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">Senaryo</th>
                {scenarios.columns.map(column => (
                  <th key={column} scope="col" className="py-1 pr-3 text-xs font-medium text-muted-foreground">
                    {BOUNDARY_TR[column] ?? column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.rows.map(row => (
                <tr key={row.name} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="break-words py-2 pr-3 text-left font-medium">
                    {row.name}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {row.services.map(service => (
                        <span key={service} className="mr-1.5">
                          {service}
                          {row.unverifiedServices.includes(service) && (
                            <span className="ml-1 font-medium text-warning">? doğrulanamadı</span>
                          )}
                        </span>
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {row.probes.length} probe ({row.probes.map(probe => probe.id).join(', ')})
                      {' · '}kayıt: {row.checkpoints.length > 0 ? row.checkpoints.join(', ') : 'yok'}
                    </span>
                  </th>
                  {scenarios.columns.map(column => (
                    <td key={column} className="py-2 pr-3">
                      <ScenarioCell verdict={row.cells[column] ?? 'skipped'} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <WarningsStrip warnings={scenarios.warnings} />
    </article>
  );
}
