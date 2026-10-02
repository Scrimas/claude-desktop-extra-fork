# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Left-click on the tray icon shows the app on Linux.
#
# Upstream (2.9939.4, tray setup in an index chunk) builds the tray with only a
# tooltip and a context menu:
#
#   Y9=new a.Tray(a.nativeImage.createFromPath(r)),Y9.setToolTip(...),...,
#   Y9.setContextMenu(Z9)
#
# and never attaches a `click` listener. On macOS/Windows the OS opens the
# context menu on click, so nothing is lost there. On Linux, Electron's tray is
# a StatusNotifierItem: the tray host (KDE Plasma, waybar, Quickshell, ...)
# calls the item's Activate method on left-click, Electron turns that into the
# Tray `click` event, and with no listener the click is dropped. The only way
# back into a hidden window is right-click -> "Show App".
#
# We register the "Show App" menu item's own click handler (upstream's
# restore/focus/show routine, `UJ` in 2.9939.4) as the tray's `click` listener,
# right after the Tray is constructed:
#
#   Y9=new a.Tray(...),/*__cdb_tray_click_v1__*/process.platform==="linux"&&
#     Y9.on("click",()=>{UJ()}),Y9.setToolTip(...)
#
# Both names are captured from the bundle, never hardcoded: the tray variable
# from the constructor site, the handler from the "Show App" item (anchored on
# its stable i18n message, not its minified name). The menu builder and the
# tray setup live in the same chunk, so the handler is in scope.
#
# Hosts that open the menu on left-click instead of calling Activate (an item
# with ItemIsMenu=true, which Electron does not set) are unaffected.
#
# Idempotency: the injected listener (marker + `.on("click"` + the captured
# handler) is present exactly once -> already applied.

import std/[os, strformat, strutils]
import regex

const MARKER = "/*__cdb_tray_click_v1__*/"
const EXPECTED_PATCHES = 1

# "Show App" item of the tray context menu: `{label:X().formatMessage(
# {defaultMessage:"Show App",id:"..."}),click:UJ}`. Group 0 = handler name.
let showAppRe = re2(
  """\{label:[\w$]+\(\)\.formatMessage\(\{defaultMessage:["`]Show App["`],id:["`][^"`]+["`]\}\),click:([\w$]+)\}"""
)
# Tray construction inside the comma expression of the tray-update function:
# `Y9=new a.Tray(a.nativeImage.createFromPath(r)),`. Group 0 = tray variable.
let trayRe = re2(
  """([\w$]+)=new [\w$]+\.Tray\([\w$]+\.nativeImage\.createFromPath\([\w$]+\)\),"""
)
let doneRe = re2(
  """([\w$]+)=new [\w$]+\.Tray\([\w$]+\.nativeImage\.createFromPath\([\w$]+\)\),/\*__cdb_tray_click_v1__\*/process\.platform==="linux"&&([\w$]+)\.on\("click",\(\)=>\{[\w$]+\(\)\}\),"""
)

proc allMatches(s: string, r: Regex2): seq[RegexMatch2] =
  for m in findAll(s, r):
    result.add m

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let done = allMatches(input, doneRe)
  if done.len == 1:
    if input[done[0].group(0)] != input[done[0].group(1)]:
      raise newException(
        ValueError, "fix_tray_left_click: injected listener is on a different variable"
      )
    echo "  [OK] tray left-click listener already present (idempotent)"
    return input
  if done.len > 1:
    raise newException(
      ValueError, &"fix_tray_left_click: injected listener duplicated ({done.len})"
    )
  if input.find(MARKER) >= 0:
    raise newException(
      ValueError,
      "fix_tray_left_click: marker present but listener shape not found - re-extract a pristine bundle",
    )

  let showMs = allMatches(input, showAppRe)
  if showMs.len != 1:
    echo &"  [FAIL] tray menu \"Show App\" item: {showMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_left_click: Show App anchor moved")
  let trayMs = allMatches(input, trayRe)
  if trayMs.len != 1:
    echo &"  [FAIL] `<v>=new <ns>.Tray(<ns>.nativeImage.createFromPath(<p>)),`: {trayMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_left_click: Tray constructor anchor moved")

  let showFn = input[showMs[0].group(0)]
  let trayVar = input[trayMs[0].group(0)]
  let at = trayMs[0].boundaries.b + 1
  let inj =
    MARKER & "process.platform===\"linux\"&&" & trayVar & ".on(\"click\",()=>{" & showFn &
    "()}),"
  result = result[0 ..< at] & inj & result[at .. ^1]
  echo &"  [OK] tray left-click -> Show App handler (tray {trayVar}, handler {showFn})"
  inc patchesApplied

  # Positive end-state: the injected listener is present exactly once.
  if allMatches(result, doneRe).len != 1:
    echo "  [FAIL] injected listener not found in output"
    raise newException(ValueError, "fix_tray_left_click: end-state assertion failed")

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    raise newException(ValueError, "fix_tray_left_click: incomplete")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_tray_left_click <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_tray_left_click ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Tray left-click listener injected"
  else:
    echo "  [PASS] No changes needed (already applied)"
