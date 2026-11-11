# Multi Account Switcher for Claude Code (Unofficial)

Use more than one Claude account in the Claude Code extension and switch between them without signing in again.

> **Unofficial.** This extension is not made, endorsed or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic. Make sure your use of several accounts is allowed by the terms that apply to those accounts.

## What it does

- Adds an **Accounts** section to the Claude Code panel and an account item to the status bar.
- **Add account** signs a new account in through the browser, in an editor terminal.
- **Switch** swaps the active login in place. Chats, settings and history stay where they are; a chat that is mid-reply moves over when the reply ends.
- Shows each account's session and weekly usage.
- **Auto-switch** (optional) moves to another account when the active one reaches a usage threshold you set.
- Re-applies itself after every Claude Code update, so there is no manual step.

## Requirements

- The Claude Code extension (`anthropic.claude-code`) installed in the same editor.
- VS Code 1.84 or later.

## How to use it

1. Install this extension and reload the window (`Developer: Reload Window`).
2. Click the account item in the status bar, or open the Accounts section in the Claude Code panel.
3. Choose **Add account…**, give it a short name such as `work`, and finish the browser sign-in.
4. Pick an account in the list to switch to it.

If the switcher disappears after a Claude Code update, run **Claude Multi: Re-apply account patch** from the Command Palette and reload the window.

## How it works, and what it changes on your machine

Read this before installing.

- **It modifies the installed Claude Code extension.** It adds small hooks to Claude Code's `extension.js` and `webview/index.js` and copies `claude-multi.js` into that extension's folder. The original `extension.js` is kept beside it as `extension.js.claude-multi-orig`.
- **It stores your logins locally.** Each account's Claude login is kept in its own slot under `~/.claude-multi/profiles/<name>` (on macOS, in the login keychain). Settings and cached usage are in `~/.claude-multi/`.
- **Network use.** It asks Anthropic's usage endpoint (`api.anthropic.com`) for each account's usage, with that account's own login. Nothing is sent anywhere else, and there is no telemetry.
- **It can break.** The hooks depend on the internal structure of Claude Code. If a Claude Code update changes that structure, the extension shows a warning and account switching is off until this extension is updated. Claude Code itself keeps working.

## Removing it

1. Uninstall this extension.
2. Reinstall or update the Claude Code extension to get an unmodified copy (the hooks stay in the current copy until then).
3. Optionally delete `~/.claude-multi/` to remove the stored logins. Claude Code stays signed in with the account that was active.

## License

MIT © Udit Goyal
