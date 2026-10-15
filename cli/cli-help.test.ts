/** Ergonomics verbs: `--version`/`version` and per-verb `--help` (+ the
 * `help` alias). Observer-only: the retired supervision verbs refuse
 * (exit 2). All read-only, non-interactive. */

import { describe, expect, test } from "bun:test"

import { COMMANDS, helpText, run, VERB_HELP, verbHelpText } from "./cli"

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
      code = await run(["show", "--help"])
    } finally {
      io.restore()
    }
    const text = io.out.join("\n")
    expect(code).toBe(0)
    expect(text).toContain("usage: ow show ")
    expect(text).toContain("--tree")
    expect(text).toContain("run `ow --help` for the full command list")
    expect(text.includes("  doctor                        health")).toBe(false)
  })

  test("removed verbs are unknown (exit 2 without --help); verb help still scopes", async () => {
    for (const argv of [
      ["checkpoints"], ["scenarios", "--check"], ["record", "x"], ["contract", "check"], ["scenario", "run", "x"], ["failures"], ["preflight"], ["readiness"], ["provision", "--check"],
      ["up"], ["up", "--check"], ["restart", "api"], ["down"], ["reconcile", "--check"], ["ps"], ["ps", "--explain"], ["logs"], ["init"], ["render"], ["where"],
    ]) {
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
      subCode = await run(["sessions", "--help"])
    } finally {
      sub.restore()
    }
    expect(subCode).toBe(0)
    expect(sub.out.join("\n")).toContain("usage: ow sessions")

    const alias = capture()
    let aliasCode = -1
    try {
      aliasCode = await run(["help", "show"])
    } finally {
      alias.restore()
    }
    expect(aliasCode).toBe(0)
    expect(alias.out.join("\n")).toContain("usage: ow show ")
  })

  test("retired supervision flags are unknown options (exit 2, never silent)", async () => {
    for (const argv of [
      ["sessions", "--file", "ow.yaml"], ["show", "ses_x", "--tail", "10"], ["doctor", "--check"],
      ["sessions", "--wait", "10s"], ["show", "ses_x", "--probe"], ["reads", "ses_x", "--force"],
      ["version", "--rm"], ["doctor", "--only", "api"], ["sessions", "--out", "x.yaml"],
    ]) {
      const io = capture()
      let code = -1
      try {
        code = await run(argv)
      } finally {
        io.restore()
      }
      expect(`${argv.join(" ")} → ${code}`).toBe(`${argv.join(" ")} → 2`)
    }
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
      code = await run(["version", "--db", "x.db"])
    } finally {
      io.restore()
    }
    expect(code).toBe(2)
    expect(io.err.join("\n")).toContain("--db cannot be used with version")
  })
})
