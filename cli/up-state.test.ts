/** `ensureOwGitignore` unit coverage + `ow up` integration: the tooling
 * `.ow/` dir must never be committed, so `up` keeps a repo-root `.gitignore`
 * entry (create-or-append, warn-only, byte-identical when present). */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { ensureOwGitignore } from "./up-state"
import { runSuperviseFile } from "./up-supervisor-cli"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-up-state-"))

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
