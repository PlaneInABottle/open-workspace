---
name: ow-prepare-local-runtime
description: "Prepare a task-owned local runtime for a new checkout: pick real services vs test fakes, verify toolchain, start owned processes, prove readiness. Not for ready checkouts or releases."
---

# prepare-local-runtime

New checkout or new task, local runtime unknown. Reuse what is healthy and
owned; build the minimum that proves the task's acceptance — never the whole
platform. Keep task-specific fakes in tests; state readiness limits honestly.

## Trigger / non-trigger

Trigger: a fresh checkout, a new worktree, or a task whose services are not
provably running. Non-trigger: an analysis-only or read-only request, a
routine test invocation on an already-ready checkout, a release, or anything
touching shared data, schemas, deployments, real mail/booking, or providers.
Those need their own authority; this skill grants none of it.

## Prepare

Read the project's authoritative agent instructions and existing runtime recipe
first. Reuse its declared lifecycle; do not start a second supervisor beside it.

1. **Choose real vs fake from acceptance.** Start only the services the
   task's acceptance actually needs. If an existing test fake already covers
   the claim, run it as-is — do not prepare a runtime to re-prove it, and do
   not claim a fake proves provider behavior.
2. **Check prerequisites, fail fast.** Selected toolchain/interpreter
   resolves (project's own version manager first), sources are the expected
   checkouts at expected revisions, and the project's native commands exist
    (package/test/start, migration runner). Missing toolchain, unknown
   external dependency, or anything needing approval beyond this task:
    BLOCKED with the exact gap — never an hours-long install campaign.
    If recurring steps lack an entrypoint, add a small project-local sequencer
    over those native commands; do not build a service catalog or copy another
    project's environment script.
3. **Own the runtime surface.** Task-owned ports (verify the listener before
   binding; never take a foreign one), task-owned state dir (0700/0600),
   env links through the canonical procedure — never copy secret values.
   Reuse a healthy owned instance when its source fingerprint (tracked
   edits *and* untracked inputs) still matches; rebuild only on change.
4. **Use OW where it fits, native owners where they own.** Supervise app
    processes with `ow up/down/restart/logs` plus readiness waits when OW is
    the selected lifecycle owner. Database
   engines stop through their established native owner: verify the
   engine's graceful stop first — if the supervisor's default stop is
   unsafe for a connected engine (seen: smart-shutdown wait expiring into
   SIGKILL and crash recovery), stop it natively instead. No new stop
   feature, no migration DSL, no second process manager.
5. **Migrations stay with their owner.** The service that owns a schema owns
   its migration runner; validate (names, checksums, drift) through that
   runner, fail closed on mismatch, and retain data — never reset a
   database to make green. A read-only check must not perform DDL; if the
   native validator needs a writable path, say so instead of forking a
   custom validator around it.
6. **Prove READY, then stop.** Real probe through the real interface (a
   listening port is not SQL proof; SQL proof is not behavior proof) plus
   the smallest test that exercises the claim. Record one evidence
   ledger entry (fixture, toolchain, provenance, observed result) in the
   existing report — no new trial/checkpoint framework. Stop and remove
   only task-owned processes and data; verify foreign listeners, shared
   ports and sibling checkouts are untouched.

## New-feature fakes (when the task adds one)

Write the fake against the real production consumer, owned by the same
task: expected calls succeed, unexpected calls fail closed, no external
fallback. A fake proves test-scenario behavior only — isolation is not
provider proof. Keep it in the test tree, never in the runtime helper.

## Setup note

The `ow` binary and this skill install separately: downloading the binary
does not install skills. Skill install is a copy the user's own agent
performs through the `setup-ow` skill into project-local paths, with
human approval before every write.
