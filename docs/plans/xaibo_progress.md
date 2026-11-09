# Xaibo progress

Live status file for `docs/plans/xaibo_plan.md` (HARNESS_PROCESS §2, PRD §1.6 item 4). It must always show the real status.

## 1. Current status

| Item | Value |
|---|---|
| Current phase | **Phase 0: plan drafted, awaiting challenge/approval** |
| Branch | `feat/phase0-spikes` |
| Plan version | Draft v0.1 (2026-11-09) |
| Gate state | Gate 0 not started. No spike implementation before the owner approves the challenged plan (PRD §10). |
| Next step | Codex challenge of the plan (HARNESS_PROCESS §3 step 5) → revise → owner approval → P0-T01 |
| Blockers | Owner approval of the challenged plan; owner choice of unsandboxed-run mode (OQ-X2) |
| Baseline for Gate 0 review | `master` at `e6b39ab` |

## 2. Per-phase status

| Phase | Branch | Status | Gate | Gate date | PR |
|---|---|---|---|---|---|
| 0 Spikes | `feat/phase0-spikes` | plan drafted, awaiting challenge/approval | Gate 0 | — | — |
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

## 4. Design-decision log

One entry per decision where the PRD left a detail open, per owner decision, per plan deviation, and per `record_decision` call. Newest last.

Entry format:

| ID | Date | Decision | Reason | PRD ref | `record_decision` id | Approver |
|---|---|---|---|---|---|---|
| `D-P<phase>-<nn>` | YYYY-MM-DD | what was decided | why (evidence or owner instruction) | §/FR/EC/Q | harness id or — | owner / Claude |
| D-P0-01 | 2026-11-09 | Full plan for every phase; live-agent spikes run by Claude in disposable temp profiles the owner signs in to; electron-builder moves to Phase 0 | Owner answers at Phase 0 start | HARNESS_PROCESS §3.4; App. C; §8 | — | owner |
| D-P0-02 | 2026-11-09 | OQ-X2, OQ-X4, OQ-X7, OQ-X10 resolved with the plan defaults (in-sandbox first, else per-command approval; stop live spikes on any real keychain change; branch commit before each gate review; ≤40 tiny prompts per agent in Phase 0) | Owner: "4 questions are good for default answer" | plan §6.1 | — | owner |

(no entries yet)

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
| Choose unsandboxed-run mode (OQ-X2) | pending |
| Confirm Phase 0 installs (P0-T01) | pending |
| Sign in to temp profiles (P0-T06) | pending |
| Answer or accept defaults for open questions (plan §6) | pending |

## 9. Gate records

| Gate | Date | Codex verdict | Claude verdict | Owner decision | PR |
|---|---|---|---|---|---|

(none yet)

## Update rule

- Update in the same working change as each task, as soon as it becomes done or blocked; on every design decision where the PRD left a detail open; on every owner decision; and before each gate review (the review diff includes this file). Never batch updates at phase end.
- Spike findings only in `phase0_spikes.md`; this file links to them.
- Repo privacy rules apply in full: no counts, paths, IDs, ports or prompts from the owner's machine.
