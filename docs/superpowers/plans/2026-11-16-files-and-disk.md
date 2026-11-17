# Files and disk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A file being replaced through the virtual drive uploads on its last close, never mid-write.
- A file the disk guard cut short is held until the user decides.
- A full disk is said plainly.
- An open that would fill the disk is refused.
- The mount tests survive a nearly full disk.

**Architecture:** the FUSE helper (native-vfs) tracks write sessions per file and posts `/vfs/writing`, `/vfs/closed` and
`/vfs/refused` to the daemon. A single background sender does the posting, and a refused close is never dropped. The
daemon:
- keeps in-memory writing marks that its settle rule consults;
- holds cut-short files in a new `cut_short_files` table, which every upload path checks;
- reports `diskFull` and a cut-short count in status, which the app and tray show;
- checks the disk before downloading a file for an open.

**Tech Stack:** Rust (fuser 0.18, libc, serde_json) for native-vfs; Bun/TypeScript (bun:sqlite, node:fs) for the
daemon; Rust egui 0.31 for the app; Python 3 for the tray.

**Spec:** `docs/superpowers/specs/2026-11-16-files-and-disk-design.md`. A code map with file:line references for
everything below is at `<scratchpad>/files-and-disk-map.md`; the controller gives the path. Line numbers there are as
of main 3f39a7d.

## Global Constraints

- **Order:** one issue, one branch, one PR each, in this order:

  | Issue | Branch | Tasks |
  |---|---|---|
  | #302 | `fix/302-mount-test-underflow` | Task 1 |
  | #64 | `feat/64-upload-on-close` | Tasks 2–3 |
  | #300 | `feat/300-cut-short-files` | Tasks 4–5 |
  | #299 | `feat/299-disk-full-notice` | Tasks 6–7 |
  | #301 | `feat/301-open-room-check` | Task 8 |

  Each branch is cut from main after the previous PR merges.
- **Checks:**
  - **Daemon:** `bun test tests` and `bunx tsc --noEmit`, run as a normal user.
  - **Rust**, in each touched crate (`native-vfs/`, `native-gui/`): `cargo test --release` and
    `cargo clippy --release --all-targets`, with no warnings.
  - **Helper on a real mount**, when touched: `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --release --test mount` in
    `native-vfs/`.
  - **Tray and extension:** `python3 linux/tray/test_proton_drive_tray.py` and
    `python3 linux/nautilus/test_proton_drive_nautilus.py`.
- **Values (verbatim from the spec):**

  | What | Value |
  |---|---|
  | Disk reserve | 5 GB = `5_000_000_000` bytes (`LOCAL_RESERVE` in `native-vfs/src/fs.rs`; mirrored in TS as `LOCAL_RESERVE_BYTES`) |
  | Keepalive for a replacing session | every 30 s |
  | Expiry of a replacing mark | 90 s |
  | `diskFull` window | 10 minutes after the last refusal |
  | Early clear of `diskFull` | at least 2 minutes after the last refusal, and the store's disk has `LOCAL_RESERVE_BYTES + max(1_000_000_000, the largest needed since the window opened)` available (changed after #299's final review; see the spec) |
  | Summary row | above 3 held files |
  | Activity | one line per burst; another only after 60 s |
  | Settle constants | unchanged: `SETTLE_QUIET_MS` 2000, `SETTLE_MAX_WAIT_MS` 120 000 |

- **Exact copy:**

  | Where | Text |
  |---|---|
  | Row, existing item | "**{name}** wasn't fully written: your computer's disk was nearly full." + "Proton Drive still has the version from before." |
  | Row, new file | "**{name}** wasn't fully written: your computer's disk was nearly full." + "It hasn't been uploaded." |
  | Summary row | "**{n} files** weren't fully written: your computer's disk was nearly full." |
  | Buttons | **Upload this version**, **Put back the Proton Drive version**, **Upload it anyway**, **Upload all anyway**, **Put back all**, **Show them** |
  | Activity line | "Not uploaded: {relPath} wasn't fully written (disk nearly full)" |
  | Home notice | "Your computer's disk is almost full. Proton Drive keeps 5 GB free on it, so new files can't be saved to the drive." + **Free up space…** |
  | Tray status line | "Disk almost full" |
  | Put back copy name | the stem, then ` (not fully written <YYYY-MM-DD HH-MM-SS> <host>)`, then the extension (the conflict naming with "not fully written" in place of "conflict") |

- **Data safety (CLAUDE.md):**
  - Nothing trashes or replaces a cloud item the user didn't change.
  - Records before files: the `cut_short_files` row is written before the daemon answers `/vfs/closed`.
  - Put back keeps both copies.
  - A local file Put back moves away is never read as a delete.
- **Git:** conventional commits; the last commit of each PR says `Fixes #N`; no AI attribution anywhere.
- **Subagent safety:**
  - Never touch `~/ProtonDrive`, `~/.local/share/proton-drive-ubuntu`, `~/.config/protondrive`, `~/.local/bin`,
    `$XDG_RUNTIME_DIR/protondrive` or port 49152.
  - Never start or stop the user's daemon, app, tray, Files or helper.
  - Never run `install.sh`, `bun run build` or `nautilus -q`.
  - Never contact Proton servers.

## Review Focus

1. **A file deleted, or replaced by a rename, while open for writing:** its close has no path (`path_of(ino)` is None).
   No post, no panic, nothing held. Task 2 Step 1, `a_file_deleted_while_open_sends_no_close`.
2. **Two apps writing one file:** "closed" only after the last handle. Task 2 Step 1,
   `closed_is_posted_after_the_last_writing_handle`.
3. **A `cp -r` cut short leaves hundreds of refused closes:** none dropped, even with a full queue of best-effort
   posts. Task 2 Step 1, `refused_closes_are_never_dropped_and_retry_in_order`. On Home, one summary row: Task 5
   Step 1, `more_than_three_cut_short_files_are_one_row`.
4. **Put back:** never trashes or uploads anything, never reads the moved-away file as a delete, and the path shows the
   cloud version online-only. Task 4 Step 1, `put_back_keeps_both_and_touches_nothing_in_proton_drive`.
5. **Daemon restart while a replacing copy is open:** the helper's keepalive restores the mark, and the copy doesn't
   upload until closed. Task 3 Step 1, `a_keepalive_after_a_restart_restores_the_mark`.

---

### Task 1: #302, the mount tests survive a nearly full disk

**Files:** Modify `native-vfs/tests/mount.rs`:
- `the_drive_reports_the_accounts_storage`, about line 685;
- `a_write_that_would_leave_the_system_disk_under_5_gb_is_refused`, about line 719;
- the header, lines 1–4.

**Interfaces:** Produces `fn has_room(needed: u64) -> bool`, test-local. It prints
`"skipped: needs {needed} bytes free where TMPDIR points"` to stderr and answers false when TMPDIR's disk has less
`f_bavail * f_frsize` than `needed`.

- [ ] **Step 0: Branch** `fix/302-mount-test-underflow` from main. Commit the spec and this plan first:
  `docs: design and plan for files and disk (#64, #299, #300, #301, #302)`, with `Refs #302`.
- [ ] **Step 1: Make the arithmetic saturate.**
  - `max - used` becomes `max.saturating_sub(used)` (both uses).
  - Any other unsigned subtraction from a disk reading in these two tests saturates too.
- [ ] **Step 2: Skip instead of failing on a nearly full disk.**
  - The two disk-dependent tests start with `if !enabled() || !has_room(LOCAL_RESERVE_BYTES_FOR_TESTS) { return; }`.
  - `const LOCAL_RESERVE_BYTES_FOR_TESTS: u64 = 5_000_000_000 + 100_000_000`: the reserve plus what the test writes.
  - Update the header to say these two skip with a message rather than fail.
- [ ] **Step 3: Check.** In `native-vfs/`, run `cargo test --release`, then
  `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --release --test mount`, then `cargo clippy --release --all-targets`. All
  pass; this machine's /tmp has room, so nothing skips.
- [ ] **Step 4: Commit.** `fix(vfs): mount tests' size checks saturate and skip on a nearly full disk` with
  `Fixes #302`.

---

### Task 2: #64, helper write sessions and the background sender

**Files:**
- Create `native-vfs/src/notices.rs`, and add `mod notices;` in `main.rs`.
- Modify `native-vfs/src/daemon.rs`: the new `notify`.
- Modify `native-vfs/src/fs.rs`:
  - the `State` fields;
  - `open`, `create`, `write`, `setattr`, `release`;
  - `write_at` (it gains `ino`);
  - the keepalive thread, started like `start_space_refresh`.
- Modify `native-vfs/tests/mount.rs`: the fake daemon's routes.

**Interfaces:**
- `daemon.rs`:
  - `pub const NOTICE_TIMEOUT: Duration = Duration::from_secs(5);`
  - `pub fn notify(&self, route: &str, body: serde_json::Value) -> Result<(), DaemonError>`: a POST with no
    `deadlineMs`, timed by `NOTICE_TIMEOUT`.
- `notices.rs`:
  - `pub enum Notice { Writing { path: String, replacing: bool }, Closed { path: String, refused: bool, replaced: bool }, Refused { needed: u64, available: u64 } }`
    - `Writing` posts to `/vfs/writing {path, replacing}`;
    - `Closed` posts to `/vfs/closed {path, refused, replaced}`;
    - `Refused` posts to `/vfs/refused {needed, available}` (Task 6 sends it).
  - `pub struct Notices`, with:
    - `pub fn start(send: impl Fn(&Notice) -> Result<(), DaemonError> + Send + 'static) -> Arc<Notices>`, which spawns
      one thread named `notices`;
    - `pub fn send(&self, notice: Notice)`, which never blocks.
  - **Queue rules:** a `Mutex<VecDeque<Notice>>` with a `Condvar`.
    - When best-effort notices reach `NOTICE_QUEUE_MAX = 1024`, the oldest best-effort one is dropped.
    - `Closed { refused: true }` is never dropped.
    - A failed best-effort post is dropped.
    - A failed refused close stays at the head and is retried every `NOTICE_RETRY = Duration::from_secs(2)`. Notices
      behind it wait, so order is kept.
    - The thread ends when the last `Arc<Notices>` is dropped, as `start_unlinker` does with `Weak`.
- `fs.rs`:
  - `struct WriteSession { handles: u32, replacing: bool, refused: bool }`.
  - `State.sessions: Mutex<HashMap<u64, WriteSession>>`, keyed by ino.
  - `State.writing_fhs: Mutex<HashSet<u64>>`.
  - `State.notices: Arc<Notices>`. `DriveFs::new` builds it over `daemon.notify`; tests build it over a recording
    closure.
  - `KEEPALIVE_EVERY = Duration::from_secs(30)`.
  - Methods on `State`:
    - `begin_writing(ino, fh, replacing)`;
    - `mark_replacing(ino)`;
    - `mark_refused(ino)`;
    - `end_writing(ino, fh)`.
- **Produces for Task 3:** the three wire formats above. The `path` is relative to the drive root, as in `/vfs/rename`.

- [ ] **Step 0: Branch** `feat/64-upload-on-close` from main, after #302's PR merges.
- [ ] **Step 1: Write the failing tests.**

  **Unit, in `notices.rs`** (inject a `send` closure that records, and can be made to fail):
  - `notices_go_out_in_order`.
  - `a_full_queue_drops_the_oldest_best_effort_notice`: with `send` blocked, 1030 `Writing` notices leave 1024, and
    the first six are gone.
  - `refused_closes_are_never_dropped_and_retry_in_order`: `send` fails twice for a refused close, then succeeds. The
    refused close is delivered once, before the `Writing` notice queued after it. 2000 refused closes behind a full
    best-effort queue are all delivered.

  **Unit, in `fs.rs`** (the `scripted` harness, with `Notices` recording):
  - `a_new_file_is_a_replacing_session_closed_on_its_last_release`: create, write, release gives
    `[Writing{p, true}, Closed{p, refused: false, replaced: true}]`.
  - `an_open_without_trunc_is_not_replacing`: open RDWR, write, release gives `[Writing{p, false}, Closed{p, false, false}]`.
  - `a_truncate_to_zero_turns_a_session_replacing`: open RDWR, setattr size 0 gives a second
    `Writing{p, replacing: true}`, and the close says `replaced: true`.
  - `closed_is_posted_after_the_last_writing_handle`: two writing opens and one close give no `Closed`; the second
    close gives one.
  - `a_read_only_open_sends_nothing`.
  - `a_refused_write_marks_the_close_refused`: a room of 0 makes a growth write fail ENOSPC; the close says
    `refused: true`.
  - `a_refused_growth_by_setattr_marks_the_close_refused`.
  - `a_file_deleted_while_open_sends_no_close`.
  - `a_renamed_open_file_closes_under_its_new_name`.
  - `trash_info_and_volume_info_handles_send_nothing`.
  - `a_replacing_session_is_kept_alive_every_30_s`: drive the keepalive tick directly, through a test seam
    `State::keepalive_tick()`. It re-sends `Writing{p, true}` for replacing sessions only.

  **Real mount, in `mount.rs`** (the fake daemon records `/vfs/writing` and `/vfs/closed` into new `Calls` vecs, with
  accessors `writings()` and `closes()`; parse the body directly, since there's no deadline):
  - `cp_over_a_file_posts_writing_then_closed_replaced`: `cp` an outside file over a local one; the closes are
    `[{path, refused: false, replaced: true}]`.
  - `an_append_posts_a_close_that_isnt_replacing`.
- [ ] **Step 2: Run them; the new tests fail** (compile errors first, then assertions). Commands: in `native-vfs/`,
  `cargo test --release -- notices` and `cargo test --release -- fs::tests`.
- [ ] **Step 3: Implement.**
  - `begin_writing`:
    - **When:** in `open` when `writing` (access isn't read-only), on every path that gives a handle. That includes
      `Handle::Deferred` and the O_TRUNC `make_empty` path, which is `replacing = true`. Also in `create`, except
      trash-info, which is `replacing = true`.
    - **Then:** insert the fh into `writing_fhs`. Post `Writing` on the first handle of the session, or when
      `replacing` turns true.
  - `mark_replacing`: from `setattr` with `size == Some(0)` when the ino has a session.
  - `mark_refused`: on any `Err(ENOSPC)` from `write_at`, `write_deferred`, or `setattr`'s size change.
  - `end_writing`: from `release` when the fh is in `writing_fhs`. It posts `Closed` with `path_of(ino)` when that is
    `Some`. Reply to `release` first; the post never waits.
  - The keepalive thread re-sends `Writing{p, true}` for every replacing session every `KEEPALIVE_EVERY`.
- [ ] **Step 4: Run all checks** (Global Constraints, Rust and the mount tests). Expected: all pass, clippy clean.
- [ ] **Step 5: Commit.** `feat(vfs): the drive tells the daemon when a file is open for writing and when its last
  writer closes it`, with `Refs #64`.

---

### Task 3: #64, the daemon uploads on close and never mid-replace

**Files:**
- Modify `src/daemon/controlServer.ts`:
  - the `driveRoute` cases;
  - `DRIVE_ROUTES`;
  - the `engine` Pick, which gains `driveWriting`, `driveClosed` and `clearDriveWriting`.
- Modify `src/daemon/controlWiring.ts` if the Pick needs widening there.
- Modify `src/sync/syncEngine.ts`:
  - the marks;
  - `stillBeingWritten`;
  - `renameLocally`;
  - the new public methods.
- Modify `src/daemon/vfsSupervisor.ts` (`onHelperStart?: () => void`, called right after `spawnHelper()` in `launch()`)
  and `src/daemon/daemonServer.ts` (the wiring).
- Tests:
  - `tests/syncEngine.test.ts`, a new `describe('upload on the last close (#64)')` next to the #51 block, using its
    `settle` seam;
  - `tests/controlServer.test.ts`;
  - `tests/vfsSupervisor.test.ts`.

**Interfaces:**
- **Engine:**
  - `driveWriting(relPath: string, replacing: boolean): void`
  - `driveClosed(relPath: string, opts: { refused: boolean; replaced: boolean }): Promise<void>`
  - `clearDriveWriting(): void`
  - A private `writingMarks: Map<string, { replacing: boolean; at: number }>`, timed by `settle.now`.
  - `DRIVE_MARK_EXPIRES_MS = 90_000`.
- **Routes:**
  - `POST /vfs/writing {path: string, replacing: boolean}` and `POST /vfs/closed {path, refused: boolean, replaced: boolean}`.
  - Both answer `{ok: true}`. A wrong type answers 400 `{code: 'EINVAL'}`.
  - Neither takes `deadlineMs`.
- **Produces for Task 4:** `driveClosed`'s `refused: true` branch. In this task it behaves like `refused: false`;
  Task 4 replaces it with the hold.

- [ ] **Step 0:** same branch as Task 2.
- [ ] **Step 1: Write the failing tests.** The engine tests use the virtual layout and the #51 `setup` with
  `quietMs: 2000`, `maxWaitMs: 120_000`, `now` and `schedule`.
  - `a_replacing_file_never_uploads_while_marked`: `driveWriting(p, true)`, write, `advance(10 * 60_000)` with looks
    running; no upload.
  - `the_close_uploads_at_once`: then `await driveClosed(p, {refused: false, replaced: true})`; exactly one upload, with
    no `advance`.
  - `a_marked_file_edited_in_place_keeps_the_2_minute_rule`: `driveWriting(p, false)` with the file changing on every
    look uploads only at the 120 s mark.
  - `a_mark_expires_after_90_s_without_a_keepalive`: replacing, `advance(91_000)`, change gives the settle rule again.
  - `a_keepalive_after_a_restart_restores_the_mark`: restart the engine on the same db, then `driveWriting(p, true)`;
    `advance(5 * 60_000)`; no upload.
  - `a_drive_rename_moves_the_mark`: `driveWriting(a, true)`, `renameItem(a, b)`; b doesn't upload while marked, and
    `driveClosed(b, …)` uploads b.
  - `clearDriveWriting_drops_every_mark`.
  - `a_close_for_a_path_never_marked_or_gone_does_nothing_harmful`.
  - **Routes:**
    - the routes call the engine with the parsed values;
    - a wrong type is 400 EINVAL;
    - both are 405 on GET.
  - **Supervisor:** `onHelperStart` is called once per launch, including a relaunch after a crash. Use the fake spawn.
- [ ] **Step 2: Run them; they fail.** `bun test tests/syncEngine.test.ts -t "#64"`, plus the controlServer and
  vfsSupervisor tests.
- [ ] **Step 3: Implement.**
  - `stillBeingWritten` consults a live mark first:
    - **Replacing:** `forgetSettling`, schedule a look after `quietMs`, return true. There's no max-wait for it.
    - **Not replacing:** the existing logic, except that "quiet" alone doesn't let it through; only the max-wait does.
  - `driveClosed`: delete the mark, `forgetSettling(rel)`, record a settled entry for the current stat (as
    `stillBeingWritten` does when quiet), then `void this.handleLocalFileChange(rel)`, tracked in `runningLooks`.
  - `renameLocally` moves a mark from the source to the target, and drops one at a replaced target.
  - Wire `onHelperStart: () => engine.clearDriveWriting()` in `daemonServer.ts`.
- [ ] **Step 4: Run all checks.** `bun test tests` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(sync): a file replaced through the drive uploads on its last close, never mid-write`,
  with `Fixes #64`.

---

### Task 4: #300, the daemon holds a cut-short file

**Files:**
- Modify `src/sync/syncStateDb.ts`:
  - the table and its accessors;
  - `getSummaryStats` gains `cutShortFiles`;
  - start-fresh's table list in `syncEngine.ts`, about line 3819, gains `'cut_short_files'`.
- Modify `src/sync/conflictResolver.ts`: `formatNotFullyWrittenName`.
- Modify `src/sync/syncEngine.ts`:
  - the hold in `driveClosed`;
  - the upload guards;
  - the lifts;
  - Put back;
  - the `transfersBelow` arm;
  - Activity.
- Modify `src/daemon/controlServer.ts`: the `/cut-short` routes.
- Tests:
  - `tests/syncEngine.test.ts`, a new `describe('cut-short files (#300)')` in the virtual layout;
  - `tests/syncStateDb.test.ts`;
  - `tests/controlServer.test.ts`.

**Interfaces:**
- **Table:** `cut_short_files (relPath TEXT PRIMARY KEY, nodeUid TEXT, size INTEGER NOT NULL, mtimeMs INTEGER NOT NULL, detectedAt INTEGER NOT NULL)`.
  It's created like `drive_edit_baselines`.
- **Db accessors:**
  - `holdCutShort(row)`
  - `getCutShort(rel)`
  - `listCutShort()`
  - `dropCutShort(rel)`
  - `moveCutShort(from, to)`: drops a row at `to`.
  - `dropStaleCutShort(exists: (rel) => boolean)`

  Each calls `onChange`.
- **Engine:**
  - `type CutShortItem = { relPath: string; existing: boolean; size: number; detectedAt: number }`
  - `listCutShort(): CutShortItem[]`
  - `uploadCutShort(paths: string[]): Promise<void>`: drops the rows and looks at each path, which uploads.
  - `putBackCutShort(paths: string[]): Promise<void>`: refuses a new file with `DriveOpError('EINVAL')`.
- `formatNotFullyWrittenName(originalName: string, date?: Date, host?: string): string`.
- **Routes:**
  - `GET /cut-short` answers `{items: CutShortItem[]}`.
  - `POST /cut-short/upload {paths: string[]}` and `POST /cut-short/restore {paths}` answer `{ok: true}`.
  - A path that isn't held is skipped, not an error.
- **Status:** `stats.cutShortFiles: number`.

- [ ] **Step 0:** branch `feat/300-cut-short-files` from main, after #64's PR merges.
- [ ] **Step 1: Write the failing tests.** Virtual layout; uploads are counted by `d.calls.uploads`.
  - **Holding:**
    - `a_refused_close_holds_an_existing_file`: synced `a.txt`, rewritten shorter, then
      `driveClosed('a.txt', {refused: true, replaced: true})`. A row exists with the node's uid; no upload after
      `advance(10 * 60_000)` and a sync pass; `stats.cutShortFiles === 1`.
    - `a_copy_over_an_online_only_file_counts_as_existing`: an edit baseline, no record; the row has the baseline's
      uid, and `existing: true` in `listCutShort`.
    - `a_refused_close_holds_a_new_file`: no record or baseline; the row has `nodeUid` null, and `existing: false`.
    - `an_unchanged_file_isnt_held`.
    - `the_row_survives_a_restart`: restart the engine, then a sync pass; still no upload.
  - **Lifting:**
    - `a_full_rewrite_lifts_the_hold`: `driveClosed(p, {refused: false, replaced: true})`; the row is gone and the file
      uploads once.
    - `a_close_that_didnt_replace_keeps_the_hold`.
    - `the_file_gone_drops_the_row`, both by a watcher delete and by a sync pass's stale cleanup.
    - `a_drive_rename_carries_the_row` and `a_rename_over_a_held_file_drops_its_row`.
    - `a_cloud_change_to_a_held_item_puts_it_back`: the remote revision changes, then a pass. The path has no local
      file and shows online-only through `vfsChildren`; the copy exists and holds the row; there's no conflict row and
      no upload.
  - **The user's choices:**
    - `upload_this_version_uploads_it_once`.
    - `put_back_keeps_both_and_touches_nothing_in_proton_drive`:
      - `putBackCutShort([p])` renames the local file to `formatNotFullyWrittenName` and moves the row to it (as a new
        file);
      - `p` has no local file and no record, and its baseline is gone;
      - `p` is listed online-only by `vfsChildren`;
      - `d.calls.trashed` is empty, `d.calls.uploads` is unchanged, and the cloud node is unchanged;
      - a watcher event and a sync pass afterwards trash nothing.
    - `put_back_of_a_new_file_is_refused`.
  - **Around the edges:**
    - `keep_local_on_a_held_path_is_refused`: `resolveConflictManually` throws `ConflictRefusedError(409)`.
    - `free_up_space_never_frees_a_held_file`: a regression test.
    - `a_held_file_reads_error_in_item_states`: `itemStates` gives transfer `'error'` for the file and its folder.
    - `activity_logs_the_first_cut_short_file_of_a_burst`: two holds within 60 s give one Activity line; one after
      61 s gives another.
  - **Db and routes:**
    - db: the table is created, and the accessors and `moveCutShort` work;
    - routes: list, upload, restore, a bad body, and a wrong method.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - **The hold:** the `refused: true` branch of `driveClosed` decides on the current file, a new file or one that
    differs from Proton Drive's version, and writes the row before returning. "Existing" means
    `getItemByPath(rel) || getEditBaseline(rel)`, read before any upload.
  - **The guards:** return early on a held path in `handleLocalFileChangeNow`, beside the `stillBeingWritten` check,
    and in `reconcileSinglePath`, beside its check. `resolveConflictNow`'s keep-local refuses a held path.
  - **Put back:** inside `whileRemoving`, as `freeUpSpace` does:
    - move the file with `moveWithoutReplacing` (watcher suppressed) to `formatNotFullyWrittenName`'s name, using `-N`
      on a clash;
    - `records.drop(rel)` and `stateDb.dropEditBaselines(rel)`;
    - `moveCutShort(rel, copy)`, then set the copy's `nodeUid` to null.
  - **A cloud change:** a remote change on a held path calls the same Put back steps instead of the conflict path.
  - **Emblems:** a `cut_short_files` arm in `transfersBelow` reads `'error'`.
  - **Activity:** logged with action `'error'`, at most once per 60 s.
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit.** `feat(sync): a file the disk guard cut short is held until the user decides`, with
  `Refs #300`.

---

### Task 5: #300, Home and the tray show held files

**Files:**
- Modify `native-gui/src/main.rs`:
  - `SummaryStats.cut_short_files`, `#[serde(default)]`;
  - the `WorkerCommand`/`WorkerEvent` variants;
  - the `control_request_at` callers;
  - the state `self.cut_short`.
- Modify `native-gui/src/home.rs`:
  - the `Attention` variants;
  - `attention_items`;
  - the row rendering.
- Modify `linux/tray/proton_drive_tray.py`: `problem_count`.
- Tests: inline in `home.rs` and `main.rs` (Harness), and `linux/tray/test_proton_drive_tray.py`.

**Interfaces:**
- **App state:**
  - `struct CutShortItem { rel_path: String, existing: bool, size: u64, detected_at: i64 }`, deserialized camelCase.
  - `Attention::CutShort(CutShortItem)` and `Attention::CutShortMany(Vec<CutShortItem>)`.
  - `attention_items(status, conflicts, cut_short)` gives one `CutShort` per item when there are 3 or fewer, else one
    `CutShortMany`.
- **Worker:**
  - `WorkerCommand::LoadCutShort`, which gives `WorkerEvent::CutShortLoaded(Result<Vec<CutShortItem>, String>)`.
  - `WorkerCommand::ResolveCutShort { paths: Vec<String>, restore: bool }`, which gives
    `WorkerEvent::CutShortResolved(Result<(), String>)`.
  - Reload on a change of `stats.cut_short_files`, as conflicts reload.
- **Tray:** `problem_count += n if n <= 3 else 1`, for `n = stats.cutShortFiles`.

- [ ] **Step 1: Write the failing tests.**
  - `attention_lists_cut_short_files_one_each_up_to_three`.
  - `more_than_three_cut_short_files_are_one_row`: the summary row's words, and its **Upload all anyway**, **Put back
    all** and **Show them**. **Put back all** shows only when some item is existing. **Show them** expands the list with
    each item's own buttons.
  - `a_held_existing_file_offers_upload_and_put_back`: the exact copy. Clicks send
    `ResolveCutShort{[p], restore: false}` and then `restore: true`.
  - `a_held_new_file_offers_only_upload_it_anyway`.
  - `an_old_daemon_without_cut_short_files_still_parses`: a status JSON without the field gives 0.
  - Tray: `test_problem_count_counts_up_to_three_cut_short_files_then_one`.
- [ ] **Step 2: Run them; they fail.** `cargo test --release -- cut_short` in `native-gui/`, then the tray test.
- [ ] **Step 3: Implement.** The rows follow the conflict row (`attention_row`, `action_button_if`). Buttons are
  disabled while offline.
- [ ] **Step 4: Run all checks, and take screenshots.** Use `shoot.sh` with a stand-in daemon list.
  - Add a screenshot-only `--fake-cut-short <one|many>` flag, as for `--fake-shared`.
  - Shoot Home light and dark at 1000×700, and at 840×540 with `--zoom 1.2`.
- [ ] **Step 5: Commit.** `feat(gui): Home and the tray show files that weren't fully written`, with `Fixes #300`.

---

### Task 6: #299, the helper reports refusals; the daemon says the disk is full

**Files:**
- Modify `native-vfs/src/fs.rs` (`LocalRoom`): a reporter, called on a due ENOSPC refusal.
- Modify `native-vfs/src/main.rs` and `native-vfs/src/fs.rs` (`DriveFs::new`): wire the reporter to
  `Notice::Refused`.
- Modify `src/daemon/controlServer.ts`: `/vfs/refused`.
- Modify `src/sync/syncEngine.ts`:
  - `driveRefused`;
  - `diskFull` in `getStatus`;
  - the `diskFree` seam;
  - `LOCAL_RESERVE_BYTES`.
- Tests:
  - fs.rs unit;
  - `tests/syncEngine.test.ts`, `describe('disk full (#299)')`;
  - `tests/controlServer.test.ts`.

**Interfaces:**
- `LocalRoom::report_to(&self, report: impl Fn(u64, u64) + Send + Sync + 'static)`, set once with a `OnceLock`. It's
  called with `(needed, available)` in `allow`'s refusal branch exactly when `log_due()` is true and the errno is
  ENOSPC, not EIO.
- Engine:
  - `driveRefused(needed: number, available: number): void`, which records `lastRefusalAt`;
  - `getStatus().diskFull: { refusedAt: number } | null`.
- `diskFull` is non-null while `now - lastRefusalAt < 10 * 60_000` and the store's disk has less than
  `LOCAL_RESERVE_BYTES + 1_000_000_000` available. The disk is read through `options.diskFree?: (dir: string) => Promise<number>`;
  the default is `statfs` with `bavail * bsize`.
- Route: `POST /vfs/refused {needed: number, available: number}` answers `{ok: true}`.
- **Produces for Task 8:** `driveRefused` is also what a refused open records.
- `getStatus` stays synchronous. The engine caches the last `diskFree` reading, refreshing it after each refusal and on
  each status read, and the read is awaited by the next call.

- [ ] **Step 0:** branch `feat/299-disk-full-notice` from main, after #300's PRs merge.
- [ ] **Step 1: Write the failing tests.**
  - Helper:
    - `a_due_refusal_is_reported_with_its_sizes`;
    - `refusals_within_30_s_are_reported_once`;
    - `an_unreadable_disk_isnt_reported`.
  - Daemon:
    - `a_refusal_sets_disk_full_for_10_minutes`;
    - `disk_full_clears_early_once_there_is_room`;
    - `the_refused_route_calls_the_engine`, plus a bad body.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** as in the Interfaces.
- [ ] **Step 4: Run all checks.** Daemon and Rust (native-vfs).
- [ ] **Step 5: Commit.** `feat(vfs,sync): refusals reach the daemon, which says the disk is full`, with `Refs #299`.

---

### Task 7: #299, the notice on Home and the tray line

**Files:**
- Modify `native-gui/src/main.rs`: `DaemonStatus.disk_full: Option<DiskFull>`, `#[serde(default)]`, and the notice.
- Modify `native-gui/src/home.rs`: where the notice renders.
- Modify `linux/tray/proton_drive_tray.py`: `status_line`.
- Tests: inline, and the tray test.

**Interfaces:**
- `struct DiskFull { refused_at: i64 }`.
- The notice shows while `status.disk_full.is_some()`. It sits in `render_home` after `render_status_block`, in the
  warning frame `render_notice` uses, with no close button, since it goes away by itself.
- It has a secondary button **Free up space…** that calls `self.open_free_up_space(String::new())`, enabled as Home's
  button is.
- Tray: `status_line` answers `("Disk almost full", "protondrive-tray-error")` when `status.get("diskFull")`, after
  signed-out and paused and before syncing.

- [ ] **Step 1: Write the failing tests.**
  - `the_disk_full_notice_shows_and_offers_free_up_space`: the exact copy; a click opens `PendingConfirm::FreeAll`.
  - `no_notice_without_disk_full`.
  - Tray:
    - `test_status_line_says_disk_almost_full`;
    - `test_paused_wins_over_disk_full`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all checks, and take screenshots.** Add a screenshot-only `--fake-disk-full` flag. Shoot Home light
  and dark at 1000×700, and at 840×540 with `--zoom 1.2`.
- [ ] **Step 5: Commit.** `feat(gui): Home and the tray say when the disk is almost full`, with `Fixes #299`.

---

### Task 8: #301, an open that would fill the disk is refused

**Files:**
- Modify `src/sync/driveOps.ts`: `DriveOpErrorCode` gains `'ENOSPC'`.
- Modify `src/sync/syncEngine.ts`: the room check in `hydrate` and the reservations.
- Modify `native-vfs/src/daemon.rs`: `errno_of_code` gains ENOSPC.
- Modify `native-vfs/src/fs.rs`: `hydrate_unlogged` passes ENOSPC through with no error line.
- Modify `native-vfs/tests/mount.rs`: `Fake::refusing(path, "ENOSPC")` already works.
- Tests:
  - `tests/syncEngine.test.ts`, `describe('an open that would fill the disk (#301)')`;
  - `daemon.rs` `error_codes_map_to_errnos`;
  - mount.rs.

**Interfaces:**
- **Engine:** in `hydrate` (after the existing refusals, before `hydrateNow`):
  - if `available - (entry.size + reservedBytes) < LOCAL_RESERVE_BYTES`, throw
    `DriveOpError('ENOSPC', 'Not enough room on this computer\'s disk')` and call `driveRefused(...)`;
  - `reservedBytes` is the sum over a new `hydrationSizes: Map<string, number>`, added before downloading and removed in
    `finally`;
  - `available` comes from `options.diskFree`, from Task 6.
- **Helper:** ENOSPC from `/vfs/hydrate` reaches the app as ENOSPC, with `line: None`.

- [ ] **Step 0:** branch `feat/301-open-room-check` from main, after #299's PRs merge.
- [ ] **Step 1: Write the failing tests.**
  - `an_open_that_would_leave_less_than_the_reserve_is_refused_with_enospc`: `diskFree` gives
    `LOCAL_RESERVE_BYTES + 100`; a file of 1000 bytes is refused with ENOSPC, and `diskFull` is set.
  - `an_open_that_fits_downloads`.
  - `two_opens_at_once_count_each_other`: two files of 600 bytes with 1000 bytes of room above the reserve; the
    second is refused while the first downloads.
  - `error_codes_map_to_errnos` covers ENOSPC.
  - Mount: `an_open_refused_for_room_reaches_the_app_as_enospc_and_isnt_logged`.
    - Reading the file gives ENOSPC on open.
    - A write-only open gives ENOSPC on its first write.
    - `stderr` has no "couldn't download" line.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all checks.** Daemon, Rust (native-vfs) and the mount tests.
- [ ] **Step 5: Commit.** `feat(sync,vfs): an open that would fill the disk is refused with ENOSPC`, with `Fixes #301`.

## After all PRs

- File the follow-up the spec names: downloads the sync makes on its own (Always keep, the whole drive kept) aren't
  guarded by the reserve.
- Deploy the daemon, the helper and the app together:
  - wait for the daemon to be idle;
  - back up the database;
  - run the full deploy procedure.
