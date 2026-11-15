//! Home: the sync's status in plain words, what needs the user, what is moving, and the drive.

use std::process::Command;
use std::sync::atomic::Ordering;

use eframe::egui::{self, Align, Color32, CornerRadius, Frame, Layout, Margin, RichText, ScrollArea, Stroke, Vec2};

use crate::{
    action_button, btn_secondary_hover_bg, card_frame, drive_status_line, files_safe_hint, format_bytes, offers_mount_again,
    render_transfer_line, shown_folder, spawn_reaped, AccountInfo, ButtonKind, ConflictRecord, DaemonStatus,
    PendingConfirm, ProtonDriveNativeApp, VfsStatus, WorkerCommand, BG_CARD_ALT, BORDER_SUBTLE, PROTON_PURPLE,
    PROTON_PURPLE_TEXT, SCREENSHOT_MODE, STATUS_DANGER, STATUS_SUCCESS, STATUS_WARNING, TEXT_MUTED, TEXT_PRIMARY,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Busy,
    Paused,
    Attention,
    Offline,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusSummary {
    pub headline: String,
    pub detail: Option<String>,
    pub tone: Tone,
}

fn summary(headline: impl Into<String>, detail: Option<String>, tone: Tone) -> StatusSummary {
    StatusSummary { headline: headline.into(), detail, tone }
}

/// Whether the daemon has no account to sync with.
pub fn signed_out(status: &DaemonStatus) -> bool {
    !status.logged_in || status.state == "unauthenticated"
}

/// What the app says about the sync in a sentence, in the user's terms. Never echoes the daemon's own wording.
/// `connecting`: the app's first try at reaching the daemon isn't over yet.
/// Precedence: connecting or unreachable, signed out, paused, moving files, syncing, needs attention, stopped with no
/// reason given, up to date.
pub fn status_summary(status: &DaemonStatus, daemon_online: bool, connecting: bool, attention: usize, now_ms: i64) -> StatusSummary {
    if !daemon_online {
        if connecting {
            return summary("Connecting…", None, Tone::Busy);
        }
        return summary("Can't reach Proton Drive's background service", None, Tone::Offline);
    }
    if signed_out(status) {
        return summary("Signed out", Some("Sign in to sync your files".to_string()), Tone::Attention);
    }
    if status.state == "paused" || status.settings.paused {
        return summary(paused_headline(status.settings.paused_until, now_ms, local_offset_secs), None, Tone::Paused);
    }
    if status.vfs.as_ref().is_some_and(|v| v.reason.as_deref() == Some("moving")) {
        return summary("Moving files…", None, Tone::Busy);
    }
    if status.state == "syncing" {
        return summary(syncing_headline(status), None, Tone::Busy);
    }
    if attention > 0 {
        let headline = if attention == 1 {
            "1 problem needs you".to_string()
        } else {
            format!("{attention} problems need you")
        };
        return summary(headline, Some("See Needs attention below".to_string()), Tone::Attention);
    }
    // An error the daemon gave no words for (with words, it is in Needs attention and counted above)
    if status.state == "error" {
        return summary("Sync stopped", Some("Check the log or try Sync now".to_string()), Tone::Attention);
    }
    let detail = status.last_sync_at.map(|at| format!("Last synced {}", ago(now_ms - at)));
    summary("Up to date", detail, Tone::Ok)
}

fn syncing_headline(status: &DaemonStatus) -> String {
    let transfers = &status.active_transfers;
    let uploads = transfers.iter().filter(|t| t.direction == "upload").count();
    let downloads = transfers.len() - uploads;
    match (uploads, downloads) {
        (0, 0) => "Checking for changes…".to_string(),
        (_, 0) | (0, _) => {
            let verb = if downloads == 0 { "Uploading" } else { "Downloading" };
            if transfers.len() == 1 {
                let name = transfers[0].rel_path.rsplit('/').next().unwrap_or("");
                format!("{verb} {name}")
            } else {
                format!("{verb} {} files", transfers.len())
            }
        }
        _ => format!("Syncing {} files", transfers.len()),
    }
}

/// "just now", "2 min ago", "2 h ago", "3 days ago"; a negative (future) time reads as "just now".
pub fn ago(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        "just now".to_string()
    } else if secs < 3600 {
        format!("{} min ago", secs / 60)
    } else if secs < 86_400 {
        format!("{} h ago", secs / 3600)
    } else if secs / 86_400 == 1 {
        "1 day ago".to_string()
    } else {
        format!("{} days ago", secs / 86_400)
    }
}

/// One thing that needs the user, in the order the home screen lists them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attention {
    /// Signed in to another Proton account than the records are of: nothing syncs until the user chooses (#35)
    AccountMismatch,
    Conflict { id: u64, rel_path: String },
    FilesMissing,
    DriveNotMounted { message: String, can_mount: bool },
    StoppedMove,
    FailedItems(u64),
    LastError(String),
}

/// Every problem the user can act on, each once: another account's records (first, as nothing syncs until it is
/// settled), files missing, stopped move, drive not mounted, unresolved conflicts by id, failed items, last error (only
/// when neither another account nor missing files explains it: the daemon sets it to say so).
///
/// A stopped move is listed whenever the daemon reports one with something to do or say about it, whatever the drive
/// is doing now: it attaches the move to a drive mounted (or ejected) again since the move failed. An unmounted virtual
/// drive is listed too unless the move explains it or it is still starting or moving files.
pub fn attention_items(status: &DaemonStatus, conflicts: &[ConflictRecord]) -> Vec<Attention> {
    let mut items = Vec::new();
    if status.account_mismatch.is_some() {
        items.push(Attention::AccountMismatch);
    }
    if status.files_missing.is_some() {
        items.push(Attention::FilesMissing);
    }
    if let Some(v) = &status.vfs {
        let reason = v.reason.as_deref();
        let move_to_act_on = v.drive_move.as_ref().is_some_and(|m| {
            !m.actions.is_empty() || m.error.as_deref().is_some_and(|e| !e.trim().is_empty())
        });
        if move_to_act_on || reason == Some("move-failed") {
            items.push(Attention::StoppedMove);
        }
        if v.mode == "virtual" && !v.mounted && !matches!(reason, Some("move-failed" | "starting" | "moving")) {
            items.push(Attention::DriveNotMounted {
                message: drive_status_line(v, &status.sync_dir),
                can_mount: offers_mount_again(v),
            });
        }
    }
    let mut open: Vec<&ConflictRecord> = conflicts.iter().filter(|c| c.resolved == 0).collect();
    open.sort_by_key(|c| c.id);
    items.extend(open.into_iter().map(|c| Attention::Conflict { id: c.id, rel_path: c.local_rel_path.clone() }));
    if status.stats.error_items > 0 {
        items.push(Attention::FailedItems(status.stats.error_items));
    }
    if status.files_missing.is_none() && status.account_mismatch.is_none() {
        if let Some(e) = status.last_error.as_deref().filter(|e| !e.trim().is_empty()) {
            items.push(Attention::LastError(e.to_string()));
        }
    }
    items
}

/// Whether a status refresh asks for the conflicts again: when the daemon came back, when the count of unresolved
/// ones changed, and on every refresh while one is open on either side, so that one resolved and another new between
/// two polls (the same count) is not missed.
pub fn should_reload_conflicts(was_offline: bool, old_unresolved: u64, new_unresolved: u64, listed_open: usize) -> bool {
    was_offline || old_unresolved != new_unresolved || new_unresolved > 0 || listed_open > 0
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// The local day (days since 1970-01-01 by the local calendar) and the seconds into it, of a time in epoch ms, local
/// time being `offset` seconds east of UTC.
pub(crate) fn local_day_and_secs(ms: i64, offset: i64) -> (i64, i64) {
    let secs = ms.div_euclid(1000) + offset;
    (secs.div_euclid(86_400), secs.rem_euclid(86_400))
}

/// How many seconds east of UTC local time is at a time in epoch ms (the machine's time zone, summer time included).
pub fn local_offset_secs(ms: i64) -> i64 {
    let t = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: localtime_r only writes the tm it is given, and reads t
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return 0;
    }
    tm.tm_gmtoff
}

/// The Home headline while paused (#205), as the tray says it (linux/tray paused_line): "Paused until 15:00" when the
/// pause ends today, "Paused until tomorrow 08:00", "Paused until Mon 08:00" on a later day; "Paused" with no end.
/// `offset_at` gives local time's offset from UTC (seconds east) at a time in epoch ms (local_offset_secs).
pub fn paused_headline(until: Option<i64>, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> String {
    let Some(until) = until else {
        return "Paused".to_string();
    };
    let (day, secs) = local_day_and_secs(until, offset_at(until));
    let (today, _) = local_day_and_secs(now_ms, offset_at(now_ms));
    let clock = format!("{:02}:{:02}", secs / 3600, secs % 3600 / 60);
    match day - today {
        ..=0 => format!("Paused until {clock}"),
        1 => format!("Paused until tomorrow {clock}"),
        // 1970-01-01 was a Thursday
        _ => format!("Paused until {} {clock}", WEEKDAYS[(day + 4).rem_euclid(7) as usize]),
    }
}

/// Tomorrow at 08:00 local time, in epoch ms: by the offset that holds then (a clock change overnight is allowed for).
pub fn tomorrow_at_eight(now_ms: i64, offset_at: impl Fn(i64) -> i64) -> i64 {
    let (today, _) = local_day_and_secs(now_ms, offset_at(now_ms));
    let local_secs = (today + 1) * 86_400 + 8 * 3600;
    let guess = (local_secs - offset_at(now_ms)) * 1000;
    (local_secs - offset_at(guess)) * 1000
}

/// What Home's Pause offers (#205).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseChoice {
    Hour,
    Tomorrow,
    UntilResumed,
}

impl PauseChoice {
    pub const ALL: [PauseChoice; 3] = [PauseChoice::Hour, PauseChoice::Tomorrow, PauseChoice::UntilResumed];

    pub fn label(self) -> &'static str {
        match self {
            PauseChoice::Hour => "For 1 hour",
            PauseChoice::Tomorrow => "Until tomorrow",
            PauseChoice::UntilResumed => "Until I resume",
        }
    }

    /// When the pause ends (epoch ms), None until resumed.
    pub fn until(self, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> Option<i64> {
        match self {
            PauseChoice::Hour => Some(now_ms + 3_600_000),
            PauseChoice::Tomorrow => Some(tomorrow_at_eight(now_ms, offset_at)),
            PauseChoice::UntilResumed => None,
        }
    }
}

/// The main button's label, and the `paused` it asks for: Resume when paused by the setting or the state.
pub fn pause_button(status: &DaemonStatus) -> (&'static str, bool) {
    if status.state == "paused" || status.settings.paused {
        ("Resume", false)
    } else {
        ("Pause", true)
    }
}

/// Whether the main button is the filled (primary) one: only Resume is. Pause looks like Sync now.
pub fn pause_button_is_primary(status: &DaemonStatus) -> bool {
    !pause_button(status).1
}

/// How the drive is shown, under its location.
pub fn drive_kind(vfs: Option<&VfsStatus>) -> &'static str {
    match vfs {
        Some(v) if v.reason.as_deref() == Some("moving") => "Moving files…",
        Some(v) if v.reason.as_deref() == Some("starting") => "Starting the virtual drive…",
        Some(v) if v.mode == "virtual" && v.mounted => "Virtual drive · mounted",
        Some(v) if v.mode == "virtual" => "Virtual drive · not mounted",
        _ => "Plain folder",
    }
}

/// The folder holding a conflict's file, which Show in Files opens.
pub fn conflict_folder(sync_dir: &str, rel_path: &str) -> std::path::PathBuf {
    let file = std::path::Path::new(sync_dir).join(rel_path);
    file.parent().map_or_else(|| std::path::PathBuf::from(sync_dir), std::path::Path::to_path_buf)
}

fn file_name(rel_path: &str) -> &str {
    rel_path.rsplit('/').next().unwrap_or(rel_path)
}

/// What happened to a conflict's file, by its name (its path is in the tooltip). Unresolved conflicts only exist under
/// the "ask me" strategy: the daemon queued the file for the user and kept nothing twice yet.
pub fn conflict_title(rel_path: &str) -> String {
    format!("Changed here and in Proton Drive: {}", file_name(rel_path))
}

/// One way to resolve a conflict: what it asks the daemon for, its button and what its hover text says it does.
pub struct ConflictChoice {
    pub choice: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
}

/// The choices in the order shown: Keep Both first, as the main one, since it replaces nothing.
pub const CONFLICT_CHOICES: [ConflictChoice; 3] = [
    ConflictChoice {
        choice: "keep-both",
        label: "Keep Both",
        hint: "Keep both versions: this computer's is saved as a renamed copy next to the Proton Drive version",
    },
    ConflictChoice {
        choice: "keep-local",
        label: "Keep Local",
        hint: "Use this computer's version: replaces the one in Proton Drive",
    },
    ConflictChoice {
        choice: "keep-remote",
        label: "Keep Remote",
        hint: "Use the Proton Drive version: replaces the one on this computer",
    },
];

pub fn failed_items_text(n: u64) -> String {
    if n == 1 {
        "1 file couldn't sync".to_string()
    } else {
        format!("{n} files couldn't sync")
    }
}

/// How many transfers In progress lists before "N more".
pub const IN_PROGRESS_SHOWN: usize = 5;

/// "N more" under the transfers listed, when there are more than `IN_PROGRESS_SHOWN`.
pub fn more_transfers(total: usize) -> Option<String> {
    (total > IN_PROGRESS_SHOWN).then(|| format!("{} more", total - IN_PROGRESS_SHOWN))
}

/// The account's storage: "X of Y", how full the bar is, and Drive's share for the tooltip.
#[derive(Clone, Debug, PartialEq)]
pub struct Storage {
    pub text: String,
    pub fraction: f32,
    pub tooltip: String,
}

/// None without the account's usage (signed out, or an older daemon) or a quota.
pub fn storage(account: Option<&AccountInfo>) -> Option<Storage> {
    let a = account.filter(|a| a.max_space > 0)?;
    Some(Storage {
        text: format!("{} of {}", format_bytes(a.used_space), format_bytes(a.max_space)),
        fraction: (a.used_space as f64 / a.max_space as f64).clamp(0.0, 1.0) as f32,
        tooltip: format!("Drive uses {}", format_bytes(a.used_drive_space)),
    })
}

/// The headline's colour.
fn tone_color(tone: Tone) -> Color32 {
    match tone {
        Tone::Ok => STATUS_SUCCESS,
        Tone::Busy => PROTON_PURPLE_TEXT(),
        Tone::Paused => TEXT_MUTED(),
        Tone::Attention => STATUS_WARNING,
        Tone::Offline => STATUS_DANGER,
    }
}

/// Opens a folder in the file manager; a screenshot opens nothing.
pub(crate) fn open_in_files(folder: &std::path::Path) {
    open_externally(folder.as_os_str(), screenshot());
}

/// Proton Drive on the web, and its trash: where a delete through the drive puts what was deleted (#201)
pub(crate) const PROTON_DRIVE_WEB_URL: &str = "https://drive.proton.me";
pub(crate) const PROTON_DRIVE_TRASH_URL: &str = "https://drive.proton.me/trash";
pub(crate) const OPEN_TRASH: &str = "Open Proton Drive Trash";

/// What the trash button says on hover: deleted files wait there, and come back to the sync folder when restored
pub(crate) fn trash_hover(sync_dir: &str) -> String {
    let folder = if sync_dir.is_empty() { "~/ProtonDrive".to_string() } else { shown_folder(sync_dir) };
    format!("Deleted files stay here until you empty the trash or restore them. Restoring brings them back to {folder}.")
}

/// Opens a page in the default browser; a screenshot opens nothing.
pub(crate) fn open_in_browser(url: &str) {
    open_externally(std::ffi::OsStr::new(url), screenshot());
}

/// Whether the app only renders a screenshot. A test can say so for its own thread (AS_SCREENSHOT), as the global is
/// shared by tests running at once
fn screenshot() -> bool {
    #[cfg(test)]
    if AS_SCREENSHOT.with(|s| s.get()) {
        return true;
    }
    SCREENSHOT_MODE.load(Ordering::SeqCst)
}

/// The one way the app opens a folder or a page, with the desktop's own handler (xdg-open), except in a screenshot.
/// Tests see what would have been opened (LAUNCHED) instead of opening it.
pub(crate) fn open_externally(target: &std::ffi::OsStr, screenshot: bool) {
    if screenshot {
        return;
    }
    #[cfg(test)]
    LAUNCHED.with(|launched| launched.borrow_mut().push(target.to_string_lossy().into_owned()));
    #[cfg(not(test))]
    spawn_opener(target);
}

#[cfg_attr(test, allow(dead_code))]
fn spawn_opener(target: &std::ffi::OsStr) {
    let _ = spawn_reaped(Command::new("xdg-open").arg(target));
}

/// Opens a file with its default app; a screenshot opens nothing.
pub(crate) fn open_file(file: &std::path::Path) {
    open_externally(file.as_os_str(), screenshot());
}

/// Shows an item in the file manager, selected in its folder (the file manager's ShowItems), or, where no file manager
/// answers that, opens the folder it is in; a screenshot shows nothing. Tests see "show:<path>" in LAUNCHED (#94).
pub(crate) fn show_in_files(item: &std::path::Path) {
    if screenshot() {
        return;
    }
    #[cfg(test)]
    LAUNCHED.with(|launched| launched.borrow_mut().push(format!("show:{}", item.display())));
    #[cfg(not(test))]
    spawn_show_items(item.to_path_buf());
}

#[cfg_attr(test, allow(dead_code))]
fn spawn_show_items(item: std::path::PathBuf) {
    std::thread::spawn(move || {
        let shown = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
            ])
            .arg(format!("array:string:{}", crate::activity::file_uri(&item)))
            .arg("string:")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !shown {
            let folder = if item.is_dir() { item.as_path() } else { item.parent().unwrap_or(&item) };
            let _ = spawn_reaped(Command::new("xdg-open").arg(folder));
        }
    });
}

#[cfg(test)]
thread_local! {
    /// What open_externally would have opened, on this test's thread
    pub(crate) static LAUNCHED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    /// This test's thread renders as a screenshot does (see screenshot)
    pub(crate) static AS_SCREENSHOT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A secondary (outlined) button, as wide as its label.
pub(crate) fn secondary_button(ui: &mut egui::Ui, label: &str, height: f32) -> egui::Response {
    action_button(ui, ButtonKind::Secondary, None, label, height)
}

pub(crate) fn primary_button(ui: &mut egui::Ui, label: &str, height: f32) -> egui::Response {
    action_button(ui, ButtonKind::Primary, None, label, height)
}

const PAUSE_CHOICES_ID: &str = "pause_choices";

/// Home's Pause choices (#205), in a small card under the Pause button (its right edges lined up), over an invisible
/// shield so that a click outside only closes them. The choice clicked, if one was.
fn pause_choices(ctx: &egui::Context, anchor: egui::Rect) -> Option<PauseChoice> {
    crate::click_shield(ctx, "pause_choices_shield", egui::Order::Foreground, None);
    let mut picked = None;
    egui::Area::new(egui::Id::new(PAUSE_CHOICES_ID))
        .order(egui::Order::Tooltip)
        .fixed_pos(anchor.right_bottom() + Vec2::new(0.0, 6.0))
        .pivot(egui::Align2::RIGHT_TOP)
        .show(ctx, |ui| {
            Frame::NONE
                .fill(crate::BG_CARD())
                .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                .corner_radius(CornerRadius::same(10))
                .shadow(egui::Shadow { offset: [0, 6], blur: 18, spread: 0, color: Color32::from_rgba_unmultiplied(0, 0, 0, 90) })
                .inner_margin(Margin::same(6))
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    for choice in PauseChoice::ALL {
                        if menu_item(ui, choice.label(), 168.0).clicked() {
                            picked = Some(choice);
                        }
                    }
                });
        });
    picked
}

/// Whether a click landed on the Pause choices, as last drawn. Takes their place rather than the context: it is read
/// inside `ui.input`, which holds egui's lock, and asking the context's memory there deadlocks.
fn pause_choices_hit(choices: Option<egui::Rect>, pointer: Option<egui::Pos2>) -> bool {
    matches!((choices, pointer), (Some(rect), Some(pos)) if rect.contains(pos))
}

/// A row of a small menu: its label on the left, highlighted on hover.
fn menu_item(ui: &mut egui::Ui, label: &str, width: f32) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 30.0), egui::Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        ui.painter().rect_filled(rect, CornerRadius::same(6), btn_secondary_hover_bg());
    }
    ui.painter().text(
        rect.left_center() + Vec2::new(10.0, 0.0),
        egui::Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(13.0),
        TEXT_PRIMARY(),
    );
    resp
}

fn card_title(ui: &mut egui::Ui, title: &str) {
    ui.label(RichText::new(title).size(15.5).strong().color(TEXT_PRIMARY()));
}

/// A line that never wraps: elided to the room left, the whole of `full` on hover.
pub(crate) fn elided(ui: &mut egui::Ui, text: RichText, full: &str) -> egui::Response {
    ui.add(egui::Label::new(text).truncate()).on_hover_text(full)
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

impl ProtonDriveNativeApp {
    /// Home: the status with Pause and Sync now, what needs the user, what is moving, and the drive.
    pub(crate) fn render_home(&mut self, ui: &mut egui::Ui) {
        ScrollArea::vertical()
            .id_salt("home_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                // A gutter for the scroll bar, so that it never draws over the cards' edges
                Frame::NONE.inner_margin(Margin { left: 0, right: 12, top: 0, bottom: 0 }).show(ui, |ui| {
                    self.render_status_block(ui);
                    self.render_notice(ui);
                    if !self.attention.is_empty() {
                        ui.add_space(14.0);
                        self.render_attention(ui);
                    }
                    if !self.status.active_transfers.is_empty() {
                        ui.add_space(14.0);
                        self.render_in_progress(ui);
                    }
                    ui.add_space(14.0);
                    self.render_your_drive(ui);
                });
            });
    }

    /// The status in a sentence, with Pause and Sync now, or Sign in while signed out.
    fn render_status_block(&mut self, ui: &mut egui::Ui) {
        let summary = status_summary(&self.status, self.daemon_online, self.initial_connecting, self.attention.len(), now_ms());
        let (pause_label, pause_to) = pause_button(&self.status);
        // Pause and Sync now mean nothing without an account: Sign in, as Settings › Account offers it
        let show_sign_in = self.daemon_online && signed_out(&self.status);
        let mut command = None;
        let mut sign_in = false;
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.horizontal_top(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                    if show_sign_in {
                        sign_in = primary_button(ui, "Sign in", 34.0).clicked();
                    } else {
                        ui.add_enabled_ui(self.daemon_online, |ui| {
                            // Pause looks like Sync now; Resume, while paused, is the filled one
                            let button = if pause_button_is_primary(&self.status) {
                                primary_button(ui, pause_label, 34.0)
                            } else {
                                secondary_button(ui, pause_label, 34.0)
                            };
                            if !pause_to {
                                if button.clicked() {
                                    command = Some(WorkerCommand::SetPaused { paused: false, until: None });
                                }
                            } else if self.pause_choices_open {
                                // Over a shield that takes the click on Pause too: any click outside closes them
                                if let Some(choice) = pause_choices(ui.ctx(), button.rect) {
                                    command = Some(WorkerCommand::SetPaused {
                                        paused: true,
                                        until: choice.until(now_ms(), local_offset_secs),
                                    });
                                }
                                // Read before ui.input: egui's context lock isn't re-entrant
                                let choices = ui.ctx().memory(|m| m.area_rect(egui::Id::new(PAUSE_CHOICES_ID)));
                                let outside = ui.input(|i| {
                                    i.key_pressed(egui::Key::Escape)
                                        || (i.pointer.primary_clicked() && !pause_choices_hit(choices, i.pointer.interact_pos()))
                                });
                                if command.is_some() || outside {
                                    self.pause_choices_open = false;
                                }
                            } else if button.clicked() {
                                self.pause_choices_open = true; // #205: For 1 hour, Until tomorrow, Until I resume
                            }
                            ui.add_space(4.0);
                            if secondary_button(ui, "Sync now", 34.0).clicked() {
                                command = Some(WorkerCommand::TriggerSync);
                            }
                        });
                    }
                    ui.add_space(12.0);
                    ui.with_layout(Layout::top_down(Align::Min), |ui| {
                        let headline = RichText::new(&summary.headline).size(18.0).strong().color(tone_color(summary.tone));
                        ui.add(egui::Label::new(headline).wrap());
                        if let Some(detail) = &summary.detail {
                            ui.add_space(2.0);
                            ui.add(egui::Label::new(RichText::new(detail).size(12.5).color(TEXT_MUTED())).wrap());
                        }
                        // The sign-in page opening (why it failed is in the notice below)
                        if show_sign_in && self.login_url.is_some() {
                            ui.add_space(2.0);
                            let text = "Opening the Proton sign-in page in your browser…";
                            ui.add(egui::Label::new(RichText::new(text).size(12.0).color(PROTON_PURPLE_TEXT())).wrap());
                        }
                    });
                });
            });
        });
        // Only while Pause is offered and can be used
        if !self.daemon_online || show_sign_in || !pause_to {
            self.pause_choices_open = false;
        }
        if let Some(command) = command {
            let _ = self.tx.send(command);
        }
        if sign_in {
            self.send_account_command(WorkerCommand::StartLogin);
        }
    }

    /// Needs attention: each problem with what can be done about it. Its list scrolls once taller than 280 px.
    fn render_attention(&mut self, ui: &mut egui::Ui) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_title(ui, "Needs attention");
            // Why the last resolve of a conflict was refused, once for the list
            if let Some(error) = &self.conflict_error {
                ui.add_space(4.0);
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
            }
            ui.add_space(10.0);
            ScrollArea::vertical()
                .id_salt("attention_scroll")
                .max_height(280.0)
                .auto_shrink([false, true])
                .show(ui, |ui| {
                    for (i, item) in self.attention.clone().into_iter().enumerate() {
                        if i > 0 {
                            ui.add_space(8.0);
                        }
                        self.render_attention_item(ui, item);
                    }
                });
        });
    }

    fn render_attention_item(&mut self, ui: &mut egui::Ui, item: Attention) {
        match item {
            Attention::AccountMismatch => self.render_account_mismatch(ui),
            Attention::FilesMissing => self.render_files_missing(ui),
            Attention::Conflict { id, rel_path } => {
                attention_row(ui, |ui| {
                    elided(ui, RichText::new(conflict_title(&rel_path)).size(13.5).strong().color(TEXT_PRIMARY()), &rel_path);
                    ui.add_space(8.0);
                    ui.horizontal_wrapped(|ui| {
                        if secondary_button(ui, "Show in Files", 30.0).clicked() {
                            open_in_files(&conflict_folder(&self.status.sync_dir, &rel_path));
                        }
                        ui.add_space(8.0);
                        // Resolving needs the daemon, as Pause and Sync now do
                        let online = self.daemon_online;
                        for (i, c) in CONFLICT_CHOICES.iter().enumerate() {
                            let clicked = ui
                                .add_enabled_ui(online, |ui| {
                                    let button = if i == 0 {
                                        primary_button(ui, c.label, 30.0)
                                    } else {
                                        secondary_button(ui, c.label, 30.0)
                                    };
                                    button.on_hover_text(c.hint).on_disabled_hover_text(c.hint)
                                })
                                .inner
                                .clicked();
                            if clicked {
                                let _ = self.tx.send(WorkerCommand::ResolveConflict { id, choice: c.choice.to_string() });
                            }
                        }
                    });
                });
            }
            Attention::DriveNotMounted { message, can_mount } => {
                attention_row(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(&message).size(13.5).strong().color(TEXT_PRIMARY())).wrap());
                    if let Some(hint) = self.status.vfs.as_ref().and_then(files_safe_hint) {
                        ui.add_space(2.0);
                        ui.add(egui::Label::new(RichText::new(hint).size(12.5).color(TEXT_MUTED())).wrap());
                    }
                    if can_mount {
                        ui.add_space(8.0);
                        let clicked = ui.add_enabled_ui(!self.drive_working, |ui| primary_button(ui, "Mount again", 32.0).clicked()).inner;
                        if clicked {
                            self.send_drive_command(WorkerCommand::MountAgain);
                        }
                    }
                    self.render_drive_progress(ui);
                });
            }
            Attention::StoppedMove => {
                let Some(vfs) = self.status.vfs.clone() else { return };
                attention_row(ui, |ui| {
                    // Why the move stopped, while that is the drive's state (render_stopped_move doesn't repeat it).
                    // Mounted or ejected again since, the drive's own line would be about something else
                    let failed = vfs.reason.as_deref() == Some("move-failed");
                    if failed {
                        let line = drive_status_line(&vfs, &self.status.sync_dir);
                        ui.add(egui::Label::new(RichText::new(line).size(13.5).strong().color(TEXT_PRIMARY())).wrap());
                    }
                    if let Some(mv) = &vfs.drive_move {
                        if failed {
                            ui.add_space(8.0);
                        }
                        self.render_stopped_move(ui, &vfs, mv);
                    }
                    self.render_drive_progress(ui);
                });
            }
            Attention::FailedItems(n) => attention_row(ui, |ui| {
                ui.label(RichText::new(failed_items_text(n)).size(13.5).strong().color(TEXT_PRIMARY()));
            }),
            Attention::LastError(text) => attention_row(ui, |ui| {
                ui.add(egui::Label::new(RichText::new(text).size(13.0).color(STATUS_DANGER)).wrap());
            }),
        }
    }

    /// While Mount again or a move action runs, and how it went.
    fn render_drive_progress(&self, ui: &mut egui::Ui) {
        if self.drive_working {
            ui.add_space(8.0);
            ui.label(RichText::new("↻ Working… moving files can take a while.").size(12.5).color(PROTON_PURPLE_TEXT()));
        }
        if let Some(error) = &self.drive_error {
            ui.add_space(8.0);
            ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
        }
    }

    /// In progress: the first transfers with their progress, then how many more.
    fn render_in_progress(&self, ui: &mut egui::Ui) {
        let transfers = &self.status.active_transfers;
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_title(ui, "In progress");
            ui.add_space(10.0);
            for t in transfers.iter().take(IN_PROGRESS_SHOWN) {
                let frac = if t.total_bytes > 0 {
                    (t.bytes_transferred as f32 / t.total_bytes as f32).clamp(0.0, 1.0)
                } else {
                    0.5
                };
                render_transfer_line(ui, t);
                ui.add_space(4.0);
                ui.add(egui::ProgressBar::new(frac).fill(PROTON_PURPLE).desired_height(6.0).corner_radius(CornerRadius::same(4)));
                ui.add_space(8.0);
            }
            if let Some(more) = more_transfers(transfers.len()) {
                ui.label(RichText::new(more).size(12.5).color(TEXT_MUTED()));
            }
        });
    }

    /// Your drive: where it is and how it is shown, its trash, and what is on this computer. Open in Files is the
    /// sidebar's, and the account's storage is at the sidebar's foot.
    fn render_your_drive(&mut self, ui: &mut egui::Ui) {
        let sync_dir = self.status.sync_dir.clone();
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            card_title(ui, "Your drive");
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // The trash, on the right. Not before a folder is set up
                    if !sync_dir.is_empty() {
                        if secondary_button(ui, OPEN_TRASH, 32.0).on_hover_text(trash_hover(&sync_dir)).clicked() {
                            open_in_browser(PROTON_DRIVE_TRASH_URL);
                        }
                        ui.add_space(8.0);
                    }
                    ui.with_layout(Layout::top_down(Align::Min), |ui| {
                        let shown = if sync_dir.is_empty() { "Not set up yet".to_string() } else { shown_folder(&sync_dir) };
                        elided(ui, RichText::new(&shown).size(14.0).strong().color(TEXT_PRIMARY()), &sync_dir);
                        ui.label(RichText::new(drive_kind(self.status.vfs.as_ref())).size(12.5).color(TEXT_MUTED()));
                    });
                });
            });

            ui.add_space(12.0);
            ui.separator();
            ui.add_space(10.0);
            let mut free = false;
            ui.horizontal(|ui| {
                // As tall as the button, so the labels sit level with it
                ui.set_min_height(32.0);
                ui.label(RichText::new("On this computer").size(13.0).color(TEXT_PRIMARY()));
                ui.add_space(6.0);
                ui.label(RichText::new(format_bytes(self.status.stats.total_bytes)).size(13.0).strong().color(TEXT_PRIMARY()));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // One free at a time, and only with the daemon there to do it
                    let can = self.daemon_online && self.working.is_empty();
                    free = ui.add_enabled_ui(can, |ui| secondary_button(ui, "Free up space…", 32.0).clicked()).inner;
                });
            });
            if free {
                self.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
            }
        });
    }
}

/// One problem in Needs attention, in its own box.
fn attention_row(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
    Frame::NONE
        .fill(BG_CARD_ALT())
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            add(ui);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActiveTransfer, DaemonStatus};

    const NOW: i64 = 1_800_000_000_000;

    fn transfer(direction: &str, path: &str) -> ActiveTransfer {
        ActiveTransfer {
            id: path.to_string(),
            direction: direction.to_string(),
            rel_path: path.to_string(),
            bytes_transferred: 0,
            total_bytes: 10,
        }
    }

    fn status(state: &str, transfers: Vec<ActiveTransfer>, paused: bool) -> DaemonStatus {
        let mut s = DaemonStatus {
            state: state.to_string(),
            active_transfers: transfers,
            logged_in: true,
            ..Default::default()
        };
        s.settings.paused = paused;
        s
    }

    #[test]
    fn summary_when_up_to_date() {
        let mut s = status("idle", vec![], false);
        s.last_sync_at = Some(NOW - 120_000);
        let r = status_summary(&s, true, false, 0, NOW);
        assert_eq!(r.headline, "Up to date");
        assert_eq!(r.detail.as_deref(), Some("Last synced 2 min ago"));
        assert_eq!(r.tone, Tone::Ok);
        s.last_sync_at = None;
        assert_eq!(status_summary(&s, true, false, 0, NOW).detail, None);
    }

    #[test]
    fn summary_names_what_moves() {
        let up = |n: usize| (0..n).map(|i| transfer("upload", &format!("a{i}.txt"))).collect::<Vec<_>>();
        let cases = [
            (up(3), "Uploading 3 files"),
            (vec![up(1).remove(0)], "Uploading a0.txt"),
            (vec![transfer("download", "docs/report.pdf")], "Downloading report.pdf"),
            (
                vec![transfer("upload", "a"), transfer("upload", "b"), transfer("download", "c")],
                "Syncing 3 files",
            ),
            (vec![transfer("download", "a"), transfer("download", "b")], "Downloading 2 files"),
            (vec![], "Checking for changes…"),
        ];
        for (transfers, want) in cases {
            let r = status_summary(&status("syncing", transfers, false), true, false, 0, NOW);
            assert_eq!(r.headline, want);
            assert_eq!(r.tone, Tone::Busy);
            assert_eq!(r.detail, None);
        }
    }

    #[test]
    fn summary_never_shows_engine_text() {
        let mut s = status("syncing", vec![], false);
        s.current_action = Some("Listing /my-files/deployment".to_string());
        let r = status_summary(&s, true, false, 0, NOW);
        let all = format!("{} {}", r.headline, r.detail.unwrap_or_default());
        assert!(!all.contains("/my-files") && !all.contains("Listing"));
    }

    #[test]
    fn summary_reads_paused_from_either_field() {
        for s in [status("paused", vec![], false), status("idle", vec![], true)] {
            let r = status_summary(&s, true, false, 0, NOW);
            assert_eq!(r.headline, "Paused");
            assert_eq!(r.tone, Tone::Paused);
        }
    }

    #[test]
    fn summary_when_something_needs_the_user() {
        let s = status("idle", vec![], false);
        let one = status_summary(&s, true, false, 1, NOW);
        assert_eq!(one.headline, "1 problem needs you");
        assert_eq!(one.detail.as_deref(), Some("See Needs attention below"));
        assert_eq!(one.tone, Tone::Attention);
        assert_eq!(status_summary(&s, true, false, 3, NOW).headline, "3 problems need you");
    }

    #[test]
    fn summary_when_signed_out() {
        for s in [
            DaemonStatus { state: "idle".into(), logged_in: false, ..Default::default() },
            DaemonStatus { state: "unauthenticated".into(), logged_in: true, ..Default::default() },
        ] {
            let r = status_summary(&s, true, false, 0, NOW);
            assert_eq!(r.headline, "Signed out");
            assert_eq!(r.detail.as_deref(), Some("Sign in to sync your files"));
            assert_eq!(r.tone, Tone::Attention);
            assert!(signed_out(&s));
        }
        assert!(!signed_out(&status("idle", vec![], false)));
        // Unreachable comes first: whether signed in can't be known
        let out = DaemonStatus { logged_in: false, ..Default::default() };
        assert_eq!(status_summary(&out, false, false, 0, NOW).tone, Tone::Offline);
        // Signed out comes before paused
        let mut paused_out = status("paused", vec![], true);
        paused_out.logged_in = false;
        assert_eq!(status_summary(&paused_out, true, false, 0, NOW).headline, "Signed out");
    }

    #[test]
    fn summary_while_first_connecting_is_not_the_offline_line() {
        let s = status("idle", vec![], false);
        let r = status_summary(&s, false, true, 0, NOW);
        assert_eq!(r.headline, "Connecting…");
        assert_eq!(r.tone, Tone::Busy);
        // Once the first try is over, unreachable says so
        assert_eq!(status_summary(&s, false, false, 0, NOW).tone, Tone::Offline);
    }

    #[test]
    fn summary_while_the_drive_moves_files() {
        let mut s = status("syncing", vec![transfer("upload", "a.txt")], false);
        s.vfs = Some(vfs("plain", false, Some("moving")));
        let r = status_summary(&s, true, false, 0, NOW);
        assert_eq!(r.headline, "Moving files…");
        assert_eq!(r.tone, Tone::Busy);
        // Below unreachable, signed out and paused
        s.settings.paused = true;
        assert_eq!(status_summary(&s, true, false, 0, NOW).headline, "Paused");
        s.logged_in = false;
        assert_eq!(status_summary(&s, true, false, 0, NOW).headline, "Signed out");
        assert_eq!(status_summary(&s, false, false, 0, NOW).tone, Tone::Offline);
    }

    #[test]
    fn summary_of_an_error_without_a_message_is_not_up_to_date() {
        let mut s = status("error", vec![], false);
        s.last_sync_at = Some(NOW - 120_000);
        let r = status_summary(&s, true, false, 0, NOW);
        assert_eq!(r.headline, "Sync stopped");
        assert_eq!(r.detail.as_deref(), Some("Check the log or try Sync now"));
        assert_eq!(r.tone, Tone::Attention);
        // With a message, it is in Needs attention and the headline counts it
        assert_eq!(status_summary(&s, true, false, 1, NOW).headline, "1 problem needs you");
    }

    #[test]
    fn summary_when_the_daemon_is_unreachable() {
        for s in [status("idle", vec![], false), status("paused", vec![], true)] {
            let r = status_summary(&s, false, false, 2, NOW);
            assert_eq!(r.headline, "Can't reach Proton Drive's background service");
            assert_eq!(r.tone, Tone::Offline);
        }
    }

    fn conflict(id: u64, path: &str, resolved: u8) -> ConflictRecord {
        ConflictRecord { id, local_rel_path: path.to_string(), resolved, ..Default::default() }
    }

    fn vfs(mode: &str, mounted: bool, reason: Option<&str>) -> crate::VfsStatus {
        crate::VfsStatus { mode: mode.into(), mounted, reason: reason.map(String::from), ..Default::default() }
    }

    fn missing() -> crate::FilesMissing {
        crate::FilesMissing { root: "/r".into(), names: vec!["Docs".into()], items: 1, message: "m".into() }
    }

    #[test]
    fn attention_lists_each_problem_once_in_order() {
        let mut s = status("idle", vec![], false);
        s.files_missing = Some(missing());
        s.vfs = Some(vfs("virtual", false, Some("move-failed")));
        s.stats.error_items = 3;
        s.last_error = Some("boom".into());
        let all = attention_items(&s, &[conflict(9, "b", 0), conflict(2, "a", 0)]);
        assert_eq!(
            all,
            vec![
                Attention::FilesMissing,
                Attention::StoppedMove,
                Attention::Conflict { id: 2, rel_path: "a".into() },
                Attention::Conflict { id: 9, rel_path: "b".into() },
                Attention::FailedItems(3),
            ]
        );
        s.files_missing = None;
        s.vfs = Some(vfs("virtual", false, Some("ejected")));
        let all = attention_items(&s, &[conflict(1, "a", 0)]);
        assert_eq!(
            all,
            vec![
                Attention::DriveNotMounted { message: "Virtual drive: ejected".into(), can_mount: true },
                Attention::Conflict { id: 1, rel_path: "a".into() },
                Attention::FailedItems(3),
                Attention::LastError("boom".into()),
            ]
        );
    }

    #[test]
    fn no_attention_when_all_is_well() {
        assert!(attention_items(&status("idle", vec![], false), &[]).is_empty());
        let mut s = status("idle", vec![], false);
        s.vfs = Some(vfs("virtual", true, None));
        s.last_error = Some("  ".into());
        assert!(attention_items(&s, &[]).is_empty());
    }

    #[test]
    fn resolved_conflicts_are_not_listed() {
        let s = status("idle", vec![], false);
        assert!(attention_items(&s, &[conflict(1, "a", 1), conflict(2, "b", 2)]).is_empty());
    }

    #[test]
    fn no_mount_attention_for_a_plain_folder_or_an_old_daemon() {
        let mut s = status("idle", vec![], false);
        s.vfs = None;
        assert!(attention_items(&s, &[]).is_empty());
        s.vfs = Some(vfs("plain", false, Some("switched-off")));
        assert!(attention_items(&s, &[]).is_empty());
        for r in ["starting", "moving"] {
            s.vfs = Some(vfs("virtual", false, Some(r)));
            assert!(attention_items(&s, &[]).is_empty());
        }
    }

    #[test]
    fn a_stopped_move_is_attention_not_a_mount_problem() {
        let mut s = status("idle", vec![], false);
        let mut v = vfs("virtual", false, Some("move-failed"));
        v.drive_move = Some(crate::DriveMove { actions: vec!["retry".into()], ..Default::default() });
        s.vfs = Some(v);
        assert_eq!(attention_items(&s, &[]), vec![Attention::StoppedMove]);
        // In plain mode, and without the move's details
        s.vfs = Some(vfs("plain", false, Some("move-failed")));
        assert_eq!(attention_items(&s, &[]), vec![Attention::StoppedMove]);
    }

    #[test]
    fn a_stopped_move_is_listed_while_the_drive_is_mounted_again() {
        let mut s = status("idle", vec![], false);
        let mut v = vfs("virtual", true, None);
        v.drive_move = Some(crate::DriveMove { actions: vec!["retry".into()], ..Default::default() });
        s.vfs = Some(v.clone());
        assert_eq!(attention_items(&s, &[]), vec![Attention::StoppedMove]);
        // With only its error, too
        v.drive_move = Some(crate::DriveMove { error: Some("Permission denied".into()), ..Default::default() });
        s.vfs = Some(v.clone());
        assert_eq!(attention_items(&s, &[]), vec![Attention::StoppedMove]);
        // Neither actions nor an error: nothing to do about it
        v.drive_move = Some(crate::DriveMove::default());
        s.vfs = Some(v);
        assert!(attention_items(&s, &[]).is_empty());
    }

    #[test]
    fn an_ejected_drive_with_a_stopped_move_lists_both() {
        let mut s = status("idle", vec![], false);
        let mut v = vfs("virtual", false, Some("ejected"));
        v.drive_move = Some(crate::DriveMove { actions: vec!["retry".into()], ..Default::default() });
        s.vfs = Some(v);
        assert_eq!(
            attention_items(&s, &[]),
            vec![
                Attention::StoppedMove,
                Attention::DriveNotMounted { message: "Virtual drive: ejected".into(), can_mount: true },
            ]
        );
    }

    #[test]
    fn a_virtual_drive_unmounted_for_no_known_reason_cannot_mount_again() {
        let mut s = status("idle", vec![], false);
        s.vfs = Some(vfs("virtual", false, None));
        assert_eq!(
            attention_items(&s, &[]),
            vec![Attention::DriveNotMounted { message: "Virtual drive: not mounted".into(), can_mount: false }]
        );
    }

    #[test]
    fn last_error_is_listed_only_when_files_are_not_missing() {
        let mut s = status("idle", vec![], false);
        s.last_error = Some("boom".into());
        assert_eq!(attention_items(&s, &[]), vec![Attention::LastError("boom".into())]);
        s.files_missing = Some(missing());
        assert_eq!(attention_items(&s, &[]), vec![Attention::FilesMissing]);
    }

    fn mismatch() -> crate::AccountMismatch {
        crate::AccountMismatch { message: "You signed in to a different Proton account.".into() }
    }

    // #35: another account's records block every sync, so the mismatch comes first, and the error it sets isn't repeated
    #[test]
    fn another_accounts_records_come_first_and_explain_the_last_error() {
        let mut s = status("error", vec![], false);
        s.account_mismatch = Some(mismatch());
        s.last_error = Some("You signed in to a different Proton account.".into());
        assert_eq!(attention_items(&s, &[]), vec![Attention::AccountMismatch]);

        s.files_missing = Some(missing());
        s.vfs = Some(vfs("virtual", false, Some("ejected")));
        s.stats.error_items = 1;
        assert_eq!(
            attention_items(&s, &[conflict(4, "a", 0)]),
            vec![
                Attention::AccountMismatch,
                Attention::FilesMissing,
                Attention::DriveNotMounted { message: "Virtual drive: ejected".into(), can_mount: true },
                Attention::Conflict { id: 4, rel_path: "a".into() },
                Attention::FailedItems(1),
            ]
        );
    }

    #[test]
    fn another_accounts_records_count_as_a_problem_in_the_status() {
        let mut s = status("error", vec![], false);
        s.account_mismatch = Some(mismatch());
        let n = attention_items(&s, &[]).len();
        let r = status_summary(&s, true, false, n, 0);
        assert_eq!(r.headline, "1 problem needs you");
        assert_eq!(r.tone, Tone::Attention);
    }

    #[test]
    fn failed_items_come_from_stats() {
        let mut s = status("idle", vec![], false);
        s.stats.error_items = 2;
        assert_eq!(attention_items(&s, &[]), vec![Attention::FailedItems(2)]);
    }

    #[test]
    fn conflicts_reload_while_any_is_open_or_the_count_changes() {
        // Nothing open, nothing listed, same count: no need to ask again
        assert!(!should_reload_conflicts(false, 0, 0, 0));
        // The count changed, either way
        assert!(should_reload_conflicts(false, 0, 1, 0));
        assert!(should_reload_conflicts(false, 2, 1, 2));
        // One open: every refresh, so one resolved and another new between two polls is not missed
        assert!(should_reload_conflicts(false, 1, 1, 1));
        // The daemon says none are open but the list still shows one: reload to clear it
        assert!(should_reload_conflicts(false, 0, 0, 1));
        // The daemon came back
        assert!(should_reload_conflicts(true, 0, 0, 0));
    }

    // #205: times by a fixed offset from UTC, so the tests don't depend on the machine's time zone
    const CET: i64 = 3600;
    /// 2026-11-04 (a Wednesday) at 00:00 UTC, in epoch ms
    const NOV_4_UTC: i64 = 1_793_750_400_000;

    /// Epoch ms of `days` after 2026-11-04 at hh:mm, local time `offset` seconds east of UTC.
    fn local(days: i64, hh: i64, mm: i64, offset: i64) -> i64 {
        NOV_4_UTC + days * 86_400_000 + (hh * 3600 + mm * 60 - offset) * 1000
    }

    #[test]
    fn a_click_hits_the_pause_choices_only_inside_them_as_last_drawn() {
        let rect = egui::Rect::from_min_size(egui::pos2(100.0, 100.0), egui::vec2(180.0, 96.0));
        assert!(pause_choices_hit(Some(rect), Some(egui::pos2(150.0, 120.0))));
        assert!(!pause_choices_hit(Some(rect), Some(egui::pos2(50.0, 120.0))));
        assert!(!pause_choices_hit(None, Some(egui::pos2(150.0, 120.0)))); // not drawn yet
        assert!(!pause_choices_hit(Some(rect), None)); // no pointer
    }

    #[test]
    fn paused_headline_says_until_when() {
        let off = |_| CET;
        let now = local(0, 10, 30, CET);
        assert_eq!(paused_headline(None, now, off), "Paused");
        assert_eq!(paused_headline(Some(local(0, 15, 0, CET)), now, off), "Paused until 15:00");
        assert_eq!(paused_headline(Some(local(0, 23, 59, CET)), now, off), "Paused until 23:59");
        assert_eq!(paused_headline(Some(local(1, 8, 0, CET)), now, off), "Paused until tomorrow 08:00");
        assert_eq!(paused_headline(Some(local(5, 8, 0, CET)), now, off), "Paused until Mon 08:00");
        assert_eq!(paused_headline(Some(local(2, 7, 5, CET)), now, off), "Paused until Fri 07:05");
        // Just after local midnight, by the local day, not UTC's
        let late = local(0, 0, 30, CET);
        assert_eq!(paused_headline(Some(local(0, 8, 0, CET)), late, off), "Paused until 08:00");
        // West of UTC too
        let west = |_| -5 * 3600;
        assert_eq!(paused_headline(Some(local(1, 8, 0, -5 * 3600)), local(0, 22, 0, -5 * 3600), west), "Paused until tomorrow 08:00");
        // A time already past (the daemon is about to resume) reads as a time today
        assert_eq!(paused_headline(Some(local(0, 9, 0, CET)), now, off), "Paused until 09:00");
    }

    #[test]
    fn tomorrow_at_eight_is_the_next_local_day_at_eight() {
        let off = |_| CET;
        assert_eq!(tomorrow_at_eight(local(0, 10, 30, CET), off), local(1, 8, 0, CET));
        assert_eq!(tomorrow_at_eight(local(0, 0, 10, CET), off), local(1, 8, 0, CET));
        assert_eq!(tomorrow_at_eight(local(0, 23, 59, CET), off), local(1, 8, 0, CET));
        // Across a clock change: +2 h until tomorrow 03:00 local, +1 h from then on, so 08:00 is by the new offset
        let change = local(1, 3, 0, CET);
        let dst = move |ms: i64| if ms < change { 2 * 3600 } else { CET };
        assert_eq!(tomorrow_at_eight(local(0, 10, 30, 2 * 3600), dst), local(1, 8, 0, CET));
    }

    #[test]
    fn the_pause_choices_and_their_times() {
        let off = |_| CET;
        let now = local(0, 10, 30, CET);
        let labels: Vec<&str> = PauseChoice::ALL.iter().map(|c| c.label()).collect();
        assert_eq!(labels, ["For 1 hour", "Until tomorrow", "Until I resume"]);
        assert_eq!(PauseChoice::Hour.until(now, off), Some(now + 3_600_000));
        assert_eq!(PauseChoice::Tomorrow.until(now, off), Some(local(1, 8, 0, CET)));
        assert_eq!(PauseChoice::UntilResumed.until(now, off), None);
    }

    #[test]
    fn the_local_offset_is_one_the_machine_could_have() {
        let off = local_offset_secs(NOW);
        assert!((-14 * 3600..=14 * 3600).contains(&off), "{off}");
    }

    #[test]
    fn summary_says_until_when_paused_with_a_time() {
        let mut s = status("paused", vec![], true);
        s.settings.paused_until = Some(NOW + 30 * 60_000);
        let r = status_summary(&s, true, false, 0, NOW);
        assert!(r.headline.starts_with("Paused until "), "{}", r.headline);
        assert_eq!(r.tone, Tone::Paused);
    }

    #[test]
    fn pause_reads_paused_from_either_field_and_sends_the_opposite() {
        assert_eq!(pause_button(&status("idle", vec![], false)), ("Pause", true));
        assert_eq!(pause_button(&status("syncing", vec![], false)), ("Pause", true));
        assert_eq!(pause_button(&status("paused", vec![], false)), ("Resume", false));
        assert_eq!(pause_button(&status("idle", vec![], true)), ("Resume", false));
    }

    #[test]
    fn only_resume_is_the_filled_button() {
        assert!(!pause_button_is_primary(&status("idle", vec![], false)));
        assert!(!pause_button_is_primary(&status("syncing", vec![], false)));
        assert!(pause_button_is_primary(&status("paused", vec![], false)));
        assert!(pause_button_is_primary(&status("idle", vec![], true)));
    }

    #[test]
    fn drive_kind_says_how_the_drive_is_shown() {
        assert_eq!(drive_kind(Some(&vfs("virtual", true, None))), "Virtual drive · mounted");
        assert_eq!(drive_kind(Some(&vfs("virtual", false, Some("ejected")))), "Virtual drive · not mounted");
        assert_eq!(drive_kind(Some(&vfs("plain", false, Some("switched-off")))), "Plain folder");
        // While it moves files or starts, it says so
        assert_eq!(drive_kind(Some(&vfs("plain", false, Some("moving")))), "Moving files…");
        assert_eq!(drive_kind(Some(&vfs("virtual", false, Some("moving")))), "Moving files…");
        assert_eq!(drive_kind(Some(&vfs("virtual", false, Some("starting")))), "Starting the virtual drive…");
        // A daemon before the virtual drive syncs a plain folder
        assert_eq!(drive_kind(None), "Plain folder");
    }

    #[test]
    fn a_conflict_is_shown_in_the_folder_holding_it() {
        assert_eq!(conflict_folder("/home/u/ProtonDrive", "docs/2026/report.pdf"), std::path::PathBuf::from("/home/u/ProtonDrive/docs/2026"));
        assert_eq!(conflict_folder("/home/u/ProtonDrive", "report.pdf"), std::path::PathBuf::from("/home/u/ProtonDrive"));
    }

    #[test]
    fn a_conflict_says_both_versions_changed_not_that_both_were_kept() {
        assert_eq!(conflict_title("docs/report.pdf"), "Changed here and in Proton Drive: report.pdf");
        assert_eq!(conflict_title("report.pdf"), "Changed here and in Proton Drive: report.pdf");
        // Each choice says what it does, and which version it replaces
        let hints: Vec<_> = CONFLICT_CHOICES.iter().map(|c| (c.choice, c.label, c.hint)).collect();
        assert_eq!(
            hints,
            vec![
                ("keep-both", "Keep Both", "Keep both versions: this computer's is saved as a renamed copy next to the Proton Drive version"),
                ("keep-local", "Keep Local", "Use this computer's version: replaces the one in Proton Drive"),
                ("keep-remote", "Keep Remote", "Use the Proton Drive version: replaces the one on this computer"),
            ]
        );
    }

    #[test]
    fn failed_items_in_plain_words() {
        assert_eq!(failed_items_text(1), "1 file couldn't sync");
        assert_eq!(failed_items_text(4), "4 files couldn't sync");
    }

    #[test]
    fn in_progress_shows_five_then_how_many_more() {
        assert_eq!(IN_PROGRESS_SHOWN, 5);
        assert_eq!(more_transfers(0), None);
        assert_eq!(more_transfers(5), None);
        assert_eq!(more_transfers(6).as_deref(), Some("1 more"));
        assert_eq!(more_transfers(12).as_deref(), Some("7 more"));
    }

    #[test]
    fn storage_is_the_accounts_usage_of_its_quota() {
        const GB: u64 = 1024 * 1024 * 1024;
        let account = crate::AccountInfo { used_space: 51 * GB, max_space: 510 * GB, used_drive_space: 2 * GB, ..Default::default() };
        let s = storage(Some(&account)).unwrap();
        assert_eq!(s.text, "51.0 GB of 510.0 GB");
        assert!((s.fraction - 0.1).abs() < 1e-6);
        assert_eq!(s.tooltip, "Drive uses 2.0 GB");
        // Over quota still draws a full bar, not past it
        let over = crate::AccountInfo { used_space: 3 * GB, max_space: 2 * GB, ..Default::default() };
        assert_eq!(storage(Some(&over)).unwrap().fraction, 1.0);
        // No account, or no quota, no row
        assert_eq!(storage(None), None);
        assert_eq!(storage(Some(&crate::AccountInfo::default())), None);
    }

    #[test]
    fn ago_in_plain_words() {
        assert_eq!(ago(30_000), "just now");
        assert_eq!(ago(120_000), "2 min ago");
        assert_eq!(ago(2 * 3_600_000), "2 h ago");
        assert_eq!(ago(3 * 86_400_000), "3 days ago");
        assert_eq!(ago(86_400_000), "1 day ago");
        assert_eq!(ago(-5_000), "just now");
    }
}
