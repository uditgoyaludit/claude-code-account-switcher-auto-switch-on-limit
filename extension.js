'use strict';
// Claude Multi — Companion.
// Its only job: keep the multi-account patch applied to Claude Code. Because this
// is a separate extension, a Claude Code update (which replaces Claude's own
// folder) can't remove it, so the patcher keeps running and re-applies the patch
// to each new Claude version — no manual step after an update.
const path = require('path');
const fs = require('fs');
const { patchDir, claudeExtensionDirs } = require('./claude-multi.js');

let vscode, warnedFor = new Set(), reloadAsked = false, noClaudeWarned = false;

// The patch is on disk, but this window's Claude Code loaded before it: the
// account backend (globalThis.__claudeMulti, set by the patched Claude Code in
// this same extension host) only starts after a reload. Ask once per window.
function askReload() {
  if (reloadAsked || globalThis.__claudeMulti) return;
  reloadAsked = true;
  vscode.window.showInformationMessage(
    'Multi Account Switcher is installed. Reload the window to start using it (until then the Accounts section shows "Loading accounts…").',
    'Reload Window'
  ).then((pick) => { if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
}

function patchAll(root) {
  const dirs = claudeExtensionDirs(root);
  if (!dirs.length && !noClaudeWarned) {
    noClaudeWarned = true;
    vscode.window.showWarningMessage('Multi Account Switcher needs the Claude Code extension. Install Claude Code, then reload the window.', 'Install Claude Code')
      .then((pick) => { if (pick === 'Install Claude Code') vscode.commands.executeCommand('workbench.extensions.search', 'anthropic.claude-code'); });
  }
  let patched = false;
  for (const dir of dirs) {
    try {
      const r = patchDir(dir);
      if (r === 'patched') { console.log('[claude-multi] applied to', dir); patched = true; }
      warnedFor.delete(dir);
    } catch (e) {
      console.error('[claude-multi]', e.message);
      // Warn once per Claude version so a structural change is visible, not silent.
      if (!warnedFor.has(dir)) {
        warnedFor.add(dir);
        vscode.window.showWarningMessage('Claude Multi: ' + e.message + ' Multi-account switching is off until the patch is updated.');
      }
    }
  }
  if (patched) askReload();
}

function activate(context) {
  vscode = require('vscode');
  const root = path.dirname(context.extensionPath); // the extensions directory
  patchAll(root);

  // Re-patch when the extensions folder changes (a Claude update lands here) and
  // on a slow timer as a backstop. fs.watch isn't available everywhere.
  let debounce;
  try {
    const watcher = fs.watch(root, { persistent: false }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => patchAll(root), 3000);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (e) { console.error('[claude-multi] watch failed', e); }

  const timer = setInterval(() => patchAll(root), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => { clearTimeout(debounce); clearInterval(timer); } });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMultiCompanion.repatch', () => {
      patchAll(root);
      vscode.window.showInformationMessage('Claude Multi: re-applied. Reload the window (Developer: Reload Window) if it was just updated.');
    })
  );
}

module.exports = { activate, deactivate() {} };
