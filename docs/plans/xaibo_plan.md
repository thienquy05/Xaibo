# Xaibo implementation plan

## 1. Header

| Item | Value |
|---|---|
| Status | **Approved v1.0 (2026-11-09, owner; D-P0-09).** Content is draft v0.3: Codex challenge (4 rounds, final verdict yes with fixes, applied) and Claude second review (progress §9b, applied). |
| Date | 2026-11-09 |
| Source of truth | `docs/PRD.md`, Approved v1.0. Phases from PRD §10, tests from PRD §9, "done" from PRD §1.6 and §9.3. Where this plan and the PRD disagree, the PRD wins and the plan is corrected. |
| Process | `docs/process/HARNESS_PROCESS.md` |
| Live status | `docs/plans/xaibo_progress.md` |
| Spike evidence | `docs/plans/phase0_spikes.md` (created by P0-T10) |
| Branch of this plan | `feat/phase0-spikes` |

**Owner decisions of 2026-11-09 (binding on this plan)**

1. Plan scope is the **full plan**: every phase is detailed now. Every PRD §9.2 edge-case row (EC-01..EC-105) is a required task, assigned to exactly the gate PRD §10 lists (traceability in §5).
2. Spikes that need live agent sessions (installed: `claude` 2.1.319, `codex-cli` 0.160.0, `gemini` 0.46.0) are run **by Claude** in disposable temp profiles (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` / `HOME` pointed at temp dirs under a git-ignored repo dir or the session scratchpad), with tiny prompts. The **owner signs in** to each temp profile the first time a run needs it. Real profiles are never written.
3. A **guard** records a local-only checksum manifest of the real agent config files before and after each spike session. Its output is never committed or pasted. macOS keychain credential sharing is checked before any temp sign-in.
4. **electron-builder moves from Phase 1 to Phase 0** (S1, S3 and S10 need a packaged app). Phase 0 installs `electron`, `typescript` and `electron-builder` at exact pinned versions; `better-sqlite3` only if S1 rejects `node:sqlite`. Machine: Node v26.10.0, npm 11.19.1.

**Standing rules (owner memory and PRD)**

- Installs are project-local only (`node_modules/`). npm, Electron and electron-builder download caches point at the git-ignored repo `.cache/`. Each package is installed at the start of its phase. Anything not on PRD App. C needs owner approval first.
- One branch per phase from up-to-date `master`: `git switch -c <feat|fix|chore|docs>/<topic>`. Commit and push only when the owner asks. Merge by PR after the gate.
- Every gate: Codex review, then Claude second review, then owner stop. Reviews are diff-only. Gate D exception: Codex authors, so Claude review then owner approval.
- harness-os pipeline for every unit of work touching `src/**/*.ts(x)`.
- The repo is treated as **public**: no real usernames, paths (use `~`), session IDs, ports, counts, prompts or account data anywhere in git. Fixtures are synthetic. Evidence from temp-profile runs is reduced to schemas and aggregates before it enters git.
- Ponytail discipline: the smallest working change, stdlib and native features first, no speculative abstractions.
- UI testing uses Playwright: `_electron` for E2E, Playwright MCP for a visual check on every UI change.

## 2. How to use this plan

### 2.1 Process steps (HARNESS_PROCESS §3 steps 4–8)

| Step | What happens here |
|---|---|
| 4 Plan | This file. Every unclear requirement is an open question with a default (§6), never a guess. |
| 5 Challenge | A second session (Codex, via the companion, on this file only after the privacy gate) looks for holes. Changes are noted in the progress file's decision log. The owner then approves the challenged plan. |
| 6 Implement | Phase by phase, task by task, in the listed order. Each task: test or check script first, observe it failing, implement, run the verification loop, debug before moving on, update the progress file. |
| 7 Review | At each gate (GS below). Correctness, performance, security, privacy. |
| 8 Finalize | The plan and progress file are updated with what was actually built and why. Commit only on the owner's word. |

### 2.2 Verification loop (HARNESS_PROCESS §5)

| Part | Loop |
|---|---|
| Service, store, adapters, scripts | `npm run lint && npm run typecheck && npm test` (node:test, `*.test.ts`); integration tests on synthetic fixtures; end-to-end runs on synthetic stores |
| UI | `npm run test:e2e -- <spec>` (Playwright `_electron`, packaged or built app, temp data) plus a **Playwright MCP visual check** (render, console clean, key flows) against a temp-data dev instance only, never a real-data instance (PRD §8) |
| Performance | `npm run perf -- <tier/metric>` on the seeded synthetic corpus; results recorded with hardware, macOS, app/agent versions, seed and actual DB/index sizes |
| Spikes | each spike's pass/fail check script, observed failing first; results reduced before entering git |

The loop runs after every significant change, not only at phase end.

### 2.3 harness-os pipeline per unit of work (HP)

Applies to every unit that touches the gated globs `src/**/*.ts(x)`. Config files and `scripts/`, `test/`, `spikes/`, `docs/` are outside the gate.

1. `run_workflow` with `new-feature`; `security-change` where a task says so (agent-config writes, sockets and auth, spawning or exec, network receivers, permanent deletion, MCP grants); `hotfix` for gate-review fixes.
2. `create_spec` (prefix `XAIBO`), `validate_spec`, `assess_risk`. Keyword-risk prompts are expected ("session", "token", "trust", "credential", "purge" are domain words): read the rationale and log the outcome with `record_decision`. A critical rating needs the owner's approval at the terminal.
3. Write the test, run `npm test` and observe it failing (RED is observed through `npm test`). Implement. Observe GREEN. `request_review`.
4. `npm run lint && npm run typecheck && npm test`, plus the affected `npm run test:e2e -- <spec>`.
5. UI changes: Playwright MCP visual check (render, console errors, key flows, light and dark once themes exist).
6. Update `docs/plans/xaibo_progress.md` with result, decisions and any PRD detail that was left open.

E2E-only and perf-only RED/GREEN results cannot be observed by harness-os; they are logged by hand (sanitized) in the progress file (OQ-X8).

### 2.4 Gate procedure (GS)

Used by every gate except Gate D (Claude review then owner approval).

0. **Pre-freeze run (working tree).** Run the step-1 suite in the working tree; `/ponytail-review` on the diff and fix what it finds; harness `validate_coverage`, `audit_report`, and `workflow_status` showing every unit finalized; `/graphify` refresh. Then fill in the progress file from this run: EC results, metric table (hardware, macOS, app and agent versions, seed, DB/index sizes), `record_decision` IDs, waivers, deviations, and the gate row's link to `docs/plans/gates/gate<N>.md`; add every new package to the dependency license list (license from package metadata). Nothing after step 1 edits the tracked tree except an accepted fix (step 4).
1. **Freeze and clean-checkout suite.** Every gate tests, reviews and approves one exact revision, the gate SHA. A gate needs the owner's OK for one unpushed branch commit (OQ-X7, D-P0-07); if the owner declines, the gate waits; there is no uncommitted fallback. Commit the phase work to the phase branch until `git status --porcelain` is empty; the gate SHA is `git rev-parse HEAD`, kept only in git-ignored `.handoff/gate<N>-sha` until the end of step 6. Anything known only after freeze (the gate SHA, the final-SHA suite and metric results, review verdicts, finding dispositions, owner decision) never goes into the frozen tree; it goes into the new file `docs/plans/gates/gate<N>.md` in the gate-record commit (step 6). Then the full suite from a clean checkout of the gate SHA, with every cache pointed at absolute repo paths so nothing lands in `~/Library/Caches`: `W=$(mktemp -d); git worktree add "$W" <gate-sha>`; `export npm_config_cache=<repo>/.cache/npm electron_config_cache=<repo>/.cache/electron ELECTRON_CACHE=<repo>/.cache/electron ELECTRON_BUILDER_CACHE=<repo>/.cache/electron-builder` for the whole suite; `touch <marker>`; in `$W`: `npm ci`, then `npm run lint && npm run typecheck && npm test && npm run build && npm run dist:mac -- --dir && npm run test:e2e && npm run perf -- <affected tiers> && npm run privacy:scan -- --all && npm run fixtures:lint`; afterwards a recursive `find ~/Library/Caches \( -ipath '*electron*' -o -ipath '*xaibo*' \) -newer <marker>` prints nothing (catches new or changed files inside existing cache dirs); finally `git worktree remove --force "$W" && git worktree prune`. (Phase 0 uses its own subset, §0.20 G0-2.)
2. M6 connection-attempt audit clean in every E2E run. `git status --porcelain` unchanged after runs (EC-61 regression). Native fixture-store checksums unchanged.
3. **Codex review, diff-only.** Baseline = `git merge-base master HEAD`, recorded at branch creation. Write `.handoff/gate<N>-review.md` with the reviewer role, PRD section refs, this plan's phase section, the EC list, `git diff -u <base> <gate-sha> -- . ':!package-lock.json'`, and sanitized test and metric output. Run `npm run privacy:scan` on the handoff file first. Run `node <codex-companion> task --fresh --prompt-file .handoff/gate<N>-review.md` outside the sandbox per PRD App. B item 6 and OQ-X2 (per-command approval, or the owner runs it in their own terminal). If the diff is too large, split by top-level directory into sequential handoffs (OQ-X7). Fixes go through HP with `hotfix` (with the owner's OK, as a further unpushed commit). After the last fix, the new HEAD is the new gate SHA (step 1); re-run the **full** step-1 suite on it, and give substantive fixes a fix-only Codex re-review of `git diff -u <old-gate-sha> <new-gate-sha>`. Repeat whenever the gate SHA changes.
4. **Claude second review** of the final gate SHA's diff plus the Codex findings: correctness, performance, security, privacy, ponytail. Any accepted fix after freeze, whether from Codex, Claude or the owner, is a further owner-authorized unpushed commit and so a new gate SHA, and restarts the loop on it: full step-1 suite, Codex fix-only re-review of the delta, Claude re-review. The gate proceeds only on a SHA that both reviews pass with no new accepted fixes.
5. Delete the review handoffs `.handoff/gate<N>-*.md`, with no backups (`.handoff/gate<N>-sha` stays until step 6's checks pass).
6. **Owner stop.** Present the final gate SHA, summary, metric misses, waivers, open items; the owner approves that SHA. Then, when the owner asks, the **gate-record commit** on top of the gate SHA adds exactly one new file, `docs/plans/gates/gate<N>.md` (gate SHA, final-SHA suite and metric results, Codex and Claude verdicts, finding dispositions, owner decision; privacy rules apply; `privacy:scan` on it). Check: `git rev-list --parents -n 1 HEAD` prints exactly `<HEAD> <gate-sha>` (one parent, the approved SHA; no merge commit); `git diff --name-status <gate-sha> HEAD` prints exactly `A	docs/plans/gates/gate<N>.md`; `git ls-tree HEAD docs/plans/gates/gate<N>.md` shows mode `100644` (a regular file); `git status --porcelain` is empty. Then delete `.handoff/gate<N>-sha`. Then, each only when the owner asks for it: push, open the PR to `master`, merge after approval. The next phase's first commit updates the progress file's §1/§2 status from the gate file. (For gates, this committed-review procedure, D-P0-07, replaces HARNESS_PROCESS §3 step 7's review of uncommitted changes.)

**Agent version check (every gate from Gate 1, part of step 0; D-P1-17).** Compare each installed agent version with the one last recorded. Unchanged: nothing more. Changed: run the synthetic fixture tests and the agent's facts extractor over the temp profiles (no prompt): `spikes/s9/facts.ts` for Claude and Codex, `spikes/p2-agy/facts.ts` for `agy` once P2-T00 lands. A live PR-OK prompt in a temp profile runs only if new record types or fields appear, with the owner's OK for that run. In real use, the EC-04 drift flag covers the owner's own transcripts.

`<codex-companion>` = the Codex plugin's `scripts/codex-companion.mjs` (path resolved on the machine, never written into git).

### 2.5 Branch per phase

Each branch is cut from up-to-date `master` (`git switch master && git pull --ff-only && git switch -c <branch>`) only after the previous phase's PR is merged, except Phase D (may run in parallel, Q-D1).

| Phase | Branch | Gate |
|---|---|---|
| 0 Spikes | `feat/phase0-spikes` (exists; cut from `master` at `e6b39ab`) | Gate 0 |
| 1 Skeleton + Claude ingest | `feat/phase1-claude-ingest` | Gate 1 |
| 2 Codex + normalization + Gemini ingest | `feat/phase2-codex-gemini-normalization` | Gate 2 |
| 3 Live status | `feat/phase3-live-status` | Gate 3 |
| D Design system | `docs/design-system` | Gate D |
| 4 Session workspace UI | `feat/phase4-session-workspace` | Gate 4 |
| 5 History and retention | `feat/phase5-history-retention` | Gate 5 |
| 6 Integrations | `feat/phase6-integrations` | Gate 6 |
| 7 Control | `feat/phase7-control` | Gate 7 = MVP Gate |
| v1-A Embedded terminal, app-server, ACP | `feat/v1a-embedded-terminal` | v1-A gate |
| v1-B OTLP, Compare, notify, categories, inspector | `feat/v1b-otlp-compare` | v1-B gate |
| v1-C MCP server | `feat/v1c-mcp` | v1-C gate |
| v1-D Windows, Linux | `feat/v1d-cross-platform` | v1-D gate |
| Public release (optional) | `chore/public-release` | Public gate |

### 2.6 Privacy rules for evidence

- No real usernames, absolute paths (write `~`), uids, hostnames, session IDs, ports, counts from the owner's stores, prompts, transcript content, emails or account/plan data in any committed file, review handoff, chat or log.
- Raw temp-profile output stays under git-ignored `.cache/` and is deleted once reduced. Only schemas (key paths and types), allowlisted format identifiers, pass/fail, booleans and timing aggregates enter git.
- Fixtures are hand-written from reduced schemas, never copied from recordings. Synthetic UUID pattern `00000000-0000-4000-8000-<12 hex>`; cwd values `/tmp/xaibo-fixture/<project>`; home-relative paths `~/<project>`; fixed timestamp base (OQ-X5).
- Canary secrets are generated at test time, never committed.
- Before any text leaves the machine (Codex handoff, PR, chat), it passes the privacy scan (`npm run privacy:scan`, from P0-T08 in Phase 0 and extended in P1-T02; `npm run privacy:scan` from Phase 1).
- Guard manifests and keychain metadata are never printed, committed or pasted; only `MATCH`, `DIFF` with per-category counts, and `expected-new 1` are reported (P0-T04).

## 3. Cross-cutting conventions

### 3.1 Spike placement

- Spike code lives in `spikes/<spike-id>/` (`spikes/s1`, `s3`, `s4`, …, `s13`), plus `spikes/app/` (the packaged throwaway spike app) and `spikes/shared/` (guard, runner, bench, reducer, recorder) (OQ-B2). Pre-v1 spikes use `spikes/s2-pty/`, `spikes/s8-otlp/`, `spikes/s10-mcp/`.
- `spikes/` is outside the gated globs and is **never imported by `src/`** (lint rule from Phase 1; grep check at every gate). It stays on its phase branch as evidence.
- Findings go to `docs/plans/phase0_spikes.md` (pre-v1 spikes append sections there).
- Each spike's "test first" is its pass/fail check script, observed failing before the spike code exists. Spike decisions are recorded with `record_decision`.

### 3.2 Disposable profiles and owner sign-in

| Item | Rule |
|---|---|
| Location | `.cache/profiles/<agent>-<slot>/` (git-ignored, mode 0700); `HOME=<profile>/home`; `CLAUDE_CONFIG_DIR=$HOME/.claude`, `CODEX_HOME=$HOME/.codex`, `GEMINI_CLI_HOME=$HOME` (parent of `.gemini`). Alternative: the session scratchpad (re-sign-in each session). OQ-X1. |
| Runner | `spikes/shared/in-profile.sh <agent> <slot> -- <cmd…>`: `env -i` with an allowlist, all five isolation variables (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XAIBO_DATA_DIR`) set inside the profile, a sentinel-file check that the resolved profile is under `.cache/profiles/`, refusal if any target realpath equals or lies under a real agent or Xaibo root (not merely under the real home, since the repo itself is under home), auto-update disabled, started PIDs recorded, version recorded before and after (P0-T05). Reused unchanged by Phase 3, Phase 6, and v1 live checks. |
| Throwaway projects | `.cache/spike-projects/<spike>/` with `git init` and one synthetic `README.txt` |
| Guard | `spikes/shared/guard.ts snapshot|compare <label>` before and after every live session, every owner sign-in and every spike block (P0-T04). It is **detection only**; prevention is the runner's env isolation plus the sandbox write-deny on real roots. It hashes real config files and stats credential files and keychain metadata; it never lists or reads real session stores (AGENTS.md). Any `DIFF` (including a removal) stops all live work; the owner is told and adjudicates (the owner's own concurrent sessions can cause a DIFF). |
| Keychain | Metadata only (attribute enumeration with `security dump-keychain`, never `-d`/`-g`/`-w`; P0-T04). Sharing checked before the first sign-in per agent (P0-T06). If temp sign-in would share or overwrite the real credential: stop (OQ-X4). |
| Owner sign-in | Owner runs the printed `in-profile.sh … -- <agent>` login command in their own terminal (the sandbox blocks `open` and browser OAuth). First need per profile only. |
| Prompts | Fixed synthetic prompt set (P0-T07); budget OQ-X10. `/context`, `count_tokens`, quota and usage commands are never used (OQ-B16). |
| Retirement | Profiles kept until Gate 6 (FR-32 disposable-profile hook work), then the owner logs out in each, and profiles plus any temp keychain item are deleted after owner confirmation (OQ-B10). |

### 3.3 Caches and local dirs

| Path (all git-ignored via `.cache/`) | Use |
|---|---|
| `.cache/npm` | npm cache (`.npmrc` `cache=`, or `npm_config_cache`) |
| `.cache/electron`, `.cache/electron-builder` | `electron_config_cache` / `ELECTRON_CACHE`, `ELECTRON_BUILDER_CACHE` |
| `.cache/node-gyp` | `npm_config_devdir` (v1-A native rebuild) |
| `.cache/profiles/` | disposable agent profiles |
| `.cache/guard/` | guard manifests (local only) |
| `.cache/spike-results/<id>/` | raw spike output (`raw/` deleted after reduction) |
| `.cache/spike-data/<id>/` | spike corpora (S12 ≥10 GiB) |
| `.cache/spike-projects/<spike>/` | throwaway projects |
| `.cache/perf/` , `.cache/perf-corpus/<seed>/` | product perf corpora (T1–T3) |
| `.cache/validator-trial/` | optional validator trial install (only with approval) |

### 3.4 Installs per phase

Each install needs the owner's go-ahead at phase start, exact versions (`save-exact`), project-local, caches in `.cache/`.

| Phase | Install | App. C status |
|---|---|---|
| 0 | `electron`, `typescript`, `electron-builder` | on App. C (electron-builder moved from Phase 1 by owner decision 2026-11-09; App. C errata D-P0-05) |
| 0 (conditional) | `better-sqlite3` only if S1 rejects `node:sqlite` | on App. C; separate go-ahead at that point |
| 1 | `vite`, `@vitejs/plugin-react`, `@playwright/test`, `eslint`, `typescript-eslint`, `react`, `react-dom` | on App. C |
| 1 (approval needed) | `@types/react`, `@types/react-dom`, explicit `@types/node` | **not on App. C** (OQ-P1-02) |
| 1 (conditional) | JSON Schema validator selected at Gate 0 (`ajv` or a small maintained validator) | App. C: "selected at Gate 0" (OQ-X6) |
| 2, 3, 5, 6, 7 | none (Phase 3: a packaging helper only if the S3 winner needs one, with approval) | — |
| D | none | — |
| 4 | `@tanstack/react-virtual` | on App. C |
| v1-A | `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` | on App. C |
| v1-B | `smol-toml` | on App. C |
| v1-C | none by default; `@modelcontextprotocol/sdk` only if the owner picks the SDK | on App. C (with hand-written alternative) |
| v1-D, Public | none (OS toolchains only with approval) | — |

Never installed without explicit approval: `postject`, `hyperfine`, axe-core, any chart/icon/font/animation library, a diff library, MCP SDK, zstd package, tokenizer.

### 3.5 Diff-only reviews and Codex handoff mechanics

- Baseline snapshot recorded at branch creation (progress file and `.handoff/<phase>-baseline`).
- The reviewer gets `diff -u` plus only the context it needs (PRD excerpts, plan section, EC rows, sanitized results), never whole files or raw data.
- Handoff files live in git-ignored `.handoff/`, pass the privacy scan, and are deleted after use with no backups.
- Companion: `node <codex-companion> task --fresh --prompt-file .handoff/<file>.md`, run outside the sandbox per PRD App. B item 6 and OQ-X2 (per-command approval, or the owner runs it).
- Phase 3 security-change units also get interim diff-only Codex reviews without an owner stop (Q3-12).

### 3.6 Shared conventions decided by this plan

- One per-install random secret file in app data (0600) is used both for hashing IDs in logs (P1-T03) and for opaque contribution keys (P5-T04) (OQ-X14).
- `npm test` is node:test only, and harness-os observes RED only through `npm test`. TSX cannot be imported by node:test, so **every gated unit that writes `src/**/*.tsx` (or any `src/` file whose only test is E2E) has a harness RED of its own: a node:test test, observed failing through `npm test`, on the `.ts` module that holds the unit's logic (state, projection, keyboard/focus math, formatting, IPC handler)**. The `.tsx` is written only after that RED. A Playwright RED/GREEN is additional evidence, logged by hand (OQ-X8). Markup with no testable logic is part of the unit whose `.ts` logic it renders, never a harness unit on its own. This applies to every E2E-first task, including P3-T10, P4-T03, P4-T14, P4-T15, P5-T18, P6-T11, V1A-T03 and V1A-T07; each names its `.ts` module and node:test file in its HP spec. Proved once on the first `.tsx` unit in Phase 1: `workflow_status` must advance on the node:test RED; if harness-os rejects it, stop and take it to the owner before any further `.tsx` work.
- Every limit that cuts a real corner carries a `ponytail:` comment naming the ceiling and upgrade path.
- Pre-Gate-D UI is minimal semantic HTML with text plus glyph; no visual baselines before Phase 4.

## 4. Phases

## Phase 0 — Spikes (Gate 0)

### 0.1 Phase header

| Item | Value |
|---|---|
| Goal | Evidence-backed decisions, written to `docs/plans/phase0_spikes.md`, for: S1 SQLite engine; S3 forwarder runtime, per-event reporting path and ack point (Q7, Q17); S4 Claude hooks-only plugin route (D-2); S5 Codex hook trust (FR-31); S6/S7 cross-surface visibility, resume and attach (Q3, Q12, compatibility matrix); S9 version-pinned Claude/Codex format facts; S10 zero attempted non-loopback connections and the audit method; S11 Gemini observation/retention/launch facts, catalog expressiveness and the JSON Schema validator selection; S12 minimum service architecture, batch bounds, watcher strategy and the watch reconciliation interval default (Q8/FR-02), Q19 feasibility; S13 passive usage/context/cost inputs and the explicit **tee-feasibility and account-scope decision**. Product code is out of scope: nothing goes in `src/`. |
| Branch | `feat/phase0-spikes` (cut from `master` at `e6b39ab`; carries the plan commit `96ac326`, also on `origin`). Before the next commit: `git fetch && git merge-base --is-ancestor origin/master HEAD`; if it fails, rebase onto `origin/master`. Commit/push only on the owner's word; merge by PR after Gate 0. |
| Installs at phase start | `electron`, `typescript`, `electron-builder` (exact pins, `save-exact`, caches in `.cache/`). `@types/node` arrives transitively through `electron` and is not added to `package.json`. `better-sqlite3` only if S1 rejects `node:sqlite`, with a separate owner go-ahead. Nothing else (`ajv`, `postject`, `hyperfine`, MCP SDK) without explicit approval. macOS tools already present and used: `/usr/bin/expect`, `/usr/bin/script`, `/usr/bin/shasum`, `/usr/bin/security`, `sandbox-exec`, `hdiutil`. |
| Toolchain facts (system Node, not evidence about Electron) | Node v26.10.0, npm 11.19.1. System Node offers `--build-sea` and native type stripping; its `node:sqlite` reports SQLite 3.53.4 with `ENABLE_FTS5=1`. **Electron's bundled Node is what S1 must test.** |
| harness-os | `spikes/**` and `scripts/**` are outside the gated globs, so spike code does not go through `run_workflow`. Every spike decision is recorded with `record_decision` (keyword-risk prompts on "session"/"token" are expected; read the rationale and approve). |
| Isolation | Spike code only in `spikes/`; never imported by `src/`. Raw results in `.cache/spike-results/<id>/`, corpora in `.cache/spike-data/<id>/`, profiles in `.cache/profiles/`, guard manifests in `.cache/guard/`. Only reduced aggregates, schemas, decisions and hand-written synthetic fixtures enter git. |
| PRD mapping | §10 Phase 0 row and spike table; S-01..S-06, S-10..S-14, S-22, S-25, S-27..S-35; App. E rows listed per spike; §12 Q3, Q7, Q8, Q12, Q17, Q18, Q19. |
| EC rows assigned to Gate 0 | **None.** PRD §10 assigns every §9.2 row to Gates 1–7 or v1. Spikes produce evidence and fixtures that later gates consume (§0.18). |

### 0.2 Entry criteria

1. PRD v1.0 approved (done 2026-11-09).
2. This plan has been challenged by a second session and the owner has approved the challenged spike plan (PRD §10: "before any spike implementation").
3. PRD App. C records electron-builder in Phase 0 (one-line errata, D-P0-05) before P0-T01.
4. Unsandboxed runs follow OQ-X2 (resolved, D-P0-02): per-command approval, or the owner runs the listed `npm run spike:*` commands in their own terminal. Needed for packaged GUI launches, `sandbox-exec` (incl. `npm run spike:test:unsandboxed` and every `in-profile.sh` run), loopback binds and agent CLIs.
4a. **Reference machine (D-P0-03).** Phase 0 runs only on the owner's Apple Silicon Mac (PRD §1.4): `uname -sm` = `Darwin arm64` and system Node = v26.10.0. Any other machine (e.g. a Linux/WSL dev box) may edit docs and review only; spike tasks refuse to start there.
5. Installed agent versions match the pins: claude 2.1.319, codex 0.160.0, gemini 0.46.0. Checked only through the runner with the guard around it (P0-T05 Verify, after P0-T06 step 1), never by running the agents in the real environment; re-checked in P0-S9-T1. A mismatch stops the phase; the owner decides re-pin or reinstall; Claude never installs agent binaries.
6. The owner is available for the first sign-in to each temp profile (P0-T06).
7. harness-os reachable (`get_constitution` or `workflow_status` succeeds) for `record_decision`, and the Codex companion runnable per PRD App. B item 6 and OQ-X2 for the Gate 0 review.

### 0.3 Shared infrastructure (P0-T01..P0-T11)

**P0-T01 — Minimal package, pinned installs, local caches**
- Do:
  - Hand-write `package.json`: `"private": true`, name `xaibo`, version `0.0.0`, no runtime dependencies.
  - Write `.npmrc` with `save-exact=true` and `cache=` pointing at the repo `.cache/npm`.
  - Install with the Electron cache env inline: `electron_config_cache="$PWD/.cache/electron" npm install --save-dev --save-exact electron@<v> typescript@<v> electron-builder@<v>`.
  - Version rule: latest stable of each at install time (OQ-A14). Record exact versions plus Electron's `process.versions.node`, `.v8`, `.chrome` in `phase0_spikes.md`.
  - Sandbox network for the install: `registry.npmjs.org`, `github.com`, and the release-asset hosts named in any sandbox-violations block.
- Files: `package.json`, `package-lock.json`, `.npmrc`.
- Test first (S): before the install, `npx --no-install electron --version` fails.
- Verify: `npx --no-install electron --version`, `npx tsc --version`, `npx electron-builder --version`; `npm config get cache` resolves to the repo `.cache/npm` (if not, switch to `${PWD}` interpolation and document "run npm from the repo root"); `ls .cache/electron` contains the Electron zip; a before/after listing of `~/Library/Caches/electron` and `~/Library/Caches/electron-builder` shows no new or modified entries; `git status --porcelain` after the install differs from its pre-install output (which already shows the P0-T10 report) by exactly the three files.
- Done-evidence: pinned versions and cache verification in `phase0_spikes.md` § Environment.
- Deps: entry criteria, P0-T10 (report skeleton exists). Owner: confirms the install (phase-start check).

**P0-T02 — Spike layout, TypeScript config, shared bench helpers, scripts**
- Do:
  - `spikes/tsconfig.json`: strict, `module`/`moduleResolution` `nodenext`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `outDir` `spikes/app/build` (ignored by `build/`).
  - `spikes/shared/bench.ts`: `hr()` (`process.hrtime.bigint()`); `summary()` (nearest-rank p50/p95/p99/max, n, mean); `mulberry32(seed)`; `envRecord()` (CPU brand, macOS version, RAM class, Electron/Node/SQLite/agent versions; no hostname, username or paths); `redactPaths()` (home → `~`, temp roots → `<tmp>`, applied to every results file).
  - `package.json` scripts: `typecheck` = `tsc --noEmit -p spikes && tsc --noEmit -p tsconfig.scripts.json` (the second covers `scripts/**/*.ts` and `test/**/*.ts`); `spike:build` = `tsc -p spikes`; `spike:test` = `node --test "spikes/**/*.test.ts"`; `spike:test:unsandboxed` = the real-`sandbox-exec` deny tests (P0-T05); `privacy:scan` = `node scripts/privacy-scan.ts`; `test` = `node --test "test/**/*.test.ts"` (Phase 1 refines); `spike:s1|s3|s10|s12` per spike.
  - Helper scripts are `.ts` run directly by Node 26 type stripping; hook recorders are plain `.mjs` so nothing can reach stderr.
- Files: `spikes/tsconfig.json`, `tsconfig.scripts.json` (strict, `nodenext`, `noEmit`, includes `scripts/**/*.ts` and `test/**/*.ts`), `spikes/shared/bench.ts`, `spikes/shared/bench.test.ts`, `package.json`.
- Test first (U): `bench.test.ts` asserts nearest-rank p95 of 1..100 = 95 and of a single sample = that sample; `mulberry32(42)` gives the same first five values every run; `redactPaths` removes `os.homedir()` and `os.tmpdir()` prefixes. Run before `bench.ts` exists; it fails.
- Verify: `npm run spike:test && npm run typecheck`.
- Done-evidence: green output; the percentile method stated in `phase0_spikes.md` (every Phase 0 p95 depends on it).
- Deps: P0-T01.

**P0-T03 — Packaged throwaway spike app (minimal `dist:mac`)**
- Do: a plain-HTML spike app `XaiboSpike` (no React).
  - `main.ts`: `app.setPath('userData'|'sessionData', $XAIBO_DATA_DIR)` before `ready`, refusing to start without it; single-instance lock; tray plus a window that hides on close; spawns `service.ts` via `utilityProcess.fork` and restarts it with bounded backoff (100 ms ×2, capped at 5 s); opens a `MessageChannelMain` port from the service directly to the renderer; applies the P2/SEC1 policy: CSP meta `default-src 'self'; connect-src 'self'`; `session.webRequest.onBeforeRequest` allows only `file:`/app schemes and logs and cancels the rest; navigation and `window.open` denied; permission requests denied; spellcheck off; `crashReporter` never started; no updater.
  - `preload.cts` (CommonJS, sandboxed) exposes only the port.
  - `index.html` + `renderer.js` paint one element per received event and send a paint ack through `requestAnimationFrame` → port.
  - `service.ts` dispatches on argv mode: `idle`, `s1-probe`, `s1-crash`, `s3`, `s9-zstd`, `s12-*`.
  - Builder config `spikes/app/electron-builder.json`: `appId` `local.xaibo.spike`, `productName` `XaiboSpike`, `electronVersion` equal to the installed one; `files` `["package.json","index.html","build/**"]`; `asarUnpack` `["build/s3/forwarder.cjs"]`; no `extraResources` yet (P0-S3-T5 adds the SEA binary entry once it exists); `mac.target` `dir` (no dmg), `mac.identity` `null`, `npmRebuild` `false`; `directories` `{"app": "spikes/app", "output": "dist/spike"}` (electron-builder resolves `files` against the app dir, which otherwise defaults to the repo root); `spikes/app/package.json` has `"main": "build/app/main.js"`.
  - Root script `dist:mac` = `npm run spike:build && ELECTRON_CACHE="${ELECTRON_CACHE:-$INIT_CWD/.cache/electron}" ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$INIT_CWD/.cache/electron-builder}" electron-builder --mac dir --config spikes/app/electron-builder.json` (npm sets `INIT_CWD` to the directory npm was run from, defaults only; §2.4 step 1 sets the main repo's absolute `.cache/` paths, which win). Phase 1 repoints it to the product config (OQ-A13).
- Files: `spikes/app/{package.json,electron-builder.json,main.ts,preload.cts,service.ts,index.html,renderer.js,smoke.ts}`, `package.json`.
- Test first (S): `spikes/app/smoke.ts` launches `dist/spike/mac-arm64/XaiboSpike.app/Contents/MacOS/XaiboSpike` with temp `XAIBO_DATA_DIR`, mode `idle`; asserts service ready over IPC, renderer paint ack received, clean exit on quit, no orphan PIDs (`pgrep -f XaiboSpike` empty 2 s after quit). Fails before the app is built.
- Verify: `npm run dist:mac && node spikes/app/build/app/smoke.js` (unsandboxed); `codesign --verify --deep --strict` on the `.app` (if invalid or killed on launch, add an ad-hoc `codesign --force --deep --sign -` post-step, no Apple account, and record it); `ELECTRON_RUN_AS_NODE=1 <app binary> -e "console.log(process.versions.node)"` confirms the RunAsNode fuse state (needed by S3 candidate A); the data dir is the only new path — a before/after `find ~/Library -maxdepth 3 \( -iname '*XaiboSpike*' -o -iname '*local.xaibo.spike*' \)` (covers Application Support, Caches, Preferences plist, HTTPStorages, Saved Application State) shows nothing new, output kept local; `git status --porcelain` unchanged by the run (EC-61 evidence for Gate 1).
- Done-evidence: build summary (sizes, Electron version, signing state) and smoke pass in `phase0_spikes.md`.
- Deps: P0-T01, P0-T02. Owner: approves the unsandboxed launch, or runs it.

**P0-T04 — Real-profile guard (local checksum manifest)**
- Do: `spikes/shared/guard.ts snapshot|compare <label>` writes `.cache/guard/<label>.json` (never printed, committed or pasted).
  - **sha256** (when present) of: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/known_marketplaces.json`, `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.gemini/settings.json`; plus a sorted name+size listing hash of `~/.claude/plugins/`. The same file set is hashed under every real root resolved from the login-shell env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` via the same fixed-argv `env -0` read as OQ-P1-03; EC-39) as well as the defaults.
  - Real session stores (`projects/`, `sessions/`, `archived_sessions/`, Gemini `tmp/*/chats`) are **never listed, statted or read** (AGENTS.md: dev and tests never read real agent stores). A CLI that ignores the env override is stopped by (1) the write-deny on real roots (Claude sandbox inside it, the runner's `sandbox-exec` wrapper outside it, see below), and noticed by (2) a positive check after every temp session that its transcript/rollout appeared under the temp root; if it did not, stop all live work (the CLI may have written elsewhere).
  - `~/.claude.json`: the controlling Claude session rewrites it, so only its top-level key set and the `mcpServers` subtree are hashed; a change in either is a `DIFF`, never ignored.
  - Credential files (`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, any found in agent docs): **stat only** (size, mtime, inode); content never read.
  - Gemini roots: `GEMINI_CLI_HOME` is the *parent* of the store, so the hashed set is under `${GEMINI_CLI_HOME:-~}/.gemini/`.
  - Keychain **metadata only**: every snapshot enumerates the login keychain with `security dump-keychain` (attributes only; never `-d`, and never `find-generic-password -g`/`-w`), parsed in-process; it keeps, for **every** generic-password item, the tuple (SHA-256 of `svce`, SHA-256 of `acct`, `mdat`) in the private manifest, and marks items whose `svce` matches `laude|odex|emini` or a name confirmed from the agents' docs via context7 as agent items. Compare: any agent item added, modified or removed is a keychain DIFF (stop). Any non-agent item added, modified or removed is reported as `unmatched-change <n>` and live work pauses until the owner adjudicates it in Keychain Access; the owner may mark that hashed service as non-agent in the private manifest, after which its later changes are ignored for the rest of Phase 0 (other apps refresh their own items). An unrecognised agent credential present at baseline therefore cannot change unnoticed. Enumerating everything on every snapshot is what makes items under an unexpected service name, or a second account under a known name, visible. Unknown names become an owner check in Keychain Access.
  - `compare <label> [--expect-new-keychain <svce>]` detects additions, modifications, deletions, replacements (inode change) and truncations of every entry, and keychain items added, modified or removed. Precedence, highest first: any config, credential or agent-item change other than the expected addition → `DIFF` (exit 1, stop); else any unmatched change → `unmatched-change <n>` (exit 1, pause for the owner); else `MATCH`, with `expected-new 1` when the single temp-credential item named by `--expect-new-keychain` (pre-identified from docs in P0-T06 step 1) was added. Changes to owner-marked non-agent services are ignored. All applicable counts are printed together. Output is only category counts (`DIFF: config <n> / credential <n> / keychain <n>`, `unmatched-change <n>`, `expected-new 1`), never names; per-entry detail stays in the private manifest under `.cache/guard/`. Otherwise `MATCH`.
  - Prevention, not the guard: `in-profile.sh` always runs unsandboxed (per-command approval or owner-run, OQ-X2) and always wraps the command in `sandbox-exec` with a deny profile generated at run time from the resolved real roots: `(allow default)` plus `(deny file-read* file-write* …)` for each real root, `~/.claude.json` and a canary dir `$P/.deny-canary/`. Before launching it reads and writes the canary through the same wrapper; if either succeeds, or `sandbox-exec` is unavailable, it refuses to launch. Agents and Electron apps that apply their own Seatbelt profile may not run nested inside it; the P0-T05 nesting probe finds those, and they never run unwrapped (OQ-X16). Keychain writes go through `securityd` and are not file writes, so for those the guard (detection) and P0-T06 step 1 (backend proven first) are the controls. If isolation cannot be established, stop.
- Files: `spikes/shared/guard.ts`, `spikes/shared/guard.test.ts`.
- Test first (U): the test builds a synthetic HOME under `$TMPDIR` with dummy files and a fake keychain-metadata provider, snapshots, then for each case expects the right category count and exit 1: `.claude/settings.json` modified; a config deleted; a credential file truncated; a credential file replaced (same size, new inode); a config under a synthetic env-override root modified; a keychain item removed; an agent-named keychain item added under a new service name; a second account added under a known service name; an item with an unrelated synthetic service name added, an existing unrelated item modified, and one removed (each expects `unmatched-change 1` and exit 1); the same changes to a service marked non-agent give `MATCH`. With `--expect-new-keychain <svce>`: adding exactly that item gives `MATCH` with `expected-new 1`; adding it plus modifying an agent item gives `DIFF`; adding it plus modifying an unrecognised item gives `unmatched-change 1` (pause, not `DIFF`). A final case asserts stdout contains no file or item names. Fails before `guard.ts` exists.
- Verify: `npm run spike:test`; then `guard.ts snapshot baseline` on the real home followed immediately by `guard.ts compare baseline` → `MATCH`.
- When it runs: before and after every owner sign-in, every live spike session/block, and at Gate 0 against `baseline`.
- Done-evidence: `phase0_spikes.md` § Guard lists the procedure and "MATCH" per live session; no hashes, paths or account data.
- Deps: P0-T02. Owner: approves the one-time keychain metadata read.

**P0-T05 — Isolated temp-profile runner**
- Do: `spikes/shared/in-profile.sh <agent> <slot> -- <cmd…>`:
  - Signature `in-profile.sh [--spike <id>] [--gemini-layout unset|custom] <agent> <slot> -- <cmd…>`. **Targets** are the five isolation variables (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XAIBO_DATA_DIR`) plus `TMPDIR`, all under `$P`; `XAIBO_SPIKE_RAW` and the cwd may additionally be under `<repo>/.cache/spike-results/<id>/raw` and `<repo>/.cache/spike-projects/<id>/`, with the same real-root check.
  - Profile root `P=<repo>/.cache/profiles` (OQ-X1); one HOME per agent and slot (`claude-a`, `codex-a`, `gemini-a`; `-b` slots only for optional EC-92 evidence, OQ-B11).
  - `exec env -i` with only `PATH`, `TERM`, `LANG`, `USER`, `LOGNAME`, `SHELL`, `HOME=$P/<agent>-<slot>/home`, **all** agent variables whatever the agent (`CLAUDE_CONFIG_DIR=$HOME/.claude`, `CODEX_HOME=$HOME/.codex`, `GEMINI_CLI_HOME=$HOME`) so a child that starts another agent stays isolated, `XAIBO_DATA_DIR=$P/<agent>-<slot>/xaibo-data`, `TMPDIR=$P/<agent>-<slot>/tmp`, `XAIBO_SPIKE_RAW=<repo>/.cache/spike-results/<id>/raw` (from `--spike`). This drops inherited `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OTEL_*` and real `*_CONFIG_DIR`/`*_HOME` values.
  - Requires a sentinel file `$P/<agent>-<slot>/.xaibo-temp-profile`. Refuses if the `realpath` of any target is outside its allowed root, or equals, contains or lies under a **real root**: the defaults `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini`, the real Xaibo app-data dir and `~/Library/Application Support/XaiboSpike`, plus every real `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and the real Gemini store `${GEMINI_CLI_HOME}/.gemini` read from the login-shell env (OQ-P1-03; `GEMINI_CLI_HOME` is the store's parent, never itself a root, so an override set to the real home does not reject profiles under home). The repo being under the real home is fine.
  - Always wraps in the read/write-deny `sandbox-exec` profile with the canary self-check described in P0-T04, with no exceptions; refuses to launch if the wrapper cannot be established (commands that cannot nest follow OQ-X16 and never run unwrapped).
  - **Nesting probe (first run on the Mac, before any live block; no agent, account or network needed):** under the generated profile run (1) `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`, which is the mechanism Codex's tool sandbox uses on macOS: exit 0 means nesting works, `sandbox_apply` errors mean it does not; and (2) the packaged spike app in mode `idle` (P0-T03 smoke): smoke pass means Electron's helper sandbox nests. Any other failure is classified as a probe error and stops live work until explained. If (1) fails, every Codex command that uses its tool sandbox falls under OQ-X16; if (2) fails, every packaged-app and VS Code launch does. Results go to `phase0_spikes.md` § Guard.
  - Gemini layout mode for P0-S11-T1 only: `--gemini-layout unset` (no `GEMINI_CLI_HOME`, store resolves under the profile `HOME`) or `--gemini-layout custom` (`GEMINI_CLI_HOME=$P/gemini-a/cli-home`); every other check unchanged.
  - Runs a small supervisor (perl, present on macOS) that stays **outside** the command's process group, using standard job control. Requirement: cleanup stops every process in the run's group and never signals anything outside it; descendants that leave the group are handled by detection, with an explicitly stated limit (below). Design: after `fork`, both the supervisor and the child call `setpgid(child, child)` (the standard race-free idiom; no handshake), then the child execs the command. The supervisor **does not reap the group leader until group signalling is finished**: an unreaped (zombie) leader keeps its group ID reserved, so `kill -<pgid>` can never hit a reused group; the parent's own `setpgid` may return `EACCES` when the child has already exec'd (expected on macOS): the parent then checks `ps -o pgid= -p <child>` equals the child PID and continues. Any other outcome (the child's `setpgid` or `exec` fails, or the group check fails) refuses the run: the supervisor sends `kill -KILL -<pgid>` if the group exists (else kills the child), waits for members to disappear, then reaps the leader. Shutdown (leader exited, or cleanup signal): `kill -TERM -<pgid>`, wait until no live member remains besides the zombie leader (`pgrep -g`), `kill -KILL -<pgid>` after 5 s, then reap the leader and exit. Records its own PID, `ps -o lstart=`, the group ID and argv in `$P/<agent>-<slot>/pids`.
  - Escaped descendants (new group or session): every run carries a random `XAIBO_RUN_TOKEN` in its environment, and after shutdown any own-user process whose environment holds it (`ps -Eww`) is reported as `survivors <n>`. **Limit:** a descendant that both leaves the group and clears its environment carries no token. Backstop after every spike block: own-user processes started after the block's start time that were not in the pre-block process list are listed locally (PIDs and command names only, never printed into git or chat), and live work pauses until the owner has checked them; any survivor or unexplained process is a stop condition.
  - Version freeze: Claude adds `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; Codex gets a temp `$CODEX_HOME/config.toml` with `check_for_update_on_startup = false` and `cli_auth_credentials_store = "file"`; Gemini auto-update disabled in temp settings. **All names UNVERIFIED** — confirmed via context7 first, then `--help` of the installed version run through the runner only after that agent's guarded first `--version` run gave `MATCH`.
  - Records `<agent> --version` before and after each run; a change invalidates the run.
  - No agent binary runs before P0-T06 step 1 (docs-only credential-backend record) is done for that agent.
- Files: `spikes/shared/in-profile.sh`, `spikes/shared/in-profile.test.ts`.
- Test first (S): `in-profile.sh claude a -- /usr/bin/env` (a non-shell child, so no shell-added `PWD`/`SHLVL`/`_`) fails before the script exists; afterwards it lists only the allowlisted names, with all five isolation paths and `TMPDIR` under `$P`, for every agent's profile. `in-profile.test.ts` with a synthetic real home and synthetic real roots: a repo and `$P` under that home are accepted, including with a synthetic real `GEMINI_CLI_HOME` set to that home and set to a custom parent; a target under a synthetic real root (incl. `<override>/.gemini`), a symlink in `$P` that resolves into a real root, and a target outside `$P` are each refused; both `--gemini-layout` modes resolve under `$P` and pass the same checks. Deny-profile tests (macOS, real `sandbox-exec`): the profile is generated from a list of synthetic protected roots under `$TMPDIR`; under it, a write into **each** protected root (file, nested dir, and a path reached through a symlink in `$P`) is denied, while writes into the temp profile, its `tmp/` and a writable control dir succeed and a temp-profile agent stub (`sh` writing a config, a transcript and a lock file) exits 0; a standalone protected file (like `~/.claude.json`), both existing and initially absent, cannot be created, written, truncated, deleted, replaced or renamed; for protected directories and files, deletion, replacement (`mv` of another file onto it) and rename through the parent directory are each denied; a root that does not exist yet still gets its deny rule (a later-created dir is protected); every one of these cases fails closed; a root path containing quotes or parentheses is escaped correctly or, if it cannot be, makes the runner refuse to launch, as does any generation error (fail closed); a no-op wrapper is caught by the canary check; a read of a protected file is denied too; supervisor tests: a child that execs before the parent's `setpgid` (parent gets `EACCES`) is accepted and still cleaned up as a group; a forced child `setpgid`/`exec` failure and a failed group check each leave nothing behind; cleanup signalled immediately after start still stops the group; a leader that exits with no descendants (no group signal goes out after reaping); a background child that outlives the command; descendants that exit during the 5 s timeout; cleanup signalled while the command and its child run; in each of these no group member remains and nothing outside the group is signalled. Escape cases: a `setsid` descendant that keeps its environment is reported as `survivors 1`; one that also clears its environment is not reported by the token scan but appears in the block backstop list; in both the run stops, and the test then kills the escaped process itself (expected state before cleanup: one listed escaper; after: none). These real-`sandbox-exec` tests are a separate script `npm run spike:test:unsandboxed` (Seatbelt cannot nest inside the Claude sandbox; listed under entry criterion 4), so `npm run spike:test` stays runnable in the sandbox. At runtime the runner also checks that the generated profile has one deny rule per resolved real root before the canary write.
- Verify: that command; then per agent, only after P0-T06 step 1 for it: `guard.ts snapshot pre-version-<agent>`, `in-profile.sh <agent> a -- <agent> --version` prints exactly the pin, `guard.ts compare pre-version-<agent>` → `MATCH` (shows `--version` is non-mutating for this version). Re-run at the end of every spike block.
- Done-evidence: "isolated: yes" in the report, no paths.
- Deps: P0-T04; P0-T06 step 1 (docs-only) before the version runs.

**P0-T06 — Keychain sharing check and owner sign-in per temp profile**
- Do, per agent, before any spike uses the profile:
  1. **Credential backend first, before any agent command (including P0-T05's `--version` run).** Docs only, no agent binary run: from the installed version's docs (context7) and its installed package files read as text, record where this exact version stores credentials and whether that location follows the temp profile: a file under the profile (Codex `cli_auth_credentials_store = "file"`, Gemini `oauth_creds.json` under `GEMINI_CLI_HOME`, Claude `$CLAUDE_CONFIG_DIR/.credentials.json`), or a keychain item. A keychain backend counts as isolated only if docs show the item name is distinct per config dir and differs from the real item recorded by the guard. If isolation cannot be shown from docs, do not run the probe or sign in: the live part for that agent is UNVERIFIED and the owner decides (OQ-X4).
  2. No real session of that agent may run during steps 2–5 (a token refresh would look like an overwrite). For Claude the owner runs steps 2–5 in their own terminal with every Claude Code session exited; any change to a real credential item or file during them is a stop (OQ-X4), not something to adjudicate. `guard.ts snapshot pre-login-<agent>`.
  3. **Auth probe** (only after step 1 shows isolation): run the agent's auth-status command, or launch it unauthenticated in the temp profile. It is not assumed to be read-only: `guard.ts compare pre-login-<agent>` must give `MATCH` immediately after it. If it already reports a login, credentials are shared (keychain or env): stop, do not sign in, apply OQ-X4.
  4. If clean, the owner runs in their own terminal: `in-profile.sh claude a -- claude` then `/login`; `in-profile.sh codex a -- codex login` (subcommand and any `--device-auth` variant UNVERIFIED; check `codex --help` first); `in-profile.sh gemini a -- gemini` with the sign-in method of their choice.
  5. `guard.ts compare pre-login-<agent> [--expect-new-keychain <svce from step 1>]` → `MATCH` (with `expected-new 1` if the pre-identified temp item was added); `DIFF` stops live work; `unmatched-change` pauses until the owner adjudicates (P0-T04 precedence). Check where temp credentials landed (expected `$CLAUDE_CONFIG_DIR/.credentials.json`, a *new* keychain item, or `$CODEX_HOME/auth.json`); the real item's `mdat` must be unchanged. A new item is recorded as "temp credential stored in keychain: yes/no" (needed for cleanup).
  6. One PR-OK prompt per agent: `claude -p "<PR-OK>"`, `codex exec "<PR-OK>"` (UNVERIFIED subcommand), `gemini` interactive; exit 0.
  - Rule if sharing is found for Claude: never `/login` or `/logout` inside a temp profile.
- Files: none in git. Report gets "temp login isolated from real credential store: yes/no" per agent.
- Test first (S): the guard compare must run and come back `MATCH` before any spike uses the profile.
- Deps: P0-T04, P0-T05. Owner: signs in once per profile; the sign-in lasts until retirement (§3.2).

**P0-T07 — Fixed minimal prompt set (synthetic; no real prompt is ever used)**

| ID | Prompt |
|---|---|
| PR-OK | "Reply with the single word OK." |
| PR-TOOL | "Run the shell command `ls` once, then reply DONE." |
| PR-WRITE | "Create a file named spike.txt containing the word hi, then reply DONE." |
| PR-BG | "Start the shell command `sleep 30` in the background and reply STARTED without waiting for it." |
| PR-SUB | "Use one subagent to list the files in this directory, then reply DONE." |
| PR-ELICIT | "Call the tool ask_name from the spike server once, then reply DONE." |
| PR-LONG | "Run the shell command `sleep 20`, then reply DONE." |
| PR-BIG | "Run the shell command `seq 1 200000`, then reply DONE." (S11 tool-output file) |

Each uses the account's default model unless a step says otherwise. Budget OQ-X10. Non-deterministic models that never trigger a tool/subagent/rewind: at most two retries, then "not-triggered" (never a pass, never a semantic fail; escalated if core scope).

**P0-T08 — Raw capture, recorder, reducer and privacy check**
- Do:
  - **Recorder** `spikes/shared/record-hook.mjs <agent> <event>`: reads stdin up to 1 MiB, appends `{agent, event, ts_mono_ns, argv_len, stdin_bytes, payload}` to `$XAIBO_SPIKE_RAW/<agent>.jsonl` (git-ignored), writes **0 bytes** to stdout/stderr, exits 0. `--self-test` spawns itself with stdin and asserts 0/0 bytes and exit 0.
  - **Reducer** `spikes/shared/reduce.ts --in <raw> --out spikes/<id>/evidence/` (and `--schema` to emit key-path → JSON-type schema files): keeps only key paths and types, presence counts per event, and allowlisted enum values (`hook_event_name`, `notification_type`, record `type`/`subtype`, `entrypoint`, `source`, `originator`, `role`, content-block `type`, payload `type`, `permission_mode`, usage key names, built-in `tool_name`, public model IDs, agent version). Values must also match `^[A-Za-z_][A-Za-z0-9_.-]{0,40}$` or become `<other>`. Strings/numbers become their type; UUIDs `<session-id>`/`<id>`; absolute paths `~`/`<tmp>`; plan, credit and account fields keep type only. The whitelist is extensible per spike (S9, S11 add their discriminators).
  - **Privacy scanner, written once here:** `scripts/privacy-scan.ts` (stdlib only; `npm run privacy:scan`) with explicit paths and `--stdin`; Phase 1 (P1-T02) only adds `--staged`, `--all`, `--history`, fixture-lint and the pre-commit hook, and P1-T03 moves the one pattern list to `src/shared/secret-patterns.ts`, which the scanner then imports. `reduce.ts` only reduces. Patterns (D-20 plus privacy): absolute home paths (`/Users/`, `/private/`, `/home/`, `C:\Users\`), a UUID not matching `00000000-0000-4000-8000-<12 hex>`, an email outside `example.{com,org,net,invalid}`, `localhost:<digits>` / `127.0.0.1:<digits>` / `[::1]:<digits>`, opaque identifiers (a hex run of ≥32 chars that does not resolve as a git object via `git cat-file -e`, or a base64url token of ≥32 chars that mixes upper case, lower case and digits; plain `[A-Za-z_]` identifiers never match; the one exemption from this opaque rule, and only this rule, is a value of the exact form `"integrity": "sha512-<base64>"` in `package-lock.json` content, including its `+`/`-` diff-line and `--history` forms), every D-20 secret pattern (generic `sk-…`, Anthropic-style, AWS `AKIA…`, GitHub `gh[pousr]_…`, Google `AIza…`, Slack `xox[abpr]-…`, JWT, `Bearer <long>`, PEM private-key header, `scheme://user:pass@`), and the current username/hostname (read at scan time, never written). Per-line `privacy-scan:allow <reason>` suppresses a finding (only on lines that document the patterns themselves); findings print `file:line pattern-id` with the match masked; exit 1 on any finding. It runs over `spikes/`, `docs/plans/`, `test/fixtures/synthetic/`, every handoff file, **and the complete outgoing gate diff** (`git diff -u <base> <gate-sha> -- . ':!package-lock.json' | npm run privacy:scan -- --stdin`). Prompts and transcript content cannot be pattern-detected, so every reduced evidence file is also reviewed by hand against the reducer's allowlist before it is staged. <!-- privacy-scan:allow pattern documentation -->
- Files: `spikes/shared/record-hook.mjs`, `spikes/shared/reduce.ts`, `spikes/shared/reduce.test.ts`, `scripts/privacy-scan.ts`, `test/unit/privacy-scan.test.ts`, `package.json` (`privacy:scan`).
- Test first (U): feed a synthetic raw line with a fake home-directory path (built at test time), a random UUID and `sk-test` text; expect scrubbed reducer output and `privacy-scan` exit 1 on the unscrubbed file. Canary cases generated at test time (never committed), each must exit 1: a loopback port, a 32-char hex non-UUID ID, a 40-char mixed-case base64url token, and one sample per D-20 secret class. Negative cases must exit 0: a file of long camelCase and SNAKE_CASE identifiers (e.g. the names of this plan's env variables), realistic `package-lock.json` integrity lines (`"integrity": "sha512-…"` computed at test time from random bytes, plain and as `+`/`-` diff lines), while a D-20 secret canary on such a line is still flagged, a resolvable git SHA, and a clean synthetic file. Fails before the reducer and scanner exist. Recorder `--self-test` fails before the recorder exists.
- Verify: `npm run spike:test && npm test -- test/unit/privacy-scan.test.ts && npm run privacy:scan -- spikes docs/plans test/fixtures/synthetic`.
- Done-evidence: tests green; the scan passes over everything staged for review.

**P0-T09 — Cleanup rule**
- After each spike block: signal only the supervisors the runner recorded in `$P/<agent>-<slot>/pids`, after checking each supervisor's current start time and argv still match the record; each supervisor stops its whole group and reports any token-carrying survivor outside it (P0-T05). Never select processes by command-line substring such as `pgrep -f`; `guard.ts compare`; reduce raw output, then delete `.cache/spike-results/<spike>/raw/`.
- At Gate 0: delete all raw dirs, throwaway projects and generated bindings; confirm no workspace-scope retention file remains (`find .cache/spike-projects -path '*/.gemini/settings.json'` empty). Keep signed-in profiles until Gate 6 (OQ-B10).
- At retirement: owner logs out inside each temp profile; delete `.cache/profiles/` and any temp keychain item after owner confirmation.
- Done-evidence: every block has a final `MATCH` in `.cache/guard/`; report states "guard clean for all blocks".

**P0-T10 — Report skeleton `docs/plans/phase0_spikes.md` (RED state)**
- Create first, before P0-T01 (T01–T03 record evidence in it); every criterion row pre-filled `UNVERIFIED`. Structure in §0.16.
- Done-evidence: skeleton in the working tree.

**P0-T11 — Progress file** — `docs/plans/xaibo_progress.md` was created with this plan (status: done). Update rule in that file.

### 0.4 S1 — SQLite engine

PRD §10: *Packaged `utilityProcess` opens the DB; WAL/FTS5/transactions work; kill/restart preserves committed events and checkpoints. Choose one engine.* Decision: `node:sqlite` or `better-sqlite3` (never both, §7.4), plus pinned SQLite version and compile options. Closes App. E #6 and part of #20; resolves the App. C `better-sqlite3` row. Maps: S-04, §7.4, FR-09, ROB, learning goal 2.

**P0-S1-T1 — Probe check (RED)** — `spikes/s1/check.ts` launches the packaged app in mode `s1-probe` with temp `XAIBO_DATA_DIR` and asserts each T2 criterion from the JSON report the service sends to main (written to `.cache/spike-results/s1/probe.json`). Script `spike:s1`. Test first (S): fails with "mode not implemented". Deps: P0-T03.

**P0-S1-T2 — Probe in the utilityProcess main thread and in a `worker_threads` worker**
- `spikes/s1/db.ts` with `node:sqlite` `DatabaseSync`:
  1. `sqlite_version()`, `PRAGMA compile_options` (need `ENABLE_FTS5`; record `ENABLE_DBSTAT_VTAB`, threadsafe mode), the module's stability level in Electron's Node docs.
  2. §7.4 pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL` before the first table, `temp_store=MEMORY`), each read back.
  3. FTS5 external-content table (`unicode61`): insert, `MATCH`, `snippet()`, `bm25()`, `INSERT INTO fts(fts) VALUES('integrity-check')`; record `contentless_delete` availability (needed by Phase 5 purge).
  4. `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, a savepoint, prepared-statement reuse over 10,000 executions.
  5. While a write transaction is open on connection 1, read from a second `readOnly` connection; check snapshot isolation.
  6. Online `backup` API (EC-45 recovery path) and `PRAGMA incremental_vacuum` availability.
  7. Any `ExperimentalWarning` on the utility process stderr.
  8. Repeat 2–5 inside a `worker_threads` worker spawned by the utilityProcess (§7.1 writer/parser workers).
- Files: `spikes/s1/db.ts`, `spikes/app/service.ts`. Verify: `npm run dist:mac && npm run spike:s1`. Done-evidence: `probe.json` reduced into the S1 table. Deps: T1.

**P0-S1-T3 — Kill/restart durability** (mode `s1-crash`)
- The service writer commits batches (≤500 rows or 100 ms) of synthetic events plus the source-checkpoint row `(path_id, offset, head_hash)` in one transaction, posting `ack(batch_seq)` only after `COMMIT` returns. The driver SIGKILLs the utility PID at 200 seeded instants (`mulberry32(1)`); main restarts it. After each restart: (a) `PRAGMA integrity_check` = ok; (b) FTS integrity-check ok; (c) per source, persisted event count equals the count implied by its checkpoint offset; (d) every acknowledged `batch_seq` present; (e) `journal_mode` still `wal`. Variant: SIGKILL main 20 times, assert no orphan utility PIDs 2 s later, relaunch, repeat (a)–(e).
- Test first (S): invariants run against a stub writer committing events and checkpoint in two transactions; (c) must fail on at least one kill (proves detection). Then switch to the single-transaction writer.
- Verify: `npm run spike:s1 -- --crash`. Done-evidence: 200/200 and 20/20, with any failure and cause.

**P0-S1-T4 — Fallback (only if T2 or T3 fails for `node:sqlite`)** — stop and report the failing criterion. On approval: install `better-sqlite3@<exact>`, rebuild for the Electron ABI with `npx electron-builder install-app-deps` (any extra toolchain such as node-gyp's Python needs separate approval, OQ-A15), set `npmRebuild` as needed, re-run T1–T3 unchanged against a `better-sqlite3` `db.ts`. Owner: approves install and toolchain.

**P0-S1-T5 — Decision** — § S1 in the report: criterion table, versions and compile options, API stability note (pin Electron; re-run S1 probes on every Electron bump), DBSTAT availability (S12 per-table bytes, else per-table files), `contentless_delete` availability. `record_decision` "SQLite engine". Proposed PRD edits: App. E #6 resolved; App. C `better-sqlite3` "not needed"/"selected"; §7.4 engine sentence.

### 0.5 S3 — Hook forwarder runtime and reporting path

PRD §10: compare packaged Electron-run-as-Node, a minimal standalone packaged forwarder, and native Claude HTTP on supported events; measure dispatch/spawn, forwarder, transport, service, renderer and paint separately; measure synchronous agent wait against a no-Xaibo baseline; pass requires M1/M16, silent failure, authentication, bounded input, native trust, service-down recovery, spool replay and no-system-runtime packaging; HTTP cannot win on spawn time alone; document missing SessionStart support, synchronous wait and hook-only recovery gaps; if no option qualifies, the owner reviews target and implementation.

Decision: forwarder runtime (Q7), per-event-class path (Q17), ack point (OQ-A1). Closes App. E #19, and #18 jointly with S4. Maps: S-05, FR-03, §7.3, SEC2, SEC4, D-7, M1, M7, M16, US-1, learning goal 3. Codex/Gemini live receipt through the same shim is exercised in S5/S11; S3 measures the synchronous path synthetically (covers Codex `SessionEnd`, always sync).

**P0-S3-T1 — Bench and pass/fail check (RED)**
- `spikes/s3/dispatch-bench.ts` (system Node, dev-time) mimics command-hook dispatch: `spawn('/bin/sh', ['-c', <hook command>])`, JSON on stdin, spawn→exit timing, child stdout/stderr byte counts and exit code.
- Assertions per candidate and mode: stdout+stderr = 0 bytes; exit 0; forwarder self-reported entry→exit ≤100 ms including fallback (M16 own deadline); added wait p95 vs baseline command `true` ≤100 ms (M16 sync bound).
- Modes: service up; no socket (spool); socket accepts but never acks (deadline → spool); spool dir on a full 1 MiB disk image (`hdiutil create -size 1m -fs HFS+ -volname xaibo-full <img>.dmg`, `hdiutil attach -nobrowse -mountpoint <dir>`, `hdiutil detach` in cleanup; `attach`, user-level) → silent loss with overflow counter; malformed stdin; 300 KB and 10 MB stdin (truncation flag, bounded read); stdin never closed (deadline); 50 concurrent dispatches.
- n = 1,000 warm runs per candidate per mode, plus the first 10 runs after 60 s idle reported separately.
- Files: `spikes/s3/dispatch-bench.ts`; script `spike:s3`. Test first (S): fails with no forwarder present. Deps: P0-T02.

**P0-S3-T2 — Spike forwarder and stable shim**
- `spikes/s3/forwarder.cts` (single CommonJS file, Node builtins only, also the SEA entry): (1) `t_entry = hrtime`; (2) bounded stdin read at 256 KB with a read deadline, `truncated: true` at the cap, never unbounded; (3) `delivery_id = crypto.randomUUID()` before the first send; (4) connect to `<data>/run/xaibo.sock`, write a frame: 4-byte big-endian length + JSON `{v:1, delivery_id, agent, event, session_id, cwd, received_ts, payload, token, t_entry, t_send}`; (5) wait for a 1-byte ack within the remaining budget (100 ms − elapsed − measured spool reserve); (6) without ack, append the same delivery to `<data>/spool/<date>-<pid>.jsonl` (`O_APPEND`, 0600 in a 0700 dir), stopping at the 50 MB cap and incrementing an overflow counter file; (7) exit 0 on every path — top-level try/catch, `uncaughtException` handler and hard timer all end in exit 0; nothing ever written to stdout/stderr.
- `spikes/s3/shim.sh` models `<appdata>/integrations/bin/xaibo-hook`: `exec` the selected runtime, or `exit 0` silently when app or runtime is missing (EC-27 evidence). Shim cost is part of every candidate's numbers.
- Verify: `npm run spike:s3 -- --candidate system-node` (logic check only; not a candidate) passes output and exit assertions. Deps: T1.

**P0-S3-T3 — Spike service receiver and ack point**
- In `service.ts` mode `s3`: Unix socket created private (0700 dir, `umask` before `listen`, permissions verified, stale socket removed on start); explicit framing; frames >1 MB rejected; per-connection read deadline; `v` and token validated (token in 0600 `<data>/run/token`); validated events published to the renderer port before persistence, paint ack returned; startup replays the spool deduplicated by `delivery_id` (1,000 spooled deliveries with 10% duplicates must end with exactly the distinct count). Two ack points measured: (i) after validation and volatile publish; (ii) after the delivery commits in SQLite (S1 engine) in an immediate small transaction rather than the 100 ms batch window.
- Test first (U/S): socket client tests with a bad token, a 2 MB frame, `v=2`, truncated framing — each rejected without a crash. Fail before the receiver exists.
- Verify: `npm run spike:s3 -- --receiver-tests`. Done-evidence: rejection matrix (informs EC-32), replay dedup result, ack latency p50/p95 for (i) and (ii). Deps: T2, P0-S1-T2.

**P0-S3-T4 — Candidate A: packaged Electron-run-as-Node** — shim runs `ELECTRON_RUN_AS_NODE=1 exec "<app>/Contents/MacOS/XaiboSpike" "<app>/Contents/Resources/app.asar.unpacked/build/s3/forwarder.cjs"`; measure unpacked and once read from inside asar. Verify under `env -i PATH=/usr/bin:/bin` (no system Node reachable): `npm run spike:s3 -- --candidate electron-node`. Done-evidence: timing per mode; note that this candidate requires the RunAsNode fuse to stay enabled (security trade-off). Deps: P0-T03, T3.

**P0-S3-T5 — Candidate B: Node SEA standalone forwarder** — `spikes/s3/sea-config.json` (code cache on and off) plus `spikes/s3/build-sea.sh`: `node --build-sea spikes/s3/sea-config.json` with system Node 26 (if the flag misbehaves, `postject` needs owner approval, OQ-A4); `codesign --remove-signature` then `codesign --sign -`; this task adds the `extraResources` entry to `spikes/app/electron-builder.json` (placed at `Contents/Resources/bin/xaibo-forwarder-sea`) and a `build-sea.sh` step before `dist:mac`, then rebuilds with `npm run dist:mac`. Verify under `env -i PATH=/usr/bin:/bin`: `npm run spike:s3 -- --candidate sea`; record binary size and `.app` size delta. Deps: T3.

**P0-S3-T6 — Candidate C: native Claude HTTP hook**
- Service adds a loopback HTTP receiver on `127.0.0.1` with an ephemeral port (never recorded), applying SEC2 conditional-receiver rules: token header, reject any `Origin`, exact loopback `Host`, JSON content-type only, body ≤1 MB, empty response body, no decision/context fields. In the temp Claude profile, `type: "http"` hooks from `spikes/s3/claude-settings.http.json` (placeholders `<port>`, `<token-ref>` filled at runtime inside the temp profile only). From context7 and `claude --help`, then live: which events accept `http` (SessionStart expected missing); whether http hooks block and the effective timeout when the service is down/hung; whether the auth header can avoid a plaintext token in settings; any user-visible noise when the receiver is down; hook-only evidence loss when down (no spool); interaction with `allowedHttpHookUrls` (informs EC-49).
- Files: `spikes/s3/claude-settings.http.json`, `spikes/s3/claude-settings.command.json`, `service.ts`. Verify: T8 live run plus a synthetic POST bench (system Node `node:http` client) for the receiver hop. Deps: T3, P0-T06.

**P0-S3-T7 — End-to-end hop instrumentation to paint**
- Stamps: `t0` dispatch (bench); `t_entry`, `t_send` (forwarder); `t_recv`, `t_publish` (service); `t_paint_ack` (service receives the renderer's rAF ack). Hops: dispatch/spawn = `t_entry−t0`; forwarder = `t_send−t_entry`; transport = `t_recv−t_send`; service = `t_publish−t_recv`; renderer+paint = `t_paint_ack−t_publish` (upper bound incl. return hop; the sandboxed renderer has no `hrtime`).
- Clock sanity: two processes stamp `hrtime` around a pipe ping 1,000 times; assert `t_send(A) < t_recv(B)` always. If it fails, report hop sums and end-to-end only.
- Test first (S): bench asserts all hop fields present and non-negative; fails before stamps exist. Verify: `npm run spike:s3 -- --e2e` per candidate. Done-evidence: hop table p50/p95/p99/max per candidate; end-to-end p95 vs M1 (≤250 ms). Deps: T4/T5/T6.

**P0-S3-T8 — Live temp-profile Claude runs**
- `guard.ts snapshot s3-pre`. For each candidate (A, B with command hooks, async where supported; C with http) the temp Claude profile runs ≤3 prompts (PR-OK, PR-TOOL). Assert: the packaged service receives SessionStart (or records it unsupported for C), UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd; the transcript has no hook output, no added context and no visible error lines (M7); async hooks do not noticeably delay the turn (coarse comparison vs a no-hook run; the real bound is T1); the service-down run shows no agent-visible noise and A/B spooled deliveries replay on the next service start. `guard.ts compare s3-pre` → `MATCH`. Raw outputs reduced then deleted; only event-name coverage, byte counts, pass/fail and timing aggregates enter the report.
- Deps: T4..T7, P0-T06. Owner: first sign-in; approves unsandboxed agent/app runs and agent network.

**P0-S3-T9 — Decision** — candidate × criterion matrix (M1, M16 own deadline and added wait, 0 bytes/exit 0 in all modes, auth, bounded input, service-down recovery, spool replay, no system runtime, native-trust compatibility of a stable shim path). Choose the smallest qualifying candidate by OQ-A2 ordering; HTTP adopted for an event only if it also meets bounded wait, SEC2 and recovery equivalence (D-7). Record the ack point (OQ-A1). If nothing qualifies, stop and give the owner the evidence (PRD §10). `record_decision` "Forwarder runtime and per-event path". Proposed PRD edits: Q7, Q17 answered; App. E #19 resolved; #18 updated (with S4); §7.3 forwarder-runtime sentence; D-7 note. Done-evidence: § S3 with matrix, hop table, added-wait table, failure-mode matrix, HTTP event-eligibility table, sizes.

### 0.6 S4 — Claude hooks-only plugin (D-2, FR-30, S-05)

PRD §10: disposable profile — install, restart/reload, event receipt, duplicate-install prevention, disconnect, conflict-safe restoration; no skills, MCP definitions or context output; fallback tested separately; `--settings` experiments only if the fallback needs them. Maps: FR-30, FR-32, FR-34, S-05, US-7, M7, D-2, learning goal 6, App. E #1, #2, #18 (plugin share).

**P0-S4-T1 — Verify the CLI surface** — in the temp profile capture help for `claude plugin`, `plugin marketplace`, `plugin install`, `plugin uninstall`, `plugin list`, `plugin validate`, `plugin enable|disable`, and `claude --help` (for `--plugin-dir`, `--settings`). All UNVERIFIED on 2.1.319 until this runs. Files: `spikes/s4/evidence/cli-surface.json` (command names only). Test first (S): checklist of expected subcommands from FR-30; missing ones are recorded fails. Deps: P0-T05, P0-T06.

**P0-S4-T2 — Spike marketplace and plugin** — `spikes/s4/marketplace/.claude-plugin/marketplace.json`; plugin `xaibo-hooks-spike/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` (command hooks, `async: true`, every §5.2 event: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, Elicitation, ElicitationResult, SubagentStart, SubagentStop, Stop, StopFailure, PreCompact, PostCompact, CwdChanged, SessionEnd), and `hooks/record-hook.mjs` (copy of the shared recorder via `node "${CLAUDE_PLUGIN_ROOT}/hooks/record-hook.mjs" claude <event>`). No `skills/`, `commands/`, `agents/`, `.mcp.json`. Copied to `$P/claude-a/marketplace/` (stands in for `<appdata>/integrations/`). Test first (S): `claude plugin validate <dir>` (UNVERIFIED; else Claude's own load errors at session start). Deps: T1.

**P0-S4-T3 — Install, reload, event receipt**
1. Hash-manifest the temp profile tree: `find <profile> -type f -exec shasum -a 256 {} + | sort -k2` into `.cache/spike-results/s4/raw/` (the real-profile guard is not pointed at temp trees).
2. `claude plugin marketplace add <dir>`, `claude plugin install xaibo-hooks-spike@<marketplace>` (UNVERIFIED).
3. Diff the tree; record which files the CLI changed (names relative to the config dir).
4. Check whether hooks activate in a running session or only after restart or `/plugin`/`/hooks` reload (UNVERIFIED).
5. Interactive session via `spikes/s4/session.exp` (expect): PR-OK, PR-TOOL (approve), PR-WRITE (deny), PR-SUB; exit.
6. Reduce recorder output to a per-event payload schema and the list of events fired.
- Files: `spikes/s4/session.exp`, `spikes/s4/evidence/{install-delta,hooks.schema}.json`. Test first (S): before install, the same expect script yields **empty** recorder output. Verify: `in-profile.sh claude a -- expect spikes/s4/session.exp`; `node spikes/shared/reduce.ts --in .cache/spike-results/s4/raw --out spikes/s4/evidence`. Done: every triggerable event received with a schema; others listed "not triggered in spike", never "unsupported". Deps: T2.

**P0-S4-T4 — Zero output, zero tokens, async (M7 feasibility)** — PR-OK twice in fresh sessions, plugin disabled vs enabled; compare the first assistant record's `message.usage` input + cache-read + cache-creation sum: delta must be **0**. No hook output/echo record in the transcript (record-type schema only). A probe variant prints a marker to stdout on SessionStart and UserPromptSubmit: does it reach transcript/context (temp only; justifies the zero-output rule)? Async check: a recorder variant sleeping 2 s; turn completion time differs by <100 ms (aggregate). Record whether any `/plugin` UI shows a token cost (App. E #1); `/context` not used. Files: `spikes/s4/evidence/m7.json`. Test first (S): the marker variant must be detectable (leak or no leak); the silent recorder must show none. Deps: T3.

**P0-S4-T5 — Duplicates, policy, coexistence** — (a) install twice: idempotent, refused, or duplicates; (b) plugin plus a fallback settings hook together: count duplicate deliveries per event (EC-09 input); (c) `disableAllHooks: true` in temp `settings.json`: plugin hooks blocked and detectable from effective config (EC-49 input); (d) temp `settings.json` seeded with a synthetic agent-flow-style foreign hook and a synthetic custom `statusLine`: both byte-identical through install and uninstall (EC-72, US-7 input); (e) whether plugin `hooks.json` accepts `type: "http"` (recording only; S3 owns HTTP). Files: `spikes/s4/evidence/dup-policy.json`, `spikes/s4/seeds/`. Test first (S): expected outcome per sub-case written before running. Verify: expect runs, `shasum -a 256` before/after, reducer. Deps: T3.

**P0-S4-T6 — Disconnect and conflict-safe restoration** — `claude plugin uninstall …`, `claude plugin marketplace remove …` (UNVERIFIED); diff the tree vs the T3 baseline; classify leftovers as Claude-owned or Xaibo-owned. Conflict case: while installed, simulate an owner edit (foreign `enabledPlugins` entry or another key), uninstall: the foreign edit survives. Simulate "uninstalled outside Xaibo" and record how `plugin list` reports it (EC-26 input). Files: `spikes/s4/evidence/restore.json`. Test first (S): baseline-equality check written first; fails while installed. Deps: T3–T5.

**P0-S4-T7 — Fallback (marker-based settings merge), tested separately** — insert hooks into temp `settings.json` (marker = command path under a `xaibo` integrations dir); check receipt; remove and check byte-identity. Only if the fallback needs it: `--settings <file>` merge-vs-replace behaviour and `CLAUDE_CODE_PLUGIN_DIRS`/`--plugin-dir` syntax (App. E #2; UNVERIFIED); otherwise App. E #2 stays open "not required". Files: `spikes/s4/fallback/settings.hooks.json`, `spikes/s4/evidence/fallback.json`. Test first (S): recorder empty before insertion. Deps: T1.

**S4 decision (D-2)** — T3–T6 pass → plugin route adopted, with the exact verified command sequence for FR-30 and the Phase 3 installer; otherwise fallback adopted with the failing criterion named. Either way: the plugin/fallback mutual-exclusion rule (EC-09) and the detection signal (EC-26/EC-49). App. E: #1 (subcommands; token-cost display as observed/not observed), #2 (closed or open "not required"), #18 (plugin-HTTP eligibility, for S3). Fixtures: `test/fixtures/synthetic/claude/2.1.319/hooks/<case>/hooks.jsonl` for simple turn, permission granted, permission denied (manual), subagent — hand-written from the T3 schema (Gate 3 EC-09/EC-64, §6.6 set).

### 0.7 S5 — Codex hooks and trust (FR-31, S-06)

PRD §10: pin 0.160.0; untrusted hooks do not execute; explicit approval activates them; a changed hook needs renewed trust; uninstall preserves foreign hooks; plugin route optional. Maps: FR-31, S-06, US-7, M7/M16 feasibility, App. E #5, §5.3.

**P0-S5-T1 — CLI and config surface** — capture `codex --help` (look for `hooks`, `plugin`, `app-server`, `resume`, `fork`, `exec`, `login`); which config enables hooks (`$CODEX_HOME/hooks.json` and/or `[features]` flag or `[hooks]` table in `config.toml`); trust UX entry points (TUI prompt, `/hooks`, a `codex hooks …` subcommand). All UNVERIFIED: confirm against 0.160.0 docs via context7, then by observation. Files: `spikes/s5/evidence/cli-surface.json`. Test first (S): checklist from §5.3 and FR-31. Deps: P0-T05, P0-T06.

**P0-S5-T2 — Untrusted hooks do not execute** — temp `$CODEX_HOME/hooks.json` with recorder command hooks for all 12 0.160.0 events (SessionStart, SessionEnd, SubagentStart, SubagentStop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop, Interrupt; `async` where the schema allows), plus one synthetic **foreign** hook with a separate recorder tag. Interactive `codex` via `spikes/s5/session.exp` with PR-OK, PR-TOOL. Expect zero Xaibo recorder lines. Record how the untrusted state is shown (wording category only) and whether a rollout is still written (EC-25 premise). Files: `spikes/s5/{hooks.json,session.exp}`, `spikes/s5/evidence/untrusted.json`. This step *is* the negative test: `test ! -s .cache/spike-results/s5/raw/codex.jsonl`. `--dangerously-bypass-hook-trust` is **never** used. Deps: T1.

**P0-S5-T3 — Explicit approval activates hooks** — approve through the verified trust UX (Claude drives it with expect; owner may watch, OQ-B5). Re-run PR-OK, PR-TOOL (approve), PR-WRITE (deny), an interrupt during PR-LONG (Esc/Ctrl-C). Reduce per-event payload schemas. Record: which events accept `async` (`SessionEnd` expected always sync); that empty stdout is accepted; whether stdout from a marker variant reaches rollout/context (temp only); that PreModelRequest/PostModelRequest are absent (EC-53 input); where trust is stored (location category only; Xaibo never writes it). Files: `spikes/s5/evidence/{hooks.schema,trust}.json`. Test first (S): T2's empty result is the RED baseline. Deps: T2.

**P0-S5-T4 — A changed hook needs renewed trust** — edit the Xaibo hook command (add an argument), and separately change only the script content behind an unchanged path; confirm execution stops until renewal; record whether a content-only change is detected (hash covers command string vs file) — input to the Phase 3 stable-shim design (EC-46). Files: `spikes/s5/evidence/retrust.json`. Test first (S): expected "stops" written first; recorder empty after change, non-empty after renewal. Deps: T3.

**P0-S5-T5 — Uninstall preserves foreign hooks** — remove Xaibo entries by text edit; foreign entry bytes unchanged (`shasum` over the extracted span) and the foreign hook still runs; record whether its trust survived; record leftover trust records as Codex-owned (document, never delete). Files: `spikes/s5/evidence/uninstall.json`. Test first (S): foreign-entry hash taken before the edit. Deps: T3.

**P0-S5-T6 — Optional Codex plugin route** — only if T1 found a plugin subcommand (UNVERIFIED): install a hooks-only Codex plugin from a local dir and repeat T2–T5 in short form; otherwise record "plugin route unavailable on 0.160.0". Files: `spikes/s5/plugin/**` (only if attempted). Deps: T1.

**S5 decision** — FR-31 route (`hooks.json` default, or plugin); the guided trust steps Phase 3 must present; async/sync matrix per event (feeds M16). App. E #5 closed. Fixtures: `test/fixtures/synthetic/codex/0.160.0/hooks/<case>/` for simple turn, permission granted, permission denied, interrupted turn, untrusted-installed state (EC-25, EC-70 at Gate 3; EC-53 at Gate 2).

### 0.8 S6 — Codex interoperability (Q3, compatibility matrix)

PRD §10: record visibility, loadability, ownership and approval recipient separately per surface/version; a negative attachment result is acceptable (external sessions stay observe-only). Maps: S-12, S-22, FR-20–23, US-8, learning goals 4–5, App. E #4 and #14 (Codex half), Q3; EC-05/50/68/74 inputs.

**P0-S6-T1 — Same-profile CLI surfaces** — in `codex-a`: (a) interactive TUI with PR-OK, exit, then `codex resume <id>` (FR-21) and `codex fork <id>` (FR-22) — record exact syntax (UNVERIFIED); (b) `codex exec "<PR-OK>"`: do exec sessions appear in the resume picker, and which resume form works for the exec kind (EC-50 UNVERIFIED flag); (c) reduce `session_meta.source`/`originator` values per surface (EC-05/EC-74 input). Files: `spikes/s6/session.exp`, `spikes/s6/evidence/cli-matrix.json`. Test first (S): matrix rows pre-filled with expected values from PRD §2.3. Verify: expect runs; reducer over temp `sessions/**/rollout-*.jsonl`. Done: every cell yes/no/partial/untested+reason. Deps: P0-S5-T1, P0-T06.

**P0-S6-T2 — app-server threads** — `spikes/s6/app-server-probe.ts` (stdlib JSON-RPC over stdio) spawns `codex app-server` (UNVERIFIED invocation): `initialize`, `thread/start`, `turn/start` with PR-OK, `thread/list`, `thread/loaded/list`, `thread/read`. Record notifications seen (`thread/status/changed`, `turn/*`, `item/*`, `thread/tokenUsage/updated`), whether the thread is listed in the `codex resume` picker, and its rollout `source`. Optionally `codex app-server generate-ts --out .cache/spike-results/s6/bindings` for method names only; not committed (OQ-B17). Files: `spikes/s6/app-server-probe.ts`, `spikes/s6/evidence/app-server.json`. Test first (S): the probe fails cleanly with a recorded error on a wrong method name. Done: app-server-thread visibility in the CLI picker recorded (EC-68 input). Deps: T1.

**P0-S6-T3 — Attach to a live external thread; approval recipient** — start TUI session X with PR-LONG in default approval mode so a permission prompt is pending; the probe calls `thread/resume` (or `thread/loaded/list` then read) on X. Record whether it attaches, receives `thread/status/changed` and `item/*/requestApproval`, which client receives the approval (TUI only, probe only, both), what happens if both answer; check the process table for a shared daemon (process names only). Files: `spikes/s6/attach.exp`, `spikes/s6/evidence/attach.json`. Test first (S): expected default "no attach, observe-only" written first. Deps: T2.

**P0-S6-T4 — VS Code extension (conditional)** — only if the Codex extension honours `CODEX_HOME` from the environment (UNVERIFIED). The owner launches VS Code from their own terminal with isolated `--user-data-dir` and `--extensions-dir` under `$P` via `in-profile.sh codex a -- "<VS Code app>/Contents/Resources/app/bin/code" …` (`code` is not on PATH), installs the extension there and signs in if asked; the owner's real VS Code is not running, and the step is bracketed by `guard.ts snapshot/compare`. Record both directions (T1 session visible/loadable in VS Code; VS Code session in `codex resume`) and the `source` value. Otherwise "untested: extension reads real profile" (OQ-B4). Files: `spikes/s6/evidence/vscode.json`. Owner: launches VS Code and installs the extension in the isolated dir.

**P0-S6-T5 — Codex Desktop (conditional)** — same approach, only if Desktop honours `CODEX_HOME` when started from a terminal with env (UNVERIFIED); else "untested (real profile only)". Never observe the real profile. Files: `spikes/s6/evidence/desktop.json`. Owner: launches the app, if attempted.

**P0-S6-T6 — Compatibility matrix (Codex rows)** — columns: agent/version; origin surface; observing surface; visible; loadable/resumable; live attach; ownership/control; approval recipient; evidence file. Surfaces: TUI, exec, app-server, VS Code, Desktop. Files: `phase0_spikes.md` (S6). Verify: `npm run privacy:scan`. Done: every cell filled. Deps: T1–T5.

**S6 decision** — Q3 closed (attach to externally owned threads yes/no; if negative: live control only for Xaibo-started threads, external sessions observe-only); FR-21/22 verified resume and fork syntax; EC-50 resume form per kind; EC-68 input (hidden app-server threads → v1-A launches as interactive TUI or documented limit). App. E #4, #14 (Codex half). Fixtures: `test/fixtures/synthetic/codex/0.160.0/rollout/<surface>/` with `session_meta` per source kind and a synthetic originator for the cross-agent case (EC-05, EC-50, EC-74 at Gate 2).

### 0.9 S7 — Claude interoperability (Q12, §6.2 semantics)

PRD §10: separate external-TUI history visibility from later PTY hosting (S2); exercise manual denial, cancelled input, foreground Stop with background work, child completion; Desktop listing and `--bg`/attach are optional. Maps: FR-20–23, US-8, §6.2, learning goal 4, App. E #3, #13, #14 (Claude half), Q12; EC-40/41/67/70 inputs.

**P0-S7-T1 — Launch and resume primitives** — interactive TUI with pre-allocated `--session-id 00000000-0000-4000-8000-000000000001` (synthetic, fixed, unique per temp profile); transcript lands at `<config>/projects/<enc>/<id>.jsonl` with `entrypoint: cli` (FR-20); `claude --resume <id>` (D-8); `--fork-session` gives a new ID (FR-22); a `claude -p` session is hidden from the picker but resumable by ID (re-verified on 2.1.319); existence only of `--bg`/attach and `--desktop` (UNVERIFIED, Q12; `--desktop` not exercised). Files: `spikes/s7/launch.exp`, `spikes/s7/evidence/launch.json`. Test first (S): expected rows from FR-20–22. Verify: expect runs; temp projects dir reduced to the encoded-name pattern only. Deps: P0-T06; S4-T3 (recorder plugin) or temp recorder hooks.

**P0-S7-T2 — Manual denial and permission evidence** — PR-WRITE in default permission mode, deny at the prompt; record ordered events by `tool_use_id` (PermissionRequest / Notification `permission_prompt`, then what follows); confirm PermissionDenied does **not** fire (auto-mode only); repeat once in auto mode if the temp account allows, to capture PermissionDenied. Files: `spikes/s7/deny.exp`, `spikes/s7/evidence/deny.json`. Test first (S): §6.2 "manual denial detection must not depend on PermissionDenied" as the assertion. Done: the manual-denial evidence chain identified or recorded absent (App. E #13).

**P0-S7-T3 — Input requests (accepted, declined, cancelled)** — `spikes/s7/elicit-mcp.ts`, a stdlib MCP stdio server whose tool `ask_name` issues `elicitation/create`; registered in the temp profile only (`claude mcp add --scope user …`, UNVERIFIED syntax; OQ-B14). PR-ELICIT three times: accept, decline, cancel (Esc). Record Elicitation and ElicitationResult (App. E #13), Notification types seen, and `idle_prompt` after ~60 s idle (must not be an input request). Files: `spikes/s7/{elicit-mcp.ts,elicit-mcp.test.ts,elicit.exp}`, `spikes/s7/evidence/input.json`. Test first (U): `elicit-mcp.test.ts` JSON-RPC handshake over a pipe; fails before the server exists. Done: the validated input-request notification type named, or "none".

**P0-S7-T4 — Stop with background work, child completion, interrupt** — (a) PR-BG: Stop fires while `sleep 30` runs; what marks background completion (Notification, transcript record, nothing); (b) PR-SUB with a background subagent if supported: order of SubagentStart, SubagentStop, Stop; (c) interrupt PR-LONG with Esc: events and transcript markers (EC-70 input); (d) monotonic Stop→last-child-signal timing (aggregates) for the 4 s turn-settle default. Files: `spikes/s7/bg.exp`, `spikes/s7/evidence/background.json`. Test first (S): §6.2 "Finishing…" sequence written first. App. E #3.

**P0-S7-T5 — VS Code extension history and open URL (conditional)** — as S6-T4 with `CLAUDE_CONFIG_DIR` honoured (UNVERIFIED): T1 session in the extension history; `vscode://anthropic.claude-code/open?session=<id>` opens it — never via macOS `open` (Launch Services would route the URL to the owner's real VS Code and real extension); the owner, with their real VS Code not running, runs `in-profile.sh claude a -- "<VS Code app>/Contents/Resources/app/bin/code" --user-data-dir <P>/vscode --extensions-dir <P>/vscode-ext --open-url '<url>'`; if routing to the isolated instance cannot be guaranteed, record "untested (would route to real profile)" and rely on the P7-T09 U test of URL construction; an extension-origin session resumable from the CLI (`entrypoint: claude-vscode`). Otherwise untested with reason. The owner step is bracketed by `guard.ts snapshot/compare`. Files: `spikes/s7/evidence/vscode.json`. Owner: isolated VS Code, extension, `--open-url`.

**P0-S7-T6 — Desktop listing and Desktop-origin resume (optional)** — only if Claude Desktop can use the temp config (UNVERIFIED); else "untested (real profile only)" and EC-67 defaults to view-only with a reason (OQ-B4). Files: `spikes/s7/evidence/desktop.json`.

**P0-S7-T7 — Compatibility matrix (Claude rows)** — same columns as S6-T6 plus "entrypoint value"; surfaces TUI, `-p`/SDK, VS Code, Desktop, `--bg`. Verify: `npm run privacy:scan`. Deps: T1–T6.

**S7 decision** — Claude half of the matrix; §6.2 confirmations (input-request evidence, manual-denial evidence, ElicitationResult support, background-completion evidence; unverified rows stay UNVERIFIED and heuristic); EC-67 behaviour (CLI resume or view-only); Q12 (`--desktop` existence; "Not in MVP" stands). App. E #3, #13, #14 (Claude half). Fixtures: `test/fixtures/synthetic/claude/2.1.319/hooks/<case>/{hooks.jsonl,expected.json}` for manual denial, auto-mode denial (if captured), `idle_prompt` without input request, needs-input accepted/declined/cancelled, background work after Stop, subagent completion, interrupted turn (EC-40/41/70 at Gate 3).

### 0.10 S9 — Format survey

PRD mapping: S-02, S-03, S-04, S-10, S-25, S-35; FR-02, FR-08, FR-13, FR-47, FR-51; §2.3, §5.2, §5.3, §5.5, §5.8, §5.11, §6.6; US-3, US-15; App. E #8, #11, #24 (Codex part); App. F.

§10 criteria, numbered for the report: **S9-C1** versions pinned; **C2** synthetic fixtures cover usage semantics; **C3** identifiers; **C4** unknown records; **C5** partial and huge lines; **C6** cleanup; **C7** optional compressed and metadata files (`.jsonl.zst`, Claude `sessions/*.json`, `claude agents --json`, Codex `session_index.jsonl`, state-DB names); **C8** unsupported optional formats produce coverage warnings. C2–C5 are required scope; C6–C7 optional (a negative result narrows scope).

**P0-S9-T1 — Pin and record versions** — `claude|codex|gemini --version` through the runner; compare with PRD §2.3; record in the report header and every S9/S11 evidence entry. Test first (S): header holds `2.1.319 / 0.160.0 / 0.46.0` as UNVERIFIED before the probe. Owner: any difference stops the phase (entry criterion 5). Deps: P0-T05.

**P0-S9-T2 — `scripts/audit-sources.ts` (aggregated counts only)**
- Read-only TypeScript run by Node 26 type stripping, no dependencies. Roots default per App. F: `~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, `${GEMINI_CLI_HOME:-~}/.gemini/tmp/*/chats`; honours `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`; `--claude-root|--codex-root|--gemini-root` overrides for tests.
- JSONL streamed with a manual chunk splitter capped per line; over-cap lines counted, not buffered; files opened read-only; `lstat`; symlinks leaving a root skipped.
- Output per agent, aggregated only: file count; counts per entrypoint/source kind; record-type histogram; unknown-record share vs the pinned known-type list; partial-trailing, malformed, oversize line counts; `.jsonl.zst` count; Claude `sessions/*.json` count; Gemini legacy `.json` chat count. Only discriminator values matching `^[A-Za-z_][A-Za-z0-9_.-]{0,40}$` print; else `<other>`. Never paths, IDs, cwd, timestamps, content or per-file sizes. Never writes; exits 0.
- Files: `scripts/audit-sources.ts` (§7.2), `test/unit/audit-sources.test.ts`, `test/fixtures/synthetic/audit/{claude,codex,gemini}/…`.
- Test first (U): the test runs the script on a synthetic tree containing a canary path segment, canary session ID, canary content string, one unknown type, one partial line, one malformed line and one `.zst` file (generated at test time with `node:zlib` `zstdCompressSync`, OQ-X5); asserts histogram and counts and that no canary appears in stdout. Fails first (no script).
- Verify: `npm test -- test/unit/audit-sources.test.ts`; `npm run typecheck`. Maps: App. F, P5, EC-62 spirit.

**P0-S9-T3 — Reduced real-store facts (owner-run, PRD §8 owner-started real-data exception)** — this is the only Phase 0 step that touches real agent stores, recorded as an explicit exception in AGENTS.md (owner decision D-P0-04). Claude never runs it and never sees its raw output. The owner runs `node scripts/audit-sources.ts` in their own terminal (OQ-C1) and answers a fixed, numberless questionnaire: (a) `.jsonl.zst` present, in which agent store? (b) entrypoint/source-kind values beyond the PRD lists (names); (c) record types outside the pinned list (names); (d) any agent with unknown share >5% (Y/N); (e) Claude `sessions/*.json` present (Y/N); (f) Gemini legacy `.json` chats present (Y/N); (g) partial/malformed/oversize lines present (Y/N per kind). The owner vets every name; anything user-like is `<other>` (OQ-C15). Files: `phase0_spikes.md` (answers only). Verify: answers contain no digits apart from version strings (privacy grep). Maps: S9-C4, C7; EC-03, EC-04, EC-05. Owner: runs and answers.

**P0-S9-T4 — Temp-profile recordings and schema extraction (Claude, Codex)**
- Temp profiles, throwaway project `.cache/spike-projects/s9/`, guard before/after every session. Prompts: PR-OK; one approved tool call; Claude: one subagent call and one `/compact` (spike-only, OQ-B15); Codex: one interactive session (source `cli`), one `codex exec` (source `exec`), one `/compact`.
- Schema extraction with `reduce.ts --schema` (whitelist extended with S9 discriminators). Raw recordings stay in `.cache/` and are never committed.
- Facts, each an S9-C2/C3/C7 row: **Claude identifiers** — `sessionId`, `uuid`, `parentUuid`, multi-line `message.id` partial updates (is usage repeated per partial line so "latest wins" is correct?), subagent file location and link to parent. **Claude format** — `entrypoint` values, injected-content prefixes (§5.2 filter list), compaction record shape incl. any `postTokens`, `message.model`, `message.usage` key set incl. cache-creation sub-classes and tier qualifiers, which fields carry large payloads (EC-15). **Claude metadata** — schema and lifetime of `<config>/sessions/*.json` (pid-bearing? removed on exit?), whether `claude agents --json` exists and its schema. **Codex** — rollout path/filename pattern, session ID in filename vs `session_meta`, all record types; `token_count` key sets (`info.total_token_usage`, `last_token_usage`, `model_context_window`, `rate_limits` primary/secondary, window unit, `resets_at` unit), booleans cached ⊆ input and reasoning ⊆ output (EC-93); `token_usage_record` presence; `turn_context` model and reasoning-effort field name (FR-51); mirrored user/agent message pairs; `compacted` shape; `session_index.jsonl` schema; state-DB file names and version suffix only (never opened). **Compressed** — does either agent write `.jsonl.zst` in a fresh profile (with T3 (a)).
- Files: `spikes/s9/schemas/claude-2.1.319.schema.json`, `spikes/s9/schemas/codex-0.160.0.schema.json`.
- Test first (S): `reduce.ts` schema self-test on a synthetic line asserts only whitelisted strings survive.
- Verify: self-test; `grep -E '"[^"]*(/|@)[^"]*"'` finds no values in the schemas; guard `MATCH` per session.
- Done-evidence: two schema files; each fact row pass/fail/not-triggered/unsupported with the version pin. Deps: T1; profiles shared with S4/S5/S7. Owner: sign-in (P0-T06); network/keychain authorization for agent runs.

**P0-S9-T5 — Runtime zstd and compressed-history decision** — in the packaged spike app the `utilityProcess` (mode `s9-zstd`) runs `spikes/s9/zstd-probe.ts`: reports Electron and its Node version and `typeof zlib.createZstdDecompress`; stream-decompresses a synthetic two-line `.jsonl.zst` and a synthetic ~100 MB stream generated into `.cache/spike-data/s9/`; records peak RSS; writes JSON to `.cache/spike-results/s9/`. Decision for EC-03 at Gate 1: "streaming decompress" or "list as compressed, not imported, with coverage warning". No zstd package proposed. Test first (S): decompressed line count equals generated count; fails first. Maps: S9-C7, C8; EC-03 (S half); App. E #8. Deps: P0-T03.

**P0-S9-T6 — Claude cleanup age semantics (App. E #11)** — temp `CLAUDE_CONFIG_DIR` with user-scope `settings.json` `cleanupPeriodDays: 1` (never project scope, never 0). `spikes/s9/plant-cleanup.ts` plants synthetic transcripts under `projects/<encoded synthetic cwd>/` shaped from the T4 schema: four sessions covering file mtime old/new × last-record timestamp old/new (`fs.utimes`), plus one subagent file and one session directory. Launch `claude` in the throwaway project (first unauthenticated; if cleanup does not run, one PR-OK after sign-in); observe after ~30 s, after quit, after a second launch. Record age basis (mtime, last record, other), trigger (startup, periodic), whether subagent files and empty dirs are removed, names of other cleaned dirs. Inconclusive → App. E #11 stays UNVERIFIED and EC-23 keeps its estimate label. Test first (S): expected quadrant outcomes written first. Verify: runner sentinel check before launch; guard before/after. Maps: S9-C6; S-10, S-25, FR-13, FR-33; EC-23, EC-73 context.

**P0-S9-T7 — Synthetic fixture set per pinned version** — hand-authored from the reduced schemas (no recorded line copied) under `test/fixtures/synthetic/claude/2.1.319/<case>/` and `codex/0.160.0/<case>/` (Gemini from S11-T4). Cases: `usage-basic` (Claude partial `message.id` updates; Codex cumulative and latest `token_count`); `identifiers`; `unknown-records` (one session above and one below 5% unknown share); `partial-line` (trailing partial plus one malformed complete line); `compaction`; `entrypoints` (every entrypoint/source kind incl. non-interactive); `rate-limits` (Codex); `model-effort`; `compressed-source` (plain `.jsonl`, zstd-compressed at test time); `sessions-meta` (only if T4 shows it exists); `canary` (one fake credential-shaped string, assembled at test time where a literal would trip scanners). Huge-file cases are not committed; the large-payload fields go to the report for Phase 1 `scripts/gen-perf-corpus`. Each case has `expected.json` with only S9-verified facts (record-type histogram, unknown count, identities, normalized usage components), written before its input lines. Synthetic identity pattern per §2.6 (OQ-X5). Committed at the final path in Phase 0 (OQ-B9). Verify (must print nothing): `grep -rnE "/Users/|$USER|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}" test/fixtures/synthetic`; `grep -rhoE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' test/fixtures/synthetic | grep -v '^00000000-0000-4000-8000-'`; a one-line `node -e` `JSON.parse` over every fixture line except those marked malformed; `npm run privacy:scan -- test/fixtures/synthetic`. Maps: S9-C2–C5; §6.6; EC-04/05/14/16/50/51/93/94/95/101. Deps: T4, T5. <!-- privacy-scan:allow pattern documentation -->

**P0-S9-T8 — S9 report section and decision** — per-criterion evidence and one decision: supported fact set per version; EC-03 handling; Claude `sessions/*.json` and `claude agents --json` used or not used (not used narrows §5.1). Proposed App. E edits #8, #11, #24 (Codex part). `record_decision`. Test first (S): no criterion left UNVERIFIED without a stated consequence. Deps: T1–T7.

### 0.11 S10 — Network (zero attempted non-loopback connections)

PRD §10: packaged main, service, renderer and forwarder; exercise startup, idle, errors, shutdown and dependencies; pass requires zero attempted non-loopback connections, not merely zero successful requests. Decision: the P2 policy settings that suffice (Chromium switches added only when an attempt is observed; whether `--use-mock-keychain` is needed to avoid keychain access), the audit method Gate 1 E2E reuses, and M4/M5 idle baselines. Spike evidence for EC-60 (Gate 1). Maps: S-14, P2, SEC1, M6, US-12, §1.6 items 6–7. Runs last, on the final spike app.

**P0-S10-T1 — OS-level attempt audit with positive control (RED first)** — `spikes/s10/audit.sb` Seatbelt profile: `(allow default)`, deny `network-outbound` to any non-loopback IP, allow loopback and the app's Unix socket, deny the `mDNSResponder` socket so DNS lookups show as denials (SBPL syntax checked against `/usr/share/sandbox/*.sb`). `spikes/s10/run-audit.sh <scenario>` runs `sandbox-exec -f audit.sb <app binary>` with temp `XAIBO_DATA_DIR` (children inherit), then collects `log show --start <t0> --predicate 'sender == "Sandbox"'` filtered to the XaiboSpike tree into `.cache/spike-results/s10/` (redacted). Positive control: a control build that attempts TCP to `192.0.2.1:443` (RFC 5737) and a DNS lookup of `example.invalid` (RFC 2606) from main, service and forwarder; the audit must report ≥1 attempt per process. Files: `spikes/s10/{audit.sb,run-audit.sh,control.ts}`. Test first (S): the control yields FAIL — proves the detector. Verify: `npm run spike:s10 -- --control`. Owner: runs or approves `sandbox-exec` outside the Claude sandbox (Seatbelt cannot nest). Deps: P0-T03.

**P0-S10-T2 — Supplementary recorders (not proof alone)** — Chromium NetLog via `app.commandLine.appendSwitch('log-net-log', <data>/netlog.json)` (spike env only), parser flags URL_REQUEST/DNS/SOCKET events with non-loopback hosts; Node `diagnostics_channel` subscribers on `net.client.socket` and HTTP/undici channels; `lsof -nP -i -a -p <pids>` every 250 ms. Files: `spikes/s10/parse-netlog.ts`, `spikes/app/{main,service}.ts`. Verify: on the control build NetLog shows the `example.invalid` attempt.

**P0-S10-T3 — Scenario driver plus idle baseline** — `spikes/s10/scenarios.ts` on the final spike app (S1 DB code, S3 receiver, both forwarder candidates): cold start; 5 min idle window open; 5 min window closed (tray, collecting); renderer crash (`webContents.forcefullyCrashRenderer`) and reload; service SIGKILL and restart; forwarder A and B with service down and up; DB open error (unwritable data dir); blocked `window.open('https://example.invalid')` and navigation (cancelled by policy before any socket → zero OS-level attempts); quit. RSS and %CPU of all XaiboSpike PIDs every 1 s (`ps -o rss=,pcpu=`). Test first (S): driver asserts each scenario reached its marker. Verify: `npm run spike:s10`. Done-evidence: scenario × process attempt matrix (OS log, NetLog, Node channels); idle RSS/CPU for scenarios 2–3 as M5/M4 baselines (not gate passes). Deps: T1/T2, P0-S1-T5, P0-S3-T9.

**P0-S10-T4 — Decision** — zero attempts in every scenario (or each attempt with source, fix and re-run); positive-control proof; sufficient policy list; residual gaps (Seatbelt deprecation, DNS-via-mDNSResponder assumption); how Gate 1 reuses the audit (EC-60) and the re-run before v1-C with the MCP process. `record_decision` "Network denial and audit method".

### 0.12 S11 — Gemini and catalog

PRD mapping: S-01, S-27, S-28, S-35; FR-01, FR-06–FR-08, FR-20, FR-21, FR-25, FR-33, FR-34, FR-51; §5.4, §5.5, §5.9, §5.10, §5.11 (Gemini), §5.12, §6.8, §7.3 catalog schema v1, §7.6; SEC5; US-13, US-15, US-19; M7/M15/M16 feasibility; D-14, D-19; App. C (validator); App. E #16, #17, #24 (Gemini part); Q15, Q18, Q20.

Criteria: **S11-C1** hooks and empty output; **C2** actual transcript path; **C3** content, thought, tool coverage incl. subagents and tool-output files; **C4** patch, rewind, legacy semantics; **C5** permission correlation; **C6** profile override; **C7** native retention (`maxAge` format, enabled/disabled, effective value, policy precedence, execution); **C8** interactive launch/resume; **C9** generic maps; **C10** synthetic custom-agent schema; **C11** unsupported facts explicit; **C12** JSON Schema validator selected. Proposed classification (OQ-C14): C1–C5 core-required (a miss returns to the owner); C6–C8 and C11 conditional (negative narrows scope); C9, C10, C12 catalog-required (D-14).

**P0-S11-T1 — Gemini disposable profile and profile override** — two layouts through the runner's `--gemini-layout unset|custom` mode (P0-T05): (a) `HOME=.cache/profiles/gemini-a/home`, `GEMINI_CLI_HOME` unset → profile expected at `home/.gemini`; (b) same `HOME` plus `GEMINI_CLI_HOME=.cache/profiles/gemini-a/cli-home` → expected at `cli-home/.gemini`, nothing written to `home/.gemini` (S11-C6). Credential-backend check, auth probe and sign-in per P0-T06; record auth-state file names only; disable auto-update with the key confirmed in the installed package. Test first (S): expected roots for (a)/(b) written first. Verify: `find .cache/profiles/gemini-a -maxdepth 3 -name .gemini`; guard `MATCH`. Owner: sign-in; network/keychain authorization.

**P0-S11-T2 — Hooks, empty output, permission correlation**
- Event set from `gemini --help` and the installed package's settings schema/docs (reading the installed Apache-2.0 package is allowed; behaviour confirmed only by a run). In temp user-scope `settings.json`, subscribe command hooks to every lifecycle event that exists, at minimum the §6.8 set: `SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`, `SessionEnd`; record existing but unsubscribed events (e.g. `AfterModel`).
- Hook command: `node <repo>/spikes/shared/record-hook.mjs gemini <event>`.
- Variants: (i) empty output — agent proceeds, no warning, no injected context (check the chat file); (ii) 2 s sleep on `BeforeTool` — blocking and added wait (M16 feasibility); (iii) crashing recorder — fail open?; (iv) untrusted folder — hooks disabled? (native folder trust never bypassed, §7.6); (v) any required hooks-enable flag.
- Permission correlation: shell-tool prompt in default approval mode; approve once, deny once, cancel once. Record whether `Notification` carries `notification_type=ToolPermission`, which correlation key (if any) links it to `BeforeTool`/`AfterTool`, what fires on deny and cancel. An unmatched resolution stays unresolved (§6.8, EC-83).
- Schemas via `reduce.ts --schema` with `hook_event_name`, `notification_type`, built-in tool names whitelisted.
- Files: `spikes/s11/schemas/gemini-0.46.0-hooks.schema.json`. Test first (S): recorder `--self-test` (P0-T08). Verify: hook-log event names match the subscribed set; guard `MATCH`. Done-evidence: S11-C1, C5 rows with variant results; added-wait observation tagged "spike, not gate evidence". Owner: interactive approval steps if expect fails (OQ-C8). Maps: M7, M16; EC-52, EC-83 inputs; FR-06; §6.8.

**P0-S11-T3 — Transcript path, content, thought, tool and subagent coverage** — locate chat files (`find "$GEMINI_CLI_HOME/.gemini/tmp" -path '*/chats/*'`); record the placeholder pattern (`tmp/<project-key>/chats/<file>`): hash or slug key, JSONL or legacy JSON, which metadata record carries session identity (§5.9: never the filename), where subagent chats live and link to the parent, where large tool outputs go. Prompts: PR-OK, PR-TOOL, PR-BIG (tool-output file), a subagent request if 0.46.0 has subagents (else "unsupported"), one thinking-capable model run if offered. Record prompts/responses/thoughts/tool args/results present (Y/N), per-message `model`, any effort/thinking-level field (FR-51: omitted unless shown). Files: `spikes/s11/schemas/gemini-0.46.0-chat.schema.json`. Test first (S): coverage rows pre-filled UNVERIFIED. Maps: FR-08, FR-51, US-15, US-19; EC-81, EC-101, EC-102 inputs.

**P0-S11-T4 — Folding and Gemini fixtures** — observe repeated message IDs during streaming, `$set` metadata patches, the effect of the version's rewind command (`/rewind` or 0.46.0 equivalent); record exact operation names and shapes. Legacy conversion: find the logic in the installed package source, plant a synthetic legacy `.json` chat (`spikes/s11/plant-legacy.ts`, shape from source) in the temp profile, launch, observe conversion/replacement (old file renamed or deleted? duplicate session? EC-80). Fixtures: `test/fixtures/synthetic/gemini/0.46.0/{basic-turn,repeated-id,set-patch,rewind,legacy-conversion,tool-output-file,missing-tool-output,subagent,tokens}/`, each `expected.json` (current projection, superseded/rewound revisions, usage contributions) written from observed semantics before its inputs. Verify: same fixture checks as P0-S9-T7. Maps: §5.5, §5.9; EC-80, EC-81 (Gate 2).

**P0-S11-T5 — Token semantics (§5.11 Gemini, §5.12)** — booleans only on recorded `tokens.input/output/cached/thoughts/tool/total`: cached ⊆ input? thoughts ⊆ output or separate? tool counted in input? total = Σ of which? any model window present? Output: a normalization rule table or "unverified → Unavailable". Files: report plus `tokens` fixture `expected.json`. Test first (S): hypothesis table pre-filled UNVERIFIED; each relation holds on every recorded message or is marked mixed/unverified. Maps: FR-47, FR-48; EC-94, EC-95; App. E #24.

**P0-S11-T6 — Native retention semantics (D-19, EC-90 input)** — from the installed package schema and source: `general.sessionRetention` keys (`maxAge`, plus any `enabled`, count or minimum keys), `maxAge` format (`45d`, other units), invalid-value handling, default when unset (enabled? 30 days?), disabled semantics, effective-value precedence across system defaults, user, workspace and system override. Runtime precedence on temp files only: user scope in the temp profile; workspace scope in `.cache/spike-projects/s11/.gemini/settings.json`, deleted immediately after; system scope only if an env var relocates the system settings path — **never write system folders**; otherwise "source-read, not runtime-verified" (OQ-C11). Execution test: `spikes/s11/plant-retention.ts` plants synthetic old chats (mtime old vs metadata start time old) with the smallest valid `maxAge`; record which files are deleted, when, on what age basis, and whether tool-output files go. Test first (S): quadrant expectation table first. Verify: runner sentinel; afterwards `find .cache/spike-projects -path '*/.gemini/settings.json'` empty; guard `MATCH`. Owner: approves narrowing if unverifiable (default: do not show the `maxAge` offer). Maps: FR-33, FR-34, §5.9, §7.6; EC-90 (Gate 6), EC-81.

**P0-S11-T7 — Interactive launch and resume** — structured argv, no shell: `gemini` in the throwaway cwd, driven by Claude with macOS `expect` under a PTY, owner fallback per step (OQ-C8). Can a session ID be pre-allocated? If not, binding comes from the `SessionStart` payload or first chat-file metadata (FR-20 provisional row). Resume: list sessions with the version's command; resume by UUID vs index/latest (FR-21 needs UUID); behaviour when the native chat file was deleted (error shape, exit code) and from a different cwd. No headless mode. Output: exact argv templates with whole-argument placeholders. Files: `spikes/s11/{launch.exp,resume.exp}`. Test first (S): argv templates pre-filled UNVERIFIED. Verify: expect scripts exit 0 at expected prompts; the resumed UUID's chat file gains records. Owner: approves narrowing if resume is not UUID-addressable (resume disabled with reason). Maps: FR-20, FR-21, FR-25; EC-84, EC-85 (Gate 7), EC-81.

**P0-S11-T8 — Generic maps and synthetic custom-agent schema** — `spikes/s11/catalog/agents.catalog.schema.draft.json` covering exactly the §7.3 v1 fields: identity/version/lifecycle; tested versions; detection (binaries, locations, version args); profile roots and named env overrides; existence evidence; adapter/channel references; capabilities; ordered display-only setup steps; copy-only install hints; config-edit declarations (Claude-like and Gemini JSON writers only); hook mappings (exact event name plus optional exact field-value predicates → normalized event); launch argv templates with whole-argument placeholders; env-key grants. `additionalProperties: false` throughout; argv arrays only; no ACP (v1). Positive entries: `gemini.entry.json` (§6.8 mappings plus the `ToolPermission` predicate), `synthetic-agent.entry.json` (fourth agent, report v1 only, no native adapter; M15 feasibility). Negative entries (must fail): unknown field; shell string in a launch template; imported entry shadowing a bundled ID; profile root escaping approved roots; executable/mapping code field. Expressiveness table: every S11 fact not expressible as data stays "unsupported, needs a tested adapter" (C11). Seeds Phase 6 `integrations/agents.catalog.schema.json` and `test/fixtures/synthetic/catalog/` (moved then, never imported). Test first (S): negatives written before the schema. Verify: validate with T9 candidates if a trial is approved; else "validation not run; schema review only" (never counts as pass). Maps: S-27, SEC5, FR-07; EC-78, EC-79 (Gate 6), M15.

**P0-S11-T9 — JSON Schema validator selection (App. C, Gate 0)** — candidates: `ajv` (named in App. C) plus small zero-dependency validators found in research (e.g. `@cfworker/json-schema`). Criteria: permissive licence (MIT/BSD/ISC/Apache-2.0); transitive dependency list and count; supports the draft schema's keywords (`type`, `enum`, `const`, `pattern`, `required`, `additionalProperties`, `items`/`prefixItems`, `oneOf`, `$ref`/`$defs`, `maxLength`/`maxItems`); no remote `$ref` fetching or network path (M6); recent release (registry `time`); runs in Electron `utilityProcess` (ESM/CJS), note `new Function` code generation; error output usable for the Add agent import UI; install size. Method: `npm view <pkg> version license dependencies time repository` (registry read, `registry.npmjs.org` allowed per command) plus context7; optionally, only with approval, a trial `npm install --prefix .cache/validator-trial --cache .cache/npm` to run T8 entries (OQ-X6). Output: evidence table and a recommendation with install phase. Test first (S): criteria table pre-filled UNVERIFIED; every criterion cites a source. Owner: approves/declines the trial; approves the selection at Gate 0.

**P0-S11-T10 — S11 report section and decision** — per-criterion evidence; one decision covering supported Gemini observation, narrowed items and the validator; proposed App. E #16, #17, #24 (Gemini) edits; Q18 answer; FR-51 Gemini effort conclusion; every unsupported fact listed (C11); `record_decision`. A core-observation miss goes to the owner at Gate 0.

### 0.13 S12 — Capacity/latency feasibility (runs on S1's engine)

PRD §10: synthetic feasibility measurements for 50 sessions, 200 events/s, ≥10 GiB SQLite/FTS corpus; worker isolation, query times, watcher/FD strategy, queue age and candidate forwarder hops; record the minimum architecture and unresolved gate risks (spike results do not replace packaged E2E gates); include 45-day minute-sampled quota histories, transition rows, context projections and price provenance; report row counts, table/index/WAL bytes, retention cost and live/query interference.

Decisions: minimum architecture (§7.1 worker layout), batch bounds (rows/ms/bytes), the **watch reconciliation interval default** (Q8/FR-02) and watcher strategy; Q19 feasibility status (final answers at Gates 1–5). Closes the feasibility part of App. E #20 and #26. Maps: S-29, FR-02, FR-09, PERF, §5.11 storage, §7.4, D-16, M2, M13, M14, US-14, learning goal 7. DB work runs under the packaged binary with `ELECTRON_RUN_AS_NODE=1`; interference runs use the packaged `utilityProcess` (modes `s12-*`); load generators run as separate system-Node processes.

**P0-S12-T1 — Generators with self-checks; threshold check (RED)** — `spikes/s12/gen.ts` (seeded `mulberry32`, seeds recorded): (a) live stream: 50 sessions, 200 events/s, mean serialized 4 KiB, p99 ≤256 KiB, max 256 KiB (M14); (b) historical corpus ≥10,000 sessions, §6.6 size shape (median ~200 KB, p99 ~20 MB, max ~200 MB incl. ≥1 session of 200 MB), scaled until the populated DB (content + FTS + indexes, no padding) is ≥10 GiB, fixed vocabulary plus a CJK/emoji fraction; (c) usage tables: per quota stream 64,800 minute samples (45 days) plus transitions (stream count OQ-A8), ContextSnapshot projections per session generation, price-provenance revisions. The generator asserts its declared statistics and exits non-zero otherwise. `spikes/s12/check.ts` asserts T4 thresholds; fails before load/query code exists. Script `spike:s12`. Test first (U): generator self-check with a deliberately wrong size parameter fails. Deps: P0-S1-T5, P0-T02.

**P0-S12-T2 — Build the ≥10 GiB corpus** — abort if <40 GiB free; write DB, WAL and headroom to `.cache/spike-data/s12/`; bulk-load with S1's schema shape (events, sessions, FTS5 external content indexing the first 64 KiB per item, §7.4 indexes); record build time, `page_count×page_size`, freelist and WAL size. Verify: `npm run spike:s12 -- --build`; `PRAGMA integrity_check` and FTS integrity-check. Done-evidence: corpus stats (sessions, rows per table, GiB per table/index via DBSTAT or per-table files, seed). Owner: only if disk space is short.

**P0-S12-T3 — Query timings on the corpus (warm and "cold")** — each 200×, p50/p95/p99: keyset session-list first page (unfiltered, by agent, by project); FTS first page of 20 with `snippet()` for a common, a rare and a CJK term; first bounded content page of the 200 MB session plus the next 5; a 45-day quota-history range for one scope; month totals. "Cold" = new process and connection with the OS page cache warm (OQ-A11); true cold optional via owner-run `sudo purge`. Verify: `npm run spike:s12 -- --queries`. Done-evidence: query table vs DB-portion budgets of M12 (list ≤1.5 s), M13 (content ≤300 ms, search ≤500 ms incl. paint), EC-86/EC-87.

**P0-S12-T4 — Live load and worker isolation** — 10 min at 200 events/s from 50 sessions while a bounded backfill parser and T3 queries run. Mixes (OQ-A9): 100% file-append records; 75% file / 25% hook deliveries via the S3-chosen forwarder. Variants: **A** everything on the utility main thread; **B** writer in a `worker_threads` worker, reads on the dispatch loop; **C** the §7.1 layout (dispatch loop + writer worker + bounded parser worker, reads off the dispatch loop). Measure dispatch-loop delay (`perf_hooks.monitorEventLoopDelay` p99/max), receive→publish (service-side M1 hop), append→watch→parse→publish (service-side M2 hop), persistence queue age (p95 ≤1 s), drain after load (≤5 s), loss/duplication (logical in vs out = 0), WAL size over time and checkpoint starvation, RSS of all processes (vs M4/M5), open FDs. Sweep batch bounds under C: rows ∈ {100, 500}, ms ∈ {50, 100}, byte cap ∈ {1, 4, 16} MiB. Verify: `npm run spike:s12 -- --load --arch A|B|C`; `check.ts` assertions. Done-evidence: load table per variant and mix; the smallest passing variant (A is expected to fail interference but this is not assumed). Deps: T2, P0-S3-T9.

**P0-S12-T5 — Usage-snapshot scale and retention cost** — row counts and table/index bytes for UsageSnapshot (minute samples and transitions), ContextSnapshot, CostEstimate/price provenance, MonthlyUsageTotal/MonthlyQuotaPeak/SettledContribution with indexes `(usage_scope_id, limit_id, as_of)` and session/context-generation indexes. Retention cost: a one-day expiry (1/45 of quota history plus sessions past 45 days) as delete + settle in one transaction, batched; wall time, WAL growth, `incremental_vacuum` time, dispatch-loop delay while concurrent with T4 load (variant C). Verify: `npm run spike:s12 -- --usage`. Done-evidence: bytes per stream (linear scaling stated), retention-cost table, interference result (inputs to EC-99 Gate 5, EC-100 Gate 4). Deps: T4.

**P0-S12-T6 — Watcher/FD strategy and reconciliation interval** — synthetic store tree under `.cache/spike-data/s12/tree/` mimicking Claude `projects/<dir>/<id>.jsonl` and Codex `sessions/YYYY/MM/DD/`, at 1,000 and 10,000 files with 50 active appenders. Compare (a) recursive `fs.watch` per root (FSEvents), (b) per-active-file `fs.watch`, (c) `fs.watchFile` polling: append→event latency p95/max, missed events under a 200 events/s burst, FD count vs the GUI soft limit (`launchctl limit maxfiles` recorded), idle CPU. Reconciliation scan: bounded readdir + stat vs checkpoint `(size, mtime, ino)` at 1k and 10k files; wall time and CPU per scan. Interval rule (OQ-A10): smallest of {2, 5, 10, 15, 30, 60} s where the scan averages ≤0.25% of one core at 10k files and one scan takes ≤10% of the interval; missed-watch recovery = interval + 1 s (M2, EC-19). Verify: `npm run spike:s12 -- --watch`. Done-evidence: watcher table, scan-cost table, proposed default with derivation. Deps: T1.

**P0-S12-T7 — Decision** — § S12: minimum architecture (chosen variant and why each worker is needed), batch bounds, watcher strategy and fallback, watch reconciliation interval default; Q19 feasibility per target M2/M3/M12/M13/M14 vs its gate; unresolved gate risks mapped to gates (Gate 1 EC-15/EC-19; Gate 4 EC-57/EC-100/M14; Gate 5 EC-87/EC-99/M13). `record_decision` "Minimum service architecture", "Watch reconciliation interval default". Proposed PRD edits: FR-02 default value, Q8 interval part resolved, Q19 status, App. E #20/#26 "feasible / at risk — final at Gate N".

### 0.14 S13 — Passive usage, context and cost (S-31, S-32, D-22)

PRD §10: synthetic or disposable-profile evidence for tee byte and exit preservation; absent-original and capture-failure paths; bounded added wait; no output and no tokens; installed-version snapshot schemas; scope-attribution limits; compaction and model-window changes; price-component semantics. No quota, context or model API is called; incomplete category and Gemini evidence recorded; if no tee qualifies, the question goes back to the owner, with no silent use of an account cache. Maps: S-31, S-32, S-33 (evidence only), S-35, FR-44–49, FR-51, US-16–19, M7, M16, D-22, App. E #22–#25; EC-28/91–96/98/100–102 inputs.

**P0-S13-T1 — How Claude invokes the statusLine** — temp `statusLine` → `spikes/s13/statusline-probe.mjs`, which records to raw: stdin byte length and TTY-ness; argv count; parent command name (`ps -o comm= -p $PPID`, `sh -c` vs direct exec); cwd category (project/other); env variable *names*; invocation interval; whether a long-running probe (sleeps 5 s) gets SIGTERM or SIGKILL when a newer update arrives (App. E #22); what Claude shows on non-zero exit and on stderr. PR-OK and PR-TOOL via expect (`log_file`). Files: `spikes/s13/{statusline-probe.mjs,probe.exp}`, `spikes/s13/evidence/invocation.json`. Test first (S): expected contract (shell string, project cwd, stdin JSON) written first. Done: the invocation contract the tee must reproduce (shell, cwd, env, cancellation, timeout). Deps: P0-T06.

**P0-S13-T2 — statusLine stdin schema on 2.1.319** — from T1 raw plus runs before the first response, after responses and after a subagent, reduce: `session_id`, `transcript_path`, `cwd`; `model.id`, `model.display_name`, `effort.level`; `cost.total_cost_usd`; `context_window.current_usage`, `total_input_tokens`, `context_window_size`, `used_percentage`; `rate_limits.five_hour`, `seven_day`, `spend_limit` with `resets_at` units; extra fields. Record presence/null/absence per phase (null `current_usage` before first response = "unavailable", not zero); whether an `as_of`/measurement-time field exists (if not: "Source time unknown; observed …"); whether unchanged `rate_limits` are re-emitted per redraw; whether `cost.total_cost_usd` rises with a subagent (parent-includes-children stays "uncertain" unless proven, §5.12); presence only of rate-limit and plan fields (values never kept). Files: `spikes/s13/evidence/statusline.schema.json`. Test first (S): expected key list from §5.2 as a checklist.

**P0-S13-T3 — Tee golden tests (RED first)** — `spikes/s13/tee.test.ts` (node:test) against `spikes/s13/tee.ts`, an empty stub at first so every test fails. Synthetic originals in `spikes/s13/originals/`: `bytes.sh` (fixed stdout incl. invalid UTF-8, ANSI, no trailing newline, plus fixed stderr), `exit-N.sh` (0, 1, 3, 255), `sig.sh` (kills itself with SIGTERM), `slow.sh` (2 s), `nostdin.sh`, `stdin-hash.sh` (sha256 of stdin to a side file).

| Case | Expectation |
|---|---|
| G1 | stdout and stderr byte-identical to running the original directly |
| G2 | exit code preserved for every exit fixture |
| G3 | a signal-killed original is mirrored (OQ-B8) |
| G4 | the original receives byte-identical stdin, incl. a 2 MiB input |
| G5 | no original configured: 0 bytes stdout/stderr, exit 0 |
| G6 | capture failure (no listener, unwritable capture target, malformed JSON, oversized stdin): original still runs with G1/G2 output |
| G7 | slow original: added wall time ≤ bound (OQ-B6) |
| G8 | original ignores stdin: EPIPE handled silently |
| G9 | tee receives SIGTERM: child terminated or forwarded per T1 findings, documented |
| G10 | captured record holds only `session_id` (OQ-B7), usage/context/cost fields, `model.id`, `model.display_name`, `effort.level`; no `transcript_path`, `cwd` or content |
| G11 | the tee itself contributes no bytes |

Shape: `spawn('/bin/sh', ['-c', original])` (or what T1 shows), `stdio: ['pipe','inherit','inherit']`, stdin copied to child and to a 256 KiB-capped capture buffer, capture sent to a Unix socket with its own deadline, exit mirrored. Verify: `npm run spike:test -- spikes/s13/`. Done: G1–G11 green.

**P0-S13-T4 — Tee in a real temp-profile session** — temp `statusLine` → `tee.ts` wrapping `originals/bytes.sh`; expect run with PR-OK and PR-TOOL; Claude displays the original's line (marker substring in the expect log) with and without the tee; `spikes/s13/capture-listener.ts` receives the G10 fields; no original configured → empty line, no errors; listener stopped → line still displays; first-turn input tokens tee on vs off: delta 0 (M7). Files: `spikes/s13/{capture-listener.ts,tee.exp}`, `spikes/s13/evidence/tee-live.json`. Test first (S): no-tee baseline captured first.

**P0-S13-T5 — Tee added-wait (M16 feasibility)** — `spikes/s13/overhead.ts`: N = 200 runs each of original alone vs through the tee; capture variants listener up / no listener / listener never reads. Added wall time p50/p95/max (monotonic, aggregates). Once with system Node, once with S3's selected packaged runtime (gate-relevant). Foreign command runtime excluded (EC-100 rule). Test first (P): asserts p95 ≤ bound, exits 1 otherwise; a first run with a deliberate 200 ms sleep in the tee must fail. Deps: T3, P0-S3-T9.

**P0-S13-T6 — Compaction, model-window and effort changes (Claude, Codex)** — Claude: after a few PR-OK turns, `/compact` (spike-only model call, OQ-B15); PreCompact/PostCompact schemas, where any `postTokens`/pre-token field appears, next statusLine `current_usage`; `/model` to a different-window model if offered (`context_window_size`, `model.id`/`display_name` change); effort switch (UNVERIFIED command) → `effort.level`. Codex: temp TUI `/compact` and `/model` (UNVERIFIED); reduce rollout `event_msg.token_count` (`info.total_token_usage`, `last_token_usage`, `model_context_window`, `rate_limits` primary/secondary window minutes, used percent, reset, plan, credits, any `limit_id`); presence of `token_usage_record`, `compacted`, `turn_context` model/effort; duplicate cumulative events or counter resets. Files: `spikes/s13/compact.exp`, `spikes/s13/evidence/{context-changes,codex-token-count.schema}.json`. Test first (S): §5.11 assertions (old reading invalidated; new generation on model/window change; cumulative counters not summed) each marked confirmed/contradicted/untestable. Deps: T2; S6-T1.

**P0-S13-T7 — Price-component semantics** — Claude `message.usage` schema (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, any `cache_creation.ephemeral_5m/1h_input_tokens`, `service_tier`, server-tool fields); Codex `cached_input_tokens ⊂ input_tokens` and `reasoning_output_tokens ⊂ output_tokens` as aggregate booleans (`spikes/s13/subset-check.ts`). Mapping table source field → §5.12 component; unpriced qualifiers marked "component unavailable unless table supports"; Gemini "pending S11". Files: `spikes/s13/evidence/price-components.json`. Test first (S): §5.12 formula expectations first. Deps: T6.

**P0-S13-T8 — Account-scope attribution limits** — list every passive field (statusLine, rollout `token_count`/`session_meta`) that could bind a reading to an account or epoch; no credentials, `~/.claude.json` or `auth.json` contents read (FR-45). Optional (OQ-B11): owner signs the `-b` slot into the same account to show readings are passively indistinguishable (EC-92). Record "silent account change undetectable". Files: `spikes/s13/evidence/scope.json` (field names and conclusion). Test first (S): hypothesis "no passive account identifier exists" written first.

**P0-S13-T9 — Category and inventory evidence (record only, v1-B)** — which record types could support §5.11 categories (instruction, memory, tool, skill or agent listings; deferred-definition deltas; compaction buffer inputs): present/absent/partial. No `/context`, no tokenizer; Gemini deferred to S11. Files: `spikes/s13/evidence/categories.json`. App. E #25 stays open for v1-B.

**S13 decisions (explicit Gate 0 decision; report and `record_decision`)**
1. **Tee feasibility:** adopt S-31 as FR-45 specifies only if G1–G11 pass, T4 live preservation holds with token delta 0, T5 packaged added wait p95 ≤ bound (OQ-B6), and the T1 invocation contract incl. cancellation is reproducible. Otherwise **return to the owner** with the failing criterion; **no** fallback to `~/.claude.json` or any account cache (D-22). Without the tee, Claude context uses transcript evidence and rate limits show Unavailable.
2. **Account scope:** (A, default) opaque `(agent, profile)` key plus epoch (starts on an owner declaration or evidenced profile change), label "Account scope unverified" unless T8 found a passive identifier; never merged across profiles. (B) only if T8 found a passive non-credential identifier: bound to it, stored only as an opaque key.
3. **Snapshot schemas** pinned to 2.1.319 / 0.160.0 for Gate 2 and Gate 3 parsers.
4. **Context-change rules** confirmed/contradicted for §5.11 (feeds EC-94, Gate 2).
5. **Price-component mapping** plus unsupported qualifiers (feeds `integrations/models.json`, EC-95/96).
6. **Category evidence** gaps for v1-B.
- App. E: #22 and #23 closed at spike level (final at EC-28 and EC-91/92, Gate 3); #24 Claude/Codex closed, Gemini with S11; #25 incomplete (v1-B).
- Fixtures: `test/fixtures/synthetic/claude/2.1.319/statusline/*.json` (pre-first-response null `current_usage`; normal; with/without `rate_limits`; spend >100%; expired reset; repeated cached emission; after compaction; 1M↔200k; `display_name` mismatch; effort change) for EC-28/91/92 (Gate 3), EC-94/101 (Gate 2), EC-102 (Gate 4); `test/fixtures/synthetic/codex/0.160.0/rollout/token_count/*.jsonl` (missing `rate_limits`; duplicate cumulative; counter reset; model/window change; `compacted`; unknown `token_usage_record` version) for EC-93/51/53; `test/fixtures/synthetic/claude/2.1.319/usage/*.jsonl` (mixed cache-write classes and models) for EC-95; `spikes/s13/originals/` copied to `test/fixtures/synthetic/claude/statusline-originals/` at Phase 3 start (EC-28).

### 0.15 Execution order

| Step | Tasks | Needs |
|---|---|---|
| 1 | P0-T10 first (report skeleton; T01–T03 record evidence in it), then P0-T01 → T02 → T03; T04 → T05 → T06; T07, T08 | entry criteria |
| 2 | S1 (T1–T5) | P0-T03 |
| 3 | S3 (T1–T9) | S1-T2, P0-T06 |
| 4 | S4, S5, S9-T1..T4, S9-T6 (temp-profile blocks, one agent block at a time with guard before/after) | P0-T06 |
| 5 | S12 (T1–T7) | S1-T5, S3-T9 |
| 6 | S13, S6, S7, S9-T5/T7/T8 | S3-T9, S4-T3, S5-T1 |
| 7 | S11 (T1–T10) | P0-T06, S9 extractor |
| 8 | S10 (T1–T4) on the final spike app | S1-T5, S3-T9 |
| 9 | Gate 0 tasks P0-G-T1..T5 | all spikes |

Time-box: one working session per spike; on overrun or a blocker, stop and report partial evidence (OQ-X10).

### 0.16 `docs/plans/phase0_spikes.md` structure (P0-T10)

```text
# Phase 0 spike report
Header: PRD version, date, branch, pinned versions (claude/codex/gemini; electron + its node/v8/chrome;
        typescript; electron-builder), reference-machine class (Apple Silicon, macOS version),
        percentile method, corpus seeds, privacy statement.
§ Environment: cache verification, install pins.
§ Guard: procedure; MATCH per live session; keychain sharing yes/no per agent; temp item added yes/no.
1. Summary table — one row per spike S1 S3 S4 S5 S6 S7 S9 S10 S11 S12 S13:
   | Spike | Scope (required/optional/conditional) | Verdict (Pass / Pass-narrowed / Fail→owner)
   | Decision (one sentence) | PRD sections changed | Evidence anchor |
2. Per-spike section (identical template):
   2.1 Question and PRD refs (S-/FR-/M-/EC-/App. E IDs)
   2.2 Criteria: the §10 pass/fail text split into numbered rows <Spike>-C<n>
   2.3 Method: versions, profile type (synthetic / disposable temp profile), commands with
       placeholders, guard results (MATCH/DIFF only)
   2.4 Evidence per criterion: status ∈ {pass, fail, not-triggered, unsupported, not-run}, artifact
       path (spikes/<id>/..., schema file, fixture case), reduced facts only
   2.5 Decision: exactly one binding decision, citing its supporting criteria
   2.6 Consequences: scope narrowed (PRD wording), App. E rows resolved/narrowed/open (owning gate),
       §12 questions answered/added, EC rows and later tasks affected, new risks
3. Cross-spike decisions: dependency list for approval (App. C delta), Q8 watch-reconciliation default
   (S12), S13 tee/account-scope decision, validator selection, S6/S7 compatibility matrix
4. Required-scope misses returned to owner: miss, evidence, options, owner decision + date
5. Decisions table: record_decision references
6. Gate 0 record: baseline commit and a link to `docs/plans/gates/gate0.md`, which the gate-record commit adds
   (gate SHA, final-SHA results, Codex verdict + findings disposition, Claude verdict, owner decision; §2.4 step 6)
```

Rules: "not-run" and "not-triggered" are never passes; a decision cites only evidence rows in its own section or §3; raw recordings never enter the report; negative results that change the PRD link to the proposed PRD edit. Privacy rule for this file and all of `spikes/`: no absolute paths, usernames, uids, ports, session IDs, prompts or transcript content (checked by `npm run privacy:scan` at the gate).

### 0.17 Gate 0 tasks

**P0-G-T1 — Report sections complete** — every spike has steps actually run with **verified** command syntax (anything not run stays UNVERIFIED), an evidence index, pass/fail against its §10 row, and a decision; the consolidated compatibility matrix (S6-T6 + S7-T7); the S13 decision block. Verify: `npm run privacy:scan -- docs/plans spikes test/fixtures/synthetic`.

**P0-G-T2 — PRD delta (one revision, OQ-X9)** — targeted edits only: FR-02 interval default; §12 Q3, Q7, Q12, Q17, Q18 answered or default confirmed; Q8 interval part resolved; Q19 status; new questions with defaults; App. E #1–6, #8, #11, #13, #14, #16–#20, #22–#26 resolved/narrowed/still UNVERIFIED with owning gate; FR-45: also capture `session_id` (local private path only; never `transcript_path` or `cwd`; OQ-B7), so the record carries the native session identity PRD §6 requires; App. C: exact pins (the electron-builder Phase 0 row was already corrected by errata D-P0-05), `better-sqlite3` outcome, validator selection and install phase, any S3 packaging need; FR-30/FR-31 verified subcommands replace UNVERIFIED; §6.2 rows updated only where S7 produced evidence; §7.3 forwarder-runtime and §7.4 engine sentences; new App. D rows (D-26 onward) for the D-2 outcome, tee feasibility and account scope; each negative optional result as a narrowing edit (e.g. EC-03 list-only, Claude `sessions/*.json` unused, Gemini resume disabled with reason, `maxAge` offer hidden). Verify: `npm run privacy:scan -- docs/PRD.md`; the diff contains only these edits.

**P0-G-T3 — Decision records** — `record_decision` entries: SQLite engine; forwarder runtime and per-event path; ack point; network audit method; minimum architecture; watch interval; D-2 outcome; FR-31 route; Q3; Q12; tee feasibility; account scope; compatibility-matrix version; S9 fact set; S11 Gemini decision; validator selection.

**P0-G-T4 — Review procedure** — run §2.4 (GS) steps 0–6 unchanged, with suite = the §0.20 G0-2 commands and baseline = `git merge-base master HEAD` (the plan commit on this branch precedes Phase 0 work, so the Gate 0 diff also shows the plan docs). Gate 0 additions only:
- Step 0 also completes the report, progress file and the staged PRD delta (P0-G-T2); the privacy gate runs before any text leaves the machine.
- Step 3 handoff `.handoff/gate0-codex-review.md` adds the Gate 0 checklist (§0.20), PRD excerpts (privacy rule, §10 Phase 0 row and spike table, §12, App. C, App. E) and the questions: is each decision supported by its evidence rows; are narrowings correct and minimal; are required-scope misses escalated; any privacy leak; is the dependency list complete. Output: findings with severity and file:line, verdict approve / approve-with-fixes / reject.
- Step 4 (Claude) also runs `/ponytail-review` on spike code and scripts and checks decisions against evidence.
- Step 6 presents: summary table; narrowed scope; required-scope misses with options; dependency list for approval; S13 decision; PRD delta. Everything post-freeze goes to `docs/plans/gates/gate0.md`.

**P0-G-T5 — After approval** — the §2.4 step 6 gate-record commit and, each only when the owner asks, push, PR `feat/phase0-spikes` → `master`, merge. Delete raw dirs and throwaway projects (P0-T09). Temp profiles stay until Gate 6 (OQ-B10).

### 0.18 EC rows referenced by Phase 0 (evidence only; gate assignment unchanged)

Gate 0 owns no §9.2 row. These rows consume Phase 0 evidence or fixtures and are implemented and tested in their own gate's tasks.

| EC | Case (short) | Test (§9.2) | Owning gate | Phase 0 input |
|---|---|---|---|---|
| EC-03 | `.jsonl.zst` history | U + S9 | 1 | S9-T3/T5 (the S half closes at Gate 0) |
| EC-04 | Format drift | U | 1 | S9-T4/T7 |
| EC-14 | Partial trailing JSONL line | U | 1 | S9-T7 |
| EC-15 | Huge transcripts / record | P | 1 | S9-T4 large-payload fields; S12-T3 200 MB paging |
| EC-16 | Unicode/long paths | U | 1 | S9-T4 |
| EC-19 | Missed watch events | I | 1 | S12-T6 interval |
| EC-39 | Config-dir overrides | U + I | 1 | P0-T05 overrides honoured |
| EC-45 | DB migration failure | I | 1 | S1-T2 backup API |
| EC-60 | Non-loopback attempt | E + S10 | 1 | S10 audit method + zero-attempt matrix |
| EC-61 | Runtime writes into repo | E | 1 | P0-T03 / S10 repo checks |
| EC-05 | Multiple entrypoints | U | 2 | S6-T1, S7-T1, S9-T4 |
| EC-50 | Non-interactive sessions | U | 2 | S6-T1(b), S7-T1, S9-T4 |
| EC-51 | Compaction | U | 2 | S9-T4, S13-T6 |
| EC-53 | Codex PreModelRequest absent | U | 2 | S5-T3 |
| EC-74 | Cross-agent sessions | U + I | 2 | S6-T1(c) |
| EC-80 | Gemini folding | U + I | 2 | S11-T4 |
| EC-81 | Gemini cleanup / missing tool output | I | 2 | S11-T3/T6/T7 |
| EC-93 | Codex rate_limits / cumulative | U + I | 2 | S9-T4, S13-T6 |
| EC-94 | Claude compaction / window switch | U + I | 2 | S9-T4, S11-T5, S13-T6 |
| EC-95 | Mixed models / cost components | U + I | 2 | S9-T4, S11-T5, S13-T7 |
| EC-101 | Model evidence / name precedence | U | 2 | S9-T4, S11-T3, S13-T2/T6 |
| EC-09 | Duplicate events | I | 3 | S4-T5 |
| EC-11 | Service down / no ack | I | 3 | S3-T1/T3 |
| EC-12 | Spool overflow | I | 3 | S3 cap/counter |
| EC-25 | Codex hook trust not granted | I + S5 | 3 | S5-T2..T5 (the S portion) |
| EC-28 | statusLine tee | U + I | 3 | S13-T1..T5 |
| EC-32 | Malicious socket client | U + I | 3 | S3-T3 rejection matrix |
| EC-40 | Background work after Stop | U (fixture) + P | 3 | S7-T4 |
| EC-41 | Permission heuristic vs confirmed | U | 3 | S7-T2/T3 |
| EC-44 | Disk full | I | 3 | S3 full-disk-image mode |
| EC-46 | Upgrade while agents run | I | 3 | S3 shim; S5-T4 retrust scope |
| EC-49 | Managed settings / disableAllHooks | U | 3 | S3-T6, S4-T5(c) |
| EC-52 | Unknown hook events | U | 3 | S11-T2 |
| EC-63 | Oversized/malformed stdin | U | 3 | S3-T1 |
| EC-64 | Hook output adding tokens | U | 3 | S3-T1/T8, S4-T4, S5-T3 |
| EC-70 | Interrupted turn | U | 3 | S5-T3, S7-T4(c) |
| EC-83 | Generic notifications | U | 3 | S11-T2 |
| EC-91 | Rate windows null/expired | U + I | 3 | S13-T2 |
| EC-92 | Multiple profiles/accounts | U + I | 3 | S13-T8 |
| EC-57 | 50 concurrent sessions | P | 4 | S12-T4 |
| EC-100 | Usage under load/faults | I + P | 4 | S12-T4/T5, S13-T5 |
| EC-102 | Model/effort switch | U + E | 4 | S11-T3, S13-T6 |
| EC-23 | Claude transcript cleanup | I | 5 | S9-T6 |
| EC-87 | 10,000 sessions / ≥10 GiB | I + P | 5 | S12-T2/T3 |
| EC-99 | 45-day quota expiry | I + P | 5 | S12-T5 |
| EC-26 | Plugin uninstalled externally | I | 6 | S4-T6 |
| EC-27 | Xaibo deleted without Disconnect | I | 6 | S3-T2 shim |
| EC-72 | Agent-flow rewrites hooks | I | 6 | S4-T5(d) |
| EC-78 | Catalog invalid/imported | U + I | 6 | S11-T8/T9 |
| EC-79 | Newly installed agent | I + E | 6 | S11-T1/T2 |
| EC-90 | Gemini maxAge | U | 6 | S11-T6 |
| EC-20 | Concurrent resume | U + E | 7 | S6-T3, S7-T1 |
| EC-67 | Desktop-origin resume | S7 | 7 | S7-T6 (Gate 7 re-checks on the then-current version) |
| EC-84 | Changed executable/args | U + I | 7 | S11-T7 argv templates |
| EC-85 | Provisional launch row | E + P | 7 | S11-T7 binding evidence |
| EC-68 | App-server thread visibility | S6 + I, v1-A | v1-A | S6-T2..T5 |
| EC-98 | Category records | U + I, v1-B | v1-B | S13-T9 |

FR/S/US mapping: S1 → S-04, FR-09; S3 → S-05, FR-03, US-1; S4 → FR-30/32/34, S-05, US-7; S5 → FR-31, S-06, US-7; S6 → FR-20–23, S-12, S-22, US-8; S7 → FR-20–23, §6.2, US-8; S9 → S-02/03/04/10/25/35, FR-02/08/13/47/51, US-3, US-15; S10 → S-14, P2, US-12; S11 → S-01/27/28/35, FR-01/06–08/20/21/25/33/34/51, US-13/15/19; S12 → S-29, FR-02/09, US-14; S13 → S-31/32/33/35, FR-44–49/51, US-16–19.

### 0.19 Metrics measured at Gate 0 (feasibility only; no M-ID is a Gate 0 pass condition)

| M | Measured in | How |
|---|---|---|
| M1 | S3-T7 | hop table, emission→paint-ack (upper bound), p95 vs 250 ms per candidate |
| M2 | S12-T4/T6 | service-side append→publish p95; watcher latency; recovery = interval + 1 s |
| M3 (corpus realism) | S9-T4 | large-payload fields only, no sizes or counts |
| M4/M5 | S10-T3 | idle RSS/CPU of the spike app tree, window closed/open (baseline; product measured at Gates 3/4) |
| M6 | S10 | Seatbelt denials + NetLog + Node channels; all scenarios = 0 |
| M7 | S3-T1/T8, S4-T4, S5-T3, S11-T2, S13-T4 | stdout+stderr bytes, exit code, first-turn token delta (target 0), marker-leak probes |
| M13 | S12-T3 | DB-portion query p95 on the ≥10 GiB corpus |
| M14 | S12-T4 | 50 sessions, 200 events/s, 10 min: queue age, drain, loss/dup, RSS |
| M15 | S11-T8 | synthetic fourth agent expressible as catalog data + report v1 |
| M16 | S3-T1, S13-T5, S11-T2, S4-T4, S5-T3 | forwarder own deadline (max ≤100 ms); added sync wait p95 vs `true`; tee added wait p95 on the packaged runtime; per-event async support |

Every result records hardware class, macOS, app/agent versions, seed and actual DB/index sizes, tagged "spike, not gate evidence".

### 0.20 Gate 0 checklist

Gate 0 approved 2026-11-10 on gate SHA `7deb8cb` (`docs/plans/gates/gate0.md`). Boxes ticked 2026-11-14 against that record and `phase0_spikes.md`; *Via* marks an item met through an owner-accepted substitute.

- [x] **G0-1** `phase0_spikes.md` has one decision per spike (S1, S3, S4, S5, S6, S7, S9, S10, S11, S12, S13) against its pass/fail evidence; no criterion UNVERIFIED without a stated consequence. *Evidence:* report §1, one 2.5 decision per spike in §2; Gemini live UNVERIFIED carried to report §4.
- [x] **G0-2** Environment: exact pins for electron, typescript, electron-builder in `package.json`/`package-lock.json`/`.npmrc`; caches verified in `.cache/`; nothing new under `~/Library/Caches`. `npm run spike:test`, `npm test`, `npm run typecheck`, `npm run dist:mac` green on a clean checkout; spike app smoke passes with no orphans. *Evidence:* report § Environment; gate0.md suite on `7deb8cb`.
- [x] **G0-3** S1 engine decision with all probe and kill/restart invariants (200/200, 20/20); App. C `better-sqlite3` row resolved. *Evidence:* S1-C5 (200/200, 20/20), `node:sqlite` chosen, `better-sqlite3` not needed (record_decision 16).
- [x] **G0-4** S3 candidate matrix covers every PRD criterion; Q7 and Q17 answered; ack point decided; App. E #19 resolved, #18 updated; HTTP gaps documented. *Evidence:* S3-C1–C13, S3 2.5/2.6 (SEA over a private socket, ack after commit; record_decision 23).
- [x] **G0-5** S4 (D-2) decided with a verified command sequence; S5 FR-31 route and trust steps decided; compatibility matrix complete for Claude 2.1.319 and Codex 0.160.0 (untested cells carry a reason). *Evidence:* S4, S5 2.5 (record_decision 24, 25); matrix in report §3. *Via:* Claude rows are on 2.1.322 after an auto-update; owner accepted (D-P0-34).
- [x] **G0-6** S12 minimum architecture, batch bounds, watcher strategy and FR-02/Q8 interval default derived from measurements; Q19 status; unresolved risks mapped to gates. *Evidence:* S12 2.5/2.6 and its Q19 table (record_decision 28). *Via:* personal profile with a deferred scale-up stage (D-P0-24, D-P0-26, D-P0-36).
- [x] **G0-7** S10 positive control detected; zero attempted non-loopback connections in every scenario across main, renderer/Chromium, service and both forwarder candidates. *Evidence:* S10-C1–C6; gate0.md: 11/11 controls, 0 attempts in 10 scenarios (record_decision 34).
- [x] **G0-8** **S13 report with the explicit tee-feasibility and account-scope decision.** If the tee is not feasible, the owner has made the scope decision; no silent account-cache fallback. *Evidence:* S13 2.5: tee feasible as a SEA; Claude scope unverified; Codex salted hash (record_decision 33).
- [x] **G0-9** S9 and S11 decisions; required-scope misses (S11-C1–C5, S3/S12 speed/capacity) presented to the owner with options and the decision recorded in report §4; negative optional results listed as narrowing edits. *Evidence:* S9, S11 2.5 (record_decision 26, 27); report §4 rows with owner decisions dated 2026-11-10.
- [x] **G0-10** Dependency list approved by the owner (App. C delta incl. validator selection and install phase). Nothing outside App. C installed. *Evidence:* report §3; D-P0-34 (`ajv` 8.20.0 at Phase 1 start).
- [x] **G0-11** PRD delta collected into one revision with a history line (P0-G-T2). *Evidence:* PRD v1.1 status line at `7deb8cb`, approved with Gate 0.
- [x] **G0-12** Privacy: `npm run privacy:scan` green over `docs/plans`, `spikes`, `test/fixtures/synthetic`, `docs/PRD.md` and the complete gate diff (P0-T08); no raw recording committed; schemas contain only whitelisted strings; fixtures pass the synthetic-pattern checks. *Evidence:* gate0.md suite, privacy row clean.
- [x] **G0-13** Real profiles untouched: guard `MATCH` for every live session and the final `baseline` compare; keychain result per agent (shared/not shared; temp item added yes/no); no real store or config written; no workspace-scope retention file remains. *Evidence:* report § Guard (per-block results, keychain table: no temp item added); no `.gemini/settings.json` under `.cache/spike-projects` (checked 2026-11-14). *Via:* the `baseline` snapshot was lost, so per-block snapshots from S10 on replace the final compare (D-P0-35).
- [x] **G0-14** Hygiene: `grep -rn "spikes/" src/` empty (Phase 0 adds no `src/`); `git status --porcelain` lists only intended files; `.cache/` ignored. *Evidence:* gate0.md suite.
- [x] **G0-15** All P0-G-T3 `record_decision` entries exist; progress file current. *Evidence:* report §5 (16, 23–28, 32–39); Gate 0 approval is record_decision 41.
- [x] **G0-16** Codex diff review → Claude second review → owner stop; `.handoff/` deleted. *Evidence:* gate0.md Reviews (Codex approve on `7deb8cb`, Claude second review approve, owner approved 2026-11-10); no Gate 0 handoff files remain.

### 0.21 Risks (Phase 0)

| Risk | Mitigation |
|---|---|
| Electron's bundled Node lacks `node:sqlite`, FTS5, worker support, `readOnly` or `backup` | S1 tests each separately; better-sqlite3 fallback needs approval and an Electron-ABI rebuild; never both engines |
| `node:sqlite` is experimental and changes on an Electron upgrade | Pin Electron; record stability level; re-run S1 probes on every bump |
| Electron-run-as-Node too slow for M16; RunAsNode fuse is a local-code-execution surface | Measure; SEA alternative; record the fuse trade-off |
| SEA embeds a second Node runtime (size, Apple Silicon codesign, `--build-sea` maturity) | Measure size; ad-hoc signing; `postject` only with approval |
| Cross-process `hrtime` not comparable | Clock sanity check; else hop sums and end-to-end only |
| Commit-ack exceeds the 100 ms deadline and causes duplicate spooling | Measure both ack points; owner decision (OQ-A1) |
| Seatbelt deprecated, cannot nest, may miss DNS paths | Mandatory positive control; NetLog and Node channels corroborate; owner-run or approved unsandboxed run |
| The Claude sandbox blocks GUI launch, loopback bind, agent network, keychain, TTY | Entry criterion 4; per-command approval or owner-run scripts; expect PTY driving with owner fallback |
| A temp sign-in overwrites or reuses the real keychain credential, or an inherited env key leaks in | `env -i` runner with all five isolation variables; credential backend proven isolated from docs before any probe or login (P0-T06 step 1), else UNVERIFIED; guard keychain added/modified/removed before/after; stop rule (OQ-X4) |
| A CLI ignores the env override and writes a real profile (`~/.claude.json`, plugin cache, VS Code globals) | `HOME` also isolated; sandbox write allowlist; guard after every block |
| Agent auto-updates mid-spike, invalidating pins | Auto-update disabled; versions checked at block start and end |
| A retention spike deletes real history (workspace-scope setting left behind, or override not applied) | User scope in temp profiles only; workspace file deleted right after; sentinel check; G0-13 leftover check |
| Desktop/VS Code surfaces cannot use disposable profiles | Accepted coverage limit; PRD defaults (observe-only, view-only) apply; never observe real profiles |
| Expect-driven TUIs are brittle | Marker-substring matching with timeouts; owner manual checklist fallback |
| Live runs spend the owner's quota | Fixed tiny prompt set; budget (OQ-X10) |
| Raw temp evidence or owner audit output leaks into git or a chat | Raw only in `.cache/`; allowlist reducer; `npm run privacy:scan` before review; owner-run numberless questionnaire |
| Codex trust semantics differ from PRD assumptions | S5-T4 characterises them; Phase 3 shim adapts; never write trust |
| Tee cannot match Claude's invocation or cancellation semantics | Golden plus live tests; failure goes back to the owner, no silent fallback |
| Synthetic load and a warm page cache flatter results | Labelled feasibility only; real gates decide; optional `sudo purge` |
| ≥10 GiB corpus build is slow and disk-heavy | Free-space precheck; seeded; git-ignored; deletable after Gate 5 on owner OK |
| Validator choice pulls transitive deps or a network `$ref` path | Selection criteria; owner approval |
| Spike code leaks into `src/` | Grep check every gate; Phase 1 lint rule |
| Temp profiles with credentials inside the repo dir are visible to the harness-os Docker mount | OQ-X1 (scratchpad alternative) |

### 0.22 Open questions (Phase 0)

See §6: OQ-X1–X16 (cross-cutting) and OQ-A1–A16, OQ-B1–B18, OQ-C1–C15 (Phase 0). Each has a default.

## Phase 1 — Skeleton + Claude ingest (Gate 1)

**Goal.** A packaged, single-instance Electron app with a tray, a deny-by-default security and network policy, a supervised `utilityProcess` service that restarts with bounded backoff, a private SQLite store with forward-only migrations and a recovery path, Claude transcript and subagent backfill plus live tail with transactional checkpoints, and a read-only paged session list. Also: privacy tooling (pre-commit, privacy scan with D-20 secret patterns, fixture lint), the connection-attempt audit in every E2E run, and one `sanitize()` covering every egress path that ships in Phase 1 (logs, diagnostics bundle, crash/error records, test artifacts).

**Maps.** S-01 (Claude/Codex detection subset), S-02, S-04 (schema, FTS5, Claude dedup), S-13 (tray, close/quit only), S-14, S-15, S-29 (paged APIs, bounded batches); FR-01, FR-02, FR-08, FR-09; P1–P5, SEC1, SEC3, ROB, PERF, Reproducibility; US-1 (read-only list), US-9 (tray), US-12, US-15 (Claude part); M3 first-list, M6, M9.

**Branch.** `feat/phase1-claude-ingest`, after the Phase 0 PR is merged.

**Installs at phase start** (owner approval, `--save-exact`, `npm_config_cache=.cache/npm`):
- `npm install --save-exact --save-dev vite @vitejs/plugin-react @playwright/test eslint typescript-eslint`
- `npm install --save-exact react react-dom`
- Not on App. C, separate approval (OQ-P1-02): `@types/react`, `@types/react-dom`, explicit `@types/node`.
- The Gate 0 JSON Schema validator, if a package was selected (first user: P1-T08) (OQ-X6).
- electron, typescript, electron-builder come from Phase 0; `better-sqlite3` only if S1 rejected `node:sqlite`. Playwright `_electron` drives the Electron binary, so no browser download.
- Done-evidence: `npm ls --depth=0` plus version and license list in the progress file.

**Entry criteria.**
1. Gate 0 passed, Phase 0 PR merged, `phase0_spikes.md` approved.
2. S1 chose exactly one engine with WAL/FTS5/kill-restart evidence from a packaged `utilityProcess`.
3. S9 pinned the Claude 2.1.319 transcript schema (entrypoint values, injected-content prefix list, compaction/system record shapes, subagent layout, whether `sessions/*.json` carries a pid, `.jsonl.zst` producer and runtime zstd availability); fixtures under `test/fixtures/synthetic/claude/2.1.319/`.
4. S10 chose the connection-attempt audit mechanism, the Chromium switches and session settings needed for zero attempts, and whether `--use-mock-keychain` is needed.
5. S12 set the watch reconciliation interval (Q8, FR-02) and the minimum service architecture (whether a writer or parser worker is needed before Phase 4).
6. Gate 0 validator decision recorded (App. C).
7. harness-os containers running; Codex companion runnable outside the sandbox per PRD App. B item 6 and OQ-X2.

**Loop.** HP (§2.3) for every gated unit (spec prefix `XAIBO-1nn`). E2E (`npm run test:e2e`) and perf (`npm run perf`) RED/GREEN recorded by hand, sanitized (OQ-X8).

### Ordered tasks

#### P1-T01 — Toolchain scaffold
- **Build:**
  - `package.json` scripts per §7.7: `dev` = `node scripts/dev.ts` (starts Vite programmatically on 127.0.0.1 with `strictPort`, spawns electron with the `Xaibo-dev` data dir); `build` = `tsc` for main, service, shared, preload, then `vite build`, then copy `store/migrations/*.sql` if the directory exists (it arrives with P1-T07); `test` = `node --test "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"`; `test:e2e` = `playwright test -c test/e2e/playwright.config.ts` against `dist:mac -- --dir` output; `lint` = `eslint .`; `typecheck` = `tsc --noEmit` for both tsconfigs (plus `-p spikes`); `perf` = `node test/perf/run.ts`; `privacy:scan`, `fixtures:lint`. `dist:mac` is repointed from the Phase 0 spike config to the product electron-builder config.
  - Node-side `tsconfig.json`: `strict`, `module: nodenext`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `.ts` import specifiers (Node 26 runs tests and scripts with no build). `src/renderer/tsconfig.json`: DOM, `jsx: react-jsx`. Sandboxed preload is one CommonJS file `src/main/preload.cts`.
  - `eslint.config.js` (typescript-eslint flat config): `no-restricted-imports` banning `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns` (and `node:` forms), `undici`, `ws`, and any `**/spikes/**` path inside `src/` (future socket/OTLP modules get per-file allowlists only when they land); `no-restricted-globals` for `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`; `no-restricted-syntax` for the Electron `net` import, `session.fetch`, `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`; one sanctioned spawn module (`child_process` import allowed only there).
- **Files:** `package.json`, `tsconfig.json`, `src/renderer/tsconfig.json`, `eslint.config.js`, `vite.config.ts`, `scripts/dev.ts`, product `electron-builder` config.
- **Test first (U):** `test/unit/lint-rules.test.ts` uses ESLint `lintText` on samples with `fetch(`, `import http`, Electron `net`, `innerHTML=`, a `spikes/` import, a stray `child_process` import, and a clean sample. Fails first (no config).
- **Loop:** `npm test -- test/unit/lint-rules.test.ts && npm run lint && npm run typecheck`
- **Done:** lint/typecheck green on the skeleton; rule test passes. (`npm run build` first runs in P1-T04, when `src/main/index.ts` and `src/renderer/index.html` exist.)
- **Deps:** installs approved. **Owner:** approve installs incl. OQ-P1-02. **Harness:** config files exempt; no spec.

#### P1-T02 — Privacy tooling (EC-62)
- **Build:**
  - Extend the Phase 0 `scripts/privacy-scan.ts` (P0-T08; same single pattern list, unchanged) with modes `--staged` (staged blob via `git show :<path>`), `--all` (tracked files) and `--history` (`git log -p --all`). No second pattern list is written here. <!-- privacy-scan:allow pattern documentation -->
  - `scripts/fixture-lint.ts` over `test/fixtures/synthetic/`: IDs match the synthetic UUID pattern; paths start with `~`, `<project>` or `/tmp/xaibo-fixture/`; emails use example domains; plus all privacy-scan patterns.
  - `.githooks/pre-commit` (POSIX sh): `node scripts/privacy-scan.ts --staged && node scripts/fixture-lint.ts --staged`. `git config core.hooksPath .githooks` once, documented in the progress file.
- **Files:** `scripts/privacy-scan.ts` (extended), `scripts/fixture-lint.ts`, `.githooks/pre-commit`, `test/unit/privacy-scan.test.ts` (new mode cases), `test/unit/fixture-lint.test.ts`.
- **Test first (U):** positive/negative samples built at test time by string concatenation (no committed secret-shaped literal; avoids self-detection and push protection); each pattern id fires; allow marker suppresses; output never contains the raw match; username/hostname check works with an injected `userInfo`. Fails first.
- **Loop:** `npm test -- test/unit/privacy-scan.test.ts test/unit/fixture-lint.test.ts && npm run privacy:scan -- --all && npm run fixtures:lint`; manual: stage a temp file with a generated canary, `git commit --dry-run` is blocked, then unstage and delete.
- **Done:** pre-commit blocks the canary; `--all` and `--history` clean; Phase 0 fixtures pass fixture-lint (OQ-B9).
- **Deps:** T01. **Maps:** S-15, P5, EC-62 (R + U). **Harness:** `scripts/` not gated; allow-marker policy via `record_decision`.

#### P1-T03 — `sanitize()`, content-free logger, canary generator (EC-33, EC-35 logs)
- **Build:** `src/shared/sanitize.ts` masks recognized credential formats (the pattern list moves from `scripts/privacy-scan.ts` into `src/shared/secret-patterns.ts`, imported by both; one list), configured secret keys (key names in JSON/env-like text) and emails; home path → `~`; idempotent; documented best effort. `src/shared/log.ts`: allowlisted fields (event code, numbers, error codes, sizes, durations, IDs hashed with HMAC-SHA256 truncated using the per-install secret, OQ-X14); every string through `sanitize()`; content never logged (P4); size-bounded rotating files under `<appdata>/logs/`, 0600. `test/helpers/canary.ts` generates canaries in memory per pattern class plus a home path and an email.
- **Files:** `src/shared/sanitize.ts`, `src/shared/secret-patterns.ts`, `src/shared/log.ts`, `test/unit/sanitize.test.ts`, `test/unit/log.test.ts`, `test/helpers/canary.ts`.
- **Test first (U, canary):** each canary class absent after `sanitize()`; idempotent; home → `~`; logger drops non-allowlisted fields, writes no content string, hashes IDs, file mode 0600. Fails first.
- **Loop:** `npm test -- test/unit/sanitize.test.ts test/unit/log.test.ts`
- **Deps:** T02. **Harness:** `security-change`, XAIBO-101.

#### P1-T04 — Electron main shell (EC-47, EC-55 CSP part, SEC1, P2 policy, tray)
- **Build:**
  - `src/main/app-paths.ts` (before `ready`): data dir = `XAIBO_DATA_DIR` for tests, else `userData` (`Xaibo`, or `Xaibo-dev` unpackaged); `setPath` for `userData`, `sessionData`, `logs`; `process.umask(0o077)`; data dir 0700.
  - Single instance: `app.requestSingleInstanceLock()`; second instance quits; first focuses on `second-instance`. Dev and prod lock separately (different data dirs; the Phase 3 socket path derives from the data dir).
  - `src/main/security.ts`: `protocol.handle('app', …)` serves `dist/renderer` with a path-traversal guard and CSP header `default-src 'self'; connect-src 'self'` (also as meta); `session.webRequest.onBeforeRequest` allows `app:` and `devtools:`, plus the loopback Vite origin and its WS in dev only, cancels and counts everything else; permission request/check handlers always deny; `will-navigate` blocked; `setWindowOpenHandler` deny; `will-attach-webview` blocked; spellcheck and dictionary download off; no crash reporter upload, no auto-updater; S10-chosen Chromium switches; `BrowserWindow` `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`.
  - `src/main/tray.ts`: "Show Xaibo", "Save diagnostics…" (T13), "Quit". Close hides the window (not destroyed), collection continues; Quit stops the service and exits.
  - No `shell.openExternal` in Phase 1 (allowlist lands with first use in Phase 6/7).
- **Files:** `src/service/index.ts` (minimal: posts `ready` on its port; T06 adds the supervisor with restart and health, T07 the store), `src/main/index.ts` (forks the service once with `utilityProcess.fork`, no restart until T06), `src/main/app-paths.ts`, `src/main/security.ts`, `src/main/tray.ts`, `src/main/preload.cts`, `src/renderer/index.html`, `test/unit/app-paths.test.ts`, `test/e2e/shell.spec.ts`, `test/e2e/security.spec.ts`.
- **Test first:** U — data-dir resolution and modes with injected env. E — two launches on one data dir: second exits, first stays; dev and prod-like launches with different data dirs both run; in the renderer `window.open` returns null, navigating to `https://example.invalid` is blocked, `getUserMedia` rejects, `typeof require`/`process` is `undefined`; closing the window keeps main and service pids alive; tray Quit (via `electronApp.evaluate`) exits every process. Fails first.
- **Loop:** `npm test -- test/unit/app-paths.test.ts && npm run build && npm run dist:mac -- --dir`; the E specs run in P1-T05 once `playwright.config.ts` and the audit fixture exist.
- **Done:** U green; `npm run build` emits `out/` and `dist/renderer/`; the packaged app launches. EC-47 E, the security spec and close/hide/Quit are verified in P1-T05.
- **Deps:** T01, T03. **Owner:** may need unsandboxed Electron/packaging runs (R-P1-01). **Maps:** SEC1, P1, P2, S-13, US-9. **Harness:** `security-change`, XAIBO-102.

#### P1-T05 — Connection-attempt audit and repo-write guard in every E2E run (EC-60, EC-61, M6)
- **Build:** `test/e2e/fixtures.ts`, the shared Playwright fixture: launches the packaged app with an isolated environment (temp `HOME`, `XAIBO_DATA_DIR`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, fake `SHELL`, fake agent binaries on `PATH`) and wraps every test in the S10-selected attempt audit: Chromium net-log (`--log-net-log`) parsed for any non-loopback host/IP incl. resolver attempts; the OS-level deny-and-log profile or socket audit over the whole process tree (main, renderer, GPU/network utility, service); the `onBeforeRequest` counter as supporting evidence only. After every test: zero non-loopback attempts (fail on any attempt, not only success); `git status --porcelain` unchanged (app run with cwd at the repo root); fixture agent-store checksums identical (§9.3 native-files-untouched). Startup, failure (service killed) and shutdown paths run under the audit.
- **Files:** `test/e2e/fixtures.ts`, `test/e2e/audit.ts`, `test/e2e/playwright.config.ts`, `test/e2e/network.spec.ts`, `test/unit/netlog-parse.test.ts`.
- **Test first:** U — parser flags a synthetic non-loopback attempt and ignores loopback. E — `network.spec.ts` uses a test-only renderer action and a test-only main hook (env-flag gated in the test build) to attempt `https://example.invalid`; asserts blocked and recorded as a failure; a deliberate temp repo write proves the repo-write guard. Fails first.
- **Loop:** `npm test -- test/unit/netlog-parse.test.ts && npm run test:e2e -- network.spec.ts shell.spec.ts security.spec.ts`
- **Done:** every E2E spec runs through the fixture; negative tests prove both detectors; P1-T04's EC-47 E, security spec and close/hide/Quit pass.
- **Deps:** T04, S10. **Owner:** may need unsandboxed OS-level audit runs. **Maps:** P2, M6, EC-60 (E + S10), EC-61 (E). **Harness:** `security-change`, XAIBO-103 (only the env-flag test hook lives in `src/`, with a unit test for the flag).

#### P1-T06 — Service process with restart backoff and health (ROB)
- **Build:** `src/main/service-supervisor.ts` forks `src/service/index.ts` with `utilityProcess.fork`; brokers a `MessageChannelMain` port service↔renderer and re-brokers after every restart; unexpected exit → restart with bounded exponential backoff (pure `nextDelay(attempt)`, constants OQ-P1-07); counter reset after a healthy period; health `starting|running|restarting n|stopped` to the renderer as text plus icon; Quit stops without restart. `src/shared/ipc.ts`: versioned message types with hand-written validation; invalid messages dropped and counted. The service resumes from committed checkpoints without re-import (verified in T10).
- **Files:** `src/main/service-supervisor.ts`, `src/service/index.ts`, `src/shared/ipc.ts`, `test/unit/service-supervisor.test.ts`, `test/unit/ipc.test.ts`, `test/e2e/service-restart.spec.ts`.
- **Test first:** U — backoff sequence, cap, reset with injected clock/spawn; no restart after Quit; IPC rejects unknown versions/types. E — SIGKILL the service pid (`electronApp.evaluate`); health shows "Restarting" then "Running"; pre-kill rows present with no duplicates (list API count); a post-restart append appears. Fails first.
- **Loop:** `npm test -- test/unit/service-supervisor.test.ts test/unit/ipc.test.ts && npm run test:e2e -- service-restart.spec.ts`
- **Deps:** T04, T07, T10 (for E); executed after P1-T10 (listed here for the supervisor design; its E test needs T07 and T10). **Maps:** ROB, §7.1. **Harness:** `new-feature`, XAIBO-104.

#### P1-T07 — SQLite store, schema, migrations with a recovery path (EC-45)
- **Build:**
  - `src/service/store/db.ts`: S1 engine; §7.4 pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL` before the first table, `temp_store=MEMORY`); `PRAGMA user_version` as schema version.
  - `migrate(db, migrations)`: forward-only, each migration in a transaction, only after the recovery path: (1) free space via `fs.statfs` (≥ DB size + margin); (2) online backup with the engine's backup API and progress to `<appdata>/backups/` (0600; only the latest kept, OQ-P1-17); (3) migrate; (4) on failure roll back, reopen read-only, health banner "Database migration failed: read-only", never delete data; (5) insufficient space → refuse and the same read-only banner. Migration/backup progress reported separately from readiness.
  - `migrations/001_init.sql` (Phase 1 tables only): `profiles` (opaque id, agent, root, origin `default|env|manual`); `sessions` (`UNIQUE(agent, profile_id, native_session_id)`, original cwd, entrypoint, interactive, title, started/last_activity, native_available, record/unknown/quarantined counts, drift flag); `events` (§5.4 envelope: `schema_version`, `source`, `confidence`, `source_ts`, `file_mtime`, `received_ts`, `source_seq`, `ingest_id`; native uuid, parent uuid, `message.id`, kind, role, subagent native id, file id, byte offset, full extracted content, raw source line (OQ-P1-05); `UNIQUE(session_id, source, native_id)`); `subagents`; `source_files` (path, dev, ino, size, mtime, offset, head_hash, kind, status `ok|compressed_not_imported|gone|oversized`); `quarantine`; `event_fts` (FTS5 external content, `unicode61`, first 64 KiB UTF-8-safe prefix); `kv`; indexes `(session_id, source_seq)` and `(last_activity DESC, id)` (deviation from §7.4's `(agent, last_activity)`, added when agent filtering ships; recorded with `record_decision`).
  - `schema.sql` snapshot kept equal by a test. Writer batches ≤500 rows or 100 ms per transaction (or the S12 bounds) and commits records with their `source_files` checkpoint; live batches scheduled ahead of backfill.
- **Files:** `src/service/store/{db.ts,writer.ts,schema.sql,migrations/001_init.sql}`, `test/integration/store.test.ts`, `test/integration/migration-failure.test.ts`, `test/unit/fts-prefix.test.ts`.
- **Test first:** I — fresh DB applies 001 and matches `schema.sql`; pragmas verified; DB/`-wal`/`-shm` 0600; batch+checkpoint atomic (throw after rows → no rows, no checkpoint advance); FTS5 MATCH. EC-45 (I) — a failing second migration: backup exists, `user_version` unchanged, DB read-only with banner flag, all rows remain; insufficient space (injected `statfs`) → refused, same outcome. U — 64 KiB prefix never splits UTF-8. SQLite I-tests also run under the Electron runtime (OQ-P1-15). Fails first.
- **Loop:** `npm test -- test/integration/store.test.ts test/integration/migration-failure.test.ts test/unit/fts-prefix.test.ts`
- **Done:** EC-45 passes; schema snapshot test passes.
- **Deps:** T01, S1. **Maps:** S-04, §7.4, ROB. **Harness:** `new-feature`, XAIBO-105.

#### P1-T08 — Detection of executables, login-shell env and profiles (EC-38, EC-39)
- **Build:** `integrations/agents.catalog.json` with Claude and Codex entries limited to the detection subset (binary names, known locations, version args, default profile root, env overrides `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, existence evidence) and `integrations/agents.catalog.schema.json` for exactly that subset (unknown fields rejected), validated with the Gate 0 validator (OQ-P1-01, OQ-X6). `src/service/catalog/env.ts`: one fixed-argument login-shell read (OQ-P1-03) `execFile($SHELL, ['-l','-c','/usr/bin/env -0'])`, `stdin: ignore`, 3 s timeout, bounded output, no interpolation; keeps only `PATH`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`. `src/service/catalog/detect.ts`: candidates from login-shell PATH, catalog known locations and manual paths; bounded shell-free version probe (`execFile`, 3 s, bounded) for bundled entries only; states Detected (with version) / Not detected (normal, never an error). Manual path = regular executable, realpath, stored in `kv`. Profiles = default root + env overrides + manual roots, opaque ids; session identity includes the profile. Rescan on service start. Detection authorizes nothing beyond the version probe. Renderer: minimal agent status strip and "Set path…" via the native file dialog.
- **Files:** `integrations/agents.catalog.json`, `integrations/agents.catalog.schema.json`, `src/service/catalog/{env,detect,validate}.ts`, `test/unit/detect.test.ts`, `test/unit/login-env.test.ts`, `test/integration/profiles.test.ts`, `test/fixtures/synthetic/catalog/`.
- **Test first:** EC-38 (U) — absent from PATH and known locations → Not detected, no throw, no error log; only at a known location not on GUI PATH → Detected; manual path accepted after validation; probe timeout → Not detected. Login env (U) — noisy shell output before `env -0`, timeout, non-allowlisted keys dropped (a canary key never appears in logs). EC-39 (U + I) — temp HOME with default `~/.claude` and a second profile from the fake login env: the same native session id in both gives two sessions; `CODEX_HOME` detected as a Codex profile (no ingest yet); manual profile root honored. Fails first.
- **Loop:** `npm test -- test/unit/detect.test.ts test/unit/login-env.test.ts test/integration/profiles.test.ts`
- **Deps:** T07. **Maps:** S-01, FR-01, SEC5. **Harness:** `security-change` (spawning), XAIBO-106.

#### P1-T09 — Claude transcript parser, a pure module (EC-04, EC-08, EC-14, EC-16)
- **Build:** `src/service/adapters/claude/parse.ts` (raw line bytes + file context → normalized record or counted outcome). Tolerant; fields `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `entrypoint`, `version`, `message.role/content[]/usage/id/model`. Injected content filtered by the S9 prefix list (stored and counted, never shown as a prompt). Partial updates of one `message.id` collapse to the latest. Unknown types stored raw and counted; drift flag when unknown share >5%. Ordering by `source_seq` (byte offset); `source_ts`, `file_mtime`, `received_ts` all stored; durations from one source only, negative or cross-source → NULL. cwd only from records, never the encoded dir name (incl. >200-char hashed names); original kept; comparison key realpath + NFC. `src/service/lines.ts` splits on byte 0x0A before decoding, carries trailing partial bytes; a malformed complete line is quarantined and counted.
- **Files:** `src/service/adapters/claude/parse.ts`, `src/service/lines.ts`, `src/service/paths.ts`, `test/unit/{claude-parse,lines,paths}.test.ts`, fixtures `test/fixtures/synthetic/claude/2.1.319/{simple-turn,subagent,format-drift,clock-skew,partial-line,unicode-paths,long-dirname,injected-content}/`.
- **Test first (U):** EC-04 — drift fixture: unknowns stored and counted; flag set at >5%, clear at ≤5%. EC-08 — out-of-order timestamps order by `source_seq`; all three timestamps kept; negative duration NULL. EC-14 — a line split across chunks (incl. mid-codepoint) parses once; malformed complete line quarantined. EC-16 — Unicode/spaced/long paths keep originals; NFC-equivalent compare equal; long/hashed dir names never yield a cwd. Partial `message.id` collapses; injected content not a prompt. Fails first.
- **Loop:** `npm test -- test/unit/claude-parse.test.ts test/unit/lines.test.ts test/unit/paths.test.ts && npm run fixtures:lint`
- **Deps:** T01, S9. **Maps:** S-02, S-04, §5.2, §5.5–§5.8, FR-08. **Harness:** `new-feature`, XAIBO-107.

#### P1-T10 — Tailer, checkpoints, watch, reconciliation, zstd (EC-03, EC-13, EC-18, EC-19)
- **Build:** `src/service/tail.ts`: checkpoint per file `(path, dev, ino, size, mtime, offset, head_hash)`; size < offset or head-hash/inode change → reparse from 0 with dedup by Claude `uuid`; offset advances only to the last complete newline, atomically with records (T07 writer). `.jsonl.zst`: stream-decompress if S9 confirmed `zlib.createZstdDecompress` in Electron's Node, else status `compressed_not_imported` plus coverage warning; never modified. `src/service/watch.ts`: one recursive `fs.watch` per profile root (or the S12 strategy); periodic bounded stat-only reconciliation at the watch reconciliation interval (S12/Q8) that never reads unchanged files; reconcile on wake (`powerMonitor` `resume` in main → service); realpath grouping for symlinked dirs; watch failure/error → polling at the interval for that root (OQ-P1-12). Backfill newest-first; live files ahead; inactive handles closed. Subagent files under `<id>/subagents/` discovered recursively and linked.
- **Files:** `src/service/tail.ts`, `src/service/watch.ts`, `src/service/adapters/claude/{discover,index}.ts`, `test/unit/tail.test.ts`, `test/unit/zst.test.ts`, `test/integration/{watch,symlink,claude-ingest}.test.ts`.
- **Test first:** EC-13 (U) — truncate below offset, rotate (new inode), replace (same size, different head hash): each reparses with zero duplicates. EC-03 (U) — zstd capability injected present → imports; absent → `compressed_not_imported` + warning; checksum unchanged both ways. EC-18 (I) — symlinked temp HOME and project dir group under one realpath; injected watch error → appended line still imported via polling within the interval. EC-19 (I, real clock, short interval) — with watch events suppressed, an appended line visible within interval + 1 s; zero reads of unchanged files (counted); simulated wake → immediate reconcile. Claude ingest (I) — backfill plus tail with subagents linked; kill/restart mid-batch: no duplicates, no lost committed rows. Fails first.
- **Loop:** `npm test -- test/unit/tail.test.ts test/unit/zst.test.ts test/integration/watch.test.ts test/integration/symlink.test.ts test/integration/claude-ingest.test.ts`
- **Done:** EC-03 (U part; S9 part closed at Gate 0), EC-13, EC-18, EC-19 pass.
- **Deps:** T07, T09, S9, S12. **Maps:** S-02, FR-02, ROB, PERF. **Harness:** `new-feature`, XAIBO-108.

#### P1-T11 — Liveness check (EC-01)
- **Build:** `src/service/liveness.ts` pure `liveness(record, processTable)`: `live` only if pid alive and start time and executable match; else `stale`; a pid alone never yields `ended`. macOS provider `ps -o pid=,lstart=,comm= -p <pid>` via `execFile`, no shell, timeout, bounded output. Wired to Claude session metadata only if S9 confirmed a pid-bearing source (OQ-P1-11); else ready for Phase 3/7.
- **Files:** `src/service/liveness.ts`, `test/unit/liveness.test.ts`.
- **Test first (U, fake process table):** matching → live; reused pid with different start time → stale; different executable → stale; gone → stale, never ended. Fails first.
- **Loop:** `npm test -- test/unit/liveness.test.ts`. **Deps:** T01. **Maps:** FR-05. **Harness:** `new-feature`, XAIBO-109.

#### P1-T12 — Read-only session list over paged IPC (EC-55)
- **Build:** service `listSessions({cursor, limit})` keyset over `(last_activity DESC, id)`, default and hard cap (proposed 100), cursor always progresses; coalesced session-summary deltas over the brokered port (≤1 per 250 ms). Renderer (React): first page plus "Load more" (virtualization is Phase 4), T06 health indicator, T08 status strip; columns (OQ-P1-04): agent, entrypoint badge, original cwd, native title or "Untitled", last activity, coverage markers (drift, compressed-not-imported, quarantined count) as text plus icon. All strings as React text nodes; ANSI/control sequences made visible as escaped text (`src/renderer/text.ts`); no HTML injection path. Minimal semantic HTML with keyboard focus and labeled controls; not the Gate D design; no visual baselines.
- **Files:** `src/service/api.ts`, `src/renderer/{main.tsx,SessionList.tsx,Health.tsx,text.ts}`, `test/unit/keyset.test.ts`, `test/unit/text.test.ts`, `test/e2e/session-list.spec.ts`, `test/e2e/untrusted-content.spec.ts`, fixture `test/fixtures/synthetic/claude/2.1.319/untrusted-content/`.
- **Test first:** U — keyset progresses with ties; page cap enforced; `text.ts` escapes ANSI/control chars. EC-55 (E) — fixture puts `<img src=x onerror=…>`, `<script>`, markdown and ANSI into cwd and title: rendered `textContent` equals the raw string, no `img`/`script` element created, a sentinel global stays unset, CSP violations captured via `securitypolicyviolation`; lint already forbids `dangerouslySetInnerHTML`/`innerHTML`. E — rows appear from backfill; live append updates the row; "Load more" pages without duplicates. Fails first.
- **Loop:** `npm test -- test/unit/keyset.test.ts test/unit/text.test.ts && npm run build && npm run dist:mac -- --dir && npm run test:e2e -- session-list.spec.ts untrusted-content.spec.ts`, then Playwright MCP visual check against a temp-synthetic-data dev instance (render, empty console, keyboard flow; attach method OQ-X11).
- **Done:** EC-55 passes; MCP check noted in the progress file.
- **Deps:** T06, T10. **Maps:** S-08 precursor, FR-09, SEC3, US-1. **Harness:** `new-feature`, XAIBO-110.

#### P1-T13 — Diagnostics bundle, crash policy, egress coverage (EC-33, EC-35, M9)
- **Build:** `src/main/diagnostics.ts` (tray "Save diagnostics…"): `dialog.showSaveDialog`, then a JSON bundle (app/Electron/OS versions, health, counters, log tail) through `sanitize()`. Crash policy (OQ-P1-10): `crashReporter.start` never called; uncaught exceptions/rejections in main and service go through the T03 logger as sanitized error-code entries. Test helpers writing under `test-results/` pass content through `sanitize()`. `src/shared/egress.ts` registry lists shipped paths (logs, diagnostics, crash/error records, test artifacts); a unit test requires one canary test per listed path (MCP, OTLP and export join when they ship).
- **Files:** `src/main/diagnostics.ts`, `src/shared/egress.ts`, `test/unit/egress-coverage.test.ts`, `test/unit/diagnostics.test.ts`, `test/e2e/canary.spec.ts`.
- **Test first:** EC-35 (U) — every registry path has a canary test; diagnostics writer and error logger strip all canary classes; logs contain no content strings. EC-33 (U canary + E) — a runtime-generated canary transcript is ingested; the DB holds full content; DB/logs/data dir 0600/0700; after an induced error, the diagnostics bundle (dialog stubbed via `electronApp.evaluate`), logs and `test-results/` artifacts contain zero hits for every canary form; no crash dump directory has reports. Fails first.
- **Loop:** `npm test -- test/unit/egress-coverage.test.ts test/unit/diagnostics.test.ts && npm run test:e2e -- canary.spec.ts`
- **Done:** EC-33 and EC-35 (shipped paths) pass; M9 = 0 canary hits per path.
- **Deps:** T03, T04, T10. **Maps:** P1, P3, P4, M9. **Harness:** `security-change`, XAIBO-111.

#### P1-T14 — Perf corpus, M3 first-list, huge transcripts (EC-15)
- **Build:** `scripts/gen-perf-corpus.ts` (seeded PRNG) emits Claude 2.1.319-shaped synthetic transcripts: ~1,000 sessions, median ~200 KB, p99 ~20 MB, max ~200 MB, ~500 MB total, subagents and a few huge single records (large-payload fields from S9), to `.cache/perf-corpus/<seed>/`; actual sizes recorded. `test/perf/run.ts` launches the unpacked packaged app with Playwright `_electron`, corpus as temp `CLAUDE_CONFIG_DIR`, empty data dir. `src/renderer/perf-marks.ts`: first-usable-page mark = double `requestAnimationFrame` after a commit with ≥1 row whose controls accept input; time via `performance.timeOrigin + performance.now()` per process. `PerformanceObserver` `long-animation-frame` (fallback `longtask`); frames >100 ms reported at Gate 1, enforced at Gate 2.
- **Files:** `scripts/gen-perf-corpus.ts`, `test/perf/{run,m3-first-list,ec15-huge}.ts`, `src/renderer/perf-marks.ts`.
- **Test first (P):** before the list mark exists, `run.ts` reports a missing mark and exits non-zero. EC-15 (P): a 200 MB transcript plus one huge record above and below the parse cap (OQ-P1-06): parsing streams; each FTS item ≤64 KiB; service peak RSS growth within the OQ-P1-06 bound comparing 20 MB and 200 MB files; list paging stays usable during import; the record above the parse cap is **not** parked as raw only: a bounded streaming extractor (FR-08) reads its readable fields (prompt, response, reasoning, tool input/output text) in chunks into private storage and FTS items, with memory within the OQ-P1-06 bound, and the UI pages through that content (Phase 4 lazy view, EC-15); a coverage gap is recorded only for bytes that cannot be read or interpreted, never for readable content.
- **Loop:** `node scripts/gen-perf-corpus.ts --seed <n> && npm run dist:mac -- --dir && npm run perf -- --tier T1 --metric m3-first-list --runs 20 && npm run perf -- --case ec15`
- **Done:** M3 first-list p95 ≤1.5 s over 20 runs during background import (OQ-P1-09); EC-15 passes; report records hardware, macOS, versions, seed, corpus/DB/index sizes, LoAF counts (aggregates only).
- **Deps:** T10, T12. **Owner:** decides any miss (Q19). **Maps:** M3, S-29, PERF. **Harness:** perf code outside `src/` except `perf-marks.ts` (`new-feature`, XAIBO-112).

#### P1-T15 — Gate 1
Run GS (§2.4) steps 0–6 in order, with these Gate 1 additions:
1. Step 0 (before freeze): progress file EC results, M3/M6/M9 aggregates, decisions, deviations, dependency licenses.
2. Step 1 suite also runs `npm run perf -- --tier T1 --metric m3-first-list`, the SQLite I-tests under the Electron runtime, the packaged S10-style audit (startup, 5 min idle, service-kill path, shutdown → zero attempts) and `npm run privacy:scan -- --history` (EC-62 R).
3. Step 3 handoff `.handoff/gate1-review.md`: diff excluding `package-lock.json`, dependency/version list, PRD §10 Phase 1 row, the EC rows below, test/metric summary.

### EC rows assigned to Gate 1

| EC | Case | Expected behaviour (summary) | Test (PRD) | Task / test file |
|---|---|---|---|---|
| EC-01 | Stale pid / pid reuse | Live only if pid alive and start time + executable match; otherwise stale; never ended from pid | U (fake process table) | P1-T11 `test/unit/liveness.test.ts` |
| EC-03 | `.jsonl.zst` history | Streaming decompress if runtime zstd exists; else "compressed, not imported" + warning; file untouched | U + S9 | P1-T10 `test/unit/zst.test.ts` (S9 half at Gate 0) |
| EC-04 | Format drift | Tolerant parse; unknown stored and counted; drift banner when unknown share >5%; per-version fixtures | U | P1-T09 |
| EC-08 | Clock skew | Order by source sequence; all three timestamps; one-source durations; negative → NULL | U | P1-T09 |
| EC-13 | Truncated/rotated/replaced file | size < offset or head-hash/inode change → reparse from 0 with dedup | U | P1-T10 |
| EC-14 | Partial trailing JSONL line | Carry bytes until newline; malformed complete line quarantined and counted | U | P1-T09 |
| EC-15 | Huge transcripts / huge record | Streaming parse; FTS first 64 KB per item; bounded memory; UI lazy | P | P1-T14 |
| EC-16 | Unicode/spaced/long paths; >200-char dir names | cwd from records; NFC compare; original displayed | U | P1-T09 |
| EC-18 | Symlinked/synced/network dirs | realpath grouping; polling fallback | I | P1-T10 |
| EC-19 | Missed watch events | Reconcile every interval and on wake; recovery ≤ interval + 1 s; bounded scans | I | P1-T10 |
| EC-33 | Secrets in prompts/tool output | Stored full locally (0600); masked on every egress path; canaries never in egress | U (canary) | P1-T03, P1-T13 |
| EC-35 | Egress redaction coverage | All shipped paths through `sanitize()`; one test per path; logs content-free | U | P1-T13 (MCP/OTLP/export added when they ship) |
| EC-38 | Agent not installed / not on GUI PATH | Login-shell PATH + known locations; Not detected + manual path; no errors | U | P1-T08 |
| EC-39 | Config-dir overrides, multiple profiles | Read from login-shell env; manual add; identity includes profile | U + I | P1-T08 |
| EC-45 | DB migration failure | Backup first; rollback; read-only banner; never delete data | I | P1-T07 |
| EC-47 | Two Xaibo instances | Single-instance lock; dev has its own data dir and socket | E | P1-T04 |
| EC-55 | Untrusted content rendering | Text only; ANSI safe; no `innerHTML`; CSP blocks scripts | E | P1-T12 |
| EC-60 | Non-loopback connection attempt | Blocked and logged; test fails on any attempt | E + S10 | P1-T05 (S10 at Gate 0; re-run in P1-T15) |
| EC-61 | Runtime writes into repo | None; `git status --porcelain` unchanged | E | P1-T05 |
| EC-62 | Real data in fixtures/commits | Pre-commit secret + privacy scan blocks; fixture lint enforces synthetic patterns | R + U | P1-T02 (R in P1-T15) |

### Metrics at Gate 1
- **M3 (first-list only):** T1, process start → first painted usable page with ≥1 row during background import; p95 ≤1.5 s over 20 cold runs (`npm run perf -- --tier T1 --metric m3-first-list --runs 20`); LoAF >100 ms reported not enforced; full import time reported for information.
- **M6:** attempt count across every E2E run (P1-T05) plus the packaged S10-style audit; target 0; renderer interception counts supporting only.
- **M9:** canary hits in logs, diagnostics bundle, crash/error records, test artifacts (`canary.spec.ts`); target 0 per path.

### Gate 1 checklist
- [ ] All 20 assigned EC rows pass (any waiver approved in writing by the owner).
- [ ] lint, typecheck, unit, integration, E2E and perf green on a clean worktree; SQLite I-tests green under the Electron runtime.
- [ ] M3 first-list, M6, M9 measured and reported with environment details, aggregates only.
- [ ] `privacy:scan --all/--history` and `fixtures:lint` green; pre-commit active (`core.hooksPath`).
- [ ] App data only in the temp or OS app-data dir with 0700/0600; repo unchanged after runs; fixture-store checksums unchanged.
- [ ] Playwright MCP visual check of the list (render, empty console, keyboard); no visual baselines yet.
- [ ] Dependency versions and licenses in the progress file.
- [ ] GS: Codex review (`.handoff/gate1-review.md`), Claude second review, owner stop; PR only on request.

### Risks (Phases 1–2)

| ID | Risk | Mitigation |
|---|---|---|
| R-P1-01 | Electron, packaging, Vite's loopback dev server and the OS-level audit may fail inside Claude Code's Seatbelt sandbox (window server, local bind, nested Seatbelt) | Owner allows those commands unsandboxed; failures reported with sandbox evidence; MCP checks only on temp-data dev instances |
| R-P1-02 | System Node `node:sqlite` differs from the Electron engine; a better-sqlite3 Electron-ABI binary will not load in system Node | SQLite I-tests run under the Electron runtime against `tsc` output (OQ-P1-15) |
| R-P1-03 | harness-os observes RED only via `npm test` | Every gated unit includes a node:test test; E2E RED logged by hand |
| R-P1-04 | FTS5 external-content delete needs the exact indexed text; Gemini folding deletes often | Indexed text is a deterministic byte prefix recomputed from stored content; `integrity-check` in fold tests |
| R-P1-05 | Login-shell env read hangs on interactive rc files or prints secrets | Fixed argv, `stdin: ignore`, 3 s timeout, allowlisted keys, never logged |
| R-P1-06 | Canary/secret-shaped fixtures trip push protection or the repo scan | Canaries generated at runtime, never committed |
| R-P1-07 | Chromium "Safe Storage" keychain prompts during tests | S10-decided `--use-mock-keychain` in tests (OQ-P1-08) |
| R-P1-08 | Sandboxed preload cannot use ESM imports | Single-file CJS preload (`.cts`) |
| R-P1-09 | A huge single-line record defeats bounded memory | Parse cap plus bounded streaming extraction of readable content; gap only for unreadable bytes (OQ-P1-06) |
| R-P1-10 | Gate 1 review diff is very large (skeleton + lockfile) | Lockfile excluded; split by directory (OQ-X7) |
| R-P2-01 | Installed agents drift from S9/S11 evidence | Per-version fixtures and drift counters; unknown records kept raw |
| R-P2-02 | Bundled prices wrong or stale; cache-write classes and qualifiers mispriced | Owner-verified sources; unknown qualifier → component unavailable; immutable revisions |
| R-P2-03 | Single-thread service misses the 120 s full import | Pull the S12 worker forward as a recorded, owner-decided deviation |
| R-P2-04 | Cumulative-counter semantics misread, inflating consumption | Segment tests, order-invariance assertions, S13 evidence |
| R-P2-05 | Moved or copied rollouts duplicate sessions | Content-based file identity (OQ-P2-02) |

### Open questions (Phase 1)
See §6: OQ-P1-02..P1-12, P1-15..P1-17 (OQ-P1-01 → OQ-X6, P1-13 → OQ-X7, P1-14 → OQ-X8).

---

## Phase 2 — Codex ingest + normalization, Antigravity CLI evaluation and ingestion (Gate 2)

**Goal.** Codex rollout ingest (backfill and tail, incl. `archived_sessions/`); Antigravity CLI (`agy`) evaluation, then ingestion/projection from verified facts only (D-P0-25, D-P0-36); the normalized model (Turn, ToolCall, Subagent, Usage, ContextSnapshot, CostEstimate, Codex rate-limit observations); §5.5 dedup and precedence; agent-specific token normalization; passive context mappings; §5.12 cost calculation with a bundled `integrations/models.json` and a validated private override; model display names and effort (FR-51); M3 full.

**Maps.** S-03, S-04, S-28 (native history, folding, subagents, cleanup detection), S-32 (context/cost data, no UI), S-35 (model data), S-29; FR-02, FR-08, FR-47, FR-48, FR-51; §5.3, §5.5, §5.6, §5.9, §5.11 (context), §5.12; US-3, US-15, US-17, US-18, US-19 (data layer); M3 full.

**Branch.** `feat/phase2-codex-agy-normalization`, after the Phase 1 PR is merged.

**Installs at phase start.** No new product package; validator per OQ-X6, zstd via runtime `zlib` only. T00 pins the `agy` install source/version; any package outside App. C needs owner approval before installation.

**Entry criteria.**
1. Gate 1 passed and merged.
2. S9 pinned the Codex 0.160.0 rollout schema (five record types, `session_meta.source`/`originator`, mirrored-message pairs, `token_count` fields, whether a `token_usage_record` version exists, `compacted` shape).
3. S11 is the template, not `agy` evidence: Gemini live C1–C5 and resume were UNVERIFIED; profile/retention source reads did not prove runtime behaviour. T00 pins the replacement contract before dependent work; no Gemini path, field or operation is inherited.
4. S13 supplies Claude/Codex price-component evidence only; `agy` token relationships require T00.
5. S6/S7 supply Claude/Codex resume evidence; `agy` requires T00. Unverified kinds remain disabled.

### Ordered tasks

#### P2-T00 — Antigravity CLI evaluation and input contract
- **Build:** S11 C1–C14 checklist as the template, initially UNVERIFIED. Inspect install/package sources without executing `agy` first; `~/.gemini/antigravity-cli/`, JSONL and hooks are hypotheses only. Pin install source/version probe/update-disable method; profile/config roots and isolation variable; credential backend/sharing; transcript paths, identity and record shapes; streaming/rewrite/patch/rewind/legacy semantics; subagents/parent linkage; usage/token fields, inclusion, scope and counter relationships; model/effort/context fields; tool-output storage; native retention/cleanup/precedence; interactive launch/resume argv; hooks, empty-output behaviour, trust and permission correlation. Source-read and runtime-verified are separate; unsupported/not-triggered/not-run never means pass.
- **Safety first:** before any `agy` binary (incl. help/version/login), extend/test `in-profile.*`, guard and root/env coverage for every required variable/root, retaining all five existing isolation variables. §3.2 with D-P0-15 external 0700 disposable profiles; `env -i`, sentinel/realpath checks, deny-wrapper canaries, supervision and version-before/after. Prove credential/keychain isolation before owner sign-in and before prompts; unknown/shared backend → stop. Owner signs in in their terminal. Guard snapshot/compare around every sign-in and live block; any DIFF stops live work for owner adjudication. Never inspect real session stores.
- **Run:** owner-authorized synthetic prompt set, ≤4 submissions total including retries, one working session (OQ-P2-10); cap/blocker → partial evidence. Retention probes plant synthetic old records only; no system-folder writes. Reporting/hook commands print nothing, exit 0, make no network/model calls; no quota/usage/token-count command. Only the isolated, owner-authorized native CLI evaluation may contact its provider; Xaibo stays zero-egress/zero-token.
- **Files:** `spikes/p2-agy/{check,facts}.ts`, `spikes/p2-agy/schemas/`, `spikes/shared/in-profile.{sh,ts}`, `spikes/shared/in-profile.test.ts`, `spikes/shared/guard{,.test}.ts`, `docs/plans/xaibo_progress.md`, fixtures `test/fixtures/synthetic/agy/<verified-version>/`. Reuse reducer/recorder; changes only if needed, their self-tests first. No spike imports in `src/`.
- **Test first (S + U):** checklist/expectations first; synthetic runner/guard checks fail before changes (new env/root escapes, credential-isolation policy, deny canaries, version probe inside wrapper). `check.ts` rejects missing evidence as a pass. Fixture expectations before synthetic inputs, from verified shapes only. Raw temp artifacts stay private; reduce to numberless facts/schemas before git, never copy live transcripts; private prompt tally outside git.
- **Loop:** `npm run spike:test && npm run spike:test:unsandboxed`; `node spikes/p2-agy/check.ts --self-test`; guard-bracketed approved evaluation; fixtures lint and privacy scan on proposed evidence.
- **Done:** versioned contract with per-fact status via `record_decision` and progress file. Map each unverified dependency to EC/FR and owner disposition (waive, defer, or Gemini-equivalent behaviour only where verified); approve EC-80/81 wording before T11 (OQ-P2-11). Later version changes follow §2.4/D-P1-17: synthetic tests plus `facts.ts` over temp profiles, no prompt; live prompt only for new record types/fields with owner OK per run.
- **Deps:** Gate 1; static isolation review before binary execution. **Owner:** install if needed, live run/sign-in, prompt budget, residual scope. **Harness:** none (no `src/` unit, §2.3; as P1-T05, D-P1-08); the contract and each live run are recorded with `record_decision`.

**Test-first rule.** Every changed `src/` unit follows harness-os spec → failing test → implementation → passing test → review → finalize; new parsing/normalization logic gets unit checks before the listed integration checks. T04–T12 `agy` changes use T00 synthetic fixtures only; unverified facts stay unavailable/disabled.

#### P2-T01 — Normalization schema (migration 002)
- **Build:** `002_normalize.sql`, every table with source identity and `schema_version`: `turns` (session, native turn/prompt id, start/end, outcome, model id, effort); `tool_calls` (native call id, tool/server, args/result event refs, approval state, duration, provenance source set); `subagents` + model id; `usage` (scope `message|turn|session`, model, uncached input, cache read, cache write with class, output, raw original fields, per-component completeness, source, request/counter identity, segment number); `context_snapshots` (session, generation, model, used, window, window basis `reported|inferred|unavailable`, percentage, source locator, `as_of`, `observed_at`); `cost_estimates` (covered scope, nullable `amount_usd`, basis, coverage, source, `as_of`, price revision, applied rates, unavailable reason); `price_revisions` (immutable); `usage_snapshots` (Codex rate-limit observations only, OQ-P2-01); `session_links`; `cwd_history`; `sessions` + originator, source kind, interactive, current model, current effort; `events` + current flag and revision status `current|superseded|rewound`; `schema.sql` updated.
- **Files:** `src/service/store/migrations/002_normalize.sql`, `src/service/store/schema.sql`, `test/integration/migration-002.test.ts`.
- **Test first (I):** a DB populated with a Phase 1 fixture migrates 001→002 through the recovery path (backup present, rows preserved); snapshot matches; an injected failure in 002 gives the EC-45 read-only outcome (regression).
- **Loop:** `npm test -- test/integration/migration-002.test.ts`. **Deps:** Gate 1. **Harness:** `new-feature`, XAIBO-201.

#### P2-T02 — Codex rollout parser (pure)
- **Build:** `src/service/adapters/codex/parse.ts`: `session_meta` (cwd, cli_version, source, originator), `turn_context` (model, approval/sandbox policy, reasoning effort), `response_item` (message, function_call, function_call_output, custom_tool_call, web_search_call, reasoning), `event_msg` (task_started, task_complete, token_count, agent_reasoning, others), `compacted`. Mirrored user/agent messages deduplicated. Unknown records stored raw and counted (Phase 1 drift rule). Session id from `session_meta`; filename mismatch → coverage warning. Dedup key `(file identity, byte offset)`, file identity = native session id + head hash (archive moves and copies do not duplicate, OQ-P2-02). Reuses `lines.ts`/`tail.ts`.
- **Files:** `src/service/adapters/codex/parse.ts`, `test/unit/codex-parse.test.ts`, fixtures `test/fixtures/synthetic/codex/0.160.0/{simple-turn,mirrored,compacted,token-count,unknown-records,archived}/`.
- **Test first (U):** each record type maps; a mirrored pair → one message; unknown counted; an archived copy of an ingested session → zero new events.
- **Loop:** `npm test -- test/unit/codex-parse.test.ts && npm run fixtures:lint`. **Deps:** T01, S9. **Maps:** S-03, §5.3. **Harness:** `new-feature`, XAIBO-202.

#### P2-T03 — Codex adapter (discovery and tail)
- **Build:** `src/service/adapters/codex/index.ts` discovers `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/` (sets `native_archived`); watch/reconcile/checkpoints reuse Phase 1; Codex version probe added to the catalog (data only). State DBs and `session_index.jsonl` not opened (S-03); enrichment only if T13 shows a gap and the owner approves.
- **Files:** `src/service/adapters/codex/{index,discover}.ts`, `integrations/agents.catalog.json`, `test/integration/codex-ingest.test.ts`.
- **Test first (I):** temp `CODEX_HOME` with dated and archived rollouts: backfill plus tail; kill/restart no duplicates; archived flag set.
- **Loop:** `npm test -- test/integration/codex-ingest.test.ts`. **Deps:** T02. **Harness:** `new-feature`, XAIBO-203.

#### P2-T04 — Entry points, session kinds, resume argv (EC-05, EC-50)
- **Build:** catalog maps Claude `cli`, `claude-vscode`, `claude-desktop`, `sdk-cli` and Codex `cli`, `vscode`, `exec`, `appServer`, `subAgent` (exact strings from S9) to an origin badge and interactive flag; non-interactive sessions (`claude -p`, SDK, `codex exec`) imported and tagged. `src/service/resume.ts` pure `resumeArgv(session)`: structured argv for kinds verified in S6/S7 (e.g. `['--resume', id]`) or `{disabled, reason}` for unverified kinds; never executed before Phase 7 (OQ-P2-08). List shows the origin badge and "Non-interactive" tag as text.
- **Build/test first (`agy`, U):** in the listed tests, T00-verified entrypoints map to badge/interactive status and exact resume argv; unknown kind or unverified UUID resume disabled with reason. T00 alone exercises native resume; product execution stays Phase 7.
- **Files:** `integrations/agents.catalog.json`, `src/service/resume.ts`, `src/renderer/SessionList.tsx`, `test/unit/session-kind.test.ts`, `test/unit/resume.test.ts`.
- **Test first (U):** EC-05 — every entrypoint/source fixture lands in one list with its badge; non-interactive tagged; resume argv valid per kind. EC-50 — `-p`/SDK/exec fixtures imported and tagged; resume chosen per kind; unverified kind disabled with reason.
- **Loop:** `npm test -- test/unit/session-kind.test.ts test/unit/resume.test.ts`, then Playwright MCP check of the badge. **Deps:** T00, T03, S6, S7. **Harness:** `new-feature`, XAIBO-204.

#### P2-T05 — Identity, dedup, merge, relocation (EC-06, EC-07, EC-10)
- **Build:** `src/service/normalize.ts`: identity strictly `(agent, profile, native_session_id)`; worktree relocation (same id, new cwd or new Claude project dir) appends `cwd_history`, never a second session; same-cwd concurrent sessions route by session id only; hook, transcript/rollout and OTel records for one tool call join on `tool_use_id`/`call_id` into one ToolCall with combined provenance (pure merge tested with synthetic hook/OTel records; real adapters in Phase 3 and v1-B); no receipt-time-bucket dedup; turns from non-injected user records (Claude), `task_started`/`task_complete` (Codex), T00-verified turn boundaries (`agy`); missing boundary/correlation evidence → unavailable/unlinked, never inferred from timing.
- **Files:** `src/service/normalize.ts`, `test/unit/toolcall-merge.test.ts`, `test/integration/relocation.test.ts`, `test/integration/same-cwd.test.ts`.
- **Test first:** EC-10 (U) — three sources in any arrival order → one ToolCall listing all three. EC-06 (I) — a Claude session continuing under a second encoded-cwd dir and a Codex cwd change each stay one session with a two-entry cwd history. EC-07 (I) — two sessions in one cwd with interleaved appends → two sessions, events routed correctly.
- **Test first (`agy`, U):** T00 turn/correlation evidence maps exactly in `toolcall-merge.test.ts`; missing boundaries/keys stay unavailable/unlinked.
- **Loop:** `npm test -- test/unit/toolcall-merge.test.ts test/integration/relocation.test.ts test/integration/same-cwd.test.ts`. **Deps:** T00, T01, T03. **Harness:** `new-feature`, XAIBO-205.

#### P2-T06 — Token normalization, usage, compaction (EC-51, EC-93)
- **Build:** `src/service/usage/tokens.ts`. Claude: usage once per `message.id` (latest record); total input = uncached + cache read + cache creation; cache-write classes kept. Codex: cached ⊂ input, reasoning ⊂ output; consumption from `total_token_usage` deltas per counter segment (a decrease starts a new segment, never negative); duplicate cumulative events add nothing; per-request usage from `last_token_usage` only when the total advances; unknown `token_usage_record` version = coverage gap. Codex `rate_limits` stored as `usage_snapshots` rows with `as_of` from the event; a missing reading writes no row (never zero, never refreshes an earlier reading's age). Compaction (Claude compact records, Codex `compacted`) recorded as events; consumption not reduced, not double counted; pre-compaction history kept. Missing values NULL (§5.6).
- **Files:** `src/service/usage/tokens.ts`, `test/unit/tokens.test.ts`, `test/integration/usage-codex.test.ts`, fixtures `codex/0.160.0/{token-dup,token-reset,rate-limits-missing,token-record-v2}`, `claude/2.1.319/{multi-block-usage,compaction}`.
- **Test first:** EC-51 (U) — Claude compaction and Codex `compacted` each produce the event; totals equal before/after; pre-compaction events kept. EC-93 (U + I) — missing `rate_limits` → no snapshot, previous `as_of` unchanged; duplicate cumulative → +0; counter reset → new segment, no negative; unknown record version → gap (model/context change part in T07). Claude multi-block usage counted once.
- **Build/test first (`agy`, U):** `tokens.test.ts` pins only T00-verified component relationships, usage identity/scope, revisions and compaction; duplicates add no usage; unknown relationships stay NULL with gaps. Include T00 token fixtures; never inherit Gemini `tokens.*`.
- **Loop:** `npm test -- test/unit/tokens.test.ts test/integration/usage-codex.test.ts`. **Deps:** T02, T05, S9, S13. **Harness:** `new-feature`, XAIBO-206 ("token" risk prompts via `record_decision`).

#### P2-T07 — Context mappings (EC-94; EC-93 context/model part)
- **Build:** `src/service/usage/context.ts` keeps the latest context projection plus generation markers. Claude (transcript-only fallback): used = input + cache read + cache creation from the latest eligible assistant usage (excl. output); window = statusLine-reported when present (tee is Phase 3; precedence tested with synthetic `statusline` records), else `models.json` `context_window` labeled inferred only when unambiguous (a model with both 200k and 1M windows → unavailable); null before first response = unavailable. Codex: `last_token_usage.total_tokens / model_context_window`, "reported effective window", no second reduction. `agy`: `~est` only with T00-verified latest-prompt input semantics and a version-tested window for the exact model ID (OQ-P2-09); either missing → unavailable. Generation changes (compaction, model change, window change) start a new generation and invalidate the old reading; eligible `postTokens` → labeled interim reading, else "Awaiting next usage"; never an old numerator with a new denominator; consumption and cost unchanged.
- **Files:** `src/service/usage/context.ts`, `test/unit/context.test.ts`, `test/integration/context.test.ts`.
- **Test first:** EC-94 (U + I) — Claude compaction or null `current_usage` invalidates and labels interim; 1M/200k switch yields no mismatched pair; transcript-only gives inferred/unavailable labels; `agy` without verified tokens/window unavailable; consumption/cost totals unchanged. EC-93 (context/model) — Codex model/window change uses the reported effective window, no second reduction, new generation.
- **Loop:** `npm test -- test/unit/context.test.ts test/integration/context.test.ts`. **Deps:** T00, T06, T08, S13. **Harness:** `new-feature`, XAIBO-207.

#### P2-T08 — Model list, display names, effort (EC-101)
- **Build:** `integrations/models.json`: schema version, revision, currency USD, `prices_as_of`, source references; exact model IDs or explicit aliases with `display_name`, `family`, `context_window` where known, supported qualifiers (cache-write classes, service tier, long-context tier), per-million rates; sourcing per OQ-P2-05; no family guess, no silent fallback. `src/service/usage/models.ts` display-name precedence: agent-provided name only for the matching identity and generation → list `display_name` → raw ID; no evidence → "Model unavailable"; delayed evidence never reverts newer state. Per-turn model and effort recorded (Claude `message.model`; Codex `turn_context` model and reasoning effort; `agy` model/effort fields only as pinned by T00); switches timestamped; effort omitted when not exposed. List shows current model and effort as text.
- **Files:** `integrations/models.json`, `src/service/usage/models.ts`, `src/renderer/SessionList.tsx`, `test/unit/models.test.ts`.
- **Test first (U):** EC-101 — no evidence → "Model unavailable"; unlisted ID → raw ID (never blank or family-guessed); conflicting agent name wins only for the matching identity; a stale name after a newer model ID ignored; unknown-model cost rule asserted in T09.
- **Test first (`agy`, U):** verified model/effort fields map; absent/unknown evidence keeps model unavailable and effort omitted.
- **Loop:** `npm test -- test/unit/models.test.ts`, then Playwright MCP list check. **Deps:** T00, T01. **Owner:** verifies Claude-drafted bundled prices (OQ-P2-05). **Harness:** `new-feature`, XAIBO-208.

#### P2-T09 — Price validation, override, revisions (EC-96)
- **Build:** `src/service/usage/prices.ts` loads bundled `models.json` and, if present, private `<appdata>/models.override.json`, validating both strictly (validator per OQ-X6). Invalid override → error via health and sanitized log codes, last valid revision kept; absent → bundled only. Accepted revisions written once to `price_revisions` (immutable); new calculations use the latest accepted revision; existing estimates keep theirs (no automatic repricing). Owner-set fallback only with explicit scope and rate, labeled "Owner-set fallback". No network. Reload on service start and via a `reloadPrices` IPC message (Settings UI is Phase 6).
- **Files:** `src/service/usage/prices.ts`, `test/unit/prices.test.ts`, `test/integration/prices.test.ts`.
- **Test first (U + I):** EC-96 — valid edit → new revision, new usage priced with it, old estimates keep the old revision; invalid edit → error, last valid kept; unknown model → `~$ unavailable`; owner fallback only within scope with its label; mixed revisions visible in provenance; T05-style audit asserts no network activity during load.
- **Loop:** `npm test -- test/unit/prices.test.ts test/integration/prices.test.ts`. **Deps:** T08. **Harness:** `security-change` (untrusted local file), XAIBO-209.

#### P2-T10 — Cost engine (EC-95)
- **Build:** `src/service/usage/cost.ts`: `USD = (uncached×in + output×out + cache_read×cr + cache_write×cw) / 1e6` per request with that request's model and accepted revision; Codex cached input subtracted from inclusive input before pricing; reasoning inside output not added again; an unknown cache-write class, service tier or long-context qualifier makes that component unavailable unless the table supports it; `agy` components unavailable until T00 confirms meanings, inclusion relationships and scope. Selection: one estimate per disjoint covered scope; an eligible agent-reported session estimate replaces the calculated total for that scope, never added (tested with synthetic statusLine cost). Children: a parent total that includes children excludes child estimates; unknown inclusion → aggregate coverage uncertain and the ambiguous addition excluded. Counter resets start a segment; opaque session estimates never prorated; partial coverage → known subtotal; none → unavailable; a valid reported zero stays zero; character-estimated tokens and context figures never inputs. Results to `cost_estimates` with full provenance.
- **Files:** `src/service/usage/cost.ts`, `test/unit/cost.test.ts`, `test/integration/cost.test.ts`.
- **Test first (U + I):** EC-95 — mixed models/cache classes priced per component; partial tokens → known subtotal with gaps; reported session cost replaces; delegated child covered by parent not added; cumulative reset no negative delta; opaque total not prorated; missing cost unavailable, never 0. Golden values from synthetic rates in a fixture `models.json`.
- **Test first (`agy`, U):** unverified token inclusion/child coverage excludes ambiguous additions and records gaps; verified components use synthetic rates only.
- **Loop:** `npm test -- test/unit/cost.test.ts test/integration/cost.test.ts`. **Deps:** T00, T06, T09, S13. **Harness:** `new-feature`, XAIBO-210.

#### P2-T11 — Antigravity CLI adapter and verified projection (EC-80, EC-81)
- **Build:** `src/service/adapters/agy/` from T00 only: approved roots/override, discovery, metadata identity, main/subagent linkage where verified. Reuse Phase 1 watch/tail/checkpoints and oversized handling. Retain raw source locators (generation/byte offset where applicable); reconcile verified rewrites atomically. Apply only observed revision/patch/rewind/conversion operations in source order; preserve history, index current text, replace projection usage without duplicate consumption. Never assume Gemini `id`/`$set`/`$rewindTo`; unknown operations → raw evidence plus coverage gap.
- **Build:** tool-output references only within approved profile roots (realpath containment, regular files only, reject escaping symlinks/special files, streamed/bounded); missing → "Tool output missing" gap. Verified native deletion → `native_available=0`, copy/Keep retained, resume unavailable; uncertain visibility → gap, never proof of deletion. No native writes. Retention settings hidden until runtime-verified; hook integration stays Phase 3/6.
- **Files:** `src/service/adapters/agy/{discover,parse,index}.ts` (+ `fold.ts` only for verified revision operations), `integrations/agents.catalog.json`, `test/unit/agy-{discover,parse}.test.ts` (+ `agy-fold.test.ts` if built), `test/integration/agy-{ingest,cleanup}.test.ts`; T00 synthetic fixtures extended for verified operations, missing output, cleanup and path escapes.
- **Test first (U + I):** discovery/parser units before implementation; EC-80 — verified rewrites/revisions/patches/rewinds/conversion yield approved projection, retained history, no duplicate usage/FTS/session; replay from 0 identical, FTS integrity passes. Unknown operation → gap. EC-81 — verified cleanup retains copy/Keep and disables resume; missing output reported; path escape/special-file rejected; uncertain visibility never deletes data. Backfill/tail/kill/restart idempotent. Missing native semantics go to owner, never synthetic proof of behaviour.
- **Loop:** `npm test -- test/unit/agy-*.test.ts test/integration/agy-*.test.ts && npm run fixtures:lint` (only created files for verified scope). **Deps:** T00 owner disposition, T01, T05, T06. **Maps:** S-28, §5.9, FR-08, SEC5. **Harness:** `security-change`, XAIBO-211.

#### P2-T12 — Cross-agent links and capability detection (EC-74, EC-53)
- **Build:** a Codex rollout whose `originator` is Claude Code via the Codex plugin is stored as a Codex session tagged with its originator, linked in `session_links` to a Claude session when a matching tool call is found (S9-verified correlation key); aggregates count each session once under its own agent. Catalog lists Codex hook events by version range; pure `capabilities(agent, version)` reports PreModelRequest/PostModelRequest only where verified; nothing depends on them.
- **Files:** `src/service/normalize.ts` (link step), `src/service/catalog/capabilities.ts`, `integrations/agents.catalog.json`, `test/unit/cross-agent.test.ts`, `test/integration/cross-agent.test.ts`, `test/unit/capabilities.test.ts`.
- **Test first:** EC-74 (U + I) — tagged Codex session linked via the matching call; no match → tagged, no link; counted once per agent. EC-53 (U) — 0.160.0 lacks the events, a newer range has them; no code path requires them.
- **Loop:** `npm test -- test/unit/cross-agent.test.ts test/integration/cross-agent.test.ts test/unit/capabilities.test.ts`. **Deps:** T03, T05. **Harness:** `new-feature`, XAIBO-212.

#### P2-T13 — Codex state-DB decision (EC-54)
- **Build:** evaluate rollout-only coverage (titles, archive flags) on synthetic fixtures vs S9 findings. **Default: no enrichment** (OQ-P2-04); EC-54 proven as non-interference (ingest never opens or copies `state_*.sqlite`). If the owner approves enrichment: `src/service/adapters/codex/state-db.ts`, read-only connection, version-suffix glob, skip and report reduced coverage on lock or schema mismatch, never write or copy.
- **Files:** `test/integration/codex-statedb.test.ts` (+ `state-db.ts` only if approved).
- **Test first (I):** EC-54 — temp `CODEX_HOME` with an exclusively locked `state_<n>.sqlite` and a garbage-schema `thread_history_<n>.sqlite`: rollout ingest completes; state files' checksums and mtimes unchanged; no copy under the data dir; with enrichment enabled → "reduced coverage", nothing written.
- **Loop:** `npm test -- test/integration/codex-statedb.test.ts`. **Done:** decision via `record_decision` and progress file. **Deps:** T03. **Owner:** enrichment decision. **Harness:** `new-feature`, XAIBO-213.

#### P2-T14 — M3 full on a mixed corpus
- **Build:** extend `scripts/gen-perf-corpus.ts` with Codex rollouts and T00-verified `agy` records (composition OQ-P2-03; §6.6 total size and distribution; seed recorded); enforce the LoAF budget; full import = start until every checkpoint is at EOF and queues are empty. If the S12-fixed service shape misses 120 s, bring the S12-recorded parser/writer worker forward from Phase 4 (recorded deviation, owner decides).
- **Files:** `scripts/gen-perf-corpus.ts`, `test/perf/m3-full.ts`.
- **Test first (P):** `m3-full.ts` asserts all three M3 conditions; fails while frame enforcement or the mixed corpus is absent.
- **Loop:** `node scripts/gen-perf-corpus.ts --seed <n> --mix && npm run dist:mac -- --dir && npm run perf -- --tier T1 --metric m3-full --runs 5`
- **Done:** full import ≤120 s; usable list p95 ≤1.5 s; 0 renderer frames >100 ms; Claude-only T1 re-run for comparison; environment and sizes recorded.
- **Deps:** T00, T03, T11. **Owner:** decides any miss (Q19); unavailable `agy` ingest returns M3-full to the owner, never a passing two-agent substitute.

#### P2-T15 — Gate 2
GS (§2.4 steps 0–6) on this branch (full suite, audit run as M6 regression, `privacy:scan --all/--history`, `fixtures:lint`, `/ponytail-review`, `/graphify`, Playwright MCP list check, progress file; `.handoff/gate2-review.md`). Include T00 evidence and all residual EC/FR dispositions. Version-triggered drift checks include `agy` via `spikes/p2-agy/facts.ts`, without routine live prompts (D-P1-17). Any authorized live Codex/agy recording uses §3.2/D-P0-15 disposable profiles, guard brackets, proven credential isolation and numberless reduction before git; drift prompts need owner OK per run.

### EC rows assigned to Gate 2

| EC | Case | Expected behaviour (summary) | Test (PRD) | Task |
|---|---|---|---|---|
| EC-05 | Multiple entrypoints (Claude cli/claude-vscode/claude-desktop/sdk-cli; Codex cli/vscode/exec/appServer/subAgent) | One list with origin badge; non-interactive tagged; resume flags valid per kind | U | P2-T04 |
| EC-06 | Worktree relocation | Same session id stays one session; cwd history updated; no duplicate | I | P2-T05 |
| EC-07 | Same repo open twice | Distinguished by session id; no cwd routing | I | P2-T05 |
| EC-10 | Hook + transcript + OTel for one tool call | One ToolCall, combined provenance | U | P2-T05 |
| EC-50 | Non-interactive sessions | Imported and tagged; resume per kind (Codex flag per S6) | U | P2-T04 |
| EC-51 | Compaction | Event recorded; no usage double count; pre-compaction history kept | U | P2-T06 |
| EC-53 | Codex PreModel/PostModel missing on older versions | Capability detection by version; not relied on | U | P2-T12 |
| EC-54 | Codex state DB locked/schema changed (if enrichment ships) | Read-only; skip and report reduced coverage; never copy; rollout ingest continues | I | P2-T13 |
| EC-74 | Cross-agent sessions | Tagged with originator; linked on matching tool call; counted once per agent | U + I | P2-T12 |
| EC-80 | `agy` rewrite/revision/patch/rewind/conversion verified in T00 | Approved equivalent projection; history retained; no duplicate usage, FTS or session; unverified scope requires owner waive/defer decision | U + I | P2-T00, P2-T11 |
| EC-81 | `agy` cleanup / tool-output storage verified in T00 | Copy/Keep retained; resume unavailable after native deletion; missing output reported; unverified scope requires owner waive/defer decision | I | P2-T00, P2-T11 |
| EC-93 | Missing Codex rate_limits, duplicate cumulative, new record version, context/model change | No additive snapshots or stale refresh, no second window reduction; gaps explicit; correct segments | U + I | P2-T06, P2-T07 |
| EC-94 | Claude compaction/null current_usage, 1M↔200k, transcript-only; `agy` evidence absent | Generation invalidated; interim labeled; no mismatched pairing; consumption/cost unchanged | U + I | P2-T07 |
| EC-95 | Mixed models/cache classes, partial tokens, reported cost, children, resets | One estimate per disjoint scope; correct components; no double count, negative delta or proration; missing unavailable | U + I | P2-T10 |
| EC-96 | Valid/invalid price edit, unknown model, owner fallback, mixed revisions | Last valid kept; no fetch or silent rate; new revision for new usage, old provenance kept | U + I | P2-T09 |
| EC-101 | No model evidence, unlisted ID, name conflict, stale name | "Model unavailable"; raw ID; agent name only for matching identity; no revert; unknown-model cost rule | U | P2-T08 |

### Metrics at Gate 2
- **M3 (full):** T1 corpus (OQ-P2-03): full import ≤120 s, usable list p95 ≤1.5 s, no renderer frame >100 ms (`npm run perf -- --tier T1 --metric m3-full`). M1/M2 during import belong to Gate 3.
- **M6, M9 (regression):** audit in every E2E spec = 0; canary tests stay green (no egress path added).

### Gate 2 checklist
- [ ] All 16 EC rows accounted for: applicable scope passes; any waiver/defer/narrowing has an explicit owner decision and is not reported as a pass (EC-54 non-interference unless enrichment approved).
- [ ] T00 contract/isolation checks complete; unverified facts explicit; EC-80/81 and dependent EC/FR dispositions approved; no fabricated fixture semantics.
- [ ] Phase 1 EC tests still green.
- [ ] lint, typecheck, unit, integration, E2E and perf green on a clean worktree.
- [ ] Fixtures synthetic and lint-clean; bundled `models.json` entries have source references and `prices_as_of`, verified by the owner.
- [ ] No network activity, no model/quota/token-count request (FR-44), no write to any native store; fixture checksums unchanged.
- [ ] Playwright MCP check of the list changes (badges, model/effort).
- [ ] GS: Codex review, Claude second review, owner stop.

### Open questions (Phase 2)
OQ-P2-01..05, 07..09 defaults accepted by the owner, with Gemini read as `agy`; OQ-P2-06 → OQ-X6. OQ-P2-10..11 resolved by the owner (§6, D-P2-01).

---

## Phase 3 — Live status (Gate 3)

### 3.0 Summary

| Field | Value |
|---|---|
| Goal | Zero-token live status for Claude and Codex, plus generic/Gemini hook mapping and custom report ingest: the FR-32 safe config transaction engine; the forwarder/spool/private socket with delivery IDs and durable acks; Claude plugin hooks; Codex hooks with the guided trust flow; the §6.2/§6.3 state machines; §6.4 rules; notifications; sleep/wake; full-content report chunks; the Claude statusLine tee; passive usage/context snapshot collection with history projection. The §6.6 replay harness proves §6.7/M8. All agent-config writes stay inside the FR-32 boundary: disposable profiles or the confirming dev CLI only. Real-profile Connect waits for Gate 6. |
| Branch | `feat/phase3-live-status`, after the Gate 2 PR is merged |
| Installs at phase start | None planned. Conditional, each with owner approval: a packaging helper the S3 forwarder winner needs that is not on App. C. Notifications (`Notification`), sleep/wake (`powerMonitor`), framing (`node:net`), IDs (`crypto.randomUUID`), process metrics (`app.getAppMetrics`) are built in. Validator from Phase 1 (OQ-X6). |
| PRD mapping | FR-02 (wake reconcile), FR-03, FR-04, FR-05, FR-06 (state; UI in Phase 6), FR-07, FR-08, FR-09, FR-10 (notification label), FR-30, FR-31, FR-32, FR-34 (engine revert), FR-44, FR-45, FR-46, FR-47 (Claude reported totals), FR-48 (agent-reported estimate), FR-51 (tee/hook model and effort); S-05, S-06, S-07, S-27, S-28 (Gemini hooks), S-29 (M11/M16), S-31, S-32; US-1, US-2, US-4, US-15, US-16/17/18 (data); SEC2, SEC4, ROB, Tokens; M1, M2, M3, M4, M7, M8, M11 (ingestion), M16 |

### 3.1 Entry criteria
1. Gate 2 passed and merged; all Gate 1 and Gate 2 EC tests green on `master`.
2. `phase0_spikes.md` records a decision for every input Phase 3 consumes (not re-decided here): S1 engine; S3 forwarder runtime, async vs sync per event and agent, native-HTTP verdict (default private socket), ack point; S4 plugin route vs fallback, exact `claude plugin` subcommands, marketplace layout; S5 `hooks.json` shape, trust location, renewed-trust behaviour, `SessionEnd` sync; S7 manual-denial evidence, input-request notification types, `ElicitationResult` support, background-completion evidence; S9 Claude interruption record shape; S11 Gemini hook names/payloads, empty-output acceptance, `ToolPermission` correlation; S12 watch interval (Q8) and minimum worker architecture; S13 tee invocation semantics, snapshot schemas, tee-feasibility and account-scope decision; Gate 0 validator choice.
3. The Phase 0 runner, guard and keychain-sharing finding exist (§3.2). If a temp sign-in would replace or read the real keychain item, live tasks stop and go to the owner.
4. Phase 1 delivered: packaged app, supervised service, single-writer atomic record+checkpoint batches, renderer live-delta channel, tray/close, connection-attempt audit, `sanitize()`, `privacy:scan`, `fixtures:lint`, session list.
5. Phase 2 delivered: Codex rollout ingest incl. parsed `token_count`, dedup/precedence, token normalization, `models.json`, model evidence (FR-51), cost calculation.
6. Baseline SHA recorded at branch creation (progress file and `.handoff/phase3-baseline`).

### 3.2 Phase rules
- HP for every gated unit. `security-change` for T01, T02, T03, T04, T13, T14 (agent configs, sockets/auth, foreign command execution, spool/durability); `new-feature` otherwise; `hotfix` for gate fixes. Interim diff-only Codex reviews for security-change units without an owner stop (Q3-12).
- Test layout: `test/unit/*.test.ts`, `test/integration/*.test.ts`, `test/e2e/*.spec.ts`, `test/perf/*.ts`; live disposable-profile checks in `test/live/*.live.test.ts`, skipped unless `XAIBO_LIVE_ROOT` points at a temp-profile root under `.cache/profiles/`.
- Live runs per §3.2 (runner, guard snapshot → run → guard compare; tiny synthetic prompts; owner signs in once; raw output reduced then deleted; only schemas and pass/fail in git).
- Fixtures hand-written from recorded schemas only (OQ-X5).

### 3.3 Ordered tasks

#### P3-T00 — Phase setup
- Create the branch; record the baseline SHA; `/graphify` over `docs/` and `src/`; Phase 3 section in the progress file listing the consumed Gate 0 decisions; `get_constitution` reachable; copy `spikes/s13/originals/` to `test/fixtures/synthetic/claude/statusline-originals/`. Done-evidence: progress entry with baseline SHA and links.

#### P3-T01 — FR-32 safe config transaction engine (before any hook install)
- **Build:**
  - `plan(target, change)`: read; parse (JSON only in Phase 3; TOML in v1-B with `smol-toml`); refuse invalid input; structured diff `{JSON pointer, old, new}` (no diff dependency) and pre-hash.
  - `apply(plan)`: private backup `<appdata>/integrations/backups/<entry>.bak` (0600); hash recheck just before writing; same-dir temp file with the original mode, fsync, atomic rename; self-check (re-read, re-parse, Xaibo entries present, foreign subtree hash unchanged; restore backup on failure); manifest entry `<appdata>/integrations/manifest.json` (0600) with target, route, pre/post hashes, Xaibo-owned pointers and values.
  - `revert(entry)`: current hash = post-hash → restore backup bytes exactly; else remove only still-unchanged Xaibo-owned values and report changed ones as conflicts, never overwriting.
  - Refusals: symlinked targets (manual steps, Q3-2); any hook entry of type `prompt` or `agent` (lint shared with T03); a Claude hook without `async: true` where S3/S4 found async supported.
  - Dev CLI `node src/service/config/dev-cli.ts plan|apply|revert|status --target <claude-plugin|claude-settings-fallback|claude-tee|codex-hooks|gemini-hooks> --profile <dir>`: prints the diff, requires typed `yes` on a TTY; `--yes` only when the profile realpath is under the OS temp dir or `.cache/profiles/`; refuses `~/.claude`, `~/.codex`, `~/.gemini`, `~/.claude.json` and the login-shell `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GEMINI_CLI_HOME`, with no override. No renderer Connect IPC until Phase 6.
- **Files:** `src/service/config/transaction.ts`, `src/service/config/dev-cli.ts`, `test/unit/config-transaction.test.ts`, `test/fixtures/synthetic/config/{claude-settings,codex-hooks,gemini-settings}/*.json` (synthetic agent-flow-style hook block, custom statusLine, foreign Codex hooks, foreign Gemini hooks).
- **EC-48** Agent config invalid or edited concurrently — refuse on parse error, recheck hash before rename, abort with a message — **U**.
- **Maps:** FR-32, FR-34 (engine), S-11 (engine), US-7 (engine), §7.6.
- **Test first (U):** invalid JSON refused, nothing written; file changed between plan and apply → abort with message, original bytes kept; apply then revert on an unchanged file byte-identical; foreign-only edit after apply → Xaibo values removed, foreign kept; changed Xaibo value → conflict, not overwritten; self-check failure → backup restored; backup and manifest 0600; symlink refused; `prompt`/`agent` refused; dev CLI refuses real roots. Fails first.
- **Loop:** `npm test -- test/unit/config-transaction.test.ts`, then L (`npm run typecheck && npm run lint && npm test`).
- **Done:** GREEN recorded in harness-os; byte-identical round trip on every synthetic config fixture. **Deps:** T00.

#### P3-T02 — Hook wire protocol, framing, private socket
- **Build:** envelope v1 `{v, delivery_id, agent, profile_key, event, session_id, cwd, received_ts, payload, truncated?, malformed?}`; 4-byte big-endian length prefix; frames >1 MB rejected; hook payloads capped at 256 KB (T03), report frames ≤256 KiB (T13); ack frame `{v, delivery_id, status: accepted|rejected, code}`. Server on `<appdata>/run/xaibo.sock` in a 0700 `run/`, chmod 0600 right after listen. Stale endpoint: existing file → try connect; ECONNREFUSED → unlink and listen; success → another instance owns it (single-instance lock). Per-connection read deadline; per-install token `<appdata>/run/token` (0600, regenerated at each service start) required in the first frame; `v` validated (no `v-1` path until a second version exists). Paths over the macOS 104-byte `sun_path` limit → visible health error (Q3-8); tests use short `XAIBO_DATA_DIR` roots.
- **Files:** `src/shared/hook-protocol.ts`, `src/service/receivers/socket.ts`, `test/unit/hook-protocol.test.ts`, `test/integration/socket-security.test.ts`.
- **EC-32** Malicious local client on the hook socket — reject bad token, frame >1 MB, invalid protocol/version; socket private — **U + I**.
- **Maps:** SEC2, FR-03, §7.3.
- **Test first:** U — encode/decode, partial frame across chunks, oversize header, unknown `v`. I — wrong token, 1 MB+1 frame, garbage bytes, slow-loris → disconnected, no ingest; socket/dir modes 0600/0700; stale socket recovered; second listener refused; EC-47 regression — two services with different `XAIBO_DATA_DIR`s (dev/prod) both listen on distinct socket paths and neither steals the other's endpoint.
- **Loop:** `npm test -- test/unit/hook-protocol.test.ts test/integration/socket-security.test.ts`, then L. **Done:** rejection paths log only error codes (P4). **Deps:** T00.

#### P3-T03 — Forwarder, stable shim, spool
- **Build:**
  - Forwarder (S3 runtime, no dependencies): monotonic deadline at entry; stdin read with a 256 KB bound and `truncated`; malformed JSON → `malformed: true`, `payload: null`; `delivery_id = randomUUID()` before the first send; `agent`, `profile_key` from argv (hook command `<shim> hook <agent> <profile_key>`); read token, connect, send, wait for ack within the remaining budget; no ack → append the same envelope to `<appdata>/spool/<date>-<pid>.jsonl` (0600); always exit 0 with 0 bytes on stdout/stderr (global handlers swallow everything); total own time ≤100 ms including fallback.
  - Spool cap 50 MB (dir-size stat before append); at the cap append nothing and write a ≤128-byte line `{ts, agent, session_id, event}` to `spool/overflow.log` (own 1 MB cap, `saturated` flag beyond). Concurrent overshoot ≤ N×256 KB, noted in a `ponytail:` comment.
  - Shim `<appdata>/integrations/bin/xaibo-hook` execs the current forwarder; missing forwarder → exit 0 silently; forwarder replaced by atomic rename on upgrade.
  - Config lint over every hook template and engine-generated entry: command type only, never `prompt`/`agent`, `async` where supported, command points at the shim.
- **Files:** `src/forwarder/forwarder.ts`, `src/forwarder/xaibo-hook`, electron-builder `extraResources` entry per S3, `test/unit/forwarder.test.ts`, `test/unit/hook-config-lint.test.ts`, `test/integration/forwarder-service-down.test.ts`, `test/integration/spool-overflow.test.ts`.
- **EC rows:** **EC-11** Service down / no ack when hook fires — spool the same `delivery_id`, exit 0 silently within the deadline; idempotent replay on start — **I** (replay side in T04). **EC-12** Spool overflow — stop at cap; overflow counter; UI warning naming the exact hook-only gap; files backfill what they can — **I** (warning surface in T10). **EC-63** Oversized/malformed stdin — bounded read, never unbounded; 256 KB cap and truncated flag; full content from files; malformed → no output, no decision — **U**. **EC-64** Hook output adding tokens/noise — 0 bytes stdout/stderr, always exit 0; lint rejects `prompt`/`agent` — **U**.
- **Maps:** S-05, M7, M16 (own deadline), FR-03, FR-09, ROB, Tokens, §7.3.
- **Test first:** U — spawn with stdin variants (valid, 10 MB, malformed, empty, closed): stdout = stderr = 0 bytes, exit 0, flags set, RSS bounded on 10 MB; lint rejects synthetic `prompt`/`agent`. I — socket absent → exactly one spooled envelope with the same `delivery_id`, ≤100 ms from entry; socket accepts but never acks → same; at the cap → no append, overflow line, exit 0 silent.
- **Loop:** the four test files, then L. **Done:** M7 check green on every path; dev-runtime deadline histogram (packaged figure in T16). **Deps:** T02, S3.

#### P3-T04 — Service intake, durable ack, dedup, spool replay, disk-full, upgrade
- **Build:** intake order: validate frame → publish volatile live state (pending-durability flag) → enqueue to the writer → ack after commit; live deliveries flushed in an immediate small transaction ahead of the ≤500-row/100 ms backfill batches so acks fit the deadline (OQ-A1). `hook_delivery(delivery_id PK, agent, profile_key, received_ts, committed_ts)`; a duplicate `delivery_id` is acked and ignored. Unknown events and fields stored generically in `event` (source=hook, name, payload JSON). Spool replay on service start and each socket (re)listen: oldest first through the same intake; delete a file only after every line committed; `overflow.log` surfaced as an exact gap per `{agent, session, time range}`, then truncated. ENOSPC: pause ingest, checkpoints do not advance, health "disk full", banner naming the exact hook-only gap; forwarder spool write fails silently. Upgrade: stable shim; spool while down; `v` validated; replay after restart. Plugin and fallback routes both in the manifest → coverage warning "duplicate registration".
- **Files:** `src/service/receivers/intake.ts`, `src/service/receivers/spool-replay.ts`, `src/service/workers/writer.ts` (live-priority flush, ENOSPC pause), `src/service/store/migrations/<next>_hook_delivery.sql`, `test/integration/{hook-intake,spool-replay,disk-full,upgrade-spool}.test.ts`, `test/unit/hook-unknown-event.test.ts`.
- **EC rows:** **EC-09** Duplicate events (agent-flow + Xaibo; plugin and fallback together; spool replay) — ignore agent-flow traffic; plugin/fallback mutually exclusive; replays collapse by `delivery_id`; duplicates across second boundaries collapse while rapid distinct events stay distinct — **I**. **EC-11** (replay side) — **I**. **EC-44** Disk full — pause ingest without advancing checkpoints; spool stops; banner naming the exact hook-only gap; no corruption — **I** (fault injection, Q3-15). **EC-46** Upgrade while agents run — stable shim; spool during upgrade; version validated (`v-1` once a second version exists); replay — **I**. **EC-52** Unknown hook events/new fields — stored generically; no crash — **U**.
- **Maps:** FR-03, FR-09, ROB, §5.5 (delivery dedup), D-18.
- **Test first:** EC-09 — a profile with an agent-flow-style command and the Xaibo shim: only Xaibo frames arrive, agent-flow fixture bytes untouched; the same `delivery_id` replayed at x.999 and (x+1).001 → 1 row; two distinct deliveries with identical payload in the same ms → 2 rows; engine refuses fallback when plugin is in the manifest and vice versa. EC-11 — kill service, fire 20 hooks, restart: each once, spool empty. EC-44 — writer injected with ENOSPC: offsets unchanged, gap record exists, `integrity_check` ok after recovery, ingest resumes. EC-46 — replace the forwarder mid-stream and restart: no loss beyond the reported gap, replay works. EC-52 — unknown event plus extra fields stored raw.
- **Loop:** the five test files, then L. **Done:** zero unexplained loss/duplication. **Deps:** T02, T03, Phase 1 writer.

#### P3-T05 — Claude plugin hooks and effective-policy detection
- **Build:** hooks-only plugin `integrations/claude-plugin/.claude-plugin/plugin.json` + `hooks/hooks.json` and the local marketplace manifest in the S4 shape, subscribing to every §5.2 event (`ElicitationResult` only where S7 found support); each entry command type, `async: true`, command `<shim> hook claude <profile_key>`; no skills, MCP definitions or context output. Setup plan copies the plugin to `<appdata>/integrations/claude-plugin/`, then runs the S4 subcommands as argv arrays (no shell) with `CLAUDE_CONFIG_DIR` = the temp profile; pre/post hashes into the manifest. If S4 rejected the plugin route, the fallback is a marker-based settings merge through T01; the routes are mutually exclusive. Payload mapping: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, `tool_name`, `tool_use_id`, `tool_input` preview, `notification_type`, `model`/`effort` when present (FR-51); unknown remainder raw. Effective policy reads managed settings (injectable path), `disableAllHooks`, `allowedHttpHookUrls` → coverage "hooks blocked by policy", files-only mode.
- **Files:** `integrations/claude-plugin/**`, `src/service/adapters/claude/{hooks,setup}.ts`, `test/unit/claude-hooks-map.test.ts`, `test/unit/claude-hook-policy.test.ts`, `test/live/claude-plugin.live.test.ts`.
- **EC-49** Managed settings, `disableAllHooks`, `allowedHttpHookUrls` — effective config detected; "hooks blocked by policy"; files-only — **U**.
- **Maps:** FR-30, S-05, D-2, M7, SEC4.
- **Test first:** U — every §5.2 event fixture maps to evidence; policy fixtures give the expected coverage state. Live (skipped without `XAIBO_LIVE_ROOT`) — install, restart, one PR-OK; `SessionStart`/`UserPromptSubmit`/`Stop` received; duplicate install refused; disconnect restores the pre-hash; guard `MATCH`.
- **Loop:** U, L, then `XAIBO_LIVE_ROOT=<temp root> npm test -- test/live/claude-plugin.live.test.ts`. **Done:** live result and reduced event-field schema in the progress file. **Deps:** T01, T03, T04, S4, S7. **Owner:** temp Claude profile sign-in if not already done.

#### P3-T06 — Codex hooks and guided trust flow
- **Build:** `integrations/codex/hooks.json` with separate Xaibo entries for the 0.160.0 events (SessionStart, SessionEnd, SubagentStart, SubagentStop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop, Interrupt), `async` where S5 allowed (`SessionEnd` sync); Pre/PostModelRequest capability-detected only. Installed into `$CODEX_HOME/hooks.json` through T01. State `installed, awaiting trust` (guided steps as text) → `connected` only on the first event received from that hook; any change to the Xaibo entry returns it to awaiting trust. Never `--dangerously-bypass-hook-trust`; never write trust hashes or the S5 trust location; rollouts keep being observed.
- **Files:** `integrations/codex/hooks.json`, `src/service/adapters/codex/{hooks,setup}.ts`, `test/unit/codex-hooks-map.test.ts`, `test/integration/codex-trust.test.ts`, `test/live/codex-hooks.live.test.ts`.
- **EC-25** Codex hook trust not granted — "installed, awaiting trust" with steps; rollouts observed; no bypass flag, no trust-hash writes — **I + S5** (S5 evidence cited from Phase 0).
- **Maps:** FR-31, FR-06, S-06, M16 (sync `SessionEnd`).
- **Test first:** I on synthetic `CODEX_HOME`: after install → awaiting trust; a rollout appended meanwhile is ingested; trust location and `config.toml` checksums unchanged; a static test asserts no argv in `src/` contains the bypass flag; a synthetic hook event → connected; editing the Xaibo entry → awaiting trust. Live: untrusted hooks do not fire; after the owner approves in the TUI they fire.
- **Loop:** U+I, L, live. **Deps:** T01, T03, T04, S5. **Owner:** approves the trust prompt by following Xaibo's displayed steps (validates the guidance text).

#### P3-T07 — Replay harness and required fixture set (§6.6)
- **Build:** harness loads `test/fixtures/synthetic/<agent>/<version>/<case>/` (hook JSON lines, transcript/rollout JSONL, optional OTel JSON, `expected.json` with per-event-index lifecycle, reason, confidence, findings) and replays on a virtual clock under 10 interleavings: hooks-first, files-first, hooks-missing, OTel-late, duplicated hooks, duplicate spool replay across second boundaries, rapid distinct events, delayed earlier events, service restart mid-stream (state rebuilt from a temp DB at index k), sleep gap. Order invariance: final lifecycle, ToolCall count and usage totals identical across interleavings. Baselines B1 (files-only inference) and B2 (agent-flow-style: Stop = idle, 5 s heuristic, no background awareness), with FP/FN counts per fixture, printed via `t.diagnostic`. Fixtures hand-written from S4/S5/S7/S9/S13 schemas: simple turn; permission granted; permission denied (manual and auto-mode); `idle_prompt` without input request; needs-input accepted/declined/cancelled; tool failure; StopFailure; subagent; background work after Stop; compaction; worktree relocation; interrupted turn; legit 15-minute build; repeated tool; repeated error; 2- and 3-tool cycles; sleep/wake gap; pre-hook session; concurrent resume interleave; format-drift unknown records — for claude/2.1.319 and codex/0.160.0 where applicable. Also gemini/0.46.0 (from S11-T2 schemas, §6.8) and report/v1 (from §5.10): simple turn with AfterAgent settle; ToolPermission granted, denied and cancelled; generic Notification without input wait; unmatched resolution left unresolved; interrupted/duplicate report delivery — each with `expected.json`, run under all 10 interleavings once T13's mappings exist, and included in the Gate 3 M8/§6.7 table with B1/B2 counts.
- **Files:** `test/integration/replay-harness.ts`, `test/integration/replay-baselines.ts`, `test/integration/replay.test.ts`, the fixtures (test infrastructure, outside the gate).
- **Maps:** §6.6, §6.7, M8.
- **Test first:** harness self-test proves the interleaving generator is deterministic for a seed; `replay.test.ts` against the T08 engine is RED (engine absent).
- **Loop:** `npm test -- test/integration/replay.test.ts && npm run fixtures:lint`. **Deps:** T04.

#### P3-T08 — Status engine and Claude/Codex state machines (§6.1–§6.3)
- **Build:** engine core: lifecycle plus confidence and health; pending permission/input requests keyed by native ID, resolved only by a matching ID; precedence hooks/report > native-file inference > heuristics (app-server and ACP rows until v1-A; OTel never drives status); causal/source ordering (a delayed earlier event never regresses newer evidence). "Finishing…" reason within M1 on Stop/`task_complete`; after the turn-settle interval (default 4 s, setting key) settle to idle, or busy "Background work" while children are active. `idle_prompt` never means needs-input; never ended from silence (FR-05); insufficient evidence → Unknown. Claude mapping: every §6.2 row incl. no-hook inferred/heuristic rows ("Probably waiting" after a pending non-Agent tool >5 s with no file writes). Codex mapping: hook/rollout rows of §6.3 (notify rows v1-B, app-server v1-A, Q3-13); `Interrupt` → outcome interrupted, awaits settle. Claude Ctrl-C via the S9 interruption record. Conflicts logged to session diagnostics without content.
- **Files:** `src/service/status/engine.ts`, `src/service/adapters/claude/status-map.ts`, `src/service/adapters/codex/status-map.ts`, `src/service/store/migrations/<next>_status.sql`, `test/unit/{status-engine,claude-status,codex-status}.test.ts`, `test/integration/pre-hook-session.test.ts`.
- **EC rows:** **EC-02** Sessions started before hooks / before first run — backfilled from files; "inferred"; upgraded to confirmed on the first hook — **I**. **EC-40** Subagents and background work after Stop; immediate Stop on a non-Xaibo session — "Finishing…" within M1 without premature idle; settle after the interval; busy "Background work" while children active — **U (fixture) + P** (P in T16). **EC-41** Permission-wait heuristic vs confirmed — confirmed only from explicit evidence; heuristic "Probably waiting", no OS notification — **U** (notification side in T11). **EC-70** Interrupted turn (Ctrl-C, `Interrupt`) — outcome "interrupted", not error — **U**.
- **Maps:** FR-04, FR-05, S-07, US-1, §5.5, §6.1–§6.3, M8.
- **Test first:** T07 replay set plus U per table row; two interleaved pending requests resolved individually; delayed earlier `PreToolUse` after Stop does not regress. I for EC-02: transcript-only backfill → inferred, a synthetic hook → confirmed.
- **Loop:** U, `npm test -- test/integration/replay.test.ts`, L. **Done:** §6.7 numbers on the fixture set (confirmed transitions 100%, 0 heuristic-as-confirmed, order invariance 100%, FP/FN ≤ B1 and B2) in the progress file. **Deps:** T05, T06, T07.

#### P3-T09 — Stuck/loop rules R1–R5 (§6.4)
- **Build:** rules on every event and on a timer: R1 no-progress (5 min busy, no progress, no known wait, excluding suspended time from T12); R2 repeated-tool (same tool, normalized args and result signature 4× in a row within a turn); R3 repeated-error (same tool/error signature 3×); R4 cycle (a 2–3 tool sequence repeated 3×); R5 long-tool (>10 min). Findings deduplicated by `(session, rule, signature)`, cleared when progress breaks the pattern, never terminate anything; legit long work shows only "expected inactivity"/"long-running tool", never confirmed stuck/error. Thresholds are setting keys with PRD defaults (Q3-14).
- **Files:** `src/service/status/rules.ts`, `src/service/store/migrations/<next>_finding.sql` (if absent), `test/unit/stuck-rules.test.ts`.
- **Maps:** FR-04, US-4, §6.4, M8.
- **Test first:** U on a fake clock per rule plus dedup and clearing; replay fixtures for 15-min build, repeated tool, repeated error, 2-/3-cycles.
- **Loop:** U, replay, L. **Done:** legit-long fixture → zero confirmed stuck/error. **Deps:** T08.

#### P3-T10 — Live status rendering (placeholder, pre-Gate D) and paint instrumentation
- **Build:** extend the Phase 1 live-delta channel and list row with lifecycle text plus glyph (never colour alone), confidence, health, reason ("Finishing…", "Background work", "Probably waiting"), finding badges, minimal text for context %, `~$` estimate, usage scope (Q3-5). Service coverage banners: spool overflow gap, disk full, hooks blocked by policy, awaiting trust. Summaries coalesced. No new screens. Perf trace (test-only, `XAIBO_PERF_TRACE=1`, IDs only): renderer posts `{delta_id}` after rAF plus one frame; main stamps `process.hrtime.bigint()`; conservative upper bound incl. one IPC hop; emitters stamp the same clock.
- **Files:** `src/renderer/**` (row, banner), `src/main/**` (IPC relay, perf trace), `src/service/**` (delta fields), `test/e2e/live-status.spec.ts`.
- **EC:** EC-12 warning surface (row in T03).
- **Maps:** US-1, US-4, FR-09, A11Y, M1/M2 paint hop.
- **Test first (E):** Playwright `_electron`, temp data and profiles: a synthetic emitter drives busy, waiting-for-permission, "Finishing…" then idle, "Probably waiting", an R2 badge, the overflow banner; assertions on accessible text. Fails first.
- **Loop:** `npm run test:e2e -- test/e2e/live-status.spec.ts`, Playwright MCP visual check (render, console clean, keyboard focus), L. **Done:** E2E green; MCP notes; audit still 0. **Deps:** T08, T09.

#### P3-T11 — OS notifications
- **Build:** the service emits a notify intent only on the first confirmed waiting-for-permission or needs-input transition per request ID (Q3-11). Main shows an Electron `Notification` with `<agent display name> · <approved project label or "Project"> · <state>`; the approved label is read only if one exists (FR-10; label UI in Phase 5; Q3-6). Heuristic waits never notify. The payload is built by a pure function whose only inputs are agent, label and state. Test mode stubs the notifier to record payload plus an hrtime stamp to a temp file.
- **Files:** `src/main/notifications.ts`, `src/service/status/engine.ts` (intent), `test/unit/notification-content.test.ts`, `test/e2e/notification.spec.ts`, probe in `test/perf/t0.ts`.
- **EC-59** OS notification privacy — only agent, approved project label ("Project" placeholder until approved) and state; never prompt excerpts, titles, paths or tool content; no content opt-in; dispatched within 2 s of the confirmed wait event (US-2), real monotonic clock — **E + P**.
- **Maps:** US-2, FR-10, D-11, EC-41 (no notification for heuristics).
- **Test first:** U — canary prompt/title/path/tool strings never appear in the payload; heuristic wait → no intent. E — a confirmed `PermissionRequest` → exactly one stub notification with the allowed fields. P — emission→dispatch p95 ≤2 s over ≥100 events.
- **Loop:** U, E, `npm run perf -- --tier T0 --only notify`, L. **Done:** E/P green; one-time owner look at a real macOS notification from the packaged app. **Deps:** T08, T10. **Owner:** allows notifications on first run; visual confirmation.

#### P3-T12 — Sleep/wake and clock correctness
- **Build:** `powerMonitor` suspend/resume forwarded to the service; suspended intervals recorded; R1 excludes them; health stale across the gap; resume triggers the FR-02 bounded reconcile (no full-history scan). Stored times UTC ms; settle, rule and reset-countdown timers use elapsed monotonic ms, never local wall-clock dates.
- **Files:** `src/main/power.ts`, `src/service/status/{engine,rules}.ts`, `test/unit/sleep-wake.test.ts`, `test/integration/wake-reconcile.test.ts`, `test/unit/timezone-dst.test.ts`.
- **EC rows:** **EC-43** Laptop sleep/wake — reconcile on resume; suspended time excluded from R1; no false stuck — **U (fake clock) + I**. **EC-42** Timezone/DST change — UTC ms; retention uses elapsed N × 24 h; DST fixture — **U** (Phase 3 covers ingest timestamps, timers, reset countdowns; P5-T03/T10 reuse the elapsed-ms comparison as a regression, with a DST fixture in P5-T10; the row stays at Gate 3).
- **Maps:** FR-02, FR-05, §6.4, §5.11.
- **Test first:** U — busy session, 2-hour suspend on the fake clock, resume: no R1 finding, health stale then recovered. I — watcher paused while records are appended, then resume: records appear within interval + 1 s. U (DST) — child processes with `TZ` in a DST zone across the transition give identical stored ms and timer outcomes.
- **Loop:** the three tests, L. **Done:** green; sleep-gap replay interleaving green. **Deps:** T09.

#### P3-T13 — Generic mapped hooks, report v1 ingest, registration, full-content chunks (incl. Gemini hooks, `xaibo-report`)
- **Build:** report v1 schema and validator per §5.10 (OQ-X6). Catalog hook mappings: exact event names plus optional exact field-value predicates (extends Phase 1 catalog fields; never executes code); Gemini mappings per §6.8; only a tested `notification_type=ToolPermission` gives a permission state; `AfterModel` not subscribed; unknown mappings → Unknown/reduced coverage. Generic hook writer for the tested Claude-like and Gemini JSON shapes through T01, into a disposable `GEMINI_CLI_HOME` only (the `maxAge` offer is Gate 6). Registrations approved locally via `dev-cli register` (typed confirmation), stored in app data; each binds agent/profile with its own token, byte/queue limits and round-robin scheduling (Q3-9); a payload cannot select another registration's identity; payload paths never dereferenced. Dedup on `(registration, delivery_id)` and item/revision/chunk. `content.upsert` chunks (≤256 KiB frames, UTF-8-safe, `chunk_index`, `final`) assembled on disk under `<appdata>/content-chunks/` (0700/0600) within quotas; complete only when all chunks are durable, else labeled incomplete; rejected/malformed frames are explicit coverage. Optional `model {id, display_name?}` and `effort` attributed per FR-51. `xaibo-report` helper (packaged, shares the forwarder's delivery-ID and spool logic); `docs/integrations/report-v1.md` with minimal examples.
- **Files:** `src/shared/report/schema.ts`, `src/service/adapters/generic/{mapping,report,chunks}.ts`, `src/service/catalog/setup-plan.ts`, `src/forwarder/report.ts`, `src/service/store/migrations/<next>_report.sql`, `integrations/agents.catalog.json` (+ schema fields), `docs/integrations/report-v1.md`, `test/fixtures/synthetic/report/v1/{lifecycle,exchange,duplicate-retry,out-of-order,interrupted-chunks}/`, `test/fixtures/synthetic/catalog/`, `test/unit/report-schema.test.ts`, `test/unit/generic-mapping.test.ts`, `test/integration/report-ingest.test.ts`, `test/live/gemini-hooks.live.test.ts`.
- **EC rows:** **EC-82** Custom full content, large chunks, retry/restart, malformed/auth failure — private full-content persistence; idempotent delivery; bounded disk-backed assembly; partial/rejected explicit; no unauthorized identity or path access — **U + I**. **EC-83** Generic notifications / unmatched permission resolution — no invented input wait; only matching evidence clears; unresolved coverage visible — **U**.
- **Maps:** FR-03, FR-07, FR-08, S-27, S-28, US-15, SEC2, SEC5, §5.10, §6.8.
- **Test first:** U — schema accept/reject (unsupported `v` rejected without executing anything); mapping predicates; generic notification → no wait; unmatched resolution leaves the request unresolved and visible. I — a 5 MiB item in 21 chunks, service killed after chunk 9, retry → complete exactly once; a payload claiming another registration rejected; bad token rejected; malformed frame → explicit rejected coverage; assembly cap hit → item labeled incomplete. Live — disposable Gemini 0.46.0 profile: empty-output hooks, mapped events received, guard `MATCH`.
- **Loop:** U, I, L, live. **Done:** all five conformance fixtures pass; live Gemini result recorded. **Deps:** T01, T03, T04, T08, S11. **Owner:** temp Gemini profile sign-in if needed; confirms the dev-CLI registration of the synthetic producer.

#### P3-T14 — Claude statusLine tee engine (S-31)
- **Build:** `xaibo-statusline` (packaged with the forwarder) spawns the original command immediately using exactly the S13-recorded invocation (shell, cwd, env inherited unchanged); streams original stdin bytes to the child unmodified while keeping a separate 256 KB copy; child `stdout`/`stderr` by `inherit` (byte-identical; Xaibo writes nothing); exits with the child's code or re-raises its signal; forwards SIGTERM/SIGINT. After stdin EOF, in parallel, validates only the FR-45 fields (`context_window.*`, `rate_limits.*`, `cost.total_cost_usd`, `model.id`, `model.display_name`, `effort.level`) plus `session_id` (OQ-B7; captured only if the Gate 0 PRD delta adds it to FR-45, P0-G-T2) and sends them as source `statusline` with a delivery ID over the socket, no spool (the next redraw replaces a lost one). Capture failure never blocks or alters the original; no original → emit nothing, exit 0. Install/revert through T01 into a disposable `settings.json` as target `claude-tee`; the original command reference kept in the manifest (Q3-7). Never read `~/.claude.json`, never change `refreshInterval`.
- **Files:** `src/forwarder/statusline-tee.ts`, `src/service/adapters/claude/statusline.ts`, `src/service/adapters/claude/setup.ts` (tee plan), `test/unit/statusline-tee.test.ts`, `test/integration/statusline-tee-config.test.ts`, `test/live/statusline-tee.live.test.ts`.
- **EC-28** Existing/absent Claude statusLine; capture failure; concurrent config edit — untouched by default; opt-in tee preserves stdin, invocation, stdout/stderr and exit status; capture failure cannot block; no-original emits nothing and exits 0; Disconnect restores unchanged owned config; concurrent edits produce a conflict — **U + I**.
- **Maps:** FR-45, S-31, D-22, M7, M16, Tokens.
- **Test first:** U golden tests over `test/fixtures/synthetic/claude/statusline-originals/`: non-UTF-8 stdout, stderr writes, exit 3, killed by SIGTERM, reads all/part/none of stdin, slow 300 ms original, no original → byte-for-byte equal to a direct run, same exit/signal; capture failures (no socket, bad token, invalid JSON, 10 MB stdin) leave output identical. I — install into a temp `settings.json` with a custom statusLine; concurrent edit before rename aborts; revert byte-identical; foreign edit after install → conflict. Live — disposable Claude profile with a synthetic `printf` original renders the same text and a snapshot arrives.
- **Loop:** U, I, L, live. **Done:** golden suite green; dev added-wait histogram (packaged figure in T16). **Deps:** T01, T02, S13 (tee adopted at Gate 0; if not adopted, this task is replaced by the owner's Gate 0 decision).

#### P3-T15 — Passive usage collection and usage/context history projection
- **Build:**
  - UsageSnapshot normalization from tee `rate_limits` (5h/7d/spend windows; resets in epoch seconds → UTC ms; spend >100% kept; missing spend dollars do not invalidate utilization) and Codex rollout `token_count.rate_limits` (window duration, percentage, reset, plan/credits when supplied), building on the Phase 2 raw rows, with backfill from retained rollouts. Every field carries its own `as_of` vs `observed_at`; unknown source time → "Source time unknown; observed …"; a re-emitted unchanged reading does not refresh measurement age; stale after 15 min; at reset time "Reset passed; awaiting observation", never zero; missing `rate_limits` is a gap, not zero.
  - Usage scope: local opaque ID bound to profile plus evidenced epoch/limit identity, else "Account scope unverified" with separate streams (S13 decision); no credential or account-file reads, no stored account identifiers, no cross-profile merge.
  - History: ≤1 ordinary sample per UTC minute per scope/limit stream (latest eligible); reset/window/scope transitions kept separately; no interpolation; index `(usage_scope_id, limit_id, as_of)`.
  - ContextSnapshot: Claude reported totals over transcript-derived; generations on model/compaction markers; only the latest projection persisted.
  - Gemini: an explicit usage-status state with reason "Unavailable from passive sources" (FR-46); never an empty or zero snapshot.
  - CostEstimate `agent_reported` from `cost.total_cost_usd` replaces (never adds to) the token-table estimate for the same scope (Phase 2 engine).
  - FR-44 guard: static test fails if `src/` contains `/context`, `get_context_usage`, `count_tokens`, `claude -p`, `codex exec`, or a quota/usage endpoint; integration file-access spy asserts `~/.claude.json` is never opened.
  - Out of scope: 45-day expiry and settlement (Phase 5, EC-99/EC-103).
- **Files:** `src/service/usage/snapshots.ts`, `src/service/adapters/codex/rate-limits.ts` (or the Phase 2 module), `src/service/store/migrations/<next>_usage_snapshot.sql`, `test/unit/{usage-snapshot,usage-scope,no-active-usage-calls}.test.ts`, `test/integration/usage-history.test.ts`.
- **EC rows:** **EC-91** Missing/null/expired rate windows, >100% spend, stale replay, unknown source time, sleep/wake — per-field timestamps; no fake zero or freshness; reset-passed and gaps explicit; repeated cached emission does not renew age — **U + I**. **EC-92** Multiple profiles/accounts/terminals, missing account identity — separate uncertain scopes; no credential/account-file reads, stored identifiers or guessed merge; newest eligible measurement within a proven scope — **U + I**.
- **Maps:** FR-44, FR-46, FR-47, FR-48, FR-51, S-32, US-16, US-17, US-18, §5.11, §5.12.
- **Test first:** U — each EC-91/92 sub-case on a fake clock. I — two synthetic profiles with identical readings stay two scopes; spool replay and restart → no duplicate minute samples; a sleep gap → collection gap, no interpolation; Codex backfill → timestamped snapshots; canary `~/.claude.json` in temp HOME never opened. I (§9.3 account canary) — `test/integration/usage-account-canary.test.ts` injects runtime-generated account-ID, org-ID, email and credential canaries (plus any account-like fields S13-T8 found) into synthetic statusLine and rollout `token_count`/`session_meta` payloads; zero canary bytes in `usage_snapshots`/`context_snapshots`/`cost_estimates`, logs and a generated diagnostics bundle; registered in the P1-T13 egress-coverage registry and cited on the MVP checklist row.
- **Loop:** U, I, L. **Done:** green; synthetic snapshot schema documented in the progress file. **Deps:** T14, Phase 2 token_count and cost.

#### P3-T16 — T0 perf tier and Gate 3 metrics (packaged app)
- **Build:** `test/perf/t0.ts` plus `test/perf/emitter.ts` against `npm run dist:mac` output with temp `XAIBO_DATA_DIR` and synthetic profiles; records hardware, macOS, app/agent versions, seed, DB/index sizes; output to `test-results/`, aggregates to the progress file. Measures per §3.5.
- **Test first (P):** fails until the T10 trace and packaged forwarder/tee paths exist; thresholds encoded as assertions; a miss fails and is reported, never relaxed.
- **Helper attempt audit (M6, §4.3 P2):** the packaged forwarder, stable shim, `xaibo-statusline` tee and `xaibo-report` run under the S10 Seatbelt audit plus the Node `diagnostics_channel` recorder in each mode: service up, service down/spool, socket hung, ENOSPC, spool at cap, malformed stdin, tee capture failure; zero attempts required. `test/e2e/fixtures.ts` (P1-T05) is extended so the audit also wraps emitter-spawned helper processes in every E2E run. Owner: runs or approves `sandbox-exec` unsandboxed (as P0-S10-T1).
- **Loop:** `npm run dist:mac && npm run perf -- --tier T0` and `npm run perf -- --tier T1 --with-live-probes`.
- **Done:** §3.5 table filled with p95 and per-hop timings; misses flagged; helper audit 0 attempts per mode. **Deps:** T03–T15. **Owner:** accepts or rejects any miss.

#### P3-T17 — Gate 3
Run GS (§2.4) steps 0–6 in order, with these Gate 3 additions:
1. Step 0 (before freeze) as in §2.4 (incl. `/ponytail-review` and `workflow_status` for every unit).
2. Step 1 suite also re-runs every Gate 1/2 EC test.
3. Step 3 handoffs split into chunks: (a) T01 config engine; (b) T02–T04 transport/intake; (c) T05–T12 status/rules/notifications/UI; (d) T13 generic/report; (e) T14–T15 tee/usage — each with the PRD excerpts it needs (FR rows, §5.2/5.3/5.10/5.11/5.12, §6.2–6.8, §7.3, the EC rows). `.handoff/gate3-<chunk>.md` per chunk (deleted by GS step 5's `.handoff/gate3-*.md`).

### 3.4 EC rows assigned to Gate 3 (24)

| EC | Case | Expected (summary) | Test | Task |
|---|---|---|---|---|
| EC-02 | Sessions started before hooks / first run | Backfilled from files; "inferred"; confirmed on first hook | I | P3-T08 |
| EC-09 | Duplicate events (agent-flow+Xaibo; plugin+fallback; spool replay) | Ignore agent-flow; mutually exclusive routes; collapse by `delivery_id`; rapid distinct stay distinct | I | P3-T04 |
| EC-11 | Service down / no ack | Spool same `delivery_id`, exit 0 silently within deadline; idempotent replay | I | P3-T03 + T04 |
| EC-12 | Spool overflow | Stop at cap; counter; exact hook-only gap warning; files backfill | I | P3-T03 (+T10 UI) |
| EC-25 | Codex hook trust not granted | "installed, awaiting trust" + steps; rollouts observed; no bypass, no trust writes | I + S5 | P3-T06 |
| EC-28 | statusLine existing/absent, capture failure, concurrent edit | Tee preserves stdin/invocation/stdout/stderr/exit; no-original silent exit 0; conflict on edit | U + I | P3-T14 |
| EC-32 | Malicious local client on hook socket | Reject bad token, >1 MB frame, bad version; socket private | U + I | P3-T02 |
| EC-40 | Background work after Stop | "Finishing…" within M1; settle; "Background work" | U (fixture) + P | P3-T08 (+T16 P) |
| EC-41 | Permission heuristic vs confirmed | Confirmed only from explicit evidence; heuristic labeled, no notification | U | P3-T08 (+T11) |
| EC-42 | Timezone / DST change | UTC ms; elapsed N×24 h; DST fixture | U | P3-T12 |
| EC-43 | Laptop sleep / wake | Reconcile on resume; suspended time excluded from R1 | U (fake clock) + I | P3-T12 |
| EC-44 | Disk full | Pause ingest, checkpoints held, spool stops, exact gap banner, no corruption | I | P3-T04 |
| EC-46 | Upgrade while agents run | Stable shim; spool; version validated; replay | I | P3-T04 |
| EC-48 | Agent config invalid/edited concurrently | Refuse on parse error; hash recheck; abort with message | U | P3-T01 |
| EC-49 | Managed settings / `disableAllHooks` / `allowedHttpHookUrls` | Effective config detected; files-only mode | U | P3-T05 |
| EC-52 | Unknown hook events / new fields | Stored generically; no crash | U | P3-T04 |
| EC-59 | OS notification privacy | Agent + approved label + state only; ≤2 s dispatch | E + P | P3-T11 |
| EC-63 | Oversized/malformed hook stdin | Bounded read; 256 KB cap; truncated flag; no output/decision | U | P3-T03 |
| EC-64 | Hook output adding tokens/noise | 0 bytes, exit 0; no prompt/agent types | U | P3-T03 |
| EC-70 | Interrupted turn | Outcome "interrupted", not error | U | P3-T08 |
| EC-82 | Custom full content, chunks, retry, auth failure | Private persistence; idempotent; bounded assembly; explicit partial/rejected | U + I | P3-T13 |
| EC-83 | Generic notifications / unmatched resolution | No invented wait; only matching evidence clears | U | P3-T13 |
| EC-91 | Rate windows null/expired/>100%/stale | Per-field timestamps; no fake zero/freshness | U + I | P3-T15 |
| EC-92 | Multiple profiles/accounts | Separate uncertain scopes; no credential reads or merge | U + I | P3-T15 |

### 3.5 Metrics measured at Gate 3

| Metric | Target | How |
|---|---|---|
| M8 / §6.7 | Confirmed transitions 100% exact; 0 heuristic-as-confirmed; 0 confirmed stuck/error on legit-long; order invariance 100%; FP/FN ≤ B1 and B2 per fixture | `npm test -- test/integration/replay.test.ts` over claude/2.1.319, codex/0.160.0, gemini/0.46.0 and report/v1 fixtures; baseline table in the progress file |
| M1 | Hook/report → paint p95 ≤250 ms; "Finishing…" ≤250 ms; settled ≤ settle interval + 250 ms; also tee/usage/context/cost receipt path | T0: emitter runs the packaged shim as the agent dispatches hooks; hrtime at emit vs main-stamped paint ack; ≥500 mixed events; per-hop timings |
| M2 | File append → paint p95 ≤1 s; missed-watch recovery ≤ interval + 1 s; also file-only usage, context and cost receipt paths (PRD §10 Gate 3) | Hooks disabled; complete JSONL record appended, measured separately per path: plain record, Claude `message.usage` record, Codex `token_count` record (usage + rate limits), compaction/context record, and a priced turn whose `~$` estimate repaints; each path also during the M3 import; watcher-drop hook for recovery; per-path p95 recorded as Gate 3 evidence |
| M3 | Full import ≤120 s; list p95 ≤1.5 s; no frame >100 ms; M1/M2 hold during import | T1 seeded corpus with concurrent M1/M2 probes |
| M4 | ≤250 MB RSS all processes; idle CPU ≤1% over 5 min, window closed and collecting | `app.getAppMetrics()` at 1 s for 5 min (test mode) plus `ps` on the tree |
| M7 | Forwarder stdout+stderr = 0 bytes, exit 0, no `prompt`/`agent` types; tee adds 0 bytes | T03/T14 tests on every path plus config lint |
| M11 (ingestion) | First observable session-start signal → identified row p95 ≤300 ms | Synthetic `SessionStart` hook and file-only first record; external process start → first signal reported separately |
| M16 | No decisions/stdout/stderr/tokens; async where supported; sync added wait p95 ≤100 ms vs no-Xaibo baseline; forwarder own time ≤100 ms incl. fallback; tee overhead (tee wall − original wall) p95 ≤100 ms | S3-style baseline (`true` vs shim) under service up, down, socket hung, disk full, spool at cap; dispatch/spawn reported separately |

### 3.6 Gate 3 checklist
- [ ] All 24 EC rows pass with their PRD test types; EC-25 cites S5 evidence.
- [ ] §6.7 thresholds met (M8); B1/B2 reported per fixture.
- [ ] M1, M2, M3 (with M1/M2 during import), M4, M7, M11 (ingestion), M16 (incl. tee overhead) measured on the packaged app on the reference Mac; misses accepted by the owner.
- [ ] Gate 1/2 EC regression green; audit 0 in every E2E run; repo unchanged after runs.
- [ ] Helpers (forwarder/shim/tee/`xaibo-report`) audited in every P3-T16 mode: 0 attempts.
- [ ] EC-47 regression (P3-T02): dev and prod data dirs give distinct, coexisting sockets.
- [ ] No agent-config write outside disposable profiles; dev CLI refuses real roots; no renderer Connect IPC.
- [ ] Guard `MATCH` for every live session (local only).
- [ ] Only schemas and aggregates from live runs in git; `privacy:scan` and `fixtures:lint` green.
- [ ] harness-os: every unit's workflow complete (RED and GREEN observed); decisions recorded.
- [ ] Playwright MCP visual check for T10/T11 UI; console clean; status as text plus icon.
- [ ] `/ponytail-review` clean or resolved; no dependency added without approval.
- [ ] `docs/integrations/report-v1.md` and the progress file updated.
- [ ] GS: Codex review (all chunks), Claude second review, `.handoff/` deleted, owner stop, PR.

### 3.7 Risks (Phase 3)

| Risk | Mitigation |
|---|---|
| Ack-after-commit vs the 100 ms forwarder deadline causes routine spooling and duplicate replay | Immediate live-priority transactions; M16/T0 measure the ack hop; OQ-A1 |
| Codex `SessionEnd` always sync; some Claude events may not support async | Counted in the M16 sync budget; per-event S3 decision |
| Keychain sharing touches the real credential | Entry criterion 3; stop and go to the owner |
| Guard false alarms from the owner's concurrent sessions | Guard covers config, credential stat and keychain metadata only (no session-store listings, D-P0-04); owner adjudicates any DIFF |
| Tee changes foreign behaviour (shell semantics, timeout/kill, signals, latency) | S13-recorded invocation; golden suite; signal forwarding; overhead in M16 |
| Unsigned/ad-hoc notification delivery on macOS | E2E stub plus one owner check |
| macOS `sun_path` 104-byte limit | Length check with health error; short test roots (Q3-8) |
| Cross-process latency methodology (renderer has no `hrtime`) | Main-stamped paint ack upper bound, documented |
| Placeholder UI reworked in Phase 4 | Minimal text plus glyph in the existing list only |
| Symlinked agent configs broken by atomic rename | Refused in Phase 3 (Q3-2) |
| Spool cap overshoot by concurrent forwarders | Bounded N×256 KB; `ponytail:` comment; overflow log names the gap |
| 256 KB hook cap drops content where no file fallback exists | Gemini/custom use report chunks (FR-08); truncation flag plus file channel for Claude/Codex |
| Huge single gate diff | Chunked handoffs; interim reviews (Q3-12) |
| Risk prompts on domain words slow every unit | Expected; `record_decision` |

### 3.8 Open questions (Phase 3)
See §6: Q3-2, Q3-3, Q3-5..Q3-9, Q3-11..Q3-15 (Q3-1 → OQ-A1, Q3-4 → OQ-X5, Q3-10 → OQ-X1, Q3-16 → OQ-X6).

---

## Phase D — Xaibo design system (Gate D)

**Goal.** Codex writes `docs/design/xaibo-design.md`, an original Xaibo design system (S-34, FR-50, D-23): tokens (color, type, spacing, status semantics, light and dark themes), layouts for every MVP screen and key states, with the binding A11Y rules (§4.3) part of the design. Phase 4 cannot start until it is approved.

**Branch.** `docs/design-system` from up-to-date `master` (may start right after Gate 0 and run in parallel with Phases 1–3, Q-D1).
**Installs.** None. Optional mockups are static, self-contained HTML/SVG with no external fonts, CDNs or scripts.
**Gated code.** None (`*.md` exempt); no `run_workflow`. Approval recorded with `record_decision`.
**PRD mapping.** S-34, FR-49, FR-50, FR-51 (model · effort display), FR-52 (monthly chart), §6.9, A11Y, D-23; UI parts of US-1..US-20.
**EC rows assigned to Gate D.** None (PRD §10).
**M-IDs.** None measured. The review confirms the design never requires whole-history rendering, keeping M5/M12/M13/M14 reachable (US-14, PERF).

**Entry criteria.** PRD v1.0 approved; Gate 0 passed (S11/S13 fix which usage, context and model fields exist, e.g. Gemini quota "Unavailable from passive sources"); the owner authorized the Codex companion outside the sandbox for this phase (App. B.6).

### Tasks

**PD-T01 — Design brief (Claude)**
- Write `.handoff/design-brief.md`:
  - (a) Required screens: Overview with usage status and live-set totals; attention queue; Session workspace (turns, workflow/timeline, tools, subagents, files touched, available reasoning, context usage view, transcript, cost breakdown); History (projects/folders, Trash, purge confirm, Re-import, monthly usage chart, US-20); Integrations/Add agent; Settings (retention, storage meter, price-override reveal/validate/reload, Clear usage history, theme). No additional top-level workspace (FR-49). Also the patterns later phases need (launch dialog, concurrency warning, ownership badge), so Phase 7 avoids a design delta where possible (OQ-X12).
  - (b) Required states per surface: empty, loading, error, stale, unavailable, estimate.
  - (c) Every fixed PRD label to place and style: "Probably waiting", "Finishing…", "Background work", "Unknown", "Model unavailable", `<model> · <effort>`, `~$…`, "Estimated cost", `~$… known subtotal`, `~$ unavailable`, "Owner-set fallback", `~est`, "Content incomplete", "Transcript only, not resumable", "native deleted/archived", "Account scope unverified", "Unavailable from passive sources" (Gemini quota, FR-46), "Source time unknown; observed …", "Reset passed; awaiting observation", the stale indicator, "Awaiting next usage", "month to date", "some details expired", "details expired, totals only", the drift banner, coverage-gap banners (spool overflow, disk full, hooks blocked by policy), ownership badges (Observed externally / Controlled here / Detached), finding badges R1–R5 with "expected inactivity" / "long-running tool", "Untitled", "Prices as of …", "observed workload, not a quality benchmark" (v1 Compare noted only).
  - (d) Decisions the PRD delegates: token abbreviation format with exact-integer accessible text (§6.9); category labels, grouping, order (§6.9); number, time and countdown formats; narrow-window breakpoints and minimum window size; focus-ring style; reduced motion; theme selection; original inline-SVG iconography; hand-written SVG chart form; viewport sizes for visual baselines.
  - (e) Stack constraints: React, `@tanstack/react-virtual`, no Tailwind, no chart/icon/font libraries, no web fonts (P2; Q-D6), content rendered as text only (SEC3).
  - (f) A11Y: keyboard operation, visible focus, labeled controls, status as text + icon, focus restoration, narrow layouts; an enumerated inventory of every foreground/background token pair with its category (normal text, large text, UI component/focus indicator, graphical object) and the OQ-X15 threshold that applies.
  - (g) Originality: references (agent-flow, harp, deer-flow, Claude Code's context view, the owner's dashboard screenshot) supply features only; layout, navigation, visual style, tab/header naming and colors must not be reproduced.
  - (h) Privacy: synthetic placeholders only.
- Files: `.handoff/design-brief.md` (git-ignored). Test first: n/a; privacy gate on the brief before it leaves the machine. Loop: `npm run privacy:scan -- .handoff/design-brief.md`. Done: brief with a coverage table (PRD ID → design section) and a clean scan. Deps: Gate 0. Owner: optional read.

**PD-T02 — Codex authors the design** — `node <codex-companion> task --fresh --prompt-file .handoff/design-brief.md` outside the sandbox; Codex writes `docs/design/xaibo-design.md` (plus `docs/design/mockups/*` only if Q-D3 says yes) directly on the branch (Q-D2). Loop: `git diff --stat` shows only `docs/design/**`; `npm run privacy:scan`. Done: job result noted in the progress file. Owner: approves the unsandboxed command.

**PD-T03 — Claude review (gate review, diff-only)** — freeze per §2.4 step 1's commit and gate-SHA rules only, no product suite (owner-approved branch commit; Codex's design edits are committed on the docs branch, the gate waits if declined); the privacy check is `npm run privacy:scan`, which exists on `master` from Gate 0 (P0-T08); `git diff -u <base> <gate-sha> -- docs/design`; each Codex revision round gets a new gate SHA and the re-review uses `git diff -u <old-gate-sha> <new-gate-sha>`. Checklist: (1) every PD-T01 (a)–(d) item present (coverage matrix; gaps by ID); (2) every pair in the design's foreground/background pair inventory passes its OQ-X15 contrast threshold in both themes, reported per pair as ratio and pass/fail (throwaway WCAG script in the scratchpad, not committed); (3) status never relies on color alone (each lifecycle × confidence pair has text and icon); (4) keyboard and focus order per screen and dialog, focus-restoration targets named; (5) narrow layouts per screen; (6) no unapproved dependency implied; (7) large lists/transcripts designed as paged/virtualized surfaces with explicit continuation, no whole-history views; (8) originality vs the named references; (9) mockups contain no real data and load no external resources; (10) no wording contradicting the PRD (e.g. a new top-level workspace). Findings to `.handoff/design-review-<n>.md`. Done: findings with severities; zero blocking at exit.

**PD-T04 — Codex revision rounds** — findings sent back via the companion (`--fresh --prompt-file .handoff/design-review-<n>.md`); Codex edits; Claude re-reviews the new diff and never edits design content (Q-D2), and on every new gate SHA re-runs the **complete** PD-T03 checklist on the whole design at that SHA (including the full per-pair contrast report), not only on the changed lines; owner approval names the SHA whose checklist run is attached; after Q-D5 rounds, remaining findings go to the owner. Done: 0 blocking, or the owner ruled on each.

**PD-T05 — Owner approval and close** — owner reads the doc (and mockups); `record_decision` "Gate D approved, design rev <sha>"; gate-record commit on top of the approved SHA adds `docs/plans/gates/gateD.md` with the checklist run, verdicts and approval (§2.4 step 6); `.handoff/design-*` deleted with no backups; PR to `master` when the owner asks. Done: decision ID, approved SHA, merged PR. Owner: **approves Gate D**.

### Gate D checklist
- [ ] `docs/design/xaibo-design.md` covers every screen, state, label and delegated decision in PD-T01 (coverage matrix attached).
- [ ] Light and dark themes; every inventoried token pair passes its OQ-X15 threshold (per-pair ratio and pass/fail attached).
- [ ] A11Y rules per screen: keyboard, focus, labels, text + icon, focus restoration, narrow layouts.
- [ ] No unapproved dependency implied; charts and icons hand-written SVG; no web fonts.
- [ ] Originality (D-23) passed; the owner checks the dashboard-screenshot item (Q-D4).
- [ ] Privacy scan clean; `.handoff` design files deleted.
- [ ] Claude review 0 blocking, then owner approval recorded (no Codex review: Codex is the author).

### Risks (Phase D)
- **Critical path:** Phase 4 blocked until Gate D → run Phase D in parallel (Q-D1).
- **Hidden dependencies** (chart library, web fonts) → brief constraint (e), review item (6).
- **Subjective originality** → written checklist vs named references; owner is the final judge.
- **Untestable design** (states the data cannot produce) → the brief cites S11/S13 results; every state maps to a PRD rule.

### Open questions (Phase D)
See §6: Q-D1..Q-D6.

---

## Phase 4 — Session workspace UI (Gate 4)

**Goal.** Overview, attention queue and Session workspace in the approved design: usage status and history access, live-set totals, context usage view, files touched, transcript, cost breakdown, timeline, model · effort. Lists paged and virtualized; workers, file handles, live memory and IPC bounded. Gate 4 passes on EC-56/57/86/97/100/102 and M5, M12, M14 (T2 with usage/context/cost enabled).

**Branch.** `feat/phase4-session-workspace`, from `master` containing Gate 3 and Gate D.
**Installs.** `@tanstack/react-virtual`, exact version (App. C, Phase 4); owner confirms before `npm install`; npm cache in `.cache/`.

**PRD mapping.** S-08, S-29 (UI virtualization, bounded live path), S-32 (UI), S-35 (UI); FR-04 (badges), FR-09, FR-23 (badge display only; ownership logic Phase 7), FR-46, FR-47, FR-48, FR-49, FR-50, FR-51; §6.9, A11Y, SEC3, PERF; US-1, US-2 (in-app attention), US-3, US-4, US-14, US-15 (coverage display), US-16, US-17, US-18, US-19; M5, M12, M14; M13 on T0 only (EC-86).

**Entry criteria.** Gates 3 and D passed; Phase 1 shell (Electron, renderer, IPC, tray, E2E + audit every run); Phase 3 live projection, status engine, findings, usage/context projection; Phase 2 cost estimates; the T2 emitter and M1/M2 instrumentation from Phase 3; `dist:mac` packaging works.

**Pipeline.** HP for every `src/**/*.ts(x)` unit (`new-feature` unless noted). Every unit's harness RED is a node:test test on its `.ts` logic module, observed through `npm test` before any `.tsx` is written (§3.6); Playwright RED is additional, logged by hand (OQ-X8).

**Shared loop (each task).**
```sh
npm run typecheck && npm run lint && npm test -- <unit/integration files>
npm run build && npm run test:e2e -- <spec files>   # connection-attempt audit runs inside every E2E run
npm run privacy:scan && npm run fixtures:lint
```
After each UI change, a Playwright MCP visual check on a dev build with synthetic data (render, 0 console errors, key flows); never a real-data instance (§8).

### Tasks

**P4-T00 — Phase setup** — branch; base SHA in the progress file; `/graphify`; install `@tanstack/react-virtual` exact; Phase 4 progress section. Loop: `npm ci && npm test` green; `git status --porcelain` clean apart from intended changes. Owner: approves the install.

**P4-T01 — Design tokens, themes, status semantics**
- Build: approved tokens as CSS custom properties (light/dark); pure `statusPresentation(lifecycle, confidence, reasons)` → label and icon ID per §6.1–§6.4; `<StatusBadge>` renders text plus inline SVG icon.
- Files: `src/renderer/styles/tokens.css`, `src/renderer/status/presentation.ts`, `src/renderer/status/StatusBadge.tsx`, `test/unit/renderer/presentation.test.ts`, `test/unit/renderer/contrast.test.ts`.
- Test first (U): every lifecycle × confidence pair has non-empty text and an icon; heuristic waits read "Probably waiting"; Unknown never renders as idle (§5.6). Contrast test parses `tokens.css` and asserts the design's target for every declared pair in both themes. Both fail first.
- Deps: P4-T00.

**P4-T02 — Paged data access and live-delta coalescing (renderer side)**
- Build: keyset-cursor IPC for session list, turns/events, tools, files, usage history (FR-09); MessagePort live-delta consumer with a bounded per-session coalescer (latest wins, flushed ≤ once per animation frame); deltas pause while the window is hidden and the renderer resyncs by cursor when shown (M4/M12). Extends the Phase 1 preload/IPC.
- Files: `src/main/ipc.ts`, `src/main/preload.cts`, `src/renderer/data/{pages,coalesce}.ts`, `test/unit/renderer/coalesce.test.ts`, `test/integration/ipc-paging.test.ts`.
- Test first: U — bounded size under 10,000 deltas, last value wins, final state never lost. I — cursor always progresses, page size bounded, no duplicates or gaps with concurrent inserts.
- Done: GREEN; coalescer heap under load bounded (number in the progress file).

**P4-T03 — Virtualized list primitive** — one wrapper on `@tanstack/react-virtual` (variable heights, roving-focus keyboard navigation, page fetch at edges) used by session list, transcript and timeline; no second list abstraction. Files: `src/renderer/components/virtual-list-model.ts` (focus index transitions for Arrow/Home/End, edge-fetch trigger, head-insertion scroll anchor), `test/unit/renderer/virtual-list-model.test.ts`, `src/renderer/components/VirtualList.tsx`, `test/e2e/virtual-list.spec.ts`. Test first (U, harness RED via `npm test`, §3.6): Arrow/Home/End index transitions incl. bounds; the edge-fetch fires once per edge; adding N rows at the head shifts the anchor by their measured heights. Fails before `virtual-list-model.ts` exists; `VirtualList.tsx` is written after. Then (E): 10,000 synthetic sessions → rendered row DOM count ≤ viewport rows + overscan; Arrow/Home/End move focus; the scrolled-to row stays put when rows are added at the head (App. G §7). Deps: P4-T02.

**P4-T04 — Overview and attention queue**
- Build: live sessions list; attention queue (confirmed waiting-for-permission and needs-input first; heuristic "Probably waiting" separated and labeled); collection health (a disconnected collector loses the live indicator, §6.9); active-agent count (distinct registrations with busy, waiting or needs-input sessions, incl. background work) plus session count; live-set token totals (normalized input + output, no parent/child overlap) and `~$` with coverage (known subtotal/unavailable per §5.12); usage status per agent and evidenced scope (windows, durations, %, reset clock and countdown, plan, credits, stale, reset-passed, account-scope-unverified, source-time-unknown; FR-46, §5.11); access to each scope's bounded observed history with gaps shown, not interpolated (Q-4.4); model · effort on every live row (FR-51); finding badges with rule and evidence (US-4).
- Files: `src/renderer/overview/*.tsx`, `src/renderer/overview/totals.ts`, `src/renderer/usage/presentation.ts`, `test/unit/renderer/totals.test.ts`, `test/unit/renderer/usage-presentation.test.ts`, `test/e2e/overview.spec.ts`.
- Test first: U totals — unavailable ≠ 0, partial label "known subtotal", no child double-added. U usage — >100% spend kept, stale label after 15 min, reset-passed replaces the countdown, scope-unverified omits the combined curve, Gemini shows exactly "Unavailable from passive sources" with no reset or percentage values. E — synthetic live stream updates rows; queue order confirmed > heuristic; collector loss removes the live indicator; a Gemini profile shows that exact text with no reset or percentage values.
- Deps: P4-T01, P4-T03.

**P4-T05 — Session workspace (turns, workflow, tools, subagents, files, reasoning, transcript, timeline)**
- Build: paged virtualized transcript of prompts, responses and "Available reasoning" (only when present, §5.6); tool calls with args, results, approval state, duration and combined provenance; subagents with lifecycle and model; files touched (read, write attempted, write confirmed — FileTouch derived here, OQ-P2-07); timeline of workflow/tool/subagent events with compaction and model/effort markers; "Content incomplete" gap (US-15); provenance per item; untrusted content as text (EC-55 rule: no `innerHTML`, safe ANSI).
- Files: `src/renderer/workspace/*.tsx`, `src/renderer/workspace/timeline.ts`, `src/service/` FileTouch derivation (pure module), `test/unit/renderer/timeline.test.ts`, `test/unit/filetouch.test.ts`, `test/e2e/workspace.spec.ts`.
- Test first: U — timeline merge gives stable source-order (causal) ordering, includes compaction and model markers, does not duplicate a tool with hook and transcript provenance; FileTouch kinds derived correctly. E — on a synthetic Claude, Codex and Gemini session: turns, tools with results, a subagent, three file-touch kinds, the reasoning block, the incomplete-content label.
- Deps: P4-T03.

**P4-T06 — Context usage view** — percentage, used/window tokens in the design's abbreviated format with exact integers in accessible text, source, freshness, model, context generation; "Awaiting next usage" after compaction; inferred-window and `~est` labels (Gemini); graphical meter with a text equivalent; the §6.9 category list shown as unavailable with the v1-B explanation; unavailable buffer means unoccupied space is never labeled "usable before compaction" (FR-47, US-17). Files: `src/renderer/workspace/context/*.tsx`, `src/renderer/workspace/context/format.ts`, `test/unit/renderer/context-format.test.ts`, `test/e2e/context-view.spec.ts`. Test first: U — abbreviations round-trip to exact integers in accessible text; null → unavailable, never 0; old generation never paired with a new window. E — post-compaction fixture shows "Awaiting next usage"; categories unavailable with explanation. Deps: P4-T05.

**P4-T07 — Cost breakdown** — session `~$` with accessible "Estimated cost" label, token components, basis (agent_reported or token_table), source, coverage, each applied price revision and "Prices as of …"; multiple revisions listed; `~$ unavailable` with reason; "Owner-set fallback" label (FR-48, US-18, §5.12). Files: `src/renderer/workspace/cost/*.tsx`, `src/renderer/workspace/cost/present.ts`, `test/unit/renderer/cost-present.test.ts`, `test/e2e/cost-breakdown.spec.ts`. Test first: U — every amount has `~` and label; null keeps its reason; reported 0 stays 0; mixed revisions listed. E — mixed-revision fixture. Deps: P4-T05.

**P4-T08 — EC-102: model/effort switch and subagent model (U + E)**
- **EC-102** Mid-session model or effort switch; subagent on a different model than its parent — current model updates within M1 (hook/report) and M2 (file-only) with pre-observation delay reported separately; switch on the timeline with a timestamp; each subagent shows its own model; tokens and cost attributed per turn's model; tee and report v1 carry model and effort (FR-45, §5.10) — **U + E**.
- Build: renderer model-label projection `<display name> · <effort>`, raw ID when unlisted, "Model unavailable" without evidence; timeline switch markers; reuses Phase 2 FR-51 resolution (EC-101 logic is Gate 2).
- Files: `src/renderer/model/label.ts`, `test/unit/renderer/model-label.test.ts`, `test/e2e/model-switch.spec.ts`.
- Test first: U — separator, effort omitted when absent, never blank; on a synthetic switch fixture with distinct per-turn usage and distinct prices per model, each turn's tokens and `~$` cost are attributed to that turn's model, for both the hook/report and the file-only path. E — synthetic hook-path and file-only switches each update row and timeline; each timeline switch marker carries the fixture's switch timestamp; latency via Phase 3 M1/M2 instrumentation asserted ≤ M1 and ≤ M2; a subagent row shows its own model.
- Done: latency p95 in the progress file. Deps: P4-T05.

**P4-T09 — EC-56: very long lines, binary-like output (E)**
- **EC-56** Very long lines / binary-like output — wrapped, truncated with "show more", no UI freeze — **E**.
- Build: bounded content slices from the store (§5.7); wrap/truncate at a design-defined length; "show more" fetches the next slice; binary-like bytes render as escaped text.
- Files: `src/renderer/workspace/ContentBlock.tsx`, `src/renderer/workspace/slice.ts`, `test/unit/renderer/slice.test.ts`, `test/e2e/long-content.spec.ts`.
- Test first: U — UTF-8-safe cuts, continuation cursor progresses. E — synthetic 50 MB single-line tool output and a NUL/control-byte blob: no main-thread long task >100 ms (`PerformanceObserver` `longtask`); "show more" works by keyboard.
- Done: longest task recorded. Deps: P4-T05.

**P4-T10 — Bounded workers, watcher handles, live memory, IPC (service side)** — cap parser worker count and open tail handles (LRU closes inactive handles; limits from S12); bounded live-state map (ended sessions evicted from volatile state after durability); bounded renderer delta queue with cursor-resync fallback; content-free metrics (queue age, WAL size, parse lag, open handles, §7.4); each limit with a `ponytail:` comment. Files: `src/service/workers/pool.ts`, `src/service/watch/handles.ts`, `src/service/live/state.ts`, `src/service/metrics.ts`, `test/unit/service/{handles,live-state}.test.ts`, `test/integration/bounded-resources.test.ts`. Test first: U — LRU never exceeds cap, reopens at the saved offset; eviction. I — 200 tailed synthetic files: open handles ≤ cap, no events lost. Done: metrics visible in diagnostics without content. Deps: P4-T00.

**P4-T11 — EC-57: 50 concurrent sessions, sustained mixed traffic (P)**
- **EC-57** 50 concurrent sessions / sustained mixed traffic — M14 holds during backfill; bounded resources; no unexplained loss or duplicate logical operations — **P**.
- Build: extend the Phase 3 T2 scenario with UI rendering: packaged app window open on Overview with one workspace selected; T1 backfill concurrent; a service restart/replay mid-run. `scripts/gen-perf-corpus.ts` gains a mixed-agent live stream (4 KiB mean, p99 ≤256 KiB).
- Files: `test/perf/t2.ts`, `scripts/gen-perf-corpus.ts`.
- Test first (P): T2 fails against the pre-T10 build or before assertions exist. Assertions: 50 sessions, 200 events/s for 10 min, M1/M2 p95, queue age p95 ≤1 s, drain ≤5 s after load, delivered = persisted logical operations, 0 duplicates.
- Loop: `npm run dist:mac && npm run perf -- --tier=T2`. Done: T2 report (hardware, macOS, versions, seed, DB/index sizes, end-to-end p95, per-hop timings). Deps: P4-T04, T05, T10. Owner: accepts any miss (Q19).

**P4-T12 — EC-100: usage/context/cost enabled under live load and faults (I + P)**
- **EC-100** Usage/context/cost enabled during live load and faults — M1/M2/M4/M5/M7/M14/M16 hold; category work cannot stall live dispatch; no prohibited command or backend call; capture overhead measured separately from the foreign statusLine runtime — **I + P**.
- Build: T2 with synthetic statusLine-tee frames (context, rate limits, cost, model, effort), Codex `token_count` with rate limits, live cost calculation; faults: service kill, disk-full injection, malformed snapshot. Spawn/exec audit wraps the single spawn module in service and main under test and fails on `claude -p`, `codex exec`, `/context`, `count_tokens` or any model/quota invocation (FR-44); asserts no non-loopback attempts.
- Files: `test/integration/usage-under-fault.test.ts`, `test/perf/t2.ts` (usage flag), `test/perf/m4-m5.ts`.
- Test first: I — dispatch-loop lag bounded while a price/category worker job is artificially slowed; the spawn audit catches an injected prohibited command (negative control). P — T2 with usage fails until assertions are wired.
- Loop: `npm test -- test/integration/usage-under-fault.test.ts && npm run perf -- --tier=T2 --usage`. Done: M1/M2/M4/M5/M7/M14/M16 reported; tee overhead separate from foreign runtime. Deps: P4-T11. Owner: miss acceptance.

**P4-T13 — EC-86: cold start, hidden tray window, 200 MB indexed session (E + P)**
- **EC-86** Cold start, hidden tray window, 200 MB indexed session — M12; M13 on T0 only (full M13 on T3 at Gate 5); window hidden not destroyed; content paged without a full-file read — **E + P**.
- Build: close hides, tray shows the existing window; readiness path runs no backfill, reindex or migration (§7.4); session open fetches the first bounded page from the indexed store; content-free perf marks (start, first usable page via double rAF after commit).
- Files: `src/main/window.ts`, `src/main/tray.ts`, `test/e2e/tray-window.spec.ts`, `test/perf/t0.ts`.
- Test first: E — after close, the BrowserWindow ID is unchanged when it reappears; collection continues (US-9); Quit stops it. P — cold start → usable list p95 ≤1.5 s; tray → painted p95 ≤300 ms; selecting the synthetic 200 MB session → first page p95 ≤300 ms; bytes read from the source transcript during selection ≪ file size (read counter in the test build).
- Loop: `npm run dist:mac && npm run test:e2e -- test/e2e/tray-window.spec.ts && npm run perf -- --tier=T0`. Done: M12 and M13-T0 p95 at n ≥20 runs each (Q-4.7). Deps: P4-T05. Owner: miss acceptance.

**P4-T14 — EC-97: usage, context and session access under narrow layouts, missing/stale data, collection loss (E)**
- **EC-97** Usage status, live-set totals, context view and session access (files, transcript, cost breakdown, timeline) under narrow layouts, missing/stale data and collection loss — FR-49/§6.9 capabilities with keyboard and text equivalents in the approved design (FR-50); scope and coverage explicit; honest live health; content access preserved — **E**.
- Build: fix whatever the spec exposes; no new feature.
- Files: `test/e2e/usage-access.spec.ts`, fixes in P4-T04..T07 files.
- Test first (E): matrix {narrow, wide per design breakpoints, Q-4.5} × {complete, missing, stale, collector-disconnected}; each surface reached by keyboard only; accessible text has exact values and coverage; disconnected collector → no live indicator.
- Deps: P4-T04..T07.

**P4-T15 — A11Y sweep (§4.3, §9.3)** — keyboard-only E2E per flow (Overview → queue item → workspace regions → context, cost, files, timeline → back); visible focus (computed outline per the design focus token); labeled controls (`getByRole` with name for every interactive element); status text + icon; focus restoration after dialogs/panels; narrow layouts rendered; `toMatchAriaSnapshot` per screen. No axe dependency (Q-4.2). Files: `test/e2e/a11y-workspace.spec.ts`. Test first (E): fails on the names and focus targets enumerated from the design doc. Deps: P4-T04..T09.

**P4-T16 — Visual baselines and Playwright MCP checks** — `toHaveScreenshot` per screen (Overview, queue, workspace with each panel, context, cost, empty/loading/error/stale/unavailable/estimate states) × light/dark × design viewports; synthetic data, fixed clock, animations off, system fonts; darwin-only. Playwright MCP over every screen (render, console free of errors). Files: `test/e2e/visual.spec.ts`, `test/e2e/visual.spec.ts-snapshots/*.png` (Q-4.1). Test first (E): first run fails (missing baselines); Claude reviews each PNG against the design before `--update-snapshots`, and checks PNGs contain only synthetic text. Loop: `npm run test:e2e -- test/e2e/visual.spec.ts` ×3. Done: stable over 3 runs; MCP notes. Deps: P4-T04..T15. Owner: optional look.

**P4-T17 — M5 measurement** — `ps -o rss=,pcpu=` across the packaged app tree (main, renderer, GPU, utility service, workers) with the window open on Overview with 50 live sessions (after T2) and idle with a workspace open; re-measure M4 (window closed). Files: `test/perf/m4-m5.ts`. Test first (P): fails before the assertion exists; asserts M5 ≤450 MB and M4 ≤250 MB with CPU ≤1% over 5 min. Loop: `npm run perf -- --tier=M5`. Deps: P4-T11 (an early run right after P4-T04 to catch RSS risk). Owner: miss acceptance.

**P4-T18 — Gate 4** — GS (incl. `npm run perf -- --tier=T0,T2,M5`, M6 = 0 across all Phase 4 E2E runs, `git status --porcelain` unchanged; `.handoff/gate4-review.md` with base SHA, diff and needed PRD rows/design sections). Owner: **Gate 4 stop**; accepts metric misses.

### EC rows assigned to Gate 4

| EC | Case | Expected (PRD §9.2 summary) | Test | Task |
|---|---|---|---|---|
| EC-56 | Very long lines / binary-like output | Wrapped, truncated with "show more"; no UI freeze | E | P4-T09 |
| EC-57 | 50 concurrent sessions / sustained mixed traffic | M14 holds during backfill; bounded resources; no unexplained loss/duplicates | P | P4-T11 |
| EC-86 | Cold start, hidden tray window, 200 MB indexed session | M12; M13 on T0 only; hidden not destroyed; paged without full-file read | E + P | P4-T13 |
| EC-97 | Usage, totals, context view, session access under narrow/missing/stale/collection loss | §6.9 capabilities with keyboard/text equivalents; scope/coverage explicit; honest health; access preserved | E | P4-T14 |
| EC-100 | Usage/context/cost during live load and faults | M1/M2/M4/M5/M7/M14/M16 hold; no dispatch stall; no prohibited call; overhead measured separately | I + P | P4-T12 |
| EC-102 | Mid-session model/effort switch; subagent on a different model | Update within M1/M2; timeline switch with timestamp; per-subagent model; per-turn attribution | U + E | P4-T08 |

### Metrics at Gate 4
- **M5:** RSS ≤450 MB window open (P4-T17).
- **M12:** cold start → usable list p95 ≤1.5 s; tray → painted hidden window p95 ≤300 ms, packaged (P4-T13).
- **M14:** T2 (50 sessions, 200 events/s × 10 min, 4 KiB mean, p99 ≤256 KiB) with usage/context/cost enabled, during T1 import and a restart/replay: M1/M2 hold, queue age p95 ≤1 s, drain ≤5 s, no unexplained loss/duplication (P4-T11/T12).
- **Re-measured (EC-100):** M1, M2, M4, M7, M16, plus M13 on T0 (P4-T12/T13/T17).
- Reporting: hardware, macOS, versions, seed, DB/index sizes, real monotonic clock; a miss needs explicit owner acceptance.

### Gate 4 checklist
- [ ] EC-56, 57, 86, 97, 100, 102 pass.
- [ ] E2E covers Overview live updates, attention queue, session workspace (turns, tools, subagents, files, reasoning), stuck/loop badge display, context, cost, timeline, model switch, tray/close/quit.
- [ ] Visual baselines from the implemented approved design, light and dark; Playwright MCP check on every screen with 0 console errors.
- [ ] A11Y: keyboard-only flows, visible focus, labels, text + icon status, focus restoration, narrow layouts.
- [ ] M5, M12, M14 (T2, usage enabled) measured; misses accepted by the owner.
- [ ] M6 = 0 in every E2E run; repo unchanged after runs.
- [ ] Pipeline evidence per unit; `record_decision` entries for risk prompts.
- [ ] GS: Codex review, Claude second review, owner stop, `.handoff` deleted, PR after the gate.

### Risks (Phase 4)
- **RSS budget** with 50 live rows → virtualization, coalescer, paused deltas while hidden, measure early (P4-T17 after P4-T04).
- **Flaky visual baselines** → fixed clock, no animation, system fonts, darwin-only, three-run check.
- **Real data in PNGs** (the scan cannot read PNG text) → synthetic fixture dirs only plus manual PNG check.
- **JSX and node:test** → logic in `.ts` modules.
- **Paint latency proxy** (double rAF) → report hops, compare with Phase 3 instrumentation.
- **Spawn audit coverage** → lint rule enforces one spawn module (P1-T01).

### Open questions (Phase 4)
See §6: Q-4.1, Q-4.2, Q-4.4..Q-4.7 (Q-4.3 → OQ-X8, Q-4.8 → OQ-X11).

---

## Phase 5 — History and retention (Gate 5)

**Goal.** History organization (projects/folders, move, pin, archive, Trash with Undo, restore); purge covering every derivative copy, with suppression and Re-import; FTS5 search, paged, with the coverage note; the retention job (session retention, 45-day account-usage expiry, Trash auto-empty); the storage meter; monthly usage settlement and chart (FR-52, US-20); large-history paging, search and maintenance meeting M13 on T3 incl. quota history and indexes.

**Branch.** `feat/phase5-history-retention`, from `master` containing Gate 4.
**Installs.** None (chart is hand-written SVG).

**PRD mapping.** S-09, S-10, S-29 (large history), S-36; FR-10, FR-11, FR-12, FR-13, FR-52; §5.4 (Overlay, Suppression, MonthlyUsageTotal, MonthlyQuotaPeak, SettledContribution), §5.7 (64 KiB FTS coverage), §5.11 (retention/storage), §7.4 (`incremental_vacuum`, `PRAGMA optimize`, backups), P1; US-5, US-6, US-14, US-20; M13 (T3); regression M12 and T0/T1 smoke.

**Entry criteria.** Gate 4 passed; S1 engine and SQLite version, FTS5 delete strategy (`contentless_delete` availability) and DBSTAT availability recorded in `phase0_spikes.md`; Phase 3 usage history projection and Phase 2 cost estimates exist; ≥25 GiB free disk for T3 (Q-5.4).

**Pipeline.** HP. Purge, suppression, retention, settlement and Clear usage history use `security-change` (permanent destruction, privacy); search and history UI `new-feature`. Expect risk prompts on "purge", "delete", "session", "token".

**Loop.** As Phase 4; plus `npm test -- test/integration/<file>` and `npm run perf -- --tier=T3`.

### Tasks

**P5-T00 — Phase setup** — branch, base SHA, `/graphify`, progress section. Generate the T3 corpus once per seed into `.cache/perf/t3/`: extend `scripts/gen-perf-corpus.ts` for ≥10,000 sessions, a ≥10 GiB populated DB (content and index, no padding), 200 MB transcripts, 45-day minute-sampled quota streams with transitions, context projections, price provenance. Test first (U): `test/unit/scripts/gen-corpus.test.ts` — same seed → identical manifest hash; declared distribution met at small scale. Loop: `npm test -- test/unit/scripts/gen-corpus.test.ts && npm run perf -- --gen=T3`. Done: corpus manifest (row counts, table/index/WAL bytes), aggregates only. Owner: confirms disk location and budget.

**P5-T01 — Overlay: projects, folders, move, pin, archive (FR-10, US-5)** — forward-only migration with overlay tables keyed `(agent, profile, native_session_id)`; IPC actions; paged filtered history list (keyset on `(agent, last_activity)` and `(project_id)`); native files never touched; the "approved project label" confirm action used by notifications. Files: `src/service/store/migrations/<n>_overlay.sql`, `src/service/history/overlay.ts`, `src/main/ipc.ts`, `test/unit/service/overlay.test.ts`, `test/integration/overlay-migration.test.ts`. Test first: U — idempotent ops; a move keeps identity. I — backup taken by the recovery path; forward-only; native fixture checksum unchanged. Deps: P5-T00.

**P5-T02 — EC-66: missing title or project (U)**
- **EC-66** Missing title / project — "Untitled" + first-prompt excerpt in-app only (never in notifications); default project = cwd basename in-app only; reaches notifications only after the user confirms it as the approved project label (FR-10) — **U**.
- Build: pure display resolver; the Phase 3 notification payload builder takes the label only from the confirmed overlay field, else "Project".
- Files: `src/shared/display/title.ts`, `src/service/notify/payload.ts`, `test/unit/shared/title.test.ts`, `test/unit/service/notify-payload.test.ts`.
- Test first (U): untitled → "Untitled" plus excerpt in-app; payload has no excerpt, title or basename until the label is confirmed, then exactly the label. Deps: P5-T01.

**P5-T03 — Trash, Undo, restore; Trash auto-empty timer (FR-11, FR-12)** — delete → Trash (`trashed_at`) with Undo; restore clears; 30-day timer from deletion; monthly totals unchanged by Trash/restore (FR-52). Files: `src/service/history/trash.ts`, `test/unit/service/trash.test.ts`. Test first (U): Undo restores the overlay exactly; expiry eligibility = elapsed 30 × 24 h (EC-42 rule). Deps: P5-T01.

**P5-T04 — Settlement core (FR-52 accounting)** — tables MonthlyUsageTotal, MonthlyQuotaPeak, SettledContribution. Contribution keys = `HMAC(per-install key, source identity)` (Q-5.10, OQ-X14), content-free. Settlement by deltas only; counter resets start a new series; sessions and turns counted once per local month bucket (owner time zone at event time, offset stored); cost only from disjoint attributable contributions, never prorated across months or models, partial = known subtotal, none = unavailable; price provenance frozen. Quota peak = max measured % per month per scope/epoch and limit window, never summed, carried forward or model-attributed. `settle(tx, records)` runs inside the caller's transaction and is the only path into frozen totals. Live month view = frozen totals + live calculation over unsettled retained records, in a bounded worker (never renderer or dispatch loop). Files: `src/service/store/migrations/<n>_monthly.sql`, `src/service/usage/{settle,monthly}.ts`, `test/unit/service/settle.test.ts`, `test/unit/service/monthly-buckets.test.ts`. Test first (U): EC-103/104 unit parts (T05/T06). Deps: P5-T00.

**P5-T05 — EC-103: settlement accounting (U + I)**
- **EC-103** Settlement accounting: retention expiry in split batches; job killed mid-run; cumulative counters and resets; spool replay, explicit Re-import and suppression-clearing new activity after settlement — settle + delete in one transaction; deltas, never cumulative snapshots; sessions/turns once per month bucket regardless of batches; month totals identical before and after expiry; settled keys block double counting; genuinely new contributions still added — **U + I**.
- Files: `test/unit/service/settle.test.ts`, `test/integration/settlement-crash.test.ts`.
- Test first: U — split-batch and counter-reset cases. I — SIGKILL the service between batches; after restart totals equal the never-killed oracle; replay or Re-import adds 0 to settled months. Deps: P5-T04.

**P5-T06 — EC-104: month and quota semantics (U)**
- **EC-104** Month and quota semantics: TZ change, DST, near-midnight last-day events, partial current month, months before first observation, quota windows crossing months, multiple scopes, model filter on quota — local month at event time with offset stored; "month to date"; missing months absent, not zero; quota peak = max measured per month per scope, never summed or carried forward; uncertain scopes separate; model filter does not apply to quota; detail availability from retained records ("some details expired" vs "details expired, totals only", honoring Keep/active) — **U**.
- Files: `test/unit/service/monthly-buckets.test.ts`, `src/service/usage/availability.ts`.
- Test first (U): fixed-TZ fixtures (`TZ` per test process) around DST and month-end. Deps: P5-T04.

**P5-T07 — Purge engine and suppression (FR-11), with purge acceptance**
- Build: `purge(session)` in one DB transaction settles contributions (P5-T04), then deletes events, turns, tool calls, file touches, FTS rows (S1-version strategy: external-content `'delete'` with original text, or `contentless_delete`), attachments, session-linked ContextSnapshot/CostEstimate/UsageSnapshot provenance links, and writes the Suppression marker (manual or retention). After commit: remove complete and incomplete content/chunk files; rewrite closed spool files without the session's deliveries (atomic same-dir rename; active files rely on intake suppression and are rewritten once rotated); handle migration backups containing the session (Q-5.1); `incremental_vacuum` off the readiness path. Suppression filters rescans, spool replay and late hooks before insert. Native files never touched. UI copy: "not forensic secure erasure" (Q-5.2).
- Files: `src/service/history/purge.ts`, `src/service/history/suppression.ts`, `src/service/ingest/*` (intake suppression check), `src/service/store/backup.ts`, `test/integration/purge-acceptance.test.ts`.
- Test first (I, **purge acceptance**): one synthetic session with a unique canary across events, FTS, attachments, a complete chunked item, an interrupted chunk assembly, spool entries, a context/cost snapshot, a migration backup, plus an untouched second session. After purge: (a) all logical queries for canary and session ID return 0 rows incl. FTS `MATCH`; (b) byte search for the canary across content dirs, spool and backups finds 0 hits (main DB file excluded, FR-11 non-forensic, Q-5.2); (c) other session intact; (d) monthly totals unchanged; (e) native fixture checksum unchanged; (f) app-data permissions 0700/0600.
- Loop: `npm test -- test/integration/purge-acceptance.test.ts`. Done: recorded as Gate 5 purge-acceptance evidence. Deps: P5-T03, P5-T04.

**P5-T08 — EC-21: purged session resurrection (I)**
- **EC-21** Purged session resurrection (rescan, spool replay, late hooks, migration backups) — purge covers events, FTS, attachments, complete and incomplete content/chunk files, spool entries, session-linked projections and backups; tested with interrupted chunk assembly then purge and replay; suppression skips rescans and replays; retention suppression clears only on demonstrably new native activity; manual suppression needs explicit "Re-import" — **I**.
- Files: `test/integration/purge-resurrection.test.ts`, `src/service/history/reimport.ts`.
- Test first (I): after purge — full rescan, spool replay of pre-purge deliveries, a late hook, restart from a pre-purge backup path, a resumed interrupted chunk upload: 0 rows each time. Then new native records: retention suppression clears; manual stays until Re-import. Deps: P5-T07.

**P5-T09 — Retention job (FR-12, §5.11)** — at service start (deferred off readiness) and daily. Session policy: default delete 45 days after last activity; Never or N days (Q-5.5); excludes busy/waiting/needs-input, activity <24 h, Keep. Trash auto-empties 30 days after deletion. Account-level usage history expires 45 elapsed days after measurement time (observation time if unknown), independent of the setting and Keep. Every deletion through `settle()` in the same transaction. Batches bounded by rows and time, behind live batches (§7.4). Purge date visible in session details (US-6). Files: `src/service/retention/{job,policy}.ts`, `test/unit/service/retention-policy.test.ts`. Test first (U): EC-22 part. Deps: P5-T07. Owner: confirms retention bounds (Q-5.5).

**P5-T10 — EC-22: retention vs active sessions (U)**
- **EC-22** Retention vs active sessions — never purge busy/waiting/needs-input, activity <24 h, or Keep; an auto-purged session continued natively is re-imported with a notice; a manual purge stays suppressed with a notice — **U**.
- Files: `test/unit/service/retention-policy.test.ts`. Test first (U): fake clock and fake lifecycle table; EC-42 regression — a TZ/DST-transition fixture shows session retention and Trash expiry use elapsed N × 24 h. Deps: P5-T09.

**P5-T11 — EC-99: 45-day quota expiry and large quota history (I + P)**
- **EC-99** Forty-five-day quota expiry, Keep/Trash/purge, restart/replay, large quota history — independent quota and session retention; no resurrection or fabricated samples; bounded indexed queries; M13 holds with snapshot and index bytes in T3 — **I + P**.
- Files: `test/integration/quota-retention.test.ts`, `test/perf/t3.ts` (quota-history queries).
- Test first: I — account-level samples expire at 45 days even when the originating session has Keep; session-linked snapshots follow Keep, Trash and purge; restart with replay of expired samples does not re-insert them; no interpolated rows; EXPLAIN QUERY PLAN uses `(usage_scope_id, limit_id, as_of)`. P — paged quota-history queries on T3 (64,800 samples per stream plus transitions) bounded; M13 holds.
- Done: row counts and table/index bytes reported. Deps: P5-T09, P5-T00.

**P5-T12 — EC-23 and EC-24: native availability (I)**
- **EC-23** Claude transcript cleanup (nominally 45 days if the Connect increase is kept; 30-day default if deselected; actual semantics per S9-T6 or UNVERIFIED) — native availability checked independently; Xaibo copy stays; "Transcript only, not resumable"; resume disabled with reason; native expiry shown as an estimate — **I**.
- **EC-24** Native deletion/archive (`claude purge`, `codex delete`/`archive`) — Xaibo copy kept; badge "native deleted/archived"; native files never recreated — **I**.
- Build: `native_available`/`native_archived` check on reconcile; expiry estimate uses the S9 age-basis finding, labeled as an estimate (FR-13).
- Files: `src/service/history/native-availability.ts`, `test/integration/native-availability.test.ts`.
- Test first (I): deleting or archiving the fixture native file keeps Xaibo content; badge and FR-13 label set; resume capability false with a reason; nothing recreated at the native path. Deps: P5-T01.

**P5-T13 — EC-71: session moved or deleted while tailed (I)**
- **EC-71** Session moved/deleted while being tailed — watcher closes cleanly; state updated; no crash loop — **I**.
- Files: `src/service/watch/*` (fixes as exposed), `test/integration/tail-move-delete.test.ts`.
- Test first (I): rename and unlink active tail files under load: handle released (count back to baseline per P4-T10 metrics), availability updated, 0 service restarts within 60 s. Deps: P5-T12.

**P5-T14 — Search and EC-58 (U)**
- Build: scoped, paged FTS5 search (`unicode61`), snippets as text, the 64 KiB per-item coverage note (§5.7); Trash/archived/suppressed per Q-5.3; keyset pages in short read transactions.
- **EC-58** CJK / emoji search — FTS5 `unicode61` baseline; CJK limitation documented; trigram option later — **U**.
- Files: `src/service/search/query.ts`, `test/unit/service/search.test.ts`, CJK limitation note in `docs/plans/xaibo_progress.md`.
- Test first (U): emoji and CJK fixtures give the documented `unicode61` results (incl. the known CJK miss); query escaping prevents FTS syntax errors from user input; cursor progresses. Deps: P5-T01.

**P5-T15 — Storage meter (S-10, US-6, §5.11)** — totals for DB, WAL, FTS/index, content/chunk files, spool, backups, usage snapshots, price provenance; per-table sizes via `dbstat` only if S1 shows it compiled in, else file-level totals plus row counts (Q-5.6); computed in a worker and cached, never on readiness. Files: `src/service/storage/meter.ts`, `test/integration/storage-meter.test.ts`. Test first (I): seeded sizes within tolerance; meter falls after purge plus `incremental_vacuum`. Deps: P5-T07.

**P5-T16 — Clear usage history and EC-105 (U + I + E)**
- Build: confirmed Settings action removing frozen MonthlyUsageTotal and MonthlyQuotaPeak rows (Q-5.8) and durably marking every contribution observed up to confirmation as cleared (excluded from live calculation and future settlement); later usage counts.
- **EC-105** Deletion paths and clearing (Trash then restore, Trash expiry, manual purge, Keep, Clear usage history then restart and later expiry, price-file edit after freeze); cost coverage (mixed frozen/live, unknown prices, parent/child overlap, opaque session estimate spanning months); privacy fixture (no paths/names/account IDs in totals) — Trash/restore leaves totals unchanged; every permanent deletion settles first; Keep does not duplicate; cleared contributions never reappear while later usage counts; frozen cost keeps its price revision; disjoint attributable contributions only, opaque estimates not prorated, partial = known subtotal, none = unavailable; totals contain only opaque keys — **U + I + E**.
- Files: `src/service/usage/clear.ts`, `test/unit/service/monthly-cost.test.ts`, `test/integration/usage-clear.test.ts`, `test/e2e/usage-clear.spec.ts`.
- Test first: U — cost coverage cases. I — clear, restart, expiry → 0 reappearance; price edit leaves frozen rows unchanged; privacy fixture (synthetic home path, profile name, account email/ID canaries) → 0 canary bytes in monthly tables. E — chart reflects Trash/restore (no change), purge (no change), clear (empty, later usage appears).
- Deps: P5-T04, T07, T17.

**P5-T17 — Monthly usage chart UI (US-20, FR-52)** — hand-written SVG in the approved design: each month's value printed visibly; filters by agent and model (model filter excludes quota); metric switch sessions, tokens, `~$` (coverage and price-revision provenance), peak quota % per usage scope (default Q-5.7); labels "month to date", "some details expired", "details expired, totals only"; months before first observation absent, not zero; text/table equivalent; placement per the design (no new top-level workspace). Files: `src/renderer/history/MonthlyChart.tsx`, `src/renderer/history/monthly-view.ts`, `test/unit/renderer/monthly-view.test.ts`, `test/e2e/monthly-chart.spec.ts`. Test first: U — absent ≠ zero; `~` cost with known subtotal; quota separated per scope. E — synthetic multi-month data shows values, labels, filters; table reachable by keyboard. Done: Playwright MCP check. Deps: P5-T06.

**P5-T18 — History UI and settings (US-5, US-6)** — screens per the design: projects/folders, move, pin, archive; Trash with Undo and restore; purge confirm with "not forensic secure erasure"; Re-import for manual suppression; search with coverage note; per-session Keep and purge date; retention settings (Never / N) persisted across restart; storage meter. Lists use Phase 4 `VirtualList` and paged IPC. Files: `src/renderer/history/*.tsx`, `src/renderer/settings/RetentionSettings.tsx`, `test/e2e/history.spec.ts`, `test/e2e/a11y-history.spec.ts`, `test/e2e/visual.spec.ts` (history screens). Test first (E): search, move/pin/archive/Trash/Undo/restore/purge, retention settings plus storage meter, persistence after restart, keyboard-only, focus restoration after confirm dialogs, narrow layouts, missing history baselines. Done: baselines accepted after Claude review; MCP check with 0 console errors. Deps: P5-T01..T17.

**P5-T19 — EC-87: 10,000 sessions / ≥10 GiB DB, M13 on T3 (I + P)**
- **EC-87** 10,000 sessions / ≥10 GiB DB, WAL growth and query pressure — M13; bounded memory, handles and queues; maintenance and query work do not stall live dispatch — **I + P**.
- Build: keyset list and search plans verified with EXPLAIN; `PRAGMA optimize` and `incremental_vacuum` as bounded jobs off readiness; bounded WAL checkpoints; short read transactions.
- Files: `test/integration/large-history.test.ts`, `test/perf/t3.ts`.
- Test first: I — with a light T2 stream live, a concurrent retention batch, `optimize` and `incremental_vacuum` keep dispatch lag and queue age within M14 bounds; every list/search plan uses an index. P — T3: indexed selection → first bounded page p95 ≤300 ms incl. the 200 MB transcript; search → first page p95 ≤500 ms filtered and unfiltered; warm and cold application cache (app restart; OS cache not dropped, Q-5.11); memory bounded.
- Loop: `npm run dist:mac && npm run perf -- --tier=T3`. Done: T3 report (hardware, versions, seed, DB/FTS/index/WAL and snapshot bytes, p95, per-hop). Deps: P5-T11, T14, T18. Owner: miss acceptance.

**P5-T20 — Gate 5** — GS with `npm run perf -- --tier=T0,T1,T3`, rerun of T0/T1 smoke and M12 (schema/migrations changed), M6 = 0 across Phase 5 E2E, repo unchanged, native fixture checksums unchanged; `.handoff/gate5-review.md`. Owner: **Gate 5 stop**.

### EC rows assigned to Gate 5

| EC | Case | Expected (PRD §9.2 summary) | Test | Task |
|---|---|---|---|---|
| EC-21 | Purged session resurrection | Purge covers all derivative copies incl. interrupted chunks; suppression skips rescans/replays; retention suppression clears only on new native activity; manual needs Re-import | I | P5-T07, P5-T08 |
| EC-22 | Retention vs active sessions | Never purge busy/waiting/needs-input, <24 h, Keep; re-import with notice after new native activity; manual stays suppressed | U | P5-T10 |
| EC-23 | Claude transcript cleanup | Native availability independent; copy stays; "Transcript only, not resumable"; resume disabled; expiry as estimate | I | P5-T12 |
| EC-24 | Native deletion/archive | Copy kept; "native deleted/archived"; never recreated | I | P5-T12 |
| EC-58 | CJK / emoji search | `unicode61` baseline; CJK limitation documented | U | P5-T14 |
| EC-66 | Missing title / project | "Untitled" + excerpt and basename in-app only; notifications only after label confirmed | U | P5-T02 |
| EC-71 | Session moved/deleted while tailed | Clean close; state updated; no crash loop | I | P5-T13 |
| EC-87 | 10,000 sessions / ≥10 GiB DB | M13; bounded resources; maintenance doesn't stall dispatch | I + P | P5-T19 |
| EC-99 | 45-day quota expiry, large history | Independent retention; no resurrection/fabrication; indexed queries; M13 with snapshot bytes | I + P | P5-T11 |
| EC-103 | Settlement accounting | One transaction; deltas; once per bucket; totals stable across expiry; keys block double count | U + I | P5-T05 |
| EC-104 | Month and quota semantics | Local month + offset; "month to date"; absent not zero; quota max per scope; model filter excludes quota | U | P5-T06 |
| EC-105 | Deletion paths, clearing, cost coverage, privacy | Trash/restore no change; settle before deletion; cleared never reappear; frozen revision; opaque keys only | U + I + E | P5-T16 |

### Metrics at Gate 5
- **M13 (T3):** selection → first bounded page p95 ≤300 ms incl. 200 MB transcript; search → first page p95 ≤500 ms; warm and cold (app restart) on ≥10,000 sessions / ≥10 GiB with quota history and indexes; actual DB/index/WAL/snapshot bytes (P5-T19, P5-T11).
- **Regression:** M12 and T0/T1 smoke after migrations; M1/M2 dispatch lag during retention/maintenance (EC-87).

### Gate 5 checklist
- [ ] Purge acceptance (P5-T07) GREEN.
- [ ] EC-21, 22, 23, 24, 58, 66, 71, 87, 99, 103, 104, 105 pass.
- [ ] EC-42 regression (P5-T10 DST fixture): retention and Trash expiry use elapsed N × 24 h.
- [ ] History E2E flows pass (search, move/pin/archive/Trash/Undo/restore/purge, Re-import, retention settings plus storage meter, settings persistence); monthly chart E2E (US-20).
- [ ] A11Y and visual baselines for history and chart screens; MCP check 0 console errors.
- [ ] M13 (T3) measured with quota history; regression reruns reported.
- [ ] Native fixture stores byte-identical; app data 0700/0600; repo unchanged; M6 = 0.
- [ ] Monthly tables contain only opaque keys.
- [ ] Pipeline evidence per unit (`security-change` for purge, retention, settlement, clear).
- [ ] GS: Codex review, Claude second review, owner stop.

### Risks (Phase 5)
- **FTS5 deletion** needs original indexed text or `contentless_delete` (SQLite ≥3.43, version from S1); a mismatch leaves orphans.
- **Leftover bytes** in WAL/freed pages; FR-11 makes purge non-forensic; UI copy says so; the byte scan excludes the main DB (Q-5.2).
- **Long settlement transactions** stall the single writer → bounded batches behind live batches; verified by EC-87.
- **Backups** containing a purged session must be deleted or rewritten (Q-5.1); deletion removes a recovery point.
- **T3 corpus cost** → generate once per seed; delete only on owner request.
- **Time-zone bugs** → fixed-TZ matrix (EC-104).
- **Spool rewrite race** with an appending forwarder → rewrite only closed files; active files rely on intake suppression.

### Open questions (Phase 5)
See §6: Q-5.1..Q-5.11.

---

## Phase 6 — Integrations (Gate 6)

**Goal.** User-facing Connect, Disconnect and Uninstall over the Phase 3 FR-32 engine: diff preview (with the default-selected `cleanupPeriodDays` increase), manifest, Add agent, catalog validation and private import, rescan, setup and coverage UI, the Gemini `maxAge` offer (D-19), the default-off statusLine tee opt-in, Settings access to the price-override file, opt-in start-at-login (OQ-P1-16). Real-profile Connect is enabled only when this gate passes (FR-32).

**Branch.** `feat/phase6-integrations`.
**Installs.** None planned; validator per OQ-X6. Caches `npm_config_cache=.cache/npm`, `electron_config_cache=.cache/electron`, `ELECTRON_BUILDER_CACHE=.cache/electron-builder`.
**Maps.** S-01, S-11, S-13 (start-at-login opt-in), S-25, S-27, S-28 (retention offer), S-31 (opt-in UI); FR-01, FR-06, FR-07, FR-30–FR-34, FR-45, §5.12 override, §7.6 (OS login items); SEC5; US-7, US-13; D-2, D-9, D-19; M15.
**Entry criteria.** Gates 0–5 and D passed and merged; FR-32 engine, Claude plugin, Codex hooks, tee engine and generic report ingest exist (Gate 3); detection exists (Gate 1); S4, S5, S11 decisions recorded; the design defines Integrations, Add agent and Settings.

### Ordered tasks

**P6-T01 — Phase setup** — branch, `/graphify`, baseline, progress section; inventory the Phase 3 engine API (plan, preview, apply, verify, manifest) so Phase 6 builds only UI and plan builders on top.

**P6-T02 — Retention offers in the Connect plan (EC-73, EC-90)** — `security-change`.
- **EC-73** `cleanupPeriodDays` already set (higher, lower, managed policy) — preview a default-selected increase to `max(effective value, 45)`; deselectable; never lowers; managed policy wins and is shown; Disconnect restores the prior value (or removes the key if it was absent) only if the Xaibo-owned value is unchanged, else conflict — **U**.
- **EC-90** Gemini `general.sessionRetention.maxAge` unset, lower, higher, managed/system policy, retention disabled — disabled: no change offered, shown as disabled (S11 semantics); otherwise the same previewed, default-selected, deselectable increase to `max(effective, 45d)`; never lowers; policy wins and is shown; restore only an unchanged Xaibo-owned value, else conflict (D-19) — **U**.
- Build: pure plan builders returning preview and manifest entries; effective value resolved across user/managed/system layers per S4/S11; Gemini `maxAge` parsing in the S11-verified format only (if S11 narrowed the offer, the builder returns "not offered" with the reason).
- Files: `src/service/catalog/setup-plans.ts`, `test/unit/catalog/setup-plans.test.ts`, `test/fixtures/synthetic/config/{claude,gemini}/<case>/`.
- Test first (U): table of cases (absent, lower, equal, higher, managed-lower, managed-higher, invalid type, retention disabled, deselected), each followed by Disconnect with the value unchanged and changed. Fails first.
- Loop: `node --test test/unit/catalog/setup-plans.test.ts && npm test`. Deps: P6-T01, S11.

**P6-T03 — Connect, Disconnect, Uninstall service flow with a byte-identical round trip** — `security-change`.
- Build: IPC handlers main → service `previewConnect`, `applyConnect`, `disconnect`, `uninstall`, each through the FR-32 engine. Claude route: plugin via local marketplace with S4-verified subcommands, marker-merge fallback (D-2). Codex hooks then the guided trust step (FR-31; no bypass, no trust writes). Gemini hooks as named entries. Tee as a separate opt-in transaction (FR-45, S-31) with its own preview and manifest path. Uninstall restores every manifest-owned change where unchanged and lists conflicts; deleting history is a separate choice (FR-34).
- Files: `src/service/integrations-ipc.ts` (next to the Phase 3 engine), `src/main/` IPC bridge; fixtures under `test/fixtures/synthetic/config/`: Claude `settings.json` with agent-flow-style hooks and a custom statusLine; Codex `hooks.json` with foreign hooks; `config.toml` with a foreign `notify`; Gemini user `settings.json` with foreign hooks and `general.sessionRetention`.
- Test first (I): `test/integration/integrations/roundtrip.test.ts` — sha256 every fixture, Connect (all offers plus tee), Disconnect, checksums equal; variant: Xaibo-owned value changed in between → conflict, file not overwritten; variant: foreign value changed → survives, Xaibo entries removed; variant: invalid file refused before any write. Fails first.
- Loop: `node --test test/integration/integrations/roundtrip.test.ts`. Done: byte-identical across the whole matrix incl. tee (§9.3 round-trip item). Deps: P6-T02.

**P6-T04 — External uninstall reconcile (EC-26)**
- **EC-26** Plugin uninstalled outside Xaibo / leftovers — reconcile on start shows "disconnected externally"; offer reconnect or cleanup of Xaibo-owned leftovers only — **I**.
- Build: startup reconcile comparing manifest with actual config and plugin state (S4-T6 detection signal). Files: `src/service/integrations/reconcile.ts`, `test/integration/integrations/reconcile.test.ts`. Test first (I): remove the plugin from a temp profile behind Xaibo's back, start the service → `disconnected-externally` and a cleanup offer listing only manifest-owned items; foreign entries checksummed untouched. Deps: P6-T03.

**P6-T05 — Xaibo removed without Disconnect (EC-27)**
- **EC-27** Xaibo deleted without Disconnect — shim exits 0 silently; no visible errors or tokens; manual cleanup documented — **I**.
- Build: confirm the stable shim in `<appdata>/integrations/` exits 0 with zero bytes when its forwarder target or app bundle is missing; write manual cleanup steps (OQ-P6-6). Files: shim under `src/forwarder/`, `docs/integrations/manual-cleanup.md`, `test/integration/forwarder/shim-orphan.test.ts`. Test first (I): delete the forwarder target, pipe a synthetic payload into the shim → stdout/stderr 0 bytes, exit 0. Deps: P6-T03.

**P6-T06 — Agent-flow rewrites (EC-72)**
- **EC-72** Agent-flow later rewrites or removes hooks — Xaibo uses its own command path (never a bare-origin URL) and its own plugin, so it is unaffected — **I**.
- Files: `test/integration/integrations/agentflow-coexist.test.ts`, synthetic agent-flow fixture entries. Test first (I): Connect, rewrite or remove the agent-flow entries, fire a synthetic hook → Xaibo still receives it and its entries are unchanged; fails if reconcile wrongly flags the change or the hook path is shared. Deps: P6-T03.

**P6-T07 — Catalog validation and private import (EC-78)** — `security-change`.
- **EC-78** Invalid/imported catalog; duplicate bundled ID; executable probe — reject invalid or shadowing entries; no execution before a grant; a valid data-only synthetic agent passes M15 — **U + I**.
- Build: validation against `integrations/agents.catalog.schema.json` (catalog schema v1 seeded from S11-T8) with the Gate 0 validator (OQ-X6); unknown fields and unsupported operations fail; import stores entries under app data with IDs that cannot shadow bundled IDs; an executable probe of an imported entry requires an explicit grant (FR-01, SEC5); file references limited to approved profile roots and regular files (escaping symlinks and special files rejected).
- Files: `src/service/catalog/{validate,import}.ts`, `test/unit/catalog/validate.test.ts`, `test/integration/catalog/import.test.ts`, `test/fixtures/synthetic/catalog/{invalid,shadow,probe,symlink-escape}/` (S11-T8 negatives moved here).
- Test first: U — each invalid fixture rejected with a specific reason. I — an import with a probe declaration triggers no spawn before the grant (fake spawner called 0 times, then 1 after, no shell, 3 s timeout). Deps: P6-T01.

**P6-T08 — Add agent flow and rescan (EC-79)**
- **EC-79** Newly installed agent; missing auth; blocked hooks — rescan without restart; installation, auth and connection shown separately; setup steps and actual coverage shown — **I + E**.
- Build: Add agent screen in the approved design: rescan on open (FR-01); detected candidates first; FR-06 states (Detected, Setup required, Awaiting trust, Connected, Partial coverage, Unsupported version, Not detected); copy-only install hints; previewed config change through P6-T03; a receipt test before claiming Connected; blocked hooks as "hooks blocked by policy" (EC-49 detection); auth shown per OQ-P6-3. Gate 0 compatibility-matrix results (S6-T6/S7-T7) carried as catalog capability data per agent version and surface (visible, resumable, attach, ownership; verified/unverified/unsupported), rendered as text in Add agent/Integrations and as a reason string in the session view (e.g. "VS Code history visibility: unverified for <version>"; §2.2, US-8, §9.3).
- Files: `src/renderer/` Add agent view, `src/service/catalog/detect.ts` (rescan IPC), `src/service/catalog/capabilities.ts`, `test/unit/capabilities.test.ts` (capability-to-label mapping), `test/integration/catalog/rescan.test.ts`, `test/e2e/add-agent.spec.ts`.
- Test first: I — a synthetic executable added to the temp PATH after startup is detected by rescan without restart. U — each matrix state maps to its label; an unverified surface never renders as supported. E — hooks-blocked fixture → Partial coverage; no events → "Connected" only after a synthetic receipt; an unverified surface shows its coverage-limit text; keyboard only.
- Loop: `node --test test/integration/catalog/rescan.test.ts && npm run test:e2e -- test/e2e/add-agent.spec.ts`, MCP visual check. Deps: P6-T03, P6-T07.

**P6-T09 — M15 synthetic fourth agent** — no `src/` change; only a catalog entry, report-v1 events and the test. Files: `test/fixtures/synthetic/catalog/fourth-agent/` (entry and event stream, seeded from S11-T8), `test/integration/catalog/m15-fourth-agent.test.ts`. Test first (I): import, detect, preview and apply setup in a temp profile, send report events via `xaibo-report` (lifecycle, `content.upsert` chunks, `usage.snapshot`); detection, setup, full-content storage and status all pass; fails if core paths hard-code agent IDs (that fix is a separate HP unit first; M15 counts only once the final fixture diff touches `test/` alone). Done: green, unit diff lists only `test/` paths (`git diff --name-only` in the progress file). Deps: P6-T07, T08.

**P6-T10 — Integrations page UI** — per-agent Connect/Disconnect with diff preview incl. default-selected, deselectable retention rows; separate default-off tee toggle with its own preview; Uninstall; coverage and trust guidance; conflict display; start-at-login opt-in (Electron `app.setLoginItemSettings`, default off); approved design and A11Y. Files: `src/renderer/` Integrations view, `test/e2e/integrations.spec.ts`. Test first (E, §9.3 "Integrations connect/disconnect with diff preview"): preview shown; deselecting retention removes that row from the applied change; Disconnect restores; conflict shown; start-at-login toggles and persists; keyboard only, focus restored after the dialog, narrow layout. Loop: `npm run test:e2e -- test/e2e/integrations.spec.ts`, MCP check, baselines. Deps: P6-T03.

**P6-T11 — Price-override access in Settings** — reveal (`shell.showItemInFolder`, on the SEC1 reveal allowlist), validate and reload `<appdata>/models.override.json`; invalid edit shows the error and keeps the last valid revision (Gate 2 engine; EC-96 is gated there). Files: `src/renderer/` Settings, `src/main/` reveal handler, `test/e2e/settings-prices.spec.ts`. Test first (E): invalid override + Reload → error, revision unchanged; valid → new revision and "Prices as of" shown. Deps: P6-T01.

**P6-T12 — Real-profile enablement and owner live check** — `security-change`. Remove the dev-CLI-only restriction so Connect may target detected real profiles (effective once the branch merges after Gate 6); the packaged app shows the same diff preview and requires explicit confirmation. Test first (U): target resolution refuses real roots with the "real-profile enabled" build flag off, allows them with a preview when on. The "real-profile enabled" flag stays off on the branch until the Gate 6 merge (FR-32). Owner touchpoint (optional, OQ-P6-1): runs after Gate 6 approval, as P7-T01's first step on the Phase 7 branch — the owner runs Connect then Disconnect on their real profiles in the packaged app; Claude records a local-only checksum manifest before/after (never committed or pasted); only pass/fail goes to the progress file. Deps: P6-T03, T10.

**P6-T13 — Gate 6** — GS plus the checklist. At this gate the temp profiles are retired (§3.2; OQ-B10).

### EC rows assigned to Gate 6

| EC | Case | Expected (summary) | Test | Task |
|---|---|---|---|---|
| EC-26 | Plugin uninstalled outside Xaibo / leftovers | "disconnected externally"; reconnect or owned-leftover cleanup only | I | P6-T04 |
| EC-27 | Xaibo deleted without Disconnect | Shim exits 0 silently; no errors/tokens; manual cleanup documented | I | P6-T05 |
| EC-72 | Agent-flow rewrites/removes hooks | Own command path and plugin unaffected | I | P6-T06 |
| EC-73 | `cleanupPeriodDays` already set | Default-selected increase to max(effective, 45); never lowers; policy wins; conditional restore | U | P6-T02 |
| EC-78 | Invalid/imported catalog; duplicate ID; executable probe | Reject invalid/shadowing; no execution before grant; synthetic agent passes M15 | U + I | P6-T07 |
| EC-79 | Newly installed agent; missing auth; blocked hooks | Rescan without restart; install/auth/connection separate; coverage shown | I + E | P6-T08 |
| EC-90 | Gemini `maxAge` cases | Disabled → no offer; else max(effective, 45d) preview; never lowers; policy wins; conditional restore | U | P6-T02 |

### Gate 6 checklist
- [ ] EC-26 (I), EC-27 (I), EC-72 (I), EC-73 (U), EC-78 (U + I), EC-79 (I + E), EC-90 (U) pass, each with RED output recorded.
- [ ] Config round trip byte-identical where Xaibo-owned values are unchanged, across the full matrix incl. the tee; changed values conflict, never overwrite.
- [ ] M15 measured: fourth agent passes detection, setup, full-content storage and status with a `test/`-only diff.
- [ ] Integrations, Add agent and Settings price E2E green; visual baselines from the approved design; A11Y keyboard/focus/narrow checks pass.
- [ ] M6 clean in every E2E run; M7 config lint: no prompt/agent hook types in any generated config.
- [ ] Native fixture files unmodified (checksums).
- [ ] Temp profiles retired (owner logout, deletion, temp keychain items removed after confirmation).
- [ ] GS steps 0–6.

**Metrics at Gate 6.** M15 (pass/fail per sub-check); M6 from the E2E audit; M7 config lint on generated plugin and hooks; if forwarder or service code changed, re-run T0 (M1, M16).

**Risks.** The Claude CLI's plugin install/uninstall may rewrite `settings.json` formatting or key order, breaking byte identity (OQ-P6-2). A first real-profile write is hard to undo if backup/restore misbehaves (FR-32 backup, owner-run check after Gate 6 with a local manifest, owner decides whether to run it). The Codex trust step makes "one click" feel broken (§11); guided step and files-only coverage remain. Catalog import is an attack surface (validation, no execution before grant, root confinement).

**Open questions.** See §6: OQ-P6-1..P6-3, P6-5, P6-6 (OQ-P6-4 → OQ-X6).

---

## Phase 7 — Control (MVP Gate)

**Goal.** Launch and resume in an external terminal, ownership badges, the concurrency guard, launch-argument safety, launch grants, Open in VS Code, tested generic and Gemini launch/resume; complete M11 (launch portion); the owner verifies US-8 live once; the phase ends at the MVP Gate.

**Branch.** `feat/phase7-control`. **Installs.** None.
**Maps.** S-12, S-16 (stretch), S-28 (launch/resume); FR-13, FR-20–FR-25; SEC1 (`vscode:` allowlist); US-8, US-10 (stretch); D-5, D-8; Q12, Q20; M11.
**Entry criteria.** Gate 6 merged; S6, S7, S11 decisions recorded (resume flags per kind, Desktop-origin resume, Gemini interactive start/resume); design coverage for the launch dialog, concurrency warning and ownership badge, or an approved Codex design delta (OQ-X12).

### Ordered tasks

**P7-T01 — Phase setup** — branch, `/graphify`, baseline, progress section; then the optional owner real-profile Connect/Disconnect check moved from P6-T12 (OQ-P6-1), now that Gate 6 has enabled real-profile Connect.

**P7-T02 — Launch argument safety (EC-76)** — `security-change`.
- **EC-76** Launch/resume argument safety (shell metacharacters, spaces, Unicode in cwd/IDs, stale ownership) — native IDs, executable paths and cwd validated; external-terminal command text assembled only from validated, individually quoted whole-argument tokens (executable path, template arguments, native ID, cwd) and tested with metacharacters; no catalog, transcript or user shell fragment reaches it; probes and embedded/ACP spawns use no shell; stale ownership not treated as control — **U + E**.
- Build: token validators (native-ID patterns per agent, absolute realpath-resolved executable, existing cwd dir); POSIX single-quote quoting per token; whole-argument placeholders; rejection of catalog/user shell or interpreter command strings and package runners.
- Files: `src/main/launch/command.ts`, `test/unit/launch/command.test.ts`, `test/e2e/launch.spec.ts`.
- Test first: U fuzz table (`;`, `$(...)`, backticks, quotes, newlines, `&&`, Unicode, spaces, leading `-`): each token survives a round trip through `sh -c 'printf %s\\0 ...'` as exactly one argument; a transcript-derived string never appears. E — assembled command captured by the stubbed terminal spawner. Deps: P7-T01.

**P7-T03 — Launch grants and revalidation (EC-84)** — `security-change`.
- **EC-84** Changed executable/script/args/environment; shell command string — launch blocked pending a renewed grant; no shell evaluation or implicit package install; observe-only remains — **U + I**.
- Build: private grant record in app data binding the executable realpath and sha256, the relevant script/package entrypoint and sha256, the argument template, approved env keys; revalidated immediately before each execution; provider credentials not inherited without an explicit env grant (Q20); bundled entries ship tested templates (from S11-T7 for Gemini); imported ones need an explicit grant.
- Files: `src/main/launch/grants.ts`, `test/unit/launch/grants.test.ts`, `test/integration/launch/grants.test.ts`.
- Test first: U — each bound field changed in turn → `blocked: renewal required`. I — replace the synthetic executable's bytes in a temp dir → launch blocked, observe-only works. Deps: P7-T02.

**P7-T04 — External-terminal launcher, provisional row, binding (EC-85, M11 launch)**
- **EC-85** Provisional launch row, evidence binding, immediate Stop after launch — M11 launch portion; binding does not duplicate the session; post-Stop behaviour per EC-40 (Gate 3) — **E + P**.
- Build: launch dialog (agent, project, cwd). Claude gets a pre-allocated `--session-id <uuid>` and the interactive CLI, never `-p` (FR-20, D-5); Codex interactive TUI; Gemini and generic per S11/catalog-tested templates. Provisional "Starting…" row with no native identity until evidence binds it (Claude by ID; others per OQ-P7-2). Terminal per OQ-P7-1 via a dependency-injected spawner stubbed in tests.
- Files: `src/main/launch/terminal.ts`, `src/service/` provisional-row projection, `src/renderer/` launch dialog, `test/e2e/launch.spec.ts`, perf scenario `m11-launch` in `test/perf/`.
- Test first: E — stubbed launch paints the provisional row; a synthetic SessionStart with the pre-allocated ID binds it (row count 1); an immediate Stop shows "Finishing…" then settles per EC-40. P — launch action → provisional row painted p95 ≤300 ms, real monotonic clock.
- Loop: `npm run test:e2e -- test/e2e/launch.spec.ts && npm run perf -- --scenario m11-launch`. Done: M11 launch p95 recorded. Deps: P7-T02, T03.

**P7-T05 — Resume and concurrency guard (EC-20)**
- **EC-20** Concurrent resume interleaving — if live elsewhere (recent hook activity or known owner) or uncertain (silence does not prove safety): concurrency warning, offer Open/Fork; lock Xaibo-owned sessions; warn that external clients cannot be locked — **U + E**.
- Build: resume commands `claude --resume <id>`, `codex resume <id>`, the S11-tested Gemini UUID command, in the original cwd with no extra Xaibo flags (FR-21, D-8), per-kind flags from S6/S7 (P2-T04 `resumeArgv`). Native availability first; unavailable → "Transcript only, not resumable" with reason (FR-13). Liveness classifier live/uncertain/not-live (EC-01 rules); live and uncertain show the warning with Open in VS Code or Fork (`--fork-session` / `codex fork`). Xaibo-side lock per OQ-P7-3.
- Files: `src/main/launch/resume.ts`, `src/service/status/` liveness, `test/unit/launch/resume.test.ts`, `test/e2e/resume.spec.ts`.
- Test first: U — recent hook → live; silence → uncertain; known owner → live; second resume while one pending → locked. E — warning choices route correctly, keyboard only. Deps: P7-T04.

**P7-T06 — Ownership badges (FR-23)** — Observed externally / Controlled here / Detached as text plus icon; external-terminal sessions incl. Xaibo-launched ones are "Observed externally"; "Controlled here" reachable from v1-A. Files: `src/service/status/ownership.ts`, renderer badge, `test/unit/status/ownership.test.ts`. Test first: U — never `controlled` from launch origin alone or stale ownership (EC-76 stale case); E — badge visible with accessible label. Deps: P7-T04.

**P7-T07 — Desktop-origin Claude resume (EC-67)**
- **EC-67** Resume of Desktop-origin Claude session — CLI resume from the shared store if S7 confirms; otherwise view-only with the reason — **S7**.
- Build: resume capability per entrypoint from the recorded S7 result; `claude-desktop` resumable or view-only with a reason string. Re-check S7 on the then-current Claude version if it changed since Gate 0 (SG procedure).
- Additional test (U): a fixture with `entrypoint=claude-desktop` yields the S7-decided capability; fails first (no Desktop entry). Files: `src/service/adapters/claude/capabilities.ts`, `test/unit/adapters/claude-capabilities.test.ts`. Done: S7 evidence reference plus green U test. Deps: P7-T05.

**P7-T08 — Gemini and generic tested launch/resume** — catalog launch/resume argument templates for Gemini (S11 evidence) and generic entries; unsupported custom resume disabled with reason (FR-21); no headless Gemini start (FR-20). Files: `src/service/catalog/launch-templates.ts`, `integrations/agents.catalog.json`, `test/unit/catalog/launch-templates.test.ts`. Test first (U): expansion validated by P7-T02 and gated by P7-T03; no tested resume template → disabled reason. Deps: P7-T03.

**P7-T09 — Open in VS Code** — `shell.openExternal('vscode://anthropic.claude-code/open?session=<id>')` with a validated ID, only via the SEC1 allowlist. Files: `src/main/launch/vscode.ts`, `test/unit/launch/vscode.test.ts`. Test first: U — non-UUID ID or any non-`vscode:` scheme rejected; E — stubbed `openExternal` receives the exact URL. Deps: P7-T05.

**P7-T10 — Compare (stretch)** — deferred to v1-B where it is required (OQ-P7-4); built here only if the owner asks, using the V1B-T07 spec.

**P7-T11 — US-8 live verification by the owner** — the owner runs the packaged app as an explicit real-data session (§8); no Playwright or Claude automation touches it. Launch Claude, then Codex, into an external terminal in a throwaway project; confirm the terminal opens in the right cwd running the interactive CLI and the session appears in Xaibo; for Claude check VS Code history only if S7 passed for that version, else the documented coverage limit is shown (P6-T08 capability UI; OQ-P7-6). Evidence: owner pass/fail per agent in the progress file; no IDs, paths or screenshots.

**P7-T12 — MVP hardening sweep** — E2E coverage audit against the §9.3 E2E list (add missing specs); native-file checksum test over fixture stores before/after the full E2E run; app-data permission test (0700/0600); packaged artifact run with no system Node or Docker (`env -i PATH=/usr/bin:/bin`, Docker stopped); `git log -p --all | npm run privacy:scan -- --stdin`; dependency license list and agent-flow NOTICE check; full suite plus perf T0–T3 on a clean clone (`.cache/clean/`, `npm ci`); re-run the P3-T16 helper attempt audit (forwarder, shim, tee, `xaibo-report`, all modes) on the MVP artifact. Files: `test/e2e/native-untouched.spec.ts`, `test/e2e/no-system-runtime.spec.ts` (if missing), progress-file metric table.

**P7-T13 — MVP Gate** — GS plus the checklist.

### EC rows assigned to Gate 7

| EC | Case | Expected (summary) | Test | Task |
|---|---|---|---|---|
| EC-20 | Concurrent resume interleaving | Warning when live/uncertain; Open/Fork; lock Xaibo-owned; external clients cannot be locked | U + E | P7-T05 |
| EC-67 | Desktop-origin Claude resume | CLI resume if S7 confirms; else view-only with reason | S7 | P7-T07 |
| EC-76 | Launch/resume argument safety | Validated whole-argument tokens, quoted; no shell fragments; stale ownership ≠ control | U + E | P7-T02 |
| EC-84 | Changed executable/args/env; shell string | Blocked pending renewed grant; no shell eval or implicit install; observe-only stays | U + I | P7-T03 |
| EC-85 | Provisional launch row, binding, immediate Stop | M11 launch portion; no duplicate; post-Stop per EC-40 | E + P | P7-T04 |

### MVP Gate checklist

*Gate 7 rows*
- [ ] EC-20 (U + E), EC-67 (S7), EC-76 (U + E), EC-84 (U + I), EC-85 (E + P) pass.
- [ ] M11 complete: launch portion (p95 ≤300 ms) reported with the Gate 3 ingestion portion (p95 ≤300 ms); external process start → first signal reported separately.
- [ ] US-8 verified live once by the owner.

*PRD §9.3 acceptance checklist*
- [ ] All MVP §9.2 rows pass or have owner-approved waivers, re-confirmed by gate — Gate 1: EC-01, 03, 04, 08, 13, 14, 15, 16, 18, 19, 33, 35, 38, 39, 45, 47, 55, 60, 61, 62; Gate 2: EC-05, 06, 07, 10, 50, 51, 53, 54, 74, 80, 81, 93, 94, 95, 96, 101; Gate 3: EC-02, 09, 11, 12, 25, 28, 32, 40, 41, 42, 43, 44, 46, 48, 49, 52, 59, 63, 64, 70, 82, 83, 91, 92; Gate 4: EC-56, 57, 86, 97, 100, 102; Gate 5: EC-21, 22, 23, 24, 58, 66, 71, 87, 99, 103, 104, 105; Gate 6: EC-26, 27, 72, 73, 78, 79, 90; Gate 7: EC-20, 67, 76, 84, 85.
- [ ] All shipped §1.5 metrics measured and reported incl. M11–M16 (M10 when MCP ships); misses need explicit owner acceptance; unrun tests are not passes.
- [ ] Add agent and custom reporter, Gemini folding/content/cleanup, launch grants and all assigned perf tiers pass; content coverage and unverified capabilities visible (P6-T08 capability UI).
- [ ] Fixture replay meets §6.7 with B1/B2 reported.
- [ ] Playwright `_electron` E2E covers: first run and detection; Overview live updates; attention queue and notification; session workspace (turns, tools, subagents, files, reasoning); stuck/loop badge; search; move, pin, archive, Trash, Undo, restore, purge; retention settings and storage meter; Integrations connect/disconnect with diff preview; launch/resume in an external terminal (assembled command, spawn stubbed); tray, close, quit; settings persistence.
- [ ] Accessibility: every MVP flow keyboard-operable with visible focus and labeled controls; status as text + icon; focus restoration and narrow layouts tested.
- [ ] Screens follow the approved design (FR-50, Gate D) incl. light/dark; baselines from the implemented design; Playwright MCP check on every screen, console free of errors.
- [ ] Usage status and history, context view, live-set totals and session access pass their tests; all unavailable/estimated/stale labels and aggregate scopes visible.
- [ ] Price-override validation and pinned provenance pass; no price, quota, context, token-count or model request (FR-44).
- [ ] Usage/context/cost enabled in T2 and T3; snapshot/index overhead and affected M1–M16 results reported.
- [ ] Synthetic account identifiers and credentials do not survive in normalized snapshots, logs, diagnostics or fixtures; no real account file used (`usage-account-canary.test.ts`, P3-T15).
- [ ] Zero attempted non-loopback connections in all E2E runs and the S10-style OS audit.
- [ ] Forwarder: 0 output bytes, exit 0, spool works, M16 met.
- [ ] Connect/Disconnect round trip byte-identical when Xaibo-owned values are unchanged (agent-flow hooks, custom statusLine, foreign notify, Gemini `settings.json` with foreign hooks and `general.sessionRetention`); changed values conflict.
- [ ] Native agent files never modified (checksums before/after the full E2E run).
- [ ] App data only in the OS app-data dir with private permissions; repo unchanged after runs.
- [ ] Egress canary tests pass for every shipped path.
- [ ] Secret scan, privacy scan, fixture lint green on the full history.
- [ ] Lint, typecheck, unit, integration, E2E, perf green on a clean checkout.
- [ ] Licenses: agent-flow attribution/NOTICE kept where reused (telemetry removed); no AGPL code copied; dependency licenses listed.
- [ ] Before going public: tracked under Public release (not required here).

*PRD §1.6 Definition of Done*
- [ ] 1. Every P0 item in §3.1 implemented (S-01–S-15, S-25, S-27–S-29, S-31, S-32, S-34, S-35, S-36).
- [ ] 2. Every MVP §9.2 row has a passing automated test or an owner-approved written waiver.
- [ ] 3. Every §9.3 item checked.
- [ ] 4. All shipped §1.5 metrics measured and reported in `docs/plans/xaibo_progress.md`; misses owner-accepted.
- [ ] 5. Every gate passed with Codex review, Claude second review, owner stop (Gate D: Claude review then owner approval).
- [ ] 6. The macOS MVP artifact runs without system Node or Docker and makes zero non-loopback connections; dev and build dependencies separate.
- [ ] 7. Privacy checks green.

**Metrics at the MVP Gate.** M1–M9 and M11–M16 re-run on a clean checkout on the reference Mac with hardware, macOS, versions, seed, DB/index sizes: M1, M2, M11, M16 on T0; M3 on T1; M12, M14 on T2; M13 on T3; M4, M5 from process sampling; M6 from the E2E audit plus the S10-style audit, including the helper audit (P7-T12); M7 from forwarder tests and config lint; M8 from replay; M9 from the canary suite.

**Risks.** External-terminal launch passes command text through a terminal (FR-25): quoting bugs mean injection → EC-76 fuzzing, whole-argument tokens only. Binding provisional rows without pre-allocated IDs can duplicate or mis-merge (OQ-P7-2). Executables are often symlinks to scripts whose identity changes each agent update → frequent grant renewals (expected friction). The full MVP re-run may surface late regressions → rerun affected tiers at every gate.

**Open questions.** See §6: OQ-P7-1..P7-6 (OQ-P7-7 → OQ-X12).

---

## v1-A — Embedded terminal, Codex app-server control, ACP

**Goal.** S2 PTY spike first; then the embedded terminal (FR-24), Codex app-server control for Xaibo-owned threads (S-22, per S6), capability-negotiated ACP start/load/resume for Xaibo-owned compatible agents (S-30). No self-installing registry distributions.

**Branch.** `feat/v1a-embedded-terminal`; S2 code in `spikes/s2-pty/`.
**Installs** (owner approval, exact pins): `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`. Native rebuild for the Electron ABI via electron-builder `install-app-deps` with `npm_config_devdir=.cache/node-gyp`. No ACP library (OQ-V1A-1). A missing native toolchain → stop and ask (OQ-V1A-5).
**Maps.** S-20, S-22, S-30; FR-21 (ACP), FR-24, FR-25; §5.3 app-server; §6.3 app-server rows; §5.5 precedence; US-8 (embedded); Q3; App. E #4, #7, #21.
**Entry criteria.** MVP Gate passed and the owner decides to start v1; S6 results recorded; design delta for the terminal panel and "Controlled here" approved (V1A-T02).

**V1A-S2-T1 — S2 PTY spike** (SG procedure, §3.2) — minimal packaged Electron app in `spikes/s2-pty/` (node-pty in main, xterm in renderer, electron-builder): input, resize, Unicode (CJK, emoji), Ctrl-C, child exit, window close and reopen with the PTY surviving, Quit with no orphans (process table after Quit); run with `/bin/sh`, optionally a Claude TUI in a temp profile. Test first (S): checklist script asserting each criterion; fails first. Done: S2 section in `phase0_spikes.md` with pass/fail and prebuild vs local-compile result (App. E #7). Owner: reviews S2 before any `src/` work.

**V1A-T02 — Design delta** — Codex authors the terminal panel, PTY-live Quit warning and "Controlled here" state; Claude reviews; owner approves. Files: `docs/design/xaibo-design.md` delta.

**V1A-T03 — PTY host in main (EC-69)** — `security-change`.
- **EC-69** Embedded terminal: exit, resize, Unicode, Ctrl-C, window close — PTY in main survives window close; resize and Unicode correct; Quit warns — **E (v1)**.
- Build: `src/main/pty/` owns PTYs; argument-array spawns, no shell, reusing P7-T02 tokens and P7-T03 grants; IPC for data, resize, exit; survives window close; Quit warns if any PTY is live; sessions spawned this way are "Controlled here".
- Files: `src/main/pty/host.ts`, `src/renderer/terminal/` (xterm, addon-fit; output as terminal text, CSP-compatible; WebGL addon deferred), `test/e2e/embedded-terminal.spec.ts`.
- Test first (E): synthetic echo program; type, resize, Unicode, Ctrl-C (interrupt seen), exit, close/reopen (output continues), Quit (warning, then no orphans). Loop: `npm run build && npm run test:e2e -- test/e2e/embedded-terminal.spec.ts`, MCP check. Deps: V1A-S2-T1, T02.

**V1A-T04 — Ownership and status precedence for owned channels** — owned channels (embedded PTY, app-server, ACP) ranked above hooks (§5.5); interrupt only on owned channels; EC-01 pid rules still apply. Test first (U): replay fixtures where owned-channel evidence beats a conflicting hook and a delayed event does not regress. Files: `src/service/status/`, `test/unit/status/precedence.test.ts`. Deps: V1A-T03.

**V1A-T05 — Codex app-server control (EC-68)** — `security-change`.
- **EC-68** App-server thread started by Xaibo not visible in Codex Desktop / VS Code — per S6: if hidden, start as the interactive TUI (source `cli`) or show a documented coverage limit; MVP external-terminal launches already use the TUI (FR-20, EC-76) — **S6 + I, v1-A**.
- Build: Xaibo spawns `codex app-server` (stdio JSON-RPC): `thread/start|resume|fork|list|read|loaded/list`, `turn/start|interrupt`; notifications drive status per §6.3 app-server rows; `notLoaded` = detached; approval and user-input requests go to the UI, answered only by the owner; bindings from `codex app-server generate-ts` on the pinned CLI (OQ-V1A-2); fixtures pinned to the same version.
- Files: `src/service/adapters/codex/appserver/`, `test/integration/codex/appserver.test.ts` (scripted fake app-server, synthetic messages from the pinned schema).
- Test first (I): start a thread; `thread/status/changed` active then waitingOnApproval; UI request appears; owner approves; turn completes; "Finishing…" settles; the S6 hidden-visibility case routes to TUI fallback or the coverage-limit label. Live check (SG): one tiny thread in a temp `CODEX_HOME`, reduced to message-type schemas. Deps: V1A-T04, S6.

**V1A-T06 — ACP client (EC-88)** — `security-change`.
- **EC-88** ACP missing load/resume capability, permission request, replay — disable unsupported actions; no claim of attaching to external sessions; permission needs owner action; replay idempotent — **I, v1-A**.
- Build: hand-written JSON-RPC client over stdio (`node:readline`), limited to approved local executables declared in the catalog (ACP declaration v1-only, §7.3); capability negotiation; start/load/resume only when advertised; permission requests need owner action; replay joins on native IDs; uncertain correlations stay separate with a coverage warning (§5.5). Agents per OQ-V1A-3.
- Files: `src/service/adapters/generic/acp.ts`, `test/integration/generic/acp.test.ts` (fake ACP agent).
- Test first (I): no `load` capability → Load disabled with reason; permission request unanswered until owner acts; replaying the same updates twice → identical projection. Deps: V1A-T04.

**V1A-T07 — Embedded launch and resume UI** — dialogs offer "Embedded terminal" next to "External terminal" (external default, OQ-V1A-4), reusing P7 validators and grants; EC-20 guard applies, with a real lock for "Controlled here" sessions. Test first (E): embedded resume of an owned session, then a second attempt blocked by the lock. Files: `src/renderer/`, `test/e2e/embedded-launch.spec.ts`. Deps: V1A-T03.

**V1A-T08 — v1-A gate** — GS.

**v1-A gate checklist**
- [ ] S2 passed and recorded.
- [ ] EC-68 (S6 + I, v1-A), EC-69 (E (v1)), EC-88 (I, v1-A) pass.
- [ ] MVP regressions green, especially EC-20, EC-76, EC-84 with embedded spawns.
- [ ] M6 audit attributes by process tree: Xaibo processes (main, service, renderer, forwarder) 0 attempts; agent children (PTY, app-server, ACP) outside the guarantee (P2), reported separately.
- [ ] Visual baselines for the terminal panel; A11Y: focus-trap escape and labeled controls.
- [ ] GS complete; licenses recorded for `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`.

**Metrics.** M1 and M11 on T0 incl. app-server and ACP status paths; M4, M5 with one live PTY; M6 as above; M14 (T2) if dispatch code changed.
**Risks.** No node-pty prebuild for the Electron ABI forces a local toolchain (App. E #7); orphaned PTY children after a crash; app-server schema drift (pinning, generated bindings); ACP mistaken for external-session observation (§11) → capability negotiation, no attachment claims.
**Open questions.** See §6: OQ-V1A-1..V1A-5.

---

## v1-B — OTLP receiver, Compare, notify wrapper, categories, inspector

**Goal.** S8 OTLP spike first; then the opt-in OTLP/HTTP JSON receiver (S-19); OTel exporter setup preserving existing exporters; generic GenAI and Gemini OTLP mapping; Compare (S-16, US-10); the opt-in Codex notify wrapper (S-18); estimated context category composition (S-33); the Skills/MCP inspector (S-17, FR-35).

**Branch.** `feat/v1b-otlp-compare`; S8 code in `spikes/s8-otlp/`.
**Installs** (approval, exact pin): `smol-toml` (validates Codex `config.toml` after marker-delimited text insertion; never re-serializes, §7.6).
**Maps.** S-16, S-17, S-18, S-19, S-33; FR-35, FR-46–FR-48, §5.11 categories, §5.12, §6.5, §6.9 Compare; SEC2 (OTLP); P2 lint exception for the receiver; US-10; D-7, D-13; App. E #9, #10, #15, #21, #25; M9 (OTLP).
**Entry criteria.** v1-A gate passed (OQ-V1B-5); design deltas for Compare, inspector and OTel/notify opt-ins approved (V1B-T02).

**V1B-S8-T1 — S8 OTLP spike** (SG) — tiny loopback JSON receiver in `spikes/s8-otlp/` (`node:http`), temp profiles for Claude (user-settings `env`), Codex (`[otel]`, `protocol = "json"`, explicit `metrics_exporter`), Gemini (telemetry settings); owner signs in. Verify actual config syntax, auth header support, signal paths, payload shapes, flush behaviour, existing-exporter preservation, that dollar fields are agent estimates (D-13); whether a verified provider-billed amount exists locally (App. E #15); Gemini token-header support. Test first (S): criteria checklist script. Done: S8 section in `phase0_spikes.md` (payload schemas only). Owner: reviews S8 before `src/` work.

**V1B-T02 — Design deltas** — Codex designs Compare, the inspector, the OTel and notify opt-in rows; Claude reviews; owner approves.

**V1B-T03 — OTLP receiver (EC-77, EC-31)** — `security-change`.
- **EC-77** Malicious local request / DNS rebinding / browser POST to the OTLP receiver — reject an Origin header, non-exact loopback Host, bad token, body >1 MB, wrong content-type — **U + I (v1)**.
- **EC-31** OTLP port conflict — next free port in range; agent config updated through the manifest with consent; never kill other processes; hooks unaffected (socket) — **I (v1)**.
- Build: `src/service/receivers/otlp.ts` on `node:http`: loopback only; per-install token header (0600 token file); exact loopback `Host`; any `Origin` rejected; `application/json` only; streamed body with a 1 MB cap; `/v1/logs`, `/v1/metrics`, `/v1/traces`; port scan over a fixed range (OQ-V1B-1); a port change proposed as an FR-32 transaction needing consent; the P2 lint rule allows HTTP server APIs only in this module.
- Files: `src/service/receivers/otlp.ts`, `test/unit/receivers/otlp.test.ts`, `test/integration/receivers/otlp.test.ts`.
- Test first: U — request-validation table. I — occupy the first port, start Xaibo → binds the next; the other listener survives; config-update preview offered; a socket hook delivery still works. Deps: V1B-S8-T1.

**V1B-T04 — OTel exporter setup (EC-30)** — `security-change`.
- **EC-30** OTel exporter already configured — detected; never replaced without an explicit choice; consequences explained; Codex `metrics_exporter` set explicitly — **I (v1)**.
- Build: separate opt-in FR-32 transactions: Claude `env` keys in user `settings.json` (§5.2), content-logging flags off; Codex marker-delimited `[otel]` block validated with `smol-toml` (`log_user_prompt` and `log_agent_responses` off); Gemini telemetry settings; each bound to an agent/profile registration (§5.5). Producers per OQ-V1B-2; Gemini per OQ-V1B-3.
- Files: `src/service/catalog/setup-plans.ts` (OTel plans), `test/integration/integrations/otel-setup.test.ts`, fixtures with a pre-existing exporter.
- Test first (I): existing exporter → preview defaults to "keep existing"; replacement needs an explicit choice; round trip byte-identical; Codex block always has `metrics_exporter`. Deps: V1B-T03.

**V1B-T05 — Generic GenAI and Gemini OTLP mapping (EC-89)**
- **EC-89** Generic GenAI telemetry without content/session identity; exporter conflict — coverage explicit; no guessed session correlation; existing exporter preserved; full local content via a verified channel or an incomplete warning — **I, v1-B**.
- Build: `src/service/adapters/generic/otel.ts`: binds agent/profile via the registration, never `service.name` alone; correlates only on reliable conversation identity, never timestamp proximity, else stored uncorrelated; never drives status; usage precedence §5.5.
- Files: `test/integration/generic/otel.test.ts`, `test/fixtures/synthetic/otel/`. Test first (I): payloads without session ID stored uncorrelated with a coverage flag; no session's row count changes. Deps: V1B-T03.

**V1B-T06 — Codex notify wrapper (EC-29)** — `security-change`.
- **EC-29** Existing Codex notify — opt-in wrapper invokes the original argv with the original JSON appended, no shell string; restore; conflict detection — **U (v1)**.
- Build: wrapper in the packaged forwarder runtime: captures the notify JSON over the private path, execs the original argv array with the JSON as the final argument, preserves exit status; marker-delimited `config.toml` insertion validated by `smol-toml`.
- Files: `src/forwarder/notify-wrapper.ts`, `test/unit/forwarder/notify-wrapper.test.ts`. Test first (U): original argv gets exactly its arguments plus the JSON; no `sh -c`; capture failure still runs the original; restore removes the wrapper; changed value → conflict. Deps: V1B-T04.

**V1B-T07 — Compare (S-16, US-10)** — per agent, model, project and time range, the §6.5 metrics each with its own coverage %; badge below 80% coverage; no imputation; §5.5 token normalization; estimated cost per §5.12 (`~`, known subtotal, no prorating opaque totals); account-scope quota histories shown separately; label "observed workload, not a quality benchmark"; hand-written SVG. Files: `src/service/` compare queries (bounded, indexed, in a worker), `src/renderer/` Compare view, `test/unit/compare/aggregate.test.ts`, `test/e2e/compare.spec.ts`. Test first: U — mixed coverage: missing values unavailable not 0; Codex cached not added on top of input; parent cost incl. children not double-counted. E — filters, coverage badge, estimate label, keyboard. Deps: V1B-T02.

**V1B-T08 — Estimated category composition (EC-98)**
- **EC-98** Category records missing/duplicated/deferred; estimates exceed total; buffer settings unknown — no duplicate or deferred occupied-token count; exactness only from complete inventory evidence; residual/mismatch/unavailable per §5.11; no forced normalization or API call — **U + I, v1-B**.
- Build: bounded worker job: UTF-8 bytes / 4 labeled `~est`; "Messages/residual ~est" only with sufficient coverage, else "Unattributed used"; estimates over the reported total → composition omitted with a mismatch flag; deferred definitions listed separately; buffer only from a version-tested formula; no model or API calls (FR-44). Inputs from S13-T9.
- Files: `src/service/workers/categories.ts`, `test/unit/context/categories.test.ts`, `test/integration/context/categories.test.ts`. Test first: U — duplicated skill/instruction text counted once; deferred tools excluded; over-total → mismatch, no rescaling. I — dispatch latency unaffected during a job (EC-100 regression). Deps: V1B-T02.

**V1B-T09 — Skills/MCP inspector (S-17, FR-35)** — labels configured / loaded/connected / called/activated / Unknown, each only from matching config, runtime or invocation evidence; a text mention proves nothing. Files: `src/service/inspector.ts`, `test/unit/inspector/evidence.test.ts`, renderer view, `test/e2e/inspector.spec.ts`. Test first (U): skill name only in a prompt → Unknown; invocation record → called; config without runtime evidence → configured. Deps: V1B-T02.

**V1B-T10 — OTLP egress canaries (M9)** — additional U test: canaries in OTLP payloads never appear in logs, diagnostics bundles or receiver error responses (all through `sanitize()`; EC-35 registry extended). Files: `test/unit/egress/otlp-canary.test.ts`. Deps: V1B-T03.

**V1B-T11 — v1-B gate** — GS.

**v1-B gate checklist**
- [ ] S8 passed and recorded.
- [ ] EC-29 (U (v1)), EC-30 (I (v1)), EC-31 (I (v1)), EC-77 (U + I (v1)), EC-89 (I, v1-B), EC-98 (U + I, v1-B) pass.
- [ ] Egress canaries cover OTLP (M9); inspector evidence rules tested.
- [ ] Compare E2E green with baselines.
- [ ] Config round trip byte-identical for OTel and notify transactions.
- [ ] Receiver binds loopback only (bind address asserted); M6 = 0.
- [ ] GS complete; license recorded for `smol-toml`.

**Metrics.** M9 (OTLP canaries), M6; M1, M2, M14, M16 on T0 and T2 with OTLP ingestion and category jobs enabled (EC-100 conditions); M4, M5 with the receiver idle.
**Risks.** First network listener: DNS-rebinding/browser POST (EC-77) is the main threat; keep the lint exception narrow. Replacing a user's exporter breaks their telemetry → never without explicit choice. Category estimates read as exact `/context` output (§11) → `~est`, no accuracy claim. Codex OTel coverage of exec/app-server/IDE sessions unverified (App. E #9).
**Open questions.** See §6: OQ-V1B-1..V1B-5.

---

## v1-C — Xaibo MCP server

**Goal.** Opt-in stdio MCP server `xaibo-mcp` with four grant-scoped, size-capped read tools (`sessions`, `session`, `search`, `usage`) and an optional confirmation-gated `control` tool, with labeled estimates and scoped usage history; S10 re-run with the MCP process.

**Branch.** `feat/v1c-mcp`; S10 re-run code in `spikes/s10-mcp/`.
**Installs.** None by default (hand-written JSON-RPC, OQ-V1C-1); `@modelcontextprotocol/sdk` only if the owner chooses it.
**Maps.** S-21; FR-40–FR-43; P1, P3; US-11, US-12; §11 (MCP leakage, authorization gap); M6, M9, M10.
**Entry criteria.** v1-B gate passed; design delta for MCP registration, grant editor, disclosure text and token-overhead display approved (V1C-T02); the S3 packaged runtime available for the `xaibo-mcp` entrypoint.

**V1C-T01 — Phase setup** — branch, `/graphify`, baseline, progress section.

**V1C-T02 — Design delta** — Codex designs the MCP section on Integrations: per-agent and per-project registration, grant editor (agents, profiles, projects, plus a separate usage-scope grant), the P1 disclosure shown before enabling, the M10 token overhead, the control toggle; Claude reviews; owner approves.

**V1C-T03 — stdio server skeleton and read-only DB (FR-42)** — `security-change`. `src/mcp/server.ts` handles `initialize`, `tools/list`, `tools/call`, `ping` over stdio; DB opened read-only; packaged `xaibo-mcp` on the S3 runtime (no system Node); `tools/list` advertises 4 tools, plus `control` only when enabled. Test first (U): handshake; tool count 4 (5 with control); a write through the DB handle fails. Files: `test/unit/mcp/server.test.ts`. Deps: V1C-T01.

**V1C-T04 — Grants (EC-75)** — `security-change`.
- **EC-75** MCP grant enforcement (ungranted project/agent/profile, widening filters, revocation while the app is quit, Trash and suppressed sessions) — denied before querying; filters cannot widen the grant; revocation honored offline; Trash/suppressed excluded from results, counts and aggregates; account-level usage history denied without a usage-scope grant even when project grants exist — **U + I (v1)**.
- Build: one grant record per registration in a private 0600 file (OQ-V1C-5), re-read on every call; check before any query; filters intersected, never unioned.
- Files: `src/mcp/grants.ts`, `test/unit/mcp/grants.test.ts`, `test/integration/mcp/grants.test.ts`. Test first: U — widening-filter table. I — revoke while quit, call → denied; Trash/suppressed absent from `sessions`, `search` counts, `usage` aggregates; `usage` history without a usage-scope grant → denied. Deps: V1C-T03.

**V1C-T05 — Read tools and caps (EC-34)**
- **EC-34** MCP result size caps — ≤8 KiB always, measured after sanitization and serialization incl. metadata and errors, even for one huge item; truncated flag plus a progressing cursor — **U (v1)**.
- Build: four tools per FR-40/FR-41: page size 20, item text ≤500 chars, snippets ≤200 chars; final cap check on serialized sanitized bytes; `truncated` flag; forward-only cursor; every monetary value carries `estimated: true`, USD, basis, coverage, `as_of`, price revision/date; unavailable amounts null with reason.
- Files: `src/mcp/tools/{sessions,session,search,usage}.ts`, `test/unit/mcp/caps.test.ts`, `test/unit/mcp/usage-metadata.test.ts`. Test first (U): a single 200 MB item, error payloads and maximal metadata each ≤8192 bytes after `sanitize()` and `JSON.stringify`; cursor moves forward every page; cost results carry all metadata fields. Deps: V1C-T04.

**V1C-T06 — Offline behaviour (EC-65)**
- **EC-65** MCP called while Xaibo is not running — read tools return timestamped history with `as_of` and live state unavailable; control returns "app not running", no action — **I (v1)**.
- Files: `test/integration/mcp/offline.test.ts`. Test first (I): service stopped: `sessions` returns `as_of`, live state unavailable; `control` → "app not running"; no IPC or side effect. Deps: V1C-T05.

**V1C-T07 — Prompt-injection handling (EC-36)**
- **EC-36** Prompt injection inside content returned via MCP — returned as labeled data; minimal excerpts; control tool off by default — **U (v1)**.
- Files: `test/unit/mcp/injection.test.ts`. Test first (U): instruction-like content wrapped as labeled data within excerpt limits; `control` absent from `tools/list` by default. Deps: V1C-T05.

**V1C-T08 — Control tool** — `security-change`. `control` (resume or interrupt of Xaibo-owned sessions) via authenticated local IPC to the running service (OQ-V1C-3); each exact request shown in the Xaibo UI for confirmation; ownership rechecked immediately before execution; no service or no confirmation → no action (FR-42). Test first: U — rejected without confirmation; rejected if ownership changed between confirmation and execution. E — confirmation dialog shows the exact request. Files: `src/mcp/tools/control.ts`, `src/service/` IPC handler, `test/unit/mcp/control.test.ts`, `test/e2e/mcp-control.spec.ts`. Deps: V1C-T05, v1-A ownership.

**V1C-T09 — Registration (EC-37)** — `security-change`.
- **EC-37** MCP opt-in writing into a user repo (`.mcp.json`) — local/user scope only; repo files never written — **I (v1)**.
- Build: FR-32 transactions at local/user scope for Claude, Codex (marker block in `config.toml`, `smol-toml`-validated) and Gemini (user `settings.json`) (OQ-V1C-4); hooks plugin kept separate so hooks add no tool-definition tokens (FR-43); Integrations UI shows the P1 disclosure and M10 overhead before enabling.
- Files: `src/service/catalog/setup-plans.ts` (MCP plans), `test/integration/mcp/registration.test.ts`, `test/e2e/mcp-optin.spec.ts`. Test first (I): register with a temp project dir as cwd → no file created or changed under the project (recursive checksum), only user-scope files changed, round trip byte-identical. Deps: V1C-T02.

**V1C-T10 — MCP egress canaries (M9)** — additional U: canaries in stored content never appear in any MCP response incl. errors; the MCP path joins the EC-35 registry. Files: `test/unit/egress/mcp-canary.test.ts`. Deps: V1C-T05.

**V1C-T11 — S10 re-run with the MCP process** (SG) — register the packaged `xaibo-mcp` in temp profiles; the agent calls each read tool once with tiny prompts; exercise startup, idle, errors, shutdown under the OS-level audit (reusing `spikes/s10/` with `spikes/s10-mcp/` scenarios). Done: zero attempted non-loopback connections from `xaibo-mcp` and all Xaibo processes; S10-MCP section in `phase0_spikes.md` (aggregates only); the real tool-definition token delta from the agent's own `message.usage` recorded for M10 (OQ-V1C-2). Deps: V1C-T09.

**V1C-T12 — v1-C gate** — GS.

**v1-C gate checklist**
- [ ] S10 re-run with the MCP process clean.
- [ ] MCP path in the `sanitize()` and canary set; M6 and M9 re-measured with it.
- [ ] EC-34 (U (v1)), EC-36 (U (v1)), EC-37 (I (v1)), EC-65 (I (v1)), EC-75 (U + I (v1)) pass, incl. cost metadata, coverage and history grants.
- [ ] M10: 4 read tools (+ `control` only when enabled); every response ≤8 KiB after sanitization and serialization; tool-definition overhead shown before opt-in.
- [ ] MCP opt-in E2E green with disclosure visible; baselines added.
- [ ] GS complete; license recorded if the SDK was chosen.

**Metrics.** M10 (tool count from `tools/list`; max response bytes across the cap suite and fuzzed queries; token overhead per OQ-V1C-2); M6 (S10 re-run plus E2E audit); M9 (canary suite incl. MCP).
**Risks.** Confidential data leaks through MCP answers to the cloud provider (§11; masking best effort) → disclosure, minimal excerpts, canaries. Authorization gap → per-call grant checks, offline revocation. Hand-written protocol drift → V1C-T11 live registration; SDK fallback with approval.
**Open questions.** See §6: OQ-V1C-1..V1C-5.

---

## v1-D — Windows, then Linux

**Goal.** Windows 10 1809+ builds (ConPTY), then Linux, with no system runtime; EC-17 on Windows; full E2E per OS.

**Branch.** `feat/v1d-cross-platform`; Windows first; Linux after the owner checks the Windows checkpoint (OQ-V1D-6).
**Installs.** None new; `electron-builder` covers `dist:win`/`dist:linux`; node-pty rebuilt per OS (App. E #7); any OS-level toolchain needs approval (OQ-V1D-4).
**Maps.** S-23; Portability; P1 (per-user ACL); SEC2 (named pipe); FR-24 (ConPTY), FR-25 (platform quoting); §5.7 win32 comparison key; §7.5 paths; Q4; App. E #12.
**Entry criteria.** v1-C gate passed; build hosts decided (OQ-V1D-1).

**V1D-T01 — Windows platform layer and paths (EC-17)** — `security-change`.
- **EC-17** Windows paths (drive letters, `\`, case-insensitive, UNC, `\\?\`) — win32 comparison key; original preserved; tests via `path.win32` — **U (v1 on Windows)**.
- Build: comparison key = realpath + NFC + lowercase + `/`; `%APPDATA%\Xaibo\` with per-user ACL; per-user named-pipe transport with private ACL from creation, framing and deadlines; Windows profile roots; GUI PATH detection equivalents (EC-38/EC-39 regression).
- Files: `src/shared/paths.ts`, `src/service/` transport, `test/unit/paths/win32.test.ts`, `test/integration/transport/named-pipe.test.ts`. Test first: U — drive-letter, UNC, `\\?\`, mixed-case table; originals preserved. I (Windows) — pipe rejects another user; EC-32 checks hold. Loop (Windows host): `npm test`.

**V1D-T02 — Windows terminal, PTY, launch** — `security-change`. External terminal launcher with Windows quoting (OQ-V1D-2); EC-76 fuzzing re-run with cmd and PowerShell metacharacters; ConPTY via node-pty; S2 repeated on Windows. Test first (U): Windows quoting fuzz table; then the S2 checklist. Files: `src/main/launch/terminal-win.ts`, `test/unit/launch/command-win.test.ts`, S2 Windows section in `phase0_spikes.md`.

**V1D-T03 — Windows packaging and full E2E** — `npm run dist:win` (unsigned; SmartScreen warning documented); full `npm run test:e2e` on Windows; S10 audit with Windows tooling; perf tiers reported (OQ-V1D-3). Done: all E rows green; S10 clean. Owner: checks the Windows checkpoint.

**V1D-T04 — Linux platform layer** — `${XDG_CONFIG_HOME:-~/.config}/Xaibo/`; Unix socket permissions; inotify limits with polling fallback (EC-18/EC-19 regression); external terminal launcher (OQ-V1D-2); `npm run dist:linux` (AppImage, OQ-V1D-5); S2 repeated on Linux. Test first (I): watcher-limit fault injection recovers within interval + 1 s.

**V1D-T05 — Linux full E2E** — full `npm run test:e2e`, S10 audit, perf report.

**V1D-T06 — v1-D gate** — GS.

**v1-D gate checklist**
- [ ] EC-17 (U (v1 on Windows)) passes on Windows.
- [ ] Full E2E green on Windows and Linux.
- [ ] S2 repeated per OS; S10 audit clean per OS.
- [ ] Private permissions or ACL verified per OS.
- [ ] Unsigned-build behaviour documented.
- [ ] GS complete.

**Metrics.** M1–M16 run and reported per OS with hardware; targets bind only on the reference Mac unless the owner decides otherwise (OQ-V1D-3); M6 = 0 on every OS.
**Risks.** node-pty Windows builds may need machine-wide Visual Studio Build Tools (App. E #7); cmd vs PowerShell quoting; private-repo CI minute limits may cost money (App. E #12); inotify limits; named-pipe ACL must be private from creation.
**Open questions.** See §6: OQ-V1D-1..V1D-6.

---

## Public release (optional)

**Goal.** Make the repo safe and legally clean to publish, and decide on signing. The owner decides whether and when (Q5).
**Branch.** `chore/public-release`. **Installs.** None.
**Maps.** P5, §9.3 last item, Q2/D-11 (revisit DB encryption), Q5, §3.2 (signing out of scope until public), App. D licensing (D-6).
**Entry criteria.** The owner asks to prepare a public release, after the MVP Gate at the earliest.

- **PUB-T01 — Sanitizer pass over the full history and docs** — `scripts/privacy-scan` and fixture lint over `git log -p --all`, all `docs/`, fixtures, screenshots and visual baselines in the tree. Test first (R): a synthetic canary commit on a throwaway local clone in `.cache/` is caught. Done: zero findings on the real history. If anything is found: stop; history rewrite or force-push needs explicit owner confirmation (OQ-PUB-2).
- **PUB-T02 — License audit** — license of every dependency from package metadata; agent-flow attribution and NOTICE present where reused (telemetry removed); no AGPL code copied (clean-room harp). Done: license list committed under `docs/`.
- **PUB-T03 — Signing and notarization decision** — options (unsigned, ad-hoc, Developer ID with notarization; Windows Authenticode) with cost and effort; owner decides; revisit DB encryption at rest (Q2/D-11, OQ-PUB-4); project license (OQ-PUB-3).
- **PUB-T04 — Owner sign-off** — owner reviews PUB-T01..T03; changing repo visibility is an owner action, never Claude's.

**Gate checklist**
- [ ] §9.3 last item: sanitizer pass over full history and docs, license audit, owner sign-off.
- [ ] Signing decision and Q2 encryption decision recorded.
- [ ] Codex review → Claude second review → owner decision (GS steps 3–6).

**Risks.** Real data in old commits removable only by a history rewrite (outward-facing, irreversible once pushed); a missing NOTICE; signing costs money.
**Open questions.** See §6: OQ-PUB-1..PUB-4.

---

## 5. Traceability appendix

### 5.1 Edge-case catalog (EC-01..EC-105) → gate → task

Gate assignment fixed by PRD §10. Test type copied from PRD §9.2. Phase 0 spike inputs are listed in §0.18.

| EC | Case (short) | Test (§9.2) | Gate | Task |
|---|---|---|---|---|
| EC-01 | Stale pid / pid reuse | U (fake process table) | 1 | P1-T11 |
| EC-02 | Sessions started before hooks / first run | I | 3 | P3-T08 |
| EC-03 | `.jsonl.zst` history | U + S9 | 1 | P1-T10 (S9 half: P0-S9-T5) |
| EC-04 | Format drift on agent upgrade | U | 1 | P1-T09 |
| EC-05 | Multiple entrypoints | U | 2 | P2-T04 |
| EC-06 | Worktree relocation | I | 2 | P2-T05 |
| EC-07 | Same repo open twice | I | 2 | P2-T05 |
| EC-08 | Clock skew | U | 1 | P1-T09 |
| EC-09 | Duplicate events (agent-flow, plugin+fallback, spool replay) | I | 3 | P3-T04 |
| EC-10 | Hook + transcript + OTel for one tool call | U | 2 | P2-T05 |
| EC-11 | Service down / no ack when hook fires | I | 3 | P3-T03, P3-T04 |
| EC-12 | Spool overflow | I | 3 | P3-T03 (+P3-T10 UI) |
| EC-13 | Truncated / rotated / replaced file | U | 1 | P1-T10 |
| EC-14 | Partial trailing JSONL line | U | 1 | P1-T09 |
| EC-15 | Huge transcripts / huge record | P | 1 | P1-T14 |
| EC-16 | Unicode/spaced/long paths; >200-char dir names | U | 1 | P1-T09 |
| EC-17 | Windows paths | U (v1 on Windows) | v1-D | V1D-T01 |
| EC-18 | Symlinked/synced/network dirs | I | 1 | P1-T10 |
| EC-19 | Missed watch events | I | 1 | P1-T10 |
| EC-20 | Concurrent resume interleaving | U + E | 7 | P7-T05 |
| EC-21 | Purged session resurrection | I | 5 | P5-T07, P5-T08 |
| EC-22 | Retention vs active sessions | U | 5 | P5-T10 |
| EC-23 | Claude transcript cleanup | I | 5 | P5-T12 |
| EC-24 | Native deletion/archive | I | 5 | P5-T12 |
| EC-25 | Codex hook trust not granted | I + S5 | 3 | P3-T06 (S5: P0-S5-T2..T5) |
| EC-26 | Plugin uninstalled outside Xaibo | I | 6 | P6-T04 |
| EC-27 | Xaibo deleted without Disconnect | I | 6 | P6-T05 |
| EC-28 | Claude statusLine existing/absent, capture failure, concurrent edit | U + I | 3 | P3-T14 |
| EC-29 | Existing Codex notify | U (v1) | v1-B | V1B-T06 |
| EC-30 | OTel exporter already configured | I (v1) | v1-B | V1B-T04 |
| EC-31 | OTLP port conflict | I (v1) | v1-B | V1B-T03 |
| EC-32 | Malicious local client on the hook socket | U + I | 3 | P3-T02 |
| EC-33 | Secrets in prompts / tool output | U (canary) | 1 | P1-T03, P1-T13 |
| EC-34 | MCP result size caps | U (v1) | v1-C | V1C-T05 |
| EC-35 | Egress redaction coverage | U | 1 | P1-T13 (extended in V1B-T10, V1C-T10) |
| EC-36 | Prompt injection via MCP | U (v1) | v1-C | V1C-T07 |
| EC-37 | MCP opt-in writing into a user repo | I (v1) | v1-C | V1C-T09 |
| EC-38 | Agent not installed / not on GUI PATH | U | 1 | P1-T08 |
| EC-39 | Config-dir overrides, multiple profiles | U + I | 1 | P1-T08 |
| EC-40 | Background work after Stop | U (fixture) + P | 3 | P3-T08 (+P3-T16 P) |
| EC-41 | Permission-wait heuristic vs confirmed | U | 3 | P3-T08 (+P3-T11) |
| EC-42 | Timezone / DST change | U | 3 | P3-T12 |
| EC-43 | Laptop sleep / wake | U (fake clock) + I | 3 | P3-T12 |
| EC-44 | Disk full | I | 3 | P3-T04 |
| EC-45 | DB migration failure | I | 1 | P1-T07 |
| EC-46 | Xaibo upgrade while agents run | I | 3 | P3-T04 |
| EC-47 | Two Xaibo instances | E | 1 | P1-T04 |
| EC-48 | Agent config invalid / edited concurrently | U | 3 | P3-T01 |
| EC-49 | Managed settings, `disableAllHooks`, `allowedHttpHookUrls` | U | 3 | P3-T05 |
| EC-50 | Non-interactive sessions | U | 2 | P2-T04 |
| EC-51 | Compaction | U | 2 | P2-T06 |
| EC-52 | Unknown hook events / new fields | U | 3 | P3-T04 |
| EC-53 | Codex Pre/PostModelRequest missing | U | 2 | P2-T12 |
| EC-54 | Codex state DB locked / schema changed | I | 2 | P2-T13 |
| EC-55 | Untrusted content rendering | E | 1 | P1-T12 |
| EC-56 | Very long lines / binary-like output | E | 4 | P4-T09 |
| EC-57 | 50 concurrent sessions / sustained traffic | P | 4 | P4-T11 |
| EC-58 | CJK / emoji search | U | 5 | P5-T14 |
| EC-59 | OS notification privacy | E + P | 3 | P3-T11 |
| EC-60 | Non-loopback connection attempt | E + S10 | 1 | P1-T05 (S10: P0-S10-T1..T4) |
| EC-61 | Runtime writes into the repo | E | 1 | P1-T05 |
| EC-62 | Real data in fixtures or commits | R + U | 1 | P1-T02 |
| EC-63 | Oversized or malformed hook stdin | U | 3 | P3-T03 |
| EC-64 | Hook output adding tokens or noise | U | 3 | P3-T03 |
| EC-65 | MCP called while Xaibo not running | I (v1) | v1-C | V1C-T06 |
| EC-66 | Missing title / project | U | 5 | P5-T02 |
| EC-67 | Resume of Desktop-origin Claude session | S7 | 7 | P7-T07 (S7: P0-S7-T6) |
| EC-68 | App-server thread not visible in Desktop/VS Code | S6 + I, v1-A | v1-A | V1A-T05 (S6: P0-S6-T2..T5) |
| EC-69 | Embedded terminal | E (v1) | v1-A | V1A-T03 |
| EC-70 | Interrupted turn | U | 3 | P3-T08 |
| EC-71 | Session moved/deleted while tailed | I | 5 | P5-T13 |
| EC-72 | Agent-flow rewrites/removes hooks | I | 6 | P6-T06 |
| EC-73 | `cleanupPeriodDays` already set | U | 6 | P6-T02 |
| EC-74 | Cross-agent sessions | U + I | 2 | P2-T12 |
| EC-75 | MCP grant enforcement | U + I (v1) | v1-C | V1C-T04 |
| EC-76 | Launch/resume argument safety | U + E | 7 | P7-T02 |
| EC-77 | Malicious request / DNS rebinding to OTLP receiver | U + I (v1) | v1-B | V1B-T03 |
| EC-78 | Invalid/imported catalog; duplicate ID; probe | U + I | 6 | P6-T07 |
| EC-79 | Newly installed agent; missing auth; blocked hooks | I + E | 6 | P6-T08 |
| EC-80 | Gemini repeated ID, `$set`, `$rewindTo`, legacy | U + I | 2 | P2-T11 |
| EC-81 | Gemini native cleanup / missing tool output | I | 2 | P2-T11 |
| EC-82 | Custom full content, chunks, retry, auth failure | U + I | 3 | P3-T13 |
| EC-83 | Generic notifications / unmatched resolution | U | 3 | P3-T13 |
| EC-84 | Changed executable/script/args/env; shell string | U + I | 7 | P7-T03 |
| EC-85 | Provisional launch row, binding, immediate Stop | E + P | 7 | P7-T04 |
| EC-86 | Cold start, hidden tray window, 200 MB session | E + P | 4 | P4-T13 |
| EC-87 | 10,000 sessions / ≥10 GiB DB | I + P | 5 | P5-T19 |
| EC-88 | ACP missing capability, permission, replay | I, v1-A | v1-A | V1A-T06 |
| EC-89 | Generic GenAI telemetry without identity | I, v1-B | v1-B | V1B-T05 |
| EC-90 | Gemini `maxAge` cases | U | 6 | P6-T02 |
| EC-91 | Rate windows null/expired/>100%/stale | U + I | 3 | P3-T15 |
| EC-92 | Multiple profiles/accounts, missing identity | U + I | 3 | P3-T15 |
| EC-93 | Codex rate_limits / cumulative / record version / context | U + I | 2 | P2-T06, P2-T07 |
| EC-94 | Claude compaction / null usage / 1M↔200k; Gemini absent | U + I | 2 | P2-T07 |
| EC-95 | Mixed models, cache classes, reported cost, children, resets | U + I | 2 | P2-T10 |
| EC-96 | Price edits, unknown model, owner fallback, revisions | U + I | 2 | P2-T09 |
| EC-97 | Usage/context/session access under narrow/missing/stale/loss | E | 4 | P4-T14 |
| EC-98 | Category records missing/duplicated/deferred | U + I, v1-B | v1-B | V1B-T08 |
| EC-99 | 45-day quota expiry, large quota history | I + P | 5 | P5-T11 |
| EC-100 | Usage/context/cost under live load and faults | I + P | 4 | P4-T12 |
| EC-101 | Model evidence / name precedence | U | 2 | P2-T08 |
| EC-102 | Mid-session model/effort switch | U + E | 4 | P4-T08 |
| EC-103 | Settlement accounting | U + I | 5 | P5-T05 |
| EC-104 | Month and quota semantics | U | 5 | P5-T06 |
| EC-105 | Deletion paths, clearing, cost coverage, privacy | U + I + E | 5 | P5-T16 |

Counts: Gate 1 = 20, Gate 2 = 16, Gate 3 = 24, Gate 4 = 6, Gate 5 = 12, Gate 6 = 7, Gate 7 = 5, v1-A = 3, v1-B = 6, v1-C = 5, v1-D = 1; total 105. Gate 0 and Gate D own none.

### 5.2 Metrics (M1–M16) → gate → measuring task

| M | Target (PRD §1.5, short) | Feasibility (Gate 0) | Gate pass | Measuring task(s) | Re-measured |
|---|---|---|---|---|---|
| M1 | Hook/report → paint p95 ≤250 ms; settle ≤ interval + 250 ms | P0-S3-T7 | Gate 3 | P3-T16 | P4-T08/T12, V1A-T08, V1B-T11, P7-T12 |
| M2 | File append → paint p95 ≤1 s; recovery ≤ interval + 1 s | P0-S12-T4/T6 | Gate 3 | P3-T16 (P1-T10 EC-19 recovery) | P4-T08/T12, P7-T12 |
| M3 | Import 1,000 sessions/~500 MB ≤120 s; list p95 ≤1.5 s; no frame >100 ms | P0-S9-T4 (realism) | Gates 1–3 | P1-T14 (first-list), P2-T14 (full), P3-T16 (with M1/M2) | P5-T20, P7-T12 |
| M4 | Idle window closed ≤250 MB, CPU ≤1% | P0-S10-T3 | Gate 3 | P3-T16 | P4-T17, P7-T12 |
| M5 | Idle window open ≤450 MB | P0-S10-T3 | Gate 4 | P4-T17 | P4-T12, P7-T12 |
| M6 | 0 attempted non-loopback connections | P0-S10 | Gate 1 onward, every gate | P1-T05, P1-T15 | every GS; V1C-T11 (MCP) |
| M7 | 0 tokens added by reporting channels | P0-S3, S4-T4, S5-T3, S13-T4 | Gate 3 | P3-T03, P3-T14, P3-T16 | P6-T13 (config lint), P7-T12 |
| M8 | Status detection on labeled fixtures | — | Gate 3 | P3-T07, P3-T08 | P7-T12 |
| M9 | 0 egress canaries | — | Gate 1 | P1-T13 | V1B-T10 (OTLP), V1C-T10 (MCP), P7-T12 |
| M10 | MCP footprint | — | v1-C | V1C-T05, V1C-T11 | — |
| M11 | Startup visibility (launch and ingestion portions) | — | Gate 3 (ingestion), Gate 7 (launch) | P3-T16, P7-T04 | V1A-T08 |
| M12 | Readiness: cold → list p95 ≤1.5 s; tray → window ≤300 ms | P0-S12-T3 (DB portion) | Gate 4 | P4-T13 | P5-T20, P7-T12 |
| M13 | Selection ≤300 ms; search ≤500 ms (T3) | P0-S12-T3 | Gate 5 (T0 portion at Gate 4) | P5-T19, P5-T11; P4-T13 (T0) | P7-T12 |
| M14 | 50 sessions, 200 events/s, 10 min | P0-S12-T4 | Gate 4 | P4-T11, P4-T12 | V1A-T08, V1B-T11, P7-T12 |
| M15 | Synthetic fourth agent via data only | P0-S11-T8 | Gate 6 | P6-T09 | — |
| M16 | Agent interference ≤100 ms | P0-S3-T1, S13-T5, S11-T2 | Gate 3 | P3-T16 | P4-T12, P6-T13, P7-T12 |

### 5.3 Spikes (S1–S13) → phase → decision produced

| Spike | Phase | Tasks | Decision produced |
|---|---|---|---|
| S1 SQLite | 0 | P0-S1-T1..T5 | One engine (`node:sqlite` or `better-sqlite3`), pinned SQLite version and compile options; DBSTAT and `contentless_delete` availability; App. E #6 |
| S2 PTY | pre-v1-A (repeat per OS in v1-D) | V1A-S2-T1, V1D-T02/T04 | PTY host feasibility, prebuild vs local compile (App. E #7) |
| S3 Forwarder | 0 | P0-S3-T1..T9 | Forwarder runtime (Q7), per-event path (Q17), ack point; HTTP eligibility; App. E #19, #18 (with S4) |
| S4 Claude plugin | 0 | P0-S4-T1..T7 | D-2 route (plugin or marker fallback) with verified command sequence; mutual-exclusion rule; App. E #1, #2 |
| S5 Codex hooks | 0 | P0-S5-T1..T6 | FR-31 route, guided trust steps, async/sync matrix; App. E #5 |
| S6 Codex interoperability | 0 | P0-S6-T1..T6 | Q3 (attach yes/no), resume/fork syntax, EC-50 per-kind resume, compatibility matrix; App. E #4, #14 |
| S7 Claude interoperability | 0 | P0-S7-T1..T7 | §6.2 confirmations, EC-67 behaviour, Q12, compatibility matrix; App. E #3, #13, #14 |
| S8 OTLP | pre-v1-B | V1B-S8-T1 | OTel config syntax, auth, payloads, exporter preservation; D-13 confirmation; App. E #9, #10, #15 |
| S9 Format survey | 0 | P0-S9-T1..T8 | Supported fact set per version, EC-03 handling, metadata-file use; fixtures; App. E #8, #11, #24 (Codex) |
| S10 Network | 0 (MCP re-run pre-v1-C) | P0-S10-T1..T4, V1C-T11 | Sufficient P2 policy, audit method for E2E, M4/M5 baselines |
| S11 Gemini/catalog | 0 | P0-S11-T1..T10 | Gemini observation/retention/launch facts and narrowings; catalog schema draft; JSON Schema validator selection; Q18; App. E #16, #17, #24 (Gemini) |
| S12 Capacity/latency | 0 | P0-S12-T1..T7 | Minimum architecture, batch bounds, watcher strategy, **watch reconciliation interval default** (Q8/FR-02), Q19 status; App. E #20, #26 |
| S13 Passive usage/context/cost | 0 | P0-S13-T1..T9 | **Tee feasibility and account-scope decision**, snapshot schemas, context-change rules, price-component mapping; App. E #22–#25 |

## 6. Consolidated open questions and plan risks

Every question has a default that applies if the owner does not answer. "→" marks a question merged into another.

### 6.1 Cross-cutting (OQ-X)

| ID | Question | Default |
|---|---|---|
| OQ-X1 | Where do signed-in temp profiles live? The repo `.cache/` persists across sessions but sits inside the Docker-mounted project root (harness-os); the session scratchpad is outside the repo but is wiped per session (re-sign-in each time). (merges OQ-B1, Q3-10, part A profile-location question) | `<repo>/.cache/profiles/<agent>-<slot>/` (git-ignored, 0700), kept until Gate 6, then logout and delete. |
| OQ-X2 | How are runs that must leave the Claude sandbox executed (packaged GUI, `sandbox-exec`, loopback bind, agent CLIs and their network)? (merges OQ-A16, OQ-B13, OQ-C13) | **Resolved (owner, 2026-11-09): default accepted.** Inside the sandbox with `allowed_domains` where possible; otherwise per-command unsandboxed approval; the owner may instead run the listed `npm run spike:*` commands and Claude reads results from `.cache/spike-results/`. The guard always runs. |
| OQ-X3 | Which keychain items does the guard check, and may it hash credential files? (merges OQ-A6, OQ-A7) | Every snapshot enumerates the login keychain's attributes (`security dump-keychain`, never `-d`/`-g`/`-w`) and keeps (`svce`, SHA-256 of `acct`, `mdat`) for items matching the agents' names (from docs via context7) privately; never secrets; unknown names checked by the owner in Keychain Access. Credential files stat only (size, mtime, inode); config files SHA-256; `~/.claude.json` only top-level keys and `mcpServers`. |
| OQ-X4 | What if a temp sign-in would share or overwrite a real keychain credential (or it changed one)? (merges OQ-B12, OQ-C9) | **Resolved (owner, 2026-11-09): default accepted.** Stop all live spikes; the owner re-authenticates the real profile if needed; continue only with owner-approved alternative temp auth (API key in a temp env file under `.cache/`, which spends money) or mark the live part UNVERIFIED. For core Gemini scope that is a required-scope miss returned to the owner. |
| OQ-X5 | Fixture origin and identity: PRD §6.6 allows sanitized recordings, but the standing rule says only schemas/aggregates enter git; how are `.jsonl.zst` fixtures handled; what synthetic pattern; may Phase 0 commit fixtures before Phase 1's lint exists? (merges Q3-4, OQ-B9, OQ-C2, OQ-C3) | Hand-written fixtures from recorded schemas only; UUIDs `00000000-0000-4000-8000-<12 hex>`, cwd `/tmp/xaibo-fixture/<project>`, home paths `~/<project>`, fixed timestamp base; `.jsonl.zst` generated at test time with `node:zlib` (no `.gitignore` change); Phase 0 commits at the final path after `npm run privacy:scan` and manual review; Phase 1 fixture-lint re-runs over them at Gate 1. |
| OQ-X6 | JSON Schema validator: which, when installed, and is a hand-written validator allowed? App. C says "an approved existing validator or a small maintained validator selected at Gate 0". (merges OQ-C4, OQ-C5, OQ-C6, OQ-P1-01, OQ-P2-06, Q3-16, OQ-P6-4) | Selected at Gate 0 from registry metadata and docs (P0-S11-T9); a trial install into `.cache/validator-trial/` only if the owner approves at that step; installed at **Phase 1 start** (first user: P1-T08 catalog detection subset), then reused for `models.json`, report v1 and catalog import. A hand-written validator only if the owner explicitly decides so at Gate 0 (App. C change). |
| OQ-X7 | How are large gate diffs reviewed; commit before review? (merges OQ-P1-13, OQ-B18, OQ-C12) | **Resolved (owner, 2026-11-09, D-P0-02; fallback removed by D-P0-07).** Each gate needs the owner's OK for an unpushed branch commit before review; if declined, the gate waits (no uncommitted fallback). The suite, both reviews and the owner approval use the same gate SHA; every fix is a further commit and a new gate SHA with a full re-run; post-freeze evidence goes into `docs/plans/gates/gate<N>.md` in the gate-record commit (§2.4). One handoff excluding the lockfile; split by top-level directory into sequential Codex tasks if too large. Phase 0 parts reviewed together as one Gate 0 review. |
| OQ-X8 | How is RED evidence recorded for E2E/perf-only and TSX work, since harness-os sees RED only via `npm test` and node:test cannot import JSX? (merges OQ-P1-14, Q-4.3) | Every gated unit has a node:test harness RED on its `.ts` logic module before any `.tsx` is written (§3.6), proved on the first `.tsx` unit in Phase 1; E2E/perf RED/GREEN is additional, from Playwright/perf output, sanitized, in the progress file and `record_decision`. |
| OQ-X9 | How are the Gate 0 PRD edits versioned, and are stale "pending owner approval" notes (D-14..D-19, D-22, Q15, header) removed? (= OQ-C10) | One revision, v1.1, with a history line, approved at Gate 0; the stale notes removed if the owner confirms v1.0 approval covered them. |
| OQ-X10 | Prompt budget and time-box for live spikes. (merges OQ-B3, OQ-A12) | **Resolved (owner, 2026-11-09): default accepted.** ≤40 tiny prompts per agent in Phase 0 in total; Claude stops and asks before exceeding; one working session per spike, stopping with partial evidence on overrun or blocker; runs tallied in the progress file. |
| OQ-X11 | How does Playwright MCP attach to the Electron renderer? (= Q-4.8) | The method set up in Phase 1 (P1-T12); if none: dev build only, loopback remote-debugging port, synthetic data dir, MCP CDP endpoint; never in packaged builds; the owner approves any MCP config change. |
| OQ-X12 | Screens not in the Gate D brief (launch dialog, concurrency warning, ownership badge, terminal panel, Compare, inspector, MCP grant UI): how are they designed? (merges OQ-P7-7 and the v1 design deltas) | The Gate D brief includes the Phase 7 patterns; v1 screens get a small Codex design delta (Claude review, owner approval) before implementation; otherwise compose from existing components. |
| OQ-X13 | Commit format identifiers and real agent-version strings in reports? | Agent format identifiers (entrypoint, record type names) and public version strings are allowed; anything user-like becomes `<other>`. |
| OQ-X14 | One per-install secret for log-ID hashing (P1-T03) and opaque contribution keys (P5-T04), or two? (plan merge decision) | One random per-install key file in app data (0600), used by both via HMAC-SHA256 with distinct context labels. |
| OQ-X16 | Commands that apply their own Seatbelt profile (e.g. Codex's tool sandbox, Electron helpers) may fail inside the runner's `sandbox-exec` read/write deny wrapper (P0-T05 nesting probe). How are they run? | **Never unwrapped.** A command that cannot run inside the wrapper does not run. The owner chooses per command: (a) disable that agent's own sandbox in the temp profile so the command runs inside the wrapper (recorded as a behaviour change under test, with the affected spike criteria noted), or (b) mark that live part UNVERIFIED. Recorded with `record_decision`. |
| OQ-X15 | Contrast thresholds for the Gate D pair inventory (PRD §4.3 names contrast but no ratio). | WCAG 2.2 AA: 4.5:1 normal text; 3:1 large text (≥24 px, or ≥18.66 px bold); 3:1 UI component boundaries, focus indicators, status glyphs and chart marks against adjacent colours; checked in light and dark themes. |

### 6.2 Phase 0 — part A (S1, S3, S10, S12, setup)

| ID | Question | Default |
|---|---|---|
| OQ-A1 | Which ack point counts as "durable acceptance" (FR-09, §7.3): (i) after validation and volatile publish, or (ii) after SQLite commit? A commit inside the 100 ms batch window could exceed the forwarder deadline and cause duplicate spooling. (merges Q3-1) | Ack after commit in an immediate small transaction ahead of backfill batches (WAL + `synchronous=NORMAL` survives a process crash). S3 measures both; if (ii) misses the deadline at p95, evidence goes to the owner before Gate 0; if Phase 3 T0 shows routine misses, back to the owner. |
| OQ-A2 | How is the "smallest qualifying" forwarder candidate defined (§7.3, Q7)? | (1) fewest additional shipped binaries and build steps, (2) bytes added, (3) p95 added sync wait; Electron-run-as-Node wins ties. |
| OQ-A3 | Native compiled forwarder (C/Swift) as a fourth S3 candidate? | No; only if both Node candidates fail M16, as an owner-reviewed decision. |
| OQ-A4 | May the SEA embed system Node 26 via `node --build-sea`; may `postject` be installed if the flag fails? | Yes to embedding for the spike (product Node binary decided in Phase 3 if SEA wins); `postject` only with explicit approval at that moment. |
| OQ-A5 | Where do temp profiles and spike data live? | → OQ-X1 (spike data in git-ignored `.cache/spike-data/` and `.cache/spike-results/`). |
| OQ-A6 | Keychain item names for the guard | → OQ-X3 |
| OQ-A7 | May the guard hash credential file content? | → OQ-X3 |
| OQ-A8 | How many quota-history streams does S12 simulate? | 12 (3 agents × 2 profiles × 2 windows), 64,800 samples each, transitions at 1% of samples; bytes per stream reported for linear extrapolation. |
| OQ-A9 | Event mix for the 200 events/s M14 workload in S12 | Two mixes reported: 100% native-file appends; 75% file / 25% hook deliveries through the S3 forwarder (50 spawns/s). |
| OQ-A10 | Decision rule for the watch reconciliation interval (Q8/FR-02) | Smallest of {2, 5, 10, 15, 30, 60} s where the scan over 10,000 files averages ≤0.25% of one core and one scan ≤10% of the interval; recovery = interval + 1 s; owner confirms at Gate 0. |
| OQ-A11 | What is a "cold" query in S12 (dropping the page cache needs root)? | New process and connection, OS page cache warm, reported as such; owner may run `sudo purge` for true cold. |
| OQ-A12 | Time-box per spike | → OQ-X10 |
| OQ-A13 | Should root `dist:mac` build the spike app in Phase 0? | Yes (`spikes/app/electron-builder.json`, mac `dir`, identity null); Phase 1 repoints it. |
| OQ-A14 | Which Electron version is pinned? | Latest stable at install time, recorded exactly; if its Node lacks a working `node:sqlite`, S1 evaluates better-sqlite3 rather than switching Electron, unless the owner decides otherwise. |
| OQ-A15 | May a native toolchain rebuild better-sqlite3 for Electron? | `electron-builder install-app-deps` with prebuilt binaries where available; any extra tool (node-gyp's Python etc.) needs explicit approval. |
| OQ-A16 | How are unsandboxed runs executed? | → OQ-X2 |

### 6.3 Phase 0 — part B (S4, S5, S6, S7, S13, profile protocol)

| ID | Question | Default |
|---|---|---|
| OQ-B1 | Temp profile location | → OQ-X1 |
| OQ-B2 | Shared spike helper dir allowed, given the rule says `spikes/<spike-id>/`? | `spikes/shared/` (plus `spikes/app/`), never imported by `src/`. |
| OQ-B3 | Prompt budget | → OQ-X10 |
| OQ-B4 | Desktop and VS Code surfaces that may only read the real profile | Test only when the surface honours the temp env in an isolated user-data dir; otherwise "untested (real profile only)"; never observe the real profile. |
| OQ-B5 | Who approves Codex hook trust in the temp profile? | Claude via expect; the owner may watch. |
| OQ-B6 | Tee added-wait bound | p95 ≤100 ms on S3's packaged runtime (M16), excluding the foreign command's runtime. |
| OQ-B7 | FR-45's capture list omits `session_id`, but attribution needs it | Capture `session_id` (local private path only); never `transcript_path` or `cwd`. |
| OQ-B8 | Tee exit status when the original is killed by a signal | Re-raise the same signal; if impossible, exit 128 + signal number; documented. |
| OQ-B9 | Commit fixtures in Phase 0 before fixture-lint exists? | → OQ-X5 |
| OQ-B10 | Keep signed-in temp profiles after Gate 0? (merges OQ-C7) | Keep until Gate 6 (FR-32 disposable-profile hook work), then owner logout, delete profiles and any temp keychain items after confirmation. |
| OQ-B11 | Second same-account temp profile for EC-92 evidence? | Skip; account scope defaults to option A "Account scope unverified". |
| OQ-B12 | Temp login changes a real keychain item | → OQ-X4 |
| OQ-B13 | Agent CLIs need provider hosts through the sandbox proxy | → OQ-X2 |
| OQ-B14 | May a local stdlib MCP elicitation server be registered in the temp profile (S7-T3)? | Yes; no SDK install. |
| OQ-B15 | Spike `/compact` and `/model` cause model calls; allowed? | Allowed in temp profiles only; FR-44 binds the product, not spikes. |
| OQ-B16 | May spikes use `/context` or token counting to cross-check context? | No, never. |
| OQ-B17 | Commit `codex app-server generate-ts` output from Phase 0? | No; method names only in the report (product bindings per OQ-V1A-2). |
| OQ-B18 | Separate part B review or one Gate 0 review? | → OQ-X7 (one combined Gate 0 review). |

### 6.4 Phase 0 — part C (S9, S11, report, gate)

| ID | Question | Default |
|---|---|---|
| OQ-C1 | Who runs `scripts/audit-sources` on the real stores? | **Resolved (owner, 2026-11-09, D-P0-04).** The owner, in their own terminal, as the one named real-data exception in AGENTS.md (PRD §8), sharing only the numberless P0-S9-T3 answers; Claude runs it only on synthetic trees. |
| OQ-C2 | `.jsonl.zst` fixtures given `.gitignore` | → OQ-X5 |
| OQ-C3 | Synthetic identity pattern | → OQ-X5 |
| OQ-C4 | Hand-written validator allowed? | → OQ-X6 |
| OQ-C5 | Validator trial install | → OQ-X6 |
| OQ-C6 | Validator install phase | → OQ-X6 (Phase 1 start; this replaces part C's "Phase 3 or Phase 6" default) |
| OQ-C7 | Temp profiles after Gate 0 | → OQ-B10 |
| OQ-C8 | How are interactive TUI steps (approve/deny, rewind, resume) driven? | macOS `expect` under a PTY, owner manual fallback per step. |
| OQ-C9 | Temp sign-in would share/overwrite the real credential | → OQ-X4 |
| OQ-C10 | PRD edit versioning | → OQ-X9 |
| OQ-C11 | Gemini system/managed precedence when no env var relocates the system settings path; may system folders be written? | No; record precedence as "source-read, not runtime-verified"; EC-90 tests use fixtures. |
| OQ-C12 | Commit before the Gate 0 review? | → OQ-X7 |
| OQ-C13 | Network for live agent runs | → OQ-X2 |
| OQ-C14 | Is the S11 classification right (C1–C5 core-required; C6–C8, C11 conditional; C9, C10, C12 catalog-required)? | As proposed; owner confirms at Gate 0. |
| OQ-C15 | May format identifiers from the real-store questionnaire be committed? | → OQ-X13 |

### 6.5 Phase 1

| ID | Question | Default |
|---|---|---|
| OQ-P1-01 | Catalog with schema in Phase 1 detection? | → OQ-X6 (yes, detection subset, validated with the Gate 0 validator; schema grows additively at v1). |
| OQ-P1-02 | `@types/react`, `@types/react-dom`, explicit `@types/node` are not on App. C | Request approval at Phase 1 start; TSX typecheck is blocked until approved. |
| OQ-P1-03 | EC-38/39 need the login-shell env, but FR-01 says probes run without a shell | One fixed-argv login-shell `env -0` read (no interpolation, 3 s, allowlisted keys); version probes stay shell-free. |
| OQ-P1-04 | Which transcript-derived strings does the Phase 1 list show? | Agent, entrypoint badge, original cwd, native title or "Untitled", last activity, coverage markers; EC-55 exercised through cwd and title; first-prompt excerpts wait for EC-66 (Gate 5). |
| OQ-P1-05 | Store the raw source line for every record (~2× storage)? | Yes, so later normalization works after native files are deleted. |
| OQ-P1-06 | Single-record parse cap and EC-15 memory bound | Parse lines up to 64 MiB in memory; larger lines go through a bounded streaming extractor that stores their readable content in chunks (FR-08) and keeps the raw bytes chunked; an `oversized` gap only for bytes it cannot read or interpret; service RSS growth ≤ 2 × min(largest line, 64 MiB) + 128 MiB. |
| OQ-P1-07 | Service restart backoff constants | 0.5 s doubling to a 30 s cap, retrying indefinitely at the cap, reset after 60 s healthy. |
| OQ-P1-08 | `--use-mock-keychain` in production? | Tests only; production follows S10 evidence at Gate 1. |
| OQ-P1-09 | What does M3 "usable list p95" measure? | Process start → first painted page with ≥1 row accepting input, during background import, p95 over 20 cold runs. |
| OQ-P1-10 | Crash reports? | Never call `crashReporter.start`; crashes become sanitized error-code log entries. |
| OQ-P1-11 | EC-01 liveness wiring source | Pure function plus `ps` provider; wired only if S9 confirmed a pid-bearing Claude source, else first used in Phase 3/7. |
| OQ-P1-12 | Network-volume detection for EC-18? | No; reconciliation is the polling fallback and a watch error switches that root to polling. |
| OQ-P1-13 | Large gate diffs | → OQ-X7 |
| OQ-P1-14 | RED evidence for E2E/perf | → OQ-X8 |
| OQ-P1-15 | Which runtime runs SQLite integration tests? | `npm test` on system Node plus SQLite I-tests under `ELECTRON_RUN_AS_NODE` against `tsc` output; with better-sqlite3, Electron only. |
| OQ-P1-16 | Where does start-at-login (S-13 opt-in) land? | Phase 6 (P6-T10), default off; Phase 1 ships tray, close and quit only. |
| OQ-P1-17 | How many pre-migration backups are kept? | Only the latest, 0600, under `<appdata>/backups/`, covered by the Phase 5 purge. |

### 6.6 Phase 2

| ID | Question | Default |
|---|---|---|
| OQ-P2-01 | UsageSnapshot split between Phase 2 and Phase 3 | **Resolved: default accepted by owner.** Phase 2 persists raw Codex rate-limit observations; scope/epoch attribution, minute sampling, staleness and UI in Phase 3. |
| OQ-P2-02 | Rollout dedup "file identity" | **Resolved: default accepted by owner.** Native session id + head hash (not inode), so archive moves and copies do not duplicate; recorded via `record_decision`. |
| OQ-P2-03 | M3-full corpus composition | **Resolved: default accepted by owner.** §6.6 total size and distribution with a seeded Claude/Codex/agy mix; T00-verified shapes only; proportions proposed in the progress file and confirmed by the owner before P2-T14; Claude-only T1 re-run for comparison. |
| OQ-P2-04 | Ship Codex state-DB enrichment? | **Resolved: default accepted by owner.** No, unless P2-T13 finds a coverage gap and the owner approves; EC-54 proven by non-interference. |
| OQ-P2-05 | Who sources and verifies bundled prices and display names? | **Resolved: default accepted by owner.** Claude drafts from providers' public pricing pages (URL + date in `models.json`); the owner verifies before Gate 2; unverified models ship names only and `~$ unavailable`. |
| OQ-P2-06 | Validator for `models.json` | → OQ-X6 |
| OQ-P2-07 | When is FileTouch derived? | **Resolved: default accepted by owner.** Phase 4 (P4-T05), with the workspace that displays it. |
| OQ-P2-08 | Pure resume argv builder in Phase 2? | **Resolved: default accepted by owner.** Yes; from S6/S7 (Claude/Codex) and T00 (`agy`) evidence; unverified kinds disabled with a reason; executed only in Phase 7. |
| OQ-P2-09 | `agy` context window source | **Resolved: default accepted by owner.** T00 must verify latest-prompt input semantics; `~est` only when `models.json` lists a version-tested window for that exact model ID; otherwise unavailable. |
| OQ-P2-10 | Initial `agy` evaluation budget | **Resolved: owner chose the recommendation (D-P2-01).** ≤4 tiny synthetic prompt submissions total, retries included, one working session; owner authorizes live run/sign-in first. Cap/blocker → partial evidence, no automatic extension. Private tally only; no live counts in git. |
| OQ-P2-11 | Unverified `agy` facts / Gemini-equivalent EC scope | **Resolved: owner chose the recommendation (D-P2-01).** stop dependent work; owner chooses waive/defer/verified-equivalent scope per affected EC/FR (incl. EC-80/81, and M3-full if ingest unavailable). Missing facts stay unavailable/disabled; no automatic waiver or Gate 2 pass. |

### 6.7 Phase 3

| ID | Question | Default |
|---|---|---|
| Q3-1 | Ack semantics | → OQ-A1 |
| Q3-2 | Symlinked agent config files: refuse or write through? | Refuse with manual steps in Phase 3; revisit at Gate 6. |
| Q3-3 | After a foreign-only edit, must Disconnect keep foreign formatting byte-identical? | Unchanged hash → restore backup bytes; otherwise structural removal keeping detected indent and trailing newline; Gate 6 round-trip tests decide whether text-splice edits are needed. |
| Q3-4 | Fixture origin | → OQ-X5 |
| Q3-5 | Placeholder status UI before Gate D acceptable? | Yes: text + glyph in the Phase 1 list and minimal banners; no new screens or baselines until Phase 4. |
| Q3-6 | Notification project label before Phase 5's label UI | "Project" unless an approved label row exists (tests seed one). |
| Q3-7 | Tee original command in the manifest or embedded in wrapper argv; is running it via Claude's shell outside FR-25's launch shell ban? | Manifest reference plus the S13-recorded shell invocation; treated as outside FR-25 scope (it is the owner's own command). |
| Q3-8 | Socket path over 104 bytes in production | Visible health error; no alternate path until observed. |
| Q3-9 | Chunk-assembly quotas and per-registration limits | 64 MiB pending per registration, 512 MiB global, 1,000 queued frames / 16 MiB per registration, round-robin; counted in the storage meter. |
| Q3-10 | Phase 3 temp profile location | → OQ-X1 |
| Q3-11 | Which states trigger OS notifications? | Confirmed waiting-for-permission and needs-input only; none for error, ended or findings. |
| Q3-12 | Interim Codex reviews for security-change units before Gate 3? | Yes, diff-only, no owner stop; Gate 3 still covers the full diff. |
| Q3-13 | §6.3 app-server and notify rows in Phase 3? | No; v1-A (app-server) and v1-B (notify). |
| Q3-14 | Where are R1–R5, settle and heuristic thresholds adjusted? | Setting keys with PRD defaults in Phase 3; adjustment UI with the Settings screen after Gate D. |
| Q3-15 | Disk-full testing | ENOSPC fault injection only; no real tiny-volume test (S3 already used a 1 MiB image in Phase 0). |
| Q3-16 | Report v1 validator | → OQ-X6 |

### 6.8 Phase D, Phase 4, Phase 5

| ID | Question | Default |
|---|---|---|
| Q-D1 | Run Phase D in parallel with Phases 1–3? | Yes, start after Gate 0 on `docs/design-system`; Gate D must pass before Phase 4. |
| Q-D2 | Does Codex write the design doc directly? | Yes, on the docs branch; Claude never edits design content; all changes go back to Codex. |
| Q-D3 | Static mockups? | No unless the owner asks; if produced, self-contained HTML/SVG in `docs/design/mockups/`, synthetic, no external resources. |
| Q-D4 | Originality check against the owner's dashboard screenshot (not in the repo) | The owner checks that item at approval; Claude checks the other references. |
| Q-D5 | Codex revision rounds before escalation | 2, then the owner rules on remaining findings. |
| Q-D6 | Font choice | System font stack (no network, no font asset or license). |
| Q-4.1 | Commit Playwright baseline PNGs? | Yes, in the default `*-snapshots/` folder; synthetic only; darwin-only; updated only with owner OK after a design change. |
| Q-4.2 | Automated A11Y tooling (axe-core not on App. C)? | No new dependency; role/name queries, aria snapshots, keyboard tests, token contrast unit test. |
| Q-4.3 | RED for TSX | → OQ-X8 |
| Q-4.4 | Range of per-scope observed usage history in the UI | Full retained 45 days, paged by day, gaps shown. |
| Q-4.5 | Narrow-window widths if the design gives none | Minimum window width and 720 px. |
| Q-4.6 | Theme selection if unspecified | Follow the OS (`nativeTheme`), no setting. |
| Q-4.7 | Sample size for p95 claims (M12, M13-T0) | ≥20 runs per measurement, distribution summary recorded. |
| Q-4.8 | Playwright MCP attach | → OQ-X11 |
| Q-5.1 | Migration backups containing a purged session: delete or rewrite? | Delete affected backups, with a notice and a progress-file entry. |
| Q-5.2 | SQLite `secure_delete` for purge? | Off; purge is logical and not forensic (FR-11); the acceptance byte-scan excludes the main DB file. |
| Q-5.3 | Does search include archived, Trash, suppressed? | Archived included with a filter; Trash excluded by default (search inside the Trash view); suppressed never. |
| Q-5.4 | T3 corpus location and disk budget | `.cache/perf/t3/`, ≥25 GiB free; kept between runs; deleted on owner request. |
| Q-5.5 | Allowed retention N | Integer days 1–3650 or Never; default 45. |
| Q-5.6 | Storage meter granularity without DBSTAT | File-level totals plus row counts; per-table bytes only if S1 shows DBSTAT. |
| Q-5.7 | Monthly chart default metric | Tokens; switchable to sessions, `~$`, peak quota % per scope. |
| Q-5.8 | Does Clear usage history clear MonthlyQuotaPeak too? | Yes (both are frozen totals). |
| Q-5.9 | May Phase 5 backend work start before Gate 4? | No; phases run in sequence (PRD §10). |
| Q-5.10 | How are opaque contribution keys derived? | HMAC-SHA-256 of the source identity with the per-install key (OQ-X14). |
| Q-5.11 | Does M13 "cold application cache" require dropping the OS page cache? | No; cold = fresh app process; OS cache state recorded, not purged. |

### 6.9 Phases 6, 7, v1, Public

| ID | Question | Default |
|---|---|---|
| OQ-P6-1 | Owner live real-profile Connect/Disconnect at Gate 6? | Yes, optional, owner-run in the packaged app after Gate 6 approval (first step of P7-T01; FR-32 forbids real-profile Connect before Gate 6); local checksum manifest; pass/fail only recorded. |
| OQ-P6-2 | Claude CLI plugin install/uninstall not byte-identical for `settings.json`? | Use S4 evidence; if not identical, marker-merge fallback (D-2) for that version; any remaining difference needs an owner waiver. |
| OQ-P6-3 | How is auth shown in Add agent without reading credentials? | "Sign-in not verified" until a session or event is observed; no credential/auth-file reads; no agent commands beyond the version probe. |
| OQ-P6-4 | Catalog validator | → OQ-X6 |
| OQ-P6-5 | Does Uninstall remove `<appdata>/integrations/`? | Only when every manifest entry was restored without conflict; otherwise the shim stays so EC-27 behaviour holds. |
| OQ-P6-6 | Guard against a missing shim when app data was deleted? | No shell wrapper; documented manual cleanup (`docs/integrations/manual-cleanup.md`). |
| OQ-P7-1 | External terminal on macOS | Terminal.app: a private 0700 `.command` file in `<appdata>/run/` with only quoted tokens, opened via `open -a Terminal <file>` with argument-array spawn, deleted after launch. |
| OQ-P7-2 | Binding provisional rows for agents without pre-allocated IDs | Bind only when exactly one new session-start record for that agent and profile, with matching realpath cwd, appears within 60 s; else the row ends "Not observed" and the session appears separately; never merge on ambiguity. |
| OQ-P7-3 | Meaning of the MVP lock | Blocks a second Xaibo launch/resume of the same session while one is pending or live evidence exists; the warning says external clients cannot be locked. |
| OQ-P7-4 | Compare in Phase 7? | Deferred to v1-B. |
| OQ-P7-5 | Fork for Gemini and generic agents | Only where the catalog declares a tested fork template. |
| OQ-P7-6 | US-8 agents | Claude and Codex once each; Gemini optional. |
| OQ-P7-7 | Design for non-Gate-D screens | → OQ-X12 |
| OQ-V1A-1 | ACP library? | None; hand-written stdio JSON-RPC client. |
| OQ-V1A-2 | Where do generated app-server bindings live, given `src/**/*.ts` is gated? | `src/service/adapters/codex/appserver/protocol.generated.ts` under a harness spec, regenerated by `scripts/gen-codex-appserver`, with a version-stamp unit test. |
| OQ-V1A-3 | Which agents get ACP? | Only catalog entries whose pre-v1-A test proves ACP support (App. E #21); Gemini first candidate. |
| OQ-V1A-4 | Embedded or external terminal default? | External stays default; embedded offered per launch. |
| OQ-V1A-5 | node-pty needs an absent native toolchain (also v1-D) | Stop and ask; nothing installed machine-wide without approval. |
| OQ-V1B-1 | OTLP port range | Small fixed loopback range from S8 evidence; docs show `<port>` only. |
| OQ-V1B-2 | Which producers get OTLP opt-ins? | Claude, Codex, Gemini, generic, each separate. |
| OQ-V1B-3 | Gemini OTLP without token-header support | Do not enable Gemini OTLP; show the reason; native JSONL content channel remains. |
| OQ-V1B-4 | S8 finds a provider-billed amount locally? | Record only; D-13 stays (estimates) unless the owner revises it. |
| OQ-V1B-5 | Must v1-B wait for v1-A? | Yes, sequential A, B, C, D unless the owner reorders. |
| OQ-V1C-1 | MCP SDK or hand-written JSON-RPC? | Hand-written; SDK (with approval) only if the V1C-T11 live registration fails. |
| OQ-V1C-2 | M10 token overhead without model calls | `~est` (bytes/4 of serialized definitions) next to the measured delta from the V1C-T11 temp-profile run. |
| OQ-V1C-3 | Control-tool IPC | Private service socket, separate authenticated message type, 0600 per-install token. |
| OQ-V1C-4 | Registration targets | Claude, Codex, Gemini; separate opt-in per agent and project. |
| OQ-V1C-5 | Grant storage | Private 0600 app-data file re-read on every call (offline revocation works). |
| OQ-V1D-1 | Build hosts | Owner-provided Windows, then Linux, machines; CI only with owner approval (cost/minutes). |
| OQ-V1D-2 | External terminal on Windows/Linux | `wt.exe` with argument-array spawn when present, else `cmd.exe /c start` with tested quoting; Linux `x-terminal-emulator`, else a configured terminal. |
| OQ-V1D-3 | Perf targets binding on Windows/Linux? | Measured and reported; binding only on the reference Mac. |
| OQ-V1D-4 | Native toolchain for node-pty | → OQ-V1A-5 |
| OQ-V1D-5 | Linux package format | AppImage only. |
| OQ-V1D-6 | One gate or two for v1-D? | One branch and gate, with an owner checkpoint between Windows and Linux. |
| OQ-PUB-1 | Signing | Stay unsigned and private until the owner decides. |
| OQ-PUB-2 | Sanitizer finds real data in history | Stop and ask; no rewrite or force-push without explicit owner confirmation. |
| OQ-PUB-3 | Project license | No LICENSE file until the owner chooses. |
| OQ-PUB-4 | DB encryption at rest for public users | Keep D-11 (OS disk encryption plus private permissions) unless the owner decides otherwise. |

### 6.10 Risks specific to this plan

| Risk | Mitigation |
|---|---|
| The plan is long and detailed before any spike ran; Phase 1+ tasks depend on Gate 0 outcomes (engine, forwarder, interval, tee, D-2, validator) | Every dependent task names the Gate 0 decision it consumes; after Gate 0 the plan is revised in one change (logged in the progress file) before Phase 1 starts |
| Phase 0 parts were drafted separately; helper paths, profile locations and validator timing conflicted | Unified here: `spikes/shared/` helpers, `.cache/profiles/`, `.cache/spike-results/`, validator at Phase 1 start (OQ-X1, OQ-X6); the Codex challenge should re-check for leftovers |
| Live temp-profile work depends on owner availability for sign-in and unsandboxed approvals | Batch live blocks per agent (§0.15); owner-run script option (OQ-X2) |
| Keychain sharing could block all live spikes | Checked first (P0-T06); fallback paths in OQ-X4; UNVERIFIED with consequences rather than silent skips |
| Gate review diffs grow very large (Phase 1, Phase 3) | Chunked handoffs, lockfile excluded, interim reviews (OQ-X7, Q3-12) |
| harness-os keyword-risk prompts on every unit slow progress | Expected; `record_decision`; owner approves criticals at the terminal |
| Spike evidence or real data leaking into git or handoffs | Reducer and privacy scan (Phase 0), plus pre-commit (Phase 1+), privacy gate before any handoff |
| Gate D on the critical path for Phase 4 | Phase D in parallel after Gate 0 (Q-D1) |
| Performance targets missed on the reference Mac | Feasibility measured early (S12); misses reported, never relaxed; owner decides (Q19) |
| Agent versions drift during the long build | Pins recorded per fixture set; drift counters; re-run affected spikes (S1 on Electron bumps, S6/S7 checks at Gate 7) |
