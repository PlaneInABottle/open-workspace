/** M2 provenance kaydı: saf çıkarım + maske + best-effort exec (enjekte).
 * Secret değer ve tam komut-satırı state'e girmez; env İÇERİĞİ asla. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  argvShapeOf,
  envFilesOf,
  gitCheckout,
  inferInterpreter,
  javaInfoOf,
  procCwdOf,
  recordProvenance,
  type ExecFn,
} from "./up-provenance"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-m2prov-"))

describe("argvShapeOf (maskeli-şekil, ham argv yok)", () => {
  test("string + argv listesi maskelenir, şekil korunur", () => {
    expect(argvShapeOf("deploy --token hunter2 --verbose")).toEqual(["deploy", "--token", "***", "--verbose"])
    expect(argvShapeOf(["./app", "--api-key", "hunter2"])).toEqual(["./app", "***", "***"])
    expect(argvShapeOf("sleep 30")).toEqual(["sleep", "30"])
    expect(argvShapeOf(undefined)).toBeUndefined()
  })

  test("sentinel şekilli yollarda görünmez", () => {
    for (const shape of [
      argvShapeOf("run --password hunter2")!,
      argvShapeOf(["./x", "TOKEN=hunter2"])!,
    ]) {
      expect(shape.join(" ")).not.toContain("hunter2")
    }
  })
})

describe("inferInterpreter (eşleşme = inferred, sürüm exec yok)", () => {
  test("bilinen interpreter'lar", () => {
    expect(inferInterpreter(["python3", "-m", "app"])).toMatchObject({ name: "python3", source: "inferred" })
    expect(inferInterpreter(["uv", "run", "x"])).toMatchObject({ name: "uv", source: "inferred" })
    expect(inferInterpreter("bun run dev")).toMatchObject({ name: "bun", source: "inferred" })
    expect(inferInterpreter(["node", "server.js"])).toMatchObject({ name: "node", source: "inferred" })
    expect(inferInterpreter(["java", "-jar", "a.jar"])).toMatchObject({ name: "java", source: "inferred" })
    expect(inferInterpreter(["./gradlew", "bootRun"])).toMatchObject({ name: "gradlew", source: "inferred" })
  })

  test("eşleşme yoksa alan atlanır (sh dahil)", () => {
    expect(inferInterpreter("sleep 30")).toBeUndefined()
    expect(inferInterpreter("sh -c 'echo hi'")).toBeUndefined()
    expect(inferInterpreter(undefined)).toBeUndefined()
  })
})

describe("javaInfoOf (sayı/ad, inferred)", () => {
  test("-cp girdileri + -jar adı", () => {
    const interp = { name: "java", source: "inferred" as const }
    expect(javaInfoOf(["java", "-cp", "a.jar:lib/b.jar:classes", "Main"], interp)).toEqual({
      classpathCount: 3,
      jarNames: ["a.jar", "b.jar"],
      source: "inferred",
    })
    expect(javaInfoOf(["java", "-jar", "app.jar"], interp)).toMatchObject({ classpathCount: 1, jarNames: ["app.jar"] })
  })

  test("java değilse ya da kanıt yoksa atlanır", () => {
    expect(javaInfoOf(["node", "x.js"], { name: "node", source: "inferred" })).toBeUndefined()
    expect(javaInfoOf(["java", "Main"], { name: "java", source: "inferred" })).toBeUndefined()
    expect(javaInfoOf(undefined, undefined)).toBeUndefined()
  })
})

describe("gitCheckout + procCwdOf (enjekte exec, best-effort)", () => {
  const fakeGit = (rev: string | null, dirty: string): ExecFn => async (argv) => {
    if (argv.includes("rev-parse")) return rev
    if (argv.includes("status")) return dirty
    return null
  }

  test("rev + dirty bayrağı", async () => {
    expect(await gitCheckout("/r", fakeGit("abc123", ""))).toEqual({ rev: "abc123", dirty: false })
    expect(await gitCheckout("/r", fakeGit("abc123", " M x\n"))).toEqual({ rev: "abc123", dirty: true })
  })

  test("repo-değil/timeout/throw → null (asla throw yok)", async () => {
    expect(await gitCheckout("/r", fakeGit(null, ""))).toBeNull()
    expect(await gitCheckout("/r", fakeGit("!!!", ""))).toBeNull()
    expect(await gitCheckout("/r", async () => null)).toBeNull()
    expect(await gitCheckout("/r", async () => {
      throw new Error("patlak")
    })).toBeNull()
  })

  test("procCwd -Fn parse + yabancı çıktı null + AND bayrağı", async () => {
    const seen: string[][] = []
    const lsof: ExecFn = async (argv) => {
      seen.push(argv)
      return "p123\nfcwd\nn/repo/svc\nf0\nn/dev/null\n"
    }
    expect(await procCwdOf(123, lsof)).toBe("/repo/svc")
    // `-a` yoksa -p/-d OR birleşir (canlı kanıt: ilk sürecin cwd'si
    // dönerdi) — bayrak sözleşmesi testle pinli.
    expect(seen[0]).toContain("-a")
    expect(await procCwdOf(123, async () => "garbage")).toBeNull()
    expect(await procCwdOf(123, async () => null)).toBeNull()
  })
})

describe("recordProvenance (bütün + sentinel)", () => {
  test("git + envFiles + interpreter + recordedAt; .env İÇERİĞİ girmez", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, ".env"), "TOKEN=hunter2\n", "utf8")
      await writeFile(join(root, ".env.local"), "X=1\n", "utf8")
      const exec: ExecFn = async (argv) => {
        if (argv.includes("rev-parse")) return "abc123def456"
        if (argv.includes("status")) return ""
        return null
      }
      const provenance = await recordProvenance({
        svc: { name: "api", cmd: ["node", "server.js"], env: { TOKEN: "hunter2" } as never },
        cwdAbs: root,
        exec,
        now: () => "2026-10-09T00:00:00.000Z",
      })
      expect(provenance).toMatchObject({
        cwdAbs: root,
        checkout: { rev: "abc123def456", dirty: false, source: "observed" },
        argvShape: ["node", "server.js"],
        interpreter: { name: "node", source: "inferred" },
        envFiles: [".env", ".env.local"],
        recordedAt: "2026-10-09T00:00:00.000Z",
      })
      expect(JSON.stringify(provenance)).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("exec patlarsa kayıt düşer, throw yok", async () => {
    const root = await tempRoot()
    try {
      const provenance = await recordProvenance({
        svc: { name: "a", cmd: "sleep 30" },
        cwdAbs: root,
        exec: async () => {
          throw new Error("patlak")
        },
      })
      expect(provenance.checkout).toBeUndefined()
      expect(provenance.cwdAbs).toBe(root)
      expect(provenance.recordedAt).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lsof çelişirse cwdAbs düşer (UNVERIFIED render tetikler)", async () => {
    const root = await tempRoot()
    try {
      const exec: ExecFn = async (argv) => {
        if (argv[0] === "lsof") return "p1\nfcwd\nn/baska/yer\n"
        return null
      }
      const provenance = await recordProvenance({ svc: { name: "a", cmd: "sleep 1" }, cwdAbs: root, pid: 1, exec })
      expect(provenance.cwdAbs).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("symlink-farklı ama aynı dizin: realpath eşleşir, düşmez (macOS /private)", async () => {
    const root = await tempRoot()
    try {
      const { realpath } = await import("node:fs/promises")
      const real = await realpath(root)
      const exec: ExecFn = async (argv) => {
        if (argv[0] === "lsof") return `p1\nfcwd\nn${real}\n`
        return null
      }
      const provenance = await recordProvenance({ svc: { name: "a", cmd: "sleep 1" }, cwdAbs: root, pid: 1, exec })
      expect(provenance.cwdAbs).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("spawn kaydı: fake git çağrılır, state'e rev işlenir", async () => {
    const root = await tempRoot()
    try {
      const { ensureUpStateDir, readSupervisorState, upPaths } = await import("./up-state")
      const { runSupervised } = await import("./up-supervisor")
      const paths = upPaths(root)
      await ensureUpStateDir(paths.stateDir)
      const calls: string[][] = []
      const exec: ExecFn = async (argv) => {
        calls.push(argv)
        if (argv.includes("rev-parse")) return "deadbeef1234"
        if (argv.includes("status")) return ""
        return null
      }
      const code = await runSupervised([{ name: "a", cmd: "echo hi" }], {
        rootDir: root,
        stateFile: paths.supervisorFile,
        onLine: () => undefined,
        provenanceExec: exec,
      })
      expect(code).toBe(0)
      expect(calls.some((argv) => argv.includes("rev-parse"))).toBe(true)
      const state = await readSupervisorState(paths.supervisorFile)
      expect(state?.services[0]?.provenance).toMatchObject({
        checkout: { rev: "deadbeef1234", dirty: false, source: "observed" },
      })
      expect(state?.services[0]?.provenance?.argvShape).toEqual(["echo", "hi"])
      expect(JSON.stringify(state)).not.toContain("hunter2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("envFilesOf", () => {
  test(".env* adları, içerik yok; yoksa atlanır", async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, ".env"), "S=hunter2", "utf8")
      expect(await envFilesOf(root)).toEqual([".env"])
      expect(await envFilesOf(join(root, "yok"))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
