# Gate 4 record

Post-freeze evidence for Gate 4 (plan §2.4 step 6, P4-T18, D-P0-07). The frozen tree is the gate SHA; this file is the only change in the gate-record commit.

| Item | Value |
|---|---|
| Gate SHA | `e1cd15c` (branch `feat/phase4-session-workspace`) |
| Baseline | `master` at `43c2e24` (after the Gate 3 and Gate D merges) |
| Freezes | `48118dd` (first, reviewed), `b4b4324` (round-1 fixes), `bae686f` (round-2 fixes), `e1cd15c` (last fix; the suite below) |
| Fix commits | efb0716, 730b3fd, 38f8786, 86d4e6b, 221cac9, c72c1e4, a1a892e, 82827e0, 5c8de78, 1973d2b, 61a2b32, 75f6638, 00bcd0f, 11c2ad8, d5e426d, 70260ca, 9ac910d, 2498099, be7142c (harness runs 116–132) |
| Owner decision | **Approved** 2026-11-17 on `e1cd15c` ("those look good enough") |
| Push / PR | owner asked for the PR with the approval |

## Suite on the gate SHA `e1cd15c` (clean clone, `npm ci`, repo `.cache/` caches)

Environment: Apple Silicon, 10 cores, 16 GiB, Darwin 27.2.0, Electron 45.2.3.

| Check | Result |
|---|---|
| ci, lint, typecheck, test:electron, build, dist:mac | pass |
| `npm test` | suite run 1209/1212 while a Codex review ran in parallel (forwarder 100 ms delivery, 5,000-session watch 1,252/1,000 ms, reprice loop hold 279/250 ms); three quiet reruns in the same clone **1212/1212** each |
| `test:e2e` (61, connection audit in every launch) | **61/61** |
| M1/M2/M11 (T0 live) | M1, finishing, settled (p95 ~4,133 ms), M11 hook, M2, priced, recovery pass; **M11 file-only p95 ~5.0 s: accepted miss (D-P3-19)** |
| Notifications (T0) | pass: p95 ~1 ms, 0 extra |
| M16 (T0, 200 runs per mode) | pass: up-mode added wait p95 ~42 ms |
| M12/M13/tray (T0 cold, 20 runs) | pass (all checks; `noEaccesLogged`) |
| M3 full (t1mix-1, 20 cold runs) | pass: import ~52 s (120), 0 frames > 100 ms |
| EC-15 | pass |
| EC-57/EC-100/M14 at TP with usage and disk-full (600 s) | pass, all 23 checks incl. fullProfile, loadRate, byte-exact teeM7, diskFullFaulted with workspace reopen: M1 steady p95 ~225 ms, M2 p95 ~311 ms, drain 43 ms; T2 in the scale-up stage (D-P4-07) |
| M5 / M4 (t1mix + 50 idle live sessions, 3 × 5 min) | pass: footprint max ~225 MiB Dashboard, ~179 MiB workspace (450 MB); window closed ~181 MiB (250 MB), CPU mean 0.16 % (D-P4-12) |
| Packaged audit `scripts/gate-audit.ts` (M6, EC-60, EC-61) | pass |
| `privacy:scan -- --all`, `--history`; `fixtures:lint`; `spike:test` | clean / pass |
| `git status` after the suite (clone and repo) | clean |
| `~/Library/Caches` newer than the marker | 32 entries, all Claude Code's own MCP logs under `claude-cli-nodejs/<project folder>` (matched by the folder name); none from Xaibo, Electron or npm |

## Reviews

| Step | Reviewer | Scope | Verdict |
|---|---|---|---|
| Pre-freeze | Claude `/ponytail-review` (fresh agent) | working tree | 21 simplification findings, deferred (D-P4-13) |
| Gate review (six chunks a–f) | Codex (`codex exec -s read-only`, account default model; gpt-6.2-sol refused for a ChatGPT account) | `43c2e24..48118dd` | e approve; a, b, c, d, f reject: 22 findings (18 major, 4 minor) |
| Second review | Claude (five fresh verifiers with reproductions) | chunk diffs + Codex findings | none refuted; 5 major confirmed (G4b-2, G4c-1, G4d-1, G4d-2, G4d-3), others minor; 3 new minors |
| Fix units | delegated implementers; fresh code/security reviewers per unit | runs 116–127 | approve |
| Fix re-review 1 | Codex | `48118dd..b4b4324` | reject: 17 resolved, 7 partly |
| Fix units | delegated implementers | runs 128–131 | approve |
| Fix re-review 2 | Codex | `b4b4324..bae686f` | reject: 1 new major (unbounded marker refresh) |
| Fix unit | delegated implementer | run 132 | approve |
| Fix re-review 3 | Codex | `bae686f..e1cd15c` | **approve** |
| Second review of the fix delta | Claude (fresh code reviewer) | `48118dd..e1cd15c` | **approve** (2 minors accepted) |

## Finding dispositions
| ID | Verdict | Severity | Fix |
|---|---|---|---|
| G4c-1 | confirmed (Session list only, multi-page reload) | major | hold deltas during reload, replay over snapshot (pure helper in data/pages.ts) |
| G4c-2 | partly (no trailing read; retry-on-tick is the D-P4-09 design) | minor | one trailing usage read 5 s after a throttled tick; first-failure retry timer |
| G4c-3 | confirmed (>100 live sessions) | minor | single-flight live-set refill when a capped set shrinks |
| G4c-4 | confirmed | minor | AttentionView gets loaded/failed; empty text only when loaded |
| G4d-1 | confirmed | major | Hide session list only while a session is open |
| G4d-2 | confirmed | major | VirtualList anchor request; OpenSession anchors first/latest |
| G4d-3 | confirmed | major | markers paged with a fixed budget + RetryNotice |
| G4d-4 | confirmed | minor | keep empty continuation pages' cursor |
| G4d-5 | confirmed | minor | ContextPane shows Retry above a retained reading |
| G4d-6 | confirmed | minor | coverage spoken in agent-reported/unavailable cost states |
| G4d-N1 | new, confirmed | minor | transcript Retry repeats the failed request |
| G4f-1 | partly | minor | detach then delete image; SIGINT guarded cleanup |
| G4f-2 | partly (logged runs 98.6-98.7 % of profile) | minor | expectedEvents + loadRate/fullProfile checks |
| G4f-3 | confirmed (unit goldens already exact) | minor | tee check compares bytes + exit |
| G4f-4 | confirmed | minor | workspaceReopened in diskFull checks |
| G4f-5 | confirmed | minor | rename to noEaccesLogged; reword ledger |
| G4f-6 | confirmed (stale doc vs D-P4-06) | minor (docs) | design §2.1/§5.1 apply the D-P4-06 exception |
| G4b-1 | partly (status effect predates branch; 4cf9762 message overclaims) | minor | Claude status-map line(): injected string prefixes emit nothing (all five); not in generic feed |
| G4b-2 | confirmed | major | report model evidence older than max producer_seq marked stale: no current_model/effort update, per-turn kept |
| G4b-3 | confirmed (broader: spooled hooks behind a report blocked) | minor | lazy, retried report intake; always pass reports/deliverReport; replay once on recovery |
| G4b-N1 | new | minor | injected check uses only string content or content[0] text, not first text block |
| G4a-1 | partly (observed Claude format = one block per record) | minor | optional call selector on slice requests; matching tool_use/tool_result block |
| G4a-2 | confirmed (rare order) + tool.rejected-before-start | minor | keep confidence; only confirmed ends close; rejected only when in flight |
| G4a-3 | confirmed (boot reprice >2000 rows or override reload) | minor | onPriced → one bounded resync per multi-slice job |

## Codex fix-only re-review 1 (48118dd..b4b4324): reject; 17 resolved, 7 partly
| ID | Status | Disposition |
|---|---|---|
| R1-1 (G4b-2 follow-up) | major | fix: compare only against model-bearing evidence (Codex ruling) |
| R1-2 (G4a-1 wiring) | minor | fix: main.tsx workspaceApi forwards `call` |
| R1-3 (G4a-3 follow-up) | minor | fix: explicit price reload always notifies |
| R1-4 (G4d-3 follow-up) | minor | fix: bounded marker continuation control |
| R1-5 (G4a-2 follow-up) | minor | fix: inferred request/resolve ignored as in the engine |
| R1-6 (G4b-N1 follow-up) | minor | fix: oversized checks first block type |
| R1-L answerMarkers DB error → empty page | minor | fix: report failure |
| R1-L hold overflow starvation | low | accepted (bounded memory; deltas keep rows current) |
| R1-L misplaced comment; repeated context alert | low | Phase 5 cleanup / a11y |

## Re-review 2 (b4b4324..bae686f): reject, 1 new major → XAIBO-PROD-457 (be7142c)
## Re-review 3 (bae686f..e1cd15c): Codex approve
## Claude second review (48118dd..e1cd15c, fresh ecc:code-reviewer): approve
| Minor | Disposition |
|---|---|
| VirtualList re-applies first/latest anchor on remount (tab switch) | accepted (remount resets scroll anyway); open item |
| AttentionView failed text has no live region (Retry in summary notice by design) | accepted; Phase 5 a11y |

All findings are fixed or accepted as listed; accepted lows and follow-ups are in the progress ledger rows "P4-T18 Gate 4 review / re-review 1 / re-review 2" and the Phase 5 cleanup row.

## Owner decision

Approved by the owner on 2026-11-17 on gate SHA `e1cd15c` ("those look good enough"). Accepted with it: M11 file-only miss (D-P3-19, unchanged since Gate 3); M14 measured at TP, T2 in the scale-up stage (D-P4-07); the 21 deferred simplifications and the accepted lows (Phase 5 cleanup unit, D-P4-13); harness decision 2105 still pending at the owner's terminal (non-blocking).
