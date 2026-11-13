# Documentation audit ledger (2026-11-13)

Codex (lead designer) audited the newest version of every doc, read-only: PRD v1.3 draft, plan, progress, Phase 0
report, gate records, process docs, report contract v1, Orca scope and research notes, usage-broker guide, and the
local LLM / AEGIS drafts. It found 114 items: A = conflicts, B = unanswered, C = stale or dangling, D = gaps a coding
agent would hit. Claude triaged them. The full Codex report with file:line evidence is kept outside git (`.handoff/`);
this ledger tracks closure.

**Rules for this ledger.** "Blocker" means a blocker for the affected feature only; approved Phase 3 work continues.
`xaibo_plan.md` and `xaibo_progress.md` are being edited on the Phase 3 branch, so their fixes wait until Phase 3
merges (status **after P3**). PRD and side-doc fixes land on this branch (status **now**). Line numbers refer to the
audit snapshot.

Rebased 2026-11-13 on master's hard-rules-vs-defaults update: AGENTS.md now splits hard rules (privacy, real data, zero network, git, installs, gate order) from defaults; the fixes here keep the hard rules intact and the PRD's browser checks are tool-agnostic to match.

Status values: **fixed** (with commit or note), **now** (Claude fixes on this branch), **after P3** (Claude fixes in
plan/progress after Phase 3 merges), **Codex design** (needs a design decision, then review), **owner** (owner decides),
**phase entry** (decide when that phase starts; nothing to do now).

## A. Conflicts

| ID | Issue (short) | Sev. | Status |
|---|---|---|---|
| A1 | Headers name v1.0 or pending v1.1; Gate 0 approved v1.1 | blocker | fixed (audit fix 1); after P3 (plan header) |
| A2 | Gate 0-approved defaults still say proposed/pending | should | fixed (audit fix 1 and 2; Q15 in fix 2) |
| A3 | D-22 tee approved via D-27 but summaries say pending | should | fixed (audit fix 1) |
| A4 | v1.2 history says reviews done and pending at once | should | fixed (audit fix 1) |
| A5 | v1.3 path omitted Claude second review | blocker | fixed (v1.3 App. G records Claude second review) |
| A6 | Broker exception vs unconditional zero network | blocker | fixed (c3a93b2: mode clause in §1.4, M6, §1.6, P1, P2, FR-44, §7.1, §9.3, S10; AGENTS.md) |
| A7 | Active quota requests / refresh toggle still out of scope; §9.3 FR-44 check | blocker | fixed (audit fix 1) |
| A8 | Method order differs between FR-56 and guide | blocker | fixed (c3a93b2: agent interface first everywhere) |
| A9 | How a sign-in change is detected while polling is stopped | should | Codex design |
| A10 | Local LLM draft fixes Claude as orchestrator vs S-42 owner-chosen lead | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| A11 | `delegate_task` expands the fixed MCP tool surface | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| A12 | AEGIS "enforcement deferred" vs S-43 guard hook | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| A13 | Local model calls vs no-model-call rules | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| A14 | Plan still requires plan-scale T2/T3 at Gates 4/5 despite scale-up deferral | blocker | after P3 |
| A15 | Approved worker layout vs plan treating workers as optional | blocker | Codex design (plan) |
| A16 | Blanket async-hook wording vs sync Stop and Codex per-event subset | blocker | fixed (audit fix 1 and 2: §5.2 Stop, §7.3 per-agent async) (PRD); after P3 (plan) |
| A17 | PRD allows sanitized recordings as fixtures; plan forbids | should | fixed (audit fix 1) |
| A18 | Keychain guard spec vs OQ-X3 default | blocker | after P3 |
| A19 | Disposable profiles still placed in repo `.cache/profiles/` (D-P0-15 moved them) | blocker | after P3 |
| A20 | Plan still prescribes env-token escape detection (D-P0-12 replaced it) | should | after P3 |
| A21 | Plan ranks embedded PTY evidence above hooks vs FR-55 | blocker | Codex design |
| A22 | Report guide promises receive-time ordering vs causal ordering | blocker | Codex design |
| A23 | Silent/exit-0 reporting rule vs `xaibo-report` exit 2 and stderr | blocker | fixed: owner chose two modes (silent hooks; `xaibo-report` may print errors and exit non-zero); PRD Tokens and AGENTS.md |
| A24 | Every report exit 2 called permanent, including temporary failures | should | Codex design |
| A25 | Literal order invariance includes hooks-missing (D-P3-07 distinguishes) | blocker | Codex design |
| A26 | Stop/subagent "Background work" vs "Finishing…" wording | blocker | Codex design |
| A27 | Required fixtures include cases deferred per agent | blocker | after P3 (needs the progress matrix) |
| A28 | S-36 shorthand attributes quota peaks per model | should | fixed (audit fix 1) |
| A29 | Clear usage history listed among settling operations | blocker | Codex design |
| A30 | Phase 0 report says hook content never stored vs full local storage | should | fixed (audit fix 1) |
| A31 | Transcript-only Claude context window vs D-P2-04 (unavailable until tee) | blocker | fixed (audit fix 1) (PRD); after P3 (plan) |
| A32 | EC-74 link still required despite owner deferral | should | fixed (audit fix 1) (PRD); after P3 (plan) |
| A33 | T1 corpus shape vs accepted gate evidence | should | Codex design |
| A34 | Orca scope hypothesis "no manual setup" vs setup scripts left to owner | should | fixed (audit fix 1) |

## B. Unanswered

| ID | Issue (short) | Sev. | Status |
|---|---|---|---|
| B1 | v1.2, v1.3, AEGIS and OpenShell ideas are proposals | blocker | owner (PR reviews #9, #10, #12) |
| B2 | Gate 3 live checks pending (Claude plugin, Codex trust, tee) | blocker | Phase 3 (owner) |
| B3 | Owner notification visual check; stray hook copy cleanup | should | Phase 3 (owner) |
| B4 | P3-T15 and packaged Gate 3 perf/helper audits unfinished | blocker | Phase 3 |
| B5 | agy native dispatch/added wait not measured (M16) | blocker | Phase 3 (owner) |
| B6 | VS Code/Desktop visibility, daemon attach, PTY visibility unverified | should | Codex design (capability rows) |
| B7 | Claude cleanup age basis unverified | should | Codex design |
| B8 | Gemini never verified; agy capability gaps | blocker | owner: agy built-in; Gemini for API-key users, unverified (with C1) |
| B9 | Codex cache-write, agy reasoning/cache, prices | should | Codex design |
| B10 | Cross-profile freshness and account epochs to validate in T15 | blocker | Phase 3 (T15) |
| B11 | S2/S8/ACP/category pre-feature evidence | should | phase entry |
| B12 | S14, S15, clone cost evidence tasks | blocker | Codex design (after #10 approval) |
| B13 | Broker provider/method matrix and terms reviews | blocker | owner + S16 (after #12 approval) |
| B14 | Q31–Q34 defaults | blocker | owner (delegated to Claude 2026-11-13; confirm in #12) |
| B15 | Guard deny formats, latency and rule format | blocker | owner + S17 |
| B16 | Local model tier and fine-tune claims unvalidated | should | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| B17 | AEGIS/local LLM metric targets and safe task types TBD | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| B18 | AEGIS phases not placed in the roadmap | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| B19 | OpenShell O1/O5 extraction, thresholds, placement open | blocker | Codex design (after #9 approval) |
| B20 | O1–O7 not individually accepted | should | owner (#9 review) |
| B21 | Design/UI defaults (Gate D, Phase 4) | should | phase entry |
| B22 | Phase 5 defaults | should | phase entry |
| B23 | Phase 6/7 choices | should | phase entry |
| B24 | v1-A/B/C defaults | should | phase entry |
| B25 | OS builds, CI, license, signing, encryption | should | phase entry (before cross-platform/public work) |
| B26 | Gate 2 note about a real-machine count in an old commit has no recorded disposition | should | owner |
| B27 | Unreproduced test failures tracked only as prose | should | after P3 |
| B28 | Export and command palette have no phase | should | owner |

## C. Stale or dangling

| ID | Issue (short) | Sev. | Status |
|---|---|---|---|
| C1 | Gemini→agy replacement is only a reading instruction; requirements still say Gemini | blocker | fixed (audit fix 2): owner 2026-11-13: agy is the built-in third agent (§5.9 contract); Gemini CLI stays as an API-key/Vertex catalog agent, UNVERIFIED until S11 re-runs; after P3 (plan) |
| C2 | Branch matrix names the Gemini Phase 2 branch | cosmetic | after P3 |
| C3 | P2-T00 cites S11 C1–C14; only C1–C12 exist | should | after P3 |
| C4 | "SG procedure" never defined | blocker | after P3 |
| C5 | D-P2-09 cited but missing from the decision log | should | after P3 |
| C6 | keyset test path stale | should | after P3 |
| C7 | usage/context test paths stale | should | after P3 |
| C8 | Codex hook template documented as a repo file | should | fixed (audit fix 1) (PRD); after P3 (plan) |
| C9 | Report helper file location stale | should | after P3 |
| C10 | P2-T00 self-test file never existed | should | after P3 |
| C11 | EC-50, agy facts, Codex compaction still "unverified" after evidence | should | fixed (audit fix 1) (EC-50); after P3 (progress) |
| C12 | Old ledger rows still say pending after later resolution | should | after P3 |
| C13 | Orca auxiliary docs keep answered questions open | should | fixed (audit fix 1) |
| C14 | Traceability and roadmap stop at EC-105 / v1-D | should | after P3 and after #10/#12 approval |
| C15 | Plan metadata revision and spec-ID prefix stale | should | after P3 |
| C16 | Consolidated defaults list superseded values | should | after P3 |
| C17 | Hook wire protocol described in different partial forms | blocker | Codex design |

## D. Gaps

| ID | Issue (short) | Sev. | Status |
|---|---|---|---|
| D1 | No precedence rule between PRD, approved decisions in progress, plan and drafts | blocker | fixed: owner chose "newest approval wins"; PRD header and AGENTS.md |
| D2 | S-37/S-38 have no plan tasks | blocker | after #10 approval (plan) |
| D3 | v1-A lacks S-39/S-40 tasks | blocker | after #10 approval (plan) |
| D4 | Broker, orchestrator, guard, metrics lack plan tasks | blocker | after #12 approval (plan) |
| D5 | Bare-repository wording and "outside its root" undefined | blocker | fixed (audit fix 1) |
| D6 | Worktree ignored-file enumeration, traversal, symlinks, races undefined | blocker | Codex design |
| D7 | Sign-in evidence vs owner declaration precedence | blocker | fixed (audit fix 1) |
| D8 | Key entry path | blocker | fixed (c3a93b2: CRED11) |
| D9 | Agent-interface broker method has no invocation contract | blocker | Codex design (with S16) |
| D10 | Source `broker` missing from the normalized schema | blocker | Codex design |
| D11 | Provider disablement, in-flight network-off, release ownership | blocker | partly fixed (CRED7, CRED10); Codex design for cancellation states |
| D12 | Hard budget vs delayed spend evidence | blocker | fixed (c3a93b2: stop threshold with overshoot) |
| D13 | MCP control extension versioning for S-42 | blocker | partly fixed (run grants); Codex design for versioning |
| D14 | Guard deadline | blocker | fixed (c3a93b2: 300 ms absolute deadline) |
| D15 | AEGIS rule schema, precedence, verdict schema | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| D16 | Policy layering algebra (union/intersect/override) | blocker | Codex design (after #9 approval) |
| D17 | `delegate_task` contract | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| D18 | Model server install, downloads, network | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| D19 | Real-history training/export data flow | blocker | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| D20 | AEGIS phase names A–E collide with Phase D / v1-A..E | should | deferred: owner 2026-11-13 keeps the AEGIS/local LLM draft (#9) separate until a final decision |
| D21 | Report helper retries without stable IDs | blocker | Codex design |
| D22 | Report contract omits bounds and semantics | blocker | Codex design |
| D23 | Report guide omits accepted-but-incomplete | should | Codex design |
| D24 | Live test invoked through `npm test` that doesn't select it | blocker | after P3 |
| D25 | Plan commands chain the test command | blocker | after P3 |
| D26 | Listed task order vs dependencies | should | after P3 |
| D27 | Canary test recipe uses `git commit --dry-run` | should | after P3 |
| D28 | Purge vs active spool rotation and crash cleanup | blocker | Codex design |
| D29 | Monthly accounting needs owner time zone at event time | blocker | Codex design |
| D30 | Real-profile enablement vs frozen gate SHA | blocker | Codex design |
| D31 | Temp profiles retired at Gate 6 but later spikes need them | should | after P3 |
| D32 | `ponytail:` vs another comment convention | should | fixed: owner delegated tool conventions to the agents (2026-11-13); the repo keeps `ponytail:` (existing code and PRD), written into AGENTS.md |
| D33 | FTS 64 KiB cap per item vs per chunk | should | Codex design |
| D34 | Stale/sampling identity for unknown measurement time | blocker | Codex design (T15 contract) |
| D35 | Public release plan only needs a signing decision vs CRED10 | blocker | fixed (audit fix 1) |
