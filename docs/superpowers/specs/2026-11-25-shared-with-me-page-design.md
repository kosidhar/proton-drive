# A Shared with me page in the app (design)

Issue #487. The owner chose this on 2026-11-25: an app page first, a "Shared with me" folder in the virtual drive later.

## Why

People share files and folders with the owner in Proton Drive, and the app shows none of them. The sync and the virtual
drive cover My files only. The Shared page (#410, design 2026-11-15) lists what the owner shared, not what others shared
with them, and that design left Shared with me out on purpose, as "a folder in Files", a larger piece. Only the CLI
reaches shared items (`protondrive ls /shared-with-me`, #486).

A page in the app comes first because it is needed even once the folder exists. Files can't accept or decline an
invitation, and can't say who shared an item, when, or with what access. The folder can come later and reuse this
page's daemon routes.

**Success:** someone shares a folder with the owner. The app shows the invitation, and the owner accepts it there. The
folder is then listed with who shared it and the owner's access, and opens on the web in one click. A shared file can
be saved to Downloads.

## Goals

- **Pending invitations,** each with what is shared, who sent it, the role offered, and **Accept** / **Decline**.
- **The items shared with the owner,** each with its name and kind, who shared it, when, and the owner's access
  (Viewer or Editor).
- **Act on an item:**
  - **Open** shows it on the web: Proton Drive for files and folders, Proton Docs for Docs and Sheets.
  - **Download** saves a shared *file* to the Downloads folder.
  - **Leave** removes the item from the owner's Shared with me, after asking.

## Non-goals

- **A "Shared with me" folder in Files** (the virtual drive). That is the later step, which will reuse these routes.
- **Downloading a shared folder,** or syncing anything shared. Open on the web does a whole folder.
- **Editing or uploading into shared items from the app.**
- **Bookmarks** (public links the owner saved on the web), and **Photos shared with me**. The page says where to find
  them: "Saved links and shared photos are on drive.proton.me".
- **Notifications or a sidebar badge** for new invitations. A possible follow-up.
- **Live updates.** The list loads when the page opens, on Refresh, and after each action, as the Shared page does.

## Anti-goals (a failure even if it works)

- **Accepting an invitation from someone Proton can't verify, without a warning.** The SDK warns that an unverified
  sender "could be forged by a bad actor".
- **Leave without asking,** or without saying it can't be undone from here: only the owner can share it again.
- **Download overwriting a file in Downloads,** or filling the disk past the drive's 5 GB reserve (`LOCAL_RESERVE_BYTES`).
- **Opening the page changes anything.** Reading is all it does; every change is a button press.
- **Anything touching My files, the sync, or the virtual drive.**
- **The app frozen:** every network call runs off the UI thread.

## Approaches

1. **The daemon lists and acts, and the app renders (chosen),** as for the Shared page. One read route returns
   invitations and items together, and one route per action. All SDK calls stay in the daemon, on the control socket
   only.
2. **A section on the Shared page** (two lists, "By you" and "With you"). It is one page fewer, but it mixes two
   different jobs on one page and works against the web's layout, where they are separate entries.
3. **Through the drive only,** with a folder in Files. Deferred: it is larger, and it can't accept invitations.

## How it works

### Daemon (control socket only, never TCP; next to the share routes in `src/daemon/shareRoutes.ts`)

- **`GET /share/with-me`** returns `{ invitations: [...], items: [...] }`.
  - **Invitations** come from `sdk.iterateInvitations()`:
    `{ invitationUid, nodeUid, name, kind: 'file'|'folder'|'doc'|'sheet', from: string|null, fromVerified: boolean, role, invitedAt }`.
    `nodeUid` is the shared item's: the app knows an accepted invitation's item by it.
    - `from` is `addedByEmail`. When the sender is unverified, it is the error's `claimedAuthor` if there is one, else
      null, and `fromVerified` is false.
    - An invitation whose name can't be decrypted shows as "An item".
    - `kind` comes from the invitation's `node.type` and `node.mediaType`, using the same Docs/Sheets check as #430. With
      no media type, it's file or folder.
  - **Items** come from `sdk.iterateSharedWithMeNodeUids()` plus `iterateNodes`, loaded by the loader #486 added to
    `src/sdk/paths.ts` (shared, not copied). An item that fails to load is listed as unreadable:
    `{ uid, name, kind, sharedBy: string|null, sharedByVerified: boolean, sharedAt, role: 'viewer'|'editor'|'admin', unreadable?: string }`.
    `sharedBy`, `sharedAt` and `role` come from the node's `membership`. An unverified `sharedBy` uses the claimed
    author, as for invitations. With no `membership`, it falls back to `directRole`, `sharedBy` and `sharedAt` are null,
    and the item has `canLeave: false`. The list holds the items shared with the owner directly, so that should be rare.
  - **`kind`** is `doc` or `sheet` for Proton Docs and Sheets (as #430 detects them), else file or folder.
  - **Order:** invitations newest first, then items newest shared first.
- **`POST /share/with-me/accept {invitationUid}`** and **`/decline {invitationUid}`** call `acceptInvitation` /
  `rejectInvitation`. The other actions take the node's `uid`.
- **`POST /share/with-me/leave {uid}`** calls `leaveSharedNode`. It is refused for an item with `canLeave: false`.
- **`POST /share/with-me/open-url {uid}`** returns `{ url }` from `sdk.experimental.getNodeUrl(uid)`. If that fails, for
  example with no share root it can read, it returns `https://drive.proton.me/shared-with-me`. The app opens it with
  the desktop's opener (`xdg-open`, #433).
- **`POST /share/with-me/download {uid}`** saves a file's active revision into the user's Downloads folder
  (`xdg-user-dir DOWNLOAD`, or `~/Downloads`), as `name`, or `name (1).ext`, `name (2).ext` and so on if taken. It never
  overwrites. It uses `downloadDriveNodeToLocal` (`src/sdk/fileOps.ts`).
  - It is refused when the file's size would leave less than `LOCAL_RESERVE_BYTES` free on that disk, with the reason in
    plain words. The size is the larger of the active revision's claimed and storage sizes, and the other downloads
    under way count as used, in full.
  - It writes to a hidden temp name (`.proton-drive-tmp-download-*`) in the same folder, removed on any failure.
  - Before each download, it removes from that folder (not below it) the temps a stopped daemon left (#492): its own
    `.proton-drive-tmp-download-*` that no download of this daemon is writing, and `downloadDriveNodeToLocal`'s
    `.proton-drive-tmp-<pid>-<uuid>` only when no process has that pid. Nothing else, since the sync's temps there look
    alike.
  - It is placed without ever replacing a file: `link(temp, chosen)`, which fails if the name exists (then the next
    `name (n).ext` is tried), then the temp is unlinked. `downloadDriveNodeToLocal`'s own rename-over is not used for the
    final step.
  - It returns `{ path }`. Folders, Docs and Sheets are refused with a plain reason.
- **Errors:** 400 `{ error }` in plain words: offline, not signed in, Proton's own message. These are the same rules
  as the share routes.
- **Logging:** reads log nothing. Accept, Decline, Leave and Download go to the activity history the daemon already keeps,
  as other actions do, in plain words: "Accepted an invitation to <name>", "Left <name>", "Downloaded <name> to
  Downloads". Item names appear there as file names do today. Email addresses never appear in the activity or the log
  (log masking as today).

### App: the Shared with me page

- **Sidebar:** a new entry, **Shared with me**, under **Shared** (as on the web), with a people icon. `--tab shared-with-me`
  opens on it.
- **Layout:** the Shared page's patterns, including its loading picture, its centred Refresh, and its states (#410).

```
 Shared with me                                                        [ ⟳ Refresh ]

 Invitations
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ 📁 Holiday photos     alex@proton.me invited you as Editor · 2 h ago         │
 │                                                    [ Decline ]  [ Accept ]   │
 │ 📄 Budget.pdf         ⚠ Sender not verified · Viewer · Yesterday             │
 │                                                    [ Decline ]  [ Accept ]   │
 └──────────────────────────────────────────────────────────────────────────────┘

 Name                     Shared by             Shared        Access
 📁 Project X             sam@proton.me         3 Nov 2026    Editor     [ Open ] [ ⋯ ]
 📄 Contract.pdf          lee@proton.me         1 Nov 2026    Viewer     [ Open ] [ ⋯ ]
 📝 Meeting notes         ⚠ unverified          28 Oct 2026   Viewer     [ Open ] [ ⋯ ]

 Saved links and shared photos are on drive.proton.me
```

- **Invitations** show only when there are any.
  - **Accept from an unverified sender** asks first, with **Cancel** and **Accept**:
    - with a claimed email: "Proton couldn't verify that this invitation is from <email>. Accept it only if you expected
      it.";
    - without one: "Proton couldn't verify who sent this invitation. Accept it only if you expected it."
  - After Accept or Decline, the list reloads. An accepted item that isn't listed yet (Proton's list can lag) shows as
    "Accepted, it will appear shortly", and the page reloads once more after 5 s.
- **Each item:**
  - Its kind icon: folder, file, or the Proton Docs and Sheets icons from #473.
  - Its name, who shared it, the date, and the access (Viewer / Editor / Admin). An unverified "Shared by" shows ⚠ with
    a tooltip saying why.
  - **Open** opens it on the web.
  - **⋯** holds **Download** (files only, not Docs and Sheets) and **Leave** (not shown when `canLeave` is false).
- **Leave** asks first: "Leave <name>? It will no longer be shared with you. Only the person who shared it can share it
  again." with **Cancel** and **Leave**. Afterwards, the list reloads.
- **Download** shows "Downloading…" on the row. Then:
  - done: "Saved to Downloads" with **Show in Files** (opens the folder with the file selected);
  - failed: the reason, on the row.
- **Unreadable items** show "An item" (or their name, if known), with **Open on the web**
  (`https://drive.proton.me/shared-with-me`).
- **The other states:**
  - **Empty:** the web's words, "Files and folders that others shared with you will appear here".
  - **Offline or an error:** the reason, with **Retry**.
  - **Signed out:** as on the Shared page.
- **Accessibility:** buttons are named with the item ("Open Project X", "Leave Project X"), notes are announced
  politely, and focus returns after a keyboard Refresh (#411).
- **Screenshot mode** sends nothing. Its fakes show invitations (verified and not), each kind of item, unreadable,
  empty, loading and error.

## Constraints

- **Data safety (CLAUDE.md):** nothing here touches My files, records, the sync or the drive. Leave and Decline change
  only the owner's membership, and both confirm. Leave always does; Decline doesn't, because the person can invite
  again (my call).
- **The SDK calls stay in the daemon,** on the control socket only, as the Share routes do.
- **Words match Proton's web app** where they overlap: "Shared with me", "Accept", "Decline", "Leave", "Viewer",
  "Editor".
- **Tests in each layer:**
  - daemon routes with a fake SDK: listing, the missing-`membership` fallback, unreadable items, each action, Download's
    name choice, reserve refusal and temp-then-rename, and kind refusals;
  - the app with harness tests: each state, the confirmations, keyboard focus, and the accessible names;
  - screenshots in light and dark.

## My calls (marked so the owner can check them)

- A separate sidebar entry, not a section of the Shared page.
- Download for files only, into Downloads, never overwriting.
- Decline doesn't ask first; Leave does.
- No live updates, badge or notifications in this step.
- **Download never replaces a file:** it places the file with `link()`, and its temp file in Downloads is hidden and
  removed on failure.
- **An unverified sender's claimed email** is shown with ⚠ and the warning, never as if verified.
- **An accepted item that hasn't arrived yet** shows "Accepted, it will appear shortly", and the page reloads once.
- **Open falls back to the web's Shared with me page** when Proton can't build the item's own link.
- Bookmarks and Photos shared with me only get a pointer to the web.

## Left to the builder

- The exact route and field names, and how they fit `shareRoutes.ts` / `shareService.ts`.
- How Download reports progress (a single "Downloading…" is enough).
- Date formatting (match the Activity page's).
- Whether the item list and the Shared page share row-drawing code.
