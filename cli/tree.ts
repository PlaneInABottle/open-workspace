import { childSessions, formatGrouped, groupByTask, joinSession, type EnrichedRecord } from "./join"

type Dict = Record<string, unknown>

/** One subagent spawn edge parsed from a parent tool-call row. */
export type SpawnLink = {
  childSessionID: string
  agent: string | null
  description: string | null
  time: number
}

/** A session node in the task tree. link is null for the root and for orphans. */
export type TreeNode = {
  sessionID: string
  link: SpawnLink | null
  children: TreeNode[]
}

const asDict = (value: unknown): Dict | undefined =>
  typeof value === "object" && value !== null ? (value as Dict) : undefined

const timeOf = (record: EnrichedRecord): number => {
  const parsed = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "")
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Spawn links live in parent-session tool-call rows: tool=subagent with an
 * args JSON of {agent, sessionID, description}. Sorted chronologically so
 * child sections nest under their spawn point in run order.
 *
 * Args are clipped to 500 chars at capture, so full JSON.parse often fails
 * on live rows — fall back to field regexes over the clipped text.
 */
export const parseSpawnLinks = (records: EnrichedRecord[]): SpawnLink[] => {
  const out: SpawnLink[] = []
  const strField = (text: string, name: string): string | null => {
    const m = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]{1,200})`))
    return m ? m[1] : null
  }
  for (const record of records) {
    if (record.kind !== "tool-call" || record.tool !== "subagent") continue
    if (typeof record.args !== "string") continue
    let childSessionID: string | null = null
    let agent: string | null = null
    let description: string | null = null
    try {
      const dict = asDict(JSON.parse(record.args))
      if (dict && typeof dict.sessionID === "string") {
        childSessionID = dict.sessionID
        agent = typeof dict.agent === "string" ? dict.agent : null
        description = typeof dict.description === "string" ? dict.description : null
      }
    } catch {
      // clipped args: recover fields by regex below
    }
    if (!childSessionID) {
      childSessionID = strField(record.args, "sessionID")
      agent = strField(record.args, "agent")
      description = strField(record.args, "description")
    }
    if (!childSessionID) continue
    out.push({ childSessionID, agent, description, time: timeOf(record) })
  }
  return out.sort((a, b) => a.time - b.time)
}

const earliest = (records: EnrichedRecord[] | undefined): number => {
  if (!records || records.length === 0) return Number.MAX_SAFE_INTEGER
  let best = Number.MAX_SAFE_INTEGER
  for (const record of records) {
    const t = timeOf(record)
    if (t < best) best = t
  }
  return best
}

/**
 * Build the task tree for a parent session. Children attach via spawn links
 * parsed from each node's own records (so grandchildren nest under the child
 * that spawned them). Descendants with no spawn link anywhere are still shown
 * as unlinked children of the root, ordered by earliest record.
 */
export const buildTree = (parentID: string, recordsBy: Map<string, EnrichedRecord[]>): TreeNode => {
  const known = new Set(recordsBy.keys())
  known.add(parentID)
  const visited = new Set<string>([parentID])
  const childrenOf = (id: string): TreeNode[] => {
    const out: TreeNode[] = []
    const seen = new Set<string>()
    for (const link of parseSpawnLinks(recordsBy.get(id) ?? [])) {
      if (!known.has(link.childSessionID)) continue
      if (visited.has(link.childSessionID) || seen.has(link.childSessionID)) continue
      seen.add(link.childSessionID)
      visited.add(link.childSessionID)
      out.push({ sessionID: link.childSessionID, link, children: childrenOf(link.childSessionID) })
    }
    return out
  }
  const root: TreeNode = { sessionID: parentID, link: null, children: childrenOf(parentID) }
  const orphans = [...known].filter((id) => !visited.has(id))
  orphans.sort((a, b) => earliest(recordsBy.get(a)) - earliest(recordsBy.get(b)))
  for (const id of orphans) {
    visited.add(id)
    root.children.push({ sessionID: id, link: null, children: childrenOf(id) })
  }
  return root
}

/** ID-only view of the tree for --json output (stable English keys). */
export const treeIds = (node: TreeNode): { sessionID: string; children: ReturnType<typeof treeIds> } => ({
  sessionID: node.sessionID,
  children: node.children.map(treeIds),
})

/**
 * Load every session in a task tree: the parent, childSessions() (DB
 * parent_id walk, capped) union spawn-linked IDs parsed from fetched records
 * (the DB walk cap can drop linked sessions, so linked IDs are added back,
 * with one expansion round for grandchild links). Still bounded.
 */
export const loadTreeRecords = async (options: {
  dbPath?: string
  logPath?: string
  sessionID: string
  maxSessions?: number
  sinceMs?: number | null
  now?: number
}): Promise<{ by: Map<string, EnrichedRecord[]>; warnings: string[]; childCount: number }> => {
  const max = options.maxSessions ?? 40
  const by = new Map<string, EnrichedRecord[]>()
  const warnings: string[] = []
  const fetch = async (id: string): Promise<void> => {
    if (by.has(id)) return
    const r = await joinSession({ sessionID: id, dbPath: options.dbPath, logPath: options.logPath, sinceMs: options.sinceMs ?? null, now: options.now })
    by.set(id, r.records)
    warnings.push(...r.warnings)
  }
  await fetch(options.sessionID)
  const dbChildren = await childSessions({ dbPath: options.dbPath, sessionID: options.sessionID })
  const linked = (records: EnrichedRecord[]): string[] =>
    parseSpawnLinks(records).map((l) => l.childSessionID).filter((id) => id !== options.sessionID)
  const firstRound = [...dbChildren, ...linked(by.get(options.sessionID) ?? [])]
  for (const id of firstRound.slice(0, max - 1)) await fetch(id)
  // one expansion round: grandchild links missing from the capped DB walk
  const extra: string[] = []
  for (const recs of by.values()) {
    for (const id of linked(recs)) {
      if (!by.has(id) && !extra.includes(id)) extra.push(id)
    }
  }
  for (const id of extra.slice(0, Math.max(0, max - by.size))) await fetch(id)
  return { by, warnings, childCount: by.size - 1 }
}

/**
 * Hierarchical display: each section reuses groupByTask/formatGrouped with
 * session short-id tags, indented 2 spaces per depth. Subtrees deeper than
 * depth 2 collapse to a single `...` line.
 */
export const formatTree = (
  root: TreeNode,
  recordsBy: Map<string, EnrichedRecord[]>,
  options: { full?: boolean; sectionBudget?: number } = {},
): string => {
  const lines: string[] = []
  const render = (node: TreeNode, depth: number): void => {
    const pad = "  ".repeat(depth)
    const short = node.sessionID.slice(0, 13)
    if (depth === 0) {
      lines.push(`${pad}session ${short}`)
    } else {
      const who = node.link?.agent ? ` [${node.link.agent}]` : ""
      const what = node.link?.description ? ` ${node.link.description.slice(0, 80)}` : ""
      const orphan = node.link ? "" : " (unlinked)"
      lines.push(`${pad}↳ child${who}${what} — ${short}${orphan}`)
    }
    const records = recordsBy.get(node.sessionID) ?? []
    if (records.length === 0) {
      lines.push(`${pad}  (no records)`)
    } else {
      const text = formatGrouped(groupByTask(records), options.full ?? false, true, options.sectionBudget)
      for (const line of text.split("\n")) lines.push(`${pad}${line}`)
    }
    if (depth >= 2) {
      if (node.children.length > 0) lines.push(`${pad}  ...`)
      return
    }
    for (const child of node.children) render(child, depth + 1)
  }
  render(root, 0)
  return lines.join("\n")
}
