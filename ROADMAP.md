# OpenWorkspace — direction

Make existing development work easier, without requiring a second test framework
or evidence system. Strengthen useful capabilities and simplify or remove those
whose maintenance and usage cost outweigh their demonstrated benefit.

## Working loop

Realistic trial → identify concrete benefit and friction → fix or simplify →
build and identify the new artifact → repeat the original check.

Passing tests prove correctness, not usefulness. Do not invent time savings or
add a feature merely to make another feature testable. Development and safety
constraints remain in [AGENTS.md](AGENTS.md).

## Next decisions

The previous speculative backlog is cleared. Add only selected, evidence-backed
simplification steps here, with the observed problem, intended reduction in work
and the real-world check that will establish the result. Keep incident details
and test output in their existing findings and task artifacts.

- **Proven: a `prepare-local-runtime` consumer skill.** The ResAI trial
  repeatedly rediscovered checkout prerequisites and native service startup;
  the helper experiment passed (fresh-worktree prepare/reuse/cleanup,
  independent feature-fake trial, reviewer-APPROVED) and the procedure is
  now distilled into short `skills/prepare-local-runtime/SKILL.md`: an AI
  reuses project-native commands, writes a thin local helper only where
  repetition warrants it, and uses OW for lifecycle rather than creating
  another process manager. Task-specific fakes stay in tests; readiness
  limits stated. Validated against a different shape (stdlib-only Node
  fixture + OW manifest: prepare → real probe/test → reuse same pid →
  negative BLOCKs → owned-only down; evidence in
  `.ow/trials/v2.3-draft-preparation/prepare-local-runtime-skill-evidence.md`).
  Bounds: one language/one service/no DB re-proven here — DB/native-owner
  lessons carried from the ResAI experiment; no ResAI paths, secrets,
  service catalog, dependency graph, new OW verb, or release machinery.
  Distribution verified via generated packs, not assumed from the binary.

## Evidence-backed decisions

- **Keep the runtime and log core.** Real local trials demonstrated checkout and
  drift visibility, owned lifecycle control, and useful log filtering. Validate
  each fix on a newly built artifact against the original real-world failure.
- **Remove the checkpoint/scenario evidence-wrapper layer.** Reader correctness
  passed synthetic tests, but no native producer or real recovery benefit was
  demonstrated, and the 880 pilot required an adapter plus separate checkout
  proof without net benefit. The `checkpoints`, `failures`, `scenarios`,
  `record`, `contract` and `scenario` verbs, their file readers, the overlay
  convention and the data-clock witness are removed (breaking change); legacy
  `.ow/checkpoints/`, `.ow/replay/`, `ow.scenarios.yaml` and overlay files
  already on disk are left byte-identical in place — removals cover commands
  and APIs, never user data. No replacement evidence framework.
- **Remove embedded tracing.** The OTLP collector/listener/decoder/span store,
  the `trace` verb, `timeline --trace` merging, the `trace:` config block,
  `init --tracing` and the tracing skills/recipes are removed (breaking
  change); legacy `.ow/traces/spans.jsonl` files already on disk are left
  byte-identical in place and never read. The session-only `timeline`
  (agent rows), text redaction of trace-shaped values, and all runtime,
  readiness and ownership behavior stay.
- **Go CLI-only.** The Node dashboard/MCP service, its HTTP routes, the
  source companion, the frontend, and their configs/dependencies are
  removed (breaking change); the `ow` CLI and the consumer skills are the
  product. Legacy user state (registrations, connection data, recorded
  runs, stored spans) outside the source tree is left byte-identical in
  place — removals cover code and docs, never user data.
- **Do not make scenarios a mandatory test wrapper.** Select a simplification
  only if it removes real work; no replacement evidence framework.
- **Start only the selected service on lockless `up <name>`.** `up <name>`
  with no live supervisor bulk-started every declared service, forcing a
  separate manifest/state-root workaround to prepare one service. Now the
  selection applies from initial startup (foreground, or detached with
  `-d` plus target-only `--wait`/`--health`; a failed initial wait stops
  what it started); bulk bare `up` is unchanged. Real-world check: two
  loopback services, `up A -d --wait --health` leaves B unstarted, later
  `up B` joins the live supervisor with A untouched.
- **Show honest session observation (additive only).** `show`/`meta`
  report the latest-observed session outcome from `session_v2`
  (`idle_outcome` + `time_idle`) beside the windowed record groups —
  never window-filtered, never a stale claim on null/unknown; grouped
  lines carry an evidence-accurate time range (first/last, per-run where
  the model allows) with monotonic-vs-wall domains labeled; failure
  labels separate task context from command-text reasons. All JSON keys
  additive; existing keys byte-identical. Real-world check: fixture DB +
  ring proving missing-status/timestamp/label baselines, then Bun
  unit/contract plus the real compiled binary.
- **Mask secret shapes on every observer analysis view (SECURITY).**
  The observation milestone left raw command echoes on record lines,
  drill-down variants and wire `variants[]` (fail-before: HIGH probe
  `token=hunter2` exposed on human/drill/JSON/tree). Now the shared
  `maskSecrets` redacts every caller-controlled text the analysis views
  emit (record/variant/intent/excerpt/task/context/meta free text, tree
  descriptions, refusal echoes, error-text warnings), mask-before-cap,
  compact JSON structurally (parse-first, values redacted, shape valid —
  never the old silent corruption). Stored sidecar/DB sources and the
  raw `--flat` record stream stay verbatim by design. SECURITY
  compatibility exception: JSON keys unchanged, but secret-shaped VALUES
  are intentionally redacted — benign commands/fields stay byte-identical
  (old-keys byte-equal contract holds for non-sensitive content only).
  Residual: service `logs` output streams owner data unmasked.
- **Unique drill refs + honest empty filters (behavior correction).**
  Per-group `[N]` refs reset per group, so later groups' lines were
  unreachable via `--show N` (fail-before: two groups each printing
  `[1]`, second unselectable); unmatched kind/tool filters printed the
  same `no records` line as a valid empty. Now `groupByTask` numbers
  lines 1..K uniquely in display order per response (human and wire
  share refs; every N selects exactly its line) and a kind/tool-filtered
  empty renders `no records … [filters: session=…, kind/tool=…]`
  (masked-then-capped; exact session match, no prefix search). Refs are
  ephemeral per query, never stored ids — intentional contract change:
  old per-group ref values are NOT byte-equal (single-line groups still
  start at 1); JSON keys/types/envelopes unchanged, pure-empty lines and
  `--json` unchanged.
