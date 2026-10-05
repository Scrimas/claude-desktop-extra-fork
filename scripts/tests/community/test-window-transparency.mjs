#!/usr/bin/env node
/*
 * test-window-transparency.mjs - main-process half of the transparent window.
 * Runs the real js/window_transparency.js with electron shimmed and a temporary
 * profile dir: which keys win, native titlebar opt-out, the IPC handlers, which
 * claude.ai webContents get the see-through CSS (main window only), and the
 * opacity slider's live stylesheet swap, locks and validation.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

function load(dir, env = {}, native = false) {
  const handlers = {}, events = {}, windows = [];
  const electron = {
    app: { getPath: () => dir, on: (e, f) => { events[e] = f; } },
    BrowserWindow: { getAllWindows: () => windows.slice() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeTheme: { shouldUseDarkColors: true }
  };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env }, console, setTimeout, __cdbNativeTb: () => native };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, "js/window_transparency.js"), "utf8"), vm.createContext(sandbox));
  return { handlers, events, windows, sandbox };
}
const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };

{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  let t = load(dir);
  ok(JSON.stringify(t.sandbox.__cdbWinTransExtra()) === "{}", "off by default: no extra options");
  const r0 = await t.handlers["cdb-wt:pref-read"](sender);
  ok(r0.ok && r0.enabled === false, "pref-read defaults to off");
  ok(r0.nativeTitlebar === false, "pref-read reports nativeTitlebar false");
  const s = await t.handlers["cdb-wt:pref-set"](sender, true);
  ok(s.ok && s.enabled === true, "pref-set turns it on");
  t = load(dir);
  const x = t.sandbox.__cdbWinTransExtra();
  ok(x.transparent === true && x.backgroundColor === "#00000000", "on: transparent + clear background");
  rmSync(dir, { recursive: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const n = load(dir, {}, true);
  ok(JSON.stringify(n.sandbox.__cdbWinTransExtra()) === "{}", "native titlebar: transparency skipped");
  const rn = await n.handlers["cdb-wt:pref-read"](sender);
  ok(rn.ok && rn.enabled === true && rn.nativeTitlebar === true, "pref-read reports nativeTitlebar true");
  const e = load(dir, { CLAUDE_WINDOW_TRANSPARENCY: "0" });
  ok(JSON.stringify(e.sandbox.__cdbWinTransExtra()) === "{}", "env 0 forces it off");
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{"windowTransparency": false}');
  const l = load(dir);
  const r = await l.handlers["cdb-wt:pref-set"](sender, true);
  ok(r.ok === false, "jsonc lock refuses pref-set");
  const bad = await l.handlers["cdb-wt:pref-set"]({ sender: { getURL: () => "https://evil.example", isDestroyed: () => false } }, true);
  ok(bad.ok === false, "foreign origin rejected");
  rmSync(dir, { recursive: true });
}
{
  // Fake webContents / views / windows: only what the dom-ready handler and
  // the browser-window-created hook touch.
  const fakeWc = (url) => {
    const h = {};
    const wc = { css: 0, cssText: [], on: (e, f) => { h[e] = f; }, getURL: () => url, isDestroyed: () => false,
      insertCSS: (c) => { wc.css++; wc.cssText.push(c); return Promise.resolve(); }, fire: (e) => h[e] && h[e]() };
    return wc;
  };
  const view = (wc, children = []) => ({ webContents: wc, children });
  const win = (wc, contentView) => ({ isDestroyed: () => false, webContents: wc, contentView,
    setBackgroundColor() {}, setSize() {} });

  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const t = load(dir);
  t.sandbox.__cdbWinTransExtra();
  // The insert runs on the webContents' own promise chain, so give it a tick.
  const created = async (wc) => {
    t.events["web-contents-created"](null, wc); wc.fire("dom-ready");
    await new Promise((r) => setTimeout(r, 5));
    return wc.css;
  };

  const mainView = fakeWc("https://claude.ai/new");
  const mainWin = win(fakeWc("file:///x/renderer/main_window/index.html"), view(null, [view(mainView)]));
  t.events["browser-window-created"](null, mainWin);
  const popWc = fakeWc("https://claude.ai/chat/1");
  const popWin = win(popWc, view(popWc));
  const codeWc = fakeWc("https://claude.ai/code");
  const codeWin = win(fakeWc("file:///x/other.html"), view(null, [view(null, [view(codeWc)])]));
  t.windows.push(mainWin, popWin, codeWin);

  ok(await created(mainView) === 1, "main window's claude.ai child view gets the CSS");
  ok(await created(popWc) === 0, "another window's own claude.ai webContents does not");
  ok(await created(codeWc) === 0, "a claude.ai view nested in another window's contentView does not");
  ok(await created(fakeWc("https://claude.ai/new")) === 1, "an unattached claude.ai webContents still gets it");
  rmSync(dir, { recursive: true });

  // The CSS itself, rendered by a real browser: a design-system Dialog card
  // (.bg-surface-2.rounded-card + data-cds=Dialog, e.g. Settings) stays solid
  // while the Claude Code content card with the same two classes still takes the
  // window alpha. Skipped when no chromium is installed, like the DOM harnesses.
  const css = mainView.cssText.join("\n");
  ok(/\[data-cds=Dialog\]\.bg-surface-2\{background-color:var\(--cds-surface-2\)!important\}/.test(css),
     "the claude.ai CSS carries the solid-dialog rule");
  let chromium = null;
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try { chromium = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim() || null; } catch {}
    if (chromium) break;
  }
  if (!chromium) {
    console.log("  skip no chromium: the rendered check of the dialog card");
  } else {
    const d = mkdtempSync(join(tmpdir(), "cdb-wt-css-"));
    const f = join(d, "t.html");
    writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>
:root{--cds-surface-0:#111;--cds-surface-1:#1a1a19;--cds-surface-2:#262624;--cds-surface-3:#333;--cds-page-bg:#111;--bg-200:0 0% 10%}
</style><style>${css}</style>
<div id="dlg" data-cds="Dialog" class="bg-surface-2 rounded-card"></div>
<div id="card" class="bg-surface-2 rounded-card"></div>
<pre id="o"></pre>
<script>o.textContent="CDB-BEGIN"+JSON.stringify({dlg:getComputedStyle(dlg).backgroundColor,card:getComputedStyle(card).backgroundColor})+"CDB-END"</script>`);
    const dump = execFileSync(chromium, ["--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000",
      "--dump-dom", "file://" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /CDB-BEGIN(\{.*?\})CDB-END/.exec(dump.replace(/&quot;/g, '"'));
    const got = m ? JSON.parse(m[1]) : {};
    ok(/^rgb\(38, 38, 36\)$/.test(got.dlg || ""), "a Dialog card renders solid surface-2 (" + got.dlg + ")");
    ok(!!got.card && !/^rgb\(/.test(got.card), "the same classes without data-cds=Dialog still fade (" + got.card + ")");
    rmSync(d, { recursive: true });
  }
}

// --- the opacity slider: pref-read fields, preview/set, locks, validation, and
// the live stylesheet swap on the main window's claude.ai view.
{
  const read = (t) => t.handlers["cdb-wt:pref-read"](sender);
  const json = (dir) => JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));

  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true, "theme": "mario"}');
  const t = load(dir);
  const r0 = await read(t);
  ok(r0.opacity === 0.8 && r0.opacitySource === "default" && r0.opacityLocked === false && r0.opacityEnvForced === false,
     "pref-read reports opacity 0.8 from the default, unlocked: " + JSON.stringify(r0));

  // Not built yet (active null): set still saves, preview writes nothing.
  const p0 = await t.handlers["cdb-wt:opacity-preview"](sender, 0.5);
  ok(p0.ok && p0.live === 0, "preview before the window is transparent restyles nothing");
  ok(json(dir).windowOpacity === undefined, "preview does not write");
  const s0 = await t.handlers["cdb-wt:opacity-set"](sender, 0.55);
  const j0 = json(dir);
  ok(s0.ok && j0.windowOpacity === 0.55, "set writes windowOpacity to the .json");
  ok(j0.windowTransparency === true && j0.theme === "mario", "set preserves the other keys: " + JSON.stringify(j0));
  const r1 = await read(t);
  ok(r1.opacity === 0.55 && r1.opacitySource === "json", "pref-read reflects the saved opacity and its source");

  // Validation: non-numbers refused, out-of-range numbers clamped.
  for (const bad of ["0.5", NaN, Infinity, null, undefined, {}, true]) {
    const r = await t.handlers["cdb-wt:opacity-set"](sender, bad);
    ok(r.ok === false, "set refuses " + String(bad));
  }
  ok(json(dir).windowOpacity === 0.55, "a refused set leaves the file alone");
  const lo = await t.handlers["cdb-wt:opacity-set"](sender, 0.01);
  ok(lo.ok && lo.opacity === 0.1 && json(dir).windowOpacity === 0.1, "below 0.1 clamps to 0.1");
  const hi = await t.handlers["cdb-wt:opacity-set"](sender, 7);
  ok(hi.ok && hi.opacity === 1 && json(dir).windowOpacity === 1, "above 1 clamps to 1");
  const evil = { sender: { getURL: () => "https://evil.example", isDestroyed: () => false } };
  ok((await t.handlers["cdb-wt:opacity-set"](evil, 0.5)).ok === false, "set: foreign origin rejected");
  ok((await t.handlers["cdb-wt:opacity-preview"](evil, 0.5)).ok === false, "preview: foreign origin rejected");
  await t.handlers["cdb-wt:opacity-set"](sender, 0.8);

  // Live swap. Build the window transparent, style the main view, then move
  // the slider: every swap must insert the new alpha and remove the old key.
  const live = load(dir);
  live.sandbox.__cdbWinTransExtra();
  const mk = (url) => {
    const h = {}, sheets = new Map();
    let n = 0;
    const wc = { sheets, removed: [], on: (e, f) => { h[e] = f; }, once: (e, f) => { h[e] = f; },
      getURL: () => url, isDestroyed: () => false,
      insertCSS: (c) => { const k = "k" + (++n); sheets.set(k, c); return Promise.resolve(k); },
      removeInsertedCSS: (k) => { wc.removed.push(k); sheets.delete(k); return Promise.resolve(); },
      fire: (e) => h[e] && h[e]() };
    return wc;
  };
  const alphaOf = (css) => { const m = /--bg-200\) \/ ([\d.]+)\)/.exec(css); return m ? Number(m[1]) : null; };
  const view = mk("https://claude.ai/new");
  live.events["web-contents-created"](null, view);
  view.fire("dom-ready");
  await new Promise((r) => setTimeout(r, 10));
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.8, "dom-ready inserts the saved alpha");
  const first = [...view.sheets.keys()][0];

  const pv = await live.handlers["cdb-wt:opacity-preview"](sender, 0.4);
  ok(pv.ok && pv.live === 1, "preview restyles the one styled webContents: " + JSON.stringify(pv));
  ok(view.removed.includes(first), "the old stylesheet key is removed");
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.4, "and the new CSS carries alpha 0.4");
  ok(json(dir).windowOpacity === 0.8, "preview still does not write");

  // A burst of previews ends on the last value with exactly one sheet left.
  await Promise.all([0.3, 0.35, 0.45].map((a) => live.handlers["cdb-wt:opacity-preview"](sender, a)));
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.45,
     "a burst of previews leaves one sheet with the last alpha");

  const st = await live.handlers["cdb-wt:opacity-set"](sender, 0.65);
  ok(st.ok && st.live === 1 && json(dir).windowOpacity === 0.65, "set persists and applies live");
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.65, "the live sheet carries the saved alpha");

  // A navigation is a new document: a fresh insert replaces the stored key, and
  // the next swap removes THAT key.
  view.fire("dom-ready");
  await new Promise((r) => setTimeout(r, 10));
  const navKey = [...view.sheets.keys()].pop();
  await live.handlers["cdb-wt:opacity-preview"](sender, 0.9);
  ok(view.removed[view.removed.length - 1] === navKey, "after a navigation the swap removes the new document's key");

  // Destroyed webContents are dropped, not restyled.
  view.isDestroyed = () => true;
  view.fire("destroyed");
  const pd = await live.handlers["cdb-wt:opacity-preview"](sender, 0.5);
  ok(pd.ok && pd.live === 0, "a destroyed webContents is no longer restyled");

  // Locks: a .jsonc windowOpacity and CLAUDE_WINDOW_OPACITY both refuse.
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{\n  // mine\n  "windowOpacity": 0.7\n}');
  const jl = load(dir);
  const rj = await read(jl);
  ok(rj.opacity === 0.7 && rj.opacitySource === "jsonc-locked" && rj.opacityLocked === true && rj.opacityEnvForced === false,
     "pref-read reports the .jsonc lock: " + JSON.stringify(rj));
  const sj = await jl.handlers["cdb-wt:opacity-set"](sender, 0.3);
  ok(sj.ok === false && /claude-desktop-extra\.jsonc/.test(sj.error), "jsonc-locked refuses set: " + sj.error);
  ok((await jl.handlers["cdb-wt:opacity-preview"](sender, 0.3)).ok === false, "jsonc-locked refuses preview");
  ok(json(dir).windowOpacity === 0.65, "a refused set leaves the .json alone");
  const el = load(dir, { CLAUDE_WINDOW_OPACITY: "0.35" });
  const re = await read(el);
  ok(re.opacity === 0.35 && re.opacitySource === "env" && re.opacityEnvForced === true,
     "env wins over .jsonc and is reported: " + JSON.stringify(re));
  const se = await el.handlers["cdb-wt:opacity-set"](sender, 0.3);
  ok(se.ok === false && /CLAUDE_WINDOW_OPACITY/.test(se.error), "env-forced refuses set: " + se.error);
  const junk = load(dir, { CLAUDE_WINDOW_OPACITY: "abc" });
  const rk = await read(junk);
  ok(rk.opacitySource === "jsonc-locked" && rk.opacity === 0.7, "a non-numeric env value falls through to the files");
  rmSync(dir, { recursive: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
