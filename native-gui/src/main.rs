use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Align, Color32, CornerRadius, FontFamily, FontId, Frame, IconData, Key, Layout, Margin,
    RichText, ScrollArea, Sense, Stroke, TextureHandle, TextureOptions, Vec2, ViewportCommand,
};
use serde::{Deserialize, Serialize};

const DAEMON_URL: &str = "http://127.0.0.1:49152";

// Official Proton Carbon Dark Palette (matching Proton Mail & Proton Drive Desktop)
const BG_CANVAS: Color32 = Color32::from_rgb(26, 24, 35); // #1A1823
const BG_SIDEBAR: Color32 = Color32::from_rgb(20, 18, 27); // #14121B
const BG_CARD: Color32 = Color32::from_rgb(33, 29, 44); // #211D2C
const BG_CARD_ALT: Color32 = Color32::from_rgb(42, 37, 56); // #2A2538
const BG_INPUT: Color32 = Color32::from_rgb(35, 31, 48); // #231F30
const BORDER_SUBTLE: Color32 = Color32::from_rgb(48, 43, 64); // #302B40
const TEXT_PRIMARY: Color32 = Color32::from_rgb(247, 246, 252);
const TEXT_MUTED: Color32 = Color32::from_rgb(162, 158, 178);
const PROTON_PURPLE: Color32 = Color32::from_rgb(109, 74, 255); // #6D4AFF
const PROTON_PURPLE_HOVER: Color32 = Color32::from_rgb(126, 94, 255); // #7E5EFF
const PROTON_PURPLE_SOFT: Color32 = Color32::from_rgb(44, 37, 69); // #2C2545 Active nav pill
const PROTON_PURPLE_TEXT: Color32 = Color32::from_rgb(214, 204, 255);
const STATUS_SUCCESS: Color32 = Color32::from_rgb(30, 168, 133); // #1EA885
const STATUS_WARNING: Color32 = Color32::from_rgb(255, 153, 0); // #FF9900
const STATUS_DANGER: Color32 = Color32::from_rgb(220, 50, 81); // #DC3251

#[derive(Clone, Copy, PartialEq, Eq)]
enum NavTab {
    Overview,
    CloudBrowser,
    SelectiveSync,
    Conflicts,
    Settings,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryStats {
    total_files: u64,
    total_folders: u64,
    total_bytes: u64,
    unresolved_conflicts: u64,
    #[allow(dead_code)]
    error_items: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSettings {
    sync_dir: String,
    conflict_strategy: String,
    notifications_enabled: bool,
    reconcile_interval_sec: u64,
    paused: bool,
    excluded_folders: Vec<String>,
    ignore_patterns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTransfer {
    #[allow(dead_code)]
    id: String,
    direction: String,
    rel_path: String,
    bytes_transferred: u64,
    total_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AccountInfo {
    #[allow(dead_code)]
    name: String,
    display_name: String,
    email: String,
    initials: String,
    used_space: u64,
    max_space: u64,
    used_drive_space: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    state: String,
    current_action: Option<String>,
    logged_in: bool,
    sync_dir: String,
    active_transfers: Vec<ActiveTransfer>,
    stats: SummaryStats,
    settings: SyncSettings,
    #[serde(default)]
    account: Option<AccountInfo>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRecord {
    #[allow(dead_code)]
    timestamp: u64,
    action: String,
    local_rel_path: String,
    details: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteItem {
    #[allow(dead_code)]
    uid: String,
    name: String,
    #[serde(rename = "type")]
    item_type: String,
    size: u64,
    #[allow(dead_code)]
    modification_time: String,
}

#[derive(Clone, Debug, Deserialize)]
struct RemoteListResponse {
    path: String,
    items: Vec<RemoteItem>,
}

#[derive(Clone, Debug, Deserialize)]
struct SelectiveFolder {
    name: String,
    #[allow(dead_code)]
    uid: String,
    excluded: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct SelectiveFoldersResponse {
    folders: Vec<SelectiveFolder>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictRecord {
    id: u64,
    local_rel_path: String,
    #[allow(dead_code)]
    detected_at: u64,
    resolved: u8,
    resolution: Option<String>,
}

enum WorkerCommand {
    RefreshAll,
    TriggerSync,
    SetPaused(bool),
    StartLogin,
    Logout,
    LoadRemotePath(String),
    CreateRemoteFolder { parent_path: String, name: String },
    LoadSelectiveFolders,
    SaveSettings(serde_json::Value),
    LoadConflicts,
    ResolveConflict { id: u64, choice: String },
}

enum WorkerEvent {
    StatusAndActivity {
        status: Result<DaemonStatus, String>,
        activity: Vec<ActivityRecord>,
    },
    LoginStarted(String),
    RemoteLoaded(Result<RemoteListResponse, String>),
    SelectiveLoaded(Vec<SelectiveFolder>),
    ConflictsLoaded(Vec<ConflictRecord>),
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WindowGeometry {
    position: Option<[f32; 2]>,
    width: f32,
    height: f32,
    maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            position: None,
            width: 1280.0,
            height: 820.0,
            maximized: true,
        }
    }
}

fn ui_prefs_path() -> Option<std::path::PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return Some(std::path::PathBuf::from(xdg).join("protondrive/ui.json"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".config/protondrive/ui.json"))
}

fn load_window_geometry() -> WindowGeometry {
    if let Some(p) = ui_prefs_path() {
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(mut g) = serde_json::from_slice::<WindowGeometry>(&bytes) {
                g.width = g.width.clamp(840.0, 16384.0);
                g.height = g.height.clamp(540.0, 16384.0);
                return g;
            }
        }
    }
    WindowGeometry::default()
}

fn save_window_geometry(geom: &WindowGeometry) {
    let Some(p) = ui_prefs_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(geom) {
        let tmp = p.with_file_name(format!(".ui.json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, &p)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

struct ProtonDriveNativeApp {
    tab: NavTab,
    tx: Sender<WorkerCommand>,
    rx: Receiver<WorkerEvent>,
    logo_texture: Option<TextureHandle>,

    daemon_online: bool,
    status: DaemonStatus,
    activities: Vec<ActivityRecord>,
    login_url: Option<String>,
    search_query: String,
    show_account_menu: bool,

    // Cloud Browser state
    remote_path: String,
    remote_items: Vec<RemoteItem>,
    remote_loading: bool,
    remote_error: Option<String>,
    new_folder_name: String,
    show_new_folder_modal: bool,

    // Selective sync state
    selective_folders: Vec<SelectiveFolder>,
    selective_filter: String,
    ignore_patterns_text: String,
    settings_dirty: bool,

    // Conflicts state
    conflicts: Vec<ConflictRecord>,

    // Settings edits
    edit_sync_dir: String,
    edit_conflict_strategy: String,
    edit_notifications: bool,

    // Window geometry state
    window_geometry: WindowGeometry,
    maximize_applied_on_open: bool,

    // Automatic screenshot support for visual verification
    screenshot_target: Option<String>,
    frames_rendered: u32,
    screenshot_requested: bool,
    last_poll: Instant,
}

impl ProtonDriveNativeApp {
    fn new(
        cc: &eframe::CreationContext<'_>,
        screenshot_target: Option<String>,
        initial_tab: NavTab,
        initial_account_menu: bool,
        window_geometry: WindowGeometry,
    ) -> Self {
        configure_proton_theme(&cc.egui_ctx);

        let logo_texture = load_glyph_texture(&cc.egui_ctx);

        let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCommand>();
        let (evt_tx, evt_rx) = mpsc::channel::<WorkerEvent>();
        let egui_ctx = cc.egui_ctx.clone();

        thread::spawn(move || {
            worker_loop(cmd_rx, evt_tx, egui_ctx);
        });

        let _ = cmd_tx.send(WorkerCommand::RefreshAll);
        if initial_tab == NavTab::SelectiveSync {
            let _ = cmd_tx.send(WorkerCommand::LoadSelectiveFolders);
        } else if initial_tab == NavTab::CloudBrowser {
            let _ = cmd_tx.send(WorkerCommand::LoadRemotePath("/my-files".to_string()));
        } else if initial_tab == NavTab::Conflicts {
            let _ = cmd_tx.send(WorkerCommand::LoadConflicts);
        }

        Self {
            tab: initial_tab,
            tx: cmd_tx,
            rx: evt_rx,
            logo_texture,
            daemon_online: false,
            status: DaemonStatus::default(),
            activities: Vec::new(),
            login_url: None,
            search_query: String::new(),
            show_account_menu: initial_account_menu,
            remote_path: "/my-files".to_string(),
            remote_items: Vec::new(),
            remote_loading: false,
            remote_error: None,
            new_folder_name: String::new(),
            show_new_folder_modal: false,
            selective_folders: Vec::new(),
            selective_filter: String::new(),
            ignore_patterns_text: String::new(),
            settings_dirty: false,
            conflicts: Vec::new(),
            edit_sync_dir: String::new(),
            edit_conflict_strategy: "keep-both".to_string(),
            edit_notifications: true,
            window_geometry,
            maximize_applied_on_open: false,
            screenshot_target,
            frames_rendered: 0,
            screenshot_requested: false,
            last_poll: Instant::now(),
        }
    }

    fn process_worker_events(&mut self) {
        while let Ok(evt) = self.rx.try_recv() {
            match evt {
                WorkerEvent::StatusAndActivity { status, activity } => match status {
                    Ok(s) => {
                        self.daemon_online = true;
                        if !self.settings_dirty {
                            self.edit_sync_dir = s.settings.sync_dir.clone();
                            self.edit_conflict_strategy = s.settings.conflict_strategy.clone();
                            self.edit_notifications = s.settings.notifications_enabled;
                            self.ignore_patterns_text = s.settings.ignore_patterns.join("\n");
                        }
                        if s.logged_in {
                            self.login_url = None;
                        }
                        self.status = s;
                        self.activities = activity;
                    }
                    Err(_) => {
                        self.daemon_online = false;
                    }
                },
                WorkerEvent::LoginStarted(url) => {
                    if !url.is_empty() {
                        self.login_url = Some(url);
                    }
                }
                WorkerEvent::RemoteLoaded(res) => {
                    self.remote_loading = false;
                    match res {
                        Ok(list) => {
                            self.remote_path = list.path;
                            self.remote_items = list.items;
                            self.remote_error = None;
                        }
                        Err(e) => {
                            self.remote_error = Some(e);
                        }
                    }
                }
                WorkerEvent::SelectiveLoaded(folders) => {
                    self.selective_folders = folders;
                }
                WorkerEvent::ConflictsLoaded(conflicts) => {
                    self.conflicts = conflicts;
                }
            }
        }
    }

    fn render_sidebar(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("proton_sidebar")
            .resizable(false)
            .exact_width(252.0)
            .frame(
                Frame::NONE
                    .fill(BG_SIDEBAR)
                    .inner_margin(Margin::symmetric(16, 18))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE)),
            )
            .show(ctx, |ui| {
                // Brand Header (matching official Proton desktop header)
                ui.horizontal(|ui| {
                    if let Some(tex) = &self.logo_texture {
                        ui.add(
                            egui::Image::new(tex)
                                .fit_to_exact_size(Vec2::new(30.0, 30.0))
                                .corner_radius(CornerRadius::same(7)),
                        );
                    }
                    ui.add_space(6.0);
                    ui.label(
                        RichText::new("Proton Drive")
                            .size(18.5)
                            .strong()
                            .color(TEXT_PRIMARY),
                    );
                });

                ui.add_space(18.0);

                // Primary CTA button (Proton Purple #6d4aff — perfectly centered text, no border stroke, matching Proton Mail)
                let sync_label = if self.status.state == "syncing" {
                    "Syncing..."
                } else {
                    "Sync now"
                };
                if proton_button(
                    ui,
                    Vec2::new(ui.available_width(), 38.0),
                    sync_label,
                    PROTON_PURPLE,
                    PROTON_PURPLE_HOVER,
                    None,
                    Color32::WHITE,
                    14.0,
                )
                .clicked()
                {
                    let _ = self.tx.send(WorkerCommand::TriggerSync);
                }

                ui.add_space(16.0);

                // Navigation Links with crisp vector icons
                let selective_badge = if !self.selective_folders.is_empty() {
                    let inc = self
                        .selective_folders
                        .iter()
                        .filter(|f| !f.excluded)
                        .count();
                    Some(format!("{inc}/{}", self.selective_folders.len()))
                } else {
                    None
                };
                let conflict_badge = if self.status.stats.unresolved_conflicts > 0 {
                    Some(self.status.stats.unresolved_conflicts.to_string())
                } else {
                    None
                };

                let nav_items: [(NavTab, &str, Option<String>, bool); 5] = [
                    (NavTab::Overview, "My Files & Activity", None, false),
                    (NavTab::CloudBrowser, "Cloud Browser", None, false),
                    (NavTab::SelectiveSync, "Selective Sync", selective_badge, false),
                    (NavTab::Conflicts, "Conflicts", conflict_badge, true),
                    (NavTab::Settings, "Settings", None, false),
                ];

                for (tab, label, badge, is_danger_badge) in nav_items {
                    let active = self.tab == tab;
                    let fill = if active {
                        PROTON_PURPLE_SOFT
                    } else {
                        Color32::TRANSPARENT
                    };
                    let text_color = if active {
                        TEXT_PRIMARY
                    } else {
                        TEXT_MUTED
                    };
                    let icon_color = if active {
                        PROTON_PURPLE_TEXT
                    } else {
                        TEXT_MUTED
                    };

                    let response = Frame::NONE
                        .fill(fill)
                        .corner_radius(CornerRadius::same(8))
                        .inner_margin(Margin::symmetric(12, 9))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.horizontal(|ui| {
                                let (icon_rect, _) =
                                    ui.allocate_exact_size(Vec2::new(16.0, 16.0), Sense::hover());
                                draw_nav_icon(ui.painter(), icon_rect, tab, icon_color);
                                ui.add_space(6.0);

                                let text = if active {
                                    RichText::new(label).size(13.5).strong().color(text_color)
                                } else {
                                    RichText::new(label).size(13.5).color(text_color)
                                };
                                ui.label(text);

                                if let Some(b_text) = badge {
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        let badge_fill = if is_danger_badge {
                                            STATUS_DANGER
                                        } else {
                                            BG_CARD_ALT
                                        };
                                        let badge_fg = if is_danger_badge {
                                            Color32::WHITE
                                        } else {
                                            TEXT_MUTED
                                        };
                                        Frame::NONE
                                            .fill(badge_fill)
                                            .corner_radius(CornerRadius::same(8))
                                            .inner_margin(Margin::symmetric(7, 2))
                                            .show(ui, |ui| {
                                                ui.label(
                                                    RichText::new(b_text)
                                                        .size(11.0)
                                                        .strong()
                                                        .color(badge_fg),
                                                );
                                            });
                                    });
                                }
                            });
                        })
                        .response
                        .interact(Sense::click());

                    if response.hovered() {
                        ctx.set_cursor_icon(egui::CursorIcon::PointingHand);
                    }
                    if response.clicked() {
                        self.tab = tab;
                        match tab {
                            NavTab::CloudBrowser => {
                                self.remote_loading = true;
                                let _ = self
                                    .tx
                                    .send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
                            }
                            NavTab::SelectiveSync => {
                                let _ = self.tx.send(WorkerCommand::LoadSelectiveFolders);
                            }
                            NavTab::Conflicts => {
                                let _ = self.tx.send(WorkerCommand::LoadConflicts);
                            }
                            _ => {}
                        }
                    }
                    ui.add_space(3.0);
                }

                // Push footer to the bottom of the sidebar (matching Proton Mail storage bar)
                let footer_height = 114.0;
                let remaining_h = (ui.available_height() - footer_height).max(12.0);
                ui.add_space(remaining_h);

                // Quick Open sync folder button (centered text, reflects configured sync_dir)
                let short_sync_folder = {
                    let raw = if self.status.sync_dir.is_empty() {
                        "~/ProtonDrive".to_string()
                    } else if let Ok(home) = std::env::var("HOME") {
                        if let Some(rest) = self.status.sync_dir.strip_prefix(&home) {
                            format!("~{rest}")
                        } else {
                            self.status.sync_dir.clone()
                        }
                    } else {
                        self.status.sync_dir.clone()
                    };
                    truncate_middle(&raw, 20)
                };
                if proton_button(
                    ui,
                    Vec2::new(ui.available_width(), 34.0),
                    &format!("Open {short_sync_folder} folder"),
                    BG_CARD,
                    BG_CARD_ALT,
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                    TEXT_PRIMARY,
                    12.5,
                )
                .clicked()
                {
                    let folder = if self.status.sync_dir.is_empty() {
                        "~/ProtonDrive"
                    } else {
                        &self.status.sync_dir
                    };
                    let _ = Command::new("xdg-open").arg(folder).spawn();
                }

                ui.add_space(14.0);

                // Official Proton Bottom-Left Storage Quota Meter + App Version
                let (used_bytes, max_bytes) = if let Some(acct) = &self.status.account {
                    if acct.max_space > 0 {
                        (acct.used_space, acct.max_space)
                    } else {
                        (self.status.stats.total_bytes, 0)
                    }
                } else {
                    (self.status.stats.total_bytes, 0)
                };

                let ratio = if max_bytes > 0 {
                    (used_bytes as f32 / max_bytes as f32).clamp(0.015, 1.0)
                } else {
                    0.12
                };

                // Thin 4px progress bar matching Proton Mail
                let bar_w = ui.available_width();
                let (bar_rect, _) = ui.allocate_exact_size(Vec2::new(bar_w, 4.0), Sense::hover());
                ui.painter().rect_filled(
                    bar_rect,
                    CornerRadius::same(2),
                    Color32::from_rgb(46, 41, 62),
                );
                let mut fill_rect = bar_rect;
                fill_rect.set_width((bar_w * ratio).max(4.0));
                let bar_color = if ratio > 0.90 {
                    STATUS_DANGER
                } else if ratio > 0.75 {
                    STATUS_WARNING
                } else {
                    STATUS_SUCCESS
                };
                ui.painter()
                    .rect_filled(fill_rect, CornerRadius::same(2), bar_color);

                ui.add_space(7.0);

                ui.horizontal(|ui| {
                    let quota_label = if max_bytes > 0 {
                        format!(
                            "{} / {}",
                            format_bytes_precise(used_bytes),
                            format_bytes_precise(max_bytes)
                        )
                    } else {
                        format!("{} synced", format_bytes_precise(used_bytes))
                    };
                    ui.label(
                        RichText::new(quota_label)
                            .size(11.5)
                            .strong()
                            .color(TEXT_PRIMARY),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new(env!("CARGO_PKG_VERSION"))
                                .size(11.5)
                                .color(TEXT_MUTED),
                        );
                    });
                });

                ui.add_space(2.0);
                ui.label(
                    RichText::new(format!(
                        "Local folder: {} ({} files)",
                        format_bytes(self.status.stats.total_bytes),
                        self.status.stats.total_files
                    ))
                    .size(11.0)
                    .color(TEXT_MUTED),
                );
            });
    }

    fn render_top_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            // Search / filter input on the left (matching Proton Mail top bar)
            Frame::NONE
                .fill(BG_INPUT)
                .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                .corner_radius(CornerRadius::same(8))
                .inner_margin(Margin::symmetric(12, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (s_rect, _) =
                            ui.allocate_exact_size(Vec2::new(14.0, 14.0), Sense::hover());
                        draw_search_icon(ui.painter(), s_rect, TEXT_MUTED);
                        ui.add_space(4.0);
                        ui.add(
                            egui::TextEdit::singleline(&mut self.search_query)
                                .hint_text("Search files and sync activity")
                                .frame(false)
                                .desired_width(280.0),
                        );
                        if !self.search_query.is_empty()
                            && ui
                                .add(
                                    egui::Button::new(
                                        RichText::new("×").size(14.0).color(TEXT_MUTED),
                                    )
                                    .frame(false),
                                )
                                .clicked()
                        {
                            self.search_query.clear();
                        }
                    });
                });

            // Right side: Proton User Profile (Name + Email + Initials Avatar) + Settings Gear + Sync Status
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let (display_name, email, initials) = if let Some(acct) = &self.status.account {
                    (
                        if acct.display_name.is_empty() {
                            "Proton Account".to_string()
                        } else {
                            acct.display_name.clone()
                        },
                        acct.email.clone(),
                        if acct.initials.is_empty() {
                            "PD".to_string()
                        } else {
                            acct.initials.clone()
                        },
                    )
                } else if self.status.logged_in {
                    (
                        "Proton Account".to_string(),
                        "Connected".to_string(),
                        "PD".to_string(),
                    )
                } else {
                    (
                        "Not Signed In".to_string(),
                        "Click Sign In below".to_string(),
                        "PD".to_string(),
                    )
                };

                // Initials Avatar Badge (34x34 rounded square matching Proton Mail's "GC" badge)
                let (avatar_rect, avatar_resp) =
                    ui.allocate_exact_size(Vec2::new(34.0, 34.0), Sense::click());
                let avatar_fill = if self.show_account_menu || avatar_resp.hovered() {
                    Color32::from_rgb(66, 53, 108)
                } else {
                    Color32::from_rgb(50, 41, 82)
                };
                ui.painter().rect_filled(
                    avatar_rect,
                    CornerRadius::same(8),
                    avatar_fill,
                );
                ui.painter().rect_stroke(
                    avatar_rect,
                    CornerRadius::same(8),
                    Stroke::new(
                        1.0_f32,
                        if self.show_account_menu {
                            PROTON_PURPLE
                        } else {
                            Color32::from_rgb(92, 74, 156)
                        },
                    ),
                    egui::StrokeKind::Inside,
                );
                ui.painter().text(
                    avatar_rect.center(),
                    egui::Align2::CENTER_CENTER,
                    &initials,
                    FontId::new(13.0, FontFamily::Proportional),
                    TEXT_PRIMARY,
                );
                if avatar_resp.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                if avatar_resp.clicked() {
                    self.show_account_menu = !self.show_account_menu;
                }

                ui.add_space(8.0);

                // Stacked Display Name + Email (right-aligned next to avatar, clickable to open account menu)
                let name_resp = ui
                    .allocate_ui_with_layout(
                        Vec2::new(195.0, 34.0),
                        Layout::top_down(Align::Max),
                        |ui| {
                            ui.label(
                                RichText::new(&display_name)
                                    .size(13.0)
                                    .strong()
                                    .color(TEXT_PRIMARY),
                            );
                            ui.label(RichText::new(&email).size(11.5).color(TEXT_MUTED));
                        },
                    )
                    .response
                    .interact(Sense::click());
                if name_resp.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                if name_resp.clicked() {
                    self.show_account_menu = !self.show_account_menu;
                }

                ui.add_space(10.0);

                // Subtle vertical divider
                let (div_rect, _) = ui.allocate_exact_size(Vec2::new(1.0, 24.0), Sense::hover());
                ui.painter().rect_filled(div_rect, 0, BORDER_SUBTLE);

                ui.add_space(10.0);

                // Settings Icon Button
                let (gear_rect, gear_resp) =
                    ui.allocate_exact_size(Vec2::new(32.0, 32.0), Sense::click());
                if gear_resp.hovered() || self.tab == NavTab::Settings {
                    ui.painter().rect_filled(
                        gear_rect,
                        CornerRadius::same(8),
                        BG_CARD_ALT,
                    );
                }
                draw_gear_icon(ui.painter(), gear_rect.shrink(8.0), TEXT_MUTED);
                if gear_resp.on_hover_text("Synchronization Settings").clicked() {
                    self.tab = NavTab::Settings;
                }

                ui.add_space(6.0);

                // Pause / Resume Button (centered text)
                let paused = self.status.settings.paused;
                let pause_label = if paused { "Resume" } else { "Pause" };
                if proton_button(
                    ui,
                    Vec2::new(76.0, 30.0),
                    pause_label,
                    BG_CARD,
                    BG_CARD_ALT,
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                    TEXT_PRIMARY,
                    12.5,
                )
                .clicked()
                {
                    let _ = self.tx.send(WorkerCommand::SetPaused(!paused));
                }

                ui.add_space(6.0);

                // Status Pill
                let (dot_color, status_text) = if !self.daemon_online {
                    (STATUS_DANGER, "Daemon Offline".to_string())
                } else if !self.status.logged_in {
                    (STATUS_WARNING, "Sign in required".to_string())
                } else if self.status.settings.paused {
                    (STATUS_WARNING, "Paused".to_string())
                } else if self.status.state == "syncing" {
                    let act = self
                        .status
                        .current_action
                        .as_deref()
                        .unwrap_or("Syncing...");
                    (PROTON_PURPLE_HOVER, truncate_middle(act, 36))
                } else if self.status.state == "error" {
                    (STATUS_DANGER, "Sync Error".to_string())
                } else {
                    (STATUS_SUCCESS, "Up to date".to_string())
                };

                Frame::NONE
                    .fill(BG_CARD)
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(12, 6))
                    .show(ui, |ui| {
                        ui.label(RichText::new(status_text).size(12.0).color(TEXT_PRIMARY));
                        ui.add_space(4.0);
                        let (rect, _) =
                            ui.allocate_exact_size(Vec2::new(8.0, 8.0), Sense::hover());
                        ui.painter().circle_filled(rect.center(), 4.0, dot_color);
                    });
            });
        });
    }

    fn render_account_popover(&mut self, ctx: &egui::Context) {
        if !self.show_account_menu {
            return;
        }

        let screen_rect = ctx.screen_rect();
        let pop_w = 264.0;
        let pop_pos = egui::pos2((screen_rect.max.x - pop_w - 18.0).max(260.0), 54.0);

        let (display_name, email, initials, plan_badge) = if let Some(acct) = &self.status.account {
            let plan = if acct.max_space >= 400 * 1024 * 1024 * 1024 {
                "Proton Unlimited"
            } else if acct.max_space >= 15 * 1024 * 1024 * 1024 {
                "Proton Drive Plus"
            } else {
                "Proton Free"
            };
            (
                if acct.display_name.is_empty() {
                    "Proton Account".to_string()
                } else {
                    acct.display_name.clone()
                },
                acct.email.clone(),
                if acct.initials.is_empty() {
                    "PD".to_string()
                } else {
                    acct.initials.clone()
                },
                plan.to_string(),
            )
        } else {
            (
                "Proton Account".to_string(),
                "Not Signed In".to_string(),
                "PD".to_string(),
                "Proton Drive".to_string(),
            )
        };

        let area_resp = egui::Area::new(egui::Id::new("proton_account_popover"))
            .order(egui::Order::Foreground)
            .fixed_pos(pop_pos)
            .show(ctx, |ui| {
                Frame::NONE
                    .fill(Color32::from_rgb(28, 25, 38)) // #1C1926 matching Proton Mail popover
                    .stroke(Stroke::new(1.0_f32, Color32::from_rgb(60, 53, 82)))
                    .corner_radius(CornerRadius::same(12))
                    .show(ui, |ui| {
                        ui.set_min_width(pop_w);
                        ui.set_max_width(pop_w);

                        // Top header strip ("End-to-end encrypted sync  ›")
                        Frame::NONE
                            .inner_margin(Margin::symmetric(16, 12))
                            .show(ui, |ui| {
                                ui.set_min_width(pop_w - 32.0);
                                ui.vertical_centered(|ui| {
                                    ui.label(
                                        RichText::new("✓  End-to-end encrypted sync   ›")
                                            .size(12.5)
                                            .color(Color32::from_rgb(206, 202, 222)),
                                    );
                                });
                            });

                        let (sep_rect, _) =
                            ui.allocate_exact_size(Vec2::new(pop_w, 1.0), Sense::hover());
                        ui.painter()
                            .rect_filled(sep_rect, 0, Color32::from_rgb(48, 43, 66));

                        // Main Popover Body
                        Frame::NONE
                            .inner_margin(Margin::symmetric(18, 18))
                            .show(ui, |ui| {
                                ui.set_min_width(pop_w - 36.0);
                                ui.vertical_centered(|ui| {
                                    // Centered 44x44 Initials Avatar
                                    let (av_rect, _) = ui.allocate_exact_size(
                                        Vec2::new(44.0, 44.0),
                                        Sense::hover(),
                                    );
                                    ui.painter().rect_filled(
                                        av_rect,
                                        CornerRadius::same(10),
                                        Color32::from_rgb(61, 46, 110),
                                    );
                                    ui.painter().text(
                                        av_rect.center(),
                                        egui::Align2::CENTER_CENTER,
                                        &initials,
                                        FontId::new(16.0, FontFamily::Proportional),
                                        Color32::WHITE,
                                    );

                                    ui.add_space(12.0);

                                    // Display Name
                                    ui.label(
                                        RichText::new(&display_name)
                                            .size(14.5)
                                            .strong()
                                            .color(TEXT_PRIMARY),
                                    );

                                    ui.add_space(2.0);

                                    // Email
                                    ui.label(
                                        RichText::new(&email).size(12.5).color(TEXT_MUTED),
                                    );

                                    ui.add_space(8.0);

                                    // Compact Plan Pill Badge ("Proton Unlimited") matching Proton Mail
                                    let (pill_rect, _) = ui.allocate_exact_size(
                                        Vec2::new(112.0, 20.0),
                                        Sense::hover(),
                                    );
                                    ui.painter().rect_filled(
                                        pill_rect,
                                        CornerRadius::same(5),
                                        Color32::from_rgb(47, 36, 84),
                                    );
                                    ui.painter().text(
                                        pill_rect.center(),
                                        egui::Align2::CENTER_CENTER,
                                        &plan_badge,
                                        FontId::new(11.0, FontFamily::Proportional),
                                        Color32::from_rgb(198, 180, 255),
                                    );

                                    ui.add_space(16.0);

                                    // Button 1: Open local folder (outlined button matching Proton Mail)
                                    let btn_w = pop_w - 36.0;
                                    if proton_button(
                                        ui,
                                        Vec2::new(btn_w, 34.0),
                                        "Open local sync folder",
                                        Color32::from_rgb(28, 25, 38),
                                        Color32::from_rgb(42, 37, 56),
                                        Some(Stroke::new(1.0_f32, Color32::from_rgb(76, 69, 100))),
                                        TEXT_PRIMARY,
                                        13.0,
                                    )
                                    .clicked()
                                    {
                                        let folder = if self.status.sync_dir.is_empty() {
                                            "~/ProtonDrive"
                                        } else {
                                            &self.status.sync_dir
                                        };
                                        let _ = Command::new("xdg-open").arg(folder).spawn();
                                        self.show_account_menu = false;
                                    }

                                    ui.add_space(8.0);

                                    // Button 2: Sign out / Sign in (outlined with Proton purple border matching Proton Mail)
                                    if self.status.logged_in {
                                        if proton_button(
                                            ui,
                                            Vec2::new(btn_w, 34.0),
                                            "Sign out",
                                            Color32::from_rgb(28, 25, 38),
                                            Color32::from_rgb(46, 36, 82),
                                            Some(Stroke::new(1.2_f32, PROTON_PURPLE)),
                                            TEXT_PRIMARY,
                                            13.0,
                                        )
                                        .clicked()
                                        {
                                            let _ = self.tx.send(WorkerCommand::Logout);
                                            self.show_account_menu = false;
                                        }
                                    } else if proton_button(
                                        ui,
                                        Vec2::new(btn_w, 34.0),
                                        "Sign in",
                                        PROTON_PURPLE,
                                        PROTON_PURPLE_HOVER,
                                        None,
                                        Color32::WHITE,
                                        13.0,
                                    )
                                    .clicked()
                                    {
                                        let _ = self.tx.send(WorkerCommand::StartLogin);
                                        self.show_account_menu = false;
                                    }
                                });
                            });
                    });
            });

        // Close popover if user clicks outside of it (and outside top bar)
        if ctx.input(|i| i.pointer.any_pressed()) {
            if let Some(pos) = ctx.input(|i| i.pointer.interact_pos()) {
                if !area_resp.response.rect.contains(pos) && pos.y > 56.0 {
                    self.show_account_menu = false;
                }
            }
        }
    }

    fn render_overview_tab(&mut self, ui: &mut egui::Ui) {
        // Section Title Bar
        ui.horizontal(|ui| {
            ui.label(
                RichText::new("My Files & Sync Activity")
                    .size(20.0)
                    .strong()
                    .color(TEXT_PRIMARY),
            );
            if !self.status.logged_in {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if proton_button(
                        ui,
                        Vec2::new(165.0, 34.0),
                        "Sign in to Proton Drive",
                        PROTON_PURPLE,
                        PROTON_PURPLE_HOVER,
                        None,
                        Color32::WHITE,
                        13.0,
                    )
                    .clicked()
                    {
                        let _ = self.tx.send(WorkerCommand::StartLogin);
                    }
                });
            }
        });

        if let Some(url) = &self.login_url {
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!("Sign-in URL opened in browser: {url}"))
                    .size(12.0)
                    .color(PROTON_PURPLE_TEXT),
            );
        }

        ui.add_space(12.0);

        // 4 Stat Metric Cards (including Proton Cloud Storage Quota!)
        let cloud_quota_str = if let Some(acct) = &self.status.account {
            if acct.max_space > 0 {
                format!(
                    "{} / {}",
                    format_bytes_precise(acct.used_space),
                    format_bytes_precise(acct.max_space)
                )
            } else {
                format_bytes(self.status.stats.total_bytes)
            }
        } else {
            format_bytes(self.status.stats.total_bytes)
        };

        ui.columns(4, |cols| {
            render_stat_card(
                &mut cols[0],
                "Proton Cloud Storage",
                &cloud_quota_str,
            );
            render_stat_card(
                &mut cols[1],
                "Local Synced Size",
                &format_bytes_precise(self.status.stats.total_bytes),
            );
            render_stat_card(
                &mut cols[2],
                "Synced Files",
                &self.status.stats.total_files.to_string(),
            );
            render_stat_card(
                &mut cols[3],
                "Synced Folders",
                &self.status.stats.total_folders.to_string(),
            );
        });

        // Active Transfers Card (if any)
        if !self.status.active_transfers.is_empty() {
            ui.add_space(14.0);
            card_frame().show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.label(
                    RichText::new("Active Transfers")
                        .size(15.0)
                        .strong()
                        .color(TEXT_PRIMARY),
                );
                ui.add_space(10.0);
                for t in &self.status.active_transfers {
                    let frac = if t.total_bytes > 0 {
                        (t.bytes_transferred as f32 / t.total_bytes as f32).clamp(0.0, 1.0)
                    } else {
                        0.5
                    };
                    ui.horizontal(|ui| {
                        let badge = if t.direction == "upload" {
                            "↑ Uploading"
                        } else {
                            "↓ Downloading"
                        };
                        ui.label(RichText::new(badge).size(12.5).strong().color(PROTON_PURPLE_TEXT));
                        ui.label(RichText::new(&t.rel_path).size(12.5).color(TEXT_PRIMARY));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            ui.label(
                                RichText::new(format!(
                                    "{} / {}",
                                    format_bytes(t.bytes_transferred),
                                    format_bytes(t.total_bytes)
                                ))
                                .size(12.0)
                                .color(TEXT_MUTED),
                            );
                        });
                    });
                    ui.add_space(4.0);
                    ui.add(
                        egui::ProgressBar::new(frac)
                            .fill(PROTON_PURPLE)
                            .desired_height(6.0)
                            .corner_radius(CornerRadius::same(4)),
                    );
                    ui.add_space(8.0);
                }
            });
        }

        ui.add_space(14.0);

        // Recent Sync Activity Card (filtered by top search box)
        let query_lower = self.search_query.trim().to_lowercase();
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("Recent Sync Activity")
                        .size(15.5)
                        .strong()
                        .color(TEXT_PRIMARY),
                );
                if let Some(acct) = &self.status.account {
                    if acct.used_drive_space > 0 {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            ui.label(
                                RichText::new(format!(
                                    "Drive Cloud Usage: {}  •  Syncing {}",
                                    format_bytes_precise(acct.used_drive_space),
                                    self.status.sync_dir
                                ))
                                .size(12.0)
                                .color(TEXT_MUTED),
                            );
                        });
                    }
                }
            });
            ui.add_space(12.0);

            // Full-width Column Header Bar for Recent Sync Activity
            let (hdr_rect, _) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::hover());
            ui.painter().rect_filled(
                hdr_rect,
                CornerRadius::same(7),
                Color32::from_rgb(26, 23, 36),
            );
            let hdr_y = hdr_rect.center().y;
            let file_col_x = hdr_rect.min.x + 124.0;
            let details_col_x = (hdr_rect.min.x + hdr_rect.width() * 0.54).max(file_col_x + 220.0);

            ui.painter().text(
                egui::pos2(hdr_rect.min.x + 14.0, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Action",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );
            ui.painter().text(
                egui::pos2(file_col_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "File / Folder",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );
            ui.painter().text(
                egui::pos2(details_col_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Details",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );

            ui.add_space(4.0);

            ScrollArea::vertical()
                .id_salt("activity_table_scroll")
                .max_height((ui.available_height() - 10.0).max(200.0))
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    if self.activities.is_empty() {
                        ui.add_space(16.0);
                        ui.label(
                            RichText::new("No synchronization activity recorded yet.")
                                .size(13.0)
                                .color(TEXT_MUTED),
                        );
                    } else {
                        for act in self
                            .activities
                            .iter()
                            .filter(|a| {
                                query_lower.is_empty()
                                    || a.local_rel_path
                                        .to_lowercase()
                                        .contains(&query_lower)
                                    || a.details.to_lowercase().contains(&query_lower)
                                    || a.action.to_lowercase().contains(&query_lower)
                            })
                            .take(40)
                        {
                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 36.0),
                                Sense::hover(),
                            );
                            if row_resp.hovered() {
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(6),
                                    Color32::from_rgb(41, 36, 56),
                                );
                            }
                            ui.painter().line_segment(
                                [
                                    egui::pos2(row_rect.min.x + 10.0, row_rect.max.y),
                                    egui::pos2(row_rect.max.x - 10.0, row_rect.max.y),
                                ],
                                Stroke::new(1.0_f32, Color32::from_rgb(40, 35, 54)),
                            );

                            let cy = row_rect.center().y;
                            let r_file_x = row_rect.min.x + 124.0;
                            let r_details_x =
                                (row_rect.min.x + row_rect.width() * 0.54).max(r_file_x + 220.0);

                            let pill_color = match act.action.as_str() {
                                "upload" => PROTON_PURPLE,
                                "download" => STATUS_SUCCESS,
                                "error" | "conflict" => STATUS_DANGER,
                                _ => BG_CARD_ALT,
                            };
                            let pill_rect = egui::Rect::from_min_size(
                                egui::pos2(row_rect.min.x + 12.0, cy - 10.0),
                                Vec2::new(88.0, 20.0),
                            );
                            ui.painter()
                                .rect_filled(pill_rect, CornerRadius::same(5), pill_color);
                            ui.painter().text(
                                pill_rect.center(),
                                egui::Align2::CENTER_CENTER,
                                &act.action,
                                FontId::new(11.0, FontFamily::Proportional),
                                Color32::WHITE,
                            );

                            ui.painter().text(
                                egui::pos2(r_file_x, cy),
                                egui::Align2::LEFT_CENTER,
                                truncate_middle(&act.local_rel_path, 52),
                                FontId::new(13.0, FontFamily::Proportional),
                                TEXT_PRIMARY,
                            );
                            ui.painter().text(
                                egui::pos2(r_details_x, cy),
                                egui::Align2::LEFT_CENTER,
                                truncate_middle(&act.details, 64),
                                FontId::new(12.5, FontFamily::Proportional),
                                TEXT_MUTED,
                            );
                        }
                    }
                });
        });
    }

    fn render_browser_tab(&mut self, ui: &mut egui::Ui) {
        let avail_h = (ui.available_height() - 4.0).max(400.0);
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.set_min_height(avail_h - 36.0);

            // Top Breadcrumb & Action Bar
            let parts: Vec<String> = self
                .remote_path
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            let mut navigate_to: Option<String> = None;

            ui.horizontal(|ui| {
                // Up button if deeper than /my-files
                if parts.len() > 1 {
                    if proton_button(
                        ui,
                        Vec2::new(34.0, 32.0),
                        "↑",
                        BG_CARD_ALT,
                        Color32::from_rgb(54, 47, 72),
                        Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                        TEXT_PRIMARY,
                        14.0,
                    )
                    .on_hover_text("Go to parent folder")
                    .clicked()
                    {
                        let parent = format!("/{}", parts[..parts.len() - 1].join("/"));
                        navigate_to = Some(parent);
                    }
                    ui.add_space(4.0);
                }

                // Interactive Breadcrumbs ("My files  ›  subfolder")
                for (idx, part) in parts.iter().enumerate() {
                    let is_last = idx + 1 == parts.len();
                    let label = if idx == 0 && part == "my-files" {
                        "My files"
                    } else {
                        part.as_str()
                    };
                    let target_path = format!("/{}", parts[..=idx].join("/"));

                    let crumb_fill = if is_last {
                        PROTON_PURPLE_SOFT
                    } else {
                        BG_INPUT
                    };
                    let crumb_text_col = if is_last {
                        TEXT_PRIMARY
                    } else {
                        TEXT_MUTED
                    };

                    let resp = Frame::NONE
                        .fill(crumb_fill)
                        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                        .corner_radius(CornerRadius::same(7))
                        .inner_margin(Margin::symmetric(12, 6))
                        .show(ui, |ui| {
                            ui.label(
                                RichText::new(label)
                                    .size(13.5)
                                    .strong()
                                    .color(crumb_text_col),
                            );
                        })
                        .response
                        .interact(Sense::click());

                    if !is_last {
                        if resp.hovered() {
                            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                        }
                        if resp.clicked() {
                            navigate_to = Some(target_path);
                        }
                        ui.label(RichText::new("›").size(15.0).color(TEXT_MUTED));
                    }
                }

                // Right-side Toolbar Buttons & Item Counter
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if proton_button(
                        ui,
                        Vec2::new(84.0, 32.0),
                        "Refresh",
                        PROTON_PURPLE,
                        PROTON_PURPLE_HOVER,
                        None,
                        Color32::WHITE,
                        13.0,
                    )
                    .clicked()
                    {
                        navigate_to = Some(self.remote_path.clone());
                    }

                    ui.add_space(6.0);

                    if proton_button(
                        ui,
                        Vec2::new(108.0, 32.0),
                        "+ New folder",
                        BG_CARD_ALT,
                        Color32::from_rgb(54, 47, 72),
                        Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                        TEXT_PRIMARY,
                        13.0,
                    )
                    .clicked()
                    {
                        self.show_new_folder_modal = !self.show_new_folder_modal;
                    }

                    if !self.remote_items.is_empty() {
                        ui.add_space(10.0);
                        let folder_count = self
                            .remote_items
                            .iter()
                            .filter(|i| i.item_type == "folder")
                            .count();
                        let file_count = self.remote_items.len().saturating_sub(folder_count);
                        ui.label(
                            RichText::new(format!(
                                "{folder_count} folders  •  {file_count} files"
                            ))
                            .size(12.0)
                            .color(TEXT_MUTED),
                        );
                    }
                });
            });

            if let Some(next_path) = navigate_to {
                self.remote_loading = true;
                let _ = self.tx.send(WorkerCommand::LoadRemotePath(next_path));
            }

            if self.show_new_folder_modal {
                ui.add_space(10.0);
                Frame::NONE
                    .fill(BG_INPUT)
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(14, 10))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new("New folder name:")
                                    .size(13.0)
                                    .color(TEXT_MUTED),
                            );
                            ui.add(
                                egui::TextEdit::singleline(&mut self.new_folder_name)
                                    .hint_text("Enter folder name...")
                                    .desired_width(240.0),
                            );
                            if proton_button(
                                ui,
                                Vec2::new(76.0, 28.0),
                                "Create",
                                PROTON_PURPLE,
                                PROTON_PURPLE_HOVER,
                                None,
                                Color32::WHITE,
                                12.5,
                            )
                            .clicked()
                                && !self.new_folder_name.trim().is_empty()
                            {
                                let _ = self.tx.send(WorkerCommand::CreateRemoteFolder {
                                    parent_path: self.remote_path.clone(),
                                    name: self.new_folder_name.trim().to_string(),
                                });
                                self.new_folder_name.clear();
                                self.show_new_folder_modal = false;
                            }
                            if proton_button(
                                ui,
                                Vec2::new(68.0, 28.0),
                                "Cancel",
                                BG_CARD_ALT,
                                Color32::from_rgb(54, 47, 72),
                                Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                                TEXT_MUTED,
                                12.5,
                            )
                            .clicked()
                            {
                                self.show_new_folder_modal = false;
                            }
                        });
                    });
            }

            ui.add_space(14.0);

            // Column Header Bar (pixel-aligned across full table width)
            let (hdr_rect, _) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::hover());
            ui.painter().rect_filled(
                hdr_rect,
                CornerRadius::same(7),
                Color32::from_rgb(26, 23, 36),
            );
            let hdr_y = hdr_rect.center().y;
            let status_x = (hdr_rect.max.x - 395.0).max(hdr_rect.min.x + 240.0);
            let mod_x = (hdr_rect.max.x - 245.0).max(status_x + 110.0);
            let size_right_x = hdr_rect.max.x - 18.0;

            ui.painter().text(
                egui::pos2(hdr_rect.min.x + 16.0, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Name",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );
            ui.painter().text(
                egui::pos2(status_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Sync Status",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );
            ui.painter().text(
                egui::pos2(mod_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Modified",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );
            ui.painter().text(
                egui::pos2(size_right_x, hdr_y),
                egui::Align2::RIGHT_CENTER,
                "Size",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED,
            );

            ui.add_space(4.0);

            if self.remote_loading {
                ui.add_space(28.0);
                ui.vertical_centered(|ui| {
                    ui.label(
                        RichText::new("Loading Proton Drive folder contents...")
                            .size(13.5)
                            .color(TEXT_MUTED),
                    );
                });
            } else if let Some(err) = &self.remote_error {
                ui.add_space(20.0);
                ui.label(RichText::new(err).size(13.0).color(STATUS_DANGER));
            } else if self.remote_items.is_empty() {
                ui.add_space(28.0);
                ui.vertical_centered(|ui| {
                    ui.label(
                        RichText::new("This folder is empty.")
                            .size(13.5)
                            .color(TEXT_MUTED),
                    );
                });
            } else {
                // Sort folders first (A-Z), then files (A-Z), and filter by search_query
                let query_lower = self.search_query.trim().to_lowercase();
                let mut sorted_items: Vec<RemoteItem> = self
                    .remote_items
                    .iter()
                    .filter(|item| {
                        query_lower.is_empty()
                            || item.name.to_lowercase().contains(&query_lower)
                    })
                    .cloned()
                    .collect();

                sorted_items.sort_by(|a, b| {
                    let a_folder = a.item_type == "folder";
                    let b_folder = b.item_type == "folder";
                    match (a_folder, b_folder) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                    }
                });

                let is_root = self.remote_path == "/my-files" || self.remote_path == "/";
                let root_folder_name = parts.get(1).cloned();
                let scroll_h = (ui.available_height() - 6.0).max(240.0);

                ScrollArea::vertical()
                    .id_salt("cloud_browser_table_scroll")
                    .max_height(scroll_h)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let mut clicked_folder: Option<String> = None;

                        for item in sorted_items {
                            let is_folder = item.item_type == "folder";
                            let top_check_name = if is_root {
                                Some(item.name.as_str())
                            } else {
                                root_folder_name.as_deref()
                            };
                            let is_excluded = top_check_name.is_some_and(|top_name| {
                                self.status
                                    .settings
                                    .excluded_folders
                                    .iter()
                                    .any(|ex| ex == top_name)
                            });

                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 42.0),
                                Sense::click(),
                            );

                            if row_resp.hovered() {
                                if is_folder {
                                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                                }
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(7),
                                    Color32::from_rgb(43, 38, 60),
                                );
                            }

                            // Subtle bottom row separator
                            ui.painter().line_segment(
                                [
                                    egui::pos2(row_rect.min.x + 10.0, row_rect.max.y),
                                    egui::pos2(row_rect.max.x - 10.0, row_rect.max.y),
                                ],
                                Stroke::new(1.0_f32, Color32::from_rgb(40, 35, 54)),
                            );

                            let row_cy = row_rect.center().y;
                            let row_status_x =
                                (row_rect.max.x - 395.0).max(row_rect.min.x + 240.0);
                            let row_mod_x = (row_rect.max.x - 245.0).max(row_status_x + 110.0);
                            let row_size_right_x = row_rect.max.x - 18.0;

                            // 1. Name Column (Vector Folder/File Icon + Item Name)
                            let ic_rect = egui::Rect::from_center_size(
                                egui::pos2(row_rect.min.x + 26.0, row_cy),
                                Vec2::new(20.0, 17.0),
                            );
                            if is_folder {
                                draw_folder_icon(ui.painter(), ic_rect, !is_excluded);
                            } else {
                                draw_file_icon(ui.painter(), ic_rect, &item.name);
                            }

                            let name_color = if is_folder {
                                TEXT_PRIMARY
                            } else {
                                Color32::from_rgb(230, 228, 240)
                            };
                            ui.painter().text(
                                egui::pos2(row_rect.min.x + 46.0, row_cy),
                                egui::Align2::LEFT_CENTER,
                                truncate_middle(&item.name, 54),
                                FontId::new(13.5, FontFamily::Proportional),
                                name_color,
                            );

                            // 2. Sync Status Column ("✓ Synced" vs "Cloud only")
                            let pill_rect = egui::Rect::from_min_size(
                                egui::pos2(row_status_x, row_cy - 10.5),
                                Vec2::new(84.0, 21.0),
                            );
                            if is_excluded {
                                ui.painter().rect_filled(
                                    pill_rect,
                                    CornerRadius::same(99),
                                    Color32::from_rgb(38, 33, 52),
                                );
                                ui.painter().text(
                                    pill_rect.center(),
                                    egui::Align2::CENTER_CENTER,
                                    "Cloud only",
                                    FontId::new(11.0, FontFamily::Proportional),
                                    TEXT_MUTED,
                                );
                            } else {
                                ui.painter().rect_filled(
                                    pill_rect,
                                    CornerRadius::same(99),
                                    Color32::from_rgba_unmultiplied(30, 168, 133, 30),
                                );
                                ui.painter().text(
                                    pill_rect.center(),
                                    egui::Align2::CENTER_CENTER,
                                    "✓ Synced",
                                    FontId::new(11.0, FontFamily::Proportional),
                                    STATUS_SUCCESS,
                                );
                            }

                            // 3. Modified Date Column
                            ui.painter().text(
                                egui::pos2(row_mod_x, row_cy),
                                egui::Align2::LEFT_CENTER,
                                format_iso_date(&item.modification_time),
                                FontId::new(12.0, FontFamily::Proportional),
                                TEXT_MUTED,
                            );

                            // 4. Size Column
                            let size_str = if is_folder {
                                "—".to_string()
                            } else {
                                format_bytes(item.size)
                            };
                            ui.painter().text(
                                egui::pos2(row_size_right_x, row_cy),
                                egui::Align2::RIGHT_CENTER,
                                size_str,
                                FontId::new(12.0, FontFamily::Proportional),
                                TEXT_MUTED,
                            );

                            if is_folder && row_resp.clicked() {
                                clicked_folder = Some(format!(
                                    "{}/{}",
                                    self.remote_path.trim_end_matches('/'),
                                    item.name
                                ));
                            }
                        }

                        if let Some(next) = clicked_folder {
                            self.remote_loading = true;
                            let _ = self.tx.send(WorkerCommand::LoadRemotePath(next));
                        }
                    });
            }
        });
    }

    fn render_selective_tab(&mut self, ui: &mut egui::Ui) {
        let total_folders = self.selective_folders.len();
        let synced_folders = self.selective_folders.iter().filter(|f| !f.excluded).count();
        let avail_h = (ui.available_height() - 6.0).max(420.0);
        let total_w = ui.available_width();
        let left_w = ((total_w - 16.0) * 0.62).max(380.0);
        let right_w = (total_w - left_w - 16.0).max(260.0);

        ui.horizontal_top(|ui| {
            // Left Column: Spacious Full-Height Selective Folder Sync Card
            ui.allocate_ui_with_layout(Vec2::new(left_w, avail_h), Layout::top_down(Align::Min), |ui| {
                card_frame().show(ui, |ui| {
                    ui.set_min_width(left_w - 38.0);
                    ui.set_max_width(left_w - 38.0);
                    ui.set_min_height(avail_h - 38.0);

                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new("Selective Folder Sync (/my-files)")
                                        .size(16.0)
                                        .strong()
                                        .color(TEXT_PRIMARY),
                                );
                                ui.add_space(6.0);
                                Frame::NONE
                                    .fill(PROTON_PURPLE_SOFT)
                                    .corner_radius(CornerRadius::same(99))
                                    .inner_margin(Margin::symmetric(10, 3))
                                    .show(ui, |ui| {
                                        ui.label(
                                            RichText::new(format!(
                                                "{synced_folders} of {total_folders} synced"
                                            ))
                                            .size(11.5)
                                            .strong()
                                            .color(PROTON_PURPLE_TEXT),
                                        );
                                    });
                            });
                            ui.add_space(3.0);
                            ui.label(
                                RichText::new("Unchecked folders are removed from local disk and kept safely in Proton Drive cloud.")
                                    .size(12.5)
                                    .color(TEXT_MUTED),
                            );
                        });

                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let mut bulk_change: Option<bool> = None;
                            if ui
                                .add(
                                    egui::Button::new(
                                        RichText::new("None").size(12.0).color(TEXT_PRIMARY),
                                    )
                                    .fill(BG_CARD_ALT)
                                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                                    .corner_radius(CornerRadius::same(6))
                                    .min_size(Vec2::new(60.0, 28.0)),
                                )
                                .on_hover_text("Exclude all top-level folders from local sync")
                                .clicked()
                            {
                                bulk_change = Some(true);
                            }
                            ui.add_space(6.0);
                            if ui
                                .add(
                                    egui::Button::new(
                                        RichText::new("Select All").size(12.0).color(TEXT_PRIMARY),
                                    )
                                    .fill(BG_CARD_ALT)
                                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                                    .corner_radius(CornerRadius::same(6))
                                    .min_size(Vec2::new(78.0, 28.0)),
                                )
                                .on_hover_text("Include all top-level folders in local sync")
                                .clicked()
                            {
                                bulk_change = Some(false);
                            }

                            if let Some(exclude_all) = bulk_change {
                                for f in &mut self.selective_folders {
                                    f.excluded = exclude_all;
                                }
                                let excluded: Vec<String> = self
                                    .selective_folders
                                    .iter()
                                    .filter(|f| f.excluded)
                                    .map(|f| f.name.clone())
                                    .collect();
                                let _ = self.tx.send(WorkerCommand::SaveSettings(
                                    serde_json::json!({ "excludedFolders": excluded }),
                                ));
                            }
                        });
                    });

                    ui.add_space(12.0);

                    // Filter box
                    ui.horizontal(|ui| {
                        ui.add(
                            egui::TextEdit::singleline(&mut self.selective_filter)
                                .hint_text("Filter folders in /my-files...")
                                .desired_width(ui.available_width() - 80.0),
                        );
                        if ui
                            .add(
                                egui::Button::new(RichText::new("Refresh").size(12.0))
                                    .fill(BG_CARD_ALT)
                                    .corner_radius(CornerRadius::same(6))
                                    .min_size(Vec2::new(70.0, 28.0)),
                            )
                            .clicked()
                        {
                            let _ = self.tx.send(WorkerCommand::LoadSelectiveFolders);
                        }
                    });

                    ui.add_space(10.0);
                    ui.separator();
                    ui.add_space(8.0);

                    let scroll_h = (ui.available_height() - 6.0).max(240.0);
                    let filter_lower = self.selective_filter.trim().to_lowercase();

                    ScrollArea::vertical()
                        .id_salt("selective_folders_scroll")
                        .max_height(scroll_h)
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            if self.selective_folders.is_empty() {
                                ui.add_space(20.0);
                                ui.label(
                                    RichText::new("Loading remote top-level folders from /my-files...")
                                        .size(13.5)
                                        .color(TEXT_MUTED),
                                );
                                return;
                            }

                            let mut changed = false;
                            for folder in &mut self.selective_folders {
                                if !filter_lower.is_empty()
                                    && !folder.name.to_lowercase().contains(&filter_lower)
                                {
                                    continue;
                                }
                                let mut included = !folder.excluded;
                                let row_fill = if included {
                                    BG_CARD_ALT
                                } else {
                                    Color32::from_rgb(27, 24, 36)
                                };
                                let border_col = if included {
                                    Color32::from_rgb(56, 48, 78)
                                } else {
                                    BORDER_SUBTLE
                                };

                                Frame::NONE
                                    .fill(row_fill)
                                    .stroke(Stroke::new(1.0_f32, border_col))
                                    .corner_radius(CornerRadius::same(8))
                                    .inner_margin(Margin::symmetric(14, 10))
                                    .show(ui, |ui| {
                                        ui.set_min_width(ui.available_width());
                                        ui.horizontal(|ui| {
                                            if ui.checkbox(&mut included, "").changed() {
                                                folder.excluded = !included;
                                                changed = true;
                                            }
                                            ui.add_space(4.0);
                                            let (f_rect, _) = ui.allocate_exact_size(
                                                Vec2::new(16.0, 13.0),
                                                Sense::hover(),
                                            );
                                            let folder_color = if included {
                                                PROTON_PURPLE
                                            } else {
                                                TEXT_MUTED
                                            };
                                            ui.painter().rect_filled(
                                                f_rect,
                                                CornerRadius::same(3),
                                                folder_color,
                                            );
                                            ui.add_space(6.0);

                                            let name_resp = ui.add(
                                                egui::Label::new(
                                                    RichText::new(&folder.name)
                                                        .size(14.0)
                                                        .strong()
                                                        .color(if included {
                                                            TEXT_PRIMARY
                                                        } else {
                                                            TEXT_MUTED
                                                        }),
                                                )
                                                .sense(Sense::click()),
                                            );
                                            if name_resp.clicked() {
                                                included = !included;
                                                folder.excluded = !included;
                                                changed = true;
                                            }

                                            ui.with_layout(
                                                Layout::right_to_left(Align::Center),
                                                |ui| {
                                                    if included {
                                                        Frame::NONE
                                                            .fill(Color32::from_rgba_unmultiplied(
                                                                30, 168, 133, 32,
                                                            ))
                                                            .corner_radius(CornerRadius::same(99))
                                                            .inner_margin(Margin::symmetric(10, 3))
                                                            .show(ui, |ui| {
                                                                ui.label(
                                                                    RichText::new("Synced Locally")
                                                                        .size(11.5)
                                                                        .strong()
                                                                        .color(STATUS_SUCCESS),
                                                                );
                                                            });
                                                    } else {
                                                        Frame::NONE
                                                            .fill(Color32::from_rgb(35, 31, 46))
                                                            .corner_radius(CornerRadius::same(99))
                                                            .inner_margin(Margin::symmetric(10, 3))
                                                            .show(ui, |ui| {
                                                                ui.label(
                                                                    RichText::new("Cloud Only")
                                                                        .size(11.5)
                                                                        .color(TEXT_MUTED),
                                                                );
                                                            });
                                                    }
                                                },
                                            );
                                        });
                                    });
                                ui.add_space(6.0);
                            }

                            if changed {
                                let excluded: Vec<String> = self
                                    .selective_folders
                                    .iter()
                                    .filter(|f| f.excluded)
                                    .map(|f| f.name.clone())
                                    .collect();
                                let _ = self.tx.send(WorkerCommand::SaveSettings(
                                    serde_json::json!({ "excludedFolders": excluded }),
                                ));
                            }
                        });
                });
            });

            ui.add_space(14.0);

            // Right Column: Full-Height Ignore Patterns Card
            ui.allocate_ui_with_layout(Vec2::new(right_w, avail_h), Layout::top_down(Align::Min), |ui| {
                card_frame().show(ui, |ui| {
                    ui.set_min_width(right_w - 38.0);
                    ui.set_max_width(right_w - 38.0);
                    ui.set_min_height(avail_h - 38.0);
                    ui.label(
                        RichText::new("Ignore Patterns (Glob)")
                            .size(16.0)
                            .strong()
                            .color(TEXT_PRIMARY),
                    );
                    ui.add_space(4.0);
                    ui.label(
                        RichText::new(
                            "One glob pattern per line. Matching files or folders are skipped during two-way sync.",
                        )
                        .size(12.5)
                        .color(TEXT_MUTED),
                    );
                    ui.add_space(12.0);

                    let rows = ((avail_h - 175.0) / 19.0).clamp(8.0, 32.0) as usize;
                    if ui
                        .add(
                            egui::TextEdit::multiline(&mut self.ignore_patterns_text)
                                .desired_rows(rows)
                                .desired_width(f32::INFINITY)
                                .font(FontId::new(13.0, FontFamily::Monospace)),
                        )
                        .changed()
                    {
                        self.settings_dirty = true;
                    }
                    ui.add_space(12.0);
                    if ui
                        .add(
                            egui::Button::new(
                                RichText::new("Save Ignore Rules")
                                    .size(13.0)
                                    .strong()
                                    .color(Color32::WHITE),
                            )
                            .fill(PROTON_PURPLE)
                            .corner_radius(CornerRadius::same(8))
                            .min_size(Vec2::new(ui.available_width(), 36.0)),
                        )
                        .clicked()
                    {
                        let patterns: Vec<String> = self
                            .ignore_patterns_text
                            .lines()
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        self.settings_dirty = false;
                        let _ = self.tx.send(WorkerCommand::SaveSettings(
                            serde_json::json!({ "ignorePatterns": patterns }),
                        ));
                    }
                });
            });
        });
    }

    fn render_conflicts_tab(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(
                RichText::new("File Conflicts")
                    .size(15.5)
                    .strong()
                    .color(TEXT_PRIMARY),
            );
            ui.add_space(8.0);
            if self.conflicts.is_empty() {
                ui.label(
                    RichText::new("No file conflicts detected.")
                        .size(13.0)
                        .color(TEXT_MUTED),
                );
            } else {
                for c in self.conflicts.clone() {
                    Frame::NONE
                        .fill(BG_CARD_ALT)
                        .corner_radius(CornerRadius::same(8))
                        .inner_margin(Margin::symmetric(12, 10))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new(&c.local_rel_path)
                                        .size(13.5)
                                        .strong()
                                        .color(TEXT_PRIMARY),
                                );
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    if c.resolved != 0 {
                                        ui.label(
                                            RichText::new(format!(
                                                "Resolved ({})",
                                                c.resolution.unwrap_or_default()
                                            ))
                                            .size(12.5)
                                            .color(STATUS_SUCCESS),
                                        );
                                    } else {
                                        for (choice, label) in [
                                            ("keep-remote", "Keep Remote"),
                                            ("keep-local", "Keep Local"),
                                            ("keep-both", "Keep Both"),
                                        ] {
                                            if ui.button(label).clicked() {
                                                let _ = self.tx.send(
                                                    WorkerCommand::ResolveConflict {
                                                        id: c.id,
                                                        choice: choice.to_string(),
                                                    },
                                                );
                                            }
                                        }
                                    }
                                });
                            });
                        });
                    ui.add_space(6.0);
                }
            }
        });
    }

    fn render_settings_tab(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(
                RichText::new("Synchronization Settings")
                    .size(16.0)
                    .strong()
                    .color(TEXT_PRIMARY),
            );
            ui.add_space(16.0);

            ui.label(RichText::new("Local Sync Folder").size(13.0).color(TEXT_MUTED));
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let input_w = (ui.available_width() - 104.0).max(240.0);
                if ui
                    .add_sized(
                        [input_w, 34.0],
                        egui::TextEdit::singleline(&mut self.edit_sync_dir)
                            .vertical_align(Align::Center),
                    )
                    .changed()
                {
                    self.settings_dirty = true;
                }
                ui.add_space(6.0);
                if proton_button(
                    ui,
                    Vec2::new(92.0, 34.0),
                    "Browse...",
                    BG_CARD_ALT,
                    Color32::from_rgb(56, 50, 76),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE)),
                    TEXT_PRIMARY,
                    12.5,
                )
                .clicked()
                {
                    if let Ok(out) = Command::new("zenity")
                        .args([
                            "--file-selection",
                            "--directory",
                            "--title=Choose Proton Drive Local Sync Folder",
                        ])
                        .output()
                    {
                        if out.status.success() {
                            let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
                            if !chosen.is_empty() && chosen != self.edit_sync_dir {
                                self.edit_sync_dir = chosen;
                                self.settings_dirty = true;
                            }
                        }
                    }
                }
            });
            ui.add_space(6.0);
            ui.label(
                RichText::new(
                    "Changing the sync location safely moves your existing synced files to the new folder, switches the real-time file watcher, and preserves all cloud files without re-uploading or deleting them.",
                )
                .size(11.5)
                .color(TEXT_MUTED),
            );

            ui.add_space(16.0);
            ui.label(
                RichText::new("Conflict Resolution Strategy")
                    .size(13.0)
                    .color(TEXT_MUTED),
            );
            ui.add_space(6.0);
            egui::ComboBox::from_id_salt("conflict_strategy_combo")
                .selected_text(match self.edit_conflict_strategy.as_str() {
                    "keep-local" => "Keep Local (Overwrite remote revision)",
                    "keep-remote" => "Keep Remote (Overwrite local file)",
                    "prompt" => "Ask manually in Conflicts tab",
                    _ => "Keep Both (Save conflict copy with timestamp)",
                })
                .width(360.0)
                .show_ui(ui, |ui| {
                    for (val, text) in [
                        ("keep-both", "Keep Both (Save conflict copy with timestamp)"),
                        ("keep-local", "Keep Local (Overwrite remote revision)"),
                        ("keep-remote", "Keep Remote (Overwrite local file)"),
                        ("prompt", "Ask manually in Conflicts tab"),
                    ] {
                        if ui
                            .selectable_value(
                                &mut self.edit_conflict_strategy,
                                val.to_string(),
                                text,
                            )
                            .changed()
                        {
                            self.settings_dirty = true;
                        }
                    }
                });

            ui.add_space(16.0);
            if ui
                .checkbox(
                    &mut self.edit_notifications,
                    RichText::new("Enable Ubuntu desktop notifications")
                        .size(13.5)
                        .color(TEXT_PRIMARY),
                )
                .changed()
            {
                self.settings_dirty = true;
            }

            ui.add_space(18.0);
            if proton_button(
                ui,
                Vec2::new(156.0, 36.0),
                "Save Preferences",
                PROTON_PURPLE,
                PROTON_PURPLE_HOVER,
                None,
                Color32::WHITE,
                13.5,
            )
            .clicked()
            {
                self.settings_dirty = false;
                let _ = self.tx.send(WorkerCommand::SaveSettings(serde_json::json!({
                    "syncDir": self.edit_sync_dir,
                    "conflictStrategy": self.edit_conflict_strategy,
                    "notificationsEnabled": self.edit_notifications,
                })));
            }
        });
    }
}

impl eframe::App for ProtonDriveNativeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.process_worker_events();
        self.frames_rendered += 1;

        if self.screenshot_target.is_none() {
            if self.frames_rendered <= 3 {
                if self.window_geometry.maximized {
                    ctx.send_viewport_cmd(ViewportCommand::Maximized(true));
                }
                self.maximize_applied_on_open = true;
            } else if self.frames_rendered == 8 {
                save_window_geometry(&self.window_geometry);
            } else if self.frames_rendered > 8 {
                let updated_geom = ctx.input(|i| {
                    let vp = i.viewport();
                    if vp.minimized == Some(true) || vp.fullscreen == Some(true) {
                        return None;
                    }
                    let content_size = vp.inner_rect.map_or(i.screen_rect().size(), |r| r.size());
                    let is_max_by_monitor = vp
                        .monitor_size
                        .filter(|m| m.is_finite() && m.x > 0.0 && m.y > 0.0)
                        .is_some_and(|m| {
                            content_size.x >= m.x * 0.90 && content_size.y >= m.y * 0.84
                        });
                    let maximized = vp.maximized == Some(true) || is_max_by_monitor;
                    if maximized {
                        Some(WindowGeometry {
                            maximized: true,
                            ..self.window_geometry
                        })
                    } else if content_size.x >= 800.0 && content_size.y >= 500.0 {
                        let position = vp.outer_rect.map(|r| [r.min.x, r.min.y]);
                        Some(WindowGeometry {
                            position: position.or(self.window_geometry.position),
                            width: content_size.x.clamp(840.0, 16384.0),
                            height: content_size.y.clamp(540.0, 16384.0),
                            maximized: false,
                        })
                    } else {
                        None
                    }
                });

                if let Some(next_geom) = updated_geom {
                    if next_geom != self.window_geometry {
                        self.window_geometry = next_geom;
                        save_window_geometry(&self.window_geometry);
                    }
                }
            }
        }

        if self.last_poll.elapsed() >= Duration::from_millis(1500) {
            self.last_poll = Instant::now();
            let _ = self.tx.send(WorkerCommand::RefreshAll);
        }

        if ctx.input(|i| i.key_pressed(Key::F5)) {
            let _ = self.tx.send(WorkerCommand::RefreshAll);
        }

        self.render_sidebar(ctx);

        egui::TopBottomPanel::top("proton_top_header")
            .exact_height(56.0)
            .frame(
                Frame::NONE
                    .fill(BG_SIDEBAR)
                    .inner_margin(Margin::symmetric(24, 11))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE)),
            )
            .show(ctx, |ui| {
                self.render_top_bar(ui);
            });

        egui::CentralPanel::default()
            .frame(
                Frame::NONE
                    .fill(BG_CANVAS)
                    .inner_margin(Margin::symmetric(26, 20)),
            )
            .show(ctx, |ui| {
                match self.tab {
                    NavTab::Overview => self.render_overview_tab(ui),
                    NavTab::CloudBrowser => self.render_browser_tab(ui),
                    NavTab::SelectiveSync => self.render_selective_tab(ui),
                    NavTab::Conflicts => self.render_conflicts_tab(ui),
                    NavTab::Settings => self.render_settings_tab(ui),
                }
            });

        self.render_account_popover(ctx);

        // Handle --screenshot <path> for automated visual inspection
        if let Some(target_path) = self.screenshot_target.clone() {
            let ready = if self.tab == NavTab::SelectiveSync {
                (!self.selective_folders.is_empty() && self.frames_rendered >= 6)
                    || self.frames_rendered >= 45
            } else if self.tab == NavTab::CloudBrowser {
                (!self.remote_items.is_empty() && self.frames_rendered >= 6)
                    || self.frames_rendered >= 45
            } else {
                self.frames_rendered >= 6
            };
            if ready && !self.screenshot_requested {
                self.screenshot_requested = true;
                ctx.send_viewport_cmd(ViewportCommand::Screenshot(egui::UserData::default()));
            }
            let screenshot_img = ctx.input(|i| {
                for event in &i.raw.events {
                    if let egui::Event::Screenshot { image, .. } = event {
                        return Some(image.clone());
                    }
                }
                None
            });
            if let Some(img) = screenshot_img {
                save_color_image_png(&img, &target_path);
                ctx.send_viewport_cmd(ViewportCommand::Close);
            } else {
                ctx.request_repaint_after(Duration::from_millis(50));
            }
        } else {
            ctx.request_repaint_after(Duration::from_millis(500));
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if self.screenshot_target.is_none() {
            save_window_geometry(&self.window_geometry);
        }
    }
}

fn card_frame() -> Frame {
    Frame::NONE
        .fill(BG_CARD)
        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::same(18))
}

fn proton_button(
    ui: &mut egui::Ui,
    size: Vec2,
    label: &str,
    fill: Color32,
    hover_fill: Color32,
    stroke: Option<Stroke>,
    text_color: Color32,
    font_size: f32,
) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let bg = if resp.hovered() { hover_fill } else { fill };
    ui.painter().rect_filled(rect, CornerRadius::same(8), bg);
    if let Some(s) = stroke {
        ui.painter()
            .rect_stroke(rect, CornerRadius::same(8), s, egui::StrokeKind::Inside);
    }
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        label,
        FontId::new(font_size, FontFamily::Proportional),
        text_color,
    );
    resp
}

fn render_stat_card(ui: &mut egui::Ui, label: &str, value: &str) {
    card_frame().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new(label).size(12.5).color(TEXT_MUTED));
        ui.add_space(6.0);
        ui.label(
            RichText::new(value)
                .size(24.0)
                .strong()
                .color(TEXT_PRIMARY),
        );
    });
}

fn configure_proton_theme(ctx: &egui::Context) {
    // Embed Inter & JetBrains Mono fonts (matching Proton Carbon Design System & WordCraft)
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "Inter".to_owned(),
        std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
            "../../assets/fonts/Inter-Regular.ttf"
        ))),
    );
    fonts.font_data.insert(
        "InterMedium".to_owned(),
        std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
            "../../assets/fonts/Inter-Medium.ttf"
        ))),
    );
    fonts.font_data.insert(
        "InterSemiBold".to_owned(),
        std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
            "../../assets/fonts/Inter-SemiBold.ttf"
        ))),
    );
    fonts.font_data.insert(
        "JetBrainsMono".to_owned(),
        std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
            "../../assets/fonts/JetBrainsMono-Regular.ttf"
        ))),
    );
    if let Some(prop) = fonts.families.get_mut(&egui::FontFamily::Proportional) {
        prop.insert(0, "Inter".to_owned());
        prop.insert(1, "InterMedium".to_owned());
    }
    if let Some(mono) = fonts.families.get_mut(&egui::FontFamily::Monospace) {
        mono.insert(0, "JetBrainsMono".to_owned());
    }
    ctx.set_fonts(fonts);

    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BG_CANVAS;
    visuals.window_fill = BG_CARD;
    visuals.faint_bg_color = Color32::from_rgb(28, 25, 38);
    visuals.extreme_bg_color = BG_INPUT;
    visuals.selection.bg_fill = PROTON_PURPLE;
    visuals.selection.stroke = Stroke::new(1.0_f32, Color32::WHITE);
    visuals.widgets.noninteractive.bg_fill = BG_CARD;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER_SUBTLE);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);
    visuals.widgets.inactive.bg_fill = BG_CARD_ALT;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER_SUBTLE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);
    visuals.widgets.hovered.bg_fill = PROTON_PURPLE_HOVER;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, Color32::WHITE);
    visuals.widgets.active.bg_fill = PROTON_PURPLE;
    ctx.set_visuals(visuals);
}

fn load_app_icon() -> Option<IconData> {
    let png_bytes = include_bytes!("../../assets/app-icon/hicolor/256x256/apps/ch.proton.drive.png");
    eframe::icon_data::from_png_bytes(png_bytes).ok()
}

fn load_glyph_texture(ctx: &egui::Context) -> Option<TextureHandle> {
    let png_bytes = include_bytes!("../../linux/icons/protondrive-glyph-128.png");
    let img = image::load_from_memory(png_bytes).ok()?.to_rgba8();
    let size = [img.width() as usize, img.height() as usize];
    let color_img = egui::ColorImage::from_rgba_unmultiplied(size, img.as_raw());
    Some(ctx.load_texture("proton_drive_glyph", color_img, TextureOptions::LINEAR))
}

fn save_color_image_png(img: &egui::ColorImage, path: &str) {
    let mut raw = Vec::with_capacity(img.pixels.len() * 4);
    for px in &img.pixels {
        raw.extend_from_slice(&px.to_array());
    }
    if let Some(buf) =
        image::RgbaImage::from_raw(img.size[0] as u32, img.size[1] as u32, raw)
    {
        let _ = buf.save(path);
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut val = bytes as f64 / 1024.0;
    let mut idx = 0;
    while val >= 1024.0 && idx < units.len() - 1 {
        val /= 1024.0;
        idx += 1;
    }
    format!("{val:.1} {}", units[idx])
}

fn format_bytes_precise(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut val = bytes as f64 / 1024.0;
    let mut idx = 0;
    while val >= 1024.0 && idx < units.len() - 1 {
        val /= 1024.0;
        idx += 1;
    }
    if idx >= 2 {
        format!("{val:.2} {}", units[idx])
    } else {
        format!("{val:.1} {}", units[idx])
    }
}

fn draw_nav_icon(painter: &egui::Painter, rect: egui::Rect, tab: NavTab, color: Color32) {
    let stroke = Stroke::new(1.5_f32, color);
    let r = rect.shrink(1.5);
    match tab {
        NavTab::Overview => {
            // Folder outline icon
            let tab_rect = egui::Rect::from_min_size(r.min, Vec2::new(r.width() * 0.45, 3.0));
            let body_rect = egui::Rect::from_min_max(
                egui::pos2(r.min.x, r.min.y + 2.5),
                r.max,
            );
            painter.rect_filled(tab_rect, CornerRadius::same(1), color);
            painter.rect_stroke(body_rect, CornerRadius::same(2), stroke, egui::StrokeKind::Inside);
        }
        NavTab::CloudBrowser => {
            // 2x2 grid icon
            let w = (r.width() - 3.0) * 0.5;
            let h = (r.height() - 3.0) * 0.5;
            for row in 0..2 {
                for col in 0..2 {
                    let min = egui::pos2(
                        r.min.x + col as f32 * (w + 3.0),
                        r.min.y + row as f32 * (h + 3.0),
                    );
                    let cell = egui::Rect::from_min_size(min, Vec2::new(w, h));
                    painter.rect_stroke(cell, CornerRadius::same(1), stroke, egui::StrokeKind::Inside);
                }
            }
        }
        NavTab::SelectiveSync => {
            // Checklist / filter bars icon
            for i in 0..3 {
                let y = r.min.y + 2.0 + i as f32 * 4.5;
                painter.circle_filled(egui::pos2(r.min.x + 2.0, y), 1.4, color);
                painter.line_segment(
                    [egui::pos2(r.min.x + 5.5, y), egui::pos2(r.max.x, y)],
                    stroke,
                );
            }
        }
        NavTab::Conflicts => {
            // Warning badge icon
            painter.circle_stroke(r.center(), r.width() * 0.46, stroke);
            let c = r.center();
            painter.line_segment(
                [egui::pos2(c.x, c.y - 3.2), egui::pos2(c.x, c.y + 0.8)],
                stroke,
            );
            painter.circle_filled(egui::pos2(c.x, c.y + 3.2), 1.0, color);
        }
        NavTab::Settings => {
            draw_gear_icon(painter, rect.shrink(1.0), color);
        }
    }
}

fn draw_search_icon(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
    let stroke = Stroke::new(1.5_f32, color);
    let center = egui::pos2(rect.min.x + rect.width() * 0.42, rect.min.y + rect.height() * 0.42);
    let radius = rect.width() * 0.32;
    painter.circle_stroke(center, radius, stroke);
    let start = egui::pos2(center.x + radius * 0.72, center.y + radius * 0.72);
    let end = egui::pos2(rect.max.x - 1.2, rect.max.y - 1.2);
    painter.line_segment([start, end], stroke);
}

fn draw_gear_icon(painter: &egui::Painter, rect: egui::Rect, color: Color32) {
    let stroke = Stroke::new(1.5_f32, color);
    let c = rect.center();
    let r_outer = rect.width() * 0.44;
    let r_inner = rect.width() * 0.20;
    painter.circle_stroke(c, r_outer * 0.75, stroke);
    painter.circle_filled(c, r_inner, color);
    for i in 0..4 {
        let angle = i as f32 * std::f32::consts::FRAC_PI_4;
        let dx = angle.cos() * r_outer;
        let dy = angle.sin() * r_outer;
        painter.line_segment(
            [egui::pos2(c.x - dx, c.y - dy), egui::pos2(c.x + dx, c.y + dy)],
            Stroke::new(1.3_f32, color),
        );
    }
}

fn draw_folder_icon(painter: &egui::Painter, rect: egui::Rect, synced: bool) {
    let top_color = if synced {
        Color32::from_rgb(142, 112, 255)
    } else {
        Color32::from_rgb(108, 102, 128)
    };
    let body_color = if synced {
        PROTON_PURPLE
    } else {
        Color32::from_rgb(84, 78, 104)
    };
    let tab_rect = egui::Rect::from_min_size(
        egui::pos2(rect.min.x, rect.min.y + 1.0),
        Vec2::new(rect.width() * 0.46, 4.5),
    );
    let body_rect = egui::Rect::from_min_max(
        egui::pos2(rect.min.x, rect.min.y + 4.0),
        egui::pos2(rect.max.x, rect.max.y - 1.0),
    );
    painter.rect_filled(tab_rect, CornerRadius::same(2), top_color);
    painter.rect_filled(body_rect, CornerRadius::same(3), body_color);
}

fn draw_file_icon(painter: &egui::Painter, rect: egui::Rect, filename: &str) {
    let r = egui::Rect::from_min_max(
        egui::pos2(rect.min.x + 2.0, rect.min.y + 1.0),
        egui::pos2(rect.max.x - 2.0, rect.max.y - 1.0),
    );
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let accent = match ext.as_str() {
        "pdf" => Color32::from_rgb(235, 87, 87),
        "png" | "jpg" | "jpeg" | "svg" | "webp" | "gif" => STATUS_SUCCESS,
        "zip" | "tar" | "gz" | "7z" => STATUS_WARNING,
        "md" | "txt" | "doc" | "docx" => PROTON_PURPLE_HOVER,
        _ => Color32::from_rgb(154, 148, 176),
    };
    painter.rect_filled(r, CornerRadius::same(2), Color32::from_rgb(44, 39, 62));
    painter.rect_stroke(
        r,
        CornerRadius::same(2),
        Stroke::new(1.3_f32, accent),
        egui::StrokeKind::Inside,
    );
    // Two tiny horizontal text lines inside the document icon
    painter.line_segment(
        [
            egui::pos2(r.min.x + 3.5, r.min.y + 6.0),
            egui::pos2(r.max.x - 3.5, r.min.y + 6.0),
        ],
        Stroke::new(1.2_f32, accent),
    );
    painter.line_segment(
        [
            egui::pos2(r.min.x + 3.5, r.min.y + 9.5),
            egui::pos2(r.max.x - 5.5, r.min.y + 9.5),
        ],
        Stroke::new(1.2_f32, accent),
    );
}

fn format_iso_date(iso: &str) -> String {
    // e.g. "2026-05-07T18:55:25.000Z" -> "2026-05-07  18:55"
    if iso.len() >= 16 {
        let date_part = &iso[0..10];
        let time_part = &iso[11..16];
        format!("{date_part}  {time_part}")
    } else if iso.is_empty() {
        "—".to_string()
    } else {
        iso.to_string()
    }
}

fn truncate_middle(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let head = max_chars / 2 - 1;
    let tail = max_chars - head - 1;
    let start: String = chars[..head].iter().collect();
    let end: String = chars[chars.len() - tail..].iter().collect();
    format!("{start}…{end}")
}

fn try_autostart_daemon() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static TRIED: AtomicBool = AtomicBool::new(false);
    if TRIED.swap(true, Ordering::SeqCst) {
        return;
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("protondrive"));
            candidates.push(dir.join("proton-drive-ubuntu"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let home_path = std::path::PathBuf::from(home);
        candidates.push(home_path.join(".local/bin/protondrive"));
    }
    candidates.push(std::path::PathBuf::from("/usr/bin/protondrive"));
    candidates.push(std::path::PathBuf::from("protondrive"));

    for bin in candidates {
        if Command::new(&bin)
            .arg("daemon")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok()
        {
            thread::sleep(Duration::from_millis(900));
            break;
        }
    }
}

fn worker_loop(rx: Receiver<WorkerCommand>, tx: Sender<WorkerEvent>, ctx: egui::Context) {
    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::RefreshAll => {
                let mut status = fetch_status();
                if status.is_err() {
                    try_autostart_daemon();
                    status = fetch_status();
                }

                let activity = fetch_activity();

                let _ = tx.send(WorkerEvent::StatusAndActivity { status, activity });
                ctx.request_repaint();
            }
            WorkerCommand::TriggerSync => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/sync")).call();
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: fetch_status(),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::SetPaused(paused) => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/pause"))
                    .send_json(serde_json::json!({ "paused": paused }));
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: fetch_status(),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::StartLogin => {
                if let Ok(resp) = ureq::post(&format!("{DAEMON_URL}/api/auth/login")).call() {
                    if let Ok(val) = resp.into_json::<serde_json::Value>() {
                        let url = val
                            .get("signInUrl")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send(WorkerEvent::LoginStarted(url));
                        ctx.request_repaint();
                    }
                }
            }
            WorkerCommand::Logout => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/auth/logout")).call();
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: fetch_status(),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::LoadRemotePath(path) => {
                let url = format!("{DAEMON_URL}/api/remote/list?path={path}");
                let res = ureq::get(&url)
                    .call()
                    .map_err(|e| e.to_string())
                    .and_then(|r| r.into_json::<RemoteListResponse>().map_err(|e| e.to_string()));
                let _ = tx.send(WorkerEvent::RemoteLoaded(res));
                ctx.request_repaint();
            }
            WorkerCommand::CreateRemoteFolder { parent_path, name } => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/remote/mkdir")).send_json(
                    serde_json::json!({
                        "parentPath": parent_path,
                        "name": name,
                    }),
                );
                let url = format!("{DAEMON_URL}/api/remote/list?path={parent_path}");
                let res = ureq::get(&url)
                    .call()
                    .map_err(|e| e.to_string())
                    .and_then(|r| r.into_json::<RemoteListResponse>().map_err(|e| e.to_string()));
                let _ = tx.send(WorkerEvent::RemoteLoaded(res));
                ctx.request_repaint();
            }
            WorkerCommand::LoadSelectiveFolders => {
                if let Ok(resp) = ureq::get(&format!("{DAEMON_URL}/api/selective-sync/folders")).call()
                {
                    if let Ok(parsed) = resp.into_json::<SelectiveFoldersResponse>() {
                        let _ = tx.send(WorkerEvent::SelectiveLoaded(parsed.folders));
                        ctx.request_repaint();
                    }
                }
            }
            WorkerCommand::SaveSettings(payload) => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/settings")).send_json(payload);
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: fetch_status(),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::LoadConflicts => {
                if let Ok(resp) = ureq::get(&format!("{DAEMON_URL}/api/conflicts")).call() {
                    if let Ok(list) = resp.into_json::<Vec<ConflictRecord>>() {
                        let _ = tx.send(WorkerEvent::ConflictsLoaded(list));
                        ctx.request_repaint();
                    }
                }
            }
            WorkerCommand::ResolveConflict { id, choice } => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/conflicts/resolve")).send_json(
                    serde_json::json!({
                        "id": id,
                        "choice": choice,
                    }),
                );
                if let Ok(resp) = ureq::get(&format!("{DAEMON_URL}/api/conflicts")).call() {
                    if let Ok(list) = resp.into_json::<Vec<ConflictRecord>>() {
                        let _ = tx.send(WorkerEvent::ConflictsLoaded(list));
                        ctx.request_repaint();
                    }
                }
            }
        }
    }
}

fn fetch_status() -> Result<DaemonStatus, String> {
    ureq::get(&format!("{DAEMON_URL}/api/status"))
        .timeout(Duration::from_millis(1200))
        .call()
        .map_err(|e| e.to_string())
        .and_then(|r| r.into_json::<DaemonStatus>().map_err(|e| e.to_string()))
}

fn fetch_activity() -> Vec<ActivityRecord> {
    ureq::get(&format!("{DAEMON_URL}/api/activity?limit=40"))
        .timeout(Duration::from_millis(1200))
        .call()
        .ok()
        .and_then(|r| r.into_json::<Vec<ActivityRecord>>().ok())
        .unwrap_or_default()
}

fn try_autostart_tray() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static TRIED_TRAY: AtomicBool = AtomicBool::new(false);
    if TRIED_TRAY.swap(true, Ordering::SeqCst) {
        return;
    }

    let mut script_candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            script_candidates.push(dir.join("../linux/tray/proton_drive_tray.py"));
            script_candidates.push(dir.join("../share/protondrive/proton_drive_tray.py"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let hp = std::path::PathBuf::from(home);
        script_candidates.push(hp.join(".local/share/protondrive/proton_drive_tray.py"));
    }
    script_candidates.push(std::path::PathBuf::from(
        "/usr/share/protondrive/proton_drive_tray.py",
    ));

    for script in script_candidates {
        if script.is_file() {
            let _ = Command::new("python3")
                .arg(&script)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            break;
        }
    }
}

const USAGE: &str = "\
protondrive-gui — Proton Drive native Linux desktop client

USAGE:
  protondrive-gui [OPTIONS]

OPTIONS:
  --tab <TAB>           initial tab (overview | browser | selective | conflicts | settings)
  --screenshot <PATH>   render UI, save a PNG screenshot to PATH, and exit
  --version             print the version
  -h, --help            print this help
";

fn main() -> eframe::Result {
    let mut screenshot_target: Option<String> = None;
    let mut initial_tab = NavTab::Overview;
    let mut initial_account_menu = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--screenshot" => {
                screenshot_target = args.next();
            }
            "--account-menu" => {
                initial_account_menu = true;
            }
            "--tab" => {
                if let Some(t) = args.next() {
                    initial_tab = match t.as_str() {
                        "browser" | "cloud" => NavTab::CloudBrowser,
                        "selective" => NavTab::SelectiveSync,
                        "conflicts" => NavTab::Conflicts,
                        "settings" => NavTab::Settings,
                        _ => NavTab::Overview,
                    };
                }
            }
            "--version" | "-V" => {
                println!("protondrive-gui {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--help" | "-h" => {
                print!("{USAGE}");
                return Ok(());
            }
            _ => {}
        }
    }

    if screenshot_target.is_none() {
        try_autostart_tray();
    }

    let saved_geom = load_window_geometry();
    let initial_size = if screenshot_target.is_some() {
        [1440.0, 900.0]
    } else if saved_geom.maximized {
        [1920.0, 1080.0]
    } else {
        [saved_geom.width, saved_geom.height]
    };

    let mut viewport = egui::ViewportBuilder::default()
        .with_title("Proton Drive")
        .with_app_id("ch.proton.drive")
        .with_inner_size(initial_size)
        .with_min_inner_size([840.0, 540.0]);

    if screenshot_target.is_none() {
        viewport = viewport.with_maximized(saved_geom.maximized);
        if !saved_geom.maximized {
            if let Some(pos) = saved_geom.position {
                viewport = viewport.with_position(pos);
            }
        }
    }

    if let Some(icon) = load_app_icon() {
        viewport = viewport.with_icon(icon);
    }

    let mut options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    // Match wordcraft: use XWayland when DISPLAY is set so window icon and WM_CLASS work reliably across Linux desktop environments
    if std::env::var_os("DISPLAY").is_some() && std::env::var_os("PROTONDRIVE_WAYLAND").is_none() {
        options.event_loop_builder = Some(Box::new(|b| {
            use winit::platform::x11::EventLoopBuilderExtX11;
            b.with_x11();
        }));
    }

    eframe::run_native(
        "Proton Drive",
        options,
        Box::new(move |cc| {
            Ok(Box::new(ProtonDriveNativeApp::new(
                cc,
                screenshot_target,
                initial_tab,
                initial_account_menu,
                saved_geom,
            )))
        }),
    )
}
