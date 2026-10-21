#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="0.1.0"
ARCH="amd64"
PKG_NAME="proton-drive-ubuntu"
STAGE_DIR="$ROOT_DIR/build/deb/${PKG_NAME}_${VERSION}_${ARCH}"

echo "==> Compiling standalone binary with Bun..."
bun "$ROOT_DIR/scripts/build.ts"

echo "==> Compiling native Rust GUI (protondrive-gui)..."
export PATH="$HOME/.cargo/bin:$PATH"
(cd "$ROOT_DIR/native-gui" && cargo build --release)
cp "$ROOT_DIR/native-gui/target/release/protondrive-gui" "$ROOT_DIR/release/protondrive-gui"
chmod 0755 "$ROOT_DIR/release/protondrive-gui"

echo "==> Staging Debian package layout in $STAGE_DIR..."
rm -rf "$STAGE_DIR"
mkdir -p \
  "$STAGE_DIR/DEBIAN" \
  "$STAGE_DIR/usr/bin" \
  "$STAGE_DIR/usr/lib/systemd/user" \
  "$STAGE_DIR/usr/share/applications" \
  "$STAGE_DIR/usr/share/icons/hicolor/scalable/apps" \
  "$STAGE_DIR/usr/share/icons/hicolor/256x256/apps" \
  "$STAGE_DIR/usr/share/nautilus-python/extensions"

cp "$ROOT_DIR/release/proton-drive-ubuntu" "$STAGE_DIR/usr/bin/proton-drive-ubuntu"
cp "$ROOT_DIR/release/protondrive-gui" "$STAGE_DIR/usr/bin/protondrive-gui"
chmod 0755 "$STAGE_DIR/usr/bin/proton-drive-ubuntu" "$STAGE_DIR/usr/bin/protondrive-gui"
ln -sf proton-drive-ubuntu "$STAGE_DIR/usr/bin/protondrive"

cp "$ROOT_DIR/linux/systemd/proton-drive-ubuntu.service" "$STAGE_DIR/usr/lib/systemd/user/proton-drive-ubuntu.service"
cp "$ROOT_DIR/linux/desktop/proton-drive.desktop" "$STAGE_DIR/usr/share/applications/proton-drive.desktop"
cp "$ROOT_DIR/linux/icons/proton-drive-ubuntu.svg" "$STAGE_DIR/usr/share/icons/hicolor/scalable/apps/proton-drive-ubuntu.svg"
cp "$ROOT_DIR/linux/icons/proton-drive-ubuntu.svg" "$STAGE_DIR/usr/share/icons/hicolor/scalable/apps/protondrive.svg"
cp "$ROOT_DIR/linux/icons/protondrive-256.png" "$STAGE_DIR/usr/share/icons/hicolor/256x256/apps/protondrive.png"
cp "$ROOT_DIR/linux/nautilus/proton_drive_nautilus.py" "$STAGE_DIR/usr/share/nautilus-python/extensions/proton_drive_nautilus.py"

cat > "$STAGE_DIR/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${ARCH}
Depends: libsecret-1-0, libnotify-bin, xdg-utils
Recommends: python3-nautilus
Maintainer: Gautam Chauhan <gautam@ubuntu.local>
Description: Unofficial Proton Drive two-way sync & desktop client for Ubuntu
 Third-party application not officially supported by Proton.
 Built on top of the official Proton Drive SDK (@protontech/drive-sdk) with
 event-based two-way local folder synchronization, OS Keyring storage,
 conflict resolution, selective sync, and Ubuntu Nautilus integration.
EOF

cat > "$STAGE_DIR/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
rm -f /usr/share/applications/proton-drive-ubuntu.desktop
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postinst"

DEB_OUT="$ROOT_DIR/release/${PKG_NAME}_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE_DIR" "$DEB_OUT"
echo "==> Built Debian package: $DEB_OUT"
