---
name: setup-tracing
description: Wire OpenTelemetry tracing into a repo's ow.yaml per stack and prove spans flow. Ends with doctor span count plus one ow trace.
---

# Tracing setup

Wire opt-in distributed tracing for a repo supervised by `ow`, then prove
spans actually flow. End state is PROVEN (spans flowing), not files-written.
Exact `ow.yaml` blocks live in product `cli/README.md` ("İzleme tarifleri")
— copy from there, never from memory. This skill only routes per stack.

## Detect stack, write the trace block

Detect from project files (first match wins; mixed repos get one block per
service): `pom.xml`/Gradle wrapper → Java; `pyproject.toml`/`requirements*.txt`
→ Python (note `uv`- vs `pip`-managed venv: `opentelemetry-bootstrap -a
install` shells out to `python -m pip` and fails inside `uv` venvs with no
pip — skip bootstrap, install instrumentors with `uv pip` and run the venv's
own `opentelemetry-instrument` binary); `package.json` + Vite → browser.

Then:

1. Add the top-level `trace:` block (`port: 4319`; never 4318 — that is the
   dashboard port) plus per-service `env:` on ONE line each (the YAML subset
   reads line by line; a wrapped map fails `up --check` — warn explicitly).
2. Java: provision the agent jar by hand into `.ow/otel/` (manual download;
   never auto-downloaded); `doctor` reports present/absent. `-javaagent`
   resolves relative to the service `cwd` — use an absolute jar path when the
   service `cwd` differs from the `ow.yaml` root.
3. Browser (3-line essentials): use the `-otlp-proto` exporter package
   (`-otlp-http` sends JSON the receiver never decodes); point it at
   `/v1/traces` on the receiver; same-origin app calls avoid a backend CORS
   preflight that could strip `traceparent` (cross-origin backends must allow
   the `traceparent` header).
4. Pin `OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf` in every recipe (the
   receiver decodes protobuf only) and set `OTEL_METRICS_EXPORTER: none` +
   `OTEL_LOGS_EXPORTER: none` (the receiver serves `/v1/traces` only; anything
   else spams exporter errors into service stdout).

## Prove it

Run `ow up --check`, then `up`, exercise the app, and verify with `ow doctor`
(span count > 0) plus one `ow trace` (newest-first list or one span tree).
Zero spans with the block on: `doctor` prints the hint — check endpoint,
protocol pin, and exporter env before touching app code. Browser spans arrive
5–15s late in batches (`ow trace <id> --wait 15s` covers it). Local export
always targets the `ow` receiver; a remote backend (e.g. Langfuse) is a
separate exporter with its own endpoint/headers and a low export timeout so a
dead host cannot stall startup. Trace output is semi-sensitive (resource IDs)
— review before pasting into public issues.
