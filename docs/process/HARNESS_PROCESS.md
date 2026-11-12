# Harness engineering process

A repeatable way to take any project from idea to reviewed, documented code with an AI coding agent. Copy this file to a new repository unchanged; everything specific to one project goes in that project's `docs/PRD.md`.

Companion file: [PRD_TEMPLATE.md](PRD_TEMPLATE.md).

## 1. Tools and what they do

Checked by reading the two repositories, not from memory. "To check" items need a look on your own machine.

| Tool | What it is | Verified facts | To check on your machine |
|---|---|---|---|
| **Claude Code** | The coding agent (terminal, VS Code, web) | - | - |
| **harness-os** ([repo](https://github.com/thienquy05/harness_os)) | A governance MCP server that runs in Docker with a Postgres database | Tools: `get_constitution`, `create_spec`, `validate_spec`, `assess_risk`, `generate_tests`, `request_review`, `run_workflow`, `workflow_status`, `record_decision`, `trace_artifact`, `impact_analysis`, `validate_coverage`, `audit_report`, `evaluate_governance`. Workflows: `new-feature` (spec → risk → tests → implement → review → finalize → trace), `hotfix`, `security-change`. Rules (the "constitution"): no gated code without a validated spec; a test must be observed failing (RED) before the code and passing (GREEN) after; config files are integrity-checked; agent boundaries. A rule-based risk rubric sets low/medium/high/critical, and critical needs a human approval at a terminal | Containers `harness_postgres` and `harness_gate_daemon` are running; the MCP server is registered in `~/.claude.json` |
| **Everything Claude Code (ECC)** ([fork](https://github.com/WorldFlowAI/everything-claude-code)) | A Claude Code plugin of agents, slash commands, skills, rules and hooks | This fork is a January 2026 snapshot of the upstream project. It contains agents (`planner`, `tdd-guide`, `code-reviewer`, `security-reviewer`, `architect`, `e2e-runner`, `doc-updater`, `refactor-cleaner`, `build-error-resolver`) and commands (`/plan`, `/tdd`, `/verify`, `/code-review`, `/checkpoint`, `/e2e`, `/eval`, `/learn`, `/update-docs`, …) | Which version you installed: harness-os calls ECC skills (`orch-add-feature`, `orch-fix-defect`) and reviewers (`python-reviewer`, `fastapi-reviewer`, `typescript-reviewer`, `database-reviewer`) that are **not** in this fork's snapshot. Check that your installed ECC has them |
| **Playwright MCP** | Drives a real browser so the agent sees what actually renders | - | Registered as an MCP server; used for every frontend or full-stack change |

## 2. File and naming convention

All documents live in `docs/`. A subfolder is used when several files share a purpose.

| File | Purpose |
|---|---|
| `docs/PRD.md` | Source of truth: what, why, data, evaluation, acceptance checklist |
| `docs/plans/<feature>_plan.md` | Implementation plan derived from the PRD |
| `docs/plans/<feature>_progress.md` | Live status and design decisions, updated after every step |
| `docs/process/` | This process and the PRD template |

## 3. The process

1. **Interview and PRD.** The agent asks the questions in §6, then drafts `docs/PRD.md` from the template. Remove sections that do not apply. The agent never guesses: unclear points go to the PRD's open-questions table with a default.
2. **Privacy gate.** Before any text leaves the machine (Git, another tool, a chat), check it for real names, IDs, dates, paths and data. Use placeholders.
3. **Review the PRD yourself.** Nothing is implemented until you have read and approved it.
4. **Plan.** In a fresh session: read the PRD, explore the codebase, ask clarifying questions about requirements, constraints and edge cases, then write `docs/plans/<feature>_plan.md`. Phases come from PRD §10, tests from PRD §9, "done" from PRD §1.6 and §9.3.
5. **Challenge the plan.** A second session (a different model only if the privacy gate allows) looks for holes. Revise and note what changed.
6. **Implement in small steps with a verification loop:**
   1. write the test or execution script first;
   2. implement the step;
   3. run the loop and compare with the expected output;
   4. if it differs, debug before moving on;
   5. update the progress file and record every design decision, especially where the PRD left a detail open.
7. **Review.** Review the uncommitted changes against the plan and the PRD like a staff engineer: correctness, performance, security, privacy. A second reviewer is preferred.
8. **Finalize.** Update the plan and progress file with what was actually built and why; that is the documentation. Commit only when the owner says so.

### The harness pipeline inside step 6

When harness-os governance is active for the project, each unit of work follows its order: **Constitution → Specification → Test Suite → Generate Code → Code Review**, run through `run_workflow` (`new-feature`, `hotfix` or `security-change`). The server advances a stage only when it observes evidence (for example a test run observed failing).

Test runs: the hook runs a matched test command once, records its exit code, then blocks the agent's identical Bash call and returns the result (exit code, last 80 lines, full log path). That block is the test result, not an error; read the log path rather than re-running. Only the configured command runs, plus arguments that are `--` or existing paths; anything piped or chained after it (`| tail`, `&& build`, `2>&1 | …`) and any other flag is dropped. Never pipe or chain the test command; run other steps as separate calls. `request_review` requires an independent, fresh-context reviewer subagent (Opus for high/critical risk, Sonnet for medium) given only the diff, spec and test results.

## 4. Before turning harness-os governance on for a project

`harness init` is a one-time, per-project step. It is not "just configuration", so decide it deliberately:

- It writes `.claude/` (hooks, `settings.json`, `harness.config.json`, `agents/AGENTS.md`) **and makes a git commit** ("harness: initial project scaffold").
- For Python it gates every `**/*.py` file: writes are blocked until a validated spec covers the file and its test has been seen failing.
- Its gate daemon can only see the folder mounted as `HARNESS_PROJECTS_ROOT`, so the project must live under it.
- Its runbook uses the author's own home paths (`~/...`) and a WSL2 + Docker setup; adapt them to your machine.
- Risk is classified by keywords in the request text and paths. Words such as `order`, `token`, `session` or `credential` can raise the level and trigger a human approval prompt even in harmless work; expect to see this and read the rationale rather than ignoring it. Keywords match whole words only (`border` is not `order`); a project can tune them with `risk` in `harness.config.json` (`ignoreKeywords`, `extraCritical`, `extraHigh`), applied only while the config verifies, and only with owner approval.
- Config files are integrity-checked; if you edit one deliberately, run `harness reconcile-config <project>`.

Ask the owner before running it, and say plainly that it commits.

## 5. Verification loop by project type

| Project part | Loop |
|---|---|
| Backend / library | Linter, unit tests, an end-to-end run on synthetic data |
| Frontend / full-stack | **Playwright MCP**: open the page, look at the rendering, check the console and the key flows. Do not infer correctness from code |
| Data / ML (add these) | Leakage tests (no row or group in two folds; scalers fit on training data only), fixed seeds, forbidden-column assertions, baselines reported next to every model, a reload-and-reproduce test for saved models |

Set these loops up before the agent starts implementing, and run them after every significant change, not only at the end of a phase.

## 6. Questions the agent asks at the start of every project

**Goal and users**
1. What problem is solved, for whom, and what is the cost of not solving it?
2. What does "done" mean, and who decides?
3. What is explicitly out of scope?

**Data and privacy**
4. What data exists, how much, and what is restricted? What may never appear in Git, chats or documents?
5. Where may data be stored and moved (approved cloud storage, USB, direct copy)?
6. Which names, IDs and dates need placeholders?

**Technical**
7. Language, frameworks, and what must keep working (operating systems, Python versions, CI)?
8. Where does it run (local, remote machine, GPU), and how is it reached and monitored?
9. How are results and models retrieved and re-used?

**Quality**
10. Which risks matter most (leakage, security, correctness, performance)?
11. What are the known edge cases and failure modes?
12. What must be tested before code is written?

**Process**
13. Is harness-os governance on for this project (see §4)? Which verification tool for the UI?
14. May the agent commit and push, or only when told?
15. Are external review tools allowed, and on what material?
16. Deadline, reviewers, and the gates where you want to stop and look?

## 7. Master prompt (fill the brackets per project)

```
I want to implement [project/feature]. The full PRD is at docs/PRD.md; read it in full first.
It is the source of truth; this prompt sets the process, not the spec.

1. Plan: write docs/plans/[feature]_plan.md. Take the phases from PRD §10, the tests from
   PRD §9 (every row of the edge-case catalog is a required task), and "done" from PRD §1.6
   and §9.3. Ask me clarifying questions before writing it.
2. Implement phase by phase. For each step: implement, run the verification loop, confirm the
   output matches, debug before moving on, and record progress and design decisions in
   docs/plans/[feature]_progress.md.
3. Backend and ML: write execution scripts or tests first; run them after every significant change.
4. Frontend: use the Playwright MCP server and look at what renders.
5. If harness-os governance is on, follow its pipeline for every unit of work and do not skip stages.
6. Review the uncommitted changes against the plan and the PRD for correctness, performance,
   security and privacy before calling a step done.
7. Do not commit, push or open a pull request unless I ask. Ask me when anything is unclear.

Don't miss these (project-specific): [easy-to-forget requirements]
```

Keep the progress file current throughout; it must always show the real status, not a snapshot from when the plan was written.
