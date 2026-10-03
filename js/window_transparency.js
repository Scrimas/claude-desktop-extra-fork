/*
 * window_transparency.js - translucent main window, injected at the head of the
 * main bundle by patches/community/add_feature_window_transparency.nim.
 *
 * Two keys in <userData>/claude-desktop-extra.json(c):
 *   windowTransparency  bool    default false   (env CLAUDE_WINDOW_TRANSPARENCY=1|0)
 *   windowOpacity       number  default 0.8     (env CLAUDE_WINDOW_OPACITY=0.1..1)
 *
 * What it does when on:
 *   1. The main BrowserWindow is created with transparent:true and a fully
 *      transparent backgroundColor: the patched options literal spreads
 *      globalThis.__cdbWinTransExtra() in AFTER upstream's backgroundColor, so
 *      its keys win. Constructor-only options, so the switch needs an app
 *      RESTART - same as the titlebar modes.
 *   2. Upstream re-paints the window with opaque colours on every theme change
 *      (setBackgroundColor, and setTitleBarOverlay for the integrated
 *      titlebar). On the window we just built (caught by browser-window-created)
 *      the first becomes a no-op and the second has its colour forced to
 *      transparent, so a theme flip cannot bring the solid background back.
 *   3. A stylesheet is inserted into the window's own shell page and into its
 *      claude.ai view that clears the page background and gives the visible
 *      surfaces (sidebar, bg-surface-N) an alpha of windowOpacity. Blur behind
 *      the window is the COMPOSITOR's job (Hyprland decoration:blur, KWin
 *      "Blur" effect, ...) - the app only has to stop being opaque.
 *
 * Transparency needs a frameless window, so it is skipped (and logged) when the
 * native titlebar is in use (frame:true). Why the patch is a spread in the options
 * literal and not a wrapper around the window factory: patches/core/
 * fix_profile_window_title.nim and patches/linux/fix_window_bounds.nim anchor on
 * that factory's exact shape.
 *
 * Everything here is synchronous where the window needs it and never throws:
 * a broken config file means "feature off", never a window that fails to open.
 */
;/*__CDB_WINTRANS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") {
    globalThis.__cdbWinTransExtra = function () { return {}; };
    return;
  }
  if (globalThis.__cdbWinTrans) return;

  var _fs = require("fs");
  var _path = require("path");
  var _electron = require("electron");
  var _URL = require("url").URL;

  var KEY_ON = "windowTransparency";
  var KEY_ALPHA = "windowOpacity";
  var ALPHA_DEFAULT = 0.8;
  var ALPHA_MIN = 0.1;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";

  function log(m) { (globalThis.__cdbDiag || console.log)("[window-transparency] " + m); }

  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    try { return _path.join(_electron.app.getPath("userData"), name); } catch (e) { return null; }
  }
  // Same string-aware comment/trailing-comma stripper as the other pref readers.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var s = stripComments(_fs.readFileSync(p, "utf8"));
      var v = s.trim() ? JSON.parse(s) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  // .jsonc (hand-owned) wins over .json (written by the Settings switch).
  function readKey(key, type) {
    var files = [JSONC_NAME, JSON_NAME];
    for (var i = 0; i < files.length; i++) {
      var cfg = readFileJson(pathFor(files[i]));
      if (cfg && typeof cfg[key] === type) {
        return { value: cfg[key], source: i === 0 ? "jsonc-locked" : "json" };
      }
    }
    return { value: undefined, source: "default" };
  }

  function envOn() {
    var raw;
    try { raw = process.env.CLAUDE_WINDOW_TRANSPARENCY; } catch (e) { return null; }
    if (raw === undefined || raw === null || raw === "") return null;
    return raw === "1";
  }
  function clampAlpha(n) {
    if (typeof n !== "number" || !isFinite(n)) return ALPHA_DEFAULT;
    return Math.min(1, Math.max(ALPHA_MIN, n));
  }
  function alpha() {
    var raw;
    try { raw = process.env.CLAUDE_WINDOW_OPACITY; } catch (e) { raw = undefined; }
    if (raw !== undefined && raw !== "" && isFinite(parseFloat(raw))) return clampAlpha(parseFloat(raw));
    return clampAlpha(readKey(KEY_ALPHA, "number").value);
  }
  function savedOn() { return readKey(KEY_ON, "boolean").value === true; }

  // Memoized for the life of the process: the window was built with this
  // answer, and the Settings row compares it against the saved value to know
  // whether a restart is pending. null = nothing asked yet.
  var active = null;
  function wanted() {
    if (active !== null) return active;
    var forced = envOn();
    var on = forced === null ? savedOn() : forced;
    return on === true;
  }

  // Mirrors the native-titlebar decision of patches/linux/fix_native_frame.nim
  // (same defensive form: the config reader if present, else the env var).
  function nativeTitlebar() {
    try {
      if (globalThis.__cdbNativeTb) return !!globalThis.__cdbNativeTb();
      return process.env.CLAUDE_NATIVE_TITLEBAR === "1";
    } catch (e) { return false; }
  }

  // Spread into the MAIN window's options literal, after upstream's own keys.
  var pendingMain = false;
  var mainWin = null;
  globalThis.__cdbWinTransExtra = function () {
    try {
      if (active !== null) return active ? { transparent: true, backgroundColor: "#00000000" } : {};
      var on = wanted();
      if (on && nativeTitlebar()) {
        // frame:true; Electron cannot make a framed window translucent.
        log("native titlebar in use - transparency skipped (it needs a frameless window)");
        on = false;
      }
      active = on;
      if (!on) return {};
      pendingMain = true;
      log("main window built transparent (opacity " + alpha() + ")");
      return { transparent: true, backgroundColor: "#00000000" };
    } catch (e) {
      log("options hook failed: " + ((e && e.message) || e));
      return {};
    }
  };

  // Fires synchronously inside the BrowserWindow constructor; pendingMain says
  // which window that is.
  _electron.app.on("browser-window-created", function (_ev, win) {
    try {
      if (!pendingMain) return;
      pendingMain = false;
      mainWin = win;
      win.setBackgroundColor = function () {};
      // patches/linux/fix_window_bounds.nim "jiggles" the window on
      // ready-to-show: setSize(w+1,h+1), then 50 ms later setSize(w,h) with the
      // size captured BEFORE the jiggle. On a tiling compositor the window has
      // been placed into its tile by then (1810x1020 inside the bar/gap
      // reservation), so that second call forces it back to the pre-tile size
      // (1920x1080). On a transparent window Chromium keeps rendering at that
      // size while the compositor shows the tile, so the bottom and right edges
      // are cut off - the page looks fine for a few frames, then cropped, until
      // the compositor sends another size. Drop setSize for the first seconds;
      // the initial size comes from the constructor options, not from here.
      var realSetSize = win.setSize;
      win.setSize = function () {};
      setTimeout(function () { try { win.setSize = realSetSize; } catch (e) {} }, 4000);
      var orig = win.setTitleBarOverlay;
      if (typeof orig === "function") {
        win.setTitleBarOverlay = function (o) {
          if (o && typeof o === "object") {
            var t = {};
            for (var k in o) t[k] = o[k];
            t.color = "#00000000";
            o = t;
          }
          return orig.call(win, o);
        };
        // The constructor already got upstream's opaque overlay colour; replace it
        // now. Bare mode has no overlay and setTitleBarOverlay throws there.
        try {
          orig.call(win, {
            color: "#00000000",
            symbolColor: _electron.nativeTheme.shouldUseDarkColors ? "#fff" : "#000",
            height: 36
          });
        } catch (e0) {}
      }
    } catch (e) { log("window hook failed: " + ((e && e.message) || e)); }
  });

  // ---- CSS -----------------------------------------------------------------
  // Tokens are the CDS/claude.ai ones also used by add_feature_custom_themes:
  // --bg-000/100/200 are "H S% L%" triplets, so hsl(var(--bg-N) / A) keeps the
  // active theme's colour and only lowers its alpha. `html` is prepended to
  // every selector to out-rank a custom theme's own !important rules.
  function buildCss(a) {
    var A = String(Math.round(a * 1000) / 1000);
    var P = String(Math.round(a * 100)) + "%";
    var FADE = String(Math.round(a * 50) / 100);
    function mix(v) { return "color-mix(in srgb,var(" + v + ") " + P + ",transparent)"; }
    // Only ONE layer may carry the alpha at any point of the screen: stacked
    // translucent layers multiply (0.6 over 0.6 is 0.84). So the outer wrappers
    // (page, root, frame, content column) go fully clear and the visible
    // PAGE-level surfaces take the alpha: the sidebar, bg-surface-0/1 and bg-page
    // (the page colour that sticky headers and the composer dock use to hide
    // scrolled content - hiding is exactly what a translucent window cannot do,
    // so those fade instead of masking). Surfaces are re-derived from upstream's
    // own --cds-* tokens with color-mix, so a custom theme's colours are kept.
    // bg-surface-2/3 are the CARD level - menus, popovers, the prompt box - and
    // stay solid so they read against whatever is behind the window.
    return "" +
      "html,html body,html #root,html [id=root],html .dframe-root,html .dframe-content,html .dframe-main,html main.dframe-main{background:transparent!important}" +
      "html .dframe-sidebar{background-color:hsl(var(--bg-200) / " + A + ")!important}" +
      "html .bg-surface-0{background-color:" + mix("--cds-surface-0") + "!important}" +
      "html .bg-surface-1{background-color:" + mix("--cds-surface-1") + "!important}" +
      "html .bg-page,html [data-cds-dock-masked] .in-data-cds-dock-masked\\:bg-page{background-color:" + mix("--cds-page-bg") + "!important}" +
      "html .bg-surface-2{background-color:var(--cds-surface-2)!important}" +
      // Claude Code's whole content area is ONE rounded-card on surface-2, whose
      // warm gray (#1a1a19) reads as a tint next to the neutral surface-1 the
      // rest of the app uses. It is a page-level panel, not a card to read on,
      // so it takes surface-1 at the window alpha like everything else.
      "html .bg-surface-2.rounded-card{background-color:" + mix("--cds-surface-1") + "!important}" +
      "html .bg-surface-3,html .bg-surface-popover{background-color:var(--cds-surface-3)!important}" +
      "html [role=menu],html [role=listbox]{background-color:var(--cds-surface-3)!important}" +
      "html [class*=approval-dock]{background:transparent!important}" +
      "html .sticky.bottom-0.pointer-events-none[class*=\"bg-[var(--epitaxy-transcript-surface\"]{background-color:" + mix("--cds-surface-1") + "!important}" +
      "html .scroll-fade-strip-top,html .scroll-fade-strip-bottom,html .page-fade-t,html .page-fade-b{opacity:" + FADE + "!important}";
  }
  // The window's own shell page (title bar / boot placeholder / error UI).
  // The shell page also paints a "boot placeholder" (sidebar row shapes) that
  // an opaque claude.ai view normally covers; with a see-through view on top it
  // shows through as ghost rectangles behind the sidebar, so hide it. The drag
  // strip is left alone - it is the window's drag region.
  var SHELL_CSS = "html,html body{background:transparent!important}" +
    "html #boot-placeholder-sidebar,html #boot-placeholder-sidebar-rows,html [class*=boot-placeholder-seam],html [class*=boot-placeholder-frame],html [class*=boot-placeholder-row]{display:none!important}";

  var ALLOWED_ORIGINS = [
    "https://claude.ai", "https://preview.claude.ai",
    "https://claude.com", "https://preview.claude.com"
  ];
  function originAllowed(rawUrl) {
    try { return ALLOWED_ORIGINS.indexOf(new _URL(String(rawUrl)).origin) !== -1; } catch (e) { return false; }
  }
  function isShell(rawUrl) {
    return /^file:\/\/.*\/renderer\/main_window\//.test(String(rawUrl));
  }

  // Only the main window is see-through. Pop-outs, the Code and Design windows,
  // artifact pop-ups and the 3P config window load claude.ai in BrowserWindows
  // of their own with an opaque background, so a claude.ai webContents that
  // another live window provably owns - as its own webContents or as a view in
  // its contentView tree - is left alone. Unclaimed (not attached yet, or the
  // main window's own view), no main window to tell apart, or any error: the
  // CSS goes in as before, so the main window never loses it here.
  function viewHolds(view, wc) {
    if (!view) return false;
    if (view.webContents === wc) return true;
    var kids = view.children || [];
    for (var i = 0; i < kids.length; i++) if (viewHolds(kids[i], wc)) return true;
    return false;
  }
  function otherWindowOwns(wc) {
    try {
      if (!mainWin || mainWin.isDestroyed()) return false;
      var wins = _electron.BrowserWindow.getAllWindows();
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (!w || w === mainWin || w.isDestroyed()) continue;
        if (w.webContents === wc || viewHolds(w.contentView, wc)) return true;
      }
    } catch (e) {}
    return false;
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        if (active !== true) return;
        var url = wc.getURL() || "";
        if (originAllowed(url)) {
          if (!otherWindowOwns(wc)) wc.insertCSS(buildCss(alpha())).catch(function () {});
        } else if (isShell(url)) wc.insertCSS(SHELL_CSS).catch(function () {});
      } catch (e) {}
    });
  });

  // ---- Settings -> Extra row (IPC) -------------------------------------------
  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      return !(ev.senderFrame && ev.senderFrame.parent);
    } catch (e) { return false; }
  }

  // Writes ONLY the .json, tmp + rename, every other key preserved; refuses to
  // touch a file it cannot parse instead of discarding the user's other settings.
  function writeOn(value) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || e) };
    }
    var cfg = {};
    if (raw !== null) {
      var s = stripComments(raw);
      try { cfg = s.trim() ? JSON.parse(s) : {}; }
      catch (e2) { return { ok: false, error: p + " is not valid JSON (" + e2.message + ") - nothing was written" }; }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (s !== raw) { try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {} }
    }
    if (value === false) delete cfg[KEY_ON]; else cfg[KEY_ON] = true;
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || e4) };
    }
    return { ok: true, path: p };
  }

  var ipc = _electron.ipcMain;
  ipc.handle("cdb-wt:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var disk = readKey(KEY_ON, "boolean");
    var env = envOn();
    return {
      ok: true,
      enabled: disk.value === true,
      active: active,
      opacity: alpha(),
      lockedByJsonc: disk.source === "jsonc-locked",
      source: disk.source,
      envForced: env !== null,
      nativeTitlebar: nativeTitlebar()
    };
  });
  ipc.handle("cdb-wt:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    if (readKey(KEY_ON, "boolean").source === "jsonc-locked") {
      return { ok: false, error: KEY_ON + " is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    var w = writeOn(enabled);
    if (!w.ok) return w;
    log("pref " + KEY_ON + " set to " + enabled + " (" + w.path + ") - takes effect on restart");
    return { ok: true, enabled: enabled, path: w.path };
  });

  globalThis.__cdbWinTrans = true;
  // __cdbDiag does not exist yet at injection time; defer one tick.
  setTimeout(function () {
    log("installed; saved=" + savedOn() + ", opacity=" + alpha() +
      (envOn() !== null ? ", CLAUDE_WINDOW_TRANSPARENCY forces " + envOn() : ""));
  }, 0);
})();
