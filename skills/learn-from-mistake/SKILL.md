---
name: learn-from-mistake
description: On explicit invocation, turn reusable session lessons into direct skill and AGENTS.md updates. Never runs automatically.
---

# Learn from a mistake

Use only when the user explicitly invokes this skill. It never runs automatically at session end or after a correction. Review available evidence, keep only guidance that would help someone on a different task, and write it directly to the relevant skill and instruction file. This is not an incident log.

## Review evidence

1. Review the visible session transcript for surprises, retries, denials, and user corrections. Never search for or mine transcript files on disk.
2. When available, review relevant `activity_list` entries and `recent_runs` for the affected workspace or workstream. These read-only summaries help identify the triggering operation and outcome; they do not authorize other actions.
3. Calibrate every candidate with: **Would this help someone who never saw this failure, on a different task?** If not, skip it. Record reusable patterns, not one-off flukes or incident narratives.

## Write durable guidance directly

1. Treat the repository/project currently being worked in as the active project; sibling roots are separate. If its root is unclear, ask before editing. Keep all skill and instruction edits inside it. Update its applicable skill, or create `skills/<skill-name>/SKILL.md` using the existing layout and frontmatter conventions. Never edit a shared skill outside the active project without explicit user authorization; if that is the only suitable skill, refuse that edit and report the boundary.
2. Record the durable rule in the nearest existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` inside the active project. If none applies, add a concise section to the project-root `AGENTS.md`. A shared ancestor outside the project requires explicit user authorization; without it, do not edit there and report that the rule could not be recorded.
3. In both destinations, keep each entry short: **rule** and **when it applies**, with a source reference when one exists. Cite evidence by `runId`, activity timestamp, or test name only; do not copy evidence content. If a transcript-only correction has no such reference, skip the citation; never invent one or copy evidence content.
4. Add or change no more than **5 rules per invocation**. Prefer the most reusable patterns; leave one-off or lower-value observations out.
5. After writing the rule, call the `learning_record` tool with its short title (80 characters or fewer), the repo-relative rule file (for example `AGENTS.md`, never an absolute path), the triggering run IDs (1–5, taken from `recent_runs`), and the failure signature (failing test names and/or error classes, at least one). The returned id is internal — record it nowhere. This index append is mechanical bookkeeping, outside the 5-rule cap.
6. If a past lesson is flagged needs-review (a later run repeated its failure), check whether its rule still applies: fix the rule text in the user file, or remove the rule if it was wrong. Flagged entries are reviewed here, never auto-deleted. Fixes count toward the 5-rule cap.

Write only patterns. Never record secrets, literal credentials, absolute user paths or path values, customer data, SQL literals, URLs containing credentials, or log/transcript content. Do not create a draft, quarantine file, or separate learning store. Do not modify product code, global configuration, or unrelated instruction files as a side effect.

## Milestone notes

When a major milestone lands, append one file under `OPENWORKSPACE_HOME/learnings/milestones/` named `<epoch-seconds>-<short-slug>.md` (at most 50 files, 2KiB each). Content is one pattern-only line of 500 characters or fewer after an optional `#` title — what changed for the user, never literals: no secrets, tokens, paths, SQL, URLs, or log output. The dashboard reads these files only; it never writes them.

## Workflow framing

Milestones, verification, and learning run as one flow: mirror completed major milestones to the workspace milestones file for cross-session continuity, verify with the usual checks, then explicitly invoke this skill when a reusable lesson is wanted. Milestone notes remain the narrative timeline; skill and instruction edits hold durable reusable rules. Pause work with a bounded pattern-only checkpoint note (goal, blocker, next step, owner) so the workstream resumes later. Notes append to a bounded history (last 10, latest reads unchanged) and `workstream_context` returns the checkpoint plus scoped recent runs in one read-only call. Native micro-todos may still track small steps alongside; this skill complements that tracking rather than replacing it.

### Assignment completion handoff

Give each child assignment a coordinator-issued `assignmentId`. Before treating that assignment as handed off, query `workstream_context` with that ID and check its present/missing completion state. A completion is an append-only, idempotent result record; it does not change the coordinator-owned workstream status. If the assignment has no completion, ask the **same child** to record its result; never rerun tests, sends, or other side effects as a substitute for a missing handoff. Completion checks are `agent_report` claims, not independent proof or verified-by-us results. Existing `openworkspace_run` evidence is context-stamped separately; pasted/external evidence retains its unverified source and tone. Keep checks and evidence references bounded. Counts are queryable, but do not claim percentage rates from this bounded history.

### Coordinator loop fit (kickoff context, closeout receipt)

When the coordinator runs its own delivery loop, fit OpenWorkspace into it with two touches; the loop itself is unchanged and no new tool is needed. At kickoff, call `workstream_context`; at closeout, attach an `environment_verify` receipt.

**Kickoff — one `workstream_context` call.** Pass `{ workstreamId: "<workstream-id>", limit?, assignmentId? }` (`limit` 1–20, default 5; `assignmentId` is the coordinator-issued ID when one exists). Read the task reference from `name`/`checkouts`, prior state from `checkpoint.latest` plus `open`, and claimed proof from completion `checks` and `recentRuns` — completions are agent-reported (see above), so treat them as claims until backed by run evidence.

**Closeout — one `environment_verify` call.** Pass `{ workspaceId: "<workspace-id>", environmentId: "<environment-id>", repositoryPath: "<repo-path>", scriptName: "<repo-script>" }`; it runs one repo-native script and returns the environment snapshot with the verification outcome and persisted run id. Tie the user-visible result to that receipt; a completion record alone is not proof.

## Checkpoint nudge

When a workstream stayed open a long time with no checkpoint update, close the session with a single-line reminder suggesting the owner write one checkpoint note (goal, blocker, next step). Suggested wording: "Consider writing one checkpoint note (goal, blocker, next step) before closing." Advisory only — never blocks closing, never repeats.

## Shared-resource lease check

Before end-to-end checks that touch shared resources (test mailbox, shared database), check held leases first. If the needed lease is unheld or held by another workstream, say so — e.g. "The test mailbox lease is unheld; results may collide with another run." Advisory only — warn and continue, never block.
