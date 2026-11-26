# Shared with me page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shared with me page in the app that lists invitations and the items others share with the owner, with
Accept, Decline, Open, Download and Leave.

**Architecture:**
- A new daemon service, `src/daemon/sharedWithMe.ts`, holds every SDK call. Thin routes on the control socket expose
  it, next to the share routes.
- The app gets a model module (`shared_with_me.rs`) and a view module (`shared_with_me_view.rs`), built in the Shared
  page's patterns, plus a new sidebar entry.

**Tech Stack:** Bun/TypeScript (`bun test`), Rust/egui (`cargo test`, the `Harness` in `native-gui/src/main.rs` tests).

**Spec:** `docs/superpowers/specs/2026-11-25-shared-with-me-page-design.md` (issue #487)

## Global Constraints

- **Words, verbatim:**
  - the sidebar and title `Shared with me`;
  - buttons `Accept`, `Decline`, `Open`, `Download`, `Leave`, `Refresh`, `Retry`, `Show in Files`, `Cancel`;
  - access `Viewer`, `Editor`, `Admin`;
  - section `Invitations`;
  - columns `Name`, `Shared by`, `Shared`, `Access`.
- **Empty state:** `Files and folders that others shared with you will appear here`.
- **Note below the list:** `Saved links and shared photos are on drive.proton.me`.
- **Unverified Accept question:**
  - with a claimed email: `Proton couldn't verify that this invitation is from <email>. Accept it only if you expected it.`;
  - without one: `Proton couldn't verify who sent this invitation. Accept it only if you expected it.`
- **Leave question:** `Leave <name>? It will no longer be shared with you. Only the person who shared it can share it again.`
- **Row notes:** `Downloading…`, `Saved to Downloads`, `Accepted, it will appear shortly`. After an accept, the page
  reloads once more after 5 s.
- **Activity texts:** `Accepted an invitation to <name>`, `Declined an invitation to <name>`, `Left <name>`,
  `Downloaded <name> to Downloads`. No email address ever goes in the activity or the log.
- **Open fallback URL:** `https://drive.proton.me/shared-with-me`.
- **Download:**
  - the destination is `xdg-user-dir DOWNLOAD`, else `~/Downloads`, created if missing;
  - names go `name.ext`, then `name (1).ext`, `name (2).ext` and so on;
  - it never overwrites;
  - the temp prefix is `.proton-drive-tmp-`;
  - it refuses if the download would leave less than `LOCAL_RESERVE_BYTES` (`src/sync/syncEngine.ts`) free;
  - files only; folders, Docs and Sheets are refused.
- **Routes** are on the control socket only, never on TCP (add them to `src/daemon/tcpRefusals.ts`, as the share routes are).
- **Data safety:** nothing here reads or writes My files, records, the index, the sync or the drive.
- **Repo rules:**
  - branch `feat/487-shared-with-me-page`;
  - conventional commits, with the last one saying `Fixes #487`;
  - no AI attribution;
  - every check in CLAUDE.md passes before the push.
- **Safety for implementers:**
  - run the app only through the stand-in daemon's `shoot.sh`, or `--screenshot`;
  - never touch `~/.config/protondrive`, `~/.local`, `~/ProtonDrive` or the user's daemon;
  - never contact Proton.

## Review Focus

1. **Two downloads of the same name at once** (two shared `Report.pdf` from different people): they end as `Report.pdf`
   and `Report (1).pdf`, and neither is lost or overwritten (Task 2).
2. **A shared item's name that isn't a safe file name** (`..`, `.`, empty, a `/`, a NUL, a leading dot): it is never
   used as a path. Download saves under a safe name, and never outside Downloads (Task 2).
3. **Offline in the middle of Accept, Decline or Leave:** the row shows the reason, the list isn't changed, and no
   activity is logged (Tasks 1 and 5).
4. **An unverified sender with no claimed email:** the Accept question uses the no-email wording, and no "null" or
   empty email ever shows (Tasks 1 and 5).
5. **A Downloads folder that doesn't exist yet,** or `xdg-user-dir` missing: the folder is created, or `~/Downloads`
   is used (Task 2).

---

### Task 1: The daemon lists what's shared with the owner and acts on invitations and items

**Files:**
- Create: `src/daemon/sharedWithMe.ts`.
- Modify:
  - `src/sdk/paths.ts`: export the #486 loader as `loadSharedWithMe` (no behaviour change);
  - `src/daemon/shareRoutes.ts`: new routes;
  - `src/daemon/tcpRefusals.ts`;
  - `src/daemon/daemonServer.ts`: wire it in next to `createShareService` (~line 541).
- Test: `tests/sharedWithMe.test.ts`, and extend `tests/shareRoutes.test.ts`.

**Interfaces:**
- Produces, from `src/daemon/sharedWithMe.ts`:
  ```ts
  export type SharedWithMeKind = 'file' | 'folder' | 'doc' | 'sheet';
  export interface Invitation { invitationUid: string; name: string | null; kind: SharedWithMeKind; from: string | null; fromVerified: boolean; role: 'viewer' | 'editor' | 'admin'; invitedAt: number }
  export interface SharedWithMeItem { uid: string; name: string | null; kind: SharedWithMeKind; sharedBy: string | null; sharedByVerified: boolean; sharedAt: number | null; role: 'viewer' | 'editor' | 'admin'; canLeave: boolean; unreadable?: string }
  export interface SharedWithMeService {
      list(signal?: AbortSignal): Promise<{ invitations: Invitation[]; items: SharedWithMeItem[] }>;
      accept(invitationUid: string): Promise<void>;
      decline(invitationUid: string): Promise<void>;
      leave(uid: string): Promise<void>;
      openUrl(uid: string): Promise<{ url: string }>;
      download(uid: string): Promise<{ path: string }>; // Task 2 fills this in; Task 1 throws ShareError('Not yet')
  }
  export function createSharedWithMeService(deps: SharedWithMeDeps): SharedWithMeService;
  ```
  - `SharedWithMeDeps`:
    - `sdk`: a `Pick` of `iterateInvitations`, `acceptInvitation`, `rejectInvitation`, `leaveSharedNode`,
      `iterateSharedWithMeNodeUids`, `iterateNodes`, `experimental`;
    - `logActivity(entry: { action: 'share'; localRelPath: string; details: string })`;
    - `now()`.
  - Errors are `ShareError` (from `shareService.ts`), with a plain message.
- Routes (JSON; errors 400 `{ error }`, as the share routes):
  - `GET /share/with-me`;
  - `POST /share/with-me/accept {invitationUid}`;
  - `POST /share/with-me/decline {invitationUid}`;
  - `POST /share/with-me/leave {uid}`;
  - `POST /share/with-me/open-url {uid}` → `{ url }`.

- [ ] **Step 1: Write the failing tests** in `tests/sharedWithMe.test.ts`, with a fake SDK:
  - `lists invitations newest first, with from/verified/kind/role`: a verified invitation; an unverified one whose
    error has `claimedAuthor: 'x@proton.me'` (→ `from: 'x@proton.me', fromVerified: false`); and one with no claimed
    author (→ `from: null`).
  - `an invitation whose name can't be decrypted has name null`.
  - `kind is doc/sheet from the Proton Docs/Sheets media types, else file/folder by type`. Use the media-type check
    #430 uses (grep `isProtonDocument`).
  - `items come from iterateSharedWithMeNodeUids, newest shared first, with sharedBy/sharedAt/role from membership`.
  - `an item with no membership falls back to directRole, with sharedBy and sharedAt null and canLeave false`.
  - `an item that fails to load is listed with unreadable set`.
  - `accept/decline/leave call the SDK with that uid and log Accepted an invitation to <name> / Declined an invitation to <name> / Left <name>`.
  - `leave refuses an item with canLeave false`.
  - `an SDK error in accept/decline/leave becomes a ShareError, and nothing is logged` (Review Focus 3).
  - `openUrl returns getNodeUrl's URL, or https://drive.proton.me/shared-with-me when getNodeUrl throws`.
  - `no logged detail contains an email address`.
  - In `tests/shareRoutes.test.ts`:
    - each route maps to the service and returns its JSON;
    - a missing uid is a 400;
    - the routes are refused on TCP (`tcpRefusals`).

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/sharedWithMe.test.ts tests/shareRoutes.test.ts`.
  Expected: FAIL, because the module and routes don't exist yet.

- [ ] **Step 3: Implement** the service, the routes and the wiring.
  - Reuse `loadSharedWithMe` for items, with its skip callback marking them unreadable.
  - An unverified author is an SDK `Result` with `ok: false`; read `error.claimedAuthor`.
  - Dates are epoch milliseconds.

- [ ] **Step 4: Run the checks.** Run `bun test tests` and `bunx tsc --noEmit`. Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git add src/daemon/sharedWithMe.ts src/sdk/paths.ts src/daemon/shareRoutes.ts src/daemon/tcpRefusals.ts src/daemon/daemonServer.ts tests
  git commit -m "feat(share): the daemon lists what's shared with you and accepts, declines and leaves

  Refs #487"
  ```

### Task 2: The daemon downloads a shared file to Downloads, never overwriting

**Files:**
- Modify:
  - `src/daemon/sharedWithMe.ts`: `download`;
  - `src/daemon/shareRoutes.ts`;
  - `src/daemon/daemonServer.ts`: deps.
- Test: `tests/sharedWithMe.test.ts`.

**Interfaces:**
- Consumes: Task 1's service.
- Produces:
  - `POST /share/with-me/download {uid}` → `{ path }`;
  - new deps on `SharedWithMeDeps`:
    ```ts
    downloadsDir(): Promise<string>;            // xdg-user-dir DOWNLOAD, else ~/Downloads (the daemon creates it)
    freeBytes(dir: string): Promise<number>;    // statfs
    fetchFile(node: NodeEntity, toPath: string): Promise<void>; // daemonServer wires it to downloadDriveNodeToLocal
    ```
  - The name helper `export function downloadNames(name: string): Generator<string>`, which yields the safe base name,
    then `base (1).ext`, `base (2).ext` and so on.

- [ ] **Step 1: Write the failing tests:**
  - `downloads a file into Downloads under its own name and logs Downloaded <name> to Downloads`.
  - `a taken name gets (1), (2): an existing file is never overwritten`. Pre-create `Report.pdf` and
    `Report (1).pdf`; the result is `Report (2).pdf`, and both originals are byte-for-byte unchanged.
  - `two downloads of the same name at once end as two files` (Review Focus 1): start both, await both; the two paths
    differ, and both contents are right.
  - `unsafe names are made safe and stay inside Downloads` (Review Focus 2):
    - `..` → `Shared file`;
    - `a/b` → `a_b`;
    - a NUL is stripped;
    - empty → `Shared file`;
    - a leading-dot name is kept but placed inside Downloads.
    Assert that `path.dirname(result) === downloadsDir` for each.
  - `the Downloads folder is created if missing` (Review Focus 5).
  - `refused when it would leave less than LOCAL_RESERVE_BYTES free`, with a plain reason; nothing is written.
  - `refused for folders, Docs and Sheets`.
  - `a failed fetch leaves no temp file and no target`. List the folder: nothing starts with `.proton-drive-tmp-`.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/sharedWithMe.test.ts -t download`. Expected: FAIL.

- [ ] **Step 3: Implement `download(uid)`:**
  1. Load the node and check its kind.
  2. Size: `activeRevision.claimedSize ?? totalStorageSize`, checked against `freeBytes(downloadsDir)` minus `LOCAL_RESERVE_BYTES`.
  3. `fetchFile` into a fresh `.proton-drive-tmp-<random>-<safe name>` in Downloads. That path is new, so
     `downloadDriveNodeToLocal`'s own rename-over can't replace anything.
  4. Then, for each name from `downloadNames`, `link(temp, candidate)`. `EEXIST` moves on to the next name.
  5. `unlink(temp)`.
  6. On any failure, `rm(temp, { force: true })`.

- [ ] **Step 4: Run the checks.** Run `bun test tests` and `bunx tsc --noEmit`. Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git add src/daemon tests
  git commit -m "feat(share): download a file shared with you to Downloads, never overwriting

  Refs #487"
  ```

### Task 3: The app's model and requests for Shared with me

**Files:**
- Create: `native-gui/src/shared_with_me.rs`, the model, the texts, the requests and the screenshot fakes.
- Modify: `native-gui/src/main.rs`: `mod`, `WorkerCommand`/`WorkerEvent` variants, and the worker loop.
- Test: the unit tests in `shared_with_me.rs`.

**Interfaces:**
- Consumes: Task 1's and Task 2's JSON.
- Produces:
  ```rust
  pub struct Invitation { pub invitation_uid: String, pub name: Option<String>, pub kind: Kind, pub from: Option<String>, pub from_verified: bool, pub role: Role, pub invited_at: i64 }
  pub struct Item { pub uid: String, pub name: Option<String>, pub kind: Kind, pub shared_by: Option<String>, pub shared_by_verified: bool, pub shared_at: Option<i64>, pub role: Role, pub can_leave: bool, pub unreadable: Option<String> }
  pub enum Kind { File, Folder, Doc, Sheet }
  pub enum Role { Viewer, Editor, Admin }
  pub struct Listing { pub invitations: Vec<Invitation>, pub items: Vec<Item> }
  pub struct SharedWithMePage { /* loading, seq, result, stale, row notes, … as SharedPage */ }
  pub fn list_at(socket: &Path) -> Result<Listing, String>;
  pub fn accept_at(socket: &Path, invitation_uid: &str) -> Result<(), String>;
  pub fn decline_at(socket: &Path, invitation_uid: &str) -> Result<(), String>;
  pub fn leave_at(socket: &Path, uid: &str) -> Result<(), String>;
  pub fn open_url_at(socket: &Path, uid: &str) -> Result<String, String>;
  pub fn download_at(socket: &Path, uid: &str) -> Result<String, String>; // the saved path
  pub fn accept_question(inv: &Invitation) -> Option<String>; // None when verified
  pub fn leave_question(item: &Item) -> String;
  pub fn display_name(name: &Option<String>) -> String;       // "An item" for None
  pub fn fake_shared_with_me(state: &str, now_ms: i64) -> Option<Result<Listing, String>>; // "list", "empty", "offline", "invitations"
  ```
  - Worker variants: `WorkerCommand::{ListSharedWithMe(u64), AcceptInvitation(String), DeclineInvitation(String), LeaveShared(String), OpenSharedUrl(String), DownloadShared(String)}`
  - Matching `WorkerEvent`s, each carrying its uid and a `Result`.
  - Requests use the share module's control-socket helpers and timeouts (`share.rs`). Download uses `DRIVE_READ_TIMEOUT`.

- [ ] **Step 1: Write the failing tests** in `shared_with_me.rs`:
  - JSON decoding of Task 1's shapes, with nulls;
  - `accept_question` for a claimed email, no email (Review Focus 4: the text never contains "null" or `""`), and
    verified (`None`);
  - `leave_question` verbatim;
  - `display_name(None) == "An item"`;
  - `fake_shared_with_me` covers each state.
- [ ] **Step 2: Run them and see them fail.** Run `cd native-gui && timeout 1800 cargo test --release shared_with_me`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the checks.** Run `timeout 1800 cargo test --release` and `cargo clippy --release --all-targets` (0 warnings).
- [ ] **Step 5: Commit**
  ```bash
  git add native-gui/src
  git commit -m "feat(gui): the model and requests for Shared with me

  Refs #487"
  ```

### Task 4: The Shared with me page and its sidebar entry

**Files:**
- Create: `native-gui/src/shared_with_me_view.rs`, which renders the page.
- Modify: `native-gui/src/main.rs`:
  - `NavTab::SharedWithMe`, with `parse_tab("shared-with-me")`;
  - the sidebar entry under Shared, with icon `icons::PEOPLE`;
  - loading on open and on Refresh, as `NavTab::Shared` does around `main.rs:2271`;
  - `--fake-shared-with-me <S>` for screenshots.
- Test: harness tests next to the Shared page tests.

**Interfaces:**
- Consumes: Task 3's model and worker variants.
- Produces: `fn render_shared_with_me(&mut self, ui: &mut egui::Ui)`.

- [ ] **Step 1: Write the failing tests:**
  - the sidebar has `Shared with me` between `Shared` and `Activity`, and clicking it opens the page and asks for the
    list (`sent()` holds the list command);
  - `--tab shared-with-me` opens on it;
  - the loading, empty (verbatim text), offline (`Retry`) and list states;
  - `Invitations` shows only when there are invitations;
  - the columns and each row's `Shared by` / date / `Access` text;
  - ⚠ for unverified, with the tooltip;
  - unreadable rows show `An item`;
  - the note `Saved links and shared photos are on drive.proton.me` shows below the list and the empty state;
  - Refresh is keyboard-focus friendly (#411's helper);
  - buttons are named with the item (`Open Project X`).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement,** reusing the Shared page's loading picture, centred Refresh, column helper and states.
- [ ] **Step 4: Run the checks,** then take screenshots, light and dark, with
  `…/scratchpad/fakedaemon/shoot.sh <png> <theme> 1180x940 normal --tab shared-with-me --fake-shared-with-me <S>`
  for `list`, `invitations`, `empty` and `offline`. Use a scratch copy of `shoot.sh` whose binary path is your worktree.
- [ ] **Step 5: Commit**
  ```bash
  git add native-gui/src
  git commit -m "feat(gui): a Shared with me page in the sidebar

  Refs #487"
  ```

### Task 5: Actions on the page: Accept, Decline, Open, Download, Leave

**Files:**
- Modify:
  - `native-gui/src/shared_with_me_view.rs`;
  - `native-gui/src/main.rs`: `PendingConfirm::{AcceptUnverified { invitation_uid, question }, LeaveShared { uid, question }}`, rendered by `render_confirm_modal`.
- Test: harness tests.

**Interfaces:**
- Consumes: Task 3's requests and texts, and Task 4's page.

- [ ] **Step 1: Write the failing tests:**
  - **Accept (verified):** sends at once, then reloads.
  - **Accept (unverified):** the verbatim question; `Cancel` sends nothing; `Accept` sends.
  - **Decline:** sends at once.
  - **After an Accept** whose item isn't in the reloaded list: the row note `Accepted, it will appear shortly`, and one
    more reload after 5 s.
  - **Open:** sends `OpenSharedUrl`, and the URL reply opens through the app's existing browser opener.
  - **⋯ menu:** shows `Download` only for files, and `Leave` only when `can_leave`.
  - **Leave:** the verbatim question; `Cancel` sends nothing; `Leave` sends, then reloads.
  - **Download:** `Downloading…`, then `Saved to Downloads` with `Show in Files`, which opens the folder with the
    file selected (the helper Home's "Show in Files" uses).
  - **A failed action** (Review Focus 3): its reason shows on the row, and the list isn't changed.
  - **Notes** are announced politely.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run every check in CLAUDE.md** (bun, tsc, Python, native-vfs, native-gui), plus screenshots of both
  confirmations (`--confirm-accept-unverified <NAME>`, `--confirm-leave <NAME>`, added like `--confirm-stop-sharing`).
- [ ] **Step 5: Commit**
  ```bash
  git add native-gui/src
  git commit -m "feat(gui): accept, decline, open, download and leave from Shared with me

  Fixes #487"
  ```
