# Local Declarative Tools Engine — Implementation Contract

## Problem and Success Criteria
- Solo-local users/agents can add MCP tools as **data-only declarations** (JSON), executed solely by the hardened runner. No arbitrary-code plugins, no marketplace, no dynamic MCP discovery.
- Success: one declared tool (`db_tables`) is callable over MCP, is strictly better than its raw `psql` equivalent (bounded, honest-unavailable, activity-counted, learning-loop-fed), and the full injection-negative matrix passes with spawn never invoked for hostile slots.
- Conformance gate before activation; provenance per tool; auto-quarantine on repeated failure. `stateSchema.strict` untouched; no new dashboard views in v1.

## Decisions
- **Storage: `<OPENWORKSPACE_HOME>/local-tools/{pending,active,quarantined}/`, never in the repo.** Satisfies ROADMAP "separate `local-tools/` dir (no upstream conflicts)" by construction: state home is outside the repo, per-machine, `0700` via `ensurePrivateDirectory`, isolated per `OPENWORKSPACE_HOME` in tests. Nothing committed, nothing to gitignore. Alternatives rejected: repo-level `local-tools/` (git-status noise, upstream-collision review burden).
- **Execution model: NO declaration-supplied argv in v1 (F2).** Declarations carry slots plus one fixed `statement` literal; every argv vector is server-owned code in the allowlist class. The single v1 class `psql-fixed-select` requires exactly slots `{database, role}` (both `identifier`) and builds `psql <base flags> -d <db> -U <role> -f -` with the fixed statement on stdin, delegating to `runDatastoreQuery` (which re-validates shape/deny on the final SQL at runtime). `-c` and `-f<path>` appear in no server argv; no declaration field can add flags. A generic argv-template class is deferred to a future plan with its own `-c`/`-f` negatives — it is not half-specified here.
- **Template safety = server-owned argv + closed slot kinds + universal no-leading-dash rule + `shell:false` + fixed statement.** Slot kinds are server-defined classes only (`identifier|slug|integer|enum` — **no free-text string kind, no custom regex in v1**); enum values must start alphanumeric (`^[A-Za-z0-9][A-Za-z0-9_.,:]{0,63}$`, F1). After slot placement, every slot-derived argv element is re-matched to its class AND must not begin with `-` — checked at gate dry-run and at every invocation, so flag smuggling (`-h`, `-c`, `--help`) is refused pre-spawn regardless of class. Execution reuses `runBoundedCommand` (`shell:false`); local-tools modules add no spawn site.
- **Executable allowlist is compiled code (`src/local-tools-allowlist.ts`), human-extended only, resolved to canonical absolute paths (F4).** Agents write state-home JSON; new executables require a source edit + review + typecheck. v1 holds exactly one entry: class `psql-fixed-select`, which owns binary name `psql`. Resolution happens at gate AND at each run: PATH scan for the class's owned binary (same `stat`+`X_OK` per absolute PATH-dir model as `toolAvailability`) → `realpath` → verify (regular file, no remaining symlink, uid 0-or-euid, no group/other write, executable) → spawn the canonical absolute path. Re-verification failure or canonical-path change at run time = honest unavailable via the existing `PostgreSQL client is unavailable.` message — never a bare-name fallback. The probe uses the same canonical path.
- **Transport is explicit HTTP to the service process (F3).** MCP and service are separate processes (service holds the single-writer lock; MCP reaches it via loopback `serviceRequest`). All gate/registry/execution/quarantine/activity writes happen service-side only; the MCP process never touches `local-tools/` files. Two new routes (specified in Transport below) with `mcpMayCall` + dashboard-intent gating mirroring the datastore block.
- **Solo-local approval: gate-pass = active, no extra click.** Rationale: threat model contains accidents/agent mistakes, never the user attacking themselves (`AGENTS.md`); matches "dashboard records, never gates" philosophy. Gate-fail leaves the file in `pending/` (never-active) or moves it to `quarantined/` (was-active) with a closed-vocabulary reason; reasons surface via the read-only `local_tool_status` MCP tool + `activity_list`.
- **First tool: `db_tables` (public-schema table lister).** `pm2-env` probe rejected: process environments are an explicit non-exposure invariant. `db_tables` reuses the whole datastore hardened path (identifier regex, superuser probe, `BEGIN READ ONLY` + `statement_timeout`, `maskSecrets`, counts-only activity). Its fixed declaration is given literally in First-tool declaration below.
- **One coherent engine in two milestones** (core callable tool first; authoring path + hardening second). No new runner abstraction; no `stateSchema` change; backend typecheck scope only.

## Verified Context
- `src/verify.ts:93-111` — `runBoundedCommand` spawns with `shell:false`, bounded env, stdin-close default; `boundedEnvironment` at `:82-91`.
- `src/verify.ts:106` — `shell: false` is unconditional in the runner; reuse as-is, no wrapper, no signature change.
- `src/discovery.ts:121-141` — `toolAvailability` PATH model: per absolute PATH dir, `stat` isFile + `X_OK`; availability ≠ readiness; honest `found/missing`.
- `src/connection.ts:21-31` — MCP is a separate process reaching the service over loopback HTTP bearer `serviceRequest`; raw server error text passes through `src/mcp.ts:23-29`, so every service-emitted local-tool message must already be safe-listed.
- `src/main.ts:12` — service holds the single-writer state lock (`acquireStateLock`); all registry-file and activity writes belong service-side — the MCP process must not write them.
- `src/http.ts:496-539` — safe-error allowlist: only listed messages reach clients; everything else collapses to a generic retry message. Local-tool errors must extend this list.
- `src/http.ts:240-258` — activity records counts/descriptors only; literals/SQL/URLs/log text never persisted; activity/run reads never record.
- `src/http.ts:360-373` — datastore block pattern to mirror for the new call route: dashboard role requires canonical origin + intent header; MCP role allowed directly; `request.setTimeout` for long calls.
- `src/store.ts:66-80` — `ensurePrivateDirectory` enforces `0700`, uid-ownership, no-symlink ancestors; `writePrivateJson` uses `0600` + atomic rename.
- `src/store.ts:51-56` — `stateSchema.strict()` with `workspaces/workstreams/leases/activity`; registry lives in files + activity counts, schema untouched.
- `src/datastore.ts:204-247` — `singleStatement` / `checkShape` / `checkDenied` run on FINAL bound SQL before any spawn (module-private today — F8 adds a bounded export; do not duplicate).
- `src/datastore.ts:178-200` — `bindParams` throws the shape error on out-of-range `$n` placeholders; `:323` validates the FINAL bound text. (G4: gate runs `bindParams(statement, [])` so a `$` placeholder can never survive to activation.)
- `src/datastore.ts:251-267` — `psqlArgs` base flags and `psqlEnv` minimal env; `:328/:341` spawn the hardcoded `'psql'` name (F4 plumbs an `executablePath` override; default preserves current behavior). (G2: `psqlArgs` joins the bounded export so class and spawn share one construction; the class passes no `socketDir`/`port`, keeping `-h`/`-p` out of every local-tool argv.)
- `src/datastore.ts:15` — identifier is `max(63)` `/^[A-Za-z_][A-Za-z0-9_$]*$/`; declaration classes must be byte-identical (F7). `:8` runner timeout is a fixed 15s class constant, not declarable (F7).
- `src/datastore.ts:328-336` — superuser probe refuses superuser roles before the real query; `:337` wraps with `BEGIN READ ONLY` + `statement_timeout`, so declarations carry a bare single SELECT. Probe-phase vs query-phase failures are indistinguishable to callers today (same message strings) — G5 adds a `stage: 'connect'|'query'` marker with byte-identical messages.
- `src/datastore.ts:274-287` — `parseRows` limitation note: hostile cell text stays inert display text, never re-executed; same applies to tool output.
- `src/run-summaries.ts:31-37` — `maskSecrets` for output before return/persist.
- `src/services.ts` (whole) — process environments and raw argv are never exposed; this invariant is why no env-probe tool is allowed.
- `src/mcp.ts:32-61` — `registerTool` with strict zod `inputSchema`, format-budget precedent (desc short, `≤5`-key flat schemas, `describe` sparingly); base instructions near byte cap — do NOT extend them.
- `skills/learn-from-mistake/SKILL.md:20-33` — drafts under `OPENWORKSPACE_HOME/learnings/_drafts/`, ≤2KiB, ≤50 files, pattern-only rules; `sourceDraft` links this loop.
- `ROADMAP.md:234` — queue row 16 fixes direction: declarations + hardened runner only, gate + provenance + quarantine, `local-tools/` separation, solo-local (multi-user would re-lock).

## Scope
- Allowed: new `src/local-tools*.ts` modules (loader, gate, registry, executor, allowlist class); MCP wiring in `src/mcp.ts` (startup status fetch, dynamic registration, `local_tool_status`); two HTTP routes + `mcpMayCall` + safe-error additions in `src/http.ts`; `WorkspaceService` methods for status/call; bounded `src/datastore.ts` change ONLY — export `singleStatement`/`checkShape`/`checkDenied`/`bindParams`/`psqlArgs`, add `DatastoreRunnerOptions.executablePath` (default absent preserves hardcoded-`'psql'` behavior), and throw staged errors (`stage: 'connect'|'query'` with byte-identical message strings — no existing message changes, no other behavior change); `test/local-tools.test.ts`; `skills/scaffold-local-tool/SKILL.md`; `docs/` plan file.
- Forbidden: any change to `stateSchema`/migration logic, `runBoundedCommand` signature/behavior, dashboard views or frontend code, `toolAvailability` semantics, duplicating datastore validation/execution logic in local-tools modules, network/remote execution, secret-bearing fields, custom slot regexes, shell execution paths, declaration-supplied argv/flags.

## Blast Radius and Invariants
- Entry points: two new HTTP routes (`POST /api/workspaces/:id/local-tools/call`, `GET /api/local-tools/status`) under the existing role/intent model; service startup scan; MCP startup status fetch + `listTools/callTool` for registered local tools and `local_tool_status`.
- Invariants and verification: `shell:false` on every spawn (audit: no `spawn(`/`exec` in `src/local-tools*.ts` — absolute-path spawn flows through the existing datastore `run()` indirection only); process env/argv never in output (injected test asserts); `stateSchema.strict` parse of existing fixtures still passes (run `test/workspace.test.ts` unmodified); safe-error allowlist is the only client-visible error path (test asserts hostile input yields a listed message, never raw zod text or paths — call-time schema failures map to one fixed listed message per Call-time vocabulary below); no declaration field reaches any argv vector (shared-construction + spawn-capture tests per G2).
- Must not change: existing MCP tool names/descriptions/behaviors; base MCP instructions text (byte cap); verification/datastore/service semantics except the bounded F8/G5 export; dashboard UI.

## Milestone 1: Engine + first tool callable over MCP
- Dependencies: None.
- Subphases:
  1. Allowlist class + declaration envelope: `src/local-tools-allowlist.ts` holding exactly `psql-fixed-select` (owns binary `psql`; slotSpec exactly `{database: identifier, role: identifier}`; argv built ONLY via exported `psqlArgs`, no `socketDir`/`port`; `probeArgs:['--version']`; `env:'psql'`; class constants timeout 15s / output 64KiB / socket headroom 40s; `socketOnly:true`); `src/local-tools.ts` zod-strict envelope per Declaration envelope below; file bounds (≤8KiB, regular file, no symlink, uid-owned, no group/other write — read bits may stay open for hand-editing); name rule (`^[a-z][a-z0-9_]{0,39}$` minus reserved prefixes `workspace_|service_|verification_|lease_|workstream_|activity_|recent_|onboarding_|browser_|datastore_|local_`); class names kebab-case; ≤20 tools total.
  2. Loader + gate (service-side only): validation order per Loader below (incl. G4 `bindParams(statement, [])` placeholder rejection); `pending/→active` promotion only on full gate pass; atomic in-memory registry swap (never half-active); gate runs at service startup scan + on status calls; canonical-path resolve→`realpath`→verify→probe sets `available:true|false` (unverifiable/missing exe = active-but-honest-unavailable, never quarantine).
  3. Execution (service-side): slot re-validation + universal no-leading-dash post-substitution rule → re-resolve/re-verify canonical path (mismatch = honest unavailable, counter untouched) → delegate to `runDatastoreQuery(roots, {database, role, sql: <fixed statement>, maxRows}, {executablePath: canonical})` with NO `socketDir`/`port`; output via `maskSecrets`, truncated to class caps; activity `local-tool-call` counts-only (`db_tables → N rows`). Failure classification (G5): probe/connect-stage failures (bad database/role, server down, superuser refusal, connect timeouts — `stage: 'connect'`) and caller-side slot refusals are caller errors: safe message returned, counter untouched. ONLY query-stage failures (`stage: 'query'`) increment the quarantine counter.
  4. Quarantine with closed-vocabulary reasons: 3 consecutive QUERY-stage post-spawn failures → drop in-memory registration FIRST (immediate stop), then write `<name>.reason.json` (`{code: runtime-failures, at, failures, exitCodes?}` — counts/codes only, never stderr), then atomic rename `active/→quarantined/`, plus activity `local-tool-quarantine`; success (any stage) resets the counter. Rename failure: tool stays unregistered, retry on next call/rescan (server-logged), status reports `quarantinePending:true`. Re-activation = human moves the file to `pending/` for re-gate. `quarantined/` location is durable across restarts. Counters in-memory only. Accepted residual: compiled-flag breakage manifests at probe stage and therefore never auto-quarantines — it surfaces via status/activity and is fixed by code change under review, which is the correct channel for compiled code.
  5. Transport + MCP exposure: the two routes with `mcpMayCall` entries and dashboard-intent gating (`call-local-tool`; status read is intent-free like other reads); call-route body/schema failures map to the fixed Call-time vocabulary below (never raw zod); MCP startup fetches status via `serviceRequest` and registers one tool per `active` declaration (name + server-prefixed description + translated strict zod schema, no `describe`/examples) plus always-on `local_tool_status`; service unreachable at MCP startup → status tool only, local tools appear after MCP restart (see E1). Thirteen new safe-error messages join the `http.ts` allowlist (10 gate + 3 call-time; delegate/workspace messages reused from the existing list).
  6. Ship the fixed `db_tables` JSON from First-tool declaration below into tests/fixtures; owned-fixture proof via temp `OPENWORKSPACE_HOME` + stub-`psql`-on-PATH (temp dir, `0700`, canned `--version` + query output; stub passes the canonical verify as euid-owned non-writable) and empty-PATH unavailable case.
- Files/behavior boundary: `src/local-tools*.ts`, `src/mcp.ts` registration block, `src/http.ts` routes + safe-message list, `WorkspaceService` status/call methods, bounded `src/datastore.ts` export/option/stage, `test/local-tools.test.ts`, fixture stub only under temp dirs.
- INNER/CHECKPOINT: `pnpm typecheck:backend`; `npx tsx --test test/local-tools.test.ts`; `grep -rn "spawn(\|exec(" src/local-tools*.ts` (must be empty); G2 argv tests — (i) `psqlArgs({database, role, sql, params: [], maxRows}, {})` deep-equals the literal expected vector, (ii) injected capturing `run` into `runDatastoreQuery` records the ACTUAL spawn argv and asserts equality with (i).
- Milestone gate: `db_tables` callable end-to-end (real HTTP service + real stdio MCP session) against the stub-PATH fixture (happy rows + unavailable-honest + 1 injection refusal), integration evidence only.
- Evidence invalidation: any edit to `src/local-tools*.ts`, `src/mcp.ts`, `src/http.ts`, `src/datastore.ts`, `src/verify.ts` after the run.
- Stop conditions: MCP SDK cannot register tools post-connect AND startup-only registration breaks the `pending→active` without-restart story (fall back to documented MCP-restart-required; see experiment E1); stub fixture cannot faithfully emulate `psql -f -` stdin framing (fall back to injected-runner argv assertions + real-`psql`-absent unavailable proof).
- Acceptance: fixed declaration from First-tool declaration below gates clean; negative matrix from Template safety below all refused with spawn uncalled (assert via injected runner); 3 stubbed consecutive QUERY-stage failures quarantine with closed-vocabulary reason + activity entry while caller-side refusals, probe-stage failures, and run-time unavailable do NOT increment (assert counter stays 0 with a capturing run failing at probe input); unavailable-PATH yields the listed safe error and `available:false` in status; existing `test/workspace.test.ts` + `test/datastore.test.ts` still pass unmodified (message strings byte-identical despite staged errors).

## Milestone 2: Authoring path + hardening + review
- Dependencies: Milestone 1.
- Subphases:
  1. `skills/scaffold-local-tool/SKILL.md` implementing the Scaffold skill contract below (inputs/outputs/refusals incl. G6 imperative patterns; writes `pending/` only; ≤2KiB skill file per learning-loop precedent).
  2. Hardening tests: gate-refusal matrix (unknown exe, class-name/binary confusion i.e. `"executable": "psql"`, 6th input key, custom pattern/kind field, enum `['-h']` / `['-c']`, integer `min<0`, `$1` placeholder in `statement` (G4), second statement in `statement`, `COPY` in `statement`, `-h`-shaped slot value, TCP-ish statement, oversized description, fenced/URL/imperative description (G6), reserved name, forged `sourceDraft`, 21st tool); server-argv audit via the G2 shared-construction + capture tests (no `-c`, `-f` only as `-f -`); description-confinement test (hostile description renders in the description field only, alters no instruction/prompt/SQL/argv); G5 classification test (probe-input failure → no increment + caller message; query-input failure ×3 → quarantined); quarantine re-gate cycle (quarantined → human moves to pending → fixed file re-gates to active); hot/cold rescan behavior per experiment E1 outcome.
  3. Byte-budget note: measure `listTools` delta with `db_tables` active vs absent (target: one tool ≈ server prefix + description + 2-key schema, no base-instructions change); record in plan file appendix.
  4. Final review pass at security-boundary level (negative-matrix + trust-boundary + transport + rollback rationale).
- Files/behavior boundary: `skills/scaffold-local-tool/SKILL.md`, `test/local-tools.test.ts` additions, plan-file budget note.
- INNER/CHECKPOINT: `pnpm typecheck:backend`; `npx tsx --test test/local-tools.test.ts`; `pnpm test` (full suite, includes UI — must stay green though untouched).
- Milestone gate: full `pnpm test` green + reviewer confirms negative matrix, trust boundary, and transport; no new dashboard/frontend diff.
- Evidence invalidation: any edit to covered `src/` files, skill text, or test file after the run.
- Stop conditions: byte-budget delta forces `listTools` truncation concerns (defer: cap active tools below 20 by policy, document); reviewer finds a slot class that admits control characters (fix class, re-run matrix — no redesign).
- Acceptance: scaffold skill refuses all contract refusal cases in tests (fixtures, not live agent); gate-refusal matrix green; G5 classification + quarantine cycle green; budget note recorded; `pnpm test` green.

## Conditional Surface Contracts

### Declaration envelope (exact)
```ts
// zod-strict envelope; JSON file ≤8KiB; unknown keys rejected
{
  name: /^[a-z][a-z0-9_]{0,39}$/ minus reserved prefixes
    (workspace_|service_|verification_|lease_|workstream_|activity_|recent_|onboarding_|browser_|datastore_|local_),
  description: string 1..200, // UNTRUSTED DATA (F5/G6): no NUL/controls/newlines; gate refuses
    // ``` fences, markdown links [x](y), http(s):// and www. patterns, AND bounded
    // imperative/prompt patterns: /ignore|disregard|forget.{0,40}(previous|prior|above|instructions|rules)/i,
    // /you are (now|a)/i, /system prompt/i. Always presented as "Local tool <name>: <description>"
    // inside the MCP description field ONLY — never interpolated into instructions, prompts,
    // SQL, or argv (asserted by test). Pattern refusal is defense-in-depth and explicitly
    // non-exhaustive; field-confinement is the primary control (accepted residual, G6).
  executable: string // (G1) names the allowlist CLASS (v1: exactly "psql-fixed-select");
    // the class owns the binary name ("psql") + argv + probe. Kebab-case, no slashes,
    // no absolute paths. A bare binary name ("psql") is NOT a valid class reference.
  slots: { [k: string]: SlotDecl } // ≤5 keys; key regex ^[a-zA-Z_][a-zA-Z0-9_]{0,63}$;
    // the v1 psql-fixed-select class requires EXACTLY {database: identifier, role: identifier}
  statement: string // 1..8000 chars, fixed literal, zero "{{" occurrences, zero "$n"
    // placeholders (G4: gate runs bindParams(statement, []) so "$" never survives);
    // must pass singleStatement+checkShape+checkDenied at gate (psql class).
    // Keep it a bare single SELECT — runDatastoreQuery adds BEGIN READ ONLY + statement_timeout.
  caps: { maxRows?: 1..100 default 50 } // (F7) timeout/outputLimit are class-owned constants,
    // NOT declarable; maxRows maps 1:1 onto runDatastoreQuery maxRows
  provenance: { origin: 'handwritten'|'scaffolded', sourceDraft?: basename /^[a-z0-9-]{1,80}\.md$/,
    createdAt: datetime } // sourceDraft required iff scaffolded; must exist under local-tools/proposals at gate.
    // origin is an informational label with ZERO trust weight — gate treats both identically (F10)
}
type SlotDecl =
  | { kind:'identifier' } // ^[A-Za-z_][A-Za-z0-9_$]{0,62}$ — byte-identical to the datastore
    // identifier (total max 63, F7)
  | { kind:'slug' }       // ^[a-z0-9][a-z0-9_-]{0,63}$
  | { kind:'integer', min: int, max: int } // min<=max, |bound|<=1e9; min>=0 for argv-bound slots (F1)
  | { kind:'enum', values: string[2..20] } // each ^[A-Za-z0-9][A-Za-z0-9_.,:]{0,63}$ —
    // leading char alphanumeric, so a leading '-' is unrepresentable (F1)
// NO argsTemplate, NO stdinTemplate, NO {kind:'string'}, NO custom pattern field,
// NO nested objects/arrays, NO defaults/examples.
```
Translated to a strict zod object at registration; `workspaceId` comes from the route path, never from declaration input.

### Loader validation order (first failure wins, safe error)
1. `lstat`: regular file, not symlink, uid-owned, no group/other write, size ≤8KiB → else `Local tool file could not be read safely.`
2. Fatal-UTF8 read + `JSON.parse` → `Local tool declaration is not valid JSON.`
3. Envelope zod `.strict()` → `Local tool declaration failed validation.` (details server-log only)
4. Name regex + reserved prefixes → `Local tool name is not allowed.`
5. Description untrusted-data patterns (F5 fences/links/URLs + G6 imperative/prompt patterns) → `Local tool description is not allowed.`
6. `executable` names a compiled allowlist class — v1 exactly `psql-fixed-select`; a bare binary name is refused here (G1) → `Local tool executable is not allowlisted.`
7. Slots match the class `slotSpec` exactly (names, kinds, count) → `Local tool inputs do not match the executable class.`
8. `statement`: `bindParams(statement, [])` (G4: rejects any `$n`), then `singleStatement`+`checkShape`+`checkDenied` on the FINAL text via the shared datastore functions (no copies) → `Local tool command shape is not allowed.`
9. `caps.maxRows` range → `Local tool limits are out of range.`
10. `provenance` cross-check (`sourceDraft` present iff scaffolded AND exists under `local-tools/proposals`) → `Local tool declaration failed validation.`
11. Canonical-path resolve→`realpath`→verify→probe (class `probeArgs`, ≤5s, exit 0) against the class's owned binary → sets the `available` flag; unverifiable or probe-failing = `available:false`, never fatal.
12. Tool-count cap (≤20 active+pending) → `Local tool limit reached.`
All thirteen new messages (10 gate above + 3 call-time below) join the `http.ts` safe allowlist; pre-existing delegate/workspace messages are already listed; zod internals and absolute paths never reach clients.

### Template safety mechanism + negative matrix (F1/F2, G2)
Mechanism (all must hold; each is independently testable):
- (a) No shell exists in the path: `runBoundedCommand` spawns with `shell:false`; local-tools modules add no spawn site (delegation only).
- (b) Server-owned argv with SHARED construction (G2): the class builds argv ONLY by calling the exported `psqlArgs({database, role, sql: statement, params: [], maxRows}, {})` with no `socketDir`/`port` — the exact function `runDatastoreQuery` uses internally, so class and spawn cannot drift. Expected vector: `psql -X -w -v ON_ERROR_STOP=1 -A -F <US> -P null=<RS> -P pager=off -q -d <db> -U <role> -f -`. Tests: (i) `psqlArgs(...)` output deep-equals this literal vector (catches any future `-c`/`-f<path>` edit at its source); (ii) an injected capturing `run` passed into `runDatastoreQuery` records the ACTUAL spawn argv and asserts equality with (i) (proves what spawns, not just what builds).
- (c) Closed slot classes (above): every value matches a bounded allowlist charset; NUL/newline/controls structurally unrepresentable; enum cannot start with `-` (F1).
- (d) Universal post-substitution rule (F1): after slot placement, each slot-derived element is re-matched to its class AND must not begin with `-`. Checked at gate dry-run and at every invocation; violation refuses pre-spawn. This also closes integer-negative smuggling even if a future class permits negative bounds.
- (e) Fixed statement: zero interpolation points and zero placeholders (G4); validated at gate AND re-validated at runtime inside `runDatastoreQuery`.
- (f) Path slots do not exist in v1 (`/` appears in no class); TCP options do not exist (`-h`/`-p` in no local-tool argv; socket default only).
Negative matrix (each: refused pre-spawn, spawn uncalled, listed safe error): `; DROP TABLE x` · `$(rm -rf ~)` · `` `id` `` · `a\nB` / `\r` / `\0` · `&& evil` · `| evil` · `--help` / `-h evilhost` / enum `['-h']` / enum `['-c']` / integer `-1` · `../../etc/passwd` · `/abs/path` · `x; SELECT 1` · enum value outside list · integer out of range · 64th-char overflow · `{{slot}}` literal smuggled as slot value (caught by post-substitution re-match) · `COPY x TO ...` as `statement` · second statement in `statement` · `$1` placeholder in `statement` (G4) · `-c`-shaped or URL-shaped slot values.

### Transport (explicit, F3)
- MCP and service are separate processes: the service holds the single-writer lock (`src/main.ts:12`); MCP reaches it via loopback HTTP bearer `serviceRequest` (`src/connection.ts:21-31`), which passes server error text through (`src/mcp.ts:23-29`) — hence every service-emitted local-tool message is safe-listed. ALL gate/registry/execution/quarantine/activity writes happen in the service process; the MCP process never touches `local-tools/` files (no racing by construction).
- `POST /api/workspaces/:id/local-tools/call` — strict body `{tool: name-rule, inputs: record ≤5 keys}`; unknown workspace → existing `Workspace not found. Register it first.`; MCP role allowed directly; dashboard role additionally requires canonical origin + intent `call-local-tool` (mirrors `src/http.ts:360-373`); `request.setTimeout(40_000)` for the psql class; response is the bounded masked result; activity `local-tool-call` recorded in-process, counts-only. Malformed body → `Local tool call is not valid.`; translated-schema failure → `Local tool inputs are not valid.` (never raw zod — G3).
- `GET /api/local-tools/status` — global registry snapshot `[{name, status: active|pending|quarantined, available, reasonCode?, origin, createdAt, useCount, lastUseAt?, consecFailures, quarantinePending?}]`; MCP + dashboard read roles; never records activity (mirrors activity/run read rules). Both routes added to `mcpMayCall`.
- MCP startup: `serviceRequest('GET /api/local-tools/status')` then `registerTool` per `active` entry (+ always-on `local_tool_status` with strict empty-object schema, `readOnlyHint:true`); service unreachable → status tool only. No file watcher: service rescans at startup + on status calls (+ per-invocation canonical re-resolution only).

### Call-time error vocabulary (closed, G3)
Every message the call path can emit, and nothing else. New messages (3) join the `http.ts` safe allowlist; the rest are pre-existing listed messages:
- Unknown/inactive tool name, or registration dropped between `listTools` and call → `Local tool is not available.` (NEW — covers unknown, `pending/`, `quarantined/`, never counts toward quarantine.)
- Call body fails the strict route schema (bad tool-name shape, non-object inputs, >5 keys) → `Local tool call is not valid.` (NEW — thrown before any tool lookup.)
- Inputs fail the translated per-tool strict schema → `Local tool inputs are not valid.` (NEW — the `ZodError` is caught at the translation boundary and replaced; raw zod text/paths never leave the server. Caller error: counter untouched.)
- Canonical re-verify fails at run → existing `PostgreSQL client is unavailable.` (caller-environment, counter untouched.)
- Delegate probe/connect-stage failure (bad database/role, server down, superuser refusal, connect timeout; `stage: 'connect'`) → the delegate's existing safe messages (`The database query failed without returning rows.` / `Superuser database roles cannot be used for read-only queries.` / `PostgreSQL client is unavailable.` / `The database query did not finish within the bounded runtime.`). Caller error: counter untouched (G5).
- Delegate query-stage failure (`stage: 'query'`) → same existing messages. Tool-defect candidate: THE ONLY path that increments the quarantine counter.
- Unknown workspace id → existing `Workspace not found. Register it first.`
Test obligation: every bullet above is exercised with a stubbed/capturing run and asserted to yield exactly its listed message.

### Persistence / registry
- `pending/`: never-active files awaiting gate; `active/`: gate-passed; `quarantined/`: runtime-disabled + `<name>.reason.json` (≤1KiB). Transitions are atomic renames; in-memory registry swaps atomically; a file is either fully registered or absent.
- Reason sidecars use a CLOSED vocabulary (F9): `{code: gate-shape|gate-executable|gate-inputs|gate-limits|gate-provenance|gate-description|runtime-failures, at, failures?, exitCodes?}` — counts/codes only, never stderr text, never slot values.
- `stateSchema.strict` untouched; no migrations; dynamic counters (useCount, consecFailures, lastUseAt) in-memory only + derivable from `activity_list`; static provenance in-file.
- Dir via `ensurePrivateDirectory` (`0700`); total ≤20 tools × 8KiB.

### Shared callers / routing
- MCP `registerTool` per active declaration; names cannot collide with built-ins (gate prefix rule). MCP role model unchanged; dashboard needs no new views (status is MCP-readable; dashboard read role exists for future use). No file watcher.

### Scaffold skill contract (not the skill text)
- Inputs: ≥3 observed raw-command repetitions (activity entries / transcript pattern) + originating draft basename + desired name/description/slots.
- Outputs: exactly one JSON file ≤8KiB at `<OPENWORKSPACE_HOME>/local-tools/pending/<name>.json`; never writes `active/` or `quarantined/`; never edits the allowlist source; `executable` must name a compiled class (never a binary — G1 confusion case refused).
- Refusals (must not draft, must explain which rule): secret-shaped values; multi-step chains (`|`, `&&`, `;`); executables outside the compiled allowlist; path/shell/free-text slots; >5 inputs; description violating the F5/G6 patterns (fences, links, URLs, imperative/prompt patterns); any statement beyond a single fixed SELECT-shape query with zero placeholders (psql class); forged or missing `sourceDraft` link.

### First-tool declaration (fixed, F6, G1)
```json
{
  "name": "db_tables",
  "description": "List public-schema tables of a local database over a read-only socket connection.",
  "executable": "psql-fixed-select",
  "slots": { "database": { "kind": "identifier" }, "role": { "kind": "identifier" } },
  "statement": "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  "caps": {},
  "provenance": { "origin": "handwritten", "createdAt": "2026-10-03T00:00:00.000Z" }
}
```
Gate walk-through: envelope strict OK; name/description OK (no fences/links/URLs/imperative patterns); `executable` names the compiled class (a bare `"psql"` would fail step 6 — G1); slots exactly the class spec; statement passes `bindParams(statement, [])` (no `$`), `singleStatement` (no `;`), `checkShape` (`SELECT`), `checkDenied` (no denied token outside literals); caps default `maxRows: 50`; provenance handwritten needs no draft; probe resolves the class's owned binary to a canonical `psql` + `--version` ≤5s. Runtime: `runDatastoreQuery(roots, {database, role, sql: statement, maxRows: 50}, {executablePath: canonical})` → superuser probe → `BEGIN READ ONLY; SET LOCAL statement_timeout = '8s'; <statement>; COMMIT;` → masked bounded rows.

### Security boundary
- Trust boundary: declaration files are untrusted data (agent-writable) — the compiled allowlist class + gate + closed classes + server-owned argv are the boundary, not file authorship. Human-only allowlist extension; agent can never add executables, flags, TCP options, or shell.
- Descriptions are untrusted data (F5/G6): server-prefixed presentation (`Local tool <name>: …`), gate pattern refusals (bounded, non-exhaustive), description-field-only rendering (tested); a hostile description cannot alter instructions, prompts, SQL, or argv because the handler never reads it. Residual model-context visibility is explicitly accepted; confinement is the control.
- Provenance origin is informational with zero trust weight (F10, explicitly accepted): both origins gate identically; the only enforced link is `sourceDraft` basename + existence.
- Secrets: no secret-shaped fields exist in the envelope; socket-only passwordless (parity with M1 DB policy); `-h`/`-p`/password/URL flags absent from all server argv; output passes `maskSecrets`; activity holds counts only.
- Rollback: delete/rename files + restart (or service rescan; MCP restart per E1 if needed); quarantined tools stop immediately (in-memory drop before rename completes); no state repair needed since schema untouched.

### Runtime ownership
- No new processes, ports, watchers, or locks. Bounded CPU: gate ≤ (20 files × parse) + 1 probe ≤5s per tool at startup; per-call cost = one `runDatastoreQuery` delegation within class caps. No concurrency cap in v1 (MCP calls already serialized per client); documented for revisit if parallel agents emerge.

## Decision Authority and Open Questions
- Fixed: solo-local scope; declarations-only (never arbitrary code); no declaration-supplied argv in v1; declarations name classes, never binaries (G1); reuse `runBoundedCommand`; `stateSchema.strict` untouched; secret blindness; dashboard secondary (no v1 views); no marketplace/discovery; bridge-to-drafts handoff point only (`pending/` + `sourceDraft` link, bridge itself out of scope).
- Delegated: exact constant values within stated ranges; test file layout; reason-JSON field names; probe timeout ≤5s; status-field naming.
- Unknown:
  - **E1 (bounded experiment, owner: implementer):** does MCP SDK `registerTool` after `connect()` propagate to an already-connected stdio client (`tools/list` reflects the new tool)? Procedure: temp harness, register-then-list, one retry. Decision rule: observed update → MCP process may rescan on a timer/status call; no update → documented MCP-restart-required for newly gated tools, status reports `restartRequired:true`. Stop after one harness session either way. Service-side gate/rescan works regardless. (ASSUMED interim: MCP-startup registration suffices; hot-plug is a bonus.)
  - **E2 (reversible, owner: implementer):** stub-`psql` fixture fidelity for `-f -` stdin framing. If unfaithful, acceptance falls back to injected-runner argv assertions + real-binary-absent unavailable proof. No product decision hides here.
- Residual risk recorded, no fix required (G7): parent-directory TOCTOU between canonical re-verification and spawn (a PATH dir component renamed after verify). Solo-local minor: the attacker and victim are the same user; per-run re-verification already shrinks the window to microseconds; accepted.
- No blocking product/safety questions remain: the hard safety choices (server-owned argv, closed classes, universal no-leading-dash rule, canonical-path spawn, fixed statement, staged failure classification, gate-pass=active for solo-local) are decided above.

## Final Validation and Review
- Fixed `db_tables` declaration gates clean → startup scan log + `local_tool_status` shows `active/available` (stub PATH) and `active/unavailable` (empty PATH); `"executable": "psql"` variant fails step 6 (G1 regression).
- Negative matrix (Template safety above, ≥19 cases) → all refused pre-spawn; injected runner records zero spawns; each yields a listed safe error.
- Gate-refusal matrix (Milestone 2, ≥16 cases incl. enum `['-h']`, `$1` statement, fenced/imperative description, forged draft, class/binary confusion, 21st tool) → correct file placement (`pending/` vs `quarantined/`) + listed safe errors; G2 shared-construction + capture tests green.
- Quarantine + classification: 3 consecutive stubbed QUERY-stage failures → `quarantined/` + closed-vocabulary reason sidecar + `local-tool-quarantine` in `activity_list`; probe-stage failures, caller-side refusals, and run-time unavailable do NOT increment; success resets; human-move-to-`pending/` re-gates to active. Every Call-time vocabulary bullet asserted to its exact message.
- Owned-fixture proof: temp `OPENWORKSPACE_HOME` + stub-PATH `psql` happy path over a real HTTP service + real stdio MCP session; empty-PATH honest-unavailable proof; all fixtures removed; no ResAI/real project touched.
- `pnpm typecheck:backend` + full `pnpm test` green (datastore message strings byte-identical despite staged errors); no frontend diff; `listTools` byte-delta note recorded.
- Review level: **security-boundary review required** (execution model, trust boundary, canonical-path confinement, transport, staged classification, safe-error containment) — this is the most consequential risk; reviewer re-runs the negative matrix against final code.

## Risks and Rollback
- Risk: declaration output (table names) contains hostile text → mitigation: `maskSecrets` + inert-display-only (never re-executed, per datastore precedent) + output caps; rollback: quarantine the tool.
- Risk: slot-class oversight admits a dangerous byte → mitigation: classes reviewed explicitly; universal no-leading-dash + post-substitution re-match; rollback: tighten class, re-run matrix (data files need no migration).
- Risk: well-formed-but-wrong database/role repeatedly fails at probe stage (G5) → accepted bounded self-DoS: solo-local caller is the user/their agent, quarantine is fail-closed and visible, recovery is one human file move; probe failures never auto-quarantine by design. No code fix; rationale recorded here.
- Risk: canonical-path check rejects a legit user-installed `psql` (odd ownership/perms) → mitigation: honest unavailable with reason code, not a crash; user fixes perms or PATH; rollback: none needed (fail-closed default).
- Risk: MCP context bloat per tool → mitigation: server-prefixed desc ≤200, ≤5 keys, no examples/describe, no instructions change, ≤20 tools; rollback: lower active cap by policy.
- Risk: agent spams `pending/` with junk → mitigation: 20-file cap, gate rejects fast, files are visible in status; no auto-promotion path except passing the gate.
- Rollback (global): remove `local-tools/` + revert registration block and the two routes; `stateSchema` untouched so no state repair; restart restores pre-feature behavior.

## Appendix: listTools byte-budget note (M2)

Measured 2026-10-03 over a real stdio MCP session against a temp service
(`measure-listtools-budget.ts`, one-off, removed after the run): `listTools`
JSON is 12,497 bytes with no declared tool and 13,169 bytes with `db_tables`
active — a **672-byte delta** for one tool (671-byte entry: server prefix +
description + 2-key strict schema, plus the array comma). Base MCP
instructions are untouched. At the 20-tool cap the worst case adds ~13.4KiB
to a ~12.5KiB baseline — no truncation concern at this scale; if tool count
ever grows, lower the active cap by policy instead of changing the transport.
