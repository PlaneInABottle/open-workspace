/** Recorded durations and log coverage: no number is invented when the store lacks it. */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { formatDuration, groupByTask, readLogBounds, timedSummary } from "./join"

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "ow-timings-"))

describe("formatDuration", () => {
  test("scales from milliseconds to minutes without inventing precision", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(125_400)).toBe("2m 05s")
  })
})

describe("recorded durations in the grouped view", () => {
  const record = (command: string, durationMs?: number) => ({
    command,
    outcome: "success",
    intent: null,
    messageID: "m",
    taskRef: "t",
    ...(durationMs === undefined ? {} : { durationMs }),
  })

  test("sums and maxes only the records that carried a duration", () => {
    const groups = groupByTask([record("pnpm test", 1200), record("pnpm test", 800), record("pnpm test")])
    const line = groups[0]!.lines[0]!
    expect(line.timedRuns).toBe(2)
    expect(line.durationTotalMs).toBe(2000)
    expect(line.durationMaxMs).toBe(1200)
    expect(timedSummary(groups)).toBe("time: 2.0s recorded across 2 records (max 1.2s)")
  })

  test("claims nothing when no record was timed", () => {
    const groups = groupByTask([record("pnpm test"), record("pnpm test")])
    expect(timedSummary(groups)).toBeNull()
    expect(groups[0]!.lines[0]!.timedRuns).toBe(0)
  })

  test("keeps zero recorded milliseconds distinct from an absent duration", () => {
    const groups = groupByTask([record("true", 0)])
    const line = groups[0]!.lines[0]!
    expect(line.timedRuns).toBe(1)
    expect(line.durationTotalMs).toBe(0)
  })
})

describe("readLogBounds", () => {
  test("reports the first and last timestamp actually present", async () => {
    const root = await tempRoot()
    try {
      const log = join(root, "shell-events.jsonl")
      const rows = ["2026-11-01T10:00:00.000Z", "2026-11-02T10:00:00.000Z", "2026-11-03T10:00:00.000Z"].map(
        (timestamp, i) => JSON.stringify({ timestamp, sessionID: "ses_x", command: `echo ${i}`, outcome: "success" }),
      )
      await writeFile(log, `${rows.join("\n")}\n`, "utf8")
      const bounds = await readLogBounds(log)
      expect(bounds).not.toBeNull()
      expect(new Date(bounds!.firstMs).toISOString()).toBe("2026-11-01T10:00:00.000Z")
      expect(new Date(bounds!.lastMs).toISOString()).toBe("2026-11-03T10:00:00.000Z")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns null for a missing or empty log instead of guessing", async () => {
    const root = await tempRoot()
    try {
      expect(await readLogBounds(join(root, "absent.jsonl"))).toBeNull()
      const empty = join(root, "empty.jsonl")
      await writeFile(empty, "", "utf8")
      expect(await readLogBounds(empty)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
