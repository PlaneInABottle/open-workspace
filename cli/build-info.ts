/** Build identity stamped into the binary at `pnpm ow:build` time.
 * Sidecar read for the observer surface (`doctor` identity, `version`). */

import { readFile, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Build identity stamped into the binary at `pnpm ow:build` time.
 * `dirty` is additive (worktree dirtiness at build time); absent on older
 * sidecars (never a failure, reads as undefined). `version` is the
 * package.json version captured at build time (absent on older sidecars). */
export type UpBuildInfo = { sha: string; digest: string; time: string; dirty?: boolean; version?: string }

/** Read an `ow.build.json` sidecar sitting next to the given binary path,
 * resolving symlinks first (covers a `~/.local/bin/ow` shim). Returns the
 * identity triple, or null when missing/unreadable/invalid — never throws. */
export const readBuildSidecar = async (execPath: string): Promise<UpBuildInfo | null> => {
  try {
    const dir = dirname(await realpath(execPath))
    const parsed = JSON.parse(await readFile(join(dir, "ow.build.json"), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const { sha, digest, time, dirty, version } = record
    if (typeof sha !== "string" || typeof digest !== "string" || typeof time !== "string") return null
    if (sha.length === 0 || digest.length === 0 || time.length === 0) return null
    return {
      sha,
      digest,
      time,
      ...(typeof dirty === "boolean" ? { dirty } : {}),
      ...(typeof version === "string" && version.length > 0 ? { version } : {}),
    }
  } catch {
    return null
  }
}

/** Sidecar of the currently running binary (what `doctor` identity and
 * `version` report). */
export const readOwnBuildSidecar = async (): Promise<UpBuildInfo | null> => readBuildSidecar(process.execPath)
