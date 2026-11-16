# Storage on Home, the drive's free space, and keeping Always keep files

Issues: #294, #295, #296. Asked for by the user on 2026-11-15 with three screenshots. The proposals were discussed in the
conversation, and the user chose option B for the drive's free space ("go with B").

## Why

- **Storage on Home:** since #276, Proton storage shows only in the sidebar's small meter. Home is the status page, and
  that's where people look for used and free space.
- **Free space in Disk Usage:** GNOME draws the drive's bar from Available, which the drive caps at this computer's free
  space. So a nearly empty 510 GB account looks 81% full, unlike the other cloud drives listed next to it. Separately,
  nothing stops a copy into the drive from filling the system disk: writes land locally before they upload.
- **Free up space:** freeing the whole drive also removes every "Always keep on this device" mark the user set one by
  one, with no way to keep them.

## Goals and non-goals

- **Goals:**
  - Home shows used and free.
  - Disk Usage, df and Files see Proton's free space.
  - The system disk never fills through the drive.
  - The user chooses whether Free up space also frees Always keep files. Keeping them is the default.
- **Non-goals:**
  - Uploading while a copy runs, so that a big copy fits (option C).
  - Guarding downloads the daemon makes into the store when a file is opened. That is a separate issue.
  - Changing Free up space on one folder from Files.

## Approaches (decided)

1. **Storage on Home:** a row on the "Your drive" card. The sidebar meter stays.
2. **The drive's free space (option B, the user's choice):**
   - The drive reports Proton's free space as Available.
   - A guard refuses any write that would leave the system disk under a reserve.
   - Rejected:
     - A: today's cap, with its misleading bar.
     - C: B plus uploading and freeing during a copy. It's much larger.
3. **Keeping Always keep files:**
   - A checkbox in the dialog, unticked by default (keep them).
   - The daemon's free action takes an option, and a read-only route says whether any marks exist.
   - Rejected: always showing the checkbox, which is confusing when nothing is marked.

## How it works

### Home (#294)
- **The row:** below the drive's path, a "Proton storage" row with a bar and "3.0 GB used · 507.0 GB free of
  510.0 GB". The bar uses the card's colours.
- **Hover:** "Drive uses 2.4 GB of it; the rest is your other Proton apps".
- **Number format:** the same as everywhere else in the app (`format_bytes`).
- **When it's hidden:** with no quota (signed out, or an older daemon), the row isn't shown.

### The virtual drive (#295, `native-vfs`)
- **statfs:**
  - total is Proton's quota;
  - free and available are both Proton's free space;
  - used is therefore what the account uses.
  - Until the quota is known, statfs reports the local disk's own numbers, as today.
- **The guard:**
  - A write that makes a file grow is refused with ENOSPC ("No space left on device") when the system disk would be
    left with less than **5 GB** available. This covers writes through the drive and file growth by `setattr` size,
    `fallocate`, and `copy_file_range` where implemented.
  - A write that doesn't grow a file (an overwrite in place) is never refused.
  - The disk's free space is read with statvfs on the backing store. The reading is cached briefly so that writes stay
    fast, but never long enough to overshoot by more than the reserve.
- **What the user sees:**
  - Files now lets a copy start that doesn't fit this computer.
  - The copy stops partway with "No space left on device", and the system disk keeps at least 5 GB free.
  - A partly copied file may be uploaded as it is, like any interrupted copy. Nothing that existed before is touched.

### Free up space (#296)
- **Daemon:**
  - `POST /availability {path, action: "free", keepPinned?: boolean}`. With `keepPinned: true`, the item is still set to
    online-only. Items marked Always keep below it keep their marks, and their files stay. Without it, the action works
    exactly as today.
  - New read-only route on the control socket: `GET /availability/pinned` answers
    `{ items: number, wholeDrive: boolean }`. `items` counts the items marked Always keep below the top level.
    `wholeDrive` says whether the top level itself is marked.
  - Files that aren't safely in Proton Drive are never freed, either way (unchanged).
- **App:**
  - **Opening the dialog:** Home's Free up space… reads `/availability/pinned` off the UI thread.
  - **The checkbox:** when `items > 0` and not `wholeDrive`, the dialog shows "Also free files marked Always keep on this
    device", unticked.
  - **The dialog text:**
    - unticked: "Files marked Always keep stay on this computer";
    - ticked: today's sentence that they stop being kept.
  - **What it sends:** confirming sends `keepPinned: !ticked`.
  - **No checkbox:** with no marked items, or the whole drive marked, the dialog is as today.
  - **If the read fails:** the dialog opens without the checkbox and keeps Always keep files. That's the safe default.

## Constraints
- **Tests:** test first, in each layer.
  - **Daemon:** `bun test tests` and `bunx tsc --noEmit`.
  - **App and helper:** `cargo test --release` and `cargo clippy --release --all-targets`, with no warnings.
- **Data safety (CLAUDE.md):**
  - Freeing never removes a file that isn't safely in Proton Drive.
  - The guard never refuses an overwrite that doesn't grow a file.
  - The guard never touches existing data.
- **One issue, one branch, one PR, each.**

## Left to the builder
- How long the free-space reading is cached.
- The exact wording of the hover and the checkbox hint, within what's quoted here.
