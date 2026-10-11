/** M7 data-clock witness: pure read + render of runner-written
 * `.ow/data-clock.json` (4KB cap). Presence and shape only - `ow` never
 * connects to a database, runs migrations, or interprets freshness
 * beyond the wall-clock comparison below. All values render masked;
 * raw identities never reach logs, JSON wire shapes stay English. */

import { lstat, open } from "node:fs/promises"
import { join } from "node:path"

import { maskSecrets } from "./up-evidence"

export const DATA_CLOCK_FILE = ".ow/data-clock.json"
export const DATA_CLOCK_MAX_BYTES = 4 * 1024
export const DATA_CLOCK_MAX_CHARS = 64

const DATA_CLOCK_KEYS = ["schema_hash", "applied_head", "seed_profile", "seed_rev", "db_identity", "at"] as const
export type DataClockKey = (typeof DATA_CLOCK_KEYS)[number]
export type DataClockData = Record<DataClockKey, string>

const cleanScalar = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  if (value.length === 0 || value.length > DATA_CLOCK_MAX_CHARS) return null
  if (/[\s\x00-\x1f\x7f]/.test(value)) return null
  return value
}

/** Shape validation (pure): all six keys present as tight 1..64ch
 * whitespace-free strings. Anything else reads as invalid. */
export const parseDataClock = (text: string): { ok: true; data: DataClockData } | { ok: false; reason: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid" }
  }
  const record = parsed as Record<string, unknown>
  const data = {} as DataClockData
  for (const key of DATA_CLOCK_KEYS) {
    const value = cleanScalar(record[key])
    if (value === null) return { ok: false, reason: "invalid" }
    data[key] = value
  }
  return { ok: true, data }
}

export type DataClockRead =
  | { state: "fresh"; data: DataClockData }
  | { state: "stale-ignored"; data: DataClockData }
  | { state: "missing" }
  | { state: "oversize" }
  | { state: "invalid" }

/** Bounded file read (symlinks skipped - no exfiltration surface beyond
 * the 4KB cap; oversize reads as oversize without parsing). */
export const readDataClockFile = async (path: string): Promise<{ bytes: string } | { missing: true } | { oversize: true }> => {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return { missing: true }
  } catch {
    return { missing: true }
  }
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    return { missing: true }
  }
  try {
    const buffer = Buffer.alloc(DATA_CLOCK_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > DATA_CLOCK_MAX_BYTES) return { oversize: true }
    return { bytes: buffer.subarray(0, bytesRead).toString("utf8") }
  } catch {
    return { missing: true }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Freshness against the newest checkpoint evidence time (pure): no
 * checkpoints means nothing newer exists (fresh); an unparseable clock
 * `at` cannot prove staleness (fresh). Stale never gates - the
 * `stale-ignored` state is advisory only, by construction. */
export const selectDataState = (
  parsed: { ok: true; data: DataClockData } | { ok: false; reason: string } | null,
  newestEvidenceAt: number | null,
): DataClockRead => {
  if (parsed === null) return { state: "missing" }
  if (!parsed.ok) return { state: parsed.reason === "oversize" ? "oversize" : "invalid" }
  if (newestEvidenceAt === null) return { state: "fresh", data: parsed.data }
  const atMs = Date.parse(parsed.data.at)
  if (!Number.isFinite(atMs)) return { state: "fresh", data: parsed.data }
  return atMs < newestEvidenceAt ? { state: "stale-ignored", data: parsed.data } : { state: "fresh", data: parsed.data }
}

export type DataLedgerScope = { scope: string; data: DataClockData }

/** Collision scan (pure): identities shared by two or more scopes. */
export const findCollisions = (scopes: DataLedgerScope[]): string[] => {
  const byIdentity = new Map<string, Set<string>>()
  for (const entry of scopes) {
    const set = byIdentity.get(entry.data.db_identity) ?? new Set<string>()
    set.add(entry.scope)
    byIdentity.set(entry.data.db_identity, set)
  }
  return [...byIdentity.entries()]
    .filter(([, scopes]) => scopes.size > 1)
    .map(([identity]) => identity)
    .sort()
}

/** Ledger chip line (masked identity parts, explicit scope). */
export const formatLedgerChip = (scope: string, data: DataClockData): string =>
  `db:${maskSecrets(data.db_identity)} seed:${maskSecrets(data.seed_profile)}/${maskSecrets(data.seed_rev)} mig:${maskSecrets(data.applied_head)} (${scope})`

/** Human dataClock line per state (English, masked). */
export const formatDataClock = (read: DataClockRead): string => {
  if (read.state === "missing") return "dataClock: unmeasured (no-file)"
  if (read.state === "oversize") return "dataClock: unmeasured (data-clock-oversize)"
  if (read.state === "invalid") return "dataClock: unmeasured (invalid)"
  const base = `dataClock: ${maskSecrets(read.data.db_identity)}@${maskSecrets(read.data.applied_head)} (${maskSecrets(read.data.seed_profile)}/${maskSecrets(read.data.seed_rev)})`
  return read.state === "stale-ignored" ? `${base} (stale-ignored)` : base
}

/** Read one scope's clock file (root or service-cwd anchored). */
export const readScopeClock = async (
  dir: string,
  scope: string,
): Promise<{ scope: string; data: DataClockData } | null> => {
  const outcome = await readDataClockFile(join(dir, DATA_CLOCK_FILE))
  if ("missing" in outcome || "oversize" in outcome) return null
  const parsed = parseDataClock(outcome.bytes)
  if (!parsed.ok) return null
  return { scope, data: parsed.data }
}

/** Raw JSON wire shape for reports (masked or null, English keys). */
export const dataWireOf = (data: DataClockData | null): Record<string, string | null> | null => {
  if (data === null) return null
  return {
    schema_hash: maskSecrets(data.schema_hash),
    applied_head: maskSecrets(data.applied_head),
    seed_profile: maskSecrets(data.seed_profile),
    seed_rev: maskSecrets(data.seed_rev),
    db_identity: maskSecrets(data.db_identity),
    at: data.at,
  }
}
