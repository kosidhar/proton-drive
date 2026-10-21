#!/usr/bin/env bash
# Repackage a Proton Drive Linux tarball as a single-file Flatpak bundle:
#   dist/release/protondrive-<version>-linux-<arch>.flatpak
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
APP_ID="ch.proton.drive"
VERSION="0.1.0"
DIST="$ROOT/dist/release"
CARGO_TARGET_DIR="$ROOT/native-gui/target"
FLATHUB="https://dl.flathub.org/repo/flathub.flatpakrepo"

ARCH="$(uname -m)"
BASENAME="protondrive-$VERSION-linux-$ARCH"
TARBALL="${1:-$DIST/$BASENAME.tar.gz}"

[ -f "$TARBALL" ] || { echo "error: $TARBALL not found (run packaging/linux/package.sh --formats tar first)" >&2; exit 1; }
for tool in flatpak flatpak-builder; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found (install flatpak and flatpak-builder)" >&2; exit 1; }
done

WORK="$CARGO_TARGET_DIR/flatpak-bundle"
rm -rf "$WORK"
mkdir -p "$WORK/stage"
tar -xzf "$TARBALL" -C "$WORK/stage" --strip-components=1
cp "$HERE/flatpak/$APP_ID.bundle.yml" "$WORK/$APP_ID.yml"

flatpak remote-add --user --if-not-exists flathub "$FLATHUB"
flatpak-builder --user --install-deps-from=flathub --disable-rofiles-fuse --force-clean \
  --default-branch=stable --repo="$WORK/repo" --state-dir="$WORK/state" "$WORK/build" "$WORK/$APP_ID.yml"

OUT="$DIST/$BASENAME.flatpak"
flatpak build-bundle --runtime-repo="$FLATHUB" "$WORK/repo" "$OUT" "$APP_ID" stable
echo "wrote $OUT"
