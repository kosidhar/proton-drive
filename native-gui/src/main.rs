mod activity;
mod chrome;
mod home;
mod icons;
mod settings;
mod share;
mod shared;
mod single_instance;

use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Align, Color32, CornerRadius, FontFamily, FontId, Frame, IconData, Key, Layout, Margin,
    RichText, ScrollArea, Sense, Stroke, TextureHandle, TextureOptions, Vec2, ViewportCommand,
};
use serde::{Deserialize, Serialize};

/// The daemon's TCP API: 127.0.0.1 at $PROTON_DRIVE_DAEMON_PORT, as the daemon reads it, else at 49152
fn daemon_url_for(port: Option<&str>) -> String {
    let port = port.and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p != 0).unwrap_or(49152);
    format!("http://127.0.0.1:{port}")
}

fn daemon_url() -> &'static str {
    static URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    URL.get_or_init(|| daemon_url_for(std::env::var("PROTON_DRIVE_DAEMON_PORT").ok().as_deref()))
}

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

/// The app's colours in one theme. The token functions below (`BG_CANVAS()`, …) read the theme in use, so tests can
/// check both palettes without switching themes.
pub(crate) struct Palette {
    /// The section area and the top bar
    pub(crate) canvas: Color32,
    pub(crate) sidebar: Color32,
    /// The sidebar's row for the section that is open
    pub(crate) sidebar_selected: Color32,
    /// A sidebar row under the pointer
    pub(crate) sidebar_hover: Color32,
    /// Section names and "Proton Drive" in the sidebar
    pub(crate) sidebar_text: Color32,
    /// The sidebar's quieter text and its icons
    pub(crate) sidebar_weak: Color32,
    /// The sidebar's storage meter: what is used, over the track
    pub(crate) storage_fill: Color32,
    pub(crate) storage_track: Color32,
    pub(crate) card: Color32,
    pub(crate) card_alt: Color32,
    pub(crate) input: Color32,
    /// Separators and card edges
    pub(crate) border_weak: Color32,
    /// Secondary buttons' outline
    pub(crate) border_norm: Color32,
    pub(crate) text: Color32,
    pub(crate) text_weak: Color32,
    pub(crate) purple_soft: Color32,
    pub(crate) purple_text: Color32,
    /// Folders in lists
    pub(crate) folder: Color32,
    /// Red words: an error, an expired link. `STATUS_DANGER` stays for red fills and outlines
    pub(crate) danger_text: Color32,
}

/// Proton's light theme, as drive.proton.me shows it (#276)
pub(crate) const LIGHT: Palette = Palette {
    canvas: Color32::WHITE,
    sidebar: Color32::from_rgb(0x21, 0x1A, 0x42),
    sidebar_selected: Color32::from_rgb(0x2E, 0x23, 0x59),
    sidebar_hover: Color32::from_rgb(0x28, 0x20, 0x4D),
    sidebar_text: Color32::WHITE,
    sidebar_weak: Color32::from_rgb(0xB1, 0xA1, 0xF5),
    storage_fill: Color32::from_rgb(0xB1, 0xA1, 0xF5),
    storage_track: Color32::from_rgb(0x3E, 0x2F, 0x7F),
    card: Color32::WHITE,
    card_alt: Color32::from_rgb(0xF5, 0xF4, 0xF2),
    input: Color32::from_rgb(0xF5, 0xF4, 0xF2),
    border_weak: Color32::from_rgb(0xEA, 0xE7, 0xE4),
    border_norm: Color32::from_rgb(0xD1, 0xCF, 0xCD),
    text: Color32::from_rgb(0x0C, 0x0C, 0x14),
    text_weak: Color32::from_rgb(0x5C, 0x59, 0x58),
    purple_soft: Color32::from_rgb(0xEB, 0xE5, 0xFF),
    purple_text: Color32::from_rgb(0x5D, 0x38, 0xEB),
    folder: Color32::from_rgb(0xF5, 0xA4, 0x28),
    danger_text: STATUS_DANGER, // 4.55:1 on white
};

/// Proton Carbon, the app's dark theme as it was. The colours it didn't have are taken from it.
pub(crate) const DARK: Palette = Palette {
    canvas: Color32::from_rgb(26, 24, 35),           // #1A1823
    sidebar: Color32::from_rgb(20, 18, 27),          // #14121B
    sidebar_selected: Color32::from_rgb(44, 37, 69), // #2C2545, as an open section's row was (the soft purple)
    sidebar_hover: Color32::from_rgb(33, 29, 44),    // #211D2C, the cards'
    sidebar_text: Color32::from_rgb(247, 246, 252),  // #F7F6FC, the text's
    sidebar_weak: Color32::from_rgb(162, 158, 178),  // #A29EB2, the weak text's
    storage_fill: PROTON_PURPLE,                     // as Home's storage bar was
    storage_track: Color32::from_rgb(48, 43, 64),    // #302B40, the weak border's, as Home's storage bar was
    card: Color32::from_rgb(33, 29, 44),             // #211D2C
    card_alt: Color32::from_rgb(42, 37, 56),         // #2A2538
    input: Color32::from_rgb(35, 31, 48),            // #231F30
    border_weak: Color32::from_rgb(48, 43, 64),      // #302B40
    border_norm: Color32::from_rgb(74, 67, 96),      // #4A4360, as an off switch's track is
    text: Color32::from_rgb(247, 246, 252),          // #F7F6FC
    text_weak: Color32::from_rgb(162, 158, 178),     // #A29EB2
    purple_soft: Color32::from_rgb(44, 37, 69),      // #2C2545
    purple_text: Color32::from_rgb(214, 204, 255),   // #D6CCFF
    folder: Color32::from_rgb(0xF5, 0xA4, 0x28),
    danger_text: Color32::from_rgb(0xF5, 0x56, 0x6F), // #F5566F: STATUS_DANGER, lightened to read at 4.5:1 here
};

/// The palette of the theme in use.
fn palette() -> &'static Palette {
    if is_light_mode() {
        &LIGHT
    } else {
        &DARK
    }
}

/// The colour tokens, each a colour of the palette in use.
macro_rules! tokens {
    ($($(#[$attr:meta])* $name:ident => $field:ident,)*) => {
        $(
            $(#[$attr])*
            #[inline]
            #[allow(non_snake_case)]
            fn $name() -> Color32 {
                palette().$field
            }
        )*
    };
}

tokens! {
    BG_CANVAS => canvas,
    BG_SIDEBAR => sidebar,
    BG_CARD => card,
    BG_CARD_ALT => card_alt,
    BG_INPUT => input,
    BORDER_SUBTLE => border_weak,
    BORDER_NORM => border_norm,
    TEXT_PRIMARY => text,
    TEXT_MUTED => text_weak,
    PROTON_PURPLE_SOFT => purple_soft,
    PROTON_PURPLE_TEXT => purple_text,
    SIDEBAR_SELECTED => sidebar_selected,
    SIDEBAR_HOVER => sidebar_hover,
    SIDEBAR_TEXT => sidebar_text,
    SIDEBAR_WEAK => sidebar_weak,
    STORAGE_FILL => storage_fill,
    STORAGE_TRACK => storage_track,
    FOLDER_ICON => folder,
    DANGER_TEXT => danger_text,
}

/// The WCAG contrast ratio of two opaque colours, from 1 (the same) to 21 (black on white).
#[cfg(test)]
fn contrast(a: Color32, b: Color32) -> f32 {
    fn luminance(c: Color32) -> f32 {
        let lin = |v: u8| {
            let v = v as f32 / 255.0;
            if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * lin(c.r()) + 0.7152 * lin(c.g()) + 0.0722 * lin(c.b())
    }
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

const PROTON_PURPLE: Color32 = Color32::from_rgb(109, 74, 255); // #6D4AFF
const PROTON_PURPLE_HOVER: Color32 = Color32::from_rgb(0x62, 0x43, 0xE6); // #6243E6, Proton's
const STATUS_SUCCESS: Color32 = Color32::from_rgb(25, 150, 118); // #199676
const STATUS_WARNING: Color32 = Color32::from_rgb(230, 138, 0); // #E68A00
const STATUS_DANGER: Color32 = Color32::from_rgb(220, 50, 81); // #DC3251
// Darker on hover, so the white label keeps a contrast of at least 4.5:1 (5.5:1; STATUS_DANGER has 4.5:1)
const STATUS_DANGER_HOVER: Color32 = Color32::from_rgb(196, 43, 71); // #C42B47

#[inline]
fn btn_secondary_hover_bg() -> Color32 {
    if is_light_mode() {
        Color32::from_rgb(228, 224, 242)
    } else {
        Color32::from_rgb(54, 47, 72)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NavTab {
    Home,
    Shared,
    Activity,
    Settings,
}

/// The section `--tab` names. The old names still work: overview is Activity now, and My files and Conflicts, which
/// are gone, open Home, where what they showed lives. Anything else opens Home too.
fn parse_tab(name: &str) -> NavTab {
    match name {
        "activity" | "overview" => NavTab::Activity,
        "settings" => NavTab::Settings,
        "shared" => NavTab::Shared,
        _ => NavTab::Home,
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryStats {
    total_files: u64,
    total_folders: u64,
    total_bytes: u64,
    unresolved_conflicts: u64,
    error_items: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SyncSettings {
    sync_dir: String,
    conflict_strategy: String,
    notifications_enabled: bool,
    reconcile_interval_sec: u64,
    paused: bool,
    /// When a timed pause ends (epoch ms); None when it lasts until resumed, or from an older daemon (#205)
    paused_until: Option<i64>,
    ignore_patterns: Vec<String>,
    /// Apps (by process name) the virtual drive won't download online-only files for; absent from an older daemon
    blocked_apps: Vec<String>,
    /// Proton Drive starts at login (#92); on unless the daemon says otherwise (an older daemon doesn't say)
    #[serde(default = "on")]
    start_at_login: bool,
}

fn on() -> bool {
    true
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
    /// Why the state is "error" (the last pass failed, or the files are missing from the folder)
    #[serde(default)]
    last_error: Option<String>,
    /// While the daemon holds because the files are missing from the folder: what is missing
    #[serde(default)]
    files_missing: Option<FilesMissing>,
    /// While the daemon holds because the records are of another account than the one signed in to (#35)
    #[serde(default)]
    account_mismatch: Option<AccountMismatch>,
    logged_in: bool,
    sync_dir: String,
    active_transfers: Vec<ActiveTransfer>,
    #[serde(default)]
    syncing_folders: Vec<String>,
    stats: SummaryStats,
    settings: SyncSettings,
    #[serde(default)]
    account: Option<AccountInfo>,
    /// The virtual drive; daemons before Stage 2 send none
    #[serde(default)]
    vfs: Option<VfsStatus>,
    /// The Settings switch as stored (the drive may still be a plain folder, e.g. without FUSE)
    #[serde(default)]
    virtual_drive_wanted: Option<bool>,
    /// When the last sync pass finished, epoch milliseconds; absent before the first one
    #[serde(default)]
    last_sync_at: Option<i64>,
}

/// What is missing while the daemon holds because the files are missing from the folder (`filesMissing` in
/// /api/status): the sync folder (which a confirmation names), the recorded items still missing (top-level items, or
/// after the files came back, whatever is still missing at any depth), how many items that is, and what the daemon says
/// about it, in the user's terms (empty from a daemon before #46's fixes).
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct FilesMissing {
    root: String,
    names: Vec<String>,
    items: u64,
    message: String,
}

/// Signed in to another Proton account than the files on this computer were synced with (`accountMismatch` in
/// /api/status): nothing syncs until the user signs back in to that account, or starts fresh with this one (#35).
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct AccountMismatch {
    message: String,
}

/// "Docs and Photos are", "A, B, C and 2 more are": the missing items as the hold banner names them.
fn missing_names(fm: &FilesMissing) -> String {
    match fm.names.len() {
        0 => "Your files are".to_string(),
        1 => format!("{} is", fm.names[0]),
        _ => format!("{} are", listed_names(&fm.names)),
    }
}

/// "Docs", "Docs and Photos", "A, B, C and 2 more".
fn listed_names(names: &[String]) -> String {
    const SHOWN: usize = 3;
    let n = names.len();
    match n {
        0 => String::new(),
        1 => names[0].clone(),
        _ if n <= SHOWN => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
        _ => format!("{} and {} more", names[..SHOWN].join(", "), n - SHOWN),
    }
}

/// A folder as the user knows it: "~/ProtonDrive" for one in the home folder.
fn home_short(path: &str, home: Option<&str>) -> String {
    match home.map(|h| h.trim_end_matches('/')).filter(|h| !h.is_empty()) {
        Some(home) if path == home => "~".to_string(),
        Some(home) => path.strip_prefix(home).filter(|rest| rest.starts_with('/')).map_or_else(|| path.to_string(), |rest| format!("~{rest}")),
        None => path.to_string(),
    }
}

/// `home_short` with this user's home folder.
fn shown_folder(path: &str) -> String {
    home_short(path, std::env::var("HOME").ok().as_deref())
}

/// The virtual drive as `/api/status` describes it (`VfsStatus` in src/daemon/vfsSupervisor.ts).
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct VfsStatus {
    /// virtual or plain
    mode: String,
    mounted: bool,
    /// ejected, crashed, fuse-unavailable, switched-off, starting, mount-point-busy, different-disk, moving,
    /// move-failed, or none
    reason: Option<String>,
    /// Why the move stopped, with move-failed
    error: Option<String>,
    /// A move that stopped, and what can be done about it now (POST /drive/move on the control socket)
    #[serde(rename = "move")]
    drive_move: Option<DriveMove>,
}

/// A move that stopped: a relocation of the sync folder, or files moving between the sync folder and the drive's store.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct DriveMove {
    /// relocation or layout
    kind: String,
    from: String,
    to: String,
    error: Option<String>,
    /// finish, move-back or retry
    actions: Vec<String>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.trim().is_empty())
}

/// The drive's state in one line, for Settings. A state this app doesn't know reads as its mode.
fn drive_status_line(v: &VfsStatus, sync_dir: &str) -> String {
    if v.mounted {
        return format!("Virtual drive: mounted at {sync_dir}");
    }
    match v.reason.as_deref() {
        Some("ejected") => "Virtual drive: ejected".into(),
        Some("crashed") => "Virtual drive: stopped after repeated crashes".into(),
        Some("fuse-unavailable") => "Plain folder: FUSE isn't available on this system".into(),
        Some("switched-off") => "Plain folder: virtual drive switched off".into(),
        Some("starting") => "Virtual drive: starting…".into(),
        Some("mount-point-busy") => "Virtual drive: couldn't mount, the folder is busy".into(),
        Some("different-disk") => "Plain folder: the Proton Drive folder is on another disk than the app's data".into(),
        Some("moving") => "Moving files…".into(),
        Some("move-failed") => {
            let error = non_empty(&v.error)
                .or_else(|| v.drive_move.as_ref().and_then(|m| non_empty(&m.error)))
                .unwrap_or("unknown error");
            format!("Moving files stopped: {error}")
        }
        _ if v.mode == "virtual" => "Virtual drive: not mounted".into(),
        _ => format!("Plain folder at {sync_dir}"),
    }
}

/// Why the virtual drive switch can't be used right now: the drive is moving files or starting.
fn switch_wait_reason(v: &VfsStatus) -> Option<String> {
    matches!(v.reason.as_deref(), Some("moving" | "starting")).then(|| match v.reason.as_deref() {
        Some("starting") => "Starting the virtual drive…".to_string(),
        _ => drive_status_line(v, ""),
    })
}

/// Mount again is offered for a virtual drive left unmounted by an eject, a crash streak or a busy mount point.
fn offers_mount_again(v: &VfsStatus) -> bool {
    v.mode == "virtual" && !v.mounted && matches!(v.reason.as_deref(), Some("ejected" | "crashed" | "mount-point-busy"))
}

/// Where the files are while the drive can't show them, and how to see them again.
fn files_safe_hint(v: &VfsStatus) -> Option<&'static str> {
    match v.reason.as_deref() {
        Some("crashed" | "mount-point-busy") => {
            Some("Your files are safe. To see them, click Mount again, or switch the virtual drive off.")
        }
        Some("move-failed") if v.drive_move.as_ref().is_some_and(|m| !m.actions.is_empty()) => {
            Some("Your files are safe. To see them, carry on with the move or move the files back below.")
        }
        Some("move-failed") => Some("Your files are safe. To see them, switch the virtual drive off."),
        _ => None,
    }
}

/// The button for one action on a move that stopped.
fn move_action_label(action: &str) -> Option<&'static str> {
    match action {
        "finish" => Some("Finish moving files"),
        "move-back" => Some("Move files back"),
        "retry" => Some("Try again"),
        _ => None,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRecord {
    /// The daemon's id for the entry: what an opened row is known by (none from a cache written before it was kept)
    #[serde(default)]
    id: Option<u64>,
    #[allow(dead_code)]
    timestamp: u64,
    action: String,
    local_rel_path: String,
    details: String,
}

/// Activity's search: the path or the details hold the query, whatever the case; an empty query matches everything.
fn activity_matches(act: &ActivityRecord, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty() || act.local_rel_path.to_lowercase().contains(&query) || act.details.to_lowercase().contains(&query)
}

/// What the daemon's control socket answers to an availability action.
#[derive(Clone, Debug, Deserialize)]
struct AvailabilityResult {
    #[allow(dead_code)]
    state: String,
    #[serde(default)]
    kept: Vec<String>,
    #[serde(default)]
    refused: Option<String>,
}

/// The kept things themselves: not the folders holding them, and not the engine's own downloads in progress
/// (the daemon's own notification applies the same filter).
fn kept_leaves(kept: &[String]) -> Vec<String> {
    // Containment is judged against the full list, temp files included, as the daemon does
    kept.iter()
        .filter(|p| !kept.iter().any(|q| q.strip_prefix(p.as_str()).is_some_and(|rest| rest.starts_with('/'))))
        .filter(|p| !p.rsplit('/').next().unwrap_or("").starts_with(".proton-drive-tmp-"))
        .cloned()
        .collect()
}

/// The line shown above the table after an action: the refusal, else the items that had to stay.
fn availability_notice(r: &AvailabilityResult) -> Option<String> {
    if let Some(refused) = r.refused.as_ref().filter(|m| !m.is_empty()) {
        return Some(refused.clone());
    }
    let kept = kept_leaves(&r.kept);
    if kept.is_empty() {
        return None;
    }
    const SHOWN: usize = 3;
    let n = kept.len();
    let (subject, verb) = if n == 1 { ("item", "stays") } else { ("items", "stay") };
    let pronoun = if n == 1 { "it isn't" } else { "they aren't" };
    let mut names = kept.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if n > SHOWN {
        names.push_str(&format!(" and {} more", n - SHOWN));
    }
    Some(format!(
        "{n} {subject} {verb} on this computer because {pronoun} safely in Proton Drive: {names}"
    ))
}

/// Same rule as the daemon's `defaultControlSocketPath`: `$XDG_RUNTIME_DIR/protondrive/control.sock`, else
/// `<tmp>/protondrive-<uid>/control.sock`.
fn control_socket_path_from(xdg_runtime_dir: Option<std::ffi::OsString>, tmp: std::path::PathBuf, uid: u32) -> std::path::PathBuf {
    match xdg_runtime_dir.filter(|d| !d.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir).join("protondrive").join("control.sock"),
        None => tmp.join(format!("protondrive-{uid}")).join("control.sock"),
    }
}

/// The temp dir as the daemon's Node os.tmpdir() finds it: $TMPDIR, else $TMP, else $TEMP, else /tmp, without a
/// trailing slash.
fn node_tmpdir(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let tmp = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|name| var(name).filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".into());
    let bytes = tmp.as_bytes();
    if bytes.len() > 1 && bytes.ends_with(b"/") {
        return std::path::PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..bytes.len() - 1]));
    }
    std::path::PathBuf::from(tmp)
}

fn own_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(0)
}

fn control_socket_path() -> std::path::PathBuf {
    control_socket_path_from(std::env::var_os("XDG_RUNTIME_DIR"), node_tmpdir(|name| std::env::var_os(name)), own_uid())
}

/// Why the folder holding the control socket can't be trusted, or None. The daemon makes it a 0700 folder of the
/// user's; one that is missing just means no daemon runs (connecting then fails).
fn socket_dir_problem(socket: &std::path::Path, uid: u32) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let dir = socket.parent().unwrap_or(std::path::Path::new("/"));
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => return Some(format!("Can't check the Proton Drive control socket's folder {} ({e})", dir.display())),
    };
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Some(format!(
            "The Proton Drive control socket's folder {} isn't private to you (owner {}, mode {:o}); not connecting to it",
            dir.display(),
            meta.uid(),
            meta.mode() & 0o7777
        ));
    }
    None
}

/// One HTTP/1.1 request to the daemon's user-only control socket. Pin, free, hide and unhide go
/// only through here, never through the TCP API.
fn control_request(
    method: &str,
    path_and_query: &str,
    body: Option<&serde_json::Value>,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    control_request_at(&control_socket_path(), method, path_and_query, body, read_timeout)
}

/// Pin and free reply only once the work is done, which can take a long time on a big folder.
const AVAILABILITY_READ_TIMEOUT: Duration = Duration::from_secs(600);
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// What a read timeout means: the daemon accepted the request and is still busy with it.
const STILL_WORKING: &str = "Still working on it in the background. Refresh to see the result.";

fn control_request_at(
    socket: &std::path::Path,
    method: &str,
    path_and_query: &str,
    body: Option<&serde_json::Value>,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    const UNREACHABLE: &str = "Can't reach the Proton Drive background service";
    // Every request on the socket goes through here: a screenshot never calls it, so it can't change anything
    if SCREENSHOT_MODE.load(AtomicOrdering::SeqCst) {
        return Err("Screenshots never call the Proton Drive background service".to_string());
    }
    if let Some(problem) = socket_dir_problem(socket, own_uid()) {
        return Err(problem);
    }
    let mut stream =
        std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("{UNREACHABLE} ({e})"))?;
    let _ = stream.set_read_timeout(Some(read_timeout));
    let _ = stream.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT));

    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut request = format!("{method} {path_and_query} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n");
    if body.is_some() {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");
    request.push_str(&payload);
    stream.write_all(request.as_bytes()).map_err(|e| format!("{UNREACHABLE} ({e})"))?;

    // Connection: close ends the reply at EOF; Content-Length, when present, trims anything after the body
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| match e.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => STILL_WORKING.to_string(),
        _ => format!("{UNREACHABLE} ({e})"),
    })?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Malformed reply from the Proton Drive background service")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut body_bytes = &raw[split + 4..];
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or("Malformed reply from the Proton Drive background service")?;
    let content_length = lines.find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok())?
    });
    if let Some(len) = content_length.filter(|len| *len <= body_bytes.len()) {
        body_bytes = &body_bytes[..len];
    }
    let json: Option<serde_json::Value> = serde_json::from_slice(body_bytes).ok();
    if (200..300).contains(&status) {
        return json.ok_or_else(|| "Unreadable reply from the Proton Drive background service".to_string());
    }
    Err(json
        .as_ref()
        .and_then(|j| j.get("error"))
        .and_then(|e| e.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("The Proton Drive background service answered {status}")))
}

fn set_availability(path: &str, action: &str) -> Result<AvailabilityResult, String> {
    let body = serde_json::json!({ "path": path, "action": action });
    let reply = control_request("POST", "/availability", Some(&body), AVAILABILITY_READ_TIMEOUT)?;
    serde_json::from_value(reply).map_err(|e| e.to_string())
}

/// One item hidden from this computer, as GET /availability/hidden lists it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
struct HiddenItem {
    /// Relative to the sync folder
    path: String,
    /// hidden, or hiding while the hide waits on uploads
    state: String,
}

/// Reading the list of hidden items is quick: the daemon answers it from its database.
const HIDDEN_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// What Settings says when the daemon is older than the list (it answers 404): restarting it brings the list.
const HIDDEN_NEEDS_RESTART: &str = "Restart Proton Drive to see this list";

/// What is hidden from this computer (GET /availability/hidden on the control socket; it only reads).
fn hidden_items_at(socket: &std::path::Path) -> Result<Vec<HiddenItem>, String> {
    #[derive(Deserialize)]
    struct Reply {
        items: Vec<HiddenItem>,
    }
    // A 404 is the daemon's catch-all for a route it doesn't have, with or without its {"error":"Not found"} body
    let reply = control_request_at(socket, "GET", "/availability/hidden", None, HIDDEN_READ_TIMEOUT).map_err(|e| {
        if e == "Not found" || e.ends_with("answered 404") {
            HIDDEN_NEEDS_RESTART.to_string()
        } else {
            e
        }
    })?;
    serde_json::from_value::<Reply>(reply).map(|r| r.items).map_err(|e| e.to_string())
}

/// Sign-in answers once the browser has the sign-in page, or after 3 s without it.
const LOGIN_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Sign-out stops the sync engine first.
const LOGOUT_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Saving settings, the virtual drive switch, Mount again and an action on a stopped move can move every file.
const DRIVE_READ_TIMEOUT: Duration = Duration::from_secs(600);
/// Resolving a conflict may upload or download the file.
const RESOLVE_READ_TIMEOUT: Duration = Duration::from_secs(600);

/// What POST /auth/login answers: the sign-in page's URL, '' when it wasn't ready in time (the browser opens anyway).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LoginReply {
    sign_in_url: String,
}

/// What POST /drive/settings answers: the settings as stored now, and why a folder move or the switch didn't happen.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SettingsReply {
    settings: Option<SyncSettings>,
    virtual_drive_wanted: Option<bool>,
    vfs: Option<VfsStatus>,
    folder_error: Option<String>,
    switch_error: Option<String>,
}

impl SettingsReply {
    /// The refusals to show, if any: the folder's, then the switch's.
    fn problem(&self) -> Option<String> {
        let problems: Vec<&str> = [&self.folder_error, &self.switch_error].into_iter().filter_map(non_empty).collect();
        (!problems.is_empty()).then(|| problems.join("\n"))
    }
}

/// The ignore list as the editor holds it: one pattern per line, trimmed, blank lines left out.
fn parse_ignore_patterns(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// The body of POST /drive/settings: only the fields edited since the settings were loaded, so that a value the daemon
/// adjusted on load (an ignore list it trimmed) is never written back unless the user changed it.
fn settings_changes(
    loaded: &SyncSettings,
    sync_dir: &str,
    conflict_strategy: &str,
    notifications_enabled: bool,
    start_at_login: bool,
    ignore_patterns_text: &str,
) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let mut changes = serde_json::Map::new();
    if sync_dir.trim() != loaded.sync_dir.trim() {
        changes.insert("syncDir".into(), Value::from(sync_dir.trim()));
    }
    if conflict_strategy != loaded.conflict_strategy {
        changes.insert("conflictStrategy".into(), Value::from(conflict_strategy));
    }
    if notifications_enabled != loaded.notifications_enabled {
        changes.insert("notificationsEnabled".into(), Value::from(notifications_enabled));
    }
    if start_at_login != loaded.start_at_login {
        changes.insert("startAtLogin".into(), Value::from(start_at_login));
    }
    let patterns = parse_ignore_patterns(ignore_patterns_text);
    if patterns != parse_ignore_patterns(&loaded.ignore_patterns.join("\n")) {
        changes.insert("ignorePatterns".into(), Value::from(patterns));
    }
    changes
}

// The control socket's write routes (src/daemon/controlServer.ts). TCP refuses all of them with 403; a status other
// than 2xx comes back as the daemon's `error`, and a read timeout as STILL_WORKING (see control_request_at).

/// POST /auth/login: starts the sign-in in the browser.
fn sign_in_at(socket: &std::path::Path) -> Result<LoginReply, String> {
    let reply = control_request_at(socket, "POST", "/auth/login", Some(&serde_json::json!({})), LOGIN_READ_TIMEOUT)?;
    serde_json::from_value(reply).map_err(|e| e.to_string())
}

/// POST /auth/logout: signs out and clears the caches.
fn sign_out_at(socket: &std::path::Path) -> Result<(), String> {
    control_request_at(socket, "POST", "/auth/logout", Some(&serde_json::json!({})), LOGOUT_READ_TIMEOUT).map(|_| ())
}

/// POST /drive/settings with only the changed fields (or just virtualDriveWanted, for the switch).
fn save_settings_at(socket: &std::path::Path, changes: &serde_json::Value) -> Result<SettingsReply, String> {
    let reply = control_request_at(socket, "POST", "/drive/settings", Some(changes), DRIVE_READ_TIMEOUT)?;
    serde_json::from_value(reply).map_err(|e| e.to_string())
}

/// POST /vfs/mount: mounts the drive again after an eject, a crash streak or a busy mount point.
fn mount_again_at(socket: &std::path::Path) -> Result<(), String> {
    control_request_at(socket, "POST", "/vfs/mount", Some(&serde_json::json!({})), DRIVE_READ_TIMEOUT).map(|_| ())
}

/// POST /drive/move {action, from, to}: finish, move back or retry the move that stopped, named by where it goes.
fn drive_move_at(socket: &std::path::Path, action: &str, from: &str, to: &str) -> Result<(), String> {
    let body = serde_json::json!({ "action": action, "from": from, "to": to });
    control_request_at(socket, "POST", "/drive/move", Some(&body), DRIVE_READ_TIMEOUT).map(|_| ())
}

/// POST /conflicts/resolve {id, choice}.
fn resolve_conflict_at(socket: &std::path::Path, id: u64, choice: &str) -> Result<(), String> {
    let body = serde_json::json!({ "id": id, "choice": choice });
    control_request_at(socket, "POST", "/conflicts/resolve", Some(&body), RESOLVE_READ_TIMEOUT).map(|_| ())
}

/// What the user does about the files missing from the folder, besides waiting for them (the action of POST
/// /sync/files-missing).
#[derive(Clone, Copy, Debug, PartialEq)]
enum MissingChoice {
    /// They were deleted on purpose: the daemon's next sync moves them to the Proton Drive trash too.
    DeleteInCloud,
    /// They stay in Proton Drive, online-only: nothing is deleted, and nothing is downloaded again (#50).
    KeepOnlineOnly,
}

impl MissingChoice {
    fn action(self) -> &'static str {
        match self {
            MissingChoice::DeleteInCloud => "delete-in-cloud",
            MissingChoice::KeepOnlineOnly => "keep-online-only",
        }
    }
}

/// POST /sync/files-missing {action, root, names}: what to do about the files missing from the folder, as the user was
/// shown them. The daemon refuses (409) if that is no longer what is missing.
fn files_missing_resolve_at(socket: &std::path::Path, choice: MissingChoice, root: &str, names: &[String]) -> Result<(), String> {
    let body = serde_json::json!({ "action": choice.action(), "root": root, "names": names });
    control_request_at(socket, "POST", "/sync/files-missing", Some(&body), DRIVE_READ_TIMEOUT).map(|_| ())
}

/// POST /account/start-fresh: the files on this computer sync to the account signed in to as new files (#35).
fn start_fresh_at(socket: &std::path::Path) -> Result<(), String> {
    control_request_at(socket, "POST", "/account/start-fresh", Some(&serde_json::json!({})), DRIVE_READ_TIMEOUT).map(|_| ())
}

/// The least the Shared list's Location column keeps before the name gives way.
const SHARED_LOCATION_MIN: f32 = 56.0;

/// How the Shared list's text columns share `room`, as (name, location, sharing). Sharing has what its marks need (up
/// to half the room) and what a longer reason wants (up to two fifths). The name has at least half the rest, so the
/// columns line up, and more as it needs. Location gives way first, down to `SHARED_LOCATION_MIN`; then the name.
fn shared_columns(room: f32, name_want: f32, sharing_need: f32, sharing_want: f32) -> (f32, f32, f32) {
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
    // Sharing needs room for every readable row's marks, and wants room for its words and an unreadable row's reason
    let sharing_need = items
        .iter()
        .zip(&pieces)
        .filter(|(i, _)| i.unreadable.is_none())
        .map(|(_, p)| sharing_width(&painter, &sharing_fit(&painter, p, 0.0)))
        .fold(text_width(&painter, "Sharing", &header_font), f32::max);
    let sharing_want = pieces.iter().map(|p| sharing_width(&painter, &p.iter().collect::<Vec<_>>())).fold(sharing_need, f32::max);
    let (name_w, location_w, sharing_w) = shared_columns(room, name_want, sharing_need, sharing_want);

    ui.spacing_mut().item_spacing.y = 0.0;
    let line = |painter: &egui::Painter, rect: egui::Rect| {
        painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0_f32, BORDER_SUBTLE()));
    };
    let (header, _) = ui.allocate_exact_size(Vec2::new(width, 32.0), Sense::hover());
    let name_x = header.left() + START;
    let location_x = name_x + name_w + SHARED_COLUMN_GAP;
    let sharing_x = location_x + location_w + SHARED_COLUMN_GAP;
    for (title, x) in [("Name", name_x), ("Location", location_x), ("Sharing", sharing_x)] {
        painter.text(egui::pos2(x, header.center().y), egui::Align2::LEFT_CENTER, title, header_font.clone(), TEXT_MUTED());
    }
    line(&painter, header);

    let mut act = None;
    for (i, (item, pieces)) in items.iter().zip(&pieces).enumerate() {
        let (row, _) = ui.allocate_exact_size(Vec2::new(width, SHARED_ROW_HEIGHT), Sense::hover());
        line(&painter, row);
        let y = row.center().y;
        let cell = |x: f32, w: f32| egui::Rect::from_min_max(egui::pos2(x, row.top()), egui::pos2(x + w.max(0.0), row.bottom()));
        let in_cell = |rect: egui::Rect| painter.with_clip_rect(rect.intersect(painter.clip_rect()));
        let enabled = ui.is_enabled();
        // Each cell is named for screen readers, as a label would be, and says the whole of it on hover
        let describe = |rect: egui::Rect, what: &str, says: &str, hover: &str| {
            let resp = ui.interact(rect, ui.id().with(("shared_cell", i, what)), Sense::hover());
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, enabled, says));
            resp.on_hover_text(hover);
        };
        let whole = format!("{}\n{}", item.name, shared::folder_text(item));

        // Name: a folder's or a file's icon, then the name
        let name_cell = cell(name_x, name_w);
        let p = in_cell(name_cell);
        let icon_color = if shared::name_icon(&item.name) == icons::FOLDER { FOLDER_ICON() } else { TEXT_MUTED() };
        p.text(egui::pos2(name_x, y), egui::Align2::LEFT_CENTER, shared::name_icon(&item.name), icons::font(BUTTON_ICON_SIZE), icon_color);
        let name = truncate_middle_to_width(&p, &item.name, &name_font, name_w - ICON_ROOM);
        p.text(egui::pos2(name_x + ICON_ROOM, y), egui::Align2::LEFT_CENTER, name, name_font.clone(), TEXT_PRIMARY());
        describe(name_cell, "name", &item.name, &whole);

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
        describe(location_cell, "location", &location, &whole);

        // Sharing: the marks, or the warning and why; the whole sentence on hover
        let sharing_cell = cell(sharing_x, sharing_w);
        let p = in_cell(sharing_cell);
        let mut x = sharing_x;
        let fit = sharing_fit(&p, pieces, sharing_w);
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
        describe(sharing_cell, "sharing", &exposure, &exposure);

        // The actions, on the right: weak until the row is hovered. A row being stopped waits for the answer
        let buttons = SharedAction::for_item(item, now_ms);
        let n = buttons.len() as f32;
        let actions_w = n * ICON_BUTTON_SIZE + (n - 1.0).max(0.0) * SHARED_ACTION_GAP;
        let right = row.right() - SHARED_ROW_END;
        let actions = egui::Rect::from_min_max(egui::pos2(right - actions_w, row.top()), egui::pos2(right, row.bottom()));
        let color = if ui.rect_contains_pointer(row) { TEXT_PRIMARY() } else { TEXT_MUTED() };
        let busy = stopping.is_some() && stopping == item.rel_path.as_deref();
        let mut actions_ui = ui.new_child(egui::UiBuilder::new().id_salt(("shared_actions", i)).max_rect(actions).layout(Layout::left_to_right(Align::Center)));
        actions_ui.spacing_mut().item_spacing.x = SHARED_ACTION_GAP;
        actions_ui.add_enabled_ui(!busy, |ui| {
            for button in &buttons {
                // One stop at a time: the other rows' Stop sharing wait for the answer
                let can = *button != SharedAction::Stop || stopping.is_none();
                if ui.add_enabled_ui(can, |ui| icon_button_colored(ui, button.icon(), button.label(), color)).inner.clicked() {
                    act = Some((*button, i));
                }
            }
        });
    }
    act
}

/// A button on a row of the Shared page.
#[derive(Clone, Copy, PartialEq)]
enum SharedAction {
    CopyLink,
    Manage,
    ShowInFiles,
    Stop,
    ManageOnWeb,
}

impl SharedAction {
    fn label(self) -> &'static str {
        match self {
            SharedAction::CopyLink => "Copy link",
            SharedAction::Manage => "Manage…",
            SharedAction::ShowInFiles => "Show in Files",
            SharedAction::Stop => "Stop sharing",
            SharedAction::ManageOnWeb => "Manage on the web",
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

/// An action that waits for the user's confirmation.
#[derive(Clone, Debug, PartialEq)]
enum PendingConfirm {
    /// Free up space for everything in a folder (`rel_path` is empty for the whole drive). Home only asks for the whole
    /// drive; a folder's `rel_path` is kept for the tray or a later stage to free one folder.
    FreeAll { rel_path: String },
    /// Switching the virtual drive off moves the downloaded files back into a normal folder.
    VirtualDriveOff,
    /// The files missing from the folder were deleted on purpose: they go to the Proton Drive trash too. What the dialog
    /// was opened for (the status's `filesMissing`) is what it confirms.
    DeleteMissing { root: String, names: Vec<String>, items: u64 },
    /// Start fresh with the account signed in to: the files on this computer sync to it as new files (#35)
    StartFresh,
    /// Stop all sharing of an item of the Shared page: `question` is what it asks, naming what is lost (#253)
    StopSharing { rel_path: String, uid: String, question: String },
}

/// What a confirmation dialog says, and what its button asks the daemon to do to which path.
struct ConfirmCopy {
    title: String,
    body: String,
    detail: &'static str,
    button: &'static str,
    /// The button that does nothing (the default: Escape and a click outside do the same)
    cancel: &'static str,
    rel_path: String,
    action: &'static str,
}

/// `virtual_drive`: whether the drive shows online-only files in Files (a plain folder doesn't).
fn confirm_copy(confirm: &PendingConfirm, virtual_drive: bool) -> ConfirmCopy {
    match confirm {
        PendingConfirm::FreeAll { rel_path } => {
            let (title, body) = if rel_path.is_empty() {
                let stay = if virtual_drive {
                    "Your files stay in Proton Drive, and in Files as online-only: they download again when you open them. Nothing is deleted online."
                } else {
                    "Your files stay in Proton Drive, and nothing is deleted online. While Proton Drive is a plain folder, files that are only online don't show in Files."
                };
                (
                    "Free up space on this computer?".to_string(),
                    format!("This removes the copies on this computer of everything that is safely in Proton Drive. {stay}"),
                )
            } else {
                (
                    format!("Free up space in \"{rel_path}\"?"),
                    format!("This removes the copies on this computer of everything in \"{rel_path}\" that is safely in Proton Drive. Nothing is deleted online. Use Always keep to download them again."),
                )
            };
            ConfirmCopy {
                title,
                body,
                detail: "Anything marked Always keep here stops being kept. Files that aren't fully synced, or that you've told Proton Drive to ignore, stay on this computer.",
                button: "Free up space",
                cancel: "Cancel",
                rel_path: rel_path.clone(),
                action: "free",
            }
        }
        PendingConfirm::VirtualDriveOff => ConfirmCopy {
            title: "Switch off the virtual drive?".to_string(),
            body: "Your downloaded files move back into a normal folder; online-only files stop showing in Files.".to_string(),
            detail: "Nothing is deleted: online-only files stay in Proton Drive, and you can switch the virtual drive on again at any time.",
            button: "Switch off",
            cancel: "Cancel",
            rel_path: String::new(),
            // Not an availability action: render_confirm_modal sends the switch instead
            action: "virtual-drive-off",
        },
        PendingConfirm::DeleteMissing { names, items, .. } => ConfirmCopy {
            title: "Delete them from Proton Drive too?".to_string(),
            // The banner above says where they were missing from; this says what goes
            body: {
                let (what, them) = if *items == 1 { ("missing item".to_string(), "it") } else { (format!("{items} missing items"), "them") };
                format!(
                    "The {what} ({}) will move to the Proton Drive trash. You can restore {them} from the trash on the Proton Drive website.",
                    listed_names(names)
                )
            },
            detail: "Keep waiting if they are on a disk that isn't connected, or you are bringing them back: nothing is deleted while Proton Drive waits.",
            button: "Delete from Proton Drive",
            cancel: "Keep waiting",
            rel_path: String::new(),
            // Not an availability action: render_confirm_modal sends the confirmation instead
            action: "files-missing-delete",
        },
        PendingConfirm::StartFresh => ConfirmCopy {
            title: "Start fresh with this account?".to_string(),
            body: "The files on this computer stay, and sync to the Proton account you are signed in to as new files: they upload to it.".to_string(),
            detail: "Nothing is deleted, on this computer or in either account. To sync with the other account instead, sign out and sign in to it.",
            button: "Start fresh",
            cancel: "Cancel",
            rel_path: String::new(),
            // Not an availability action: render_confirm_modal sends the start-fresh instead
            action: "start-fresh",
        },
        PendingConfirm::StopSharing { question, .. } => ConfirmCopy {
            title: "Stop sharing?".to_string(),
            body: question.clone(),
            detail: "Nothing is deleted: the item stays in Proton Drive.",
            button: "Stop sharing",
            cancel: "Cancel",
            rel_path: String::new(),
            // Not an availability action: render_confirm_modal sends the stop instead
            action: "stop-sharing",
        },
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictRecord {
    id: u64,
    local_rel_path: String,
    #[allow(dead_code)]
    detected_at: u64,
    resolved: u8,
}

enum WorkerCommand {
    RefreshAll,
    /// Home's Sync now
    TriggerSync,
    /// Home's Pause choices and Resume: until, when the pause ends (epoch ms), None until resumed (#205)
    SetPaused { paused: bool, until: Option<i64> },
    StartLogin,
    Logout,
    /// Only the settings that changed (see `settings_changes`)
    SaveSettings(serde_json::Value),
    /// The Settings switch `Show online-only files in Files (virtual drive)`
    SetVirtualDrive(bool),
    /// POST /drive/settings with the whole new list of blocked apps (Block or Unblock in Settings)
    SetBlockedApps(Vec<String>),
    MountAgain,
    /// An action on a move that stopped, naming the move by where it goes
    DriveMove { action: String, from: String, to: String },
    LoadConflicts,
    ResolveConflict { id: u64, choice: String },
    SetAvailability { path: String, action: String },
    /// What is hidden from this computer, for Settings (a read, over the control socket)
    LoadHidden,
    /// What to do about the files missing from the folder, as shown (POST /sync/files-missing)
    ResolveFilesMissing { choice: MissingChoice, root: String, names: Vec<String> },
    /// Start fresh with the account signed in to (POST /account/start-fresh, #35)
    StartFresh,
    /// What is shared, for the Shared section (a read, over the control socket)
    SharedLoad { seq: u64 },
    /// Stop all sharing of the item at `rel_path` (DELETE /share/all)
    SharedStop { rel_path: String, uid: String },
    /// The Share window (#216), each over the control socket for the item at `rel_path` (inside My files), and
    /// answered to the `window` that asked: how it is shared (a read)
    ShareLoad { window: share::WindowId, rel_path: String },
    /// Turn the link on (POST /share/link: makes one only if there is none)
    ShareEnsureLink { window: share::WindowId, rel_path: String },
    /// Set or clear the link's password and expiry: None leaves one as it is, Some(None) clears it
    ShareSettings {
        window: share::WindowId,
        rel_path: String,
        password: Option<Option<String>>,
        expires_at: Option<Option<i64>>,
    },
    ShareRemoveLink { window: share::WindowId, rel_path: String },
    ShareInvite { window: share::WindowId, rel_path: String, emails: Vec<String>, role: share::Role },
    ShareRole { window: share::WindowId, rel_path: String, email: String, role: share::Role },
    ShareRemovePerson { window: share::WindowId, rel_path: String, email: String },
    /// The link's password, only when Show is clicked (a read)
    SharePassword { window: share::WindowId, rel_path: String },
}

/// Set once in `main` when the app only renders a screenshot: nothing that changes anything is ever sent then, and
/// the control socket is never called.
static SCREENSHOT_MODE: AtomicBool = AtomicBool::new(false);
/// A later start asked this GUI to bring its window to the front (#129); the next frame does it
static SHOW_REQUESTED: AtomicBool = AtomicBool::new(false);
/// The section a later start asked for, opened with the window (#203)
static SECTION_REQUESTED: std::sync::Mutex<Option<NavTab>> = std::sync::Mutex::new(None);
/// What a later start asked to share (or why it can't be), opened with the window (#216)
static SHARE_REQUESTED: std::sync::Mutex<Option<single_instance::Request>> = std::sync::Mutex::new(None);
/// The running app's context, so the single-instance listener can wake it
static APP_CONTEXT: std::sync::OnceLock<egui::Context> = std::sync::OnceLock::new();

/// The POST /api/pause body: until (epoch ms) only when the pause has an end (#205).
fn pause_request(paused: bool, until: Option<i64>) -> serde_json::Value {
    match until {
        Some(until) => serde_json::json!({ "paused": paused, "until": until }),
        None => serde_json::json!({ "paused": paused }),
    }
}

/// What screenshot mode may ask the worker for: reads only.
fn allowed_in_screenshot_mode(cmd: &WorkerCommand) -> bool {
    matches!(cmd, WorkerCommand::RefreshAll | WorkerCommand::LoadConflicts)
}

/// Screenshot-only: `--fake-attention N`: N conflicts named report.pdf, notes.txt and a 120-character name in turn, and
/// two failed items.
fn fake_attention_items(n: usize) -> Vec<home::Attention> {
    let long = format!("{}.docx", "a-very-long-file-name-".repeat(6).chars().take(115).collect::<String>());
    let names = ["report.pdf".to_string(), "notes.txt".to_string(), long];
    let mut items: Vec<home::Attention> = (0..n)
        .map(|i| home::Attention::Conflict { id: i as u64 + 1, rel_path: format!("Documents/{}", names[i % 3]) })
        .collect();
    items.push(home::Attention::FailedItems(2));
    items
}

/// Screenshot-only: `--fake-transfers N`: N uploads, each 40% of 10 MB done.
fn fake_transfers(n: usize) -> Vec<ActiveTransfer> {
    (0..n)
        .map(|i| ActiveTransfer {
            id: format!("fake-{i}"),
            direction: "upload".into(),
            rel_path: format!("Photos/Holiday/IMG_{:04}.jpg", i + 1),
            bytes_transferred: 4_000_000,
            total_bytes: 10_000_000,
        })
        .collect()
}

/// Screenshot-only: the drive status `--drive-status` names (with `--drive-move`, a move that stopped), as the vfs to show
/// and the switch's state; None for an unknown name.
fn fake_drive_status(name: &str, move_kind: Option<&str>, sync_dir: &str, home: &str) -> Option<(VfsStatus, bool)> {
    let (mode, mounted, reason, wanted) = match name {
        "mounted" => ("virtual", true, None, true),
        "ejected" => ("virtual", false, Some("ejected"), true),
        "plain" | "switched-off" => ("plain", false, Some("switched-off"), false),
        "fuse-unavailable" => ("plain", false, Some("fuse-unavailable"), true),
        "crashed" => ("virtual", false, Some("crashed"), true),
        "busy" | "mount-point-busy" => ("virtual", false, Some("mount-point-busy"), true),
        "starting" => ("virtual", false, Some("starting"), true),
        "moving" => ("plain", false, Some("moving"), true),
        "move-failed" => ("plain", false, Some("move-failed"), true),
        "different-disk" => ("plain", false, Some("different-disk"), true),
        _ => return None,
    };
    let error = (reason == Some("move-failed")).then(|| "No space left on device".to_string());
    let drive_move = match move_kind {
        None => None,
        Some("relocation") => Some(DriveMove {
            kind: "relocation".into(),
            from: sync_dir.into(),
            to: "/media/backup/ProtonDrive".into(),
            error: Some("Permission denied".into()),
            actions: vec!["move-back".into(), "retry".into()],
        }),
        Some("layout") => Some(DriveMove {
            kind: "layout".into(),
            from: sync_dir.into(),
            to: format!("{home}/.local/share/proton-drive-ubuntu/files"),
            error: Some("No space left on device".into()),
            actions: vec!["finish".into(), "move-back".into()],
        }),
        Some(_) => return None,
    };
    let vfs = VfsStatus { mode: mode.into(), mounted, reason: reason.map(String::from), error, drive_move };
    Some((vfs, wanted))
}

enum WorkerEvent {
    StatusAndActivity {
        status: Box<Result<DaemonStatus, String>>,
        activity: Vec<ActivityRecord>,
    },
    /// The sign-in started (its page's URL, maybe ''), or why it didn't
    LoginStarted(Result<LoginReply, String>),
    LoggedOut(Result<(), String>),
    ConflictsLoaded(Vec<ConflictRecord>),
    ConflictResolved(Result<(), String>),
    AvailabilityDone { path: String, result: Result<AvailabilityResult, String> },
    /// What is hidden from this computer, or why it couldn't be read
    HiddenLoaded(Result<Vec<HiddenItem>, String>),
    SettingsSaved(Result<SettingsReply, String>),
    VirtualDriveSwitched(Result<SettingsReply, String>),
    BlockedAppsSaved(Result<SettingsReply, String>),
    /// Mount again or an action on a stopped move finished, or why not
    DriveDone(Result<(), String>),
    /// What was asked about the missing files (deleted on purpose, or kept online-only) went through, or why not
    FilesMissingDone(Result<(), String>),
    StartFreshDone(Result<(), String>),
    /// What the Shared section lists, or why that couldn't be read (#253)
    SharedLoaded(u64, Result<Vec<shared::SharedItem>, String>),
    /// Stopping all sharing of the item at that rel_path went through, or why not
    SharedStopped(String, Result<(), String>),
    /// How the item of the Share window that asked is shared, or why that couldn't be read (#216)
    ShareLoaded(share::WindowId, Result<share::ShareInfo, String>),
    /// A change made in that Share window went through, or why not
    ShareDone(share::WindowId, Result<(), String>),
    /// The link's password (None when Proton Drive can't show it here), or why it couldn't be read
    SharePassword(share::WindowId, Result<Option<String>, String>),
}

/// A line telling how something went: done, or why not.
#[derive(Clone, Debug, PartialEq)]
struct Notice {
    text: String,
    error: bool,
}

impl Notice {
    fn info(text: impl Into<String>) -> Self {
        Self { text: text.into(), error: false }
    }

    fn error(text: impl Into<String>) -> Self {
        Self { text: text.into(), error: true }
    }
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
            // With no saved size the app opens as a small window: it is a status and control centre, not a browser
            width: 900.0,
            height: 640.0,
            maximized: false,
            theme_mode: "system".to_string(),
        }
    }
}

fn ui_prefs_path() -> Option<std::path::PathBuf> {
    // Tests drive the app headlessly and must never touch the user's own files
    if cfg!(test) {
        return None;
    }
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
    activities: Vec<ActivityRecord>,
}

fn startup_cache_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
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

fn save_startup_cache(status: &DaemonStatus, activities: &[ActivityRecord]) {
    // A screenshot may show a faked drive, which must never be what the app shows at its next start
    if !status.logged_in || SCREENSHOT_MODE.load(AtomicOrdering::SeqCst) {
        return;
    }
    let Some(p) = startup_cache_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let cache = StartupCache {
        status: Some(status.clone()),
        activities: activities.to_vec(),
    };
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let tmp = p.with_file_name(format!(".startup-cache.json.{}.tmp", std::process::id()));
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
    initial_connecting: bool,
    status: DaemonStatus,
    activities: Vec<ActivityRecord>,
    /// The sign-in page's URL once a sign-in started ('' while the browser is still opening it)
    login_url: Option<String>,
    /// Why signing in or out failed
    account_error: Option<String>,
    /// Activity's search: rows whose path or details hold it, whatever the case
    search_query: String,
    /// Activity's filter: all, uploads, downloads, or problems (#94)
    activity_filter: activity::ActivityFilter,
    /// The Activity row opened to show its full details and actions (see activity_key), with where Show in Files and
    /// Open go, looked up once when it was opened: never on every frame, as the drive may be slow to answer
    expanded_activity: Option<ExpandedActivity>,

    /// What is hidden from this computer, as last read (None until the first answer), and whether a read is out
    hidden: Option<Result<Vec<HiddenItem>, String>>,
    hidden_loading: bool,
    /// The item an Unhide was sent for, and how the last Unhide went when it didn't simply work (shown in Settings'
    /// card only: items it had to keep as information, a refusal or a failure as an error)
    unhiding: Option<String>,
    unhide_notice: Option<Notice>,

    /// Paths (relative to the sync folder; empty is the whole drive) with an availability action still running.
    working: Vec<String>,
    pending_confirm: Option<PendingConfirm>,
    /// Dismissible line on Home: a refusal, the items that had to stay, or an error.
    notice: Option<String>,

    // Ignore patterns editor (Settings)
    ignore_patterns_text: String,
    settings_dirty: bool,
    /// The settings as last loaded into the form: Save Preferences sends only what differs from them
    loaded_settings: SyncSettings,
    settings_saving: bool,
    /// Under Save Preferences: saved, nothing to save, or why not
    settings_notice: Option<Notice>,
    /// The virtual drive switch, Mount again or an action on a stopped move is still running
    drive_working: bool,
    /// Why the last of those was refused or failed
    drive_error: Option<String>,
    /// The name typed under Apps blocked from downloading, whether a Block or Unblock is still running, and why the
    /// last one was refused
    block_app_input: String,
    blocklist_working: bool,
    blocklist_error: Option<String>,
    /// The confirmation that the missing files were deleted on purpose is still running, and why the last one failed
    files_missing_working: bool,
    files_missing_error: Option<String>,
    start_fresh_working: bool,
    start_fresh_error: Option<String>,

    // Conflicts state
    conflicts: Vec<ConflictRecord>,
    /// What needs the user, from the status and the conflicts; recomputed whenever either changes
    attention: Vec<home::Attention>,
    /// Why the last conflict resolution was refused or failed
    conflict_error: Option<String>,

    // Settings edits
    edit_sync_dir: String,
    edit_conflict_strategy: String,
    edit_notifications: bool,
    edit_start_at_login: bool,

    /// Screenshot-only: `--drive-status` and `--drive-move`, laid over every status from the daemon
    fake_drive: Option<(String, Option<String>)>,
    /// Screenshot-only: `--files-missing`, the daemon holding with the files missing, laid over every status
    fake_files_missing: bool,
    /// Screenshot-only: `--fake-attention`, how many conflicts Home lists (plus two failed items)
    fake_attention: Option<usize>,
    /// Screenshot-only: `--fake-transfers`, how many uploads Home shows in progress
    fake_transfers: Option<usize>,
    /// Screenshot-only: `--signed-out`, the daemon without an account, laid over every status
    fake_signed_out: bool,
    /// Screenshot-only: `--account-mismatch`, the daemon holding another account's records, laid over every status
    fake_account_mismatch: bool,
    /// Screenshot-only: `--paused-until-min N`, paused until N minutes from the start (0: until resumed)
    fake_paused_until: Option<i64>,
    /// Home's Pause choices are open (#205)
    pause_choices_open: bool,
    /// The top bar's account menu is open (#274)
    account_menu_open: bool,

    // Window geometry state
    window_geometry: WindowGeometry,
    maximize_applied_on_open: bool,
    applied_light_mode: bool,

    // Automatic screenshot support for visual verification
    screenshot_target: Option<String>,
    frames_rendered: u32,
    screenshot_requested: bool,
    last_poll: Instant,
    /// The Share window, while one is open (#216)
    share: Option<share::ShareWindow>,
    /// What the Shared section lists (#253)
    shared: shared::SharedPage,
    /// Changes sent from Share windows closed or replaced before they were answered: a failure goes to the notice
    share_left: Vec<share::LeftChange>,
}

impl ProtonDriveNativeApp {
    fn new(
        cc: &eframe::CreationContext<'_>,
        screenshot_target: Option<String>,
        initial_tab: NavTab,
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

        let logo_texture = load_logo_texture(&cc.egui_ctx);
        let startup_cache = load_startup_cache();
        let mut initial_status = startup_cache.status.unwrap_or_default();
        if initial_status.state == "syncing" {
            initial_status.state = "idle".to_string();
            initial_status.current_action = None;
        }
        let initial_activities = startup_cache.activities;

        let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCommand>();
        let (evt_tx, evt_rx) = mpsc::channel::<WorkerEvent>();
        let egui_ctx = cc.egui_ctx.clone();

        thread::spawn(move || {
            worker_loop(cmd_rx, evt_tx, egui_ctx);
        });

        // RefreshAll autostarts the daemon if needed; the conflicts are what Home's Needs attention lists
        let _ = cmd_tx.send(WorkerCommand::RefreshAll);
        let _ = cmd_tx.send(WorkerCommand::LoadConflicts);

        // Opened on Shared (--tab shared): the list is asked for as the window opens
        let mut shared = shared::SharedPage::default();
        if initial_tab == NavTab::Shared {
            let seq = shared.begin_load();
            let _ = cmd_tx.send(WorkerCommand::SharedLoad { seq });
        }

        let edit_sync_dir = initial_status.settings.sync_dir.clone();
        let edit_conflict_strategy = if initial_status.settings.conflict_strategy.is_empty() {
            "keep-both".to_string()
        } else {
            initial_status.settings.conflict_strategy.clone()
        };
        let edit_notifications = initial_status.settings.notifications_enabled;
        let edit_start_at_login = initial_status.settings.start_at_login;
        let ignore_patterns_text = initial_status.settings.ignore_patterns.join("\n");
        let loaded_settings = initial_status.settings.clone();
        let attention = home::attention_items(&initial_status, &[]);

        Self {
            tab: initial_tab,
            tx: cmd_tx,
            rx: evt_rx,
            logo_texture,
            daemon_online: initial_status.logged_in,
            initial_connecting: true,
            status: initial_status,
            activities: initial_activities,
            login_url: None,
            account_error: None,
            search_query: String::new(),
            activity_filter: activity::ActivityFilter::All,
            expanded_activity: None,
            hidden: None,
            hidden_loading: false,
            unhiding: None,
            unhide_notice: None,
            working: Vec::new(),
            pending_confirm: None,
            notice: None,
            ignore_patterns_text,
            settings_dirty: false,
            loaded_settings,
            settings_saving: false,
            settings_notice: None,
            drive_working: false,
            drive_error: None,
            block_app_input: String::new(),
            blocklist_working: false,
            blocklist_error: None,
            files_missing_working: false,
            files_missing_error: None,
            start_fresh_working: false,
            start_fresh_error: None,
            conflicts: Vec::new(),
            attention,
            conflict_error: None,
            edit_sync_dir,
            edit_conflict_strategy,
            edit_notifications,
            edit_start_at_login,
            fake_drive: None,
            fake_files_missing: false,
            fake_attention: None,
            fake_transfers: None,
            fake_signed_out: false,
            fake_account_mismatch: false,
            fake_paused_until: None,
            pause_choices_open: false,
            account_menu_open: false,
            window_geometry,
            maximize_applied_on_open: false,
            applied_light_mode: initial_light,
            screenshot_target,
            frames_rendered: 0,
            screenshot_requested: false,
            last_poll: Instant::now(),
            share: None,
            shared,
            share_left: Vec::new(),
        }
    }

    /// Screenshot-only: lays `--fake-transfers` (that many uploads in progress) over a status from the daemon.
    fn apply_fake_transfers(&self, status: &mut DaemonStatus) {
        if let Some(n) = self.fake_transfers {
            status.active_transfers = fake_transfers(n);
        }
    }

    /// Screenshot-only: lays `--signed-out` over a status from the daemon, as the daemon reports no account.
    fn apply_fake_signed_out(&self, status: &mut DaemonStatus) {
        if self.fake_signed_out {
            status.logged_in = false;
            status.state = "unauthenticated".into();
            status.account = None;
        }
    }

    /// Screenshot-only: lays `--paused-until-min` over a status from the daemon: paused, until that time if one (#205).
    fn apply_fake_paused(&self, status: &mut DaemonStatus) {
        if let Some(until) = self.fake_paused_until {
            status.state = "paused".into();
            status.settings.paused = true;
            status.settings.paused_until = (until > 0).then_some(until);
        }
    }

    /// Screenshot-only: lays `--account-mismatch` over a status from the daemon, in the daemon's words (#35).
    fn apply_fake_account_mismatch(&self, status: &mut DaemonStatus) {
        if !self.fake_account_mismatch {
            return;
        }
        let message = "You signed in to a different Proton account than the files on this computer were synced with. \
            Nothing is synced, deleted or uploaded until you choose: sign back in to that account, or start fresh, keeping \
            the files on this computer and syncing them to this account as new files.";
        status.state = "error".into();
        status.last_error = Some(message.to_string());
        status.account_mismatch = Some(AccountMismatch { message: message.to_string() });
    }

    /// Screenshot-only: lays `--files-missing` over a status from the daemon.
    fn apply_fake_files_missing(&self, status: &mut DaemonStatus) {
        if !self.fake_files_missing {
            return;
        }
        let root = if !status.sync_dir.is_empty() {
            status.sync_dir.clone()
        } else {
            match std::env::var("HOME") {
                Ok(home) if !home.is_empty() => format!("{}/ProtonDrive", home.trim_end_matches('/')),
                _ => "/home/u/ProtonDrive".to_string(),
            }
        };
        // As after a restore by copy that has yet to finish: a folder still missing, and one file deeper down. Where, as
        // the daemon says it: the drive's storage in the virtual layout (lay --drive-status first), else the folder
        let place = if status.vfs.as_ref().is_some_and(|v| v.mode == "virtual") {
            "the drive's storage".to_string()
        } else {
            shown_folder(&root)
        };
        let message = format!("1284 items are missing from {place}. Nothing was deleted in Proton Drive.");
        status.state = "error".into();
        status.last_error = Some(message.clone());
        let names = vec!["Documents".into(), "Photos/2024/IMG_2041.jpg".into()];
        status.files_missing = Some(FilesMissing { root, names, items: 1284, message });
    }

    /// Screenshot-only: lays `--drive-status` / `--drive-move` over a status from the daemon.
    fn apply_fake_drive(&self, status: &mut DaemonStatus) {
        let Some((name, move_kind)) = &self.fake_drive else { return };
        let home = std::env::var("HOME").unwrap_or_default();
        if let Some((vfs, wanted)) = fake_drive_status(name, move_kind.as_deref(), &status.sync_dir, &home) {
            status.vfs = Some(vfs);
            status.virtual_drive_wanted = Some(wanted);
        }
    }

    /// What POST /drive/settings answered: the settings, the drive and the switch as they are now.
    fn apply_settings_reply(&mut self, reply: SettingsReply) {
        if let Some(settings) = reply.settings {
            if !self.settings_dirty && !self.settings_saving {
                self.load_settings_form(&settings);
            }
            self.status.sync_dir = settings.sync_dir.clone();
            self.status.settings = settings;
        }
        if reply.vfs.is_some() {
            self.status.vfs = reply.vfs;
        }
        if reply.virtual_drive_wanted.is_some() {
            self.status.virtual_drive_wanted = reply.virtual_drive_wanted;
        }
    }

    /// Sign in or out; a problem from the last try is cleared as this one starts.
    fn send_account_command(&mut self, cmd: WorkerCommand) {
        self.account_error = None;
        let _ = self.tx.send(cmd);
    }

    /// Sign-in and sign-out problems show under Activity's search row, in Settings' Account card and on Home, until the next try.
    fn show_account_error(&mut self, text: String) {
        self.login_url = None;
        self.notice = Some(text.clone());
        self.account_error = Some(text);
    }

    /// Fills the Settings form from the daemon's settings, which become what Save compares against.
    fn load_settings_form(&mut self, settings: &SyncSettings) {
        self.edit_sync_dir = settings.sync_dir.clone();
        self.edit_conflict_strategy = settings.conflict_strategy.clone();
        self.edit_notifications = settings.notifications_enabled;
        self.edit_start_at_login = settings.start_at_login;
        self.ignore_patterns_text = settings.ignore_patterns.join("\n");
        self.loaded_settings = settings.clone();
    }

    /// Recomputes what Needs attention lists (and the Home badge counts) from the status and the conflicts.
    fn refresh_attention(&mut self) {
        self.attention = match self.fake_attention {
            Some(n) => fake_attention_items(n),
            None => home::attention_items(&self.status, &self.conflicts),
        };
    }

    fn process_worker_events(&mut self) {
        let mut changed = false;
        while let Ok(evt) = self.rx.try_recv() {
            // Every event can change the status or the conflicts (a settings reply carries the drive's state)
            changed = true;
            match evt {
                WorkerEvent::StatusAndActivity { status, activity } => match *status {
                    Ok(mut s) => {
                        let was_offline = !self.daemon_online;
                        self.daemon_online = true;
                        self.initial_connecting = false;
                        self.apply_fake_drive(&mut s);
                        self.apply_fake_files_missing(&mut s);
                        self.apply_fake_transfers(&mut s);
                        self.apply_fake_signed_out(&mut s);
                        self.apply_fake_account_mismatch(&mut s);
                        self.apply_fake_paused(&mut s);
                        // Edits being made or saved stay as they are; Save compares them with what they were loaded from
                        if !self.settings_dirty && !self.settings_saving {
                            self.load_settings_form(&s.settings);
                        }
                        if s.logged_in {
                            self.login_url = None;
                        }
                        // Signed out meanwhile (from Settings, the tray…): the account menu has nothing left to offer
                        if !s.logged_in && s.account.is_none() {
                            self.account_menu_open = false;
                        }
                        // The list Needs attention shows may have changed: reload it while any is open (see
                        // should_reload_conflicts)
                        let listed_open = self.conflicts.iter().filter(|c| c.resolved == 0).count();
                        if home::should_reload_conflicts(
                            was_offline,
                            self.status.stats.unresolved_conflicts,
                            s.stats.unresolved_conflicts,
                            listed_open,
                        ) {
                            let _ = self.tx.send(WorkerCommand::LoadConflicts);
                        }
                        self.status = s;
                        self.activities = activity;
                        save_startup_cache(&self.status, &self.activities);
                        // A hide finishing, or one made in Files, shows in Settings' list by the next status
                        if self.tab == NavTab::Settings {
                            self.load_hidden();
                        }
                        // A Share window opened before the daemon answered finds its item now
                        self.resolve_share();
                    }
                    Err(_) => {
                        self.daemon_online = false;
                        self.initial_connecting = false;
                        self.resolve_share();
                    }
                },
                WorkerEvent::LoginStarted(result) => match result {
                    Ok(reply) => {
                        self.login_url = Some(reply.sign_in_url);
                        self.account_error = None;
                    }
                    Err(e) => self.show_account_error(format!("Couldn't start signing in: {e}")),
                },
                WorkerEvent::LoggedOut(result) => {
                    match result {
                        Ok(()) => self.account_error = None,
                        Err(e) => self.show_account_error(format!("Couldn't sign out: {e}")),
                    }
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::ConflictResolved(result) => {
                    self.conflict_error = result.err();
                    let _ = self.tx.send(WorkerCommand::LoadConflicts);
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::SettingsSaved(result) => {
                    self.settings_saving = false;
                    match result {
                        Ok(reply) => {
                            self.settings_notice =
                                Some(reply.problem().map_or_else(|| Notice::info("Preferences saved."), Notice::error));
                            self.settings_dirty = false;
                            self.apply_settings_reply(reply);
                        }
                        // Nothing was stored: the edits stay, to fix and save again
                        Err(e) => self.settings_notice = Some(Notice::error(e)),
                    }
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::VirtualDriveSwitched(result) => {
                    self.drive_working = false;
                    match result {
                        Ok(reply) => {
                            self.drive_error = non_empty(&reply.switch_error).map(String::from);
                            self.apply_settings_reply(reply);
                        }
                        Err(e) => self.drive_error = Some(e),
                    }
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::BlockedAppsSaved(result) => {
                    self.blocklist_working = false;
                    match result {
                        Ok(reply) => {
                            self.blocklist_error = None;
                            self.block_app_input.clear();
                            self.apply_settings_reply(reply);
                        }
                        // Nothing was stored: the name stays, to fix and try again
                        Err(e) => self.blocklist_error = Some(e),
                    }
                }
                WorkerEvent::DriveDone(result) => {
                    self.drive_working = false;
                    self.drive_error = result.err();
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::FilesMissingDone(result) => {
                    self.files_missing_working = false;
                    self.files_missing_error = result.err();
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::HiddenLoaded(result) => {
                    self.hidden_loading = false;
                    self.hidden = Some(result);
                }
                WorkerEvent::StartFreshDone(result) => {
                    self.start_fresh_working = false;
                    self.start_fresh_error = result.err();
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
                WorkerEvent::ConflictsLoaded(conflicts) => {
                    self.conflicts = conflicts;
                }
                WorkerEvent::SharedLoaded(seq, result) => self.shared.loaded(seq, result),
                WorkerEvent::SharedStopped(rel_path, result) => {
                    if self.shared.stopping.as_deref() == Some(rel_path.as_str()) {
                        self.shared.stopping = None;
                    }
                    match result {
                        Ok(()) => self.load_shared(),
                        Err(e) => {
                            // Reading the list again when Shared is next opened would drop this: off the page it is told
                            // in the notice, with the item's name
                            if self.tab != NavTab::Shared {
                                let name = self
                                    .shared
                                    .items
                                    .iter()
                                    .flatten()
                                    .find(|i| i.rel_path.as_deref() == Some(rel_path.as_str()))
                                    .map(|i| i.name.clone())
                                    .unwrap_or_else(|| rel_path.rsplit('/').next().unwrap_or(&rel_path).to_string());
                                self.notice = Some(format!("Couldn't stop sharing {name}: {e}"));
                            }
                            self.shared.stop_error = Some(e);
                        }
                    }
                }
                WorkerEvent::ShareLoaded(window, result) => self.share_loaded(window, result),
                WorkerEvent::ShareDone(window, result) => self.share_done(window, result),
                WorkerEvent::SharePassword(window, result) => self.share_password(window, result),
                WorkerEvent::AvailabilityDone { path, result } => {
                    if let Some(i) = self.working.iter().position(|w| w == &path) {
                        self.working.remove(i);
                    }
                    let notice = match &result {
                        Ok(r) => availability_notice(r).map(|text| {
                            if r.refused.as_deref().is_some_and(|m| !m.is_empty()) {
                                Notice::error(text)
                            } else {
                                Notice::info(text)
                            }
                        }),
                        Err(e) => Some(Notice::error(e.clone())),
                    };
                    if self.unhiding.as_deref() == Some(path.as_str()) {
                        // An Unhide from Settings: its list changed, and how it went shows in its card, not on Home
                        self.unhiding = None;
                        self.unhide_notice = notice;
                        self.hidden_loading = false;
                        self.load_hidden();
                    } else {
                        self.notice = notice.map(|n| n.text);
                    }
                    // The status counters change with the action
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                }
            }
        }
        if changed {
            self.refresh_attention();
        }
    }

    /// Shows a section, closing the account menu; Settings reads what is hidden as it opens.
    fn open_tab(&mut self, tab: NavTab) {
        self.account_menu_open = false;
        if tab == NavTab::Settings && self.tab != NavTab::Settings {
            self.load_hidden();
        }
        if tab == NavTab::Shared && self.tab != NavTab::Shared {
            self.load_shared();
        }
        self.tab = tab;
    }

    /// Asks for what is shared. Each entry, Refresh and Retry asks again; only the newest read's answer is shown (older ones, which can
    /// arrive later, are ignored).
    fn load_shared(&mut self) {
        let seq = self.shared.begin_load();
        let _ = self.tx.send(WorkerCommand::SharedLoad { seq });
    }

    /// Shared: what you've shared, as a list of Proton's kind: each item's name, where it is, what it exposes and what
    /// can be done with it.
    fn render_shared(&mut self, ui: &mut egui::Ui) {
        // A gutter for the scroll bar, as Settings has, so that it never draws over the actions; the toolbar keeps it
        // too, so that Refresh lines up with them
        let gutter = Margin { left: 0, right: 12, top: 0, bottom: 0 };
        // The toolbar, which stays while the list scrolls: what was just done on the left, Refresh on the right, in
        // line with the rows' actions (the title is the top bar's)
        let toolbar = Margin { right: gutter.right + SHARED_ROW_END as i8, ..gutter };
        Frame::NONE.inner_margin(toolbar).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(34.0);
                if self.shared.copied.is_some() {
                    ui.label(RichText::new(icons::CHECK).font(icons::font(16.0)).color(STATUS_SUCCESS));
                    ui.label(RichText::new("Link copied").size(13.0).color(TEXT_MUTED()));
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // Retry is the action while the list couldn't be read
                    if self.shared.error.is_none() {
                        let refresh = ui.add_enabled_ui(!self.shared.loading, |ui| icon_button(ui, icons::REFRESH, "Refresh")).inner;
                        if refresh.clicked() {
                            self.load_shared();
                        }
                    }
                });
            });
        });
        ui.add_space(8.0);

        ScrollArea::vertical().id_salt("shared_scroll").auto_shrink([false, false]).show(ui, |ui| {
            Frame::NONE.inner_margin(gutter).show(ui, |ui| {
                if let Some(error) = self.shared.error.clone() {
                    ui.add(egui::Label::new(RichText::new(error).size(13.0).color(DANGER_TEXT())).wrap());
                    ui.add_space(10.0);
                    if proton_button(
                        ui,
                        Vec2::new(button_width(ui, "Retry"), 34.0),
                        "Retry",
                        PROTON_PURPLE,
                        PROTON_PURPLE_HOVER,
                        None,
                        Color32::WHITE,
                        13.0,
                    )
                    .clicked()
                    {
                        self.load_shared();
                    }
                    return;
                }
                let loading = self.shared.loading;
                if loading {
                    ui.label(RichText::new(shared::LOADING).size(13.0).color(TEXT_MUTED()));
                    ui.add_space(10.0);
                }
                let Some(items) = &self.shared.items else { return };
                if items.is_empty() {
                    if !loading {
                        ui.add(egui::Label::new(RichText::new(shared::EMPTY).size(13.0).color(TEXT_MUTED())).wrap());
                        ui.add_space(8.0);
                        Self::shared_photos_note(ui, self.screenshot_target.is_some());
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

    /// The daemon never lists Photos shares, so the page says where to find them (#256).
    fn shared_photos_note(ui: &mut egui::Ui, screenshot: bool) {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            ui.label(RichText::new(shared::PHOTOS_NOTE).size(12.5).color(TEXT_MUTED()));
            if ui.add(egui::Link::new(RichText::new(shared::PHOTOS_LINK).size(12.5))).clicked() {
                home::open_externally(std::ffi::OsStr::new(shared::WEB_SHARED_URL), screenshot);
            }
        });
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

    /// Asks for what is hidden from this computer, unless a read is already out.
    fn load_hidden(&mut self) {
        if !self.hidden_loading {
            self.hidden_loading = true;
            let _ = self.tx.send(WorkerCommand::LoadHidden);
        }
    }

    /// Activity: what was synced, newest first, with a search over it. Storage and transfers are Home's.
    fn render_activity(&mut self, ui: &mut egui::Ui) {
        // The page scrolls when the window is too short for a usable activity table; on taller windows the table
        // fills the rest exactly, so no page scrollbar appears.
        let viewport_h = ui.available_height();
        ScrollArea::vertical()
            .id_salt("activity_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| self.render_activity_content(ui, viewport_h));
    }

    fn render_activity_content(&mut self, ui: &mut egui::Ui, viewport_h: f32) {
        let content_top = ui.cursor().top();

        // Sign in while signed out, the search and the filter; the row wraps to a second line when the page is narrow
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
            if !self.status.logged_in
                && proton_button(
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
                self.send_account_command(WorkerCommand::StartLogin);
            }
            let width = ui.available_width().clamp(120.0, ACTIVITY_SEARCH_WIDTH);
            search_field(ui, &mut self.search_query, "Search activity", width);
            for (filter, label) in activity::FILTERS.iter() {
                if filter_chip(ui, label, self.activity_filter == *filter) {
                    self.activity_filter = *filter;
                }
            }
        });

        if let Some(error) = &self.account_error {
            ui.add_space(6.0);
            ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
        } else if let Some(url) = &self.login_url {
            let text = if url.is_empty() {
                "Opening the Proton sign-in page in your browser…".to_string()
            } else {
                format!("Sign-in URL opened in browser: {url}")
            };
            ui.add_space(6.0);
            ui.label(RichText::new(text).size(12.0).color(PROTON_PURPLE_TEXT()));
        }

        ui.add_space(14.0);

        let query = self.search_query.clone();
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());

            // The column names, quiet, over a line: no band
            let (hdr_rect, _) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::hover());
            ui.painter().line_segment(
                [hdr_rect.left_bottom(), hdr_rect.right_bottom()],
                Stroke::new(1.0_f32, BORDER_SUBTLE()),
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
                    let filter = self.activity_filter;
                    let shown: Vec<ActivityRecord> = self
                        .activities
                        .iter()
                        .filter(|a| activity_matches(a, &query))
                        .filter(|a| activity::in_filter(activity::activity_kind(&a.action, &a.details), filter))
                        .take(ACTIVITY_SHOWN)
                        .cloned()
                        .collect();
                    if self.activities.is_empty() || shown.is_empty() {
                        let text = if self.activities.is_empty() {
                            "No synchronization activity recorded yet.".to_string()
                        } else if !query.trim().is_empty() {
                            format!("No activity matches \"{}\".", query.trim())
                        } else {
                            match filter {
                                activity::ActivityFilter::Uploads => "No uploads yet.".to_string(),
                                activity::ActivityFilter::Downloads => "No downloads yet.".to_string(),
                                activity::ActivityFilter::Problems => "No conflicts or failures.".to_string(),
                                activity::ActivityFilter::All => "No synchronization activity recorded yet.".to_string(),
                            }
                        };
                        ui.add_space(16.0);
                        ui.label(RichText::new(text).size(13.0).color(TEXT_MUTED()));
                    } else {
                        for act in &shown {
                            let kind = activity::activity_kind(&act.action, &act.details);
                            let key = activity_key(act);
                            let expanded = self.expanded_activity.as_ref().is_some_and(|e| e.key == key);
                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 38.0),
                                Sense::click(),
                            );
                            if row_resp.hovered() {
                                ui.painter().rect_filled(
                                    row_rect,
                                    CornerRadius::same(6),
                                    BG_INPUT(),
                                );
                            }
                            ui.painter().line_segment(
                                [
                                    egui::pos2(row_rect.min.x + 10.0, row_rect.max.y),
                                    egui::pos2(row_rect.max.x - 10.0, row_rect.max.y),
                                ],
                                Stroke::new(1.0_f32, BORDER_SUBTLE()),
                            );

                            let cy = row_rect.center().y;
                            let r_file_x = row_rect.min.x + 152.0;
                            let r_details_x =
                                (row_rect.min.x + row_rect.width() * 0.44).max(r_file_x + 210.0);
                            let r_time_right_x = row_rect.max.x - 16.0;

                            let pill_label = activity::kind_label(kind);
                            let (pill_bg, pill_fg) = activity_pill_colors(kind);
                            let pill_rect = egui::Rect::from_min_size(
                                egui::pos2(row_rect.min.x + 12.0, cy - 11.0),
                                Vec2::new(124.0, 22.0),
                            );
                            ui.painter()
                                .rect_filled(pill_rect, CornerRadius::same(99), pill_bg);
                            // Freed up or hidden: still in Proton Drive, online-only, which the cloud says
                            let label_center = if activity::shows_cloud(kind) {
                                draw_cloud_icon(ui.painter(), egui::pos2(pill_rect.min.x + 18.0, cy), pill_fg);
                                pill_rect.center() + Vec2::new(8.0, 0.0)
                            } else {
                                pill_rect.center()
                            };
                            ui.painter().text(
                                label_center,
                                egui::Align2::CENTER_CENTER,
                                pill_label,
                                FontId::new(11.0, FontFamily::Proportional),
                                pill_fg,
                            );

                            // File / Folder icon + name
                            // Taken away here (removed, freed up, hidden): grey, and a folder when the path looks like one
                            let taken_away = matches!(
                                kind,
                                activity::ActivityKind::RemovedLocally | activity::ActivityKind::FreedUp | activity::ActivityKind::Hidden
                            );
                            let is_folder_act = act.action == "mkdir" || taken_away && !act.local_rel_path.contains('.');
                            let ic_rect = egui::Rect::from_center_size(
                                egui::pos2(r_file_x + 9.0, cy),
                                Vec2::new(17.0, 14.5),
                            );
                            if is_folder_act {
                                draw_folder_icon(ui.painter(), ic_rect, !taken_away);
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
                            // Cut short: the whole text shows on hover; it shows in the row a click opens, too
                            let row_resp = if truncated {
                                row_resp.on_hover_text(format!("{}\n{}", act.local_rel_path, act.details))
                            } else {
                                row_resp
                            }
                            .on_hover_cursor(egui::CursorIcon::PointingHand);
                            if row_resp.clicked() {
                                self.expanded_activity = if expanded {
                                    None
                                } else {
                                    let sync_dir = &self.status.sync_dir;
                                    Some(ExpandedActivity {
                                        key: key.clone(),
                                        show: activity::show_target(sync_dir, &act.local_rel_path),
                                        open: activity::open_target(sync_dir, &act.local_rel_path),
                                    })
                                };
                            }
                            if expanded {
                                self.render_activity_details(ui, act);
                            }
                        }
                    }
                });
        });
    }

    /// An opened Activity row: its whole path and details, and Show in Files and, for a file there now, Open (#94)
    fn render_activity_details(&mut self, ui: &mut egui::Ui, act: &ActivityRecord) {
        Frame::NONE
            .fill(BG_CARD_ALT())
            .corner_radius(CornerRadius::same(8))
            .inner_margin(Margin::symmetric(14, 10))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.add(egui::Label::new(RichText::new(&act.local_rel_path).size(13.0).strong().color(TEXT_PRIMARY())).wrap());
                ui.add_space(2.0);
                ui.add(egui::Label::new(RichText::new(&act.details).size(12.5).color(TEXT_MUTED())).wrap());
                let (show, open) = self.expanded_activity.as_ref().map(|e| (e.show.clone(), e.open.clone())).unwrap_or_default();
                if show.is_some() || open.is_some() {
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if let Some(path) = &show {
                            if home::secondary_button(ui, "Show in Files", 28.0).clicked() {
                                home::show_in_files(path);
                            }
                        }
                        if let Some(path) = &open {
                            ui.add_space(6.0);
                            if home::secondary_button(ui, "Open", 28.0).clicked() {
                                home::open_file(path);
                            }
                        }
                    });
                }
            });
        ui.add_space(4.0);
    }

    /// Asks the daemon, over the control socket and off the UI thread, to change availability.
    fn send_availability(&mut self, rel_path: String, action: &str) {
        self.notice = None;
        self.working.push(rel_path.clone());
        let _ = self.tx.send(WorkerCommand::SetAvailability { path: rel_path, action: action.to_string() });
    }

    /// While an availability action runs, a line saying so; then a dismissible line with how it went.
    fn render_notice(&mut self, ui: &mut egui::Ui) {
        if !self.working.is_empty() {
            ui.add_space(10.0);
            Frame::NONE
                .fill(PROTON_PURPLE_SOFT())
                .corner_radius(CornerRadius::same(8))
                .inner_margin(Margin::symmetric(12, 8))
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    ui.label(
                        RichText::new("↻ Working… this can take a while for large folders.")
                            .size(12.5)
                            .color(PROTON_PURPLE_TEXT()),
                    );
                });
        }
        let Some(text) = self.notice.clone() else {
            return;
        };
        ui.add_space(10.0);
        Frame::NONE
            .fill(Color32::from_rgba_unmultiplied(230, 138, 0, 32))
            .stroke(Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(230, 138, 0, 120)))
            .corner_radius(CornerRadius::same(8))
            .inner_margin(Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.horizontal_top(|ui| {
                    ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                        let close = ui
                            .add(
                                egui::Button::new(RichText::new("×").size(18.0).color(TEXT_MUTED()))
                                    .frame(false),
                            )
                            .on_hover_text("Dismiss");
                        if close.clicked() {
                            self.notice = None;
                        }
                        ui.with_layout(Layout::left_to_right(Align::Min), |ui| {
                            ui.add(
                                egui::Label::new(RichText::new(&text).size(12.5).color(TEXT_PRIMARY())).wrap(),
                            );
                        });
                    });
                });
            });
    }

    /// Confirmation for Free up space, switching the virtual drive off and deleting the missing files in Proton Drive.
    fn render_confirm_modal(&mut self, ctx: &egui::Context) {
        let Some(confirm) = self.pending_confirm.clone() else {
            return;
        };
        if ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.pending_confirm = None;
            return;
        }

        let screen_rect = ctx.screen_rect();
        // The dimmed backdrop takes the clicks meant for what is under it: a click outside only cancels
        click_shield(
            ctx,
            "confirm_backdrop",
            egui::Order::Foreground,
            Some(Color32::from_rgba_unmultiplied(10, 8, 16, 175)),
        );

        let modal_w = 436.0;
        let modal_h = 236.0;
        let modal_pos = egui::pos2(
            screen_rect.center().x - modal_w * 0.5,
            screen_rect.center().y - modal_h * 0.5,
        );

        let ConfirmCopy { title, body, detail, button, cancel, rel_path: action_path, action } =
            confirm_copy(&confirm, self.status.vfs.as_ref().is_some_and(|v| v.mode == "virtual"));

        let area_resp = egui::Area::new(egui::Id::new("confirm_dialog"))
            .order(egui::Order::Tooltip)
            .fixed_pos(modal_pos)
            .show(ctx, |ui| {
                Frame::NONE
                    .fill(BG_CARD())
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                    .corner_radius(CornerRadius::same(14))
                    .shadow(egui::Shadow {
                        offset: [0, 12],
                        blur: 32,
                        spread: 2,
                        color: Color32::from_rgba_unmultiplied(0, 0, 0, 190),
                    })
                    .inner_margin(Margin::symmetric(24, 22))
                    .show(ui, |ui| {
                        ui.set_min_width(modal_w - 48.0);
                        ui.set_max_width(modal_w - 48.0);

                        ui.label(RichText::new(title).size(16.5).strong().color(TEXT_PRIMARY()));
                        ui.add_space(10.0);
                        ui.label(RichText::new(body).size(13.0).color(TEXT_PRIMARY()));
                        ui.add_space(6.0);
                        ui.label(RichText::new(detail).size(12.5).color(TEXT_MUTED()));

                        ui.add_space(20.0);
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            // Deleting from Proton Drive is destructive: red, not the primary purple
                            let (fill, hover) = if matches!(confirm, PendingConfirm::DeleteMissing { .. } | PendingConfirm::StopSharing { .. }) {
                                (STATUS_DANGER, STATUS_DANGER_HOVER)
                            } else {
                                (PROTON_PURPLE, PROTON_PURPLE_HOVER)
                            };
                            if proton_button(
                                ui,
                                Vec2::new(if button.len() > 16 { 186.0 } else { 138.0 }, 36.0),
                                button,
                                fill,
                                hover,
                                None,
                                Color32::WHITE,
                                13.0,
                            )
                            .clicked()
                            {
                                // Exhaustive on purpose: a new variant must say what it sends, not fall into availability
                                match &confirm {
                                    PendingConfirm::VirtualDriveOff => {
                                        self.send_drive_command(WorkerCommand::SetVirtualDrive(false));
                                    }
                                    PendingConfirm::DeleteMissing { root, names, .. } => {
                                        self.resolve_files_missing(MissingChoice::DeleteInCloud, root.clone(), names.clone());
                                    }
                                    PendingConfirm::StopSharing { rel_path, uid, .. } => {
                                        self.shared.stopping = Some(rel_path.clone());
                                        self.shared.stop_error = None;
                                        let _ = self.tx.send(WorkerCommand::SharedStop { rel_path: rel_path.clone(), uid: uid.clone() });
                                    }
                                    PendingConfirm::StartFresh => {
                                        self.start_fresh_working = true;
                                        self.start_fresh_error = None;
                                        let _ = self.tx.send(WorkerCommand::StartFresh);
                                    }
                                    PendingConfirm::FreeAll { .. } => {
                                        self.send_availability(action_path.clone(), action);
                                    }
                                }
                                self.pending_confirm = None;
                            }

                            ui.add_space(8.0);

                            if proton_button(
                                ui,
                                Vec2::new(if cancel == "Cancel" { 88.0 } else { 118.0 }, 36.0),
                                cancel,
                                BG_CARD_ALT(),
                                btn_secondary_hover_bg(),
                                Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                                TEXT_PRIMARY(),
                                13.0,
                            )
                            .clicked()
                            {
                                self.pending_confirm = None;
                            }
                        });
                    });
            });

        // Dismiss if clicked outside the dialog
        if ctx.input(|i| i.pointer.any_pressed()) {
            if let Some(pos) = ctx.input(|i| i.pointer.interact_pos()) {
                if !area_resp.response.rect.contains(pos) {
                    self.pending_confirm = None;
                }
            }
        }
    }

    /// In Home's Needs attention while the daemon holds because the files are missing from the folder: what is missing, that
    /// nothing was deleted, and what can be done besides waiting, which is the default and needs nothing. Keeping them
    /// online-only deletes nothing, so it asks nothing: the banner says what it does. Deleting them from Proton Drive too
    /// asks first. In the virtual layout (the files were in the drive's hidden storage) keeping them online-only is the
    /// default; in the plain layout the files are often on a disk that isn't connected, so waiting stays the default.
    fn render_files_missing(&mut self, ui: &mut egui::Ui) {
        let Some(fm) = self.status.files_missing.clone() else {
            return;
        };
        let virtual_layout = self.status.vfs.as_ref().is_some_and(|v| v.mode == "virtual");
        Frame::NONE
            .fill(Color32::from_rgba_unmultiplied(239, 68, 68, 26))
            .stroke(Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(239, 68, 68, 110)))
            .corner_radius(CornerRadius::same(10))
            .inner_margin(Margin::symmetric(16, 12))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                // What the daemon says (what is missing, and where, in the user's terms); a daemon from before it said
                // so names the folder
                let title = if fm.message.trim().is_empty() {
                    format!("Proton Drive's files are missing from {}. Nothing was deleted in Proton Drive.", shown_folder(&fm.root))
                } else {
                    fm.message.clone()
                };
                ui.add(egui::Label::new(RichText::new(title).size(13.5).strong().color(TEXT_PRIMARY())).wrap());
                ui.add_space(2.0);
                let detail = format!(
                    "{} missing. Proton Drive waits for them to come back and syncs nothing meanwhile.",
                    missing_names(&fm)
                );
                ui.add(egui::Label::new(RichText::new(detail).size(12.5).color(TEXT_MUTED())).wrap());
                ui.add_space(2.0);
                let keep_says = if virtual_layout {
                    "Keep them online-only to stop waiting: they stay in Proton Drive, and the drive shows them as online-only. Nothing is deleted."
                } else {
                    "Keep them online-only to stop waiting: they stay in Proton Drive as online-only files, and aren't downloaded again. Nothing is deleted."
                };
                ui.add(egui::Label::new(RichText::new(keep_says).size(12.5).color(TEXT_MUTED())).wrap());
                if let Some(error) = &self.files_missing_error {
                    ui.add_space(2.0);
                    ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
                }
                ui.add_space(8.0);
                let working = self.files_missing_working;
                let mut chosen = None;
                ui.horizontal(|ui| {
                    ui.add_enabled_ui(!working, |ui| {
                        let kind = if virtual_layout { ButtonKind::Primary } else { ButtonKind::Secondary };
                        let keep = action_button(ui, kind, Some(icons::ONLINE_ONLY), "Keep them online-only", 32.0);
                        if keep.on_hover_text("Nothing is deleted, on this computer or in Proton Drive").clicked() {
                            chosen = Some(MissingChoice::KeepOnlineOnly);
                        }
                        ui.add_space(4.0);
                        let delete = action_button(ui, ButtonKind::DangerOutline, Some(icons::TRASH), "Delete them from Proton Drive too", 32.0);
                        if delete.on_hover_text("Asks first. While they are missing, nothing is deleted in Proton Drive.").clicked() {
                            chosen = Some(MissingChoice::DeleteInCloud);
                        }
                    });
                });
                match chosen {
                    _ if working => {}
                    Some(MissingChoice::KeepOnlineOnly) => self.resolve_files_missing(MissingChoice::KeepOnlineOnly, fm.root.clone(), fm.names.clone()),
                    Some(MissingChoice::DeleteInCloud) => {
                        self.pending_confirm =
                            Some(PendingConfirm::DeleteMissing { root: fm.root.clone(), names: fm.names.clone(), items: fm.items });
                    }
                    None => {}
                }
            });
    }

    /// In Home's Needs attention, first, while the daemon holds because the records are of another Proton account than
    /// the one signed in to: what the daemon says, and the two ways on. Starting fresh asks first; signing out (to sign
    /// in to the account the files were synced with) asks nothing, as it changes no file.
    fn render_account_mismatch(&mut self, ui: &mut egui::Ui) {
        let Some(mismatch) = self.status.account_mismatch.clone() else {
            return;
        };
        Frame::NONE
            .fill(Color32::from_rgba_unmultiplied(239, 68, 68, 26))
            .stroke(Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(239, 68, 68, 110)))
            .corner_radius(CornerRadius::same(10))
            .inner_margin(Margin::symmetric(16, 12))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.add(
                    egui::Label::new(RichText::new("Signed in to a different Proton account").size(13.5).strong().color(TEXT_PRIMARY()))
                        .wrap(),
                );
                ui.add_space(2.0);
                ui.add(egui::Label::new(RichText::new(&mismatch.message).size(12.5).color(TEXT_MUTED())).wrap());
                if let Some(error) = &self.start_fresh_error {
                    ui.add_space(2.0);
                    ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
                }
                ui.add_space(8.0);
                let working = self.start_fresh_working;
                let mut start_fresh = false;
                let mut sign_out = false;
                ui.horizontal(|ui| {
                    ui.add_enabled_ui(!working, |ui| {
                        let fresh = action_button(ui, ButtonKind::Primary, Some(icons::RESTART), "Start fresh with this account", 32.0);
                        if fresh.on_hover_text("Asks first. The files on this computer stay, and upload to this account.").clicked() {
                            start_fresh = true;
                        }
                        ui.add_space(4.0);
                        let out = action_button(ui, ButtonKind::Secondary, Some(icons::SIGN_OUT), "Sign out", 32.0);
                        if out.on_hover_text("Then sign in to the account the files were synced with").clicked() {
                            sign_out = true;
                        }
                    });
                });
                if !working && start_fresh {
                    self.pending_confirm = Some(PendingConfirm::StartFresh);
                }
                if !working && sign_out {
                    // As Settings › Account signs out
                    self.send_account_command(WorkerCommand::Logout);
                }
            });
    }

    /// Asks the daemon to do what the user chose about the missing files, as they were shown.
    fn resolve_files_missing(&mut self, choice: MissingChoice, root: String, names: Vec<String>) {
        self.files_missing_working = true;
        self.files_missing_error = None;
        let _ = self.tx.send(WorkerCommand::ResolveFilesMissing { choice, root, names });
    }

    /// One frame of the window's contents: the sidebar, the top bar, the current section and anything floating over
    /// them.
    fn render_ui(&mut self, ctx: &egui::Context) {
        self.render_sidebar(ctx);
        self.render_top_bar(ctx);

        egui::CentralPanel::default()
            .frame(
                Frame::NONE
                    .fill(BG_CANVAS())
                    .inner_margin(Margin::symmetric(26, 20)),
            )
            .show(ctx, |ui| {
                // Nothing under the confirmation dialog or the Share window takes clicks or keys while it is open
                if self.dialog_open() {
                    ui.disable();
                }
                match self.tab {
                    NavTab::Home => self.render_home(ui),
                    NavTab::Shared => self.render_shared(ui),
                    NavTab::Activity => self.render_activity(ui),
                    NavTab::Settings => self.render_settings_tab(ui),
                }
            });

        self.render_confirm_modal(ctx);
        self.render_share(ctx);
    }

    fn render_settings_tab(&mut self, ui: &mut egui::Ui) {
        ScrollArea::vertical()
            .id_salt("settings_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                // A gutter for the scroll bar, so that it never draws over the cards' edges
                Frame::NONE.inner_margin(Margin { left: 0, right: 12, top: 0, bottom: 0 }).show(ui, |ui| {
                    self.render_account_card(ui);
                    ui.add_space(14.0);
                    // A daemon before Stage 2 has no virtual drive to show
                    if let Some(vfs) = self.status.vfs.clone() {
                        self.render_drive_card(ui, &vfs);
                        ui.add_space(14.0);
                        self.render_blocked_apps_card(ui);
                        ui.add_space(14.0);
                    }
                    self.render_hidden_card(ui);
                    ui.add_space(14.0);
                    self.render_sync_settings_card(ui);
                });
            });
    }

    /// The drive: where it is, and the virtual drive switch. Its state, Mount again and a move that stopped are Home's.
    fn render_drive_card(&mut self, ui: &mut egui::Ui, vfs: &VfsStatus) {
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("Drive").size(16.0).strong().color(TEXT_PRIMARY()));
            ui.add_space(12.0);

            ui.label(RichText::new("Location").size(13.0).color(TEXT_MUTED()));
            ui.add_space(4.0);
            let sync_dir = &self.status.sync_dir;
            let shown = if sync_dir.is_empty() { "Not set up yet".to_string() } else { shown_folder(sync_dir) };
            ui.add(egui::Label::new(RichText::new(&shown).size(14.0).strong().color(TEXT_PRIMARY())).truncate())
                .on_hover_text(sync_dir);
            ui.label(RichText::new(home::drive_kind(Some(vfs))).size(12.5).color(TEXT_MUTED()));
            ui.add_space(14.0);
            ui.separator();
            ui.add_space(12.0);

            // On is what the user chose (the daemon's virtualDriveWanted); without FUSE the drive is a plain folder anyway
            let on = self.status.virtual_drive_wanted.unwrap_or(vfs.mode == "virtual");
            let clicked = ui
                .add_enabled_ui(!self.drive_working && switch_wait_reason(vfs).is_none(), |ui| {
                    ui.horizontal(|ui| {
                        let switch = toggle_switch(ui, on);
                        ui.add_space(4.0);
                        let label = ui.add(
                            egui::Label::new(
                                RichText::new("Show online-only files in Files (virtual drive)")
                                    .size(13.5)
                                    .color(TEXT_PRIMARY()),
                            )
                            .sense(Sense::click()),
                        );
                        if label.hovered() {
                            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                        }
                        switch.clicked() || label.clicked()
                    })
                    .inner
                })
                .inner;
            ui.add_space(4.0);
            ui.add(
                egui::Label::new(
                    RichText::new(
                        "Files you haven't downloaded appear in Files and download when you open them.",
                    )
                    .size(12.0)
                    .color(TEXT_MUTED()),
                )
                .wrap(),
            );
            // Why the drive is a plain folder although the switch is on (switched off is the user's own choice)
            if on && matches!(vfs.reason.as_deref(), Some("fuse-unavailable" | "different-disk")) {
                ui.add_space(6.0);
                ui.add(
                    egui::Label::new(
                        RichText::new(drive_status_line(vfs, &self.status.sync_dir)).size(12.5).color(STATUS_WARNING),
                    )
                    .wrap(),
                );
            } else if let Some(why) = switch_wait_reason(vfs) {
                // The switch is disabled while the drive moves files or starts: say so
                ui.add_space(6.0);
                ui.add(egui::Label::new(RichText::new(why).size(12.5).color(TEXT_MUTED())).wrap());
            }
            if self.drive_working {
                ui.add_space(10.0);
                ui.label(
                    RichText::new("↻ Working… moving files can take a while.").size(12.5).color(PROTON_PURPLE_TEXT()),
                );
            }
            if let Some(error) = &self.drive_error {
                ui.add_space(10.0);
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
            }
            if clicked {
                if on {
                    self.pending_confirm = Some(PendingConfirm::VirtualDriveOff);
                } else {
                    self.send_drive_command(WorkerCommand::SetVirtualDrive(true));
                }
            }
        });
    }

    /// A move that stopped: where from and to, why, and one button per action the daemon offers now.
    fn render_stopped_move(&mut self, ui: &mut egui::Ui, vfs: &VfsStatus, mv: &DriveMove) {
        let mut chosen: Option<String> = None;
        Frame::NONE
            .fill(BG_CARD_ALT())
            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
            .corner_radius(CornerRadius::same(8))
            .inner_margin(Margin::symmetric(14, 12))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                let title = if mv.kind == "relocation" {
                    "Moving the Proton Drive folder didn't finish"
                } else {
                    "Moving files between the folder and the drive didn't finish"
                };
                ui.add(egui::Label::new(RichText::new(title).size(13.5).strong().color(TEXT_PRIMARY())).wrap());
                ui.add_space(4.0);
                // The two folders start at the same x
                let font = FontId::proportional(12.5);
                let label_w = text_width(ui.painter(), "From", &font) + 6.0;
                for (label, folder) in [("From", &mv.from), ("To", &mv.to)] {
                    ui.horizontal_top(|ui| {
                        let row_h = ui.fonts(|f| f.row_height(&font));
                        let (cell, _) = ui.allocate_exact_size(Vec2::new(label_w, row_h), Sense::hover());
                        ui.painter().text(cell.left_center(), egui::Align2::LEFT_CENTER, label, font.clone(), TEXT_MUTED());
                        ui.add(egui::Label::new(RichText::new(folder).size(12.5).color(TEXT_PRIMARY())).wrap());
                    });
                }
                // Not twice: the status line already shows the error of a move that failed
                let shown_above = (vfs.reason.as_deref() == Some("move-failed"))
                    .then(|| non_empty(&vfs.error).or_else(|| non_empty(&mv.error)))
                    .flatten();
                if let Some(error) = non_empty(&mv.error).filter(|e| Some(*e) != shown_above) {
                    ui.add_space(4.0);
                    ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
                }
                if mv.actions.iter().any(|a| move_action_label(a).is_some()) {
                    ui.add_space(10.0);
                    ui.add_enabled_ui(!self.drive_working, |ui| {
                        ui.horizontal_wrapped(|ui| {
                            for action in &mv.actions {
                                let Some(label) = move_action_label(action) else { continue };
                                // Going on is the main way out; moving back is the other
                                let (kind, icon) = match action.as_str() {
                                    "move-back" => (ButtonKind::Secondary, icons::MOVE_BACK),
                                    "finish" => (ButtonKind::Primary, icons::CHECK),
                                    _ => (ButtonKind::Primary, icons::REFRESH),
                                };
                                if action_button(ui, kind, Some(icon), label, 32.0).clicked() {
                                    chosen = Some(action.clone());
                                }
                                ui.add_space(4.0);
                            }
                        });
                    });
                }
            });
        if let Some(action) = chosen {
            self.send_drive_command(WorkerCommand::DriveMove { action, from: mv.from.clone(), to: mv.to.clone() });
        }
    }

    /// Apps blocked from downloading online-only files: each with Unblock, and a name to block.
    fn render_blocked_apps_card(&mut self, ui: &mut egui::Ui) {
        let apps = self.status.settings.blocked_apps.clone();
        let mut asked: Option<Result<Vec<String>, String>> = None;
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("Apps blocked from downloading").size(16.0).strong().color(TEXT_PRIMARY()));
            ui.add_space(6.0);
            ui.add(
                egui::Label::new(
                    RichText::new("These apps can't download online-only files. Files they already have on this computer still open.")
                        .size(12.5)
                        .color(TEXT_MUTED()),
                )
                .wrap(),
            );
            ui.add_space(12.0);
            ui.add_enabled_ui(!self.blocklist_working, |ui| {
                if apps.is_empty() {
                    ui.label(RichText::new("No apps are blocked.").size(13.0).color(TEXT_MUTED()));
                }
                for app in &apps {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(app).size(13.5).monospace().color(TEXT_PRIMARY()));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let size = Vec2::new(button_width(ui, "Unblock"), 28.0);
                            let stroke = Some(Stroke::new(1.0_f32, BORDER_SUBTLE()));
                            if proton_button(ui, size, "Unblock", BG_CARD_ALT(), btn_secondary_hover_bg(), stroke, TEXT_PRIMARY(), 12.5)
                                .clicked()
                            {
                                asked = Some(Ok(without_blocked_app(&apps, app)));
                            }
                        });
                    });
                    ui.add_space(4.0);
                }
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    let button_w = button_width(ui, "Block");
                    let input_w = (ui.available_width() - button_w - 6.0 - ui.spacing().item_spacing.x).clamp(120.0, 320.0);
                    let field = ui.add_sized(
                        [input_w, 32.0],
                        egui::TextEdit::singleline(&mut self.block_app_input)
                            .hint_text("App name, e.g. rg")
                            .vertical_align(Align::Center),
                    );
                    let entered = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    ui.add_space(6.0);
                    let clicked = proton_button(ui, Vec2::new(button_w, 32.0), "Block", PROTON_PURPLE, PROTON_PURPLE_HOVER, None, Color32::WHITE, 13.0)
                        .clicked();
                    if (clicked || entered) && !self.block_app_input.trim().is_empty() {
                        asked = Some(with_blocked_app(&apps, &self.block_app_input));
                    }
                });
            });
            if let Some(error) = &self.blocklist_error {
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
            }
        });
        match asked {
            Some(Ok(list)) if !self.blocklist_working => {
                self.blocklist_error = None;
                self.blocklist_working = true;
                let _ = self.tx.send(WorkerCommand::SetBlockedApps(list));
            }
            Some(Err(problem)) => self.blocklist_error = Some(problem),
            _ => {}
        }
    }

    /// Sends the switch, Mount again or a move action; the drive's buttons wait until its answer arrives.
    fn send_drive_command(&mut self, cmd: WorkerCommand) {
        if self.drive_working {
            return;
        }
        self.drive_working = true;
        self.drive_error = None;
        let _ = self.tx.send(cmd);
    }

    /// Save Preferences: only the settings edited since they were loaded (see `settings_changes`).
    fn save_preferences(&mut self) {
        let changes = settings_changes(
            &self.loaded_settings,
            &self.edit_sync_dir,
            &self.edit_conflict_strategy,
            self.edit_notifications,
            self.edit_start_at_login,
            &self.ignore_patterns_text,
        );
        if changes.is_empty() {
            self.settings_dirty = false;
            self.settings_notice = Some(Notice::info("No changes to save."));
            return;
        }
        self.settings_saving = true;
        self.settings_notice = None;
        let _ = self.tx.send(WorkerCommand::SaveSettings(serde_json::Value::Object(changes)));
    }

    /// An edit in the Settings form: it is kept through status refreshes until saved.
    fn mark_settings_edited(&mut self) {
        self.settings_dirty = true;
        self.settings_notice = None;
    }

    fn render_sync_settings_card(&mut self, ui: &mut egui::Ui) {
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
                // The row is the field, a 6 px gap and the 92 px button, with item spacing after the field
                let input_w = (ui.available_width() - 6.0 - 92.0 - ui.spacing().item_spacing.x).max(240.0);
                if ui
                    .add_sized(
                        [input_w, 34.0],
                        egui::TextEdit::singleline(&mut self.edit_sync_dir)
                            .vertical_align(Align::Center),
                    )
                    .changed()
                {
                    self.mark_settings_edited();
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
                                self.mark_settings_edited();
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
                // Both versions are always kept (#91): at once, or once the user chose in Home's Needs attention
                .selected_text(match self.edit_conflict_strategy.as_str() {
                    "prompt" => "Ask me each time (in Home's Needs attention)",
                    _ => "Keep Both (Save conflict copy with timestamp)",
                })
                .width(360.0)
                .show_ui(ui, |ui| {
                    for (val, text) in [
                        ("keep-both", "Keep Both (Save conflict copy with timestamp)"),
                        ("prompt", "Ask me each time (in Home's Needs attention)"),
                    ] {
                        if ui
                            .selectable_value(
                                &mut self.edit_conflict_strategy,
                                val.to_string(),
                                text,
                            )
                            .changed()
                        {
                            self.mark_settings_edited();
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
                self.mark_settings_edited();
            }

            ui.add_space(10.0);
            if ui
                .checkbox(
                    &mut self.edit_start_at_login,
                    RichText::new("Start Proton Drive when I log in")
                        .size(13.5)
                        .color(TEXT_PRIMARY()),
                )
                .on_hover_text("Syncs and mounts the drive at login, with the tray icon, without opening this window")
                .changed()
            {
                self.mark_settings_edited();
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
                self.mark_settings_edited();
            }

            ui.add_space(18.0);
            let label = if self.settings_saving { "Saving…" } else { "Save Preferences" };
            let clicked = ui
                .add_enabled_ui(!self.settings_saving, |ui| {
                    proton_button(
                        ui,
                        Vec2::new(156.0, 36.0),
                        label,
                        PROTON_PURPLE,
                        PROTON_PURPLE_HOVER,
                        None,
                        Color32::WHITE,
                        13.5,
                    )
                    .clicked()
                })
                .inner;
            if clicked {
                self.save_preferences();
            }
            if let Some(notice) = &self.settings_notice {
                ui.add_space(8.0);
                let color = if notice.error { STATUS_DANGER } else { TEXT_MUTED() };
                ui.add(egui::Label::new(RichText::new(&notice.text).size(12.5).color(color)).wrap());
            }
        });
    }
}

impl ProtonDriveNativeApp {
    /// Opens the share window for the item at `abs_path` (an absolute path in the Proton Drive folder), as `--share`
    /// asks (#216).
    fn open_share(&mut self, abs_path: &str) {
        // The same item again: the window stays (what was typed in it too), and reads again if nothing was. One that
        // could only say why it can't share is opened afresh: what it showed as the path is only a likeness of one
        if self.share.as_ref().is_some_and(|w| w.abs_path == abs_path && w.may_share()) {
            self.share_again();
            return;
        }
        self.leave_share();
        self.share = Some(share::ShareWindow::new(abs_path));
        self.resolve_share();
    }

    /// Does what a start's `--share` asked, on a first start or from a later one: opens the Share window on the item,
    /// or, for a path that can't be shared, opens it saying why (#216).
    fn open_share_request(&mut self, request: single_instance::Request) {
        match request {
            single_instance::Request::Share(path) => self.open_share(&path),
            single_instance::Request::ShareRefused { shown, problem } => {
                self.leave_share();
                self.share = Some(share::ShareWindow::refused(&shown, problem));
            }
            single_instance::Request::Show(_) => {}
        }
    }

    /// Opened again from the tray or the launcher: bring this window back instead of a second one (#129), on the section
    /// it asked for, if any (#203).
    fn answer_show_request(&mut self, ctx: &egui::Context) {
        if !SHOW_REQUESTED.swap(false, AtomicOrdering::SeqCst) {
            return;
        }
        if let Some(tab) = SECTION_REQUESTED.lock().map(|mut s| s.take()).unwrap_or(None) {
            self.open_tab(tab);
        }
        if let Some(request) = SHARE_REQUESTED.lock().map(|mut s| s.take()).unwrap_or(None) {
            self.open_share_request(request);
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
    }
}

impl eframe::App for ProtonDriveNativeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.answer_show_request(ctx);
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
        }

        if ctx.input(|i| i.key_pressed(Key::F5)) {
            let _ = self.tx.send(WorkerCommand::RefreshAll);
        }

        self.render_ui(ctx);

        // Handle --screenshot <path> for automated visual inspection
        if let Some(target_path) = self.screenshot_target.clone() {
            let ready = self.frames_rendered >= 6;
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

/// The blocklist with one more app, as the daemon will take it (see problemWithBlockedApps): a process name of 1 to 15
/// bytes, trimmed, with no '/' or control characters. One already listed leaves the list as it is.
fn with_blocked_app(apps: &[String], name: &str) -> Result<Vec<String>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Type the name of an app to block.".into());
    }
    if name.len() > 15 {
        return Err(format!("\"{name}\" is too long: an app's process name has at most 15 bytes."));
    }
    if name.contains('/') || name.chars().any(char::is_control) {
        return Err(format!("\"{name}\" isn't the name of an app. Use its process name, as `ps` shows it."));
    }
    let mut next = apps.to_vec();
    if !next.iter().any(|a| a == name) {
        next.push(name.to_string());
    }
    Ok(next)
}

fn without_blocked_app(apps: &[String], name: &str) -> Vec<String> {
    apps.iter().filter(|a| *a != name).cloned().collect()
}

fn card_frame() -> Frame {
    Frame::NONE
        .fill(BG_CARD())
        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::same(18))
}

/// A layer over the whole window that takes every click meant for what is under it, so a click outside a menu or
/// dialog only closes it. `dim` paints it as a dialog backdrop; without it the layer is invisible.
fn click_shield(ctx: &egui::Context, id: &str, order: egui::Order, dim: Option<Color32>) {
    let screen = ctx.screen_rect();
    egui::Area::new(egui::Id::new(id))
        .order(order)
        .fixed_pos(screen.min)
        .default_size(screen.size())
        .sense(Sense::click())
        .show(ctx, |ui| {
            let (rect, _) = ui.allocate_exact_size(screen.size(), Sense::click());
            if let Some(color) = dim {
                ui.painter().rect_filled(rect, 0, color);
            }
        });
}

/// A button's room and background: `fill`, or `hover_fill` under the pointer, with radius 8 and the outline if any.
/// It is named `label` for screen readers (and `Harness::widget_at`), whatever it paints.
fn button_shell(
    ui: &mut egui::Ui,
    size: Vec2,
    label: &str,
    fill: Color32,
    hover_fill: Color32,
    stroke: Option<Stroke>,
) -> (egui::Rect, egui::Response) {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let enabled = ui.is_enabled();
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, label));
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let bg = if resp.hovered() { hover_fill } else { fill };
    ui.painter().rect_filled(rect, CornerRadius::same(8), bg);
    if let Some(s) = stroke {
        ui.painter()
            .rect_stroke(rect, CornerRadius::same(8), s, egui::StrokeKind::Inside);
    }
    (rect, resp)
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
    let (rect, resp) = button_shell(ui, size, label, fill, hover_fill, stroke);
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        label,
        FontId::new(font_size, FontFamily::Proportional),
        text_color,
    );
    resp
}

/// The room on each side of a button's label.
const BUTTON_PADDING: f32 = 16.0;

/// A button just wide enough for its label at 13 pt.
fn button_width(ui: &egui::Ui, label: &str) -> f32 {
    text_width(ui.painter(), label, &FontId::proportional(13.0)) + 2.0 * BUTTON_PADDING
}

/// The size of an icon on a button.
const BUTTON_ICON_SIZE: f32 = 16.0;
/// The room between a button's icon and its label.
const BUTTON_ICON_GAP: f32 = 6.0;

/// What a button with a label looks like (#276).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ButtonKind {
    /// Filled purple, white text: the one thing a card most likely wants done
    Primary,
    /// The card's colour with an outline, filled with the weak background on hover
    Secondary,
    /// Red, for a confirmation that deletes
    #[cfg_attr(not(test), expect(dead_code, reason = "the dialogs don't use action_button yet"))]
    Danger,
    /// A secondary button whose label is red: a choice that deletes, short of a confirmation
    DangerOutline,
}

/// A button as wide as its icon and label: the icon (one of `icons::*`) first, then the label, in `kind`'s colours.
/// The icon is painted as text of its own, so the label stays findable as painted text.
fn action_button(ui: &mut egui::Ui, kind: ButtonKind, icon: Option<&str>, label: &str, height: f32) -> egui::Response {
    let size = Vec2::new(action_button_width(ui, icon, label), height);
    action_button_sized(ui, kind, icon, label, size)
}

/// `action_button` at `size`, with its icon and label centred in it (as wide as the sidebar, say).
fn action_button_sized(ui: &mut egui::Ui, kind: ButtonKind, icon: Option<&str>, label: &str, size: Vec2) -> egui::Response {
    let (fill, hover_fill, stroke, text_color) = match kind {
        ButtonKind::Primary => (PROTON_PURPLE, PROTON_PURPLE_HOVER, None, Color32::WHITE),
        ButtonKind::Secondary => (BG_CARD(), BG_CARD_ALT(), Some(Stroke::new(1.0_f32, BORDER_NORM())), TEXT_PRIMARY()),
        ButtonKind::Danger => (STATUS_DANGER, STATUS_DANGER_HOVER, None, Color32::WHITE),
        ButtonKind::DangerOutline => (BG_CARD(), BG_CARD_ALT(), Some(Stroke::new(1.0_f32, BORDER_NORM())), STATUS_DANGER),
    };
    let (rect, resp) = button_shell(ui, size, label, fill, hover_fill, stroke);
    let content = action_button_width(ui, icon, label) - 2.0 * BUTTON_PADDING;
    let mut x = rect.center().x - content / 2.0;
    if let Some(icon) = icon {
        let icon_font = icons::font(BUTTON_ICON_SIZE);
        let at = egui::pos2(x, rect.center().y);
        ui.painter().text(at, egui::Align2::LEFT_CENTER, icon, icon_font.clone(), text_color);
        x += text_width(ui.painter(), icon, &icon_font) + BUTTON_ICON_GAP;
    }
    let font = FontId::proportional(13.0);
    ui.painter().text(egui::pos2(x, rect.center().y), egui::Align2::LEFT_CENTER, label, font, text_color);
    resp
}

/// How wide `action_button` makes a button with this icon and label.
fn action_button_width(ui: &egui::Ui, icon: Option<&str>, label: &str) -> f32 {
    let icon_room = icon.map_or(0.0, |icon| {
        text_width(ui.painter(), icon, &icons::font(BUTTON_ICON_SIZE)) + BUTTON_ICON_GAP
    });
    button_width(ui, label) + icon_room
}

/// The width and height of an icon-only button.
const ICON_BUTTON_SIZE: f32 = 28.0;

/// An icon-only button, 28×28, with no fill until hovered. `label`, what a button with words would have said, is its
/// tooltip and its name for screen readers.
fn icon_button(ui: &mut egui::Ui, icon: &str, label: &str) -> egui::Response {
    icon_button_drawn(ui, icon, label, None, TEXT_PRIMARY())
}

/// `icon_button` with its icon in `color`: a list row's actions, weak until their row is hovered.
fn icon_button_colored(ui: &mut egui::Ui, icon: &str, label: &str, color: Color32) -> egui::Response {
    icon_button_drawn(ui, icon, label, None, color)
}

/// `icon_button`, filled with the soft purple while `pressed`: the top bar's gear while Settings is open. Unlike the
/// others, it is a toggle for screen readers.
fn icon_button_pressed(ui: &mut egui::Ui, icon: &str, label: &str, pressed: bool) -> egui::Response {
    icon_button_drawn(ui, icon, label, Some(pressed), if pressed { PROTON_PURPLE_TEXT() } else { TEXT_PRIMARY() })
}

/// An icon-only button; `pressed` is None for a plain push button, or whether a toggle is on.
fn icon_button_drawn(ui: &mut egui::Ui, icon: &str, label: &str, pressed: Option<bool>, color: Color32) -> egui::Response {
    let (fill, hover_fill) =
        if pressed == Some(true) { (PROTON_PURPLE_SOFT(), PROTON_PURPLE_SOFT()) } else { (Color32::TRANSPARENT, BG_CARD_ALT()) };
    let (rect, resp) = button_shell(ui, Vec2::splat(ICON_BUTTON_SIZE), label, fill, hover_fill, None);
    // A toggle says whether it is pressed, as the sections say whether they are open; a push button only its name
    // (egui marks any `selected` widget a toggle, pressed or not)
    let enabled = ui.is_enabled();
    resp.widget_info(|| match pressed {
        Some(pressed) => egui::WidgetInfo::selected(egui::WidgetType::Button, enabled, pressed, label),
        None => egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, label),
    });
    ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, icon, icons::font(BUTTON_ICON_SIZE), color);
    // With no words of its own, it says what it is even while it waits (greyed out)
    resp.on_hover_text(label).on_disabled_hover_text(label)
}

/// An on/off switch; the caller flips the state when it is clicked.
fn toggle_switch(ui: &mut egui::Ui, on: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(40.0, 22.0), Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let radius = rect.height() / 2.0;
    let track = match (on, is_light_mode()) {
        (true, _) if resp.hovered() => PROTON_PURPLE_HOVER,
        (true, _) => PROTON_PURPLE,
        (false, true) => Color32::from_rgb(200, 195, 218),
        (false, false) => Color32::from_rgb(74, 67, 96),
    };
    ui.painter().rect_filled(rect, CornerRadius::same(radius as u8), track);
    let knob_x = if on { rect.right() - radius } else { rect.left() + radius };
    ui.painter().circle_filled(egui::pos2(knob_x, rect.center().y), radius - 3.0, Color32::WHITE);
    resp
}

/// Room for about five 38px activity rows.
const ACTIVITY_TABLE_MIN_HEIGHT: f32 = 200.0;
/// How many activity entries the app asks for (the daemon keeps 500), and lists: enough that the filter finds older
/// problems too, not only among the latest few (#94)
const ACTIVITY_FETCHED: usize = 200;
const ACTIVITY_SHOWN: usize = 200;
/// About the width of the Activity filter (All, Uploads, Downloads, Problems), kept free beside the search
const ACTIVITY_SEARCH_WIDTH: f32 = 260.0;

/// The family bold text is laid out in: Inter SemiBold (#279).
const BOLD_FAMILY: &str = "bold";

/// The font for bold text at `size` points: titles, the brand, the open section. egui's `RichText::strong` only picks
/// the strong text colour, and only where no colour is set, so text meant to be bold says so with this font.
pub(crate) fn bold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name(BOLD_FAMILY.into()))
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
    // Bold text: Inter SemiBold, then whatever the proportional family falls back to (#279)
    let mut bold_fonts = vec!["InterSemiBold".to_owned()];
    bold_fonts.extend(fonts.families.get(&egui::FontFamily::Proportional).cloned().unwrap_or_default());
    fonts.families.insert(FontFamily::Name(BOLD_FAMILY.into()), bold_fonts);
    // The icons, in a family of their own (see icons.rs)
    icons::add_to_fonts(&mut fonts);
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
    // Links in Proton's purple, not egui's blue; in the dark, its light purple, which reads at 4.5:1 there (R14)
    visuals.hyperlink_color = if light { PROTON_PURPLE } else { DARK.purple_text };
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

/// The logo the sidebar shows: the folder mark alone, without the app icon's tile (#273). Rendered once from
/// assets/app-icon/protondrive-mark.svg, at 128 px. To regenerate it:
/// `resvg -w 128 -h 128 assets/app-icon/protondrive-mark.svg assets/app-icon/protondrive-mark-128.png`
const LOGO_PNG: &[u8] = include_bytes!("../../assets/app-icon/protondrive-mark-128.png");

fn load_logo_texture(ctx: &egui::Context) -> Option<TextureHandle> {
    let img = image::load_from_memory(LOGO_PNG).ok()?.to_rgba8();
    let size = [img.width() as usize, img.height() as usize];
    let color_img = egui::ColorImage::from_rgba_unmultiplied(size, img.as_raw());
    Some(ctx.load_texture("proton_drive_logo", color_img, TextureOptions::LINEAR))
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

/// An Activity row's identity, to keep it open across refreshes: the daemon's id, or without one what it says
/// A filter chip's fill and label: white on Proton's purple when selected, else the quiet input colours.
fn chip_colors(p: &Palette, selected: bool) -> (Color32, Color32) {
    if selected {
        (PROTON_PURPLE, Color32::WHITE)
    } else {
        (p.input, p.text_weak)
    }
}

/// A filter chip: a pill that fits its label. Returns whether it was clicked.
fn filter_chip(ui: &mut egui::Ui, label: &str, selected: bool) -> bool {
    let font = FontId::new(12.5, FontFamily::Proportional);
    let width = text_width(ui.painter(), label, &font) + 24.0;
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 28.0), Sense::click());
    let (fill, text) = chip_colors(palette(), selected);
    ui.painter().rect_filled(rect, CornerRadius::same(14), fill);
    ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, label, font, text);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

/// The search field: a rounded input with a magnifier on its left, outlined in purple only while it has focus.
fn search_field(ui: &mut egui::Ui, text: &mut String, hint: &str, width: f32) {
    let id = egui::Id::new("activity_search");
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 32.0), Sense::hover());
    let focused = ui.memory(|m| m.has_focus(id));
    let stroke = if focused { Stroke::new(1.0_f32, PROTON_PURPLE) } else { Stroke::NONE };
    ui.painter().rect(rect, CornerRadius::same(8), BG_INPUT(), stroke, egui::StrokeKind::Inside);
    ui.painter().text(
        egui::pos2(rect.min.x + 10.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        icons::SEARCH,
        icons::font(16.0),
        TEXT_MUTED(),
    );
    let edit_rect = egui::Rect::from_min_max(egui::pos2(rect.min.x + 34.0, rect.min.y), egui::pos2(rect.max.x - 8.0, rect.max.y));
    // A child of the field's own box, so the row's spacing after it stays what the row says
    let mut inner = ui.new_child(egui::UiBuilder::new().max_rect(edit_rect));
    inner.add_sized(
        edit_rect.size(),
        egui::TextEdit::singleline(text).id(id).hint_text(hint).frame(false).vertical_align(Align::Center),
    );
}

fn activity_key(act: &ActivityRecord) -> String {
    match act.id {
        Some(id) => format!("#{id}"),
        None => format!("{}\u{0}{}\u{0}{}\u{0}{}", act.timestamp, act.action, act.local_rel_path, act.details),
    }
}

/// The opened Activity row
#[derive(Clone, Debug, PartialEq)]
struct ExpandedActivity {
    key: String,
    show: Option<std::path::PathBuf>,
    open: Option<std::path::PathBuf>,
}

/// An Activity pill's fill and text colours, by what the entry is
fn activity_pill_colors(kind: activity::ActivityKind) -> (Color32, Color32) {
    use activity::ActivityKind::*;
    match kind {
        Downloaded => (Color32::from_rgba_unmultiplied(30, 168, 133, 34), STATUS_SUCCESS),
        Uploaded => (Color32::from_rgba_unmultiplied(109, 74, 255, 42), PROTON_PURPLE_TEXT()),
        FreedUp | Hidden => (Color32::from_rgba_unmultiplied(109, 74, 255, 26), PROTON_PURPLE_TEXT()),
        Shared => (Color32::from_rgba_unmultiplied(109, 74, 255, 26), PROTON_PURPLE_TEXT()),
        FolderCreated | Other => (BG_CARD_ALT(), TEXT_PRIMARY()),
        RemovedLocally => (BG_CARD_ALT(), TEXT_MUTED()),
        MovedToCloudTrash => (Color32::from_rgba_unmultiplied(245, 158, 11, 34), STATUS_WARNING),
        Conflict | Failed => (Color32::from_rgba_unmultiplied(239, 68, 68, 38), STATUS_DANGER),
    }
}

/// A small cloud, centred at `c`, as the drive's online-only icon draws it
fn draw_cloud_icon(painter: &egui::Painter, c: egui::Pos2, color: Color32) {
    painter.circle_filled(c + Vec2::new(-3.0, 1.5), 2.6, color);
    painter.circle_filled(c + Vec2::new(0.5, -0.8), 3.4, color);
    painter.circle_filled(c + Vec2::new(3.6, 1.6), 2.4, color);
    painter.rect_filled(
        egui::Rect::from_min_max(c + Vec2::new(-3.0, 1.2), c + Vec2::new(3.6, 4.0)),
        CornerRadius::ZERO,
        color,
    );
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
/// `s` cut at its end to fit `max_width`, with an ellipsis: for a phrase, which reads from its start.
fn truncate_end_to_width(painter: &egui::Painter, s: &str, font: &FontId, max_width: f32) -> String {
    if max_width <= 0.0 {
        return String::new();
    }
    if text_width(painter, s, font) <= max_width {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let cut = |n: usize| chars[..n].iter().collect::<String>().trim_end().to_string() + "…";
    // Binary search for the longest start that still fits with its ellipsis
    let (mut lo, mut hi) = (0, chars.len() - 1);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if text_width(painter, &cut(mid), font) <= max_width {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let out = cut(lo);
    if text_width(painter, &out, font) <= max_width { out } else { String::new() }
}

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
    // A screenshot only looks at a daemon that is running; it never starts one
    if SCREENSHOT_MODE.load(Ordering::SeqCst) || TRIED.swap(true, Ordering::SeqCst) {
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
        if SCREENSHOT_MODE.load(AtomicOrdering::SeqCst) && !allowed_in_screenshot_mode(&cmd) {
            continue;
        }
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
                let _ = ureq::post(&format!("{}/api/sync", daemon_url())).call();
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(fetch_status()),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            WorkerCommand::SetPaused { paused, until } => {
                let _ = ureq::post(&format!("{}/api/pause", daemon_url())).send_json(pause_request(paused, until));
                let _ = tx.send(WorkerEvent::StatusAndActivity {
                    status: Box::new(fetch_status()),
                    activity: fetch_activity(),
                });
                ctx.request_repaint();
            }
            // The writes below go over the user-only control socket, off this thread: they can take minutes (a move of
            // every file), and the status polls must go on meanwhile. The app refreshes once their event arrives.
            WorkerCommand::StartLogin => off_thread(&tx, &ctx, || WorkerEvent::LoginStarted(sign_in_at(&control_socket_path()))),
            WorkerCommand::Logout => off_thread(&tx, &ctx, || WorkerEvent::LoggedOut(sign_out_at(&control_socket_path()))),
            WorkerCommand::SaveSettings(changes) => off_thread(&tx, &ctx, move || {
                WorkerEvent::SettingsSaved(save_settings_at(&control_socket_path(), &changes))
            }),
            WorkerCommand::SetVirtualDrive(on) => off_thread(&tx, &ctx, move || {
                let change = serde_json::json!({ "virtualDriveWanted": on });
                WorkerEvent::VirtualDriveSwitched(save_settings_at(&control_socket_path(), &change))
            }),
            WorkerCommand::SetBlockedApps(apps) => off_thread(&tx, &ctx, move || {
                let change = serde_json::json!({ "blockedApps": apps });
                WorkerEvent::BlockedAppsSaved(save_settings_at(&control_socket_path(), &change))
            }),
            WorkerCommand::MountAgain => off_thread(&tx, &ctx, || WorkerEvent::DriveDone(mount_again_at(&control_socket_path()))),
            WorkerCommand::DriveMove { action, from, to } => off_thread(&tx, &ctx, move || {
                WorkerEvent::DriveDone(drive_move_at(&control_socket_path(), &action, &from, &to))
            }),
            WorkerCommand::SetAvailability { path, action } => {
                // Off-thread: Free and Hide can take a while on big folders
                let tx_clone = tx.clone();
                let ctx_clone = ctx.clone();
                thread::spawn(move || {
                    let _ = tx_clone.send(WorkerEvent::AvailabilityDone { result: set_availability(&path, &action), path });
                    ctx_clone.request_repaint();
                });
            }
            WorkerCommand::LoadHidden => {
                off_thread(&tx, &ctx, || WorkerEvent::HiddenLoaded(hidden_items_at(&control_socket_path())))
            }
            WorkerCommand::LoadConflicts => {
                if let Ok(resp) = ureq::get(&format!("{}/api/conflicts", daemon_url())).call() {
                    if let Ok(list) = resp.into_json::<Vec<ConflictRecord>>() {
                        let _ = tx.send(WorkerEvent::ConflictsLoaded(list));
                        ctx.request_repaint();
                    }
                }
            }
            WorkerCommand::ResolveConflict { id, choice } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ConflictResolved(resolve_conflict_at(&control_socket_path(), id, &choice))
            }),
            WorkerCommand::ResolveFilesMissing { choice, root, names } => off_thread(&tx, &ctx, move || {
                WorkerEvent::FilesMissingDone(files_missing_resolve_at(&control_socket_path(), choice, &root, &names))
            }),
            WorkerCommand::StartFresh => {
                off_thread(&tx, &ctx, move || WorkerEvent::StartFreshDone(start_fresh_at(&control_socket_path())))
            }
            // The Share window's requests reach Proton's servers through the daemon: each runs on its own thread
            WorkerCommand::SharedLoad { seq } => {
                off_thread(&tx, &ctx, move || WorkerEvent::SharedLoaded(seq, share::list_at(&control_socket_path())))
            }
            WorkerCommand::SharedStop { rel_path, uid } => off_thread(&tx, &ctx, move || {
                let result = share::stop_sharing_at(&control_socket_path(), &rel_path, &uid);
                WorkerEvent::SharedStopped(rel_path, result)
            }),
            WorkerCommand::ShareLoad { window, rel_path } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareLoaded(window, share::info_at(&control_socket_path(), &rel_path))
            }),
            WorkerCommand::SharePassword { window, rel_path } => off_thread(&tx, &ctx, move || {
                WorkerEvent::SharePassword(window, share::password_at(&control_socket_path(), &rel_path))
            }),
            WorkerCommand::ShareEnsureLink { window, rel_path } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareDone(window, share::ensure_link_at(&control_socket_path(), &rel_path))
            }),
            WorkerCommand::ShareSettings { window, rel_path, password, expires_at } => off_thread(&tx, &ctx, move || {
                let result = share::settings_at(&control_socket_path(), &rel_path, password.as_ref().map(|p| p.as_deref()), expires_at);
                WorkerEvent::ShareDone(window, result)
            }),
            WorkerCommand::ShareRemoveLink { window, rel_path } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareDone(window, share::remove_link_at(&control_socket_path(), &rel_path))
            }),
            WorkerCommand::ShareInvite { window, rel_path, emails, role } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareDone(window, share::invite_at(&control_socket_path(), &rel_path, &emails, role))
            }),
            WorkerCommand::ShareRole { window, rel_path, email, role } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareDone(window, share::role_at(&control_socket_path(), &rel_path, &email, role))
            }),
            WorkerCommand::ShareRemovePerson { window, rel_path, email } => off_thread(&tx, &ctx, move || {
                WorkerEvent::ShareDone(window, share::remove_person_at(&control_socket_path(), &rel_path, &email))
            }),
        }
    }
}

/// Runs `work` on its own thread and hands its event to the app.
fn off_thread(tx: &Sender<WorkerEvent>, ctx: &egui::Context, work: impl FnOnce() -> WorkerEvent + Send + 'static) {
    let (tx, ctx) = (tx.clone(), ctx.clone());
    thread::spawn(move || {
        let _ = tx.send(work());
        ctx.request_repaint();
    });
}

fn fetch_status() -> Result<DaemonStatus, String> {
    ureq::get(&format!("{}/api/status", daemon_url()))
        .timeout(Duration::from_millis(1200))
        .call()
        .map_err(|e| e.to_string())
        .and_then(|r| r.into_json::<DaemonStatus>().map_err(|e| e.to_string()))
}

fn fetch_activity() -> Vec<ActivityRecord> {
    ureq::get(&format!("{}/api/activity?limit={ACTIVITY_FETCHED}", daemon_url()))
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
  --tab <TAB>           initial section (home | shared | activity | settings)
  --screenshot <PATH>   render UI, save a PNG screenshot to PATH, and exit
  --search <QUERY>      pre-fill the activity search
  --share <PATH>        open the share window for the item at the absolute PATH (in a running app too)
  --confirm-free-all    with --screenshot: show the Free up space confirmation (for the whole drive)
  --drive-status <S>    with --screenshot: show the virtual drive as S (mounted | ejected | plain | crashed | busy |
                        starting | moving | move-failed | different-disk | fuse-unavailable)
  --drive-move <KIND>   with --screenshot: add a move that stopped (relocation | layout)
  --drive-error <TEXT>  with --screenshot: show TEXT as the refusal of a drive request
  --confirm-drive-off   with --screenshot: show the confirmation for switching the virtual drive off
  --files-missing       with --screenshot: show the daemon holding with the files missing from the folder
  --confirm-files-missing  with --screenshot: also show the confirmation for deleting them from Proton Drive too
  --login-error <TEXT>  with --screenshot: show TEXT as a failed sign-in
  --hidden-items        with --screenshot: list two items as hidden from this computer in Settings
  --fake-attention <N>  with --screenshot: list N conflicts (and two failed items) under Needs attention on Home
  --fake-transfers <N>  with --screenshot: show N uploads in progress on Home
  --signed-out          with --screenshot: show the daemon without an account
  --account-mismatch    with --screenshot: show the daemon holding the records of another Proton account
  --paused-until-min <N>  with --screenshot: show sync paused until N minutes from now (0: until resumed)
  --pause-choices       with --screenshot: show Home's Pause choices open
  --account-menu        with --screenshot: show the top bar's account menu open
  --fake-share <S>      with --screenshot: show the Share window (for --share's item, else Docs/report.pdf in the
                        drive) as S (none | link | link-password | link-expired | people)
  --confirm-stop-sharing <NAME>  with --screenshot and --fake-shared list: show the Stop sharing confirmation for that row
  --fake-shared <S>     with --screenshot: show the Shared section (--tab shared) as S (list | empty | offline)
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
    let mut initial_tab = NavTab::Home;
    let mut cli_tab: Option<String> = None;
    let mut cli_share: Option<std::ffi::OsString> = None;
    let mut cli_theme_override: Option<String> = None;
    let mut cli_search: Option<String> = None;
    let mut cli_size: Option<[f32; 2]> = None;
    let mut cli_confirm_free_all = false;
    let mut cli_drive_status: Option<String> = None;
    let mut cli_drive_move: Option<String> = None;
    let mut cli_drive_error: Option<String> = None;
    let mut cli_confirm_drive_off = false;
    let mut cli_files_missing = false;
    let mut cli_confirm_files_missing = false;
    let mut cli_login_error: Option<String> = None;
    let mut cli_hidden_items = false;
    let mut cli_fake_attention: Option<usize> = None;
    let mut cli_fake_transfers: Option<usize> = None;
    let mut cli_signed_out = false;
    let mut cli_account_mismatch = false;
    let mut cli_paused_until_min: Option<i64> = None;
    let mut cli_pause_choices = false;
    let mut cli_account_menu = false;
    let mut cli_fake_share: Option<String> = None;
    let mut cli_fake_shared: Option<String> = None;
    let mut cli_confirm_stop_sharing: Option<String> = None;
    // The arguments as the system gives them: one that isn't UTF-8 (a file's name can be anything) mustn't stop the app
    // (#216). --share's path is kept as it is; every other value is read as text, as near as it can be
    let text = |arg: Option<std::ffi::OsString>| arg.map(|a| a.to_string_lossy().into_owned());
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str().unwrap_or_default() {
            "--screenshot" => {
                screenshot_target = text(args.next());
            }
            "--confirm-free-all" => {
                cli_confirm_free_all = true;
            }
            "--drive-status" => {
                cli_drive_status = text(args.next());
            }
            "--drive-move" => {
                cli_drive_move = text(args.next());
            }
            "--drive-error" => {
                cli_drive_error = text(args.next());
            }
            "--confirm-drive-off" => {
                cli_confirm_drive_off = true;
            }
            "--files-missing" => {
                cli_files_missing = true;
            }
            "--confirm-files-missing" => {
                cli_files_missing = true;
                cli_confirm_files_missing = true;
            }
            "--confirm-stop-sharing" => {
                cli_confirm_stop_sharing = text(args.next());
            }
            "--fake-attention" => {
                cli_fake_attention = text(args.next()).and_then(|v| v.parse().ok());
            }
            "--fake-transfers" => {
                cli_fake_transfers = text(args.next()).and_then(|v| v.parse().ok());
            }
            "--signed-out" => {
                cli_signed_out = true;
            }
            "--account-mismatch" => {
                cli_account_mismatch = true;
            }
            "--paused-until-min" => {
                cli_paused_until_min = text(args.next()).and_then(|v| v.parse().ok()).filter(|m: &i64| *m >= 0);
            }
            "--pause-choices" => {
                cli_pause_choices = true;
            }
            "--account-menu" => {
                cli_account_menu = true;
            }
            "--fake-share" => {
                cli_fake_share = text(args.next());
            }
            "--fake-shared" => {
                cli_fake_shared = text(args.next());
            }
            "--hidden-items" => {
                cli_hidden_items = true;
            }
            "--login-error" => {
                cli_login_error = text(args.next());
            }
            "--theme" => {
                cli_theme_override = text(args.next());
            }
            "--size" => {
                let raw = text(args.next()).unwrap_or_default();
                cli_size = parse_window_size(&raw);
                if cli_size.is_none() {
                    eprintln!("protondrive-gui: ignoring invalid --size {raw:?} (expected WxH, e.g. 1280x800)");
                }
            }
            "--search" => {
                cli_search = text(args.next());
            }
            "--share" => {
                cli_share = args.next();
            }
            "--tab" => {
                if let Some(t) = text(args.next()) {
                    initial_tab = parse_tab(&t);
                    cli_tab = Some(t);
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

    // Before any thread starts: a screenshot only reads (see allowed_in_screenshot_mode and control_request_at)
    SCREENSHOT_MODE.store(screenshot_target.is_some(), AtomicOrdering::SeqCst);

    if screenshot_target.is_none()
        && (cli_fake_attention.is_some()
            || cli_fake_transfers.is_some()
            || cli_signed_out
            || cli_account_mismatch
            || cli_paused_until_min.is_some()
            || cli_pause_choices
            || cli_account_menu
            || cli_fake_share.is_some()
            || cli_fake_shared.is_some()
            || cli_confirm_stop_sharing.is_some())
    {
        eprintln!(
            "protondrive-gui: --fake-attention, --fake-transfers, --signed-out, --account-mismatch, --paused-until-min, --pause-choices, --account-menu, --fake-share, --fake-shared and --confirm-stop-sharing only apply together with --screenshot; ignoring them"
        );
    }
    let fake_share = match cli_fake_share {
        Some(state) if screenshot_target.is_some() => {
            let info = share::fake_share_info(&state, home::now_ms(), home::local_offset_secs);
            if info.is_none() {
                eprintln!("protondrive-gui: ignoring unknown --fake-share {state:?} (none | link | link-password | link-expired | people)");
            }
            info
        }
        _ => None,
    };
    if screenshot_target.is_some() && initial_tab != NavTab::Shared && (cli_fake_shared.is_some() || cli_confirm_stop_sharing.is_some()) {
        eprintln!("protondrive-gui: --fake-shared and --confirm-stop-sharing only show with --tab shared; ignoring them");
        cli_confirm_stop_sharing = None;
    }
    let fake_shared = match cli_fake_shared {
        Some(state) if screenshot_target.is_some() => {
            let list = shared::fake_shared(&state, home::now_ms());
            if list.is_none() {
                eprintln!("protondrive-gui: ignoring unknown --fake-shared {state:?} (list | empty | offline)");
            }
            list
        }
        _ => None,
    };
    let fake_drive = if cli_drive_status.is_some() || cli_drive_move.is_some() {
        // A move alone is shown as the move that failed
        let name = cli_drive_status.unwrap_or_else(|| "move-failed".to_string());
        if screenshot_target.is_none() {
            eprintln!("protondrive-gui: --drive-status and --drive-move only apply together with --screenshot; ignoring them");
            None
        } else if fake_drive_status(&name, cli_drive_move.as_deref(), "", "").is_none() {
            eprintln!("protondrive-gui: ignoring unknown --drive-status {name:?} or --drive-move {cli_drive_move:?}");
            None
        } else {
            Some((name, cli_drive_move))
        }
    } else {
        None
    };

    // What --share asks: the item, or, for a path that can't be shared, to say why (in the window, never nothing)
    let share_request = cli_share.as_deref().map(single_instance::share_request);

    // One app window per user (#129): a second start shows the running window and exits. A screenshot runs beside it
    let mut _instance_lock: Option<std::fs::File> = None;
    if screenshot_target.is_none() {
        let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty());
        let in_runtime_dir = runtime_dir.is_some();
        // A later start that names an item shares it (or says why it can't); one that doesn't shows the window
        let request = share_request.clone().unwrap_or_else(|| single_instance::Request::Show(cli_tab.clone()));
        let paths = single_instance::instance_paths(runtime_dir, node_tmpdir(|name| std::env::var_os(name)), own_uid());
        match single_instance::claim(&paths, own_uid(), in_runtime_dir, Duration::from_secs(5), &request) {
            Ok(single_instance::Claim::Signalled) => return Ok(()),
            Ok(single_instance::Claim::Primary { lock, listener }) => {
                _instance_lock = Some(lock);
                thread::spawn(move || {
                    single_instance::serve(listener, |request| {
                        match request {
                            single_instance::Request::Show(section) => {
                                if let Ok(mut requested) = SECTION_REQUESTED.lock() {
                                    *requested = section.as_deref().map(parse_tab);
                                }
                            }
                            share @ (single_instance::Request::Share(_) | single_instance::Request::ShareRefused { .. }) => {
                                if let Ok(mut requested) = SHARE_REQUESTED.lock() {
                                    *requested = Some(share);
                                }
                            }
                        }
                        SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
                        if let Some(ctx) = APP_CONTEXT.get() {
                            ctx.request_repaint();
                        }
                    })
                });
            }
            Err(e) => eprintln!("protondrive-gui: couldn't check for a running app window ({e}); starting anyway"),
        }
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
            let _ = APP_CONTEXT.set(cc.egui_ctx.clone());
            let mut app = ProtonDriveNativeApp::new(
                cc,
                screenshot_target,
                initial_tab,
                saved_geom,
            );
            if let Some(q) = cli_search {
                app.search_query = q;
            }
            if let Some(request) = share_request {
                app.open_share_request(request);
            }
            // Screenshot-only: these flags only draw the dialogs, nothing is sent
            if app.screenshot_target.is_some() {
                if cli_confirm_free_all {
                    // Free up space for the whole drive, as Home offers it
                    app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
                } else if cli_confirm_drive_off {
                    app.pending_confirm = Some(PendingConfirm::VirtualDriveOff);
                }
                app.fake_drive = fake_drive;
                app.fake_files_missing = cli_files_missing;
                app.fake_attention = cli_fake_attention;
                app.fake_transfers = cli_fake_transfers;
                app.fake_signed_out = cli_signed_out;
                app.fake_account_mismatch = cli_account_mismatch;
                // Epoch ms from the minutes asked for (0: paused until resumed)
                app.fake_paused_until = cli_paused_until_min.map(|min| if min > 0 { home::now_ms() + min * 60_000 } else { 0 });
                app.pause_choices_open = cli_pause_choices;
                app.account_menu_open = cli_account_menu;
                let mut status = std::mem::take(&mut app.status);
                app.apply_fake_drive(&mut status);
                app.apply_fake_files_missing(&mut status);
                app.apply_fake_transfers(&mut status);
                app.apply_fake_signed_out(&mut status);
                app.apply_fake_account_mismatch(&mut status);
                app.apply_fake_paused(&mut status);
                app.status = status;
                app.refresh_attention();
                if cli_confirm_files_missing {
                    if let Some(fm) = &app.status.files_missing {
                        app.pending_confirm =
                            Some(PendingConfirm::DeleteMissing { root: fm.root.clone(), names: fm.names.clone(), items: fm.items });
                    }
                }
                app.drive_error = cli_drive_error;
                if cli_hidden_items {
                    let item = |path: &str, state: &str| HiddenItem { path: path.into(), state: state.into() };
                    app.hidden = Some(Ok(vec![item("Archive/2019 taxes", "hidden"), item("Docs/Private", "hiding")]));
                } else {
                    // The worker doesn't read the list in a screenshot: show it empty rather than loading forever
                    app.hidden = Some(Ok(Vec::new()));
                }
                if let Some(error) = cli_login_error {
                    app.show_account_error(format!("Couldn't start signing in: {error}"));
                }
                if app.tab == NavTab::Shared {
                    // The worker doesn't read the list in a screenshot: show the fake one, or an empty one, rather than
                    // loading forever
                    let seq = app.shared.seq;
                    app.shared.loaded(seq, fake_shared.unwrap_or_else(|| Ok(Vec::new())));
                    if let (Some(name), Some(items)) = (&cli_confirm_stop_sharing, &app.shared.items) {
                        app.pending_confirm = items.iter().find(|i| &i.name == name && i.unreadable.is_none()).and_then(|i| {
                            Some(PendingConfirm::StopSharing { rel_path: i.rel_path.clone()?, uid: i.uid.clone(), question: shared::stop_question(i, home::now_ms()) })
                        });
                    }
                }
                if let Some(info) = fake_share {
                    // The item --share names, or one in the drive (as the startup cache knows it)
                    if app.share.is_none() {
                        let drive = match app.status.sync_dir.as_str() {
                            "" => format!("{}/ProtonDrive", std::env::var("HOME").unwrap_or_default().trim_end_matches('/')),
                            dir => dir.trim_end_matches('/').to_string(),
                        };
                        app.open_share(&format!("{drive}/Docs/report.pdf"));
                    }
                    let sync_dir = app.status.sync_dir.clone();
                    if let Some(w) = app.share.as_mut() {
                        w.fake(info, &sync_dir);
                    }
                }
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

    // R13: a phrase is cut at its end, so it still reads from its start
    #[test]
    fn truncate_end_to_width_cuts_a_phrase_at_its_end() {
        with_painter(|p| {
            let font = FontId::proportional(13.0);
            assert_eq!(truncate_end_to_width(p, "(top level)", &font, 500.0), "(top level)", "it fits");
            let phrase = "Proton Drive is still catching up with this item: refresh in a moment";
            for max_width in [60.0, 150.0, 300.0] {
                let out = truncate_end_to_width(p, phrase, &font, max_width);
                assert!(text_width(p, &out, &font) <= max_width, "{out:?} wider than {max_width}");
                assert!(out.ends_with('…') && phrase.starts_with(out.trim_end_matches('…')), "{out:?}");
                // the longest that fits: one more letter (past the space the cut leaves out) doesn't
                let kept = out.trim_end_matches('…');
                let (at, next) = phrase[kept.len()..].char_indices().find(|(_, c)| !c.is_whitespace()).unwrap();
                let longer = format!("{}…", &phrase[..kept.len() + at + next.len_utf8()]);
                assert!(text_width(p, &longer, &font) > max_width, "{longer:?} would have fitted {max_width}");
            }
            assert_eq!(truncate_end_to_width(p, "Hidden from this computer", &font, 0.0), "", "no room");
            assert_eq!(truncate_end_to_width(p, "Hidden from this computer", &font, -5.0), "");
            let out = truncate_end_to_width(p, "日本語のとても長い説明の文です", &font, 60.0);
            assert!(out.starts_with('日') && out.ends_with('…') && text_width(p, &out, &font) <= 60.0, "{out:?}");
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
    fn with_no_saved_geometry_the_window_opens_at_900_by_640() {
        let g = WindowGeometry::default();
        assert_eq!((g.width, g.height, g.maximized, g.position), (900.0, 640.0, false, None));
    }

    #[test]
    fn parse_tab_maps_old_and_new_names() {
        assert_eq!(parse_tab("home"), NavTab::Home);
        assert_eq!(parse_tab("activity"), NavTab::Activity);
        assert_eq!(parse_tab("settings"), NavTab::Settings);
        assert_eq!(parse_tab("shared"), NavTab::Shared);
        // The old Sync Activity tab is Activity now
        assert_eq!(parse_tab("overview"), NavTab::Activity);
        // My files and Conflicts are gone: what they showed lives on Home
        for old in ["browser", "cloud", "files", "selective", "conflicts"] {
            assert_eq!(parse_tab(old), NavTab::Home, "{old}");
        }
        assert_eq!(parse_tab("nonsense"), NavTab::Home);
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
    fn control_socket_path_honours_xdg_runtime_dir_and_falls_back_to_tmp() {
        let tmp = std::path::PathBuf::from("/tmp");
        assert_eq!(
            control_socket_path_from(Some("/run/user/1000".into()), tmp.clone(), 1000),
            std::path::PathBuf::from("/run/user/1000/protondrive/control.sock")
        );
        for unset in [None, Some(std::ffi::OsString::new())] {
            assert_eq!(
                control_socket_path_from(unset, tmp.clone(), 1000),
                std::path::PathBuf::from("/tmp/protondrive-1000/control.sock")
            );
        }
        std::env::set_var("XDG_RUNTIME_DIR", "/run/user/4242");
        assert_eq!(control_socket_path(), std::path::PathBuf::from("/run/user/4242/protondrive/control.sock"));
    }

    // Final review M-5: the same temp dir rule as the daemon and the tray (Node's os.tmpdir())
    #[test]
    fn the_tmp_fallback_reads_tmpdir_then_tmp_then_temp_as_the_daemon_does() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| std::ffi::OsString::from(v))
        };
        assert_eq!(node_tmpdir(env(&[])), std::path::PathBuf::from("/tmp"));
        assert_eq!(node_tmpdir(env(&[("TMPDIR", "/var/tmp/me/")])), std::path::PathBuf::from("/var/tmp/me"));
        assert_eq!(node_tmpdir(env(&[("TMP", "/scratch")])), std::path::PathBuf::from("/scratch"));
        assert_eq!(node_tmpdir(env(&[("TEMP", "/t")])), std::path::PathBuf::from("/t"));
        assert_eq!(node_tmpdir(env(&[("TMP", "/a"), ("TEMP", "/b")])), std::path::PathBuf::from("/a"));
        assert_eq!(node_tmpdir(env(&[("TMPDIR", ""), ("TMP", "/a")])), std::path::PathBuf::from("/a"));
        assert_eq!(node_tmpdir(env(&[("TMPDIR", "/")])), std::path::PathBuf::from("/"));
        assert_eq!(
            control_socket_path_from(None, node_tmpdir(env(&[("TEMP", "/t/")])), 7),
            std::path::PathBuf::from("/t/protondrive-7/control.sock")
        );
    }

    /// A fresh folder of the user's, mode 0700 as the daemon makes it, for test sockets
    fn private_dir(name: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("{name}-{}-{:?}", std::process::id(), thread::current().id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    // Final review M-5: in the /tmp fallback anyone can make that folder first; the daemon's is the user's and 0700
    #[test]
    fn a_socket_folder_that_is_not_private_to_the_user_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let uid = own_uid();
        let dir = private_dir("pd-gui-sockdir");
        let sock = dir.join("control.sock");
        assert_eq!(socket_dir_problem(&sock, uid), None);
        // Missing: no daemon runs, which connecting says
        assert_eq!(socket_dir_problem(&dir.join("missing").join("control.sock"), uid), None);
        for mode in [0o755, 0o770, 0o701, 0o1777] {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            let problem = socket_dir_problem(&sock, uid).unwrap_or_default();
            assert!(problem.contains(dir.to_str().unwrap()), "mode {mode:o}: {problem}");
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Another user's folder (root's), and the right uid that isn't the owner
        assert!(socket_dir_problem(std::path::Path::new("/control.sock"), uid).is_some());
        assert!(socket_dir_problem(&sock, uid.wrapping_add(1)).is_some());
        // A link to a folder, or a file, isn't the daemon's folder either
        let link = dir.with_extension("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(socket_dir_problem(&link.join("control.sock"), uid).is_some());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_request_never_connects_through_a_folder_others_can_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_dir("pd-gui-open");
        let sock = dir.join("c.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let err = control_request_at(&sock, "POST", "/vfs/mount", Some(&serde_json::json!({})), SHORT).unwrap_err();
        assert!(err.contains("isn't private"), "{err}");
        assert!(listener.accept().is_err(), "nothing connected");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Serves one canned HTTP reply on a fresh socket; returns the socket path and the request it saw.
    fn serve_once(reply: &'static [u8]) -> (std::path::PathBuf, thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let dir = private_dir("pd-gui-test");
        let sock = dir.join(format!("c{}.sock", reply.len()));
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let handle = thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = conn.read(&mut buf).unwrap();
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let want = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if body.len() >= want {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            conn.write_all(reply).unwrap();
            String::from_utf8_lossy(&seen).to_string()
        });
        (sock, handle)
    }

    #[test]
    fn control_request_parses_a_json_reply() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 48\r\n\r\n{\"state\":\"pinned\",\"kept\":[\"a/b\"],\"refused\":null}   ";
        let (sock, server) = serve_once(reply);
        let body = serde_json::json!({ "path": "Projects", "action": "pin" });
        let got = control_request_at(&sock, "POST", "/availability", Some(&body), SHORT).unwrap();
        assert_eq!(got["state"], "pinned");
        assert_eq!(got["kept"][0], "a/b");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /availability HTTP/1.1\r\n"), "{request}");
        assert!(request.to_ascii_lowercase().contains("connection: close"));
        assert!(request.ends_with(&body.to_string()));
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn control_request_reads_to_eof_without_content_length() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"path\":\"x\",\"state\":\"hidden\"}";
        let (sock, server) = serve_once(reply);
        let got = control_request_at(&sock, "GET", "/availability?path=x", None, SHORT).unwrap();
        assert_eq!(got["state"], "hidden");
        assert!(server.join().unwrap().starts_with("GET /availability?path=x HTTP/1.1"));
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn control_request_turns_an_error_status_into_the_daemon_message() {
        let reply: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 34\r\n\r\n{\"error\":\"Not in Proton Drive: x\"}    ";
        let (sock, server) = serve_once(reply);
        let err = control_request_at(&sock, "GET", "/availability?path=x", None, SHORT).unwrap_err();
        server.join().unwrap();
        assert_eq!(err, "Not in Proton Drive: x");
        let _ = std::fs::remove_file(&sock);
    }

    const SHORT: Duration = Duration::from_secs(5);

    #[test]
    fn control_request_timeout_means_still_working_not_unreachable() {
        let dir = private_dir("pd-gui-timeout");
        let sock = dir.join("slow.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        // Accepts and then says nothing, like a daemon that is still downloading
        let server = thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(600));
            drop(conn);
        });
        let body = serde_json::json!({ "path": "x", "action": "pin" });
        let err = control_request_at(&sock, "POST", "/availability", Some(&body), Duration::from_millis(100)).unwrap_err();
        // Nothing reloads the list when the work finishes later, so the user is told to refresh
        assert_eq!(err, "Still working on it in the background. Refresh to see the result.");
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn availability_requests_wait_ten_minutes() {
        assert_eq!(AVAILABILITY_READ_TIMEOUT, Duration::from_secs(600));
    }

    #[test]
    fn kept_leaves_drop_folders_holding_kept_items_and_engine_temp_files() {
        let kept: Vec<String> = ["Projects/app/.git", "Projects/app", "Projects", "Projects/.proton-drive-tmp-1-2-x"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(kept_leaves(&kept), vec!["Projects/app/.git".to_string()]);
        // Siblings that merely share a name prefix are both kept
        let kept: Vec<String> = ["a/b", "a/bc"].iter().map(|s| s.to_string()).collect();
        assert_eq!(kept_leaves(&kept), kept);
        // A folder whose only kept content is an in-progress download is not a leaf either
        let kept: Vec<String> = ["Projects/.proton-drive-tmp-1", "Projects"].iter().map(|s| s.to_string()).collect();
        assert!(kept_leaves(&kept).is_empty());
        let kept: Vec<String> = ["Projects/.proton-drive-tmp-123-456-a.pdf", "Projects"].iter().map(|s| s.to_string()).collect();
        assert!(kept_leaves(&kept).is_empty());
    }

    #[test]
    fn availability_notice_ignores_folders_and_temp_files_in_kept() {
        let r = AvailabilityResult {
            state: "online-only".into(),
            kept: ["Projects/app/.git", "Projects/app", "Projects"].iter().map(|s| s.to_string()).collect(),
            refused: None,
        };
        assert_eq!(
            availability_notice(&r).as_deref(),
            Some("1 item stays on this computer because it isn't safely in Proton Drive: Projects/app/.git")
        );
        let only_temp = AvailabilityResult { state: "x".into(), kept: vec!["a/.proton-drive-tmp-1".into(), "a".into()], refused: None };
        assert_eq!(availability_notice(&only_temp), None);
    }

    #[test]
    fn control_request_reports_a_missing_daemon() {
        let err = control_request_at(std::path::Path::new("/nonexistent/control.sock"), "GET", "/availability?path=", None, SHORT).unwrap_err();
        assert!(err.contains("Proton Drive background service"), "{err}");
    }

    #[test]
    fn availability_notice_prefers_the_refusal_then_lists_kept_items() {
        let r = |kept: &[&str], refused: Option<&str>| AvailabilityResult {
            state: "online-only".into(),
            kept: kept.iter().map(|s| s.to_string()).collect(),
            refused: refused.map(String::from),
        };
        assert_eq!(availability_notice(&r(&[], None)), None);
        assert_eq!(
            availability_notice(&r(&["a"], Some("Can't hide x: y exists only on this computer"))).as_deref(),
            Some("Can't hide x: y exists only on this computer")
        );
        assert_eq!(
            availability_notice(&r(&["a/b.txt"], None)).as_deref(),
            Some("1 item stays on this computer because it isn't safely in Proton Drive: a/b.txt")
        );
        assert_eq!(
            availability_notice(&r(&["1", "2", "3", "4", "5"], None)).as_deref(),
            Some("5 items stay on this computer because they aren't safely in Proton Drive: 1, 2, 3 and 2 more")
        );
    }

    /// The app driven headlessly: no worker thread and no daemon; what it asks the worker for lands in `commands`.
    struct Harness {
        ctx: egui::Context,
        app: ProtonDriveNativeApp,
        commands: Receiver<WorkerCommand>,
        /// What the worker would answer, handled by `ProtonDriveNativeApp::process_worker_events`
        events: Sender<WorkerEvent>,
        last: Option<egui::FullOutput>,
        /// The window's size in points (the real window's size divided by the zoom)
        screen: Vec2,
        /// What a frame shows instead of the app, to test a widget on its own (see `Harness::widget`)
        scene: Option<Scene>,
    }

    /// Widgets added to a bare panel, frame after frame
    type Scene = Box<dyn FnMut(&mut egui::Ui)>;

    /// Held by the tests that set the single-instance request statics, which every test of the app shares
    static REQUEST_STATICS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl Harness {
        fn new() -> Self {
            let (tx, commands) = mpsc::channel();
            let (events, rx) = mpsc::channel();
            let status = DaemonStatus { state: "idle".into(), logged_in: true, ..Default::default() };
            let app = ProtonDriveNativeApp {
                tab: NavTab::Home,
                tx,
                rx,
                logo_texture: None,
                daemon_online: true,
                initial_connecting: false,
                status,
                activities: Vec::new(),
                login_url: None,
                account_error: None,
                search_query: String::new(),
                activity_filter: activity::ActivityFilter::All,
                expanded_activity: None,
                hidden: None,
                hidden_loading: false,
                unhiding: None,
                unhide_notice: None,
                working: Vec::new(),
                pending_confirm: None,
                notice: None,
                ignore_patterns_text: String::new(),
                settings_dirty: false,
                loaded_settings: SyncSettings { conflict_strategy: "keep-both".into(), ..Default::default() },
                settings_saving: false,
                settings_notice: None,
                drive_working: false,
                drive_error: None,
                block_app_input: String::new(),
                blocklist_working: false,
                blocklist_error: None,
                files_missing_working: false,
                files_missing_error: None,
                start_fresh_working: false,
                start_fresh_error: None,
                conflicts: Vec::new(),
                attention: Vec::new(),
                conflict_error: None,
                edit_sync_dir: String::new(),
                edit_conflict_strategy: "keep-both".into(),
                edit_notifications: false,
                edit_start_at_login: true,
                fake_drive: None,
                fake_files_missing: false,
                fake_attention: None,
                fake_transfers: None,
                fake_signed_out: false,
                fake_account_mismatch: false,
                fake_paused_until: None,
                pause_choices_open: false,
                account_menu_open: false,
                window_geometry: WindowGeometry::default(),
                maximize_applied_on_open: true,
                applied_light_mode: false,
                screenshot_target: None,
                frames_rendered: 0,
                screenshot_requested: false,
                last_poll: Instant::now(),
                share: None,
                shared: shared::SharedPage::default(),
                share_left: Vec::new(),
            };
            let ctx = egui::Context::default();
            configure_proton_theme(&ctx);
            apply_proton_visuals(&ctx, false);
            // Widgets then say what they are, and `widget_at` finds them by name, as a screen reader would
            ctx.enable_accesskit();
            let mut h = Self { ctx, app, commands, events, last: None, screen: Vec2::new(1440.0, 900.0), scene: None };
            h.frames(3);
            h
        }

        /// A window showing only what `scene` adds to its panel, to test a widget on its own.
        fn widget(scene: impl FnMut(&mut egui::Ui) + 'static) -> Self {
            let mut h = Self::new();
            h.scene = Some(Box::new(scene));
            h.frames(3);
            h
        }

        /// The Settings tab, with the drive as given and the settings form as loaded from `loaded_settings()`.
        fn settings(vfs: Option<VfsStatus>, wanted: Option<bool>) -> Self {
            let mut h = Self::new();
            let loaded = loaded_settings();
            h.app.tab = NavTab::Settings;
            h.app.status.sync_dir = loaded.sync_dir.clone();
            h.app.status.settings = loaded.clone();
            h.app.status.vfs = vfs;
            h.app.status.virtual_drive_wanted = wanted;
            h.app.load_settings_form(&loaded);
            h.frames(3);
            h
        }

        /// Hands the app a worker event, as the worker thread would, and draws the result.
        fn event(&mut self, event: WorkerEvent) {
            self.events.send(event).unwrap();
            self.app.process_worker_events();
            self.frames(2);
        }

        fn frame(&mut self, events: Vec<egui::Event>) {
            let input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, self.screen)),
                events,
                ..Default::default()
            };
            let app = &mut self.app;
            let scene = &mut self.scene;
            self.last = Some(self.ctx.run(input, |ctx| match scene {
                Some(scene) => {
                    egui::CentralPanel::default().show(ctx, |ui| scene(ui));
                }
                None => app.render_ui(ctx),
            }));
        }

        /// The window at `size` (as the OS sees it) with the keyboard zoom at `zoom`: egui then has `size / zoom` points.
        fn resize_zoomed(&mut self, size: Vec2, zoom: f32) {
            self.ctx.set_zoom_factor(zoom);
            self.screen = size / zoom;
            self.frames(3);
        }

        /// The rectangles the last frame painted with this fill.
        fn rects_filled(&self, fill: Color32) -> Vec<egui::Rect> {
            fn rects(shape: &egui::Shape, fill: Color32, out: &mut Vec<egui::Rect>) {
                match shape {
                    egui::Shape::Rect(r) if r.fill == fill => out.push(r.rect),
                    egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| rects(s, fill, out)),
                    _ => {}
                }
            }
            let mut out = Vec::new();
            for clipped in self.last.iter().flat_map(|o| o.shapes.iter()) {
                rects(&clipped.shape, fill, &mut out);
            }
            out
        }

        fn frames(&mut self, n: usize) {
            for _ in 0..n {
                self.frame(Vec::new());
            }
        }

        /// A left click as the windowing system sends it: move there, press, release, each in its own frame.
        fn click(&mut self, pos: egui::Pos2) {
            let button = |pressed| egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed,
                modifiers: egui::Modifiers::NONE,
            };
            self.frame(vec![egui::Event::PointerMoved(pos)]);
            self.frame(vec![button(true)]);
            self.frame(vec![button(false)]);
            self.frames(2);
        }

        /// The mouse wheel turned over `pos`, moving the content under it up by `dy` points, then time for the scroll
        /// to settle.
        fn scroll(&mut self, pos: egui::Pos2, dy: f32) {
            self.frame(vec![egui::Event::PointerMoved(pos)]);
            let wheel = egui::Event::MouseWheel {
                unit: egui::MouseWheelUnit::Point,
                delta: Vec2::new(0.0, -dy),
                modifiers: egui::Modifiers::NONE,
            };
            self.frame(vec![wheel]);
            self.frames(30);
        }

        /// Every text the last frame painted that `matches`, in the order painted.
        fn texts(&self, matches: impl Fn(&egui::epaint::TextShape) -> bool) -> Vec<&egui::epaint::TextShape> {
            fn find<'a>(shape: &'a egui::Shape, matches: &impl Fn(&egui::epaint::TextShape) -> bool, out: &mut Vec<&'a egui::epaint::TextShape>) {
                match shape {
                    egui::Shape::Text(t) if matches(t) => out.push(t),
                    egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| find(s, matches, out)),
                    _ => {}
                }
            }
            let mut out = Vec::new();
            for clipped in self.last.iter().flat_map(|o| o.shapes.iter()) {
                find(&clipped.shape, &matches, &mut out);
            }
            out
        }

        /// Where the last frame painted exactly this text.
        fn text_at(&self, text: &str) -> Option<egui::Pos2> {
            self.text_rect(text).map(|r| r.center())
        }

        /// The box the last frame painted this text in, the first time it painted it.
        fn text_rect(&self, text: &str) -> Option<egui::Rect> {
            self.texts(|t| t.galley.text() == text).first().map(|t| t.visual_bounding_rect())
        }

        /// The box the last frame painted text starting with `prefix` in (a line shortened to fit), the first time.
        fn text_rect_starting(&self, prefix: &str) -> Option<egui::Rect> {
            self.texts(|t| t.galley.text().starts_with(prefix)).first().map(|t| t.visual_bounding_rect())
        }

        /// Everywhere the last frame painted exactly this text, in the order painted.
        fn text_at_all(&self, text: &str) -> Vec<egui::Pos2> {
            self.text_rects_all(text).into_iter().map(|r| r.center()).collect()
        }

        /// The boxes the last frame painted exactly this text in, in the order painted.
        fn text_rects_all(&self, text: &str) -> Vec<egui::Rect> {
            self.texts(|t| t.galley.text() == text).into_iter().map(|t| t.visual_bounding_rect()).collect()
        }

        /// The centre of the first widget the last frame named exactly `label` for screen readers (an icon-only
        /// button's name is its old label).
        fn widget_at(&self, label: &str) -> Option<egui::Pos2> {
            self.widgets_at_all(label).into_iter().next()
        }

        /// The centres of every widget the last frame named exactly `label` for screen readers.
        fn widgets_at_all(&self, label: &str) -> Vec<egui::Pos2> {
            let Some(update) = self.last.as_ref().and_then(|o| o.platform_output.accesskit_update.as_ref()) else {
                return Vec::new();
            };
            update
                .nodes
                .iter()
                .filter(|(_, node)| node.label() == Some(label))
                .filter_map(|(_, node)| node.bounds())
                .map(|b| egui::pos2(((b.x0 + b.x1) / 2.0) as f32, ((b.y0 + b.y1) / 2.0) as f32))
                .collect()
        }

        /// The centre of the first label the last frame gave screen readers with exactly this text (egui hands a
        /// label's text over as its value, not its name).
        fn label_at(&self, text: &str) -> Option<egui::Pos2> {
            let update = self.last.as_ref()?.platform_output.accesskit_update.as_ref()?;
            update
                .nodes
                .iter()
                .filter(|(_, node)| node.role() == egui::accesskit::Role::Label && node.value() == Some(text))
                .find_map(|(_, node)| node.bounds())
                .map(|b| egui::pos2(((b.x0 + b.x1) / 2.0) as f32, ((b.y0 + b.y1) / 2.0) as f32))
        }

        /// The accessibility nodes the last frame named exactly `label`, left to right.
        fn nodes_named(&self, label: &str) -> Vec<egui::accesskit::Node> {
            let Some(update) = self.last.as_ref().and_then(|o| o.platform_output.accesskit_update.as_ref()) else {
                return Vec::new();
            };
            let mut nodes: Vec<_> = update.nodes.iter().filter(|(_, n)| n.label() == Some(label)).map(|(_, n)| n.clone()).collect();
            nodes.sort_by(|a, b| a.bounds().map_or(0.0, |r| r.x0).total_cmp(&b.bounds().map_or(0.0, |r| r.x0)));
            nodes
        }

        /// The colour the last frame painted this text in, the first time it painted it.
        fn text_color_at(&self, text: &str) -> Option<Color32> {
            self.texts(|t| t.galley.text() == text).first().map(|t| {
                t.galley.job.sections.first().map_or(t.fallback_color, |s| s.format.color)
            })
        }

        /// The rectangle and fill of the topmost rectangle the last frame painted under a point.
        fn rect_under(&self, pos: egui::Pos2) -> Option<(egui::Rect, Color32)> {
            fn rects(shape: &egui::Shape, out: &mut Vec<(egui::Rect, Color32)>) {
                match shape {
                    egui::Shape::Rect(r) => out.push((r.rect, r.fill)),
                    egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| rects(s, out)),
                    _ => {}
                }
            }
            let mut all = Vec::new();
            for clipped in &self.last.as_ref()?.shapes {
                rects(&clipped.shape, &mut all);
            }
            all.into_iter().rev().find(|(rect, fill)| rect.contains(pos) && *fill != Color32::TRANSPARENT)
        }

        /// The fill of the topmost rectangle the last frame painted under a point (a button's background).
        fn fill_under(&self, pos: egui::Pos2) -> Option<Color32> {
            fn rects(shape: &egui::Shape, out: &mut Vec<(egui::Rect, Color32)>) {
                match shape {
                    egui::Shape::Rect(r) => out.push((r.rect, r.fill)),
                    egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| rects(s, out)),
                    _ => {}
                }
            }
            let mut all = Vec::new();
            for clipped in &self.last.as_ref()?.shapes {
                rects(&clipped.shape, &mut all);
            }
            all.into_iter().rev().find(|(rect, fill)| rect.contains(pos) && *fill != Color32::TRANSPARENT).map(|(_, fill)| fill)
        }

        /// The actions asked of the worker since the last call (reads, such as refreshes, are left out, except the Share
        /// window's, which its tests follow).
        fn sent(&self) -> Vec<String> {
            self.commands
                .try_iter()
                .filter_map(|c| match c {
                    WorkerCommand::SetAvailability { path, action } => Some(format!("{action} {path:?}")),
                    WorkerCommand::SaveSettings(changes) => Some(format!("save {changes}")),
                    WorkerCommand::SetVirtualDrive(on) => Some(format!("virtual drive {on}")),
                    WorkerCommand::SetBlockedApps(apps) => Some(format!("blocked apps {}", apps.join(","))),
                    WorkerCommand::MountAgain => Some("mount again".to_string()),
                    WorkerCommand::DriveMove { action, from, to } => Some(format!("{action} {from} -> {to}")),
                    WorkerCommand::ResolveFilesMissing { choice, root, names } => {
                        Some(format!("files missing: {} {root} {}", choice.action(), names.join(", ")))
                    }
                    WorkerCommand::TriggerSync => Some("sync now".to_string()),
                    WorkerCommand::SetPaused { paused, until: None } => Some(format!("paused {paused}")),
                    WorkerCommand::SetPaused { paused, until: Some(until) } => Some(format!("paused {paused} until {until}")),
                    WorkerCommand::ResolveConflict { id, choice } => Some(format!("resolve {id} {choice}")),
                    WorkerCommand::StartLogin => Some("sign in".to_string()),
                    WorkerCommand::StartFresh => Some("start fresh".to_string()),
                    WorkerCommand::SharedLoad { .. } => Some("shared list".to_string()),
                    WorkerCommand::SharedStop { rel_path, uid } => Some(format!("stop sharing {rel_path:?} {uid}")),
                    WorkerCommand::Logout => Some("sign out".to_string()),
                    WorkerCommand::ShareLoad { rel_path, .. } => Some(format!("share info {rel_path}")),
                    WorkerCommand::SharePassword { rel_path, .. } => Some(format!("share password {rel_path}")),
                    WorkerCommand::ShareEnsureLink { rel_path, .. } => Some(format!("share link on {rel_path}")),
                    WorkerCommand::ShareRemoveLink { rel_path, .. } => Some(format!("share link off {rel_path}")),
                    WorkerCommand::ShareSettings { rel_path, password, expires_at, .. } => Some(format!(
                        "share settings {}",
                        share::settings_body(&rel_path, password.as_ref().map(|p| p.as_deref()), expires_at)
                    )),
                    WorkerCommand::ShareInvite { rel_path, emails, role, .. } => {
                        Some(format!("share invite {rel_path} {} {}", emails.join(","), role.as_str()))
                    }
                    WorkerCommand::ShareRole { rel_path, email, role, .. } => {
                        Some(format!("share role {rel_path} {email} {}", role.as_str()))
                    }
                    WorkerCommand::ShareRemovePerson { rel_path, email, .. } => Some(format!("share remove {rel_path} {email}")),
                    _ => None,
                })
                .collect()
        }
    }

    /// Clicks the sidebar's Activity with nothing open, to prove `pos` is where it reacts, then goes back to Home.
    fn activity_nav_reacts_at(h: &mut Harness, pos: egui::Pos2) {
        h.click(pos);
        assert_eq!(h.app.tab, NavTab::Activity, "Activity did not react to a click at {pos:?}");
        h.app.tab = NavTab::Home;
        h.frames(2);
    }

    // #203: a later start that names a section (the tray's problems item asks for Home) opens the running app there; one
    // that names none leaves it where it is. The tests that touch these statics hold REQUEST_STATICS, so they can't race.
    #[test]
    fn a_later_start_opens_the_running_app_on_the_section_it_asks_for() {
        let _statics = REQUEST_STATICS.lock().unwrap_or_else(|e| e.into_inner());
        let mut h = Harness::new();
        h.app.tab = NavTab::Settings;
        *SECTION_REQUESTED.lock().unwrap() = Some(NavTab::Home);
        SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
        h.app.answer_show_request(&h.ctx);
        assert_eq!(h.app.tab, NavTab::Home);
        assert!(SECTION_REQUESTED.lock().unwrap().is_none(), "taken once");

        h.app.tab = NavTab::Activity;
        SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
        h.app.answer_show_request(&h.ctx);
        assert_eq!(h.app.tab, NavTab::Activity);
        assert!(!SHOW_REQUESTED.load(AtomicOrdering::SeqCst));
    }

    // #216: a later start with --share opens the share window on the running app
    #[test]
    fn a_later_start_with_share_opens_the_window_on_the_running_app() {
        let _statics = REQUEST_STATICS.lock().unwrap_or_else(|e| e.into_inner());
        let mut h = Harness::new();
        assert!(h.app.share.is_none());
        *SHARE_REQUESTED.lock().unwrap() = Some(single_instance::Request::Share("/home/u/ProtonDrive/My Docs/a.pdf".to_string()));
        SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
        h.app.answer_show_request(&h.ctx);
        assert_eq!(h.app.share.as_ref().map(|w| w.abs_path.as_str()), Some("/home/u/ProtonDrive/My Docs/a.pdf"));
        assert!(SHARE_REQUESTED.lock().unwrap().is_none(), "taken once");
        // A plain show afterwards leaves the open window alone
        SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
        h.app.answer_show_request(&h.ctx);
        assert!(h.app.share.is_some());
    }

    // Minor 5: a --share that can't be done (not a full path, a line break, not UTF-8) opens the window saying why,
    // on a first start and in a running app, rather than nothing at all
    #[test]
    fn a_share_that_cant_be_done_opens_the_window_saying_why() {
        use std::os::unix::ffi::OsStrExt;
        let _statics = REQUEST_STATICS.lock().unwrap_or_else(|e| e.into_inner());
        let mut h = Harness::new();
        h.app.status.sync_dir = "/home/u/ProtonDrive".into();
        // A first start
        h.app.open_share_request(single_instance::share_request(std::ffi::OsStr::new("Docs/report.pdf")));
        h.frames(3);
        assert!(h.text_at("Share \"report.pdf\"").is_some());
        assert!(h.text_at(share::refusal(single_instance::PathProblem::NotAbsolute)).is_some());
        assert!(h.text_at("Try again").is_none(), "nothing to try again");
        assert_eq!(h.sent(), Vec::<String>::new());

        // A running app, asked by a later start: a line break, then a name that isn't UTF-8
        let cases: [(&[u8], &str, single_instance::PathProblem); 2] = [
            (b"/home/u/ProtonDrive/two\nlines.txt", "Share \"two\u{fffd}lines.txt\"", single_instance::PathProblem::LineBreak),
            (b"/home/u/ProtonDrive/caf\xe9.txt", "Share \"caf\u{fffd}.txt\"", single_instance::PathProblem::NotUtf8),
        ];
        for (path, title, problem) in cases {
            *SHARE_REQUESTED.lock().unwrap() = Some(single_instance::share_request(std::ffi::OsStr::from_bytes(path)));
            SHOW_REQUESTED.store(true, AtomicOrdering::SeqCst);
            h.app.answer_show_request(&h.ctx);
            h.frames(3);
            assert!(h.text_at(title).is_some(), "{title}");
            assert!(h.text_at(share::refusal(problem)).is_some(), "{problem:?}");
            assert_eq!(h.sent(), Vec::<String>::new());
        }
        // A file truly named as the refusal showed the last one: a window of its own, which reads, not the refusal
        h.app.open_share("/home/u/ProtonDrive/caf\u{fffd}.txt");
        assert_eq!(h.sent(), vec!["share info caf\u{fffd}.txt".to_string()]);
        h.frames(2);
        assert!(h.text_at(share::refusal(single_instance::PathProblem::NotUtf8)).is_none());
        h.click(h.text_at("Done").unwrap());
        assert!(h.app.share.is_none());
    }

    #[test]
    fn clicking_outside_a_confirm_dialog_closes_it_and_clicks_nothing_under_it() {
        let mut h = Harness::new();
        let activity = h.text_at("Activity").expect("the sidebar's Activity is painted");
        activity_nav_reacts_at(&mut h, activity);

        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        h.frames(2);
        h.click(activity);

        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.app.tab, NavTab::Home);
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn a_click_in_the_frame_a_confirm_dialog_appears_clicks_nothing_under_it() {
        let mut h = Harness::new();
        let activity = h.text_at("Activity").expect("the sidebar's Activity is painted");
        activity_nav_reacts_at(&mut h, activity);

        // No frame has drawn the backdrop yet when the click arrives
        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        let button = |pressed| egui::Event::PointerButton {
            pos: activity,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        };
        h.frame(vec![button(true), button(false)]);
        h.frames(2);

        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.app.tab, NavTab::Home);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    /// Opens `confirm`, clicks its button (`label`) and returns the harness for the checks on what was sent.
    fn confirm_and_click(confirm: PendingConfirm, label: &str) -> Harness {
        let mut h = Harness::new();
        h.app.pending_confirm = Some(confirm);
        h.frames(2);
        let button = *h.text_at_all(label).last().unwrap_or_else(|| panic!("the dialog's {label:?} button is painted"));
        h.click(button);
        assert_eq!(h.app.pending_confirm, None);
        h
    }

    #[test]
    fn confirming_free_all_for_a_folder_sends_free_for_that_folder() {
        let h = confirm_and_click(PendingConfirm::FreeAll { rel_path: "Docs".into() }, "Free up space");
        assert_eq!(h.sent(), vec![r#"free "Docs""#.to_string()]);
        assert_eq!(h.app.working, vec!["Docs".to_string()]);
    }

    #[test]
    fn confirming_virtual_drive_off_sends_only_the_virtual_drive_switch() {
        let h = confirm_and_click(PendingConfirm::VirtualDriveOff, "Switch off");
        assert_eq!(h.sent(), vec!["virtual drive false".to_string()]);
        assert!(h.app.drive_working);
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn confirming_delete_missing_sends_only_the_delete_in_cloud_choice() {
        let h = confirm_and_click(
            PendingConfirm::DeleteMissing { root: "/home/u/ProtonDrive".into(), names: vec!["Docs".into()], items: 3 },
            "Delete from Proton Drive",
        );
        assert_eq!(h.sent(), vec!["files missing: delete-in-cloud /home/u/ProtonDrive Docs".to_string()]);
        assert!(h.app.files_missing_working);
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn confirming_start_fresh_sends_only_start_fresh() {
        let h = confirm_and_click(PendingConfirm::StartFresh, "Start fresh");
        assert_eq!(h.sent(), vec!["start fresh".to_string()]);
        assert!(h.app.start_fresh_working);
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn confirming_stop_sharing_sends_only_the_stop_for_that_item() {
        let h = confirm_and_click(
            PendingConfirm::StopSharing { rel_path: "Documents/report.pdf".into(), uid: "vol~report".into(), question: "Stop sharing report.pdf?".into() },
            "Stop sharing",
        );
        assert_eq!(h.sent(), vec![r#"stop sharing "Documents/report.pdf" vol~report"#.to_string()]);
        assert_eq!(h.app.shared.stopping.as_deref(), Some("Documents/report.pdf"));
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn the_free_up_space_dialogs_buttons_take_clicks() {
        let mut h = Harness::new();
        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        h.frames(2);
        h.click(h.text_at("Cancel").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        h.frames(2);
        h.click(h.text_at("Free up space").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec![r#"free """#.to_string()]);
        assert_eq!(h.app.working, vec![String::new()]);
    }

    #[test]
    fn home_carries_a_badge_counting_what_needs_attention_kept_up_with_the_status_and_conflicts() {
        let mut h = Harness::new();
        assert!(h.app.attention.is_empty());
        let mut status = h.app.status.clone();
        status.stats.error_items = 2;
        status.stats.unresolved_conflicts = 1;
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert_eq!(h.app.attention, vec![home::Attention::FailedItems(2)]);
        // A new count of conflicts asks for the list, whose arrival is counted too
        assert!(h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadConflicts)));
        h.event(WorkerEvent::ConflictsLoaded(vec![ConflictRecord { id: 3, local_rel_path: "a.txt".into(), ..Default::default() }]));
        assert_eq!(h.app.attention.len(), 2);
        let badge = h.text_at("2").expect("Home's badge is painted");
        let home = h.text_at("Home").unwrap();
        assert!((badge.y - home.y).abs() < 4.0, "the badge is on Home's row");
    }

    #[test]
    fn settings_starts_with_the_account_and_signs_out_from_it() {
        let mut h = Harness::new();
        h.app.status.account = Some(AccountInfo {
            display_name: "Gautam C".into(),
            email: "gc@proton.me".into(),
            initials: "GC".into(),
            used_space: 51 * GB,
            max_space: 510 * GB,
            ..Default::default()
        });
        h.frames(2);
        h.click(h.widget_at("Settings").expect("the top bar's gear"));
        assert_eq!(h.app.tab, NavTab::Settings);
        // Settings starts with the account: name, email, plan, storage and Sign out (the top bar shows the name, email
        // and initials too)
        let in_section = |h: &Harness, text: &str| h.text_at_all(text).iter().any(|p| p.y > chrome::TOP_BAR_HEIGHT);
        for shown in ["Account", "Gautam C", "GC", "gc@proton.me", "Proton Unlimited", "51.0 GB of 510.0 GB"] {
            assert!(in_section(&h, shown), "{shown}");
        }
        h.click(h.text_at("Sign out").expect("Sign out is offered"));
        assert_eq!(h.sent(), vec!["sign out".to_string()]);
        // Nothing of the old sidebar, top bar or popover is left (Home has its own Pause and Sync now)
        for gone in ["Sync now", "My files", "Sync Activity", "Conflicts", "Pause", "Open local sync folder"] {
            assert!(h.text_at(gone).is_none(), "{gone}");
        }
    }

    #[test]
    fn signed_out_the_account_card_offers_sign_in_and_shows_how_it_went() {
        let mut h = Harness::new();
        h.app.status.logged_in = false;
        h.app.status.account = None;
        h.app.tab = NavTab::Settings;
        h.frames(2);
        assert!(h.text_at("Sign out").is_none());
        h.click(h.text_at("Sign in").expect("Sign in is offered while signed out"));
        assert_eq!(h.sent(), vec!["sign in".to_string()]);
        h.event(WorkerEvent::LoginStarted(Err("Proton is unreachable".into())));
        assert!(h.text_at("Couldn't start signing in: Proton is unreachable").is_some());
    }

    // #94: a free-up reads as such, not as a delete; a filter keeps uploads, downloads or problems; a click opens a row
    // to its full details, with Show in Files and Open, quietly showing where a gone item was
    #[test]
    fn activity_rows_say_what_happened_filter_and_open_to_show_in_files() {
        let dir = std::env::temp_dir().join(format!("pd-activity-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Docs")).unwrap();
        std::fs::write(dir.join("Docs/report.pdf"), "r").unwrap();
        let launched = || home::LAUNCHED.with(|l| std::mem::take(&mut *l.borrow_mut()));
        launched();
        let mut h = Harness::new();
        h.app.tab = NavTab::Activity;
        h.app.status.sync_dir = dir.to_string_lossy().into_owned();
        let record = |ts: u64, action: &str, path: &str, details: &str| ActivityRecord {
            id: Some(ts),
            timestamp: ts,
            action: action.into(),
            local_rel_path: path.into(),
            details: details.into(),
        };
        h.app.activities = vec![
            record(1, "delete-local", "Photos", "Freed up space (removed the local copies; kept in Proton Drive)"),
            record(2, "upload", "Docs/report.pdf", "Uploaded to Proton Drive (1 B)"),
            record(3, "download", "Music/song.mp3", "Downloaded from Proton Drive (4 MB)"),
            record(4, "error", "Gone/away.txt", "Upload failed: network down"),
        ];
        h.frames(2);
        assert!(h.text_at("Freed up space").is_some());
        assert!(h.text_at("− Removed locally").is_none(), "a free-up never reads as a delete");

        h.click(h.text_at("Problems").unwrap());
        h.frames(2);
        assert!(h.text_at("Gone/away.txt").is_some());
        for hidden in ["Docs/report.pdf", "Music/song.mp3", "Photos"] {
            assert!(h.text_at(hidden).is_none(), "{hidden}");
        }
        h.click(h.text_at("Uploads").unwrap());
        h.frames(2);
        assert!(h.text_at("Docs/report.pdf").is_some());
        assert!(h.text_at("Gone/away.txt").is_none());
        h.click(h.text_at("All").unwrap());
        h.frames(2);
        assert!(h.text_at("Music/song.mp3").is_some());

        // A click opens the row: its whole details, Show in Files and, as the file is here, Open
        h.click(h.text_at("Docs/report.pdf").unwrap());
        h.frames(2);
        h.click(h.text_at("Show in Files").expect("Show in Files is offered"));
        assert_eq!(launched(), vec![format!("show:{}", dir.join("Docs/report.pdf").display())]);
        h.click(h.text_at("Open").expect("Open is offered for a file here"));
        assert_eq!(launched(), vec![dir.join("Docs/report.pdf").to_string_lossy().into_owned()]);
        assert_eq!(h.sent(), Vec::<String>::new());

        // Looked up once, as the row opened: a file gone since still offers what was found then, until opened again
        assert!(h.app.expanded_activity.as_ref().is_some_and(|e| e.open.is_some()));

        // An item that is gone: no Open, and Show in Files shows the sync folder it was in, quietly
        h.click(h.text_at("Gone/away.txt").unwrap());
        h.frames(2);
        assert!(h.text_at("Open").is_none());
        h.click(h.text_at("Show in Files").unwrap());
        assert_eq!(launched(), vec![format!("show:{}", dir.display())]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn activity_has_its_own_search_and_no_stat_cards() {
        let mut h = Harness::new();
        h.app.tab = NavTab::Activity;
        h.app.status.account = Some(AccountInfo { used_space: 5, max_space: 10, used_drive_space: 5, ..Default::default() });
        let record = |path: &str, details: &str| ActivityRecord {
            id: None,
            timestamp: 0,
            action: "upload".into(),
            local_rel_path: path.into(),
            details: details.into(),
        };
        h.app.activities = vec![record("Docs/Report.pdf", "Uploaded 2 MB"), record("Music/song.mp3", "Uploaded in Q3 report run")];
        h.frames(2);
        assert!(h.text_at("Activity").is_some());
        assert!(h.text_at("Search activity").is_some(), "the search field is at the top");
        for gone in ["Proton Cloud Storage", "Local Synced Size", "Synced Files", "Synced Folders", "Recent Sync Activity"] {
            assert!(h.text_at(gone).is_none(), "{gone}");
        }
        assert!(h.text_at("Docs/Report.pdf").is_some());
        assert!(h.text_at("Music/song.mp3").is_some());

        // Case-insensitive, on the path or the details
        h.app.search_query = "REPORT".into();
        h.frames(2);
        assert!(h.text_at("Docs/Report.pdf").is_some());
        assert!(h.text_at("Music/song.mp3").is_some());
        h.app.search_query = "docs/".into();
        h.frames(2);
        assert!(h.text_at("Docs/Report.pdf").is_some());
        assert!(h.text_at("Music/song.mp3").is_none());
        h.app.search_query = "nothing like it".into();
        h.frames(2);
        assert!(h.text_at("Docs/Report.pdf").is_none());
        assert!(h.text_at("No activity matches \"nothing like it\".").is_some());
    }

    // #275: the selected filter is white on purple, and each chip reads in both themes
    #[test]
    fn the_selected_chip_is_readable() {
        for p in [&LIGHT, &DARK] {
            for selected in [true, false] {
                let (fill, text) = chip_colors(p, selected);
                assert!(contrast(text, fill) >= 4.5, "selected {selected}: {}", contrast(text, fill));
            }
        }
        let mut h = Harness::new();
        h.app.tab = NavTab::Activity;
        h.frames(3);
        let all = h.text_at("All").expect("the All chip is painted");
        assert_eq!(h.fill_under(all), Some(PROTON_PURPLE));
        assert_eq!(h.text_color_at("All"), Some(Color32::WHITE));
        let uploads = h.text_at("Uploads").expect("the Uploads chip is painted");
        assert_eq!(h.fill_under(uploads), Some(palette().input));
        assert_eq!(h.text_color_at("Uploads"), Some(palette().text_weak));
        h.click(uploads);
        assert_eq!(h.fill_under(h.text_at("Uploads").unwrap()), Some(PROTON_PURPLE));
        assert_eq!(h.text_color_at("Uploads"), Some(Color32::WHITE));
        assert_eq!(h.fill_under(h.text_at("All").unwrap()), Some(palette().input));
    }

    #[test]
    fn activity_search_has_its_icon() {
        let mut h = Harness::new();
        h.app.tab = NavTab::Activity;
        h.frames(3);
        let hint = h.text_rect("Search activity").expect("the search hint is painted");
        let icon = h.text_rect(icons::SEARCH).expect("the search glyph is painted");
        assert!(icon.max.x <= hint.min.x, "the glyph {icon:?} sits left of the hint {hint:?}");
        assert!((icon.center().y - hint.center().y).abs() < 4.0);
        assert_eq!(h.fill_under(hint.center()), Some(palette().input));
    }

    // #280: every chip and the search field stay inside the page at the smallest window and 120% zoom
    #[test]
    fn activity_top_row_fits_at_the_smallest_window_and_120_percent_zoom() {
        for logged_in in [true, false] {
            let mut h = Harness::new();
            h.app.tab = NavTab::Activity;
            h.app.status.logged_in = logged_in;
            h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2);
            let right_max = 840.0 / 1.2;
            for label in ["All", "Uploads", "Downloads", "Problems", "Search activity"] {
                let pos = h.text_at(label).unwrap_or_else(|| panic!("{label} is painted (logged in {logged_in})"));
                let (rect, _) = h.rect_under(pos).unwrap_or_else(|| panic!("{label} has a box"));
                assert!(rect.max.x <= right_max, "{label} runs past the right edge: {rect:?} (logged in {logged_in})");
                assert!(rect.min.x >= SIDEBAR_EDGE, "{label} runs into the sidebar: {rect:?} (logged in {logged_in})");
            }
            assert_eq!(h.text_at("Sign in to Proton Drive").is_some(), !logged_in);
        }
    }

    #[test]
    fn activity_search_matches_the_path_or_the_details_whatever_the_case() {
        let act: ActivityRecord =
            serde_json::from_str(r#"{"timestamp":0,"action":"download","localRelPath":"Docs/Plan.txt","details":"From Laptop"}"#)
                .unwrap();
        assert!(activity_matches(&act, ""));
        assert!(activity_matches(&act, "plan"));
        assert!(activity_matches(&act, "LAPTOP"));
        assert!(activity_matches(&act, "  docs/plan "));
        assert!(!activity_matches(&act, "music"));
    }

    fn hidden(path: &str, state: &str) -> HiddenItem {
        HiddenItem { path: path.into(), state: state.into() }
    }

    #[test]
    fn hidden_items_are_read_over_the_control_socket() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"items\":[{\"path\":\"Docs/Private\",\"state\":\"hiding\"},{\"path\":\"Music\",\"state\":\"hidden\"}]}";
        let (sock, server) = serve_once(reply);
        assert_eq!(hidden_items_at(&sock).unwrap(), vec![hidden("Docs/Private", "hiding"), hidden("Music", "hidden")]);
        assert!(server.join().unwrap().starts_with("GET /availability/hidden HTTP/1.1\r\n"));

        // A daemon from before the list answers 404: restarting it brings the list
        let (sock, server) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"Not found\"}");
        assert_eq!(hidden_items_at(&sock).unwrap_err(), HIDDEN_NEEDS_RESTART);
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
        let (sock, server) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\n");
        assert_eq!(hidden_items_at(&sock).unwrap_err(), HIDDEN_NEEDS_RESTART);
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn the_shared_list_and_stop_sharing_go_over_the_control_socket() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"items\":[{\"uid\":\"vol~a\",\"name\":\"a.txt\",\"relPath\":\"a.txt\",\"where\":\"my-files\",\"link\":null,\"people\":1}]}";
        let (sock, server) = serve_once(reply);
        let items = share::list_at(&sock).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "a.txt");
        assert_eq!(items[0].uid, "vol~a");
        assert!(server.join().unwrap().starts_with("GET /share/list HTTP/1.1\r\n"));
        let _ = std::fs::remove_file(&sock);

        // Not what it can't read, in serde's words
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"items\":[{\"name\":\"secret@x.com\"}]}");
        assert_eq!(share::list_at(&sock).unwrap_err(), "Unreadable reply from the Proton Drive background service");
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);

        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"link\":null,\"people\":[]}");
        share::stop_sharing_at(&sock, "Docs/a b.txt", "vol~n1").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("DELETE /share/all HTTP/1.1\r\n"), "{request}");
        assert!(request.ends_with(r#"{"path":"Docs/a b.txt","uid":"vol~n1"}"#), "{request}");
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn list_at_against_a_daemon_without_the_route_says_restart() {
        let (sock, server) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"Not found\"}");
        assert_eq!(share::list_at(&sock).unwrap_err(), share::SHARE_NEEDS_RESTART);
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
        let (sock, server) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\n");
        assert_eq!(share::stop_sharing_at(&sock, "a", "u").unwrap_err(), share::SHARE_NEEDS_RESTART);
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn settings_lists_what_is_hidden_and_unhide_sends_it() {
        let mut h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        assert!(h.text_at("Hidden from this computer").is_some());
        // Shown, it asks for the list on every status
        let status = h.app.status.clone();
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert!(h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadHidden)));

        h.event(WorkerEvent::HiddenLoaded(Ok(Vec::new())));
        assert!(h.text_at("Nothing is hidden.").is_some());

        h.event(WorkerEvent::HiddenLoaded(Ok(vec![hidden("Docs/Private", "hiding"), hidden("Music", "hidden")])));
        assert!(h.text_at("Nothing is hidden.").is_none());
        assert!(h.text_at("Docs/Private").is_some());
        assert!(h.text_at("Music").is_some());
        assert!(h.text_at("Hiding…").is_some());
        let music = h.text_at("Music").unwrap();
        let unhide = h.text_at_all("Unhide").into_iter().find(|p| (p.y - music.y).abs() < 12.0).expect("Music has Unhide");
        h.click(unhide);
        assert_eq!(h.sent(), vec![r#"unhide "Music""#.to_string()]);
        assert_eq!(h.app.working, vec!["Music".to_string()]);
        // One at a time
        h.click(unhide);
        assert_eq!(h.sent(), Vec::<String>::new());

        // When it is done the list is read again, and a refusal is shown in the card, and only there
        let refused = AvailabilityResult { state: "hidden".into(), kept: Vec::new(), refused: Some("Can't unhide Music: busy".into()) };
        h.event(WorkerEvent::AvailabilityDone { path: "Music".into(), result: Ok(refused) });
        assert!(h.app.working.is_empty());
        assert!(h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadHidden)));
        assert!(h.text_at("Can't unhide Music: busy").is_some());
        assert_eq!(h.app.unhide_notice, Some(Notice::error("Can't unhide Music: busy")));
        assert_eq!(h.app.notice, None, "not on Home too");

        // A list that can't be read says so
        h.event(WorkerEvent::HiddenLoaded(Err("Proton is unreachable".into())));
        assert!(h.text_at("Couldn't load the list: Proton is unreachable").is_some());
        // An older daemon, without the list, needs a restart, not an error
        h.event(WorkerEvent::HiddenLoaded(Err(HIDDEN_NEEDS_RESTART.into())));
        assert!(h.text_at("Restart Proton Drive to see this list").is_some());
        assert!(h.text_at("Couldn't load the list: Restart Proton Drive to see this list").is_none());
    }

    #[test]
    fn an_unhide_that_kept_items_says_so_in_the_card_as_information() {
        let mut h = Harness::settings(None, None);
        h.event(WorkerEvent::HiddenLoaded(Ok(vec![hidden("Music", "hidden")])));
        h.click(h.text_at("Unhide").expect("Unhide is painted"));
        assert_eq!(h.sent(), vec![r#"unhide "Music""#.to_string()]);
        let kept = AvailabilityResult { state: "pinned".into(), kept: vec!["Music/a.mp3".into()], refused: None };
        h.event(WorkerEvent::AvailabilityDone { path: "Music".into(), result: Ok(kept) });
        let text = "1 item stays on this computer because it isn't safely in Proton Drive: Music/a.mp3";
        assert_eq!(h.app.unhide_notice, Some(Notice::info(text)));
        assert_eq!(h.app.notice, None);
        assert!(h.text_at(text).is_some());
        // A failure is an error
        h.click(h.text_at("Unhide").unwrap());
        h.event(WorkerEvent::AvailabilityDone { path: "Music".into(), result: Err("Still working on it".into()) });
        assert_eq!(h.app.unhide_notice, Some(Notice::error("Still working on it")));
        assert_eq!(h.app.notice, None);
    }

    #[test]
    fn unhide_waits_for_the_daemon() {
        let mut h = Harness::settings(None, None);
        h.event(WorkerEvent::HiddenLoaded(Ok(vec![hidden("Music", "hidden")])));
        h.app.daemon_online = false;
        h.frames(2);
        h.click(h.text_at("Unhide").expect("Unhide is painted"));
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    /// Home with the status changed by `change`, and what Needs attention lists recomputed, as a status event would.
    fn home_with(change: impl FnOnce(&mut DaemonStatus)) -> Harness {
        let mut h = Harness::new();
        h.app.status.sync_dir = "/home/u/ProtonDrive".into();
        change(&mut h.app.status);
        h.app.refresh_attention();
        h.frames(3);
        h
    }

    #[test]
    fn home_says_how_the_sync_is_and_pause_resume_and_sync_now_send_their_commands() {
        let mut h = home_with(|_| {});
        assert!(h.text_at("Up to date").is_some());
        assert!(h.text_at("Resume").is_none());
        // #205: Pause opens its three choices and sends nothing yet; each choice sends the pause with its time
        let pause = h.text_at("Pause").expect("Pause is a button");
        assert!(h.text_at("For 1 hour").is_none());
        h.click(pause);
        assert_eq!(h.sent(), Vec::<String>::new());
        for choice in ["For 1 hour", "Until tomorrow", "Until I resume"] {
            assert!(h.text_at(choice).is_some(), "{choice} is offered");
        }
        let before = home::now_ms();
        h.click(h.text_at("For 1 hour").unwrap());
        let after = home::now_ms();
        let sent = h.sent();
        let until: i64 = sent[0].strip_prefix("paused true until ").expect("a pause with a time").parse().unwrap();
        assert!((before + 3_600_000..=after + 3_600_000).contains(&until), "{sent:?}");
        assert!(h.text_at("For 1 hour").is_none(), "a choice closes the choices");

        h.click(pause);
        h.click(h.text_at("Until tomorrow").unwrap());
        let tomorrow = home::tomorrow_at_eight(home::now_ms(), home::local_offset_secs);
        assert_eq!(h.sent(), vec![format!("paused true until {tomorrow}")]);

        h.click(pause);
        h.click(h.text_at("Until I resume").unwrap());
        assert_eq!(h.sent(), vec!["paused true".to_string()]);

        h.click(h.text_at("Sync now").expect("Sync now is offered"));
        assert_eq!(h.sent(), vec!["sync now".to_string()]);

        // A click elsewhere closes the choices and sends nothing, Sync now's place included (the shield takes it)
        h.click(pause);
        h.click(h.text_at("Sync now").unwrap());
        assert!(h.text_at("For 1 hour").is_none());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(pause);
        h.click(h.text_at("Up to date").unwrap());
        assert!(h.text_at("For 1 hour").is_none());
        assert_eq!(h.sent(), Vec::<String>::new());

        // Paused, by the setting or by the state, offers Resume
        for paused in [home_with(|s| s.settings.paused = true), home_with(|s| s.state = "paused".into())] {
            let mut h = paused;
            assert!(h.text_at("Paused").is_some());
            assert!(h.text_at("Pause").is_none());
            h.click(h.text_at("Resume").expect("Resume is the main button"));
            assert_eq!(h.sent(), vec!["paused false".to_string()]);
            assert!(h.text_at("For 1 hour").is_none(), "Resume is one button");
        }
    }

    #[test]
    fn home_says_until_when_a_pause_ends() {
        let until = home::now_ms() + 30 * 60_000;
        let h = home_with(|s| {
            s.settings.paused = true;
            s.state = "paused".into();
            s.settings.paused_until = Some(until);
        });
        let headline = home::paused_headline(Some(until), home::now_ms(), home::local_offset_secs);
        assert!(headline.starts_with("Paused until "), "{headline}");
        assert!(h.text_at(&headline).is_some(), "{headline}");
    }

    #[test]
    fn the_settings_carry_when_a_pause_ends() {
        let read = |json: &str| serde_json::from_str::<SyncSettings>(json).unwrap().paused_until;
        assert_eq!(read(r#"{"paused":true,"pausedUntil":1800000000000}"#), Some(1_800_000_000_000));
        assert_eq!(read(r#"{"paused":true,"pausedUntil":null}"#), None);
        assert_eq!(read(r#"{"paused":true}"#), None); // an older daemon
    }

    #[test]
    fn a_pause_request_carries_its_time_only_when_it_has_one() {
        assert_eq!(pause_request(true, Some(1_800_000_000_000)), serde_json::json!({ "paused": true, "until": 1_800_000_000_000_i64 }));
        assert_eq!(pause_request(true, None), serde_json::json!({ "paused": true }));
        assert_eq!(pause_request(false, None), serde_json::json!({ "paused": false }));
    }

    #[test]
    fn needs_attention_shows_only_when_something_does() {
        let h = home_with(|_| {});
        assert!(h.text_at("Needs attention").is_none());
        let h = home_with(|s| {
            s.stats.error_items = 3;
            s.last_error = Some("Proton Drive couldn't be reached".into());
        });
        assert!(h.text_at("Needs attention").is_some());
        assert!(h.text_at("2 problems need you").is_some());
        assert!(h.text_at("3 files couldn't sync").is_some());
        assert!(h.text_at("Proton Drive couldn't be reached").is_some());
    }

    #[test]
    fn a_conflict_says_both_versions_changed_and_its_resolve_buttons_send_the_choice() {
        let mut h = home_with(|_| {});
        h.event(WorkerEvent::ConflictsLoaded(vec![
            ConflictRecord { id: 7, local_rel_path: "docs/report.pdf".into(), ..Default::default() },
            ConflictRecord { id: 8, local_rel_path: "old.txt".into(), resolved: 1, ..Default::default() },
        ]));
        assert!(h.text_at("Changed here and in Proton Drive: report.pdf").is_some());
        assert!(h.text_at("Changed here and in Proton Drive: old.txt").is_none(), "a resolved conflict is not listed");
        for wrong in ["Both copies kept: report.pdf", "Both copies kept: old.txt"] {
            assert!(h.text_at(wrong).is_none(), "{wrong}");
        }
        assert!(h.text_at("Show in Files").is_some());
        // Keep Both, which replaces nothing, is the one that looks like the main choice
        let both = h.text_at("Keep Both").unwrap();
        let local = h.text_at("Keep Local").unwrap();
        assert!(both.x < local.x, "Keep Both comes first");
        assert_eq!(h.fill_under(both), Some(PROTON_PURPLE));
        assert_ne!(h.fill_under(local), Some(PROTON_PURPLE));
        assert_ne!(h.fill_under(h.text_at("Keep Remote").unwrap()), Some(PROTON_PURPLE));
        h.click(h.text_at("Keep Both").expect("the conflict's resolve buttons are painted"));
        assert_eq!(h.sent(), vec!["resolve 7 keep-both".to_string()]);
        h.click(h.text_at("Keep Local").unwrap());
        assert_eq!(h.sent(), vec!["resolve 7 keep-local".to_string()]);
        h.click(h.text_at("Keep Remote").unwrap());
        assert_eq!(h.sent(), vec!["resolve 7 keep-remote".to_string()]);
        // They wait for the daemon, as Pause and Sync now do
        h.app.daemon_online = false;
        h.frames(2);
        for label in ["Keep Both", "Keep Local", "Keep Remote"] {
            h.click(h.text_at(label).unwrap());
        }
        assert_eq!(h.sent(), Vec::<String>::new());
        h.app.daemon_online = true;
        h.frames(2);
        // A refused resolve is shown in the card
        h.event(WorkerEvent::ConflictResolved(Err("The file changed again".into())));
        assert!(h.text_at("The file changed again").is_some());
    }

    #[test]
    fn conflicts_reload_on_every_status_while_one_is_open() {
        let mut h = Harness::new();
        let mut status = h.app.status.clone();
        status.stats.unresolved_conflicts = 1;
        for _ in 0..2 {
            h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status.clone())), activity: Vec::new() });
            assert!(h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadConflicts)));
        }
        status.stats.unresolved_conflicts = 0;
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status.clone())), activity: Vec::new() });
        assert!(h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadConflicts)), "the count changed");
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert!(!h.commands.try_iter().any(|c| matches!(c, WorkerCommand::LoadConflicts)), "nothing open, nothing new");
    }

    #[test]
    fn the_drive_not_mounted_is_on_home_with_mount_again() {
        let mut h = home_with(|s| s.vfs = Some(vfs("virtual", false, Some("ejected"))));
        assert!(h.text_at("Virtual drive: ejected").is_some());
        h.click(h.text_at("Mount again").expect("Mount again is offered"));
        assert_eq!(h.sent(), vec!["mount again".to_string()]);
        // Nothing else is sent while it runs
        h.click(h.text_at("Mount again").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.event(WorkerEvent::DriveDone(Err("The drive is stopping".into())));
        assert!(h.text_at("The drive is stopping").is_some());

        // Not offered when the daemon can't mount it again
        let h = home_with(|s| s.vfs = Some(vfs("virtual", false, Some("different-disk"))));
        assert!(h.text_at("Mount again").is_none());
    }

    #[test]
    fn a_stopped_move_is_on_home_with_its_actions() {
        let stopped = VfsStatus {
            error: Some("Disk full".into()),
            drive_move: Some(drive_move("relocation", None, &["move-back", "retry"])),
            ..vfs("plain", false, Some("move-failed"))
        };
        let mut h = home_with(|s| s.vfs = Some(stopped));
        assert!(h.text_at("Moving files stopped: Disk full").is_some());
        assert!(h.text_at("Moving the Proton Drive folder didn't finish").is_some());
        h.click(h.text_at("Move files back").expect("the move's actions are offered"));
        assert_eq!(h.sent(), vec!["move-back /home/u/ProtonDrive -> /mnt/b/ProtonDrive".to_string()]);
    }

    #[test]
    fn a_stopped_move_is_on_home_while_the_drive_is_mounted_again() {
        let mounted = VfsStatus {
            drive_move: Some(drive_move("relocation", Some("Permission denied"), &["retry"])),
            ..vfs("virtual", true, None)
        };
        let mut h = home_with(|s| s.vfs = Some(mounted));
        assert!(h.text_at("Needs attention").is_some());
        assert!(h.text_at("Moving the Proton Drive folder didn't finish").is_some());
        assert!(h.text_at("Permission denied").is_some());
        // Not the mounted line as if it were a problem
        assert!(h.text_at("Virtual drive: mounted at /home/u/ProtonDrive").is_none());
        h.click(h.text_at("Try again").expect("the move's actions are offered"));
        assert_eq!(h.sent(), vec!["retry /home/u/ProtonDrive -> /mnt/b/ProtonDrive".to_string()]);
    }

    #[test]
    fn the_signed_out_screenshot_flag_lays_no_account_over_every_status() {
        let mut h = Harness::new();
        h.app.fake_signed_out = true;
        let mut status = h.app.status.clone();
        status.account = Some(AccountInfo { email: "gc@proton.me".into(), ..Default::default() });
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert!(!h.app.status.logged_in);
        assert_eq!(h.app.status.state, "unauthenticated");
        assert!(h.app.status.account.is_none());
        assert!(h.text_at("Signed out").is_some());
    }

    #[test]
    fn the_account_mismatch_screenshot_flag_lays_it_over_every_status() {
        let mut h = Harness::new();
        h.app.fake_account_mismatch = true;
        let status = h.app.status.clone();
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert!(h.app.status.account_mismatch.is_some());
        assert_eq!(h.app.status.state, "error");
        assert_eq!(h.app.attention.first(), Some(&home::Attention::AccountMismatch));
        assert!(h.text_at("Start fresh with this account").is_some());
    }

    #[test]
    fn signed_out_home_offers_sign_in_and_not_pause() {
        let mut h = home_with(|s| {
            s.logged_in = false;
            s.state = "unauthenticated".into();
        });
        assert!(h.text_at("Signed out").is_some());
        assert!(h.text_at("Sign in to sync your files").is_some());
        assert!(h.text_at("Up to date").is_none());
        for gone in ["Pause", "Resume", "Sync now"] {
            assert!(h.text_at(gone).is_none(), "{gone}");
        }
        h.click(h.text_at("Sign in").expect("Sign in is offered on Home while signed out"));
        assert_eq!(h.sent(), vec!["sign in".to_string()]);
    }

    #[test]
    fn home_says_connecting_until_the_first_answer() {
        let mut h = home_with(|_| {});
        h.app.daemon_online = false;
        h.app.initial_connecting = true;
        h.frames(2);
        assert!(h.text_at("Connecting…").is_some());
        assert!(h.text_at("Can't reach Proton Drive's background service").is_none());
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Err("refused".into())), activity: Vec::new() });
        assert!(h.text_at("Can't reach Proton Drive's background service").is_some());
    }

    #[test]
    fn in_progress_shows_the_first_five_transfers_then_how_many_more() {
        let h = home_with(|_| {});
        assert!(h.text_at("In progress").is_none());
        let h = home_with(|s| {
            s.state = "syncing".into();
            s.active_transfers = (0..7)
                .map(|i| ActiveTransfer {
                    id: i.to_string(),
                    direction: "upload".into(),
                    rel_path: format!("a{i}.txt"),
                    bytes_transferred: 1,
                    total_bytes: 2,
                })
                .collect();
        });
        assert!(h.text_at("In progress").is_some());
        assert!(h.text_at("a4.txt").is_some());
        assert!(h.text_at("a5.txt").is_none());
        assert!(h.text_at("2 more").is_some());
    }

    // #201: a delete through the drive goes to the Proton Drive trash, which the app opens in the browser, from Home
    // and from Settings' account card; a screenshot opens nothing (nor does the sidebar's Open in Files)
    #[test]
    fn the_proton_drive_trash_opens_in_the_browser_from_home_and_settings() {
        let launched = || home::LAUNCHED.with(|l| std::mem::take(&mut *l.borrow_mut()));
        launched();
        let mut h = home_with(|s| s.sync_dir = "/srv/u/ProtonDrive".into());
        h.click(h.text_at("Trash").expect("the trash is offered on Home"));
        assert_eq!(launched(), vec!["https://drive.proton.me/trash".to_string()]);
        h.click(h.text_at("Open in Files").unwrap());
        assert_eq!(launched(), vec!["/srv/u/ProtonDrive".to_string()]);
        assert_eq!(h.sent(), Vec::<String>::new()); // nothing goes to the daemon
        // Not before a folder is set up
        let h = home_with(|s| s.sync_dir = String::new());
        assert!(h.text_at("Trash").is_none());

        let mut h = Harness::settings(None, None);
        h.app.status.logged_in = true;
        h.frames(2);
        h.click(h.text_at("Open Proton Drive Trash").expect("the trash is offered in Settings"));
        assert_eq!(launched(), vec!["https://drive.proton.me/trash".to_string()]);
        h.click(h.text_at("Open Proton Drive on the web").expect("Proton Drive on the web is offered"));
        assert_eq!(launched(), vec!["https://drive.proton.me".to_string()]);
        // Signed out, Sign in is the one thing to do
        h.app.status.logged_in = false;
        h.frames(2);
        assert!(h.text_at("Open Proton Drive Trash").is_none());
        assert!(h.text_at("Open Proton Drive on the web").is_none());

        // A screenshot opens nothing, from the same buttons
        home::AS_SCREENSHOT.with(|s| s.set(true));
        let mut h = home_with(|s| s.sync_dir = "/srv/u/ProtonDrive".into());
        h.click(h.text_at("Trash").unwrap());
        h.click(h.text_at("Open in Files").unwrap());
        home::AS_SCREENSHOT.with(|s| s.set(false));
        assert_eq!(launched(), Vec::<String>::new(), "a screenshot opens nothing");
    }

    #[test]
    fn home_offers_trash_with_its_old_hover() {
        let mut h = home_with(|s| s.sync_dir = "/srv/u/ProtonDrive".into());
        let label = h.text_at("Trash").expect("Home offers Trash");
        assert!(h.text_at("Open Proton Drive Trash").is_none(), "the long name is Settings'");
        let glyph = h.text_at(icons::TRASH).expect("the trash icon is painted");
        assert!(glyph.x < label.x && (glyph.y - label.y).abs() < 4.0, "the icon {glyph:?} is before the label {label:?}");
        tooltips_at_once(&h);
        hover(&mut h, label);
        assert!(h.text_at(&home::trash_hover("/srv/u/ProtonDrive")).is_some(), "hovering Trash says where restored files go");
    }

    #[test]
    fn home_buttons_carry_their_icons_before_their_labels() {
        let h = home_with(|s| {
            s.sync_dir = "/srv/u/ProtonDrive".into();
            s.stats.total_bytes = 1024;
        });
        for (label, icon) in [("Sync now", icons::SYNC), ("Pause", icons::PAUSE), ("Free up space…", icons::ONLINE_ONLY)] {
            let at = h.text_at(label).unwrap_or_else(|| panic!("{label}"));
            let glyph = h.text_at(icon).unwrap_or_else(|| panic!("{label}'s icon is painted"));
            assert!(glyph.x < at.x && (glyph.y - at.y).abs() < 4.0, "{label}'s icon {glyph:?} is before it at {at:?}");
        }
        let h = home_with(|s| s.settings.paused = true);
        assert!(h.text_at(icons::RESUME).is_some() && h.text_at("Resume").is_some());
    }

    #[test]
    fn the_trash_hover_says_where_restored_files_come_back() {
        assert_eq!(
            home::trash_hover(""),
            "Deleted files stay here until you empty the trash or restore them. Restoring brings them back to ~/ProtonDrive."
        );
        assert!(home::trash_hover("/srv/u/Elsewhere").ends_with("Restoring brings them back to /srv/u/Elsewhere."));
    }

    #[test]
    fn your_drive_shows_where_it_is_and_frees_up_space_after_asking() {
        let mut h = home_with(|s| {
            s.sync_dir = "/srv/u/ProtonDrive".into();
            s.vfs = Some(vfs("virtual", true, None));
            s.stats.total_bytes = 169 * 1024 * 1024;
            s.account = Some(AccountInfo { used_space: 51 * GB, max_space: 510 * GB, used_drive_space: GB, ..Default::default() });
        });
        assert!(h.text_at("Your drive").is_some());
        assert!(h.text_at("/srv/u/ProtonDrive").is_some());
        assert!(h.text_at("Virtual drive · mounted").is_some());
        assert!(h.text_at("On this computer").is_some());
        assert!(h.text_at("169.0 MB").is_some());
        h.click(h.text_at("Free up space…").expect("Free up space is offered"));
        assert_eq!(h.app.pending_confirm, Some(PendingConfirm::FreeAll { rel_path: String::new() }));
        assert_eq!(h.sent(), Vec::<String>::new());

        let h = home_with(|s| s.account = None);
        assert!(h.text_at("Plain folder").is_some());
    }

    #[test]
    fn freeing_up_the_whole_drive_asks_in_plain_words() {
        let copy = confirm_copy(&PendingConfirm::FreeAll { rel_path: String::new() }, true);
        assert_eq!(copy.title, "Free up space on this computer?");
        assert!(copy.body.contains("stay in Proton Drive"), "{}", copy.body);
        assert!(copy.body.contains("in Files as online-only"), "{}", copy.body);
        for text in [&copy.title, &copy.body, &copy.detail.to_string()] {
            assert!(!text.contains("My files"), "{text}");
        }
        assert_eq!((copy.rel_path.as_str(), copy.action), ("", "free"));
        // A plain folder doesn't show online-only files in Files: the dialog never says it does
        let plain = confirm_copy(&PendingConfirm::FreeAll { rel_path: String::new() }, false);
        assert_eq!(plain.title, copy.title);
        assert!(plain.body.contains("stay in Proton Drive"), "{}", plain.body);
        assert!(!plain.body.contains("in Files as online-only"), "{}", plain.body);
        assert!(!plain.body.contains("download again when you open them"), "{}", plain.body);
        assert!(plain.body.contains("don't show in Files"), "{}", plain.body);
        assert_eq!((plain.rel_path.as_str(), plain.action), ("", "free"));
    }

    fn vfs(mode: &str, mounted: bool, reason: Option<&str>) -> VfsStatus {
        VfsStatus { mode: mode.into(), mounted, reason: reason.map(String::from), ..Default::default() }
    }

    fn drive_move(kind: &str, error: Option<&str>, actions: &[&str]) -> DriveMove {
        DriveMove {
            kind: kind.into(),
            from: "/home/u/ProtonDrive".into(),
            to: "/mnt/b/ProtonDrive".into(),
            error: error.map(String::from),
            actions: actions.iter().map(|a| a.to_string()).collect(),
        }
    }

    #[test]
    fn drive_status_line_says_each_state() {
        let dir = "/home/u/ProtonDrive";
        let line = |v: VfsStatus| drive_status_line(&v, dir);
        assert_eq!(line(vfs("virtual", true, None)), "Virtual drive: mounted at /home/u/ProtonDrive");
        assert_eq!(line(vfs("virtual", false, Some("ejected"))), "Virtual drive: ejected");
        assert_eq!(line(vfs("plain", false, Some("fuse-unavailable"))), "Plain folder: FUSE isn't available on this system");
        // Files still in the drive's store with FUSE gone: the next start moves them back
        assert_eq!(line(vfs("virtual", false, Some("fuse-unavailable"))), "Plain folder: FUSE isn't available on this system");
        assert_eq!(line(vfs("plain", false, Some("switched-off"))), "Plain folder: virtual drive switched off");
        assert_eq!(line(vfs("virtual", false, Some("crashed"))), "Virtual drive: stopped after repeated crashes");
        assert_eq!(line(vfs("virtual", false, Some("starting"))), "Virtual drive: starting…");
        assert_eq!(line(vfs("virtual", false, Some("mount-point-busy"))), "Virtual drive: couldn't mount, the folder is busy");
        assert_eq!(
            line(vfs("plain", false, Some("different-disk"))),
            "Plain folder: the Proton Drive folder is on another disk than the app's data"
        );
        assert_eq!(line(vfs("plain", false, Some("moving"))), "Moving files…");
        assert_eq!(line(vfs("virtual", false, Some("moving"))), "Moving files…");
    }

    #[test]
    fn drive_status_line_says_why_a_move_stopped() {
        let dir = "/home/u/ProtonDrive";
        let failed = |error: Option<&str>, mv: Option<DriveMove>| VfsStatus {
            error: error.map(String::from),
            drive_move: mv,
            ..vfs("plain", false, Some("move-failed"))
        };
        assert_eq!(
            drive_status_line(&failed(Some("No space left on device"), None), dir),
            "Moving files stopped: No space left on device"
        );
        // vfs.error first, then the move's own error, then a placeholder
        let mv = drive_move("layout", Some("Permission denied"), &["finish"]);
        assert_eq!(drive_status_line(&failed(Some("Disk full"), Some(mv.clone())), dir), "Moving files stopped: Disk full");
        assert_eq!(drive_status_line(&failed(None, Some(mv.clone())), dir), "Moving files stopped: Permission denied");
        assert_eq!(drive_status_line(&failed(Some("  "), Some(mv)), dir), "Moving files stopped: Permission denied");
        assert_eq!(drive_status_line(&failed(None, None), dir), "Moving files stopped: unknown error");
        assert_eq!(
            drive_status_line(&failed(None, Some(drive_move("relocation", None, &["retry"]))), dir),
            "Moving files stopped: unknown error"
        );
    }

    #[test]
    fn drive_status_line_falls_back_on_the_mode_for_states_it_does_not_know() {
        let dir = "/home/u/ProtonDrive";
        assert_eq!(drive_status_line(&vfs("plain", false, None), dir), "Plain folder at /home/u/ProtonDrive");
        assert_eq!(drive_status_line(&vfs("virtual", false, None), dir), "Virtual drive: not mounted");
        assert_eq!(drive_status_line(&vfs("virtual", false, Some("something-new")), dir), "Virtual drive: not mounted");
        assert_eq!(drive_status_line(&vfs("plain", false, Some("something-new")), dir), "Plain folder at /home/u/ProtonDrive");
    }

    #[test]
    fn mount_again_is_offered_only_for_an_unmounted_virtual_drive_that_can_mount_again() {
        for reason in ["ejected", "crashed", "mount-point-busy"] {
            assert!(offers_mount_again(&vfs("virtual", false, Some(reason))), "{reason}");
            assert!(!offers_mount_again(&vfs("plain", false, Some(reason))), "plain {reason}");
            assert!(!offers_mount_again(&vfs("virtual", true, Some(reason))), "mounted {reason}");
        }
        for reason in [None, Some("starting"), Some("moving"), Some("move-failed"), Some("fuse-unavailable"), Some("switched-off")] {
            assert!(!offers_mount_again(&vfs("virtual", false, reason)), "{reason:?}");
        }
    }

    #[test]
    fn files_safe_hint_tells_how_to_see_the_files_while_the_drive_cannot() {
        let mount_hint = Some("Your files are safe. To see them, click Mount again, or switch the virtual drive off.");
        assert_eq!(files_safe_hint(&vfs("virtual", false, Some("crashed"))), mount_hint);
        assert_eq!(files_safe_hint(&vfs("virtual", false, Some("mount-point-busy"))), mount_hint);
        let failed = |mv: Option<DriveMove>| VfsStatus { drive_move: mv, ..vfs("plain", false, Some("move-failed")) };
        assert_eq!(
            files_safe_hint(&failed(Some(drive_move("layout", None, &["finish", "move-back"])))),
            Some("Your files are safe. To see them, carry on with the move or move the files back below.")
        );
        assert_eq!(files_safe_hint(&failed(None)), Some("Your files are safe. To see them, switch the virtual drive off."));
        for reason in [None, Some("ejected"), Some("starting"), Some("moving"), Some("switched-off"), Some("different-disk")] {
            assert_eq!(files_safe_hint(&vfs("virtual", false, reason)), None, "{reason:?}");
        }
    }

    #[test]
    fn move_actions_have_their_buttons() {
        assert_eq!(move_action_label("finish"), Some("Finish moving files"));
        assert_eq!(move_action_label("move-back"), Some("Move files back"));
        assert_eq!(move_action_label("retry"), Some("Try again"));
        assert_eq!(move_action_label("explode"), None);
    }

    #[test]
    fn daemon_status_reads_the_drive_and_still_reads_a_stage_1_daemon() {
        let base = r#""state":"idle","currentAction":null,"loggedIn":true,"syncDir":"/home/u/ProtonDrive","activeTransfers":[],
            "stats":{"totalFiles":1,"totalFolders":0,"totalBytes":3,"unresolvedConflicts":0,"errorItems":0},
            "settings":{"syncDir":"/home/u/ProtonDrive","conflictStrategy":"keep-both","notificationsEnabled":true,
                        "reconcileIntervalSec":120,"paused":false,"ignorePatterns":[".git"]}"#;
        let old: DaemonStatus = serde_json::from_str(&format!("{{{base}}}")).unwrap();
        assert_eq!(old.vfs, None);
        assert_eq!(old.virtual_drive_wanted, None);

        let plain: DaemonStatus = serde_json::from_str(&format!(
            r#"{{{base},"vfs":{{"mode":"plain","mounted":false,"reason":"switched-off"}},"virtualDriveWanted":false}}"#
        ))
        .unwrap();
        assert_eq!(plain.vfs, Some(vfs("plain", false, Some("switched-off"))));
        assert_eq!(plain.virtual_drive_wanted, Some(false));

        let stopped: DaemonStatus = serde_json::from_str(&format!(
            r#"{{{base},"vfs":{{"mode":"virtual","mounted":false,"reason":"move-failed","error":"Disk full",
                "move":{{"kind":"relocation","from":"/home/u/ProtonDrive","to":"/mnt/b/ProtonDrive","error":null,
                         "actions":["move-back","retry"]}}}},"virtualDriveWanted":true}}"#
        ))
        .unwrap();
        let v = stopped.vfs.unwrap();
        assert_eq!((v.reason.as_deref(), v.error.as_deref()), (Some("move-failed"), Some("Disk full")));
        assert_eq!(v.drive_move, Some(drive_move("relocation", None, &["move-back", "retry"])));

        let mounted: VfsStatus = serde_json::from_str(r#"{"mode":"virtual","mounted":true,"reason":null}"#).unwrap();
        assert_eq!(mounted, vfs("virtual", true, None));
    }

    fn loaded_settings() -> SyncSettings {
        SyncSettings {
            sync_dir: "/home/u/ProtonDrive".into(),
            conflict_strategy: "keep-both".into(),
            notifications_enabled: true,
            reconcile_interval_sec: 120,
            paused: false,
            paused_until: None,
            ignore_patterns: vec![".git".into(), "*.part".into()],
            blocked_apps: Vec::new(),
            start_at_login: true,
        }
    }

    #[test]
    fn settings_save_sends_only_the_fields_that_changed() {
        let loaded = loaded_settings();
        let changes = |dir: &str, strategy: &str, notify: bool, ignore: &str| {
            serde_json::Value::Object(settings_changes(&loaded, dir, strategy, notify, loaded.start_at_login, ignore))
        };
        let same = ".git\n*.part";
        assert_eq!(changes("/home/u/ProtonDrive", "keep-both", true, same), serde_json::json!({}));
        assert_eq!(
            changes("/home/u/ProtonDrive", "prompt", true, same),
            serde_json::json!({ "conflictStrategy": "prompt" })
        );
        assert_eq!(changes("/home/u/ProtonDrive", "keep-both", false, same), serde_json::json!({ "notificationsEnabled": false }));
        assert_eq!(changes(" /mnt/b/ProtonDrive ", "keep-both", true, same), serde_json::json!({ "syncDir": "/mnt/b/ProtonDrive" }));
        // Spacing, blank lines and a trailing newline are no edit: the list as loaded is never written back
        assert_eq!(changes("/home/u/ProtonDrive/", "keep-both", true, "  .git \n\n*.part\n"), serde_json::json!({ "syncDir": "/home/u/ProtonDrive/" }));
        assert_eq!(changes("/home/u/ProtonDrive ", "keep-both", true, "  .git \n\n*.part\n"), serde_json::json!({}));
        assert_eq!(
            changes("/home/u/ProtonDrive", "keep-both", true, ".git\n*.part\nnode_modules"),
            serde_json::json!({ "ignorePatterns": [".git", "*.part", "node_modules"] })
        );
        assert_eq!(
            changes("/mnt/x", "prompt", false, ""),
            serde_json::json!({ "syncDir": "/mnt/x", "conflictStrategy": "prompt", "notificationsEnabled": false, "ignorePatterns": [] })
        );
    }

    // #92: the Start at login switch is saved like the others, and reads as on from a daemon that doesn't send it
    #[test]
    fn start_at_login_is_sent_only_when_changed_and_on_unless_said_otherwise() {
        let loaded = loaded_settings();
        let same = ".git\n*.part";
        let changes = |start: bool| {
            serde_json::Value::Object(settings_changes(&loaded, "/home/u/ProtonDrive", "keep-both", true, start, same))
        };
        assert!(loaded.start_at_login);
        assert_eq!(changes(true), serde_json::json!({}));
        assert_eq!(changes(false), serde_json::json!({ "startAtLogin": false }));
        let older: SyncSettings = serde_json::from_value(serde_json::json!({ "syncDir": "/home/u/ProtonDrive" })).unwrap();
        assert!(older.start_at_login);
        let off: SyncSettings = serde_json::from_value(serde_json::json!({ "startAtLogin": false })).unwrap();
        assert!(!off.start_at_login);
    }

    #[test]
    fn ignore_patterns_are_one_per_line_trimmed_without_blank_lines() {
        assert_eq!(parse_ignore_patterns(" .git \n\n\t*.part\r\n"), vec![".git".to_string(), "*.part".to_string()]);
        assert!(parse_ignore_patterns("\n  \n").is_empty());
    }

    #[test]
    fn settings_reply_reads_the_stored_settings_and_the_refusals() {
        let reply: SettingsReply = serde_json::from_value(serde_json::json!({
            "ok": true,
            "settings": { "syncDir": "/home/u/ProtonDrive", "conflictStrategy": "keep-both", "notificationsEnabled": true,
                          "reconcileIntervalSec": 120, "paused": false, "ignorePatterns": [".git", "*.part"] },
            "virtualDriveWanted": true,
            "vfs": { "mode": "virtual", "mounted": true, "reason": null },
            "folderError": "The new folder must be empty",
            "switchError": null
        }))
        .unwrap();
        assert_eq!(reply.settings, Some(loaded_settings()));
        assert_eq!(reply.virtual_drive_wanted, Some(true));
        assert_eq!(reply.vfs, Some(vfs("virtual", true, None)));
        assert_eq!(reply.problem().as_deref(), Some("The new folder must be empty"));

        let both = SettingsReply { folder_error: Some("A".into()), switch_error: Some("B".into()), ..Default::default() };
        assert_eq!(both.problem().as_deref(), Some("A\nB"));
        let none = SettingsReply { folder_error: None, switch_error: Some(String::new()), ..Default::default() };
        assert_eq!(none.problem(), None);
    }

    /// The JSON body of a request `serve_once` saw.
    fn request_body(request: &str) -> serde_json::Value {
        serde_json::from_str(request.split_once("\r\n\r\n").map_or("", |(_, body)| body)).unwrap_or(serde_json::Value::Null)
    }

    #[test]
    fn sign_in_goes_over_the_control_socket_and_a_refusal_is_an_error() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"signInUrl\":\"https://account.proton.me/x\",\"disclosure\":\"d\"}";
        let (sock, server) = serve_once(reply);
        assert_eq!(sign_in_at(&sock).unwrap().sign_in_url, "https://account.proton.me/x");
        assert!(server.join().unwrap().starts_with("POST /auth/login HTTP/1.1\r\n"));

        // The page wasn't ready in time: still a sign-in in progress, with no URL to show
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"signInUrl\":\"\",\"disclosure\":\"d\"}";
        let (sock, server) = serve_once(reply);
        assert_eq!(sign_in_at(&sock).unwrap().sign_in_url, "");
        server.join().unwrap();

        for reply in [
            &b"HTTP/1.1 500 Internal Server Error\r\n\r\n{\"error\":\"Proton is unreachable\",\"code\":\"EIO\"}"[..],
            &b"HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"Not found\"}  "[..],
        ] {
            let (sock, server) = serve_once(reply);
            let err = sign_in_at(&sock).unwrap_err();
            server.join().unwrap();
            assert!(err == "Proton is unreachable" || err == "Not found", "{err}");
        }
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn sign_out_goes_over_the_control_socket() {
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}");
        sign_out_at(&sock).unwrap();
        assert!(server.join().unwrap().starts_with("POST /auth/logout HTTP/1.1\r\n"));
    }

    #[test]
    fn settings_are_saved_over_the_control_socket_and_a_400_is_shown() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"settings\":{\"syncDir\":\"/home/u/ProtonDrive\",\"conflictStrategy\":\"prompt\",\"notificationsEnabled\":true,\"reconcileIntervalSec\":120,\"paused\":false,\"ignorePatterns\":[]},\"virtualDriveWanted\":true,\"vfs\":{\"mode\":\"virtual\",\"mounted\":true,\"reason\":null},\"folderError\":null,\"switchError\":null}";
        let (sock, server) = serve_once(reply);
        let body = serde_json::json!({ "conflictStrategy": "prompt" });
        let got = save_settings_at(&sock, &body).unwrap();
        assert_eq!(got.problem(), None);
        assert_eq!(got.settings.unwrap().conflict_strategy, "prompt");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /drive/settings HTTP/1.1\r\n"), "{request}");
        assert_eq!(request_body(&request), serde_json::json!({ "conflictStrategy": "prompt" }));

        let (sock, server) = serve_once(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"Unknown setting: x\",\"code\":\"EINVAL\"}");
        assert_eq!(save_settings_at(&sock, &serde_json::json!({ "x": 1 })).unwrap_err(), "Unknown setting: x");
        server.join().unwrap();
    }

    #[test]
    fn mount_again_and_move_actions_go_over_the_control_socket() {
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true} ");
        mount_again_at(&sock).unwrap();
        assert!(server.join().unwrap().starts_with("POST /vfs/mount HTTP/1.1\r\n"));

        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}  ");
        drive_move_at(&sock, "move-back", "/home/u/ProtonDrive", "/mnt/b/ProtonDrive").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /drive/move HTTP/1.1\r\n"), "{request}");
        assert_eq!(
            request_body(&request),
            serde_json::json!({ "action": "move-back", "from": "/home/u/ProtonDrive", "to": "/mnt/b/ProtonDrive" })
        );

        // 409 and 500 bodies reach the user
        let (sock, server) = serve_once(b"HTTP/1.1 409 Conflict\r\n\r\n{\"error\":\"Nothing is waiting to be finished or moved back\",\"move\":null}");
        assert_eq!(drive_move_at(&sock, "finish", "a", "b").unwrap_err(), "Nothing is waiting to be finished or moved back");
        server.join().unwrap();
        let (sock, server) = serve_once(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"The virtual drive is off: Proton Drive is a plain folder\",\"code\":\"EIO\"}");
        assert_eq!(mount_again_at(&sock).unwrap_err(), "The virtual drive is off: Proton Drive is a plain folder");
        server.join().unwrap();
    }

    #[test]
    fn conflicts_are_resolved_over_the_control_socket() {
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"conflict\":{}}");
        resolve_conflict_at(&sock, 7, "keep-local").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /conflicts/resolve HTTP/1.1\r\n"), "{request}");
        assert_eq!(request_body(&request), serde_json::json!({ "id": 7, "choice": "keep-local" }));

        let (sock, server) = serve_once(b"HTTP/1.1 409 Conflict\r\n\r\n{\"error\":\"That conflict is resolved already\",\"code\":\"EEXIST\"}");
        assert_eq!(resolve_conflict_at(&sock, 7, "keep-both").unwrap_err(), "That conflict is resolved already");
        server.join().unwrap();
    }

    #[test]
    fn writes_that_can_move_files_wait_long_and_sign_in_waits_for_the_browser() {
        assert_eq!(DRIVE_READ_TIMEOUT, Duration::from_secs(600));
        assert_eq!(RESOLVE_READ_TIMEOUT, Duration::from_secs(600));
        assert!(LOGIN_READ_TIMEOUT >= Duration::from_secs(10), "the daemon waits up to 3 s for the sign-in page");
        assert!(LOGOUT_READ_TIMEOUT >= Duration::from_secs(30));
    }

    #[test]
    fn screenshot_mode_only_reads() {
        let reads = [WorkerCommand::RefreshAll, WorkerCommand::LoadConflicts];
        for cmd in &reads {
            assert!(allowed_in_screenshot_mode(cmd));
        }
        let window = share::ShareWindow::new("/a.pdf").id;
        let writes = [
            WorkerCommand::TriggerSync,
            WorkerCommand::SetPaused { paused: true, until: None },
            WorkerCommand::SetPaused { paused: true, until: Some(1_800_000_000_000) },
            WorkerCommand::SetPaused { paused: false, until: None },
            WorkerCommand::StartLogin,
            WorkerCommand::Logout,
            WorkerCommand::SaveSettings(serde_json::json!({})),
            WorkerCommand::SetVirtualDrive(false),
            WorkerCommand::MountAgain,
            WorkerCommand::DriveMove { action: "finish".into(), from: "a".into(), to: "b".into() },
            WorkerCommand::ResolveConflict { id: 1, choice: "keep-both".into() },
            WorkerCommand::SetAvailability { path: "x".into(), action: "pin".into() },
            WorkerCommand::SetAvailability { path: "Music".into(), action: "unhide".into() },
            // A read, but over the control socket, which a screenshot never calls
            WorkerCommand::LoadHidden,
            WorkerCommand::ResolveFilesMissing { choice: MissingChoice::DeleteInCloud, root: "/r".into(), names: vec!["Docs".into()] },
            WorkerCommand::ResolveFilesMissing { choice: MissingChoice::KeepOnlineOnly, root: "/r".into(), names: vec!["Docs".into()] },
            WorkerCommand::StartFresh,
            // The Share window's reads and changes: all over the control socket (#216)
            WorkerCommand::ShareLoad { window, rel_path: "a.pdf".into() },
            // The Shared section's read and its Stop sharing (#253)
            WorkerCommand::SharedLoad { seq: 1 },
            WorkerCommand::SharedStop { rel_path: "a.pdf".into(), uid: "vol~a".into() },
            WorkerCommand::SharePassword { window, rel_path: "a.pdf".into() },
            WorkerCommand::ShareEnsureLink { window, rel_path: "a.pdf".into() },
            WorkerCommand::ShareSettings { window, rel_path: "a.pdf".into(), password: Some(None), expires_at: None },
            WorkerCommand::ShareRemoveLink { window, rel_path: "a.pdf".into() },
            WorkerCommand::ShareInvite { window, rel_path: "a.pdf".into(), emails: vec!["a@b.co".into()], role: share::Role::Viewer },
            WorkerCommand::ShareRole { window, rel_path: "a.pdf".into(), email: "a@b.co".into(), role: share::Role::Editor },
            WorkerCommand::ShareRemovePerson { window, rel_path: "a.pdf".into(), email: "a@b.co".into() },
        ];
        for cmd in &writes {
            assert!(!allowed_in_screenshot_mode(cmd));
        }
    }

    const SWITCH: &str = "Show online-only files in Files (virtual drive)";

    // S39: while the files are missing from the folder, the daemon holds; the app says so on every tab, and deleting
    // them from Proton Drive too takes a confirmation, with keeping waiting as the default
    const MISSING: &str = "Proton Drive's files are missing from /home/u/ProtonDrive. Nothing was deleted in Proton Drive.";
    const DELETE_TOO: &str = "Delete them from Proton Drive too";
    // #50: or keep them in Proton Drive, online-only, which deletes nothing; the default in the virtual layout
    const KEEP: &str = "Keep them online-only";
    const KEEP_SAYS_PLAIN: &str =
        "Keep them online-only to stop waiting: they stay in Proton Drive as online-only files, and aren't downloaded again. Nothing is deleted.";
    const KEEP_SAYS_VIRTUAL: &str =
        "Keep them online-only to stop waiting: they stay in Proton Drive, and the drive shows them as online-only. Nothing is deleted.";

    fn held(h: &mut Harness) {
        h.app.status.state = "error".into();
        h.app.status.last_error = Some(MISSING.into());
        h.app.status.files_missing =
            Some(FilesMissing { root: "/home/u/ProtonDrive".into(), names: vec!["Docs".into(), "Photos".into()], items: 12, ..Default::default() });
        h.app.refresh_attention();
        h.frames(3);
    }

    #[test]
    fn the_files_missing_hold_shows_in_homes_needs_attention() {
        let mut h = Harness::new();
        assert!(h.text_at(DELETE_TOO).is_none());
        held(&mut h);
        assert!(h.text_at("Needs attention").is_some());
        assert!(h.text_at(DELETE_TOO).is_some());
        assert!(h.text_at(KEEP).is_some());
        assert!(h.text_at("Docs and Photos are missing. Proton Drive waits for them to come back and syncs nothing meanwhile.").is_some());
        // Elsewhere, Home's badge says something needs the user
        for tab in [NavTab::Activity, NavTab::Settings] {
            h.app.tab = tab;
            h.frames(3);
            assert!(h.text_at(DELETE_TOO).is_none(), "{tab:?}");
            assert!(h.text_at("1").is_some(), "{tab:?}: Home's badge");
        }
    }

    // R12: deleting from Proton Drive keeps its danger signal: an outlined button with a red label
    #[test]
    fn the_cloud_delete_choice_stays_red() {
        let mut h = Harness::new();
        held(&mut h);
        let colors: Vec<Color32> = h
            .texts(|t| t.galley.text() == DELETE_TOO)
            .iter()
            .flat_map(|t| t.galley.job.sections.iter().map(|s| s.format.color))
            .collect();
        assert_eq!(colors, vec![STATUS_DANGER], "the label's painted colour");
        assert_eq!(h.fill_under(h.text_at(DELETE_TOO).unwrap()), Some(BG_CARD()), "outlined, not filled");
    }

    // #253: the Shared section
    #[test]
    fn the_sidebar_lists_home_shared_activity_in_that_order() {
        let h = Harness::new();
        let ys: Vec<f32> = ["Home", "Shared", "Activity"].iter().map(|l| h.text_at(l).expect(l).y).collect();
        assert!(ys.windows(2).all(|w| w[0] < w[1]), "{ys:?}");
    }

    // #276: the sidebar as Proton's: the mark, Open in Files, the sections, and the storage meter over the version
    const SIDEBAR_EDGE: f32 = 252.0;
    const GB: u64 = 1024 * 1024 * 1024;

    fn tooltips_at_once(h: &Harness) {
        h.ctx.style_mut(|s| {
            s.interaction.tooltip_delay = 0.0;
            s.interaction.show_tooltips_only_when_still = false;
        });
    }

    fn hover(h: &mut Harness, pos: egui::Pos2) {
        h.frame(vec![egui::Event::PointerMoved(pos)]);
        h.frames(5);
    }

    /// An account using 3 GB of 510 GB, 2 GB of it in Drive.
    fn three_of_510() -> AccountInfo {
        AccountInfo { used_space: 3 * GB, max_space: 510 * GB, used_drive_space: 2 * GB, ..Default::default() }
    }

    #[test]
    fn the_sidebar_offers_home_shared_and_activity_and_no_settings() {
        let h = Harness::new();
        for (label, icon) in [("Home", icons::HOME), ("Shared", icons::SHARED), ("Activity", icons::ACTIVITY)] {
            let at = h.text_at(label).expect(label);
            assert!(at.x < SIDEBAR_EDGE, "{label} at {at:?}");
            let glyph = h.text_at(icon).unwrap_or_else(|| panic!("{label}'s icon is painted"));
            assert!(glyph.x < at.x && (glyph.y - at.y).abs() < 4.0, "{label}'s icon {glyph:?} is before its name {at:?}");
        }
        let settings: Vec<_> = h.text_at_all("Settings").into_iter().filter(|p| p.x < SIDEBAR_EDGE).collect();
        assert_eq!(settings, Vec::<egui::Pos2>::new(), "Settings leaves the sidebar (the top bar's gear opens it)");
        // Nor is the account at its foot any more (it moves to the top bar)
        for gone in ["Not signed in", "Proton Account", "PD"] {
            assert!(h.text_at_all(gone).iter().all(|p| p.x > SIDEBAR_EDGE), "{gone}");
        }
    }

    #[test]
    fn the_open_section_is_filled_and_another_fills_under_the_pointer() {
        let mut h = Harness::new();
        assert_eq!(h.fill_under(h.text_at("Home").unwrap()), Some(SIDEBAR_SELECTED()));
        assert_eq!(h.fill_under(h.text_at("Activity").unwrap()), Some(BG_SIDEBAR()));
        let activity = h.text_at("Activity").unwrap();
        hover(&mut h, activity);
        assert_eq!(h.fill_under(activity), Some(SIDEBAR_HOVER()));
        h.click(activity);
        assert_eq!(h.app.tab, NavTab::Activity);
        assert_eq!(h.fill_under(h.text_at("Activity").unwrap()), Some(SIDEBAR_SELECTED()));
        // The sections are named for screen readers too (the top bar's title is another "Activity")
        for label in ["Home", "Shared", "Activity"] {
            assert!(h.widgets_at_all(label).iter().any(|p| p.x < SIDEBAR_EDGE), "{label}");
        }
    }

    #[test]
    fn open_in_files_in_the_sidebar_opens_the_drive_folder() {
        let launched = || home::LAUNCHED.with(|l| std::mem::take(&mut *l.borrow_mut()));
        launched();
        let mut h = home_with(|s| s.sync_dir = "/home/u/ProtonDrive".into());
        h.sent();
        let open = h.text_at_all(chrome::OPEN_IN_FILES);
        assert_eq!(open.len(), 1, "offered once, in the sidebar, not on Home's card too: {open:?}");
        assert!(open[0].x < SIDEBAR_EDGE, "{open:?}");
        assert!(open[0].y < h.text_at("Home").unwrap().y, "above the sections");
        assert_eq!(h.fill_under(open[0]), Some(PROTON_PURPLE), "the primary button");
        h.click(open[0]);
        assert_eq!(launched(), vec!["/home/u/ProtonDrive".to_string()]);
        assert_eq!(h.sent(), Vec::<String>::new(), "nothing goes to the daemon");
        // A screenshot opens nothing
        home::AS_SCREENSHOT.with(|s| s.set(true));
        h.click(open[0]);
        home::AS_SCREENSHOT.with(|s| s.set(false));
        assert_eq!(launched(), Vec::<String>::new());
    }

    #[test]
    fn open_in_files_waits_for_a_folder() {
        let launched = || home::LAUNCHED.with(|l| std::mem::take(&mut *l.borrow_mut()));
        launched();
        let mut h = home_with(|s| s.sync_dir = String::new());
        tooltips_at_once(&h);
        let open = h.text_at(chrome::OPEN_IN_FILES).expect("still offered, greyed out");
        // A disabled widget fades into the colour it sits on (the sidebar's)
        let faded = egui::ecolor::tint_color_towards(PROTON_PURPLE, BG_SIDEBAR());
        assert_eq!(h.fill_under(open), Some(faded), "greyed out: the primary fill, faded as a disabled widget's is");
        assert_ne!(faded, PROTON_PURPLE);
        hover(&mut h, open);
        assert!(h.text_at(chrome::OPEN_IN_FILES_WAITS).is_some(), "the hover says why");
        h.click(open);
        assert_eq!(launched(), Vec::<String>::new());
    }

    #[test]
    fn the_storage_meter_shows_used_over_total_and_the_version() {
        let mut h = home_with(|s| s.account = Some(three_of_510()));
        tooltips_at_once(&h);
        let text = chrome::storage_meter_text(h.app.status.account.as_ref()).expect("a quota to show");
        assert_eq!(text, "3.0 GB / 510.0 GB");
        let meter = h.text_at(&text).expect("the meter's line is painted");
        let version = h.text_at(env!("CARGO_PKG_VERSION")).expect("the version is painted");
        for at in [meter, version] {
            assert!(at.x < SIDEBAR_EDGE && at.y > 400.0, "at the foot of the sidebar: {at:?}");
        }
        assert!(meter.x < version.x && (meter.y - version.y).abs() < 2.0, "one line: {meter:?}, then {version:?}");
        // The bar, over the line: its track, filled with what is used
        let track = h.rects_filled(STORAGE_TRACK());
        let track = track.iter().find(|r| r.right() <= SIDEBAR_EDGE).expect("the bar's track");
        assert!(track.height() <= 4.0 && track.bottom() < h.text_rect(&text).unwrap().top(), "{track:?}");
        let used = h.rects_filled(STORAGE_FILL());
        let used = used.iter().find(|r| track.contains(r.center())).expect("the used part");
        assert!(used.width() < track.width() / 10.0, "3 GB of 510 GB is a sliver: {used:?} of {track:?}");
        hover(&mut h, meter);
        assert!(h.text_at("Drive uses 2.0 GB").is_some(), "the hover says how much is Drive's");

        // Signed out: the version alone
        h.app.status.account = None;
        h.frames(2);
        assert!(h.text_at(&text).is_none());
        assert!(h.text_at(env!("CARGO_PKG_VERSION")).is_some());
        assert!(h.rects_filled(STORAGE_TRACK()).iter().all(|r| r.right() > SIDEBAR_EDGE), "no bar");
        assert_eq!(chrome::storage_meter_text(None), None);
        assert_eq!(chrome::storage_meter_text(Some(&AccountInfo::default())), None, "no quota, no meter");
    }

    #[test]
    fn home_no_longer_shows_proton_storage() {
        let h = home_with(|s| s.account = Some(three_of_510()));
        assert!(h.text_at("Proton storage").is_none());
        assert!(h.text_at("3.0 GB of 510.0 GB").is_none());
        assert!(h.text_at("Your drive").is_some());
    }

    #[test]
    fn the_sidebar_fits_at_840_by_540_zoomed() {
        let mut h = home_with(|s| s.account = Some(three_of_510()));
        h.app.fake_attention = Some(3);
        h.app.refresh_attention();
        h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2);
        let text = chrome::storage_meter_text(h.app.status.account.as_ref()).unwrap();
        let rect = |label: &str| h.text_rect(label).unwrap_or_else(|| panic!("{label} is painted"));
        let (name, open, home, activity, meter) =
            (rect("Proton Drive"), rect(chrome::OPEN_IN_FILES), rect("Home"), rect("Activity"), rect(&text));
        assert!(name.bottom() < open.top(), "the logo {name:?} is above Open in Files {open:?}");
        assert!(open.bottom() < home.top(), "Open in Files {open:?} is above Home {home:?}");
        assert!(activity.bottom() < meter.top(), "Activity {activity:?} is above the meter {meter:?}");
        assert!(meter.bottom() <= h.screen.y, "the meter {meter:?} is inside the window {:?}", h.screen);
        assert!(rect(env!("CARGO_PKG_VERSION")).right() <= SIDEBAR_EDGE, "the version stays in the sidebar");
    }

    #[test]
    fn the_logo_has_no_dark_tile() {
        let img = image::load_from_memory(LOGO_PNG).expect("the logo is a PNG").to_rgba8();
        assert_eq!(img.dimensions(), (128, 128));
        assert_eq!(img.get_pixel(2, 2)[3], 0, "a corner is transparent");
        assert_eq!(img.get_pixel(64, 0)[3], 0, "the middle of the top edge is transparent: no tile behind the folder");
        assert_eq!(img.get_pixel(64, 64)[3], 255, "the folder is there");
    }

    // #274: the top bar: the section's title, the gear for Settings, and the account, which opens a menu (not Settings)
    fn gautam() -> AccountInfo {
        AccountInfo {
            display_name: "Gautam C".into(),
            email: "gc@proton.me".into(),
            initials: "GC".into(),
            used_space: 51 * GB,
            max_space: 510 * GB,
            ..Default::default()
        }
    }

    /// Home, signed in as `gautam()`, with the account menu open.
    fn account_menu() -> Harness {
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.frames(2);
        h.click(h.widget_at("Account").expect("the account is one button, named Account"));
        assert!(h.app.account_menu_open);
        h
    }

    /// Where the last frame painted this text in the top bar (right of the sidebar, above the section).
    fn in_top_bar(h: &Harness, text: &str) -> Vec<egui::Pos2> {
        h.text_at_all(text).into_iter().filter(|p| p.x > SIDEBAR_EDGE && p.y < chrome::TOP_BAR_HEIGHT).collect()
    }

    #[test]
    fn the_top_bar_titles_each_section_once() {
        let mut h = Harness::new();
        for tab in [NavTab::Home, NavTab::Shared, NavTab::Activity, NavTab::Settings] {
            h.app.open_tab(tab);
            h.frames(3);
            let title = chrome::tab_title(tab);
            let shown: Vec<_> = h.text_at_all(title).into_iter().filter(|p| p.x > SIDEBAR_EDGE).collect();
            assert_eq!(shown.len(), 1, "{tab:?}: {title:?} is shown once beside the sidebar, at {shown:?}");
            assert!(shown[0].y < chrome::TOP_BAR_HEIGHT, "{tab:?}: in the top bar, at {:?}", shown[0]);
        }
        // In bold (the sidebar has no "Settings" to find first)
        assert!(painted_bold(&h, "Settings", f32::MAX));
    }

    #[test]
    fn the_gear_opens_settings() {
        let mut h = Harness::new();
        let gear = h.widget_at("Settings").expect("the gear, named Settings");
        assert!(gear.x > SIDEBAR_EDGE && gear.y < chrome::TOP_BAR_HEIGHT, "in the top bar, at {gear:?}");
        assert_eq!(in_top_bar(&h, icons::SETTINGS).len(), 1, "drawn as the gear");
        h.click(gear);
        assert_eq!(h.app.tab, NavTab::Settings);
        assert_eq!(h.fill_under(gear), Some(PROTON_PURPLE_SOFT()), "it looks pressed while Settings is open");
        h.click(h.text_at("Home").unwrap());
        h.frame(vec![egui::Event::PointerMoved(egui::pos2(600.0, 400.0))]);
        h.frames(2);
        assert_ne!(h.fill_under(gear), Some(PROTON_PURPLE_SOFT()), "and not once it is closed");
    }

    #[test]
    fn clicking_the_account_opens_the_menu_not_settings() {
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.frames(2);
        // The name over the email, then the initials, on the right
        let (name, email, initials) = (in_top_bar(&h, "Gautam C"), in_top_bar(&h, "gc@proton.me"), in_top_bar(&h, "GC"));
        assert!(name.len() == 1 && email.len() == 1 && initials.len() == 1, "{name:?} {email:?} {initials:?}");
        assert!(name[0].y < email[0].y && email[0].x < initials[0].x, "{name:?} {email:?} {initials:?}");
        let gear = h.widget_at("Settings").unwrap();
        assert!(gear.x < name[0].x, "the gear {gear:?} is left of the account {name:?}");
        assert!(h.text_at("Sign out").is_none());

        h.click(h.widget_at("Account").expect("the account is one button, named Account"));
        assert_eq!(h.app.tab, NavTab::Home, "not Settings");
        assert!(h.app.account_menu_open);
        for item in ["Sign out", "Open Proton Drive on the web", "Proton Unlimited", "51.0 GB of 510.0 GB", "Proton storage"] {
            let at = h.text_at(item).unwrap_or_else(|| panic!("the menu shows {item:?}"));
            assert!(at.y > chrome::TOP_BAR_HEIGHT, "{item:?}: under the top bar, at {at:?}");
        }
        assert_eq!(h.sent(), Vec::<String>::new(), "opening it does nothing else");
    }

    #[test]
    fn sign_out_in_the_menu_signs_out_at_once_and_closes_it() {
        let mut h = account_menu();
        h.click(h.text_at("Sign out").unwrap());
        assert_eq!(h.sent(), vec!["sign out".to_string()]);
        assert!(!h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_none());
    }

    #[test]
    fn web_in_the_menu_opens_drive_proton_me() {
        let launched = || home::LAUNCHED.with(|l| std::mem::take(&mut *l.borrow_mut()));
        launched();
        let mut h = account_menu();
        h.click(h.text_at("Open Proton Drive on the web").unwrap());
        assert_eq!(launched(), vec![home::PROTON_DRIVE_WEB_URL.to_string()]);
        assert!(!h.app.account_menu_open);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn escape_and_a_click_outside_close_the_menu_without_clicking_through() {
        let mut h = account_menu();
        press_key(&mut h, egui::Key::Escape);
        assert!(!h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_none());

        h.app.open_tab(NavTab::Shared);
        h.frames(2);
        h.sent();
        h.click(h.widget_at("Account").unwrap());
        assert!(h.app.account_menu_open);
        h.click(h.text_at("Home").expect("the sidebar's Home"));
        assert!(!h.app.account_menu_open, "a click outside closes it");
        assert_eq!(h.app.tab, NavTab::Shared, "and clicks nothing under it");
        assert_eq!(h.sent(), Vec::<String>::new());
        // The account again, with the menu open, closes it too
        h.click(h.widget_at("Account").unwrap());
        h.click(h.widget_at("Account").unwrap());
        assert!(!h.app.account_menu_open);
    }

    #[test]
    fn opening_a_section_closes_the_menu() {
        let mut h = account_menu();
        h.app.open_tab(NavTab::Activity);
        h.frames(2);
        assert!(!h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_none());
    }

    #[test]
    fn signed_out_the_account_area_says_so_and_opens_nothing() {
        let mut h = Harness::new();
        h.app.status.logged_in = false;
        h.app.status.account = None;
        h.frames(2);
        let at = in_top_bar(&h, "Not signed in");
        assert_eq!(at.len(), 1, "said in the top bar");
        assert_eq!(in_top_bar(&h, "PD").len(), 1, "with PD for initials");
        h.click(at[0]);
        assert!(!h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_none());
        // Until the daemon first answers, it says so
        h.app.initial_connecting = true;
        h.frames(2);
        assert_eq!(in_top_bar(&h, "Connecting…").len(), 1);
        // Signed in without the account's details (an older daemon): the menu still offers Sign out
        h.app.initial_connecting = false;
        h.app.status.logged_in = true;
        h.frames(2);
        assert_eq!(in_top_bar(&h, "Proton Account").len(), 1);
        h.click(h.widget_at("Account").unwrap());
        assert!(h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_some());
        // Signed out meanwhile (from Settings, the tray…): the menu goes
        let status = DaemonStatus { logged_in: false, account: None, ..h.app.status.clone() };
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert!(!h.app.account_menu_open);
        assert!(h.text_at("Sign out").is_none());
    }

    #[test]
    fn a_long_name_does_not_push_the_title_or_gear_off_at_840() {
        let mut h = Harness::new();
        let name = "Bartholomew ".repeat(5);
        let email = format!("{}@proton.me", "featherstonehaugh".repeat(3));
        assert!(name.len() >= 60 && email.len() >= 60);
        h.app.status.account = Some(AccountInfo { display_name: name.clone(), email, initials: "BB".into(), ..gautam() });
        h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2);
        let inside = |h: &Harness, r: egui::Rect| {
            r.left() > SIDEBAR_EDGE && r.right() <= h.screen.x && r.top() >= 0.0 && r.bottom() <= chrome::TOP_BAR_HEIGHT
        };
        for tab in [NavTab::Home, NavTab::Shared, NavTab::Activity, NavTab::Settings] {
            h.app.open_tab(tab);
            h.frames(3);
            let title = chrome::tab_title(tab);
            let title = *h.text_rects_all(title).iter().find(|r| r.left() > SIDEBAR_EDGE).expect("the title is shown");
            // On Settings the title is named Settings too: the gear is the one on the right
            let gear = h.widgets_at_all("Settings").into_iter().max_by(|a, b| a.x.total_cmp(&b.x)).unwrap();
            let gear = egui::Rect::from_center_size(gear, Vec2::splat(28.0));
            // (Settings' Account card shows them too)
            let initials: Vec<_> = h.text_rects_all("BB").into_iter().filter(|r| r.top() < chrome::TOP_BAR_HEIGHT).collect();
            assert!(initials.len() == 1 && inside(&h, title) && inside(&h, gear) && inside(&h, initials[0]), "{tab:?}");
            assert!(title.right() < gear.left(), "{tab:?}: the title {title:?} runs under the gear {gear:?}");
            // The name is shortened to fit, between the gear and the initials
            let shown = h.text_rect_starting("Bartholomew").expect("the name is painted, shortened");
            assert!(gear.right() < shown.left() && shown.right() < initials[0].left(), "{tab:?}: {shown:?} {gear:?}");
            assert!(in_top_bar(&h, &name).is_empty(), "shortened");
        }
    }

    #[test]
    fn the_top_bar_takes_no_clicks_under_a_dialog() {
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.frames(2);
        let (gear, account) = (h.widget_at("Settings").unwrap(), h.widget_at("Account").unwrap());
        for at in [gear, account] {
            h.app.pending_confirm = Some(PendingConfirm::StartFresh);
            h.frames(2);
            h.click(at);
            assert_eq!(h.app.tab, NavTab::Home);
            assert!(!h.app.account_menu_open);
        }
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    /// The top bar's last node named `label` (the gear, the account), as screen readers get it.
    fn top_bar_node(h: &Harness, label: &str) -> egui::accesskit::Node {
        h.nodes_named(label).pop().unwrap_or_else(|| panic!("{label} is named"))
    }

    #[test]
    fn the_top_bar_is_disabled_under_a_dialog_and_under_the_share_window() {
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.frames(2);
        for label in ["Settings", "Account"] {
            assert!(!top_bar_node(&h, label).is_disabled(), "{label} works with no dialog");
        }
        h.app.pending_confirm = Some(PendingConfirm::StartFresh);
        h.frames(2);
        for label in ["Settings", "Account"] {
            assert!(top_bar_node(&h, label).is_disabled(), "{label} under the confirmation");
        }
        h.app.pending_confirm = None;
        h.frames(2);
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        h.frames(3);
        assert!(h.app.share.is_some());
        for label in ["Settings", "Account"] {
            assert!(top_bar_node(&h, label).is_disabled(), "{label} under the Share window");
        }
    }

    #[test]
    fn the_gear_and_the_account_say_whether_they_are_pressed() {
        use egui::accesskit::Toggled;
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.frames(2);
        assert_eq!(top_bar_node(&h, "Settings").toggled(), Some(Toggled::False), "Home is open");
        assert_eq!(top_bar_node(&h, "Account").toggled(), Some(Toggled::False), "no menu");
        h.app.open_tab(NavTab::Settings);
        h.frames(2);
        assert_eq!(top_bar_node(&h, "Settings").toggled(), Some(Toggled::True), "Settings is open");
        h.click(h.widget_at("Account").unwrap());
        assert!(h.app.account_menu_open);
        assert_eq!(top_bar_node(&h, "Account").toggled(), Some(Toggled::True), "the menu is open");
    }

    #[test]
    fn a_right_click_outside_the_account_menu_closes_it_and_clicks_nothing() {
        let mut h = Harness::new();
        h.app.status.account = Some(gautam());
        h.app.open_tab(NavTab::Shared);
        h.frames(2);
        h.click(h.widget_at("Account").unwrap());
        assert!(h.app.account_menu_open);
        h.sent();
        let at = h.text_at("Home").expect("the sidebar's Home");
        let button = |pressed| egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Secondary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        };
        h.frame(vec![egui::Event::PointerMoved(at)]);
        h.frame(vec![button(true)]);
        h.frame(vec![button(false)]);
        h.frames(2);
        assert!(!h.app.account_menu_open, "a right-click outside closes it");
        assert_eq!(h.app.tab, NavTab::Shared);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn opening_shared_asks_for_the_list_each_time_and_never_on_a_timer() {
        let mut h = Harness::new();
        h.sent();
        h.click(h.text_at("Shared").unwrap());
        assert_eq!(h.app.tab, NavTab::Shared);
        assert_eq!(h.sent(), ["shared list"]);
        h.frames(30);
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Home").unwrap());
        h.sent();
        h.click(h.text_at("Shared").unwrap());
        assert_eq!(h.sent(), ["shared list"]);
    }

    fn shared_rows() -> Vec<shared::SharedItem> {
        shared::fake_shared("list", home::now_ms()).unwrap().unwrap()
    }

    #[test]
    fn shared_shows_each_row_and_each_state() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        h.sent();
        assert!(h.text_at(shared::LOADING).is_some());
        let rows = shared_rows();
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(rows.clone())));
        h.frames(3);
        assert!(h.text_at(shared::LOADING).is_none());
        for item in &rows {
            assert!(h.text_at(&item.name).is_some(), "{}", item.name);
            assert!(h.text_at(&shared::location_text(item)).is_some(), "{}", shared::location_text(item));
            // What it exposes is the Sharing column's, whole for screen readers (and on hover)
            let exposure = shared::exposure_text(item, home::now_ms(), home::local_offset_secs);
            assert!(h.label_at(&exposure).is_some(), "{exposure}");
        }
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(vec![])));
        h.frames(3);
        assert!(h.text_at(shared::EMPTY).is_some());
        let offline = "Proton Drive is offline: try again when you are connected";
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Err(offline.into())));
        h.frames(3);
        assert!(h.text_at(shared::EMPTY).is_none());
        let said = h.text_at(offline).expect("the daemon's message");
        assert_eq!(painted_color(&h, offline, said), Some(DANGER_TEXT()), "in the red that reads as text (R15)");
        assert!(h.widget_at("Refresh").is_none(), "Retry is the action here");
        h.click(h.text_at("Retry").unwrap());
        assert_eq!(h.sent(), ["shared list"]);
    }

    #[test]
    fn a_reload_keeps_the_list_until_the_new_one_comes() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        let rows = shared_rows();
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(rows.clone())));
        h.frames(3);
        h.sent();
        h.click(h.widget_at("Refresh").unwrap());
        assert_eq!(h.sent(), ["shared list"]);
        h.frames(3);
        assert!(h.text_at(shared::LOADING).is_some());
        assert!(h.text_at(&rows[0].name).is_some());
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(rows.clone())));
        h.frames(3);
        assert!(h.text_at(shared::LOADING).is_none());
    }

    #[test]
    fn only_the_newest_read_is_shown() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        let old = h.app.shared.seq;
        // Leaving and entering again while that read is out: a second read
        h.click(h.text_at("Home").unwrap());
        h.click(h.text_at("Shared").unwrap());
        let new = h.app.shared.seq;
        assert_ne!(old, new);
        let rows = shared_rows();
        h.event(WorkerEvent::SharedLoaded(new, Ok(rows.clone())));
        h.frames(3);
        // The older read answers last: with a list, with an error; neither changes what is shown
        h.event(WorkerEvent::SharedLoaded(old, Ok(vec![])));
        h.event(WorkerEvent::SharedLoaded(old, Err("Proton Drive took too long to answer".into())));
        h.frames(3);
        assert!(h.text_at(&rows[0].name).is_some());
        assert!(h.text_at(shared::EMPTY).is_none());
        assert!(h.text_at("Proton Drive took too long to answer").is_none());
        assert!(!h.app.shared.loading);
        // An older answer doesn't end a newer read's loading either
        h.click(h.text_at("Home").unwrap());
        h.click(h.text_at("Shared").unwrap());
        let older = new;
        h.event(WorkerEvent::SharedLoaded(older, Ok(vec![])));
        assert!(h.app.shared.loading);
        assert!(h.text_at(shared::LOADING).is_some());
    }

    #[test]
    fn refresh_does_nothing_while_a_read_is_out() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(shared_rows())));
        h.sent();
        // An icon, named Refresh
        assert!(h.text_at(icons::REFRESH).is_some());
        assert!(h.text_at("Refresh").is_none());
        h.click(h.widget_at("Refresh").unwrap());
        assert_eq!(h.sent(), ["shared list"]);
        h.frames(3);
        h.click(h.widget_at("Refresh").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    /// The colour `text` was painted in at `pos`, as drawn (faded if its widget is disabled).
    fn painted_color(h: &Harness, text: &str, pos: egui::Pos2) -> Option<Color32> {
        h.texts(|t| t.galley.text() == text)
            .into_iter()
            .find(|t| t.visual_bounding_rect().expand(4.0).contains(pos))
            .and_then(|t| t.galley.rows.first()?.visuals.mesh.vertices.first().map(|v| v.color))
    }

    /// Where the last frame painted `text` on the line of `y` (within half a row of it).
    fn on_line(h: &Harness, text: &str, y: f32) -> Option<egui::Rect> {
        h.text_rects_all(text).into_iter().find(|r| (r.center().y - y).abs() < SHARED_ROW_HALF)
    }

    /// Half a Shared row's height: what is on a row's line is within this of its name's centre.
    const SHARED_ROW_HALF: f32 = 22.0;

    #[test]
    fn a_row_shows_its_name_location_sharing_and_actions_on_one_line() {
        let h = shared_with_rows();
        let item = &shared_rows()[0];
        let name = h.text_rect(&item.name).unwrap();
        let y = name.center().y;
        let location = h.text_rect(&shared::location_text(item)).unwrap();
        let file = on_line(&h, icons::FILE, y).expect("a file's icon before its name");
        let marks: Vec<egui::Rect> =
            shared::sharing_marks(item, home::now_ms()).iter().map(|m| on_line(&h, m, y).unwrap_or_else(|| panic!("{m:?}"))).collect();
        let actions = row_buttons(&h, &item.name);
        let first_action = on_row(&h, &item.name, actions[0]);
        for (what, at) in [("location", location.center()), ("icon", file.center()), ("first mark", marks[0].center()), ("action", first_action)] {
            assert!((at.y - y).abs() < 4.0, "{what} on the name's line: {at:?}, {y}");
        }
        assert!(file.right() < name.left() && name.right() < location.left(), "{file:?} {name:?} {location:?}");
        assert!(location.right() < marks[0].left() && marks.windows(2).all(|m| m[0].right() < m[1].left()), "{location:?} {marks:?}");
        assert!(marks.last().unwrap().right() < first_action.x, "the actions on the right");
        let count = on_line(&h, "2", y).expect("the number of people, after their mark");
        assert!(count.left() > marks.last().unwrap().right());
        // Each column under its header
        for (header, left) in [("Name", file.left()), ("Location", location.left()), ("Sharing", marks[0].left())] {
            let at = h.text_rect(header).unwrap_or_else(|| panic!("{header:?}"));
            assert!((at.left() - left).abs() < 3.0, "{header:?} at {}, its column at {left}", at.left());
        }
        // A folder's icon is Proton's orange; a file's is grey
        let icons_y = h.text_at("Icons").unwrap().y;
        let folder = on_line(&h, icons::FOLDER, icons_y).expect("a folder's icon").center();
        assert_eq!(painted_color(&h, icons::FOLDER, folder), Some(FOLDER_ICON()));
        assert_eq!(painted_color(&h, icons::FILE, file.center()), Some(TEXT_MUTED()));
    }

    #[test]
    fn shared_has_column_headers_and_no_card() {
        let h = shared_with_rows();
        let name = h.text_at("report.pdf").unwrap();
        for header in ["Name", "Location", "Sharing"] {
            let at = h.text_at(header).unwrap_or_else(|| panic!("{header:?} is painted"));
            assert!(at.y < name.y, "{header:?} above the rows");
        }
        assert!(h.rects_filled(BG_CARD()).iter().all(|r| !r.contains(name)), "no card around the rows");
    }

    #[test]
    fn the_sharing_column_marks_an_expired_link_an_unreadable_row_and_says_it_all_on_hover() {
        let mut h = shared_with_rows();
        tooltips_at_once(&h);
        let rows = shared_rows();
        // An expired link: the broken link and "Link expired", in the red that reads as text (R15)
        let old_notes = h.text_at("old-notes.txt").unwrap();
        let expired = on_line(&h, "Link expired", old_notes.y).expect("said on its row").center();
        assert_eq!(painted_color(&h, "Link expired", expired), Some(DANGER_TEXT()));
        let broken = on_line(&h, icons::LINK_BROKEN, old_notes.y).filter(|r| r.center().x < expired.x).expect("the broken link before it");
        assert_eq!(painted_color(&h, icons::LINK_BROKEN, broken.center()), Some(DANGER_TEXT()));
        // A row whose sharing wasn't read: the warning and why, in place of the marks
        let budget = rows.iter().find(|i| i.unreadable.is_some()).unwrap();
        let y = h.text_at(&budget.name).unwrap().y;
        assert!(on_line(&h, icons::WARNING, y).is_some(), "the warning");
        assert!(h.texts(|t| t.galley.text().starts_with("Proton Drive")).iter().any(|t| (t.visual_bounding_rect().center().y - y).abs() < 4.0), "and why");
        assert!(on_line(&h, icons::PEOPLE, y).is_none(), "no marks");
        // The whole of what an item exposes, on hover
        let report = &rows[0];
        let exposure = shared::exposure_text(report, home::now_ms(), home::local_offset_secs);
        assert!(h.text_at(&exposure).is_none());
        let lock = on_line(&h, icons::LOCK, h.text_at(&report.name).unwrap().y).expect("the password's mark").center();
        h.frame(vec![egui::Event::PointerMoved(lock)]);
        h.frames(5);
        assert!(h.text_at(&exposure).is_some(), "the tooltip says what it exposes");
    }

    #[test]
    fn a_rows_actions_are_weak_until_the_row_is_hovered() {
        let mut h = shared_with_rows();
        let stop = on_row(&h, "Icons", "Stop sharing");
        assert_eq!(painted_color(&h, icons::LINK_BROKEN, stop), Some(TEXT_MUTED()));
        // Over the row's name: its actions turn to the text's colour; the other rows' stay weak
        h.frame(vec![egui::Event::PointerMoved(h.text_at("Icons").unwrap())]);
        h.frames(2);
        assert_eq!(painted_color(&h, icons::LINK_BROKEN, stop), Some(TEXT_PRIMARY()));
        assert_eq!(painted_color(&h, icons::MANAGE, on_row(&h, "Icons", "Manage…")), Some(TEXT_PRIMARY()));
        assert_eq!(painted_color(&h, icons::LINK_BROKEN, on_row(&h, "report.pdf", "Stop sharing")), Some(TEXT_MUTED()));
    }

    #[test]
    fn the_shared_columns_give_way_location_first_then_the_name() {
        let sum = |(n, l, s): (f32, f32, f32)| n + l + s;
        // Room to spare: Sharing has what it needs, and the name half the rest, so the columns line up
        assert_eq!(shared_columns(600.0, 100.0, 120.0, 120.0), (240.0, 240.0, 120.0));
        // A long name takes what it needs from Location
        assert_eq!(shared_columns(600.0, 300.0, 120.0, 120.0), (300.0, 180.0, 120.0));
        // Narrower: Location gives way first, down to its least…
        assert_eq!(shared_columns(400.0, 300.0, 120.0, 120.0), (224.0, SHARED_LOCATION_MIN, 120.0));
        // …then the name
        assert_eq!(shared_columns(300.0, 300.0, 120.0, 120.0), (124.0, SHARED_LOCATION_MIN, 120.0));
        // A reason too long for the row takes at most two fifths of the room; what the marks need, up to half
        assert_eq!(shared_columns(1000.0, 100.0, 120.0, 600.0).2, 400.0);
        assert_eq!(shared_columns(200.0, 100.0, 120.0, 120.0).2, 100.0);
        for room in [120.0, 200.0, 300.0, 400.0, 600.0, 1000.0] {
            for (name, need, want) in [(50.0, 120.0, 120.0), (300.0, 120.0, 600.0), (900.0, 60.0, 60.0)] {
                let cols = shared_columns(room, name, need, want);
                assert!((sum(cols) - room).abs() < 0.01, "{room} {cols:?}");
                assert!(cols.0 >= 0.0 && cols.1 >= 0.0 && cols.2 >= 0.0, "{room} {cols:?}");
            }
        }
    }

    // A Shared action and Refresh are push buttons for screen readers; only the gear, which stays pressed while
    // Settings is open, is a toggle
    #[test]
    fn shared_actions_and_refresh_are_push_buttons_and_the_gear_a_toggle() {
        let h = shared_with_rows();
        for label in ["Copy link", "Manage…", "Show in Files", "Stop sharing", "Manage on the web", "Refresh"] {
            let nodes = h.nodes_named(label);
            assert!(!nodes.is_empty(), "{label:?}");
            for node in nodes {
                assert_eq!(node.role(), egui::accesskit::Role::Button, "{label:?}");
                assert_eq!(node.toggled(), None, "{label:?} is not a toggle");
            }
        }
        let gear = h.nodes_named("Settings").into_iter().find(|n| n.role() == egui::accesskit::Role::Button).expect("the gear");
        assert_eq!(gear.toggled(), Some(egui::accesskit::Toggled::False), "the gear says it isn't pressed");
    }

    // R13: phrases are cut at their end; paths (folders, names) in the middle, keeping their ends
    #[test]
    fn phrases_are_cut_at_the_end_and_paths_in_the_middle() {
        let mut h = shared_with_rows();
        h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2);
        // On the page, not the sidebar's "Proton Drive"
        let painted = |start: &str| -> Vec<String> {
            h.texts(|t| t.galley.text().starts_with(start) && t.visual_bounding_rect().left() > SIDEBAR_EDGE)
                .iter()
                .map(|t| t.galley.text().to_string())
                .collect()
        };
        for (start, whole) in [
            ("Hid", "Hidden from this computer"),
            ("Not", "Not on this computer"),
            ("(to", "(top level)"),
            ("Proton D", "Proton Drive is still catching up with this item: refresh in a moment"),
        ] {
            let shown = painted(start);
            assert_eq!(shown.len(), 1, "{whole:?}: {shown:?}");
            assert!(shown[0].ends_with('…') && whole.starts_with(shown[0].trim_end_matches('…')), "{whole:?} cut at its end: {shown:?}");
        }
        // A folder keeps its end
        let documents = painted("Do");
        assert!(!documents.is_empty() && documents.iter().all(|d| d.contains('…') && d.ends_with("ts")), "{documents:?}");
        // and the whole of it is on hover, as before
        let taxes = h.text_at(&painted("Hid")[0]).unwrap();
        tooltips_at_once(&h);
        h.frame(vec![egui::Event::PointerMoved(taxes)]);
        h.frames(5);
        assert!(h.text_at("Taxes\nPrivate · Hidden from this computer").is_some());
    }

    // R14: links are Proton's purple, readable in both palettes
    #[test]
    fn links_are_proton_purple_in_both_palettes() {
        let link_color = |h: &Harness| {
            h.texts(|t| t.galley.text() == shared::PHOTOS_LINK).first().map(|t| t.fallback_color).expect("the Photos note's link")
        };
        let mut h = shared_with_rows();
        assert_eq!(link_color(&h), DARK.purple_text, "dark");
        assert!(contrast(DARK.purple_text, DARK.canvas) >= 4.5);
        apply_proton_visuals(&h.ctx, true);
        h.frames(2);
        assert_eq!(link_color(&h), PROTON_PURPLE, "light");
        assert!(contrast(PROTON_PURPLE, LIGHT.canvas) >= 4.5);
    }

    // #253: acting on a row
    fn shared_with_rows() -> Harness {
        let mut h = Harness::new();
        h.app.status.sync_dir = "/home/u/ProtonDrive".into();
        h.click(h.text_at("Shared").unwrap());
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(shared_rows())));
        h.frames(3);
        assert_eq!(h.sent(), ["shared list"]);
        h
    }

    /// The buttons on the row of `name`, left to right, by their names for screen readers (they are icons).
    fn row_buttons(h: &Harness, name: &str) -> Vec<&'static str> {
        let y = h.text_at(name).unwrap_or_else(|| panic!("{name:?} is painted")).y;
        let mut found: Vec<(f32, &'static str)> = ["Copy link", "Manage…", "Show in Files", "Stop sharing", "Manage on the web"]
            .into_iter()
            .flat_map(|label| h.widgets_at_all(label).into_iter().filter(|p| (p.y - y).abs() < SHARED_ROW_HALF).map(move |p| (p.x, label)))
            .collect();
        found.sort_by(|a, b| a.0.total_cmp(&b.0));
        found.into_iter().map(|(_, label)| label).collect()
    }

    /// The button named `label` on the row of `name`.
    fn on_row(h: &Harness, name: &str, label: &str) -> egui::Pos2 {
        let y = h.text_at(name).unwrap_or_else(|| panic!("{name:?} is painted")).y;
        h.widgets_at_all(label)
            .into_iter()
            .filter(|p| (p.y - y).abs() < SHARED_ROW_HALF)
            .min_by(|a, b| (a.y - y).abs().total_cmp(&(b.y - y).abs()))
            .unwrap_or_else(|| panic!("{label:?} on the row of {name:?}"))
    }

    #[test]
    fn each_kind_of_row_has_its_buttons() {
        let h = shared_with_rows();
        assert_eq!(row_buttons(&h, "report.pdf"), ["Copy link", "Manage…", "Show in Files", "Stop sharing"]);
        assert_eq!(row_buttons(&h, "Icons"), ["Manage…", "Show in Files", "Stop sharing"], "no link, no Copy link");
        assert_eq!(row_buttons(&h, "old-notes.txt"), ["Manage…", "Show in Files", "Stop sharing"], "an expired link can't be copied");
        assert_eq!(row_buttons(&h, "Taxes"), ["Manage on the web"]);
        assert_eq!(row_buttons(&h, "holiday.jpg"), ["Manage on the web"]);
        // R10: its sharing wasn't read, so nothing that acts on it
        assert_eq!(row_buttons(&h, "Budget.xlsx"), ["Show in Files", "Manage on the web"]);
    }

    #[test]
    fn an_unreadable_hidden_row_has_only_manage_on_the_web() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        let mut rows = shared_rows();
        let mut hidden = rows.remove(3);
        hidden.unreadable = Some("Proton Drive is still catching up with this item: refresh in a moment".into());
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(vec![hidden])));
        h.frames(3);
        assert_eq!(row_buttons(&h, "Taxes"), ["Manage on the web"]);
    }

    #[test]
    fn a_change_landing_after_the_share_window_closed_reloads_the_list_again() {
        let mut h = shared_with_rows();
        h.click(on_row(&h, "report.pdf", "Manage…"));
        h.sent();
        let first = shown(&h);
        h.event(WorkerEvent::ShareLoaded(first, Ok(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] })));
        h.frames(3);
        h.click(h.text_at("On").expect("the link switch, on"));
        h.click(*h.text_at_all("Stop sharing").last().expect("the confirmation's button"));
        assert_eq!(h.sent(), vec!["share link off Documents/report.pdf".to_string()]);
        h.click(h.text_at("Done").expect("Done"));
        assert_eq!(h.sent(), ["shared list"], "read at close");
        h.event(WorkerEvent::ShareDone(first, Ok(())));
        assert_eq!(h.sent(), ["shared list"], "and again once the change landed");
    }

    #[test]
    fn manage_on_the_web_opens_the_shared_page_there() {
        let mut h = shared_with_rows();
        h.click(on_row(&h, "holiday.jpg", "Manage on the web"));
        assert!(home::LAUNCHED.with(|l| l.borrow().iter().any(|t| t == shared::WEB_SHARED_URL)));
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn shared_notes_that_photos_may_be_missing_under_rows_and_under_the_empty_text() {
        let mut h = shared_with_rows();
        assert!(h.text_at(shared::PHOTOS_NOTE).is_some(), "under the list");
        assert!(h.text_at(shared::PHOTOS_LINK).is_some());
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Ok(vec![])));
        h.frames(3);
        assert!(h.text_at(shared::EMPTY).is_some());
        assert!(h.text_at(shared::PHOTOS_NOTE).is_some(), "under the empty text");
        assert!(h.text_at(shared::PHOTOS_LINK).is_some());
    }

    #[test]
    fn shared_does_not_note_photos_while_first_loading_or_on_an_error() {
        let mut h = Harness::new();
        h.click(h.text_at("Shared").unwrap());
        h.frames(3);
        assert!(h.text_at(shared::LOADING).is_some());
        assert!(h.text_at(shared::PHOTOS_NOTE).is_none(), "first load");
        h.event(WorkerEvent::SharedLoaded(h.app.shared.seq, Err("Proton Drive is offline".into())));
        h.frames(3);
        assert!(h.text_at("Retry").is_some());
        assert!(h.text_at(shared::PHOTOS_NOTE).is_none(), "error");
        assert!(h.text_at(shared::PHOTOS_LINK).is_none());
    }

    #[test]
    fn see_them_on_drive_proton_me_opens_the_shared_page_there() {
        let mut h = shared_with_rows();
        h.click(h.text_at(shared::PHOTOS_LINK).expect("the link"));
        assert!(home::LAUNCHED.with(|l| l.borrow().iter().any(|t| t == shared::WEB_SHARED_URL)));
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn stop_sharing_asks_first_then_sends_once_and_reloads() {
        let mut h = shared_with_rows();
        let item = shared_rows().remove(0);
        h.click(on_row(&h, "report.pdf", "Stop sharing"));
        assert_eq!(h.app.pending_confirm, Some(PendingConfirm::StopSharing { rel_path: "Documents/report.pdf".into(), uid: item.uid.clone(), question: shared::stop_question(&item, home::now_ms()) }));
        h.frames(2);
        assert!(h.text_at("Stop sharing?").is_some());
        assert!(h.text_at(&shared::stop_question(&item, home::now_ms())).is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        let button = *h.text_at_all("Stop sharing").last().unwrap();
        h.click(button);
        assert_eq!(h.sent(), [format!("stop sharing \"Documents/report.pdf\" {}", item.uid)]);
        assert!(h.app.pending_confirm.is_none());
        assert_eq!(h.app.shared.stopping.as_deref(), Some("Documents/report.pdf"));
        h.event(WorkerEvent::SharedStopped("Documents/report.pdf".into(), Ok(())));
        assert_eq!(h.app.shared.stopping, None);
        assert_eq!(h.sent(), ["shared list"]);
    }

    #[test]
    fn cancelling_stop_sharing_sends_nothing() {
        let mut h = shared_with_rows();
        h.click(on_row(&h, "report.pdf", "Stop sharing"));
        h.frames(2);
        h.click(h.text_at("Cancel").expect("Cancel"));
        assert!(h.app.pending_confirm.is_none());
        assert_eq!(h.app.shared.stopping, None);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn a_row_being_stopped_cannot_be_stopped_again() {
        let mut h = shared_with_rows();
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.frames(2);
        h.click(on_row(&h, "report.pdf", "Stop sharing"));
        assert!(h.app.pending_confirm.is_none());
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn another_row_cannot_be_stopped_while_a_stop_is_out() {
        let mut h = shared_with_rows();
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.frames(2);
        h.click(on_row(&h, "Icons", "Stop sharing"));
        assert!(h.app.pending_confirm.is_none());
        assert_eq!(h.sent(), Vec::<String>::new());
        // the row's other buttons still work
        h.click(on_row(&h, "Icons", "Manage…"));
        assert!(h.app.share.is_some());
    }

    /// #262: the greyed-out look of a Stop sharing that has to wait, not only that it doesn't answer a click
    #[test]
    fn another_rows_stop_sharing_looks_greyed_out_while_a_stop_is_out() {
        let mut h = shared_with_rows();
        tooltips_at_once(&h);
        let stop = on_row(&h, "Icons", "Stop sharing");
        let enabled = painted_color(&h, icons::LINK_BROKEN, stop).expect("Stop sharing's icon is painted");
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.frames(2);
        let disabled = painted_color(&h, icons::LINK_BROKEN, stop).expect("Stop sharing's icon is painted");
        assert_ne!(disabled, enabled, "the waiting button is painted differently");
        // the row's other buttons keep their look
        assert_eq!(painted_color(&h, icons::MANAGE, on_row(&h, "Icons", "Manage…")), Some(enabled));
        // and the waiting one still says what it is, on hover
        assert!(h.text_at("Stop sharing").is_none());
        h.frame(vec![egui::Event::PointerMoved(stop)]);
        h.frames(5);
        assert!(h.text_at("Stop sharing").is_some(), "its tooltip");
    }

    /// The actions never move: at the narrowest window with the keyboard zoom up, every row's buttons are whole inside
    /// the window, and every column is still shown (#262's buttons wrapped instead)
    #[test]
    fn a_rows_actions_stay_inside_the_window_narrow_and_zoomed() {
        let mut h = shared_with_rows();
        h.resize_zoomed(Vec2::new(840.0, 540.0), 1.2);
        for (label, rows) in [("Copy link", 1), ("Manage…", 3), ("Show in Files", 4), ("Stop sharing", 3), ("Manage on the web", 3)] {
            let nodes = h.nodes_named(label);
            assert_eq!(nodes.len(), rows, "{label:?} on each of its rows");
            for node in nodes {
                let right = node.bounds().expect("placed").x1 as f32;
                assert!(right <= h.screen.x - 4.0, "{label:?} runs to {right}, past the window's {}", h.screen.x);
            }
        }
        for header in ["Name", "Location", "Sharing"] {
            assert!(h.text_at(header).is_some(), "{header:?} is shown");
        }
        // Names too, shortened in the middle
        for item in shared_rows() {
            let (first, last) = (item.name.chars().next().unwrap(), item.name.chars().last().unwrap());
            let shown = h.texts(|t| t.galley.text().starts_with(first) && t.galley.text().ends_with(last)).len();
            assert!(shown > 0, "{:?} shows its start and its end", item.name);
        }
    }


    #[test]
    fn a_stop_that_fails_after_leaving_shared_is_told_in_the_notice() {
        let mut h = shared_with_rows();
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.click(h.text_at("Home").unwrap());
        h.event(WorkerEvent::SharedStopped("Documents/report.pdf".into(), Err("Proton Drive is offline".into())));
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't stop sharing report.pdf: Proton Drive is offline"));
        // on Shared itself the list shows it, and no notice
        let mut h = shared_with_rows();
        h.event(WorkerEvent::SharedStopped("Documents/report.pdf".into(), Err("Proton Drive is offline".into())));
        assert_eq!(h.app.notice, None);
    }

    /// #260: the daemon refuses a stop whose item is no longer at that path, in words that reach the user as any stop error
    #[test]
    fn the_daemons_refusal_of_a_changed_item_shows_as_a_stop_error() {
        const CHANGED: &str = "This item changed since the list was loaded: refresh";
        let (sock, server) =
            serve_once(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"This item changed since the list was loaded: refresh\"}");
        let refusal = share::stop_sharing_at(&sock, "Documents/report.pdf", "vol~old").unwrap_err();
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
        assert_eq!(refusal, CHANGED);

        let mut h = shared_with_rows();
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.event(WorkerEvent::SharedStopped("Documents/report.pdf".into(), Err(refusal)));
        h.frames(3);
        assert_eq!(h.app.shared.stopping, None);
        assert!(h.text_at(CHANGED).is_some());
        assert!(h.text_at("report.pdf").is_some(), "the list stays, for Refresh");
    }

    #[test]
    fn a_failed_stop_says_why_and_keeps_the_list() {
        let mut h = shared_with_rows();
        h.app.shared.stopping = Some("Documents/report.pdf".into());
        h.event(WorkerEvent::SharedStopped("Documents/report.pdf".into(), Err("Proton Drive is offline".into())));
        h.frames(3);
        assert_eq!(h.app.shared.stopping, None);
        let said = h.text_at("Proton Drive is offline").expect("why");
        assert_eq!(painted_color(&h, "Proton Drive is offline", said), Some(DANGER_TEXT()), "in the red that reads as text (R15)");
        assert!(h.text_at("report.pdf").is_some(), "the list stays");
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn a_rows_name_and_folder_are_whole_on_hover() {
        let mut h = shared_with_rows();
        h.ctx.style_mut(|s| {
            s.interaction.tooltip_delay = 0.0;
            s.interaction.show_tooltips_only_when_still = false;
        });
        let name = h.text_at("report.pdf").unwrap();
        h.frame(vec![egui::Event::PointerMoved(name)]);
        h.frames(5);
        assert!(h.text_at("report.pdf\nDocuments").is_some(), "the tooltip has the full name and folder");
    }

    #[test]
    fn manage_opens_the_share_window_for_the_item_and_closing_it_reloads_the_list() {
        let mut h = shared_with_rows();
        h.click(on_row(&h, "report.pdf", "Manage…"));
        assert_eq!(window(&mut h).abs_path, "/home/u/ProtonDrive/Documents/report.pdf");
        assert_eq!(h.sent(), ["share info Documents/report.pdf"]);
        h.frames(3);
        h.click(h.text_at("Done").expect("Done"));
        assert!(h.app.share.is_none());
        assert_eq!(h.sent(), ["shared list"]);
    }

    #[test]
    fn copy_link_copies_the_url_and_says_so() {
        let mut h = shared_with_rows();
        let pos = on_row(&h, "report.pdf", "Copy link");
        h.frame(vec![egui::Event::PointerMoved(pos)]);
        let button = |pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE };
        h.frame(vec![button(true)]);
        h.frame(vec![button(false)]);
        let url = shared_rows()[0].link.as_ref().unwrap().url.clone();
        let copied = h.last.as_ref().unwrap().platform_output.commands.iter().any(|c| matches!(c, egui::OutputCommand::CopyText(t) if *t == url));
        assert!(copied, "the link is on the clipboard");
        h.frames(2);
        assert!(h.text_at("Link copied").is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.widget_at("Refresh").unwrap());
        h.frames(2);
        assert_eq!(h.app.shared.copied, None, "until the next load");
    }

    // #35: signed in to another account than the files were synced with, Home's Needs attention says so first, and
    // offers both ways on
    #[test]
    fn another_account_shows_first_in_homes_needs_attention_and_starting_fresh_asks_first() {
        let mut sent = serde_json::to_value(DaemonStatus::default()).unwrap();
        sent["accountMismatch"] = serde_json::json!({ "message": "You signed in to a different Proton account." });
        let status: DaemonStatus = serde_json::from_value(sent).unwrap();
        assert_eq!(status.account_mismatch, Some(AccountMismatch { message: "You signed in to a different Proton account.".into() }));

        let mut h = Harness::new();
        assert!(h.text_at("Start fresh with this account").is_none());
        h.app.status.state = "error".into();
        h.app.status.last_error = Some("You signed in to a different Proton account.".into());
        h.app.status.account_mismatch = Some(AccountMismatch { message: "You signed in to a different Proton account.".into() });
        h.app.status.files_missing =
            Some(FilesMissing { root: "/home/u/ProtonDrive".into(), names: vec!["Docs".into()], items: 1, ..Default::default() });
        h.app.refresh_attention();
        h.frames(3);
        assert_eq!(h.app.attention.first(), Some(&home::Attention::AccountMismatch));
        assert!(h.text_at("Needs attention").is_some());
        assert!(h.text_at("2 problems need you").is_some(), "the mismatch counts in the status");
        let title = h.text_at("Signed in to a different Proton account").expect("the mismatch is listed");
        assert!(title.y < h.text_at(DELETE_TOO).expect("files missing is listed too").y, "the mismatch comes first");
        // Said once: the error the daemon sets for it isn't listed again
        assert_eq!(h.text_at_all("You signed in to a different Proton account.").len(), 1);
        // Home only, as the files missing are: the other sections don't repeat it
        for tab in [NavTab::Activity, NavTab::Settings] {
            h.app.tab = tab;
            h.frames(3);
            assert!(h.text_at("Start fresh with this account").is_none(), "{tab:?}");
        }
        h.app.tab = NavTab::Home;
        h.frames(3);

        h.click(h.text_at("Start fresh with this account").unwrap());
        assert_eq!(h.app.pending_confirm, Some(PendingConfirm::StartFresh));
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Cancel").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Start fresh with this account").unwrap());
        h.click(h.text_at("Start fresh").expect("the dialog's button"));
        assert_eq!(h.sent(), vec!["start fresh".to_string()]);
        assert!(h.app.start_fresh_working);
        // Nothing more is sent while it runs
        h.click(h.text_at("Start fresh with this account").unwrap());
        assert_eq!(h.app.pending_confirm, None);
        h.event(WorkerEvent::StartFreshDone(Err("Nothing to start fresh from".into())));
        assert!(!h.app.start_fresh_working);
        h.frames(2);
        assert!(h.text_at("Nothing to start fresh from").is_some());
        h.click(h.text_at("Sign out").unwrap());
        assert_eq!(h.sent(), vec!["sign out".to_string()]);
    }

    #[test]
    fn deleting_the_missing_files_from_proton_drive_asks_first_and_keep_waiting_sends_nothing() {
        let mut h = Harness::new();
        held(&mut h);
        h.click(h.text_at(DELETE_TOO).unwrap());
        assert_eq!(
            h.app.pending_confirm,
            Some(PendingConfirm::DeleteMissing {
                root: "/home/u/ProtonDrive".into(),
                names: vec!["Docs".into(), "Photos".into()],
                items: 12
            })
        );
        assert!(h
            .text_at("The 12 missing items (Docs and Photos) will move to the Proton Drive trash. You can restore them from the trash on the Proton Drive website.")
            .is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Keep waiting").expect("keep waiting is offered"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(h.text_at(DELETE_TOO).unwrap());
        // What the dialog was opened for is what is confirmed, even if the status changes while it is open: the daemon
        // refuses it if that is no longer what is missing
        h.app.status.files_missing.as_mut().unwrap().names = vec!["Photos".into()];
        h.click(h.text_at("Delete from Proton Drive").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["files missing: delete-in-cloud /home/u/ProtonDrive Docs, Photos".to_string()]);
        assert!(h.app.files_missing_working);
        // Nothing more is sent while it runs
        h.click(h.text_at(DELETE_TOO).unwrap());
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        h.event(WorkerEvent::FilesMissingDone(Err("Nothing is missing from /home/u/ProtonDrive".into())));
        assert!(!h.app.files_missing_working);
        assert!(h.text_at("Nothing is missing from /home/u/ProtonDrive").is_some());
    }

    #[test]
    fn both_choices_post_their_action_with_what_was_shown_on_the_control_socket() {
        for (choice, action) in [(MissingChoice::DeleteInCloud, "delete-in-cloud"), (MissingChoice::KeepOnlineOnly, "keep-online-only")] {
            let reply: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 61\r\n\r\n{\"ok\":true,\"root\":\"/home/u/ProtonDrive\",\"names\":[],\"items\":0}";
            let (sock, server) = serve_once(reply);
            files_missing_resolve_at(&sock, choice, "/home/u/ProtonDrive", &["Docs".to_string(), "Photos/p2.jpg".to_string()]).unwrap();
            let seen = server.join().unwrap();
            assert!(seen.starts_with("POST /sync/files-missing HTTP/1.1\r\n"), "{seen}");
            let body: serde_json::Value = serde_json::from_str(seen.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body, serde_json::json!({ "action": action, "root": "/home/u/ProtonDrive", "names": ["Docs", "Photos/p2.jpg"] }));
            let _ = std::fs::remove_file(&sock);
        }
    }

    #[test]
    fn keeping_them_online_only_sends_at_once_what_was_shown_and_says_what_happens_first() {
        let mut h = Harness::new();
        held(&mut h);
        // Said before it is clicked: it deletes nothing, so it asks nothing
        assert!(h.text_at(KEEP_SAYS_PLAIN).is_some());
        h.click(h.text_at(KEEP).expect("keep online-only is offered"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["files missing: keep-online-only /home/u/ProtonDrive Docs, Photos".to_string()]);
        assert!(h.app.files_missing_working);
        // Nothing more is sent while it runs, by either button
        h.click(h.text_at(KEEP).unwrap());
        h.click(h.text_at(DELETE_TOO).unwrap());
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        let refused = "What is missing from ~/ProtonDrive has changed (now Photos): nothing was changed; look again";
        h.event(WorkerEvent::FilesMissingDone(Err(refused.into())));
        assert!(!h.app.files_missing_working);
        assert!(h.text_at(refused).is_some());
        // What is shown now is what is sent
        h.app.status.files_missing.as_mut().unwrap().names = vec!["Photos".into()];
        h.frames(2);
        h.click(h.text_at(KEEP).unwrap());
        assert_eq!(h.sent(), vec!["files missing: keep-online-only /home/u/ProtonDrive Photos".to_string()]);
    }

    #[test]
    fn keep_online_only_is_the_default_in_the_virtual_layout_and_delete_never_is() {
        let mut h = Harness::new();
        h.app.status.vfs = Some(vfs("virtual", true, None));
        held(&mut h);
        assert!(h.text_at(KEEP_SAYS_VIRTUAL).is_some());
        assert_eq!(h.fill_under(h.text_at(KEEP).unwrap()), Some(PROTON_PURPLE));
        let delete = h.fill_under(h.text_at(DELETE_TOO).unwrap());
        assert!(delete != Some(PROTON_PURPLE) && delete != Some(STATUS_DANGER), "{delete:?}");
        h.click(h.text_at(KEEP).unwrap());
        assert_eq!(h.sent(), vec!["files missing: keep-online-only /home/u/ProtonDrive Docs, Photos".to_string()]);

        // The plain layout offers it too, not as the default (there the files are often on a disk not connected)
        let mut h = Harness::new();
        h.app.status.vfs = Some(vfs("plain", false, Some("switched-off")));
        held(&mut h);
        assert!(h.text_at(KEEP_SAYS_PLAIN).is_some());
        assert_ne!(h.fill_under(h.text_at(KEEP).unwrap()), Some(PROTON_PURPLE));
        assert_ne!(h.fill_under(h.text_at(DELETE_TOO).unwrap()), Some(PROTON_PURPLE));
    }

    #[test]
    fn daemon_status_reads_files_missing() {
        let status: DaemonStatus = serde_json::from_str(
            r#"{"state":"error","currentAction":null,"loggedIn":true,"syncDir":"/home/u/ProtonDrive","activeTransfers":[],
                "filesMissing":{"root":"/home/u/ProtonDrive","names":["Docs"],"items":3,"message":"Docs is missing from ~/ProtonDrive. Nothing was deleted in Proton Drive."},
                "stats":{"totalFiles":1,"totalFolders":0,"totalBytes":3,"unresolvedConflicts":0,"errorItems":0},
                "settings":{"syncDir":"/home/u/ProtonDrive","conflictStrategy":"keep-both","notificationsEnabled":true,
                            "reconcileIntervalSec":120,"paused":false,"ignorePatterns":[".git"]}}"#,
        )
        .unwrap();
        assert_eq!(
            status.files_missing,
            Some(FilesMissing {
                root: "/home/u/ProtonDrive".into(),
                names: vec!["Docs".into()],
                items: 3,
                message: "Docs is missing from ~/ProtonDrive. Nothing was deleted in Proton Drive.".into()
            })
        );
        let none: DaemonStatus = serde_json::from_str(r#"{"state":"idle","loggedIn":true,"syncDir":"/x","activeTransfers":[],
            "stats":{"totalFiles":1,"totalFolders":0,"totalBytes":3,"unresolvedConflicts":0,"errorItems":0},
            "settings":{"syncDir":"/x","conflictStrategy":"keep-both","notificationsEnabled":true,"reconcileIntervalSec":120,"paused":false,"ignorePatterns":[]},
            "filesMissing":null}"#).unwrap();
        assert_eq!(none.files_missing, None);
    }

    // The app reaches the daemon where the daemon listens: $PROTON_DRIVE_DAEMON_PORT when set (a sandboxed screenshot
    // points it at a port nothing listens on), else 49152
    #[test]
    fn the_daemon_url_honours_the_daemons_port_variable() {
        assert_eq!(daemon_url_for(None), "http://127.0.0.1:49152");
        assert_eq!(daemon_url_for(Some("50001")), "http://127.0.0.1:50001");
        assert_eq!(daemon_url_for(Some(" 50001 ")), "http://127.0.0.1:50001");
        for bad in ["", "0", "x", "70000", "-1"] {
            assert_eq!(daemon_url_for(Some(bad)), "http://127.0.0.1:49152", "{bad:?}");
        }
    }

    #[test]
    fn missing_names_read_as_a_list() {
        let fm = |names: &[&str], items| FilesMissing {
            root: "/r".into(),
            names: names.iter().map(|n| n.to_string()).collect(),
            items,
            ..Default::default()
        };
        assert_eq!(missing_names(&fm(&["Docs"], 1)), "Docs is");
        assert_eq!(missing_names(&fm(&["Docs", "Photos"], 2)), "Docs and Photos are");
        assert_eq!(missing_names(&fm(&["A", "B", "C"], 3)), "A, B and C are");
        assert_eq!(missing_names(&fm(&["A", "B", "C", "D", "E"], 5)), "A, B, C and 2 more are");
        assert_eq!(missing_names(&fm(&[], 0)), "Your files are");
    }

    // #46: the banner and the dialog name the folder the user knows (the sync folder, ~ for the home folder), and the
    // dialog says what it deletes, one item or many
    #[test]
    fn the_hold_names_the_folder_in_user_terms() {
        assert_eq!(home_short("/home/u/ProtonDrive", Some("/home/u")), "~/ProtonDrive");
        assert_eq!(home_short("/home/u", Some("/home/u")), "~");
        assert_eq!(home_short("/home/user/ProtonDrive", Some("/home/u")), "/home/user/ProtonDrive");
        assert_eq!(home_short("/mnt/disk/ProtonDrive", Some("/home/u")), "/mnt/disk/ProtonDrive");
        assert_eq!(home_short("/home/u/ProtonDrive", None), "/home/u/ProtonDrive");
        assert_eq!(home_short("/home/u/ProtonDrive", Some("")), "/home/u/ProtonDrive");

        let one = confirm_copy(&PendingConfirm::DeleteMissing {
            root: "/mnt/disk/ProtonDrive".into(),
            names: vec!["Photos/p2.jpg".into()],
            items: 1,
        }, true);
        assert_eq!(
            one.body,
            "The missing item (Photos/p2.jpg) will move to the Proton Drive trash. You can restore it from the trash on the Proton Drive website."
        );

        // The banner says what the daemon says: what is missing, and where, in the user's terms
        let mut h = Harness::new();
        held(&mut h);
        let says = "Photos/p2.jpg is missing from the drive's storage. Nothing was deleted in Proton Drive.";
        h.app.status.files_missing.as_mut().unwrap().message = says.into();
        h.frames(3);
        assert!(h.text_at(says).is_some());
        assert!(h.text_at(MISSING).is_none());

        // A daemon from before it said so: the app says it, with ~ for the home folder
        let home = std::env::var("HOME").unwrap_or_default();
        if home.len() > 1 {
            let mut h = Harness::new();
            held(&mut h);
            h.app.status.files_missing.as_mut().unwrap().root = format!("{home}/ProtonDrive");
            h.frames(3);
            assert!(h.text_at("Proton Drive's files are missing from ~/ProtonDrive. Nothing was deleted in Proton Drive.").is_some());
            // The daemon gets the folder as it is, not as shown
            h.click(h.text_at(DELETE_TOO).unwrap());
            h.click(h.text_at("Delete from Proton Drive").unwrap());
            assert_eq!(h.sent(), vec![format!("files missing: delete-in-cloud {home}/ProtonDrive Docs, Photos")]);
        }
    }

    #[test]
    fn the_destructive_buttons_white_label_reads_at_rest_and_on_hover() {
        assert!(contrast(Color32::WHITE, STATUS_DANGER) >= 4.5, "{}", contrast(Color32::WHITE, STATUS_DANGER));
        assert!(contrast(Color32::WHITE, STATUS_DANGER_HOVER) >= 4.5, "{}", contrast(Color32::WHITE, STATUS_DANGER_HOVER));
        assert_ne!(STATUS_DANGER_HOVER, STATUS_DANGER);
    }

    #[test]
    fn delete_from_proton_drive_is_a_destructive_button() {
        let mut h = Harness::new();
        held(&mut h);
        h.click(h.text_at(DELETE_TOO).unwrap());
        h.frames(10); // past the dialog's fade-in
        let delete = h.text_at("Delete from Proton Drive").expect("the dialog is painted");
        assert_eq!(h.fill_under(delete), Some(STATUS_DANGER));
        assert_ne!(h.fill_under(h.text_at("Keep waiting").unwrap()), Some(STATUS_DANGER));
        // The other confirmations keep the primary colour
        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        h.frames(10);
        assert_eq!(h.fill_under(h.text_at("Free up space").expect("free up space asks")), Some(PROTON_PURPLE));
    }

    #[test]
    fn the_settings_tab_shows_the_drive_and_its_switch() {
        let h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        assert!(h.text_at("Location").is_some());
        assert!(h.text_at("/home/u/ProtonDrive").is_some());
        assert!(h.text_at(SWITCH).is_some());
        // The mount state is Home's
        assert!(h.text_at("Virtual drive: mounted at /home/u/ProtonDrive").is_none());
        assert!(h.text_at("Mount again").is_none());
        // A daemon before Stage 2 has no drive to show
        let h = Harness::settings(None, None);
        assert!(h.text_at(SWITCH).is_none());
        assert!(h.text_at("Save Preferences").is_some());
    }

    #[test]
    fn switching_the_virtual_drive_off_asks_first() {
        let mut h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        h.click(h.text_at(SWITCH).expect("the switch is painted"));
        assert_eq!(h.app.pending_confirm, Some(PendingConfirm::VirtualDriveOff));
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.text_at("Your downloaded files move back into a normal folder; online-only files stop showing in Files.").is_some());
        h.click(h.text_at("Cancel").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(h.text_at(SWITCH).unwrap());
        h.click(h.text_at("Switch off").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["virtual drive false".to_string()]);
        assert!(h.app.drive_working);
    }

    #[test]
    fn the_blocklist_is_parsed_when_there_and_empty_from_an_older_daemon() {
        let old: SyncSettings = serde_json::from_str(r#"{"syncDir":"/x","conflictStrategy":"keep-both"}"#).unwrap();
        assert!(old.blocked_apps.is_empty());
        let new: SyncSettings = serde_json::from_str(r#"{"syncDir":"/x","blockedApps":["rg","code"]}"#).unwrap();
        assert_eq!(new.blocked_apps, ["rg", "code"]);
    }

    #[test]
    fn a_name_to_block_is_checked_as_the_daemon_checks_it() {
        let apps = vec!["rg".to_string()];
        assert_eq!(with_blocked_app(&apps, "  code "), Ok(vec!["rg".to_string(), "code".to_string()]));
        assert_eq!(with_blocked_app(&apps, "rg"), Ok(apps.clone()));
        assert!(with_blocked_app(&apps, "   ").is_err());
        assert!(with_blocked_app(&apps, "a-very-long-name").is_err());
        assert!(with_blocked_app(&apps, "éééééééé").is_err()); // 16 bytes
        assert!(with_blocked_app(&apps, "/usr/bin/rg").is_err());
        assert!(with_blocked_app(&apps, "r\tg").is_err());
        assert_eq!(without_blocked_app(&["rg".into(), "code".into()], "rg"), ["code"]);
    }

    #[test]
    fn blocked_apps_are_listed_and_unblock_and_block_send_the_new_list() {
        let mut h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        assert!(h.text_at("No apps are blocked.").is_some());
        h.app.status.settings.blocked_apps = vec!["rg".into(), "code".into()];
        h.frames(2);
        assert!(h.text_at("rg").is_some());
        assert!(h.text_at("No apps are blocked.").is_none());

        h.click(h.text_at("Unblock").expect("each app has Unblock"));
        assert_eq!(h.sent(), vec!["blocked apps code".to_string()]);
        assert!(h.app.blocklist_working);
        // Nothing else is sent while it runs
        h.click(h.text_at("Unblock").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        let settings = SyncSettings { blocked_apps: vec!["code".into()], ..h.app.status.settings.clone() };
        h.event(WorkerEvent::BlockedAppsSaved(Ok(SettingsReply { settings: Some(settings), ..Default::default() })));
        assert!(!h.app.blocklist_working);
        assert!(h.text_at("rg").is_none());

        h.app.block_app_input = "backup.sh".into();
        h.click(h.text_at("Block").expect("a name can be blocked"));
        assert_eq!(h.sent(), vec!["blocked apps code,backup.sh".to_string()]);
        h.event(WorkerEvent::BlockedAppsSaved(Err("\"backup.sh\" isn't the name of an app".into())));
        assert!(h.text_at("\"backup.sh\" isn't the name of an app").is_some());
        assert_eq!(h.app.block_app_input, "backup.sh");

        h.app.block_app_input = "/bin/sh".into();
        h.click(h.text_at("Block").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.app.blocklist_error.as_deref().is_some_and(|e| e.contains("isn't the name of an app")));
    }

    #[test]
    fn without_the_virtual_drive_there_is_no_blocklist() {
        let h = Harness::settings(None, None);
        assert!(h.text_at("Apps blocked from downloading").is_none());
    }

    #[test]
    fn switching_the_virtual_drive_on_goes_at_once() {
        let mut h = Harness::settings(Some(vfs("plain", false, Some("switched-off"))), Some(false));
        h.click(h.text_at(SWITCH).unwrap());
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["virtual drive true".to_string()]);
    }

    #[test]
    fn mount_again_and_a_stopped_move_are_on_home_not_in_settings() {
        let h = Harness::settings(Some(vfs("virtual", false, Some("ejected"))), Some(true));
        assert!(h.text_at("Mount again").is_none());
        assert!(h.text_at("Virtual drive: ejected").is_none());
        let stopped = VfsStatus {
            error: Some("Disk full".into()),
            drive_move: Some(drive_move("relocation", None, &["move-back", "retry"])),
            ..vfs("plain", false, Some("move-failed"))
        };
        let h = Harness::settings(Some(stopped), Some(true));
        assert!(h.text_at("Moving files stopped: Disk full").is_none());
        assert!(h.text_at("Move files back").is_none());
        assert!(h.text_at("Try again").is_none());
    }

    #[test]
    fn why_the_drive_is_a_plain_folder_despite_the_switch_is_said_under_it() {
        let h = Harness::settings(Some(vfs("plain", false, Some("fuse-unavailable"))), Some(true));
        assert!(h.text_at("Plain folder: FUSE isn't available on this system").is_some());
        // Switched off is the user's own choice: nothing to explain
        let h = Harness::settings(Some(vfs("plain", false, Some("switched-off"))), Some(false));
        assert!(h.text_at("Plain folder: virtual drive switched off").is_none());
    }

    #[test]
    fn while_the_drive_moves_files_or_starts_the_disabled_switch_says_why() {
        let h = Harness::settings(Some(vfs("virtual", false, Some("moving"))), Some(true));
        assert!(h.text_at("Moving files…").is_some());
        let h = Harness::settings(Some(vfs("virtual", false, Some("starting"))), Some(true));
        assert!(h.text_at("Starting the virtual drive…").is_some());
        let h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        assert!(h.text_at("Moving files…").is_none());
        assert!(h.text_at("Starting the virtual drive…").is_none());
    }

    #[test]
    fn fake_attention_cycles_the_names_and_adds_failed_items() {
        let items = fake_attention_items(4);
        assert_eq!(items.len(), 5);
        let name = |i: usize| match &items[i] {
            home::Attention::Conflict { rel_path, .. } => rel_path.rsplit('/').next().unwrap().to_string(),
            other => panic!("{other:?}"),
        };
        assert_eq!(name(0), "report.pdf");
        assert_eq!(name(1), "notes.txt");
        assert_eq!(name(2).chars().count(), 120);
        assert_eq!(name(3), "report.pdf");
        assert_eq!(items[4], home::Attention::FailedItems(2));
        let ids: std::collections::HashSet<_> =
            items.iter().filter_map(|a| if let home::Attention::Conflict { id, .. } = a { Some(*id) } else { None }).collect();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn fake_transfers_are_uploads_at_forty_percent_of_ten_megabytes() {
        let t = fake_transfers(3);
        assert_eq!(t.len(), 3);
        assert!(t.iter().all(|t| t.direction == "upload" && t.total_bytes == 10_000_000 && t.bytes_transferred == 4_000_000));
    }

    #[test]
    fn a_refused_drive_request_is_shown() {
        let mut h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        h.event(WorkerEvent::DriveDone(Err("The drive is stopping".into())));
        assert!(!h.app.drive_working);
        assert!(h.text_at("The drive is stopping").is_some());

        let reply = SettingsReply { switch_error: Some("Proton Drive is busy moving files".into()), ..Default::default() };
        h.event(WorkerEvent::VirtualDriveSwitched(Ok(reply)));
        assert!(h.text_at("Proton Drive is busy moving files").is_some());
    }

    #[test]
    fn save_preferences_sends_only_what_changed() {
        let mut h = Harness::settings(None, None);
        // Below the fold at 1440x900 since Settings gained the Account card and Start at login
        h.scroll(h.text_at("Save Preferences").unwrap() - Vec2::new(0.0, 200.0), 400.0);
        h.click(h.text_at("Save Preferences").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        assert_eq!(h.app.settings_notice, Some(Notice::info("No changes to save.")));

        h.app.edit_conflict_strategy = "prompt".into();
        h.app.settings_dirty = true;
        h.frames(2);
        h.click(h.text_at("Save Preferences").unwrap());
        assert_eq!(h.sent(), vec![r#"save {"conflictStrategy":"prompt"}"#.to_string()]);
        assert!(h.app.settings_saving);
    }

    // #92 and #91 merged into Stage 1's Settings: the login switch is there and saves, and the conflict strategy offers
    // only the two the daemon still takes
    #[test]
    fn settings_has_start_at_login_and_no_strategy_that_replaces_a_version() {
        let mut h = Harness::settings(None, None);
        h.scroll(h.text_at("Save Preferences").unwrap() - Vec2::new(0.0, 200.0), 400.0);
        h.click(h.text_at("Start Proton Drive when I log in").expect("the login switch is in Settings"));
        assert!(!h.app.edit_start_at_login);
        h.click(h.text_at("Save Preferences").unwrap());
        assert_eq!(h.sent(), vec![r#"save {"startAtLogin":false}"#.to_string()]);

        h.click(h.text_at("Keep Both (Save conflict copy with timestamp)").expect("the strategy's dropdown"));
        assert!(h.text_at("Ask me each time (in Home's Needs attention)").is_some(), "the dropdown is open");
        for gone in ["Keep Local (Overwrite remote revision)", "Keep Remote (Overwrite local file)", "Ask manually in Conflicts tab"] {
            assert!(h.text_at(gone).is_none(), "{gone}");
        }
    }

    #[test]
    fn a_save_refreshes_the_form_from_the_reply_and_shows_what_was_refused() {
        let mut h = Harness::settings(None, None);
        h.app.edit_sync_dir = "/mnt/b/ProtonDrive".into();
        h.app.edit_conflict_strategy = "prompt".into();
        h.app.settings_dirty = true;
        h.app.settings_saving = true;
        let stored = SyncSettings { conflict_strategy: "prompt".into(), ..loaded_settings() };
        let reply = SettingsReply {
            settings: Some(stored.clone()),
            folder_error: Some("The new folder must be empty".into()),
            ..Default::default()
        };
        h.event(WorkerEvent::SettingsSaved(Ok(reply)));
        assert!(!h.app.settings_saving && !h.app.settings_dirty);
        assert_eq!(h.app.edit_sync_dir, "/home/u/ProtonDrive");
        assert_eq!(h.app.loaded_settings, stored);
        assert_eq!(h.app.settings_notice, Some(Notice::error("The new folder must be empty")));

        // A refused save keeps the edits to fix them
        h.app.edit_conflict_strategy = "prompt".into();
        h.app.settings_dirty = true;
        h.app.settings_saving = true;
        h.event(WorkerEvent::SettingsSaved(Err("conflictStrategy must be one of keep-both".into())));
        assert_eq!(h.app.edit_conflict_strategy, "prompt");
        assert!(h.app.settings_dirty && !h.app.settings_saving);
        assert_eq!(h.app.settings_notice, Some(Notice::error("conflictStrategy must be one of keep-both")));
    }

    #[test]
    fn tests_never_reach_the_users_own_settings_files() {
        assert_eq!(startup_cache_path(), None);
        assert_eq!(ui_prefs_path(), None);
    }

    #[test]
    fn a_refused_sign_in_is_an_error_not_a_sign_in_url() {
        let mut h = Harness::new();
        h.event(WorkerEvent::LoginStarted(Err("Not found".into())));
        assert_eq!(h.app.login_url, None);
        assert_eq!(h.app.account_error.as_deref(), Some("Couldn't start signing in: Not found"));
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't start signing in: Not found"));

        // A status doesn't hide it; the next try does
        h.event(WorkerEvent::StatusAndActivity {
            status: Box::new(Ok(DaemonStatus { logged_in: false, ..Default::default() })),
            activity: Vec::new(),
        });
        assert!(h.app.account_error.is_some());
        h.event(WorkerEvent::LoginStarted(Ok(LoginReply { sign_in_url: String::new() })));
        assert_eq!(h.app.login_url.as_deref(), Some(""));
        assert_eq!(h.app.account_error, None);

        h.event(WorkerEvent::LoggedOut(Err("Proton is unreachable".into())));
        assert_eq!(h.app.account_error.as_deref(), Some("Couldn't sign out: Proton is unreachable"));
    }

    #[test]
    fn screenshot_drive_states_fake_every_status_and_both_moves() {
        let fake = |name: &str, mv: Option<&str>| fake_drive_status(name, mv, "/home/u/ProtonDrive", "/home/u");
        let (v, wanted) = fake("mounted", None).unwrap();
        assert_eq!((v, wanted), (vfs("virtual", true, None), true));
        assert_eq!(fake("ejected", None).unwrap(), (vfs("virtual", false, Some("ejected")), true));
        assert_eq!(fake("plain", None).unwrap(), (vfs("plain", false, Some("switched-off")), false));
        assert_eq!(fake("crashed", None).unwrap().0, vfs("virtual", false, Some("crashed")));
        assert_eq!(fake("busy", None).unwrap().0, vfs("virtual", false, Some("mount-point-busy")));
        assert_eq!(fake("starting", None).unwrap().0, vfs("virtual", false, Some("starting")));
        assert_eq!(fake("fuse-unavailable", None).unwrap(), (vfs("plain", false, Some("fuse-unavailable")), true));
        assert_eq!(fake("different-disk", None).unwrap(), (vfs("plain", false, Some("different-disk")), true));
        assert_eq!(fake("moving", None).unwrap().0.reason.as_deref(), Some("moving"));
        let failed = fake("move-failed", None).unwrap().0;
        assert_eq!((failed.reason.as_deref(), failed.error.as_deref()), (Some("move-failed"), Some("No space left on device")));
        assert_eq!(fake("nonsense", None), None);

        let relocation = fake("move-failed", Some("relocation")).unwrap().0.drive_move.unwrap();
        assert_eq!((relocation.kind.as_str(), relocation.from.as_str()), ("relocation", "/home/u/ProtonDrive"));
        assert_eq!(relocation.actions, vec!["move-back".to_string(), "retry".to_string()]);
        let layout = fake("mounted", Some("layout")).unwrap().0.drive_move.unwrap();
        assert_eq!((layout.kind.as_str(), layout.to.as_str()), ("layout", "/home/u/.local/share/proton-drive-ubuntu/files"));
        assert_eq!(layout.actions, vec!["finish".to_string(), "move-back".to_string()]);
        assert_eq!(fake("mounted", Some("sideways")), None);
    }

    // #216: the Share window. The item is Docs/report.pdf in /home/u/ProtonDrive; what the daemon answers comes as events.
    const SHARED: &str = "Docs/report.pdf";
    const LINK_URL: &str = "https://drive.proton.me/urls/7XK2M9QD4A#aB3dE5fG7hJ9";

    fn share_link(has_password: bool, expires_at: Option<i64>) -> share::ShareLink {
        share::ShareLink { url: LINK_URL.into(), has_password, expires_at, role: share::Role::Viewer }
    }

    fn share_person(email: &str, role: share::Role, state: share::PersonState) -> share::SharePerson {
        share::SharePerson { email: email.into(), role, state }
    }

    /// The Share window open on Docs/report.pdf, with the daemon's answer when one is given.
    fn share_window(info: Option<share::ShareInfo>) -> Harness {
        let mut h = Harness::new();
        h.app.status.sync_dir = "/home/u/ProtonDrive".into();
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")], "opening it reads how the item is shared");
        if let Some(info) = info {
            h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(info)));
        }
        h.frames(3);
        h
    }

    fn window(h: &mut Harness) -> &mut share::ShareWindow {
        h.app.share.as_mut().expect("the Share window is open")
    }

    /// The open Share window's id, which the daemon's answers to it carry.
    fn shown(h: &Harness) -> share::WindowId {
        h.app.share.as_ref().expect("the Share window is open").id
    }

    /// Where the last frame painted `text` on the row of `row` (the nearest one to it, up or down).
    fn in_row(h: &Harness, row: &str, text: &str) -> egui::Pos2 {
        let y = h.text_at(row).unwrap_or_else(|| panic!("{row:?} is painted")).y;
        h.text_at_all(text)
            .into_iter()
            .min_by(|a, b| (a.y - y).abs().total_cmp(&(b.y - y).abs()))
            .unwrap_or_else(|| panic!("{text:?} is painted"))
    }

    fn press_key(h: &mut Harness, key: egui::Key) {
        let event = |pressed| egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::NONE };
        h.frame(vec![event(true)]);
        h.frame(vec![event(false)]);
        h.frames(2);
    }

    #[test]
    fn the_share_window_reads_how_its_item_is_shared_and_says_so_when_it_is_not_in_proton_drive() {
        let mut h = share_window(None);
        assert!(h.text_at("Share \"report.pdf\"").is_some(), "titled with the item's name");
        assert!(h.text_at("Loading…").is_some());
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo::default())));
        assert!(h.text_at("Loading…").is_none());
        assert!(h.text_at("Off").is_some(), "no link: the switch is off");
        assert!(h.text_at("You").is_some() && h.text_at("Owner").is_some());
        // An answer for another window (one since replaced) changes nothing
        let other = share::ShareWindow::new("/home/u/ProtonDrive/Other.pdf").id;
        h.event(WorkerEvent::ShareLoaded(other, Err("Not uploaded yet".into())));
        assert!(h.text_at("Not uploaded yet").is_none());

        // The daemon's refusal is shown as it says it, and Try again reads again
        let refusal = "Not uploaded yet: Proton Drive can share it once it has uploaded";
        h.event(WorkerEvent::ShareLoaded(shown(&h), Err(refusal.into())));
        assert!(h.text_at(refusal).is_some());
        h.click(h.text_at("Try again").expect("a failed read can be tried again"));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);

        // Outside the drive, or the drive's folder itself: nothing to ask the daemon
        for outside in ["/home/u/Documents/report.pdf", "/home/u/ProtonDrive"] {
            h.app.open_share(outside);
            h.frames(3);
            assert!(h.text_at("Not in Proton Drive").is_some(), "{outside}");
            assert_eq!(h.sent(), Vec::<String>::new());
        }
    }

    #[test]
    fn the_same_item_again_keeps_the_window_and_nothing_under_it_takes_clicks() {
        let mut h = share_window(Some(share::ShareInfo::default()));
        window(&mut h).invite_input = "a@b.co".into();
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(window(&mut h).invite_input, "a@b.co", "what was typed stays");
        assert_eq!(h.sent(), Vec::<String>::new());
        // The sidebar under the window doesn't react
        let activity = h.text_at("Activity").expect("the sidebar is painted under the window");
        h.click(activity);
        assert_eq!(h.app.tab, NavTab::Home);
        assert!(h.app.share.is_some(), "a click outside the window doesn't close it");
        // Another item replaces it
        h.app.open_share("/home/u/ProtonDrive/Notes/plan.txt");
        assert_eq!(h.sent(), vec!["share info Notes/plan.txt".to_string()]);
        h.frames(2);
        assert!(h.text_at("Share \"plan.txt\"").is_some());
    }

    #[test]
    fn a_share_window_opened_before_the_daemon_answers_reads_once_it_knows_the_folder() {
        let mut h = Harness::new();
        h.app.initial_connecting = true;
        h.app.daemon_online = false;
        h.app.status.sync_dir = "/home/u/ProtonDrive".into(); // as the startup cache had it
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        h.frames(2);
        assert_eq!(h.sent(), Vec::<String>::new(), "the folder may have moved since the cache: wait for the daemon");
        assert!(h.text_at("Loading…").is_some());
        // The daemon doesn't answer: said so, rather than loading for ever
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Err("refused".into())), activity: Vec::new() });
        assert!(h.text_at(share::DAEMON_UNREACHABLE).is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        let status = DaemonStatus { state: "idle".into(), logged_in: true, sync_dir: "/home/u/ProtonDrive".into(), ..Default::default() };
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status.clone())), activity: Vec::new() });
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        assert!(h.text_at(share::DAEMON_UNREACHABLE).is_none());
        assert!(h.text_at("Loading…").is_some());
        // Once
        h.event(WorkerEvent::StatusAndActivity { status: Box::new(Ok(status)), activity: Vec::new() });
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn the_link_switch_turns_the_link_on_at_once_and_off_only_after_asking() {
        let mut h = share_window(Some(share::ShareInfo::default()));
        h.click(h.text_at("Off").expect("the link switch, off"));
        assert_eq!(h.sent(), vec![format!("share link on {SHARED}")]);
        assert!(h.text_at("Working…").is_some());
        // Nothing more goes while it runs
        h.click(h.text_at("Off").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")], "it reads again after every change");
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] })));
        assert!(h.text_at("Working…").is_none());
        assert!(h.text_at("Anyone with the link can view.").is_some());

        // Off asks first; Cancel (or Escape) sends nothing
        h.click(h.text_at("On").expect("the link switch, on"));
        assert!(h.text_at("Stop sharing the link?").is_some());
        assert!(h.text_at("Anyone using it loses access.").is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Cancel").expect("the confirmation's Cancel"));
        assert!(h.text_at("Stop sharing the link?").is_none());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("On").unwrap());
        press_key(&mut h, egui::Key::Escape);
        assert!(h.text_at("Stop sharing the link?").is_none());
        assert!(h.app.share.is_some(), "Escape closes the confirmation, not the window");
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(h.text_at("On").unwrap());
        h.click(h.text_at("Stop sharing").expect("the confirmation's button"));
        assert_eq!(h.sent(), vec![format!("share link off {SHARED}")]);
    }

    #[test]
    fn show_asks_for_the_password_and_shows_it_only_once_it_arrives() {
        let info = share::ShareInfo { link: Some(share_link(true, None)), people: vec![] };
        let mut h = share_window(Some(info));
        assert!(h.text_at("••••••••").is_some(), "hidden until Show");
        h.click(in_row(&h, "Password", "Show"));
        assert_eq!(h.sent(), vec![format!("share password {SHARED}")]);
        assert!(h.text_at("hunter2").is_none());
        h.event(WorkerEvent::SharePassword(shown(&h), Ok(Some("hunter2".into()))));
        assert!(h.text_at("hunter2").is_some());
        h.click(in_row(&h, "Password", "Hide"));
        assert!(h.text_at("hunter2").is_none());
        assert!(h.text_at("••••••••").is_some());
        assert_eq!(h.sent(), Vec::<String>::new());

        // An older link's password, which Proton Drive can't show here
        h.click(in_row(&h, "Password", "Show"));
        assert_eq!(h.sent(), vec![format!("share password {SHARED}")]);
        h.event(WorkerEvent::SharePassword(shown(&h), Ok(None)));
        assert!(h.text_at(share::CANT_SHOW_PASSWORD).is_some());
    }

    #[test]
    fn the_password_is_set_changed_and_removed_with_its_own_buttons() {
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        h.click(in_row(&h, "Password", "Set password"));
        assert_eq!(h.sent(), Vec::<String>::new(), "opening the field sends nothing");
        // An empty password isn't sent
        h.click(h.text_at("Save").expect("the password's Save"));
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.text_at("Type a password").is_some());
        window(&mut h).password_editor = Some("n3w-pass".into());
        h.frames(2);
        h.click(h.text_at("Save").unwrap());
        let body = serde_json::json!({ "path": SHARED, "password": "n3w-pass" });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        assert_eq!(window(&mut h).password_editor, None, "the field closes once it is set");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);

        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(true, None)), people: vec![] })));
        h.click(in_row(&h, "Password", "Remove"));
        let body = serde_json::json!({ "path": SHARED, "password": null });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
        // A refusal is shown as the daemon words it, and the window reads again
        let refusal = "This link has expired: set a new expiry date, or remove the expiry, to change it";
        h.event(WorkerEvent::ShareDone(shown(&h), Err(refusal.into())));
        assert!(h.text_at(refusal).is_some());
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
    }

    #[test]
    fn the_expiry_is_set_from_a_preset_or_a_date_and_removed() {
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        assert!(in_row(&h, "Expires", "Never").y > 0.0);
        h.click(in_row(&h, "Expires", "Set date…"));
        h.click(h.text_at("7 days").expect("the presets"));
        assert_eq!(h.sent(), Vec::<String>::new(), "a preset fills the date in");
        let now = home::now_ms();
        let today = share::local_day(now, home::local_offset_secs);
        assert_eq!(window(&mut h).expiry_editor.as_deref(), Some(share::date_text(today + 7).as_str()));
        h.click(h.text_at("Set").expect("the date's Set"));
        let body = serde_json::json!({ "path": SHARED, "expiresAt": share::end_of_day(today + 7, home::local_offset_secs) });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        assert_eq!(window(&mut h).expiry_editor, None);
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        // The window waits for that read before taking another change
        h.click(in_row(&h, "Expires", "Set date…"));
        assert_eq!(window(&mut h).expiry_editor, None);
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] })));

        // A date that isn't one is said so, and nothing is sent
        h.click(in_row(&h, "Expires", "Set date…"));
        window(&mut h).expiry_editor = Some("2026-02-30".into());
        h.frames(2);
        h.click(h.text_at("Set").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.text_at("Type the date as YYYY-MM-DD").is_some());

        let at = share::end_of_day(today + 3, home::local_offset_secs);
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, Some(at))), people: vec![] })));
        h.click(in_row(&h, "Expires", "Remove"));
        let body = serde_json::json!({ "path": SHARED, "expiresAt": null });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
    }

    #[test]
    fn invite_sends_every_address_with_the_role_after_checking_them() {
        let mut h = share_window(Some(share::ShareInfo::default()));
        window(&mut h).invite_input = "a@b.co, nope".into();
        h.frames(2);
        h.click(h.text_at("Invite").expect("the Invite button"));
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.text_at("Not a valid email address: nope").is_some());

        window(&mut h).invite_input = "a@b.co, c@d.org".into();
        window(&mut h).invite_role = share::Role::Editor;
        h.frames(2);
        h.click(h.text_at("Invite").unwrap());
        assert_eq!(h.sent(), vec![format!("share invite {SHARED} a@b.co,c@d.org editor")]);
        assert!(h.text_at("Not a valid email address: nope").is_none());
        // Refused: the addresses stay, to change and send again
        h.event(WorkerEvent::ShareDone(shown(&h), Err("Already has access: change their role instead".into())));
        assert!(h.text_at("Already has access: change their role instead").is_some());
        assert_eq!(window(&mut h).invite_input, "a@b.co, c@d.org");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo::default())));
        assert!(h.text_at("Already has access: change their role instead").is_some(), "the refusal stays after the read");
        h.click(h.text_at("Invite").unwrap());
        assert_eq!(h.sent(), vec![format!("share invite {SHARED} a@b.co,c@d.org editor")]);
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        assert_eq!(window(&mut h).invite_input, "", "invited: the field empties");
    }

    fn with_people() -> share::ShareInfo {
        use share::{PersonState, Role};
        share::ShareInfo {
            link: Some(share_link(false, None)),
            people: vec![
                share_person("alex@proton.me", Role::Editor, PersonState::Member),
                share_person("sam@proton.me", Role::Viewer, PersonState::Invited),
                share_person("jo@example.com", Role::Viewer, PersonState::InvitedNotProton),
            ],
        }
    }

    #[test]
    fn who_has_access_lists_everyone_and_removing_someone_asks_first() {
        let mut h = share_window(Some(with_people()));
        for email in ["alex@proton.me", "sam@proton.me", "jo@example.com"] {
            assert!(h.text_at(email).is_some(), "{email}");
        }
        h.click(in_row(&h, "sam@proton.me", "×"));
        assert!(h.text_at("Remove sam@proton.me?").is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Cancel").unwrap());
        assert!(h.text_at("Remove sam@proton.me?").is_none());
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(in_row(&h, "sam@proton.me", "×"));
        h.click(h.text_at("Remove access").expect("the confirmation's button"));
        assert_eq!(h.sent(), vec![format!("share remove {SHARED} sam@proton.me")]);
    }

    #[test]
    fn a_role_change_shows_at_once_and_a_refusal_reads_the_roles_again() {
        let mut h = share_window(Some(with_people()));
        h.click(in_row(&h, "alex@proton.me", "Editor"));
        let viewer = *h.text_at_all("Viewer").last().expect("the role choices");
        h.click(viewer);
        assert_eq!(h.sent(), vec![format!("share role {SHARED} alex@proton.me viewer")]);
        let alex = |h: &mut Harness| window(h).info.clone().unwrap().unwrap().people[0].role;
        assert_eq!(alex(&mut h), share::Role::Viewer, "shown at once");
        h.event(WorkerEvent::ShareDone(shown(&h), Err("Proton Drive is offline".into())));
        assert!(h.text_at("Proton Drive is offline").is_some());
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")], "the roles as they are come back");
    }

    #[test]
    fn copy_link_puts_the_link_on_the_clipboard_and_done_or_escape_closes_the_window() {
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        let pos = h.text_at("Copy link").expect("Copy link");
        h.frame(vec![egui::Event::PointerMoved(pos)]);
        let button = |pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE };
        h.frame(vec![button(true)]);
        h.frame(vec![button(false)]);
        let copied = h.last.as_ref().unwrap().platform_output.commands.iter().any(|c| matches!(c, egui::OutputCommand::CopyText(t) if t == LINK_URL));
        assert!(copied, "the link is on the clipboard");
        h.frames(2);
        assert!(h.text_at("Copied").is_some());
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(h.text_at("Done").expect("Done"));
        assert!(h.app.share.is_none());
        let mut h = share_window(Some(share::ShareInfo::default()));
        press_key(&mut h, egui::Key::Escape);
        assert!(h.app.share.is_none());
    }

    // Important 1: closing the window never waits for a change, but a change that then fails is still told
    #[test]
    fn a_change_that_fails_after_its_window_closed_is_told_in_the_notice() {
        let offline = || Err("Proton Drive is offline".to_string());
        // Done while the link is being turned off
        let mut h = share_window(Some(with_people()));
        let first = shown(&h);
        h.click(h.text_at("On").expect("the link switch, on"));
        h.click(h.text_at("Stop sharing").expect("the confirmation's button"));
        assert_eq!(h.sent(), vec![format!("share link off {SHARED}")]);
        h.click(h.text_at("Done").unwrap());
        assert!(h.app.share.is_none(), "Done doesn't wait");
        h.event(WorkerEvent::ShareDone(first, offline()));
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't stop sharing the link to report.pdf: Proton Drive is offline"));
        assert!(h.text_at("Couldn't stop sharing the link to report.pdf: Proton Drive is offline").is_some(), "on Home");
        assert_eq!(h.sent(), Vec::<String>::new(), "no window to read again for");
        // Told once: a second answer for that window is nobody's
        h.app.notice = None;
        h.event(WorkerEvent::ShareDone(first, offline()));
        assert_eq!(h.app.notice, None);

        // Escape while someone's access is being removed
        let mut h = share_window(Some(with_people()));
        let second = shown(&h);
        h.click(in_row(&h, "sam@proton.me", "×"));
        h.click(h.text_at("Remove access").unwrap());
        assert_eq!(h.sent(), vec![format!("share remove {SHARED} sam@proton.me")]);
        press_key(&mut h, egui::Key::Escape);
        assert!(h.app.share.is_none(), "Escape doesn't wait either");
        h.event(WorkerEvent::ShareDone(second, offline()));
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't remove sam@proton.me's access to report.pdf: Proton Drive is offline"));

        // Files' Share… for another item, while a password is being set: that window replaces this one
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        let third = shown(&h);
        h.click(in_row(&h, "Password", "Set password"));
        window(&mut h).password_editor = Some("n3w-pass".into());
        h.frames(2);
        h.click(h.text_at("Save").unwrap());
        assert_eq!(h.sent().len(), 1);
        h.app.open_share("/home/u/ProtonDrive/Notes/plan.txt");
        assert_eq!(h.sent(), vec!["share info Notes/plan.txt".to_string()]);
        h.event(WorkerEvent::ShareDone(third, Err("Timed out".into())));
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't change the password of the link to report.pdf: Timed out"));
        assert_eq!(window(&mut h).error, None, "not shown in the other item's window");
        assert_eq!(h.sent(), Vec::<String>::new(), "the open window is another item's: it has nothing to read again");

        // One that went through says nothing
        let mut h = share_window(Some(share::ShareInfo::default()));
        let fourth = shown(&h);
        h.click(h.text_at("Off").unwrap());
        assert_eq!(h.sent(), vec![format!("share link on {SHARED}")]);
        h.click(h.text_at("Done").unwrap());
        h.event(WorkerEvent::ShareDone(fourth, Ok(())));
        assert_eq!(h.app.notice, None);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    // Minor 3: an answer for a window since closed never lands in one opened again on the same item
    #[test]
    fn an_answer_for_a_closed_window_does_not_land_in_one_reopened_on_the_same_item() {
        let mut h = share_window(Some(with_people()));
        let closed = shown(&h);
        h.click(in_row(&h, "alex@proton.me", "Editor"));
        h.click(*h.text_at_all("Viewer").last().unwrap());
        assert_eq!(h.sent(), vec![format!("share role {SHARED} alex@proton.me viewer")]);
        press_key(&mut h, egui::Key::Escape);
        assert!(h.app.share.is_none());
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        assert_ne!(shown(&h), closed, "a window of its own");
        // The closed window's read can't fill this one either
        h.event(WorkerEvent::ShareLoaded(closed, Ok(share::ShareInfo::default())));
        assert!(h.text_at("Loading…").is_some());
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(with_people())));
        window(&mut h).invite_input = "kim@proton.me".into();
        h.frames(2);
        h.click(h.text_at("Invite").unwrap());
        assert_eq!(h.sent(), vec![format!("share invite {SHARED} kim@proton.me viewer")]);
        // The closed window's role change is answered: the new window still waits for its invitation
        h.event(WorkerEvent::ShareDone(closed, Err("Proton Drive is offline".into())));
        assert!(h.text_at("Working…").is_some(), "the invitation is still out");
        assert!(h.text_at("Proton Drive is offline").is_none(), "not pinned on the invitation");
        assert_eq!(window(&mut h).invite_input, "kim@proton.me");
        assert_eq!(h.app.notice.as_deref(), Some("Couldn't change alex@proton.me's access to report.pdf: Proton Drive is offline"));
        assert_eq!(h.sent(), Vec::<String>::new(), "it reads again once its own invitation is answered");
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        assert_eq!(window(&mut h).invite_input, "", "its own answer did land");
    }

    // A change from a closed window answered while one is open again on its item: what that one read may be from
    // before the change, so it reads again
    #[test]
    fn a_window_open_again_on_the_item_reads_again_once_the_closed_ones_change_is_answered() {
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        let closed = shown(&h);
        h.click(h.text_at("On").unwrap());
        h.click(h.text_at("Stop sharing").unwrap());
        assert_eq!(h.sent(), vec![format!("share link off {SHARED}")]);
        h.click(h.text_at("Done").unwrap());
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        // Read before the link went: it still shows it
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] })));
        h.event(WorkerEvent::ShareDone(closed, Ok(())));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        assert_eq!(h.app.notice, None);
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo::default())));
        assert!(h.text_at("Off").is_some());
    }

    // Minor 7: Share… again on the same item reads again when nothing has been typed in its window, so an error the
    // daemon gave earlier (Not uploaded yet, before the upload finished) doesn't stay
    #[test]
    fn share_again_on_the_same_item_reads_again_unless_something_is_typed() {
        let mut h = share_window(None);
        let refusal = "Not uploaded yet: Proton Drive can share it once it has uploaded";
        h.event(WorkerEvent::ShareLoaded(shown(&h), Err(refusal.into())));
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")], "the error may be out of date");
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo::default())));
        assert!(h.text_at(refusal).is_none());
        // Nothing typed: it reads again; while that read is out, not twice
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), Vec::<String>::new());
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo::default())));
        // Something typed: the window stays as it is
        window(&mut h).invite_input = "a@b.co".into();
        h.app.open_share("/home/u/ProtonDrive/Docs/report.pdf");
        assert_eq!(h.sent(), Vec::<String>::new());
        assert_eq!(window(&mut h).invite_input, "a@b.co");
    }

    // Minor 2: an expired link can't be copied (Files refuses it too); it says why and what to do
    #[test]
    fn an_expired_link_cant_be_copied_and_says_why() {
        let yesterday = home::now_ms() - 86_400_000;
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, Some(yesterday))), people: vec![] }));
        assert!(h.text_at(share::LINK_EXPIRED).is_some(), "says why");
        assert!(h.text_at("Anyone with the link can view.").is_none(), "no one can, now");
        let pos = h.text_at("Copy link").expect("Copy link, disabled");
        h.click(pos);
        let copied = h.last.as_ref().unwrap().platform_output.commands.iter().any(|c| matches!(c, egui::OutputCommand::CopyText(_)));
        assert!(!copied, "nothing on the clipboard");
        assert!(h.text_at("Copied").is_none());
        // A new date makes it copyable again (and an older link, with no expiry, still copies)
        let next_week = home::now_ms() + 7 * 86_400_000;
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, Some(next_week))), people: vec![] })));
        assert!(h.text_at(share::LINK_EXPIRED).is_none());
        let pos = h.text_at("Copy link").unwrap();
        h.frame(vec![egui::Event::PointerMoved(pos)]);
        let button = |pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE };
        h.frame(vec![button(true)]);
        h.frame(vec![button(false)]);
        let copied = h.last.as_ref().unwrap().platform_output.commands.iter().any(|c| matches!(c, egui::OutputCommand::CopyText(t) if t == LINK_URL));
        assert!(copied);
    }

    /// Clicks the field showing `hint`, types `text` into it and presses Enter.
    fn type_and_enter(h: &mut Harness, hint: &str, text: &str) {
        h.click(h.text_at(hint).unwrap_or_else(|| panic!("the field {hint:?}")));
        h.frame(vec![egui::Event::Text(text.into())]);
        press_key(h, egui::Key::Enter);
    }

    // Minor 6: Enter sends what was typed, as the button beside each field does
    #[test]
    fn enter_in_the_invite_password_and_date_fields_sends_as_their_buttons_do() {
        let mut h = share_window(Some(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] }));
        type_and_enter(&mut h, "email@example.com, …", "a@b.co c@d.org");
        assert_eq!(h.sent(), vec![format!("share invite {SHARED} a@b.co,c@d.org viewer")]);
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(false, None)), people: vec![] })));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);

        h.click(in_row(&h, "Password", "Set password"));
        type_and_enter(&mut h, "New password", "n3w-pass");
        let body = serde_json::json!({ "path": SHARED, "password": "n3w-pass" });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
        h.event(WorkerEvent::ShareDone(shown(&h), Ok(())));
        h.event(WorkerEvent::ShareLoaded(shown(&h), Ok(share::ShareInfo { link: Some(share_link(true, None)), people: vec![] })));
        assert_eq!(h.sent(), vec![format!("share info {SHARED}")]);

        h.click(in_row(&h, "Expires", "Set date…"));
        let today = share::local_day(home::now_ms(), home::local_offset_secs);
        let date = share::date_text(today + 2);
        type_and_enter(&mut h, "YYYY-MM-DD", &date);
        let body = serde_json::json!({ "path": SHARED, "expiresAt": share::end_of_day(today + 2, home::local_offset_secs) });
        assert_eq!(h.sent(), vec![format!("share settings {body}")]);
    }

    #[test]
    fn the_share_screenshots_fake_each_state() {
        let now = 1_793_750_400_000;
        let state = |name| share::fake_share_info(name, now, |_| 3600);
        assert_eq!(state("none"), Some(share::ShareInfo::default()));
        let link = state("link").unwrap().link.unwrap();
        assert!(!link.has_password && link.expires_at.is_none());
        let with_password = state("link-password").unwrap().link.unwrap();
        assert!(with_password.has_password && with_password.expires_at.is_some_and(|at| at > now));
        let expired = state("link-expired").unwrap().link.unwrap();
        assert!(!expired.has_password && expired.expires_at.is_some_and(|at| at < now && at > now - 2 * 86_400_000));
        let people = state("people").unwrap();
        assert!(people.link.is_some());
        let states: Vec<share::PersonState> = people.people.iter().map(|p| p.state).collect();
        assert_eq!(states, vec![share::PersonState::Member, share::PersonState::Invited, share::PersonState::InvitedNotProton]);
        assert_eq!(people.people[0].role, share::Role::Editor);
        assert_eq!(state("nonsense"), None);
    }

    #[test]
    fn share_requests_go_over_the_control_socket_and_a_refusal_is_shown_as_is() {
        use share::Role;
        let info: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"link\":null,\"people\":[{\"email\":\"a@b.co\",\"role\":\"viewer\",\"state\":\"member\"}]}";
        let (sock, server) = serve_once(info);
        let got = share::info_at(&sock, "My Docs/a&b.pdf").unwrap();
        assert_eq!(got.people.len(), 1);
        let request = server.join().unwrap();
        // The path travels in the query, encoded
        assert!(request.starts_with("GET /share/info?path=My%20Docs%2Fa%26b.pdf HTTP/1.1\r\n"), "{request}");

        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"password\":\"s3cret!\"}");
        assert_eq!(share::password_at(&sock, "a.pdf"), Ok(Some("s3cret!".to_string())));
        assert!(server.join().unwrap().starts_with("GET /share/password?path=a.pdf HTTP/1.1\r\n"));
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"password\":null} ");
        assert_eq!(share::password_at(&sock, "a.pdf"), Ok(None));
        server.join().unwrap();

        let done: &'static [u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"link\":null,\"people\":[]}";
        type Call = Box<dyn Fn(&std::path::Path) -> Result<(), String>>;
        let cases: Vec<(&str, Call, serde_json::Value)> = vec![
            ("POST /share/link ", Box::new(|s| share::ensure_link_at(s, "a.pdf")), serde_json::json!({ "path": "a.pdf" })),
            ("DELETE /share/link ", Box::new(|s| share::remove_link_at(s, "a.pdf")), serde_json::json!({ "path": "a.pdf" })),
            (
                "POST /share/link/settings ",
                Box::new(|s| share::settings_at(s, "a.pdf", Some(Some("pw")), Some(None))),
                serde_json::json!({ "path": "a.pdf", "password": "pw", "expiresAt": null }),
            ),
            (
                "POST /share/invite ",
                Box::new(|s| share::invite_at(s, "a.pdf", &["a@b.co".to_string(), "c@d.org".to_string()], Role::Editor)),
                serde_json::json!({ "path": "a.pdf", "emails": ["a@b.co", "c@d.org"], "role": "editor" }),
            ),
            (
                "POST /share/role ",
                Box::new(|s| share::role_at(s, "a.pdf", "a@b.co", Role::Viewer)),
                serde_json::json!({ "path": "a.pdf", "email": "a@b.co", "role": "viewer" }),
            ),
            (
                "DELETE /share/person ",
                Box::new(|s| share::remove_person_at(s, "a.pdf", "a@b.co")),
                serde_json::json!({ "path": "a.pdf", "email": "a@b.co" }),
            ),
        ];
        for (line, call, body) in cases {
            let (sock, server) = serve_once(done);
            assert_eq!(call(&sock), Ok(()), "{line}");
            let request = server.join().unwrap();
            assert!(request.starts_with(&format!("{line}HTTP/1.1\r\n")), "{request}");
            assert_eq!(request_body(&request), body, "{line}");
        }

        // The daemon's 400 is shown as it says it; an older daemon without the routes asks for a restart
        let (sock, server) = serve_once(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"Already has access: change their role instead\"}");
        assert_eq!(
            share::invite_at(&sock, "a.pdf", &["a@b.co".to_string()], Role::Viewer),
            Err("Already has access: change their role instead".to_string())
        );
        server.join().unwrap();
        let (sock, server) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"Not found\"}");
        assert_eq!(share::info_at(&sock, "a.pdf"), Err(share::SHARE_NEEDS_RESTART.to_string()));
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }

    // #276: Proton's colours, as drive.proton.me shows them in light mode
    #[test]
    fn the_light_palette_is_protons() {
        assert_eq!(LIGHT.sidebar, Color32::from_rgb(0x21, 0x1A, 0x42));
        assert_eq!(LIGHT.sidebar_selected, Color32::from_rgb(0x2E, 0x23, 0x59));
        assert_eq!(LIGHT.sidebar_text, Color32::WHITE);
        assert_eq!(LIGHT.sidebar_weak, Color32::from_rgb(0xB1, 0xA1, 0xF5));
        assert_eq!(
            (LIGHT.storage_fill, LIGHT.storage_track),
            (Color32::from_rgb(0xB1, 0xA1, 0xF5), Color32::from_rgb(0x3E, 0x2F, 0x7F))
        );
        assert_eq!((LIGHT.canvas, LIGHT.card), (Color32::WHITE, Color32::WHITE));
        assert_eq!(
            (LIGHT.card_alt, LIGHT.input),
            (Color32::from_rgb(0xF5, 0xF4, 0xF2), Color32::from_rgb(0xF5, 0xF4, 0xF2))
        );
        assert_eq!(
            (LIGHT.border_weak, LIGHT.border_norm),
            (Color32::from_rgb(0xEA, 0xE7, 0xE4), Color32::from_rgb(0xD1, 0xCF, 0xCD))
        );
        assert_eq!(
            (LIGHT.text, LIGHT.text_weak),
            (Color32::from_rgb(0x0C, 0x0C, 0x14), Color32::from_rgb(0x5C, 0x59, 0x58))
        );
        assert_eq!(LIGHT.folder, Color32::from_rgb(0xF5, 0xA4, 0x28));
        assert_eq!(PROTON_PURPLE_HOVER, Color32::from_rgb(0x62, 0x43, 0xE6));
    }

    #[test]
    fn the_dark_palette_keeps_todays_colours() {
        // Every dark value main had (dacfcea), the sidebar's being its own panel's
        let rgb = Color32::from_rgb;
        assert_eq!(DARK.canvas, rgb(26, 24, 35));
        assert_eq!(DARK.sidebar, rgb(20, 18, 27));
        assert_eq!(DARK.card, rgb(33, 29, 44));
        assert_eq!(DARK.card_alt, rgb(42, 37, 56));
        assert_eq!(DARK.input, rgb(35, 31, 48));
        assert_eq!(DARK.border_weak, rgb(48, 43, 64));
        assert_eq!(DARK.text, rgb(247, 246, 252));
        assert_eq!(DARK.text_weak, rgb(162, 158, 178));
        assert_eq!(DARK.purple_soft, rgb(44, 37, 69));
        assert_eq!(DARK.purple_text, rgb(214, 204, 255));
    }

    #[test]
    fn contrast_is_the_wcag_ratio() {
        assert!((contrast(Color32::BLACK, Color32::WHITE) - 21.0).abs() < 0.01);
        assert_eq!(contrast(Color32::WHITE, Color32::BLACK), contrast(Color32::BLACK, Color32::WHITE), "either way");
        assert_eq!(contrast(PROTON_PURPLE, PROTON_PURPLE), 1.0);
        // #767676 on white is the lightest grey that reads at 4.5:1
        let grey = Color32::from_rgb(0x76, 0x76, 0x76);
        assert!((contrast(grey, Color32::WHITE) - 4.54).abs() < 0.01, "{}", contrast(grey, Color32::WHITE));
    }

    #[test]
    fn text_reads_at_4_5_to_1_in_both_palettes() {
        for p in [&LIGHT, &DARK] {
            for (fg, bg, what) in [
                (p.text, p.canvas, "text"),
                (p.text_weak, p.canvas, "weak text"),
                (p.text_weak, p.card_alt, "weak text on a hovered row"),
                (p.text_weak, p.input, "weak text on an input"),
                (p.purple_text, p.purple_soft, "the plan pill"),
                (p.text, p.card, "text on cards"),
                (p.sidebar_text, p.sidebar, "sidebar"),
                (p.sidebar_text, p.sidebar_selected, "selected section"),
                (p.sidebar_weak, p.sidebar, "sidebar weak"),
                (Color32::WHITE, PROTON_PURPLE, "primary button"),
                (p.danger_text, p.canvas, "red text"),
                (p.danger_text, p.card, "red text on cards"),
            ] {
                assert!(contrast(fg, bg) >= 4.5, "{what}: {:.2}", contrast(fg, bg));
            }
        }
    }

    #[test]
    fn an_icon_button_is_found_by_its_label_and_says_it_on_hover() {
        let mut h = Harness::widget(|ui| {
            icon_button(ui, icons::REFRESH, "Refresh");
        });
        let at = h.widget_at("Refresh").expect("named Refresh for screen readers");
        assert!(h.text_at(icons::REFRESH).is_some(), "the icon is painted");
        assert_eq!(h.text_at("Refresh"), None, "and no label");
        assert_eq!(h.fill_under(at), Some(BG_CANVAS()), "no fill of its own");
        h.frame(vec![egui::Event::PointerMoved(at)]);
        h.frames(120); // 2 s, as frames come at 60 a second
        assert!(h.text_at("Refresh").is_some(), "the tooltip says what it does");
        assert_eq!(h.fill_under(at), Some(BG_CARD_ALT()), "until hovered");
    }

    /// The size of `icon` drawn at 16 pt in Phosphor alone.
    fn phosphor_glyph_size(icon: &str) -> Vec2 {
        let ctx = egui::Context::default();
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert("phosphor".into(), std::sync::Arc::new(egui_phosphor::Variant::Regular.font_data()));
        fonts.families.insert(FontFamily::Proportional, vec!["phosphor".into()]);
        ctx.set_fonts(fonts);
        let _ = ctx.run(egui::RawInput::default(), |_| {}); // the fonts load with the first frame
        ctx.fonts(|f| f.layout_no_wrap(icon.into(), FontId::proportional(16.0), Color32::WHITE)).mesh_bounds.size()
    }

    // Inter, the app's font, has glyphs of its own at some of Phosphor's private-use code points (the house, the gear,
    // the open folder…): an icon drawn in Inter's family shows Inter's glyph instead of Phosphor's
    #[test]
    fn each_icon_is_drawn_as_phosphors_glyph() {
        let mut wrong = Vec::new();
        for icon in icons::ALL {
            let h = Harness::widget(move |ui| {
                action_button(ui, ButtonKind::Secondary, Some(icon), "Label", 32.0);
            });
            let drawn = h.text_rect(icon).expect("the icon is painted").size();
            if (drawn - phosphor_glyph_size(icon)).length() > 1.0 {
                wrong.push(format!("{icon:?} drawn {drawn:?}, Phosphor's is {:?}", phosphor_glyph_size(icon)));
            }
        }
        assert_eq!(wrong, Vec::<String>::new());
    }

    #[test]
    fn an_action_buttons_label_is_still_painted_text() {
        let h = Harness::widget(|ui| {
            action_button(ui, ButtonKind::Secondary, Some(icons::SYNC), "Sync now", 32.0);
        });
        let label = h.text_at("Sync now").expect("the label is painted text");
        assert!(h.widget_at("Sync now").is_some(), "and the button's name");
        let icon = h.text_at(icons::SYNC).expect("the icon is painted");
        assert!(icon.x < label.x, "the icon comes before the label");
    }

    #[test]
    fn a_proton_button_is_named_by_its_label() {
        let h = Harness::widget(|ui| {
            proton_button(ui, Vec2::new(90.0, 30.0), "Unblock", BG_CARD_ALT(), BG_INPUT(), None, TEXT_PRIMARY(), 12.5);
        });
        let button = h.widget_at("Unblock").expect("named by its label");
        let label = h.text_at("Unblock").unwrap();
        assert!((button - label).length() < 3.0, "the button {button:?} is where its label {label:?} is painted");
    }

    #[test]
    fn each_button_kind_has_its_look() {
        let mut h = Harness::widget(|ui| {
            action_button(ui, ButtonKind::Primary, None, "Primary", 32.0);
            action_button(ui, ButtonKind::Secondary, Some(icons::TRASH), "Secondary", 32.0);
            action_button(ui, ButtonKind::Danger, None, "Danger", 32.0);
            home::secondary_button(ui, "Old secondary", 32.0);
            home::primary_button(ui, "Old primary", 32.0);
        });
        let fill = |h: &Harness, label| h.fill_under(h.widget_at(label).unwrap());
        assert_eq!(fill(&h, "Primary"), Some(PROTON_PURPLE));
        assert_eq!(fill(&h, "Secondary"), Some(BG_CARD()));
        assert_eq!(fill(&h, "Danger"), Some(STATUS_DANGER));
        assert_eq!(fill(&h, "Old secondary"), Some(BG_CARD()));
        assert_eq!(fill(&h, "Old primary"), Some(PROTON_PURPLE));
        h.frame(vec![egui::Event::PointerMoved(h.widget_at("Secondary").unwrap())]);
        h.frames(2);
        // The weak background: the same as an input's in light, and visible on a card in dark (an input's isn't)
        assert_eq!(fill(&h, "Secondary"), Some(BG_CARD_ALT()), "a secondary button's hover");
    }

    const INTER_REGULAR: &[u8] = include_bytes!("../../assets/fonts/Inter-Regular.ttf");
    const INTER_SEMIBOLD: &[u8] = include_bytes!("../../assets/fonts/Inter-SemiBold.ttf");

    /// How wide `text` is at `size` points in one face of Inter alone.
    fn width_in(face: &'static [u8], text: &str, size: f32) -> f32 {
        let ctx = egui::Context::default();
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert("face".into(), std::sync::Arc::new(egui::FontData::from_static(face)));
        fonts.families.insert(FontFamily::Proportional, vec!["face".into()]);
        ctx.set_fonts(fonts);
        let _ = ctx.run(egui::RawInput::default(), |_| {}); // the fonts load with the first frame
        ctx.fonts(|f| f.layout_no_wrap(text.into(), FontId::proportional(size), Color32::WHITE)).size().x
    }

    /// Whether the last frame laid `text` out in the bold family, the first time it painted it left of `left_of`.
    fn painted_bold(h: &Harness, text: &str, left_of: f32) -> bool {
        let shown = h.texts(|t| t.galley.text() == text && t.visual_bounding_rect().right() < left_of);
        let galley = &shown.first().unwrap_or_else(|| panic!("{text:?} is painted")).galley;
        galley.job.sections.iter().all(|s| s.format.font_id.family == FontFamily::Name(BOLD_FAMILY.into()))
    }

    // #279: egui's .strong() only picks a colour, and the app sets one on almost every label, so nothing was ever bold
    #[test]
    fn bold_text_is_laid_out_in_inter_semibold() {
        let h = Harness::new(); // On Home
        // The bold family is Inter SemiBold: a line in it is as wide as in SemiBold, and wider than in Regular (short
        // words differ too little to tell)
        let line = "Proton Drive keeps your files in sync";
        let laid = h.ctx.fonts(|f| f.layout_no_wrap(line.into(), bold(16.0), Color32::WHITE)).size().x;
        assert!((laid - width_in(INTER_SEMIBOLD, line, 16.0)).abs() < 0.5, "{laid} wide, not SemiBold's");
        assert!(laid > width_in(INTER_REGULAR, line, 16.0) + 4.0, "{laid} wide, as Regular is");
        // And what is meant to be bold is laid out in it
        assert!(painted_bold(&h, "Proton Drive", f32::MAX), "the sidebar's brand");
        assert!(painted_bold(&h, "Home", SIDEBAR_EDGE), "the open section's name, in the sidebar");
        assert!(painted_bold(&h, "Your drive", f32::MAX), "a card's title");
        assert!(!painted_bold(&h, "Shared", SIDEBAR_EDGE), "a section that isn't open stays regular");
    }
}
