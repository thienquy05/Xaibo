# Gate D record

Post-freeze evidence for Gate D (plan Phase D, PD-T05; §2.4 step 6). The frozen tree is the gate SHA; this file is the only change in the gate-record commit. Gate D has no Codex review (Codex authored the design): Claude review, then owner approval.

| Item | Value |
|---|---|
| Gate SHA | `3b41fc6` (branch `docs/design-system`) |
| Baseline | `master` at `e7c8683` (PR #15 merge) |
| Freezes | `839826c` (first draft with owner amendment D-PD-01, reviewed), `3b41fc6` (after review round 1) |
| Deliverable | `docs/design/xaibo-design.md` (no mockups, Q-D3) |
| Owner decision | **Gate D approved 2026-11-14 on `3b41fc6`** (`record_decision` 1157) |
| Push / PR | not done; when the owner asks |

## Process

| Step | Result |
|---|---|
| PD-T01 brief | `.handoff/design-brief.md`: screens A1–A12, states B1–B6, fixed labels C1–C34, delegated decisions D1–D10, stack E1–E5, A11Y F1–F7, originality G1, privacy H1; privacy scan clean |
| PD-T02 Codex authoring | Codex companion task (outside the sandbox, owner-approved, `--write`); owner amendment 1 (D-PD-01: Dashboard, Session, Agent Map, Settings) applied in the same Codex session |
| PD-T03 Claude review on `839826c` | Checklist 1–10 pass; 0 blocking, 6 non-blocking (R1-1..R1-6) |
| PD-T04 round 1 | Codex resolved R1-1..R1-6; full checklist re-run on the whole document at `3b41fc6`: 0 blocking, 0 open. Round 2 not needed (Q-D5) |
| PD-T05 | Owner approval on `3b41fc6`, including the dashboard-screenshot originality item (Q-D4) |

## Owner decisions in this phase

| ID | Decision |
|---|---|
| D-PD-01 | Four top-level areas: Dashboard, Session (read-only chat-style transcript plus the session history list), Agent Map, Settings; monthly chart and usage history in Dashboard; integrations in Agent Map |
| D-PD-02 | Agent Map is repository-first (repository → worktree → sessions, agent named on each session); agent integrations in a separate Agents list on the same screen |
| D-PD-03 | Session section names: Conversation, Timeline, Tools, Subagents, Files, Context, Cost |

## Review findings and dispositions

| ID | Finding | Disposition at `3b41fc6` |
|---|---|---|
| R1-1 | Agent-first map hides agents sharing a worktree (owner D-PD-02) | Fixed: repository-first tree, service worktree counts (sessions, live, agents), separate Agents list |
| R1-2 | Coined section names (owner D-PD-03) | Fixed: plain names everywhere |
| R1-3 | Busy glyph read as pause | Fixed: static zigzag stroke |
| R1-4 | Health and Ownership "Detached" visually identical | Fixed: visible "Health: Detached" / "Ownership: Detached" |
| R1-5 | Dashboard showed ~3 live sessions at 960×640 | Fixed: in-place views (Live sessions, Needs attention [n], Usage and history) filling the window; compact two-line rows at normal/wide widths |
| R1-6 | Live session opened at its first turn | Fixed: live sessions open at the latest page; explicit Go to first turn |

## Gate D checklist at `3b41fc6`

| Item | Result |
|---|---|
| Covers every screen, state, label and delegated decision (coverage matrix §9 of the design) | Pass |
| Light and dark themes; every inventoried pair passes OQ-X15 | Pass: 27 pairs × 2 themes, 54/54, recomputed from the hex values (table below) |
| A11Y per screen: keyboard, focus, labels, text + icon, focus restoration, narrow layouts | Pass |
| No unapproved dependency; charts and icons hand-written SVG; no web fonts | Pass |
| Originality (D-23) | Pass vs agent-flow, harp, deer-flow and Claude Code's context view (Claude); dashboard screenshot checked by the owner at approval |
| Privacy scan clean; `.handoff` design files deleted | Scan clean on the design and this record; handoff files deleted after this commit |
| Claude review 0 blocking, then owner approval recorded | Pass (`record_decision` 1157) |

## Contrast report (WCAG 2.2 relative luminance, recomputed by Claude from `3b41fc6`)

| Foreground | Background | Threshold | Light | Dark | Result |
|---|---|---|---:|---:|---|
| `--x-ink` | `--x-canvas` | 4.5:1 | 14.13 | 14.03 | Pass / Pass |
| `--x-ink` | `--x-surface` | 4.5:1 | 15.28 | 12.80 | Pass / Pass |
| `--x-ink` | `--x-tint` | 4.5:1 | 12.10 | 10.63 | Pass / Pass |
| `--x-muted` | `--x-canvas` | 4.5:1 | 6.23 | 8.65 | Pass / Pass |
| `--x-muted` | `--x-surface` | 4.5:1 | 6.74 | 7.89 | Pass / Pass |
| `--x-muted` | `--x-tint` | 4.5:1 | 5.34 | 6.55 | Pass / Pass |
| `--x-accent` | `--x-canvas` | 4.5:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-accent` | `--x-surface` | 4.5:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-accent` | `--x-tint` | 4.5:1 | 6.64 | 7.04 | Pass / Pass |
| `--x-success` | `--x-canvas` | 4.5:1 | 6.51 | 9.86 | Pass / Pass |
| `--x-success` | `--x-surface` | 4.5:1 | 7.04 | 9.00 | Pass / Pass |
| `--x-success` | `--x-tint` | 4.5:1 | 5.57 | 7.47 | Pass / Pass |
| `--x-warning` | `--x-canvas` | 4.5:1 | 6.42 | 9.55 | Pass / Pass |
| `--x-warning` | `--x-surface` | 4.5:1 | 6.95 | 8.71 | Pass / Pass |
| `--x-warning` | `--x-tint` | 4.5:1 | 5.50 | 7.23 | Pass / Pass |
| `--x-danger` | `--x-canvas` | 4.5:1 | 6.46 | 8.55 | Pass / Pass |
| `--x-danger` | `--x-surface` | 4.5:1 | 6.99 | 7.80 | Pass / Pass |
| `--x-danger` | `--x-tint` | 4.5:1 | 5.53 | 6.48 | Pass / Pass |
| `--x-line` | `--x-canvas` | 3:1 | 3.78 | 5.40 | Pass / Pass |
| `--x-line` | `--x-surface` | 3:1 | 4.08 | 4.93 | Pass / Pass |
| `--x-line` | `--x-tint` | 3:1 | 3.23 | 4.09 | Pass / Pass |
| `--x-focus` | `--x-canvas` | 3:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-focus` | `--x-surface` | 3:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-focus` | `--x-tint` | 3:1 | 6.64 | 7.04 | Pass / Pass |
| `--x-chart` | `--x-canvas` | 3:1 | 7.75 | 9.29 | Pass / Pass |
| `--x-chart` | `--x-surface` | 3:1 | 8.38 | 8.48 | Pass / Pass |
| `--x-chart` | `--x-tint` | 3:1 | 6.64 | 7.04 | Pass / Pass |

## Carried into Phase 4

- Phase 4's first commit updates `docs/plans/xaibo_progress.md` from this file (PD-T04, PD-T05 rows; Phase D done).
- Playwright visual baselines come from the implemented design at the §2.4 viewports (960×640, 720×640, 640×560, 1280×800; light and dark).
- Worktree counts (D-PD-02) and S-37 grouping need the service aggregates the design names; FR-53 grouping is planned for Phase 5, so Phase 4 builds the Agent Map view on synthetic presentation data where the service does not yet supply them.
