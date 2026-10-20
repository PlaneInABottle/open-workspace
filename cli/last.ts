import { readFile } from "node:fs/promises"

import { DEFAULT_LOG_PATH } from "./join"
import { maskSecrets } from "./up-evidence"

export type LastMatch = { command: string; workdir: string; timestamp: string; sessionID: string; exitCode: number }

/** Credential-named assignment (`GH_TOKEN=…`, `export DB_PASSWORD=…`). */
const SECRET_ASSIGNMENT = /\b[A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY)[A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|[^\s;&|]*)/gi
/** A value that only references another variable or command output holds no literal secret. */
const REFERENCE_VALUE = /^["']?\$(?:\{\w+\}|\w+|\(.*\))["']?$/s

/** Re-runnable redaction: a credential assignment keeps its variable name and
 * drops a literal value (`NAME=***`); references (`"$(gh auth token)"`) stay
 * verbatim. Everything else goes through the shared `maskSecrets`. Stashed
 * assignments are restored after the shared mask so its token walk cannot
 * split a quoted `$(…)` value. */
export const maskCommand = (command: string): string => {
  const stash: string[] = []
  const stashed = command.replace(SECRET_ASSIGNMENT, (assignment) => {
    const eq = assignment.indexOf("=")
    const value = assignment.slice(eq + 1)
    stash.push(REFERENCE_VALUE.test(value) ? assignment : `${assignment.slice(0, eq)}=***`)
    return `\u0000${stash.length - 1}\u0000`
  })
  return maskSecrets(stashed).replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)])
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Command-position prefix: start of command or after `;` `&` `|` `(` `$(` (optionally followed by `do`/`then`/`else`), then
 * any env assignments and plain wrappers, then an optional path. Newlines are
 * not separators, so heredoc/quoted bodies never count as an invocation. */
const COMMAND_START = String.raw`(?:^|[;&|(]|\$\()[ \t]*(?:(?:do|then|else)[ \t]+)?(?:(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)|timeout\s+\d+\S*|env|time|sudo|nohup|exec)\s+)*(?:[^\s;&|()]*/)?`

/** Heredoc bodies are data, not invocations: drop everything after the line
 * that opens the first heredoc (`<<`, `<<-`, quoted or bare delimiter). */
const withoutHeredocBody = (command: string): string => {
  const open = /<<-?[ \t]*['"]?\w+['"]?[^\n]*/.exec(command)
  return open ? command.slice(0, open.index + open[0].length) : command
}

/** True when `pattern` begins a command (token position), not just a substring. */
export const atCommandPosition = (command: string, pattern: string): boolean =>
  new RegExp(`${COMMAND_START}${escapeRegex(pattern)}(?=$|[\\s;&|)])`, "i").test(withoutHeredocBody(command))

/** `ow` invoking itself (bare, `./ow`, or by path) never counts as prior work. */
const isOwInvocation = (command: string): boolean => atCommandPosition(command, "ow")

/** Newest-first distinct (command, cwd) shell records whose masked command
 * contains `pattern` (case-insensitive); matches at a command position beat
 * substring-only matches, and `ow` invocations are skipped. `failed` selects non-zero exits
 * instead of exit 0; rows without a numeric exit code never match. */
export const findLast = (
  logText: string,
  options: { pattern: string; count: number; failed?: boolean; sinceMs?: number | null; dir?: string; now?: number },
): LastMatch[] => {
  const needle = options.pattern.toLowerCase()
  const cutoff = options.sinceMs ? (options.now ?? Date.now()) - options.sinceMs : null
  const rows: LastMatch[] = []
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const { command, workdir, timestamp, exitCode, sessionID } = record
    if (typeof command !== "string" || typeof workdir !== "string" || typeof timestamp !== "string") continue
    if (typeof exitCode !== "number" || (options.failed ? exitCode === 0 : exitCode !== 0)) continue
    if (cutoff !== null && Date.parse(timestamp) < cutoff) continue
    if (options.dir && !workdir.startsWith(options.dir)) continue
    rows.push({ command, workdir, timestamp, sessionID: typeof sessionID === "string" ? sessionID : "", exitCode })
  }
  rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  const candidates = rows
    .map((row) => ({ ...row, command: maskCommand(row.command) }))
    .filter((row) => withoutHeredocBody(row.command).toLowerCase().includes(needle) && !isOwInvocation(row.command))
  // Token-position matches win outright; plain substring hits (outside heredoc
  // bodies) are the fallback.
  const tokenHits = candidates.filter((row) => atCommandPosition(row.command, options.pattern))
  const pool = tokenHits.length > 0 ? tokenHits : candidates
  const seen = new Set<string>()
  const out: LastMatch[] = []
  for (const row of pool) {
    const key = `${row.workdir}\u0000${row.command}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
    if (out.length >= options.count) break
  }
  return out
}

export const formatLast = (matches: LastMatch[], failed = false): string =>
  matches
    .map((m) =>
      [`# cwd: ${m.workdir}`, `# at: ${m.timestamp}  session: ${m.sessionID}${failed ? `  exit: ${m.exitCode}` : ""}`, m.command].join("\n"),
    )
    .join("\n\n")

export const readLog = async (logPath: string = DEFAULT_LOG_PATH): Promise<string | null> => {
  try {
    return await readFile(logPath, "utf8")
  } catch {
    return null
  }
}
