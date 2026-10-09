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
import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Store, resolveEnvironmentRecord, resolveWorkspaceRecord, type EnvironmentRecord } from './store.js';
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
}

export type ScenarioVerdict = 'pass' | 'stale' | 'skipped' | 'uncovered' | 'unverified';

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
}

export interface CoordinatorExplanation {
  entries: CoordinatorExplanationEntry[];
  revisions: CoordinatorRevision[];
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
  warnings: string[];
  meta: CoordinatorMeta;
}

// --- Checkpoint zarf aynası (cli/up-evidence.ts + cli/up-checkpoints.ts) ----
// Şekil-sıkı fail-closed: bozuk satır bölümü öldürmez (corrupt sayılır).

const ENVELOPE_BY = new Set(['runner', 'ow-preflight', 'ow-reconcile', 'ow-probe']);
const STALE_REASONS = new Set(['script_hash', 'checkout_rev', 'runtime', 'missing_basis']);
const SAFE_NEXT_ACTION_MAX = 512;
const REV_MAX_CHARS = 64;

export interface ParsedCheckpointEnvelope {
  stage: string;
  status: CheckpointStageStatus;
  staleReason: string | null;
  safeNextAction: string | null;
  at: string;
  checkoutRev?: string;
  scriptHash?: string;
  port?: number;
  /**
   * Tam çözümlenmiş cwd — YALNIZCA tazelik karşılaştırması için iç slot
   * (CLI `slotsOf` aynası: cwd tam-yoldan karşılaştırılır). Wire'a/çıktıya
   * çıkmaz (basename indirgemesi bile yok — cwd P3/P4'te render edilmez).
   */
  cwdFull?: string;
  provenanceRev?: string;
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
    const scriptHash = revField(code['script_hash']);
    const checkoutRev = revField(code['checkout_rev']);
    if (scriptHash !== undefined) envelope.scriptHash = scriptHash;
    if (checkoutRev !== undefined) envelope.checkoutRev = checkoutRev;
    if (scriptHash === undefined && checkoutRev === undefined && Object.keys(code).length > 0) return { ok: false };
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
  return { ok: true, envelope };
}

function applyCheckpointFreshness(envelopes: ParsedCheckpointEnvelope[]): ParsedCheckpointEnvelope[] {
  const basisByStage = new Map<string, ParsedCheckpointEnvelope>();
  for (const envelope of envelopes) {
    if (envelope.status === 'confirmed' && !basisByStage.has(envelope.stage)) basisByStage.set(envelope.stage, envelope);
  }
  return envelopes.map(envelope => {
    if (envelope.status !== 'confirmed') return { ...envelope };
    if (envelope.scriptHash === undefined && envelope.checkoutRev === undefined && envelope.port === undefined && envelope.cwdFull === undefined && envelope.provenanceRev === undefined) {
      return { ...envelope, status: 'stale' as const, staleReason: 'missing_basis' };
    }
    const basis = basisByStage.get(envelope.stage) as ParsedCheckpointEnvelope;
    if (basis.scriptHash !== envelope.scriptHash) return { ...envelope, status: 'stale' as const, staleReason: 'script_hash' };
    if (basis.checkoutRev !== envelope.checkoutRev) return { ...envelope, status: 'stale' as const, staleReason: 'checkout_rev' };
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

function buildScenarios(
  record: EnvironmentRecord,
  checkpoint: CheckpointSource | null,
  parsed: ParsedScenario[],
  fileWarnings: string[],
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
  return { file: SCENARIOS_FILE_NAME, columns: shownColumns, rows, warnings: warnings.map(warning => maskSecrets(warning)), error: null };
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
  return {
    run: source.run,
    runs: source.runs,
    stages,
    summary: { confirmed, stale, notObserved },
    lastVerified,
    firstGap,
    safeNextAction: actionSource?.safeNextAction ?? null,
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
  read: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[] } | null,
): CoordinatorScenarios | null {
  if (!read || (read.scenarios === null && read.error === null)) return null;
  if (read.scenarios === null) {
    return { file: SCENARIOS_FILE_NAME, columns: [], rows: [], warnings: [], error: read.error ?? 'kayıt yok' };
  }
  return buildScenarios(record, checkpoint, read.scenarios, read.warnings);
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
  scenarioRead?: { scenarios: ParsedScenario[] | null; error: string | null; warnings: string[] } | null;
  /** Keşfedilen run adları — checkpoints null iken bile wire'a çıkar. */
  runs?: string[];
  unprobedPorts?: number[];
  producedAt?: string;
  snapshotId?: string;
}): CoordinatorSnapshot {
  const warnings = input.checkpointWarnings.map(warning => maskSecrets(warning));
  for (const port of input.unprobedPorts ?? []) {
    warnings.push(`port yoklaması ölçülemedi: ${port} — preflight bu portu boş sayar`);
  }
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
      return {
        serviceId: maskSecrets(entry.serviceId),
        name: maskSecrets(entry.name),
        dir: service ? basename(resolve(service.repositoryPath)) : null,
        status: entry.status,
        detail: maskSecrets(entry.detail),
        lastPoll: entry.owned?.lastPoll ?? null,
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

  return {
    reconcile: { inSync: drifts.length === 0, drifts },
    readiness,
    explanation: buildExplanation(input.record, input.status, input.checkpoint ?? null, input.supervisor ?? null),
    preflight: { pass: missing.length === 0, gates, missing },
    checkpoints: buildCheckpoints(input.checkpoint ?? null),
    scenarios: buildScenariosSection(input.record, input.checkpoint ?? null, input.scenarioRead ?? null),
    runs: input.runs ?? [],
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
      if (!merged.has(record.name)) merged.set(record.name, record);
    }
    if (corrupt > 0) warnings.push(`provenance bozuk kayıt atlandı: ${basename(canonicalRoot)} (${corrupt})`);
  }
  return { records: [...merged.values()], warnings };
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
  return record;
}

/**
 * `<root>/ow.scenarios.yaml` bounded salt-okunur senaryo matrisi kaynağı.
 * Kök-dışı/symlink/cap disiplini §0.3 ile aynı; dosya YOKSA sessiz
 * null-kayıt (UI "senaryo dosyası bağlı değil"), bozuksa error kutusu
 * (diğer paneller sağlam). Çok kökte ilk-kazanan adla birleşir.
 */
export async function readScenariosSource(roots: string[]): Promise<{
  scenarios: ParsedScenario[] | null;
  error: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const merged = new Map<string, ParsedScenario>();
  let error: string | null = null;
  let found = false;
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
    for (const scenario of parsed.scenarios) {
      if (!merged.has(scenario.name)) merged.set(scenario.name, scenario);
      else warnings.push(maskSecrets(`senaryo yinelendi: ${scenario.name} (${basename(canonicalRoot)})`));
    }
  }
  if (!found && error === null) return { scenarios: null, error: null, warnings };
  if (merged.size === 0) return { scenarios: null, error: error ?? 'kayıt yok', warnings };
  return { scenarios: [...merged.values()], error: null, warnings };
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
    unprobedPorts,
  });
}
