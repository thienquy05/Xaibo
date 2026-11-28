# MVP Gate (Gate 7) record

Post-freeze evidence for the MVP Gate (plan §2.4 step 6, P7-T13). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `75e04ae` (branch `feat/phase7-control`) |
| Baseline | `master` at `c7e8304` (D-P7-01) |
| Freezes | `608f440` (first, reviewed; step 1 through E2E green, stopped before perf), `1c5c732` (round-1 fixes; step 1 stopped), `75e04ae` (round-2 fixes; full suite below) |
| Fix commits | `8075cc9` (XAIBO-PROD-628/629, hotfix runs 265/266, owner approvals 4154/4155), `d547ec1` (XAIBO-PROD-630, hotfix run 267, owner approval 4168); docs `1c5c732`, `75e04ae` |
| Owner decision | **Approved** 2026-11-27 on `75e04ae` ("approve") |
| Push / PR | _pending owner request_ |

Environment: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0, Electron 45.2.3. Agents (temp profiles, guard MATCH): Claude 2.1.332, Codex 0.160.0, agy 1.5.6, unchanged since Gate 6. Clean clone of the gate SHA under the repo `.cache/`, `npm ci`, every cache in the repo `.cache/`.

## Full suite on `75e04ae`

| Check | Result |
|---|---|
| ci, lint, typecheck, build, dist:mac | pass |
| `npm test` | 2180/2180 |
| `test:electron` | 807/809: the accepted `import-liveness` timer test (D-P6-24) and EC-11 "socket accepts but never acks" under 1-min load ~13 (the file passes 3/3 alone on the same tree) |
| `test:e2e` (connection audit in every launch) | 97/97 |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | pass: 0 non-loopback, repo and fixture stores unchanged |
| `privacy:scan -- --all`, `--history`; `fixtures:lint`; `spike:test` | pass |
| perf T0 `live` | M1, M2, M11 hook, finishing, settled, priced, recovery pass; **M11 file-only: accepted miss (D-P3-19)** |
| perf `m11-launch` (M11 launch portion, 20 runs, spawn stubbed) | p95 46.5 ms (budget 300) |
| perf `m16 --runs 200`, `cold` (M12, M13 T0), `m4`, `m3-first-list`, `m3-full`, `ec15`, `M5`, `TP` (M14), `TP --only quota`, `TP --only m13` | pass |
| perf `TP --usage` (real mid-backfill disk-full) | **fail, accepted (D-P6-03, D-P6-04)**: M1 steady p95 ~2.78 s, M2 ~1.98 s, queue age, M5 under load; the diagnosed post-disk-full ingestion stall and the M5-under-load baseline, inside the Phase 6 measurements (filled-and-freed steady M1 up to ~13.5 s); plain TP passes |
| `git status` after the suite (clone and repo); new `~/Library/Caches` entries | 0 lines; 0 entries |

The `608f440` step 1 (ci through E2E, gate audit not reached) was green; its logs are in `.cache/gate7-results-608f440/` (local).

## MVP Gate checklist (plan §Phase 7), verified on `75e04ae`

*Gate 7 rows*
- [x] EC-20, EC-67, EC-76, EC-84, EC-85 pass (unit, integration and E2E above; RED in runs 249-267). EC-67 by its fallback (Desktop-origin resume view-only with the reason; S7 not re-run on 2.1.332, D-P7-10).
- [x] M11 complete: launch portion p95 46.5 ms; ingestion portion (hook) passes, file-only accepted (D-P3-19); external process start -> first signal unavailable without a live agent (US-8 deferred).
- [ ] US-8 verified live once by the owner: **deferred by the owner to the production stage (D-P7-10).**

*PRD §9.3 acceptance checklist*
- [x] All MVP §9.2 rows pass or have owner-approved waivers (gate records 1-6; Gate 7 rows above).
- [x] Added MVP rows EC-106..110 pass (gates 5 and 6; still passing).
- [x] All shipped §1.5 metrics measured and reported (table above); misses accepted: M11 file-only (D-P3-19), TP usage with disk-full M1/M2/queue age (D-P6-03), M5 under load (D-P6-04); M10 not shipped.
- [x] Add agent and custom reporter, launch grants and the assigned perf tiers pass; Gemini ships capability-gated and runtime-UNVERIFIED (PRD S-28-Gemini, D-P0-19).
- [x] Fixture replay meets §6.7 with B1/B2 (`replay.test.ts`).
- [x] Playwright `_electron` E2E covers the §9.3 list (P7-T12 audit; partial notes there).
- [x] Accessibility (E2E a11y specs; known T15b text200 footer focus-ring edge).
- [x] Screens follow the approved design (visual baselines; Phase 7 screens checked on the packaged app; launch, resume and grants specs assert no console error).
- [x] Usage, context, live-set totals, session access; price validation and provenance; no model or quota request.
- [x] Usage/context/cost at TP (T2/T3 in the owner-started scale-up stage, A14).
- [x] Synthetic account identifiers do not survive (`usage-account-canary.test.ts`).
- [x] Zero attempted non-loopback connections in every E2E run, the packaged audit and the helper audit (P7-T12).
- [x] Forwarder: 0 output bytes, exit 0, spool works, M16 met.
- [x] Connect/Disconnect round trip byte-identical (`roundtrip`).
- [x] Native agent files never modified (per-test checksum; `fixtureStoresUnchanged`).
- [x] App data private (E2E `no-system-runtime`); repo unchanged after runs.
- [x] Egress canaries pass.
- [x] Secret scan, privacy scan, fixture lint green on the full history.
- [x] Lint, typecheck, unit, integration, E2E, perf green on a clean checkout (with the accepted items above).
- [x] Licenses: no Phase 7 packages; no agent-flow code in `src/`; no AGPL code.
- [x] Before going public: tracked under Public release.

*PRD §1.6 Definition of Done*
- [x] 1. Every P0 item implemented (phases 1-7).
- [x] 2. Every MVP §9.2 row has a passing test or an owner-approved waiver.
- [ ] 3. Every §9.3 item checked: all but US-8 (owner-deferred, D-P7-10).
- [x] 4. All shipped metrics measured and reported; misses owner-accepted (D-P3-19, D-P6-03, D-P6-04).
- [x] 5. Every gate passed with Codex review, Claude second review and owner stop (this gate: below).
- [x] 6. The artifact runs without system Node or Docker and makes zero non-loopback connections.
- [x] 7. Privacy checks green.

## Reviews
| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude `/ponytail-review` (fresh agent) | Phase 7 `src/` diff | 15 findings, ~70 lines; deferred to a post-gate cleanup unit |
| Gate review (5 chunks a-e) | Codex | `c7e8304..608f440` | a reject, b reject, c approve-with-fixes, d reject, e reject: G7-1 (OQ-P7-3 pending-resume lock not wired), G7-2 (liveness change after preview skipped the warning), G7-3 (evidence could precede the provisional row), G7-4 (no-id binding took the first of two sessions); minors (dialog reply order, late binding over navigation, suppressed open, E2E identity, M11 probe, console-error claim) |
| Fix round 1 | Claude, hotfix runs 265/266 | XAIBO-PROD-628/629 | RED 1049/1052 -> GREEN 1051/1053; fresh security and code reviews: no critical/high, adopted |
| Fix re-review 1 | Codex | `608f440..1c5c732` | reject: G7R-1 (major: the acknowledgement wait was an unchecked liveness interval), G7-4 carried, request navigation minor |
| Fix round 2 | Claude, hotfix run 267 | XAIBO-PROD-630 | RED 1054/1057 -> GREEN 1058; fresh security review: MEDIUM throw path adopted |
| Fix re-review 2 | Codex | `1c5c732..75e04ae` | approve-with-fixes: G7R-1 resolved, G7-4 closed by owner acceptance; one minor (simultaneous request and binding delivery) |
| Second review | Claude (fresh reviewer) | `c7e8304..75e04ae` + Codex findings | approve with fixes (none before merge): two nits |

## Finding dispositions
- Fixed: G7-1, G7-2, G7-3, G7-4 (stored-at-offer candidates), round-1 minors, G7R-1, the request navigation minor (partly; see below), the security-review items (orphan row on acknowledgement timeout, warning escalation, candidate cap fail-closed, no resurrected failed row, safe() throw path).
- Accepted by the owner: G7-4 limit (a second session stored after the first bound, or hook-only, is not counted; D-P7-11).
- Accepted (owner delegated to Claude, 2026-11-27): D-P7-08 residual (per-launch confirmation is the in-app dialog once granted; launches 2 s apart, 5 s cooldown, grant dialog names the folder); the renderer-asserted concurrency confirmation (a UX guard; main still refuses a worse liveness); the milliseconds between the last liveness read and the spawn; the in-memory lock (a service restart releases it); test load flakes (EC-11, `import-liveness`).
- Deferred to a post-gate cleanup unit (owner delegated): Codex minor "simultaneous request and binding delivery" (the view may open the bound session; no deterministic E2E); Claude nits (uppercase-UUID resume reason; grant key length for agent ids over 25 characters; both fail closed, unreachable with the bundled agents); the 15 ponytail findings.
- Owner-deferred: US-8 and the OQ-P6-1 real-profile check to the production stage (D-P7-10).
