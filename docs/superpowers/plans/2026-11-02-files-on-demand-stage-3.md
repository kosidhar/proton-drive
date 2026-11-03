# Files On-Demand, Stage 3 (Files integration) Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking. Work task by task; each task ends green and committed.

**Goal:** Make the drive readable and manageable from GNOME Files:
- the three status emblems of spec §2.3 on every file and folder inside the drive;
- the right-click actions "Always keep on this device", "Free up space" and "Hide from this computer", on one or many items;
- emblems that update by themselves within about 2 s of a change, with Files open on the folder.

**Spec:** `docs/superpowers/specs/2026-10-23-files-on-demand-design.md`, delivery step 3 of §6 (§2.3, §2.5, §2.6, §5.5, and the emblem part of §5.8).
- Builds on Stage 2, merged as `f521607`.
- **Tracking issue:** #52. Follow-ups found while building it: #53 (folder emblems and files waiting to upload), #54 (`install.sh --uninstall` leaves the app icons).
- **Already done in Stage 2:** clearing GNOME's failed-thumbnail entries after a download (see the Stage 2 plan, "Deviation from §6").
- **Out of scope (Stage 4):** the mass-download notice and "Block this app", the user blocklist in Settings, and the Trash and Settings polish.
- **Nemo** keeps today's menu (spec §3 makes parity optional). Dolphin is unchanged. `/api/file-status` stays on the TCP API for them, unchanged.

**Architecture:**
- **Daemon (Bun).** Two new read-only routes on the existing user-only control socket (`defaultControlSocketPath()`):
  - a batched state route answering for a folder and all its children at once;
  - a newline-delimited JSON stream of state changes.

  A small `StateEvents` bus in the engine collects changed paths from the places that change state, and sends them out coalesced.
- **Nautilus extension (Python).** It talks only to the control socket, never the TCP API:
  - Emblems come from a per-folder cache, filled by one batched request per folder. Fetching runs off the GTK thread through `update_file_info_full`, so Files never waits on the daemon.
  - Menu actions post to the existing `POST /availability` route from a worker thread, and failures become desktop notifications.
  - One background thread follows the event stream. It drops stale cache entries and calls `invalidate_extension_info()` on the affected files, from the GLib main loop.
- **No change to `protondrive-vfs`** (no xattrs). The same extension therefore works in plain-folder mode (§5.9), where `syncDir` is the backing store itself.

**Tech stack:** Bun + TypeScript (`bun:test`); Python 3 with nautilus-python 4 (GTK 4 Files), tested with `unittest` and stand-ins for `gi`; SVG emblems.

## Global Constraints

- **Emblem names and meaning** (installed to `<prefix>/share/icons/hicolor/scalable/emblems/`):

  | Name | State | Drawing (16×16 viewBox) |
  |---|---|---|
  | `emblem-protondrive-pinned` | Always keep on this device | solid green circle (`#1ea672`), white check |
  | `emblem-protondrive-local` | Downloaded | white circle, green ring (`#1ea672`, 1.5 px), green check |
  | `emblem-protondrive-cloud` | Online only | grey (`#77777c`) cloud outline, filled 85% white (reads on dark backgrounds, like OneDrive's) |

  Transient states keep the stock emblems: `emblem-synchronizing` (uploading, downloading, waiting to upload, opening) and `emblem-important` (error, conflict). A transient state replaces the availability emblem; Files shows them small, so one emblem per item.
- **Folder rule (§5.5):** solid when the folder is effectively pinned; green ring when everything inside is downloaded; grey cloud when anything inside is online-only. This is what `AvailabilityPolicy.stateOf` already computes.
- **No emblem** for: the drive's root itself; local items matching an ignore pattern (§5.4); `.xdg-volume-info`, `.Trash-*` and `.proton-drive-tmp-*`; anything outside `syncDir`.
- **Never block Files.**
  - `update_file_info_full` answers `IN_PROGRESS` and completes later whenever the folder's states aren't cached.
  - `get_file_items` reads only the cache, with no I/O. Items whose state isn't known yet get both "Always keep" and "Free up space".
  - Every socket request runs on a worker thread, and all GTK/Nautilus calls go back through `GLib.idle_add`.
- **Read-only routes only.** The new routes change nothing. State changes keep going through `POST /availability`. Nothing new is added to the TCP API.
- **Security.** The extension checks the socket's folder the way the tray does (`socket_dir_problem`: owned by the user, mode 0700) before connecting.
- **Menu copy:**
  - `Always keep on this device`;
  - `Free up space`;
  - `Hide from this computer`;
  - existing: `Proton Drive: Sync Now`, `Open Proton Drive`.
- **Notification copy:**
  - for a refused hide: title `Can't hide <name>`, body the daemon's `refused` text;
  - when Free up space kept items: `Kept <n> item(s) on this computer` / `They aren't in Proton Drive yet.`;
  - when the daemon can't be reached: `Proton Drive isn't running`.
- **Checks for every task:**
  - `bun test tests` and `bunx tsc --noEmit` pass. As of `f521607`, `tsc` already fails on the deprecated `baseUrl` in `tsconfig.json`; Task 0 fixes that first.
  - `python3 linux/nautilus/test_proton_drive_nautilus.py` and `python3 linux/tray/test_proton_drive_tray.py` pass.
  - Run as a normal user: three layout tests rely on read-only folders and fail as root.
- **Commits:** conventional style. Work on a local branch `files-on-demand-stage-3` from `main-epgufb`. At the end, merge it into `main-epgufb` with `--no-ff` (as Stages 1 and 2 were) and push `main-epgufb` only.

## Review Focus

1. **Files on a folder of 500 items, the daemon slow or stopped.**
   - Expected: the listing appears at once; emblems fill in when the daemon answers, or never; right-click opens at once.
   - Pinned in **Task 4** (async fetch, cache-only menu) and **Task 7**.
2. **Free up space on a folder with Files open on it.**
   - Expected: the folder's and children's emblems go grey within about 2 s, with no refresh by hand; the parents up to the root update too.
   - Pinned in **Task 1** (ancestor and subtree events) and **Task 6**.
3. **The event stream under load,** for example the first sync of thousands of files.
   - Expected: events are coalesced; a slow or dead reader never grows the daemon's memory, it is dropped and told to reset; the extension reconnects and refetches.
   - Pinned in **Task 1** and **Task 3**.
4. **Hide on a folder holding an ignored `.git`.**
   - Expected: nothing is hidden, and a notification names the `.git`.
   - Pinned in **Task 5**.
5. **`syncDir` moved, or the virtual drive switched off, with Files open.**
   - Expected: the extension follows the new root, and no emblem stays stuck.
   - Pinned in **Task 3** (`root` and `reset` events) and **Task 6**.

---

### Task 0: Branch, and a green type check

- [x] **Step 1:** `git switch -c files-on-demand-stage-3 main-epgufb`.
- [x] **Step 2:** Remove the deprecated `baseUrl` from `tsconfig.json`. Every `paths` entry already starts with `./`, so they resolve from the tsconfig without it. `bunx tsc --noEmit` passes again.
- [x] **Step 3:** Commit `chore: drop the deprecated baseUrl so the type check passes`.

---

### Task 1: State change events in the engine

**Files:**
- Create: `src/sync/stateEvents.ts`
- Modify: `src/sync/syncStateDb.ts`, `src/sync/availability.ts`, `src/sync/remoteIndex.ts`, `src/sync/syncEngine.ts`
- Test: `tests/stateEvents.test.ts`, plus cases in `tests/syncEngine.test.ts` (`describe('state events')`)

**Interfaces:**
```ts
export interface StateChange { paths: string[]; subtrees: string[] } // relative to the drive root; '' is the root
export class StateEvents {
    constructor(opts?: { delayMs?: number /* 250 */; maxPaths?: number /* 2000 */ });
    touch(relPath: string): void;        // relPath and every ancestor up to ''
    touchSubtree(relPath: string): void; // as touch, and everything below relPath
    reset(): void;                       // everything may have changed (mode switch, sign-out, syncDir moved)
    subscribe(listener: (change: StateChange | 'reset') => void): () => void;
    stop(): void;                        // drops the pending timer
}
```
- Changes are coalesced. The first `touch` starts a `delayMs` timer, and everything touched until it fires goes out as one `StateChange`.
  - Paths are sorted and deduplicated.
  - A subtree swallows the paths and subtrees below it.
- If more than `maxPaths` would go out at once, listeners get `'reset'` instead.
- A listener that throws is removed, and the others still run.

**Where to touch.** Each source gets an optional `onChange` callback, set by the engine to its `StateEvents`, so the DB classes stay independent of the bus.
- `SyncStateDb`:
  - `upsertItem`, `removeItemByPath`, `removeItemByNodeUid`, `setItemStatus`: `touch(path)`;
  - `renameItemPath(from, to)`: `touchSubtree(from)` and `touchSubtree(to)`;
  - conflict add and resolve: `touch(path)`.
- `AvailabilityPolicy`:
  - `setPin` and `setHide`: `touchSubtree(path of uid)`.
- `RemoteIndex`:
  - an insert, update or remove of a node: `touch(path)`;
  - a move: `touchSubtree(old)` and `touchSubtree(new)`.
- **Engine:**
  - the start and end of a hydrate (the "opening" state): `touch`;
  - a local file seen by the watcher that isn't indexed yet (waiting to upload): `touch`;
  - `reset()` after a mode switch, a `syncDir` relocation, a sign-out, and a layout move.
- The engine exposes `readonly stateEvents: StateEvents`.

- [x] **Step 1: Failing tests.**
  - **`StateEvents`, with a fake clock:**
    - touching `a/b/c.txt` sends `['', 'a', 'a/b', 'a/b/c.txt']` once after 250 ms;
    - two touches within the delay give one change;
    - `touchSubtree('a')` with `touch('a/x')` gives `subtrees: ['a']` and no `a/x` path;
    - 2001 distinct paths give `'reset'`;
    - a listener that throws is removed;
    - `stop()` cancels the timer.
  - **Engine:**
    - after `setAvailability('Docs', 'free')` the listener sees subtree `Docs`;
    - after a download is recorded for `Docs/a.txt` it sees `Docs/a.txt` and `Docs`;
    - after `renameItem('a', 'b')` it sees both subtrees;
    - a relocation sends `'reset'`.
- [x] **Step 2: Run** the tests. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the full suite and tsc. Expected: pass.
- [x] **Step 5: Commit** `feat(sync): coalesced state change events for the file manager`.

---

### Task 2: States of a folder's children in one call

**Files:**
- Modify: `src/sync/availability.ts`, `src/sync/syncEngine.ts`
- Test: `tests/availability.test.ts` (`describe('childStates')`), `tests/syncEngine.test.ts` (`describe('itemStates')`)

**Interfaces:**
```ts
export type Transfer = 'syncing' | 'error' | 'conflict' | null;
export interface ItemState { availability: 'pinned' | 'downloaded' | 'online-only'; transfer: Transfer }
// policy: availability of each indexed, non-hidden child of a folder, in a fixed number of queries
childStates(folderRel: string): Map<string, ItemAvailability>; // child name -> state
// engine
itemStates(folderRel: string): { self: ItemState | null; children: Record<string, ItemState | null> } | null; // null: not a folder in the drive
```
- **`childStates`** must answer a folder of 5,000 children in under 50 ms on the test machine.
  - The folder's own effective pin is worked out once, and each child's explicit flag is applied on top of it.
  - A single query, grouped by the first path segment below the folder, finds which child folders hold a file with no `synced_items` record.
  - Its results must equal `stateOf` for every child (property test over random trees).
- **`itemStates`:**
  - **Children:** every name a listing of the folder would show (index plus `localRoot()`, minus hidden items and temp files, as `vfsChildren` does). Then:
    - local items matching an ignore pattern get `null`;
    - local items not in the index yet get `{ availability: 'downloaded', transfer: 'syncing' }`;
    - `transfer` comes from the `synced_items` status (`uploading` and `downloading` give `syncing`; `error` gives `error`), from an unresolved conflict on the path (`conflict`), and from an in-flight hydrate (`syncing`).
  - **Folders:** a folder gets `syncing` when any item below it is transferring, `error` when any has an error, and `conflict` when any has a conflict.
    - This counts only what is recorded (`synced_items`, conflicts, in-flight hydrates). A local file waiting to upload shows `syncing` on itself but not on its folders: finding those below a folder would need a disk scan, and a folder's emblem must be the same whether Files shows it from its parent or from inside it.
    - All three come from one grouped query each, the same way as `childStates`.
    - Precedence: conflict, then error, then syncing.
  - `self` is the folder's own state, or `null` for the root.
  - **Hidden or `hiding`** items are left out of `children`. A `hiding` folder still lists as hidden, since it's on its way out.

- [x] **Step 1: Failing tests.**
  - `childStates` equals `stateOf` on random trees with pins, unpins, hides and partial downloads.
  - The 5,000-child timing.
  - `itemStates`:
    - an ignored local `.git` is `null`;
    - a new local file is `syncing`;
    - a file with an error makes its folder and the folder's parent `error`;
    - a conflict wins over an error;
    - a hidden child is absent;
    - a path that is a file answers `null`.
- [x] **Step 2: Run** the tests. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the suite and tsc. Expected: pass.
- [x] **Step 5: Commit** `feat(sync): states of a folder's children in a fixed number of queries`.

---

### Task 3: Control routes for the file manager

**Files:**
- Create: `src/daemon/fileManagerRoutes.ts`
- Modify: `src/daemon/controlServer.ts`, `src/daemon/controlWiring.ts`
- Test: `tests/fileManagerRoutes.test.ts`

**Routes** (control socket only; read-only):
- `GET /fm/root` returns `{ syncDir, mode: 'virtual' | 'plain', mounted: boolean }`.
- `GET /fm/states?path=<absolute folder path>`:
  - For a folder inside `syncDir`, it returns `{ path, self, children }` from `itemStates`, with `path` echoed as given.
  - It returns 404 `{ error, code: 'ENOENT' }` for a path outside `syncDir`, or one that isn't a folder in the drive.
  - The mapping from absolute to relative paths:
    - uses `path.relative` and refuses anything that climbs out, as `existsInSyncFolder` does;
    - accepts `syncDir` itself (`''`);
    - does **not** resolve symlinks, because the mount point is the path Files shows.
- `GET /fm/events` is a stream with `Content-Type: application/x-ndjson`. Each line is one JSON object:
  - first `{ "type": "hello", "syncDir": "...", "mode": "virtual" }`;
  - then `{ "type": "changed", "paths": [abs...], "subtrees": [abs...] }`, from `StateEvents`, with paths made absolute under the current `syncDir`;
  - `{ "type": "reset", "syncDir": "...", "mode": "..." }` on a `StateEvents` reset, sent with the then-current root;
  - `{ "type": "ping" }` every 30 s, so readers notice a dead daemon.

**Backpressure:**
- Each stream has a queue of at most 64 lines. When it is full, the server sends one `reset` line if it can, then closes the stream.
- The listener is unsubscribed when the stream closes or is cancelled.
- At most 16 event streams are open at once; the 17th gets 503.

- [x] **Step 1: Failing tests**, against a fake engine and a temporary socket:
  - `/fm/states` for `syncDir/Docs` maps to `Docs`; for `syncDir` maps to `''`; for `syncDir/../x` and `/tmp` answers 404; a name with a space and `é` survives.
  - `/fm/events` sends `hello` first, then a coalesced `changed` with absolute paths, then `reset` after `stateEvents.reset()`.
  - A reader that never reads, followed by 100 changes, gets the stream closed, and the server's listener count goes back to 0.
  - A 17th stream gets 503.
- [x] **Step 2: Run** the tests. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the suite and tsc. Expected: pass.
- [x] **Step 5: Commit** `feat(daemon): folder states and a change stream for the file manager`.

---

### Task 4: Emblems in the Nautilus extension

> Tasks 4, 5 and 6 change one file and landed as one commit, `feat(nautilus): emblems, right-click actions and live refresh for the drive`. The extension's state lives in a `ProtonDriveFiles` class that only the main loop touches, with the socket, the worker threads, notifications and Nautilus's completion injected, so all three tasks are tested without Nautilus. The stream reader was also checked against the real Bun control server (chunked transfer encoding, non-ASCII paths).

**Files:**
- Modify: `linux/nautilus/proton_drive_nautilus.py`
- Create: `linux/nautilus/test_proton_drive_nautilus.py`

**Structure of the extension** (one file; nautilus-python loads every `.py` in its folder as an extension, so there is no shared helper module):
- **Control socket client.**
  - Copy `control_socket_path`, `socket_dir_problem`, `connect_control_socket`, `build_request`, `parse_response` and `control_request` from the tray, unchanged.
  - Keep them identical to the tray's; a test compares the two sources.
  - Timeouts: connect 0.5 s, read 2 s for `/fm/*`.
- **`FolderCache`:** absolute folder path to `{ self, children, fetched_at }`.
  - It keeps at most 256 folders, evicting the least recently used.
  - It has no TTL; the event stream invalidates entries (Task 6).
  - When the stream is down, entries older than 10 s are refetched on the next request.
- **Root.** `GET /fm/root` at start and on every `hello` and `reset`. This replaces the hard-coded `~/ProtonDrive`.
  - Until the root is known, every request is ignored, cheaply.
- **`update_file_info_full(provider, handle, closure, file)`:**
  - It returns `COMPLETE` at once, with no emblem, for: non-`file://` URIs; paths outside the root; the root itself; and names starting `.Trash-`, `.proton-drive-tmp-` or equal to `.xdg-volume-info`.
  - If the parent folder is cached, it adds the emblem and returns `COMPLETE`.
  - Otherwise it queues `(handle, closure, file)` under the parent folder and returns `IN_PROGRESS`.
    - Only one fetch per folder is in flight; later files join the queue.
    - The worker calls `/fm/states`. In the main loop, the cache is filled and each queued file gets its emblem and `Nautilus.info_provider_update_complete_invoke(closure, provider, handle, COMPLETE)`.
    - On error, every queued file completes with `FAILED` and nothing is cached.
  - `cancel_update(provider, handle)` drops the handle from its queue.
- **`emblem_for(state)`**, a pure function:
  - `None` gives `None`;
  - `transfer` `conflict` or `error` gives `emblem-important`;
  - `syncing` gives `emblem-synchronizing`;
  - otherwise it maps `pinned`, `downloaded` and `online-only` to the three emblems.
- **Remove** the old `update_file_info` and `/api/file-status` calls. Keep `_neutralize_legacy_extension`.

**Tests** (stand-ins for `gi`, as in the tray's tests; a fake socket server on a temporary path):
- `emblem_for` for every combination.
- Path filtering, including a sibling folder whose name only starts with the root's (`~/ProtonDrive2`).
- Twenty files of one folder give one request, and every file completes.
- A daemon that doesn't answer gives `FAILED` within the read timeout, and nothing is cached.
- LRU eviction.
- The client functions match the tray's source.

- [x] **Step 1:** Write the failing tests.
- [x] **Step 2: Run** `python3 linux/nautilus/test_proton_drive_nautilus.py`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** both Python test files. Expected: pass.
- [x] **Step 5: Commit** `feat(nautilus): availability emblems from one request per folder, off the UI thread`.

---

### Task 5: Right-click actions

**Files:**
- Modify: `linux/nautilus/proton_drive_nautilus.py`
- Test: `linux/nautilus/test_proton_drive_nautilus.py`

**Menu** (`get_file_items(files)`, for files inside the root, excluding the root itself; uses the cache only):
- **Visibility:**
  - `ProtonDrive::Pin` "Always keep on this device": shown unless every selected item is known to be `pinned`.
  - `ProtonDrive::Free` "Free up space": shown when any selected item is `pinned` or `downloaded`, or its state isn't known.
  - `ProtonDrive::Hide` "Hide from this computer": always shown.
  - The existing "Proton Drive: Sync Now" and "Open Proton Drive" items stay last.
  - An item whose state is `None` (ignored or local-only) gets only Sync Now and Open. If every selected item is `None`, the three new items are left out.
- **On activate:**
  - A worker thread posts `POST /availability {path, action}` for each item in turn, with relative paths and a 10-minute read timeout per request.
  - The menu returns at once. While the actions run, the affected folders' cache entries are dropped and their files invalidated, so they show `emblem-synchronizing` until the events refresh them.
  - **After all items** (main loop):
    - one notification per refused hide (`Can't hide <name>`, plus the daemon's reason);
    - one notification adding up the `kept` items of Free up space;
    - one notification listing items that failed (the daemon's error text, at most 3 names then `and <n> more`).
  - If the daemon isn't reachable, one notification: `Proton Drive isn't running`.
- **Background menu** (right-click on empty space): unchanged, apart from using the root from `/fm/root`.

**Tests:**
- Menu sets for: all pinned; mixed; unknown state; an ignored item; the root; a path outside the drive.
- Activation posts one request per item with the right relative paths, in order, from a non-main thread.
- A refused hide gives the notification with the `.git` reason.
- `kept` items are added up across items.
- An unreachable daemon gives one notification.

- [x] **Step 1:** Write the failing tests.
- [x] **Step 2: Run** the tests. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** both Python test files. Expected: pass.
- [x] **Step 5: Commit** `feat(nautilus): Always keep, Free up space and Hide from the right-click menu`.

---

### Task 6: Live refresh

**Files:**
- Modify: `linux/nautilus/proton_drive_nautilus.py`
- Test: `linux/nautilus/test_proton_drive_nautilus.py`

**Behaviour:**
- **The reader thread.** One daemon thread reads `GET /fm/events` line by line.
  - It reconnects with backoff (1, 2, 4 … 30 s) after an error, an end of stream, or 75 s without a line (two missed pings).
  - It parses lines and hands each event to the main loop with `GLib.idle_add`.
- **`FileTracker`.** A dict from absolute path to a `weakref` of the `Nautilus.FileInfo` last given to `update_file_info_full`, at most 20,000 entries, with dead refs pruned on each event.
- **`changed`:**
  - For each path, drop the cache entry of its parent folder and of the path itself (when it is a folder), then `invalidate_extension_info()` its tracked file.
  - For each subtree, drop every cache entry at or below it, and invalidate every tracked file at or below it.
- **`hello` and `reset`:**
  - Adopt the new `syncDir` and clear the whole cache.
  - Invalidate every tracked file, both those under the old root (so their emblems clear) and those under the new one.
- **Stream down:** the 10 s cache refetch rule of Task 4 applies, so emblems are never stuck for long.

**Tests:**
- A fake server sends `hello`, then `changed` for `<root>/Docs/a.txt` with ancestors. The tracked `a.txt`, `Docs` and the root's children are invalidated, and the `Docs` cache entry is gone.
- A subtree event invalidates every file below it, and nothing outside it.
- A `reset` to a new root clears emblems under the old root.
- The server closes the stream and the reader reconnects. Use a fake clock for the backoff.
- Dead weakrefs are pruned.

- [x] **Step 1:** Write the failing tests.
- [x] **Step 2: Run** the tests. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** both Python test files. Expected: pass.
- [x] **Step 5: Commit** `feat(nautilus): emblems follow changes within seconds, without a refresh`.

---

### Task 7: Emblem icons and packaging

**Files:**
- Create: `linux/icons/emblems/emblem-protondrive-pinned.svg`, `…-local.svg`, `…-cloud.svg`
- Modify: `packaging/linux/install.sh`, `packaging/linux/package.sh`, `packaging/linux/arch/PKGBUILD` (if it stages its own files), `packaging/linux/postinst.sh`

**Steps:**
- [x] **Step 1: Draw** the three SVGs to the table in Global Constraints.
  - 16×16 viewBox, no text, no external references, no scripts.
  - Each must stay readable at 16 px on both a light (`#ffffff`) and a dark (`#242424`) background. The white disc of `-local` and a 1 px white halo around the cloud of `-cloud` give the contrast.
- [x] **Step 2: Check** by rendering each at 16, 32 and 64 px on both backgrounds into the scratchpad (`rsvg-convert`, or Chromium through Playwright if that is missing), then look at the PNGs.
- [x] **Step 3: Install** the emblems into `share/icons/hicolor/scalable/emblems/` in every install path (`install.sh --user`, the release staging in `package.sh`, and so the .deb, .rpm, tar and Arch builds), then refresh the icon cache as each path already does.
  - `install.sh` uninstall removes `emblem-protondrive-*`.
  - The release tree (`install.sh` from a release) copies `share/icons/hicolor` whole, so it gets them through the staging. The Flatpak build gets them too, from the same staging; they are unused there.
- [x] **Step 4: Check** with `bash packaging/linux/install.sh --user` into a temporary `PREFIX` (or `--dry-run` if it has one) that the three files land where expected. Also check the staged tree from `package.sh` with the build step skipped, if it allows that; otherwise inspect it by reading.
- [x] **Step 5: Commit** `feat(packaging): install the Proton Drive emblems`.

---

### Task 8: Docs, review and merge

- [x] **Step 1: README.** Update the Files section: the three icons and their meanings, the right-click actions, "unhide in the app", and that Files must be restarted (`nautilus -q`) after an upgrade.
- [x] **Step 2: Review** the whole branch diff against the Review Focus list and the Global Constraints. Fix what is found, each fix as its own commit.
- [x] **Step 3: Run** every check in Global Constraints, plus `cargo test` in `native-vfs` (it should be untouched, so it is a guard only).
- [x] **Step 4: Merge** with `git switch main-epgufb && git merge --no-ff files-on-demand-stage-3 -m "Merge branch 'files-on-demand-stage-3': Proton Drive emblems and actions in Files"`, then `git push -u origin main-epgufb`.

---

### Task 9: Acceptance on the real desktop (the user, GNOME 50)

This needs the user's machine; the build container has no desktop. Each line is a pass or fail; anything that fails becomes a fix on `main-epgufb`.

1. **Install and restart.** Install the build, then run `nautilus -q`, `systemctl --user restart protondrive`, and open Files.
2. **Emblems:**
   - Open `~/ProtonDrive`. Pinned top-level folders show the solid green emblem, and former Cloud only folders show the grey cloud.
   - The listing appears at once, and emblems follow within a second.
3. **Open an online-only file.** Double-click an online-only PDF. It opens, and its emblem goes grey, then synchronizing, then the green ring, within about 2 s of the download finishing, with no refresh by hand.
4. **Free up space** on a downloaded folder with Files open on it:
   - The folder and its files go grey within about 2 s, and its parent updates if it was all-downloaded before.
   - `du -sh ~/.local/share/proton-drive-ubuntu/files` drops.
5. **Always keep** on an online-only folder: its emblem is solid at once, and its files download and go solid.
6. **Hide:**
   - Hide on a folder makes it disappear from Files.
   - Hide on a folder holding `.git` shows the notification naming it, and nothing changes.
   - The app's My files lists the hidden folder with Unhide, which brings it back as online-only.
7. **Multi-select.** Select five mixed items: the menu matches the rules of Task 5, and Free up space acts on all five.
8. **Daemon stopped.** With `systemctl --user stop protondrive`, Files still lists, the menu opens, and an action notifies `Proton Drive isn't running`. After a restart, emblems come back within about 30 s.
9. **Large folder.** A folder of 500 online-only images in grid view: scrolling stays smooth, and the activity log shows no downloads.
10. **API check.** Confirm that `Nautilus.InfoProvider.update_file_info_full` and `invalidate_extension_info` behave as described on this Files version. If they don't, record the fallback taken (a synchronous fetch per folder, cached).
