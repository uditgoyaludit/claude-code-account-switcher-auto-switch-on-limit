'use strict';
// Claude Multi: multi-account switching inside the Claude Code extension.
// Works the way /login does: Claude keeps one folder (~/.claude: chats, settings)
// and one live login. Switching swaps that login in place, so chats resume and
// the terminal and every editor follow. Each account's login is also kept in its
// own slot (~/.claude-multi/profiles/<name>) so switching back needs no sign-in.
// Loaded by two small hooks that patchDir() adds to the extension's extension.js:
//   start(context, host)  - at activation
//   onUsage(windows)      - on every live usage update the extension receives
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const STORE = path.join(os.homedir(), '.claude-multi');
const CONFIG = path.join(STORE, 'config.json');
const USAGE = path.join(STORE, 'usage-cache.json');
const PROFILES = path.join(STORE, 'profiles');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ACTIVE_POLL = 5 * 60e3, IDLE_POLL = 30 * 60e3;
const MARK = '/*claude-multi*/';
const BACKUP = 'extension.js.claude-multi-orig';
const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];

// ---------- patching (also used by patch.js) ----------

const HOOKS = [
  { what: 'the activation point', has: 'require("./claude-multi.js").start(',
    re: /([\w$]+)=([\w$]+),([\w$]+)\.subscriptions\.push\(\2\),(?=\3\.subscriptions\.push\([\w$]+\.workspace\.onDidChangeConfiguration)/,
    to: '$&(()=>{try{require("./claude-multi.js").start($3,$2)}catch(e){console.error("claude-multi",e)}})(),' + MARK, exactlyOne: true },
  { what: 'the usage relay', has: '__claudeMulti.onUsage(',
    re: /broadcastPanelUsage\(([\w$]+)\)\{/,
    to: '$&try{globalThis.__claudeMulti&&globalThis.__claudeMulti.onUsage($1)}catch{}', exactlyOne: true },
  { what: 'the panel message handler', has: '__claudeMulti.webview(',
    re: /([\w$]+)\.webview\.onDidReceiveMessage\(\(([\w$]+)\)=>\{(?=[\w$]+\(this\.output,\2\),[\w$]+\?\.fromClient\(\2\))/,
    to: '$&if($2&&$2.type==="claudeMulti"){try{globalThis.__claudeMulti&&globalThis.__claudeMulti.webview($2,$1.webview)}catch{}return}' }
];
const UI_BEGIN = '/*claude-multi:begin*/', UI_END = '/*claude-multi:end*/';

function patchDir(dir, { undo = false } = {}) {
  const file = path.join(dir, 'extension.js'), backup = path.join(dir, BACKUP), mod = path.join(dir, 'claude-multi.js');
  const ui = path.join(dir, 'webview', 'index.js');
  const stripUi = (t) => { const i = t.indexOf(UI_BEGIN), j = t.indexOf(UI_END); return i === 0 && j > 0 ? t.slice(j + UI_END.length + 1) : t; };
  if (undo) {
    if (fs.existsSync(backup)) { fs.copyFileSync(backup, file); fs.unlinkSync(backup); }
    if (fs.existsSync(ui)) { const t = fs.readFileSync(ui, 'utf8'), u = stripUi(t); if (u !== t) fs.writeFileSync(ui, u); }
    if (fs.existsSync(mod)) fs.unlinkSync(mod);
    return 'restored';
  }
  let changed = false;
  const self = fs.readFileSync(__filename);
  if (!fs.existsSync(mod) || !fs.readFileSync(mod).equals(self)) { fs.writeFileSync(mod, self); changed = true; }
  const original = fs.readFileSync(file, 'utf8');
  let s = original;
  for (const h of HOOKS) {
    if (s.includes(h.has)) continue;
    const n = (s.match(new RegExp(h.re.source, 'g')) || []).length;
    if (n === 0 || (h.exactlyOne && n !== 1)) throw new Error('Claude Multi: cannot find ' + h.what + ' in this Claude extension version (' + n + ' matches)');
    s = s.replace(new RegExp(h.re.source, 'g'), h.to);
  }
  if (s !== original) {
    if (!original.includes(MARK) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, s);
    changed = true;
  }
  if (fs.existsSync(ui)) {
    const t = fs.readFileSync(ui, 'utf8');
    const u = UI_BEGIN + '(' + webviewMain.toString() + ')();' + UI_END + '\n' + stripUi(t);
    if (u !== t) { fs.writeFileSync(ui, u); changed = true; }
  }
  return changed ? 'patched' : 'already';
}

// Runs inside the Claude panel (prepended to webview/index.js): adds an
// "Accounts" section above "Session manager". Must be self-contained.
function webviewMain() {
  if (window.__claudeMultiUI) return;
  window.__claudeMultiUI = true;
  var orig = window.acquireVsCodeApi, api = null;
  if (typeof orig === 'function') window.acquireVsCodeApi = function () { return api || (api = orig()); };
  function post(m) { try { (api || window.acquireVsCodeApi()).postMessage(Object.assign({ type: 'claudeMulti' }, m)); } catch (e) {} }
  var state = null, block = null, body = null, chevron = null, said = false, collapsed = false, queued = false, dragAlias = null;
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtAt(iso) {
    var d = new Date(iso), time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    if (d.toDateString() === new Date().toDateString()) return 'at ' + time;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' at ' + time;
  }
  function pct(f) { return Math.round((f || 0) * 100); }
  var DIM = 'var(--vscode-descriptionForeground)';
  function link(text, fn) {
    var b = el('button', { background: 'none', border: 'none', padding: '0', margin: '0', color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', font: 'inherit', fontSize: '12px' }, text);
    b.addEventListener('click', fn);
    return b;
  }
  function button(text, fn) {
    var b = el('button', {
      background: 'var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2))', color: 'var(--vscode-button-secondaryForeground, inherit)',
      border: '1px solid var(--vscode-button-border, transparent)', borderRadius: '4px', padding: '2px 10px', cursor: 'pointer', font: 'inherit', fontSize: '11px', lineHeight: '16px'
    }, text);
    b.addEventListener('click', fn);
    return b;
  }
  function time(iso) { return fmtAt(iso).replace(/^at /, ''); }
  function level(f) {
    return f >= 1 ? 'var(--vscode-errorForeground, #f14c4c)' : f >= (state ? state.threshold : 0.85) ? 'var(--vscode-editorWarning-foreground, #cca700)' : DIM;
  }
  // One limit, laid out like the extension's own Usage rows.
  function meter(label, f, resetsAt) {
    var box = el('div', { marginTop: '8px' });
    var top = el('div', { display: 'flex', justifyContent: 'space-between', fontSize: '12px' });
    top.appendChild(el('span', null, label));
    top.appendChild(el('span', { fontVariantNumeric: 'tabular-nums', color: f >= (state ? state.threshold : 0.85) ? level(f) : 'inherit' }, pct(f) + '%'));
    box.appendChild(top);
    var outer = el('div', { height: '4px', borderRadius: '2px', background: 'rgba(128,128,128,0.22)', margin: '4px 0 3px 0', overflow: 'hidden' });
    outer.appendChild(el('div', { height: '100%', width: Math.min(100, pct(f)) + '%', minWidth: f > 0 ? '4px' : '0', borderRadius: '2px', background: level(f) }));
    box.appendChild(outer);
    box.appendChild(el('div', { color: DIM, fontSize: '11px' }, resetsAt ? 'Resets ' + fmtAt(resetsAt) : 'No reset scheduled'));
    return box;
  }
  function setting(label, value, fn) {
    var row = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '3px 0' });
    row.appendChild(el('span', null, label));
    row.appendChild(link(value, fn));
    return row;
  }
  function draw() {
    if (!body) return;
    body.textContent = '';
    body.style.display = collapsed ? 'none' : 'block';
    if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
    var dim = { color: DIM, fontSize: '12px' };
    if (!state) { body.appendChild(el('div', dim, 'Loading accounts…')); return; }
    if (!state.accounts.length) body.appendChild(el('div', Object.assign({ marginBottom: '8px' }, dim), 'No accounts yet. Add one to get started.'));
    state.accounts.forEach(function (a, idx) {
      var card = el('div', {
        marginBottom: '8px', padding: '10px 12px', borderRadius: '6px', cursor: 'grab',
        border: '1px solid ' + (a.active ? 'var(--vscode-focusBorder, rgba(128,128,128,0.5))' : 'var(--vscode-widget-border, rgba(128,128,128,0.25))'),
        background: a.active ? 'rgba(128,128,128,0.08)' : 'transparent'
      });
      card.draggable = true;
      card.addEventListener('dragstart', function (e) { dragAlias = a.alias; card.style.opacity = '0.4'; try { e.dataTransfer.effectAllowed = 'move'; } catch (x) {} });
      card.addEventListener('dragend', function () { card.style.opacity = ''; dragAlias = null; });
      card.addEventListener('dragover', function (e) { e.preventDefault(); card.style.borderTop = dragAlias && dragAlias !== a.alias ? '2px solid var(--vscode-focusBorder)' : ''; });
      card.addEventListener('dragleave', function () { card.style.borderTop = ''; });
      card.addEventListener('drop', function (e) {
        e.preventDefault(); card.style.borderTop = '';
        if (dragAlias && dragAlias !== a.alias) { var order = state.accounts.map(function (x) { return x.alias; }); order.splice(order.indexOf(dragAlias), 1); order.splice(order.indexOf(a.alias), 0, dragAlias); post({ cmd: 'reorder', order: order }); }
      });
      var top = el('div', { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '22px' });
      top.appendChild(el('span', { color: DIM, fontSize: '12px', cursor: 'grab' }, '⋮⋮'));
      top.appendChild(el('span', { color: DIM, fontSize: '10px' }, '#' + (idx + 1)));
      top.appendChild(el('span', { fontWeight: '600', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, a.alias));
      if (a.active) top.appendChild(el('span', { fontSize: '9px', fontWeight: '600', letterSpacing: '0.04em', padding: '1px 6px', borderRadius: '8px', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)' }, 'ACTIVE'));
      top.appendChild(el('span', { flex: '1' }));
      if (a.signedOut) top.appendChild(button('Sign in', function () { post({ cmd: 'signin', alias: a.alias }); }));
      else if (!a.active) top.appendChild(button('Use', function () { post({ cmd: 'switch', alias: a.alias }); }));
      card.appendChild(top);
      if (a.email) card.appendChild(el('div', { color: DIM, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, a.email));
      if (a.signedOut) card.appendChild(el('div', Object.assign({ marginTop: '6px' }, dim), 'Signed out'));
      else if (a.session == null) card.appendChild(el('div', Object.assign({ marginTop: '6px' }, dim), 'Usage not checked yet'));
      else {
        card.appendChild(meter('Session (5hr)', a.session, a.sessionResetsAt));
        card.appendChild(meter('Weekly (7 day)', a.weekly, a.weeklyResetsAt));
        var due = a.nextCheckAt && a.nextCheckAt > Date.now() ? time(a.nextCheckAt) : 'now';
        var status = (a.checkedAt ? (a.live ? 'Live · ' : 'Updated ') + time(a.checkedAt) + ' · ' : '') + 'next check ' + due + (a.busy ? ' (server busy)' : '');
        card.appendChild(el('div', { color: DIM, fontSize: '11px', opacity: '0.75', marginTop: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, status));
      }
      body.appendChild(card);
    });
    if (state.accounts.length > 1) body.appendChild(el('div', { color: DIM, fontSize: '11px', opacity: '0.8', margin: '0 0 8px' }, 'Drag to set priority — auto-switch tries them top to bottom.'));
    var settings = el('div', { marginTop: '10px' });
    settings.appendChild(setting('Auto-switch', state.autoSwitch ? 'On' : 'Off', function () { post({ cmd: 'auto' }); }));
    settings.appendChild(setting('Switch at', pct(state.threshold) + '% used', function () { post({ cmd: 'threshold' }); }));
    body.appendChild(settings);
    var foot = el('div', { display: 'flex', justifyContent: 'space-between', marginTop: '8px' });
    foot.appendChild(link('+ Add account', function () { post({ cmd: 'add' }); }));
    foot.appendChild(link('More…', function () { post({ cmd: 'more' }); }));
    body.appendChild(foot);
  }
  function ensure() {
    queued = false;
    var btn = document.querySelector('button[title$="session manager"]');
    var hdr = btn && btn.parentElement;
    if (!hdr || !hdr.parentElement) return;
    if (!block) {
      block = el('div');
      var h = hdr.cloneNode(true), b = h.querySelector('button'), label = h.querySelector('span');
      if (label) label.textContent = 'Accounts';
      chevron = h.querySelector('svg');
      if (b) {
        b.removeAttribute('title');
        b.addEventListener('click', function () { collapsed = !collapsed; draw(); });
      }
      block.appendChild(h);
      body = el('div', { padding: '2px 20px 12px 20px' });
      block.appendChild(body);
      draw();
    }
    if (block.nextSibling !== hdr) hdr.parentElement.insertBefore(block, hdr);
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(ensure); } }
  function banner(sw) {
    var bar = el('div', { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '99999',
      padding: '8px 14px', font: '13px var(--vscode-font-family)', color: '#fff',
      background: 'var(--vscode-statusBarItem-prominentBackground, #3794ff)',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)', textAlign: 'center',
      transition: 'opacity 0.4s', opacity: '0' });
    bar.textContent = 'Account switched to ' + sw.to + (sw.from ? ' from ' + sw.from : '') + (sw.reason ? ' — ' + sw.reason : '');
    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.style.opacity = '1'; });
    setTimeout(function () { bar.style.opacity = '0'; setTimeout(function () { bar.remove(); }, 500); }, 6000);
  }
    window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'claudeMulti') return;
    if (e.data.state) { state = e.data.state; draw(); }
    if (e.data.switched) banner(e.data.switched);
  });
  // Register every panel (chat panels too) so switch banners reach all of them,
  // not only the sidebar that shows the Accounts section.
  post({ cmd: "hello" });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(draw, 30000);
  schedule();
}

function claudeExtensionDirs(root) {
  try {
    return fs.readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-')).map((d) => path.join(root, d))
      .filter((d) => fs.existsSync(path.join(d, 'extension.js')));
  } catch { return []; }
}

// ---------- small helpers ----------

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
function writeJSON(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const cfg = () => ({ accounts: [], activeAccount: null, autoSwitch: true, switchThreshold: 0.85, ...readJSON(CONFIG, {}) });
const saveCfg = (c) => writeJSON(CONFIG, c);
const iso = () => new Date().toISOString();
const pct = (f) => Math.round((f || 0) * 100);
const dirOf = (a) => path.join(PROFILES, a.alias);
const REPO_URL = 'https://github.com/uditgoyaludit/claude-code-account-switcher-auto-switch-on-limit';
const openRepo = () => vscode.env.openExternal(vscode.Uri.parse(REPO_URL));

// A polite, optional ask for a GitHub star: once after the 3rd successful switch,
// again 3 switches after "Later", never after "Star" or "Don't ask again".
function askForStar() {
  const c = cfg(), s = c.starAsk || { switches: 0, askAt: 3 };
  if (s.done) return;
  s.switches = (s.switches || 0) + 1;
  const due = s.switches >= (s.askAt || 3);
  if (due) s.askAt = s.switches + 3; // claim this ask before showing, so other windows don't repeat it
  c.starAsk = s;
  saveCfg(c);
  if (!due) return;
  vscode.window.showInformationMessage('Enjoying Multi Account Switcher? A ⭐ on GitHub helps others find it.', 'Star on GitHub', 'Later', "Don't ask again")
    .then((pick) => {
      if (pick === 'Star on GitHub') openRepo();
      if (pick === 'Star on GitHub' || pick === "Don't ask again") { const n = cfg(); n.starAsk = { ...(n.starAsk || s), done: true }; saveCfg(n); }
    }, (e) => log('star ask failed', e));
}

// Earlier versions ran each account in its own folder; move any chats made
// there into ~/.claude so they can be resumed.
function moveInto(from, to) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name), dst = path.join(to, name);
    if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    else if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) moveInto(src, dst);
  }
  try { fs.rmdirSync(from); } catch {} // stays if something could not be merged
}

function linkShared(a) {
  for (const name of ['projects', 'file-history']) {
    const shared = path.join(os.homedir(), '.claude', name), own = path.join(dirOf(a), name);
    let st = null;
    try { st = fs.lstatSync(own); } catch {}
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    fs.mkdirSync(shared, { recursive: true });
    moveInto(own, shared);
    if (fs.existsSync(own)) fs.renameSync(own, own + '.unmerged-' + Date.now());
    fs.symlinkSync(shared, own, process.platform === 'win32' ? 'junction' : 'dir'); // a junction needs no admin rights on Windows
  }
}

// slot: the account's own stored login. Otherwise the live login Claude uses.
function envFor(a, slot) {
  const env = { ...process.env };
  for (const k of AUTH_VARS) delete env[k];
  if (a && slot) env.CLAUDE_CONFIG_DIR = dirOf(a); else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const run = (bin, args, opts = {}) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 60e3, maxBuffer: 1 << 20, ...opts }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
});

function fmtIn(isoDate) {
  const m = Math.round((Date.parse(isoDate) - Date.now()) / 60e3);
  if (!(m > 0)) return 'now';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return `in ${d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`}`;
}

function fmtAt(isoDate) {
  const d = new Date(isoDate), time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (d.toDateString() === new Date().toDateString()) return `at ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

// Usage with windows whose reset time has passed counted as 0.
function view(u) {
  if (!u || typeof u.session !== 'number') return null;
  const past = (d) => d && Date.parse(d) <= Date.now();
  const session = past(u.sessionResetsAt) ? 0 : u.session, weekly = past(u.weeklyResetsAt) ? 0 : (u.weekly || 0);
  return {
    session, weekly, frac: Math.max(session, weekly),
    sessionResetsAt: past(u.sessionResetsAt) ? null : u.sessionResetsAt,
    weeklyResetsAt: past(u.weeklyResetsAt) ? null : u.weeklyResetsAt
  };
}

function describe(u) {
  if (u && u.reason === 'logged_out') return 'Signed out';
  const v = view(u);
  if (!v) return 'Usage not checked yet';
  const part = (name, f, r) => `${name} ${pct(f)}% used${r ? ` (resets ${fmtAt(r)})` : ''}`;
  return `${part('Session', v.session, v.sessionResetsAt)} · ${part('Week', v.weekly, v.weeklyResetsAt)}`;
}

// ---------- runtime (inside the extension host) ----------

let vscode, ctx, host, item, bin, seenActive = null, manualAlias = null, lastSwitch = 0, switching = false, lastAllLimitedNote = 0;
const polling = new Set(), lastRefresh = new Map();
const log = (...a) => console.log('[claude-multi]', ...a);

function setUsage(alias, patch) {
  const all = readJSON(USAGE, {});
  all[alias] = { ...(all[alias] || {}), ...patch };
  writeJSON(USAGE, all);
  render();
}

// Where Claude Code keeps a login: on macOS a keychain entry named by the config
// folder (no suffix for the default folder), elsewhere <folder>/.credentials.json.
const keychainName = (dir) => 'Claude Code-credentials' + (dir ? '-' + crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8) : '');
const credsFile = (dir) => path.join(dir || path.join(os.homedir(), '.claude'), '.credentials.json');

// dir: an account slot, or null for the live login.
async function readCreds(dir) {
  try {
    if (process.platform !== 'darwin') return JSON.parse(fs.readFileSync(credsFile(dir), 'utf8'));
    const r = await run('security', ['find-generic-password', '-s', keychainName(dir), '-w'], { timeout: 10e3 });
    if (!r.ok) return null;
    const out = r.stdout.trim();
    // `security` prints the value as hex when it holds non-ASCII characters.
    return JSON.parse(out.startsWith('{') ? out : Buffer.from(out, 'hex').toString('utf8'));
  } catch { return null; }
}

async function writeCreds(dir, oauth) {
  const data = JSON.stringify({ ...((await readCreds(dir)) || {}), claudeAiOauth: oauth });
  if (process.platform !== 'darwin') {
    fs.mkdirSync(path.dirname(credsFile(dir)), { recursive: true });
    fs.writeFileSync(credsFile(dir), data, { mode: 0o600 });
    return true;
  }
  // As an argument, not via `security -i`: its stdin line buffer truncates long values.
  const user = process.env.USER || os.userInfo().username;
  const r = await run('security', ['add-generic-password', '-U', '-a', user, '-s', keychainName(dir), '-X', Buffer.from(data).toString('hex')], { timeout: 15e3 });
  if (!r.ok) return false;
  const back = await readCreds(dir);
  return !!(back && back.claudeAiOauth && back.claudeAiOauth.accessToken === oauth.accessToken);
}

const isActive = (a) => cfg().activeAccount === a.alias;
// The active account's current login is the live one; its slot copy may be stale.
async function readToken(a) { return ((await readCreds(isActive(a) ? null : dirOf(a))) || {}).claudeAiOauth || null; }

// Only Claude itself spends the (rotating) refresh token: `/usage` in print mode makes no model call.
async function refreshToken(a) {
  if (Date.now() - (lastRefresh.get(a.alias) || 0) < 5 * 60e3) return;
  lastRefresh.set(a.alias, Date.now());
  fs.mkdirSync(dirOf(a), { recursive: true });
  await run(bin, ['-p', '/usage'], { env: envFor(a, !isActive(a)), cwd: dirOf(a) });
}

async function authStatus(a, slot) {
  const r = await run(bin, ['auth', 'status', '--json'], { env: envFor(a, slot), timeout: 20e3 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Account details Claude shows (email, organisation) live in .claude.json.
function copyAccountInfo(fromFile, toFile) {
  try {
    const info = readJSON(fromFile, {}).oauthAccount;
    if (!info) return;
    const to = readJSON(toFile, null) || (fs.existsSync(toFile) ? null : {});
    if (!to) return;
    to.oauthAccount = info;
    const tmp = `${toFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(to, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, toFile);
  } catch (e) { log('account info not copied', e); }
}
const LIVE_INFO = path.join(os.homedir(), '.claude.json');
const slotInfo = (a) => path.join(dirOf(a), '.claude.json');

// The /login-style switch: save the outgoing account's live login to its slot,
// then make the incoming account's stored login the live one.
async function swapLogin(fromAlias, toAlias) {
  const c = cfg(), from = c.accounts.find((x) => x.alias === fromAlias), to = c.accounts.find((x) => x.alias === toAlias);
  if (!to) return false;
  const next = ((await readCreds(dirOf(to))) || {}).claudeAiOauth;
  if (!next || !next.accessToken) return false;
  if (from && from.alias !== to.alias) {
    const live = ((await readCreds(null)) || {}).claudeAiOauth;
    if (live && live.accessToken) {
      fs.mkdirSync(dirOf(from), { recursive: true });
      if (!(await writeCreds(dirOf(from), live))) return false;
      copyAccountInfo(LIVE_INFO, slotInfo(from));
    }
  }
  if (!(await writeCreds(null, next))) return false;
  copyAccountInfo(slotInfo(to), LIVE_INFO);
  c.activeAccount = to.alias;
  saveCfg(c);
  return true;
}

async function fetchUsage(token) {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-cli/${ctx.extension.packageJSON.version} (external, cli)` },
      signal: AbortSignal.timeout(15e3)
    });
    return { status: res.status, data: res.ok ? await res.json() : null };
  } catch { return { status: 0 }; }
}

async function poll(alias, { force = false } = {}) {
  if (polling.has(alias)) return;
  polling.add(alias);
  try {
    const c = cfg(), a = c.accounts.find((x) => x.alias === alias);
    if (!a) return;
    const u = readJSON(USAGE, {})[alias] || {}, now = Date.now();
    if (now < (u.nextCheckAt || 0) && (!force || u.backoffMs)) return;
    let tok = await readToken(a);
    if (!tok || !tok.accessToken) { setUsage(alias, { reason: 'logged_out', checkedAt: iso() }); return; }
    if (tok.expiresAt && tok.expiresAt - now < 60e3) { await refreshToken(a); tok = (await readToken(a)) || tok; }
    let r = await fetchUsage(tok.accessToken);
    if (r.status === 401) {
      await refreshToken(a);
      const t2 = await readToken(a);
      if (t2 && t2.accessToken && t2.accessToken !== tok.accessToken) r = await fetchUsage(t2.accessToken);
    }
    const every = alias === c.activeAccount ? ACTIVE_POLL : IDLE_POLL;
    if (r.status === 200) {
      const s = r.data.five_hour, w = r.data.seven_day;
      setUsage(alias, {
        reason: 'ok', source: 'api', checkedAt: iso(), nextCheckAt: now + every, backoffMs: 0,
        session: ((s && s.utilization) || 0) / 100, weekly: ((w && w.utilization) || 0) / 100,
        sessionResetsAt: (s && s.resets_at) || null, weeklyResetsAt: (w && w.resets_at) || null
      });
    } else if (r.status === 401 || r.status === 403) {
      setUsage(alias, { reason: 'auth_expired', nextCheckAt: now + every });
    } else {
      // 429 or offline: keep the last reading and wait longer each time.
      const backoffMs = Math.min(Math.max((u.backoffMs || 0) * 2, 2 * 60e3), 30 * 60e3);
      setUsage(alias, { nextCheckAt: now + backoffMs, backoffMs });
    }
  } catch (e) { log('poll failed', alias, e); } finally { polling.delete(alias); }
}

// Live update from the extension: { five_hour, seven_day: { utilization 0..1, resetsAt epoch s } }.
function onUsage(w) {
  if (!w || (!w.five_hour && !w.seven_day)) return;
  const c = cfg();
  if (!c.activeAccount) return;
  const all = readJSON(USAGE, {});
  const at = (x) => (x && x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : null);
  const frac = (x) => (x && x.utilization != null ? (x.utilization > 1.5 ? x.utilization / 100 : x.utilization) : 0);
  // A chat still finishing a reply on the previous account reports that account's
  // numbers; the weekly reset time tells the accounts apart.
  let alias = c.activeAccount;
  const wk = w.seven_day && w.seven_day.resetsAt;
  const same = (name) => all[name] && all[name].weeklyResetsAt && Math.abs(Date.parse(all[name].weeklyResetsAt) - wk * 1000) < 120e3;
  if (wk && !same(alias)) {
    const other = c.accounts.find((a) => a.alias !== alias && same(a.alias));
    if (other) alias = other.alias;
  }
  const now = Date.now();
  setUsage(alias, {
    reason: 'ok', source: 'live', checkedAt: iso(), backoffMs: 0,
    nextCheckAt: now + (alias === c.activeAccount ? ACTIVE_POLL : IDLE_POLL),
    session: frac(w.five_hour), weekly: frac(w.seven_day),
    sessionResetsAt: at(w.five_hour), weeklyResetsAt: at(w.seven_day)
  });
  evaluate().catch((e) => log('evaluate failed', e));
}

async function evaluate() {
  const c = cfg();
  if (!c.autoSwitch || c.accounts.length < 2 || switching || Date.now() - lastSwitch < 60e3) return;
  const cur = readJSON(USAGE, {})[c.activeAccount];
  const v = view(cur), loggedOut = cur && cur.reason === 'logged_out';
  // An account you picked by hand is left alone until it is fully used up (100%).
  // A hand-picked account is kept until it is nearly exhausted (99%).
  const limit = c.activeAccount === manualAlias ? 0.99 : c.switchThreshold;
  if (!loggedOut && (!v || v.frac < limit)) return;
  switching = true;
  try {
    const others = c.accounts.filter((a) => a.alias !== c.activeAccount);
    // Re-check the others before deciding, but at most every 5 minutes each:
    // this runs on every tick while the active account is over the threshold.
    const seen = readJSON(USAGE, {});
    const stale = (a) => Date.now() - (Date.parse((seen[a.alias] || {}).checkedAt) || 0) > 5 * 60e3;
    await Promise.all(others.filter(stale).map((a) => poll(a.alias, { force: true })));
    const all = readJSON(USAGE, {});
    // others is in config (priority) order. Pick the first one under the threshold;
    // if none, and the active account is exhausted, fall back to the least-used.
    const avail = others.map((a) => ({ alias: a.alias, v: all[a.alias] && all[a.alias].reason !== 'logged_out' ? view(all[a.alias]) : null })).filter((x) => x.v);
    const curFrac = v ? v.frac : 1;
    let best = avail.find((x) => x.v.frac < c.switchThreshold);
    if (!best && curFrac >= 1) best = avail.filter((x) => x.v.frac < 1).sort((x, y) => x.v.frac - y.v.frac)[0];
    if (best) {
      await switchTo(best.alias, loggedOut ? `${c.activeAccount} is signed out` : `${c.activeAccount} is at ${pct(curFrac)}%`);
    } else if (curFrac >= 1 && Date.now() - lastAllLimitedNote > 60 * 60e3) {
      lastAllLimitedNote = Date.now();
      const next = c.accounts.map((a) => ({ alias: a.alias, v: view(all[a.alias]) })).filter((x) => x.v)
        .map((x) => ({ alias: x.alias, at: Math.max(...[x.v.session >= 1 && x.v.sessionResetsAt, x.v.weekly >= 1 && x.v.weeklyResetsAt].filter(Boolean).map((d) => Date.parse(d))) }))
        .filter((x) => Number.isFinite(x.at)).sort((x, y) => x.at - y.at)[0];
      vscode.window.showWarningMessage(`All Claude accounts are at their limit.${next ? ` ${next.alias} frees up ${fmtIn(new Date(next.at).toISOString())}.` : ''}`);
    }
  } finally { switching = false; }
}

// Older versions pointed the extension at an account folder; remove that.
async function clearFolderSetting() {
  const conf = vscode.workspace.getConfiguration('claudeCode');
  const before = conf.get('environmentVariables') || [];
  const vars = before.filter((e) => e.name !== 'CLAUDE_CONFIG_DIR');
  if (vars.length === before.length) return false;
  await conf.update('environmentVariables', vars.length ? vars : undefined, vscode.ConfigurationTarget.Global);
  return true;
}

// Make the extension notice the new login and restart chats on it (idle ones now,
// busy ones when their reply ends).
function applyLogin() {
  try { if (host && host.refreshEveryHost) host.refreshEveryHost('Claude Multi switched account'); } catch (e) { log('refresh failed', e); }
  restartSessions();
}

function restartSessions() {
  try { for (const c of (host && host.allComms) || []) if (c.restartSessionsWhenIdle) c.restartSessionsWhenIdle(); }
  catch (e) { log('restart failed', e); }
}

async function switchTo(alias, reason, { manual = false } = {}) {
  const from = cfg().activeAccount;
  if (!(await swapLogin(from, alias))) {
    vscode.window.showWarningMessage(`Could not switch to ${alias}: it is signed out. Use "Sign in again".`);
    return;
  }
  // Protect a hand pick only when it was already above the threshold (a deliberate
  // choice of a high-usage account). A pick below the threshold behaves normally.
  const pickFrac = (view(readJSON(USAGE, {})[alias]) || {}).frac || 0;
  manualAlias = manual && pickFrac >= cfg().switchThreshold ? alias : null;
  seenActive = alias;
  lastSwitch = Date.now();
  applyLogin();
  render();
  poll(alias, { force: true });
  if (from !== alias) {
    broadcast({ switched: { from, to: alias, reason: reason || '' } });
    vscode.window.showInformationMessage(`Claude is now using ${alias}${reason ? ` (${reason})` : ''}. A chat that is mid-reply moves over when the reply ends.`);
    setTimeout(() => { try { askForStar(); } catch (e) { log('star ask failed', e); } }, 4000);
  }
}

const webviews = new Set();

function snapshot() {
  const c = cfg(), all = readJSON(USAGE, {});
  return {
    autoSwitch: c.autoSwitch, threshold: c.switchThreshold,
    accounts: c.accounts.map((a) => {
      const u = all[a.alias], v = view(u);
      return {
        alias: a.alias, email: a.email || '', active: a.alias === c.activeAccount, signedOut: !!(u && u.reason === 'logged_out'),
        session: v ? v.session : null, weekly: v ? v.weekly : null,
        sessionResetsAt: v ? v.sessionResetsAt : null, weeklyResetsAt: v ? v.weeklyResetsAt : null,
        checkedAt: (u && u.checkedAt) || null, nextCheckAt: (u && u.nextCheckAt) || null, live: !!(u && u.source === 'live'), busy: !!(u && u.backoffMs)
      };
    })
  };
}

function broadcast(msg) {
  for (const wv of webviews) {
    try { Promise.resolve(wv.postMessage(Object.assign({ type: 'claudeMulti' }, msg))).catch(() => webviews.delete(wv)); }
    catch { webviews.delete(wv); }
  }
}

function pushState() {
  if (!webviews.size) return;
  const state = snapshot();
  for (const wv of webviews) {
    try { Promise.resolve(wv.postMessage({ type: 'claudeMulti', state })).catch(() => webviews.delete(wv)); }
    catch { webviews.delete(wv); }
  }
}

// Messages from the Accounts section in the Claude panel.
function fromWebview(m, wv) {
  webviews.add(wv);
  const c = cfg(), a = c.accounts.find((x) => x.alias === m.alias);
  const done = (p) => Promise.resolve(p).catch((e) => log(e)).then(pushState);
  if (m.cmd === 'hello') pushState();
  else if (m.cmd === 'switch' && a) done(switchTo(a.alias, 'you chose it', { manual: true }));
  else if (m.cmd === 'signin' && a) done(signIn(a, false));
  else if (m.cmd === 'add') done(addAccount());
  else if (m.cmd === 'more') done(menu());
  else if (m.cmd === 'reorder' && Array.isArray(m.order)) {
    const c = cfg(); const by = {}; c.accounts.forEach((a) => { by[a.alias] = a; });
    const ranked = m.order.map((al) => by[al]).filter(Boolean);
    c.accounts = ranked.concat(c.accounts.filter((a) => !m.order.includes(a.alias)));
    saveCfg(c); pushState();
  }
  else if (m.cmd === 'threshold') done(setThreshold());
  else if (m.cmd === 'auto') { c.autoSwitch = !c.autoSwitch; saveCfg(c); render(); }
}

function render() {
  pushState();
  if (!item) return;
  const c = cfg(), all = readJSON(USAGE, {});
  if (!c.accounts.length) {
    item.text = '$(account) Claude: add account';
    item.tooltip = 'Add a Claude account';
    item.backgroundColor = undefined;
    item.show();
    return;
  }
  const u = all[c.activeAccount], v = view(u);
  item.text = `$(account) ${c.activeAccount || '?'}${u && u.reason === 'logged_out' ? ' signed out' : v ? ` ${pct(v.frac)}%` : ''}`;
  item.backgroundColor = v && v.frac >= 1 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : v && v.frac >= c.switchThreshold ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const lines = c.accounts.map((a) => `${a.alias === c.activeAccount ? '●' : '○'} ${a.alias}: ${describe(all[a.alias])}`);
  item.tooltip = ['Claude accounts', ...lines, '', `Auto-switch ${c.autoSwitch ? `on, at ${pct(c.switchThreshold)}% used` : 'off'}`, 'Click to manage'].join('\n');
  item.show();
}

// Browser sign-in in an IDE terminal; resolves once the account is signed in.
// Browser sign-in in an IDE terminal, into the account's own slot so the live
// login is untouched until the account is used.
async function signIn(a, isNew) {
  const dir = dirOf(a);
  fs.mkdirSync(dir, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: dir };
  for (const k of AUTH_VARS) env[k] = null;
  // Run the Claude binary directly (no shell), so it works whatever the default
  // terminal is: zsh/bash, PowerShell, cmd or Git Bash.
  const term = vscode.window.createTerminal({ name: `Claude sign-in: ${a.alias}`, env, shellPath: bin, shellArgs: ['auth', 'login', '--claudeai'] });
  term.show();
  const slotToken = async () => ((await readCreds(dir)) || {}).claudeAiOauth;
  const before = await slotToken();
  const deadline = Date.now() + 10 * 60e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const tok = await slotToken();
    if (!tok || !tok.accessToken || (before && tok.accessToken === before.accessToken)) continue;
    const st = await authStatus(a, true);
    if (!st || !st.loggedIn) continue;
    const c = cfg();
    const entry = { alias: a.alias, email: st.email || '', organization: st.orgName || '', orgId: st.orgId || '', subscription: st.subscriptionType || '' };
    const i = c.accounts.findIndex((x) => x.alias === a.alias);
    if (i >= 0) c.accounts[i] = { ...c.accounts[i], ...entry }; else c.accounts.push({ ...entry, addedAt: iso() });
    const makeLive = !c.activeAccount || c.activeAccount === a.alias;
    saveCfg(c);
    term.dispose();
    if (makeLive && (await swapLogin(null, a.alias))) { seenActive = a.alias; applyLogin(); }
    await poll(a.alias, { force: true });
    vscode.window.showInformationMessage(`${a.alias} is signed in${st.email ? ` as ${st.email}` : ''}.`);
    return true;
  }
  if (isNew) vscode.window.showWarningMessage(`Sign-in for ${a.alias} was not completed.`);
  return false;
}

async function addAccount() {
  const taken = cfg().accounts.map((a) => a.alias);
  const alias = await vscode.window.showInputBox({
    title: 'Add Claude account', prompt: 'A short name for this account, e.g. work',
    validateInput: (v) => (!/^[A-Za-z0-9_-]+$/.test(v) ? 'Letters, numbers, - and _ only' : taken.includes(v) ? 'That name is already used' : null)
  });
  if (alias) await signIn({ alias }, true);
}

async function removeAccount() {
  const c = cfg();
  const pick = await vscode.window.showQuickPick(c.accounts.map((a) => ({ label: a.alias, description: a.email || '' })), { title: 'Remove which account?' });
  if (!pick) return;
  const a = c.accounts.find((x) => x.alias === pick.label);
  const wasActive = c.activeAccount === a.alias, rest = c.accounts.filter((x) => x.alias !== a.alias);
  const note = wasActive && !rest.length ? 'Claude stays signed in with it; it is only removed from this list.'
    : 'Its stored login is deleted. You can add it again any time.';
  if ((await vscode.window.showWarningMessage(`Remove ${a.alias}?`, { modal: true, detail: note }, 'Remove')) !== 'Remove') return;
  await run(bin, ['auth', 'logout'], { env: envFor(a, true), timeout: 20e3 });
  fs.rmSync(dirOf(a), { recursive: true, force: true });
  const c2 = cfg();
  c2.accounts = c2.accounts.filter((x) => x.alias !== a.alias);
  if (wasActive) c2.activeAccount = null;
  saveCfg(c2);
  const all = readJSON(USAGE, {});
  delete all[a.alias];
  writeJSON(USAGE, all);
  if (wasActive && rest[0]) await switchTo(rest[0].alias, `${a.alias} was removed`);
  render();
}

async function setThreshold() {
  const v = await vscode.window.showInputBox({
    title: 'Auto-switch threshold', prompt: 'Switch to another account when this much of the limit is used (percent, 1-100)',
    value: String(pct(cfg().switchThreshold)),
    validateInput: (t) => (/^\d{1,3}$/.test(t.trim()) && +t >= 1 && +t <= 100 ? null : 'Enter a whole number from 1 to 100')
  });
  if (v === undefined) return;
  const c = cfg();
  c.switchThreshold = +v.trim() / 100;
  saveCfg(c);
  render();
  evaluate().catch((e) => log('evaluate failed', e));
}

async function menu() {
  const c = cfg(), all = readJSON(USAGE, {});
  const items = c.accounts.map((a) => ({
    label: `${a.alias === c.activeAccount ? '$(check)' : '$(circle-large-outline)'} ${a.alias}`,
    description: [a.email, a.organization].filter(Boolean).join(' · '),
    detail: describe(all[a.alias]), run: () => switchTo(a.alias, 'you chose it', { manual: true })
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) Add account…', run: addAccount });
  if (c.accounts.length) {
    items.push({ label: '$(sync) Refresh usage', run: () => Promise.all(c.accounts.map((a) => poll(a.alias, { force: true }))) });
    items.push({
      label: `$(arrow-swap) Auto-switch: ${c.autoSwitch ? 'on' : 'off'}`, description: `switches at ${pct(c.switchThreshold)}% used`,
      run: () => { const n = cfg(); n.autoSwitch = !n.autoSwitch; saveCfg(n); render(); }
    });
    items.push({ label: `$(settings) Switch at: ${pct(c.switchThreshold)}% used…`, run: setThreshold });
    items.push({
      label: '$(sign-in) Sign in again…', run: async () => {
        const p = await vscode.window.showQuickPick(c.accounts.map((a) => a.alias), { title: 'Sign in again to which account?' });
        if (p) await signIn(c.accounts.find((a) => a.alias === p), false);
      }
    });
    items.push({ label: '$(trash) Remove account…', run: removeAccount });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(star) Star on GitHub', description: 'helps others find this extension', run: openRepo });
  const pick = await vscode.window.showQuickPick(items, { title: 'Claude accounts', placeHolder: 'Pick an account to switch to it' });
  if (pick && pick.run) await pick.run();
}

// One-time setup: work out which account the live login belongs to. If it is not
// one of the added accounts it becomes the first account, "main".
async function adopt() {
  let c = cfg();
  if (c.swapSetup) return;
  for (const a of c.accounts) { try { linkShared(a); } catch (e) { log('chat history not moved for', a.alias, e); } }
  const st = await authStatus(null, false);
  const live = ((await readCreds(null)) || {}).claudeAiOauth;
  c = cfg();
  c.accounts = c.accounts.map(({ system, configDir, ...a }) => a);
  if (st && st.loggedIn && st.authMethod === 'claude.ai' && live && live.accessToken) {
    const match = st.orgId && c.accounts.find((a) => a.orgId === st.orgId);
    if (match) c.activeAccount = match.alias;
    else {
      let alias = 'main', n = 2;
      while (c.accounts.some((a) => a.alias === alias)) alias = `main-${n++}`;
      const a = { alias, email: st.email || '', organization: st.orgName || '', orgId: st.orgId || '', subscription: st.subscriptionType || '', addedAt: iso() };
      fs.mkdirSync(dirOf(a), { recursive: true });
      await writeCreds(dirOf(a), live);
      copyAccountInfo(LIVE_INFO, slotInfo(a));
      c.accounts.unshift(a);
      c.activeAccount = alias;
    }
    c.swapSetup = true;
    saveCfg(c);
  } else {
    // Claude is signed out: sign it in with the chosen (or first) account.
    c.swapSetup = true;
    const first = c.accounts.find((a) => a.alias === c.activeAccount) || c.accounts[0];
    c.activeAccount = null;
    saveCfg(c);
    if (first) await swapLogin(null, first.alias);
  }
}

// A Claude extension update installs a new folder next to this one; patch it before it loads.
function patchUpdates() {
  for (const dir of claudeExtensionDirs(path.dirname(ctx.extensionPath))) {
    try {
      if (patchDir(dir) === 'patched') log('patched updated extension', dir);
    } catch (e) {
      log(e.message);
      vscode.window.showWarningMessage(`${e.message}. Account switching will stop working after the Claude extension updates.`);
    }
  }
}

async function tick() {
  const c = cfg();
  // Another window or editor switched accounts: follow it.
  if (seenActive && c.activeAccount && c.activeAccount !== seenActive) applyLogin();
  seenActive = c.activeAccount;
  await Promise.all(c.accounts.map((a) => poll(a.alias)));
  render();
  await evaluate();
}

function start(context, sessionHost) {
  if (globalThis.__claudeMulti) return;
  vscode = require('vscode');
  ctx = context;
  host = sessionHost;
  bin = path.join(ctx.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (!fs.existsSync(bin)) bin = 'claude';
  globalThis.__claudeMulti = { onUsage, webview: fromWebview };
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.command = 'claudeMulti.menu';
  const timers = [setInterval(() => tick().catch((e) => log(e)), 20e3), setInterval(render, 15e3), setInterval(patchUpdates, 10 * 60e3)];
  ctx.subscriptions.push(item, vscode.commands.registerCommand('claudeMulti.menu', menu), { dispose: () => timers.forEach(clearInterval) });
  render();
  (async () => {
    await adopt();
    seenActive = cfg().activeAccount;
    if (await clearFolderSetting()) restartSessions();
    await tick();
    patchUpdates();
  })().catch((e) => log('startup failed', e));
}

module.exports = { start, patchDir, claudeExtensionDirs, MARK, _test: { readCreds, writeCreds, swapLogin, keychainName, askForStar } };
