# S14 sign-in signal spike (P6-S14-T1, FR-54)

Design: Codex, `.handoff/s14-design.md` (not in git). Scope: owner decision D-P6-14.
Question: which fields that Xaibo already ingests identify a profile's sign-in method (subscription, API key, cloud
provider, gateway, mixed) for an exact agent version? A negative result is valid: that agent stays Unknown/owner declaration.

| File | Role |
|---|---|
| `signals.test.ts` | Synthetic S-tests, written and seen failing first. They cover each method, absent/null/malformed fields, unknown enums, exact version, wrong record type, text-only mentions, dropped fields, excluded fields, conflict vs mixed, the privacy trace (no file/env/spawn/network, no canary), the report allowlist and bounded collection |
| `signals.ts` | Pure classifier over the **production projection** (`captureRecord`; Codex `parseLine` + `codexRateLimits`). Rule shape = draft of the P6-T01a catalog contract |
| `capture.ts` | statusLine helper: production projection + key names to the git-ignored raw dir; imports only the tee module; silent, exit 0 |
| `collect.ts` | `settings` (clears that start's earlier captures), `reduce` (bounded reads inside the profile; an empty start is `invalid`, never a negative) |
| `report.ts` | Numberless allowlisted row serializer |
| `run.sh` | Owner's live block: guard snapshot/compare around two CLI starts, then reduce |
| `fixtures/rules.synthetic.json` | Provisional synthetic rules (certify nothing live) |
| `catalog-signals.draft.json` | Candidate rules (version `unverified`: they cannot match) and coverage gaps |
| `evidence/s14.json` | Written by `reduce`: rows plus key-path names, no values |

Checks: `node --test spikes/s14/signals.test.ts` (also part of `npm run spike:test`); typecheck runs through the root `tsconfig.json`, because the spike imports the production projections from `src/` (`src/` never imports `spikes/`).

## Matrix (D-P6-14)

| Agent | Method | Status |
|---|---|---|
| Claude | subscription (owner sign-in) | **live**: 2 starts x 1 fixed prompt |
| Claude | API key, Bedrock/Vertex (cloud provider), gateway | ready, `not-run` (no access; the private key-handoff route is built only when a key run is scheduled) |
| Claude | mixed | synthetic tests only (live mixed skipped) |
| Codex | ChatGPT sign-in, API key, cloud provider, gateway | ready (`run.sh codex …`, unverified flags), `not-run` |
| agy | Google sign-in | `not-run`; no candidate field (Unknown/owner declaration) |

Prompt: **"Reply with the single word OK."** No tools, `/context`, quota or usage commands, no retries. Budget: 2 prompts per
method run, subscription only (no paid API spend). A method that is not available uses no prompt and is recorded `not-run`, never `unsupported`.

## Owner runbook (Claude subscription)

Run in your own terminal from the repo root, with every Claude Code session closed (editor extensions too).

1. **Profile signed in?** The disposable profile `claude-a` (in `~/.xaibo-spike-profiles/`) was signed in with your
   subscription in Phase 0. If Claude shows a login screen in step 2, quit and sign in first with the guarded helper:
   `bash spikes/shared/signin.sh claude` (it must end with MATCH). Choose your **subscription** login.
2. **Live block:** `bash spikes/s14/run.sh claude a subscription`. Claude opens twice. Each time, wait for "OK" and the
   status line, then type `/exit`. Every guard compare must print MATCH; any DIFF stops the block (tell Claude).
3. **Send Claude** the MATCH lines and the printed rows (they hold only names, enums and the Claude version).
4. Afterwards Claude reviews `evidence/s14.json`, writes the S14 section of `docs/plans/phase0_spikes.md` and records the
   disposition before P6-T01a. Delete `.cache/spike-results/s14/raw` after that review (raw captures hold the
   production projection: session id and window values; local only).

What a row means: `verified` + `alternatives-not-run` = the field was present in both starts under this method. It does
**not** show that it distinguishes methods, because no alternative method was run. `negative` = absent or not repeatable.
`invalid` = guard DIFF, version change, truncated collection or a start with no capture (`collection-empty`: e.g. the status line never ran).

## Privacy

Collection reads only the statusLine stdin given to the capture helper, the throwaway project's Claude transcripts (key
names only) and `versions.log`, with bounded reads of regular files. It reads no config, auth, keychain or environment
files. Evidence holds no live value, ID, path, timestamp, count or cost. Profile logout, deletion and key revocation stay with the owner (plan §3.2).
