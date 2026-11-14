# Report events v1

Xaibo's report contract lets a tool that Xaibo does not read natively send its own sessions, turns, waits, tool calls and
full content to Xaibo. The contract is defined in PRD §5.10. This page covers what a producer needs: how to register,
how to send events with `xaibo-report`, and what each answer means.

Everything stays on your machine. Events travel over Xaibo's private Unix socket or its private spool, never the network.

## 1. Register the producer

A registration binds one agent id and one profile to a token. The agent and profile always come from the registration:
an event can never name a different one.

```sh
XAIBO_DATA_DIR=<appdata> node src/service/config/dev-cli.ts register --agent acme-agent --profile-key acme-1
# Type yes to register a report producer for agent acme-agent, profile acme-1: yes
# registered 00000000-0000-4000-8000-0000000000a1 agent=acme-agent profile=acme-1
# token: <shown once>
```

- The token is shown once. Xaibo keeps only its hash.
- Save the token in a private file owned by you with mode 0600, for example `~/.config/acme/xaibo.token`. Never put it
  in argv or the environment.
- **Agents outside Xaibo's catalog.** The first event creates a profile of that agent, so its sessions appear in Xaibo.
- **Claude, Codex and agy.** Use the id of an existing Xaibo profile of that agent.
- To revoke a producer, run `dev-cli.ts revoke --id <registration>`. Its open connections close; the profile and the
  sessions already received stay.

## 2. Send events

```sh
'<appdata>/integrations/bin/xaibo-report' <registration-id> ~/.config/acme/xaibo.token < event.json
```

`xaibo-report` reads one event of at most 256 KiB from stdin and sends it.

- If the service is down or busy, the event is saved to Xaibo's private spool and delivered when the service next
  starts. If the spool cannot take it, the helper exits 2 with `spool`.
- It never writes to stdout and normally finishes within about 2 seconds.
- The token is checked against the stored registration before anything is sent, so a registration changed a moment
  earlier can give `auth`.

### Exit codes

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Accepted, a duplicate of an accepted event, or spooled for later delivery | Nothing |
| 2 | Refused for good. stderr has one line, `xaibo-report: <code>` | Fix the cause. Retrying the same input fails again |

The codes on stderr:

| Code | Cause |
| --- | --- |
| `usage` | Wrong arguments |
| `stdin` | stdin did not close within 1 s |
| `oversize` | The event is larger than 256 KiB. Use content chunks (below) |
| `token` | The token file is missing, not a private 0600 file of yours, or too long |
| `auth` | Wrong token, or an unknown or revoked registration |
| `malformed` | Not a JSON object |
| `invalid-<field>` | The named field is wrong, for example `invalid-delivery_id` |
| `unsupported-version` | `v` is not 1 |
| `spool` | The service was unreachable and the private spool could not take the event (full, unwritable or not Xaibo's) |
| `internal` | An unexpected error before the event could be sent or spooled |
| `rejected` | Xaibo refused the event with a code the helper does not recognise |
| `forwarder` | The helper refused to run its forwarder: Xaibo's install is damaged or writable by others |

## 3. Event shape

Required fields:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `delivery_id` | Up to 128 characters and stable across retries. If it is missing, `xaibo-report` assigns one |
| `session_id` | Your session id |
| `producer_id` | Names this producer instance |
| `producer_seq` | A counter that rises within the producer instance |
| `event` | The event name |
| `source_ts` | An ISO timestamp |
| `payload` | An object |

Optional fields:

| Field | Value |
| --- | --- |
| `turn_id`, `item_id`, `parent_id`, `request_id`, `cwd` | Correlation ids. `cwd` is stored as given and never opened |
| `model` | `{id, display_name?}` |
| `effort` | The reasoning effort level |

Any other top-level field is rejected.

Events:

| Event | Payload and meaning |
| --- | --- |
| `session.start`, `session.end` | Session lifecycle |
| `turn.start`, `turn.end`, `turn.error` | Turn lifecycle |
| `permission.request` | Needs a `request_id`. Without one it is reduced coverage, never a wait |
| `permission.resolve` | Matches its request by `request_id` only. Payload `decision` is one of `allow`, `deny`, `cancel` |
| `input.request` | Needs a `request_id`, like `permission.request` |
| `input.resolve` | Matches by `request_id` only. Payload `action` is one of `accept`, `decline`, `cancel` |
| `tool.start`, `tool.end` | Matched by `item_id`. Payload `tool` and `args` on start; `result` and `ok` on end |
| `content.upsert` | Full content (below) |
| `usage.snapshot` | Payload counters `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`. Each snapshot replaces the producer's previous one; they never add up |

An event name not in this list is stored and shown as reduced coverage.

### A minimal session

The sequence below is one session. Every line is one event, sent as one call to `xaibo-report`.

```json
{"v":1,"delivery_id":"acme-0001","session_id":"s-1","producer_id":"acme","producer_seq":1,"event":"session.start","source_ts":"2026-01-01T00:00:00.000Z","payload":{},"cwd":"/tmp/project"}
{"v":1,"delivery_id":"acme-0002","session_id":"s-1","producer_id":"acme","producer_seq":2,"event":"turn.start","source_ts":"2026-01-01T00:00:01.000Z","payload":{},"turn_id":"t-1","model":{"id":"acme-large"}}
{"v":1,"delivery_id":"acme-0003","session_id":"s-1","producer_id":"acme","producer_seq":3,"event":"tool.start","source_ts":"2026-01-01T00:00:02.000Z","payload":{"tool":"Read","args":{"path":"README.md"}},"turn_id":"t-1","item_id":"call-1"}
{"v":1,"delivery_id":"acme-0004","session_id":"s-1","producer_id":"acme","producer_seq":4,"event":"tool.end","source_ts":"2026-01-01T00:00:03.000Z","payload":{"ok":true},"turn_id":"t-1","item_id":"call-1"}
{"v":1,"delivery_id":"acme-0005","session_id":"s-1","producer_id":"acme","producer_seq":5,"event":"turn.end","source_ts":"2026-01-01T00:00:04.000Z","payload":{},"turn_id":"t-1"}
```

### Full content in chunks

Send each part of a message, tool output or thought as one `content.upsert` event. Every chunk has the same `item_id`
and `revision`, a `chunk_index` starting at 0, and `final: true` on the last one.

- Split on character boundaries, never in the middle of a character, and keep each event under 256 KiB.
- An item is complete only once every chunk is stored. Until then Xaibo shows it as incomplete.
- Resending a chunk is harmless.
- A revision's chunk boundaries must not change: a producer that re-chunks a revision must send it as a new revision.
  Chunks are assembled per `producer_id`; when two producers send the same item, the first one to settle it (complete or incomplete) is kept.
- If an item would exceed the storage quota, it is marked incomplete and its chunks are dropped.

```json
{"v":1,"delivery_id":"acme-0010","session_id":"s-1","producer_id":"acme","producer_seq":10,"event":"content.upsert","source_ts":"2026-01-01T00:00:05.000Z","payload":{"revision":1,"role":"assistant","kind":"message","content":"First part, ","chunk_index":0,"final":false},"item_id":"reply-1"}
{"v":1,"delivery_id":"acme-0011","session_id":"s-1","producer_id":"acme","producer_seq":11,"event":"content.upsert","source_ts":"2026-01-01T00:00:05.100Z","payload":{"revision":1,"role":"assistant","kind":"message","content":"second part.","chunk_index":1,"final":true},"item_id":"reply-1"}
```

## 4. Behaviour to rely on

- **Retries.** Keep `delivery_id` stable across retries. Xaibo deduplicates on (registration, `delivery_id`), so a retry,
  or a spooled copy of an event that was in fact delivered, is stored once.
- **Order.** Send events in order. Xaibo orders them by its own receive time, not by `source_ts`. A missing event is
  never invented to fill a gap.
- **Waits.** Xaibo shows a session as waiting only while a request has no resolve with the same `request_id`. A
  notification never counts as a wait.
- **Limits.**
  - Each registration may hold 8 connections and queue 1,000 frames or 16 MiB.
  - Pending content may use 64 MiB per registration, 256 items and 20,000 chunk files.
- **Trust.** The spool and the socket are private to your user account. Any process running as you can read your
  token file, so keep producers you do not trust under a different account.

Synthetic conformance fixtures for lifecycle, an exchange, duplicate retry, out-of-order delivery and interrupted chunks
are in `test/fixtures/synthetic/replay/report/v1/`.
