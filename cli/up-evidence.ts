/** Shared redaction core: free-text secret mask + cap/mark. Every
 * reader (join/tree) routes user-controlled text through
 * `maskSecrets` (mask-before-cap); `capText` bounds the length. The B3
 * token patterns live here (single source). */

/** Secret-shaped argv/cmd echo is a masked shape (B3): raw values never
 * enter output/log. Rules: a secret word inside `name=value`
 * (`password|secret|api[_-]?key|bearer|token|credential|private_key|
 * authorization`) → `name=***`; the value after a secret flag
 * (`--password hunter2`) → `***`; provider prefixes (ghp_/sk-/xox-) and
 * ≥32-hex bodies → `***`; a bare part containing a secret word → `***`.
 * Shape is preserved (same part count/order), values drop. */
const SECRET_WORD = /password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization/i
const PROVIDER_PREFIX = /^(ghp_|gho_|ghu_|ghs_|sk-(live|test)-|xox[bpas]-|Bearer\s|eyJ[A-Za-z0-9_-]{8,})/

/** B3 mask list (shared with the evidence mask; single source). */
export const SECRET_WORD_PATTERN = SECRET_WORD
export const PROVIDER_PREFIX_PATTERN = PROVIDER_PREFIX

/** B3 token mask (shared with the evidence mask; single source). */
export const maskSecretToken = (token: string, prevIsSecretFlag: boolean): string => {
  if (token.length === 0) return token
  const eq = token.indexOf("=")
  if (eq > 0) {
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (SECRET_WORD.test(key) || SECRET_WORD.test(value) || /^[0-9a-fA-F]{32,}$/.test(value) || PROVIDER_PREFIX.test(value)) {
      return `${key}=***`
    }
    return token
  }
  if (prevIsSecretFlag) return "***"
  if (/^(-{1,2}[A-Za-z0-9_-]*password|^(-{1,2}[A-Za-z0-9_-]*secret)|(-{1,2}[A-Za-z0-9_-]*token))$/i.test(token)) return token
  if (SECRET_WORD.test(token) || /^[0-9a-fA-F]{32,}$/.test(token) || PROVIDER_PREFIX.test(token)) return "***"
  return token
}

const isSecretFlag = (token: string): boolean =>
  /^(-{1,2})?[A-Za-z0-9_-]*(password|secret|api[_-]?key|bearer|token|credential|private[_-]?key|authorization)$/i.test(token) &&
  !token.includes("=")

/** B3 secret-flag test (shared with the evidence mask; single source). */
export const isSecretFlagToken = isSecretFlag

export const TRUNCATION_MARK = "…[truncated]"

/** Free-text secret mask (B3 list, single source): first the `Bearer`
 * body (the value is the adjacent token), then a whitespace-preserving
 * token walk — `name=value` (including quoted JSON), `name:` + the next
 * value, a post-flag value, a bare secret word, a provider prefix, long hex.
 * All regexes are linear (no O(n²) backtracking). Shapeless bare values
 * like `hunter2` are not masked — sentinel tests place them in a shape. */
export const maskSecrets = (text: string): string => {
  const afterBearer = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
  const looksSecretKey = (token: string): boolean =>
    SECRET_WORD_PATTERN.test(token.replace(/^["']+|["':=]+$/g, ""))
  /** While masking a value, keeps the surrounding quote/punctuation (`"hunter2",`
   * → `"***",`; for structural integrity). */
  const maskWord = (token: string): string => {
    const match = /^(\W*)(.*?)(\W*)$/.exec(token)
    if (!match || match[2].length === 0) return "***"
    return `${match[1]}***${match[3]}`
  }
  const parts = afterBearer.split(/(\s+)/)
  let prev = ""
  let maskNext = false
  return parts
    .map((part) => {
      if (part.length === 0 || /^\s+$/.test(part)) return part
      let masked: string
      if (maskNext) {
        masked = maskWord(part)
        maskNext = false
      } else if (part.includes("=") && !/^[:=]+$/.test(part)) {
        masked = maskSecretToken(part, isSecretFlagToken(prev))
      } else if (/^[:=]+$/.test(part)) {
        if (looksSecretKey(prev)) maskNext = true
        masked = part
      } else if (/[:=]["']?$/.test(part)) {
        if (looksSecretKey(part)) maskNext = true
        masked = part
      } else if (isSecretFlagToken(part)) {
        masked = part
        maskNext = true
      } else if (
        SECRET_WORD_PATTERN.test(part) ||
        /^[0-9a-fA-F]{32,}$/.test(part) ||
        PROVIDER_PREFIX_PATTERN.test(part)
      ) {
        masked = maskWord(part)
      } else {
        masked = part
      }
      prev = part
      return masked
    })
    .join("")
}

/** Cap + truncation mark (character count; the mask is applied FIRST). */
export const capText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length)) + TRUNCATION_MARK
