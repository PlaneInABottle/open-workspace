/** M2 readiness with teeth: boundary-scan pure kernel (no exec, no I/O).
 * Reads, as data: ow.yaml services + normalized scenario boundary claims +
 * supervisor records (lastReadiness/artifactDigests) + checkpoints view +
 * caller-supplied fresh artifact declarations + migration-history presence +
 * raw ow.yaml `version:` value. Every detector fires on positive evidence
 * only (absent data is silent — healthy fixtures stay green).
 *
 * Reuse notes: stale-jar comparison mirrors `reconcileOne` artifact-stale
 * (case-insensitive hex, first sorted basename, basename-only output) and
 * renders through `formatDrift`, so `derleme-eski:` lines read identically;
 * digest display reuses `reduceArtifactMap` (masked basename + short-8). */

import { formatDrift, type ReconcileDrift } from "./up-reconcile"
import { maskSecrets } from "./up-evidence"
import { reduceArtifactMap } from "./up-probe"
import type { UpService } from "./up-schema"
import type { UpServiceState } from "./up-state"
import type { EvidenceEnvelope } from "./up-evidence"

export type FalseGreenKind = "stale-jar" | "v5-confusion" | "origin-403" | "msw-vite-trap"
export type BoundaryFalseGreen = { kind: FalseGreenKind; service: string; hint: string }
export type BoundaryScan = { missing: string[]; stale: string[]; falseGreens: BoundaryFalseGreen[] }

/** Normalized evidence-demanding claim (I/O layer maps raw values through
 * M1 `normalizeBoundary` and drops unknown/unverified/network-deny/blocked:
 * unknown stays M1 warn-only, network-deny has nothing observable to prove,
 * blocked is human-gated, unverified is explicitly unverified). */
export type BoundaryClaim = { scenario: string; service: string; boundary: string }

/** Boundaries that demand backing evidence. */
const EVIDENCE_DEMANDING: ReadonlySet<string> = new Set(["real-read-only", "real-state-changing", "subscribed"])

/** I/O-layer claim filter (M1 `normalizeBoundary` output in, claim out). */
export const isEvidenceDemanding = (normalized: string): boolean => EVIDENCE_DEMANDING.has(normalized)

/** evaluatePreflight composition input (all fields optional except claims;
 * absent input means an empty passing gate — old callers unaffected). */
export type BoundaryGateInput = {
  claims: BoundaryClaim[]
  declaredArtifacts?: Record<string, Record<string, string>>
  migrationObserved?: Record<string, boolean>
  configVersion?: string
  scenariosUnreadable?: boolean
}

export type BoundaryScanInput = {
  services: UpService[]
  claims: BoundaryClaim[]
  records: UpServiceState[]
  envelopes: EvidenceEnvelope[]
  /** Fresh probe-declared digests per service (service -> base -> digest).
   * No pure fresh source exists at the CLI layer in M2, so callers inject
   * observations (tests + future composition); absent means silent. */
  declaredArtifacts: Record<string, Record<string, string>>
  /** Migration-history presence per service (absent key = unknown). */
  migrationObserved: Record<string, boolean>
  /** Raw ow.yaml `version:` value (undefined when absent). */
  configVersion: string | undefined
}

/** Migration-tooling markers in config text (heuristic, documented: the
 * matched signal is a declared migration path with no observed history). */
const MIGRATION_MARKERS = /migrat|prisma|drizzle|knex|flyway|liquibase|alembic|typeorm/i

/** Mock-traffic markers: MSW shapes are unambiguous mocks. Bare `vite dev`
 * stays silent (healthy dev server); `vite preview` serves a frozen build. */
const MOCK_MARKERS = /\bmsw\b|mock-service-worker|mockServiceWorker/i
const PREVIEW_MARKERS = /vite\s+preview|vite-preview/i

/** Recorded 403 evidence (bounded digits both sides, so `14035` never matches). */
const NOTE_403 = /(^|[^0-9A-Za-z])403([^0-9A-Za-z]|$)/

/** Config text under witness (names only from env; values never stored). */
const configTextOf = (svc: UpService): string => {
  const cmd = Array.isArray(svc.cmd) ? svc.cmd.join("\n") : (svc.cmd ?? "")
  return `${cmd}\n${svc.logs ?? ""}`
}

const hasArtifacts = (record: UpServiceState): boolean =>
  record.artifactDigests !== undefined && Object.keys(record.artifactDigests).length > 0

const parseTime = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Human line for one catalog finding (Turkish, locked prefixes).
 * stale-jar hint carries the full `derleme-eski:` line via `formatDrift`
 * (service + base + remedy), so it renders verbatim. */
export const formatFalseGreen = (finding: BoundaryFalseGreen): string => {
  switch (finding.kind) {
    case "stale-jar":
      return finding.hint
    case "origin-403":
      return `origin-suspect: ${finding.service} (403 recorded — not down)`
    case "msw-vite-trap":
      return `mock-traffic: ${finding.service} (${finding.hint})`
    case "v5-confusion":
      return `version-confusion: ${finding.service} (${finding.hint})`
  }
}

export const scanBoundaries = (input: BoundaryScanInput): BoundaryScan => {
  const missing: string[] = []
  const stale: string[] = []
  const falseGreens: BoundaryFalseGreen[] = []
  const byName = new Map(input.services.map((svc) => [svc.name, svc]))
  const recordByName = new Map(input.records.map((record) => [record.name, record]))
  const confirmedEnvelopes = input.envelopes.some((envelope) => envelope.status === "confirmed")

  for (const claim of input.claims) {
    if (!EVIDENCE_DEMANDING.has(claim.boundary)) continue
    const expected = byName.get(claim.service)
    // Unknown services stay M1 warn-only territory: never fail here.
    if (expected === undefined) continue
    const record = recordByName.get(claim.service)
    if (claim.boundary === "subscribed") {
      // Subscription means the checkpoint stream: only confirmed envelopes back it.
      if (!confirmedEnvelopes) missing.push(`boundary:${claim.service}:no-subscription`)
      continue
    }
    const backed = record !== undefined && (record.lastReadiness !== undefined || hasArtifacts(record))
    if (!backed) {
      missing.push(`boundary:${claim.service}:no-evidence`)
      continue
    }
    // State-changing claims with a declared migration path but no observed
    // history: the app may be ready while its schema is stale.
    if (
      claim.boundary === "real-state-changing" &&
      MIGRATION_MARKERS.test(configTextOf(expected)) &&
      input.migrationObserved[claim.service] !== true
    ) {
      missing.push(`boundary:${claim.service}:no-migration-evidence`)
    }
  }

  // Non-v1 `version:` key: parsed as v1 while the author meant v5 semantics.
  // Every service's expected config was read under that confusion.
  if (input.configVersion !== undefined && input.configVersion !== "1") {
    const version = maskSecrets(input.configVersion)
    for (const svc of input.services) {
      falseGreens.push({
        kind: "v5-confusion",
        service: svc.name,
        hint: `ow.yaml version "${version}" ignored — v1 assumed`,
      })
    }
  }

  for (const svc of input.services) {
    const text = configTextOf(svc)
    if (MOCK_MARKERS.test(text)) {
      falseGreens.push({ kind: "msw-vite-trap", service: svc.name, hint: "MSW marker" })
    } else if (PREVIEW_MARKERS.test(text)) {
      falseGreens.push({ kind: "msw-vite-trap", service: svc.name, hint: "vite-preview marker" })
    }
  }

  for (const record of input.records) {
    const note = record.lastReadiness?.note
    if (note !== undefined && NOTE_403.test(note)) {
      falseGreens.push({
        kind: "origin-403",
        service: record.name,
        hint: "403 on record — not down; discriminate with --probe",
      })
    }
    const seenAt = parseTime(record.lastReadiness?.at)
    const startedAt = parseTime(record.startedAt)
    if (seenAt !== null && startedAt !== null && seenAt < startedAt) {
      stale.push(`boundary:${record.name}:stale-record`)
    }
    const recorded = record.artifactDigests ?? {}
    const declared = input.declaredArtifacts[record.name] ?? {}
    for (const base of Object.keys(declared).sort()) {
      const seen = recorded[base]
      if (seen !== undefined && seen.toLowerCase() !== declared[base].toLowerCase()) {
        const drift: ReconcileDrift = {
          service: record.name,
          kind: "artifact-stale",
          expected: { artifact: maskSecrets(base) },
          running: { pid: record.pid },
          hint: `yeniden-derle + ow restart ${record.name}`,
        }
        falseGreens.push({ kind: "stale-jar", service: record.name, hint: formatDrift(drift) })
        break
      }
    }
  }

  return { missing, stale, falseGreens }
}

/** Boundary gate detail (additive JSON): findings + digest/migration report.
 * Digests reuse `reduceArtifactMap` (masked basename + short-8, never raw). */
export type BoundaryGateDetail = {
  missing: string[]
  stale: string[]
  falseGreens: BoundaryFalseGreen[]
  artifacts: Record<string, { shown: { base: string; digest: string }[]; rest: number }>
  migrations: Record<string, boolean>
}

export const boundaryGateDetail = (
  input: Pick<BoundaryScanInput, "services" | "records" | "migrationObserved">,
  scan: BoundaryScan,
): BoundaryGateDetail => {
  const artifacts: BoundaryGateDetail["artifacts"] = {}
  for (const record of input.records) {
    if (!hasArtifacts(record)) continue
    artifacts[record.name] = reduceArtifactMap(record.artifactDigests)
  }
  const migrations: BoundaryGateDetail["migrations"] = {}
  for (const svc of input.services) {
    if (MIGRATION_MARKERS.test(configTextOf(svc)) || input.migrationObserved[svc.name] !== undefined) {
      migrations[svc.name] = input.migrationObserved[svc.name] === true
    }
  }
  return { missing: scan.missing, stale: scan.stale, falseGreens: scan.falseGreens, artifacts, migrations }
}
