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
});
