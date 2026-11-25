//! The window's frame around the sections, as Proton's apps have it (#276):
//! - the sidebar: from the top, the logo, Open in Files, the sections (Settings last), and at its foot the storage
//!   meter and the version;
//! - the top bar over the section: its title and the account, which opens the account menu (#274).

use std::path::Path;

use eframe::egui::{self, Align, Color32, CornerRadius, FontId, Frame, Layout, Margin, RichText, Sense, Stroke, Vec2};

use crate::{
    action_button_on_sidebar, bold, focus_ring, focus_ring_colored, format_bytes, home, icons, settings,
    truncate_middle_to_width, AccountInfo, ButtonKind, NavTab, ProtonDriveNativeApp, WorkerCommand, BG_CANVAS,
    BG_CARD_ALT, BG_SIDEBAR, BORDER_NORM, BORDER_SUBTLE, PROTON_PURPLE, PROTON_PURPLE_SOFT, SIDEBAR_FOCUS,
    SIDEBAR_HOVER, SIDEBAR_SELECTED, SIDEBAR_TEXT, SIDEBAR_WEAK, STATUS_DANGER, STORAGE_FILL, STORAGE_TRACK,
    TEXT_MUTED, TEXT_PRIMARY,
};

/// The button that opens the drive's folder in the file manager: the sidebar's, and Home's drive card's
pub(crate) const OPEN_IN_FILES: &str = "Open in Files";
/// Why Open in Files is greyed out
pub(crate) const OPEN_IN_FILES_WAITS: &str = "Set up a folder in Settings first";

const SIDEBAR_WIDTH: f32 = 252.0;
/// The top bar's height, over the section
pub(crate) const TOP_BAR_HEIGHT: f32 = 56.0;
/// The top bar's room on the left, as the section's, so that the title starts where the cards do
const TOP_BAR_MARGIN_LEFT: i8 = 26;
/// And on the right: the initials end where Home's and Settings' cards do (the section's margin and its scroll bar's
/// gutter, less the account's padding)
const TOP_BAR_MARGIN_RIGHT: i8 = 32;
/// The account's initials, in a bordered square on the top bar's right
const INITIALS_SIZE: f32 = 28.0;
/// The room around the account's lines and initials (its hover fill), and between them
const ACCOUNT_PADDING: f32 = 6.0;
const ACCOUNT_GAP: f32 = 10.0;
/// The most the account's name and email take on the top bar: longer ones are shortened in the middle
const ACCOUNT_TEXT_WIDTH: f32 = 220.0;
const ACCOUNT_MENU_ID: &str = "account_menu";
/// The account menu's rows' width
const ACCOUNT_MENU_WIDTH: f32 = 280.0;
const SIGN_OUT: &str = "Sign out";
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
    let a = account?;
    home::storage(Some(a))?;
    Some(format!("{} / {}", format_bytes(a.used_space), format_bytes(a.max_space)))
}

/// A section's title, as the top bar shows it.
pub(crate) fn tab_title(tab: NavTab) -> &'static str {
    match tab {
        NavTab::Home => "Home",
        NavTab::Shared => "Shared",
        NavTab::Activity => "Activity",
        NavTab::Settings => "Settings",
    }
}

impl ProtonDriveNativeApp {
    /// Whether the confirmation dialog, the Share window or the first-run notice is open: nothing under any of them
    /// takes clicks or keys, and the account menu doesn't stay over them.
    pub(crate) fn dialog_open(&self) -> bool {
        self.pending_confirm.is_some() || self.share.is_some() || self.unofficial_notice_open()
    }

    /// The sidebar, navy in light mode as on drive.proton.me, and dark in dark mode.
    pub(crate) fn render_sidebar(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("proton_sidebar")
            .resizable(false)
            // The edge is egui's separator line, which the theme draws in BORDER_SUBTLE. A stroke on the frame as well
            // made the panel 2 px wider than its 252 px, and that strip, outside what the panel paints, showed the
            // window's black clear colour as a hard line (#254)
            .show_separator_line(true)
            .exact_width(SIDEBAR_WIDTH)
            .frame(Frame::NONE.fill(BG_SIDEBAR()))
            .show(ctx, |ui| {
                // What is greyed out fades into the sidebar's colour, not into the theme's light grey, and the
                // floating scrollbar uses sidebar-contrasting colours rather than the light canvas theme
                {
                    let v = ui.visuals_mut();
                    v.widgets.noninteractive.weak_bg_fill = BG_SIDEBAR();
                    v.extreme_bg_color = BG_SIDEBAR();
                    v.widgets.inactive.fg_stroke.color = SIDEBAR_WEAK();
                    v.widgets.hovered.fg_stroke.color = SIDEBAR_TEXT();
                    v.widgets.active.fg_stroke.color = SIDEBAR_TEXT();
                }
                if self.dialog_open() {
                    ui.disable(); // As in the section: nothing under the confirmation dialog takes clicks while it is open
                }
                // Scroll when the window is too short (high zoom) so the sections never run under the meter (#314);
                // keeping the margin inside the scroll area also leaves room for keyboard focus rings.
                egui::ScrollArea::vertical()
                    .id_salt("sidebar_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        Frame::NONE
                            .inner_margin(Margin { left: 12, right: 12, top: 16, bottom: 14 })
                            .show(ui, |ui| {
                                self.render_logo(ui);
                                ui.add_space(18.0);
                                self.render_open_in_files(ui);
                                ui.add_space(14.0);
                                self.render_sections(ui);
                                self.render_storage_meter(ui);
                            });
                    });
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
                action_button_on_sidebar(ui, ButtonKind::Primary, Some(icons::FOLDER_OPEN), OPEN_IN_FILES, size)
            })
            .inner
            .on_disabled_hover_text(OPEN_IN_FILES_WAITS);
        if open.clicked() {
            home::open_in_files(Path::new(folder));
        }
    }

    /// Home, Shared, Activity and Settings. Home counts what needs the user.
    fn render_sections(&mut self, ui: &mut egui::Ui) {
        let count = (!self.attention.is_empty()).then(|| self.attention.len().to_string());
        let sections = [
            (NavTab::Home, icons::HOME, "Home", count),
            (NavTab::Shared, icons::SHARED, "Shared", None),
            (NavTab::Activity, icons::ACTIVITY, "Activity", None),
            (NavTab::Settings, icons::SETTINGS, "Settings", None),
        ];
        for (tab, icon, label, count) in sections {
            if section_row(ui, icon, label, self.tab == tab, count.as_deref()).clicked() {
                self.open_tab(tab);
            }
        }
    }

    /// At the foot of the sidebar: the storage meter, a thin bar over "used / total", with the version on the right.
    /// Without the account's usage (signed out, connecting, an older daemon), the version alone. When the window is
    /// too short for the sections and the meter together (high zoom), the meter flows under the sections and the
    /// sidebar scrolls to it rather than painting over the last section (#314).
    fn render_storage_meter(&self, ui: &mut egui::Ui) {
        const MIN_METER_GAP: f32 = 12.0;
        let account = self.status.account.as_ref();
        let storage = home::storage(account);
        let meter_text = storage_meter_text(account);
        let text_h = ui
            .fonts(|f| f.row_height(&FontId::proportional(11.5)))
            .max(ui.spacing().interact_size.y);
        let bar_storage = storage.filter(|_| meter_text.is_some());
        let meter_h = if bar_storage.is_some() {
            // Usage bar (4 pt) + item spacing after the bar + 6 pt space + the text row
            4.0 + ui.spacing().item_spacing.y + 6.0 + text_h
        } else {
            text_h
        };
        let weak = |text: &str| RichText::new(text).size(11.5).color(SIDEBAR_WEAK());
        let render_row = |ui: &mut egui::Ui| {
            ui.horizontal(|ui| {
                let meter = meter_text.as_deref().map(|text| ui.label(weak(text)));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(weak(env!("CARGO_PKG_VERSION"))));
                meter
            })
            .inner
        };

        if ui.available_height() >= meter_h + MIN_METER_GAP {
            ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                let meter = render_row(ui);
                if let (Some(storage), Some(meter)) = (bar_storage, meter) {
                    ui.add_space(6.0);
                    let bar = home::usage_bar(ui, storage.fraction, STORAGE_FILL(), STORAGE_TRACK());
                    // How much of it is Drive's
                    meter.union(bar).on_hover_text(storage.tooltip);
                }
            });
        } else {
            ui.add_space(MIN_METER_GAP);
            let bar = bar_storage.as_ref().map(|storage| {
                let bar = home::usage_bar(ui, storage.fraction, STORAGE_FILL(), STORAGE_TRACK());
                ui.add_space(6.0);
                bar
            });
            let meter = render_row(ui);
            if let (Some(storage), Some(bar), Some(meter)) = (bar_storage, bar, meter) {
                // How much of it is Drive's
                meter.union(bar).on_hover_text(storage.tooltip);
            }
        }
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
    focus_ring_colored(ui, &resp, 8.0, SIDEBAR_FOCUS());
    resp
}

/// Who the top bar says is signed in.
struct AccountShown {
    name: String,
    /// Empty when not known
    email: String,
    initials: String,
    /// Whether the account menu opens: signed in, even without the account's details (an older daemon)
    signed_in: bool,
}

/// What the account menu was asked to do
#[derive(Clone, Copy)]
enum AccountAction {
    OpenWeb,
    SignOut,
}

impl ProtonDriveNativeApp {
    /// The top bar over the section: its title on the left; on the right, the account, which opens the account
    /// menu.
    pub(crate) fn render_top_bar(&mut self, ctx: &egui::Context) {
        // Nothing under the confirmation dialog or the Share window takes clicks, and the menu doesn't stay over them
        let dialog = self.dialog_open();
        if dialog {
            self.account_menu_open = false;
        }
        let account = egui::TopBottomPanel::top("top_bar")
            .exact_height(TOP_BAR_HEIGHT)
            // The bottom edge is egui's separator line, in BORDER_SUBTLE as the sidebar's
            .show_separator_line(true)
            .frame(Frame::NONE.fill(BG_CANVAS()).inner_margin(Margin {
                left: TOP_BAR_MARGIN_LEFT,
                right: TOP_BAR_MARGIN_RIGHT,
                top: 0,
                bottom: 0,
            }))
            .show(ctx, |ui| {
                if dialog {
                    ui.disable();
                }
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    ui.label(RichText::new(tab_title(self.tab)).font(bold(17.0)).color(TEXT_PRIMARY()));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        // The name and email take what the title and the initials leave, up to 220 pt. The second
                        // `ACCOUNT_GAP` is the least room kept between the title and the account
                        let fixed = INITIALS_SIZE + 2.0 * ACCOUNT_PADDING + 2.0 * ACCOUNT_GAP;
                        let room = (ui.available_width() - fixed).clamp(0.0, ACCOUNT_TEXT_WIDTH);
                        self.account_block(ui, room).clicked()
                    })
                    .inner
                })
                .inner
            })
            .inner;
        self.render_account_menu(ctx);
        // Shown from the next frame: in this one, the click that opened it would count as a click outside it
        if account {
            self.account_menu_open = !self.account_menu_open;
            ctx.request_repaint();
        }
    }

    /// Who the top bar shows: the account, or that it isn't known yet, or that no one is signed in.
    fn account_shown(&self) -> AccountShown {
        let unknown = |name: &str, signed_in| AccountShown {
            name: name.to_string(),
            email: String::new(),
            initials: "PD".to_string(),
            signed_in,
        };
        match &self.status.account {
            Some(a) => AccountShown {
                name: if a.display_name.is_empty() { "Proton Account".to_string() } else { a.display_name.clone() },
                email: a.email.clone(),
                initials: if a.initials.is_empty() { "PD".to_string() } else { a.initials.clone() },
                signed_in: true,
            },
            None if self.status.logged_in => unknown("Proton Account", true),
            None if self.initial_connecting => unknown("Connecting…", false),
            None => unknown("Not signed in", false),
        }
    }

    /// The account on the top bar's right: the name over the email, each shortened to `room`, then the initials in a
    /// bordered square, as Proton's top bar has it. Signed in, it is one button, named Account, for the account menu;
    /// otherwise it only says who isn't signed in.
    fn account_block(&self, ui: &mut egui::Ui, room: f32) -> egui::Response {
        let shown = self.account_shown();
        let painter = ui.painter().clone();
        let line = |text: &str, size: f32, color| {
            let font = FontId::proportional(size);
            painter.layout_no_wrap(truncate_middle_to_width(&painter, text, &font, room), font, color)
        };
        let name = line(&shown.name, 13.0, TEXT_PRIMARY());
        let email = (!shown.email.is_empty()).then(|| line(&shown.email, 11.5, TEXT_MUTED()));
        let text_width = name.size().x.max(email.as_ref().map_or(0.0, |e| e.size().x));
        let size = Vec2::new(text_width + ACCOUNT_GAP + INITIALS_SIZE, INITIALS_SIZE) + Vec2::splat(2.0 * ACCOUNT_PADDING);
        let (rect, resp) = ui.allocate_exact_size(size, if shown.signed_in { Sense::click() } else { Sense::hover() });
        let enabled = ui.is_enabled();
        if shown.signed_in {
            let open = self.account_menu_open;
            resp.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Button, enabled, open, "Account"));
            if resp.hovered() {
                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
            }
            // Under the pointer, and while its menu is open
            if resp.hovered() || self.account_menu_open {
                painter.rect_filled(rect, CornerRadius::same(8), BG_CARD_ALT());
            }
        } else {
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, &shown.name));
        }
        let initials = egui::Rect::from_center_size(
            egui::pos2(rect.right() - ACCOUNT_PADDING - INITIALS_SIZE / 2.0, rect.center().y),
            Vec2::splat(INITIALS_SIZE),
        );
        painter.rect_stroke(initials, CornerRadius::same(6), Stroke::new(1.0_f32, BORDER_NORM()), egui::StrokeKind::Inside);
        let initials_font = FontId::proportional(11.5);
        painter.text(initials.center(), egui::Align2::CENTER_CENTER, &shown.initials, initials_font, TEXT_PRIMARY());
        // Both lines end at the initials, as in Proton's top bar
        let right = initials.left() - ACCOUNT_GAP;
        let height = name.size().y + email.as_ref().map_or(0.0, |e| e.size().y);
        let top = rect.center().y - height / 2.0;
        let below = top + name.size().y;
        painter.galley(egui::pos2(right - name.size().x, top), name, TEXT_PRIMARY());
        if let Some(email) = email {
            painter.galley(egui::pos2(right - email.size().x, below), email, TEXT_MUTED());
        }
        if shown.signed_in {
            focus_ring(ui, &resp, 8.0);
        }
        resp
    }

    /// The account menu, under the account on the right, over an invisible shield so that a click outside only closes
    /// it (as Home's Pause choices). It shows who is signed in, with the plan and the storage used, and offers Proton
    /// Drive on the web and Sign out. Either one, Escape or a click outside closes it.
    fn render_account_menu(&mut self, ctx: &egui::Context) {
        let shown = self.account_shown();
        // Only while signed in (a status saying no one is closes it, see process_worker_events); `--account-menu` opens
        // it before the first status
        if !self.account_menu_open || !shown.signed_in {
            return;
        }
        crate::click_shield(ctx, "account_menu_shield", egui::Order::Foreground, None);
        let screen = ctx.screen_rect();
        let frame = home::menu_frame();
        let frame_margin = frame.total_margin();
        const MENU_EDGE_GAP: f32 = 8.0;
        let top = screen.top() + TOP_BAR_HEIGHT + 4.0;
        let max_menu_height = (screen.bottom() - top - MENU_EDGE_GAP - frame_margin.sum().y).max(40.0);
        // Line up the menu's right edge with the account button when there is room; at high zoom clamp the right
        // margin and width so the framed card stays inside the viewport (#365).
        let right_margin = f32::from(TOP_BAR_MARGIN_RIGHT).min(
            (screen.width() - ACCOUNT_MENU_WIDTH - frame_margin.sum().x - MENU_EDGE_GAP).max(MENU_EDGE_GAP),
        );
        let anchor = egui::pos2(screen.right() - right_margin, top);
        let menu_width = ACCOUNT_MENU_WIDTH.min(
            (anchor.x - screen.left() - MENU_EDGE_GAP - frame_margin.sum().x).max(120.0),
        );
        let account = self.status.account.clone();
        let mut picked = None;
        // Above its shield, in the order above it, as Pause's choices are: the shield moves to the top of its own order
        // when pressed, which would bury a menu in that order under it
        egui::Area::new(egui::Id::new(ACCOUNT_MENU_ID))
            .order(egui::Order::Tooltip)
            .fixed_pos(anchor)
            .pivot(egui::Align2::RIGHT_TOP)
            .show(ctx, |ui| {
                frame.show(ui, |ui| {
                    ui.set_width(menu_width);
                    egui::ScrollArea::vertical()
                        .id_salt("account_menu_scroll")
                        .max_width(menu_width)
                        .max_height(max_menu_height)
                        // As high as it may be at once, not only as high as last frame's Area was: auto_shrink still
                        // shrinks it to what it holds, so zooming back out or loading storage expands cleanly (#365).
                        .min_scrolled_height(max_menu_height)
                        .auto_shrink([false, true])
                        .show(ui, |ui| {
                            ui.set_width(menu_width);
                            ui.spacing_mut().item_spacing.y = 2.0;
                            Frame::NONE.inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
                                account_menu_header(ui, &shown, account.as_ref());
                                if let Some(storage) = home::storage(account.as_ref()) {
                                    ui.add_space(12.0);
                                    account_menu_storage(ui, &storage);
                                }
                            });
                            ui.separator();
                            if home::menu_item(ui, Some(icons::WEB), home::OPEN_WEB, menu_width).clicked() {
                                picked = Some(AccountAction::OpenWeb);
                            }
                            if home::menu_item(ui, Some(icons::SIGN_OUT), SIGN_OUT, menu_width).clicked() {
                                picked = Some(AccountAction::SignOut);
                            }
                        });
                });
            });
        // Read before ctx.input: egui's context lock isn't re-entrant
        let menu = ctx.memory(|m| m.area_rect(egui::Id::new(ACCOUNT_MENU_ID)));
        let outside = ctx.input(|i| {
            let on_menu = matches!((menu, i.pointer.interact_pos()), (Some(menu), Some(at)) if menu.contains(at));
            i.key_pressed(egui::Key::Escape) || (i.pointer.any_click() && !on_menu)
        });
        match picked {
            Some(AccountAction::OpenWeb) => home::open_in_browser(home::PROTON_DRIVE_WEB_URL),
            // At once, as Settings' Sign out
            Some(AccountAction::SignOut) => self.send_account_command(WorkerCommand::Logout),
            None => {}
        }
        if picked.is_some() || outside {
            self.account_menu_open = false;
        }
    }
}

/// The account menu's top: the initials, then the name over the email, and the plan, as Settings' Account card shows
/// them. The plan has a line of its own, so that the name keeps the menu's width.
fn account_menu_header(ui: &mut egui::Ui, shown: &AccountShown, account: Option<&AccountInfo>) {
    ui.horizontal(|ui| {
        let (avatar, _) = ui.allocate_exact_size(Vec2::splat(36.0), Sense::hover());
        ui.painter().rect_filled(avatar, CornerRadius::same(8), PROTON_PURPLE_SOFT());
        let font = FontId::proportional(13.5);
        ui.painter().text(avatar.center(), egui::Align2::CENTER_CENTER, &shown.initials, font, TEXT_PRIMARY());
        ui.add_space(4.0);
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            let room = ui.available_width();
            let name = truncate_middle_to_width(ui.painter(), &shown.name, &bold(13.5), room);
            ui.label(RichText::new(name).font(bold(13.5)).color(TEXT_PRIMARY())).on_hover_text(&shown.name);
            if !shown.email.is_empty() {
                let font = FontId::proportional(12.0);
                let email = truncate_middle_to_width(ui.painter(), &shown.email, &font, room);
                ui.label(RichText::new(email).font(font).color(TEXT_MUTED())).on_hover_text(&shown.email);
            }
            if let Some(a) = account.filter(|a| a.max_space > 0) {
                ui.add_space(2.0);
                ui.horizontal(|ui| settings::plan_pill(ui, settings::plan_name(a.max_space)));
            }
        });
    });
}

/// The account menu's storage: "Proton storage", what is used of the quota, and a bar of it.
fn account_menu_storage(ui: &mut egui::Ui, storage: &home::Storage) {
    let font = FontId::proportional(12.5);
    let heading_w = crate::text_width(ui.painter(), "Proton storage", &font);
    let text_w = crate::text_width(ui.painter(), &storage.text, &font);
    let row = if heading_w + 8.0 + text_w <= ui.available_width() {
        ui.horizontal(|ui| {
            ui.label(RichText::new("Proton storage").size(12.5).color(TEXT_PRIMARY()));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(&storage.text).size(12.5).color(TEXT_MUTED()));
            });
        })
        .response
    } else {
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            ui.label(RichText::new("Proton storage").size(12.5).color(TEXT_PRIMARY()));
            ui.label(RichText::new(&storage.text).size(12.5).color(TEXT_MUTED()));
        })
        .response
    };
    ui.add_space(6.0);
    let bar = home::usage_bar(ui, storage.fraction, PROTON_PURPLE, BORDER_SUBTLE());
    // How much of it is Drive's
    row.union(bar).on_hover_text(&storage.tooltip);
}
