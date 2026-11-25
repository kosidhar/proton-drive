//! Settings' own cards: the account (who is signed in, their plan and storage, Sign out), what is hidden from this
//! computer, with Unhide, and the theme; and the row every setting is laid out in, as Proton lays out its settings.

use eframe::egui::{self, Align, CornerRadius, FontFamily, FontId, Frame, Layout, Margin, RichText, Sense, Stroke, Vec2};

use crate::home::{
    card_title, elided, open_in_browser, storage, trash_hover, OPEN_TRASH, OPEN_WEB, PROTON_DRIVE_TRASH_URL,
    PROTON_DRIVE_WEB_URL, TRASH_BUTTON,
};
use crate::{
    action_button, action_button_named, action_button_width, card_frame, focus_ring, icons, save_window_geometry, text_width, toggle_switch,
    ButtonKind, ProtonDriveNativeApp, WorkerCommand, BG_INPUT, BORDER_NORM, BORDER_SUBTLE, DANGER_TEXT,
    HIDDEN_NEEDS_RESTART, PROTON_PURPLE, PROTON_PURPLE_TEXT, TEXT_MUTED, TEXT_PRIMARY,
};

/// The themes the Appearance card offers: what is saved, and what the picker says.
pub(crate) const THEME_CHOICES: [(&str, &str); 3] = [("system", "Follow the system"), ("light", "Light"), ("dark", "Dark")];

/// A setting's label, and its hint under it
const LABEL_SIZE: f32 = 13.5;
const HINT_SIZE: f32 = 12.0;
/// The room between a setting's label and its hint
const HINT_GAP: f32 = 2.0;
/// A setting's row is at least this tall: room for a 32 pt field or button
pub(crate) const ROW_HEIGHT: f32 = 36.0;
/// The room between two settings' rows
pub(crate) const ROW_GAP: f32 = 6.0;
/// The room between a setting's label and its control
const CONTROL_GAP: f32 = 16.0;
/// The least share of a row its control has, however much its label would take
const CONTROL_SHARE: f32 = 0.4;
/// The ⓘ after a label
const INFO_SIZE: f32 = 16.0;
/// The room over and under a picker's text: as tall as a 32 pt field
const PICKER_PADDING_Y: f32 = 7.0;
/// A wide control (a field, a picker, a text box) at its widest
pub(crate) const WIDE_CONTROL: f32 = 360.0;
/// A row narrower than this has its control under its label
pub(crate) const STACKED_BELOW: f32 = 440.0;
/// The room between a label and the control under it
const STACKED_GAP: f32 = 6.0;

/// A setting as Proton lays one out (#276): its label, and a one-line `hint` at most, on the left; the ⓘ after the label
/// when there is more to say (`info`, on hover, a click or keyboard focus); and its `control` on the right, vertically
/// centred.
/// The control has the room the label leaves (but at least 40% of the row) and sizes itself to `ui.available_width()`,
/// as one widget or one group; the label, then the hint, are cut to the room it leaves, whole on hover. In a row
/// narrower than `STACKED_BELOW` (a small window, a large zoom), the control goes under its label instead, as on
/// Proton's settings on a phone.
///
/// `control` returns its main widget, which screen readers hear named by the label (unless the control already carries
/// its own non-empty name, as an action button does) and described by `info`. The label is no stop for the Tab key.
/// Returns the label's response.
pub(crate) fn setting_row(
    ui: &mut egui::Ui,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    control: impl FnOnce(&mut egui::Ui) -> egui::Response,
) -> egui::Response {
    row(ui, true, label, RowLabel::Words, hint, info, None, control)
}

/// `setting_row` with a `note` (how a change went, or that a move is under way) beside its control, in the room the
/// row already has, so it never changes where the rows below are (#428).
pub(crate) fn setting_row_noted(
    ui: &mut egui::Ui,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    note: Option<&RowNote>,
    control: impl FnOnce(&mut egui::Ui) -> egui::Response,
) -> egui::Response {
    row(ui, true, label, RowLabel::Words, hint, info, note, control)
}

/// What kind of thing a row's note says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NoteTone {
    /// A change was saved
    Success,
    /// A change wasn't made, and why
    Error,
    /// Something is under way
    Working,
}

/// A line beside a setting's control: its words, and a tone that gives its colour and icon.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RowNote {
    pub text: String,
    pub tone: NoteTone,
}

/// The room an icon takes before a note's words, with the gap after it
const NOTE_ICON_ROOM: f32 = 18.0;
/// The room between a row's label (or its control) and a note beside it
const NOTE_GAP: f32 = 4.0;
/// A note with less room for its words than this is its icon alone
const NOTE_WORDS_MIN: f32 = 28.0;
/// A note with less room than its icon shows nothing
const NOTE_MIN_ROOM: f32 = 14.0;

/// Draws `note` in `rect`, on one line: its icon, then its words cut to the room left (whole on hover), flush with the
/// right edge of `rect` when `right_aligned`, else with its left. The words are announced politely as they appear (#425).
/// Whether it fit: not when `rect` has no room even for the icon.
fn draw_note(ui: &mut egui::Ui, rect: egui::Rect, note: &RowNote, right_aligned: bool) -> bool {
    if rect.width() < NOTE_MIN_ROOM || rect.height() < 14.0 {
        return false;
    }
    let layout = if right_aligned { Layout::right_to_left(Align::Center) } else { Layout::left_to_right(Align::Center) };
    // A child that takes no room from its parent: the note is drawn into the row, it doesn't lay a line of its own out
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(layout));
    note_contents(&mut child, note, rect.width());
    true
}

/// A note with no room beside its control (a squeezed or stacked row): on a line of its own under the row, at the right,
/// as it was before #428. Seen and announced all the same, never dropped: an error says why the control went back.
fn note_line(ui: &mut egui::Ui, note: &RowNote) {
    let color = match note.tone {
        NoteTone::Success => TEXT_MUTED(),
        NoteTone::Error => DANGER_TEXT(),
        NoteTone::Working => PROTON_PURPLE_TEXT(),
    };
    ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
        let label = ui.add(egui::Label::new(RichText::new(&note.text).size(12.5).color(color)).wrap());
        ui.ctx().accesskit_node_builder(label.id, |node| node.set_live(egui::accesskit::Live::Polite));
    });
}

/// A note's icon and words in `room`, in the layout `ui` has: for a control's own row, whose layout runs right to left
/// (so the words go first, and the icon after them).
fn note_contents(ui: &mut egui::Ui, note: &RowNote, room: f32) {
    let (color, icon) = match note.tone {
        NoteTone::Success => (TEXT_MUTED(), icons::CHECK),
        NoteTone::Error => (DANGER_TEXT(), icons::WARNING),
        NoteTone::Working => (PROTON_PURPLE_TEXT(), icons::REFRESH),
    };
    let right_to_left = ui.layout().prefer_right_to_left();
    ui.spacing_mut().item_spacing.x = 4.0;
    let icon_only = room - NOTE_ICON_ROOM < NOTE_WORDS_MIN;
    let words = |ui: &mut egui::Ui| {
        ui.scope(|ui| {
            ui.set_max_width((room - NOTE_ICON_ROOM).max(1.0));
            let label = ui.add(egui::Label::new(RichText::new(&note.text).size(12.5).color(color)).truncate());
            // Announced as it appears, as the Working… lines are (#370)
            ui.ctx().accesskit_node_builder(label.id, |node| node.set_live(egui::accesskit::Live::Polite));
        });
    };
    let icon = |ui: &mut egui::Ui| {
        let glyph = crate::decoration(ui, icon, 14.0, color).on_hover_text(&note.text);
        if icon_only {
            // No room for the words: the icon says it, and carries the words for screen readers, announced politely
            glyph.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, true, &note.text));
            ui.ctx().accesskit_node_builder(glyph.id, |node| {
                node.set_label(note.text.as_str());
                node.set_live(egui::accesskit::Live::Polite);
            });
        }
    };
    if icon_only {
        icon(ui);
    } else if right_to_left {
        words(ui);
        icon(ui);
    } else {
        icon(ui);
        words(ui);
    }
}

/// `setting_row` for a name typed as code, an app's process name, which its label shows in monospace.
pub(crate) fn code_row(ui: &mut egui::Ui, name: &str, control: impl FnOnce(&mut egui::Ui) -> egui::Response) -> egui::Response {
    row(ui, true, name, RowLabel::Code, None, None, None, control)
}

/// What a row's label is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RowLabel {
    /// Words, in the app's font
    Words,
    /// A name typed as code, in monospace
    Code,
    /// A switch's words, which flip it when clicked, as a label does on the web (but no stop for the Tab key: the
    /// switch is)
    Switch,
}

impl RowLabel {
    fn font(self) -> FontId {
        match self {
            RowLabel::Code => FontId::monospace(LABEL_SIZE),
            RowLabel::Words | RowLabel::Switch => FontId::proportional(LABEL_SIZE),
        }
    }
}

/// `setting_row`, with its label as `kind` says. When `!enabled`, the control and its label are greyed out while any
/// ⓘ stays enabled so keyboard users can still Tab to it and read its explanation (#289).
#[allow(clippy::too_many_arguments)] // a row's label, hint, ⓘ, note slot and control are each its own
fn row(
    ui: &mut egui::Ui,
    enabled: bool,
    label: &str,
    kind: RowLabel,
    hint: Option<&str>,
    info: Option<&str>,
    note: Option<&RowNote>,
    control: impl FnOnce(&mut egui::Ui) -> egui::Response,
) -> egui::Response {
    let width = ui.available_width();
    if width < STACKED_BELOW {
        return ui
            .vertical(|ui| {
                // The note on the label's line, at the right, in what the label and its hint leave
                let mut stacked_fits = true;
                let top = ui.cursor().min;
                let column = ui.scope(|ui| label_column(ui, enabled, label, kind, hint, info));
                let label = column.inner;
                if let Some(note) = note {
                    let line_h = ui.fonts(|f| f.row_height(&kind.font())).max(INFO_SIZE);
                    let left = (column.response.rect.right() + NOTE_GAP).min(top.x + width);
                    let rect = egui::Rect::from_min_max(egui::pos2(left, top.y), egui::pos2(top.x + width, top.y + line_h));
                    stacked_fits = draw_note(ui, rect, note, true);
                }
                ui.add_space(STACKED_GAP);
                let control = ui.add_enabled_ui(enabled, control).inner;
                name_control(ui, &control, &label, info);
                if let Some(note) = note.filter(|_| !stacked_fits) {
                    note_line(ui, note);
                }
                label
            })
            .inner;
    }
    let label_font = kind.font();
    let hint_font = FontId::proportional(HINT_SIZE);
    let label_need = text_width(ui.painter(), label, &label_font) + info_room(ui, info);
    let need = hint.map_or(label_need, |hint| label_need.max(text_width(ui.painter(), hint, &hint_font)));
    let label_h = ui.fonts(|f| f.row_height(&label_font)).max(INFO_SIZE).max(ui.spacing().interact_size.y);
    let left_h = label_h + hint.map_or(0.0, |_| HINT_GAP + ui.fonts(|f| f.row_height(&hint_font)));
    let row_h = left_h.max(ROW_HEIGHT);
    let gap = CONTROL_GAP + ui.spacing().item_spacing.x;
    let control_room = (width - need - gap).max(width * CONTROL_SHARE);
    // Lay out label + ⓘ first (left to right for Tab and screen readers) while keeping the control right-aligned and
    // giving the label every pixel the control doesn't use (#367).
    let size_key = ui.id().with(("setting_row_ctrl_size", label));
    let cached = ui.ctx().data(|d| d.get_temp::<Vec2>(size_key));
    let (est_w, est_h) = match cached {
        Some(sz) => (sz.x.min(control_room), sz.y.max(row_h)),
        None => (control_room, row_h),
    };
    let label_w = (width - est_w - CONTROL_GAP).max(0.0);
    let total_h = est_h.max(row_h);
    let (_, row_rect) = ui.allocate_space(Vec2::new(width, total_h));
    // The label level with the control's middle, or beside a control taller than the row (a text box), with its top line
    let top = if total_h > row_h + 0.5 {
        row_rect.top() + (row_h - left_h) / 2.0
    } else {
        row_rect.center().y - left_h / 2.0
    };
    let column = egui::Rect::from_min_max(
        egui::pos2(row_rect.left(), top),
        egui::pos2((row_rect.left() + label_w).min(row_rect.right()), top + left_h),
    );
    let label_resp = ui
        .scope_builder(egui::UiBuilder::new().max_rect(column).layout(Layout::top_down(Align::Min)), |ui| {
            label_column(ui, enabled, label, kind, hint, info)
        })
        .inner;
    let ctrl_rect = egui::Rect::from_min_max(
        egui::pos2((row_rect.right() - control_room).max(row_rect.left()), row_rect.top()),
        row_rect.max,
    );
    let control_out = ui.scope_builder(
        egui::UiBuilder::new().max_rect(ctrl_rect).layout(Layout::right_to_left(Align::Center)),
        |ui| {
            ui.set_max_width(control_room);
            ui.add_enabled_ui(enabled, control).inner
        },
    );
    let actual = control_out.response.rect.size();
    if cached.is_none_or(|c| (c.x - actual.x).abs() > 0.5 || (c.y - actual.y).abs() > 0.5) {
        ui.ctx().data_mut(|d| d.insert_temp(size_key, actual));
        ui.ctx().request_discard("setting_row_ctrl_size");
    }
    let mut fits = true;
    if let Some(note) = note {
        if total_h > row_h + 0.5 {
            // A control taller than its label (a text box): the note under the label's hint, in the label's column,
            // and no taller than what is left of the box
            let top = column.bottom() + HINT_GAP;
            let rect = egui::Rect::from_min_max(egui::pos2(column.left(), top), egui::pos2(column.right(), row_rect.bottom()));
            fits = draw_note(ui, rect, note, false);
        } else {
            // Just left of the control, in what its label doesn't take
            let left = row_rect.left() + need.min(label_w) + NOTE_GAP;
            let right = control_out.response.rect.left() - NOTE_GAP;
            let rect = egui::Rect::from_min_max(egui::pos2(left, row_rect.top()), egui::pos2(right.max(left), row_rect.bottom()));
            fits = draw_note(ui, rect, note, true);
        }
    }
    name_control(ui, &control_out.inner, &label_resp, info);
    if let Some(note) = note.filter(|_| !fits) {
        note_line(ui, note);
    }
    label_resp
}

/// Links `control` to its row's `label` and `info` for screen readers: controls without an explicit name of their own
/// (switches, text fields, pickers) are named by the row's label, while action buttons that carry their own non-empty
/// name (such as "Unblock rg" or "Unhide Docs/Private") keep that name instead of a conflicting `labelled_by` (#291).
fn name_control(ui: &egui::Ui, control: &egui::Response, label: &egui::Response, info: Option<&str>) {
    crate::scroll_to_focused(ui, control);
    let mut needs_label = false;
    ui.ctx().accesskit_node_builder(control.id, |node| {
        // A name of its own, even an empty one (egui's picker has one), is read instead of its label's
        if node.label().is_some_and(str::is_empty) {
            node.clear_label();
        }
        needs_label = node.label().is_none();
        if let Some(info) = info {
            node.set_description(info);
        }
    });
    if needs_label {
        let _ = control.clone().labelled_by(label.id);
    }
}

/// The room the ⓘ takes after a label, if there is one.
fn info_room(ui: &egui::Ui, info: Option<&str>) -> f32 {
    if info.is_some() {
        ui.spacing().item_spacing.x + INFO_SIZE
    } else {
        0.0
    }
}

/// A setting's label, cut to the room there is with its ⓘ after it, over its hint. The label's response.
fn label_column(
    ui: &mut egui::Ui,
    enabled: bool,
    label: &str,
    kind: RowLabel,
    hint: Option<&str>,
    info: Option<&str>,
) -> egui::Response {
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = HINT_GAP;
        let label = ui
            .horizontal(|ui| {
                let room = (ui.available_width() - info_room(ui, info)).max(0.0);
                let text = RichText::new(label).font(kind.font()).color(TEXT_PRIMARY());
                let label = ui
                    .scope(|ui| {
                        ui.set_max_width(room);
                        ui.add_enabled_ui(enabled, |ui| {
                            let label = egui::Label::new(text).truncate();
                            // A switch's label takes clicks, but not the keyboard's focus
                            ui.add(if kind == RowLabel::Switch { label.sense(Sense::CLICK) } else { label })
                        })
                        .inner
                    })
                    .inner;
                // Keep ⓘ outside the row's disabled scope so keyboard users can still reach it with Tab (#289)
                if let Some(info) = info {
                    info_glyph(ui, info);
                }
                label
            })
            .inner;
        if let Some(hint) = hint {
            let text = RichText::new(hint).font(FontId::proportional(HINT_SIZE)).color(TEXT_MUTED());
            ui.add_enabled_ui(enabled, |ui| ui.add(egui::Label::new(text).truncate()));
        }
        label
    })
    .inner
}

/// A setting that is on or off: `setting_row` with a switch, which a click on the label flips too, and a `note` beside
/// the switch (see `setting_row_noted`). Whether either was clicked: the caller flips the setting.
pub(crate) fn switch_row_noted(
    ui: &mut egui::Ui,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    on: bool,
    note: Option<&RowNote>,
) -> bool {
    switch_row_with(ui, true, label, hint, info, on, note)
}

/// A switch row, greyed out unless `enabled` while keeping its ⓘ reachable with the keyboard (#289).
pub(crate) fn switch_row_if(
    ui: &mut egui::Ui,
    enabled: bool,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    on: bool,
) -> bool {
    switch_row_with(ui, enabled, label, hint, info, on, None)
}

fn switch_row_with(
    ui: &mut egui::Ui,
    enabled: bool,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    on: bool,
    note: Option<&RowNote>,
) -> bool {
    let mut switch = None;
    let label_response = row(ui, enabled, label, RowLabel::Switch, hint, info, note, |ui| {
        let response = toggle_switch(ui, on);
        switch = Some(response.clone());
        response
    });
    let active = enabled && ui.is_enabled();
    if label_response.hovered() && active {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let switch = switch.expect("setting_row lays out its control");
    // Named by its label for screen readers, and on or off
    switch.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, active, on, label));
    (switch.clicked() || label_response.clicked()) && active
}

/// A Settings card's heading, in bold, with the ⓘ after it when there is more to say (`info`, on hover or a click),
/// and a one-line `hint` under it.
pub(crate) fn card_heading(ui: &mut egui::Ui, title: &str, hint: Option<&str>, info: Option<&str>) {
    ui.horizontal(|ui| {
        card_title(ui, title);
        if let Some(info) = info {
            info_glyph(ui, info);
        }
    });
    if let Some(hint) = hint {
        ui.add_space(HINT_GAP);
        ui.label(RichText::new(hint).font(FontId::proportional(HINT_SIZE)).color(TEXT_MUTED()));
    }
}

/// A picker (egui's combo box) that looks like the fields beside it: as tall, in the field's colours, its text cut to
/// `width` at most. The list it opens keeps the app's look.
pub(crate) fn picker<R>(
    ui: &mut egui::Ui,
    id_salt: &str,
    selected: &str,
    width: f32,
    choices: impl FnOnce(&mut egui::Ui) -> R,
) -> egui::InnerResponse<Option<R>> {
    ui.scope(|ui| {
        ui.spacing_mut().button_padding = Vec2::new(10.0, PICKER_PADDING_Y);
        let widgets = &mut ui.visuals_mut().widgets;
        for (state, border) in [
            (&mut widgets.inactive, BORDER_SUBTLE()),
            (&mut widgets.hovered, BORDER_NORM()),
            (&mut widgets.active, BORDER_NORM()),
            (&mut widgets.open, PROTON_PURPLE),
        ] {
            state.weak_bg_fill = BG_INPUT();
            state.bg_stroke = Stroke::new(1.0_f32, border);
            state.fg_stroke.color = TEXT_PRIMARY();
            state.expansion = 0.0;
        }
        // In a box of exactly its size, which the row centres (egui's combo box, put in a centring layout as it is,
        // sits a few points low)
        let text_h = ui.text_style_height(&egui::TextStyle::Button).max(ui.spacing().icon_width);
        let size = Vec2::new(width, text_h + 2.0 * PICKER_PADDING_Y);
        let shown = ui.allocate_ui_with_layout(size, Layout::top_down(Align::Min), |ui| {
            egui::ComboBox::from_id_salt(id_salt).selected_text(selected).width(width).truncate().show_ui(ui, choices)
        });
        // Cut short, the choice is whole on hover
        let room = width - 2.0 * ui.spacing().button_padding.x - ui.spacing().icon_width - ui.spacing().icon_spacing;
        let font = egui::TextStyle::Button.resolve(ui.style());
        let mut shown = shown.inner;
        focus_ring(ui, &shown.response, 8.0);
        if text_width(ui.painter(), selected, &font) > room {
            shown.response = shown.response.on_hover_text(selected);
        }
        shown
    })
    .inner
}

/// The ⓘ a click (or Enter) opened (#318), and the pass it was last drawn in. One at a time; it closes on a click
/// elsewhere, a second click on it, Escape, Tab (the focus moving on), a wheel turn, the focus coming to another ⓘ,
/// or once it isn't drawn (another section open, or scrolled out of sight).
#[derive(Clone, Copy)]
struct OpenInfo {
    id: egui::Id,
    pass: u64,
}

const OPEN_INFO: &str = "settings_open_info";

/// An ⓘ that shows `info` on hover, greyed out or not, on a click until a click elsewhere (egui hides a tooltip right
/// after a click, #318), and on the keyboard's focus (it is a stop for the Tab key, with a focus ring); and hands it to
/// screen readers.
fn info_glyph(ui: &mut egui::Ui, info: &str) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(INFO_SIZE), Sense::click());
    let enabled = ui.is_enabled();
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, info));
    ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, icons::INFO, icons::font(INFO_SIZE - 1.0), TEXT_MUTED());
    focus_ring(ui, &response, INFO_SIZE / 2.0);
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }

    let ctx = ui.ctx().clone();
    let key = egui::Id::new(OPEN_INFO);
    let pass = ctx.cumulative_pass_nr();
    let open = ctx.data(|d| d.get_temp::<OpenInfo>(key));
    // Still open if it was this one, drawn in the last pass, and in sight
    let mut is_open = open.is_some_and(|o| o.id == response.id && o.pass + 1 >= pass) && ui.is_rect_visible(rect);
    // A greyed-out ⓘ takes no clicks as a widget, so the click is read off the pointer, where the ⓘ is in sight
    // (not scrolled under the top bar); under a dialog, the dialog's shield is the layer under the pointer, and
    // nothing opens
    let clicked = if enabled {
        response.clicked()
    } else {
        ctx.input(|i| i.pointer.primary_clicked()) && ui.rect_contains_pointer(rect)
    };
    if clicked {
        is_open = !is_open;
    } else if ctx.input(|i| {
        let keys = i.key_pressed(egui::Key::Escape) || i.key_pressed(egui::Key::Tab);
        // A wheel turn too, as egui hides its tooltips on a scroll: over the box, which takes the pointer, the page
        // wouldn't scroll while it is open
        i.pointer.any_click() || keys || i.raw_scroll_delta != Vec2::ZERO
    }) {
        is_open = false;
    }
    // One at a time: the focus coming to this ⓘ (from a screen reader, say) closes another that is open. (Asked here:
    // asking for the focus inside `data_mut` would lock the context twice.)
    let focus_takes_over = response.has_focus() && open.is_some_and(|o| o.id != response.id);
    ctx.data_mut(|d| {
        if is_open {
            d.insert_temp(key, OpenInfo { id: response.id, pass });
        } else if open.is_some_and(|o| o.id == response.id) || focus_takes_over {
            d.remove::<OpenInfo>(key);
        }
    });

    // Open, or with the keyboard's focus (under the pointer too, so the words don't drop out while egui's hover delay
    // runs), and in sight
    if (is_open || response.has_focus()) && ui.is_rect_visible(rect) {
        show_info_words(&ctx, response.id, rect, info);
        response
    } else {
        let words = |ui: &mut egui::Ui| {
            ui.set_max_width(ui.spacing().tooltip_width);
            ui.add(egui::Label::new(info));
        };
        response.on_hover_ui(words).on_disabled_hover_ui(words)
    }
}

/// An ⓘ's words in egui's tooltip box, where egui puts a tooltip (under the ⓘ, else above it, kept on the
/// screen), in an area of their own rather than as a tooltip: egui shows one tooltip at a time, so a tooltip held
/// open would keep every other widget's from showing on hover (#318). The box takes the clicks on it, which close
/// it: a click never reaches the control it hides (in a narrow window, the drive's ⓘ's words cover its switch).
fn show_info_words(ctx: &egui::Context, id: egui::Id, anchor: egui::Rect, info: &str) {
    /// egui's gap between a widget and its tooltip
    const GAP: f32 = 4.0;
    let style = ctx.style();
    let frame = Frame::popup(&style);
    let width = style.spacing.tooltip_width;
    // Its size, to put it where egui would: the words laid out as the label in it lays them out
    let font = egui::TextStyle::Body.resolve(&style);
    let words = ctx.fonts(|f| f.layout(info.to_owned(), font, style.visuals.text_color(), width)).size();
    let size = words + frame.total_margin().sum();
    let screen = ctx.screen_rect();
    let fits_below = anchor.bottom() + GAP + size.y <= screen.bottom();
    let top = if fits_below { anchor.bottom() + GAP } else { anchor.top() - GAP - size.y };
    let outer = egui::Rect::from_min_size(egui::pos2(anchor.left(), top), size);
    // Kept on the screen, as egui keeps an area: pushed left off the right edge, then onto the left and top edges
    let outer = outer.translate(Vec2::new((screen.right() - outer.right()).min(0.0), 0.0));
    let onto_screen = Vec2::new((screen.left() - outer.left()).max(0.0), (screen.top() - outer.top()).max(0.0));
    let outer = outer.translate(onto_screen);
    // Each ⓘ's box an area of its own, as a focused one may show while another's closes; non-interactable during a
    // wheel turn so the page's ScrollArea underneath receives the scroll (#319)
    let scrolling = ctx.input(|i| i.raw_scroll_delta != Vec2::ZERO);
    egui::Area::new(egui::Id::new(OPEN_INFO).with(id))
        .order(egui::Order::Tooltip)
        .fixed_pos(outer.min)
        .interactable(!scrolling)
        .sense(Sense::CLICK)
        .show(ctx, |ui| {
            frame.show(ui, |ui| {
                ui.set_max_width(width);
                ui.add(egui::Label::new(info).selectable(false));
            });
        });
}

/// Closes the ⓘ a click opened, if any: a dialog or the Share window is opening over Settings.
pub(crate) fn close_open_info(ctx: &egui::Context) {
    ctx.data_mut(|d| d.remove::<OpenInfo>(egui::Id::new(OPEN_INFO)));
}

/// The plan, as the account's quota tells it.
pub fn plan_name(max_space: u64) -> &'static str {
    const GB: u64 = 1024 * 1024 * 1024;
    if max_space >= 400 * GB {
        "Proton Unlimited"
    } else if max_space >= 15 * GB {
        "Proton Drive Plus"
    } else {
        "Proton Free"
    }
}

impl ProtonDriveNativeApp {
    /// Account: the initials, name and email, the plan, the storage used, and Sign out (Sign in while signed out).
    pub(crate) fn render_account_card(&mut self, ui: &mut egui::Ui) {
        let account = self.status.account.clone();
        let (name, email, initials) = match &account {
            Some(a) => (
                if a.display_name.is_empty() { "Proton Account".to_string() } else { a.display_name.clone() },
                a.email.clone(),
                if a.initials.is_empty() { "PD".to_string() } else { a.initials.clone() },
            ),
            None if self.status.logged_in => ("Proton Account".to_string(), String::new(), "PD".to_string()),
            None => ("Not signed in".to_string(), String::new(), "PD".to_string()),
        };
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_heading(ui, "Account", None, None);
            ui.add_space(12.0);
            let plan = account.as_ref().filter(|a| a.max_space > 0).map(|a| plan_name(a.max_space));
            let logged_in = self.status.logged_in;
            let mut account_command = None;
            let paint_avatar = |ui: &mut egui::Ui| {
                let (avatar, _) = ui.allocate_exact_size(Vec2::new(44.0, 44.0), Sense::hover());
                ui.painter().rect_filled(avatar, CornerRadius::same(10), crate::PROTON_PURPLE_SOFT());
                ui.painter().text(
                    avatar.center(),
                    egui::Align2::CENTER_CENTER,
                    &initials,
                    FontId::new(16.0, FontFamily::Proportional),
                    TEXT_PRIMARY(),
                );
            };
            let mut sign_action = |ui: &mut egui::Ui| {
                if logged_in {
                    if action_button(ui, ButtonKind::Secondary, Some(icons::SIGN_OUT), "Sign out", 32.0).clicked() {
                        account_command = Some(WorkerCommand::Logout);
                    }
                } else if action_button(ui, ButtonKind::Primary, Some(icons::SIGN_IN), "Sign in", 32.0).clicked() {
                    account_command = Some(WorkerCommand::StartLogin);
                }
            };
            if ui.available_width() < STACKED_BELOW {
                // Narrow card (small window, high zoom): avatar and name, then plan, then Sign out/in under them (#315)
                ui.horizontal(|ui| {
                    paint_avatar(ui);
                    ui.add_space(6.0);
                    ui.vertical(|ui| {
                        elided(ui, RichText::new(&name).size(NAME_SIZE).strong().color(TEXT_PRIMARY()), &name);
                        if !email.is_empty() {
                            elided(ui, RichText::new(&email).size(12.5).color(TEXT_MUTED()), &email);
                        }
                    });
                });
                if let Some(plan) = plan {
                    ui.add_space(8.0);
                    plan_pill(ui, plan);
                }
                ui.add_space(10.0);
                sign_action(ui);
            } else {
                ui.horizontal(|ui| {
                    paint_avatar(ui);
                    ui.add_space(6.0);
                    let btn_w = if self.status.logged_in {
                        action_button_width(ui, Some(icons::SIGN_OUT), "Sign out")
                    } else {
                        action_button_width(ui, Some(icons::SIGN_IN), "Sign in")
                    };
                    let gap = 8.0 + ui.spacing().item_spacing.x;
                    let text_w = (ui.available_width() - btn_w - gap).max(0.0);
                    ui.allocate_ui_with_layout(Vec2::new(text_w, 44.0), Layout::top_down(Align::Min), |ui| {
                        ui.set_min_width(text_w);
                        // The plan beside the name when the whole name fits beside it, else under the email
                        let name_w = text_width(ui.painter(), &name, &FontId::proportional(NAME_SIZE));
                        let beside = plan.is_some_and(|plan| {
                            name_w + 4.0 + 2.0 * ui.spacing().item_spacing.x + plan_pill_width(ui, plan) <= text_w
                        });
                        ui.horizontal(|ui| {
                            elided(ui, RichText::new(&name).size(NAME_SIZE).strong().color(TEXT_PRIMARY()), &name);
                            if let Some(plan) = plan.filter(|_| beside) {
                                ui.add_space(4.0);
                                plan_pill(ui, plan);
                            }
                        });
                        if !email.is_empty() {
                            elided(ui, RichText::new(&email).size(12.5).color(TEXT_MUTED()), &email);
                        }
                        if let Some(plan) = plan.filter(|_| !beside) {
                            ui.add_space(2.0);
                            plan_pill(ui, plan);
                        }
                    });
                    ui.add_space(8.0);
                    sign_action(ui);
                });
            }
            if let Some(cmd) = account_command {
                self.send_account_command(cmd);
            }
            if let Some(s) = storage(account.as_ref()) {
                ui.add_space(12.0);
                ui.separator();
                ui.add_space(6.0);
                setting_row(ui, "Proton storage", None, None, |ui| {
                    ui.add(egui::Label::new(RichText::new(&s.text).size(LABEL_SIZE).color(TEXT_PRIMARY())).truncate())
                });
            }
            // Proton Drive on the web, and its trash, where a delete through the drive puts what was deleted (#201):
            // short labels with their icons, what they open on hover. Signed in only: signed out, Sign in is the one
            // thing to do
            if self.status.logged_in {
                ui.add_space(10.0);
                ui.horizontal_wrapped(|ui| {
                    // Short labels, named in full for screen readers
                    let web = action_button_named(ui, ButtonKind::Secondary, Some(icons::WEB), "Web", OPEN_WEB, 32.0);
                    if web.on_hover_text(OPEN_WEB).clicked() {
                        open_in_browser(PROTON_DRIVE_WEB_URL);
                    }
                    ui.add_space(4.0);
                    let trash = action_button_named(ui, ButtonKind::Secondary, Some(icons::TRASH), TRASH_BUTTON, OPEN_TRASH, 32.0);
                    if trash.on_hover_text(trash_hover(&self.status.sync_dir)).clicked() {
                        open_in_browser(PROTON_DRIVE_TRASH_URL);
                    }
                });
            }
            // How signing in or out went (the sign-in page opening, or why it failed)
            if let Some(error) = &self.account_error {
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(DANGER_TEXT())).wrap());
            } else if let Some(url) = &self.login_url {
                let text = if url.is_empty() {
                    "Opening the Proton sign-in page in your browser…".to_string()
                } else {
                    format!("Sign-in URL opened in browser: {url}")
                };
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(text).size(12.0).color(PROTON_PURPLE_TEXT())).wrap());
            }
        });
    }

    /// Hidden from this computer: each hidden item with Unhide (POST /availability, as the browser sent it).
    pub(crate) fn render_hidden_card(&mut self, ui: &mut egui::Ui) {
        let mut unhide: Option<String> = None;
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_heading(
                ui,
                "Hidden from this computer",
                None,
                Some("Hidden items stay in Proton Drive, but aren't kept on this computer or shown in Files. To hide something, right-click it in Files."),
            );
            ui.add_space(10.0);
            match &self.hidden {
                None => {
                    ui.label(RichText::new("Loading…").size(13.0).color(TEXT_MUTED()));
                }
                // An older daemon, without the list: not an error, a restart brings it
                Some(Err(e)) if e == HIDDEN_NEEDS_RESTART => {
                    ui.add(egui::Label::new(RichText::new(e).size(12.5).color(TEXT_MUTED())).wrap());
                }
                Some(Err(e)) => {
                    ui.add(
                        egui::Label::new(RichText::new(format!("Couldn't load the list: {e}")).size(12.5).color(DANGER_TEXT()))
                            .wrap(),
                    );
                }
                Some(Ok(items)) if items.is_empty() => {
                    ui.label(RichText::new("Nothing is hidden.").size(13.0).color(TEXT_MUTED()));
                }
                Some(Ok(items)) => {
                    // One action at a time, and only with the daemon there to do it
                    let can = self.daemon_online && self.working.is_empty();
                    for item in items {
                        // Each item a row: its path, "Hiding…" under it while it goes, and Unhide
                        let hiding = (item.state == "hiding").then_some("Hiding…");
                        setting_row(ui, &item.path, hiding, None, |ui| {
                            let label = if self.working.contains(&item.path) { "Unhiding…" } else { "Unhide" };
                            let name = format!("{label} {}", item.path);
                            let button = ui
                                .add_enabled_ui(can, |ui| {
                                    action_button_named(ui, ButtonKind::Secondary, None, label, &name, 30.0)
                                })
                                .inner;
                            if button.clicked() {
                                unhide = Some(item.path.clone());
                            }
                            button
                        });
                        ui.add_space(ROW_GAP);
                    }
                }
            }
            // How the last Unhide went: the items it had to keep as information, a refusal or failure as an error
            if let Some(notice) = &self.unhide_notice {
                ui.add_space(6.0);
                let color = if notice.error { DANGER_TEXT() } else { TEXT_MUTED() };
                ui.add(egui::Label::new(RichText::new(&notice.text).size(12.5).color(color)).wrap());
            }
        });
        if let Some(path) = unhide {
            self.unhide_notice = None;
            self.unhiding = Some(path.clone());
            self.send_availability(path, "unhide", None);
        }
    }

    /// Appearance: the theme, taken and saved as soon as it is picked, like the Sync card's settings.
    pub(crate) fn render_appearance_card(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_heading(ui, "Appearance", None, None);
            ui.add_space(10.0);
            setting_row(ui, "Theme", None, None, |ui| {
                let mode = self.window_geometry.theme_mode.as_str();
                // Anything else follows the system, as the app does
                let shown = THEME_CHOICES.iter().find(|(value, _)| *value == mode).map_or(THEME_CHOICES[0].1, |(_, text)| text);
                picker(ui, "appearance_theme_combo", shown, ui.available_width().min(WIDE_CONTROL), |ui| {
                    for (value, text) in THEME_CHOICES {
                        if ui.selectable_value(&mut self.window_geometry.theme_mode, value.to_string(), text).changed() {
                            save_window_geometry(&self.window_geometry);
                        }
                    }
                })
                .response
            });
        });
    }
}

/// The account's name in the Account card
const NAME_SIZE: f32 = 14.5;
/// The plan pill's words, and their room on each side
const PLAN_SIZE: f32 = 11.0;
const PLAN_PADDING: i8 = 7;

/// The plan, in a small pill beside the name.
pub(crate) fn plan_pill(ui: &mut egui::Ui, plan: &str) {
    Frame::NONE
        .fill(crate::PROTON_PURPLE_SOFT())
        .corner_radius(CornerRadius::same(5))
        .inner_margin(Margin::symmetric(PLAN_PADDING, 2))
        .show(ui, |ui| {
            ui.add(egui::Label::new(RichText::new(plan).size(PLAN_SIZE).color(PROTON_PURPLE_TEXT())).extend());
        });
}

/// How wide `plan_pill` is for `plan`.
fn plan_pill_width(ui: &egui::Ui, plan: &str) -> f32 {
    text_width(ui.painter(), plan, &FontId::proportional(PLAN_SIZE)) + 2.0 * PLAN_PADDING as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_is_named_by_the_accounts_quota() {
        const GB: u64 = 1024 * 1024 * 1024;
        assert_eq!(plan_name(5 * GB), "Proton Free");
        assert_eq!(plan_name(15 * GB - 1), "Proton Free");
        assert_eq!(plan_name(15 * GB), "Proton Drive Plus");
        assert_eq!(plan_name(200 * GB), "Proton Drive Plus");
        assert_eq!(plan_name(400 * GB), "Proton Unlimited");
        assert_eq!(plan_name(510 * GB), "Proton Unlimited");
    }
}
