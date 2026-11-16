# Storage on Home, the Drive's Free Space, Keeping Always Keep Files: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show used and free space on Home (#294). Have the virtual drive report Proton's free space, with a guard that keeps the system disk from filling (#295). Let Free up space keep files marked Always keep (#296).

**Architecture:**
- Three independent PRs, one per issue.
- #294 changes Home's drive card (`native-gui/src/home.rs`).
- #295 changes the FUSE helper (`native-vfs/src/fs.rs`): `drive_size` and a write guard.
- #296 adds a `keepPinned` option to the daemon's free action (`src/sync/syncEngine.ts`, `src/sync/availability.ts`, `src/daemon/controlServer.ts`), a read-only `GET /availability/pinned`, and the checkbox in the app's Free up space dialog (`native-gui/src/main.rs`).

**Tech Stack:** Rust (egui 0.31, fuser), Bun/TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-15-storage-and-free-up-design.md`

## Global Constraints

- **Storage on Home:**
  - Row text, verbatim format: `"{used} used · {free} free of {max}"`, using `format_bytes`.
  - Hover: `"Drive uses {drive} of it; the rest is your other Proton apps"`.
  - The row is hidden without a quota.
- **The drive's sizes (statfs):**
  - total = quota;
  - free = available = quota − used, saturating;
  - until the quota is known, the local disk's numbers.
- **The guard:**
  - `LOCAL_RESERVE = 5_000_000_000` bytes.
  - A write that grows a file is refused with `ENOSPC` when the system disk would be left with less than that available.
  - A write that doesn't grow a file is never refused.
- **The keepPinned option:**
  - `POST /availability {path, action: "free", keepPinned?: boolean}`. A `keepPinned` that isn't a boolean, or one sent with another action, is a 400.
  - Without it, freeing behaves exactly as today.
- **The pinned summary:**
  - `GET /availability/pinned` → `{ "items": number, "wholeDrive": boolean }`, on the control socket only.
  - It only reads.
- **The dialog:**
  - Checkbox label: `Also free files marked Always keep on this device`, unticked by default.
  - Shown only when `items > 0 && !wholeDrive`.
  - While the summary is unknown or failed, there's no checkbox and confirming keeps Always keep files (`keepPinned: true`).
  - Unticked hint: `Files marked Always keep stay on this computer.`
- **Data safety:**
  - Freeing never removes a file that isn't safely in Proton Drive (unchanged).
  - The guard never touches existing data.
- **Checks:**
  - daemon: `bun test tests` and `bunx tsc --noEmit`;
  - Rust: `cargo test --release` and `cargo clippy --release --all-targets`, with no warnings, in each crate touched.
- **Git:** no AI attribution anywhere. One issue, one branch, one PR.

## Review Focus

1. **Pinned and not yet uploaded:** a file marked Always keep that isn't uploaded yet is never freed, with `keepPinned` true or false. (Task 3 test.)
2. **Pinned folder with an online-only child:** with `keepPinned: true`, the folder's other files stay and the online-only child is freed. That is what `isPinned` already says for each path. (Task 3 test.)
3. **A write past the end of a file** (a seek, then a write) counts as growth from the old size to the new end. A write inside the file counts as none. (Task 2 test.)
4. **The guard before the quota is known:** it still applies, because it depends only on the local disk. (Task 2 test.)
5. **Confirming before the summary arrives:** the dialog is confirmed before the pinned summary comes back. It sends `keepPinned: true`. (Task 3 test.)

---

### Task 1: Storage on Home (#294) — branch `feat/294-home-storage`

**Files:** Modify `native-gui/src/home.rs` (`render_your_drive`, next to `storage`/`Storage`). Commit the spec and this plan first on this branch (`docs: storage on Home, the drive's free space, keeping Always keep files`, `Refs #294 #295 #296`).

**Interfaces:**
- Produces:
  - `pub fn storage_line(account: Option<&AccountInfo>) -> Option<String>` returns `"3.0 GB used · 507.0 GB free of 510.0 GB"`.
  - `pub fn storage_hover(account: Option<&AccountInfo>) -> Option<String>` returns `"Drive uses 2.4 GB of it; the rest is your other Proton apps"`.
  - Both return `None` without a quota (`max_space == 0` or no account).
  - `Storage.tooltip`, which the sidebar uses, stays as it is.

- [ ] **Step 1: failing tests**
  - `storage_line_says_used_and_free_of_the_quota`: `used_space = 3 GiB`, `max_space = 510 GiB` gives `format!("{} used · {} free of {}", format_bytes(3 GiB), format_bytes(507 GiB), format_bytes(510 GiB))`. Also: `used > max` gives free `0 B`; no account gives None.
  - `home_shows_proton_storage_used_and_free` (harness): with an account, `text_at(storage_line…)` is Some at x > the sidebar edge. Hovering the row shows `storage_hover`. With `account = None`, the row isn't shown.
  - `homes_storage_row_fits_at_840_by_540_zoomed`: with `resize_zoomed(840×540, 1.2)`, the row's text rect is inside the window, right of the sidebar edge.
- [ ] **Step 2: run them and see them fail** (`cd native-gui && cargo test --release -- storage_line home_shows_proton_storage homes_storage_row`).
- [ ] **Step 3: implement.**
  - The row: "Proton storage" (13, `TEXT_PRIMARY()`) on the left, `storage_line` (13, `TEXT_MUTED()`) on the right, then `usage_bar(ui, fraction, PROTON_PURPLE, BORDER_SUBTLE())`, with `storage_hover` on hover over both.
  - It goes after the drive's path and before "On this computer", separated as the card's other rows are.
  - At narrow widths the text wraps under the label rather than clipping.
- [ ] **Step 4:** run the full suite and clippy.
- [ ] **Step 5: screenshots.** Use `scratchpad/fakedaemon/shoot.sh`, Home light and dark at 1100×760 and 840×540, plus `--zoom 1.2` at 840×540 light.
- [ ] **Step 6: commit** `feat(gui): Home shows Proton storage used and free` (`Fixes #294`).

### Task 2: The drive reports Proton's free space; a guard for the system disk (#295) — branch `fix/295-drive-free-space`

**Files:** Modify `native-vfs/src/fs.rs`:
- `drive_size` (~1601) and its tests (~1620);
- the `write` handler (~1451);
- `setattr` (~1054), for size growth;
- `fallocate` and `copy_file_range`, if implemented.

**Interfaces:**
- Produces:
  - `const LOCAL_RESERVE: u64 = 5_000_000_000;`
  - `fn growth(old_len: u64, offset: u64, len: u64) -> u64`, which is `(offset + len).saturating_sub(old_len)`.
  - `struct LocalRoom { read: Box<dyn Fn() -> io::Result<u64> + Send + Sync>, cache: Mutex<(Instant, u64 /*available*/, u64 /*granted since*/)> }`.
  - `fn LocalRoom::allow(&self, growth: u64) -> Result<(), Errno>`.
    - It re-reads when the reading is older than 250 ms, or when more than 1 GB has been granted since the last reading.
    - It refuses with `Errno::ENOSPC` when `available - granted_since - growth < LOCAL_RESERVE`.
    - Otherwise it adds `growth` to `granted_since`.
    - `growth == 0` always passes without a reading.
  - The production `read` is `statvfs(backing).f_bavail * f_frsize`.

- [ ] **Step 1: failing tests**
  - `the_drive_reports_protons_free_space`: the existing sizes test (118.6 GB local available, 13.57 of 510 GB used) now expects `available == free == (510 − 13.57) GB / block`, and `blocks == 510 GB / block`. With no quota, the local numbers.
  - `growth_counts_only_bytes_past_the_end`: `growth(100, 0, 50) == 0`, `growth(100, 80, 50) == 30`, `growth(100, 200, 10) == 110`.
  - `the_guard_keeps_five_gb_on_the_system_disk`: with an injected reading of 6 GB, `allow(500 MB)` is Ok, a second `allow(600 MB)` is ENOSPC (it would leave 4.9 GB), and `allow(0)` is Ok.
  - `the_guard_rereads_after_a_while`: the injected reading counts its calls. Two quick allows read once; after 300 ms (sleep or an injected clock) it reads again.
  - `the_guard_applies_before_the_quota_is_known`: the guard doesn't depend on `space`.
- [ ] **Step 2: run them and see them fail** (`cd native-vfs && cargo test --release -- drive_reports growth_counts guard`).
- [ ] **Step 3: implement.**
  - **statfs:** `drive_size` reports `available: cloud_free`.
  - **The guard:** `LocalRoom` is held in the fs state. Call `allow(growth)` before writing:
    - in `write`, for `Handle::File`, with `old_len` from the open file's metadata;
    - in `setattr` with a larger size;
    - in `fallocate`, for its range.
  - **Refusal:** reply `ENOSPC` and write nothing.
  - **Not guarded:** `Handle::TrashInfo` and `Handle::Deferred`, whose writes are small. Note it in a comment.
- [ ] **Step 4: checks.**
  - `cargo test --release` and `cargo clippy --release --all-targets` in `native-vfs`.
  - Where `/dev/fuse` and `fusermount3` exist, `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --release --test mount`: no regression.
- [ ] **Step 5: commit** `fix(vfs): report Proton's free space, and keep 5 GB free on the system disk` (`Fixes #295`).

### Task 3: Free up space can keep Always keep files (#296) — branch `feat/296-free-keep-pinned`

**Files:**
- Modify:
  - `src/sync/availability.ts`: `pinnedSummary`;
  - `src/sync/syncEngine.ts`: `setAvailability` (~5888), `setAvailabilityNow`, `freeUpSpace` (~6109);
  - `src/daemon/controlServer.ts`: `/availability` (~436-468);
  - `native-gui/src/main.rs`: `PendingConfirm::FreeAll`, `render_confirm_modal`, `set_availability` (~725), the worker, the harness's `sent()`.
- Tests: `tests/availability*.test.ts` and `tests/syncEngine*.test.ts` (whichever cover free today), `tests/controlServer.test.ts`, and the main.rs tests.

**Interfaces:**
- Produces:
  - **Daemon:**
    - `engine.setAvailability(relPath, action, opts?: { keepPinned?: boolean })`.
    - `freeUpSpace(relPath, uid, current, keepPinned: boolean)`.
    - With `keepPinned`: `policy.setPin(uid, 'unpinned', false)`, keeping the marks below. Every scanned entry with `policy.isPinned(entry.relPath)` is added to `keep`.
    - `engine.pinnedSummary(): { items: number; wholeDrive: boolean }`. `items` counts the availability rows with `pin = 'pinned'` other than the top level's. `wholeDrive` is true when the top level is pinned, either by its row or by the first-sync default (`PIN_ROOT_ON_FIRST_SYNC`). The builder confirms which applies.
  - **App:**
    - `PendingConfirm::FreeAll { rel_path: String, also_pinned: Option<bool> }`. `None` means no checkbox; `Some(ticked)` is the checkbox's state.
    - `WorkerCommand::PinnedSummary` and `WorkerEvent::PinnedSummary(Result<(u32, bool), String>)`.
    - `set_availability(path, action, keep_pinned: Option<bool>)` puts `keepPinned` in the body when it's Some.
    - The harness's `sent()` string for a free becomes `free "<path>"` plus ` keep-pinned` when `keepPinned: true` is sent.

- [ ] **Step 1: failing tests (daemon)**
  - Free with `keepPinned: true` on "":
    - a pinned folder's synced files stay, and its pin stays (`isPinned`);
    - an unpinned synced file is freed;
    - an unsynced file is kept;
    - a pinned folder's explicitly unpinned child is freed.
  - Free without the option: unchanged (an existing test still passes, and the pinned folder's files are freed).
  - `pinnedSummary`: zero; two pinned folders give `{items: 2, wholeDrive: false}`; root pinned gives `wholeDrive: true`.
  - Route: `keepPinned: "yes"` is a 400; `keepPinned` with `pin` is a 400; `GET /availability/pinned` returns the summary.
- [ ] **Step 2: run them and see them fail.**
- [ ] **Step 3: implement the daemon.** Run `bun test tests` and `bunx tsc --noEmit`.
- [ ] **Step 4: failing tests (app)**
  - Opening Free up space… sends a `pinned summary` read, and the dialog has no checkbox until it answers.
  - With `(2, false)`, the checkbox shows unticked with the "stay on this computer" hint. Confirming sends `free "" keep-pinned`.
  - Ticking switches the hint to today's sentence. Confirming sends `free ""`.
  - With `(0, false)`, `(3, true)` or `Err`: no checkbox. Confirming sends `free "" keep-pinned`.
  - Confirming before the answer sends `free "" keep-pinned`.
  - A folder's Free up space (`FreeAll` with a non-empty `rel_path`, as in `confirming_free_all_for_a_folder_sends_free_for_that_folder`) reads no summary, shows no checkbox, and sends `free "Docs"` as today. The option is only for the whole drive.
  - A `--fake-pinned <n>` screenshot flag fills the summary.
- [ ] **Step 5: implement the app.** Run `cargo test --release` and clippy.
- [ ] **Step 6: screenshots.** `--confirm-free-all --fake-pinned 3`, light and dark, at 1100×760 and 840×540.
- [ ] **Step 7: commit(s).** `feat(sync): free up space can keep the files marked Always keep`, then `feat(gui): …`. The last commit says `Fixes #296`.
