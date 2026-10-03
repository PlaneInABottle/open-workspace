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

For task planning — opening context, closing with a verification receipt, milestone notes, handoff checks, and checkpoint-nudge plus shared-resource lease advisories — use the **new-task** skill instead; turning session surprises into durable reusable rules stays here.
