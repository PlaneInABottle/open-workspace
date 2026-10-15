/** `ow init` acceptance: repo detection → starter `ow.yaml`, all against
 * fixture dirs under system temp (removed after). Generated files always
 * re-parse through the real `parseUpFile`; required-env assertions control
 * `process.env` explicitly with save/restore. */

import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseArgs, run } from "./cli"
import { parseUpFile } from "./up-schema"
import { runInit } from "./up-init"


const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-init-"))

const withCwd = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const saved = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(saved)
  }
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

const makeGradle = async (root: string, portLine = "server.port=8081"): Promise<void> => {
  await writeFile(join(root, "build.gradle"), "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n")
  await writeFile(join(root, "gradlew"), "#!/bin/sh\necho gradle-stub\n")
  await chmod(join(root, "gradlew"), 0o755)
  await mkdir(join(root, "src", "main", "resources"), { recursive: true })
  await writeFile(
    join(root, "src", "main", "resources", "application.properties"),
    `${portLine}\ndb.url=jdbc:postgresql://db:5432/app?user=\${DB_USER}&password=\${DB_PASSWORD}\nttl=\${CACHE_TTL:60}\n`,
  )
}

const EXPECTED_GRADLE = `services:
  api:
    cmd: ./gradlew bootRun
    port: 8081
    required-env: [DB_USER, DB_PASSWORD]
`

describe("ow init gradle+spring", () => {
  test("exact yaml, checklist lines, missing-var payoff", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          const result = await runInit({ rootDir: root })
          expect(result.code).toBe(0)
          expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE)
          expect(result.stdout).toContain("2 missing required vars: DB_USER, DB_PASSWORD")
          expect(result.stdout).toContain("DB_USER, DB_PASSWORD")
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("filled required-env reports none missing; no tracing means no trace block or env", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", "u", async () => {
        await withEnv("DB_PASSWORD", "p", async () => {
          const result = await runInit({ rootDir: root })
          expect(result.code).toBe(0)
          const text = await readFile(join(root, "ow.yaml"), "utf8")
          expect(text).not.toContain("trace:")
          expect(text).not.toMatch(/^\s+env: /m)
          expect(text).toContain("required-env: [DB_USER, DB_PASSWORD]")
          expect(result.stdout).toContain("no missing required vars")
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("invalid port is omitted, service still emitted", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root, "server.port=abc")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      expect(text).toContain("cmd: ./gradlew bootRun")
      expect(text).not.toContain("port:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow init maven/python/node", () => {
  test("maven without wrapper falls back to mvn spring-boot:run", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "pom.xml"), "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toContain("cmd: mvn spring-boot:run")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("gradle without spring markers is checklist-only, no invented cmd", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "build.gradle"), "plugins {\n  id 'java'\n}\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("no Spring marker")
      expect(result.stdout).toContain("no empty skeleton written")
      let missing = false
      try {
        await readFile(join(root, "ow.yaml"), "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H3: spring mention in a line comment is checklist-only, no bootRun", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "build.gradle"), "plugins {\n  id 'java'\n}\n// note: spring-boot\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("no Spring marker")
      expect(result.stdout).toContain("no empty skeleton written")
      let missing = false
      try {
        await readFile(join(root, "ow.yaml"), "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H3: spring mention in a block comment is checklist-only, no bootRun", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "build.gradle"), "plugins {\n  id 'java'\n}\n/* roadmap: org.springframework.boot migration */\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("no Spring marker")
      let missing = false
      try {
        await readFile(join(root, "ow.yaml"), "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H3: real quoted marker still emits bootRun beside a spring comment", async () => {
    const root = await tempRoot()
    try {
      await writeFile(
        join(root, "build.gradle"),
        "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n// spring-boot via the plugin above\n",
      )
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toContain("bootRun")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("python-uv distinguishes environ subscripts from getenv", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "pyproject.toml"), '[project]\nname = "svc"\n')
      await writeFile(join(root, "uv.lock"), "# lock\n")
      await writeFile(join(root, "main.py"), "x = 1\n")
      await writeFile(join(root, "mod.py"), 'import os\na = os.environ["DB_PASSWORD"]\nb = os.getenv("OPTIONAL_X")\n')
      await withEnv("DB_PASSWORD", undefined, async () => {
        const plain = await runInit({ rootDir: root })
        expect(plain.code).toBe(0)
        const plainText = await readFile(join(root, "ow.yaml"), "utf8")
        expect(plainText).toContain("cmd: uv run python main.py")
        expect(plainText).toContain("required-env: [DB_PASSWORD]")
        expect(plainText).not.toContain("OPTIONAL_X")
        expect(plainText).not.toContain("trace:")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("node-vite port picked up with plain env", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }))
      await writeFile(join(root, "vite.config.ts"), "export default {\n  server: { port: 5173 },\n}\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      expect(text).toContain("cmd: npm run dev")
      expect(text).toContain("port: 5173")
      expect(text).not.toContain("env:")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H4: unrelated dev script + vite config → no port + checklist note", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "echo hi" } }))
      await writeFile(join(root, "vite.config.ts"), "export default {\n  server: { port: 5173 },\n}\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      expect(text).toContain("cmd: npm run dev")
      expect(text).not.toContain("port:")
      expect(result.stdout).toContain("does not use vite")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("H4: vite start script + vite config → port attached", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "vite preview" } }))
      await writeFile(join(root, "vite.config.ts"), "export default {\n  server: { port: 4173 },\n}\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      expect(text).toContain("cmd: npm run start")
      expect(text).toContain("port: 4173")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow init boundaries", () => {
  test("compose-only writes no file, honest message, exit 0", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "docker-compose.yml"), "services:\n  postgres:\n    image: postgres:16\n")
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("postgres")
      expect(result.stdout).toContain("does not manage")
      expect(result.stdout).toContain("no empty skeleton written")
      let missing = false
      try {
        await readFile(join(root, "ow.yaml"), "utf8")
      } catch {
        missing = true
      }
      expect(missing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("existing ow.yaml refuses naming --force; --force backs up and overwrites", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "build.gradle"), "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n")
      await writeFile(join(root, "ow.yaml"), "services:\n  old:\n    cmd: old-cmd\n")
      const refused = await runInit({ rootDir: root })
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain("--force")
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toContain("old-cmd")
      const forced = await runInit({ rootDir: root, force: true })
      expect(forced.code).toBe(0)
      expect(await readFile(join(root, "ow.yaml.bak"), "utf8")).toContain("old-cmd")
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toContain("gradle bootRun")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("generated files always re-parse clean with matching services", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      const parsed = parseUpFile(text)
      expect(parsed.services.map((s) => s.name)).toEqual(["api"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("L4: validation failure leaves the original file and creates no .bak", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      const original = "services:\n  old:\n    cmd: old-cmd\n"
      await writeFile(join(root, "ow.yaml"), original)
      const result = await runInit({ rootDir: root, force: true }, { renderYaml: () => "services:\n  !!boom\n" })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("invalid skeleton")
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(original)
      let bakMissing = false
      try {
        await readFile(join(root, "ow.yaml.bak"), "utf8")
      } catch {
        bakMissing = true
      }
      expect(bakMissing).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow init cli wiring", () => {
  test("parseArgs accepts flags; help names init; positional is usage error", async () => {
    const parsed = parseArgs(["init", "--force"])
    expect(parsed.error).toBeNull()
    expect(parsed.command).toBe("init")
    const { helpText } = await import("./cli")
    expect(helpText()).toContain("init [--force]")
    expect(await run(["init", "extra"])).toBe(2)
  })

  test("run init end-to-end in an empty fixture via cwd", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          expect(await withCwd(root, () => run(["init"]))).toBe(0)
          expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE)
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--file anchors the target dir, cwd untouched", async () => {
    const root = await tempRoot()
    try {
      const target = join(root, "target")
      await mkdir(target, { recursive: true })
      await makeGradle(target)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          expect(await withCwd(root, () => run(["init", "--file", join(target, "ow.yaml")]))).toBe(0)
          expect(await readFile(join(target, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE)
          let cwdClean = false
          try {
            await readFile(join(root, "ow.yaml"), "utf8")
          } catch {
            cwdClean = true
          }
          expect(cwdClean).toBe(true)
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow init runtime scaffold", () => {
  const EXPECTED_QUESTIONS = [
    "question: is the working directory (cwd) correct for api? If not, fix it in ow.yaml.",
    "question: is port 8081 correct for api? If not, fix it in ow.yaml.",
    "question: are the required variables (DB_USER, DB_PASSWORD) defined in the environment?",
  ]

  // Every printed question must match the bounded <=3-kind catalog.
  const QUESTION_PATTERNS = [
    /^question: is the working directory \(cwd\) correct for \S+\?/,
    /^question: is port \d+ correct for \S+\?/,
    /^question: are the required variables \(.+\) defined in the environment\?$/,
  ]

  const questionKindsOk = (stdout: string): boolean =>
    stdout.split("\n").filter((line) => line.startsWith("question: ")).every((line) =>
      QUESTION_PATTERNS.some((pattern) => pattern.test(line)),
    )

  const listAll = async (root: string): Promise<string[]> => {
    const out: string[] = []
    const stack: string[] = [root]
    let budget = 500
    while (stack.length > 0 && budget > 0) {
      const dir = stack.pop() as string
      budget -= 1
      const { readdir } = await import("node:fs/promises")
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else out.push(full.slice(root.length + 1))
      }
    }
    return out.sort()
  }

  test("Spring dir scaffolds ow.yaml (+ questions)", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          const result = await runInit({ rootDir: root })
          expect(result.code).toBe(0)
          expect(result.stdout).toContain(`wrote: ${join(root, "ow.yaml")}`)
          for (const question of EXPECTED_QUESTIONS) expect(result.stdout).toContain(question)
          expect(questionKindsOk(result.stdout)).toBe(true)
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("empty dir writes nothing (no .ow), honest message", async () => {
    const root = await tempRoot()
    try {
      const before = await listAll(root)
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe("nothing recognized, no empty skeleton written")
      expect(await listAll(root)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rerun without --force exits 2 leaving the file byte-identical", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      expect((await runInit({ rootDir: root })).code).toBe(0)
      const yamlBefore = await readFile(join(root, "ow.yaml"), "utf8")
      const filesBefore = await listAll(root)
      const refused = await runInit({ rootDir: root })
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain("--force")
      expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(yamlBefore)
      expect(await listAll(root)).toEqual(filesBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("--force twice keeps exactly one .bak (overwritten)", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      expect((await runInit({ rootDir: root })).code).toBe(0)
      expect((await runInit({ rootDir: root, force: true })).code).toBe(0)
      expect((await runInit({ rootDir: root, force: true })).code).toBe(0)
      const files = await listAll(root)
      expect(files.filter((name) => name === "ow.yaml.bak")).toHaveLength(1)
      expect(files.some((name) => name.endsWith(".bak.bak"))).toBe(false)
      expect(await readFile(join(root, "ow.yaml.bak"), "utf8")).toBe(await readFile(join(root, "ow.yaml"), "utf8"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("never-activate: package.json byte-identical, file set bounded", async () => {
    const root = await tempRoot()
    try {
      const pkg = JSON.stringify({ scripts: { dev: "echo hi" } })
      await writeFile(join(root, "package.json"), pkg)
      const before = await listAll(root)
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(await readFile(join(root, "package.json"), "utf8")).toBe(pkg)
      const added = (await listAll(root)).filter((name) => !before.includes(name))
      expect(added.sort()).toEqual(["ow.yaml"])
      expect(questionKindsOk(result.stdout)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
