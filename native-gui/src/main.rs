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

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

static IS_LIGHT_MODE: AtomicBool = AtomicBool::new(false);
static SYSTEM_LIGHT_MODE: AtomicBool = AtomicBool::new(false);

#[inline]
fn is_light_mode() -> bool {
    IS_LIGHT_MODE.load(AtomicOrdering::Relaxed)
}

fn detect_system_light_mode() -> bool {
    if let Ok(out) = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if s.contains("prefer-dark") {
                return false;
            }
            if s.contains("prefer-light") || s.contains("default") {
                if let Ok(tk) = Command::new("gsettings")
                    .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
                    .output()
                {
                    let theme_str = String::from_utf8_lossy(&tk.stdout).to_lowercase();
                    if theme_str.contains("-dark") {
                        return false;
                    }
                }
                return true;
            }
        }
    }
    false
}

// Official Proton Carbon (Dark) & Proton Snow (Light) Adaptive Palette
#[inline]
#[allow(non_snake_case)]
fn BG_CANVAS() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(245, 244, 250) // #F5F4FA Proton Snow canvas
    } else {
        Color32::from_rgb(26, 24, 35) // #1A1823 Proton Carbon canvas
    }
}
#[inline]
#[allow(non_snake_case)]
fn BG_SIDEBAR() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(255, 255, 255) // #FFFFFF Crisp white sidebar & header
    } else {
        Color32::from_rgb(20, 18, 27) // #14121B
    }
}
#[inline]
#[allow(non_snake_case)]
fn BG_CARD() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(255, 255, 255) // #FFFFFF
    } else {
        Color32::from_rgb(33, 29, 44) // #211D2C
    }
}
#[inline]
#[allow(non_snake_case)]
fn BG_CARD_ALT() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(240, 238, 248) // #F0EEF8
    } else {
        Color32::from_rgb(42, 37, 56) // #2A2538
    }
}
#[inline]
#[allow(non_snake_case)]
fn BG_INPUT() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(243, 241, 250) // #F3F1FA
    } else {
        Color32::from_rgb(35, 31, 48) // #231F30
    }
}
#[inline]
#[allow(non_snake_case)]
fn BORDER_SUBTLE() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(222, 218, 235) // #DEDAEB
    } else {
        Color32::from_rgb(48, 43, 64) // #302B40
    }
}
#[inline]
#[allow(non_snake_case)]
fn TEXT_PRIMARY() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(28, 24, 43) // #1C182B
    } else {
        Color32::from_rgb(247, 246, 252)
    }
}
#[inline]
#[allow(non_snake_case)]
fn TEXT_MUTED() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(106, 101, 126) // #6A657E
    } else {
        Color32::from_rgb(162, 158, 178)
    }
}
const PROTON_PURPLE: Color32 = Color32::from_rgb(109, 74, 255); // #6D4AFF
const PROTON_PURPLE_HOVER: Color32 = Color32::from_rgb(126, 94, 255); // #7E5EFF
#[inline]
#[allow(non_snake_case)]
fn PROTON_PURPLE_SOFT() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(235, 229, 255) // #EBE5FF
    } else {
        Color32::from_rgb(44, 37, 69) // #2C2545
    }
}
#[inline]
#[allow(non_snake_case)]
fn PROTON_PURPLE_TEXT() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(93, 56, 235) // #5D38EB
    } else {
        Color32::from_rgb(214, 204, 255)
    }
}
const STATUS_SUCCESS: Color32 = Color32::from_rgb(25, 150, 118); // #199676
const STATUS_WARNING: Color32 = Color32::from_rgb(230, 138, 0); // #E68A00
const STATUS_DANGER: Color32 = Color32::from_rgb(220, 50, 81); // #DC3251

#[inline]
fn table_header_bg() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(243, 241, 250)
    } else {
        Color32::from_rgb(26, 23, 36)
    }
}
#[inline]
fn row_hover_bg() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(240, 236, 252)
    } else {
        Color32::from_rgb(43, 38, 60)
    }
}
#[inline]
fn row_divider_color() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(234, 231, 244)
    } else {
        Color32::from_rgb(40, 35, 54)
    }
}
#[inline]
fn btn_secondary_hover_bg() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(228, 224, 242)
    } else {
        Color32::from_rgb(54, 47, 72)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NavTab {
    Overview,
    CloudBrowser,
    Conflicts,
    Settings,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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
    ignore_patterns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTransfer {
    #[allow(dead_code)]
    id: String,
    direction: String,
    rel_path: String,
    bytes_transferred: u64,
    total_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    state: String,
    current_action: Option<String>,
    logged_in: bool,
    sync_dir: String,
    active_transfers: Vec<ActiveTransfer>,
    #[serde(default)]
    syncing_folders: Vec<String>,
    stats: SummaryStats,
    settings: SyncSettings,
    #[serde(default)]
    account: Option<AccountInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRecord {
    #[allow(dead_code)]
    timestamp: u64,
    action: String,
    local_rel_path: String,
    details: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    /// One of pinned, downloaded, online-only, hidden or hiding; older daemons omit it.
    #[serde(default)]
    availability: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Availability {
    Pinned,
    Downloaded,
    OnlineOnly,
    Hidden,
    Hiding,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PillStyle {
    SolidGreen,
    OutlineGreen,
    Muted,
}

/// Maps the daemon's availability string; a missing or unknown value reads as online only.
fn parse_availability(s: Option<&str>) -> Availability {
    match s {
        Some("pinned") => Availability::Pinned,
        Some("downloaded") => Availability::Downloaded,
        Some("hidden") => Availability::Hidden,
        Some("hiding") => Availability::Hiding,
        _ => Availability::OnlineOnly,
    }
}

fn availability_pill(a: Availability) -> (&'static str, PillStyle) {
    match a {
        Availability::Pinned => ("Always keep", PillStyle::SolidGreen),
        Availability::Downloaded => ("Downloaded", PillStyle::OutlineGreen),
        Availability::OnlineOnly => ("Online only", PillStyle::Muted),
        Availability::Hidden => ("Hidden", PillStyle::Muted),
        Availability::Hiding => ("Hiding…", PillStyle::Muted),
    }
}

/// Screenshot-only: a `RemoteListResponse` JSON file that replaces the daemon's listing.
static REMOTE_FIXTURE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn load_remote_fixture(path: &str) -> Result<RemoteListResponse, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("{path}: {e}"))
}

#[derive(Clone, Debug, Deserialize)]
struct RemoteListResponse {
    path: String,
    items: Vec<RemoteItem>,
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
    SaveSettings(serde_json::Value),
    LoadConflicts,
    ResolveConflict { id: u64, choice: String },
}

enum WorkerEvent {
    StatusAndActivity {
        status: Box<Result<DaemonStatus, String>>,
        activity: Vec<ActivityRecord>,
    },
    LoginStarted(String),
    RemoteLoaded(Result<RemoteListResponse, String>),
    ConflictsLoaded(Vec<ConflictRecord>),
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WindowGeometry {
    position: Option<[f32; 2]>,
    width: f32,
    height: f32,
    maximized: bool,
    theme_mode: String,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            position: None,
            width: 1280.0,
            height: 820.0,
            maximized: true,
            theme_mode: "system".to_string(),
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StartupCache {
    status: Option<DaemonStatus>,
    root_items: Vec<RemoteItem>,
    activities: Vec<ActivityRecord>,
}

fn startup_cache_path() -> Option<std::path::PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return Some(std::path::PathBuf::from(xdg).join("protondrive/startup-cache.json"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".config/protondrive/startup-cache.json"))
}

fn load_startup_cache() -> StartupCache {
    if let Some(p) = startup_cache_path() {
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(cache) = serde_json::from_slice::<StartupCache>(&bytes) {
                return cache;
            }
        }
    }
    StartupCache::default()
}

fn save_startup_cache(status: &DaemonStatus, root_items: &[RemoteItem], activities: &[ActivityRecord]) {
    if !status.logged_in {
        return;
    }
    let Some(p) = startup_cache_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let cache = StartupCache {
        status: Some(status.clone()),
        root_items: root_items.to_vec(),
        activities: activities.to_vec(),
    };
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let tmp = p.with_file_name(format!(".startup-cache.json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, &p)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

fn format_remote_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("connection refused") || lower.contains("connection failed") {
        return "Connecting to Proton Drive background service...".to_string();
    }
    if let Some(idx) = raw.find(": ") {
        if raw[..idx].starts_with("http://") || raw[..idx].starts_with("https://") {
            return raw[idx + 2..].to_string();
        }
    }
    raw.to_string()
}

struct ProtonDriveNativeApp {
    tab: NavTab,
    tx: Sender<WorkerCommand>,
    rx: Receiver<WorkerEvent>,
    logo_texture: Option<TextureHandle>,

    daemon_online: bool,
    initial_connecting: bool,
    status: DaemonStatus,
    activities: Vec<ActivityRecord>,
    cached_root_items: Vec<RemoteItem>,
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

    // Ignore patterns editor (Settings)
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
    applied_light_mode: bool,

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
        initial_path: Option<String>,
        window_geometry: WindowGeometry,
    ) -> Self {
        let sys_light = detect_system_light_mode();
        SYSTEM_LIGHT_MODE.store(sys_light, AtomicOrdering::Relaxed);
        let initial_light = match window_geometry.theme_mode.as_str() {
            "light" => true,
            "dark" => false,
            _ => sys_light,
        };
        IS_LIGHT_MODE.store(initial_light, AtomicOrdering::Relaxed);
        configure_proton_theme(&cc.egui_ctx);
        apply_proton_visuals(&cc.egui_ctx, initial_light);

        let logo_texture = load_glyph_texture(&cc.egui_ctx);
        let startup_cache = load_startup_cache();
        let mut initial_status = startup_cache.status.unwrap_or_default();
        if initial_status.state == "syncing" {
            initial_status.state = "idle".to_string();
            initial_status.current_action = None;
        }
        let initial_root_items = startup_cache.root_items;
        let initial_activities = startup_cache.activities;
        let has_cached_items = !initial_root_items.is_empty();

        let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCommand>();
        let (evt_tx, evt_rx) = mpsc::channel::<WorkerEvent>();
        let egui_ctx = cc.egui_ctx.clone();

        thread::spawn(move || {
            worker_loop(cmd_rx, evt_tx, egui_ctx);
        });

        // Ensure RefreshAll (which autostarts the daemon if needed) runs BEFORE LoadRemotePath
        let _ = cmd_tx.send(WorkerCommand::RefreshAll);
        let start_path = initial_path.unwrap_or_else(|| "/my-files".to_string());
        let start_at_root = start_path == "/my-files" || start_path == "/";
        let _ = cmd_tx.send(WorkerCommand::LoadRemotePath(start_path.clone()));
        if initial_tab == NavTab::Conflicts {
            let _ = cmd_tx.send(WorkerCommand::LoadConflicts);
        }

        let edit_sync_dir = initial_status.settings.sync_dir.clone();
        let edit_conflict_strategy = if initial_status.settings.conflict_strategy.is_empty() {
            "keep-both".to_string()
        } else {
            initial_status.settings.conflict_strategy.clone()
        };
        let edit_notifications = initial_status.settings.notifications_enabled;
        let ignore_patterns_text = initial_status.settings.ignore_patterns.join("\n");

        Self {
            tab: initial_tab,
            tx: cmd_tx,
            rx: evt_rx,
            logo_texture,
            daemon_online: initial_status.logged_in,
            initial_connecting: true,
            status: initial_status,
            activities: initial_activities,
            cached_root_items: initial_root_items.clone(),
            login_url: None,
            search_query: String::new(),
            show_account_menu: initial_account_menu,
            remote_path: start_path,
            // The startup cache only holds the root listing, so don't show it under another folder
            remote_items: if start_at_root { initial_root_items } else { Vec::new() },
            remote_loading: !start_at_root || !has_cached_items,
            remote_error: None,
            new_folder_name: String::new(),
            show_new_folder_modal: false,
            ignore_patterns_text,
            settings_dirty: false,
            conflicts: Vec::new(),
            edit_sync_dir,
            edit_conflict_strategy,
            edit_notifications,
            window_geometry,
            maximize_applied_on_open: false,
            applied_light_mode: initial_light,
            screenshot_target,
            frames_rendered: 0,
            screenshot_requested: false,
            last_poll: Instant::now(),
        }
    }

    fn process_worker_events(&mut self) {
        while let Ok(evt) = self.rx.try_recv() {
            match evt {
                WorkerEvent::StatusAndActivity { status, activity } => match *status {
                    Ok(s) => {
                        let was_offline = !self.daemon_online;
                        self.daemon_online = true;
                        self.initial_connecting = false;
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
                        save_startup_cache(&self.status, &self.cached_root_items, &self.activities);

                        // If the daemon just came online or an earlier remote fetch failed, automatically reload
                        if was_offline || self.remote_error.is_some() || (self.remote_items.is_empty() && !self.remote_loading) {
                            self.remote_error = None;
                            if self.remote_items.is_empty() {
                                self.remote_loading = true;
                            }
                            let _ = self.tx.send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
                        }
                    }
                    Err(_) => {
                        self.daemon_online = false;
                        self.initial_connecting = false;
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
                            if (list.path == "/my-files" || list.path == "/")
                                && REMOTE_FIXTURE.get().is_none()
                            {
                                self.cached_root_items = list.items.clone();
                                save_startup_cache(&self.status, &self.cached_root_items, &self.activities);
                            }
                            self.remote_path = list.path;
                            self.remote_items = list.items;
                            self.remote_error = None;
                        }
                        Err(e) => {
                            let is_conn_err = e.to_lowercase().contains("connection refused")
                                || e.to_lowercase().contains("connection failed");
                            if is_conn_err {
                                // Keep showing cached items if available, or show loading state while daemon starts
                                if self.remote_items.is_empty() {
                                    self.remote_loading = true;
                                }
                                self.remote_error = None;
                            } else {
                                self.remote_error = Some(format_remote_error(&e));
                            }
                        }
                    }
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
                    .fill(BG_SIDEBAR())
                    .inner_margin(Margin::symmetric(16, 18))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE())),
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
                            .color(TEXT_PRIMARY()),
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
                let selective_badge = if (self.remote_path == "/my-files" || self.remote_path == "/")
                    && !self.remote_items.is_empty()
                {
                    let root_folders: Vec<&RemoteItem> = self
                        .remote_items
                        .iter()
                        .filter(|i| i.item_type == "folder")
                        .collect();
                    if !root_folders.is_empty() {
                        let inc = root_folders
                            .iter()
                            .filter(|f| {
                                matches!(
                                    parse_availability(f.availability.as_deref()),
                                    Availability::Pinned | Availability::Downloaded
                                )
                            })
                            .count();
                        Some(format!("{inc}/{}", root_folders.len()))
                    } else {
                        None
                    }
                } else {
                    None
                };
                let conflict_badge = if self.status.stats.unresolved_conflicts > 0 {
                    Some(self.status.stats.unresolved_conflicts.to_string())
                } else {
                    None
                };

                let nav_items: [(NavTab, &str, Option<String>, bool); 4] = [
                    (NavTab::CloudBrowser, "My files", selective_badge, false),
                    (NavTab::Overview, "Sync Activity", None, false),
                    (NavTab::Conflicts, "Conflicts", conflict_badge, true),
                    (NavTab::Settings, "Settings", None, false),
                ];

                for (tab, label, badge, is_danger_badge) in nav_items {
                    let active = self.tab == tab;
                    let fill = if active {
                        PROTON_PURPLE_SOFT()
                    } else {
                        Color32::TRANSPARENT
                    };
                    let text_color = if active {
                        TEXT_PRIMARY()
                    } else {
                        TEXT_MUTED()
                    };
                    let icon_color = if active {
                        PROTON_PURPLE_TEXT()
                    } else {
                        TEXT_MUTED()
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
                                            BG_CARD_ALT()
                                        };
                                        let badge_fg = if is_danger_badge {
                                            Color32::WHITE
                                        } else {
                                            TEXT_MUTED()
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
                    BG_CARD(),
                    BG_CARD_ALT(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    TEXT_PRIMARY(),
                    12.5,
                )
                .clicked()
                {
                    let folder = if self.status.sync_dir.is_empty() {
                        "~/ProtonDrive"
                    } else {
                        &self.status.sync_dir
                    };
                    let _ = spawn_reaped(Command::new("xdg-open").arg(folder));
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
                    if is_light_mode() { Color32::from_rgb(225, 221, 238) } else { Color32::from_rgb(46, 41, 62) },
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
                            .color(TEXT_PRIMARY()),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new(env!("CARGO_PKG_VERSION"))
                                .size(11.5)
                                .color(TEXT_MUTED()),
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
                    .color(TEXT_MUTED()),
                );
            });
    }

    fn render_top_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            // Right side first (right to left): avatar, name + email, settings gear, pause, sync status.
            // The search box is added last and takes whatever width is left, so nothing can be drawn
            // over it on narrow windows or while a long status is shown.
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let gap = ui.spacing().item_spacing.x;
                // Narrowest search box worth showing: text field + frame margins, stroke, icon and spacing
                let search_min_w = TOP_BAR_SEARCH_MIN_TEXT_WIDTH + 12.0 * 2.0 + 2.0 + 14.0 + 4.0 + gap * 3.0;
                // Status pill without its text: frame margins, stroke, dot and spacing
                let pill_chrome_w = 12.0 * 2.0 + 2.0 + 4.0 + 8.0 + gap * 2.0;
                let status_font = FontId::new(12.0, FontFamily::Proportional);

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
                } else if self.initial_connecting {
                    (
                        "Proton Drive".to_string(),
                        "Connecting...".to_string(),
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
                let avatar_fill = if is_light_mode() {
                    if self.show_account_menu || avatar_resp.hovered() {
                        Color32::from_rgb(224, 214, 255)
                    } else {
                        Color32::from_rgb(235, 229, 255)
                    }
                } else if self.show_account_menu || avatar_resp.hovered() {
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
                            if is_light_mode() { Color32::from_rgb(168, 146, 245) } else { Color32::from_rgb(92, 74, 156) }
                        },
                    ),
                    egui::StrokeKind::Inside,
                );
                ui.painter().text(
                    avatar_rect.center(),
                    egui::Align2::CENTER_CENTER,
                    &initials,
                    FontId::new(13.0, FontFamily::Proportional),
                    TEXT_PRIMARY(),
                );
                if avatar_resp.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                if avatar_resp.clicked() {
                    self.show_account_menu = !self.show_account_menu;
                }

                ui.add_space(8.0);

                // Stacked Display Name + Email (right-aligned next to avatar, clickable to open account menu).
                // Hidden when there isn't room for it plus the controls and a usable search box; the avatar's
                // account menu still shows both. The longest fixed status is reserved instead of the live one
                // so the name doesn't flicker in and out as sync messages change.
                let name_w = text_width(ui.painter(), &display_name, &FontId::new(13.0, FontFamily::Proportional))
                    .max(text_width(ui.painter(), &email, &FontId::new(11.5, FontFamily::Proportional)))
                    + 1.0;
                let status_reserve_w = text_width(ui.painter(), "Sign in required", &status_font);
                let after_name_w = TOP_BAR_GEAR_SIZE + 10.0 + TOP_BAR_PAUSE_W + 6.0
                    + pill_chrome_w
                    + status_reserve_w
                    + search_min_w
                    + gap * 3.0;
                let show_name = ui.available_width() >= name_w + 12.0 + gap + after_name_w;
                if !show_name && !self.show_account_menu {
                    avatar_resp.on_hover_text(format!("{display_name}\n{email}"));
                }
                if show_name {
                    let name_resp = ui
                        .allocate_ui_with_layout(
                            Vec2::new(name_w, 34.0),
                            Layout::top_down(Align::Max),
                            |ui| {
                                ui.label(
                                    RichText::new(&display_name)
                                        .size(13.0)
                                        .strong()
                                        .color(TEXT_PRIMARY()),
                                );
                                ui.label(RichText::new(&email).size(11.5).color(TEXT_MUTED()));
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

                    ui.add_space(12.0);
                }

                // Settings Icon Button (matching Proton official header cogwheel)
                let (gear_rect, gear_resp) =
                    ui.allocate_exact_size(Vec2::splat(TOP_BAR_GEAR_SIZE), Sense::click());
                if gear_resp.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                    ui.painter().rect_filled(
                        gear_rect,
                        CornerRadius::same(8),
                        BG_CARD_ALT(),
                    );
                }
                let gear_color = if gear_resp.hovered() || self.tab == NavTab::Settings {
                    TEXT_PRIMARY()
                } else {
                    if is_light_mode() { Color32::from_rgb(82, 76, 104) } else { Color32::from_rgb(218, 214, 232) }
                };
                draw_gear_icon(ui.painter(), gear_rect.shrink(7.0), gear_color);
                if gear_resp.on_hover_text("Synchronization Settings").clicked() {
                    self.tab = NavTab::Settings;
                }

                ui.add_space(10.0);

                // Pause / Resume Button (centered text)
                let paused = self.status.settings.paused;
                let pause_label = if paused { "Resume" } else { "Pause" };
                if proton_button(
                    ui,
                    Vec2::new(TOP_BAR_PAUSE_W, 30.0),
                    pause_label,
                    BG_CARD(),
                    BG_CARD_ALT(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    TEXT_PRIMARY(),
                    12.5,
                )
                .clicked()
                {
                    let _ = self.tx.send(WorkerCommand::SetPaused(!paused));
                }

                ui.add_space(6.0);

                // Status Pill
                let (dot_color, status_text) = if !self.daemon_online {
                    if self.initial_connecting {
                        (PROTON_PURPLE_HOVER, "Connecting...".to_string())
                    } else {
                        (STATUS_DANGER, "Daemon Offline".to_string())
                    }
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
                    (PROTON_PURPLE_HOVER, act.to_string())
                } else if self.status.state == "error" {
                    (STATUS_DANGER, "Sync Error".to_string())
                } else {
                    (STATUS_SUCCESS, "Up to date".to_string())
                };

                // Shorten the status to the room left after a minimum-width search box (full text on hover)
                let status_max_w =
                    (ui.available_width() - pill_chrome_w - search_min_w).min(TOP_BAR_STATUS_MAX_WIDTH);
                let shown_status =
                    truncate_middle_to_width(ui.painter(), &status_text, &status_font, status_max_w);
                let pill = Frame::NONE
                    .fill(BG_CARD())
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(12, 6))
                    .show(ui, |ui| {
                        ui.label(RichText::new(&shown_status).size(12.0).color(TEXT_PRIMARY()));
                        ui.add_space(4.0);
                        let (rect, _) =
                            ui.allocate_exact_size(Vec2::new(8.0, 8.0), Sense::hover());
                        ui.painter().circle_filled(rect.center(), 4.0, dot_color);
                    });
                if shown_status != status_text {
                    pill.response.on_hover_text(&status_text);
                }

                // Search / filter input on the left (matching Proton Mail top bar), sized to the space left
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    Frame::NONE
                        .fill(BG_INPUT())
                        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                        .corner_radius(CornerRadius::same(8))
                        .inner_margin(Margin::symmetric(12, 6))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let (s_rect, _) =
                                    ui.allocate_exact_size(Vec2::new(14.0, 14.0), Sense::hover());
                                draw_search_icon(ui.painter(), s_rect, TEXT_MUTED());
                                ui.add_space(4.0);
                                let clear_w = if self.search_query.is_empty() { 0.0 } else { 25.0 };
                                let text_w =
                                    (ui.available_width() - clear_w).clamp(0.0, TOP_BAR_SEARCH_MAX_TEXT_WIDTH);
                                let full_hint = "Search files and sync activity";
                                let hint_font = egui::TextStyle::Body.resolve(ui.style());
                                // TextEdit insets its text (and placeholder) by a 4px margin on each side
                                let hint = if text_width(ui.painter(), full_hint, &hint_font) <= text_w - 8.0 {
                                    full_hint
                                } else {
                                    "Search…"
                                };
                                ui.add(
                                    egui::TextEdit::singleline(&mut self.search_query)
                                        // Stable id: the widgets laid out before it vary (the name block can
                                        // hide), and an auto id would drop focus when they do
                                        .id_salt("top_bar_search")
                                        .hint_text(hint)
                                        .frame(false)
                                        .desired_width(text_w),
                                );
                                if !self.search_query.is_empty()
                                    && ui
                                        .add(
                                            egui::Button::new(
                                                RichText::new("×").size(14.0).color(TEXT_MUTED()),
                                            )
                                            .frame(false),
                                        )
                                        .clicked()
                                {
                                    self.search_query.clear();
                                }
                            });
                        });
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
                    .fill(if is_light_mode() { Color32::WHITE } else { Color32::from_rgb(28, 25, 38) })
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
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
                                            .color(TEXT_MUTED()),
                                    );
                                });
                            });

                        let (sep_rect, _) =
                            ui.allocate_exact_size(Vec2::new(pop_w, 1.0), Sense::hover());
                        ui.painter()
                            .rect_filled(sep_rect, 0, BORDER_SUBTLE());

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
                                            .color(TEXT_PRIMARY()),
                                    );

                                    ui.add_space(2.0);

                                    // Email
                                    ui.label(
                                        RichText::new(&email).size(12.5).color(TEXT_MUTED()),
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
                                        BG_CARD(),
                                        BG_CARD_ALT(),
                                        Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                                        TEXT_PRIMARY(),
                                        13.0,
                                    )
                                    .clicked()
                                    {
                                        let folder = if self.status.sync_dir.is_empty() {
                                            "~/ProtonDrive"
                                        } else {
                                            &self.status.sync_dir
                                        };
                                        let _ = spawn_reaped(Command::new("xdg-open").arg(folder));
                                        self.show_account_menu = false;
                                    }

                                    ui.add_space(8.0);

                                    // Button 2: Sign out / Sign in (outlined with Proton purple border matching Proton Mail)
                                    if self.status.logged_in {
                                        if proton_button(
                                            ui,
                                            Vec2::new(btn_w, 34.0),
                                            "Sign out",
                                            BG_CARD(),
                                            PROTON_PURPLE_SOFT(),
                                            Some(Stroke::new(1.2_f32, PROTON_PURPLE)),
                                            TEXT_PRIMARY(),
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
        // The page scrolls when the window is too short for the stat cards plus a usable activity
        // table; on taller windows the table fills the rest exactly, so no page scrollbar appears.
        let viewport_h = ui.available_height();
        ScrollArea::vertical()
            .id_salt("overview_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| self.render_overview_content(ui, viewport_h));
    }

    fn render_overview_content(&mut self, ui: &mut egui::Ui, viewport_h: f32) {
        let content_top = ui.cursor().top();

        // Section Title Bar
        ui.horizontal(|ui| {
            ui.label(
                RichText::new("Sync Activity & Storage")
                    .size(20.0)
                    .strong()
                    .color(TEXT_PRIMARY()),
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
                    .color(PROTON_PURPLE_TEXT()),
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

        let stat_cards = [
            ("Proton Cloud Storage", cloud_quota_str),
            ("Local Synced Size", format_bytes_precise(self.status.stats.total_bytes)),
            ("Synced Files", self.status.stats.total_files.to_string()),
            ("Synced Folders", self.status.stats.total_folders.to_string()),
        ];
        let spacing = ui.spacing().item_spacing.x;
        let per_row = stat_cards_per_row(ui.painter(), &stat_cards, ui.available_width(), spacing);
        let content_width = stat_card_content_width(ui.available_width(), spacing, per_row);
        // One shared value size so the longest value (usually the quota) fits on a single line
        // and all cards stay visually consistent.
        let value_size = stat_cards
            .iter()
            .map(|(_, value)| {
                fit_font_size(ui.painter(), value, STAT_VALUE_SIZE, STAT_VALUE_MIN_SIZE, content_width)
            })
            .fold(STAT_VALUE_SIZE, f32::min);
        for (row_idx, row) in stat_cards.chunks(per_row).enumerate() {
            if row_idx > 0 {
                // Make the gap between rows match the gap between columns
                ui.add_space((spacing - ui.spacing().item_spacing.y).max(0.0));
            }
            ui.columns(per_row, |cols| {
                for ((label, value), col) in row.iter().zip(cols.iter_mut()) {
                    render_stat_card(col, label, value, value_size);
                }
            });
        }

        // Active Transfers Card (if any)
        if !self.status.active_transfers.is_empty() {
            ui.add_space(14.0);
            card_frame().show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.label(
                    RichText::new("Active Transfers")
                        .size(15.0)
                        .strong()
                        .color(TEXT_PRIMARY()),
                );
                ui.add_space(10.0);
                for t in &self.status.active_transfers {
                    let frac = if t.total_bytes > 0 {
                        (t.bytes_transferred as f32 / t.total_bytes as f32).clamp(0.0, 1.0)
                    } else {
                        0.5
                    };
                    render_transfer_line(ui, t);
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
                        .color(TEXT_PRIMARY()),
                );
                if let Some(acct) = &self.status.account {
                    if acct.used_drive_space > 0 {
                        let usage =
                            format!("Drive Cloud Usage: {}", format_bytes_precise(acct.used_drive_space));
                        let full = format!("{usage}  •  Syncing {}", self.status.sync_dir);
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            // Fit the space left of the title instead of running over it
                            let font = FontId::new(12.0, FontFamily::Proportional);
                            let room = ui.available_width() - 16.0;
                            let shown =
                                activity_header_detail(ui.painter(), &usage, &self.status.sync_dir, &font, room);
                            if !shown.is_empty() {
                                let resp = ui.label(RichText::new(&shown).size(12.0).color(TEXT_MUTED()));
                                if shown != full {
                                    resp.on_hover_text(&full);
                                }
                            }
                        });
                    }
                }
            });
            ui.add_space(12.0);

            // Full-width Column Header Bar for Recent Sync Activity
            let (hdr_rect, _) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::hover());
            ui.painter().rect_filled(
                hdr_rect,
                CornerRadius::same(7),
                table_header_bg(),
            );
            let hdr_y = hdr_rect.center().y;
            let file_col_x = hdr_rect.min.x + 152.0;
            let details_col_x = (hdr_rect.min.x + hdr_rect.width() * 0.44).max(file_col_x + 210.0);
            let time_right_x = hdr_rect.max.x - 16.0;

            ui.painter().text(
                egui::pos2(hdr_rect.min.x + 14.0, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Status",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );
            ui.painter().text(
                egui::pos2(file_col_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "File / Folder",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );
            ui.painter().text(
                egui::pos2(details_col_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Details",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );
            ui.painter().text(
                egui::pos2(time_right_x, hdr_y),
                egui::Align2::RIGHT_CENTER,
                "Time",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );

            ui.add_space(4.0);

            // Fill what's left of the viewport, but never fewer than ~5 rows. min_scrolled_height lets the
            // table be taller than the visible space (egui caps nested scroll areas to it); the page
            // scroll area then scrolls to reveal the rest.
            let used_h = ui.cursor().top() - content_top;
            let table_h = (viewport_h - used_h - card_frame().total_margin().bottom - 10.0)
                .max(ACTIVITY_TABLE_MIN_HEIGHT);
            // While part of the table is off screen the wheel scrolls the page, bringing the table fully into
            // view; only then does the table take the wheel itself
            let table_rect = egui::Rect::from_min_size(ui.cursor().min, Vec2::new(ui.available_width(), table_h));
            // (If the table can never be fully visible, e.g. when zoomed in, it always scrolls itself.)
            let table_in_view = ui.clip_rect().contains_rect(table_rect.shrink(0.5))
                || table_h >= ui.clip_rect().height();
            ScrollArea::vertical()
                .id_salt("activity_table_scroll")
                .max_height(table_h)
                .min_scrolled_height(table_h)
                .enable_scrolling(table_in_view)
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    if self.activities.is_empty() {
                        ui.add_space(16.0);
                        ui.label(
                            RichText::new("No synchronization activity recorded yet.")
                                .size(13.0)
                                .color(TEXT_MUTED()),
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
                            .take(50)
                        {
                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 38.0),
                                Sense::hover(),
                            );
                            if row_resp.hovered() {
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(6),
                                    row_hover_bg(),
                                );
                            }
                            ui.painter().line_segment(
                                [
                                    egui::pos2(row_rect.min.x + 10.0, row_rect.max.y),
                                    egui::pos2(row_rect.max.x - 10.0, row_rect.max.y),
                                ],
                                Stroke::new(1.0_f32, row_divider_color()),
                            );

                            let cy = row_rect.center().y;
                            let r_file_x = row_rect.min.x + 152.0;
                            let r_details_x =
                                (row_rect.min.x + row_rect.width() * 0.44).max(r_file_x + 210.0);
                            let r_time_right_x = row_rect.max.x - 16.0;

                            let (pill_label, pill_bg, pill_fg) = humanize_activity_action(&act.action);
                            let pill_rect = egui::Rect::from_min_size(
                                egui::pos2(row_rect.min.x + 12.0, cy - 11.0),
                                Vec2::new(124.0, 22.0),
                            );
                            ui.painter()
                                .rect_filled(pill_rect, CornerRadius::same(99), pill_bg);
                            ui.painter().text(
                                pill_rect.center(),
                                egui::Align2::CENTER_CENTER,
                                pill_label,
                                FontId::new(11.0, FontFamily::Proportional),
                                pill_fg,
                            );

                            // File / Folder icon + name
                            let is_folder_act = act.action == "mkdir"
                                || act.action == "delete-local" && !act.local_rel_path.contains('.');
                            let ic_rect = egui::Rect::from_center_size(
                                egui::pos2(r_file_x + 9.0, cy),
                                Vec2::new(17.0, 14.5),
                            );
                            if is_folder_act {
                                draw_folder_icon(ui.painter(), ic_rect, act.action != "delete-local");
                            } else {
                                draw_file_icon(ui.painter(), ic_rect, &act.local_rel_path);
                            }

                            // Truncate by measured pixel width so long names/details never spill into the next column
                            let col_gap = 16.0;
                            let name_font = FontId::new(13.0, FontFamily::Proportional);
                            let details_font = FontId::new(12.0, FontFamily::Proportional);
                            let time_font = FontId::new(11.5, FontFamily::Proportional);
                            let time_str = format_relative_timestamp(act.timestamp);
                            let time_w = text_width(ui.painter(), &time_str, &time_font);
                            let name_x = r_file_x + 25.0;
                            let time_left_x = r_time_right_x - time_w - col_gap;
                            // Names stop at Details, or at Time when zoomed in so far that Details collapses
                            let name_max_w = (r_details_x - col_gap).min(time_left_x) - name_x;
                            let details_max_w = time_left_x - r_details_x;
                            let name_text =
                                truncate_middle_to_width(ui.painter(), &act.local_rel_path, &name_font, name_max_w);
                            let details_text =
                                truncate_middle_to_width(ui.painter(), &act.details, &details_font, details_max_w);
                            let truncated = name_text != act.local_rel_path || details_text != act.details;

                            ui.painter().text(
                                egui::pos2(name_x, cy),
                                egui::Align2::LEFT_CENTER,
                                name_text,
                                name_font,
                                TEXT_PRIMARY(),
                            );
                            ui.painter().text(
                                egui::pos2(r_details_x, cy),
                                egui::Align2::LEFT_CENTER,
                                details_text,
                                details_font,
                                TEXT_MUTED(),
                            );
                            ui.painter().text(
                                egui::pos2(r_time_right_x, cy),
                                egui::Align2::RIGHT_CENTER,
                                time_str,
                                time_font,
                                TEXT_MUTED(),
                            );
                            if truncated {
                                row_resp.on_hover_text(format!("{}\n{}", act.local_rel_path, act.details));
                            }
                        }
                    }
                });
        });
    }

    /// My files toolbar, laid out right to left: Refresh, New folder and, when there's room, the
    /// item count.
    fn render_browser_toolbar(&mut self, ui: &mut egui::Ui, count: Option<&str>, navigate_to: &mut Option<String>) {
        if proton_button(
            ui,
            Vec2::new(TOOLBAR_REFRESH_W, 32.0),
            "Refresh",
            PROTON_PURPLE,
            PROTON_PURPLE_HOVER,
            None,
            Color32::WHITE,
            13.0,
        )
        .clicked()
        {
            *navigate_to = Some(self.remote_path.clone());
        }

        ui.add_space(6.0);

        if proton_button(
            ui,
            Vec2::new(TOOLBAR_NEW_FOLDER_W, 32.0),
            "+ New folder",
            BG_CARD_ALT(),
            btn_secondary_hover_bg(),
            Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
            TEXT_PRIMARY(),
            13.0,
        )
        .clicked()
        {
            self.show_new_folder_modal = !self.show_new_folder_modal;
        }

        if !self.remote_items.is_empty() {
            if let Some(count) = count {
                ui.add_space(10.0);
                ui.label(RichText::new(count).size(12.0).color(TEXT_MUTED()));
            }
        }
    }

    fn render_browser_tab(&mut self, ui: &mut egui::Ui) {
        // If there is an active transfer, show a compact live sync banner above My files
        if let Some(t) = self.status.active_transfers.first() {
            let frac = if t.total_bytes > 0 {
                (t.bytes_transferred as f32 / t.total_bytes as f32).clamp(0.0, 1.0)
            } else {
                0.5
            };
            Frame::NONE
                .fill(BG_CARD())
                .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin::symmetric(14, 10))
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    render_transfer_line(ui, t);
                    ui.add_space(4.0);
                    ui.add(
                        egui::ProgressBar::new(frac)
                            .fill(PROTON_PURPLE)
                            .desired_height(5.0)
                            .corner_radius(CornerRadius::same(4)),
                    );
                });
            ui.add_space(10.0);
        }

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

            // Breadcrumbs and toolbar share one row when they fit. On narrow windows the item count is
            // dropped first, then the buttons move to their own row, so nothing spills past the card.
            let gap = ui.spacing().item_spacing.x;
            let crumbs_w = breadcrumbs_width(ui.painter(), &parts, gap);
            let has_items = !self.remote_items.is_empty();
            let buttons_w = TOOLBAR_REFRESH_W + 6.0 + TOOLBAR_NEW_FOLDER_W + gap * 2.0;
            let folder_count = self.remote_items.iter().filter(|i| i.item_type == "folder").count();
            let file_count = self.remote_items.len().saturating_sub(folder_count);
            let count_text = format!("{folder_count} folders  •  {file_count} files");
            let count_w = 10.0 + text_width(ui.painter(), &count_text, &FontId::new(12.0, FontFamily::Proportional)) + gap;
            let available = ui.available_width() - TOOLBAR_FIT_SLACK;
            let one_row = crumbs_w + buttons_w <= available;
            let row_room = if one_row { available - crumbs_w } else { available };
            let count = (has_items && buttons_w + count_w <= row_room).then_some(count_text.as_str());

            if one_row {
                ui.horizontal(|ui| {
                    render_breadcrumbs(ui, &parts, &mut navigate_to);
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        self.render_browser_toolbar(ui, count, &mut navigate_to);
                    });
                });
            } else {
                ui.horizontal_wrapped(|ui| render_breadcrumbs(ui, &parts, &mut navigate_to));
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        self.render_browser_toolbar(ui, count, &mut navigate_to);
                    });
                });
            }

            if let Some(next_path) = navigate_to {
                self.remote_loading = true;
                let _ = self.tx.send(WorkerCommand::LoadRemotePath(next_path));
            }

            if self.show_new_folder_modal {
                ui.add_space(10.0);
                Frame::NONE
                    .fill(BG_INPUT())
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(14, 10))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new("New folder name:")
                                    .size(13.0)
                                    .color(TEXT_MUTED()),
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
                                BG_CARD_ALT(),
                                btn_secondary_hover_bg(),
                                Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                                TEXT_MUTED(),
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
                table_header_bg(),
            );
            let hdr_y = hdr_rect.center().y;
            let date_font = FontId::new(12.0, FontFamily::Proportional);
            let date_w = text_width(ui.painter(), "0000-00-00  00:00", &date_font);
            let short_date_w = text_width(ui.painter(), "0000-00-00", &date_font);
            let hdr_cols = browser_columns(hdr_rect, date_w, short_date_w);

            ui.painter().text(
                egui::pos2(hdr_rect.min.x + 16.0, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Name",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );
            ui.painter().text(
                egui::pos2(hdr_cols.status_x, hdr_y),
                egui::Align2::LEFT_CENTER,
                "Sync Status",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );
            if let Some(mod_x) = hdr_cols.mod_x {
                ui.painter().text(
                    egui::pos2(mod_x, hdr_y),
                    egui::Align2::LEFT_CENTER,
                    "Modified",
                    FontId::new(12.0, FontFamily::Proportional),
                    TEXT_MUTED(),
                );
            }
            ui.painter().text(
                egui::pos2(hdr_cols.size_right_x, hdr_y),
                egui::Align2::RIGHT_CENTER,
                "Size",
                FontId::new(12.0, FontFamily::Proportional),
                TEXT_MUTED(),
            );

            ui.add_space(4.0);

            if self.remote_loading {
                ui.add_space(28.0);
                ui.vertical_centered(|ui| {
                    ui.label(
                        RichText::new("Loading Proton Drive folder contents...")
                            .size(13.5)
                            .color(TEXT_MUTED()),
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
                            .color(TEXT_MUTED()),
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

                let scroll_h = (ui.available_height() - 6.0).max(240.0);

                ScrollArea::vertical()
                    .id_salt("cloud_browser_table_scroll")
                    .max_height(scroll_h)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let mut clicked_folder: Option<String> = None;

                        for item in sorted_items {
                            let is_folder = item.item_type == "folder";
                            let availability = parse_availability(item.availability.as_deref());
                            let is_muted_row =
                                matches!(availability, Availability::Hidden | Availability::Hiding);
                            let is_hidden = availability == Availability::Hidden;
                            let has_local_copy = matches!(
                                availability,
                                Availability::Pinned | Availability::Downloaded
                            );
                            let item_rel = {
                                let dir = self
                                    .remote_path
                                    .strip_prefix("/my-files")
                                    .unwrap_or(&self.remote_path)
                                    .trim_matches('/');
                                if dir.is_empty() {
                                    item.name.clone()
                                } else {
                                    format!("{dir}/{}", item.name)
                                }
                            };

                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 42.0),
                                Sense::click(),
                            );

                            if row_resp.hovered() {
                                if (is_folder && !is_hidden) || (!is_folder && has_local_copy) {
                                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                                }
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(7),
                                    row_hover_bg(),
                                );
                            }

                            // Subtle bottom row separator
                            ui.painter().line_segment(
                                [
                                    egui::pos2(row_rect.min.x + 10.0, row_rect.max.y),
                                    egui::pos2(row_rect.max.x - 10.0, row_rect.max.y),
                                ],
                                Stroke::new(1.0_f32, row_divider_color()),
                            );

                            let row_cy = row_rect.center().y;
                            let row_cols = browser_columns(row_rect, date_w, short_date_w);
                            let row_status_x = row_cols.status_x;

                            // 1. Name Column (Vector Folder/File Icon + Item Name)
                            let ic_rect = egui::Rect::from_center_size(
                                egui::pos2(row_rect.min.x + 26.0, row_cy),
                                Vec2::new(20.0, 17.0),
                            );
                            if is_folder {
                                draw_folder_icon(ui.painter(), ic_rect, has_local_copy);
                            } else {
                                draw_file_icon(ui.painter(), ic_rect, &item.name);
                            }

                            let name_color = if is_muted_row { TEXT_MUTED() } else { TEXT_PRIMARY() };
                            let name_font = FontId::new(13.5, FontFamily::Proportional);
                            let name_text =
                                truncate_middle_to_width(ui.painter(), &item.name, &name_font, row_cols.name_max_w);
                            if is_hidden {
                                let hint = "Hidden from this computer. Right-click to unhide.";
                                let tip = if name_text != item.name {
                                    format!("{}\n{hint}", item.name)
                                } else {
                                    hint.to_string()
                                };
                                row_resp.clone().on_hover_text(tip);
                            } else if name_text != item.name
                                && row_resp.hover_pos().is_some_and(|p| p.x < row_cols.status_x)
                            {
                                row_resp.clone().on_hover_text(&item.name);
                            }
                            ui.painter().text(
                                egui::pos2(row_rect.min.x + 46.0, row_cy),
                                egui::Align2::LEFT_CENTER,
                                name_text,
                                name_font,
                                name_color,
                            );

                            // 2. Availability pill; "↻ Syncing..." overrides it while the item is being transferred
                            let is_syncing = self.status.syncing_folders.iter().any(|f| f == &item_rel)
                                || self.status.active_transfers.iter().any(|t| {
                                    t.rel_path == item_rel
                                        || t.rel_path.starts_with(&format!("{item_rel}/"))
                                });

                            let pill_rect = egui::Rect::from_min_size(
                                egui::pos2(row_status_x, row_cy - 11.0),
                                Vec2::new(TABLE_STATUS_PILL_W, 22.0),
                            );
                            let pill_font = FontId::new(11.0, FontFamily::Proportional);

                            if is_syncing {
                                ui.painter()
                                    .rect_filled(pill_rect, CornerRadius::same(99), PROTON_PURPLE_SOFT());
                                ui.painter().rect_stroke(
                                    pill_rect,
                                    CornerRadius::same(99),
                                    Stroke::new(1.0_f32, PROTON_PURPLE),
                                    egui::StrokeKind::Inside,
                                );
                                ui.painter().text(
                                    pill_rect.center(),
                                    egui::Align2::CENTER_CENTER,
                                    "↻ Syncing...",
                                    pill_font,
                                    PROTON_PURPLE_TEXT(),
                                );
                            } else {
                                let (label, style) = availability_pill(availability);
                                let painter = ui.painter();
                                let round = CornerRadius::same(99);
                                let text_color = match style {
                                    PillStyle::SolidGreen => {
                                        painter.rect_filled(pill_rect, round, STATUS_SUCCESS);
                                        Color32::WHITE
                                    }
                                    PillStyle::OutlineGreen => {
                                        painter.rect_filled(
                                            pill_rect,
                                            round,
                                            Color32::from_rgba_unmultiplied(30, 168, 133, 30),
                                        );
                                        painter.rect_stroke(
                                            pill_rect,
                                            round,
                                            Stroke::new(
                                                1.0_f32,
                                                Color32::from_rgba_unmultiplied(30, 168, 133, 110),
                                            ),
                                            egui::StrokeKind::Inside,
                                        );
                                        STATUS_SUCCESS
                                    }
                                    PillStyle::Muted => {
                                        painter.rect_filled(pill_rect, round, BG_CARD_ALT());
                                        TEXT_MUTED()
                                    }
                                };
                                painter.text(
                                    pill_rect.center(),
                                    egui::Align2::CENTER_CENTER,
                                    label,
                                    pill_font,
                                    text_color,
                                );
                            }

                            // 3. Modified Date Column (date only on narrow windows, dropped on the narrowest)
                            if let Some(mod_x) = row_cols.mod_x {
                                let modified = format_iso_date(&item.modification_time);
                                let modified = if row_cols.date_only {
                                    modified.chars().take(10).collect()
                                } else {
                                    modified
                                };
                                ui.painter().text(
                                    egui::pos2(mod_x, row_cy),
                                    egui::Align2::LEFT_CENTER,
                                    modified,
                                    date_font.clone(),
                                    TEXT_MUTED(),
                                );
                            }

                            // 4. Size Column
                            let size_str = if is_folder {
                                "—".to_string()
                            } else {
                                format_bytes(item.size)
                            };
                            ui.painter().text(
                                egui::pos2(row_cols.size_right_x, row_cy),
                                egui::Align2::RIGHT_CENTER,
                                size_str,
                                FontId::new(12.0, FontFamily::Proportional),
                                TEXT_MUTED(),
                            );

                            if is_folder && !is_hidden && row_resp.clicked() {
                                clicked_folder = Some(format!(
                                    "{}/{}",
                                    self.remote_path.trim_end_matches('/'),
                                    item.name
                                ));
                            } else if !is_folder && has_local_copy && row_resp.clicked() {
                                let rel_sub = self
                                    .remote_path
                                    .strip_prefix("/my-files")
                                    .unwrap_or(&self.remote_path)
                                    .trim_matches('/');
                                let local_target = if rel_sub.is_empty() {
                                    format!("{}/{}", self.status.sync_dir, item.name)
                                } else {
                                    format!("{}/{}/{}", self.status.sync_dir, rel_sub, item.name)
                                };
                                let _ = spawn_reaped(Command::new("xdg-open").arg(local_target));
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

    fn render_conflicts_tab(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(
                RichText::new("File Conflicts")
                    .size(15.5)
                    .strong()
                    .color(TEXT_PRIMARY()),
            );
            ui.add_space(8.0);
            if self.conflicts.is_empty() {
                ui.label(
                    RichText::new("No file conflicts detected.")
                        .size(13.0)
                        .color(TEXT_MUTED()),
                );
            } else {
                for c in self.conflicts.clone() {
                    Frame::NONE
                        .fill(BG_CARD_ALT())
                        .corner_radius(CornerRadius::same(8))
                        .inner_margin(Margin::symmetric(12, 10))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new(&c.local_rel_path)
                                        .size(13.5)
                                        .strong()
                                        .color(TEXT_PRIMARY()),
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
                    .color(TEXT_PRIMARY()),
            );
            ui.add_space(16.0);

            ui.label(RichText::new("Local Sync Folder").size(13.0).color(TEXT_MUTED()));
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
                    BG_CARD_ALT(),
                    btn_secondary_hover_bg(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    TEXT_PRIMARY(),
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
                .color(TEXT_MUTED()),
            );

            ui.add_space(16.0);
            ui.label(
                RichText::new("Appearance Theme")
                    .size(13.0)
                    .color(TEXT_MUTED()),
            );
            ui.add_space(6.0);
            egui::ComboBox::from_id_salt("appearance_theme_combo")
                .selected_text(match self.window_geometry.theme_mode.as_str() {
                    "light" => "Light (Proton Snow)",
                    "dark" => "Dark (Proton Carbon)",
                    _ => "Follow Ubuntu System Theme",
                })
                .width(360.0)
                .show_ui(ui, |ui| {
                    for (val, text) in [
                        ("system", "Follow Ubuntu System Theme"),
                        ("light", "Light (Proton Snow)"),
                        ("dark", "Dark (Proton Carbon)"),
                    ] {
                        if ui
                            .selectable_value(
                                &mut self.window_geometry.theme_mode,
                                val.to_string(),
                                text,
                            )
                            .changed()
                        {
                            save_window_geometry(&self.window_geometry);
                        }
                    }
                });

            ui.add_space(16.0);
            ui.label(
                RichText::new("Conflict Resolution Strategy")
                    .size(13.0)
                    .color(TEXT_MUTED()),
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
                        .color(TEXT_PRIMARY()),
                )
                .changed()
            {
                self.settings_dirty = true;
            }

            ui.add_space(20.0);
            ui.separator();
            ui.add_space(16.0);

            ui.label(
                RichText::new("Ignore Patterns (Glob)")
                    .size(14.5)
                    .strong()
                    .color(TEXT_PRIMARY()),
            );
            ui.add_space(4.0);
            ui.label(
                RichText::new(
                    "One glob pattern per line. Matching files or folders (e.g. .git, node_modules, *.part) are skipped during two-way sync.",
                )
                .size(12.0)
                .color(TEXT_MUTED()),
            );
            ui.add_space(8.0);
            if ui
                .add(
                    egui::TextEdit::multiline(&mut self.ignore_patterns_text)
                        .desired_rows(8)
                        .desired_width(f32::INFINITY)
                        .font(FontId::new(13.0, FontFamily::Monospace)),
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
                let patterns: Vec<String> = self
                    .ignore_patterns_text
                    .lines()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                self.settings_dirty = false;
                let _ = self.tx.send(WorkerCommand::SaveSettings(serde_json::json!({
                    "syncDir": self.edit_sync_dir,
                    "conflictStrategy": self.edit_conflict_strategy,
                    "notificationsEnabled": self.edit_notifications,
                    "ignorePatterns": patterns,
                })));
            }
        });
    }
}

impl eframe::App for ProtonDriveNativeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.process_worker_events();
        self.frames_rendered += 1;

        let desired_light = match self.window_geometry.theme_mode.as_str() {
            "light" => true,
            "dark" => false,
            _ => SYSTEM_LIGHT_MODE.load(AtomicOrdering::Relaxed),
        };
        if desired_light != self.applied_light_mode {
            self.applied_light_mode = desired_light;
            IS_LIGHT_MODE.store(desired_light, AtomicOrdering::Relaxed);
            apply_proton_visuals(ctx, desired_light);
        }

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
                            ..self.window_geometry.clone()
                        })
                    } else if content_size.x >= 800.0 && content_size.y >= 500.0 {
                        let position = vp.outer_rect.map(|r| [r.min.x, r.min.y]);
                        Some(WindowGeometry {
                            position: position.or(self.window_geometry.position),
                            width: content_size.x.clamp(840.0, 16384.0),
                            height: content_size.y.clamp(540.0, 16384.0),
                            maximized: false,
                            theme_mode: self.window_geometry.theme_mode.clone(),
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
            if self.tab == NavTab::CloudBrowser && self.remote_items.is_empty() && !self.remote_loading {
                self.remote_loading = true;
                let _ = self
                    .tx
                    .send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
            }
        }

        if ctx.input(|i| i.key_pressed(Key::F5)) {
            let _ = self.tx.send(WorkerCommand::RefreshAll);
        }

        self.render_sidebar(ctx);

        egui::TopBottomPanel::top("proton_top_header")
            .exact_height(56.0)
            .frame(
                Frame::NONE
                    .fill(BG_SIDEBAR())
                    .inner_margin(Margin::symmetric(24, 11))
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE())),
            )
            .show(ctx, |ui| {
                self.render_top_bar(ui);
            });

        egui::CentralPanel::default()
            .frame(
                Frame::NONE
                    .fill(BG_CANVAS())
                    .inner_margin(Margin::symmetric(26, 20)),
            )
            .show(ctx, |ui| {
                match self.tab {
                    NavTab::Overview => self.render_overview_tab(ui),
                    NavTab::CloudBrowser => self.render_browser_tab(ui),
                    NavTab::Conflicts => self.render_conflicts_tab(ui),
                    NavTab::Settings => self.render_settings_tab(ui),
                }
            });

        self.render_account_popover(ctx);

        // Handle --screenshot <path> for automated visual inspection
        if let Some(target_path) = self.screenshot_target.clone() {
            let ready = if self.tab == NavTab::CloudBrowser {
                (!self.remote_items.is_empty() && self.frames_rendered >= 6)
                    || self.frames_rendered >= 60
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

/// Up button plus clickable "My files › subfolder" breadcrumbs for the My files tab.
fn render_breadcrumbs(ui: &mut egui::Ui, parts: &[String], navigate_to: &mut Option<String>) {
    // Up button if deeper than /my-files
    if parts.len() > 1 {
        if proton_button(
            ui,
            Vec2::new(34.0, 32.0),
            "↑",
            BG_CARD_ALT(),
            btn_secondary_hover_bg(),
            Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
            TEXT_PRIMARY(),
            14.0,
        )
        .on_hover_text("Go to parent folder")
        .clicked()
        {
            let parent = format!("/{}", parts[..parts.len() - 1].join("/"));
            *navigate_to = Some(parent);
        }
        ui.add_space(4.0);
    }

    // Interactive Breadcrumbs ("My files  ›  subfolder")
    let crumb_font = FontId::new(BREADCRUMB_FONT_SIZE, FontFamily::Proportional);
    let crumb_chrome_w = BREADCRUMB_PAD_X * 2.0 + 2.0;
    let separator_w = text_width(ui.painter(), "›", &FontId::new(BREADCRUMB_SEPARATOR_SIZE, FontFamily::Proportional));
    let gap = ui.spacing().item_spacing.x;
    for (idx, part) in parts.iter().enumerate() {
        let is_last = idx + 1 == parts.len();
        let label = breadcrumb_label(idx, part);
        let target_path = format!("/{}", parts[..=idx].join("/"));

        // In the wrapping (two-row) toolbar, start a new row rather than breaking a folder name inside its
        // pill, and shorten a single crumb that's wider than a whole row (full name on hover). Both are
        // no-ops in the one-row layout, which is only used when every crumb fits.
        // (available_width() is the whole row in a wrapping layout; what's left on this row is
        // available_size_before_wrap.)
        let separator = if is_last { 0.0 } else { gap + separator_w };
        let at_row_start = ui.cursor().left() <= ui.max_rect().left() + 0.5;
        if !at_row_start
            && text_width(ui.painter(), label, &crumb_font) + crumb_chrome_w + separator
                > ui.available_size_before_wrap().x
        {
            ui.end_row();
        }
        let shown = truncate_middle_to_width(
            ui.painter(),
            label,
            &crumb_font,
            ui.available_size_before_wrap().x - crumb_chrome_w - separator,
        );

        let crumb_fill = if is_last {
            PROTON_PURPLE_SOFT()
        } else {
            BG_INPUT()
        };
        let crumb_text_col = if is_last {
            TEXT_PRIMARY()
        } else {
            TEXT_MUTED()
        };

        let mut resp = Frame::NONE
            .fill(crumb_fill)
            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
            .corner_radius(CornerRadius::same(7))
            .inner_margin(Margin::symmetric(BREADCRUMB_PAD_X as i8, 6))
            .show(ui, |ui| {
                ui.add(
                    egui::Label::new(
                        RichText::new(&shown)
                            .size(BREADCRUMB_FONT_SIZE)
                            .strong()
                            .color(crumb_text_col),
                    )
                    .extend(),
                );
            })
            .response
            .interact(Sense::click());
        if shown != label {
            resp = resp.on_hover_text(label);
        }

        if !is_last {
            if resp.hovered() {
                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
            }
            if resp.clicked() {
                *navigate_to = Some(target_path);
            }
            ui.label(RichText::new("›").size(BREADCRUMB_SEPARATOR_SIZE).color(TEXT_MUTED()));
        }
    }
}

fn breadcrumb_label(idx: usize, part: &str) -> &str {
    if idx == 0 && part == "my-files" {
        "My files"
    } else {
        part
    }
}

/// Width of the My files breadcrumb row as `render_breadcrumbs` lays it out.
fn breadcrumbs_width(painter: &egui::Painter, parts: &[String], gap: f32) -> f32 {
    let crumb_font = FontId::new(BREADCRUMB_FONT_SIZE, FontFamily::Proportional);
    let separator_w = text_width(painter, "›", &FontId::new(BREADCRUMB_SEPARATOR_SIZE, FontFamily::Proportional));
    let up_w = if parts.len() > 1 { 34.0 + 4.0 + gap } else { 0.0 };
    up_w + parts
        .iter()
        .enumerate()
        .map(|(idx, part)| {
            let separator = if idx + 1 == parts.len() { 0.0 } else { separator_w + gap };
            text_width(painter, breadcrumb_label(idx, part), &crumb_font) + BREADCRUMB_PAD_X * 2.0 + 2.0 + gap + separator
        })
        .sum::<f32>()
}

fn card_frame() -> Frame {
    Frame::NONE
        .fill(BG_CARD())
        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::same(18))
}

#[allow(clippy::too_many_arguments)]
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

const BREADCRUMB_FONT_SIZE: f32 = 13.5;
const BREADCRUMB_SEPARATOR_SIZE: f32 = 15.0;
const BREADCRUMB_PAD_X: f32 = 12.0;
const TOOLBAR_REFRESH_W: f32 = 84.0;
const TOOLBAR_NEW_FOLDER_W: f32 = 108.0;
/// Safety margin for toolbar widths that are estimated before layout.
const TOOLBAR_FIT_SLACK: f32 = 12.0;

const TOP_BAR_GEAR_SIZE: f32 = 32.0;
const TOP_BAR_PAUSE_W: f32 = 76.0;
const TOP_BAR_SEARCH_MIN_TEXT_WIDTH: f32 = 110.0;
const TOP_BAR_SEARCH_MAX_TEXT_WIDTH: f32 = 280.0;
const TOP_BAR_STATUS_MAX_WIDTH: f32 = 240.0;

const TABLE_COL_GAP: f32 = 16.0;
const TABLE_STATUS_PILL_W: f32 = 96.0;
/// Fits the widest formatted size, e.g. "1023.9 MB".
const TABLE_SIZE_COL_W: f32 = 64.0;
const TABLE_NAME_MIN_W: f32 = 140.0;

/// Room for about five 38px activity rows.
const ACTIVITY_TABLE_MIN_HEIGHT: f32 = 200.0;

const STAT_LABEL_SIZE: f32 = 12.5;
const STAT_VALUE_SIZE: f32 = 24.0;
const STAT_VALUE_MIN_SIZE: f32 = 14.0;
/// Smallest value size accepted with four cards per row before switching to a 2×2 grid.
const STAT_VALUE_COMFORT_SIZE: f32 = 18.0;

/// Width left for a stat card's text when `per_row` cards share `available_width` (mirrors `ui.columns`).
fn stat_card_content_width(available_width: f32, spacing: f32, per_row: usize) -> f32 {
    let n = per_row as f32;
    (available_width - spacing * (n - 1.0)) / n - card_frame().total_margin().sum().x
}

/// All cards in one row when every label and value fits on one line at a comfortable size,
/// otherwise two rows (a 2×2 grid for four cards) so narrow windows neither wrap labels nor
/// shrink values to nothing.
fn stat_cards_per_row(painter: &egui::Painter, cards: &[(&str, String)], available_width: f32, spacing: f32) -> usize {
    let content_width = stat_card_content_width(available_width, spacing, cards.len());
    let fits = cards.iter().all(|(label, value)| {
        text_width(painter, label, &FontId::proportional(STAT_LABEL_SIZE)) <= content_width
            && text_width(painter, value, &FontId::proportional(STAT_VALUE_COMFORT_SIZE)) <= content_width
    });
    if fits {
        cards.len()
    } else {
        cards.len().div_ceil(2)
    }
}

fn render_stat_card(ui: &mut egui::Ui, label: &str, value: &str, value_size: f32) {
    card_frame().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.label(RichText::new(label).size(STAT_LABEL_SIZE).color(TEXT_MUTED()));
        ui.add_space(6.0);
        // Never wrap the value; if even the minimum size can't fit, elide instead
        ui.add(
            egui::Label::new(
                RichText::new(value)
                    .size(value_size)
                    .strong()
                    .color(TEXT_PRIMARY()),
            )
            .truncate(),
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
}

fn apply_proton_visuals(ctx: &egui::Context, light: bool) {
    let mut visuals = if light {
        egui::Visuals::light()
    } else {
        egui::Visuals::dark()
    };
    visuals.panel_fill = BG_CANVAS();
    visuals.window_fill = BG_CARD();
    visuals.faint_bg_color = if light {
        Color32::from_rgb(243, 241, 250)
    } else {
        Color32::from_rgb(28, 25, 38)
    };
    visuals.extreme_bg_color = BG_INPUT();
    visuals.selection.bg_fill = PROTON_PURPLE;
    visuals.selection.stroke = Stroke::new(1.0_f32, Color32::WHITE);
    visuals.widgets.noninteractive.bg_fill = BG_CARD();
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER_SUBTLE());
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY());
    visuals.widgets.inactive.bg_fill = BG_CARD_ALT();
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER_SUBTLE());
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY());
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
        NavTab::CloudBrowser => {
            // Official Proton Drive "My files" folder outline icon
            let tab_rect = egui::Rect::from_min_size(r.min, Vec2::new(r.width() * 0.45, 3.0));
            let body_rect = egui::Rect::from_min_max(
                egui::pos2(r.min.x, r.min.y + 2.5),
                r.max,
            );
            painter.rect_filled(tab_rect, CornerRadius::same(1), color);
            painter.rect_stroke(body_rect, CornerRadius::same(2), stroke, egui::StrokeKind::Inside);
        }
        NavTab::Overview => {
            // Sync Activity pulse / waveform icon
            let cy = r.center().y;
            let w = r.width();
            let pts = vec![
                egui::pos2(r.min.x, cy),
                egui::pos2(r.min.x + w * 0.25, cy),
                egui::pos2(r.min.x + w * 0.40, r.min.y + 1.0),
                egui::pos2(r.min.x + w * 0.60, r.max.y - 1.0),
                egui::pos2(r.min.x + w * 0.75, cy),
                egui::pos2(r.max.x, cy),
            ];
            painter.add(egui::Shape::line(pts, stroke));
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
            draw_gear_icon(painter, rect.shrink(0.5), color);
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
    // Official Proton Carbon `ic-cog-wheel` 8-tooth outline cogwheel + hollow center circle
    let c = rect.center();
    let radius = rect.width().min(rect.height()) * 0.5;
    let r_outer = radius * 0.96;
    let r_valley = radius * 0.72;
    let r_hole = radius * 0.33;
    let stroke = Stroke::new(1.35_f32, color);

    let teeth = 8;
    let step = std::f32::consts::TAU / teeth as f32;
    let half_tip = 0.13_f32; // angular half-width of tooth crest (~7.5 deg)
    let half_base = 0.22_f32; // angular half-width of tooth base (~12.6 deg)

    let mut pts = Vec::with_capacity(teeth * 5);
    for i in 0..teeth {
        let theta = i as f32 * step;
        let a0 = theta - half_base;
        let a1 = theta - half_tip;
        let a2 = theta + half_tip;
        let a3 = theta + half_base;
        let a_mid_valley = theta + step * 0.5;

        pts.push(egui::pos2(c.x + a0.cos() * r_valley, c.y + a0.sin() * r_valley));
        pts.push(egui::pos2(c.x + a1.cos() * r_outer, c.y + a1.sin() * r_outer));
        pts.push(egui::pos2(c.x + a2.cos() * r_outer, c.y + a2.sin() * r_outer));
        pts.push(egui::pos2(c.x + a3.cos() * r_valley, c.y + a3.sin() * r_valley));
        pts.push(egui::pos2(
            c.x + a_mid_valley.cos() * r_valley,
            c.y + a_mid_valley.sin() * r_valley,
        ));
    }

    painter.add(egui::Shape::closed_line(pts, stroke));
    painter.circle_stroke(c, r_hole, stroke);
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
    painter.rect_filled(r, CornerRadius::same(2), BG_CARD_ALT());
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

fn humanize_activity_action(action: &str) -> (&'static str, Color32, Color32) {
    match action {
        "download" => (
            "↓ Downloaded",
            Color32::from_rgba_unmultiplied(30, 168, 133, 34),
            STATUS_SUCCESS,
        ),
        "upload" => (
            "↑ Uploaded",
            Color32::from_rgba_unmultiplied(109, 74, 255, 42),
            PROTON_PURPLE_TEXT(),
        ),
        "mkdir" => (
            "+ Folder created",
            BG_CARD_ALT(),
            TEXT_PRIMARY(),
        ),
        "delete-local" => (
            "− Removed locally",
            BG_CARD_ALT(),
            TEXT_MUTED(),
        ),
        "delete-remote" | "trash-remote" => (
            "Trash (Cloud)",
            Color32::from_rgba_unmultiplied(245, 158, 11, 34),
            STATUS_WARNING,
        ),
        "conflict" => (
            "! Conflict",
            Color32::from_rgba_unmultiplied(239, 68, 68, 38),
            STATUS_DANGER,
        ),
        "error" => (
            "✕ Failed",
            Color32::from_rgba_unmultiplied(239, 68, 68, 38),
            STATUS_DANGER,
        ),
        _ => ("• Synced", BG_CARD_ALT(), TEXT_PRIMARY()),
    }
}

fn format_relative_timestamp(ts_ms: u64) -> String {
    if ts_ms == 0 {
        return "—".to_string();
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now_ms <= ts_ms {
        return "Just now".to_string();
    }
    let diff_secs = (now_ms - ts_ms) / 1000;
    if diff_secs < 45 {
        "Just now".to_string()
    } else if diff_secs < 3600 {
        format!("{}m ago", diff_secs / 60)
    } else if diff_secs < 86_400 {
        format!("{}h ago", diff_secs / 3600)
    } else if diff_secs < 172_800 {
        "Yesterday".to_string()
    } else {
        format!("{}d ago", diff_secs / 86_400)
    }
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

fn text_width(painter: &egui::Painter, text: &str, font: &FontId) -> f32 {
    painter
        .layout_no_wrap(text.to_owned(), font.clone(), Color32::PLACEHOLDER)
        .size()
        .x
}

/// Middle-truncate `s` so it fits within `max_width` pixels when drawn in `font`.
fn truncate_middle_to_width(painter: &egui::Painter, s: &str, font: &FontId, max_width: f32) -> String {
    // No room at all (e.g. a collapsed column when zoomed in): draw nothing rather than overlap
    if max_width <= 0.0 {
        return String::new();
    }
    if text_width(painter, s, font) <= max_width {
        return s.to_string();
    }
    // Binary search for the longest truncation that still fits
    let (mut lo, mut hi) = (2, s.chars().count().saturating_sub(1));
    let mut best = truncate_middle(s, 2);
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let candidate = truncate_middle(s, mid);
        if text_width(painter, &candidate, font) <= max_width {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    best
}

/// Largest font size in `min_size..=base_size` at which `text` fits within `max_width` on one line,
/// or `min_size` if it doesn't fit even then.
fn fit_font_size(painter: &egui::Painter, text: &str, base_size: f32, min_size: f32, max_width: f32) -> f32 {
    let mut size = base_size;
    while size > min_size && text_width(painter, text, &FontId::proportional(size)) > max_width {
        size -= 0.5;
    }
    size.max(min_size)
}

/// The Recent Sync Activity header detail, "<usage>  •  Syncing <dir>", fitted to `max_width`: the
/// folder path is middle-truncated first, then dropped, then the whole text.
fn activity_header_detail(painter: &egui::Painter, usage: &str, sync_dir: &str, font: &FontId, max_width: f32) -> String {
    let prefix = format!("{usage}  •  Syncing ");
    let full = format!("{prefix}{sync_dir}");
    if text_width(painter, &full, font) <= max_width {
        return full;
    }
    let path = truncate_middle_to_width(painter, sync_dir, font, max_width - text_width(painter, &prefix, font));
    // Only keep the path while enough of it survives to be recognisable
    if path.chars().count() >= 12 {
        return format!("{prefix}{path}");
    }
    if text_width(painter, usage, font) <= max_width {
        return usage.to_string();
    }
    String::new()
}

/// One active-transfer line: direction badge, the path (middle-truncated to the room left, full path on
/// hover) and the right-aligned "transferred / total". Returns the path and byte-count label rects.
fn render_transfer_line(ui: &mut egui::Ui, t: &ActiveTransfer) -> (egui::Rect, egui::Rect) {
    ui.horizontal(|ui| {
        let badge = if t.direction == "upload" { "↑ Uploading" } else { "↓ Downloading" };
        ui.label(RichText::new(badge).size(12.5).strong().color(PROTON_PURPLE_TEXT()));
        // Byte counts first (right to left) so the path gets what's left and never runs under them
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let counts_rect = ui
                .label(
                    RichText::new(format!("{} / {}", format_bytes(t.bytes_transferred), format_bytes(t.total_bytes)))
                        .size(12.0)
                        .color(TEXT_MUTED()),
                )
                .rect;
            let path_rect = ui
                .with_layout(Layout::left_to_right(Align::Center), |ui| {
                    let font = FontId::new(12.5, FontFamily::Proportional);
                    let room = ui.available_width() - ui.spacing().item_spacing.x;
                    let shown = truncate_middle_to_width(ui.painter(), &t.rel_path, &font, room);
                    let resp = ui.label(RichText::new(&shown).size(12.5).color(TEXT_PRIMARY()));
                    let rect = resp.rect;
                    if shown != t.rel_path {
                        resp.on_hover_text(&t.rel_path);
                    }
                    rect
                })
                .inner;
            (path_rect, counts_rect)
        })
        .inner
    })
    .inner
}

/// Column positions in the My files table, shared by the header and the rows.
struct BrowserColumns {
    name_max_w: f32,
    status_x: f32,
    /// Left edge of the Modified column, if it's shown at all
    mod_x: Option<f32>,
    /// Show only the date (no time) in Modified
    date_only: bool,
    size_right_x: f32,
}

/// The original column spacing on wide rows. As the row narrows the columns slide right (names keep
/// ~194px) until they're packed against Size, then names shrink to TABLE_NAME_MIN_W. Past that Modified
/// shows the date only, and on the very narrowest rows it's dropped.
fn browser_columns(row: egui::Rect, date_w: f32, short_date_w: f32) -> BrowserColumns {
    let name_left = row.min.x + 46.0;
    let size_right_x = row.max.x - 18.0;
    let size_left = size_right_x - TABLE_SIZE_COL_W;
    let names_fit = |status_x: f32| status_x - TABLE_COL_GAP - name_left >= TABLE_NAME_MIN_W;
    // Status and Modified packed as far right as they go, for a given date width
    let packed = |date_w: f32| {
        let mod_x = size_left - TABLE_COL_GAP - date_w;
        (mod_x - TABLE_COL_GAP - TABLE_STATUS_PILL_W, mod_x)
    };

    let (full_status_x, full_mod_x) = packed(date_w);
    let (short_status_x, short_mod_x) = packed(short_date_w);
    let (status_x, mod_x, date_only) = if names_fit(full_status_x) {
        let status_x = (row.max.x - 395.0).max(full_status_x.min(row.min.x + 240.0));
        let mod_x = (row.max.x - 245.0)
            .max(status_x + TABLE_STATUS_PILL_W + TABLE_COL_GAP)
            .min(full_mod_x);
        (status_x, Some(mod_x), false)
    } else if names_fit(short_status_x) {
        (short_status_x, Some(short_mod_x), true)
    } else {
        (size_left - TABLE_COL_GAP - TABLE_STATUS_PILL_W, None, false)
    };
    BrowserColumns {
        name_max_w: status_x - TABLE_COL_GAP - name_left,
        status_x,
        mod_x,
        date_only,
        size_right_x,
    }
}

/// Spawn `cmd` and wait on it from a background thread so it never lingers as a zombie child.
fn spawn_reaped(cmd: &mut Command) -> std::io::Result<()> {
    let mut child = cmd.spawn()?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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
        if spawn_reaped(
            Command::new(&bin)
                .arg("daemon")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()),
        )
        .is_ok()
        {
            // Poll up to ~3.6s so we return as soon as the daemon HTTP listener is ready
            for _ in 0..30 {
                thread::sleep(Duration::from_millis(120));
                if fetch_status().is_ok() {
                    break;
                }
            }
            break;
        }
    }
}

fn worker_loop(rx: Receiver<WorkerCommand>, tx: Sender<WorkerEvent>, ctx: egui::Context) {
    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::RefreshAll => {
                SYSTEM_LIGHT_MODE.store(detect_system_light_mode(), AtomicOrdering::Relaxed);
                let mut status = fetch_status();
                if status.is_err() {
                    try_autostart_daemon();
                    status = fetch_status();
                }

                let activity = fetch_activity();

                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(status),
                    activity,
                });
                ctx.request_repaint();
            }
            WorkerCommand::TriggerSync => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/sync")).call();
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(fetch_status()),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::SetPaused(paused) => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/pause"))
                    .send_json(serde_json::json!({ "paused": paused }));
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(fetch_status()),
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
                    status: Box::new(fetch_status()),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::LoadRemotePath(_) if REMOTE_FIXTURE.get().is_some() => {
                let res = load_remote_fixture(REMOTE_FIXTURE.get().map_or("", String::as_str));
                let _ = tx.send(WorkerEvent::RemoteLoaded(res));
                ctx.request_repaint();
            }
            WorkerCommand::LoadRemotePath(path) => {
                let tx_clone = tx.clone();
                let ctx_clone = ctx.clone();
                thread::spawn(move || {
                    let url = format!("{DAEMON_URL}/api/remote/list?path={path}");
                    let mut res = ureq::get(&url)
                        .call()
                        .map_err(|e| e.to_string())
                        .and_then(|r| {
                            r.into_json::<RemoteListResponse>().map_err(|e| e.to_string())
                        });
                    if res.is_err() {
                        try_autostart_daemon();
                        res = ureq::get(&url)
                            .call()
                            .map_err(|e| e.to_string())
                            .and_then(|r| {
                                r.into_json::<RemoteListResponse>().map_err(|e| e.to_string())
                            });
                    }
                    let _ = tx_clone.send(WorkerEvent::RemoteLoaded(res));
                    ctx_clone.request_repaint();
                });
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
            WorkerCommand::SaveSettings(payload) => {
                let _ = ureq::post(&format!("{DAEMON_URL}/api/settings")).send_json(payload);
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(fetch_status()),
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
            let _ = spawn_reaped(
                Command::new("python3")
                    .arg(&script)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null()),
            );
            break;
        }
    }
}

const USAGE: &str = "\
protondrive-gui — Proton Drive native Linux desktop client

USAGE:
  protondrive-gui [OPTIONS]

OPTIONS:
  --tab <TAB>           initial tab (overview | browser | conflicts | settings)
  --screenshot <PATH>   render UI, save a PNG screenshot to PATH, and exit
  --search <QUERY>      pre-fill the search/filter box
  --remote-fixture <F>  with --screenshot: list My files from a JSON file instead of the daemon
  --path <FOLDER>       open My files at a remote folder, e.g. /my-files/photos
  --size <WxH>          window size for --screenshot (default 1440x900, min 840x540)
  --version             print the version
  -h, --help            print this help
";

/// Parses a `--size` value like "1280x800", clamped to the window range the app supports
/// (winit panics on zero/negative sizes under Wayland).
fn parse_window_size(s: &str) -> Option<[f32; 2]> {
    let (w, h) = s.trim().split_once(['x', 'X'])?;
    let (w, h): (f32, f32) = (w.trim().parse().ok()?, h.trim().parse().ok()?);
    (w.is_finite() && h.is_finite()).then(|| [w.clamp(840.0, 16384.0), h.clamp(540.0, 16384.0)])
}

fn main() -> eframe::Result {
    let mut screenshot_target: Option<String> = None;
    let mut initial_tab = NavTab::CloudBrowser;
    let mut initial_account_menu = false;
    let mut cli_theme_override: Option<String> = None;
    let mut cli_search: Option<String> = None;
    let mut cli_path: Option<String> = None;
    let mut cli_size: Option<[f32; 2]> = None;
    let mut cli_fixture: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--screenshot" => {
                screenshot_target = args.next();
            }
            "--account-menu" => {
                initial_account_menu = true;
            }
            "--remote-fixture" => {
                // Screenshot-only: show this RemoteListResponse JSON instead of the daemon's listing
                cli_fixture = args.next();
            }
            "--theme" => {
                cli_theme_override = args.next();
            }
            "--size" => {
                let raw = args.next().unwrap_or_default();
                cli_size = parse_window_size(&raw);
                if cli_size.is_none() {
                    eprintln!("protondrive-gui: ignoring invalid --size {raw:?} (expected WxH, e.g. 1280x800)");
                }
            }
            "--path" => {
                cli_path = args.next();
            }
            "--search" => {
                cli_search = args.next();
            }
            "--tab" => {
                if let Some(t) = args.next() {
                    initial_tab = match t.as_str() {
                        // Selective sync lives in My files now
                        "browser" | "cloud" | "files" | "selective" => NavTab::CloudBrowser,
                        "overview" | "activity" => NavTab::Overview,
                        "conflicts" => NavTab::Conflicts,
                        "settings" => NavTab::Settings,
                        _ => NavTab::CloudBrowser,
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

    if let Some(path) = cli_fixture {
        if screenshot_target.is_some() {
            let _ = REMOTE_FIXTURE.set(path);
        } else {
            eprintln!("protondrive-gui: --remote-fixture only applies together with --screenshot; ignoring it");
        }
    }

    if screenshot_target.is_none() {
        try_autostart_tray();
    }

    let mut saved_geom = load_window_geometry();
    if let Some(theme_ov) = cli_theme_override {
        saved_geom.theme_mode = theme_ov;
    }
    if cli_size.is_some() && screenshot_target.is_none() {
        eprintln!("protondrive-gui: --size only applies together with --screenshot; ignoring it");
    }
    let initial_size = if screenshot_target.is_some() {
        cli_size.unwrap_or([1440.0, 900.0])
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
            let mut app = ProtonDriveNativeApp::new(
                cc,
                screenshot_target,
                initial_tab,
                initial_account_menu,
                cli_path,
                saved_geom,
            );
            if let Some(q) = cli_search {
                app.search_query = q;
            }
            Ok(Box::new(app))
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_painter(f: impl FnOnce(&egui::Painter)) {
        let ctx = egui::Context::default();
        let mut f = Some(f);
        let _ = ctx.run(egui::RawInput::default(), |ctx| {
            if let Some(f) = f.take() {
                f(&ctx.layer_painter(egui::LayerId::background()));
            }
        });
    }

    #[test]
    fn truncate_to_width_keeps_text_that_fits() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            assert_eq!(truncate_middle_to_width(p, "short.txt", &font, 500.0), "short.txt");
        });
    }

    #[test]
    fn truncate_to_width_fits_long_text_in_pixels() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            let details = "Download failed: ENOENT: no such file or directory, rename \
                '/home/user/ProtonDrive/xyz/.proton-drive-tmp-00849-gabiinthewild_1753137399_3863415252.mp4'";
            for max_width in [80.0, 250.0, 550.0] {
                let out = truncate_middle_to_width(p, details, &font, max_width);
                assert!(text_width(p, &out, &font) <= max_width, "{out:?} wider than {max_width}");
                assert!(out.contains('…'));
                assert!(out.starts_with("Down") && out.ends_with('\''));
            }
        });
    }

    #[test]
    fn truncate_to_width_returns_empty_when_there_is_no_room() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            assert_eq!(truncate_middle_to_width(p, "", &font, -1.0), "");
            assert_eq!(truncate_middle_to_width(p, "report.pdf", &font, -40.0), "");
            assert_eq!(truncate_middle_to_width(p, "report.pdf", &font, 0.0), "");
        });
    }

    #[test]
    fn truncate_to_width_uses_the_longest_truncation_that_fits() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            let name = "xyz/Gabriela Valientes/gabiinthewild_1753137399_3863415252.mp4";
            let out = truncate_middle_to_width(p, name, &font, 200.0);
            let kept = out.chars().count();
            assert!(text_width(p, &truncate_middle(name, kept + 1), &font) > 200.0);
        });
    }

    #[test]
    fn truncate_to_width_handles_multibyte_text() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            let name = "写真/日本語のファイル名_とても長い名前_2026年10月23日_最終版.txt";
            let out = truncate_middle_to_width(p, name, &font, 120.0);
            assert!(text_width(p, &out, &font) <= 120.0);
            assert!(out.starts_with('写') && out.ends_with(".txt"));
        });
    }

    #[test]
    fn spawn_reaped_leaves_no_zombie_children() {
        let zombie_children = || {
            let me = std::process::id().to_string();
            std::fs::read_dir("/proc")
                .unwrap()
                .filter_map(|e| std::fs::read_to_string(e.ok()?.path().join("stat")).ok())
                .filter(|stat| {
                    // Fields after the "(comm)" are: state ppid ...
                    let rest: Vec<&str> = stat.rsplit_once(')').map_or(vec![], |(_, r)| r.split_whitespace().collect());
                    rest.first() == Some(&"Z") && rest.get(1) == Some(&me.as_str())
                })
                .count()
        };
        for _ in 0..3 {
            spawn_reaped(&mut Command::new("true")).unwrap();
        }
        thread::sleep(Duration::from_millis(300));
        assert_eq!(zombie_children(), 0);
    }

    #[test]
    fn stat_card_content_width_matches_what_egui_gives_the_card() {
        // Odd widths too, so egui's pixel rounding of column positions is exercised
        for screen_width in [1440.0, 1133.7, 841.3, 1001.0] {
            let ctx = egui::Context::default();
            let input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, Vec2::new(screen_width, 900.0))),
                ..Default::default()
            };
            let _ = ctx.run(input, |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    let available = ui.available_width();
                    let spacing = ui.spacing().item_spacing.x;
                    for per_row in [2, 4] {
                        let mut actual = 0.0;
                        ui.columns(per_row, |cols| {
                            card_frame().show(&mut cols[0], |ui| actual = ui.available_width());
                        });
                        let predicted = stat_card_content_width(available, spacing, per_row);
                        // egui snaps layout positions to multiples of GUI_ROUNDING (1/32 pt)
                        assert!(
                            (predicted - actual).abs() <= egui::emath::GUI_ROUNDING,
                            "{screen_width}px, {per_row} per row: {predicted} vs {actual}"
                        );
                    }
                });
            });
        }
    }

    #[test]
    fn stat_cards_switch_to_two_rows_exactly_when_one_row_stops_fitting() {
        with_painter(|p| {
            let spacing = 8.0;
            let margin = card_frame().total_margin().sum().x;
            let long_quota = [
                ("Proton Cloud Storage", "13.22 GB / 510.00 GB".to_string()),
                ("Local Synced Size", "5.29 GB".to_string()),
                ("Synced Files", "372".to_string()),
                ("Synced Folders", "60".to_string()),
            ];
            let short_values = long_quota.clone().map(|(label, _)| (label, "1".to_string()));
            let mut switch_points = vec![];
            for cards in [&long_quota, &short_values] {
                let needed = cards
                    .iter()
                    .map(|(label, value)| {
                        text_width(p, label, &FontId::proportional(STAT_LABEL_SIZE))
                            .max(text_width(p, value, &FontId::proportional(STAT_VALUE_COMFORT_SIZE)))
                    })
                    .fold(0.0, f32::max);
                let switch_at = 4.0 * (needed + margin) + 3.0 * spacing;
                assert_eq!(stat_cards_per_row(p, cards, switch_at + 0.5, spacing), 4);
                assert_eq!(stat_cards_per_row(p, cards, switch_at - 0.5, spacing), 2);
                switch_points.push(switch_at);
            }
            // The decision follows the measured text: a long quota needs a wider window
            assert!(switch_points[0] > switch_points[1]);
        });
    }

    #[test]
    fn transfer_line_keeps_the_path_clear_of_the_byte_counts() {
        let transfer = ActiveTransfer {
            id: "t1".into(),
            direction: "download".into(),
            rel_path: "xyz/Gabriela Valientes/archive/2025/summer/gabiinthewild_1753137399_3863415252.mp4".into(),
            bytes_transferred: 512 * 1024 * 1024,
            total_bytes: 1536 * 1024 * 1024,
        };
        for screen_width in [480.0, 700.0, 1400.0] {
            let ctx = egui::Context::default();
            let input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, Vec2::new(screen_width, 300.0))),
                ..Default::default()
            };
            let _ = ctx.run(input, |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    let row_right = ui.max_rect().right();
                    let (path_rect, counts_rect) = render_transfer_line(ui, &transfer);
                    assert!(path_rect.right() <= counts_rect.left(), "{screen_width}: path runs under the counts");
                    assert!(counts_rect.right() <= row_right + 0.5, "{screen_width}: counts pushed out of the row");
                });
            });
        }
    }

    #[test]
    fn browser_columns_keep_wide_layout_and_never_overlap_when_narrow() {
        // Inter 12pt widths of "0000-00-00  00:00" and "0000-00-00"
        let (date_w, short_date_w) = (118.0, 76.0);
        let row = |w: f32| egui::Rect::from_min_size(egui::pos2(300.0, 0.0), Vec2::new(w, 45.0));

        // Wide rows keep the original spacing
        let wide = browser_columns(row(1100.0), date_w, short_date_w);
        assert_eq!(wide.status_x, 300.0 + 1100.0 - 395.0);
        assert_eq!(wide.mod_x, Some(300.0 + 1100.0 - 245.0));
        assert!(!wide.date_only);

        let mut prev: Option<BrowserColumns> = None;
        for w in (400..=1400).step_by(5).map(|w| w as f32) {
            let c = browser_columns(row(w), date_w, short_date_w);
            let size_left = c.size_right_x - TABLE_SIZE_COL_W;
            let status_right = c.status_x + TABLE_STATUS_PILL_W;
            let shown_date_w = if c.date_only { short_date_w } else { date_w };
            match c.mod_x {
                Some(mod_x) => {
                    assert!(status_right + TABLE_COL_GAP <= mod_x + 0.01, "{w}: status runs into Modified");
                    assert!(mod_x + shown_date_w + TABLE_COL_GAP <= size_left + 0.01, "{w}: Modified runs into Size");
                    assert!(c.name_max_w >= TABLE_NAME_MIN_W, "{w}: Modified kept at the cost of names");
                }
                None => assert!(status_right + TABLE_COL_GAP <= size_left + 0.01, "{w}: status runs into Size"),
            }
            assert!(c.status_x - TABLE_COL_GAP - c.name_max_w >= 300.0 + 46.0 - 0.01, "{w}: name area overlaps status");
            // No jumps while resizing, other than where the date format changes
            if let Some(p) = &prev {
                if p.date_only == c.date_only && p.mod_x.is_some() == c.mod_x.is_some() {
                    assert!((c.status_x - p.status_x).abs() <= 5.01, "{w}: status column jumps");
                }
            }
            prev = Some(c);
        }
        // At the minimum window's row width the date stays visible (date only); Modified goes only below that
        let narrow = browser_columns(row(496.0), date_w, short_date_w);
        assert!(narrow.mod_x.is_some() && narrow.date_only);
        assert!(browser_columns(row(560.0), date_w, short_date_w).mod_x.is_some());
        assert!(browser_columns(row(460.0), date_w, short_date_w).mod_x.is_none());
    }

    #[test]
    fn breadcrumbs_width_matches_the_laid_out_breadcrumbs() {
        let ctx = egui::Context::default();
        let _ = ctx.run(egui::RawInput::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let gap = ui.spacing().item_spacing.x;
                for path in ["/my-files", "/my-files/logo/exports", "/my-files/写真/trailamigo-store-screenshots-2026-10"] {
                    let parts: Vec<String> = path.split('/').filter(|s| !s.is_empty()).map(String::from).collect();
                    let mut nav = None;
                    let laid_out = ui.horizontal(|ui| render_breadcrumbs(ui, &parts, &mut nav)).response.rect.width();
                    let estimate = breadcrumbs_width(ui.painter(), &parts, gap);
                    // The estimate also counts the gap before whatever follows the last crumb
                    assert!((estimate - (laid_out + gap)).abs() < 0.5, "{path}: {estimate} vs {laid_out} + {gap}");
                }
            });
        });
    }

    #[test]
    fn activity_header_detail_shortens_path_then_drops_it_then_everything() {
        with_painter(|p| {
            let font = FontId::proportional(12.0);
            let usage = "Drive Cloud Usage: 13.13 GB";
            let dir = "/home/gautam-chauhan/ProtonDrive";
            let full = format!("{usage}  •  Syncing {dir}");
            let full_w = text_width(p, &full, &font);

            assert_eq!(activity_header_detail(p, usage, dir, &font, full_w + 10.0), full);

            let shortened = activity_header_detail(p, usage, dir, &font, full_w - 60.0);
            assert!(shortened.starts_with(&format!("{usage}  •  Syncing /")), "{shortened:?}");
            assert!(shortened.contains('…') && shortened.ends_with("ProtonDrive"));
            assert!(text_width(p, &shortened, &font) <= full_w - 60.0);

            let usage_w = text_width(p, usage, &font);
            assert_eq!(activity_header_detail(p, usage, dir, &font, usage_w + 20.0), usage);
            assert_eq!(activity_header_detail(p, usage, dir, &font, usage_w - 1.0), "");
        });
    }

    #[test]
    fn parse_window_size_accepts_wxh_and_clamps_to_supported_range() {
        assert_eq!(parse_window_size("1280x800"), Some([1280.0, 800.0]));
        assert_eq!(parse_window_size(" 1280X800 "), Some([1280.0, 800.0]));
        // Sizes winit can't handle (zero/negative) or below the minimum window are clamped
        assert_eq!(parse_window_size("0x0"), Some([840.0, 540.0]));
        assert_eq!(parse_window_size("-100x700"), Some([840.0, 700.0]));
        assert_eq!(parse_window_size("99999x99999"), Some([16384.0, 16384.0]));
        for bad in ["", "1280", "x800", "abcxdef", "NaNx700", "infx700"] {
            assert_eq!(parse_window_size(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn fit_font_size_keeps_base_size_when_text_fits() {
        with_painter(|p| {
            assert_eq!(fit_font_size(p, "372", 24.0, 14.0, 300.0), 24.0);
        });
    }

    #[test]
    fn fit_font_size_shrinks_wide_text_to_fit_without_going_below_min() {
        with_painter(|p| {
            let quota = "13.22 GB / 510.00 GB";
            let size = fit_font_size(p, quota, 24.0, 14.0, 200.0);
            assert!((14.0..24.0).contains(&size));
            assert!(text_width(p, quota, &FontId::proportional(size)) <= 200.0);
            assert_eq!(fit_font_size(p, quota, 24.0, 14.0, 20.0), 14.0);
        });
    }

    #[test]
    fn parse_availability_maps_every_daemon_string() {
        assert_eq!(parse_availability(Some("pinned")), Availability::Pinned);
        assert_eq!(parse_availability(Some("downloaded")), Availability::Downloaded);
        assert_eq!(parse_availability(Some("online-only")), Availability::OnlineOnly);
        assert_eq!(parse_availability(Some("hidden")), Availability::Hidden);
        assert_eq!(parse_availability(Some("hiding")), Availability::Hiding);
    }

    #[test]
    fn parse_availability_defaults_to_online_only() {
        assert_eq!(parse_availability(None), Availability::OnlineOnly);
        assert_eq!(parse_availability(Some("")), Availability::OnlineOnly);
        assert_eq!(parse_availability(Some("Pinned")), Availability::OnlineOnly);
        assert_eq!(parse_availability(Some("syncing")), Availability::OnlineOnly);
    }

    #[test]
    fn availability_pill_uses_the_agreed_labels_and_styles() {
        assert_eq!(availability_pill(Availability::Pinned), ("Always keep", PillStyle::SolidGreen));
        assert_eq!(availability_pill(Availability::Downloaded), ("Downloaded", PillStyle::OutlineGreen));
        assert_eq!(availability_pill(Availability::OnlineOnly), ("Online only", PillStyle::Muted));
        assert_eq!(availability_pill(Availability::Hidden), ("Hidden", PillStyle::Muted));
        assert_eq!(availability_pill(Availability::Hiding), ("Hiding…", PillStyle::Muted));
    }
}
