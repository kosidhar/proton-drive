"""
GNOME Files (Nautilus) extension for Proton Drive on Linux.

- Emblems: what is on this computer (Always keep, Downloaded, Online only), and what is syncing or needs attention.
- Right-click: Always keep on this device, Free up space, Hide from this computer; Sync Now and Open Proton Drive.
- Emblems follow changes by themselves, from the daemon's change stream.

Everything goes through the daemon's user-only control socket (never the TCP API), off the GTK thread: Files never
waits on the daemon. Only the main loop touches the state below; worker threads do the socket I/O and hand their
results back through GLib.idle_add.
"""

import json
import os
import signal
import socket
import stat
import sys
import threading
import time
import types
import urllib.parse
import urllib.request
import weakref
from collections import OrderedDict

from gi.repository import GLib, GObject, Nautilus

DAEMON_URL = os.environ.get("PROTON_DRIVE_DAEMON_URL", "http://127.0.0.1:49152")

# The client functions below are the tray's (linux/tray/proton_drive_tray.py), unchanged: a test keeps them identical
CONTROL_CONNECT_TIMEOUT = 0.5
MOUNT_READ_TIMEOUT = 15.0
STATES_READ_TIMEOUT = 2.0
ACTION_READ_TIMEOUT = 600.0  # a Free up space of a big folder, or a Hide waiting for its uploads, takes a while
EVENTS_READ_TIMEOUT = 75.0  # two missed pings: the daemon is gone
EVENTS_BACKOFF = (1, 2, 4, 8, 16, 30)
CACHE_FOLDERS = 256
STALE_WITHOUT_EVENTS = 10.0  # with no change stream, a folder's states are fetched again after this
ROOT_RETRY = 5.0
TRACK_LIMIT = 20000

EMBLEMS = {
    "pinned": "emblem-protondrive-pinned",
    "downloaded": "emblem-protondrive-local",
    "online-only": "emblem-protondrive-cloud",
}
SYNCING_EMBLEM = "emblem-synchronizing"
ATTENTION_EMBLEM = "emblem-important"
FALLBACK_ROOT = os.path.expanduser("~/ProtonDrive")  # for the menu only, while the daemon can't say where the drive is

PIN_LABEL = "Always keep on this device"
FREE_LABEL = "Free up space"
HIDE_LABEL = "Hide from this computer"
NOT_RUNNING = "Proton Drive isn't running"

UNKNOWN = object()  # a state not fetched yet (None is "no emblem": a local item matching an ignore pattern)


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
    """Reads GET /fm/events from a connected socket, calling on_event(dict) for each line, until it ends (raises
    StreamEnded). Bun sends the stream chunked; a reply that isn't 200 raises at once."""
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
    """Follows the change stream for good: reconnects after any failure, waiting longer each time (up to 30 s), and
    says so through on_down. stop() true ends it (for tests)."""
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


# --- What Files shows ---------------------------------------------------------------------------------------------


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


def skipped(rel: str) -> bool:
    """Files the drive keeps for itself, which never get an emblem or a menu."""
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
    """The FileInfo Files last asked about at each path, held weakly where it can be, to invalidate on a change."""

    def __init__(self, limit=TRACK_LIMIT):
        self.limit = limit
        self.refs = OrderedDict()

    def track(self, path, file):
        try:
            ref = weakref.ref(file)
        except TypeError:
            ref = lambda f=file: f  # noqa: E731 (bounded by the limit)
        self.refs[path] = ref
        self.refs.move_to_end(path)
        while len(self.refs) > self.limit:
            self.refs.popitem(last=False)

    def get(self, path):
        ref = self.refs.get(path)
        file = ref() if ref else None
        if ref and file is None:
            del self.refs[path]
        return file

    def within(self, top):
        return [f for f in (self.get(p) for p in [p for p in self.refs if is_within(p, top)]) if f is not None]

    def all(self):
        return [f for f in (self.get(p) for p in list(self.refs)) if f is not None]

    def prune(self):
        for path in list(self.refs):
            self.get(path)

    def clear(self):
        self.refs.clear()


def summarize(names, limit=3):
    shown = ", ".join(names[:limit])
    return shown if len(names) <= limit else f"{shown} and {len(names) - limit} more"


class ProtonDriveFiles:
    """What the extension knows and does, apart from Nautilus: everything here runs on the main loop. request(method,
    path, body, timeout) talks to the control socket, run(work, done) runs work() on a worker thread and done(result,
    error) back on the main loop, notify(title, body) tells the user, complete(handle, closure, ok) finishes an
    asynchronous emblem update."""

    def __init__(self, request, run, notify, complete, clock=time.monotonic, later=None):
        self.request = request
        self.run = run
        self.notify = notify
        self.complete = complete
        self.clock = clock
        self.later = later or (lambda fn, seconds: None)  # later(fn, seconds): fn on the main loop that much later
        self.root = None
        self.root_asked_at = None
        self.root_waiting = []  # [(handle, closure, file)] asked about before the root was known
        self.root_in_flight = False
        self.root_retry_due = False
        self.fetch_failures = {}  # folder -> how many fetches of its states failed in a row
        self.stream_up = False
        self.cache = FolderCache()
        self.tracker = FileTracker()
        self.waiting = {}  # folder -> [(handle, closure, file)] waiting for its states
        self.generation = 0  # bumped by every change, so a fetch that started before it isn't cached
        self.busy = set()  # paths an action is working on, shown as syncing

    # Where the drive is

    def ask_root(self):
        now = self.clock()
        if self.root_asked_at is not None and now - self.root_asked_at < ROOT_RETRY:
            return
        self.root_asked_at = now
        self.root_in_flight = True

        def done(result, error):
            self.root_in_flight = False
            if error is None and isinstance(result, dict) and isinstance(result.get("syncDir"), str):
                self.set_root(result["syncDir"])
                return
            # Not known yet (the daemon starting, say): what waited gets no emblem for now, but is tracked, so that the
            # root arriving later refreshes it (forget_everything); and the root is asked for again
            for handle, closure, file in self.root_waiting:
                if file.get_uri_scheme() == "file":
                    self.tracker.track(file.get_location().get_path(), file)
                self.complete(handle, closure, False)
            self.root_waiting = []
            if not self.root_retry_due:
                self.root_retry_due = True
                self.later(self.retry_root, ROOT_RETRY)

        self.run(lambda: self.request("GET", "/fm/root", None, STATES_READ_TIMEOUT), done)

    def retry_root(self):
        self.root_retry_due = False
        if self.root is None:
            self.root_asked_at = None
            self.ask_root()

    def answer_root_waiting(self):
        """The root is known: what was asked about before it gets its emblem now (#86)."""
        waiting, self.root_waiting = self.root_waiting, []
        for handle, closure, file in waiting:
            if self.file_info(file, handle, closure):
                self.complete(handle, closure, True)

    def set_root(self, sync_dir):
        if sync_dir != self.root:
            self.root = sync_dir
            self.forget_everything()
        # However the root became known (its answer, or the change stream's hello), what waited for it is answered
        self.answer_root_waiting()

    # Emblems

    def file_info(self, file, handle, closure):
        """True when done at once, False when the emblem comes later through complete()."""
        if file.get_uri_scheme() != "file":
            return True
        path = file.get_location().get_path()
        if self.root is None:
            self.ask_root()
            if self.root_in_flight:
                # Answered once the root is known (#86): answering "no emblem" now left it without one until a refresh
                self.root_waiting.append((handle, closure, file))
                return False
            # Not being asked right now (the daemon isn't running, say): no emblem for now, without holding Files up;
            # tracked, so that the root arriving refreshes it
            self.tracker.track(path, file)
            return True
        rel = rel_to_root(self.root, path)
        if not rel or skipped(rel):
            return True
        self.tracker.track(path, file)
        folder = os.path.dirname(path)
        entry = self.cache.get(folder, self.clock(), None if self.stream_up else STALE_WITHOUT_EVENTS)
        if entry is not None:
            self.apply(file, path, entry)
            return True
        queue = self.waiting.get(folder)
        if queue is not None:
            queue.append((handle, closure, file))
            return False
        self.waiting[folder] = [(handle, closure, file)]
        self.fetch(folder)
        return False

    def fetch(self, folder):
        generation = self.generation
        query = "/fm/states?path=" + urllib.parse.quote(folder, safe="/")

        def done(result, error):
            queue = self.waiting.pop(folder, [])
            if error is not None or not isinstance(result, dict):
                for handle, closure, _file in queue:
                    self.complete(handle, closure, False)
                if not _transient(error):
                    self.fetch_failures.pop(folder, None)  # an answer, like "not a folder in Proton Drive": not asked again
                    return
                # Asked again a little later, waiting longer after each failure in a row: the files are invalidated, so
                # Files asks about them again (#86)
                if len(self.fetch_failures) > 256:
                    self.fetch_failures.clear()  # folders left while the daemon was away: kept bounded
                failures = self.fetch_failures.get(folder, 0) + 1
                self.fetch_failures[folder] = failures
                files = [file for _handle, _closure, file in queue]
                self.later(lambda: [self.invalidate(file) for file in files], min(2 ** failures, 60))
                return
            self.fetch_failures.pop(folder, None)
            entry = {"self": result.get("self"), "children": result.get("children") or {}}
            if generation == self.generation:
                self.cache.put(folder, result, self.clock())
            for handle, closure, file in queue:
                self.apply(file, file.get_location().get_path(), entry)
                self.complete(handle, closure, True)

        self.run(lambda: self.request("GET", query, None, STATES_READ_TIMEOUT), done)

    def apply(self, file, path, entry):
        if path in self.busy:
            file.add_emblem(SYNCING_EMBLEM)
            return
        emblem = emblem_for(entry["children"].get(os.path.basename(path)))
        if emblem:
            file.add_emblem(emblem)

    def cancel(self, handle):
        for queue in self.waiting.values():
            queue[:] = [item for item in queue if item[0] is not handle]
        self.root_waiting = [item for item in self.root_waiting if item[0] is not handle]

    def state_of(self, path):
        entry = self.cache.get(os.path.dirname(path), self.clock(), None if self.stream_up else STALE_WITHOUT_EVENTS)
        if entry is None:
            return UNKNOWN
        return entry["children"].get(os.path.basename(path), UNKNOWN)

    # The menu

    def menu_root(self):
        return self.root or FALLBACK_ROOT

    def selection(self, paths):
        """'outside' when anything selected is outside the drive (no menu), 'drive' when it holds the drive itself or a
        file the drive keeps for itself (Sync Now and Open only), else 'items' (the availability actions too)."""
        root = self.menu_root()
        kind = "items"
        for path in paths:
            rel = rel_to_root(root, path) if path else None
            if rel is None:
                return "outside"
            if rel == "" or skipped(rel):
                kind = "drive"
        return kind

    def actions_for(self, paths):
        """Which of pin, free and hide to offer for a selection inside the drive (see the plan's Task 5)."""
        states = [self.state_of(p) for p in paths]
        acting = [s for s in states if s is not None]
        if not acting:
            return []
        known = lambda s: s is not UNKNOWN  # noqa: E731
        actions = []
        if not all(known(s) and s.get("availability") == "pinned" for s in acting):
            actions.append("pin")
        if any(not known(s) or s.get("availability") in ("pinned", "downloaded") for s in acting):
            actions.append("free")
        actions.append("hide")
        return actions

    def act(self, action, paths):
        root = self.menu_root()
        targets = [p for p in paths if self.state_of(p) is not None]
        rels = [rel_to_root(root, p) for p in targets]
        for path in targets:
            self.busy.add(path)
            self.invalidate(self.tracker.get(path))

        def work():
            results = []
            for path, rel in zip(targets, rels):
                try:
                    results.append((path, self.request("POST", "/availability", {"path": rel, "action": action}, ACTION_READ_TIMEOUT), None))
                except ControlError as err:
                    results.append((path, None, str(err)))
                    if str(err).startswith("Can't reach"):
                        break
            return results

        def done(results, error):
            for path in targets:
                self.busy.discard(path)
                self.cache.drop(os.path.dirname(path))
                self.invalidate(self.tracker.get(path))
            if error is not None:
                results = [(targets[0] if targets else "", None, str(error))]
            self.report(action, results or [])

        self.run(work, done)

    def report(self, action, results):
        failed = [(p, e) for p, _r, e in results if e is not None]
        if any(e.startswith("Can't reach") for _p, e in failed):
            self.notify(NOT_RUNNING, "Start Proton Drive, then try again.")
            return
        kept = 0
        for path, result, _e in results:
            if not isinstance(result, dict):
                continue
            if result.get("refused"):
                self.notify(f"Can't hide {os.path.basename(path)}", str(result["refused"]))
            kept += len(result.get("kept") or [])
        if kept:
            self.notify(f"Kept {kept} item(s) on this computer", "They aren't in Proton Drive yet.")
        if failed:
            names = [os.path.basename(p) for p, _e in failed]
            self.notify(f"Proton Drive couldn't change {summarize(names)}", failed[0][1])

    # Changes

    def invalidate(self, file):
        if file is not None:
            try:
                file.invalidate_extension_info()
            except Exception:  # a FileInfo Files let go of meanwhile
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
        self.tracker.prune()
        stale = {}  # each file once, however many paths of the change name it
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


# --- Nautilus ----------------------------------------------------------------------------------------------------


def _query_daemon(endpoint: str, method: str = "GET"):
    try:
        req = urllib.request.Request(f"{DAEMON_URL}{endpoint}", method=method)
        with urllib.request.urlopen(req, timeout=0.35) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _spawn_detached(argv) -> None:
    # Like Popen(start_new_session=True): own session, stdio on /dev/null, none of Nautilus's
    # fds and default SIGPIPE/SIGXFSZ. The GLib child watch reaps it so it never lingers as a
    # zombie of the long-lived Nautilus service. Raises OSError if argv[0] can't be executed.
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


def _notify(title: str, body: str) -> None:
    try:
        _spawn_detached(["notify-send", "--app-name=Proton Drive", "--icon=ch.proton.drive", title, body])
    except OSError:
        pass


def _launch_native_gui():
    candidates = [
        os.path.expanduser("~/.local/bin/protondrive-gui"),
        "/usr/bin/protondrive-gui",
        "protondrive-gui",
    ]
    for bin_path in candidates:
        try:
            _spawn_detached([bin_path])
            return
        except OSError:
            continue


def _transient(error):
    """Whether a failed request may well work if asked again: the daemon not reachable or not answering in time."""
    if error is None or not isinstance(error, ControlError):
        return True  # no error but no answer either, or something unexpected
    text = str(error)
    return text.startswith("Can't reach") or text.startswith("Proton Drive is still working")


def _later(fn, seconds):
    """fn() on the main loop, that many seconds from now."""

    def call():
        fn()
        return False

    GLib.timeout_add_seconds(max(1, int(seconds)), call)


def _run_in_thread(work, done):
    """work() on a worker thread, then done(result, error) on the main loop."""

    def main():
        try:
            result, error = work(), None
        except Exception as err:  # every failure is reported, never raised into Nautilus
            result, error = None, err

        def deliver():
            done(result, error)
            return False

        GLib.idle_add(deliver)

    threading.Thread(target=main, name="proton-drive-request", daemon=True).start()


def _socket_request(method, path, body, timeout):
    return control_request(method, path, body, timeout=timeout)


def _on_main_loop(fn, *args):
    def call():
        fn(*args)
        return False

    GLib.idle_add(call)


class ProtonDriveNautilusExtension(
    GObject.GObject,
    Nautilus.InfoProvider,
    Nautilus.MenuProvider,
):
    def __init__(self):
        super().__init__()
        self.files = ProtonDriveFiles(
            request=_socket_request,
            run=_run_in_thread,
            notify=_notify,
            complete=self._complete,
            later=_later,
        )
        self.files.ask_root()
        threading.Thread(
            target=follow_events,
            args=(lambda event: _on_main_loop(self.files.on_event, event), lambda: _on_main_loop(self.files.on_stream_down)),
            name="proton-drive-events",
            daemon=True,
        ).start()

    def _complete(self, handle, closure, ok):
        result = Nautilus.OperationResult.COMPLETE if ok else Nautilus.OperationResult.FAILED
        Nautilus.info_provider_update_complete_invoke(closure, self, handle, result)

    def update_file_info_full(self, provider, handle, closure, file):
        if self.files.file_info(file, handle, closure):
            return Nautilus.OperationResult.COMPLETE
        return Nautilus.OperationResult.IN_PROGRESS

    def cancel_update(self, provider, handle):
        self.files.cancel(handle)

    def get_file_items(self, *args):
        _neutralize_legacy_extension()
        files = args[-1] if args else []
        if not files:
            return []
        paths = [f.get_location().get_path() if f.get_uri_scheme() == "file" else None for f in files]
        kind = self.files.selection(paths)
        if kind == "outside":
            return []
        items = []
        labels = {
            "pin": (PIN_LABEL, "Download and keep these on this computer, including what is added later"),
            "free": (FREE_LABEL, "Remove the copies on this computer; they stay in Proton Drive"),
            "hide": (HIDE_LABEL, "Remove these from this computer and from Files; unhide them in the Proton Drive app"),
        }
        for action in self.files.actions_for(paths) if kind == "items" else []:
            label, tip = labels[action]
            item = Nautilus.MenuItem(name=f"ProtonDrive::{action.capitalize()}", label=label, tip=tip)
            item.connect("activate", lambda _menu, a=action: self.files.act(a, paths))
            items.append(item)

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

        return items + [sync_item, open_app_item]

    def get_background_items(self, *args):
        _neutralize_legacy_extension()
        folder = args[-1] if args else None
        if folder is not None and hasattr(folder, "get_location"):
            folder_path = folder.get_location().get_path()
            if rel_to_root(self.files.menu_root(), folder_path) is None:
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
        threading.Thread(target=_query_daemon, args=("/api/sync", "POST"), daemon=True).start()

    def _on_open_app(self, _menu):
        _launch_native_gui()
