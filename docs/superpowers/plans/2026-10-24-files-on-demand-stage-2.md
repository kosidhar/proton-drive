# Files On-Demand, Stage 2 (virtual drive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `~/ProtonDrive` into a FUSE virtual drive that shows the whole of My files in the Files sidebar and downloads a file when an app opens it. It also fixes issue #16, where a cloud-side rename, move or trash destroyed local-only content.

**Architecture:**
- **Backing store.** Downloaded and local-only files move into `<appDir>/files`. The sync engine now syncs that folder. In code this is `localRoot()`, which is `syncDir` in plain-folder mode.
- **The helper.** A new Rust binary, `protondrive-vfs` (`fuser` 0.18, no libfuse), mounts the drive at `syncDir`.
  - Local entries pass straight through to the backing store.
  - Online-only entries come from the daemon's remote index.
  - Opens, renames and deletes go to the daemon over the existing user-only control socket.
- **The daemon** supervises the helper, recovers stale mounts, keeps an offline journal of remote operations, and falls back to plain-folder mode whenever FUSE is unavailable or switched off.

**Tech Stack:** Bun 1.4 + TypeScript (`bun:sqlite`, `bun:test`); Rust 1.99, with `fuser = "0.18"` and `libc` in a new crate `native-vfs/`; Rust/egui 0.31 GUI; Python 3 tray.

**Spec:** `docs/superpowers/specs/2026-10-23-files-on-demand-design.md`. This plan covers delivery step 2 of §6, plus §5.9 (plain-folder mode).
- Builds on Stage 1, merged as `8f74376`.
- Stages 3 (Nautilus emblems, menu, live refresh) and 4 (mass-download notice, user blocklist UI, polish) are out of scope.
- **Deviation from §6:** clearing GNOME's failed-thumbnail entries after a download moves from Stage 3 into this stage. This stage's background-reader blocking is what creates those entries; without the clean-up, downloaded files would never get thumbnails.
- **Facts behind the decisions** (researched 2026-10-24; sources in the session notes):
  - fuser 0.18 renamed `mount2` to `mount`. `AutoUnmount` needs `allow_other`, which Ubuntu doesn't allow by default.
  - Kernel passthrough needs `CAP_SYS_ADMIN`.
  - fuser answers interrupts with ENOSYS, so a killed caller stays blocked until we reply.
  - `Request::pid()` is a thread id. The process is `Tgid` in `/proc/<tid>/status`.
  - GIO treats `fuse.*` other than `fuse.sshfs` as local, so thumbnails, item counts and recursive search all run on the mount.
  - GIO sniffs up to 16 KiB of files with uncertain names, opening them with `O_NOATIME`.
  - A mount under `$HOME` appears in the sidebar, named by `.xdg-volume-info` `Name=`.
  - Eject runs `umount`, which ends the session normally.
  - Trash on a non-home mount uses `$top/.Trash-$uid` (mode 0700) and renames into `files/`.
  - localsearch indexes `$HOME` recursively, but skips mount points and hidden paths.

## Global Constraints

- **Paths and names:**
  - backing store `<appDir>/files`, where `appDir` is `runtime.config.appDir` (`~/.local/share/proton-drive-ubuntu`);
  - helper binary `protondrive-vfs`, installed next to `protondrive`;
  - mount at `settings.syncDir`;
  - FUSE `FSName("protondrive")` and `Subtype("protondrive")`;
  - control socket as in Stage 1 (`defaultControlSocketPath()`).
- **Mount options:** `DefaultPermissions` and `NoAtime`. **No** `allow_other` and **no** `AutoUnmount`; the daemon cleans up stale mounts with `fusermount3 -u -z <mountpoint>`. Request `FUSE_PARALLEL_DIROPS` in `init`. Entry and attr TTL is **1 s**.
- **Never trash a cloud item** except for a genuine user delete: through the drive, through `.Trash-$uid`, or a local deletion of a recorded item. Records still go before files. #16: a cloud-side delete never removes local-only content. It is moved to the desktop Trash (`gio trash`) and the user is told.
- **The engine always works on `localRoot()`.** Only user-facing code (status, GUI, tray, CLI path maths, `/api/file-status`) uses `syncDir`.
- **Mode rule.** Effective mode = `virtual` when meta `virtualDriveWanted` ≠ `'0'` (default on) **and** FUSE is available (`/dev/fuse` is readable and writable, `fusermount3` is on PATH, the helper binary exists). Otherwise `plain`. Meta `driveLayout` (`'plain'` | `'virtual'`) records where the files physically are. Every start moves the files to match the effective mode, resumably.
- **While unmounted,** the mount point is mode `0555`. Stray files found in it at mount time are merged into the backing store as new local files.
- **Background readers never trigger a download.** An open of an online-only file fails with `EACCES`, without contacting the daemon, when:
  - the opener's `/proc/<tgid>/comm` starts with one of `glycin-thumbnai`, `gdk-pixbuf-thum`, `gst-video-thumb`, `gst-audio-thumb`, `papers-thumbnai`, `evince-thumbnai`, `totem-video-thu`, `ffmpegthumbnail`, `gnome-thumbnail`, `heif-thumbnail`, `gnome-epub-thum`, `localsearch-3`, `localsearch-ext`, `tracker-miner-f` or `tracker-extract`; **or**
  - the open flags contain `O_NOATIME`, which is how GIO sniffs content.

  Every other opener downloads.
- **A download triggered by an open** completes or fails within **30 minutes**; otherwise the open returns `EIO`. It notifies `Downloading <name>…` if it takes longer than 2 s, and notifies on failure. After a successful download, delete `~/.cache/thumbnails/fail/gnome-thumbnail-factory/<md5 of the file:// URI of the mount path>.png`.
- **Sidebar name** is "Proton Drive", via a virtual read-only root file `.xdg-volume-info` containing `[Volume Info]\nName=Proton Drive\n`. The helper also hides `.proton-drive-tmp-*` entries.
- **Copy:**
  - tray item `Mount Proton Drive` (shown only when ejected);
  - tray label `Open Proton Drive Folder`;
  - GUI Settings switch `Show online-only files in Files (virtual drive)`;
  - GUI button `Mount again`.
- **Checks for every task:**
  - `PATH=$HOME/.bun/bin:$PATH bun test tests` and `bunx tsc --noEmit` pass;
  - for Rust tasks, in the touched crate(s): `PATH=$HOME/.cargo/bin:$PATH cargo test --release` and `cargo clippy --release --all-targets` with **0 warnings**;
  - mount tests run with `PROTONDRIVE_VFS_MOUNT_TESTS=1`.
- **Commits:** conventional style, `Refs #<tracking issue>`, no Claude/Anthropic attribution. Work on branch `files-on-demand-stage-2`, branched from `main`.

## Review Focus

1. **A folder of 500 online-only photos browsed in Files grid view, while desktop search runs.**
   - Expected: nothing downloads; listing stays instant; the photos show generic icons.
   - Pinned in **Task 6** (classifier and `O_NOATIME`) and **Task 12** (live check).
2. **The network drops, or the app is killed, while an online-only file is opening.**
   - Expected: the open fails cleanly within the bound; no `.proton-drive-tmp-*` shows; later opens still work; the mount never hangs.
   - Pinned in **Task 5** (hydrate failure) and **Task 6** (temp files hidden, error reply).
3. **`kill -9` of the helper or daemon, then a restart.**
   - Expected: the drive comes back with no lasting "Transport endpoint is not connected", and no cloud trash happens.
   - Pinned in **Task 8**.
4. **Renaming or moving, offline, a folder that holds online-only items, then reconnecting.**
   - Expected: the cloud matches, with no duplicates and nothing lost. An editor's atomic save (write a temp file, rename it over the target) becomes a new revision of the same file.
   - Pinned in **Task 4** and **Task 7**.
5. **An app saves into `~/ProtonDrive` while the daemon is down.**
   - Expected: the file isn't hidden under the mount later; it is merged into the backing store and uploaded.
   - Pinned in **Task 8**.

---

### Task 0: Branch and tracking issue

- [ ] **Step 1:** Run `git switch -c files-on-demand-stage-2 main`, then `git push -u origin files-on-demand-stage-2`.
- [ ] **Step 2:** Create the tracking issue and note its number N:

  ```bash
  gh issue create --title "Files On-Demand stage 2: virtual drive" --body "Implements delivery step 2 of docs/superpowers/specs/2026-10-23-files-on-demand-design.md (plan: docs/superpowers/plans/2026-10-24-files-on-demand-stage-2.md), plus #16."
  ```

---

### Task 1: The engine works on `localRoot()`

**Files:**
- Create: `src/sync/driveMode.ts`
- Modify:
  - `src/sync/syncEngine.ts`: every ENGINE site listed in the Stage 2 inventory (lines ~145, 329, 392, 707/722, 1074, 1126, 1156, 1226, 1244, 1367–1369, 1460, 1512/1523, 1571/1610, 1818, 1899) and the watcher root at ~109;
  - `src/sync/availabilityMigration.ts` (:37, :41);
  - `src/sync/conflictResolver.ts` callers;
  - `src/daemon/daemonServer.ts` (construct with the backing dir).
- Test: `tests/driveMode.test.ts`, `tests/syncEngine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // driveMode.ts
  export type DriveLayout = 'plain' | 'virtual';
  export function backingDirFor(appDir: string): string;               // path.join(appDir, 'files')
  export function readDriveLayout(stateDb: SyncStateDatabase): DriveLayout; // meta 'driveLayout', default 'plain'
  export function virtualDriveWanted(stateDb: SyncStateDatabase): boolean;  // meta 'virtualDriveWanted' !== '0'
  // ProtonDriveSyncEngine
  constructor(sdk, eventsManager, auth, stateDb, logger, options?: { backingDir?: string })
  localRoot(): string;   // readDriveLayout(stateDb) === 'virtual' && backingDir ? backingDir : settings.syncDir
  ```
- `getStatus().syncDir` stays the user-facing `syncDir`. `relocateSyncFolder` moves files only when the layout is `plain`. In `virtual` it only changes the setting; Task 9 adds the unmount and remount.

- [ ] **Step 1: Failing tests:**
  - `backingDirFor('/x')` is `'/x/files'`.
  - The layout defaults to `'plain'`, and `virtualDriveWanted` defaults to true.
  - `engine works entirely in the backing dir when the layout is virtual`: set meta `driveLayout='virtual'` and `backingDir=<tmp>/files`; `syncDir` is a different temp dir. Expect:
    - a remote file under a pinned root is downloaded into `<tmp>/files/...`;
    - a new file written into `<tmp>/files` uploads;
    - `free` removes from `<tmp>/files`;
    - nothing is ever created in `syncDir`.
  - The existing suite passes unchanged in plain layout.
- [ ] **Step 2: Run** `bun test tests/driveMode.test.ts tests/syncEngine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Swap each ENGINE `settings.syncDir` for `this.localRoot()`. Leave the USER sites alone.
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `refactor(sync): run the engine on a local root that can differ from the sync folder` (`Refs #N`).

---

### Task 2: A cloud-side delete keeps local-only content (#16, part 1)

**Files:**
- Create: `src/sync/desktopTrash.ts`
- Modify: `src/sync/syncEngine.ts`: reconcile case 2 (~458–471), the NodeDeleted handler (~1222–1237), and the NodeUpdated-with-`isTrashed` handler (~1239–1255)
- Test: `tests/syncEngine.test.ts` (`describe('cloud-side deletes')`)

**Interfaces:**
- Consumes: `scanLocalCopies` and `removeScannedEntries` (mode `'keep-changed'`) from `src/sync/localCopies.ts`, plus the engine's `recordDropper` and `whileRemoving`.
- Produces:
  ```ts
  export type MoveToDesktopTrash = (fullPath: string) => Promise<boolean>; // true when moved
  export const gioTrash: MoveToDesktopTrash;  // Bun.spawn(['gio','trash','--',fullPath]); false on non-zero exit or missing gio
  // engine option: options.moveToDesktopTrash?: MoveToDesktopTrash (default gioTrash)
  private async removeAfterCloudDelete(relPath: string, reason: 'deleted' | 'trashed'): Promise<void>;
  ```
- **Behaviour:**
  1. Remove the unchanged synced copies (`keep-changed`). Records go first, as Stage 1 does.
  2. Move each top-level kept item to the desktop Trash: the topmost kept paths, not the folders above them.
  3. If moving fails, leave the item in place.
  4. Send one notification: `<relPath> was removed from Proton Drive. <n> item(s) that existed only on this computer were moved to your Trash.` (or `…were kept at <path>.` if moving failed).
  5. Log one activity entry.

  None of the three call sites uses `rm -rf` any more.

- [ ] **Step 1: Failing tests.** Use the mock drive and a fake `moveToDesktopTrash` that records its paths. Each case runs for case 2, NodeDeleted and isTrashed:
  - a folder deleted in the cloud with an ignored `app/.git` and an edited `notes.txt`: the unchanged files are removed; `.git` and `notes.txt` are passed to the fake trash; no records remain;
  - a fully synced folder: everything is removed and the trash fake is never called;
  - the trash fake returns false: the items stay on disk, and the notice says "kept".
- [ ] **Step 2: Run** the tests. Expected: FAIL (today the content is gone).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `fix(sync): keep local-only content when a folder is deleted in the cloud` (`Refs #16`, `Refs #N`).

---

### Task 3: A cloud-side rename or move follows locally (#16, part 2)

**Files:**
- Modify:
  - `src/sync/syncStateDb.ts`: add `renameItemPath`;
  - `src/sync/syncEngine.ts`: reconcile case 1 and case 2, and `reconcileDirectoryIncremental`.
- Test: `tests/syncStateDb.test.ts`, `tests/syncEngine.test.ts` (`describe('cloud-side renames')`)

**Interfaces:**
- Produces:
  ```ts
  // SyncStateDatabase
  renameItemPath(fromRel: string, toRel: string): void; // self and descendants, byte-exact range, in one transaction
  // engine
  private async followRemoteMove(nodeUid: string, fromRel: string, toRel: string): Promise<boolean>; // true when the local copy was moved
  ```
- **Rule.**
  - **Case 1** (remote present at `toRel`, nothing local, no record): when a record with the same `nodeUid` exists at another path whose local copy exists, move that copy (`rename` in `localRoot()`, then `renameItemPath`) instead of downloading.
  - **Case 2** (local present at `fromRel`, remote missing, record present): when `index.getByUid(record.nodeUid)` sits at another path, do the same move rather than delete.
  - Watcher events are suppressed for both paths.
  - If the target path is already occupied locally, fall back to Task 2's delete handling for the source, and leave the target alone.

- [ ] **Step 1: Failing tests:**
  - `renameItemPath` moves `A`, `A/x` and `A/B/y` to `Z/A…`, and leaves `AB/z` and `a/q` alone.
  - Renaming a pinned folder `Projects` (holding an ignored `.git`) to `Work` in the cloud: `.git` is now under `Work`; the uploads and downloads count is 0; the trash fake is not called.
  - Moving a downloaded but unpinned file into another folder in the cloud keeps it **downloaded** at its new path.
  - A rename whose target already exists locally: the source goes through the Task 2 handling, and the target is untouched.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `fix(sync): follow cloud-side renames and moves locally instead of deleting` with `Fixes #16` and `Refs #N`.

---

### Task 4: Remote operations journal, and rename/delete from the drive

**Files:**
- Create: `src/sync/remoteOps.ts`
- Modify: `src/sync/syncEngine.ts`, `tests/helpers/mockDrive.ts` (add `renameNode` and `moveNodes`, plus `calls.renamed` and `calls.moved`)
- Test: `tests/remoteOps.test.ts`, `tests/syncEngine.test.ts` (`describe('drive operations')`)

**Interfaces:**
- Produces:
  ```ts
  export type RemoteOp =
      | { id: number; kind: 'rename'; nodeUid: string; toPath: string; attempts: number }
      | { id: number; kind: 'move'; nodeUid: string; toPath: string; attempts: number }   // toPath gives the new parent and name
      | { id: number; kind: 'trash'; nodeUid: string; path: string; attempts: number };
  export class RemoteOpsJournal {            // table remote_ops(id PK AUTOINCREMENT, kind, nodeUid, path, toPath, createdAt, attempts, lastError)
      constructor(db: Database);
      enqueue(op: Omit<RemoteOp, 'id' | 'attempts'>): number;
      pending(): RemoteOp[];                 // in id order
      complete(id: number): void;
      failed(id: number, error: string): void;
  }
  // engine
  async renameItem(fromRel: string, toRel: string): Promise<void>;
  async deleteItem(relPath: string): Promise<void>;
  async replayRemoteOps(): Promise<void>;   // called at the start of reconcileNow (not while paused) and right after each enqueue
  ```
- **`renameItem` behaviour:**
  1. **Locally first, at once:** rename the copy under `localRoot()` if it exists (watcher suppressed), `renameItemPath`, and `index.upsert` the entry at `toRel` so listings show it straight away.
  2. **Then journal the remote change:** `rename` for the same parent, otherwise `move`, followed by `rename` if the name changed. Ops resolve parent uids at replay time from the index. An item that was never uploaded (no uid) gets no op.
  3. **Replacing an existing target** (an editor's atomic save): the target's node identity wins. The source's node, if it was ever uploaded, is journalled as `trash`. The target's record is kept, so the new content uploads as a new revision.
- **`deleteItem`:** drop records first, then `rm -r` the local copy (this is a user delete, so everything goes), then `index.removeSubtree(uid)`, then journal `trash`.
- **Replay rules (spec §5.2):**
  - Ops run in order.
  - A network error leaves the op pending and stops replay until the next pass.
  - **Name taken remotely:** rename the moved item with `formatConflictFileName` (from `conflictResolver.ts`), update local and index paths to match, and notify.
  - **Source trashed remotely:** a local copy exists, so drop its record (it uploads as a new file at the new path); otherwise drop the op and notify.
  - **Trash of an item changed remotely:** still trash it.
  - A **pause** stops replay.

- [ ] **Step 1: Failing tests:**
  - **Journal:** order, persistence across a new `RemoteOpsJournal` on the same database, `complete` and `failed`.
  - **Offline rename of a folder holding online-only items:** `renameNode` throws a network error. The local and index state already show the new name, and a restart keeps the op. Once the network is back, `replayRemoteOps` renames once. `calls.renamed` has exactly one entry and there are no uploads.
  - **Move** into another folder uses `moveNodes` with the right parent uid.
  - **Atomic save:** write `.report.txt.tmp` (not ignored, uploaded), then rename it over `report.txt`. Result: one new revision of `report.txt`'s node, the temp node is trashed, and there is no duplicate file remotely.
  - **Conflict on replay:** the target name was created remotely while offline. Result: a conflict-named copy, matching locally and remotely.
  - `deleteItem` of an online-only file trashes it remotely and downloads nothing.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `feat(sync): rename, move and delete through a persistent journal of remote operations` (`Refs #N`).

---

### Task 5: Daemon side of the drive (control routes and hydrate)

**Files:**
- Modify: `src/daemon/controlServer.ts`, `src/sync/syncEngine.ts`
- Create: `src/sync/thumbnailCache.ts`
- Test: `tests/controlServer.test.ts`, `tests/syncEngine.test.ts` (`describe('hydrate')`), `tests/thumbnailCache.test.ts`

**Interfaces:**
- Consumes: Task 4's `renameItem` and `deleteItem`.
- Produces:
  ```ts
  export interface VfsEntry { name: string; type: 'file' | 'folder'; size: number; mtimeMs: number }
  // engine
  vfsChildren(relPath: string): VfsEntry[];      // index children of relPath minus hidden, minus ignore-pattern matches, minus Proton Docs/Sheets (not indexed); [] for an unindexed folder
  async hydrate(relPath: string): Promise<void>; // downloads into localRoot() via downloadRemoteToLocal + recordSynced; resolves at once if a local copy exists; rejects `Hidden: <relPath>` / `Not in Proton Drive: <relPath>` / the download error; concurrent calls for one path share one download
  // thumbnailCache.ts
  export function failedThumbnailPath(mountFullPath: string, home?: string): string; // md5 of the escaped file:// URI
  export function forgetFailedThumbnail(mountFullPath: string): Promise<void>;
  ```
- **Control routes** (same socket, same 400 `{ error, code }` style; `code` is one of `ENOENT`, `EEXIST`, `EACCES`, `EIO`):
  - `GET /vfs/children?path=` returns `{ entries: VfsEntry[] }`.
  - `POST /vfs/hydrate {path}` returns `{ ok: true }`. Its timeout is 30 min.
  - `POST /vfs/rename {from, to, noReplace?: boolean}` returns `{ ok: true }`. It returns `EEXIST` when `noReplace` is set and the target exists.
  - `POST /vfs/delete {path}` returns `{ ok: true }`.
  - The `ControlServerOptions` engine `Pick` gains `vfsChildren`, `hydrate`, `renameItem` and `deleteItem`.
- **`hydrate` also:**
  - sends the 2 s `Downloading <name>…` notice, and a failure notice;
  - calls `forgetFailedThumbnail(path.join(settings.syncDir, relPath))` on success.
- Paths in query strings and bodies are UTF-8, as-is (URL-encoded in the query).

- [ ] **Step 1: Failing tests:**
  - **`vfsChildren`:** omits hidden items and a remote `.git`, and includes online-only and downloaded items with their size and mtime.
  - **`hydrate`:**
    - downloads once for two concurrent calls;
    - after it, `stateOf` is `downloaded`;
    - a hidden path rejects;
    - a failing download rejects and leaves no `.proton-drive-tmp-*` file.
  - **Routes:** each route round-trips through a fake engine; a name with a space and `é` survives.
  - **`failedThumbnailPath`:** for `/home/u/ProtonDrive/a b.jpg` it equals `/home/u/.cache/thumbnails/fail/gnome-thumbnail-factory/<md5 of "file:///home/u/ProtonDrive/a%20b.jpg">.png`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `feat(daemon): serve drive listings, hydrate, rename and delete over the control socket` (`Refs #N`).

---

### Task 6: `protondrive-vfs`, read side

**Files:**
- Create in `native-vfs/`:
  - `Cargo.toml`: package `protondrive-vfs`, edition 2021; deps `fuser = "0.18"`, `libc = "0.2"`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`;
  - `src/main.rs`: argument parsing and mount;
  - `src/daemon.rs`: HTTP/1.1 over `UnixStream`, like the GUI's `control_request`;
  - `src/inodes.rs`;
  - `src/listing.rs`;
  - `src/readers.rs`;
  - `src/fs.rs`;
  - `tests/mount.rs`.

**Interfaces:**
- Consumes: Task 5's routes.
- Produces:
  ```rust
  // CLI: protondrive-vfs --mountpoint <dir> --backing <dir> --socket <path>
  // exit 0 = the session ended because the drive was unmounted (eject); 2 = mount failed; 1 = other error
  pub struct Entry { pub name: String, pub kind: Kind, pub size: u64, pub mtime: SystemTime, pub local: bool }
  pub enum Kind { File, Folder }
  pub fn merge_listing(local: Vec<Entry>, remote: Vec<Entry>) -> Vec<Entry>;  // local wins by exact name; drops ".proton-drive-tmp-*"; adds ".xdg-volume-info" at root only (caller passes is_root)
  pub enum Reader { Background, Sniff, App }
  pub fn classify_open(comm: &str, flags: i32) -> Reader;  // O_NOATIME -> Sniff; blocklisted comm prefix -> Background; else App
  pub fn process_comm(tid: u32) -> Option<String>;          // Tgid from /proc/<tid>/status, then /proc/<tgid>/comm
  ```
- **The filesystem:**
  - Inodes map `relPath ↔ u64`, with the root as 1.
  - `lookup`, `getattr` and `readdir` use the merged listing: backing `read_dir` plus `GET /vfs/children`, cached per folder for 1 s.
  - Online-only files report their real size, mtime and `blocks = 0`.
  - `open`:
    - for a local file, open the backing file;
    - for an online-only file:
      - `Background` or `Sniff` replies `EACCES` without contacting the daemon;
      - `App` moves the `ReplyOpen` to a worker thread, calls `/vfs/hydrate` (30 min limit), then opens the backing file. `EIO` on failure.
  - `read` uses `pread` on the handle.
  - `statfs` reports the backing filesystem's `statvfs`.
  - If the control socket is unreachable, remote listings are empty (logged once per minute) and hydrate fails with `EIO`. Local entries keep working.
  - `/vfs/children` JSON maps to `Entry`: `type` `"file"`/`"folder"` maps to `Kind`; `mtimeMs` maps to `SystemTime`; `local = false`.
  - `.xdg-volume-info` is read-only, with the exact content from Global Constraints.
  - `init` requests `FUSE_PARALLEL_DIROPS`.
  - Mount options as in Global Constraints. `n_threads = Some(4)`.

- [ ] **Step 1: Failing unit tests:**
  - **`merge_listing`:** local wins; temp files are dropped; `.xdg-volume-info` appears only at the root.
  - **`classify_open`:**
    - `("glycin-thumbnai", O_RDONLY)` gives `Background`;
    - `("localsearch-3", O_RDONLY)` gives `Background`;
    - `("gedit", O_RDONLY | O_NOATIME)` gives `Sniff`;
    - `("nautilus", O_RDONLY)` gives `App`.
  - **`process_comm(std::process::id())`** equals the test binary's comm.
- [ ] **Step 2: Failing mount tests** (`tests/mount.rs`; all skip unless `PROTONDRIVE_VFS_MOUNT_TESTS=1`). Each test:
  - starts a fake control server on a temp socket, serving `/vfs/children` from a map, and `/vfs/hydrate` by copying a fixture into the backing dir after 200 ms;
  - spawns the built binary on a temp mount point;
  - waits for the mount to appear in `/proc/self/mounts`;
  - unmounts with `fusermount3 -u` at the end.

  Cases:
  - `ls` shows local and online-only entries, with no temp files.
  - `stat` of an online-only file shows its remote size.
  - `cat` of an online-only file returns the fixture content, and the hydrate route was called exactly once.
  - A read-only open with `O_NOATIME` (via `libc::open`) fails with `EACCES`, and the hydrate route was **not** called.
  - Unmounting makes the binary exit with code 0.
- [ ] **Step 3: Run** `cd native-vfs && PATH=$HOME/.cargo/bin:$PATH cargo test --release` (unit tests), then the same with `PROTONDRIVE_VFS_MOUNT_TESTS=1`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** both commands, plus clippy. Expected: pass, 0 warnings.
- [ ] **Step 6: Commit** `feat(vfs): add protondrive-vfs, a FUSE view of the drive with download on open` (`Refs #N`).

---

### Task 7: `protondrive-vfs`, write side, rename, delete and trash

**Files:**
- Modify: `native-vfs/src/fs.rs`, `native-vfs/tests/mount.rs`
- Create: `native-vfs/src/trash.rs`

**Interfaces:**
- Consumes: Task 5's routes, Task 6's types.
- Produces:
  ```rust
  pub struct TrashArea { /* in-memory .Trash-<uid> with files/ and info/ */ }
  impl TrashArea {
      pub fn new(uid: u32) -> Self;
      pub fn is_trash_path(&self, rel: &str) -> bool;
      pub fn trashed_source(&self, rename_to: &str) -> bool;  // true when rename_to is under .Trash-<uid>/files/
  }
  ```
- **Writes:**
  - `create`, `write`, `flush`, `fsync`, `mkdir` and `setattr` (size, mode, times) pass through to the backing store.
  - Truncating or opening an online-only file with `O_TRUNC` creates an empty local file, without hydrating.
  - Writing into an online-only file without `O_TRUNC` hydrates first (the Task 6 path).
- **Unlink and rmdir** call `/vfs/delete`.
- **Rename:**
  - flags `0` and `RENAME_NOREPLACE` call `/vfs/rename`; `RENAME_EXCHANGE` gives `EINVAL`;
  - a rename into `.Trash-<uid>/files/` calls `/vfs/delete` for the source and succeeds.
- **`symlink`, `link` and `mknod`** give `EPERM`.
- **`.Trash-<uid>`:**
  - It is a mode-0700 folder owned by the user, holding `files/` and `info/`.
  - It accepts GIO's sequence in `info/`: create `O_EXCL`, write, a temp file renamed over `<name>.trashinfo`.
  - It keeps those `info/` entries only in memory and drops them once the matching `files/` rename happens.
  - `files/` always lists empty.

- [ ] **Step 1: Failing mount tests:**
  - **Write a new file:** `echo hi > new.txt` creates `backing/new.txt` with that content.
  - **Truncate:** `truncate -s 0` on an online-only file doesn't call hydrate.
  - **Rename:** `mv a.txt b.txt` calls `/vfs/rename {from:"a.txt", to:"b.txt"}`. `mv -n` onto an existing name fails.
  - **Delete:** `rm online.txt` calls `/vfs/delete`, and no hydrate.
  - **Trash:** `gio trash online.txt` succeeds and calls `/vfs/delete` exactly once. `info/` is empty afterwards, and `gio trash --list` shows nothing from this mount.
  - **Links:** `ln -s x y` fails with `EPERM`.
- [ ] **Step 2: Run** with `PROTONDRIVE_VFS_MOUNT_TESTS=1`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit and mount tests, plus clippy. Expected: pass.
- [ ] **Step 5: Commit** `feat(vfs): writes, renames, deletes and Move to Trash through the drive` (`Refs #N`).

---

### Task 8: Daemon supervises the helper

**Files:**
- Create: `src/daemon/vfsSupervisor.ts`
- Modify:
  - `src/daemon/daemonServer.ts`: start/stop, `vfs` in `/api/status`;
  - `src/daemon/controlServer.ts`: `POST /vfs/mount`.
- Test: `tests/vfsSupervisor.test.ts`, using a fake helper script that mimics exit codes and mount presence. It must not mount anything real.

**Interfaces:**
- Produces:
  ```ts
  export interface VfsStatus { mode: 'virtual' | 'plain'; mounted: boolean; reason: 'ejected' | 'crashed' | 'fuse-unavailable' | 'switched-off' | 'starting' | null }
  export function fuseAvailable(helperPath: string | null): boolean;   // /dev/fuse rw, fusermount3 on PATH, helper executable
  export function findHelper(): string | null;                         // $PROTON_DRIVE_VFS_BIN, else <dir of process.execPath>/protondrive-vfs, else PATH
  export class VfsSupervisor {
      constructor(opts: { mountpoint: string; backingDir: string; socketPath: string; helperPath: string; logger: Logger; mergeStray(fullPath: string): Promise<void>; spawn?: typeof Bun.spawn; run?: (cmd: string[]) => Promise<number> });
      start(): Promise<void>;     // prepare, then spawn
      mountAgain(): Promise<void>;
      stop(): Promise<void>;      // fusermount3 -u -z, then wait for exit
      status(): VfsStatus;
  }
  ```
- **Prepare:**
  1. If `stat(mountpoint)` fails with `ENOTCONN`, run `fusermount3 -u -z mountpoint`.
  2. If the mount point holds files, `mergeStray` each one into the backing store: a new local file, or a conflict-named copy if the name exists there.
  3. `chmod 0555`.
- **Spawn** the helper with the Task 6 CLI; stderr goes to the daemon log.
- **Exit handling:**
  - Exit code 0 means the drive was ejected: status `ejected`. Restore `0555` and don't restart until `mountAgain` or the next daemon start.
  - Any other exit or a signal means a crash: run `fusermount3 -u -z`, then restart after 1 s, 5 s and 30 s. After three crashes within 5 minutes, status `crashed` and stop retrying.
- **Wiring:** in `virtual` layout, `daemonServer` starts the supervisor after the engine and control server. `stop()` runs on daemon shutdown.
- **`mergeStray(fullPath)`** is provided by `daemonServer`. It renames the stray entry into the same relative path under `backingDir`. If that path exists, it uses `formatConflictFileName` from `conflictResolver.ts`. The engine's watcher then uploads it as a new local item.

- [ ] **Step 1: Failing tests** (fake `spawn` and `run`):
  - A stale `ENOTCONN` mount point runs `fusermount3 -u -z` before spawning.
  - Stray files are merged before the mount, and the mount point ends at mode `0555`.
  - Exit 0 gives `ejected` and no respawn; `mountAgain` respawns.
  - Three quick crashes give `crashed` after three restarts.
  - `fuseAvailable` is false when the helper is missing.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `feat(daemon): mount the drive, recover stale mounts and restart a crashed helper` (`Refs #N`).

---

### Task 9: Moving files between plain and virtual layouts

**Files:**
- Create: `src/sync/layoutMigration.ts`
- Modify:
  - `src/daemon/daemonServer.ts`: before `engine.start()`, migrate to the effective mode;
  - `src/sync/syncEngine.ts`: `relocateSyncFolder` in virtual layout;
  - `src/daemon/daemonServer.ts` `/api/settings`: a `virtualDriveWanted` boolean switch, which stops the supervisor, migrates and restarts.
- Test: `tests/layoutMigration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function moveToLayout(opts: { stateDb: SyncStateDatabase; syncDir: string; backingDir: string; target: DriveLayout; logger: Logger }): Promise<'moved' | 'already'>;
  ```
- **Move order:**
  1. Write meta `layoutMoving=<target>`.
  2. For each top-level entry of the source, `rename` it into the destination. On `EXDEV`, copy recursively, compare size and mtime per file, then remove the source.
  3. Write `driveLayout=<target>`.
  4. Delete `layoutMoving`.
- **Re-running** with `layoutMoving` set finishes the move: an entry already at the destination is skipped.
- **Moving to `virtual`** finishes with `chmod 0555` on `syncDir` once it is empty. **Moving to `plain`** first restores `0755`.
- Records are never touched; paths are relative.
- The engine's watcher is stopped during the move.
- **`relocateSyncFolder` in virtual layout** moves no files. It stops the supervisor (unmount), restores `0755` on the old mount point, saves the new `syncDir`, then starts the supervisor at the new path.

- [ ] **Step 1: Failing tests:**
  - Moving plain to virtual puts every file under `backing` and leaves `syncDir` empty at `0555`. `driveLayout` is `virtual` and the records are unchanged.
  - Simulate a crash after the first entry (inject a throw), then re-run: the result is complete, with no duplicates.
  - Moving virtual to plain restores everything, with `syncDir` at `0755`.
  - The effective mode `plain` while the layout is `virtual`: an absent helper moves the files back at start.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: pass.
- [ ] **Step 5: Commit** `feat(sync): move files into the drive's hidden store and back, resumably` (`Refs #N`).

---

### Task 10: App and tray

**Files:**
- Modify: `native-gui/src/main.rs`, `linux/tray/proton_drive_tray.py`

**Interfaces:**
- Consumes: `/api/status` `vfs` (Task 8), `POST /vfs/mount` (Task 8, control socket), `/api/settings` `virtualDriveWanted` (Task 9).
- Produces:
  ```rust
  #[derive(Deserialize, Default)] struct VfsStatus { mode: String, mounted: bool, reason: Option<String> }  // DaemonStatus.vfs: Option<VfsStatus> with serde(default)
  fn drive_status_line(v: &VfsStatus) -> String;
  ```
- **`drive_status_line` text:**
  - `Virtual drive: mounted at <syncDir>`;
  - `Virtual drive: ejected`;
  - `Plain folder: FUSE isn't available on this system`;
  - `Plain folder: virtual drive switched off`;
  - `Virtual drive: stopped after repeated crashes`.
- **Settings tab:** the line above, a `Mount again` button when ejected or crashed (socket `POST /vfs/mount`), and the switch from Global Constraints. Switching it off asks first: `Your downloaded files move back into a normal folder; online-only files stop showing in Files.`
- **My files:** in virtual mode, clicking an online-only file opens `<syncDir>/<rel>` (the drive downloads it). Plain mode is unchanged.
- **Tray:** `Mount Proton Drive` is shown only when `vfs.mounted` is false in virtual mode. It sends `POST /vfs/mount` over the control socket: a raw HTTP/1.1 request on `socket.AF_UNIX`, with the same path rule as `defaultControlSocketPath()` (`$XDG_RUNTIME_DIR/protondrive/control.sock`, else `<tmpdir>/protondrive-<uid>/control.sock`). The label becomes `Open Proton Drive Folder`.

- [ ] **Step 1: Failing unit tests:** `drive_status_line` returns the exact text for each case.
- [ ] **Step 2: Run** `cargo test --release`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add a `--drive-status <mounted|ejected|plain>` screenshot flag that fakes the status.
- [ ] **Step 4: Verify:**
  - tests and clippy are clean;
  - screenshots of the Settings tab at 840x540 and 1440x900 for each status, viewed;
  - the tray's Python checked with `python3 -m py_compile linux/tray/proton_drive_tray.py`.
- [ ] **Step 5: Commit** `feat(gui): show the drive's state, mount it again, and switch the virtual drive` (`Refs #N`).

---

### Task 11: Packaging and docs

**Files:**
- Modify:
  - `packaging/linux/package.sh`: build `native-vfs`, install it to `release/protondrive-vfs`, stage it into `bin/`;
  - `packaging/linux/install.sh`: install the helper and uninstall it, from both layouts;
  - `packaging/linux/nfpm.yaml`: add contents, `fuse3` to deb and rpm depends;
  - `packaging/linux/arch/PKGBUILD`: `fuse3`;
  - `README.md`: a virtual drive section covering the sidebar, online-only files, eject and Mount again, the hidden store location, plain-folder fallback (Flatpak or no FUSE), and runtime dependency `fuse3`.
- The Flatpak bundle stays without the helper, so it runs in plain mode. Add a comment in `flatpak/ch.proton.drive.bundle.yml` saying so.

- [ ] **Step 1:** `bash packaging/linux/package.sh --formats tar` builds a tarball containing `bin/protondrive-vfs`. Check with `tar tzf`.
- [ ] **Step 2:** In a temp `PREFIX`, run `./packaging/linux/install.sh --user` against a fake `HOME` (`HOME=<tmp> ./packaging/linux/install.sh --user`). It installs `bin/protondrive-vfs`, and `--uninstall` removes it.
- [ ] **Step 3:** `nfpm` deb metadata lists `fuse3`: `dpkg-deb -I` on the built deb.
- [ ] **Step 4: Commit** `build: package protondrive-vfs and depend on fuse3` (`Refs #N`).

---

### Task 12: Deploy and acceptance on the real install

**Files:** none. Verification only, plus a closing commit if a fix is needed.

- [ ] **Step 1: Back up and record.**
  - Back up the state DB into the scratchpad with `VACUUM INTO`, which needs no sqlite3 (it isn't installed): `~/.bun/bin/bun -e 'new (require("bun:sqlite").Database)(process.argv[1], { readwrite: true, create: false }).run("VACUUM INTO ?", [process.argv[2]])' ~/.local/share/proton-drive-ubuntu/ubuntu-sync-state.sqlite <scratchpad>/state-before-stage-2.sqlite` (the target must not exist yet).
  - Record the status, `du -sb ~/ProtonDrive`, the file count, and the last activity id.
- [ ] **Step 2: Build and install** the daemon, GUI and helper. Restart the daemon only while idle (quit via the API, then `setsid -f`).
- [ ] **Step 3: Check the layout move:**
  - `~/.local/share/proton-drive-ubuntu/files` holds the files, with the same `du` and count;
  - `~/ProtonDrive` is a `fuse.protondrive` mount (`findmnt ~/ProtonDrive`), showing both downloaded and online-only folders;
  - `gio info -a filesystem::remote ~/ProtonDrive` shows `FALSE`, as expected;
  - the sidebar shows "Proton Drive" (`gio mount -l` lists it);
  - no new delete, trash or download activity.
- [ ] **Step 4: Acceptance on a throwaway `fod2-test`:**
  - **Create:** write `a.txt` through the mount; it uploads.
  - **Free:** `protondrive free fod2-test`, after which `ls` still shows `a.txt` (online-only).
  - **Open:** `cat a.txt` downloads it and prints the content.
  - **Rename and move:** `mv` to `b.txt` renames it in the cloud, then `mv` into a subfolder moves it, with no re-upload (activity shows a rename, not a trash plus upload).
  - **Trash:** `gio trash b.txt` sends it to the Proton Drive trash, with no prompt.
  - **Sniff:** `python3 -c "import os; os.open('<path>', os.O_RDONLY|os.O_NOATIME)"` on an online-only file gets `EACCES` and no download.
  - **Eject:** `umount ~/ProtonDrive` (the same command Files' eject runs) gives the ejected status. `Mount again` remounts.
  - **Crash:** `kill -9` the helper. It comes back within seconds, with no ENOTCONN left over.
  - **Clean up** with `rm -r ~/ProtonDrive/fod2-test`, which goes to the Proton trash.
- [ ] **Step 5: Live background-reader check.** Open a folder with online-only images in Files (ask the user to browse it, or use `gio list` plus `gio info -a standard::content-type` on it). The activity log shows no downloads.
- [ ] **Step 6:** Screenshots of the GUI Settings and My files from the installed build. Commit any fix with `Fixes #N` (or close the issue at merge), and push.
- **Rollback** (back to the `main` binaries). `main` knows nothing of the backing store. A `main` daemon started while the files are in it syncs the empty `~/ProtonDrive` and trashes every cloud copy, so **never start a `main` daemon while meta `driveLayout` is `'virtual'`**. Meta is the `settings` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) of `~/.local/share/proton-drive-ubuntu/ubuntu-sync-state.sqlite` (`$XDG_DATA_HOME/proton-drive-ubuntu/` when that is set).

  The `sqlite3` command isn't installed by default, so the database steps go through `pdb`, a stand-in on Bun's built-in SQLite. It runs one SQL text against `$DB`, printing rows as `sqlite3` does (`a|b`). It needs no install: `~/.bun/bin/bun` runs it, or, with no Bun installed, the Stage 2 `protondrive` binary does (with `BUN_BE_BUN=1` it acts as Bun). With `sqlite3` installed, `sqlite3 "$DB" "<the same SQL>"` does the same.

  Set these first:
  ```sh
  APP=~/.local/share/proton-drive-ubuntu; DB=$APP/ubuntu-sync-state.sqlite; STORE=$APP/files
  BUN=~/.bun/bin/bun    # or, with no Bun installed: BUN=~/.local/bin/protondrive; export BUN_BE_BUN=1
  pdb() { "$BUN" -e 'const { Database } = require("bun:sqlite"); const [, file, sql] = process.argv; const db = new Database(file, { readwrite: true, create: false }); db.run("PRAGMA busy_timeout = 5000"); if (/^\s*select/i.test(sql)) { for (const row of db.query(sql).values()) console.log(row.join("|")); } else { db.run(sql); }' "$DB" "$1"; }
  ```
  1. **Preferred: let the Stage 2 daemon move the files back.**
     - In Settings, switch off **Show online-only files in Files (virtual drive)**, and wait until the move is done.
     - Confirm that `curl -s http://127.0.0.1:49152/api/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["vfs"])'` shows `'mode': 'plain'`, with no `'move'`.
     - Confirm that `pdb "SELECT key, value FROM settings WHERE key IN ('driveLayout', 'layoutMoving', 'syncDirMoving', 'localMoveInProgress');"` prints only `driveLayout|plain`.
     - Then go to step 3.
  2. **Only if the Stage 2 daemon won't start: move the files back by hand.**
     - Check that no Proton Drive process runs: `pgrep -a protondrive` must print nothing (no daemon, app or helper). If it prints anything, choose **Quit Proton Drive** in the tray menu, or close the app (`pkill -x protondrive-gui`, so that it can't start the daemon again) and then run `curl -s -X POST http://127.0.0.1:49152/api/quit`; check again. A daemon still running would read the moves below as deletes.
     - Back up the database, and look at its markers:
       ```sh
       pdb "VACUUM INTO '$APP/ubuntu-sync-state.pre-rollback.sqlite'"
       pdb "SELECT key, value FROM settings WHERE key IN ('syncDir', 'driveLayout', 'layoutMoving', 'syncDirMoving', 'localMoveInProgress');"
       ```
     - `VACUUM INTO` refuses a file that already exists: pick another name for a second backup. With `sqlite3`: `sqlite3 "$DB" ".backup '$APP/ubuntu-sync-state.pre-rollback.sqlite'"`.
     - `syncDir` names the Proton Drive folder. The commands below assume it is `~/ProtonDrive`; use yours if it isn't.
     - If `syncDirMoving` is listed, stop here. A move of the plain folder was cut short, and only the Stage 2 daemon can finish it.
     - Unmount the drive, and make the folder writable again (it is `0555` while unmounted). `findmnt` must print nothing:
       ```sh
       fusermount3 -u -z ~/ProtonDrive 2>/dev/null; findmnt ~/ProtonDrive
       chmod 755 ~/ProtonDrive
       ```
     - Move everything out of the store, dot-entries included, never replacing anything:
       ```sh
       find "$STORE" -mindepth 1 -maxdepth 1 -exec mv -n -t ~/ProtonDrive {} +
       find "$STORE" -mindepth 1
       ```
     - The last `find` must print nothing. If it prints a folder, a move was cut short inside it, so it exists in both places. Merge it file by file, again never replacing anything:
       ```sh
       (cd "$STORE" && find . -mindepth 1 -type d -printf '%P\0' | xargs -0r -I{} mkdir -p -- ~/ProtonDrive/{})
       (cd "$STORE" && find . -mindepth 1 ! -type d -printf '%P\0' | xargs -0r -I{} mv -n -- {} ~/ProtonDrive/{})
       find "$STORE" -mindepth 1 -type d -empty -delete
       find "$STORE" -mindepth 1
       ```
     - Whatever the last `find` still prints has a name already taken in `~/ProtonDrive`. Compare the two copies and keep the right one by hand. The store must end up empty.
     - Record the plain layout. `virtualDriveWanted='0'` stops the Stage 2 daemon in step 3 from moving the files back into the store:
       ```sh
       pdb "BEGIN; INSERT OR REPLACE INTO settings (key, value) VALUES ('driveLayout', 'plain'), ('virtualDriveWanted', '0'); DELETE FROM settings WHERE key = 'layoutMoving'; COMMIT;"
       pdb "SELECT key, value FROM settings WHERE key IN ('driveLayout', 'layoutMoving', 'syncDirMoving', 'localMoveInProgress', 'virtualDriveWanted');"
       ```
     - The check must print only `driveLayout|plain` and `virtualDriveWanted|0`.
  3. **Before installing the `main` binaries:** run the Stage 2 daemon, online, signed in, and in the plain layout, until it has finished all its work:
     - every change made through the drive has reached Proton Drive (`remote_ops`);
     - every file edited through the drive is recorded (`drive_edit_baselines`);
     - a local move cut short is finished (`localMoveInProgress`).

     `main` reads none of these. Pending renames and moves would be lost: the moved items would upload again as new ones, and the cloud copies at their old paths would be trashed (#16). Files edited through the drive would meet `main`'s conflict handling. With the daemon idle, both checks must pass:
     ```sh
     pdb "SELECT (SELECT COUNT(*) FROM remote_ops), (SELECT COUNT(*) FROM drive_edit_baselines);"
     pdb "SELECT key, value FROM settings WHERE key IN ('driveLayout', 'layoutMoving', 'syncDirMoving', 'localMoveInProgress');"
     ```
     - The first must print `0|0`. The second must print only `driveLayout|plain`.
     - If the Stage 2 daemon can't run at all, don't install `main`: keep the Stage 2 binaries installed and investigate.
     - Otherwise, with the daemon idle, quit Proton Drive (the tray's **Quit Proton Drive**, or close the app and then run `curl -s -X POST http://127.0.0.1:49152/api/quit`). Check that `pgrep -a protondrive` prints nothing, back up the database again (`pdb "VACUUM INTO '$APP/ubuntu-sync-state.pre-main.sqlite'"`), and install the `main` binaries.
