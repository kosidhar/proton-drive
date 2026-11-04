# Control Centre, Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Proton Drive app from a file browser into three sections (Home, Activity, Settings), with no file browser, no top bar and no Conflicts tab. Every control the app has today stays reachable.

**Architecture:** New pure logic (the status line, the attention list, the tab names) lives in `native-gui/src/home.rs` with unit tests. Rendering stays in egui methods on `ProtonDriveNativeApp`. New screens go in `native-gui/src/home.rs` (Home) and `native-gui/src/settings.rs` (the Account section); the existing settings cards and activity list move as they are. The removed browser code is deleted, not hidden.

**Tech Stack:** Rust, egui/eframe 0.31, serde. Checks: `cargo test --release` and `cargo clippy --release --all-targets` in `native-gui/`.

**Spec:** `docs/superpowers/specs/2026-11-04-app-control-centre-design.md` (issue #191).

## Global Constraints

- **Daemon routes:** every action uses the existing worker commands and control-socket routes. No new daemon route and no daemon change in Stage 1.
- **Plain words:** user-facing text never contains `currentAction` raw, `/my-files`, or engine terms such as "listing", "reconcile", "hydrate" or "pass".
- **Window size:** the default is 900×640 when no saved geometry exists. The minimum stays 840×540.
- **`--tab` names:** `--tab` takes `home | activity | settings`. The old names map as `overview|activity → Activity`, `browser|cloud|files|selective|conflicts → Home`, anything else `→ Home`.
- **Screenshot mode stays read-only** (`SCREENSHOT_MODE`). Every new state can be shown with the existing flags (`--drive-status`, `--drive-move`, `--files-missing`, `--theme`, `--size`) or the new ones in Task 6.
- **No `#[allow(dead_code)]`** is added to hide removed code; clippy must pass with no warnings.
- **Signed out:** the sign-in screen and flow stay unchanged.

## Review Focus

1. **Daemon unreachable while the app is open:** Home must say so ("Can't reach Proton Drive's background service"), never keep showing "Up to date". Test: `summary_when_the_daemon_is_unreachable` in Task 1.
2. **Long names in attention rows and transfers** at 840×540: rows elide, no horizontal overflow. Check: a Task 6 screenshot with a 120-character file name in `--fake-attention`.
3. **Many conflicts (50):** the attention list scrolls inside its card, and the drive card stays reachable. Check: a Task 6 screenshot with `--fake-attention 50`.
4. **Plain-folder mode or an old daemon without `vfs`:** no "not mounted" attention, and the drive card says "plain folder". Test: `no_mount_attention_for_a_plain_folder_or_an_old_daemon` in Task 2.
5. **Paused by an older daemon** that sends `state: "paused"` but `settings.paused` false (or the reverse): either one reads as Paused. Test: `summary_reads_paused_from_either_field` in Task 1.

---

### Task 1: The status line

**Files:**
- Create: `native-gui/src/home.rs` (`mod home;` in `main.rs`)
- Modify: `native-gui/src/main.rs`: `DaemonStatus` gains `#[serde(default)] last_sync_at: Option<i64>` (wire name `lastSyncAt`, epoch ms)

**Interfaces:**
- Produces:
  - `pub enum Tone { Ok, Busy, Paused, Attention, Offline }`;
  - `pub struct StatusSummary { pub headline: String, pub detail: Option<String>, pub tone: Tone }`;
  - `pub fn status_summary(status: &DaemonStatus, daemon_online: bool, attention: usize, now_ms: i64) -> StatusSummary`;
  - `pub fn ago(ms: i64) -> String`.

- [ ] **Step 1: Write the failing tests** in `home.rs` `#[cfg(test)]`, with a `status(state, transfers, paused)` helper building a `DaemonStatus`:
  - `summary_when_up_to_date`:
    - idle with `last_sync_at = now - 120_000` gives `("Up to date", Some("Last synced 2 min ago"), Tone::Ok)`;
    - with `None`, the detail is `None`.
  - `summary_names_what_moves`: state `syncing`:
    - 3 uploads give "Uploading 3 files";
    - 1 download of `docs/report.pdf` gives "Downloading report.pdf";
    - 2 uploads and 1 download give "Syncing 3 files";
    - no transfers give "Checking for changes…".

    Tone is `Busy` in every case.
  - `summary_never_shows_engine_text`: `current_action = Some("Listing /my-files/deployment")` while syncing. Neither `headline` nor `detail` contains "/my-files" or "Listing".
  - `summary_reads_paused_from_either_field`: `state "paused"` gives `("Paused", _, Tone::Paused)`, and so does `settings.paused = true` with state `idle`.
  - `summary_when_something_needs_the_user`: idle with `attention = 1` gives "1 problem needs you"; with 3, "3 problems need you". Tone `Attention`.
  - `summary_when_the_daemon_is_unreachable`: `daemon_online = false` gives `("Can't reach Proton Drive's background service", _, Tone::Offline)`, whatever the status says.
  - `ago_in_plain_words`:
    - 30 s gives "just now";
    - 120 s, "2 min ago";
    - 2 h, "2 h ago";
    - 3 days, "3 days ago".
- [ ] **Step 2:** Run `cargo test --release home::` in `native-gui/`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `status_summary` and `ago`.** The order of precedence is: offline, then paused, then syncing, then attention > 0, then up to date. The detail for syncing is `None`. The detail for "N problems need you" is "See Needs attention below".
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(gui): plain-language status line (Refs #191)`.

### Task 2: The attention list

**Files:**
- Modify: `native-gui/src/home.rs`

**Interfaces:**
- Consumes:
  - `DaemonStatus`, `ConflictRecord`, `VfsStatus`;
  - `offers_mount_again(&VfsStatus) -> bool` (existing, `main.rs:386`).
- Produces:
  - `pub enum Attention { Conflict { id: u64, rel_path: String }, FilesMissing, DriveNotMounted { message: String, can_mount: bool }, StoppedMove, FailedItems(u64), LastError(String) }`;
  - `pub fn attention_items(status: &DaemonStatus, conflicts: &[ConflictRecord]) -> Vec<Attention>`.

- [ ] **Step 1: Write the failing tests:**
  - `attention_lists_each_problem_once_in_order`. The order is: files missing, stopped move, drive not mounted, conflicts (unresolved only, by id), failed items, last error.
  - `no_attention_when_all_is_well`: an idle status with no conflicts gives an empty Vec.
  - `resolved_conflicts_are_not_listed`.
  - `no_mount_attention_for_a_plain_folder_or_an_old_daemon`: `vfs = None` gives none; `mode "plain"` gives none.
  - `a_stopped_move_is_attention_not_a_mount_problem`: `vfs.reason "move-failed"` with a `drive_move` gives `StoppedMove` only.
  - `last_error_is_listed_only_when_files_are_not_missing`: with `files_missing` set, only `FilesMissing` is listed.
  - `failed_items_come_from_stats`: `stats.error_items = 2` gives `FailedItems(2)`.

  `DriveNotMounted.message` reuses the text `render_drive_card` shows today for that reason. Extract it to a shared function if needed.
- [ ] **Step 2:** Run `cargo test --release home::`. Expected: FAIL.
- [ ] **Step 3:** Implement `attention_items`. Remove `#[allow(dead_code)]` from `SummaryStats::error_items`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(gui): what needs the user, as one list (Refs #191)`.

### Task 3: Three sections

**Files:**
- Modify: `native-gui/src/main.rs`: `NavTab`, `render_sidebar`, `render_ui`, argument parsing, the default window size, `USAGE`

**Interfaces:**
- Produces:
  - `enum NavTab { Home, Activity, Settings }`;
  - `fn parse_tab(name: &str) -> NavTab`, mapped as in Global Constraints;
  - `ProtonDriveNativeApp::attention: Vec<Attention>`, recomputed whenever the status or the conflicts change.

- [ ] **Step 1: Write the failing test** `parse_tab_maps_old_and_new_names`. It covers every name in Global Constraints, `"settings"`, and `"nonsense" → Home`.
- [ ] **Step 2:** Run `cargo test --release parse_tab`. Expected: FAIL.
- [ ] **Step 3: Implement it:**
  - **Sidebar:**
    - three items, Home, Activity, Settings, with the existing icons (Home uses the overview icon);
    - a count badge on Home when `attention` is non-empty;
    - the footer shows the account's initials and display name, and clicking it opens Settings;
    - the app version stays in the footer;
    - the "Open ~/ProtonDrive folder" button, the storage bar, the "Local folder" line, the "My files n/m" badge and the "Sync now" button are removed. Sync now moves to Home in Task 4.
  - **`render_ui`:** drop the `TopBottomPanel::top("proton_top_header")`, `render_top_bar`, and the `render_account_popover` and `render_row_menu` calls.
  - **The default inner size** for a missing saved geometry is `[900.0, 640.0]`.
  - **`--tab`** goes through `parse_tab`, and `USAGE` lists `home|activity|settings`.
  - **Until Tasks 4 and 5 land,** `Home` renders an empty `card_frame`, `Activity` renders the existing `render_overview_tab`, and `Settings` stays as is.
- [ ] **Step 4:** Run `cargo test --release` and `cargo clippy --release --all-targets`. Expected: PASS with no warnings. Dead code from the top bar is deleted here.
- [ ] **Step 5:** Commit `feat(gui): Home, Activity and Settings replace the tabs and the top bar (Refs #191)`.

### Task 4: Home

**Files:**
- Modify: `native-gui/src/home.rs` (an `impl ProtonDriveNativeApp { fn render_home(&mut self, ui) }` block), `native-gui/src/main.rs`

**Interfaces:**
- Consumes:
  - `status_summary`, `attention_items` / `self.attention`;
  - `render_transfer_line(ui, &ActiveTransfer)`;
  - the existing worker commands for pause, resume, sync, conflict resolve, mount again and drive move;
  - `render_files_missing`, `render_stopped_move`;
  - `PendingConfirm::FreeAll { rel_path: String::new() }`.

- [ ] **Step 1: Status block.** The headline is coloured by `Tone`, with the detail under it.
  - The main button is "Pause" or "Resume", using the same worker command the top bar's Pause used.
  - A secondary "Sync now" sends the same command as the old sidebar button.
- [ ] **Step 2: "Needs attention" card.** It's shown only when `self.attention` is non-empty, and its list scrolls once it is taller than 280 px.
  - **Conflict:** "Both copies kept: <file name>" (path in the tooltip), with "Show in Files", which runs `xdg-open` on the parent folder. The existing resolve buttons stay, sending the same `WorkerCommand::ResolveConflict`.
  - **FilesMissing:** calls the existing `render_files_missing` content inside the card. Remove its call from `render_ui`.
  - **StoppedMove:** the existing `render_stopped_move`.
  - **DriveNotMounted:** the message, plus "Mount again" when `can_mount` is true, the same as the drive card today.
  - **FailedItems(n):** "n files couldn't sync". It has no action until Stage 4.
  - **LastError:** the text.
- [ ] **Step 3: "In progress" card,** hidden with no transfers. It shows the first 5 `active_transfers` with `render_transfer_line`, then "N more" when there are more.
- [ ] **Step 4: "Your drive" card:**
  - the location (`sync_dir`, with `$HOME` shown as `~`);
  - "Virtual drive · mounted", "Virtual drive · not mounted" or "Plain folder", from `vfs`;
  - "Open in Files" (`xdg-open sync_dir`);
  - "Proton storage", with a bar and "X of Y" (`format_bytes` of `account.used_space` / `max_space`) and Drive's share in a tooltip;
  - "On this computer" with `stats.total_bytes`, and "Free up space…", which opens the existing FreeAll confirmation for the drive's top.
- [ ] **Step 5:** Run `cargo test --release` and `cargo clippy --release --all-targets`. Expected: PASS with no warnings.
- [ ] **Step 6:** Commit `feat(gui): Home shows status, what needs you, transfers and the drive (Refs #191)`.

### Task 5: Activity and Settings

**Files:**
- Modify: `native-gui/src/main.rs`
- Create: `native-gui/src/settings.rs` (the Account section)

**Interfaces:**
- Consumes: `self.search_query`, the existing activity table code in `render_overview_content`, the settings cards, and the sign-out worker command.

- [ ] **Step 1: Activity.**
  - Rename the activity part of `render_overview_content` to `fn render_activity(&mut self, ui)`.
  - Drop the four stat cards and the "Drive Cloud Usage" header text. Storage lives on Home now.
  - Put a search field at the top that filters rows by `search_query` (case-insensitive substring of path or details), the same filter the top bar search applied.
- [ ] **Step 2: Settings.**
  - Take the mount state, "Mount again" and the stopped-move rendering out of `render_drive_card`; Home shows them now. Keep the location, the switch and its confirmation.
  - Add `fn render_account_card(&mut self, ui)` in `settings.rs`, first in Settings. It shows:
    - the initials avatar, display name and email;
    - the plan pill (move the plan logic from `render_account_popover`);
    - storage as "X of Y";
    - "Sign out", sending the same command as the popover.
  - Delete `render_account_popover` and its state.
- [ ] **Step 3:** Run `cargo test --release` and `cargo clippy --release --all-targets`. Expected: PASS with no warnings.
- [ ] **Step 4:** Commit `feat(gui): Activity with its own search; Settings gains Account (Refs #191)`.

### Task 6: Remove the browser; screenshots

**Files:**
- Modify: `native-gui/src/main.rs`, `README.md` (if it describes My files or the tabs)

**Remove:**
- `render_browser_tab`, `render_browser_toolbar`, `render_breadcrumbs`, `render_row_menu`;
- `BrowserColumns`, `RowMenu`, `RemoteItem`, `RemoteListResponse`;
- `Availability` and `parse_availability`, `availability_pill`, `menu_actions`, `file_opens_on_click` and their tests;
- the worker commands and events only the browser used (listing, availability set, mkdir), `REMOTE_FIXTURE`;
- `PendingConfirm::Hide` and `KeepAll` (`FreeAll` stays);
- `draw_folder_icon` if unused;
- the flags `--path`, `--row-menu`, `--confirm-hide`, `--confirm-keep-all`, `--remote-fixture`, `--working`.

`--search` stays and sets the Activity search.

**Add screenshot-only flags:**
- `--fake-attention N`: N conflicts whose names cycle through `report.pdf`, `notes.txt` and one 120-character name, plus `FailedItems(2)`.
- `--fake-transfers N`: N uploads at 40% of 10 MB each.

- [ ] **Step 1:** Delete the code above. Run `cargo clippy --release --all-targets`, which must report no warnings and no dead code, then `cargo test --release`. Expected: PASS.
- [ ] **Step 2:** Add the two flags. They apply only with `--screenshot`, like the existing fake flags, and their help goes in `USAGE`.
- [ ] **Step 3: Screenshots** with `cargo build --release`, then `target/release/protondrive-gui --screenshot …`, in light and dark at `--size 840x540` and `1440x900`:
  - `--tab home` (healthy);
  - `--tab home --fake-attention 3 --fake-transfers 7`;
  - `--tab home --fake-attention 50`;
  - `--tab home --files-missing`;
  - `--tab home --drive-status ejected`;
  - `--tab activity`;
  - `--tab settings`.

  Check each image: nothing overflows, long names elide, the 50-conflict list scrolls, and the drive card is visible.
- [ ] **Step 4:** Update `README.md` wherever it describes the app's tabs or My files.
- [ ] **Step 5:** Commit `feat(gui): remove the file browser; screenshot flags for Home (Refs #191)`.
