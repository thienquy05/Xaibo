# Xaibo design delta 2 — modern observation desk

## 1. Summary

- **Status: rev 3, approved by the owner 2026-11-14, applied.** Replaces rev 2 in full. Owner direction in the rev 3 brief (2026-11-14): choose and refine logo A; keep that mark pixel-art; make the rest modern and normal, especially removing shadow boxes.
- **Seven items: 5 must, 2 should.** Codex design → Claude review → owner approval. The owner approved the rev 3 mock on 2026-11-14; the apply brief authorizes binding-design and Phase 4 renderer application. Claude implementation review and runtime checks follow.
- Application scope: binding design, existing Phase 4 renderer presentation, pure chart geometry and focused tests. No PRD, plan, service, IPC, config, dependencies, fonts or git-state changes. Agent Map and Settings remain later-phase designs.
- Viewed `.handoff/1.png` and `2.png` again. Use only their layout: leading nav, four tiles, large plot plus gauge, lower panels; repository root, worktree count nodes, curved session fan-out, selected detail. All colors, icon geometry, typography and branding remain Xaibo’s.
- **Sole design tool: UI UX Pro Max**, local design-system + chart + html-tailwind searches. Apply its color-contrast, focus-states, keyboard-nav, chart-type, data-table, consistency and reduced-motion rules. Its web fonts, libraries, marketing journey, gradients and shadow advice yield to the explicit brief. No design-tool network call, package install, external asset or image generation.
- The review mock shows original A vs refined A at **96, 32 and 24 px in both themes**, then Dashboard, Session, Agent Map and Settings in **each** theme. Every screen labels synthetic sample data and static design-preview controls. These previews are not shipped functionality.

## 2. Proposals

“Current” names the superseded rev 2 proposal where appropriate. Listed design sections are the applied design checklist; later-phase implementations remain deferred. No later-phase feature is brought forward.

| ID | Design § | Current | Proposed change | Why (UI UX Pro Max rule) | Tokens / §8.2? | Priority | Implementation phase |
|---|---|---|---|---|---|---|---|
| DD2-01 | §1.1, §2.1–2.4, §8.2, §10.1 | Pixel desk, stepped edges, hard feet/shadows, mono display type. | Modern flat navy/white system themes; 8 px controls / 12 px panels; tonal surfaces and subtle decorative 1 px separators; system UI text and plain Xaibo wordmark. No shadows on cards or panels. | consistency, color-contrast, readable-font-size | Yes, §3 | must | Phase 4 after approval |
| DD2-02 | §5.3, §6.0, §8.1 | Pixel lockup and framed rail/top band. | Refined pixel mark + plain text Xaibo; 184 px leading rail at ≥1200, wrapping ordinary nav below; persistent collection band. Only shipped areas appear in app. | keyboard-nav, focus-states, horizontal-scroll | Uses §3 | should | Phase 4 frame |
| DD2-03 | §6.1–6.1.1, §7.1, §8.1 | Block plots and segmented quota gauge. | Four fact tiles with slim categorical microcharts; large observed-quota line/translucent-area panel and continuous arc gauge in Usage and history; lower current-state, Agents and monthly regions. Keep honest source/coverage rules below. | chart-type, data-table, color-guidance | Uses §3 | must | Phase 4 presentation; monthly ledger Phase 5 |
| DD2-04 | §5.1 Hierarchy outline, §6.5–6.5.1, §8.1 | Text-outline restriction; rev 2 stepped nodes. | Rounded repository → worktree count nodes → session leaves, smooth decorative connectors, right detail. Retain one semantic tree, all paging/virtualization and keyboard rules. | keyboard-nav, consistency, horizontal-scroll | Uses §3 | should | Design only; Phases 5–6 |
| DD2-05 | §1.1, §4–4.1, §6.0, §6.10 | Three logo choices, pixel wordmark/icons. | Owner-selected A, calibrated on 16×16 rect grid. It is the only pixel element. All status/nav/action icons become simple round-stroke hand-written vectors with unchanged meanings and labels. No pixel wordmark. | consistency, no-emoji-icons, aria-labels | Uses §3 | must | Phase 4 icons; tray separately reviewed |
| DD2-06 | §2.3–2.4, §5.1–5.4, §8.1–8.3 | Existing AA/behavior floor. | Fully visible 2 px focus + 2 px neutral gap, words with status, opaque states, exact chart alternatives, text-spacing/200%/320 px reflow and reduced motion. Preserve all behavior and selector contracts. | color-contrast, focus-states, reduced-motion, data-table | Yes, §3 | must | Every affected phase |
| DD2-07 | §2.3, §6.0, §10.1 | Optional checker trim/arcade ornament. | Remove checker trim, bevels, stepped corners, pixel icons, block charts and hard/offset/drop shadows. No replacement ornament. Logo pixels alone remain. | consistency, reduced-motion | Removes obsolete uses | must | All affected surfaces after approval |

### 2.1 Modern geometry, type, frame and motion

Use opaque canvas/surface/tint backgrounds, 4 px spacing base, 24 px panel gaps and main gutters (16 px narrow). Controls have 8 px corners, panels 12 px, small status labels 6 px. Panels are separated by tonal contrast and headings; a decorative 1 px divider may reinforce grouping. Controls/selection/meaningful chart boundaries retain the ≥3:1 line/accent ink. No hard/offset shadows, drop-shadow cards, stepped clip paths, bevels, checker strips, textures, glow or gradients. Default panel/card shadow is **none**. Menus/dialogs may remain shadowless too; this mock uses no elevation.

System UI for body, headings, navigation, labels and values: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Mono only for code and paths; tabular numerals for aligned quantities, without changing them to a pixel display. Type: 13 px metadata, 14 px body/controls, 18 px sections, 28 px page titles, 28 px facts; rem-based production values grow with text scaling. Readable body measure remains ≤65ch where DD1-07 has passed visual comparison. No web font, font file or remote icon set. Metadata and chart/eyebrow captions retain the approved 13 px floor.

Wide ≥1200 content px: 184 px rail, four tiles, 1.85:1 plot/gauge, then three lower regions. At 800–1199: wrapping top nav, two tiles per row; below 800: single-column tiles/panels, 16 px gutters. All columns use minmax(0,…) and text wraps. Map details stack below wide; at narrow use the approved single-pane Back to map flow. At effective 320 px, table records reflow with visible column labels; nothing is hidden to mask page overflow. The production Session list/chat narrow swap keeps Back to list and focus restoration; the mock shows only the selected chat in this size as a static composition, not a navigation implementation. Native macOS title bar stays native, absent from review framing.

Exactly four area names: Dashboard, Session, Agent Map, Settings. Plain text navigation wraps naturally, keeps aria-current and the existing focus/return model, and admits future owner-approved destinations without shrinking labels. No fifth area or new global action. Production renders only phase-shipped destinations. Theme follows system appearance (`nativeTheme` / prefers-color-scheme), no persisted theme switch; explicit light/dark sections in the mock are review-only.

Persistent collection health precedes quantities. Loss of collector qualifies all retained live readings as Last known with time; never Ended by silence. Coverage notices precede summary facts. Dashboard starts in Live sessions and retains Live sessions / Needs attention / Usage and history. The mock selects Usage and history to show the charts; summary tiles stay shared. Charts mount/fetch only for the active view. No arbitrary greeting, performance score, inferred account total or percentage improvement. Live/attention retain the full main scrollport, existing anchor preservation, bounded paging and restoration. The lower current-state sample is a compact summary, not a second unbounded record list.

Focus is immediate, 2 px accent outline at 2 px neutral offset, with ≥4 px unclipped clearance. Pointer-inert SVG decoration cannot cover it. Hover changes only opaque tint, never scale/position. Retain 80/120 ms user-state/disclosure durations; no animated graph, count-up, spinner, blink, pulse or smooth scroll. Under reduced motion all transitions are zero. Production target minima stay approved 32 px / 36 px controls and grow with content; review links/fields use 44 px. Status always has full words and a distinct vector shape, not hue alone.

### 2.2 Chart → data-source inventory


“Phase 4” below means **implementable from current contracts after approval**, not already implemented by this document. No service/IPC/pure-logic changes are authorized here. Calculations reuse existing presentation/totals semantics; any rendering derivation must preserve the same deduplication/coverage boundaries.

| Chart | Real source | Ships now or later | Honesty / empty state |
|---|---|---|---|
| Active agents tile microbars | `SessionRow.agent`, `live.lifecycle`; same ACTIVE set as `liveSetSummary()` | Phase 4: counts by agent for loaded, deduplicated live set; not history. No profile claim; active bars count only busy/waiting-for-permission/needs-input sessions, not idle/error members. | Loaded subset if `more`; loading/error has no bars. |
| Sessions tile discrete microbars / live-state distribution | `SessionRow.live.lifecycle` from `liveSet` + deltas | Phase 4: idle/busy/permission/input/error/unknown counts. Null live → Unknown. Include every lifecycle if supplied. | Exact counts + text legend/table; capped feed says loaded subset, never global percentage. |
| Observed tokens tile microbars | `SessionRow.tokens`, `tokensComplete`; `overview/totals.ts` | Phase 4: one discrete slim rounded bar per displayed session, same consumed input+output basis; total remains `liveSetSummary`. | Null stays unavailable, not zero; incomplete known subtotal, eligible/observed coverage beside value. |
| Estimated cost tile microbars | `SessionRow.costUsd`, `costCoverage`; `overview/totals.ts` | Phase 4: discrete slim rounded bars for per-session estimates of the displayed rows, no time trend. | Always `~$`, known subtotal/provenance/coverage; unavailable sessions have no bar; exclude overlapping parent/child scopes per existing policy. |
| Large observed-quota history + optional quota sparkline | `UsageApi.history()` → `usageHistory` port → `answerUsageHistory()` in `src/service/api.ts`; `UsageRecord` | Phase 4: selected scope+stream/day only, existing cursor pages (≤100/page). MeasuredAt x-axis, usedPercent y-axis. | Round observation points with straight joins only between adjacent observed minutes of the same window/reset. Joins indicate sequence, not measured intermediate values. Break at missing minutes, null, transition, reset/window changes; no data carry-forward or interpolated measurements. Any translucent area is decorative sequence emphasis and has the same breaks; no smoothing, forecast or filled missing intervals. Explicit loaded time range and Load more. |
| Continuous arc quota gauge | `UsageApi.usage()` → `usage` port → `usageScopes()`; `UsageScope`, `usageView()` | Phase 4: one selected scope/stream/window. Continuous 0–100% arc with exact percentage alongside. | Clamp art to 100, retain >100% text/Above displayed scale. Reset passed hides current meter; stale/time unknown/account-scope labels retained. No observations yet / source-specific unavailable. Never overall score or remaining quota. |
| Monthly consumed-token / ~$ bar ledger | Approved design §6.1.1; monthly ledger query is absent from current `PortRequest` | Phase 5 design only: use approved disjoint settled monthly totals when service contract exists. | App until then: No observations yet — monthly totals are not available in this phase. No synthetic bars, count-derived totals, forecast or new endpoint implied. |

Source anchors: `src/shared/ipc.ts` (`SessionRow`, `LiveStatus`, `UsageScope`, `UsageRecord`, `PortRequest`); `src/service/index.ts` usage request cases; `src/service/api.ts` (`usageScopes`, `answerUsage`, `answerUsageHistory`); `src/renderer/overview/Dashboard.tsx` (`UsageApi`, `UsageView`, `History`); `src/renderer/usage/presentation.ts` (`usageView`, `scopeBlocks`, `dayRange`, `historyBounds`); `src/renderer/overview/totals.ts` (`liveSetSummary`). Current history is a list, not a chart. Existing service responses do not provide a trend of live-set totals, monthly totals, named gaps or epoch labels. Do not infer those from missing records. Since a service catch can return an empty page, say **No observations yet** rather than claiming no usage occurred.

Every graph has a visible title, scope, unit, range, source/observation time, exact values and a semantic table/list alternative. Decorative microbars are aria-hidden beside the same exact textual facts; chart SVG gets one concise accessible summary, not one node per pixel. No hover-only facts. Cap marks to the loaded page/window; explicit Load more keeps current chart and focus, never silently fetch all 45 days. Empty/loading/error retain words and prior evidence where available; no empty 0% gauge. Known missing minutes are visual breaks, not a measured zero. Different scopes/streams never form one curve or blended gauge.


**Tile sparklines versus available data:** the reference’s tile rhythm is retained using small modern categorical bars. Current SessionRow/live-set contracts do not provide time-series history for Active agents, Sessions, Observed tokens or Estimated cost. Do not fabricate a temporal sparkline for these totals. The quota-history source supports a genuine optional small sparkline only beside its own scope/window reading. Any future temporal summary requires a separately approved data contract. This preserves rev 2’s chart/source mapping while removing its pixel geometry.

### 2.3 Agent Map, Session and Settings

Propose replacing §5.1 “no graphical canvas or additional colors” and §6.5 “text outline, not a graphical canvas” only as a visual restriction, following the newer owner layout request. Wide arrangement: a repository root at left, worktree nodes with exact service counts centrally, session nodes fanning out at right, selected detail beside the map. Use rounded 10–12 px nodes and cubic SVG curves routed through whitespace. Connect each source’s right-edge center to its target’s left-edge center; never enter a node box or exit through its bottom. The static mock uses equal-height grid rows, centered spanning nodes and two dedicated 32 px connector gutters, with separate root/main/review fanouts sharing the nodes’ row spans; normalized endpoints therefore follow node edges at every wide width. Production derives endpoints only from mounted node bounds. Connectors use line on canvas, are aria-hidden and pointer-inert, and render only between mounted endpoints. No curves behind node text, force simulation, free pan/zoom, canvas widget, graph library, offscreen layout cache or second semantic graph. The mock’s connectors are illustrative layout decoration; exact hierarchy is supplied as a nested list disclosure.

Production keeps **one ARIA tree**, not the mock’s static columns: repository → worktree → sessions; cwd fallback and Project override retain provenance and never guess identity from strings. Agent/profile text remains on leaves; integration setup belongs to separate Agents mode. Worktree counts are authoritative bounded aggregates, never loaded-leaf sums. Unknown counts/incomplete agent inventory stay unavailable. Draw no line to an unfetched imaginary descendant; continuation gets its own endpoint. On resize/virtualization discard/recompute mounted decoration. Below 1200 omit connectors and use bounded indentation; below 800 preserve approved single-pane Back to map navigation.

Unchanged §6.5.1 behavior: roots 10/page, worktrees 20/page, leaves 50/page (service cap 100); three resident child pages/node and root cache; four expanded leafward paths; focus-safe eviction, collapse restoration, explicit previous/more/retry treeitems. One roving tab stop; Up/Down, Left/Right, Home/End, loaded-label typeahead, Space expansion and Enter selection/opening stay intact. Repository/worktree selects provenance detail; session opens Session. No live Agent Map code in this run.

Session preview uses the two-pane session list/read-only conversation. Preserve Conversation, Timeline, Tools, Subagents, Files, Context and Cost, readable owner/agent roles, source/model provenance, evidence disclosures, explicit first/latest navigation and local return anchors. No composer, active transcript link, markdown execution or new agent action. All conversation text is invented and labeled. Settings preview covers retention, storage, prices, startup, notifications and observation thresholds; controls are disabled synthetic fields, with system appearance read-only. This is no config write, Connect permission, clear-history action or revised settings contract. Unshown later states and mutation recovery remain required by approved design, not certified by a static mock.

### 2.4 Refined logo A: exact grid and SVG

Owner selected **A / Field lens**. Keep the low fedora and paired negative-space lenses. Calibrate the coat into one compact silhouette, and replace the detached cyan fragments with **one 5×5 pixel-circle ring with all four corners cut, plus a short diagonal handle**, separated from the coat by neutral space. No isolated accent pixels. The cut-corner ring and its diagonal handle form one eight-neighbor-connected pixel shape; its transparent 3×3 center keeps it readable as a lens. The silhouette remains asymmetric enough to read as the original detective, rather than a new logo direction. Original A is preserved verbatim in its comparison symbol only; B/C and the pixel wordmark are removed.

The grid is 16×16. `I` = ink, `C` = cyan, `.` = transparent surrounding neutral. Each row is y=0…15, columns x=0…15. Consecutive equal cells become one `<rect>`; no path, stroke, smoothing or raster asset. Negative space uses the neutral behind the mark, never cyan over ink.

```text
................
......IIII......
.....IIIIII.....
....IIIIIIII....
....I....III....
..IIIIIIIIIIII..
...IIIIIIIIII...
....I..II..I....
....I..II..I....
.....IIIII......
...III.II...CCC.
..IIII.II..C...C
..IIIII.I..C...C
.IIIIII.I..C...C
.IIIIII.II..CCC.
..IIIIIIII.....C
```

Exact refined source (the mock defines it once as `symbol#logo-refined` and uses local `<use>`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32" role="img" aria-label="Xaibo detective" shape-rendering="crispEdges"><rect x="6" y="1" width="4" height="1" fill="var(--x-ink)"/><rect x="5" y="2" width="6" height="1" fill="var(--x-ink)"/><rect x="4" y="3" width="8" height="1" fill="var(--x-ink)"/><rect x="4" y="4" width="1" height="1" fill="var(--x-ink)"/><rect x="9" y="4" width="3" height="1" fill="var(--x-ink)"/><rect x="2" y="5" width="12" height="1" fill="var(--x-ink)"/><rect x="3" y="6" width="10" height="1" fill="var(--x-ink)"/><rect x="4" y="7" width="1" height="1" fill="var(--x-ink)"/><rect x="7" y="7" width="2" height="1" fill="var(--x-ink)"/><rect x="11" y="7" width="1" height="1" fill="var(--x-ink)"/><rect x="4" y="8" width="1" height="1" fill="var(--x-ink)"/><rect x="7" y="8" width="2" height="1" fill="var(--x-ink)"/><rect x="11" y="8" width="1" height="1" fill="var(--x-ink)"/><rect x="5" y="9" width="5" height="1" fill="var(--x-ink)"/><rect x="3" y="10" width="3" height="1" fill="var(--x-ink)"/><rect x="7" y="10" width="2" height="1" fill="var(--x-ink)"/><rect x="12" y="10" width="3" height="1" fill="var(--x-cyan)"/><rect x="2" y="11" width="4" height="1" fill="var(--x-ink)"/><rect x="7" y="11" width="2" height="1" fill="var(--x-ink)"/><rect x="11" y="11" width="1" height="1" fill="var(--x-cyan)"/><rect x="15" y="11" width="1" height="1" fill="var(--x-cyan)"/><rect x="2" y="12" width="5" height="1" fill="var(--x-ink)"/><rect x="8" y="12" width="1" height="1" fill="var(--x-ink)"/><rect x="11" y="12" width="1" height="1" fill="var(--x-cyan)"/><rect x="15" y="12" width="1" height="1" fill="var(--x-cyan)"/><rect x="1" y="13" width="6" height="1" fill="var(--x-ink)"/><rect x="8" y="13" width="1" height="1" fill="var(--x-ink)"/><rect x="11" y="13" width="1" height="1" fill="var(--x-cyan)"/><rect x="15" y="13" width="1" height="1" fill="var(--x-cyan)"/><rect x="1" y="14" width="6" height="1" fill="var(--x-ink)"/><rect x="8" y="14" width="2" height="1" fill="var(--x-ink)"/><rect x="12" y="14" width="3" height="1" fill="var(--x-cyan)"/><rect x="2" y="15" width="8" height="1" fill="var(--x-ink)"/><rect x="15" y="15" width="1" height="1" fill="var(--x-cyan)"/></svg>
```

Use 32 px in wide rail, 24 px in compact band, 96 px only on comparison sheet. At 24 px a 16-cell grid maps to 1.5 CSS px cells: crispEdges can produce unequal snapped widths; visual checks at final Electron 1×/2× remain mandatory before adoption. No claim of optical certification follows a grid assertion. Mock shows all three sizes side-by-side in both themes for owner comparison.

The wordmark is ordinary **Xaibo** system UI text. Mark alone: role img, accessible name `Xaibo detective`. A lockup exposes that named mark with plain text Xaibo; alternatively name the whole lockup once and hide the decorative child SVG, without duplicating its description. The old pixel wordmark is absent. App uses class-based fills from the bundled stylesheet; the source uses presentation attributes, no style attribute. The static mock’s hash-authorized style element is review-only, not permission to weaken app CSP. Tray stays a separately reviewed native-template monochrome consumer; no tray edit or cyan recoloring now.

### 2.5 Modern icon contract

All §4 glyph IDs/callers/meanings remain. Hand-write original 24×24 SVGs, approximately 1.5–1.75 px round strokes, 16/20 px output, consistent inset bounds. Busy is a two-peak activity line, idle a clock/open shape, waiting permission a raised hand, input a message shape, error a crossed circle, ended a stop shape, unknown a question shape. Confidence retains distinct solid/open/dashed evidence shapes and full words. Health link/clock-gap/unlink and ownership external/control/detached remain separate with dimension labels. Findings, information, hourglass, restore, branch, settle, pending durability and all existing actions preserve their established silhouettes. Navigation uses ordinary vector grid/document/branch/sliders; agent identity stays text, never a vendor logo. No pixel glyph, emoji or external icon dependency. Paired icons are aria-hidden; icon-only controls keep their action names.

## 3. Contrast and tokens — proposed §8.2 replacement

| Token | Light | Dark |
|---|---|---|
| `--x-canvas` | `#EDF3FC` | `#080F21` |
| `--x-surface` | `#FFFFFF` | `#111F38` |
| `--x-tint` | `#DDE8F8` | `#1A2E4B` |
| `--x-ink` | `#102443` | `#F4F7FF` |
| `--x-muted` | `#435773` | `#B9C9E2` |
| `--x-accent` | `#204FA8` | `#93B8FF` |
| `--x-cyan` | `#006879` | `#63E6F5` |
| `--x-success` | `#205E50` | `#8DDFC0` |
| `--x-warning` | `#775500` | `#FFD166` |
| `--x-danger` | `#993744` | `#FFACB9` |
| `--x-line` | `#617896` | `#7188AD` |
| `--x-divider` | `#D7E0ED` | `#293B56` |

Aliases: focus→accent, chart→cyan, selected→tint, inset→canvas. Meaningful foregrounds appear on **canvas/surface/tint**, plus opaque chart marks on the explicitly inventoried translucent-area composite. All text and status glyphs use ink/muted/accent/cyan/success/warning/danger; all meet 4.5:1 even where large text would permit 3:1. Meaningful boundaries/axes/empty-outline/arc tracks use line (≥3:1); focus uses accent and charts cyan. There are no semantic-color badge fills, white-on-accent text, opacity-dimmed disabled fields or overlapping data series. Selection uses ink/accent on tint. The decorative history area uses cyan at 12% fill opacity over surface; the line is opaque cyan at 2 px, and observation dots stay opaque. Both preserve every evidence gap. Labels remain on neutral backgrounds. In addition to neutral pairs, the opaque chart marks are checked against the composited area below. Opacity is permitted only for this non-informational area, never text, status, axes, tracks or data marks. Neutral gaps separate axes/track outlines from cyan data and control borders from focus; do not rely on cyan-vs-line contrast.

`divider` is decorative only (panel separators/grid guides), not a control outline, chart scale, state indicator or the only boundary of a named region. It carries no information requiring a contrast threshold. Panel identity comes from headings/spacing; meaningful boundaries use line. Ink/cyan logo fills and negative space use the same neutral compositions; no accent touches ink. Original comparison A’s cutouts are surface. No new meaningful pair beyond this complete inventory (including chart/area-composite) is allowed without adding/checking it.

WCAG sRGB channels normalized to 0–1, linearization threshold 0.04045, luminance weights 0.2126/0.7152/0.0722, (lighter+.05)/(darker+.05). Test the unrounded result before rounding to 2 decimals. **62/62 checks pass: 21 text pairs + 9 neutral UI/focus/chart pairs + 1 chart/area-composite pair per theme.**

| Foreground | Background | Minimum | Light | Dark | Result |
|---|---|---:|---:|---:|---|
| `ink` | `canvas` | 4.5:1 | 13.89:1 | 17.80:1 | Pass / Pass |
| `ink` | `surface` | 4.5:1 | 15.49:1 | 15.35:1 | Pass / Pass |
| `ink` | `tint` | 4.5:1 | 12.52:1 | 12.75:1 | Pass / Pass |
| `muted` | `canvas` | 4.5:1 | 6.61:1 | 11.37:1 | Pass / Pass |
| `muted` | `surface` | 4.5:1 | 7.37:1 | 9.80:1 | Pass / Pass |
| `muted` | `tint` | 4.5:1 | 5.96:1 | 8.15:1 | Pass / Pass |
| `accent` | `canvas` | 4.5:1 | 6.86:1 | 9.58:1 | Pass / Pass |
| `accent` | `surface` | 4.5:1 | 7.65:1 | 8.25:1 | Pass / Pass |
| `accent` | `tint` | 4.5:1 | 6.18:1 | 6.86:1 | Pass / Pass |
| `cyan` | `canvas` | 4.5:1 | 5.78:1 | 12.87:1 | Pass / Pass |
| `cyan` | `surface` | 4.5:1 | 6.45:1 | 11.10:1 | Pass / Pass |
| `cyan` | `tint` | 4.5:1 | 5.21:1 | 9.22:1 | Pass / Pass |
| `success` | `canvas` | 4.5:1 | 6.78:1 | 12.22:1 | Pass / Pass |
| `success` | `surface` | 4.5:1 | 7.56:1 | 10.53:1 | Pass / Pass |
| `success` | `tint` | 4.5:1 | 6.11:1 | 8.75:1 | Pass / Pass |
| `warning` | `canvas` | 4.5:1 | 6.11:1 | 13.23:1 | Pass / Pass |
| `warning` | `surface` | 4.5:1 | 6.81:1 | 11.41:1 | Pass / Pass |
| `warning` | `tint` | 4.5:1 | 5.50:1 | 9.48:1 | Pass / Pass |
| `danger` | `canvas` | 4.5:1 | 6.31:1 | 10.77:1 | Pass / Pass |
| `danger` | `surface` | 4.5:1 | 7.04:1 | 9.28:1 | Pass / Pass |
| `danger` | `tint` | 4.5:1 | 5.69:1 | 7.72:1 | Pass / Pass |
| `line` | `canvas` | 3:1 | 4.06:1 | 5.29:1 | Pass / Pass |
| `line` | `surface` | 3:1 | 4.53:1 | 4.56:1 | Pass / Pass |
| `line` | `tint` | 3:1 | 3.66:1 | 3.79:1 | Pass / Pass |
| `focus` | `canvas` | 3:1 | 6.86:1 | 9.58:1 | Pass / Pass |
| `focus` | `surface` | 3:1 | 7.65:1 | 8.25:1 | Pass / Pass |
| `focus` | `tint` | 3:1 | 6.18:1 | 6.86:1 | Pass / Pass |
| `chart` | `canvas` | 3:1 | 5.78:1 | 12.87:1 | Pass / Pass |
| `chart` | `surface` | 3:1 | 6.45:1 | 11.10:1 | Pass / Pass |
| `chart` | `tint` | 3:1 | 5.21:1 | 9.22:1 | Pass / Pass |
| `chart` | `area-composite` | 3:1 | 5.38:1 | 8.32:1 | Pass / Pass |

Derived backgrounds (not new CSS tokens): 12% cyan over surface is approximately `#E0EDEF` light and `#1B374F` dark. Ratios use the unrounded composited channels. This area has no independent information/contrast requirement; only the opaque cyan data marks on it do.

Minima: light text cyan/tint **5.21:1**; dark text accent/tint **6.86:1**. Light UI line/tint **3.66:1**; dark UI line/tint **3.79:1**. These are token calculations, not runtime accessibility certification or native-control contrast measurements.

## 4. Checked, keep as is

- All approved privacy, observation, lifecycle/confidence/health/ownership, coverage, unavailable, estimate, stale, source-time and reset-passed semantics. No native data mutation, real-profile access, network, quota API or model call.
- All existing component names, data hooks, roles, labels, keyboard/anchor restoration, bounded virtualization/paging, IPC and pure total/presentation calculations. No new backend endpoint or graph dependency implied by layout.
- DD1 dialog/recovery, field-error association, named selector groups, text-spacing tests and gated 65ch body measure. Four areas only; Agent Map/Settings later-phase surfaces remain previews.
- The approved apply brief supersedes the first-pass pixel edits in the binding design and existing Phase 4 renderer/tests. Runtime certification remains separate.
- `.handoff` remains ignored and retained for Claude/owner use; delete the consumed handoff after review per AGENTS, without backups. No commit, push, publication or git-state mutation.

## 5. Historical mock verification (before application)

Review `.handoff/dd2-mock.html` alongside this proposal. All SVG artwork is defined once in `<symbol>` and instanced with local `<use>`. Standalone single HTML, system fonts, no script/event handlers/style attributes/images/remote URLs/dependencies. Its CSP denies every resource by default, including scripts/connections/fonts/images, and authorizes only the exact SHA-256 of its static CSS. App CSS remains bundled; no CSP change is proposed.

Shared SVG paint is explicit inside each symbol: history axes/guides have `fill="none"` and named stroke tokens; the area has cyan fill at 0.12 opacity; the trace has `fill="none"`, cyan stroke and 2 px width; dots have explicit cyan/surface paint. Every chart text node, including gauge endpoints, carries muted-token fill and system-font attributes. Icon symbols carry `fill="none"`, `stroke="currentColor"`, width and round joins/caps. Microbar/logo fills and connector strokes are explicit. Descendant selectors such as `.chart .trace` are not required to cross a `<use>` shadow tree.

Native review anchors and details disclosures work; mock area/view/section labels do not claim app navigation or live state. Disabled Settings controls never write. Exact numeric history alternative, state counts and a hierarchy disclosure retain the chart/tree information. Static previews do not certify production ARIA tree behavior, disabled-field interaction, Session narrow navigation or actual data integration.

- **Static checks pass:** 8 screen samples (4 surfaces × 2 themes); original/refined A at 96/32/24 px in each theme; 24 unique SVG symbols; 49 unique IDs; 147 resolved local references; 16 correctly associated sample form labels. No scripts, event handlers, inline style attributes, images, external resource references, shadows or stepped UI clipping. Reduced-motion rule is present. HTML nesting and disabled sample fieldsets checked.
- **Logo checks pass:** exact documented 16×16 grid matches the mock symbol; ink is four-neighbor-connected and the cut-corner cyan ring/handle is eight-neighbor-connected; the accent is separated from the coat, with no detached pixels. Original A geometry is preserved for comparison. This does not replace size/scale visual review.
- **Contrast checks pass:** independently read the mock’s literal theme tokens and recompute all 62 inventory entries (including the fractional-channel area composite); every threshold and published two-decimal ratio matches. The mock CSS matches the exact CSP SHA-256 authorization. No request/network execution result is claimed from these static checks.
- **Privacy scan passes:** explicit two-file `node scripts/privacy-scan.ts` run with disposable isolated HOME/agent/Xaibo paths exited 0, no output. The initial scan flagged the generated CSS digest as `opaque-id`; only its CSP line has a narrowly explained `privacy-scan:allow` annotation. The digest is independently verified against the static stylesheet; no rule or script was changed.
- **Preservation passes:** hashes of 565 protected source, test, scripts and documentation files match the pre-work snapshot, including the binding design, PRD, plan/progress and existing renderer/test edits. Only this draft and the mock were edited. No git-state mutation or commit.
- **Artifact size:** 74958 bytes, with artwork shared through symbol/use rather than repeated SVG geometry.
- **Browser verification blocked:** Playwright returned `MCP tool call requires approval, but approval policy is never`; the in-app browser returned `The browser access host is unavailable`. No rendered visual, narrow/wide viewport, focus, text-spacing, 200% text, reduced-motion, screenshot, console or Electron result is claimed. Claude must visually review both themes, all logo sizes and wide/narrow layouts before owner approval/adoption.
- **Not run:** application unit/build/E2E/Electron suites, because this run changes only the design draft and standalone mock. No renderer, runtime, native-control or accessibility certification.

Follow-up fixes from Claude’s 1440 px Chromium review: explicit symbol paint replaces the black history area/axis fallback; the lens is a cut-corner pixel circle; grid-gutter connectors replace the independently scaled full-map overlay. The earlier static checks did not catch these rendering bugs; they do not establish a visual pass. Follow-up checks audit all 24 symbols / 147 shapes and labels for explicit effective paint without descendant CSS, confirm the 2 px trace/12% area and gap, compare the revised circle grid/SVG, and check seven gutter-confined endpoint routes at four row heights. All 62 contrast checks and the explicit two-file privacy scan pass. A fresh Playwright navigation attempt still returned `MCP tool call requires approval, but approval policy is never`; these fixes have not been independently rendered in this environment.

The historical checks above describe the mock-only design run. The owner-approved apply brief subsequently authorizes Phase 4 application; it does not authorize later-phase implementation.


## 6. Phase 4 application verification (2026-11-14)

The owner-approved rev 3 apply brief is implemented without committing or changing git state. The binding design header, named sections, §8.2 (31 pairs × 2 themes) and all seven coverage rows now use rev 3. Superseded pixel UI geometry/type/shadows are removed; refined A alone remains pixel art.

| Item | Applied result / files |
|---|---|
| DD2-01 | `src/renderer/styles/tokens.css`: exact 12-color light/dark palettes, system appearance, system UI type, 8/12/6 px radii, decorative 1 px dividers and shadowless panels. |
| DD2-02 | `src/renderer/main.tsx`, `Health.tsx`, stylesheet: 184 px wide rail / wrapping top nav, named refined A plus plain Xaibo text, persistent collection health ahead of quantities. Dashboard and Session links only. |
| DD2-03 | `overview/Dashboard.tsx`, new pure `overview/charts.ts`: four categorical microbar tiles, one selected scope/stream/day history line/12% area and continuous quota arc, lower state/Agents/monthly empty regions. Exact semantic list alternatives, loaded-set coverage, explicit source-time limits, unchanged local API/paging. History scale expands above 100%; only gauge art clamps. Missing minutes, nulls, transition, window/reset changes and unknown source time break joins/area. Monthly service work remains Phase 5. |
| DD2-04 | Binding design only: rounded mounted-node map and whitespace connectors, one semantic tree and unchanged bounded paging/keyboard model. No Agent Map code. |
| DD2-05 | `main.tsx`, `status/icons.ts`, `Health.tsx`, `Coverage.tsx`, `SessionList.tsx`: exact refined-A rect grid, simple vector nav/health/warning icons, full status words retained. Existing lifecycle/evidence shapes and pure status logic unchanged. Tray adoption deferred. |
| DD2-06 | `test/unit/renderer/charts.test.ts`, `contrast.test.ts`, `presentation.test.ts`, `test/e2e/shell.spec.ts`: geometry/null/gap/scaling tests; 62 contrast checks including unrounded 12% area composite; original lifecycle icon assertions retained; E2E logo/grid/name, both themes and wide/narrow reflow assertions updated for Claude to execute. HTML chart captions preserve the metadata font floor on narrow plots. |
| DD2-07 | Stylesheet/binding design: no stepped/notched UI, checker trim, pixel wordmark, block charts or panel shadows. |

Tests were written before the geometry implementation: initial run failed with `ERR_MODULE_NOT_FOUND`; an additional above-scale history assertion failed (`undefined !== 125`) before its fix. Renderer checks pass after implementation. Initial typecheck exposed four TS18047 nullable-previous errors in the new module; corrected, final typecheck passes.

- `npm run typecheck`: exit 0 after the fix.
- `npm run lint`: exit 0.
- `node --test "test/unit/renderer/*.test.ts"`: 49 passed, 0 failed, 0 skipped.
- `npm test`: run once, exit 1; 978 tests, 950 passed, 7 failed, 21 skipped. Three privacy-scanner tests (`flags home`, `allow comment suppresses a documented pattern line only`, `GitHub Actions: the machine-name rule is off`) fail with `0 !== 1`: they build a home-path canary from the isolated temporary HOME, whose `/tmp/` prefix is outside the scanner's home-path pattern. Four `statusline-tee.test.ts` tests fail with `hook socket unavailable: listen` under this sandbox. These files were not changed; the full suite was not rerun.
- Changed-file privacy scan: exit 0, no output. No dependencies, network/model calls, real agent stores, service/IPC/data-flow changes, PRD/plan edits or git mutations.
- Harness constitution/workflow calls were unavailable: `MCP tool call requires approval, but approval policy is never`. No governed workflow completion is claimed.

Build, E2E, Electron and rendered visual verification are delegated to Claude by the apply brief; none is claimed here. Existing Phase 4 carry-overs (including the monitoring main-scrollport integration, compact record/disclosure behavior, finding-evidence pages and missing provenance/gap/epoch contracts) are unchanged by this presentation delta. Agent Map, Settings, monthly queries and native tray work remain in their designated phases. Retain the mock for the pending Claude comparison, then delete consumed handoffs without backups per AGENTS.
