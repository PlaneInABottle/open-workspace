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
