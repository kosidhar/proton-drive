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

# Where the app keeps its data (src/sdk/config.ts): $PROTON_DRIVE_CACHE_DIR, else $XDG_DATA_HOME (or ~/.local/share)
# /proton-drive-ubuntu; under sudo, the invoking user's
proton_app_dir() {
  if [ -n "${PROTON_DRIVE_CACHE_DIR:-}" ]; then
    echo "$PROTON_DRIVE_CACHE_DIR"
    return
  fi
  local home="$HOME" data="${XDG_DATA_HOME:-}"
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    data=""
  fi
  echo "${data:-$home/.local/share}/proton-drive-ubuntu"
}

# The virtual drive keeps the files in a hidden store while it is on. An uninstall never deletes or moves them: it
# says where they are and how to get them back into a plain folder.
warn_about_store() {
  local app store db
  app="$(proton_app_dir)"
  store="$app/files"
  db="$app/ubuntu-sync-state.sqlite"
  [ -d "$store" ] || return 0
  [ -n "$(find "$store" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || return 0
  cat <<WARNING

!!! Your Proton Drive files are still in the virtual drive's hidden store. Nothing there was deleted:
      $store
    The virtual drive was on, so your Proton Drive folder (by default ~/ProtonDrive) showed them only while Proton
    Drive ran. To get them back into that folder, either:
      - reinstall Proton Drive, switch off "Show online-only files in Files (virtual drive)" in Settings, wait until
        the files are back, then uninstall again (the safe way); or
      - move them by hand, for ~/ProtonDrive. First quit Proton Drive, which may still be running from the removed
        files (choose Quit Proton Drive in its tray menu, or close the app, then run the curl line), and check that
        pgrep prints nothing, or the moves below read as deletes. Then record that the files are back (python3 needs
        no sqlite3 command):
          curl -s -X POST http://127.0.0.1:49152/api/quit
          pgrep -a protondrive           # must print nothing
          fusermount3 -u -z ~/ProtonDrive; chmod 755 ~/ProtonDrive
          find "$store" -mindepth 1 -maxdepth 1 -exec mv -n -t ~/ProtonDrive {} +
          find "$store" -mindepth 1      # must print nothing: anything left has a name already taken
          python3 -c 'import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.executemany("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [("driveLayout", "plain"), ("virtualDriveWanted", "0")]); db.execute("DELETE FROM settings WHERE key = ?", ("layoutMoving",)); db.commit()' "$db"
          # or, with the sqlite3 command instead of python3:
          sqlite3 "$db" "INSERT OR REPLACE INTO settings (key, value) VALUES ('driveLayout', 'plain'), ('virtualDriveWanted', '0'); DELETE FROM settings WHERE key = 'layoutMoving';"
    Don't install an older version of Proton Drive until the files are back: it knows nothing of the store, takes the
    empty folder for files you deleted, and moves them to the Proton Drive trash.
WARNING
}

if [ "$UNINSTALL" -eq 1 ]; then
  echo "==> Uninstalling Proton Drive from $PREFIX..."
  systemctl --user disable --now protondrive.service 2>/dev/null || true
  systemctl --user disable --now proton-drive-ubuntu.service 2>/dev/null || true
  rm -f "$PREFIX/bin/protondrive" "$PREFIX/bin/protondrive-gui" "$PREFIX/bin/protondrive-vfs" "$PREFIX/bin/proton-drive-ubuntu"
  rm -f "$PREFIX/share/applications/ch.proton.drive.desktop" "$PREFIX/share/applications/proton-drive.desktop"
  rm -f "$PREFIX/share/metainfo/ch.proton.drive.metainfo.xml"
  rm -f "$SYSTEMD_USER_DIR/protondrive.service"
  rm -f "$PREFIX/share/icons/hicolor/scalable/emblems/emblem-protondrive-"*.svg
  # The file manager integrations and the tray, so Files, Nemo and Dolphin stop offering Proton Drive (#54)
  rm -f "$PREFIX/share/nautilus-python/extensions/ch_proton_drive_nautilus.py" \
    "$PREFIX/share/nautilus-python/extensions/proton_drive_nautilus.py" \
    "$PREFIX/share/nemo-python/extensions/proton_drive_nemo.py" \
    "$PREFIX/share/kio/servicemenus/protondrive.desktop"
  rm -rf "$PREFIX/share/protondrive"
  # The parentheses matter: without them -delete applies to the last name only (#54)
  find "$PREFIX/share/icons/hicolor" \( -name "ch.proton.drive.*" -o -name "protondrive.*" -o -name "protondrive-tray-*" \) \
    -delete 2>/dev/null || true
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$PREFIX/share/icons/hicolor" 2>/dev/null || true
  echo "==> Uninstalled Proton Drive."
  warn_about_store
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
  # The virtual drive helper must sit next to protondrive (the daemon looks beside itself first)
  install -Dm755 "$SRC_Root/bin/protondrive-vfs" "$PREFIX/bin/protondrive-vfs"
  ln -sf protondrive "$PREFIX/bin/proton-drive-ubuntu"
  cp -R "$SRC_Root/share/icons/hicolor" "$PREFIX/share/icons/"
  [ -d "$SRC_Root/share/protondrive" ] && cp -R "$SRC_Root/share/protondrive/"* "$PREFIX/share/protondrive/"
  install -Dm644 "$SRC_Root/share/applications/ch.proton.drive.desktop" "$PREFIX/share/applications/ch.proton.drive.desktop"
  [ -f "$SRC_Root/share/metainfo/ch.proton.drive.metainfo.xml" ] && \
    install -Dm644 "$SRC_Root/share/metainfo/ch.proton.drive.metainfo.xml" "$PREFIX/share/metainfo/ch.proton.drive.metainfo.xml"
  rm -f "$PREFIX/share/nautilus-python/extensions/proton_drive_nautilus.py"
  [ -f "$SRC_Root/share/nautilus-python/extensions/ch_proton_drive_nautilus.py" ] && \
    install -Dm644 "$SRC_Root/share/nautilus-python/extensions/ch_proton_drive_nautilus.py" "$PREFIX/share/nautilus-python/extensions/ch_proton_drive_nautilus.py"
  [ -f "$SRC_Root/share/nemo-python/extensions/proton_drive_nemo.py" ] && \
    install -Dm644 "$SRC_Root/share/nemo-python/extensions/proton_drive_nemo.py" "$PREFIX/share/nemo-python/extensions/proton_drive_nemo.py"
  [ -f "$SRC_Root/share/kio/servicemenus/protondrive.desktop" ] && \
    install -Dm644 "$SRC_Root/share/kio/servicemenus/protondrive.desktop" "$PREFIX/share/kio/servicemenus/protondrive.desktop"
else
  install -Dm755 "$SRC_Root/release/proton-drive-ubuntu" "$PREFIX/bin/protondrive"
  install -Dm755 "$SRC_Root/release/protondrive-gui" "$PREFIX/bin/protondrive-gui"
  install -Dm755 "$SRC_Root/release/protondrive-vfs" "$PREFIX/bin/protondrive-vfs"
  ln -sf protondrive "$PREFIX/bin/proton-drive-ubuntu"
  cp -R "$SRC_Root/assets/app-icon/hicolor" "$PREFIX/share/icons/"
  cp -R "$SRC_Root/assets/app-icon/tray/"*.png "$PREFIX/share/protondrive/tray/"
  cp -R "$SRC_Root/assets/app-icon/tray/"*.png "$PREFIX/share/icons/hicolor/64x64/apps/"
  install -Dm755 "$SRC_Root/linux/tray/proton_drive_tray.py" "$PREFIX/share/protondrive/proton_drive_tray.py"
  for emblem in "$SRC_Root"/linux/icons/emblems/emblem-protondrive-*.svg; do
    install -Dm644 "$emblem" "$PREFIX/share/icons/hicolor/scalable/emblems/$(basename "$emblem")"
  done
  install -Dm644 "$SRC_Root/packaging/linux/ch.proton.drive.desktop" "$PREFIX/share/applications/ch.proton.drive.desktop"
  rm -f "$PREFIX/share/nautilus-python/extensions/proton_drive_nautilus.py"
  install -Dm644 "$SRC_Root/linux/nautilus/proton_drive_nautilus.py" "$PREFIX/share/nautilus-python/extensions/ch_proton_drive_nautilus.py"
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
