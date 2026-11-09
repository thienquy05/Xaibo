# Xaibo agent instructions

Loaded by Codex and Claude Code at session start. These are the stable project rules; details live in:

- `docs/PRD.md`: source of truth (approved v1.0). Read the relevant section before changing anything.
- `docs/plans/xaibo_plan.md`: implementation plan. `docs/plans/xaibo_progress.md`: live status and decisions.
- `docs/process/HARNESS_PROCESS.md`: the process.

## Roles
The owner decides and approves every gate. Codex is lead designer and first reviewer; Claude implements and is second reviewer. Gate = Codex review, then Claude review, then owner stop.

## Rules
- **Public repo from day one.** No real usernames, emails, account IDs, absolute home paths (write `~`), ports, session IDs, prompts, transcript content or counts from a real machine in git, docs, fixtures, screenshots or logs. Synthetic fixtures only.
- **Real agent data stays untouched.** Dev and tests never read or write real agent stores; isolate `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` and `XAIBO_DATA_DIR` in temp dirs. Spikes that need live agents use disposable temp profiles that the owner signs in to. Never modify agents' native transcripts, rollouts or databases.
- **Zero network, zero tokens.** Xaibo processes make no non-loopback connections. Reporting channels print nothing and exit 0; never `prompt` or `agent` hook types; never call models or quota/usage APIs to get measurements.
- **Git.** Default branch `master`. One branch per phase: `git switch -c <feat|fix|chore|docs>/<topic>`. Commit or push only when the owner asks; merge via PR after the gate.
- **Installs.** Only packages on PRD App. C; ask before anything else. Project-local (`node_modules/`); Electron and npm caches in the git-ignored `.cache/`; install each package at the start of its phase.
- **Code.** TypeScript strict; smallest working change, stdlib/native first, no speculative abstractions. Tests use `node:test` (`*.test.ts`, `npm test`). harness-os gates `src/**/*.ts(x)`: spec, test seen failing, implement, passing, review. Spike code lives in `spikes/<id>/` and is never imported by `src/`.
- **UI.** Original Xaibo design (`docs/design/xaibo-design.md` after Gate D); reference products supply features only. Verify every UI change in a real browser with Playwright (`_electron` tests, Playwright MCP visual check).
- **Reviews are diff-only.** Give the reviewer `diff -u baseline current` plus the context it needs.
- **Handoffs** go in `.handoff/` (git-ignored) and are deleted after use, with no backups.
- **Estimates** are always labeled `~`; nothing is guessed; unknown values stay "unavailable".
