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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
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
    /// Why the state is "error" (the last pass failed, or the files are missing from the folder)
    #[serde(default)]
    last_error: Option<String>,
    /// While the daemon holds because the files are missing from the folder: what is missing
    #[serde(default)]
    files_missing: Option<FilesMissing>,
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
}

/// What is missing while the daemon holds because the files are missing from the folder (`filesMissing` in
/// /api/status): the folder, the recorded top-level items still missing, and how many items that is.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct FilesMissing {
    root: String,
    names: Vec<String>,
    items: u64,
}

/// "Docs and Photos are", "A, B, C and 2 more are": the missing top-level items as the hold banner names them.
fn missing_names(fm: &FilesMissing) -> String {
    const SHOWN: usize = 3;
    let n = fm.names.len();
    match n {
        0 => "Your files are".to_string(),
        1 => format!("{} is", fm.names[0]),
        _ if n <= SHOWN => format!("{} and {} are", fm.names[..n - 1].join(", "), fm.names[n - 1]),
        _ => format!("{} and {} more are", fm.names[..SHOWN].join(", "), n - SHOWN),
    }
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

/// Menu entries for one item, as (label, action) with the daemon's action names. The root can't be hidden, and a
/// hidden or hiding item offers only Unhide: it has to be unhidden before it can be kept (ruling R18).
fn menu_actions(a: Availability, is_root: bool) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    let hidden = matches!(a, Availability::Hidden | Availability::Hiding);
    if a != Availability::Pinned && !hidden {
        out.push(("Always keep on this device", "pin"));
    }
    if matches!(a, Availability::Pinned | Availability::Downloaded) {
        out.push(("Free up space", "free"));
    }
    if !hidden && !is_root {
        out.push(("Hide from this computer", "hide"));
    }
    if hidden {
        out.push(("Unhide", "unhide"));
    }
    out
}

/// The browser path relative to the sync folder; empty at the root.
fn folder_rel_path(remote_path: &str) -> &str {
    remote_path.strip_prefix("/my-files").unwrap_or(remote_path).trim_matches('/')
}

/// An item's path relative to the sync folder: the browser path without `/my-files`, joined with its name.
fn item_rel_path(remote_path: &str, name: &str) -> String {
    let dir = folder_rel_path(remote_path);
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// The status pill for a sync error: the daemon's reason when it gives one (such as the files missing from the
/// folder), shortened to fit with the full text on hover.
fn sync_error_text(status: &DaemonStatus) -> String {
    status.last_error.as_deref().map(str::trim).filter(|e| !e.is_empty()).unwrap_or("Sync Error").to_string()
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

/// Sign-in answers once the browser has the sign-in page, or after 3 s without it.
const LOGIN_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Sign-out stops the sync engine first.
const LOGOUT_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Saving settings, the virtual drive switch, Mount again and an action on a stopped move can move every file.
const DRIVE_READ_TIMEOUT: Duration = Duration::from_secs(600);
/// Resolving a conflict may upload or download the file.
const RESOLVE_READ_TIMEOUT: Duration = Duration::from_secs(600);
const MKDIR_READ_TIMEOUT: Duration = Duration::from_secs(60);

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

/// POST /sync/files-missing {action: "delete-in-cloud"}: the files missing from the folder were deleted on purpose, so
/// the daemon's next sync moves them to the Proton Drive trash.
fn files_missing_delete_at(socket: &std::path::Path) -> Result<(), String> {
    let body = serde_json::json!({ "action": "delete-in-cloud" });
    control_request_at(socket, "POST", "/sync/files-missing", Some(&body), DRIVE_READ_TIMEOUT).map(|_| ())
}

/// POST /remote/mkdir {parentPath, name}: makes a folder in the cloud.
fn make_folder_at(socket: &std::path::Path, parent_path: &str, name: &str) -> Result<(), String> {
    let body = serde_json::json!({ "parentPath": parent_path, "name": name });
    control_request_at(socket, "POST", "/remote/mkdir", Some(&body), MKDIR_READ_TIMEOUT).map(|_| ())
}

/// Whether clicking a file's row opens it: a local copy opens as it is, and on the mounted virtual drive an online-only
/// file opens through the drive, which downloads it. Hidden items don't open.
fn file_opens_on_click(availability: Availability, vfs: Option<&VfsStatus>) -> bool {
    match availability {
        Availability::Pinned | Availability::Downloaded => true,
        Availability::OnlineOnly => vfs.is_some_and(|v| v.mode == "virtual" && v.mounted),
        Availability::Hidden | Availability::Hiding => false,
    }
}

/// An open row menu: the item it acts on and where it was opened.
#[derive(Clone, Debug)]
struct RowMenu {
    name: String,
    rel_path: String,
    availability: Availability,
    pos: egui::Pos2,
}

/// An action that waits for the user's confirmation.
#[derive(Clone, Debug, PartialEq)]
enum PendingConfirm {
    Hide { name: String, rel_path: String },
    /// Free up space for everything in the current folder (`rel_path` is empty at the root).
    FreeAll { rel_path: String },
    /// Keep all at the My files root, which downloads the whole drive (ruling R19); in a folder it needs no confirmation.
    KeepAll,
    /// Switching the virtual drive off moves the downloaded files back into a normal folder.
    VirtualDriveOff,
    /// The files missing from the folder were deleted on purpose: they go to the Proton Drive trash too.
    DeleteMissing { root: String, items: u64 },
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

fn confirm_copy(confirm: &PendingConfirm) -> ConfirmCopy {
    match confirm {
        PendingConfirm::Hide { name, rel_path } => ConfirmCopy {
            title: format!("Hide \"{name}\" from this computer?"),
            body: format!("\"{name}\" disappears from your Proton Drive folder on this computer. It stays in Proton Drive, and you can unhide it any time."),
            detail: "Changes that haven't synced yet are uploaded first. Hiding is refused if anything inside exists only on this computer.",
            button: "Hide",
            cancel: "Cancel",
            rel_path: rel_path.clone(),
            action: "hide",
        },
        PendingConfirm::FreeAll { rel_path } => {
            let place = if rel_path.is_empty() { "My files".to_string() } else { format!("\"{rel_path}\"") };
            ConfirmCopy {
                title: format!("Free up space in {place}?"),
                body: format!("This removes the local copies of everything in {place} that is safely in Proton Drive. Nothing is deleted online. Use Always keep to download them again."),
                detail: "Anything marked Always keep here stops being kept. Files that aren't fully synced, or that you've told Proton Drive to ignore, stay on this computer.",
                button: "Free up space",
                cancel: "Cancel",
                rel_path: rel_path.clone(),
                action: "free",
            }
        }
        PendingConfirm::KeepAll => ConfirmCopy {
            title: "Keep everything on this device?".to_string(),
            body: "This downloads everything in My files to this computer and keeps it updated.".to_string(),
            detail: "Items you made online only are downloaded too; hidden items stay hidden. This can take a long time and use a lot of disk space.",
            button: "Keep everything",
            cancel: "Cancel",
            rel_path: String::new(),
            action: "pin",
        },
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
        PendingConfirm::DeleteMissing { root, items } => ConfirmCopy {
            title: "Delete them from Proton Drive too?".to_string(),
            body: format!(
                "The {items} items that were in {root} will move to the Proton Drive trash. You can restore them from the trash on the Proton Drive website."
            ),
            detail: "Keep waiting if they are on a disk that isn't connected, or you are bringing them back: nothing is deleted while Proton Drive waits.",
            button: "Delete from Proton Drive",
            cancel: "Keep waiting",
            rel_path: String::new(),
            // Not an availability action: render_confirm_modal sends the confirmation instead
            action: "files-missing-delete",
        },
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
    /// Only the settings that changed (see `settings_changes`)
    SaveSettings(serde_json::Value),
    /// The Settings switch `Show online-only files in Files (virtual drive)`
    SetVirtualDrive(bool),
    MountAgain,
    /// An action on a move that stopped, naming the move by where it goes
    DriveMove { action: String, from: String, to: String },
    LoadConflicts,
    ResolveConflict { id: u64, choice: String },
    SetAvailability { path: String, action: String },
    /// The files missing from the folder were deleted on purpose (POST /sync/files-missing)
    ConfirmFilesMissing,
}

/// Set once in `main` when the app only renders a screenshot: nothing that changes anything is ever sent then, and
/// the control socket is never called.
static SCREENSHOT_MODE: AtomicBool = AtomicBool::new(false);

/// What screenshot mode may ask the worker for: reads only.
fn allowed_in_screenshot_mode(cmd: &WorkerCommand) -> bool {
    matches!(cmd, WorkerCommand::RefreshAll | WorkerCommand::LoadRemotePath(_) | WorkerCommand::LoadConflicts)
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
    RemoteLoaded(Result<RemoteListResponse, String>),
    /// A cloud folder was made in the folder shown, or why not
    FolderMade(Result<(), String>),
    ConflictsLoaded(Vec<ConflictRecord>),
    ConflictResolved(Result<(), String>),
    AvailabilityDone { path: String, result: Result<AvailabilityResult, String> },
    SettingsSaved(Result<SettingsReply, String>),
    VirtualDriveSwitched(Result<SettingsReply, String>),
    /// Mount again or an action on a stopped move finished, or why not
    DriveDone(Result<(), String>),
    /// The confirmation that the missing files were deleted on purpose went through, or why not
    FilesMissingDone(Result<(), String>),
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
            width: 1280.0,
            height: 820.0,
            maximized: true,
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
    root_items: Vec<RemoteItem>,
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

fn save_startup_cache(status: &DaemonStatus, root_items: &[RemoteItem], activities: &[ActivityRecord]) {
    // A screenshot may show a faked drive or listing, which must never be what the app shows at its next start
    if !status.logged_in || SCREENSHOT_MODE.load(AtomicOrdering::SeqCst) {
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
    /// The sign-in page's URL once a sign-in started ('' while the browser is still opening it)
    login_url: Option<String>,
    /// Why signing in or out failed
    account_error: Option<String>,
    search_query: String,
    show_account_menu: bool,

    // Cloud Browser state
    remote_path: String,
    remote_items: Vec<RemoteItem>,
    remote_loading: bool,
    remote_error: Option<String>,
    new_folder_name: String,
    show_new_folder_modal: bool,
    row_menu: Option<RowMenu>,
    /// Paths (relative to the sync folder; empty is the whole drive) with an action still running.
    working: Vec<String>,
    pending_confirm: Option<PendingConfirm>,
    /// Dismissible line above the table: a refusal, the items that had to stay, or an error.
    notice: Option<String>,
    /// Screenshot-only: open the row menu of the item with this name once it is laid out.
    screenshot_menu_for: Option<String>,

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
    /// The confirmation that the missing files were deleted on purpose is still running, and why the last one failed
    files_missing_working: bool,
    files_missing_error: Option<String>,

    // Conflicts state
    conflicts: Vec<ConflictRecord>,
    /// Why the last conflict resolution was refused or failed
    conflict_error: Option<String>,

    // Settings edits
    edit_sync_dir: String,
    edit_conflict_strategy: String,
    edit_notifications: bool,

    /// Screenshot-only: `--drive-status` and `--drive-move`, laid over every status from the daemon
    fake_drive: Option<(String, Option<String>)>,
    /// Screenshot-only: `--files-missing`, the daemon holding with the files missing, laid over every status
    fake_files_missing: bool,

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
        let loaded_settings = initial_status.settings.clone();

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
            account_error: None,
            search_query: String::new(),
            show_account_menu: initial_account_menu,
            remote_path: start_path,
            // The startup cache only holds the root listing, so don't show it under another folder
            remote_items: if start_at_root { initial_root_items } else { Vec::new() },
            remote_loading: !start_at_root || !has_cached_items,
            remote_error: None,
            new_folder_name: String::new(),
            show_new_folder_modal: false,
            row_menu: None,
            working: Vec::new(),
            pending_confirm: None,
            notice: None,
            screenshot_menu_for: None,
            ignore_patterns_text,
            settings_dirty: false,
            loaded_settings,
            settings_saving: false,
            settings_notice: None,
            drive_working: false,
            drive_error: None,
            files_missing_working: false,
            files_missing_error: None,
            conflicts: Vec::new(),
            conflict_error: None,
            edit_sync_dir,
            edit_conflict_strategy,
            edit_notifications,
            fake_drive: None,
            fake_files_missing: false,
            window_geometry,
            maximize_applied_on_open: false,
            applied_light_mode: initial_light,
            screenshot_target,
            frames_rendered: 0,
            screenshot_requested: false,
            last_poll: Instant::now(),
        }
    }

    /// Screenshot-only: lays `--files-missing` over a status from the daemon.
    fn apply_fake_files_missing(&self, status: &mut DaemonStatus) {
        if !self.fake_files_missing {
            return;
        }
        let root = if status.sync_dir.is_empty() { "/home/u/ProtonDrive".to_string() } else { status.sync_dir.clone() };
        status.state = "error".into();
        status.last_error = Some(format!("Proton Drive's files are missing from {root}. Nothing was deleted in Proton Drive."));
        status.files_missing = Some(FilesMissing { root, names: vec!["Documents".into(), "Photos".into()], items: 1284 });
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

    /// Sign-in and sign-out problems show under Sync Activity's title and above My files, until the next try.
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
        self.ignore_patterns_text = settings.ignore_patterns.join("\n");
        self.loaded_settings = settings.clone();
    }

    fn process_worker_events(&mut self) {
        while let Ok(evt) = self.rx.try_recv() {
            match evt {
                WorkerEvent::StatusAndActivity { status, activity } => match *status {
                    Ok(mut s) => {
                        let was_offline = !self.daemon_online;
                        self.daemon_online = true;
                        self.initial_connecting = false;
                        self.apply_fake_drive(&mut s);
                        self.apply_fake_files_missing(&mut s);
                        // Edits being made or saved stay as they are; Save compares them with what they were loaded from
                        if !self.settings_dirty && !self.settings_saving {
                            self.load_settings_form(&s.settings);
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
                WorkerEvent::FolderMade(result) => {
                    if let Err(e) = result {
                        self.notice = Some(format!("Couldn't create the folder: {e}"));
                    }
                    let _ = self.tx.send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
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
                WorkerEvent::AvailabilityDone { path, result } => {
                    if let Some(i) = self.working.iter().position(|w| w == &path) {
                        self.working.remove(i);
                    }
                    self.notice = match result {
                        Ok(result) => availability_notice(&result),
                        Err(e) => Some(e),
                    };
                    // Pills and the status counters change with the action
                    let _ = self.tx.send(WorkerCommand::RefreshAll);
                    let _ = self.tx.send(WorkerCommand::LoadRemotePath(self.remote_path.clone()));
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
                    (STATUS_DANGER, sync_error_text(&self.status))
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
                                            self.send_account_command(WorkerCommand::Logout);
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
                                        self.send_account_command(WorkerCommand::StartLogin);
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
                        self.send_account_command(WorkerCommand::StartLogin);
                    }
                });
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

    /// My files toolbar, laid out right to left: Refresh, New folder, Free up all, Keep all and, when
    /// there's room, the item count.
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

        ui.add_space(6.0);

        let here = folder_rel_path(&self.remote_path);
        let folder_busy = self
            .working
            .iter()
            .any(|w| w.is_empty() || w == here || here.starts_with(&format!("{w}/")));
        let free_all = ui
            .add_enabled_ui(!folder_busy, |ui| {
                proton_button(
                    ui,
                    Vec2::new(TOOLBAR_FREE_ALL_W, 32.0),
                    "Free up all",
                    BG_CARD_ALT(),
                    btn_secondary_hover_bg(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    TEXT_PRIMARY(),
                    13.0,
                )
            })
            .inner
            .on_hover_text("Free up space for everything in this folder");
        if free_all.clicked() && !folder_busy {
            self.pending_confirm = Some(PendingConfirm::FreeAll {
                rel_path: folder_rel_path(&self.remote_path).to_string(),
            });
        }

        ui.add_space(6.0);

        let keep_all = ui
            .add_enabled_ui(!folder_busy, |ui| {
                proton_button(
                    ui,
                    Vec2::new(TOOLBAR_KEEP_ALL_W, 32.0),
                    "Keep all",
                    BG_CARD_ALT(),
                    btn_secondary_hover_bg(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    TEXT_PRIMARY(),
                    13.0,
                )
            })
            .inner
            .on_hover_text("Always keep everything in this folder on this device");
        if keep_all.clicked() && !folder_busy {
            if here.is_empty() {
                self.pending_confirm = Some(PendingConfirm::KeepAll); // The whole drive: ask first
            } else {
                self.send_availability(here.to_string(), "pin");
            }
        }

        if !self.remote_items.is_empty() {
            if let Some(count) = count {
                ui.add_space(10.0);
                ui.label(RichText::new(count).size(12.0).color(TEXT_MUTED()));
            }
        }
    }

    /// Asks the daemon, over the control socket and off the UI thread, to change availability.
    fn send_availability(&mut self, rel_path: String, action: &str) {
        self.row_menu = None;
        self.notice = None;
        self.working.push(rel_path.clone());
        let _ = self.tx.send(WorkerCommand::SetAvailability { path: rel_path, action: action.to_string() });
    }

    /// Dismissible warning line above the table.
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
                        RichText::new("↻ Working… this can take a while for large folders. The list updates when it's done.")
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

    /// The context menu for one row, closed by Escape, a click elsewhere or choosing an entry.
    fn render_row_menu(&mut self, ctx: &egui::Context) {
        let Some(menu) = self.row_menu.clone() else {
            return;
        };
        if ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.row_menu = None;
            return;
        }
        let actions = menu_actions(menu.availability, menu.rel_path.is_empty());
        let menu_w = 224.0;
        let menu_h = actions.len() as f32 * 30.0 + 12.0;
        let screen = ctx.screen_rect();
        let pos = egui::pos2(
            menu.pos.x.min(screen.right() - menu_w - 8.0).max(screen.left() + 8.0),
            menu.pos.y.min(screen.bottom() - menu_h - 8.0).max(screen.top() + 8.0),
        );
        let mut chosen: Option<&'static str> = None;
        // Above the window's contents and below the menu, so a click outside the menu only closes it
        click_shield(ctx, "row_menu_shield", egui::Order::Middle, None);
        let area = egui::Area::new(egui::Id::new("row_menu"))
            .order(egui::Order::Foreground)
            .fixed_pos(pos)
            .show(ctx, |ui| {
                Frame::NONE
                    .fill(BG_CARD())
                    .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
                    .corner_radius(CornerRadius::same(10))
                    .shadow(egui::Shadow {
                        offset: [0, 6],
                        blur: 18,
                        spread: 0,
                        color: Color32::from_rgba_unmultiplied(0, 0, 0, 120),
                    })
                    .inner_margin(Margin::same(6))
                    .show(ui, |ui| {
                        ui.set_min_width(menu_w - 12.0);
                        ui.set_max_width(menu_w - 12.0);
                        ui.spacing_mut().item_spacing.y = 2.0;
                        for (label, action) in &actions {
                            let entry = egui::Button::new(RichText::new(*label).size(13.0).color(TEXT_PRIMARY()))
                                .fill(Color32::TRANSPARENT)
                                .stroke(Stroke::NONE)
                                .corner_radius(CornerRadius::same(6))
                                .min_size(Vec2::new(menu_w - 12.0, 28.0));
                            if ui.add(entry).clicked() {
                                chosen = Some(action);
                            }
                        }
                    });
            });

        if let Some(action) = chosen {
            match action {
                "hide" => {
                    self.pending_confirm =
                        Some(PendingConfirm::Hide { name: menu.name, rel_path: menu.rel_path });
                    self.row_menu = None;
                }
                _ => self.send_availability(menu.rel_path, action),
            }
        } else if ctx.input(|i| i.pointer.any_pressed()) {
            if let Some(p) = ctx.input(|i| i.pointer.interact_pos()) {
                if !area.response.rect.contains(p) {
                    self.row_menu = None;
                }
            }
        }
    }

    /// Confirmation for Hide (one item), Free up all (the current folder) and Keep all at the root.
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

        let ConfirmCopy { title, body, detail, button, cancel, rel_path: action_path, action } = confirm_copy(&confirm);

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
                            if proton_button(
                                ui,
                                Vec2::new(if button.len() > 16 { 186.0 } else { 138.0 }, 36.0),
                                button,
                                PROTON_PURPLE,
                                PROTON_PURPLE_HOVER,
                                None,
                                Color32::WHITE,
                                13.0,
                            )
                            .clicked()
                            {
                                if confirm == PendingConfirm::VirtualDriveOff {
                                    self.send_drive_command(WorkerCommand::SetVirtualDrive(false));
                                } else if matches!(confirm, PendingConfirm::DeleteMissing { .. }) {
                                    self.files_missing_working = true;
                                    self.files_missing_error = None;
                                    let _ = self.tx.send(WorkerCommand::ConfirmFilesMissing);
                                } else {
                                    self.send_availability(action_path.clone(), action);
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

    /// Above every tab while the daemon holds because the files are missing from the folder: what is missing, that
    /// nothing was deleted, and, behind a confirmation, deleting them from Proton Drive too. Keeping waiting is the
    /// default: it needs nothing.
    fn render_files_missing(&mut self, ui: &mut egui::Ui) {
        let Some(fm) = self.status.files_missing.clone() else {
            return;
        };
        Frame::NONE
            .fill(Color32::from_rgba_unmultiplied(239, 68, 68, 26))
            .stroke(Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(239, 68, 68, 110)))
            .corner_radius(CornerRadius::same(10))
            .inner_margin(Margin::symmetric(16, 12))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                let title = format!("Proton Drive's files are missing from {}. Nothing was deleted in Proton Drive.", fm.root);
                ui.add(egui::Label::new(RichText::new(title).size(13.5).strong().color(TEXT_PRIMARY())).wrap());
                ui.add_space(2.0);
                let detail = format!(
                    "{} missing. Proton Drive waits for them to come back and syncs nothing meanwhile.",
                    missing_names(&fm)
                );
                ui.add(egui::Label::new(RichText::new(detail).size(12.5).color(TEXT_MUTED())).wrap());
                if let Some(error) = &self.files_missing_error {
                    ui.add_space(2.0);
                    ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
                }
                ui.add_space(8.0);
                let working = self.files_missing_working;
                let clicked = proton_button(
                    ui,
                    Vec2::new(250.0, 32.0),
                    "Delete them from Proton Drive too",
                    BG_CARD_ALT(),
                    btn_secondary_hover_bg(),
                    Some(Stroke::new(1.0_f32, BORDER_SUBTLE())),
                    if working { TEXT_MUTED() } else { STATUS_DANGER },
                    12.5,
                )
                .on_hover_text("Asks first. While they are missing, nothing is deleted in Proton Drive.")
                .clicked();
                if clicked && !working {
                    self.pending_confirm = Some(PendingConfirm::DeleteMissing { root: fm.root.clone(), items: fm.items });
                }
            });
        ui.add_space(14.0);
    }

    /// One frame of the window's contents: sidebar, header, the current tab and anything floating over them.
    fn render_ui(&mut self, ctx: &egui::Context) {
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
                if self.pending_confirm.is_some() {
                    ui.disable(); // Nothing under the confirmation dialog takes clicks or keys while it is open
                }
                self.render_files_missing(ui);
                match self.tab {
                    NavTab::Overview => self.render_overview_tab(ui),
                    NavTab::CloudBrowser => self.render_browser_tab(ui),
                    NavTab::Conflicts => self.render_conflicts_tab(ui),
                    NavTab::Settings => self.render_settings_tab(ui),
                }
            });

        self.render_account_popover(ctx);
        self.render_row_menu(ctx);
        self.render_confirm_modal(ctx);
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
            let buttons_w = TOOLBAR_REFRESH_W
                + TOOLBAR_NEW_FOLDER_W
                + TOOLBAR_FREE_ALL_W
                + TOOLBAR_KEEP_ALL_W
                + 3.0 * 6.0
                + gap * 4.0;
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

            self.render_notice(ui);

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
                            let opens_file = !is_folder && file_opens_on_click(availability, self.status.vfs.as_ref());
                            let item_rel = item_rel_path(&self.remote_path, &item.name);

                            let (row_rect, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 42.0),
                                Sense::click(),
                            );

                            if row_resp.hovered() {
                                if (is_folder && !is_hidden) || opens_file {
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
                            let is_working = self
                                .working
                                .iter()
                                .any(|w| *w == item_rel || w.is_empty() || item_rel.starts_with(&format!("{w}/")));
                            let is_syncing = is_working || self.status.syncing_folders.iter().any(|f| f == &item_rel)
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
                                    if is_working { "↻ Working…" } else { "↻ Syncing..." },
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

                            // The pill and a right-click anywhere on the row open the same menu
                            let pill_resp = ui.interact(
                                pill_rect,
                                ui.id().with(("availability_pill", &item.name)),
                                Sense::click(),
                            );
                            if pill_resp.hovered() {
                                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                            }
                            let menu_pos = if pill_resp.clicked() {
                                Some(pill_rect.left_bottom() + Vec2::new(0.0, 4.0))
                            } else if row_resp.secondary_clicked() {
                                row_resp.interact_pointer_pos()
                            } else if self.screenshot_menu_for.as_deref() == Some(item.name.as_str()) {
                                self.screenshot_menu_for = None;
                                Some(pill_rect.left_bottom() + Vec2::new(0.0, 4.0))
                            } else {
                                None
                            };
                            if let Some(pos) = menu_pos {
                                self.row_menu = Some(RowMenu {
                                    name: item.name.clone(),
                                    rel_path: item_rel.clone(),
                                    availability,
                                    pos,
                                });
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
                            } else if opens_file && row_resp.clicked() {
                                // On the mounted virtual drive, opening an online-only file downloads it
                                let local_target = format!("{}/{}", self.status.sync_dir, item_rel);
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
            if let Some(error) = &self.conflict_error {
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
                ui.add_space(8.0);
            }
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
        ScrollArea::vertical()
            .id_salt("settings_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                // A gutter for the scroll bar, so that it never draws over the cards' edges
                Frame::NONE.inner_margin(Margin { left: 0, right: 12, top: 0, bottom: 0 }).show(ui, |ui| {
                    // A daemon before Stage 2 has no virtual drive to show
                    if let Some(vfs) = self.status.vfs.clone() {
                        self.render_drive_card(ui, &vfs);
                        ui.add_space(14.0);
                    }
                    self.render_sync_settings_card(ui);
                });
            });
    }

    /// The virtual drive: its state, Mount again, a move that stopped, and the switch.
    fn render_drive_card(&mut self, ui: &mut egui::Ui, vfs: &VfsStatus) {
        let moving = vfs.reason.as_deref() == Some("moving");
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("Virtual Drive").size(16.0).strong().color(TEXT_PRIMARY()));
            ui.add_space(12.0);

            ui.horizontal(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if offers_mount_again(vfs) {
                        let clicked = ui
                            .add_enabled_ui(!self.drive_working, |ui| {
                                proton_button(
                                    ui,
                                    Vec2::new(button_width(ui, "Mount again"), 32.0),
                                    "Mount again",
                                    PROTON_PURPLE,
                                    PROTON_PURPLE_HOVER,
                                    None,
                                    Color32::WHITE,
                                    13.0,
                                )
                                .clicked()
                            })
                            .inner;
                        if clicked {
                            self.send_drive_command(WorkerCommand::MountAgain);
                        }
                        ui.add_space(8.0);
                    }
                    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                        ui.add_space(DRIVE_DOT_INDENT);
                        let line = ui.add(
                            egui::Label::new(
                                RichText::new(drive_status_line(vfs, &self.status.sync_dir))
                                    .size(14.0)
                                    .strong()
                                    .color(TEXT_PRIMARY()),
                            )
                            .wrap(),
                        );
                        // Level with the first line when a long one wraps
                        let first_line_h = ui.fonts(|f| f.row_height(&FontId::proportional(14.0)));
                        let dot = egui::pos2(line.rect.left() - DRIVE_DOT_INDENT + 5.0, line.rect.top() + first_line_h / 2.0);
                        ui.painter().circle_filled(dot, 4.5, drive_state_color(vfs));
                    });
                });
            });
            if let Some(hint) = files_safe_hint(vfs) {
                ui.add_space(4.0);
                ui.add(egui::Label::new(RichText::new(hint).size(12.5).color(TEXT_MUTED())).wrap());
            }
            if let Some(mv) = &vfs.drive_move {
                ui.add_space(12.0);
                self.render_stopped_move(ui, vfs, mv);
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

            ui.add_space(14.0);
            ui.separator();
            ui.add_space(12.0);

            // On is what the user chose (the daemon's virtualDriveWanted); without FUSE the drive is a plain folder anyway
            let on = self.status.virtual_drive_wanted.unwrap_or(vfs.mode == "virtual");
            let clicked = ui
                .add_enabled_ui(!self.drive_working && !moving, |ui| {
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
                                let primary = action != "move-back";
                                let (fill, hover, stroke, text) = if primary {
                                    (PROTON_PURPLE, PROTON_PURPLE_HOVER, None, Color32::WHITE)
                                } else {
                                    (BG_CARD(), btn_secondary_hover_bg(), Some(Stroke::new(1.0_f32, BORDER_SUBTLE())), TEXT_PRIMARY())
                                };
                                let size = Vec2::new(button_width(ui, label), 32.0);
                                if proton_button(ui, size, label, fill, hover, stroke, text, 13.0).clicked() {
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

        self.render_ui(ctx);

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

/// Room left of the drive's status line for its dot.
const DRIVE_DOT_INDENT: f32 = 18.0;

/// A button just wide enough for its label at 13 pt.
fn button_width(ui: &egui::Ui, label: &str) -> f32 {
    text_width(ui.painter(), label, &FontId::proportional(13.0)) + 32.0
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

/// The dot before the drive's status line: green when mounted, red when it needs the user, grey otherwise.
fn drive_state_color(v: &VfsStatus) -> Color32 {
    if v.mounted {
        return STATUS_SUCCESS;
    }
    match v.reason.as_deref() {
        Some("crashed" | "mount-point-busy" | "move-failed") => STATUS_DANGER,
        Some("ejected" | "different-disk" | "fuse-unavailable") => STATUS_WARNING,
        Some("starting" | "moving") => PROTON_PURPLE_HOVER,
        _ => TEXT_MUTED(),
    }
}

const BREADCRUMB_FONT_SIZE: f32 = 13.5;
const BREADCRUMB_SEPARATOR_SIZE: f32 = 15.0;
const BREADCRUMB_PAD_X: f32 = 12.0;
const TOOLBAR_REFRESH_W: f32 = 84.0;
const TOOLBAR_NEW_FOLDER_W: f32 = 108.0;
const TOOLBAR_KEEP_ALL_W: f32 = 84.0;
const TOOLBAR_FREE_ALL_W: f32 = 100.0;
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
            WorkerCommand::SetPaused(paused) => {
                let _ = ureq::post(&format!("{}/api/pause", daemon_url()))
                    .send_json(serde_json::json!({ "paused": paused }));
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
            WorkerCommand::LoadRemotePath(_) if REMOTE_FIXTURE.get().is_some() => {
                let res = load_remote_fixture(REMOTE_FIXTURE.get().map_or("", String::as_str));
                let _ = tx.send(WorkerEvent::RemoteLoaded(res));
                ctx.request_repaint();
            }
            WorkerCommand::LoadRemotePath(path) => {
                let tx_clone = tx.clone();
                let ctx_clone = ctx.clone();
                thread::spawn(move || {
                    let url = format!("{}/api/remote/list?path={path}", daemon_url());
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
            WorkerCommand::CreateRemoteFolder { parent_path, name } => off_thread(&tx, &ctx, move || {
                WorkerEvent::FolderMade(make_folder_at(&control_socket_path(), &parent_path, &name))
            }),
            WorkerCommand::SaveSettings(changes) => off_thread(&tx, &ctx, move || {
                WorkerEvent::SettingsSaved(save_settings_at(&control_socket_path(), &changes))
            }),
            WorkerCommand::SetVirtualDrive(on) => off_thread(&tx, &ctx, move || {
                let change = serde_json::json!({ "virtualDriveWanted": on });
                WorkerEvent::VirtualDriveSwitched(save_settings_at(&control_socket_path(), &change))
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
            WorkerCommand::ConfirmFilesMissing => off_thread(&tx, &ctx, || {
                WorkerEvent::FilesMissingDone(files_missing_delete_at(&control_socket_path()))
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
    ureq::get(&format!("{}/api/activity?limit=40", daemon_url()))
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
  --row-menu <NAME>     with --screenshot: open the actions menu of the item NAME
  --confirm-hide <NAME> with --screenshot: show the Hide confirmation for the item NAME
  --working <NAME>      with --screenshot: show the item NAME (or . for this folder) as still working
  --confirm-free-all    with --screenshot: show the Free up all confirmation
  --confirm-keep-all    with --screenshot: show the Keep all confirmation (for the whole drive)
  --drive-status <S>    with --screenshot: show the virtual drive as S (mounted | ejected | plain | crashed | busy |
                        starting | moving | move-failed | different-disk | fuse-unavailable)
  --drive-move <KIND>   with --screenshot: add a move that stopped (relocation | layout)
  --drive-error <TEXT>  with --screenshot: show TEXT as the refusal of a drive request
  --confirm-drive-off   with --screenshot: show the confirmation for switching the virtual drive off
  --files-missing       with --screenshot: show the daemon holding with the files missing from the folder
  --confirm-files-missing  with --screenshot: also show the confirmation for deleting them from Proton Drive too
  --login-error <TEXT>  with --screenshot: show TEXT as a failed sign-in
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
    let mut cli_row_menu: Option<String> = None;
    let mut cli_confirm_hide: Option<String> = None;
    let mut cli_confirm_free_all = false;
    let mut cli_confirm_keep_all = false;
    let mut cli_working: Option<String> = None;
    let mut cli_drive_status: Option<String> = None;
    let mut cli_drive_move: Option<String> = None;
    let mut cli_drive_error: Option<String> = None;
    let mut cli_confirm_drive_off = false;
    let mut cli_files_missing = false;
    let mut cli_confirm_files_missing = false;
    let mut cli_login_error: Option<String> = None;
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
            "--row-menu" => {
                cli_row_menu = args.next();
            }
            "--confirm-hide" => {
                cli_confirm_hide = args.next();
            }
            "--working" => {
                cli_working = args.next();
            }
            "--confirm-free-all" => {
                cli_confirm_free_all = true;
            }
            "--confirm-keep-all" => {
                cli_confirm_keep_all = true;
            }
            "--drive-status" => {
                cli_drive_status = args.next();
            }
            "--drive-move" => {
                cli_drive_move = args.next();
            }
            "--drive-error" => {
                cli_drive_error = args.next();
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
            "--login-error" => {
                cli_login_error = args.next();
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

    // Before any thread starts: a screenshot only reads (see allowed_in_screenshot_mode and control_request_at)
    SCREENSHOT_MODE.store(screenshot_target.is_some(), AtomicOrdering::SeqCst);

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
            // Screenshot-only: these flags only draw the menu and dialogs, nothing is sent
            if app.screenshot_target.is_some() {
                app.screenshot_menu_for = cli_row_menu;
                if let Some(name) = cli_working {
                    let rel_path = if name == "." {
                        folder_rel_path(&app.remote_path).to_string()
                    } else {
                        item_rel_path(&app.remote_path, &name)
                    };
                    app.working.push(rel_path);
                }
                if let Some(name) = cli_confirm_hide {
                    let rel_path = item_rel_path(&app.remote_path, &name);
                    app.pending_confirm = Some(PendingConfirm::Hide { name, rel_path });
                } else if cli_confirm_free_all {
                    let rel_path = folder_rel_path(&app.remote_path).to_string();
                    app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path });
                } else if cli_confirm_keep_all {
                    app.pending_confirm = Some(PendingConfirm::KeepAll);
                } else if cli_confirm_drive_off {
                    app.pending_confirm = Some(PendingConfirm::VirtualDriveOff);
                }
                app.fake_drive = fake_drive;
                app.fake_files_missing = cli_files_missing;
                let mut status = std::mem::take(&mut app.status);
                app.apply_fake_drive(&mut status);
                app.apply_fake_files_missing(&mut status);
                app.status = status;
                if cli_confirm_files_missing {
                    if let Some(fm) = &app.status.files_missing {
                        app.pending_confirm = Some(PendingConfirm::DeleteMissing { root: fm.root.clone(), items: fm.items });
                    }
                }
                app.drive_error = cli_drive_error;
                if let Some(error) = cli_login_error {
                    app.show_account_error(format!("Couldn't start signing in: {error}"));
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

    #[test]
    fn menu_actions_follow_the_state() {
        use Availability::*;
        let keep = ("Always keep on this device", "pin");
        let free = ("Free up space", "free");
        let hide = ("Hide from this computer", "hide");
        let unhide = ("Unhide", "unhide");
        assert_eq!(menu_actions(Pinned, false), vec![free, hide]);
        assert_eq!(menu_actions(Downloaded, false), vec![keep, free, hide]);
        assert_eq!(menu_actions(OnlineOnly, false), vec![keep, hide]);
        // Unhide first, then keep (ruling R18)
        assert_eq!(menu_actions(Hidden, false), vec![unhide]);
        assert_eq!(menu_actions(Hiding, false), vec![unhide]);
    }

    #[test]
    fn menu_actions_never_offer_hide_on_the_root() {
        use Availability::*;
        for a in [Pinned, Downloaded, OnlineOnly, Hidden, Hiding] {
            assert!(menu_actions(a, true).iter().all(|(_, action)| *action != "hide"), "{a:?}");
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
    fn item_rel_path_strips_my_files_and_joins_the_name() {
        assert_eq!(item_rel_path("/my-files", "a.txt"), "a.txt");
        assert_eq!(item_rel_path("/my-files/", "a.txt"), "a.txt");
        assert_eq!(item_rel_path("/my-files/Projects/2026", "a b.txt"), "Projects/2026/a b.txt");
        assert_eq!(item_rel_path("/", "x"), "x");
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
    }

    impl Harness {
        fn new(remote_path: &str) -> Self {
            let (tx, commands) = mpsc::channel();
            let (events, rx) = mpsc::channel();
            let items: Vec<RemoteItem> = serde_json::from_str(
                r#"[
                    {"uid": "1", "name": "Projects", "type": "folder", "size": 0, "modificationTime": "2026-10-20T10:00:00Z", "availability": "downloaded"},
                    {"uid": "2", "name": "Photos", "type": "folder", "size": 0, "modificationTime": "2026-10-19T10:00:00Z", "availability": "online-only"},
                    {"uid": "3", "name": "Archive", "type": "folder", "size": 0, "modificationTime": "2026-10-18T10:00:00Z", "availability": "pinned"},
                    {"uid": "4", "name": "photo.jpg", "type": "file", "size": 42, "modificationTime": "2026-10-17T10:00:00Z", "availability": "online-only"}
                ]"#,
            )
            .unwrap();
            let status = DaemonStatus { state: "idle".into(), logged_in: true, ..Default::default() };
            let app = ProtonDriveNativeApp {
                tab: NavTab::CloudBrowser,
                tx,
                rx,
                logo_texture: None,
                daemon_online: true,
                initial_connecting: false,
                status,
                activities: Vec::new(),
                cached_root_items: Vec::new(),
                login_url: None,
                account_error: None,
                search_query: String::new(),
                show_account_menu: false,
                remote_path: remote_path.to_string(),
                remote_items: items,
                remote_loading: false,
                remote_error: None,
                new_folder_name: String::new(),
                show_new_folder_modal: false,
                row_menu: None,
                working: Vec::new(),
                pending_confirm: None,
                notice: None,
                screenshot_menu_for: None,
                ignore_patterns_text: String::new(),
                settings_dirty: false,
                loaded_settings: SyncSettings { conflict_strategy: "keep-both".into(), ..Default::default() },
                settings_saving: false,
                settings_notice: None,
                drive_working: false,
                drive_error: None,
                files_missing_working: false,
                files_missing_error: None,
                conflicts: Vec::new(),
                conflict_error: None,
                edit_sync_dir: String::new(),
                edit_conflict_strategy: "keep-both".into(),
                edit_notifications: false,
                fake_drive: None,
                fake_files_missing: false,
                window_geometry: WindowGeometry::default(),
                maximize_applied_on_open: true,
                applied_light_mode: false,
                screenshot_target: None,
                frames_rendered: 0,
                screenshot_requested: false,
                last_poll: Instant::now(),
            };
            let ctx = egui::Context::default();
            configure_proton_theme(&ctx);
            apply_proton_visuals(&ctx, false);
            let mut h = Self { ctx, app, commands, events, last: None };
            h.frames(3);
            h
        }

        /// The Settings tab, with the drive as given and the settings form as loaded from `loaded_settings()`.
        fn settings(vfs: Option<VfsStatus>, wanted: Option<bool>) -> Self {
            let mut h = Self::new("/my-files");
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
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, Vec2::new(1440.0, 900.0))),
                events,
                ..Default::default()
            };
            let app = &mut self.app;
            self.last = Some(self.ctx.run(input, |ctx| app.render_ui(ctx)));
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

        /// Where the last frame painted exactly this text.
        fn text_at(&self, text: &str) -> Option<egui::Pos2> {
            fn find(shape: &egui::Shape, text: &str) -> Option<egui::Pos2> {
                match shape {
                    egui::Shape::Text(t) if t.galley.text() == text => Some(t.visual_bounding_rect().center()),
                    egui::Shape::Vec(shapes) => shapes.iter().find_map(|s| find(s, text)),
                    _ => None,
                }
            }
            self.last.as_ref()?.shapes.iter().find_map(|c| find(&c.shape, text))
        }

        /// Availability actions and folder changes asked of the worker since the last call.
        fn sent(&self) -> Vec<String> {
            self.commands
                .try_iter()
                .filter_map(|c| match c {
                    WorkerCommand::SetAvailability { path, action } => Some(format!("{action} {path:?}")),
                    WorkerCommand::LoadRemotePath(path) => Some(format!("open {path}")),
                    WorkerCommand::SaveSettings(changes) => Some(format!("save {changes}")),
                    WorkerCommand::SetVirtualDrive(on) => Some(format!("virtual drive {on}")),
                    WorkerCommand::MountAgain => Some("mount again".to_string()),
                    WorkerCommand::DriveMove { action, from, to } => Some(format!("{action} {from} -> {to}")),
                    WorkerCommand::ConfirmFilesMissing => Some("files missing: delete in cloud".to_string()),
                    _ => None,
                })
                .collect()
        }
    }

    /// Clicks Keep all with nothing open, to prove `pos` is where it reacts, then forgets what that did.
    fn keep_all_reacts_at(h: &mut Harness, pos: egui::Pos2) {
        h.sent();
        h.click(pos);
        let reacted = !h.sent().is_empty() || h.app.pending_confirm.is_some();
        assert!(reacted, "Keep all did not react to a click at {pos:?}");
        h.app.pending_confirm = None;
        h.app.working.clear();
        h.frames(2);
    }

    #[test]
    fn clicking_outside_a_confirm_dialog_closes_it_and_clicks_nothing_under_it() {
        let mut h = Harness::new("/my-files");
        let keep_all = h.text_at("Keep all").expect("Keep all is painted");
        keep_all_reacts_at(&mut h, keep_all);

        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        h.frames(2);
        h.click(keep_all);

        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.app.working.is_empty());
    }

    #[test]
    fn clicking_outside_the_row_menu_closes_it_and_clicks_nothing_under_it() {
        let mut h = Harness::new("/my-files");
        let keep_all = h.text_at("Keep all").expect("Keep all is painted");
        keep_all_reacts_at(&mut h, keep_all);
        let open_menu = |h: &mut Harness| {
            h.app.row_menu = Some(RowMenu {
                name: "photo.jpg".into(),
                rel_path: "photo.jpg".into(),
                availability: Availability::OnlineOnly,
                pos: egui::pos2(1000.0, 700.0),
            });
            h.frames(2);
        };

        open_menu(&mut h);
        h.click(keep_all);
        assert!(h.app.row_menu.is_none());
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        // Nor does a click on another row open that folder
        open_menu(&mut h);
        let projects = h.text_at("Projects").expect("the Projects row is painted");
        h.click(projects);
        assert!(h.app.row_menu.is_none());
        assert_eq!(h.sent(), Vec::<String>::new());
        assert_eq!(h.app.remote_path, "/my-files");
    }

    #[test]
    fn a_click_in_the_frame_a_confirm_dialog_appears_clicks_nothing_under_it() {
        let mut h = Harness::new("/my-files");
        let keep_all = h.text_at("Keep all").expect("Keep all is painted");
        keep_all_reacts_at(&mut h, keep_all);

        // No frame has drawn the backdrop yet when the click arrives
        h.app.pending_confirm = Some(PendingConfirm::FreeAll { rel_path: String::new() });
        let button = |pressed| egui::Event::PointerButton {
            pos: keep_all,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        };
        h.frame(vec![button(true), button(false)]);
        h.frames(2);

        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());
    }

    #[test]
    fn menu_entries_and_dialog_buttons_still_take_clicks() {
        let mut h = Harness::new("/my-files");
        h.app.row_menu = Some(RowMenu {
            name: "photo.jpg".into(),
            rel_path: "photo.jpg".into(),
            availability: Availability::OnlineOnly,
            pos: egui::pos2(1000.0, 700.0),
        });
        h.frames(2);
        h.click(h.text_at("Always keep on this device").expect("the menu is painted"));
        assert_eq!(h.sent(), vec![r#"pin "photo.jpg""#.to_string()]);
        assert!(h.app.row_menu.is_none());

        h.app.working.clear();
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
    }

    #[test]
    fn keep_all_at_the_root_asks_first_and_in_a_subfolder_does_not() {
        // The whole drive: confirmed first (ruling R19)
        let mut h = Harness::new("/my-files");
        h.click(h.text_at("Keep all").expect("Keep all is painted"));
        assert!(h.app.pending_confirm.is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Keep everything").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec![r#"pin """#.to_string()]);

        let mut h = Harness::new("/my-files");
        h.click(h.text_at("Keep all").expect("Keep all is painted"));
        h.click(h.text_at("Cancel").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        // A folder inside: at once, as before
        let mut h = Harness::new("/my-files/Projects");
        h.click(h.text_at("Keep all").expect("Keep all is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec![r#"pin "Projects""#.to_string()]);
    }

    #[test]
    fn keep_all_confirmation_says_it_downloads_everything() {
        let copy = confirm_copy(&PendingConfirm::KeepAll);
        assert_eq!(copy.title, "Keep everything on this device?");
        assert_eq!(copy.body, "This downloads everything in My files to this computer and keeps it updated.");
        assert_eq!((copy.button, copy.action, copy.rel_path.as_str()), ("Keep everything", "pin", ""));
        // The other dialogs keep their wording
        let hide = confirm_copy(&PendingConfirm::Hide { name: "a".into(), rel_path: "x/a".into() });
        assert_eq!((hide.title.as_str(), hide.action, hide.rel_path.as_str()), ("Hide \"a\" from this computer?", "hide", "x/a"));
        let free = confirm_copy(&PendingConfirm::FreeAll { rel_path: String::new() });
        assert_eq!((free.title.as_str(), free.action, free.rel_path.as_str()), ("Free up space in My files?", "free", ""));
    }

    #[test]
    fn toolbar_buttons_are_wide_enough_for_their_labels() {
        with_painter(|p| {
            for (label, w) in [
                ("Refresh", TOOLBAR_REFRESH_W),
                ("+ New folder", TOOLBAR_NEW_FOLDER_W),
                ("Keep all", TOOLBAR_KEEP_ALL_W),
                ("Free up all", TOOLBAR_FREE_ALL_W),
            ] {
                let text_w = text_width(p, label, &FontId::proportional(13.0));
                assert!(text_w + 20.0 <= w, "{label}: {text_w} in {w}");
            }
        });
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

    // #45: the engine holds with its files missing from the folder, and the status pill says why (full text on hover)
    #[test]
    fn a_sync_error_shows_the_daemons_reason() {
        let missing = "Proton Drive's files are missing from /home/u/ProtonDrive. Nothing was deleted in Proton Drive.";
        let status: DaemonStatus = serde_json::from_str(&format!(
            r#"{{"state":"error","currentAction":null,"loggedIn":true,"syncDir":"/home/u/ProtonDrive","activeTransfers":[],
                "lastError":"{missing}",
                "stats":{{"totalFiles":1,"totalFolders":0,"totalBytes":3,"unresolvedConflicts":0,"errorItems":0}},
                "settings":{{"syncDir":"/home/u/ProtonDrive","conflictStrategy":"keep-both","notificationsEnabled":true,
                            "reconcileIntervalSec":120,"paused":false,"ignorePatterns":[".git"]}}}}"#
        ))
        .unwrap();
        assert_eq!(sync_error_text(&status), missing);
        let unexplained = DaemonStatus { state: "error".into(), ..Default::default() };
        assert_eq!(sync_error_text(&unexplained), "Sync Error");
        let blank = DaemonStatus { state: "error".into(), last_error: Some("  ".into()), ..Default::default() };
        assert_eq!(sync_error_text(&blank), "Sync Error");
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
            ignore_patterns: vec![".git".into(), "*.part".into()],
        }
    }

    #[test]
    fn settings_save_sends_only_the_fields_that_changed() {
        let loaded = loaded_settings();
        let changes = |dir: &str, strategy: &str, notify: bool, ignore: &str| {
            serde_json::Value::Object(settings_changes(&loaded, dir, strategy, notify, ignore))
        };
        let same = ".git\n*.part";
        assert_eq!(changes("/home/u/ProtonDrive", "keep-both", true, same), serde_json::json!({}));
        assert_eq!(
            changes("/home/u/ProtonDrive", "keep-local", true, same),
            serde_json::json!({ "conflictStrategy": "keep-local" })
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
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"settings\":{\"syncDir\":\"/home/u/ProtonDrive\",\"conflictStrategy\":\"keep-local\",\"notificationsEnabled\":true,\"reconcileIntervalSec\":120,\"paused\":false,\"ignorePatterns\":[]},\"virtualDriveWanted\":true,\"vfs\":{\"mode\":\"virtual\",\"mounted\":true,\"reason\":null},\"folderError\":null,\"switchError\":null}";
        let (sock, server) = serve_once(reply);
        let body = serde_json::json!({ "conflictStrategy": "keep-local" });
        let got = save_settings_at(&sock, &body).unwrap();
        assert_eq!(got.problem(), None);
        assert_eq!(got.settings.unwrap().conflict_strategy, "keep-local");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /drive/settings HTTP/1.1\r\n"), "{request}");
        assert_eq!(request_body(&request), serde_json::json!({ "conflictStrategy": "keep-local" }));

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
    fn conflicts_are_resolved_and_folders_made_over_the_control_socket() {
        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"conflict\":{}}");
        resolve_conflict_at(&sock, 7, "keep-local").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /conflicts/resolve HTTP/1.1\r\n"), "{request}");
        assert_eq!(request_body(&request), serde_json::json!({ "id": 7, "choice": "keep-local" }));

        let (sock, server) = serve_once(b"HTTP/1.1 409 Conflict\r\n\r\n{\"error\":\"That conflict is resolved already\",\"code\":\"EEXIST\"}");
        assert_eq!(resolve_conflict_at(&sock, 7, "keep-both").unwrap_err(), "That conflict is resolved already");
        server.join().unwrap();

        let (sock, server) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"folder\":{\"uid\":\"u\",\"name\":\"New\"}}");
        make_folder_at(&sock, "/my-files/Projects", "New").unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /remote/mkdir HTTP/1.1\r\n"), "{request}");
        assert_eq!(request_body(&request), serde_json::json!({ "parentPath": "/my-files/Projects", "name": "New" }));

        let (sock, server) = serve_once(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"name must be the name of a folder\",\"code\":\"EINVAL\"}");
        assert_eq!(make_folder_at(&sock, "/my-files", "..").unwrap_err(), "name must be the name of a folder");
        server.join().unwrap();
    }

    #[test]
    fn writes_that_can_move_files_wait_long_and_sign_in_waits_for_the_browser() {
        assert_eq!(DRIVE_READ_TIMEOUT, Duration::from_secs(600));
        assert_eq!(RESOLVE_READ_TIMEOUT, Duration::from_secs(600));
        assert!(LOGIN_READ_TIMEOUT >= Duration::from_secs(10), "the daemon waits up to 3 s for the sign-in page");
        assert!(LOGOUT_READ_TIMEOUT >= Duration::from_secs(30));
        assert!(MKDIR_READ_TIMEOUT >= Duration::from_secs(30));
    }

    #[test]
    fn an_online_only_file_opens_through_the_mounted_drive_only() {
        let mounted = vfs("virtual", true, None);
        let ejected = vfs("virtual", false, Some("ejected"));
        let plain = vfs("plain", false, Some("switched-off"));
        for v in [None, Some(&mounted), Some(&ejected), Some(&plain)] {
            assert!(file_opens_on_click(Availability::Pinned, v));
            assert!(file_opens_on_click(Availability::Downloaded, v));
            assert!(!file_opens_on_click(Availability::Hidden, v));
            assert!(!file_opens_on_click(Availability::Hiding, v));
        }
        assert!(file_opens_on_click(Availability::OnlineOnly, Some(&mounted)));
        for v in [None, Some(&ejected), Some(&plain)] {
            assert!(!file_opens_on_click(Availability::OnlineOnly, v), "{v:?}");
        }
    }

    #[test]
    fn screenshot_mode_only_reads() {
        let reads = [WorkerCommand::RefreshAll, WorkerCommand::LoadRemotePath("/my-files".into()), WorkerCommand::LoadConflicts];
        for cmd in &reads {
            assert!(allowed_in_screenshot_mode(cmd));
        }
        let writes = [
            WorkerCommand::TriggerSync,
            WorkerCommand::SetPaused(true),
            WorkerCommand::StartLogin,
            WorkerCommand::Logout,
            WorkerCommand::CreateRemoteFolder { parent_path: "/my-files".into(), name: "x".into() },
            WorkerCommand::SaveSettings(serde_json::json!({})),
            WorkerCommand::SetVirtualDrive(false),
            WorkerCommand::MountAgain,
            WorkerCommand::DriveMove { action: "finish".into(), from: "a".into(), to: "b".into() },
            WorkerCommand::ResolveConflict { id: 1, choice: "keep-both".into() },
            WorkerCommand::SetAvailability { path: "x".into(), action: "pin".into() },
            WorkerCommand::ConfirmFilesMissing,
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

    fn held(h: &mut Harness) {
        h.app.status.state = "error".into();
        h.app.status.last_error = Some(MISSING.into());
        h.app.status.files_missing =
            Some(FilesMissing { root: "/home/u/ProtonDrive".into(), names: vec!["Docs".into(), "Photos".into()], items: 12 });
        h.frames(3);
    }

    #[test]
    fn the_files_missing_hold_shows_on_every_tab() {
        let mut h = Harness::new("/my-files");
        assert!(h.text_at(DELETE_TOO).is_none());
        held(&mut h);
        for tab in [NavTab::CloudBrowser, NavTab::Overview, NavTab::Conflicts, NavTab::Settings] {
            h.app.tab = tab;
            h.frames(3);
            assert!(h.text_at(DELETE_TOO).is_some(), "{tab:?}");
            assert!(h.text_at("Docs and Photos are missing. Proton Drive waits for them to come back and syncs nothing meanwhile.").is_some(), "{tab:?}");
        }
    }

    #[test]
    fn deleting_the_missing_files_from_proton_drive_asks_first_and_keep_waiting_sends_nothing() {
        let mut h = Harness::new("/my-files");
        held(&mut h);
        h.click(h.text_at(DELETE_TOO).unwrap());
        assert_eq!(h.app.pending_confirm, Some(PendingConfirm::DeleteMissing { root: "/home/u/ProtonDrive".into(), items: 12 }));
        assert!(h
            .text_at("The 12 items that were in /home/u/ProtonDrive will move to the Proton Drive trash. You can restore them from the trash on the Proton Drive website.")
            .is_some());
        assert_eq!(h.sent(), Vec::<String>::new());
        h.click(h.text_at("Keep waiting").expect("keep waiting is offered"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), Vec::<String>::new());

        h.click(h.text_at(DELETE_TOO).unwrap());
        h.click(h.text_at("Delete from Proton Drive").expect("the dialog is painted"));
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["files missing: delete in cloud".to_string()]);
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
    fn the_confirmation_posts_delete_in_cloud_on_the_control_socket() {
        let reply: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 61\r\n\r\n{\"ok\":true,\"root\":\"/home/u/ProtonDrive\",\"names\":[],\"items\":0}";
        let (sock, server) = serve_once(reply);
        files_missing_delete_at(&sock).unwrap();
        let seen = server.join().unwrap();
        assert!(seen.starts_with("POST /sync/files-missing HTTP/1.1\r\n"), "{seen}");
        assert!(seen.ends_with(r#"{"action":"delete-in-cloud"}"#), "{seen}");
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn daemon_status_reads_files_missing() {
        let status: DaemonStatus = serde_json::from_str(
            r#"{"state":"error","currentAction":null,"loggedIn":true,"syncDir":"/home/u/ProtonDrive","activeTransfers":[],
                "filesMissing":{"root":"/home/u/ProtonDrive","names":["Docs"],"items":3},
                "stats":{"totalFiles":1,"totalFolders":0,"totalBytes":3,"unresolvedConflicts":0,"errorItems":0},
                "settings":{"syncDir":"/home/u/ProtonDrive","conflictStrategy":"keep-both","notificationsEnabled":true,
                            "reconcileIntervalSec":120,"paused":false,"ignorePatterns":[".git"]}}"#,
        )
        .unwrap();
        assert_eq!(status.files_missing, Some(FilesMissing { root: "/home/u/ProtonDrive".into(), names: vec!["Docs".into()], items: 3 }));
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
        let fm = |names: &[&str], items| FilesMissing { root: "/r".into(), names: names.iter().map(|n| n.to_string()).collect(), items };
        assert_eq!(missing_names(&fm(&["Docs"], 1)), "Docs is");
        assert_eq!(missing_names(&fm(&["Docs", "Photos"], 2)), "Docs and Photos are");
        assert_eq!(missing_names(&fm(&["A", "B", "C"], 3)), "A, B and C are");
        assert_eq!(missing_names(&fm(&["A", "B", "C", "D", "E"], 5)), "A, B, C and 2 more are");
        assert_eq!(missing_names(&fm(&[], 0)), "Your files are");
    }

    #[test]
    fn the_settings_tab_shows_the_drive_and_its_switch() {
        let h = Harness::settings(Some(vfs("virtual", true, None)), Some(true));
        assert!(h.text_at("Virtual drive: mounted at /home/u/ProtonDrive").is_some());
        assert!(h.text_at(SWITCH).is_some());
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
    fn switching_the_virtual_drive_on_goes_at_once() {
        let mut h = Harness::settings(Some(vfs("plain", false, Some("switched-off"))), Some(false));
        assert!(h.text_at("Plain folder: virtual drive switched off").is_some());
        h.click(h.text_at(SWITCH).unwrap());
        assert_eq!(h.app.pending_confirm, None);
        assert_eq!(h.sent(), vec!["virtual drive true".to_string()]);
    }

    #[test]
    fn mount_again_and_the_move_actions_send_their_requests() {
        let mut h = Harness::settings(Some(vfs("virtual", false, Some("ejected"))), Some(true));
        h.click(h.text_at("Mount again").expect("Mount again is offered"));
        assert_eq!(h.sent(), vec!["mount again".to_string()]);
        // Nothing else is sent while it runs
        h.click(h.text_at("Mount again").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());

        let stopped = VfsStatus {
            error: Some("Disk full".into()),
            drive_move: Some(drive_move("relocation", None, &["move-back", "retry"])),
            ..vfs("plain", false, Some("move-failed"))
        };
        let mut h = Harness::settings(Some(stopped.clone()), Some(true));
        assert!(h.text_at("Moving files stopped: Disk full").is_some());
        assert!(h.text_at("Finish moving files").is_none());
        h.click(h.text_at("Move files back").expect("the move's actions are offered"));
        assert_eq!(h.sent(), vec!["move-back /home/u/ProtonDrive -> /mnt/b/ProtonDrive".to_string()]);
        let mut h = Harness::settings(Some(stopped), Some(true));
        h.click(h.text_at("Try again").unwrap());
        assert_eq!(h.sent(), vec!["retry /home/u/ProtonDrive -> /mnt/b/ProtonDrive".to_string()]);
    }

    #[test]
    fn a_refused_drive_request_is_shown() {
        let mut h = Harness::settings(Some(vfs("virtual", false, Some("ejected"))), Some(true));
        h.click(h.text_at("Mount again").unwrap());
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
        h.click(h.text_at("Save Preferences").unwrap());
        assert_eq!(h.sent(), Vec::<String>::new());
        assert!(h.text_at("No changes to save.").is_some());

        h.app.edit_conflict_strategy = "keep-local".into();
        h.app.settings_dirty = true;
        h.frames(2);
        h.click(h.text_at("Save Preferences").unwrap());
        assert_eq!(h.sent(), vec![r#"save {"conflictStrategy":"keep-local"}"#.to_string()]);
        assert!(h.app.settings_saving);
    }

    #[test]
    fn a_save_refreshes_the_form_from_the_reply_and_shows_what_was_refused() {
        let mut h = Harness::settings(None, None);
        h.app.edit_sync_dir = "/mnt/b/ProtonDrive".into();
        h.app.edit_conflict_strategy = "keep-local".into();
        h.app.settings_dirty = true;
        h.app.settings_saving = true;
        let stored = SyncSettings { conflict_strategy: "keep-local".into(), ..loaded_settings() };
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
        let mut h = Harness::new("/my-files");
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
}
