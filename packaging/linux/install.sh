#!/usr/bin/env bash
# Universal Linux installer for Proton Drive (works on Ubuntu, Debian, Fedora, Arch,
# openSUSE, Linux Mint, Pop!_OS, Manjaro, NixOS/FHS, Void, Gentoo, etc.)
#
# Usage:
#   ./install.sh [--user | --system] [--uninstall]
#
# Defaults to --user (~/.local) when run as a non-root user, or --system (/usr) when run as root.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Support running either from inside an extracted release tarball or from the git repo root
if [ -x "$HERE/bin/protondrive-gui" ]; then
  SRC_Root="$HERE"
elif [ -x "$HERE/../../release/protondrive-gui" ]; then
  SRC_Root="$HERE/../.."
else
  SRC_Root="$HERE"
fi

MODE=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE="user"; shift ;;
    --system) MODE="system"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--user | --system] [--uninstall]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MODE" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    MODE="system"
  else
    MODE="user"
  fi
fi

if [ "$MODE" = "system" ]; then
  PREFIX="/usr"
  SYSTEMD_USER_DIR="/usr/lib/systemd/user"
else
  PREFIX="$HOME/.local"
  SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
fi

if [ "$UNINSTALL" -eq 1 ]; then
  echo "==> Uninstalling Proton Drive from $PREFIX..."
  systemctl --user disable --now protondrive.service 2>/dev/null || true
  systemctl --user disable --now proton-drive-ubuntu.service 2>/dev/null || true
  rm -f "$PREFIX/bin/protondrive" "$PREFIX/bin/protondrive-gui" "$PREFIX/bin/proton-drive-ubuntu"
  rm -f "$PREFIX/share/applications/ch.proton.drive.desktop" "$PREFIX/share/applications/proton-drive.desktop"
  rm -f "$PREFIX/share/metainfo/ch.proton.drive.metainfo.xml"
  rm -f "$SYSTEMD_USER_DIR/protondrive.service"
  find "$PREFIX/share/icons/hicolor" -name "ch.proton.drive.*" -o -name "protondrive.*" -delete 2>/dev/null || true
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$PREFIX/share/icons/hicolor" 2>/dev/null || true
  echo "==> Uninstalled Proton Drive."
  exit 0
fi

echo "==> Installing Proton Drive ($MODE mode) into $PREFIX..."
mkdir -p \
  "$PREFIX/bin" \
  "$PREFIX/share/applications" \
  "$PREFIX/share/metainfo" \
  "$PREFIX/share/icons" \
  "$PREFIX/share/protondrive/tray" \
  "$PREFIX/share/nautilus-python/extensions" \
  "$PREFIX/share/nemo-python/extensions" \
  "$PREFIX/share/kio/servicemenus" \
  "$SYSTEMD_USER_DIR"

if [ -d "$SRC_Root/bin" ]; then
  install -Dm755 "$SRC_Root/bin/protondrive" "$PREFIX/bin/protondrive"
  install -Dm755 "$SRC_Root/bin/protondrive-gui" "$PREFIX/bin/protondrive-gui"
  ln -sf protondrive "$PREFIX/bin/proton-drive-ubuntu"
  cp -R "$SRC_Root/share/icons/hicolor" "$PREFIX/share/icons/"
  [ -d "$SRC_Root/share/protondrive" ] && cp -R "$SRC_Root/share/protondrive/"* "$PREFIX/share/protondrive/"
  install -Dm644 "$SRC_Root/share/applications/ch.proton.drive.desktop" "$PREFIX/share/applications/ch.proton.drive.desktop"
  [ -f "$SRC_Root/share/metainfo/ch.proton.drive.metainfo.xml" ] && \
    install -Dm644 "$SRC_Root/share/metainfo/ch.proton.drive.metainfo.xml" "$PREFIX/share/metainfo/ch.proton.drive.metainfo.xml"
  [ -f "$SRC_Root/share/nautilus-python/extensions/proton_drive_nautilus.py" ] && \
    install -Dm644 "$SRC_Root/share/nautilus-python/extensions/proton_drive_nautilus.py" "$PREFIX/share/nautilus-python/extensions/proton_drive_nautilus.py"
  [ -f "$SRC_Root/share/nemo-python/extensions/proton_drive_nemo.py" ] && \
    install -Dm644 "$SRC_Root/share/nemo-python/extensions/proton_drive_nemo.py" "$PREFIX/share/nemo-python/extensions/proton_drive_nemo.py"
  [ -f "$SRC_Root/share/kio/servicemenus/protondrive.desktop" ] && \
    install -Dm644 "$SRC_Root/share/kio/servicemenus/protondrive.desktop" "$PREFIX/share/kio/servicemenus/protondrive.desktop"
else
  install -Dm755 "$SRC_Root/release/proton-drive-ubuntu" "$PREFIX/bin/protondrive"
  install -Dm755 "$SRC_Root/release/protondrive-gui" "$PREFIX/bin/protondrive-gui"
  ln -sf protondrive "$PREFIX/bin/proton-drive-ubuntu"
  cp -R "$SRC_Root/assets/app-icon/hicolor" "$PREFIX/share/icons/"
  cp -R "$SRC_Root/assets/app-icon/tray/"*.png "$PREFIX/share/protondrive/tray/"
  cp -R "$SRC_Root/assets/app-icon/tray/"*.png "$PREFIX/share/icons/hicolor/64x64/apps/"
  install -Dm755 "$SRC_Root/linux/tray/proton_drive_tray.py" "$PREFIX/share/protondrive/proton_drive_tray.py"
  install -Dm644 "$SRC_Root/packaging/linux/ch.proton.drive.desktop" "$PREFIX/share/applications/ch.proton.drive.desktop"
  install -Dm644 "$SRC_Root/linux/nautilus/proton_drive_nautilus.py" "$PREFIX/share/nautilus-python/extensions/proton_drive_nautilus.py"
  install -Dm644 "$SRC_Root/linux/nemo/proton_drive_nemo.py" "$PREFIX/share/nemo-python/extensions/proton_drive_nemo.py"
  install -Dm644 "$SRC_Root/linux/dolphin/protondrive.desktop" "$PREFIX/share/kio/servicemenus/protondrive.desktop"
fi

cat > "$SYSTEMD_USER_DIR/protondrive.service" <<EOF
[Unit]
Description=Proton Drive Background Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PREFIX/bin/protondrive daemon
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

if [ "$MODE" = "user" ]; then
  # Rewrite Exec= and Icon= in user desktop entry so it works even if ~/.local/bin is not in the display manager's PATH
  sed -i "s|^Exec=.*|Exec=$PREFIX/bin/protondrive-gui|; s|^TryExec=.*|TryExec=$PREFIX/bin/protondrive-gui|; s|^Icon=.*|Icon=$PREFIX/share/icons/hicolor/256x256/apps/ch.proton.drive.png|" \
    "$PREFIX/share/applications/ch.proton.drive.desktop"
  rm -f "$PREFIX/share/applications/proton-drive.desktop"
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$PREFIX/share/icons/hicolor" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

echo "==> Proton Drive installed successfully!"
echo "    Launch GUI : $PREFIX/bin/protondrive-gui (or 'Proton Drive' in your app launcher)"
echo "    CLI / Sync : $PREFIX/bin/protondrive status"
