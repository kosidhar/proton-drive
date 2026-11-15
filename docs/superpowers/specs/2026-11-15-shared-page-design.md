# The Shared page in the app

Tracking issue: #253. Approved by the user on 2026-11-15 ("ok", to the design in the conversation). Builds on Share
(#216, `docs/superpowers/specs/2026-11-04-share-design.md`), whose routes, Share window and rules it reuses.

## Why

Sharing works from Files (Copy Link, Share…), but nothing in the app shows what the user has shared. To answer "what
have I made public, and who can see it?", they have to open drive.proton.me → Shared. In a privacy-focused app, that
answer belongs one click away on the desktop, along with the means to act on it.

## Goals

- **One list of everything the user has shared,** with what each item exposes: a public link (and whether it has a
  password and an expiry), and how many people have access.
- **Act on an item from the list:** copy its link, manage it in the existing Share window, show it in Files, or stop
  sharing it.
- **Nothing public stays invisible.** An item the app can't act on is still listed, with a way to manage it on the web.

## Non-goals

- **Shared with me** (items others shared with the user). Those belong in the drive itself, as a folder in Files. That
  is a separate, larger piece.
- **Pending invitations** on Home. A possible follow-up.
- **Changing a link's password, expiry or role, or inviting people from the list.** The Share window does that.
- **A badge or count in the sidebar.**

## Anti-goals (a failure even if it works)

- **Opening the page changes anything.** The page and its route only read. Every change is a click on a button that
  says what it does.
- **Stop sharing without asking.** It always confirms first, saying what is lost.
- **A stale list presented as current.** The list comes from Proton Drive when the page opens and on Refresh, never from
  a cache that may be out of date. While it loads, the page says so.
- **Files or the app frozen.** All network calls run off the UI thread, as with every other daemon call.

## Approaches

1. **The daemon lists and summarises (chosen).** One read-only control-socket route returns every shared item with its
   sharing summary, and the app renders it. It is one request from the app, all SDK calls stay in the daemon (a
   Share constraint), and items outside My files, which have no path, are handled in one place.
2. **The app asks per item.** The daemon returns only the shared items, and the app calls `GET /share/info` for each.
   Rows would fill in one by one, but that means many round trips from the app. Also, `/share/info` takes a path, and
   items outside My files have none.
3. **The daemon keeps the list in its database,** updated from Proton Drive's events. It would be instant and work
   offline, but it is more code and risks the stale list the anti-goals rule out.

## How it works

### Daemon: `GET /share/list` (control socket only, never TCP)

It answers `{ items: [...] }`.

- **Listing:**
  - The route lists the uids of the nodes the user shared with the SDK's `iterateSharedNodeUids`. That call is not
    deprecated and asks the API each time, unlike `iterateSharedNodes`, which reads the SDK's cache.
  - It loads those nodes (`iterateNodes`) and reads each one's sharing with `getSharingInfo`, a few at a time.
- **Each item** is
  `{ name, relPath | null, where: "my-files" | "hidden" | "elsewhere", link: { url, hasPassword, expiresAt | null, role } | null, people: number }`.
  - **`relPath`** is the item's path in My files, from the remote index by uid (`getByUid`). It is null when the index
    doesn't have the item.
  - **`where`** says what the app can do with the item:
    - `my-files`: everything.
    - `hidden`: the item is hidden from this computer (`hiddenBy`). The existing share routes refuse it, as Share's
      spec says.
    - `elsewhere`: not on this computer, such as Photos, Computers, Proton Drive's trash, Proton Docs, an item not
      indexed yet, or the My files folder itself (an empty path, which the share routes refuse).
  - **`link`** has the same shape and the same password rules as `/share/info`. The URL is shown without an older
    link's password, and the password itself is never sent.
  - **`people`** counts members and invitations, the same people the Share window lists.
- **Order:** My files first, by path, then everything else by name.
- **Errors:** offline, or not signed in, is a 400 `{ error }` in plain words, as the share routes give. So is Proton
  Drive's rate or server-error limit ("Proton Drive is busy: try again in a minute"). Neither ever gives a partial list.
- **An item the server lists as shared whose sharing the SDK hasn't caught up with yet** (its node cache lags changes
  made elsewhere by up to about 30 seconds) is listed, unreadable: "Proton Drive is still catching up with this item:
  refresh in a moment". It is never dropped.
- **One unreadable item** (its node or its sharing can't be read) is still listed, with its name, or "An item" when
  even that is unknown. It has `unreadable: "<why, in plain words>"`, with `link: null` and `people: 0`, so the app can
  say why. The rest of the list is unaffected.
- **Logging:** nothing goes to the log or the activity history for a read. Log lines never include link URLs or anyone's
  address.

### Daemon: `DELETE /share/all {path}` (stop sharing)

- It removes the item's sharing completely, the link and everyone at once: `unshareNode(uid)` with no settings deletes
  the share.
- It refuses what the other share routes refuse: not uploaded, hidden.
- It writes an activity entry: "Stopped sharing report.pdf".
- A share already deleted elsewhere (the SDK answers `NotFoundAPIError`) counts as stopped: it succeeds, with no
  activity entry.

### App: the Shared section

The sidebar becomes **Home, Shared, Activity, Settings**. `--tab shared` opens it.

```
Shared                                              [Refresh]
─────────────────────────────────────────────────────────────
report.pdf        Documents
Link · password · expires 2026-11-30 · 2 people
                 [Copy link] [Manage…] [Show in Files] [Stop sharing]
Icons             (top level)
2 people · no link
                            [Manage…] [Show in Files] [Stop sharing]
holiday.jpg       Photos (not in My files)    [Manage on the web]
```

- **Each row:**
  - **First line:** the name, then the folder.
  - **Second line:** what it exposes, e.g. "Link · password · expires 2026-11-30 · 2 people" (dates as the Share window writes them), "Link expired 2026-11-01 · 2 people", "2 people · no link", or
    "Link · anyone with it can view".
- **Actions for `my-files` items:**
  - **Copy link:** only when the item has a link that hasn't expired, as in the Share window. It copies the URL and says
    "Link copied".
  - **Manage…:** opens the existing Share window for the item. When the window closes, the list loads again.
  - **Show in Files:** shows the item selected in its folder, with the app's existing helper.
  - **Stop sharing:** asks first: "Stop sharing report.pdf? The link stops working and 2 people lose access." (Only
    the parts that apply are named.) It then calls `DELETE /share/all`, and the row goes once the list loads again.
- **`hidden` and `elsewhere` items:** one button, **Manage on the web**, which opens `https://drive.proton.me/shared`.
  The row says why ("Hidden from this computer", "Not on this computer"). `elsewhere` covers more than items outside My
  files: Proton Docs and Sheets, items not indexed yet, and nodes that couldn't be loaded are in My files but not on
  this computer, so the wording stays neutral.
- **Photos note:** below the list, and below the empty-state text (not while the first load runs, not on an error), the
  page says "Photos and albums you share from Photos may not be listed here." with a "See them on drive.proton.me" link
  to the web Shared page. The daemon doesn't list Photos shares: the SDK's Photos client creates a Photos volume on the
  account when there is none, and the SDK has no read-only check, so opening the page would change the account (#256).
- **States:**
  - **Loading:** "Loading what you've shared…", with the previous list kept and greyed out on a reload.
  - **Offline or failed:** the daemon's message, with Retry.
  - **Empty:** "Nothing shared yet. Right-click a file or folder in Files and choose Share… or Copy Link."
- **When it loads:** each time the section is opened, on Refresh, after Stop sharing, and when the Share window closes.
  It never loads on a timer.
- **Screenshot mode sends nothing,** as always. Screenshot-only fakes show a list with each kind of row, the empty
  state, and the confirmation.

## Constraints

- **The SDK calls stay in the daemon,** and the routes exist only on the control socket (as for Share), under `/share/`,
  which is what the socket hands to the share routes. They are not on the TCP API and not in `tcpRefusals.ts`, because
  `/share` paths aren't `/api/*`.
- **Same words as the Share window and Proton's web app** where they overlap: "Stop sharing", "Manage", "Copy link".
- **Tests, in each layer:**
  - **Daemon:** the list route and stop sharing, against a mocked SDK. Cover:
    - `where` for each case;
    - an unreadable item;
    - the order;
    - that no password or URL fragment leaks;
    - that stop sharing refuses what the others refuse and logs its entry.
  - **App:** the rows and their buttons per kind, the confirmation, the states, and that Manage opens the Share window
    for the right path.

## Left to the builder

- How many `getSharingInfo` calls run at once (a few).
- Visual details within the app's style, and exact wording beyond what is quoted here.
- Whether a reload keeps the scroll position.

## Order of work

1. Daemon routes and tests (one PR).
2. The Shared section in the app (one PR).
