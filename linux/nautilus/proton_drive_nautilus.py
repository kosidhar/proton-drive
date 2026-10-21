"""
GNOME Files (Nautilus) extension for Proton Drive on Linux.
Provides sync status emblems and native context menu actions (never opens a browser).
"""

import json
import os
import subprocess
import sys
import types
import urllib.parse
import urllib.request
from gi.repository import GObject, Nautilus

DAEMON_URL = os.environ.get("PROTON_DRIVE_DAEMON_URL", "http://127.0.0.1:49152")


def _neutralize_legacy_extension():
    legacy_mod = sys.modules.get("proton_drive_nautilus")
    if legacy_mod is not None and hasattr(legacy_mod, "ProtonDriveUbuntuExtension"):
        legacy_cls = getattr(legacy_mod, "ProtonDriveUbuntuExtension")
        legacy_cls.get_file_items = lambda self, *args: []
        legacy_cls.get_background_items = lambda self, *args: []
        legacy_cls.update_file_info = lambda self, *args: None
    elif "proton_drive_nautilus" not in sys.modules:
        # Block /usr/share/nautilus-python/extensions/proton_drive_nautilus.py from being imported later
        sys.modules["proton_drive_nautilus"] = types.ModuleType("proton_drive_nautilus")


_neutralize_legacy_extension()


def _query_daemon(endpoint: str, method: str = "GET"):
    try:
        req = urllib.request.Request(f"{DAEMON_URL}{endpoint}", method=method)
        with urllib.request.urlopen(req, timeout=0.35) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _launch_native_gui():
    candidates = [
        os.path.expanduser("~/.local/bin/protondrive-gui"),
        "/usr/bin/protondrive-gui",
        "protondrive-gui",
    ]
    for bin_path in candidates:
        try:
            subprocess.Popen(
                [bin_path],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return
        except Exception:
            continue


class ProtonDriveNautilusExtension(
    GObject.GObject,
    Nautilus.InfoProvider,
    Nautilus.MenuProvider,
):
    def __init__(self):
        super().__init__()
        self.sync_dir = os.path.expanduser("~/ProtonDrive")

    def _is_inside_sync_dir(self, local_path: str) -> bool:
        if not local_path:
            return False
        return local_path == self.sync_dir or local_path.startswith(self.sync_dir + os.sep)

    def update_file_info(self, file: Nautilus.FileInfo):
        if file.get_uri_scheme() != "file":
            return

        local_path = file.get_location().get_path()
        if not local_path or not self._is_inside_sync_dir(local_path):
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
        _neutralize_legacy_extension()
        files = args[-1] if args else []
        if not files:
            return []

        first_path = files[0].get_location().get_path()
        if not self._is_inside_sync_dir(first_path):
            return []

        sync_item = Nautilus.MenuItem(
            name="ProtonDrive::SyncNow",
            label="Proton Drive: Sync Now",
            tip="Trigger immediate two-way synchronization with Proton Drive",
        )
        sync_item.connect("activate", self._on_sync_now)

        open_app_item = Nautilus.MenuItem(
            name="ProtonDrive::OpenApp",
            label="Open Proton Drive",
            tip="Open the native Proton Drive desktop application",
        )
        open_app_item.connect("activate", self._on_open_app)

        return [sync_item, open_app_item]

    def get_background_items(self, *args):
        _neutralize_legacy_extension()
        folder = args[-1] if args else None
        if folder is not None and hasattr(folder, "get_location"):
            folder_path = folder.get_location().get_path()
            if not self._is_inside_sync_dir(folder_path):
                return []

        sync_item = Nautilus.MenuItem(
            name="ProtonDrive::BgSyncNow",
            label="Proton Drive: Sync Folder Now",
            tip="Trigger immediate two-way synchronization with Proton Drive",
        )
        sync_item.connect("activate", self._on_sync_now)

        open_app_item = Nautilus.MenuItem(
            name="ProtonDrive::BgOpenApp",
            label="Open Proton Drive",
            tip="Open the native Proton Drive desktop application",
        )
        open_app_item.connect("activate", self._on_open_app)

        return [sync_item, open_app_item]

    def _on_sync_now(self, _menu):
        _query_daemon("/api/sync", method="POST")

    def _on_open_app(self, _menu):
        _launch_native_gui()
