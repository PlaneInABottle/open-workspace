import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type CoordinatorSnapshot } from '../api';
import { CoordinatorSection } from '../features/environments/coordinator-section';

function snapshot(overrides: Partial<CoordinatorSnapshot> = {}): CoordinatorSnapshot {
  return {
    reconcile: { inSync: true, drifts: [] },
    readiness: [],
    explanation: null,
    preflight: { pass: true, gates: [], missing: [] },
    checkpoints: null,
    runs: [],
    scenarios: null,
    warnings: [],
    meta: { producedAt: new Date().toISOString(), snapshotId: 'a3f9c1d2', environment: 'dev' },
    ...overrides,
  };
}

function drifted(): CoordinatorSnapshot {
  return snapshot({
    reconcile: {
      inSync: false,
      drifts: [
        { service: 'api', field: 'durum', expected: 'çalışıyor (dev · portsuz)', actual: 'failed: The last readiness poll did not succeed.' },
        { service: 'web', field: 'durum', expected: 'çalışıyor (dev · 3000 portu)', actual: 'down: No owned process is recorded.' },
      ],
    },
    preflight: {
      pass: false,
      gates: [{ service: 'web', port: 3000, free: false, note: '3000 portu dolu' }],
      missing: ['web: 3000 portu dolu'],
    },
    warnings: ['checkpoint kırpıldı: big (256KB/500 kayıt sınırı)'],
  });
}

function apiReturning(value: CoordinatorSnapshot | Error) {
  return {
    coordinator: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as ApiClient;
}

const REV_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const REV_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';

function checkpointed(): CoordinatorSnapshot {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  return snapshot({
    checkpoints: {
      run: 'demo',
      runs: ['demo'],
      stages: [
        { stage: 'build', status: 'confirmed', staleReason: null, at: twoHoursAgo, sideEffect: null, sideEffectAttempted: null, sideEffectConfirmed: null, scenario: null, attempt: null, stepSignature: null },
        { stage: 'test', status: 'stale', staleReason: 'checkout_rev', at: tenMinutesAgo, sideEffect: null, sideEffectAttempted: null, sideEffectConfirmed: null, scenario: null, attempt: null, stepSignature: null },
        { stage: 'deploy', status: 'not_observed', staleReason: null, at: tenMinutesAgo, sideEffect: null, sideEffectAttempted: null, sideEffectConfirmed: null, scenario: null, attempt: null, stepSignature: null },
      ],
      summary: { confirmed: 1, stale: 1, notObserved: 1 },
      lastVerified: { stage: 'build', at: twoHoursAgo },
      firstGap: { stage: 'test', status: 'stale', staleReason: 'checkout_rev', at: tenMinutesAgo },
      safeNextAction: 'betiği yeniden çalıştır',
      retryHint: false,
    },
    explanation: {
      entries: [
        {
          service: 'api',
          expected: { cmd: 'dev', dir: 'backend', port: 3100 },
          running: { status: 'ready', detail: 'çalışıyor' },
          revShort: REV_A.slice(0, 7), revFull: REV_A, revAt: twoHoursAgo, revDirty: false, revRecorded: true,
          diffs: [], note: 'çalışıyor, bilinen sorun yok',
          artifacts: [], artifactRest: 0,
        },
        {
          service: 'ghost',
          expected: { cmd: 'dev', dir: 'backend', port: null },
          running: null,
          revShort: null, revFull: null, revAt: null, revDirty: false, revRecorded: false,
          diffs: [], note: 'kayıt yok — bu servis için provenance kaydı bulunamadı',
          artifacts: [], artifactRest: 0,
        },
      ],
      revisions: [
        { short: REV_A.slice(0, 7), full: REV_A, at: twoHoursAgo, current: false, recorded: true },
        { short: REV_B.slice(0, 7), full: REV_B, at: tenMinutesAgo, current: true, recorded: false },
      ],
    },
  });
}

describe('CoordinatorSection', () => {
  it('shows sync + launchable badges with a witness line and no raw paths', async () => {
    render(<CoordinatorSection api={apiReturning(snapshot())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(within(section).getByText('eşleşiyor')).toBeInTheDocument();
    expect(within(section).getByText('başlatılabilir')).toBeInTheDocument();
    expect(within(section).getByText('Fark yok — beklenen topoloji ile çalışan durum örtüşüyor.')).toBeInTheDocument();
    expect(within(section).getByText(/#a3f9c1d2/)).toBeInTheDocument();
    expect(within(section).getByText(/koordinatör anlığı/)).toBeInTheDocument();
    // No action controls: read-only, single-shot refresh lives in the top bar.
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\/tmp\/secret-repo/);
  });

  it('lists drifts as expected→actual rows with a keyboard-operated diff modal', async () => {
    render(<CoordinatorSection api={apiReturning(drifted())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(within(section).getByText('kayık (2)')).toBeInTheDocument();
    expect(within(section).getByText(/çalışıyor \(dev · portsuz\) →/)).toBeInTheDocument();
    expect(within(section).getByText('checkpoint kırpıldı: big (256KB/500 kayıt sınırı)')).toBeInTheDocument();

    // Keyboard-only tour: focus the first diff button, open with Enter, close with Esc.
    const diffButtons = within(section).getAllByRole('button', { name: "Diff'i aç" });
    expect(diffButtons).toHaveLength(2);
    diffButtons[0].focus();
    expect(document.activeElement).toBe(diffButtons[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.click(diffButtons[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Fark: api')).toBeInTheDocument();
    expect(within(dialog).getByText('Salt-okunur önizleme — hiçbir şey çalıştırmaz.')).toBeInTheDocument();
    // Focus moved into the modal (close button autofocus).
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tab cycles inside the modal (focus trap): single focusable wraps to itself.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus returns to the opener.
    expect(document.activeElement).toBe(diffButtons[0]);
  });

  it('expands the missing list as an aria-correct accordion', async () => {
    render(<CoordinatorSection api={apiReturning(drifted())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(within(section).getByText('eksikler var (1)')).toBeInTheDocument();
    const toggle = within(section).getByRole('button', { name: /Eksik listesini göster/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(section).getByText('web: 3000 portu dolu')).toBeInTheDocument();
  });

  it('shows one error box when the aggregate is missing or 400', async () => {
    const failing = apiReturning(new ApiError('Environment not found. Propose and set its topology first.', 400));
    const { rerender } = render(<CoordinatorSection api={failing} workspace="Demo" environment="nope" refreshToken={0} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Koordinatör anlığı okunamadı/);
    expect(screen.queryByRole('region', { name: 'Ortam haritası' })).not.toBeInTheDocument();
    rerender(<CoordinatorSection api={failing} workspace="Demo" environment="nope" refreshToken={1} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows explained empty states when runner files are missing', async () => {
    render(<CoordinatorSection api={apiReturning(snapshot())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(await within(section).findByText(/Checkpoint yok/)).toBeInTheDocument();
    expect(within(section).getByText(/Provenance kaydı yok/)).toBeInTheDocument();
  });

  it('tara-test: no bare 8-plus-hex in DOM/title/aria; full rev only in the copy payload', async () => {
    const writeText = vi.fn(async (_payload: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CoordinatorSection api={apiReturning(checkpointed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Provenance kartı');
    await within(section).findByText('Checkpoint çizgisi');

    const rawText = document.body.textContent ?? '';
    // textContent öğe sınırında birleşir ("önce"+"b2c3d4e" gibi yalancı
    // 8'li üretir); düğümleri boşlukla birleştiren tarama gerçek
    // render'ı denetler. Ham textContent ayrıca tam-hash içerirlik
    // için denetlenir (parçalı render bile yakalanır).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    const text = parts.join(' ');
    const ariaTexts = [...document.querySelectorAll('[aria-label]')]
      .map(element => element.getAttribute('aria-label') ?? '').join(' ');
    // Allowlist: `#`+8-hex snapshotId ("anlık" etiketli) ve 7-karakter
    // kısa-hash'ler. Bunlar çıkınca çıplak hash kalmamalı.
    const scanned = `${document.title} ${text} ${ariaTexts}`.replace(/#\s?[0-9a-fA-F]{8}\b/g, '');
    expect(scanned).not.toMatch(/[0-9a-fA-F]{8,}/);
    expect(rawText).not.toContain(REV_A);
    expect(rawText).not.toContain(REV_B);
    // Kısa-hash ve anlık kimliği görünür.
    expect(rawText).toContain(REV_A.slice(0, 7));
    expect(rawText).toContain('#a3f9c1d2');

    // Tam-hash yalnızca kullanıcı-tetikli kopyalamada clipboard'a gider.
    const copy = within(section).getByRole('button', { name: `${REV_A.slice(0, 7)} revini kopyala` });
    copy.focus();
    expect(document.activeElement).toBe(copy);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(REV_A);
    expect(await within(section).findByText('✓ kopyalandı')).toBeInTheDocument();
  });

  it('marks stale checkpoints orange with ages inside a status region', async () => {
    render(<CoordinatorSection api={apiReturning(checkpointed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const strip = await within(section).findByRole('list', { name: 'Checkpoint aşamaları' });
    expect(within(strip).getByText('bayat')).toBeInTheDocument();
    // Mevcut adım (ilk boşluk) liste öğesinde aria-current taşır.
    const current = strip.querySelector('[aria-current="step"]');
    expect(current?.textContent).toMatch(/test/);
    // Bayat kuyruğu: neden + yaş, role=status bölgesinde.
    const status = within(section).getByRole('status');
    expect(within(status).getByText(/İlk boşluk:/)).toBeInTheDocument();
    expect(within(status).getByText('Bayat kuyruğu')).toBeInTheDocument();
    // Neden hem boşluk satırında hem kuyruk maddesinde yazılır.
    expect(within(status).getAllByText(/kod revizyonu değişti/)).toHaveLength(2);
    // Yaş şeritte (×2), boşluk satırında, kuyruk maddesinde ve rev
    // şeridinde yazılır — hepsi aynı kayıt-saatinden.
    expect(within(section).getAllByText(/10 dk önce/)).toHaveLength(5);
    // Kayıtlı rev yaşı tabloda.
    expect(within(section).getByText(/2 sa önce kaydedildi/)).toBeInTheDocument();
    expect(within(section).getByText('kayıtlı')).toBeInTheDocument();
    expect(within(section).getByText('rev kaydı yok')).toBeInTheDocument();
  });

  it('renders safe_next_action as text with no action control', async () => {
    render(<CoordinatorSection api={apiReturning(checkpointed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const action = await within(section).findByText('betiği yeniden çalıştır');
    expect(within(section).getByText(/Bu bir öneri — çalıştırmaz/)).toBeInTheDocument();
    const box = action.closest('div')!;
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
    expect(within(box).queryByRole('link')).not.toBeInTheDocument();
  });

  it('walks the rev strip by keyboard over a scoped table', async () => {
    render(<CoordinatorSection api={apiReturning(checkpointed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const revStrip = await within(section).findByRole('list', { name: 'Rev şeridi' });
    const dots = within(revStrip).getAllByRole('button');
    expect(dots).toHaveLength(2);
    // En yeni rev seçili başlar.
    expect(dots[1]).toHaveAttribute('aria-current', 'true');
    // Klavye turu: Tab odağı alır, Enter seçimi taşır.
    dots[0].focus();
    expect(document.activeElement).toBe(dots[0]);
    fireEvent.keyDown(dots[0], { key: 'Enter' });
    fireEvent.click(dots[0]);
    expect(dots[0]).toHaveAttribute('aria-current', 'true');
    expect(dots[1]).not.toHaveAttribute('aria-current');
    // Beklenen/çalışan gerçek bir tablodur (scope'lu başlıklar).
    const table = within(section).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Servis', 'Beklenen', 'Çalışan', 'Rev']);
    expect(within(table).getByRole('rowheader', { name: 'api' })).toBeInTheDocument();
  });
});

function scenarioed(overrides: Partial<CoordinatorSnapshot> = {}): CoordinatorSnapshot {
  return snapshot({
    checkpoints: {
      run: 'yeni',
      runs: ['yeni', 'eski'],
      stages: [],
      summary: { confirmed: 0, stale: 0, notObserved: 0 },
      lastVerified: null,
      firstGap: null,
      safeNextAction: null,
      retryHint: false,
    },
    runs: ['yeni', 'eski'],
    scenarios: {
      file: 'ow.scenarios.yaml',
      columns: ['local', 'real', 'xyz-unknown'],
      rows: [
        {
          name: 'cart',
          services: ['api'],
          unverifiedServices: [],
          probes: [{ id: 'ready', timeout: '10s' }],
          checkpoints: ['approval'],
          cells: { local: 'pass', real: 'uncovered', 'xyz-unknown': 'unverified' },
        },
        {
          name: 'payment',
          services: ['api', 'foreign'],
          unverifiedServices: ['foreign'],
          probes: [{ id: 'healthy', timeout: '5s' }],
          checkpoints: ['rollout'],
          cells: { local: 'uncovered', real: 'stale', 'xyz-unknown': 'skipped' },
        },
      ],
      warnings: ['cart: unknown field ignored: note'],
      error: null,
    },
    ...overrides,
  });
}

describe('CoordinatorSection scenarios', () => {
  it('renders the matrix as a scoped table with verdict badges and no run action', async () => {
    render(<CoordinatorSection api={apiReturning(scenarioed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const table = await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
      // M1: unknown columns show `unknown`, never the raw name.
      .toEqual(['Senaryo', 'local', 'real', 'unknown']);
    expect(within(table).getByRole('rowheader', { name: /cart/ })).toBeInTheDocument();
    expect(within(table).getByText('geçti')).toBeInTheDocument();
    expect(within(table).getByText('bayat')).toBeInTheDocument();
    expect(within(table).getByText('atlandı')).toBeInTheDocument();
    expect(within(table).getByText('doğrulanamadı')).toBeInTheDocument();
    expect(within(table).getByText('? doğrulanamadı')).toBeInTheDocument();
    // Raw English enum keys never leak into user-facing text (boundary
    // headers render spaced labels; verdict badges render Turkish until E1-b).
    const tableText = table.textContent ?? '';
    for (const raw of ['captured-response', 'pass', 'stale', 'skipped', 'uncovered', 'unverified', 'not_observed']) {
      expect(tableText).not.toContain(raw);
    }
    // Probe ids render, no run control: cells are plain text.
    expect(within(table).getByText(/1 probe \(ready\)/)).toBeInTheDocument();
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(within(table).queryByRole('link')).not.toBeInTheDocument();
    // Section warning strip comes after the matrix (focus order).
    expect(within(section).getByText('cart: unknown field ignored: note')).toBeInTheDocument();
  });

  it('renders M1 boundary labels in English with unknown fallback for unknown columns', async () => {
    const columns = ['real-read-only', 'real-state-changing', 'network-deny', 'subscribed', 'blocked:maintenance', 'unverified', 'xyz-unknown'];
    const cells: Record<string, 'pass'> = {};
    for (const column of columns) cells[column] = 'pass';
    render(<CoordinatorSection api={apiReturning(scenarioed({
      scenarios: {
        file: 'ow.scenarios.yaml',
        columns,
        rows: [
          {
            name: 'cart',
            services: ['api'],
            unverifiedServices: [],
            probes: [{ id: 'ready', timeout: '10s' }],
            checkpoints: ['approval'],
            cells,
          },
        ],
        warnings: [],
        error: null,
      },
    }))} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const table = await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    const headers = within(table).getAllByRole('columnheader').map(cell => cell.textContent);
    expect(headers)
      .toEqual(['Senaryo', 'real read-only', 'real state-changing', 'network deny', 'subscribed', 'blocked', 'unverified', 'unknown']);
    // Headers carry no Turkish: the M1 map renders English labels.
    expect(headers.join(' ')).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it('shows an explained empty state with a setup link when no file is bound', async () => {
    render(<CoordinatorSection api={apiReturning(snapshot())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(await within(section).findByText('Senaryo dosyası bağlı değil.')).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: 'Connect your AI →' });
    expect(link).toHaveAttribute('href', '#setup');
  });

  it('shows an error box without killing sibling panels on a corrupt file', async () => {
    const broken = scenarioed({
      scenarios: { file: 'ow.scenarios.yaml', columns: [], rows: [], warnings: [], error: '`version: 1` gerekli' },
    });
    render(<CoordinatorSection api={apiReturning(broken)} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent(/Senaryo dosyası okunamadı/);
    expect(within(section).getByText('eşleşiyor')).toBeInTheDocument();
    expect(within(section).queryByRole('table', { name: /Senaryo matrisi/ })).not.toBeInTheDocument();
  });

  it('nudges a stale matrix with age inside a status region', async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<CoordinatorSection api={apiReturning(scenarioed({ meta: { producedAt: old, snapshotId: 'a3f9c1d2', environment: 'dev' } }))} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    const nudge = within(section).getByText('bayat olabilir — Yenile?');
    expect(nudge.closest('[role="status"]')).not.toBeNull();
    expect(nudge.parentElement?.textContent).toMatch(/5 dk önce/);
  });

  it('selects a checkpoint run with one user-triggered refetch and resets on environment change', async () => {
    const calls: Array<string | undefined> = [];
    const coordinator = vi.fn(async (_workspace: string, _environment: string, run?: string) => {
      calls.push(run);
      return scenarioed();
    });
    const api = { coordinator } as unknown as ApiClient;
    const { rerender } = render(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const select = await within(section).findByLabelText('Çalışma') as HTMLSelectElement;
    expect([...select.options].map(option => option.text)).toEqual(['en güncel', 'yeni', 'eski']);
    expect(calls).toEqual([undefined]);
    select.focus();
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: 'eski' } });
    await vi.waitFor(() => expect(coordinator).toHaveBeenLastCalledWith('Demo', 'dev', 'eski'));
    expect(calls).toEqual([undefined, 'eski']);
    // Ortam değişince seçim latest'e döner.
    rerender(<CoordinatorSection api={api} workspace="Demo" environment="prod" refreshToken={0} />);
    await vi.waitFor(() => expect(coordinator).toHaveBeenLastCalledWith('Demo', 'prod', undefined));
  });

  it('keeps the run picker on a content-less run and recovers on reselect', async () => {
    const full = scenarioed();
    const empty = scenarioed({ checkpoints: null });
    const coordinator = vi.fn(async (_workspace: string, _environment: string, run?: string) =>
      run === 'eski' ? empty : full);
    const api = { coordinator } as unknown as ApiClient;
    const { rerender } = render(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByLabelText('Çalışma');
    // İçeriksiz run: null iletisi + seçici kalır (dead-end yok).
    fireEvent.change(within(section).getByLabelText('Çalışma'), { target: { value: 'eski' } });
    await within(section).findByText('Checkpoint yok — runner kaydı bulunamadı.');
    const stranded = within(section).getByLabelText('Çalışma') as HTMLSelectElement;
    expect([...stranded.options].map(option => option.value)).toEqual(['', 'yeni', 'eski']);
    expect(stranded.value).toBe('eski');
    // Yenile aynı içeriksiz run'da kalır: ileti + seçici korunur.
    rerender(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={1} />);
    await vi.waitFor(() => expect(coordinator).toHaveBeenLastCalledWith('Demo', 'dev', 'eski'));
    expect(within(section).getByText('Checkpoint yok — runner kaydı bulunamadı.')).toBeInTheDocument();
    expect(within(section).getByLabelText('Çalışma')).toBeInTheDocument();
    // İçerikli run'a dönüş kurtarır: ileti gider, şerit döner.
    fireEvent.change(within(section).getByLabelText('Çalışma'), { target: { value: 'yeni' } });
    await vi.waitFor(() => expect(coordinator).toHaveBeenLastCalledWith('Demo', 'dev', 'yeni'));
    await vi.waitFor(() => expect(within(section).queryByText('Checkpoint yok — runner kaydı bulunamadı.')).not.toBeInTheDocument());
    expect(within(section).getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes('çalışma: yeni'))).toBeInTheDocument();
    expect(within(section).getByLabelText('Çalışma')).toBeInTheDocument();
  });

  it('shows the picker on first load when checkpoints are null but runs are listed', async () => {
    const firstLoad = scenarioed({ checkpoints: null, runs: ['yeni', 'eski'] });
    const full = scenarioed();
    const coordinator = vi.fn(async (_workspace: string, _environment: string, run?: string) =>
      run === undefined ? firstLoad : full);
    const api = { coordinator } as unknown as ApiClient;
    render(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    // Önbellek boştur: liste wire'daki üst-düzey runs'tan gelir.
    const select = await within(section).findByLabelText('Çalışma') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['', 'yeni', 'eski']);
    expect(within(section).getByText('Checkpoint yok — runner kaydı bulunamadı.')).toBeInTheDocument();
    // İçerikli seçim kurtarır (tekil yeniden-çekme).
    fireEvent.change(select, { target: { value: 'yeni' } });
    await vi.waitFor(() => expect(coordinator).toHaveBeenLastCalledWith('Demo', 'dev', 'yeni'));
    await vi.waitFor(() => expect(within(section).queryByText('Checkpoint yok — runner kaydı bulunamadı.')).not.toBeInTheDocument());
  });

  it('tara-test stays green with the matrix mounted', async () => {
    render(<CoordinatorSection api={apiReturning(scenarioed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    const text = parts.join(' ');
    const ariaTexts = [...document.querySelectorAll('[aria-label]')]
      .map(element => element.getAttribute('aria-label') ?? '').join(' ');
    const scanned = `${document.title} ${text} ${ariaTexts}`.replace(/#\s?[0-9a-fA-F]{8}\b/g, '');
    expect(scanned).not.toMatch(/[0-9a-fA-F]{8,}/);
  });

  it('shows no Source column on old wire without overlay tags (strip untouched)', async () => {
    render(<CoordinatorSection api={apiReturning(scenarioed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const table = await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Senaryo', 'local', 'real', 'unknown']);
    expect(within(table).queryByText('overlay active:')).not.toBeInTheDocument();
  });

  it('shows the Source badge column + banner when the overlay applied', async () => {
    const overlaid = scenarioed({
      scenarios: {
        file: 'ow.scenarios.yaml',
        columns: ['local', 'real'],
        rows: [
          {
            name: 'cart',
            services: ['api'],
            unverifiedServices: [],
            probes: [{ id: 'ready', timeout: '10s' }],
            checkpoints: ['approval'],
            cells: { local: 'pass', real: 'uncovered' },
          },
          {
            name: 'payment',
            services: ['api'],
            unverifiedServices: [],
            probes: [{ id: 'healthy', timeout: '5s' }],
            checkpoints: ['rollout'],
            cells: { local: 'uncovered', real: 'stale' },
          },
        ],
        warnings: [],
        error: null,
        overlayApplied: true,
        overlayFile: 'boundaries.local.yaml',
        boundarySources: [
          { scenario: 'cart', boundary: 'local', source: 'local' },
        ],
        overlayError: null,
      },
    });
    render(<CoordinatorSection api={apiReturning(overlaid)} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const table = await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Senaryo', 'local', 'real', 'Source']);
    const rows = within(table).getAllByRole('row');
    expect(rows[1].textContent).toContain('local');
    expect(rows[2].textContent).toContain('base');
    const banner = within(section).getByRole('status', { name: '' });
    expect(banner.textContent).toContain('overlay active: boundaries.local.yaml');
  });

  it('shows the overlay error box while the base matrix still renders', async () => {
    const refused = scenarioed({
      scenarios: {
        file: 'ow.scenarios.yaml',
        columns: ['local'],
        rows: [
          {
            name: 'cart',
            services: ['api'],
            unverifiedServices: [],
            probes: [{ id: 'ready', timeout: '10s' }],
            checkpoints: ['approval'],
            cells: { local: 'pass' },
          },
        ],
        warnings: [],
        error: null,
        overlayApplied: false,
        overlayFile: null,
        boundarySources: [],
        overlayError: 'overlay-dangling: ghost (refused)',
      },
    });
    render(<CoordinatorSection api={apiReturning(refused)} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent(/Overlay ignored: overlay-dangling: ghost \(refused\)/);
    expect(await within(section).findByRole('table', { name: /Senaryo matrisi/ })).toBeInTheDocument();
    expect(within(section).getByText('eşleşiyor')).toBeInTheDocument();
  });
});

function flagged(): CoordinatorSnapshot {
  const at = new Date().toISOString();
  return snapshot({
    checkpoints: {
      run: 'gece-attempt2',
      runs: ['gece-attempt2'],
      stages: [
        { stage: 'build', status: 'confirmed', staleReason: null, at, sideEffect: 'attempted', sideEffectAttempted: 2, sideEffectConfirmed: null, scenario: 'gece', attempt: 1, stepSignature: 'build-imza' },
        { stage: 'test', status: 'confirmed', staleReason: null, at, sideEffect: 'none', sideEffectAttempted: null, sideEffectConfirmed: null, scenario: 'gece', attempt: 2, stepSignature: null },
        { stage: 'deploy', status: 'not_observed', staleReason: null, at, sideEffect: null, sideEffectAttempted: null, sideEffectConfirmed: null, scenario: null, attempt: null, stepSignature: null },
      ],
      summary: { confirmed: 2, stale: 0, notObserved: 1 },
      lastVerified: { stage: 'test', at },
      firstGap: { stage: 'deploy', status: 'not_observed', staleReason: null, at },
      safeNextAction: null,
      retryHint: true,
    },
  });
}

describe('CoordinatorSection M-A flags', () => {
  it('renders per-stage side-effect flags with counts and bilinmiyor for missing', async () => {
    render(<CoordinatorSection api={apiReturning(flagged())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Checkpoint çizgisi');
    expect(within(section).getByText(/yan-etki: build \(denendi, denenen: 2\)/)).toBeInTheDocument();
    expect(within(section).getByText(/yan-etki: test \(yok\)/)).toBeInTheDocument();
    expect(within(section).getByText(/yan-etki: deploy \(bilinmiyor\)/)).toBeInTheDocument();
    // Ham İngilizce enum kullanıcıya dönük metinde görünmez.
    const text = section.textContent ?? '';
    expect(text).not.toContain('attempted');
    expect(text).not.toContain('side_effect');
  });

  it('renders the locked reconcile-before-retry hint as text with no action control', async () => {
    render(<CoordinatorSection api={apiReturning(flagged())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const hint = await within(section).findByText('tekrar-öncesi: ow reconcile --check');
    expect(hint).toBeInTheDocument();
    const box = hint.closest('div')!;
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
    expect(within(box).queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the scenario→attempt tree with locked vocab and doğrulanmadı', async () => {
    render(<CoordinatorSection api={apiReturning(flagged())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const tree = await within(section).findByRole('list', { name: 'Deneme ağacı' });
    expect(within(tree).getByText(/senaryo: gece/)).toBeInTheDocument();
    expect(within(tree).getByText(/deneme 1: build/)).toBeInTheDocument();
    expect(within(tree).getByText(/deneme 2: test/)).toBeInTheDocument();
    expect(within(tree).getByText(/doğrulanmadı/)).toBeInTheDocument();
    // Sahipsiz zarf ağaca girmez (düz listede kalır).
    expect(within(tree).queryByText(/deploy/)).not.toBeInTheDocument();
  });
});

function artifacted(): CoordinatorSnapshot {
  const at = new Date().toISOString();
  return snapshot({
    checkpoints: {
      run: 'demo',
      runs: ['demo'],
      stages: [
        { stage: 'build', status: 'confirmed', staleReason: null, at, sideEffect: null, sideEffectAttempted: null, sideEffectConfirmed: null, scenario: null, attempt: null, stepSignature: null },
      ],
      summary: { confirmed: 1, stale: 0, notObserved: 0 },
      lastVerified: { stage: 'build', at },
      firstGap: null,
      safeNextAction: null,
      retryHint: false,
    },
    explanation: {
      entries: [
        {
          service: 'api',
          expected: { cmd: 'dev', dir: 'backend', port: null },
          running: { status: 'ready', detail: 'çalışıyor' },
          revShort: null, revFull: null, revAt: null, revDirty: false, revRecorded: false,
          diffs: [], note: 'çalışıyor, bilinen sorun yok',
          artifacts: [
            { base: 'api.jar', digest: 'a1b2c3d4' },
            { base: 'extra.jar', digest: 'ffffffff' },
          ],
          artifactRest: 3,
        },
      ],
      revisions: [],
    },
  });
}

describe('CoordinatorSection M-C artifacts', () => {
  it('renders basename@short-8 chips with a rest count and no full digest', async () => {
    render(<CoordinatorSection api={apiReturning(artifacted())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Provenance kartı');
    expect(within(section).getByText('api.jar@a1b2c3d4')).toBeInTheDocument();
    expect(within(section).getByText('extra.jar@ffffffff')).toBeInTheDocument();
    expect(within(section).getByText('+3 daha')).toBeInTheDocument();
    // Tam-digest/argv ASLA DOM'da yok (tel zaten indirgenmiş taşır).
    const rawText = document.body.textContent ?? '';
    expect(rawText).not.toMatch(/[0-9a-fA-F]{32,}/);
  });

  it('tara-test stays green with artifact chips mounted', async () => {
    render(<CoordinatorSection api={apiReturning(artifacted())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Provenance kartı');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    const text = parts.join(' ');
    const ariaTexts = [...document.querySelectorAll('[aria-label]')]
      .map(element => element.getAttribute('aria-label') ?? '').join(' ');
    // Kasıtlı kısa-8 çipler düğüm-bazında ayıklanır (tam-hash koruması sürer).
    const chips = [...document.querySelectorAll('[data-artifact-digest]')].map(element => element.textContent ?? '');
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toMatch(/^[^@/]+@[0-9a-fA-F]{8}$/);
    let scanned = `${document.title} ${text} ${ariaTexts}`.replace(/#\s?[0-9a-fA-F]{8}\b/g, '');
    for (const chip of chips) scanned = scanned.replace(chip, '');
    expect(scanned).not.toMatch(/[0-9a-fA-F]{8,}/);
  });
});

describe('M1 worktree identity (chip + wt: filter, conditional)', () => {
  const WT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  function twoRoot(): CoordinatorSnapshot {
    return snapshot({
      readiness: [
        { serviceId: 'api', name: 'api', dir: 'wt-a', status: 'ready', detail: 'ok', lastPoll: null, worktree: { rootBase: 'wt-a', revShort: WT_A.slice(0, 7) } },
        { serviceId: 'web', name: 'web', dir: 'wt-b', status: 'ready', detail: 'ok', lastPoll: null, worktree: { rootBase: 'wt-b', revShort: null } },
      ],
      explanation: {
        entries: [
          {
            service: 'api',
            expected: { cmd: 'dev', dir: 'wt-a', port: 3100 },
            running: { status: 'ready', detail: 'çalışıyor' },
            revShort: WT_A.slice(0, 7), revFull: WT_A, revAt: new Date().toISOString(), revDirty: false, revRecorded: true,
            diffs: [], note: 'çalışıyor, bilinen sorun yok',
            artifacts: [], artifactRest: 0,
          },
          {
            service: 'web',
            expected: { cmd: 'dev', dir: 'wt-b', port: null },
            running: { status: 'ready', detail: 'çalışıyor' },
            revShort: null, revFull: null, revAt: null, revDirty: false, revRecorded: false,
            diffs: [], note: 'çalışıyor, bilinen sorun yok',
            artifacts: [], artifactRest: 0,
          },
        ],
        revisions: [{ short: WT_A.slice(0, 7), full: WT_A, at: new Date().toISOString(), current: true, recorded: true }],
      },
    });
  }

  it('shows basename@short7 chips on two roots and narrows with wt:<base>', async () => {
    render(<CoordinatorSection api={apiReturning(twoRoot())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Provenance kartı');
    const chipA = within(section).getByText(`wt-a@${WT_A.slice(0, 7)}`);
    const chipB = within(section).getByText('wt-b');
    expect(chipA.textContent).toMatch(/^[^/\\@]{1,64}(@[0-9a-fA-F]{7})?$/);
    expect(chipB.textContent).toMatch(/^[^/\\@]{1,64}(@[0-9a-fA-F]{7})?$/);
    // Full rev travels only as the copy-button clipboard payload — never DOM text.
    expect(document.body.textContent).not.toContain(WT_A);
    // Filter narrows to the matching root only.
    const filter = within(section).getByLabelText('Worktree filtresi (wt:<ad>)');
    fireEvent.change(filter, { target: { value: 'wt:wt-a' } });
    expect(within(section).queryByText(`wt-a@${WT_A.slice(0, 7)}`)).toBeInTheDocument();
    expect(within(section).queryByText('wt-b')).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: '' } });
    expect(within(section).getByText('wt-b')).toBeInTheDocument();
  });

  it('hides chips and filter on single-root snapshots (NO-WORKTREE-NO-FRICTION)', async () => {
    // checkpointed() carries revs but no readiness worktree → no discriminating info.
    render(<CoordinatorSection api={apiReturning(checkpointed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    await within(section).findByText('Provenance kartı');
    expect(within(section).queryByLabelText('Worktree filtresi (wt:<ad>)')).not.toBeInTheDocument();
    expect(within(section).queryByText(/wt:|backend@/)).not.toBeInTheDocument();
  });
});

describe('M2 ownership ledger (read-only list, conditional)', () => {
  const WT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  function ledgered(): CoordinatorSnapshot {
    return snapshot({
      worktrees: [
        { rootBase: 'wt-a', revShort: WT_A.slice(0, 7), branch: 'main', lock: 'live', liveServices: ['api', 'web'], state: 'ok' },
        { rootBase: 'wt-b', revShort: null, branch: null, lock: 'stale', liveServices: [], state: 'corrupt' },
      ],
    });
  }

  function ledgerArticle(section: HTMLElement): HTMLElement | null {
    return within(section).getByText('Worktree sahipliği').closest('article');
  }

  it('lists per-root lock states with rev chips and no action buttons', async () => {
    render(<CoordinatorSection api={apiReturning(ledgered())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const ledger = ledgerArticle(section);
    expect(ledger).not.toBeNull();
    expect(within(ledger as HTMLElement).getByText('wt-a')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('@a1b2c3d')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('canlı')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText(/dal: main/)).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText(/kayıtlı: api, web/)).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('wt-b')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('bayat')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText(/bozuk kayıt/)).toBeInTheDocument();
    // Read-only: no buttons inside the ledger (copy buttons live in provenance only).
    expect(within(ledger as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    // Full rev never reaches the DOM (short-7 only).
    expect(document.body.textContent).not.toContain(WT_A);
  });

  it('masks hostile ledger strings and stays hidden without worktrees', async () => {
    const hostile = snapshot({
      worktrees: [
        { rootBase: '***', revShort: null, branch: '***', lock: 'absent', liveServices: ['***'], state: 'missing' },
      ],
    });
    const { rerender } = render(<CoordinatorSection api={apiReturning(hostile)} workspace="Demo" environment="dev" refreshToken={0} />);
    let section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(document.body.textContent).not.toContain('hunter2');
    expect(within(section).getByText('Worktree sahipliği')).toBeInTheDocument();
    // Re-select with a worktree-less snapshot: the ledger unmounts (stale
    // responses cannot linger past newer data).
    rerender(<CoordinatorSection api={apiReturning(snapshot())} workspace="Demo" environment="dev" refreshToken={1} />);
    section = await screen.findByRole('region', { name: 'Koordinatör' });
    expect(within(section).queryByText('Worktree sahipliği')).not.toBeInTheDocument();
  });
});

describe('CoordinatorSection readiness strip', () => {
  function stripped(overrides: Partial<CoordinatorSnapshot> = {}): CoordinatorSnapshot {
    return snapshot({
      scenarios: {
        file: 'ow.scenarios.yaml',
        columns: ['real-read-only', 'network-deny'],
        rows: [],
        warnings: [],
        error: null,
      },
      boundaryList: [
        { boundary: 'real-read-only', status: 'pass' },
        { boundary: 'network-deny', status: 'skipped' },
      ],
      lastRun: { id: 'demo', at: new Date().toISOString(), pass: true },
      readinessGate: { pass: true, missing: [] },
      ...overrides,
    });
  }

  it('renders boundary chips, last-run line, and gate line with data', async () => {
    render(<CoordinatorSection api={apiReturning(stripped())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const strip = within(section).getByRole('article', { name: 'Readiness strip' });
    expect(within(strip).getByText('real read-only')).toBeInTheDocument();
    expect(within(strip).getByText('network deny')).toBeInTheDocument();
    expect(within(strip).getByText(/Last run: demo/)).toBeInTheDocument();
    expect(within(strip).getByText('Readiness gate: pass')).toBeInTheDocument();
    expect(strip.getAttribute('class')).not.toContain('opacity-60');
  });

  it('renders an unmeasured placeholder without wire sections and never crashes', async () => {
    render(<CoordinatorSection api={apiReturning(snapshot())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const strip = within(section).getByRole('article', { name: 'Readiness strip' });
    expect(within(strip).getByText(/unmeasured/)).toBeInTheDocument();
    expect(within(strip).queryByRole('list')).not.toBeInTheDocument();
    expect(within(strip).queryByRole('button')).not.toBeInTheDocument();
    expect(within(strip).queryByRole('link')).not.toBeInTheDocument();
  });

  it('dims stale evidence and keeps the failing gate visible', async () => {
    render(<CoordinatorSection api={apiReturning(stripped({
      boundaryList: [{ boundary: 'real-read-only', status: 'stale' }],
      lastRun: null,
      readinessGate: { pass: false, missing: ['a: down'] },
    }))} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const strip = within(section).getByRole('article', { name: 'Readiness strip' });
    expect(strip.getAttribute('class')).toContain('opacity-60');
    expect(within(strip).getByText('stale evidence')).toBeInTheDocument();
    expect(within(strip).getByText('Last run: no record')).toBeInTheDocument();
    expect(within(strip).getByText('Readiness gate: fail (1 missing)')).toBeInTheDocument();
  });

  it('fetches once per mount with no polling', async () => {
    const coordinator = vi.fn(async () => stripped());
    const api = { coordinator } as unknown as ApiClient;
    const { rerender } = render(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={0} />);
    await screen.findByRole('article', { name: 'Readiness strip' });
    expect(coordinator).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(coordinator).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    rerender(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={0} />);
    expect(coordinator).toHaveBeenCalledTimes(1);
    rerender(<CoordinatorSection api={api} workspace="Demo" environment="dev" refreshToken={1} />);
    await screen.findByRole('article', { name: 'Readiness strip' });
    expect(coordinator).toHaveBeenCalledTimes(2);
  });
});
