#!/usr/bin/env bash
# Build and package Proton Drive for Linux (<arch> is x86_64 or aarch64):
#
#   $DIST/kosidhar-protondrive-<version>-linux-<arch>.AppImage  any distro with glibc 2.35 or newer
#   $DIST/kosidhar-protondrive-<version>-linux-<deb_arch>.deb   Debian, Ubuntu, Mint, Pop!_OS, Zorin, ...
#   $DIST/kosidhar-protondrive-<version>-linux-<arch>.rpm       Fedora, openSUSE, RHEL, Rocky, Alma, ...
#   $DIST/kosidhar-protondrive-<version>-linux-<arch>.tar.gz    portable FHS tree + universal install.sh
#
# Usage: packaging/linux/package.sh [--skip-build] [--native] [--allow-newer-glibc] [--formats "appimage deb rpm tar"]
#
# The app (protondrive-gui) and the drive helper (protondrive-vfs) are built in an Ubuntu 22.04 container
# (build-portable.sh, needs docker), so the packages run on glibc 2.35 and newer: Ubuntu 22.04, Debian 12 and later.
# The packages declare the newest glibc their binaries need, and the build stops if that is newer than 2.35.
#
#   --native             build them on this machine instead, for local testing: they then need this machine's glibc
#   --allow-newer-glibc  package binaries that need a glibc newer than 2.35 anyway (as a --native build may)
set -euo pipefail
# Staged folders 0755 and files 0644 whatever the user's umask (#548)
umask 022

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
APP_ID="io.github.kosidhar.ProtonDrive"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")"
BUILD_DATE="$(date -u +%Y-%m-%d)"
DIST="$ROOT/dist/release"
CARGO_TARGET_DIR="$ROOT/native-gui/target"
# The newest glibc a release package may need: Ubuntu 22.04's (#505)
GLIBC_LIMIT=2.35

SKIP_BUILD=0
NATIVE=0
ALLOW_NEWER_GLIBC=0
FORMATS="appimage deb rpm tar"
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --native) NATIVE=1; shift ;;
    --allow-newer-glibc) ALLOW_NEWER_GLIBC=1; shift ;;
    --formats) FORMATS="$2"; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DEB_ARCH=amd64; NFPM_BIN_ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64; DEB_ARCH=arm64; NFPM_BIN_ARCH=arm64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 2 ;;
esac

# The portable build runs in docker: say so before building anything
if [ "$SKIP_BUILD" = 0 ] && [ "$NATIVE" = 0 ] && ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is needed to build the app and the drive helper for glibc $GLIBC_LIMIT (Ubuntu 22.04)." >&2
  echo "       Install docker, or pass --native to build them on this machine for local testing" \
    "(the packages then need this machine's glibc, so add --allow-newer-glibc if it is newer)." >&2
  exit 1
fi

export PROTONDRIVE_MAINTAINER="${PROTONDRIVE_MAINTAINER:-Gautam Chauhan <gautam@linux.local>}"
BASENAME="kosidhar-protondrive-$VERSION-linux-$ARCH"
mkdir -p "$DIST" "$ROOT/release" "$CARGO_TARGET_DIR"

echo "==> Proton Drive $VERSION for Linux $ARCH ($FORMATS)"

if [ "$SKIP_BUILD" = 0 ]; then
  echo "==> Building sync daemon & CLI (Bun standalone binary)..."
  (cd "$ROOT" && bun "$ROOT/scripts/build.ts")
  if [ "$NATIVE" = 1 ]; then
    echo "==> Building native Rust desktop GUI (protondrive-gui) on this machine..."
    (cd "$ROOT/native-gui" && cargo build --release)
    install -Dm755 "$CARGO_TARGET_DIR/release/protondrive-gui" "$ROOT/release/protondrive-gui"
    echo "==> Building virtual drive helper (protondrive-vfs) on this machine..."
    (cd "$ROOT/native-vfs" && cargo build --release)
    install -Dm755 "$ROOT/native-vfs/target/release/protondrive-vfs" "$ROOT/release/protondrive-vfs"
  else
    echo "==> Building native Rust desktop GUI and virtual drive helper for glibc $GLIBC_LIMIT..."
    "$HERE/build-portable.sh"
  fi
fi

WORK="$CARGO_TARGET_DIR/linux-package"
STAGE="$WORK/root"
rm -rf "$WORK"
mkdir -p "$STAGE"

# ---- Stage shared FHS tree (used by tar, deb, rpm, AppImage, Flatpak, Arch) ----
install -Dm755 "$ROOT/release/protondrive" "$STAGE/usr/bin/protondrive"
install -Dm755 "$ROOT/release/protondrive-gui" "$STAGE/usr/bin/protondrive-gui"
install -Dm755 "$ROOT/release/protondrive-vfs" "$STAGE/usr/bin/protondrive-vfs"
strip "$STAGE/usr/bin/protondrive-gui" "$STAGE/usr/bin/protondrive-vfs" 2>/dev/null || true

# The packages declare the newest glibc any of their binaries needs (nfpm.yaml), which must not pass $GLIBC_LIMIT
GLIBC_MIN="$("$HERE/glibc-min.sh" "$STAGE/usr/bin/protondrive" "$STAGE/usr/bin/protondrive-gui" "$STAGE/usr/bin/protondrive-vfs")"
if [ "$(printf '%s\n' "$GLIBC_MIN" "$GLIBC_LIMIT" | sort -V | tail -n 1)" != "$GLIBC_LIMIT" ]; then
  if [ "$ALLOW_NEWER_GLIBC" = 0 ]; then
    echo "error: the binaries need glibc $GLIBC_MIN, newer than the $GLIBC_LIMIT (Ubuntu 22.04) release packages support." >&2
    echo "       Build them without --native, or pass --allow-newer-glibc for packages that need glibc $GLIBC_MIN." >&2
    exit 1
  fi
  echo "warning: the packages need glibc $GLIBC_MIN, newer than $GLIBC_LIMIT (--allow-newer-glibc)" >&2
fi
echo "==> The binaries need glibc $GLIBC_MIN or newer"
export GLIBC_MIN

install -Dm644 "$HERE/$APP_ID.desktop" "$STAGE/usr/share/applications/$APP_ID.desktop"
install -Dm644 "$HERE/$APP_ID.OpenDoc.desktop" "$STAGE/usr/share/applications/$APP_ID.OpenDoc.desktop"
install -Dm644 "$HERE/$APP_ID.xml" "$STAGE/usr/share/mime/packages/$APP_ID.xml"
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
# Proton's own Docs and Sheets icons for the placeholders (GPL-3.0, see assets/mimetypes/LICENSE)
install -Dm644 "$ROOT/assets/mimetypes/application-vnd.proton.doc.svg" "$STAGE/usr/share/icons/hicolor/scalable/mimetypes/application-vnd.proton.doc.svg"
install -Dm644 "$ROOT/assets/mimetypes/application-vnd.proton.sheet.svg" "$STAGE/usr/share/icons/hicolor/scalable/mimetypes/application-vnd.proton.sheet.svg"
# The license texts: the project's own, the third-party notices, and the GPL text for the Proton icons
install -Dm644 "$ROOT/LICENSE" "$STAGE/usr/share/licenses/kosidhar-protondrive/LICENSE"
install -Dm644 "$ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/usr/share/licenses/kosidhar-protondrive/THIRD_PARTY_NOTICES.md"
install -Dm644 "$ROOT/assets/mimetypes/LICENSE" "$STAGE/usr/share/licenses/kosidhar-protondrive/LICENSE.proton-file-icons"

# File manager integrations (GNOME Nautilus, Cinnamon Nemo, KDE Dolphin)
install -Dm644 "$ROOT/linux/nautilus/proton_drive_nautilus.py" \
  "$STAGE/usr/share/nautilus-python/extensions/kosidhar_protondrive_nautilus.py"
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

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$STAGE/usr/share/applications/$APP_ID.desktop"
  desktop-file-validate "$STAGE/usr/share/applications/$APP_ID.OpenDoc.desktop"
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
  "$HERE/nfpm-contents.sh" "$STAGE" > "$WORK/contents.yaml"
  sed "s|\${STAGE}|$STAGE|g" "$HERE/nfpm.yaml" \
    | awk -v list="$WORK/contents.yaml" '/# @STAGED_CONTENTS@/ { while ((getline line < list) > 0) print line; next } { print }' \
    > "$WORK/nfpm.yaml"
  if has deb; then
    (cd "$ROOT" && "$NFPM_TOOL" package -f "$WORK/nfpm.yaml" -p deb -t "$DIST/kosidhar-protondrive-${VERSION}-linux-${DEB_ARCH}.deb")
    echo "wrote $DIST/kosidhar-protondrive-${VERSION}-linux-${DEB_ARCH}.deb"
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

  # AppRun puts $APPDIR/usr/bin on PATH (so protondrive-gui can spawn the daemon), dispatches
  # CLI arguments, and registers the Docs and Sheets file types on the host at launch. The MIME
  # XML, icons and OpenDoc.desktop it copies are the ones staged under usr/share above.
  install -m 0755 "$HERE/appimage/AppRun" "$APPDIR/AppRun"

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
