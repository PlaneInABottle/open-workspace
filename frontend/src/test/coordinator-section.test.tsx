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
        { stage: 'build', status: 'confirmed', staleReason: null, at: twoHoursAgo },
        { stage: 'test', status: 'stale', staleReason: 'checkout_rev', at: tenMinutesAgo },
        { stage: 'deploy', status: 'not_observed', staleReason: null, at: tenMinutesAgo },
      ],
      summary: { confirmed: 1, stale: 1, notObserved: 1 },
      lastVerified: { stage: 'build', at: twoHoursAgo },
      firstGap: { stage: 'test', status: 'stale', staleReason: 'checkout_rev', at: tenMinutesAgo },
      safeNextAction: 'betiği yeniden çalıştır',
    },
    explanation: {
      entries: [
        {
          service: 'api',
          expected: { cmd: 'dev', dir: 'backend', port: 3100 },
          running: { status: 'ready', detail: 'çalışıyor' },
          revShort: REV_A.slice(0, 7), revFull: REV_A, revAt: twoHoursAgo, revDirty: false, revRecorded: true,
          diffs: [], note: 'çalışıyor, bilinen sorun yok',
        },
        {
          service: 'ghost',
          expected: { cmd: 'dev', dir: 'backend', port: null },
          running: null,
          revShort: null, revFull: null, revAt: null, revDirty: false, revRecorded: false,
          diffs: [], note: 'kayıt yok — bu servis için provenance kaydı bulunamadı',
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
    },
    runs: ['yeni', 'eski'],
    scenarios: {
      file: 'ow.scenarios.yaml',
      columns: ['local', 'real', 'uydurma'],
      rows: [
        {
          name: 'sepet',
          services: ['api'],
          unverifiedServices: [],
          probes: [{ id: 'hazir', timeout: '10s' }],
          checkpoints: ['onay'],
          cells: { local: 'pass', real: 'uncovered', uydurma: 'unverified' },
        },
        {
          name: 'odeme',
          services: ['api', 'yabanci'],
          unverifiedServices: ['yabanci'],
          probes: [{ id: 'saglik', timeout: '5s' }],
          checkpoints: ['dagitim'],
          cells: { local: 'uncovered', real: 'stale', uydurma: 'skipped' },
        },
      ],
      warnings: ['sepet: bilinmeyen alan yoksayıldı: not'],
      error: null,
    },
    ...overrides,
  });
}

describe('CoordinatorSection scenarios', () => {
  it('renders the matrix as a scoped table with Turkish verdicts and no run action', async () => {
    render(<CoordinatorSection api={apiReturning(scenarioed())} workspace="Demo" environment="dev" refreshToken={0} />);
    const section = await screen.findByRole('region', { name: 'Koordinatör' });
    const table = await within(section).findByRole('table', { name: /Senaryo matrisi/ });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Senaryo', 'yerel', 'gerçek', 'uydurma']);
    expect(within(table).getByRole('rowheader', { name: /sepet/ })).toBeInTheDocument();
    expect(within(table).getByText('geçti')).toBeInTheDocument();
    expect(within(table).getByText('bayat')).toBeInTheDocument();
    expect(within(table).getByText('atlandı')).toBeInTheDocument();
    expect(within(table).getByText('doğrulanamadı')).toBeInTheDocument();
    expect(within(table).getByText('? doğrulanamadı')).toBeInTheDocument();
    // Ham İngilizce enumlar kullanıcıya dönük metinde görünmez.
    const tableText = table.textContent ?? '';
    for (const raw of ['local', 'real', 'captured-response', 'pass', 'stale', 'skipped', 'uncovered', 'unverified', 'not_observed']) {
      expect(tableText).not.toContain(raw);
    }
    // Probe id'leri görünür, çalıştırma denetimi yok: hücreler salt-metin.
    expect(within(table).getByText(/1 probe \(hazir\)/)).toBeInTheDocument();
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(within(table).queryByRole('link')).not.toBeInTheDocument();
    // Bölüm uyarı şeridi matristen sonra gelir (odak sırası).
    expect(within(section).getByText('sepet: bilinmeyen alan yoksayıldı: not')).toBeInTheDocument();
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
});
