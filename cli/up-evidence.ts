/** Shared redaction core: free-text secret mask + cap/mark. Every
 * remaining reader (ps/explain, logs, export, probe, supervisor,
 * init, join/tree) routes user-controlled text
 * through `maskSecrets` (mask-before-cap); `capText` bounds the length.
 * No envelope/freshness/normalize machinery lives here anymore. */

import { isSecretFlagToken, maskSecretToken, PROVIDER_PREFIX_PATTERN, SECRET_WORD_PATTERN } from "./up-reconcile"

export const TRUNCATION_MARK = "…[truncated]"

/** Secret-shaped object key (single source for the JSON walk below). A
 * `token`-style key qualifies irrespective of its value container. */
const isSecretKey = (key: string): boolean =>
  SECRET_WORD_PATTERN.test(key) || PROVIDER_PREFIX_PATTERN.test(key)

/** Structured JSON value walk (object/array) with inherited secret context.
 * A secret-shaped KEY's value is sensitive BEFORE type recursion: the key
 * context is inherited by the whole subtree (nested strings, numbers and
 * booleans all redact — no never-numbers exemption overrides explicit
 * secret context), while the shape stays valid JSON. Null stays null under
 * any context (absent value, nothing to leak); non-secret numbers, booleans
 * and nulls pass through, so benign counts are never masked. Other strings
 * recurse through `maskSecrets` (a nested shaped secret still masks; a
 * nested compact-JSON string takes the token path). */
const maskJsonValue = (key: string | null, value: unknown, tainted = false): unknown => {
  const secret = tainted || (key !== null && isSecretKey(key))
  if (value === null) return null
  if (typeof value === "string") return secret ? "***" : maskSecrets(value)
  if (typeof value === "number" || typeof value === "boolean") return secret ? "***" : value
  if (Array.isArray(value)) return value.map((entry) => maskJsonValue(null, entry, secret))
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskJsonValue(k, v, secret)]))
  }
  return value
}

/** One whitespace-free token that parses as a JSON object/array masks
 * structurally (parse first, walk values, re-stringify) so the shape stays
 * valid JSON. Returns null only when the token is not complete JSON
 * (partial tokens like `{"token":` keep the existing token-walk behavior).
 * A complete-JSON verdict is final — unchanged input keeps its source bytes
 * (benign JSON stays byte-identical, never falls through to whole-token
 * masking), changed input returns the redacted structure. */
const maskJsonToken = (token: string): string | null => {
  if (!/^[{[]/.test(token)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const masked = maskJsonValue(null, parsed)
  const out = JSON.stringify(masked)
  return out === JSON.stringify(parsed) ? token : out
}

/** Free-text secret mask (B3 list, single source): first the `Bearer`
 * body (the value is the adjacent token), then a whitespace-preserving
 * token walk — `name=value` (including quoted JSON), `name:` + the next
 * value, a post-flag value, a bare secret word, a provider prefix, long hex.
 * Precedence: an explicit post-flag/name-value slot masks its whole value
 * opaquely (structure never rescues survivors); otherwise a whitespace-free
 * token that is complete JSON masks structurally instead
 * (values redacted, shape valid — never the old silent corruption), so this
 * masker is safe on compact JSON by construction. All regexes are linear
 * (no O(n²) backtracking). Shapeless bare values
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
        // Explicit post-flag/name-value context wins over everything: a
        // complete JSON value masks opaquely (structure never rescues
        // unmarked survivors inside it); a plain value keeps the
        // surrounding quote/punctuation via maskWord.
        maskNext = false
        masked = maskJsonToken(part) !== null ? "***" : maskWord(part)
      } else {
        const structured = maskJsonToken(part)
        if (structured !== null) {
          masked = structured
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
      }
      prev = part
      return masked
    })
    .join("")
}

/** Cap + truncation mark (character count; the mask is applied FIRST). */
export const capText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length)) + TRUNCATION_MARK
