# Gate 3 record

Post-freeze evidence for Gate 3 (plan §2.4 step 6, P3-T17, D-P0-07). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `cd0a289` (branch `feat/phase3-live-status`) |
| Baseline | `master` at `7193694` (after the Gate 2 merge) |
| Freezes | `10fbdd2` (first freeze, reviewed), `972da0e` (after the review fixes), `cd0a289` (after the forwarder fix; the suite below) |
| Review-fix commits | `f6357c4`, `5acc658`, `aa35057`, `7aac66e`, `26aa3ef`, `cd0a289` (harness runs 70–75) |
| Owner decision | **pending** |
| Push / PR | not done (D-P3-24); after the owner's approval |

## Suite on the gate SHA `cd0a289` (clean clone, `npm ci`, caches and the verified official Node from the repo `.cache/`)

Environment: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0, Electron 45.2.3. The machine carried external load during the run (a virtualization VM, most likely the Docker VM the harness gate needs, at ~1–1.5 cores; load average ~3–5). P3-T16e's figures were taken with Docker stopped.

| Check | Result |
|---|---|
| `npm ci`, `install-electron`, lint, typecheck (Node side, `src/renderer`, `spikes`) | pass |
| `npm test` (outside the Claude sandbox; every Gate 3 EC test and the Gate 1/2 EC regression) | 900/900 |
| `test:electron` | 371/371 |
| `build`, `dist:mac` | pass |
| `test:e2e` (every launch under the connection audit) | 20/20 |
| M3 full (t1mix-1, 20 cold runs) | **pass**: list p95 ~894 ms (target 1,500); full import ~65.9 s (target 120); 0 frames > 100 ms |
| EC-15 (seed 1) | **pass**: growth ~21 MiB (20 MB file), ~128 MiB (213 MB file, bound 256); 0 gaps; needle found |
| Notifications (T0 notify) | **pass**: p95 ~1.3 ms, 0 extra notifications |
| M1 / M2 / M11 (T0 live) | M1 hook → paint p95 ~115 ms (250); settled p95 ~4,118 ms (4,250); M11 hook p95 ~115 ms (300); M2 per path p95 ~65–66 ms (1,000); recovery pass. **M11 file-only p95 ~5.0 s: accepted miss (D-P3-19)** |
| M1 / M2 during the import (T1 live probes) | **pass**: M1 p95 ~182 ms with spooled hooks counted as misses (250); 16 spooled; M2 pass |
| M16 (T0, 200 runs per mode) | first run: one mode p95 100.6 ms vs 100 under the load above; **rerun: pass** (hung p95 ~90.8 ms, other modes ~43–44 ms) |
| Tee overhead, packaged | **pass**: p95 ~39–40 ms (100) |
| M4 (T1 imported, window closed, 5 min) | **pass**: summed footprint max ~157 MiB (250 MB), idle CPU mean ~0.10 % |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | **pass**: 0 non-loopback NetLog events; repo and fixture stores unchanged |
| Helper attempt audit `scripts/helper-audit.ts` | **pass**: 32 cases, 0 attempts, positive controls fired (first run did not start: the clone lacked the git-ignored official Node; rerun with the repo's verified copy) |
| `privacy:scan -- --all`, `--history`; `fixtures:lint` | clean |
| `spike:test`; `spike:test:unsandboxed`; `git status` after the suite | 64/64; 14/14; clean |
| Visual check (T10/T11 UI, unpackaged gate build, loopback debug port for the check only, Playwright `connectOverCDP`) | service Running; agent strip; a synthetic live row shows "● Busy (confirmed)" then "⏸ Waiting for permission (confirmed)" (text plus icon); the stub records exactly one notification `Claude Code · Project · Waiting for permission`; 0 console errors; Tab reaches the labeled buttons with a visible focus ring; instance stopped, port closed |

An A/B of the pre-fix `10fbdd2` and `972da0e` builds (packaged probe, 8 runs alternating; in-process import with an event-loop probe) showed no code regression from the review fixes (medians within ~1 %, identical rows written); the slower figures seen earlier came from machine load.

## Reviews

| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude (`/ponytail-review`, coverage 99.12 % lines) | working tree | 14 findings: 3 kept with reasons, 11 deferred to the first Phase 4 unit (D-P3-23) |
| Gate review (five plan chunks a–e) | Codex | `7193694..10fbdd2` | a reject, b approve-with-fixes, c reject, d reject, e reject: 14 findings |
| Second review | Claude (three fresh-context verifiers with reproductions) | chunk diffs + Codex findings | 13 confirmed (severity revised), G3d-3 partly (owner), 3 new defects added |
| Fix units | delegated implementers; fresh code/security reviewers per unit | runs 70–72 | approve (with lows fixed RED-first or accepted) |
| Fix re-review 1 | Codex | `10fbdd2..aa35057` | reject: 10 resolved, 2 partly, G3d-3 open; new G3f-1, G3f-2 (confirmed), G3f-3 (refuted: report chunks never shipped) |
| Fix re-review 2 | Codex | `aa35057..7aac66e` | approve-with-fixes: G3f-1, G3f-2 resolved; G3b-2 residual |
| Fix re-review 3 | Codex | `7aac66e..26aa3ef` | **approve** |
| Owner-delegated designs (D-P3-25) | Codex + fresh security review | forwarder fix (run 75), D-P3-26 | forwarder approve-with-fixes (G3i-1 + four security lows, fixed RED-first) → re-check **approve**; D-P3-26 **approve** |

## Finding dispositions (all fixed or decided)

| # | Finding (short) | Disposition |
|---|---|---|
| G3a-1 | Manifest over 4 MiB written, then unreadable | refused before writing (`f6357c4`) |
| G3a-2 | Installers re-planned after the confirmed preview | the previewed plan is applied (`f6357c4`) |
| G3b-1 | Forwarder ack length unbounded | 0 or >4096 bytes dropped (`f6357c4`) |
| G3b-2 | Disk-full gaps over-counted, never reconciled | per delivery, cleared on accept, on duplicates and at start (`f6357c4`, `7aac66e`, `26aa3ef`) |
| G3c-1 | Status key lacked the profile (PRD §5.5) | keyed by (agent, profile, native id); migration 011 (`5acc658`, critical run 71, owner-approved 1131) |
| G3c-2 | Resume after SessionEnd stayed ended | per-invocation reset (`5acc658`) |
| G3c-3, G3f-1, G3f-2 | Report ordering by receipt time; late lower/higher seq; placement time aged notifications | registration-scoped producer seq, two-sided clamp, receipt time for notification age, replay keeps received_ts (`5acc658`, `7aac66e`) |
| G3c-4 | SubagentStart did not activate the parent | fixed, never clears an error (`5acc658`) |
| G3d-1 | Chunks removed before the incomplete state committed | kept until commit (`aa35057`) |
| G3d-2 | Content assembly ignored producer_id | producer in the chunk key; first to settle wins (`aa35057`, report-v1.md) |
| G3d-3 | Producer sequence gaps not tracked | **deferred to the Phase 4 coverage surface** (D-P3-26, Codex approve); inputs stored |
| G3e-1 | Null/empty rate windows dropped (EC-91) | kept as all-null readings, Claude and Codex (`aa35057`) |
| G3e-2 | Salt opened without O_NONBLOCK | fixed (`aa35057`) |
| G3f-3 | Legacy chunk keys removed at upgrade | not a defect: report chunks never left this branch |
| Claude (EC-46 under load) | Forwarder deadline could exit before the spool fallback was armed: silent hook loss | two-turn deferral, truncated evidence, report `fail('stdin')` (`cd0a289`, D-P3-27); G3i-1 resolved |
| Accepted lows | pre-011 evidence rows unread after upgrade; overflow disk-full bucket past 1000 keys not reconciled; a losing producer's chunks wait for its next send or a restart; an all-null usage reading labelled current until the Phase 4 UI; a missing window key gives no reading; `report.ts:78` comment says "complete" (first Phase 4 unit) | recorded in the run decisions |

## Plan §3.6 Gate 3 checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | All 24 EC rows pass with their PRD test types, or each unavailable required branch has an explicit owner disposition; no blanket `agy` pass; EC-25 cites S5 | met | `npm test` 900/900 incl. every Gate 3 EC test (P3-T17 step 0); dispositions D-P3-08; EC-25: S5 evidence plus the live two-step Codex trust check (P3-T17 live checks) |
| 2 | §6.7 thresholds (M8) on the declared fixture scope; B1/B2 per fixture; unavailable `agy` cases listed | met | `replay.test.ts` in `npm test` (order invariance kept after G3c-3, harness stamps report arrivals); B1/B2 and unavailable cases: P3-T07, D-P3-08 |
| 3 | M1, M2, M3 (with M1/M2 during import), M4, M7, M11 (ingestion), M16 (incl. tee overhead) on the packaged app on the reference Mac; misses accepted by the owner | met, with disclosures | suite table above; accepted miss M11 file-only (D-P3-19); M16 first-run 100.6 ms under external load, rerun pass (owner to note); M7 by the forwarder/tee tests in `npm test` |
| 4 | Gate 1/2 EC regression green; audit 0 in every E2E run; repo unchanged after runs | met | `npm test` 900/900; E2E 20/20 under the audit fixture; packaged gate audit pass; `git status` clean |
| 5 | Helpers audited in every P3-T16 mode: 0 attempts | met | helper audit 32 cases, 0 attempts |
| 6 | EC-47 regression: dev and prod data dirs give distinct, coexisting sockets | met | P3-T02 socket tests in `npm test` |
| 7 | No agent-config write outside disposable profiles; dev CLI refuses real roots; no renderer Connect IPC | met | config-transaction and dev-CLI tests (confinement, real-root refusal) in `npm test`; IPC tests; guard MATCH on every live step |
| 8 | Guard MATCH for every live session; `agy` runs had owner OK/budget; skipped or missing native evidence has dispositions | met | P3-T13e (agy), P3-T17 live checks (every step MATCH, prompts disclosed); unverified native items listed there (e.g. Codex tool hooks without a matcher; real macOS notification D-P3-22) |
| 9 | Only reduced schemas and numberless facts in git; `privacy:scan` and `fixtures:lint` green | met | privacy `--all` and `--history` clean (D-P3-21 allowlist); `fixtures:lint` clean |
| 10 | harness-os: every unit's workflow complete (RED and GREEN observed); decisions recorded | met | runs 49–75 completed; review-fix runs 70–75 RED → GREEN recorded; critical run 71 approval 1131 (owner, D-P3-25) |
| 11 | Playwright MCP visual check for T10/T11 UI; console clean; status as text plus icon | met | visual check row above |
| 12 | `/ponytail-review` clean or resolved; no dependency added without approval | met | D-P3-23; lockfile unchanged since the baseline (only the `dist:mac` script gained the forwarder build) |
| 13 | `docs/integrations/report-v1.md` and the progress file updated | met | report-v1 (producer assembly, chunk boundaries); progress P3-T17 rows, D-P3-21..27 |
| 14 | GS: Codex review (all chunks), Claude second review, `.handoff/` deleted, owner stop, PR | partly | reviews done (above); `.handoff/gate3-*` deletion: owner (deletion is blocked in Claude's session); owner stop and PR pending |
