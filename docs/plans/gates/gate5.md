# Gate 5 record

Post-freeze evidence for Gate 5 (plan §2.4 step 6, P5-T20). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `6991582` (branch `feat/phase5-history-retention`) |
| Baseline | `master` at `d2bcc15` |
| Freezes | `7be79fc` (first, reviewed), `d009538` (round-1 fixes), `6bf1b7e` (round-2 fixes), `730a8fe` (round-3 fixes; full suite), `f7c9a52` (round-4 fixes), `481f5f2` (round-5 fixes), `18a2009` (second-review fix), `829e51f` (TP disk-full fix and docs; delta suite below), `32817fb` (docs only: second-review G5C3-1/2), `8be42e3` and `6991582` (docs only: D-P5-21, D-P5-22) |
| Fix commits | ef976f0 (PROD-542), e275690 (PROD-543), 1d95b96 (U5 perf/E2E), 6bf1b7e (PROD-544), 730a8fe (PROD-545), d4a01e2 (PROD-546), d8d9a0c (PROD-547), 4ea3884 + f7c9a52 (probe), cd6ae17 (PROD-548), 481f5f2 (G5Su-1..3), 18a2009 (G5C2s-1), 7968e5b (probe hook identity), 9afef69 (PROD-549), 829e51f (docs), 32817fb, 8be42e3, 6991582 (docs) |
| Owner decision | **Approved** 2026-11-22 on `6991582` ("I approve, finish gate 5 and clean up") |
| Push / PR | _pending owner request_ |

Environment for every suite: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0, Electron 45.2.3. Clean clone under the repo `.cache/` (dev-CLI tests refuse temp-dir data dirs), `npm ci --offline`, repo `.cache/` caches; each step started at 1-min load < 6.

## Delta suite on `829e51f` (`32817fb` adds docs only)

| Check | Result |
|---|---|
| ci, lint, typecheck, build, dist:mac | pass |
| `npm test` | 1639/1639 |
| `test:electron` | 578/579 twice under load (EC-71 `tail-move-delete`, 1-min load ~5.9 and ~4.3); EC-71 alone under Electron 3/3; full rerun on a quiet machine 579/579 |
| `test:e2e` (connection audit in every launch) | 75/75 |
| `privacy:scan -- --all`, `--history`; `fixtures:lint` | pass |
| EC-99 quota expiry at TP | pass |
| M13 at TP (20 runs): selection, rare and common search, cold and warm, retention overlap | pass, all 13 checks |
| TP retention under load (600 s) | pass |
| TP usage with the real mid-backfill disk-full (600 s) | fail m1, m2, queueAge (accepted, D-P5-20): M1 steady p95 ~1.4 s, M2 ~1.7 s, 0 steady misses, drain ~72 ms; m5UnderLoad fail (peak ~450 MiB vs ~429 MiB; accepted, D-P5-22). EC-57/EC-100/M14 frames, banner, reopen, noCrash pass |
| M5 / M4 | pass |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | pass: 0 non-loopback, repo and fixture stores unchanged, 0 unexpected deaths |
| `git status` after the suite (clone and repo) | 0 lines |
| Connected-browser visual check (built gate app, synthetic home, loopback CDP) | pass, 0 console errors or warnings, light and dark |

The `18a2009` delta suite (before the disk-full fix) passed everything except TP usage with disk-full (npm test 1629/1630 on a load-only EC-11 miss, rerun 1630/1630); its numbers are in `.cache/gate5-results-18a2009-r3/` (local).

### TP usage disk-full: what was measured
- Since `730a8fe` (round 3 review M2) the probe fills the disk at 60 s, while the t1mix backfill runs, and requires the store itself to hit ENOSPC. Before, at the quarter mark, no write failed (commit note on a `6bf1b7e` run), so the `6bf1b7e` result (M1 p95 ~282 ms) and the Gate 4 A/B (`dbacaf8`, ~288 ms, drain ~72 ms) did not exercise a real disk-full.
- Every run with the real fault stalls the same way: `730a8fe` M1 p95 ~17.3 s, `18a2009` ~12.4 s, and `18a2009` without PROD-545's spool re-stat (A/B, `.cache/gate5-results-18a2009-r3/ab-norestat-*`) ~12.1 s. So the cause is not the re-stat, and not machine load (the A/B started at load 4.4).
- Not yet known: which part of recovery after a real disk-full during backfill holds commits ~11 s (backfill resume, spool replay cadence, WAL checkpoint). Gate 4 never measured this case.
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | pass |
| `git status` after the suite (clone and repo); `~/Library/Caches` writes | 0 lines; 0 new cache entries |

## Full suite on `730a8fe` (round-3 freeze)

| Check | Result |
|---|---|
| ci, lint, typecheck, build, dist:mac | pass |
| `npm test` / `test:electron` / `test:e2e` | 1617/1617, 569/569, 75/75 |
| M1/M2/M11 (T0 live) | pass except **M11 file-only: accepted miss (D-P3-19)** |
| Notifications, M16 (T0), M12/M13/tray (T0 cold, 20 runs), M3 full (t1mix, 20 cold runs), EC-15 | pass |
| TP usage with disk-full (600 s) | **fail**: m1, m2, queueAge, drain, m5UnderLoad (superseded: PROD-548 pacing came after; re-measured on `18a2009` above) |
| EC-99 quota, M13 at TP, M5, gate audit | pass |
| `privacy:scan`, `fixtures:lint`, `spike:test`; `git status` clone and repo | pass; 0 lines |

### Machine-limited TP results (Gate 4 A/B, old fault timing)
With the fault at the quarter mark, TP usage M1 steady p95 (~282–289 ms on this machine) and `hookM16` also miss on the Gate 4 gate build `dbacaf8` run on the same machine the same night (`.cache/gate4-ab-results2`): machine-limited at that timing. This does not cover the real disk-full stall above.

### M5 headroom
Standalone M5 passes. M5 under load (TP usage with the real disk-full) is over budget in 3 of the last 4 runs (~446–463 MiB vs ~429 MiB) and ~50 MiB above the Gate 4 build under the same fault (~397 MiB); accepted, D-P5-22.

## Gate 5 checklist (plan §Phase 5), verified on `829e51f` (`32817fb` adds docs only)
- [x] Purge acceptance (P5-T07) GREEN — `purge acceptance: canary and session gone from rows, FTS, chunks, spool and backups; the rest intact (FR-11)` passes in `test:electron` (579/579 on a quiet rerun).
- [x] EC-21, 22, 23, 24, 58, 66, 71, 99, 103, 104, 105, 106, 107, 108 pass; Q24 rows unchanged. Each EC id has passing tests in `npm test` (1639/1639), `test:electron` or E2E (75/75), none failing; EC-66 and EC-105 are named in their files (`session-excerpt`, `renderer-model`, E2E `session-list`; `usage-clear`, `monthly-cost`, E2E `usage-clear`), all passing. The two Q24 tests pass. EC-87 deferred to owner-started scale-up (P5-T19).
- [x] EC-42 regression (P5-T10 DST fixture): 4 EC-42 tests pass.
- [x] History E2E flows (`history-browse`, `history-actions`, `settings-retention`), monthly chart E2E (US-20, `monthly-chart`, `usage-clear`), Agent Map tree/nav E2E (US-21, `agent-map`): all in the 75/75 E2E run.
- [x] A11Y and visual baselines (`a11y-workspace`, `a11y-agent-map`, `visual` in the E2E run); connected-browser visual check on the built gate app (synthetic home, loopback CDP, Playwright `connectOverCDP`): Dashboard with Usage and history and the monthly chart, Session list, open session with its retention line, Trash, Agent Map and Settings in light and dark, 0 console errors or warnings; port closed after.
- [x] M13 (TP) with quota history and snapshot/index bytes: `perf-tp-m13` 20 runs, all 13 checks pass, per-table bytes (FTS, snapshots, index) reported; TP quota passes; regression reruns reported (suite rows above).
- [x] Native fixture stores byte-identical; app data 0700/0600; repo unchanged; M6 = 0: packaged audit `fixtureStoresUnchanged` and `repoUnchanged` true, netlog 0 non-loopback; `pragmas and 0600 files` and `modes: run dir 0700, socket and token 0600` pass; clone and repo `git status` 0 lines.
- [x] Monthly tables contain only opaque keys: `privacy: monthly tables hold opaque keys only, no ids, paths, titles or locators` passes.
- [x] Pipeline evidence per unit (`security-change` for purge, retention, settlement, clear): met with the owner-approved deviation D-P5-21. Purge (P5-T07 run 146), resurrection/clearing (P5-T08 run 147), retention (P5-T09 run 148) and PROD-549 (run 183) ran `security-change`. The settlement core (P5-T04 run 144) and Clear usage history (P5-T16 runs 156, 157) ran `new-feature` (risk high/critical), each with a fresh diff-only security review (approve with fixes, no critical/high) and, for P5-T16, owner approval. Owner decision D-P5-21: the security reviews are accepted as equivalent; run 157 (medium) had a fresh code review.
- [x] GS: Codex review (rounds 1–10, final approve on `6991582`), Claude second review (approve), owner stop: approved 2026-11-22.

### Resolved by owner decisions
- M5 under load (TP usage with the real disk-full): peak ~446–463 MiB in 3 of the last 4 runs against ~429 MiB (450 MB); the Gate 4 build under the same fault ~397 MiB. A Phase 5 increase (~50 MiB; the `730a8fe` split put it in the renderer and GPU processes). Standalone M5 passes. Accepted for Gate 5, Phase 6 unit (D-P5-22).
- EC-71 (`tail-move-delete`) failed twice in full `test:electron` runs under load (1-min load ~5.9 and ~4.3); passes alone under Electron 3/3 and in the full run on a quiet machine 579/579. Load-sensitive timing; the delta does not touch watching.

## Reviews
| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude `/ponytail-review` | working tree | deferred to Phase 6 unit 1 (owner) |
| Gate review (8 chunks a–h, b split) | Codex gpt-6.1-sol (gpt-6.2-sol refused for a ChatGPT account) | `d2bcc15..7be79fc` | all reject: 26 findings |
| Second review | Claude (fresh verifiers; G5a, G5b2 in main session, owner-delegated) | chunk diffs + findings | 26 confirmed or partly, + G5-N1 |
| Fix units U1–U5 | delegated implementers, fresh reviewers | runs (U1–U5) | approve |
| Fix re-review 1 | Codex (r1, r2) | `7be79fc..d009538` | reject |
| Fix round 2 | Claude | PROD-544 | approve |
| Fix re-review 2 | Codex (s1; s2 orphaned) | `d009538..6bf1b7e` | s1 reject: G5Ss1-1..3, G5Rr1-3 partly |
| Fix round 3 | Claude, run 176 (design review 3002, owner 3003, diff security review) | PROD-545 | approve with fixes, adopted |
| Fix re-review 3 | Codex (t) | `6bf1b7e..730a8fe` + round-2 tests/perf chunk | reject: G5St-1 (probe counted failed purges); G5-N1, G5Ss1-1 partly, accepted by decision 3002 |
| Fix round 4 | Claude, runs 177–179 (owner approved) | PROD-546, PROD-547, PROD-548, probe | approve |
| Fix re-review 4 | Codex (u) | `730a8fe..f7c9a52` | reject: G5Su-1..3 |
| Fix round 5 | Claude, run 180 (design review, owner approval, diff review) | G5Su-1..3 | approve |
| Fix re-review 5 | Codex (v) | `f7c9a52..481f5f2` | approve, no new findings |
| Second review of the fix delta | Claude | `7be79fc..481f5f2` | G5C2s-1 (minor, privacy rule G5b1-3) fixed in run 182 (owner critical, decision 3048); test hardening G5C2s-3, G5C2r-3, G5C2r-4; G5C2r-1, G5C2r-5 deferred |
| Fix re-review 6 | Codex (w) | `481f5f2..18a2009` | approve, no new findings |
| TP disk-full investigation | Claude (CPU samples, WAL sizes, live log/spool/trace) and Codex (root cause, fix design) | `18a2009` | probe rowid matching after ENOSPC; replay quiet-window starvation and backoff not reset |
| Fix: probe identity | Claude, fresh diff review | `7968e5b` | approve (review L1 adopted) |
| Fix: PROD-549 | Claude, harness run 183 (design security review 3057, owner 3058, diff security review) | `9afef69` | approve with changes, adopted (R183-1..4, D183-1..4) |
| Fix re-review 7 | Codex (x; the first attempt orphaned without a verdict, rerun x2) | `18a2009..829e51f` | approve; G5Sx-1 minor (the 2 s floor is stamped at tick dispatch, so a pass queued behind a startup, late-listen or report-recovery replay can start < 2 s after it): kept, bounded to one early pass per such event; the replayNow storm path stays floored; Phase 6 cleanup unit |
| Second review of the final fix delta | Claude (fresh reviewer) | `18a2009..829e51f` | approve; G5C3-1 (UTC dates) and G5C3-2 (§5 deviation rows) adopted in `32817fb`; agrees G5Sx-1 goes to the Phase 6 cleanup unit |
| Fix re-review 8 | Codex (y) | `829e51f..32817fb` (docs) | approve, no new findings |
| Fix re-review 9 | Codex (z) | `32817fb..8be42e3` (docs) | reject: G5Sz-1 minor (D-P5-21 overstated run 157), fixed in `6991582` |
| Fix re-review 10 | Codex (z2) | `32817fb..6991582` (docs) | approve, no new findings |

## Decisions for owner sign-off
- D-P5-17: G5h-1 / G5c-4 deferred to Phase 6.
- D-P5-18: kept G5Rr1-1 (oversized spool file deleted whole); EC-22 wording.
- D-P5-19: settle phase batched (deviation from PRD §5.11 "same transaction" wording); G5Ss1-1 kept by decision with measured bounds.
- M11 file-only accepted miss (D-P3-19).
- D-P5-20: TP usage with a real mid-backfill disk-full, M1/M2 miss accepted (pre-existing; Gate 4 build worse under the same fault); Phase 6 unit.
- D-P5-21: settlement core (P5-T04) and Clear usage history (P5-T16) ran `new-feature` instead of `security-change`; their security reviews accepted as equivalent.
- D-P5-22: M5 under load (TP usage with the real disk-full) over budget, ~50 MiB above the Gate 4 build; accepted, Phase 6 unit.

## Deferred to Phase 6
- Ponytail pre-freeze items (unit 1); D-P5-17 filters; D-P5-20 post-disk-full commit latency; D-P5-22 renderer and GPU memory under load; G5Sx-1 replay floor at the serialized start; test temp-folder leak root cause; spool-replay boot-level test (item 4).
