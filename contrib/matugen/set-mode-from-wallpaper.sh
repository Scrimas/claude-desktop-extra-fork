#!/usr/bin/env bash
# set-mode-from-wallpaper.sh <wallpaper> - the wallpaper post-change command of the matugen recipe
# (docs/themes.md, "matugen (official recipe)"): light/dark follows the wallpaper.
#
# Measures the wallpaper's mean luma with ImageMagick, picks "light" above the threshold
# (0.6, override with CDB_MODE_THRESHOLD; biased toward dark, a bright sky over dark ground still counts as dark) and "dark" below, runs matugen in that mode with the
# scheme-fidelity type (CDB_MATUGEN_SCHEME overrides), and
# sets the desktop-wide color-scheme preference so Claude Desktop's Appearance = System follows:
#   - gsettings org.gnome.desktop.interface color-scheme (xdg-desktop-portal-gtk) and
#     org.x.apps.portal color-scheme (xdg-desktop-portal-xapp: XFCE, Cinnamon, MATE) - the portal
#     answer Chromium/Electron, i.e. Claude Desktop, reads -> prefer-light / prefer-dark
#   - XFCE only: xfconf /Net/ThemeName adw-gtk3 <-> adw-gtk3-dark (when one of those two stock
#     themes is active) and /Gtk/ApplicationPreferDarkTheme
#
# Wiring: make this your wallpaper tool's post-change command (Variety:
# ~/.config/variety/scripts/set_wallpaper, replacing `matugen image "$WP" -m dark -q`):
#     ~/.config/matugen/set-mode-from-wallpaper.sh "$WP"
# and set Claude Desktop Settings -> Appearance -> System. If you do not want the desktop-wide
# preference changed, keep a fixed-mode `matugen image "$WP" -m dark -q` line instead.
# To keep the wallpaper-derived colors but never leave dark (or light) mode, pin it:
#     CDB_MODE=dark ~/.config/matugen/set-mode-from-wallpaper.sh "$WP"
# CDB_MODE=auto (default) follows the wallpaper luma; dark|light skips the measurement.
# Needs: matugen, imagemagick (magick).
set -u

wp="${1:-}"
if [ -z "$wp" ] || [ ! -r "$wp" ]; then
  echo "usage: $0 <wallpaper>" >&2
  exit 2
fi
threshold="${CDB_MODE_THRESHOLD:-0.6}"
pin="${CDB_MODE:-auto}"
case "$pin" in
  auto|dark|light) ;;
  *) echo "set-mode-from-wallpaper: CDB_MODE must be auto, dark or light (got '$pin')" >&2; exit 2 ;;
esac

# matugen decodes raster formats only; rasterize anything else (SVG, ...) to a temp PNG.
case "${wp,,}" in
  *.jpg|*.jpeg|*.png|*.webp|*.bmp|*.gif|*.tif|*.tiff) ;;
  *)
    tmp="$(mktemp --suffix=.png)"
    if magick "$wp" -resize '1600x1600>' "$tmp" 2>/dev/null; then wp="$tmp"; trap 'rm -f "$tmp"' EXIT
    else rm -f "$tmp"; echo "set-mode-from-wallpaper: cannot rasterize $wp" >&2; exit 1; fi
    ;;
esac

if [ "$pin" = auto ]; then
  luma="$(magick "$wp" -resize '1x1!' -colorspace gray -format '%[fx:mean]' info: 2>/dev/null)"
  if [ -z "$luma" ]; then
    echo "set-mode-from-wallpaper: could not measure $wp (is imagemagick installed?)" >&2
    exit 1
  fi
  if awk -v l="$luma" -v t="$threshold" 'BEGIN { exit !(l > t) }'; then mode=light; else mode=dark; fi
  echo "set-mode-from-wallpaper: luma=$luma threshold=$threshold -> $mode"
else
  mode="$pin"
  echo "set-mode-from-wallpaper: CDB_MODE=$pin -> $mode"
fi

# scheme-fidelity keeps the wallpaper's own chroma: a grey wallpaper gives grey-blue surfaces,
# a colorful one stays colorful. matugen's default (scheme-tonal-spot) forces a fixed high
# chroma, which turns near-grey wallpapers into saturated blue. Override with CDB_MATUGEN_SCHEME.
scheme="${CDB_MATUGEN_SCHEME:-scheme-fidelity}"

# Pale wallpapers in dark mode: fidelity/content give primary_container the source color's own
# (high) tone, so the container comes out light (#cbe6fa from a pale sky) and primary/tertiary
# are pushed to #ffffff to keep contrast - no accent left. Measured: normal wallpapers stay at
# container lightness <= 0.65, pale ones hit 0.87+. Above CDB_PASTEL_LIMIT (0.75) fall back to
# scheme-tonal-spot, which pins dark-mode tones (container ~0.2, primary a real pastel accent).
# Only when the scheme was not chosen explicitly; needs python3, skipped without it.
if [ "$mode" = dark ] && [ -z "${CDB_MATUGEN_SCHEME:-}" ] && command -v python3 >/dev/null 2>&1; then
  pc_l="$(matugen image "$wp" -m dark -t "$scheme" --dry-run -j hex -q 2>/dev/null | python3 -c '
import colorsys, json, sys
h = json.load(sys.stdin)["colors"]["primary_container"]["dark"]["color"].lstrip("#")
print(round(colorsys.rgb_to_hls(*(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))[1], 3))' 2>/dev/null)"
  if [ -n "$pc_l" ] && awk -v l="$pc_l" -v t="${CDB_PASTEL_LIMIT:-0.75}" 'BEGIN { exit !(l > t) }'; then
    echo "set-mode-from-wallpaper: pale source (primary_container lightness $pc_l) -> scheme-tonal-spot"
    scheme=scheme-tonal-spot
  fi
fi
matugen image "$wp" -m "$mode" -t "$scheme" -q

if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$mode" 2>/dev/null || true
  # XFCE, Cinnamon and MATE route the Settings portal through xdg-desktop-portal-xapp, which
  # answers color-scheme from its own key (the GNOME key above is ignored there).
  gsettings set org.x.apps.portal color-scheme "prefer-$mode" 2>/dev/null || true
fi

if command -v xfconf-query >/dev/null 2>&1 && [ -n "${XDG_CURRENT_DESKTOP:-}" ] && [[ "$XDG_CURRENT_DESKTOP" == *XFCE* ]]; then
  # Only the stock adw-gtk3 names are flipped here. A custom wrapper theme (one that
  # imports adw-gtk3 plus a generated colors.css) is left alone: switch it from your
  # matugen post_hook instead, where {{mode}} is available.
  current="$(xfconf-query -c xsettings -p /Net/ThemeName 2>/dev/null || true)"
  case "$current" in
    adw-gtk3|adw-gtk3-dark)
      if [ "$mode" = dark ]; then want=adw-gtk3-dark; else want=adw-gtk3; fi
      [ "$current" = "$want" ] || xfconf-query -c xsettings -p /Net/ThemeName -s "$want"
      ;;
  esac
  if [ "$mode" = dark ]; then dark=true; else dark=false; fi
  xfconf-query -c xsettings -p /Gtk/ApplicationPreferDarkTheme -t bool -s "$dark" --create
fi
