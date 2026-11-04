#!/usr/bin/env python3
"""
Proton Drive Top-Bar / System Tray Status Indicator for Linux.
Supports AyatanaAppIndicator3 and AppIndicator3 across GNOME, KDE, XFCE, Cinnamon, MATE.
"""
import datetime
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
# #98: the drive itself is what people open most; the app is where they check on sync and change how it behaves
OPEN_DRIVE_LABEL = "Open Proton Drive"
VIEW_ONLINE_LABEL = "View Online"
ONLINE_URL = "https://drive.proton.me"
APP_LABEL = "Status & Settings…"
# A delete through the drive goes to the Proton Drive trash, on the web (#201)
OPEN_TRASH_LABEL = "Open Proton Drive Trash"
TRASH_URL = "https://drive.proton.me/trash"

# #205: what Pause Sync offers, and the request each sends (pause_body)
PAUSE_CHOICES = (("For 1 hour", "hour"), ("Until tomorrow", "tomorrow"), ("Until I resume", "resume"))
RESUME_LABEL = "Resume Sync"
_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _ms(moment: datetime.datetime) -> int:
    return int(moment.timestamp() * 1000)


def tomorrow_at_eight(now: datetime.datetime) -> int:
    """Tomorrow at 08:00 local time (now is local), in epoch ms."""
    day = now.date() + datetime.timedelta(days=1)
    return _ms(datetime.datetime(day.year, day.month, day.day, 8, 0))


def pause_body(choice: str, now: datetime.datetime) -> dict:
    """The POST /api/pause body for a choice: an hour from now, tomorrow at 08:00, or until resumed (no time)."""
    if choice == "hour":
        return {"paused": True, "until": _ms(now) + 3_600_000}
    if choice == "tomorrow":
        return {"paused": True, "until": tomorrow_at_eight(now)}
    return {"paused": True}


def paused_line(until_ms, now: datetime.datetime) -> str:
    """How long a pause lasts, as the app's Home says it (native-gui/src/home.rs paused_headline): Paused until 15:00
    (today), Paused until tomorrow 08:00, Paused until Mon 08:00 (a later day); Paused with no time."""
    if not isinstance(until_ms, (int, float)) or isinstance(until_ms, bool) or until_ms <= 0:
        return "Paused"
    until = datetime.datetime.fromtimestamp(until_ms / 1000)
    clock = until.strftime("%H:%M")
    days = (until.date() - now.date()).days
    if days <= 0:
        return f"Paused until {clock}"
    if days == 1:
        return f"Paused until tomorrow {clock}"
    return f"Paused until {_WEEKDAYS[until.weekday()]} {clock}"


def trash_tooltip(sync_dir: str) -> str:
    """What the trash item says on hover: as the app says it, naming the sync folder (with ~ for the home folder)."""
    home = os.path.expanduser("~")
    shown = "~" + sync_dir[len(home):] if sync_dir == home or sync_dir.startswith(home + os.sep) else sync_dir
    return (
        "Deleted files stay here until you empty the trash or restore them. "
        f"Restoring brings them back to {shown}."
    )
# Why a virtual drive can be mounted again (the daemon's vfs.reason); POST /vfs/mount refuses the rest
MOUNT_REASONS = ("ejected", "crashed", "mount-point-busy")
CONTROL_CONNECT_TIMEOUT = 2.0
# Mounting readies the mount point first; past this the daemon is still at it, and the menu says so on the next poll
MOUNT_READ_TIMEOUT = 15.0


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


# A GTK menu grows with its longest label: a file name longer than this is shortened in the middle
NAME_LIMIT = 40


def _short(name: str) -> str:
    if len(name) <= NAME_LIMIT:
        return name
    keep = NAME_LIMIT - 1
    return name[: keep - keep // 2] + "…" + name[-(keep // 2):]


def signed_out(status: dict) -> bool:
    return not status.get("loggedIn", False) or status.get("state") == "unauthenticated"


def _transfers_line(transfers) -> str:
    """What moves, as the app's Home says it."""
    uploads = sum(1 for t in transfers if t.get("direction") == "upload")
    downloads = sum(1 for t in transfers if t.get("direction") == "download")
    if uploads == 0 and downloads == 0:
        return "Checking for changes…"
    if uploads and downloads:
        return f"Syncing {uploads + downloads} files"
    count, verb = (uploads, "Uploading") if uploads else (downloads, "Downloading")
    if count == 1:
        name = next(t for t in transfers if t.get("direction") in ("upload", "download")).get("relPath") or ""
        name = name.rstrip("/").rsplit("/", 1)[-1]
        return f"{verb} {_short(name)}" if name else f"{verb} 1 file"
    return f"{verb} {count} files"


def problem_count(status: dict) -> int:
    """How many things need the user, counted as the app's Needs attention lists them: another account's records,
    files missing, a stopped move, the drive not mounted, each unresolved conflict, failed files (one line), and the
    last error when neither another account nor missing files explains it."""
    count = 0
    if status.get("accountMismatch"):
        count += 1
    if status.get("filesMissing"):
        count += 1
    vfs = status.get("vfs")
    if isinstance(vfs, dict):
        reason = vfs.get("reason")
        move = vfs.get("move")
        move_to_act_on = isinstance(move, dict) and (move.get("actions") or str(move.get("error") or "").strip())
        if move_to_act_on or reason == "move-failed":
            count += 1
        if vfs.get("mode") == "virtual" and not vfs.get("mounted") and reason not in ("move-failed", "starting", "moving"):
            count += 1
    stats = status.get("stats") or {}
    count += int(stats.get("unresolvedConflicts") or 0)
    if int(stats.get("errorItems") or 0) > 0:
        count += 1
    if not status.get("filesMissing") and not status.get("accountMismatch") and str(status.get("lastError") or "").strip():
        count += 1
    return count


def status_line(status: dict, now=None):
    """The tray's status line and icon, in the app's words (native-gui/src/home.rs status_summary): signed out, paused,
    moving files, what moves, problems, sync stopped, up to date. Never the engine's own action text."""
    if signed_out(status):
        return "Signed out", "protondrive-tray-error"
    settings = status.get("settings") or {}
    if status.get("state") == "paused" or settings.get("paused"):
        return paused_line(settings.get("pausedUntil"), now or datetime.datetime.now()), "protondrive-tray-paused"
    vfs = status.get("vfs")
    if isinstance(vfs, dict) and vfs.get("reason") == "moving":
        return "Moving files…", "protondrive-tray-syncing"
    if status.get("state") == "syncing":
        return _transfers_line(status.get("activeTransfers") or []), "protondrive-tray-syncing"
    if problem_count(status):
        # The count is on the clickable item just below (problems_label), so this line doesn't repeat it
        return "Needs attention", "protondrive-tray-error"
    if status.get("state") == "error":
        return "Sync stopped", "protondrive-tray-error"
    return "Up to date", "protondrive-tray-idle"


def problems_label(count: int) -> str:
    """The menu item that opens the app on Home, where the problems are listed."""
    return "⚠ 1 problem needs you" if count == 1 else f"⚠ {count} problems need you"


def _one_decimal(b: int) -> str:
    """Bytes with one decimal, in 1024s, as the app shows storage."""
    val = float(b)
    for unit in ("B", "KB", "MB", "GB"):
        if val < 1024.0:
            return f"{int(val)} B" if unit == "B" else f"{val:.1f} {unit}"
        val /= 1024.0
    return f"{val:.1f} TB"


def storage_line(account: dict):
    """'13.6 GB of 510.0 GB used', or None while the account's storage isn't known."""
    used, total = int(account.get("usedSpace") or 0), int(account.get("maxSpace") or 0)
    if total <= 0:
        return None
    return f"{_one_decimal(used)} of {_one_decimal(total)} used"


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

        # What is going on, greyed: the same status line as the app's Home, and the storage
        self.status_item = Gtk.MenuItem(label="Starting…")
        self.status_item.set_sensitive(False)
        self.menu.append(self.status_item)

        self.storage_item = Gtk.MenuItem(label="")
        self.storage_item.set_sensitive(False)
        self.storage_item.set_no_show_all(True)
        self.menu.append(self.storage_item)

        # Only while something needs the user: opens the app, whose Home lists it
        self.problems_item = Gtk.MenuItem(label="")
        self.problems_item.connect("activate", self.on_open_app)
        self.problems_item.set_no_show_all(True)
        self.menu.append(self.problems_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        open_drive_item = Gtk.MenuItem(label=OPEN_DRIVE_LABEL)
        open_drive_item.connect("activate", self.on_open_drive)
        self.menu.append(open_drive_item)

        view_online_item = Gtk.MenuItem(label=VIEW_ONLINE_LABEL)
        view_online_item.connect("activate", self.on_view_online)
        self.menu.append(view_online_item)

        self.open_trash_item = Gtk.MenuItem(label=OPEN_TRASH_LABEL)
        self.open_trash_item.set_tooltip_text(trash_tooltip(self.sync_dir))
        self.open_trash_item.connect("activate", self.on_open_trash)
        self.menu.append(self.open_trash_item)

        # Shown only while the virtual drive can be mounted again (see offers_mount)
        self.mounting = False
        self.mount_item = Gtk.MenuItem(label=MOUNT_LABEL)
        self.mount_item.connect("activate", self.on_mount)
        self.mount_item.set_no_show_all(True)
        self.menu.append(self.mount_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        app_item = Gtk.MenuItem(label=APP_LABEL)
        app_item.connect("activate", self.on_open_app)
        self.menu.append(app_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        sync_now_item = Gtk.MenuItem(label="Sync Now")
        sync_now_item.connect("activate", self.on_sync_now)
        self.menu.append(sync_now_item)

        # #205: while not paused, Pause Sync opens its choices; while paused, Resume Sync shows in its place
        self.pause_item = Gtk.MenuItem(label="Pause Sync")
        pause_menu = Gtk.Menu()
        for label, choice in PAUSE_CHOICES:
            item = Gtk.MenuItem(label=label)
            item.connect("activate", self.on_pause_choice, choice)
            pause_menu.append(item)
        self.pause_item.set_submenu(pause_menu)
        self.menu.append(self.pause_item)

        self.resume_item = Gtk.MenuItem(label=RESUME_LABEL)
        self.resume_item.connect("activate", self.on_resume)
        self.resume_item.set_no_show_all(True)
        self.menu.append(self.resume_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit Proton Drive")
        quit_item.connect("activate", self.on_quit)
        self.menu.append(quit_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

        self.poll_status()
        GLib.timeout_add_seconds(2, self.poll_status)

    def poll_status(self) -> bool:
        try:
            req = urllib.request.Request(f"{DAEMON_URL}/api/status", method="GET")
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            settings = data.get("settings") or {}
            self.paused = bool(settings.get("paused", False)) or data.get("state") == "paused"
            sync_dir = data.get("syncDir") or os.path.expanduser("~/ProtonDrive")
            if sync_dir != self.sync_dir:
                self.sync_dir = sync_dir
                self.open_trash_item.set_tooltip_text(trash_tooltip(sync_dir))

            text, icon = status_line(data)
            self.status_item.set_label(text)
            self.indicator.set_icon_full(icon, text)

            storage = storage_line(data.get("account") or {})
            self.storage_item.set_label(storage or "")
            self.storage_item.set_visible(storage is not None)

            problems = 0 if signed_out(data) else problem_count(data)
            self.problems_item.set_label(problems_label(problems))
            self.problems_item.set_visible(problems > 0)

            self.pause_item.set_visible(not self.paused)
            self.resume_item.set_visible(self.paused)
            self.mount_item.set_visible(offers_mount(data))
        except Exception:
            offline = "Can't reach Proton Drive's background service"
            self.indicator.set_icon_full("protondrive-tray-error", offline)
            self.status_item.set_label(offline)
            self.storage_item.set_visible(False)
            self.problems_item.set_visible(False)
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
                # On Home, where what needs the user is listed; a running app just comes to the front
                spawn_detached([bin_path, "--tab", "home"])
                return
            except OSError:
                continue

    def on_open_drive(self, _widget):
        """The drive itself, in Files (#98)."""
        spawn_detached(["xdg-open", self.sync_dir])

    def on_view_online(self, _widget):
        spawn_detached(["xdg-open", ONLINE_URL])

    def on_open_trash(self, _widget):
        spawn_detached(["xdg-open", TRASH_URL])

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

    def on_pause_choice(self, _widget, choice):
        self._post_pause(pause_body(choice, datetime.datetime.now()))

    def on_resume(self, _widget):
        self._post_pause({"paused": False})

    def _post_pause(self, body):
        try:
            payload = json.dumps(body).encode("utf-8")
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
