# Gate 0 record

Post-freeze evidence for Gate 0 (plan §2.4 step 6, D-P0-07). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `7deb8cb51d6af9c7193cd54722b7439c8e367310` (branch `feat/phase0-spikes`) |
| Baseline | `master` at `e6b39ab` (`git merge-base master HEAD`) |
| Commits reviewed | `84af83d` (Phase 0 work), `f0ddc99` (review fixes, round 1), `7deb8cb` (round 2) |
| Owner decision | **Approved** 2026-11-10, including PRD v1.1 and its proposed items (S12 defaults: 5 s scan interval, batch 100 rows / 50 ms / 1 MiB, per-file watcher strategy; S5 append rule); record_decision 41 |
| Push / PR | not requested at approval; merged to `master` later by PR #2 |

## Suite on the gate SHA (clean checkout, caches under the repo `.cache/`)

| Check | Result |
|---|---|
| `npm ci`, `install-electron` | ok |
| `npm run typecheck` | pass |
| `npm test` | 55/55 |
| `npm run spike:test` | 50/50 |
| `npm run spike:test:unsandboxed` | 12/12 |
| `npm run dist:mac`; spike app smoke | pass; no orphans |
| `privacy:scan` over `docs/plans`, `spikes`, `test/fixtures/synthetic`, `docs/PRD.md`; complete gate diff | clean |
| `grep -rn "spikes/" src/`; `git status --porcelain` after the suite | empty; empty |
| New files under `~/Library/Caches` (electron, xaibo) | none |

The same suite was also green from clean checkouts of `84af83d` and `f0ddc99`. S10 (network audit, run separately on the final app code): 11/11 controls detected, 0 attempted non-loopback connections in 10 scenarios.

## Reviews

| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude (6 lenses, 2 adversarial checks per finding) | full Phase 0 tree | 58 findings: 36 upheld, 11 split, 11 refuted; upheld and split ones fixed before `84af83d` |
| Gate review | Codex (5 parts) | `e6b39ab..84af83d` | docs: approve-with-fixes; shared code, S1, S3, app, scripts: reject; S4–S10 code: reject; S11–S13 code: approve-with-fixes; evidence and fixtures: approve |
| Fix re-review 1 | Codex | `84af83d..f0ddc99` | approve-with-fixes (17 resolved, 3 partly resolved, all minor; no new findings) |
| Fix re-review 2 | Codex | `f0ddc99..7deb8cb` | approve (3 resolved, no new findings) |
| Second review | Claude | fix deltas against the Codex findings | approve; one minor limit documented (approximate spool accounting, report § S3 2.6) |

## Finding dispositions (Codex gate review, 20 findings, all fixed)

| Area | Finding (short) | Disposition |
|---|---|---|
| PRD | third-agent requirements still Gemini; MVP still required plan-scale tiers; D-22 status | aligned with D-P0-36; TP tier at the MVP Gate, T2/T3 in the deferred stage; D-22 status updated |
| Report / progress | S5-C5 trust failure not escalated; validator wording; S10 control count | S5-C5 in report §4, S5 pass-narrowed; wording fixed; final control set named |
| Runner | version probe outside the supervisor; registration failure left the command running | probe supervised, failure invalidates the run; registration failure stops the group (tested) |
| S1 | orphan cleanup by name match | pid + start time of this run's own tree |
| S3 | never-closed stdin not exercised; paint ack before paint; spool counter only grows | re-measured (SEA pass, Electron-as-Node own deadline fail, not chosen); ack one frame later, timings re-measured as an upper bound; counter reset after replay (tested) |
| Scanner | JSON-escaped Windows paths missed | pattern and test |
| S10 | an audit kill at quit could hide in the allowance; output read before drained | clean service exit at quit, shutdown-attempt control, read after close; re-run |
| S7 | elicitation action matched over the whole transcript | anchored to the call's own result, exact match; recomputed from local raw data (no prompts) |
| S13 | tee filter by value shape, not fields | explicit field allowlist with negative tests; overhead re-run (SEA p95 31 ms) |
| S12 | stale result reuse; null metrics passing; byte vs character cap | fresh result required; finite-number check; recorded as characters |

## Owner decisions at Gate 0

D-P0-34 (Claude 2.1.322 accepted for the matrix; dependency list approved), D-P0-35 (guard adjudication, delegated), D-P0-36 (scale-up stage when the owner starts it, likely after the first version; Antigravity CLI replaces Gemini CLI), and the approval above.
