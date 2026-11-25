# Xaibo design delta 3 — Missions, rev 2

## 1. Status and scope

**Proposed, 2026-11-25.** Replaces rev 1 in place; rev 1 remains in git history. Owner feedback: too much scrolling, too many tabs, no clear starting point. Rev 2 starts with **Needs you**, then shows outcomes in one task list.

PRD v1.3 and the [binding design](xaibo-design.md) remain binding; PRD v1.4 is a draft. Missions remains post-MVP **v1-M**, after S18 qualification and Gate M. The fifth destination and this revision need Claude second review, then owner approval. Rev 1's review does not approve rev 2. No execution or spending consent is implied.

Scope: this file and [the synthetic mock](../../.handoff/missions-mock.html). Consumers remain the proposed frame, Dashboard, Missions and Autonomy UI, their state fixtures and accessibility checks. No source, IPC, exports, dependencies, config, PRD or other planning file changes.

## 2. Revised proposals

All rows reuse existing tokens/components; no new color pair. “Must” is a shipping requirement, not permission to implement.

| ID | Binding design | Rev 2 proposal | Priority |
|---|---|---|---|
| DD3-01 | §§5.3, 6.0–6.2 | Append Missions after the four existing destinations; Dashboard attention links to the exact mission action. | must |
| DD3-02 | §§5.2, 6.12 | Single-line mission inventory; search and state only. | must |
| DD3-03 | §6.12 | One mission page: header, four summary values, Needs you, Tasks. | must |
| DD3-04 | §§5.2, 6.12 | Merge Tasks and Workers into compact task rows with evidence disclosures. | must |
| DD3-05 | §§5.1–5.4 | Plan, PRD and Audit log open read-only views; no mission section selector. | must |
| DD3-06 | §§5.1, 5.4 | One compact approval sheet: What, Allowed, Limits; disclosures in Details. | must |
| DD3-07 | §§5.1, 6.0 | Single-line run strip everywhere; immediate scoped Stop. | must |
| DD3-08 | §6.6 | Three preset cards, two thresholds, collapsed Advanced; narrowing overrides retained. | must |
| DD3-09 | §§5.1, 6.6 | Keep all Advanced policy fields and validation; no JSON editor. | must |
| DD3-10 | §6.6 | Reuse Settings navigation; remove the proposed index/search redesign from this delta. | should |
| DD3-11 | §§2.4, 6.13, 8 | Preserve states, keyboard, reflow, bounds and both themes. | must |
| DD3-12 | §§8.3, 9 | Review simplified synthetic screens and measurable density targets. | should |

## 3. Where to start

**Frame.** Preserve Dashboard, Session, Agent Map, Settings; append Missions only after approval. Dashboard uses the existing attention queue, deduplicated by owner action. Its mission entries open the matching Needs you item or task, with a return anchor; no new notification system. Counts are service totals, never sums of loaded pages. Unknown counts say **unavailable**.

**Run strip.** One line at wide widths: **● Running · Navigation polish · 58 min left · Stop**. Mission name opens its page. Stop's accessible name includes the mission/run. Keep the collection band separate. The strip persists on every destination while authority/processes may remain; no strip for a concluded run. Multiple runs use bounded named lines with a Stop each and an explicit **Stop all**. Narrow layouts wrap; controls stay reachable in the frame's keyboard-accessible scrollport if necessary. Stale telemetry replaces the countdown with last-known expiry and observation time; requesting Stop remains available.

**Missions list.** Heading, **New mission**, search and state filter, then rows:

`Navigation polish | Paused | Needs you 3 | 2/4 merged | ~$18.40 subtotal / $30 · total unavailable`

No explanatory sub-lines, cards, meters, worker counts or second token metric. Spend retains coverage/uncertainty words; its observation/source is available in the row's evidence disclosure, with stale/partial qualification visible. Names can expand in place. Search commits on Enter, state on explicit selection; clearing restores the list anchor. This is a proposed exception to §5.1's Apply/Reset filter group, avoiding two extra buttons for two controls. States remain Intake, Awaiting approval, Running, Paused, Done, Failed. Not started is not zero spend. Opening a row lands on Needs you; Back restores query/filter/cursor/focus. New mission spends nothing; intake model use needs separate bounded consent.

## 4. One mission page

No section tabs, kanban, separate Workers view or report panels. Stable order:

1. **Header:** mission name, state chip, **Plan**, **PRD**, **Audit log** in one row; **Stop** only for a live/unresolved run. Back link and selected-run checkpoint/time qualify the page. Changing historical run uses a read-only disclosure, not a permanent tab bar.
2. **Summary:** **Merged**, **Needs you**, **Blocked**, **Spend**. Four values only; spend is `~$x / $y`, explicitly **subtotal / total unavailable** when partial. No inferred percentages. Source/coverage words remain adjacent; the common checkpoint supplies as-of time. **Spend details** contains tokens, exact coverage, price provenance, limits, overshoot and latency. Unknown fields retain a reason. Thresholds are not hard budgets.
3. **Needs you:** actual owner decisions, one line and one action each. Use **Review PR**, **Answer question**, **Resolve escalation**, **Accept default**. A price gap uses **Restore coverage**, rather than inventing an escalation. Defaults are accepted individually. Successfully empty says **Nothing needs you.** Loading or failure cannot say this. A collapsed **Run details** beneath the list holds checkpoint, remaining-work and run-wide facts; informative facts do not increase the count.
4. **Tasks:** one compact semantic list, in stable approved dependency order. Each row shows name, state, **author → reviewer**, tier and evidence mark with text (**Current**, **Failed**, **Invalidated**, **unavailable**). A live worker adds **Running · Open session** inline. Expansion reveals checks, review verdict, lead notes, dependencies/dependants and worker evidence. Do not reorder rows as events arrive.

Merged details name the exact target and observed PR/merge result. Checks bind command/arguments/cwd/timeout, attempt, base/head, complete snapshot, order and exit status; review binds the exact integrated diff and distinct family. Later edits/target movement invalidate evidence. No transcript-derived “Verified”; missing large-task notes say **Lead notes unavailable** plus reason. Escalation is permanent for that run even after retry/badge clearance. An incomplete/unresolved PR never appears merged.

Worker details retain role/profile/family, model when observed, lifecycle/confidence, health, ownership/children, limits, spend and exit. Run state is separate from inferred session state. **Open session** requires correlation; otherwise **Session unavailable** plus reason. Session returns to the exact task anchor. Lead/verifier/integrator history is under Run details, so taskless roles are retained without fabricated task rows. Takeover removes that worker from run control explicitly.

Plan opens bounded read-only plan/task/decision facts; PRD opens acceptance/scope. Audit opens bounded chronological events and local evidence. These are temporary read-only views with **Close**, not another section system. Render escaped text/structured fields, no raw JSON presentation or editing, active repository HTML or command replay. Show reviewed versus on-disk revision; changed artifacts expire approval. Public PR links are explicit reviewed destinations; portable evidence references are opaque local locators, never native session IDs, transcripts or home paths.

**Canonical finished sample unchanged:** Navigation polish is Paused; the run ended with two small merges to `mission/integration`, one large PR with lead notes and one security-check escalation. Sentence-case wording was an in-scope runtime default. Tokens 72,000/120,000; known cost ~$18.40 against $30; 5/6 records priced, one reviewer price missing; total and overshoot unavailable. Wall time 1 h 20 min/2 h; interruption 1.2 s; no unresolved conflict or uncertain publication observed. Final observation 2030-04-18 06:20:00 UTC+00:00; atomic report checkpoint 06:20:02. Three owner actions include restoring coverage before resume. Running preview is an earlier checkpoint of these same tasks, explicitly synthetic.

## 5. Approve run

Keep the binding native dialog width `min(640px, viewport − 32px)`, transparent backdrop, no shadow, inert background and focus restoration. The mock is an in-flow specimen. Production has a Close control, Escape before submission, and one primary **Approve run** button; no separate Start. Heading receives initial review focus. Only explicit activation grants one run against the exact reviewed artifacts/effective policy; Enter elsewhere, closing, saving or navigation grants nothing.

Three blocks, no introductory policy paragraphs:

- **What:** one sentence plus task count.
- **Allowed:** up to four short **May** bullets and four **Won't** bullets, reflecting actual effective authority.
- **Limits:** workers, wall time, consumed tokens, `~$` stop threshold and exact merge target.

One collapsed **Details** follows Limits. It remains part of the sheet and accessible before approval; it is never fetched only after consent. A short visible helper warns **Thresholds may overshoot; worst-case spend unavailable.** Details contains:

| Disclosure | Required content |
|---|---|
| Binding | Repo/remote identity; artifact and policy revisions/digests; acceptance/claims/exclusions; worktree base/root/template; exact target/creation permission; expiry. |
| Questions | Every unresolved/defaulted question, blocking status, individually accepted intake default and consequences; no bulk acceptance. |
| Data movement | Selected profiles, executable versions, models/providers and final lead work; provider context transport, command networking, research domains, MCP/plugin identities/operations/destinations and publication capability separately, including None. Xaibo helpers stay network/model-free. |
| Checks | Explicit executable/ordered argument/cwd/timeout rows; additive security/performance checks; contained external verifier outside author control, network off; S18 qualification. No setup/install. |
| Remaining limits | Retry/review/turn/integrator bounds, sensitive paths, tiers, spend grace, stop grace; all children/reviews/final synthesis share run caps. |
| Consequences | Known spend/coverage, delayed measurement/overshoot, no guaranteed maximum loss; Stop cannot undo accepted publication; expiry/revocation/pause refuse new work and interrupt owned trees. |

**Locked:** one reason line beside the disabled action; resolve blockers one at a time, with the complete list in Details. Missing cross-family review disables automatic merge; PR-only needs an explicitly reviewed narrowing and qualified execution, never silent fallback. Validating/submitting disables duplicates. Unknown submit outcome provides Close and reconciliation before retry, never a second grant.

**Stop** takes effect immediately without confirmation: revoke authority, invalidate queued actions/publication, interrupt owned trees. Never delete artifacts or undo publication. Keep Stopping, observed remaining trees, measured latency, Stop failed or **Stop result unavailable** explicit; timeout is not proof of Stopped. Retain an idempotent request/recovery path and local audit. The proposed 5 s target is not a guarantee. If the strip disappears, restore focus to surviving mission status.

## 6. Settings → Autonomy

Three native radio cards, each one line:

- **Cautious:** 1 worker · 1 h · PR only.
- **Balanced:** 2 workers · 2 h · Small merges.
- **Overnight:** 2 workers · 8 h · Small merges.

Then **Token threshold**, **Cost threshold**, then collapsed **Advanced**, then Save. One helper sentence per field, no policy essay. Balanced initially selected; presets supply no token/dollar budget. Empty finite thresholds lock planning/run consent; sample 120,000/~$30 are owner-entered synthetic values, not defaults. Save never starts a run; loosening affects future grants only, tightening immediately affects/pauses active work with consequences shown before Save.

Advanced preserves qualified agents/routing/provider models; S18 CLI lockdown; MCP/plugin/network allowlists; all limits/checks; sensitive paths; finding/escalation policy; merge tiers/remote/target. Q35..39 values remain: small ≤200 changed lines/5 files; 1 retry, 2 review rounds, 30 turns/30 min per attempt, integrator 15 turns/15 min, spend grace 60 s including initial absence. Mandatory escalation, no same-family merge fallback, unqualified capabilities disabled and agy execution excluded until qualified remain unchanged. Structured check fields, never shell fragments/JSON.

Per-mission **Limits** disclosure shows inherited ceilings beside overrides: only lower limits, remove permissions, add checks/denials or force PR-only. Reject widening with an inline reason, never clamp silently. Effective policy is the intersection. No new remote/default-branch permission through an override. Keep existing Settings sections and per-section saving.

## 7. Tokens, states and acceptance

Primary labels use at most three words; each block has at most one short helper sentence. Data titles and necessary uncertainty reasons remain complete; longer explanations belong in Details or Learn more.

No new colors/pairs/fonts/shadows/icons. Reuse binding §2 literals, 14/22 px body, 13/20 metadata, existing 36 px controls, ≥32 px targets, 184 px rail, spacing/radii, 2 px focus ring/gap. Compact mission/task rows propose a 64 px minimum, growing with content, instead of the generic 104 px record minimum. No truncation of uncertainty, invisible evidence or tooltip-only reasons. Color supplements words; Stop is danger text on neutral. Reused contrast minima: text **5.21/6.86**, primary **7.65/8.25**, line **3.66/3.79**, focus **6.18/6.86** light/dark. No §8.2 addition.

| Surface | Empty/loading/error | Stale/unavailable |
|---|---|---|
| Inventory/attention | Empty vs no matches; retain filters/anchor while loading; Retry same page. | Last-known timestamp, independently unavailable count/progress/spend. |
| Mission/tasks/workers | Nothing needs you only after successful read; no approved tasks; region-local loading/Retry. | Evidence/notes/dependencies/session/ownership each retain reason; no silence-based completion. |
| Artifacts/audit | Not created vs read failure; Retry, never blank overwrite/replay. | Revision mismatch locks consent; unknown publication remains unknown. |
| Approval/settings | Missing limits lock; retain edits/errors; uncertain submit reconciles. | Capability unavailable disables it; stale policy requires validation. |
| Checkpoint/Stop | Local report + **Retry checkpoint** on write failure; retry only write. | Stopping/failed/unknown remain explicit; Stop survives collection loss. |

Native disclosure Enter/Space; Escape closes nearest disclosure and restores its trigger. Tab follows reading order; no mission selector/arrow-key mode. Skip to main; exact invoker/row restoration with next/previous/heading fallback. No live-update focus theft. Errors associated to fields; urgent containment/Stop failures announced once, ordinary changes politely. Native modal Close/Escape/transaction rules remain. Theme preserves focus/geometry; production follows macOS, review-only selector persists nothing.

Keep 1200/800 breakpoints, 640×560 minimum outer window; 320 CSS px reflow, 200% text and binding combined text-spacing overrides remain fully usable. At narrow widths rows become labeled records, cards stack and chrome wraps. Never force a desktop height or clip content to pass density. Reduced motion disables transitions. Reuse 50-record pages/100 cap, 3 retained pages, 16 KiB slices/4 per open item and focused-record protection. Task/artifact limits do not permit unbounded rendering.

**Checkable targets:** at a 1440×900 CSS viewport, default text, both themes, Details/rows collapsed, including review harness and live strip: mission page through first five task rows for ≤8 tasks and ≤3 owner actions; all four rows in the canonical sample; approval heading through Approve run with no body/page scroll; inventory ≥8 complete rows. More decisions, expanded details, long data and scaled/narrow views scroll naturally; no truncation to force a pass.

Mock uses native [HTML disclosures](https://developer.chrome.com/docs/modern-web-guidance/guides/html/html#5-disclosures-details-and-summary), system fonts and no external assets, persistence or execution. Harness selector is explicitly outside product UI; every screen says **synthetic sample data — design preview**. Runtime containment, budgets, persistence, remote outcomes and screen-reader behavior require implemented-app qualification.

**Rev 2 checks:** scoped privacy scan and `git diff --check` pass; 56 reused contrast pairs pass against the binding palette. HTML IDs/references, native summary structure, nine harness states, both theme events, live-strip persistence, locks, task/view links, disclosure restoration and filters pass static/assert-based DOM checks. Prose is more than 50% shorter than rev 1; static mock text is more than 60% shorter.

**Rendered checks blocked:** Playwright and Chrome DevTools actions returned `MCP tool call requires approval, but approval policy is never`; the in-app browser host is unavailable. Isolated local Chrome exited `SIGABRT`. No rendered fit, visual light/dark, narrow/text-scaling, real keyboard/screen-reader or `_electron` pass is claimed. The density targets above remain unverified; Claude review and owner approval are pending. No package/browser installed.

## 8. Removed, mapped and wording changes

**Removed/merged:** five mission section tabs → one page; board + Workers → task rows; seven report panels → summary, owner actions and disclosures; verbose inventory → one-line rows; long approval → three blocks + Details; expanded policy → collapsed Advanced; Settings index/search redesign removed. No new token, dependency, graph or notification feature.

| FR-70 fact | Rev 2 location |
|---|---|
| Merged and where | Merged value + task details/target/outcome. |
| PRs, checks, cross-review, lead notes | Review PR action + matching task expansion. |
| Questions/defaults | Owner actions for blocking items; task decisions/Run details for defaults already taken. |
| Tokens/~$, thresholds, coverage/overshoot/unavailable | Spend value/qualification + Spend details. |
| Escalations, failed/blocked tasks, conflicts, Stop failures | Needs you + state/evidence/details; run-wide failures in Run details. |
| Remaining work/audit | Needs you + dependencies; Audit log in header. |
| Atomic report/checkpoint failure | Run details: saved time, local copy, Retry checkpoint with safe reason. |
| Journal/private evidence | Observed row facts, local evidence; bounded optional lead commentary cannot certify facts. |

| FR-71 requirement | Rev 2 coverage |
|---|---|
| Missions/mission landing | Fifth destination + Needs you first on one mission page. |
| One approval with disclosures | What/Allowed/Limits + preloaded Details, same binding. |
| Kill access everywhere | Header Stop while live + persistent scoped run strip. |
| Presets/Advanced/narrowing | Autonomy cards/fields, Advanced and mission Limits. |
| No JSON; honest disabled/states/A11Y | Structured readouts; reasons, estimates/unavailable; §7. |
| Design approval/post-MVP | §1; Claude second review then owner, no MVP IA change. |

Minimal PRD edits (applied by Claude to the v1.4 draft, 2026-11-25, together with the matching S-45 and M22 wording):

| Location | Replace only |
|---|---|
| FR-70 opening | “Report is the first mission view after a run” → “The mission page starts with Needs you and summarizes run outcomes”; keep atomic `report.md` and all fact requirements. |
| FR-71 | “Report-first mission view” → “one mission page with summary, Needs you and compact tasks”; add “disclosures may be collapsed in Details on the approve-run sheet.” |
| EC-133 | “Report-first UI” → “mission page”; “all FR-70 sections” → “all FR-70 facts”. |
| D-43 | “Report-first view” → “one mission page starting with Needs you”. |

No permission, evidence, reporting or safety requirement needs weakening. Binding-design adoption must record the compact row height and two-control filter exception above. All approval/disclosure obligations remain on the sheet.

## Claude second review, rev 2 (2026-11-25)

**approve.** Rendered in the built-in browser at 1440×900, light and dark, with no console errors. The finished and running mission pages, the Missions list (8 rows), Approve run and Autonomy all fit without scrolling. The mission page now starts with **Needs you** and one button per item. Tasks and workers share one list, and the five section tabs are gone. Rev 1's finding (Stop on a concluded run) holds: Stop shows only while a run is live. One note for implementation, not blocking: the Advanced block still uses spec shorthand (S18, R1/R5, "verifier isolation"). When it is built, render it as one label/value row per setting in plain words, and keep the spec references behind Learn more.

