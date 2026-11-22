# OpenShell ideas for the AEGIS module (DRAFT)

Status: DRAFT, planning only. Adds to `docs/plans/local_agent_aegis_prd.md` (AEGIS: rules over Xaibo's normalized
tool-call events, detect and alert only). Nothing here changes that draft or `docs/PRD.md`; each item needs an owner
decision. Estimates are labeled `~`; unknown values stay "unavailable".

Source: [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell), Apache-2.0, read-only shallow clone of the default
branch on 2026-11-13. Ideas only; if a rule format follows OpenShell's schema closely, credit it (Apache-2.0).

## 1. What OpenShell does

OpenShell runs each agent in a sandbox and enforces a YAML policy:

- **Filesystem and process:** readable and writable paths (Linux Landlock), user and group (Docker or Podman).
- **Network:** default deny. A rule names destinations and the binaries allowed to reach them; every listed binary may
  reach every listed endpoint in that rule. Rules can also limit requests (for example read but not write).
- **Credentials:** the agent holds opaque placeholders, resolved only when three independent checks pass: network
  policy allows the binary and destination; the credential is bound to that host, port and path; the placeholder is in
  a declared slot (`docs/how-it-works/providers/overview.mdx`).
- **Effective policy:** a base policy plus rules contributed by attached providers; a global policy replaces all of it
  (`docs/how-it-works/policies/overview.mdx`).
- **Policy Advisor:** the agent proposes a narrow rule; a human approves; proposals are rechecked when their inputs
  change (`docs/how-it-works/policies/advisor.mdx`).
- **Prover:** checks that a policy stays within a boundary policy and reports a counterexample; unsupported or
  inconclusive checks are failures, not passes (`docs/how-it-works/policies/prover.mdx`).
- **Events:** security events in OCSF format.

## 2. Adopt the ideas, do not install OpenShell

- **Enforcement vs observation.** OpenShell confines a process; AEGIS observes events and never blocks (draft §4:
  enforcement deferred, M7 zero-output forwarder unchanged).
- **How the owner runs agents.** Installing means running agents inside OpenShell's sandbox (Linux with Landlock plus
  Docker or Podman, or a MicroVM gateway on macOS). Xaibo observes agents wherever the owner already runs them, and
  Docker at runtime is out of Xaibo's scope (PRD §3.2).
- **Network.** OpenShell's telemetry is on by default; Xaibo makes zero non-loopback connections (M6).

## 3. Ideas for AEGIS

All detect-and-alert. A verdict is a recorded finding, never a block.

### O1. Default-deny rules over effective permissions

Rules describe what each agent/profile is expected to touch: file paths (read, write), commands, network destinations
seen in tool input (fetch tools, shell commands), and MCP tools. Anything an event shows outside the rules gets a
`warn` or `deny` verdict in the log. Rules are evaluated as combined permissions (tool, target, action), not as
separate lists, so "may write" and "may reach host X" never combine into a permission nobody granted.

- **TBD, needs validation via a replay of synthetic sessions:** how much of a target is recoverable from stored tool
  input (shell commands are free text; the draft already asks whether tool names plus paths are enough).

### O2. Layered policy: global, profile, project

Like OpenShell's base, provider and global policies: one global policy, per-profile and per-project additions, and one
effective policy per session that the timeline shows next to each verdict. Each session records the policy version that
applied, so editing rules later never changes past verdicts.

### O3. Boundary check

A check that a project or profile policy stays within the owner's global boundary. It compares combined permissions,
returns a concrete counterexample when something exceeds the boundary, and fails on any rule form it cannot evaluate
rather than passing it.

### O4. Rule proposals from findings (advisor pattern)

From a `warn` finding, AEGIS can propose the narrowest rule that would have allowed it. The owner approves or
declines; nothing is added automatically. A proposal states its scope (profile or project), the policy version it
amends, passes O3, and is rechecked if that policy changes before approval. Every approval is audited.

### O5. Credential-use findings

Adapting OpenShell's three checks as detection: flag an event where a credential-looking value or a known credential
variable name appears in tool input sent to a destination the rules do not bind to that credential, or outside a
declared field. Uses the existing masking engine's patterns (S-14); AEGIS never reads credential stores or stores
credential values.

- **TBD, needs validation:** false-positive rate on synthetic sessions before any alert is enabled (draft risk "noisy
  rules").

### O6. OCSF-shaped verdict log

Name verdict-log fields after OCSF (actor, activity, disposition, the rule that fired) so findings can be exported in a
known format. Export stays local and masked (S-24 rules).

### O7. Could: ingest OpenShell's own events

If the owner later runs some agents inside OpenShell, Xaibo could read its local OCSF denial events as one more
evidence source on the same timeline. Only from a local file or loopback source; never a remote gateway.

## 4. Open questions

- [ ] Rule format: own schema, OpenShell-shaped, or Falco-compatible (draft §9 already asks)?
- [ ] Which targets O1 can recover reliably from each agent's tool input.
- [ ] Should O4 proposals appear in the attention queue or only on the AEGIS screen?
- [ ] O5 thresholds before alerts turn on.
