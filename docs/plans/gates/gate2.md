# Gate 2 record

Post-freeze evidence for Gate 2 (plan §2.4 step 6, D-P0-07). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `9028f9b` (branch `feat/phase2-codex-agy-normalization`) |
| Baseline | `master` at `28a3b62` (`git merge-base master HEAD`) |
| Commits reviewed | `d5fd4cf`..`787d988` (P2-T00..T08, T13, committed before the freeze), `b363be5`, `8e99ecc`, `524279f` (first gate SHA), `ac1b5fb` (review fixes G2-1..G2-15), `9028f9b` (fixes G2-16, G2-17) |
| Owner decision | **Approved** 2026-11-12 on `9028f9b`; record_decision 351 |
| Push / PR | requested by the owner: push and a PR to `master` with a summary; the owner merges |

## Suite on the final gate SHA `9028f9b` (clean worktree, `npm ci --offline`, caches under the repo `.cache/`)

| Check | Result |
|---|---|
| `npm ci --offline`, `install-electron` | pass |
| lint; typecheck (Node side, `src/renderer`, `spikes`) | pass |
| `npm test` (outside the Claude sandbox, real-`ps` case included) | 389/389 |
| `test:electron` (SQLite integration under Electron's Node) | 84/84 |
| `build`, `dist:mac -- --dir` | pass |
| `test:e2e` (every launch under the connection audit) | 18/18 |
| M3 full (mixed corpus `t1mix-1`: Claude 501 / Codex 350 / agy 149 sessions, 1,049 files, ~698 MB; 20 cold runs) | **pass**: list p50 ~953 ms, p95 ~1,029 ms (target 1,500); full import ~51.7 s (target 120); 0 frames > 100 ms over the first-list windows and the whole import; 1,049/1,049 checkpoints at EOF, 0 incomplete |
| EC-15 (seed 1) | **pass**: 20 MB file RSS growth ~25 MiB (bound ~128); 213 MB file ~141 MiB (bound 256); 0 gaps; needle found |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60) | **pass**: 0 non-loopback NetLog events; repo and fixture stores unchanged (EC-61) |
| `privacy:scan -- --all`, `--history`; `fixtures:lint` (EC-62) | clean |
| `spike:test`; `git status` after the suite; new files under `~/Library/Caches` (electron, xaibo) | pass; clean; none |

Earlier gate SHAs: `524279f` passed the same suite after re-runs (first run: lint aborted on a system file-table overflow and the `ps` liveness case failed once under load; three re-runs 379/379); `ac1b5fb` passed every step, but its import time doubled (103.9 s), traced to the G2-2 dirty-estimate query and fixed in `9028f9b` (G2-17). Environment: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0, Electron 45.2.3 (Chrome 156, Node 24.22.2). Claude-only T1 comparison at step 0: p95 ~817 ms, import ~55.4 s (Gate 1: ~667 ms, ~40.7 s).

## Reviews

| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude (`/ponytail-review`, coverage 99.39 % lines, harness audit) | working tree | 2 findings: 1 fixed, 1 kept with reason (progress ledger, P2-T15 step 0) |
| Gate review (4 parts) | Codex | `28a3b62..524279f` | reject: 17 findings (14 major, 3 minor) |
| Second review | Claude | `524279f` diff + Codex findings | reject: confirms 15, 2 to the owner, adds 1 minor (decision 335) |
| Fix re-review 1 | Codex | `524279f..ac1b5fb` | reject: 16 of 18 resolved; 1 residual, 1 new (performance) |
| Second review | Claude | fix delta + Codex findings | reject, agrees; the performance item found independently (decision 343) |
| Fix re-review 2 | Codex | `ac1b5fb..9028f9b` | **approve**: both resolved, no new findings |
| Second review | Claude | fix delta + Codex findings | **approve**, no new accepted fixes (decision 350) |

## Finding dispositions (all fixed or owner-decided)

| # | Finding (short) | Disposition |
|---|---|---|
| P1-1 | Raw Codex `session_meta` kept account identifiers | stripped before storage (G2-1) |
| P1-2 | Phase 1 databases never gain normalization for stored events | **accepted by the owner** as a known limitation: no released or real-data DB exists (D-P2-09) |
| P1-3, P4-1 | Estimates stale when evidence changes after pricing (usage update, late Codex tier) | dirty estimates re-priced with their own revision (G2-2, migration 005); qualifier-only changes included (G2-16) |
| P1-4 | A zero counter reading did not start a segment | fixed (G2-3) |
| P1-5 | agy missing transcript then folder deletion not reassessed | fixed (G2-4) |
| P1-6 | Symlinked Codex `sessions/` followed | **by design, owner** (consistent with EC-18 for Claude; D-P2-09) |
| P1-7 | agy replay quadratic | partial index on current events (G2-5) |
| P1-8 | Tool-name precedence depended on arrival order | `tool_calls.tool_source` provenance (G2-6) |
| P1-9 | Zero tokens bypassed unknown-model unavailability | eligibility first (G2-7) |
| P2-1..P2-4 | Tests too weak (reload pricing, agy replay, Claude latest-wins, two tier settings) | strengthened (G2-8..G2-11) |
| P3-1 | agy facts extractor followed symlinks | containment; evidence unchanged on re-extraction (G2-12) |
| P3-2 | m3-full accepted extra incomplete checkpoints | exact completion (G2-13) |
| P4-2 | Real-machine process count in a progress row | removed going forward (G2-14); it remains in local commit `e694001`; the owner is asked before the push |
| Claude | liveness test start-time tolerance under load | compares against the `ps` start time (G2-15) |
| Fix review 1 | Dirty query scanned `usage` on every pass (import doubled) | driven from the partial index (G2-17) |

## Owner decisions at Gate 2

D-P2-01..08 during the phase (Phase 2 preparation; agy residual scope; Codex record drift; Claude context window until the tee; bundled prices; owner-set fallback scope; EC-74 link deferred; pricing qualifiers and the Codex tier rule), D-P2-09 (review dispositions above), the harness approvals 327, 337 and 344 for the hotfix runs, and the approval above.

## Open items carried forward

- EC-74 `session_links` deferred until a verified correlation key exists (D-P2-07); tagging and count-once ship.
- EC-80 passes for the generic source-order mechanism; agy rewind/compaction semantics remain unobserved (D-P2-02). A replay after a rewrite commits in bounded batches (brief window, `ponytail` note).
- Claude context window unavailable until the Phase 3 statusLine tee (D-P2-04); Codex cache-write tokens unpriced (relation unverified).
- Phase 1 databases do not gain Phase 2 normalization for already-stored events (accepted).
