# Open in Files on Home, Settings in the sidebar, and the empty Shared page: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Home's drive row offers Open in Files before Trash.
- Settings becomes a sidebar section and the top bar's gear goes.
- The empty Shared page becomes a centred picture, a heading, one line and a small Photos note.

**Architecture:** these are three independent app-only changes in `native-gui`, one issue, branch and PR each, each from
`main`. Task 1 also commits the spec and this plan. The tasks touch different functions (`home.rs` `render_your_drive`;
`chrome.rs` sidebar and top bar; `main.rs` `render_shared`) and different tests in `main.rs`'s test module.

**Tech Stack:** Rust, egui 0.31, egui-phosphor 0.9 (`icons::font`), the existing `Harness` test helpers in `main.rs`.

**Spec:** `docs/superpowers/specs/2026-11-16-home-sidebar-shared-polish-design.md`

## Global Constraints

- **Tests first:** watch each new test fail before writing the code.
- **Checks** (in `native-gui/`):
  - `cargo test --release` passes;
  - `cargo clippy --release --all-targets` has no warnings.
- **Screenshots:** through `shoot.sh` only, never the user's running app: light and dark, at 1000×700 and at 840×540
  with `--zoom 1.2`.
  - Use `<scratchpad>/fakedaemon/shoot.sh <out.png> <light|dark> <WxH> normal [gui args]`; the controller gives the
    scratchpad path.
- **Colours:** come from the palette tokens only (`PROTON_PURPLE_SOFT()`, `PROTON_PURPLE_TEXT()`, `BG_CARD()`,
  `BORDER_SUBTLE()`, `TEXT_PRIMARY()`, `TEXT_MUTED()`, `PROTON_PURPLE`). Muted text keeps ≥ 4.5:1 (existing contrast
  tests).
- **Unchanged:** Trash's icon, wording, hover (`trash_hover`) and screen-reader name (`OPEN_TRASH`) stay as they are.
- **Exact copy:**
  - "Open in Files" (`chrome::OPEN_IN_FILES`);
  - "Settings";
  - "Nothing shared yet";
  - "Right-click a file or folder in Files and choose Share…";
  - "Shared from Photos?";
  - "See them on drive.proton.me" (`shared::PHOTOS_LINK`).
- **Git:**
  - Branches: `feat/308-home-open-in-files`, `feat/309-settings-in-sidebar`, `feat/310-shared-empty-state`.
  - Commits are conventional, `feat(gui): …`, and the last one says `Fixes #N`.
  - No AI attribution of any kind.
- **Subagent safety:** never touch the user's running app or daemon, `~/ProtonDrive`, `~/.local/bin`, `~/.config/protondrive`
  or `~/.local/share/proton-drive-ubuntu`. Never run `install.sh`, `bun run build` or `nautilus -q`.

## Review Focus

1. **A small window with a large zoom** (840×540 at 120%):
   - Home's two buttons must not overlap the drive's name or its "Virtual drive · mounted" line;
   - the Shared empty state must not clip.

   Pinned in Task 1 Step 1 and Task 3 Step 1.
2. **No folder set up yet:** Home must not offer Open in Files (or Trash) on the card. The sidebar's greyed button stays.
   Pinned in Task 1 Step 1.
3. **A dialog open:** the new sidebar Settings must take no clicks under a confirmation, like the other sections. Pinned
   in Task 2 Step 1.
4. **Both themes:** the picture's glyphs must read on its circle and badges in light and in dark. The harness renders
   the dark palette (`IS_LIGHT_MODE` is false in tests and is global, so tests never flip it). Pinned in Task 3 Step 1
   by testing `share_picture_colors` over `[&LIGHT, &DARK]`, as the contrast tests do.
5. **Screen readers:** the picture must not be announced; the sidebar's Settings must say it is open as Home does.
   Pinned in Task 2 Step 1 and Task 3 Step 1.

---

### Task 1: Open in Files beside Trash on Home (#308)

**Files:**
- Modify: `native-gui/src/home.rs`: `render_your_drive` (the drive row, about lines 900–925).
- Test: `native-gui/src/main.rs`, test module:
  - new tests;
  - `open_in_files_in_the_sidebar_opens_the_drive_folder` (about line 7501);
  - `the_proton_drive_trash_opens_in_the_browser_from_home_and_settings` (about line 6845).
- Also commit: the spec and this plan.

**Interfaces:**
- Consumes:
  - `home::open_in_files(&Path)`, which already opens nothing in screenshot mode;
  - `action_button_named` or `action_button`, with `ButtonKind::Secondary` and `icons::FOLDER_OPEN`;
  - `chrome::OPEN_IN_FILES`;
  - `settings::STACKED_BELOW`.
- Produces: nothing used by other tasks.

- [ ] **Step 0: Branch.** `git checkout main && git pull && git checkout -b feat/308-home-open-in-files`, then commit
  the spec and plan:

  ```bash
  git add docs/superpowers/specs/2026-11-16-home-sidebar-shared-polish-design.md docs/superpowers/plans/2026-11-16-home-sidebar-shared-polish.md
  git commit -m "docs: design and plan for Open in Files on Home, Settings in the sidebar, the empty Shared page" -m "Refs #308, #309, #310"
  ```

- [ ] **Step 1: Write the failing tests** (in `main.rs`'s test module, next to `home_offers_trash_saying_where_it_goes_on_hover`).

  `home_offers_open_in_files_before_trash`:
  - Set up with `home_with(|s| s.sync_dir = "/srv/u/ProtonDrive".into())`.
  - On the page (x > `SIDEBAR_EDGE`), `chrome::OPEN_IN_FILES` is painted exactly once.
  - It is left of "Trash" and level with it (|Δy| < 4).
  - An `icons::FOLDER_OPEN` glyph on the page is painted just before it.
  - `fill_under(open) == fill_under(trash)`: the same Secondary kind.
  - Clicking it records `home::LAUNCHED == ["/srv/u/ProtonDrive"]`, and `h.sent()` is empty.
  - With `home::AS_SCREENSHOT` set, clicking it launches nothing.
  - With `sync_dir` empty, neither "Trash" nor `OPEN_IN_FILES` is painted at x > `SIDEBAR_EDGE`.

  `home_drive_buttons_fit_beside_or_under_the_name`:
  - Set up the same way.
  - At the default 1440×900:
    - both buttons' text rects are level with the drive's name (|Δy| < 12);
    - both are right of the name and of the "Virtual drive" line (`home::drive_kind(None)`, or whatever the harness
      shows).
  - After `h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2)`:
    - neither button's text rect intersects the name's or the kind line's rect;
    - all four lie within `SIDEBAR_EDGE..h.screen.x`;
    - Open in Files is still left of Trash.

  Update `open_in_files_in_the_sidebar_opens_the_drive_folder`. It asserts the button is "offered once, in the sidebar,
  not on Home's card too", which this issue reverses. Find the sidebar's button by `x < SIDEBAR_EDGE` and keep the rest
  of the test.

  Update `the_proton_drive_trash_opens_in_the_browser_from_home_and_settings`: its two `h.text_at("Open in Files")`
  clicks must name which button they mean (the sidebar's, filtered by x).

- [ ] **Step 2: Run them and see the new ones fail.** Run `cd native-gui && cargo test --release home_offers_open_in_files_before_trash home_drive_buttons_fit`.
  Expected: FAIL, because `OPEN_IN_FILES` is not painted at x > `SIDEBAR_EDGE`.

- [ ] **Step 3: Implement it in `render_your_drive`.**
  - **Wide card:** the drive row's right-to-left layout gets Open in Files after Trash, so it shows on Trash's left.
    Use Secondary, `icons::FOLDER_OPEN`, `chrome::OPEN_IN_FILES`, 32.0 high and 8.0 apart. Show it only when
    `!sync_dir.is_empty()`. It calls `open_in_files(Path::new(&sync_dir))`.
  - **Narrow card:** when `ui.available_width() < crate::settings::STACKED_BELOW`, the name and kind line come first.
    The two buttons follow in a `horizontal_wrapped` row under them, Open in Files first, 10.0 below, as
    `render_status_block` does.
  - Update the doc comment, which says "Open in Files is the sidebar's".

- [ ] **Step 4: Run all checks.** Run `cargo test --release` and `cargo clippy --release --all-targets`.
  Expected: all pass, with no warnings.

- [ ] **Step 5: Take screenshots.** Shoot Home (`--tab home`), light and dark, at 1000×700 and at 840×540
  `--zoom 1.2`. Check them by eye: both buttons, nothing overlapping.

- [ ] **Step 6: Commit.** `git commit -m "feat(gui): Home's drive row offers Open in Files beside Trash" -m "Fixes #308"`

---

### Task 2: Settings in the sidebar, no gear in the top bar (#309)

**Files:**
- Modify `native-gui/src/chrome.rs`:
  - `render_sections`: add Settings;
  - `render_top_bar`: remove the gear and its room;
  - `GEAR_SIZE`: delete it;
  - update the module and function doc comments that mention the gear.
- Modify `native-gui/src/main.rs`:
  - delete `icon_button_pressed`; it has no other caller;
  - drop `icon_button_drawn`'s `pressed` parameter, which is then always `None`, and its toggle branch;
  - update the tests listed in Step 1.

**Interfaces:**
- Consumes: `section_row`, `icons::SETTINGS`, `NavTab::Settings`, `self.open_tab`.
- Produces: nothing used by other tasks.

- [ ] **Step 0: Branch.** `git checkout main && git pull && git checkout -b feat/309-settings-in-sidebar`

- [ ] **Step 1: Write and update the tests.**

  Rename and rewrite `the_sidebar_offers_home_shared_and_activity_and_no_settings` as
  `the_sidebar_offers_home_shared_activity_and_settings`:
  - Each of `("Home", icons::HOME)`, `("Shared", icons::SHARED)`, `("Activity", icons::ACTIVITY)` and
    `("Settings", icons::SETTINGS)` is painted at x < `SIDEBAR_EDGE`, its icon before it.
  - The account still isn't in the sidebar.

  Rename `the_sidebar_lists_home_shared_activity_in_that_order` to
  `the_sidebar_lists_home_shared_activity_settings_in_that_order`, and add Settings last. Look for each label at
  x < `SIDEBAR_EDGE`.

  New `the_sidebar_settings_opens_settings_and_stays_selected`:
  - Click the sidebar's "Settings" (x < `SIDEBAR_EDGE`); `h.app.tab == NavTab::Settings`.
  - `fill_under` that row is `SIDEBAR_SELECTED()`.
  - The sidebar "Settings" accesskit node's `toggled()` equals what the sidebar "Home" node reported while Home was
    open. Clicking Home makes it report as not open.
  - With `pending_confirm = Some(PendingConfirm::StartFresh)`, clicking it leaves `tab == NavTab::Home`.

  Replace `the_gear_opens_settings` with `the_top_bar_has_no_gear`:
  - `in_top_bar(&h, icons::SETTINGS)` is empty.
  - Every `widgets_at_all("Settings")` position has x < `SIDEBAR_EDGE`, on Home.
  - On Settings, the top bar shows the title "Settings" once (bold), and no widget named Settings sits in the top bar.

  Update the rest:
  - `settings_starts_with_the_account_and_signs_out_from_it`: click the sidebar's Settings.
  - `clicking_the_account_opens_the_menu_not_settings`: drop the gear-left-of-account assertion.
  - `a_long_name_does_not_push_the_title_or_gear_off_at_840`: rename to `a_long_name_does_not_push_the_title_off_at_840`.
    Assert `title.right() < shown.left()`, with the shortened name between the title and the initials, and drop the
    gear.
  - `the_top_bar_takes_no_clicks_under_a_dialog` and `the_top_bar_is_disabled_under_a_dialog_and_under_the_share_window`:
    only "Account".
  - `the_gear_and_the_account_say_whether_they_are_pressed`: rename to `the_account_says_whether_its_menu_is_open`, with
    only the Account asserts.
  - `shared_actions_and_refresh_are_push_buttons_and_the_gear_a_toggle`: rename to
    `shared_actions_and_refresh_are_push_buttons`; drop the gear part.
  - `the_top_bar_titles_each_section_once`: its last line uses `painted_bold(&h, "Settings", f32::MAX)`, which can now
    find the sidebar's (bold while open). Check the title right of `SIDEBAR_EDGE` instead.

- [ ] **Step 2: Run the new and renamed tests and see them fail.** Run `cargo test --release sidebar top_bar`.
  Expected:
  - `the_sidebar_offers_home_shared_activity_and_settings` FAILS (no Settings in the sidebar);
  - `the_top_bar_has_no_gear` FAILS (the gear is there).

- [ ] **Step 3: Implement it.**
  - **`render_sections`:** add `(NavTab::Settings, icons::SETTINGS, "Settings", None)` last, and update its doc comment.
  - **`render_top_bar`:** remove the gear, `GEAR_SIZE` and the gear's share of `fixed`. Without the gear the panel's
    closure returns only `account`; drop the `gear` result and the `if gear { … }` block.
  - **`main.rs`:** delete `icon_button_pressed` and simplify `icon_button_drawn`. Its doc comment says the gear is the
    only toggle; update it.

- [ ] **Step 4: Run all checks.** Run `cargo test --release` and `cargo clippy --release --all-targets`. Expected: all
  pass, with no warnings, including no dead code.

- [ ] **Step 5: Take screenshots.**
  - `--tab home` and `--tab settings`, light and dark, at 1000×700.
  - `--tab settings` at 840×540 `--zoom 1.2`: the four sections and the storage meter fit without overlapping.

- [ ] **Step 6: Commit.** `git commit -m "feat(gui): Settings is a sidebar section; the top bar's gear goes" -m "Fixes #309"`

---

### Task 3: The empty Shared page (#310)

**Files:**
- Modify `native-gui/src/shared.rs`:
  - replace `EMPTY` with `EMPTY_TITLE = "Nothing shared yet"` and
    `EMPTY_HOW = "Right-click a file or folder in Files and choose Share…"`;
  - add `EMPTY_PHOTOS = "Shared from Photos?"`;
  - keep `PHOTOS_NOTE` and `PHOTOS_LINK`.
- Modify `native-gui/src/icons.rs`: add `pub const PERSON: &str = ph::USER;` and add it to `ALL` (36 entries).
- Modify `native-gui/src/main.rs`:
  - `render_shared`'s empty branch calls a new `fn render_shared_empty(&mut self, ui: &mut egui::Ui, viewport: f32)`;
  - add a new free fn `paint_share_picture(ui: &mut egui::Ui) -> egui::Response`;
  - tests, and a `circles_filled` harness helper.

**Interfaces:**
- Consumes:
  - `icons::SHARED` (`ph::LINK`), `icons::PERSON`, `icons::font`;
  - `bold(size)`;
  - `home::open_externally(OsStr::new(shared::WEB_SHARED_URL), screenshot)`, as `shared_photos_note` uses it.
- Produces: nothing used by other tasks.

- [ ] **Step 0: Branch.** `git checkout main && git pull && git checkout -b feat/310-shared-empty-state`

- [ ] **Step 1: Write the failing tests.**

  Add a harness helper `fn circles_filled(&self, fill: Color32) -> Vec<(egui::Pos2, f32)>`, modelled on `rects_filled`.
  It returns the centre and radius of each `Shape::Circle` with that fill.

  `shared_empty_is_a_picture_a_heading_and_one_line` (built like the existing empty case: open Shared, then
  `SharedLoaded(seq, Ok(vec![]))`, 3 frames):
  - `shared::EMPTY_TITLE` is painted bold (`painted_bold`), and `shared::EMPTY_HOW` is painted in `TEXT_MUTED()`.
  - There is exactly one circle filled `share_picture_colors(palette()).circle` with radius ≥ 40.
  - Its centre's x is within 2.0 of the title's centre x, and of the page's centre
    (`(SIDEBAR_EDGE + h.screen.x) / 2`, within 30.0 for the scroll gutter).
  - It sits above the title.
  - `icons::SHARED` is painted inside that circle.
  - At least two `icons::PERSON` glyphs are painted, each within radius + 20 of the circle's centre.
  - The circle's centre y lies between 25% and 60% of the way down from the toolbar's bottom (the Refresh widget's
    y + 20) to `h.screen.y`.
  - `nodes_named` finds no node named `icons::SHARED` or `icons::PERSON`: the picture isn't announced.
  - `"Refresh"` is still a widget.

  `the_share_picture_reads_in_both_palettes`: for `p` in `[&LIGHT, &DARK]`, with `let c = share_picture_colors(p)`:
  - `c.circle == p.purple_soft`, `c.glyph == p.purple_text`, `c.badge == p.card`, `c.badge_line == p.border_weak`;
  - `contrast(c.glyph, c.circle) >= 3.0` and `contrast(c.glyph, c.badge) >= 3.0` (WCAG's 3:1 for graphics).

  In `shared_empty_is_a_picture_a_heading_and_one_line`, look for the circle by `share_picture_colors(palette()).circle`.

  `shared_empty_fits_a_small_zoomed_window`:
  - After `resize_zoomed(Vec2::new(840.0, 540.0), 1.2)`, the title, the how line, `EMPTY_PHOTOS` and `PHOTOS_LINK` are
    all painted with x in `SIDEBAR_EDGE..h.screen.x`.
  - The how line is either on one line or wrapped (no clipping): its rect's right ≤ `h.screen.x`.
  - In a 840×380 window at zoom 1.2, the first visible element is not above the toolbar, and the page scrolls to the
    link (it is reachable by `ScrollArea` scrolling, or is already visible).

  Update the existing empty-state tests:
  - `shared::EMPTY` becomes `shared::EMPTY_TITLE`, in the tests at about lines 8138, 8142, 8186 and 8489.
  - `shared_notes_that_photos_may_be_missing_under_rows_and_under_the_empty_text`: under rows, `PHOTOS_NOTE` and
    `PHOTOS_LINK` as before. On the empty page, `EMPTY_PHOTOS` and `PHOTOS_LINK`, and `PHOTOS_NOTE` is NOT painted.
    Also click the link on the empty page and expect `WEB_SHARED_URL` in `home::LAUNCHED`.
  - `shared_does_not_note_photos_while_first_loading_or_on_an_error`: also assert `EMPTY_PHOTOS` is absent.

- [ ] **Step 2: Run them and see them fail.** Run `cargo test --release shared_empty`.
  Expected: FAIL. Before Step 3 the tests don't compile, because the new constants don't exist; add the constants
  first, so they fail on the assertions.

- [ ] **Step 3: Implement it.**
  - **The viewport height:** in `render_shared`, before the `ScrollArea`, take `let viewport = ui.available_height();`.
    The empty branch (not loading) calls `self.render_shared_empty(ui, viewport)` in place of today's label and note.
  - **`render_shared_empty`:** a `Layout::top_down(Align::Center)` group.
    - Keep the group's height from the last frame in egui temp memory (`ui.ctx().data_mut`, id `"shared_empty_h"`), 0
      at first. Add top space `((viewport - group_h) * 0.4).max(0.0)`.
    - Then the picture (`paint_share_picture`), 20.0 space, the title in `bold(16.0)` and `TEXT_PRIMARY()`, 6.0 space,
      and the how line.
    - The how line is 13.0, `TEXT_MUTED()`, wrapping, centred, at most 420.0 wide.
    - Then 24.0 space and a centred `horizontal` row: `EMPTY_PHOTOS` at 12.0 in `TEXT_MUTED()`, 4.0 apart from a link
      `PHOTOS_LINK` at 12.0, which opens `WEB_SHARED_URL` as `shared_photos_note` does.
    - Store the group's measured height for the next frame, and request a repaint when it changed.
  - **`share_picture_colors(p: &Palette) -> SharePictureColors`:** a struct with `circle`, `glyph`, `badge` and
    `badge_line`, all `Color32`, filled from `p` as the test says. `paint_share_picture` takes its colours from
    `share_picture_colors(palette())`.
  - **`paint_share_picture`:** allocate 128×112 with `Sense::hover()`.
    - Paint a circle of radius 48 in `circle` at the centre.
    - Paint `icons::SHARED` at 44pt in `glyph`, centred.
    - Paint two badges: circles of radius 16, filled `badge` with a 1.5 `badge_line` stroke. One sits at
      (centre − 46, centre + 26), the other at (centre + 46, centre − 26). Each has `icons::PERSON` at 18pt in `glyph`.
    - Give it no `widget_info`, so screen readers skip it.
    - The exact sizes may move by a few points if a screenshot shows the badges crowding the glyph; keep the tests'
      bounds.

- [ ] **Step 4: Run all checks.** Run `cargo test --release` and `cargo clippy --release --all-targets`. Expected: all
  pass, with no warnings.

- [ ] **Step 5: Take screenshots.** `--tab shared --fake-shared empty`, light and dark, at 1000×700 and at 840×540
  `--zoom 1.2`. Also `--fake-shared list`, to show the list is unchanged.

- [ ] **Step 6: Commit.** `git commit -m "feat(gui): the empty Shared page is a picture, a heading and one line" -m "Fixes #310"`
