# Proton Docs and Sheets in the virtual drive: placeholders that open in the browser (design)

## Intent

The owner keeps Proton Docs and Proton Sheets in Proton Drive alongside ordinary files. Today the Linux app leaves them
out entirely: the remote index drops them (`entryFromNode` returns null for `isUnsupportedRemoteNode`), so they never
appear in `~/ProtonDrive`, and someone browsing in Files can't tell they exist or reach them. The owner asked for a
placeholder in Files that opens the document in the browser when clicked (2026-11-25), and approved the approach
below.

**Success:**
- In the virtual drive, every Proton Doc and Sheet shows up where it lives, as `<name>.protondoc` or
  `<name>.protonsheet`, with a document or spreadsheet icon.
- Double-clicking one opens it at docs.proton.me in the default browser.
- Nothing the user does to a placeholder in Files can change or lose the real document.

## Goals, non-goals, anti-goals

**Goals**
- Placeholders for Docs and Sheets, in the virtual drive only.
- They're read-only: they open the document, and every change through Files is refused.
- They stay current with the cloud: created, renamed, moved and deleted documents appear, follow and disappear, as
  other cloud changes do.
- Installed file types and an "open" handler, so Files knows them, shows proper icons and opens them correctly.

**Non-goals**
- Plain-folder mode (`driveLayout` plain): it shows nothing, as today.
- Creating new Docs or Sheets from Linux.
- Editing documents offline, downloading their contents, and exporting.
- The Shared page, Photos, and docs in other people's shares.
- Thumbnails or previews of document contents.

**Anti-goals** (failures even if it "works")
- **A placeholder is ever uploaded as a file.** The cloud would then hold `test.protondoc` beside `test`.
- **A rename, move, edit or delete of a placeholder changes or trashes the real document.**
- **Opening any file of these types sends the browser somewhere other than Proton's documents site.** A crafted
  `.protondoc` from elsewhere must not become a phishing link.
- **Thumbnailers or search indexers reading placeholders cause any side effect,** such as browser tabs, network
  requests or log spam.

## Constraints

- **Data safety (CLAUDE.md):** never trash or overwrite a cloud item except for a genuine user delete; when unsure,
  keep both.
  - A delete of a single placeholder is refused, and is not taken as a delete.
  - A delete or Move to Trash of a *folder* that holds documents is a genuine delete of that folder, as it is today
    and as on the web. The folder goes to Proton Drive's trash with everything in it, including documents, and can be
    restored there.
- **The URL** comes from the node: Proton's SDK builds it in `getNodeUrl` (`ProtonDriveClient.experimental`, which
  returns `https://docs.proton.me/doc?type=doc|sheet&mode=open&volumeId=<volumeId>&linkId=<nodeId>` for Docs and
  Sheets). The format is pinned by a test, so an SDK change is noticed.
- **Today's shape:**
  - The drive's listings come from the daemon (`GET /vfs/children` → `SyncEngine.vfsChildren(relPath)` →
    `VfsEntry { name, type, size, mtimeMs }`).
  - Renames, deletes and truncates go through the daemon (`POST /vfs/rename|delete|truncate`).
  - Opens of online-only files go through `POST /vfs/hydrate`.
  - The FUSE helper (`native-vfs/src/fs.rs`) serves local files from the store and asks the daemon for the rest.
- **Identity (#413):** app ID `io.github.kosidhar.ProtonDrive`, commands `protondrive*`, and packaging in
  `packaging/linux/`.

## Approaches

| | What Files shows | Trade-off | |
|---|---|---|---|
| **A. Own file types and an open handler** | `test.protondoc`, `Budget.protonsheet`, with document or spreadsheet icons; double-click opens the browser | The installer registers two MIME types and a hidden desktop entry. It's clean and reliable, like Google Drive's `.gdoc`. | **Chosen** |
| B. `.desktop` link files | `test.desktop` | No registration, but Files treats them as untrusted programs ("Allow Launching?") or shows them as text. | Rejected |
| C. HTML redirect files | `test.protondoc.html` | No registration, but the double extension is ugly, and an editor shows code. | Rejected |
| D. The drive opens the browser on read | `test` | Thumbnailers and indexers read files constantly, which would pop up browser tabs. | Rejected |

Placeholders are served by the virtual drive from the listing and never written into the store. That keeps the sync
engine from ever seeing them as local files, which is the first anti-goal.

## The design

### File types (packaging)

- **The MIME types are Proton's own media types:** `application/vnd.proton.doc` (glob `*.protondoc`, comment "Proton
  Docs document", `generic-icon` `x-office-document`) and `application/vnd.proton.sheet` (glob `*.protonsheet`,
  comment "Proton Sheets spreadsheet", `generic-icon` `x-office-spreadsheet`).
  - They're shipped as a shared-mime-info file, `share/mime/packages/io.github.kosidhar.ProtonDrive.xml`.
  - The theme's generic icons are used, so no Proton artwork is involved.
- **A hidden desktop entry**, `share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop`:
  - `NoDisplay=true`, `MimeType=application/vnd.proton.doc;application/vnd.proton.sheet;`;
  - `Exec=protondrive open-doc %f` (absolute path in user mode, as the main entry's `Exec` is rewritten today);
  - `Name=Proton Drive`.
- **`install.sh`** (user and system) and **`package.sh`** (and so deb, rpm, the tarball and Arch) install both files.
  Afterwards they run `update-mime-database` and `update-desktop-database` when present. Uninstalling removes both
  files. Flatpak: the manifest gets the same two files.
- **The AppImage** installs nothing on the host, so its users get placeholders without the file types or handler. A
  double-click then likely opens the JSON in an editor. This is a known limitation, with its own issue (my call). The
  owner uses `install.sh`.

### The placeholder file

- **Name:** the document's name plus `.protondoc` or `.protonsheet`, for example `Untitled document 2026-05-07
  18.55.25.protondoc`.
- **Content:** a small UTF-8 JSON object followed by a newline:
  `{"type":"doc","url":"https://docs.proton.me/doc?…","name":"<doc name>"}`. Its size is the byte length, and its
  mtime is the document's modification time.
- **Collisions:** if the folder already holds a real file or folder with exactly the placeholder's name, the real item
  wins and the placeholder is left out, logged once per path.

### The daemon: knowing where the documents are

- **Recording documents:** the daemon keeps a record of the account's Docs and Sheets (uid, parent uid, name, type,
  modification time). It's filled where the remote index skips them today (the crawl and the event replay), and it
  stays current with the same events as files: create, rename, move and trash. It's persisted next to the remote
  index, so placeholders show straight after a restart.
- **Listings:** `vfsChildren(relPath)` adds the placeholders for the documents whose parent folder is `relPath`, in
  virtual-drive mode only.
  - `VfsEntry` gains an optional `placeholder` field: `{ kind: 'doc' | 'sheet', content: string }`.
  - `type` is `'file'`, and `size` is the content's byte length.
- **Refusing changes:**
  - `POST /vfs/rename` and `POST /vfs/delete` on a placeholder's path are refused with `EPERM`. This covers both the
    `from` and the `to` side: renaming a real file onto a placeholder name is refused too.
  - `POST /vfs/truncate` and `POST /vfs/hydrate` on a placeholder are refused with `EPERM`.
  - **Move to Trash of a folder** holding placeholders goes ahead as today, for the folder: one daemon call, and the
    documents go with it to Proton Drive's trash.
  - **A permanent folder delete** (`rmdir`, which `rm -r`, Shift+Delete and the delete half of a move out of the drive
    end in) counts the folder's documents as contents. The daemon's emptiness check (`holdsAnything`) and the helper's
    both see them, so the delete is refused with `ENOTEMPTY` while any document is inside. Without this, a folder
    holding only documents would pass the emptiness check and trash its documents silently.
  - **The result:** a permanent delete or a move out of the drive leaves the folder and its documents behind, safe in
    the cloud, and Move to Trash is the way to remove such a folder.
- **No uploads:** a placeholder is never in the store, so the engine never sees it. A real local file whose name ends
  in `.protondoc`/`.protonsheet` syncs as any other file. Only placeholders are virtual.
  - **Copies:** Copy and Paste or a duplicate of a placeholder inside the drive makes a real file (`test
    (copy).protondoc`), which uploads as the user's own small file and still opens the document. That's accepted (my
    call): blocking it would mean the engine judging file contents.
- **The URL** for each document comes from the SDK's `getNodeUrl`, or from a local function producing the identical
  format, pinned by a test against the SDK's. It's computed when the record is written, not on every listing.

### The FUSE helper: serving and refusing

- **Serving:** an entry with `placeholder` is a regular file of mode `0444`, which reads its `content` from memory.
  `open` read-only succeeds without any daemon call, and `read` serves the bytes.
- **Refusing:** `open` for writing, `write`, `setattr` (size, mode, times), `unlink`, `rename` (either side) and
  `link` are refused with `EPERM`. Files then says "Permission denied" and nothing is sent to the daemon. The daemon
  also refuses, as a second line of defence.
- **Notices:** the writing and closed notices (#64) are never sent for placeholders.

### Opening: `protondrive open-doc <file>`

- **A new CLI subcommand** reads the file, which is at most 64 KiB, and parses the JSON.
- **It opens the URL** with the desktop's opener (`xdg-open`) only if it is exactly `https:`, host `docs.proton.me`,
  path `/doc`, and holds `type` (doc|sheet), `volumeId` and `linkId` query parameters. Otherwise it shows a desktop
  notification, "This isn't a Proton Drive document link", and exits non-zero.
- **No daemon needed:** it works with the daemon down, and needs no sign-in, because the browser handles the
  session.

## Decided by the owner

- Approach A.
- Placeholders are read-only.
- The virtual drive only.

## My calls (marked so the owner can check them)

- **A permanent delete of a folder holding documents is refused** (`ENOTEMPTY`). Move to Trash still works. This
  follows the data-safety rule "when unsure, keep both".
- **Copies of placeholders made inside the drive upload** as the user's own small files.
- **The AppImage doesn't register the file types:** a known limitation with its own issue.
- **The MIME type names** are Proton's own media types, and the icons are the theme's generic ones.
- **A folder's delete or Move to Trash** takes its documents to Proton Drive's trash, as the web does. Single
  placeholders can't be deleted.
- **Names** use `.protondoc` and `.protonsheet`, and real items win name collisions.
- **The JSON content and the strict URL check** in `open-doc`.

## Left to the builder

- Where the document record lives (table name and shape) and how it hooks into the crawl and event code.
- Which FUSE call sites need the placeholder checks.
- Whether `getNodeUrl` or the local format function is used.
- How the tests reach the FUSE behaviour: the mount tests, or the helper's unit tests.
