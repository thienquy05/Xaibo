# Xaibo design delta 3 — Missions

## 1. Summary and approval boundary

- **Status: proposed, 2026-11-25.** Codex design → Claude second review → owner approval before implementation. PRD v1.4 remains a draft; v1.3 and the approved design remain binding. This document neither approves the PRD nor changes MVP navigation.
- **Twelve proposals: 10 must, 2 should, 0 could.** All implementation belongs to **v1-M**, after MVP, subject to S18 qualification and Gate M. D-PD-01's four destinations remain the MVP baseline; DD3-01 explicitly proposes its post-MVP fifth destination.
- Inputs: [binding design](xaibo-design.md) §§2, 5, 6.0–6.2, 6.6, 6.12–6.13, 7, 8, 10; [PRD draft](../PRD.md) FR-60..72, MIS1..7, M22, EC-133/134 and Q35..39. Historical delta 1/2 proposal-table format was read from git history; their current rules are folded into the binding design.
- **Only design lens: UI UX Pro Max.** Local design-system, UX and HTML stack searches support flat design, consistency, form labels, focus states, keyboard navigation, error recovery, loading feedback and reflow. Its cyan palette, web fonts, marketing layout, longer animations and library suggestions yield to Xaibo's approved tokens, system fonts and process. No new dependency or external asset.
- The centrepiece is a factual morning report: **what merged, what still needs you, what was assumed, and what it cost or could not measure**. Lead prose supplements journal facts; it cannot certify completion or hide missing evidence.
- Deliverables are this proposal and [the static review mock](../../.handoff/missions-mock.html). No binding-design, plan, progress, source, config or git changes. No mission execution, real data or model calls. The mock's theme switch is review-only; production appearance still follows macOS.

### Step 0 — PRD fix re-check

**approve — no must-fix findings in the three requested passages.** Reviewed `git diff 9ff89fc~1 9ff89fc -- docs/PRD.md`, limited to SEC6's mission clause, MIS2's last sentence and the App. G v1.4 review record, with FR-65/MIS4 as context. SEC6 now permits only digest-approved check commands under a live grant, through the external mission verifier outside author control, network-off and contained, with approve-run disclosure. MIS2 agrees; App. G accurately records Claude's finding and the pending re-check. This resolves the textual contradiction without approving runtime containment or the whole draft. **No PRD edit.**

## 2. Proposals

“Current” describes the binding design, not an observed implementation defect. New section names below are proposed insertions under §6.12, not edits to that file. “Must” means required before the affected surface ships, not permission to build now.

| ID | Design § | Current | Proposed change | Why (UI UX Pro Max rule) | Tokens / §8.2? | Priority | Implementation phase |
|---|---|---|---|---|---|---|---|
| DD3-01 | §1.2, §5.3, §6.0, §6.2, §6.12 | Four destinations; attention is session-oriented. | Append **Missions** as destination five; add owner-needed mission items and running mission summaries to Dashboard attention, with Report/task deep links and return anchors. | consistency, keyboard-nav, horizontal-scroll | No; existing nav/list/banner pairs. | must | v1-M |
| DD3-02 | §5.1, §5.2, §6.12 Missions list, §7 | No mission inventory. | Paged mission records: state, exact outcome progress, needs-you count, token and estimated-cost thresholds with coverage. Search/state filters; no fabricated completion percentage. | form-labels, data-table, error-feedback | No; existing record/meter pairs. | must | v1-M |
| DD3-03 | §5.1, §6.12 Mission Report, §7 | No report or run outcome surface. | **Report is the landing section**, including while running. Lead with merged outcomes and owner decisions; retain all FR-70 sections and atomic-checkpoint/write-failure status. | consistency, line-length, error-recovery, color-contrast | No; existing headings/facts/tables/disclosures. | must | v1-M |
| DD3-04 | §5.1–5.3, §6.12 Tasks | No DAG task view. | Read-only board by state; cards expose author, different reviewer family, tier and revision-bound evidence; textual dependency hints and a labeled record fallback. | keyboard-nav, horizontal-scroll, color-guidance | No; proposed composition C3, existing pairs. | must | v1-M |
| DD3-05 | §5.2–5.4, §6.3, §6.12 Mission detail | Session exists; no mission workers/artifacts/audit. | Report / Tasks / Workers / Plan/PRD / Audit selector; sessions open existing Session, artifacts render safely read-only, audit pages link local evidence. | consistency, keyboard-nav, error-recovery | No; existing selector/table/plain-text viewer. | must | v1-M |
| DD3-06 | §5.1, §5.4, §6.12 Approve run | Generic confirmation, no bounded-run review. | One approve-run sheet for exact artifacts, defaults, effective authority, all execution/egress channels, limits and worst case; one primary **Approve this run** action, disabled with explicit lock reasons. | form-labels, error-feedback, loading-buttons | No; proposed composition C4, existing dialog pairs. | must | v1-M |
| DD3-07 | §5.1, §5.3–5.4, §6.0, §6.12 | Collection band, no persistent run control. | Run strip with scoped **Stop** everywhere during a run; persistent mission/run Stop even on other detail sections. Immediate revocation; pending, stopped, uncertain and failed-stop evidence. | visibility through feedback, keyboard-nav, focus-states, error-recovery | No; proposed composition C1, existing danger-on-neutral. | must | v1-M |
| DD3-08 | §5.1, §6.6 Autonomy | No autonomy configuration. | Cautious/Balanced/Overnight with Q35 values; plain effective-policy summary; mission overrides may only narrow and show inherited ceilings. | form-labels, consistency, error-feedback | No; proposed composition C5, native radios/fields. | must | v1-M |
| DD3-09 | §5.1, §6.6 Autonomy Advanced | No routing, lockdown or merge-tier form. | Advanced sections for agents/routing, S18 lockdown, MCP/plugins, limits, checks, sensitive paths, escalation and merge targets; validation beside each field; no raw JSON. | form-labels, error-feedback, keyboard-nav | No; C5 reuses disclosure/table/fields. | must | v1-M |
| DD3-10 | §5.3–5.4, §6.6 | One long Settings column. | Group existing sections under a left index and label search, retaining per-section Save, every existing setting and current appearance policy. | consistency, keyboard-nav, horizontal-scroll | No; proposed composition C6, existing links/search. | should | v1-M |
| DD3-11 | §2.4, §5.1–5.4, §6.13, §8.1–8.3 | State and accessibility contracts cover existing surfaces. | Extend explicit state matrix to every Missions surface; protect Stop, freshness, focus, bounded pages, narrow layout, text scaling and both themes. | focus-states, color-contrast, error-messages, reduced-motion | No new pairs; reused-pair checks in §7. | must | v1-M |
| DD3-12 | §6.12 Mission Report, §8.3, §9 | No Missions review fixture. | Static synthetic preview of all requested screens in both themes, with complete and locked approval examples and a state gallery. Use report review as the first owner design checkpoint. | consistency, data-table, error-recovery | No; review-only theme selector. | should | v1-M |

## 3. Frame, Dashboard and mission inventory

**Navigation.** Preserve order **Dashboard, Session, Agent Map, Settings**, then append **Missions**. Keep the 184 px rail at ≥1200 content px and wrapping text navigation below it; no shrinking, icon-only navigation or hamburger. Missions is an independent destination, not inside Session. Current destination uses existing selection semantics. Returning from a mission opened through Dashboard restores the exact queue invoker, filters and scroll; if gone, following/previous record, then attention heading. The Missions destination retains its own bounded list state.

**Dashboard attention.** In Needs attention, show owner-needed items first using existing reason/severity ordering and service identities; running missions follow in a labeled **Running missions** group. A mission summary has title, run state, exact completed/total counts when known, needs-you count and last observation. Owner-needed rows name the actual action: **Review large PR**, **Resolve escalation**, **Restore spend coverage**, **Answer blocking question**, **Resume reconciled run**. A nonblocking parked default already within the grant is report information, not a new urgent decision. Deduplicate by underlying owner action; a session finding inside a mission links that task rather than inflating needs-you. Counts are service totals, not sums of loaded pages. Unknown counts say **Needs-you count unavailable**. No mission OS notifications are added.

**Persistent run strip (C1, proposed).** After the collection band, before main, show the run label, state, workers still owned, remaining wall time or unavailable reason, an **Open report** link and **Stop [run label]**. This is an opaque surface using existing banner geometry, not a toast. Multiple active runs form bounded named rows with a Stop per run; never silently scope Stop to whichever detail page happens to be open. Provide an explicit **Stop all runs** when more than one run is active. In the static mock, the strip's active run is a different synthetic mission from the finished report; their labels make the scope clear.

The frame's navigation/collection/run region remains available while main scrolls. On narrow/200% text it wraps and grows; if chrome would consume the viewport, its named scrollport keeps every control keyboard reachable, with focused controls scrolled into view. Stop is never solely in a collapsed menu or horizontal strip. Retained/stale run authority displays **Last known: [state], [time]**; loss of telemetry never disables requesting Stop. A stale countdown is replaced by its last-known absolute expiry, not a live countdown.

**Missions list.** Heading and primary **New mission** action, then search, state filter, Apply/Reset and a paged record list. State values are **Intake, Awaiting approval, Running, Paused, Done, Failed**. Run history separately records stopped, killed and recovered outcomes; do not squeeze them into an invented mission lifecycle. Done requires the service's completion contract; a finished run with an unresolved escalation is Paused or Failed, not Done. Intake model use has its own bounded consent before lead invocation (FR-60); New mission itself spends nothing.

Each record shows title/repo display label, state/reason, progress **2 of 4 tasks merged; 1 PR awaiting review; 1 blocked**, needs-you count, consumed tokens/threshold and **Estimated cost ~$18.40 known subtotal / ~$30.00 stop threshold** with coverage/time and a separate **Total unavailable** where needed. Tasks merged is not a percentage of all work done. A meter is permitted only for a fully measured named quantity/domain; partial spend gets text, no misleading percent. Intake uses **Not started**, not a zero-spend claim. Threshold absence says **Approval locked: set finite limits**. Open a record on Report; preserve list anchor on Back to missions. Use existing 50-record paging/100 cap and virtual-list bounds, never load the whole inventory to filter/count.

## 4. Mission detail: Report first

Header: Back to missions/source, mission title, mission state, selected run with absolute start/end, repo label and **Stop this run** while authority/processes may remain. A concluded run shows no Stop control, only the state line and **No run-owned processes remain** with its end time (Claude review: a disabled Stop on a finished run read as live and added noise), while another active run stays actionable in the frame. A recovered run starts **Paused — reconciliation required**, with observed remote outcome/worker ownership and an explicit Resume review under valid authority; never auto-retry a publication or start on navigation.

Use the existing wrapping, manually activated selector, named **Mission section**, in order **Report, Tasks, Workers, Plan/PRD, Audit**. Report is selected on first open and after a run ends; a background completion does not forcibly switch a section the owner is reading. Preserve section anchors on subsequent navigation. The selected run applies to every section; show its label so past and current evidence cannot be mixed.

### 4.1 Report (C2, proposed composition)

At the top show **Run finished with remaining work**, an absolute checkpoint time and freshness. Live runs say **Run in progress — checkpoint**, never final. A short factual sentence leads; optional lead synthesis is labelled **Lead summary — commentary**. Follow with:

1. **Merged**: task title, small tier, exact target, observed PR/merge outcome, current check/cross-review evidence links. Keep integration-branch merge distinct from default-branch release.
2. **Needs your review**: PRs awaiting review, large/permanently escalated tier, current/failed/unavailable checks, cross-review and **Lead notes**. Notes name risks, limitations and unverified work. Missing notes read **Incomplete — lead notes unavailable [reason]**, never an empty “approved” area.
3. **Defaults taken**: question, chosen default, why it fit the approved scope, decision reference and whether owner-accepted at intake or a nonblocking runtime default. Unanswered blocking questions remain blocked, never mixed into successful defaults.
4. **Spend and limits**: tokens and estimated dollars separately, thresholds, eligible/covered population, source/as-of, missing/partial/stale reasons, price provenance, wall time, and whether a threshold triggered. Show observed overshoot (including valid zero) and measured interruption latency, each independently unavailable when unmeasured. **Stop threshold, not a hard budget** is adjacent, not tooltip text. Missing coverage pauses under Q38 despite a smaller known subtotal.
5. **Escalations**: trigger, affected task and consequence. Clearing a badge or retrying cannot clear a permanent run merge block. Show any unauthorized/stop-failure outcome without dumping secrets or raw process output.
6. **Blocked / unresolved / remaining**: failed or parked tasks, dependency blockage, unresolved conflicts, unknown remote outcomes and remaining owner actions. Distinguish **PR opened**, **PR outcome unavailable**, **Merged** and **Verified**.
7. **Audit and report checkpoint**: local audit link, `report.md` status and timestamp. M22's final checkpoint target is within 5 s of quiescence, not a fabricated success timer. On write failure show **Report saved locally; repository checkpoint failed [safe reason]**, Retry checkpoint, and local report access. Retry only the report write, never rerun workers/publication.

The mock's finished run merged two small tasks before a later spend-coverage gap; one large PR and one permanently escalated task remain. Known spend is below threshold, but total and overshoot are unavailable. Coverage absence caused a pause; no later automatic action is implied. All numbers, repo/task labels and relative links are synthetic.

Public PR links are owner-reviewable explicit links, not repository-text autolinks or embedded previews. App-private evidence links remain local. Portable report references use opaque local locators; never embed native session identifiers, absolute home paths, raw transcripts or credentials. `report.md` is not an authority source.

### 4.2 Tasks (C3, proposed composition)

Use four state columns at wide widths: **Ready, In progress, Review, Finished / parked**; the final column groups visibly labeled Done, Blocked and Failed records, never conflating their outcomes. Intake-only tasks show Not approved. Each heading states exact total or **Loaded [n]**, with bounded Load more per group. At normal/narrow widths stack the groups in the same order; no sideways board scrolling or drag/drop. These are semantic lists with headings, not an interactive grid or graph canvas. A task opens an inline detail disclosure; it does not move state by dragging.

Every card shows **Author [family/profile or Not assigned]**, **Reviewer family [family or Unavailable — reason]**, **Tier Small/Large**, **Evidence [Current / Failed / Invalidated / Unavailable]**, and its actual state. Distinguish author self-report from verifier/check/reviewer evidence. Details bind base/head/snapshot, checked revision, command executable/arguments/cwd/timeout and observed exit, reviewer verdict/limitations, integration revision and outcome. Never display Verified from transcript text. Any later edit/target movement labels evidence Invalidated and blocks auto-merge.

Dependency hints read **Depends on: [task links]**, **Ready after [task] merges**, or **Blocked by [task + reason]**. Include downstream dependants on expansion and a bounded textual dependency list for complex DAGs; counts and edges come from the validated DAG, never inferred from card positions. No new node canvas, connecting-wire decoration or author-family colors. All task labels and file claims are untrusted plain text.

### 4.3 Workers, Plan/PRD and Audit

- **Workers:** paged live/history records for lead, author, reviewer, verifier and integrator, including owned child-tree counts where observed. Show role/family, task, lifecycle/confidence, collection health, ownership, current limits, spend coverage and observed exit. **Open session** links only an evidenced session into the existing Session view; otherwise **Session unavailable — not yet correlated**. Run role/state is distinct from inferred agent lifecycle. Session offers **Return to mission** restoring worker and section anchor. Owner takeover explicitly removes that worker from run control; the UI must not keep promising Stop will control a detached worker.
- **Plan/PRD:** read-only selection of `prd.md`, `plan.md`, `tasks.json`, `decisions.md`; Report covers `report.md`. Show reviewed revision/digest and current-on-disk mismatch. Use existing wrapped, paged, escaped plain-text viewer, not HTML/Markdown execution or a JSON editor. Structured task facts can accompany raw read-only `tasks.json`. A changed draft says **Approval expired — review changed artifacts**; previous grant is never silently rebased. File access uses reviewed mission artifacts, not arbitrary paths supplied by renderer text.
- **Audit:** bounded chronological pages with event time/offset, action/role/task, policy and artifact revision, observed result and evidence link. Filters by task/action/outcome commit on Apply. A denied attempt, missing evidence, unknown mutation and stop failure remain explicit; no “success” from missing output. Preserve cursor/anchor. Private raw output is not copied into the portable report. Audit is read-only, without raw command replay buttons.

## 5. Approve-run sheet and Stop

### 5.1 Approve run (C4, proposed composition)

The only primary action is **Approve this run**. Cancel and links for correcting questions/policy are secondary; no separate Start that ambiguously reuses consent. Approval binds exactly one current reviewed revision and effective policy and then starts that authorized run. Previewing, saving Settings, closing the sheet or pressing Return in another field never starts workers.

Reuse the native modal dialog: width `min(640px, viewport minus 32px)`, bounded body scroll, visible wrapping title/footer, transparent backdrop and no shadow. The static mock shows the sheet as an in-flow review specimen, **not** a fake modal; production must use `showModal()` with inert background, described controls and existing restoration. Focus starts on the sheet heading so scope is read before the action. Escape/Cancel before submission returns to its invoker; failed submission focuses the first invalid question/limit. Pending approval disables duplicate submission and reconciles uncertain outcomes before any retry, with Close on lost result per §5.1 of the binding design.

Required sections in this order:

| Section | Visible review content |
|---|---|
| Scope | Repo/display root, exact artifact revision/digest and approved task count, acceptance summary, claimed areas, worktree template/base, excluded areas, remote identity and exact merge target/branch creation if granted. Detailed digest/command arrays use disclosure, never only a tooltip. |
| Questions and defaults | Every open question marked blocking/nonblocking; every intake blocking default individually accepted or answered before unlocking. Show accepted decision and consequence. Runtime defaults restricted to nonblocking in-scope choices. No bulk “accept all” shortcut for unresolved authority. |
| Effective policy | Plain **Tonight agents may… / may not…** derived from the actual intersection of settings and narrowing overrides. Display inherited ceiling and any narrowing. No optimistic prose beside a more permissive hidden policy. |
| Models and data movement | Selected profiles/families/providers/model routing and bounded lead synthesis; external agents consume tokens and send approved repo context to their configured providers. Xaibo scheduler/supervisor/reporting remain network-off and make no model calls. Provider transport, research web domains, MCP/plugin operations and publication each get separate lines, including **None** where denied. |
| Check execution | Explicit approved check executable/argument arrays, working directory and timeout, including additive policy security/performance checks. **Untrusted repository checks execute in a contained external mission verifier, network off; setup/install commands do not run.** Qualification missing means disabled, not bypass flags. |
| Limits | Preset, workers, finite token and estimated-dollar thresholds, wall time/absolute expiry, task/integrator turns/time, retry/review rounds, spend grace and stop grace, required checks, sensitive paths, merge tiers and target. Explicitly include delegated children, verifier/review/integration and final lead notes in caps. |
| Worst case | Thresholds can overshoot due to delayed/partial measurement and interruption. Show known current spend/coverage; never invent a maximum dollar loss. **Worst-case spend unavailable; thresholds are not hard budgets.** Publication already accepted remotely cannot be undone by Stop; reviewed scope can reach approved providers/hosts. On expiry/revocation/threshold/spend pause, new actions stop and run-owned trees are interrupted. |

Locked state has a persistent **Approval locked** banner and adjacent disabled-action explanation listing concrete blockers: unresolved blocking question/default, missing finite threshold, changed artifacts, invalid DAG/claims, unqualified execution/containment, missing required evidence or unsupported permission. Missing cross-family review specifically disables **automatic merge** (Q39); PR-only can proceed only if all its own contracts qualify. Do not silently change a Balanced grant to PR-only; show the narrowed policy for review.

### 5.2 Stop semantics

**Stop this run** acts immediately without a confirm dialog: revoke authority, refuse new/queued dispatch and publication, interrupt still-owned process trees. The owner-approved run contract already describes this reversible control; a second confirmation would delay it. Stop does not erase artifacts, undo merged commits, delete worktrees, or interrupt workers already taken over by the owner. Multiple-run Stop all explicitly names its scope.

Retain the control/status while stopping: **Stopping — authority revoked; waiting for [observed count] process trees**, then **Stopped — observed [latency]**, or **Stop failed — [observed remaining or unavailable]; publication blocked**. M20's 5 s target is proposed, not a proven guarantee. Never show Stopped from a timeout or lost connection alone. Unknown outcome says **Stop result unavailable — authority revocation/remaining processes not confirmed**; retain an idempotent Stop request and explicit recovery/audit path rather than indefinite spinner or false success. Announce a failure once urgently, normal transitions politely. After Stop removes a strip, restore focus to the surviving report/status heading; never leave it on the document body.

## 6. Settings → Autonomy

### 6.1 Settings index (C6, proposed composition)

Use a labeled **Search settings** field followed by a left index at ≥800 content px and one main section pane (existing 880 px content measure). Index groups: **History and storage** (Session retention, Trash, Storage, Usage history), **Agents and autonomy** (Autonomy), **Usage and prices** (Local prices, Owner-set fallback), **App** (Appearance, Startup, Status thresholds, Notifications). Keep every current section/action and its independent Save. This is an index inside Settings, not more global destinations.

Search matches setting labels/help text locally, never repo/session content or a model. Enter commits the query; results are named links with section context and exact result count or unavailable reason. Clearing restores the previous index/anchor. **No settings match** retains query, offers Clear search. Navigating to a result focuses its section heading; preserve dirty fields, warn before discarding on section changes, and never auto-save. Narrow stacks the index/search above content; all groups remain accessible. Index selection uses current-location semantics and word labels, no raw key names.

### 6.2 Presets and narrowing policy (C5, proposed composition)

| Preset | One-line summary shown on the card/radio |
|---|---|
| Cautious | **1 worker · 1 h · PR only.** |
| Balanced (initial selection) | **2 workers · 2 h · small auto-merge to integration branch.** |
| Overnight | **2 workers · 8 h · small auto-merge to integration branch.** |

Immediately below: **Set finite consumed-token and estimated-dollar stop thresholds before first planning/run consent. Presets do not supply a dollar budget.** Empty values stay empty and lock consent; the mock's 120,000 tokens / ~$30.00 are explicitly synthetic owner-entered values, not new defaults. Changing a radio previews the resulting fields/permissions and remains unsaved until **Save Autonomy**. Settings save never starts a mission. Loosening applies only to future grants; global tightening applies immediately and shows affected-run pause consequences before Save. No active grant can inherit a relaxation.

**Per-mission overrides:** show inherited value/ceiling beside each supported override and **Can only narrow Settings** above the group. Lower concurrency/time/tokens/dollars, remove tools/domains/agents/actions, add checks/sensitive paths and force PR-only are allowed. Routing substitutions must stay in the already allowed qualified set and cannot widen role authority. A broader path/remote/target or removed required check is invalid, not silently clamped. A different repository default-branch target requires explicit owner selection/approval within the global allowed target ceiling; there is no automatic integration-branch promotion. Effective policy previews the intersection before Save/approve. Raising autonomy requires returning to Settings and a new grant; never an inline “allow anyway.”

### 6.3 Advanced, expanded in the mock

Use one **Advanced policy** disclosure with semantic subheadings and native forms/tables; retain visible summary outside it. All saved values are service-validated. No JSON editor, shell text area or speculative CLI switches.

| Group | Required form/readout |
|---|---|
| Agents and routing | Allowed qualified family/profile/executable identity/version and provider/model disclosure; routing tag → qualified author; independent different-family reviewer; lead selection. Show Not qualified/Unavailable with reason. agy stays planner-only under separate interactive consent or excluded until qualified; no family-alias loophole. |
| CLI lockdown | S18-derived read-only permission/sandbox/tool/network contract per version, qualification date/result and disabled capabilities. Claude explicit tool/permission policy; Codex workspace-write/no approval prompts/command network off only when verified. No bypass toggle or guessed flags. Verifier isolation shown separately. |
| MCP/plugins and networks | Default-denied identity/operation allowlists, role and destination, explicit provider transport, research domain list, local network-off MCP/plugin tools and separate least-privilege publication capability. Code/review/verifier shell networking remains off, no package downloads. |
| Limits | Workers, required finite token/~$ thresholds, wall time; Q37 initial values: 1 retry/task, 2 author/reviewer rounds, 30 turns/30 min per attempt, integrator 15 turns/15 min; all children and final synthesis within run caps. Q38 required spend gap 60 s, initial absence included; global stop grace at most proposed 5 s. Units and narrowing ceiling beside fields. |
| Checks and sensitive paths | Structured executable + ordered arguments + relative cwd + finite timeout rows; policy checks additive, including security and applicable performance checks. Path controls use validated repo-relative selectors and denial summaries; no executing a pasted shell string. Show conflicts and validation errors inline. |
| Tiers and finding policy | Q36 small ceiling 200 changed lines (additions + deletions), 5 files; binary/unmeasurable → large. Sensitive/dependency/lockfile/CI/security policy/test weakening/security-check failure always large; outside-claim write stops task. Lead may only downgrade autonomy. Q38 R1/R5 expected-work warning otherwise pause; R2/R3/R4 at most one retry within Q37 then escalate; escalation survives badge clearance/retry. |
| Merge and publication | Small may PR+merge only with current checks, cross-family review, valid grant and no escalation; large PR only with lead notes. Exact allowed remote/repo and pre-existing integration target (or expressly granted creation), branch protections win. Default branch explicit opt-in only; no deploy/release/force-push/deletion/install; no remote credentials in a form or artifact. |

## 7. Tokens, proposed components and §8.2 pairs

**No new tokens, token values, semantic fills, color pairs, fonts, shadows or icon families.** All compositions use existing surface/canvas/tint, ink/muted/accent/success/warning/danger, line, divider and focus aliases. Existing radii/spacing/type/z-order remain. Use danger text on neutral for Stop, surface on accent for the one primary approval action, line on neutral for meaningful boundaries. Never put white on danger, semantic text on a semantic fill, accent against ink, or add a dimmed modal overlay.

| Proposed composition | Existing construction reused | New primitive/token? |
|---|---|---|
| C1 Persistent run strip | Banner + wrapping detail facts + link + destructive text button | No; new frame placement and stop semantics. |
| C2 Mission Report | Headings + labeled facts + detail tables/records + evidence disclosures | No; new factual information hierarchy. |
| C3 Task board | Headed semantic record lists + badges + dependency links + disclosures | No; new grouped layout, no drag/drop or graph. |
| C4 Approve-run sheet | Native dialog + confirmation + fields + disclosures + one primary action | No; new consent content and binding contract. |
| C5 Autonomy policy form | Native radios/fields + detail tables + Advanced disclosure + validation | No; new configuration schema consumers. |
| C6 Settings index/search | Search field + grouped links + section headings | No; new Settings layout. |

New §8.2 rows required: **none**. All used pair types already occur in the closed inventory. Recomputed the reused text, boundary and focus pairs from the binding literals (sRGB method in §8.2); results below are token calculations, not native-widget/runtime certification.

| Reused pair minimum | Light | Dark | Required |
|---|---:|---:|---:|
| Text on canvas/surface/tint, all seven semantic foregrounds | 5.21:1 (cyan/tint) | 6.86:1 (accent/tint) | ≥4.5:1 |
| Primary surface/accent | 7.65:1 | 8.25:1 | ≥4.5:1 |
| Meaningful line on neutrals | 3.66:1 (line/tint) | 3.79:1 (line/tint) | ≥3:1 |
| Focus accent on neutrals | 6.18:1 (accent/tint) | 6.86:1 (accent/tint) | ≥3:1 |

Keep a 2 px neutral focus gap and 4 px unclipped clearance. The mock uses 44 px minimum review targets (within existing minimum-size rules), not a new global geometry token. Existing 14 px rem body remains; system UI, tabular figures, mono for code/paths only. Panel separators are decorative divider; controls use meaningful line. No animation is required. Production reduced-motion and approved loading glyph rules remain unchanged. Theme switching in the review preserves screen and focus and writes no preference.

## 8. State, keyboard and responsive acceptance

Every surface uses §6.13; no empty array alone proves “nothing happened.” Distinguish a successfully empty result from a read failure. Region loading/errors never remove frame Stop or unrelated sections. Estimates always retain **Estimated cost** and `~$`; missing values are words with reasons, never dashes or synthetic zero.

| Surface | Empty | Loading | Error / recovery | Stale | Unavailable |
|---|---|---|---|---|---|
| Dashboard missions / Missions list | No missions yet → New mission; filtered no matches → Reset filters. | Loading missions in region; retain frame, filters and previous page. | Could not load missions + Retry same cursor, preserve anchor. | Last known state/time/count; no unqualified Running. | State/progress/count/spend each has its own reason; absent threshold locks consent. |
| Report | No run yet → Review plan / bounded intake consent; never an empty successful report. | Preparing checkpoint; keep last checkpoint labeled. | Report read/write failed, local copy and Retry checkpoint where applicable. | Checkpoint as-of + connection status, not a live report. | Missing notes/checks/spend/merge outcome/overshoot individually named, remaining known facts retained. |
| Tasks / dependency detail | No approved tasks yet; validated empty draft cannot start. | Loading this state/page; no skeleton tasks. | Retry this group; retain other groups and dependency source. | Last known task/evidence revision + time; no current verification claim. | Dependency/evidence/author/reviewer missing → reason; auto-merge disabled where required. |
| Workers | No workers started, or No run-owned workers remain after observed stop. | Awaiting correlated session/ownership evidence. | Could not load workers; Stop request remains reachable. | Last known lifecycle/confidence/ownership/time, no silence-based Ended. | Session/ownership/spend independently unavailable; no blind Session link/control. |
| Plan/PRD | Artifact not created → Return to intake. | Loading selected artifact/slice. | Read failed + Retry; no replacing file with blank. | Reviewed revision versus changed disk revision, approval invalidation explicit. | Missing/unreadable/oversized/invalid artifact named, approval locked. |
| Audit | No observed events yet, not proof no external mutation. | Loading events; cursor/filters retained. | Retry same cursor; no automatic command replay. | Last received event time/collection gap. | Result/evidence missing or publication outcome unknown, not success. |
| Approve sheet | No valid draft/required limits → locked + corrective links. | Validating current artifact/policy, primary disabled with reason. | Near-field errors; lost submit result → Close, reconcile before retry. | Reviewed revision changed → re-review, no stale grant. | Required permission/qualification/coverage absent → disabled with reason. |
| Stop / run strip | No active run → no strip; ended detail explains disabled Stop. | Stopping, authority/process observations separately shown. | Stop failed or result unavailable, audit/recovery and safe idempotent Stop. | Last-known state; Stop remains available, no invented current authority. | Remaining process count/latency/overshoot unavailable separately. |
| Settings / Autonomy / overrides | Never configured → finite thresholds required; search no matches → Clear. | Loading settings; no preset inferred from absent response. | Preserve edits, near-field error or Retry read; no silent clamp/save. | Last saved policy revision; stale validation requires fresh check before Save/approve. | S18 capability/routing/limit missing → reason and affected capability disabled. |

**Keyboard/focus:** preserve Skip to main, ordinary area links, frame controls, then page order. Selector arrows move roving focus only; Enter/Space commits, no tablist retrofit. Detail controls follow reading order. All disabled controls have adjacent readable reasons; no tooltip-only explanation. Search and radio editing keys are native. Open mission → h1; opening a section preserves selector focus; explicit heading links focus their target. Worker → Session → Return to mission restores worker anchor. Collapsing Advanced with descendant focus first restores disclosure trigger. Cancel/Close restore exact invoker or existing following/previous/heading fallback. No automatic focus movement from new tasks, status or spend; coalesce polite announcements, urgent stop/containment failure once. No scrolling live content into view without request.

**Responsive:** retain frame breakpoint 1200, content breakpoint 800 and 640×560 minimum outer window. At wide widths Report's main outcomes and smaller spend/remaining panel form two columns; DOM reads outcomes before supporting details. At normal/narrow stack them. Board columns stack below 1200; tables become labeled records below 800. Settings index moves above content below 800. Approve dialog title/footer wrap and body scrolls. At 320 CSS px, 200% text and §2.4 combined text spacing, every word/action remains reachable without horizontal page scrolling; Stop cannot be clipped by chrome. Scroll controls into view with focus clearance. Readable prose ≤65ch; files/arguments wrap anywhere. Native titlebar is outside review framing.

**Bounds:** reuse §5.2 paging, 16 KiB text slices, 3 retained list pages and 4 slices/open item, focused-record protection and explicit continuations. The 256-task artifact limit is not permission to render/fetch every task/evidence blob. Board groups/audit/workers/report rows use bounded pages; service totals are independent of loaded rows. Virtual-list caching must remain bounded across sections, mission switches and Settings search.

## 9. Review mock and verification boundary

`.handoff/missions-mock.html` is one self-contained HTML document: inline CSS, system fonts, no external resources, libraries, network fetches or backend. Minimal inline JavaScript only selects preview screens and theme (including selector keyboard handling); native disclosures remain native. **Every screen says “synthetic sample data — design preview.”** Mutation controls are illustrative/disabled with a shared visible explanation. The complete and locked approval specimens are separate static states; no real consent, Stop or saved setting is simulated. Product theme continues to follow macOS; the mock theme button is not a proposal to change D7.

Review screens include Missions list; Report with two small merges, one large PR/lead notes, one parked default, one escalation and unavailable spend; Tasks; Workers; read-only Plan/PRD; Audit; Approve run; Settings → Autonomy (Balanced, Advanced expanded); and state specimens. The persistent strip remains on Settings as well. A Dashboard attention specimen demonstrates entry points.

Before v1-M UI approval, EC-133/134 and M22 must be exercised in the implemented app: journal/report agreement, killed/failed/recovered report, stale/partial spend, missing notes, checkpoint disk-full recovery, invalidated artifact, narrowing/widening rejection, global tightening, Stop while navigating, uncertain publication, focus restoration and both themes. Use the binding `_electron` baseline sizes, real-browser visual review, 320 px reflow, 200% text, text spacing and reduced motion. A static mock cannot prove process interruption, command containment, budget enforcement, persistence, remote outcomes, screen-reader behavior or performance.

**Checks performed on this draft:** 56/56 reused text/boundary/focus contrast checks pass across both themes; HTML identifiers, accessible references, all ten screen targets and synthetic labels checked; no external asset/load references; script syntax and screen/theme/manual-keyboard behavior checked with an assert-based DOM shim; scoped privacy scan clean. **Visual verification remains outstanding:** the Playwright MCP returned `MCP tool call requires approval, but approval policy is never`; installed Playwright has no bundled Chromium; installed Chrome exited with `SIGABRT` during sandboxed launch (`Target page, context or browser has been closed`). No package/browser was installed and no rendered light/dark/narrow or `_electron` result is claimed. Claude and owner should review the HTML before adoption.

## 10. Owner decisions still open

1. Approve or amend the **fifth destination after MVP**, Report-first hierarchy and six proposed compositions. Existing four-area approval is not silently changed.
2. Approve the Q35..39 proposal values and global ceiling/merge target policy with the PRD; **choose actual finite token and dollar limits** at configuration time. Synthetic preview values are not defaults or spending consent.
3. Review the mock in both themes, especially report density, persistent Stop and the expanded policy form. Claude second review and owner approval remain pending; qualification/implementation are later work.

No new feature options beyond the requested surfaces, draggable DAG, notification system, model picker catalog, visual graph, dependency, font, token or product theme preference is proposed.

## Claude second review (2026-11-25)

**approve-with-fixes.** Rendered the mock in the built-in browser at 1440×900 and 800 px, light and dark: Missions list, Report, Tasks board, Approve run and Settings → Autonomy; no console errors. Clean, flat, consistent with the approved navy/white system; the Report leads with outcomes as the owner asked; the frame-level run strip keeps Stop reachable from every screen. One fix applied: a concluded run no longer shows a disabled **Stop this run** (it rendered close to an active control); the header states the ended run instead (§4 header text, mock line updated). No other findings. Electron rendering, real keyboard traversal and text scaling remain for implementation (DD3-11).

