# Local LLM and AEGIS: PRD amendment (DRAFT)

Status: DRAFT, planning only. Nothing here is approved or started. Amends `docs/PRD.md` v1.0 once the owner approves. Estimates are labeled `~`; unknown values stay "unavailable".

## 1. Problem

Xaibo shows what Claude Code, Codex and Gemini CLI did, but it cannot (a) hand routine work to a cheap local model, (b) turn that history into improvements, or (c) answer "what did the AI do between T1 and T2, and did it match my rules?"

Evidence: PRD §1.1 (scattered history, 30-day native deletion). The delegation and cost claims are **assumptions** until the Phase A spike.

## 2. Solution: two optional Settings modules

Both are **off by default** and independent. AEGIS must work with no model installed.

| Module | Does | Needs a model |
|---|---|---|
| **AEGIS** | Rules over the existing normalized tool-call events; verdict log; time-window timeline; alerts. **Detect and alert only.** | No |
| **Local LLM** | Local worker the orchestrator can delegate bounded tasks to; learning loop that proposes improvements and exports a reviewed dataset | Yes |

Orchestrator: Claude decides. Xaibo supplies a `delegate_task` MCP tool whose description lists safe task types, a short delegation-policy file (skill or CLAUDE.md snippet), and a status call (lane availability, queue, recent acceptance rate).

## 3. Placement rule (owner decision)

Xaibo and its model server run **on the same host machine**. Each host uses what it can fit. No cross-machine traffic, so the zero non-loopback rule (M6) is unchanged.

| Host tier | Example | Default worker |
|---|---|---|
| S | Mac, 16 GB unified memory | Qwen3 14B or 8B, 4-bit (small context) |
| M | PC, 32 GB RAM, 8 GB VRAM GPU | Qwen3-Coder-30B-A3B via llama.cpp MoE expert offload (`--n-cpu-moe`), ~10-20 tok/s (estimate, unmeasured) |
| L | 64 GB or more | Qwen3-Coder-Next (80B total, 3B active) |

The model endpoint is an OpenAI-compatible loopback server, so the model is a config value.

### Slow lane (AirLLM): optional, batch only
Layer-by-layer streaming from disk lets a 70B-class model run in a few GB of VRAM but at ~0.2-4 tok/s depending on storage; ~140 GB disk for a 16-bit 70B. Not usable for agent loops. Allowed only for unattended batch jobs (large-diff review, log summaries, data labeling). Supported-model list and Windows/CUDA support are **unverified**; Phase A settles it with one measured run. Skipping it loses little.

## 4. Scope

| Priority | Capability |
|---|---|
| Must | AEGIS observe: rules file, allow/warn/deny verdicts recorded (never enforced), per-agent timeline, time-window query, "changes between T1 and T2" |
| Must | AEGIS alerts on rule hits |
| Must | Settings toggles for both modules |
| Must | Loopback model endpoint, model-agnostic |
| Should | `delegate_task` over the opt-in MCP server (PRD S-21), isolated worktree, diff-only return |
| Could | Learning loop suggestions (human-reviewed); dataset export; MLX/QLoRA recipe |
| Won't (now) | AEGIS enforcement/blocking; automatic retraining; cross-machine worker; LLM in any rule decision path |

Enforcement is deferred. A deny needs a hook that returns output, which breaks the zero-output fail-open forwarder rule (M7); it would be a separate opt-in hook type decided later.

## 5. Conflicts with PRD v1.0 to resolve at approval

1. "Never call models / zero tokens": amend to allow the user-enabled loopback local model; reporting channels stay silent.
2. Out of scope "quality leaderboards": the bake-off is a private measurement, never published.
3. Real transcripts as training data is a new data flow: owner-started step, masked, stored in app data, never in git.
4. Hook forwarder stays zero-output; AEGIS observe adds no new hook behavior.
5. PRD §3.2 out-of-scope list and §10 phases/gates need an amendment entry in the decision log.

## 6. Technical notes

- AEGIS reuses the normalized event schema (PRD §5.4), hook protocol (§7.3), stuck/loop rules (§6.4) and session workspace (S-08). It adds a rules file, a verdict table and a timeline view.
- Prior art to read before choosing a rule format: Prempti (Falco rules, allow/deny/ask), Prismor (observe-by-default), Belay (deterministic, no LLM in the decision path), Pipelock (network egress). Seen via search summaries only; read the repos first.
- Fine-tuning: QLoRA on a 4-bit 4B-8B model fits 16 GB (community guides); ~200-500 examples is the practical minimum for any behavior change. Training memory on an 8 GB GPU is **unverified**.

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tier S memory too small for useful agent work | High | Bake-off; small tasks only; swappable endpoint |
| Small model lowers quality | High | Orchestrator reviews every diff; track acceptance rate |
| Training data leaks private content | Medium | Masking, app-data only, owner approves each export |
| Noisy rules cause alert fatigue | Medium | Log-only first; review a week of data before alerting |
| Model rankings come from blogs | High | Measure on own tasks before choosing |

## 7. Phases (nothing started)

| # | Phase | Delivers | Depends |
|---|---|---|---|
| A | Bake-off spike | Candidates scored on tool-call success, speed, memory; one AirLLM run | - |
| B | AEGIS detect + alert | Rules, verdict log, timeline, alerts, toggle | - |
| C | Local LLM module | Toggle, endpoint, `delegate_task`, policy file, status call | A |
| D | Learning loop | Accepted/rejected results to suggestions; reviewed dataset export | B, C |
| E | Fine-tune recipe | QLoRA on the export | D |

A and B can run in parallel. Phase 3 (live status) is unaffected and finishes first.

## 8. Success metrics (all targets TBD until measured)

| Metric | Target | Measured by |
|---|---|---|
| AEGIS timeline completeness | TBD | Replay synthetic sessions against known tool calls |
| Rule evaluation latency | TBD | Benchmark (other tools claim <100 ms; unverified) |
| Delegated-task acceptance | TBD | Phase A spike over 20-30 task types |
| Non-loopback connections by new code | 0 | Existing M6 audit |

## 9. Open questions

- [ ] Which task types are safe to delegate to a small model?
- [ ] Are tool names plus file paths enough for "which function", or are diffs required?
- [ ] Rule file format: own schema, or Falco-compatible?
- [ ] Keep the AirLLM slow lane, or drop it after the Phase A number?
- [ ] Phase ordering relative to the remaining Xaibo MVP gates.

## 10. Decisions log

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Module placement | Inside Xaibo, Settings toggles | Sibling project | Reuses event stream; owner choice |
| Enforcement | Deferred | Block mode now | Detection and alerting suffice; avoids breaking M7 |
| Orchestrator | Claude decides, guided by policy + status | Xaibo routes tasks | Owner choice |
| Placement | Same host as Xaibo | LAN worker | Keeps zero non-loopback rule |
| Default worker lane | llama.cpp MoE offload | AirLLM | AirLLM too slow for loops |

## 11. Sources (secondary; verify before relying)

AirLLM layer-wise inference and limits: wavect.io, bestllmfor.com blogs. llama.cpp MoE offload: llmhardware.io guide. Qwen3-Coder-Next model card (Hugging Face). Devstral 2 announcement (Mistral). 16 GB Mac guide and MLX fine-tuning guide (insiderllm.com). Agent firewalls: Sysdig Prempti, Prismor, Pipelock write-ups.

*Generated: 2026-11-12. Status: DRAFT, needs validation.*
