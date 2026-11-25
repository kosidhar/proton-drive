# Shared Page Loading and Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Shared page shows turning arrows while its list is read, and one easy-to-find Refresh (or Retry) at a time.

**Architecture:** All in the egui app (`native-gui/`). Home's turning-glyph helpers (#345) become shared helpers in
`home.rs`. `shared_view.rs` gains a loading group, a "Refreshing…" toolbar state, centred Refresh/Retry buttons and one
placement helper for its centred groups. `shared.rs` gains the new words and the screenshot-only page states.

**Tech Stack:** Rust, egui/eframe 0.31, the app's test harness (`Harness` in `native-gui/src/main.rs` tests).

**Spec:** `docs/superpowers/specs/2026-11-25-shared-loading-and-refresh-design.md` (issue #410)

## Global Constraints

- Turning: one turn in `home::TURN_SECONDS` (1.5 s), frames every `home::TURN_FRAME` (33 ms). Still (angle 0, no fast
  frames) with GNOME's Reduce animation and in screenshots, exactly as Home's status arrows.
- The turning glyph is `icons::SYNC`. Both Refresh buttons carry `icons::SYNC`. Retry keeps `icons::REFRESH`.
- Words: `shared::LOADING` stays "Loading what you've shared…"; new `shared::REFRESHING` = "Refreshing…". Retry,
  Refresh, the error messages and the empty page's words don't change.
- At most one control named "Refresh" on screen in any state. The arrows and the picture are decoration (no
  AccessKit node); the words say what's happening.
- The loading circle is the empty picture's: radius 48, `share_picture_colors(palette()).circle`, glyph colour
  `.glyph`, glyph 44 pt, in the same 128×112 allocation.
- Repo rules (CLAUDE.md): one branch `feat/410-shared-loading-refresh`, conventional commits, the last says
  `Fixes #410`. Never commit `.claude/`, `target/`, `release/`. No AI attribution in commits.
- Checks before push: `cargo test --release` and `cargo clippy --release --all-targets` (0 warnings) in `native-gui/`.

## Review Focus

1. Refresh from the empty page (rows known to be none, a read out): the loading group shows, not a blank page or
   the empty picture (Task 1).
2. A short or zoomed window: the loading and error groups start below the toolbar and never draw over it, and the
   empty page's centred Refresh is reachable by scrolling (Tasks 1 and 2).
3. The toolbar keeps its height as its right end changes (Refresh ↔ Refreshing… ↔ nothing), so the rows don't jump
   when a reload starts or ends (Task 1).
4. Reduce animation, screenshots and the minimized window give still arrows and no 33 ms frames (Task 1).
5. Screen readers meet exactly one Refresh in the list and empty states, and none while loading, refreshing or on an
   error (Task 2).

---

### Task 1: Turning arrows while the list is read

**Files:**
- Modify: `native-gui/src/home.rs` (turning helpers near `turning_decoration`, `render_status_headline`)
- Modify: `native-gui/src/shared_view.rs` (`render_shared`, `render_shared_empty`, new loading group)
- Modify: `native-gui/src/shared.rs` (`REFRESHING`, the screenshot-only page states)
- Modify: `native-gui/src/main.rs` (`--fake-shared` parsing and screenshot setup near "The worker doesn't read the list
  in a screenshot"; harness tests)

**Interfaces:**
- Produces in `home.rs`:
  - `pub(crate) fn turning_angle(ui: &egui::Ui) -> f32`: the angle for this frame. When motion is allowed
    (`glyph_may_turn()`), it is `turn_angle(time)`, and it asks for the next frame after `TURN_FRAME` unless the window
    is minimized. Otherwise it is 0.0 and asks for nothing. Home's `render_status_headline` uses it (busy:
    `turning_decoration(ui, glyph, 32.0, color, turning_angle(ui))`), so Home behaves exactly as now.
  - `pub(crate) fn turning_decoration(...)` (now `pub(crate)`, same signature).
  - `pub(crate) fn paint_turned_glyph(painter: &egui::Painter, centre: egui::Pos2, icon: &str, size: f32, color: Color32, angle: f32)`:
    paints `icon` turned `angle` clockwise, with the middle of its shape (`galley.mesh_bounds.center()`) at
    `centre`. Use `turned_pos`.
- Produces in `shared_view.rs`:
  - `fn place_above_middle(ui: &mut egui::Ui, id: &str, viewport: f32, add: impl FnOnce(&mut egui::Ui)) -> egui::Response`:
    lays `add` out top-down and centred, starting `((viewport - last_height) * 0.4).max(0.0)` down. `last_height` is
    the group's height last frame, kept under `id`. When it changes, the frame is discarded with `request_discard`.
    This is `render_shared_empty`'s placement, moved out unchanged; the empty page uses it with id
    `"shared_empty_h"`.
- Produces in `shared.rs`: `pub const REFRESHING: &str = "Refreshing…";`, and
  `impl SharedPage { pub fn fake(&mut self, state: &str, now_ms: i64) -> bool }`, which sets the page as
  `--fake-shared <state>` shows it:
  - list, empty, offline: answered, from `fake_shared`;
  - loading: `begin_load` only;
  - refreshing: the list answered, then `begin_load` again.
  It returns false for an unknown state.

- [ ] **Step 1: Write the failing tests** (in `main.rs` tests, beside `shared_shows_each_row_and_each_state`; reuse
  the `status_glyph_angles`/`repaint_in` pattern from the #345 tests, with the size the glyph is painted at)

```rust
// #410: the first read shows the arrows turning in the empty picture's circle, the words under it, and no Refresh
#[test]
fn shared_first_load_turns_the_arrows_in_the_pictures_circle() {
    let mut h = Harness::new();
    h.click(h.text_at("Shared").unwrap());
    h.frames(3);
    let circles: Vec<_> = h.circles_filled(share_picture_colors(palette()).circle).into_iter().filter(|c| c.1 >= 40.0).collect();
    assert_eq!(circles.len(), 1, "{circles:?}");
    let (centre, radius) = circles[0];
    // The arrows' painted middle (pos + Rot2(angle) * mesh centre) is the circle's centre, and they're turned
    let arrows = h.texts(|t| t.galley.job.text == icons::SYNC);
    assert_eq!(arrows.len(), 1);
    let middle = arrows[0].pos + egui::emath::Rot2::from_angle(arrows[0].angle) * arrows[0].galley.mesh_bounds.center().to_vec2();
    assert!(middle.distance(centre) < 2.0, "{middle:?} in {centre:?}");
    assert!(arrows[0].angle > 0.0);
    assert!(repaint_in(&h) <= home::TURN_FRAME);
    let words = h.text_rect(shared::LOADING).expect("the loading words");
    assert!((words.center().x - centre.x).abs() < 2.0 && words.top() > centre.y + radius, "centred under the circle");
    assert!(h.widget_at("Refresh").is_none() && h.text_at(shared::REFRESHING).is_none());
    assert!(h.nodes_named(icons::SYNC).is_empty(), "the arrows aren't announced");
}

// #410 (Review Focus 1): Refresh on the empty page shows the same loading group
#[test]
fn shared_refresh_from_the_empty_page_shows_the_loading_group() { /* empty_shared(); app.load_shared(); frames(3);
   one picture circle with turning SYNC inside; LOADING painted; EMPTY_TITLE not painted */ }

// #410: reloading a list greys its rows and turns the arrows in the toolbar, where Refresh was, at the same height
#[test]
fn shared_reload_turns_the_arrows_in_the_toolbar_and_keeps_the_rows_still() {
    // shared_with_rows(); first row's text_rect y = before; click widget "Refresh"; frames(3):
    //   REFRESHING painted; a 16 pt SYNC glyph turned (angle > 0) left of it; widget "Refresh" none; LOADING none;
    //   the first row's y == before (Review Focus 3); repaint_in <= TURN_FRAME
    // SharedLoaded(seq, Ok(rows)); frames(3): REFRESHING none; widget "Refresh" back; the first row's y == before
}

// #410 (Review Focus 4): still arrows and no fast frames with Reduce animation and in a screenshot
#[test]
fn shared_loading_arrows_are_still_in_a_screenshot_and_with_reduce_animation() { /* as
   home_keeps_the_sync_glyph_still_in_a_screenshot_and_with_reduce_animation, on the first load:
   angle == 0.0 and repaint_in > TURN_FRAME, once with home::AS_SCREENSHOT and once with home::NO_MOTION */ }

// #410 (Review Focus 2): in a short zoomed window the loading group starts below the toolbar
#[test]
fn shared_loading_fits_a_short_zoomed_window() { /* first load; resize_zoomed(840x380, 1.2): the circle's top >=
   the toolbar's bottom (TOP_BAR_HEIGHT + 34 + 8, see Step 3) and the words are under it */ }
```

Also a unit test in `shared.rs` tests, `the_screenshot_states_set_the_page`. It checks:
- `fake("loading")` leaves `items` None with `loading` true;
- `fake("refreshing")` leaves the list's 6 rows with `loading` true;
- `fake("list")`, `fake("empty")` and `fake("offline")` match `fake_shared`;
- `fake("nope")` is false.

- [ ] **Step 2: Run them and see them fail**

Run: `cd native-gui && cargo test --release shared_ 2>&1 | grep -E "test result|FAILED|error"`
Expected: compile errors for `REFRESHING`, `turning_angle`, `SharedPage::fake`, or failures on the new assertions.

- [ ] **Step 3: Implement**

In `home.rs`, add `turning_angle` and `paint_turned_glyph`, make `turning_decoration` `pub(crate)`, and route
`turning_decoration` and `render_status_headline` through them. The #345 tests must still pass unchanged.

In `shared_view.rs`, `render_shared` changes as follows:
- **Toolbar, right end** (the row keeps `set_min_height(34.0)`):
  - error: nothing;
  - a read out with rows showing: `turning_decoration(ui, icons::SYNC, 16.0, PROTON_PURPLE_TEXT(), turning_angle(ui))`,
    then `REFRESHING` at 13 pt in `TEXT_MUTED()`;
  - a read out with no rows: nothing;
  - otherwise: the Refresh control. Task 2 turns it into a labelled button.
- **Page:** while a read is out and there are no rows (`items` None or empty), show the loading group via
  `place_above_middle(ui, "shared_loading_h", viewport, …)`: the 128×112 picture allocation, the circle, the arrows
  painted with `paint_turned_glyph` at the circle's centre, 20 pt of space, then `LOADING` at 13 pt in `TEXT_MUTED()`.
- **Remove** the `LOADING` line above the rows.

In `main.rs`:
- Validate `--fake-shared` against list | empty | offline | loading | refreshing, and say so in the usage text and in
  the unknown-state warning.
- Replace the setup's `loaded(...)` with `app.shared.fake(state, now)`. With no `--fake-shared`, it still shows
  empty.

Update the existing tests that assumed the old states:
- `a_reload_keeps_the_list_until_the_new_one_comes` and the end of `only_the_newest_read_is_shown`: the reload with
  rows shows `REFRESHING`, not `LOADING`.
- `refresh_does_nothing_while_a_read_is_out` becomes `refresh_is_not_offered_while_a_read_is_out`: no "Refresh"
  widget while the read is out, and nothing sent.
- The two empty-page tests measure the page's top as `TOP_BAR_HEIGHT + 34.0 + 8.0` (the toolbar's row and its gap,
  `SCROLL_GUTTER.top` being 0) instead of from the Refresh widget. Put this in one test helper,
  `fn shared_content_top() -> f32`.

- [ ] **Step 4: Run the tests and clippy**

Run: `cd native-gui && cargo test --release 2>&1 | grep -E "test result|FAILED|panicked"` and
`cargo clippy --release --all-targets 2>&1 | grep -cE "^(warning|error)"`
Expected: all pass (the 2 test binaries `ok`), clippy count 0.

- [ ] **Step 5: Commit**

```bash
git add native-gui/src/home.rs native-gui/src/shared_view.rs native-gui/src/shared.rs native-gui/src/main.rs
git commit -m "feat(gui): the Shared page turns the sync arrows while its list is read

Refs #410"
```

### Task 2: One Refresh, where the eyes are

**Files:**
- Modify: `native-gui/src/shared_view.rs` (toolbar Refresh, `render_shared_empty`, the error branch of `render_shared`)
- Modify: `native-gui/src/main.rs` (harness tests)

**Interfaces:**
- Consumes: `place_above_middle` (Task 1), `turning_angle` (Task 1), `action_button(ui, kind, icon, label, height)`.

- [ ] **Step 1: Write the failing tests**

```rust
// #410: with a list, Refresh is a labelled button with the sync glyph at the toolbar's right end
#[test]
fn shared_refresh_is_a_labelled_button_with_rows() { /* shared_with_rows(): text "Refresh" painted (the label);
   an icons::SYNC glyph painted on its row, left of the label; nodes_named("Refresh").len() == 1, Role::Button;
   click it: sent == ["shared list"] */ }

// #410: nothing shared: a centred Refresh between the how line and the Photos line, and none in the toolbar
#[test]
fn shared_empty_offers_a_centred_refresh() { /* empty_shared(): let r = widget_at("Refresh"); |r.x - EMPTY_HOW
   centre x| < 2; EMPTY_HOW bottom < r.y < EMPTY_PHOTOS top (or PHOTOS_LINK top when stacked);
   nodes_named("Refresh").len() == 1; click: sent == ["shared list"] */ }

// #410: couldn't read: the message and a primary Retry, centred, placed as the empty group is
#[test]
fn shared_error_centres_the_message_and_retry() { /* first load, then SharedLoaded(seq, Err(offline)): the message's
   centre x and Retry's x within 2 of each other and within 30 of the page's middle ((SIDEBAR_EDGE + screen.x)/2);
   Retry below the message; the message's top - shared_content_top() > 40 (not at the top); still red
   (painted_color == DANGER_TEXT()); nodes_named("Refresh") empty; click Retry: sent == ["shared list"] */ }

// #410 (Review Focus 5): one Refresh at most, in every state
#[test]
fn shared_shows_at_most_one_refresh_in_every_state() { /* nodes_named("Refresh").len(): first load 0, rows 1,
   refreshing 0, empty 1, error 0 */ }
```

And extend `shared_empty_fits_a_small_zoomed_window` (Review Focus 2): at 840×380 ×1.2 the centred Refresh is below
the fold until scrolled, then reachable, under the how line.

- [ ] **Step 2: Run them and see them fail**

Run: `cd native-gui && cargo test --release shared_ 2>&1 | grep -E "test result|FAILED"`
Expected: the new tests FAIL (no centred Refresh; the error at the top left; the toolbar Refresh unlabelled).

- [ ] **Step 3: Implement**

- **Toolbar:** with rows and no read out, the Refresh control is
  `action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0)`. There is no toolbar Refresh on
  the empty page. A click calls `self.load_shared()`.
- **Empty page:** in `render_shared_empty`, after `EMPTY_HOW` add 16 pt, then a centred
  `action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0)`, then the 24 pt before the Photos
  line. The method becomes `&mut self`, or returns whether Refresh was clicked; it's the implementer's call.
- **Error:** via `place_above_middle(ui, "shared_error_h", viewport, …)`: the message at 13 pt in `DANGER_TEXT()`,
  wrapped and centred, at most 420 wide (as `EMPTY_HOW` is), then 12 pt, then
  `action_button(ui, ButtonKind::Primary, Some(icons::REFRESH), "Retry", 34.0)`.

- [ ] **Step 4: Run all tests, clippy, and look at it**

Run: `cd native-gui && cargo test --release 2>&1 | grep -E "test result|FAILED|panicked"` and
`cargo clippy --release --all-targets 2>&1 | grep -cE "^(warning|error)"`. Expected: all pass, 0.

Then screenshots, in light and dark at 1180×940: `--tab shared --fake-shared` with list, empty, offline, loading and
refreshing. Use the stand-in daemon setup (`--screenshot <png> --theme <t> --size 1180x940`, with HOME, XDG_CONFIG_HOME
and XDG_RUNTIME_DIR in a scratch folder). Look at each.

- [ ] **Step 5: Commit**

```bash
git add native-gui/src/shared_view.rs native-gui/src/main.rs docs/superpowers/specs/2026-11-25-shared-loading-and-refresh-design.md docs/superpowers/plans/2026-11-25-shared-loading-and-refresh.md
git commit -m "feat(gui): one Refresh on the Shared page, labelled, or centred on the empty and error pages

Fixes #410"
```
