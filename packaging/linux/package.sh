#!/usr/bin/env bash
# Build and package Proton Drive for Linux (<arch> is x86_64 or aarch64):
#
#   $DIST/protondrive-<version>-linux-<arch>.AppImage  any distro with glibc >= host
#   $DIST/protondrive-<version>-linux-<deb_arch>.deb   Debian, Ubuntu, Mint, Pop!_OS, Zorin, ...
#   $DIST/protondrive-<version>-linux-<arch>.rpm       Fedora, openSUSE, RHEL, Rocky, Alma, ...
#   $DIST/protondrive-<version>-linux-<arch>.tar.gz    portable FHS tree + universal install.sh
#
# Usage: packaging/linux/package.sh [--skip-build] [--formats "appimage deb rpm tar"]
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
APP_ID="ch.proton.drive"
VERSION="0.1.0"
BUILD_DATE="$(date -u +%Y-%m-%d)"
DIST="$ROOT/dist/release"
CARGO_TARGET_DIR="$ROOT/native-gui/target"

SKIP_BUILD=0
FORMATS="appimage deb rpm tar"
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --formats) FORMATS="$2"; shift 2 ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DEB_ARCH=amd64; NFPM_BIN_ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64; DEB_ARCH=arm64; NFPM_BIN_ARCH=arm64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 2 ;;
esac

export PROTONDRIVE_MAINTAINER="${PROTONDRIVE_MAINTAINER:-Gautam Chauhan <gautam@linux.local>}"
BASENAME="protondrive-$VERSION-linux-$ARCH"
mkdir -p "$DIST" "$ROOT/release" "$CARGO_TARGET_DIR"

echo "==> Proton Drive $VERSION for Linux $ARCH ($FORMATS)"

if [ "$SKIP_BUILD" = 0 ]; then
  echo "==> Building sync daemon & CLI (Bun standalone binary)..."
  (cd "$ROOT" && bun "$ROOT/scripts/build.ts")
  echo "==> Building native Rust desktop GUI (protondrive-gui)..."
  (cd "$ROOT/native-gui" && cargo build --release)
  install -Dm755 "$CARGO_TARGET_DIR/release/protondrive-gui" "$ROOT/release/protondrive-gui"
  echo "==> Building virtual drive helper (protondrive-vfs)..."
  (cd "$ROOT/native-vfs" && cargo build --release)
  install -Dm755 "$ROOT/native-vfs/target/release/protondrive-vfs" "$ROOT/release/protondrive-vfs"
fi

WORK="$CARGO_TARGET_DIR/linux-package"
STAGE="$WORK/root"
rm -rf "$WORK"
mkdir -p "$STAGE"

# ---- Stage shared FHS tree (used by tar, deb, rpm, AppImage, Flatpak, Arch) ----
install -Dm755 "$ROOT/release/proton-drive-ubuntu" "$STAGE/usr/bin/protondrive"
install -Dm755 "$ROOT/release/protondrive-gui" "$STAGE/usr/bin/protondrive-gui"
install -Dm755 "$ROOT/release/protondrive-vfs" "$STAGE/usr/bin/protondrive-vfs"
ln -sf protondrive "$STAGE/usr/bin/proton-drive-ubuntu"
strip "$STAGE/usr/bin/protondrive-gui" "$STAGE/usr/bin/protondrive-vfs" 2>/dev/null || true

install -Dm644 "$HERE/$APP_ID.desktop" "$STAGE/usr/share/applications/$APP_ID.desktop"
mkdir -p "$STAGE/usr/share/metainfo"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@DATE@/$BUILD_DATE/g" \
  "$HERE/$APP_ID.metainfo.xml.in" > "$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml"

mkdir -p "$STAGE/usr/share/icons" "$STAGE/usr/share/protondrive/tray"
cp -R "$ROOT/assets/app-icon/hicolor" "$STAGE/usr/share/icons/"
cp -R "$ROOT/assets/app-icon/tray/"*.png "$STAGE/usr/share/protondrive/tray/"
cp -R "$ROOT/assets/app-icon/tray/"*.png "$STAGE/usr/share/icons/hicolor/64x64/apps/"
install -Dm755 "$ROOT/linux/tray/proton_drive_tray.py" "$STAGE/usr/share/protondrive/proton_drive_tray.py"
# The Files emblems: Always keep, Downloaded, Partly here, Online only
for emblem in "$ROOT"/linux/icons/emblems/emblem-protondrive-*.svg; do
  install -Dm644 "$emblem" "$STAGE/usr/share/icons/hicolor/scalable/emblems/$(basename "$emblem")"
done

# File manager integrations (GNOME Nautilus, Cinnamon Nemo, KDE Dolphin)
install -Dm644 "$ROOT/linux/nautilus/proton_drive_nautilus.py" \
  "$STAGE/usr/share/nautilus-python/extensions/ch_proton_drive_nautilus.py"
install -Dm644 "$ROOT/linux/nemo/proton_drive_nemo.py" \
  "$STAGE/usr/share/nemo-python/extensions/proton_drive_nemo.py"
install -Dm644 "$ROOT/linux/dolphin/protondrive.desktop" \
  "$STAGE/usr/share/kio/servicemenus/protondrive.desktop"

# Systemd user service
mkdir -p "$STAGE/usr/lib/systemd/user"
cat > "$STAGE/usr/lib/systemd/user/protondrive.service" <<'EOF'
[Unit]
Description=Proton Drive Background Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/protondrive daemon
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
ln -sf protondrive.service "$STAGE/usr/lib/systemd/user/proton-drive-ubuntu.service"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$STAGE/usr/share/applications/$APP_ID.desktop"
fi
if command -v appstreamcli >/dev/null 2>&1; then
  appstreamcli validate --no-net --explain "$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml" || true
fi

has() { case " $FORMATS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- 1. Portable .tar.gz + universal install.sh ----
if has tar; then
  mkdir -p "$WORK/tar"
  cp -R "$STAGE/usr" "$WORK/tar/$BASENAME"
  install -Dm755 "$HERE/install.sh" "$WORK/tar/$BASENAME/install.sh"
  tar -C "$WORK/tar" -czf "$DIST/$BASENAME.tar.gz" "$BASENAME"
  echo "wrote $DIST/$BASENAME.tar.gz"
fi

# ---- 2. .deb and .rpm (via nfpm, auto-downloaded if missing) ----
if has deb || has rpm; then
  NFPM_TOOL="$(command -v nfpm || true)"
  if [ -z "$NFPM_TOOL" ]; then
    NFPM_TOOL="$CARGO_TARGET_DIR/nfpm-$NFPM_BIN_ARCH"
    if [ ! -x "$NFPM_TOOL" ]; then
      echo "==> Downloading nfpm for .deb / .rpm packaging..."
      NFPM_TAR="$CARGO_TARGET_DIR/nfpm.tar.gz"
      curl -fsSL -o "$NFPM_TAR" \
        "https://github.com/goreleaser/nfpm/releases/download/v2.41.1/nfpm_2.41.1_Linux_${NFPM_BIN_ARCH}.tar.gz"
      tar -xzf "$NFPM_TAR" -C "$CARGO_TARGET_DIR" nfpm
      mv "$CARGO_TARGET_DIR/nfpm" "$NFPM_TOOL"
      chmod +x "$NFPM_TOOL"
      rm -f "$NFPM_TAR"
    fi
  fi

  export VERSION
  export NFPM_ARCH="$DEB_ARCH"
  sed "s|\${STAGE}|$STAGE|g" "$HERE/nfpm.yaml" > "$WORK/nfpm.yaml"
  if has deb; then
    (cd "$ROOT" && "$NFPM_TOOL" package -f "$WORK/nfpm.yaml" -p deb -t "$DIST/protondrive-${VERSION}-linux-${DEB_ARCH}.deb")
    cp -f "$DIST/protondrive-${VERSION}-linux-${DEB_ARCH}.deb" "$ROOT/release/proton-drive-ubuntu_${VERSION}_${DEB_ARCH}.deb"
    echo "wrote $DIST/protondrive-${VERSION}-linux-${DEB_ARCH}.deb"
  fi
  if has rpm; then
    (cd "$ROOT" && "$NFPM_TOOL" package -f "$WORK/nfpm.yaml" -p rpm -t "$DIST/$BASENAME.rpm")
    echo "wrote $DIST/$BASENAME.rpm"
  fi
fi

# ---- 3. Universal .AppImage ----
if has appimage; then
  APPDIR="$WORK/ProtonDrive.AppDir"
  cp -R "$STAGE" "$APPDIR"

  # Custom AppRun that adds $APPDIR/usr/bin to PATH so protondrive-gui can auto-spawn protondrive daemon
  cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
SELF="$(readlink -f "$0")"
HERE="${SELF%/*}"
export PATH="${HERE}/usr/bin:${PATH}"
export XDG_DATA_DIRS="${HERE}/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
if [ $# -gt 0 ] && [ "$1" != "--screenshot" ] && [ "$1" != "--version" ] && [ "$1" != "--help" ] && [ "$1" != "-h" ]; then
  exec "${HERE}/usr/bin/protondrive" "$@"
else
  exec "${HERE}/usr/bin/protondrive-gui" "$@"
fi
EOF
  chmod 0755 "$APPDIR/AppRun"

  cp "$HERE/$APP_ID.desktop" "$APPDIR/$APP_ID.desktop"
  cp "$ROOT/assets/app-icon/hicolor/256x256/apps/$APP_ID.png" "$APPDIR/$APP_ID.png"
  ln -sf "$APP_ID.png" "$APPDIR/.DirIcon"

  TOOL="${APPIMAGETOOL:-$(command -v appimagetool || true)}"
  if [ -z "$TOOL" ]; then
    TOOL="$CARGO_TARGET_DIR/appimagetool-$ARCH.AppImage"
    if [ ! -x "$TOOL" ]; then
      echo "==> Downloading appimagetool-$ARCH.AppImage..."
      curl -fsSL -o "$TOOL" \
        "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
      chmod +x "$TOOL"
    fi
  fi

  OUT="$(cd "$DIST" && pwd)/$BASENAME.AppImage"
  APPDIR="$(cd "$APPDIR" && pwd)"
  TOOL="$(cd "$(dirname "$TOOL")" && pwd)/$(basename "$TOOL")"
  (cd "$DIST" && ARCH="$ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream "$APPDIR" "$OUT")
  chmod +x "$OUT"
  echo "wrote $OUT"
fi

echo "==> Built Linux packages in $DIST:"
ls -lh "$DIST"
