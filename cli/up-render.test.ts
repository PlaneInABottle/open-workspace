/** `ow render` acceptance: base → filtered task manifest, all against
 * fixture dirs under system temp (removed after). Rendered files always
 * re-parse through the real `parseUpFile`; env assertions use fixed
 * sentinel values with save/restore. */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { parseUpFile } from "./up-schema"
import { runRender } from "./up-render"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-render-"))

const BASE = `services:
  api:
    cmd: ./gradlew bootRun
    cwd: ./svc-api
    port: 8901
    required-env: [DB_USER]
  web:
    cmd: ["node", "dev.mjs", "--port", "3114"]
    port: 3114
  worker:
    cmd: python worker.py
    logs: docker logs -f worker
`

const SECRET_BASE = `services:
  api:
    cmd: ./run.sh
    port: 8901
    env: {DB_PASSWORD: hunter2-env-secret}
    required-env: [DB_PASSWORD]
`

const writeBase = async (root: string, text: string = BASE): Promise<string> => {
  const file = join(root, "ow.yaml")
  await writeFile(file, text, "utf8")
  return file
}

const withEnv = async <T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

describe("ow render subset + overrides", () => {
  test("subset filter keeps base order; port/cwd overrides apply", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      const result = await runRender({ baseFile: base, only: "worker,api", setPort: "api=9911", setCwd: "api=./task-api", out })
      expect(result.code).toBe(0)
      const text = await readFile(out, "utf8")
      const parsed = parseUpFile(text)
      expect(parsed.services.map((s) => s.name)).toEqual(["api", "worker"])
      expect(parsed.services[0].port).toBe(9911)
      expect(parsed.services[0].cwd).toBe("./task-api")
      expect(parsed.services[0].cmd).toBe("./gradlew bootRun")
      expect(result.stdout).toContain("2 services: api, worker")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cmd list stays a list, cmd string stays a string", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      const result = await runRender({ baseFile: base, out })
      expect(result.code).toBe(0)
      const parsed = parseUpFile(await readFile(out, "utf8"))
      const web = parsed.services.find((s) => s.name === "web")
      expect(web?.cmd).toEqual(["node", "dev.mjs", "--port", "3114"])
      expect(parsed.services.find((s) => s.name === "api")?.cmd).toBe("./gradlew bootRun")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown service in --only exits 2 and writes nothing", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      const result = await runRender({ baseFile: base, only: "nope", out })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("unknown service: nope")
      expect(result.stderr).toContain("api, web, worker")
      let missing = false
      try {
        await readFile(out, "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unknown/malformed --set-port and --set-cwd exit 2", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      expect((await runRender({ baseFile: base, setPort: "ghost=9911", out })).code).toBe(2)
      expect((await runRender({ baseFile: base, setPort: "api", out })).code).toBe(2)
      for (const bad of ["api=0", "api=99999", "api=abc"]) {
        const result = await runRender({ baseFile: base, setPort: bad, out })
        expect(`${bad} → ${result.code}`).toBe(`${bad} → 2`)
        expect(result.stderr).toContain("invalid --set-port")
      }
      expect((await runRender({ baseFile: base, setCwd: "ghost=./x", out })).code).toBe(2)
      expect((await runRender({ baseFile: base, setPort: "worker=9911", only: "api", out })).code).toBe(2)
      let missing = false
      try {
        await readFile(out, "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("existing --out refuses byte-identical without --force; --force keeps one .bak", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      const original = "services:\n  old:\n    cmd: old-cmd\n"
      await writeFile(out, original, "utf8")
      const refused = await runRender({ baseFile: base, only: "api", out })
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain("--force")
      expect(await readFile(out, "utf8")).toBe(original)
      const forced = await runRender({ baseFile: base, only: "api", setPort: "api=9911", out, force: true })
      expect(forced.code).toBe(0)
      expect(await readFile(`${out}.bak`, "utf8")).toBe(original)
      expect(parseUpFile(await readFile(out, "utf8")).services.map((s) => s.name)).toEqual(["api"])
      const forced2 = await runRender({ baseFile: base, only: "web", out, force: true })
      expect(forced2.code).toBe(0)
      expect(await readFile(out, "utf8")).toContain("web:")
      let doubleBak = false
      try {
        await readFile(`${out}.bak.bak`, "utf8")
      } catch {
        doubleBak = true
      }
      expect(doubleBak).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("validation failure leaves the original and creates no .bak", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root, "services:\n  !!boom\n")
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      const original = "services:\n  old:\n    cmd: old-cmd\n"
      await writeFile(out, original, "utf8")
      const result = await runRender({ baseFile: base, out, force: true })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("invalid ow.yaml")
      expect(await readFile(out, "utf8")).toBe(original)
      let bakMissing = false
      try {
        await readFile(`${out}.bak`, "utf8")
      } catch {
        bakMissing = true
      }
      expect(bakMissing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("directory and symlinked targets refuse (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      expect((await runRender({ baseFile: base, out: join(root, "rendered.yaml") })).code).toBe(0)
      // Existing directory as --out.
      const dirResult = await runRender({ baseFile: base, out: root })
      expect(dirResult.code).toBe(2)
      expect(dirResult.stderr).toContain("directory")
      // Symlinked parent is refused.
      const real = join(root, "real")
      await mkdir(real, { recursive: true })
      await symlink(real, join(root, "linked"))
      const linkResult = await runRender({ baseFile: base, out: join(root, "linked", "ow.yaml") })
      expect(linkResult.code).toBe(2)
      expect(linkResult.stderr).toContain("symlinked/unavailable")
      // Missing parent is refused, never created.
      const missingResult = await runRender({ baseFile: base, out: join(root, "absent", "ow.yaml") })
      expect(missingResult.code).toBe(2)
      expect(missingResult.stderr).toContain("parent not found")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing --out and missing base refuse (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      expect((await runRender({ baseFile: base })).code).toBe(2)
      const missing = await runRender({ baseFile: join(root, "nope.yaml"), out: join(root, "o.yaml") })
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain("not found")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow render secrets", () => {
  test("env values never reach the manifest, stdout, or --json; required names still report", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root, SECRET_BASE)
      const out = join(root, "task", "ow.yaml")
      await mkdir(join(root, "task"), { recursive: true })
      await withEnv("DB_PASSWORD", undefined, async () => {
        const result = await runRender({ baseFile: base, out })
        expect(result.code).toBe(0)
        const text = await readFile(out, "utf8")
        expect(text).not.toContain("hunter2-env-secret")
        expect(text).toContain("required-env: [DB_PASSWORD]")
        expect(result.stdout).not.toContain("hunter2-env-secret")
        expect(result.stdout).toContain("1 missing required vars: DB_PASSWORD")
        const jsonOut = join(root, "task2", "ow.yaml")
        await mkdir(join(root, "task2"), { recursive: true })
        const json = await runRender({ baseFile: base, out: jsonOut, json: true })
        expect(json.code).toBe(0)
        const payload = JSON.parse(json.stdout) as { out: string; services: unknown }
        expect(payload.out).toBe(jsonOut)
        expect(json.stdout).not.toContain("hunter2-env-secret")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--json is parse-clean with names+ports only", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root, SECRET_BASE)
      const task = join(root, "task")
      await mkdir(task, { recursive: true })
      await withEnv("DB_PASSWORD", "set", async () => {
        const result = await runRender({ baseFile: base, only: "api", setPort: "api=9911", out: join(task, "ow.yaml"), json: true })
        expect(result.code).toBe(0)
        const payload = JSON.parse(result.stdout) as { out: string; services: unknown[]; warnings: unknown[] }
        expect(payload.out).toBe(join(task, "ow.yaml"))
        expect(payload.services).toEqual([{ name: "api", port: 9911 }])
        expect(result.stdout).not.toContain("hunter2-env-secret")
        expect(Array.isArray(payload.warnings)).toBe(true)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow render cli wiring", () => {
  test("rendered manifest passes the real up --check path", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const task = join(root, "task")
      await mkdir(task, { recursive: true })
      const out = join(task, "ow.yaml")
      const logs: string[] = []
      const errors: string[] = []
      const origLog = console.log
      const origError = console.error
      console.log = (...args: unknown[]): void => {
        logs.push(args.map(String).join(" "))
      }
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(" "))
      }
      let renderCode = -1
      let checkCode = -1
      try {
        await withEnv("DB_USER", "test-user", async () => {
          renderCode = await run(["render", "--file", base, "--only", "api,web", "--set-port", "api=9911", "--out", out])
          checkCode = await run(["up", "--check", "--file", out])
        })
      } finally {
        console.log = origLog
        console.error = origError
      }
      expect(renderCode).toBe(0)
      expect(checkCode).toBe(0)
      expect(logs.join("\n")).toContain("wrote:")
      expect(errors.join("\n")).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("render-only flags refuse on every other verb (exit 2)", async () => {
    const root = await tempRoot()
    try {
      const base = await writeBase(root)
      const origError = console.error
      const origLog = console.log
      console.log = () => undefined
      console.error = () => undefined
      try {
        expect(await run(["up", "--check", "--file", base, "--only", "api"])).toBe(2)
        expect(await run(["ps", "--out", join(root, "o.yaml")])).toBe(2)
        expect(await run(["where", "--set-port", "api=1"])).toBe(2)
        expect(await run(["render", "extra", "--out", join(root, "o.yaml")])).toBe(2)
        expect(await run(["render", "--file", base, "--wait", "10s", "--out", join(root, "o.yaml")])).toBe(2)
      } finally {
        console.log = origLog
        console.error = origError
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
