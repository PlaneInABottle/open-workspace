---
name: update
description: Refresh installed OpenWorkspace command copies by re-reading checkout skills and overwriting stale snapshots. Runs only on explicit invocation.
---

# OpenWorkspace update

Run only when the user invokes `/ow-update` or re-pastes the setup prompt. Never auto-run, never nudge.

## Refresh installed copies

1. Re-read every `skills/<name>/SKILL.md` in the product checkout — all six (`learn-from-mistake`, `onboarding`, `ow`, `ow-debug`, `setup-ow`, `update`), this skill included. The source text is authoritative. Installed `ow-runtime` copies have no source: report them for removal under the same safety rules below, never refresh them.
2. Byte-compare each source text against the installed `ow-*` copies at this project's client paths (Claude Code project `.claude/commands/ow-<name>.md`; OpenCode project `.opencode/commands/ow-<name>.md`; Codex project `.agents/skills/ow-<name>/SKILL.md`; VS Code/Copilot project `.github/skills/ow-<name>/SKILL.md`), normalizing the `ow-` frontmatter name prefix. Report each skill as `current` (bytes match) or `stale` (bytes differ or copy missing).
3. Byte-identical → skip silently (leave the file alone). Tool-owned and locally unmodified but stale → overwrite verbatim at the same project-local paths and report the diff. A personal edit inside a snapshot file → show the diff and let the user decide before writing; never overwrite it silently. Every other file stays byte-identical.
4. Verify with `ow --version` (a free read), then hand off in 120 words or fewer: per-skill current/updated list, files written, verification result, next human action. Refresh runs no service, verify, or install operations — the free read is the whole verification.

## Safety

Project-local only; never write user-wide/global scope without a separate explicit ask. The setup prompt's AGENTS.md marker-block rule applies unchanged (replace inside markers only; idempotent re-paste). Tokens never in chat, repo, or config. Show the exact diff for any file write.

Delete installed `ow-*` copies to return to checkout-served prompts.
