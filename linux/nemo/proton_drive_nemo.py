import os
import subprocess
import urllib.request
from gi.repository import GObject, Nemo


class ProtonDriveNemoExtension(GObject.GObject, Nemo.MenuProvider, Nemo.InfoProvider):
    def __init__(self):
        super().__init__()
        self.sync_dir = os.path.expanduser("~/ProtonDrive")

    def update_file_info(self, file):
        if file.get_uri_scheme() != "file":
            return
        filepath = file.get_location().get_path()
        if not filepath:
            return
        if filepath == self.sync_dir or filepath.startswith(self.sync_dir + os.sep):
            file.add_emblem("emblem-synchronized")

    def get_file_items(self, window, files):
        if not files:
            return []
        first = files[0].get_location().get_path()
        if not first or not (first == self.sync_dir or first.startswith(self.sync_dir + os.sep)):
            return []

        sync_item = Nemo.MenuItem(
            name="ProtonDriveNemo::SyncNow",
            label="Proton Drive: Sync Now",
            tip="Trigger an immediate Proton Drive sync pass",
        )
        sync_item.connect("activate", self._on_sync_now)

        gui_item = Nemo.MenuItem(
            name="ProtonDriveNemo::OpenGui",
            label="Open Proton Drive",
            tip="Open the Proton Drive desktop window",
        )
        gui_item.connect("activate", self._on_open_gui)
        return [sync_item, gui_item]

    def _on_sync_now(self, _menu):
        try:
            req = urllib.request.Request("http://127.0.0.1:49152/api/sync", method="POST")
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            subprocess.Popen(["protondrive", "sync"])

    def _on_open_gui(self, _menu):
        subprocess.Popen(["protondrive-gui"])
