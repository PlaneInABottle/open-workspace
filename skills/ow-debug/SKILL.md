---
name: ow-debug
description: Debug with ow in order (ps/logs/trace/timeline), join Langfuse by traceId, and diff DB snapshots with a copy-paste recipe.
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
3. `ow trace` — what crossed services, and when? List newest-first
   (`--tail 20 --since 1d --service <svc>`), then `ow trace <traceId>`
   for one span tree. Browser spans arrive 5–15s late in batches, so
   `ow trace <traceId> --wait 15s` polls for late arrivals before
   concluding absence (browser batch delay).
4. `ow timeline [session] [--trace <id>] [--since 1d]` — which agent row
   goes with which span? `kesin` (exact-ID link) vs `tahmini` (nearest row
   within ±10s): cite the confidence shown, never upgrade a `tahmini`
   link into a causal claim.
5. `ow doctor` when results look wrong (stale tail, missing session,
   0 spans): it names liveness, `unknown` service, and listener hints.

Exits: 0 ok (quiet-empty listings included), 1 structural failure,
2 usage error; always non-interactive.

## Langfuse join (only when the app also reports there)

Local and Langfuse are separate exporters: local always targets the ow
receiver, Langfuse gets its own endpoint/headers (pipeline split per
product `cli/README.md`). Join by the same W3C `traceId` in both
backends: `ow trace <traceId>` for local timing, Langfuse's own UI for
the remote leg. `ow` never reads the Langfuse API — the join happens by
ID in the agent's hands. When the app logs the ID, `ow logs --grep
<traceId>` correlates values to the same trace instead.

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

- Narrow first; `--json` for piping; trace output is semi-sensitive
  (resource IDs) — review before pasting anywhere public.
- Two lags: sidecar rows land ~5s after session end; browser spans 5–15s.
- `unset` span status means the app never said; `unknown` service
  means `OTEL_SERVICE_NAME` is missing.
- Port fight: `lsof -i :PORT` plus `ow doctor` last-span age
  (stale = spans go elsewhere; local stays 4319).
- Honesty (mirrors `skill/ow`): report only what the output shows;
  never invent causes.
