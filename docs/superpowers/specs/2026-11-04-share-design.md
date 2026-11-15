# Share from Files and the app

Tracking issue: #216. Approved by the user on 2026-11-14 ("design looks good, start building").

## Why

Nothing in this client can share. To send someone a file or folder, the user has to open drive.proton.me, find the
item again and share it there. Every other sync client puts sharing on the file's right-click menu. The Proton Drive
SDK we already use supports all of it:
- `shareNode` with users (email, viewer or editor) and `urlAccess` (role, custom password, expiry);
- `getSharingInfo` (members, Proton and non-Proton invitations, the public link with its URL);
- `unshareNode` (some users, the link, or everything).

## Goals

- **Copy Link:** one click on a file or folder in Files puts a working share link on the clipboard.
- **A Share window:** turn the public link on or off, set or clear a password and an expiry, copy the link, invite
  people by email as viewer or editor, see who has access, and remove a person or the link.
- **The same wording and behaviour as Proton's web app,** so a user who knows one knows the other.

## Non-goals

- **Shared with me:** browsing items others shared with you, or accepting invitations. That is a later piece.
- **Bookmarks, abuse reports, editors-can-share settings, custom email messages.**
- **Sharing more than one item at once.** Copy Link and Share act on exactly one selected item.
- **A "shared" emblem in Files.** A possible follow-up.

## Anti-goals (a failure even if it works)

- **Access granted without the user meaning it.**
  - Nothing is ever shared or unshared without an explicit click on an action that says so.
  - Copy Link creates a link only when none exists. It never changes an existing link's password, expiry or role.
  - Removing access always asks first.
- **A password shown in the clear by default.** In the Share window a password is hidden until "Show" is clicked. It is
  never written to the daemon's log or the activity history.
- **Files frozen or slowed.** Every network call runs off the main thread (the extension already does this, see the GIL
  pump, #131), with a timeout and a notification on failure.
- **Sharing an item that isn't in Proton Drive yet.**
  - A file or folder that exists only on this computer has no cloud node to share.
  - Copy Link and Share say "Not uploaded yet: Proton Drive can share it once it has uploaded", and do nothing else.

## How it works

### Daemon: control-socket routes (user-only; never on the TCP API)

The daemon finds an item's node by its path in My files, using the remote index. A path with no node is refused with
the "not uploaded yet" error. An item that is hidden or being hidden is refused too.

- **`GET /share/info?path=`** returns
  `{ link: { url, hasPassword, expiresAt | null, role } | null, people: [{ email, role, state: "member" | "invited" | "invited-not-proton" }] }`,
  from `getSharingInfo`.
  - The answer never includes the password itself.
  - The window asks again for it only when "Show" is clicked: `GET /share/password?path=`.
- **`POST /share/link {path}`** returns the link, `{ url, created: boolean }`.
  - If the item already has a public link, its URL is returned unchanged (`created: false`).
  - Otherwise a viewer link with no password and no expiry is created (`created: true`). This is what Copy Link uses.
- **`POST /share/link/settings {path, password?: string | null, expiresAt?: number | null}`** sets the link's password
  and expiry; `null` clears either one.
- **`DELETE /share/link {path}`** removes the public link (`unshareNode(…, { urlAccess: 'remove' })`).
- **`POST /share/invite {path, emails: string[], role: "viewer" | "editor"}`** invites people (`shareNode` users).
- **`POST /share/role {path, email, role}`** changes one person's role.
- **`DELETE /share/person {path, email}`** removes one person or invitation (`unshareNode(…, { users: [email] })`).
- **Errors:** 400 `{ error }` in plain words, such as "Not uploaded yet", "Not a valid email address", or "Proton Drive
  is offline".
- **Activity:** each change goes into the activity history ("Shared report.pdf with a link", "Invited 2 people to
  Docs", "Stopped sharing the link to report.pdf"). Activity entries never include passwords, and log lines never
  include passwords or invitees' addresses.

### Files (Nautilus) right-click

On exactly one selected item that is in Proton Drive, after the existing actions:

```
Always keep on this device
Free up space
Hide from this computer
───
Share…
Copy Link
```

- **Copy Link:**
  - calls `POST /share/link`;
  - puts the URL on the clipboard (Files' own clipboard);
  - shows a notification: "Link copied: anyone with the link can view report.pdf", or "Link copied" when the link
    already existed.
  - On an error, the notification says what went wrong.
- **Share…:** opens the app's Share window for that item (below).
- **Neither item is shown** for several selected items, for something the drive keeps for itself, or outside the drive.
  Both show while the daemon is unreachable, and then report that.

### App: the Share window

Opened with `protondrive-gui --share <absolute path>`. A running app gets the request through the single-instance
socket as `share <path>` (#203's protocol, extended: one line, path up to 4096 bytes, no newline). It shows the Share
window in front of whatever section is open.

```
┌ Share "report.pdf" ───────────────────────────────┐
│ Link                                    [ on  ●]  │
│ https://drive.proton.me/urls/…        [Copy link] │
│ Anyone with the link can view.                    │
│ Password  ••••••   [Show] [Change] [Remove]       │
│ Expires   never    [Set date…]                    │
│───────────────────────────────────────────────────│
│ Invite people                                     │
│ [ email@example.com, …        ] [Viewer ▾] [Invite]│
│───────────────────────────────────────────────────│
│ Who has access                                    │
│ you                                     Owner     │
│ alex@proton.me                    [Editor ▾] [×]  │
│ sam@example.com (invited)         [Viewer ▾] [×]  │
│                                          [Done]   │
└───────────────────────────────────────────────────┘
```

- **Link switch:**
  - Turning it on creates the link (`POST /share/link`).
  - Turning it off asks first ("Stop sharing the link? Anyone using it loses access."), then calls `DELETE /share/link`.
- **Password and expiry:** change only through the explicit buttons. The expiry is a date picker, ending at the end of
  that day, local time.
- **Invite:** takes a comma- or space-separated list of emails, each checked before sending.
- **Role changes and removal:** removal asks first. The change shows at once, and is rolled back with an error on
  failure.
- **Screenshot mode sends nothing,** as always. New screenshot-only fakes show the window with a link, a password, and
  members.

## Constraints

- **The SDK calls stay in the daemon.** The app and the extension only call the control socket, as every other action
  does.
- **No new route on the TCP API.** The TCP API has no `/share` routes: they exist only on the control socket.
  (`tcpRefusals.ts` doesn't list them: `refuseOnTcp` refuses exact `/api/*` paths that moved to the control socket.)
- **Tests, in each layer:**
  - daemon: the routes against a mocked SDK (path to node, not uploaded, the no-password guarantees, Copy Link
    reusing a link);
  - extension: the menu items' visibility and the requests they send;
  - app: the window's actions and confirmations, and the protocol message.

## Left to the builder

- Visual details within the app's style.
- Exact error wording, in plain words.
- How the date picker is drawn.
- Whether the Share window is a separate viewport or a modal in the main window. A separate small window is
  preferred, if egui's multi-viewport works on this setup.

## Order of work

1. Daemon routes and tests.
2. Copy Link in Files.
3. The Share window in the app, and Share… in Files.

Each step is its own PR. Copy Link is useful on its own after step 2.
