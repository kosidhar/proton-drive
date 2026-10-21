#!/usr/bin/env python3
"""
Proton Drive Top-Bar / System Tray Status Indicator for Linux.
Supports AyatanaAppIndicator3 and AppIndicator3 across GNOME, KDE, XFCE, Cinnamon, MATE.
"""
import fcntl
import json
import os
import signal
import subprocess
import sys
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    try:
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3 as AppIndicator
    except (ValueError, ImportError):
        sys.exit(0)

DAEMON_URL = os.environ.get("PROTON_DRIVE_DAEMON_URL", "http://127.0.0.1:49152")


def find_icon_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.abspath(os.path.join(here, "../../assets/app-icon/tray")),
        os.path.expanduser("~/.local/share/protondrive/tray"),
        "/usr/share/protondrive/tray",
        os.path.expanduser("~/.local/share/icons/hicolor/64x64/apps"),
        "/usr/share/icons/hicolor/64x64/apps",
    ]
    for path in candidates:
        if os.path.isfile(os.path.join(path, "protondrive-tray-idle.png")):
            return path
    return candidates[0]


def format_bytes(b: int) -> str:
    if b < 1024:
        return f"{b} B"
    val = float(b) / 1024.0
    for unit in ["KB", "MB", "GB", "TB"]:
        if val < 1024.0 or unit == "TB":
            return f"{val:.1f} {unit}"
        val /= 1024.0
    return f"{val:.1f} TB"


class ProtonDriveTrayIndicator:
    def __init__(self):
        icon_dir = find_icon_dir()
        self.indicator = AppIndicator.Indicator.new(
            "ch.proton.drive.tray",
            "protondrive-tray-idle",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        if os.path.isdir(icon_dir):
            self.indicator.set_icon_theme_path(icon_dir)
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.indicator.set_title("Proton Drive")

        self.paused = False
        self.sync_dir = os.path.expanduser("~/ProtonDrive")

        self.menu = Gtk.Menu()

        self.status_item = Gtk.MenuItem(label="Proton Drive: Starting...")
        self.status_item.set_sensitive(False)
        self.menu.append(self.status_item)

        self.stats_item = Gtk.MenuItem(label="Checking local sync folder...")
        self.stats_item.set_sensitive(False)
        self.menu.append(self.stats_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        open_app_item = Gtk.MenuItem(label="Open Proton Drive")
        open_app_item.connect("activate", self.on_open_app)
        self.menu.append(open_app_item)

        open_folder_item = Gtk.MenuItem(label="Open ~/ProtonDrive Folder")
        open_folder_item.connect("activate", self.on_open_folder)
        self.menu.append(open_folder_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        sync_now_item = Gtk.MenuItem(label="Sync Now")
        sync_now_item.connect("activate", self.on_sync_now)
        self.menu.append(sync_now_item)

        self.pause_item = Gtk.MenuItem(label="Pause Sync")
        self.pause_item.connect("activate", self.on_toggle_pause)
        self.menu.append(self.pause_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

        self.poll_status()
        GLib.timeout_add_seconds(2, self.poll_status)

    def poll_status(self) -> bool:
        try:
            req = urllib.request.Request(f"{DAEMON_URL}/api/status", method="GET")
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            state = data.get("state", "idle")
            logged_in = data.get("loggedIn", False)
            settings = data.get("settings", {})
            stats = data.get("stats", {})
            self.paused = bool(settings.get("paused", False))
            self.sync_dir = data.get("syncDir") or os.path.expanduser("~/ProtonDrive")

            total_files = int(stats.get("totalFiles", 0))
            total_bytes = int(stats.get("totalBytes", 0))
            self.stats_item.set_label(f"{format_bytes(total_bytes)} synced  •  {total_files} files")

            if not logged_in:
                self.indicator.set_icon_full("protondrive-tray-error", "Sign in required")
                self.status_item.set_label("Status: Sign in required")
            elif self.paused or state == "paused":
                self.indicator.set_icon_full("protondrive-tray-paused", "Paused")
                self.status_item.set_label("Status: Sync Paused")
            elif state == "syncing":
                action = data.get("currentAction") or "Syncing..."
                if len(action) > 42:
                    action = action[:20] + "…" + action[-18:]
                self.indicator.set_icon_full("protondrive-tray-syncing", "Syncing")
                self.status_item.set_label(f"Syncing: {action}")
            elif state == "error":
                self.indicator.set_icon_full("protondrive-tray-error", "Sync Error")
                self.status_item.set_label("Status: Sync Error")
            else:
                self.indicator.set_icon_full("protondrive-tray-idle", "Up to date")
                self.status_item.set_label("Status: Up to date")

            self.pause_item.set_label("Resume Sync" if self.paused else "Pause Sync")
        except Exception:
            self.indicator.set_icon_full("protondrive-tray-error", "Daemon Offline")
            self.status_item.set_label("Status: Daemon Offline")
        return True

    def on_open_app(self, _widget):
        candidates = [
            os.path.expanduser("~/.local/bin/protondrive-gui"),
            "/usr/bin/protondrive-gui",
            os.path.abspath(os.path.join(os.path.dirname(__file__), "../../release/protondrive-gui")),
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

    def on_open_folder(self, _widget):
        subprocess.Popen(
            ["xdg-open", self.sync_dir],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def on_sync_now(self, _widget):
        try:
            req = urllib.request.Request(f"{DAEMON_URL}/api/sync", method="POST")
            urllib.request.urlopen(req, timeout=1.5)
        except Exception:
            pass
        self.poll_status()

    def on_toggle_pause(self, _widget):
        try:
            payload = json.dumps({"paused": not self.paused}).encode("utf-8")
            req = urllib.request.Request(
                f"{DAEMON_URL}/api/pause",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=1.5)
        except Exception:
            pass
        self.poll_status()


def main():
    lock_path = f"/tmp/protondrive-tray-{os.getuid()}.lock"
    lock_file = open(lock_path, "a+")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
    except OSError:
        sys.exit(0)

    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    ProtonDriveTrayIndicator()
    Gtk.main()


if __name__ == "__main__":
    main()
