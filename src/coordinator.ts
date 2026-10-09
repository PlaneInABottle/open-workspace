/**
 * Dashboard-only coordinator snapshot (D1: P1 ortam haritası + P2 preflight).
 *
 * Salt-okunur aggregate: kayıtlı topoloji + canlı durumdan reconcile
 * (eşleşiyor/kayık) + port preflight + runner-dosya bounded okuma
 * (frozen root, symlink-izlenmez, 256KB/500 cap, latest-only,
 * fail-closed + warnings[]).
 *
 * Secret disiplini: tüm serbest-metin alanlar wire'a yazılmadan önce
 * maskelenir (aşağıdaki maske, cli/up-reconcile.ts + cli/up-evidence.ts
 * kurallarının node-tarafı aynasıdır — CLI bun-only olduğu için import
 * edilmez, davranış değişikliği yok); mutlak path'ler basename'e iner.
 * Ham enum/UUID/rev bu zarfta taşınmaz (D2'nin revisions[] kapsamı dışında).
 */
import { randomBytes } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
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

export interface CoordinatorSnapshot {
  reconcile: CoordinatorReconcile;
  readiness: CoordinatorReadinessEntry[];
  /** D2 kapsamı — D1'de her zaman null. */
  explanation: null;
  preflight: CoordinatorPreflight;
  /** D2 kapsamı — D1'de her zaman null (dosya okunur, yalnızca warnings üretir). */
  checkpoints: null;
  /** D3 kapsamı — D1'de her zaman null. */
  scenarios: null;
  warnings: string[];
  meta: CoordinatorMeta;
}

// --- Saf çekirdek (I/O yok; testler hostile fixture enjekte eder) -------------

function expectedDescriptor(service: EnvironmentRecord['services'][number]): string {
  const script = service.scriptName || '(komut yok)';
  const port = typeof service.port === 'number' ? `${service.port} portu` : 'portsuz';
  return `${script} · ${port}`;
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
    explanation: null,
    preflight: { pass: missing.length === 0, gates, missing },
    checkpoints: null,
    scenarios: null,
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
const runFilePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jsonl$/;

/**
 * `.ow/checkpoints` latest-only bounded tarama: D1 contenuti yok — yalnızca
 * warnings[] sepeti dolar (kırpma/bozuk/yok). Kök dışına çıkış, symlink ve
 * aşırı dosya fail-closed atlanır; bölüm asla ölmez.
 */
export async function readCheckpointWarnings(roots: string[]): Promise<string[]> {
  const warnings: string[] = [];
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
      candidates.push({ name, mtimeMs: entry.mtimeMs });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    const path = join(dir, latest.name);
    const run = latest.name.replace(/\.jsonl$/, '');
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      warnings.push(`checkpoint okunamadı: ${run} — bölüm etkilenmedi`);
      continue;
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
        try {
          JSON.parse(line);
        } catch {
          corrupt += 1;
        }
      }
      // Cap penceresi dışında kalan dolu satırlar overCap sayılır.
      const overCap = truncated || processed >= CHECKPOINT_MAX_LINES;
      if (overCap) warnings.push(`checkpoint kırpıldı: ${run} (256KB/500 kayıt sınırı)`);
      if (corrupt > 0) warnings.push(`checkpoint bozuk satır atlandı: ${run} (${corrupt})`);
    } catch {
      warnings.push(`checkpoint okunamadı: ${run} — bölüm etkilenmedi`);
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return warnings;
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
  const [status, checkpointWarnings] = await Promise.all([
    environmentStatus(store, workspaceName, environmentName, runtime.list),
    readCheckpointWarnings(roots),
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
  return buildCoordinatorSnapshot({ record, status, portOccupied, freeSuggestion, checkpointWarnings, unprobedPorts });
}
