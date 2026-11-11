# Gate 1 record

Post-freeze evidence for Gate 1 (plan §2.4 step 6, D-P0-07). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `5defefa` (branch `feat/phase1-claude-ingest`) |
| Baseline | `master` at `d09ab65` (`git merge-base master HEAD`) |
| Commits reviewed | `1027f50`, `7feeca8`, `dbf5243` (Phase 1 work, first gate SHA), `3801dd8` (review fixes H1–H5), `5defefa` (fix H6) |
| Owner decision | **Approved** 2026-11-11 on `5defefa`; record_decision 231 |
| Push / PR | requested by the owner: push and a PR to `master`; the owner merges |

## Suite on the final gate SHA `5defefa` (clean worktree, `npm ci --offline`, caches under the repo `.cache/`)

| Check | Result |
|---|---|
| `npm ci --offline`, `install-electron` | pass |
| lint; typecheck (Node side, `src/renderer`, `spikes`) | pass |
| `npm test` (outside the Claude sandbox, real-`ps` case included) | 265/265 |
| `test:electron` (SQLite integration under Electron's Node) | 35/35 |
| `build`, `dist:mac -- --dir` | pass |
| `test:e2e` (every launch under the kill-on-attempt audit + NetLog) | 18/18 |
| M3 first-list (T1, seed 1, 20 cold runs) | **pass**: p50 ~695 ms, p95 ~728 ms (target 1,500 ms), 0 missing marks, 0 frames > 100 ms |
| EC-15 (seed 1) | **pass**: 20 MB file RSS growth ~30 MiB (bound ~128); 213 MB file ~133 MiB (bound 256), above-cap record in 1,281 chunks ≤ 64 KiB, searchable, 0 gaps, paging ~87 ms during import |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60: startup, 300 s idle, service SIGKILL + restart, shutdown) | **pass**: child-kill positive control detected and quit in time; 0 children killed; 0 unexpected helper deaths; killed service detected; main exit 0; 1 restart; NetLog parsed, 0 non-loopback events; repo and fixture stores unchanged (EC-61) |
| `privacy:scan -- --all`, `--history`; `fixtures:lint` (EC-62) | clean |
| New files under `~/Library/Caches` (electron, xaibo) | none |

Earlier gate SHAs: `dbf5243` and `3801dd8` each passed the same clean-checkout suite before their reviews.

## Reviews

| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude (`/ponytail-review`, coverage, audit report) | working tree | 4 findings: 1 fixed, 3 kept with reason (progress ledger, P1-T15 step 0) |
| Gate review | Codex | `d09ab65..dbf5243` | reject: 7 major |
| Second review | Claude | `dbf5243` diff + Codex findings | reject: confirms all 7, adds 2 minor (decision 209) |
| Fix re-review 1 | Codex | `dbf5243..3801dd8` | reject: 8 of 9 resolved, #7 partly; new N1 (major), N2 (minor) |
| Second review | Claude | fix delta + Codex findings | reject, agrees (decision 221) |
| Fix re-review 2 | Codex | `3801dd8..5defefa` | **approve**: N1, N2 resolved, no new findings |
| Second review | Claude | fix delta + Codex findings | **approve**, no new accepted fixes (decision 230) |

## Finding dispositions (all fixed or owner-accepted)

| # | Finding (short) | Disposition |
|---|---|---|
| 1 | Claude adapter skipped a failed batch commit; later checkpoints passed it | each batch commit awaited; a failure stops the file (H1, run 31) |
| 2 | Watcher never retried failed syncs | a failed sync makes the watcher forget the file; the next scan or wake retries (H1) |
| 3 | Oversized chunk ids collided across files of one session | the chunk key includes the source file (H2) |
| 4 | Escaped surrogate pairs split at chunk boundaries | the cutter holds a trailing high surrogate (H2) |
| 5 | One string > 64 KiB rejected a whole list page; the request never settled | display strings bounded before IPC; an invalid reply rejects its request (H3) |
| 6 | Startup error printed raw fs paths | error code only (H4) |
| 7 | Gate audit missed short-lived descendants | `child_killed` detector for direct children with a positive control (H5); remaining limit (a forked grandchild killed while its parent exits 0) **accepted by the owner** (D-P1-17) |
| 8 | LRM/RLM/ALM not escaped | escaped (H3) |
| 9 | Agent strip stuck at "Detecting" on a catalog failure | empty list announced, "No agents detected" (H3) |
| N1 | Lone high surrogate let a chunk exceed its byte bound | a pair counts only with a following low surrogate (H6, run 32) |
| N2 | Audit ignored the control-app shutdown timeout | fails and force-kills on timeout (H6) |

## Owner decisions at Gate 1

D-P1-15 (8 MiB parse cap kept; EC-55 through cwd/entrypoint with "Untitled" titles; unsandboxed runs with integrity checks), D-P1-16 (fix all findings, add a child-kill detector), D-P1-17 (M6 limit accepted; partial S9 re-check accepted: record types confirmed on Claude 2.1.322, no model reply because the temp-profile sign-in failed; version-triggered agent format checks from now on, plan §2.4), and the approval above.

## Open items carried forward

- Claude temp-profile sign-in fails (`authentication_failed`); not needed under the version-triggered check unless new record types appear.
- One unsandboxed `liveness` + `spawn` run during hotfix run 31 reported a single failure that did not reproduce in 6 further runs; cause unknown.
- "No agents detected" strip state is covered by unit tests only (no test hook to break the bundled catalog in E2E).
