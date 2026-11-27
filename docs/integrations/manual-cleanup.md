# Removing Xaibo's agent integrations by hand

Use this page if you deleted Xaibo without first choosing **Disconnect** or **Uninstall** in it (EC-27, OQ-P6-6).

## The easy way first

If you can, install or open Xaibo again and choose **Uninstall**. It removes only what Xaibo added and keeps any changes you made yourself (FR-34). Then delete the app.

## What happens if you leave things as they are

The agent's hook entries point at a small helper in Xaibo's data folder, not at the app.

- **You deleted only the app:** the helper is still in the data folder. On every hook event it exits silently with code 0. It prints nothing, adds nothing to the conversation and costs no tokens. Events are queued in the data folder's `spool/` up to the spool size limit, and are never sent anywhere.
- **You also deleted the data folder:** the hook entries now name a file that does not exist. The agent may report a hook error on every event until you remove the entries as described below. Xaibo deliberately installs no wrapper to hide this.

## Where Xaibo's data folder is

On macOS it is `~/Library/Application Support/Xaibo`. Delete it last, after the steps below. It holds Xaibo's own history database, the helpers in `integrations/bin/`, the manifest of what Xaibo changed, and backups of the files it changed.

## Claude Code

Claude's settings live in `~/.claude/settings.json`, or in `$CLAUDE_CONFIG_DIR/settings.json` if you set that variable. Back the file up before editing it.

1. **Plugin.** If Xaibo connected through its plugin, run:
   - `claude plugin uninstall xaibo-hooks@xaibo -s user`
   - `claude plugin marketplace remove xaibo`
2. **Settings hooks.** If Xaibo connected through settings instead, look under `hooks` for entries whose `command` contains `xaibo-hook` and delete them. Leave every other hook as it is.
3. **Status line.** If you turned on Xaibo's status line reading, `statusLine.command` contains `xaibo-statusline`. Put your own status line command back, or delete the `statusLine` key if you had none. Your original command was recorded only in Xaibo's data folder.
4. **Transcript retention.** If you accepted Xaibo's offer, `cleanupPeriodDays` was raised to 45. Set it back to your earlier value, or delete it to use Claude's default, if you want shorter retention.

## Codex

Codex's hooks live in `~/.codex/hooks.json`, or in `$CODEX_HOME/hooks.json`.

1. Delete the hook groups whose `command` contains `xaibo-hook`. Leave every other group as it is.
2. Xaibo never writes Codex's hook trust. Any approvals you gave in Codex's review stay in Codex's own records, and no longer apply to anything once the hooks are gone.

## Antigravity CLI (agy)

agy's hooks live in `~/.gemini/config/hooks.json`. Delete the `xaibo` key and leave every other key as it is.

## Gemini CLI

Xaibo does not install anything for Gemini CLI. There is nothing to remove.
