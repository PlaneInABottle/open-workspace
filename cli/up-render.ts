/** `ow render`: deterministically generate a per-task manifest from a single
 * base `ow.yaml`.
 *
 * The base file stays the single source (the coordinator owns it;
 * `ow up --check` validates it). A per-task manifest (convention:
 * `.local-runtime/<task>/ow.yaml`, documented not enforced) is a filtered
 * copy with task-local ports/cwds, produced here by pure
 * filter+override+write — never hand-edited. Port allocation stays with the
 * caller (passed as flags); no allocation pool, no env-value store, no
 * build/migration sequencing.
 *
 * Order (init discipline): validate the `--out` target shape, parse the
 * base with the real `parseUpFile`, apply overrides, re-render, re-parse
 * the rendered text, report `missingRequiredEnv` (names only, never
 * values), then atomic `0600` write. A validation failure leaves the
 * original and creates no `.bak`. An existing `--out` refuses without
 * `--force` (exit 2, byte-identical); `--force` keeps a single `.bak`.
 *
 * `env:` values are never copied into the manifest (the task process env
 * provides them); `required-env` names, `readiness` and `logs` carry over.
 * `cmd` keeps its base shape (list stays a flow argv list, string stays a
 * string). Stdout/`--json` carry names/ports only — never secret values. */

import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import { decodeUtf8Fatal, formatUpWarnings, missingRequiredEnv, parseUpFile, type UpService, type UpWarning } from "./up-schema"

export type RenderOptions = {
  baseFile: string
  only?: string
  setPort?: string
  setCwd?: string
  out?: string
  force?: boolean
  json?: boolean
}

export type RenderResult = { code: number; stdout: string; stderr: string }

const fail = (message: string): RenderResult => ({ code: 2, stdout: "", stderr: message })

const splitPairs = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

/** `a,b` name list (used by `--only`). Null on empty input. */
const parseOnly = (raw: string): string[] | null => {
  const names = splitPairs(raw)
  return names.length > 0 ? names : null
}

/** `svc=value` pairs (used by `--set-port`/`--set-cwd`). Throws an English
 * usage error naming the offending entry, never a value. */
const parseAssignments = (raw: string, flag: string): { service: string; value: string }[] => {
  const entries = splitPairs(raw)
  if (entries.length === 0) throw new Error(`invalid ${flag}: empty (svc=value expected)`)
  return entries.map((entry) => {
    const eq = entry.indexOf("=")
    if (eq <= 0 || eq === entry.length - 1) throw new Error(`invalid ${flag}: ${entry} (svc=value expected)`)
    return { service: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() }
  })
}

const validPort = (raw: string): number | null => {
  const num = Number(raw)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null
}

const jsonScalar = (value: string): string => JSON.stringify(value)

const renderServiceYaml = (svc: UpService): string[] => {
  const lines = [`  ${svc.name}:`]
  if (svc.cmd !== undefined) {
    lines.push(typeof svc.cmd === "string" ? `    cmd: ${jsonScalar(svc.cmd)}` : `    cmd: [${svc.cmd.map(jsonScalar).join(", ")}]`)
  }
  if (svc.cwd !== undefined) lines.push(`    cwd: ${jsonScalar(svc.cwd)}`)
  if (svc.port !== undefined) lines.push(`    port: ${svc.port}`)
  if (svc.logs !== undefined) lines.push(`    logs: ${jsonScalar(svc.logs)}`)
  // `env:` deliberately omitted: values are never copied into a task
  // manifest (the task process env provides them). `required-env` carries
  // names only, so it stays — `up --check` still fails early on missing
  // credentials for the rendered file.
  if (svc.requiredEnv !== undefined && svc.requiredEnv.length > 0) {
    lines.push(`    required-env: [${svc.requiredEnv.join(", ")}]`)
  }
  if (svc.readiness !== undefined) {
    lines.push(
      `    readiness: {probe: [${[...svc.readiness.probe].map(jsonScalar).join(", ")}], timeout: ${svc.readiness.timeout}, needsPort: ${svc.readiness.needsPort}}`,
    )
  }
  return lines
}

/** Block YAML with flow argv sequences (JSON-escaped scalars are valid
 * YAML): re-parses through the real `parseUpFile` before any write. */
export const renderManifestYaml = (services: UpService[]): string =>
  `services:\n${services.flatMap(renderServiceYaml).join("\n")}\n`

export const runRender = async (options: RenderOptions): Promise<RenderResult> => {
  const out = options.out
  if (out === undefined || out.trim().length === 0) {
    return fail("ow: --out <path> required (render writes only where pointed)")
  }
  const resolvedOut = resolve(out.trim())
  // Target-shape guards before any tmp creation: a bare `.`/existing
  // directory is refused, and neither the target nor its immediate parent
  // may be a symlink (init lstat discipline — never followed).
  const parent = dirname(resolvedOut)
  if (basename(resolvedOut).length === 0 || resolvedOut === parent) {
    return fail(`ow: refusing --out target: ${out}`)
  }
  try {
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      return fail(`ow: refusing --out with symlinked/unavailable parent: ${out}`)
    }
  } catch {
    return fail(`ow: --out parent not found: ${out}`)
  }
  let outInfo: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    outInfo = await lstat(resolvedOut)
  } catch {
    outInfo = null
  }
  if (outInfo?.isSymbolicLink()) return fail(`ow: refusing symlinked --out target: ${out}`)
  if (outInfo?.isDirectory()) return fail(`ow: --out is a directory: ${out}`)
  if (outInfo !== null && options.force !== true) {
    return fail(`ow: ${out} already exists — use --force to overwrite`)
  }
  let baseText: string
  try {
    baseText = decodeUtf8Fatal(await readFile(options.baseFile))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(`ow: ow.yaml not found: ${options.baseFile}`)
    }
    return fail(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
  }
  let base: ReturnType<typeof parseUpFile>
  try {
    base = parseUpFile(baseText)
  } catch (error) {
    return fail(`ow: invalid ow.yaml: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Filter to the requested subset, keeping base declaration order.
  let selected = [...base.services]
  if (options.only !== undefined) {
    const names = parseOnly(options.only)
    if (names === null) return fail("ow: invalid --only: empty (svcA,svcB expected)")
    const known = new Set(base.services.map((svc) => svc.name))
    for (const name of names) {
      if (!known.has(name)) {
        return fail(`ow: unknown service: ${name} (known: ${base.services.map((svc) => svc.name).join(", ")})`)
      }
    }
    const wanted = new Set(names)
    selected = base.services.filter((svc) => wanted.has(svc.name))
  }
  // Overrides apply to the rendered subset only: naming a service outside
  // it is a usage error (exit 2), never a silent no-op.
  const renderedNames = selected.map((svc) => svc.name).join(", ")
  // Overrides apply to the rendered subset only: naming a service outside
  // it is a usage error (exit 2), never a silent no-op. Targets are the
  // parsed service objects themselves: `env`/`requiredEnv`/`readiness` are
  // non-enumerable, so a spread copy would silently drop them.
  const byName = new Map(selected.map((svc) => [svc.name, svc]))
  const lookup = (name: string, flag: string): { name: string } => {
    if (!byName.has(name)) {
      throw new Error(`unknown service: ${name} (--${flag}${renderedNames.length > 0 ? `; known: ${renderedNames}` : ""})`)
    }
    return { name }
  }
  try {
    if (options.setPort !== undefined) {
      for (const { service, value } of parseAssignments(options.setPort, "--set-port")) {
        const target = byName.get(lookup(service, "set-port").name)
        const port = validPort(value)
        if (port === null) throw new Error(`invalid --set-port: ${service}=${value} (port 1-65535 expected)`)
        if (target) target.port = port
      }
    }
    if (options.setCwd !== undefined) {
      for (const { service, value } of parseAssignments(options.setCwd, "--set-cwd")) {
        const target = byName.get(lookup(service, "set-cwd").name)
        if (target) target.cwd = value
      }
    }
  } catch (error) {
    return fail(`ow: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rendered = [...byName.values()]
  // Validate BEFORE touching disk: re-parse the rendered text through the
  // real schema. A failure leaves the original and creates no `.bak`.
  const text = renderManifestYaml(rendered)
  let reparsed: ReturnType<typeof parseUpFile>
  try {
    reparsed = parseUpFile(text)
  } catch (error) {
    return fail(`ow: invalid render: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (outInfo !== null) {
    const backup = `${resolvedOut}.bak`
    await unlink(backup).catch(() => undefined)
    await rename(resolvedOut, backup)
  }
  try {
    await writeFile(resolvedOut, text, { encoding: "utf8", mode: 0o600 })
    await chmod(resolvedOut, 0o600)
  } catch (error) {
    return fail(`ow: cannot write ${out}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const missing = missingRequiredEnv(reparsed.services)
  const missingNames = [...new Set(missing.flatMap((entry) => entry.vars))]
  const names = reparsed.services.map((svc) => svc.name).join(", ")
  const warnings: UpWarning[] = reparsed.warnings
  if (options.json === true) {
    const payload = {
      out: resolvedOut,
      services: reparsed.services.map((svc) => ({
        name: svc.name,
        ...(svc.port === undefined ? {} : { port: svc.port }),
        ...(svc.cwd === undefined ? {} : { cwd: svc.cwd }),
      })),
      warnings,
    }
    return { code: 0, stdout: JSON.stringify(payload), stderr: formatUpWarnings(warnings).join("\n") }
  }
  const validity =
    missingNames.length === 0
      ? `manifest valid: ${reparsed.services.length} services, no missing required vars`
      : `manifest valid: ${reparsed.services.length} services, ${missingNames.length} missing required vars: ${missingNames.join(", ")}`
  return {
    code: 0,
    stdout: [`wrote: ${resolvedOut} (${reparsed.services.length} services: ${names})`, validity].join("\n"),
    stderr: formatUpWarnings(warnings).join("\n"),
  }
}
