/** Shared redaction core: free-text secret mask + cap/mark. Every
 * remaining reader (ps/explain, logs, export, probe, supervisor,
 * init, join/tree) routes user-controlled text
 * through `maskSecrets` (mask-before-cap); `capText` bounds the length.
 * No envelope/freshness/normalize machinery lives here anymore. */

import { isSecretFlagToken, maskSecretToken, PROVIDER_PREFIX_PATTERN, SECRET_WORD_PATTERN } from "./up-reconcile"

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
