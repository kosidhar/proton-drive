# Settings › Sync card: plain words, instant changes, a confirmed folder move (short design)

**Why:** the owner asked whether Settings' "Synchronization Settings" card makes sense. It doesn't quite:
- It is the only card that waits for **Save Preferences**. Every other setting applies at once, so a flipped switch is
  easily lost.
- It says "Ubuntu" ("Enable Ubuntu desktop notifications") although the app runs on any Linux, and Ubuntu is
  Canonical's trademark.
- Its labels are engineer's words in Title Case.
- The ignore box lets people delete the app's own must-ignore names, such as `.proton-drive-tmp-*`.
- **Browse…** plus Save moves the whole drive with no confirmation.

The owner approved the proposal below on 2026-11-25.

## Approaches

- **Every control applies at once, and the folder gets a confirmed Move… (chosen).** This is how the rest of Settings
  works.
- Keep Save Preferences but mark unsaved changes: rejected. It's the only card working this way, and a forgotten Save
  still loses changes.
- Move the whole card into an "Advanced" page: rejected. Notifications and start at login are everyday settings.

## The card

```
 Sync
 Desktop notifications                                              (●)
 Start Proton Drive when I log in  ⓘ                                (●)
 When a file changes in both places   [ Keep both copies          ▾ ]
 Files to ignore  ⓘ      ┌──────────────────────────────┐
 One pattern per line,   │ .git                         │
 like *.log or build/    │ node_modules                 │
                         └──────────────────────────────┘
```

- **Title:** "Sync", with no subtitle. It's in sentence case, like "Account", "Appearance" and "Drive".
- **Desktop notifications** (was "Enable Ubuntu desktop notifications"): it applies at once.
- **Start Proton Drive when I log in:** unchanged words. It applies at once.
- **When a file changes in both places** (was "Conflict Resolution Strategy"): the choices are **Keep both copies**
  (the other copy gets the time in its name) and **Ask me each time** (in Home's Needs attention). It applies at once.
- **Files to ignore** (was "Ignore Patterns (Glob)"):
  - It shows only the user's own patterns, and its hint reads "One pattern per line, like *.log or build/".
  - It applies when the box loses focus (Tab or clicking elsewhere), and only if the text changed. It doesn't apply on
    every keystroke.
- **Proton Drive folder:** not in this card (#427). The folder shows once, on the Drive card's Location row, with
  **Move…** there (was Browse…, applied by Save).
  - Move… opens the folder picker.
  - Choosing a different folder opens a confirmation in the app's existing dialog style: "Move your Proton Drive
    folder to <new path>? Your files will move there. Proton Drive pauses until the move is done."
  - It then sends `syncDir` as Save does today.
  - Choosing the same folder, or cancelling, does nothing.
- **Save Preferences goes**, along with "These apply when you save", the dirty-form tracking, and "No changes to save".
- **Feedback:** each change shows the result next to its control, briefly: "Saved", or why it couldn't be saved. On
  failure the control goes back to what the daemon holds.

## Ignore patterns: built-in versus yours

- The daemon always applies a built-in list, whatever the settings say: the app's temporary files and other files
  that should never sync.
  - `BUILTIN_IGNORE_PATTERNS = ['.proton-drive-tmp-*', '*.part', '*.crdownload', '.DS_Store', '.Trash-*']`
- `DEFAULT_IGNORE_PATTERNS`, the editable defaults a new install starts with, becomes
  `['.git', '.git/**', 'node_modules', 'node_modules/**', '*~']`.
- Stored settings that still list built-in entries (every existing install) drop them when read. Since the built-ins
  are always applied, nothing about what syncs changes. The stored list is the user's list from then on.
- Saving `ignorePatterns` stores only the user's patterns. A built-in pattern typed by the user is accepted, and it is
  harmless since it's applied anyway.

## Not in scope

The Hidden, Appearance, Account and Drive cards; what the conflict choices do; how the folder move itself works.

## Left to the builder

How the instant saves reuse the existing `SaveSettings` worker command (one field per change); and how long the
"Saved" note stays, a few seconds.
