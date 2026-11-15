# Proton's Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app look like Proton Drive on the web: a navy sidebar in light mode, a top bar with the account menu, and icons on every action. Every function stays.

**Architecture:**
- **Colours:** they become one `Palette` struct with a `LIGHT` and a `DARK` constant. The existing token functions (`TEXT_PRIMARY()`, …) read from it, so call sites don't change and tests can check both palettes without flipping the global light-mode flag.
- **Icons:** they come from `egui-phosphor`, named once by meaning in `icons.rs`.
- **The window chrome:** the sidebar, the top bar and the account menu move into `chrome.rs`. The four pages keep their render functions and are restyled in PR 2.
- **Icon-only buttons:** they carry an accessible name. The test harness finds them through AccessKit, the way it finds painted text today.

**Tech Stack:** Rust, egui/eframe 0.31, `egui-phosphor` 0.9 (MIT or Apache-2.0), Inter (already embedded).

**Spec:** `docs/superpowers/specs/2026-11-15-proton-look-design.md` (approved 2026-11-15). Tracking issue #276; fixes #273, #274, #275.

## Global Constraints

- **Colours, light mode, exact:**

  | Token | Value |
  |---|---|
  | sidebar | `#211A42` |
  | sidebar selected | `#2E2359` |
  | sidebar text | `#FFFFFF` |
  | sidebar weak text and icons | `#B1A1F5` |
  | storage bar | `#B1A1F5` on `#3E2F7F` |
  | primary | `#6D4AFF`, hover `#6243E6`, text white |
  | content and top bar | `#FFFFFF` |
  | weak background | `#F5F4F2` |
  | weak border | `#EAE7E4` |
  | norm border | `#D1CFCD` |
  | text | `#0C0C14` |
  | weak text | `#5C5958` |
  | folder icon | `#F5A428` |

  The sidebar hover colour is the builder's (spec suggests `#28204D`).
- **Dark mode:** the current palette stays (canvas `#1A1823`, sidebar `#14121B`, cards `#211D2C`, text `#F7F6FC`, muted `#A29EB2`). New tokens get dark values chosen from it.
- **Status colours unchanged:** success `#199676`, warning `#E68A00`, danger `#DC3251`.
- **Contrast:** body text ≥ 4.5:1 against its background, in both palettes.
- **Icons:** only from `egui-phosphor` 0.9. No Proton icon or style files. One glyph means one thing everywhere: the names live in `icons.rs`.
- **Icon-only buttons:** each has its old label as tooltip and as accessible name.
- **Each action is offered once:**
  - Open in Files only in the sidebar;
  - Proton storage in the sidebar meter and the account menu (and Settings' Account card);
  - Settings only behind the top bar's gear.
- **Sign out in the account menu** signs out at once, exactly as Settings › Account does (`WorkerCommand::Logout` via `send_account_command`).
- **Settings:** the theme picker stays, with its choices reading "Follow the system", "Light" and "Dark". Which settings wait for Save Preferences doesn't change.
- **Layout:** no clipping or overlap at 840×540, or at 120% zoom.
- **Screenshot mode sends nothing.**
- **No daemon change.**
- **Checks:** in `native-gui/`, `cargo test --release` and `cargo clippy --release --all-targets` with no warnings.
- **Git:** no AI attribution anywhere (no Co-Authored-By, no "Generated with").
- **Screenshots in every PR:** light and dark, 1100×760 and 840×540, of each page it touches.

## Review Focus

1. **Signed out, connecting, no folder set up:**
   - the sidebar shows no storage meter;
   - the account area shows "Not signed in" or "Connecting…" and opens no menu;
   - Open in Files is greyed out with a tooltip.

   (Task 2 and Task 3 tests.)
2. **A long name or email at 840×540:** the account area truncates; the title and the gear stay fully visible. (Task 3 test.)
3. **A confirmation dialog or the Share window is open:** the sidebar button, the gear and the account area take no clicks, as the sidebar today disables itself. (Task 3 test.)
4. **The account menu:**
   - Escape closes it;
   - a click outside only closes it and doesn't also click what's under it;
   - opening another section closes it.

   (Task 3 test.)
5. **120% zoom at 840×540:**
   - the sidebar's logo, button, sections and storage meter don't overlap;
   - the top bar's title, gear and account don't overlap.

   (Task 2 and Task 3 tests.)

---

## PR 1: Foundation (branch `feat/276-proton-look`, fixes #273 and #274)

### Task 1: Palette, icon font, button kinds, accessible names

**Files:**
- Modify: `native-gui/Cargo.toml` (add `egui-phosphor = { version = "0.9", default-features = false, features = ["regular"] }`, or `"light"` instead, see Step 3).
- Create: `native-gui/src/icons.rs`.
- Modify: `native-gui/src/main.rs`: the token block (lines ~65-170), `configure_proton_theme` (~3705), `proton_button` (~3642), `button_width`, and the `Harness` in the test module.
- Modify: `native-gui/src/home.rs`: `secondary_button` and `primary_button` (~464-473).

**Interfaces:**
- Produces:
  - **The palette:**
    - `struct Palette { canvas, sidebar, sidebar_selected, sidebar_hover, sidebar_text, sidebar_weak, storage_fill, storage_track, card, card_alt, input, border_weak, border_norm, text, text_weak, purple_soft, purple_text, folder: Color32 }`;
    - `const LIGHT: Palette`, `const DARK: Palette`, `fn palette() -> &'static Palette` (by `is_light_mode()`).
  - **Token functions:**
    - existing ones keep their names and read the palette: `BG_CANVAS() = canvas`, `BG_SIDEBAR() = sidebar`, `BG_CARD() = card`, `BG_CARD_ALT() = card_alt`, `BG_INPUT() = input`, `BORDER_SUBTLE() = border_weak`, `TEXT_PRIMARY() = text`, `TEXT_MUTED() = text_weak`, `PROTON_PURPLE_SOFT() = purple_soft`, `PROTON_PURPLE_TEXT() = purple_text`;
    - new: `BORDER_NORM()`, `SIDEBAR_SELECTED()`, `SIDEBAR_HOVER()`, `SIDEBAR_TEXT()`, `SIDEBAR_WEAK()`, `STORAGE_FILL()`, `STORAGE_TRACK()`, `FOLDER_ICON()`;
    - `PROTON_PURPLE_HOVER` becomes `#6243E6`.
  - **Light values:**
    - `canvas` = `card` = `#FFFFFF`;
    - `card_alt` = `input` = `#F5F4F2`;
    - the rest per Global Constraints.
  - **Dark values:** today's, plus new ones of your choice.
  - **Contrast:** `fn contrast(a: Color32, b: Color32) -> f32`, the WCAG ratio.
  - **Icon names:** `mod icons` with `pub const` glyph names by meaning:
    - `HOME`, `SHARED`, `ACTIVITY`, `SETTINGS`, `FOLDER_OPEN` (Open in Files / Show in Files), `TRASH`, `SYNC`;
    - `PAUSE`, `RESUME`, `CHECK`, `WARNING`, `OFFLINE`, `LINK`, `LINK_BROKEN` (Stop sharing, expired link);
    - `LOCK`, `CLOCK`, `PEOPLE`, `COPY`, `MANAGE`, `WEB` (open on the web), `REFRESH`, `SEARCH`, `INFO`, `SIGN_OUT`, `FOLDER`, `FILE`.

    `SYNC` and `REFRESH` may share a glyph only if they mean the same thing.
  - **Button kinds:** `enum ButtonKind { Primary, Secondary, Danger }`.
  - **Button helpers:**
    - `fn action_button(ui: &mut egui::Ui, kind: ButtonKind, icon: Option<&str>, label: &str, height: f32) -> egui::Response`. The icon is painted as its own text shape, before the label, so `Harness::text_at(label)` still finds the label.
    - `fn icon_button(ui: &mut egui::Ui, icon: &str, label: &str) -> egui::Response`: 28×28, no fill until hovered, `label` as tooltip and accessible name.
    - `fn action_button_width(ui: &egui::Ui, icon: Option<&str>, label: &str) -> f32`.
  - **`proton_button`:** gains `widget_info(WidgetInfo::labeled(WidgetType::Button, ui.is_enabled(), label))`.
  - **Old helpers:** `secondary_button` and `primary_button` keep their signatures and call `action_button(…, None, …)`. Secondary is `card` fill with a `border_norm` outline and an `input` hover; Primary is purple.
  - **Harness:**
    - `Harness::new` calls `ctx.enable_accesskit()`;
    - `fn widget_at(&self, label: &str) -> Option<egui::Pos2>` and `fn widgets_at_all(&self, label: &str) -> Vec<egui::Pos2>`: the centres of widgets whose AccessKit label is exactly `label`, from the last frame's `platform_output.accesskit_update`.

- [ ] **Step 1: Write the failing tests** (in `main.rs`'s test module)

```rust
#[test]
fn the_light_palette_is_protons() {
    assert_eq!(LIGHT.sidebar, Color32::from_rgb(0x21, 0x1A, 0x42));
    assert_eq!(LIGHT.sidebar_selected, Color32::from_rgb(0x2E, 0x23, 0x59));
    assert_eq!(LIGHT.sidebar_text, Color32::WHITE);
    assert_eq!(LIGHT.sidebar_weak, Color32::from_rgb(0xB1, 0xA1, 0xF5));
    assert_eq!((LIGHT.storage_fill, LIGHT.storage_track), (Color32::from_rgb(0xB1, 0xA1, 0xF5), Color32::from_rgb(0x3E, 0x2F, 0x7F)));
    assert_eq!((LIGHT.canvas, LIGHT.card), (Color32::WHITE, Color32::WHITE));
    assert_eq!((LIGHT.card_alt, LIGHT.input), (Color32::from_rgb(0xF5, 0xF4, 0xF2), Color32::from_rgb(0xF5, 0xF4, 0xF2)));
    assert_eq!((LIGHT.border_weak, LIGHT.border_norm), (Color32::from_rgb(0xEA, 0xE7, 0xE4), Color32::from_rgb(0xD1, 0xCF, 0xCD)));
    assert_eq!((LIGHT.text, LIGHT.text_weak), (Color32::from_rgb(0x0C, 0x0C, 0x14), Color32::from_rgb(0x5C, 0x59, 0x58)));
    assert_eq!(LIGHT.folder, Color32::from_rgb(0xF5, 0xA4, 0x28));
    assert_eq!(PROTON_PURPLE_HOVER, Color32::from_rgb(0x62, 0x43, 0xE6));
}

#[test]
fn the_dark_palette_keeps_todays_colours() {
    assert_eq!(DARK.canvas, Color32::from_rgb(26, 24, 35));
    assert_eq!(DARK.sidebar, Color32::from_rgb(20, 18, 27));
    assert_eq!(DARK.card, Color32::from_rgb(33, 29, 44));
    assert_eq!(DARK.text, Color32::from_rgb(247, 246, 252));
}

#[test]
fn text_reads_at_4_5_to_1_in_both_palettes() {
    for p in [&LIGHT, &DARK] {
        for (fg, bg, what) in [
            (p.text, p.canvas, "text"), (p.text_weak, p.canvas, "weak text"), (p.text, p.card, "text on cards"),
            (p.sidebar_text, p.sidebar, "sidebar"), (p.sidebar_text, p.sidebar_selected, "selected section"),
            (p.sidebar_weak, p.sidebar, "sidebar weak"), (Color32::WHITE, PROTON_PURPLE, "primary button"),
        ] {
            assert!(contrast(fg, bg) >= 4.5, "{what}: {:.2}", contrast(fg, bg));
        }
    }
}

#[test]
fn an_icon_button_is_found_by_its_label_and_says_it_on_hover() {
    // Render a bare icon_button labelled "Refresh" in a test Ui (see Harness for a context), then:
    // assert widget_at("Refresh") is Some, text_at("Refresh") is None (no painted label),
    // and after hovering it for 2 s of frames, text_at("Refresh") is Some (the tooltip).
}

#[test]
fn an_action_buttons_label_is_still_painted_text() {
    // action_button(Secondary, Some(icons::SYNC), "Sync now", 32.0): text_at("Sync now") is Some and widget_at("Sync now") is Some.
}
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd native-gui && cargo test --release palette contrast icon_button action_button 2>&1 | tail -20`
Expected: compile errors (`LIGHT`, `contrast`, `icon_button`… not defined).

- [ ] **Step 3: Implement**
  - **Icon font:**
    - Add the crate.
    - In `configure_proton_theme`, call `egui_phosphor::add_to_fonts(&mut fonts, egui_phosphor::Variant::Regular)` (or `Light`). Do it after Inter is inserted, so text stays Inter and the glyphs fall back to Phosphor.
    - **Pick the weight:** screenshot the sidebar with each weight, and keep the one closer to Proton's strokes in `/tmp/claude-1000/-home-gautam-chauhan-projects-proton-drive/83ab53f0-fea2-45b0-a976-56dd433d1865/images/28.png`. Say which in the report.
  - **AccessKit:** egui 0.31 is already built with `accesskit` (it's in `Cargo.lock`). If `enable_accesskit` isn't reachable, add `features = ["accesskit"]` to the `egui` dependency.

- [ ] **Step 4: Run the new tests and the whole suite**

Run: `cargo test --release 2>&1 | grep -E "test result|FAILED|panicked"` and `cargo clippy --release --all-targets 2>&1 | grep -E "^(warning|error)"`
Expected: all pass. Existing tests that compare fills with token functions still pass, because the harness renders dark. No clippy output.

- [ ] **Step 5: Commit** `feat(gui): Proton's palette, Phosphor icons and button kinds` (`Refs #276`).

### Task 2: The sidebar (fixes #273)

**Files:**
- Create: `native-gui/src/chrome.rs` (`impl ProtonDriveNativeApp { pub(crate) fn render_sidebar(&mut self, ctx: &egui::Context) }`, moved from `main.rs` ~1825-1990).
- Create: `assets/app-icon/protondrive-mark.svg`, the folder's two paths and gradients from `assets/app-icon/protondrive.svg`, without the white tile, on a square transparent canvas.
- Create: `assets/app-icon/protondrive-mark-128.png`, rendered from that SVG. Use the resvg CLI installed into the scratchpad, not `~/.cargo/bin`: `cargo install resvg --locked --root /tmp/claude-1000/-home-gautam-chauhan-projects-proton-drive/83ab53f0-fea2-45b0-a976-56dd433d1865/scratchpad/tools`.
- Modify: `native-gui/src/main.rs`:
  - `load_glyph_texture` now loads the mark;
  - remove `draw_nav_icon`, `draw_gear_icon` and `jump_to_account`, if unused afterwards.
- Modify: `native-gui/src/home.rs`, `render_your_drive`: remove "Open in Files" and the Proton storage row.

**Interfaces:**
- Consumes: Task 1's palette tokens, `icons::*`, `action_button`, `ButtonKind::Primary`.
- Produces:
  - `pub(crate) const OPEN_IN_FILES: &str = "Open in Files"`;
  - `fn storage_meter_text(account: Option<&AccountInfo>) -> Option<String>`, giving `"{used} / {total}"` with `format_bytes`, e.g. "3.0 GB / 510.0 GB".

**What it draws, top to bottom:**
1. **The logo:** the 28-pt mark, then "Proton Drive" in `SIDEBAR_TEXT()` (18.5, strong).
2. **Open in Files:** a full-width `ButtonKind::Primary` button, 40 tall, with `icons::FOLDER_OPEN` and "Open in Files".
   - Click: `open_in_files(Path::new(&status.sync_dir))`, as Home did.
   - Disabled when `sync_dir` is empty, with hover text "Set up a folder in Settings first".
3. **The sections:** Home, Shared, Activity, each with its `icons::*` glyph.
   - selected: `SIDEBAR_SELECTED()` fill, `SIDEBAR_TEXT()` strong;
   - others: `SIDEBAR_TEXT()` normal, with icons in `SIDEBAR_WEAK()`;
   - hovered: `SIDEBAR_HOVER()`;
   - Home keeps its red count.
4. **At the bottom:**
   - when `storage()` is Some: a 4-pt bar (`STORAGE_FILL()` on `STORAGE_TRACK()`), then a line with `storage_meter_text` on the left and the version on the right, both `SIDEBAR_WEAK()` 11.5;
   - otherwise only the version;
   - the meter's hover text is `storage().tooltip`;
   - the account footer is gone.

- [ ] **Step 1: Write the failing tests**
  - `the_sidebar_offers_home_shared_and_activity_and_no_settings`:
    - `text_at` finds "Home", "Shared" and "Activity" at x < 252;
    - no "Settings" text at x < 252.
  - `open_in_files_in_the_sidebar_opens_the_drive_folder`:
    - set `status.sync_dir = "/home/u/ProtonDrive"`, click `text_at("Open in Files")`;
    - `home::LAUNCHED` contains the folder and `sent()` is empty;
    - Home's card no longer paints "Open in Files" (only one `text_at_all`, at x < 252).
  - `open_in_files_waits_for_a_folder`: with `sync_dir` empty, clicking it launches nothing.
  - `the_storage_meter_shows_used_over_total_and_the_version`:
    - with an account of 3 GB used of 510 GB, `text_at(&storage_meter_text(..).unwrap())` and `text_at(&env!("CARGO_PKG_VERSION"))` are Some, at x < 252, y > 400;
    - signed out (`status.account = None`): no meter text.
  - `home_no_longer_shows_proton_storage`: `text_at("Proton storage")` is None on Home.
  - `the_sidebar_fits_at_840_by_540_zoomed`:
    - `resize_zoomed(Vec2::new(840.0, 540.0), 1.2)`;
    - the bottom of the "Activity" text is above the top of the meter text, and "Open in Files" is above "Home".
  - `the_logo_has_no_dark_tile`: the PNG's corner pixel (2, 2) and its centre-top pixel are fully transparent (`image::load_from_memory(include_bytes!(…))`).

- [ ] **Step 2: Run them and see them fail**

Run: `cargo test --release sidebar storage_meter open_in_files logo home_no_longer 2>&1 | tail -20`
Expected: failures. "Settings" is painted in the sidebar, "Open in Files" is painted twice, and so on.

- [ ] **Step 3: Implement**
  - **Moving the sidebar:** move `render_sidebar` to `chrome.rs` and restyle it as above.
  - **Fixing tests:** update the existing tests that click the sidebar's "Settings" to use `h.app.open_tab(NavTab::Settings)`. Task 3 gives them the gear.

- [ ] **Step 4: Run the whole suite and clippy.** Expected: all pass, no warnings.

- [ ] **Step 5: Screenshots**
  - `--tab home`, light and dark, at 1100×760 and 840×540, into the scratchpad. Look at them.
  - Compare the light one with `images/28.png`'s sidebar. Describe both in the report.

- [ ] **Step 6: Commit** `feat(gui): a Proton sidebar: the mark, Open in Files, the storage meter` (`Fixes #273`, `Refs #276`).

### Task 3: The top bar and the account menu (fixes #274)

**Files:**
- Modify: `native-gui/src/chrome.rs`, adding:
  - `pub(crate) fn render_top_bar(&mut self, ctx: &egui::Context)`;
  - `fn render_account_menu(&mut self, ctx: &egui::Context)`.
- Modify: `native-gui/src/main.rs`:
  - `render_ui` calls `render_top_bar` after `render_sidebar` and before `CentralPanel`. Add `egui::TopBottomPanel::top("top_bar")`, white (`BG_CANVAS()`), about 56 tall, with a `BORDER_SUBTLE()` bottom line.
  - New field `account_menu_open: bool`.
  - Screenshot flag `--account-menu` sets it.
  - `open_tab` closes the menu.
- Modify: `native-gui/src/main.rs` `render_shared` and `native-gui/src/activity.rs`: remove the pages' own "Shared" and "Activity" titles, keeping Refresh and the filters right-aligned in their rows.

**Interfaces:**
- Consumes: Task 1's `icon_button`, `icons::SETTINGS`, `icons::WEB`, `icons::SIGN_OUT`, the palette; Task 2's `storage_meter_text`; `home::storage`, `home::PROTON_DRIVE_WEB_URL`, `home::open_in_browser`.
- Produces: `fn tab_title(tab: NavTab) -> &'static str` returning "Home", "Shared", "Activity" or "Settings".

**What it draws:**
- **The title:** on the left, `tab_title(self.tab)` (17, strong, `TEXT_PRIMARY()`).
- **On the right, right to left:**
  - **The initials:** a 28×28 square, `BORDER_NORM()` outline, radius 6.
  - **The account:** a two-line block, the name (13, `TEXT_PRIMARY()`) over the email (11.5, `TEXT_MUTED()`). Both are middle-truncated to 220 pt.
  - **The gear:** `icon_button(icons::SETTINGS, "Settings")` → `open_tab(NavTab::Settings)`, with `PROTON_PURPLE_SOFT()` fill while Settings is open.
- **Clicking the account:** the name, email and initials are one click target, with accessible name "Account". Clicking it toggles `account_menu_open`.
- **Without an account:** with `status.account` None, the block shows "Not signed in", or "Connecting…" while `initial_connecting`, with "PD" initials. It's not clickable.
- **The menu:**
  - An `egui::Area` at `Order::Foreground`, anchored right-top under the account block, over `click_shield`. Same pattern as `home::pause_choices`.
  - It shows:
    - the initials, name, email and plan badge (as `render_account_card` shows it);
    - "Proton storage" with `storage().text` and a bar;
    - then two `menu_item`-style rows with icons: "Open Proton Drive on the web" → `open_in_browser(PROTON_DRIVE_WEB_URL)`, and "Sign out" → `send_account_command(WorkerCommand::Logout)`.

    Either one closes the menu.
  - Escape, or a click on the shield, closes it.
- **While a dialog is open:** with `pending_confirm` or `share` set, the top bar is disabled (`ui.disable()`), as the sidebar is.

- [ ] **Step 1: Write the failing tests**
  - `the_top_bar_titles_each_section_once`: for each tab, `text_at_all(tab_title(tab)).len() == 1` with x > 252. For Shared and Activity this proves the page titles are gone.
  - `the_gear_opens_settings`: `h.click(h.widget_at("Settings").unwrap())` sets the tab to Settings.
  - `clicking_the_account_opens_the_menu_not_settings`:
    - with an account set, click `widget_at("Account")`;
    - the tab is unchanged, `account_menu_open`, and the menu paints "Sign out" and "Open Proton Drive on the web".
  - `sign_out_in_the_menu_signs_out_at_once_and_closes_it`: click "Sign out" → `sent() == ["sign out"]`, and the menu is closed.
  - `web_in_the_menu_opens_drive_proton_me`: `home::LAUNCHED` contains `PROTON_DRIVE_WEB_URL`.
  - `escape_and_a_click_outside_close_the_menu_without_clicking_through`:
    - Escape closes it;
    - reopen it and click over the "Home" sidebar entry while on Shared: the menu closes and the tab stays Shared.
  - `opening_a_section_closes_the_menu`.
  - `signed_out_the_account_area_says_so_and_opens_nothing`: account None → "Not signed in" painted, and a click leaves `account_menu_open` false.
  - `a_long_name_does_not_push_the_title_or_gear_off_at_840`:
    - a 60-character name and email, `resize_zoomed(Vec2::new(840.0, 540.0), 1.2)`;
    - the title's and the gear's positions are inside the window, the gear is right of the title, and the name text, if found, is right of the gear.
  - `the_top_bar_takes_no_clicks_under_a_dialog`: with `pending_confirm = Some(PendingConfirm::StartFresh)`, clicking the gear's position leaves the tab unchanged.

- [ ] **Step 2: Run them and see them fail**

Run: `cargo test --release top_bar gear account menu 2>&1 | tail -20`
Expected: failures. There's no top bar, and `widget_at("Settings")` is None.

- [ ] **Step 3: Implement**
  - Build the top bar and the menu as above.
  - Point the existing tests that go to Settings (see Task 2 Step 3) back to the gear where they test navigation.
  - Remove `jump_to_account` and its Settings scroll if nothing else uses it.

- [ ] **Step 4: Run the whole suite and clippy.** Expected: all pass, no warnings.

- [ ] **Step 5: Screenshots** of `--tab home`, and of `--tab home --account-menu`, light and dark, at 1100×760 and 840×540. Look at them and describe them in the report.

- [ ] **Step 6: Commit** `feat(gui): a top bar with the gear and an account menu` (`Fixes #274`, `Refs #276`).

**PR 1:** push `feat/276-proton-look`, open the PR (Fixes #273, #274; Refs #276) with the screenshots, merge after the whole-branch review.

---

## PR 2: The pages (branch `feat/276-proton-look-pages` from main after PR 1, fixes #275 and #276)

### Task 4: Home

**Files:**
- Modify: `native-gui/src/home.rs`: `render_status_block` (~569), `render_your_drive` (~792), `render_attention_item` (~676), and the transfers and moves buttons.

**Interfaces:**
- Consumes: Task 1's `action_button`, `icons::*`.
- Produces: `fn status_icon(status: &Status) -> (&'static str, Color32)`:
  - `CHECK`/`STATUS_SUCCESS` up to date;
  - `SYNC`/`PROTON_PURPLE` syncing;
  - `PAUSE`/`STATUS_WARNING` paused;
  - `WARNING`/`STATUS_DANGER` a problem;
  - `OFFLINE`/`TEXT_MUTED()` offline or the daemon unreachable.

  Use the same state tests as the existing title logic.

**Changes:**
- **The status card:** a 32-pt status glyph before the title.
- **Sync now and Pause/Resume:** `action_button` with `icons::SYNC`, `icons::PAUSE` or `icons::RESUME`. Kinds as #254: Resume Primary, Pause Secondary.
- **The trash button:** `OPEN_TRASH` becomes "Trash", with `icons::TRASH` and the same hover text.
- **The drive card:** keeps "Your drive" as a small heading, with `icons::FOLDER` before the path.
- **The other buttons:** Free up space…, the attention items' buttons and the transfers' buttons get fitting icons.

- [ ] **Step 1: Failing tests**
  - `status_icon_matches_each_state`: a unit test over the five states, using the `status(...)` helper home.rs tests already have.
  - `home_offers_trash_with_its_old_hover`: `text_at("Trash")` is Some; hovering it shows `trash_hover(...)`.
  - `every_existing_home_test_still_passes`: no new code; this step is the run.
- [ ] **Step 2: Run and see the new ones fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and clippy.**
- [ ] **Step 5: Screenshots** of Home, light and dark, at both sizes, plus `--drive-status`/`--fake-attention` states. Describe them.
- [ ] **Step 6: Commit** `feat(gui): Home with status icons and icon buttons` (`Refs #276`).

### Task 5: Shared as a Proton list

**Files:**
- Modify: `native-gui/src/main.rs`: `render_shared` (~2014-2190) and the Shared test helpers `row_buttons` and `on_row` (~6832-6845).
- Modify: `native-gui/src/shared.rs`: add the column-text helpers.

**Interfaces:**
- Consumes: Task 1's `icon_button`, `icons::*`, `FOLDER_ICON()`; the existing `shared::folder_text`, `exposure_text`, `can_copy`, `SharedAction` rules.
- Produces:
  - `pub fn sharing_marks(item: &SharedItem, now_ms: i64) -> Vec<&'static str>`: the glyphs for the Sharing column, in order:
    - `LINK`, or `LINK_BROKEN` when expired;
    - then `LOCK` if it has a password;
    - `CLOCK` if it expires and hasn't yet;
    - `PEOPLE` if `people > 0`.
  - `pub fn location_text(item: &SharedItem) -> String`: `folder_text`, or "Hidden from this computer" / "Not on this computer".

**Layout:**
- **A toolbar row:** Refresh becomes `icon_button(icons::REFRESH, "Refresh")`, right-aligned. It keeps the current rules: hidden on error, disabled while loading.
- **Column headers:** "Name", "Location" and "Sharing" in `TEXT_MUTED()` 12, with a `BORDER_SUBTLE()` line under them.
- **One row per item,** about 44 tall, with a `BORDER_SUBTLE()` line between rows and no card:
  - **Name:** a `FOLDER` glyph (`FOLDER_ICON()`) for a name without an extension, else `FILE`, then the name.
  - **Location:** `location_text`.
  - **Sharing:**
    - the `sharing_marks` glyphs, then the person count, with "Link expired" in `STATUS_DANGER` when it applies;
    - the column's hover text is `exposure_text`;
    - an unreadable row shows `WARNING` and its reason instead.
  - **Actions:** icon buttons, right-aligned, with the same set and rules as today:
    - Copy link (`COPY`), Manage… (`MANAGE`), Show in Files (`FOLDER_OPEN`), Stop sharing (`LINK_BROKEN`);
    - Manage on the web (`WEB`).

    Their accessible names and tooltips are those labels. The icons are drawn in `TEXT_MUTED()`, and in `TEXT_PRIMARY()` on the hovered row.
- **Narrow windows:** the Location column narrows and truncates first, then the name; the actions never move.
- **Unchanged:** the Photos note, the empty, loading and error states, and the confirmation, reload, stop and #260 behaviour.
- **#262's wrap:** no longer needed, since icon actions fit in one row. The test asserting the wrap becomes "all action buttons of a row are inside the window at 840×540 and 120% zoom".

- [ ] **Step 1: Failing tests**
  - `sharing_marks_for_each_kind` (shared.rs): the fake rows give their exact glyph lists, e.g. report.pdf → `[LINK, LOCK, CLOCK, PEOPLE]`, old-notes.txt → `[LINK_BROKEN, PEOPLE]`, Icons → `[PEOPLE]`.
  - `location_text_for_each_place` (shared.rs).
  - Update `row_buttons` and `on_row` to use `widgets_at_all` instead of `text_at_all`. All existing Shared tests must then pass unchanged in meaning: `each_kind_of_row_has_its_buttons`, the copy, manage, show and stop tests, R10, R12, #260, #256.
  - `shared_has_column_headers_and_no_card`: "Name", "Location" and "Sharing" are painted; `rects_filled(BG_CARD())` has no rect containing the first row's name.
  - `a_rows_actions_stay_inside_the_window_narrow_and_zoomed`: replaces #262's wrap test at 840×540 and 1.2. Every action's `widget_at` x is ≤ the window's width minus 4, for every row.
- [ ] **Step 2: Run and see the new ones fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and clippy.**
- [ ] **Step 5: Screenshots**
  - `--fake-shared list`, light and dark, at both sizes;
  - the `--confirm-stop-sharing report.pdf` dialog;
  - the empty state.

  Describe them.
- [ ] **Step 6: Commit** `feat(gui): Shared as a Proton list with icon actions` (`Refs #276`).

### Task 6: Activity (fixes #275)

**Files:**
- Modify: `native-gui/src/activity.rs`, and the Activity render code in `main.rs` (find `render_activity`): the filter chips, the search field, the table header.

**Interfaces:**
- Consumes: the palette, `icons::SEARCH`.
- Produces: `fn chip_colors(selected: bool) -> (Color32 /*fill*/, Color32 /*text*/)`:
  - selected → `(PROTON_PURPLE, Color32::WHITE)`;
  - otherwise → `(BG_INPUT(), TEXT_MUTED())`.

**Changes:**
- **The chips** use `chip_colors`.
- **The search field:** the `SEARCH` glyph inside it on the left, `BG_INPUT()` fill, radius 8, no outline until focused.
- **The table header:** no tinted band, `TEXT_MUTED()` 12, with a `BORDER_SUBTLE()` line under it. Rows are separated by `BORDER_SUBTLE()` lines. The status pills are unchanged.

- [ ] **Step 1: Failing tests**
  - `the_selected_chip_is_readable`:
    - for both palettes, `contrast(chip_colors(true).1, chip_colors(true).0) >= 4.5` and the same for `false`;
    - in the harness on Activity, `fill_under(text_at("All"))` is `PROTON_PURPLE`, and the "All" galley's colour is white. Read it from the `Shape::Text` the way `text_at` finds it; add `fn text_color_at(&self, text: &str) -> Option<Color32>` to the harness.
  - `activity_search_has_its_icon`: the `SEARCH` glyph is painted left of the search hint text.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and clippy.**
- [ ] **Step 5: Screenshots** of Activity, light and dark, at both sizes. Describe them.
- [ ] **Step 6: Commit** `fix(gui): Activity's selected filter is readable, Proton's table style` (`Fixes #275`, `Refs #276`).

### Task 7: Settings rows

**Files:**
- Modify: `native-gui/src/settings.rs` (`render_account_card`, `render_hidden_card`), `native-gui/src/main.rs`:
  - `render_drive_card` (~2960);
  - `render_blocked_apps_card` (~3110);
  - `render_sync_settings_card` (~3215);
  - the theme picker (~3285).
- Create: in `settings.rs`, `pub(crate) fn setting_row(ui: &mut egui::Ui, label: &str, hint: Option<&str>, info: Option<&str>, control: impl FnOnce(&mut egui::Ui))`. It puts the label (13.5, `TEXT_PRIMARY()`) and an optional one-line hint (12, `TEXT_MUTED()`) on the left. An `info` text shows an `icons::INFO` glyph after the label, with `info` as hover text. The control goes on the right, vertically centred.

**Interfaces:**
- Consumes: the palette, `icons::INFO`, `icons::WEB`, `icons::TRASH`, `action_button`.
- Produces: `pub(crate) const THEME_CHOICES: [(&str, &str); 3] = [("system", "Follow the system"), ("light", "Light"), ("dark", "Dark")]`.

**Changes:**
- **Every card:** keeps its heading. Each setting becomes a `setting_row`.
- **Long explanations move to `info`:**
  - "Files you haven't downloaded appear in Files and download when you open them.";
  - the blocked-apps paragraph;
  - the hidden-items paragraph.

  Their exact current text becomes the hover text.
- **The Save group:** the Synchronization card keeps Save Preferences at its foot. Its heading gets the hint "These apply when you save". Its rows are the sync folder, the conflict choice, notifications, start at login and ignore patterns, exactly those.
- **The theme picker** uses `THEME_CHOICES`.
- **The Account card's buttons:**
  - "Open Proton Drive on the web" → `action_button(Secondary, Some(icons::WEB), "Web", 32.0)`, hover "Open Proton Drive on the web";
  - "Open Proton Drive Trash" → `(Some(icons::TRASH), "Trash")`, with the same hover as Home.

  Sign out is unchanged.

- [ ] **Step 1: Failing tests**
  - `the_theme_picker_reads_follow_the_system_light_dark`: open the combo and assert the three texts. No "Snow" or "Carbon" is painted anywhere on Settings.
  - `the_virtual_drive_explanation_is_behind_info`:
    - "Files you haven't downloaded appear in Files and download when you open them." is not painted until the `INFO` glyph next to "Show online-only files in Files (virtual drive)" is hovered;
    - then it is.
  - `the_save_group_says_it_applies_when_saved`: "These apply when you save" is painted above "Save Preferences".
  - Existing settings tests (save, block, unhide, the virtual-drive switch and its confirmation) pass unchanged in meaning.
- [ ] **Step 2: Run and see the new ones fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and clippy.**
- [ ] **Step 5: Screenshots** of Settings, light and dark, at both sizes, scrolled to the top and to the bottom. Describe them.
- [ ] **Step 6: Commit** `feat(gui): Settings in Proton's row layout` (`Refs #276`).

### Task 8: Dialogs and the Share window

**Files:**
- Modify: `native-gui/src/main.rs` `render_confirm_modal` (~2600) and `native-gui/src/share.rs` (the Share window's buttons, `section_title`, fields).

**Interfaces:**
- Consumes: `action_button`, `ButtonKind::{Primary, Secondary, Danger}`, `icons::{COPY, LINK, PEOPLE, LINK_BROKEN}`, the palette.

**Changes:**
- **The confirmation:** its buttons become `action_button`: Cancel Secondary, the action Primary, or Danger for Stop sharing, Delete and Switch off, as today.
- **The Share window:**
  - its buttons use `action_button` with icons: Copy link `COPY`, Create link `LINK`, Invite `PEOPLE`, Remove link `LINK_BROKEN`;
  - its fields use `BG_INPUT()` and radius 8;
  - its labels and behaviour are unchanged.

- [ ] **Step 1: Failing test**
  - `the_stop_sharing_confirm_button_is_danger`: `fill_under` on the dialog's "Stop sharing" is `STATUS_DANGER`.
  - `the_share_windows_copy_link_has_its_icon`: the `COPY` glyph is painted left of "Copy link" in the Share window, using `--fake-share` data the way the existing share-window tests do.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and clippy.**
- [ ] **Step 5: Screenshots** of `--confirm-stop-sharing report.pdf --fake-shared list` and of `--share <path> --fake-share link`, light and dark. Describe them.
- [ ] **Step 6: Commit** `feat(gui): dialogs and the Share window in Proton's style` (`Fixes #276`).

**PR 2:**
- Push `feat/276-proton-look-pages` and open the PR (Fixes #275, #276) with the screenshots.
- Merge after the whole-branch review.
- Then deploy the app only. No daemon change, but install both with the GUI killed first, per the deploy rules.
