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

const EXPECTED_GRADLE_TRACING = `trace:
  port: 4319
services:
  api:
    cmd: ./gradlew bootRun
    port: 8081
    env: {JAVA_TOOL_OPTIONS: "-javaagent:.ow/otel/opentelemetry-javaagent.jar", OTEL_SERVICE_NAME: api, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319", OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf, OTEL_METRICS_EXPORTER: none, OTEL_LOGS_EXPORTER: none}
    required-env: [DB_USER, DB_PASSWORD]
`

describe("ow init gradle+spring", () => {
  test("exact yaml, checklist lines, missing-var payoff", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          const result = await runInit({ rootDir: root, tracing: true })
          expect(result.code).toBe(0)
          expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE_TRACING)
          expect(result.stdout).toContain("2 eksik gerekli değişken: DB_USER, DB_PASSWORD")
          expect(result.stdout).toContain("opentelemetry-javaagent.jar")
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
          expect(result.stdout).toContain("eksik gerekli değişken yok")
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
      expect(result.stdout).toContain("Spring işareti yok")
      expect(result.stdout).toContain("boş iskelet yazılmadı")
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

  test("python-uv distinguishes environ subscripts from getenv; traced cmd prefixed", async () => {
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
        await rm(join(root, "ow.yaml"), { force: true })
        const traced = await runInit({ rootDir: root, tracing: true, force: true })
        expect(traced.code).toBe(0)
        const tracedText = await readFile(join(root, "ow.yaml"), "utf8")
        expect(tracedText).toContain("cmd: uv run opentelemetry-instrument python main.py")
        expect(tracedText).toContain('env: {OTEL_SERVICE_NAME: worker, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319"')
        expect(traced.code).toBe(0)
        expect(() => parseUpFile(tracedText)).not.toThrow()
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("node-vite port picked up; no OTel env even with --tracing, frontend note printed", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }))
      await writeFile(join(root, "vite.config.ts"), "export default {\n  server: { port: 5173 },\n}\n")
      const result = await runInit({ rootDir: root, tracing: true })
      expect(result.code).toBe(0)
      const text = await readFile(join(root, "ow.yaml"), "utf8")
      expect(text).toContain("cmd: npm run dev")
      expect(text).toContain("port: 5173")
      expect(text).not.toContain("env:")
      expect(result.stdout).toContain("tracing.ts")
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
      expect(result.stdout).toContain("ow yönetmez")
      expect(result.stdout).toContain("boş iskelet yazılmadı")
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

  test("empty dir writes nothing, honest message, exit 0", async () => {
    const root = await tempRoot()
    try {
      const result = await runInit({ rootDir: root })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe("hiçbir şey tanınmadı, boş iskelet yazılmadı")
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

  test("generated files always re-parse clean with matching services", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      for (const tracing of [false, true]) {
        const forced = tracing ? { force: true } : {}
        const result = await runInit({ rootDir: root, tracing, ...forced })
        expect(result.code).toBe(0)
        const text = await readFile(join(root, "ow.yaml"), "utf8")
        const parsed = parseUpFile(text)
        expect(parsed.services.map((s) => s.name)).toEqual(["api"])
        expect("trace" in parsed).toBe(tracing)
        if (tracing) expect(text).toMatch(/env: \{[^}]*\}/)
        await rm(join(root, "ow.yaml"), { force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ow init cli wiring", () => {
  test("parseArgs accepts flags; help names init; positional is usage error", async () => {
    const parsed = parseArgs(["init", "--force", "--tracing"])
    expect(parsed.error).toBeNull()
    expect(parsed.command).toBe("init")
    const { helpText } = await import("./cli")
    expect(helpText()).toContain("init [--force] [--tracing]")
    expect(await run(["init", "extra"])).toBe(2)
  })

  test("run init --tracing end-to-end in an empty fixture via cwd", async () => {
    const root = await tempRoot()
    try {
      await makeGradle(root)
      await withEnv("DB_USER", undefined, async () => {
        await withEnv("DB_PASSWORD", undefined, async () => {
          expect(await withCwd(root, () => run(["init", "--tracing"]))).toBe(0)
          expect(await readFile(join(root, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE_TRACING)
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
          expect(await withCwd(root, () => run(["init", "--tracing", "--file", join(target, "ow.yaml")]))).toBe(0)
          expect(await readFile(join(target, "ow.yaml"), "utf8")).toBe(EXPECTED_GRADLE_TRACING)
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
