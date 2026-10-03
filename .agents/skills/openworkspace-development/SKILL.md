---
name: openworkspace-development
description: Develop and verify OpenWorkspace itself across its local service, companion CLI, MCP bridge and dashboard. Use for platform changes and project-local QA, not onboarding a user's application or operating its real services.
---

# OpenWorkspace development

Follow [the development guide](../../../AGENTS.md) for canonical commands, safety and knowledge ownership. Read [the roadmap](../../../ROADMAP.md) only for the affected milestone. Do not replay the whole roadmap or start later milestones implicitly.

## Preflight

Identify the changed boundary: CLI/bootstrap, core operations/state, MCP or dashboard. Read its actual implementation and nearest tests. Record allowed files and existing runtime ownership in the session. A registered application such as ResAI or Chatwoot is not an authorized edit/test target.

## Development loop

1. Define the smallest observable acceptance scenario and its denial/preservation case. UI and MCP must reach the same workspace state; no second implementation of an operation.
2. Implement the bounded change. Keep an existing implementation owner through edit/test/fix. Use specialized UI, MCP or security guidance only for the affected surface; a skill does not expand the role's authority.
3. Run the affected native tests/static checks from `AGENTS.md`. Reuse unchanged PASS evidence. A passing handler unit test is insufficient for changed bootstrap, CLI or transport behavior.
4. At the behavior boundary, exercise the actual local interface described below. Report observed results and unimplemented boundaries separately.

## Actual interface checks

**Launch/connection:** in an owned dummy Java-only directory, verify the source companion starts its own runtime rather than that project's package manager. Test state-directory identity, paths with spaces/apostrophes, headless suppression and a nonfatal opener failure. Normal startup opens only a secret-free URL, and the real browser creates a dashboard session only after the Connect consent action; there must be no key/password/terminal-copy step or legacy `pair` command. Cover exact canonical Origin/Host/fetch metadata, any-Authorization issuance denial, expiry/revocation/restart and raw MCP credential scope. A Node binary invoked by absolute path is not proof of a Node-free installation.

**MCP + registration:** create owned repositories under unrelated parents, include same-basename roots and a symlink trap, and register a named project with `workspace_register({name, roots})`. A wrapper can be tested additionally, never as the only assumption. Prove inspection of an unregistered project is denied, register that exact root list through the dashboard or MCP, then inspect every root group via the configured stdio client. Expect exact components and honest unconnected/unchecked states. A synthetic `.env` sentinel must not be returned and the linked external component must not be discovered.

**Migration/native selection:** use a synthetic v1 state fixture with registered records; prove ID/value preservation, no filesystem discovery or scope widening, idempotent upgrade and byte-preserving failure. Exercise create-project drafts, cancel/unavailable picker responses and manual fallback without registering implicitly. Native JXA compilation and injected result paths are not proof of an observed OS chooser. Do not bypass macOS privacy/automation controls to fill that gap. Restore controlled picker-response mocks before cleanup and identify those results as fake while registration/discovery remain real.

**Dashboard:** build the frontend and test the Node-served production bundle, not a Vite dev/preview server. Keep one named Chrome session through the flow, preserve launch settings and inspect fresh refs before mutation. Use the actual generated configuration and copy controls, not a hand-written approximation. Check errors, input preservation/focus, first-action hierarchy, URL/reload/back and narrow-screen access. Reserve an explicit desktop/narrow axe result for every pairing, empty/populated projects, AI setup and privacy view before teardown; a missing cell is not a PASS. Inspect CSP errors and manually classify incomplete audit items. A screenshot, no body overflow or a clean automated scan alone does not prove the best UX or full WCAG compliance. Keep secrets out of browser command arguments, raw logs and screenshots; use the private/redacted QA path in `AGENTS.md`.

**Browser state:** prove post-mutation reconciliation when registration/removal overlaps a deferred refresh. Reconnecting, current-session 401 and a newer selection must invalidate stale results. Include a same-origin service rebound with a different isolated state directory when the auth/client-state boundary changes; old inventory, UUID prompt and configuration must not survive as the new session's data. Logout revokes only the captured old session and must not clear a newer connection when its response arrives late.

**Refresh continuity:** a successful functional request does not prove smoothness. For a background refresh of the same still-authorized project/session, keep the existing inventory mounted, retain its height and scroll context, and keep the updating indication active until the follow-up inspection finishes. Test with deferred reads; do not replace existing content with an initial-loading screen or add a motion library to mask the reset. Identity, selection and confirmed authorization changes must still clear old data immediately. All-projects navigation must invalidate pending selection responses so an intentionally cleared selection cannot return.

## Recovery and result

Classify application vs CLI/harness failure before retrying. Change the relevant condition or hypothesis; never weaken an assertion, bypass confirmation, alter a pilot's toolchain or reinstall global tools just to obtain PASS. Stop if the next action needs a real credential/provider, shared mutation or changed product/security contract outside scope.

Return changed files, actual checks/results, the environment and real/fake boundary, concrete UI observations and remaining failures. No separate evidence.md is required. Save a repeatable rule in its existing owner; make a regression test for a demonstrated repeated failure when practical.

## Cleanup

Remove the owned dummy registration through MCP or the dashboard, prove subsequent MCP access is denied, and preserve all prior registrations. Only then delete the owned fixture and close the named browser/MCP clients. Stop only task-owned disposable services; retain an explicitly handed-over preview. Do not retain session/MCP tokens, browser storage or HAR captures as test artifacts.
