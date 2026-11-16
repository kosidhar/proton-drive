//! Settings' own cards: the account (who is signed in, their plan and storage, Sign out), what is hidden from this
//! computer, with Unhide, and the theme; and the row every setting is laid out in, as Proton lays out its settings.

use eframe::egui::{self, Align, CornerRadius, FontFamily, FontId, Frame, Layout, Margin, RichText, Sense, Stroke, Vec2};

use crate::home::{
    card_title, elided, open_in_browser, secondary_button, storage, trash_hover, OPEN_TRASH, OPEN_WEB, PROTON_DRIVE_TRASH_URL,
    PROTON_DRIVE_WEB_URL, TRASH_BUTTON,
};
use crate::{
    action_button, action_button_named, card_frame, focus_ring, icons, save_window_geometry, text_width, toggle_switch,
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
/// when there is more to say (`info`, on hover or keyboard focus); and its `control` on the right, vertically centred.
/// The control has the room the label leaves (but at least 40% of the row) and sizes itself to `ui.available_width()`,
/// as one widget or one group; the label, then the hint, are cut to the room it leaves, whole on hover. In a row
/// narrower than `STACKED_BELOW` (a small window, a large zoom), the control goes under its label instead, as on
/// Proton's settings on a phone.
///
/// `control` returns its main widget, which screen readers then hear named by the label and described by `info`. The
/// label is no stop for the Tab key. Returns the label's response.
pub(crate) fn setting_row(
    ui: &mut egui::Ui,
    label: &str,
    hint: Option<&str>,
    info: Option<&str>,
    control: impl FnOnce(&mut egui::Ui) -> egui::Response,
) -> egui::Response {
    row(ui, label, RowLabel::Words, hint, info, control)
}

/// `setting_row` for a name typed as code, an app's process name, which its label shows in monospace.
pub(crate) fn code_row(ui: &mut egui::Ui, name: &str, control: impl FnOnce(&mut egui::Ui) -> egui::Response) -> egui::Response {
    row(ui, name, RowLabel::Code, None, None, control)
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

/// `setting_row`, with its label as `kind` says.
fn row(
    ui: &mut egui::Ui,
    label: &str,
    kind: RowLabel,
    hint: Option<&str>,
    info: Option<&str>,
    control: impl FnOnce(&mut egui::Ui) -> egui::Response,
) -> egui::Response {
    let width = ui.available_width();
    if width < STACKED_BELOW {
        return ui
            .vertical(|ui| {
                let label = label_column(ui, label, kind, hint, info);
                ui.add_space(STACKED_GAP);
                let control = control(ui);
                name_control(ui, &control, &label, info);
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
    // Between the control and the label: the gap, and the item spacing egui puts after the control
    let gap = CONTROL_GAP + ui.spacing().item_spacing.x;
    let control_room = (width - need - gap).max(width * CONTROL_SHARE);
    ui.allocate_ui_with_layout(Vec2::new(width, row_h), Layout::right_to_left(Align::Center), |ui| {
        ui.set_min_size(Vec2::new(width, row_h));
        let control = ui.scope(|ui| {
            ui.set_max_width(control_room);
            control(ui)
        });
        let control_rect = control.response.rect;
        ui.add_space(CONTROL_GAP);
        // The label level with the control's middle (a picker sits a little off the row's), or, beside a control
        // taller than the row (a text box), with its top line
        let top = if control_rect.height() > row_h + 0.5 {
            control_rect.top() + (row_h - left_h) / 2.0
        } else {
            control_rect.center().y - left_h / 2.0
        };
        let column = egui::Rect::from_min_max(
            egui::pos2(ui.max_rect().left(), top),
            egui::pos2(ui.available_rect_before_wrap().right().max(ui.max_rect().left()), top + left_h),
        );
        let label = ui
            .scope_builder(egui::UiBuilder::new().max_rect(column).layout(Layout::top_down(Align::Min)), |ui| {
                label_column(ui, label, kind, hint, info)
            })
            .inner;
        name_control(ui, &control.inner, &label, info);
        label
    })
    .inner
}

/// Screen readers hear the control named by its row's label (it is laid out first, from the row's right end, so it
/// comes first in their order too), and described by what the row's ⓘ says.
fn name_control(ui: &egui::Ui, control: &egui::Response, label: &egui::Response, info: Option<&str>) {
    let _ = control.clone().labelled_by(label.id);
    ui.ctx().accesskit_node_builder(control.id, |node| {
        // A name of its own, even an empty one (egui's picker has one), is read instead of its label's
        if node.label().is_some_and(str::is_empty) {
            node.clear_label();
        }
        if let Some(info) = info {
            node.set_description(info);
        }
    });
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
fn label_column(ui: &mut egui::Ui, label: &str, kind: RowLabel, hint: Option<&str>, info: Option<&str>) -> egui::Response {
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = HINT_GAP;
        let label = ui
            .horizontal(|ui| {
                let room = (ui.available_width() - info_room(ui, info)).max(0.0);
                let text = RichText::new(label).font(kind.font()).color(TEXT_PRIMARY());
                let label = ui
                    .scope(|ui| {
                        ui.set_max_width(room);
                        let label = egui::Label::new(text).truncate();
                        // A switch's label takes clicks, but not the keyboard's focus
                        ui.add(if kind == RowLabel::Switch { label.sense(Sense::CLICK) } else { label })
                    })
                    .inner;
                if let Some(info) = info {
                    info_glyph(ui, info);
                }
                label
            })
            .inner;
        if let Some(hint) = hint {
            let text = RichText::new(hint).font(FontId::proportional(HINT_SIZE)).color(TEXT_MUTED());
            ui.add(egui::Label::new(text).truncate());
        }
        label
    })
    .inner
}

/// A setting that is on or off: `setting_row` with a switch, which a click on the label flips too. Whether either was
/// clicked: the caller flips the setting.
pub(crate) fn switch_row(ui: &mut egui::Ui, label: &str, hint: Option<&str>, info: Option<&str>, on: bool) -> bool {
    let mut switch = None;
    let label_response = row(ui, label, RowLabel::Switch, hint, info, |ui| {
        let response = toggle_switch(ui, on);
        switch = Some(response.clone());
        response
    });
    if label_response.hovered() && ui.is_enabled() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let switch = switch.expect("setting_row lays out its control");
    // Named by its label for screen readers, and on or off
    let enabled = ui.is_enabled();
    switch.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, enabled, on, label));
    switch.clicked() || label_response.clicked()
}

/// A Settings card's heading, in bold, with the ⓘ after it when there is more to say (`info`, on hover), and a one-line
/// `hint` under it.
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
        if text_width(ui.painter(), selected, &font) > room {
            shown.response = shown.response.on_hover_text(selected);
        }
        shown
    })
    .inner
}

/// An ⓘ that shows `info` on hover, greyed out or not, and on the keyboard's focus (it is a stop for the Tab key, with a
/// focus ring), and hands it to screen readers.
fn info_glyph(ui: &mut egui::Ui, info: &str) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(INFO_SIZE), Sense::FOCUSABLE);
    let enabled = ui.is_enabled();
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, info));
    ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, icons::INFO, icons::font(INFO_SIZE - 1.0), TEXT_MUTED());
    focus_ring(ui, &response, INFO_SIZE / 2.0);
    // Once: under the pointer, the hover shows it
    if response.has_focus() && !response.hovered() {
        response.show_tooltip_text(info);
    }
    response.on_hover_text(info).on_disabled_hover_text(info)
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
            ui.horizontal(|ui| {
                let (avatar, _) = ui.allocate_exact_size(Vec2::new(44.0, 44.0), Sense::hover());
                ui.painter().rect_filled(avatar, CornerRadius::same(10), crate::PROTON_PURPLE_SOFT());
                ui.painter().text(
                    avatar.center(),
                    egui::Align2::CENTER_CENTER,
                    &initials,
                    FontId::new(16.0, FontFamily::Proportional),
                    TEXT_PRIMARY(),
                );
                ui.add_space(6.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if self.status.logged_in {
                        if action_button(ui, ButtonKind::Secondary, Some(icons::SIGN_OUT), "Sign out", 32.0).clicked() {
                            self.send_account_command(WorkerCommand::Logout);
                        }
                    } else if action_button(ui, ButtonKind::Primary, Some(icons::SIGN_IN), "Sign in", 32.0).clicked() {
                        self.send_account_command(WorkerCommand::StartLogin);
                    }
                    ui.add_space(8.0);
                    ui.with_layout(Layout::top_down(Align::Min), |ui| {
                        ui.horizontal(|ui| {
                            elided(ui, RichText::new(&name).size(14.5).strong().color(TEXT_PRIMARY()), &name);
                            if let Some(a) = account.as_ref().filter(|a| a.max_space > 0) {
                                ui.add_space(4.0);
                                plan_pill(ui, plan_name(a.max_space));
                            }
                        });
                        if !email.is_empty() {
                            elided(ui, RichText::new(&email).size(12.5).color(TEXT_MUTED()), &email);
                        }
                    });
                });
            });
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
                ui.horizontal(|ui| {
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
                            let button = ui.add_enabled_ui(can, |ui| secondary_button(ui, label, 30.0)).inner;
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
            self.send_availability(path, "unhide");
        }
    }

    /// Appearance: the theme, taken and saved as soon as it is picked, as before, unlike the Synchronization card's
    /// settings, which wait for Save Preferences.
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

/// The plan, in a small pill beside the name.
pub(crate) fn plan_pill(ui: &mut egui::Ui, plan: &str) {
    Frame::NONE
        .fill(crate::PROTON_PURPLE_SOFT())
        .corner_radius(CornerRadius::same(5))
        .inner_margin(Margin::symmetric(7, 2))
        .show(ui, |ui| {
            ui.label(RichText::new(plan).size(11.0).color(PROTON_PURPLE_TEXT()));
        });
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
