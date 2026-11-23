//! The Share window (#216): an item's public link (on or off, its password and expiry), inviting people by email, and
//! who has access. Everything goes through the daemon's /share routes on the control socket, off the UI thread; nothing
//! here logs what it shares (no URL, password or address).
//!
//! It is drawn over the app's window (which a request from Files brings to the front), not as a window of its own: a
//! second window (an egui immediate viewport) opened under the app's window on X11/XWayland when the app wasn't
//! focused, out of sight, and GNOME then let that hidden window draw only once a second, which held up the whole app.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eframe::egui::{
    self, Align, Color32, CornerRadius, Frame, Key, Layout, Margin, RichText, ScrollArea, Sense, Stroke, Vec2,
};
use serde::Deserialize;

use crate::home::{self, elided, primary_button, secondary_button};
use crate::single_instance::PathProblem;
use crate::{
    action_button, action_button_named, action_button_sized, action_button_width, button_width, control_request_at, icon_button, icons,
    toggle_switch, ButtonKind, ProtonDriveNativeApp, WorkerCommand, BG_CARD, BG_CARD_ALT, BG_INPUT, BORDER_NORM,
    BORDER_SUBTLE, DANGER_TEXT, TEXT_MUTED, TEXT_PRIMARY,
};

/// A share's role, for the link and for each person.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    Viewer,
    Editor,
}

impl Role {
    /// As the daemon's routes take it
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Role::Viewer => "Viewer",
            Role::Editor => "Editor",
        }
    }
}

/// The item's public link, as GET /share/info gives it: never with its password.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub url: String,
    pub has_password: bool,
    /// Epoch ms; None when it never expires
    pub expires_at: Option<i64>,
    pub role: Role,
}

/// Where someone with access stands: a member, or invited (with a Proton account, or by email without one).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PersonState {
    Member,
    Invited,
    InvitedNotProton,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SharePerson {
    pub email: String,
    pub role: Role,
    pub state: PersonState,
}

/// How an item is shared (GET /share/info): its link, if any, and the people with access.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ShareInfo {
    pub link: Option<ShareLink>,
    pub people: Vec<SharePerson>,
}

/// What the window says for an item outside the drive (or the drive's folder itself).
pub const NOT_IN_DRIVE: &str = "Not in Proton Drive";
/// What Show says for a link whose password the daemon can't give (older links: controller ruling 9)
pub const CANT_SHOW_PASSWORD: &str = "Proton Drive can't show this link's password here: open it on drive.proton.me";
/// What the window says while the daemon doesn't answer, before it could work out where the item is
pub const DAEMON_UNREACHABLE: &str = "Can't reach Proton Drive's background service";
/// What a daemon from before the /share routes answers (404): restarting it brings them
pub const SHARE_NEEDS_RESTART: &str = "Restart Proton Drive to share from here";
/// Under an expired link, whose Copy link is off (Files' Copy Link refuses it too)
pub const LINK_EXPIRED: &str = "This link has expired: set a new date, or remove the expiry, to use it again";
const UNREADABLE: &str = "Unreadable reply from the Proton Drive background service";
/// As many addresses as the daemon takes in one invitation
const MAX_INVITES: usize = 50;
/// How far ahead an expiry may be, as the daemon takes it
const MAX_EXPIRY_YEARS: i64 = 10;

/// Reading how an item is shared asks Proton's servers, through the daemon.
const SHARE_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A change can take longer: inviting many people is a request for each.
const SHARE_WRITE_TIMEOUT: Duration = Duration::from_secs(120);

/// Why the window can't share what a start named (`--share`), in its words: Files says the same for the two it can meet.
pub fn refusal(problem: PathProblem) -> &'static str {
    match problem {
        PathProblem::NotAbsolute => "Proton Drive needs the item's full path, starting with /",
        PathProblem::TooLong => "This path is too long for Proton Drive to share",
        PathProblem::LineBreak => "Proton Drive can't share an item whose path has a line break in it",
        PathProblem::NotUtf8 => "Proton Drive can't share an item whose path isn't valid UTF-8",
    }
}

/// The item's path inside My files, from its absolute path and the sync folder; None when it isn't inside the folder
/// (the folder itself included).
pub fn rel_path_in(sync_dir: &str, abs_path: &str) -> Option<String> {
    let dir = sync_dir.trim_end_matches('/');
    if dir.is_empty() {
        return None;
    }
    let rel = abs_path.strip_prefix(dir)?.strip_prefix('/')?.trim_end_matches('/');
    (!rel.is_empty()).then(|| rel.to_string())
}

/// An address as the daemon takes one (shareService's EMAIL): something@something.something, with no space and one @.
fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && !text.chars().any(char::is_whitespace)
        && domain.char_indices().any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// The addresses typed under Invite people, split on commas, semicolons and spaces, each checked as the daemon checks
/// it; the same address twice is sent once.
pub fn parse_emails(text: &str) -> Result<Vec<String>, String> {
    let mut emails: Vec<String> = Vec::new();
    for item in text.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter(|s| !s.is_empty()) {
        if !is_email(item) {
            return Err(format!("Not a valid email address: {item}"));
        }
        if !emails.iter().any(|e| e.to_lowercase() == item.to_lowercase()) {
            emails.push(item.to_string());
        }
    }
    match emails.len() {
        0 => Err("Type the email address of someone to invite".to_string()),
        n if n > MAX_INVITES => Err(format!("Invite at most {MAX_INVITES} people at a time")),
        _ => Ok(emails),
    }
}

/// Days since 1970-01-01 of a date in the proleptic Gregorian calendar (month 1 to 12).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12; // March is 0
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date (year, month, day) of a day since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A `YYYY-MM-DD` date as days since 1970-01-01; None when it isn't a real date in that form.
pub fn parse_date(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range.clone()].iter().all(u8::is_ascii_digit).then(|| text[range].parse::<i64>().ok())?;
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let days = days_from_civil(year, month, day);
    // A day past the month's end (or a month past 12) would read as a later date: such a date isn't one
    ((1..=12).contains(&month) && day >= 1 && civil_from_days(days) == (year, month, day)).then_some(days)
}

/// A day (days since 1970-01-01) as `YYYY-MM-DD`.
pub fn date_text(day: i64) -> String {
    let (year, month, day) = civil_from_days(day);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The local day (days since 1970-01-01) of a time in epoch ms. `offset_at` gives local time's offset from UTC
/// (seconds east) at a time in epoch ms (home::local_offset_secs).
pub fn local_day(ms: i64, offset_at: impl Fn(i64) -> i64) -> i64 {
    home::local_day_and_secs(ms, offset_at(ms)).0
}

/// The last second of a local day (days since 1970-01-01), in epoch ms: by the offset that holds then, so a clock change
/// that day is allowed for.
pub fn end_of_day(day: i64, offset_at: impl Fn(i64) -> i64) -> i64 {
    let local_secs = (day + 1) * 86_400 - 1;
    let guess = (local_secs - offset_at(local_secs * 1000)) * 1000;
    (local_secs - offset_at(guess)) * 1000
}

/// The expiry a typed date asks for: the end of that day, local time; or why it can't be.
pub fn expiry_from_date(text: &str, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> Result<i64, String> {
    let day = parse_date(text).ok_or("Type the date as YYYY-MM-DD")?;
    let today = local_day(now_ms, &offset_at);
    if day < today {
        return Err("That day has passed: pick today or a later day".to_string());
    }
    // The daemon takes an expiry up to 10 years from now: the end of the day 10 years on is already past that
    let (year, month, date) = civil_from_days(today);
    if day >= days_from_civil(year + MAX_EXPIRY_YEARS, month, date) {
        return Err(format!("Pick a day within {MAX_EXPIRY_YEARS} years"));
    }
    Ok(end_of_day(day, offset_at))
}

/// When the link expires, in words, and whether it has.
fn expiry_text(expires_at: Option<i64>, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> (String, bool) {
    let Some(at) = expires_at else {
        return ("Never".to_string(), false);
    };
    let day = local_day(at, &offset_at);
    let date = date_text(day);
    if at <= now_ms {
        return (format!("Expired {date}"), true);
    }
    let when = match day - local_day(now_ms, &offset_at) {
        ..=0 => "today".to_string(),
        1 => "tomorrow".to_string(),
        n => format!("in {n} days"),
    };
    (format!("{date} ({when})"), false)
}

/// The POST /share/link/settings body: only what changes (None leaves it as it is; Some(None) clears it).
pub fn settings_body(rel_path: &str, password: Option<Option<&str>>, expires_at: Option<Option<i64>>) -> serde_json::Value {
    let mut body = serde_json::json!({ "path": rel_path });
    if let Some(password) = password {
        body["password"] = password.map_or(serde_json::Value::Null, serde_json::Value::from);
    }
    if let Some(expires_at) = expires_at {
        body["expiresAt"] = expires_at.map_or(serde_json::Value::Null, serde_json::Value::from);
    }
    body
}

/// A query parameter's value, percent-encoded (everything but letters, digits and `-._~`).
fn query_value(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// One /share request on the control socket. A 400 comes back as the daemon words it, to show as is.
fn share_request(
    socket: &Path,
    method: &str,
    path_and_query: &str,
    body: Option<&serde_json::Value>,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    // A 404 is the daemon's catch-all for a route it doesn't have, with or without its {"error":"Not found"} body
    control_request_at(socket, method, path_and_query, body, read_timeout).map_err(|e| {
        if e == "Not found" || e.ends_with("answered 404") {
            SHARE_NEEDS_RESTART.to_string()
        } else {
            e
        }
    })
}

/// A change: what it answers is read again with GET /share/info, as after every change.
fn share_change(socket: &Path, method: &str, route: &str, body: serde_json::Value) -> Result<(), String> {
    share_request(socket, method, route, Some(&body), SHARE_WRITE_TIMEOUT).map(|_| ())
}

/// How the item is shared (GET /share/info).
pub fn info_at(socket: &Path, rel_path: &str) -> Result<ShareInfo, String> {
    let reply = share_request(socket, "GET", &format!("/share/info?path={}", query_value(rel_path)), None, SHARE_READ_TIMEOUT)?;
    // Not serde's message: it can quote what it couldn't read, addresses among them
    serde_json::from_value(reply).map_err(|_| UNREADABLE.to_string())
}

/// The link's password (GET /share/password), asked for only when Show is clicked; None when Proton Drive can't show it.
pub fn password_at(socket: &Path, rel_path: &str) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Reply {
        password: Option<String>,
    }
    let reply = share_request(socket, "GET", &format!("/share/password?path={}", query_value(rel_path)), None, SHARE_READ_TIMEOUT)?;
    serde_json::from_value::<Reply>(reply).map(|r| r.password).map_err(|_| UNREADABLE.to_string())
}

pub fn ensure_link_at(socket: &Path, rel_path: &str) -> Result<(), String> {
    share_change(socket, "POST", "/share/link", serde_json::json!({ "path": rel_path }))
}

pub fn settings_at(socket: &Path, rel_path: &str, password: Option<Option<&str>>, expires_at: Option<Option<i64>>) -> Result<(), String> {
    share_change(socket, "POST", "/share/link/settings", settings_body(rel_path, password, expires_at))
}

pub fn remove_link_at(socket: &Path, rel_path: &str) -> Result<(), String> {
    share_change(socket, "DELETE", "/share/link", serde_json::json!({ "path": rel_path }))
}

pub fn invite_at(socket: &Path, rel_path: &str, emails: &[String], role: Role) -> Result<(), String> {
    share_change(socket, "POST", "/share/invite", serde_json::json!({ "path": rel_path, "emails": emails, "role": role.as_str() }))
}

pub fn role_at(socket: &Path, rel_path: &str, email: &str, role: Role) -> Result<(), String> {
    share_change(socket, "POST", "/share/role", serde_json::json!({ "path": rel_path, "email": email, "role": role.as_str() }))
}

pub fn remove_person_at(socket: &Path, rel_path: &str, email: &str) -> Result<(), String> {
    share_change(socket, "DELETE", "/share/person", serde_json::json!({ "path": rel_path, "email": email }))
}

/// Everything the account shares (GET /share/list). Read with the longer timeout: the listing grows with the number of
/// shared items (#257).
pub fn list_at(socket: &Path) -> Result<Vec<crate::shared::SharedItem>, String> {
    #[derive(Deserialize)]
    struct Reply {
        items: Vec<crate::shared::SharedItem>,
    }
    let reply = share_request(socket, "GET", "/share/list", None, SHARE_WRITE_TIMEOUT)?;
    serde_json::from_value::<Reply>(reply).map(|r| r.items).map_err(|_| UNREADABLE.to_string())
}

/// Stops all sharing of an item: its link and everyone invited (DELETE /share/all). `uid` is the one the list gave the
/// item: the daemon refuses when the path no longer holds that item (#260).
pub fn stop_sharing_at(socket: &Path, rel_path: &str, uid: &str) -> Result<(), String> {
    share_change(socket, "DELETE", "/share/all", serde_json::json!({ "path": rel_path, "uid": uid }))
}

/// Screenshot-only: `--fake-share <state>`, how the item is shared in each state the window shows (none, a link, a link
/// with a password and an expiry a week out, a link that expired yesterday, and a link with three people: a member
/// editor, a Proton invitation and an invitation by email); None for an unknown state.
pub fn fake_share_info(state: &str, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> Option<ShareInfo> {
    let link = |has_password: bool, expires_at: Option<i64>| ShareLink {
        url: "https://drive.proton.me/urls/7XK2M9QD4A#aB3dE5fG7hJ9".into(),
        has_password,
        expires_at,
        role: Role::Viewer,
    };
    let person = |email: &str, role: Role, state: PersonState| SharePerson { email: email.into(), role, state };
    Some(match state {
        "none" => ShareInfo::default(),
        "link" => ShareInfo { link: Some(link(false, None)), people: vec![] },
        "link-password" => {
            let week = end_of_day(local_day(now_ms, &offset_at) + 7, &offset_at);
            ShareInfo { link: Some(link(true, Some(week))), people: vec![] }
        }
        "link-expired" => {
            let yesterday = end_of_day(local_day(now_ms, &offset_at) - 1, &offset_at);
            ShareInfo { link: Some(link(false, Some(yesterday))), people: vec![] }
        }
        "people" => ShareInfo {
            link: Some(link(false, None)),
            people: vec![
                person("alex.martin@proton.me", Role::Editor, PersonState::Member),
                person("sam.okafor@proton.me", Role::Viewer, PersonState::Invited),
                person("jordan@example.com", Role::Viewer, PersonState::InvitedNotProton),
            ],
        },
        _ => return None,
    })
}

/// Which part of the window an error belongs under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Link,
    Invite,
    People,
}

/// The link's password as the window shows it: hidden (dots) until Show is clicked.
#[derive(Clone, Debug, PartialEq)]
pub enum PasswordView {
    Hidden,
    /// Show was clicked; the password is on its way
    Loading,
    Shown(String),
    /// The daemon can't give it (an older link)
    CantShow,
}

/// What waits for the user's confirmation, in the window.
#[derive(Clone, Debug, PartialEq)]
pub enum Confirm {
    LinkOff,
    RemovePerson(String),
}

/// The change out, if any: what to do once it went through, or what to say if it didn't.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Change {
    LinkOn,
    LinkOff,
    Password,
    Expiry,
    Invite,
    /// Someone's role (their address)
    Role(String),
    /// Someone's access (their address)
    RemovePerson(String),
}

/// Which Share window a request came from. Each window gets its own, and its answers come back with it, so an answer
/// for a window since closed or replaced never lands in another, even one open on the same item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowId(u64);

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// A change a window sent, still out when the window was closed or replaced (closing never waits): if it fails, the
/// app's notice says so, since no window is left to.
pub struct LeftChange {
    window: WindowId,
    rel_path: String,
    name: String,
    change: Change,
}

impl LeftChange {
    /// What the notice says when it failed.
    fn failed(&self, problem: &str) -> String {
        let name = &self.name;
        match &self.change {
            Change::LinkOn => format!("Couldn't turn on the link to {name}: {problem}"),
            Change::LinkOff => format!("Couldn't stop sharing the link to {name}: {problem}"),
            Change::Password => format!("Couldn't change the password of the link to {name}: {problem}"),
            Change::Expiry => format!("Couldn't change when the link to {name} expires: {problem}"),
            Change::Invite => format!("Couldn't invite people to {name}: {problem}"),
            Change::Role(email) => format!("Couldn't change {email}'s access to {name}: {problem}"),
            Change::RemovePerson(email) => format!("Couldn't remove {email}'s access to {name}: {problem}"),
        }
    }
}

/// What the user did in the window.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    LinkOn,
    AskLinkOff,
    ShowPassword,
    HidePassword,
    EditPassword,
    SavePassword,
    CancelPassword,
    RemovePassword,
    EditExpiry,
    /// Fills the date in with the day this many days from today
    PresetExpiry(i64),
    SaveExpiry,
    CancelExpiry,
    RemoveExpiry,
    Invite,
    SetRole(String, Role),
    AskRemove(String),
    Confirm,
    CancelConfirm,
    Retry,
}

impl Action {
    /// Whether it only opens, closes or hides something in the window (it may then go while a change is out).
    fn is_local(&self) -> bool {
        matches!(self, Action::HidePassword | Action::CancelPassword | Action::CancelExpiry | Action::CancelConfirm)
    }
}

/// The Share window's state, for the item at `abs_path`.
pub struct ShareWindow {
    /// This window's, carried by its requests and their answers
    pub id: WindowId,
    pub abs_path: String,
    /// The item's path inside My files; empty until known, and when it isn't in the drive
    pub rel_path: String,
    /// The item's file name, which titles the window
    pub name: String,
    /// How it is shared, as last read (None until the first answer), or why it couldn't be read
    pub info: Option<Result<ShareInfo, String>>,
    /// Whether rel_path was worked out (from the sync folder the daemon reported)
    resolved: bool,
    /// A read is out
    loading: bool,
    /// A change is out: the window waits for it
    busy: Option<Change>,
    /// Why the last change, or what was typed for it, was refused; shown under its section
    pub error: Option<(Section, String)>,
    pub password: PasswordView,
    /// The new password typed, while its field is open
    pub password_editor: Option<String>,
    /// The expiry date typed (YYYY-MM-DD), while its field is open
    pub expiry_editor: Option<String>,
    pub invite_input: String,
    pub invite_role: Role,
    pub confirm: Option<Confirm>,
    /// Copy link was clicked (its button says Copied until the next change)
    copied: bool,
    /// The password field just opened: it takes the keyboard
    focus_field: bool,
}

impl ShareWindow {
    pub fn new(abs_path: &str) -> Self {
        let name = Path::new(abs_path).file_name().map_or_else(|| abs_path.to_string(), |n| n.to_string_lossy().into_owned());
        Self {
            id: WindowId(NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)),
            abs_path: abs_path.to_string(),
            rel_path: String::new(),
            name,
            info: None,
            resolved: false,
            loading: false,
            busy: None,
            error: None,
            password: PasswordView::Hidden,
            password_editor: None,
            expiry_editor: None,
            invite_input: String::new(),
            invite_role: Role::Viewer,
            confirm: None,
            copied: false,
            focus_field: false,
        }
    }

    /// The window for what a start named but can't be shared (`shown`, only to show): it says why, and asks nothing.
    pub fn refused(shown: &str, problem: PathProblem) -> Self {
        let mut w = Self::new(shown);
        w.resolved = true;
        w.info = Some(Err(refusal(problem).to_string()));
        w
    }

    /// Whether it is on an item in the drive, or may yet be (it waits to know where the drive is): not one that could
    /// only say why it can't share (outside the drive, or a path that can't be shared).
    pub fn may_share(&self) -> bool {
        !self.resolved || !self.rel_path.is_empty()
    }

    /// The change it sent that isn't answered yet, if any, as it is closed or replaced.
    pub fn left_change(self) -> Option<LeftChange> {
        let change = self.busy?;
        Some(LeftChange { window: self.id, rel_path: self.rel_path, name: self.name, change })
    }

    /// Share… again on its item: it reads again (what it shows, an error included, may be out of date), unless
    /// something is typed in it, or it already waits for the daemon.
    fn again(&mut self) -> Option<WorkerCommand> {
        // While a read failed, no field shows: nothing typed is in sight to keep
        let typed = matches!(self.info, Some(Ok(_)))
            && (!self.invite_input.trim().is_empty()
                || self.password_editor.is_some()
                || self.expiry_editor.is_some()
                || self.confirm.is_some());
        if typed || !self.resolved || self.rel_path.is_empty() || self.busy.is_some() || self.loading {
            return None;
        }
        self.error = None;
        Some(self.load())
    }

    /// A change sent from a window since closed, for this item, was answered: what this window read may be from before
    /// it, so it reads again (unless its own change is out: the read after that one comes anyway).
    fn changed_elsewhere(&mut self, rel_path: &str) -> Option<WorkerCommand> {
        (self.resolved && !self.rel_path.is_empty() && self.rel_path == rel_path && self.busy.is_none()).then(|| self.load())
    }

    /// Works out the item's path inside My files from the sync folder the daemon reported, once, and asks how it is
    /// shared; outside the drive, says so and asks nothing.
    fn resolve(&mut self, sync_dir: &str) -> Option<WorkerCommand> {
        if self.resolved {
            return None;
        }
        self.resolved = true;
        match rel_path_in(sync_dir, &self.abs_path) {
            Some(rel_path) => {
                self.rel_path = rel_path;
                self.info = None;
                Some(self.load())
            }
            None => {
                self.info = Some(Err(NOT_IN_DRIVE.to_string()));
                None
            }
        }
    }

    /// The daemon didn't answer the app's status: before the item's place is known, the window says so (it reads once
    /// the daemon answers).
    fn unreachable(&mut self) {
        if !self.resolved {
            self.info = Some(Err(DAEMON_UNREACHABLE.to_string()));
        }
    }

    /// Screenshot-only: shows `info` without asking the daemon.
    pub fn fake(&mut self, info: ShareInfo, sync_dir: &str) {
        self.resolved = true;
        self.rel_path = rel_path_in(sync_dir, &self.abs_path).unwrap_or_else(|| self.name.clone());
        self.info = Some(Ok(info));
    }

    fn load(&mut self) -> WorkerCommand {
        self.loading = true;
        WorkerCommand::ShareLoad { window: self.id, rel_path: self.rel_path.clone() }
    }

    fn link(&self) -> Option<&ShareLink> {
        self.info.as_ref()?.as_ref().ok()?.link.as_ref()
    }

    /// A change goes out: the window waits for it, and a shown password is hidden again (it may be about to change).
    fn start(&mut self, change: Change) {
        if matches!(change, Change::LinkOn | Change::LinkOff | Change::Password) {
            self.password = PasswordView::Hidden;
        }
        self.busy = Some(change);
        self.error = None;
        self.copied = false;
    }

    /// Does what the user asked; what to send the worker, if anything. Nothing goes while a change, or the read after
    /// one, is out (the window then shows what may be about to change), or for an item whose place in the drive isn't
    /// known.
    pub fn act(&mut self, action: Action, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> Option<WorkerCommand> {
        if !action.is_local() && (self.working() || self.rel_path.is_empty()) {
            return None;
        }
        let (window, rel_path) = (self.id, self.rel_path.clone());
        match action {
            Action::LinkOn => {
                if self.link().is_some() {
                    return None;
                }
                self.start(Change::LinkOn);
                Some(WorkerCommand::ShareEnsureLink { window, rel_path })
            }
            Action::AskLinkOff => {
                self.confirm = self.link().is_some().then_some(Confirm::LinkOff);
                None
            }
            Action::AskRemove(email) => {
                self.confirm = Some(Confirm::RemovePerson(email));
                None
            }
            Action::CancelConfirm => {
                self.confirm = None;
                None
            }
            Action::Confirm => match self.confirm.take()? {
                Confirm::LinkOff => {
                    self.start(Change::LinkOff);
                    self.password_editor = None;
                    self.expiry_editor = None;
                    Some(WorkerCommand::ShareRemoveLink { window, rel_path })
                }
                Confirm::RemovePerson(email) => {
                    self.start(Change::RemovePerson(email.clone()));
                    Some(WorkerCommand::ShareRemovePerson { window, rel_path, email })
                }
            },
            Action::ShowPassword => {
                self.password = PasswordView::Loading;
                Some(WorkerCommand::SharePassword { window, rel_path })
            }
            Action::HidePassword => {
                self.password = PasswordView::Hidden;
                None
            }
            Action::EditPassword => {
                self.password_editor = Some(String::new());
                self.focus_field = true;
                self.error = None;
                None
            }
            Action::CancelPassword => {
                self.password_editor = None;
                None
            }
            Action::SavePassword => {
                let typed = self.password_editor.clone()?;
                if typed.is_empty() {
                    self.error = Some((Section::Link, "Type a password".to_string()));
                    return None;
                }
                self.start(Change::Password);
                Some(WorkerCommand::ShareSettings { window, rel_path, password: Some(Some(typed)), expires_at: None })
            }
            Action::RemovePassword => {
                self.start(Change::Password);
                Some(WorkerCommand::ShareSettings { window, rel_path, password: Some(None), expires_at: None })
            }
            Action::EditExpiry => {
                let current = self.link().and_then(|l| l.expires_at).filter(|at| *at > now_ms);
                self.expiry_editor = Some(current.map(|at| date_text(local_day(at, &offset_at))).unwrap_or_default());
                self.error = None;
                None
            }
            Action::PresetExpiry(days) => {
                self.expiry_editor = Some(date_text(local_day(now_ms, &offset_at) + days));
                self.error = None;
                None
            }
            Action::CancelExpiry => {
                self.expiry_editor = None;
                None
            }
            Action::SaveExpiry => match expiry_from_date(self.expiry_editor.as_deref()?, now_ms, offset_at) {
                Ok(at) => {
                    self.start(Change::Expiry);
                    Some(WorkerCommand::ShareSettings { window, rel_path, password: None, expires_at: Some(Some(at)) })
                }
                Err(problem) => {
                    self.error = Some((Section::Link, problem));
                    None
                }
            },
            Action::RemoveExpiry => {
                self.start(Change::Expiry);
                Some(WorkerCommand::ShareSettings { window, rel_path, password: None, expires_at: Some(None) })
            }
            Action::Invite => match parse_emails(&self.invite_input) {
                Ok(emails) => {
                    self.start(Change::Invite);
                    Some(WorkerCommand::ShareInvite { window, rel_path, emails, role: self.invite_role })
                }
                Err(problem) => {
                    self.error = Some((Section::Invite, problem));
                    None
                }
            },
            Action::SetRole(email, role) => {
                // Shown at once; the read after the change brings the role back if it was refused
                let person = match &mut self.info {
                    Some(Ok(info)) => info.people.iter_mut().find(|p| p.email == email),
                    _ => None,
                }?;
                if person.role == role {
                    return None;
                }
                person.role = role;
                self.start(Change::Role(email.clone()));
                Some(WorkerCommand::ShareRole { window, rel_path, email, role })
            }
            Action::Retry => {
                self.error = None;
                Some(self.load())
            }
        }
    }

    /// How the item is shared, as just read.
    fn loaded(&mut self, result: Result<ShareInfo, String>) {
        self.loading = false;
        if !matches!(&result, Ok(ShareInfo { link: Some(link), .. }) if link.has_password) {
            // No link, or no password: nothing to show
            self.password = PasswordView::Hidden;
        }
        self.info = Some(result);
    }

    /// A change went through, or why not; the window reads how the item is shared again either way.
    fn done(&mut self, result: Result<(), String>) -> WorkerCommand {
        let change = self.busy.take();
        match result {
            Ok(()) => match change {
                Some(Change::Password) => self.password_editor = None,
                Some(Change::Expiry) => self.expiry_editor = None,
                Some(Change::Invite) => self.invite_input.clear(),
                _ => {}
            },
            Err(problem) => {
                let section = match change {
                    Some(Change::Invite) => Section::Invite,
                    Some(Change::Role(_) | Change::RemovePerson(_)) => Section::People,
                    _ => Section::Link,
                };
                self.error = Some((section, problem));
            }
        }
        self.load()
    }

    /// The password Show asked for, unless it was hidden again or the link changed meanwhile.
    fn password_arrived(&mut self, result: Result<Option<String>, String>) {
        if self.password != PasswordView::Loading {
            return;
        }
        self.password = match result {
            Ok(Some(password)) => PasswordView::Shown(password),
            Ok(None) => PasswordView::CantShow,
            Err(problem) => {
                self.error = Some((Section::Link, problem));
                PasswordView::Hidden
            }
        };
    }

    /// Whether the window waits on the daemon (a change, or the read after one).
    fn working(&self) -> bool {
        self.busy.is_some() || (self.loading && self.info.is_some())
    }
}

/// The confirmation's title, text and button.
fn confirm_copy(confirm: &Confirm, w: &ShareWindow) -> (String, String, &'static str) {
    match confirm {
        Confirm::LinkOff => ("Stop sharing the link?".to_string(), "Anyone using it loses access.".to_string(), "Stop sharing"),
        Confirm::RemovePerson(email) => {
            let invited = match &w.info {
                Some(Ok(info)) => info.people.iter().any(|p| &p.email == email && p.state != PersonState::Member),
                _ => false,
            };
            let body = if invited {
                format!("Their invitation to {} is cancelled.", w.name)
            } else {
                format!("They lose access to {}.", w.name)
            };
            (format!("Remove {email}?"), body, "Remove access")
        }
    }
}

const SHARE_ID: &str = "protondrive_share";
/// The window's width, and the height it is laid out for: it is as high as it needs, up to the room there is (then what
/// is above Done scrolls)
const WIDTH: f32 = 520.0;
const HEIGHT: f32 = 680.0;
/// Room for Done at the bottom
const FOOTER_HEIGHT: f32 = 58.0;
/// The labels' column (Password, Expires)
const LABEL_WIDTH: f32 = 76.0;
const ROW_HEIGHT: f32 = 30.0;
const PERSON_ROW_HEIGHT: f32 = 36.0;

impl ProtonDriveNativeApp {
    /// Works out the open Share window's item once the daemon has said where the sync folder is: the startup cache's may
    /// be out of date. While the daemon doesn't answer, the window says so.
    pub(crate) fn resolve_share(&mut self) {
        if self.initial_connecting {
            return;
        }
        if !self.daemon_online {
            if let Some(w) = self.share.as_mut() {
                w.unreachable();
            }
            return;
        }
        let sync_dir = self.status.sync_dir.clone();
        if let Some(cmd) = self.share.as_mut().and_then(|w| w.resolve(&sync_dir)) {
            let _ = self.tx.send(cmd);
        }
    }

    /// The open window, if it is the one that asked (an answer for one since closed or replaced has none).
    fn share_for(&mut self, window: WindowId) -> Option<&mut ShareWindow> {
        self.share.as_mut().filter(|w| w.id == window)
    }

    /// Closes the Share window, or makes way for another: closing never waits, so a change it sent that isn't
    /// answered yet is remembered, to tell if it fails.
    pub(crate) fn leave_share(&mut self) {
        let was_open = self.share.is_some();
        if let Some(left) = self.share.take().and_then(ShareWindow::left_change) {
            self.share_left.push(left);
        }
        // What was shared may have changed in the window: the Shared section reads it again (#253)
        if was_open && self.tab == crate::NavTab::Shared {
            self.load_shared();
        }
    }

    /// Share… again on the open window's item: it reads again, unless something is typed in it.
    pub(crate) fn share_again(&mut self) {
        if let Some(cmd) = self.share.as_mut().and_then(ShareWindow::again) {
            let _ = self.tx.send(cmd);
        }
    }

    pub(crate) fn share_loaded(&mut self, window: WindowId, result: Result<ShareInfo, String>) {
        if let Some(w) = self.share_for(window) {
            w.loaded(result);
        }
    }

    pub(crate) fn share_done(&mut self, window: WindowId, result: Result<(), String>) {
        if let Some(w) = self.share_for(window) {
            let cmd = w.done(result);
            let _ = self.tx.send(cmd);
            return;
        }
        // A change from a window closed or replaced since: no window can show its failure, so the notice does
        let Some(i) = self.share_left.iter().position(|c| c.window == window) else {
            return;
        };
        let left = self.share_left.remove(i);
        if let Err(problem) = result {
            self.notice = Some(left.failed(&problem));
        }
        // The Shared section read the list when the window closed, perhaps before this change landed (#253)
        if self.tab == crate::NavTab::Shared {
            self.load_shared();
        }
        if let Some(cmd) = self.share.as_mut().and_then(|w| w.changed_elsewhere(&left.rel_path)) {
            let _ = self.tx.send(cmd);
        }
    }

    pub(crate) fn share_password(&mut self, window: WindowId, result: Result<Option<String>, String>) {
        if let Some(w) = self.share_for(window) {
            w.password_arrived(result);
        }
    }

    /// The Share window, while one is open, drawn over the app's window, which it dims and keeps from taking clicks.
    pub(crate) fn render_share(&mut self, ctx: &egui::Context) {
        if self.share.is_none() {
            return;
        }
        let screen = ctx.screen_rect();
        let width = WIDTH.min(screen.width() - 32.0);
        // Its top stays put as rows open and close under it: about centred for what it usually holds; it reaches down
        // to 20 points above the app window's bottom at most
        let top = ((screen.height() - HEIGHT) / 2.0).max(20.0);
        let height = screen.height() - top - 20.0;
        let id = egui::Id::new(SHARE_ID);
        egui::Modal::new(id)
            .area(egui::Modal::default_area(id).anchor(egui::Align2::CENTER_TOP, Vec2::new(0.0, top)))
            .backdrop_color(Color32::from_rgba_unmultiplied(10, 8, 16, 175))
            .frame(dialog_frame())
            .show(ctx, |ui| {
                ui.set_width(width - 44.0);
                self.share_ui(ui, height - 36.0 - FOOTER_HEIGHT);
            });
        self.share_confirm(ctx);
    }

    /// The window's contents: what can be scrolled (as high as what it holds, up to `body_height`), then Done.
    fn share_ui(&mut self, ui: &mut egui::Ui, body_height: f32) {
        let now = home::now_ms();
        let owner = self.status.account.as_ref().map(|a| a.email.clone()).unwrap_or_default();
        // Escape closes the window, but not while typing (it leaves the field), with a list open, or while a
        // confirmation (this window's or the app's) takes it
        let escape = ui.input(|i| i.key_pressed(Key::Escape))
            && ui.memory(|m| m.focused().is_none() && !m.any_popup_open())
            && self.pending_confirm.is_none();
        let Some(w) = self.share.as_mut() else {
            return;
        };
        let mut actions = Vec::new();
        let mut close = escape && w.confirm.is_none();
        ui.spacing_mut().item_spacing = Vec2::new(8.0, 6.0);
        // A thin bar that stays visible: on a small screen, Who has access can be below the fold
        ui.spacing_mut().scroll = egui::style::ScrollStyle::thin();
        // As high as it may be at once, not only as high as last frame's window was (an Area's contents get that):
        // it then shrinks to what it holds
        ScrollArea::vertical()
            .id_salt("share_scroll")
            .max_height(body_height)
            .min_scrolled_height(body_height)
            .auto_shrink([false, true])
            .show(ui, |ui| share_body(w, ui, &owner, now, &mut actions));
        ui.add_space(10.0);
        ui.separator();
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            if w.working() {
                ui.label(RichText::new("Working…").size(12.5).color(TEXT_MUTED()));
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                // Closing never waits: what is out still happens, and a failure is told in the app's notice
                if primary_button(ui, "Done", 34.0).clicked() {
                    close = true;
                }
            });
        });
        for action in actions {
            if let Some(cmd) = w.act(action, now, home::local_offset_secs) {
                let _ = self.tx.send(cmd);
            }
        }
        if close {
            self.leave_share();
        }
    }

    /// Turning the link off or removing someone asks first, over the window.
    fn share_confirm(&mut self, ctx: &egui::Context) {
        let Some(w) = self.share.as_mut() else {
            return;
        };
        let Some(confirm) = w.confirm.clone() else {
            return;
        };
        let (title, body, button) = confirm_copy(&confirm, w);
        let width = 400.0_f32.min(ctx.screen_rect().width() - 32.0);
        let mut answer = None;
        let response = egui::Modal::new(egui::Id::new("share_confirm"))
            .backdrop_color(Color32::from_rgba_unmultiplied(10, 8, 16, 120))
            .frame(dialog_frame())
            .show(ctx, |ui| {
                ui.set_width(width - 44.0);
                ui.add(egui::Label::new(RichText::new(title).size(16.0).strong().color(TEXT_PRIMARY())).wrap());
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(body).size(13.0).color(TEXT_PRIMARY())).wrap());
                ui.add_space(18.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    // It takes access away: red, not the primary purple
                    if action_button(ui, ButtonKind::Danger, None, button, 34.0).clicked() {
                        answer = Some(Action::Confirm);
                    }
                    ui.add_space(4.0);
                    if secondary_button(ui, "Cancel", 34.0).clicked() {
                        answer = Some(Action::CancelConfirm);
                    }
                });
            });
        // Escape and a click outside cancel
        if answer.is_none() && response.should_close() {
            answer = Some(Action::CancelConfirm);
        }
        if let Some(cmd) = answer.and_then(|a| w.act(a, home::now_ms(), home::local_offset_secs)) {
            let _ = self.tx.send(cmd);
        }
    }
}

fn dialog_frame() -> Frame {
    Frame::NONE
        .fill(BG_CARD())
        .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
        .corner_radius(CornerRadius::same(14))
        .shadow(egui::Shadow { offset: [0, 12], blur: 32, spread: 2, color: Color32::from_rgba_unmultiplied(0, 0, 0, 150) })
        .inner_margin(Margin::symmetric(22, 18))
}

/// `field` (a text field) with Proton's rounded corners (8 points) on its input colour and an AccessKit `label` (#372).
fn input_field(ui: &mut egui::Ui, label: &str, field: impl FnOnce(&mut egui::Ui) -> egui::Response) -> egui::Response {
    let resp = ui
        .scope(|ui| {
            let widgets = &mut ui.visuals_mut().widgets;
            for state in [&mut widgets.inactive, &mut widgets.hovered, &mut widgets.active, &mut widgets.open] {
                state.corner_radius = CornerRadius::same(8);
            }
            field(ui)
        })
        .inner;
    ui.ctx().accesskit_node_builder(resp.id, |node| {
        node.set_label(label);
    });
    crate::scroll_to_focused(ui, &resp);
    resp
}

fn section_title(ui: &mut egui::Ui, title: &str) {
    ui.label(RichText::new(title).size(14.5).strong().color(TEXT_PRIMARY()));
}

fn muted(ui: &mut egui::Ui, text: impl Into<String>) {
    ui.add(egui::Label::new(RichText::new(text.into()).size(12.5).color(TEXT_MUTED())).wrap());
}

/// A row's label in the labels' column (Password, Expires), or the room it takes when empty.
fn field_label(ui: &mut egui::Ui, text: &str) {
    ui.allocate_ui_with_layout(Vec2::new(LABEL_WIDTH, ROW_HEIGHT), Layout::left_to_right(Align::Center), |ui| {
        ui.set_min_size(Vec2::new(LABEL_WIDTH, ROW_HEIGHT));
        ui.label(RichText::new(text).size(13.0).color(TEXT_MUTED()));
    });
}

fn error_line(ui: &mut egui::Ui, w: &ShareWindow, section: Section) {
    if let Some((_, problem)) = w.error.as_ref().filter(|(s, _)| *s == section) {
        ui.add_space(2.0);
        ui.add(egui::Label::new(RichText::new(problem).size(12.5).color(DANGER_TEXT())).wrap());
    }
}

/// The role lists' width
const ROLE_WIDTH: f32 = 84.0;

/// Viewer or Editor, as a short list `height` high, drawn as the app's secondary buttons are.
fn role_choice(ui: &mut egui::Ui, id: impl std::hash::Hash, role: &mut Role, height: f32) {
    ui.scope(|ui| {
        ui.spacing_mut().interact_size.y = height;
        ui.spacing_mut().button_padding = Vec2::new(10.0, 4.0);
        let widgets = &mut ui.visuals_mut().widgets;
        for (state, fill) in [
            (&mut widgets.inactive, BG_CARD()),
            (&mut widgets.hovered, BG_CARD_ALT()),
            (&mut widgets.active, BG_CARD_ALT()),
            (&mut widgets.open, BG_CARD_ALT()),
        ] {
            state.weak_bg_fill = fill;
            state.bg_stroke = Stroke::new(1.0_f32, BORDER_NORM());
            state.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY());
            state.corner_radius = CornerRadius::same(8);
            state.expansion = 0.0;
        }
        let shown = egui::ComboBox::from_id_salt(id).selected_text(role.label()).width(ROLE_WIDTH).show_ui(ui, |ui| {
            for choice in [Role::Viewer, Role::Editor] {
                ui.selectable_value(role, choice, choice.label());
            }
        });
        crate::focus_ring(ui, &shown.response, 8.0);
    });
}

/// Everything above Done: the link, inviting people and who has access, or why they can't be shown.
fn share_body(w: &mut ShareWindow, ui: &mut egui::Ui, owner: &str, now: i64, actions: &mut Vec<Action>) {
    let title = format!("Share \"{}\"", w.name);
    elided(ui, RichText::new(&title).size(17.0).strong().color(TEXT_PRIMARY()), &title);
    let place = if w.rel_path.is_empty() { w.abs_path.clone() } else { w.rel_path.clone() };
    elided(ui, RichText::new(&place).size(12.0).color(TEXT_MUTED()), &place);
    ui.add_space(12.0);

    let info = match w.info.clone() {
        None => {
            ui.label(RichText::new("Loading…").size(13.0).color(TEXT_MUTED()));
            return;
        }
        Some(Err(problem)) => {
            ui.add(egui::Label::new(RichText::new(problem).size(13.0).color(DANGER_TEXT())).wrap());
            if !w.rel_path.is_empty() {
                ui.add_space(10.0);
                if ui.add_enabled_ui(!w.loading, |ui| secondary_button(ui, "Try again", 30.0)).inner.clicked() {
                    actions.push(Action::Retry);
                }
            }
            return;
        }
        Some(Ok(info)) => info,
    };
    ui.add_enabled_ui(!w.working(), |ui| {
        link_section(w, ui, info.link.as_ref(), now, actions);
        ui.add_space(12.0);
        ui.separator();
        ui.add_space(8.0);
        invite_section(w, ui, actions);
        ui.add_space(12.0);
        ui.separator();
        ui.add_space(8.0);
        people_section(w, ui, &info.people, owner, actions);
    });
}

/// The switch, the link and Copy link, its password and its expiry.
fn link_section(w: &mut ShareWindow, ui: &mut egui::Ui, link: Option<&ShareLink>, now: i64, actions: &mut Vec<Action>) {
    let on = link.is_some();
    ui.horizontal(|ui| {
        section_title(ui, "Link");
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let switch = toggle_switch(ui, on);
            // The word beside the switch flips it on click, without creating a duplicate Tab stop (#360)
            let word = ui
                .add(egui::Label::new(RichText::new(if on { "On" } else { "Off" }).size(13.0).color(TEXT_MUTED())).sense(Sense::CLICK))
                .on_hover_cursor(egui::CursorIcon::PointingHand);
            if switch.clicked() || word.clicked() {
                actions.push(if on { Action::AskLinkOff } else { Action::LinkOn });
            }
        });
    });
    let Some(link) = link else {
        muted(ui, format!("Turn it on to make a link anyone can use to view {}.", w.name));
        error_line(ui, w, Section::Link);
        return;
    };
    let (expiry, expired) = expiry_text(link.expires_at, now, home::local_offset_secs);
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        let label = if w.copied && !expired { "Copied" } else { "Copy link" };
        let copy_w = action_button_width(ui, Some(icons::COPY), "Copy link").max(action_button_width(ui, Some(icons::COPY), "Copied"));
        let field_w = (ui.available_width() - copy_w - ui.spacing().item_spacing.x).max(120.0);
        Frame::NONE
            .fill(BG_INPUT())
            .stroke(Stroke::new(1.0_f32, BORDER_SUBTLE()))
            .corner_radius(CornerRadius::same(8))
            .inner_margin(Margin::symmetric(10, 8))
            .show(ui, |ui| {
                ui.set_width(field_w - 22.0);
                elided(ui, RichText::new(&link.url).size(12.5).color(TEXT_PRIMARY()), &link.url);
            });
        // An expired link leads nowhere: it isn't copied (an older link, without its password in the URL, still is)
        let copy = ui.add_enabled_ui(!expired, |ui| {
            action_button_sized(ui, ButtonKind::Primary, Some(icons::COPY), label, Vec2::new(copy_w, 34.0))
        });
        if copy.inner.clicked() {
            ui.ctx().copy_text(link.url.clone());
            w.copied = true;
        }
    });
    let can = if link.role == Role::Editor { "edit" } else { "view" };
    muted(
        ui,
        if expired {
            LINK_EXPIRED.to_string()
        } else if link.has_password {
            format!("Anyone with the link and the password can {can}.")
        } else {
            format!("Anyone with the link can {can}.")
        },
    );
    ui.add_space(6.0);

    ui.horizontal(|ui| {
        field_label(ui, "Password");
        if link.has_password {
            let (text, shown) = match &w.password {
                PasswordView::Shown(password) => (RichText::new(password.as_str()).monospace(), true),
                PasswordView::Loading => (RichText::new("Loading…"), false),
                PasswordView::Hidden | PasswordView::CantShow => (RichText::new("••••••••"), false),
            };
            ui.label(text.size(13.0).color(TEXT_PRIMARY()));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if action_button_named(ui, ButtonKind::Secondary, None, "Remove", "Remove password", 28.0).clicked() {
                    actions.push(Action::RemovePassword);
                }
                if action_button_named(ui, ButtonKind::Secondary, None, "Change", "Change password", 28.0).clicked() {
                    actions.push(Action::EditPassword);
                }
                let loading = w.password == PasswordView::Loading;
                let (vis, acc) = if shown { ("Hide", "Hide password") } else { ("Show", "Show password") };
                let show = ui
                    .add_enabled_ui(!loading, |ui| action_button_named(ui, ButtonKind::Secondary, None, vis, acc, 28.0))
                    .inner;
                if show.clicked() {
                    actions.push(if shown { Action::HidePassword } else { Action::ShowPassword });
                }
            });
        } else {
            ui.label(RichText::new("None").size(13.0).color(TEXT_MUTED()));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if secondary_button(ui, "Set password", 28.0).clicked() {
                    actions.push(Action::EditPassword);
                }
            });
        }
    });
    if link.has_password && w.password == PasswordView::CantShow {
        ui.horizontal(|ui| {
            field_label(ui, "");
            muted(ui, CANT_SHOW_PASSWORD);
        });
    }
    if let Some(typed) = w.password_editor.as_mut() {
        ui.horizontal(|ui| {
            field_label(ui, "");
            let buttons = button_width(ui, "Save") + button_width(ui, "Cancel") + 2.0 * ui.spacing().item_spacing.x;
            let field = input_field(ui, "New password", |ui| {
                ui.add_sized(
                    [(ui.available_width() - buttons).max(100.0), ROW_HEIGHT],
                    egui::TextEdit::singleline(typed).password(true).hint_text("New password").vertical_align(Align::Center),
                )
            });
            if std::mem::take(&mut w.focus_field) {
                field.request_focus();
            }
            let entered = field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            if action_button_named(ui, ButtonKind::Primary, None, "Save", "Save password", ROW_HEIGHT).clicked() || entered {
                actions.push(Action::SavePassword);
            }
            if action_button_named(ui, ButtonKind::Secondary, None, "Cancel", "Cancel password", ROW_HEIGHT).clicked() {
                actions.push(Action::CancelPassword);
            }
        });
    }

    ui.horizontal(|ui| {
        field_label(ui, "Expires");
        let color = if expired {
            DANGER_TEXT()
        } else if link.expires_at.is_none() {
            TEXT_MUTED()
        } else {
            TEXT_PRIMARY()
        };
        ui.label(RichText::new(expiry).size(13.0).color(color));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if link.expires_at.is_some() {
                if action_button_named(ui, ButtonKind::Secondary, None, "Remove", "Remove expiry", 28.0).clicked() {
                    actions.push(Action::RemoveExpiry);
                }
                if action_button_named(ui, ButtonKind::Secondary, None, "Change", "Change expiry", 28.0).clicked() {
                    actions.push(Action::EditExpiry);
                }
            } else if action_button_named(ui, ButtonKind::Secondary, None, "Set date…", "Set expiry date…", 28.0).clicked() {
                actions.push(Action::EditExpiry);
            }
        });
    });
    if let Some(date) = w.expiry_editor.as_mut() {
        ui.horizontal(|ui| {
            field_label(ui, "");
            for (label, days) in [("1 day", 1), ("7 days", 7), ("30 days", 30)] {
                if secondary_button(ui, label, 28.0).clicked() {
                    actions.push(Action::PresetExpiry(days));
                }
            }
        });
        ui.horizontal(|ui| {
            field_label(ui, "");
            let field = input_field(ui, "Expiry date", |ui| {
                ui.add_sized(
                    [118.0, ROW_HEIGHT],
                    egui::TextEdit::singleline(date).hint_text("YYYY-MM-DD").vertical_align(Align::Center),
                )
            });
            let entered = field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            if action_button_named(ui, ButtonKind::Primary, None, "Set", "Set expiry date", ROW_HEIGHT).clicked() || entered {
                actions.push(Action::SaveExpiry);
            }
            if action_button_named(ui, ButtonKind::Secondary, None, "Cancel", "Cancel expiry", ROW_HEIGHT).clicked() {
                actions.push(Action::CancelExpiry);
            }
        });
        ui.horizontal(|ui| {
            field_label(ui, "");
            muted(ui, "The link stops working at the end of that day.");
        });
    }
    error_line(ui, w, Section::Link);
}

/// Addresses, the role they get, and Invite.
fn invite_section(w: &mut ShareWindow, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
    section_title(ui, "Invite people");
    ui.horizontal(|ui| {
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let invite = action_button(ui, ButtonKind::Primary, Some(icons::PEOPLE), "Invite", 32.0).clicked();
            role_choice(ui, "share_invite_role", &mut w.invite_role, 32.0);
            let field = input_field(ui, "Invite people", |ui| {
                ui.add_sized(
                    [ui.available_width().max(140.0), 32.0],
                    egui::TextEdit::singleline(&mut w.invite_input).hint_text("email@example.com, …").vertical_align(Align::Center),
                )
            });
            let entered = field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            if invite || entered {
                actions.push(Action::Invite);
            }
        });
    });
    muted(ui, "Separate addresses with commas or spaces.");
    error_line(ui, w, Section::Invite);
}

/// You, then everyone with access or invited, each with their role and ×.
fn people_section(w: &mut ShareWindow, ui: &mut egui::Ui, people: &[SharePerson], owner: &str, actions: &mut Vec<Action>) {
    section_title(ui, "Who has access");
    ui.add_space(2.0);
    ui.horizontal(|ui| {
        ui.set_min_height(ROW_HEIGHT);
        ui.label(RichText::new("You").size(13.5).color(TEXT_PRIMARY()));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new("Owner").size(13.0).color(TEXT_MUTED()));
            if !owner.is_empty() {
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    elided(ui, RichText::new(owner).size(12.5).color(TEXT_MUTED()), owner);
                });
            }
        });
    });
    for person in people {
        ui.horizontal(|ui| {
            ui.set_min_height(PERSON_ROW_HEIGHT);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                // Named, and saying on hover, whom it removes
                let remove = icon_button(ui, icons::REMOVE, &format!("Remove {}", person.email));
                if remove.clicked() {
                    actions.push(Action::AskRemove(person.email.clone()));
                }
                let mut role = person.role;
                role_choice(ui, ("share_role", &person.email), &mut role, 28.0);
                if role != person.role {
                    actions.push(Action::SetRole(person.email.clone(), role));
                }
                let state = match person.state {
                    PersonState::Member => None,
                    PersonState::Invited => Some("Invited"),
                    PersonState::InvitedNotProton => Some("Invited by email: no Proton account yet"),
                };
                let size = Vec2::new(ui.available_width(), PERSON_ROW_HEIGHT);
                ui.allocate_ui_with_layout(size, Layout::top_down(Align::Min), |ui| {
                    // About 17 points for the address and 14 for the line under it: centred on the row
                    ui.spacing_mut().item_spacing.y = 1.0;
                    ui.add_space(if state.is_some() { 2.0 } else { 9.5 });
                    elided(ui, RichText::new(&person.email).size(13.5).color(TEXT_PRIMARY()), &person.email);
                    if let Some(state) = state {
                        elided(ui, RichText::new(state).size(11.5).color(TEXT_MUTED()), state);
                    }
                });
            });
        });
    }
    if people.is_empty() {
        muted(ui, "No one else has access.");
    }
    error_line(ui, w, Section::People);
}

#[cfg(test)]
mod tests {
    use super::*;

    const CET: i64 = 3600;
    /// 2026-11-04 (a Wednesday) at 00:00 UTC, in epoch ms
    const NOV_4_UTC: i64 = 1_793_750_400_000;
    const NOV_4: i64 = NOV_4_UTC / 86_400_000;

    /// Epoch ms of `days` after 2026-11-04 at hh:mm:ss, local time `offset` seconds east of UTC.
    fn local(days: i64, hh: i64, mm: i64, ss: i64, offset: i64) -> i64 {
        NOV_4_UTC + days * 86_400_000 + (hh * 3600 + mm * 60 + ss - offset) * 1000
    }

    #[test]
    fn share_info_parses_the_daemons_answer() {
        let json = r#"{
            "link": { "url": "https://drive.proton.me/urls/ABCDEF#abcdefghijkl", "hasPassword": true, "expiresAt": 1800000000000, "role": "viewer" },
            "people": [
                { "email": "alex@proton.me", "role": "editor", "state": "member" },
                { "email": "sam@proton.me", "role": "viewer", "state": "invited" },
                { "email": "jo@example.com", "role": "viewer", "state": "invited-not-proton" }
            ]
        }"#;
        let info: ShareInfo = serde_json::from_str(json).unwrap();
        assert_eq!(
            info.link,
            Some(ShareLink {
                url: "https://drive.proton.me/urls/ABCDEF#abcdefghijkl".into(),
                has_password: true,
                expires_at: Some(1_800_000_000_000),
                role: Role::Viewer,
            })
        );
        let people: Vec<(&str, Role, PersonState)> = info.people.iter().map(|p| (p.email.as_str(), p.role, p.state)).collect();
        assert_eq!(
            people,
            vec![
                ("alex@proton.me", Role::Editor, PersonState::Member),
                ("sam@proton.me", Role::Viewer, PersonState::Invited),
                ("jo@example.com", Role::Viewer, PersonState::InvitedNotProton),
            ]
        );

        // No link, no one, and a link that never expires
        let none: ShareInfo = serde_json::from_str(r#"{ "link": null, "people": [] }"#).unwrap();
        assert_eq!(none, ShareInfo::default());
        let never: ShareInfo =
            serde_json::from_str(r#"{ "link": { "url": "u", "hasPassword": false, "expiresAt": null, "role": "editor" }, "people": [] }"#)
                .unwrap();
        assert_eq!(never.link.as_ref().map(|l| (l.expires_at, l.role)), Some((None, Role::Editor)));
        assert_eq!(Role::Editor.as_str(), "editor");
        assert_eq!(Role::Viewer.as_str(), "viewer");
        assert_eq!(Role::Viewer.label(), "Viewer");
    }

    #[test]
    fn parse_emails_splits_on_commas_and_spaces_and_checks_each() {
        assert_eq!(
            parse_emails("a@b.co, c@d.org e@f.io"),
            Ok(vec!["a@b.co".to_string(), "c@d.org".to_string(), "e@f.io".to_string()])
        );
        assert_eq!(parse_emails("a@b.co, nope"), Err("Not a valid email address: nope".to_string()));
        // Pasted lists: semicolons, new lines, doubled separators, and the same address twice in any case
        assert_eq!(
            parse_emails(" a@b.co;\n c@d.org,, A@B.co "),
            Ok(vec!["a@b.co".to_string(), "c@d.org".to_string()])
        );
        // As the daemon checks them: something@something.something, with no space or second @
        for bad in ["a@b", "@b.co", "a@.co", "a@b.", "a@@b.co", "a@b@c.co"] {
            assert_eq!(parse_emails(bad), Err(format!("Not a valid email address: {bad}")), "{bad}");
        }
        assert_eq!(parse_emails("  , "), Err("Type the email address of someone to invite".to_string()));
        let many: Vec<String> = (0..51).map(|i| format!("p{i}@example.com")).collect();
        assert_eq!(parse_emails(&many.join(" ")), Err("Invite at most 50 people at a time".to_string()));
        assert_eq!(parse_emails(&many[..50].join(" ")).map(|l| l.len()), Ok(50));
    }

    #[test]
    fn rel_path_is_the_path_inside_the_sync_folder() {
        let dir = "/home/u/ProtonDrive";
        assert_eq!(rel_path_in(dir, "/home/u/ProtonDrive/Docs/report.pdf").as_deref(), Some("Docs/report.pdf"));
        assert_eq!(rel_path_in("/home/u/ProtonDrive/", "/home/u/ProtonDrive/a b.txt").as_deref(), Some("a b.txt"));
        assert_eq!(rel_path_in(dir, "/home/u/ProtonDrive/Docs/").as_deref(), Some("Docs"));
        // The folder itself, a folder whose name only starts the same, and anything outside aren't in Proton Drive
        assert_eq!(rel_path_in(dir, "/home/u/ProtonDrive"), None);
        assert_eq!(rel_path_in(dir, "/home/u/ProtonDrive/"), None);
        assert_eq!(rel_path_in(dir, "/home/u/ProtonDrive2/a.txt"), None);
        assert_eq!(rel_path_in(dir, "/home/u/Documents/a.txt"), None);
        // Nor anything while the folder isn't known
        assert_eq!(rel_path_in("", "/home/u/ProtonDrive/a.txt"), None);
    }

    #[test]
    fn an_expiry_date_ends_at_the_end_of_that_day_local_time() {
        let off = |_| CET;
        assert_eq!(parse_date("2026-11-04"), Some(NOV_4));
        assert_eq!(parse_date(" 2026-12-01 "), Some(NOV_4 + 27));
        assert_eq!(parse_date("2028-02-29"), Some(NOV_4 + 482));
        for bad in ["", "2026-13-01", "2026-02-29", "2026-11-31", "2026-00-10", "26-12-01", "2026/12/01", "2026-1-5", "tomorrow"] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
        assert_eq!(date_text(NOV_4 + 27), "2026-12-01");
        assert_eq!(date_text(NOV_4 + 482), "2028-02-29");

        // 23:59:59 that day, by the local clock, whichever side of UTC
        assert_eq!(end_of_day(NOV_4 + 27, off), local(27, 23, 59, 59, CET));
        assert_eq!(end_of_day(NOV_4 + 27, |_| -5 * 3600), local(27, 23, 59, 59, -5 * 3600));
        // By the offset that holds then, across a clock change that day (+2 h until 03:00, +1 h after)
        let change = local(27, 3, 0, 0, 2 * 3600);
        let dst = move |ms: i64| if ms < change { 2 * 3600 } else { CET };
        assert_eq!(end_of_day(NOV_4 + 27, dst), local(27, 23, 59, 59, CET));

        let now = local(0, 10, 30, 0, CET);
        assert_eq!(expiry_from_date("2026-12-01", now, off), Ok(local(27, 23, 59, 59, CET)));
        // Today is a day too: it ends tonight
        assert_eq!(expiry_from_date("2026-11-04", now, off), Ok(local(0, 23, 59, 59, CET)));
        // By the local date: at 00:30 CET on the 4th, UTC still says the 3rd, which has passed here
        let just_after_midnight = local(0, 0, 30, 0, CET);
        assert_eq!(
            expiry_from_date("2026-11-03", just_after_midnight, off),
            Err("That day has passed: pick today or a later day".to_string())
        );
        assert_eq!(expiry_from_date("4 Dec", now, off), Err("Type the date as YYYY-MM-DD".to_string()));
        // Within 10 years, as the daemon takes it
        assert!(expiry_from_date("2036-11-03", now, off).is_ok());
        assert_eq!(expiry_from_date("2036-11-04", now, off), Err("Pick a day within 10 years".to_string()));
    }

    #[test]
    fn the_settings_body_carries_only_what_changes() {
        assert_eq!(
            settings_body("Docs/a.pdf", Some(Some("s3cret")), None),
            serde_json::json!({ "path": "Docs/a.pdf", "password": "s3cret" })
        );
        assert_eq!(
            settings_body("Docs/a.pdf", Some(None), None),
            serde_json::json!({ "path": "Docs/a.pdf", "password": null })
        );
        assert_eq!(
            settings_body("a.pdf", None, Some(Some(1_800_000_000_000))),
            serde_json::json!({ "path": "a.pdf", "expiresAt": 1_800_000_000_000_i64 })
        );
        assert_eq!(settings_body("a.pdf", None, Some(None)), serde_json::json!({ "path": "a.pdf", "expiresAt": null }));
    }
}
