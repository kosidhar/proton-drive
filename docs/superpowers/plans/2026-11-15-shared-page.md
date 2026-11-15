# The Shared page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shared section in the app that lists everything the user has shared, with what each item exposes. From
each row the user can copy the link, manage the item, show it in Files or stop sharing it.

**Architecture:**
- The daemon's share service gains `list()` and `stopSharing()`, served as `GET /share/list` and
  `DELETE /share/all` on the control socket.
- The app gets a `shared.rs` module (the page's model and wording) and the Shared section in `main.rs`, which reuses
  the Share window, the confirmation dialog and the Files helpers.
- PR 1 is Tasks 1–3 (daemon); PR 2 is Tasks 4–6 (app).

**Tech Stack:**
- Daemon: Bun and TypeScript, with `@protontech/drive-sdk` and `bun:test`.
- App: Rust, egui 0.31 and serde_json, with `cargo test` and the app's egui test harness.

**Spec:** `docs/superpowers/specs/2026-11-15-shared-page-design.md` (issue #253). It builds on
`docs/superpowers/specs/2026-11-04-share-design.md` (#216).

## Global Constraints

- **Routes:** `GET /share/list` answers `{ items: SharedItem[] }`; `DELETE /share/all {path}` stops sharing an item.
  - Both are on the control socket only, under `/share/` (the socket hands those to `shareRoute`).
  - Neither is on the TCP API, and neither goes in `tcpRefusals.ts`.
- **What the list never carries:** a password, an older link's URL fragment, or an address.
  - Log lines never carry URLs or addresses either.
  - A read writes nothing to the log or the activity history.
- **Only clicks change anything:** opening the page, loading the list and Refresh only read. Stop sharing always asks
  first.
- **Exact wording:**
  - Section and buttons:
    - The section is called "Shared".
    - Buttons: "Refresh", "Retry", "Copy link", "Manage…", "Show in Files", "Stop sharing" and "Manage on the web".
  - Page messages:
    - After Copy link: "Link copied".
    - While loading: "Loading what you've shared…".
    - With nothing shared: "Nothing shared yet. Right-click a file or folder in Files and choose Share… or Copy Link."
  - Stop sharing:
    - The confirmation: "Stop sharing report.pdf? The link stops working and 2 people lose access." It names only the
      parts that apply.
    - The activity entry: "Stopped sharing report.pdf".
- **Web page:** `https://drive.proton.me/shared`.
- **Sidebar order:** Home, Shared, Activity, Settings. `--tab shared` opens the section.
- **Screenshot mode** sends nothing to the daemon and opens nothing.
- **Checks before every push:**
  - `bun test tests` and `bunx tsc --noEmit`;
  - in `native-gui/`: `cargo test --release` and `cargo clippy --release --all-targets` with no warnings.
  - `cargo` is at `~/.cargo/bin` and `bun` at `~/.bun/bin`.
- **Git:**
  - Conventional commits, with no AI attribution of any kind.
  - PR 1's commits say `Refs #253`. PR 2's last commit says `Fixes #253`.
  - Never commit `target/`, `release/` or `__pycache__/`.

## Review Focus

1. **A shared item in Proton Drive's trash.** It has `trashTime`, and the index may still hold a stale entry. It must
   be `elsewhere`, with Manage on the web, never `my-files` with Stop sharing on a path that points elsewhere. (Test in
   Task 1.)
2. **The My files folder itself shared** (an index entry with path `""`). It must be `elsewhere`, because the share
   routes refuse an empty path. (Test in Task 1.)
3. **Many shared items.** With 60 items: no more than 4 sharing reads at once, every item listed, and the order
   stable. (Test in Task 1.)
4. **Stop sharing an item already unshared elsewhere** (the web app, another device). It is no error, and the list
   reloads without it. (Test in Task 2.)
5. **An app talking to a daemon from before these routes.** The 404 reads "Restart Proton Drive to share from here"
   (`SHARE_NEEDS_RESTART`), not a raw error. (Test in Task 4.)

---

## PR 1: daemon (branch `feat/253-shared-page`, which already holds the spec and this plan)

### Task 1: `list()` in the share service

**Files:**
- Modify: `src/daemon/shareService.ts`
- Test: `tests/shareService.test.ts`

**Interfaces:**
- Produces, in `src/daemon/shareService.ts`:
  ```ts
  export type SharedPlace = 'my-files' | 'hidden' | 'elsewhere';
  export interface SharedItem {
      name: string;
      relPath: string | null;
      where: SharedPlace;
      link: ShareInfo['link'];
      people: number;
      unreadable?: string;
  }
  export const LIST_CONCURRENCY = 4;
  // ShareService gains:
  list(): Promise<SharedItem[]>;
  // ShareServiceDeps changes:
  sdk: Pick<ProtonDriveClient, 'getSharingInfo' | 'shareNode' | 'unshareNode' | 'iterateSharedNodeUids' | 'iterateNodes'>;
  placeOf(uid: string): { relPath: string; hidden: boolean } | null; // the remote index's path for the node, and whether it is hidden
  ```

The behaviour the tests pin:
- **Uids:** from `sdk.iterateSharedNodeUids()`. Never use `iterateSharedNodes`, which reads the SDK's cache.
- **Nodes:** loaded with `sdk.iterateNodes(uids)`.
  - A `MissingNode` (`{ missingUid }`) is listed as `{ name: 'An item', relPath: null, where: 'elsewhere', link: null, people: 0, unreadable: "This item can't be found in Proton Drive" }`.
  - A node whose name isn't readable (`name.ok === false`) is named `'An item'`.
- **`where`:**
  - `elsewhere` when the node has `trashTime`, when `placeOf` gives `null`, or when it gives the path `''`;
  - otherwise `hidden` when `placeOf(uid).hidden`;
  - otherwise `my-files`.
  - `relPath` is `placeOf`'s path for `my-files` and `hidden`, and `null` for `elsewhere`.
- **Sharing:** `sdk.getSharingInfo(uid)` per item, at most `LIST_CONCURRENCY` at once.
  - **`undefined`** (the SDK's node cache hasn't caught up): listed as unreadable, "Proton Drive is still catching up
    with this item: refresh in a moment" (ruling R5, which replaced "left out").
  - **An offline error** (`isOffline`): the whole `list()` throws the same `ShareError` as `plainError` gives. Never a
    partial list.
  - **Any other error:** the item is listed with `unreadable: "Proton Drive couldn't say how this item is shared"`,
    `link: null` and `people: 0`.
- **`link`:** exactly as `toInfo` builds it, so share the code.
- **`people`:** members, Proton invitations and non-Proton invitations, counted together.
- **Order:** `my-files` and `hidden` items by `relPath` (plain string order), then `elsewhere` items by `name`.
- **Logging:** nothing to `logActivity`.

- [ ] **Step 1: Write the failing tests** in `tests/shareService.test.ts`, in a new `describe('list', …)`.
  - Extend the test fake with `iterateSharedNodeUids` and `iterateNodes`, a per-uid sharing map, a per-uid failure,
    and a counter of concurrent `getSharingInfo` calls. Keep the existing tests' behaviour.
  - The tests:
    - `each shared item with its link and how many people`: a link with password and expiry, plus 1 member, 1 Proton
      invitation and 1 non-Proton invitation, gives `people: 3`. The `link` equals what `info()` gives for the same
      sharing.
    - `where each item is: my files, hidden, elsewhere, trashed, the My files folder itself`: the five cases give
      `my-files`, `hidden`, `elsewhere`, `elsewhere` and `elsewhere`. The trashed one and the root have
      `relPath: null`.
    - `an item the SDK hasn't caught up with is listed as unreadable, not dropped` (ruling R5).
    - `an item whose sharing can't be read is listed as unreadable; the rest is unaffected`.
    - `a node Proton Drive can't find is listed as "An item", unreadable`.
    - `offline while reading is the offline refusal, not a partial list`: `ConnectionError` on one item rejects with
      `ShareError` 'Proton Drive is offline: try again when you are connected'.
    - `never more than 4 sharing reads at once, and all 60 items listed in order`: 60 uids, 20 of them elsewhere. Max
      concurrency is 4, the length is 60, and the order is as specified.
    - `an older link's password stays out, and nothing is logged`: the URL has no `#` part, there is no `customPassword`
      key anywhere in the JSON, and the `logActivity` calls are `[]`.
- [ ] **Step 2: Run them and see them fail**: `PATH=$HOME/.bun/bin:$PATH bun test tests/shareService.test.ts`. They
  fail with `list is not a function`.
- [ ] **Step 3: Implement `list()`** and the two new deps in `createShareService`.
- [ ] **Step 4: Run the tests** (all of `shareService.test.ts` passes), then `bunx tsc --noEmit`. `daemonServer.ts`
  fails type-checking until Task 3 wires `placeOf`. Add `placeOf: () => null` there now, marked as wired in Task 3, so
  the tree type-checks.
- [ ] **Step 5: Commit**: `feat(share): list what the user has shared, with what each item exposes`, body `Refs #253`.

### Task 2: `stopSharing()` in the share service

**Files:**
- Modify: `src/daemon/shareService.ts`
- Test: `tests/shareService.test.ts`

**Interfaces:**
- Produces: `ShareService.stopSharing(path: string): Promise<ShareInfo>`. It resolves to `{ link: null, people: [] }`.

The behaviour:
- It runs through `run(path, …)`, so it refuses what the other routes refuse and queues per item.
- It calls `sdk.unshareNode(uid)` with **no second argument**, which deletes the whole share.
- Then it calls `log(path, \`Stopped sharing ${name}\`)`.

- [ ] **Step 1: Write the failing tests.**
  - First make the fake's `unshareNode` treat a missing second argument as "everything": the state becomes
    `undefined`.
  - The tests:
    - `stopSharing removes the whole share in one call and logs "Stopped sharing report.pdf"`: exactly one
      `unshareNode` call, whose `args` has length 1, and the activity entry is as quoted.
    - `stopSharing refuses an item not uploaded or hidden, calling nothing`.
    - `stopSharing an item no longer shared is not an error`: the state is already `undefined`, and it resolves to
      `{ link: null, people: [] }`.
    - `stopSharing offline is the offline refusal and logs nothing`.
- [ ] **Step 2: Run them and see them fail** (`stopSharing is not a function`).
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `bun test tests/shareService.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit**: `feat(share): stop sharing an item, its link and everyone at once`, body `Refs #253`.

### Task 3: the routes, and the daemon's wiring

**Files:**
- Modify: `src/daemon/shareRoutes.ts` (`ROUTES`)
- Modify: `src/daemon/daemonServer.ts` (the `createShareService` call, around line 535)
- Test: `tests/shareRoutes.test.ts`, and the TCP-refusal or control-socket test that already covers `/share/info`, if
  there is one

**Interfaces:**
- Consumes `ShareService.list()` (Task 1) and `ShareService.stopSharing()` (Task 2).
- Produces the HTTP contract Task 4 relies on:
  - `GET /share/list` → `200 { items: SharedItem[] }`.
  - `DELETE /share/all` with body `{ path }` → `200 { link: null, people: [] }`.
  - Both refuse with `400 { error }` like the other share routes, and with `400 'Sign in to share'` when signed out.

- [ ] **Step 1: Write the failing tests** in `tests/shareRoutes.test.ts`.
  - Extend `each route calls the right method and answers its JSON` with `GET /share/list` (it answers
    `{ items: [...] }`) and `DELETE /share/all` (it calls `stopSharing('Documents/report.pdf')`).
  - Extend the bad-path test: `DELETE /share/all` with a missing, empty or rooted `path` is refused before the service.
  - `GET /share/list while signed out is 'Sign in to share'`.
  - If an existing test asserts that the TCP API doesn't serve `/share/info`, add `/share/list` and `/share/all` to it.
- [ ] **Step 2: Run them and see them fail** (404 for the new paths).
- [ ] **Step 3: Add both routes** to `ROUTES`, and wire `placeOf` in `daemonServer.ts`:
  - `engine.remoteIndex.getByUid(uid)` gives `{ relPath: entry.relPath, hidden: Boolean(engine.availability.hiddenBy(entry.relPath)) }`,
    or `null` when there is no entry.
- [ ] **Step 4: Run all daemon checks**: `bun test tests` and `bunx tsc --noEmit`. Run them as a normal user; CLAUDE.md
  names three tests that fail as root.
- [ ] **Step 5: Commit**: `feat(daemon): GET /share/list and DELETE /share/all on the control socket`, body
  `Refs #253`.

---

## PR 2: app (branch `feat/253-shared-page-app`, from `main` after PR 1 is merged)

### Task 4: the app's client and the page's model and wording

**Files:**
- Create: `native-gui/src/shared.rs`
- Modify: `native-gui/src/share.rs`:
  - add `list_at` and `stop_sharing_at`;
  - make `local_day` and `date_text` usable from `shared.rs` (`pub(crate)`).
- Modify: `native-gui/src/main.rs` (`mod shared;`)
- Test: unit tests in `shared.rs` and `share.rs`

**Interfaces:**
- Produces, in `shared.rs`:
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)] #[serde(rename_all = "kebab-case")]
  pub enum Place { MyFiles, Hidden, Elsewhere }
  #[derive(Clone, Debug, PartialEq, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct SharedItem {
      pub name: String,
      pub rel_path: Option<String>,
      #[serde(rename = "where")] pub place: Place,
      pub link: Option<share::ShareLink>,
      pub people: u32,
      #[serde(default)] pub unreadable: Option<String>,
  }
  pub const WEB_SHARED_URL: &str = "https://drive.proton.me/shared";
  pub const LOADING: &str = "Loading what you've shared…";
  pub const EMPTY: &str = "Nothing shared yet. Right-click a file or folder in Files and choose Share… or Copy Link.";
  pub fn folder_text(item: &SharedItem) -> String;
  pub fn exposure_text(item: &SharedItem, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> String;
  pub fn can_copy(item: &SharedItem, now_ms: i64) -> bool;
  pub fn stop_question(item: &SharedItem) -> String;
  pub fn fake_shared(state: &str, now_ms: i64) -> Option<Result<Vec<SharedItem>, String>>; // "list" | "empty" | "offline"
  ```
- Produces, in `share.rs`:
  - `pub fn list_at(socket: &Path) -> Result<Vec<shared::SharedItem>, String>`: GET `/share/list`, read with
    `SHARE_WRITE_TIMEOUT` (120 s): listing grows with the number of shared items (ruling R7, #257).
  - `pub fn stop_sharing_at(socket: &Path, rel_path: &str) -> Result<(), String>`: DELETE `/share/all` with `{ path }`,
    through `share_change`.
  - Both go through `share_request`, so a 404 reads as `SHARE_NEEDS_RESTART`, and an unreadable reply as `UNREADABLE`
    (never serde's message).

The wording rules:
- **`folder_text`:**
  - For `my-files` and `hidden`: the folder of `rel_path` (`"Documents/Work/a.txt"` gives `"Documents/Work"`), or
    `"(top level)"` for an item at the top.
  - `hidden` adds `" · Hidden from this computer"`.
  - `elsewhere` is `"Not on this computer"` (ruling R4: it also covers Proton Docs and items not indexed yet).
- **`exposure_text`:**
  - An `unreadable` item shows its text.
  - Otherwise, the link part:
    - `"Link"`, or `"Link expired {date}"` once `expires_at <= now`;
    - then `" · password"` if it has one;
    - then `" · expires {date}"` if it has a future expiry.
  - The people part: `"1 person"` or `"{n} people"`.
  - Link and people: `"{link} · {people}"`. People only: `"{people} · no link"`. Link only:
    `"{link} · anyone with it can view"` (`"…can edit"` for the editor role).
  - `{date}` is `date_text(local_day(expires_at, offset_at))`, the Share window's format.
- **`can_copy`:** a `my-files` item, not unreadable, whose link exists and hasn't expired.
- **`stop_question`:**
  - It is `"Stop sharing {name}? "` followed by the clauses that apply, joined with `" and "`, ending with `"."`:
    `"The link stops working"`, then `"1 person loses access"` or `"{n} people lose access"`.
  - With no clauses it is `"Stop sharing {name}?"`.

- [ ] **Step 1: Write the failing tests.**
  - In `shared.rs`:
    - `a_list_reply_is_read_each_kind_of_item`: serde reads a JSON with `my-files`, `hidden`, `elsewhere` and an
      unreadable item.
    - `folder_text_says_where_each_item_is`: the four cases above.
    - `exposure_text_says_what_each_item_exposes`:
      - `"Link · password · expires 2026-11-30 · 2 people"`;
      - `"2 people · no link"`;
      - `"Link · anyone with it can view"`;
      - `"Link expired 2026-11-01 · 1 person"`;
      - an unreadable item's text.
      - Use a fixed `now` and offset, as the Share tests do.
    - `copy_link_only_for_a_live_link_in_my_files`: true only for a `my-files` item with a live link; false for an
      expired link, no link, hidden, elsewhere and unreadable.
    - `the_stop_question_names_only_what_is_lost`:
      - link and 2 people: `"Stop sharing report.pdf? The link stops working and 2 people lose access."`;
      - 1 person only: `"Stop sharing Icons? 1 person loses access."`;
      - link only: `"Stop sharing a.txt? The link stops working."`.
    - `the_fakes_cover_every_kind_of_row`:
      - `"list"` has each `Place`, an unreadable item and an expired link;
      - `"empty"` is `Ok(vec![])`;
      - `"offline"` is `Err` with the daemon's offline text;
      - an unknown state is `None`.
  - In `share.rs`: `list_at_against_a_daemon_without_the_route_says_restart`, using the fake control-socket server the
    existing `control_request_*` tests use.
- [ ] **Step 2: Run them and see them fail**: `cd native-gui && PATH=$HOME/.cargo/bin:$PATH cargo test --release shared`.
- [ ] **Step 3: Implement** `shared.rs` and the two `share.rs` functions.
- [ ] **Step 4: Run** `cargo test --release` and `cargo clippy --release --all-targets`, with 0 warnings. Before Task 5
  uses the new items, `#[allow(dead_code)]` is acceptable only on items still unused, with a comment naming Task 5.
- [ ] **Step 5: Commit**: `feat(gui): the Shared page's client, rows and wording`, body `Refs #253`.

### Task 5: the Shared section, reading and showing the list

**Files:**
- Modify: `native-gui/src/main.rs`:
  - `NavTab` and `parse_tab`;
  - the sidebar list and nav icons in `render_sidebar` and the icon painter (~line 3500);
  - the `WorkerCommand`/`WorkerEvent` enums and the worker;
  - the section's render;
  - the CLI flags;
  - the harness's `sent()`.
- Modify: `native-gui/src/shared.rs` (the page's state)
- Test: harness tests in `main.rs`; the `parse_tab` test

**Interfaces:**
- Consumes everything from Task 4.
- Produces, in `shared.rs`:
  - `pub struct SharedPage { pub items: Option<Vec<SharedItem>>, pub loading: bool, pub error: Option<String> }`
    (Default);
  - `pub fn begin_load(&mut self)`;
  - `pub fn loaded(&mut self, result: Result<Vec<SharedItem>, String>)`.
- Produces, in `main.rs`:
  - `NavTab::Shared`;
  - `WorkerCommand::SharedLoad`, which the worker answers with
    `WorkerEvent::SharedLoaded(share::list_at(&control_socket_path()))`;
  - the app field `shared: shared::SharedPage`;
  - the harness's `sent()` shows `SharedLoad` as `"shared list"`.

The behaviour:
- **Navigation:**
  - The sidebar is Home, Shared, Activity, Settings, with a Shared icon (two linked rings) drawn like the others.
  - `parse_tab("shared")` is `NavTab::Shared`.
- **When it loads:**
  - Entering the section sends `SharedLoad`, each time it is entered. Refresh and Retry send it too.
  - Nothing sends it on a timer or on every frame.
- **States:**
  - **While loading,** `LOADING` shows. Rows already shown stay visible, greyed out (`ui.disable()`).
  - **On an error,** the daemon's message shows, with Retry.
  - **With no items,** `EMPTY` shows.
- **Each row** shows `name`, `folder_text` and `exposure_text`. There are no buttons yet; Task 6 adds them.
- **`--fake-shared <list|empty|offline>`** works only with `--screenshot`, and names the valid values for an unknown
  one, like `--fake-share`. It fills the page in place of the daemon, and nothing is sent.

- [ ] **Step 1: Write the failing tests.**
  - Add `assert_eq!(parse_tab("shared"), NavTab::Shared)` to `parse_tab_maps_old_and_new_names`.
  - `the_sidebar_lists_home_shared_activity_settings_in_that_order`: the y positions of the four labels increase in
    that order.
  - `opening_shared_asks_for_the_list_each_time_and_never_on_a_timer`:
    - clicking Shared sends `["shared list"]`;
    - 30 more frames send `[]`;
    - Home, then Shared again, sends `["shared list"]`.
  - `shared_shows_each_row_and_each_state`:
    - `h.event(WorkerEvent::SharedLoaded(Ok(fake list)))` shows each row's three texts;
    - `Ok(vec![])` shows `EMPTY`;
    - `Err("Proton Drive is offline: try again when you are connected")` shows it, and clicking Retry sends
      `["shared list"]`.
  - `a_reload_keeps_the_list_until_the_new_one_comes`: after a load, Refresh shows `LOADING` while the old rows are
    still there.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --release` and `cargo clippy --release --all-targets` (0 warnings). Build, and take
  screenshots:
  - `target/release/protondrive-gui --tab shared --fake-shared <list|empty|offline> --theme <light|dark> --screenshot <scratch>/shared-<state>-<theme>.png`;
  - plus `--size 840x540` for the list.
  - Read them: rows legible, nothing clipped, and long names elided rather than pushing the layout.
- [ ] **Step 5: Commit**: `feat(gui): a Shared section listing what you've shared`, body `Refs #253`.

### Task 6: acting on a row

**Files:**
- Modify: `native-gui/src/main.rs`:
  - the section's rows;
  - `PendingConfirm` and `confirm_copy`;
  - the worker;
  - the Share window's close path;
  - the CLI flags;
  - the harness's `sent()`.
- Modify: `native-gui/src/shared.rs`: the page state gains `stopping: Option<String>`, the rel_path being stopped, and
  `copied: Option<String>`, the rel_path just copied.
- Test: harness tests in `main.rs`

**Interfaces:**
- Consumes Tasks 4 and 5.
- Produces:
  - `PendingConfirm::StopSharing { rel_path: String, question: String }`;
  - `WorkerCommand::SharedStop { rel_path: String }`, which the worker answers with
    `WorkerEvent::SharedStopped(rel_path, share::stop_sharing_at(...))`;
  - the harness's `sent()` shows it as `stop sharing {rel_path:?}`.

The behaviour:
- **Buttons on an unreadable row** (ruling R10): Show in Files when it has a path, and Manage on the web. Never Stop
  sharing, Manage… or Copy link: its sharing wasn't read (the SDK may not have caught up), so they would act on a stale
  view, and Stop sharing could report done while the share stays live (#220).
- **Buttons on a readable `my-files` row:**
  - Copy link, only when `can_copy`;
  - Manage…;
  - Show in Files;
  - Stop sharing.
- **Buttons on a `hidden` or `elsewhere` row:** Manage on the web only.
- **Copy link:**
  - `ctx.copy_text(url)`, as the Share window's Copy link does.
  - The row shows "Link copied" until the next load.
- **Manage…:**
  - `self.open_share(abs)`, where `abs` is the item's path under the drive folder, from
    `activity::local_path(&status.sync_dir, rel_path)`.
  - When that Share window closes, while the section is Shared, the list reloads (`SharedLoad`).
- **Show in Files:** `home::show_in_files` on `activity::show_target(&status.sync_dir, rel_path)`. It sends nothing to
  the daemon.
- **Manage on the web:** `home::open_externally(WEB_SHARED_URL, screenshot)`.
- **Stop sharing:**
  - The click sets `pending_confirm` to `StopSharing` with `stop_question(item)`.
  - `confirm_copy` gives:
    - title "Stop sharing?";
    - body: the question;
    - confirm button "Stop sharing";
    - Cancel.
  - Confirming sends `SharedStop` and sets `stopping`. The row's buttons are disabled while `stopping` is that
    rel_path.
  - `SharedStopped(_, Ok)` clears `stopping` and sends `SharedLoad`.
  - `SharedStopped(_, Err(e))` clears `stopping` and shows `e` above the list. The list stays.
- **`--confirm-stop-sharing NAME`** (with `--fake-shared list` and `--screenshot`) opens the confirmation for the row
  named NAME.

- [ ] **Step 1: Write the failing tests.**
  - `each_kind_of_row_has_its_buttons`, on the fake list:
    - a live-link row has all four buttons;
    - an expired-link row has no Copy link;
    - a hidden and an elsewhere row have only "Manage on the web".
  - `stop_sharing_asks_first_then_sends_once_and_reloads`:
    - clicking Stop sharing shows the exact `stop_question` and sends `[]`;
    - confirming sends `["stop sharing \"Documents/report.pdf\""]`;
    - `SharedStopped(…, Ok(()))` sends `["shared list"]`.
  - `cancelling_stop_sharing_sends_nothing`.
  - `a_row_being_stopped_cannot_be_stopped_again`: while `stopping`, clicking the row's Stop sharing opens no
    confirmation.
  - `a_failed_stop_says_why_and_keeps_the_list`.
  - `manage_opens_the_share_window_for_the_item_and_closing_it_reloads_the_list`:
    - the Share window's `abs_path` is `{sync_dir}/Documents/report.pdf`;
    - closing it sends `["shared list"]`, and the window's own reads may appear, as `sent()` documents.
  - `copy_link_copies_the_url_and_says_so`: the copied text is the row's URL, checked the same way the Share window's
    Copy link test checks it, and "Link copied" shows.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all checks** (the app checks; the daemon checks too, as the last task before the PR). Build, and
  take screenshots:
  - the list with buttons, in light and dark;
  - `--confirm-stop-sharing report.pdf`;
  - `--size 840x540`, where the four buttons must fit or wrap without overlapping.
  - Read every screenshot.
- [ ] **Step 5: Commit**: `feat(gui): copy, manage, show in Files and stop sharing from the Shared page`, body
  `Fixes #253`.
