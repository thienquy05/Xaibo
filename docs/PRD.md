# Xaibo PRD

## Header

| Field | Value |
|---|---|
| Status | **v1.1 (Gate 0 PRD delta, pending owner approval at Gate 0)** — targeted edits from Phase 0 evidence (`docs/plans/phase0_spikes.md`, decisions D-P0-01..33, record_decision 16, 23–28, 32–37); items marked "proposed" need the owner's decision. Previously: **Approved v1.0 — owner, 2026-11-09.** Errata (owner, 2026-11-09): App. C `electron-builder` moved to Phase 0 (plan decisions D-P0-01, D-P0-05); no other change. History: v0.6: monthly usage history added (Codex diff review approve-with-fixes, fixes applied; Claude second review); v0.5: usage status, context, estimated cost, model names + effort level, original-design step added (Codex design; Codex diff review approve-with-fixes, fixes applied; Claude second review). **Awaiting owner approval** (HARNESS_PROCESS §3 step 3). Owner decisions of 2026-11-09 supersede the previous estimated-cost restrictions, resolve Q16 and Q21 and require an original Xaibo design (D-23). No new target is verified until its assigned gate passes. |
| Date | 2026-11-09 |
| Owner (decides, approves every gate) | The user (repo owner) |
| Lead designer, first reviewer | Codex |
| Implementer, second reviewer | Claude |
| Design input | `.handoff/` design v0 (deleted after handoff) + Codex Design v1 delta + Codex Design v2 delta (Add agent / scalability / speed) (both summarized in App. G) + `.handoff/research-usage-context.md` (2026-11-09) + Codex Design v3 delta (App. G) |
| Process | [docs/process/HARNESS_PROCESS.md](process/HARNESS_PROCESS.md); template [PRD_TEMPLATE.md](process/PRD_TEMPLATE.md) |

**Privacy rule.** The repo is treated as public from day one. No real usernames, emails, account/organization identifiers, plan or credit values, absolute home paths, ports, session IDs, prompts, transcript content or counts from the owner's machine may appear in git, docs, fixtures, screenshots or logs. Use `~` and placeholders such as `<session-id>`, `<project>`, `<port>`. Only aggregated facts appear here.

**Conventions.** **UNVERIFIED** = needs a concrete test (most map to a Phase 0 spike, §10). **Proposed** = a default target the owner may change. "Egress" = any path by which data leaves Xaibo's private store (§4.3).

---

## 1. Executive summary

### 1.1 Problem
People who run several coding agents (Claude Code, Codex) across terminals, VS Code and the agents' desktop apps cannot see in one place which session is working, waiting for permission, stuck or done, what each one did, or how much it used. History is scattered across each agent's private store, and Claude deletes its own transcripts after 30 days by default.

### 1.2 Proposed solution
Xaibo is a local-only desktop app that observes supported agents in detected, readable local profiles through hooks, native history and the versioned report contract, normalizes their evidence into private SQLite history, and provides live status and paged history. MVP supports Claude Code, Codex, Gemini CLI and custom agents implementing the report contract. Agent identities are catalog data; unsupported native formats require an external reporter/converter or a separately tested adapter. It can launch and resume sessions (external terminal in MVP, embedded terminal in v1); shared history across clients is the promise, while visibility and control in VS Code and the agent apps are claimed only per surface/version after S6/S7 pass. In v1 it offers an opt-in, size-capped MCP server (read tools plus an optional gated control tool) so agents can query Xaibo's history; its answers reach the calling agent and may reach that agent's cloud provider.

### 1.3 Expected impact
- One live view of every agent session with confirmed vs inferred status, so waiting sessions are not missed.
- A durable, searchable, private history that outlives the agents' own cleanup.
- Comparable observed tokens, time, errors, interventions and estimated USD cost across agents, with coverage, source and pricing provenance. Plan/rate-limit status is separate from session consumption and cost.

### 1.4 Resources
- **People:** owner (decisions, approvals), Codex (design, first review), Claude (implementation, second review).
- **Compute:** owner's Apple Silicon Mac (development, reference for perf targets). Docker for dev tooling only (harness-os). Windows/Linux machines or CI runners later (§8).
- **Data:** the owner's local agent stores, read-only; Xaibo processes make zero non-loopback connections (opt-in MCP disclosure is covered in §4.3 P1). All tests use synthetic fixtures only (§9).

### 1.5 Success metrics (all targets proposed)

| ID | Metric | Target | Measured by |
|---|---|---|---|
| M1 | Hook/report latency, source event emission to painted UI state | p95 ≤250 ms; Stop/turn completion shows “Finishing…” within this target. Settled state p95 ≤configured turn-settle interval (default 4 s, §6.2/§6.3) +250 ms. | Instrumented synthetic emitter through packaged transport/service/renderer to paint; Gate 3 |
| M2 | Healthy file-only latency, complete record append to painted UI state | p95 ≤1 s; missed-watch recovery ≤watch reconciliation interval (FR-02) +1 s | Hooks disabled, instrumented append and paint; Gate 3 |
| M3 | Background import, 1,000 sessions / approximately 500 MB | Full import ≤120 s; usable list p95 ≤1.5 s; no renderer frame >100 ms; M1/M2 hold during import | Seeded size mix in §6.6; Gates 1–3 |
| M4 | Idle memory, window closed (tray, collecting) | <= 250 MB RSS across all Xaibo processes; idle CPU <= 1% over 5 min | Perf script sampling process RSS/CPU |
| M5 | Idle memory, window open | <= 450 MB RSS | Same |
| M6 | Attempted non-loopback connections by Xaibo processes (Chromium, main, service, forwarder; MCP from v1-C) | 0 attempts (not merely 0 successful requests) in every E2E run and in the OS-level socket audit | Connection-attempt audit covering all Xaibo processes (§4.3 P2) + socket audit; renderer interception alone is not proof |
| M7 | Tokens added to agent context by reporting channels | 0: hook forwarder stdout+stderr = 0 bytes, exit code 0, no prompt/agent hook types | Unit + integration tests on forwarder; config lint |
| M8 | Status detection on labeled fixtures | 100% match on confirmed-evidence transitions; 0 heuristic states shown as confirmed; legit long work never becomes confirmed stuck/error (expected inactivity/long-tool badges are permitted) | Replay harness (§6.6) |
| M9 | Egress leak canaries | 0 canary secrets on every shipped egress path: logs and crash/diagnostic bundles (MVP); exports, OTLP and MCP output once those paths ship | Canary tests (§9.2 EC-33..35) |
| M10 | Xaibo MCP footprint (v1) | 4 read tools (+ `control` only when enabled); every response <= 8 KiB measured after sanitization and serialization, including metadata/errors; tool-definition token overhead reported to the user before opt-in | MCP tests; token overhead (not dollars) shown in Integrations |
| M11 | Startup visibility | Xaibo launch action→provisional row p95 ≤300 ms. First observable session-start signal→identified row p95 ≤300 ms. External process-start→first signal measured separately without an Xaibo guarantee. | Synthetic external emitter and stubbed launch; Gate 3, launch portion Gate 7 |
| M12 | Application readiness | Cold process start→usable indexed list p95 ≤1.5 s; tray activation→painted usable hidden window p95 ≤300 ms | Packaged app, no full backfill/reindex on readiness path; Gate 4 |
| M13 | Session/search responsiveness | Indexed session selection→first bounded content page painted p95 ≤300 ms, including a 200 MB source transcript; indexed search submission→first page painted p95 ≤500 ms | Warm and cold application-cache runs on ≥10,000 sessions / ≥10 GiB DB; personal profile at Gate 5 (D-P0-24), plan scale in the scale-up stage (D-P0-26) |
| M14 | Live capacity | 50 concurrent sessions; 200 events/s for 10 minutes; 4 KiB mean serialized event size, p99 ≤256 KiB; M1/M2 hold, no unexplained loss/duplication, persistence queue age p95 ≤1 s and backlog drains ≤5 s after load ends | Seeded mixed-agent replay during background import; personal profile at Gate 4 (D-P0-24), plan scale in the scale-up stage (D-P0-26) |
| M15 | Extensibility | Add a synthetic fourth agent using catalog data and report events only; no core source changes; detection, setup, full-content storage and status tests pass | Integration fixture; Gate 6 |
| M16 | Agent interference | No reporting decisions, stdout/stderr or context tokens. Async reporting where supported; unavoidable synchronous hook added wait p95 ≤100 ms. Forwarder own deadline ≤100 ms from entry, including fallback attempt; agent dispatch/spawn measured separately. | S3 baseline comparison and fault injection; Gate 3 |

All timing targets are proposals until measured on the owner’s reference Mac. Tests record hardware, macOS, app/agent versions, corpus seed and actual DB/index sizes. “Usable” means a real bounded result page accepts input, not an empty skeleton. Backfill, reindexing, native startup/authentication delays, first-ever content import and migration recovery are reported separately. The 10 GiB floor includes populated content and index data, not padding.

### 1.6 Definition of Done (MVP)
1. Every P0 item in §3.1 is implemented.
2. Every row of §9.2 tagged MVP has a passing automated test, or a written waiver approved by the owner.
3. Every item in §9.3 is checked.
4. All shipped metrics in §1.5 are measured and reported, including M11–M16 for MVP and M10 when MCP ships. A miss requires explicit owner acceptance; unrun tests are not passes. Results go in `docs/plans/<feature>_progress.md`.
5. Each phase gate passed: Codex review, Claude second review, owner stop (§10). Gate D exception: Codex authors the design, so that gate is Claude review then owner approval.
6. The built macOS MVP artifact runs without system Node or Docker and makes zero non-loopback connections; development/build dependencies are separate.
7. Privacy checks green: secret scan, privacy scan, fixture lint, zero attempted non-loopback connections.

---

## 2. Problem definition

### 2.1 Users
- **Primary:** the owner, running Claude Code, Codex, Gemini CLI and personal/local agents across supported local surfaces on macOS.
- **Later:** the same profile on Windows and Linux; possibly public users if the repo goes public (§12).

### 2.2 Context
- Each agent writes sessions from several surfaces into one on-disk store per profile: Claude in `~/.claude/projects/` (CLI, VS Code extension and Desktop entrypoints observed there), Codex in `~/.codex/sessions/` (CLI, Desktop, exec and plugin-originated sessions observed). Whether every client observes the same history, and resume/attachment across surfaces, is **UNVERIFIED** per surface/version until S6/S7 pass; the result is published as a compatibility matrix, and unsupported surfaces show coverage limits.
- Claude exposes hooks (command, http, mcp_tool, prompt, agent handler types), a statusLine slot and OpenTelemetry. Codex exposes hooks (command, mcp_tool; trust-gated), a single `notify` command, OpenTelemetry and a versioned app-server JSON-RPC protocol.
- The owner's machine already has: a third-party hook tool (agent-flow) registered on several Claude events, a custom statusLine command, and a Codex `notify` command owned by another app. Xaibo must coexist with all three.
- Prior art: agent-flow (Apache-2.0; ingestion, visualizer, no history/app), harp (AGPL-3.0; status model, plugin setup; clean-room only), blazo (MIT; stuck/loop rules, OTLP collector), deer-flow (MIT; history/trash features). See App. D for reuse rules. Prior art and other references supply features only, never layout, navigation structure, visual style, tab/header naming or color schemes; Xaibo's UI follows its own design system (S-34, FR-50, D-23).

### 2.3 What the data actually looks like (aggregated; audit commands in App. F)
- **Claude transcripts:** one JSONL per session at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, plus `<session-id>/subagents/*.jsonl`. Directory names replace non-alphanumerics with `-`; names over 200 characters are truncated with a hash, so cwd cannot be decoded from the name. The line format is internal and changes between releases (Claude docs say so). Default retention 30 days (`cleanupPeriodDays`), so older native transcripts disappear.
- **Entrypoints are mixed in one store:** `cli`, `claude-vscode`, `claude-desktop`, `sdk-cli`. Sessions from `-p`/SDK are hidden from the CLI `--resume` picker but resumable by id.
- **Codex rollouts:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with five record types (`session_meta`, `turn_context`, `response_item`, `event_msg`, `compacted`), plus `archived_sessions/`, versioned SQLite state files (`state_<n>.sqlite`, `thread_history_<n>.sqlite`) and `session_index.jsonl`. Source kinds seen: `cli`, `vscode`, `exec`, plugin-originated.
- **Compressed history (`.jsonl.zst`)** may appear in agent stores. S9: present only in the Codex store; stream-decompressed with built-in `node:zlib` zstd (EC-03, App. E #8).
- **Versions at time of writing:** claude 2.1.319, codex-cli 0.160.0, Gemini CLI 0.46.0; Codex Desktop bundles a newer prerelease. Codex docs list hook events (PreModelRequest/PostModelRequest) that 0.160.0 lacks.
- **Missingness:** sessions started before any hook exists have file evidence only; Claude token counts exist per assistant message (`message.usage`); no provider-billed cost exists locally (statusLine and OTel `cost_usd` dollar fields are the agent's own estimates, not bills); Codex tokens via `event_msg.token_count` (cumulative and latest-request usage), no cost; reasoning text is present only when the source exposes it.
- **Confounds:** agent-flow and Xaibo hooks fire on the same events; one tool call appears in hooks, transcript and OTel; concurrent resumes can interleave two writers into one transcript.

### 2.4 Cost of not solving
Missed permission prompts stall work; stuck/looping sessions burn tokens unnoticed; history older than 30 days is lost; no basis to compare agents; manual tab-hunting across terminals and apps.

---

## 3. Scope

### 3.1 In scope

| ID | Item | Priority |
|---|---|---|
| S-01 | Catalog-driven detection of installed executables, versions and profiles; detection does not authorize execution, configuration or connection | P0 |
| S-02 | Claude transcript + subagent ingest (backfill + live tail) | P0 |
| S-03 | Codex rollout ingest (backfill + live tail); read-only state-db enrichment deferred unless file/hook coverage proves insufficient | P0 |
| S-04 | Normalized schema, dedup, source precedence, SQLite store with FTS5 | P0 |
| S-05 | Hook forwarder (zero output, fail-open, spool) + Claude hooks via plugin | P0 |
| S-06 | Codex hooks with guided trust flow | P0 |
| S-07 | Status engine (lifecycle + confidence), stuck/loop warnings, notifications | P0 |
| S-08 | Overview (live sessions, attention queue) and Session workspace (turns, workflow, tools, subagents, files, available reasoning) | P0 |
| S-09 | History: projects, folders, move, pin, archive, Trash, restore, purge with suppression, search | P0 |
| S-10 | Retention: Xaibo history policy, Trash auto-empty, per-session Keep, storage meter | P0 |
| S-11 | Integrations page: one-click connect/disconnect with diff preview, manifest, full uninstall | P0 |
| S-12 | Launch/resume in external terminal with ownership and concurrency guard; Open in VS Code | P0 |
| S-13 | Background collection after window close (tray); start-at-login opt-in | P0 |
| S-14 | Privacy/egress controls: masking engine, zero network, CSP, request blocking, private perms | P0 |
| S-15 | Repo leak checks: secret scan, privacy scan, fixture lint, pre-commit hook | P0 |
| S-16 | Compare tokens, estimated cost, time, errors and interventions with coverage; show observed plan/rate-limit history separately by usage scope | P1 |
| S-17 | Skills/MCP inspector (configured / loaded / called / unknown, from evidence only, FR-35) | P1 |
| S-18 | Opt-in chained Codex notify wrapper; Claude statusLine tee moves to S-31 | P1 |
| S-19 | Opt-in local OTLP/HTTP JSON receiver for built-in and generic GenAI producers, explicitly bound to an agent/profile; content and usage coverage shown | P1 (v1) |
| S-20 | Embedded terminal (node-pty + xterm.js) | P1 (v1) |
| S-21 | Xaibo MCP server (opt-in, grant-scoped, capped read tools; optional gated control tool) | P1 (v1) |
| S-22 | Codex app-server control for Xaibo-owned threads | P1 (v1) |
| S-23 | Windows and Linux builds | P1 (v1) |
| S-24 | Session export (masked) | P2 |
| S-25 | Connect previews a default-selected increase of Claude `cleanupPeriodDays` to `max(effective value, 45)`, aligning nominal native retention with Xaibo's default (native availability is checked separately and is not guaranteed); the owner may deselect it; managed policy wins; never lowers a higher value; restoration is conditional on the Xaibo-owned value being unchanged | P0 |
| S-26 | Command palette | P2 |
| S-27 | Add agent flow; bundled schema-validated catalog; private local-entry import; generic hook mapping and documented report contract | P0 |
| S-28 | Gemini CLI observation: hooks, full native history including subagents, last-write-wins/rewind folding, retention parity offer (D-19); interactive launch/resume after compatibility tests | P0 |
| S-29 | Measured live/history capacity, bounded queues and memory, database pagination and UI virtualization; M11–M16 | P0 |
| S-30 | ACP start/load/resume for Xaibo-owned compatible agents, capability-negotiated, with normal permission confirmation | P1 (v1) |
| S-31 | Separately opt-in, chained Claude statusLine tee; reported context totals, rate-limit windows and own cost estimate; files-only fallback | P0 |
| S-32 | Passive per-agent/profile usage status and observed quota history; context usage view (used/total and category breakdown); estimated session, per-agent and live-set cost with versioned local prices | P0 |
| S-33 | Evidence-based estimated Claude category composition and counts; partial Codex category evidence where available | P1 |
| S-34 | Xaibo design system: original visual identity, tokens, screen layouts and component patterns | P0 |
| S-36 | Monthly usage history: per-month totals (per agent/model: sessions, tokens, `~$` estimated cost, peak quota %) shown as a chart with the value for each month; totals survive the 45-day detail retention (FR-52) | P0 |
| S-35 | Model names: friendly model name (e.g. "Opus 5.5") shown for every running agent, session and subagent, from the agent's own display name or the bundled/editable model list; raw-ID fallback; model switches recorded | P0 |

### 3.2 Out of scope
Cloud/remote sessions; remote or LAN access; auto-update; code signing/notarization (until public release); answering permission prompts for sessions Xaibo does not own; creating, modifying or deleting agents' native transcripts, rollouts or databases (Xaibo modifies only previewed integration configuration, FR-33); quality leaderboards or benchmark claims; any off-machine data flow from Xaibo processes (analytics, crash upload, fonts, CDNs) (opt-in MCP answers that reach the calling agent's provider are disclosed, not prevented, §4.3 P1); Docker or tmux at runtime; multi-user/team features.

Remote catalog fetching, automatic agent/package installation, arbitrary in-process code plugins, screen scraping and dedicated OpenCode/Goose database readers are out of scope. Multi-machine/team/cloud operation remains out of scope; event identities and service interfaces must not depend on renderer state or a particular local transport.

Provider billing reconciliation, subscription-charge allocation, automatic price downloads, active quota/backend requests, and multi-machine collection/synchronization are out of scope. This includes Codex `account/rateLimits/read` and `account/usage/read`; no refresh toggle is planned. Gemini quota endpoints are not called.

### 3.3 MVP
MVP includes S-01..S-15, S-25, S-27..S-29 and S-31, S-32, S-34, S-35, S-36 on macOS, built from source. MVP control launches/resumes in the owner’s external terminal. Compare (S-16) and inspector (S-17) remain stretch for MVP and required for v1. S-33 is v1-B. MVP's context usage view lists its categories with unavailable values where no eligible measurement exists; estimated category composition is not an MVP promise. One installation observes one local machine; the versioned service boundary remains.

### 3.4 Learning goals (questions the project must answer)
1. Can live status be accurate using only zero-token channels? (M7, M8)
2. Does `node:sqlite` in Electron's runtime provide WAL + FTS5, or is `better-sqlite3` needed? (S1)
3. What does a hook forwarder cost per event with each runtime option? (S3)
4. Does a session Xaibo starts appear in VS Code / agent apps, and vice versa, for both agents? (S7, S6)
5. Can Xaibo attach to Codex threads owned by other clients through the shared daemon? (S6)
6. Can the Claude plugin route install hooks reversibly with zero token cost? (S4)
7. Which Gemini CLI folding, content and status semantics hold, and are the capacity/latency targets feasible on the reference Mac? (S11, S12)

---

## 4. Requirements

### 4.1 User stories

| ID | Story | Acceptance criteria |
|---|---|---|
| US-1 | I see supported live sessions in detected, readable profiles. | Initial visibility and updates meet M1/M2/M11; state shows text, icon and evidence confidence. |
| US-2 | I get told when a session waits for me. | OS notification within 2 s of confirmed permission/input wait; heuristic waits shown in-app only, labeled "Probably waiting"; notifications contain only agent, approved project label and state (never prompt excerpts, session titles, paths or tool content; no content opt-in). |
| US-3 | I can see what a session did. | Session workspace shows prompts, responses, available reasoning, tool calls with results, subagents, files (read / write attempted / write confirmed), usage, provenance. |
| US-4 | I am warned when a session is stuck or looping. | Warnings from §6.4 rules appear as badges with the rule and evidence; no automatic termination. |
| US-5 | I can organize history. | Move to project/folder, pin, archive, Trash with Undo, restore, purge; search finds text across sessions; none of these touch native agent files. |
| US-6 | I control how long Xaibo keeps history. | Retention setting (default: delete Xaibo's copy 45 days after last activity; Never or other N selectable), Trash auto-empty after 30 days, per-session Keep, purge date visible in session details, storage meter. Account-level usage history follows its own fixed 45-day rule (§5.11), independent of this setting and Keep. |
| US-7 | I connect Xaibo to my agents with one action and can undo it fully. | Diff preview before change; Connect installs; Disconnect restores exactly where Xaibo-owned values are unchanged (conflicts shown, never overwritten); existing agent-flow hooks, statusLine and notify keep working byte-identically. |
| US-8 | I start or resume a session from Xaibo and see it in VS Code / the agent app. | MVP: opens external terminal in the right cwd running the agent's interactive CLI; session appears in Xaibo; Claude session appears in the VS Code extension history only if S7 passes for that version (otherwise a documented coverage limit). External-terminal sessions remain externally controlled (FR-23). |
| US-9 | Xaibo keeps collecting when I close its window. | Tray icon visible; closing window keeps collection; Quit stops it; start-at-login is opt-in. |
| US-10 | I compare agents. | Compare shows tokens, estimated cost (`~`, labeled, with provenance, §5.12), time, errors and interventions by agent/model/project with coverage. Plan/rate-limit histories remain separate by usage scope. Missing values are unavailable, never zero; this is observed workload, not a quality benchmark. |
| US-11 | My agent can ask Xaibo about past sessions without token bloat (v1). | Opt-in with an explicit grant (agents, profiles, projects) enforced server-side on every call; 4 read tools (+ `control` only when enabled); responses <= 8 KiB after sanitization and serialization, paginated, masked; tool-definition token overhead and the disclosure in §4.3 P1 shown before enabling. |
| US-12 | Xaibo itself sends nothing off my machine, and I know what opt-in MCP discloses. | M6 = 0 attempted connections; MCP disclosure explained before enabling; masking (best effort) on every egress path; DB and spool files private (0600 / per-user ACL). |
| US-13 | I add an installed or personal agent. | Add agent rescans, lists detected candidates first, shows prerequisites and coverage, previews configuration changes, and tests receipt. Installation hints are copy-only. Connection never happens merely because detection succeeded. |
| US-14 | My history remains usable as it grows. | Lists and content are paged and virtualized; 50 live sessions and the large-history corpus meet M12–M14. |
| US-15 | My local copy contains the available conversation for every connected agent. | Prompts, responses, source-exposed thinking and tool I/O remain unmasked locally; missing content channels show “Content incomplete”; native deletion does not remove Xaibo history. |
| US-16 | I see my agents’ available plan/rate-limit status and history. | Overview shows reported windows, reset times, plan and credits where available; every reading has source/time information. Stale, expired, missing and ambiguous-scope readings are explicit. History contains observations only, with collection gaps visible. |
| US-17 | I see how much context a session currently uses. | The session view shows a context usage view: percentage and used/window tokens with provenance, plus a category breakdown with evidenced counts; estimates carry `~est`, and unavailable categories remain unavailable. Compaction/model changes cannot leave an old reading labeled current. |
| US-18 | I see estimated session and aggregate cost. | Session, per-agent and live-set totals show `~` and an estimate label. The session's cost breakdown explains token components, source, coverage and applicable price revision/date. Aggregate totals show coverage (`~$… known subtotal` when partial) and give access to source/price provenance. Unknown models retain tokens and show `~$ unavailable` unless an explicit owner-set rate applies. |
| US-20 | I see my usage month by month, including months whose details have expired. | A chart shows each month's value with the number visible; filters by agent and model; the current month is labeled "month to date"; months whose details are gone show totals with "details expired, totals only" and partly retained months say "some details expired" (derived from retained records, honoring Keep and active sessions); quota peaks are shown per usage scope, not per model; months before Xaibo first observed data are absent, not zero; estimated cost keeps `~`, coverage and price-revision provenance (FR-52). |
| US-19 | I see which model each running agent uses. | Every live agent, session and subagent shows its current model's friendly name (e.g. "Opus 5.5") with its effort / reasoning level when recorded (e.g. "Opus 5.5 · high"); an unlisted model shows its raw ID, never blank, and a session with no model evidence yet shows "Model unavailable"; a mid-session switch updates within M1 (hook/report) or M2 (file-only) and appears in the timeline (FR-51). |

### 4.2 Functional requirements

**Ingest and status**
- FR-01 Detect catalog entries using PATH, known locations, profile overrides and manual paths. Rescan on startup and Add agent; opening Add agent requires no app restart. Configuration existence is evidence only, not proof of installation or authentication. Bundled entries are authorized by default for bounded, shell-free version probes; imported-entry executable probes require an explicit grant. All probes run without a shell, with bounded output and a 3 s timeout.
- FR-02 Tail Claude transcripts and subagent files; tail Codex rollouts; incremental byte-offset checkpoints; periodic bounded watch reconciliation scan, run off the dispatch loop, every watch reconciliation interval (configurable; default 5 s at the personal profile, missed-watch recovery 6 s; trees of ~10k files need ≥15–30 s; S12, Q8; proposed, owner decision at Gate 0) and on wake. This is distinct from the post-Stop turn-settle interval (§6.2/§6.3).
- FR-03 Accept authenticated, versioned hook/report events over the private endpoint; replay durable spool deliveries idempotently. A native HTTP hook receiver is not adopted: S3 measured it (no SessionStart, nothing spooled when the receiver is down, agent-visible stderr once) and the owner chose the SEA forwarder and the private socket for every event (D-7, D-P0-22).
- FR-04 Compute lifecycle + confidence per §6; run stuck/loop rules on every event and on a timer.
- FR-05 Never infer `ended` from silence alone.
- FR-06 Add agent shows Detected, Setup required, Awaiting trust, Connected, Partial coverage, Unsupported version or Not detected from evidence. Apply configuration only through FR-32; verify actual event receipt before claiming Connected.
- FR-07 Custom agents use the public report contract, directly or through the packaged `xaibo-report` helper. A new conforming agent needs no core changes. Lifecycle receipt and complete-content coverage are separate facts.
- FR-08 Preserve all received/source-readable content locally for every agent. Oversized content is streamed or chunked, never silently discarded by a hook-size cap. Missing, truncated, rejected or lost content produces an explicit coverage gap; unavailable reasoning is not fabricated.
- FR-09 Push validated live state before batched persistence. Mark pending durability; acknowledge and delete spool entries only after durable acceptance. All list/content/search APIs use bounded pages with progressing cursors; renderer views virtualize those pages.

**History**
- FR-10 Overlay state (project, folder, pin, archived, trashed, keep) lives only in Xaibo's DB keyed by `(agent, profile, native_session_id)`. The notification project label ("approved project label") is a project name the user set or confirmed in Xaibo; until one exists, notifications show the generic placeholder "Project", never the cwd basename, a title or a prompt excerpt.
- FR-11 Manual Delete = move to Trash (Undo); the Trash 30-day timer starts at deletion. Purge = permanently remove Xaibo content from events, FTS, attachments, complete and incomplete content/chunk files, spool entries, session-linked projections and backups containing that content, keeping a suppression marker. Replay cannot resurrect purged content. Retention suppression clears only on demonstrably new native activity after the purge; manual suppression requires explicit Re-import. Logical purge is documented as not forensic secure erasure. Native files are never touched.
- FR-12 Retention job runs at service start and daily; automatic retention permanently purges eligible Xaibo history 45 days after last activity by default (owner decision D-9); excludes active and Keep sessions; Trash auto-empties 30 days after deletion. These defaults align nominal retention periods with Claude's and Gemini's (D-9, D-19); native availability is checked separately and is not guaranteed. The same job expires account-level usage history 45 elapsed days after measurement (§5.11), independent of the session retention setting and Keep.
- FR-13 Session whose native transcript is gone shows "Transcript only, not resumable".

**Control**
- FR-20 Launch: choose agent, project, cwd; Claude gets a pre-allocated `--session-id <uuid>`; interactive CLI (not `-p`) so it appears in native pickers. Generic launch uses a tested catalog argument template. Gemini interactive start is disabled with a reason until tested (S11-C8 not-run, D-P0-19); never headless mode. Show a provisional “Starting…” row without claiming a native session identity until evidence binds it.
- FR-21 Resume: `claude --resume <id>` / `codex resume <id>` (exec sessions: `codex exec resume <id>`, EC-50; verified on Claude 2.1.322 and Codex 0.160.0, S6/S7) in the session's original cwd; re-pass no Xaibo-specific flags beyond what the user configured. Gemini resume is disabled with a reason until a UUID-based command is tested (S11-C8 not-run, D-P0-19; package docs give `--resume <uuid>`, UNVERIFIED); native availability is checked first. Unsupported custom resume is disabled with a reason. ACP load/resume is v1 and capability-negotiated.
- FR-22 Before resume, if the session looks live elsewhere or its liveness is uncertain, show a concurrency warning and offer Open in VS Code (`vscode://anthropic.claude-code/open?session=<id>`; untested: VS Code would read the real profile, S7, OQ-B4) or Fork (`claude --resume <id> --fork-session` / `codex fork <id>`, verified S6/S7: new id, Codex records `forked_from_id`) instead. Silence does not prove safe resumability.
- FR-23 Ownership badge on every session: Observed externally / Controlled here / Detached. Observation never grants control. External-terminal sessions, including ones Xaibo launched, are externally controlled; launch origin alone does not establish ownership.
- FR-24 v1: embedded terminal hosts the same commands; PTYs owned by the main process survive window close; Quit warns if PTYs are live.
- FR-25 Launch safety: validate native IDs, executable paths and cwd; launch with structured arguments and platform-safe quoting; never interpolate transcript-derived strings into executable shell text (EC-76). User-defined launch grants bind the resolved executable and its content identity, argument template, relevant script/package entrypoint, and approved environment keys. Revalidate before execution; changed identities/templates/grants require renewed approval. Detection probes and embedded/ACP spawns use argument arrays without a shell; placeholders occupy whole arguments, and prompts use stdin where supported. External-terminal launch (MVP) necessarily passes command text to the user's terminal: Xaibo builds that text only from validated, individually quoted whole-argument tokens (executable path, template arguments, native ID, cwd); catalog, transcript and user-supplied shell fragments are never allowed (EC-76). Reject catalog- or user-supplied shell/interpreter command strings and automatic package-runner installation. Provider credentials are not inherited without an explicit environment grant.

**Integrations**
- FR-30 Claude hooks installed as a Xaibo plugin through a local marketplace (`claude plugin marketplace add <dir>` + `claude plugin install <plugin>@<marketplace> -s user`; removal `claude plugin uninstall <plugin> -s user` + `claude plugin marketplace remove <marketplace>`; verified on 2.1.319, S4), fallback marker-based settings merge (decision D-2, App. D). Plugin and fallback are mutually exclusive (both deliver every event twice, EC-09); detection via `claude plugin list --json` and the settings `disableAllHooks` flag (EC-49).
- FR-31 Codex hooks installed into `$CODEX_HOME/hooks.json` (default `~/.codex`, user scope) as one stable shim command, Xaibo groups appended after all existing entries (Codex keys trust by position, so removal never shifts a foreign hook present at install; at Disconnect a foreign group that follows a Xaibo group under the same event is shown as an FR-34 conflict, not removed silently; the append rule is untested, Gate 3), then a guided trust step: the owner approves the listed hooks in Codex's own review (verified on 0.160.0, S5). A changed hook command needs renewed trust. Codex plugin route untested (S5-C6 not-run). Never use `--dangerously-bypass-hook-trust`, never write trust hashes.
- FR-32 Every config change is a safe config transaction: parse, refuse invalid, diff preview, private backup, recheck hash, atomic same-dir rename, self-check, manifest entry. The transaction engine lands before Phase 3 installs any hook; Phase 6 adds its UI. Until Gate 6, hooks are installed only into disposable/temp profiles or through a dev CLI that prints the diff preview and requires explicit owner confirmation; real-profile Connect is enabled only at Gate 6.
- FR-33 Connect previews a default-selected increase of Claude `cleanupPeriodDays` to `max(effective cleanupPeriodDays, 45)`; the owner may deselect it. Managed policy wins. statusLine / notify wrappers and OTel exporters remain separate opt-ins. Xaibo may modify only previewed integration configuration; native transcripts, rollouts and databases remain untouched. Gemini gets the same previewed, default-selected, deselectable offer for `general.sessionRetention.maxAge` to `max(effective value, 45d)`; never lowers; managed/system policy wins (D-19, EC-90). The Gemini offer is not shown until Gemini retention is runtime-verified (S11-C7 source-read only; D-P0-19).
- FR-34 Disconnect and Uninstall restore manifest-owned changes only, and only where the Xaibo-owned value is unchanged; conflicts are shown, not overwritten. History deletion is a separate choice.
- FR-35 Inspector (S-17) labels a skill/MCP server configured, loaded/connected or called/activated only from corresponding configuration, runtime or invocation evidence; otherwise Unknown. Text mentions do not prove activation.

**MCP (v1)**
- FR-40 Four read tools: `sessions` (filters, pagination, lifecycle/health; absorbs live status), `session` (summary + paged turns/tools/usage), `search` (scoped FTS snippets), `usage` (tokens, estimated cost and observed usage history with coverage; every monetary result includes `estimated: true`, currency USD, basis (source), coverage, `as_of` and applicable price revision/date (§5.12); unavailable amounts remain null). Optional `control` (resume/interrupt Xaibo-owned sessions) is advertised only when enabled; each exact request is confirmed in the Xaibo UI, then ownership is rechecked immediately before execution.
- FR-41 Defaults: page size 20, hard cap 8 KiB per response measured after sanitization and serialization (including metadata and errors), item text <= 500 chars, snippets <= 200 chars, `truncated` flag + a cursor that always progresses.
- FR-42 Transport stdio only (agent spawns `xaibo-mcp`); the MCP reader opens the DB read-only and never writes it. Offline (Xaibo quit), read tools return timestamped history with `as_of` and live state marked unavailable. Control requires authenticated local IPC to the running Xaibo service, per-call UI confirmation and ownership revalidation; no service or no confirmation means no action.
- FR-43 Registration only at local/user scope; never writes `.mcp.json` or any file inside a user repo. Separate from the hooks plugin so hooks add no tool-definition tokens. Each registration has an explicit grant identifying allowed agents, profiles and projects. Every tool validates the grant before querying; caller-supplied filters cannot widen it. Ungranted access is denied, revocation is honored while the app is quit, and Trash and suppressed sessions are excluded from results, counts and aggregates (EC-75). Account-level usage history requires a separate explicit usage-scope grant; session/project grants alone do not authorize it, and missing or ambiguous scope authorization denies access, including counts and aggregates.

**Usage, context and estimated cost**
- FR-44 Passive collection. Consume agent-produced local files, existing hooks, statusLine stdin and approved local telemetry only. Never invoke `/context`, `get_context_usage`, `count_tokens`, `claude -p`, `codex exec`, quota/backend requests, or any other model invocation or provider API request (token counting, context, quota, usage) to obtain these measurements. Do not change an agent’s refresh interval to manufacture freshness. Full-content local storage and egress rules remain unchanged.
- FR-45 Claude tee. S-31 is a separate, default-off integration using FR-32/FR-34 transactions and conflict handling. Forward the original stdin bytes to the existing statusLine command and preserve its invocation semantics, stdout/stderr bytes and exit status. Xaibo contributes no output. Capture only validated usage/context/cost fields, plus `session_id` (native session identity, §6; local private path only), `model.id`, `model.display_name` and `effort.level` (FR-51), through the private reporting path. Never capture `transcript_path` or `cwd` (OQ-B7). Xaibo capture failure must not prevent the original command from running. With no original command, emit nothing and exit successfully. Do not read `~/.claude.json` for usage; without the tee, use transcript token/context evidence and mark missing rate limits unavailable.
- FR-46 Usage status/history. Show Claude 5h/7d and gateway spend windows when supplied; show Codex primary/secondary window lengths, utilization, reset times, plan and credits when supplied. Never infer plan from model or credit balance. Gemini quota is “Unavailable from passive sources”. Group readings by evidenced usage scope, not session; do not sum shared-account quota percentages. Preserve observations and collection gaps under §5.11.
- FR-47 Context. Show current-context used tokens, window, percentage, source, freshness and model. Claude reported totals take precedence over transcript-derived totals; Codex uses latest-request context usage and its reported effective window; Gemini remains estimated until its semantics are verified. Context is separate from cumulative consumption. S-33 adds estimated category composition without model calls or new dependencies.
- FR-48 Cost. Apply §5.12. Prefer an eligible agent-reported per-session estimate over token-table calculation for the same covered scope. Never add both. Estimated cost is permitted in live-set totals, sessions, per-agent totals, Compare and MCP; every representation identifies it as estimated (`~` / “Estimated cost” label) and reports coverage and provenance (source, basis, price revision/date) per §5.12.
- FR-49 Existing workspaces. Overview shows usage status and live-set totals. The session view shows context usage and gives access to files touched, the transcript, the cost breakdown and the timeline. Reuse existing transcript, file, tool, subagent and workflow data; no additional workspace or control surface is introduced. Usage/context/cost projections use the existing live path and preserve M1–M16.

**Design**
- FR-50 Original design. The UI follows the approved Xaibo design system (S-34, `docs/design/xaibo-design.md`, Gate D). No reference product's layout, navigation structure, visual style, tab/header naming or color scheme is reproduced; references are cited only for features (D-23). A11Y rules (§4.3) are binding on the design.
- FR-52 Monthly usage history. Month totals = frozen totals + a live calculation over unsettled retained records.
  - **Settlement.** Every permanent deletion path (retention expiry, manual purge, Trash expiry, Clear-history exclusion) atomically settles previously unsettled contributions into frozen totals in the same transaction that removes the records. Trash preserves contributions (restore changes nothing); Keep retains details without duplicating contributions.
  - **Accounting.** Settle deduplicated consumption deltas, never cumulative snapshots or counters (counter resets start a new delta series). Sessions and turns are counted once per applicable monthly bucket, independent of settlement batches. Content-free accounting markers (opaque contribution keys) exclude previously settled contributions after spool replay, explicit Re-import or suppression-clearing new native activity (FR-11); genuinely new contributions remain eligible.
  - **Usage totals** (MonthlyUsageTotal): local calendar month (owner's time zone at event time, offset stored), agent, opaque profile key, model ID, sessions, turns, input/output/cache-read/cache-write tokens, and estimated cost under §5.12: only disjoint contributions attributable to that month and model; opaque session estimates are never prorated across months or models; content-free basis, source-time metadata, applied price provenance and composable coverage counts/gaps are kept; no eligible cost = unavailable; partial = known subtotal. No repricing when prices change.
  - **Quota peaks** (MonthlyQuotaPeak), stored separately: month, opaque usage-scope/epoch key, evidenced limit/window identity; peak = maximum eligible percentage measured in that month, never a sum or carried-forward reading; uncertain scopes kept separate; not attributed to models; missing observations stay unavailable.
  - **Privacy.** Persist only opaque local profile and usage-scope/epoch keys; never prompts, content, titles, paths, profile names, account IDs/emails or source locators. Retained model/price metadata contains no user-specific labels or paths.
  - **Clear usage history** (Settings, confirmed) removes frozen totals and durably excludes every contribution already observed at confirmation from live calculation and future settlement; usage observed afterwards remains eligible.
  - **Detail availability** is derived from retained records (honoring Keep and active sessions), not age: "some details expired" vs "details expired, totals only".
  - Zero tokens; computed locally.
- FR-51 Model names. Record the model ID per turn for sessions and subagents (Claude transcript `message.model` / hook `model`; Codex `turn_context.model`; Gemini message `model`; report contract `model`). Display name precedence: agent-provided display name (Claude statusLine `model.display_name`) > `display_name` in the model list (`integrations/models.json`, owner override `models.override.json`) > raw model ID; without any model-ID evidence show "Model unavailable". An agent-provided name applies only to the matching model identity/generation, and delayed evidence never reverts newer state. Never blank, never guessed from a family pattern. Switch updates meet M1 on hook/report paths and M2 on file-only paths; pre-observation delay is reported separately. Show the current model on every live agent, session and subagent; record switches with timestamps in the session timeline; Compare and cost use each turn's own model. Zero tokens: names come only from records the agents already write. Effort / reasoning level is shown next to the model name when the agent records it (Claude statusLine `effort.level` via the default-off tee (S-31, FR-45) or hook `effort`; Claude transcripts carry no effort field (S9); Codex `turn_context.collaboration_mode.settings.reasoning_effort` (S9); report contract optional `effort`); per turn, with changes recorded like model switches; omitted (not guessed) when the agent does not expose it, e.g. Gemini (unavailable: S11 live parts not run, D-P0-19).

### 4.3 Non-functional requirements

**Privacy and egress (P)**
- P1 Full source-exposed prompts, responses, thinking and tool I/O are stored locally for all agents, including custom/third-party agents; masking applies only at egress. Missing source content is explicitly reported. Xaibo processes make zero non-loopback connections. Opt-in MCP results are disclosed to the calling agent and may reach its cloud provider. Masking is best effort and does not guarantee removal of confidential content. This is explained before MCP is enabled. App data lives in the OS app-data dir (§7.5), never in the repo. Dir 0700, files 0600 (Windows: per-user profile ACL).
- P2 Zero non-loopback network: renderer CSP `default-src 'self'; connect-src 'self'`; `session.webRequest.onBeforeRequest` allows only app/file/devtools schemes (and the Vite dev server in dev); spellcheck dictionary download disabled; crash reporter upload disabled; no auto-updater; lint rule forbids HTTP client imports outside the OTLP receiver. Network-denial coverage is defined for Chromium and all Xaibo Node/native subprocesses (main, service, forwarder, MCP); the audit records connection attempts as well as successful sockets, including startup and failure paths. A test-only guard or renderer request interception alone is not reported as proof. The guarantee is limited to Xaibo processes; launched agents' network activity is outside it.
- P3 One `sanitize()` function masks every egress path: MCP answers (these reach the agent's cloud model provider), exports, logs, diagnostic bundles, crash reports, test artifacts. Masks recognized credential formats, configured secret keys, emails; replaces home path with `~`. Best effort, documented as such; it does not guarantee removal of confidential content.
- P4 Logs contain no content by default (ids hashed, sizes, error codes only).
- P5 Repo is public-ready: synthetic fixtures only, pre-commit secret + privacy scan, fixture lint, sanitizer pass before going public (§9.3).

**Security (SEC)**
- SEC1 Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, no remote content, navigation and `window.open` blocked, permission requests denied, `shell.openExternal` allowlist (`vscode:`, reveal-in-folder).
- SEC2 Hook socket: Unix domain socket / Windows named pipe, created privately (private permissions from creation), with bounded explicit framing, stale-endpoint recovery, read deadlines and protocol validation. OTLP receiver (v1): loopback bind, per-install token header, reject any `Origin` header, exact loopback `Host`, body <= 1 MB, JSON content-type only. Report registrations are locally approved and bound to an agent/profile; payloads cannot select another registration’s identity. Apply per-registration authentication, byte/queue limits and fair scheduling. A conditional HTTP hook receiver uses loopback-only binding, token authentication, Origin rejection, exact Host validation, bounded JSON input and no decision/context response.
- SEC3 Transcript/tool content is untrusted: rendered as text, never `innerHTML`; ANSI handled safely.
- SEC4 Xaibo never returns hook decisions in MVP (observe only).
- SEC5 Catalogs are validated data, never executable code. Imported entries can never replace or shadow bundled IDs. They cannot run detection commands, launch agents, access arbitrary paths or modify configuration without the corresponding explicit grant. Display-only setup text cannot execute commands or HTML. File references are limited to approved profile roots and regular files; reject escaping symlinks and special files. Same-user trusted code can impersonate its own events; registration authentication is not a sandbox against that user.

**Performance (PERF)**: meet all shipped §1.5 targets. Use bounded live state, queues, workers and file handles; paged database queries and content slices; virtualized UI; incremental parsing; live-first scheduling. No whole-transcript read, historical full scan, index rebuild or heavy maintenance operation may lie on a normal interactive path. Capacity is tested, not inferred from component choices. Usage/context/cost updates use the existing validated live projection, worker isolation and batched writer. Complete local snapshot receipt to paint meets M1; complete native-file record append to paint meets M2. Agent-side debounce, write delay and other pre-observation latency are measured separately. Minute history sampling never delays current UI updates. T2/T3 tests include these features enabled; no whole-history aggregation or category parsing occurs on the renderer/dispatch loop.

**Robustness (ROB)**: hooks fail open; idempotent replay. Normalized records and source checkpoints commit atomically; acknowledgement and spool deletion happen only after the required durability boundary. A failed service is restarted with bounded backoff and visible health. Process-crash recovery is distinguished from sudden-power-loss guarantees (`synchronous=NORMAL`, §7.4). Bounded-spool overflow or disk exhaustion may lose hook-only evidence; the exact coverage gap is reported (§9.2).

**Portability**: macOS first; Windows 10 1809+ (ConPTY) next, Linux last, in v1. No system Node, Docker, Rust, Go, Bun, tmux or Python required at runtime.

**Accessibility (A11Y)**: all MVP flows support keyboard operation, visible focus and labeled controls; status is conveyed with text + icon, never color alone; focus restoration and narrow-window layouts are tested (§9.3).

**Reproducibility**: exact dependency versions pinned in lockfile; fixtures versioned per agent version; perf corpus generated by a seeded script.

**Code style**: TypeScript strict; ponytail discipline (smallest working change, stdlib/native first, no speculative abstractions); `node:test` for unit tests (`*.test.ts`, run by `npm test`, matching harness `testGlobs`); match surrounding style.

**Tokens**: reporting channels add zero tokens (M7). Hooks print nothing; never `prompt` or `agent` hook types; statusLine wrapper output is the original's output only. S-31 adds no prompt/context output. M7’s zero-byte/exit-zero rule applies to Xaibo reporting helpers; the chained statusLine preserves the foreign command’s output and exit status under FR-45.

---

## 5. Data specification

### 5.1 Sources and roles

| Source | Agent | Role | Needs setup | Latency | Stability |
|---|---|---|---|---|---|
| Hooks | Claude | Live lifecycle, permission, subagents | Plugin or settings entry | Immediate | Documented |
| Transcripts | Claude | Full content, usage per message, history | None | File write | Internal, drifts |
| `sessions/*.json`, `claude agents --json` | Claude | Not read in the MVP; listed with a coverage warning, not imported | — | — | Not used (S9) |
| statusLine stdin | Claude | Reported current-context totals, optional rate-limit windows and own session cost estimate | Separate opt-in tee, MVP | Agent debounce plus M1 after receipt | Documented fields; per-version validated |
| OTel | Claude | Tokens/timing; `cost_usd` is an agent estimate eligible under §5.12 | Opt-in env | Logs 5 s, metrics 60 s | Documented |
| Rollouts | Codex | Full content, token consumption, current-context evidence, timestamped rate-limit snapshots and available plan/credits | None | File write | Internal |
| State DBs / index | Codex | Optional read-only enrichment (titles, archive), deferred unless needed (S-03) | None | Poll | Version-specific |
| Hooks | Codex | Live lifecycle, permission | Install + user trust | Immediate | Documented |
| App-server | Codex | Status and control for Xaibo-owned threads | Xaibo spawns it | Live | Versioned schema |
| `notify` | Codex | Turn complete fallback | Opt-in wrapper | Immediate | Documented |
| OTel | Codex | Tokens/timing | Opt-in `[otel]` | Batched, undocumented | Documented |
| Hooks | Gemini / compatible catalog entries | Explicit lifecycle/tool evidence | Previewed hooks and agent trust | Immediate | Per-version tested |
| Native JSONL | Gemini | Full history, thoughts, tools, usage | Readable profile | File write | Version-tested internal format |
| Report v1 | Custom / third-party | Lifecycle and full content supplied by producer | Registration and emitter | Push | Xaibo-versioned |
| GenAI OTLP/HTTP JSON | Generic, v1 | Supplied content, usage and timing | Explicit binding/exporter setup | Producer-dependent batching | Convention-version dependent |
| ACP | Compatible Xaibo-owned agents, v1 | Launch/control and session updates | Approved local executable | Push | Negotiated protocol |

### 5.2 Input contracts — Claude Code

**Hooks** (command type, `async: true`, empty stdout/stderr, exit 0). Subscribed events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` (auto-mode denial only), `Notification`, `Elicitation`, `ElicitationResult` (where supported), `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `CwdChanged`, `SessionEnd`. Fields used: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, plus event payload (`tool_name`, `tool_use_id`, `tool_input` preview, `notification_type`). Unknown events/fields are stored generically.

**Transcripts.** Path `<config>/projects/<encoded-cwd>/<id>.jsonl`, subagents under `<id>/subagents/` (recursive). Fields used (tolerant): `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `entrypoint`, `version`, `message.role`, `message.content[]` (text, thinking, tool_use, tool_result), `message.usage`, `message.id`. Injected system content (command wrappers, hook output echoes) is filtered by a prefix list, counted, not shown as user prompts.

**statusLine** (opt-in): stdin JSON `session_id`, `transcript_path`, `cwd`, `model`, `cost.total_cost_usd` (agent estimate, not a bill), `context_window`, `rate_limits`, `effort.level`. No measurement-time field (S13, 2.1.319).

**OTel** (opt-in): `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_*_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, endpoint loopback, token header via `OTEL_EXPORTER_OTLP_HEADERS`; content logging flags stay off because full content comes from transcripts, so OTel content would be redundant (this does not reduce local content coverage, P1/D-15). Used: `api_request` (tokens, model, duration; `cost_usd` is an estimate), `tool_result`, `tool_decision`, metrics `cost.usage` (estimate), `token.usage`, `active_time.total`; correlation `session.id`, `prompt.id`, `event.sequence`, `app.entrypoint`. Set only in user settings `env` or shell env (project settings ignore exporter vars).

**Passive usage fields.** Read statusLine `context_window.current_usage`, `total_input_tokens`, `context_window_size`, `used_percentage`, optional `rate_limits.five_hour`, `seven_day` (each `used_percentage`, `resets_at`), `spend_limit` (not seen in S13; untested), and `cost.total_cost_usd`. `current_usage` is null before the first response (S13, 2.1.319) and after `/compact` until the next response (S13-C8, 2.1.322); null is unavailable, not zero. Rate resets are epoch seconds; normalize to UTC milliseconds. Spend utilization may exceed 100%; retain the reported number even if a visual meter saturates. Missing spend dollars/period do not invalidate an available utilization/reset reading. These are reported measurements or agent estimates, not proof of provider billing or current backend state.

Without statusLine, the latest eligible assistant `message.usage` supplies input + cache-read + cache-creation as the observed input-context count. A window inferred from model/beta evidence is labeled inferred; do not assume 1M or 200k when evidence is insufficient. A pre-first-response null is unavailable, not a measured zero.

StatusLine contains totals, not a Messages/System/MCP category breakdown. Optional internal request-shape, instruction, tool/agent/skill listing and delta records are version-tested inputs for S-33, not a stable public contract.

### 5.3 Input contracts — Codex

**Rollouts.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/`. Session id from filename and `session_meta`. Records: `session_meta` (cwd, cli_version, source, originator), `turn_context` (model, approval/sandbox policy), `response_item` (message, function_call, function_call_output, custom_tool_call, web_search_call, reasoning), `event_msg` (task_started, task_complete, token_count, agent_reasoning, others), `compacted`. Mirrored user/agent messages are deduplicated.

**State DBs** (optional enrichment, only if shipped). Use a read-only SQLite connection. On lock/schema incompatibility, skip optional enrichment and report reduced coverage; never copy live database files as a fallback. Glob version suffix. Never write.

**Hooks.** Events in 0.160.0: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `Interrupt` (`PreModelRequest`/`PostModelRequest` only on newer versions; capability-detected). Command handler, `async` where allowed (`SessionEnd` is always sync). Trust required per hook hash.

**App-server** (Xaibo-owned threads): `thread/start|resume|fork|list|read|loaded/list`, `turn/start|interrupt`, notifications `thread/status/changed`, `turn/*`, `item/*`, `thread/tokenUsage/updated`; server requests `item/*/requestApproval`, `item/tool/requestUserInput`. Bindings generated with `codex app-server generate-ts` at build time from the tested, pinned CLI version; fixtures are pinned to the same version.

**notify** (opt-in): single JSON argv: `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`.

**OTel** (opt-in): `[otel] exporter = otlp-http` with `protocol = "json"`, loopback endpoint, token header; `metrics_exporter` set explicitly (default otherwise follows analytics to a remote service); `log_user_prompt` / `log_agent_responses` stay off because full content comes from rollouts, so OTel content would be redundant (this does not reduce local content coverage, P1/D-15).

**Passive usage fields.** Parse `event_msg.token_count` with `info.total_token_usage`, `last_token_usage`, `model_context_window` and optional `rate_limits`. Retain raw fields; normalize input/cache/output semantics through tested mappings. Version-detect `token_usage_record` before treating it as equivalent; unsupported records remain coverage gaps.

Rate-limit windows retain reported duration, percentage and reset time, plus available plan/credits/limit metadata. Missing `rate_limits` in one token event is not zero and does not refresh the previous rate-limit measurement’s age.

Context is `last_token_usage.total_tokens / model_context_window`, labeled “reported effective window”. Do not apply an additional effective-window reduction or claim parity with Codex’s baseline-adjusted TUI percentage. Cumulative usage is consumption, not context. Reconstruct history from source timestamps; never sum cumulative snapshots.

### 5.4 Normalized schema
Every record: `schema_version`, `agent`, `profile`, `native_session_id`, `source` (hook | transcript | rollout | gemini_jsonl | state_db | app_server | otel | statusline | notify | report | acp (v1)), `confidence` (confirmed | inferred | heuristic), `source_ts`, `received_ts`, `source_seq`, `ingest_id`, `delivery_id` (hook deliveries).

| Entity | Key fields |
|---|---|
| Session | id, (agent, profile, native_id), cwd, project_id, entrypoint/source kind, interactive flag, title, started/last_activity, lifecycle, confidence, health, ownership, native_available, native_archived, current model id + model-change history (FR-51) |
| Turn | session, native prompt/turn id, user input, start/end, outcome |
| Event | turn, parent, kind, name, content (full, local), start/end, outcome, source locator (file+offset or hook id) |
| ToolCall | event, native call id, tool/server, args, result, approval state, duration |
| Subagent | parent session/event, native child id, type/name, lifecycle, model id (FR-51) |
| FileTouch | session, path, kind (read / write_attempted / write_confirmed), evidence |
| Usage | scope (message/turn/session), model, normalized uncached input/cache-read/cache-write/output tokens, original token fields, per-component completeness, source and request/counter identity; monetary estimates link through CostEstimate |
| Finding | session, rule, evidence ids, first/last seen, cleared |
| Overlay | project, folder, pinned, archived_at, trashed_at, keep |
| Suppression | (agent, profile, native_id), reason (manual / retention), at |
| MonthlyUsageTotal | month (local calendar month + offset), agent, opaque profile key, model ID, sessions, turns, input/output/cache-read/cache-write tokens, estimated cost USD (disjoint, attributable contributions only) + basis + applied price provenance + coverage counts/gaps; no content, paths, names or account identifiers (FR-52) |
| MonthlyQuotaPeak | month, opaque usage-scope/epoch key, limit/window identity, peak measured % in month, observation count; not model-attributed (FR-52) |
| SettledContribution | opaque contribution key, month, settled_at, cleared flag; content-free marker that prevents double counting after replay/Re-import and honors "Clear usage history" (FR-52) |
| UsageSnapshot | agent, profile, local usage-scope ID/epoch, optional originating session, limit ID, plan, credits, windows `{kind, duration_minutes, used_percent, resets_at, used_usd?, limit_usd?, period?}`, source locator, source timestamp/as_of, observed_at, per-field quality |
| ContextSnapshot | session, context generation, model, used_tokens, window_tokens, window basis, percentage, category values/quality, evidenced inventory counts/completeness, buffer basis, source locator, as_of, observed_at |
| CostEstimate | session/covered scope, amount_usd nullable, basis (agent_reported/token_table), covered usage identity/range, model/component coverage, source, as_of, price revision/date and applied rates when table-based, unavailable reason |

Account-level UsageSnapshot records may have no native session ID; session identity is optional for these records only. An originating session is provenance, not ownership of a shared quota. All entities preserve source identity and schema version.

Agent IDs are stable strings from registrations/catalog entries, not a closed agent enum. `gemini_jsonl` is Gemini native history; `report` and `acp` are generic source kinds. Preserve producer identity/sequence, content revision/chunk identity and projection membership where supplied.

### 5.5 Identity, dedup and precedence
- **Session identity:** `(agent, profile, native_session_id)`. Never path or cwd. Worktree relocation updates cwd history, not identity.
- **Event dedup keys:** Claude transcript `uuid` (partial updates of one `message.id` collapse to the latest); Codex rollout `(file identity, byte offset)`; hook `delivery_id`, assigned by the forwarder before first send and preserved through spool replay; OTel `(session.id, prompt.id, event.sequence)`. Logical operations are correlated by native IDs (`tool_use_id`, `prompt_id`, `agent_id`, `call_id`); never deduplicate solely by a receipt-time bucket. Plugin and fallback hook registrations are mutually exclusive.
- **Merge:** hook + transcript (+ OTel) for one tool call join on `tool_use_id` / `call_id` into one ToolCall with combined provenance.
- **Status precedence:** owned control channels (Codex app-server; ACP, v1) > hooks and report events > native-file inference (transcript / rollout / Gemini JSONL) > heuristics. OTel never drives status. Status uses causal/source ordering, not arrival order: a delayed earlier event cannot regress a completed turn or override newer evidence.
- **Token normalization (agent-specific):** Claude total input = uncached input + cache-read + cache-creation tokens. Codex cached input is a subset of input, not added on top. Cumulative counters (Codex totals, statusLine session totals) are snapshots, never additive events; request usage is deduplicated.
- **Usage precedence per request:** eligible OTel request usage > native transcript/rollout usage > eligible producer summary for missing coverage. Match native request/counter identities; never add overlapping sources. Claude statusLine context totals are not session-consumption totals and must not fill missing cumulative consumption. Preserve per-component coverage.
- **Cost (D-12/D-13):** §5.12 governs estimated monetary values. Select one eligible estimate for each non-overlapping covered scope. A reported session total replaces, rather than adds to, a calculated total for that scope. Its model breakdown may remain unavailable. Context compaction never subtracts consumed tokens or cost. Model changes retain each request’s model and applicable price basis.
- **Gemini, report, ACP and generic OTel identity:** Gemini raw identity is `(file generation, byte offset)`; projected message identity is `(session, message id)` with source-order last-write-wins. Report delivery dedup uses registration plus `delivery_id`; content dedup uses item/revision/chunk identity. ACP replay joins native IDs where available; uncertain correlations remain separate and carry a coverage warning. Generic OTel binds agent/profile through registration, not untrusted `service.name` alone. Without a reliable conversation identity, retain telemetry as uncorrelated; do not attach it by timestamp proximity. OTel remains non-authoritative for lifecycle. Preserve raw usage; unsupported semantics remain Unavailable.

### 5.6 Missing-value rules
- Missing is `NULL`, displayed "Unavailable", never 0.
- Aggregates report coverage (share of sessions in scope with the value from an eligible source).
- Negative or cross-source durations -> `NULL`.
- Reasoning shown only as "Available reasoning" when present.
- Status with insufficient evidence -> "Unknown", not idle.

### 5.7 Transforms
- Paths: keep original; comparison key = realpath + NFC (+ lowercase and `/` on win32).
- Timestamps: UTC epoch ms; display local.
- Content: store full locally. FTS indexes at most the first 64 KiB per content item; search UI states this coverage limit. Content display uses bounded pages/slices with explicit continuation. Larger content remains retrievable locally.
- Egress: `sanitize()` (§4.3 P3) applied at the egress boundary, never at storage.

### 5.8 Eligible records and filtering
Imported: all sessions in detected profiles, including non-interactive (tagged). Excluded from prompt/turn views (still stored, counted): injected system content, mirrored duplicates, hook echo records. Unknown record types: stored raw, counted as unsupported coverage.

### 5.9 Input contracts — Gemini CLI
Gemini profiles resolve to `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`; the environment variable names the parent of `.gemini`. Discover main and subagent chat files beneath `tmp/*/chats/`; derive identity from metadata, never the shortened filename or directory slug.

Preserve source records with file generation and byte offset. Fold in source order: a message `id` upserts the current message; `$set` patches metadata; `$rewindTo` removes the target message and subsequent messages from the current conversation. Previously observed revisions remain locally stored and labeled superseded/rewound; default transcript/search results use the current projection. Updates atomically replace projected content, FTS entries and usage contributions. Rewind never retroactively subtracts known consumed tokens; show conversation usage and observed consumption separately when evidence supports that distinction.

Import source-exposed content, thoughts, tool arguments/results and referenced tool-output files within approved profile roots. Preserve unknown records and raw token fields; normalize token/cache/thought categories only after S11 establishes their meaning.

Native retention is independent of Xaibo retention. Gemini CLI natively deletes sessions after 30 days by default (`general.sessionRetention.maxAge`; read from the 0.46.0 package source, not runtime-verified, S11). Setup offers, in the same previewed, default-selected, deselectable and reversible way as Claude `cleanupPeriodDays` (FR-33), to raise `maxAge` to `max(effective value, 45d)`; it never lowers a higher value, managed/system policy wins and is shown, and Disconnect restores only an unchanged Xaibo-owned value (D-19, EC-90). If Gemini session retention is disabled, no change is offered and the state is shown as disabled (semantics source-read only, S11). The `maxAge` offer stays hidden until retention is runtime-verified (record_decision 27). Native availability is still checked separately. Native cleanup changes `native_available`, not Xaibo content or Keep. Legacy JSON conversion/replacement must not duplicate sessions.

Runtime validation of transcript paths, patch/rewind semantics, permission identifiers, token meanings and retention behavior is required in S11. S11 live parts were not run (Google rejected personal sign-in for Gemini CLI 0.46.0; owner skipped, D-P0-19): every Gemini fact in this section stays **UNVERIFIED**; retention keys and defaults are source-read only, and the `maxAge` offer is not shown until retention behavior is runtime-verified.

### 5.10 Report event contract v1
```text
Required:
  v=1, delivery_id, session_id, producer_id, producer_seq,
  event, source_ts, payload

Identity:
  agent and profile are bound by the approved registration;
  hook adapters add them to the internal envelope.

Optional correlation:
  turn_id, item_id, parent_id, request_id, cwd

Events:
  session.start, session.end, turn.start, turn.end, turn.error,
  permission.request, permission.resolve,
  input.request, input.resolve,
  tool.start, tool.end, content.upsert, usage.snapshot
```

`delivery_id` is stable across retries. `producer_seq` increases within a producer instance; native turn/item/request IDs provide cross-source correlation. A sequence gap is coverage evidence, not permission to invent missing events. Conflicting producers remain distinguishable.

`content.upsert` contains `item_id`, `revision`, role/kind and full content. Stream content as UTF-8-safe chunks with `chunk_index` and `final`; each serialized frame is ≤256 KiB. An item is complete only when all chunks are durably present. Tool I/O and source-exposed thinking use the same content path. Chunk assembly is disk-backed and subject to storage quotas; partial content is labeled incomplete.

Report v1 accepts optional `model: {id, display_name?}` and `effort` on turn, content and usage events, attributed to the relevant session or subagent (FR-51).

Full source payload is local data. Report timestamps do not override causal ordering. Usage snapshots are not additive. Unknown event kinds are preserved with coverage warnings; unsupported protocol versions are rejected without executing instructions.

Direct producers retry until durable acknowledgment; `xaibo-report` generates/preserves delivery identity and uses the private spool. A failed report never blocks an agent indefinitely. Oversized native hook payloads may carry a coverage flag and rely on a verified native-file channel; agents without that fallback must use content chunks.

Minimal examples and executable synthetic conformance fixtures cover lifecycle, one prompt/response/thought/tool exchange, duplicate retry, out-of-order delivery and interrupted chunk recovery.

### 5.11 Usage/context snapshots

**Scope and accounts.** Use a local opaque usage-scope ID bound to the configured profile and evidenced account epoch/limit identity. Profile and `limit_id` alone do not prove account identity. Do not read credentials to resolve it, persist account UUIDs/emails, or merge profiles merely because readings match. Exception (owner approved): Codex `session_meta.creator_account_id` may be used only as a local salted hash epoch marker; the raw value is never persisted. The Claude statusLine has no account identifier: Claude readings are “Account scope unverified” and kept per session unless the owner declares an account change. Where attribution is uncertain, show “Account scope unverified”; keep observations separate by source/session and omit a combined account curve. On evidenced account/profile change, or an owner-declared change, start a new epoch. Silent account changes that passive sources cannot reveal remain a documented coverage limit.

**Time and freshness.** Store source `as_of` separately from receipt `observed_at`. Use actual measurement time where available; receipt time is not proof that the agent refreshed its backend reading. If measurement time is unknown, show “Source time unknown; observed …”; this always applies to Claude statusLine readings (no measurement-time field, S13). Re-emission of unchanged cached fields does not refresh their measurement age. After 15 minutes without a newer eligible measurement, show stale values with their timestamp and a non-color stale indicator. At a window’s reset time, retain historical data but replace its current utilization/countdown with “Reset passed; awaiting observation”; never display a fabricated zero. Local countdowns do not call the agent.

**History.** Usage history begins with available source observations. Claude history begins at tee collection; no earlier quota history is fabricated. Retained Codex rollouts can backfill timestamped snapshots. Deduplicate by source identity, scope/epoch and measurement identity. Keep at most one ordinary sample per UTC minute per scope/limit stream, retaining the latest eligible sample; preserve reset/window/scope transitions separately. Do not interpolate through missing collection or account-scope gaps. Current UI updates are not minute-throttled.

**Retention/storage.** Account-level usage history expires 45 elapsed days after its measurement time, or observation time when measurement time is unknown; it is not extended by session Keep. Store only normalized quota/plan/credit fields and necessary provenance, not raw account files or credentials. Session-linked ContextSnapshot and CostEstimate records follow FR-11/FR-12, including Keep, Trash and purge. Removing a session removes its provenance link; unlinkable account aggregates contain no session content. Before any usage, cost or quota record is permanently removed by any path (expiry, purge, Trash expiry), its unsettled contribution is settled into MonthlyUsageTotal / MonthlyQuotaPeak in the same transaction (FR-52); monthly totals have no automatic expiry and are removed only by "Clear usage history".

Maintain the latest context projection plus model/compaction generation markers; do not persist every identical statusLine redraw. Existing token records remain the consumption history. Bound pending buffers and use indexed, paged history queries. The storage meter includes these tables, indexes and retained price provenance. A continuous ordinary quota stream has at most 64,800 minute samples over 45 days, plus transitions; actual bytes and index overhead are measured under S12/T3 rather than assumed negligible.

**Context changes.** Claude used context excludes latest-response output and includes input/cache-read/cache-creation. Trust the reported window over model-name inference. Show 1M versus 200k from evidence, independently of any “exceeds 200k” flag. On compaction, invalidate the old current reading; eligible `postTokens` may provide a labeled interim reading, otherwise show “Awaiting next usage”. On model/window change, start a new context generation; do not present an old numerator against a newly inferred denominator. Preserve cumulative consumption/cost.

**Gemini.** S11 validates message `tokens.input/output/cached/thoughts/tool/total` before normalization or pricing. A latest prompt-input count against a version-tested model window may be shown as `~est` context, not guaranteed live occupancy. Unknown models/windows are unavailable. No quota, plan or reset value is invented from token consumption.

**Categories, v1-B.** Use observed current request-shape text/schema and ordered inventory deltas. Estimate available material with UTF-8 byte length / 4, labeled `~est`; this is a heuristic with no promised percentage accuracy. Avoid duplicate counting between system text, memory, skills, instructions and tool definitions. Missing or incomplete evidence makes the affected row unavailable.

Counts describe the evidenced inventory, not guaranteed active context membership. Mark a count exact only when the relevant inventory is complete for that context generation; otherwise label observed/partial. Configured counts do not prove loaded tools, memory or agents.

Estimate Messages as a residual only when non-message coverage and a compatible used total are sufficient; label it “Messages/residual ~est”. Incomplete coverage uses an “Unattributed used” remainder. If category estimates exceed reported used tokens, flag the mismatch and omit the composition; do not rescale or clamp estimates into apparent agreement.

Buffer is separate from used tokens. Apply a version-tested local buffer formula only when its settings/inputs are known, label it `~est`, and otherwise show unavailable. Free space excluding buffer is derived only when both used and buffer are available. Deferred tool definitions are listed separately and excluded from used context. A tokenizer is considered only after an agreed accuracy requirement demonstrates need and App. C approval is obtained.

### 5.12 Estimated cost and prices

**Meaning.** Every displayed dollar amount derived here is an estimate, never a provider bill, subscription charge or remaining subscription balance. Display `~$…` with an accessible “Estimated cost” label. Keep gateway spend-limit dollars and credit balances separate from session cost.

**Selection.** Prefer an agent-reported per-session estimate, such as Claude statusLine `cost.total_cost_usd`, when its identity, covered scope and measurement are compatible with the displayed session. Otherwise calculate from real normalized token counts and eligible local prices. Never estimate billable tokens from characters. Category estimates from §5.11 are never cost inputs.

**Calculation.** For supported pricing semantics:

`USD = (uncached_input × input_rate + output × output_rate + cache_read × cache_read_rate + cache_write × cache_write_rate) / 1,000,000`

Use deduplicated consumed tokens, not current context. Codex cached input is subtracted from inclusive input before pricing uncached input; reasoning already included in output is not added again. Gemini cache/thought/tool relationships must pass S11. Unknown cache-write classes, long-context tiers, service modes or other price-affecting qualifiers make the affected component unavailable unless the table explicitly supports them. Claude qualifiers: cache writes split into 5m/1h classes (`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), `service_tier` and `speed`. `server_tool_use` is not a token component and is not priced; `fallback_credit`, `inference_geo`, `iterations` and `output_tokens_details` have no established semantics and are never priced. Codex `cache_write_input_tokens` has no established relation to `input_tokens`; Codex cache-write is unavailable until tested.

**Prices.** Bundle `integrations/models.json` (the model list, also used for display names, FR-51): schema version, revision, currency USD, `prices_as_of`, exact model IDs or explicit aliases, per-model `display_name`, `family` and `context_window` where known, source references, supported qualifiers and per-million input/output/cache-read/cache-write rates. No family-name guess or silent fallback rate. Unknown model: show tokens and `~$ unavailable`. A fallback applies only when the owner explicitly configures its scope and rate, labeled “Owner-set fallback”.

Settings gives access to reveal, validate and reload a private `<appdata>/models.override.json`. An absent override uses bundled data; an invalid edit reports the error and retains the last valid revision. No price-network requests, new dependency or pricing editor UI is required. Bundled updates arrive with manually installed app versions. Show revision and “Prices as of …”; an old date is visible without implying current market verification.

Accepted revisions are immutable calculation provenance. Edits apply to newly priced usage; existing estimates retain their applied rates/revision. No automatic historical repricing is included. A session can therefore contain multiple price revisions, exposed in its cost breakdown.

**Coverage and aggregates.** Sum only disjoint covered scopes. Partial coverage displays `~$… known subtotal` with priced/eligible session coverage and token-component gaps. No eligible cost yields `~$ unavailable`, not zero. Aggregates retain estimate labeling, source timestamps and mixed-price provenance. A valid reported zero remains zero.

A parent’s reported cost may include subagents or delegated work: do not add child estimates already covered by that total. If inclusion is unknown, mark aggregate coverage uncertain and exclude the ambiguous addition. Linked cross-agent activity is not automatically additive. Cumulative resets/counter decreases start an evidenced new segment or produce a gap; they never generate negative consumption/cost.

Time/model-filtered Compare totals use only attributable usage. An opaque whole-session estimate cannot be prorated across models or time ranges; report that coverage unavailable. MCP returns numeric amounts only alongside `estimated: true`, USD, basis, coverage, `as_of` and applicable price revision/date; null retains an unavailable reason.

---

## 6. Status detection, metrics and evaluation

### 6.1 Model
Two dimensions per session:
1. **Lifecycle:** idle / busy / waiting-for-permission / needs-input / error / ended / unknown.
2. **Evidence:** confidence (confirmed / inferred / heuristic) and health (connected / stale / detached).
Background work and findings are reasons attached to a state.

### 6.2 Claude state machine

| Evidence | Result |
|---|---|
| `SessionStart` (interactive) | idle, confirmed |
| `UserPromptSubmit` | busy |
| `PreToolUse`, `SubagentStart`, new assistant/tool records | busy (unless an unresolved permission request exists) |
| `PermissionRequest`, or `Notification` with `permission_prompt` | waiting-for-permission, confirmed |
| `Notification` with `idle_prompt` | idle reminder only; preserves idle, never needs-input |
| Validated input-request event (`Elicitation`, validated in S7 on 2.1.322; `Notification` `elicitation_dialog`/`elicitation_response` are not input-request evidence: the dialog notification appeared once in three requests) | needs-input, confirmed |
| Matching resolution by native ID (`PostToolUse`, `PostToolUseFailure`, `ElicitationResult` with `action` accept/decline/cancel, cancellation, or terminal-turn evidence) | clears only that request; busy; denial/decline/cancel recorded |
| `PermissionDenied` | auto-mode denial recorded for that request (untested); not emitted on manual denial (S7) |
| Transcript `tool_result` of the call with `is_error` and the rejection text, for a call that had a `PermissionRequest` and no later `PostToolUse` (no `PermissionDenied` or `Stop` follows; the same rejection without a `PermissionRequest` is an interrupt) | manual denial recorded; clears that request; turn outcome interrupted; idle, inferred |
| `Stop` | Immediately show “Finishing…” within M1, preserving unresolved waits and known background-work evidence. After the configured turn-settle interval (default 4 s, configurable, Q8), settle to idle or busy “Background work”. S7 (2.1.322): a backgrounded subagent's `SubagentStop` and a background shell's completion turn (`UserPromptSubmit` → `Stop` with a transcript `queue-operation` record, when the shell finishes, ~30 s after `Stop` for a `sleep 30`) arrive after `Stop`, so 4 s can settle early. Proposed, owner decision at Gate 0: keep “Finishing…” while a `SubagentStart` has no `SubagentStop`, and treat a `UserPromptSubmit` without a typed prompt as the same activity. “Finishing…” is a reason on the existing lifecycle, not proof of idle or ended. |
| `StopFailure` | error for that turn |
| `SessionEnd` or confirmed exit of a Xaibo-owned process | ended |
| No hooks: last record is assistant end-of-turn | idle, inferred |
| No hooks: pending non-Agent tool > 5 s and no file writes | waiting-for-permission, heuristic ("Probably waiting") |
| Silence / collector disconnected | stale or unknown, never ended |

Pending permission/input requests are tracked individually by native ID. A delayed event never overrides newer evidence (§5.5). `PermissionRequest` carries no `tool_use_id`; it is joined to its `PreToolUse` by order within the session. S7 evidence (manual denial; accepted, declined and cancelled input; `idle_prompt` ~60 s after a turn, not an input request; background-shell completion; backgrounded subagent; interrupt) is on 2.1.322, the installed version after an auto-update from the 2.1.319 pin (D-P0-33); on 2.1.319 it stays **UNVERIFIED**, and Gate 1 pins the matrix to the tested version (D-P0-33; owner accepted 2.1.322, D-P0-34).

### 6.3 Codex state machine

| Evidence | Result |
|---|---|
| App-server `active` | busy |
| `active` + `waitingOnApproval` | waiting-for-permission |
| `active` + `waitingOnUserInput` | needs-input |
| `idle` / `systemError` | idle / error |
| `notLoaded` | detached; keep last lifecycle, confidence reduced |
| Hook `UserPromptSubmit` or rollout `task_started` | busy |
| Hook `PermissionRequest` | waiting-for-permission |
| Matching tool completion (by native ID) | clear only that request |
| Rollout `task_complete` / hook `Stop` / notify `agent-turn-complete` | Immediately show “Finishing…” within M1, preserving unresolved waits and known background-work evidence. After the configured turn-settle interval (default 4 s; same configurable value as Claude, Q8), settle to idle or busy “Background work”. “Finishing…” is a reason on the existing lifecycle, not proof of idle or ended. |
| Hook `Interrupt` | turn outcome interrupted; await turn settle |
| Hook `SessionEnd` / owned process exit | ended |

Conflicts are logged to session diagnostics; the current authoritative source wins. App-server status rows apply only to threads Xaibo starts: an externally owned thread (TUI; Codex 0.160.0, no-daemon mode) is listed and readable but reads as `notLoaded`, `thread/resume` fails and no notifications arrive, so it is observed from hooks, notify and rollout, not app-server status (Q3, observe-only). Shared-daemon mode is untested.

### 6.4 Stuck / loop rules (thresholds proposed, configurable, MIT-licensed rules adapted from blazo)

| Rule | Condition | Warning |
|---|---|---|
| R1 no-progress | busy, no progress event 5 min, no known wait; suspended time excluded | Possibly inactive |
| R2 repeated-tool | same tool + normalized args + result signature 4x consecutively in a turn | Repeated tool |
| R3 repeated-error | same tool/error signature 3x consecutively | Repeated error |
| R4 cycle | same 2–3 tool sequence repeats 3x | Possible loop |
| R5 long-tool | tool running > 10 min without completion | Long-running tool |

Warnings never terminate anything; deduplicated per finding id `(session, rule, signature)`; cleared when progress breaks the pattern. Expected long work is separated from inactivity: legit long work never becomes confirmed stuck/error; R1/R5 may show only an explicitly "expected inactivity" / "long-running tool" badge.

### 6.5 Comparison metrics and coverage
Per agent / model / project / time range: sessions, turns, wall time, active time where reported, normalized input/cache/output tokens, estimated USD cost under §5.12, tool calls/errors, failed turns, permission requests/denials, interventions and findings. Show observed quota history separately by usage scope; account quotas are not attributable session consumption or a cross-agent score.

Coverage rules: each metric shows its own coverage %; below 80% (proposed) a warning badge; no imputation; token totals follow the agent-specific normalization in §5.5 (Claude cache tokens added to uncached input; Codex cached input already inside input; cumulative counters never summed); the view is labeled "observed workload, not a quality benchmark".

### 6.6 Validation design
- **Fixtures** (`test/fixtures/synthetic/<agent>/<version>/<case>/`): event streams (hook JSON lines, transcript/rollout JSONL, optional OTel JSON) plus `expected.json` listing, per event index, the expected lifecycle, reason, confidence and findings.
- **Origin:** hand-written, or recorded from disposable sandbox runs (temp `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME`, throwaway project, synthetic prompts), then passed through the sanitizer and fixture lint and reviewed before commit. Never from the owner's real stores.
- **Replay harness:** virtual clock for ordering and logic (UI latency is measured separately with a real monotonic clock, M1/M2); each fixture replayed under interleavings: hooks-first, files-first, hooks-missing, OTel-late, duplicated hooks, duplicate spool replay across second boundaries, rapid distinct events, delayed earlier events, service restart mid-stream, sleep gap.
- **Order invariance** (the analogue of leakage tests): final lifecycle, ToolCall count and usage totals identical across all interleavings.
- **Baselines** reported next to Xaibo per fixture with defined false-positive/false-negative counts: (B1) files-only inference; (B2) agent-flow-style rules (Stop = idle, 5 s heuristic, no background awareness).
- **Required fixture set (minimum):** simple turn; permission granted; permission denied (manual and auto-mode); idle reminder (`idle_prompt`) without input request; needs-input accepted, declined and cancelled; tool failure; StopFailure; subagent; background work after Stop; compaction; worktree relocation; interrupted turn; legit 15-min build (no stuck); repeated tool; repeated error; 2- and 3-tool cycles; sleep/wake gap; pre-hook session; concurrent resume interleave; format-drift unknown records; per agent version.
- **Perf corpus:** seeded generator, ~1,000 transcripts, size median ~200 KB, p99 ~20 MB, max ~200 MB.
- **Seeded perf tiers:**
  - T0: one session; startup, tray reopen, hook/file visibility and large indexed-session opening.
  - T1: existing 1,000-session / approximately 500 MB import corpus.
  - T2: 50 live sessions, 200 events/s for 10 minutes, declared event-size distribution, concurrent backfill and service restart/replay.
  - T3: ≥10,000 sessions / ≥10 GiB populated DB, including 200 MB source transcripts; cold application caches, filtered/unfiltered list/search and content paging.
  - TP, personal profile (D-P0-24; used at Gates 4/5 in place of T2/T3, which run in the deferred scale-up stage, D-P0-26): 5 live sessions at ~20 events/s with bursts to 50/s, 1,000 watched files, 2 quota streams × 45 days, a seeded ~1,500-session corpus (~2.6 GiB DB) with a 50 MB largest session.

  Each tier has an automated test. Record end-to-end p95 and individual hop timings using a real monotonic clock; virtual clocks test logic only. Measure agent wait separately from UI latency. Resource limits M4/M5 apply to total process memory; disk-backed corpus size must not become resident memory.

  Gate 1 measures T1 list readiness; Gate 2 completes import; Gate 3 measures T0 ingestion and M16; Gate 4 measures application readiness and M14 at the personal profile; Gate 5 measures M13 at the personal profile (TP, D-P0-24); T2 and T3 at plan scale run in the deferred scale-up stage (D-P0-26). Later gates rerun affected tiers.

### 6.7 Acceptance thresholds (proposed)
Confirmed transitions 100% exact; 0 heuristic-as-confirmed; 0 confirmed stuck/error on legit-long fixtures (expected long-work badges permitted); order invariance 100%; Xaibo's false-positive and false-negative counts <= B1 and B2 on every fixture; UI latency measured with a real monotonic clock meets M1/M2.

### 6.8 Generic, Gemini and report-event mappings
Catalog mappings select normalized evidence using exact event names and optional exact field-value predicates; they do not execute state-machine code. Confirmed states require validated event semantics and sufficient correlation. Unknown mappings yield Unknown/reduced coverage.

Gemini mappings: `SessionStart`→session.start; `BeforeAgent`→turn.start; `AfterAgent`→turn.end with turn settle; `BeforeTool`/`AfterTool`→tool.start/tool.end; `SessionEnd`→session.end. Only `Notification` with tested `notification_type=ToolPermission` requests permission state. Other notifications do not imply input wait. Resolve only a matching request with tested evidence; absent correlation remains unresolved/unknown. Do not subscribe to chunk-frequency `AfterModel` solely for lifecycle.

Custom report events use the same lifecycle engine and request-correlation rules. Explicit reporting confirms observed events, not their truth against a malicious producer. Neither silence nor an unavailable capability proves idle, ended or permission granted.

### 6.9 Usage and session capabilities
These are capability and data requirements. Placement, layout, navigation and visual form come from the approved Xaibo design system (S-34, FR-50).

**Overview.** Overview shows collection health, active agent count, total observed tokens and estimated USD cost for the explicitly labeled live-session set. “Active agents” counts distinct agent registrations with busy/waiting/needs-input sessions, including known background work; the session count is also available. Use normalized consumed input plus output for token totals; disclose coverage and avoid overlapping parent/child contributions. A disconnected collector cannot retain an unqualified live indicator.

Usage status is grouped by agent and evidenced profile/account scope. Show available window labels/durations, percentages, reset clock times/countdowns, plan and credits. Stale/unknown/expired states use text and icons. Each usage scope gives access to its bounded observed history; no additional top-level screen is required.

**Session context usage.** Show percentage, used/window tokens, source and freshness. Abbreviated token values (e.g. `<used>k / <window>`) expose exact integer values in accessible text/details; the abbreviation format is defined by the design system. Any graphical meter has text equivalents. MVP shows observed used/unoccupied portions; unavailable buffer means unoccupied space is not labeled “usable before compaction”.

The category breakdown covers these data categories: messages, system tool definitions, MCP tool definitions, skills, system prompt, memory files, MCP server instructions, custom agents, compaction buffer, free space, and deferred MCP/system tool definitions. Category identifiers name the data; display labels, grouping, order and number formatting come from the Xaibo design system (FR-50). Show MCP-tool, memory-file and custom-agent counts only with their evidence/completeness labels. In MVP, unavailable category rows explain that composition estimates arrive in v1-B. In v1-B, valid estimates form a labeled composition; deferred definitions remain outside occupied context.

**Session access.** The session view gives access to files touched (reusing FileTouch evidence), the transcript (with available reasoning/tool/subagent detail), the cost breakdown (session estimate, components, coverage and provenance) and the timeline (reusing workflow/tool/subagent events and compaction/model markers). Preserve existing workspace functions and keyboard/focus behavior.

**Compare, v1-B.** Reuse §6.5 filters, cost rules and usage-history data. Show account-scope histories separately from session/project consumption. Do not duplicate charts or imply quota use measures agent efficiency.

---

## 7. Technical specification

### 7.1 Process model (decision D-1)

| Process | Role |
|---|---|
| Electron main | Windows, tray, IPC, security policy, terminal launch, PTYs (v1) |
| Service (Electron `utilityProcess`) | Adapters, ingest, status engine, SQLite single writer, retention, hook socket, OTLP receiver (v1) |
| Renderer (React) | UI only; talks to main via `contextBridge`; live deltas over a `MessagePort` |
| Hook forwarder (short-lived Node SEA behind a stable shim) | Reads stdin, sends to socket, else spools; exits 0 silently |
| `xaibo-mcp` (v1, spawned by agent) | stdio MCP; DB read-only, never writes; enforces grants; `control` only via authenticated IPC to the running service |

Window close -> tray, collection continues. Quit -> everything stops; gaps are filled from spool and files on next start. If the service crashes, main restarts it with bounded backoff and shows its health; it resumes from committed checkpoints and replays the spool. `utilityProcess` is a managed child, not a detached daemon; a detached always-on daemon is deferred until needed.

The utility service owns validation, live state and dispatch. A dedicated worker owns the single SQLite writer; a bounded parser worker handles incremental historical parsing. Read queries execute off the dispatch loop in a reader worker with short-lived read transactions (S12: one reader worker is enough at the personal profile; proposed, owner decision at Gate 0). Worker count and caches are bounded; scale them only on measured evidence.

### 7.2 Code layout
```
src/main/        Electron main, tray, IPC, security, terminal launch
src/service/     ingest, status, retention, receivers
  adapters/claude/  adapters/codex/
  store/         schema.sql, migrations/
src/shared/      normalized types, sanitize(), hook protocol
src/renderer/    React UI
src/forwarder/   hook forwarder + shim (no dependencies)
src/mcp/         stdio MCP server (v1)
integrations/claude-plugin/   plugin manifest + hooks/hooks.json
integrations/codex/           hooks.json template (S5: hooks.json route; plugin route untested)
src/service/catalog/          validation, detection, mappings, setup plans
src/service/adapters/gemini/  native JSONL folding
src/service/adapters/generic/ hook/report; ACP and OTel in v1
src/service/workers/          bounded parser and single-writer workers
src/shared/report/           wire schema and conformance types
integrations/agents.catalog.json
integrations/agents.catalog.schema.json
integrations/models.json
docs/integrations/report-v1.md
docs/design/xaibo-design.md   approved design system (Gate D)
test/fixtures/synthetic/catalog/
test/unit/ test/integration/ test/e2e/ test/perf/ test/fixtures/synthetic/
scripts/         privacy-scan, fixture-lint, gen-perf-corpus, audit-sources (local output only)
.githooks/pre-commit
```

### 7.3 Interfaces
- **Adapter:** `detect()`, `capabilities()`, `discover()`, `observe(emit)`, optional `start()`, `resume()`, `interrupt()`. Built-in native parsers are code adapters selected by catalog reference. Generic hook/report channels serve new catalog IDs without core changes. New native storage formats require an external report producer/converter or a separately tested adapter; no arbitrary code-plugin loader.
- **Catalog schema v1:** contains identity/version/lifecycle, tested agent versions, binary/location/version-argument detection, profile roots and named environment overrides, existence evidence, adapter/channel references, capabilities, ordered display-only prerequisites/setup steps, documentation/install hints, supported config-edit declarations, exact hook-event/payload-field mappings, launch argument templates and environment-key grants. ACP declaration is v1-only. No shell expressions, executable mappings or arbitrary write paths. Unknown fields and unsupported operations fail validation. Bundled entries and private imported entries are validated identically; imports use separate IDs and cannot shadow bundled entries. Supported generic hook config writers initially cover the tested Claude-like and Gemini JSON shapes. Unsupported formats receive manual setup instructions. Detection schedules bounded probes only for authorized entries: bundled entries are authorized for bounded, shell-free version probes by default; imported entries require an explicit grant (FR-01).
- **Hook wire protocol v1:** `{v, delivery_id, agent, event, session_id, cwd, received_ts, payload}`; the forwarder bounds bytes while reading stdin (payload <= 256 KB; larger: truncated flag) and frames socket messages explicitly. The service validates `v`; `v-1` compatibility is added only when a second protocol version exists.
- **Delivery:** validate and publish volatile live state before SQLite batching; durable acknowledgment comes after an immediate small SQLite commit (S3), then spool deletion. Forwarder own deadline = 100 ms minus the runtime's startup p95; for the SEA that is ≈ 60 ms, and a hung service measured 77 ms in total (S3). On missing acknowledgment, spool the same delivery and exit silently; duplicate replay is expected. Spool overflow/disk exhaustion exposes the exact gap.
- **Transport:** `<appdata>/run/xaibo.sock` (Windows: per-user named pipe). Spool: `<appdata>/spool/<date>-<pid>.jsonl`, cap 50 MB (proposed).
- **Forwarder runtime (S3, record_decision 23):** a Node SEA (needs no system runtime; ~138 MB; building it needs a static Node build) behind one stable shim, the only command in agent config. Every event goes over the private socket with the per-install token (0600) in each frame. Native HTTP hooks are not adopted: no `SessionStart`/`Setup` support, nothing spooled when the receiver is down, agent-visible stderr seen once. `Stop` is synchronous (an async Stop is lost when headless Claude exits); all other events async. Codex 0.160.0: async accepted on SessionStart and PostToolUse, SessionEnd forced synchronous, other events untested (S5). The owner accepted the M16 miss under a 50-way simultaneous burst (added wait p95 ≈ 276 ms). Stable shims remain fail-open and silent.

### 7.4 Storage
One SQLite DB, single writer (service). `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL` (at creation), `temp_store=MEMORY`. Batched transactions (<= 100 rows, 50 ms or 1 MiB, live rows first; S12, proposed, owner decision at Gate 0) that commit normalized records and their source checkpoints atomically, cached prepared statements, FTS5 external-content table, indexes on `(session_id, source_seq)`, `(agent, last_activity)`, `(project_id)`, `(trashed_at)`. Source checkpoints `(path, dev, ino, size, mtime, offset, head_hash)`. Backfill newest-first. `PRAGMA optimize` periodically; `incremental_vacuum` after purge. Migrations forward-only, in a transaction, after a backup taken by the explicit recovery path below; purge also covers backups containing purged content (FR-11). `synchronous=NORMAL` protects committed data against process crashes, not necessarily against sudden power loss (ROB). Engine: `node:sqlite` (`DatabaseSync`) from Electron's bundled Node (S1: Electron 45.2.3, Node 24.22.2, SQLite 3.53.4 with FTS5, DBSTAT and the online backup API); `better-sqlite3` not used. The module is a release candidate, so Electron stays pinned and the S1 probes re-run on every Electron bump.

Preserve one SQLite writer and existing transactional checkpointing. Schedule live batches ahead of bounded backfill jobs; bound by bytes/time as well as rows. Use indexed keyset pagination, compact session summaries, bounded large-item slices and short read transactions. Coalesce renderer summaries while preserving persisted events.

`fs.watch` on each active session file plus the reconciliation scan (FR-02) cover history; the scan finds new files (recursive directory watches measured append→event p95 ≈ 14.6 s on macOS, unusable for M2); above an FD cap, the least-recently-active files drop to scan-only; inactive handles close (S12, proposed, owner decision at Gate 0). Track queue age, WAL size, parse lag and storage pressure without content logs.

Replace unconditional pre-migration `VACUUM INTO` with an explicit, tested backup/migration recovery path that checks space and reports progress. Large migration/backup, checkpoint, vacuum and FTS maintenance operations never run invisibly on the normal readiness path. Startup with a pending migration shows recovery/progress separately from M12.

Usage snapshots and cost/context projections use the existing single writer, transactional checkpoints and indexed reads. Index quota history by `(usage_scope_id, limit_id, as_of)` and session projections by session/context generation. Keep live summaries incremental; sample history off the dispatch path. Price/category work executes in bounded worker jobs. No additional database or time-series service is introduced.

### 7.5 Data locations
App data = Electron `userData`: macOS `~/Library/Application Support/Xaibo/`, Windows `%APPDATA%\Xaibo\`, Linux `${XDG_CONFIG_HOME:-~/.config}/Xaibo/`. Contents: `xaibo.db`, `spool/`, `run/`, `integrations/` (forwarder, shim, plugin copy, manifest, backups), `logs/`. Dev builds use `Xaibo-dev`; tests set `XAIBO_DATA_DIR` to a temp dir and point `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` at temp fixture dirs.

Private imported catalogs and registration/launch grants live under app data, not user repos. Test isolation includes `GEMINI_CLI_HOME` and all report registrations; all profile roots resolve beneath temporary test directories.

Private cost overrides live at `models.override.json` under app data. Accepted price provenance lives in Xaibo’s private store. Neither overrides nor observed usage/account data belong in the repo.

### 7.6 Integration footprint

| Location | Xaibo-owned content | Opt-in |
|---|---|---|
| Claude plugin (local marketplace in `<appdata>/integrations/`) | hooks only; installed and removed through the `claude plugin` CLI (which records `enabledPlugins`); never together with the settings-hook fallback (S4) | Connect |
| `~/.codex/hooks.json` | separate Xaibo groups appended after all existing entries (Codex keys trust by position; a foreign group added later is a Disconnect conflict); activated only by the user in Codex's own trust review; Xaibo never writes trust (S5) | Connect |
| `~/.claude/settings.json` | statusLine wrapper; OTel `env` keys; `cleanupPeriodDays` | wrapper and OTel each separate; `cleanupPeriodDays` default-selected in the Connect preview, deselectable (FR-33) |
| `~/.codex/config.toml` | marker-delimited `[otel]` block; notify wrapper | each separate |
| Claude/Codex MCP registration (local/user scope) | `xaibo` server (v1) with an explicit grant (agents, profiles, projects) | per agent and project |
| OS login items | Xaibo start-at-login | separate |
| Gemini user-profile `settings.json` | Named Xaibo hook entries; `general.sessionRetention.maxAge` (D-19); optional v1 telemetry/MCP entries | Connect; `maxAge` default-selected in the preview, deselectable (D-19); telemetry and MCP separately |
| Xaibo app data | Imported catalog entries, report registrations and launch grants | Add agent/import/explicit launch grant |

Gemini native retention changes only through the previewed, reversible D-19 offer; managed/system policy wins. No generic integration may bypass native folder trust or approval policies.

Never written: `~/.claude/agent-flow/`, other tools' entries, files inside user repos, agent databases. TOML edits are text insertions validated by a parser, never a full re-serialize.

Claude’s statusLine tee is available in MVP as a separate default-off previewed opt-in, shipped as a SEA binary behind the same stable shim as the forwarder (plain `node` fails the 100 ms added-wait bound; a second binary or one binary with two entry modes is decided in Phase 3, S13); Codex notify remains v1-B. Do not enable a periodic refresh interval or read `~/.claude.json` as part of this integration.

### 7.7 Scripts
`npm run dev`, `build`, `test` (node:test), `test:e2e` (Playwright Electron), `lint`, `typecheck` (`tsc --noEmit`), `perf`, `privacy:scan`, `fixtures:lint`, `dist:mac`.

### 7.8 Dependencies
See App. C. Every install needs owner approval first.

---

## 8. Execution environment
- **Primary:** owner's Apple Silicon Mac. Build from source; locally built apps carry no quarantine attribute, so no signing is needed for personal use.
- **Dev isolation:** dev and test runs never read or write the owner's real agent stores or Xaibo data except an explicit, owner-started "real data" dev session; Playwright (automated or MCP) never runs against a real-data instance.
- **Docker:** dev tooling only (harness-os containers). The app never needs Docker.
- **Installs:** project-local only (`node_modules/`; a `.venv/` only if Python is ever needed). Electron and npm download caches, and the dev-time official Node build used to build the SEA binaries (checksum-verified, D-P0-21), are pointed at the git-ignored repo `.cache/`; anything that truly requires a machine-wide location goes under the owner's projects folder, never system folders. Each package is installed when its phase starts (owner approval of App. C, 2026-11-09).
- **Windows/Linux (v1):** build on each OS (node-pty is native) or a CI matrix; private-repo CI minute limits **UNVERIFIED**; Windows unsigned builds show SmartScreen warnings.
- **Data movement:** none by Xaibo processes (zero non-loopback connections). Opt-in MCP (v1) results reach the calling agent and may reach its cloud provider (§4.3 P1). Diagnostics bundles are local files, sanitized, created only on request.
- **Runbook:** App. B.

---

## 9. Testing and QA

### 9.1 Approach and verification loop
- harness-os pipeline per unit of work: spec -> test observed failing (RED) -> implement -> passing (GREEN) -> review. Gated globs: `src/**/*.ts(x)`.
- Unit: `node:test`, `*.test.ts`, pure modules (parsers, status engine, dedup, sanitize, config merge).
- Integration: service against temp `HOME`/profile dirs with synthetic fixtures; fake process table; fault injection (kill service, disk full, bad migration).
- E2E/UI: Playwright `_electron` launches the built app with temp data; every UI flow in §9.3 has a test. Playwright MCP is used for visual checks of rendering, console and key flows after every UI change.
- Perf: `npm run perf` on the seeded corpus (M3–M5).
- Perf tiers T0–T3 (§6.6): each tier has an automated test with real-monotonic-clock end-to-end p95 and per-hop timings; agent wait measured separately from UI latency; tier-to-gate assignment as in §6.6 (M11–M16).
- Privacy: secret scan + privacy scan in pre-commit; connection-attempt audit over all Xaibo processes in every E2E run; canary secrets in fixtures.
- After every significant change: lint, typecheck, unit, affected integration/E2E. Full suite before every gate.

### 9.2 Edge-case catalog
Every row is a required task. Test codes: U unit, I integration, E Playwright E2E, P perf, S Phase 0 spike, R release check. Phase: MVP unless marked v1.

| ID | Case | Expected behaviour | Test |
|---|---|---|---|
| EC-01 | Stale pid / pid reuse | Live only if pid alive and start time + executable match; otherwise "stale"; never ended from pid alone | U (fake process table) |
| EC-02 | Sessions started before hooks or before Xaibo's first run | Backfilled from files; status "inferred"; upgraded to confirmed on first hook | I |
| EC-03 | `.jsonl.zst` history | Streaming decompress with built-in `node:zlib` zstd (S9 verified in the packaged utility process; no package); file untouched | U + S9 |
| EC-04 | Format drift on agent upgrade | Tolerant parse; unknown records stored and counted; drift banner if unknown share > 5% in a session (proposed); fixtures per agent version | U |
| EC-05 | Multiple entrypoints (`cli`, `claude-vscode`, `claude-desktop`, `sdk-cli`; Codex `cli`/`vscode`/`exec`/`appServer`/`subAgent`) | One list with origin badge; non-interactive tagged; resume uses flags valid for that kind | U |
| EC-06 | Worktree relocation | Same session id stays one session; cwd history updated; no duplicate | I |
| EC-07 | Same repo open twice (concurrent sessions, same cwd) | Distinguished by session id; no cwd-based routing | I |
| EC-08 | Clock skew (agent ts vs mtime vs receive time) | Order by source sequence; all three timestamps stored; durations from one source only; negative -> NULL | U |
| EC-09 | Duplicate events: agent-flow + Xaibo hooks; plugin and fallback registration attempted together; spool replay duplicates | Xaibo ignores agent-flow traffic; plugin and fallback are mutually exclusive; replayed deliveries collapse by `delivery_id`; duplicates across second boundaries collapse while rapid distinct events stay distinct | I |
| EC-10 | Hook + transcript + OTel describe one tool call | One ToolCall, combined provenance | U |
| EC-11 | Service down or no acknowledgement when hook fires | Forwarder spools the same `delivery_id`, exits 0 silently within its own total deadline; idempotent replay on start | I |
| EC-12 | Spool overflow | Stop appending at cap; overflow counter; UI warning naming the exact hook-only coverage gap; files backfill what they can | I |
| EC-13 | Truncated / rotated / replaced file | size < offset or head-hash/inode change -> reparse from 0 with dedup | U |
| EC-14 | Partial trailing JSONL line | Carry bytes until newline; malformed complete line quarantined and counted | U |
| EC-15 | Huge transcripts (>= 200 MB) / huge single record | Streaming parse; FTS first 64 KB per item; bounded memory; UI lazy | P |
| EC-16 | Unicode / spaced / long paths; Claude dir name > 200 chars truncated with hash | cwd from records, never from dir name; NFC compare; original displayed | U |
| EC-17 | Windows paths (drive letters, `\`, case-insensitive, UNC, `\\?\`) | win32 comparison key; original preserved; tests via `path.win32` | U (v1 on Windows) |
| EC-18 | Symlinked home/project dirs; synced or network folders | realpath for grouping; polling fallback where watch is unreliable | I |
| EC-19 | Missed watch events (inotify limits, sleep) | Reconcile every watch reconciliation interval (FR-02) and on wake; recovery ≤that interval +1 s under M2; bounded incremental scans, no full-history blocking scan. | I |
| EC-20 | Concurrent resume interleaving | If live elsewhere (recent hook activity or known owner) or liveness is uncertain (silence does not prove safety): concurrency warning, offer Open/Fork; lock for Xaibo-owned; warn that external clients cannot be locked | U + E |
| EC-21 | Purged session resurrection (rescan, spool replay, late hooks, migration backups) | Purge covers events, FTS, attachments, complete and incomplete content/chunk files, spool entries, session-linked projections and backups; tested with interrupted chunk assembly followed by purge and replay; suppression marker skips rescans and replays; retention suppression clears only on demonstrably new native activity; manual suppression needs explicit "Re-import" | I |
| EC-22 | Retention vs active sessions | Never purge busy/waiting/needs-input, activity < 24 h, or Keep; auto-purged session later continued natively (new activity after purge) -> re-imported with notice; manual purge stays suppressed with a notice | U |
| EC-23 | Claude transcript cleanup (nominally 45 days if the Connect increase is kept; 30-day agent default if deselected; actual cleanup semantics UNVERIFIED) | Native availability checked independently; Xaibo copy stays; "Transcript only, not resumable"; resume disabled with reason; native expiry estimate shown as an estimate | I |
| EC-24 | Native deletion/archive (`claude purge`, `codex delete`/`archive`) | Xaibo copy kept; badge "native deleted/archived"; native files never recreated | I |
| EC-25 | Codex hook trust not granted | State "installed, awaiting trust" with steps; rollouts still observed; no bypass flag, no trust-hash writes | I + S5 |
| EC-26 | Plugin uninstalled outside Xaibo / leftovers | Reconcile on start -> "disconnected externally"; offer reconnect/cleanup of owned leftovers only | I |
| EC-27 | Xaibo deleted without Disconnect | Shim exits 0 silently; no visible errors or tokens; manual cleanup documented | I |
| EC-28 | Existing or absent Claude statusLine; capture failure; concurrent config edit | Untouched by default. Opt-in tee preserves original stdin, invocation, stdout/stderr and exit status; capture failure cannot block original execution. No-original case emits nothing, exits 0. Disconnect restores unchanged owned configuration; concurrent edits produce conflict. MVP, Gate 3 | U + I |
| EC-29 | Existing Codex notify | Opt-in wrapper invokes original argv with original JSON appended, no shell string; restore; conflict detection | U (v1) |
| EC-30 | OTel exporter already configured | Detected; never replaced without explicit choice; replacement consequences explained; Codex `metrics_exporter` set explicitly | I (v1) |
| EC-31 | OTLP port conflict | Next free port in range; agent config updated through manifest with consent; never kill other processes; hooks unaffected (socket) | I (v1) |
| EC-32 | Malicious local client on the hook socket | Reject bad token, frame > 1 MB, invalid protocol/version; socket private (owner-only) | U + I |
| EC-33 | Secrets in prompts / tool output | Stored full locally (0600); masked on every egress path; canaries never appear in egress | U (canary) |
| EC-34 | MCP result size caps | <= 8 KiB always, measured after sanitization and serialization including metadata/errors, even for one huge item; truncated flag + progressing cursor | U (v1) |
| EC-35 | Egress redaction coverage (MCP, export, logs, diagnostics, crash reports, test artifacts) | All go through `sanitize()`; one test per path; logs have no content | U |
| EC-36 | Prompt injection inside content returned via MCP | Returned as labeled data; minimal excerpts; control tool off by default | U (v1) |
| EC-37 | MCP opt-in writing into a user repo (`.mcp.json`) | Local/user scope only; repo files never written | I (v1) |
| EC-38 | Agent not installed / not on GUI PATH | Login-shell PATH + known locations; "not detected" + manual path; no errors | U |
| EC-39 | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides, multiple profiles | Read from login-shell env; manual add; identity includes profile (setup targeting is covered by EC-48 at Gate 3 and EC-73 at Gate 6) | U + I |
| EC-40 | Subagents and background work after Stop; immediate Stop on a session Xaibo did not launch | “Finishing…” within M1 without premature idle; settle after the turn-settle interval (default 4 s); busy "Background work" while children active | U (fixture) + P |
| EC-41 | Permission-wait heuristic vs confirmed | Confirmed only from explicit evidence; heuristic labeled "Probably waiting", no OS notification | U |
| EC-42 | Timezone / DST change | UTC ms; retention uses elapsed N x 24 h; DST fixture | U |
| EC-43 | Laptop sleep / wake | Reconcile scan on resume; suspended time excluded from R1; no false stuck | U (fake clock) + I |
| EC-44 | Disk full | Pause ingest without advancing checkpoints; spool stops; banner naming the exact hook-only coverage gap (hook-only evidence may be lost); no corruption | I |
| EC-45 | DB migration failure | Backup first; rollback; open read-only with banner; never delete data | I |
| EC-46 | Xaibo upgrade while agents run | Hooks target stable shim; events spool during upgrade; protocol version validated (`v-1` accepted once a second version exists); replay after | I |
| EC-47 | Two Xaibo instances (double launch, dev + prod) | Single-instance lock; dev uses separate data dir and socket | E |
| EC-48 | Agent config invalid or edited concurrently | Refuse on parse error; recheck hash before rename; abort with message | U |
| EC-49 | Managed settings, `disableAllHooks`, `allowedHttpHookUrls` | Effective config detected; coverage "hooks blocked by policy"; files-only mode | U |
| EC-50 | Non-interactive sessions (`claude -p`, SDK, `codex exec`) | Imported and tagged; resume command per kind (Codex flag needs **UNVERIFIED**, S6) | U |
| EC-51 | Compaction (Claude compact, Codex `compacted`) | Event recorded; no usage double count; pre-compaction history kept | U |
| EC-52 | Unknown hook events / new fields | Stored generically; no crash | U |
| EC-53 | Codex PreModelRequest/PostModelRequest missing on older versions | Capability detection by version; not relied upon | U |
| EC-54 | Codex state DB locked or schema changed (if enrichment ships) | Read-only connection; on lock/schema incompatibility skip enrichment and report reduced coverage; never copy live DB files; rollout ingest continues | I |
| EC-55 | Untrusted content rendering (HTML, markdown, ANSI) | Rendered as text; ANSI safe; no `innerHTML`; CSP blocks scripts | E |
| EC-56 | Very long lines / binary-like output | Wrapped, truncated with "show more"; no UI freeze | E |
| EC-57 | 50 concurrent sessions / sustained mixed traffic | M14 holds during backfill; bounded resources, no unexplained loss or duplicate logical operations | P |
| EC-58 | CJK / emoji search | FTS5 `unicode61` baseline; CJK limitation documented; trigram option later | U |
| EC-59 | OS notification privacy | Notifications contain only agent, approved project label (FR-10; "Project" placeholder until approved) and state; prompt excerpts, session titles, paths and tool content are never included; no content opt-in exists; OS notification dispatched within 2 s of the confirmed wait event (US-2), measured with a real monotonic clock | E + P |
| EC-60 | Non-loopback connection attempt from any dependency, Chromium feature or Xaibo Node/native process (incl. startup and failure paths) | Attempt blocked and logged; test fails on any attempt, not only on success | E + S10 |
| EC-61 | Runtime writes into the repo directory | None; E2E asserts `git status --porcelain` unchanged | E |
| EC-62 | Real data entering fixtures or commits | Pre-commit secret + privacy scan blocks; fixture lint requires synthetic id/path patterns | R + U |
| EC-63 | Oversized or malformed hook stdin | Forwarder bounds bytes while reading (never buffers unbounded stdin), caps 256 KB, flags truncated; full content from files; malformed input produces no output and no decision | U |
| EC-64 | Hook output adding tokens or noise | Forwarder writes 0 bytes to stdout/stderr, always exit 0; config lint rejects prompt/agent hook types | U |
| EC-65 | MCP called while Xaibo not running | Read tools return timestamped history with `as_of`, live state marked unavailable; control returns "app not running" and takes no action | I (v1) |
| EC-66 | Missing title / project | "Untitled" + first-prompt excerpt in-app only (never in notifications); default project = cwd basename in-app only; it reaches notifications only after the user confirms it as the approved project label (FR-10) | U |
| EC-67 | Resume of Desktop-origin Claude session | CLI resume from shared store if S7 confirms; else view-only with reason | S7 |
| EC-68 | Codex app-server thread started by Xaibo not visible in Codex Desktop / VS Code | Per S6: if app-server threads are hidden, start as interactive TUI (source `cli`) or show a documented coverage limit; MVP external-terminal launches already use the interactive TUI (FR-20, EC-76) | S6 + I, v1-A |
| EC-69 | Embedded terminal: exit, resize, Unicode, Ctrl-C, window close | PTY in main survives window close; correct resize/Unicode; Quit warns | E (v1) |
| EC-70 | Interrupted turn (Ctrl-C, `Interrupt` hook) | Outcome "interrupted", not error | U |
| EC-71 | Session moved/deleted while being tailed | Watcher closes cleanly; state updated; no crash loop | I |
| EC-72 | Agent-flow later rewrites or removes hooks | Xaibo uses its own command path (never a bare-origin URL) and own plugin, so unaffected | I |
| EC-73 | `cleanupPeriodDays` already set by the owner (higher, lower, or managed policy) | Preview a default-selected increase to `max(effective value, 45)`; owner may deselect; never lower a higher value; managed policy wins and is shown; Disconnect restores the prior value (or removes the key if absent before) only if the Xaibo-owned value is unchanged, else shows a conflict | U |
| EC-74 | Cross-agent sessions (Codex rollouts whose originator is Claude Code via the Codex plugin) | Stored as a Codex session tagged with its originator; linked to the Claude session when a matching tool call is found; counted once per agent in usage aggregates | U + I |
| EC-75 | MCP grant enforcement (ungranted project/agent/profile, widening filters, revocation while app is quit, Trash/suppressed sessions) | Denied before querying; filters cannot widen the grant; revocation honored offline; Trash and suppressed sessions excluded from results, counts and aggregates; account-level usage history denied without a usage-scope grant, even when project grants exist | U + I (v1) |
| EC-76 | Launch/resume argument safety (shell metacharacters, spaces, Unicode in cwd/IDs, stale ownership) | Native IDs, executable paths and cwd validated; external-terminal command text assembled only from validated, individually quoted whole-argument tokens (executable path, template arguments, native ID, cwd), tested with metacharacters; no catalog, transcript or user-supplied shell fragment reaches it; probes and embedded/ACP spawns use no shell; stale ownership is not treated as control | U + E |
| EC-77 | Malicious local request / DNS rebinding / browser POST to the OTLP receiver | Reject Origin header, non-exact loopback Host, bad token, body > 1 MB, wrong content-type | U + I (v1) |
| EC-78 | Invalid/imported catalog; duplicate bundled ID; executable probe | Reject invalid/shadowing entry; no execution before grant; valid data-only synthetic agent passes M15 | U + I |
| EC-79 | Newly installed agent; missing auth; blocked hooks | Rescan without restart; installation/auth/connection shown separately; setup steps and actual coverage shown | I + E |
| EC-80 | Gemini repeated message ID, `$set`, `$rewindTo`, legacy conversion | Correct current projection; observed revisions retained; no duplicate usage/FTS or session | U + I |
| EC-81 | Gemini native cleanup / missing tool-output file | Xaibo copy retained; native resume disabled when unavailable; missing content clearly reported | I |
| EC-82 | Custom full content, large chunks, retry/restart, malformed/auth failure | Private full-content persistence; idempotent delivery; bounded disk-backed assembly; partial/rejected content explicit; no unauthorized identity/path access | U + I |
| EC-83 | Generic notifications / unmatched permission resolution | No invented input wait; matching evidence alone clears requests; unresolved coverage remains visible | U |
| EC-84 | Changed executable/script/args/environment; shell command string | Launch blocked pending renewed grant; no shell evaluation or implicit package install; observe-only remains available | U + I |
| EC-85 | Provisional launch row, evidence binding, immediate Stop after launch | M11 launch portion; binding does not duplicate the session; post-Stop behaviour follows EC-40 (ingestion case, Gate 3) | E + P |
| EC-86 | Cold start, hidden tray window, 200 MB indexed session | M12; M13 on T0 (200 MB session) only, full M13 on T3 in the scale-up stage (D-P0-26); window hidden rather than destroyed; content paged without full-file read | E + P |
| EC-87 | 10,000 sessions / ≥10 GiB DB, WAL growth and query pressure | M13; bounded memory/handles/queues; maintenance and query work do not stall live dispatch | I + P |
| EC-88 | ACP missing load/resume capability, permission request, replay | Disable unsupported action; no external-session attachment claim; permission requires owner action; replay idempotent | I, v1-A |
| EC-89 | Generic GenAI telemetry without content/session identity; exporter conflict | Coverage explicit; no guessed session correlation; existing exporter preserved; full local content via verified channel or incomplete warning | I, v1-B |
| EC-90 | Gemini `general.sessionRetention.maxAge` unset, lower, higher, or set by managed/system policy; session retention disabled | Retention disabled: no change offered, shown as disabled (semantics read from the 0.46.0 package source in S11, not runtime-verified; no increase is offered until they are runtime-verified, record_decision 27). Otherwise Connect previews a default-selected increase to `max(effective value, 45d)`; owner may deselect; never lowers a higher value; managed/system policy wins and is shown; Disconnect restores the prior value (or removes the key if absent before) only if the Xaibo-owned value is unchanged, else shows a conflict (D-19) | U |
| EC-91 | Missing/null/expired rate windows, >100% spend, stale replay, unknown source time, sleep/wake | Per-field timestamps retained; no fake zero/freshness; reset-passed state and collection gaps explicit; repeated cached emission does not renew measurement age | U + I |
| EC-92 | Multiple profiles/accounts/terminals and missing account identity | Separate uncertain scopes; no credential/account-file reads, stored account identifiers or guessed cross-profile merge; newest eligible measurement selected within a proven scope | U + I |
| EC-93 | Missing Codex rate_limits, duplicate cumulative events, new token record version, context/model change | No additive snapshots, stale-field refresh or second window reduction; unsupported fields remain gaps; correct effective-window context and counter segments | U + I |
| EC-94 | Claude compaction/null current_usage, 1M↔200k switch, transcript-only fallback; Gemini tokens/window absent | Context generation invalidated; interim readings labeled; no old numerator/new denominator pairing; consumption/cost unchanged; unavailable/inferred/estimated labels correct | U + I |
| EC-95 | Mixed models/cache classes, partial tokens, reported session cost, delegated children and cumulative resets | One estimate per disjoint scope; correct component pricing; no context-derived cost, double count, negative delta or opaque-total proration; missing cost remains unavailable | U + I |
| EC-96 | Valid/invalid local price edit, unknown model, explicit owner fallback, mixed revisions | Last valid revision retained on error; no automatic fetch or silent rate; new calculations use accepted revision, old provenance retained; dates/coverage visible | U + I |
| EC-97 | Usage status, live-set totals, context usage view and session access (files touched, transcript, cost breakdown, timeline) under narrow layouts, missing/stale data and collection loss | FR-49/§6.9 capabilities work with keyboard/text equivalents in the approved design (FR-50); aggregate scope/coverage explicit; live health honest; files, transcript, cost breakdown and timeline preserve existing content access | E |
| EC-98 | Category records missing/duplicated/deferred; estimates exceed total; buffer settings unknown | No duplicate or deferred occupied-token count; exactness only from complete inventory evidence; residual/mismatch/unavailable behavior follows §5.11; no forced normalization or API call | U + I, v1-B |
| EC-99 | Forty-five-day quota expiry, Keep/Trash/purge, restart/replay and large quota history | Correct independent quota/session retention; no resurrection or fabricated samples; bounded/indexed queries; M13 holds with snapshot/index bytes included, at the personal profile (TP, D-P0-24); plan-scale T3 in the scale-up stage (D-P0-26) | I + P |
| EC-100 | Usage/context/cost enabled during live load and faults | M1/M2/M4/M5/M7/M14/M16 hold; category work cannot stall live dispatch; no prohibited command/backend call; capture overhead measured separately from foreign statusLine runtime | I + P |
| EC-101 | No model evidence yet; model ID not in the model list; agent-provided display name conflicts with the list; stale display name arrives after a newer model ID | "Model unavailable" without evidence; raw ID when unlisted (never blank or family-guessed); agent-provided name wins over the list only for the matching model identity/generation; delayed evidence never reverts newer state; cost follows §5.12 unknown-model rule | U |
| EC-103 | Settlement accounting: retention expiry in split batches; job killed mid-run; cumulative counters and counter resets; spool replay, explicit Re-import and suppression-clearing new activity after settlement | Settle + delete is one transaction; deltas, never cumulative snapshots; sessions/turns counted once per month bucket regardless of batches; month totals identical before and after expiry; settled contribution keys block double counting; genuinely new contributions still added | U + I |
| EC-104 | Month and quota semantics: time zone change, DST, events near midnight on the last day, partial current month, months before first observation; quota windows crossing months; multiple usage scopes; model filter on quota | Month by owner's local time zone at event time, offset stored; "month to date" label; missing months absent, not zero; quota peak = max measured in that month per scope, never summed or carried forward; uncertain scopes separate; model filter does not apply to quota; detail availability derived from retained records ("some details expired" vs "details expired, totals only", honoring Keep/active) | U |
| EC-105 | Deletion paths and clearing: Trash then restore, Trash expiry, manual purge, Keep, "Clear usage history" then restart and later expiry, price-file edit after freeze; cost coverage: mixed frozen/live, unknown prices, parent/child overlap, opaque session estimate spanning months; privacy fixture (no paths/names/account IDs in totals) | Trash/restore leaves totals unchanged; every permanent deletion settles first; Keep does not duplicate; cleared contributions never reappear (live or settled), later usage counts; frozen cost keeps its price revision; cost aggregates only disjoint attributable contributions, opaque estimates not prorated, partial = known subtotal, none = unavailable; totals contain only opaque keys | U + I + E |
| EC-102 | Mid-session model or effort switch; subagent on a different model than its parent | Current model updates within M1 on hook/report paths and M2 on file-only paths (pre-observation delay reported separately); switch recorded in timeline with timestamp; each subagent shows its own model; tokens/cost attributed per turn's model; tee and report v1 carry model/effort (FR-45, §5.10) | U + E |

### 9.3 Acceptance checklist
- [ ] All MVP rows in §9.2 pass (or have owner-approved waivers).
- [ ] All shipped metrics in §1.5 are measured and reported, including M11–M16 for MVP and M10 when MCP ships. A miss requires explicit owner acceptance; unrun tests are not passes.
- [ ] Add agent/custom reporter, Gemini folding/content/cleanup, launch grants and all assigned performance tiers pass; content coverage and unverified capabilities are visible. Claude second review and owner approval cover this delta.
- [ ] Fixture replay: §6.7 thresholds met; baselines reported.
- [ ] Playwright `_electron` E2E covers: first run + agent detection, Overview live updates, attention queue + notification, session workspace (turns, tools, subagents, files, reasoning), stuck/loop badge, search, move/pin/archive/Trash/Undo/restore/purge, retention settings + storage meter, Integrations connect/disconnect with diff preview, launch/resume in external terminal (command assembled, terminal spawn stubbed), tray/close/quit, settings persistence.
- [ ] Accessibility (A11Y, §4.3): every MVP flow operable by keyboard with visible focus and labeled controls; status conveyed with text + icon; focus restoration and rendered narrow-window layouts tested.
- [ ] Implemented screens follow the approved Xaibo design system (FR-50, Gate D), including light and dark themes as the design defines them; Playwright visual baselines are taken from the implemented approved design; Playwright MCP visual check done on every screen, console free of errors.
- [ ] Usage status/history, context usage view, live-set totals and session access (files touched, transcript, cost breakdown, timeline) pass their assigned tests; all unavailable/estimated/stale labels and aggregate scopes are visible.
- [ ] Price override validation and pinned calculation provenance pass; no price, quota, context, token-count or model request is made (FR-44).
- [ ] Usage/context/cost enabled in T2/T3; snapshot/index overhead and all affected M1–M16 results reported.
- [ ] Synthetic account identifiers and credentials do not survive in normalized snapshots, logs, diagnostics or fixtures; no real account file is used for tests.
- [ ] Zero attempted non-loopback connections by any Xaibo process in all E2E runs; OS-level socket audit (S10) clean.
- [ ] Forwarder: 0 output bytes, exit 0, spool works, M16 met (owner accepted the miss under a 50-way simultaneous burst, D-P0-22).
- [ ] Connect/Disconnect round-trip leaves agent configs byte-identical when Xaibo-owned values are unchanged (fixture copies of agent-flow hooks, custom statusLine, foreign notify, Gemini user-profile `settings.json` with foreign hooks and `general.sessionRetention`); changed values produce a conflict, not an overwrite.
- [ ] Native agent files never modified (checksum test over fixture stores before/after full E2E).
- [ ] App data only in the OS app-data dir with private permissions; repo unchanged after runs.
- [ ] Egress canary tests pass for every shipped egress path (OTLP, MCP and export checks apply only when those paths ship).
- [ ] Secret scan, privacy scan, fixture lint green on full history.
- [ ] Lint, typecheck, unit, integration, E2E, perf all green on a clean checkout.
- [ ] Licenses: agent-flow attribution/NOTICE kept where code reused and its telemetry removed; no AGPL code copied; dependency licenses listed.
- [ ] Before going public (separate gate): sanitizer pass over full git history and docs, license audit, owner sign-off.

---

## 10. Phases, gates and exit criteria
Every gate = Codex review -> Claude second review -> owner stop. Gate D exception: Codex authors the design, so that gate is Claude review then owner approval. Handoff notes go in `.handoff/` and are deleted after the gate. Each phase updates `docs/plans/<feature>_progress.md`. The owner approves the reconciled PRD and the challenged spike plan before any spike implementation. Every §9.2 row is assigned to exactly one gate below.

| Phase | Content | Exit criteria |
|---|---|---|
| **0 Spikes** | S1, S3, S4, S5, S6, S7, S9, S10, S11, S12, S13 per the spike criteria table below (S2 moves to pre-v1-A, S8 to pre-v1-B). Include S11 Gemini/catalog validation, S12 load/latency feasibility (including usage-snapshot scale) and S13 passive usage/context/cost. Core Gemini observation and agreed speed/capacity targets are required scope; misses return for owner decision rather than being silently deferred. | Spike report `docs/plans/phase0_spikes.md` with a decision per spike against its pass/fail evidence; §12 and App. E updated; dependency list approved by owner; S13 report and explicit account-scope/tee feasibility decision. A negative optional-feature result narrows scope rather than failing the MVP. **Gate 0** |
| **1 Skeleton + Claude ingest** | Electron shell, tray, security policy, service process (restart with backoff), SQLite schema + migrations, Claude transcript backfill/tail, session list (read-only), privacy tooling (pre-commit, scans, fixture lint), network denial + connection-attempt audit, log/diagnostic sanitization | EC-01, 03, 04, 08, 13..16, 18, 19, 33, 35, 38, 39, 45, 47, 55, 60, 61, 62 pass; M3 first-list target met on synthetic corpus; M6 and M9 (shipped egress paths) measured. **Gate 1** |
| **2 Codex ingest + normalization** | Codex rollouts (state-db enrichment only if coverage proves insufficient), dedup/precedence, agent-specific token normalization, usage model; Gemini native transcript ingestion and folding; passive Codex/Gemini context mappings, cost normalization/calculation and local price validation | EC-05, 06, 07, 10, 50, 51, 53, 54, 74, 80, 81, 93, 94, 95, 96, 101 pass; M3 full target. **Gate 2** |
| **3 Live status** | Safe config transactions (FR-32 engine) first, then forwarder + spool + socket (delivery IDs, acknowledgement), Claude plugin hooks, Codex hooks + trust flow, state machines, rules, notifications, sleep/wake. Hooks go only into disposable profiles or via the confirmed dev CLI (FR-32); real-profile Connect waits for Gate 6. Generic mapped hooks/report ingest, registration and full-content chunks. Claude statusLine tee engine and passive usage collection/history projection, under FR-32’s disposable-profile/dev-confirmation boundary | §6.7 thresholds (M8); EC-02, 09, 11, 12, 25, 28, 32, 40..44, 46, 48, 49, 52, 59, 63, 64, 70, 82, 83, 91, 92 pass; M1, M2, M3 (M1/M2 hold during import; M1/M2 cover usage/context/cost receipt paths), M4, M7, M11 ingestion portion (T0), M16 (including Xaibo’s added tee overhead). **Gate 3** |
| **D Design** | Codex leads the Xaibo design system (S-34, FR-50): original identity; color/type/spacing tokens including status semantics and dark/light themes; layouts for Overview (including usage status and live-set totals), Session workspace (including context usage, files touched, transcript, cost breakdown and timeline), History, Integrations/Add agent and Settings (including price-override access), with no additional top-level workspace (FR-49); key states empty, loading, error, stale, unavailable and estimate. A11Y rules (§4.3) are binding. Deliverable `docs/design/xaibo-design.md` (optional static mockups). References supply features only (D-23). | Codex authors the deliverable, so the gate review is Claude second review and owner approval of the design. Afterwards Playwright visual baselines are taken from the implemented approved design (Phase 4 onward). **Gate D** |
| **4 Session workspace UI** | Requires Gate D. Overview, attention queue, workspace (turns, workflow, tools, subagents, files, available reasoning), virtualization; bounded workers, watcher handles, live memory and IPC, implemented in the approved design system. Usage status/history access, live-set totals, context usage view and session access to files touched, transcript, cost breakdown and timeline | EC-56, 86, 97, 100, 102 pass; E2E for these screens; Playwright visual baselines from the implemented approved design; M5, M12, M14 at the personal profile (D-P0-24; includes enabled usage/context/cost); plan-scale M14 (T2) and EC-57 in the scale-up stage (D-P0-26). **Gate 4** |
| **5 History + retention** | Projects/folders, move, pin, archive, Trash, restore, purge (incl. spool/backups), suppression, search, retention, storage meter; large-history paging/search and maintenance; quota retention, linked snapshot purge and large usage-history queries | Purge acceptance; EC-21..24, 58, 66, 71, 99, 103, 104, 105 pass; E2E history flows and monthly usage chart (US-20); M13 at the personal profile (D-P0-24; includes quota history and its indexes); plan-scale M13 (T3) and EC-87 in the scale-up stage (D-P0-26). **Gate 5** |
| **6 Integrations** | Connect/disconnect UI over the Phase 3 transaction engine, diff preview (incl. default-selected `cleanupPeriodDays` increase), manifest, uninstall; Add agent, schema validation/local import, rescan, setup and coverage UI; Gemini retention offer (D-19; hidden until runtime-verified, S11); separate default-off statusLine tee opt-in and Settings access to reveal, validate and reload the private price override file | EC-26, 27, 72, 73, 78, 79, 90 pass; config round-trip byte-identical where Xaibo-owned values are unchanged (also covers the tee’s real-profile preview/manifest path); M15. **Gate 6** |
| **7 Control (MVP)** | Launch/resume in external terminal, ownership badges, concurrency guard, launch argument safety, Open in VS Code, Compare (stretch); generic/Gemini tested external-terminal launch/resume and trust grants | EC-20, 67, 76, 84, 85 pass; complete M11 (launch portion); US-8 verified live once by owner. **MVP Gate: full §9.3 + §1.6** |
| **Scale-up (deferred, D-P0-26)** | Runs only when the owner starts it, likely after the first version is finished (owner decision 2026-11-10, D-P0-36); not part of the MVP Gate. Re-run the Gate 4/5 perf tiers at plan scale on the seeded synthetic corpus with usage/context/cost and quota history enabled: T3 for M13 on ≥10,000 sessions / ≥10 GiB DB including a 200 MB transcript; T2 for M14 with 50 concurrent sessions at 200 events/s for 10 minutes. Targets kept, not relaxed | EC-57, EC-87 pass; M13 and M14 met at plan scale; a miss returns to the owner (§1.6 item 4). **Gate S** |
| **v1-A** | S2 PTY spike first; embedded terminal; Codex app-server control (per S6); ACP capability-negotiated Xaibo-owned start/load/resume; no auto-installing registry distributions | S2 passed; EC-68, 69, 88 pass. Gate |
| **v1-B** | S8 OTLP spike first; OTLP receiver; Compare with eligible tokens/timing/estimated cost and observed usage history; opt-in notify wrapper; estimated context category composition (S-33); Skills/MCP inspector (FR-35); generic GenAI mapping and Gemini OTLP/HTTP JSON validation (configure a local content channel where telemetry omits content; verify token-header support and exporter preservation before enabling) | S8 passed; EC-29, 30, 31, 77, 89, 98 pass; egress canaries cover OTLP; inspector evidence rules tested. Gate |
| **v1-C** | Xaibo MCP server (4 read tools + optional gated control, grants); labeled estimates and scoped usage history in existing read tools | S10 re-run with the MCP process; MCP path added to the `sanitize()`/canary test set; M6 and M9 re-measured with the MCP path; EC-34, 36, 37, 65, 75 pass (also covering cost metadata, coverage and history grants); M10. Gate |
| **v1-D** | Windows, then Linux builds | EC-17 on Windows; full E2E per OS. Gate |
| **Public release (optional)** | Sanitizer pass, license audit, signing decision | §9.3 last item; owner decision. Gate |

**Spike pass/fail criteria** (all outcomes **UNVERIFIED** until executed; a negative optional-feature result narrows scope rather than failing the MVP):

| Spike | When | Required pass/fail evidence |
|---|---|---|
| S1 SQLite | Phase 0 | Packaged `utilityProcess` opens the DB; WAL/FTS5/transactions work; kill/restart preserves committed events and checkpoints. Choose one engine. |
| S2 PTY | pre-v1-A | Packaged macOS input, resize, Unicode, Ctrl-C, exit and close/reopen work without orphaned processes. Repeat on each later OS. |
| S3 Forwarder | Phase 0 | Compare packaged Electron-run-as-Node, a minimal standalone packaged forwarder, and native Claude HTTP on supported events. Measure dispatch/spawn, forwarder, transport, service, renderer and paint separately; measure synchronous agent wait against a no-Xaibo baseline. Pass M1/M16, silent failure, authentication, bounded input, native trust, service-down recovery, spool replay and no-system-runtime packaging. HTTP cannot win on spawn time alone; document missing SessionStart support, synchronous wait and hook-only recovery gaps. No qualifying option means an owner-reviewed target/implementation decision. **Phase 0 result (record_decision 23, D-P0-22):** Node SEA forwarder behind a stable shim, private socket for every event (HTTP not adopted: no SessionStart, nothing spooled when the receiver is down); ack after an immediate small SQLite commit; Stop synchronous, other events async; own deadline = 100 ms − SEA startup p95. Single-dispatch added wait p95 ≈33 ms; under a 50-way simultaneous burst both process candidates miss M16 (SEA added wait p95 ≈276 ms; nothing lost, spooled). Owner accepted the burst miss. Spike, not gate evidence. |
| S4 Claude plugin | Phase 0 | Disposable profile: install, restart/reload, event receipt, duplicate-install prevention, disconnect and conflict-safe restoration. No skills, MCP definitions or context output in the hooks-only plugin. Fallback tested separately; `--settings` experiments only if fallback requires them. |
| S5 Codex hooks | Phase 0 | Pin 0.160.0; untrusted hooks do not execute; explicit user approval activates them; a changed hook requires renewed trust; uninstall preserves foreign hooks. Plugin route optional. |
| S6 Codex interoperability | Phase 0 | Record visibility, loadability, ownership and approval recipient separately per surface/version. A negative attachment result is acceptable: external sessions remain observe-only. |
| S7 Claude interoperability | Phase 0 | Separate external-TUI history visibility from later PTY hosting. Exercise manual denial, cancelled input, foreground Stop with background work, and child completion. Desktop listing and `--bg`/attach are optional outcomes. |
| S8 OTLP | pre-v1-B | Verify actual config syntax, auth headers, signal paths, payloads, flush behaviour and existing-exporter preservation. Confirm dollar fields remain agent estimates (D-13) and record whether any verified provider-billed amount is available locally (App. E #15). Agent monetary values remain estimates under revised D-13; eligible estimates may be aggregated with scope/coverage safeguards. OTel does not make them provider-billed amounts. |
| S9 Format survey | Phase 0 | Pin versions; synthetic fixtures for usage semantics, identifiers, unknown records, partial/huge lines, cleanup and optional compressed/metadata files. Unsupported optional formats produce coverage warnings. |
| S10 Network | Phase 0 (MCP added before v1-C) | Packaged main/service/renderer/forwarder; exercise startup, idle, errors, shutdown and dependencies. Pass requires zero attempted non-loopback connections, not merely zero successful requests. |
| S11 Gemini/catalog | Phase 0 | Disposable 0.46.0 profile: hooks and empty output, actual transcript path, content/thought/tool coverage, patch/rewind/legacy semantics, permission correlation, profile override, native retention (`general.sessionRetention.maxAge` key/value format such as `45d`, enabled/disabled semantics, effective-value resolution and system/managed-policy precedence) and interactive launch/resume. Validate generic maps and synthetic custom-agent schema; unsupported facts remain explicit. **Phase 0 result (D-P0-19, record_decision 27):** live parts not run: Google rejected personal sign-in for Gemini CLI 0.46.0 and the owner declined API key/Vertex. Hooks, transcript path, content/thought/tool coverage, patch/rewind/legacy and permission correlation (core-required C1–C5; required-scope miss, owner: skip) and launch/resume stay UNVERIFIED. Profile override and retention read from package source only, not runtime-verified; `maxAge` offer hidden. Generic maps, synthetic custom-agent schema and unsupported-fact labels pass; validator `ajv` 8.20.0 (owner approved, D-P0-34). Owner decision 2026-11-10 (D-P0-25, D-P0-36): replace Gemini CLI with the Antigravity CLI (`agy`) as the third agent, evaluated in Phase 2 (temp-profile isolation incl. its login, hooks, JSONL transcripts, resume, retention; current `agy` facts come from unverified public sources). |
| S12 Capacity/latency | Phase 0 | Synthetic feasibility measurements for 50 sessions, declared 200 events/s workload and ≥10 GiB SQLite/FTS corpus; measure worker isolation, query times, watcher/FD strategy, queue age and candidate forwarder hops. Record selected minimum architecture and unresolved gate risks; spike results do not replace packaged E2E gates. Include 45-day minute-sampled quota histories, transition rows, context projections and price provenance; report row counts, actual table/index/WAL bytes, retention cost and live/query interference. **Phase 0 result (D-P0-24, record_decision 28):** narrowed by the owner to a personal profile: 5 live sessions at ~20 events/s with bursts to 50/s, 1,000 watched files, 2 quota streams × 45 days, synthetic 1,500-session corpus (2.61 GiB DB, largest session 50 MB), plus one ~3× probe; 50 sessions, 200 events/s, ≥10 GiB and a 200 MB session not run. Proposed for Gate 0: §7.1 layout C, batch 100 rows/50 ms/1 MiB, per-file watch + 5 s scan (recursive FSEvents p95 ≈14.6 s, unusable for M2). Risk: bm25 common-term cold p99 593 ms > 500 ms search budget (M13). The plan-scale targets are kept, not relaxed, and measured in the deferred scale-up stage (D-P0-26). Spike, not gate evidence. |
| S13 Passive usage/context/cost | Phase 0 | Synthetic/disposable-profile evidence for Claude tee byte/exit preservation, absent-original and capture-failure paths, bounded added wait and no output/tokens; installed-version snapshot schemas, scope attribution limits, compaction/model-window changes and price-component semantics. Validate local capture without requesting quota/context/model APIs. Record incomplete category/Gemini evidence explicitly. No qualifying tee means return to owner for scope/implementation decision, not silent use of an account cache. |

---

## 11. Risks and mitigations

| Risk | Prob. | Impact | Mitigation |
|---|---|---|---|
| Claude transcript format changes on upgrade | High | High | Tolerant parser, per-version fixtures, drift banner, hooks as independent status source |
| Cross-client live control assumed but impossible | Med | High | Ownership badges; S6/S7 before any claim; per-version, per-surface compatibility matrix; history sharing is the promise, live attach is conditional |
| Setup breaks agent-flow, statusLine or foreign notify | Med | High | Plugin route, marker entries, byte-identical round-trip tests on fixture copies |
| Confidential data leaks via MCP answers to the cloud provider | Med | High | Opt-in with disclosure before enabling; masking is best effort, not a guarantee; capped, minimal excerpts; canary tests |
| MCP authorization gap (one user-scope registration exposes every project) | Med | High | Explicit per-registration grants enforced server-side on every call, incl. search/counts/usage; revocation honored offline (FR-43, EC-75) |
| Purged content survives in spool, backups or late hooks | Med | Med | Purge covers derivative copies; suppression blocks replay resurrection (FR-11, EC-21) |
| Hook-delivery identity errors (duplicates merged, distinct events dropped, delayed events regress status) | Med | Med | Forwarder-assigned `delivery_id`, native-ID correlation, causal ordering, replay tests across second boundaries (§5.5, EC-09) |
| Real data committed to a repo that may go public | Med | High | Pre-commit scans, fixture lint, ignored data patterns, sanitizer gate before public |
| Hook spawn cost slows agents | Med | Med | S3 chooses per-event reporting path; async where supported, bounded synchronous wait where unavoidable; no zero-overhead claim. |
| `node:sqlite` lacks FTS5 or misbehaves in Electron | Med | Med | S1 passed (§7.4): FTS5 present in Electron 45.2.3; `node:sqlite` is a release candidate, so Electron stays pinned and the S1 probes re-run on every Electron bump; any `better-sqlite3` fallback needs owner approval |
| node-pty packaging issues across OSes | Med | Med | S2; v1 only; external terminal remains |
| Codex trust friction makes "one click" feel broken | High | Low | Clear guided step; files-only coverage meanwhile |
| Electron RAM over targets | Med | Med | Service in `utilityProcess`, virtualization, perf gate M4/M5 |
| Duplicate/conflicting sources distort usage | Med | Med | Precedence rules, order-invariance tests |
| harness-os keyword risk rubric fires constantly ("session", "token" are core domain words) | High | Low | Expect approval prompts; read rationale; record decisions via `record_decision` |
| Codex review unavailable (companion blocked by sandbox) | High | Med | Owner allows the one command or adds the plugin data dir to the sandbox allowlist (App. B.6); gates do not pass without Codex review |
| License contamination (AGPL harp) | Low | High | Clean-room behaviour only; license list at every gate |
| Over-scoping MVP | Med | Med | Ponytail review per diff; P1/P2 deferred |
| Catalog implies universal compatibility | High | Med | Supported-contract boundary; explicit capabilities and content coverage; M15 |
| Imported launch/detection executes hostile code | Med | High | No automatic execution, explicit grants, executable/script identity revalidation, no shell/package downloads |
| Gemini rewind/update corrupts projection or usage | Med | High | Immutable observed records, ordered fold, atomic projection/index updates, EC-80 |
| Full-content retention exceeds disk/queue capacity | Med | High | Storage meter, streaming/chunks, existing retention/Keep policy, explicit pressure/gap reporting |
| Parsing/SQLite/FTS maintenance stalls live UI | Med | High | Worker isolation, bounded queues, live-first scheduling, T2/T3 gates |
| Native HTTP is fast but synchronous or loses hook-only evidence | Med | Med | S3 measures wait/recovery; private socket remains default |
| OTel/ACP is mistaken for complete external-session observation | High | Med | Capability negotiation, explicit correlation and coverage; no unsupported attachment/content claims |
| Passive readings look current despite cached data or silent account changes | High | Med | Per-field time/quality, separate observation time, unknown scope epochs, no guessed account merge, stale/reset states |
| Dollar estimate mistaken for subscription spend or bill | High | Med | Persistent estimate label, quota/spend shown separately from session cost, source/prices date, partial coverage and no silent fallback |
| Parent/child or cumulative counters inflate totals | Med | High | Disjoint scope accounting, tested counter segmentation, ambiguous additions excluded with coverage warning |
| Category heuristic appears as exact `/context` output | High | Med | v1 only, `~est`, evidence completeness, unavailable rows, mismatch fallback; no accuracy claim |
| StatusLine capture changes foreign behavior or delays agent | Med | High | Default-off opt-in, byte/exit golden tests, bounded Xaibo overhead, original command independent of capture failure |

---

## 12. Open questions

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | ~~Retention~~ **Resolved (D-9):** Xaibo copy deleted 45 days after last activity; Connect previews a default-selected Claude `cleanupPeriodDays` increase to `max(effective value, 45)` (deselectable); these defaults align nominal retention periods, native availability is checked separately and is not guaranteed; Trash 30 days from deletion; storage meter; per-session Keep. Gemini parity: D-19 (EC-90). | n/a |
| Q2 | ~~DB encryption at rest~~ **Resolved (D-11):** skipped while local-only with zero network; OS disk encryption + private file permissions; revisit before public release. | n/a |
| Q3 | ~~Codex daemon outcome (S6): can Xaibo attach to threads owned by other Codex clients?~~ **Resolved (S6, record_decision 35):** no, on Codex 0.160.0 in no-daemon mode: a second client lists and reads an externally owned thread, but `thread/resume` fails and no notifications arrive. External Codex sessions observe-only; live control only for threads Xaibo starts. Shared-daemon mode, VS Code and Desktop untested; re-test before any v1-A control feature relies on attach. | n/a |
| Q4 | ~~Windows/Linux timing~~ **Resolved (D-11):** after MVP acceptance on macOS, in v1-D (Windows first, then Linux). | n/a |
| Q5 | Public release | Stays private until sanitizer pass, license audit and owner sign-off |
| Q6 | ~~Xaibo MCP in MVP or v1?~~ **Resolved (D-11):** v1 (v1-C), not MVP. | n/a |
| Q7 | ~~Forwarder runtime (S3)~~ **Resolved (S3, owner decision 2026-11-10, record_decision 23):** Node SEA forwarder behind a stable shim; private Unix socket for every event; ack after an immediate small SQLite commit; Stop synchronous, other events async. The M16 miss under a 50-way simultaneous burst is accepted by the owner. | n/a |
| Q8 | Status thresholds (R1–R5, 4 s turn-settle interval, watch reconciliation interval, 5 s heuristic). Watch reconciliation interval part resolved (S12, record_decision 28; proposed, owner decision at Gate 0): 5 s default at the personal profile, missed-watch recovery 6 s; trees of ~10k files need ≥15–30 s. | Turn-settle 4 s (§6.2/§6.3); watch reconciliation interval 5 s (FR-02); R1–R5 and 5 s heuristic in §6.2/§6.4; all user-adjustable |
| Q9 | ~~Notification content~~ **Resolved (D-11):** agent, approved project label (FR-10) and state only; no prompt excerpts, session titles, paths or tool content; no content opt-in. | n/a |
| Q10 | ~~Estimated cost~~ **Resolved, revised 2026-11-09 (D-12/D-13):** show labeled estimated cost from eligible agent figures or real tokens × explicit local prices, with coverage and provenance. | n/a |
| Q11 | Native archive/delete actions from Xaibo | Never (owner decision: Xaibo deletes only its own copy) |
| Q12 | Claude Desktop handoff (`--desktop`, needs subscription). S7: `--desktop` listed in `claude --help` on 2.1.322, not exercised; Desktop untested (real profile only). | Not in MVP (default stands, record_decision 36) |
| Q13 | Export format (S-24) | Markdown + JSON, masked, P2 |
| Q14 | ~~Untracked `.claude/proven-config*` files~~ **Resolved (D-10):** created by the ruflo plugin hook (runtime state, not harness-os); git-ignored. | n/a |
| Q15 | Gemini/custom adapters. **Proposed resolution:** Resolved by proposed D-14: Gemini observation and custom report/catalog integration in MVP; ACP and generic OTel in v1. Pending owner approval. | D-14 scope applies unless the owner rejects it |
| Q16 | ~~Show session cost totals (agent-flow cited as a feature reference only, D-23)?~~ **Resolved: yes, owner decision 2026-11-09.** Estimates may appear in live-set totals, per-session/per-agent views, Compare and labeled MCP output; §5.12 applies. | n/a |
| Q17 | ~~Which S3 candidate meets latency, agent-wait and recovery requirements?~~ **Resolved (S3, record_decision 23):** SEA over the private socket (Q7). Native Claude HTTP not adopted: no `SessionStart`/`Setup` support, nothing spooled while Xaibo is down, agent-visible stderr seen once; no automatic HTTP switch. | n/a |
| Q18 | Which Gemini 0.46.0 semantics/coverage pass S11? S11: none verified live. Google rejected personal sign-in for Gemini CLI 0.46.0 (an API key or Vertex would be needed) and the owner skipped the live parts (D-P0-19); S11-C1–C5 and C8 not run; profile override and retention source-read only, not runtime-verified. | Report each unverified field/capability; no complete-content or confirmed-status claim without evidence; App. E #16/#17/#24 (Gemini) stay UNVERIFIED; `maxAge` offer not shown; FR-51 Gemini effort unavailable; see Q23 |
| Q19 | Does the reference Mac meet all timing/capacity targets? S12 status (spike, not gate evidence; personal profile, D-P0-24): feasible at the personal profile; at risk: M3 import (backfill rate too low for ≤120 s), M13 common-term bm25 search (cold p99 over the 500 ms budget; needs newest-first or capped bm25 candidates), M2 for a new session's first record (per-file watches cannot see new files, so it waits for the ≤5 s scan), M4 idle RSS (S10 window-closed summed RSS 270 MiB mean in one run, 198 MiB in a second, against 250 MB; summed RSS overstates it; S12 service RSS under load also above 250 MB; Phase 3 re-measures footprint-based). Plan-scale M13/M14/EC-57/EC-87 unmeasured. | Targets remain acceptance gates; larger-scale targets (M13, M14, EC-57, EC-87) are kept and measured in a deferred scale-up stage after the personal-profile path (D-P0-26), not relaxed; misses require owner decision, not silent relaxation |
| Q20 | Which optional launch environment keys may custom agents receive? | Minimal operational environment only; provider credentials require an explicit per-agent grant |
| Q21 | ~~Multiple machines/team use?~~ **Resolved: one platform for one local machine only, owner decision 2026-11-09.** No multi-machine collection/sync work; retain the versioned local service boundary. Existing sequential OS build plans do not imply cross-machine operation. | n/a |
| Q22 | ~~Show effort / reasoning level next to the model name?~~ **Resolved: yes, owner decision 2026-11-09 (FR-51, D-24).** | n/a |
| Q23 | Third agent: replace Gemini CLI with the Antigravity CLI (`agy`)? **Resolved: yes, owner decision 2026-11-10 (D-P0-25, D-P0-36).** evaluate `agy` in Phase 2 (temp-profile isolation incl. its login, hooks, JSONL transcripts, resume, retention); its hook and transcript facts come from public sources only and are UNVERIFIED; the Antigravity IDE is not the observation target. | Gemini CLI stays the third agent with observation UNVERIFIED (Q18) until the owner decides |

---

## Appendices

### A. Glossary
| Term | Meaning |
|---|---|
| OTel (OpenTelemetry) | Vendor-neutral standard for programs to emit metrics, logs/events and traces |
| OTLP | The OTel wire protocol; Xaibo would receive OTLP/HTTP JSON on loopback (`/v1/logs`, `/v1/metrics`, `/v1/traces`) |
| Hook | A command the agent runs on a lifecycle event (e.g. before a tool runs), receiving event JSON on stdin |
| Transcript | Claude Code's per-session JSONL history file |
| Rollout | Codex's per-session JSONL history file |
| App-server | Codex's JSON-RPC server for starting/resuming threads and turns, statuses and approvals |
| PTY | Pseudo-terminal; lets Xaibo host an interactive CLI inside its window (node-pty + xterm.js) |
| MCP | Model Context Protocol; how agents call external tools. Xaibo's MCP server lets an agent query Xaibo history |
| Retention | Rule for how long Xaibo keeps its own history copy before deleting it automatically |
| Spool | Private append-only file where the hook forwarder saves events while Xaibo is not running; replayed later |
| Egress | Any path by which data leaves Xaibo's private store (MCP, export, logs, crash/diagnostics, test artifacts) |
| Masking | Replacing secrets/identifiers with placeholders at egress |
| Suppression marker | Minimal record that stops a purged session from being re-imported |
| WAL / FTS5 | SQLite write-ahead logging / full-text search engine |
| Entrypoint / source kind | Which surface created a session (CLI, VS Code, Desktop, SDK, exec, app-server) |
| Manifest | Xaibo's record of every config change it made, used to undo exactly |
| `utilityProcess` | Electron's API for a Node child process managed by the main process |

### B. Tooling runbook
1. **harness-os** (governance, Docker + Postgres): `harness init` is TTY-gated and needs Docker, so **the owner runs it** in their own terminal. Status: already run (initial scaffold commit present; gated globs `src/**/*.ts(x)`, tests `npm test`). Its `.claude/` governance files stay tracked. Every unit of work goes through `run_workflow` (`new-feature`, `hotfix`, `security-change`); a test must be seen failing before code. If a config file is edited on purpose: `harness reconcile-config <project>`.
2. **ruflo** (orchestration): parallel agents for independent tasks (e.g. fixture authoring, test writing, review sweeps), task tracking and memory. Runtime state (`.claude-flow/`, `.swarm/`) is git-ignored.
3. **graphify** (knowledge graph): `/graphify` over `docs/` and `src/` at the start of each phase and before reviews, for navigation and impact questions. Output `graphify-out/` is git-ignored.
4. **ponytail** (minimal-code discipline): always on; `/ponytail-review` on each diff before a gate; `ponytail:` comments mark deliberate simplifications.
5. **Playwright**: `@playwright/test` with `_electron` for automated UI tests; Playwright MCP for visual checks. Artifacts (`test-results/`, `playwright-report/`) are git-ignored and contain synthetic data only.
6. **Codex** (lead designer, first reviewer) via the Codex plugin. Known blocker: the companion cannot write its job log under `~/.claude/plugins/` inside the sandbox. Owner options: allow that one command unsandboxed, add the plugin's data dir to the sandbox write allowlist (`/sandbox`), or run the companion command in their own terminal. For the PRD v0.3 review the owner allowed the companion to run outside the sandbox for handoff.
7. **Handoffs**: temporary files in `.handoff/` (ignored), deleted after each gate.
8. **Git**: default branch `master` (renamed from `main` 2026-11-09; root commit is the harness scaffold). Every unit of work starts from an up-to-date `master` with `git switch -c <type>/<topic>` (`type` = `feat` | `fix` | `chore` | `docs`; one branch per phase, e.g. `feat/phase1-claude-ingest`). Never commit or push to `master` directly; commit/push only when the owner asks; merge via PR after the gate. Pre-commit hook via `git config core.hooksPath .githooks`.
9. **Installs**: ask the owner before installing anything (App. C).

### C. Install-approval list (all NEED OWNER APPROVAL; exact versions pinned at install)

| Package | Kind | Purpose | When |
|---|---|---|---|
| `electron` | dev (runtime bundled) | App shell; stays pinned, S1 probes re-run on every bump (`node:sqlite` is release candidate) | Phase 0 (installed 45.2.3, exact) |
| `typescript` | dev | Type checking, build | Phase 0 (installed 7.0.2, exact) |
| `vite`, `@vitejs/plugin-react` | dev | Renderer build/dev server | Phase 1 |
| `react`, `react-dom` | runtime | UI | Phase 1 |
| `@tanstack/react-virtual` | runtime | List virtualization (M3/M5) | Phase 4 |
| ~~`better-sqlite3`~~ | — | Not needed: S1 chose `node:sqlite` from Electron's bundled Node (record_decision 16); not installed | — |
| `@playwright/test` | dev | Electron E2E (`_electron`) | Phase 1 |
| `eslint`, `typescript-eslint` | dev | Linting incl. forbidden-import rule | Phase 1 |
| `electron-builder` | dev | Packaging (`dist:mac`, later win/linux) | Phase 0 (errata 2026-11-09: owner decision D-P0-01; S1, S3 and S10 need a packaged app; installed 26.18.0, exact) |
| `smol-toml` | runtime | Validate Codex `config.toml` after text edits | v1-B (first `config.toml` edit: notify wrapper, OTel) |
| `node-pty` | runtime (native) | Embedded terminal | S2 / v1-A |
| `@xterm/xterm`, `@xterm/addon-fit` | runtime | Terminal rendering (WebGL addon deferred until needed) | S2 / v1-A |
| `@modelcontextprotocol/sdk` | runtime | MCP stdio server (alternative: small hand-written JSON-RPC) | v1-C |
| `ajv` | runtime | JSON Schema validation (catalog): exact pin 8.20.0, `ajv/dist/2020`, `strict: true`, `allErrors: true`, never `loadSchema`/`compileAsync`; costs: 4 permissive dependencies, ~1.3 MB, CommonJS, runtime code generation | Phase 1 start (owner approved 2026-11-10, D-P0-34) |
| Official Node build (not an npm package) | build tool (dev-time) | Build the SEA forwarder and statusLine tee (`node --build-sea`); Homebrew Node is a shared-library build with SEA disabled. Phase 0: official Node 26.10.0 macOS arm64 tarball, checksum-verified against nodejs.org SHASUMS, in git-ignored `.cache/node-official/` (D-P0-21). The SEA adds a ~138 MB binary to the package (S3-C12). Product Node binary decided in Phase 3 (OQ-A4) | Phase 0 (dev-time, D-P0-21); product build: Phase 3 |
| ~~gitleaks~~ | — | Dropped by owner (D-20). Secret patterns (API keys, tokens, private-key blocks, credential URLs) are checked by the in-repo `scripts/privacy-scan` in pre-commit; no install | — |

Not needed (by choice): Tailwind, chart libraries (hand-written SVG), test runners beyond `node:test`, husky, HTTP client libraries, telemetry SDKs.

No additional runtime dependency is preselected for extensibility. JSON Schema validation uses the validator selected at Gate 0: `ajv` 8.20.0 (row above, S11-C12), owner approved 2026-11-10 (D-P0-34); installed at Phase 1 start. ACP library choice is deferred to pre-v1-A. Worker threads, framing, catalog mappings and `xaibo-report` reuse the packaged runtime. Xaibo never installs agent binaries or packages.

### D. Decision log (conflicts resolved, per owner instruction "you decide the conflict")
| ID | Conflict | Decision | Reason |
|---|---|---|---|
| D-1 | Separate always-on daemon serving UI over localhost (stack research) vs in-app service with plain renderer (design draft) | Service in Electron `utilityProcess`; renderer via IPC; tray keeps it running after window close | Meets "collect after window close" with no daemon lifecycle, no UI HTTP server, smaller attack surface |
| D-2 | Claude hooks via plugin (research) vs settings.json entries (design draft) | Plugin via local marketplace first; marker-based settings merge as fallback if S4 fails | Agent CLI owns the edit; clean uninstall; no settings churn |
| D-3 | Redact before persistence (design draft) vs store full content (owner) | Store full locally; mask at egress | Owner decision; local copy must be complete |
| D-4 | Purge native JSONL after confirmation (research) vs Xaibo-only delete (owner) | Xaibo-only, always | Owner decision |
| D-5 | Drive Claude headless (`-p` stream-json) vs interactive TUI | Interactive TUI | `-p` sessions are hidden from native pickers; visibility both ways is required |
| D-6 | agent-flow: replace vs coexist | Coexist; never touch its entries or folder | Owner's tool keeps working; Apache code reusable with attribution, minus its telemetry |
| D-7 | Hook transport: loopback HTTP vs local socket (revised in v0.4) | Private socket/named pipe remains the default hook/report transport. Native Claude HTTP is an S3 candidate on supported events only; adoption requires measured latency, bounded agent wait, equivalent security and explicit delivery/recovery behavior. Loopback HTTP is no longer categorically restricted to OTLP, but no HTTP hook receiver ships without this decision’s evidence. Phase 0 outcome (S3, D-P0-22, record_decision 23): native HTTP not adopted (no SessionStart, nothing spooled while the receiver is down); the SEA forwarder over the private socket is used for every event. | No port, no DNS-rebinding surface for the main path unless S3 evidence justifies it |
| D-8 | `claude resume <id>` (design draft) | `claude --resume <id>` | Matches verified CLI help |
| D-9 | Retention default: Never (Codex draft) vs N days (owner) | Xaibo copy deleted 45 days after last activity; Connect previews a default-selected Claude `cleanupPeriodDays` increase to `max(effective value, 45)` (deselectable, never lowers); Trash 30 days from deletion | Owner decision 2026-11-09. These defaults align nominal retention periods; native availability is checked separately and is not guaranteed. Gemini parity: D-19 (EC-90). |
| D-10 | `.claude/proven-config.json`, `.claude/.proven-config-version`: track or ignore | Git-ignored | Written by the ruflo plugin hook (runtime state), not by `harness init`. Verified by Claude: the ruflo-core plugin's `ruflo-hook.cjs` references proven-config. |
| D-11 | Defaults for DB encryption, Windows/Linux timing, MCP timing, notification content | Accepted as proposed: no at-rest encryption while local-only; Win then Linux after macOS MVP; MCP in v1; notifications contain only agent, approved project label (FR-10) and state; no prompt excerpts, session titles, paths or tool content; no content opt-in | Owner decision 2026-11-09 |
| D-12 | Never estimate versus owner’s revised Q16 | Compute estimated USD cost from real normalized tokens and explicit versioned prices when no eligible agent session estimate exists; unknown pricing remains unavailable; no silent fallback | Owner decision 2026-11-09 supersedes prior prohibition |
| D-13 | Details-only agent estimates versus live/session/Compare totals | Eligible estimates may be shown and aggregated in live-set totals, sessions, per-agent views, Compare and MCP. Always `~`/estimated, never billed; non-overlapping scopes, coverage and provenance required | Owner’s revised Q16; §5.12 |
| D-14 | Gemini/custom later versus extensibility now | MVP catalog/Add agent/local import/report contract plus Gemini native observation; ACP and generic OTel in v1 | Delivers useful extensibility without a parser language or code-plugin runtime |
| D-15 | Research content-off default versus owner rule | Full source-exposed content stored locally for every agent; masking only at egress; unavailable content explicit | Owner requirement |
| D-16 | Unlimited extensibility/capacity claims versus testable scope | Contract-based extension; tested 50-session, 200-events/s and ≥10,000-session/≥10-GiB tiers | Concrete acceptance without promising arbitrary formats or unlimited resources |
| D-17 | Literal immediate/zero-overhead targets versus agent behavior | M1/M2/M11–M16; observable-signal timing, provisional launch row, async preference and measured synchronous exceptions | Xaibo cannot control pre-signal startup or erase synchronous execution cost |
| D-18 | Push-before-DB versus durable delivery | Volatile live projection first; visible pending durability; durable acknowledgment and idempotent spool replay unchanged | Fast UI without false durability claims |
| D-19 | Gemini retention parity: warn-only (Codex design) vs parity with D-9 (Claude second review) | Gemini CLI natively deletes sessions after 30 days (`general.sessionRetention.maxAge`). Setup offers, previewed, default-selected and deselectable like Claude `cleanupPeriodDays`, to raise `maxAge` to `max(effective value, 45d)`; never lowers; managed/system policy wins; Disconnect restores only unchanged Xaibo-owned values (FR-33, FR-34, EC-90) | Same nominal-retention alignment and reversibility as D-9; native availability is still checked separately |
| D-20 | Secret scanning tool: gitleaks (Docker image) vs no new tool | gitleaks dropped; secret patterns are part of the in-repo `scripts/privacy-scan` run by the pre-commit hook; installs are project-local with repo `.cache/` for download caches | Owner decision 2026-11-09 (App. C approved except gitleaks) |
| D-21 | Future multi-machine option versus single-machine product | One local machine per installation; no multi-machine implementation. Preserve versioned service interfaces | Owner decision 2026-11-09, Q21 resolved |
| D-22 | Claude cache fallback versus earlier statusLine tee | Default-off chained tee in MVP; no `~/.claude.json` usage reader. Passive Codex rollouts and unavailable Gemini quotas; quota history MVP, category estimates v1-B, no active backend refresh | Covers requested passive signals with less undocumented/account-sensitive machinery; accepted by Claude second review, awaiting owner approval |
| D-23 | Reproducing reference products' UI (agent-flow, harp, deer-flow, Claude Code's context view, the owner's dashboard screenshot) versus an original design | Xaibo has its own design system (S-34, FR-50), produced in the Design step and approved at Gate D. References supply features only, never layout, navigation structure, visual style, tab/header naming or color schemes. A11Y rules remain binding | Owner decision 2026-11-09 |
| D-25 | Monthly usage history vs 45-day detail retention | Keep per-month totals forever (until "Clear usage history"); expiring records are settled into frozen month totals in the same transaction; no content kept | Owner decision 2026-11-09 ("Keep monthly totals") |
| D-24 | Where friendly model names come from | Agent-provided display name > bundled/editable model list (`models.json`, shared with prices) > raw ID; per-turn model and switch history stored; effort / reasoning level shown beside it when the agent records it, never guessed (S-35, FR-51, Q22) | Owner request 2026-11-09; one data file avoids a second registry |
| D-26 | D-2 Claude integration route: hooks-only plugin vs settings merge | Hooks-only plugin from a local marketplace (`claude plugin marketplace add` + `claude plugin install … -s user`); settings merge stays the fallback and never runs together with the plugin (both deliver every event twice) | Phase 0 S4 on 2.1.319, record_decision 24 |
| D-27 | Passive Claude usage source: statusLine tee feasibility | Feasible as a SEA binary behind the stable shim (added wait p95 33–78 ms against the 100 ms bound; plain Node 124–168 ms, not shipped); default-off opt-in as D-22 | Phase 0 S13, record_decision 32; owner approval 2026-11-10, record_decision 33 |
| D-28 | Account scope of passive usage readings | Claude statusLine has no account identifier: readings stay "Account scope unverified" unless the owner declares an epoch. Codex `session_meta.creator_account_id` is used only as a local salted hash marking an account change, never stored raw (§5.11) | Owner decision 2026-11-10, record_decision 33 |

D-14..D-19: accepted by Claude second review; pending owner approval. D-20, D-21, D-23: owner decisions. Revised D-12/D-13 apply the owner's Q16 decision. D-22: accepted by Claude second review; pending owner approval.

### E. UNVERIFIED register
1. Resolved (S4, 2.1.319): `claude plugin marketplace add`, `plugin install -s user`, `plugin uninstall -s user`, `plugin marketplace remove` verified, no confirmation flag needed; hooks-only plugin adds 0 tokens. Plugin token-cost display not observed (headless only).
2. Not required (S4): the fallback uses a marker-based settings merge, so `--settings` merge vs replace and `CLAUDE_CODE_PLUGIN_DIRS` syntax stay untested (`--settings`/`--plugin-dir` exist in `--help`).
3. Background completion resolved (S7, 2.1.322): a queued-message turn (`UserPromptSubmit` → `Stop`) after the foreground `Stop`; backgrounded subagents end with `SubagentStop` after `Stop`. Still UNVERIFIED: PTY session in VS Code history (PTY hosting S2/v1-A), Desktop auto-listing and VS Code (would read the real profile), `--bg` (exists in `--help`, not exercised).
4. Narrowed (S6, 0.160.0, no-daemon mode): app-server threads appear in the `codex resume` picker; approvals go to the starting client only (TUI or app-server client); no live attach to externally owned threads. Still UNVERIFIED: shared-daemon mode (eligibility, which clients share it, attach and approval routing; the daemon does not start inside the runner; re-test before any v1-A/Phase 7 control feature) and Desktop/VS Code visibility (real profile only).
5. Closed (S5, 0.160.0): FR-31 uses `$CODEX_HOME/hooks.json` with Codex trust review; `codex plugin add/list/marketplace` exist but the optional plugin route was not run.
6. Resolved (S1): `node:sqlite` in Electron 45.2.3's bundled Node 24.22.2 (SQLite 3.53.4) opens the DB in the packaged `utilityProcess` and its workers; WAL, FTS5, transactions and kill/restart pass. API is a release candidate: re-run S1 probes on every Electron bump.
7. node-pty prebuilds for the target matrix (S2).
8. Resolved (S9): `.jsonl.zst` files are present only in the Codex store (owner audit; fresh temp profiles wrote none) and are stream-decompressed with built-in `node:zlib` (EC-03); Claude `sessions/*.json` is not read in the MVP (coverage warning), schema not established.
9. Codex OTel coverage of exec/app-server/IDE and flush interval (S8).
10. OTLP default port and paths taken from spec knowledge, not fetched (S8).
11. How Claude's cleanup measures transcript age (mtime vs last record): still UNVERIFIED; S9 cleanup not triggered (headless runs do not clean up; the TUI did not reach ready under expect). EC-23 keeps its estimate label.
12. Private-repo CI minute limits (v1-D).
13. Resolved on 2.1.322, untested on 2.1.319 (S7): manual denial = the call's transcript `tool_result` rejection (`is_error` + rejection text) after `PreToolUse` → `PermissionRequest` (an interrupt leaves the same rejection without a `PermissionRequest`), with no `PostToolUse`, `PermissionDenied` or `Stop`; input requests = `Elicitation` → `ElicitationResult` (`action` accept/decline/cancel) with `Notification` `elicitation_dialog`/`elicitation_response`; `idle_prompt` is not an input request.
14. Narrowed (S6/S7; compatibility matrix in `phase0_spikes.md`): Codex 0.160.0 TUI, `exec`, app-server and Claude 2.1.322 TUI, `-p` recorded; external Codex sessions observe-only (Q3). Still UNVERIFIED: VS Code and Desktop rows for both agents (real profile only), Codex shared-daemon mode, Claude `--bg`/live attach; Claude matrix re-pinned at Gate 1 to the tested version.
15. Whether any verified provider-billed amount is available locally (S8; none known today, D-13).
16. Gemini 0.46.0 hook runtime behavior, empty-output acceptance, actual transcript path, notification correlation and profile overrides: still UNVERIFIED, not run because Google rejected personal sign-in (D-P0-19). Profile override source-read only (`GEMINI_CLI_HOME` read inconsistently). EC-80/81/90 (Gates 2, 6).
17. Gemini 0.46.0, still UNVERIFIED (not run, D-P0-19): folding, subagent/tool-output completeness, token semantics, retention execution, effective-value resolution and system-policy precedence, native resume (resume disabled with reason). Source-read only, not runtime-verified: `general.sessionRetention.{enabled (default true), maxAge (default 30d), maxCount, minRetention (default 1d)}`, format `^(\d+)([hdwm])$`, invalid config disables cleanup, age basis `lastUpdated`, runs once at startup; `maxAge` offer hidden.
18. Resolved for the decision (S3/S4, 2.1.319): native HTTP not adopted (D-P0-22). Docs: `SessionStart`/`Setup` do not support `http`, `async` is command-only, auth header from env via `allowedEnvVars`; live: every subscribed event except SessionStart arrived, end-to-end p95 15 ms, no spooling when the receiver is down, agent-visible stderr once; plugin `hooks.json` accepts `type: "http"`.
19. Resolved at spike level (S3; spike, not gate evidence; final at M16, Gate 3): Node SEA forwarder, dispatch→paint p95 49 ms, single-dispatch added wait p95 ≈33 ms; service-down and no-ack paths spool, and every fault mode including full disk is silent (0 bytes, exit 0); ack after a small SQLite commit; own deadline 100 ms − SEA startup p95. 50-way burst added wait p95 ≈276 ms misses M16, accepted (D-P0-22). No zero-overhead claim.
20. Narrowed (S12, personal profile, D-P0-24; spike, not gate evidence; proposed, owner decision at Gate 0): feasible with the §7.1 layout (writer, parser, reader workers), batch 100 rows/50 ms/1 MiB, per-file `fs.watch` + 5 s reconciliation scan. At risk: M3 import rate, M13 common-term bm25 (cold p99 593 ms). Plan scale (M13 10 GiB/200 MB, M14/EC-57, EC-87) unmeasured, deferred to an end-stage scale-up (D-P0-26). Final at Gates 1/3/4/5.
21. ACP capabilities and filesystem/terminal permission behavior per agent; generic GenAI convention versions, content/session coverage and Gemini OTLP auth support (pre-v1-A/S8).
22. Resolved at spike level (S13, 2.1.319; final at EC-28, Gate 3): SEA tee preserves stdin, stdout/stderr bytes and exit/signal, adds 0 bytes; absent original emits nothing, exits 0; capture failure leaves output unchanged; a slow statusLine is cancelled with SIGTERM, which the tee forwards; added wait p95 32.8–77.7 ms (plain `node` fails, not shipped).
23. Narrowed (S13; D-P0-27): Claude statusLine has no account identifier and no measurement-time field, so readings say "Account scope unverified" and "Source time unknown"; Codex uses a local salted hash of `creator_account_id` as an epoch marker only. Still UNVERIFIED: freshness and quota reset/history semantics across profiles and surfaces (EC-91/92; Gate 3).
24. Codex part resolved (S9, 0.160.0): `token_count` cumulative per session, cached ⊆ input, reasoning ⊆ output, `model_context_window`, `rate_limits.resets_at` in epoch seconds; `cache_write_input_tokens` relation to input untested. Gemini cache/thought/tool meanings UNVERIFIED (not run, D-P0-19). Window-size change not observed (S13). EC-93..96; Gate 2.
25. Completeness of internal category inventories, deferred definitions, buffer inputs and heuristic usefulness; no accuracy claim established (S13; EC-98; v1-B).
26. Narrowed (S12, personal profile; spike, not gate evidence; proposed, owner decision at Gate 0): ~4.3 MiB per quota stream (~68 B/row, linear); context and price tables <0.2 MB; one-day expiry 549 ms in ≤102 ms batches, loop max 1.89 ms under live load. Declared plan capacity unmeasured. Final at EC-100 (Gate 4) and EC-99 (Gate 5).

### F. Data audit commands (print aggregated counts locally; never paste output into git or chats)
```sh
# Claude transcripts and subagent files
find ~/.claude/projects -name '*.jsonl' -not -path '*/subagents/*' | wc -l
find ~/.claude/projects -path '*/subagents/*' -name '*.jsonl' | wc -l
# Codex rollouts, archived, compressed
find ~/.codex/sessions -name 'rollout-*.jsonl' | wc -l
find ~/.codex/archived_sessions -name '*.jsonl' 2>/dev/null | wc -l
find ~/.claude ~/.codex \( -name '*.jsonl.zst' \) 2>/dev/null | wc -l
# Gemini chat files (main and subagent)
find "${GEMINI_CLI_HOME:-$HOME}/.gemini/tmp" -path '*/chats/*' -type f 2>/dev/null | wc -l
# Agent versions
claude --version; codex --version; gemini --version
```
Phase 0 adds `scripts/audit-sources` printing per-entrypoint/source-kind counts, record-type histograms and unknown-record shares, aggregated only.

### G. Codex Design v1, v2 and v3 deltas (summary)
Codex's Design v1 is a delta over the `.handoff/` design v0 (which is deleted after handoff). This appendix preserves it; the PRD sections cited carry the binding wording.

| v0 section | Design v1 delta | Applied in |
|---|---|---|
| 1. Product summary | Limit "every session" to detected, readable local profiles. Distinguish shared history from verified cross-client visibility/control. Opt-in Xaibo MCP in v1; its answers can reach cloud providers. | §1.2, §2.2, US-1, P1 |
| 2. Architecture | Electron `utilityProcess` service, IPC renderer, tray lifecycle (D-1). Private socket/named pipe for hooks (D-7). Full local content, sanitized at egress. Explicit service-crash recovery and transactional checkpointing. | §7.1, §7.3, §7.4, ROB |
| 3. Status | No "idle notification => needs input". Pending permission/input requests correlated and resolved individually. Delayed events never override newer evidence. Expected long work separated from inactivity warnings. | §5.5, §6.2, §6.4 |
| 4. Control | `claude --resume <id>` (D-8). External-terminal launches remain externally controlled; launch origin alone does not establish ownership. Embedded terminal required in v1. No future native-history deletion. | FR-21..25, Q11 |
| 5. Setup | Claude local-marketplace hooks plugin first, settings fallback only when needed. Codex trust approval preserved. Previewed, default-on retention increase that never lowers a higher value. | FR-30..34, S-25 |
| 6. Storage/history | 45 days since last activity replaces Never as default; Trash 30 days; Keep and storage meter. Full content private locally. Purge covers derivative copies and prevents replay resurrection. Native resumability checked independently. | FR-11..12, EC-21..23 |
| 7. UI | Cost policy superseded by Design v3 and revised D-12/D-13. Notification privacy, keyboard access, text/icon status, resizable workspace and non-disruptive scrolling remain binding. Visual design comes from the original Xaibo design system (D-23). | §5.5, US-2, A11Y, FR-50 |
| 8. Stack | Private sockets for hooks; HTTP only for optional OTLP (superseded by revised D-7, see v2 delta below). Packaged utility service and forwarder validated separately. macOS first, Windows next, Linux last. | SEC2, S1/S3, Portability |
| 9. Releases | MCP, PTY hosting, app-server control and OTLP remain outside MVP. Claude statusLine tee moves to MVP under S-31; Codex notify remains v1-B. Optional state-DB enrichment remains deferred unless needed. | S-03, §10 |
| 10. Risks/questions | Close owner-resolved questions. Per-version, per-surface evidence instead of broad interoperability promises. New risks: MCP authorization, retention across backups/spool, hook-delivery identity. | §11, §12, App. E |

Historical decisions remain subject to later revisions: the original D-12/D-13 were revised to apply the owner’s 2026-11-09 Q16 decision and Design v3; the revised rows in App. D are binding. D-9 aligns nominal retention only. D-10 was verified by Claude. D-1 requires managed-child restart/replay; D-7 retains private framing, endpoint recovery, deadlines and protocol validation.

**MCP contract (v1, FR-40..43):** four read tools (`sessions` with filters, pagination and lifecycle/health, absorbing status; `session` summary and paged turns/tools/usage; `search` scoped FTS snippets; `usage` tokens, labeled estimated cost (`estimated: true`, basis, coverage, `as_of`, price revision) and scoped usage history) plus `control`, advertised only when enabled, with each exact resume/interrupt request confirmed in the Xaibo UI and ownership rechecked. Page size 20; 8 KiB cap measured after sanitization and serialization, including metadata/errors; progressing cursor. Agent/project grants enforced server-side on every request, including search, counts and usage. Read tools work while Xaibo is quit but return timestamped history with live status unavailable. Control uses authenticated local IPC to the running service; the MCP reader never writes SQLite.

Spike criteria: §10 (spike pass/fail table).

#### Codex Design v2 delta (Add agent / scalability / speed)
Extensibility/speed delta: Gemini observation, catalog/Add agent/local import and custom report integration are MVP scope. ACP and generic OTel remain v1. Private socket is default; native HTTP is conditional on S3 under revised D-7. Full local content applies to every agent. M1/M2 and new M11–M16 supersede earlier latency/capacity values. Gemini retention parity (D-19, EC-90) replaces the design's warn-only proposal. D-14..D-19 are accepted by Claude second review and remain pending owner approval.

#### Codex Design v3 delta — usage, context and estimated cost
Owner decisions authorize estimated session/aggregate cost and resolve Q21 to one local machine. Proposed implementation moves the separate default-off Claude statusLine tee into MVP, uses passive Codex rollouts, reports unavailable Gemini quota, and avoids the undocumented Claude account cache and active backend refresh. MVP adds usage status and history, the context usage view, Overview live-set totals and session access to files touched, transcript, cost breakdown and timeline; v1-B adds evidence-based estimated category composition and Compare extensions. Cost uses agent estimates or real consumed tokens with explicit local price revisions, never character-estimated tokens. Exact/reported/inferred/`~est`/unavailable, time/coverage, compaction, shared quotas and overlapping cost scopes remain explicit. No new dependency, service, top-level workspace or success metric is introduced. Claude second review accepted the delta and, per the owner's original-design decision (D-23), restated layout-prescriptive wording as capabilities and added the Xaibo design system (S-34, FR-50) with a Codex-led Design step and Gate D before Phase 4. Owner approval remains required.
