# Gate 6 record

Post-freeze evidence for Gate 6 (plan §2.4 step 6, P6-T13). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `7ad7479` (branch `feat/phase6-integrations`) |
| Baseline | `master` at `06e7d36` (PR #22 merge) |
| Freezes | `1484039` (first, reviewed; full suite), `a64d443` (round-1 fixes; full suite), `7ad7479` (G6R-1 fix; full suite below) |
| Fix commits | a64d443 (XAIBO-PROD-602..605, hotfix runs 238-241), 7ad7479 (XAIBO-PROD-606, hotfix run 242) |
| Owner decision | **Approved** 2026-11-26 on `7ad7479` ("approve") |
| Push / PR | _pending owner request_ |
| `REAL_PROFILE_ENABLED` | `false` at the gate SHA; flipped only in the Gate 6 merge, after the owner works through the P6-T12 pre-enable checklist (plan P6-T12), or left off by owner choice |

Environment for every suite: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0. Clean checkout of the gate SHA as a worktree under the repo `.cache/` (dev-CLI tests refuse temp-dir data dirs), `npm ci` (online: the repo npm cache lacked one package; lockfile unchanged), every cache in the repo `.cache/`.

## Full suite on `7ad7479`

| Check | Result |
|---|---|
| ci, lint, typecheck, build, dist:mac | pass |
| `npm test` | 2099/2101: both failures are `import-liveness` event-loop timing tests under suite load (1-min load up to ~14): the 5 ms timer test (accepted, D-P6-23) and "watching many settling sessions stays linear" (same file, same cause; accepted with the gate approval, below) |
| `test:electron` | 799/799 (both `import-liveness` tests pass here) |
| `test:e2e` (connection audit in every launch) | 90/90 |
| perf T0 `--only live` | M1, M2, M11 hook, priced, recovery pass; **M11 file-only: accepted miss (D-P3-19)** |
| perf `--only m16 --runs 200` | pass |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | pass: 0 non-loopback, repo and fixture stores unchanged |
| `privacy:scan -- --all`, `--history`; `fixtures:lint` | pass |
| `git status` after the suite (clone and repo); new `~/Library/Caches` entries | 0 lines; 0 entries |

The `1484039` and `a64d443` suites had the same shape (`npm test` 2093/2094 and 2099/2101 on `import-liveness` only; `test:electron` 794/794 and 799/799; E2E 90/90; T0 live only the M11 accepted miss; M16, gate audit, privacy, fixtures pass); their numbers are in `.cache/gate6-results-*/` (local).

## Gate 6 checklist (plan §Phase 6), verified on `7ad7479`
- [x] EC-26 (`reconcile`), EC-27 (`shim-orphan`), EC-72 (`agentflow-coexist`, `reconcile`), EC-73 (`setup-plans`, `roundtrip`), EC-78 (`validate`, `probe`, `import`, `m15-fourth-agent`), EC-79 (`capabilities`, `integration-detail`, `rescan`, E2E `add-agent`), EC-90 (`setup-plans`), EC-109 (`sign-in-state`, `sign-in`, `sign-in-codex`), EC-110 (`sign-in-access`) pass in the runs above; RED output is in each unit's harness run (runs 185-242, progress §5).
- [x] Config round trip: `roundtrip` (full matrix incl. the tee) passes: byte-identical where Xaibo-owned values are unchanged, changed values conflict.
- [x] M15: `m15-fourth-agent` passes (P6-T09, `test/`-only diff).
- [x] Agents list, integration panel, Add agent, Settings prices and sign-in declarations, usage E2E (`agent-map`, `integrations`, `add-agent`, `settings-prices`, `sign-in-usage`), visual baselines (`visual`: agents, agents-panel, agent-map) and A11Y (`a11y-agent-map`, `a11y-workspace`): all in the 90/90 E2E run.
- [x] S14 disposition Pass-narrowed (D-P6-15): no verified sign-in mapping; every method Unknown unless the owner declares it; no shipped rules, no credential inspection or usage request.
- [x] M6 0 in every E2E run and the packaged audit; M7 `hook-config-lint` passes (no prompt/agent hook types in generated configs).
- [x] Native fixture files unmodified: packaged audit `fixtureStoresUnchanged` true; clone and repo `git status` 0 lines.
- [x] Temp profiles: **kept** for the later SG spikes and the P6-T12 plugin-route evidence (D-P6-22).
- [x] GS: step 0 (progress §5), Codex review (rounds 1-3, final approve on `7ad7479`), Claude second review (approve with fixes, none before merge), review handoffs deleted, owner stop: approved 2026-11-26.

## Reviews
| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude `/ponytail-review` | `src/` diff | ~65 lines, deferred to a first Phase 7 cleanup unit |
| Gate review (7 chunks A, B, C, D1, D2, E, F) | Codex | `06e7d36..1484039` | A reject (G6A-1, G6A-2 major); B approve-with-fixes (G6B-1, G6B-2 major); C approve; D1 approve-with-fixes (G6D1-1 major, D1-2, D1-3 minor); D2 approve-with-fixes (D2-1..3 minor); E approve-with-fixes (G6E-1 major, E-2 minor); F approve-with-fixes (F-1, F-2 minor) |
| Fix round 1 | Claude, hotfix runs 238-241 (approvals by the owner) | XAIBO-PROD-602..605 | RED 965 (the 6 new tests) -> GREEN 966 |
| Fix re-review 1 | Codex | `1484039..a64d443` | reject: G6R-1 major (JSON `null` registry/settings or `plugins: null` still read as absent); G6R-2 minor; G6R-3 minor adopted test-only; all round-1 majors resolved |
| Fix round 2 | Claude, hotfix run 242 | XAIBO-PROD-606 | RED 968 -> GREEN |
| Fix re-review 2 | Codex | `a64d443..7ad7479` | approve, no new findings |
| Second review | Claude (fresh reviewer) | `06e7d36..7ad7479` + Codex findings | approve with fixes; six minor/nit findings, none before merge (below) |

## Finding dispositions
- Fixed: G6A-1, G6A-2, G6B-1, G6B-2, G6D1-1, G6D1-2, G6E-1, G6E-2, G6F-2 (round 1); G6R-1, G6R-3 (round 2).
- Not adopted, with reason: D2-1 (covered by the unit and roundtrip tests), D2-2 (unreachable: no production sign-in rules ship), G6R-2 (no TSX component harness under node:test; E2E covers rendering).
- Deferred to Phase 7: D1-3 (owner, D-P6-23), D2-3, F-1, the pre-freeze ponytail items.
- Claude second review, deferred to Phase 7 with the gate approval:
  1. A stuck integration operation lock has no recovery and its "restart Xaibo" text misleads; also an owner check on the P6-T12 pre-enable checklist before the flip (with lock start identity, already listed).
  2. Measure (or cache) the usage-consumption read on the service thread.
  3. An Agents list refresh can be dropped when Load more runs at the same time.
  4. `loadImports` runs once per report-agent profile per page request.
  5. Packaged builds: drop the temp-dir allowance and inherited test environment variables unless an E2E marker is set.
  6. A comment nit in `connect.ts`.

## Decisions for owner sign-off
- D-P6-21: P6-T12 real-profile policy behind `REAL_PROFILE_ENABLED = false`.
- D-P6-22: temp profiles kept.
- D-P6-23: round-1 dispositions; `import-liveness` 5 ms timer test accepted as load-sensitive.
- With this approval (to enter the progress log in Phase 7's first commit): the second `import-liveness` test ("watching many settling sessions stays linear") is accepted on the same grounds as D-P6-23 (passes under `test:electron` 799/799 and alone); the six second-review findings go to Phase 7, item 1 also to the pre-enable checklist.
- M11 file-only accepted miss (D-P3-19).

## Deferred to Phase 7
- D1-3 Return to Dashboard; D2-3 lower-panel visual baseline; F-1 T2 perf-tool attribution; ponytail pre-freeze items (generic main confirmation flow, dead `geminiRetentionOffer` and `lockHeld`, file-local exports, `allRows` page loop); the six second-review findings above; the optional owner real-profile Connect check (P7-T01).
