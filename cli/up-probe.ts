/** M3 proje-tanımlı readiness probe çalıştırıcısı: istemci-tarafı one-shot
 * (supervisor içinde ASLA — gating yok, daemon yok). Keyfi yerel komut
 * (B2: ağ kısıtı YOK, read-only sözleşmesi beyana dayalı — ow denetlemez,
 * yalnızca raporlar + cap/timeout/maske uygular). argv-only: shell/sh-c
 * formu şemada reddedilir, burada yorumlanmaz. */

import { maskSecrets } from "./up-evidence"
import { PROBE_TIMEOUT_MS, type UpReadiness } from "./up-schema"

export const PROBE_STDOUT_MAX_BYTES = 64 * 1024
export const PROBE_STDERR_MAX_BYTES = 16 * 1024
export const PROBE_NOTE_MAX_CHARS = 200
export const PROBE_RESULT_NOTE_MAX_CHARS = 500
export const ORPHAN_NOTE = "artakalan-torun-olabilir"

export type ProbeCheck = { name: string; ok: boolean }

export type ProbeOutcome = {
  ok: boolean
  note: string
  checks?: ProbeCheck[]
  timedOut: boolean
  code: number | null
}

export type ProbeSpec = {
  probe: readonly string[]
  timeoutMs: number
  cwd: string
  env: Record<string, string | undefined>
}

/** Tam-çözülmüş spec ile koşum (orkestrasyon varsayılanı; `timeout`
 * etiketi inert — `timeoutMs` kazanır). */
export const runProbeJob = (spec: ProbeSpec): Promise<ProbeOutcome> =>
  runProbe({
    spec: { probe: spec.probe, timeout: "10s", needsPort: true },
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: spec.timeoutMs,
  })

/** Probe çalıştırıcı fn tipi (enjeksiyon noktası; testler sahte verir). */
export type ProbeFn = (spec: ProbeSpec) => Promise<ProbeOutcome>

/** stdout içindeki İLK JSON objeyi bul (derinlik sayaçlı, string-farkındalı).
 * Log-ön-ekli çıktılarda sözleşme objesini yakalar. */
export const findFirstJsonObject = (text: string): string | null => {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === "}") {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) return text.slice(start, i + 1)
    }
  }
  return null
}

type ParsedContract = { ready: boolean; note?: string; checks?: ProbeCheck[] }

/** `{ready: bool, note?: ≤200ch, checks?: [{name, ok}]}` sözleşmesi:
 * ready ZORUNLU bool (yoksa geçersiz); note kırpılır; checks yalnızca
 * şekli tutan girdilerle alınır (bozuk girdiler düşer, fatal değil). */
export const parseProbeContract = (text: string): ParsedContract | null => {
  const raw = findFirstJsonObject(text)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const dict = parsed as Record<string, unknown>
  if (typeof dict["ready"] !== "boolean") return null
  const out: ParsedContract = { ready: dict["ready"] as boolean }
  if (typeof dict["note"] === "string") out.note = (dict["note"] as string).slice(0, PROBE_NOTE_MAX_CHARS)
  if (Array.isArray(dict["checks"])) {
    const checks: ProbeCheck[] = []
    for (const entry of dict["checks"] as unknown[]) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>
        if (typeof record["name"] === "string" && typeof record["ok"] === "boolean") {
          checks.push({ name: record["name"] as string, ok: record["ok"] as boolean })
        }
      }
    }
    out.checks = checks
  }
  return out
}

/** Tek probe koşusu: exit 0 + timeout-içi + geçerli JSON + ready:true =
 * hazır; diğer her şey hazır-değil (retry/restart YOK). Timeout TEK-PID
 * kill (grup-kill YOK; torun sızıntısı notlanır). Çıktılar B3 desen
 * listesiyle maskeli + cap'li (çıplak şekilsiz değerler maskelenmez —
 * probe ham sırrı basmamalı; liste plan B3'ten sabittir); ham argv/loga
 * girmez. Asla throw etmez (sonuçta taşınır). */
export const runProbe = async (opts: {
  spec: UpReadiness
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs?: number
}): Promise<ProbeOutcome> => {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS[opts.spec.timeout]
  const fail = (note: string, extra?: Partial<ProbeOutcome>): ProbeOutcome => ({
    ok: false,
    note: maskSecrets(note).slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
    timedOut: false,
    code: null,
    ...extra,
  })
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([...opts.spec.probe], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    })
  } catch (error) {
    return fail(`başlatılamadı: ${error instanceof Error ? error.message : String(error)}`)
  }
  let stdout = ""
  let stderr = ""
  let truncatedStdout = false
  const pump = async (stream: "stdout" | "stderr"): Promise<void> => {
    const pipe = stream === "stdout" ? proc.stdout : proc.stderr
    if (!pipe || typeof pipe === "number") return
    const reader = (pipe as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const cap = stream === "stdout" ? PROBE_STDOUT_MAX_BYTES : PROBE_STDERR_MAX_BYTES
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (done) break
      buf += decoder.decode(value as Uint8Array, { stream: true })
      if (buf.length > cap) {
        buf = buf.slice(0, cap)
        if (stream === "stdout") truncatedStdout = true
        break
      }
    }
    buf += decoder.decode()
    if (stream === "stdout") stdout = buf.slice(0, cap)
    else stderr = buf.slice(0, cap)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  }, timeoutMs)
  const settled = await Promise.all([proc.exited.catch(() => null), pump("stdout"), pump("stderr")])
  const code = settled[0] as number | null
  clearTimeout(timer)
  if (timedOut) {
    return fail(`zaman aşımı (${Math.round(timeoutMs / 1000)}sn) — not: ${ORPHAN_NOTE}`, { timedOut: true, code })
  }
  if (code !== 0) {
    const contract = parseProbeContract(stdout)
    const errBit = stderr.trim().length > 0 ? ` — stderr: ${stderr.trim().slice(0, 200)}` : ""
    return {
      ok: false,
      note: maskSecrets(`${contract?.note ?? "hazır değil"} (çıkış kodu ${code ?? "?"})${errBit}`).slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
      timedOut: false,
      code,
      ...(contract?.checks === undefined ? {} : { checks: contract.checks }),
    }
  }
  const contract = parseProbeContract(stdout)
  if (contract === null) {
    return fail(`geçersiz JSON (stdout ilk obje bekleniyor)${truncatedStdout ? " — çıktı cap'li" : ""}`, { code })
  }
  if (!contract.ready) {
    return {
      ok: false,
      note: maskSecrets(contract.note ?? "hazır değil").slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
      timedOut: false,
      code,
      ...(contract.checks === undefined ? {} : { checks: contract.checks }),
    }
  }
  return {
    ok: true,
    note: maskSecrets(contract.note ?? "hazır").slice(0, PROBE_RESULT_NOTE_MAX_CHARS),
    timedOut: false,
    code,
    ...(contract.checks === undefined ? {} : { checks: contract.checks }),
  }
}
