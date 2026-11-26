//! The Shared with me page's view (#487): the toolbar, the invitations, the list of what others shared, and the
//! page's states (loading, empty, offline). The model, wording and requests are `shared_with_me.rs`; the buttons only
//! say what was pressed (`PageAction`), and what that does is `act_on_shared_with_me`'s.

use eframe::egui::{self, Align, Color32, FontId, Frame, Layout, Margin, RichText, ScrollArea, Sense, Stroke, Vec2};

use crate::shared_view::{
    allocate_picture_circle, announce_politely, paint_loading, place_above_middle, refresh_pressed, share_picture_colors,
    SHARED_ACTION_GAP, SHARED_COLUMN_GAP, SHARED_ROW_END, SHARED_ROW_HEIGHT,
};
use crate::shared_with_me::{self as model, Invitation, Item, Kind, Listing};
use crate::{
    action_button_named, action_button_width, bold, home, icon_button_colored_named, icons, palette, scroll_to_focused,
    share, text_width, truncate_end_to_width, ButtonKind, PendingConfirm, ProtonDriveNativeApp, WorkerCommand, WorkerEvent, BG_CARD, BORDER_SUBTLE, BUTTON_ICON_SIZE,
    DANGER_TEXT, FOLDER_ICON, ICON_BUTTON_SIZE, PROTON_PURPLE_TEXT, SCROLL_GUTTER, TEXT_MUTED, TEXT_PRIMARY,
};

/// Why a sharer is marked ⚠.
pub const UNVERIFIED_SHARER: &str = "Proton couldn't verify who shared this";
/// The ⋯ menu's id
const MENU_ID: &str = "shared_with_me_menu";
/// What a missing date or sharer reads as.
const NONE: &str = "—";

const INVITATION_HEIGHT: f32 = 58.0;
/// The line under a row that has a note or a failure to say
const ROW_NOTE_HEIGHT: f32 = 20.0;

/// What was pressed on the page, by the uid of its invitation or item.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PageAction {
    Accept(String),
    Decline(String),
    Open(String),
    /// ⋯ of an item, with the button the menu hangs from
    More(String, egui::Rect),
    /// Show in Files, under a row that was downloaded
    ShowInFiles(String),
}

/// A date as the page shows it: "3 Nov 2026", by the local calendar.
pub fn date_text(ms: i64) -> String {
    format_date(ms, home::local_offset_secs(ms))
}

fn format_date(ms: i64, offset: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (year, month, day) = share::civil_from_days(home::local_day_and_secs(ms, offset).0);
    format!("{day} {} {year}", MONTHS[(month - 1).clamp(0, 11) as usize])
}

/// The words under an invitation's name: who invited, as what, and when. A sender that isn't verified isn't named: the
/// address is a claim, said in the question before accepting.
pub fn invitation_line(inv: &Invitation, now_ms: i64) -> String {
    let when = home::ago(now_ms - inv.invited_at);
    match (inv.from_verified, inv.from.as_deref().filter(|f| !f.is_empty())) {
        (true, Some(from)) => format!("{from} invited you as {} · {when}", inv.role.label()),
        _ => format!("Sender not verified · {} · {when}", inv.role.label()),
    }
}

/// The glyph and colour of a kind of item.
fn kind_icon(kind: Kind) -> (&'static str, Color32) {
    match kind {
        Kind::Folder => (icons::FOLDER, FOLDER_ICON()),
        Kind::File => (icons::FILE, TEXT_MUTED()),
        Kind::Doc => (icons::DOC, TEXT_MUTED()),
        Kind::Sheet => (icons::SHEET, TEXT_MUTED()),
    }
}

/// Whether ⋯ would hold anything: Download (a file) or Leave (an item shared with the account directly). An item
/// that couldn't be read offers only Open.
fn has_more(item: &Item) -> bool {
    item.unreadable.is_none() && (item.kind == Kind::File || item.can_leave)
}

/// The Shared by column's words: the address, or that it is unknown, and whether to mark it ⚠.
fn sharer_text(item: &Item) -> (String, bool) {
    let by = item.shared_by.as_deref().filter(|b| !b.is_empty());
    match (by, item.shared_by_verified) {
        (Some(by), true) => (by.to_string(), false),
        (Some(by), false) => (by.to_string(), true),
        (None, _) => (if item.unreadable.is_some() { NONE } else { "unverified" }.to_string(), item.unreadable.is_none()),
    }
}

impl ProtonDriveNativeApp {
    /// Shared with me: invitations waiting for an answer, then what others shared with the account, as Shared's list
    /// is laid out, with Shared's loading picture, centred Refresh and offline state.
    pub(crate) fn render_shared_with_me(&mut self, ui: &mut egui::Ui) {
        // The one more read after an accept whose item wasn't listed yet
        if let Some(at) = self.shared_with_me.reload_at {
            let now = std::time::Instant::now();
            if now >= at {
                self.shared_with_me.reload_at = None;
                self.load_shared_with_me();
            } else {
                ui.ctx().request_repaint_after(at - now);
            }
        }
        let gutter = SCROLL_GUTTER;
        let toolbar = Margin { right: gutter.right + SHARED_ROW_END as i8, ..gutter };
        Frame::NONE.inner_margin(toolbar).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(34.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // Only a list has a Refresh here: the empty page and the error have their own, centred, and a
                    // first read has the loading picture
                    if self.shared_with_me.has_rows() && self.shared_with_me.error.is_none() {
                        if self.shared_with_me.loading {
                            let words = ui.label(RichText::new(crate::shared::REFRESHING).size(13.0).color(TEXT_MUTED()));
                            announce_politely(ui, &words);
                            home::turning_decoration(ui, icons::SYNC, 16.0, PROTON_PURPLE_TEXT(), home::turning_angle(ui));
                        } else {
                            let refresh = crate::action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0);
                            if self.shared_with_me_refresh_pressed(ui, &refresh) {
                                self.load_shared_with_me();
                            }
                        }
                    }
                });
            });
        });
        ui.add_space(8.0);

        let viewport = ui.available_height();
        let mut acted = None;
        ScrollArea::vertical().id_salt("shared_with_me_scroll").auto_shrink([false, false]).show(ui, |ui| {
            Frame::NONE.inner_margin(gutter).show(ui, |ui| {
                if let Some(error) = self.shared_with_me.error.clone() {
                    let retry = place_above_middle(ui, "shared_with_me_error_h", viewport, |ui| {
                        ui.scope(|ui| {
                            ui.set_width(ui.available_width().min(420.0));
                            ui.add(egui::Label::new(RichText::new(error).size(13.0).color(DANGER_TEXT())).wrap().halign(Align::Center));
                        });
                        ui.add_space(12.0);
                        let retry = crate::action_button(ui, ButtonKind::Primary, Some(icons::REFRESH), "Retry", 34.0);
                        self.shared_with_me_refresh_pressed(ui, &retry)
                    });
                    if retry {
                        self.load_shared_with_me();
                    }
                    return;
                }
                let loading = self.shared_with_me.loading;
                if loading && !self.shared_with_me.has_rows() {
                    place_above_middle(ui, "shared_with_me_loading_h", viewport, |ui| paint_loading(ui, model::LOADING));
                    return;
                }
                let Some(listing) = self.shared_with_me.listing.clone() else { return };
                if listing.is_empty() && self.shared_with_me.accepted.is_empty() {
                    if self.render_shared_with_me_empty(ui, viewport) {
                        self.load_shared_with_me();
                    }
                    return;
                }
                // The rows of the list being replaced stay, greyed out and without clicks
                acted = ui.add_enabled_ui(!loading, |ui| self.shared_with_me_rows(ui, &listing)).inner;
                ui.add_space(12.0);
                Self::shared_with_me_note(ui, self.screenshot_target.is_some());
            });
        });
        // The menu first: the click that opens it must not count as one outside it
        self.shared_with_me_menu(ui.ctx());
        if let Some(action) = acted {
            if matches!(action, PageAction::More(..)) {
                ui.ctx().request_repaint();
            }
            self.act_on_shared_with_me(action);
        }
    }

    fn shared_with_me_refresh_pressed(&mut self, ui: &egui::Ui, button: &egui::Response) -> bool {
        refresh_pressed(&mut self.shared_with_me.refocus, self.shared_with_me.loading, ui, button)
    }

    /// The invitations (if any), then the list (if any).
    fn shared_with_me_rows(&self, ui: &mut egui::Ui, listing: &Listing) -> Option<PageAction> {
        let now = home::now_ms();
        let mut acted = None;
        if !listing.invitations.is_empty() {
            ui.label(RichText::new(model::INVITATIONS).font(bold(15.0)).color(TEXT_PRIMARY()));
            ui.add_space(8.0);
            acted = self.invitation_cards(ui, &listing.invitations, now);
            ui.add_space(20.0);
        }
        if !self.shared_with_me.accepted.is_empty() {
            self.accepted_cards(ui);
            ui.add_space(20.0);
        }
        if !listing.items.is_empty() {
            acted = self.item_list(ui, &listing.items).or(acted);
        }
        acted
    }

    /// The invitations accepted whose items the list doesn't show yet, as one card, a row each: the kind's icon and the
    /// name over `ACCEPTED`, said politely.
    fn accepted_cards(&self, ui: &mut egui::Ui) {
        Frame::NONE
            .fill(BG_CARD())
            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
            .corner_radius(egui::CornerRadius::same(10))
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                let width = ui.available_width();
                for (i, accepted) in self.shared_with_me.accepted.iter().enumerate() {
                    let (row, _) = ui.allocate_exact_size(Vec2::new(width, INVITATION_HEIGHT), Sense::hover());
                    if i > 0 {
                        ui.painter().hline(row.x_range(), row.top() + 0.5, Stroke::new(1.0_f32, BORDER_SUBTLE()));
                    }
                    let (icon, color) = kind_icon(accepted.kind);
                    let painter = ui.painter().with_clip_rect(row);
                    let x = row.left() + 14.0;
                    painter.text(egui::pos2(x, row.center().y), egui::Align2::LEFT_CENTER, icon, icons::font(20.0), color);
                    let text_x = x + 20.0 + 12.0;
                    let room = (row.right() - 12.0 - text_x).max(0.0);
                    let name = model::display_name(&accepted.name);
                    let name_font = bold(14.0);
                    let shown = truncate_end_to_width(&painter, &name, &name_font, room);
                    painter.text(egui::pos2(text_x, row.center().y - 10.0), egui::Align2::LEFT_CENTER, shown, name_font, TEXT_PRIMARY());
                    let font = FontId::proportional(12.5);
                    painter.text(egui::pos2(text_x, row.center().y + 10.0), egui::Align2::LEFT_CENTER, model::ACCEPTED, font, TEXT_MUTED());
                    let enabled = ui.is_enabled();
                    // The name, then the note on its own so that it is said politely as it appears
                    let (upper, lower) = (egui::Rect::from_min_max(row.min, egui::pos2(row.right(), row.center().y)), egui::Rect::from_min_max(egui::pos2(row.left(), row.center().y), row.max));
                    let resp = ui.interact(upper, ui.id().with(("accepted_name", i)), Sense::hover());
                    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, &name));
                    let resp = ui.interact(lower, ui.id().with(("accepted_words", i)), Sense::hover());
                    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, model::ACCEPTED));
                    ui.ctx().accesskit_node_builder(resp.id, |node| node.set_live(egui::accesskit::Live::Polite));
                }
            });
    }

    /// The invitations as one card, a row each: the kind's icon, the name and who invited, then Decline and Accept.
    fn invitation_cards(&self, ui: &mut egui::Ui, invitations: &[Invitation], now: i64) -> Option<PageAction> {
        let mut acted = None;
        Frame::NONE
            .fill(BG_CARD())
            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
            .corner_radius(egui::CornerRadius::same(10))
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                let width = ui.available_width();
                for (i, inv) in invitations.iter().enumerate() {
                    let has_note = self.row_note_text(&inv.invitation_uid).is_some();
                    let (full, _) = ui.allocate_exact_size(Vec2::new(width, INVITATION_HEIGHT + if has_note { ROW_NOTE_HEIGHT } else { 0.0 }), Sense::hover());
                    if i > 0 {
                        ui.painter().hline(full.x_range(), full.top() + 0.5, Stroke::new(1.0_f32, BORDER_SUBTLE()));
                    }
                    let row = egui::Rect::from_min_size(full.min, Vec2::new(width, INVITATION_HEIGHT));
                    let name = model::display_name(&inv.name);
                    let working = self.shared_with_me.working.contains(&inv.invitation_uid);
                    // The buttons, on the right, in a room of their own so that the words give way to them
                    let accept_w = action_button_width(ui, None, "Accept");
                    let decline_w = action_button_width(ui, None, "Decline");
                    let buttons_w = decline_w + SHARED_ACTION_GAP * 2.0 + accept_w;
                    let right = row.right() - 12.0;
                    let buttons = egui::Rect::from_min_max(egui::pos2(right - buttons_w, row.top()), egui::pos2(right, row.bottom()));
                    let mut buttons_ui = ui.new_child(egui::UiBuilder::new().id_salt(("invitation_buttons", i)).max_rect(buttons).layout(Layout::left_to_right(Align::Center)));
                    buttons_ui.spacing_mut().item_spacing.x = SHARED_ACTION_GAP * 2.0;
                    buttons_ui.add_enabled_ui(!working, |ui| {
                        if action_button_named(ui, ButtonKind::Secondary, None, "Decline", &format!("Decline {name}"), 30.0).clicked() {
                            acted = Some(PageAction::Decline(inv.invitation_uid.clone()));
                        }
                        if action_button_named(ui, ButtonKind::Primary, None, "Accept", &format!("Accept {name}"), 30.0).clicked() {
                            acted = Some(PageAction::Accept(inv.invitation_uid.clone()));
                        }
                    });

                    // Words: the icon, the name over who invited
                    let (icon, color) = kind_icon(inv.kind);
                    let painter = ui.painter().with_clip_rect(egui::Rect::from_min_max(row.min, egui::pos2(buttons.left() - SHARED_COLUMN_GAP, row.bottom())));
                    let x = row.left() + 14.0;
                    painter.text(egui::pos2(x, row.center().y), egui::Align2::LEFT_CENTER, icon, icons::font(20.0), color);
                    let text_x = x + 20.0 + 12.0;
                    let room = (buttons.left() - SHARED_COLUMN_GAP - text_x).max(0.0);
                    let name_font = bold(14.0);
                    let shown = truncate_end_to_width(&painter, &name, &name_font, room);
                    painter.text(egui::pos2(text_x, row.center().y - 10.0), egui::Align2::LEFT_CENTER, shown, name_font, TEXT_PRIMARY());
                    let line = invitation_line(inv, now);
                    let font = FontId::proportional(12.5);
                    let mark = !inv.from_verified;
                    let mark_room = if mark { text_width(&painter, icons::WARNING, &icons::font(14.0)) + 6.0 } else { 0.0 };
                    if mark {
                        painter.text(egui::pos2(text_x, row.center().y + 10.0), egui::Align2::LEFT_CENTER, icons::WARNING, icons::font(14.0), TEXT_MUTED());
                    }
                    let shown = truncate_end_to_width(&painter, &line, &font, (room - mark_room).max(0.0));
                    painter.text(egui::pos2(text_x + mark_room, row.center().y + 10.0), egui::Align2::LEFT_CENTER, shown, font, TEXT_MUTED());
                    // The whole of it for screen readers (and on hover), named by the row's item
                    let words = egui::Rect::from_min_max(egui::pos2(text_x, row.top()), egui::pos2(text_x + room, row.bottom()));
                    let enabled = ui.is_enabled();
                    let said = format!("{name}, {line}");
                    let resp = ui.interact(words, ui.id().with(("invitation_words", i)), Sense::hover());
                    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, &said));
                    resp.on_hover_text(said.clone());
                    self.row_note(ui, &inv.invitation_uid, egui::Rect::from_min_max(egui::pos2(full.left(), row.bottom()), full.max), text_x);
                }
            });
        acted
    }

    /// The list: column headers, then a row per item, with lines between them and no card. Each row has Open, and ⋯
    /// where it would hold something; the buttons keep their places in every row.
    fn item_list(&self, ui: &mut egui::Ui, items: &[Item]) -> Option<PageAction> {
        const START: f32 = 8.0;
        const ICON_ROOM: f32 = BUTTON_ICON_SIZE + 8.0;
        let name_font = FontId::proportional(14.0);
        let text_font = FontId::proportional(13.0);
        let header_font = FontId::proportional(12.0);
        let painter = ui.painter().clone();

        let dates: Vec<String> = items.iter().map(|i| i.shared_at.map_or_else(|| NONE.to_string(), date_text)).collect();
        let open_w = action_button_width(ui, None, "Open");
        let actions_room = open_w + SHARED_ACTION_GAP + ICON_BUTTON_SIZE;
        let width = ui.available_width();
        let room = width - START - SHARED_ROW_END - actions_room - 3.0 * SHARED_COLUMN_GAP;
        let name_want = items.iter().map(|i| ICON_ROOM + text_width(&painter, &model::display_name(&i.name), &name_font)).fold(0.0, f32::max);
        // The Shared and Access columns take what their longest words (and headers) need
        let date_w = dates.iter().map(|d| text_width(&painter, d, &text_font)).fold(text_width(&painter, "Shared", &header_font), f32::max);
        let access_w = ["Viewer", "Editor", "Admin"].iter().map(|r| text_width(&painter, r, &text_font)).fold(text_width(&painter, "Access", &header_font), f32::max);
        let both_w = date_w + SHARED_COLUMN_GAP + access_w;
        let (name_w, by_w, both_room) = crate::shared_view::shared_columns(room, name_want, both_w, both_w);
        // Squeezed (a narrow window, a big zoom): the two share what there is, and cut their words
        let squeeze = ((both_room - SHARED_COLUMN_GAP).max(0.0) / (date_w + access_w)).min(1.0);
        let (date_cell_w, access_cell_w) = (date_w * squeeze, access_w * squeeze);

        ui.spacing_mut().item_spacing.y = 0.0;
        let line = |painter: &egui::Painter, rect: egui::Rect| {
            painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0_f32, BORDER_SUBTLE()));
        };
        let (header, _) = ui.allocate_exact_size(Vec2::new(width, 32.0), Sense::hover());
        let name_x = header.left() + START;
        let by_x = name_x + name_w + SHARED_COLUMN_GAP;
        let date_x = by_x + by_w + SHARED_COLUMN_GAP;
        let access_x = date_x + date_cell_w + SHARED_COLUMN_GAP;
        let enabled = ui.is_enabled();
        let header_col = |ui: &mut egui::Ui, title: &'static str, x: f32, w: f32| -> egui::Id {
            let rect = egui::Rect::from_min_max(egui::pos2(x, header.top()), egui::pos2(x + w.max(0.0), header.bottom()));
            let resp = ui.interact(rect, ui.id().with(("shared_with_me_header", title)), Sense::hover());
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Other, enabled, title));
            ui.ctx().accesskit_node_builder(resp.id, |node| node.set_role(egui::accesskit::Role::ColumnHeader));
            painter.text(egui::pos2(x, header.center().y), egui::Align2::LEFT_CENTER, title, header_font.clone(), TEXT_MUTED());
            resp.id
        };
        let name_header = header_col(ui, "Name", name_x, name_w);
        let by_header = header_col(ui, "Shared by", by_x, by_w);
        let date_header = header_col(ui, "Shared", date_x, date_cell_w);
        let access_header = header_col(ui, "Access", access_x, access_cell_w);
        line(&painter, header);

        let mut acted = None;
        for (i, item) in items.iter().enumerate() {
            let note = self.row_note_text(&item.uid);
            let height = SHARED_ROW_HEIGHT + if note.is_some() { ROW_NOTE_HEIGHT } else { 0.0 };
            let (full, _) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
            line(&painter, full);
            let row = egui::Rect::from_min_size(full.min, Vec2::new(width, SHARED_ROW_HEIGHT));
            let y = row.center().y;
            let name = model::display_name(&item.name);
            let cell = |x: f32, w: f32| egui::Rect::from_min_max(egui::pos2(x, row.top()), egui::pos2(x + w.max(0.0), row.bottom()));
            let in_cell = |rect: egui::Rect| painter.with_clip_rect(rect.intersect(painter.clip_rect()));
            // Each cell is named for screen readers, linked to its column header, and says the whole of it on hover
            let describe = |rect: egui::Rect, what: &str, header_id: egui::Id, says: &str, hover: &str| {
                let resp = ui.interact(rect, ui.id().with(("shared_with_me_cell", i, what)), Sense::hover()).labelled_by(header_id);
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, says));
                resp.on_hover_text(hover);
            };

            // Name: the kind's icon and the name, with why an item that can't be read can't, under it
            let name_cell = cell(name_x, name_w);
            let p = in_cell(name_cell);
            let (icon, icon_color) = kind_icon(item.kind);
            let (name_y, reason_y) = if item.unreadable.is_some() { (y - 8.0, y + 9.0) } else { (y, y) };
            p.text(egui::pos2(name_x, name_y), egui::Align2::LEFT_CENTER, icon, icons::font(BUTTON_ICON_SIZE), icon_color);
            let shown = truncate_end_to_width(&p, &name, &name_font, name_w - ICON_ROOM);
            p.text(egui::pos2(name_x + ICON_ROOM, name_y), egui::Align2::LEFT_CENTER, shown, name_font.clone(), TEXT_PRIMARY());
            let mut whole = name.clone();
            if let Some(reason) = &item.unreadable {
                let small = FontId::proportional(11.5);
                let shown = truncate_end_to_width(&p, reason, &small, name_w - ICON_ROOM);
                p.text(egui::pos2(name_x + ICON_ROOM, reason_y), egui::Align2::LEFT_CENTER, shown, small, TEXT_MUTED());
                whole = format!("{name}\n{reason}");
            }
            describe(name_cell, "name", name_header, &name, &whole);

            // Shared by: the address, ⚠ before one that isn't verified
            let by_cell = cell(by_x, by_w);
            let p = in_cell(by_cell);
            let (by, unverified) = sharer_text(item);
            let mut x = by_x;
            if unverified {
                p.text(egui::pos2(x, y), egui::Align2::LEFT_CENTER, icons::WARNING, icons::font(BUTTON_ICON_SIZE), TEXT_MUTED());
                x += text_width(&p, icons::WARNING, &icons::font(BUTTON_ICON_SIZE)) + 4.0;
            }
            let shown = truncate_end_to_width(&p, &by, &text_font, by_cell.right() - x);
            p.text(egui::pos2(x, y), egui::Align2::LEFT_CENTER, shown, text_font.clone(), if by == NONE { TEXT_MUTED() } else { TEXT_PRIMARY() });
            let (says, hover) = if unverified { (format!("{by}, not verified"), UNVERIFIED_SHARER.to_string()) } else { (by.clone(), by.clone()) };
            describe(by_cell, "by", by_header, &says, &hover);

            // Shared, Access
            let date_cell = cell(date_x, date_cell_w);
            let shown = truncate_end_to_width(&p, &dates[i], &text_font, date_cell_w);
            in_cell(date_cell).text(egui::pos2(date_x, y), egui::Align2::LEFT_CENTER, shown, text_font.clone(), TEXT_MUTED());
            describe(date_cell, "date", date_header, &dates[i], &dates[i]);
            let access_cell = cell(access_x, access_cell_w);
            let role = item.role.label();
            let shown = truncate_end_to_width(&p, role, &text_font, access_cell_w);
            in_cell(access_cell).text(egui::pos2(access_x, y), egui::Align2::LEFT_CENTER, shown, text_font.clone(), TEXT_MUTED());
            describe(access_cell, "access", access_header, role, role);

            // The buttons, on the right: Open, then ⋯ where it holds something. An action waiting for the daemon's
            // answer greys them out
            let working = self.shared_with_me.working.contains(&item.uid);
            let right = row.right() - SHARED_ROW_END;
            let more = has_more(item);
            // Open stays in one place in every row: where ⋯ would be is left empty
            let actions = egui::Rect::from_min_max(egui::pos2(right - actions_room, row.top()), egui::pos2(right, row.bottom()));
            let mut actions_ui = ui.new_child(egui::UiBuilder::new().id_salt(("shared_with_me_actions", i)).max_rect(actions).layout(Layout::left_to_right(Align::Center)));
            actions_ui.spacing_mut().item_spacing.x = SHARED_ACTION_GAP;
            actions_ui.add_enabled_ui(!working, |ui| {
                if action_button_named(ui, ButtonKind::Secondary, None, "Open", &format!("Open {name}"), 28.0).clicked() {
                    acted = Some(PageAction::Open(item.uid.clone()));
                }
                if more {
                    let color = if ui.rect_contains_pointer(row) { TEXT_PRIMARY() } else { TEXT_MUTED() };
                    let button = icon_button_colored_named(ui, icons::MORE, "More actions", &format!("More actions for {name}"), color);
                    if button.clicked() {
                        acted = Some(PageAction::More(item.uid.clone(), button.rect));
                    }
                }
            });
            if self.row_note(ui, &item.uid, egui::Rect::from_min_max(egui::pos2(full.left(), row.bottom()), full.max), name_x + ICON_ROOM) {
                acted = Some(PageAction::ShowInFiles(item.uid.clone()));
            }
        }
        acted
    }

    /// What goes under a row: a note (`Downloading…`, `Saved to Downloads`) or why its action failed.
    fn row_note_text(&self, uid: &str) -> Option<(String, bool)> {
        let page = &self.shared_with_me;
        page.row_errors.get(uid).map(|e| (e.clone(), true)).or_else(|| page.notes.get(uid).map(|n| (n.clone(), false)))
    }

    /// Paints a row's note in the `rect` under it, from `at`, and has screen readers say it politely as it appears. A
    /// download that was saved has Show in Files after its note; true when that was pressed.
    fn row_note(&self, ui: &mut egui::Ui, uid: &str, rect: egui::Rect, at: f32) -> bool {
        let Some((text, failed)) = self.row_note_text(uid) else { return false };
        let color = if failed { DANGER_TEXT() } else { TEXT_MUTED() };
        let font = FontId::proportional(12.0);
        let painter = ui.painter().with_clip_rect(rect);
        let shown = truncate_end_to_width(&painter, &text, &font, (rect.right() - at - 12.0).max(0.0));
        painter.text(egui::pos2(at, rect.center().y), egui::Align2::LEFT_CENTER, &shown, font.clone(), color);
        let enabled = ui.is_enabled();
        let resp = ui.interact(rect, ui.id().with(("shared_with_me_note", uid)), Sense::hover());
        resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, &text));
        ui.ctx().accesskit_node_builder(resp.id, |node| node.set_live(egui::accesskit::Live::Polite));
        if failed || !self.shared_with_me.saved.contains_key(uid) {
            return false;
        }
        let x = at + text_width(&painter, &shown, &font) + 12.0;
        let room = egui::Rect::from_min_max(egui::pos2(x, rect.top()), egui::pos2((rect.right() - 12.0).max(x), rect.bottom()));
        let mut link_ui = ui.new_child(egui::UiBuilder::new().id_salt(("shared_with_me_show", uid)).max_rect(room).layout(Layout::left_to_right(Align::Center)));
        let link = link_ui.add(egui::Link::new(RichText::new("Show in Files").size(12.0)));
        scroll_to_focused(&link_ui, &link);
        link.clicked()
    }

    /// Nothing shared with the account: a picture, the web's words, Refresh, and where the rest is, a little above the
    /// middle of the page. True when Refresh was pressed.
    fn render_shared_with_me_empty(&mut self, ui: &mut egui::Ui, viewport: f32) -> bool {
        place_above_middle(ui, "shared_with_me_empty_h", viewport, |ui| {
            let (_, centre) = allocate_picture_circle(ui);
            let colors = share_picture_colors(palette());
            ui.painter().text(centre, egui::Align2::CENTER_CENTER, icons::PEOPLE, icons::font(44.0), colors.glyph);
            ui.add_space(20.0);
            ui.scope(|ui| {
                ui.set_max_width(ui.available_width().min(420.0));
                ui.add(egui::Label::new(RichText::new(model::EMPTY).size(13.0).color(TEXT_MUTED())).wrap().halign(Align::Center));
            });
            ui.add_space(16.0);
            let refresh = crate::action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0);
            let pressed = self.shared_with_me_refresh_pressed(ui, &refresh);
            ui.add_space(24.0);
            Self::shared_with_me_note(ui, self.screenshot_target.is_some());
            pressed
        })
    }

    /// Where saved links and shared photos are, which the daemon never lists.
    fn shared_with_me_note(ui: &mut egui::Ui, screenshot: bool) {
        let resp = ui.add(egui::Link::new(RichText::new(model::WEB_NOTE).size(12.5).color(TEXT_MUTED())));
        scroll_to_focused(ui, &resp);
        if resp.clicked() {
            home::open_externally(std::ffi::OsStr::new(model::WEB_URL), screenshot);
        }
    }

    /// What a button of the page does. Accepting from a sender Proton couldn't verify and leaving ask first; declining,
    /// opening and downloading don't. Each action greys its row out until the daemon answers (`working`), and what it
    /// says (a note, or why it failed) goes under the row.
    fn act_on_shared_with_me(&mut self, action: PageAction) {
        match action {
            PageAction::Accept(uid) => {
                let Some(inv) = self.listing_invitation(&uid) else { return };
                match model::accept_question(&inv) {
                    Some(question) => self.pending_confirm = Some(PendingConfirm::AcceptUnverified { invitation_uid: uid, question }),
                    None => self.send_accept(uid),
                }
            }
            PageAction::Decline(uid) => {
                if self.begin_row_action(&uid) {
                    let _ = self.tx.send(WorkerCommand::DeclineInvitation(uid));
                }
            }
            PageAction::Open(uid) => {
                if self.begin_row_action(&uid) {
                    let _ = self.tx.send(WorkerCommand::OpenSharedUrl(uid));
                }
            }
            PageAction::More(uid, anchor) => self.shared_with_me.menu = Some((uid, anchor)),
            PageAction::ShowInFiles(uid) => {
                if let Some(path) = self.shared_with_me.saved.get(&uid) {
                    home::show_in_files(std::path::Path::new(path));
                }
            }
        }
    }

    fn listing_invitation(&self, uid: &str) -> Option<Invitation> {
        self.shared_with_me.listing.as_ref()?.invitations.iter().find(|i| i.invitation_uid == uid).cloned()
    }

    fn listing_item(&self, uid: &str) -> Option<Item> {
        self.shared_with_me.listing.as_ref()?.items.iter().find(|i| i.uid == uid).cloned()
    }

    /// An action on a row starts: its last note and failure go, and it waits for the daemon. False when the row is
    /// already waiting for one.
    fn begin_row_action(&mut self, uid: &str) -> bool {
        let page = &mut self.shared_with_me;
        if !page.working.insert(uid.to_string()) {
            return false;
        }
        page.notes.remove(uid);
        page.row_errors.remove(uid);
        page.saved.remove(uid);
        true
    }

    /// Accept an invitation, once its question (if it has one) was answered.
    pub(crate) fn send_accept(&mut self, invitation_uid: String) {
        let Some(inv) = self.listing_invitation(&invitation_uid) else { return };
        if self.begin_row_action(&invitation_uid) {
            self.shared_with_me.accepting.insert(invitation_uid.clone(), model::Accepted { name: inv.name, kind: inv.kind });
            let _ = self.tx.send(WorkerCommand::AcceptInvitation(invitation_uid));
        }
    }

    /// Leave an item, once its question was answered.
    pub(crate) fn send_leave(&mut self, uid: String) {
        if self.begin_row_action(&uid) {
            let _ = self.tx.send(WorkerCommand::LeaveShared(uid));
        }
    }

    fn send_download(&mut self, uid: String) {
        if self.begin_row_action(&uid) {
            self.shared_with_me.notes.insert(uid.clone(), model::DOWNLOADING.to_string());
            let _ = self.tx.send(WorkerCommand::DownloadShared(uid));
        }
    }

    /// The daemon's answer to one of the page's actions (the page's other events are `SharedWithMeLoaded`). A failure
    /// says why under its row and changes nothing else; what went through reads the list again.
    pub(crate) fn on_shared_with_me_answer(&mut self, event: WorkerEvent) {
        let fail = |page: &mut model::SharedWithMePage, uid: String, why: String| {
            page.notes.remove(&uid);
            page.row_errors.insert(uid, why);
        };
        match event {
            WorkerEvent::InvitationAccepted(uid, result) => {
                let page = &mut self.shared_with_me;
                page.working.remove(&uid);
                let accepted = page.accepting.remove(&uid);
                match result {
                    Ok(()) => {
                        page.accepted.extend(accepted);
                        page.retry_armed = true;
                        self.load_shared_with_me();
                    }
                    Err(why) => fail(page, uid, why),
                }
            }
            WorkerEvent::InvitationDeclined(uid, result) | WorkerEvent::SharedLeft(uid, result) => {
                let page = &mut self.shared_with_me;
                page.working.remove(&uid);
                match result {
                    Ok(()) => self.load_shared_with_me(),
                    Err(why) => fail(page, uid, why),
                }
            }
            WorkerEvent::SharedUrl(uid, result) => {
                self.shared_with_me.working.remove(&uid);
                match result {
                    // Only a web address goes to the opener: it hands what it is given to the desktop
                    Ok(url) => {
                        let url = if url.starts_with("https://") { url } else { model::WEB_URL.to_string() };
                        home::open_externally(std::ffi::OsStr::new(&url), self.screenshot_target.is_some());
                    }
                    Err(why) => fail(&mut self.shared_with_me, uid, why),
                }
            }
            WorkerEvent::SharedDownloaded(uid, result) => {
                let page = &mut self.shared_with_me;
                page.working.remove(&uid);
                match result {
                    Ok(path) => {
                        page.notes.insert(uid.clone(), model::SAVED.to_string());
                        page.saved.insert(uid, path);
                    }
                    Err(why) => fail(page, uid, why),
                }
            }
            _ => {}
        }
    }

    /// The ⋯ menu of an item, under its button: Download for a file, Leave where the item can be left. Closes on a
    /// pick, Escape or a click outside it.
    fn shared_with_me_menu(&mut self, ctx: &egui::Context) {
        let Some((uid, anchor)) = self.shared_with_me.menu.clone() else { return };
        let Some(item) = self.listing_item(&uid).filter(has_more) else {
            self.shared_with_me.menu = None;
            return;
        };
        crate::click_shield(ctx, "shared_with_me_menu_shield", egui::Order::Foreground, None);
        let (download, leave) = (item.kind == Kind::File, item.can_leave);
        let mut picked = None;
        egui::Area::new(egui::Id::new(MENU_ID))
            .order(egui::Order::Tooltip)
            .fixed_pos(anchor.right_bottom() + Vec2::new(0.0, 6.0))
            .pivot(egui::Align2::RIGHT_TOP)
            .show(ctx, |ui| {
                home::menu_frame().show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    if download && home::menu_item(ui, None, "Download", 168.0).clicked() {
                        picked = Some(true);
                    }
                    if leave && home::menu_item(ui, None, "Leave", 168.0).clicked() {
                        picked = Some(false);
                    }
                });
            });
        // Read before ui.input: egui's context lock isn't re-entrant
        let menu = ctx.memory(|m| m.area_rect(egui::Id::new(MENU_ID)));
        let outside = ctx.input(|i| {
            i.key_pressed(egui::Key::Escape)
                || (i.pointer.primary_clicked() && !matches!((menu, i.pointer.interact_pos()), (Some(rect), Some(pos)) if rect.contains(pos)))
        });
        if picked.is_some() || outside {
            self.shared_with_me.menu = None;
            ctx.request_repaint();
        }
        match picked {
            Some(true) => self.send_download(uid),
            Some(false) => {
                let question = model::leave_question(&item);
                self.pending_confirm = Some(PendingConfirm::LeaveShared { uid, question });
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_read_day_month_year() {
        assert_eq!(format_date(1_793_750_400_000, 0), "4 Nov 2026");
        assert_eq!(format_date(1_793_750_400_000, -3600), "3 Nov 2026", "by the local calendar");
        assert_eq!(format_date(1_798_675_200_000, 0), "31 Dec 2026");
    }
}
