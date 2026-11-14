# Xaibo design system

Phase D authoring draft · PD-T04 round 1 revision · owner amendments D-PD-01–D-PD-03 applied · Gate D pending.

This document specifies the original Xaibo interface for implementation, not an implemented UI or a Gate D approval. Binding sources: PRD v1.3 §§3.1, 4.1–4.3, 5.11–5.12, 6.1–6.5, 6.9 and 9.3; the implementation plan's Phase D and Phase 4; later owner-approved decisions where newer. **The newest owner approval wins.** Ordinarily the approved PRD overrides the brief/design; owner decision **D-PD-01 (2026-11-14)** explicitly supersedes the original screen list and its FR-49 navigation interpretation: exactly Dashboard, Session, Agent Map and Settings, with no separate usage/context/cost area. **D-PD-02 (2026-11-14)** makes Agent Map repository-first, with integrations in a separate Agents list on that screen; **D-PD-03 (2026-11-14)** names the Session sections Conversation, Timeline, Tools, Subagents, Files, Context and Cost. All other PRD and original-brief constraints remain binding. These amendments are owner changes, not Gate D approval. A further conflict returns to design review rather than becoming an implementation guess. The current `src/renderer/*.tsx` supplies data and evidence constraints, not a layout to preserve.

Xaibo is a local macOS Electron observer with one window and a tray icon for Claude Code, Codex, Antigravity CLI (`agy`) and contract-reporting custom agents. It records session activity, lifecycle and evidence confidence, available usage and quota, context and estimated cost, and searchable local history; it connects through previewed reversible configuration and launches or resumes in an external terminal. It serves one owner on one machine. Passive collection uses zero network and zero tokens; the approved later opt-in usage broker is a separately disclosed exception, absent from MVP. Partial data is normal: unavailable, estimated, stale and unknown are explicit information, never disguised as zero.

## Contents

1. [Identity and principles](#1-identity-and-principles)
2. [Tokens](#2-tokens)
3. [Status semantics](#3-status-semantics)
4. [Iconography](#4-iconography)
5. [Components and interaction](#5-components-and-interaction)
6. [Screens and surface states](#6-screens-and-surface-states)
7. [Formats and fixed labels](#7-formats-and-fixed-labels)
8. [Accessibility and pair inventory](#8-accessibility-and-pair-inventory)
9. [Coverage matrix](#9-coverage-matrix)
10. [Originality and open points](#10-originality-and-open-points)

## 1. Identity and principles

### 1.1 The observation ledger

Xaibo uses a quiet observation ledger: warm paper surfaces, plum emphasis, left-aligned numeric readouts, thin horizontal rules and a small evidence margin. No vendor logos, colored-square context grid, glowing activity dots, dashboard card mosaic or decorative graph background. A session is a ruled record with a readable title and evidence, not a tile: compact on Dashboard at normal/wide widths, three-line at narrow widths and in full detail. Headings use sentence case; labels use ordinary words. Monospace is reserved for paths, commands, IDs, token values and tabular numeric detail.

The mark is two offset open brackets around a short horizontal observation stroke (§4). It means observing a bounded record, not controlling the agent. It is used beside the Xaibo wordmark and as the tray template image. Agent identity is always a text name; agents do not receive vendor color palettes.

| Principle | Implementation consequence |
|---|---|
| Evidence stays beside the claim | Status spells out confidence; context, quota and cost place source/time/coverage immediately below the value, not only in a tooltip. |
| The collection can fail independently | Collection health has its own persistent band. Collector loss qualifies every last-known live record without converting it to Ended. |
| Different quantities remain different | Quota is per usage scope; tokens and cost are consumption; context is current occupancy. No shared score, blended quota or sum of overlapping scopes. |
| Live work takes precedence | Render the live first page while other regions load independently; retain focus and scroll position during deltas. |
| Readable uncertainty | Unknown, unavailable and stale have words and distinct glyphs. Nothing missing is a blank, dash or invented zero. |
| Local content is readable, untrusted text | Plain text with visible escapes; no markdown renderer, HTML, syntax highlighter or automatically active transcript links. |
| Actions describe their reach | Trash and purge affect Xaibo's copy; launch origin does not grant control; Connect is distinct from detection. |

### 1.2 Scope and reach

Only this document changes in Phase D. Its consumers are Phase 4's tokens, status presentation, virtual list, Dashboard and Session UI/tests; Phase 5's session-history/retention features and Dashboard monthly accounting; Phase 6's integration panel inside Agent Map; Phase 7's Session launch/ownership patterns. These are placements, not authorization to implement a later phase early. No callers, exports, fixtures, application config or dependencies change now. Phase 4 imports one bundled stylesheet; later surfaces reuse it. Exactly four areas exist now; a fifth requires a later owner decision and fits the same wrapping navigation pattern. Later notes introduce no hidden area.

## 2. Tokens

### 2.1 Color and permitted compositions

All names below are CSS custom properties. Light/dark values are selected by OS `nativeTheme`; no theme switch or persisted theme preference (D7, Q-4.6). Settings reports the current appearance read-only. Theme changes preserve geometry, focus and scroll and use no crossfade.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--x-canvas` | `#F6F3EC` | `#211F24` | Window/main background; recessed content |
| `--x-surface` | `#FFFCF5` | `#29262D` | Rows, controls, panels, dialogs |
| `--x-tint` | `#E9E1D8` | `#39323D` | Hover, selected, pressed or disabled background |
| `--x-ink` | `#25222A` | `#F3EDE4` | Primary text; neutral glyphs |
| `--x-muted` | `#605763` | `#C5B9C5` | Secondary text; stale/unknown/disabled text |
| `--x-accent` | `#65405D` | `#E6B5D6` | Action text, selection mark, chart/used-context marks |
| `--x-success` | `#31604D` | `#A7D3BC` | Evidenced connected health; diff additions |
| `--x-warning` | `#77501D` | `#E5C181` | Waiting, findings, coverage caveats |
| `--x-danger` | `#903D42` | `#F0A9AF` | Error, destructive actions, diff removals |
| `--x-line` | `#867881` | `#A18F9F` | All meaningful rules, outlines, meter tracks and graph axes |
| `--x-focus` | alias `--x-accent` | alias `--x-accent` | Focus ring |
| `--x-chart` | alias `--x-accent` | alias `--x-accent` | Every data mark; distinguish series by label/pattern |
| `--x-selected` | alias `--x-tint` | alias `--x-tint` | Selection/pressed fill |
| `--x-inset` | alias `--x-canvas` | alias `--x-canvas` | Plain-text blocks/diff body |

Only canvas, surface and tint are backgrounds behind meaningful text/glyphs. Semantic colors are foregrounds, never solid badge backgrounds. No white-on-accent buttons, opacity-dimmed text, image backgrounds or new color combinations. Borders surround controls even where adjacent neutral surfaces have low mutual contrast. Graph fills touch a neutral background; annotations are placed outside fills on that background. §8 enumerates every permitted foreground/background pair, including focus/chart aliases. Native OS surfaces are rendered by macOS, not recolored by Xaibo. PD-T04 round 1 keeps these color values and permitted pairs unchanged: the revised Busy glyph, visible field labels, compact rows, local view controls and Agents list use these same foregrounds on neutral backgrounds (§8.2).

### 2.2 Type

| Token | Value | Use |
|---|---|---|
| `--x-font-ui` | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | All interface text; system fonts only |
| `--x-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | Code, paths, numeric detail |
| `--x-text-small` / `--x-leading-small` | `0.8125rem` / `1.25rem` | Secondary metadata (13/20 px at default root) |
| `--x-text-body` / `--x-leading-body` | `0.875rem` / `1.375rem` | Body and controls (14/22 px) |
| `--x-text-section` / `--x-leading-section` | `1rem` / `1.5rem` | Section headings (16/24 px) |
| `--x-text-title` / `--x-leading-title` | `1.5rem` / `1.875rem` | Page title (24/30 px) |
| `--x-text-value` / `--x-leading-value` | `1.25rem` / `1.75rem` | Summary values (20/28 px) |
| `--x-weight-normal` / `--x-weight-strong` | `400` / `600` | Body / headings, primary actions, selected items |
| `--x-tracking` | `0` | No uppercase tracking or condensed type |

Root default is 16 px; rem type and line height grow with text scaling. Use tabular numerals on numeric columns, no letter spacing. No text below small. No contrast exception is taken for large text: all text pairs meet 4.5:1. Paths/IDs wrap anywhere in details; title rows may ellipsize only if a keyboard reachable disclosure exposes the full text in place. Confidence, health, unavailable and coverage words never ellipsize.

### 2.3 Geometry, motion and stacking

| Tokens | Exact values / rules |
|---|---|
| `--x-space-1`, `--x-space-2`, `--x-space-3`, `--x-space-4`, `--x-space-5`, `--x-space-6`, `--x-space-8`, `--x-space-10` | `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`, `40px` |
| `--x-radius-control`, `--x-radius-panel`, `--x-radius-badge` | `4px`, `8px`, `2px`; no pill-shaped status badges |
| `--x-border`, `--x-selected-border` | `1px solid var(--x-line)`, `3px solid var(--x-accent)` |
| `--x-focus-width`, `--x-focus-offset` | `2px`, `2px`; solid outline in `--x-focus`; reserve 4 px clearance inside scrolling edges |
| `--x-shadow-flat`, `--x-shadow-raised` | `none`, `0 8px 24px rgb(0 0 0 / 0.16)`; decorative shadow only, solid line remains the dialog/menu boundary |
| `--x-control-height`, `--x-target-min`, `--x-row-min` | `36px`, `32px`, `104px`; Dashboard compact records override `--x-row-min` to `64px` at normal/wide widths (§6.1); all are minima, grow with wrapping/text scaling |
| `--x-chrome-height`, `--x-health-height` | `56px`, `36px` minimum; native title bar remains standard, outside content geometry |
| `--x-content-max`, `--x-panel-gap`, `--x-evidence-margin` | `1440px`, `24px`, `28px` |
| `--x-duration-state`, `--x-duration-disclosure`, `--x-ease` | `80ms`, `120ms`, `ease-out`; state background transition / disclosure opacity only |
| `--x-z-base`, `--x-z-sticky`, `--x-z-menu`, `--x-z-toast`, `--x-z-dialog`, `--x-z-tooltip` | `0`, `10`, `20`, `30`, `40`, `50` |
| `--x-break-narrow`, `--x-break-wide` | `800px`, `1200px`; CSS media queries repeat these literal values (custom properties cannot drive media queries) |
| `--x-window-min-width`, `--x-window-min-height` | `640px`, `560px` outer BrowserWindow minimum |
| `--x-window-default-width`, `--x-window-default-height` | `960px`, `640px` outer BrowserWindow initial size |

Normal: 800–1199 CSS px content width. Narrow: below 800; wide: at least 1200. Breakpoints use actual content viewport, not outer OS size. Below the minimum effective width (zoom/text testing), the narrow single column continues to reflow to 320 CSS px without horizontal page scrolling. No minimum-width table forces window overflow. Modal width is `min(640px, viewport minus 32px)`; wide diff preview uses `min(880px, viewport minus 32px)`, height at most viewport minus 32 px. Dialog body scrolls; title/footer remain visible and may wrap.

No pulsing, rotating spinners, moving live dots, smooth auto-scroll, count-up numbers or animated list reorder. Loading uses a static outline/hourglass and words. Hover/focus never translates or scales content. Under `prefers-reduced-motion: reduce`, both durations become `0ms`, all disclosure opacity changes are immediate; scrolling is always instant. Live updates are immediate in both modes; only user hover/press/disclosure transitions use durations.

### 2.4 Baseline viewports (D10)

Darwin Playwright `_electron` captures at outer sizes **960×640**, **720×640**, **640×560**, **1280×800**, in both light and dark. Record actual content dimensions in the test; force OS appearance through the test harness. 720 and 640 exercise narrow; 1280 exercises wide. Fixed synthetic clock, system fonts, deterministic data, animations off, and 1× device scale for comparison. Include 200% text and 320 CSS px reflow as accessibility cases, not new product window sizes. Baselines come from the approved implementation after Gate D; none are created by this document. Every screen and Session section includes complete, empty, loading, error, stale, unavailable and estimate fixtures where §6.13 applies. Review actual renders and console, not just PNG diffs.

## 3. Status semantics

### 3.1 Lifecycle × confidence

The following 21 labels are exhaustive presentation mappings, not permission to synthesize unsupported states. Use the lifecycle icon in each row, plus the confidence icon in the column; both are 16 px. Accessible text equals the visible status string. Icons are hidden from assistive technology when text supplies the same meaning. All use the named semantic foreground on a neutral background, never a colored dot alone.

| Lifecycle / icon / color | Confirmed (`evidence-solid`) | Inferred (`evidence-open`) | Heuristic (`evidence-dashed`) |
|---|---|---|---|
| idle / `idle` / muted | Idle · confirmed | Idle · inferred | Idle · heuristic |
| busy / `busy` / accent | Busy · confirmed | Busy · inferred | Busy · heuristic |
| waiting-for-permission / `permission` / warning | Waiting for permission · confirmed | Waiting for permission · inferred | Probably waiting · heuristic |
| needs-input / `input` / warning | Needs input · confirmed | Needs input · inferred | Probably waiting · heuristic |
| error / `error` / danger | Error · confirmed | Error · inferred | Error · heuristic |
| ended / `ended` / muted | Ended · confirmed | Ended · inferred | Ended · heuristic |
| unknown / `unknown` / muted | Unknown · confirmed | Unknown · inferred | Unknown · heuristic |

For either heuristic wait, evidence details name the underlying lifecycle and reason; do not imply an observed permission prompt. Confidence is always spelled out, never reduced to a tooltip or glyph. Missing lifecycle/evidence renders `Unknown · heuristic`, with `No eligible state evidence`; it does not become Idle. Ended can be displayed only when supplied by eligible end/exit evidence, never an elapsed-time rule; the inferred/heuristic slots are defined for total presentation coverage and cannot authorize silence-based ending.

### 3.2 Health, ownership and reasons

| Dimension | Encoding and words | Placement / behavior |
|---|---|---|
| Health connected | `link` + Connected, success | After lifecycle/confidence on every row and header |
| Health stale | `clock-gap` + Stale + last observed absolute time, warning | Last-known lifecycle remains, prefixed `Last known:` when collector is unavailable; no unqualified live label |
| Health detached | `unlink` + **Health: Detached**, muted | Visible dimension label on every occurrence, even when ownership is absent; separate from lifecycle, not Ended |
| Observed externally | `external` + Observed externally, muted | Every session row/header; includes external-terminal launches initiated here |
| Controlled here | `control` + Controlled here, accent | Only authoritative ownership evidence; never inferred from launch origin |
| Detached ownership | `unlink` + **Ownership: Detached**, muted | Visible dimension label on every occurrence, even when health is absent; ownership value remains exactly Detached (C27) |
| Finishing… | `settle` + Finishing…, muted | Reason after lifecycle, without changing its confidence; visible immediately during turn settle |
| Background work | `branch` + Background work, accent | Reason on settled busy, never a new lifecycle |
| Pending durability | `save-pending` + Pending durability, muted | Evidence margin while service reports uncommitted live data; receipt is not claimed durable |

Accessible compound order: `Status: Busy, confirmed. Reason: Finishing…. Health: Stale, last observed [time]. Ownership: Observed externally.` Health and ownership Detached may coexist; each field visibly names its dimension, and its accessible name matches that visible text. Unknown lifecycle uses a broken enclosure; Ended uses a closed square; Stale uses a clock with a missing segment. They remain distinguishable in monochrome.

### 3.3 Findings and attention

| Rule | Badge (warning + `finding`) | Evidence disclosure |
|---|---|---|
| R1 | R1 Possibly inactive | Time since progress, excluded suspended time, configured threshold; expected-work alternative `R1 expected inactivity` |
| R2 | R2 Repeated tool | Tool identity and repeated pattern count; raw args/results stay in the local item detail |
| R3 | R3 Repeated error | Error pattern, repetition count, linked occurrences |
| R4 | R4 Possible loop | Ordered repeated sequence and cycle count |
| R5 | R5 Long-running tool | Tool, start time, duration, threshold; expected-work alternative `R5 long-running tool` |

Badges are disclosure buttons named `Show evidence for R2 Repeated tool` (substitute exact badge). Disclosure is inline under that record; Escape closes and focuses its trigger. Evidence uses paged source items; show the service's finding identity/deduplication, never accumulate duplicate warnings. Progress clears a finding according to service evidence. A finding never terminates, answers a permission request or converts legitimate long work into confirmed error. Settings defaults follow PRD: R1 5 min; R2 4 repeats; R3 3 repeats; R4 2–3 tool sequence repeated 3 times; R5 10 min; turn settle 4 s. UI displays service-validated settings, not an independent timer-based classifier.

## 4. Iconography

Original hand-written inline SVG only. Shared viewBox `0 0 24 24`; 1.75-unit stroke, round caps/joins, no fill except the small confirmed evidence square; currentColor; standard rendering 16 px status, 20 px controls, 24 px empty block. Use 2–22 coordinate bounds with 2-unit optical inset; no vendor marks, imported paths, Unicode/emoji icon substitution or icon package. In the descriptions, `(x,y)` is a point; lines join listed points; rectangles specify left/top/width/height; circles specify center/radius. Every icon's accessible name is listed below. Paired text makes the SVG decorative; an icon-only button takes the action name in §5, not the geometry name. The tray mark is the same monochrome geometry rendered as a macOS template image. Busy is a static double-crest stroke: no pause bars, closed stop shape or play triangle; it differs in monochrome from settle's horizontal strokes, branch's right-angle fork and the evidence squares.

| ID | Exact geometry in the shared grid | Accessible name / meaning |
|---|---|---|
| mark | lines (9,3)-(4,3)-(4,17)-(9,17); (15,7)-(20,7)-(20,21)-(15,21); (9,12)-(15,12) | Xaibo |
| idle | circle (12,12), radius 7 | Idle |
| busy | open zigzag (3,15)-(7,9)-(12,15)-(17,9)-(21,15); no enclosure, arrowhead or fill | Busy |
| permission | lines (6,20)-(6,10)-(9,10)-(9,5)-(12,5)-(12,11)-(15,8)-(18,11)-(18,17)-(15,20)-(6,20) | Waiting for permission |
| input | rect (4,5,16,11); lines (8,16)-(8,20)-(12,16); (8,10)-(16,10) | Needs input |
| error | lines (6,6)-(18,18); (18,6)-(6,18); circle (12,12), radius 10 | Error |
| ended | rect (5,5,14,14); line (9,12)-(15,12) | Ended |
| unknown | lines (9,4)-(4,4)-(4,20)-(9,20); (15,4)-(20,4)-(20,20)-(15,20); circle (12,12), radius 1 | Unknown |
| evidence-solid | rect (7,7,10,10), solid | Confirmed evidence |
| evidence-open | rect (7,7,10,10), unfilled | Inferred evidence |
| evidence-dashed | rect (7,7,10,10), unfilled, dash 2 gap 2 | Heuristic evidence |
| link | lines (3,8)-(9,8)-(9,16)-(3,16); (21,8)-(15,8)-(15,16)-(21,16); (9,12)-(15,12) | Connected |
| unlink | link with central line replaced by (9,12)-(10,12) and (14,12)-(15,12); slash (10,18)-(14,6) | Detached |
| clock-gap | open polyline (12,3)-(5,3)-(3,10)-(5,18)-(12,21)-(20,17)-(21,10); (12,7)-(12,12)-(16,12) | Stale |
| external | rect (4,9,11,11); lines (10,14)-(20,4); (13,4)-(20,4)-(20,11) | Observed externally; external destination |
| control | rect (4,4,16,16); circle (12,12), radius 3; (12,4)-(12,8) | Controlled here |
| settle | lines (5,6)-(19,6); (5,12)-(15,12); (5,18)-(11,18) | Finishing… |
| branch | lines (7,3)-(7,17)-(11,21); (7,11)-(17,11)-(17,5) | Background work; subagent branch |
| save-pending | rect (5,4,14,16); lines (9,8)-(15,8); (9,15)-(12,18)-(16,12) | Pending durability |
| finding | closed triangle (12,3)-(22,21)-(2,21)-(12,3); (12,9)-(12,14); circle (12,18), radius 0.5 | Finding; warning |
| search | circle (10,10), radius 6; (15,15)-(21,21) | Search |
| plus | (12,4)-(12,20); (4,12)-(20,12) | Add |
| close | (6,6)-(18,18); (18,6)-(6,18), no enclosure | Close |
| chevron | (9,5)-(16,12)-(9,19); rotate 90 degrees clockwise when expanded | Expand; Collapse when expanded |
| back | (13,5)-(6,12)-(13,19); (6,12)-(21,12) | Back |
| more | three circles centered (5,12), (12,12), (19,12), radius 1 | More actions |
| check | (4,12)-(9,17)-(20,6) | Selected; succeeded |
| minus | (5,12)-(19,12) | Removed; absent change |
| folder | closed line (3,6)-(10,6)-(12,9)-(21,9)-(21,20)-(3,20)-(3,6) | Folder |
| file | closed line (6,3)-(14,3)-(19,8)-(19,21)-(6,21)-(6,3); (14,3)-(14,8)-(19,8) | File |
| pin | (7,4)-(17,4)-(15,11)-(19,15)-(5,15)-(9,11)-(7,4); (12,15)-(12,22) | Pin |
| archive | rect (4,8,16,13); rect (3,3,18,5); (9,12)-(15,12) | Archive |
| trash | (3,6)-(21,6); (8,6)-(8,3)-(16,3)-(16,6); (6,6)-(7,21)-(17,21)-(18,6); (10,10)-(10,17); (14,10)-(14,17) | Trash |
| restore | (5,11)-(5,5)-(11,5); (5,5)-(17,5)-(20,9)-(20,17)-(16,20)-(7,20) | Restore; Undo |
| history | circle (12,12), radius 9; (12,6)-(12,12)-(7,15) | History; duration |
| settings | rect (4,4,16,16); lines (4,9)-(20,9); (9,4)-(9,9); (4,15)-(20,15); (15,15)-(15,20) | Settings |
| information | circle (12,12), radius 9; (12,11)-(12,17); circle (12,7), radius 0.5 | Information; provenance |
| launch | (5,19)-(19,5); (8,5)-(19,5)-(19,16); (5,5)-(5,19)-(19,19) | Launch; Resume as labeled |
| compare | (5,18)-(5,9)-(9,9); (15,18)-(15,4)-(19,4); (3,21)-(21,21) | Monthly usage chart (not the later Compare screen) |
| hourglass | (5,3)-(19,3)-(19,6)-(8,18)-(8,21); (5,21)-(19,21); (5,6)-(16,18)-(16,21) | Loading |

Reuse these geometries for actions with visible words (e.g. file for Reveal price override, restore for Re-import, branch for Fork); do not invent additional icons during implementation. A disabled icon-only action is avoided: its full text and reason must be visible.

## 5. Components and interaction

### 5.1 Common state contract

All components use §2. Enabled default: ink on surface, line boundary. Hover: tint, same text. Focus-visible: §2 ring, never removed by selection. Active/pressed: tint plus 2 px inset line in accent (no movement). Selected: tint, 3 px leading accent rule, check glyph and selected/current semantic attribute. Disabled: muted on tint, line border, visible reason; never reduced opacity. Where an element has no action (badge, heading, meter), hover/active/disabled/selected are **not applicable** and do not create false affordances; selection of text still works. Error: danger glyph + explanation, `aria-invalid` for fields; warning: warning glyph + text. Controls always retain focus outline in error and selected states. Native form widgets use explicit neutral surfaces and line outlines; default browser blue is not a new palette token.

| Pattern | Construction / content | States and keyboard |
|---|---|---|
| Action button / icon button | 36 px minimum height, 12 px horizontal padding; text action; icon-only 36×36 with accessible name. Primary = strong accent text plus 2 px accent outline; secondary = ink/line; destructive = danger text with explicit verb. | Common states. Space/Enter activate; Tab traverses. Disabled uses native disabled plus adjacent readable reason; no tooltip-only explanation. |
| Link | Underlined accent text; internal navigation uses an actual link with current-page state; no transcript autolinks. | Hover tint; focus ring; Enter navigates. Visited color unchanged. |
| Text/search/number field | Visible label above; hint/error below; 36 px minimum; surface background/line border; text 14 px. Clear search is named `Clear search`. | Common field states; native editing keys. Search submits on Enter; Escape clears only when field nonempty, otherwise returns to prior result anchor; no global interception during editing. |
| Select, checkbox, radio | Native semantics, label plus explanation; checkbox square 18 px within 32 px target; check mark ink/accent on surface. | Tab, Space; native select/radio arrows. Selected checkbox adds check, not color alone. Invalid numbers retain typed text plus range hint. |
| Scope/filter group | Fieldset + legend; native selects/date inputs; Apply and Reset buttons; selection summary text. | DOM order matches visual. Changes commit on Apply (prevents focus jump or expensive repeated queries); Reset clears applicable filters. |
| Status/ownership/reason badge | Inline glyph + full words; no pill fill; 4 px icon gap. 13 px text with wrapping. | Static labels have no hover/action. Evidence trigger is a separate labeled disclosure button. Selected state belongs to containing row only. |
| Banner | Surface, 1 px line border, 3 px leading semantic rule, 20 px glyph, heading + explanation + action; no content hidden behind hover. | New urgent collection loss `role=alert` once; normal updates `role=status` polite; Retry/Review named. No dismissal for an ongoing gap; resolved banners move to available evidence history. |
| Virtualized record list | Semantic list of records; each record's primary button contains title plus concise agent/project/state; secondary detail is a sibling, never nested inside a button. §5.2. | One roving primary record tab stop; Arrow Up/Down, Home/End within loaded range; Enter opens. Tab reaches selected record actions, then continuation. |
| Detail table | Semantic table with caption and column headers; only currently fetched page; data left, numeric values right. No interactive grid role. | Static cells readable in normal reading order; controls Tab in row order. Below 800 px, each row becomes a labeled definition record preserving header names. |
| Disclosure / evidence detail | Text button + chevron, `aria-expanded`/`aria-controls`, immediately following content; content on canvas. | Enter/Space toggles; Escape closes nearest disclosure containing focus; restore trigger. No focus trap. |
| Section selector | Session internal wrapping text-button list, §6.3; `aria-pressed` for active section. | Tab to selected button; Left/Right changes roving focus in DOM order, Home/End endpoints; Enter/Space commits; Tab enters selected section. No hover activation. |
| Conversation record | Plain-text role-labeled message block, neutral surface; no bubble tails, avatars or vendor colors. Owner/agent geometry, reasoning and tool disclosures in §6.3. | Static message text; one roving item control for details; Tab to selected item's disclosures/actions, then continuation. Reasoning/tool content collapsed initially; explicit Enter/Space expands. |
| Hierarchy outline | Agent Map ARIA tree, §6.5.1; chevron, file/folder/branch glyphs, text/status/counts; no graphical canvas or additional colors. | Roving treeitem focus; Up/Down, Left/Right, Home/End, Enter selection, Space expansion; separate integration actions outside tree. Common hover/focus/selected/disabled states; collapse does not imply disconnection. |
| Menu | More actions button opens a bordered surface, max-height 320 px, scrolls; each item ≥32 px. | First enabled item focused; Up/Down, Home/End, typeahead; Enter/Space runs; Escape restores trigger. Click outside closes; no implicit action. Disabled entries remain explained in adjacent text. |
| Dialog | Native modal dialog semantics; labeled title, description, neutral background, solid border, decorative shadow; no backdrop tint; underlying content inert. Close/Cancel always visible. | Trap Tab/Shift+Tab; Escape = Cancel before submission. Initial focus is first field for forms, Cancel for destructive/conflict warnings. Pending transaction cannot be dismissed until result; label `Applying changes…`; maintain keyboard access to read status. |
| Confirmation | Scope text, concrete consequence, Cancel + verb naming action. No typed-name challenge. Never treat Return anywhere as default destructive submit. | Cancel initially focused; explicit click/Space/Enter on destructive button required. §5.4 restoration. |
| Undo notice | Surface bordered inline notice fixed bottom trailing, at most 360 px wide, one at a time; stacking actions updates `Undo latest Trash`. Remains until dismissed, undone, next Trash action or navigation. | Polite announcement without focus theft; Tab-accessible Undo/Dismiss; no timer expiry. Unavailable Undo after purge gives explanation and Session list link. |
| Meter | Hand-written horizontal SVG: 12 px high track, 1 px line outline, accent used segment; separate visible value and exact text. No segments for unmeasured composition. | Static meter is not a tab stop; Details button is. `role=meter` with named quantity and value text only with valid domain; otherwise descriptive text, no invented `aria-valuenow`. |
| Chart | Hand-written SVG + visible numeric labels + paged text table, Dashboard §6.1.1. No canvas or chart library. | Month controls reachable via roving buttons beside the SVG; Arrow Left/Right and Home/End within fetched months; Enter opens detail; Tab reaches table and paging. Values never tooltip-only. |
| Diff preview | Unified one-column plain text, line numbers, `+`/`−`/unchanged prefixes; additions success, removals danger, unchanged ink on canvas. Item checkbox/title above each change; syntax is not color-dependent. | Tab item checkboxes, scrollable diff (`tabindex=0`, named), conflict details, Cancel/Apply. Native arrows scroll text; Escape cancels. Unchecked changes are excluded and preview recalculated before Apply. |
| Empty/loading/error block | 24 px glyph, heading, one explanatory sentence, action where useful. No mascot or artificial skeleton data. | First empty is not a tab stop; action is. `aria-busy` on loading region only; error Retry keeps existing data. Estimate/unavailable are text states, not skeletons. |

### 5.2 Paging, long content and live change

All session/attention/history/search/transcript/timeline/tool/subagent/file/Agents lists and the flattened expanded Agent Map outline use the same Phase 4 `@tanstack/react-virtual` primitive, variable heights, overscan 3 records each side. Default page request 50 records, hard service cap 100; smaller Map root/child and Agents pages are specified in §6.5–6.5.1. Content slice request is at most 16 KiB of UTF-8-safe source text. Conversation message text initially expands the first 4 KiB; **tool inputs/results and available reasoning start collapsed**, showing only their bounded metadata summary until explicit expansion. Thereafter `Show more` reveals the remainder of the fetched slice, then `Load more text` requests the next slice. Cuts never split a code point. Explicit `Load more` below each list remains available; reaching a loaded edge by arrow may fetch once and announces `Loading next page`. No endless scroll-only flow. DOM holds viewport records plus overscan and at most one focused record; changing focus scrolls/mounts its target before focus assignment. Do not set `aria-activedescendant` to an unmounted node.

Keep at most 3 pages of detailed list data and 4 fetched text slices per open item in renderer memory; evict farthest from viewport, retain cursor/scroll anchor, and provide `Load previous` to return. Selection, its pending focus target and anchor cannot be evicted before safe focus handoff. Long text is itself chunk-virtualized, so a single long tool output cannot defeat list virtualization. Byte offsets/cursors and counts come from the service; no renderer full scan. DOM order is reading order; recycled rows have stable record keys and exact accessible ordinal when supplied. Home/End mean loaded range, not the entire archive; `Load more` explicitly reaches the next range. Never announce an invented total. Continuation text reads `More records available` / `End of available records` / `More content available`.

Page fetches do not obscure the live list. Successful pagination keeps focus on continuation and announces `[count] more records loaded`; `Go to first new record` focuses the first appended primary control when requested. Failed pagination keeps the cursor and focus on Retry; partial pages remain visible. Live insertion preserves the current scroll anchor and focused record, and offers `New activity available` to intentionally jump to the top. Live reordering is held while focus or pointer is within the list; reconcile when leaving or activating that control. Do not auto-scroll the transcript; `Go to latest` is explicit. Virtual offsets/spacers must work under the existing CSP using the bundled same-origin stylesheet's CSSOM; do not require inline style blocks, `unsafe-inline`, a second stylesheet or an injected style library.

Untrusted text is React text, rendered in `pre`-style whitespace with wrapping (`pre-wrap`, overflow-wrap anywhere). Ordinary newline/tab remain layout whitespace; ESC, NUL, other nonprinting controls and bidi formatting controls use visible escaped forms such as `\u001B`, `\u0000`. ANSI sequences remain escaped literal characters, with no terminal interpretation. No markdown, rich link preview, HTML, syntax color or content-derived CSS/attributes. Copy content copies the visible escaped text, explicitly labeled `Copy visible text`. Native source remains local and untouched. Details for each item include source kind, source/observation times, evidence completeness, model where applicable, and source locator only in local UI; logs and test artifacts stay content-free or synthetic.

### 5.3 Keyboard and navigation foundation

First Tab reveals `Skip to main content`. Then: window navigation links → persistent health Review button if present → area primary action → area controls → main records/details → continuation. Top navigation is a semantic nav, ordinary Tab links; no global single-letter shortcuts. Standard macOS copy/select/find editing behavior stays intact; Command+F focuses Session's FTS search, navigating to Session's list first if necessary and preserving the open conversation. Escape closes the innermost menu/dialog/disclosure, never destroys a session or quits. Choosing an area link focuses its h1 (`tabindex=-1`) and announces its name once; choosing a session from Dashboard, Session list or Agent Map focuses that selected conversation's title instead (§6.3). `Back to session list` restores the selected list record/filter/page/scroll; `Return to Dashboard` or `Return to Agent Map` restores the cross-area invoker and its expansion/scroll state. If gone, use nearest following record, then previous, then the relevant list/tree heading. Refreshing a background page never steals focus. No focus changes for numeric/status updates. Area navigation preserves each area's last query, selection and bounded cursor/anchor state; it does not retain an unbounded DOM or page cache.

### 5.4 Confirmation and restoration inventory

| Action / close path | Confirmation content | Return target on completion / cancellation |
|---|---|---|
| Trash | Immediate reversible action, no confirmation; Undo notice names Xaibo copy | Following primary record; if none previous; if empty list heading. Undo restores item and focuses its primary control. |
| Restore from Trash | Immediate; removal from current Trash list announced | Following/previous record then Trash heading; optional `Open restored session` link. |
| Purge / Trash purge | `Purge Xaibo copy?` + selected item count + suppression/Re-import effect; `Native files are untouched. This is logical deletion, not forensic secure erasure.` | Cancel → exact Purge trigger. Success → following/previous record then list heading; session purge → source list heading if no adjacent row. |
| Clear usage history | Removes monthly totals and excludes all consumption already observed at confirmation from future calculation/settlement; afterwards new usage can appear. Separate from session deletion. | Cancel/success → Clear usage history button; success status nearby. Do not imply account snapshots or session content are deleted by this FR-52 action. |
| Disconnect | Preview exact owned changes; `Existing history remains available`; unresolved conflicts listed | Cancel → Disconnect trigger in Agent Map's integration panel; success → same profile panel heading because button may become Connect. |
| Full Uninstall | Preview all manifest-owned removal/restoration; conflicts preserved; history deletion is separate, never preselected | Cancel → Uninstall trigger; success → remaining profile/agent integration heading, or originating Agents list row, then its list heading if removed. |
| Connect/config preview | Apply only checked items after hash recheck/self-check; no silent config write | Cancel → Connect/opt-in trigger in integration panel; success → profile panel heading + receipt status; failure → error heading in dialog, Retry only after fresh preview. |
| Move to project/folder | Select target; Save updates Xaibo overlay, not cwd/native files | Cancel → Move trigger; success → moved record if visible, otherwise source list heading with `View moved session` link. |
| Launch / concurrency | §6.7–6.8 | Cancel → Launch/Resume trigger. Successful launch → provisional row; bound session keeps same focus anchor. |
| Inline scope history / evidence / full title | No mutation | Close → its disclosure trigger; if removed, containing row or section heading. |
| Open integration / close integration panel | Agents list Open integration selects that agent/profile; no mutation until an explicit action | Open → panel heading; Back to map/Close → originating Agents row/action with Agents mode and scroll restored; next/previous row then Agents heading if removed. Dashboard invocations restore prior Map mode/anchor on Back to map and their Dashboard invoker on Return to Dashboard (§6.5.1). Tree collapse first moves descendant focus to the surviving ancestor. |
| Open session across areas / return | No mutation; preserve source and Session browser states independently | Open → conversation title; Return to Dashboard/Agent Map → exact source record/treeitem, then following/previous/ancestor/heading fallback. Session list paging never resets on return. |
| Generic menu/dialog close | No mutation or Cancel | Exact invoker; if deleted/disabled, nearest enabled sibling action, then containing heading. |

Pin/Unpin, Archive/Unarchive and Keep are reversible toggles with `aria-pressed` and immediate polite success/failure; if a filter removes the record, use following/previous/list-heading fallback. If Undo restores an item that no longer qualifies for the current list/filter, focus that list heading and offer `Open restored session`; never force a filter change. Re-import asks confirmation that suppression will be removed and available native content may be read again; source absence keeps `Transcript only, not resumable` and unavailable reason. Success returns to the reimported row if available, otherwise the suppression list heading. Focus restoration uses stable record identity internally, never titles as selectors.

## 6. Screens and surface states

### 6.0 Shared window frame

Standard native macOS title bar and traffic lights. Below it, a surface navigation band, minimum 56 px: Xaibo mark/name at leading 24 px; ordinary links in order **Dashboard**, **Session**, **Agent Map**, **Settings**. Session is the retained owner name, not a contextual fifth destination. Use a wrapping flex list, 16 px gap, minimum 36 px link height, natural text widths, no equal-width four-column assumption. A later owner-approved fifth link appends in the same list and wraps without reducing text or target size; no fifth placeholder or empty slot is rendered now. At 640–799 px the wordmark occupies the first line and navigation follows on as many lines as needed. At effective widths below 640 px the same text links continue wrapping. No icon-only rail, hamburger or horizontal scrolling. Mark/name is static; Launch is **inside Session**, not a global navigation action. Current area has aria-current=page, tint and leading accent/check selection treatment. Internal Session sections/history/Trash, Dashboard history/chart and Agent Map integration panel are never extra top-level areas.

Next, the persistent collection band (minimum 36 px): `Collection: Starting / Running / Restarting / Stopped`, glyph, last service observation and Review action for problems. Running gets link/success; Starting hourglass/muted; Restarting restore/warning; Stopped ended/danger. Read-only recovery shows its own explanatory banner and disables writes with a reason, while readable history remains usable. The band can grow, never overlap main. On restart retain already painted data as last-known, qualify health, cancel orphan pending requests, rebind/resync from the service, and preserve anchors. A stopped/restarting collector has **no** unqualified live indicator anywhere, including tray, counts or rows.

The remaining main region has 24 px padding normal/wide, 16 px narrow, centered at maximum 1440 px. Each page uses one main vertical scroll plus explicitly named virtual-list/detail scrollports; Dashboard instead uses its main scrollport directly for the active list (§6.1), with no nested monitoring scrollport. No horizontal page scroll. Sticky elements stay within their named scrollport, never cover the focus ring. Page titles precede their controls. Every screen uses §5.3 navigation and §5.4 restoration; the following sections name its local order and layout.

| Current area | In-area surfaces; no separate top-level link |
|---|---|
| Dashboard | Live observation/attention, usage scopes and their 45-day day-paged history, monthly usage chart/quota peaks |
| Session | Live/past session list, FTS/projects/folders/organization/Trash/suppression, read-only chat and details, Phase 7 launch/resume patterns |
| Agent Map | Repository/worktree/session hierarchy, separate Agents list and selected agent/profile integration/Add agent panel |
| Settings | Existing retention/storage/prices/startup/threshold/notification settings |

### 6.1 Dashboard (A1, A2, A4 monthly chart)

Dashboard uses one viewport-filling main scrollport below the shared frame, with no separately scrolling page behind it. Order: Dashboard h1 → wrapping local view controls **Live sessions**, **Needs attention [n]**, **Usage and history** → agent strip → collection/coverage notices → live-set summary → active view. These are in-place Dashboard views, not navigation areas. Live sessions is initially selected; Needs attention displays its service total or `Needs attention · count unavailable` even when another view is selected; collector loss qualifies that count as Last known with time. The view selector stays sticky within the main scrollport on surface background; reserve its measured wrapping height plus focus clearance in scroll padding so it cannot obscure a focused row or restored anchor. Usage and history contains the existing usage scopes, in-place observed history and monthly ledger (§6.1.1), in that order. No grid of summary cards. Sections retain the full readable width, top rule and 16 px vertical separation.

Live sessions and Needs attention each use the **entire remaining main viewport**, rather than fixed 320/160 px boxes or two competing scroll regions. Their virtualizer observes the Dashboard main scrollport and measures the preceding header/summary as its scroll offset; the active list fills at least the remaining height and grows with its bounded loaded pages. Header, agent strip, notices and summary scroll away in that same scrollport, so tall notices or text scaling cannot leave a clipped list below fixed chrome. No list minimum forces an outer scrollbar. Named list headings remain in reading order. Switching views preserves each view's bounded pages, selection and scroll anchor; inactive views are inert/unmounted. Left/Right, Home/End rove view buttons, Enter/Space selects and keeps focus on the button; Tab enters that view's controls/list. There is no focus jump on attention-count changes. The selected view and anchor restore on Return to Dashboard; if its source record vanished use §5.3 fallback.

Normal/wide live records are compact two-line records, minimum 64 px including padding; they may grow to wrap words and focusable controls, never clamp status or metadata. Narrow keeps the full three-line record at the 104 px minimum. All 50 concurrent sessions remain reachable through §5.2 paging/virtualization and explicit continuation. Default live order is last activity descending, unknown last, stable service key tie-break; fixed anchors and deferred live reorder in §5.2 still apply. Usage/chart failures do not block switching back to either monitoring list. In Usage and history, the main scrollport contains the scopes/chart; only an explicitly expanded day-paged history retains its named bounded inner scrollport.

| Region | Exact content / layout |
|---|---|
| Agent strip | One wrapping text row per agent registration/profile: name, detection/connection state, lifecycle/content coverage separately, current model · effort for each running session (up to 3 visible, `Show all models` paged disclosure for more). Multiple models are never collapsed into an invented agent-wide model. `Review integration` opens the matching profile. |
| Coverage/drift | Before any apparently live quantities. `Source format drift detected` plus affected agent, observation time, known parsing limitation, `Review evidence`. Coverage rows include spool overflow/saturated count unknown/damaged spool, disk full, Claude hooks blocked by policy or policy unknown, Codex awaiting trust, missing/rejected/truncated content and report sequence gaps. Group by reason and agent (current service cap 64 groups); say `Showing up to 64 groups; additional groups may be omitted` whenever capped/unknown completeness, never imply exhaustive coverage. Detail shows interval, count only if known, source and remedy; sequence-gap detail is registration/producer-scoped and reconciles late arrivals (D-P3-26). Disk full reads `Disk full: collection paused`; hooks blocked reads `[agent]: hooks blocked by policy (files only)`; awaiting trust links to §6.5 steps. |
| Live-set summary | Visible label `Live-session set: [n] currently tracked, non-ended sessions`; excludes Trash/suppressed and historical sessions without live projection. Includes idle, busy, waits, error and unknown members; archive/pin overlays do not prove an end. A historical native record outside the existing 24 h feed eligibility window alone does not create a live member (D-P3-09). Show `Active agents [n]` (distinct registrations with busy/waiting/needs-input, including background work), `Sessions [n]`, `Observed tokens [value]`, `Estimated cost [~$value]`. Tokens = service-normalized consumed input plus output; use disjoint parent/child coverage only. Each metric has eligible/observed or priced counts and source time; below 80% eligible coverage adds warning icon/words, never imputation. No eligible denominator means coverage unavailable. No model/context tokens are invented to fill gaps. |
| Live records | Evidence margin 28 px + content. Normal/wide line 1: native title/Untitled as primary Open button; agent/profile · project/worktree; lifecycle + full confidence; last activity. Line 2: visibly qualified health, ownership, model · effort, reasons and findings; a sibling **Session details** disclosure exposes entrypoint/verification, full wrapped cwd, context %, estimated cost/coverage and full title in place. All fields are reachable by keyboard/click without hover or opening another screen; expanded detail stays attached to that row and preserves its anchor. Status/confidence/health/ownership/reasons/findings remain visible when collapsed. Narrow full record: line 1 agent/profile · entrypoint · project/worktree and title/Open; line 2 lifecycle/confidence/health/reasons/findings; line 3 ownership, model · effort, context %, ~$ and last activity, with cwd/full-title disclosure. Wrapping may add lines in either layout; no fixed line clamp or unreachable field. |
| Missing data on a record | Entrypoint Unknown; project unapproved displays local label if available but notifications use Project; title Untitled; model Model unavailable; context Context unavailable; cost ~$ unavailable. `Compressed, not imported`, quarantined-line evidence and format-drift markers remain visible if provided. Ownership defaults only from authoritative projection; when unknown show `Ownership unavailable`, not Controlled here. |
| Usage scopes | Agent heading then per-profile/evidenced-scope ruled blocks. Always show profile label, scope verification/epoch boundary, sign-in method with source/time; plan, credits and each window label/duration, utilization %, reset clock and countdown when supplied. Subscription leads with windows. API key/cloud provider/gateway lead with estimated cost and tokens **for that scope's attributable observed sessions**, separate from credit/spend-limit values. Mixed has distinct quota and consumption rows, never summed. Unknown has neither emphasis lead; all available fields plus Unknown. No account total is inferred from equal readings. |

If an owner declaration disagrees with agent-output sign-in evidence, show both values, sources and times, with `Using owner declaration`; changing sign-in declaration opens the relevant profile integration panel in Agent Map. Scope uncertainty shows `Account scope unverified`; Claude readings remain separate by session/source, no merged account curve. Gateway spend windows/credit balances carry their source currency/unit and label `Reported spend limit` / `Reported credits`, visually separate from Estimated cost. Utilization above 100% remains the reported number; a meter caps its drawn extent only and adds `Above displayed scale`, without capping text.

Every scope has `Observed history` disclosure directly below its current readings. It expands **in Dashboard**, maximum 320 px scrollport: day heading, date control, Previous day/Next day, paged observation records and Load more. Initially show the latest observed day; expose the entire retained 45 elapsed days via day paging, not a 45-day DOM or prefetch. Record time, window, utilization/reset, source and scope are visible. Insert labeled collection gaps and epoch boundaries between observations; no interpolation or zero before tee collection. Absent days say `No observations for this day`, with known gap reason, not 0%. Retention is fixed even when session Keep/Never is enabled. Opening keeps focus on the disclosure, Tab enters date/day controls; Close/Escape returns to that scope's Observed history button. Day changes keep focus on Previous day/Next day and announce the date; failed day/page loads retain the prior observations plus Retry. Narrow stacks these controls, preserves the same 320 px maximum scrollport and wraps every source/scope label.

Freshness uses §7: Claude always `Source time unknown; observed …`; unchanged cached re-emission does not renew age. Older than 15 min without an eligible newer measurement shows clock-gap + Stale + timestamp. Explicit expired source reads `Expired · last observation [time]`. At reset, replace current utilization and countdown with `Reset passed; awaiting observation`, retaining historical reading in detail. agy quota and Gemini quota cells show exactly `Unavailable from passive sources`, with no fabricated percentage/reset/countdown. Claude quota before an eligible tee reading says `Unavailable — no statusLine quota observation`; tee is a separate default-off opt-in, not a prerequisite for file-only connection. No Refresh quota button or active polling is introduced.

Keyboard order after shared frame: local view selector → Review integration buttons → active banner actions → summary coverage disclosures → selected view controls: live records/Session details/actions/continuation, attention records/actions/continuation, or usage-scope disclosures/expanded controls then monthly ledger controls. Static summary numbers are readable, not spurious tab stops. Review integration navigates to Agent Map's selected profile panel and saves this invoker; Return to Dashboard restores it. Opening any session navigates to Session chat, saving Dashboard list/filter/focus/scroll anchor; Return to Dashboard restores it. Narrow: the same local view selector wraps above a full-width active view, using the same single main scrollport; each live record uses the full three-line layout and each scope becomes one full-width block; summary is a 2-column definition list (1 at effective width <480 px), values wrap with coverage. No column or disclosure is removed.

#### 6.1.1 Monthly usage ledger (A4 chart, D9)

Hand-written **vertical SVG bars**, single series per selected metric: Observed tokens (default), Estimated cost, Sessions, or Turns. Filters by agent and model; no multi-series color legend. Fetch at most 12 calendar months, latest first page but plot left-to-right chronological within that page; Previous months / Next months fetch bounded pages. Never construct all-history totals in renderer: request service MonthlyUsageTotal summaries. No month before first observation appears. Within observed range a missing bucket is `No observations` and no bar, not an inferred zero; valid evidenced zero is `0` with an outlined baseline marker.

Each month occupies at least 80 px plot width, chart height 220 px including numeric labels above each mark and month below; normal Dashboard viewport shows 6 months, wide 12, narrow 3 by chart-page subdivision of the fetched page. No horizontal drag-only chart. Labels wrap, chart extends vertically if needed rather than clipping. Axis line is line color, bars accent fill on canvas, labels ink; no gridlines required. Scale is local to the displayed subset, starts at zero, and is spelled out in a caption; text table contains exact values. Every bar/point has its visible number (cost includes ~$/known subtotal). Unavailable has its words at the month position and no mark. Current month visibly appends month to date. Detail-retention labels are per month from retained records: some details expired / details expired, totals only, honoring Keep and active sessions rather than age alone. Do not relabel retained detail as expired merely after 45 calendar days.

Under SVG: month controls (roving focus) and a semantic table with month, exact sessions/turns/token components, cost/coverage, price revisions and detail state. Enter on a month opens inline detail/provenance and a filtered retained-session link if available; totals-only months explain why there is no detail link. Cost respects disjoint month/model attribution; never prorate an opaque session estimate across filters. Existing amounts retain original prices; multiple revisions accessible from every cost month. No eligible cost stays unavailable even if token bars exist.

**Quota peaks** is a separate section/table below consumption: month, opaque scope presented as local scope label/epoch, limit/window identity, peak observed %, verification/gaps. Never grouped by model or summed. Model filter affects consumption only; text reads `Quota peaks are per usage scope; model filter does not apply`. No carried-forward reading creates a new month's peak. Uncertain scopes remain separate without user-specific profile labels resurrected from expired accounting rows; fallback labels `Scope 1`, `Scope 2` are view-local ordinals, not account identity.

This ledger lives in Dashboard’s Usage and history view below usage scopes, not in Session’s history browser. Its agent/model filters are local to this ledger and do not silently filter live-set totals or current quota readings. Tab order: metric → agent/model filters → Apply/Reset → month paging → month controls → table/detail controls → quota peaks paging. Changing chart pages leaves focus on the page control and announces the month range; selecting a month keeps focus on its control and Tab enters inline detail. Opening retained sessions from a month navigates to Session with that month/agent/model query, focuses the result heading and saves Return to Dashboard at this month control. No retained details means a totals-only explanation, not an empty fabricated session list. Narrow keeps all numeric labels visible through the three-month subdivision; at effective width below 320 px use one month per subdivision.

### 6.2 Attention queue (A2)

Dashboard view titled **Needs attention**, with total from service if supplied (otherwise `Observed items`). It uses the same available-height main scrollport as Live sessions (§6.1), at every width; no fixed-height inner queue. Each record minimum 64 px, growing with wrapping. One session appears once, containing all its findings. Groups, in order: **Confirmed requests** (waiting-for-permission then needs-input), **Errors**, **Probably waiting** (heuristic waits), **Findings** (R1–R5). Inferred request states without confirmed request evidence go in a separate **Unconfirmed requests** subgroup after Errors and before Probably waiting. Within groups oldest unresolved since-time first, stable service identity tie-break; findings use first active finding time. Service-supplied onset missing means `Since Unknown`, sorted after known times. No fabricated age from last activity.

Each record: agent, approved project label or Project, full state/confidence/health, `Since [time]` + elapsed duration, rule badges, Open session button. Heuristic waiting is in-app only. Errors/findings do not create OS notifications. The same session can remain indexed in Live sessions; queue inclusion is a different index, not another count added to live totals. On resolution remove from queue without moving keyboard focus unexpectedly: if the focused record resolves, retain it until focus leaves and label `Resolved`; then following/previous/heading restoration. Empty reads `Nothing needs attention. View Live sessions to continue monitoring.` with a Live sessions button that selects that view and focuses its list heading. On collector loss keep `Last known needs attention`, Stale time; do not clear unresolved waits on silence. Tab/roving list rules §5.2 apply; Open navigates to Session; Return to Dashboard restores the same queue anchor. Narrow retains every word and uses a vertical record.

### 6.3 Session: browser and read-only chat (A3, A4 history)

Session h1 and its primary **Launch** button (Phase 7) precede a two-region workspace: **Session list** (§6.4) and **Open session**. At 800–1199 px the list is 280 px wide; at ≥1200 px it is 320 px; gap 24 px; conversation takes remaining width, with no third column. Both regions have independent named scrollports: list at least 288 px high, conversation at least 288 px, each up to the remaining content viewport height after area heading/controls. Main scroll handles headers taller than the viewport rather than clipping either pane. At <800 px show one region at a time: list until selection, then conversation with **Back to session list**. List query/cursors/anchor and selected conversation state persist; hidden pane is inert and absent from Tab order/DOM virtualization. At effective widths <480 px controls and fields stack. There is no draggable split, hidden horizontal panel or fixed transcript width.

Selecting a list, Dashboard or Agent Map session opens its conversation and focuses its title h2. Keep the area h1 Session. `Back to session list` is available in every conversation header, restores the selected row and its list scroll/filter, and at narrow switches back to the list. For Dashboard/Agent Map invocations also show `Return to Dashboard` / `Return to Agent Map`; preserve that source independently of the existing Session browser query. If the selected session is outside that query, leave filters unchanged and show `Opened from Dashboard/Agent Map; outside current list filters`; do not load all sessions or invent a matching row. Return restores the source record/treeitem path; missing target uses §5.3 fallback. Switching away through top navigation does not discard the selection. First visit without a selected session shows `Choose a session to read its conversation` and focuses the list heading; if no records, Add agent opens Agent Map.

Open-session header, in reading order: Back to session list → optional Return to source → native title/Untitled → agent/profile/project → worktree + full wrapped cwd → lifecycle/confidence/health/reasons/findings → ownership → model · effort → last activity → retention `Purge scheduled [date]` or `Kept` / `Active; retention paused` → Keep toggle → native-availability warning. `Transcript only, not resumable` disables Resume with explanation. Native state can additionally show `native deleted/archived`; Xaibo content remains readable. A newer model/effort updates the header and creates timestamped inline Conversation and Timeline markers; old evidence never silently reverts it.

Header actions: Resume, Fork, Open in VS Code, then More actions (Move, Pin/Unpin, Archive/Unarchive, Trash; Purge only through confirmation). Disabled capabilities remain visible with reason. Open in VS Code is enabled only for verified agent/version/entrypoint support; current unverified Claude link says `VS Code opening is not verified for this version`; do not claim it works merely because the URI can be assembled. No permission-answer/control UI for externally observed sessions. Header is in main scroll, not fixed above a long transcript.

Below the header, a wrapping section index spans the conversation pane: **Conversation**, **Timeline**, **Tools**, **Subagents**, **Files**, **Context**, **Cost**. It never consumes a third side column. These switch one body within the open session; they are not top-level areas. On first opening select Conversation. A live (non-ended) session opens on the bounded latest page, anchored at its latest retained item as of that request; later activity never auto-scrolls. An ended session or historical session without a live projection opens at the first retained turn. Returning to an already open session restores its saved section/page/anchor instead of resetting it. **Go to first turn** and **Go to latest** explicitly request the bounded first/final page without fetching intervening history; unavailable/failed targets retain the current page/anchor with reason/Retry. `New activity available` offers an intentional Go to latest; new activity never silently moves the anchor. First/latest navigation keeps focus on its initiating control and announces the loaded range after anchoring; no transcript item receives surprise focus. Each body scrollport is `max(288px, content viewport height minus measured area/header/index height)`; the header can scroll in the outer conversation region if long. Preserve section pages/anchors while switching. Left/Right roves index controls in DOM order even when wrapped; Enter/Space selects, focus remains on that button, Tab reaches the selected section's first control. Opening source links to Tools/Subagents/Files focuses the destination item heading; a local Back to Conversation restores the exact source item/disclosure.

Conversation is a **chat-style conversation, read-only in MVP**: full-width agent responses alternate with owner prompt blocks indented 28 px from the leading edge (16 px narrow), width capped only by available pane width and 880 px maximum. Both align text left, use surface background and a 1 px leading line, and use ledger geometry with the existing 2 px badge radius, no enclosing bubble, tail, avatar or vendor-specific header. Owner block role label **Owner prompt**, agent block **Agent response**, then time and that item's model · effort; do not infer an old turn's model from today's header. Role labels and indentation convey speakers without vendor colors. Space between messages 16 px, label/body gap 8 px, content inset 12 px; agent messages do not alternate arbitrary colored fills. Plain text uses §5.2 wrapping/escaped controls; no rendered markdown or syntax highlighting.

Within the causal conversation sequence, **Available reasoning** is an explicitly labeled collapsed disclosure; show no reasoning text or fetch its content until expanded. Tool cards are collapsed **Tool call — [name]** with approval/result state and duration metadata; expansion exposes plain-text input and its corresponding result/error, independently chunk-paged. Long output is never auto-expanded on completion. Subagent work appears as an inline **Subagent — [name/type]** summary with its own model · effort, lifecycle/confidence/health, ownership where it is a session, and expansion to its paged work; never substitute parent's model. Model/effort switch and compaction markers are separate inline ruled rows with timestamp/glyph; findings attach at their evidenced occurrence with evidence disclosure; Content incomplete is an inline gap, not only a header banner. Available records remain readable on either side of gaps. No prompt text is used as the control's accessible name.

There is **no composer, text input for prompts, Send action or implicit control gesture**. At the end of the conversation pane, after transcript continuation/Go to first turn/Go to latest, place a normal 36 px-minimum utility row reading `Read-only observation`, with coverage/provenance action if present. This is the attachment boundary for a later S-20 terminal/input region: it can become an additional bottom layout row with a resizable body above it, without relocating list, header or section navigation. No empty fake input or reserved blank composer is rendered now; future input and control require their own approved design delta. Tool expansion/Find/Copy remain observation, not execution.

Local keyboard order after shared frame: Launch → list modes/search/filters/navigator/records/continuation (§6.4) → open-session Back/Return → header Keep/actions/evidence → section index → current body item/disclosure/actions → continuation/Go to first turn/Go to latest → read-only utility action. The title receives programmatic focus when a session opens; Tab proceeds from there into header actions. A conversation Trash/purge that removes it selects no unrelated conversation automatically: restore focus to following/previous list record, then list heading; narrow shows that list. Undo can reopen/focus the restored session when it was the invoked conversation, except an active filter exclusion uses §5.4 fallback.

| Section / visible detail heading | Required body and evidence |
|---|---|
| Conversation / Conversation record | Chat message geometry and inline records above; paged/virtualized source/causal order. Reasoning exists only if source-exposed and is collapsed by default, otherwise `Reasoning unavailable from this source`. Tools/results and subagents expand in place or link to their item detail without losing the source anchor. Missing/truncated/rejected/lost channels show inline Content incomplete gaps and persistent section coverage notice; never pretend missing content is successful empty output. Every item has its own model/effort where evidenced, timestamp and Provenance disclosure. |
| Timeline / Activity sequence | Paged vertical event ledger with a 28 px glyph margin and a single line connecting only adjacent known-order items. Turns, tools, subagent events, compaction, timestamped model/effort switches, findings and interruption/resolution markers. Gaps break the line, labeled Content incomplete. Source order, causal relationships and deduplication come from normalized evidence, not renderer clock sorting of raw hooks. |
| Tools / Tool ledger | Tool name, approval/resolution state, args as plain text, start/duration, result/error and provenance. Nested results use bounded text slices. Unknown duration/result says unavailable with known reason, never success. Findings link to occurrences; file evidence links to Files. |
| Subagents / Subagent records | Name/type where available, lifecycle/confidence/health, its own model · effort, start/end, linked turns/tools, provenance and coverage. No inheritance of parent's model or double addition of its cost. Open detail is inline with its own paged records, not a new workspace. |
| Files / Files touched | Paged file records grouped by path, visible labels **Read**, **Write attempted**, **Write confirmed** with file glyph and explicit FileTouch evidence. No write success from invocation alone; a single file may have multiple kinds. Path wraps; evidence links to corresponding call/result. Only read native source through normal collection, never open or modify files to verify touches. |
| Context / Current context | §6.3.1. Current usage separate from cumulative consumption. |
| Cost / Estimated cost | §6.3.2. USD estimate separate from plan, credits or gateway spend. |

#### 6.3.1 Current context

Order: current model · effort → percentage + abbreviated used/window tokens → 12 px horizontal used/unoccupied meter → source, measurement/observation time and Stale if needed → context generation → category ledger → deferred ledger. Accessible text gives exact used and window integers, percent and estimate state, e.g. `Context: 20 percent; 40,000 of 200,000 tokens; source [source]; generation [generation]`. This is a synthetic numeric example only. Generation is a source generation number if available, otherwise `Generation unavailable`; never substitute a native session identifier.

Meter uses a single solid accent used segment, neutral unoccupied segment with line outline, not a colored category grid. If percentage/domain is invalid/unavailable, replace meter with `Context meter unavailable` and reason; retain individually evidenced token values. Any out-of-domain reading shows its exact number with a warning and no falsely valid meter. Used/window must belong to one eligible generation. Compaction invalidates old occupancy: show Awaiting next usage, no old meter. Eligible post-compaction postTokens can appear as `Interim after compaction` with source/estimate qualification, never a new guessed window. Model/window change starts a new generation; no old numerator with a new denominator. Claude transcript-only window and % remain unavailable until tee window evidence; agy context unavailable; Gemini stays runtime-disabled until S11, then only its tested estimate rules apply. The bundled model window cannot fill a missing Claude window.

| Group / row order (D2) | Value and count rules |
|---|---|
| Used context: 1 Messages | MVP Unavailable — composition estimates arrive in v1-B. Later labels reserved: Messages/residual ~est, Unattributed used; do not implement estimates now. |
| 2 System prompt | Same unavailable explanation unless eligible measured category data exists. |
| 3 Memory files | Tokens plus evidence/completeness-qualified file count only when supplied; no configured→loaded inference. |
| 4 Skills | Tokens/count where evidenced; otherwise unavailable. |
| 5 MCP server instructions | Explicitly separate from tool schemas. |
| 6 System tool definitions | Token value and inventory completeness; no assumed total. |
| 7 MCP tool definitions | Tokens, evidenced tool count, completeness/generation. |
| 8 Custom agents | Tokens, evidenced custom-agent count and completeness. |
| Outside used context: 9 Compaction buffer | Unavailable unless version-tested inputs/formula or eligible measurement; estimate uses ~est. |
| 10 Free space | Derived only with used, window and buffer known; otherwise `Unavailable — compaction buffer unavailable` (or exact missing input). Meter's unoccupied portion is labeled `Unoccupied; buffer unknown` when applicable, never `usable before compaction`. |
| Deferred definitions: 11 Deferred MCP tool definitions | Separate table outside used total; unavailable reason/count completeness. |
| 12 Deferred system tool definitions | Same; never included in current used composition. |

Rows always remain present. A single section explanation may describe v1-B, but each unavailable value also references it accessibly. Estimated tokens prefix ~est, exact counts stay integers; observed/partial inventories say so. Later composition must follow PRD byte/4, disjoint coverage and generation rules; if sums exceed used, show `Composition mismatch`, omit composition graphics, keep reported total, never rescale into agreement. This is a reserved extension, not MVP parsing work.

#### 6.3.2 Estimated cost

Top: Estimated cost heading, session ~$ or ~$ unavailable, covered scope, basis `Agent-reported estimate` or `Calculated from tokens`, source/time, coverage eligible/priced counts and gaps. Prefer eligible agent-reported estimate for its covered scope; never add it to a calculated copy or already-included subagents. Unknown inclusion adds `Aggregate coverage uncertain`; exclude ambiguous addition. A reported zero stays ~$0.00.

Then component table: input (uncached), output, cache-read, cache-write; Claude cache-write expands into 5 min and 1 h rows. Each row shows exact tokens, model/qualifier, applicable rate per million, component ~$ if calculable, coverage and source. Unknown price-affecting qualifiers make the affected component unavailable. Codex inclusive cached input is not priced twice; reasoning included in output is not added again. Codex cache-write and agy cost remain unavailable under their unverified relationships. `server_tool_use` and unestablished fields are not priced. Category ~est counts never become billable tokens.

Eligible agent-reported opaque totals may lack a token-component split: show the total, and `Component cost unavailable — agent estimate has no split`, without manufacturing rates. Next, a **Price provenance** list, one row per applied immutable revision: revision label, Prices as of [date], source references as text, affected scope/model/period and Owner-set fallback where applicable. Multiple revisions remain separate; editing today's table does not reprice old usage. If reported estimate carries no local revision, say `Agent-reported basis; local price revision not applied`. Coverage disclosures enumerate missing components and eligible/priced sessions; partial aggregate reads ~$… known subtotal. No eligible cost reads ~$ unavailable while tokens stay readable. Price source references do not trigger remote fetching.

### 6.4 Session list and history tools (A4 inside Session)

This is the browsing pane of **Session**, never a History navigation area. Order: Session list h2 → mode controls **All sessions**, **Live**, **Archived**, **Trash**, **Suppressed** → FTS search/Apply → Filters disclosure → Projects and folders disclosure → result records/continuation. All sessions includes live and past, including archived, but excludes Trash/suppressed; other modes restrict that scope. Live uses the same evidenced live membership as Dashboard. Pane width/stacking is §6.3; mode controls wrap, fieldsets always stack inside the 280/320 px pane. Result list has a named 288 px minimum scrollport; page main scroll handles form growth. Narrow initially uses full-width list, then opens chat as the sole visible pane. There is **no monthly chart here**; it lives only in Dashboard §6.1.1.

Projects and folders uses a paged nested semantic list with disclosures (no new tree-editing abstraction). Repository-linked projects retain worktree labels from verified common git directory per FR-53; unsupported layout retains cwd grouping with `Repository grouping unavailable`, never a guessed repository. Manual project moves win; old rows are not silently regrouped. Filters: agent, project, worktree, cwd, date range, state and model when arriving from Dashboard month detail. Cwd input is labeled and wraps in summaries. Search submits bounded FTS snippets as text, maximum 200 characters initially, with explicit continuation. `Search covers retained indexed content; incomplete sources may have gaps` remains below results. Zero matches reads `No matches. Change filters or clear search.` Applying filters/search resets only this list's cursor and focuses its result heading with count if supplied; it does not clear an open conversation outside that query. Reset keeps focus on Reset and announces changed results. Selecting a project/folder applies that filter and keeps focus on its trigger; Tab enters results. Loading never requires the whole project inventory.

Each session record retains Dashboard identity/model/status/ownership and adds folder, pin/archive, Keep/purge date and native deleted/archived markers. Title and snippet wrap within the pane; numeric values and state form stacked labeled lines, no table with hidden columns. Selecting the primary control opens the chat view. Default order is pinned first, then last activity descending with stable service key tie-break; explicit search relevance comes from the service and is labeled `Search relevance`. More actions: Move, Pin, Archive, Trash; multi-selection is not required. Trash shows deletion time and `Auto-empty [date]`, Restore and Purge; session policy Never/Keep does not stop the separate Trash timer. Opening a Trash row displays its retained read-only conversation with Restore/Purge actions and explicit Trash banner; ordinary Resume/Trash actions are disabled/not offered as appropriate to that state. Purge confirmation §5.4; Undo for Trash persists with no deadline. Suppressed mode lists locally eligible suppression metadata with Re-import; opening shows metadata/reason and Re-import, never a fabricated purged transcript. Label/count comes only from available suppression metadata with Unknown/Unavailable fallbacks. Native deleted/archived is not Xaibo Trash. Logical purge and all overlays leave native agent files untouched.

Mode controls use roving focus Left/Right, Home/End, Enter/Space to apply, aria-pressed; activation keeps focus and announces mode/count. Tab then reaches Search → Apply → Filters and expanded fields/Apply/Reset → Projects and folders and selected path → primary record/actions → Load previous/Load more. §5.2 record arrows and explicit page continuation apply. Search typing never steals focus. Selection focuses chat title; Back to session list restores the same record and scroll. Trash/restore/purge/Undo/move follow §5.4, including filters that remove a row and a deleted open conversation. On narrow, returning from a dialog to a list record also exposes the list pane; returning to a conversation action exposes the conversation pane. No restoration target may remain in the hidden pane.

### 6.5 Agent Map: hierarchy and integrations (A5, S-37)

Agent Map h1, Add agent and Rescan precede a leading pane with two wrapping local mode controls **Repositories** (initial) and **Agents**, beside the existing integration-detail pane. Repositories contains the original **text outline**, not a graphical canvas; Agents contains a separate agent/profile list, never tree roots. At ≥800 px the leading pane occupies 40% (minimum 280 px), gap 24 px, integration detail takes remaining width. At ≥1200 px cap the leading pane at 480 px. Each pane has a named scrollport minimum 288 px high; outer main scroll handles tall headings/forms. At <800 px initially show the full-width leading pane in its saved mode; Open integration in Agents opens full-width integration detail with **Back to map**. Hidden pane/mode is inert and absent from Tab order/DOM virtualization. Integration detail has no separate top-level link, page or navigation area. Selecting a session always opens Session, not an embedded second chat in the map.

Mode buttons use roving Left/Right, Home/End, Enter/Space to select, aria-pressed; focus stays on the selected button, Tab enters its tree/list. Switching modes retains each mode's bounded cursor/anchor and selection, without retaining a hidden DOM. The integration selection remains scoped to its agent/profile when modes change. Agents has one row per agent/profile: agent name, profile label (mandatory when more than one), its exact FR-06 state/icon/text, separate **Lifecycle receipt** and **Content coverage**, and **Open integration**. No profile inherits another profile's Connected state. Known Not detected catalog entries can remain, with no invented profile. Rows wrap; each Open integration is named with agent/profile, opens the unchanged §6.5.2 panel and focuses its heading. The list is paged/virtualized per §5.2: 10 agent/profile rows per page, at most 3 resident pages, explicit Load previous/Load more. No agent filter or agent-specific color is added to the outline.

#### 6.5.1 Evidenced hierarchy, counts and tree behavior

Choose a single semantic ARIA tree/outline, **repository → worktree → sessions**, with sessions from different agents together under their evidenced shared worktree. No SVG graph layer to duplicate or keep synchronized. Neutral ruled rows use the existing chevron, file, folder and branch icons, 16 px indent per depth normal, 12 px narrow, capped at 48 px; an explicit level label/breadcrumb preserves meaning past the visual indent cap. Treeitem text wraps with status on following lines; no node pills, connectors, draggable coordinates, graph zoom or agent vendor colors. Role tree with accessible name `Repositories, worktrees and sessions`; aria-level, aria-expanded only on expandable nodes, aria-selected only for selected item, stable service keys. The tree itself is its text equivalent. Agent identity/connection setup is not a tree level.

| Level / node | Evidenced content and identity |
|---|---|
| Repository root | Common git directory verification per FR-53 supplies identity; visible label is evidenced repository folder name, e.g. example-app, with project overlay label separately if different. Main checkout and linked worktrees belong to one repository only when common-directory evidence verifies. Duplicate folder names distinguished by local wrapped cwd/path detail, not guessed merging. Bare-repository worktrees use verified common directory and its folder label. No native-source writes or git commands for grouping. |
| Worktree | Main checkout or linked worktree label, full home-relative cwd and verified membership. Main checkout is a worktree-level node too. Missing label says `Worktree label unavailable` and retains cwd; a label is not inferred from a branch title. Show service-supplied unique session total, live count (same membership as Dashboard) and distinct agent names, e.g. synthetic `3 sessions · 2 live · Claude Code, Codex`. Exact totals and agent inventory come from bounded service aggregates for this worktree across agents/profiles, never loaded children. Missing evidence says Session count unavailable / Live count unavailable / Agents unavailable independently; incomplete agent inventory is unavailable, never completed from loaded leaves. No new warning rule or lifecycle is introduced. |
| Cwd fallback root | At the repository level, when no git directory or unsupported/missing/unreadable metadata, use `Folder: [cwd]` instead of repository/worktree assertions. Show `Repository grouping unavailable — [reason]` (or `No git directory observed`), sessions directly beneath; never create a guessed repository node. A missing cwd is `Cwd unavailable`, with provenance reason; do not merge unrelated missing-cwd sessions into an inferred repository. |
| Project override root | At the repository level, `Project override: [owner-set label]` is owner organization, not native repository evidence. Children are evidenced worktrees, each visibly qualified by its repository, or cwd-fallback groups; different repositories/worktrees never merge just because labels match. Actual repository/cwd provenance remains visible and unchanged. |
| Session leaf | Native title/Untitled, **agent name in text and profile when more than one**, lifecycle + spelled confidence + health, ownership, model · effort, last activity, project/cwd detail and findings. Agent is never inferred from cwd/model. Enter/Open in Session navigates to §6.3 chat. No connection buttons are nested in the treeitem. |

Manual project moves win over automatic grouping: explicitly moved sessions appear once under their root-level Project override and its evidenced worktree/cwd child. Do not also count/display the moved session under its former automatic project branch; aggregate counts use this same displayed scope. Existing rows retain their approved pre-change grouping per FR-53/Q24; no retroactive guess or session identity change. Collapsed nodes distinguish `Sessions [exact total]` from `Observed [loaded count]; more available`; totals come from bounded service aggregate queries, not summing loaded children. Unknown count is `Session count unavailable`. Parents count unique descendant sessions in their scope, never add repository/worktree counts as sessions.

Bounded expansion: fetch **10 repository-level roots per page**, including repository, cwd-fallback and Project override groups; **20 worktree/cwd children per branch page**; **50 session leaves per page** (hard service cap 100). All descendants collapsed initially. At most **four expanded leafward paths**, each with at most **three resident child pages per node**, retained in renderer; the root page cache is also limited to three pages. Expanding a fifth path first collapses/evicts the least recently visited path that contains neither focus nor the new path's ancestors, announcing its label; if no such path exists, require `Collapse another branch to expand this one` rather than dropping focus. Branches share ancestor pages instead of duplicating them. Depth is bounded by the fixed schema: repository/worktree/session, cwd-fallback/session, or Project override/repository-qualified worktree-or-cwd/session; no arbitrary recursive catalog input. Virtualize flattened visible nodes per §5.2; never recursively fetch all descendants or aggregate all history in renderer. Collapse discards child rows/pages after caching bounded cursor/anchor metadata; prior child cursor can be loaded explicitly. Root/branch paging ends in an explicit synthetic treeitem `Load more [groups/worktrees/sessions]` and, after eviction, `Load previous …`; it has a button-like action but **no nested button**. Enter/Space fetches, focus stays there, announcement gives new count; next Down reaches the first appended node. On failure same item becomes `Retry loading …`, no lost cursor. It never contributes to counts.

Keyboard: Tab enters the one roving treeitem. Up/Down moves between loaded visible nodes; Right expands a collapsed branch (bounded page fetch) or moves to first child; Left collapses an expanded branch or moves to parent. Home/End move to first/last loaded visible item, not unloaded archive. Space toggles branch expansion without selecting; Enter selects a repository/worktree/cwd/override group in place to expose its provenance/count summary, or opens a session in Session. Group detail stays immediately below the tree; Tab reaches its detail controls; no new panel/workspace. Visible **Open in Session** outside the tree applies only to a selected session leaf and offers the same behavior to pointer users; **Open integration** belongs only to Agents list rows. Clicking chevron only expands; clicking node label selects/opens as Enter. Loading expanded node keeps focus on node; failed child page shows named Retry and preserves siblings. Typeahead matches loaded labels only, never downloads a whole tree. Escape closes a node's open provenance disclosure, otherwise no destructive action.

Back to map/Close integration restores Agents mode and its exact originating agent/profile row/action and scroll; when removed use next/previous row then Agents heading. A panel opened from Dashboard instead preserves its Dashboard invoker and prior Map mode/anchor independently; Back to map restores that prior Map state, Return to Dashboard restores that invoker. Return from Session restores Repositories mode, source leaf and path; if deleted, parent worktree/cwd/override node; if moved, same leaf at its newly evidenced path only when service can resolve it boundedly, otherwise prior surviving parent with an explanatory notice. Before collapsing a focused descendant or evicting a path, focus its surviving ancestor; selection remains distinguished from keyboard focus. Service restart retains cached hierarchy/Agents rows with Last known/Stale time, no unqualified Connected/live claim. Narrow keeps the same mode controls, arrow model and word labels, caps indent and wraps cwd/status, with no horizontal canvas scrolling.

#### 6.5.2 Selected integration panel and Add agent (A5)

Panel heading `Integration: [agent]` and selected profile, Back to map, then agent/profile ruled sections (not logo cards). Each: name/version/profile; state; **Lifecycle receipt** and **Content coverage** separate; last receipt/source/time; Connect, Disconnect and Full Uninstall as applicable; separate default-off Claude statusLine tee and Codex notify-wrapper actions; sign-in method declaration fieldset. A multi-profile agent panel uses a labeled native Profile select, preserving scoped declarations/previews; it never applies one profile's edits to every profile. At panel width ≥640 px facts/actions may use two columns; otherwise stack, including every narrow case. No selection reads `Choose an agent to review its integration`; Add agent/Rescan remain usable. Real-profile Connect is unavailable until Gate 6 authorization; design approval is not permission to install.

| Integration state | Glyph / foreground | Meaning and next step |
|---|---|---|
| Detected | file / muted | Executable evidence only; Review setup, not Connected |
| Setup required | settings / warning | Show unmet prerequisites; copy-only hints |
| Awaiting trust | permission / warning | Hooks configured but not trusted in Codex; guided step below |
| Connected | link / success | Eligible test event receipt verified; content coverage still stated independently |
| Partial coverage | finding / warning | Receipt present with named content/lifecycle gaps; review coverage |
| Unsupported version | unknown / warning | Tested capabilities unavailable; version evidence and copy-only instructions |
| Not detected | unknown / muted | Rescan or Set path; configuration existence is not executable proof |

**Add agent** opens within Agent Map's integration-detail pane as a labeled wizard region: (1) Rescan and candidates, detected first, then Not detected; (2) prerequisites and capability coverage; (3) select profile/path and requested grants; (4) config diff preview; (5) receipt test; (6) result. Narrow switches to that pane with Back to map. A Next/Back footer stays in the region, no new workspace. On step change focus its heading; cancellation restores Add agent. Success focuses the selected agent/profile integration heading, with its matching Agents row selected but no automatic repository expansion; Back to map exposes that row. Imported catalog-entry action uses a native file picker for a private local data file; validation errors list field/reason, never run code. Imported entries cannot shadow bundled IDs; executable probes, profile roots, config writes and launch each require their corresponding grant. Copy install hint copies text only; no Install button, package runner or shell execution. Set path field errors retain edit text and prevent probes until validation.

Before **every** Connect/Disconnect/Uninstall/tee/notify or other integration config write, show §5 diff dialog: change item selection, source profile, unchanged/added/removed lines, conflict list, effects, Cancel and Apply selected changes. Claude cleanupPeriodDays increase is default checked but deselectable, target max(effective,45), never lower or override managed policy; explanation notes native availability is separate and not guaranteed. agy has no retention-setting offer. Gemini retention offer remains hidden until API-key/Vertex S11 verification; all Gemini runtime capabilities remain disabled until their own checks. Tee and notify wrappers are separate explicit opt-ins, never bundled into Connect. Preview confirms existing foreign commands stay preserved; invalid configuration refuses before Apply; hash mismatch requires fresh preview, no overwrite. Backups/manifest are private and not exposed as transcript content.

Codex guided trust state: `Hooks installed, awaiting trust` + numbered instructions: open Codex's own hook review for this profile, review the listed Xaibo hooks there, approve there, then return and test receipt. Xaibo offers `Test receipt` (wait for eligible local hook/report event, never invoke a model or synthesize success). No trust bypass button, trust-hash write or automatic approval. Changed command requires renewed native trust. While no receipt: `Waiting for test receipt…`, status Awaiting trust/Setup required as evidenced; timeout `No receipt observed. Check trust and profile, then retry.` Detection or config write alone never sets Connected.

Sign-in fieldset: Use agent evidence (default when no declaration), or owner declaration select Subscription / API key / Cloud provider / Gateway / Mixed / Unknown; Save declaration and `Declare account change`. Show evidenced value/source/time and owner-declared value/time simultaneously if they disagree. Owner declaration wins until changed; explicit account change starts a new epoch and separates history. This reads no credential/auth/config files or environment for sign-in detection and never merges scopes. No key input exists in MVP.

Tab order: Add agent → Rescan → Repositories/Agents mode control → active outline roving treeitem then selected-leaf action/group provenance, or Agents list roving row then Open integration/continuation → panel Back to map/Profile select → per-profile coverage disclosures → Connect/Disconnect/Uninstall → opt-ins → declaration controls. Wizard follows step order; preview follows item checkboxes → named diff scrollport → conflicts → Cancel/Apply. Modal and success focus targets §5.4. Dashboard Review integration opens the matching panel, preserving Dashboard source and map state, with Return to Dashboard beside Back to map. Narrow: full-width wizard/panel/preview, one-column unified diff with wrapped lines; no side-by-side diff requiring horizontal scroll.

### 6.6 Settings (A6)

Single column main scroll; heading, then grouped ruled form sections in order below. Labels above fields, explanations adjacent; content maximum 880 px. At ≥800 px labels/explanation use 240 px leading column and controls remaining width; narrow stack. Each independent section has Save and last-saved state; no global Save that silently applies unrelated settings. Validate through service settings schema; defaults are display of stored values, not inferred from missing data.

| Section | Controls / exact behavior |
|---|---|
| Session retention | Radios 45 days (default), Never, Other; Other integer N days ≥1 subject to service bound, invalid stays unsaved. Explanation: Xaibo permanently purges eligible inactive unkept history N days after last activity; active/Keep excluded. Session headers show actual purge date. |
| Trash | Auto-empty displays 30 days default; editable whole days ≥1 only if service supports configured policy; otherwise fixed explanatory 30 days. Never/Keep above does not affect Trash. |
| Storage | Used bytes total and measured breakdown: sessions/content, search indexes, usage/context/cost tables and indexes, retained price provenance, spool/backups where measured. Meter labeled `Storage used`, never invented disk capacity; show reported capacity only when measured. Unknown categories Unavailable; no synthetic sum from overlapping measurements. Fixed account usage retention 45 elapsed days, independent of Keep/Never; monthly totals no automatic expiry. |
| Local prices | Current revision + Prices as of [date], bundled/override source; Reveal override file, Validate, Reload. No pricing editor or network refresh. Validate reads private file and shows schema/error code without switching revision; Reload accepts valid immutable revision or retains last valid revision, including across restart, with error banner. Absent override uses bundled table. Missing file Reveal opens its app-data folder with `No override file yet`. |
| Owner-set fallback | Reveal same override file; show read-only current exact model/optional agent scope and rates plus Owner-set fallback. Owner edits scoped rate in that file, then Validate/Reload. No family guess, automatic fallback or additional editor. |
| Usage history | Clear usage history button, §5.4 confirmation. Explains frozen monthly totals plus prior-observation exclusion, new observations still eligible; not a session purge or quota reset. |
| Appearance | Read-only `Appearance: Light / Dark · Follows macOS`; no switch (D7). |
| Startup | Start at login checkbox, off by default; Save, platform failure inline. Closing window leaves collection running; Quit stops it. |
| Status thresholds | Labeled number fields: Turn settle (seconds, default 4); Heuristic wait (seconds, default 5); R1 no-progress (minutes, 5); R2 consecutive tool repeats (4); R3 consecutive errors (3); R4 cycle repeats (3; sequence length 2–3 fixed); R5 tool duration (minutes, 10). Also show service-supported live-window/reconciliation settings only as supplied, not new fields invented here. Integers ≥1 for repeat counts; times >0, bounded by service schema. Preview saved values/units; errors never silently clamp. Suspended time exclusion explained. |
| Notifications | Read-only policy: confirmed permission/input requests only, text limited to agent, approved project label or Project, state. No content opt-in. Show known limitation `macOS notifications may be unavailable in unsigned builds; use Needs attention in the app` (D-P3-22). No notification preferences beyond supported OS permission/status; do not add an unimplemented toggle. |

Settings Tab order follows section order, field order then Save; price actions Reveal → Validate → Reload; confirmations return to invoking button. Save keeps focus on Save and politely reports Saved; failure focuses first invalid field, or error heading for service failure. Storage refresh is passive service data, no model/quota request. Narrow retains every explanation/rate provenance, with wrapped tables converted to labeled records. Invalid price file never hides the last valid revision/value.

### 6.7 Launch dialog (A7, Phase 7)

Launch starts from Session's Launch button; Resume/Fork/Open in VS Code start from the open-session header or its Session-list action. Dashboard/Agent Map session actions first open that session in Session, then offer these actions; they do not introduce a second launch surface. Launch opens a form dialog, initial focus Agent. Vertical order: Agent select → Profile → Project → cwd → capability explanation → **Command preview** → Cancel / Launch in terminal. Cwd is explicit, defaults only from chosen evidenced project/profile and is editable; no guessed cwd from title/content. Validate executable/native IDs/cwd/grants before enabling action and again at execution. Preview is read-only wrapped monospace in a named text region: executable and each whole-argument token individually platform-quoted; show working directory separately. Never interpret pasted shell fragments, substitute a raw prompt/title or allow shell/interpreter command templates. Exact command comes from the validated launch layer, not renderer string assembly. Show environment grant key names only, no credential values.

Disabled options remain visible with reasons: `agy interactive launch not verified`, `Gemini interactive launch not verified` (API-key/Vertex catalog eligibility still applies), `Custom resume unsupported` where applicable; only a recorded compatibility pass enables them. Headless mode is never an interactive fallback. Optional new worktree is v1-A S-39, note only; no controls/layout now.

On accepted spawn close dialog, add `Starting…` provisional row to Session's list and open its status-only detail, focusing `Starting…` detail heading. Narrow exposes that detail pane; Back to session list reaches the provisional row. It is not a fabricated native session, chat response or Controlled here. Evidence binding replaces provisional identity/detail with the evidenced conversation without losing focus anchor; externally launched sessions are Observed externally. Dashboard may mirror the service-supplied provisional observation, but launch success never navigates away from Session. Failure leaves provisional error detail with Retry launch (prefilled dialog) and Remove provisional row; no retry loop. Removing it returns following/previous/list heading and exposes list on narrow. Unbound launch remains Starting… with elapsed time and `No session evidence yet`; never claim Ended from timeout. Cancel restores exact Session Launch/Resume/Fork trigger; window close before submission behaves as Cancel. Narrow uses standard viewport-bounded dialog, wrapped preview and scrollable body, footer visible.

### 6.8 Concurrency warning (A8, Phase 7)

From Session's Resume action, before any resume where live elsewhere or liveness uncertain, modal title `Resume may create concurrent work`. Text identifies agent/project (local UI may include title/path), last known state/confidence/health/time and `Silence does not prove the session is safe to resume.` Options in order: Cancel (initial focus), Open in VS Code, Fork instead, Resume anyway. Alternatives unavailable for that capability stay disabled with an adjacent reason; an unverified VS Code route never appears as a working escape hatch. Proceed rechecks native availability, grant and ownership immediately before launch. No checkbox to permanently suppress this warning.

Cancel/Escape restores Resume. Open in VS Code closes only after a successful supported handoff and returns focus to Resume when window returns; error stays inside dialog. Fork/Resume spawn use §6.7 provisional anchor. Narrow is the same dialog, buttons stack, never hide the explanation below an inaccessible footer. No cost or context estimate is implied by concurrency.

### 6.9 Ownership badge (A9)

Use §3.2 on every session row (Dashboard/attention, Session list/chat, Agent Map leaves, Trash, search, subagent session links and provisional bound result) and header. 16 px icon + exact words; no hover/active state for the static badge. Explanation disclosure `About ownership` reads `Observation does not grant control. Sessions opened in an external terminal are observed externally, including launches from Xaibo.` Before evidence binds a provisional row use `Ownership unavailable — awaiting session evidence`; it is not yet a session. Unknown or stale authority disables control, not observation. Narrow wraps badge as a whole phrase; font never shrinks. Badge is static readable text, with the separate explanation in Tab order; Close explanation restores its trigger. Detached always includes the visible field label `Ownership: Detached`; the separate health field reads `Health: Detached`. Health Detached is never substituted for ownership without authoritative ownership evidence.

### 6.10 Tray and notification copy (A10)

Tray uses original mark; OS renders menu, spacing, fonts, colors and focus. Items, order: **Open Xaibo**; disabled informational **Collection: Running / Starting / Restarting / Stopped**; separator; **Quit Xaibo**. No session content or counts in tray. Opening returns the existing window; if newly created focus Dashboard h1, otherwise restore last focused valid control. Window Close hides without quitting or losing active section/anchor; Quit stops collection. MVP has no live PTY quit warning (embedded terminal is later).

Notification title only: `[agent] · [approved project label or Project] · Waiting for permission` or `[agent] · [approved project label or Project] · Needs input`. Body empty. No prompt, title, cwd/path, native ID, tool content, model, cost or heuristic state. Generic Project is mandatory until a label is set/confirmed in Xaibo. The queue is the reliable in-app counterpart; unsigned-build limitation appears in Settings. Deliver only new confirmed requests according to service deduplication, not replays/expired waits. macOS supplies notification UI; no custom toast pretending to be an OS notification. No additional notification actions in MVP. Menu keyboard behavior is native; no DOM contrast claim for OS-rendered colors.

### 6.11 App-wide patterns (A11)

Shared collection band, restart/read-only failure, dialogs, Undo, virtual focus and navigation are §5 and §6.0. Service down never replaces the entire window with an error page: readable cached sections remain with Last known/Stale labels, mutations disabled with reason. First run when no data is cached shows `Collection is starting` plus Open Agent Map action; actual Stopped/failed state shows `Collection unavailable` with fixed error code and Retry connection (local service reconnect, not model call). Recovery announces once and resyncs without losing focus. If saved record no longer exists, a local `Session unavailable` block offers Back to source list and explains deletion/suppression only when evidenced. App-level error details show allowlisted error codes, not raw stack/path/secret dumps.

### 6.12 Later surfaces: notes only (A12)

No layouts or MVP navigation entries for the following. Each requires a small Codex design delta, Claude review and owner approval before implementation if existing components are insufficient (OQ-X12).

| Later capability | Binding note / reusable patterns |
|---|---|
| Compare S-16 | Label `observed workload, not a quality benchmark`; reuse filters, numeric tables, coverage and chart; account quotas separate. |
| Skills/MCP inspector S-17 | Configured / Loaded / Called / Unknown are evidence levels; text mentions do not establish activation; use evidence disclosures. |
| Embedded terminal S-20 | Future input attaches below Conversation’s read-only utility row (§6.3); preserve the Conversation, Timeline, Tools, Subagents, Files, Context, Cost index. Later terminal panel; external launch is MVP. Requires separate terminal/quit/focus design delta. |
| MCP grant UI S-21 | Reuse scope fieldset and confirmation; disclosure that agent/provider may receive results and masking is best effort; no grant layout now. |
| Usage broker S-41 | Off by default, per-profile/provider disclosure names host, credential source, data, interval and global off action. CRED applies; key entry one-shot broker channel and displayed only as a 4-character suffix; no key input layout now. |
| Local diagnostics S-44 | Content-free local metrics, masked owner export only; reuse detail tables and error blocks. |
| Orchestrator S-42 | Owner grants/limits, stop threshold is not a hard budget; control/kill switch design later, no MVP control addition. |
| Guard hook S-43 | Separate opt-in, selected risky tools, reason, deadline/fail-open; reporting stays silent; no rules editor now. |
| Context composition v1-B | Reserve category row space for Messages/residual ~est and Unattributed used (§6.3.1); no heuristic composition parser in MVP. |

### 6.13 Empty/loading/error/stale/unavailable/estimate contract (B1–B6)

This table applies to **each** surface, in addition to its detailed content above. Use §5 block/badge/banner styles and exact formatting in §7. A state that cannot apply is explicitly marked N/A; it never becomes invented data. B4 collection staleness has no arbitrary renderer timeout: use service health; B4 usage is >15 min without a newer eligible measurement. No loading state fabricates values or blocks another region.

| Surface | B1 Empty | B2 Loading | B3 Error | B4 Stale | B5 Unavailable | B6 Estimate |
|---|---|---|---|---|---|---|
| A1 Dashboard (Live sessions / Usage and history) | No sessions yet → Add agent in Agent Map; no agents → Open Agent Map. Scope list says No usage observations yet. | Static Loading sessions/Detecting agents/Loading usage independently; preserve painted rows and local view/anchor in the main scrollport. | Collection banner or failed-region Retry; list stays usable. | Last known live-set totals + timestamp, stale rows/scopes; no unqualified live. | Context/cost/window unavailable with source-specific reason, never zero. | Summary/row/scope ~$ and ~est with coverage; partial known subtotal. |
| A2 Dashboard attention | Nothing needs attention → Live sessions view, saved live anchor retained. | Loading attention records; switching to Live sessions remains available. | Could not load attention → Retry, existing records retained. | Last known needs attention + clock-gap/time. | State/since unavailable stays Unknown with evidence reason; no made-up onset. | No cost quantity here; N/A. Heuristic state remains Probably waiting, not numerical estimate. |
| A3 Session Conversation/Timeline/Tools/Subagents/Files/Context/Cost | Choose a session; no recorded turns/tools/files/subagents explains source/coverage. No composer or fake prompt. | Header/selected detail independently; first opening loads latest page for live, first turn for ended/historical. Go to first turn/latest loads only its target; browser remains usable. | Failed chat slice Retry inline; Session unavailable offers Back to session list or Return to source. | Header health and usage times; old context generation never current. | Content incomplete inline gaps; Model unavailable; reasoning/context/cost explanations, no invented agent reply. | Context ~est, cost ~$ known subtotal/provenance; historical exact text stays exact. |
| A4 Session list/history | No sessions / Trash is empty / no suppressed records / no search matches, with Reset/Add agent/collection guidance as relevant. | List/search/project pages independently; keep open chat/previous results. | Could not load results → Retry same cursor; no replacement of open chat. | Query snapshot Last loaded [time] when service lost; records Last known. | Native gone marker, unavailable snippet/source, purged content never reconstructed. | Session ~$ with coverage; exact tokens alongside; no aggregate computed from loaded list. |
| A5 Agent Map Agents list / integration | Choose an agent/profile from Agents; none detected → Rescan/Set path/Import entry. | Loading Agents page / Detecting / Applying changes / Waiting for test receipt, never Connected early; repository tree remains independent. | Validation/transaction/conflict/receipt failure keeps preview/last valid state; fresh recheck before Retry. | Last receipt time + Stale; refresh evidence via passive receipt/rescan only. | Unsupported capability/sign-in Unknown with visible reason. | No cost/context quantity in setup; N/A; coverage never guessed. |
| A6 Settings | No measured storage / No override file yet; reveal folder or wait. | Loading settings/storage/Validating; fields not reset. | Invalid override retains revision; failed Save preserves edit/reason. | Last measured storage time; old price date stays Prices as of, not stale-market claim. | Unsupported storage/setting Unavailable, disabled writes in read-only mode. | Measured bytes only; any displayed cost/fallback amount retains estimate semantics. |
| A7 Session Launch | No launchable agent → Review Agent Map integration, Cancel. | Validating launch / Starting…; prevent duplicate spawn. | Field/grant/spawn failure in dialog/provisional detail, no false bound session. | Revalidate old profile/capability evidence; service down disables Launch. | Disabled agent/resume/native gone with reason. | No launch spend projection, N/A. |
| A8 Session concurrency | No liveness evidence → uncertainty text, never empty safe state. | Checking availability; Cancel before spawn. | Could not verify explains uncertainty; spawn failure stays in dialog. | Last state/time visibly stale; silence not safe. | Missing liveness/unsupported alternative explained. | No numeric estimate, N/A. |
| A9 Ownership | Before binding → Ownership unavailable. | Awaiting session evidence, static text. | Could not verify; disable control. | Last verified time, no inferred new authority. | Ownership unavailable + reason; Detached only evidenced. | Never estimated; N/A. |
| A10 Tray/OS copy | No sessions does not alter menu; no empty notification. | Collection: Starting; no loading notification. | Collection: Stopped/Restarting; Settings notification hint. | Never Running when disconnected; qualify last-known state. | Collection: Unknown if unknown; omit notification absent confirmed request. | No estimated quantities, N/A. |
| A11 Global | Missing destination → Back/Dashboard/Agent Map. | Static initial service status, frame retained. | Persistent collection/read-only banner, guarded actions. | Cached content Last known + time. | Fixed error code or detail unavailable, no raw exception dump. | Reused estimates keep label; health never estimated. |
| A12 Later notes | N/A: no implemented surface designed. | N/A: later delta. | N/A: later delta. | Later delta inherits explicit freshness. | Notes retain capability Unknown/limits. | Later Compare/context inherits ~$ / ~est, no invented values. |
| D-PD-01 Dashboard scope history | No observations for day; known gap reason; no zero/backfill before tee. | Loading day/page only; current scope stays, saved Live sessions state and view control remain usable. | Retry day/page with prior observations retained. | Historical records keep original measurement times; collector loss marks last-loaded coverage, not old records as current. | Missing source time/scope attribution explicitly unknown; gaps not interpolated. | Any cost in provenance uses ~$; quota readings stay reported, never inferred from tokens. |
| D-PD-01 Dashboard monthly chart | No observed months yet → collection guidance; months before first observation absent. | Chart/table page Loading months; Live sessions collection continues and its view stays reachable. | Retry same month cursor, old page retained. | Last calculated [time] on collector loss; totals never advertised live then. | Missing month No observations; totals-only detail labels; no eligible cost unavailable. | Every cost bar/table value ~$ with coverage/price provenance and known subtotal where partial. |
| D-PD-01 / D-PD-02 Agent Map hierarchy | No observed repositories/folders → Open Session or wait for source; branch No sessions yet. No agents detected is a separate Agents list state → Add agent/Rescan; known Not detected entries may remain. | Loading children under that branch only; other paths usable. | Retry loading [children] in place; preserve siblings/path/focus. | Last known hierarchy/state + timestamp; no unqualified live/Connected claim on collector loss. | Unreadable/missing/unsupported worktree metadata → cwd group + reason; no guessed repository/count. | Worktree session/live counts and distinct agent inventory exact from service or independently unavailable, never summed from loaded leaves; loaded-child counts are explicitly Observed, not totals; no estimated topology. No cost values here, N/A. |

## 7. Formats and fixed labels

### 7.1 Formatting contract (D1, D3)

UI language is English. Numeric formatting uses `en-US` grouping/decimal punctuation explicitly, with tabular digits. Display times use the owner's current local time zone; always expose absolute time and offset in details and accessible text. Monthly accounting buckets use their stored event-time local month/offset; changing the viewing zone never silently rebuckets frozen totals. No format needs a model or network call.

| Quantity | Visible format / rounding | Accessible text and edge cases |
|---|---|---|
| Exact number / count | `12,000`; integers, no decimals. Percent coverage one decimal only when not integral. | Full integer and unit; unknown is Unknown/Unavailable with reason, not a dash. No negative count used to represent missing. |
| Tokens (D1) | Below 1,000 full integer; ≥1,000 use k, ≥1,000,000 M, ≥1,000,000,000 B; one decimal, round half up, omit trailing .0. Promote suffix if rounded value reaches 1,000 (999,950 → 1M). Synthetic examples: 12,000 → 12k; 1,200,000 → 1.2M. | Always exact integer tokens in accessible name and Details, even when abbreviation appears in row. Estimated category tokens explicitly `~est 12k`; accessible `Estimated tokens, approximately 12,000`, not an exact measurement. |
| Context | `20% · 40k / 200k`; percent to one decimal, drop .0. Nonzero <0.1% reads `<0.1%`; no forced zero. | Exact used/window integer values, source, estimate state, generation/freshness. Percentage unavailable retains known integers individually. |
| Estimated USD | `~$0.00` for valid zero; nonzero <0.01 `~$<0.01`; otherwise two decimals, half-up. A positive value never renders ~$0.00. Thousands comma-grouped. Partial suffix `known subtotal`, no eligible `~$ unavailable`. Details preserve source numeric precision without claiming billing accuracy. | Every occurrence has accessible text starting **Estimated cost**, including each row, total, chart value, tool detail and component estimate. Example `Estimated cost: less than 0.01 US dollars; known subtotal; [coverage]`. Numeric zero: `Estimated cost: 0 US dollars`. Unavailable: `Estimated cost unavailable: [reason]`. The tilde is never the only estimate cue. |
| Price rates | Exact source decimal rate, USD per 1,000,000 tokens, no k/M cost rounding; label `Price rate`, not session cost. | Name scope/model/component, currency, unit and revision. These are table rates, not a calculated bill. Owner-set fallback visible. |
| Credits / gateway spend | Source units/currency, supported source precision, words Reported credits / Reported spend limit; no conversion to cost. | Source/time and scope; percentages may exceed 100. Never add to ~$ session totals or imply subscription balance from a cost estimate. |
| Clock time | `HH:mm` 24-hour, local. Reset same day: `Resets HH:mm`; other day: `Resets YYYY-MM-DD HH:mm`. | Absolute `YYYY-MM-DD HH:mm:ss UTC±HH:mm` plus zone label in detail; no ambiguous reset on a different date. Unknown reset has no countdown. |
| Last activity / since | <60 s `Just now`; <1 h `[n] min ago`; <24 h `[n] h ago`; thereafter local date/time. Relative units floor elapsed magnitude. Queue Since includes clock/date immediately plus elapsed duration. | Absolute source time always available in detail/name. Future timestamps say `Source clock ahead · [absolute time]`, never a negative “ago”. Unknown onset is Since Unknown. |
| Duration | <1 s `<1 s`; <1 min `[n] s`; <1 h `[m] min [s] s`; <1 day `[h] h [m] min`; ≥1 day `[d] d [h] h`. Floor units, retain exact milliseconds in detail. | Full words, e.g. 5 minutes 0 seconds. Unknown/ongoing labeled; never zero to imply no data. |
| Countdown | `in [h] h [m] min [s] s` (omit zero leading units, retain seconds); ≥1 day `[d] d [h] h [m] min`. Positive <1 s `in <1 s`. | Update at most once/second while window visible using local clock; not a live region. At reset replace current % and countdown with Reset passed; awaiting observation, never −1/0% fabricated. |
| Date | `YYYY-MM-DD`; full date/time in details. Purge and auto-empty show date and time in disclosure, date in row. | Read date as words in accessible label; distinguish scheduled from completed deletion. Never call retention a backup guarantee. |
| Month | `Jan 2030` style English short month + four-digit year; exact bucket `2030-01` and recorded offset in detail. | Current bucket appends month to date. No before-first-observation months; No observations is not zero. |
| Source freshness | Known: `Measured [absolute time] · observed [absolute time]`; unknown: `Source time unknown; observed [absolute time]`. | Claude statusLine **always** unknown-source-time wording, including cost/context/quota records. Stale glyph + Stale + time after >15 min without eligible newer measurement; repeated cached emission is not new measurement. If source measurement is unknown use first observation of that measurement's unchanged identity for age and show latest receipt separately as receipt only. |

Live relative/countdown text updates do not announce every second; source/state transitions announce through one batched polite region. Suspend/resume recomputes local countdown and service freshness, never requests quota. `~est` is the visible suffix/prefix for estimated token/context values; do not use it for cost (which already uses ~$ and Estimated cost). Exact measurements are not relabeled estimated because they are old; they become stale.

### 7.2 Fixed-label placement and accessible copy (C1–C34)

All labels below are literal, case and ellipsis included. `[value]`, `[model]`, `[effort]`, `[time]` and `[date]` are substitutions, not on-screen brackets. Every named component follows §5 states; all use semantic foreground on a neutral background. Static text is its own accessible text unless an expansion is given. No additional tooltip is required to discover it.

| ID | Literal label / pattern | Component, position, style | Accessible text |
|---|---|---|---|
| C1 | Probably waiting | Status line in live/attention/header; permission/input + warning | Probably waiting, heuristic; never OS notification |
| C2 | Finishing… | Reason after unchanged lifecycle; settle/muted | Finishing, turn settling; existing lifecycle/confidence still read |
| C3 | Background work | Busy reason in row/header; branch/accent | Background work |
| C4 | Unknown | Lifecycle/sign-in and later inspector field; unknown/muted | `[field]: Unknown`; lifecycle also confidence |
| C5 | Model unavailable | Model position in row/header/delegate/agent model list; muted | Model unavailable, no model evidence |
| C6 | `<model> · <effort>` | Model position; ink, effort muted; e.g. Opus 5.5 · high; raw reported ID fallback | Model [model], effort [effort]; omit entire effort separator when absent |
| C7 | ~$… | Summary/row/Cost/month values; tabular ink | Estimated cost: [amount] US dollars, plus scope |
| C8 | Estimated cost | Visible Cost/summary headings; accessible prefix on **every** ~$ instance | Estimated cost [value/unavailable and coverage] |
| C9 | ~$… known subtotal | Partial session/aggregate/month value; warning coverage disclosure adjacent | Estimated cost: [amount] US dollars, known subtotal, [coverage] |
| C10 | ~$ unavailable | Normal value position, muted + information glyph, reason below | Estimated cost unavailable: [reason] |
| C11 | Owner-set fallback | Applied rate/revision row in Cost and Settings; warning badge | Owner-set fallback, [exact configured scope] |
| C12 | ~est | Estimated token/context number, same line, muted | Estimated [quantity], approximately [full integer] [unit] |
| C13 | Content incomplete | Conversation/Timeline gap and section banner; finding/warning | Content incomplete: [named missing channel and reason] |
| C14 | Transcript only, not resumable | Session header under native availability; Session list row detail; information/muted | Transcript only, not resumable; [native availability evidence] |
| C15 | native deleted/archived | Session list/open-session native-state marker, not overlay state; file/muted | native deleted/archived; native file-state evidence [detail] |
| C16 | Account scope unverified | Scope heading/observation/quota-peak row; finding/warning | Account scope unverified; observations kept separate |
| C17 | Unavailable from passive sources | Unsupported quota/context field in scope/Context; information/muted | Unavailable from passive sources; [agent and capability] |
| C18 | Source time unknown; observed … | Every Claude statusLine-derived reading's provenance line; muted | Source time unknown; observed [absolute local time and offset] |
| C19 | Reset passed; awaiting observation | Replace current quota utilization/countdown, clock-gap/warning | Reset passed; awaiting observation; last reset [time] |
| C20 | Stale · [time] | Clock-gap + timestamp beside health/reading, warning; unknown source time retains C18 | Stale, last eligible measurement/observation [absolute time] |
| C21 | Awaiting next usage | Context value/meter replacement following compaction; hourglass/muted | Awaiting next usage after compaction |
| C22 | month to date | Current month axis caption, numeric table row, detail; muted | [month], month to date |
| C23 | some details expired | Month detail-state line beneath numeric value and table; information/muted | [month], some details expired |
| C24 | details expired, totals only | Month detail-state line/table; information/muted | [month], details expired, totals only |
| C25 | Source format drift detected | Dashboard banner above quantities; affected session detail; finding/warning | Source format drift detected for [agent], [known impact], observed [time] |
| C26 | Coverage gap | Banner heading above quantities; per-reason agent rows per §6.1; finding/warning | Coverage gap: [reason], [agent], [interval or unknown], [count if known]; explicit cap caveat |
| C27 | Observed externally / Controlled here / Detached | Ownership field on every row/header, §3.2; Detached always visibly prefixed Ownership: | Ownership: [exact label] |
| C28 | R1 Possibly inactive; R2 Repeated tool; R3 Repeated error; R4 Possible loop; R5 Long-running tool; expected inactivity; long-running tool | Finding disclosure after status, §3.3; finding/warning | Show evidence for [rule and visible wording]; alternatives retain rule ID |
| C29 | Untitled | Primary row/header title when no native title; ink, ordinary weight | Untitled, [agent], [project], open session (button only) |
| C30 | Prices as of … | Each applied price revision and Settings current table; muted | Prices as of [date], revision [revision] |
| C31 | observed workload, not a quality benchmark | Later Compare disclosure note §6.12; no layout now | Same words; later mandatory visible qualifier |
| C32 | Starting… | Provisional Session launch record, hourglass/muted | Starting [agent], awaiting session evidence |
| C33 | Messages/residual ~est; Unattributed used | Reserved later Context ledger labels §6.3.1; no MVP values | Estimated residual messages; Unattributed used context; later quantity/coverage |
| C34 | Project | OS notification project slot and attention approved-label slot until confirmation; ink | Project (never derive notification label from path/title) |

## 8. Accessibility and pair inventory

### 8.1 Applied screen requirements

| Surface | Semantic structure / names (F1–F4) | Focus and reflow verification (F5–F6) |
|---|---|---|
| Four-area frame | Nav links Dashboard, Session, Agent Map, Settings; aria-current; headings below collection band. | §5.3/§6.0 destination focus; natural-width links wrap with a fifth fixture link without adding a real fifth area. No focus ring clipped by wrapped nav. |
| Dashboard + attention + scope history | Main h1, named lists/definition summaries and local Live sessions/Needs attention/Usage and history controls; full status/confidence/health words; named scope history day controls; separate live regions. | §6.1–6.2 single main scrollport, compact two-line/full narrow rows and Session details disclosure; local view/source anchors restored on Return from Session/Map; scope Close/day/page targets; live regions unaffected by chart fetch. Narrow preserves all fields. |
| Dashboard monthly ledger | Chart title/description, visible number every bar/point, exact semantic table; distinct quota peaks; no chart in Session list. | §6.1.1 metric/filter/page/month/detail order; retained-session link goes to Session query then Return to Dashboard month; narrow 3-month subdivision/reflow. |
| Session chat/open detail | Session h1 and selected title h2; Conversation role labels Owner prompt/Agent response; collapsed Available reasoning/tool result controls; no composer/Send; each message's provenance/model. | §6.3 source/list returns, 7 wrapping controls (Conversation, Timeline, Tools, Subagents, Files, Context, Cost); live latest/ended first initial anchor, explicit Go to first turn/latest and stable tool/result disclosure anchor; hidden narrow pane never receives focus; deletion/Undo reveals proper pane. |
| Session list/history tools | Labeled search/filters/modes; semantic project/folder lists and results; Trash/purge/Re-import scope explicit. | §6.4 Apply/result, mode/record/paging, chat selection/title; Back list query/anchor and §5.4 mutation targets; narrow list/chat swap, stacked filters. |
| Agent Map hierarchy | One repository → worktree → sessions ARIA tree with root cwd/Project override groups; level/expanded/selected semantics, roving treeitems; session agent/profile text and service worktree session/live/agent summaries; no inaccessible canvas or duplicated SVG graph. | §6.5.1 bounded root/branch/leaf pages, arrow/Home/End/typeahead, focused ancestor on collapse, Return from Session restores Repositories mode/path; narrow indent cap/wrapped cwd. |
| Agent Map integration/Add agent | Separate Agents list, one row per agent/profile with FR-06 state, Lifecycle receipt, Content coverage and Open integration; named scoped panel; distinct lifecycle/content facts; wizard step headings; diff checkbox/caption/conflicts; native trust instructions. | §6.5.2 panel/wizard/modal restoration, scoped Profile select, Back to map restores Agents row/action or prior Map mode for Dashboard invocations; narrow panel instead of leading pane, wrapped unified diff. |
| Settings | Section fieldsets/labels/units; price status retains current revision; read-only OS theme. | Save invalid field; Clear-dialog invoker; all unchanged Settings flows §6.6; stacked narrow labels/tables. |
| Session Launch/concurrency | Named dialog fields, disabled reasons, command text preview; explicit no prompt sending in read-only transcript. | Session trigger → first field/Cancel → provisional detail/title; cancel restores exposed Session trigger; narrow footer reachable. |
| Ownership/tray/notifications/global | Ownership words on Dashboard, Session and Map; visible Ownership: Detached / Health: Detached even when shown alone; native OS menu/minimal notification copy; collection/read-only band. | §5.4 explanation/modal targets; tray reopens prior valid control/area; global errors keep readable content. |
| Later notes | No rendered surface/certification. Future input attaches at §6.3 utility-row boundary only after approved delta. | Later design defines input/terminal semantics; no empty MVP composer or fake input affordance. |

Every focusable target has a stable accessible name, including Open session, More actions, About ownership, Show evidence, Copy visible text, Close, Load more, Load previous, Retry, Go to first turn, Go to latest and chart month controls. Repeated actions include the local item ordinal/agent/project where needed; never put an entire prompt/tool result in a label. Icons duplicate visible text and are aria-hidden; decorative connector lines are hidden. SVG chart has a concise title/description and text-table equivalent, not hundreds of redundant SVG accessibility nodes. Static exact numbers are in text or associated detail, never only SVG title or hover.

Do not put entire streaming content in a live region. Coalesce polite state announcements within 1 second into a concise changed-session count and currently focused session's state if relevant; urgent service loss announces once. User-requested action results may announce immediately. Focus rings remain fully visible at scroll edges; no sticky header obscures the target. At 200% text, rows measure again; no clipped fixed line counts. At 320 CSS px, all page content reflows except inherently native OS chrome; wrapped text/diffs and the chart subdivision avoid two-dimensional scrolling.

### 8.2 Closed pair inventory (F7)

Computed with WCAG relative luminance from the literal sRGB hex values in §2: channel c/255, linearize c/12.92 when c≤0.04045 else ((c+0.055)/1.055)^2.4; luminance 0.2126R + 0.7152G + 0.0722B; ratio (lighter+0.05)/(darker+0.05). Ratios below are rounded to 2 decimals **after** testing the unrounded value. `Pass / Pass` means light / dark. This inventory is closed: implementation cannot introduce another meaningful foreground/background combination without updating the tokens, inventory and contrast tests/review. Recomputed for PD-T04 round 1: all 27 rows × 2 themes (54/54) pass and match the reported ratios to 0.01; the revised geometry/labels introduce no new pair.

All 18 text pairs below meet normal text 4.5:1, which also exceeds large text 3:1 and status glyph 3:1; text size never excuses a lower ratio. Boundary/glyph pairs have threshold 3:1 and cannot be used as small text. All neutral surfaces alone are decorative fills; meaningful boundaries always use line or accent. No semantic glyph sits on a semantic-color fill. Text selection uses ink on tint; disabled text remains muted on tint. There is no opacity reduction in a meaningful pair.

| Foreground | Background | Category / threshold | Light ratio | Dark ratio | Result |
|---|---|---|---:|---:|---|
| `--x-ink` | `--x-canvas` | Normal text / glyph; 4.5:1 | 14.13 | 14.03 | Pass / Pass |
| `--x-ink` | `--x-surface` | Normal text / glyph; 4.5:1 | 15.28 | 12.80 | Pass / Pass |
| `--x-ink` | `--x-tint` | Normal text / glyph; 4.5:1 | 12.10 | 10.63 | Pass / Pass |
| `--x-muted` | `--x-canvas` | Normal text / glyph; 4.5:1 | 6.23 | 8.65 | Pass / Pass |
| `--x-muted` | `--x-surface` | Normal text / glyph; 4.5:1 | 6.74 | 7.89 | Pass / Pass |
| `--x-muted` | `--x-tint` | Normal text / glyph; 4.5:1 | 5.34 | 6.55 | Pass / Pass |
| `--x-accent` | `--x-canvas` | Normal text / glyph; 4.5:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-accent` | `--x-surface` | Normal text / glyph; 4.5:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-accent` | `--x-tint` | Normal text / glyph; 4.5:1 | 6.64 | 7.04 | Pass / Pass |
| `--x-success` | `--x-canvas` | Normal text / glyph; 4.5:1 | 6.51 | 9.86 | Pass / Pass |
| `--x-success` | `--x-surface` | Normal text / glyph; 4.5:1 | 7.04 | 9.00 | Pass / Pass |
| `--x-success` | `--x-tint` | Normal text / glyph; 4.5:1 | 5.57 | 7.47 | Pass / Pass |
| `--x-warning` | `--x-canvas` | Normal text / glyph; 4.5:1 | 6.42 | 9.55 | Pass / Pass |
| `--x-warning` | `--x-surface` | Normal text / glyph; 4.5:1 | 6.95 | 8.71 | Pass / Pass |
| `--x-warning` | `--x-tint` | Normal text / glyph; 4.5:1 | 5.50 | 7.23 | Pass / Pass |
| `--x-danger` | `--x-canvas` | Normal text / glyph; 4.5:1 | 6.46 | 8.55 | Pass / Pass |
| `--x-danger` | `--x-surface` | Normal text / glyph; 4.5:1 | 6.99 | 7.80 | Pass / Pass |
| `--x-danger` | `--x-tint` | Normal text / glyph; 4.5:1 | 5.53 | 6.48 | Pass / Pass |
| `--x-line` | `--x-canvas` | Boundary / glyph; 3:1 | 3.78 | 5.40 | Pass / Pass |
| `--x-line` | `--x-surface` | Boundary / glyph; 3:1 | 4.08 | 4.93 | Pass / Pass |
| `--x-line` | `--x-tint` | Boundary / glyph; 3:1 | 3.23 | 4.09 | Pass / Pass |

Explicit functional aliases (same computed pairs, enumerated to prevent focus/graph omissions):

| Foreground / function | Adjacent background | Threshold | Light ratio | Dark ratio | Result |
|---|---|---:|---:|---:|---|
| `--x-focus` ring | `--x-canvas` | 3:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-focus` ring | `--x-surface` | 3:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-focus` ring | `--x-tint` / selected | 3:1 | 6.64 | 7.04 | Pass / Pass |
| `--x-chart` bars / context used | `--x-canvas` / inset | 3:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-chart` bars / context used | `--x-surface` | 3:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-chart` selected month / context used | `--x-tint` | 3:1 | 6.64 | 7.04 | Pass / Pass |

Meter fill is inset 2 px from its outer line and graph marks stop 2 px before axes, leaving a neutral gap: neither line nor accent requires contrast against the other. Focus's 2 px offset likewise leaves neutral background between border and ring; no ring is placed directly on a semantic-color fill. Strong accent control boundaries/selection rules use the accent/neutral pairs above. Diff plus/minus text uses success/danger on canvas; its signs remain readable without hue. Canvas/surface/tint are never used as foreground marks. Decorative shadow uses no informational contrast threshold and cannot serve as a boundary. OS-rendered tray/notification/native picker internals are not CSS token pairs and are not claimed covered by these computations.

### 8.3 Implementation verification boundary

Phase 4 must parse the literal token values and test every pair in both themes, all 21 lifecycle/confidence mappings and keyboard/focus logic before TSX per plan. Playwright verifies roles/names, exact integer accessible values, no unqualified live on collection loss, all restoration targets, each narrow layout and rendered focus clearance. Synthetic long-content and 50-session runs measure performance; virtualization is a design constraint, not proof of M5/M12/M13/M14. Browser/console/visual checks and owner baseline approval happen on implemented screens, not on this Markdown. No new axe, font, chart, icon or styling dependency is implied.

## 9. Coverage matrix

Each original brief ID and each amendment requirement has an explicit destination below. PD01-1–PD01-9 are local coverage IDs for D-PD-01, with PD02/PD03 for its owner amendments; none are new PRD IDs. §6.13 supplies B1–B6 for every A surface; N/A states and deferred surfaces are explained rather than treated as missing design. No known in-scope specification gap remains; §10 lists unrendered/approval/source-comparison gaps explicitly. D-PD-01 is applied with the D-PD-02 repository-first and D-PD-03 plain-name amendments; original History and Integrations capabilities are relocated, not removed.

| ID | Design section |
|---|---|
| A1 | §6.1 Dashboard available-height views and compact records, §6.0 health, §7 formats |
| A2 | §6.2 Needs attention inside Dashboard |
| A3 | §6.3 Session Conversation/Timeline/Tools/Subagents/Files/Context/Cost, live latest/ended first and Go to first turn/latest; §6.3.1 context, §6.3.2 cost, §5.2 long content |
| A4 | §6.4 Session list/history tools; §6.1.1 Dashboard monthly ledger |
| A5 | §6.5.2 Agent Map integration/Add agent panel; §6.5 Agents list selection/mode restoration |
| A6 | §6.6 Settings |
| A7 | §6.7 Launch dialog from Session |
| A8 | §6.8 Concurrency warning from Session Resume |
| A9 | §6.9 Ownership, §3.2 encoding |
| A10 | §6.10 Tray / OS copy |
| A11 | §5.3–5.4, §6.0, §6.11 global patterns |
| A12 | §6.12 later notes only |
| B1 | §6.13 Empty column; §5.1 block |
| B2 | §6.13 Loading column; §5.2 independent fetches |
| B3 | §6.13 Error column; §5.4 transactions; §6.11 recovery |
| B4 | §6.13 Stale column; §3.2, §6.1, §7.1 freshness |
| B5 | §6.13 Unavailable column; §6.3.1–6.3.2 |
| B6 | §6.13 Estimate column; §7.1 money/tokens |
| C1 | §3.1, §6.2, §7.2 C1 |
| C2 | §3.2, §7.2 C2 |
| C3 | §3.2, §7.2 C3 |
| C4 | §3.1, §6.5, §7.2 C4 |
| C5 | §6.1, §6.3, §6.5.1 session leaves, §7.2 C5 |
| C6 | §6.1, §6.3 Conversation/Subagents, §6.5.1 session leaves, §7.2 C6 |
| C7 | §6.3.2, §7.1, §7.2 C7 |
| C8 | §6.3.2, §7.1, §7.2 C8 |
| C9 | §6.1, §6.3.2, §7.2 C9 |
| C10 | §6.3.2, §7.2 C10 |
| C11 | §6.3.2, §6.6, §7.2 C11 |
| C12 | §6.3.1, §7.1–7.2 C12 |
| C13 | §6.3, §7.2 C13 |
| C14 | §6.3–6.4, §7.2 C14 |
| C15 | §6.3–6.4, §7.2 C15 |
| C16 | §6.1, §6.1.1, §7.2 C16 |
| C17 | §6.3.1, §7.2 C17 |
| C18 | §6.1, §7.1, §7.2 C18 |
| C19 | §6.1, §7.1, §7.2 C19 |
| C20 | §3.2, §6.13, §7.2 C20 |
| C21 | §6.3.1, §7.2 C21 |
| C22 | §6.1.1, §7.2 C22 |
| C23 | §6.1.1, §7.2 C23 |
| C24 | §6.1.1, §7.2 C24 |
| C25 | §6.1, §7.2 C25 |
| C26 | §6.1, §7.2 C26 |
| C27 | §3.2, §6.3, §6.5.1, §6.9, §7.2 C27 |
| C28 | §3.3, §7.2 C28 |
| C29 | §6.1, §6.3, §7.2 C29 |
| C30 | §6.3.2, §6.6, §7.2 C30 |
| C31 | §6.12, §7.2 C31, later note only |
| C32 | §6.7, §7.2 C32 |
| C33 | §6.3.1, §6.12, §7.2 C33, later note only |
| C34 | §6.2, §6.10, §7.2 C34 |
| D1 | §7.1 token abbreviation/exact text |
| D2 | §6.3.1 category order/grouping |
| D3 | §7.1 formats |
| D4 | §2.3 minimum/breakpoints; §6 screen-specific narrow layouts |
| D5 | §2.3 ring, §5.1 states, §8.2 alias pairs |
| D6 | §2.3 no live animations / reduced motion |
| D7 | §2.1 and §6.6 OS theme, no preference |
| D8 | §4 original inline SVG set |
| D9 | §5.1 meter, §6.3.1 context, §6.1.1 hand-written SVG chart |
| D10 | §2.4 baseline window sizes/themes |
| E1 | §2.2 system fonts, §4 SVG, §5.2 React/virtual primitive |
| E2 | §2.1 one bundled stylesheet, §5.2 CSP-safe dynamic geometry |
| E3 | §1.1, §5.2 text/visible escape contract |
| E4 | §5.2 page/slice/DOM bounds; §6.1 live list/month summaries; §6.4 list; §6.5.1 bounded tree |
| E5 | §1.2, §4, §8.3 no new dependency; only already approved Phase 4 virtual package |
| F1 | §5.1–5.4, §6 per-screen order, §8.1 |
| F2 | §2.3, §5.1, §8.2 |
| F3 | §4 names, §5.1 controls, §8.1 repeated-action names |
| F4 | §3 exhaustive status encodings |
| F5 | §5.2–5.4, §6 per-screen targets, §8.1 |
| F6 | §2.3–2.4, §6 per-screen narrow layout, §8.1 |
| F7 | §8.2 computed inventory, §8.3 future implementation check |
| G1 | §1.1 identity, §10.1 originality |
| H1 | §10.2 privacy/example rules, throughout numeric examples |
| PD01-1 | D-PD-01 four areas/extensible navigation and precedence: introduction, §1.2, §5.3, §6.0 |
| PD01-2 | Dashboard in-place scope usage/quota history, 45 days by day and gaps: §6.1, §6.13, §8.1 |
| PD01-3 | Dashboard monthly usage chart, C22–C24, provenance/quota separation: §6.1.1, §6.13 |
| PD01-4 | Session read-only chat, inline reasoning/tools/subagents/switches/gaps/findings: §5.1–5.2, §6.3 |
| PD01-5 | Session live/past list and history/search/projects/folders/Trash/restore/purge/Re-import: §6.4 |
| PD01-6 | Session launch/resume/concurrency origin; future input boundary without MVP composer: §6.3, §6.7–6.8 |
| PD01-7 | Agent Map repository/worktree/session hierarchy (D-PD-02); root Project override/cwd fallback groups, session agent/profile text, service session/live/agent summaries, counts/bounds/tree keys: §6.5.1 |
| PD01-8 | Separate Agents list/modes, per-profile FR-06 state and Lifecycle receipt/Content coverage, Open integration/restoration (D-PD-02): §6.5; unchanged selected integration/Add agent panel, diff/trust/opt-ins/sign-in: §6.5.2 |
| PD01-9 | Cross-area and narrow pane keyboard/focus restoration, B states and accessibility: §5.3–5.4, §6.1–6.5, §6.13, §8.1 |
| PD02 | Owner D-PD-02 repository-first Map and separate Agents list: §6.5–6.5.2, §6.13, §8.1, PD01-7–PD01-8 |
| PD03 | Owner D-PD-03 Conversation/Timeline/Tools/Subagents/Files/Context/Cost section names: §5.1, §6.3, §6.12–6.13, §8.1, §10.1 |


## 10. Originality and open points

### 10.1 Originality statement (G1)

This is an original Xaibo design authored from requirements. References provide capabilities only: agent-flow informs observation/integration capability; harp and deer-flow inform the need to navigate session work; Claude Code's context view motivates readable categories; the owner's dashboard screenshot is an approval reference only. No reference layout, navigation structure, visual style, tab/header naming, vendor app treatment or palette is adopted. Xaibo's chosen form is the warm paper/plum ruled ledger, bracket mark, extensible four-area text navigation (Dashboard, Session, Agent Map, Settings), read-only chat, repository-first evidence outline, separate Agents list and plain Session section index (Conversation, Timeline, Tools, Subagents, Files, Context, Cost), separate evidence margin, horizontal used/unoccupied context meter and single-series numbered monthly bars. In particular there is no colored-square context grid/category legend reproduction, vendor color identity, reference header/tab arrangement or copied icon path.

Originality is a design claim for review, not proof of a completed side-by-side comparison. Named reference products and the screenshot were not opened or fetched during this local authoring task. Claude reviews available references at PD-T03; the owner checks the absent dashboard screenshot at Gate D (Q-D4). If a visual collision is found, revise the affected design choice before approval; do not silently waive FR-50.

### 10.2 Public-document privacy (H1)

All examples are synthetic: example-app, home-relative `~/projects/example-app`, round token values and a fictional month. The only model-name example is the PRD's Opus 5.5; other models use their actual evidenced display name/raw ID at runtime, no invented model identity in this document. No usernames, email addresses, account IDs, absolute home paths, network endpoints/ports, session IDs, prompts or transcript samples are included. Runtime local UI may display its owner's actual conversation and provenance, but no such data enters this design, fixtures, screenshots, logs or public review evidence. Runtime full content stays local; safe display is not masking at source. Egress uses the existing best-effort sanitizer; no content-bearing log is designed. Tests isolate all agent homes/config/data paths with synthetic stores and never open real stores.

### 10.3 Open points and proposed defaults

| Point / explicit gap | Proposed default / boundary |
|---|---|
| Owner dashboard screenshot unavailable in repo | Owner compares at Gate D; keep this original ledger identity pending that check. This comparison is unverified, not silently marked passed. |
| Named references not visually inspected during authoring | Claude's PD-T03 originality review checks feature-only separation; revise any collision. No remote resources or mockups are needed to author this spec. |
| Visual geometry/type not yet rendered | Implement these exact tokens/sizes first; test all §2.4 sizes and keyboard flows. Any material design change returns for Codex delta/Claude review/owner approval; no claim that this Markdown is a browser test. |
| Native platform minimum/title-bar difference | Set the specified outer sizes, assert recorded content viewport uses intended breakpoint; preserve all required fields through wrapping. If OS chrome reduces room, scroll rather than clip. |
| Service does not yet expose every planned fact/action | Unavailable + named reason; never infer identity, ownership, cost, native capability, price attribution or measurement time in renderer. Deliver phase-owned APIs in the planned phase before enabling corresponding action. |
| Gemini and agy unverified interactive/runtime capabilities | Disabled with the precise reason; only their own compatibility checks enable them. No inherited semantics, headless fallback, guessed quotas or inferred context windows. |
| D-PD-01 area naming | Retain Session; Dashboard/Agent Map/Settings exactly as approved. No alternative name, fifth area or composer is implemented by this draft. |
| New chat/map geometry not rendered | Verify both themes at all §2.4 sizes; test two-pane/one-pane restoration, collapsed content, partial/error tree pages, fifth-link wrapping via isolated fixture only and unchanged contrast pairs. No visual/runtime pass claimed. |
| Later screens and context composition | Notes only (§6.12); no hidden navigation or speculative editor. Small reviewed design delta before implementation. |
| Review and approval pending | Claude reviews the design diff at PD-T03, then owner approves Gate D. No commit, push, mockup, product code, install or Phase 4 start is authorized by this draft. |

No unresolved aesthetic decision is delegated to the implementer: palette, type, icon geometry, spacing, screen order, states, keyboard/focus, formats, responsive behavior and baseline sizes are specified above. These verification/approval gaps remain visible until their designated review; they do not certify Gate D or runtime behavior.
