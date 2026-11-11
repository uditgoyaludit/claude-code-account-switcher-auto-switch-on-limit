# Changelog

## 1.0.2

- Your current Claude login is never lost: before a newly added account becomes the live login, the current login is saved as an account (named from its email) if it isn't one already.
- Accounts are matched by email and organisation, so two accounts in the same organisation aren't confused.
- Adding a login that's already in the list says so instead of adding a duplicate.

## 1.0.1

- After installing, a **Reload Window** prompt appears, and the Accounts section explains that a reload is needed instead of showing "Loading accounts…" forever.
- A clear message, with a button to install it, when the Claude Code extension isn't installed.
- Background usage checks no longer leave `/usage` sessions in your Claude chat history.
- Windows: **Add account** sign-in works whatever the default terminal is (PowerShell, cmd or Git Bash); the sign-in now starts Claude directly instead of typing a command.
- Windows: moving chats from older versions no longer needs admin rights.

## 1.0.0

- First release: account list, in-place switching, usage display, optional auto-switch, automatic re-apply after Claude Code updates.
- A one-time, dismissible "Star on GitHub" ask after the third account switch, and a "Star on GitHub" entry in the account menu.
