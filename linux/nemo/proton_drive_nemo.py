"""
Cinnamon Files (Nemo) extension for Proton Drive on Linux.

- Emblems: real item states from the daemon's /fm/states API (Always keep, Downloaded, Online only, Partial, Syncing,
  Needs attention) for the configured sync folder, updated live from /fm/events (#530).
- Right-click: Sync Now and Status & Settings… for items inside the configured sync folder.

Everything talks to the daemon off the GTK thread through the user-only control socket so Nemo never blocks and never
shows a synced mark for files that are still uploading, errored, in conflict, ignored, or outside the sync folder.
"""

import json
import os
import signal
import socket
import stat
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict

from gi.repository import Gio, GLib, GObject, Nemo


# The client functions below are the tray's (linux/tray/proton_drive_tray.py), unchanged: a test keeps them identical
CONTROL_CONNECT_TIMEOUT = 0.5
MOUNT_READ_TIMEOUT = 15.0
STATES_READ_TIMEOUT = 2.0
EVENTS_READ_TIMEOUT = 75.0  # two missed pings: the daemon is gone
EVENTS_BACKOFF = (1, 2, 4, 8, 16, 30)
CACHE_FOLDERS = 256
STALE_WITHOUT_EVENTS = 10.0  # with no change stream, a folder's states are fetched again after this
ROOT_RETRY = 5.0
TRACK_LIMIT = 20000

EMBLEMS = {
    "pinned": "emblem-protondrive-pinned",
    "downloaded": "emblem-protondrive-local",
    "partial": "emblem-protondrive-partial",
    "online-only": "emblem-protondrive-cloud",
}
SYNCING_EMBLEM = "emblem-synchronizing"
ATTENTION_EMBLEM = "emblem-important"
FALLBACK_ROOT = os.path.expanduser("~/ProtonDrive")  # for the menu only, while the daemon can't say where the drive is


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


# --- The change stream -------------------------------------------------------------------------------------------


class StreamEnded(Exception):
    """The change stream ended or failed; the reader reconnects."""


class _Reader:
    """Buffered reads from a socket."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def _fill(self):
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout as err:
            raise StreamEnded("No word from Proton Drive") from err
        except OSError as err:
            raise StreamEnded(str(err)) from err
        if not chunk:
            raise StreamEnded("The stream ended")
        self.buf += chunk

    def line(self) -> bytes:
        while b"\r\n" not in self.buf:
            self._fill()
        out, _, self.buf = self.buf.partition(b"\r\n")
        return out

    def exactly(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def read_event_stream(sock, on_event) -> None:
    """Reads GET /fm/events from a connected socket, calling on_event(dict) for each line, until it ends."""
    sock.sendall(build_request("GET", "/fm/events"))
    reader = _Reader(sock)
    status_line = reader.line().decode("latin-1")
    try:
        status = int(status_line.split()[1])
    except (IndexError, ValueError):
        raise StreamEnded("Malformed reply") from None
    chunked = False
    while True:
        header = reader.line().decode("latin-1")
        if header == "":
            break
        name, _, value = header.partition(":")
        if name.strip().lower() == "transfer-encoding" and "chunked" in value.lower():
            chunked = True
    if status != 200:
        raise StreamEnded(f"The change stream answered {status}")
    pending = b""

    def lines_of(data: bytes):
        nonlocal pending
        pending += data
        while b"\n" in pending:
            line, _, pending = pending.partition(b"\n")
            if line.strip():
                try:
                    event = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if isinstance(event, dict):
                    on_event(event)

    if not chunked:
        while True:
            reader._fill()
            data, reader.buf = reader.buf, b""
            lines_of(data)
    while True:
        size_line = reader.line().split(b";")[0].strip()
        try:
            size = int(size_line, 16)
        except ValueError:
            raise StreamEnded("Malformed chunk") from None
        if size == 0:
            raise StreamEnded("The stream ended")
        lines_of(reader.exactly(size))
        reader.exactly(2)  # the CRLF after the chunk


def follow_events(on_event, on_down, connect=connect_control_socket, sleep=time.sleep, stop=None) -> None:
    """Follows the change stream for good: reconnects after any failure, waiting longer each time (up to 30 s)."""
    failures = 0
    while not (stop and stop()):
        try:
            sock = connect()
        except (OSError, ControlError):
            sock = None
        if sock is not None:
            try:
                sock.settimeout(EVENTS_READ_TIMEOUT)

                def seen(event):
                    nonlocal failures
                    failures = 0
                    on_event(event)

                read_event_stream(sock, seen)
            except (StreamEnded, OSError):
                pass
            finally:
                sock.close()
        on_down()
        if stop and stop():
            return
        sleep(EVENTS_BACKOFF[min(failures, len(EVENTS_BACKOFF) - 1)])
        failures += 1


# --- What Nemo shows ---------------------------------------------------------------------------------------------


def emblem_for(state):
    """The emblem of an item's state from /fm/states, or None for no emblem."""
    if not isinstance(state, dict):
        return None
    transfer = state.get("transfer")
    if transfer in ("conflict", "error"):
        return ATTENTION_EMBLEM
    if transfer == "syncing":
        return SYNCING_EMBLEM
    return EMBLEMS.get(state.get("availability"))


def rel_to_root(root, path):
    """The path of a file inside the drive ('' for the drive itself), or None for one outside it."""
    if not root or not path:
        return None
    root = root.rstrip("/") or "/"
    if path == root:
        return ""
    if path.startswith(root + "/"):
        return path[len(root) + 1 :]
    return None


def is_utf8_path(path) -> bool:
    """Whether path is valid UTF-8 (GIO hands Python non-UTF-8 bytes as lone surrogates \\udc80–\\udcff)."""
    if not isinstance(path, str):
        return False
    try:
        path.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def skipped(rel: str) -> bool:
    """Files the drive keeps for itself, which never get an emblem."""
    for part in rel.split("/"):
        if part == ".xdg-volume-info" or part.startswith(".Trash-") or part.startswith(".proton-drive-tmp-"):
            return True
    return False


def is_within(path: str, top: str) -> bool:
    return path == top or path.startswith(top.rstrip("/") + "/")


class FolderCache:
    """The states of a folder's items, by its absolute path, least recently used first out."""

    def __init__(self, limit=CACHE_FOLDERS):
        self.limit = limit
        self.entries = OrderedDict()

    def get(self, folder, now, fresh_for=None):
        entry = self.entries.get(folder)
        if entry is None:
            return None
        if fresh_for is not None and now - entry["fetched_at"] > fresh_for:
            del self.entries[folder]
            return None
        self.entries.move_to_end(folder)
        return entry

    def put(self, folder, states, now):
        self.entries[folder] = {"self": states.get("self"), "children": states.get("children") or {}, "fetched_at": now}
        self.entries.move_to_end(folder)
        while len(self.entries) > self.limit:
            self.entries.popitem(last=False)

    def drop(self, folder):
        self.entries.pop(folder, None)

    def drop_within(self, top):
        for folder in [f for f in self.entries if is_within(f, top)]:
            del self.entries[folder]

    def clear(self):
        self.entries.clear()


class FileTracker:
    """The paths Nemo asked about, to find its item again and invalidate it on a change."""

    def __init__(self, lookup, limit=TRACK_LIMIT):
        self.lookup = lookup
        self.limit = limit
        self.paths = OrderedDict()

    def track(self, path):
        self.paths[path] = None
        self.paths.move_to_end(path)
        while len(self.paths) > self.limit:
            self.paths.popitem(last=False)

    def get(self, path):
        if path not in self.paths:
            return None
        file = self.lookup(path)
        if file is None:
            del self.paths[path]
        return file

    def within(self, top):
        return [f for f in (self.get(p) for p in [p for p in self.paths if is_within(p, top)]) if f is not None]

    def all(self):
        return [f for f in (self.get(p) for p in list(self.paths)) if f is not None]

    def clear(self):
        self.paths.clear()


def _transient(error):
    """Whether a failed request may well work if asked again: the daemon not reachable or not answering in time."""
    if error is None or not isinstance(error, ControlError):
        return True
    text = str(error)
    return text.startswith("Can't reach") or text.startswith("Proton Drive is still working")


class ProtonDriveNemoFiles:
    """Main-loop state for the Nemo extension: resolves real file emblems from the daemon off the GTK thread."""

    def __init__(self, request, run, clock=time.monotonic, later=None, lookup=None):
        self.request = request
        self.run = run
        self.clock = clock
        self.later = later or (lambda fn, seconds: None)
        self.root = None
        self.root_asked_at = None
        self.root_retry_due = False
        self.fetch_failures = {}
        self.stream_up = False
        self.cache = FolderCache()
        self.tracker = FileTracker(lookup or _lookup_file)
        self.waiting = {}
        self.generation = 0

    def ask_root(self):
        now = self.clock()
        if self.root_asked_at is not None and now - self.root_asked_at < ROOT_RETRY:
            return
        self.root_asked_at = now

        def done(result, error):
            if error is None and isinstance(result, dict) and isinstance(result.get("syncDir"), str):
                self.set_root(result["syncDir"])
                return
            if not self.root_retry_due:
                self.root_retry_due = True
                self.later(self.retry_root, ROOT_RETRY)

        self.run(lambda: self.request("GET", "/fm/root", None, STATES_READ_TIMEOUT), done)

    def retry_root(self):
        self.root_retry_due = False
        if self.root is None:
            self.root_asked_at = None
            self.ask_root()

    def set_root(self, sync_dir):
        if sync_dir != self.root:
            self.root = sync_dir
            self.forget_everything()

    def menu_root(self):
        return self.root or FALLBACK_ROOT

    def file_info(self, file):
        """Answers Nemo at once: the emblem now if the folder's states are known, else later through add_emblem."""
        if file.get_uri_scheme() != "file":
            return
        path = file.get_location().get_path()
        if self.root is None:
            if is_utf8_path(path):
                self.tracker.track(path)
            self.ask_root()
            return
        rel = rel_to_root(self.root, path)
        if not rel or skipped(rel) or not is_utf8_path(path):
            return
        self.tracker.track(path)
        folder = os.path.dirname(path)
        entry = self.cache.get(folder, self.clock(), None if self.stream_up else STALE_WITHOUT_EVENTS)
        if entry is not None:
            self.apply(file, path, entry)
            return
        queue = self.waiting.get(folder)
        if queue is not None:
            queue[id(file)] = file
            return
        self.waiting[folder] = {id(file): file}
        self.fetch(folder)

    def fetch(self, folder):
        generation = self.generation
        query = "/fm/states?path=" + urllib.parse.quote(folder, safe="/")

        def done(result, error):
            files = list(self.waiting.pop(folder, {}).values())
            if error is not None or not isinstance(result, dict):
                if not _transient(error):
                    self.fetch_failures.pop(folder, None)
                    return
                if len(self.fetch_failures) > 256:
                    self.fetch_failures.clear()
                failures = self.fetch_failures.get(folder, 0) + 1
                self.fetch_failures[folder] = failures
                self.later(lambda: [self.invalidate(file) for file in files], min(2**failures, 60))
                return
            self.fetch_failures.pop(folder, None)
            entry = {"self": result.get("self"), "children": result.get("children") or {}}
            if generation == self.generation:
                self.cache.put(folder, result, self.clock())
            for file in files:
                self.apply(file, file.get_location().get_path(), entry)

        self.run(lambda: self.request("GET", query, None, STATES_READ_TIMEOUT), done)

    def apply(self, file, path, entry):
        emblem = emblem_for(entry["children"].get(os.path.basename(path)))
        if emblem:
            file.add_emblem(emblem)

    def invalidate(self, file):
        if file is not None:
            try:
                file.invalidate_extension_info()
            except Exception:
                pass

    def forget_everything(self):
        self.generation += 1
        self.cache.clear()
        self.fetch_failures.clear()
        for file in self.tracker.all():
            self.invalidate(file)
        self.tracker.clear()

    def on_event(self, event):
        kind = event.get("type")
        if kind in ("hello", "reset"):
            self.stream_up = True
            sync_dir = event.get("syncDir")
            if isinstance(sync_dir, str) and sync_dir != self.root:
                self.set_root(sync_dir)
            else:
                self.forget_everything()
            return
        if kind != "changed":
            return
        self.stream_up = True
        self.generation += 1
        stale = {}
        for path in event.get("paths") or []:
            self.cache.drop(path)
            self.cache.drop(os.path.dirname(path))
            file = self.tracker.get(path)
            if file is not None:
                stale[id(file)] = file
        for top in event.get("subtrees") or []:
            self.cache.drop(os.path.dirname(top))
            self.cache.drop_within(top)
            for file in self.tracker.within(top):
                stale[id(file)] = file
        for file in stale.values():
            self.invalidate(file)

    def on_stream_down(self):
        self.stream_up = False


# --- Nemo --------------------------------------------------------------------------------------------------------


def _spawn_detached(argv) -> None:
    # Like Popen(start_new_session=True): own session, stdio on /dev/null, none of Nemo's fds
    # and default SIGPIPE/SIGXFSZ. The GLib child watch reaps it so it never lingers as a
    # zombie of the long-lived Nemo process. Raises OSError if argv[0] can't be executed.
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


def _lookup_file(path):
    """The item Nemo has at path now, or None if it has none."""
    try:
        return Nemo.FileInfo.lookup(Gio.File.new_for_path(path))
    except Exception:
        return None


def _later(fn, seconds):
    def call():
        fn()
        return False

    GLib.timeout_add_seconds(max(1, int(seconds)), call)


class GilPump:
    """Lets worker threads run while Nemo's C main loop holds the GIL."""

    BUSY_MS = 10
    IDLE_MS = 200
    SLICE = 0.002

    def __init__(self, add_timeout, sleep=time.sleep):
        self.add_timeout = add_timeout
        self.sleep = sleep
        self.busy = 0
        self.fast = False
        self.add_timeout(self.IDLE_MS, self.give)

    def give(self):
        self.sleep(self.SLICE)
        return True

    def begin(self):
        self.busy += 1
        if not self.fast:
            self.fast = True
            self.add_timeout(self.BUSY_MS, self._give_while_busy)

    def end(self):
        self.busy = max(0, self.busy - 1)

    def _give_while_busy(self):
        self.give()
        if self.busy > 0:
            return True
        self.fast = False
        return False


_pump = None


def _run_in_thread(work, done):
    """work() on a worker thread, then done(result, error) on the main loop."""
    if _pump is not None:
        _pump.begin()

    def main():
        try:
            result, error = work(), None
        except Exception as err:
            result, error = None, err

        def deliver():
            if _pump is not None:
                _pump.end()
            done(result, error)
            return False

        GLib.idle_add(deliver, priority=GLib.PRIORITY_DEFAULT)

    threading.Thread(target=main, name="proton-drive-nemo-request", daemon=True).start()


def _socket_request(method, path, body, timeout):
    return control_request(method, path, body, timeout=timeout)


def _on_main_loop(fn, *args):
    def call():
        fn(*args)
        return False

    GLib.idle_add(call, priority=GLib.PRIORITY_DEFAULT)


class ProtonDriveNemoExtension(GObject.GObject, Nemo.MenuProvider, Nemo.InfoProvider):
    def __init__(self):
        super().__init__()
        global _pump
        if _pump is None:
            _pump = GilPump(GLib.timeout_add)
        self.files = ProtonDriveNemoFiles(
            request=_socket_request,
            run=_run_in_thread,
            later=_later,
        )
        self.files.ask_root()
        threading.Thread(
            target=follow_events,
            args=(
                lambda event: _on_main_loop(self.files.on_event, event),
                lambda: _on_main_loop(self.files.on_stream_down),
            ),
            name="proton-drive-nemo-events",
            daemon=True,
        ).start()

    def update_file_info(self, file):
        self.files.file_info(file)
        return Nemo.OperationResult.COMPLETE

    def update_file_info_full(self, provider, handle, closure, file):
        self.files.file_info(file)
        return Nemo.OperationResult.COMPLETE

    def cancel_update(self, provider, handle):
        pass

    def get_file_items(self, *args):
        files = args[-1] if args else []
        if not files:
            return []
        root = self.files.menu_root()
        for f in files:
            if f.get_uri_scheme() != "file":
                return []
            filepath = f.get_location().get_path()
            if rel_to_root(root, filepath) is None:
                return []

        sync_item = Nemo.MenuItem(
            name="ProtonDriveNemo::SyncNow",
            label="Proton Drive: Sync Now",
            tip="Trigger an immediate Proton Drive sync pass",
        )
        sync_item.connect("activate", self._on_sync_now)

        gui_item = Nemo.MenuItem(
            name="ProtonDriveNemo::OpenGui",
            label="Proton Drive: Status & Settings…",
            tip="Open the Proton Drive app: how sync is going, what needs you, and its settings",
        )
        gui_item.connect("activate", self._on_open_gui)
        return [sync_item, gui_item]

    def _on_sync_now(self, _menu):
        def work():
            req = urllib.request.Request("http://127.0.0.1:49152/api/sync", method="POST")
            urllib.request.urlopen(req, timeout=2).close()

        def done(_result, error):
            if error is not None:
                try:
                    _spawn_detached(["protondrive", "sync"])
                except OSError:
                    pass

        _run_in_thread(work, done)

    def _on_open_gui(self, _menu):
        try:
            _spawn_detached(["protondrive-gui", "--tab", "home"])
        except OSError:
            pass
