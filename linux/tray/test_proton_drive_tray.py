#!/usr/bin/env python3
"""Tests of the tray's control socket requests and its Mount item, without GTK, a desktop or a real socket.

Run: python3 linux/tray/test_proton_drive_tray.py
"""
import datetime
import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))


def load_tray():
    """Imports the tray with stand-ins for GTK and the indicator library, so only its plain functions run."""
    gi = types.ModuleType("gi")
    gi.require_version = lambda *_args: None
    repository = types.ModuleType("gi.repository")
    for name in ("GLib", "Gtk", "AyatanaAppIndicator3"):
        setattr(repository, name, mock.MagicMock())
    gi.repository = repository
    with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
        spec = importlib.util.spec_from_file_location("proton_drive_tray", os.path.join(HERE, "proton_drive_tray.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


tray = load_tray()


class FakeSocket:
    """Answers one request with canned bytes, in pieces, and records what was sent."""

    def __init__(self, reply=b"", fail_with=None):
        self.chunks = [reply[i : i + 7] for i in range(0, len(reply), 7)]
        self.fail_with = fail_with
        self.sent = b""
        self.timeout = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.sent += data

    def recv(self, _size):
        if self.fail_with is not None:
            raise self.fail_with
        return self.chunks.pop(0) if self.chunks else b""

    def close(self):
        self.closed = True


class ControlSocketPathTest(unittest.TestCase):
    def test_follows_the_daemons_rule(self):
        self.assertEqual(
            tray.control_socket_path({"XDG_RUNTIME_DIR": "/run/user/1000"}, uid=1000),
            "/run/user/1000/protondrive/control.sock",
        )
        # No runtime dir (or an empty one): the temp dir as Node's os.tmpdir() finds it
        self.assertEqual(tray.control_socket_path({}, uid=1000), "/tmp/protondrive-1000/control.sock")
        self.assertEqual(tray.control_socket_path({"XDG_RUNTIME_DIR": ""}, uid=7), "/tmp/protondrive-7/control.sock")
        self.assertEqual(
            tray.control_socket_path({"TMPDIR": "/var/tmp/me/"}, uid=7), "/var/tmp/me/protondrive-7/control.sock"
        )
        self.assertEqual(tray.control_socket_path({"TMP": "/scratch"}, uid=7), "/scratch/protondrive-7/control.sock")


class SocketFolderTest(unittest.TestCase):
    """Final review M-5: in the /tmp fallback anyone can make the socket's folder first; the daemon's is the user's
    and 0700, and the tray never connects through any other."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pd-tray-")
        os.chmod(self.dir, 0o700)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(os.chmod, self.dir, 0o700)
        self.sock = os.path.join(self.dir, "control.sock")

    def test_only_a_private_folder_of_the_users_is_trusted(self):
        uid = os.getuid()
        self.assertIsNone(tray.socket_dir_problem(self.sock, uid))
        # Missing: no daemon runs, which connecting says
        self.assertIsNone(tray.socket_dir_problem(os.path.join(self.dir, "missing", "control.sock"), uid))
        for mode in (0o755, 0o770, 0o701, 0o1777):
            os.chmod(self.dir, mode)
            self.assertIn(self.dir, tray.socket_dir_problem(self.sock, uid) or "", oct(mode))
        os.chmod(self.dir, 0o700)
        self.assertIsNotNone(tray.socket_dir_problem("/control.sock", uid))  # root's
        self.assertIsNotNone(tray.socket_dir_problem(self.sock, uid + 1))
        link = self.dir + ".link"
        os.symlink(self.dir, link)
        self.addCleanup(os.remove, link)
        self.assertIsNotNone(tray.socket_dir_problem(os.path.join(link, "control.sock"), uid))

    def test_never_connects_through_a_folder_others_can_write(self):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(self.sock)
        server.listen(1)
        server.setblocking(False)
        os.chmod(self.dir, 0o777)
        with self.assertRaises(tray.ControlError) as refused:
            tray.connect_control_socket(self.sock)
        self.assertIn("isn't private", str(refused.exception))
        with self.assertRaises(BlockingIOError):
            server.accept()  # nothing connected
        os.chmod(self.dir, 0o700)
        tray.connect_control_socket(self.sock).close()


class RequestTest(unittest.TestCase):
    def test_builds_a_closing_http_request_with_a_json_body(self):
        self.assertEqual(
            tray.build_request("POST", "/vfs/mount", {}),
            b"POST /vfs/mount HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n"
            b"Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        )
        self.assertEqual(
            tray.build_request("GET", "/availability?path=x"),
            b"GET /availability?path=x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        )

    def test_reads_a_reply_and_turns_an_error_status_into_the_daemons_message(self):
        self.assertEqual(tray.parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}  junk"), {"ok": True})
        self.assertEqual(tray.parse_response(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}"), {"ok": True})
        with self.assertRaises(tray.ControlError) as refused:
            tray.parse_response(b"HTTP/1.1 400 Bad Request\r\n\r\n" + json.dumps({"error": "The drive is stopping"}).encode())
        self.assertEqual(str(refused.exception), "The drive is stopping")
        with self.assertRaises(tray.ControlError) as bare:
            tray.parse_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        self.assertEqual(str(bare.exception), "The Proton Drive background service answered 502")
        for raw in (b"", b"garbage", b"HTTP/1.1 OK\r\n\r\n{}", b"HTTP/1.1 200 OK\r\n\r\nnot json"):
            with self.assertRaises(tray.ControlError):
                tray.parse_response(raw)

    def test_sends_over_the_socket_it_is_given_and_reads_to_the_end(self):
        fake = FakeSocket(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}")
        self.assertEqual(tray.control_request("POST", "/vfs/mount", {}, timeout=3, connect=lambda: fake), {"ok": True})
        self.assertTrue(fake.sent.startswith(b"POST /vfs/mount HTTP/1.1\r\n"))
        self.assertEqual(fake.timeout, 3)
        self.assertTrue(fake.closed)

    def test_a_slow_daemon_is_still_working_and_a_missing_one_is_unreachable(self):
        slow = FakeSocket(fail_with=socket.timeout("timed out"))
        with self.assertRaises(tray.ControlError) as waited:
            tray.control_request("POST", "/vfs/mount", {}, connect=lambda: slow)
        self.assertIn("still", str(waited.exception).lower())
        self.assertTrue(slow.closed)

        def refuse():
            raise FileNotFoundError(2, "No such file or directory")

        with self.assertRaises(tray.ControlError) as missing:
            tray.control_request("POST", "/vfs/mount", {}, connect=refuse)
        self.assertIn("Can't reach the Proton Drive background service", str(missing.exception))


class MountItemTest(unittest.TestCase):
    def test_is_offered_only_for_an_unmounted_virtual_drive_that_can_mount_again(self):
        def status(mode, mounted, reason):
            return {"state": "idle", "vfs": {"mode": mode, "mounted": mounted, "reason": reason}}

        for reason in ("ejected", "crashed", "mount-point-busy"):
            self.assertTrue(tray.offers_mount(status("virtual", False, reason)), reason)
            self.assertFalse(tray.offers_mount(status("plain", False, reason)), reason)
            self.assertFalse(tray.offers_mount(status("virtual", True, reason)), reason)
        for reason in (None, "starting", "moving", "move-failed", "fuse-unavailable", "switched-off"):
            self.assertFalse(tray.offers_mount(status("virtual", False, reason)), reason)
        # A daemon before the virtual drive sends no vfs at all
        self.assertFalse(tray.offers_mount({"state": "idle"}))
        self.assertFalse(tray.offers_mount({"state": "idle", "vfs": None}))

    def test_labels_follow_the_copy(self):
        self.assertEqual(tray.MOUNT_LABEL, "Mount Proton Drive")
        self.assertEqual(tray.OPEN_DRIVE_LABEL, "Open Proton Drive")
        self.assertEqual(tray.VIEW_ONLINE_LABEL, "View Online")
        self.assertEqual(tray.OPEN_TRASH_LABEL, "Open Proton Drive Trash")
        self.assertEqual(tray.APP_LABEL, "Status & Settings…")


class OpenTrashTest(unittest.TestCase):
    # #201: a delete through the drive goes to the Proton Drive trash, which the tray opens in the browser
    def test_open_trash_opens_the_proton_drive_trash_in_the_browser(self):
        with mock.patch.object(tray, "spawn_detached") as spawn:
            tray.ProtonDriveTrayIndicator.on_open_trash(object(), None)
        spawn.assert_called_once_with(["xdg-open", "https://drive.proton.me/trash"])

    def test_the_menu_offers_it_with_the_hover_naming_the_sync_folder(self):
        tray.Gtk.MenuItem.reset_mock()
        with mock.patch.object(tray.ProtonDriveTrayIndicator, "poll_status"):
            indicator = tray.ProtonDriveTrayIndicator()
        self.assertIn(mock.call(label="Open Proton Drive Trash"), tray.Gtk.MenuItem.call_args_list)
        item = indicator.open_trash_item
        item.connect.assert_any_call("activate", indicator.on_open_trash)
        indicator.menu.append.assert_any_call(item)

    def test_the_hover_says_where_restored_files_come_back(self):
        home = os.path.expanduser("~")
        self.assertEqual(
            tray.trash_tooltip(os.path.join(home, "ProtonDrive")),
            "Deleted files stay here until you empty the trash or restore them. Restoring brings them back to ~/ProtonDrive.",
        )
        self.assertTrue(tray.trash_tooltip("/srv/u/Drive").endswith("back to /srv/u/Drive."))


def status(**over):
    """A daemon status as /api/status sends it: signed in, idle, nothing wrong."""
    base = {
        "state": "idle",
        "loggedIn": True,
        "settings": {"paused": False},
        "stats": {"unresolvedConflicts": 0, "errorItems": 0},
        "activeTransfers": [],
        "vfs": {"mode": "virtual", "mounted": True, "reason": None},
    }
    base.update(over)
    return base


def transfer(direction, rel_path="a.txt"):
    return {"direction": direction, "relPath": rel_path, "bytesTransferred": 1, "totalBytes": 2}


class MenuTest(unittest.TestCase):
    """#98: the menu as agreed — Open Proton Drive opens the drive, Status & Settings… opens the app."""

    def build(self):
        tray.Gtk.MenuItem.reset_mock()
        with mock.patch.object(tray.ProtonDriveTrayIndicator, "poll_status"):
            return tray.ProtonDriveTrayIndicator()

    def labels(self):
        return [c.kwargs.get("label") for c in tray.Gtk.MenuItem.call_args_list]

    def test_the_menu_items_in_order(self):
        self.build()
        labels = [l for l in self.labels() if l is not None]
        expected = [
            tray.OPEN_DRIVE_LABEL,
            tray.VIEW_ONLINE_LABEL,
            tray.OPEN_TRASH_LABEL,
            tray.MOUNT_LABEL,
            tray.APP_LABEL,
            "Sync Now",
            "Pause Sync",
            "For 1 hour",
            "Until tomorrow",
            "Until I resume",
            "Resume Sync",
            "Quit Proton Drive",
        ]
        self.assertEqual([l for l in labels if l in expected], expected)
        # Gone: the account line, the local-sync line and the separate folder item
        for gone in ("Open Proton Drive Folder", "Proton Drive"):
            self.assertNotIn(gone, labels)
        self.assertFalse(any(l.startswith("Local Sync") or l.startswith("Checking local") for l in labels))

    def test_open_proton_drive_opens_the_drive_in_files(self):
        indicator = types.SimpleNamespace(sync_dir="/home/u/ProtonDrive")
        with mock.patch.object(tray, "spawn_detached") as spawn:
            tray.ProtonDriveTrayIndicator.on_open_drive(indicator, None)
        spawn.assert_called_once_with(["xdg-open", "/home/u/ProtonDrive"])

    def test_view_online_opens_proton_drive_on_the_web(self):
        with mock.patch.object(tray, "spawn_detached") as spawn:
            tray.ProtonDriveTrayIndicator.on_view_online(object(), None)
        spawn.assert_called_once_with(["xdg-open", "https://drive.proton.me"])

    def test_status_and_settings_opens_the_app_on_home(self):
        with mock.patch.object(tray, "spawn_detached") as spawn:
            tray.ProtonDriveTrayIndicator.on_open_app(object(), None)
        argv = spawn.call_args_list[0].args[0]
        self.assertTrue(argv[0].endswith("protondrive-gui"))
        self.assertEqual(argv[1:], ["--tab", "home"])

    def test_the_problems_item_is_hidden_until_there_are_problems(self):
        indicator = self.build()
        item = indicator.problems_item
        item.set_no_show_all.assert_called_with(True)
        item.connect.assert_any_call("activate", indicator.on_open_app)


class StatusLineTest(unittest.TestCase):
    """The tray says what the app's Home says, in the same words (#98, #191)."""

    def test_up_to_date(self):
        self.assertEqual(tray.status_line(status()), ("Up to date", "protondrive-tray-idle"))

    def test_signed_out_either_way(self):
        self.assertEqual(tray.status_line(status(loggedIn=False))[0], "Signed out")
        self.assertEqual(tray.status_line(status(state="unauthenticated"))[0], "Signed out")
        self.assertEqual(tray.status_line(status(loggedIn=False))[1], "protondrive-tray-error")

    def test_paused_from_either_field(self):
        self.assertEqual(tray.status_line(status(state="paused")), ("Paused", "protondrive-tray-paused"))
        self.assertEqual(tray.status_line(status(settings={"paused": True}))[0], "Paused")

    def test_what_moves(self):
        syncing = lambda transfers: tray.status_line(status(state="syncing", activeTransfers=transfers))  # noqa: E731
        self.assertEqual(syncing([]), ("Checking for changes…", "protondrive-tray-syncing"))
        self.assertEqual(syncing([transfer("upload")] * 3)[0], "Uploading 3 files")
        self.assertEqual(syncing([transfer("download", "docs/report.pdf")])[0], "Downloading report.pdf")
        self.assertEqual(syncing([transfer("upload")] * 2 + [transfer("download")])[0], "Syncing 3 files")

    def test_never_shows_engine_text(self):
        text, _icon = tray.status_line(status(state="syncing", currentAction="Listing /my-files/deployment"))
        self.assertNotIn("/my-files", text)
        self.assertNotIn("Listing", text)

    def test_moving_files(self):
        moving = status(vfs={"mode": "virtual", "mounted": False, "reason": "moving"})
        self.assertEqual(tray.status_line(moving)[0], "Moving files…")

    def test_problems(self):
        # The count is on the clickable item just below (problems_label); the greyed line doesn't repeat it
        self.assertEqual(tray.status_line(status(stats={"unresolvedConflicts": 1, "errorItems": 0})),
                         ("Needs attention", "protondrive-tray-error"))
        self.assertEqual(tray.problems_label(1), "⚠ 1 problem needs you")
        self.assertEqual(tray.problems_label(3), "⚠ 3 problems need you")

    def test_an_error_with_no_message_is_not_up_to_date(self):
        self.assertEqual(tray.status_line(status(state="error"))[0], "Sync stopped")

    def test_storage_line(self):
        gb = 1024 ** 3
        self.assertEqual(tray.storage_line({"usedSpace": int(13.57 * gb), "maxSpace": 510 * gb}),
                         "13.6 GB of 510.0 GB used")
        self.assertIsNone(tray.storage_line({}))
        self.assertIsNone(tray.storage_line({"usedSpace": 5, "maxSpace": 0}))


class LongNamesTest(unittest.TestCase):
    def test_a_long_file_name_is_shortened_in_the_middle(self):
        name = "a-very-long-file-name-" * 6 + "end.docx"
        text, _ = tray.status_line(status(state="syncing", activeTransfers=[transfer("upload", "Docs/" + name)]))
        self.assertLessEqual(len(text), len("Uploading ") + tray.NAME_LIMIT)
        self.assertTrue(text.startswith("Uploading a-very-long"))
        self.assertTrue(text.endswith("end.docx"))
        self.assertIn("…", text)
        # A short name is left alone
        self.assertEqual(tray.status_line(status(state="syncing", activeTransfers=[transfer("upload", "a.txt")]))[0],
                         "Uploading a.txt")


class PollTest(unittest.TestCase):
    """poll_status against a fake daemon answer: what the menu shows."""

    def poll(self, answer):
        tray.Gtk.MenuItem.reset_mock()
        with mock.patch.object(tray.ProtonDriveTrayIndicator, "poll_status"):
            indicator = tray.ProtonDriveTrayIndicator()
        for name in ("status_item", "storage_item", "problems_item", "pause_item", "resume_item", "mount_item"):
            setattr(indicator, name, mock.MagicMock())
        indicator.indicator = mock.MagicMock()

        def urlopen(_req, timeout=None):
            if isinstance(answer, Exception):
                raise answer
            reply = mock.MagicMock()
            reply.__enter__.return_value.read.return_value = json.dumps(answer).encode()
            return reply

        with mock.patch.object(tray.urllib.request, "urlopen", urlopen):
            tray.ProtonDriveTrayIndicator.poll_status(indicator)
        return indicator

    def test_up_to_date_with_storage_and_no_problems(self):
        gb = 1024 ** 3
        ind = self.poll(status(account={"usedSpace": 2 * gb, "maxSpace": 10 * gb}))
        ind.status_item.set_label.assert_called_with("Up to date")
        ind.storage_item.set_label.assert_called_with("2.0 GB of 10.0 GB used")
        ind.storage_item.set_visible.assert_called_with(True)
        ind.problems_item.set_visible.assert_called_with(False)
        ind.pause_item.set_visible.assert_called_with(True)
        ind.indicator.set_icon_full.assert_called_with("protondrive-tray-idle", "Up to date")

    def test_problems_show_the_item_with_the_count(self):
        ind = self.poll(status(stats={"unresolvedConflicts": 2, "errorItems": 0}))
        ind.status_item.set_label.assert_called_with("Needs attention")
        ind.problems_item.set_label.assert_called_with("⚠ 2 problems need you")
        ind.problems_item.set_visible.assert_called_with(True)

    def test_signed_out_by_either_field_shows_no_problems_item(self):
        for answer in (status(loggedIn=False, lastError="x"), status(state="unauthenticated", lastError="x")):
            ind = self.poll(answer)
            ind.status_item.set_label.assert_called_with("Signed out")
            ind.problems_item.set_visible.assert_called_with(False)

    def test_paused_offers_resume(self):
        ind = self.poll(status(state="paused"))
        ind.pause_item.set_visible.assert_called_with(False)
        ind.resume_item.set_visible.assert_called_with(True)

    def test_not_paused_offers_the_pause_choices(self):
        ind = self.poll(status())
        ind.pause_item.set_visible.assert_called_with(True)
        ind.resume_item.set_visible.assert_called_with(False)

    def test_paused_until_a_time_says_so(self):
        until = int((datetime.datetime.now() + datetime.timedelta(minutes=30)).timestamp() * 1000)
        ind = self.poll(status(state="paused", settings={"paused": True, "pausedUntil": until}))
        label = ind.status_item.set_label.call_args.args[0]
        self.assertTrue(label.startswith("Paused until "), label)

    def test_null_fields_are_not_mistaken_for_an_offline_daemon(self):
        ind = self.poll(status(settings=None, stats=None, account=None, activeTransfers=None))
        ind.status_item.set_label.assert_called_with("Up to date")

    def test_unreachable_daemon(self):
        ind = self.poll(OSError("connection refused"))
        ind.status_item.set_label.assert_called_with("Can't reach Proton Drive's background service")
        ind.storage_item.set_visible.assert_called_with(False)
        ind.problems_item.set_visible.assert_called_with(False)


NOW = datetime.datetime(2026, 11, 4, 10, 30)  # a Wednesday, local time


def ms(dt):
    return int(dt.timestamp() * 1000)


class PausedLineTest(unittest.TestCase):
    """#205: how long a pause lasts, in local time: a time today, tomorrow, or on a later day; no time is just Paused."""

    def test_no_time(self):
        self.assertEqual(tray.paused_line(None, NOW), "Paused")
        # A time no clock can show (a corrupt stored value) is just "Paused", never an error that reads as offline
        self.assertEqual(tray.paused_line(10 ** 18, NOW), "Paused")

    def test_today(self):
        self.assertEqual(tray.paused_line(ms(datetime.datetime(2026, 11, 4, 15, 0)), NOW), "Paused until 15:00")
        self.assertEqual(tray.paused_line(ms(datetime.datetime(2026, 11, 4, 23, 59)), NOW), "Paused until 23:59")

    def test_tomorrow(self):
        self.assertEqual(tray.paused_line(ms(datetime.datetime(2026, 11, 5, 8, 0)), NOW), "Paused until tomorrow 08:00")

    def test_a_later_day_by_its_weekday(self):
        self.assertEqual(tray.paused_line(ms(datetime.datetime(2026, 11, 9, 8, 0)), NOW), "Paused until Mon 08:00")
        self.assertEqual(tray.paused_line(ms(datetime.datetime(2026, 11, 6, 7, 5)), NOW), "Paused until Fri 07:05")

    def test_the_status_line_uses_it(self):
        until = ms(datetime.datetime(2026, 11, 4, 15, 0))
        self.assertEqual(
            tray.status_line(status(state="paused", settings={"paused": True, "pausedUntil": until}), now=NOW),
            ("Paused until 15:00", "protondrive-tray-paused"),
        )
        self.assertEqual(tray.status_line(status(settings={"paused": True, "pausedUntil": None}), now=NOW)[0], "Paused")
        # A time that is not a number is no time
        self.assertEqual(tray.status_line(status(settings={"paused": True, "pausedUntil": "soon"}), now=NOW)[0], "Paused")


class PauseChoicesTest(unittest.TestCase):
    """#205: Pause Sync is a submenu of three choices while not paused; each posts /api/pause with its time."""

    def test_tomorrow_at_eight(self):
        self.assertEqual(tray.tomorrow_at_eight(NOW), ms(datetime.datetime(2026, 11, 5, 8, 0)))
        # Just after midnight it is still the next day's morning, not the same day's
        self.assertEqual(tray.tomorrow_at_eight(datetime.datetime(2026, 11, 4, 0, 10)), ms(datetime.datetime(2026, 11, 5, 8, 0)))
        # The last day of a month
        self.assertEqual(tray.tomorrow_at_eight(datetime.datetime(2026, 11, 30, 22, 0)), ms(datetime.datetime(2026, 12, 1, 8, 0)))

    def test_bodies(self):
        self.assertEqual(tray.pause_body("hour", NOW), {"paused": True, "until": ms(NOW) + 3_600_000})
        self.assertEqual(tray.pause_body("tomorrow", NOW), {"paused": True, "until": ms(datetime.datetime(2026, 11, 5, 8, 0))})
        self.assertEqual(tray.pause_body("resume", NOW), {"paused": True})

    def test_the_menu_has_the_choices_under_pause_and_a_hidden_resume(self):
        tray.Gtk.MenuItem.reset_mock()
        with mock.patch.object(tray.ProtonDriveTrayIndicator, "poll_status"):
            indicator = tray.ProtonDriveTrayIndicator()
        self.assertEqual([label for label, _ in tray.PAUSE_CHOICES], ["For 1 hour", "Until tomorrow", "Until I resume"])
        indicator.pause_item.set_submenu.assert_called()
        indicator.resume_item.set_no_show_all.assert_called_with(True)
        indicator.resume_item.connect.assert_any_call("activate", indicator.on_resume)

    def posted(self, action):
        sent = []

        def urlopen(req, timeout=None):
            sent.append((req.full_url, req.get_method(), json.loads(req.data.decode())))
            return mock.MagicMock()

        indicator = mock.MagicMock()
        indicator._post_pause = lambda body: tray.ProtonDriveTrayIndicator._post_pause(indicator, body)
        with mock.patch.object(tray.urllib.request, "urlopen", urlopen):
            action(indicator)
        indicator.poll_status.assert_called()
        return sent

    def test_each_choice_posts_its_body(self):
        for choice in ("hour", "tomorrow", "resume"):
            with mock.patch.object(tray, "pause_body", return_value={"paused": True, "choice": choice}) as body:
                sent = self.posted(lambda ind: tray.ProtonDriveTrayIndicator.on_pause_choice(ind, None, choice))
            self.assertEqual(body.call_args.args[0], choice)
            self.assertEqual(sent, [(f"{tray.DAEMON_URL}/api/pause", "POST", {"paused": True, "choice": choice})])

    def test_a_choice_uses_the_time_now(self):
        fixed = mock.MagicMock(wraps=datetime.datetime)
        fixed.now.return_value = NOW
        with mock.patch.object(tray.datetime, "datetime", fixed):
            sent = self.posted(lambda ind: tray.ProtonDriveTrayIndicator.on_pause_choice(ind, None, "hour"))
        self.assertEqual(sent[0][2], {"paused": True, "until": ms(NOW) + 3_600_000})

    def test_resume_posts_paused_false(self):
        sent = self.posted(lambda ind: tray.ProtonDriveTrayIndicator.on_resume(ind, None))
        self.assertEqual(sent, [(f"{tray.DAEMON_URL}/api/pause", "POST", {"paused": False})])


class ProblemCountTest(unittest.TestCase):
    """Counted as the app's Needs attention lists them: one per conflict, one for failed files, one each for the rest."""

    def test_problem_count_counts_up_to_three_cut_short_files_then_one(self):
        # The app lists a file the disk guard cut short on its own row up to three, and one summary row above
        for held, problems in ((0, 0), (1, 1), (2, 2), (3, 3), (4, 1), (214, 1)):
            stats = {"unresolvedConflicts": 0, "errorItems": 0, "cutShortFiles": held}
            self.assertEqual(tray.problem_count(status(stats=stats)), problems, held)
        # Beside the others, and an older daemon sends none
        stats = {"unresolvedConflicts": 1, "errorItems": 2, "cutShortFiles": 2}
        self.assertEqual(tray.problem_count(status(stats=stats)), 4)
        self.assertEqual(tray.problem_count(status(stats={"unresolvedConflicts": 1})), 1)

    def test_nothing_wrong(self):
        self.assertEqual(tray.problem_count(status()), 0)

    def test_each_kind_counts(self):
        self.assertEqual(tray.problem_count(status(accountMismatch={"message": "x"})), 1)
        self.assertEqual(tray.problem_count(status(filesMissing={"root": "/x"})), 1)
        self.assertEqual(tray.problem_count(status(stats={"unresolvedConflicts": 2, "errorItems": 0})), 2)
        self.assertEqual(tray.problem_count(status(stats={"unresolvedConflicts": 0, "errorItems": 7})), 1)
        self.assertEqual(tray.problem_count(status(lastError="Disk full")), 1)

    def test_last_error_is_not_counted_when_missing_files_or_another_account_explain_it(self):
        self.assertEqual(tray.problem_count(status(filesMissing={"root": "/x"}, lastError="missing")), 1)
        self.assertEqual(tray.problem_count(status(accountMismatch={"message": "m"}, lastError="m")), 1)
        self.assertEqual(tray.problem_count(status(lastError="   ")), 0)

    def test_the_drive(self):
        unmounted = lambda reason: status(vfs={"mode": "virtual", "mounted": False, "reason": reason})  # noqa: E731
        self.assertEqual(tray.problem_count(unmounted("ejected")), 1)
        self.assertEqual(tray.problem_count(unmounted(None)), 1)
        for transient in ("starting", "moving"):
            self.assertEqual(tray.problem_count(unmounted(transient)), 0, transient)
        self.assertEqual(tray.problem_count(unmounted("move-failed")), 1)  # the stopped move, not also "not mounted"
        mounted_with_move = status(vfs={"mode": "virtual", "mounted": True, "reason": None,
                                        "move": {"actions": ["retry"]}})
        self.assertEqual(tray.problem_count(mounted_with_move), 1)
        self.assertEqual(tray.problem_count(status(vfs={"mode": "plain", "mounted": False, "reason": "switched-off"})), 0)
        self.assertEqual(tray.problem_count(status(vfs=None)), 0)


if __name__ == "__main__":
    unittest.main()
