#!/usr/bin/env bash
# Renders the README's illustration of Proton Drive in GNOME Files (docs/images/files.png) from
# docs/images/src/files.html, which uses only made-up files (#521). It is an illustration, not a screenshot: a real
# drive's file names don't belong in a README.
#
# Needs Google Chrome (or Chromium: CHROME=chromium) and the Yaru and Adwaita icon themes, which the page loads from
# /usr/share/icons. Chrome runs headless with a throwaway profile, so your own browser profile is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || true)}"
SRC="$ROOT/docs/images/src/files.html"
OUT="$ROOT/docs/images/files.png"

[[ -n "$CHROME" ]] || { echo "files-illustration: no Chrome or Chromium (set CHROME=/path/to/chrome)" >&2; exit 1; }
[[ -d /usr/share/icons/Yaru && -d /usr/share/icons/Adwaita ]] || { echo "files-illustration: needs the Yaru and Adwaita icon themes" >&2; exit 1; }

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

timeout 60 "$CHROME" --headless=new --user-data-dir="$PROFILE" --no-first-run --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --window-size=1280,480 --screenshot="$OUT" "file://$SRC" >/dev/null 2>&1
[[ -s "$OUT" ]] || { echo "files-illustration: Chrome wrote no image" >&2; exit 1; }
echo "wrote docs/images/files.png"
