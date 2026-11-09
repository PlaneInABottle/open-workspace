/** Command signature: the shape of a shell command, not its text.
 * Groups `uv run pytest tests/a.py` with `uv run pytest tests/b.py`
 * under `uv run pytest <path>`. Deterministic, no LLM. */

const SUBCOMMAND_TOOLS = new Set([
  "git", "npm", "npx", "bun", "pnpm", "yarn", "uv", "docker", "pm2",
  "kubectl", "gh", "cargo", "go", "make", "just", "brew", "apt", "pip",
  "python", "python3", "node", "deno",
])
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "xargs", "sh", "bash", "zsh", "dash"])
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash"])
const SECOND_LEVEL = new Set(["run", "exec", "runCommand"])
/** Wrapper flags that consume the following token (so `sudo -u bob git log`
 * signs as `git log`, not `bob <arg> <arg>`). Boolean flags are skipped one
 * token at a time by `skipWrapperFlags`. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-D", "-r", "-t", "-U"]),
  env: new Set(["-u", "-C"]),
  time: new Set(["-f", "-o"]),
  xargs: new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-a", "-E", "-e", "-l", "-i"]),
}

/** Drop the wrapper's own options before reading the wrapped command. */
const skipWrapperFlags = (tokens: string[], wrapper: string): string[] => {
  const withValue = WRAPPER_VALUE_FLAGS[wrapper]
  let i = 0
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i]
    if (flag === "--") {
      i += 1
      break
    }
    i += withValue?.has(flag) && i + 1 < tokens.length ? 2 : 1
  }
  return tokens.slice(i)
}

/** Split on top-level separators, respecting single/double quotes. */
const splitTop = (command: string, separators: string[]): string[] => {
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    // Backslash escapes the next char (shell-faithful: \" and \| stay
    // literal, so separators inside \"...\" or after \ never split).
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1]
      i += 2
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      i += 1
      continue
    }
    const hit = separators.find((sep) => command.startsWith(sep, i))
    if (hit) {
      parts.push(current)
      current = ""
      i += hit.length
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** Tokenize respecting quotes; drops redirection targets. */
const tokenize = (segment: string): string[] => {
  // `cmd 2>&1` / `cmd 2>file`: the fd number belongs to the redirection,
  // not to the command shape (`cmd`, never `cmd <n>`).
  const withoutFd = segment.replace(/\b\d+(?=[<>])/g, "")
  const noRedirect = splitTop(withoutFd, [">", "<"]).filter((_, index) => index === 0)
  const text = noRedirect[0] ?? ""
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null
  const push = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ""
    }
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[i + 1]
      i += 1
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }
  push()
  return tokens
}

const basename = (token: string): string => {
  const clean = token.replace(/^["']|["']$/g, "")
  const slash = clean.lastIndexOf("/")
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

const isPathLike = (token: string): boolean =>
  token.includes("/") || token.startsWith(".") || token.startsWith("~") || /\.(py|ts|js|tsx|jsx|sh|json|md|yaml|yml|toml|sql|txt|log)$/.test(token)

const isUrl = (token: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)

/** A pipe side holding only redirections (2>&1, >&2, 2>file) is not a
 * command — it must collapse to 'empty' so the pipe filter drops it. */
const isRedirectOnly = (side: string): boolean => {
  const s = side.trim()
  if (s.length === 0) return true
  if (!/[><]/.test(s)) return false
  const without = s
    .replace(/\d*\s*>>?\s*&?\d+/g, "")
    .replace(/\d*\s*>>?\s*\S+/g, "")
    .replace(/&\s*>>?\s*\S+/g, "")
    .replace(/<<-?\s*['"]?[A-Za-z0-9_]+['"]?/g, "")
    .replace(/[<>]/g, "")
    .replace(/\d+/g, "")
    .replace(/[&\s;-]+/g, "")
  return without.length === 0
}

const placeholder = (token: string): string => {
  const bare = token.replace(/^["']|["']$/g, "")
  if (/^-?[0-9]+$/.test(bare)) return "<n>"
  if (isUrl(bare)) return "<url>"
  if (/^--[a-zA-Z0-9-]+=.+/.test(bare)) return bare.split("=")[0] + "=<v>"
  if (/^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(bare) && !isPathLike(bare)) return bare
  if (isPathLike(bare)) return "<path>"
  if (/^[A-Z_][A-Z0-9_]*=/.test(bare)) return "<env>"
  return "<arg>"
}

/** Common stdlib workhorses, deprioritized so distinctive modules lead the family signature. */
const GENERIC_MODS = new Set([
  "json", "os", "re", "sys", "pathlib", "subprocess", "hashlib", "asyncio",
  "datetime", "collections", "tempfile", "secrets", "copy", "time", "shutil",
  "logging", "urllib", "argparse", "typing",
])

export const familyMods = (mods: string[]): string[] => {
  const distinct = [...new Set(mods.filter((m) => !GENERIC_MODS.has(m)))].sort()
  if (distinct.length > 0) return distinct.slice(0, 5)
  return [...new Set(mods.filter((m) => GENERIC_MODS.has(m)))].sort().slice(0, 3)
}
export const pyModules = (text: string, cap = 6): string[] => {
  const mods: string[] = []
  const scan = text.length > 20_000 ? text.slice(0, 20_000) : text
  for (const seg of scan.split(/[\n;]+/)) {
    const t = seg.trim()
    let m = t.match(/^import\s+(.+)$/)
    if (m) {
      for (const part of m[1].split(",")) {
        const n = part.trim().split(".")[0].split(/\s/)[0]
        if (!n || n === "__future__" || /^[{}}*]/.test(n)) continue
        if (!mods.includes(n)) mods.push(n)
      }
    } else {
      m = t.match(/^from\s+(\S+)\s+import\s+/)
      if (m && !m[1].startsWith(".")) {
        const n = m[1].split(".")[0]
        if (n !== "__future__" && !mods.includes(n)) mods.push(n)
      }
    }
    if (mods.length >= cap) break
  }
  return mods.slice(0, cap)
}

/** Remove heredoc bodies before structural splitting; `;`/`&&` inside code are not shell chains. */
export const stripHeredoc = (text: string): string => {
  let out = text
  for (let i = 0; i < 5; i += 1) {
    const m = out.match(/<<-?\s*['"]?([A-Za-z0-9_]+)['"]?/)
    if (!m || m.index === undefined) break
    const marker = m[1]
    const afterOpener = m.index + m[0].length
    const rest = out.slice(afterOpener)
    const close = rest.match(new RegExp(`^${marker}[ \\t]*\\r?$`, "m"))
    if (!close || close.index === undefined) break
    // Keep whatever follows the opener on its own line (`cat <<'PY' |
    // python3`): only the body between the opener line and the closer is
    // replaced, so the pipe stays part of the command shape.
    const lineEnd = rest.indexOf("\n")
    if (lineEnd < 0) break
    const openerTail = rest.slice(0, lineEnd)
    if (close.index < lineEnd + 1) break
    const next = out.slice(0, afterOpener) + openerTail + " <body> " + rest.slice(close.index + close[0].length)
    if (next === out) break
    out = next
  }
  return out
}

export const signature = (command: unknown): string => {
  if (typeof command !== "string" || command.trim().length === 0) return "unknown"
  // strip heredoc bodies BEFORE collapsing: closers need real newlines
  const stripped = stripHeredoc(command)
  const collapsed = stripped.replace(/\s+/g, " ").trim()
  // heredoc: the runner matters, the body does not
  const heredoc = collapsed.match(/<<-?\s*['"]?([A-Za-z0-9_]+)['"]?/)
  if (collapsed.length > 4000 && !heredoc) return "huge-command"
  const chain = splitTop(stripped, ["&&", "||", ";", "\n"])
  const last = chain[chain.length - 1] ?? collapsed
  // pipeline: normalize each side
  const sides = splitTop(last, ["|"])
  const signed = sides.map((side) => {
    if (isRedirectOnly(side)) return "empty"
    let tokens = tokenize(side)
    // strip leading VAR=x assignments
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
    // unwrap wrappers: sudo, sh -c, env ...
    while (tokens.length > 1 && WRAPPERS.has(basename(tokens[0]).toLowerCase())) {
      const wrapper = basename(tokens[0]).toLowerCase()
      tokens = tokens.slice(1)
      if (SHELL_WRAPPERS.has(wrapper) && (tokens[0] === "-c" || tokens[0] === "-lc") && tokens.length > 1) {
        const inner = tokens.slice(1).join(" ").replace(/^["']|["']$/g, "")
        return `sh-c:${signature(inner)}`
      }
      // env-style leading assignments and the wrapper's own flags/values
      // are not part of the wrapped command's shape.
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
      tokens = skipWrapperFlags(tokens, wrapper)
    }
    if (tokens.length === 0) return "empty"
    const head = basename(tokens[0]).toLowerCase()
    const rest = tokens.slice(1)
    if (rest.length === 0) return head
    // keep subcommand(s) for known tools: git log, uv run pytest, npm run <script>
    if (SUBCOMMAND_TOOLS.has(head) && rest.length > 0 && !rest[0].startsWith("-")) {
      const sub = basename(rest[0]).toLowerCase()
      const tail = rest.slice(1)
      if ((head === "npm" || head === "bun" || head === "pnpm" || head === "yarn") && sub === "run" && tail.length > 0 && !tail[0].startsWith("-")) {
        return `${head} run ${basename(tail[0]).toLowerCase()}`
      }
      if (head === "uv" && SECOND_LEVEL.has(sub) && tail.length > 0 && !tail[0].startsWith("-")) {
        return `${head} ${sub} ${basename(tail[0]).toLowerCase()}`
      }
      const tailSig = tail.map(placeholder)
      return [head, sub, ...tailSig].join(" ")
    }
    return [head, ...rest.map(placeholder)].join(" ")
  })
  const core = signed.filter((part) => part !== "empty").join(" | ") || "empty"
  if (!heredoc) return core
  // python heredocs: imports are the family signature
  if (/python/.test(core)) {
    const mods = familyMods(pyModules(command as string))
    if (mods.length > 0) return `${core} [py:${mods.join(",")}]`
    return `${core} [heredoc:${heredoc[1]}]`
  }
  return `${core} [heredoc:${heredoc[1]}]`
}
