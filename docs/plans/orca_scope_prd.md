# Orca-informed scope: PRD amendment (DRAFT)

Status: DRAFT, requirements only. Nothing here is approved or started. Its requirements are written into the `docs/PRD.md` v1.2 draft (App. G, Orca-informed scope delta); the PRD wording is binding once approved. Amends `docs/PRD.md` once the owner approves,
after Codex design and review. Implementation planning comes later through the plan step. Phase 3 (live status) is
unaffected and finishes first. Background and sources: [docs/research/orca-lessons.md](../research/orca-lessons.md).
Estimates are labeled `~`; unknown values stay "unavailable".

## Problem

A developer who runs several coding agents at once on one machine has three problems Xaibo does not solve today.
Agents sharing one checkout overwrite each other's files, and when the developer splits work into git worktrees,
Xaibo's history shows each worktree as a separate project. Usage numbers mean different things depending on how the
agent is signed in: quota windows matter on a subscription, while billed tokens matter with an API key, and Xaibo shows
both the same way. And status still depends on hooks being installed. Leaving this unsolved keeps users choosing between
parallel speed and a readable history, and makes the usage view misleading for API-key users once Xaibo is public.

## Evidence

- Observed in this project: the owner runs Codex and Claude in parallel and already uses side worktrees for chores.
- Code finding: Xaibo keys projects on the canonical cwd only (`cwdKey`), so linked worktrees of one repository become
  separate projects. Confirmed by reading the source; not yet shown in a fixture.
- Prior art: Orca's headline feature is parallel worktrees (research note §1, L4).
- Assumption, needs validation via user research once public: that users sign in with a mix of subscriptions, API keys,
  cloud providers and gateways across profiles.
- Assumption, needs validation via a spike: that OSC 7501 status can be bound reliably to one session (research L1).

## Users

- **Primary:** a developer running two or more coding agents (Claude Code, Codex, agy, custom agents) on one machine,
  often in parallel on one repository, signed in by subscription, API key or both across profiles. The owner now;
  public users later.
- **Not for:** teams, shared or remote machines, cloud-hosted agents, and users who want Xaibo to drive agents
  automatically (orchestration stays out, see below).

## Hypothesis

We believe **repository-level grouping of worktree sessions, a sign-in-aware usage view, launching agents into their
own worktree, and an optional terminal status source** will **let developers run agents in parallel without losing a
readable history or a meaningful usage picture** for **multi-agent developers on one machine**.
We'll know we're right when **sessions from every worktree of a repository appear under one project, each profile's
usage view matches its sign-in method, and a parallel launch needs no manual git or setup steps**, with zero new
non-loopback connections.

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Worktree grouping correctness | 100% on the synthetic layout set (linked worktrees, relative pointers, separate git dir, bare repository, unreadable metadata); unsupported layouts stay ungrouped, never mis-grouped | Fixture tests |
| Sign-in method detection | Correct method for each synthetic profile type (subscription, API key, cloud provider, gateway, mixed); "unknown" when evidence is missing, never guessed | Fixture tests |
| Credential values read or stored by Xaibo | 0 | Static check and canary tests (M9) |
| New non-loopback connections | 0 | Existing M6 audit |
| Parallel launch effort | TBD, needs validation via a usability check (target: one confirm step after the preview) | Owner walkthrough |
| Confirmed states derived from terminal status (OSC 7501) | 0, regardless of binding | Replay harness (M8 style) |

## Scope

**MVP**

1. **Worktree grouping.** History groups sessions by repository across linked worktrees; each session keeps its own
   worktree and cwd, shown and filterable. Unresolvable layouts keep today's behavior.
2. **Sign-in-aware usage.** Each profile's sign-in method is detected from agent output Xaibo already ingests or declared by the
   owner, with no credential or configuration file read, and its usage view leads with what matters for that method: quota windows for a subscription, `~$`
   estimated cost for API-key or cloud-provider use, both where both apply. Users may use either or both.
3. **Launch into a new worktree** (v1-A, PRD Q25 resolved by the owner). An optional launch choice creates a worktree for the
   new session after a preview of every write. Ignored files the user picks are cloned or linked within a size cap.
   Git runs with repository hooks disabled; repositories with checkout filters are refused. Xaibo never runs a
   repository's setup script; the preview shows it for the owner to run. Xaibo never deletes a worktree without a
   confirmation.

**Later (v1, after a spike)**

4. **Terminal status source (OSC 7501)** for terminals Xaibo owns (S-20), only after a spike shows bounded parsing,
   binding to one process and session, a confidence mapping and reset on program exit.

**Out of scope**

- Calling provider usage, quota or billing APIs, or reading stored credentials: conflicts with M6 and PRD §3.2. May
  return later only as a separate opt-in proposal.
- Orchestration (a lead agent starting workers, mailboxes, automatic pause): a new control feature; R1–R5 stay warnings.
- Blocking or rewriting agent tool calls from hooks: conflicts with M7 and M16.
- Telemetry or crash upload: conflicts with M6.
- Orca's layout, naming or visual style: D-23.

## Delivery Milestones

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | Worktree grouping | One project per repository across its worktrees | pending | — |
| 2 | Sign-in-aware usage | Usage view fits each profile's sign-in method | pending | — |
| 3 | Launch into a new worktree | Parallel sessions start in their own checkout from Xaibo | pending | — |
| 4 | Terminal status spike, then source | Status for hook-less sessions in Xaibo's own terminal | pending | — |

Milestones start after the Phase 3 gate. Ordering against the remaining MVP gates is an open question.

## Open Questions

- [ ] Milestone 1: regroup existing projects (migration) or new sessions only?
- [ ] Milestone 2: which agent-output fields signal each sign-in method per agent (PRD spike S14)? Where none do,
      the owner declares the method.
- [ ] Milestone 2: how to show a profile that mixes methods, for example a subscription with API-key overflow.
- [ ] Milestone 3: is "launch into a worktree" MVP, v1, or later? It is the first time Xaibo writes into a user's
      repository.
- [ ] Milestone 3: default for ignored files: none, a per-repository list, or a preview of candidates?
- [ ] Milestone 4: does it wait for the embedded terminal (S-20) or ship with a minimal owned terminal?
- [ ] Compare Orca's journal recovery and versioning with Xaibo's store before Phase 5 (research L6).

Owner decisions, 2026-11-13: PRD Q24–Q30 resolved with their defaults (new sessions only; S-39 and the
terminal source in v1-A; no ignored files preselected; "Mixed" shows both, never summed; no usage APIs; checkout
filters unavailable). The Milestone 1, 3 and 4 questions above are answered by these.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Grouping merges unrelated repositories | Low | High | Group only on a verified common git directory; otherwise keep cwd grouping |
| Sign-in detection reads credential contents by accident | Medium | High | Agent-output evidence or owner declaration only; file-access trace tests |
| A worktree launch damages a user's repository | Low | High | Preview, confirm, never force; delete only on confirmation |
| Setup scripts run untrusted code | Medium | High | Xaibo never runs them; git hooks disabled; checkout filters refused |
| OSC 7501 output spoofed by another program in the pane | Medium | Medium | Always inferred, never overrides other evidence; spike gate before shipping |
| Scope competes with the MVP schedule | High | Medium | Start after the Phase 3 gate; owner orders milestones |

---
*Status: DRAFT — requirements only. Implementation planning pending via /plan.*
