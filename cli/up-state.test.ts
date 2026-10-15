/** `ensureOwGitignore` unit coverage + `ow up` integration: the tooling
 * `.ow/` dir must never be committed, so `up` keeps a repo-root `.gitignore`
 * entry (create-or-append, warn-only, byte-identical when present). */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { ensureOwGitignore, readBuildSidecar, resolveWorkspaceRoot } from "./up-state"
import { runSuperviseFile } from "./up-supervisor-cli"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-up-state-"))

const withCwd = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const saved = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(saved)
  }
}

describe("ensureOwGitignore", () => {
  test("creates the entry when .gitignore is missing", async () => {
    const root = await tempRoot()
    try {
      expect(await ensureOwGitignore(root)).toBeNull()
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".ow/\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("appends after existing lines, with or without trailing newline", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, ".gitignore"), "node_modules/\n")
      expect(await ensureOwGitignore(root)).toBeNull()
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.ow/\n")
      await writeFile(join(root, ".gitignore"), "dist")
      expect(await ensureOwGitignore(root)).toBeNull()
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("dist\n.ow/\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("already-covered entry leaves the file byte-identical", async () => {
    const root = await tempRoot()
    try {
      for (const body of ["node_modules/\n.ow/\n", "/.ow\n"]) {
        await writeFile(join(root, ".gitignore"), body)
        expect(await ensureOwGitignore(root)).toBeNull()
        expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(body)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing parent warns instead of throwing; no values logged", async () => {
    const root = await tempRoot()
    try {
      const warn = await ensureOwGitignore(join(root, "missing"))
      expect(typeof warn).toBe("string")
      expect(warn as string).toContain(".gitignore")
      expect(warn as string).not.toContain("missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("up gitignore integration", () => {
  test("runSuperviseFile ensures .gitignore alongside .ow", async () => {
    const root = await tempRoot()
    try {
      const yaml = join(root, "ow.yaml")
      await writeFile(yaml, "services:\n  a:\n    cmd: echo hi\n")
      expect(await runSuperviseFile(yaml, { quiet: true })).toBe(0)
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".ow/\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("up --check still exits 0; a legacy trace: block warns as unknown and is ignored", async () => {
    const root = await tempRoot()
    try {
      const plain = join(root, "plain.yaml")
      await writeFile(plain, "services:\n  a:\n    cmd: x\n")
      expect(await run(["up", "--check", "--file", plain])).toBe(0)
      const legacy = join(root, "legacy.yaml")
      await writeFile(legacy, "trace:\n  port: 4319\nservices:\n  a:\n    cmd: x\n")
      const err: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        err.push(args.map(String).join(" "))
      }
      let code = -1
      try {
        code = await run(["up", "--check", "--file", legacy])
      } finally {
        console.error = savedError
      }
      expect(code).toBe(0)
      expect(err.join("\n")).toContain("unknown top-level field ignored: trace")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("required-env: missing var exits 2 naming service and var; provided vars pass", async () => {
    const root = await tempRoot()
    const saved = process.env.OW_REQ_TEST_VAR
    delete process.env.OW_REQ_TEST_VAR
    try {
      const missing = join(root, "missing.yaml")
      await writeFile(missing, "services:\n  db:\n    cmd: x\n    required-env: [OW_REQ_TEST_VAR]\n")
      const errors: string[] = []
      const savedError = console.error
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(" "))
      }
      let code = -1
      try {
        code = await run(["up", "--check", "--file", missing])
      } finally {
        console.error = savedError
      }
      expect(code).toBe(2)
      expect(errors.join("\n")).toContain("db")
      expect(errors.join("\n")).toContain("OW_REQ_TEST_VAR")
      const fromEnv = join(root, "from-env.yaml")
      await writeFile(fromEnv, "services:\n  db:\n    cmd: x\n    env: {OW_REQ_TEST_VAR: s3cr3t}\n    required-env: [OW_REQ_TEST_VAR]\n")
      expect(await run(["up", "--check", "--file", fromEnv])).toBe(0)
      process.env.OW_REQ_TEST_VAR = "from-process"
      const fromProc = join(root, "from-proc.yaml")
      await writeFile(fromProc, "services:\n  db:\n    cmd: x\n    required-env: [OW_REQ_TEST_VAR]\n")
      expect(await run(["up", "--check", "--file", fromProc])).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.OW_REQ_TEST_VAR
      else process.env.OW_REQ_TEST_VAR = saved
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("resolveWorkspaceRoot", () => {
  test("subdir resolves to the enclosing workspace; nearest .ow wins", async () => {
    const root = await tempRoot()
    try {
      const inner = join(root, "sub", "deep")
      await mkdir(join(inner, ".ow"), { recursive: true, mode: 0o700 })
      await mkdir(join(root, ".ow"), { recursive: true, mode: 0o700 })
      expect(await resolveWorkspaceRoot(join(inner, "leaf"))).toBe(inner)
      expect(await resolveWorkspaceRoot(root)).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("symlink- or file-named .ow is skipped, walk continues outward", async () => {
    const root = await tempRoot()
    const target = await tempRoot()
    try {
      await mkdir(join(root, ".ow"), { recursive: true, mode: 0o700 })
      await mkdir(join(root, "sub"), { recursive: true })
      const { symlink } = await import("node:fs/promises")
      await symlink(target, join(root, "sub", ".ow"))
      expect(await resolveWorkspaceRoot(join(root, "sub"))).toBe(root)
      await rm(join(root, "sub", ".ow"), { force: true })
      await writeFile(join(root, "sub", ".ow"), "not a dir")
      expect(await resolveWorkspaceRoot(join(root, "sub"))).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  test("absent-everywhere and deep chains fall back to the start dir", async () => {
    const root = await tempRoot()
    try {
      expect(await resolveWorkspaceRoot(root)).toBe(root)
      let deep = root
      for (let i = 0; i < 40; i += 1) {
        deep = join(deep, `l${i}`)
        await mkdir(deep, { recursive: true })
      }
      expect(await resolveWorkspaceRoot(deep)).toBe(deep)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("subdir reads resolve upward", () => {
  const MINIMAL_YAML = "services:\n  a:\n    cmd: x\n"

  const captureLog = async (fn: () => Promise<number>): Promise<{ code: number; out: string }> => {
    const seen: string[] = []
    const savedLog = console.log
    console.log = (...args: unknown[]): void => {
      seen.push(args.map(String).join(" "))
    }
    try {
      const code = await fn()
      return { code, out: seen.join("\n") }
    } finally {
      console.log = savedLog
    }
  }

  test("explicit --file beats an enclosing .ow", async () => {
    const root = await tempRoot()
    try {
      const sub = join(root, "sub")
      const other = join(root, "other")
      await mkdir(join(root, ".ow"), { recursive: true, mode: 0o700 })
      await mkdir(join(other, ".ow"), { recursive: true, mode: 0o700 })
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, "ow.yaml"), MINIMAL_YAML)
      await writeFile(join(other, "ow.yaml"), MINIMAL_YAML)
      const { out } = await captureLog(() => withCwd(sub, () => run(["where"])))
      expect(out).toContain(root)
      expect(out).not.toContain(other)
      const { out: outOther } = await captureLog(() => withCwd(sub, () => run(["where", "--file", join(other, "ow.yaml")])))
      expect(outOther).toContain(other)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("absent-everywhere names cwd plus directive, exits unchanged", async () => {
    const root = await tempRoot()
    try {
      expect(await resolveWorkspaceRoot(root)).toBe(root)
      const where = await captureLog(() => withCwd(root, () => run(["where"])))
      const ps = await captureLog(() => withCwd(root, () => run(["ps"])))
      expect(where.code).toBe(0)
      expect(ps.code).toBe(0)
      expect(where.out).toContain(root)
      expect(where.out).toContain("(no .ow found)")
      expect(ps.out).toContain(root)
      expect(ps.out).toContain("run from the workspace root")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("up --check and creation stay cwd-anchored, never walk", async () => {
    const root = await tempRoot()
    try {
      const sub = join(root, "sub")
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, "ow.yaml"), "services:\n  a:\n    cmd: x\n")
      await writeFile(join(sub, "ow.yaml"), "services:\n  b:\n    cmd: echo hi\n")
      const bad = join(root, "badsub")
      await mkdir(bad, { recursive: true })
      await writeFile(join(bad, "ow.yaml"), "services:\n  b:\n")
      // --check reads the cwd file: invalid sub file fails even though the parent is valid.
      expect(await withCwd(bad, () => run(["up", "--check"]))).toBe(2)
      expect(await withCwd(sub, () => run(["up"]))).toBe(0)
      expect(existsSync(join(sub, ".ow"))).toBe(true)
      expect(existsSync(join(root, ".ow"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("readBuildSidecar", () => {
  const sidecar = (dir: string): string => join(dir, "ow.build.json")

  test("reads sha/digest/time next to the binary; resolves symlinked dirs", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "ow"), "#!/bin/sh\n")
      await writeFile(sidecar(root), JSON.stringify({ sha: "abc", digest: "d1|d2", time: "2026-10-08T07:00:00Z", extra: 1 }))
      const direct = await readBuildSidecar(join(root, "ow"))
      expect(direct).toEqual({ sha: "abc", digest: "d1|d2", time: "2026-10-08T07:00:00Z" })
      const { symlink } = await import("node:fs/promises")
      await symlink(join(root, "ow"), join(root, "link-ow"))
      expect(await readBuildSidecar(join(root, "link-ow"))).toEqual(direct)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing/corrupt/incomplete sidecar resolves to null, never throws", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "ow"), "#!/bin/sh\n")
      expect(await readBuildSidecar(join(root, "ow"))).toBeNull()
      expect(await readBuildSidecar(join(root, "missing"))).toBeNull()
      await writeFile(sidecar(root), "not-json{{{")
      expect(await readBuildSidecar(join(root, "ow"))).toBeNull()
      await writeFile(sidecar(root), JSON.stringify({ sha: "abc", digest: "", time: "t" }))
      expect(await readBuildSidecar(join(root, "ow"))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("M-h warnWriteFailed bounded once-per-class", () => {
  test("repeats collapse to a single line", async () => {
    const { resetWriteWarns, warnWriteFailed } = await import("./up-state")
    resetWriteWarns()
    const err: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]): void => {
      err.push(args.map(String).join(" "))
    }
    try {
      warnWriteFailed("log", "first failure detail")
      warnWriteFailed("log", "second failure detail")
      warnWriteFailed("log", "third failure detail")
    } finally {
      console.error = orig
      resetWriteWarns()
    }
    expect(err).toEqual(["warning: log write failed (first failure detail)"])
  })
})

describe("G9 empty lock lstart classifies unknown (refuse, never reclaim)", () => {
  test("lock with empty lstart is unknown even when pid is live", async () => {
    const { classifyLock, upPaths } = await import("./up-state")
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { writeFile, rm } = await import("node:fs/promises")
    const root = await mkdtemp(join(tmpdir(), "ow-g9-"))
    try {
      const paths = upPaths(root)
      const { mkdir } = await import("node:fs/promises")
      await mkdir(paths.stateDir, { recursive: true })
      await writeFile(paths.lockFile, JSON.stringify({ pid: process.pid, lstart: "", startedAt: new Date().toISOString() }), "utf8")
      const status = await classifyLock(paths.lockFile)
      expect(status.kind).toBe("unknown")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
