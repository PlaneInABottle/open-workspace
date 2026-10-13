---
name: openworkspace-development
description: Develop and verify OpenWorkspace itself across its local service, companion CLI, MCP bridge and dashboard. Use for platform changes and project-local QA, not onboarding a user's application or operating its real services.
---

# OpenWorkspace development

Follow [the development guide](../../../AGENTS.md) for canonical commands, safety and knowledge ownership. Read [the roadmap](../../../ROADMAP.md) only for the affected decision or scope. Do not replay the whole roadmap or pull in later scope implicitly.

## Preflight

Identify the changed boundary: CLI/bootstrap, core operations/state, MCP or dashboard. Read its actual implementation and nearest tests. Record allowed files and existing runtime ownership in the session. A registered application such as ResAI or Chatwoot is not an authorized edit/test target.

## Development loop

1. Define the smallest observable acceptance scenario and its denial/preservation case. UI and MCP must reach the same workspace state; no second implementation of an operation.
2. Implement the bounded change. Keep an existing implementation owner through edit/test/fix. Use specialized UI, MCP or security guidance only for the affected surface; a skill does not expand the role's authority.
3. Run the affected native tests/static checks from `AGENTS.md`. Reuse unchanged PASS evidence. A passing handler unit test is insufficient for changed bootstrap, CLI or transport behavior.
4. At the behavior boundary, exercise the actual local interface described below. Report observed results and unimplemented boundaries separately.
5. Milestones are pilot-pulled (L4): a milestone lands only on evidence pulled from a real run, never on implementation claims — record the evidence with the change or it didn't happen.

## Actual interface checks

**Launch/connection:** in an owned dummy Java-only directory, verify the source companion starts its own runtime rather than that project's package manager. Test state-directory identity, paths with spaces/apostrophes, headless suppression and a nonfatal opener failure. Normal startup opens only a secret-free URL, and the real browser creates a dashboard session only after the Connect consent action; there must be no key/password/terminal-copy step or legacy `pair` command. Cover exact canonical Origin/Host/fetch metadata, any-Authorization issuance denial, expiry/revocation/restart and raw MCP credential scope. A Node binary invoked by absolute path is not proof of a Node-free installation.

**MCP + registration:** create owned repositories under unrelated parents, include same-basename roots and a symlink trap, and register a named project with `workspace_register({name, roots})`. A wrapper can be tested additionally, never as the only assumption. Prove inspection of an unregistered project is denied, register that exact root list through the dashboard or MCP, then inspect every root group via the configured stdio client. Expect exact components and honest unconnected/unchecked states. A synthetic `.env` sentinel must not be returned and the linked external component must not be discovered. Registration reads bounded metadata immediately; there is no propose→approve queue for reads. Dangerous operations are authorized by the client's own permission model, and the dashboard keeps an audit log, never a gate. Execution-safety guards stay regardless: symlink/redirect rejection, output caps, timeouts, no secret-file reads, loopback-only HTTP.

**Local declarative tools:** declarations are untrusted data. Server-owned argv is built only via the shared `psqlArgs` constructor — no declaration field reaches argv. Slot kinds stay closed with a universal no-leading-dash re-match after substitution. Resolve the owned binary to a canonical path (resolve→realpath→verify→probe); an unverifiable binary is honest-unavailable, never a bare-name fallback. Classify delegate failures by stage (`connect` vs `query`) with byte-identical messages, contain every new message in the safe-error allowlist, and leave `stateSchema.strict` untouched.

**CLI verbs (read-only, redaction, containment):** prove a read-only verb by trace (no write/spawn on the path) plus a byte-identity check on the artifacts it claims not to touch. Compose summaries only from existing readers; a new collector inside a rendering verb re-opens the secret boundary. The redaction order is fixed — secret mask → absolute-path fold → short-8 for revs/digests → fence neutralization — and the whitespace-token masker never runs over compact JSON: parse first, walk values, re-stringify (wrong order silently corrupts structure while still exiting 0; seen: a `token-check`-shaped value broke a preflight fence). Fenced blocks are always valid JSON or absent — an absent section emits a plain line, never a fenced `json` wrapper around placeholder text. Trace/span shapes are semi-sensitive: mask or exclude by construction, and keep each documented claim equal to what the code guarantees. A digest/summary covers every witness-relevant field or names its exclusion on the same line. File-writing flags validate the target before any tmp creation, refuse `.`/empty/directory/symlinked-parent targets through realpath containment, and echo basenames only. A flag accepted by one verb exits 2 on every other verb — never a silent no-op that still performs the action (seen: `down --bundle` executed stop).

**Verb dispatch and landed-state contracts:** every `COMMANDS` entry needs a dispatch test that reaches its own handler with its claimed output shape; a documented verb that falls through to a sibling is a high-severity defect (seen: `timeline` dispatched as `show`). When a milestone lands, sweep its "pending"/"not yet supported" claims out of docs, help text and refusal strings in the same change. Refusal tests assert the contract marker plus a positive control — a bare exit-code assertion stays green under broken routing (seen: INERT refusal test).

**Process ownership (L1):** a listener on a forked child still belongs to the recorded launcher — prove descent (ppid chain + `lstart` match, bounded hops, cycle-safe) before calling a port foreign or a pid stale; an unprovable claim stays a legacy exact-match, never an ownership verdict. Never kill a holder on an UNVERIFIED claim (seen: mvn/node-style `sh -c '… & wait'` flagged `foreign-port`).

**Identity before compare (L3):** compare build/digest identity (sidecar vs recorded vs live) before concluding staleness; shorts on the wire, full digests never in output.

**Doc==code for flags (L5):** every documented flag/token is grepped against `--help` and its emitter; a flag accepted by one verb exits 2 on every other verb — fail-loud, never a silent no-op that still performs the action (seen: `down --bundle` executed stop).

**Migration/native selection:** use a synthetic v1 state fixture with registered records; prove ID/value preservation, no filesystem discovery or scope widening, idempotent upgrade and byte-preserving failure. Exercise create-project drafts, cancel/unavailable picker responses and manual fallback without registering implicitly. Native JXA compilation and injected result paths are not proof of an observed OS chooser. Do not bypass macOS privacy/automation controls to fill that gap. Restore controlled picker-response mocks before cleanup and identify those results as fake while registration/discovery remain real.

**Dashboard:** build the frontend and test the Node-served production bundle, not a Vite dev/preview server. Keep one named Chrome session through the flow, preserve launch settings and inspect fresh refs before mutation. Use the actual generated configuration and copy controls, not a hand-written approximation. Check errors, input preservation/focus, first-action hierarchy, URL/reload/back and narrow-screen access. Reserve an explicit desktop/narrow axe result for every pairing, empty/populated projects, AI setup and privacy view before teardown; a missing cell is not a PASS. Inspect CSP errors and manually classify incomplete audit items. A screenshot, no body overflow or a clean automated scan alone does not prove the best UX or full WCAG compliance. Keep secrets out of browser command arguments, raw logs and screenshots; use the private/redacted QA path in `AGENTS.md`.

**Browser state:** prove post-mutation reconciliation when registration/removal overlaps a deferred refresh. Reconnecting, current-session 401 and a newer selection must invalidate stale results. Include a same-origin service rebound with a different isolated state directory when the auth/client-state boundary changes; old inventory, UUID prompt and configuration must not survive as the new session's data. Logout revokes only the captured old session and must not clear a newer connection when its response arrives late.

**Refresh continuity:** a successful functional request does not prove smoothness. For a background refresh of the same still-authorized project/session, keep the existing inventory mounted, retain its height and scroll context, and keep the updating indication active until the follow-up inspection finishes. Test with deferred reads; do not replace existing content with an initial-loading screen or add a motion library to mask the reset. Identity, selection and confirmed authorization changes must still clear old data immediately. All-projects navigation must invalidate pending selection responses so an intentionally cleared selection cannot return.

## Recovery and result

Classify application vs CLI/harness failure before retrying. Change the relevant condition or hypothesis; never weaken an assertion, bypass confirmation, alter a pilot's toolchain or reinstall global tools just to obtain PASS. Stop if the next action needs a real credential/provider, shared mutation or changed product/security contract outside scope.

Return changed files, actual checks/results, the environment and real/fake boundary, concrete UI observations and remaining failures. No separate evidence.md is required. Save a repeatable rule in its existing owner; make a regression test for a demonstrated repeated failure when practical.

## Cleanup

Remove the owned dummy registration through MCP or the dashboard, prove subsequent MCP access is denied, and preserve all prior registrations. Only then delete the owned fixture and close the named browser/MCP clients. Stop only task-owned disposable services; retain an explicitly handed-over preview. Do not retain session/MCP tokens, browser storage or HAR captures as test artifacts.

## Shell-log flake diagnosis (dev-only)

Join the opencode shell-observer log at `~/.local/share/opencode-shell-log/shell-events.jsonl` with run summaries by timestamp and workdir. Grep for `exit!=0` lines, duration outliers, and retry shapes (repeated identical commands). Join rule: match a verification run's timestamp within a small window and the same workdir. Honesty note: correlation is not causation, and an empty log proves nothing — the run may have bypassed the observer or never shelled out.
