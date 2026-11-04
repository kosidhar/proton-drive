#!/usr/bin/env python3
"""Tests of the Files extension's emblems, menu and change stream, without Nautilus, a desktop or a daemon.

Run: python3 linux/nautilus/test_proton_drive_nautilus.py
"""
import importlib.util
import inspect
import json
import os
import socket
import sys
import threading
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TRAY = os.path.join(HERE, "..", "tray", "proton_drive_tray.py")


def load(name, file, extra_modules=()):
    """Imports a module with stand-ins for GTK and Nautilus, so only its plain code runs."""
    gi = types.ModuleType("gi")
    gi.require_version = lambda *_args: None
    repository = types.ModuleType("gi.repository")
    for module in ("GLib", "Gtk", "AyatanaAppIndicator3") + tuple(extra_modules):
        setattr(repository, module, mock.MagicMock())

    class Base:
        def __init__(self, *args, **kwargs):
            pass

    repository.GObject = types.SimpleNamespace(GObject=type("GObject", (Base,), {}))
    repository.Nautilus = types.SimpleNamespace(
        InfoProvider=type("InfoProvider", (), {}),
        MenuProvider=type("MenuProvider", (), {}),
        MenuItem=mock.MagicMock(),
        OperationResult=types.SimpleNamespace(COMPLETE="complete", IN_PROGRESS="in-progress", FAILED="failed"),
        info_provider_update_complete_invoke=mock.MagicMock(),
    )
    gi.repository = repository
    with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
        spec = importlib.util.spec_from_file_location(name, file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


ext = load("proton_drive_nautilus_under_test", os.path.join(HERE, "proton_drive_nautilus.py"))
ROOT = "/home/u/ProtonDrive"


class FakeFile:
    def __init__(self, path, scheme="file"):
        self.path = path
        self.scheme = scheme
        self.emblems = []
        self.invalidated = 0

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
    """A ProtonDriveFiles whose worker runs are held until the test lets them go, with a fake daemon."""

    def __init__(self, answers=None, root=ROOT):
        self.answers = answers or {}
        self.requests = []
        self.runs = []
        self.notes = []
        self.now = 1000.0
        self.threads = []
        self.scheduled = []  # [(fn, seconds)] handed to later()
        self.files = ext.ProtonDriveFiles(
            request=self.request,
            run=lambda work, done: self.runs.append((work, done)),
            notify=lambda title, body: self.notes.append((title, body)),
            clock=lambda: self.now,
            later=lambda fn, seconds: self.scheduled.append((fn, seconds)),
        )
        if root:
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
        """Runs every queued worker job, each on a thread of its own, then its completion here."""
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
        "a.txt": {"availability": "pinned", "transfer": None},
        "b.txt": {"availability": "downloaded", "transfer": None},
        "c.txt": {"availability": "online-only", "transfer": None},
        "d.txt": {"availability": "online-only", "transfer": "syncing"},
        "e.txt": {"availability": "downloaded", "transfer": "error"},
        "f.txt": {"availability": "downloaded", "transfer": "conflict"},
        "Part": {"availability": "partial", "transfer": None},  # a folder partly here (#183)
        ".git": None,
    },
}


class ClientMatchesTrayTest(unittest.TestCase):
    def test_the_socket_client_is_the_trays(self):
        tray = load("proton_drive_tray_under_test", TRAY)
        for name in ("control_socket_path", "build_request", "parse_response", "socket_dir_problem", "connect_control_socket", "control_request"):
            self.assertEqual(inspect.getsource(getattr(ext, name)), inspect.getsource(getattr(tray, name)), name)


class EmblemTest(unittest.TestCase):
    def test_emblem_for_every_state(self):
        self.assertIsNone(ext.emblem_for(None))
        self.assertIsNone(ext.emblem_for(ext.UNKNOWN))
        for availability, emblem in ext.EMBLEMS.items():
            self.assertEqual(ext.emblem_for({"availability": availability, "transfer": None}), emblem)
            self.assertEqual(ext.emblem_for({"availability": availability, "transfer": "syncing"}), "emblem-synchronizing")
            self.assertEqual(ext.emblem_for({"availability": availability, "transfer": "error"}), "emblem-important")
            self.assertEqual(ext.emblem_for({"availability": availability, "transfer": "conflict"}), "emblem-important")
        self.assertEqual(ext.EMBLEMS["pinned"], "emblem-protondrive-pinned")
        self.assertEqual(ext.EMBLEMS["downloaded"], "emblem-protondrive-local")
        self.assertEqual(ext.EMBLEMS["online-only"], "emblem-protondrive-cloud")
        self.assertEqual(ext.EMBLEMS["partial"], "emblem-protondrive-partial")
        # Every emblem the extension names is one the app installs
        icons = os.path.join(HERE, "..", "icons", "emblems")
        for emblem in ext.EMBLEMS.values():
            self.assertTrue(os.path.isfile(os.path.join(icons, emblem + ".svg")), emblem)

    def test_paths_inside_the_drive(self):
        self.assertEqual(ext.rel_to_root(ROOT, ROOT), "")
        self.assertEqual(ext.rel_to_root(ROOT + "/", ROOT + "/Docs/a"), "Docs/a")
        self.assertIsNone(ext.rel_to_root(ROOT, ROOT + "2/Docs"))
        self.assertIsNone(ext.rel_to_root(ROOT, "/home/u"))
        self.assertIsNone(ext.rel_to_root(None, ROOT))
        for rel in (".xdg-volume-info", ".Trash-1000", ".Trash-1000/files/x", "Docs/.proton-drive-tmp-hydrate-1"):
            self.assertTrue(ext.skipped(rel), rel)
        self.assertFalse(ext.skipped("Docs/Trash-notes.txt"))

    def test_one_request_per_folder_and_every_file_gets_its_emblem_when_it_arrives(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        files = {name: FakeFile(f"{ROOT}/Docs/{name}") for name in DOCS_STATES["children"]}
        for f in files.values():
            h.files.file_info(f)
            self.assertEqual(f.emblems, [])  # answered at once, with nothing yet
        self.assertEqual(len(h.runs), 1)
        h.release()
        self.assertEqual(h.requests, [("GET", states_query(ROOT + "/Docs"), None)])
        self.assertIsNot(h.threads[0], threading.main_thread())
        self.assertEqual(files["a.txt"].emblems, ["emblem-protondrive-pinned"])
        self.assertEqual(files["b.txt"].emblems, ["emblem-protondrive-local"])
        self.assertEqual(files["c.txt"].emblems, ["emblem-protondrive-cloud"])
        self.assertEqual(files["d.txt"].emblems, ["emblem-synchronizing"])
        self.assertEqual(files["e.txt"].emblems, ["emblem-important"])
        self.assertEqual(files["f.txt"].emblems, ["emblem-important"])
        self.assertEqual(files["Part"].emblems, ["emblem-protondrive-partial"])
        self.assertEqual(files[".git"].emblems, [])
        # Cached: the next file of that folder gets its emblem at once, with no request
        again = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(again)
        self.assertEqual(again.emblems, ["emblem-protondrive-pinned"])
        self.assertEqual(len(h.requests), 1)

    # #131: Files cancels and asks again about a file while its folder's states are on the way; the emblem is added once
    def test_a_file_asked_about_twice_while_waiting_gets_one_emblem(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        a = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(a)
        h.files.file_info(a)
        h.release()
        self.assertEqual(a.emblems, ["emblem-protondrive-pinned"])

    def test_files_outside_the_drive_the_drive_itself_and_its_own_files_get_nothing(self):
        h = Harness()
        for f in (
            FakeFile(ROOT),
            FakeFile("/home/u/ProtonDrive2/x"),
            FakeFile(f"{ROOT}/.xdg-volume-info"),
            FakeFile(f"{ROOT}/.Trash-1000"),
            FakeFile(f"{ROOT}/x", scheme="sftp"),
        ):
            h.files.file_info(f)
            self.assertEqual(f.emblems, [], f.path)
        self.assertEqual(h.runs, [])

    def test_a_daemon_that_fails_gives_no_emblem_and_caches_nothing(self):
        h = Harness({states_query(ROOT + "/Docs"): ext.ControlError("Can't reach the Proton Drive background service")})
        a, b = FakeFile(f"{ROOT}/Docs/a.txt"), FakeFile(f"{ROOT}/Docs/b.txt")
        h.files.file_info(a)
        h.files.file_info(b)
        h.release()
        self.assertEqual((a.emblems, b.emblems), ([], []))
        h.files.file_info(a)
        self.assertEqual(len(h.runs), 1)  # asks again

    def test_without_a_root_nothing_is_asked_per_file_and_the_root_is_asked_once_a_while(self):
        h = Harness({"/fm/root": {"syncDir": ROOT, "mode": "virtual", "mounted": True}}, root=None)
        h.files.file_info(FakeFile(f"{ROOT}/a"))
        h.files.file_info(FakeFile(f"{ROOT}/b"))
        self.assertEqual(len(h.runs), 1)
        h.release()
        self.assertEqual(h.files.root, ROOT)

    # #86: the first folder opened before the root was known kept no emblems until a refresh
    def test_a_file_asked_about_before_the_root_is_known_gets_its_emblem_once_it_is(self):
        h = Harness({"/fm/root": {"syncDir": ROOT, "mode": "virtual", "mounted": True},
                     states_query(ROOT + "/Docs"): DOCS_STATES}, root=None)
        a = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(a)
        h.release()
        self.assertEqual(h.files.root, ROOT)
        self.assertEqual(a.invalidated, 1)  # Files asks again
        h.files.file_info(a)
        h.release()
        self.assertEqual(a.emblems, ["emblem-protondrive-pinned"])

    def test_a_root_that_cannot_be_asked_yet_is_asked_again_and_what_waited_is_refreshed(self):
        answers = {"/fm/root": ext.ControlError("Can't reach the Proton Drive background service"),
                   states_query(ROOT + "/Docs"): DOCS_STATES}
        h = Harness(answers, root=None)
        a = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(a)
        h.release()
        self.assertEqual(len(h.scheduled), 1)
        # The daemon is up by the time it is asked again: Files is told to ask about the file again
        answers["/fm/root"] = {"syncDir": ROOT, "mode": "virtual", "mounted": True}
        fn, _seconds = h.scheduled.pop()
        fn()
        h.release()
        self.assertEqual(h.files.root, ROOT)
        self.assertEqual(a.invalidated, 1)
        h.files.file_info(a)
        h.release()
        self.assertEqual(a.emblems, ["emblem-protondrive-pinned"])

    def test_a_file_seen_before_the_root_is_refreshed_when_the_change_stream_tells_it_first(self):
        h = Harness({"/fm/root": {"syncDir": ROOT, "mode": "virtual", "mounted": True}}, root=None)
        a = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(a)
        h.files.on_event({"type": "hello", "syncDir": ROOT, "mode": "virtual"})
        self.assertEqual(a.invalidated, 1)
        h.release()  # the root's own answer, later, changes nothing
        self.assertEqual(a.invalidated, 1)

    def test_while_the_daemon_is_away_the_root_is_asked_again_later_still(self):
        answers = {"/fm/root": ext.ControlError("Can't reach the Proton Drive background service"),
                   states_query(ROOT + "/Docs"): DOCS_STATES}
        h = Harness(answers, root=None)
        inside = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(inside)
        h.release()
        # Asked once a while, not per file
        h.files.file_info(FakeFile("/usr/share/doc/x"))
        self.assertEqual(h.runs, [])
        fn, _seconds = h.scheduled.pop()
        fn()
        h.release()
        self.assertEqual(len(h.scheduled), 1)
        answers["/fm/root"] = {"syncDir": ROOT, "mode": "virtual", "mounted": True}
        h.scheduled.pop()[0]()
        h.release()
        self.assertEqual(h.files.root, ROOT)
        self.assertEqual(inside.invalidated, 1)

    def test_a_folder_the_daemon_says_is_not_in_the_drive_is_not_asked_again(self):
        h = Harness({states_query(ROOT + "/Docs"): ext.ControlError("Not a folder in Proton Drive")})
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        h.release()
        self.assertEqual(h.scheduled, [])
        self.assertEqual(h.files.fetch_failures, {})

    def test_a_failed_states_fetch_is_asked_again_later_with_a_growing_wait(self):
        answers = {states_query(ROOT + "/Docs"): ext.ControlError("Can't reach the Proton Drive background service")}
        h = Harness(answers)
        a = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(a)
        h.release()
        fn, first_wait = h.scheduled.pop()
        h.files.file_info(a)
        h.release()
        _fn, second_wait = h.scheduled.pop()
        self.assertGreater(second_wait, first_wait)
        # Files is told to ask again; this time the daemon answers
        answers[states_query(ROOT + "/Docs")] = DOCS_STATES
        fn()
        self.assertEqual(a.invalidated, 1)
        h.files.file_info(a)
        h.release()
        self.assertEqual(a.emblems, ["emblem-protondrive-pinned"])

    def test_without_the_change_stream_states_are_fetched_again_after_ten_seconds(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        h.release()
        h.now += 5
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        self.assertEqual(h.runs, [])
        h.now += 6
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        self.assertEqual(len(h.runs), 1)
        h.release()
        # With the stream up, the cache holds until a change says otherwise
        h.files.on_event({"type": "hello", "syncDir": ROOT, "mode": "virtual"})
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        h.release()
        h.now += 3600
        h.files.file_info(FakeFile(f"{ROOT}/Docs/a.txt"))
        self.assertEqual(h.runs, [])

    def test_the_folder_cache_lets_the_least_recently_used_go(self):
        cache = ext.FolderCache(limit=2)
        cache.put("/a", {"children": {}}, 0)
        cache.put("/b", {"children": {}}, 0)
        cache.get("/a", 0)
        cache.put("/c", {"children": {}}, 0)
        self.assertEqual(list(cache.entries), ["/a", "/c"])

    def test_a_fetch_that_started_before_a_change_is_shown_but_not_kept(self):
        h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        f = FakeFile(f"{ROOT}/Docs/a.txt")
        h.files.file_info(f)
        h.files.on_event({"type": "changed", "paths": [f"{ROOT}/Docs/a.txt"], "subtrees": []})
        h.release()
        self.assertEqual(f.emblems, ["emblem-protondrive-pinned"])
        self.assertIsNone(h.files.cache.get(f"{ROOT}/Docs", h.now))

    def test_files_is_always_answered_at_once(self):
        """#131: an answer given later can't be matched to its request with nautilus-python, so none is."""
        with open(os.path.join(HERE, "proton_drive_nautilus.py")) as f:
            source = f.read().split("class ProtonDriveNautilusExtension(")[1]
        self.assertNotIn("IN_PROGRESS", source)
        self.assertNotIn("info_provider_update_complete_invoke", source)


class GilPumpTest(unittest.TestCase):
    """#131: nautilus-python never lets go of the GIL, so the extension's threads run only when it is given away."""

    def setUp(self):
        self.timers = []  # [ms, fn, alive]
        self.slept = []
        self.pump = ext.GilPump(lambda ms, fn: self.timers.append([ms, fn, True]), sleep=self.slept.append)

    def tick(self, ms):
        for timer in self.timers:
            if timer[2] and timer[0] == ms:
                timer[2] = timer[1]()

    def live(self, ms):
        return [t for t in self.timers if t[2] and t[0] == ms]

    def test_always_gives_the_gil_away_now_and_then_for_the_change_stream(self):
        self.assertEqual(len(self.live(ext.GilPump.IDLE_MS)), 1)
        for _ in range(3):
            self.tick(ext.GilPump.IDLE_MS)
        self.assertEqual(self.slept, [ext.GilPump.SLICE] * 3)
        self.assertEqual(len(self.live(ext.GilPump.IDLE_MS)), 1)  # never stops

    def test_gives_it_away_often_only_while_a_request_is_out(self):
        self.pump.begin()
        self.pump.begin()  # one fast timer however many requests are out
        self.assertEqual(len(self.live(ext.GilPump.BUSY_MS)), 1)
        self.pump.end()
        self.tick(ext.GilPump.BUSY_MS)
        self.assertEqual(len(self.live(ext.GilPump.BUSY_MS)), 1)
        self.pump.end()
        self.tick(ext.GilPump.BUSY_MS)
        self.assertEqual(self.live(ext.GilPump.BUSY_MS), [])
        self.pump.begin()  # a later request starts it again
        self.assertEqual(len(self.live(ext.GilPump.BUSY_MS)), 1)

    def test_a_worker_thread_finishes_while_the_main_thread_only_gives_the_gil_away_through_the_pump(self):
        """A busy worker thread finishes while the main thread does nothing but give the GIL away through the pump."""
        done = threading.Event()

        def work():
            total = 0
            for i in range(200000):  # pure Python: needs the GIL throughout
                total += i
            done.set()

        pump = ext.GilPump(lambda ms, fn: None)
        thread = threading.Thread(target=work)
        thread.start()
        for _ in range(2000):
            if done.is_set():
                break
            pump.give()
        thread.join(5)
        self.assertTrue(done.is_set())


class MenuTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness({states_query(ROOT + "/Docs"): DOCS_STATES})
        for name in DOCS_STATES["children"]:
            self.h.files.file_info(FakeFile(f"{ROOT}/Docs/{name}"))
        self.h.release()

    def actions(self, *names):
        return self.h.files.actions_for([f"{ROOT}/Docs/{n}" for n in names])

    def test_which_actions_a_selection_gets(self):
        self.assertEqual(self.actions("a.txt"), ["free", "hide"])  # all pinned
        self.assertEqual(self.actions("a.txt", "c.txt"), ["pin", "free", "hide"])  # mixed
        self.assertEqual(self.actions("c.txt"), ["pin", "hide"])  # online-only
        self.assertEqual(self.actions("b.txt"), ["pin", "free", "hide"])  # downloaded
        self.assertEqual(self.actions("Part"), ["pin", "free", "hide"])  # partly here: both ways (#183, #176)
        self.assertEqual(self.actions("unseen.txt"), ["pin", "free", "hide"])  # not known yet
        self.assertEqual(self.h.files.actions_for([f"{ROOT}/Elsewhere/x"]), ["pin", "free", "hide"])
        self.assertEqual(self.actions(".git"), [])  # local only: Sync Now and Open only
        self.assertEqual(self.actions(".git", "a.txt"), ["free", "hide"])

    def test_what_kind_of_selection(self):
        self.assertEqual(self.h.files.selection([f"{ROOT}/Docs/a.txt"]), "items")
        self.assertEqual(self.h.files.selection([ROOT]), "drive")
        self.assertEqual(self.h.files.selection([f"{ROOT}/Docs/a.txt", f"{ROOT}/.Trash-1000"]), "drive")
        self.assertEqual(self.h.files.selection([f"{ROOT}/Docs/a.txt", "/home/u/x"]), "outside")
        self.assertEqual(self.h.files.selection([None]), "outside")

    def test_without_a_root_the_menu_uses_the_default_folder(self):
        h = Harness(root=None)
        self.assertEqual(h.files.selection([ext.FALLBACK_ROOT + "/x"]), "items")

    def test_an_action_posts_each_item_in_order_off_the_main_thread_and_shows_them_syncing_meanwhile(self):
        h = self.h
        h.answers["/availability"] = lambda body: {"state": "online-only", "kept": [], "refused": None}
        a, b = FakeFile(f"{ROOT}/Docs/a.txt"), FakeFile(f"{ROOT}/Docs/b.txt")
        for f in (a, b):
            h.files.file_info(f)
        h.requests.clear()
        h.threads.clear()
        h.files.act("free", [f"{ROOT}/Docs/a.txt", f"{ROOT}/Docs/b.txt", f"{ROOT}/Docs/.git"])
        self.assertEqual(a.invalidated, 1)
        h.files.file_info(a)
        self.assertEqual(a.emblems, ["emblem-synchronizing"])
        h.release()
        self.assertEqual(
            h.requests,
            [
                ("POST", "/availability", {"path": "Docs/a.txt", "action": "free"}),
                ("POST", "/availability", {"path": "Docs/b.txt", "action": "free"}),
            ],
        )
        self.assertTrue(all(t is not threading.main_thread() for t in h.threads))
        self.assertEqual(a.invalidated, 2)
        self.assertNotIn(f"{ROOT}/Docs/a.txt", h.files.busy)
        self.assertEqual(h.notes, [])

    def test_a_refused_hide_says_why(self):
        h = self.h
        reason = "Can't hide Docs: Docs/app/.git exists only on this computer"
        h.answers["/availability"] = lambda body: {"state": "pinned", "kept": [], "refused": reason}
        h.files.act("hide", [f"{ROOT}/Docs/a.txt"])
        h.release()
        self.assertEqual(h.notes, [("Can't hide a.txt", reason)])

    def test_kept_items_are_added_up(self):
        h = self.h
        h.answers["/availability"] = lambda body: {"state": "downloaded", "kept": ["x", "y"] if body["path"].endswith("a.txt") else ["z"], "refused": None}
        h.files.act("free", [f"{ROOT}/Docs/a.txt", f"{ROOT}/Docs/b.txt"])
        h.release()
        self.assertEqual(h.notes, [("Kept 3 item(s) on this computer", "They aren't in Proton Drive yet.")])

    def test_a_daemon_not_running_is_said_once(self):
        h = self.h
        h.answers["/availability"] = ext.ControlError("Can't reach the Proton Drive background service ([Errno 2])")
        h.files.act("pin", [f"{ROOT}/Docs/a.txt", f"{ROOT}/Docs/b.txt", f"{ROOT}/Docs/c.txt"])
        h.release()
        self.assertEqual(len([r for r in h.requests if r[0] == "POST"]), 1)
        self.assertEqual(h.notes, [(ext.NOT_RUNNING, "Start Proton Drive, then try again.")])

    def test_failures_name_the_items(self):
        h = self.h
        h.answers["/availability"] = ext.ControlError("Not in Proton Drive: x")
        h.files.act("pin", [f"{ROOT}/Docs/{n}" for n in ("a.txt", "b.txt", "c.txt", "d.txt", "e.txt")])
        h.release()
        self.assertEqual(h.notes, [("Proton Drive couldn't change a.txt, b.txt, c.txt and 2 more", "Not in Proton Drive: x")])


class ChangeTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness(
            {
                states_query(ROOT): {"self": None, "children": {"Docs": {"availability": "pinned", "transfer": None}, "Music": {"availability": "online-only", "transfer": None}}},
                states_query(ROOT + "/Docs"): DOCS_STATES,
                states_query(ROOT + "/Music"): {"self": None, "children": {"s.mp3": {"availability": "online-only", "transfer": None}}},
            }
        )
        self.docs = FakeFile(f"{ROOT}/Docs")
        self.music = FakeFile(f"{ROOT}/Music")
        self.a = FakeFile(f"{ROOT}/Docs/a.txt")
        self.b = FakeFile(f"{ROOT}/Docs/b.txt")
        self.song = FakeFile(f"{ROOT}/Music/s.mp3")
        for f in (self.docs, self.music, self.a, self.b, self.song):
            self.h.files.file_info(f)
        self.h.release()
        self.h.files.on_event({"type": "hello", "syncDir": ROOT, "mode": "virtual"})
        for f in (self.docs, self.music, self.a, self.b, self.song):
            f.invalidated = 0
            self.h.files.file_info(f)
        self.h.release()

    def test_a_change_invalidates_the_file_and_its_folders_and_drops_their_states(self):
        h = self.h
        h.files.on_event({"type": "changed", "paths": [ROOT, f"{ROOT}/Docs", f"{ROOT}/Docs/a.txt"], "subtrees": []})
        self.assertEqual((self.a.invalidated, self.docs.invalidated, self.b.invalidated, self.song.invalidated), (1, 1, 0, 0))
        self.assertIsNone(h.files.cache.get(f"{ROOT}/Docs", h.now))
        self.assertIsNone(h.files.cache.get(ROOT, h.now))
        self.assertIsNotNone(h.files.cache.get(f"{ROOT}/Music", h.now))

    def test_a_subtree_invalidates_everything_below_it_and_nothing_else(self):
        h = self.h
        h.files.on_event({"type": "changed", "paths": [ROOT, f"{ROOT}/Docs"], "subtrees": [f"{ROOT}/Docs"]})
        self.assertEqual((self.a.invalidated, self.b.invalidated, self.docs.invalidated), (1, 1, 1))
        self.assertEqual((self.music.invalidated, self.song.invalidated), (0, 0))

    def test_a_reset_to_another_root_clears_every_emblem(self):
        h = self.h
        h.files.on_event({"type": "reset", "syncDir": "/home/u/Elsewhere", "mode": "plain"})
        self.assertEqual(h.files.root, "/home/u/Elsewhere")
        for f in (self.docs, self.music, self.a, self.b, self.song):
            self.assertEqual(f.invalidated, 1)
            h.files.file_info(f)  # outside the new root: no emblem
            self.assertEqual(h.runs, [])
            self.assertEqual(f.emblems, [])
        self.assertEqual(h.files.cache.entries, {})

    def test_dead_files_are_let_go(self):
        tracker = ext.FileTracker()
        f = FakeFile("/x")
        tracker.track("/x", f)
        del f
        tracker.prune()
        self.assertEqual(tracker.refs, {})


def chunked(*lines):
    body = b""
    for line in lines:
        data = (json.dumps(line) + "\n").encode()
        body += f"{len(data):x}\r\n".encode() + data + b"\r\n"
    return body


class StreamTest(unittest.TestCase):
    def serve(self, payload):
        """A socket whose other end answers with payload, in small pieces, then closes."""
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)

        def answer():
            theirs.recv(65536)
            for i in range(0, len(payload), 5):
                theirs.sendall(payload[i : i + 5])
            theirs.close()

        threading.Thread(target=answer, daemon=True).start()
        return ours

    def test_reads_a_chunked_stream_line_by_line(self):
        head = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n"
        events = [{"type": "hello", "syncDir": ROOT, "mode": "virtual"}, {"type": "changed", "paths": [ROOT + "/é"], "subtrees": []}]
        sock = self.serve(head + chunked(*events) + b"0\r\n\r\n")
        seen = []
        with self.assertRaises(ext.StreamEnded):
            ext.read_event_stream(sock, seen.append)
        self.assertEqual(seen, events)

    def test_a_refusal_ends_it_at_once(self):
        sock = self.serve(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}')
        seen = []
        with self.assertRaises(ext.StreamEnded):
            ext.read_event_stream(sock, seen.append)
        self.assertEqual(seen, [])

    def test_follow_reconnects_with_growing_waits_and_says_when_it_is_down(self):
        head = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        attempts = []
        sleeps = []
        downs = []
        seen = []

        def connect():
            attempts.append(1)
            if len(attempts) in (2, 3):
                raise OSError("refused")
            return self.serve(head + chunked({"type": "hello", "syncDir": ROOT, "mode": "virtual"}) + b"0\r\n\r\n")

        ext.follow_events(seen.append, lambda: downs.append(1), connect=connect, sleep=sleeps.append, stop=lambda: len(attempts) >= 4)
        self.assertEqual(len(seen), 2)
        self.assertEqual(len(downs), 4)
        # A stream that gave events starts the waits over at 1 s; failures in a row make them grow
        self.assertEqual(sleeps, [1, 2, 4])


if __name__ == "__main__":
    unittest.main()
