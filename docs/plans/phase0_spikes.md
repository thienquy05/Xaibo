# Phase 0 spike report

Final Phase 0 report for Gate 0. Structure per plan §0.16; criteria that were not run carry a status other than pass and a stated consequence.

| Item | Value |
|---|---|
| PRD version | v1.1 Gate 0 delta (pending owner approval); base Approved v1.0 (2026-11-09, errata D-P0-05) |
| Date | 2026-11-10 |
| Branch | `feat/phase0-spikes` |
| Agent pins | codex 0.160.0 and gemini 0.46.0 verified (S9-C1, runner). claude 2.1.319 for S3, S4, S9 and S13-T1..T5; the install auto-updated to **2.1.322** before S7, so S7 and the S13-T6 leftovers are 2.1.322 (D-P0-33) |
| electron / its node, v8, chrome | 45.2.3 / node 24.22.2, v8 15.6.75.27-electron.0, chrome 156.0.8078.80 (P0-T01). Electron's bundled Node (24.x) differs from system Node (26.x); S1 tests the bundled one |
| typescript | 7.0.2 (P0-T01) |
| electron-builder | 26.18.0 (P0-T01) |
| Reference machine | Apple Silicon (M4 class, 16 GiB RAM class), macOS 27.2 |
| Percentile method | Nearest-rank: value at rank ceil(q/100 · n) of the sorted samples (`spikes/shared/bench.ts`, tested: p95 of 1..100 = 95; single sample = itself) |
| Corpus seeds | 12001–12009 (listed in § S12, 2.3) |
| Privacy | This file and all of `spikes/` hold no absolute paths, usernames, uids, ports, session IDs, prompts, transcript content or counts from the owner's stores. Only reduced schemas, allowlisted identifiers, pass/fail, booleans and timing aggregates. Checked by `npm run privacy:scan` at the gate. |

Status values per criterion: pass, fail, not-triggered, unsupported, not-run, or `UNVERIFIED` (not yet run). "not-run" and "not-triggered" are never passes.

## Environment

| Check | Result |
|---|---|
| Install pins (`package.json`, `package-lock.json`, `.npmrc` `save-exact`) | pass: devDependencies `electron` 45.2.3, `electron-builder` 26.18.0, `typescript` 7.0.2, exact (P0-T01) |
| `npm config get cache` resolves to the repo `.cache/npm` | pass: relative `cache=.cache/npm` resolves to the repo when npm runs from the repo root (run npm from the repo root) |
| Electron zip present in `.cache/electron` | pass: `electron-v45.2.3-darwin-arm64.zip`. Electron 45 has no postinstall download; the binary is fetched by `install-electron` (or lazily on first use). Fetched explicitly with `electron_config_cache=<repo>/.cache/electron npx --no-install install-electron`; inside the Claude sandbox Node's `fetch` also needs `NODE_USE_ENV_PROXY=1` to use the sandbox proxy |
| No new or modified entries under `~/Library/Caches/electron` and `~/Library/Caches/electron-builder` | pass: before/after listing identical (neither dir exists) |
| `git status --porcelain` differs only by the three install files | pass: `.npmrc`, `package.json`, `package-lock.json` |
| Install notes | npm 11 left `electron-winstaller` (Windows-only, transitive via electron-builder) install script unapproved, not run, not needed on macOS. A few non-runtime package files (`.gitmodules`, `.vscode/`) were not extracted because the sandbox denies those names. `npm audit`: 6 moderate advisories in the dev-only tree, recorded for the Gate 0 dependency list |
| Launch environment | The VS Code host exports `ELECTRON_RUN_AS_NODE`; with it set, `electron --version` reports the Node version. Every Electron launch must unset it (the `env -i` runner does) |
| Spike app build summary (size, Electron version, signing state) and smoke | pass: `XaiboSpike.app` ~268 MB, Electron 45.2.3, packaged offline from the installed `node_modules/electron/dist` (`electronDist`); electron-builder leaves only the linker signature, so `codesign --verify --deep --strict` failed until the planned ad-hoc post-step (`codesign --force --deep --sign -`), now part of `dist:mac`; verify ok. Smoke (mode `idle`, temp data dir, unsandboxed): service ready over IPC, renderer paint ack, exit 0 on quit, no orphan processes 2 s after quit, userData inside the data dir |
| RunAsNode fuse state | enabled (default): `ELECTRON_RUN_AS_NODE=1 <app binary> -e …` prints the bundled Node version (needed by S3 candidate A; a local-code-execution surface to weigh in S3) |
| Paths written outside the data dir | finding: one new file, `~/Library/Preferences/local.xaibo.spike.plist`, holding AppKit/Electron framework defaults (text-direction, argument-handling and StoreKit keys; no app data). `app.setPath` cannot redirect macOS preferences, so the plan's "data dir is the only new path" expectation cannot hold for an Electron app. Nothing under Application Support, Caches, HTTPStorages or Saved Application State. Proposed for the Gate 0 PRD delta (data-location wording); the file is removed at Gate 0 cleanup (P0-T09) |
| `git status --porcelain` unchanged by the run (EC-61 input) | pass |

## Guard

Procedure: P0-T04 (`guard.ts snapshot|compare`), P0-T05 (runner, deny wrapper, nesting probe), P0-T06 (credential backend, auth probe, sign-in), P0-T09 (cleanup). Only `MATCH`, `DIFF` with per-category counts, `unmatched-change <n>` and `expected-new 1` are reported here.

| Item | Result |
|---|---|
| Baseline snapshot + immediate compare | MATCH (2026-11-10; retaken after the review fixes extended the watched file set, before any live work; keychain enumeration populated, manifest private 0700/0600; runs inside the Claude sandbox) |
| Runner isolated (env, five isolation variables, real-root refusal) | isolated: yes. `in-profile.sh <agent> a -- /usr/bin/env` lists only allowlisted names with all isolation paths and `TMPDIR` under the profile root, for all three agents; target checks refuse real-root overlap, symlink escape and out-of-profile targets; deny profile denies read and write of every real root (dir and file roots, absent and later-created roots, delete/replace/rename through the parent, symlinks), allows the temp profile, and the canary catches a no-op wrapper (`npm run spike:test` 20 tests, `npm run spike:test:unsandboxed` 7 tests) |
| Nesting probe (1) nested `sandbox-exec` | does not nest: `sandbox_apply: Operation not permitted`. Every Codex command that uses its own tool sandbox falls under OQ-X16 (owner choice per command) |
| Nesting probe (2) packaged spike app under the wrapper | does not nest: Electron helpers report `sandbox initialization failed: Operation not permitted`. Every packaged-app and VS Code launch under the runner falls under OQ-X16. Spike-app runs without an agent (S1, S3 service side, S10, S12) do not use the runner |
| Escape detection (runner) | macOS 27.2 shows no other process's environment to a normal user (`ps -E` prints none), so the plan's `XAIBO_RUN_TOKEN` environment scan cannot work. The supervisor instead (1) records every process whose parent chain reaches the command or whose group is the command's at each 50 ms poll (pid + start time) and reports any still alive after shutdown, and (2) hands the command an inherited fd on a per-run marker file (system temp dir) and lists holders with `lsof`; Node-spawned children (Claude Code, Gemini) do not inherit fds, which is why (1) exists. `survivors <n>` fails closed, as do `ps`/`lsof` failures. Limit: a double fork that detaches within one poll gap and holds no marker fd; the block backstop (`in-profile.ts block-start/block-end`) lists it (all tested) |
| harness-os VM and the repo | The harness-os Virtualization VM mounts the repo and holds handles on new files under it (seen when it held a marker file in the repo). Owner moved temp profiles outside the repo to `~/.xaibo-spike-profiles/` (D-P0-15) |
| Guard clean for all blocks (P0-T09) | every live block: MATCH, or owner-session real-config changes with 0 credential and 0 agent keychain changes; non-agent keychain changes adjudicated by the owner (D-P0-20, D-P0-32) and the three later ones (`s6b-pre`, `s7d-pre`, `s10b-pre`) treated as owner activity, left unmarked (D-P0-35) |
| Final `baseline` compare at Gate 0 (P0-T04, G0-13) | not possible as planned: the Phase 0 `baseline` snapshot was lost when the local `.cache/` was emptied mid-phase; every block from S10 on has its own snapshot and compare, which replaces it (D-P0-35) |

| Agent | Credential backend isolated (docs) | Temp login isolated from real store | Temp keychain item added | `--version` guarded `MATCH` |
|---|---|---|---|---|
| claude | yes (2.1.319 binary text): macOS keychain item `Claude Code-credentials` plus `-<first 8 hex of sha256(config dir)>` whenever `CLAUDE_CONFIG_DIR` is set (account `$USER`); a temp profile therefore gets its own item name, expected as one new item; plaintext fallback `.credentials.json` in the config dir | yes: owner sign-in through the runner; probe showed not signed in; guard MATCH before and after. The login landed in the temp config dir `.credentials.json` (0600): under the temp HOME the macOS login keychain is not found, Claude fell back to its file store (a keychain dialog appeared once; its "Reset To Defaults" changed nothing real: same default/login keychain, same search list, 0 agent-item changes) | no | MATCH (prints the pin 2.1.319; before = after; wrote nothing into the temp home) |
| codex | yes (0.160.0 docs + binary text): `cli_auth_credentials_store` default `file` = `$CODEX_HOME/auth.json`; the temp `config.toml` sets `file` explicitly. A separate keyring "secrets key" path exists (trigger not determinable from docs); any agent-named keychain change is a guard DIFF | yes: owner sign-in (`codex login`, browser) through the runner; probe "Not logged in"; guard MATCH before and after; credentials in the temp `auth.json` | no | MATCH (prints the pin 0.160.0; before = after) |
| gemini | yes only with `GEMINI_FORCE_FILE_STORAGE=true` (0.46.0 bundle text): otherwise OAuth tokens use one fixed-name keychain item (`gemini-cli-oauth` / `main-account`) shared by every profile, which a temp sign-in could overwrite. The runner sets the variable for every profile; tokens then go to `<GEMINI_CLI_HOME>/.gemini/gemini-credentials.json` | not signed in: Google rejected "Sign in with Google" for this client ("no longer supported for Gemini Code Assist for individuals", pointing to Antigravity). Owner chose to skip Gemini live parts (D-P0-19) | no | MATCH (prints the pin 0.46.0; before = after) |

| Live session / block | Guard result |
|---|---|
| `gemini --version` (runner) | MATCH |
| `claude --version` (runner) | MATCH |
| `gemini --help`, `claude --help`, `claude auth --help` (runner) | MATCH |
| Gemini unauthenticated auth probe (P0-T06 step 3) | MATCH |
| `codex --version`, `codex --help`, `codex login --help` (runner) | MATCH |
| Owner sign-in Codex (P0-T06 steps 2–5) | MATCH (probe and after sign-in) |
| Owner sign-in Claude (P0-T06 steps 2–5) | MATCH (probe and after sign-in; first attempt failed to save to the keychain, retry saved to the temp file store) |
| Gemini sign-in attempt | blocked by Google; compare afterwards showed config DIFF from the owner's own sessions (adjudicated, D-P0-20) |
| PR-OK prompt, Claude and Codex (P0-T06 step 6) | both answered OK; transcript/rollout appeared under the temp roots; guard DIFF limited to `~/.claude/plugins` refresh churn by the owner's running Claude Code (adjudicated; guard refined to names-only for that tree, D-P0-18); backstop: 0 new processes belong to the runs |
| New `baseline` after the guard refinement (old kept locally as `baseline-v1`) | MATCH |
| S10 run (`s10-pre`; snapshots retaken because the local cache had been emptied) | credential 0, agent keychain 0; real-config and non-agent keychain changes from the owner's own sessions (D-P0-32) |
| S10 re-run (`s10b-pre`) | credential 0, agent keychain 0; a non-agent keychain change, treated as owner activity, left unmarked (D-P0-35) |
| S6 blocks (`s6-pre`, `s6b-pre`, `s6c-pre`, `s6d-pre`) | `s6-pre`, `s6c-pre`, `s6e-pre` MATCH; `s6d-pre` credential 0, keychain 0, a real-config change (owner sessions running); `s6b-pre` a non-agent keychain change, treated as owner activity, left unmarked (D-P0-35) |
| S7 blocks (`s7-pre`, `s7b-pre`, `s7c-pre`, `s7d-pre`) | `s7-pre`, `s7c-pre` MATCH; `s7b-pre` credential 0, keychain 0, a real-config change (owner sessions running); `s7d-pre` a non-agent keychain change, treated as owner activity, left unmarked (D-P0-35) |

## 1. Summary

| Spike | Scope | Verdict | Decision (one sentence) | PRD sections changed | Evidence anchor |
|---|---|---|---|---|---|
| S1 SQLite | required (one engine) | Pass | `node:sqlite` from Electron's bundled Node; no `better-sqlite3` | App. E #6; App. C; §7.4 | [S1](#s1--sqlite-engine) |
| S3 Forwarder | required (speed: M1/M16) | Pass-narrowed (owner accepted the M16 burst miss) | SEA forwarder over a private socket; commit ack; Stop synchronous, others async | Q7, Q17, App. E #18/#19, §7.3, D-7 (proposed) | [S3](#s3--hook-forwarder-runtime-and-reporting-path) |
| S4 Claude plugin | required (D-2; fallback tested separately) | Pass | hooks-only plugin route adopted; plugin and fallback mutually exclusive | App. E #1, #2, #18; FR-30 (proposed) | [S4](#s4--claude-hooks-only-plugin) |
| S5 Codex hooks | required; plugin route optional | Pass-narrowed (C5: trust shift mitigated by an untested append rule; plugin route not-run) | `hooks.json` + Codex trust review; Xaibo groups appended after foreign entries | App. E #5; FR-31 (proposed) | [S5](#s5--codex-hooks-and-trust) |
| S6 Codex interop | required; negative attachment acceptable (observe-only) | Pass-narrowed (daemon mode, VS Code, Desktop untested) | external sessions observe-only; verified resume/fork syntax | Q3, FR-21, FR-22, EC-05, EC-50, EC-68, EC-74 | [S6](#s6--codex-interoperability) |
| S7 Claude interop | required; Desktop listing and `--bg`/attach optional | Pass on 2.1.322 (Desktop, VS Code untested; `--bg` not exercised) | manual denial from the transcript; elicitation hooks validated; background completion after Stop | §6.2, Q12, EC-40, EC-41, EC-67, EC-70; App. E #3, #13, #14 | [S7](#s7--claude-interoperability) |
| S9 Format survey | C2–C5 required; C6–C7 optional | Pass (C6 not-triggered, optional) | fact set + schemas + fixtures pinned; streaming zstd; `sessions/*.json` not used | App. E #8, #11, #24; §5.1 (proposed) | [S9](#s9--format-survey) |
| S10 Network | required (zero attempted connections) | Pass | kill-on-attempt audit profile with positive controls; existing policy suffices | S-14, P2, M6, EC-60; M4 at risk | [S10](#s10--network) |
| S11 Gemini/catalog | C1–C5 core-required; C6–C8, C11 conditional; C9, C10, C12 catalog-required (OQ-C14) | Fail→owner (Gemini live), catalog pass | Gemini live UNVERIFIED (owner: skip); catalog draft + validator `ajv` 8.20.0 | Q18; App. E #16/#17/#24; App. C (proposed) | [S11](#s11--gemini-and-catalog) |
| S12 Capacity/latency | required (capacity) | Pass-narrowed (owner: personal profile, D-P0-24) | §7.1 layout C; batch 100 rows/50 ms/1 MiB; per-file watch + 5 s scan | FR-02, Q8, Q19, App. E #20/#26 (proposed) | [S12](#s12--capacitylatency-feasibility) |
| S13 Passive usage/context/cost | required; no qualifying tee returns to owner | Pass-narrowed (C8 partial) | SEA statusLine tee; Claude account scope unverified; Codex salted-hash account marker | FR-51, §5.11, §5.12, App. E #22 | [S13](#s13--passive-usage-context-and-cost) |

## 2. Per-spike sections

Each section uses the same template: 2.1 question and PRD refs; 2.2 criteria (PRD §10 text split into rows); 2.3 method; 2.4 evidence per criterion; 2.5 decision (exactly one, citing its criteria); 2.6 consequences.

### S1 — SQLite engine

**2.1 Question and refs.** Which SQLite engine runs in the packaged `utilityProcess`? Plan §0.4; PRD §10, S-04, FR-09, §7.4, App. E #6, App. C.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S1-C1 | Packaged `utilityProcess` opens the DB | pass | `.cache/spike-results/s1/probe.json` (local), reduced here: opened in the utility process main thread and in a `worker_threads` worker it spawned |
| S1-C2 | WAL works | pass | `journal_mode` reads back `wal` (main and worker); all §7.4 pragmas read back: `synchronous` 1 (NORMAL), `foreign_keys` 1, `busy_timeout` 5000, `auto_vacuum` 2 (INCREMENTAL, set before the first table), `temp_store` 2 (MEMORY) |
| S1-C3 | FTS5 works | pass | `ENABLE_FTS5` compiled in; external-content `unicode61` table: insert, `MATCH`, `snippet()`, `bm25()` and `integrity-check` all ok (main and worker); `contentless_delete=1` available |
| S1-C4 | Transactions work | pass | `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, savepoint rollback, 10,000 executions of one prepared statement (~3 ms main, ~4 ms worker, spike, not gate evidence); a second `readOnly` connection keeps its snapshot while a write transaction is open and sees the row after `COMMIT` |
| S1-C5 | Kill/restart preserves committed events and checkpoints | pass | `spikes/s1/check.ts --crash`: 200/200 service SIGKILLs at `mulberry32(1)` instants and 20/20 main SIGKILLs, each restart with (a) `integrity_check` ok, (b) FTS integrity ok, (c) per-source event count = checkpoint offset, (d) every acknowledged batch present, (e) `journal_mode` still `wal`; no orphan processes 2 s after each main kill. Detection proven first: a two-transaction stub writer fails (c) on every restart |
| S1-C6 | One engine chosen | pass | `node:sqlite` (decision below); `better-sqlite3` not needed |

**2.3 Method.** Packaged `XaiboSpike` (Electron 45.2.3, bundled Node 24.22.2) launched unsandboxed with a temp `XAIBO_DATA_DIR`, no agent and no profile; modes `s1-probe` and `s1-crash` in `spikes/app/service.ts` using `spikes/s1/db.ts` (`DatabaseSync`); worker `spikes/s1/worker.ts`; driver `spikes/s1/check.ts` (`npm run spike:s1`, `npm run spike:s1 -- --crash`). Writer batches of 1–500 synthetic events across 3 sources plus the checkpoint row and the batch row in one transaction; `ack(batch_seq)` only after `COMMIT`. No guard needed (no agent, no real store).

**2.4 Evidence (versions and options).** SQLite 3.53.4; `THREADSAFE=1`; `ENABLE_FTS5`; `ENABLE_DBSTAT_VTAB` (DBSTAT usable, so S12 can report per-table bytes); online `backup()` API works (restored copy passes `integrity_check`, EC-45 recovery path); `PRAGMA incremental_vacuum` available. Module stability: Node 24.22.2 docs mark `node:sqlite` "Stability: 1.2 – Release candidate"; no `ExperimentalWarning` on the utility process stderr.

**2.5 Decision.** Use `node:sqlite` (`DatabaseSync`) from Electron 45.2.3's bundled Node in the `utilityProcess` and its workers; `better-sqlite3` is not installed (S1-C1–C6).

**2.6 Consequences.** App. E #6 resolved; App. C `better-sqlite3` row → "not needed"; §7.4 engine sentence names `node:sqlite` with SQLite 3.53.4 and the compile options above. API stability: release candidate, so Electron stays pinned and the S1 probes (`npm run spike:s1`, `-- --crash`) are re-run on every Electron bump. Phase 5 purge can use `contentless_delete`. EC-45 can rely on the online backup API. New risk: none beyond the release-candidate status.

### S3 — Hook forwarder runtime and reporting path

**2.1 Question and refs.** Which forwarder runtime and per-event reporting path, and where is the ack point? Plan §0.5; PRD §10, S-05, FR-03, US-1, M1, M16, §12 Q7, Q17, App. E #18, #19.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S3-C1 | Compares packaged Electron-run-as-Node, a minimal standalone packaged forwarder, and native Claude HTTP on supported events | pass | A = Electron 45.2.3 binary with `ELECTRON_RUN_AS_NODE` (forwarder unpacked from asar; reading it from inside asar costs nothing measurable); B = Node SEA (`--build-sea`, code cache on/off, ad-hoc signed); C = Claude `type: "http"` hooks to a SEC2 loopback receiver |
| S3-C2 | Dispatch/spawn, forwarder, transport, service, renderer and paint measured separately | pass | hop table below; clock sanity (1,000 cross-process pings, send < receive) pass |
| S3-C3 | Synchronous agent wait measured against a no-Xaibo baseline | pass | `/bin/sh -c true` baseline, n = 1,000 per candidate and mode |
| S3-C4 | M1 | pass (spike, not gate evidence) | end-to-end dispatch→paint ack p95: A 57 ms, B 49 ms, C 15 ms (≤ 250 ms) |
| S3-C5 | M16 | fail for A and B under a 50-way burst; pass otherwise | single dispatch added wait p95 A ≈ 58 ms, B ≈ 33 ms in every mode; own deadline met; burst of 50 simultaneous dispatches: added wait p95 A ≈ 453 ms, B ≈ 276 ms, own max A 155 ms, B 177 ms (CPU contention of 50 process starts). Returned to owner (§4) |
| S3-C6 | Silent failure | pass A, B; partial C | A/B: 0 stdout/stderr bytes and exit 0 in all 9 modes × 1,000; C: one live service-down run printed agent-visible stderr (83 B across several http events; 0 B for a Stop-only hook) |
| S3-C7 | Authentication | pass | socket: per-install token (0600) in every frame, constant-time compare; HTTP: token header (docs: header values can come from env via `allowedEnvVars`, so no plaintext token is required in settings) |
| S3-C8 | Bounded input | pass | forwarder keeps ≤ 256 KB with a 40 ms stdin deadline (300 KB, 10 MB and never-closed stdin all exit 0 in time, flagged truncated); receiver rejects frames > 1 MB, bad version, bad token, bad JSON and truncated frames without a crash; HTTP receiver caps bodies at 1 MB |
| S3-C9 | Native trust | pass (shim) | one stable shim path (`shim.sh` model of `xaibo-hook`) is the only command in agent config for A and B; Codex trust behaviour itself is S5 |
| S3-C10 | Service-down recovery | pass A, B; fail C | A/B: no socket or no ack → spool within the deadline; live service-down run: reply clean, 0 stderr bytes, 3 spooled, 3 replayed on the next start; C: nothing spooled (hook-only evidence lost) |
| S3-C11 | Spool replay | pass | 1,000 spooled deliveries with 10 % duplicates replay to exactly 900; at-least-once duplicates (delivered and spooled under load) removed by `delivery_id` |
| S3-C12 | No-system-runtime packaging | pass A, B | both run under `PATH=/usr/bin:/bin` with no Node reachable; A needs the RunAsNode fuse left enabled (a local-code-execution surface); B adds a ~138 MB binary and needs a static Node to build (Homebrew Node is a shared-library build with SEA disabled; official Node 26.10.0 tarball used, D-P0-21) |
| S3-C13 | HTTP gaps documented | pass | docs: `SessionStart` and `Setup` do not support `http`; `async` exists only for command hooks; any failure is a non-blocking error unless `onFailure: "block"`; live: C received every subscribed event except SessionStart, nothing is spooled when the receiver is down, agent-visible stderr seen once |

Rule: no qualifying option means an owner-reviewed target/implementation decision (report §4).

**2.3 Method.** `spikes/s3/forwarder.cts` (CommonJS, builtins only, also the SEA entry), `spikes/s3/shim.sh`, `spikes/s3/receiver.ts` (socket) and `spikes/s3/http-receiver.ts` hosted by the packaged service in mode `s3`; benches `spikes/s3/dispatch-bench.ts` (modes up, no socket, no ack, full 1 MiB disk image, malformed stdin, 300 KB, 10 MB, stdin never closed, 50 concurrent; n = 1,000 each plus 10 runs after 60 s idle), `spikes/s3/e2e.ts` (hops to the renderer's paint ack, both ack points, synthetic HTTP POST), `spikes/s3/live.ts` and `spikes/s3/live-stop.ts` (temp Claude profile, ≤ 3 prompts per candidate). Guard `s3-pre` and `s3-stop-pre`: MATCH; block backstop: 0 processes belong to the runs.

**2.4 Evidence (hops, p95 in ms, n = 1,000).**

| Candidate | dispatch/spawn | forwarder | transport | service | renderer+paint (upper bound) | end-to-end |
|---|---|---|---|---|---|---|
| A Electron-as-Node | 54.4 | 2.7 | 0.15 | 0.02 | 0.3 | 57.3 |
| B SEA | 30.8 | 4.9 | 0.15 | 0.02 | 15.2 | 49.0 |
| C HTTP | — | — | — | 0.01 | 15.2 | 15.2 |

Other facts: ack point (i) after validation + publish p95 0.06 ms; (ii) after an immediate small SQLite commit p95 0.14 ms (both far inside the deadline). First runs after 60 s idle: A p95 101 ms, B 67 ms. SEA code cache on vs off: no measurable difference. Own deadline must be 100 ms minus runtime startup p95 (else a hung service costs 125–150 ms in total); with 40 ms (A) / 60 ms (B) a hung service costs 82 / 77 ms on warm runs; after 60 s idle (B startup p95 67 ms) it can exceed 100 ms, so the Phase 3 derivation uses the idle-start p95. Live (temp Claude 2.1.319, `claude -p`): A and B async command hooks delivered SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SessionEnd; an async Stop hook runs but is lost (not delivered, not spooled) because the headless process exits; a synchronous Stop is delivered. Transcripts: Claude adds a `system` record (`subtype` `stop_hook_summary`) with hook count; added context empty and hook errors 0 in every run except the HTTP service-down run (1). Turn time with async hooks equals the no-hook baseline (coarse).

**2.5 Decision.** Owner decision 2026-11-10 (record_decision 23): runtime B, the Node SEA forwarder behind a stable shim; private Unix socket for every event (HTTP not adopted); ack after an immediate small SQLite commit (OQ-A1 ii); Stop synchronous, all other events async; forwarder own deadline = 100 ms minus the SEA's startup p95 (≈ 60 ms). The M16 miss under a 50-way simultaneous burst is accepted by the owner (S3-C4–C13; OQ-A2 would have chosen A; owner weighted the lower added wait).

**2.6 Consequences.** Q7 and Q17 answered (SEA over a private socket; no automatic HTTP switch); App. C delta: the product build needs a static Node runtime to build the SEA (Homebrew Node cannot; the product Node binary is decided in Phase 3 per OQ-A4) and ships a ~138 MB forwarder; App. E #19 resolved (ack point and runtime); App. E #18 updated with S4; §7.3 forwarder-runtime sentence; D-7 note (HTTP gaps). New facts for later gates: the forwarder deadline is derived from runtime startup (Phase 3); async Stop is lost in headless Claude (Phase 3 hook design: Stop synchronous); EC-11/EC-12/EC-32/EC-44/EC-63/EC-64 inputs above; the spike app needs a visible window for paint measurement (an occluded window gets no frames).

### S4 — Claude hooks-only plugin

**2.1 Question and refs.** Does the hooks-only plugin route (D-2) work end to end in a disposable profile? Plan §0.6; PRD §10, FR-30, FR-32, FR-34, S-05, US-7.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S4-C1 | Install in a disposable profile | pass | `claude plugin marketplace add <dir>` then `claude plugin install xaibo-hooks-spike@xaibo-spike -s user`, both exit 0 with no confirmation flag (`--accept-command`/`-y` exist for marketplace-declared commands, not needed here); validate passes (only an `author` warning). Files changed by the CLI: plugin cache under `plugins/cache/<marketplace>/<plugin>/<version>/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `settings.json` (`enabledPlugins`) |
| S4-C2 | Restart/reload | pass (new sessions) | hooks active in every new `claude -p` session after install; in-session `/plugin` or `/hooks` reload not exercised (headless) |
| S4-C3 | Event receipt | pass | received with schemas (`spikes/s4/evidence/hooks/`): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop, SessionEnd. Not triggered in spike: PostToolUseFailure, PermissionDenied, Notification, Elicitation, ElicitationResult, StopFailure, PreCompact, PostCompact, CwdChanged; Stop with `async: true` is lost in headless runs (S3 finding: Stop must be synchronous) |
| S4-C4 | Duplicate-install prevention | pass | a second `install` exits 0 and the plugin stays listed once (idempotent); plugin plus a settings fallback hook deliver every common event twice, so plugin and fallback are mutually exclusive (EC-09) |
| S4-C5 | Disconnect | pass | `claude plugin uninstall … -s user` and `claude plugin marketplace remove xaibo-spike` exit 0; not listed afterwards; no recorder line afterwards |
| S4-C6 | Conflict-safe restoration | pass | a foreign `enabledPlugins` entry added while installed survives uninstall; a seeded synthetic foreign hook and custom `statusLine` are unchanged through install and uninstall; leftovers are Claude-owned (cache marked `.orphaned_at`, `.last-cleanup`, `.claude.json`, a built-in plugin store file) |
| S4-C7 | No skills, MCP definitions or context output in the hooks-only plugin | pass | plugin has only `plugin.json`, `hooks/hooks.json`, the recorder; token sum of the first assistant record identical with the plugin enabled and disabled (delta 0); a stdout-marker variant reaches the transcript and adds 34 tokens, which is why hooks print nothing |
| S4-C8 | Fallback tested separately (`--settings` experiments only if the fallback requires them) | pass | marker-based settings merge (commands under a `xaibo` integrations dir) delivers SessionStart, UserPromptSubmit, PreToolUse, SessionEnd and is removed byte-identically; `--settings`/`--plugin-dir` exist in `--help` but were not needed (App. E #2 open, "not required") |

**2.3 Method.** Temp Claude profile, runner, `spikes/s4/run.ts` (headless `claude -p`; PR-OK, PR-TOOL, PR-WRITE denied in headless mode, PR-SUB), marketplace copied to the temp profile as a stand-in for the integrations dir. Guard `s4-pre`: MATCH; block backstop: 0 new processes. Other facts: `disableAllHooks: true` in settings blocks plugin hooks and is detectable from the settings file (EC-49); plugin `hooks.json` accepts `type: "http"` (validate passes; App. E #18 plugin share).

**2.5 Decision.** Plugin route adopted (D-2), with the verified sequence in S4-C1/C5; plugin and fallback mutually exclusive; detection via `claude plugin list --json` and the settings `disableAllHooks` flag (record_decision 24).

**2.6 Consequences.** App. E #1 resolved (subcommands verified; a token-cost display was not observed, headless only); #2 open "not required"; #18 plugin-HTTP eligibility recorded (S3 adopts no HTTP). FR-30 and the Phase 3 installer use the S4-C1/C5 sequence. Hook fixtures under `test/fixtures/synthetic/claude/2.1.319/hooks/` are hand-written from the schemas with the S9 fixture set. Interactive-only events (manual denial, elicitation) remain for S7.

### S5 — Codex hooks and trust

**2.1 Question and refs.** How does Codex 0.160.0 gate hook execution on trust (FR-31)? Plan §0.7; PRD §10, FR-31, S-06, US-7, App. E #5, §5.3.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S5-C1 | Version pinned to 0.160.0 | pass | `codex --version` through the runner prints `codex-cli 0.160.0`, before = after, guard MATCH |
| S5-C2 | Untrusted hooks do not execute | pass | 12 Xaibo recorder hooks + 1 synthetic foreign hook in the temp `$CODEX_HOME/hooks.json`; headless run: 0 recorder lines, reply normal, rollout still written (EC-25 premise); `codex exec` shows nothing about untrusted hooks; `--dangerously-bypass-hook-trust` never used |
| S5-C3 | Explicit user approval activates them | pass | owner approved in Codex's own TUI (the folder-trust prompt also trusted the hooks; `codex --no-daemon` needed under the runner's wrapper); afterwards SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt (Esc during a running command) and SessionEnd were delivered with schemas (`spikes/s5/evidence/hooks/`); PermissionRequest not triggered (Codex sandbox off in the temp profile, D-P0-16, so no approval was asked); PreCompact, PostCompact, SubagentStart, SubagentStop not triggered |
| S5-C4 | A changed hook requires renewed trust | pass | trust is stored per hook in the user `config.toml` as `[hooks.state."<hooks.json>:<event>:<group>:<index>"] trusted_hash = "sha256:…"` (Codex-owned); a changed command (extra argument, or `async` added) stops that hook until the owner re-approves it, after which it runs again; a content-only change behind an unchanged command still runs (the hash covers the declaration, not the script) |
| S5-C5 | Uninstall preserves foreign hooks | pass for bytes, fail for trust | removing the Xaibo entries by text edit leaves the foreign entry byte-identical, but the foreign hook stops running: trust is keyed by position, and its index shifted onto a key whose stored hash belonged to a Xaibo hook. Design rule: Xaibo appends its groups after all existing entries so removal never shifts a foreign hook. Leftover trust tables are Codex-owned and never deleted The append rule is a design rule, not tested; it does not protect a foreign hook added after Xaibo's groups, so Phase 3 (Gate 3) tests append-then-remove and shows such a later hook as an FR-34 conflict instead of removing silently. |
| S5-C6 | Plugin route (optional) | not-run | `codex plugin add/list/marketplace` exist on 0.160.0; plugin hooks carry an extra content hash in their trust state (docs); not exercised (each trust step needs an owner TUI session); FR-31 uses `hooks.json` |

**2.3 Method.** Temp Codex profile through the runner (sandbox off per D-P0-16), recorder hooks, headless `codex exec … < /dev/null` (without closed stdin it waits forever), two owner-driven TUI sessions for approval and renewal (expect could not drive the TUI). Guard `s5-pre`, `s5-owner-pre`: MATCH; block backstop: 0 processes belong to the runs.

**2.4 Evidence (async per event).** `async: true` accepted without warning on SessionStart and PostToolUse; on SessionEnd Codex prints `warning: running async SessionEnd hook synchronously` and runs it synchronously; others not tested (default synchronous). `codex exec` prints `hook: <Event>` / `Completed` status lines in its own output (Codex UI, not model context).

**2.5 Decision.** FR-31 route: `$CODEX_HOME/hooks.json`, user scope, activated only through Codex's own trust review (Phase 3 guided step: install, then ask the owner to open Codex once and approve the listed hooks); Xaibo never writes trust; Xaibo groups appended after existing entries; stable shim command (record_decision 25).

**2.6 Consequences.** App. E #5 closed. Phase 3: guided trust step; EC-25 (installed-but-untrusted state: rollouts still visible, hooks silent), EC-46 (shim upgrade without re-trust: content-only changes run unreviewed, a deliberate trade-off), EC-70 (Interrupt event exists). EC-53: no PreModelRequest/PostModelRequest event exists in the 0.160.0 hook set used here. Hook fixtures with the S9 set.

### S6 — Codex interoperability

**2.1 Question and refs.** Per surface and version, what is visible, loadable and owned, and who receives approvals? Plan §0.8; PRD §10, FR-20–23, S-12, S-22, US-8, §12 Q3.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S6-C1 | Visibility recorded per surface/version | pass (TUI, exec, app-server); VS Code and Desktop untested with reason | matrix in 2.4 |
| S6-C2 | Loadability recorded per surface/version | pass (same scope) | matrix in 2.4 |
| S6-C3 | Ownership recorded per surface/version | pass (no-daemon mode); shared-daemon mode untested with reason | attach result in 2.4 |
| S6-C4 | Approval recipient recorded per surface/version | pass (no-daemon mode) | attach result in 2.4 |

Rule: a negative attachment result is acceptable; external sessions remain observe-only.

**2.3 Method.** Temp Codex profile through the runner (sandbox off per D-P0-16). `spikes/s6/run.ts`: headless `codex exec`, the stdlib JSON-RPC probe `spikes/s6/app-server-probe.ts` (method names taken from `codex app-server generate-json-schema`, kept local), and interactive sessions driven in a detached `screen` (`spikes/shared/tui.ts`, D-P0-30). One project directory per surface, so the cwd-filtered resume picker shows whether that surface's sessions are listed. 13 launches with a prompt, 8 of which reached the model (the rest stopped at a dialog, a wrong flag or a transient start error). Guard around every block: MATCH, or a real-config change with 0 credential and 0 agent keychain changes (owner sessions were running; one non-agent keychain change in one block, owner activity (D-P0-35)). Backstop: 0 new processes belong to the runs.

Deviations: every TUI ran with `--no-daemon` (the default shared daemon does not start inside the runner: `app-server daemon start` exits 1); 0.160.0 accepts only `on-request | never` for `-a`, so the pending approval came from PR-WRITE under `-s read-only` instead of PR-LONG; each session TUI first shows a hooks review for changed recorder hooks left by S5, answered "Continue without trusting"; evidence is one file.

**2.4 Evidence.** `spikes/s6/evidence/s6.json`. Compatibility matrix, Codex 0.160.0:

| Origin surface | `session_meta.source` / `originator` | In `codex resume` picker | Loadable / resumable | Live attach from a second client | Approval recipient |
|---|---|---|---|---|---|
| TUI (`codex`) | `cli` / `codex-tui` | yes | `codex resume <id> ["<prompt>"]` continues the same rollout; `codex fork <id>` makes a new id with `forked_from_id` | no: listed and readable (`notLoaded`), `thread/resume` fails, no notifications | the TUI only; the turn completes after the TUI approval |
| `codex exec` | `exec` / `codex_exec` | only with `--include-non-interactive` | `codex exec resume <id> "<prompt>"` appends to the same rollout | not tested (no live window) | none (non-interactive) |
| app-server (stdio client) | `vscode` / the client's own name | yes | `thread/read` ok; `thread/list` returns it by default, not under `sourceKinds` cli, exec or appServer | not observed (no second client tried) | not observed (the turn raised no server request) |
| VS Code extension | untested: would read the real profile unless it honours `CODEX_HOME` (not established) | untested | untested | untested | untested |
| Desktop app | untested (real profile only) | untested | untested | untested | untested |

- app-server: `codex app-server` speaks one JSON object per line on stdio; a wrong method returns a JSON-RPC error; notifications seen: `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `account/updated`. The protocol also has `account/rateLimits/read` and `account/usage/read`; Xaibo never calls them (zero quota requests).
- Positive control for the attach result: `thread/resume` on a finished TUI thread that no client holds succeeds and loads it (`notLoaded` before), so the failure on the live thread comes from the TUI holding it, not from the request shape (no prompt).
- `/compact` in the TUI adds a top-level `compacted` record to the rollout (S13-C8, Codex part).
- A transient "workspace routing discovery failed" error at TUI start was seen once; the retry worked.

**2.5 Decision.** record_decision 35. Q3: no attach to externally owned Codex threads; external sessions are observe-only, and live control is limited to threads Xaibo starts itself. FR-21/FR-22 syntax as in the matrix. EC-50: exec sessions resume with `codex exec resume <id>`. EC-68: app-server threads are visible in the picker.

**2.6 Consequences.** EC-05/EC-74: `source: vscode` does not prove the VS Code extension (any app-server client gets it by default) and `originator` is client-chosen, so entry-point labels need both fields and stay "unverified" for unknown originators. Open for v1-A / Phase 7: the shared-daemon mode (`codex agents`, `app-server proxy`), where attach and approval routing may differ; it must be re-tested outside the wrapper before any control feature relies on it. VS Code and Desktop rows stay untested (OQ-B4). Fixtures per source kind: the S9 Codex fixtures already cover `cli` and `exec`; an app-server (`vscode`) fixture is added at Gate 2 with the adapter.

### S7 — Claude interoperability

**2.1 Question and refs.** What do external Claude TUI sessions expose, separately from later PTY hosting? Plan §0.9; PRD §10, FR-20–23, §6.2, US-8, §12 Q12.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S7-C1 | External-TUI history visibility recorded separately from later PTY hosting | pass (TUI, `-p`); PTY hosting stays with S2 / v1-A | matrix in 2.4 |
| S7-C2 | Manual denial exercised | pass | 2.4 |
| S7-C3 | Cancelled input exercised | pass (accept, decline, cancel) | 2.4 |
| S7-C4 | Foreground Stop with background work exercised | pass | 2.4 |
| S7-C5 | Child completion exercised | pass | 2.4 |
| S7-C6 | Desktop listing (optional) | untested: Desktop would read the real profile (OQ-B4) | — |
| S7-C7 | `--bg`/attach (optional) | partial: `--bg`, `attach`, `logs`, `stop` exist in `--help`; not exercised | — |

**2.3 Method.** Temp Claude profile through the runner; `spikes/s7/run.ts` drives interactive sessions in a detached `screen` (`spikes/shared/tui.ts`, D-P0-30), with the S4 recorder hooks (every event) and the S13 tee passed by `--settings` (the profile's settings file is not edited) and `--permission-mode default`. Input requests use the stdlib MCP server `spikes/s7/elicit-mcp.ts` (test `elicit-mcp.test.ts`, seen failing before the server existed), registered for the run only with `--mcp-config`. 20 prompts attempted (owner raised the Claude budget, D-P0-31); some never reached the model. Guard around every block: MATCH, or a real-config change with 0 credential and 0 agent keychain changes; one block (`s7d-pre`) showed a non-agent keychain change (owner activity, D-P0-35).

**Version.** The installed Claude Code updated itself from the pinned **2.1.319 to 2.1.322** during Phase 0 (install dated 2026-11-10). Every S7 fact and the S13-T6 leftovers are for 2.1.322; the runner's freeze check passed because the version did not change *during* a run. Earlier Claude evidence (S3, S4, S9, S13-T1..T5) is 2.1.319.

The transcript checks are anchored to the `tool_result` of the call in question (`spikes/s7/run.ts recheck`, from the raw local data, no new prompts); an earlier whole-transcript match had also counted unrelated text. `fileCreated` of the denial run is not measurable: the file was left by the invalid auto-mode attempt in the same directory. Two first attempts were invalid and were rerun: the temp profile started in auto permission mode (the write was approved, no dialog), and `--allowedTools` / `--mcp-config` take lists, so they swallowed a prompt placed after them. The driver now puts the prompt first and forces the default mode.

**2.4 Evidence.** `spikes/s7/evidence/s7.json`. Compatibility matrix, Claude Code 2.1.322:

| Origin surface | `entrypoint` | In `claude --resume` picker | Loadable / resumable | Live attach | Approval recipient |
|---|---|---|---|---|---|
| TUI | `cli` | yes | `claude --resume <id> ["<prompt>"]` continues the same id and file; `--resume <id> --fork-session` gives a new id; `--session-id <uuid>` pre-allocates the id | not tested (S2 / v1-A) | the TUI |
| `claude -p` | `sdk-cli` | no ("no conversations" in that project) | `claude -p --resume <id> "<prompt>"` | n/a | n/a (headless) |
| `--bg` | not exercised | not exercised | `claude attach <id>` exists | `attach` exists | not exercised |
| VS Code extension | untested: would read the real profile unless it honours `CLAUDE_CONFIG_DIR` (not established) | untested | untested | untested | untested |
| Desktop | untested (real profile only) | untested | untested | untested | untested |

§6.2 evidence (ordered hook events; transcript markers):

| Case | Hook events | Transcript |
|---|---|---|
| Manual denial (Esc at the permission dialog) | `PreToolUse` → `PermissionRequest`; then **no** `PostToolUse`, **no** `PermissionDenied`, **no** `Stop` | the `tool_result` of that call has `is_error` and the rejection text |
| Input request, accept / decline / cancel | `Elicitation` → `ElicitationResult` (`action` = accept / decline / cancel) → `PostToolUse` → `Stop`; `Notification` `elicitation_response` each time, `elicitation_dialog` once | the server received the same action |
| Idle after a turn | `Notification` `idle_prompt` (~60 s), not an input request | — |
| Background shell after Stop (PR-BG) | `Stop` while `sleep 30` runs; ~30 s later a new turn: `UserPromptSubmit` → `Stop` | `queue-operation`, `system:stop_hook_summary`, `system:turn_duration` records |
| Subagent (PR-SUB) | `SubagentStart` → `Stop` → `SubagentStop` (the subagent is backgrounded) | — |
| Interrupt during a tool (Esc in PR-LONG) | no hook event at all after the interrupted call's `PreToolUse` (no `PostToolUse`, `PostToolUseFailure` or `Stop`) | the `tool_result` has `is_error` and the **same** rejection text as a denial: only a preceding `PermissionRequest` tells a denial from an interrupt |

- `PermissionRequest` carries no `tool_use_id`, so it is joined to its `PreToolUse` by order within the session, not by id.
- `/model` inside a session writes `model` into the profile's user settings (it persisted); `/effort` did not.
- `PostCompact` carries `compact_summary` (content: never stored, as all hook content).

**2.5 Decision.** record_decision 36. §6.2: manual denial is detected from the transcript rejection of a call that had a `PermissionRequest` (the same rejection without one is an interrupt), never from `PermissionDenied`; needs-input is validated by `Elicitation`/`ElicitationResult`; `idle_prompt` is never an input request; "Finishing…" must allow `SubagentStop` and background-completion turns after `Stop`. EC-67: CLI resume works for TUI and `-p` sessions; Desktop stays view-only (untested). Q12 default stands: Desktop handoff not in MVP.

**2.6 Consequences.** App. E #13 resolved (on 2.1.322); #3 partly (background completion = a queued-message turn; VS Code / Desktop parts untested); #14 Claude half (matrix above). The 4 s turn-settle default is too short for background shells (completion turn ~30 s after `Stop`) and for backgrounded subagents; Phase 3 keeps the session in "Finishing…" while a `SubagentStart` has no `SubagentStop`, and treats a later `UserPromptSubmit` without a typed prompt as the same activity. Version drift: the parsers and fixtures were derived on 2.1.319; Gate 1 re-runs the S9 fact extractor on the installed version and pins the matrix to whichever version is tested. Fixtures for EC-40/41/70 (manual denial, accepted/declined/cancelled input, `idle_prompt`, background completion, subagent after Stop, interrupt) are added at Gate 3 from these event orders.

### S9 — Format survey

**2.1 Question and refs.** Version-pinned Claude/Codex format facts and synthetic fixtures. Plan §0.10; PRD §10, S-02, S-03, S-04, S-10, S-25, S-35, FR-02, FR-08, FR-13, FR-47, FR-51, US-3, US-15, App. E #8, #11, #24.

**2.2 Criteria** (numbering from plan §0.10)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S9-C1 | Versions pinned | pass | `claude` 2.1.319, `codex-cli` 0.160.0, `gemini` 0.46.0 through the runner, each before = after, guard MATCH (install paths agree) |
| S9-C2 | Synthetic fixtures cover usage semantics (required) | pass | fixtures `test/fixtures/synthetic/claude/2.1.319/` and `codex/0.160.0/` (cases usage-basic, identifiers, unknown-records, partial-line, compaction, entrypoints, rate-limits (Codex), model-effort, compressed-source, canary; hook fixtures for S4/S5), each `expected.json` written first and recomputed by `test/unit/fixtures-{claude,codex}.test.ts`; adversarial review fixed four overclaims (now marked not verified). Facts: facts: Claude assistant lines sharing one `message.id` carry identical usage (latest-wins and dedupe both correct); usage keys `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`, `server_tool_use`, `service_tier`, `speed`, `inference_geo`, `iterations`, `output_tokens_details`, `fallback_credit`; Codex `token_count.info.{total,last}_token_usage` keys `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, cumulative per session, cached ⊆ input, reasoning ⊆ output (EC-93), `model_context_window`; `rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at}` with `resets_at` in epoch seconds, plus `credits`, `plan_type`, `limit_id`, `limit_name`, `individual_limit`, `rate_limit_reached_type`, `spend_control_reached`; a separate `token_usage_record` record type exists |
| S9-C3 | Identifiers (required) | pass (facts) | Claude: `sessionId`, `uuid`, `parentUuid`; transcripts at `projects/<encoded-cwd>/<uuid>.jsonl`; subagents at `projects/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.jsonl` with `isSidechain` records. Codex: `sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`, filename UUID equals `session_meta.payload.id`; `session_index.jsonl` (`id`, `thread_name`, `updated_at`) |
| S9-C4 | Unknown records (required) | pass (facts) | Claude 2.1.319 record types observed: `assistant`, `user`, `system` (`compact_boundary`, `stop_hook_summary`), `attachment`, `api-request`, `api-request-blob`, `api-request-shape`, `atis-latch`, `cost-state`, `last-prompt`, `mode`, `queue-operation`, `session-owner`, `tools-used`; Codex 0.160.0: `session_meta`, `turn_context`, `response_item`, `event_msg`, `token_usage_record`, `world_state`. Types beyond the parser's known list are counted as unknown (fixtures cover above/below 5 %). Owner-run real-store audit (T3, numberless answers): Claude unknown share above 5 % against the 2.1.319 list, with additional real-store type names `agent-color`, `agent-name`, `ai-title`, `artifact-autoreact-ledger`, `artifact-comment-monitor`, `bridge-session`, `custom-title`, `failed`, `file-history-delta`, `file-history-snapshot`, `frame-link`, `launched`, `permission-mode`, `pr-link`, `relocated`, `result`, `started`; Codex no unknown types; Gemini types `info` and `<other>` (no pinned list); no partial, malformed or oversize lines in any store |
| S9-C5 | Partial and huge lines (required) | pass (facts) | large-payload fields (> 4 KB in synthetic runs): Claude `attachment.content`, `message.content[].text`, `rendered[].content`, `shape.system[].text`; Codex `payload.base_instructions.text`, `payload.content[].text`, `payload.state.host_skills.body` (inputs for Phase 1 `gen-perf-corpus`, EC-15); partial/malformed handling in fixtures |
| S9-C6 | Cleanup (optional) | not-triggered | `cleanupPeriodDays: 1` in temp user settings with four planted quadrants (mtime × last-record age), a subagent file and an empty session dir: nothing removed after a headless run, after a run with the `.last-cleanup` marker backdated, and after a 40 s interactive launch under expect (marker never advanced: headless runs do not clean up; the interactive TUI did not reach its ready state under expect). App. E #11 stays UNVERIFIED; EC-23 keeps its estimate label |
| S9-C7 | Optional compressed and metadata files (optional) | pass | owner audit: `.jsonl.zst` present in the real Codex store (not Claude, not Gemini); Claude `sessions/*.json` present in the real store; no Gemini legacy `.json` chats. Temp profiles: no `.jsonl.zst` written by either agent in fresh profiles; Claude `<config>/sessions/*.json` absent at rest (not used); `claude agents --json` exists and returns a JSON array (empty here); Codex `session_index.jsonl` present; Codex state DBs present as `state_<n>.sqlite`, `thread_history_<n>.sqlite`, `logs_<n>.sqlite`, `memories_<n>.sqlite`, `goals_<n>.sqlite`, `queue_<n>.sqlite` (names only, never opened); runtime zstd: Electron 45.2.3 / Node 24.22.2 utility process has `zlib.createZstdDecompress`, streamed a synthetic ~115 MB `.jsonl.zst` (400,000/400,000 lines, 0.58 s, peak RSS 147 MB) |
| S9-C8 | Unsupported optional formats produce coverage warnings | pass (decision) | EC-03 at Gate 1: stream-decompress `.jsonl.zst` with built-in zlib (no package); formats not present here (Claude `sessions/*.json`) are listed with a coverage warning, not imported |

Owner audit entry points (T3): Claude `entrypoint` values in real use `cli`, `claude-vscode`, `claude-desktop`; Codex `source` `vscode`, `exec`, `<other>` and `originator` `codex_vscode`, `codex_exec`, `codex_work_desktop`, `<other>` (EC-05, EC-50). The owner chose to share the script's raw aggregate output in chat; no figure from it is recorded here or anywhere in git.

**2.3 Method.** Temp Claude and Codex profiles (sessions from S3–S5 plus an S9 tool run and a headless `/compact`), `spikes/s9/facts.ts` (booleans, key sets, allowlisted values, filename patterns only) and schemas `spikes/s9/schemas/{claude-2.1.319,codex-0.160.0}.schema.json`; packaged spike app mode `s9-zstd` (`spikes/s9/zstd-probe.ts`); `spikes/s9/plant-cleanup.ts`. Guard `s9-pre`, `s9-clean*`: MATCH. Other facts: Claude `entrypoint` observed only `sdk-cli` (headless; interactive values from S7); injected user-content prefixes `<command-name>`, `<local-command-caveat>`, `<local-command-stdout>`; compaction record `system`/`compact_boundary` with `compactMetadata` keys `trigger`, `preTokens`, `postTokens`, `durationMs`, `preservedMessages`, `preservedSegment`, `cumulativeDroppedTokens`; Claude transcripts carry no session reasoning-effort field (FR-51 effort for Claude must come from elsewhere or stay unavailable); Codex effort is `turn_context.collaboration_mode.settings.reasoning_effort` (also in `thread_settings_applied`; observed only as null on 0.160.0, so `facts.json` `effortValues` is empty; the extractor path was corrected after review); Codex sources `cli`, `exec`, originators `codex-tui`, `codex_exec`; Codex `/compact` not run (no `compacted` record observed).

**2.5 Decision.** Pin the Claude 2.1.319 and Codex 0.160.0 fact sets and schemas in `spikes/s9/`, with the synthetic fixture set; EC-03 = stream-decompress `.jsonl.zst` with built-in `node:zlib` (the owner's Codex store holds such files); Claude `sessions/*.json` and `claude agents --json` not used in the MVP (coverage note); parsers tolerate unknown record types (record_decision 26).

**2.6 Consequences.** App. E #8 resolved (built-in streaming zstd); #11 stays UNVERIFIED (cleanup age basis; EC-23 keeps its estimate label); #24 Codex part resolved (`token_count` semantics, rate-limit units). Gate 1 parsers: Claude known-type list = the 2.1.319 observations plus the owner-audit names, unknown share tracked per session; EC-05/EC-50 entrypoints include `claude-vscode`, `claude-desktop`, Codex `vscode`, `codex_work_desktop`. FR-51: Codex effort from `collaboration_mode.settings.reasoning_effort`; Claude effort not in transcripts (statusLine, S13). Phase 1 `gen-perf-corpus` uses the large-payload fields above. §5.1 narrowed: Claude `sessions/*.json` not read.

### S10 — Network

**2.1 Question and refs.** Does the packaged app make zero attempted non-loopback connections, and how is that audited? Plan §0.11; PRD §10, S-14, P2, US-12, M6.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S10-C1 | Packaged main process covered | pass | under the audit profile for every scenario; controls `main-tcp`, `main-dns` killed |
| S10-C2 | Renderer/Chromium covered | pass | renderer, GPU and network-service helpers are children of main under the same profile (Chromium's own sandbox off, see 2.4); NetLog control detected (69 non-local events incl. DNS and socket types) |
| S10-C3 | Service covered | pass | utility process under the same profile; controls `service-tcp`, `service-dns` killed |
| S10-C4 | Forwarder candidates covered | pass | SEA and Electron-as-Node forwarders under the profile: exit 0 and their own stats line proves they ran (acked with the service up, spooled with it down); kill controls on both forwarder runtimes |
| S10-C5 | Startup, idle, errors, shutdown and dependencies exercised | pass | 10 scenarios, each reached its marker (2.4) |
| S10-C6 | Positive control detected | pass | 8 of 8 kill controls (TCP and DNS from main, service, the official Node runtime and the Electron-as-Node runtime), the NetLog control, and a quiet no-control baseline |
| S10-C7 | Zero attempted (not merely zero successful) non-loopback connections | pass | two full runs: 0 unexpected process deaths (service deaths counted); lsof 0 non-loopback lines in 2,410 and 2,240 samples; NetLog 0 non-local events (part of pass/fail in the second run); main exit 0 |

**2.3 Method.** Command: `npm run spike:s10` (controls first, then the scenarios; `-- --only control` runs the controls alone; the plan's `--control` flag was not implemented). `spikes/s10/audit.sb` allows everything except non-loopback IP and the `mDNSResponder` socket, and **kills** (SIGKILL) a process on its first such attempt. `spikes/s10/run.ts` runs the packaged app (`--no-sandbox`, mode `s3`, NetLog on) and the forwarder candidates under that profile, drives the scenarios through stdin commands (`XAIBO_S10=1`, spike env only), and treats any process death other than the two it causes itself as an attempt. Supplementary recorders: `lsof -i` over the process tree every 250 ms, Chromium NetLog, the kernel denial log. Positive controls (`spikes/s10/control.ts`): one TCP attempt to a reserved test address and one DNS lookup of a reserved name from main, from the service and from the forwarder's Node runtime; one Chromium-stack request under a non-killing copy of the profile for NetLog. Controls ran first (the detector's RED proof), then the scenarios. Run outside the Claude sandbox (Seatbelt does not nest; owner approval 2026-11-10). Guard `s10-pre` around the run.

Deviations from the plan: (1) kill-on-attempt replaces counting kernel log lines, because the log is lossy (below); (2) one driver file replaces `run-audit.sh` + `scenarios.ts` + `parse-netlog.ts`; (3) Node `diagnostics_channel` subscribers are not implemented, since a Node-level attempt already kills its process; (4) the DB-open error is a directory at the database path, not an unwritable data dir (Chromium itself needs the data dir); (5) the forwarder control uses the SEA's Node binary with the control script, because the SEA embeds a fixed script.

**2.4 Evidence.** `spikes/s10/evidence/s10.json` (Apple M4, macOS 27.2; the audited app is Electron 45.2.3; the file's `env` block describes the driver's own Node).

| Scenario | Marker reached | Unexpected deaths |
|---|---|---|
| Cold start | yes | 0 |
| Idle 5 min, window open | yes | 0 |
| Idle 5 min, window closed (tray) | yes | 0 |
| Renderer crash and reload | yes | 0 |
| Service SIGKILL and restart | yes | 0 |
| Forwarders (SEA, Electron-as-Node), service up | yes (both exit 0) | 0 |
| Blocked `window.open`, `fetch` and navigation | yes | 0 |
| Quit | yes (exit 0) | 0 |
| Forwarders, service down | yes (both exit 0) | 0 |
| DB open error | yes (error reported, exit 0) | 0 |

- **Kernel log is lossy.** Of 12 identical denied attempts under fresh process names, 8 were logged. Counting log lines can therefore miss a single attempt; the scenario run logged 0 lines, which is consistent but is not the proof.
- **Rule quirks (macOS 27.2).** The loopback allow must be the last rule, or loopback is denied too; a non-killing copy of the profile cannot be used during app startup (a denied lookup stalls it), so the NetLog control request is sent after the first paint.
- **Window restoration.** After a killed run, macOS offers to restore the app's windows on the next launch and blocks startup; the driver passes `-ApplePersistenceIgnoreState YES` (argument domain, nothing persisted).
- **Idle baselines (spike, not gate evidence; RSS summed over all app processes, shared pages counted more than once; Chromium sandbox off; NetLog and S3 receivers on).**

| Phase | RSS mean / p95 / max (MiB) | CPU mean / p95 / max (%) | Target |
|---|---|---|---|
| Window open, 5 min (run 1 / run 2) | 373 / 406 / 448; 343 / 407 / 449 | 0.1 / 0 / 16.7; 0.2 / 0.5 / 13.1 | M5 ≤ 450 MB |
| Window closed, 5 min (run 1 / run 2) | 270 / 275 / 275; 198 / 225 / 225 | 0.0 / 0 / 0.2; 0.1 / 0.1 / 3.2 | M4 ≤ 250 MB, CPU ≤ 1% |

The second run followed the pre-freeze review fixes (forwarder stats check, counted service deaths, NetLog in pass/fail) and repeated every control and scenario.

- **Keychain.** No keychain item was created under the app's name; the guard showed 0 agent keychain changes and 0 credential changes. It also showed real-config and non-agent keychain changes during the window, which the spike app has no code path to cause; the owner confirmed they were the owner's own sessions (D-P0-32).

**2.5 Decision.** record_decision 34. Audit method: the kill-on-attempt profile with positive controls; the existing P2 policy (request filter for non-`file:` URLs, navigation and `window.open` denial, permission denial) is sufficient; no Chromium switch is added; `--use-mock-keychain` is not needed on this evidence.

**2.6 Consequences.** Gate 1 E2E (EC-60, P1-T05) reuses `audit.sb` and the unexpected-death check, with the controls run once per gate; the MCP process is audited the same way before v1-C. M4 is at risk: window-closed RSS was 270 MiB mean in one run and 198 MiB (max 225) in the other against ≤ 250 MB, so it varies between runs (summed RSS overstates it; Phase 3 measures with a footprint-based method and without the spike receivers). M5 has little headroom (max 448–449 MiB). Residual gaps: the audited app runs with Chromium's own sandbox off, so a difference that only appears with it on is not covered; `sandbox-exec` is deprecated; DNS detection assumes lookups go through `mDNSResponder` or a direct IP connection; `~/Library/Preferences/local.xaibo.spike.plist` is still written (P0-T03 finding).

### S11 — Gemini and catalog

**2.1 Question and refs.** Gemini 0.46.0 observation, retention and launch facts; catalog expressiveness; validator selection. Plan §0.12; PRD §10, S-01, S-27, S-28, S-35, FR-01, FR-06–08, FR-20, FR-21, FR-25, FR-33, FR-34, FR-51, US-13, US-15, US-19, D-14, D-19.

**2.2 Criteria** (numbering from plan §0.12)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S11-C1 | Hooks and empty output (core-required) | not-run | Gemini sign-in rejected by Google for this client; owner skipped live parts (D-P0-19) |
| S11-C2 | Actual transcript path (core-required) | not-run | as C1 (an unauthenticated launch exits at the auth check; owner audit shows Gemini chat files exist as `.jsonl` under `tmp/*/chats`) |
| S11-C3 | Content, thought, tool coverage incl. subagents and tool-output files (core-required) | not-run | as C1 |
| S11-C4 | Patch, rewind, legacy semantics (core-required) | not-run | as C1 (owner audit: no legacy `.json` chats in the real store) |
| S11-C5 | Permission correlation (core-required) | not-run | as C1; the `Notification` + `notification_type=ToolPermission` mapping is expressed in the catalog entry from package docs only |
| S11-C6 | Profile override (conditional) | partial (source) | storage resolves `GEMINI_CLI_HOME` as the parent of `.gemini`; an early settings read in the main entry treats `GEMINI_CLI_HOME` as the `.gemini` dir itself (inconsistency, not runtime-verified); unauthenticated probe in the temp profile named the temp `settings.json` path |
| S11-C7 | Native retention (conditional) | source-read, not runtime-verified | `spikes/s11/evidence/retention.json`: `general.sessionRetention.{enabled (default true), maxAge (default 30d), maxCount, minRetention (default 1d)}`, format `^(\d+)([hdwm])$`, invalid config disables cleanup, age basis = chat metadata `lastUpdated`, unreadable chats deleted, runs once at startup; precedence = Gemini's merged settings (not runtime-verified) |
| S11-C8 | Interactive launch/resume (conditional) | not-run | as C1; package docs give `--resume <uuid>` (catalog template marked UNVERIFIED) |
| S11-C9 | Generic maps (catalog-required) | pass | `spikes/s11/catalog/gemini.entry.json` expresses the §6.8 mappings as exact event + field predicates |
| S11-C10 | Synthetic custom-agent schema (catalog-required) | pass | `spikes/s11/catalog/agents.catalog.schema.draft.json` (§7.3 v1 fields, `additionalProperties: false`, argv-only launch templates, whole-argument placeholders); `synthetic-agent.entry.json` (report v1 only) passes (M15 feasible); six negatives fail for their intended reasons (unknown field, shell string, imported entry shadowing a bundled ID (loader rule), profile-root escape, code field, ACP field); adversarial review fixed five defects |
| S11-C11 | Unsupported facts explicit (conditional) | pass | `spikes/s11/evidence/expressiveness.json`: 37 fact classes labelled data / needs a tested adapter / core / excluded |
| S11-C12 | JSON Schema validator selected (catalog-required) | pass (owner approval at Gate 0) | `spikes/s11/evidence/validator.json` (source per cell): proposal `ajv` 8.20.0 exact pin, `ajv/dist/2020` with `strict: true`, `allErrors: true`, never `loadSchema`/`compileAsync`; 4 permissive dependencies; install at Phase 1 start (OQ-X6); costs: ~1.3 MB, CommonJS, runtime code generation. Selected from registry metadata and docs; the optional compile trial in the packaged utilityProcess was not run |

**2.3 Method.** Installed `@google/gemini-cli` 0.46.0 package read as text; temp Gemini profile through the runner (unauthenticated probe only); catalog draft and validator research by a workflow with an adversarial review; zero-dependency subset checker `spikes/s11/catalog/check.ts` (not the product validator).

**2.5 Decision.** Gemini live observation UNVERIFIED and returned to the owner (report §4, decided: skip); `maxAge` offer not shown; catalog v1 draft adopted as the Phase 6 seed; validator proposal `ajv` 8.20.0 at Phase 1 start (record_decision 27).

**2.6 Consequences.** Proposed PRD delta (D-P0-25): replace Gemini CLI with the Antigravity CLI (`agy`) as the third agent, evaluated in Phase 2 (public sources, unverified: lifecycle hooks with `transcript_path`, JSONL transcripts under `~/.gemini/antigravity-cli/brain/<id>/…`, no cwd or version stamp in the transcript; the IDE uses a separate store). App. E #16, #17, #24 (Gemini) stay UNVERIFIED; Q18 answer: Gemini observation unverified on 0.46.0 because personal Google sign-in is rejected (API key or Vertex would be needed); FR-51 Gemini effort: unavailable. EC-80/EC-81/EC-90 (Gates 2 and 6) have no Phase 0 evidence; Gemini fixtures not written (no observed semantics). App. C delta: `ajv` 8.20.0 in Phase 1. Catalog draft field names and enums go to Codex for design review at Gate 0.

### S12 — Capacity/latency feasibility

**2.1 Question and refs.** Minimum service architecture, batch bounds, watcher strategy and watch-reconciliation interval default. Plan §0.13; PRD §10, S-29, FR-02, FR-09, US-14, §12 Q8, Q19, M2, M13, M14.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S12-C1 | 50 sessions | narrowed (owner: personal profile) | Measured instead (spike, not gate evidence): 5 concurrent live sessions; 15 in the ~3x probe. Watcher: 5 appenders, 15 at ~3x. 50 sessions not run |
| S12-C2 | Declared 200 events/s workload | narrowed (owner: personal profile) | Declared ~20 events/s, bursts 50/s for 5 s every 60 s, mean 4 KiB, p99 ≤256 KiB (forced max every 5,000). Runs: 120 s (2,700 events, ~22.5/s mean), 60 s sweeps and usage run. ~3x probe: 120 s, 8,100 events (~67.5/s mean). The generator self-checks against the declared profile. 200 events/s for 10 min not run |
| S12-C3 | ≥10 GiB SQLite/FTS corpus | narrowed (owner: personal profile) | 1,500 sessions, 1.955 GB (1.82 GiB) synthetic content, two 50 MB sessions; populated DB 2,806,976,512 B (2.61 GiB), no padding; `integrity_check` and FTS integrity-check ok. 10 GiB, 10,000 sessions and a 200 MB session not run |
| S12-C4 | Worker isolation measured | pass (spike, not gate evidence) | Variants A, B, C × mixes file and hook25 (120 s each). Dispatch-loop delay max: A 441–446 ms, B 460–720 ms, C 13–24 ms (2.4 table) |
| S12-C5 | Query times measured | pass (measured); one query over budget | n = 200 warm and 200 "cold" (new process, page cache warm). Lists, content and CJK/rare/recency search are within DB budgets. bm25 on a common term: cold p99 593 ms > 500 ms search budget before paint (2.4) |
| S12-C6 | Watcher/FD strategy measured | pass | (b) per-active-file `fs.watch` and (c) `fs.watchFile` polling measured at 5 and 15 appenders, `launchctl` soft limit 256 recorded. (a) recursive `fs.watch` (FSEvents), measured afterwards outside the command sandbox: append→event p95 ≈ 14.6 s (max ≈ 15.0 s) at 5 and 15 appenders, 0 missed, so unusable for M2 |
| S12-C7 | Queue age measured | pass (spike, not gate evidence) | Persistence queue age p95 124–241 ms in every whole run, 266 ms during the expiry window (≤1 s); drain 12–184 ms (≤5 s) |
| S12-C8 | Candidate forwarder hops measured | pass (service side, pipe transport); socket not-run in S12 | Hook deliveries used S3 framing + version + timing-safe token check over an inherited pipe (socket `bind()` EPERM in the sandbox). Receive→publish p95 0.06–0.09 ms in every variant. Send→publish p95 (spike, not gate evidence): A 83–97 ms, B 55 ms, C 0.19–0.32 ms. SEA spawn and socket connect hops: S3 table |
| S12-C9 | 45-day minute-sampled quota histories, transition rows, context projections and price provenance included | pass | 2 streams (`5h`, `7d`; OQ-A8 = 2), each 64,800 minute samples + 648 transitions = 65,448 rows; 2,982 `context_snapshots`; 192 `price_provenance` rows; monthly totals and peaks tables |
| S12-C10 | Synthetic row counts, table/index/WAL bytes, retention cost and live/query interference reported | pass | Rows per table and DBSTAT bytes; build WAL max ~183 MiB (build-time only), live WAL max 30–59 MB, checkpoint busy 0. One-day expiry 549 ms in 35 batches under C load, loop max 1.89 ms. Read latencies under load per variant (2.4) |
| S12-C11 | Selected minimum architecture and unresolved gate risks recorded | pass | 2.5 and 2.6 below; `record_decision` "Minimum service architecture" and "Watch reconciliation interval default" proposed for Gate 0 |

Rule: spike results do not replace packaged E2E gates; tagged "spike, not gate evidence".

**2.3 Method.**

*Environment.* Apple M4, 16 GiB RAM, macOS 27.2. Electron 45.2.3 runs its bundled Node 24.22.2 with `ELECTRON_RUN_AS_NODE=1`, using SQLite 3.53.4 through `node:sqlite` `DatabaseSync`. Generators and appenders run on system Node v26.10.0. The pragmas read back as S1/§7.4: WAL, `synchronous` 1, `foreign_keys` 1, `busy_timeout` 5000, `auto_vacuum` 2, `temp_store` 2.

*Seeds* (`mulberry32`, `spikes/shared/bench.ts`):

| Seed | Value |
|---|---|
| corpus | 12001 |
| text | 12002 |
| live | 12003 |
| usage | 12004 |
| build | 12005 |
| tree | 12006 |
| append schedule | 12007 |
| hook mix | 12008 |
| backfill | 12009 |

No real store was read. Data was written under the git-ignored `.cache/spike-data/s12/` and raw results under `.cache/spike-results/s12/`. Only the reduced JSON in `spikes/s12/evidence/{corpus,queries,load,usage,watch}.json` is committable: aggregates and seeds, with no paths, usernames or ports.

- **T1 generators** (`spikes/s12/gen.ts`, test `gen.test.ts` seen RED, then 6/6).
  - Corpus, live, ~3x scale and usage profiles, each asserting its declared statistics.
  - A wrong parameter fails the self-check. For example, `--median-bytes 20000` gives "median 23342 not ~200000 (±15%)" and exit 1.
  - `spikes/s12/check.ts` asserts the corpus and T4 thresholds. It failed before `load.json` existed.
- **T2 build** (`npm run spike:s12 -- --build`).
  - S1 schema shape: events, sessions, FTS5 external content over the first 64 KiB of each item, §7.4 indexes.
  - 30 commits of ≤20k rows / 64 MiB; `wal_checkpoint(TRUNCATE)`.
  - DBSTAT, `integrity_check` and FTS integrity-check.
- **T3 queries** (`--queries`, read-only connection, default `cache_size`).
  - 200 warm runs: one connection, statements prepared once, 5 warm-up runs.
  - 200 "cold" runs: a new packaged process and connection per run, prepare included, OS page cache warm (OQ-A11). True cold (`sudo purge`) was not run.
  - Pages: list 50 rows; FTS 20 rows with `snippet()`; content ≤50 rows × 64 KiB on the 50 MB session, pages 1–6 by keyset.
  - Times are the DB portion only.
- **T4 load** (`--load`, `spikes/s12/load.ts`). Each run works on an APFS clone of the T2 DB.
  - Variants:
    - **A:** everything on the dispatch loop.
    - **B:** writer worker; backfill parse and reads on the loop.
    - **C:** dispatch loop, plus a writer worker, a bounded parser worker and a reader worker.
  - Every variant parses and publishes live events on the loop before persistence, through a MessagePort consumer standing in for the renderer.
  - Watcher: one `fs.watch` per active file, plus reconciliation every 5 s.
  - Backfill: ≤256 KiB per 100 ms tick from a 32 MiB synthetic JSONL file.
  - Reads: one T3 query per second, rotating through list, FTS by recency, CJK bm25, content page 1, 45-day quota and common bm25.
  - Writer: commits live rows first under a rows/ms/bytes bound, plus a `wal_checkpoint(PASSIVE)` probe every second with autocheckpoint on.
  - Loss and duplicates are checked on a unique `(session_id, source_seq)` key plus a per-id publish check.
  - Loop delay comes from `monitorEventLoopDelay` (1 ms resolution). RSS and FDs are sampled in the service process, with worker threads included.
  - Sweep under C (hook25, 60 s): 100/50/1 MiB, 500/100/4 MiB and 500/100/16 MiB.
  - ~3x probe: A and C, 120 s.
  - Four runs from the first pass were contaminated by host load (1-minute load average ~100). They were set aside and rerun at load average 2.5–4.4, which the evidence records.
- **T5 usage** (`--usage`): C, hook25, 60 s.
  - At 15 s, a one-day expiry runs in the writer: 1/45 of the quota history, plus the corpus's oldest day of sessions (the 50 MB session excluded).
  - It runs as batches of ≤1,000 rows; each batch settles into the monthly tables and deletes in one transaction.
  - Then `incremental_vacuum` in 2,000-page chunks.
- **T6 watch** (`--watch`).
  - Seeded tree at 1k and 10k files: 60% `claude/projects/<dir>/<uuid>.jsonl`, 40% `codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
  - Appenders run as separate system-Node processes on the live schedule, compressed to 15 s (a 5 s burst, then the base rate).
  - "Missed" = a line not delivered by a watch event within 2 s after the last append.
  - Polling interval 1 s.
  - Scan: 1 priming scan, then 20 timed readdir + stat passes against a `(size, mtime, ino)` map, both sync and async.

**2.4 Evidence (spike, not gate evidence).**

*Corpus (T2).*

| Metric | Value |
|---|---|
| Sessions | 1,500 (median 221,703 B, p99 18.2 MB, max 50 MB × 2) |
| Content | 1,955,170,274 B (1.82 GiB) |
| Events | 364,829 (p50 2,043 B, p99 52,178 B, max 1.03 MB; 2,303 over the 64 KiB FTS prefix) |
| Text mix | CJK 0.080, emoji 0.020; rare-term items 2 |
| Build | 39.4 s total (load 36.0 s, indexes 3.3 s) |
| Verify | `integrity_check` 7.9 s ok; FTS integrity-check 5.6 s ok |
| DB | 685,297 × 4096 = 2,806,976,512 B (2.61 GiB); freelist 0; WAL max during build 192,399,912 B → 0 after TRUNCATE |
| Bytes (DBSTAT) | `events` 2,156,048,384 B; `events_fts_data` 628,428,800 B (~32% of content); `usage_snapshots` 6,463,488 B; `events_session_seq` 4,964,352 B; `events_fts_docsize` 3,923,968 B; `usage_scope_limit_asof` 2,469,888 B; all else ≤0.82 MB each |
| Rows | `sessions` 1,500; `events` 364,829; `checkpoints` 1,500; `context_snapshots` 2,982; `usage_snapshots` 130,896 (1,296 transitions); `price_provenance` 192 |

*Queries (T3), ms, n = 200, DB portion only.*

| Query | Rows | Warm p50/p95/p99 | Cold p50/p95/p99 | DB budget | p99 within |
|---|---|---|---|---|---|
| List unfiltered | 50 | 0.11/0.12/0.15 | 0.58/0.73/1.18 | 1,500 (M12) | yes |
| List by agent | 50 | 0.02/0.03/0.06 | 0.05/0.05/0.07 | 1,500 | yes |
| List by project | ≤50 | 0.04/0.07/0.13 | 0.08/0.10/0.11 | 1,500 | yes |
| FTS common, bm25 | 20 | 368.8/409.9/450.5 | 372.4/459.3/**592.6** | <500 (M13 search incl. paint) | **no** |
| FTS common, newest first | 20 | 1.20/1.22/1.24 | 1.40/1.62/1.69 | <500 | yes |
| FTS rare, bm25 | 2 | 0.06/0.06/0.06 | 0.16/0.21/0.33 | <500 | yes |
| FTS CJK, bm25 | 20 | 42.2/45.8/52.6 | 45.0/56.8/67.9 | <500 | yes |
| FTS CJK, newest first | 20 | 0.88/0.90/0.93 | 1.10/1.39/3.21 | <500 | yes |
| Content p1 (50 MB session) | 50 | 0.45/0.49/0.70 | 0.87/1.29/1.91 | 300 (M13) | yes |
| Content p2–6 (keyset, worst) | 50 | p99 ≤4.81 | p99 ≤2.35 | 300 | yes |
| Quota 45 days, one scope, raw | 130,896 | 42.5/50.4/57.7 | 53.5/73.2/100.7 | — | — |
| Month totals | 12 | 0.57/0.58/0.59 | 0.71/0.93/1.31 | — | — |
| Month quota peaks | 4 | 58.4/72.5/82.7 | 58.4/70.2/80.8 | — | — |

Cold process: open p50 0.17 ms. Whole packaged-process spawn p50 592 / p99 908 ms, which is Electron startup, not DB.

*Live load (T4), personal profile, 120 s, batch 500 rows / 100 ms / 4 MiB, ms.*

| Run | Loop p99 / max | Append→publish p95 / max | Receive→publish p95 | Queue age p95 / max | Drain | Lost / dup | Commit p95 / max | WAL max | RSS max | FDs |
|---|---|---|---|---|---|---|---|---|---|---|
| A file | 20.0 / 440.7 | 95.7 / 405.9 | — | 160.0 / 530.5 | 108.7 | 0 / 0 | 68.8 / 172.0 | 37.4 MB | 193 MiB | 36 |
| A hook25 | 21.1 / 446.2 | 95.5 / 435.3 | 0.077 | 158.1 / 551.9 | 124.2 | 0 / 0 | 64.4 / 167.4 | 32.6 MB | 195 MiB | 39 |
| B file | 1.8 / 719.8 | 110.2 / 688.7 | — | 221.3 / 427.4 | 183.7 | 0 / 0 | 93.4 / 211.6 | 37.7 MB | 233 MiB | 38 |
| B hook25 | 1.8 / 459.8 | 94.6 / 420.8 | 0.092 | 218.1 / 430.2 | 126.2 | 0 / 0 | 91.6 / 193.3 | 35.2 MB | 238 MiB | 38 |
| C file | 1.45 / 23.5 | 0.25 / 5.1 | — | 217.4 / 362.0 | 77.2 | 0 / 0 | 90.6 / 175.4 | 57.1 MB | 270 MiB | 42 |
| C hook25 | 1.35 / 13.0 | 0.31 / 9.2 | 0.086 | 205.9 / 419.0 | 11.5 | 0 / 0 | 84.3 / 181.6 | 59.1 MB | 281 MiB | 45 |

Notes on the load runs:
- **Thresholds:** queue age p95 ≤1 s, drain ≤5 s and loss/dup 0 pass in all six runs (`check.ts` exit 0).
- **Smallest variant passing those thresholds:** A.
- **Interference** (reads max under load):
  - bm25 common: 439–718 ms
  - CJK bm25: ~142 ms
  - quota 45 days: 82–100 ms
  - list: ≤2.6 ms
- **Why A and B stall:** in A and B these reads and the 65–95 ms commits run on the loop.
- **WAL:** checkpoint busy 0; largest uncheckpointed backlog 12,666 frames (C hook25).
- **Generator RSS:** ~282 MiB (separate process).

*Batch sweep under C (hook25, 60 s, 1,350 events).*

| Rows / ms / bytes | Queue age p95 / max | Commit p95 / max | Drain | Loop max | WAL max | Pass |
|---|---|---|---|---|---|---|
| 100 / 50 / 1 MiB | **123.9** / 245.0 | 57.9 / 154.6 | 88.1 | 12.3 | 30.5 MB | yes |
| 500 / 100 / 4 MiB | 220.6 / 371.0 | 94.8 / 173.3 | 77.5 | 16.6 | 31.9 MB | yes |
| 500 / 100 / 16 MiB | 221.9 / 408.6 | 92.7 / 178.4 | 64.8 | 5.2 | 48.1 MB | yes |

*~3x scale-up probe (15 sessions, ~60 events/s, bursts 150/s; 120 s, 8,100 events, 2,011 hooks).*

| Run | Loop p99 / max | Append→publish p95 | Queue age p95 / max | Drain | Lost / dup | Commit p95 | FDs | Pass |
|---|---|---|---|---|---|---|---|---|
| A | 13.9 / 488.1 | 113.6 | 157.7 / 636.0 | 118.0 | 0 / 0 | 67.0 | 59 | yes |
| C | 1.4 / 26.1 | 0.20 | 241.1 / 494.2 | 49.0 | 0 / 0 | 98.0 | 62 | yes |

Change from the personal hook25 run of the same variant (ratio):

| Variant | Metric | Personal → ~3x | Ratio |
|---|---|---|---|
| C | drain | 11.5 → 49.0 ms | 4.26 |
| C | loop max | 13.0 → 26.1 ms | 2.01 |
| C | FDs | 45 → 62 | 1.38 |
| C | queue age p95 | 205.9 → 241.1 ms | 1.17 |
| C | commit p95 | 84.3 → 98.0 ms | 1.16 |
| C | RSS | 281 → 279 MiB | 0.99 |
| A | FDs | 39 → 59 | 1.51 |
| A | append→publish p95 | 95.5 → 113.6 ms | 1.19 |
| A | loop max | 446 → 488 ms | 1.09 (read-bound, not load-bound) |

*Watchers (T6).* 1,000-file tree; 5 appenders at 20/s with a 50/s burst (450 lines); settle 2 s.

| Strategy | Latency p50/p95/p99/max (ms) | Missed | Lost | Extra FDs | Idle CPU (% core) | CPU under load |
|---|---|---|---|---|---|---|
| (a) recursive `fs.watch` (FSEvents) | 10514/14575/14935/15016 | 0 | 0 | +0 | 0.00 | 0.18% |
| (b) `fs.watch` per active file | 0.39/0.73/0.95/2.97 | 0 | 0 | +5 | 0.00 | 0.98% |
| (c) `fs.watchFile` polling, 1,000 files, 1 s | 487/945/983/987 | 0 | 0 | +0 | 1.20 | 1.28% |
| (b) at ~3x (15 appenders, 1,350 lines) | 0.35/0.62/0.82/3.98 | 0 | 0 | +15 | — | 2.37% |

These tables are `spikes/s12/evidence/watch.json`, the rerun outside the command sandbox (the first run, under Seatbelt, could not run (a) and gave slower scans; its numbers are superseded).

Baseline idle CPU 0.02%. `launchctl limit maxfiles`: soft 256, hard unlimited.

*Reconciliation scan and OQ-A10 interval rule.* The rule picks the smallest interval in {2, 5, 10, 15, 30, 60} s with mean scan CPU ≤0.25% of one core and max scan wall ≤10% of the interval; recovery = interval + 1 s.

| Files | Mode | Wall mean / p95 / max (ms) | CPU mean (ms) | CPU % of one core at 2/5/10/15/30/60 s | Rule result |
|---|---|---|---|---|---|
| 1k | sync | 5.95 / 6.41 / 6.65 | 6.26 | 0.31/**0.13**/0.06/0.04/0.02/0.01 | **5 s** (recovery 6 s) |
| 1k | async | 15.8 / 16.99 / 18.83 | 16.74 | 0.84/0.33/**0.17**/0.11/0.06/0.03 | 10 s (recovery 11 s) |
| 10k | sync | 36.65 / 37.43 / 37.45 | 36.59 | 1.83/0.73/0.37/**0.24**/0.12/0.06 | **15 s** (recovery 16 s); 30 s under Seatbelt |
| 10k | async | 112.64 / 116.68 / 131.21 | 114.53 | 5.73/2.29/1.15/0.76/0.38/**0.19** | 60 s (recovery 61 s) |

*Usage tables and retention (T5).*

| Item | Value |
|---|---|
| Per stream | 65,448 rows (64,800 samples + 648 transitions); table + `(scope, limit, as_of)` index 4,466,688 B (~4.3 MiB), ~68.2 B/row |
| Scaling | linear in streams × minutes: N streams ≈ N × 4.3 MiB |
| Context | `context_snapshots` 2,982 rows / 131,072 B + index 40,960 B |
| Price provenance | 192 rows / 16,384 B |
| Monthly tables | totals and quota peaks, 1 page each |
| One-day expiry | 2,908 quota rows + 15 sessions (10.1 MB, 1,879 events, FTS delete) in 35 transactions of ≤1,000 rows: total 549 ms (quota 69, sessions 434); batch p95 51 / max 102 ms |
| `incremental_vacuum` | 2,484 pages in 46.7 ms (2 chunks); freelist after 0 |
| WAL during expiry | stayed at its 27.4 MB high-water mark (growth not visible in file size) |
| Interference during expiry | dispatch loop p99 1.35 / max 1.89 ms; queue age p95 266 ms |
| Whole usage run (C) | queue age p95 221 ms; drain 143 ms; lost 0 / dup 0 |

**2.5 Decision (proposed for Gate 0; spike, not gate evidence).**

- **Minimum architecture: variant C, the §7.1 layout.** C has a dispatch loop, a writer worker, a bounded parser worker and a reader worker. A is the smallest variant that passes the queue, drain and loss thresholds, but it fails interference: the loop stalls ~440–490 ms and append→publish p95 is ~95–114 ms. C keeps loop max ≤26 ms and append→publish p95 ≤0.31 ms at the personal load and at ~3x (S12-C4, C7, C10).
  - **Writer worker:** needed. Commits take 65–98 ms p95 (max up to 225 ms). On the loop they add directly to dispatch delay (A).
  - **Reader worker:** needed. B moves only the writer, and its loop still stalls 460–720 ms because bm25, CJK and quota reads (up to 718 / 150 / 100 ms) stay on the loop. One reader worker is enough at this profile.
  - **Parser worker:** kept per §7.1, but not isolated by this spike. At the 256 KiB/100 ms cap each chunk costs p99 ≤1.8 ms (max 4.5 ms), so on the loop it would cost little at this rate. It is needed for higher import rates (M3), 200 MB transcripts and ~1 MB single records (EC-15), which were not measured here.
- **Batch bounds: 100 rows / 50 ms / 1 MiB per transaction, live rows first.** It gives the lowest queue age of the three tried: p95 124 ms against 221 ms for 500/100/4 MiB, with commit p95 58 ms. Backfill is capped at 256 KiB per 100 ms tick; the M3 note in 2.6 says the cap must rise. Only 3 of the plan's 12 sweep combinations ran.
- **Watcher strategy: (b) `fs.watch` on each active session file (kqueue), plus the reconciliation scan.** Latency p95 0.72 ms, 0 missed, 1 FD per active file. The scan finds new files and recovers missed events.
  - **Fallback:** the reconciliation scan alone (recovery = interval + 1 s). Use it when the per-file watch count would pass an FD cap (soft limit 256; service base ~36–45 FDs), with the least-recently-active files dropped first.
  - **Polling (c) is not a fallback for M2:** its p95 of 955 ms uses the whole 1 s budget.
  - **Recursive FSEvents (a):** p95 ≈ 14.6 s event latency, so a directory watch cannot serve M2; new-file discovery stays with the scan.
- **Watch reconciliation interval default (FR-02): 5 s**, as a synchronous readdir + stat scan off the dispatch loop (in the parser worker).
  - *Derivation (OQ-A10) at the personal 1k-file tree:* 2 s fails (0.31% of a core > 0.25%). 5 s passes with 0.13% CPU and a longest scan of 6.65 ms ≤ 500 ms. Missed-watch recovery is 6 s.
  - *Scale-up value at 10k files:* 15 s (0.24%, longest scan 37 ms ≤ 1.5 s), recovery 16 s; under Seatbelt the same rule gave 30 s.
  - *Async scan:* the async per-file `await stat` walk needs 60 s at 10k files, so the scan stays sync in a worker.
  - *Recommendation:* ship 5 s as the configurable default and document that trees of ~10k files need ≥15–30 s.
- **Scale-up readiness (~3x).** C passes every threshold at ~3x with no change (measured at batch 500/100 ms/4 MiB; the chosen 100/50 ms/1 MiB bound ran once, 60 s at the personal load, and is unmeasured at ~3x).
  - **First metric to degrade:** drain under C, 11.5 → 49 ms (4.3x). Personal C runs already range 11.5–143 ms, so this is within run-to-run spread rather than a trend.
  - **Structural signals:**
    - Writer commit p95 reached 98 ms at ~3x with 500/100 ms/4 MiB, so the writer is what grows next. The chosen 100/50 ms/1 MiB bound has a 50 ms window and is unmeasured at ~3x; backfill can be throttled when the writer backlog grows.
    - FDs grow by about 1.7–2 per added session (+17 in C and +20 in A for 10 more sessions).
    - bm25 search cost does not depend on load. It grows with match count and corpus size (unmeasured above 2.61 GiB), so it is the first query-side limit.
  - **What grows without redesign:** the worker layout, the batch bounds, the per-file watch count up to an FD cap, and the scan interval (5 → 30 s at 10k files). The writer stays single.

**2.6 Consequences.**

- **FR-02:** default watch reconciliation interval 5 s (configurable); document that ≥15–30 s is needed at ~10k files.
- **Q8:** the watch-reconciliation-interval part is resolved (5 s, recovery 6 s). Turn-settle 4 s is unchanged.
- **Q19 feasibility status** (spike, not gate evidence; final at the gate):

| Target | Gate | Status | Basis |
|---|---|---|---|
| M2 | 3 | feasible on the service side | Watch p95 0.72 ms; append→publish p95 ≤0.31 ms (C); renderer and paint not in S12 (S3: ~15 ms). Missed-watch recovery 6 s at 5 s. Risk: the first record of a brand-new session file is seen only by the scan (≤5 s), because per-file watches cannot see new files and no directory watch was measured |
| M3 | 1–3 | at risk | List is within budget. At the spike's backfill cap (256 KiB/100 ms, ~2.6 MB/s committed in C), ~500 MB takes ~190 s against ≤120 s. Import needs ≥ ~4.2 MB/s, which was not measured under load. The bulk build (no parse) absorbed 1.96 GB in 36 s |
| M12 | 4 | feasible on the DB side | List cold p99 ≤1.2 ms. The packaged-process spawn alone is p50 592 / p99 908 ms; GUI start→list not measured |
| M13 | 5 | feasible with a condition | Content p99 ≤4.8 ms on the 50 MB session. Search passes only with newest-first ordering or capped bm25 candidates: common-term bm25 cold p99 593 ms already exceeds 500 ms before paint. 200 MB session and 10 GiB / 10,000 sessions not measured |
| M14 | 4 | feasible at the personal profile; unmeasured at the PRD target | All thresholds pass at 5 sessions (120 s runs) and at ~3x (15 sessions, ~67.5 events/s mean). 50 sessions, 200 events/s and 10 minutes not run |
| M4 / M5 | 3 | risk noted | Service RSS under load is 270–281 MiB in C (single process, workers included) against M4's idle ≤250 MB across all processes. S10 idle window-closed RSS 270 MiB mean (summed over all processes, so overstated) is also above 250 MB; Phase 3 re-measures |

- **Plan-scale targets (owner decision, D-P0-24 and D-P0-26):** Gates 4/5 measure at the personal profile; M13 on ≥10,000 sessions / ≥10 GiB with a 200 MB transcript, M14 and EC-57 on 50 sessions / 200 events/s / 10 min, and EC-87 stay as written and are measured in a deferred scale-up stage, not relaxed (PRD v1.1). The stage runs when the owner starts it, likely after the first version (D-P0-36). See §4.
- **App. E #20:** "feasible at the personal profile (5 s scan interval, C layout, batch 100/50/1 MiB, per-file watch + scan); at risk: M3 import rate, M13 bm25 search, plan-scale M13/M14 unmeasured. Final at Gates 1/3/4/5."
- **App. E #26:** "feasible at the personal profile. Footprint ~4.3 MiB per quota stream (68 B/row, linear); context and price tables < 0.2 MB. One-day expiry 549 ms in ≤102 ms batches with loop max 1.89 ms during live load. Final at EC-100 (Gate 4) and EC-99 (Gate 5)."
- **Unresolved gate risks:**

| Gate | Item | Risk |
|---|---|---|
| 1 | EC-15 | 200 MB transcript and streaming parse not measured (max session 50 MB, max item 1.03 MB) |
| 1 | EC-19 | Recovery = interval + 1 s holds only if the scan runs off the loop; recursive FSEvents is too slow (p95 ≈ 14.6 s) to replace the scan |
| 3 | M2 | New-file discovery depends on the scan |
| 3 | M3 | Backfill cap too low for ≤120 s |
| 3 | M4 | RSS under load |
| 3 | M1 hook path | Socket not re-measured under load (pipe used; S3 applies) |
| 4 | EC-57 / M14 | Plan scale and the GUI `utilityProcess` not run |
| 4 | EC-100 | Passed at the personal profile with usage tables and expiry enabled |
| 4 | M12 | GUI cold start unmeasured |
| 5 | EC-87 / M13 | bm25 common term over budget; 10 GiB not run |
| 5 | EC-99 | Expiry at personal scale OK |

- **App. C:** no new packages.
- **Phase 5 search design:** default to newest-first, or cap bm25 candidates.

**Deviations from the plan.**
1. **Scale.** The owner replaced 50 sessions / 200 events/s / ≥10 GiB with the personal profile (S12-C1–C3).
2. **DB size.** 2.61 GiB, not ~1–2 GiB. The declared size shape gives a ~1.3 MB mean session; nothing was shrunk to hit the estimate.
3. **Largest session.** 50 MB, not 200 MB (owner cap), so the M13/EC-15 200 MB case is untested.
4. **Median tolerance.** The generator allows ±15% (plan ±10%). The n = 1,500 sample median is 221,703 B (+10.9%) with seed 12001.
5. **Run length.** Live runs are 120 s (sweeps and usage 60 s), not the profile's 600 s or M14's 10 min. Watch runs are 15 s.
6. **Runtime.** Load and interference ran on the packaged binary with `ELECTRON_RUN_AS_NODE=1`, not the GUI `utilityProcess` (`s12-*` modes) the plan names.
7. **Hook transport.** Deliveries went over an inherited pipe with S3 framing and token check, not the S3 Unix socket (sandbox `bind()` EPERM; the unsandboxed rerun was denied).
8. **Recursive FSEvents and scans.** The first run was under Seatbelt (EMFILE for FSEvents, slower scans); the watcher and scan stage was rerun outside the sandbox and its results replace the first run.
9. **Batch sweep.** 3 of the plan's 12 combinations.
10. **Contaminated first pass.** The first-pass C-hook25, two sweeps and the ~3x probe were contaminated by host load (1-minute load average ~100) and were rerun. Only the reruns record host load; the first five base runs predate that field but show 0 ms generator lag.
11. **Cold queries.** "Cold" means a new process with a warm page cache; true cold (`purge`) was not run.
12. **Spike choices.** Page sizes, 1 s polling, 256 KiB/100 ms backfill cap, 5 s reconcile in T4 and the 2 s "missed" window. Polling watched all 1,000 files.
13. **Quota and monthly queries.** The quota query returns raw minute rows without downsampling. Month totals come from `sessions`; there is no `MonthlyUsageTotal` until T5.
14. **Expiry scope.** The corpus's oldest day (15 sessions), excluding the 50 MB session.
15. **`check.ts` scope.** It judges the personal runs only; the ~3x probe is diagnostic.
16. **Time budget.** The load stage ran ~35 min against the ~15 min budget.
17. **Build WAL.** The bulk build let the WAL reach ~183 MiB (64 MiB batches). This is a build setting, not a live bound.
18. **One unexplained test failure.** One `spike:test` run showed 47/48 with the failing test not identified; the rerun was green. The last stage reports `npm run typecheck` and `npm run spike:test` (48/48) green. This stage only read the evidence and reran nothing.

### S13 — Passive usage, context and cost

**2.1 Question and refs.** Passive usage/context/cost inputs; tee feasibility and account scope. Plan §0.14; PRD §10, S-31, S-32, S-33, S-35, FR-44–49, FR-51, US-16–19, D-22.

**2.2 Criteria**

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| S13-C1 | Claude tee byte and exit preservation | pass | `spikes/s13/tee.test.ts` G1–G4, G8, G9, G11 (stdout/stderr bytes incl. invalid UTF-8 and ANSI, exit 0/1/3/255, signal mirrored, stdin identical incl. 2 MiB, SIGTERM forwarded, tee adds 0 bytes); live temp-profile session shows the original's line through the tee |
| S13-C2 | Absent-original path | pass | G5: 0 bytes, exit 0 |
| S13-C3 | Capture-failure path | pass | G6 (no socket; listener never reads; listener drops): original output and exit unchanged; `overhead.ts` 0 mismatches in 600 paired runs per runtime |
| S13-C4 | Bounded added wait | pass on the SEA build; fail on plain system Node (not shipped) | § 2.4 table; bound p95 ≤ 100 ms (OQ-B6) |
| S13-C5 | No output and no tokens added | pass-narrowed | Tee writes 0 bytes (G11); statusLine markers never appear in a transcript. The planned "first-turn token delta 0" was not shown: the two sessions differed by −118 tokens of ambient context |
| S13-C6 | Installed-version snapshot schemas | pass (key names and types only) | `evidence/s13.json` `statuslineKeys` (Claude 2.1.319); Codex `token_count` keys in `spikes/s9/evidence/facts.json` |
| S13-C7 | Scope-attribution limits | pass | `evidence/s13.json` `scope` |
| S13-C8 | Compaction and model-window changes | pass-narrowed | Claude 2.1.322 (S7 run, `spikes/s7/evidence/s7.json` `s13`): after `/compact` the statusLine `current_usage` is **null** until the next response (capture sequence usage → null → usage, `spikes/s7/run.ts recheck`), `PreCompact`/`PostCompact` fire, the boundary carries `preTokens`/`postTokens`; `/model sonnet` changed `model.id` with the same window size; `/effort low` changed `effort.level`. Codex `/compact` adds a `compacted` rollout record (S6). Not observed: a window-size change, Codex `/model` |
| S13-C9 | Price-component semantics | pass (Claude, Codex); Gemini UNVERIFIED | `evidence/s13.json` `priceComponents` |
| S13-C10 | Local capture validated without requesting quota/context/model APIs | pass | The tee only copies the statusLine stdin Claude already sends; the capture path makes no request |
| S13-C11 | Incomplete category and Gemini evidence recorded explicitly | pass (record only) | `evidence/s13.json` `categories`; Gemini deferred (D-P0-19) |

Rule: no qualifying tee returns to the owner for a scope/implementation decision, never a silent account-cache fallback. A qualifying tee exists (C1–C5).

**2.3 Method.** Probe `spikes/s13/statusline-probe.mjs` and tee `spikes/s13/tee.ts` with listener `capture-listener.ts`, run as the temp Claude profile's `statusLine` in two owner sessions (guarded runner). Golden tests `tee.test.ts` and `tee.unsandboxed-test.ts` against synthetic originals in `originals/`. Added wait: `spikes/s13/overhead.ts`, n = 200 paired runs per variant (original alone, then through the tee, both as `/bin/sh -c`, same stdin; added = difference, so the original's own runtime is excluded), run unsandboxed because it binds a Unix socket. The check was first seen failing with a deliberate 200 ms delay. The packaged runtime is a Node 26.10.0 SEA with an ES module entry (`spikes/s13/build-sea.sh`, same official Node as S3, D-P0-21). T7–T9 are read from the S9 fact set and the statusLine key list; no new agent run. Evidence is one file, `spikes/s13/evidence/s13.json`, instead of the plan's one file per task; the raw probe output was local only and is no longer on disk.

**2.4 Evidence.** Added wait in ms, spike, not gate evidence (Apple M4, macOS 27.2):

| Runtime | Listener up p50 / p95 / max | No listener | Listener never reads | Bound p95 ≤ 100 |
|---|---|---|---|---|
| SEA (packaged) | 29.3 / 32.8 / 62.3 | 30.5 / 33.1 / 49.4 | 74.9 / 77.7 / 83.5 | pass |
| System Node, `node tee.ts` | 121.3 / 124.9 / 171.0 | 121.3 / 124.1 / 136.3 | 163.1 / 167.6 / 199.7 | **fail** |

- The tee's cost is runtime startup (~30 ms on the SEA) plus, only when a listener accepts and never reads, its 50 ms send deadline.
- Invocation contract: shell command string, JSON on a stdin pipe, project cwd, event-driven (gaps 1.1–16.6 s, median 9.1 s). A slow command is cancelled with SIGTERM, which the tee forwards.
- statusLine stdin has no measurement-time field and no `spend_limit` was seen. `current_usage` is null before the first response. `effort.level` is present here and absent from transcripts (S9).
- The capture record held only `session_id`, `model`, `effort`, `cost`, `context_window`, `rate_limits` and a receipt time. Paths, workspace, repository and prompt identifiers were never captured.
- Price components: Claude maps directly to the four §5.12 components, with cache writes split into 5-minute and 1-hour classes. Codex `cached_input_tokens` is inside `input_tokens` and `reasoning_output_tokens` is inside `output_tokens` (S9 aggregate booleans). Codex `cache_write_input_tokens` has no established relation to `input_tokens`.
- Account scope: the Claude statusLine has no account identifier. Codex `session_meta` has `creator_account_id` and `creator_user_id`, so the "no passive account identifier" hypothesis holds for Claude and is contradicted for Codex.
- Categories (T9): the entries are read from record-type and field names in the S9 schemas, not from content, so every "partial" means "a record type that could carry it exists".

**2.5 Decision.** Owner decision 2026-11-10 (record_decision 32 proposed, 33 approved; Codex choice: (a), the salted hash):

1. **Tee feasibility: feasible.** Ship the statusLine tee as a SEA binary behind the same stable shim as the forwarder. Plain `node` is not an option (fails the bound).
2. **Claude account scope:** readings are labeled "Account scope unverified" and kept per session unless the owner declares an account change. A silent account change stays a documented coverage limit (§5.11).
3. **Codex account scope: (a)**, use a local salted hash of `creator_account_id` as an epoch marker only, never the raw value (owner chose (a); (b), ignoring the field, was not chosen). PRD §5.11 forbids persisting account UUIDs, so (a) needs a one-line PRD clarification that a salted hash is allowed.

**2.6 Consequences.** FR-51: Claude effort comes from the statusLine. §5.11: Claude `as_of` is always "Source time unknown; observed …". §5.12: 5m/1h cache-write classes, `service_tier` and `speed` need table support or the component is unavailable; Codex cache-write stays unavailable until its relation to input is tested. App. E #22 resolved (SIGTERM on a slow statusLine). App. E #23–#25 stay open for the unobserved parts of C8 and for v1-B categories. Still to observe: a model-window size change and Codex `/model` (S13-C8). App. C delta: the product ships a second SEA binary (or one binary with two entry modes, decided in Phase 3 with OQ-A4).

## 3. Cross-spike decisions

| Item | Decision | Source |
|---|---|---|
| Dependency list for approval (App. C delta) | PRD v1.1 App. C: electron 45.2.3, typescript 7.0.2, electron-builder 26.18.0 installed (Phase 0); `better-sqlite3` not needed (S1); `ajv` 8.20.0 proposed for Phase 1 start (S11-C12); official Node 26.10.0 tarball as a dev-time SEA build tool, product Node binary decided in Phase 3 (D-P0-21, OQ-A4); two SEA binaries (~138 MB each: forwarder, statusLine tee); 6 moderate `npm audit` advisories in the installed dev dependencies (§ Environment). **Owner approved 2026-11-10 (D-P0-34, G0-10)** | S1, S3, S11-T9, S13 |
| Q8 watch-reconciliation default (FR-02) | 5 s at the personal profile (recovery 6 s); ≥15–30 s at ~10k files | S12 |
| S13 tee-feasibility and account-scope decision | tee feasible as a SEA (added wait p95 33–78 ms); Claude scope unverified; Codex salted-hash epoch marker (owner approved; PRD §5.11 clarification in the Gate 0 delta) | S13 |
| JSON Schema validator selection | proposal `ajv` 8.20.0, install at Phase 1 start (owner approval at Gate 0) | S11-C12 |
| Compatibility matrix | Codex 0.160.0 rows (§ S6); Claude rows on 2.1.322 (§ S7), the installed version after an auto-update from the 2.1.319 pin (D-P0-33); untested cells carry reasons; record_decision 37 | S6, S7 |

## 4. Required-scope misses returned to owner

| Miss | Evidence | Options | Owner decision + date |
|---|---|---|---|
| S3 M16 under a 50-way simultaneous burst (both process candidates) | § S3: added wait p95 A ≈ 453 ms, B ≈ 276 ms; own max 155/177 ms; nothing lost (spooled) | (1) accept the burst miss, choose A; (2) accept, choose B; (3) add a native forwarder candidate (OQ-A3); (4) narrow M16's burst requirement | 2026-11-10: (2) accept, SEA |
| S11 core Gemini observation (C1–C5) | § Guard: Google rejected personal sign-in for Gemini CLI 0.46.0 | (1) skip the live parts (UNVERIFIED); (2) sign in with an API key or Vertex; (3) replace Gemini CLI with the Antigravity CLI, evaluated in Phase 2 (D-P0-25, proposed) | 2026-11-10: (1) skip (D-P0-19); (3) replace with the Antigravity CLI (D-P0-36) |
| S12 capacity at plan scale (C1–C3 narrowed): 50 sessions / 200 events/s / 10 min, ≥10 GiB / 10,000 sessions and the 200 MB session not run (M13, M14, EC-57, EC-87); M3 import rate and M13 common-term bm25 at risk | § S12 | (1) keep plan scale at Gates 4/5; (2) amend the targets to the personal profile; (3) keep the targets and measure them in a deferred scale-up stage | 2026-11-10: personal profile for the spike (D-P0-24) and (3) (D-P0-26); the stage runs when the owner starts it, likely after the first version (D-P0-36) |
| Claude version drift: the install auto-updated from the pinned 2.1.319 to 2.1.322; the Claude compatibility rows and S7 facts are 2.1.322, S3/S4/S9/S13-T1..T5 are 2.1.319 (G0-5 names 2.1.319) | § S7, D-P0-33 | (1) accept 2.1.322 for the matrix and re-check the S9 facts on the installed version at Gate 1; (2) reinstall 2.1.319 and re-run S7 | 2026-11-10: (1) accept 2.1.322 (D-P0-34, record_decision 39) |

## 5. Decisions (`record_decision` references)

| Decision | `record_decision` id |
|---|---|
| SQLite engine (S1) | 16 |
| Forwarder runtime and per-event path, ack point (S3) | 23 |
| D-2 Claude route (S4) | 24 |
| FR-31 Codex route (S5) | 25 |
| Format fact set (S9) | 26 |
| Gemini and catalog (S11) | 27 |
| Minimum service architecture; watch reconciliation interval default (S12) | 28 |
| Tee feasibility and account scope (S13) | 32 (proposal), 33 (owner approval) |
| Network denial and audit method (S10) | 34 |
| Q3 Codex attach (S6) | 35 |
| Claude interop, §6.2 evidence, Q12 (S7) | 36 |
| Compatibility-matrix version (owner accepted 2.1.322) | 37, 38, 39 |

## 6. Gate 0 record

Baseline: `master` at `e6b39ab`. Post-freeze evidence goes into `docs/plans/gates/gate0.md`, added by the gate-record commit (plan §2.4 step 6).
