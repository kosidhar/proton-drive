# Files On-Demand: Proton Drive as a virtual drive in Files

Status: approved · 2026-10-24

## 1. Intent

The user wants Proton Drive on Linux to behave like OneDrive on Windows:

- Proton Drive appears in the GNOME Files (Nautilus) sidebar.
- Files shows the **whole drive**, including files that aren't downloaded. Hidden items are the exception.
- Opening a file that isn't downloaded downloads it, then opens it.
- Icons show what is on this computer.
- Right-click lets the user keep things on the device or free up space.

**Why this matters**

- Today `~/ProtonDrive` is a plain folder. It only shows what is downloaded.
- Marking a top-level folder "Cloud only" in the app deletes its local copy, so the folder disappears from the file system entirely.
- The only way to see or open a cloud-only file is through the app.
- Saving disk space today means making whole top-level folders invisible.

Once online-only items become visible, the user also wants a way to keep chosen folders out of Files completely. That is the **hide** feature.

**Prior art on this machine**

- `~/OneDrive` is an rclone FUSE mount.
- `~/pCloudDrive` is pCloud's FUSE mount.
- Both show in the Files sidebar, in the mounts section with an eject arrow.
- When the pCloud app isn't running, `~/pCloudDrive` is empty.

The user accepted that same trade-off for Proton Drive.

## 2. What the user sees (agreed with the user)

1. **Sidebar.** `~/ProtonDrive` is a mounted drive and shows in the Files sidebar the way OneDrive and pCloudDrive do.

2. **Whole tree.** Every file and folder in *My files* is listed, with its real name, size and modified time. Hidden items and items matching an ignore pattern are left out (§5.4).

3. **Three states, with OneDrive's meanings and icons.**

   | State | Meaning | Icon |
   |---|---|---|
   | Always keep on this device | Pinned. It and everything inside it stay downloaded, including new files that arrive later. | Solid green circle with a white check |
   | Downloaded | There is a local copy, but the space can be freed. | White circle with a green ring and a green check |
   | Online only | Not on disk. It downloads when opened. | Grey cloud outline |

   Transient states use the existing stock emblems: `emblem-synchronizing` for syncing, and `emblem-important` for errors and conflicts.

4. **Opening an online-only file.** Double-click it and it downloads, then opens in its app. After that it is *Downloaded*.

5. **Right-click (Nautilus).** "Always keep on this device" and "Free up space".
   - Free up space deletes the local copy and keeps the cloud copy.
   - Both actions work on several selected items at once.

6. **Hide.** This is separate from online-only.
   - A hidden item doesn't appear in Files at all, and nothing inside it downloads.
   - "Hide from this computer" is in the right-click menu.
   - You can't right-click something you can't see, so **unhiding happens in the app's My files tab**. Hidden items are listed there, greyed out, with an Unhide action.

7. **Saving and editing** in the drive uploads changes, as today.

8. **Ignore patterns** keep their current job: matching local files aren't uploaded.

9. **Existing users.** On upgrade:
   - Everything that is synced today becomes *Always keep on this device*, so nothing leaves the disk.
   - Folders that are "Cloud only" today become visible as *Online only*. They are **not** hidden.

10. **Space is only freed when the user asks.** Nothing frees space automatically.

11. **When the app isn't running,** `~/ProtonDrive` looks empty until it starts. Downloaded files stay safe in a hidden folder.

12. **The download-and-open flow and the icon meanings follow OneDrive.** The user confirmed both.

## 3. Goals, non-goals, anti-goals

**Goals**
- All of §2.
- No data loss during or after migration.
- Today's two-way sync keeps working for everything that is downloaded.

**Non-goals for v1**
- **Streaming.** Opening a file downloads it in full before the open returns. Partial or range reads are not supported, although the SDK has `getSeekableStream()`.
- **Cloud thumbnails** for online-only files.
- **Automatic space reclaim**, like Windows Storage Sense.
- **Nautilus's own Trash, Undo and Restore** for items deleted inside the drive. Deleted items go to the Proton Drive trash, which the user restores from Proton's apps.
- **Other roots.** "Shared with me", Devices and Photos stay out of the drive. Only *My files* is in it, as today.
- **Flatpak.** The Flatpak build doesn't get the virtual drive (see §5.9).
- **Nemo parity.** Nice to have, but not required. Nemo must keep working at least as well as today.

**Anti-goals**

Any of these makes the feature a failure, even if everything else works.

- **Cloud data loss.** Freeing space, migration, a helper crash, an eject or an unmounted mount point must never be treated as "the user deleted these files", and must never trash cloud items. Today the engine trashes the remote node when a tracked local file goes missing (`reconcileSinglePath` case 1, `handleLocalFileChange`). Every path that removes local copies must go through state changes first.
- **Silent mass downloads.** Known background readers must never download the drive. These are thumbnailers, desktop search indexers and extractors, Files' content-type sniffing, and Files' folder-size counting. Any other app that reads a file does download it, as on OneDrive; copying files out of the drive has to work. When one app downloads many files, the user is told and can block it (§5.3).
- **A frozen file manager.** Listing a folder or stat-ing a file must never wait on the network.
- **Stub content leaking out.** An app must never read a zero-length or placeholder file as if it were the real content. A stub must never be uploaded over the real cloud file.
- **Rename as delete and re-upload.** Moves and renames inside the drive must become remote moves and renames (keeping version history and share links), not trash-and-re-upload.

## 4. Constraints and facts about the current code

- **Platform:** GNOME Files 50 (Nautilus with nautilus-python), kernel 7.0, `fuse3` and `fusermount3` installed, `/dev/fuse` present.
- **Daemon:** Bun/TypeScript (`src/`). Bun has no maintained FUSE binding. The GUI is Rust/egui (`native-gui/`). The tray and file-manager extensions are Python (`linux/`).
- **Proton SDK** (`@protontech/drive-sdk`) has `renameNode`, `moveNodes`, `trashNodes`, `restoreNodes`, `iterateFolderChildren`, `iterateThumbnails`, `getFileDownloader` (with `downloadToStream` and `getSeekableStream`), and `getFileUploader`/`getFileRevisionUploader`. Content is end-to-end encrypted and stored in blocks.
- **Sync engine** (`src/sync/syncEngine.ts`):
  - It is a reconcile loop over *(remote child, local entry, DB record)* per folder (`reconcileDirectoryIncremental`, `reconcileSinglePath`), plus a local watcher and Drive events.
  - `synced_items` (`src/sync/syncStateDb.ts`) only tracks items that exist both locally and remotely.
  - **There is no persistent index of the remote tree.** Listings are fetched live through the SDK.
  - A remote rename currently shows up as delete-and-recreate.
- **Selective sync** today is a list of top-level folder names (`settings.excludedFolders`). Excluding a folder deletes its local copy (`applySelectiveSyncExclusions`). Since #9, this happens only when every file in it is an unchanged synced copy; otherwise the exclusion is refused and the user is told why.
- **Data paths:**
  - State DB: `$XDG_DATA_HOME/<APP_DIR_NAME>/ubuntu-sync-state.sqlite` (`appDir` in `src/sdk/config.ts`).
  - Sync dir: the `syncDir` setting, default `~/ProtonDrive`. It can be moved (`relocateSyncFolder`).
- **Daemon API:** HTTP on `127.0.0.1:49152` (`src/daemon/daemonServer.ts`). It runs as the `protondrive.service` systemd user unit. Since #8 it rejects requests that don't come from a local non-browser client (a loopback `Host`, and no `Origin` or `Sec-Fetch-Site` header). It still has no authentication against other local users or sandboxed apps.
- **Nautilus extension** (`linux/nautilus/proton_drive_nautilus.py`) already:
  - adds "Sync Now" and "Open Proton Drive" menu items;
  - adds emblems by calling `GET /api/file-status` once per file, synchronously, with a 0.35 s timeout.
- **This user's data:** about 13 GB in the cloud, of which about 5.3 GB (372 files) is local today.

## 5. Design

### 5.1 Architecture

```
 Apps / Files ──► ~/ProtonDrive  (FUSE mount, served by protondrive-vfs, Rust)
                        │  local items: passthrough to the backing store
                        │  online-only: metadata from the index; content hydrated on open
                        ▼
                 backing store  $XDG_DATA_HOME/<APP_DIR_NAME>/files   (real directory)
                        ▲
                        │  two-way sync, as today
                 protondrive daemon (Bun) ── Proton Drive cloud
                        │  remote index + availability policy (SQLite)
                        └── local control socket ◄── protondrive-vfs, extensions, GUI, CLI
```

- **Backing store** (my call: `<appDir>/files`). This is a real directory holding every downloaded file and every local-only file, laid out exactly like the drive. The sync engine keeps syncing between the cloud and this directory. Today it syncs `syncDir`, so the engine's job barely changes.
- **`protondrive-vfs`** (name is the builder's call). This is a new Rust binary, built with `fuser`, that mounts the drive at `syncDir`.
  - Downloaded and local-only items pass straight through to the backing store.
  - Online-only items are presented from the remote index. Their content is fetched into the backing store when they are opened.
  - The daemon starts and supervises it (my call), so it follows the daemon's lifecycle under systemd.
- **Remote index** (new). This is a persistent table holding the whole *My files* tree, with per-node fields `uid`, `parentUid`, `name`, `type`, `size`, `mtime`, `sha1` and `activeRevision`.
  - The full reconcile and Drive events keep it current.
  - All drive listings come from the index plus the backing store, never from a live network call.
  - The GUI's My files tab and `/api/remote/list` should read from it too.
- **Availability policy** (new), keyed by **node uid** so that renames and moves keep it.
  - **Pin:** an explicit `pinned` / `unpinned` flag on any node. A node's effective pin comes from the nearest ancestor-or-self with an explicit flag.
    - Pinning a folder pins everything inside it, including future arrivals.
    - "Free up space" on a child of a pinned folder sets an explicit `unpinned` on that child.
  - **Hide:** an explicit flag on any node, inherited by everything below it.
  - **Downloaded:** whether a local copy exists. This is derived from the backing store and `synced_items`.
- **Local control channel** (my call). A Unix socket in `$XDG_RUNTIME_DIR`, user-only permissions. It carries every new state-changing operation: pin, free, hide, unhide, hydrate, remote move/rename/trash, and the state-change event stream. The extensions, GUI and CLI may use the same socket.
  - The existing unauthenticated TCP API must **not** gain endpoints that can move, trash or free files.

### 5.2 Engine changes

- **What gets downloaded.** Replace "download everything except excluded top-level folders" with: a remote file is downloaded if its effective pin is `pinned`, or if it already has a local copy (keep downloaded copies up to date, like OneDrive). Otherwise it stays online-only. New remote items inside pinned folders download. New remote items elsewhere arrive as online-only.
- **Telling "freed" apart from "deleted".** The engine must be able to tell these apart before acting on a missing local file:
  - *freed*: the policy says online-only and the record was moved out of `synced_items` first;
  - *deleted by the user*: deleted through the drive or directly in the backing store.

  Free, hide and migration must update state **before** removing local data. The existing "missing locally + DB record → trash remote" rule must only fire for genuine deletes.
- **Local content that isn't in Proton Drive is never deleted by Free up space or Hide** (my call; #9 fixed the same bug in today's Cloud only). There are two kinds:
  - *Not uploaded yet* (new files, or edits since the last sync):
    - Free up space skips these files. They stay *Downloaded* and a notification says so. Freeing again after they upload frees them.
    - Hide waits for their uploads to finish, then completes. The app shows the item as "Hiding…" meanwhile.
  - *Never uploaded* (local items that match an ignore pattern, such as `.git` or `node_modules`):
    - Free up space keeps them in place. They stay visible in the drive, inside the now online-only folder.
    - Hide is **refused** for a folder that contains any. The message names the first one ("Can't hide Projects: Projects/app/.git exists only on this computer"), so the user can move it first.
- **Renames and moves seen through the drive are explicit.** The helper reports them, and the engine performs `renameNode`/`moveNodes` remotely, then renames in the backing store and in `synced_items`. This applies to downloaded items, online-only items and folders with mixed contents.
- **Deletes through the drive** call `trashNodes` (Proton Drive trash) without downloading anything, then remove any local copy and its records.
- **Offline and paused** (my call; OneDrive and today's plain folder both behave this way):
  - Renames, moves, deletes, creates and edits made through the drive succeed locally at once. They are applied to Proton later, from a **persistent, ordered journal** of pending remote operations.
  - Listings show the result immediately.
  - The journal must survive a crash, and replaying it must never turn into an unintended trash.
  - Replay conflicts:
    - *The target name is taken remotely:* the moved item gets the existing conflict-copy name (`name (conflict <date> <device>)`), with a notification.
    - *The source was trashed remotely before replay:* if there is a local copy, upload it as a new file at the new path, so nothing is lost; if it was online-only, drop the operation and notify.
    - *A delete of an item that was changed remotely:* still trash it. The item stays recoverable from the Proton Drive trash.
  - **Pause** stops background transfers and journal replay. Opening an online-only file is an explicit user action, so it still downloads while paused.
- **Retire the old selective sync.** `excludedFolders` is migrated (§5.7) and retired. The CLI's `selective-sync exclude/include` map to hide and unhide (my call).
- **New CLI commands** to set and inspect state, e.g. `protondrive pin|free|hide|unhide|status <path>`. Naming is the builder's call.

### 5.3 The virtual drive (`protondrive-vfs`) — required behaviour

- **Listings and attributes**
  - `lookup`, `getattr` and `readdir` are answered from the index plus the backing store, with no network access.
  - Online-only files report their real size and mtime, with `st_blocks = 0` (so `du` shows 0, as with sparse or cloud files).
- **Opening an online-only file**
  - `open` asks the daemon to hydrate the file: a full download into the backing store, using the existing temp-file-then-rename path. The open completes once the file is present, and later I/O passes through.
  - Opening with `O_TRUNC` doesn't hydrate first.
  - Progress shows in the app's Active transfers. If a download takes longer than about 2 s, a desktop notification shows its progress (my call).
- **Offline or failed hydration.** The open fails with `EIO`, and a notification says the file can't be opened while offline (or gives the error).
- **Who triggers a download** (my call, following OneDrive). The decision is made at `open`:
  - Any app opening an online-only file downloads it, including Files and `cp`/`rsync` copying files out of the drive.
  - The exception is a **blocklist of background readers**, identified by the request pid's `/proc/<pid>/comm` (and its parent's): thumbnailers, localsearch/tracker miners and extractors, and similar. Their opens of online-only files fail without downloading.
  - The blocklist is a built-in default, plus user entries in Settings.
- **Requirement:** opening a folder of 500 online-only images and videos in Files (grid view, thumbnails on), letting desktop search run, and opening Properties to count sizes **downloads nothing**.
  - The builder measures on real GNOME 50 whether Files sniffs the content of files with recognisable extensions. If it does, find a way to answer that sniff without downloading the file.
- **Thumbnails** (my call, following OneDrive):
  - Downloaded files keep their thumbnails in Files, as today. So the mount must **not** look remote to GIO; with the default "this computer only" setting, a remote-looking mount would lose all thumbnails.
  - Online-only files show generic icons (cloud thumbnails are a non-goal).
  - GNOME records a refused thumbnail as failed for that file and modified time, and a download keeps the cloud's modified time. So hydration must clear the matching entry under `~/.cache/thumbnails/fail/`; otherwise the thumbnail never appears.
- **Mass downloads by one app** (my call; OneDrive does the same). If a single process other than Files downloads more than about 20 files in a minute, notify: "<app> is downloading many files from Proton Drive". The notification has a "Block this app" action that adds it to the blocklist. This covers tools nobody listed: IDE indexers, `rg`, backup scripts.
- **Writes, creates and mkdir** go to the backing store. The engine's watcher picks them up and uploads, as today.
  - Symlinks and hard links are refused (`EPERM`). Proton Drive has no equivalent, and the engine already ignores them.
- **Rename and delete** behave as described in §5.2.
- **Move to Trash in Files** must work without a "delete permanently?" prompt, and must send the item to the Proton Drive trash.
  - GIO trashes items on non-home mounts into `<mount>/.Trash-$UID`.
  - Suggested approach: present a virtual `.Trash-$UID` where a rename into `files/` means a remote trash plus local removal, and where `.trashinfo` writes are accepted and discarded.
  - Whatever leaves `files/` or `info/` that way must reach inotify watchers as a delete. Files' Trash icon counts what gvfsd-trash hears: an item moved in adds one, and only a delete takes it off (#236).
    - FUSE's own `notify_delete` doesn't tell watchers on current kernels: the kernel drops the entry without an event.
    - So the helper has each dropped name unlinked through its own mount, once the reply that dropped it is sent, and only in a folder that has the mount's device. The trash's unlink of such a name only takes it off, in memory.
    - The unlink is made by a small child process that never holds `/dev/fuse`. It can wait on the trash folder's lock for as long as the next rename into it takes, and nothing can interrupt that wait. A helper thread in it would keep a stopped helper from ever exiting, so the app and the helper would wait on each other forever. The child's wait ends when the helper dies, because the kernel then aborts the connection.
    - The child's own unlink only ever takes a dropped name, so a late one can't remove a new `.trashinfo` of the same name.
- **The mount point while unmounted** is kept read-only (`0555`), so apps can't write into it. If it holds stray files at mount time, move them into the backing store as new local files, using the existing conflict handling.
- **No stuck mounts.**
  - If the helper or daemon dies, the next start recovers (`fusermount3 -uz`, then mount again), so the user never sees "Transport endpoint is not connected" for long.
  - If the user ejects from the sidebar, the helper exits cleanly. The daemon doesn't remount until its next start, or until the user picks "Mount Proton Drive" in the tray or app (my call).
- **Disk-space reporting (`statfs`)** is the builder's call. Copies into the drive land on the local disk first, so it should not overstate local free space.
- **Speed.** Reads and writes of downloaded files should be close to native. Kernel FUSE passthrough is optional.

### 5.4 Hidden items and ignore patterns

- **Hidden items.** Hiding first frees the item's local copies, following the rules for local-only content in §5.2. Then the item disappears from the drive. The engine never downloads anything under a hidden node.
- **Remote items that match an ignore pattern** (`.git`, `node_modules`, …) are skipped today and are not downloaded. They stay out of the drive, so they behave like hidden items (my call).
- **Local items that match an ignore pattern** live only in the backing store. They show in the drive, are never uploaded, and get no emblem, as today.

### 5.5 Nautilus extension

- **Emblems**
  - Install three SVG emblems into `hicolor/scalable/emblems` (names are the builder's call, e.g. `emblem-protondrive-pinned`, `-local`, `-cloud`), drawn to match §2.3.
  - **Folder rule** (my call, following OneDrive):
    - solid when the folder itself is effectively pinned;
    - green outline when everything inside is downloaded;
    - grey cloud when anything inside is online-only.
  - Getting state for a file must not cost a network round trip per file. Suggested: the helper exposes the state as an xattr (`user.protondrive.state`) that the extension reads, or the extension uses one batched call per folder.
  - Emblems update within about 2 s of a state change while the folder is open (download finished, freed, pinned), with no manual refresh. Suggested: the extension subscribes to the daemon's state-change events and calls `invalidate_extension_info()` on the affected `FileInfo` objects, from the GLib main loop.
- **Menu** (files and folders inside the drive; multi-select)
  - "Always keep on this device": shown unless every selected item is already pinned.
  - "Free up space": shown when any selected item is pinned or has local content.
  - "Hide from this computer".
  - Keep "Proton Drive: Sync Now" and "Open Proton Drive".
  - The background menu (right-click on empty space) keeps its current items.
  - Long operations must not block Nautilus; send them to the daemon asynchronously.

### 5.6 App (GUI My files tab and Settings)

- **Rows.** Each row shows its state: Always keep, Downloaded, Online only or Hidden, plus syncing, error and conflict. Rows offer Always keep, Free up space, Hide and Unhide, for files and folders at any depth.
- **Hidden items** are listed, greyed out, with Unhide. This is where unhiding happens.
- **Toolbar.** The existing toolbar actions ("Sync All", "Cloud Only All") are replaced with equivalents for the new model. Wording is the builder's call.
- **Settings**
  - Shows whether the drive is mounted, with "Mount again" after an eject.
  - Has a switch for the virtual drive, on by default (my call; see §5.9).

### 5.7 Migration (one time, on first start of the new version)

It must be resumable after a crash at any step (keep a migration marker in settings) and must never trash cloud items.

1. Stop the local watcher.
2. Build the remote index (a full crawl).
3. Write the policy:
   - explicit `pinned` on every top-level item that is synced today;
   - former `excludedFolders` become online-only (no flag), **not** hidden.
4. Move the contents of `syncDir` into the backing store. Use `rename` on the same filesystem; otherwise copy, verify, then delete. Carry `synced_items` over unchanged, since paths stay relative.
5. Make `syncDir` an empty `0555` mount point, mount the drive, start the watcher on the backing store, and clear `excludedFolders`.

### 5.8 Packaging

- Ship `protondrive-vfs` in `release/`, `install.sh --user`, and the nfpm (.deb/.rpm) and Arch packages.
- Add a runtime dependency on `fuse3`.
- Install the emblem icons and refresh the icon cache.
- The updated Nautilus extension is picked up after `nautilus -q`.

### 5.9 Plain-folder mode (fallback and off switch)

- When the drive can't be mounted (no `/dev/fuse` or `fusermount3`, the Flatpak build, or the user switched it off), the engine runs with `syncDir` as its backing store directly. No mount, no stubs.
- Pinned and downloaded items are on disk. Online-only and hidden items are simply absent, as cloud-only folders are today, but at any depth.
- Switching modes moves content between `syncDir` and the backing store, following the §5.7 safety rules.
- The app says clearly which mode is active and why.

This gives a rollback path and keeps Flatpak working without the virtual drive.

## 6. Suggested delivery order (my call; each step ships on its own)

1. **Engine groundwork.**
   - remote index;
   - uid-keyed pin/hide policy and the "freed vs deleted" safety;
   - explicit free, pin, hide and unhide over the local socket, plus CLI;
   - migration of `excludedFolders`;
   - GUI My files with the new states and actions.

   This runs in plain-folder mode, so it is useful even before the drive exists.
2. **Virtual drive.** `protondrive-vfs`, migration into the backing store, mount, sidebar, hydrate on open, rename/move/trash through the offline journal, the background-reader blocklist, eject and recovery, packaging.
3. **Files integration.** Emblems, the right-click menu, live refresh, thumbnail-failure cleanup.
4. **Hardening.** Background-reader safeguards measured on real Nautilus, the mass-download notification and "Block this app", other notifications, plus the Trash and Settings polish.

## 7. Acceptance checks

- **Sidebar and listing.** After upgrade, Files shows "ProtonDrive" in the sidebar with the whole tree. Previously cloud-only folders are visible with grey clouds. Everything that was local shows solid green, and no bytes were downloaded or deleted by the migration.
- **Opening.** Double-clicking an online-only PDF downloads and opens it, and its emblem turns to the green outline within about 2 s.
- **Free up space** on a folder removes the local copies (`du` of the backing store drops), the emblems turn grey, and the cloud keeps everything.
- **Hide** on a folder removes it from Files and the backing store. It appears greyed in the app, and Unhide brings it back as online-only.
- **Rename and move.** Renaming or moving an online-only file or folder in Files doesn't download it, and the change appears in Proton's web app with history intact.
- **Delete.** Move to Trash in Files puts the item in the Proton Drive trash, with no prompt and no download.
- **Background readers.** Browsing a folder of 500 online-only images with thumbnails on downloads nothing, and downloaded images show thumbnails. Opening one of those images shows its thumbnail afterwards.
- **Copying out.** Dragging online-only files out of the drive in Files, or `cp -r` of an online-only folder, downloads them and copies real content.
- **Mass downloads.** Running `rg` over an online-only folder of 50 files shows the notification, and "Block this app" stops further downloads by it.
- **Offline changes.** Offline, renaming, moving and deleting online-only items in Files works at once. After reconnecting, Proton's web app shows the changes, and a crash in between loses nothing.
- **Local-only content.** Free up space on a folder containing an ignored `.git` keeps `.git`. Hide on that folder is refused with a message naming it.
- **Failures.** Killing the helper, killing the daemon, ejecting, and rebooting while offline never cause remote trashing, and the drive comes back on the next start.
- **Offline.** Opening an online-only file shows a clear error. Downloaded files still open.
- **Plain-folder mode.** Turning the drive off returns to a plain `~/ProtonDrive` containing the downloaded items.
- **Tests.** Unit tests cover the policy and state derivation, and the freed-vs-deleted logic. Integration tests drive FUSE operations against a fake daemon.

## 8. Left to the builder

- Binary and emblem names; the control socket protocol; xattr versus batched calls for emblems; the schema for the index and the policy.
- The exact blocklist, the mass-download threshold, and how to handle Files' content sniffing, all validated on GNOME 50 (§5.3).
- The journal format and replay order (§5.2), within the rules given.
- `statfs` numbers, FUSE cache timeouts and invalidation strategy, and whether to use kernel passthrough.
- GUI wording and layout for the new states and actions, within the existing design language.
- Whether Nemo gets the new menu and emblems in v1.
