---
name: learn-from-mistake
description: Turn session surprises and user corrections into small local learning drafts. Use at session end, on demand, or whenever the user corrects you — never for implementation, deployment, or unrestricted machine setup.
---

# Learn from a mistake

You are the user's own assistant. A surprise is anything that made you retry, backtrack, or get corrected: a wrong path, flag, command, assumption, or project-specific rule you did not know. Capture it as a small local draft so the next session avoids it. This skill never modifies product code, shared skills, or global configuration.

## When to draft

Mine your visible session transcript — the turns you can already see. Client transcript-file formats vary, so never go looking for a transcript file on disk.

1. **Session-transcript mining (on demand or before finishing):** scan the turns above for correction moments — user says "wrong X, use Y", a retry after a denial, a second attempt with different arguments, or a stated project rule. Produce at least one draft per distinct surprise. Group repeats of the same surprise into one draft.
2. **Closing note (before reporting work done):** if anything surprised you during the work, write a 3-line note first — what happened / why / the rule to remember. An empty note ("no surprises") is fine and means no draft.
3. **User correction (always):** every explicit user correction drafts immediately, even a tiny one. Do not batch, debate, or skip it.

## Draft format

Drafts are markdown files under `OPENWORKSPACE_HOME/learnings/_drafts/` (for example `~/.local/share/openworkspace/learnings/_drafts/`). Create the directory if absent. Keep each file at most 2KiB, at most 50 files total — delete your own oldest drafts first if full.

Each draft has this shape:

```markdown
# <short title>

- Scope: <glob(s) this applies to, e.g. `chatwoot/**` or `*` for general>
- Rule: <one pattern-only rule, 500 characters or fewer>
- Source: <activity operation, verify run timestamp, or test name>
- Status: draft
```

The rule states the pattern, never literals: no secrets, tokens, absolute user paths, SQL text, URLs with credentials, or pasted log output. Write "the restart target needs the exact mapped pmId" rather than copying the command you ran.

## Reading history

Two read-only MCP tools feed mining without widening your permissions:

- `activity_list` (limit 1–50, default 20): recent sanitized tool/target/outcome descriptors. No payloads are stored, so absence of detail is expected.
- `recent_runs` (scope workspace or workstream ID, limit 1–20, default 5): recent bounded verification summaries with at most 200 characters of excerpt each.

Reading either tool never records new activity, so mining leaves no feedback loop.

## Promotion (manual only)

Drafts never self-promote. A draft becomes a shared skill update only when the user explicitly approves it in chat — for example after the rule proves itself on a second real task, or during a batched review the user asked for. On approval, move the rule text into the skill the user names, following that skill's own format. Until then the draft stays local, uncommitted, and invisible to other machines.
