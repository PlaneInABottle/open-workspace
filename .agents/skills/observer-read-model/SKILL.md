---
name: observer-read-model
description: Rules for changing the dashboard observer read model (src/observer.ts, its HTTP routes, signature grouping). Use for any edit to session/message loading, intent join, task grouping, signatures, prompts, or tree records. Not for onboarding, registration, MCP tools, or companion CLI work.
---

# Observer read model

The observer joins two growing sources: the append-only shell log and the agent session-message table. Both outgrow any fixed row cap on real long-lived sessions. Every rule below comes from a demonstrated production failure; do not weaken them for convenience.

**Ownership:** the CLI read model lives once in product `cli/{join,tree,signature}.ts` (`bun:test`); the dashboard read model stays in `src/observer.ts` (`node:test`, `node:sqlite`) — the two runtimes differ irreducibly, so cross-fix discipline remains but is now co-located in one repo/review: a fix on one side must still check the other, and the `ow` binary is rebuilt via `pnpm ow:build`. Drift between them has caused dashboard-fixed bugs to survive in the CLI.

## 1. Window, never head-cap

- No `ORDER BY seq LIMIT N` from the head on a growing table. A head-cap silently drops the newest rows once the table passes N (seen: 4395-row session vs 2000-row cap → all recent intents lost, records fell into `(no task)`). The cap query itself must also be newest-first: `ORDER BY seq DESC LIMIT N`, reversed in JS to ascending (a windowed `ASC LIMIT` still drops the newest rows *inside* the window past 2000).
- Every loader takes `sinceMs`/`now` and filters `time_created >= now - sinceMs` (or the log equivalent) **before** applying the row cap. New params default to null (unbounded) so existing callers keep compiling.
- Thread the window through **every** layer: HTTP handler resolves `since` once and passes `sinceMs` to `joinSession`/`loadTreeRecords`; `loadTreeRecords` forwards it to each `joinSession`; `joinSession` forwards it to `loadSessionMessages`. An unthreaded layer reintroduces the bug silently. Exception by design: `sessionPrompts` takes no `sinceMs` — it always returns the latest N (`ORDER BY seq DESC LIMIT n`, reversed chronological).
- A time window must not break the intent join (intent time vs execution time differ by hours): windowed `joinSession` pins the sidecar-referenced message ids (`loadMessagesByIds`, chunked) plus recent user context (`loadRecentUserMessages`), merged seq-ordered (`mergeMessageRows`). Seen: `since=30m` produced a 20-record `(no task)` bucket without pinning.

## 2. Recency order for user-facing lists

- Any "latest" list uses `ORDER BY seq DESC LIMIT n`, then reverses rows for chronological display. Never `ORDER BY seq LIMIT n` for recency (seen: prompts endpoint returned the session's first 20 messages from days ago instead of the current conversation).
- Name the direction in a code comment so the next edit preserves it.

## 3. Grouping key vs display are separate functions

- `signature()` is the **grouping key**: stable, aggressive folding (`<path>`, `<n>`, `<arg>`). Grouping tests pin it; grouping code never calls anything else.
- Readability enrichment (visible quoted search terms, pipe-stage stacking) lives in `displaySignature()` only — same shape, richer vitrine. Never enrich `signature()` to fix a display complaint; that reshuffles every group.

## 4. Shell text is multiline

- Chain separators are `&&`, `||`, `;` **and** `\n`. Agents emit `cd <path>\n<cmd>` shapes; without `\n` the `cd` prefix survives and the real tool hides (seen: `pnpm`/`agent-browser` invisible behind `cd` titles).
- Backslash escapes the next char in splitting and tokenizing (shell-faithful: `\"` and `\|` never split). Without it, `bun -e "...\"...\""` and `python3 -c "...|..."` shapes desync quote tracking and produce garbage stages (seen: 15 garbage signatures in 2733 real commands, zero after the fix).
- Drop `empty` pipe sides before joining, and treat redirection-only sides (`2>&1`, `>&2`, `2>file`) as `empty` (seen: `"2 | tail"` and `" | tail"` fragment signatures). A side with a real command plus redirections keeps the command.
- Briefing lookup is per-child bounded (newest-first), never one global ascending cap across children (seen: one voluminous child starving another's late prompts into `user`).
- Regression tests use real observed shapes, not idealized one-liners.

## 5. Prove it on the live database, read-only

- Fixture tests cannot catch window/cap bugs — fixtures are small by construction. After any loader/grouping change, run the affected route against the real DB and assert zero degenerate groups (`(no task)` count, `cd`-prefixed or ` -`-prefixed signatures).
- Open the DB with `readOnly: true` (or structural type-only casts) and prove no mutation (md5/stat before/after). Report the check; "fixtures pass" is not proof for this surface.
