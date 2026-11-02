# Files On-Demand, Stage 4 (hardening) Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking. Work task by task; each task ends green and committed.

**Goal:** Stop tools nobody listed from silently downloading the drive, and let the user block them:
- tell the user when one app downloads many online-only files, with a **Block this app** button;
- keep a user blocklist that the drive enforces;
- show it, and change it, in the app's Settings.

Also make the desktop Trash show an item's drive path as its original location (#40).

**Spec:** `docs/superpowers/specs/2026-10-23-files-on-demand-design.md`, delivery step 4 of §6 (§5.3 "Who triggers a download" and "Mass downloads by one app"). Builds on Stage 3 (#52).

**Tracking issue:** #55.

**Out of scope:** measuring the built-in background-reader list on real GNOME 50 Files. That needs the real desktop, so it is in Task 7's checklist, and anything it finds gets its own issue.

## Global Constraints

- **Who an app is.** It is the process's `comm` (the kernel's 15-byte name), as the helper already reads it for the built-in list (`process_comm`). The helper sends it as `opener` with each `/vfs/hydrate`. A request without one (an older helper) counts as an unknown app, which is never blocked and never counted.
- **The blocklist** is the setting `blockedApps`: a list of names, compared exactly.
  - At most 100 names. Each is 1 to 15 characters, with no `/`, control characters or leading/trailing spaces.
  - It is set through `POST /drive/settings` on the control socket only, never the TCP API. It reads back in `settings` like the others.
- **A blocked app's open of an online-only file** fails with `EACCES` and downloads nothing.
  - No notification, and the helper doesn't log it, so a blocked `rg` over a big folder can't flood the journal.
  - Its opens of downloaded files are unaffected, since those never reach the daemon.
- **The mass-download notice:**
  - It counts real downloads only: a hydrate that finds the file already here counts nothing.
  - More than **20** downloads by one app within **60 s** notifies, at most once per app per **10 minutes**.
  - Files (`nautilus`) is exempt, since copying out of the drive in Files is the user's own action.
  - Title: `<app> is downloading many files from Proton Drive`. Body: `It has downloaded <n> files in the last minute.`
  - Button `Block this app`, which adds `<app>` to `blockedApps` and confirms with `<app> is blocked` / `It can't download files from Proton Drive any more. Unblock it in Settings.`
  - Without action support in `notify-send` (it exits non-zero on `--action`), the notice goes out without the button, and the body adds `You can block it in Proton Drive's Settings.`
  - It obeys `notificationsEnabled`.
- **Settings copy:**
  - section `Apps blocked from downloading`;
  - help `These apps can't download online-only files. Files they already have on this computer still open.`;
  - a row per app with `Unblock`;
  - a name field with `Block`;
  - empty state `No apps are blocked.`
- **Trash (#40).** In the virtual layout, local-only content moved to the desktop Trash is recorded with its path under the mount (`syncDir`), not under the store.
  - The engine moves it into `$XDG_DATA_HOME/Trash` itself, per the freedesktop.org Trash spec: reserve `info/<name>.trashinfo` with `O_EXCL`, then `rename` into `files/<name>`.
  - If that rename fails with `EXDEV` (the store is on another disk from the home Trash), it falls back to `gio trash` with today's behaviour.
  - Plain layout: unchanged (`gio trash`).
- **Checks:** as in `CLAUDE.md`.
- **Commits:** conventional style, `Refs #55`. Work on a local branch `files-on-demand-stage-4` from `main-epgufb`; at the end, merge it with `--no-ff` and push `main-epgufb`.

## Review Focus

1. **`rg` over an online-only folder of 50 files.**
   - Expected: the notice after the 21st download; Block stops further downloads at once; nothing is logged per refused file.
   - Pinned in **Tasks 1–3**.
2. **The blocklist can only grow from a user's action:** the notification button, or Settings. Never from the TCP API.
   - Pinned in **Task 2**.
3. **Restoring from the desktop Trash after #16 in the virtual layout.**
   - Expected: Files shows `~/ProtonDrive/...` as the original location; Restore puts the item back in the drive, where it uploads.
   - Pinned in **Task 5**.

---

### Task 0: Branch

- [ ] **Step 1:** `git switch -c files-on-demand-stage-4 main-epgufb`.

### Task 1: The helper says who opened a file

**Files:** `native-vfs/src/daemon.rs`, `native-vfs/src/fs.rs`.

- `DaemonClient::hydrate(rel, opener, interrupted)` sends `{ path, opener }`, with the opener's process `comm`. Every caller passes the opener of the request that caused it.
- A refusal whose message starts with `Blocked:` is answered `EACCES` with no log line.
- **Tests:**
  - The body carries `opener`.
  - A `Blocked:` refusal gives `EACCES` and no log line.
- **Commit:** `feat(vfs): tell the daemon which app opened a file it downloads`.

### Task 2: The blocklist

**Files:** `src/sync/syncStateDb.ts`, `src/sync/settingsRules.ts`, `src/daemon/settingsValidation.ts`, `src/daemon/controlServer.ts`, `src/sync/syncEngine.ts`.

- `SyncSettings.blockedApps: string[]`, stored as JSON. A stored value that is unusable reads as `[]`, with a warning.
- `parseSettings` accepts and checks `blockedApps`. `/drive/settings` takes it; the TCP API's settings route keeps refusing writes.
- `hydrate(relPath, { opener })`: a blocked opener is refused before anything else with `DriveOpError('EACCES', 'Blocked: <app>')`, and nothing is notified.
- **Tests:**
  - validation (count, length, characters);
  - a round trip through `/drive/settings`;
  - a blocked hydrate downloads nothing and notifies nothing;
  - an unblocked one works;
  - a missing opener is never blocked.
- **Commit:** `feat(sync): a blocklist of apps that can't download online-only files`.

### Task 3: The mass-download notice

**Files:** create `src/sync/downloadWatch.ts`; modify `src/linux/notifications.ts`, `src/sync/syncEngine.ts`.

- `DownloadWatch.record(app, now)` returns the count to notify about, or `null`, by the rules above. It is pure, with an injected clock.
- `sendActionNotification({ title, body, actions, enabled })` resolves the chosen action key, or `null`. It uses `notify-send --wait --action=<key>=<label>`, killed after 30 minutes. It resolves `'unsupported'` when `notify-send` exits non-zero at once.
- The engine records each real download by its opener. When the watch says so, it notifies; on `block` it adds the app to `blockedApps` and confirms.
- **Tests:**
  - `DownloadWatch`: the threshold, the window, the 10-minute quiet, the Files exemption, unknown apps.
  - Engine: 21 downloads by `rg` give one notice; a `block` answer blocks `rg`; already-local files don't count.
  - `sendActionNotification` with a fake `notify-send` script on `PATH`.
- **Commit:** `feat(sync): tell the user when one app downloads many files, with Block this app`.

### Task 4: Settings in the app

**Files:** `native-gui/src/main.rs`.

- `Settings` gains `blocked_apps: Vec<String>` (default empty, so an older daemon still parses).
- The Settings page shows the section from Global Constraints.
- Unblock and Block send `POST /drive/settings { blockedApps }` at once, as the virtual-drive switch does, and show the daemon's error if it refuses.
- **Tests:** parsing with and without `blockedApps`; the request body for Block and Unblock (validation mirrored: trimmed, no duplicates).
- **Commit:** `feat(gui): list, block and unblock apps in Settings`.

### Task 5: The desktop Trash shows the drive path (#40)

**Files:** `src/sync/desktopTrash.ts`, `src/sync/syncEngine.ts`.

- `MoveToDesktopTrash` becomes `(fullPath, shownPath?) => Promise<boolean>`.
- New `homeTrash(trashDir)` implements the spec's move with `Path=<shownPath, URI-escaped>` and `DeletionDate`. It falls back to `gioTrash` on `EXDEV`.
- The engine passes `shownPath = path.join(syncDir, rel)` in the virtual layout.
- **Tests:**
  - `info` holds the shown path, escaped (space, `é`, `%`);
  - names that collide get `name.2`, `name.3`;
  - the info file is removed if the rename fails;
  - `EXDEV` falls back to `gio`;
  - the engine passes the mount path in the virtual layout and nothing extra in the plain one.
- **Commit:** `fix(sync): the desktop Trash shows the drive path of what it keeps` (`Fixes #40`).

### Task 6: Docs, review and merge

- [ ] README: the notice, the blocklist, and where to unblock.
- [ ] Review the branch against Review Focus; every problem found gets an issue (`CLAUDE.md`).
- [ ] All checks; merge `--no-ff` into `main-epgufb`; push; update #55.

### Task 7: Acceptance on the real desktop (the user)

1. `rg -l x ~/ProtonDrive/<online-only folder of 50+ files>`: the notice appears once; **Block this app** stops further downloads (`rg` reports permission denied); Settings lists `rg`; **Unblock** lets it download again.
2. The notification button works on this GNOME version (`notify-send --version` ≥ 0.7.10).
3. **Background readers (§5.3):**
   - Open a folder of 500 online-only images and videos in Files, grid view, thumbnails on; let desktop search run; open Properties on the folder.
   - Expected: the activity log shows no downloads.
   - Any comm that downloads goes in a new issue, with the fix to the built-in list.
4. **Trash:** in the virtual layout, delete a folder holding an ignored `node_modules` from the web app. The desktop Trash shows its original location under `~/ProtonDrive`, and Restore brings it back into the drive.
