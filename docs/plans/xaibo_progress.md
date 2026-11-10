# Xaibo progress

Live status file for `docs/plans/xaibo_plan.md` (HARNESS_PROCESS §2, PRD §1.6 item 4). It must always show the real status.

## 1. Current status

| Item | Value |
|---|---|
| Current phase | **Phase 0: plan approved (D-P0-09); spikes not started** |
| Branch | `feat/phase0-spikes` |
| Plan version | Approved v1.0 (2026-11-09) |
| Gate state | Gate 0 not started. Phase 0 runs only on the reference Mac (D-P0-03). |
| Next step | Owner merges the approved plan docs; then on the Mac: P0-T10, then P0-T01 |
| Blockers | None |
| Baseline for Gate 0 review | `master` at `e6b39ab` |

## 2. Per-phase status

| Phase | Branch | Status | Gate | Gate date | PR |
|---|---|---|---|---|---|
| 0 Spikes | `feat/phase0-spikes` | plan approved, spikes not started | Gate 0 | — | — |
| 1 Skeleton + Claude ingest | `feat/phase1-claude-ingest` | not started | Gate 1 | — | — |
| 2 Codex + normalization + Gemini ingest | `feat/phase2-codex-gemini-normalization` | not started | Gate 2 | — | — |
| 3 Live status | `feat/phase3-live-status` | not started | Gate 3 | — | — |
| D Design system | `docs/design-system` | not started | Gate D | — | — |
| 4 Session workspace UI | `feat/phase4-session-workspace` | not started | Gate 4 | — | — |
| 5 History and retention | `feat/phase5-history-retention` | not started | Gate 5 | — | — |
| 6 Integrations | `feat/phase6-integrations` | not started | Gate 6 | — | — |
| 7 Control | `feat/phase7-control` | not started | MVP Gate | — | — |
| v1-A | `feat/v1a-embedded-terminal` | not started | v1-A gate | — | — |
| v1-B | `feat/v1b-otlp-compare` | not started | v1-B gate | — | — |
| v1-C | `feat/v1c-mcp` | not started | v1-C gate | — | — |
| v1-D | `feat/v1d-cross-platform` | not started | v1-D gate | — | — |
| Public (optional) | `chore/public-release` | not started | Public gate | — | — |

## 3. Task ledger

Status values: todo / doing / done / blocked / waived. "done" requires the task's done-evidence. Failures, skips and waivers are recorded with output or reason.

| Task ID | Status | Evidence link | Date |
|---|---|---|---|
| P0-T11 (progress file) | done | this file | 2026-11-09 |
| Plan challenge (HARNESS_PROCESS §3.5) | done | §9a | 2026-11-09 |

## 4. Design-decision log

One entry per decision where the PRD left a detail open, per owner decision, per plan deviation, and per `record_decision` call. Newest last.

Entry format:

| ID | Date | Decision | Reason | PRD ref | `record_decision` id | Approver |
|---|---|---|---|---|---|---|
| `D-P<phase>-<nn>` | YYYY-MM-DD | what was decided | why (evidence or owner instruction) | §/FR/EC/Q | harness id or — | owner / Claude |
| D-P0-01 | 2026-11-09 | Full plan for every phase; live-agent spikes run by Claude in disposable temp profiles the owner signs in to; electron-builder moves to Phase 0 | Owner answers at Phase 0 start | HARNESS_PROCESS §3.4; App. C; §8 | — | owner |
| D-P0-02 | 2026-11-09 | OQ-X2, OQ-X4, OQ-X7, OQ-X10 resolved with the plan defaults (in-sandbox first, else per-command approval; stop live spikes on any real keychain change; branch commit before each gate review; ≤40 tiny prompts per agent in Phase 0) | Owner: "4 questions are good for default answer" | plan §6.1 | — | owner |
| D-P0-03 | 2026-11-09 | Phase 0 runs only on the reference Apple Silicon Mac; other machines (e.g. a Linux/WSL dev box) edit docs and review only | Owner answer during plan revision; plan is macOS-specific (Seatbelt, keychain, `dist:mac`) | PRD §1.4; plan §0.2 item 4a | — | owner |
| D-P0-04 | 2026-11-09 | The guard never lists, stats or reads real session stores; the owner-run `audit-sources.ts` (P0-S9-T3) stays as the one named real-data exception, recorded in AGENTS.md | Codex challenge blocker (real-store reads vs AGENTS.md); owner chose this option | PRD §8; AGENTS.md; plan P0-T04, P0-S9-T3, OQ-C1 | — | owner |
| D-P0-05 | 2026-11-09 | One-line PRD errata now: App. C `electron-builder` → Phase 0 (implements D-P0-01) | Codex challenge (plan vs PRD App. C); owner chose errata over waiting for the Gate 0 delta | PRD App. C, header | — | owner |
| D-P0-07 | 2026-11-09 | Gates require an owner-approved unpushed branch commit; the uncommitted snapshot fallback of OQ-X7 is removed (the gate waits if the commit is declined); post-freeze evidence goes into a new `docs/plans/gates/gate<N>.md` in a gate-record commit | Codex re-review round 2: the snapshot fallback could not be made safe simply (bash error handling, index preservation, promotion); owner chose deletion over a tested script | plan §2.4, P0-G-T4, PD-T03/T05, OQ-X7 | — | owner |
| D-P0-08 | 2026-11-09 | Claude second review of plan v0.2 (4 lens reviewers, each finding adversarially verified): 48 findings, 43 confirmed (about 30 unique after merging duplicates), 5 refuted; all confirmed ones applied in v0.3 per §9b. New OQ-X16 default (commands that cannot run nested in the runner's Seatbelt wrapper) needs owner approval with the plan | Gate review step (HARNESS_PROCESS §3) | plan §2.4, P0-T02–T09, P0-G-T4, P1-T01–T06, OQ-X3/X16, AGENTS.md | — | Claude (fixes); owner approved (D-P0-09) |
| D-P0-09 | 2026-11-09 | Owner approves plan v0.3 as v1.0, including the OQ-X16 default (non-nestable commands never run unwrapped), the OQ-X15 WCAG 2.2 AA default, the Gate 0 PRD delta items (incl. FR-45 `session_id`) and the §3.6 TSX RED rule (to be proven on the first `.tsx` unit) | PRD §10 owner approval of the challenged plan | plan header, progress §1–2 | — | owner |
| D-P0-06 | 2026-11-09 | Codex challenge of plan v0.1 (four parallel read-only runs, one per lens) found 19 unique findings: 3 blockers, 13 major, 3 minor (one blocker raised by two runs); all applied in v0.2 per §9a | HARNESS_PROCESS §3 step 5 | plan §2.4, §3.2, §3.6, P0-T03–T10, P0-S3-T5, PD-T01/T03, P1-T14, P3 §3.5, P4-T03, P4-T08, OQ-X7/X8/X15 | — | Claude (fixes); owner approved (D-P0-09) |

## 5. Deviations from plan or PRD

| Date | Deviation | Owner approval reference |
|---|---|---|

(none)

## 6. Spike results

All spike findings live only in `docs/plans/phase0_spikes.md` (created by P0-T10; pre-v1 spikes S2, S8 and the S10 MCP re-run append sections there). This file links to them.

| Spike | Status | Decision (one line) | Report anchor |
|---|---|---|---|
| S1 SQLite | not run | — | — |
| S3 Forwarder | not run | — | — |
| S4 Claude plugin | not run | — | — |
| S5 Codex hooks | not run | — | — |
| S6 Codex interoperability | not run | — | — |
| S7 Claude interoperability | not run | — | — |
| S9 Format survey | not run | — | — |
| S10 Network | not run | — | — |
| S11 Gemini/catalog | not run | — | — |
| S12 Capacity/latency | not run | — | — |
| S13 Passive usage/context/cost | not run | — | — |
| S2 PTY (pre-v1-A) | not run | — | — |
| S8 OTLP (pre-v1-B) | not run | — | — |

## 7. Metrics results

Every result records hardware class, macOS version, app/agent versions, corpus seed and actual DB/index sizes. Phase 0 entries are tagged "spike, not gate evidence". A miss requires explicit owner acceptance.

| M | Target (short) | Gate | Result | Pass/fail | Hardware | macOS | Versions | Seed | DB/index size |
|---|---|---|---|---|---|---|---|---|---|
| M1 | hook/report → paint p95 ≤250 ms | 3 | not measured | — | — | — | — | — | — |
| M2 | file append → paint p95 ≤1 s | 3 | not measured | — | — | — | — | — | — |
| M3 | import ≤120 s; list p95 ≤1.5 s; no frame >100 ms | 1–3 | not measured | — | — | — | — | — | — |
| M4 | idle window closed ≤250 MB, CPU ≤1% | 3 | not measured | — | — | — | — | — | — |
| M5 | idle window open ≤450 MB | 4 | not measured | — | — | — | — | — | — |
| M6 | 0 attempted non-loopback connections | 1+ | not measured | — | — | — | — | — | — |
| M7 | 0 tokens added by reporting channels | 3 | not measured | — | — | — | — | — | — |
| M8 | status detection on labeled fixtures | 3 | not measured | — | — | — | — | — | — |
| M9 | 0 egress canaries | 1 | not measured | — | — | — | — | — | — |
| M10 | MCP footprint | v1-C | not measured | — | — | — | — | — | — |
| M11 | startup visibility p95 ≤300 ms | 3, 7 | not measured | — | — | — | — | — | — |
| M12 | readiness: list ≤1.5 s, tray ≤300 ms | 4 | not measured | — | — | — | — | — | — |
| M13 | selection ≤300 ms, search ≤500 ms (T3) | 5 | not measured | — | — | — | — | — | — |
| M14 | 50 sessions, 200 events/s, 10 min | 4 | not measured | — | — | — | — | — | — |
| M15 | synthetic fourth agent via data only | 6 | not measured | — | — | — | — | — | — |
| M16 | agent interference ≤100 ms | 3 | not measured | — | — | — | — | — | — |

## 8. Owner touchpoints

| Item | Status |
|---|---|
| Approve the challenged plan | pending |
| Choose unsandboxed-run mode (OQ-X2) | done (D-P0-02); per-command approvals still asked at run time |
| Plan-revision decisions (machine, real stores, App. C errata, gate commit) | done (D-P0-03, D-P0-04, D-P0-05, D-P0-07) |
| Confirm Phase 0 installs (P0-T01) | pending |
| Sign in to temp profiles (P0-T06) | pending |
| Answer or accept defaults for open questions (plan §6) | pending |

## 9. Gate records

Post-freeze gate evidence (gate SHA, final-SHA results, Codex and Claude verdicts, dispositions, owner decision) lives only in `docs/plans/gates/gate<N>.md`, added by the gate-record commit (plan §2.4 step 6, D-P0-07); the next phase's first commit copies the outcome into §1/§2 here.

| Gate | Gate record | Outcome (filled by the next phase's first commit) |
|---|---|---|

(none yet)

## 9a. Plan challenge record (Codex, 2026-11-09, plan v0.1 → v0.2)

Baseline `master` at `e6b39ab`; diff `master...feat/phase0-spikes`. Lens verdicts: traceability "yes with fixes"; sequencing "no"; safety/privacy "no"; verification/consistency "no".

| # | Sev | Finding (short) | Disposition in v0.2 |
|---|---|---|---|
| 1 | blocker | Gate suite tests `HEAD` while review covers uncommitted changes; no full re-run after fixes; Gate 0/D review only committed diffs | Fixed: one gate SHA for suite, both reviews and owner approval; full re-run on each new SHA (§2.4, P0-G-T4, PD-T03, OQ-X7). *Historical: v0.2 also allowed a snapshot commit; removed by D-P0-07, current procedure per round 3 below.* |
| 2 | blocker | Runner refuses every path under the real home, but profiles live in the repo under home | Fixed: refuse overlap with real agent/Xaibo roots and anything outside `$P`; symlink and repo-under-home tests (P0-T05) |
| 3 | blocker | Guard lists real session stores; owner audit reads real stores | Fixed per D-P0-04: guard has no store listing; audit is the named owner-run exception (P0-T04, P0-S9-T3, AGENTS.md) |
| 4 | major | Runner sets one agent variable, no `XAIBO_DATA_DIR` | Fixed: all five variables in every profile, tested (P0-T05, §3.2) |
| 5 | major | Guard misses deletions/removals; "volatile" hides changes; post-run only | Fixed: add/modify/delete/replace/truncate and keychain removal detected and tested; stated as detection only, prevention by runner + sandbox (P0-T04) |
| 6 | major | "Zero-write probe" not proven read-only; keychain checked after login | Fixed: credential backend proven isolated from docs before any probe; probe guarded; else UNVERIFIED (P0-T06) |
| 7 | major | Phase 0 privacy check misses ports, non-UUID IDs, most secrets; not run on the whole diff | Fixed: full D-20 pattern set from Phase 0, canary tests, whole gate diff via `--stdin`, manual review of reduced evidence (P0-T08) |
| 8 | major | Guard prints names; cleanup kills by `pgrep -f` substring | Fixed: category counts only; cleanup by recorded PID + start time (P0-T04, P0-T05, P0-T09) |
| 9 | major | P0-T03 packages the S3 SEA binary before P0-S3-T5 builds it | Fixed: entry added in P0-S3-T5 |
| 10 | major | electron-builder Phase 0 vs PRD App. C Phase 1 | Fixed per D-P0-05: PRD errata |
| 11 | major | TSX units have no harness-observable RED | Fixed: node:test RED on each unit's `.ts` logic before any `.tsx`; proved on the first Phase 1 `.tsx` unit (§3.6, P4-T03, OQ-X8) |
| 12 | major | Gate D contrast target undefined | Fixed: pair inventory + OQ-X15 thresholds (WCAG 2.2 AA default), per-pair report (PD-T01/T03, Gate D checklist) |
| 13 | major | EC-15 oversized record may stay unreadable (FR-08) | Fixed: bounded streaming extraction of readable content; gap only for unreadable bytes (P1-T14, OQ-P1-06, R-P1-09) |
| 14 | major | M2 lacks usage/context/cost receipt paths | Fixed: per-path M2 measurement incl. during import (Phase 3 §3.5) |
| 15 | major | (merged into #1: Gate 0/D diff omits post-commit changes) | Fixed with #1 |
| 16 | major | (merged into #1: no full re-run after fixes) | Fixed with #1 |
| 17 | minor | Report used before P0-T10 creates it | Fixed: P0-T10 first (§0.15, P0-T01 deps) |
| 18 | minor | Progress file: OQ-X2 shown pending; stale "(no entries yet)" | Fixed in this file |
| 19 | minor | EC-102 tests lack per-turn attribution and timestamp checks | Fixed (P4-T08) |
| 20 | — | Found during revision (Claude): plan assumes the Mac; this review ran on a Linux/WSL box | D-P0-03 entry criterion 4a |

**Fix-delta re-review 1 (Codex).** *Historical: the R1 and R2 mechanics below (snapshot commit, record in progress file) were superseded by D-P0-07 and rounds 2–3.* Of the 19: 12 resolved, 7 partially resolved (#1, #2, #5, #6, #15, #16, #17). Verdict "no". New findings and dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| R1 | blocker | Snapshot command can leak `GIT_INDEX_FILE` on failure; ignored tracked files can drop out | Fixed: subshell with `set -eu`, trap cleanup, index under `.git/`, `read-tree HEAD` seed, before/after check of branch and real index (§2.4 step 1) |
| R2 | blocker | Gate SHA recorded inside files that are part of that SHA; verdicts written after freeze | Fixed: gate SHA only in `.handoff/` during the gate; verdicts, dispositions and approval go in a separate gate-record commit checked by `git diff --stat` (§2.4 steps 1 and 8, P0-G-T4, PD-T05) |
| R3 | major | Gate D revisions do not re-run the design checks | Fixed: full PD-T03 checklist incl. per-pair contrast re-run on each new SHA (PD-T04) |
| R4 | major | Runner treats `GEMINI_CLI_HOME` as a root (it is the store's parent) | Fixed: real root is `${GEMINI_CLI_HOME}/.gemini`; tests with a real-home override and a custom parent (P0-T04, P0-T05) |
| R5 | major | Guard `MATCH` vs an expected new temp keychain item contradict | Fixed: `--expect-new-keychain <svce>` for the one pre-identified item; tests (P0-T04, P0-T06) |
| R6 | major | `--version` runs before the credential-backend check | Fixed: backend check is docs-only and comes first; first `--version` per agent is guarded and must `MATCH`; entry criterion 5 no longer runs agents in the real env (§0.2, P0-T05, P0-T06) |
| R7 | minor | P0-T01 status check ignores the earlier P0-T10 report | Fixed: before/after comparison (P0-T01) |
| R8 | major | No enforced write-deny for owner-run commands outside the sandbox | Fixed: runner wraps unsandboxed commands in a generated `sandbox-exec` deny profile with a canary self-check, refuses otherwise; keychain writes covered by guard + backend check (P0-T04, P0-T05) |
| R9 | minor | Gemini override experiment conflicts with the runner's fixed env | Fixed: runner `--gemini-layout unset\|custom` mode, tested (P0-T05, P0-S11-T1) |

**Fix-delta re-review 2 (Codex).** R3–R7 and R9 resolved; R1, R2, R8 partially; of the earlier partials #2, #5, #6, #17 resolved, #1, #15, #16 partially. Verdict "no". New findings and dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| S1 | blocker | Snapshot command can continue after a failed git step in bash (`set -e` suppressed under `\|\|`) | Removed: snapshot fallback deleted (D-P0-07) |
| S2 | major | Checks cannot prove the real index unchanged; `reset --mixed` promotion can drop staging | Removed with the fallback (D-P0-07); gates freeze on a clean committed tree |
| S3 | major | Post-freeze evidence written into the frozen tree; record commit checked only by `--stat` | Fixed: post-freeze evidence only in new file `docs/plans/gates/gate<N>.md`; check is `git diff --name-status <gate-sha> HEAD` = that one added file (§2.4 steps 1, 4, 8; P0-G-T4; PD-T05). *Historical: its `HEAD~1` parent check was tightened by T2 below; current check in §2.4 step 8.* |
| S4 | major | Canary does not prove each deny rule works or that temp-profile writes still work | Fixed: per-root deny tests with symlink, nested, quoting and missing-root cases; temp-profile writes and an agent stub must succeed; one rule per resolved root checked at runtime; fail closed (P0-T05) |

**Fix-delta re-review 3 (Codex).** S1, S2, R1 resolved; S3, S4, R2, R8, #1, #15, #16 partially. Verdict "no". New findings and dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| T1 | major | Deny tests miss the standalone `~/.claude.json` and delete/replace/rename through the parent | Fixed: added, existing and absent, all fail closed (P0-T05) |
| T2 | major | Record check `HEAD~1` allows a merge commit with an unreviewed parent | Fixed: exactly one parent = gate SHA via `rev-list --parents`; regular-file mode; clean worktree (§2.4 step 8) |
| T3 | major | No loop for fixes accepted after Claude's review | Fixed: any accepted post-freeze fix is a new SHA and restarts suite + Codex + Claude (now §2.4 step 4) |
| T4 | minor | Push/PR stated unconditionally | Fixed: each only when the owner asks; D-P0-07 replaces HARNESS_PROCESS §3.7 uncommitted review for gates (now §2.4 step 6) |
| T5 | minor | Historical dispositions read as current procedure | Fixed: marked historical in this section |

**Fix-delta re-review 4 (Codex).** T1–T4, S3, S4, R2, R8, #1, #15, #16 resolved; T5 partially (S3 row still read as current; marked historical). **Codex verdict: "yes with fixes" for Claude second review and owner approval**; the one fix is applied.

## 9b. Claude second review record (2026-11-09, plan v0.2 → v0.3)

Diff `master` → working tree. 43 of 48 findings confirmed by a skeptic pass; duplicates merged below. Refuted (5): repo-wide tools reading in-repo temp credentials (graphify honours `.gitignore`); missing owner touchpoints (each task names its owner action); progress showing gate not passed after merge (by design, D-P0-07); P0-G-T5 "commit" wording (consistent with step 6); a "dead" `/logout` rule (used at retirement).

| # | Sev | Finding (short) | Disposition in v0.3 |
|---|---|---|---|
| C1 | major | Runner's `sandbox-exec` wrapper nests Seatbelt around Codex's tool sandbox and Electron helpers; no rule for when to wrap; deny tests cannot run inside the Claude sandbox | Runner always runs unsandboxed and always wraps; nesting probe on the Mac first; exceptions per new OQ-X16 (owner approval); real-sandbox tests in `spike:test:unsandboxed` (P0-T04, P0-T05, entry criterion 4) |
| C2 | major | Keychain items discovered once then polled by name: new names or second accounts invisible | Every snapshot enumerates attributes via `dump-keychain`; tests for new name and second account (P0-T04, OQ-X3) |
| C3 | major | Gate `npm ci` / `dist:mac` download Electron into `~/Library/Caches` | Absolute repo cache env in §2.4 step 1; `dist:mac` defaults only; `~/Library/Caches` before/after check |
| C4 | major | Opaque-ID rule flags ordinary identifiers and lockfile integrity; two scanners with drifting patterns | One scanner `scripts/privacy-scan.ts` from P0-T08 (P1-T02 extends, P1-T03 moves the list to `src/shared`); narrowed rule; lockfile excluded from diff scan; negative tests |
| C5 | minor | Write-only deny lets a mis-isolated CLI read real stores | Profile denies `file-read*` and `file-write*`; read test |
| C6 | minor | AGENTS.md "one exception" narrower than PRD §8 and the plan's later owner real-data steps; no Gate D exception | AGENTS.md reworded (stores defined; named owner-started sessions; guard reads named); Gate D exception added |
| C7 | minor | FR-45 `session_id` added by plan default only | Added to the P0-G-T2 PRD delta; P3-T14 captures it only after approval |
| C8 | minor | Stale status (branch "no commits", review pending, per-phase row) | Fixed (plan §0.1, header; progress §1/§2) |
| C9 | minor | One-time unsandboxed companion approval treated as standing | §2.4, §3.5, Phase 1 entry: per PRD App. B item 6 and OQ-X2 |
| C10 | minor | Gate SHA file deleted before step 8 needs it; fixed worktree path breaks re-runs; pre-freeze run undefined; P0-G-T4 a drifting copy of §2.4 | §2.4 restructured: step 0 pre-freeze, `mktemp` worktree removed after each run, SHA file deleted last; P0-G-T4 now a pointer plus Gate 0 additions |
| C11 | minor | Controlling Claude session's token refresh confounds the keychain check | P0-T06 steps 2–5 with no real session of that agent running; Claude steps owner-run with Claude Code exited; any change = stop |
| C12 | minor | PID recording vs `exec`; children missed | Own process group via `perl setpgrp`; leader record before exec; cleanup signals the group (P0-T05, P0-T09) |
| C13 | minor | Runner "targets" undefined; `XAIBO_SPIKE_RAW` outside `$P` | Targets defined; `--spike <id>` with allowed roots (P0-T05) |
| C14 | minor | Env test fails on shell-added variables | Uses `/usr/bin/env` directly (P0-T05) |
| C15 | minor | `hdiutil` image without filesystem | `-fs HFS+`, attach/detach (S3) |
| C16 | minor | Smoke check misses Preferences/HTTPStorages writes | `find ~/Library` name check (P0-T03) |
| C17 | minor | Spike builder config packages the repo root | `directories.app` and `main` set (P0-T03) |
| C18 | minor | Phase 1 tasks use artifacts created later (build, Playwright config, T06 order) | Build Done moved to T04, E specs to T05, T06 executed after T10 |
| C19 | minor | Typecheck does not cover `scripts/`/`test/` in Phase 0 | `tsconfig.scripts.json` (P0-T02) |
| C20 | minor | S4-T3 calls an undefined guard tree mode | `find … shasum` recipe |
| C21 | minor | G0-12 extra grep flags synthetic IDs, undefined exceptions | Grep removed; scanner covers it |
| C22 | minor | Phase 0 lacks a harness-os availability entry criterion | Entry criterion 7 |
| C23 | minor | Phase D calls a scanner and a full suite not on `master` yet | Scanner exists from Gate 0; PD-T03 freeze = commit and SHA rules only |
| C24 | minor | Progress gate table cannot be filled under D-P0-07 | §9 now links gate files |
| C25 | minor | Stale refs (OQ-X1–X14, guard output wording, ambiguous "§3.5") | Fixed |

**Codex fix-only re-review of v0.3 (2026-11-09).** C6, C7, C9, C11, C13–C17, C19–C24 resolved; C1–C5, C8, C10, C12, C18, C25 partially. Verdict "no". New findings and dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| V1 | critical | OQ-X16 default ran non-nestable commands without the read/write barrier | Default changed to fail safe: never unwrapped; the owner chooses per command to disable the agent's own sandbox (runs inside the wrapper) or mark the part UNVERIFIED (OQ-X16, P0-T04, P0-T05) |
| V2 | major | Nesting probe relied on an offline, signed-out `codex exec` tool call | Probe uses `/usr/bin/sandbox-exec` nested directly (Codex's mechanism) and the spike app smoke; failures classified (P0-T05) |
| V3 | major | Keychain filter hid items with unexpected names | All generic-password items compared privately; agent items → DIFF; new non-agent items → `unmatched-new`, owner check before continuing; test with an unrelated name (P0-T04) |
| V4 | major | Cache vars only on `npm ci`; shallow cache check | Exported for the whole suite; recursive `find … -newer` over electron/xaibo cache paths (§2.4 step 1) |
| V5 | major | Opaque rule contradicted the lockfile-integrity negative test | Narrow `"integrity": "sha512-…"` exemption (opaque rule only; plain, diff and history forms); realistic generated test values; secret on such a line still flagged (P0-T08) |
| V6 | major | Gate 1/3 lists out of freeze order; license step after the record commit | License list moved into step 0; §2.4 now steps 0–6; Gate 1 and Gate 3 tasks rewritten as "GS 0–6 plus additions" |
| V7 | major | Cleanup missed children after the group leader exits | Runner supervisor stays alive, kills and reaps its group, cannot be reused while members live; test (P0-T05, P0-T09) |
| V8 | major | P1-T04 build/E2E needed migrations and service from later tasks | Minimal `src/service/index.ts` and single fork in T04; migrations copied only if present |
| V9 | minor | Stale `--check` in P0-G-T2; header cited §9a | Fixed |

**Final Codex check (2026-11-09).** V1, V2, V4, V5, V8, V9 resolved; V3, V6 partially; V7 unresolved. Verdict "no". Dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| W1 | major | Supervisor inside its own process group cannot wait for the group to empty | Supervisor stays outside the child's group (child calls `setpgrp`); TERM then KILL after 5 s; tests for normal exit and cleanup-triggered shutdown (P0-T05) |
| W2 | major | Changes to existing keychain items with unrecognised names were ignored | Any non-agent add/modify/remove → `unmatched-change`, pause for owner; owner may mark a hashed service non-agent; compare rules reconciled; tests (P0-T04) |
| W3 | minor | Gate 3 handoff names escaped the GS deletion pattern | Renamed `.handoff/gate3-<chunk>.md` (P3-T17) |

**Codex re-review of W1–W3.** W3 resolved; W1, W2 partially. Dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| X1 | major | Supervisor startup/shutdown races; group ID reuse; grandchildren cannot be reaped | Requirement stated; handshake over a pipe, TERM-ignoring sentinel keeps the group ID alive until signalling ends, fail closed on setup errors; waits for disappearance, does not reap; five race tests (P0-T05) |
| X2 | major | Keychain outcomes for mixed changes inconsistent across rules, tests and P0-T06 | Precedence defined (DIFF > unmatched-change > MATCH/expected-new); tests for expected+agent and expected+unrecognised; P0-T06 step 5 aligned (P0-T04, P0-T06) |

**Codex re-review of X1–X2.** X2 resolved; X1 partially. Dispositions:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| Y1 | major | Group kill cannot stop a descendant that leaves the group or session | Guarantee limited to the group; escapers detected via a per-run `XAIBO_RUN_TOKEN` environment marker after shutdown, reported as `survivors <n>`, fail closed; `setsid` test (P0-T05) |
| Y2 | major | Handshake failure after the sentinel starts leaves it running | Handshake now precedes the sentinel; post-handshake failures kill the known group; tests force failure before and after (P0-T05) |
| Y3 | minor | P0-T09 still said "reaps" | Fixed |

**Codex re-review of Y1–Y3.** Y2, Y3 resolved; Y1 partially. Instead of patching the supervisor again, it was simplified to standard job control:

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| Z1 | major | Token scan misses an escaped descendant that clears its environment | Limit stated explicitly; backstop: processes started during the block and absent before are listed locally and pause live work for the owner; tests for both escape cases with before/after states (P0-T05) |
| Z2 | major | Group ID could be reused between acknowledgement and sentinel start | Sentinel and handshake removed: parent and child both `setpgid`; the leader is not reaped until group signalling ends, so its ID stays reserved (P0-T05) |
| Z3 | minor | "No process remains" contradicted the escaped-survivor case | Expected states before and after test cleanup stated |

**Focused Codex check of Z1–Z3.** Z1, Z3 resolved; Z2 partially. **Codex verdict: "yes with fixes"** for owner approval. The one fix (applied): the parent's `setpgid` returning `EACCES` after the child has exec'd is the expected macOS race; the parent verifies the child's group ID and continues; genuine setup failures stop the group before reaping; test added (P0-T05).

## Update rule

- Update in the same working change as each task, as soon as it becomes done or blocked; on every design decision where the PRD left a detail open; on every owner decision; and before each gate review (the review diff includes this file). Never batch updates at phase end.
- Spike findings only in `phase0_spikes.md`; this file links to them.
- Repo privacy rules apply in full: no counts, paths, IDs, ports or prompts from the owner's machine.
