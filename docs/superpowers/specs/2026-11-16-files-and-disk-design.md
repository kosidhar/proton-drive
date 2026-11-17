# Files and disk: upload on close, cut-short files, a full disk said plainly, opens that would fill the disk

Issues: #64, #300, #299, #301, #302. The user asked on 2026-11-16 to work through the open issues, chose this group
first ("yes please"), and chose how a cut-short file is handled (option A, "I'll go with your suggestion"). The build
choices below (how the drive tells the daemon, where cut-short files are kept) were left to me and are marked as mine.

## Why

- **Half a file uploads (#64).** The daemon learns of a change only by watching the local store (`node:fs` watch, no
  close events). It uploads a changed file once it has stayed the same for 2 s, waiting longer each time it changes
  again, up to 16 s, and uploads anyway after 2 minutes of changes (#51, `stillBeingWritten` in `syncEngine.ts`). A
  copy that stalls for longer than the wait uploads a partial file first, and again when it finishes. A copy over an
  existing file truncates it first: if it stalls right then, an empty version can upload.
- **A cut-short copy replaces the cloud version (#300).** A copy into the drive that stops early leaves the file cut
  short, and it uploads as the new version. When the cause is the drive's own disk guard (#295: writes that would leave
  the system disk under 5 GB are refused with ENOSPC), the drive knows the file is incomplete.
- **Saves fail with no explanation (#299).** Files and Disk Usage show hundreds of GB free on the drive (Proton's
  space), while the guard refuses writes because the computer's own disk is nearly full.
- **Opening a large online-only file can fill the disk (#301).** That download is made by the daemon, outside the
  drive's write path, so the guard doesn't cover it.
- **A test underflows (#302).** A mount test computes `max − used` without saturating.

## Goals, non-goals, anti-goals

- **Goals:**
  - A file being replaced through the drive (a copy over it, a save, a new file) uploads when the last app writing it
    closes it, and never while it is open. A file edited in place while held open (a log, a database) keeps today's
    rule: it uploads once it has kept changing for 2 minutes, then at most that often.
  - A file the guard cut short is not uploaded until the user decides. The version in Proton Drive stays as it was.
  - When the guard refuses writes, Home and the tray say why, in plain words.
  - Opening an online-only file that wouldn't fit refuses the open with "No space left on device" instead of filling
    the disk, and is explained the same way.
  - The mount tests don't fail for the wrong reason on a nearly full disk.
- **Non-goals:**
  - The plain layout (no drive helper). Its uploads keep today's settle rule.
  - A copy cancelled by the user (Ctrl-C) or killed: the drive can't tell it from a deliberate shorter save. Proton
    Drive keeps the earlier version in its history.
  - Downloads the sync makes on its own (Always keep items, the whole drive kept): a separate issue, to file.
  - Uploading while a copy runs so that a big copy fits (#295's option C).
- **Anti-goals** (failure even if it technically works):
  - Anything that replaces or trashes a cloud item the user didn't change (CLAUDE.md data safety).
  - Closing a file, or any drive call, waiting on the daemon.
  - A cut-short file uploading after a daemon restart because the hold was only in memory.
  - A file held forever after it was later written completely.

## Approaches

1. **How the drive tells the daemon about writes** (my call):
   - **Chosen:** the helper (native-vfs) posts to the daemon over the control socket it already uses (`/vfs/*`):
     "open for writing" when an app opens a file to write, and "closed" when the last writing handle closes, saying
     whether any write to it was refused. The posts go out from a background worker.
   - **Rejected:** the daemon asking the helper (the helper has no server); inotify close events on the store (the
     daemon's watcher, `node:fs` watch, doesn't expose them).
2. **What happens to a file the guard cut short** (the user's choice, A):
   - **Chosen (A):** hold it and ask. It isn't uploaded; Home offers **Upload this version** or **Put back the Proton
     Drive version** (keeping the cut-short file beside it as a copy).
   - **Rejected:** B, upload anyway and note it in Activity (the earlier version only in Proton's history); C, put back
     the Proton Drive version automatically.
3. **Where a cut-short file is kept** (my call):
   - **Chosen:** a new table in the sync database, read before any upload, so a hold survives a restart.
   - **Rejected:** a kind of conflict. The tray, status and Activity would call it a conflict, and a conflict needs a
     cloud item, which a brand-new file doesn't have.

## How it works

### #302: the mount tests' size check
- The test's arithmetic saturates (`saturating_sub`).
- A test that needs more room than the disk has is skipped with a message, not failed.

### #64: upload on the last close (helper and daemon)
- **The helper:**
  - Counts, per file, the handles open for writing (opened or created with write access, or a deferred open being
    written).
  - **A replacing session (my call):** a file's writing session "replaces" it if it was created in it, opened with
    `O_TRUNC`, or truncated to 0 through it. Copies and most saves do that; a log or a database edited in place
    doesn't.
  - **First writing handle:** posts `POST /vfs/writing {path, replacing}`. It posts it again (`replacing: true`) the
    moment a session turns replacing (a truncate to 0 after the open).
  - **While a replacing session stays open:** it repeats the post every 30 s as a keepalive (my call).
  - **Last writing handle closed:** posts `POST /vfs/closed {path, refused, replaced}`.
    - `refused` says whether the guard refused any write or growth by `setattr` size to this file during the session.
      The helper doesn't implement `fallocate` or `copy_file_range`.
    - `replaced` says whether the session replaced the file.
  - **Sending:** the posts go to a single background sender thread through a queue; `release` never waits. Other posts
    are best effort: a full queue drops the oldest, and a failed post isn't retried. A `closed` post with
    `refused: true` is never dropped, though: it's retried in order until the daemon accepts it, for as long as the
    helper runs (my call; see #300).
  - **A rename of a file open for writing:** the `closed` post names the path the file has when it closes.
- **The daemon:**
  - Keeps the set of paths open for writing through the drive, in memory, with whether each is replacing and when its
    last post came.
  - **`writing`:** adds the path or refreshes it.
  - **`closed`:** removes it. If the file changed, the daemon looks at it at once, as settled: no 2 s wait. With
    `refused: true`, see #300.
  - **A drive rename** of a path in the set moves its mark along, since the daemon handles drive renames itself.
  - **The settle rule:**
    - **A path with a replacing mark** is never uploaded while marked, however long the copy takes. No 2-minute
      exception: a copy that runs past 2 minutes and is then cut short must not have replaced the cloud version
      already (my call).
    - **A path marked but not replacing** keeps today's rule: it counts as still being written until it has kept
      changing for 2 minutes.
  - **Expiry:** a replacing mark not refreshed for 90 s is treated as gone, which covers a helper that died. When the
    helper (re)starts, the supervisor clears the set. After a daemon restart, the helper's keepalives rebuild the
    replacing marks within 30 s. In that gap, the settle rule applies (accepted).
  - **A post for a path the daemon doesn't know as written,** or that no longer exists, does nothing harmful: it is
    looked at like any change.
- **Unchanged:** the plain layout, and changes made straight in the store, keep the settle rule.

### #300: a file the guard cut short
- **The trigger:** `POST /vfs/closed {path, refused: true}` for a file whose content differs from what Proton Drive
  has.
- **Existing item or new file:** a path with a synced record, or with an edit baseline, is an existing item. The edit
  baseline covers the main case, a copy over an online-only file. A path with neither is a new file.
- **The record:** the daemon writes a row to a new table `cut_short_files`: `relPath` (primary key), `nodeUid` (null
  for a new file), the file's size and mtime when held, and `detectedAt`. It writes the row before answering the post.
- **What a row does:**
  - The file isn't uploaded while its row exists. Every path that would upload it checks the table: local-change
    handling, the sync pass, and conflict resolution's keep-local. (Replay only renames, moves and trashes; it never
    uploads.)
  - A drive rename carries a row from its source to its target, and drops a row at a target it replaces: that file's
    content is gone, replaced by the renamed one.
  - Free up space never frees it, since it isn't safely in Proton Drive (the existing rule).
- **Lifting the hold on its own:**
  - **A full rewrite:** a later `closed` post for the path with `refused: false` and `replaced: true`, for example the
    copy run again. An open that only reads, appends, or writes in place doesn't lift it (my call). The file then
    uploads as usual.
  - **The file gone:** deleted, or moved away through the drive; a move carries the row along.
  - **A cloud change to the item:** handled as Put back (below), so the cloud version is at the path and the cut-short
    file is kept as a held copy.
- **On Home, in Needs attention:**
  - **The words:** "**report.pdf** wasn't fully written: your computer's disk was nearly full." Then, for an existing
    item: "Proton Drive still has the version from before." For a new file: "It hasn't been uploaded."
  - **Upload this version:** removes the row and uploads the file as it is.
  - **Put back the Proton Drive version** (existing items only):
    - renames the cut-short file to a conflict-style copy name (the existing naming, with "not fully written" in place
      of "conflict"), and moves the row to the copy, which now counts as a held new file;
    - makes the path online-only again: the drive shows Proton Drive's version, and it downloads when opened. Nothing
      is downloaded now, on a disk that's nearly full;
    - uploads nothing (my call: unlike the conflict code's keep-both, which uploads its copy).
  - **A new file (or a copy Put back left)** has only **Upload it anyway**. Deleting it in Files also clears it.
  - **Many held files (my call):** a folder copy cut short by the guard can hold hundreds, since `cp -r` keeps creating
    files after the first refusal. With more than 3 held, Home shows one row: "**214 files** weren't fully written:
    your computer's disk was nearly full." It has **Upload all anyway**, **Put back all** (for the existing items among
    them), and **Show them**, which lists each with its own actions. Running the copy again lifts each hold as its file
    is rewritten.
- **Daemon routes on the control socket:**
  - `GET /cut-short`: the list.
  - `POST /cut-short/upload {paths}`.
  - `POST /cut-short/restore {paths}`.

  Status gains `stats.cutShortFiles`. The app and the tray count held files the way Home shows them: up to 3 as one
  problem each, more as one problem. Home's headline says "N problems need you", and the tray's menu says "⚠ N problems
  need you".
- **Emblems and Activity:** Files shows such a file with the error emblem, which is the one conflicts use.
- **Activity:** it has no folding of bursts, so it logs the first cut-short file of a burst: "Not uploaded: report.pdf
  wasn't fully written (disk nearly full)". Further ones within a minute aren't logged; Home lists them all.
- **Not covered (accepted):** a refused close that never reaches the daemon because the helper itself dies before
  sending it. The file then follows the settle rule.

### #299: the full disk said plainly
- **The helper's report:** it already logs a refusal at most every 30 s. With the same timing it posts
  `POST /vfs/refused {needed, available}`, through the same background sender. A refusal because the disk's free space
  couldn't be read (EIO) doesn't count.
- **The daemon:** keeps the time of the last refusal, and puts `diskFull: {refusedAt}` in its status while that was
  under 10 minutes ago.
- **Home:** while `diskFull` is set, a notice above the cards says: "Your computer's disk is almost full. Proton Drive
  keeps 5 GB free on it, so new files can't be saved to the drive." It has a **Free up space…** button, which opens
  the existing whole-drive Free up space dialog.
- **The tray:** its status line says "Disk almost full" while the notice shows.
- **When it goes away** (changed after the final review: going away as soon as the disk had 1 GB more than the reserve
  free hid the notice when a big growth or open was refused with that much free, and when an app deleted its partial
  file at once): 10 minutes after the last refusal. Sooner only when both hold:
  - at least 2 minutes have passed since the last refusal;
  - the store's disk has the reserve free plus 1 GB, or plus the most any refusal asked for since these 10 minutes
    began, if that is more. These 10 minutes begin at a refusal that comes once the last ones are over.

  The disk is read only while the 10 minutes run, at each refusal and when status is read, one reading at a time.
  An open the daemon refuses for space (#301) counts as a refusal too.

### #301: an open that would fill the disk
- **The check:** before downloading a file for an open (`hydrate`), the daemon reads the store's disk free space
  (statvfs). If the download would leave it under the same 5 GB reserve, it refuses with a new code, ENOSPC, recorded
  as a refusal for #299.
- **The size:** the file's size comes from the remote index. Downloads for opens already running count against the
  room too, so two large opens at once can't both squeeze in (my call).
- **The helper:** maps that refusal to ENOSPC for the app. It isn't logged as an error, since it isn't one.
  - An app that opens an online-only file to read gets ENOSPC on the open.
  - An app that opens one write-only gets it on its first write, since that download is deferred until then.

## Constraints

- **Tests first**, in each layer:
  - **Daemon:** `bun test tests` and `bunx tsc --noEmit`.
  - **App and helper:** `cargo test --release` and `cargo clippy --release --all-targets`, with no warnings.
  - **Real-mount tests:** where the helper's behaviour depends on the kernel, `PROTONDRIVE_VFS_MOUNT_TESTS=1`.
- **Data safety (CLAUDE.md):**
  - Records go before files: the hold row is written before the daemon answers the "closed" post.
  - Nothing replaces a cloud item the user didn't change.
  - Put back keeps both copies.
- **Process:**
  - One issue, one branch, one PR each, in this order: #302, #64, #300, #299, #301.
  - #300 builds on #64's "closed" post. #299 builds on #64's background sender. #301 builds on #299's refusal record.
- **Deploying** needs the daemon, the helper and the app installed together (new routes). The daemon is idle first and
  the database is backed up, as always.

## Calls made after the builder check

The builder check raised six questions; I settled them as follows (each is also marked "my call" above):

- **Replacing sessions never upload while open:** no 2-minute exception, so a long copy cut short can't have replaced
  the cloud version. In-place edits keep the 2-minute rule.
- **Marks:** a 30 s keepalive and a 90 s expiry, rather than an expiry from the first post.
- **Many held files:** a summary row with bulk actions above 3.
- **Put back:** renames the cut-short file to a held copy and makes the path online-only. It doesn't download the cloud
  version or upload the copy. A path with an edit baseline counts as an existing item.
- **Lifting a hold:** only a full rewrite without refusal lifts it.
- **Refused closes:** retried until the daemon accepts them; only the helper dying first is accepted as a gap.

## Left to the builder

- The sender queue's size. When it's full, the oldest best-effort post goes first; refused closes are never dropped.
- How the helper tells a write-capable open from a read-only one (open flags), and how deferred opens count.
- The conflict copy name used by Put back: the existing keep-both naming.
- The exact words of the Activity line and the tray line, within what's quoted here.
- Whether `/vfs/writing` carries anything beyond the path.
