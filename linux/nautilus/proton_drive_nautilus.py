"""
Ubuntu Nautilus (GNOME Files) extension for Proton Drive Ubuntu Sync (Unofficial).
Notice: This is a third-party application not officially supported by Proton.

Install to:
  ~/.local/share/nautilus-python/extensions/proton_drive_nautilus.py
or system-wide via the .deb package:
  /usr/share/nautilus-python/extensions/proton_drive_nautilus.py
"""

import json
import os
import subprocess
import urllib.parse
import urllib.request
from gi.repository import GObject, Nautilus

DAEMON_URL = os.environ.get("PROTON_DRIVE_DAEMON_URL", "http://127.0.0.1:49152")


def _query_daemon(endpoint: str, method: str = "GET"):
    try:
        req = urllib.request.Request(f"{DAEMON_URL}{endpoint}", method=method)
        with urllib.request.urlopen(req, timeout=0.35) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


class ProtonDriveUbuntuExtension(
    GObject.GObject,
    Nautilus.InfoProvider,
    Nautilus.MenuProvider,
):
    def __init__(self):
        super().__init__()

    def update_file_info(self, file: Nautilus.FileInfo):
        if file.get_uri_scheme() != "file":
            return

        local_path = file.get_location().get_path()
        if not local_path:
            return

        encoded = urllib.parse.quote(local_path)
        info = _query_daemon(f"/api/file-status?path={encoded}")
        if not info or not info.get("tracked"):
            return

        status = info.get("status")
        if status == "synced":
            file.add_emblem("emblem-default")
        elif status in ("uploading", "downloading", "syncing"):
            file.add_emblem("emblem-synchronizing")
        elif status in ("conflict", "error"):
            file.add_emblem("emblem-important")

    def get_file_items(self, *args):
        files = args[-1] if args else []
        if not files:
            return []

        sync_item = Nautilus.MenuItem(
            name="ProtonDriveUbuntu::SyncNow",
            label="Cloud Sync: Sync Now",
            tip="Trigger immediate two-way synchronization with Proton Drive",
        )
        sync_item.connect("activate", self._on_sync_now)

        dashboard_item = Nautilus.MenuItem(
            name="ProtonDriveUbuntu::OpenDashboard",
            label="Cloud Sync: Open Dashboard",
            tip="Open the Ubuntu Cloud Sync GUI dashboard",
        )
        dashboard_item.connect("activate", self._on_open_dashboard)

        return [sync_item, dashboard_item]

    def get_background_items(self, *args):
        sync_item = Nautilus.MenuItem(
            name="ProtonDriveUbuntu::BgSyncNow",
            label="Cloud Sync: Sync Folder Now",
            tip="Trigger immediate two-way synchronization with Proton Drive",
        )
        sync_item.connect("activate", self._on_sync_now)
        return [sync_item]

    def _on_sync_now(self, _menu):
        _query_daemon("/api/sync", method="POST")

    def _on_open_dashboard(self, _menu):
        subprocess.Popen(["xdg-open", DAEMON_URL], start_new_session=True)
