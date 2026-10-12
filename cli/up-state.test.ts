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
      const warn = await ensureOwGitignore(join(root, "yok"))
      expect(typeof warn).toBe("string")
      expect(warn as string).toContain(".gitignore")
      expect(warn as string).not.toContain("yok")
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

  test("up --check still exits 0 and trace port 4318 exits 2 naming the dashboard port", async () => {
    const root = await tempRoot()
    try {
      const plain = join(root, "plain.yaml")
      await writeFile(plain, "services:\n  a:\n    cmd: x\n")
      expect(await run(["up", "--check", "--file", plain])).toBe(0)
      const reserved = join(root, "reserved.yaml")
      await writeFile(reserved, "trace:\n  port: 4318\nservices:\n  a:\n    cmd: x\n")
      expect(await run(["up", "--check", "--file", reserved])).toBe(2)
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
  const TRACE_YAML = "trace:\n  port: 4319\nservices:\n  a:\n    cmd: x\n"
  const spanRow = (name: string): string =>
    JSON.stringify({ t: "2026-10-08T00:00:00.000Z", traceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", spanId: "1111111111111111", parentSpanId: null, service: "api", name, kind: "server", startNano: "1000000000", endNano: "1012000000", durMs: 12, status: "ok", attrs: {} })

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

  test("trace from a subdirectory lists the enclosing workspace spans", async () => {
    const root = await tempRoot()
    try {
      const sub = join(root, "sub")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      await writeFile(join(root, ".ow", "traces", "spans.jsonl"), `${spanRow("GET /orders")}\n`, { mode: 0o600 })
      const { code, out } = await captureLog(() => withCwd(sub, () => run(["trace", "--min-spans", "1"])))
      expect(code).toBe(0)
      expect(out).toContain("GET /orders")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctor trace line resolves upward to the enclosing ow.yaml", async () => {
    const root = await tempRoot()
    try {
      const sub = join(root, "sub")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      await writeFile(join(root, ".ow", "traces", "spans.jsonl"), `${spanRow("GET /orders")}\n`, { mode: 0o600 })
      const { out } = await captureLog(() => withCwd(sub, () => run(["doctor", "--json"])))
      const checks = (JSON.parse(out) as { checks: { name: string; detail: string }[] }).checks
      const trace = checks.find((line) => line.name === "trace")
      expect(trace?.detail).toContain("open")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("explicit --file beats an enclosing .ow", async () => {
    const root = await tempRoot()
    try {
      const sub = join(root, "sub")
      const other = join(root, "other")
      await mkdir(join(root, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await mkdir(join(other, ".ow", "traces"), { recursive: true, mode: 0o700 })
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, "ow.yaml"), TRACE_YAML)
      await writeFile(join(other, "ow.yaml"), TRACE_YAML)
      await writeFile(join(root, ".ow", "traces", "spans.jsonl"), `${spanRow("GET /from-root")}\n`, { mode: 0o600 })
      await writeFile(join(other, ".ow", "traces", "spans.jsonl"), `${spanRow("GET /from-other")}\n`, { mode: 0o600 })
      const { out } = await captureLog(() => withCwd(sub, () => run(["trace", "--min-spans", "1", "--file", join(other, "ow.yaml")])))
      expect(out).toContain("GET /from-other")
      expect(out).not.toContain("GET /from-root")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("absent-everywhere names cwd plus directive, exits unchanged", async () => {
    const root = await tempRoot()
    try {
      expect(await resolveWorkspaceRoot(root)).toBe(root)
      const trace = await captureLog(() => withCwd(root, () => run(["trace"])))
      const ps = await captureLog(() => withCwd(root, () => run(["ps"])))
      expect(trace.code).toBe(0)
      expect(ps.code).toBe(0)
      for (const out of [trace.out, ps.out]) {
        expect(out).toContain(root)
        expect(out).toContain("run from the workspace root")
      }
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
      expect(await readBuildSidecar(join(root, "yok"))).toBeNull()
      await writeFile(sidecar(root), "not-json{{{")
      expect(await readBuildSidecar(join(root, "ow"))).toBeNull()
      await writeFile(sidecar(root), JSON.stringify({ sha: "abc", digest: "", time: "t" }))
      expect(await readBuildSidecar(join(root, "ow"))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
