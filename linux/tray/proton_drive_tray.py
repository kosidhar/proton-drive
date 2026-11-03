#!/usr/bin/env python3
"""
Proton Drive Top-Bar / System Tray Status Indicator for Linux.
Supports AyatanaAppIndicator3 and AppIndicator3 across GNOME, KDE, XFCE, Cinnamon, MATE.
"""
import fcntl
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import threading
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

MOUNT_LABEL = "Mount Proton Drive"
OPEN_FOLDER_LABEL = "Open Proton Drive Folder"
# Why a virtual drive can be mounted again (the daemon's vfs.reason); POST /vfs/mount refuses the rest
MOUNT_REASONS = ("ejected", "crashed", "mount-point-busy")
CONTROL_CONNECT_TIMEOUT = 2.0
# Mounting readies the mount point first; past this the daemon is still at it, and the menu says so on the next poll
MOUNT_READ_TIMEOUT = 15.0
# While syncing the tray cycles through these frames so the arrows turn, as a full-size icon is still small in the
# panel and motion is what gets noticed (#75); scripts/make-tray-icons.py draws them
SYNC_FRAMES = 8
SYNC_FRAME_MS = 125


def sync_frame_icon(frame: int) -> str:
    return f"protondrive-tray-syncing-{frame % SYNC_FRAMES}"


class ControlError(Exception):
    """A control socket request that failed; the message is for the user."""


def control_socket_path(env=None, uid=None) -> str:
    """The daemon's control socket, by the rule of its defaultControlSocketPath(): $XDG_RUNTIME_DIR/protondrive/
    control.sock, else <tmpdir>/protondrive-<uid>/control.sock with tmpdir as Node's os.tmpdir() finds it."""
    env = os.environ if env is None else env
    runtime_dir = env.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return os.path.join(runtime_dir, "protondrive", "control.sock")
    tmp = env.get("TMPDIR") or env.get("TMP") or env.get("TEMP") or "/tmp"
    if len(tmp) > 1 and tmp.endswith("/"):
        tmp = tmp[:-1]
    uid = os.getuid() if uid is None else uid
    return os.path.join(tmp, f"protondrive-{uid}", "control.sock")


def build_request(method: str, path: str, body=None) -> bytes:
    """One HTTP/1.1 request that closes the connection after the reply, with a JSON body if given."""
    payload = b"" if body is None else json.dumps(body).encode("utf-8")
    head = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n"
    if body is not None:
        head += f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
    return (head + "\r\n").encode("ascii") + payload


def parse_response(raw: bytes) -> dict:
    """The JSON object of a 2xx reply; anything else raises ControlError with the daemon's error message."""
    malformed = "Malformed reply from the Proton Drive background service"
    head, separator, body = raw.partition(b"\r\n\r\n")
    if not separator:
        raise ControlError(malformed)
    lines = head.decode("latin-1").split("\r\n")
    try:
        status = int(lines[0].split()[1])
    except (IndexError, ValueError):
        raise ControlError(malformed) from None
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "content-length" and value.strip().isdigit() and int(value) <= len(body):
            body = body[: int(value)]
    try:
        data = json.loads(body.decode("utf-8"))
    except ValueError:
        data = None
    if 200 <= status < 300:
        if not isinstance(data, dict):
            raise ControlError("Unreadable reply from the Proton Drive background service")
        return data
    message = data.get("error") if isinstance(data, dict) else None
    if isinstance(message, str) and message:
        raise ControlError(message)
    raise ControlError(f"The Proton Drive background service answered {status}")


def socket_dir_problem(socket_path: str, uid=None):
    """Why the folder holding the control socket can't be trusted, or None. The daemon makes it a 0700 folder of the
    user's; in the /tmp fallback anyone could make it first. One that is missing just means no daemon runs."""
    directory = os.path.dirname(socket_path) or "/"
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        return None
    except OSError as err:
        return f"Can't check the Proton Drive control socket's folder {directory} ({err})"
    uid = os.getuid() if uid is None else uid
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
        return (
            f"The Proton Drive control socket's folder {directory} isn't private to you "
            f"(owner {st.st_uid}, mode {st.st_mode & 0o7777:o}); not connecting to it"
        )
    return None


def connect_control_socket(path=None) -> socket.socket:
    path = control_socket_path() if path is None else path
    problem = socket_dir_problem(path)
    if problem:
        raise ControlError(problem)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(CONTROL_CONNECT_TIMEOUT)
    try:
        sock.connect(path)
    except OSError:
        sock.close()
        raise
    return sock


def control_request(method: str, path: str, body=None, timeout=MOUNT_READ_TIMEOUT, connect=connect_control_socket) -> dict:
    """One request to the daemon's user-only control socket, where the writes live (the TCP API refuses them)."""
    unreachable = "Can't reach the Proton Drive background service"
    try:
        sock = connect()
    except OSError as err:
        raise ControlError(f"{unreachable} ({err})") from err
    try:
        sock.settimeout(timeout)
        sock.sendall(build_request(method, path, body))
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    except socket.timeout as err:
        raise ControlError("Proton Drive is still working on it in the background") from err
    except OSError as err:
        raise ControlError(f"{unreachable} ({err})") from err
    finally:
        sock.close()
    return parse_response(b"".join(chunks))


def offers_mount(status: dict) -> bool:
    """Mount is offered for a virtual drive left unmounted by an eject, a crash streak or a busy mount point; a daemon
    before the virtual drive sends no vfs, and gets no Mount item."""
    vfs = status.get("vfs")
    if not isinstance(vfs, dict):
        return False
    return vfs.get("mode") == "virtual" and not vfs.get("mounted") and vfs.get("reason") in MOUNT_REASONS


def notify(title: str, body: str) -> None:
    """A desktop notification; nothing happens if notify-send is missing."""
    try:
        spawn_detached(["notify-send", "--app-name=Proton Drive", "--icon=ch.proton.drive", title, body])
    except OSError:
        pass


def spawn_detached(argv) -> None:
    """Launch argv like Popen(start_new_session=True): own session, stdio on /dev/null,
    no inherited fds and default SIGPIPE/SIGXFSZ handling.

    A GLib child watch reaps it when it exits, so it never lingers as a zombie of this
    long-running tray. Raises OSError if argv[0] can't be executed.
    """
    file_actions = [(os.POSIX_SPAWN_OPEN, fd, os.devnull, os.O_RDWR, 0) for fd in (0, 1, 2)]
    if hasattr(os, "POSIX_SPAWN_CLOSEFROM"):  # Python 3.13+
        file_actions.append((os.POSIX_SPAWN_CLOSEFROM, 3))
    pid = os.posix_spawnp(
        argv[0],
        argv,
        os.environ,
        file_actions=file_actions,
        setsid=True,
        setsigdef=(signal.SIGPIPE, signal.SIGXFSZ),
    )
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, lambda *_: None)


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
            return f"{val:.2f} {unit}" if unit in ("GB", "TB") else f"{val:.1f} {unit}"
        val /= 1024.0
    return f"{val:.2f} TB"


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
        # The turning sync icon: the timer runs only while syncing, so an idle tray costs nothing
        self.sync_frame = 0
        self.sync_timer = 0

        self.menu = Gtk.Menu()

        self.account_item = Gtk.MenuItem(label="Proton Drive")
        self.account_item.set_sensitive(False)
        self.menu.append(self.account_item)

        self.storage_item = Gtk.MenuItem(label="Storage: Calculating...")
        self.storage_item.set_sensitive(False)
        self.menu.append(self.storage_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        self.status_item = Gtk.MenuItem(label="Status: Starting...")
        self.status_item.set_sensitive(False)
        self.menu.append(self.status_item)

        self.stats_item = Gtk.MenuItem(label="Checking local sync folder...")
        self.stats_item.set_sensitive(False)
        self.menu.append(self.stats_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        open_app_item = Gtk.MenuItem(label="Open Proton Drive")
        open_app_item.connect("activate", self.on_open_app)
        self.menu.append(open_app_item)

        open_folder_item = Gtk.MenuItem(label=OPEN_FOLDER_LABEL)
        open_folder_item.connect("activate", self.on_open_folder)
        self.menu.append(open_folder_item)

        # Shown only while the virtual drive can be mounted again (see offers_mount)
        self.mounting = False
        self.mount_item = Gtk.MenuItem(label=MOUNT_LABEL)
        self.mount_item.connect("activate", self.on_mount)
        self.mount_item.set_no_show_all(True)
        self.menu.append(self.mount_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        sync_now_item = Gtk.MenuItem(label="Sync Now")
        sync_now_item.connect("activate", self.on_sync_now)
        self.menu.append(sync_now_item)

        self.pause_item = Gtk.MenuItem(label="Pause Sync")
        self.pause_item.connect("activate", self.on_toggle_pause)
        self.menu.append(self.pause_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit Proton Drive")
        quit_item.connect("activate", self.on_quit)
        self.menu.append(quit_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

        self.poll_status()
        GLib.timeout_add_seconds(2, self.poll_status)

    def show_state(self, icon: str, description: str) -> None:
        """Shows a still state icon, ending the turning sync icon if it runs."""
        if self.sync_timer:
            GLib.source_remove(self.sync_timer)
            self.sync_timer = 0
        self.indicator.set_icon_full(icon, description)

    def show_syncing(self) -> None:
        """Starts the turning sync icon; a poll that finds it running leaves it turning."""
        if self.sync_timer:
            return
        self.indicator.set_icon_full(sync_frame_icon(self.sync_frame), "Syncing")
        self.sync_timer = GLib.timeout_add(SYNC_FRAME_MS, self.next_sync_frame)

    def next_sync_frame(self) -> bool:
        self.sync_frame = (self.sync_frame + 1) % SYNC_FRAMES
        self.indicator.set_icon_full(sync_frame_icon(self.sync_frame), "Syncing")
        return True

    def poll_status(self) -> bool:
        try:
            req = urllib.request.Request(f"{DAEMON_URL}/api/status", method="GET")
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            state = data.get("state", "idle")
            logged_in = data.get("loggedIn", False)
            settings = data.get("settings", {})
            stats = data.get("stats", {})
            account = data.get("account") or {}
            self.paused = bool(settings.get("paused", False))
            self.sync_dir = data.get("syncDir") or os.path.expanduser("~/ProtonDrive")

            display_name = account.get("displayName") or ""
            email = account.get("email") or ""
            used_space = int(account.get("usedSpace") or 0)
            max_space = int(account.get("maxSpace") or 0)

            if display_name and email:
                self.account_item.set_label(f"{display_name} ({email})")
            elif email:
                self.account_item.set_label(email)
            elif logged_in:
                self.account_item.set_label("Proton Account Connected")
            else:
                self.account_item.set_label("Proton Drive (Not Signed In)")

            if max_space > 0:
                pct = (used_space / max_space) * 100.0
                self.storage_item.set_label(
                    f"Storage: {format_bytes(used_space)} / {format_bytes(max_space)} ({pct:.1f}%)"
                )
            else:
                self.storage_item.set_label("Storage: —")

            total_files = int(stats.get("totalFiles", 0))
            total_bytes = int(stats.get("totalBytes", 0))
            self.stats_item.set_label(f"Local Sync: {format_bytes(total_bytes)}  •  {total_files} files")

            if not logged_in:
                self.show_state("protondrive-tray-error", "Sign in required")
                self.status_item.set_label("Status: Sign in required")
            elif self.paused or state == "paused":
                self.show_state("protondrive-tray-paused", "Paused")
                self.status_item.set_label("Status: Sync Paused")
            elif state == "syncing":
                action = data.get("currentAction") or "Syncing..."
                if len(action) > 42:
                    action = action[:20] + "…" + action[-18:]
                self.show_syncing()
                self.status_item.set_label(f"Syncing: {action}")
            elif state == "error":
                self.show_state("protondrive-tray-error", "Sync Error")
                self.status_item.set_label("Status: Sync Error")
            else:
                self.show_state("protondrive-tray-idle", "Up to date")
                self.status_item.set_label("Status: Up to date")

            self.pause_item.set_label("Resume Sync" if self.paused else "Pause Sync")
            self.mount_item.set_visible(offers_mount(data))
        except Exception:
            self.show_state("protondrive-tray-error", "Daemon Offline")
            self.status_item.set_label("Status: Daemon Offline")
            self.mount_item.set_visible(False)
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
                spawn_detached([bin_path])
                return
            except OSError:
                continue

    def on_open_folder(self, _widget):
        spawn_detached(["xdg-open", self.sync_dir])

    def on_mount(self, _widget):
        """POST /vfs/mount on the control socket, off the GTK thread; a failure is a notification, never a crash."""
        if self.mounting:
            return
        self.mounting = True
        self.mount_item.set_sensitive(False)
        threading.Thread(target=self._mount_in_background, daemon=True).start()

    def _mount_in_background(self):
        try:
            control_request("POST", "/vfs/mount", {})
            error = None
        except Exception as err:  # a ControlError, or anything unforeseen: reported, not raised
            error = str(err) or type(err).__name__
        GLib.idle_add(self._mount_finished, error)

    def _mount_finished(self, error):
        self.mounting = False
        self.mount_item.set_sensitive(True)
        if error:
            notify("Couldn't mount Proton Drive", error)
        self.poll_status()
        return False

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

    def on_quit(self, _widget):
        try:
            subprocess.run(
                ["pkill", "-f", "protondrive-gui"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        try:
            req = urllib.request.Request(f"{DAEMON_URL}/api/quit", method="POST")
            urllib.request.urlopen(req, timeout=1.0)
        except Exception:
            pass
        Gtk.main_quit()


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
