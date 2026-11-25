//! The Shared section's view (#253, #276, #285): the list layout, column sizing, sharing badges, row actions,
//! empty state illustration, and Photos note. Its data model and wording live in `shared.rs`.

use eframe::egui::{self, Align, Color32, FontId, Frame, Layout, Margin, RichText, ScrollArea, Sense, Stroke, Vec2};

use crate::{
    action_button, activity, bold, decoration, home, icon_button_colored_named, icons, palette,
    scroll_to_focused, shared, text_width, truncate_end_to_width, truncate_middle_to_width, ButtonKind, Palette,
    PendingConfirm, ProtonDriveNativeApp, BORDER_SUBTLE, BUTTON_ICON_SIZE, DANGER_TEXT, FOLDER_ICON, ICON_BUTTON_SIZE,
    PROTON_PURPLE_TEXT, SCROLL_GUTTER, STATUS_SUCCESS, TEXT_MUTED, TEXT_PRIMARY,
};

/// The least the Shared list's Location column keeps before the name gives way.
pub(crate) const SHARED_LOCATION_MIN: f32 = 56.0;

/// How the Shared list's text columns share `room`, as (name, location, sharing). Sharing has what its marks need (up
/// to half the room) and what its words want (up to two fifths). The name has at least half the rest, so the
/// columns line up, and more as it needs. Location gives way first, down to `SHARED_LOCATION_MIN`; then the name.
pub(crate) fn shared_columns(room: f32, name_want: f32, sharing_need: f32, sharing_want: f32) -> (f32, f32, f32) {
    let room = room.max(0.0);
    let sharing = sharing_want.min(room * 0.4).max(sharing_need.min(room * 0.5));
    let rest = room - sharing;
    // max then min, not clamp: rounding can put the bounds a hair the wrong way round, which clamp panics on
    let name = name_want.max(rest * 0.5).min(rest - SHARED_LOCATION_MIN.min(rest * 0.5));
    (name, rest - name, sharing)
}

/// A Shared row's height.
const SHARED_ROW_HEIGHT: f32 = 44.0;
/// The room between the Shared list's columns.
const SHARED_COLUMN_GAP: f32 = 12.0;
/// The room between a row's actions.
const SHARED_ACTION_GAP: f32 = 4.0;
/// The room after a row's actions, before the end of its line.
const SHARED_ROW_END: f32 = 4.0;

/// Something the Sharing column paints: a glyph (in the icons' font) or words.
struct SharingPiece {
    text: String,
    glyph: bool,
    color: Color32,
    /// Left out first when the column is too narrow for everything ("Link expired": the broken link, in red, says it)
    spare: bool,
}

/// What a row's Sharing column paints, left to right: its marks, "Link expired" after a broken link and the number of
/// people after their mark; or, for an item whose sharing couldn't be read, the warning and why.
fn sharing_pieces(item: &shared::SharedItem, now_ms: i64) -> Vec<SharingPiece> {
    let piece = |text: &str, glyph, color| SharingPiece { text: text.to_string(), glyph, color, spare: false };
    if let Some(reason) = &item.unreadable {
        return vec![piece(icons::WARNING, true, TEXT_MUTED()), piece(reason, false, TEXT_MUTED())];
    }
    let marks = shared::sharing_marks(item, now_ms);
    if marks.is_empty() {
        return vec![piece(&shared::exposure_text(item, now_ms, home::local_offset_secs), false, TEXT_MUTED())];
    }
    let mut pieces = Vec::new();
    for mark in marks {
        if mark == icons::LINK_BROKEN {
            pieces.push(piece(mark, true, DANGER_TEXT()));
            pieces.push(SharingPiece { spare: true, ..piece("Link expired", false, DANGER_TEXT()) });
        } else {
            pieces.push(piece(mark, true, TEXT_MUTED()));
        }
        if mark == icons::PEOPLE {
            pieces.push(piece(&item.people.to_string(), false, TEXT_MUTED()));
        }
    }
    pieces
}

/// The fonts of the Sharing column's glyphs and words.
fn sharing_font(piece: &SharingPiece) -> FontId {
    if piece.glyph {
        icons::font(BUTTON_ICON_SIZE)
    } else {
        FontId::proportional(13.0)
    }
}

/// The room before a piece of the Sharing column: little between a mark and its words, more before the next mark.
fn sharing_gap(before: &SharingPiece, piece: &SharingPiece) -> f32 {
    match (before.glyph, piece.glyph) {
        (true, false) => 4.0,
        (true, true) => 6.0,
        _ => 10.0,
    }
}

/// How wide the Sharing column's pieces are, side by side.
fn sharing_width(painter: &egui::Painter, pieces: &[&SharingPiece]) -> f32 {
    let widths: f32 = pieces.iter().map(|p| text_width(painter, &p.text, &sharing_font(p))).sum();
    widths + pieces.windows(2).map(|w| sharing_gap(w[0], w[1])).sum::<f32>()
}

/// The pieces that fit `width`: all of them, or all but the spare ones.
fn sharing_fit<'a>(painter: &egui::Painter, pieces: &'a [SharingPiece], width: f32) -> Vec<&'a SharingPiece> {
    let all: Vec<&SharingPiece> = pieces.iter().collect();
    if sharing_width(painter, &all) <= width {
        all
    } else {
        pieces.iter().filter(|p| !p.spare).collect()
    }
}

/// The Shared list: the column headers, then a row per item, with lines between them and no card. Returns the button
/// clicked, with its row's index.
fn shared_list(ui: &mut egui::Ui, items: &[shared::SharedItem], now_ms: i64, stopping: Option<&str>) -> Option<(SharedAction, usize)> {
    // Room before the name, and between a name's icon and the name
    const START: f32 = 8.0;
    const ICON_ROOM: f32 = BUTTON_ICON_SIZE + 8.0;
    let name_font = FontId::proportional(14.0);
    let text_font = FontId::proportional(13.0);
    let header_font = FontId::proportional(12.0);
    let pieces: Vec<Vec<SharingPiece>> = items.iter().map(|item| sharing_pieces(item, now_ms)).collect();
    let painter = ui.painter().clone();

    // The columns, from what they would like and the room there is. Room for the most buttons a row has, so that
    // the actions never move
    let actions_room = 4.0 * ICON_BUTTON_SIZE + 3.0 * SHARED_ACTION_GAP;
    let width = ui.available_width();
    let room = width - START - SHARED_ROW_END - actions_room - 3.0 * SHARED_COLUMN_GAP;
    let name_want = items.iter().map(|i| ICON_ROOM + text_width(&painter, &i.name, &name_font)).fold(0.0, f32::max);
    // Sharing needs room for every readable row's marks, and wants room for its words; an unreadable row's reason is
    // cut to the column and shown whole on hover so one unreadable item doesn't widen the column for every row (#284)
    let sharing_need = items
        .iter()
        .zip(&pieces)
        .filter(|(i, _)| i.unreadable.is_none())
        .map(|(_, p)| sharing_width(&painter, &sharing_fit(&painter, p, 0.0)))
        .fold(text_width(&painter, "Sharing", &header_font), f32::max);
    let sharing_want = items
        .iter()
        .zip(&pieces)
        .filter(|(i, _)| i.unreadable.is_none())
        .map(|(_, p)| sharing_width(&painter, &p.iter().collect::<Vec<_>>()))
        .fold(sharing_need, f32::max);
    let (name_w, location_w, sharing_w) = shared_columns(room, name_want, sharing_need, sharing_want);

    ui.spacing_mut().item_spacing.y = 0.0;
    let line = |painter: &egui::Painter, rect: egui::Rect| {
        painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0_f32, BORDER_SUBTLE()));
    };
    let (header, _) = ui.allocate_exact_size(Vec2::new(width, 32.0), Sense::hover());
    let name_x = header.left() + START;
    let location_x = name_x + name_w + SHARED_COLUMN_GAP;
    let sharing_x = location_x + location_w + SHARED_COLUMN_GAP;
    let enabled = ui.is_enabled();
    let header_col = |ui: &mut egui::Ui, title: &'static str, x: f32, w: f32| -> egui::Id {
        let rect = egui::Rect::from_min_max(egui::pos2(x, header.top()), egui::pos2(x + w.max(0.0), header.bottom()));
        let resp = ui.interact(rect, ui.id().with(("shared_header", title)), Sense::hover());
        resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Other, enabled, title));
        ui.ctx().accesskit_node_builder(resp.id, |node| {
            node.set_role(egui::accesskit::Role::ColumnHeader);
        });
        painter.text(egui::pos2(x, header.center().y), egui::Align2::LEFT_CENTER, title, header_font.clone(), TEXT_MUTED());
        resp.id
    };
    let name_header = header_col(ui, "Name", name_x, name_w);
    let location_header = header_col(ui, "Location", location_x, location_w);
    let sharing_header = header_col(ui, "Sharing", sharing_x, sharing_w);
    line(&painter, header);

    let mut act = None;
    for (i, (item, pieces)) in items.iter().zip(&pieces).enumerate() {
        let (row, _) = ui.allocate_exact_size(Vec2::new(width, SHARED_ROW_HEIGHT), Sense::hover());
        line(&painter, row);
        let y = row.center().y;
        let cell = |x: f32, w: f32| egui::Rect::from_min_max(egui::pos2(x, row.top()), egui::pos2(x + w.max(0.0), row.bottom()));
        let in_cell = |rect: egui::Rect| painter.with_clip_rect(rect.intersect(painter.clip_rect()));
        // Each cell is named for screen readers, linked to its column header (#283), and says the whole of it on hover
        let describe = |rect: egui::Rect, what: &str, header_id: egui::Id, says: &str, hover: &str| {
            let resp = ui
                .interact(rect, ui.id().with(("shared_cell", i, what)), Sense::hover())
                .labelled_by(header_id);
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, says));
            resp.on_hover_text(hover);
        };
        let whole = format!("{}\n{}", item.name, shared::folder_text(item));

        // Name: a folder's or a file's icon, then the name
        let name_cell = cell(name_x, name_w);
        let p = in_cell(name_cell);
        let icon = shared::item_icon(item);
        let icon_color = if icon == icons::FOLDER { FOLDER_ICON() } else { TEXT_MUTED() };
        p.text(egui::pos2(name_x, y), egui::Align2::LEFT_CENTER, icon, icons::font(BUTTON_ICON_SIZE), icon_color);
        let name = truncate_middle_to_width(&p, &item.name, &name_font, name_w - ICON_ROOM);
        p.text(egui::pos2(name_x + ICON_ROOM, y), egui::Align2::LEFT_CENTER, name, name_font.clone(), TEXT_PRIMARY());
        describe(name_cell, "name", name_header, &item.name, &whole);

        // Location: the folder, or where the item is instead, in weak text. A folder is cut in the middle, keeping
        // its end; a phrase ("Hidden from this computer", "(top level)") at its end (R13)
        let location_cell = cell(location_x, location_w);
        let location = shared::location_text(item);
        let color = if item.place == shared::Place::MyFiles { TEXT_PRIMARY() } else { TEXT_MUTED() };
        let p = in_cell(location_cell);
        let is_folder = item.place == shared::Place::MyFiles && item.rel_path.as_deref().is_some_and(|r| r.contains('/'));
        let shown = if is_folder {
            truncate_middle_to_width(&p, &location, &text_font, location_w)
        } else {
            truncate_end_to_width(&p, &location, &text_font, location_w)
        };
        p.text(egui::pos2(location_x, y), egui::Align2::LEFT_CENTER, shown, text_font.clone(), color);
        describe(location_cell, "location", location_header, &location, &whole);

        // The actions, on the right: weak until the row is hovered. A row being stopped waits for the answer
        let buttons = SharedAction::for_item(item, now_ms);
        let n = buttons.len() as f32;
        let actions_w = n * ICON_BUTTON_SIZE + (n - 1.0).max(0.0) * SHARED_ACTION_GAP;
        let right = row.right() - SHARED_ROW_END;
        let actions = egui::Rect::from_min_max(egui::pos2(right - actions_w, row.top()), egui::pos2(right, row.bottom()));

        // Sharing: the marks, or the warning and why; the whole sentence on hover. An unreadable row has fewer action
        // buttons on the right, so its reason may use the room up to its own actions without widening Sharing for the
        // other rows (#284).
        let row_sharing_w = if item.unreadable.is_some() {
            (actions.left() - SHARED_COLUMN_GAP - sharing_x).max(sharing_w)
        } else {
            sharing_w
        };
        let sharing_cell = cell(sharing_x, row_sharing_w);
        let p = in_cell(sharing_cell);
        let mut x = sharing_x;
        let fit = sharing_fit(&p, pieces, row_sharing_w);
        for (k, piece) in fit.iter().enumerate() {
            if k > 0 {
                x += sharing_gap(fit[k - 1], piece);
            }
            let font = sharing_font(piece);
            // Words, all phrases, are cut at their end to the column (R13); a glyph past its edge is cut off by it
            let text = if piece.glyph { piece.text.clone() } else { truncate_end_to_width(&p, &piece.text, &font, sharing_cell.right() - x) };
            let w = text_width(&p, &text, &font);
            p.text(egui::pos2(x, y), egui::Align2::LEFT_CENTER, text, font, piece.color);
            x += w;
        }
        let exposure = shared::exposure_text(item, now_ms, home::local_offset_secs);
        describe(sharing_cell, "sharing", sharing_header, &exposure, &exposure);

        let color = if ui.rect_contains_pointer(row) { TEXT_PRIMARY() } else { TEXT_MUTED() };
        let busy = stopping.is_some() && stopping == item.rel_path.as_deref();
        let mut actions_ui = ui.new_child(egui::UiBuilder::new().id_salt(("shared_actions", i)).max_rect(actions).layout(Layout::left_to_right(Align::Center)));
        actions_ui.spacing_mut().item_spacing.x = SHARED_ACTION_GAP;
        actions_ui.add_enabled_ui(!busy, |ui| {
            for button in &buttons {
                // One stop at a time: the other rows' Stop sharing wait for the answer
                let can = *button != SharedAction::Stop || stopping.is_none();
                let name = button.accessible_name(&item.name);
                if ui
                    .add_enabled_ui(can, |ui| icon_button_colored_named(ui, button.icon(), button.label(), &name, color))
                    .inner
                    .clicked()
                {
                    act = Some((*button, i));
                }
            }
        });
    }
    act
}

/// A button on a row of the Shared page.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum SharedAction {
    CopyLink,
    Manage,
    ShowInFiles,
    Stop,
    ManageOnWeb,
}

impl SharedAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            SharedAction::CopyLink => "Copy link",
            SharedAction::Manage => "Manage…",
            SharedAction::ShowInFiles => "Show in Files",
            SharedAction::Stop => "Stop sharing",
            SharedAction::ManageOnWeb => "Manage on the web",
        }
    }

    /// Screen-reader name naming both the action and the row's item (#374).
    pub(crate) fn accessible_name(self, item_name: &str) -> String {
        match self {
            SharedAction::CopyLink => format!("Copy link for {item_name}"),
            SharedAction::Manage => format!("Manage {item_name}"),
            SharedAction::ShowInFiles => format!("Show {item_name} in Files"),
            SharedAction::Stop => format!("Stop sharing {item_name}"),
            SharedAction::ManageOnWeb => format!("Manage {item_name} on the web"),
        }
    }

    fn icon(self) -> &'static str {
        match self {
            SharedAction::CopyLink => icons::COPY,
            SharedAction::Manage => icons::MANAGE,
            SharedAction::ShowInFiles => icons::FOLDER_OPEN,
            SharedAction::Stop => icons::LINK_BROKEN,
            SharedAction::ManageOnWeb => icons::WEB,
        }
    }

    /// The buttons a row gets. An item whose sharing couldn't be read gets only what doesn't depend on it (Show in
    /// Files, the web), never Stop sharing, Manage… or Copy link (#253); one outside My files, only the web.
    fn for_item(item: &shared::SharedItem, now_ms: i64) -> Vec<SharedAction> {
        let has_path = item.rel_path.is_some();
        let mut buttons = Vec::new();
        if item.unreadable.is_some() {
            if has_path && item.place == shared::Place::MyFiles {
                buttons.push(SharedAction::ShowInFiles);
            }
            buttons.push(SharedAction::ManageOnWeb);
        } else if item.place == shared::Place::MyFiles && has_path {
            if shared::can_copy(item, now_ms) {
                buttons.push(SharedAction::CopyLink);
            }
            buttons.extend([SharedAction::Manage, SharedAction::ShowInFiles, SharedAction::Stop]);
        } else {
            buttons.push(SharedAction::ManageOnWeb);
        }
        buttons
    }
}

/// The colours of the empty Shared page's picture, from one theme.
pub(crate) struct SharePictureColors {
    pub(crate) circle: Color32,
    pub(crate) glyph: Color32,
    pub(crate) badge: Color32,
    pub(crate) badge_line: Color32,
}

pub(crate) fn share_picture_colors(p: &Palette) -> SharePictureColors {
    SharePictureColors { circle: p.purple_soft, glyph: p.purple_text, badge: p.card, badge_line: p.border_weak }
}

/// The empty Shared page's Photos line: its text size, and the gap between the lead-in and the link
const PHOTOS_SIZE: f32 = 12.0;
const PHOTOS_GAP: f32 = 4.0;

/// The soft circle of the empty Shared page's picture, in the 128 x 112 room it has, and the circle's centre.
fn allocate_picture_circle(ui: &mut egui::Ui) -> (egui::Response, egui::Pos2) {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(128.0, 112.0), Sense::hover());
    let centre = rect.center();
    ui.painter().circle_filled(centre, 48.0, share_picture_colors(palette()).circle);
    (response, centre)
}

/// The Shared page while its list is first read: the empty picture's circle with the sync arrows turning in it, and
/// the words under it. Only the words are for screen readers.
fn paint_share_loading(ui: &mut egui::Ui) {
    let (_, centre) = allocate_picture_circle(ui);
    home::paint_turned_glyph(ui.painter(), centre, icons::SYNC, 44.0, share_picture_colors(palette()).glyph, home::turning_angle(ui));
    ui.add_space(20.0);
    let words = ui.label(RichText::new(shared::LOADING).size(13.0).color(TEXT_MUTED()));
    announce_politely(ui, &words);
}

/// Has screen readers say `label` as it appears, without taking the focus (as `working_line` does, #370).
fn announce_politely(ui: &egui::Ui, label: &egui::Response) {
    ui.ctx().accesskit_node_builder(label.id, |node| node.set_live(egui::accesskit::Live::Polite));
}

/// The empty Shared page's picture, for looking at only (screen readers get the heading): a link in a soft circle with
/// a person's badge at each side.
fn paint_share_picture(ui: &mut egui::Ui) -> egui::Response {
    let c = share_picture_colors(palette());
    let (response, centre) = allocate_picture_circle(ui);
    let painter = ui.painter();
    painter.text(centre, egui::Align2::CENTER_CENTER, icons::SHARED, icons::font(44.0), c.glyph);
    for offset in [Vec2::new(-46.0, 26.0), Vec2::new(46.0, -26.0)] {
        let at = centre + offset;
        painter.circle(at, 16.0, c.badge, egui::Stroke::new(1.5_f32, c.badge_line));
        painter.text(at, egui::Align2::CENTER_CENTER, icons::PERSON, icons::font(18.0), c.glyph);
    }
    response
}

/// Lays `add` out top-down and centred, a little above the middle of a page `viewport` tall: it starts
/// `(viewport - its height) * 0.4` down, and its height is last frame's, kept under `id`. When that changes, the frame
/// is drawn again with the new one. Gives back what `add` gave.
fn place_above_middle<R>(ui: &mut egui::Ui, id: &str, viewport: f32, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let id = egui::Id::new(id);
    let last: f32 = ui.ctx().data_mut(|d| d.get_temp(id)).unwrap_or(0.0);
    ui.add_space(((viewport - last) * 0.4).max(0.0));
    let group = ui.with_layout(Layout::top_down(Align::Center), add);
    let height = group.response.rect.height();
    if (height - last).abs() > 0.5 {
        ui.ctx().data_mut(|d| d.insert_temp(id, height));
        // This frame placed the group by a stale height: draw it again with the new one
        ui.ctx().request_discard("shared group height");
    }
    group.inner
}

impl ProtonDriveNativeApp {
    /// Shared: what you've shared, as a list of Proton's kind: each item's name, where it is, what it exposes and what
    /// can be done with it.
    pub(crate) fn render_shared(&mut self, ui: &mut egui::Ui) {
        // A gutter for the scroll bar, as Settings has, so that it never draws over the actions; the toolbar keeps it
        // too, so that Refresh lines up with them
        let gutter = SCROLL_GUTTER;
        // The toolbar, which stays while the list scrolls: what was just done on the left, Refresh on the right, in
        // line with the rows' actions (the title is the top bar's)
        let toolbar = Margin { right: gutter.right + SHARED_ROW_END as i8, ..gutter };
        Frame::NONE.inner_margin(toolbar).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(34.0);
                if self.shared.copied.is_some() {
                    // The words say it for screen readers: the check is only painted
                    decoration(ui, icons::CHECK, 16.0, STATUS_SUCCESS);
                    ui.label(RichText::new("Link copied").size(13.0).color(TEXT_MUTED()));
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // Only a list has a Refresh here. The empty page and the error have their own, centred where
                    // the eyes are, and a first read has the page's loading picture
                    if self.shared.has_rows() && self.shared.error.is_none() {
                        if self.shared.loading {
                            // The rows reload (greyed out): the arrows turn here, where Refresh was. Right to left:
                            // the words, then the arrows
                            let words = ui.label(RichText::new(shared::REFRESHING).size(13.0).color(TEXT_MUTED()));
                            announce_politely(ui, &words);
                            home::turning_decoration(ui, icons::SYNC, 16.0, PROTON_PURPLE_TEXT(), home::turning_angle(ui));
                        } else {
                            let refresh = action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0);
                            if self.shared_button_pressed(ui, &refresh) {
                                self.load_shared();
                            }
                        }
                    }
                });
            });
        });
        ui.add_space(8.0);

        let viewport = ui.available_height();
        ScrollArea::vertical().id_salt("shared_scroll").auto_shrink([false, false]).show(ui, |ui| {
            Frame::NONE.inner_margin(gutter).show(ui, |ui| {
                if let Some(error) = self.shared.error.clone() {
                    // Placed as the empty page is, with the one way out right under what went wrong
                    let retry = place_above_middle(ui, "shared_error_h", viewport, |ui| {
                        ui.scope(|ui| {
                            // A fixed width, so the box is centred and the words are centred in it
                            ui.set_width(ui.available_width().min(420.0));
                            ui.add(egui::Label::new(RichText::new(error).size(13.0).color(DANGER_TEXT())).wrap().halign(Align::Center));
                        });
                        ui.add_space(12.0);
                        let retry = action_button(ui, ButtonKind::Primary, Some(icons::REFRESH), "Retry", 34.0);
                        self.shared_button_pressed(ui, &retry)
                    });
                    if retry {
                        self.load_shared();
                    }
                    return;
                }
                let loading = self.shared.loading;
                if loading && !self.shared.has_rows() {
                    place_above_middle(ui, "shared_loading_h", viewport, paint_share_loading);
                    return;
                }
                let Some(items) = &self.shared.items else { return };
                if items.is_empty() {
                    if self.render_shared_empty(ui, viewport) {
                        self.load_shared();
                    }
                    return;
                }
                if let Some(error) = &self.shared.stop_error {
                    ui.add(egui::Label::new(RichText::new(error).size(13.0).color(DANGER_TEXT())).wrap());
                    ui.add_space(10.0);
                }
                // The rows of the list being replaced stay, greyed out and without clicks
                let act = ui.add_enabled_ui(!loading, |ui| shared_list(ui, items, home::now_ms(), self.shared.stopping.as_deref())).inner;
                ui.add_space(12.0);
                Self::shared_photos_note(ui, self.screenshot_target.is_some());
                if let Some((action, i)) = act {
                    self.act_on_shared_row(ui.ctx(), action, i);
                }
            });
        });
    }

    /// Whether a Refresh or Retry was pressed. One pressed from the keyboard is remembered, and the focus it loses
    /// while the page reads is given to the one that shows when the read ends; a mouse click moves no focus (#411).
    fn shared_button_pressed(&mut self, ui: &egui::Ui, button: &egui::Response) -> bool {
        if self.shared.refocus && !self.shared.loading {
            self.shared.refocus = false;
            button.request_focus();
        }
        let pressed = button.clicked();
        if pressed {
            self.shared.refocus = !ui.input(|i| i.pointer.any_click());
        }
        pressed
    }

    /// Nothing shared yet: a picture, a heading and the one way to share, a little above the middle of the page (the
    /// height it is placed by is last frame's), Refresh, and where Photos shares are. True when Refresh was clicked.
    fn render_shared_empty(&mut self, ui: &mut egui::Ui, viewport: f32) -> bool {
        place_above_middle(ui, "shared_empty_h", viewport, |ui| {
            paint_share_picture(ui);
            ui.add_space(20.0);
            ui.label(RichText::new(shared::EMPTY_TITLE).font(bold(16.0)).color(TEXT_PRIMARY()));
            ui.add_space(6.0);
            ui.scope(|ui| {
                ui.set_max_width(ui.available_width().min(420.0));
                ui.add(egui::Label::new(RichText::new(shared::EMPTY_HOW).size(13.0).color(TEXT_MUTED())).wrap().halign(Align::Center));
            });
            ui.add_space(16.0);
            let refresh = action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Refresh", 34.0);
            let refresh = self.shared_button_pressed(ui, &refresh);
            ui.add_space(24.0);
            // Centred in one row if both parts fit the page, else the lead-in above the link
            let width_of = |ui: &egui::Ui, text: &str| ui.painter().layout_no_wrap(text.into(), FontId::proportional(PHOTOS_SIZE), TEXT_MUTED()).size().x;
            let parts = width_of(ui, shared::EMPTY_PHOTOS) + PHOTOS_GAP + width_of(ui, shared::PHOTOS_LINK);
            let lead_in = |ui: &mut egui::Ui| ui.label(RichText::new(shared::EMPTY_PHOTOS).size(PHOTOS_SIZE).color(TEXT_MUTED()));
            let link = |ui: &mut egui::Ui| {
                let resp = ui.add(egui::Link::new(RichText::new(shared::PHOTOS_LINK).size(PHOTOS_SIZE)));
                scroll_to_focused(ui, &resp);
                if resp.clicked() {
                    Self::open_shared_on_web(self.screenshot_target.is_some());
                }
            };
            if parts <= ui.available_width() {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = PHOTOS_GAP;
                    ui.add_space((ui.available_width() - parts) / 2.0);
                    lead_in(ui);
                    link(ui);
                });
            } else {
                lead_in(ui);
                link(ui);
            }
            refresh
        })
    }

    /// The daemon never lists Photos shares, so the page says where to find them (#256).
    fn shared_photos_note(ui: &mut egui::Ui, screenshot: bool) {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            ui.label(RichText::new(shared::PHOTOS_NOTE).size(12.5).color(TEXT_MUTED()));
            let resp = ui.add(egui::Link::new(RichText::new(shared::PHOTOS_LINK).size(12.5)));
            scroll_to_focused(ui, &resp);
            if resp.clicked() {
                Self::open_shared_on_web(screenshot);
            }
        });
    }

    fn open_shared_on_web(screenshot: bool) {
        home::open_externally(std::ffi::OsStr::new(shared::WEB_SHARED_URL), screenshot);
    }

    /// What a button of the row at `i` does.
    fn act_on_shared_row(&mut self, ctx: &egui::Context, action: SharedAction, i: usize) {
        let Some(item) = self.shared.items.as_ref().and_then(|items| items.get(i)).cloned() else {
            return;
        };
        match action {
            SharedAction::CopyLink => {
                if let Some(link) = &item.link {
                    ctx.copy_text(link.url.clone());
                    self.shared.copied = item.rel_path.clone();
                }
            }
            SharedAction::Manage => {
                if let Some(abs) = item.rel_path.as_deref().and_then(|rel| activity::local_path(&self.status.sync_dir, rel)) {
                    self.open_share(&abs.to_string_lossy());
                }
            }
            SharedAction::ShowInFiles => {
                if let Some(target) = item.rel_path.as_deref().and_then(|rel| activity::show_target(&self.status.sync_dir, rel)) {
                    home::show_in_files(&target);
                }
            }
            SharedAction::ManageOnWeb => {
                home::open_externally(std::ffi::OsStr::new(shared::WEB_SHARED_URL), self.screenshot_target.is_some());
            }
            SharedAction::Stop => {
                if let Some(rel_path) = item.rel_path.clone().filter(|_| self.shared.stopping.is_none()) {
                    let question = shared::stop_question(&item, home::now_ms());
                    self.pending_confirm = Some(PendingConfirm::StopSharing { rel_path, uid: item.uid.clone(), question });
                }
            }
        }
    }
}
