#!/usr/bin/env python3
"""Tests of the Nemo (Cinnamon) extension's real emblems, sync-folder discovery, menu and change stream.

Run: python3 linux/nemo/test_proton_drive_nemo.py
"""
import importlib.util
import inspect
import os
import sys
import threading
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TRAY = os.path.join(HERE, "..", "tray", "proton_drive_tray.py")


def load(name, file, extra_modules=()):
    """Imports a module with stand-ins for GTK and Nemo, so only its plain code runs."""
    gi = types.ModuleType("gi")
    gi.require_version = lambda *_args: None
    repository = types.ModuleType("gi.repository")
    for module in ("GLib", "Gtk", "AyatanaAppIndicator3") + tuple(extra_modules):
        setattr(repository, module, mock.MagicMock())

    class Base:
        def __init__(self, *args, **kwargs):
            pass

    class FakeMenuItem:
        def __init__(self, name="", label="", tip=""):
            self.name = name
            self.label = label
            self.tip = tip
            self.handlers = {}

        def connect(self, sig, cb):
            self.handlers[sig] = cb

    repository.GObject = types.SimpleNamespace(GObject=type("GObject", (Base,), {}))
    repository.Nemo = types.SimpleNamespace(
        InfoProvider=type("InfoProvider", (), {}),
        MenuProvider=type("MenuProvider", (), {}),
        MenuItem=FakeMenuItem,
        FileInfo=types.SimpleNamespace(lookup=lambda _gfile: None),
        OperationResult=types.SimpleNamespace(COMPLETE="complete", IN_PROGRESS="in-progress", FAILED="failed"),
    )
    gi.repository = repository
    with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
        spec = importlib.util.spec_from_file_location(name, file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


ext = load("proton_drive_nemo_under_test", os.path.join(HERE, "proton_drive_nemo.py"), extra_modules=("Gio",))
ROOT = "/home/u/MovedProtonDrive"

HELD = {}


class FakeFile:
    def __init__(self, path, scheme="file"):
        self.path = path
        self.scheme = scheme
        self.emblems = []
        self.invalidated = 0
        HELD[path] = self

    def get_uri_scheme(self):
        return self.scheme

    def get_location(self):
        return types.SimpleNamespace(get_path=lambda: self.path)

    def add_emblem(self, name):
        self.emblems.append(name)

    def invalidate_extension_info(self):
        self.invalidated += 1
        self.emblems = []


class Harness:
    def __init__(self, answers=None, root=ROOT):
        self.answers = answers or {}
        self.requests = []
        self.runs = []
        self.now = 1000.0
        self.threads = []
        self.scheduled = []
        self.files = ext.ProtonDriveNemoFiles(
            request=self.request,
            run=lambda work, done: self.runs.append((work, done)),
            clock=lambda: self.now,
            later=lambda fn, seconds: self.scheduled.append((fn, seconds)),
            lookup=HELD.get,
        )
        if root is not None:
            self.files.set_root(root)

    def request(self, method, path, body, timeout):
        self.requests.append((method, path, body))
        self.threads.append(threading.current_thread())
        answer = self.answers.get((method, path)) or self.answers.get(path)
        if callable(answer):
            return answer(body)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            raise ext.ControlError("Not in Proton Drive")
        return answer

    def release(self):
        while self.runs:
            work, done = self.runs.pop(0)
            box = {}

            def target():
                try:
                    box["result"], box["error"] = work(), None
                except Exception as err:
                    box["result"], box["error"] = None, err

            thread = threading.Thread(target=target)
            thread.start()
            thread.join()
            done(box["result"], box["error"])


def states_query(folder):
    return "/fm/states?path=" + ext.urllib.parse.quote(folder, safe="/")


DOCS_STATES = {
    "self": {"availability": "pinned", "transfer": None},
    "children": {
        "pinned.txt": {"availability": "pinned", "transfer": None},
        "local.txt": {"availability": "downloaded", "transfer": None},
        "cloud.txt": {"availability": "online-only", "transfer": None},
        "uploading.txt": {"availability": "downloaded", "transfer": "syncing"},
        "failed.txt": {"availability": "downloaded", "transfer": "error"},
        "conflict.txt": {"availability": "downloaded", "transfer": "conflict"},
        "Partial": {"availability": "partial", "transfer": None},
        ".git": None,
    },
}


class ClientMatchesTrayTest(unittest.TestCase):
    def test_the_socket_client_is_the_trays(self):
        tray = load("proton_drive_tray_under_test", TRAY)
        for name in (
            "control_socket_path",
            "build_request",
            "parse_response",
            "socket_dir_problem",
            "connect_control_socket",
            "control_request",
        ):
            self.assertEqual(inspect.getsource(getattr(ext, name)), inspect.getsource(getattr(tray, name)), name)


class NemoEmblemTest(unittest.TestCase):
    def setUp(self):
        HELD.clear()

    def test_uploading_conflict_error_and_ignored_never_get_synced_emblem(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        files = {name: FakeFile(f"{ROOT}/Docs/{name}") for name in DOCS_STATES["children"]}
        for f in files.values():
            h.files.file_info(f)
            self.assertEqual(f.emblems, [])
        self.assertEqual(len(h.runs), 1)
        h.release()
        self.assertIsNot(h.threads[0], threading.main_thread())

        self.assertEqual(files["pinned.txt"].emblems, ["emblem-protondrive-pinned"])
        self.assertEqual(files["local.txt"].emblems, ["emblem-protondrive-local"])
        self.assertEqual(files["cloud.txt"].emblems, ["emblem-protondrive-cloud"])
        self.assertEqual(files["uploading.txt"].emblems, ["emblem-synchronizing"])
        self.assertEqual(files["failed.txt"].emblems, ["emblem-important"])
        self.assertEqual(files["conflict.txt"].emblems, ["emblem-important"])
        self.assertEqual(files["Partial"].emblems, ["emblem-protondrive-partial"])
        self.assertEqual(files[".git"].emblems, [])
        for name in ("uploading.txt", "failed.txt", "conflict.txt", "cloud.txt", ".git"):
            self.assertNotIn("emblem-synchronized", files[name].emblems)
            self.assertNotIn("emblem-protondrive-local", files[name].emblems)
            self.assertNotIn("emblem-protondrive-pinned", files[name].emblems)

        # Every custom emblem named exists on disk
        icons = os.path.join(HERE, "..", "icons", "emblems")
        for emblem in ext.EMBLEMS.values():
            self.assertTrue(os.path.isfile(os.path.join(icons, emblem + ".svg")), emblem)

    def test_leftover_default_folder_and_paths_outside_configured_sync_dir_get_no_emblem(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES}, root=ROOT)
        default_dir = os.path.expanduser("~/ProtonDrive")
        for f in (
            FakeFile(default_dir),
            FakeFile(os.path.join(default_dir, "leftover.txt")),
            FakeFile(ROOT),
            FakeFile(ROOT + "2/other.txt"),
            FakeFile(f"{ROOT}/.xdg-volume-info"),
            FakeFile(f"{ROOT}/.Trash-1000/files/a.txt"),
            FakeFile(f"{ROOT}/Docs/a.txt", scheme="sftp"),
        ):
            h.files.file_info(f)
            self.assertEqual(f.emblems, [], f.path)
        self.assertEqual(h.runs, [])

    def test_when_daemon_is_down_no_file_gets_a_synced_emblem(self):
        h = Harness({"/fm/root": ext.ControlError("Can't reach the Proton Drive background service")}, root=None)
        f = FakeFile(os.path.expanduser("~/ProtonDrive/report.pdf"))
        h.files.file_info(f)
        h.release()
        self.assertEqual(f.emblems, [])
        self.assertEqual(len(h.scheduled), 1)

    def test_files_seen_before_root_arrives_refresh_once_root_is_known(self):
        h = Harness(
            {
                "/fm/root": {"syncDir": ROOT, "mode": "virtual", "mounted": True},
                states_query(ROOT + "/Docs"): DOCS_STATES,
            },
            root=None,
        )
        f = FakeFile(f"{ROOT}/Docs/uploading.txt")
        h.files.file_info(f)
        self.assertEqual(f.emblems, [])
        h.release()
        self.assertEqual(h.files.root, ROOT)
        self.assertEqual(f.invalidated, 1)
        h.files.file_info(f)
        h.release()
        self.assertEqual(f.emblems, ["emblem-synchronizing"])

    def test_change_events_invalidate_changed_paths_and_switch_root_on_reset(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        f = FakeFile(f"{ROOT}/Docs/uploading.txt")
        h.files.file_info(f)
        h.release()
        self.assertEqual(f.emblems, ["emblem-synchronizing"])

        h.files.on_event({"type": "changed", "paths": [f"{ROOT}/Docs/uploading.txt"], "subtrees": []})
        self.assertEqual(f.invalidated, 1)

        moved = "/home/u/NewDrive"
        h.files.on_event({"type": "reset", "syncDir": moved})
        self.assertEqual(h.files.root, moved)

    def test_menu_follows_configured_sync_dir_and_keeps_expected_labels(self):
        h = Harness({}, root=ROOT)
        with mock.patch.object(ext, "threading"), mock.patch.object(ext, "GilPump"):
            provider = ext.ProtonDriveNemoExtension()
        provider.files = h.files

        # Outside configured sync dir (even in ~/ProtonDrive) -> no menu
        outside = FakeFile(os.path.expanduser("~/ProtonDrive/leftover.txt"))
        self.assertEqual(provider.get_file_items(None, [outside]), [])

        # Inside configured sync dir -> Sync Now + Status & Settings…
        inside = FakeFile(f"{ROOT}/Docs/local.txt")
        items = provider.get_file_items(None, [inside])
        self.assertEqual([i.label for i in items], ["Proton Drive: Sync Now", "Proton Drive: Status & Settings…"])

        # Also works when Nemo calls get_file_items(files) without window
        self.assertEqual(len(provider.get_file_items([inside])), 2)

        # Clicking Status & Settings… launches protondrive-gui --tab home
        with mock.patch.object(ext, "_spawn_detached") as spawn:
            items[1].handlers["activate"](items[1])
            spawn.assert_called_once_with(["protondrive-gui", "--tab", "home"])


if __name__ == "__main__":
    unittest.main()
