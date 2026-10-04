---
name: scaffold-local-tool
description: Draft one local-tool JSON into local-tools/pending/ from observed repetition. Never for secrets, chains, new executables, or writes.
---

# Scaffold a local tool

One JSON declaration; the gate decides activation. No new executables, flags, or shell.

## Inputs (all required)

- Same command seen 3+ times with varying values (activity/run refs).
- Proposal basename (`[a-z0-9-]{1,80}.md`) written by the agent under `OPENWORKSPACE_HOME/local-tools/proposals/` as part of this proposal. This is local-tool proposal provenance, not learn-from-mistake output.
- Name (`[a-z][a-z0-9_]{0,39}`, never starting `workspace_|service_|verification_|lease_|workstream_|activity_|recent_|onboarding_|browser_|datastore_|local_`), description (1-200 chars), at most 5 slots.

## Write the proposal directly — never activate silently

When you detect a repeated pattern worth turning into a tool, state the benefit and cost in the proposal record, then write the proposal plus the pending declaration directly (pending only, never active); the gate decides activation. Without the 3+ repetition evidence and the proposal inputs, write nothing. No silent activation.

## Refuse (name the rule, draft nothing)

Secrets; chains (`|`, `&&`, `;`); executables outside the compiled allowlist — name the class (`psql-fixed-select`), never a binary; path/shell/free-text slots (only `identifier`, `slug`, `integer` with `min >= 0`, `enum`); 6+ inputs; descriptions with fences, links, URLs, or prompt patterns (`ignore|disregard|forget…instructions|rules`, `you are now|a`, `system prompt`); any statement beyond one fixed placeholder-free single SELECT; missing or forged `proposal`.

## Proposal provenance

Before writing the pending JSON, create `<OPENWORKSPACE_HOME>/local-tools/proposals/<basename>.md` and point `provenance.proposal` at its basename. Keep the file at most 2KiB and use exactly this shape:

```markdown
# <short title, at most 120 characters>

- Scope: <relative glob or *>
- Rule: <one reusable, pattern-only rule, at most 500 characters>
- Source: <runId, activity timestamp, or test name>
- Status: proposal
```

Do not copy secrets, credentials, absolute paths, customer data, SQL literals, or log/transcript content. This is an explicit proposal record for the local-tool scaffold flow; it is not mined or created by **learn-from-mistake**.

## Output

One file, at most 8KiB, at `<OPENWORKSPACE_HOME>/local-tools/pending/<name>.json`:

```json
{"name":"db_tables","description":"List public-schema tables of a local database.","executable":"psql-fixed-select","slots":{"database":{"kind":"identifier"},"role":{"kind":"identifier"}},"statement":"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1","caps":{},"provenance":{"origin":"scaffolded","proposal":"<proposal-basename>.md","createdAt":"<now>"}}
```

Never write `active/` or `quarantined/`; never edit allowlist source; never invent a class.

## Pre-flight

Name plus prefix; description length plus refusal patterns; slots match the class spec; statement one bare SELECT, no `{{`, no `$n`, no denied token; the proposal file exists at the fixed path and matches the capped shape; JSON at most 8KiB. Pass activates, fail stays pending.
