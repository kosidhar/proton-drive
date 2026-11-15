//! The window's frame around the sections: the sidebar, as Proton's apps have it (#276). From the top: the logo, Open
//! in Files, the sections, and at its foot the storage meter and the version.

use std::path::Path;

use eframe::egui::{self, Align, Color32, CornerRadius, FontId, Frame, Layout, Margin, RichText, Sense, Vec2};

use crate::{
    action_button_sized, bold, format_bytes, home, icons, AccountInfo, ButtonKind, NavTab, ProtonDriveNativeApp,
    BG_SIDEBAR, SIDEBAR_HOVER, SIDEBAR_SELECTED, SIDEBAR_TEXT, SIDEBAR_WEAK, STATUS_DANGER, STORAGE_FILL, STORAGE_TRACK,
};

/// The sidebar's one button: the drive's folder in the file manager
pub(crate) const OPEN_IN_FILES: &str = "Open in Files";
/// Why Open in Files is greyed out
pub(crate) const OPEN_IN_FILES_WAITS: &str = "Set up a folder in Settings first";

const SIDEBAR_WIDTH: f32 = 252.0;
/// The mark's side, beside "Proton Drive"
const LOGO_SIZE: f32 = 28.0;
/// A section's row: with the spacing between rows, 38 pt apart, as on drive.proton.me
const SECTION_HEIGHT: f32 = 35.0;
const SECTION_ICON_SIZE: f32 = 16.0;
/// The room on the left of a section's icon, and between its icon and its name
const SECTION_PADDING: f32 = 12.0;
const SECTION_ICON_GAP: f32 = 10.0;

/// What the storage meter says the account uses of its quota: "3.0 GB / 510.0 GB". None without the account's usage
/// or a quota, as `home::storage`.
pub(crate) fn storage_meter_text(account: Option<&AccountInfo>) -> Option<String> {
    let a = account.filter(|a| a.max_space > 0)?;
    Some(format!("{} / {}", format_bytes(a.used_space), format_bytes(a.max_space)))
}

impl ProtonDriveNativeApp {
    /// The sidebar, navy in light mode as on drive.proton.me, and dark in dark mode.
    pub(crate) fn render_sidebar(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("proton_sidebar")
            .resizable(false)
            // The edge is egui's separator line, which the theme draws in BORDER_SUBTLE. A stroke on the frame as well
            // made the panel 2 px wider than its 252 px, and that strip, outside what the panel paints, showed the
            // window's black clear colour as a hard line (#254)
            .show_separator_line(true)
            .exact_width(SIDEBAR_WIDTH)
            .frame(Frame::NONE.fill(BG_SIDEBAR()).inner_margin(Margin { left: 12, right: 12, top: 16, bottom: 14 }))
            .show(ctx, |ui| {
                // What is greyed out fades into the sidebar's colour, not into the theme's light grey
                ui.visuals_mut().widgets.noninteractive.weak_bg_fill = BG_SIDEBAR();
                if self.pending_confirm.is_some() {
                    ui.disable(); // As in the section: nothing under the confirmation dialog takes clicks while it is open
                }
                self.render_logo(ui);
                ui.add_space(18.0);
                self.render_open_in_files(ui);
                ui.add_space(14.0);
                self.render_sections(ui);
                self.render_storage_meter(ui);
            });
    }

    /// The mark, without the app icon's tile (#273), then "Proton Drive".
    fn render_logo(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.add_space(4.0);
            // The room is kept without the texture too, so the sidebar is laid out the same either way
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(LOGO_SIZE), Sense::hover());
            if let Some(tex) = &self.logo_texture {
                egui::Image::new(tex).paint_at(ui, rect);
            }
            ui.add_space(2.0);
            ui.label(RichText::new("Proton Drive").font(bold(18.5)).color(SIDEBAR_TEXT()));
        });
    }

    /// Open in Files, as wide as the sidebar: the drive's folder in the file manager. Greyed out, saying why, until a
    /// folder is set up.
    fn render_open_in_files(&self, ui: &mut egui::Ui) {
        let folder = &self.status.sync_dir;
        let size = Vec2::new(ui.available_width(), 40.0);
        let open = ui
            .add_enabled_ui(!folder.is_empty(), |ui| {
                action_button_sized(ui, ButtonKind::Primary, Some(icons::FOLDER_OPEN), OPEN_IN_FILES, size)
            })
            .inner
            .on_disabled_hover_text(OPEN_IN_FILES_WAITS);
        if open.clicked() {
            home::open_in_files(Path::new(folder));
        }
    }

    /// Home, Shared and Activity. Home counts what needs the user. Settings is behind the top bar's gear.
    fn render_sections(&mut self, ui: &mut egui::Ui) {
        let count = (!self.attention.is_empty()).then(|| self.attention.len().to_string());
        let sections = [
            (NavTab::Home, icons::HOME, "Home", count),
            (NavTab::Shared, icons::SHARED, "Shared", None),
            (NavTab::Activity, icons::ACTIVITY, "Activity", None),
        ];
        for (tab, icon, label, count) in sections {
            if section_row(ui, icon, label, self.tab == tab, count.as_deref()).clicked() {
                self.open_tab(tab);
            }
        }
    }

    /// At the foot of the sidebar: the storage meter, a thin bar over "used / total", with the version on the right.
    /// Without the account's usage (signed out, connecting, an older daemon), the version alone.
    fn render_storage_meter(&self, ui: &mut egui::Ui) {
        let account = self.status.account.as_ref();
        let storage = home::storage(account);
        let meter_text = storage_meter_text(account);
        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            let weak = |text: &str| RichText::new(text).size(11.5).color(SIDEBAR_WEAK());
            let meter = ui
                .horizontal(|ui| {
                    let meter = meter_text.as_deref().map(|text| ui.label(weak(text)));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(weak(env!("CARGO_PKG_VERSION"))));
                    meter
                })
                .inner;
            if let (Some(storage), Some(meter)) = (storage, meter) {
                ui.add_space(6.0);
                let bar = storage_bar(ui, storage.fraction);
                // How much of it is Drive's
                meter.union(bar).on_hover_text(storage.tooltip);
            }
        });
    }
}

/// One section in the sidebar: its icon and name, filled while it is open or under the pointer, and the count of what
/// needs the user, if any, in red on the right.
fn section_row(ui: &mut egui::Ui, icon: &str, label: &str, open: bool, count: Option<&str>) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), SECTION_HEIGHT), Sense::click());
    let enabled = ui.is_enabled();
    resp.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::SelectableLabel, enabled, open, label));
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let painter = ui.painter();
    let fill = if open {
        SIDEBAR_SELECTED()
    } else if resp.hovered() {
        SIDEBAR_HOVER()
    } else {
        Color32::TRANSPARENT
    };
    painter.rect_filled(rect, CornerRadius::same(8), fill);
    let y = rect.center().y;
    let icon_color = if open { SIDEBAR_TEXT() } else { SIDEBAR_WEAK() };
    let x = rect.left() + SECTION_PADDING;
    painter.text(egui::pos2(x, y), egui::Align2::LEFT_CENTER, icon, icons::font(SECTION_ICON_SIZE), icon_color);
    let x = x + SECTION_ICON_SIZE + SECTION_ICON_GAP;
    // The open section's name is bold, as on drive.proton.me
    let font = if open { bold(13.5) } else { FontId::proportional(13.5) };
    painter.text(egui::pos2(x, y), egui::Align2::LEFT_CENTER, label, font, SIDEBAR_TEXT());
    if let Some(count) = count {
        let galley = painter.layout_no_wrap(count.to_string(), FontId::proportional(11.0), Color32::WHITE);
        let height = galley.size().y + 4.0;
        let size = Vec2::new((galley.size().x + 14.0).max(height), height);
        let pill = egui::Rect::from_center_size(egui::pos2(rect.right() - 10.0 - size.x / 2.0, y), size);
        painter.rect_filled(pill, CornerRadius::same(8), STATUS_DANGER);
        painter.galley(pill.center() - galley.size() / 2.0, galley, Color32::WHITE);
    }
    resp
}

/// The storage meter's bar: its track, filled with what is used (at least a dot, so that a little use still shows).
fn storage_bar(ui: &mut egui::Ui, fraction: f32) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 4.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(2), STORAGE_TRACK());
    if fraction > 0.0 {
        let used = egui::Rect::from_min_size(rect.min, Vec2::new((rect.width() * fraction).max(rect.height()), rect.height()));
        ui.painter().rect_filled(used, CornerRadius::same(2), STORAGE_FILL());
    }
    resp
}
