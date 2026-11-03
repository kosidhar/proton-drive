#!/usr/bin/env python3
"""Tests of the tray's control socket requests and its Mount item, without GTK, a desktop or a real socket.

Run: python3 linux/tray/test_proton_drive_tray.py
"""
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
        self.assertEqual(tray.OPEN_FOLDER_LABEL, "Open Proton Drive Folder")


class StateIconTest(unittest.TestCase):
    """The tray's state icons (#75): a turning sync icon while syncing, a still full-size icon otherwise."""

    ICONS = os.path.join(HERE, "..", "..", "assets", "app-icon", "tray")

    def test_every_icon_the_tray_names_is_installed(self):
        names = ["protondrive-tray-idle", "protondrive-tray-paused", "protondrive-tray-error", "protondrive-tray-syncing"]
        names += [tray.sync_frame_icon(i) for i in range(tray.SYNC_FRAMES)]
        for name in names:
            self.assertTrue(os.path.isfile(os.path.join(self.ICONS, f"{name}.png")), name)

    def test_the_sync_frames_wrap_around(self):
        self.assertEqual(tray.sync_frame_icon(0), "protondrive-tray-syncing-0")
        self.assertEqual(tray.sync_frame_icon(tray.SYNC_FRAMES), "protondrive-tray-syncing-0")
        self.assertEqual(tray.sync_frame_icon(tray.SYNC_FRAMES + 3), "protondrive-tray-syncing-3")

    def indicator_stand_in(self):
        """The tray's icon methods on a bare object, with GLib's timer calls recorded instead of run."""
        state = types.SimpleNamespace(indicator=mock.MagicMock(), sync_frame=0, sync_timer=0)
        for name in ("show_state", "show_syncing", "next_sync_frame"):
            setattr(state, name, getattr(tray.ProtonDriveTrayIndicator, name).__get__(state))
        return state

    def test_syncing_starts_one_timer_and_any_other_state_stops_it(self):
        glib = tray.GLib
        glib.timeout_add.reset_mock()
        glib.source_remove.reset_mock()
        glib.timeout_add.return_value = 42
        t = self.indicator_stand_in()

        t.show_syncing()
        t.show_syncing()  # the next poll while still syncing leaves the one timer turning
        self.assertEqual(glib.timeout_add.call_count, 1)
        self.assertEqual(glib.timeout_add.call_args[0][0], tray.SYNC_FRAME_MS)
        t.indicator.set_icon_full.assert_called_with("protondrive-tray-syncing-0", "Syncing")

        self.assertTrue(t.next_sync_frame())
        t.indicator.set_icon_full.assert_called_with("protondrive-tray-syncing-1", "Syncing")

        t.show_state("protondrive-tray-idle", "Up to date")
        glib.source_remove.assert_called_once_with(42)
        self.assertEqual(t.sync_timer, 0)
        t.indicator.set_icon_full.assert_called_with("protondrive-tray-idle", "Up to date")

        # A still state with no timer running removes nothing
        t.show_state("protondrive-tray-paused", "Paused")
        glib.source_remove.assert_called_once_with(42)


if __name__ == "__main__":
    unittest.main()
