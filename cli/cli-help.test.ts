/** Ergonomics verbs: `--version`/`version`, per-verb `--help` (+ the `help`
 * alias) and `where`. All read-only; `where` answers even when files are
 * missing (absence is data, exit stays 0). */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { COMMANDS, helpText, run, VERB_HELP, verbHelpText } from "./cli"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-help-"))

const capture = (): { out: string[]; err: string[]; restore: () => void } => {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]): void => {
    out.push(args.map(String).join(" "))
  }
  console.error = (...args: unknown[]): void => {
    err.push(args.map(String).join(" "))
  }
  return { out, err, restore: () => {
    console.log = origLog
    console.error = origError
  } }
}

describe("per-verb help", () => {
  test("every command has a verb-help entry and a usage line in the global list", () => {
    for (const command of COMMANDS) {
      expect(VERB_HELP[command]).toBeDefined()
      expect(verbHelpText(command)).toContain(`usage: ow ${command}`)
    }
  })

  test("ow <verb> --help renders verb-scoped help, not the global list", async () => {
    const io = capture()
    let code = -1
    try {
      code = await run(["up", "--help"])
    } finally {
      io.restore()
    }
    const text = io.out.join("\n")
    expect(code).toBe(0)
    expect(text).toContain("usage: ow up ")
    expect(text).toContain("--health <name>=<path>")
    expect(text).toContain("run `ow --help` for the full command list")
    expect(text.includes("  doctor                        health")).toBe(false)
  })

  test("removed verbs are unknown (exit 2 without --help); verb help still scopes", async () => {
    for (const argv of [["checkpoints"], ["scenarios", "--check"], ["record", "x"], ["contract", "check"], ["scenario", "run", "x"], ["failures"], ["preflight"], ["readiness"], ["provision", "--check"]]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
    }
    const sub = capture()
    let subCode = -1
    try {
      subCode = await run(["logs", "--help"])
    } finally {
      sub.restore()
    }
    expect(subCode).toBe(0)
    expect(sub.out.join("\n")).toContain("usage: ow logs")

    const alias = capture()
    let aliasCode = -1
    try {
      aliasCode = await run(["help", "up"])
    } finally {
      alias.restore()
    }
    expect(aliasCode).toBe(0)
    expect(alias.out.join("\n")).toContain("usage: ow up ")
  })

  test("ow --help still prints the full command list", async () => {
    const io = capture()
    let code = -1
    try {
      code = await run(["--help"])
    } finally {
      io.restore()
    }
    expect(code).toBe(0)
    expect(io.out.join("\n")).toBe(helpText())
  })
})

describe("version identity", () => {
  test("--version and version agree, exit 0, and json carries the sidecar shape", async () => {
    const flagOut = capture()
    let flagCode = -1
    try {
      flagCode = await run(["--version"])
    } finally {
      flagOut.restore()
    }
    const commandOut = capture()
    let commandCode = -1
    try {
      commandCode = await run(["version"])
    } finally {
      commandOut.restore()
    }
    expect(flagCode).toBe(0)
    expect(commandCode).toBe(0)
    expect(flagOut.out.join("\n")).toBe(commandOut.out.join("\n"))
    expect(flagOut.out.join("\n").startsWith("ow ")).toBe(true)

    const jsonOut = capture()
    let jsonCode = -1
    try {
      jsonCode = await run(["version", "--json"])
    } finally {
      jsonOut.restore()
    }
    expect(jsonCode).toBe(0)
    const payload = JSON.parse(jsonOut.out.join("\n")) as Record<string, unknown>
    expect(typeof payload.sidecar).toBe("boolean")
    expect(Object.keys(payload).sort()).toEqual(["dirty", "sha", "sidecar", "time", "version"])
  })

  test("version refuses unrelated flags (fail-loud, exit 2)", async () => {
    const io = capture()
    let code = -1
    try {
      code = await run(["version", "--file", "ow.yaml"])
    } finally {
      io.restore()
    }
    expect(code).toBe(2)
    expect(io.err.join("\n")).toContain("--file cannot be used with version")
  })
})

describe("where", () => {
  test("explicit --file: root + present/missing files, exit 0", async () => {
    const root = await tempRoot()
    try {
      const file = join(root, "ow.yaml")
      await writeFile(file, "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await mkdir(join(root, ".ow"), { recursive: true })
      const io = capture()
      let code = -1
      try {
        code = await run(["where", "--file", file, "--json"])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const node = JSON.parse(io.out.join("\n")) as Record<string, any>
      expect(node.root).toBe(root)
      expect(node.source).toBe(`--file ${file}`)
      expect(node.owYaml).toEqual({ path: file, present: true })
      expect(node.state.present).toBe(true)
      expect(node.supervisor.present).toBe(false)
      expect(typeof node.observer.log.path).toBe("string")
      expect(typeof node.observer.db.present).toBe("boolean")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("walked root: readers resolve upward from a nested cwd; missing files stay honest", async () => {
    const root = await tempRoot()
    const previous = process.cwd()
    try {
      await writeFile(join(root, "ow.yaml"), "services:\n  a:\n    cmd: echo hi\n", "utf8")
      await mkdir(join(root, ".ow"), { recursive: true })
      const nested = join(root, "src", "deep")
      await mkdir(nested, { recursive: true })
      process.chdir(nested)
      const { realpath } = await import("node:fs/promises")
      const realRoot = await realpath(root)
      const realNested = await realpath(nested)
      const io = capture()
      let code = -1
      try {
        code = await run(["where"])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      const text = io.out.join("\n")
      expect(text).toContain(`root: ${realRoot}`)
      expect(text).toContain(`source: walked up from ${realNested}`)
      expect(text).toContain(`supervisor: ${join(realRoot, ".ow", "supervisor.json")} (missing)`)
    } finally {
      process.chdir(previous)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("where without any state answers honestly (exit 0) and refuses foreign flags", async () => {
    const root = await tempRoot()
    const previous = process.cwd()
    try {
      process.chdir(root)
      const io = capture()
      let code = -1
      try {
        code = await run(["where"])
      } finally {
        io.restore()
      }
      expect(code).toBe(0)
      expect(io.out.join("\n")).toContain("(no .ow found)")
      expect(io.out.join("\n")).toContain("ow.yaml: ")
      expect(io.out.join("\n")).toContain("(missing)")

      const refused = capture()
      let refusedCode = -1
      try {
        refusedCode = await run(["where", "--probe"])
      } finally {
        refused.restore()
      }
      expect(refusedCode).toBe(2)
      expect(refused.err.join("\n")).toContain("--probe cannot be used with where")
    } finally {
      process.chdir(previous)
      await rm(root, { recursive: true, force: true })
    }
  })
})
