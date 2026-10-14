---
name: ow-ow-debug
description: Debug with ow in order (ps/logs/doctor), join Langfuse by request ID, and diff DB snapshots with a copy-paste recipe.
---

# ow-debug — debugging method + DB snapshot-diff recipe

Method and recipes only. Command syntax lives in `skill/ow`;
this file never repeats its reference. No product-code change is implied.

## Method order (each step answers one question)

1. `ow ps` — is anything alive? Note `running` vs `exited`/`stopped`/`unknown`
   per service; a recycled pid reports unknown, never signaled.
2. `ow logs <svc> --tail 200 --grep <id>` — what values and errors?
   Start narrow (`--service`/`--since`/`--tail`/`--grep` first, full dump
   never); widen only on demand. `--json` when piping into further analysis.
3. `ow doctor` when results look wrong (stale tail, missing session):
   it names liveness and listener hints.

Exits: 0 ok (quiet-empty listings included), 1 structural failure,
2 usage error; always non-interactive.

## Langfuse join (only when the app also reports there)

Local span collection is retired — `ow` no longer receives or stores
spans. When the app reports to Langfuse, join there: the app's own UI
for the remote leg, and `ow logs --grep <id>` to correlate values to
the same request ID in local logs. `ow` never reads the Langfuse API —
the join happens by ID in the agent's hands.

## DB snapshot-diff recipe (agent-run shell, not an ow command)

No new product surface: the agent runs this directly on a small local DB.

```sh
pg_dump --data-only --column-inserts "$DB" > before.sql
# ... run the single test or action ...
pg_dump --data-only --column-inserts "$DB" > after.sql
diff -u before.sql after.sql | head -n 200
```

Volatile columns (`updated_at`, counters) churn every run: exclude them
(e.g. filter before diff) or accept the noise — state which in the
report. Bound: small local DBs only; GB-scale dumps are out of scope.
MySQL/SQLite equivalents exist (`mysqldump --no-create-info` / `sqlite3
db .dump`). Secret rule: dumps may carry seed/PII — never paste dump
bodies into reports or issues; summarize row counts plus changed tables.

## Rules

- Narrow first; `--json` for piping.
- One lag: sidecar rows land ~5s after session end.
- Honesty (mirrors `skill/ow`): report only what the output shows;
  never invent causes.
