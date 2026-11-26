#!/usr/bin/env bash
# Regenerates the README's screenshots (docs/images/*.png) from made-up data (#520).
#
#   scripts/readme-screenshots.sh [path/to/protondrive-gui]
#
# Default binary: native-gui/target/release/protondrive-gui. It starts scripts/demo-daemon.ts on a free port and runs
# the app once per page against it, in a throwaway home, so nothing of the real account, folders or daemon is read:
#   * PROTON_DRIVE_DAEMON_PORT points the app's TCP API at the demo daemon (never 49152);
#   * HOME and every XDG_* folder, TMPDIR and XDG_RUNTIME_DIR are inside a fresh temp dir, so the control socket the
#     app would look for ($XDG_RUNTIME_DIR/protondrive/control.sock) is not the real one (and --screenshot never
#     calls it anyway); the rest of the environment is dropped;
#   * only the display variables are kept, so the window can open.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUI="${1:-$ROOT/native-gui/target/release/protondrive-gui}"
OUT="$ROOT/docs/images"
SIZE="${SCREENSHOT_SIZE:-1280x800}"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

[[ -x "$GUI" ]] || { echo "readme-screenshots: no GUI binary at $GUI (build it: cargo build --release in native-gui/)" >&2; exit 1; }
[[ -x "$BUN" ]] || { echo "readme-screenshots: bun not found (set BUN=/path/to/bun)" >&2; exit 1; }
[[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || { echo "readme-screenshots: no display (DISPLAY or WAYLAND_DISPLAY)" >&2; exit 1; }

REAL_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
TMP="$(mktemp -d)"
DEMO_PID=""
cleanup() {
    if [[ -n "$DEMO_PID" ]]; then kill "$DEMO_PID" 2>/dev/null || true; wait "$DEMO_PID" 2>/dev/null || true; fi
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/home" "$TMP/config" "$TMP/data" "$TMP/cache" "$TMP/run" "$OUT"
chmod 700 "$TMP/run"

# Start the demo daemon on a free port (0) and read the port it prints
"$BUN" "$ROOT/scripts/demo-daemon.ts" 0 >"$TMP/demo.out" 2>"$TMP/demo.err" &
DEMO_PID=$!
PORT=""
for _ in $(seq 1 100); do
    PORT="$(sed -n 's/^demo-daemon listening on 127\.0\.0\.1:\([0-9]*\)$/\1/p' "$TMP/demo.out" 2>/dev/null | head -n1)"
    [[ -n "$PORT" ]] && break
    kill -0 "$DEMO_PID" 2>/dev/null || { cat "$TMP/demo.err" >&2; echo "readme-screenshots: the demo daemon stopped" >&2; exit 1; }
    sleep 0.1
done
[[ -n "$PORT" && "$PORT" != 49152 ]] || { echo "readme-screenshots: the demo daemon gave no usable port" >&2; exit 1; }

# shot NAME THEME GUI-FLAGS...: one PNG, in the isolated environment
shot() {
    local name="$1" theme="$2"
    shift 2
    # Only the display variables that are set; a relative WAYLAND_DISPLAY is looked up in XDG_RUNTIME_DIR, which is
    # the temp dir here, so it is made absolute from the real one first (Wayland accepts an absolute path)
    local vars=(
        PATH=/usr/bin:/bin
        HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" XDG_CACHE_HOME="$TMP/cache"
        XDG_RUNTIME_DIR="$TMP/run" TMPDIR="$TMP/run"
        PROTON_DRIVE_DAEMON_PORT="$PORT"
    )
    [[ -n "${DISPLAY:-}" ]] && vars+=(DISPLAY="$DISPLAY")
    [[ -n "${XAUTHORITY:-}" ]] && vars+=(XAUTHORITY="$XAUTHORITY")
    if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
        if [[ "$WAYLAND_DISPLAY" == /* ]]; then
            vars+=(WAYLAND_DISPLAY="$WAYLAND_DISPLAY")
        else
            vars+=(WAYLAND_DISPLAY="$REAL_RUNTIME_DIR/$WAYLAND_DISPLAY")
        fi
    fi
    env -i "${vars[@]}" \
        timeout 60 "$GUI" --screenshot "$OUT/$name.png" --size "$SIZE" --theme "$theme" "$@"
    shrink "$OUT/$name.png"
    echo "wrote docs/images/$name.png"
}

# Makes a PNG smaller when a tool for it is there: optipng, pngquant, or python3 with Pillow (a PNG over 300 KB only)
shrink() {
    local png="$1"
    if command -v pngquant >/dev/null 2>&1; then
        pngquant --force --skip-if-larger --output "$png" -- "$png" || true
    elif command -v optipng >/dev/null 2>&1; then
        optipng -quiet "$png" || true
    elif [[ "$(stat -c %s "$png")" -gt 300000 ]]; then
        python3 -c 'import sys; from PIL import Image; p = sys.argv[1]; Image.open(p).convert("RGB").quantize(256, dither=Image.Dither.NONE).save(p, optimize=True)' "$png" 2>/dev/null || true
    fi
}

shot home dark --tab home
shot shared dark --tab shared --fake-shared readme
shot shared-with-me dark --tab shared-with-me --fake-shared-with-me readme
shot activity dark --tab activity
shot settings dark --tab settings
shot share dark --fake-share readme --share "/home/user/ProtonDrive/Documents/Lease agreement.pdf"

# The demo daemon logs what it was asked and doesn't know: show it, to find what a page needs
if [[ -s "$TMP/demo.err" ]]; then
    echo "readme-screenshots: requests the demo daemon didn't know:" >&2
    sort -u "$TMP/demo.err" >&2
fi
