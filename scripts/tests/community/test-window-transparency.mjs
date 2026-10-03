#!/usr/bin/env node
/*
 * test-window-transparency.mjs - main-process half of the transparent window.
 * Runs the real js/window_transparency.js with electron shimmed and a temporary
 * profile dir: which keys win, native titlebar opt-out, and the IPC pair.
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
  const handlers = {}, events = {};
  const electron = {
    app: { getPath: () => dir, on: (e, f) => { events[e] = f; } },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeTheme: { shouldUseDarkColors: true }
  };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env }, console, setTimeout, __cdbNativeTb: () => native };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, "js/window_transparency.js"), "utf8"), vm.createContext(sandbox));
  return { handlers, events, sandbox };
}
const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };

{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  let t = load(dir);
  ok(JSON.stringify(t.sandbox.__cdbWinTransExtra()) === "{}", "off by default: no extra options");
  const r0 = await t.handlers["cdb-wt:pref-read"](sender);
  ok(r0.ok && r0.enabled === false, "pref-read defaults to off");
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
