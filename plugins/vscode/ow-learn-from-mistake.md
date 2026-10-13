---
name: ow-learn-from-mistake
description: On explicit invocation, turn reusable session lessons into direct skill and AGENTS.md updates. Never runs automatically.
---

# Learn from a mistake

Use only when the user explicitly invokes this skill. It never runs automatically at session end or after a correction. Review available evidence, keep only guidance that would help someone on a different task, and write it directly to the relevant skill and instruction file. This is not an incident log.

## Review evidence

1. Review the visible session transcript for surprises, retries, denials, and user corrections. Never search for or mine transcript files on disk.
2. When available, review relevant run evidence for the affected workspace: the `environment_verify` receipt (cite its `runId`) plus the dashboard activity timeline. These read-only summaries help identify the triggering operation and outcome; they do not authorize other actions. Never mine your shell history for them.
3. Calibrate every candidate with: **Would this help someone who never saw this failure, on a different task?** If not, skip it. Record reusable patterns, not one-off flukes or incident narratives.

## ow evidence (alongside receipts)

When the repo is `ow`-observed, add this read-only source next to the receipt
and timeline in step 2 above:

1. `ow sessions --dir <project-root>` to scope which sessions actually worked here.
2. `ow stuck --tree` for repeats/overlaps/slows (retry counts, overlap depth).
3. `ow timeline` for action→effect joins across agent rows and spans.
4. Link confidence is cited, never upgraded: `exact` means the ID matched ≥1
   sidecar row exactly; `estimated` means nearest-row proximity within ±10s.

Findings from `ow` evidence obey the same 5-rule cap and citation rule below
(session IDs/timestamps/test names, never content).

## Write durable guidance directly

1. Treat the repository/project currently being worked in as the active project; sibling roots are separate. If its root is unclear, ask before editing. Keep all skill and instruction edits inside it. Update its applicable skill, or create `skills/<skill-name>/SKILL.md` using the existing layout and frontmatter conventions. Never edit a shared skill outside the active project without explicit user authorization; if that is the only suitable skill, refuse that edit and report the boundary.
2. Record the durable rule in the nearest existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` inside the active project. If none applies, add a concise section to the project-root `AGENTS.md`. A shared ancestor outside the project requires explicit user authorization; without it, do not edit there and report that the rule could not be recorded.
3. In both destinations, keep each entry short: **rule** and **when it applies**, with a source reference when one exists. Cite evidence by `runId`, activity timestamp, or test name only; do not copy evidence content. If a transcript-only correction has no such reference, skip the citation; never invent one or copy evidence content.
4. Add or change no more than **5 rules per invocation**. Prefer the most reusable patterns; leave one-off or lower-value observations out.
5. After writing the rule, call the `learning_record` tool with its short title (80 characters or fewer), the repo-relative rule file (for example `AGENTS.md`, never an absolute path), the triggering run IDs (1–5, taken from the `environment_verify` receipt `runId`), and the failure signature (failing test names and/or error classes, at least one). The returned id is internal — record it nowhere. This index append is mechanical bookkeeping, outside the 5-rule cap. Recorded lessons resurface at the next MCP startup as `Relevant past lessons: …` in the initialize instructions when a recent failure matches their signature — there is no lessons view to browse; the dashboard shows none.
6. If a past lesson is flagged needs-review (a later run repeated its failure), check whether its rule still applies: fix the rule text in the user file, or remove the rule if it was wrong. Flagged entries are reviewed here, never auto-deleted. Fixes count toward the 5-rule cap.

## Record setup friction, not just test failures

The primary learning target is setup friction in an unknown world: a service starts, a missing secret or setting surfaces, you set it, the next missing piece surfaces — each step costs time. When 10 or more minutes were wasted on such an avoidable detour, record it with the same care as a test failure:

1. Write the durable rule first: the setup sequence that avoids the detour next time (for example, which values to confirm before starting the service).
2. Call the `learning_record` tool with 1–10 lowercase situation tags describing the detour context (for example `missing secret`, `service start`), the detour's own run as evidence, and whatever failure signature exists — a waste lesson may carry an empty failure signature when it carries tags. Such entries stay unmeasured: they surface as `[situational]` guidance and never auto-flag, no matter how often the detour repeats.
3. Review `[situational]` lessons opportunistically while writing nearby rules: fix the rule text when the setup changed, or leave it while it still applies. There is no age-based flagging and no separate review queue; fixes count toward the 5-rule cap above.

## Probe offer (offer-only)

When a suspect `[needs-review]` measured lesson or a repeated situational detour (`detourNudge`) is under review in this invocation, read this offer once and continue: "This recurring friction could become a pre-flight check. Reply 'yes, draft a regression test at <path>' for a guidance note (at most 2KiB) inside the active project only, run by nobody. Nothing is created unless you accept."

Write only patterns. Never record secrets, literal credentials, absolute user paths or path values, customer data, SQL literals, URLs containing credentials, or log/transcript content. Do not create a draft, quarantine file, or separate learning store. Do not modify product code, global configuration, or unrelated instruction files as a side effect.

For closing a task with a verification receipt, run the receipt-bound verification once per repo-native script and tie the user-visible result to that receipt. Task tracking itself lives in your own harness. Turning session surprises into durable reusable rules stays here.
