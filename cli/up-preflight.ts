/** P2-B preflight kapısı: salt-okunur kompozisyon (mutasyon YOK).
 * Bayraksız: ow.yaml + supervisor state + read-only liveness (ps lstart
 * yeniden-okuma) + kayıtlı `lastReadiness` + checkpoint zarfları okunur;
 * canlı exec YOK (spawn/stop/restart/project-probe/health-HTTP/git/lsof
 * çalıştırılmaz). `--probe` ile: bildirimli portlara one-shot loopback TCP
 * (M1 N3 bütçesi: servis-başı timeout, toplam ≤60s, aşımda
 * `ölçülmedi(timeout-bütçesi)`). M2/M3 land etmedi: `ps --explain` yok
 * (provenance lensi = canlı servislerde beklenen/çalışan config kimliği),
 * `lastReadiness` yoksa kapı `not_observed` ile düşer (Q1). Gating YOK:
 * kapı yalnızca raporlar, runner karar verir. */

import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { decodeUtf8Fatal, parseUpFile, type UpService } from "./up-schema"
import { isLivePid, readLstart, readSupervisorState, upPaths, type UpServiceState } from "./up-state"
import { reconcileOne, type Liveness, type ReconcileDrift } from "./up-reconcile"
import { tcpListening } from "./up-net"
import { maskSecrets } from "./up-evidence"
import { CHECKPOINTS_DIR_NAME, isValidRunName, readCheckpointFile, viewOf } from "./up-checkpoints"
import type { EvidenceEnvelope } from "./up-evidence"

export type PreflightGateName = "reconcile" | "provenance" | "readiness"
export type PreflightGate = { name: PreflightGateName; pass: boolean; detail: object }

/** Toplam TCP bütçesi (M1 N3) + servis-başı timeout (alt sınırlar; üst sabit). */
export const PREFLIGHT_BUDGET_MS = 60_000
export const PREFLIGHT_PER_SERVICE_MS = 5_000

/** Enjekte edilebilir TCP yoklaması (default gerçek loopback; testler sahte
 * say sayaçla verir — bayraksız koşuda HİÇ çağrılmamalı). */
export type TcpCheck = (port: number) => Promise<boolean>

const defaultTcpCheck: TcpCheck = (port) => tcpListening(port)

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

type LivenessOf = (svc: UpServiceState) => Promise<Liveness>

const realLiveness: LivenessOf = async (svc) => {
  if (svc.exitCode !== undefined) return "dead"
  if (svc.lstart === "") return "unknown"
  const current = await readLstart(svc.pid)
  return current === null ? "dead" : current === svc.lstart ? "live" : "lstart-mismatch"
}

type LastReadiness = { ok: boolean; note?: string }

/** `lastReadiness` hoşgörülü okuma (M3-absent): `{ok: bool}` değilse
 * ölçülmemiş sayılır (kapıyı devirmez, `ölçülmedi` üretir). */
const readLastReadiness = (record: UpServiceState): LastReadiness | null => {
  const raw = (record as unknown as Record<string, unknown>)["lastReadiness"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const dict = raw as Record<string, unknown>
  if (typeof dict["ok"] !== "boolean") return null
  return { ok: dict["ok"] as boolean, ...(typeof dict["note"] === "string" ? { note: dict["note"] as string } : {}) }
}

export type PreflightEvaluation = {
  gates: PreflightGate[]
  missing: string[]
  human: string[]
  envelopes: EvidenceEnvelope[]
  pass: boolean
}

/** Saf-kompozisyon çekirdeği (IO trampleni `runPreflight`'tedir; testler
 * doğrudan çağırır). `tcpResults`: port → true(açık)/false(kapalı)/
 * "unmeasured" — bayraksız koşuda hep boştur (TCP'ye dokunulmaz). */
export const evaluatePreflight = (opts: {
  expected: UpService[]
  running: UpServiceState[]
  liveness: Map<string, Liveness>
  tcpResults?: Map<number, boolean | "unmeasured">
  envelopes: EvidenceEnvelope[]
}): PreflightEvaluation => {
  const missing: string[] = []
  const human: string[] = []
  const runByName = new Map(opts.running.map((svc) => [svc.name, svc]))

  // reconcile geçidi: M1 saf çekirdeği, read-only alt-küme (TCP/lsof yok →
  // listening/owners boş; port-yabancı bu geçitte ÜRETİLMEZ, belgeli).
  const names = [...new Set([...opts.expected.map((svc) => svc.name), ...opts.running.map((svc) => svc.name)])].sort()
  const drifts: ReconcileDrift[] = []
  for (const name of names) {
    const exp = opts.expected.find((svc) => svc.name === name) ?? null
    const run = runByName.get(name) ?? null
    const drift = reconcileOne({ name, expected: exp, running: run, liveness: run ? (opts.liveness.get(name) ?? "dead") : "dead", listening: undefined, portOwners: null })
    if (drift) {
      drifts.push(drift)
      missing.push(`reconcile:${drift.service}:${drift.kind}`)
      human.push(`eksik: ${drift.service} [${drift.kind}] → ${drift.hint}`)
    }
  }
  const inSync = drifts.length === 0

  // provenance geçidi (M2-absent provisional): CANLI servislerde
  // beklenen/çalışan config kimliği (reconcile config-farklı alt-kümesi;
  // aynı olgu, ikinci lens — ölü/bilinmeyen kayıtlar reconcile'indir).
  const liveConfigDiffs = drifts.filter(
    (drift) => drift.kind === "config-farkli" && opts.liveness.get(drift.service) === "live",
  )
  for (const drift of liveConfigDiffs) {
    missing.push(`provenance:${drift.service}:${drift.kind}`)
    human.push(`eksik: ${drift.service} [${drift.kind}] → ${drift.hint}`)
  }

  // readiness geçidi: kayıtlı `lastReadiness` (Q1: yoksa düşer) + `--probe`
  // canlı TCP onayı (ported servislerde ölçüm ZORUNLU: ölçülmedi = düşer).
  const checks: { service: string; ok: boolean; note: string; source: "recorded" | "live-tcp" }[] = []
  for (const svc of opts.expected) {
    const record = runByName.get(svc.name)
    const recorded = record ? readLastReadiness(record) : null
    const tcp = svc.port !== undefined ? opts.tcpResults?.get(svc.port) : undefined
    if (recorded === null) {
      checks.push({ service: svc.name, ok: false, note: "ölçülmedi", source: tcp === undefined ? "recorded" : "live-tcp" })
      missing.push(`readiness:${svc.name}:ölçülmedi`)
      human.push(`hazır-değil: ${svc.name} (ölçülmedi)`)
      continue
    }
    if (!recorded.ok) {
      const note = recorded.note !== undefined ? maskSecrets(recorded.note) : "hazır değil"
      checks.push({ service: svc.name, ok: false, note, source: tcp === undefined ? "recorded" : "live-tcp" })
      missing.push(`readiness:${svc.name}:hazır-değil`)
      human.push(`hazır-değil: ${svc.name} (${note})`)
      continue
    }
    if (tcp === undefined) {
      checks.push({ service: svc.name, ok: true, note: "kayıtlı: hazır", source: "recorded" })
      continue
    }
    if (tcp === "unmeasured") {
      checks.push({ service: svc.name, ok: false, note: "ölçülmedi: timeout-bütçesi", source: "live-tcp" })
      missing.push(`readiness:${svc.name}:ölçülmedi`)
      human.push(`hazır-değil: ${svc.name} (ölçülmedi: timeout-bütçesi)`)
      continue
    }
    if (!tcp) {
      checks.push({ service: svc.name, ok: false, note: "port kapalı", source: "live-tcp" })
      missing.push(`readiness:${svc.name}:port-kapalı`)
      human.push(`hazır-değil: ${svc.name} (port kapalı)`)
      continue
    }
    checks.push({ service: svc.name, ok: true, note: "kayıtlı + canlı TCP", source: "live-tcp" })
  }

  // checkpoint zarfları: bayat/gözlenmedi kapıyı düşürür (fail-closed tanık).
  for (const envelope of opts.envelopes) {
    if (envelope.status === "stale") {
      missing.push(`stale:${envelope.stage}:${envelope.stale_reason}`)
      human.push(`bayat: ${envelope.stage} (neden: ${envelope.stale_reason})`)
    } else if (envelope.status === "not_observed") {
      missing.push(`not-observed:${envelope.stage}`)
      human.push(`eksik: ${envelope.stage} (gözlenmedi)`)
    }
  }

  const gates: PreflightGate[] = [
    { name: "reconcile", pass: inSync, detail: { inSync, drifts } },
    { name: "provenance", pass: liveConfigDiffs.length === 0, detail: { diffs: liveConfigDiffs } },
    { name: "readiness", pass: checks.every((check) => check.ok), detail: { checks } },
  ]
  const pass = gates.every((gate) => gate.pass) && !opts.envelopes.some((envelope) => envelope.status !== "confirmed")
  return { gates, missing, human, envelopes: opts.envelopes, pass }
};

/** One-shot TCP fazı (yalnızca `--probe`): bildirimli portlar, yaml
 * sırası, ardışık. Bütçe biterse kalanlar ölçülmeden geçilir (sayaç
 * kanıtı için `tcpCheck` çağrılmaz). */
export const measureTcpPorts = async (opts: {
  ports: number[]
  tcpCheck?: TcpCheck
  budgetMs?: number
  perServiceMs?: number
}): Promise<Map<number, boolean | "unmeasured">> => {
  const tcpCheck = opts.tcpCheck ?? defaultTcpCheck
  const budgetMs = opts.budgetMs ?? PREFLIGHT_BUDGET_MS
  const perServiceMs = opts.perServiceMs ?? PREFLIGHT_PER_SERVICE_MS
  const results = new Map<number, boolean | "unmeasured">()
  const deadline = Date.now() + budgetMs
  for (const port of new Set(opts.ports)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      results.set(port, "unmeasured")
      continue
    }
    const verdict = await Promise.race([
      tcpCheck(port).then(
        (open) => ({ open }),
        () => ({ open: false }),
      ),
      sleep(Math.min(perServiceMs, remaining)).then(() => ({ open: false, timeout: true as const })),
    ])
    results.set(port, "timeout" in verdict ? "unmeasured" : verdict.open)
  }
  return results
};

/** `ow preflight [--json] [--probe] [--file]`: exit 0 geçti / 1 eksik / 2
 * kullanım (çağrı yeri). Mutasyon YOK. */
export const runPreflight = async (opts: {
  rootDir: string
  file: string
  json: boolean
  probe: boolean
  tcpCheck?: TcpCheck
  budgetMs?: number
  perServiceMs?: number
}): Promise<number> => {
  let text: string
  try {
    const { readFileSync } = await import("node:fs")
    text = decodeUtf8Fatal(readFileSync(opts.file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`ow: ow.yaml bulunamadı: ${opts.file}`)
    } else {
      console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 2
  }
  let expected: UpService[]
  try {
    expected = parseUpFile(text).services
  } catch (error) {
    console.error(`ow: geçersiz ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const paths = upPaths(opts.rootDir)
  const state = await readSupervisorState(paths.supervisorFile)
  let running = state?.services ?? []
  if (state === null) {
    const { classifySupervisorFile } = await import("./up-state")
    const status = await classifySupervisorFile(paths.supervisorFile)
    if (status === "corrupt" || status === "bad-version") {
      console.error("ow: okunamıyor: supervisor.json bozuk — `down --rm` ile temizleyin")
      running = []
    }
  }
  const liveness = new Map<string, Liveness>()
  for (const svc of running) liveness.set(svc.name, await realLiveness(svc))
  let tcpResults: Map<number, boolean | "unmeasured"> | undefined
  if (opts.probe) {
    const ports = expected.filter((svc) => svc.port !== undefined).map((svc) => svc.port as number)
    tcpResults = await measureTcpPorts({ ports, tcpCheck: opts.tcpCheck, budgetMs: opts.budgetMs, perServiceMs: opts.perServiceMs })
  }
  const envelopes: EvidenceEnvelope[] = []
  try {
    const dir = join(paths.stateDir, CHECKPOINTS_DIR_NAME)
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()
    const { readCheckpointFile: readFile } = await import("./up-checkpoints")
    for (const file of files) {
      const run = file.slice(0, -".jsonl".length)
      if (!isValidRunName(run)) continue
      try {
        envelopes.push(...viewOf(run, await readFile(join(dir, file))).envelopes)
      } catch {
        continue
      }
    }
  } catch {
    // checkpoints dizini yoksa zarf bağlamı boştur (fail değil)
  }
  const result = evaluatePreflight({ expected, running, liveness, tcpResults, envelopes })
  if (opts.json) {
    console.log(JSON.stringify({ pass: result.pass, gates: result.gates, missing: result.missing, envelopes: result.envelopes }))
  } else if (result.pass) {
    console.log("hazır: ortam kapıdan geçti")
  } else {
    for (const line of result.human) console.log(line)
  }
  return result.pass ? 0 : 1
}
