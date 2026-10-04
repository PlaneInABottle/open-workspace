---
name: openworkspace-new-task
description: Plan a task with OpenWorkspace: open workstream context, produce a verification receipt. Explicit invocation at task start.
---

# Plan a task

Use only when explicitly invoked during task work. It never runs automatically. Fit OpenWorkspace into any delivery loop with two touches; the loop itself is unchanged and no new tool is needed. At the start of work, open the workstream context; when work finishes, attach a verification receipt. This applies identically whether one person does everything or work is split across assignments.

## Starting work — one workstream context call

Call `workstream_context` once. Pass `{ workspace: "<project-name>", workstream: "<stream-name>", limit?, assignmentId? }` (`limit` 1–20, default 5; `assignmentId` is the grouping ID when work is grouped by assignment, omit it for solo work). Read the task reference from `name`/`checkouts`, prior state from `checkpoint.latest` plus `open`, and claimed proof from completion `checks` and `recentRuns` — completions are agent-reported (see below), so treat them as claims until backed by run evidence.

If `workstream_context` returns `goldenPath`, mention its one-line reference (`last time <script> took ~X`) when starting similar work; if it returns `detourNudge`, quote it once verbatim and continue. Both are advisory.

## Finishing work — one verification receipt call

Call `environment_verify` once. Pass `{ workspace: "<project-name>", environment: "<env-name>", repositoryPath: "<repo-path>", scriptName: "<repo-script>" }`; it runs one repo-native script and returns the environment snapshot with the verification outcome and persisted run id. Tie the user-visible result to that receipt; a completion record alone is not proof.

## Environment propose → set → up

When the project needs a multi-service runtime, call `environment_propose` first (read-only candidates), then pass its services straight into `environment_set` with your chosen env name — no hand-mapping: `dependsOnSuggest` applies as `dependsOn` and propose-only hints are ignored. Then `environment_up` starts the stored setup. A proposal with an empty `scriptName` means no runnable script was found: pick the npm script that runs it before `set`.

## Assignment completion handoff

Give each grouped piece of work an `assignmentId` (omit it for solo work — it groups under the default). Before treating that piece as handed off, query `workstream_context` with that ID and check its present/missing completion state. A completion is an append-only, idempotent result record; it does not change the workstream status. If the piece has no completion, ask the same person who did the work to record its result; never rerun tests, sends, or other side effects as a substitute for a missing handoff. Completion checks are `agent_report` claims, not independent proof or verified-by-us results. Existing `openworkspace_run` evidence is context-stamped separately; pasted/external evidence retains its unverified source and tone. Keep checks and evidence references bounded. Counts are queryable, but do not claim percentage rates from this bounded history.

## Milestone notes

When a major milestone lands, append one file under `OPENWORKSPACE_HOME/learnings/milestones/` named `<epoch-seconds>-<short-slug>.md` (at most 50 files, 2KiB each). Content is one pattern-only line of 500 characters or fewer after an optional `#` title — what changed for the user, never literals: no secrets, tokens, paths, SQL, URLs, or log output. The dashboard reads these files only; it never writes them. Mirror completed major milestones to the workspace milestones file for cross-session continuity, then verify with the usual checks; milestone notes remain the narrative timeline. Pause work with a bounded pattern-only checkpoint note (goal, blocker, next step, owner) so the workstream resumes later. Notes append to a bounded history (last 10, latest reads unchanged) and `workstream_context` returns the checkpoint plus scoped recent runs in one read-only call. Native micro-todos may still track small steps alongside; this skill complements that tracking rather than replacing it.

## Checkpoint nudge

When a workstream stayed open a long time with no checkpoint update, close the session with a single-line reminder suggesting the owner write one checkpoint note (goal, blocker, next step). Suggested wording: "Consider writing one checkpoint note (goal, blocker, next step) before closing." Advisory only — never blocks closing, never repeats.

## Shared-resource lease check

Before end-to-end checks that touch shared resources (test mailbox, shared database), check held leases first. If the needed lease is unheld or held by another workstream, say so — e.g. "The test mailbox lease is unheld; results may collide with another run." Advisory only — warn and continue, never block.

## Situational lessons

`workstream_context` may return `situationalLessons` titles marked `[situational]`: weigh them below failure-matched lessons, follow them only when they fit this task, and ignore them on mismatch.
