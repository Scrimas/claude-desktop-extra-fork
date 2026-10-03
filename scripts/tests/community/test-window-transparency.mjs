#!/usr/bin/env node
/*
 * test-window-transparency.mjs - main-process half of the transparent window.
 * Runs the real js/window_transparency.js with electron shimmed and a temporary
 * profile dir: which keys win, native titlebar opt-out, the IPC pair, and which
 * claude.ai webContents get the see-through CSS (main window only).
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    const wc = { css: 0, on: (e, f) => { h[e] = f; }, getURL: () => url, isDestroyed: () => false,
      insertCSS: () => { wc.css++; return Promise.resolve(); }, fire: (e) => h[e] && h[e]() };
    return wc;
  };
  const view = (wc, children = []) => ({ webContents: wc, children });
  const win = (wc, contentView) => ({ isDestroyed: () => false, webContents: wc, contentView,
    setBackgroundColor() {}, setSize() {} });

  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const t = load(dir);
  t.sandbox.__cdbWinTransExtra();
  const created = (wc) => { t.events["web-contents-created"](null, wc); wc.fire("dom-ready"); return wc.css; };

  const mainView = fakeWc("https://claude.ai/new");
  const mainWin = win(fakeWc("file:///x/renderer/main_window/index.html"), view(null, [view(mainView)]));
  t.events["browser-window-created"](null, mainWin);
  const popWc = fakeWc("https://claude.ai/chat/1");
  const popWin = win(popWc, view(popWc));
  const codeWc = fakeWc("https://claude.ai/code");
  const codeWin = win(fakeWc("file:///x/other.html"), view(null, [view(null, [view(codeWc)])]));
  t.windows.push(mainWin, popWin, codeWin);

  ok(created(mainView) === 1, "main window's claude.ai child view gets the CSS");
  ok(created(popWc) === 0, "another window's own claude.ai webContents does not");
  ok(created(codeWc) === 0, "a claude.ai view nested in another window's contentView does not");
  ok(created(fakeWc("https://claude.ai/new")) === 1, "an unattached claude.ai webContents still gets it");
  rmSync(dir, { recursive: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
