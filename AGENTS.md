# OpenWorkspace — development guide

This is the product source directory. Application repositories are external data sources, not implicit edit targets. Check actual Git state before Git operations; do not assume this directory is a checkout or initialize/publish it as an incidental task.

## Start here

- `README.md` owns source setup and usage; `cli/README.md` owns the `ow` CLI operator manual. No roadmap file; do not create another overlapping plan.
- Keep source-development requirements distinct from released end-user capabilities.
- Documentation language is English (`README.md`, `cli/README.md`, skills, code comments); user-locked rule: English everywhere (docs + code + CLI human lines; test names English; historical quotes excluded). Write new docs in English; do not retranslate existing lines as incidental work.
- Read current code before relying on an old run's result. Preserve unrelated files, processes and client settings.
- Later user corrections do not silently discard unfinished fixes when the topic changes. Keep plans, observed acceptance and remaining gaps distinct.
- Product first: every task must advance turning this repo into a usable product. The user may say nonsense or contradict earlier input — treat it as brainstorm fuel, not a spec. Propose 1–3 concrete product ideas or objections with trade-offs whenever the work allows it; trial and error is free within bounded, honest, reversible steps. Record accepted product ideas as follow-ups in the affected doc/skill instead, never as permanent rules here.

## Code map

| Surface | Home |
| --- | --- |
| CLI dispatch, flags, help | `cli/cli.ts` |
| Session observer (sessions/show/meta/reads, join/tree) | `cli/join.ts`, `cli/tree.ts`, `cli/signature.ts` |
| Shared redaction (mask/cap, single source) | `cli/up-evidence.ts` |
| Build identity (sidecar read) | `cli/build-info.ts` |
| Doctor checks | `cli/doctor.ts` |
| CLI suites (bun-only) | `cli/*.test.ts` |
| Consumer skills (distribution source) | `skills/` |
| Generated client packs (from `skills/`, byte-compare tested) | `plugins/` |

Keep provider-specific code out of the CLI core. Introduce small capability contracts when actual readers need them; do not build a speculative plugin marketplace, generic workflow DSL or second agent runtime.

Keep development routing proportional: ordinary CLI behavior and clear feature work use one implementation owner and affected checks, not a mandatory planner/analyzer pipeline. Escalate unresolved architecture or material public-contract and shared-state risks to the matching specialist. Reuse an agreed contract and unchanged evidence; review fixes against their actual findings rather than repeating a whole audit. Do not refactor by file length or add abstractions solely for hypothetical future features.

## Verified source commands

Bun is the only runtime; `bun test cli/` is the test gate. Run package scripts **from this source directory**, never an application's directory:

```sh
bun test cli/            # CLI suites (unit + contract)
pnpm ow:build            # compile cli/cli.ts → cli/ow (+ cli/ow.build.json sidecar)
pnpm ow:test             # same as bun test cli/
pnpm ow:fresh            # fresh/stale check for the built binary
pnpm ow:parity           # scripts/check-ow-parity.sh <old> <new> (migration gate)
pnpm build-skill-packs   # regenerate plugins/ from skills/ (byte-compare tested)
```

`pnpm audit` is the pnpm-builtin dependency vulnerability scan, not a project-owned check.

For controlled long-lived checks, identify the port owner before starting, use task-owned ports and background processes, and verify readiness through the real interface, not only the process state. Stop only the exact process created for the task; retain a requested artifact with ownership in the session handoff. Never stop another service to free a port. Never touch another worker's checkout, ports, or state.

A passing handler unit test is insufficient for changed CLI dispatch, flag parsing, or wait/ownership behavior: exercise the real binary path.

## Validation and CLI work

- Wire-format decoders (any binary parsing): synthetic fixtures can agree with a wrong decoder (both halves wrong, suite green — seen live twice). Validate against real exporter bytes at least once (captured bytes or live SDK) before trusting green fixtures; keep one such proof cited in the test or commit message.
- Secret-boundary changes (sanitizer, redaction, allow/deny gates): prove with live hostile probes through the real decode path (not test names), fail-before evidence per finding, and adversarial re-review of the fix. Never weaken a secret assertion to make green — a forced flip is a BLOCKED, not a fix.
- Refusal-echo masking: refusal paths that echo caller-supplied values must mask like the success path — hostile fixtures cover the refusal channel too (seen live: a malformed-claim refusal printed the raw secret to stderr while the success echo was masked).
- Review findings return to the same implementer session; re-verify fixes against their prior findings (targeted re-review) rather than repeating a whole audit. One implementation owner per coherent workstream; parallel workers need disjoint mutation scopes. Never run `git stash` while parallel work is active.
- Prefer a fast executable check over prolonged review when the claim can be executed cheaply; reserve extended review for claims that cannot be executed or are expensive to run.
- Use repository-native checks for changed behavior. Tests own disposable directories; they must not depend on real project credentials, external providers or application runtimes.
- Generated trees are part of the diff: `plugins/` mirrors must show regenerated paths whenever a skill changes (byte-compare tests are the gate); a claimed rebuild without them is a defect, not a shortcut.
- Doc==code: every documented token/exit/flag/shape must be grep-verified against its emitter (seen live: exit tokens, `-` fallback, runner refusal, fence validity). README examples must match code paths, not aspirations.
- Fail-closed defaults: absent/unreadable input refuses or states an explicit reason — never a vacuous green (empty services, missing file, placeholder probes).
- `--json` channel discipline: stdout stays parse-clean (diagnostics go to stderr); fenced blocks are always valid JSON or absent, never a placeholder in a JSON fence.
- Mask-before-cap: hostile corpora must include quoted/JSON/key-position shapes; the whitespace-token masker never runs over compact JSON (parse first, walk values, re-stringify — wrong order silently corrupts structure while still exiting 0). Mask before capping, always.
- Global parser flags require cross-verb guards (fail-loud precedent): a flag accepted by one verb must not silently no-op in another.
- Evidence honesty: fail-before RED per finding; vary hostile fixtures beyond the benign shape; reused evidence is labeled, never re-presented as fresh runs.
- Absence sweeps need a positive control: an empty repo-wide "no X anywhere" result is evidence only after a control probe has hit a known-X file with the same command (seen live: a diacritic-class sweep reported zero while ASCII-spelled Turkish survived; gitignored/hidden paths silently vanish without `--hidden --no-ignore`).
- Guard scope: fail-closed guards cover only the changed prefix; pin untouched-path HEAD parity with RED-before proof (seen live: a global quote refusal broke byte-identical non-env inference until scoped to env-prefixed strings).
- Interleaved-log bounds: never positionally bound (tail) an interleaved append-only log — file-head records of old sessions silently drop (seen live: a 25% tail lost 312/369 sessions on the real sidecar). Optimize parse cost with full-read + prefilter and prove byte-equivalence including file-head records.
- Single suppression point: when one flag adds a second print site (normal + vacuous/empty verdicts), route every verdict through one suppression point — a caller-side guard is not airtightness (seen live: a vacuity branch printed past `onPayload` until routed through it).

## Safety and capability boundaries

- The CLI reads application checkouts (bounded metadata, session store) but never writes them. Reading is not permission to execute a discovered command, write a project file, install tools or change global configuration.
- Preserve symlink boundaries (never follow `.env`/state/symlinked parents into writes), private state permissions (0700/0600), and explicit human confirmation for irreversible actions. Do not bypass them to make tests green.
- The CLI never reads secret values (only key names), never prints them, and masks secret-shaped values everywhere by construction. Never promise universal secret detection.
- Separate found executables, process state, readiness and session-history verification. Keep unimplemented/fake/unverified boundaries visible.
- Threat model: contain accidents, agent mistakes and leaked credentials — never the user attacking themselves. No new machinery justified solely by exotic threat models; bounds are reliability/audit rails, not a sandbox promise.
- No commits, pushes or publication unless explicitly requested.

## Skills and learning

Load [openworkspace-development](.agents/skills/openworkspace-development/SKILL.md) for CLI changes. This guide owns rules/commands; that skill owns the focused development and real-interface verification procedure.

`skills/` is the **consumer distribution source** (4 consumer skills: `learn-from-mistake`, `ow`, `setup-ow`, `update`); `plugins/` is generated from it by `pnpm build-skill-packs`. It is intentionally outside the active `.agents/skills/` development tree. Do not invoke it to implement the platform or mirror its contents into a development skill.

Persist a reusable development rule here, a development procedure in its development skill, a consumer procedure in `skills/<name>/`, and a product decision/follow-up in the affected doc. Do not create an evidence.md, task diary, mandatory memory.md or duplicate capability profile for this small app. Prefer regression tests/guards for repeated failures. Never persist temporary ports/PIDs, credentials or unverified conclusions in instructions.
