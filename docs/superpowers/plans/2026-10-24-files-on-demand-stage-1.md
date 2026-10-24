# Files On-Demand, Stage 1 (engine groundwork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace top-level-only "Cloud only" with per-item availability at any depth (Always keep, Downloaded, Online only, Hidden). It runs in plain-folder mode, driven from the app and the CLI.

**Architecture:**
- A persistent **remote index** (`remote_nodes`) records the whole *My files* tree.
- A **uid-keyed policy** (`availability`) holds explicit pin and hide flags.
- The sync engine downloads only what the policy says.
- Pin, free, hide and unhide are new engine operations, exposed on a user-only Unix control socket.
- The GUI and CLI show the new states and call the socket.
- `excludedFolders` is migrated once and retired.

**Tech Stack:** Bun 1.4 + TypeScript (`bun:sqlite`, `bun:test`), Rust/egui 0.31 GUI (`ureq`, `std::os::unix::net`).

**Spec:** `docs/superpowers/specs/2026-10-23-files-on-demand-design.md`. This plan covers delivery step 1 of §6. Stages 2–4 (virtual drive, Files integration, hardening) get their own plans once this has landed.

## Global Constraints

- **Policy key.** The policy is keyed by **node uid**, so renames and moves keep it. A node's effective pin comes from the nearest ancestor-or-self explicit flag. A hide flag is inherited by everything below.
- **Never trash cloud items through Free, Hide, migration or a crash.**
  - A record is always dropped *before* its local file or folder is removed.
  - The engine trashes a remote node only when its record still exists and the local item is still missing (the guard already in `reconcileSinglePath` case 1).
- **Free up space** keeps, in place:
  - items matching an ignore pattern;
  - non-regular files;
  - files that aren't unchanged synced copies.

  Those files stay *Downloaded*, and a notification says so.
- **Hide**
  - It is refused if the item contains ignored or non-regular items. Message: `Can't hide <relPath>: <blockingRelPath> exists only on this computer`.
  - It waits, as state `hiding`, while uploadable changes are still unsynced.
  - Unhide makes the item online-only.
- **Space is only freed when the user asks.**
- **Migration**
  - Every top-level item that is synced today becomes explicitly `pinned`.
  - Former `excludedFolders` become online-only (no flag, **not** hidden).
  - The database is backed up first.
- **The unauthenticated TCP API** (`127.0.0.1:49152`) gains **no** state-changing endpoints. Pin, free, hide and unhide go only through the control socket:
  - socket: `$XDG_RUNTIME_DIR/protondrive/control.sock`;
  - directory mode `0700`, socket mode `0600`;
  - fallback when `XDG_RUNTIME_DIR` is unset: `<os tmpdir>/protondrive-<uid>/control.sock`.
- **Copy**
  - Menu: `Always keep on this device`, `Free up space`, `Hide from this computer`, `Unhide`.
  - Pills: `Always keep`, `Downloaded`, `Online only`, `Hidden`, `Hiding…`.
- **Checks for every task**
  - `PATH=$HOME/.bun/bin:$PATH bun test tests` passes.
  - `PATH=$HOME/.bun/bin:$PATH bunx tsc --noEmit` is clean.
  - For GUI tasks: `cd native-gui && PATH=$HOME/.cargo/bin:$PATH cargo clippy --release --all-targets` reports 0 warnings, and `cargo test --release` passes.
- **Commits:** conventional style, authored by the repo user, with **no** Claude/Anthropic attribution or Co-Authored-By line. Reference the tracking issue (`Refs #N`) created before Task 1.

## Review Focus

1. **Names that differ only in case, or contain `_`, `%` or non-ASCII** (`Photos` vs `photos`, `my_docs`, NFC vs NFD `é`). Index and policy lookups must match byte-exactly, never through `LIKE`.
   - Pinned in **Task 1** (index paths) and **Task 2** (policy).
2. **Deleting a partly downloaded folder locally in plain-folder mode.**
   - The user sees 2 files and deletes the folder. The 500 online-only files they never saw must not be trashed.
   - Trash only the descendants that had local records, and leave the folder online-only.
   - Pinned in **Task 4**.
3. **A pinned or hidden folder renamed or moved in the cloud.** The flag follows the uid, and the index rewrites the subtree's paths.
   - Pinned in **Task 3** and **Task 2**.
4. **Free or Hide while a download or upload into that folder is in flight.**
   - The `.proton-drive-tmp-*` file is changing, and a record may be written mid-removal.
   - Nothing that changed may be deleted, and no record may be left without its file.
   - Pinned in **Task 5**.
5. **Pinning a deep folder whose ancestors are online-only.**
   - The ancestors are created locally as plain directories and stay online-only in the app.
   - Siblings are not downloaded.
   - Pinned in **Task 4**.

---

### Task 0: Tracking issue

- [ ] **Step 1:** Create the issue and note its number. Every later commit gets `Refs #N`; Task 10's commit gets `Fixes #N`.

```bash
gh issue create --title "Files On-Demand stage 1: per-item availability (Always keep / Downloaded / Online only / Hidden)" \
  --body "Implements delivery step 1 of docs/superpowers/specs/2026-10-23-files-on-demand-design.md (plan: docs/superpowers/plans/2026-10-24-files-on-demand-stage-1.md)."
```

---

### Task 1: Remote index

**Files:**
- Create: `src/sync/remoteIndex.ts`
- Modify: `src/sync/syncStateDb.ts`: add `get connection(): Database`, returning the private `db`.
- Test: `tests/remoteIndex.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RemoteIndexEntry {
      uid: string; parentUid: string | null; relPath: string; name: string;
      type: 'file' | 'folder'; size: number; mtimeMs: number; sha1: string | null;
  }
  export function entryFromNode(node: NodeEntity, parentRelPath: string): RemoteIndexEntry | null; // null if isUnsupportedRemoteNode
  export class RemoteIndex {
      constructor(db: Database);                       // creates remote_nodes (uid PK, parentUid, relPath UNIQUE, name, type, size, mtimeMs, sha1) + index on parentUid
      setRoot(uid: string): void;                      // stores the root as relPath ''
      replaceChildren(parentUid: string, parentRelPath: string, children: RemoteIndexEntry[]): void; // exact child set; vanished children lose their subtree
      upsert(entry: RemoteIndexEntry): void;           // same uid at a new relPath: rewrites its whole subtree's relPaths
      removeSubtree(uid: string): void;
      getByUid(uid: string): RemoteIndexEntry | null;
      getByPath(relPath: string): RemoteIndexEntry | null;
      listChildren(relPath: string): RemoteIndexEntry[];
  }
  ```
  - Subtree selection reuses the byte-exact range from `syncStateDb.ts` (`relPath >= p||'/' AND relPath < p||'0'`). Move `SELF_OR_DESCENDANT` and `selfOrDescendant` into `src/sync/pathRange.ts`, parameterised by column name, and import them in both files.
  - `relPath` is `''` for the root and has no leading slash.

- [ ] **Step 1: Write the failing tests** in `tests/remoteIndex.test.ts`, with a fresh `SyncStateDatabase` in a temp dir and `new RemoteIndex(stateDb.connection)`:
  - `replaceChildren removes vanished children and their subtrees`: index `A/x.txt` and `A/B/y.txt`, then `replaceChildren(rootUid, '', [])`. Expect `getByPath('A/B/y.txt')` to be `null`.
  - `upsert of a moved folder rewrites its subtree`: move `A` (uid `a`) to `Z/A`. Expect `getByPath('Z/A/B/y.txt')?.uid === 'y'` and `getByPath('A/B/y.txt') === null`.
  - `paths match byte-exactly`: index `Photos/a`, `photos/b`, `my_docs/x`, `my-docs/y`, `café/n` (NFC) and `café/d` (NFD). Expect `listChildren('Photos').map(e => e.name)` to equal `['a']`, and `removeSubtree(uid of my_docs)` to leave `my-docs/y`. `getByPath` of the NFC path must not return the NFD entry.
  - `entryFromNode` maps `claimedSize`, `claimedModificationTime` and `claimedDigests.sha1`, and returns `null` for an unsupported node. Reuse `makeMockNode` from `tests/syncEngine.test.ts` by moving it into `tests/helpers/mockNodes.ts`.
- [ ] **Step 2: Run** `PATH=$HOME/.bun/bin:$PATH bun test tests/remoteIndex.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/sync/pathRange.ts`, `src/sync/remoteIndex.ts` and the `connection` getter.
- [ ] **Step 4: Run** the full TS test suite and `tsc`. Expected: all pass, including `tests/syncStateDb.test.ts`.
- [ ] **Step 5: Commit** `feat(sync): add a persistent index of the remote My files tree` (Refs #N).

---

### Task 2: Availability policy

**Files:**
- Create: `src/sync/availability.ts`
- Test: `tests/availability.test.ts`

**Interfaces:**
- Consumes: `RemoteIndex` and `RemoteIndexEntry` (Task 1); the `synced_items` table on the same connection.
- Produces:
  ```ts
  export type PinFlag = 'pinned' | 'unpinned';
  export type HideFlag = 'pending' | 'hidden';
  export type ItemAvailability = 'pinned' | 'downloaded' | 'online-only' | 'hidden' | 'hiding';
  export class AvailabilityPolicy {
      constructor(db: Database, index: RemoteIndex);   // creates availability (nodeUid PK, pin TEXT NULL, hide TEXT NULL)
      setPin(uid: string, pin: PinFlag | null, clearBelow: boolean): void;   // clearBelow: drop pin flags of all indexed descendants
      setHide(uid: string, hide: HideFlag | null): void;                     // setting a hide also drops descendants' pin and hide flags
      isPinned(relPath: string): boolean;               // nearest ancestor-or-self explicit pin; default false
      hiddenBy(relPath: string): { relPath: string; hide: HideFlag } | null; // self or nearest ancestor with a hide flag
      hasPinnedBelow(relPath: string): boolean;
      stateOf(relPath: string): ItemAvailability;
      pendingHides(): string[];                         // relPaths whose own hide flag is 'pending'
  }
  ```
- `stateOf` rules (spec §2.3 and §5.5):
  1. A hide on the item or an ancestor gives `hidden` or `hiding`.
  2. A file is `pinned` if `isPinned`, otherwise `downloaded` if `synced_items` has its path, otherwise `online-only`.
  3. A folder is `pinned` if `isPinned`. Otherwise it is `downloaded` when no indexed file under it lacks a `synced_items` row (one SQL `NOT EXISTS` over the range), and `online-only` when one does.

- [ ] **Step 1: Write the failing tests** (index a small tree `Docs/{a.txt,b.txt}`, `Docs/Deep/c.txt` and `Music/s.mp3`, with records for the local files):
  - `pin inherits and the nearest flag wins`: `setPin(docs, 'pinned')` and `setPin(deep, 'unpinned')`. Expect `isPinned('Docs/a.txt')` to be true and `isPinned('Docs/Deep/c.txt')` to be false.
  - `clearBelow drops descendant flags`: then `setPin(docs, 'pinned', true)`. Expect `isPinned('Docs/Deep/c.txt')` to be true.
  - `folder state follows its contents`: with records for `Docs/a.txt` and `Docs/b.txt` only, expect `stateOf('Docs')` to be `'online-only'`. After adding a record for `Docs/Deep/c.txt`, expect `'downloaded'`.
  - `hide wins over pin and is inherited`: `setHide(docs, 'pending')`. Expect `stateOf('Docs/Deep/c.txt')` to be `'hiding'` and `pendingHides()` to equal `['Docs']`.
  - `flags follow a moved uid`: `index.upsert` Docs at `Archive/Docs`. Expect `isPinned('Archive/Docs/a.txt')` to be true.
  - `case-only sibling is unaffected`: pinning `Photos` leaves `photos/x` `online-only`.
- [ ] **Step 2: Run** `bun test tests/availability.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `AvailabilityPolicy`. Ancestor lookups walk `parentUid` through `RemoteIndex.getByUid`.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(sync): add a uid-keyed pin and hide policy` (Refs #N).

---

### Task 3: Keep the index current from the engine

**Files:**
- Modify: `src/sync/syncEngine.ts`: constructor, `reconcileNow`, `reconcileDirectoryIncremental`, `handleRemoteDriveEvent`
- Test: `tests/syncEngine.test.ts` (new `describe('remote index')`)

**Interfaces:**
- Consumes: `RemoteIndex`, `entryFromNode` (Task 1); `AvailabilityPolicy` (Task 2).
- Produces:
  - `ProtonDriveSyncEngine` creates `this.index = new RemoteIndex(stateDb.connection)` and `this.policy = new AvailabilityPolicy(stateDb.connection, this.index)`.
  - Public getters: `get remoteIndex(): RemoteIndex` and `get availability(): AvailabilityPolicy`.
- **Behaviour**
  - `reconcileNow` calls `index.setRoot(root.uid)`.
  - Every `listFolderChildren` result in `reconcileDirectoryIncremental` goes into `index.replaceChildren(folderNode.uid, prefix, …)`.
  - Remote folders that are **not** recursed into because they are absent locally are still crawled by a new `private async indexRemoteSubtree(node: NodeEntity, relPath: string): Promise<void>`. It only lists and records, and skips subtrees where `policy.hiddenBy(relPath)` is set.
  - In `handleRemoteDriveEvent`, NodeDeleted and NodeUpdated-with-`isTrashed` call `index.removeSubtree(event.nodeUid)` before any local handling.

- [ ] **Step 1: Write the failing tests**, using the mock SDK pattern of the existing two-way sync test:
  - `indexRemoteSubtree records a subtree without touching disk`: the remote has `Archive/2025/tax.pdf`. Call `(engine as any).indexRemoteSubtree(archiveNode, 'Archive')` directly, after `index.setRoot`. Expect `engine.remoteIndex.getByPath('Archive/2025/tax.pdf')` to be non-null and no local `Archive` directory to exist. (Before Task 4 a reconcile downloads everything, so the "absent locally" path can't be reached through `reconcileNow` yet. Never delete a synced folder locally in a test: that trashes it.)
  - `a remote rename moves the subtree in the index`: rename node `Archive` to `Old` in the mock, then reconcile. Expect `getByPath('Old/2025/tax.pdf')` to be non-null and `getByPath('Archive')` to be null.
  - `a NodeDeleted event removes the subtree`: fire the event through the captured listener. Expect `getByPath('Archive/2025/tax.pdf')` to be null.
- [ ] **Step 2: Run** `bun test tests/syncEngine.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(sync): keep the remote index current during reconcile and on events` (Refs #N).

---

### Task 4: Policy-driven downloads, migration, and retiring `excludedFolders`

**Files:**
- Create: `src/sync/availabilityMigration.ts`
- Modify:
  - `src/sync/syncEngine.ts`: `reconcileSinglePath` case 1, `reconcileDirectoryIncremental`, `handleLocalFileChange`, watcher config.
    - **Delete** the `excludedFolders` driver: `applySelectiveSyncExclusions(Now)`, `refuseCloudOnly`, `reportUnsyncedLocalCopy`, `logCloudOnlyRemoval`, `syncFoldersPriority` and `listRemoteTopLevelFolders`.
    - **Move**, unchanged in behaviour, `scanFolderForCloudOnly` (as `scanLocalCopies`, stopping at the first blocker), `removeScannedCloudOnlyFolder` (as `removeScannedEntries`, all-or-nothing), `isEngineTempName` and `treeEntrySignature` into new `src/sync/localCopies.ts`. Task 5 extends them.
    - Keep `isUnchangedSyncedCopy`, `markFoldersSyncing`/`syncingFolders` (Task 5's pin uses them with full relPaths) and the `exclusionRun` chain, renamed `availabilityRun`.
  - `src/sync/localWatcher.ts`: replace `getIgnoreConfig` with `shouldIgnore: (relPath: string) => boolean`; drop the `excludedTopFolders` parameter of `matchesIgnorePatterns`.
  - `src/sync/syncStateDb.ts`: drop `excludedFolders` from `SyncSettings` (the stored key stays readable for the migration, through `readLegacyExcludedFolders(): string[]`), and add `getMeta(key)` / `setMeta(key, value)` on the settings table.
  - `src/daemon/daemonServer.ts`: run the migration before `engine.start()`; remove the `excludedFolders` handling in `/api/settings`; remove `/api/selective-sync/folders`; switch `buildFallbackFromStateDb` to the index.
- Test: `tests/availabilityMigration.test.ts`, `tests/localCopies.test.ts` and `tests/syncEngine.test.ts`.
  - Move the `Cloud only` removal tests (all-synced removal, refusal reasons, new file / edit / switch-back mid-removal, symlink inside blocks) to `tests/localCopies.test.ts`, calling `scanLocalCopies` and `removeScannedEntries` directly.
  - Drop the tests that only make sense for `excludedFolders`: reappeared folder, invalid names, stale records.
  - Move their helpers (`writeSynced`, `writeLocal`, `exists`, `recordCount`, `expectNoRecordWithoutFile`, `onRemoval`) into `tests/helpers/localFiles.ts`.
  - Update `matches ignore patterns…` for the new two-argument `matchesIgnorePatterns` (drop the `Archive` case).

**Interfaces:**
- Consumes: `AvailabilityPolicy` and `RemoteIndex` (Tasks 2–3).
- Produces:
  ```ts
  export async function migrateExcludedFolders(stateDb: SyncStateDatabase, policy: AvailabilityPolicy, dbFilePath: string): Promise<'migrated' | 'already-done'>;
  ```
  1. If meta `availabilityMigrated` is `'1'`, do nothing.
  2. Otherwise run `VACUUM INTO '<dbFilePath>.pre-availability.bak'`.
  3. For every `synced_items` row whose path has no `/`, call `setPin(nodeUid, 'pinned', false)`.
  4. Store `[]` as `excludedFolders`, then set the meta.

  Every step is idempotent.
- **Download rule** (spec §5.2):
  - A remote file with no record and no local copy is downloaded only when `policy.isPinned(relPath)`.
  - A remote folder is created locally only when `isPinned` or `hasPinnedBelow`.
  - Items under `hiddenBy(…)` are skipped entirely, and their listings aren't recursed.
  - Existing local copies (with a record) keep updating as today.
  - The watcher's `shouldIgnore` combines `matchesIgnorePatterns(relPath, ignorePatterns)` with `policy.hiddenBy(relPath) !== null`.
- **Local folder deletion with online-only content** (Review Focus 2). When case 1 or `handleLocalFileChange` sees a deleted folder whose index subtree holds files without records:
  - trash only the remote nodes of the subtree's files and folders **that had records**;
  - drop the records, and leave the folder online-only.

  Without such files, trash the folder as today.

- [ ] **Step 1: Write the failing tests**
  - `migration pins today's synced top-level items, leaves Cloud only folders unpinned and is idempotent`: records for `Docs/a.txt`, `Docs` and `notes.txt`, plus legacy `excludedFolders = ['Archive']`. Expect:
    - `isPinned('Docs/a.txt')` and `isPinned('notes.txt')` are true;
    - `stateOf('Archive')` is not `'hidden'`;
    - the `.pre-availability.bak` file exists;
    - a second call returns `'already-done'`.
  - `new remote files download only under a pin` (engine and mock SDK): pin `Docs` only. Expect a remote `Docs/new.txt` to download, a remote `Other/x.txt` not to (no local `Other`), and `Other` to appear in the index.
  - `pinning a deep folder creates online-only ancestors but not siblings` (Review Focus 5): pin `A/B/C`. Expect `A/B/C/f.txt` to be downloaded, `A/sibling.txt` not, and `stateOf('A')` to be `'online-only'`.
  - `hidden items are never downloaded or uploaded`: `engine.availability.setHide(secretUid, 'hidden')`, then create local `Secret/x.txt`. Expect no upload call and no download.
  - `deleting a partly downloaded folder trashes only what was local` (Review Focus 2): `Photos` has records for `a.jpg` only, and the index also has `b.jpg` … `z.jpg`. `rm -r` the local `Photos` and reconcile. Expect `trashNodes` to have been called with exactly `[a.jpg]`, and the folder node not trashed.
  - Keep the existing two-way sync test passing, with the root pinned: `engine.availability.setPin('vol~root', 'pinned', false)` before `engine.start()`. `isPinned` reaches the root through the index once `reconcileNow` has called `setRoot`.
- [ ] **Step 2: Run** the suite. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the migration, the download rule, the partial-delete rule, the watcher change, and the removals and edits listed under Files.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(sync): download by pin, migrate Cloud only folders and retire excludedFolders` (Refs #N).

---

### Task 5: Pin, free, hide and unhide

**Files:**
- Modify: `src/sync/localCopies.ts` (from Task 4): add `stopAtFirst: false` and `mode: 'keep-changed'`
- Modify: `src/sync/syncEngine.ts`
- Test: `tests/localCopies.test.ts`, `tests/syncEngine.test.ts` (`describe('availability actions')`)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  // localCopies.ts
  export type LocalOnlyReason = 'ignored' | 'not-a-file' | 'not-in-cloud';
  export interface LocalOnlyItem { relPath: string; reason: LocalOnlyReason }
  export interface ScanEntry { relPath: string; signature: string }
  export async function scanLocalCopies(opts: {
      syncDir: string; relPath: string; ignorePatterns: string[]; stopAtFirst: boolean;
      isUnchangedSyncedCopy(relPath: string, fullPath: string, st: Stats): Promise<boolean>;
  }): Promise<{ localOnly: LocalOnlyItem[]; entries: ScanEntry[] }>;
  export async function removeScannedEntries(opts: {
      syncDir: string; entries: ScanEntry[]; keep: Set<string>; mode: 'all-or-nothing' | 'keep-changed';
      dropRecord(relPath: string): void; shouldContinue(): boolean;
  }): Promise<{ complete: boolean; kept: string[] }>;
  // syncEngine.ts
  export type AvailabilityAction = 'pin' | 'free' | 'hide' | 'unhide';
  export interface AvailabilityResult { state: ItemAvailability; kept: string[]; refused: string | null }
  async setAvailability(relPath: string, action: AvailabilityAction): Promise<AvailabilityResult>; // throws Error(`Not in Proton Drive: ${relPath}`) when the index has no such path
  ```
- **`removeScannedEntries` modes**
  - `all-or-nothing` is the #9 behaviour: stop on a changed signature or a non-empty directory.
  - `keep-changed` skips `keep` entries and changed files, and treats ENOTEMPTY as "holds kept items" (adds it to `kept`, continues).
  - Both drop the record before each unlink or rmdir, and never remove recursively.
  - `.proton-drive-tmp-*` regular files count as changed when their signature differs.
- **Actions**, serialised through the existing `exclusionRun` chain (rename it `availabilityRun`). `relPath ''` (root) is allowed for pin and free only.
  - **`pin`:** `setPin(uid, 'pinned', true)`, then reconcile that subtree now: `reconcileDirectoryIncremental` for a folder after `mkdir -p` of its ancestors, or `reconcileSinglePath` for a file.
  - **`free`:** `setPin(uid, 'unpinned', true)`, then scan with `stopAtFirst: false` and remove with `mode: 'keep-changed'`, keeping the scan's `localOnly`. If `kept` isn't empty, send one notification: `<n> item(s) in <relPath> stayed on this computer because they aren't in Proton Drive yet (e.g. <first>)`.
  - **`hide`:**
    1. Scan with `stopAtFirst: false`. Any `ignored` or `not-a-file` item means refuse, with `refused` set to the exact message from Global Constraints and no flag set.
    2. Else, if any item is `not-in-cloud`, call `setHide(uid, 'pending')` and return `state: 'hiding'`.
    3. Else call `setHide(uid, 'hidden')` and remove with `all-or-nothing`. If the removal stops, set the flag back to `'pending'`.
  - **`unhide`:** `setHide(uid, null)`. The state is then `online-only`.
  - **`completePendingHides()`** runs at the end of every `reconcileNow`. It re-runs the hide logic for each `policy.pendingHides()` entry.

- [ ] **Step 1: Write the failing tests.** In `tests/localCopies.test.ts`, add `keep-changed` mode cases next to the moved all-or-nothing ones. In `tests/syncEngine.test.ts`, add:
  - `unhide during a hide's removal stops it with no record left without its file`, using the `onRemoval` helper;
  - `an unknown path is rejected`: `setAvailability('Nope', 'pin')` rejects with `Not in Proton Drive: Nope`;
  - `free keeps ignored and edited files and drops only unchanged copies`: `Code/app/.git/HEAD`, edited `Notes/todo.txt` and unchanged `Code/main.ts`. Expect:
    - `.git/HEAD` and `todo.txt` still exist;
    - `main.ts` is gone and has no record;
    - `result.kept` contains both kept paths;
    - `stateOf('Code/main.ts')` is `'online-only'`.
  - `hide is refused for never-uploaded content with the exact message`: expect `result.refused` to be `"Can't hide Code: Code/app/.git exists only on this computer"` and `stateOf('Code')` not to be hidden or hiding.
  - `hide waits for uploads, then completes`: an untracked `Drafts/new.txt` gives `state: 'hiding'`. After a mock upload records it and `reconcileNow()` runs, `stateOf('Drafts')` is `'hidden'` and `Drafts` is gone locally.
  - `free during an in-flight download keeps the growing temp file and leaves no record without a file` (Review Focus 4): grow `Docs/.proton-drive-tmp-1-2-x` from the `dropRecord` hook. Expect it to survive and `expectNoRecordWithoutFile('Docs')` to pass.
  - `pin downloads a whole online-only subtree`: expect every file under the pinned folder to be downloaded, and `stateOf` to be `'pinned'`.
- [ ] **Step 2: Run** the suite. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the new `localCopies.ts` modes and the engine actions.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass. Mutation-check:
  - `keep-changed` without the `keep` set must fail the free test;
  - removing the hide refusal must fail the refusal test;
  - removing `completePendingHides` must fail the waiting test.
- [ ] **Step 5: Commit** `feat(sync): add pin, free, hide and unhide with local-only safety` (Refs #N).

---

### Task 6: Control socket and daemon wiring

**Files:**
- Create: `src/daemon/controlServer.ts`
- Modify: `src/daemon/daemonServer.ts`: start and stop the control server; add `availability` to `/api/remote/list` items for `/my-files` paths
- Test: `tests/controlServer.test.ts`

**Interfaces:**
- Consumes: `engine.setAvailability` (Task 5), `engine.availability.stateOf` (Task 2).
- Produces:
  ```ts
  export function defaultControlSocketPath(): string;  // $XDG_RUNTIME_DIR/protondrive/control.sock, else <os.tmpdir()>/protondrive-<uid>/control.sock
  export function startControlServer(opts: { socketPath: string; engine: Pick<ProtonDriveSyncEngine, 'setAvailability' | 'availability'> }): { stop(): void };
  ```
- **Startup:** create the directory with mode `0700`. Remove a stale socket file (connecting to it fails with ECONNREFUSED or ENOENT). Then `Bun.serve({ unix })`, then `chmod 0600`.
- **Routes**
  - `POST /availability` with body `{ path: string, action: AvailabilityAction }` returns `AvailabilityResult` as JSON.
  - `GET /availability?path=` returns `{ path, state }`.
  - An unknown action, or a `setAvailability` rejection (such as `Not in Proton Drive: …`), gives 400 with `{ error: message }`.
- **`/api/remote/list` items** gain `availability: ItemAvailability`. `relPath` is the item path with `/my-files/` stripped.

- [ ] **Step 1: Write the failing tests** against a fake engine, on a socket in a temp dir:
  - `POST /availability forwards and returns the result`: `fetch('http://localhost/availability', { unix: socketPath, method: 'POST', body: JSON.stringify({ path: 'Docs', action: 'free' }) })`. Expect the fake to have been called with `('Docs', 'free')` and the JSON to round-trip.
  - `socket is user-only`: `statSync(socketPath).mode & 0o777` is `0o600`, and the directory's mode is `0o700`.
  - `a stale socket file is replaced`: create a plain file at the path. Expect the server to start and answer.
  - `bad action is 400`.
- [ ] **Step 2: Run** `bun test tests/controlServer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the control server and the daemon wiring.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(daemon): add a user-only control socket for availability actions` (Refs #N).

---

### Task 7: CLI

**Files:**
- Create: `src/cli/availabilityCommands.ts`
- Modify: `src/cli/main.ts` (help text, dispatch). `selective-sync exclude|include|list` becomes hide, unhide, and a list of top-level folders with their availability read from `GET /api/remote/list?path=/my-files`.
- Test: `tests/availabilityCommands.test.ts`

**Interfaces:**
- Consumes: `defaultControlSocketPath`, the `/availability` routes (Task 6).
- Produces:
  ```ts
  export function toMyFilesRelPath(input: string, syncDir: string): string;  // accepts '<syncDir>/a/b', '/my-files/a/b', 'a/b/'; returns 'a/b'; throws for paths outside
  export async function runAvailabilityCommand(action: AvailabilityAction | 'status', input: string, syncDir: string): Promise<number>; // exit code
  ```
- **Commands:** `protondrive pin|free|hide|unhide <path>`, and `protondrive status <path>` (`status` without a path keeps today's output).
- **Output**
  - Success prints the new state, plus kept items or the refusal.
  - No daemon: print `The Proton Drive daemon isn't running; start it with "protondrive daemon".` and exit with code 2.

- [ ] **Step 1: Write the failing tests:**
  - `toMyFilesRelPath` normalises the three accepted forms;
  - it throws for `/etc/passwd` and for `..` escapes;
  - `runAvailabilityCommand` against a fake control server prints the refusal and returns exit code 1;
  - it returns 2 when the socket doesn't exist.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the help text.
- [ ] **Step 4: Run** the suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(cli): add pin, free, hide, unhide and status <path>` (Refs #N).

---

### Task 8: GUI, showing the states

**Files:**
- Modify: `native-gui/src/main.rs`
  - `RemoteItem` gets `#[serde(default)] availability: Option<String>`.
  - `SyncSettings` drops `excluded_folders`.
  - The status column and the folder icon take their state from `availability`.
  - Remove `is_excluded`, `pending_sync_folders` and the top-level-only toggling.
  - New screenshot-only flag `--remote-fixture <file.json>`, which loads a `RemoteListResponse` instead of calling the daemon.

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, PartialEq, Eq, Debug)]
  enum Availability { Pinned, Downloaded, OnlineOnly, Hidden, Hiding }
  fn parse_availability(s: Option<&str>) -> Availability;           // unknown or None -> OnlineOnly
  fn availability_pill(a: Availability) -> (&'static str, PillStyle); // labels exactly as in Global Constraints
  enum PillStyle { SolidGreen, OutlineGreen, Muted }
  ```
- **Hidden and hiding rows:** name and icon in `TEXT_MUTED()`. Hidden folders aren't navigable, with the tooltip `Hidden from this computer. Right-click to unhide.`
- **Transient states:** the existing syncing pill still overrides the state while `status.syncing_folders` contains the item's relPath, or an active transfer's `rel_path` is the item or under it.

- [ ] **Step 1: Write the failing unit tests** in the `tests` module:
  - `parse_availability` maps all five strings, and `None`/unknown to `OnlineOnly`;
  - `availability_pill` returns `("Always keep", SolidGreen)`, `("Downloaded", OutlineGreen)`, `("Online only", Muted)`, `("Hidden", Muted)` and `("Hiding…", Muted)`.
- [ ] **Step 2: Run** `cd native-gui && PATH=$HOME/.cargo/bin:$PATH cargo test --release`. Expected: FAIL (not defined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify**
  - Tests and clippy are clean.
  - Write a fixture with one item per state, plus a long name. Look at screenshots at 840×540 and 1440×900 (`--tab browser --remote-fixture … --screenshot …`): pills don't overlap, hidden rows are muted, and the column layout is unchanged.
- [ ] **Step 5: Commit** `feat(gui): show Always keep, Downloaded, Online only and Hidden in My files` (Refs #N).

---

### Task 9: GUI, actions

**Files:**
- Modify: `native-gui/src/main.rs`
  - Add a control socket client.
  - Add `WorkerCommand::SetAvailability { path, action }` and `WorkerEvent::AvailabilityDone(Result<AvailabilityResult, String>)`.
  - Add a row context menu (right-click on the row, or a click on the pill).
  - Toolbar: replace `Sync All` / `Cloud Only All` with `Keep all` / `Free up all`, acting on the current folder.
  - Add a notice line.
  - Replace the Cloud only confirm modal: a confirm for Hide (single item) and for Free up all.
  - Screenshot flags `--row-menu <name>`, `--confirm-hide <name>` and `--confirm-free-all` replace `--confirm-cloud-only`.

**Interfaces:**
- Consumes: the `/availability` routes (Task 6), and `Availability` (Task 8).
- Produces:
  ```rust
  fn control_socket_path() -> std::path::PathBuf;   // same rule as defaultControlSocketPath; uid from std::fs::metadata("/proc/self") (MetadataExt::uid)
  fn control_request(method: &str, path_and_query: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value, String>;
  fn menu_actions(a: Availability, is_root: bool) -> Vec<(&'static str, &'static str)>; // (label, action)
  #[derive(Deserialize)] struct AvailabilityResult { state: String, kept: Vec<String>, refused: Option<String> }
  ```
- **`control_request`:** HTTP/1.1 over `UnixStream`, with `Connection: close` and a 10 s read timeout. Parse the status line and `Content-Length`. A non-2xx status gives `Err(body.error)`.
- **`menu_actions`**
  - Show `Always keep on this device` unless `Pinned`.
  - Show `Free up space` when `Pinned` or `Downloaded`.
  - Show `Hide from this computer` unless `Hidden` or `Hiding`, and not on the root.
  - Show `Unhide` when `Hidden` or `Hiding`.
- **Notice:** after an action, show `refused`, or the kept-items sentence, as a dismissible line above the table (warning colours, ✕ button). Then reload the current path and the status.
- **Toolbar widths:** re-measure the new labels and update `TOOLBAR_SYNC_ALL_W` and `TOOLBAR_CLOUD_ONLY_ALL_W`, renaming them `TOOLBAR_KEEP_ALL_W` and `TOOLBAR_FREE_ALL_W`. The existing toolbar layout test must stay green.

- [ ] **Step 1: Write the failing unit tests:**
  - `menu_actions` for each state, plus root (no Hide on root);
  - `control_request` against a `UnixListener` test thread:
    - a well-formed `200` reply with a JSON body and correct `Content-Length` parses to that JSON;
    - a `400` reply with `{"error":"Not in Proton Drive: x"}` yields `Err("Not in Proton Drive: x")`;
  - `control_socket_path` honours `XDG_RUNTIME_DIR`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify**
  - Tests and clippy are clean.
  - Screenshots at 840×540 and 1440×900 of `--row-menu`, `--confirm-hide Projects` and `--confirm-free-all` with the fixture: the menu shows the right items per state, and the dialogs fit.
- [ ] **Step 5: Commit** `feat(gui): pin, free, hide and unhide from My files` (Refs #N).

---

### Task 10: Deploy and acceptance on the real install

**Files:** none. Verification only, plus the closing commit if a fix is needed.

- [ ] **Step 1: Back up and record the starting state.**
  - Copy `~/.local/share/proton-drive-ubuntu/ubuntu-sync-state.sqlite` to the scratchpad.
  - Record `curl -s http://127.0.0.1:49152/api/status` (stats, `excludedFolders`) and `du -s ~/ProtonDrive`.
- [ ] **Step 2: Build and install**
  - `bun run build`, the GUI release build, and `install -Dm755 native-gui/target/release/protondrive-gui release/protondrive-gui && ./packaging/linux/install.sh --user`.
  - Restart the daemon only while idle (`POST /api/quit`, then `setsid -f ~/.local/bin/protondrive daemon`).
- [ ] **Step 3: Check the migration**
  - `.pre-availability.bak` exists.
  - `excludedFolders` is `[]`.
  - The seven former Cloud only folders show `Online only` in `GET /api/remote/list?path=/my-files`, and every previously synced top-level folder shows `Always keep`.
  - `du -s ~/ProtonDrive` is unchanged.
  - The activity log has no new `delete-local`, `trash-remote` or `download` entries for existing items.
- [ ] **Step 4: Run the acceptance actions on a throwaway folder**
  - Create `~/ProtonDrive/fod-test/{a.txt,.git/HEAD}` and wait for the upload.
  - `protondrive free fod-test` keeps `.git/HEAD` and removes `a.txt`; the app shows `Online only`.
  - `protondrive hide fod-test` is refused with the exact message.
  - Remove `.git`; `hide` succeeds; the app shows `Hidden`, greyed.
  - `unhide` gives `Online only`.
  - `pin` re-downloads `a.txt`.
  - Clean up with `rm -r ~/ProtonDrive/fod-test`. The activity log then shows `trash-remote` for it, and it sits in the Proton Drive trash.
- [ ] **Step 5: Screenshot and close**
  - Screenshot My files at 840×540 and 1440×900 from the installed GUI, against the live daemon.
  - Commit any fix with `Fixes #N` and push. If nothing needed fixing, close the issue with `gh issue close <N> --comment "Stage 1 deployed and verified on a real install"`.
