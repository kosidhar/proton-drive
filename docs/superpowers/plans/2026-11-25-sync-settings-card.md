# Settings › Sync Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings' sync card applies each change at once, uses plain words, keeps the app's own ignore patterns out of
the user's reach, and asks before moving the drive folder.

**Architecture:** The daemon applies a built-in ignore list inside its one matcher (`matchesIgnorePatterns`), so every
caller gets it, and strips those entries from stored settings when they are read. The app's card sends one setting
per change through the existing `SaveSettings` worker command. It keeps a changed value until the daemon answers, and
routes the folder change through a new confirm dialog.

**Tech Stack:** Bun/TypeScript (`bun test`), Rust/egui (`cargo test`, the `Harness` in `native-gui/src/main.rs` tests).

**Spec:** `docs/superpowers/specs/2026-11-25-sync-settings-card-design.md` (issue #425)

## Global Constraints

- **Built-in ignore list, always applied:**
  - `BUILTIN_IGNORE_PATTERNS = ['.proton-drive-tmp-*', '*.part', '*.crdownload', '.DS_Store', '.Trash-*']`.
- **Defaults for a new install:**
  - `DEFAULT_IGNORE_PATTERNS = ['.git', '.git/**', 'node_modules', 'node_modules/**', '*~']`.
- **Card copy, verbatim:**
  - title `Sync`, with no subtitle;
  - `Proton Drive folder` with a `Move…` button;
  - `Desktop notifications`;
  - `Start Proton Drive when I log in` (unchanged);
  - `When a file changes in both places`, with choices `Keep both copies` and `Ask me each time`;
  - `Files to ignore`, with the hint `One pattern per line, like *.log or build/`;
  - the confirm dialog: `Move your Proton Drive folder to <new path>? Your files will move there. Proton Drive pauses
    until the move is done.`, with buttons `Cancel` and `Move`;
  - the result note: `Saved`.
- **Gone:**
  - the `Save Preferences` button and the `These apply when you save` subtitle;
  - `No changes to save`;
  - the word `Ubuntu` anywhere in the card.
- **Data safety:**
  - nothing about what syncs changes for an existing install;
  - the folder only moves after the dialog's Move;
  - a failed save never leaves the card showing a value the daemon doesn't hold.
- **Repo rules:**
  - branch `feat/425-sync-settings-card` and conventional commits; the last one says `Fixes #425`;
  - no AI attribution;
  - never commit `.claude/`, `.superpowers/`, `target/` or `release/`;
  - every check in CLAUDE.md passes before the push.
- **Safety for implementers:**
  - run the app only via `--screenshot` (the stand-in daemon's `shoot.sh`);
  - never touch `~/.config/protondrive`, `~/.local` or the user's daemon.

## Review Focus

1. **A status refresh arriving while a change is in flight** (refreshes come every 1.5 s): the control keeps the user's
   new value until the daemon answers. It doesn't flicker back (Task 2).
2. **Two quick changes to the same switch:** the card ends on the last one, whatever order the answers arrive in
   (Task 2).
3. **A refused or failed save** (daemon unreachable, or an ignore pattern that would hide the whole drive):
   - a switch or a choice goes back to what the daemon holds, and says why;
   - the ignore box keeps the user's text with the reason, so it can be fixed (Task 2).
4. **An existing install whose stored list holds the old defaults, built-ins included:** after the change the same
   files are ignored, and the box shows only `.git`, `.git/**`, `node_modules`, `node_modules/**` and `*~` (Task 1).
5. **Move… to the same folder, or cancelled:** nothing is sent. A move the daemon refuses (`folderError`) shows its
   reason beside the folder row (Task 2).

---

### Task 1: The daemon always applies the built-in ignore patterns

**Files:**
- Modify: `src/sync/syncStateDb.ts` (`DEFAULT_IGNORE_PATTERNS` ~120, `storedIgnorePatterns` ~313/341)
- Modify: `src/sync/localWatcher.ts` (`matchesIgnorePatterns` ~28)
- Test: the existing tests for `matchesIgnorePatterns` and for the settings in `tests/` (find them with `git grep -ln "matchesIgnorePatterns\|DEFAULT_IGNORE_PATTERNS" tests`)

**Interfaces:**
- Produces: `export const BUILTIN_IGNORE_PATTERNS: readonly string[]` from `src/sync/syncStateDb.ts`, and
  `matchesIgnorePatterns(relPath, patterns)` with the same signature. It matches if `relPath` matches `patterns` or
  `BUILTIN_IGNORE_PATTERNS`. `getSettings().ignorePatterns` is the user's list only.

- [ ] **Step 1: Write the failing tests**

```ts
test('the built-in patterns apply even when the user list is empty', () => {
  for (const p of ['a/.proton-drive-tmp-x', 'a/b.part', 'c.crdownload', 'd/.DS_Store', '.Trash-1000/x']) {
    expect(matchesIgnorePatterns(p, [])).toBe(true);
  }
  expect(matchesIgnorePatterns('notes.txt', [])).toBe(false);
});
test('a new install starts with the editable defaults only', () => {
  // fresh SyncStateDatabase → getSettings().ignorePatterns equals ['.git','.git/**','node_modules','node_modules/**','*~']
});
test('a stored list with the old defaults reads without the built-ins, and ignores the same files', () => { // Review Focus 4
  // store the OLD 10-entry default list directly (as an existing install has it), then getSettings().ignorePatterns is
  // ['.git','.git/**','node_modules','node_modules/**','*~']; and for a sample of paths (incl. every built-in's example
  // and '.git/config', 'x/node_modules/y', 'a~', 'keep.txt'), matchesIgnorePatterns(path, new) === matchesIgnorePatterns(path, OLD)
});
test("the user's own patterns are kept as typed, in order", () => { /* ['*.log', 'build/'] round-trips */ });
```

- [ ] **Step 2: Run them and see them fail.** Run `bun test <those test files>`. Expected: FAIL, because
  `BUILTIN_IGNORE_PATTERNS` isn't defined and the defaults are the old list.

- [ ] **Step 3: Implement.**
  - Export `BUILTIN_IGNORE_PATTERNS`, and change `DEFAULT_IGNORE_PATTERNS` (values in Global Constraints).
  - `matchesIgnorePatterns` also checks the built-ins. Keep its existing matching rules.
  - Reading stored settings drops entries exactly equal to a built-in.
  - Validation in `settingsRules.ts` stays on the user's list.
  - Comments say why the built-ins aren't settings: the app's own temporary files must never sync.

- [ ] **Step 4: Run the checks.** Run `bun test tests` and `bunx tsc --noEmit`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncStateDb.ts src/sync/localWatcher.ts tests
git commit -m "feat(sync): the app's own ignore patterns always apply and are no longer settings

Refs #425"
```

### Task 2: The card applies each change at once, in plain words, and asks before moving the folder

**Files:**
- Modify:
  - `native-gui/src/main.rs`:
    - `render_sync_settings_card` ~3252;
    - `save_preferences` ~3227 and `mark_settings_edited`;
    - `settings_changes` ~870;
    - the Browse handling ~3378;
    - `PendingConfirm` ~990, with its copy ~1097 and its handling in `render_confirm_modal`;
    - the worker's reply to `SaveSettings`.
  - `native-gui/src/settings.rs`, if a helper changes.
- Test: the `main.rs` tests, beside the existing Settings tests. `git grep -n "Save Preferences\|edit_sync_dir" native-gui/src/main.rs` finds the tests to update.

**Interfaces:**
- Consumes: Task 1's user-only `ignorePatterns`, in the status the app already reads.
- Produces:
  - `PendingConfirm::MoveFolder { to: String }`;
  - one helper that sends a single setting: `fn apply_setting(&mut self, key: &'static str, value: serde_json::Value)`.
    It sends `WorkerCommand::SaveSettings` with just that key, and marks the key pending until the reply.

- [ ] **Step 1: Write the failing tests.** All of them go through the `Harness`, and every one asserts what was sent
  with `sent()`.

```rust
// each control sends only its own field, at once; no Save Preferences, no "Ubuntu"
fn sync_card_switches_and_choice_apply_at_once()
// Desktop notifications → SaveSettings {"notificationsEnabled": false}; the When-a-file-changes picker → {"conflictStrategy": "prompt"};
// text "Save Preferences", "These apply when you save" and "Ubuntu" are absent; title "Sync" present; "Saved" shows after a good reply

fn files_to_ignore_applies_when_the_box_loses_focus_and_only_if_changed()
// typing sends nothing; Tab out → {"ignorePatterns": ["*.log"]}; Tab in and out unchanged → nothing more

fn a_refresh_during_a_save_keeps_the_new_value()                              // Review Focus 1
// flip notifications off; deliver a status with notificationsEnabled=true before the reply; the switch still shows off;
// then the reply (ok) arrives → off; a later status → off

fn two_quick_changes_end_on_the_last()                                      // Review Focus 2
fn a_failed_save_goes_back_and_says_why()                                    // Review Focus 3
// switch: error reply → switch shows the daemon's value + the reason beside it;
// ignore box: refused pattern (e.g. "*") → text kept, reason shown

fn move_asks_first_and_moves_only_on_move()                                 // Review Focus 5
// choosing /mnt/b/ProtonDrive opens the dialog with the verbatim question and that path; Cancel → nothing sent;
// Move → {"syncDir": "/mnt/b/ProtonDrive"}; choosing the current folder → no dialog, nothing sent;
// a reply with folderError → its reason beside the folder row
```

- [ ] **Step 2: Run them and see them fail.** Run `cd native-gui && timeout 900 cargo test --release sync_card files_to_ignore a_refresh_during two_quick a_failed_save move_asks`. Expected: FAIL. (Name the tests so this filter matches.)

- [ ] **Step 3: Implement.**
  - **The card:** rewrite it per the spec's layout, with the copy verbatim.
  - **Instant changes:** each control calls `apply_setting`.
  - **Pending values:** a pending key's shown value is the user's, until its reply arrives. Status refreshes don't
    overwrite it. The newest send for a key wins.
  - **Replies:** a good reply shows `Saved` beside the control for about 3 s. A failed one restores the daemon's value
    for switches and the picker, keeps the text in the ignore box, and shows the reason.
  - **Move…:** it opens the existing folder picker. A different folder sets `pending_confirm = MoveFolder { to }`, and
    the dialog's Move calls `apply_setting("syncDir", …)`.
  - **Removed:** `save_preferences`, the dirty tracking and `No changes to save`. Remove `settings_changes` too if
    nothing else uses it.
  - **Other tests:** update the existing Settings tests that assumed Save Preferences.

- [ ] **Step 4: Run every check, and look at it.**
  - In `native-gui/`: `timeout 900 cargo test --release` and `cargo clippy --release --all-targets` (0 warnings).
  - At the repo root: `bun test tests` and `bunx tsc --noEmit`.
  - Screenshots, light and dark at 1180×940, using
    `/tmp/claude-1000/-home-gautam-chauhan-projects-proton-drive/83ab53f0-fea2-45b0-a976-56dd433d1865/scratchpad/fakedaemon/shoot.sh <png> <theme> 1180x940 normal --tab settings`.
    Scroll to the Sync card if needed: an existing screenshot flag may help, otherwise a larger `--size`.

- [ ] **Step 5: Commit.** This commit also adds the spec and this plan.

```bash
git add native-gui/src docs/superpowers/specs/2026-11-25-sync-settings-card-design.md docs/superpowers/plans/2026-11-25-sync-settings-card.md
git commit -m "feat(gui): the Sync card applies each change at once, in plain words, and asks before moving the folder

Fixes #425"
```
