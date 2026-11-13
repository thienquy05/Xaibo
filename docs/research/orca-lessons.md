# Research note: lessons from Orca

| Field | Value |
|---|---|
| Status | Draft for Codex review. Nothing here changes the PRD; each proposal needs an owner decision and a PRD delta. |
| Date | 2026-11-13 |
| Source | [stablyai/orca](https://github.com/stablyai/orca), MIT, read-only shallow clone of the default branch on 2026-11-13 |
| Reuse rule | Features and ideas only (PRD §2.2, App. D). Xaibo's UI stays original (S-34, D-23). Code reuse, if ever proposed, needs the MIT notice and an owner decision. |

## 1. What Orca is

Orca is an Electron IDE that runs coding agents (Claude Code, Codex and about 40 others) in parallel, each in its own git
worktree, with chat or terminal views, diff review, a browser, a CLI, remote/SSH/cloud hosts and a mobile app.

Xaibo is a different product: a local-only observer with durable private history for the agents the owner already runs.
The overlap is live status across agents and launching sessions.

## 2. Where Xaibo differs

| Topic | Orca | Xaibo |
|---|---|---|
| Stuck / loop detection per agent | No repeated-tool, repeated-error or cycle detector found in the inspected sources. Related but different: the coordinator logs "Stuck" when all tasks are blocked and none active (`src/main/runtime/orchestration/coordinator/coordinator-dag-convergence.ts`); worker dispatch has a circuit breaker for repeated failed starts (`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-outcome.ts`); `src/main/hang-watchdog/` watches Orca's own process. | §6.4 R1–R5 (no progress, repeated tool, repeated error, cycle, long tool), warnings only |
| Network | PostHog telemetry; calls a provider OAuth usage endpoint for quota (`src/main/rate-limits/`) | Zero non-loopback connections (M6); no quota/usage API calls (§3.2) |
| Agent interference | Claude PreToolUse hook waits up to 8 s for an allow/deny/rewrite answer, fail-open | No reporting decisions; zero stdout/stderr (M7, M16) |
| Durable history | A persistent SQLite journal for its native chat sessions, restored on open (`src/main/native-chat/agent-session-journal/database/journal-host-database.ts`, `.../replay/journal-open.ts`). UNVERIFIED: whether it covers sessions Orca did not start, and whether records survive the agents' own cleanup. | Private SQLite history of every observed session that outlives native cleanup (S-09, S-10) |

These are the points to keep when positioning Xaibo. The history difference is narrower than "Orca has none": compare
coverage of sessions Orca did not start and retention after native cleanup before claiming it publicly.

## 3. Lessons worth taking

### L1. OSC 7501 program-status channel (proposed: v1, with S-20)

Some agents write their own state into the terminal stream as OSC 7501 (Program Status Protocol). Orca's support matrix
(`src/main/agent-hooks/README.md`, dated 2026-10-17) lists Claude Code (since 2.1.295), Codex (0.163.0, state only),
Grok, pi and oh-my-pi as live-verified senders. Reports carry state, a `blocked` kind (`permission`, `question`,
`auth`), one free-text line and child records (subagents).

- **Fit:** zero tokens, no config change, and it covers sessions with no hooks installed. It is always inferred,
  never confirmed, regardless of binding (PRD delta FR-55); promoting it would need a separately approved PRD change.
- **Limit:** only readable from a PTY Xaibo owns, so it belongs to the embedded terminal (S-20), not MVP.
- **Identity and trust (spike requirements):** owning the PTY does not prove which session wrote a sequence; any program
  in the pane can emit one. Orca bounds message and id sizes (`src/shared/program-status/protocol.ts`) and treats some
  sources as folder-wide rather than pane-specific (`.../program-status/hook-precedence.ts`). Before accepting it, the
  spike must define bounded parsing, binding to a process and session (PRD §5.5 identity rules), a confidence mapping
  (always inferred, per the PRD delta FR-55), and reset when the program exits or the terminal resets.
- **Caveat Orca documents:** many agents only send after the terminal answers the `OSC 7501 ; ?` probe, and Claude stops
  painting its title status glyph once answered. Anything that reads that glyph must switch to the OSC data.
- **Caveat for Xaibo:** OSC 7501 has no prompt, tool input, session id or model, so it can never replace hooks or files.
- **UNVERIFIED for Xaibo:** the matrix is Orca's claim at their agent versions. Needs a spike against the versions in
  PRD §2.3 before any status mapping is written.

### L2. Precedence when a second status channel exists (proposed: input to §5.5 / §6.2)

Orca's rule (`src/main/agent-hooks/server/program-status/hook-precedence.ts`): hooks win; OSC 7501 fills in only where
hooks do not speak, including hooks silent for 2 minutes on a state the program has since left. A finished turn is
silent by design, so only new work lets OSC take over. The next hook event takes the row back. The OSC report also rides
along as a facet that never decides state.

If L1 is accepted, compare this with Xaibo's confirmed/inferred model before designing our own rule. The "facet never
decides state" split matches Xaibo's rule that heuristic states are never shown as confirmed (M8).

### L3. Group linked worktrees under one project (proposed: MVP-size fix, needs a decision)

**Finding in Xaibo:** projects are keyed by `cwdKey` (`src/service/paths.ts`): the realpath of the cwd, NFC-normalized.
A linked worktree has its own directory, so sessions from N worktrees of one repo appear as N projects. EC-06 covers
relocation of one session, not grouping across worktrees.

Orca attributes usage to worktrees by canonicalizing the cwd and longest-prefix matching it against its own worktree
registry (`src/main/claude-usage/worktree-attribution.ts`). Xaibo has no registry, but it can derive a grouping key
locally without spawning git: a linked worktree's `.git` is a file with a `gitdir:` pointer, and that directory's
`commondir` leads to the repository's common git directory. The common directory is not always `<main>/.git` and does
not always identify a main working tree (separate git dirs, bare repositories). Orca resolves these pointers, checks
target types and keeps read failures (`src/main/git/worktrees/catalog/worktree-listing.ts`).

- **Proposal:** group by the verified, canonical common git directory; keep each session's cwd and worktree as
  attributes (shown, filterable). Unsupported or unreadable layouts stay ungrouped (today's `cwdKey`), never guessed.
- **Needs a decision:** whether grouping changes existing project rows (migration) or applies to new sessions only.
- **Tests (synthetic, temp dir):** main repo with two linked worktrees; relative `gitdir`/`commondir` pointers; a
  separate git dir; a bare repository with worktrees; unreadable or missing metadata.

### L4. Launch a session in a new worktree (proposed: scope change to S-12, v1 or later)

Parallel worktrees are Orca's headline feature: each agent gets its own checkout, so agents do not overwrite each other.
Details worth copying as behavior:

- **Fast materialization of ignored files** (`src/main/ipc/worktree-symlinks.ts`, `worktree-apfs-clone.ts`): three modes,
  `link` (APFS clone, else symlink), `copy` (independent content) and `share` (always link, one `node_modules` for all
  worktrees). APFS clone makes copying `node_modules` or `.env` nearly free on macOS.
- **Copy budget** (`worktree-include-copy-budget.ts`): default caps of 2 GiB and 50,000 entries, measured before copying;
  skipped paths are reported with a reason and a "may be partial" flag.
- **Setup-script trust** (`src/main/workspace-hooks/created-worktree-setup-trust.ts`): when the client sends approved
  hashes, a repo's shared setup commands are compared by sha256 and a changed script asks again. It is conditional:
  no approval hash (older clients) means "run as decided", and an explicit run decision passes the folder guard without
  a hash. Xaibo should not adopt script execution at all: a hash pins the content but does not bound what the script
  writes, reads or connects to (M6). The PRD delta shows the script for the owner to run instead (SEC6).

**Scope impact:** today S-12 launches or resumes in an external terminal and Xaibo writes no files in the user's repos.
Creating worktrees means Xaibo runs `git worktree add` and writes into a repo, which needs its own threat review,
cleanup rules and an owner decision. Not proposed for MVP.

### L5. Coordinator, mailbox and decision gates (later; no proposal now)

Orca lets a lead agent split a task into a DAG, start worker agents in their own worktrees, pass messages through a
mailbox and stop at decision gates (`src/main/runtime/orchestration/`). It stops repeated failed starts with a circuit
breaker, but no repeated-tool or cycle detector was found. If Xaibo ever orchestrates, R1–R5 findings could inform a
pause or escalation. That would be a new, separately approved control feature: today R1–R5 are warnings that never
terminate or pause anything (PRD §6.4). Recorded here only as a direction.

### L6. Journal recovery and versioning (proposed: input to the store design)

Orca's chat journal opens read-only or "stranded" when it cannot safely write, tracks the open transaction so drafts
from a rolled-back one are not built on, and replays saved records on open
(`src/main/native-chat/agent-session-journal/`). Compare its recovery and schema-version handling with Xaibo's store
migrations and disk-full recovery before Phase 5.

## 4. Not taking

Revised by the owner on 2026-11-13 (PRD v1.3 draft): usage APIs, orchestration, blocking and telemetry return in a
controlled form (S-41..S-44, CRED policy). Orca's look stays excluded (D-23).

- Calling usage or quota APIs, telemetry, crash upload: conflicts with M6 and §3.2.
- Blocking or rewriting tool calls from hooks: conflicts with M7/M16.
- Orca's layout, naming and visual style: D-23.

## 5. Questions for Codex and the owner

Answered by the owner on 2026-11-13 (PRD v1.2 draft): 1 → v1-A after spike S15, always inferred (Q28, FR-55);
2 → yes, new sessions only (Q24); 3 → v1-A (Q25).

1. L1: accept OSC 7501 as a v1 evidence source with S-20, pending a spike on the PRD §2.3 versions?
2. L3: accept worktree grouping, and for new sessions only or with a migration?
3. L4: is "launch in a new worktree" in scope for v1, later, or never?
