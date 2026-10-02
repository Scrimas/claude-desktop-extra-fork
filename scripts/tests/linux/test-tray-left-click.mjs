#!/usr/bin/env node
// Tray icon: left-click shows the app on Linux.
//
// WHY THIS EXISTS
// ---------------
// Upstream builds the tray with a tooltip and a context menu but never listens
// for `click`. On Linux the tray host calls the StatusNotifierItem's Activate
// method on left-click, which Electron reports as the Tray `click` event; with
// no listener the click is dropped and the window is only reachable through
// right-click -> "Show App".
//
// patches/linux/fix_tray_left_click.nim registers the "Show App" item's own
// handler as the tray's `click` listener. This harness runs the compiled patch
// on the upstream shapes (copied from the 2.9939.4 bundle), then drives the
// patched tray setup with a mock Electron and fires `click`.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_tray_left_click");
const SKIP_EXIT = 3;

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
    return;
  }
  console.log(
    `  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  );
  failures.push(label);
}
const section = (t) => console.log("\n" + t);

// Upstream shapes from 2.9939.4, trimmed; the two anchors are verbatim:
//   1. the tray menu's "Show App" item and its click handler UJ
//   2. `Y9=new a.Tray(a.nativeImage.createFromPath(r)),` in the tray setup
const FIXTURE = `"use strict";
var jo=null,Y9=null,X9=null,Z9=null;function X(){return{formatMessage:m=>m.defaultMessage}}function zo(){__ev.push("zo")}
function UJ(){let e=jo;!e||e.isDestroyed()||(e.isMinimized()?(e.restore(),e.focus()):e.isVisible()?e.focus():(zo(),e.show()))}
function G$r(){return[{label:X().formatMessage({defaultMessage:"Show App",id:"DQTgg21B7g"}),click:UJ},{label:X().formatMessage({defaultMessage:"Quit",id:"x"}),click:()=>{}}]}
function I7i(){let r="TrayIconLinux-Dark.png";Y9=new a.Tray(a.nativeImage.createFromPath(r)),Y9.setToolTip(a.app.getName()),X9=r,Z9=G$r(),Y9.setContextMenu(Z9)}
`;

function runPatch(file) {
  try {
    const out = execFileSync(PATCH_BIN, [file], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, out };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

// Load the (patched) fixture with a mock Electron, build the tray, and return
// the tray plus the event log. `win` describes the main window's state.
function boot(src, platform, win) {
  const ev = [];
  const handlers = {};
  class Tray {
    constructor() { this.menu = null; }
    on(n, f) { (handlers[n] ||= []).push(f); return this; }
    setToolTip() {}
    setContextMenu(m) { this.menu = m; }
    emit(n, ...args) { for (const f of handlers[n] || []) f(...args); }
    listenerCount(n) { return (handlers[n] || []).length; }
  }
  const w = {
    visible: win.visible,
    minimized: win.minimized,
    isDestroyed: () => false,
    isMinimized: () => w.minimized,
    isVisible: () => w.visible,
    restore: () => { w.minimized = false; ev.push("restore"); },
    focus: () => ev.push("focus"),
    show: () => { w.visible = true; ev.push("show"); },
  };
  const sandbox = {
    __ev: ev,
    process: { platform },
    a: { Tray, nativeImage: { createFromPath: (p) => p }, app: { getName: () => "Claude" } },
  };
  // The fixture is strict, so every global it assigns must already exist.
  Object.assign(sandbox, { __w: w, __tray: null });
  vm.runInNewContext(src + "\n;jo=__w;I7i();__tray=Y9;", vm.createContext(sandbox));
  return { tray: sandbox.__tray, ev, w };
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-tray-click-"));
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    "SKIP: patches/linux/fix_tray_left_click is not compiled " +
      "(run: make -C patches linux/fix_tray_left_click)"
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(SKIP_EXIT);
}

try {
  section("[A0] the compiled patch applies to the upstream shapes");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("captured names reported", /tray Y9, handler UJ/.test(r1.out), true);
  const patched = readFileSync(file, "utf8");
  check("patched output changed", patched !== FIXTURE, true);
  execFileSync("node", ["--check", file]);
  check("patched fixture passes node --check", true, true);

  section("[A1] idempotency: a second run changes nothing and exits 0");
  const r2 = runPatch(file);
  check("second run exits 0", r2.status, 0);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8"), patched);

  section("[A2] a moved anchor fails loud");
  {
    const moved = join(scratch, "moved.js");
    writeFileSync(moved, FIXTURE.replace('defaultMessage:"Show App"', 'defaultMessage:"Open"'));
    const r = runPatch(moved);
    check("missing Show App item exits non-zero", r.status !== 0, true);
    check("missing Show App item prints [FAIL]", /\[FAIL\]/.test(r.out), true);
  }
  {
    const half = join(scratch, "half.js");
    writeFileSync(half, FIXTURE + "/*__cdb_tray_click_v1__*/");
    const r = runPatch(half);
    check("stray marker without listener exits non-zero", r.status !== 0, true);
  }

  section("[B0] unpatched upstream: left-click does nothing");
  {
    const { tray, ev } = boot(FIXTURE, "linux", { visible: false, minimized: false });
    check("no click listener", tray.listenerCount("click"), 0);
    tray.emit("click");
    check("hidden window stays hidden", ev.join(","), "");
  }

  section("[B1] patched, Linux: left-click runs the Show App handler");
  {
    const { tray, ev, w } = boot(patched, "linux", { visible: false, minimized: false });
    check("one click listener", tray.listenerCount("click"), 1);
    tray.emit("click", {}, { x: 0, y: 0, width: 0, height: 0 });
    check("hidden window is shown", ev.join(","), "zo,show");
    check("window visible", w.visible, true);
  }
  {
    const { tray, ev } = boot(patched, "linux", { visible: true, minimized: true });
    tray.emit("click");
    check("minimized window is restored and focused", ev.join(","), "restore,focus");
  }
  {
    const { tray, ev } = boot(patched, "linux", { visible: true, minimized: false });
    tray.emit("click");
    check("visible window is focused", ev.join(","), "focus");
  }
  {
    const { tray } = boot(patched, "linux", { visible: false, minimized: false });
    check("context menu still set", Array.isArray(tray.menu) && tray.menu[0].label, "Show App");
  }

  section("[B2] patched, other platforms: no listener");
  {
    const { tray } = boot(patched, "darwin", { visible: false, minimized: false });
    check("darwin: no click listener", tray.listenerCount("click"), 0);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
