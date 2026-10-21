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

// Official Proton Carbon Dark Palette
const BG_CANVAS: Color32 = Color32::from_rgb(22, 20, 28); // #16141C
const BG_SIDEBAR: Color32 = Color32::from_rgb(27, 24, 36); // #1B1824
const BG_CARD: Color32 = Color32::from_rgb(33, 30, 44); // #211E2C
const BG_CARD_ALT: Color32 = Color32::from_rgb(41, 37, 56); // #292538
const BG_INPUT: Color32 = Color32::from_rgb(18, 16, 24); // #121018
const BORDER_SUBTLE: Color32 = Color32::from_rgb(52, 47, 71); // #342F47
const TEXT_PRIMARY: Color32 = Color32::from_rgb(247, 246, 252);
const TEXT_MUTED: Color32 = Color32::from_rgb(167, 164, 181);
const PROTON_PURPLE: Color32 = Color32::from_rgb(109, 74, 255); // #6D4AFF
const PROTON_PURPLE_HOVER: Color32 = Color32::from_rgb(126, 94, 255); // #7E5EFF
const PROTON_PURPLE_SOFT: Color32 = Color32::from_rgb(45, 34, 88); // Active nav pill
const PROTON_PURPLE_TEXT: Color32 = Color32::from_rgb(206, 194, 255);
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
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    state: String,
    current_action: Option<String>,
    logged_in: bool,
    sync_dir: String,
    active_transfers: Vec<ActiveTransfer>,
    stats: SummaryStats,
    settings: SyncSettings,
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
            .exact_width(248.0)
            .frame(
                Frame::NONE
                    .fill(BG_SIDEBAR)
                    .inner_margin(Margin::symmetric(16, 20))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE)),
            )
            .show(ctx, |ui| {
                // Brand Header
                ui.horizontal(|ui| {
                    if let Some(tex) = &self.logo_texture {
                        ui.add(
                            egui::Image::new(tex)
                                .fit_to_exact_size(Vec2::new(36.0, 36.0))
                                .corner_radius(CornerRadius::same(8)),
                        );
                    }
                    ui.add_space(6.0);
                    ui.vertical(|ui| {
                        ui.label(
                            RichText::new("Proton Drive")
                                .size(18.0)
                                .strong()
                                .color(TEXT_PRIMARY),
                        );
                        ui.label(
                            RichText::new("Encrypted Cloud Sync")
                                .size(11.5)
                                .color(TEXT_MUTED),
                        );
                    });
                });

                ui.add_space(20.0);

                // Primary CTA button ("Sync Now")
                let sync_btn = egui::Button::new(
                    RichText::new("↻  Sync Now")
                        .size(14.0)
                        .strong()
                        .color(Color32::WHITE),
                )
                .fill(PROTON_PURPLE)
                .corner_radius(CornerRadius::same(8))
                .min_size(Vec2::new(ui.available_width(), 38.0));

                if ui.add(sync_btn).clicked() {
                    let _ = self.tx.send(WorkerCommand::TriggerSync);
                }

                ui.add_space(18.0);

                // Navigation Links
                let nav_items = [
                    (NavTab::Overview, "My Files & Activity", 0u64),
                    (NavTab::CloudBrowser, "Cloud Browser", 0u64),
                    (NavTab::SelectiveSync, "Selective Sync", 0u64),
                    (
                        NavTab::Conflicts,
                        "Conflicts",
                        self.status.stats.unresolved_conflicts,
                    ),
                    (NavTab::Settings, "Settings", 0u64),
                ];

                for (tab, label, badge) in nav_items {
                    let active = self.tab == tab;
                    let fill = if active {
                        PROTON_PURPLE_SOFT
                    } else {
                        Color32::TRANSPARENT
                    };
                    let text_color = if active {
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
                                let text = if active {
                                    RichText::new(label).size(14.0).strong().color(text_color)
                                } else {
                                    RichText::new(label).size(14.0).color(text_color)
                                };
                                ui.label(text);
                                if badge > 0 {
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        Frame::NONE
                                            .fill(STATUS_DANGER)
                                            .corner_radius(CornerRadius::same(10))
                                            .inner_margin(Margin::symmetric(7, 2))
                                            .show(ui, |ui| {
                                                ui.label(
                                                    RichText::new(badge.to_string())
                                                        .size(11.0)
                                                        .strong()
                                                        .color(Color32::WHITE),
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
                    ui.add_space(4.0);
                }

                // Bottom Status & Storage Summary Card in Sidebar
                let remaining_h = (ui.available_height() - 108.0).max(12.0);
                ui.add_space(remaining_h);
                Frame::NONE
                    .fill(BG_CARD)
                    .corner_radius(CornerRadius::same(10))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                    .inner_margin(Margin::same(12))
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        ui.label(
                            RichText::new("Local Sync Folder")
                                .size(12.0)
                                .strong()
                                .color(TEXT_PRIMARY),
                        );
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new(format!(
                                "{} synced  •  {} files",
                                format_bytes(self.status.stats.total_bytes),
                                self.status.stats.total_files
                            ))
                            .size(11.5)
                            .color(TEXT_MUTED),
                        );
                        ui.add_space(8.0);
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("Open ~/ProtonDrive")
                                        .size(12.0)
                                        .strong()
                                        .color(TEXT_PRIMARY),
                                )
                                .fill(BG_CARD_ALT)
                                .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                                .corner_radius(CornerRadius::same(6))
                                .min_size(Vec2::new(ui.available_width(), 30.0)),
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
                    });
            });
    }

    fn render_top_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let title = match self.tab {
                NavTab::Overview => "My Files & Activity",
                NavTab::CloudBrowser => "Cloud Browser",
                NavTab::SelectiveSync => "Selective Sync",
                NavTab::Conflicts => "Conflict Resolution",
                NavTab::Settings => "Settings",
            };
            ui.label(
                RichText::new(title)
                    .size(22.0)
                    .strong()
                    .color(TEXT_PRIMARY),
            );

            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let paused = self.status.settings.paused;
                let pause_label = if paused { "Resume Sync" } else { "Pause Sync" };
                if ui
                    .add(
                        egui::Button::new(RichText::new(pause_label).size(13.0).color(TEXT_PRIMARY))
                            .fill(BG_CARD_ALT)
                            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                            .corner_radius(CornerRadius::same(8))
                            .min_size(Vec2::new(105.0, 32.0)),
                    )
                    .clicked()
                {
                    let _ = self.tx.send(WorkerCommand::SetPaused(!paused));
                }

                ui.add_space(8.0);

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
                    (PROTON_PURPLE_HOVER, truncate_middle(act, 42))
                } else if self.status.state == "error" {
                    (STATUS_DANGER, "Sync Error".to_string())
                } else {
                    (STATUS_SUCCESS, "Up to date".to_string())
                };

                Frame::NONE
                    .fill(BG_CARD)
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                    .corner_radius(CornerRadius::same(99))
                    .inner_margin(Margin::symmetric(14, 6))
                    .show(ui, |ui| {
                        ui.label(RichText::new(status_text).size(12.5).color(TEXT_PRIMARY));
                        ui.add_space(4.0);
                        let (rect, _) =
                            ui.allocate_exact_size(Vec2::new(8.0, 8.0), Sense::hover());
                        ui.painter().circle_filled(rect.center(), 4.0, dot_color);
                    });
            });
        });
    }

    fn render_overview_tab(&mut self, ui: &mut egui::Ui) {
        // Account Card
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new("Proton Account")
                            .size(15.0)
                            .strong()
                            .color(TEXT_PRIMARY),
                    );
                    ui.add_space(4.0);
                    if self.status.logged_in {
                        ui.horizontal(|ui| {
                            let (rect, _) =
                                ui.allocate_exact_size(Vec2::new(8.0, 8.0), Sense::hover());
                            ui.painter()
                                .circle_filled(rect.center(), 4.0, STATUS_SUCCESS);
                            ui.add_space(4.0);
                            ui.label(
                                RichText::new("Connected to Proton Drive  •  Syncing ~/ProtonDrive")
                                    .size(13.0)
                                    .color(STATUS_SUCCESS),
                            );
                        });
                    } else {
                        ui.label(
                            RichText::new("Sign in with your Proton account in the browser to begin syncing.")
                                .size(13.0)
                                .color(TEXT_MUTED),
                        );
                    }
                });

                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if self.status.logged_in {
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new("Sign Out").size(12.5).color(STATUS_DANGER),
                                )
                                .fill(Color32::from_rgba_unmultiplied(220, 50, 81, 28))
                                .stroke(Stroke::new(1.0_f32, STATUS_DANGER))
                                .corner_radius(CornerRadius::same(8))
                                .min_size(Vec2::new(90.0, 32.0)),
                            )
                            .clicked()
                        {
                            let _ = self.tx.send(WorkerCommand::Logout);
                        }
                    } else if ui
                        .add(
                            egui::Button::new(
                                RichText::new("Sign In").size(13.0).strong().color(Color32::WHITE),
                            )
                            .fill(PROTON_PURPLE)
                            .corner_radius(CornerRadius::same(8))
                            .min_size(Vec2::new(100.0, 34.0)),
                        )
                        .clicked()
                    {
                        let _ = self.tx.send(WorkerCommand::StartLogin);
                    }
                });
            });

            if let Some(url) = &self.login_url {
                ui.add_space(8.0);
                ui.label(
                    RichText::new(format!("Sign-in URL opened in browser: {url}"))
                        .size(12.0)
                        .color(PROTON_PURPLE_TEXT),
                );
            }
        });

        ui.add_space(14.0);

        // 4 Stat Metric Cards
        ui.columns(4, |cols| {
            render_stat_card(
                &mut cols[0],
                "Synced Files",
                &self.status.stats.total_files.to_string(),
            );
            render_stat_card(
                &mut cols[1],
                "Synced Folders",
                &self.status.stats.total_folders.to_string(),
            );
            render_stat_card(
                &mut cols[2],
                "Local Synced Size",
                &format_bytes(self.status.stats.total_bytes),
            );
            render_stat_card(
                &mut cols[3],
                "Conflicts",
                &self.status.stats.unresolved_conflicts.to_string(),
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

        // Recent Sync Activity Card
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(
                RichText::new("Recent Activity")
                    .size(15.5)
                    .strong()
                    .color(TEXT_PRIMARY),
            );
            ui.add_space(12.0);

            ScrollArea::vertical()
                .max_height(ui.available_height() - 10.0)
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
                        egui::Grid::new("activity_unified_grid")
                            .num_columns(3)
                            .spacing([24.0, 10.0])
                            .min_col_width(90.0)
                            .striped(true)
                            .show(ui, |ui| {
                                ui.label(
                                    RichText::new("Action").size(12.0).strong().color(TEXT_MUTED),
                                );
                                ui.label(
                                    RichText::new("File / Folder")
                                        .size(12.0)
                                        .strong()
                                        .color(TEXT_MUTED),
                                );
                                ui.label(
                                    RichText::new("Details")
                                        .size(12.0)
                                        .strong()
                                        .color(TEXT_MUTED),
                                );
                                ui.end_row();

                                for act in self.activities.iter().take(40) {
                                    let pill_color = match act.action.as_str() {
                                        "upload" => PROTON_PURPLE,
                                        "download" => STATUS_SUCCESS,
                                        "error" | "conflict" => STATUS_DANGER,
                                        _ => BG_CARD_ALT,
                                    };
                                    Frame::NONE
                                        .fill(pill_color)
                                        .corner_radius(CornerRadius::same(6))
                                        .inner_margin(Margin::symmetric(8, 3))
                                        .show(ui, |ui| {
                                            ui.label(
                                                RichText::new(&act.action)
                                                    .size(11.5)
                                                    .strong()
                                                    .color(Color32::WHITE),
                                            );
                                        });

                                    ui.label(
                                        RichText::new(truncate_middle(&act.local_rel_path, 56))
                                            .size(13.0)
                                            .color(TEXT_PRIMARY),
                                    );
                                    ui.label(
                                        RichText::new(&act.details).size(12.5).color(TEXT_MUTED),
                                    );
                                    ui.end_row();
                                }
                            });
                    }
                });
        });
    }

    fn render_browser_tab(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.horizontal(|ui| {
                if ui
                    .add(
                        egui::Button::new(RichText::new("↑ Up").size(13.0).color(TEXT_PRIMARY))
                            .fill(BG_CARD_ALT)
                            .corner_radius(CornerRadius::same(6))
                            .min_size(Vec2::new(64.0, 30.0)),
                    )
                    .clicked()
                {
                    let parts: Vec<&str> = self
                        .remote_path
                        .split('/')
                        .filter(|s| !s.is_empty())
                        .collect();
                    if parts.len() > 1 {
                        let parent = format!("/{}", parts[..parts.len() - 1].join("/"));
                        self.remote_loading = true;
                        let _ = self.tx.send(WorkerCommand::LoadRemotePath(parent));
                    }
                }

                Frame::NONE
                    .fill(BG_INPUT)
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE))
                    .corner_radius(CornerRadius::same(6))
                    .inner_margin(Margin::symmetric(12, 6))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new(&self.remote_path)
                                .font(FontId::new(13.0, FontFamily::Monospace))
                                .color(PROTON_PURPLE_TEXT),
                        );
                    });

                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui
                        .add(
                            egui::Button::new(
                                RichText::new("Refresh").size(13.0).strong().color(Color32::WHITE),
                            )
                            .fill(PROTON_PURPLE)
                            .corner_radius(CornerRadius::same(6))
                            .min_size(Vec2::new(80.0, 30.0)),
                        )
                        .clicked()
                    {
                        self.remote_loading = true;
                        let _ = self
                            .tx
                            .send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
                    }

                    if ui
                        .add(
                            egui::Button::new(
                                RichText::new("+ New Folder").size(13.0).color(TEXT_PRIMARY),
                            )
                            .fill(BG_CARD_ALT)
                            .corner_radius(CornerRadius::same(6))
                            .min_size(Vec2::new(105.0, 30.0)),
                        )
                        .clicked()
                    {
                        self.show_new_folder_modal = !self.show_new_folder_modal;
                    }
                });
            });

            if self.show_new_folder_modal {
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Folder Name:").size(13.0).color(TEXT_MUTED));
                    ui.add(
                        egui::TextEdit::singleline(&mut self.new_folder_name)
                            .desired_width(220.0),
                    );
                    if ui
                        .add(
                            egui::Button::new(
                                RichText::new("Create").size(12.5).color(Color32::WHITE),
                            )
                            .fill(PROTON_PURPLE),
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
                });
            }

            ui.add_space(12.0);
            ui.separator();
            ui.add_space(8.0);

            if self.remote_loading {
                ui.label(RichText::new("Loading remote folder...").color(TEXT_MUTED));
            } else if let Some(err) = &self.remote_error {
                ui.label(RichText::new(err).color(STATUS_DANGER));
            } else if self.remote_items.is_empty() {
                ui.label(RichText::new("This folder is empty.").color(TEXT_MUTED));
            } else {
                ScrollArea::vertical().show(ui, |ui| {
                    let items = self.remote_items.clone();
                    for item in items {
                        let is_folder = item.item_type == "folder";
                        let resp = Frame::NONE
                            .fill(BG_CARD_ALT)
                            .corner_radius(CornerRadius::same(8))
                            .inner_margin(Margin::symmetric(12, 9))
                            .show(ui, |ui| {
                                ui.set_min_width(ui.available_width());
                                ui.horizontal(|ui| {
                                    let (rect, _) = ui.allocate_exact_size(Vec2::new(14.0, 12.0), Sense::hover());
                                    if is_folder {
                                        ui.painter().rect_filled(rect, CornerRadius::same(3), PROTON_PURPLE);
                                    } else {
                                        ui.painter().rect_stroke(rect, CornerRadius::same(2), Stroke::new(1.5_f32, TEXT_MUTED), egui::StrokeKind::Inside);
                                    }
                                    ui.add_space(6.0);
                                    let name_color = if is_folder {
                                        PROTON_PURPLE_TEXT
                                    } else {
                                        TEXT_PRIMARY
                                    };
                                    ui.label(
                                        RichText::new(&item.name)
                                            .size(13.5)
                                            .strong()
                                            .color(name_color),
                                    );
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if !is_folder {
                                            ui.label(
                                                RichText::new(format_bytes(item.size))
                                                    .size(12.0)
                                                    .color(TEXT_MUTED),
                                            );
                                        } else {
                                            ui.label(
                                                RichText::new("Folder")
                                                    .size(12.0)
                                                    .color(TEXT_MUTED),
                                            );
                                        }
                                    });
                                });
                            })
                            .response
                            .interact(Sense::click());

                        if is_folder && resp.clicked() {
                            let next = format!(
                                "{}/{}",
                                self.remote_path.trim_end_matches('/'),
                                item.name
                            );
                            self.remote_loading = true;
                            let _ = self.tx.send(WorkerCommand::LoadRemotePath(next));
                        }
                        ui.add_space(6.0);
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
                    .size(15.5)
                    .strong()
                    .color(TEXT_PRIMARY),
            );
            ui.add_space(14.0);

            ui.label(RichText::new("Local Sync Folder").size(13.0).color(TEXT_MUTED));
            ui.add_space(4.0);
            if ui
                .add(
                    egui::TextEdit::singleline(&mut self.edit_sync_dir)
                        .desired_width(f32::INFINITY),
                )
                .changed()
            {
                self.settings_dirty = true;
            }

            ui.add_space(12.0);
            ui.label(
                RichText::new("Conflict Resolution Strategy")
                    .size(13.0)
                    .color(TEXT_MUTED),
            );
            ui.add_space(4.0);
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

            ui.add_space(12.0);
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

            ui.add_space(16.0);
            if ui
                .add(
                    egui::Button::new(
                        RichText::new("Save Preferences")
                            .size(13.5)
                            .strong()
                            .color(Color32::WHITE),
                    )
                    .fill(PROTON_PURPLE)
                    .corner_radius(CornerRadius::same(8))
                    .min_size(Vec2::new(150.0, 36.0)),
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

        egui::CentralPanel::default()
            .frame(
                Frame::NONE
                    .fill(BG_CANVAS)
                    .inner_margin(Margin::symmetric(28, 22)),
            )
            .show(ctx, |ui| {
                self.render_top_bar(ui);
                ui.add_space(18.0);

                match self.tab {
                    NavTab::Overview => self.render_overview_tab(ui),
                    NavTab::CloudBrowser => self.render_browser_tab(ui),
                    NavTab::SelectiveSync => self.render_selective_tab(ui),
                    NavTab::Conflicts => self.render_conflicts_tab(ui),
                    NavTab::Settings => self.render_settings_tab(ui),
                }
            });

        // Handle --screenshot <path> for automated visual inspection
        if let Some(target_path) = self.screenshot_target.clone() {
            let ready = if self.tab == NavTab::SelectiveSync {
                (!self.selective_folders.is_empty() && self.frames_rendered >= 6)
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
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--screenshot" => {
                screenshot_target = args.next();
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
                saved_geom,
            )))
        }),
    )
}
