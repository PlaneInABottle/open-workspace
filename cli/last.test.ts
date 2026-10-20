import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./cli"
import { atCommandPosition, findLast, maskCommand } from "./last"

type Row = { t: string; command: string; workdir?: string; exitCode?: number | null }
const log = (rows: Row[]): string =>
  rows
    .map((r) =>
      JSON.stringify({ timestamp: r.t, sessionID: "ses_x", command: r.command, workdir: r.workdir ?? "/w", exitCode: r.exitCode === undefined ? 0 : r.exitCode }),
    )
    .join("\n")

const rows: Row[] = [
  { t: "2026-10-01T10:00:00Z", command: "mvn -q package" },
  { t: "2026-10-02T10:00:00Z", command: "MVN -q package -s s.xml", workdir: "/w/a" },
  { t: "2026-10-03T10:00:00Z", command: "mvn -q package", exitCode: 1 },
  { t: "2026-10-04T10:00:00Z", command: "mvn -q package" },
  { t: "2026-10-05T10:00:00Z", command: "mvn -q package", workdir: "/w/b", exitCode: null },
  { t: "2026-10-06T10:00:00Z", command: "ls" },
]

describe("findLast", () => {
  test("newest successful match first, case-insensitive, exit 0 only", () => {
    const out = findLast(log(rows), { pattern: "mvn", count: 5 })
    expect(out.map((m) => [m.timestamp, m.workdir])).toEqual([
      ["2026-10-04T10:00:00Z", "/w"],
      ["2026-10-02T10:00:00Z", "/w/a"],
    ])
  })

  test("-n dedupes identical command+cwd and keeps the newest of each", () => {
    expect(findLast(log(rows), { pattern: "mvn", count: 1 })).toHaveLength(1)
    const out = findLast(log(rows), { pattern: "package", count: 5 })
    expect(out.map((m) => m.timestamp)).toEqual(["2026-10-04T10:00:00Z", "2026-10-02T10:00:00Z"])
  })

  test("--failed returns the newest non-zero exit with its code", () => {
    const out = findLast(log(rows), { pattern: "mvn", count: 1, failed: true })
    expect(out).toHaveLength(1)
    expect(out[0].exitCode).toBe(1)
  })

  test("--dir and --since narrow the scope", () => {
    expect(findLast(log(rows), { pattern: "mvn", count: 5, dir: "/w/a" })).toHaveLength(1)
    const now = Date.parse("2026-10-06T12:00:00Z")
    expect(findLast(log(rows), { pattern: "mvn", count: 5, sinceMs: 3 * 86_400_000, now })).toHaveLength(1)
  })

  test("malformed lines are skipped", () => {
    expect(findLast(`not json\n${log(rows)}`, { pattern: "ls", count: 1 })).toHaveLength(1)
  })
})

describe("secret masking", () => {
  const hostile = [
    'GH_PACKAGES_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 mvn package',
    'export DB_PASSWORD="hunter2 with space" && run',
    "API_KEY='s3cr3t-value' run",
    "MY_SECRET=plainvalue123 run",
  ]
  test("credential assignments keep the name and drop the value", () => {
    expect(maskCommand(hostile[0])).toBe("GH_PACKAGES_TOKEN=*** mvn package")
    expect(maskCommand(hostile[1])).toBe("export DB_PASSWORD=*** && run")
    expect(maskCommand(hostile[2])).toBe("API_KEY=*** run")
    expect(maskCommand(hostile[3])).toBe("MY_SECRET=*** run")
  })

  test("value references stay re-runnable", () => {
    const cmd = 'GH_PACKAGES_USERNAME="$login" GH_PACKAGES_TOKEN="$(gh auth token)" mvn -B package'
    expect(maskCommand(cmd)).toBe(cmd)
  })

  test("non-secret commands are untouched", () => {
    const cmd = "JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn -s /w/settings.xml package"
    expect(maskCommand(cmd)).toBe(cmd)
  })

  test("real binary path: ow last never prints the raw value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "last-test-"))
    const path = join(dir, "log.jsonl")
    await writeFile(path, log(hostile.map((command, i) => ({ t: `2026-10-0${i + 1}T10:00:00Z`, command }))))
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => void lines.push(a.join(" "))
    try {
      expect(await run(["last", "run", "-n", "5", "--log", path])).toBe(0)
    } finally {
      console.log = orig
    }
    const text = lines.join("\n")
    for (const leak of ["hunter2", "s3cr3t", "plainvalue123"]) expect(text).not.toContain(leak)
    expect(text).toContain("DB_PASSWORD=***")
  })
})

describe("ow last CLI", () => {
  test("no match exits 1 with a clear message; missing pattern and bad -n exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "last-test-"))
    const path = join(dir, "log.jsonl")
    await writeFile(path, log(rows))
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void errs.push(a.join(" "))
    try {
      expect(await run(["last", "nope-nothing", "--log", path])).toBe(1)
      expect(await run(["last", "--log", path])).toBe(2)
      expect(await run(["last", "ls", "-n", "0", "--log", path])).toBe(2)
      expect(await run(["last", "ls", "--json", "--log", path])).toBe(2)
    } finally {
      console.error = orig
    }
    expect(errs.join("\n")).toContain('no successful command matching "nope-nothing"')
  })
})

describe("command-position preference", () => {
  const MVN = 'cd /w; export JAVA_HOME=/opt/openjdk@21; for r in a b; do (cd $r && GH_PACKAGES_USERNAME="$login" GH_PACKAGES_TOKEN="$(gh auth token)" timeout 420 mvn -B -q package -s /w/docker/maven-settings.xml); done'
  const heredoc = "cd /w && python3 - <<'E'\ns='run mvn then docker compose up'\nE\ncat > SKILL.md <<'E'\nuse `mvn` and docker compose here\nE"
  const ownRun = "cd /x; for p in pytest mvn 'docker compose'; do ow last \"$p\"; done"
  const fixture = log([
    { t: "2026-10-01T10:00:00Z", command: MVN },
    { t: "2026-10-01T11:00:00Z", command: "docker compose --env-file .env -p t up -d --wait" },
    { t: "2026-10-02T10:00:00Z", command: heredoc },
    { t: "2026-10-02T11:00:00Z", command: ownRun },
    { t: "2026-10-02T12:00:00Z", command: "ow last mvn" },
    { t: "2026-10-02T13:00:00Z", command: "/Users/me/ow/cli/ow last 'docker compose'" },
  ])

  test("mvn: the real invocation (env prefix + timeout wrapper) beats newer heredoc and ow runs", () => {
    const out = findLast(fixture, { pattern: "mvn", count: 5 })
    expect(out).toHaveLength(1)
    expect(out[0].command).toContain("timeout 420 mvn")
    expect(out[0].command).toContain("GH_PACKAGES_TOKEN=\"$(gh auth token)\"")
  })

  test("docker compose: the real invocation beats newer text that only mentions it", () => {
    const out = findLast(fixture, { pattern: "docker compose", count: 5 })
    expect(out.map((m) => m.command)).toEqual(["docker compose --env-file .env -p t up -d --wait"])
  })

  test("ow's own invocations never match, even as the only hit", () => {
    expect(findLast(log([{ t: "2026-10-02T12:00:00Z", command: "ow last mvn" }]), { pattern: "mvn", count: 1 })).toHaveLength(0)
    expect(findLast(log([{ t: "2026-10-02T12:00:00Z", command: ownRun }]), { pattern: "mvn", count: 1 })).toHaveLength(0)
  })

  test("falls back to substring matches (outside heredoc bodies) only when no command-position match exists", () => {
    const mention = log([{ t: "2026-10-02T10:00:00Z", command: "echo 'run mvn first'" }])
    expect(findLast(mention, { pattern: "mvn", count: 1 })).toHaveLength(1)
    expect(findLast(log([{ t: "2026-10-02T10:00:00Z", command: heredoc }]), { pattern: "mvn", count: 1 })).toHaveLength(0)
  })

  test("a path prefix and a later pipeline stage count as command position", () => {
    const f = log([{ t: "2026-10-03T10:00:00Z", command: "cd /w && .venv/bin/pytest -q | tail -2" }])
    expect(findLast(f, { pattern: "pytest", count: 1 })).toHaveLength(1)
    expect(atCommandPosition("echo x | docker compose ps", "docker compose")).toBe(true)
    expect(atCommandPosition("echo 'mvn'", "mvn")).toBe(false)
  })
})

describe("heredoc bodies are not invocations (real failing shapes)", () => {
  const composeDoc = "cd /w/.agents/skills/rt && python3 - <<'E'\nopen('x','w').write('')\nE\ncat > SKILL.md <<'E'\n```sh\ndocker compose \"$@\" ps ; docker compose \"$@\" logs -f <service>\ndocker compose \"$@\" up -d --wait\n```\nE\nwc -l SKILL.md"
  const pytestDoc = "cd /w/.agents/skills; python3 - <<'E'\np='a'\nE\ncat > t/SKILL.md <<'E'\nuv run pytest <path> -q\nE\n"
  const fixture = log([
    { t: "2026-10-01T10:00:00Z", command: "docker compose --env-file .env -p t up -d --wait" },
    { t: "2026-10-01T11:00:00Z", command: ".venv/bin/python3 -m pytest bin/e2e/tests -q" },
    { t: "2026-10-01T11:30:00Z", command: "cd /w && uv run pytest src/tests -q" },
    { t: "2026-10-02T10:00:00Z", command: composeDoc },
    { t: "2026-10-02T11:00:00Z", command: pytestDoc },
  ])

  test("docker compose: newer heredoc with compose code-block lines loses to the real run", () => {
    const out = findLast(fixture, { pattern: "docker compose", count: 5 })
    expect(out.map((m) => m.command)).toEqual(["docker compose --env-file .env -p t up -d --wait"])
  })

  test("pytest: newer heredoc is dropped even from the substring fallback", () => {
    const out = findLast(fixture, { pattern: "pytest", count: 5 })
    expect(out.map((m) => m.command)).toEqual(["cd /w && uv run pytest src/tests -q", ".venv/bin/python3 -m pytest bin/e2e/tests -q"])
  })

  test("a command before the heredoc opener still counts", () => {
    expect(atCommandPosition("cd /w; mvn -q package <<'E'\nignored\nE", "mvn")).toBe(true)
    expect(atCommandPosition("cat <<'E'\nmvn -q\nE", "mvn")).toBe(false)
  })
})
