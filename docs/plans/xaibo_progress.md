# Xaibo progress

Live status file for `docs/plans/xaibo_plan.md` (HARNESS_PROCESS §2, PRD §1.6 item 4). It must always show the real status.

## 1. Current status

| Item | Value |
|---|---|
| Current phase | **Phase 0: spikes complete; Gate 0 pre-freeze** |
| Branch | `feat/phase0-spikes` |
| Plan version | Approved v1.0 (2026-11-09) |
| Gate state | Gate 0 not started. Phase 0 runs only on the reference Mac (D-P0-03). |
| Next step | Gate 0: pre-freeze review fixes, then owner OK for the gate commit, Codex review, Claude review, owner stop |
| Blockers | None |
| Baseline for Gate 0 review | `master` at `e6b39ab` |

## 2. Per-phase status

| Phase | Branch | Status | Gate | Gate date | PR |
|---|---|---|---|---|---|
| 0 Spikes | `feat/phase0-spikes` | spikes complete (S1–S13; S2/S8 pre-v1); Gate 0 pre-freeze | Gate 0 | — | — |
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
| P0-T10 (report skeleton) | done | `phase0_spikes.md` (all criteria UNVERIFIED; 2-lens check: 1 minor finding, applied) | 2026-11-10 |
| P0-T01 (pinned installs, local caches) | done | `phase0_spikes.md` § Environment | 2026-11-10 |
| P0-T02 (spike layout, TS config, bench helpers, scripts) | done | `spikes/shared/bench.test.ts` RED (module missing) → GREEN 5/5; `npm run typecheck` green. Root `package.json` gets `"type": "module"`; `tsconfig.scripts.json` and the `test`/`privacy:scan` scripts land with their first files in P0-T08 (an empty `include` fails tsc); `spike:sN` scripts land with each spike | 2026-11-10 |
| P0-T03 (packaged spike app, minimal `dist:mac`) | done | smoke RED (binary missing) → pass; `phase0_spikes.md` § Environment (incl. the `~/Library/Preferences` finding) | 2026-11-10 |
| P0-T04 (real-profile guard) | done | `spikes/shared/guard.test.ts` RED (module missing) → GREEN 14 tests (all plan cases incl. expect-new precedence and no-names output); real `baseline` snapshot + compare = MATCH. Owner adjudication of `unmatched-change` is `guard.ts accept-unmatched <label>` (marks those hashed services non-agent) | 2026-11-10 |
| P0-T05 (isolated temp-profile runner) | done (agent `--version` runs wait for P0-T06 step 1) | RED (modules missing) → GREEN: `spike:test` 20, `spike:test:unsandboxed` 7 (deny profile, supervisor races/escalation/cleanup, escape cases, end-to-end env). Nesting probe: neither nested `sandbox-exec` nor Electron helpers nest (OQ-X16 applies). Files: `spikes/shared/{in-profile.sh,in-profile.ts,supervise.pl}` | 2026-11-10 |
| P0-T07 (fixed synthetic prompt set) | done | defined in plan P0-T07; used verbatim by later blocks | 2026-11-10 |
| P0-T08 (recorder, reducer, privacy scanner) | done | RED (modules missing) → GREEN: `npm test` 19 (all canary classes flagged with masked output; identifiers, synthetic UUIDs, example emails, git SHAs, lockfile integrity plain/diff pass; secret on an integrity line flagged); `spike:test` 23 incl. reducer (no free strings, masked non-identifier keys) and recorder `--self-test`; `privacy:scan` clean over `spikes docs/plans scripts test`. home-path rules match absolute paths only (false positive on a relative path fixed) | 2026-11-10 |
| Review of P0-T04/T05 (Claude, 3 lenses + skeptic) | done | 10 findings: 5 confirmed and fixed (major: Node-spawned descendants never inherit the marker fd → process-tree tracking added; minor: on-disk letter case in deny rules via native realpath; `ps`/`lsof` failures now fail closed; `block-end` excluded itself; guard child stderr discarded), 5 refuted (HOME-override scenario, pids-file open failure, marker left on exit 124, unsupervised `--version` probe, baseline overwrite). Suites after fixes: `spike:test` 24, `spike:test:unsandboxed` 8, `npm test` 19; baseline retaken = MATCH | 2026-11-10 |
| P0-T06 step 1 (credential backends, docs only) | done | `phase0_spikes.md` § Guard: Claude per-config-dir keychain name (isolated), Codex file store (isolated), Gemini isolated only with `GEMINI_FORCE_FILE_STORAGE=true` (now set by the runner for every profile; guard stats `gemini-credentials.json`). Installed versions match the pins by install path | 2026-11-10 |
| P0-S1-T1..T5 (SQLite engine) | done | `spike:s1` RED ("mode not implemented") → probe pass (main + worker); crash: stub writer fails (c) on every restart (detection), real writer 200/200 + 20/20 (re-run on the final build: same result); decision recorded (id 16). The app's restart backoff resets after 250 ms healthy uptime (spike-only, `ponytail:` note) | 2026-11-10 |
| P0-T06 steps 2–6 (keychain check, owner sign-in, PR-OK) | done for Claude and Codex; Gemini skipped (owner) | `phase0_spikes.md` § Guard: both isolated (Claude temp file store, Codex temp `auth.json`), guard MATCH around each sign-in, PR-OK answered with transcripts under the temp roots; one-command owner script `spikes/shared/signin.sh` | 2026-11-10 |
| P0-S3-T1..T9 (forwarder) | done | benches n = 1,000 × 9 modes × candidates, e2e hops to paint, live temp Claude runs (guard MATCH, backstop 0 ours); decision with owner (record_decision 23). Bench bugs found and fixed on the way (idle-run counting, cross-candidate ids, occluded window) | 2026-11-10 |
| P0-S4-T1..T7 (Claude plugin) | done | `spikes/s4/run.ts`; evidence `spikes/s4/evidence/`; guard MATCH; backstop 0; hook fixtures deferred to the S9 fixture set | 2026-11-10 |
| P0-S5-T1..T5 (Codex hooks/trust) | done; T6 plugin route not-run (optional) | two owner TUI sessions; guard MATCH; backstop 0 ours | 2026-11-10 |
| P0-S9-T1, T2, T3, T4, T5, T6 (format survey) | done (T6 not-triggered, optional); T7 fixtures done (53/53 tests) | `scripts/audit-sources.ts` (TDD + adversarial review, 5 defects fixed); facts/schemas `spikes/s9/`; zstd probe; owner audit answered | 2026-11-10 |
| P0-S12-T1..T7 (capacity, personal profile) | done | workflow (corpus 2.61 GiB synthetic, queries, watchers, load A/B/C + sweep + ~3× probe, usage/retention, synthesis); FSEvents measured afterwards unsandboxed; record_decision 28 | 2026-11-10 |
| P0-S13-T1..T9 (passive usage/context/cost) | done; T6 done in S6/S7 except a window-size change and Codex `/model` (not observed) | `overhead.ts` RED (200 ms delay → exit 1) → SEA pass, system Node fail; `spike:test` 48/48, unsandboxed 12/12; `spikes/s13/evidence/`; record_decision 32 | 2026-11-10 |
| P0-S10-T1..T4 (network) | done | controls first (6 kill controls + NetLog detected, baseline quiet), then 10 scenarios: 0 unexpected deaths, lsof 0/2,410, NetLog 0 non-local; re-run after the review with stricter checks: 8 kill controls + NetLog, 0 deaths, lsof 0/2,240, NetLog 0; `spikes/s10/evidence/s10.json`; guard: 0 agent keychain, 0 credential; owner-session config and non-agent keychain changes adjudicated (D-P0-32); record_decision 34 | 2026-11-10 |
| P0-S6-T1..T3, T6 (Codex interop); T4/T5 untested with reason | done | `spikes/s6/run.ts`, `spikes/s6/evidence/s6.json`; 13 launches with a prompt, 8 reached the model; resume positive control (no prompt); guard MATCH or owner-session config change, 0 credential, 0 agent keychain; one non-agent keychain change open for the owner; record_decision 35 | 2026-11-10 |
| P0-S7-T1..T4, T7 (Claude interop); T5/T6 untested with reason | done on Claude Code 2.1.322 | `spikes/s7/run.ts`, `spikes/s7/elicit-mcp.test.ts` RED → GREEN 2/2, `spikes/s7/evidence/s7.json`; 20 prompts attempted; record_decision 36 | 2026-11-10 |
| S13-T6 leftovers (statusLine after `/compact`, model and effort switch; Codex `/compact`) | done; window-size change and Codex `/model` not observed | `spikes/s7/evidence/s7.json` `s13`, `spikes/s6/evidence/s6.json` `compact` | 2026-11-10 |
| P0-G-T2 (PRD delta v1.1) | done, pending owner approval | workflow: 8 region drafters + 8 adversarial checkers → 75 patches kept, 11 follow-on edits from the checkers, 3 App. D rows, history line; `privacy:scan docs/PRD.md` clean | 2026-11-10 |
| Gate 0 suite, pre-freeze (working tree) | typecheck, `npm test` 53/53, `dist:mac`, smoke, privacy scan green; `spike:test` 49/50 and unsandboxed 11/12 under heavy load (two timing tests), both green on rerun on a quiet machine (G7 3/3, KILL escalation 2/2) | this run; final run on the gate SHA from a clean checkout follows | 2026-11-10 |
| P0-S11-T1..T10 (Gemini and catalog) | done for static and catalog work; live parts UNVERIFIED (owner skip, D-P0-19) | `phase0_spikes.md` § S11; `spikes/s11/`; record_decision 27 | 2026-11-10 |
| Pre-freeze Claude review (6 lenses, 2 skeptics per finding) | done | 58 findings: 36 upheld by both, 11 split, 11 refuted; fixes applied to the report, PRD delta, progress file and spike code; S6/S7 evidence recomputed from raw local data (no prompts); S10 re-run with stricter checks | 2026-11-10 |
| P0-G-T1 (report complete), P0-G-T3 (decision records) | done; owner items open (§8) | decisions 16, 23–28, 32–37; `phase0_spikes.md` §5 | 2026-11-10 |
| P0-T09 (cleanup), final `baseline` compare | P0-T09 after approval (P0-G-T5); `baseline` compare not possible (snapshot lost with the emptied `.cache/`) | report § Guard | 2026-11-10 |
| Gate 0 suite after the review fixes (working tree, quiet machine) | typecheck green; `npm test` 53/53; `spike:test` 50/50; `spike:test:unsandboxed` 12/12; `dist:mac` and S10 green; `privacy:scan` clean over `docs/plans`, `docs/PRD.md`, `spikes`, `scripts`, `test` | this run; the clean-checkout run on the gate SHA follows the gate commit | 2026-11-10 |
| Gate 0 review fixes (round 1) | done | 20 findings fixed: runner (supervised version probe, registration failure stops the group), S1 orphan check by pid + start time, S3 never-closed stdin and paint ack (re-measured), spool counter reset, scanner (JSON-escaped Windows paths, fixture diff headers), S10 (clean service exit, shutdown-attempt control, drained output; re-run), S7 anchored elicitation check (recomputed), tee field allowlist (overhead re-run), S12 fresh-result and null checks, PRD/report consistency; owner OK for the fix commit | 2026-11-10 |

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
| D-P0-10 | 2026-11-10 | P0-T01 adds one step: Electron 45 no longer downloads its binary on postinstall, so the binary is fetched explicitly with `install-electron` using the same `electron_config_cache` (plus `NODE_USE_ENV_PROXY=1` inside the Claude sandbox). Every Electron launch unsets the inherited `ELECTRON_RUN_AS_NODE` | Observed at install (`phase0_spikes.md` § Environment); same cache location and pins as planned | plan P0-T01, §3.3 | — | Claude |
| D-P0-11 | 2026-11-10 | P0-T03 builder config: `electronDist` = installed `node_modules/electron/dist` (no Electron download at package time; electron-builder 26's downloader ignores `ELECTRON_CACHE`); `dist:mac` also defaults `electron_config_cache`; ad-hoc `codesign --force --deep --sign -` post-step is part of `dist:mac` (the plan's conditional fallback, triggered); `renderer.js` added to builder `files` (omitted in the plan's list); the app takes its mode from `XAIBO_SPIKE_MODE` | Observed during P0-T03 (`phase0_spikes.md` § Environment) | plan P0-T03, §2.4 step 1 | — | Claude |
| D-P0-12 | 2026-11-10 | P0-T05 escape detection: process-tree tracking at each 50 ms poll (pid + start time) plus an inherited marker fd + `lsof`, instead of the `XAIBO_RUN_TOKEN` environment scan (token kept as a label); marker in the system temp dir because the harness-os VM holds handles on new repo files. Stated limit: a double fork that detaches within one poll gap and holds no marker fd; block backstop as plan Z1 | macOS 27.2 exposes no process environments to a normal user (`ps -E`), verified; Gate 0 reviewers to check | plan P0-T05 (Y1/Z1) | — | Claude (owner/Codex review at Gate 0) |
| D-P0-13 | 2026-11-10 | P0-T05 runner details the plan left open: cwd stays if allowed, else the profile `home`; the supervisor makes the command's group the terminal foreground group (`tcsetpgrp`) so interactive agents (owner `/login`) work; the version-freeze check runs only when the command is the agent itself (so no agent binary runs before P0-T06 step 1); `supervise.pl` has test-only fault-injection hooks (`XAIBO_SUPERVISE_TEST`), which never pass through `env -i` | Needed for interactive sign-in and the P0-T06 ordering rule | plan P0-T05, P0-T06 | — | Claude |
| D-P0-14 | 2026-11-10 | Runner sets `GEMINI_FORCE_FILE_STORAGE=true` in every profile (like the other isolation variables) | Gemini 0.46.0 otherwise stores OAuth tokens in one fixed-name keychain item shared by all profiles; a temp sign-in could overwrite the real one (P0-T06 step 1 evidence) | plan P0-T05, P0-T06, OQ-X4 | — | Claude |
| D-P0-15 | 2026-11-10 | OQ-X1: temp profiles live outside the repo at `~/.xaibo-spike-profiles/<agent>-<slot>/` (0700), not `.cache/profiles/`; kept until Gate 6 as planned | Owner answer. Evidence: the harness-os VM mounts the repo and holds handles on new files in it | plan §3.2, P0-T05, OQ-X1 | — | owner |
| D-P0-16 | 2026-11-10 | OQ-X16 Codex: the temp `config.toml` sets `sandbox_mode = "danger-full-access"` (plus `check_for_update_on_startup = false`, `cli_auth_credentials_store = "file"`), so Codex tool commands run inside the runner's deny wrapper; recorded as a behaviour change under test for the affected S5/S6/S13 criteria | Owner answer; nesting probe (1) failed | plan OQ-X16, P0-T05 | — | owner |
| D-P0-17 | 2026-11-10 | OQ-X16 VS Code (conditional S6-T4/S7-T5): may run inside the wrapper with `--no-sandbox`, with care: trusted installed app only, isolated `--user-data-dir`/`--extensions-dir`, only the agent's own extension, only the throwaway project; Claude confirms the exact launch with the owner first | Owner answer ("if trusted sources with no harm to the device, be careful"); nesting probe (2) failed | plan OQ-X16, S6-T4, S7-T5 | — | owner |
| D-P0-18 | 2026-11-10 | Guard refinement: `~/.claude/plugins` tree and `known_marketplaces.json` fingerprinted by names only (marketplaces/plugins present), not contents; all other files unchanged; new `baseline` taken (old kept locally) | Owner's running Claude Code refreshes plugin marketplaces/caches continuously, which paused every live block; temp runs cannot write there (sandbox-denied) and a new/removed plugin or marketplace is still a DIFF. Gate 0 reviewers to check | plan P0-T04 | — | owner |
| D-P0-19 | 2026-11-10 | Gemini live parts skipped: S11 live criteria (incl. core-required C1–C5) and Gemini parts of S9/S13 stay UNVERIFIED and go to report §4 as a required-scope miss; static/package-based S11 work (catalog, validator, settings schema, retention keys from the installed package) still runs | Google rejected personal "Sign in with Google" for Gemini CLI 0.46.0 ("no longer supported for Gemini Code Assist for individuals"); owner declined API key/Vertex | PRD §10 (S11 required scope), plan S11, OQ-C14 | — | owner |
| D-P0-20 | 2026-11-10 | Adjudicated guard results: config DIFFs on `~/.claude/plugins`, `known_marketplaces.json` and `~/.codex/config.toml` are the owner's own sessions (Claude Code restart, Codex app closed); the non-agent keychain services marked non-agent (`accept-unmatched`) | Owner answers; temp runs are sandbox-denied from those paths; 0 agent keychain changes | plan P0-T04, §3.2 | — | owner |
| D-P0-21 | 2026-11-10 | The SEA is built with the official Node 26.10.0 macOS arm64 tarball (checksum-verified against nodejs.org SHASUMS) kept in git-ignored `.cache/node-official/`, dev-time only | Homebrew Node is a shared-library build with SEA disabled; owner approved the download | plan P0-S3-T5, OQ-A4 | — | owner |
| D-P0-22 | 2026-11-10 | S3: SEA forwarder, private socket, commit ack, Stop synchronous, others async, own deadline = 100 ms − startup p95; M16 50-way burst miss accepted | Owner choice among the §4 options; evidence in § S3 | PRD Q7, Q17, M16; plan OQ-A1, OQ-A2 | 23 | owner |
| D-P0-23 | 2026-11-10 | S9-T3 owner audit: the owner ran `scripts/audit-sources.ts` and shared its aggregate output in chat instead of numberless answers; Claude derived the numberless answers and only those are recorded; the audit's pinned known types were aligned to the S9-T4 observations before the run | Owner choice; plan intended Claude never sees raw output; output contains counts and type names only (no paths, IDs, content) | plan P0-S9-T3, D-P0-04 | — | owner |
| D-P0-24 | 2026-11-10 | S12 runs at a personal-usage profile (~1,500 sessions, ~1–2 GiB DB, 5 live sessions at ~20 events/s with bursts to 50, 1,000 watched files, 2 quota streams × 45 days) plus one ~3× scale-up probe naming the first degrading metric, instead of the plan's ≥10 GiB / 50 sessions / 200 events/s. S12-C1–C3 become narrowed. Whether M14 and EC-87 keep plan scale at Gates 4/5 is a Gate 0 PRD-delta question | Owner: "we don't have to test that big, just be ready for scale up, assume only me" | PRD §10 S12 row, M14, EC-87; plan P0-S12 | — | owner |
| D-P0-25 | 2026-11-10 | Third agent: propose replacing Gemini CLI with the Antigravity CLI (`agy`) in the Gate 0 PRD delta; evaluate `agy` (temp-profile isolation incl. its login, hooks, JSONL transcripts, resume, retention) in Phase 2 where the third-agent adapter is built; the Antigravity IDE is not the observation target | Gemini CLI personal sign-in rejected by Google, which points users to Antigravity; public (unverified) sources describe `agy` hooks and JSONL transcripts under `~/.gemini/antigravity-cli/`; owner installed the IDE; owner chose decide-at-Gate-0 | PRD §10 S11 row, Q18; plan S11 | — | owner |
| D-P0-26 | 2026-11-10 | Larger-scale targets (M13 on ≥10,000 sessions / ≥10 GiB with a 200 MB transcript; M14/EC-57 50 sessions at 200 events/s for 10 min; EC-87) are kept but measured at the end, after the personal-profile path; the Gate 0 PRD delta words this as a deferred scale-up stage, not a relaxation | Owner: "the larger scale up keep in the end" | PRD M13, M14, EC-57, EC-87, Q19; D-P0-24 | — | owner |
| D-P0-27 | 2026-11-10 | S13: statusLine tee ships as a SEA binary; Claude readings carry "Account scope unverified"; Codex uses a local salted hash of `creator_account_id` as an epoch marker only, never the raw value (PRD §5.11 clarification goes into the Gate 0 delta) | § S13 evidence: added wait p95 33–78 ms on the SEA, 124–168 ms on plain Node; no account identifier in the Claude statusLine | PRD §5.11, §5.12, FR-45, FR-51; plan P0-S13 | 32, 33 | owner (2026-11-10: "let's do the hash") |
| D-P0-28 | 2026-11-10 | S13 evidence is one file (`spikes/s13/evidence/s13.json`) plus the two overhead files, not one file per task; the Codex subset check reuses the S9 aggregate booleans instead of a new `subset-check.ts`; the official Node tarball was fetched again (same checksum check) after the local cache was emptied | Same facts, fewer files; the raw probe output is no longer on disk | plan P0-S13-T1..T9; D-P0-21 | — | Claude |
| D-P0-29 | 2026-11-10 | S10 audit method: a Seatbelt profile that kills a process on its first non-loopback or DNS attempt, around the packaged app run with `--no-sandbox`; counting kernel log lines is dropped as proof | The kernel log dropped 4 of 12 identical denials; Chromium's sandbox cannot start inside another Seatbelt profile; owner allowed runs outside the Claude sandbox in the project folder ("as long as it's good and trust sources, you verify") | PRD §10 S10 row, M6, EC-60; plan P0-S10 | 34 | Claude (method), owner (unsandboxed runs) |
| D-P0-30 | 2026-11-10 | Interactive agent TUIs are driven through the system `screen` tool (`spikes/shared/tui.ts`) instead of owner-typed sessions | `expect` could not drive the TUIs; `screen` is a full terminal emulator already on macOS (no install) | plan S6, S7, OQ-B5 | — | Claude |
| D-P0-31 | 2026-11-10 | Claude prompt budget raised: up to 20 more tiny synthetic prompts in the temp Claude profile for S7 and the S13 leftovers (the earlier cap was 40 per agent, D-P0-02; about 31 sessions were already used). Codex stays inside its cap | Owner answer | plan OQ-X10 | — | owner |
| D-P0-32 | 2026-11-10 | S10 guard result adjudicated: the real-config and non-agent keychain changes are the owner's own sessions; those services are marked non-agent (`accept-unmatched`) | Owner answer; 0 agent keychain and 0 credential changes; the spike app has no code path to them | plan P0-T04, §3.2 | — | owner |
| D-P0-33 | 2026-11-10 | The Claude Code install auto-updated from the pinned 2.1.319 to 2.1.322 during Phase 0; S7 and the S13-T6 leftovers are recorded as 2.1.322 evidence, earlier Claude evidence stays 2.1.319; Gate 1 re-runs the S9 fact extractor on the installed version | Observed (`claude --version`, install date); the runner's freeze check only detects a change during one run | plan §3.2 version freeze, P0-T06; PRD App. E #14 | 37 (proposal), 38 (marked pending) | Claude; owner decision at Gate 0 (report §4) |
| D-P0-34 | 2026-11-10 | Gate 0 owner answers: Claude 2.1.322 accepted for the compatibility matrix (Gate 1 re-checks the S9 facts on the installed version); dependency list approved as listed (PRD v1.1 App. C; `ajv` 8.20.0 at Phase 1 start) | Owner answers | G0-5, G0-10; D-P0-33 | 39 | owner |
| D-P0-35 | 2026-11-10 | Guard (owner delegated: "you decide"): the three non-agent keychain changes (`s6b-pre`, `s7d-pre`, `s10b-pre`) are treated as owner activity and left unmarked, so the guard keeps reporting those services; the lost Phase 0 `baseline` is replaced by the per-block snapshots from S10 on | Same pattern as D-P0-20/32: 0 agent items, 0 credential files; the spike code has no keychain path; leaving them unmarked keeps detection | G0-13; plan P0-T04 | 39 | Claude (owner-delegated) |
| D-P0-36 | 2026-11-10 | The deferred scale-up stage (plan-scale M13, M14, EC-57, EC-87) runs only when the owner starts it, likely after the first version is finished; it is not part of the MVP Gate. The third agent is the Antigravity CLI (`agy`) instead of Gemini CLI, evaluated in Phase 2 | Owner answers: "the large-scale will implement when i told you to do. Possibly after finish the first version"; "Yes, replace Gemini CLI with Antigravity CLI" | PRD §10, Q19, Q23; D-P0-25, D-P0-26 | 40 | owner |
## 5. Deviations from plan or PRD

| Date | Deviation | Owner approval reference |
|---|---|---|

| 2026-11-10 | S12 run at a personal profile instead of plan scale; plan-scale targets kept and measured in a deferred scale-up stage | D-P0-24, D-P0-26 |
| 2026-11-10 | Gemini live parts of S9/S11/S13 skipped (Google rejected personal sign-in) | D-P0-19 |
| 2026-11-10 | S3 M16 miss under a 50-way simultaneous burst accepted | D-P0-22 |
| 2026-11-10 | Claude evidence split across 2.1.319 and 2.1.322 after an auto-update | D-P0-33, D-P0-34 (owner accepted 2.1.322) |
| 2026-11-10 | `redactPaths` (P0-T02) deleted as unused; evidence stays path-free through the reducers and `privacy:scan` | pre-freeze review, Claude |

## 6. Spike results

All spike findings live only in `docs/plans/phase0_spikes.md` (created by P0-T10; pre-v1 spikes S2, S8 and the S10 MCP re-run append sections there). This file links to them.

| Spike | Status | Decision (one line) | Report anchor |
|---|---|---|---|
| S1 SQLite | pass | `node:sqlite` from Electron's bundled Node; no `better-sqlite3` (record_decision 16) | `phase0_spikes.md` § S1 |
| S3 Forwarder | pass-narrowed | SEA forwarder over a private socket, commit ack, Stop synchronous; owner accepted the M16 burst miss (record_decision 23) | `phase0_spikes.md` § S3 |
| S4 Claude plugin | pass | hooks-only plugin route adopted (record_decision 24) | `phase0_spikes.md` § S4 |
| S5 Codex hooks | pass-narrowed | `hooks.json` + Codex trust review; append after foreign entries, untested; foreign hooks added later shown as a Disconnect conflict (report §4; record_decision 25) | `phase0_spikes.md` § S5 |
| S6 Codex interoperability | pass-narrowed | external Codex sessions observe-only; resume/fork syntax verified; daemon mode, VS Code, Desktop untested (record_decision 35) | `phase0_spikes.md` § S6 |
| S7 Claude interoperability | pass on 2.1.322 | manual denial from the transcript; elicitation hooks validated; background completion arrives after Stop (record_decision 36) | `phase0_spikes.md` § S7 |
| S9 Format survey | pass | fact set, schemas, fixtures; streaming zstd (record_decision 26) | `phase0_spikes.md` § S9 |
| S10 Network | pass | kill-on-attempt audit profile; final run: 8 kill controls, the NetLog control and the shutdown-attempt control detected, quiet baseline, 0 attempts in 10 scenarios (record_decision 34) | `phase0_spikes.md` § S10 |
| S11 Gemini/catalog | Gemini live UNVERIFIED (owner skip); catalog + validator pass | catalog draft; `ajv` 8.20.0 owner approved (D-P0-34), installation pending Phase 1, optional runtime trial not run (record_decision 27) | `phase0_spikes.md` § S11 |
| S12 Capacity/latency | pass-narrowed (personal profile) | layout C, batch 100/50 ms/1 MiB, per-file watch + 5 s scan (record_decision 28) | `phase0_spikes.md` § S12 |
| S13 Passive usage/context/cost | pass-narrowed (C8 partial) | SEA statusLine tee feasible (added wait p95 33–78 ms); Claude account scope unverified; Codex salted-hash marker (record_decision 33, owner approved) | `phase0_spikes.md` § S13 |
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
| Approve the challenged plan | done (D-P0-09) |
| Choose unsandboxed-run mode (OQ-X2) | done (D-P0-02); per-command approvals still asked at run time |
| Profile location, Codex sandbox, VS Code launches (OQ-X1, OQ-X16) | done (D-P0-15, D-P0-16, D-P0-17) |
| Plan-revision decisions (machine, real stores, App. C errata, gate commit) | done (D-P0-03, D-P0-04, D-P0-05, D-P0-07) |
| Confirm Phase 0 installs (P0-T01) | done (2026-11-10): electron 45.2.3, typescript 7.0.2, electron-builder 26.18.0 |
| Sign in to temp profiles (P0-T06) | done for Claude and Codex; Gemini blocked by Google, skipped (D-P0-19) |
| Answer or accept defaults for open questions (plan §6) | pending |
| Gate 0: approve the dependency list (G0-10, report §3) | done (D-P0-34) |
| Gate 0: Claude version drift (report §4, D-P0-33) | done: accept 2.1.322 (D-P0-34) |
| Gate 0: placement of the deferred scale-up stage and the Antigravity CLI proposal | done (D-P0-36) |
| Gate 0: three non-agent keychain changes and the lost `baseline` snapshot | done (D-P0-35) |
| Gate 0: OK for the gate commit (D-P0-07), then Codex review | done: owner OK 2026-11-10; Codex review next |

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
