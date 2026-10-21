#!/bin/sh
# deb/rpm/tar post-install and post-remove: refresh desktop and icon caches across Linux distros.
rm -f /usr/share/nautilus-python/extensions/proton_drive_nautilus.py 2>/dev/null || true
rm -f /usr/share/applications/proton-drive-ubuntu.desktop 2>/dev/null || true
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
exit 0
