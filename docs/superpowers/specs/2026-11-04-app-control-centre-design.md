# The Proton Drive app as a status and control centre

Tracking issue: #191. Agreed with the user on 2026-11-04 ("looks good" to the proposal below).

## Why

Since the virtual drive (Stage 2), the whole of My files is in Files at `~/ProtonDrive`, with emblems and a right-click
menu (Stage 3). The app's own file browser (My files) now duplicates Files, and does it worse. Meanwhile the app
answers the questions it is opened for badly. Its status is engine jargon ("Listing /my-files/deployment"), storage
is shown three times, conflicts have a tab of their own that is almost always empty, and there's no way to see at a
glance what is happening or what needs the user.

The app becomes the place to check on sync and change how it behaves. Files is where you browse and act on files.

## Goals

- **Answer three questions:** Is everything OK? What's happening? How do I change how it behaves?
- **Plain language everywhere:** no internal paths, no engine terms.
- **Show each fact once:** storage, the drive's location and the account each appear in one place.
- **Show problems only when there is one, with the action that fixes it next to it.**

## Non-goals

- **Browsing, opening or acting on individual files in the app.** Files does that. No "Keep all", "Free up all",
  "New folder" or "Refresh" on a listing.
- **A redesign of the tray** beyond what Stage 4 wires up (#98 has the rest).
- **Changes to how sync works,** except the few daemon additions in Stage 4.

## Anti-goals (a failure even if it works)

- **Losing any control the app has today without an equivalent:**
  - sign in and out;
  - the virtual drive switch and its confirmations;
  - moving the sync folder, with its stopped-move recovery;
  - blocked apps, ignore patterns, notifications, theme;
  - files-missing resolution;
  - conflict resolution;
  - mount again.
- **A screen that looks busy when all is well.** The healthy state is calm: one status line, the drive card, nothing else.
- **Any data-safety regression.** Every action the app sends still goes through the same control-socket routes with the
  same confirmations.

## Structure

A left sidebar with three sections and nothing duplicated. The top bar goes; its search moves to Activity, its Pause to
Home, and the gear and account block to Settings.

```
┌──────────────┬──────────────────────────────────────────────┐
│ Proton Drive │  ● Up to date                    Pause  ▾    │
│              │  Last synced 2 min ago        [Sync now]     │
│ ◉ Home       │──────────────────────────────────────────────│
│ ○ Activity   │  NEEDS ATTENTION  (only when needed)         │
│ ○ Settings   │  ⚠ Changed here and in Proton Drive:         │
│              │    report.pdf  [Show] [Keep Both]…           │
│              │  ⚠ notes.txt couldn't upload     [Retry]     │
│              │──────────────────────────────────────────────│
│              │  IN PROGRESS                                 │
│              │  ↑ video.mp4      ████████░░  64%            │
│              │  ↓ 3 more files waiting                      │
│              │──────────────────────────────────────────────│
│              │  YOUR DRIVE      ~/ProtonDrive · mounted     │
│              │  [Open in Files]                             │
│              │  Proton storage  ▓░░░░░░░  13.6 of 510 GB    │
│              │  On this computer  169 MB  [Free up space…]  │
│ GC Gautam    │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- **Sidebar footer:** the account's initials and name, which open Settings › Account, plus the app version. Nothing else:
  storage is on Home.
- **Default window size:** about 900×640. Keep the minimum at 840×540.
- **The sidebar shows a badge** on Home when something needs attention.
- **Signed out:** Home says "Signed out" and offers Sign in (the same action as Settings › Account) in place of Pause
  and Sync now.

### Home (the default section)

1. **Status line,** in plain words, from the status the daemon already sends (`state`, `currentAction`, `activeTransfers`,
   `settings.paused`, `lastError`, `stats`, `vfs`, `filesMissing`). Examples:
   - "Up to date", with "Last synced 2 min ago" under it;
   - "Uploading 3 files", "Downloading report.pdf", "Checking for changes…";
   - "Paused" (Stage 4: "Paused until 15:00");
   - "Offline: can't reach Proton Drive" ("Connecting…" while the app's first try is still out), "1 problem needs you";
   - "Signed out", with a Sign in button in place of Pause and Sync now; "Moving files…" while the drive moves them;
     "Sync stopped" for an error the daemon gave no message for.

   The mapping is a pure function with unit tests. `currentAction` text is never shown raw.
2. **Pause and Sync now.** Pause/Resume is the main button. Stage 4 turns it into a dropdown: for 1 hour, until
   tomorrow, until I resume. "Sync now" is secondary.
3. **Needs attention:** a list shown only when non-empty. It replaces the Conflicts tab and the scattered notices:
   - **Unresolved conflicts:** say what happened ("Changed here and in Proton Drive: report.pdf", the full path on
     hover), with "Show in Files" and the existing resolve actions. Unresolved conflicts only exist under the "ask me"
     strategy, where the daemon queued the file and kept nothing twice. Keep Both is the main choice; each button's hover
     text says what it replaces (Keep Local: "Use this computer's version: replaces the one in Proton Drive"; Keep
     Remote: "Use the Proton Drive version: replaces the one on this computer"). Resolving goes through the same
     control-socket route as today.
   - **Files missing from the folder:** the existing flow and dialog, moved here.
   - **The drive not mounted:** the reason, with "Mount again" when the daemon offers it. The existing drive-card logic moves
     here.
   - **A stopped move of the sync folder:** the existing recovery actions.
   - **Files that couldn't sync,** with Retry. These are Stage 4; until then, a single line "N files couldn't sync" from
     `stats.errorItems`.
   - **The last error** (`lastError`), when there is one.
4. **In progress:** live uploads and downloads from `activeTransfers`, with progress bars (the existing
   `render_transfer_line`), at most 5 shown and then "N more". Hidden when there are none.
5. **Your drive card:**
   - the location (`~/ProtonDrive`) and whether it is mounted, as a virtual drive or a plain folder;
   - "Open in Files";
   - Proton storage, shown once and labelled (account usage of quota, with Drive's share in its tooltip);
   - "On this computer: 169 MB", with "Free up space…". That button frees everything (the existing FreeAll
     confirmation for the drive's top), the only bulk action left in the app.

### Activity

The existing activity list, made readable. Stage 2:
- **Labels:** "Freed up space" for frees, never "Removed locally"; plain verbs for the rest.
- **Details:** shown in full on hover or in an expanded row, never cut off.
- **Filter:** All, Uploads, Downloads, Freed, Problems.
- **Click a row** to show the item in Files. A path that no longer exists does nothing, quietly.
- **Search:** filters the list. It moves here from the top bar.

In Stage 1 the list moves here as it is.

### Settings

Grouped into sections (Stage 3), with the same controls and routes as today:
- **General:** notifications, theme. Stage 4 adds start at login (#92).
- **Drive:** the sync folder's location (and the move flow), "Show online-only files in Files" (the virtual drive
  switch, with its confirmation), apps blocked from downloading.
- **Sync:** ignore patterns. The conflict strategy control is removed once #91 lands; until then it stays here unchanged.
- **Account:** name, email, plan, storage, Sign out. These move here from the account popover.
- **About & help** (#96): app, daemon and helper versions (with a warning when they differ), "Open logs folder",
  "Copy diagnostics" (no file names or email), "Report a problem" (the project's issues page).

In Stage 1 the existing settings cards move here as they are, plus an Account section holding what the popover held.

## Removed

- **The My files browser:** `render_browser_tab`, `render_browser_toolbar`, breadcrumbs, the row menu, the
  remote-listing worker commands it alone uses, and its screenshot flags (`--path`, `--row-menu`, `--confirm-hide`,
  `--confirm-keep-all`, `--remote-fixture`, `--working`), with the Hide and KeepAll confirmations if nothing else uses
  them. Hide stays available in Files.
- **The top bar:** search, status pill, Pause, gear, account block. The account popover goes too.
- **The Conflicts tab,** folded into Needs attention.
- **The sidebar's "Open ~/ProtonDrive folder" button and storage footer,** which are on Home now.
- **The "My files 4/17" badge.**

## Daemon additions (Stage 4)

- **Pause until:** `POST /api/pause` (or a control-socket route) takes an optional `until` (epoch ms). The engine resumes by
  itself at that time, and the time survives a daemon restart (stored in settings or meta). The status carries `pausedUntil`.
- **Files that couldn't sync:** a read route listing items whose record is in error, with their message, for Needs attention.
- **Retry:** a control-socket route that clears an item's backoff (#18's per-item failure) and asks for a pass.
- **Start at login:** as #92 describes.
- **The tray (#98):** its Pause gets the same choices, and it gets a "N problems need you" item that opens the app on
  Home.

## Constraints

- **Stack:** the same egui app in `native-gui/src/main.rs`. Splitting new screens into modules (`home.rs`,
  `activity.rs`, `settings.rs`) is the builder's call and is welcome; `main.rs` is 7,600 lines.
- **Unchanged:** every existing control-socket route and confirmation. No new route on the TCP API that changes anything
  (see `tcpRefusals.ts`).
- **Screenshots:** the `--screenshot` flow keeps working for every new state. `--tab` takes `home | activity | settings`;
  the old names map to the nearest new section. New screenshot-only flags as needed for states (for example a fake
  attention list), following the existing pattern (`SCREENSHOT_MODE` reads only).
- **Checks:** `cargo test` and `cargo clippy --all-targets` with no warnings in `native-gui`, plus the repo's other checks
  when the daemon changes. Screenshots in light and dark at 840×540 and 1440×900 in each stage's PR.

## Left to the builder

- **Visual details within the app's existing style:** colours, spacing, pill styles, icons.
- **Exact wording,** within "plain words, no engine terms".
- **Module layout.**
- **How the status mapping words edge cases** (for example several transfers in both directions).
