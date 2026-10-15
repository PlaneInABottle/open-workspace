---
name: ow-learn-from-mistake
description: On explicit invocation, turn reusable session lessons into direct skill and AGENTS.md updates. Never runs automatically.
---

# Learn from a mistake

Use only when the user explicitly invokes this skill. It never runs automatically at session end or after a correction. Review available evidence, keep only guidance that would help someone on a different task, and write it directly to the relevant skill and instruction file. This is not an incident log.

## Review evidence

1. Review the visible session transcript for surprises, retries, denials, and user corrections. Never search for or mine transcript files on disk.
2. When the repo is `ow`-observed, the optional `ow` evidence in the next section may corroborate what the transcript shows. Never mine your shell history for it.
3. Calibrate every candidate with: **Would this help someone who never saw this failure, on a different task?** If not, skip it. Record reusable patterns, not one-off flukes or incident narratives.

## Optional `ow` evidence

When the repo is `ow`-observed, completed-session `ow` output may serve as extra evidence alongside the transcript. These read-only summaries help identify the triggering operation and outcome; they never authorize other actions:

1. `ow sessions --dir <project-root>` to scope which sessions actually ran here.
2. `ow show <session>` (add `--show-fails` for failures) and `ow reads <session>` for what a session did, in order.

Findings from `ow` evidence obey the same 5-rule cap and citation rule below
(session IDs/timestamps/test names, never content).

## Write durable guidance directly

1. Treat the repository/project currently being worked in as the active project; sibling roots are separate. If its root is unclear, ask before editing. Keep all skill and instruction edits inside it. Update its applicable skill, or create `skills/<skill-name>/SKILL.md` using the existing layout and frontmatter conventions. Never edit a shared skill outside the active project without explicit user authorization; if that is the only suitable skill, refuse that edit and report the boundary.
2. Record the durable rule in the nearest existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` inside the active project. If none applies, add a concise section to the project-root `AGENTS.md`. A shared ancestor outside the project requires explicit user authorization; without it, do not edit there and report that the rule could not be recorded.
3. In both destinations, keep each entry short: **rule** and **when it applies**, with a source reference when one exists. Cite evidence by session ID, timestamp, or test name only; do not copy evidence content. If a transcript-only correction has no such reference, skip the citation; never invent one or copy evidence content.
4. Add or change no more than **5 rules per invocation**. Prefer the most reusable patterns; leave one-off or lower-value observations out.
5. The written rule files are the record — there is no separate lesson
   index. Later invocations resurface them by reading the same files when
   nearby work repeats a failure; fix the rule text if it no longer
   applies, or remove the rule if it was wrong. Fixes count toward the
   5-rule cap.
6. Orphan guidance goes with its feature's files: lessons whose feature no longer exists never linger as orphan guidance.

## Record setup friction, not just test failures

The primary learning target is setup friction in an unknown world: a service starts, a missing secret or setting surfaces, you set it, the next missing piece surfaces — each step costs time. When 10 or more minutes were wasted on such an avoidable detour, record it with the same care as a test failure:

1. Write the durable rule first: the setup sequence that avoids the detour next time (for example, which values to confirm before starting the service).
2. Write the detour context into the same rule: 1–10 lowercase situation tags describing the detour (for example `missing secret`, `service start`), citing the session or test run that showed it.
3. Fix the rule text when the setup changes, or leave it while it still applies; fixes count toward the 5-rule cap above.

## Probe offer (offer-only)

When a recurring friction is under review in this invocation, read this offer once and continue: "This recurring friction could become a pre-flight check. Reply 'yes, draft a regression test at <path>' for a guidance note (at most 2KiB) inside the active project only, run by nobody. Nothing is created unless you accept."

Write only patterns. Never record secrets, literal credentials, absolute user paths or path values, customer data, SQL literals, URLs containing credentials, or log/transcript content. Do not create a draft, quarantine file, or separate learning store. Do not modify product code, global configuration, or unrelated instruction files as a side effect.
