# Docs and Sheets Placeholders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the virtual drive, each Proton Doc and Sheet appears as a read-only `<name>.protondoc` /
`<name>.protonsheet` that opens the document at docs.proton.me when double-clicked.

**Architecture:**
- **Records:** the daemon records documents from the folder listings it already makes, in a new `doc_nodes` table.
- **Listings:** `vfsChildren` adds placeholder entries, carrying their small JSON content, in virtual mode.
- **Refusals:** every change to a placeholder is refused with a new `EPERM` code, by both the daemon and the FUSE
  helper.
- **Serving:** the helper serves placeholder content from memory, like `.xdg-volume-info`.
- **Opening:** a new `protondrive open-doc` opens only Proton document links.
- **Packaging:** it registers two MIME types and a hidden desktop entry.

**Tech Stack:** Bun/TypeScript (`bun test`), Rust (`native-vfs`, `cargo test`, real-mount tests behind
`PROTONDRIVE_VFS_MOUNT_TESTS=1`), shell packaging, shared-mime-info.

**Spec:** `docs/superpowers/specs/2026-11-25-docs-sheets-placeholders-design.md` (issue #430)

**Code map, for implementers:** `<scratchpad>/docs-placeholders-map.md`

## Global Constraints

- **Names:** `<doc name>.protondoc` and `<sheet name>.protonsheet`.
- **MIME types:** `application/vnd.proton.doc` (glob `*.protondoc`, comment `Proton Docs document`, generic-icon
  `x-office-document`) and `application/vnd.proton.sheet` (glob `*.protonsheet`, comment `Proton Sheets spreadsheet`,
  generic-icon `x-office-spreadsheet`).
- **Content:** exactly `JSON.stringify({ type, url, name }) + '\n'`, with `type` `'doc'` or `'sheet'`.
  - `size` is the UTF-8 byte length, and `mtimeMs` is the document's modification time
    (`activeRevision?.claimedModificationTime ?? modificationTime`).
- **URL:** `https://docs.proton.me/doc?type=<doc|sheet>&mode=open&volumeId=<volumeId>&linkId=<nodeId>`, from
  `splitNodeUid(uid)`. It's the SDK's `getNodeUrl` format, built locally with no network call.
- **Read-only:** rename (either side), delete, truncate, write, setattr, hydrate and create-over a placeholder are
  refused with `EPERM`.
  - A permanent delete of a folder holding documents is refused with `ENOTEMPTY`.
  - Move to Trash of a folder behaves as it does today.
- **Placeholders exist only in virtual-drive mode, and are never in the store.** Real items win name collisions.
- **`open-doc` opens a URL only if it is** scheme `https:`, host `docs.proton.me`, path `/doc`, with `type` in
  {doc, sheet}, a non-empty `volumeId` and a non-empty `linkId`.
  - It reads at most 64 KiB.
  - Otherwise it notifies `This isn't a Proton Drive document link` and exits 1.
- **Files:**
  - the MIME package is `share/mime/packages/io.github.kosidhar.ProtonDrive.xml`;
  - the handler is `share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop`, with `NoDisplay=true`,
    `MimeType=application/vnd.proton.doc;application/vnd.proton.sheet;`, `Exec=protondrive open-doc %f` and
    `Name=Proton Drive`.
- **Repo rules:**
  - branch `feat/430-docs-sheets-placeholders` and conventional commits; the last one says `Fixes #430`;
  - no AI attribution;
  - every CLAUDE.md check passes before the push, including `native-vfs` tests, clippy and the mount tests.
- **Safety for implementers:**
  - never run `install.sh`, `package.sh` or the user's app or daemon;
  - never touch `~/.local`, `~/.config` or the keyring;
  - mount tests use their own temp mounts.

## Review Focus

1. **A folder holding only documents, deleted with Shift+Delete or `rm -r`:** refused (`ENOTEMPTY`), and nothing is
   trashed in the cloud (Task 2).
2. **A document renamed, moved or trashed on the web** while the drive is open: its placeholder follows or goes after
   the change is seen, and never shows at the old place too (Task 1).
3. **A real file named exactly like a placeholder** (for example `test.protondoc` uploaded from elsewhere): the real
   file shows, and there's no duplicate entry (Task 2).
4. **A thumbnailer, indexer or `cat` reading a placeholder:** no daemon call, no download attempt, and no
   writing/closed notice (Task 3).
5. **A hand-made `.protondoc` pointing at another site** (`https://evil.example/doc?...`, `http://docs.proton.me/...`,
   `https://docs.proton.me.evil.example/...`): refused, and nothing is opened (Task 4).

---

### Task 1: The daemon records Docs and Sheets, and builds their placeholder

**Files:**
- Create: `src/sync/docNodes.ts`
- Modify: `src/sync/syncEngine.ts` (`recordListing` ~7491, event removals ~3507/3518), `src/sync/remoteIndex.ts` only if
  the schema setup lives there
- Test: `tests/docNodes.test.ts`, plus the `'remote index'` block of `tests/syncEngine.test.ts`

**Interfaces:**
- Produces, in `src/sync/docNodes.ts`:
  - `type DocKind = 'doc' | 'sheet'`;
  - `interface DocRecord { uid: string; parentUid: string; name: string; kind: DocKind; mtimeMs: number }`;
  - `class DocNodes(db)`, with `replaceChildren(parentUid: string, docs: DocRecord[]): void`,
    `remove(uid: string): void`, `listChildren(parentUid: string): DocRecord[]` and
    `anyChildren(parentUid: string): boolean`;
  - `docKindOf(node: NodeEntity): DocKind | null`;
  - `docUrl(uid: string, kind: DocKind): string`;
  - `placeholderName(rec: DocRecord): string`;
  - `placeholderContent(rec: DocRecord): string`.
  - The engine exposes `docNodes` (a getter) for Task 2.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/docNodes.test.ts
test('docUrl builds the SDK getNodeUrl format from the uid', () => {
  expect(docUrl('volA~nodeB', 'doc')).toBe('https://docs.proton.me/doc?type=doc&mode=open&volumeId=volA&linkId=nodeB');
  expect(docUrl('volA~nodeB', 'sheet')).toContain('type=sheet&');
});
test('the SDK still builds document URLs this way', () => {
  // read vendor/sdk/client/js/src/internal/nodes/nodesAccess.ts and assert it contains
  // 'https://docs.proton.me/doc?type=${type}&mode=open&volumeId=${volumeId}&linkId=${nodeId}'
});
test('placeholder name and content', () => {
  const rec = { uid: 'v~n', parentUid: 'v~p', name: 'Plan', kind: 'doc', mtimeMs: 5 } as const;
  expect(placeholderName(rec)).toBe('Plan.protondoc');
  expect(placeholderName({ ...rec, kind: 'sheet' })).toBe('Plan.protonsheet');
  expect(placeholderContent(rec)).toBe(JSON.stringify({ type: 'doc', url: docUrl('v~n', 'doc'), name: 'Plan' }) + '\n');
});
test('DocNodes replaces a folder\'s documents, moves a doc by uid, and removes it', () => {
  // replaceChildren('p1', [a, b]) → listChildren('p1') = [a, b]; replaceChildren('p2', [a]) → a under p2 only;
  // remove(b.uid) → gone; anyChildren reflects it; the table survives reopening the db
});
// tests/syncEngine.test.ts 'remote index'
test('a listing records the folder\'s Docs and Sheets, and the next listing follows renames and moves', () => {}); // Review Focus 2
test('a trashed or deleted document event removes its record', () => {});
```

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/docNodes.test.ts` (and the engine tests named above).
  Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement.**
  - **Table:** `doc_nodes(uid TEXT PRIMARY KEY, parentUid TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    mtimeMs INTEGER NOT NULL)`, indexed on `parentUid`, created on the same connection as `remote_nodes`.
  - **Recording:** `recordListing` also calls `docNodes.replaceChildren(folder.uid, docsOf(children))`, in the same
    `indexWrite`. Because the table keys on uid, a doc moved by a later listing leaves its old folder.
  - **Removal:** the `NodeDeleted` and trashed-event branches call `docNodes.remove(nodeUid)`.
  - **Folder subtrees:** when a folder subtree is removed, documents whose parent is no longer in `remote_nodes` are
    invisible anyway (Task 2 looks up by the folder's uid). Pruning them is optional.
  - **Comments** say why: Docs and Sheets aren't synced files, only placeholders in the virtual drive.

- [ ] **Step 4: Run the checks.** `bun test tests` and `bunx tsc --noEmit` pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/docNodes.ts src/sync/syncEngine.ts src/sync/remoteIndex.ts tests
git commit -m "feat(sync): record Proton Docs and Sheets from folder listings

Refs #430"
```

### Task 2: The drive lists placeholders and refuses changes to them

**Files:**
- Modify:
  - `src/sync/driveOps.ts` (`VfsEntry` and `DriveOpErrorCode`);
  - `src/sync/syncEngine.ts`: `vfsChildren` ~4656, `renameItem` ~3940, `deleteItem`/`deleteLocally` ~3975/5668,
    `truncateItem` ~4042, `hydrate` ~4959 and `holdsAnything` ~5936;
  - `src/daemon/controlServer.ts`, only if code lists need it.
- Test: the `'the virtual drive'` and `'drive operations'` blocks of `tests/syncEngine.test.ts`, and the
  `'drive routes'` block of `tests/controlServer.test.ts`

**Interfaces:**
- Consumes: Task 1's `docNodes` and its helpers.
- Produces:
  - `VfsEntry` gains `placeholder?: { kind: 'doc' | 'sheet'; content: string }`;
  - `DriveOpErrorCode` gains `'EPERM'`;
  - `/vfs/children` entries carry `placeholder` as JSON.

- [ ] **Step 1: Write the failing tests**

```ts
test('in virtual mode a folder lists its documents as read-only placeholders', () => {
  // vfsChildren(folder) includes { name: 'Plan.protondoc', type: 'file', size: <byte length>, mtimeMs, placeholder: { kind: 'doc', content } }
});
test('plain mode lists no placeholders', () => {});
test('a real item with the placeholder\'s name wins', () => {});            // Review Focus 3
test('placeholders follow the ignore and hidden rules of their folder', () => {});
test('rename, delete, truncate and hydrate of a placeholder are refused with EPERM', () => {
  // renameItem from the placeholder → EPERM; renameItem of a real file TO a placeholder name → EPERM;
  // deleteItem (unlink) → EPERM; truncateItem → EPERM; hydrate → EPERM; the document record is untouched
});
test('a folder holding only documents is not empty: rmdir is refused, nothing trashed', () => {}); // Review Focus 1
// deleteItem(folder, { onlyIfEmpty: true }) → ENOTEMPTY; no remote trash op queued
test('Move to Trash of a folder holding documents behaves as before', () => {});
// pin today's behaviour for deleteItem(folder, { trash: true }); don't change it
// tests/controlServer.test.ts: /vfs/children passes placeholder through; an EPERM DriveOpError answers 400 { code: 'EPERM' }
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - **Listings:** `vfsChildren` adds the placeholders for `docNodes.listChildren(folderEntry.uid)` only when
    `inBackingStore()` (virtual mode).
    - Skip one whose name matches an index child, a local name (`localChildNames`), the ignore patterns, or
      `policy.hiddenBy`.
    - Keep the name sort.
  - **`placeholderAt(rel): DocRecord | null`:** the parent's index entry, plus a document named so. It must not be
    shadowed by a real item.
  - **Refusing:** `renameItem` (both sides), `deleteItem`, `truncateItem` and `hydrate` check `placeholderAt` first and
    throw `DriveOpError('EPERM', 'Proton Docs and Sheets open in the browser; they can't be changed here')`.
  - **Not empty:** `holdsAnything` returns true when `docNodes.anyChildren(entry.uid)`.
  - **Trash:** the trash path is not changed. Record in the report what it does today for a folder holding documents.

- [ ] **Step 4: Run the checks.** `bun test tests` and `bunx tsc --noEmit` pass.

- [ ] **Step 5: Commit** `feat(sync): the virtual drive lists Docs and Sheets as read-only placeholders`, with
  `Refs #430`.

### Task 3: The FUSE helper serves placeholders and refuses changes

**Files:**
- Modify: `native-vfs/src/daemon.rs` (`WireEntry`, `parse_children` and `errno_of_code`), `native-vfs/src/listing.rs`
  (`Entry`) and `native-vfs/src/fs.rs` (`Node`, `Handle`, `resolve`, `attr`, `open`, `read`, `write`, `setattr`,
  `remove_here`, `rename`, `create`, and the allow-lists at ~1473 and ~1278)
- Test: the unit tests in `fs.rs` (the `Gated` harness), the `daemon.rs` tests, and one test in `tests/mount.rs`

**Interfaces:**
- Consumes: Task 2's `placeholder` JSON field and the `EPERM` code.
- Produces: `Entry.placeholder: Option<Arc<[u8]>>`, `Node::Placeholder` and `Handle::Placeholder` (mirroring
  `VolumeInfo`).

- [ ] **Step 1: Write the failing tests**

```rust
// daemon.rs: a children reply with "placeholder": {"kind":"doc","content":"{...}\n"} parses into an Entry with that content;
//            errno_of_code("EPERM") == EPERM
// fs.rs (Gated): resolve gives Node::Placeholder; attr is a regular file 0o444 with size == content length;
//   open read-only succeeds with NO daemon call and read returns the content (Review Focus 4);
//   open for writing / O_TRUNC, setattr(size|mode|times), unlink (remove_here), rename from it, rename onto it,
//   create with its name → EPERM, and no request reaches the daemon; a placeholder open sends no writing/closed notice
// tests/mount.rs (gated): ls shows Plan.protondoc; cat prints the content; stat says 0444; rm / mv / truncate fail with EPERM
```

- [ ] **Step 2: Run them and see them fail.** `cd native-vfs && cargo test`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Mirror `VolumeInfo` for placeholders: entries with `placeholder` resolve to `Node::Placeholder`, served from
    memory.
  - Every change path returns `EPERM` before any daemon call.
  - Add `EPERM` to `errno_of_code`, and to the delete and rename allow-lists, so the daemon's own `EPERM` reaches the
    caller instead of `EIO`.
  - `rmdir` stays a daemon decision (`ENOTEMPTY` from Task 2).

- [ ] **Step 4: Run the checks.**
  - In `native-vfs/`: `cargo test` and `cargo clippy --all-targets` (0 warnings).
  - `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --test mount`: all pass, apart from the three CLAUDE.md names that need
    `fusermount3` if it's missing.

- [ ] **Step 5: Commit** `feat(vfs): serve Docs and Sheets placeholders read-only`, with `Refs #430`.

### Task 4: `protondrive open-doc` opens only Proton document links

**Files:**
- Create: `src/cli/openDoc.ts`
- Modify: `src/cli/main.ts` (dispatch before the unknown-command throw ~615, and a `printHelp` line)
- Test: `tests/openDoc.test.ts`

**Interfaces:**
- Produces:
  - `parseDocLink(text: string): { url: string; kind: 'doc' | 'sheet' } | null`;
  - `openDoc(path: string, deps: { open: (url: string) => void; notify: (title: string, body: string) => void }): Promise<number>`,
    which returns the exit code. `main.ts` passes `openBrowserUrl` and `sendDesktopNotification`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a placeholder\'s link is accepted', () => { /* the content Task 1 writes parses; kind and url as written */ });
test('anything but a Proton document link is refused', () => {                       // Review Focus 5
  for (const url of ['https://evil.example/doc?type=doc&volumeId=a&linkId=b', 'http://docs.proton.me/doc?type=doc&volumeId=a&linkId=b',
    'https://docs.proton.me.evil.example/doc?type=doc&volumeId=a&linkId=b', 'https://docs.proton.me/other?type=doc&volumeId=a&linkId=b',
    'https://docs.proton.me/doc?type=pdf&volumeId=a&linkId=b', 'https://docs.proton.me/doc?type=doc&linkId=b', 'javascript:alert(1)'])
    expect(parseDocLink(JSON.stringify({ type: 'doc', url, name: 'x' }) + '\n')).toBeNull();
  expect(parseDocLink('not json')).toBeNull();
});
test('openDoc opens a good link and exits 0; refuses a bad one, notifies, and exits 1; a file over 64 KiB is refused', async () => {});
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - Validate with `new URL`, using the exact checks in Global Constraints.
  - `openDoc` reads at most 64 KiB (stat first).
  - `main.ts` dispatches `open-doc <file>` without starting the runtime or contacting the daemon, and adds a help line.

- [ ] **Step 4: Run the checks.** `bun test tests` and `bunx tsc --noEmit` pass.

- [ ] **Step 5: Commit** `feat(cli): protondrive open-doc opens a Docs or Sheets placeholder in the browser`, with
  `Refs #430`.

### Task 5: Packaging registers the file types and the handler

**Files:**
- Create: `packaging/linux/io.github.kosidhar.ProtonDrive.xml` and
  `packaging/linux/io.github.kosidhar.ProtonDrive.OpenDoc.desktop`
- Modify:
  - `packaging/linux/install.sh`: both install branches, the uninstall block, a user-mode sed for this entry's `Exec`,
    and `update-mime-database`;
  - `packaging/linux/package.sh`: staging near `:68`, plus `desktop-file-validate` for the new entry;
  - `packaging/linux/postinst.sh`: `update-mime-database /usr/share/mime` when present;
  - the Flatpak manifest: two `install -Dm644` lines.
- Test: `tests/packaging.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('the MIME package declares both types with their globs and generic icons', () => {
  // parse the XML text: two <mime-type> with type="application/vnd.proton.doc" / "application/vnd.proton.sheet",
  // <glob pattern="*.protondoc"/> / "*.protonsheet", <generic-icon name="x-office-document"/> / "x-office-spreadsheet", comments verbatim
});
test('the open handler is hidden, takes both types, and runs protondrive open-doc', () => {
  // NoDisplay=true, MimeType=application/vnd.proton.doc;application/vnd.proton.sheet;, Exec=protondrive open-doc %f, Name=Proton Drive
});
test('install.sh installs both files, refreshes the MIME database, and removes them on uninstall', () => {
  // text checks on install.sh: both files appear in both install branches and in the uninstall block; update-mime-database present
});
test('package.sh stages both files under usr/share', () => {});
```

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - **User-mode Exec:** in user mode, `install.sh` rewrites the handler's `Exec` to
    `$PREFIX/bin/protondrive open-doc %f` (its own sed; the main entry's sed must not clobber it).
  - **Refresh:** `update-mime-database -n "$PREFIX/share/mime"`, guarded by `command -v`, next to
    `update-desktop-database`.
  - **Uninstall** removes both files and refreshes.

- [ ] **Step 4: Run every check.**
  - `bun test tests`, `bunx tsc --noEmit` and `bash -n` on the scripts;
  - `desktop-file-validate` on the new entry, if installed;
  - `xmllint --noout`, or `python3 -c` with ElementTree, on the XML;
  - the Python tray and Nautilus tests;
  - in `native-vfs/` and `native-gui/`: `cargo test` and clippy.

- [ ] **Step 5: Commit.** This commit also adds the spec and this plan.

```bash
git add packaging tests docs/superpowers/specs/2026-11-25-docs-sheets-placeholders-design.md docs/superpowers/plans/2026-11-25-docs-sheets-placeholders.md
git commit -m "feat(packaging): register Proton Docs and Sheets file types and their open handler

Fixes #430"
```

### After the plan (controller)

1. Install with the deploy procedure, and check on the owner's laptop:
   - placeholders appear in `~/ProtonDrive` beside the owner's Docs (for example `test.protondoc`, `Untitled document
     2026-05-07 18.55.25.protondoc`);
   - `xdg-mime query filetype` says `application/vnd.proton.doc`;
   - `gio open` opens the browser on the document;
   - `rm` and `mv` say "Operation not permitted";
   - a folder holding only a doc refuses `rmdir`.
2. The owner double-clicks one in Files.
