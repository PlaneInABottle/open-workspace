/**
 * Dashboard-only coordinator snapshot (D3: P1 ortam haritası + P2 preflight
 * + P3 checkpoint çizgisi + P4 provenance kartı + P5 senaryo matrisi).
 *
 * Salt-okunur aggregate: kayıtlı topoloji + canlı durumdan reconcile
 * (eşleşiyor/kayık) + port preflight + runner-dosya bounded okuma
 * (frozen root, symlink-izlenmez, 256KB/500 cap, seçili-run okuma,
 * fail-closed + warnings[]).
 *
 * Kaynaklar (hepsi kayıtlı dosya; canlı exec YOK, CLI davranış değişikliği
 * YOK):
 * - P3: `.ow/checkpoints/<run>.jsonl` seçili run — `?run=` adı (allowlist;
 *   boş/geçersiz/yok → en yeni İÇERİKLİ dosya + uyarı), açık istenen
 *   boş/bozuk dosya → bölüm null + tarama uyarısı (fallback yok).
 *   Zarf `at` = stage yaşı kaynağı (D2 kararı: envelope `at` +
 *   provenance `recordedAt` dışında saat yoktur).
 * - P4: `.ow/supervisor.json` spawn-kayıtları (provenance checkout rev +
 *   recordedAt = kayıtlı-rev yaşı kaynağı) + store topolojisi (beklenen) +
 *   environmentStatus (çalışan). Kaydedilmemiş rev'e "canlıda farklı"
 *   denmez — canlı checkout'u okumak git exec ister (fail-closed:
 *   "doğrulanamadı").
 * - P5: `<root>/ow.scenarios.yaml` v1 (subset-YAML aynası; argv/target
 *   ham değerleri dosyada kalır) + store topolojisi (referans kontrolü) +
 *   seçili run tazeliği (hücre hükmü).
 *
 * Secret disiplini: tüm serbest-metin alanlar wire'a yazılmadan önce
 * maskelenir (aşağıdaki maske, cli/up-reconcile.ts + cli/up-evidence.ts
 * kurallarının node-tarafı aynasıdır — CLI bun-only olduğu için import
 * edilmez, davranış değişikliği yok); mutlak path'ler basename'e iner.
 * Zarf normalizasyonu + tazelik de aynı aynalama disiplinindedir
 * (cli/up-evidence.ts + cli/up-checkpoints.ts).
 * Tam rev wire'da taşınır (kopyala-butonu clipboard payload'ı) ama ASLA
 * render edilmez — DOM/title/aria'da yalnızca kısa-hash (7) görünür.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Store, resolveEnvironmentRecord, resolveWorkspaceRecord, type EnvironmentRecord } from './store.js';
import { maxProjectRoots } from './project-roots.js';
import { verifyMessages } from './verify.js';
import {
  environmentMessages,
  environmentStatus,
  probeTcpPort,
  suggestFreePort,
  type EnvironmentStatus,
} from './environment.js';

// --- Secret maskesi (cli/up-reconcile.ts B3 listesinin aynası) -------------

const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i;
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/;

function isSecretFlagToken(token: string): boolean {
  return /^(-{1,2})?[A-Za-z0-9_-]*(password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization)$/i.test(token)
    && !token.includes('=');
}

function maskSecretToken(token: string, prevIsSecretFlag: boolean): string {
  if (token.length === 0) return token;
  const eq = token.indexOf('=');
  if (eq > 0) {
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (SECRET_WORD.test(key) || SECRET_WORD.test(value) || /^[0-9a-fA-F]{32,}$/.test(value) || PROVIDER_PREFIX.test(value)) {
      return `${key}=***`;
    }
    return token;
  }
  if (prevIsSecretFlag) return '***';
  if (/^(-{1,2}[A-Za-z0-9_-]*password|^(-{1,2}[A-Za-z0-9_-]*secret)|(-{1,2}[A-Za-z0-9_-]*token))$/i.test(token)) return token;
  if (SECRET_WORD.test(token) || /^[0-9a-fA-F]{32,}$/.test(token) || PROVIDER_PREFIX.test(token)) return '***';
  return token;
}

/** Serbest-metin secret maskesi: önce Bearer gövdesi, sonra boşluk-korumalı yürüyüş. */
export function maskSecrets(text: string): string {
  const afterBearer = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
  const looksSecretKey = (token: string): boolean =>
    SECRET_WORD.test(token.replace(/^["']+|["':=]+$/g, ''));
  const maskWord = (token: string): string => {
    const match = /^(\W*)(.*?)(\W*)$/.exec(token);
    if (!match || match[2].length === 0) return '***';
    return `${match[1]}***${match[3]}`;
  };
  const parts = afterBearer.split(/(\s+)/);
  let prev = '';
  let maskNext = false;
  return parts
    .map(part => {
      if (part.length === 0 || /^\s+$/.test(part)) return part;
      let masked: string;
      if (maskNext) {
        masked = maskWord(part);
        maskNext = false;
      } else if (part.includes('=') && !/^[:=]+$/.test(part)) {
        masked = maskSecretToken(part, isSecretFlagToken(prev));
      } else if (/^[:=]+$/.test(part)) {
        if (looksSecretKey(prev)) maskNext = true;
        masked = part;
      } else if (/[:=]["']?$/.test(part)) {
        if (looksSecretKey(part)) maskNext = true;
        masked = part;
      } else if (isSecretFlagToken(part)) {
        masked = part;
        maskNext = true;
      } else if (
        SECRET_WORD.test(part)
        || /^[0-9a-fA-F]{32,}$/.test(part)
        || PROVIDER_PREFIX.test(part)
      ) {
        masked = maskWord(part);
      } else {
        masked = part;
      }
      prev = part;
      return masked;
    })
    .join('');
}

// --- Wire tipleri ------------------------------------------------------------

export interface CoordinatorDrift {
  service: string;
  field: string;
  expected: string;
  actual: string;
}

export interface CoordinatorReconcile {
  inSync: boolean;
  drifts: CoordinatorDrift[];
}

export interface CoordinatorReadinessEntry {
  serviceId: string;
  name: string;
  /** Kayıtlı kökün dizin adı (basename) — tam path asla wire'a girmez. */
  dir: string | null;
  status: string;
  detail: string;
  lastPoll: EnvironmentRecord['owned'][number]['lastPoll'];
  /** Worktree identity (additive-optional): carried only when >1 root is
   * registered; absent from single-root snapshots.
   * `revShort` is null when missing → UI renders a basename-only chip. */
  worktree?: { rootBase: string; revShort: string | null };
}

export interface CoordinatorPreflightGate {
  service: string;
  port: number | null;
  free: boolean;
  note: string;
}

export interface CoordinatorPreflight {
  pass: boolean;
  gates: CoordinatorPreflightGate[];
  missing: string[];
}

export interface CoordinatorMeta {
  producedAt: string;
  snapshotId: string;
  environment: string;
}

export type CheckpointStageStatus = 'confirmed' | 'not_observed' | 'stale';

export interface CoordinatorCheckpointStage {
  stage: string;
  status: CheckpointStageStatus;
  /** Ham İngilizce enum (UI Türkçe'ye eşler — §3). */
  staleReason: string | null;
  /** Zarf kayıt saati (stage yaşı kaynağı). */
  at: string;
  /** M-A (#2): ham İngilizce bayrak (`null` ≡ eksik → UI `bilinmiyor`). */
  sideEffect: string | null;
  sideEffectAttempted: number | null;
  sideEffectConfirmed: number | null;
  /** M-A (#3): soy (ikisi de `null` → sahipsiz, ağaç-dışı). */
  scenario: string | null;
  attempt: number | null;
  stepSignature: string | null;
}

export interface CoordinatorCheckpoints {
  /** Dosya adı (path değil) — seçili run (?run= yoksa latest). */
  run: string;
  /** Keşfedilen run adları (yeni→eski); ?run= seçimi buradan yapılır. */
  runs: string[];
  stages: CoordinatorCheckpointStage[];
  summary: { confirmed: number; stale: number; notObserved: number };
  lastVerified: { stage: string; at: string } | null;
  firstGap: { stage: string; status: CheckpointStageStatus; staleReason: string | null; at: string } | null;
  /** Salt-metin öneri (butona bağlanmaz). */
  safeNextAction: string | null;
  /** M-A (#2): doğrulanmamış-deneme varsa true → UI kilitli
   * `tekrar-öncesi: ow reconcile --check` metnini gösterir (eylem yok). */
  retryHint: boolean;
}

export interface CoordinatorRevision {
  /** Ekrandaki tek temsil (7 karakter). */
  short: string;
  /** YALNIZCA kopyala-butonu clipboard payload'ı — DOM'a yazılmaz. */
  full: string;
  /** İlk görülme kayıt saati (zarf `at` / provenance `recordedAt`). */
  at: string | null;
  // NOT: `services` alanı bilerek yok — şerit etiketi kısa-hash+yaştır
  // (§3); zarf rev'lerinin servis atfı zaten yoktu, supervisor tarafı tek
  // ad taşıyordu (kayıp-bilgi). D3 (P5 senaryo matrisi) rev-servis
  // eşlemesi istemez; ihtiyaç doğarsa wire'a eklenir.
  /** En yeni rev (şeritte vurgulu). */
  current: boolean;
  /** Supervisor spawn-kaydıyla eşleşiyor. */
  recorded: boolean;
}

export interface CoordinatorExplanationEntry {
  service: string;
  expected: { cmd: string | null; dir: string | null; port: number | null } | null;
  running: { status: string; detail: string } | null;
  /** Rev satırı asla çıplak hash değil: kısa + rozet + yaş UI'da birleşir. */
  revShort: string | null;
  revFull: string | null;
  revAt: string | null;
  revDirty: boolean;
  revRecorded: boolean;
  diffs: string[];
  note: string;
  /** M-C derleme kimliği (kayıtlı haritadan indirgenmiş: maskeli-basename +
   * kısa-8, sıralı ilk 32; tam-yol/tam-digest tele asla çıkmaz). */
  artifacts: { base: string; digest: string }[];
  artifactRest: number;
}

export type ScenarioVerdict = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';

/** M9 overlay source tag (mirror of the CLI `boundarySources` entries:
 * per-scenario boundary provenance — `base` or the `local` convention;
 * there is no flag channel server-side by design). */
export interface OverlayBoundarySource {
  scenario: string;
  boundary: string;
  source: string;
}

export interface ScenarioMatrixRow {
  name: string;
  services: string[];
  /** Topolojide karşılığı yok (UNVERIFIED) — sarı rozetle işaretlenir. */
  unverifiedServices: string[];
  /** YALNIZCA id + timeout: probe argv dosyada kalır, wire'a çıkmaz. */
  probes: { id: string; timeout: string }[];
  checkpoints: string[];
  /** Sütun adından hücre hükmüne (columns sırası UI'dadır). */
  cells: Record<string, ScenarioVerdict>;
}

export interface CoordinatorScenarios {
  /** Dosya adı (path değil) — köklerde hep `ow.scenarios.yaml`. */
  file: string;
  /** Sınır sütunları: bilinen sıra önce, bilinmeyenler alfabetik. */
  columns: string[];
  rows: ScenarioMatrixRow[];
  /** Bölüm uyarıları (şema uyarıları + yineltiler). */
  warnings: string[];
  /** Bozuk dosya: satırlar boş + neden burada (diğer paneller sağlam). */
  error: string | null;
  /** M9 overlay source tags (additive-optional): present only when the
   * local convention applied in at least one root; absent keeps old
   * readers byte-identical. */
  overlayApplied?: boolean;
  overlayFile?: string | null;
  boundarySources?: OverlayBoundarySource[];
  /** M9 invalid-overlay box (additive-optional): the base matrix still
   * renders; the message names the refusal (never a crash). */
  overlayError?: string | null;
}

export interface CoordinatorExplanation {
  entries: CoordinatorExplanationEntry[];
  revisions: CoordinatorRevision[];
}

/** Readiness-strip chip: boundary name (masked wire value) + rolled-up
 * cell verdict across matrix rows. */
export type BoundaryChipStatus = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';
export interface CoordinatorBoundaryChip {
  boundary: string;
  status: BoundaryChipStatus;
}

/** Readiness-strip last-run line: selected run id, last verified time
 * (null when nothing verified), and the all-green verdict. */
export interface CoordinatorLastRun {
  id: string;
  at: string | null;
  pass: boolean;
}

/** Readiness-strip gate line: preflight pass + missing entries. */
export interface CoordinatorReadinessGate {
  pass: boolean;
  missing: string[];
}

export interface CoordinatorSnapshot {
  reconcile: CoordinatorReconcile;
  readiness: CoordinatorReadinessEntry[];
  /** Kayıt yoksa null → UI "provenance kaydı yok" gösterir. */
  explanation: CoordinatorExplanation | null;
  preflight: CoordinatorPreflight;
  /** Kayıt yoksa/bozuksa null → UI "checkpoint yok" gösterir. */
  checkpoints: CoordinatorCheckpoints | null;
  /**
   * Keşfedilen checkpoint run adları (yeni→eski) — checkpoints null iken
   * bile dolu olabilir; null dalındaki çalışma seçici buradan beslenir.
   * Salt-okunur liste, tekil `?run=` yeniden-çekmede kullanılır.
   */
  runs: string[];
  /**
   * Dosya yoksa null → UI "senaryo dosyası bağlı değil" gösterir.
   * Bozuk dosya: error'lu nesne (hata kutusu; diğer paneller sağlam).
   */
  scenarios: CoordinatorScenarios | null;
  /** Readiness strip (M8, additive-optional): present only when a
   * scenarios file is bound (null file keeps the wire byte-identical).
   * Absent sections render the strip `unmeasured` placeholder, never crash. */
  boundaryList?: CoordinatorBoundaryChip[];
  lastRun?: CoordinatorLastRun | null;
  readinessGate?: CoordinatorReadinessGate | null;
  /** Ownership ledger (additive-optional): carried only when >1 root is
   * registered; absent from single-root snapshots.
   * Absence is the "no record" branch in the UI (old readers skip it). */
  worktrees?: CoordinatorWorktreeEntry[];
  warnings: string[];
  meta: CoordinatorMeta;
}

// --- Checkpoint zarf aynası (cli/up-evidence.ts + cli/up-checkpoints.ts) ----
// Şekil-sıkı fail-closed: bozuk satır bölümü öldürmez (corrupt sayılır).

const ENVELOPE_BY = new Set(['runner', 'ow-preflight', 'ow-reconcile', 'ow-probe']);
const STALE_REASONS = new Set(['script_hash', 'checkout_rev', 'runtime', 'missing_basis']);
const SAFE_NEXT_ACTION_MAX = 512;
const REV_MAX_CHARS = 64;
// M-A (#2/#3) cap'leri — CLI `cli/up-evidence.ts` kilidiyle birebir.
const SIDE_EFFECTS = new Set(['none', 'attempted', 'confirmed', 'unknown']);
const SIDE_EFFECT_COUNT_MAX = 999999;
const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ATTEMPT_MIN = 1;
const ATTEMPT_MAX = 999;
const STEP_SIGNATURE_MAX = 128;

export interface ParsedCheckpointEnvelope {
  stage: string;
  status: CheckpointStageStatus;
  staleReason: string | null;
  safeNextAction: string | null;
  at: string;
  /**
   * M-B (#5) kod-haritası: wire anahtarları SABİT (`checkoutRev` = runner
   * slotu, `scriptHash` = body slotu; legacy `checkout_rev`/`script_hash`
   * okumada buraya eşlenir, telde asla yazılmaz). Yeni slotlar `fixture` +
   * `providerContract`. Dördü de tanımsız + runtime tanımsız →
   * `missing_basis`; herhangi bir kod-slotu uyuşmazlığı `script_hash`
   * bayatlatır (kod-harita uyuşmazlığı; enum sabit).
   */
  checkoutRev?: string;
  scriptHash?: string;
  fixture?: string;
  providerContract?: string;
  port?: number;
  /**
   * Tam çözümlenmiş cwd — YALNIZCA tazelik karşılaştırması için iç slot
   * (CLI `slotsOf` aynası: cwd tam-yoldan karşılaştırılır). Wire'a/çıktıya
   * çıkmaz (basename indirgemesi bile yok — cwd P3/P4'te render edilmez).
   */
  cwdFull?: string;
  provenanceRev?: string;
  /**
   * M-A (#2/#3) tel aynası (CLI `cli/up-evidence.ts` kilidiyle birebir):
   * `side_effect`→`sideEffect`, `side_effect_counts`→`sideEffectCounts`,
   * `scenario`→`scenario`, `attempt`→`attempt`,
   * `step_signature`→`stepSignature`. Eksik `side_effect` wire'da `null`
   * taşınır (render `bilinmiyor`). Tazelik bu alanları yoksayar (ortogonal).
   */
  sideEffect: string | null;
  sideEffectCounts: { attempted?: number; confirmed?: number } | null;
  scenario: string | null;
  attempt: number | null;
  stepSignature: string | null;
}

function revField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const rev = value.trim();
  if (rev.length === 0 || rev.length > REV_MAX_CHARS) return undefined;
  // Secret-şekilli rev fail-safe maskelenir (***) — örn. token=hunter2-….
  // Meşru şekiller (hex SHA incl. 40-hex, kısa id, dal adı) aynen geçer:
  // uzun-hex kuralı uygulanmaz (40-hex SHA birincil meşru şekildir —
  // maskSecrets'in 32+hex kuralı burada geçersizdir). Gerçek üreticiler
  // yalnızca hex yazar (up-provenance gitCheckout: /^[0-9a-fA-F]{4,64}$/);
  // CLI fixture-id'leri ("rev1", "abc123") secret-kelime içermez.
  if (SECRET_WORD.test(rev) || PROVIDER_PREFIX.test(rev)) return '***';
  return rev;
}

/** Saf zarf normalizasyonu (testler hostile fixture'ı buradan sokar). */
export function normalizeCheckpointEnvelope(raw: unknown): { ok: true; envelope: ParsedCheckpointEnvelope } | { ok: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const dict = raw as Record<string, unknown>;
  if (typeof dict['stage'] !== 'string' || (dict['stage'] as string).trim().length === 0) return { ok: false };
  if (dict['status'] !== 'confirmed' && dict['status'] !== 'not_observed' && dict['status'] !== 'stale') return { ok: false };
  if (typeof dict['at'] !== 'string' || !Number.isFinite(Date.parse(dict['at'] as string))) return { ok: false };
  if (typeof dict['by'] !== 'string' || !ENVELOPE_BY.has(dict['by'] as string)) return { ok: false };
  const status = dict['status'] as CheckpointStageStatus;
  const reason = dict['stale_reason'];
  if (status === 'stale') {
    if (typeof reason !== 'string' || !STALE_REASONS.has(reason)) return { ok: false };
  } else if (reason !== undefined) {
    return { ok: false };
  }
  const envelope: ParsedCheckpointEnvelope = {
    stage: dict['stage'] as string,
    status,
    staleReason: status === 'stale' ? (reason as string) : null,
    safeNextAction: null,
    at: dict['at'] as string,
    sideEffect: null,
    sideEffectCounts: null,
    scenario: null,
    attempt: null,
    stepSignature: null,
  };
  if (typeof dict['safe_next_action'] === 'string') {
    const text = maskSecrets(dict['safe_next_action'] as string);
    envelope.safeNextAction = text.length <= SAFE_NEXT_ACTION_MAX ? text : `${text.slice(0, SAFE_NEXT_ACTION_MAX - '…[kesildi]'.length)}…[kesildi]`;
  } else if (dict['safe_next_action'] !== undefined) {
    return { ok: false };
  }
  if (dict['code'] !== undefined) {
    if (typeof dict['code'] !== 'object' || dict['code'] === null || Array.isArray(dict['code'])) return { ok: false };
    const code = dict['code'] as Record<string, unknown>;
    // M-B (#5): 4 slot + legacy eşdeğer (CLI `cli/up-evidence.ts` kilidiyle
    // birebir: script_hash→body, checkout_rev→runner; aynı slot iki adla
    // gelirse satır bozuktur; present-ama-disiplinsiz değer satırı bozar).
    const slot = (key: string): { present: boolean; value: string | undefined } => {
      const raw = code[key];
      if (raw === undefined) return { present: false, value: undefined };
      return { present: true, value: revField(raw) };
    };
    const runner = slot('runner');
    const fixture = slot('fixture');
    const body = slot('body');
    const providerContract = slot('provider_contract');
    const legacyHash = slot('script_hash');
    const legacyRev = slot('checkout_rev');
    if ((legacyHash.present && body.present) || (legacyRev.present && runner.present)) return { ok: false };
    const resolve = (fresh: { present: boolean; value: string | undefined }, legacy: { present: boolean; value: string | undefined }): string | undefined | null => {
      const present = fresh.present || legacy.present;
      const value = fresh.present ? fresh.value : legacy.value;
      if (present && value === undefined) return null;
      return value;
    };
    const runnerValue = resolve(runner, legacyRev);
    const fixtureValue = resolve(fixture, { present: false, value: undefined });
    const bodyValue = resolve(body, legacyHash);
    const providerContractValue = resolve(providerContract, { present: false, value: undefined });
    if (runnerValue === null || fixtureValue === null || bodyValue === null || providerContractValue === null) return { ok: false };
    let known = 0;
    if (runnerValue !== undefined) { envelope.checkoutRev = runnerValue; known += 1; }
    if (fixtureValue !== undefined) { envelope.fixture = fixtureValue; known += 1; }
    if (bodyValue !== undefined) { envelope.scriptHash = bodyValue; known += 1; }
    if (providerContractValue !== undefined) { envelope.providerContract = providerContractValue; known += 1; }
    if (known === 0 && Object.keys(code).length > 0) return { ok: false };
  }
  if (dict['runtime'] !== undefined) {
    if (typeof dict['runtime'] !== 'object' || dict['runtime'] === null || Array.isArray(dict['runtime'])) return { ok: false };
    const runtime = dict['runtime'] as Record<string, unknown>;
    let known = 0;
    if (typeof runtime['port'] === 'number') { envelope.port = runtime['port']; known += 1; }
    if (typeof runtime['cwd'] === 'string') { envelope.cwdFull = resolve(runtime['cwd'] as string); known += 1; }
    const provenanceRev = revField(runtime['provenance_rev']);
    if (provenanceRev !== undefined) { envelope.provenanceRev = provenanceRev; known += 1; }
    if (known === 0 && Object.keys(runtime).length > 0) return { ok: false };
  }
  // M-A (#2): yan-etki bayrağı — geçersiz enum satırı bozar (asla zorlama).
  if (dict['side_effect'] !== undefined) {
    if (typeof dict['side_effect'] !== 'string' || !SIDE_EFFECTS.has(dict['side_effect'] as string)) return { ok: false };
    envelope.sideEffect = dict['side_effect'] as string;
  }
  // M-A (#2): sayaçlar render-only'dir (ow hesaplamaz); aralık-dışı /
  // tamsayı-dışı / şekilsiz değer satırı bozar.
  if (dict['side_effect_counts'] !== undefined) {
    const counts = dict['side_effect_counts'];
    if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return { ok: false };
    const table = counts as Record<string, unknown>;
    const picked: { attempted?: number; confirmed?: number } = {};
    for (const key of ['attempted', 'confirmed'] as const) {
      if (table[key] !== undefined) {
        if (typeof table[key] !== 'number' || !Number.isInteger(table[key]) || (table[key] as number) < 0 || (table[key] as number) > SIDE_EFFECT_COUNT_MAX) {
          return { ok: false };
        }
        picked[key] = table[key] as number;
      }
    }
    if (Object.keys(picked).length > 0) envelope.sideEffectCounts = picked;
    else if (Object.keys(table).length > 0) return { ok: false };
  }
  // M-A (#3): soy — senaryo RUN_NAME_PATTERN şekli, deneme 1..999 tamsayı.
  if (dict['scenario'] !== undefined) {
    if (typeof dict['scenario'] !== 'string' || !SCENARIO_PATTERN.test(dict['scenario'] as string)) return { ok: false };
    envelope.scenario = maskSecrets(dict['scenario'] as string);
  }
  if (dict['attempt'] !== undefined) {
    if (typeof dict['attempt'] !== 'number' || !Number.isInteger(dict['attempt']) || (dict['attempt'] as number) < ATTEMPT_MIN || (dict['attempt'] as number) > ATTEMPT_MAX) {
      return { ok: false };
    }
    envelope.attempt = dict['attempt'] as number;
  }
  // M-A (+M-D): adım imzası 1..128ch opak dize (maske-önce-cap).
  if (dict['step_signature'] !== undefined) {
    if (typeof dict['step_signature'] !== 'string' || (dict['step_signature'] as string).length === 0 || (dict['step_signature'] as string).length > STEP_SIGNATURE_MAX) {
      return { ok: false };
    }
    const masked = maskSecrets(dict['step_signature'] as string);
    envelope.stepSignature = masked.length <= STEP_SIGNATURE_MAX ? masked : `${masked.slice(0, STEP_SIGNATURE_MAX - '…[kesildi]'.length)}…[kesildi]`;
  }
  return { ok: true, envelope };
}

function applyCheckpointFreshness(envelopes: ParsedCheckpointEnvelope[]): ParsedCheckpointEnvelope[] {
  // M-A notu: sideEffect/sideEffectCounts/scenario/attempt/stepSignature
  // tazeliğe ortogonaldir (burada yoksayılır — CLI `applyFreshness` aynası).
  // M-B (#5): 4 kod-slotu sabit sırada (runner → fixture → body →
  // provider_contract); herhangi bir kod-slotu uyuşmazlığı enum-sabit
  // `script_hash` bayatlatır (kod-harita uyuşmazlığı).
  const basisByStage = new Map<string, ParsedCheckpointEnvelope>();
  for (const envelope of envelopes) {
    if (envelope.status === 'confirmed' && !basisByStage.has(envelope.stage)) basisByStage.set(envelope.stage, envelope);
  }
  return envelopes.map(envelope => {
    if (envelope.status !== 'confirmed') return { ...envelope };
    if (envelope.scriptHash === undefined && envelope.checkoutRev === undefined && envelope.fixture === undefined && envelope.providerContract === undefined && envelope.port === undefined && envelope.cwdFull === undefined && envelope.provenanceRev === undefined) {
      return { ...envelope, status: 'stale' as const, staleReason: 'missing_basis' };
    }
    const basis = basisByStage.get(envelope.stage) as ParsedCheckpointEnvelope;
    if (basis.checkoutRev !== envelope.checkoutRev || basis.fixture !== envelope.fixture || basis.scriptHash !== envelope.scriptHash || basis.providerContract !== envelope.providerContract) {
      return { ...envelope, status: 'stale' as const, staleReason: 'script_hash' };
    }
    if (basis.port !== envelope.port || basis.cwdFull !== envelope.cwdFull || basis.provenanceRev !== envelope.provenanceRev) {
      return { ...envelope, status: 'stale' as const, staleReason: 'runtime' };
    }
    return { ...envelope, staleReason: null };
  });
}

export interface CheckpointSource {
  run: string;
  envelopes: ParsedCheckpointEnvelope[];
  /** Keşfedilen run adları (yeni→eski, ≤50). */
  runs: string[];
}

export interface SupervisorProvenanceRecord {
  name: string;
  port?: number;
  rev?: string;
  dirty?: boolean;
  recordedAt?: string;
  exitCode?: number;
   /** Basename of the reading root (`readSupervisorRecords` fills it; full path never reaches the wire). */
  rootBase?: string;
  /** M-C probe-beyanlı derleme kimliği (durum-dosyasından ham basename →
   * tam-digest; tele indirgenmiş taşınır). */
  artifactDigests?: Record<string, string>;
  // NOT: `cwdBase`/`lastReadiness` bilerek yok — P4 beklenen/çalışan
  // environmentStatus + spawn rev'inden kurulur; supervisor cwd'si ve
  // lastReadiness kaydı render edilmez. D3 (P5 + a11y) ikisini de istemez
  // (§5-D3); cwd-diff gösterimi doğarsa tam-yol iç-slot + basename-çıktı
  // çiftiyle birlikte eklenir.
}

export function shortRev(full: string): string {
  return full.slice(0, 7);
}

// --- Senaryo aynası (cli/up-scenarios.ts v1 + cli/up-schema.ts subset) ----
// CLI bun-only olduğu için import edilmez; davranış aynasıdır.
// Wire'a argv ASLA çıkmaz (CLI maskeli-şekli bile taşımayız — matris
// yalnızca id sayar); targets/checkpoints adları maskeden geçer.

export const SCENARIOS_FILE_NAME = 'ow.scenarios.yaml';
const SCENARIOS_VERSION = '1';
const SCENARIO_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
const SCENARIO_BOUNDARIES = ['real', 'local', 'fake', 'captured-response', 'test'];
const SCENARIO_KNOWN_BOUNDARIES = new Set(SCENARIO_BOUNDARIES);
const SCENARIO_MAX_COUNT = 32;
const SCENARIO_MAX_COLUMNS = 16;
const SCENARIOS_MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUTS = new Set(['5s', '10s', '30s']);
const PROBE_DEFAULT_TIMEOUT = '10s';
const PROBE_MAX_PARTS = 16;
const PROBE_MAX_PART_BYTES = 512;
const SHELL_ARGV0 = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
export const RUN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type YamlScalar = string;
interface YamlMap { [key: string]: YamlNode }
type YamlNode = YamlScalar | YamlScalar[] | YamlMap;

function yamlUnquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function yamlStripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Üst-düzey virgül bölmesi: `[]`/`{}` derinliği + tırnak farkındalığı (CLI aynası). */
function yamlSplitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (current.length === 0 || /[\s:\[{,]$/.test(current)) quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part.length > 0);
}

function yamlParseFlowList(raw: string): YamlScalar[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  return yamlSplitTopLevel(inner).map(part => yamlUnquote(part));
}

function yamlParseFlowMap(raw: string): Record<string, YamlNode> {
  const inner = raw.trim().slice(1, -1).trim();
  const out: Record<string, YamlNode> = Object.create(null);
  if (inner.length === 0) return out;
  for (const part of yamlSplitTopLevel(inner)) {
    const colon = part.indexOf(':');
    if (colon < 0) throw new Error('harita içinde anahtar: değer bekleniyor');
    const key = yamlUnquote(part.slice(0, colon).trim());
    const value = part.slice(colon + 1).trim();
    if (key.length === 0 || value.length === 0) throw new Error('harita içinde boş anahtar/değer');
    if (key in out) throw new Error('harita içinde tekrarlanan anahtar');
    out[key] = yamlParseValue(value);
  }
  return out;
}

function yamlParseValue(rest: string): YamlNode {
  if (rest.startsWith('[') && rest.endsWith(']')) return yamlParseFlowList(rest);
  if (rest.startsWith('{') && rest.endsWith('}')) return yamlParseFlowMap(rest);
  return yamlUnquote(rest);
}

function yamlParseSubset(text: string): Record<string, YamlNode> {
  const root: Record<string, YamlNode> = {};
  const stack: { indent: number; map: Record<string, YamlNode> }[] = [{ indent: -1, map: root }];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const bare = yamlStripComment(lines[n]).replace(/\s+$/, '');
    if (bare.trim().length === 0) continue;
    const indent = bare.match(/^ */)?.[0].length ?? 0;
    const trimmed = bare.trim();
    if (trimmed.startsWith('- ')) throw new Error('blok listesi desteklenmiyor (akış listesi kullanın: [a, b])');
    const colon = trimmed.indexOf(':');
    if (colon < 0) throw new Error('anahtar: değer bekleniyor');
    const key = yamlUnquote(trimmed.slice(0, colon).trim());
    const rest = trimmed.slice(colon + 1).trim();
    if (key.length === 0) throw new Error('boş anahtar');
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].map;
    if (rest.length === 0) {
      if (indent === 0 && parent !== root) throw new Error(`beklenmeyen girinti: ${key}`);
      for (let m = n + 1; m < lines.length; m += 1) {
        const peer = yamlStripComment(lines[m]).trim();
        if (peer.length === 0) continue;
        if (peer.startsWith('- ')) throw new Error('blok listesi desteklenmiyor (akış listesi kullanın: [a, b])');
        break;
      }
      if (stack.length >= 3) throw new Error(`3. düzey desteklenmiyor: ${key}`);
      const child: Record<string, YamlNode> = {};
      if (Object.hasOwn(parent, key)) throw new Error(`tekrarlanan anahtar: ${key}`);
      parent[key] = child;
      stack.push({ indent, map: child });
      continue;
    }
    if (Object.hasOwn(parent, key)) throw new Error(`tekrarlanan anahtar: ${key}`);
    parent[key] = yamlParseValue(rest);
  }
  return root;
}

export interface ParsedScenario {
  name: string;
  services: string[];
  boundaries: string[];
  probes: { id: string; timeout: string }[];
  checkpoints: string[];
}

/**
 * Saf v1 senaryo normalizasyonu: şekil-sıkı fail-closed (hata fırlatır —
 * çağıran `error` kutusuna çevirir). Uyarılar warn-only listede döner.
 * argv/target ham DEĞERLERİ düşer (id/timeout/ad listeleri kalır).
 */
export function normalizeScenarios(text: string): { scenarios: ParsedScenario[]; warnings: string[] } {
  const fileWarnings: string[] = [];
  let doc: Record<string, YamlNode>;
  try {
    doc = yamlParseSubset(text);
  } catch (error) {
    throw new Error(`geçersiz senaryo dosyası: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'scenarios') fileWarnings.push(`bilinmeyen üst alan yoksayıldı: ${key}`);
  }
  if (doc['version'] !== SCENARIOS_VERSION) throw new Error('geçersiz senaryo dosyası: `version: 1` gerekli');
  const raw = doc['scenarios'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('geçersiz senaryo dosyası: `scenarios:` haritası gerekli');
  const entries = Object.entries(raw as Record<string, YamlNode>);
  if (entries.length === 0) throw new Error('geçersiz senaryo dosyası: senaryo yok (`scenarios:` boş)');
  if (entries.length > SCENARIO_MAX_COUNT) throw new Error(`geçersiz senaryo dosyası: en fazla ${SCENARIO_MAX_COUNT} senaryo (v1 sınırı)`);
  const scenarios: ParsedScenario[] = [];
  for (const [name, node] of entries) {
    if (!SCENARIO_NAME_PATTERN.test(name)) throw new Error(`geçersiz senaryo dosyası: senaryo adı geçersiz: ${name}`);
    if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error(`geçersiz senaryo dosyası: ${name}: senaryo haritası bekleniyor`);
    const fields = node as Record<string, YamlNode>;
    for (const key of Object.keys(fields)) {
      if (!['services', 'boundaries', 'targets', 'probes', 'checkpoints'].includes(key)) {
        fileWarnings.push(`${name}: bilinmeyen alan yoksayıldı: ${key}`);
      }
    }
    const asList = (value: YamlNode | undefined, what: string): string[] => {
      if (value === undefined) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) {
        for (const part of value) {
          if (typeof part !== 'string') throw new Error(`geçersiz senaryo dosyası: ${what} metin ya da liste olmalı`);
        }
        return [...value] as string[];
      }
      throw new Error(`geçersiz senaryo dosyası: ${what} metin ya da liste olmalı`);
    };
    const services = asList(fields['services'], `${name}: services`);
    if (services.length === 0) throw new Error(`geçersiz senaryo dosyası: ${name}: services gerekli`);
    const boundaries = asList(fields['boundaries'], `${name}: boundaries`);
    asList(fields['targets'], `${name}: targets`);
    const checkpoints = asList(fields['checkpoints'], `${name}: checkpoints`);
    const probesRaw = fields['probes'];
    if (probesRaw === undefined) throw new Error(`geçersiz senaryo dosyası: ${name}: probes gerekli`);
    if (!Array.isArray(probesRaw) || probesRaw.length === 0) throw new Error(`geçersiz senaryo dosyası: ${name}: probes liste olmalı`);
    const probes: { id: string; timeout: string }[] = [];
    for (const entry of probesRaw) {
      if (typeof entry !== 'string') throw new Error(`geçersiz senaryo dosyası: ${name}: probe satır-içi harita olmalı`);
      const trimmed = entry.trim();
      if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) throw new Error(`geçersiz senaryo dosyası: ${name}: probe satır-içi harita olmalı`);
      let map: Record<string, YamlNode>;
      try {
        map = yamlParseFlowMap(trimmed);
      } catch {
        throw new Error(`geçersiz senaryo dosyası: ${name}: probe haritası bozuk`);
      }
      for (const key of Object.keys(map)) {
        if (!['id', 'argv', 'timeout'].includes(key)) fileWarnings.push(`${name}: probe içinde bilinmeyen alan yoksayıldı: ${key}`);
      }
      const id = map['id'];
      if (typeof id !== 'string' || !SCENARIO_NAME_PATTERN.test(id)) throw new Error(`geçersiz senaryo dosyası: ${name}: probe id metin olmalı`);
      const argvRaw = map['argv'];
      if (!Array.isArray(argvRaw) || argvRaw.length === 0) throw new Error(`geçersiz senaryo dosyası: ${name}: probe argv liste olmalı (id: ${id})`);
      if (argvRaw.length > PROBE_MAX_PARTS) throw new Error(`geçersiz senaryo dosyası: ${name}: probe argv en fazla ${PROBE_MAX_PARTS} parça olabilir`);
      for (const part of argvRaw) {
        if (typeof part !== 'string') throw new Error(`geçersiz senaryo dosyası: ${name}: probe argv parçaları metin olmalı`);
        if (Buffer.byteLength(part, 'utf8') > PROBE_MAX_PART_BYTES) throw new Error(`geçersiz senaryo dosyası: ${name}: probe argv parçası çok uzun`);
      }
      if (SHELL_ARGV0.has((argvRaw as string[])[0])) throw new Error(`geçersiz senaryo dosyası: ${name}: probe argv shell ile başlayamaz`);
      const timeoutRaw = map['timeout'];
      let timeout = PROBE_DEFAULT_TIMEOUT;
      if (timeoutRaw !== undefined) {
        if (typeof timeoutRaw !== 'string' || !PROBE_TIMEOUTS.has(timeoutRaw)) throw new Error(`geçersiz senaryo dosyası: ${name}: probe timeout 5s|10s|30s olmalı`);
        timeout = timeoutRaw;
      }
      probes.push({ id, timeout });
    }
    scenarios.push({ name, services, boundaries, probes, checkpoints });
  }
  return { scenarios, warnings: fileWarnings };
}

/** Boundary rollup (pure): worst cell verdict per column, with
 * non-covering cells sorting below real verdicts. */
function rollupBoundaryStatus(cells: ScenarioVerdict[]): BoundaryChipStatus {
  const rank: Record<ScenarioVerdict, number> = { stale: 4, unverified: 3, skipped: 2, uncovered: 1, pass: 0 };
  let status: BoundaryChipStatus = 'pass';
  let covered = false;
  for (const verdict of cells) {
    if (verdict === 'uncovered') continue;
    covered = true;
    if (rank[verdict] > rank[status]) status = verdict;
  }
  return covered ? status : 'uncovered';
}

/** Readiness-strip sections (M8, pure): derived from already-built
 * aggregates - no new reads. Boundary chips roll up matrix verdicts;
 * last-run binds the selected checkpoint run (null without checkpoints);
 * the gate mirrors preflight pass + missing (already masked upstream). */
function buildReadinessStrip(
  checkpoints: CoordinatorCheckpoints | null,
  scenarios: CoordinatorScenarios,
  missing: string[],
): { boundaryList: CoordinatorBoundaryChip[]; lastRun: CoordinatorLastRun | null; readinessGate: CoordinatorReadinessGate } {
  const boundaryList = scenarios.columns.map(column => ({
    boundary: column,
    status: rollupBoundaryStatus(scenarios.rows.map(row => row.cells[column] ?? 'skipped')),
  }));
  const lastRun = checkpoints === null ? null : {
    id: checkpoints.run,
    at: checkpoints.lastVerified?.at ?? null,
    pass: checkpoints.summary.stale === 0 && checkpoints.summary.notObserved === 0,
  };
  return { boundaryList, lastRun, readinessGate: { pass: missing.length === 0, missing: [...missing] } };
}

function buildScenarios(
  record: EnvironmentRecord,
  checkpoint: CheckpointSource | null,
  parsed: ParsedScenario[],
  fileWarnings: string[],
  overlay?: { applied: boolean; file: string | null; sources: OverlayBoundarySource[]; error: string | null },
): CoordinatorScenarios {
  const knownServices = new Set(record.services.map(service => service.name ?? service.id));
  // Sütunlar: bilinen sıra önce, bilinmeyenler alfabetik (≤16).
  const seenColumns = new Set<string>();
  for (const scenario of parsed) {
    for (const boundary of scenario.boundaries) seenColumns.add(boundary);
  }
  const columns = [
    ...SCENARIO_BOUNDARIES.filter(boundary => seenColumns.has(boundary)),
    ...[...seenColumns].filter(boundary => !SCENARIO_KNOWN_BOUNDARIES.has(boundary)).sort(),
  ];
  const warnings = [...fileWarnings];
  if (columns.length > SCENARIO_MAX_COLUMNS) {
    warnings.push(`sütun kırpıldı (${SCENARIO_MAX_COLUMNS} sınır) — matris ilk sütunlarla sınırlı`);
  }
  const shownRaw = columns.slice(0, SCENARIO_MAX_COLUMNS);
  // Wire anahtarları maskeli (ham sınır adları kullanıcı verisidir);
  // bilinen adlar maskeden aynen geçer, eşleşme ham değerle yapılır.
  const shownColumns = shownRaw.map(column => maskSecrets(column));
  // Hüküm tabanı: seçili run'daki zarf tazeliği (son kayıt kazanır).
  // Checkpoint görünümü yoksa kapsanan hücre "atlandı" düşer (kayıt yok).
  const stageStatus = new Map<string, CheckpointStageStatus>();
  if (checkpoint) {
    const fresh = applyCheckpointFreshness(checkpoint.envelopes);
    for (const envelope of fresh) stageStatus.set(envelope.stage, envelope.status);
  }
  const rows: ScenarioMatrixRow[] = parsed.map(scenario => {
    const unverifiedServices = scenario.services.filter(service => !knownServices.has(service));
    let verdict: ScenarioVerdict;
    if (scenario.checkpoints.length === 0 || !checkpoint) {
      verdict = 'skipped';
    } else if (scenario.checkpoints.every(stage => stageStatus.get(stage) === 'confirmed')) {
      verdict = 'pass';
    } else if (scenario.checkpoints.some(stage => stageStatus.get(stage) === 'stale')) {
      verdict = 'stale';
    } else {
      verdict = 'skipped';
    }
    const cells: Record<string, ScenarioVerdict> = {};
    for (let i = 0; i < shownRaw.length; i += 1) {
      const raw = shownRaw[i];
      const column = shownColumns[i];
      if (!scenario.boundaries.includes(raw)) cells[column] = 'uncovered';
      else if (!SCENARIO_KNOWN_BOUNDARIES.has(raw)) cells[column] = 'unverified';
      else cells[column] = verdict;
    }
    return {
      name: maskSecrets(scenario.name),
      services: scenario.services.map(service => maskSecrets(service)),
      unverifiedServices: unverifiedServices.map(service => maskSecrets(service)),
      probes: scenario.probes.map(probe => ({ id: maskSecrets(probe.id), timeout: probe.timeout })),
      checkpoints: scenario.checkpoints.map(stage => maskSecrets(stage)),
      cells,
    };
  });
  return {
    file: SCENARIOS_FILE_NAME,
    columns: shownColumns,
    rows,
    warnings: warnings.map(warning => maskSecrets(warning)),
    error: null,
    ...(overlay !== undefined && (overlay.applied || overlay.error !== null)
      ? {
        overlayApplied: overlay.applied,
        overlayFile: overlay.file,
        boundarySources: overlay.sources,
        overlayError: overlay.error,
      }
      : {}),
  };
}

// --- Saf çekirdek (I/O yok; testler hostile fixture enjekte eder) -------------

function expectedDescriptor(service: EnvironmentRecord['services'][number]): string {
  const script = service.scriptName || '(komut yok)';
  const port = typeof service.port === 'number' ? `${service.port} portu` : 'portsuz';
  return `${script} · ${port}`;
}

function buildCheckpoints(source: CheckpointSource | null): CoordinatorCheckpoints | null {
  if (!source || source.envelopes.length === 0) return null;
  const fresh = applyCheckpointFreshness(source.envelopes);
  const stages: CoordinatorCheckpointStage[] = fresh.map(envelope => ({
    stage: maskSecrets(envelope.stage),
    status: envelope.status,
    staleReason: envelope.staleReason,
    at: envelope.at,
    sideEffect: envelope.sideEffect,
    sideEffectAttempted: envelope.sideEffectCounts?.attempted ?? null,
    sideEffectConfirmed: envelope.sideEffectCounts?.confirmed ?? null,
    scenario: envelope.scenario,
    attempt: envelope.attempt,
    stepSignature: envelope.stepSignature,
  }));
  let confirmed = 0;
  let stale = 0;
  let notObserved = 0;
  for (const envelope of fresh) {
    if (envelope.status === 'confirmed') confirmed += 1;
    else if (envelope.status === 'stale') stale += 1;
    else notObserved += 1;
  }
  let lastVerified: CoordinatorCheckpoints['lastVerified'] = null;
  for (const envelope of fresh) {
    if (envelope.status === 'confirmed') lastVerified = { stage: maskSecrets(envelope.stage), at: envelope.at };
  }
  // first_gap = son confirmed sonrasındaki İLK non-confirmed (confirmed
  // yoksa ilk satır) — cli/summarizeFresh aynası.
  let lastIndex = -1;
  for (let i = 0; i < fresh.length; i += 1) {
    if (fresh[i].status === 'confirmed') lastIndex = i;
  }
  const firstGapRaw = fresh.find((envelope, index) => index > lastIndex && envelope.status !== 'confirmed') ?? null;
  const firstGap = firstGapRaw
    ? { stage: maskSecrets(firstGapRaw.stage), status: firstGapRaw.status, staleReason: firstGapRaw.staleReason, at: firstGapRaw.at }
    : null;
  const actionSource = firstGapRaw ?? fresh[fresh.length - 1];
  // M-A (#2): doğrulanmamış-deneme kuralı (CLI `needsRetryHint` aynası:
  // aynı stage'de attempted sonrası confirmed yoksa ipucu).
  let retryHint = false;
  for (let i = 0; i < fresh.length && !retryHint; i += 1) {
    if (fresh[i].sideEffect !== 'attempted') continue;
    retryHint = !fresh.slice(i + 1).some(later => later.stage === fresh[i].stage && later.sideEffect === 'confirmed');
  }
  return {
    run: source.run,
    runs: source.runs,
    stages,
    summary: { confirmed, stale, notObserved },
    lastVerified,
    firstGap,
    safeNextAction: actionSource?.safeNextAction ?? null,
    retryHint,
  };
}

function buildExplanation(
  record: EnvironmentRecord,
  status: EnvironmentStatus,
  checkpoint: CheckpointSource | null,
  supervisor: SupervisorProvenanceRecord[] | null,
): CoordinatorExplanation | null {
  const records = supervisor ?? [];
  // Zarf rev'leri: yalnızca ilk-görülme `at` izlenir (şerit yaşı). Servis
  // atfı zarfta yoktur — stages/servis kümesi taşınmaz (prune: D3
  // istemez, wire'da karşılığı yok).
  const envelopeRevs = new Map<string, string>();
  if (checkpoint) {
    for (const envelope of checkpoint.envelopes) {
      if (envelope.checkoutRev === undefined) continue;
      const seen = envelopeRevs.get(envelope.checkoutRev);
      if (seen === undefined || Date.parse(envelope.at) < Date.parse(seen)) {
        envelopeRevs.set(envelope.checkoutRev, envelope.at);
      }
    }
  }
  if (records.length === 0 && envelopeRevs.size === 0) return null;

  const byId = new Map(status.services.map(entry => [entry.serviceId, entry]));
  const byName = new Map(status.services.map(entry => [entry.name, entry]));
  const storeByName = new Map(record.services.map(service => [service.name ?? service.id, service]));
  const names: string[] = [];
  for (const service of record.services) {
    const key = service.name ?? service.id;
    if (!names.includes(key)) names.push(key);
  }
  for (const rec of records) {
    if (!names.includes(rec.name)) names.push(rec.name);
  }

  const recordedRevs = new Set(records.flatMap(rec => (rec.rev !== undefined ? [rec.rev] : [])));
  const entries: CoordinatorExplanationEntry[] = names.map(name => {
    const storeService = storeByName.get(name);
    const rec = records.find(candidate => candidate.name === name);
    const live = (storeService ? byId.get(storeService.id) : undefined) ?? byName.get(name);
    const expected = storeService
      ? {
        cmd: maskSecrets(storeService.scriptName || '(komut yok)'),
        dir: basename(resolve(storeService.repositoryPath)),
        port: typeof storeService.port === 'number' ? storeService.port : null,
      }
      : null;
    const running = live ? { status: live.status, detail: maskSecrets(live.detail) } : null;
    const diffs: string[] = [];
    if (rec === undefined) {
      // Kayıt yok — diff üretilemez, note kapsar.
    } else {
      if (expected === null) {
        diffs.push(maskSecrets('tanımda yok — kayıtlı topolojide karşılığı yok'));
      } else if (typeof rec.port === 'number' && typeof expected.port === 'number' && rec.port !== expected.port) {
        diffs.push(maskSecrets(`port değişti (beklenen: ${expected.port}, çalışan: ${rec.port})`));
      }
      if (rec.exitCode !== undefined) diffs.push(maskSecrets(`süreç bitti (çıkış kodu ${rec.exitCode})`));
      if (rec.dirty === true) diffs.push(maskSecrets('kirli checkout ile başlatıldı'));
    }
    let note: string;
    if (rec === undefined) note = 'kayıt yok — bu servis için provenance kaydı bulunamadı';
    else if (running === null) note = 'ölçülmedi — canlı durum kaydı yok';
    else if (rec.exitCode !== undefined) note = `çalışmıyor — çıkış kodu ${rec.exitCode}; günlük için asistanına danış`;
    else if (running.status === 'starting') note = 'başlatılıyor — Yenile ile tazele';
    else if (running.status === 'stale') note = 'bayat — Yenile ile tazele';
    else if (running.status === 'ready') note = 'çalışıyor, bilinen sorun yok';
    else note = `canlı durum ${running.status} — diff satırlarına bak`;
    const rev = rec?.rev;
    // M-C: kayıtlı derleme haritası indirgenmiş taşınır (basename + kısa-8).
    const reduced = reduceArtifactMap(rec?.artifactDigests);
    return {
      service: maskSecrets(name),
      expected,
      running,
      revShort: rev !== undefined ? shortRev(rev) : null,
      // Tam rev yalnızca kopyala-butonu clipboard payload'ıdır — DOM'a
      // yazılmaz (hover-title bile yok; tara-test §3).
      revFull: rev ?? null,
      revAt: rec?.recordedAt ?? null,
      revDirty: rec?.dirty === true,
      revRecorded: rev !== undefined,
      diffs,
      note: maskSecrets(note),
      artifacts: reduced.shown,
      artifactRest: reduced.rest,
    };
  });

  // Rev şeridi: supervisor kayıtlı-rev'leri (recordedAt yaşlı) + zarflardaki
  // kayıtsız rev'ler (ilk-görülme `at` yaşlı, soluk). En yeni seçili.
  const revisions: CoordinatorRevision[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (rec.rev === undefined || seen.has(rec.rev)) continue;
    seen.add(rec.rev);
    revisions.push({
      short: shortRev(rec.rev),
      full: rec.rev,
      at: rec.recordedAt ?? null,
      current: false,
      recorded: true,
    });
  }
  for (const [rev, at] of envelopeRevs) {
    if (seen.has(rev)) {
      const existing = revisions.find(candidate => candidate.full === rev);
      if (existing && existing.at !== null && Date.parse(at) < Date.parse(existing.at)) existing.at = at;
      continue;
    }
    seen.add(rev);
    revisions.push({
      short: shortRev(rev),
      full: rev,
      at,
      current: false,
      recorded: recordedRevs.has(rev),
    });
  }
  revisions.sort((a, b) => {
    const aMs = a.at === null ? Number.NEGATIVE_INFINITY : Date.parse(a.at);
    const bMs = b.at === null ? Number.NEGATIVE_INFINITY : Date.parse(b.at);
    return aMs - bMs;
  });
  if (revisions.length > 0) revisions[revisions.length - 1].current = true;
  return { entries, revisions };
}

function buildScenariosSection(
  record: EnvironmentRecord,
  checkpoint: CheckpointSource | null,
  read: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[]; overlayApplied?: boolean; overlayFile?: string | null; boundarySources?: OverlayBoundarySource[]; overlayError?: string | null } | null,
): CoordinatorScenarios | null {
  if (!read || (read.scenarios === null && read.error === null)) return null;
  if (read.scenarios === null) {
    return {
      file: SCENARIOS_FILE_NAME,
      columns: [],
      rows: [],
      warnings: [],
      error: read.error ?? 'kayıt yok',
      ...(read.overlayApplied === true || read.overlayError != null
        ? { overlayApplied: read.overlayApplied === true, overlayFile: read.overlayFile ?? null, boundarySources: read.boundarySources ?? [], overlayError: read.overlayError ?? null }
        : {}),
    };
  }
  return buildScenarios(record, checkpoint, read.scenarios, read.warnings, {
    applied: read.overlayApplied === true,
    file: read.overlayFile ?? null,
    sources: read.boundarySources ?? [],
    error: read.overlayError ?? null,
  });
}

export function buildCoordinatorSnapshot(input: {
  record: EnvironmentRecord;
  status: EnvironmentStatus;
  /** Port → dolu mu (ölçülemeyen portlar haritada yok sayılır + warning). */
  portOccupied: Map<number, boolean>;
  /** Dolu port → önerilen boş port (yoksa null). */
  freeSuggestion: Map<number, number | null>;
  /** §0.3 dosya okuma sepeti (zaten Türkçe, yine de maskeden geçer). */
  checkpointWarnings: string[];
  /** Latest-run checkpoint kaynağı (null → bölüm `null` + "checkpoint yok"). */
  checkpoint?: CheckpointSource | null;
  /** Supervisor spawn-kayıtları (ad ile eşleşir; null/boş → kayıt yok). */
  supervisor?: SupervisorProvenanceRecord[] | null;
  /** Senaryo okuma sonucu (null → dosya yok; error → bozuk-dosya kutusu). */
  scenarioRead?: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[]; overlayApplied?: boolean; overlayFile?: string | null; boundarySources?: OverlayBoundarySource[]; overlayError?: string | null } | null;
  /** Keşfedilen run adları — checkpoints null iken bile wire'a çıkar. */
  runs?: string[];
  /** serviceId → {rootBase, revShort} identity (additive-optional).
   * When absent, readiness entries carry no `worktree` field at all
   * (single-root snapshots stay byte-identical). */
  worktreeByService?: Map<string, { rootBase: string; revShort: string | null }>;
  /** Ownership ledger input (additive-optional): `{rows, warnings}`.
   * When absent, the snapshot carries no `worktrees` field and no matrix
   * warning is produced (single-root snapshots stay byte-identical). */
  worktreeLedger?: { rows: CoordinatorWorktreeEntry[]; warnings: string[] };
  unprobedPorts?: number[];
  producedAt?: string;
  snapshotId?: string;
}): CoordinatorSnapshot {
  const warnings = input.checkpointWarnings.map(warning => maskSecrets(warning));
  for (const port of input.unprobedPorts ?? []) {
    warnings.push(`port yoklaması ölçülemedi: ${port} — preflight bu portu boş sayar`);
  }
  // Ledger warnings arrive masked from their builders; the push site does
  // not re-mask (single mask point per string, like readiness above).
  for (const warning of input.worktreeLedger?.warnings ?? []) warnings.push(warning);
  const byId = new Map(input.status.services.map(entry => [entry.serviceId, entry]));
  const topologyIds = new Set(input.record.services.map(service => service.id));

  // Reconcile: ortam kapalıysa (down) duran servisler beklenen durumdur;
  // kısmi/açık ortamda down/failed/stale/skipped her servis kayık satırıdır.
  const drifts: CoordinatorDrift[] = [];
  const stopped = input.record.state === 'down';
  for (const service of input.record.services) {
    const entry = byId.get(service.id);
    if (!entry) {
      drifts.push({
        service: maskSecrets(service.name ?? service.id),
        field: 'durum',
        expected: maskSecrets(expectedDescriptor(service)),
        actual: maskSecrets('ölçülmedi'),
      });
      continue;
    }
    if (stopped) continue;
    if (entry.status === 'ready' || entry.status === 'starting') continue;
    drifts.push({
      service: maskSecrets(entry.name),
      field: 'durum',
      expected: maskSecrets(`çalışıyor (${expectedDescriptor(service)})`),
      actual: maskSecrets(`${entry.status}: ${entry.detail}`),
    });
  }
  for (const entry of input.status.services) {
    if (entry.status !== 'stale' || topologyIds.has(entry.serviceId)) continue;
    drifts.push({
      service: maskSecrets(entry.name),
      field: 'topoloji',
      expected: maskSecrets('kayıtlı topoloji'),
      actual: maskSecrets('kayıt dışı süreç izleniyor — topolojide karşılığı yok'),
    });
  }

  const readiness: CoordinatorReadinessEntry[] = input.status.services
    .filter(entry => topologyIds.has(entry.serviceId))
    .map(entry => {
      const service = input.record.services.find(candidate => candidate.id === entry.serviceId);
      const worktree = input.worktreeByService?.get(entry.serviceId);
      return {
        serviceId: maskSecrets(entry.serviceId),
        name: maskSecrets(entry.name),
        dir: service ? basename(resolve(service.repositoryPath)) : null,
        status: entry.status,
        detail: maskSecrets(entry.detail),
        lastPoll: entry.owned?.lastPoll ?? null,
        ...(worktree === undefined ? {} : { worktree: { rootBase: maskSecrets(worktree.rootBase), revShort: worktree.revShort } }),
      };
    });

  const gates: CoordinatorPreflightGate[] = [];
  const missing: string[] = [];
  for (const service of input.record.services) {
    const label = maskSecrets(service.name ?? service.id);
    if (typeof service.port !== 'number') {
      gates.push({ service: label, port: null, free: true, note: 'port yok — süreç izlemesi' });
      continue;
    }
    if (!input.portOccupied.has(service.port)) {
      gates.push({ service: label, port: service.port, free: true, note: 'ölçülemedi — boş sayıldı' });
      continue;
    }
    if (!input.portOccupied.get(service.port)) {
      gates.push({ service: label, port: service.port, free: true, note: `${service.port} portu boş` });
      continue;
    }
    const suggestion = input.freeSuggestion.get(service.port) ?? null;
    const line = suggestion === null
      ? `${label}: ${service.port} portu dolu`
      : `${label}: ${service.port} portu dolu (${suggestion} boş görünüyor — topolojiyi değiştir, otomatik yeniden bağlama yok)`;
    gates.push({ service: label, port: service.port, free: false, note: maskSecrets(`${service.port} portu dolu`) });
    missing.push(maskSecrets(line));
  }

  const scenarios = buildScenariosSection(input.record, input.checkpoint ?? null, input.scenarioRead ?? null);
  const scopedCheckpoints = buildCheckpoints(input.checkpoint ?? null);
  return {
    reconcile: { inSync: drifts.length === 0, drifts },
    readiness,
    explanation: buildExplanation(input.record, input.status, input.checkpoint ?? null, input.supervisor ?? null),
    preflight: { pass: missing.length === 0, gates, missing },
    checkpoints: scopedCheckpoints,
    scenarios,
    runs: input.runs ?? [],
    ...(scenarios === null ? {} : buildReadinessStrip(scopedCheckpoints, scenarios, missing)),
    ...(input.worktreeLedger === undefined ? {} : { worktrees: input.worktreeLedger.rows }),
    warnings,
    meta: {
      producedAt: input.producedAt ?? new Date().toISOString(),
      snapshotId: input.snapshotId ?? randomBytes(4).toString('hex'),
      environment: input.record.name,
    },
  };
}

// --- Runner-dosya okuma sınırı (§0.3) ------------------------------------------

export const CHECKPOINT_MAX_BYTES = 256 * 1024;
export const CHECKPOINT_MAX_LINES = 500;
const CHECKPOINT_MAX_RUNS = 50;
const runFilePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jsonl$/;

/**
 * `.ow/checkpoints` bounded okuma: seçili run'un zarfları (normalize
 * edilmiş) + keşfedilen run adları + warnings[] sepeti (kırpma/bozuk/
 * symlink/okunamadı/boş). `runs` listesi source null iken bile döner —
 * null dalındaki seçici buradan beslenir. Seçim: `?run=` adı
 * (allowlist-dışı/yoksa latest + uyarı) yoksa en yeni İÇERİKLİ dosya;
 * D1 uyarı metinleri aynen korunur. Kök dışına çıkış, symlink ve aşırı
 * dosya fail-closed atlanır.
 */
export async function readCheckpointSource(roots: string[], requestedRun?: string): Promise<{
  source: CheckpointSource | null;
  /** Keşfedilen run adları — source null iken bile dolu olabilir (seçici). */
  runs: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  type Latest = { path: string; run: string; mtimeMs: number };
  const perRoot: Latest[] = [];
  const runFiles = new Map<string, { path: string; mtimeMs: number }>();
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const dir = join(canonicalRoot, '.ow', 'checkpoints');
    if (resolve(dir) !== dir || !dir.startsWith(canonicalRoot + sep)) continue;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    type Candidate = { name: string; mtimeMs: number };
    const candidates: Candidate[] = [];
    for (const name of names) {
      if (!runFilePattern.test(name)) continue;
      const path = join(dir, name);
      if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
      let entry;
      try {
        entry = await lstat(path);
      } catch {
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) warnings.push(`checkpoint atlandı (symlink izlenmez): ${name}`);
        continue;
      }
      const run = name.replace(/\.jsonl$/, '');
      candidates.push({ name, mtimeMs: entry.mtimeMs });
      const known = runFiles.get(run);
      if (!known || entry.mtimeMs > known.mtimeMs) runFiles.set(run, { path, mtimeMs: entry.mtimeMs });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    perRoot.push({ path: join(dir, latest.name), run: latest.name.replace(/\.jsonl$/, ''), mtimeMs: latest.mtimeMs });
  }
  const runs = [...runFiles.entries()]
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .map(([run]) => run);
  if (runs.length > CHECKPOINT_MAX_RUNS) {
    warnings.push(`çalışma listesi kırpıldı (${CHECKPOINT_MAX_RUNS} ad) — en yeniler listelenir`);
  }
  const trimmedRuns = runs.slice(0, CHECKPOINT_MAX_RUNS);
  if (perRoot.length === 0) return { source: null, runs: trimmedRuns, warnings };
  // Uyarı sepeti her kökün latest'inden (D1 disiplini).
  const scanned = new Map<string, ParsedCheckpointEnvelope[]>();
  for (const candidate of perRoot) {
    if (!scanned.has(candidate.path)) {
      scanned.set(candidate.path, await scanCheckpointFile(candidate.path, candidate.run, warnings));
    }
  }
  const envelopesOf = async (path: string, run: string): Promise<ParsedCheckpointEnvelope[]> => {
    const known = scanned.get(path);
    if (known !== undefined) return known;
    const parsed = await scanCheckpointFile(path, run, warnings);
    scanned.set(path, parsed);
    return parsed;
  };
  // Açık istek: allowlist-dışı ad latest'e düşer + uyarı; bulunan dosya
  // içeriği neyse odur (boş/bozuk → bölüm null + tarama uyarısı).
  const requested = (requestedRun ?? '').trim();
  if (requested) {
    if (!RUN_NAME_PATTERN.test(requested)) {
      warnings.push(maskSecrets(`istenen çalışma geçersiz: ${requested} — en güncel gösteriliyor`));
    } else {
      const hit = runFiles.get(requested);
      if (!hit) {
        warnings.push(maskSecrets(`istenen çalışma yok: ${requested} — en güncel gösteriliyor`));
      } else {
        const envelopes = await envelopesOf(hit.path, requested);
        if (envelopes.length === 0) return { source: null, runs: trimmedRuns, warnings };
        return { source: { run: requested, envelopes, runs: trimmedRuns }, runs: trimmedRuns, warnings };
      }
    }
  }
  // Latest: en yeni İÇERİKLİ dosya (D1 tek-dosya davranışı aynı). Taranan
  // ama içeriksiz kalan dosya sessiz geçilmez — sepet satırı düşer
  // (zaten uyarılmış Run adı tekrar uyarılmaz).
  const ordered = [...perRoot].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of ordered) {
    const before = warnings.length;
    const envelopes = await envelopesOf(candidate.path, candidate.run);
    if (envelopes.length > 0) return { source: { run: candidate.run, envelopes, runs: trimmedRuns }, runs: trimmedRuns, warnings };
    if (!warnings.slice(before).some(warning => warning.includes(candidate.run))) {
      warnings.push(maskSecrets(`checkpoint boş: ${candidate.run} — bölüm etkilenmedi`));
    }
  }
  return { source: null, runs: trimmedRuns, warnings };
}

/**
 * Tek checkpoint dosyasını bounded tara: 256KB chunk + 500 satır cap +
 * şekil-sıkı normalize. Uyarılar her çağrıda sepete işlenir.
 */
async function scanCheckpointFile(path: string, run: string, warnings: string[]): Promise<ParsedCheckpointEnvelope[]> {
  const envelopes: ParsedCheckpointEnvelope[] = [];
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    warnings.push(`checkpoint okunamadı: ${run} — bölüm etkilenmedi`);
    return envelopes;
  }
  try {
    const chunk = Buffer.alloc(CHECKPOINT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
    const truncated = bytesRead > CHECKPOINT_MAX_BYTES;
    const text = chunk.subarray(0, Math.min(bytesRead, CHECKPOINT_MAX_BYTES)).toString('utf8');
    const lines = text.split('\n');
    let processed = 0;
    let corrupt = 0;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      if (processed >= CHECKPOINT_MAX_LINES) break;
      processed += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      const normalized = normalizeCheckpointEnvelope(raw);
      if (!normalized.ok) {
        corrupt += 1;
        continue;
      }
      envelopes.push(normalized.envelope);
    }
    // Cap penceresi dışında kalan dolu satırlar overCap sayılır.
    const overCap = truncated || processed >= CHECKPOINT_MAX_LINES;
    if (overCap) warnings.push(`checkpoint kırpıldı: ${run} (256KB/500 kayıt sınırı)`);
    if (corrupt > 0) warnings.push(`checkpoint bozuk satır atlandı: ${run} (${corrupt})`);
  } catch {
    warnings.push(`checkpoint okunamadı: ${run} — bölüm etkilenmedi`);
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
  return envelopes;
}

/** D1 uyumluluk kabuğu: yalnızca warnings[] sepeti. */
export async function readCheckpointWarnings(roots: string[]): Promise<string[]> {
  return (await readCheckpointSource(roots)).warnings;
}

export const SUPERVISOR_MAX_BYTES = 256 * 1024;
const SUPERVISOR_MAX_SERVICES = 200;

/**
 * `.ow/supervisor.json` bounded salt-okunur provenance: spawn-kayıtları
 * (ad, port, checkout rev + recordedAt, exitCode). Yoksa sessiz null-kayıt
 * (UI "provenance kaydı yok"); symlink/cap/bozuk fail-closed + warnings[]
 * satırı. Canlı exec yok. `cwdAbs`/`lastReadiness` okunmaz (render
 * edilmeyen alan — yukarıdaki NOT'a bak).
 */
export async function readSupervisorRecords(roots: string[]): Promise<{ records: SupervisorProvenanceRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  const merged = new Map<string, SupervisorProvenanceRecord>();
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const path = join(canonicalRoot, '.ow', 'supervisor.json');
    if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      warnings.push('provenance atlandı (symlink izlenmez): supervisor.json');
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.size > SUPERVISOR_MAX_BYTES) {
      warnings.push(`provenance kırpıldı: ${basename(canonicalRoot)} (256KB sınırı) — bölüm etkilenmedi`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      warnings.push(`provenance okunamadı: ${basename(canonicalRoot)} — bölüm etkilenmedi`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push(`provenance okunamadı: ${basename(canonicalRoot)} — bölüm etkilenmedi`);
      continue;
    }
    const dict = parsed as Record<string, unknown>;
    if (dict['version'] !== 1 || !Array.isArray(dict['services'])) {
      warnings.push(`provenance sürüm uyuşmazlığı: ${basename(canonicalRoot)} — bölüm etkilenmedi`);
      continue;
    }
    const services = (dict['services'] as unknown[]).slice(0, SUPERVISOR_MAX_SERVICES);
    let corrupt = 0;
    for (const item of services) {
      const record = normalizeSupervisorService(item);
      if (!record) {
        corrupt += 1;
        continue;
      }
      if (!merged.has(record.name)) merged.set(record.name, { ...record, rootBase: basename(canonicalRoot) });
    }
    if (corrupt > 0) warnings.push(`provenance bozuk kayıt atlandı: ${basename(canonicalRoot)} (${corrupt})`);
  }
  return { records: [...merged.values()], warnings };
}

// --- Worktree ownership ledger (read-only aggregate, no new exec) ----
// Ledger answers who-is-live-where from already-read state: per-root
// supervisor file + lock classification + bounded HEAD read. Pure file
// reads (lstat/readFile); no spawn, no `git` exec, no farm scan, no writes.
// Same-name services are listed per root (no first-wins collapse at this
// layer); the merged `records` order above is untouched.

export type WorktreeLockState = 'live' | 'stale' | 'absent' | 'corrupt' | 'unknown';
export type WorktreeFileState = 'ok' | 'missing' | 'corrupt' | 'bad-version';

export interface CoordinatorWorktreeEntry {
  rootBase: string;
  revShort: string | null;
  branch: string | null;
  lock: WorktreeLockState;
  /** Spawn-recorded service names not known-dead (no `exitCode`); supervisor
   * liveness itself is the separate `lock` field. */
  liveServices: string[];
  state: WorktreeFileState;
}

export interface WorktreeLedgerPerRoot {
  rootBase: string;
  records: SupervisorProvenanceRecord[];
}

const LEDGER_HEAD_MAX_BYTES = 4096;
const LEDGER_HEX_REV = /^[0-9a-fA-F]{4,64}$/;

/** Bounded HEAD read per root (`.git/HEAD` file or linked-worktree gitdir
 * `HEAD`; ref → branch, detached hex → short-7; anything
 * unreadable/unshaped → nulls, never fail, never `git` exec). */
async function readLedgerHead(canonicalRoot: string): Promise<{ revShort: string | null; branch: string | null }> {
  const capped = async (path: string): Promise<string | null> => {
    try {
      return (await readFile(path, 'utf8')).slice(0, LEDGER_HEAD_MAX_BYTES);
    } catch {
      return null;
    }
  };
  let head = await capped(join(canonicalRoot, '.git', 'HEAD'));
  if (head === null) {
    const pointer = await capped(join(canonicalRoot, '.git'));
    if (pointer !== null) {
      const first = pointer.split('\n', 1)[0].trim();
      if (first.startsWith('gitdir: ')) head = await capped(join(resolve(canonicalRoot, first.slice('gitdir: '.length).trim()), 'HEAD'));
    }
  }
  if (head === null) return { revShort: null, branch: null };
  const line = head.split('\n', 1)[0].trim();
  if (line.startsWith('ref: ')) {
    const ref = line.slice('ref: '.length).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return branch.length > 0 ? { revShort: null, branch } : { revShort: null, branch: null };
  }
  if (LEDGER_HEX_REV.test(line)) return { revShort: line.slice(0, 7), branch: null };
  return { revShort: null, branch: null };
}

/** Supervisor-file classification (CLI `classifySupervisorFile` mirror:
 * missing/ok/corrupt/bad-version) with symlink-reject (fail-closed
 * `corrupt`; the `provenance atlandı` warning stays solely with
 * `readSupervisorRecords` — this reader emits no duplicate file warnings). */
async function classifyLedgerSupervisorFile(canonicalRoot: string): Promise<WorktreeFileState> {
  const path = join(canonicalRoot, '.ow', 'supervisor.json');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return 'missing';
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return 'missing';
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return 'corrupt';
  if (entry.size > SUPERVISOR_MAX_BYTES) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return 'corrupt';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'corrupt';
  const dict = parsed as Record<string, unknown>;
  if (typeof dict['version'] !== 'number') return 'corrupt';
  if (dict['version'] !== 1) return 'bad-version';
  if (!Array.isArray(dict['services'])) return 'corrupt';
  return 'ok';
}

/** Bounded per-root record read (same 256KB/200-service caps as
 * `readSupervisorRecords`; invalid entries drop silently here — the merged
 * reader already warns for the file, so no duplicate warning is emitted). */
async function readLedgerRootRecords(canonicalRoot: string): Promise<SupervisorProvenanceRecord[]> {
  const path = join(canonicalRoot, '.ow', 'supervisor.json');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return [];
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return [];
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > SUPERVISOR_MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const dict = parsed as Record<string, unknown>;
  if (dict['version'] !== 1 || !Array.isArray(dict['services'])) return [];
  const out: SupervisorProvenanceRecord[] = [];
  for (const item of (dict['services'] as unknown[]).slice(0, SUPERVISOR_MAX_SERVICES)) {
    const record = normalizeSupervisorService(item);
    if (record) out.push(record);
  }
  return out;
}

/** Lock classification without exec (CLI `classifyLock` cannot run here —
 * it spawns `ps` via Bun): shape check identical, liveness via signal-0
 * existence probe. Existence-only (no `lstart` PID-reuse guard — residual
 * reuse risk documented; advisory ledger only, never a gate). `EPERM`
 * (exists, unverifiable) → `unknown`; dead/invalid pid → `stale`. */
async function classifyLedgerLock(canonicalRoot: string): Promise<WorktreeLockState> {
  const path = join(canonicalRoot, '.ow', 'supervisor.lock');
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return 'absent';
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return 'absent';
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return 'corrupt';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'corrupt';
  const dict = parsed as Record<string, unknown>;
  if (typeof dict['pid'] !== 'number' || !Number.isInteger(dict['pid']) || (dict['pid'] as number) <= 0 || typeof dict['lstart'] !== 'string') {
    return 'corrupt';
  }
  try {
    process.kill(dict['pid'] as number, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'unknown' : 'stale';
  }
  return 'live';
}

/** Per-root ledger rows + warnings basket. One row per registered root
 * (cap reuses `maxProjectRoots`, overflow truncates with a warnings[] line).
 * File-condition warnings stay with `readSupervisorRecords`; only ledger-own
 * lines (lock-symlink skip, truncation) are emitted here. */
export async function readWorktreeLedger(roots: string[]): Promise<{
  rows: CoordinatorWorktreeEntry[];
  warnings: string[];
  perRoot: WorktreeLedgerPerRoot[];
}> {
  const warnings: string[] = [];
  const capped = roots.slice(0, maxProjectRoots);
  if (roots.length > capped.length) {
    warnings.push(maskSecrets(`worktree listesi kırpıldı (${maxProjectRoots} kök sınırı) — ilk ${maxProjectRoots} kök listelenir`));
  }
  const rows: CoordinatorWorktreeEntry[] = [];
  const perRoot: WorktreeLedgerPerRoot[] = [];
  for (const root of capped) {
    const canonicalRoot = resolve(root);
    const rootBase = basename(canonicalRoot);
    const state = await classifyLedgerSupervisorFile(canonicalRoot);
    const records = state === 'ok' ? await readLedgerRootRecords(canonicalRoot) : [];
    const lock = await classifyLedgerLock(canonicalRoot);
    try {
      const lockEntry = await lstat(join(canonicalRoot, '.ow', 'supervisor.lock'));
      if (lockEntry.isSymbolicLink()) warnings.push(maskSecrets(`kilit atlandı (symlink izlenmez): ${rootBase}`));
    } catch {
      // Absent lock needs no warning (honest `yok` in the row).
    }
    const head = await readLedgerHead(canonicalRoot);
    rows.push({
      rootBase: maskSecrets(rootBase),
      revShort: head.revShort,
      branch: head.branch === null ? null : maskSecrets(head.branch),
      lock,
      liveServices: records.filter(record => record.exitCode === undefined).map(record => maskSecrets(record.name)),
      state,
    });
    perRoot.push({ rootBase, records });
  }
  return { rows, warnings, perRoot };
}

const WORKTREE_ADVISORY_MAX_LINES = 10;

/** Warnings-only collision guardrails (pure, advisory text, never a gate):
 * cross-root port sharing (port source = `SupervisorProvenanceRecord.port`
 * only — no `ow.yaml` reads, no farm scan) + same-service double-ownership
 * (recorded without `exitCode` under ≥2 roots). Every line carries
 * `worktree:<base>` scope tags and the non-gating wording; truncation at 10
 * lines + `…[kesildi: N uyarı]`. Callers emit nothing when ≤1 root. */
export function buildWorktreeAdvisories(perRoot: WorktreeLedgerPerRoot[]): string[] {
  const lines: string[] = [];
  const scope = (bases: string[]): string => bases.map(base => `worktree:${base}`).join(' + ');
  const byPort = new Map<number, string[]>();
  for (const { rootBase, records } of perRoot) {
    for (const record of records) {
      if (typeof record.port !== 'number') continue;
      const bases = byPort.get(record.port) ?? [];
      if (!bases.includes(rootBase)) bases.push(rootBase);
      byPort.set(record.port, bases);
    }
  }
  for (const port of [...byPort.keys()].sort((a, b) => a - b)) {
    const bases = byPort.get(port) as string[];
    if (bases.length < 2) continue;
    lines.push(maskSecrets(`uyarı: ${port} portu dolu — ${scope(bases)} (bilgi amaçlı, engelleme yok)`));
  }
  const byService = new Map<string, string[]>();
  for (const { rootBase, records } of perRoot) {
    for (const record of records) {
      if (record.exitCode !== undefined) continue;
      const bases = byService.get(record.name) ?? [];
      if (!bases.includes(rootBase)) bases.push(rootBase);
      byService.set(record.name, bases);
    }
  }
  for (const name of [...byService.keys()].sort()) {
    const bases = byService.get(name) as string[];
    if (bases.length < 2) continue;
    lines.push(maskSecrets(`uyarı: ${name} birden fazla worktree'de kayıtlı — ${scope(bases)} (bilgi amaçlı, engelleme yok)`));
  }
  if (lines.length <= WORKTREE_ADVISORY_MAX_LINES) return lines;
  const kept = lines.slice(0, WORKTREE_ADVISORY_MAX_LINES);
  kept.push(maskSecrets(`…[kesildi: ${lines.length - WORKTREE_ADVISORY_MAX_LINES} uyarı]`));
  return kept;
}

const ARTIFACT_BASE_PATTERN = /^[^/\\]+$/;
const ARTIFACT_DIGEST_PATTERN = /^[0-9a-fA-F]{7,128}$/;

/** M-C kayıtlı-harita girişi seçimi (CLI `pickArtifactEntries` aynası:
 * şekil-sıkı, bozuk girdi düşer; basename ≤512ch, `..`/`.` yok). */
function pickArtifactEntries(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [base, digest] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof base !== 'string' || base.length === 0 || base.length > 512) continue;
    if (!ARTIFACT_BASE_PATTERN.test(base) || base === '.' || base === '..') continue;
    if (typeof digest !== 'string' || !ARTIFACT_DIGEST_PATTERN.test(digest)) continue;
    out[base] = digest;
  }
  return out;
}

/** M-C indirgenmiş görünüm (CLI `reduceArtifactMap` aynası: maskeli
 * basename + kısa-8, sıralı ilk 32 + sayaç; tam-yol/tam-digest tele çıkmaz). */
function reduceArtifactMap(map: Record<string, string> | undefined): { shown: { base: string; digest: string }[]; rest: number } {
  const bases = Object.keys(map ?? {}).sort();
  const shown = bases.slice(0, 32).map(base => ({ base: maskSecrets(base), digest: (map as Record<string, string>)[base].slice(0, 8) }));
  return { shown, rest: Math.max(0, bases.length - shown.length) };
}

/** Saf supervisor-kayıt normalizasyonu (testler hostile rev'i buradan sokar). */
export function normalizeSupervisorService(raw: unknown): SupervisorProvenanceRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const dict = raw as Record<string, unknown>;
  if (typeof dict['name'] !== 'string' || (dict['name'] as string).trim().length === 0) return null;
  const record: SupervisorProvenanceRecord = { name: dict['name'] as string };
  if (typeof dict['port'] === 'number') record.port = dict['port'] as number;
  if (typeof dict['exitCode'] === 'number') record.exitCode = dict['exitCode'] as number;
  const provenance = dict['provenance'];
  if (provenance !== undefined) {
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return null;
    const prov = provenance as Record<string, unknown>;
    const checkout = prov['checkout'];
    if (checkout !== undefined) {
      if (typeof checkout !== 'object' || checkout === null || Array.isArray(checkout)) return null;
      const checkoutDict = checkout as Record<string, unknown>;
      const rev = revField(checkoutDict['rev']);
      if (rev !== undefined) record.rev = rev;
      else if (checkoutDict['rev'] !== undefined) return null;
      if (checkoutDict['dirty'] === true) record.dirty = true;
    }
    if (typeof prov['recordedAt'] === 'string' && Number.isFinite(Date.parse(prov['recordedAt'] as string))) {
      record.recordedAt = prov['recordedAt'] as string;
    }
  }
  // M-C: derleme haritası şekil-sıkı alınır (bozuk harita düşer, kayıt yaşar;
  // bozuk girdiler düşer, geçerli yaşar).
  if (dict['artifactDigests'] !== undefined) {
    if (typeof dict['artifactDigests'] === 'object' && dict['artifactDigests'] !== null && !Array.isArray(dict['artifactDigests'])) {
      const picked = pickArtifactEntries(dict['artifactDigests']);
      if (Object.keys(picked).length > 0) record.artifactDigests = picked;
    }
  }
  return record;
}

/**
 * M9 overlay second-read (server-side mirror of `cli/up-overlay.ts` —
 * CLI modules are bun-only, so this path mirrors instead of importing;
 * behavior parity is pinned by `test/coordinator.test.ts`). Convention
 * only: `<root>/.ow/boundaries.local.yaml` (no CLI-flag channel
 * server-side exists — flag-scoped runs render the base convention with
 * `overlayApplied: false`). Per-scenario boundaries-REPLACE, never
 * union. Invalid overlays never crash: the base matrix still renders
 * and the refusal surfaces as `overlayError` (error box). Reads nothing
 * outside the root, writes nothing.
 */
const OVERLAY_LOCAL_FILE = 'boundaries.local.yaml';
const OVERLAY_MAX_BYTES = 256 * 1024;
const OVERLAY_MAX_LINES = 500;
const OVERLAY_BLOCKED_REASON_MAX = 128;

interface RootOverlay {
  applied: boolean;
  replacements: Map<string, string[]>;
  warnings: string[];
  error: string | null;
}

const overlayDigestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function overlayBlockedReason(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed !== 'blocked' && !trimmed.startsWith('blocked:')) return null;
  const raw = trimmed === 'blocked' ? '' : trimmed.slice('blocked:'.length).trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function readRootOverlay(
  canonicalRoot: string,
  baseText: string,
  baseNames: Set<string>,
): Promise<RootOverlay> {
  const idle: RootOverlay = { applied: false, replacements: new Map(), warnings: [], error: null };
  const path = join(canonicalRoot, '.ow', OVERLAY_LOCAL_FILE);
  if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) return idle;
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return idle;
  }
  const refused = (reason: string): RootOverlay => ({
    applied: false,
    replacements: new Map(),
    warnings: [],
    error: `overlay-refused: ${OVERLAY_LOCAL_FILE} (${reason})`,
  });
  if (entry.isSymbolicLink()) return refused('symlink not followed');
  if (!entry.isFile()) return refused('not a file');
  if (entry.size > OVERLAY_MAX_BYTES) return refused('oversize');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  } catch {
    return refused('undecodable');
  }
  if (text.split('\n').length > OVERLAY_MAX_LINES + 1) return refused('oversize');
  let doc: Record<string, YamlNode>;
  try {
    doc = yamlParseSubset(text);
  } catch (err) {
    return refused(`invalid overlay file: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
  }
  const warnings: string[] = [];
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'scenarios' && key !== 'baseDigest') {
      warnings.push(`unknown overlay field ignored: ${maskSecrets(key)}`);
    }
  }
  if (doc['version'] !== undefined && doc['version'] !== '1') return refused('unsupported overlay version');
  const digestRaw = doc['baseDigest'];
  if (digestRaw !== undefined && (typeof digestRaw !== 'string' || digestRaw.length === 0 || digestRaw.length > 128)) {
    return refused('invalid baseDigest');
  }
  const raw = doc['scenarios'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refused('scenarios map required');
  const entries = Object.entries(raw as Record<string, YamlNode>);
  if (entries.length === 0) return refused('no scenarios');
  if (entries.length > 32) return refused('at most 32 scenarios');
  const replacements = new Map<string, string[]>();
  for (const [name, node] of entries) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return { applied: false, replacements: new Map(), warnings: [], error: `overlay-dangling: ${maskSecrets(name)} (refused)` };
    }
    const fields = node as Record<string, YamlNode>;
    for (const key of Object.keys(fields)) {
      if (key !== 'boundaries') warnings.push(`${maskSecrets(name)}: unknown overlay field ignored: ${maskSecrets(key)}`);
    }
    const listRaw = fields['boundaries'];
    let list: string[];
    if (listRaw === undefined) list = [];
    else if (typeof listRaw === 'string') list = [listRaw];
    else if (Array.isArray(listRaw) && (listRaw as unknown[]).every(part => typeof part === 'string')) {
      list = [...(listRaw as string[])];
    } else {
      return refused(`invalid boundaries in ${maskSecrets(name)}`);
    }
    for (const boundary of list) {
      if (maskSecrets(boundary) !== boundary) return refused('secret-shaped value');
      const reason = overlayBlockedReason(boundary);
      if (reason !== null && (reason.length === 0 || [...reason].length > OVERLAY_BLOCKED_REASON_MAX)) {
        return refused(`invalid blocked shape in ${maskSecrets(name)}`);
      }
    }
    if (!baseNames.has(name)) {
      return { applied: false, replacements: new Map(), warnings: [], error: `overlay-dangling: ${maskSecrets(name)} (refused)` };
    }
    replacements.set(name, list);
  }
  if (typeof digestRaw === 'string' && digestRaw !== overlayDigestOf(baseText)) {
    warnings.push(`overlay-stale: base changed since ${digestRaw.slice(0, 8)} (warning)`);
  }
  try {
    await lstat(join(canonicalRoot, '.git'));
    let ignore = '';
    try {
      ignore = (await readFile(join(canonicalRoot, '.gitignore'), 'utf8')).slice(0, 64 * 1024);
    } catch {
      warnings.push(`overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`);
    }
    if (ignore !== '' && !ignore.split('\n').some(line => line.trim() === OVERLAY_LOCAL_FILE || line.includes(OVERLAY_LOCAL_FILE))) {
      warnings.push(`overlay-gitignore-missing: ${OVERLAY_LOCAL_FILE} (warning)`);
    }
  } catch {
    // Gitless roots stay silent.
  }
  return { applied: true, replacements, warnings, error: null };
}

/**
 * `<root>/ow.scenarios.yaml` bounded salt-okunur senaryo matrisi kaynağı.
 * Kök-dışı/symlink/cap disiplini §0.3 ile aynı; dosya YOKSA sessiz
 * null-kayıt (UI "senaryo dosyası bağlı değil"), bozuksa error kutusu
 * (diğer paneller sağlam). Çok kökte ilk-kazanan adla birleşir.
 * M9: each root's local overlay convention (`.ow/boundaries.local.yaml`)
 * applies per-scenario REPLACE before the cross-root merge; an invalid
 * overlay keeps the base rows and surfaces `overlayError` (error box,
 * never a crash).
 */
export async function readScenariosSource(roots: string[]): Promise<{
  scenarios: ParsedScenario[] | null;
  error: string | null;
  warnings: string[];
  overlayApplied: boolean;
  overlayFile: string | null;
  boundarySources: OverlayBoundarySource[];
  overlayError: string | null;
}> {
  const warnings: string[] = [];
  const merged = new Map<string, ParsedScenario>();
  const boundarySources: OverlayBoundarySource[] = [];
  let error: string | null = null;
  let found = false;
  let overlayApplied = false;
  let overlayError: string | null = null;
  for (const root of roots) {
    const canonicalRoot = resolve(root);
    const path = join(canonicalRoot, SCENARIOS_FILE_NAME);
    if (resolve(path) !== path || !path.startsWith(canonicalRoot + sep)) continue;
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      warnings.push(`senaryo atlandı (symlink izlenmez): ${SCENARIOS_FILE_NAME}`);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.size > SCENARIOS_MAX_BYTES) {
      warnings.push(`senaryo kırpıldı: ${basename(canonicalRoot)} (256KB sınırı) — bölüm etkilenmedi`);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    } catch {
      warnings.push(`senaryo okunamadı: ${basename(canonicalRoot)} — bölüm etkilenmedi`);
      if (error === null) error = 'dosya okunamadı';
      continue;
    }
    found = true;
    let parsed: { scenarios: ParsedScenario[]; warnings: string[] };
    try {
      parsed = normalizeScenarios(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(maskSecrets(`senaryo bozuk: ${basename(canonicalRoot)} (${reason}) — bölüm etkilenmedi`));
      if (error === null) error = maskSecrets(reason);
      continue;
    }
    for (const warning of parsed.warnings) warnings.push(maskSecrets(warning));
    // M9 convention second-read (server-side, local file only): REPLACE
    // this root's scenario boundaries before the cross-root merge.
    const baseNames = new Set(parsed.scenarios.map(scenario => scenario.name));
    const overlay = await readRootOverlay(canonicalRoot, text, baseNames);
    let scoped = parsed.scenarios;
    if (overlay.error !== null) {
      if (overlayError === null) overlayError = overlay.error;
      warnings.push(maskSecrets(overlay.error));
    } else {
      for (const warning of overlay.warnings) warnings.push(maskSecrets(warning));
      if (overlay.applied) {
        overlayApplied = true;
        scoped = parsed.scenarios.map(scenario => {
          const replacement = overlay.replacements.get(scenario.name);
          return replacement === undefined ? scenario : { ...scenario, boundaries: [...replacement] };
        });
        const replaced = new Set(overlay.replacements.keys());
        for (const scenario of scoped) {
          if (!replaced.has(scenario.name)) continue;
          for (const boundary of scenario.boundaries) {
            boundarySources.push({ scenario: maskSecrets(scenario.name), boundary: maskSecrets(boundary), source: 'local' });
          }
        }
      }
    }
    for (const scenario of scoped) {
      if (!merged.has(scenario.name)) {
        merged.set(scenario.name, scenario);
        if (!overlay.replacements.has(scenario.name)) {
          for (const boundary of scenario.boundaries) {
            boundarySources.push({ scenario: maskSecrets(scenario.name), boundary: maskSecrets(boundary), source: 'base' });
          }
        }
      } else warnings.push(maskSecrets(`senaryo yinelendi: ${scenario.name} (${basename(canonicalRoot)})`));
    }
  }
  const overlayFile = overlayApplied ? OVERLAY_LOCAL_FILE : null;
  if (!found && error === null) return { scenarios: null, error: null, warnings, overlayApplied: false, overlayFile: null, boundarySources: [], overlayError };
  if (merged.size === 0) return { scenarios: null, error: error ?? 'kayıt yok', warnings, overlayApplied: false, overlayFile: null, boundarySources: [], overlayError };
  return { scenarios: [...merged.values()], error: null, warnings, overlayApplied, overlayFile, boundarySources, overlayError };
}

// --- Servis kablosu ------------------------------------------------------------

export interface CoordinatorRuntime {
  list?: Parameters<typeof environmentStatus>[3];
  probe?: (port: number) => Promise<boolean>;
}

export async function coordinatorSnapshot(
  store: Store,
  workspaceName: string,
  environmentName: string,
  runtime: CoordinatorRuntime = {},
  run?: string,
): Promise<CoordinatorSnapshot> {
  const state = await store.read();
  const workspace = resolveWorkspaceRecord(state, workspaceName, verifyMessages.notFoundRegister, verifyMessages.notFoundRegister);
  const { record } = resolveEnvironmentRecord(state, workspaceName, environmentName, {
    workspaceInvalid: verifyMessages.notFoundRegister,
    workspaceNotFound: verifyMessages.notFoundRegister,
    environmentInvalid: environmentMessages.badTopology,
    environmentNotFound: environmentMessages.envNotFound,
  });
  const roots = [...workspace.roots];
  const [status, checkpointRead, supervisorRead, scenariosRead] = await Promise.all([
    environmentStatus(store, workspaceName, environmentName, runtime.list),
    readCheckpointSource(roots, run),
    readSupervisorRecords(roots),
    readScenariosSource(roots),
  ]);
  const probe = runtime.probe ?? probeTcpPort;
  const ports = [...new Set(record.services.map(service => service.port).filter((port): port is number => typeof port === 'number'))];
  const portOccupied = new Map<number, boolean>();
  const freeSuggestion = new Map<number, number | null>();
  const unprobedPorts: number[] = [];
  await Promise.all(ports.map(async port => {
    try {
      const occupied = await probe(port);
      portOccupied.set(port, occupied);
      if (occupied) {
        try {
          freeSuggestion.set(port, await suggestFreePort(port, probe));
        } catch {
          freeSuggestion.set(port, null);
        }
      }
    } catch {
      unprobedPorts.push(port);
    }
  }));
  // Worktree identity: carried only when >1 root. rootBase comes from the
  // recorded topology, revShort from the same-named supervisor record (null
  // when missing → basename-only chip); no new exec/reads.
  const worktreeByService = roots.length > 1
    ? new Map(record.services.map(service => {
      const key = service.name ?? service.id;
      const rev = supervisorRead.records.find(candidate => candidate.name === key)?.rev;
      return [service.id, { rootBase: basename(resolve(service.repositoryPath)), revShort: rev === undefined ? null : shortRev(rev) }] as const;
    }))
    : undefined;
  // Ledger + advisories: read-only aggregation, >1 root only
  // (single-root snapshots carry neither rows nor warnings). Never gates:
  // preflight gates and spawn paths are untouched (warnings[] text only).
  let worktreeLedger: { rows: CoordinatorWorktreeEntry[]; warnings: string[] } | undefined;
  if (roots.length > 1) {
    const ledger = await readWorktreeLedger(roots);
    worktreeLedger = { rows: ledger.rows, warnings: [...ledger.warnings, ...buildWorktreeAdvisories(ledger.perRoot)] };
  }
  return buildCoordinatorSnapshot({
    record,
    status,
    portOccupied,
    freeSuggestion,
    checkpointWarnings: [...checkpointRead.warnings, ...supervisorRead.warnings, ...scenariosRead.warnings],
    checkpoint: checkpointRead.source,
    supervisor: supervisorRead.records,
    scenarioRead: scenariosRead,
    runs: checkpointRead.runs,
    ...(worktreeByService === undefined ? {} : { worktreeByService }),
    ...(worktreeLedger === undefined ? {} : { worktreeLedger }),
    unprobedPorts,
  });
}
