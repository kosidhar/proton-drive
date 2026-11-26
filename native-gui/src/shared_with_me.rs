//! The Shared with me page's model, wording and requests (#487): what other people shared with the account, from the
//! daemon's `GET /share/with-me`, and the answers to an invitation, leaving, opening on the web and downloading. All of
//! it goes through the daemon's `/share/with-me` routes on the control socket, off the UI thread. Nothing here logs an
//! address or a name.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use eframe::egui;
use serde::Deserialize;

use crate::share::{self, SHARE_READ_TIMEOUT, SHARE_WRITE_TIMEOUT, UNREADABLE};

/// What an item is, as the daemon gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Folder,
    Doc,
    Sheet,
    /// A kind this app doesn't know (a newer daemon's): shown as a file, with Open only
    #[serde(other)]
    Other,
}

/// What the account may do with an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Admin,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Viewer => "Viewer",
            Role::Editor => "Editor",
            Role::Admin => "Admin",
        }
    }
}

/// An invitation waiting for an answer.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub invitation_uid: String,
    /// The uid of the item it shares: the item it is listed as once accepted
    pub node_uid: String,
    /// None when the name can't be decrypted
    pub name: Option<String>,
    pub kind: Kind,
    /// The sender's address; when it isn't verified, the one the invitation claims (None when it claims none)
    pub from: Option<String>,
    pub from_verified: bool,
    pub role: Role,
    /// Epoch ms
    pub invited_at: i64,
}

/// An item already shared with the account.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub uid: String,
    pub name: Option<String>,
    pub kind: Kind,
    pub shared_by: Option<String>,
    pub shared_by_verified: bool,
    /// Epoch ms; None when Proton doesn't say
    pub shared_at: Option<i64>,
    pub role: Role,
    /// Only an item shared with the account directly can be left
    pub can_leave: bool,
    /// Why the item can't be read, in words to show as is: its row offers only Open
    #[serde(default)]
    pub unreadable: Option<String>,
}

/// What GET /share/with-me gives.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Listing {
    pub invitations: Vec<Invitation>,
    pub items: Vec<Item>,
}

impl Listing {
    pub fn is_empty(&self) -> bool {
        self.invitations.is_empty() && self.items.is_empty()
    }

    /// The items in the page's order: newest shared first, those with no date after the dated ones, then by name.
    fn sorted(mut self) -> Self {
        self.items.sort_by(|a, b| {
            b.shared_at
                .is_some()
                .cmp(&a.shared_at.is_some())
                .then(b.shared_at.cmp(&a.shared_at))
                .then_with(|| display_name(&a.name).to_lowercase().cmp(&display_name(&b.name).to_lowercase()))
                .then_with(|| a.uid.cmp(&b.uid))
        });
        self
    }
}

pub const TITLE: &str = "Shared with me";
pub const INVITATIONS: &str = "Invitations";
pub const EMPTY: &str = "Files and folders that others shared with you will appear here";
pub const WEB_NOTE: &str = "Saved links and shared photos are on drive.proton.me";
/// Where Open goes when the daemon has no address for the item
pub const WEB_URL: &str = "https://drive.proton.me/shared-with-me";
pub const DOWNLOADING: &str = "Downloading…";
pub const SAVED: &str = "Saved to Downloads";
pub const ACCEPTED: &str = "Accepted, it will appear shortly";
/// A download that outlasted `DOWNLOAD_TIMEOUT`: the daemon is still at it, so its row stays busy until the list is read
/// again (a second Download would fetch it twice)
pub const STILL_DOWNLOADING: &str = "Still downloading: it will be in Downloads";
/// How long the app waits for a download: a big file over a slow line takes hours
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(6 * 3600);
/// How long after an accept the page reads once more
pub const RELOAD_AFTER_ACCEPT_SECS: u64 = 5;
pub const LOADING: &str = "Loading what others shared with you…";
const LIST_TIMED_OUT: &str = "Listing what others shared with you took too long. Try again.";

/// What an item without a readable name is called.
pub fn display_name(name: &Option<String>) -> String {
    name.as_deref().filter(|n| !n.is_empty()).unwrap_or("An item").to_string()
}

/// The question before accepting an invitation the sender of which Proton couldn't verify; None for a verified one.
pub fn accept_question(inv: &Invitation) -> Option<String> {
    if inv.from_verified {
        return None;
    }
    Some(match inv.from.as_deref().filter(|f| !f.is_empty()) {
        Some(email) => format!("Proton couldn't verify that this invitation is from {email}. Accept it only if you expected it."),
        None => "Proton couldn't verify who sent this invitation. Accept it only if you expected it.".to_string(),
    })
}

/// The title of the question before accepting from an unverified sender: what it is an invitation to.
pub fn accept_title(inv: &Invitation) -> String {
    format!("Accept the invitation to {}?", display_name(&inv.name))
}

/// The question before leaving an item.
pub fn leave_question(item: &Item) -> String {
    format!(
        "Leave {}? It will no longer be shared with you. Only the person who shared it can share it again.",
        display_name(&item.name)
    )
}

/// An invitation that was accepted, whose item the list may not show yet (Proton's list can lag). Known in the list by
/// its item's uid: two items can share a name and kind, and one that can't be read has none.
#[derive(Clone, Debug, PartialEq)]
pub struct Accepted {
    pub node_uid: String,
    pub name: Option<String>,
    pub kind: Kind,
}

/// The page: the listing, and what is going on in its rows. Each read has a number; only the newest one's answer counts.
#[derive(Default)]
pub struct SharedWithMePage {
    pub listing: Option<Listing>,
    pub loading: bool,
    pub error: Option<String>,
    /// The number of the newest read
    pub seq: u64,
    /// Set when something may have changed while a read was running, so entering the page starts a fresh read
    pub stale: bool,
    /// Set when Refresh or Retry was pressed from the keyboard: the read that shows when it ends takes the focus back
    pub refocus: bool,
    /// The uids (an invitation's or an item's) whose action waits for the daemon's answer
    pub working: HashSet<String>,
    /// A line under a row (`DOWNLOADING`, `STILL_DOWNLOADING`, `SAVED`), by uid
    pub notes: HashMap<String, String>,
    /// Why an action on a row failed, by uid, until the list is read again
    pub row_errors: HashMap<String, String>,
    /// What each invitation being accepted is, by its uid, until the daemon answers
    pub accepting: HashMap<String, Accepted>,
    /// Accepted invitations whose item the list doesn't show yet: each says `ACCEPTED` until it does
    pub accepted: Vec<Accepted>,
    /// An accept went through and the read it caused hasn't answered yet: if it still lacks an item, one more read follows
    pub retry_armed: bool,
    /// When that one more read goes out
    pub reload_at: Option<Instant>,
    /// Where each downloaded item was saved, by uid, for Show in Files
    pub saved: HashMap<String, String>,
    /// The items whose download outlasted the app's wait: their rows stay busy, saying `STILL_DOWNLOADING`, until the
    /// next read of the list
    pub outlasted: HashSet<String>,
    /// The ⋯ menu that is open: the uid of its item, and the button it hangs from
    pub menu: Option<(String, egui::Rect)>,
}

impl SharedWithMePage {
    /// A download outlasted the app's wait: the daemon goes on with it, so it isn't a failure, and its row stays busy.
    pub fn still_downloading(&mut self, uid: &str) {
        self.notes.insert(uid.to_string(), STILL_DOWNLOADING.to_string());
        self.outlasted.insert(uid.to_string());
    }

    pub fn has_rows(&self) -> bool {
        self.listing.as_ref().is_some_and(|l| !l.is_empty())
    }

    /// A read goes out: the rows shown stay until it answers. Why their last actions failed goes (a failure that comes
    /// while it is out stays), and a download that outlasted the wait frees its row. Returns its number.
    pub fn begin_load(&mut self) -> u64 {
        self.seq += 1;
        self.loading = true;
        self.stale = false;
        self.error = None;
        self.row_errors.clear();
        for uid in std::mem::take(&mut self.outlasted) {
            self.working.remove(&uid);
            self.notes.remove(&uid);
        }
        self.seq
    }

    /// A read answered. One that isn't the newest is ignored. A failure drops the listing: it can't be known to be current.
    pub fn loaded(&mut self, seq: u64, result: Result<Listing, String>) {
        if seq != self.seq {
            return;
        }
        self.loading = false;
        self.stale = false;
        match result {
            Ok(listing) => {
                self.listing = Some(listing);
                self.error = None;
                self.settle_accepted();
            }
            Err(message) => {
                self.listing = None;
                self.error = Some(message);
            }
        }
    }

    /// After a read: an accepted invitation whose item is listed now needs no note. One that isn't gets one more read,
    /// `RELOAD_AFTER_ACCEPT_SECS` after the first that lacked it.
    fn settle_accepted(&mut self) {
        let Some(listing) = &self.listing else { return };
        self.accepted.retain(|a| !listing.items.iter().any(|i| i.uid == a.node_uid));
        if self.accepted.is_empty() {
            self.retry_armed = false;
            self.reload_at = None;
        } else if self.retry_armed {
            self.retry_armed = false;
            self.reload_at = Some(Instant::now() + Duration::from_secs(RELOAD_AFTER_ACCEPT_SECS));
        }
    }

    /// Screenshot-only: sets the page as `--fake-shared-with-me <state>` shows it; loading is a first read still out,
    /// refreshing a listing answered and read again. False for an unknown state.
    pub fn fake(&mut self, state: &str, now_ms: i64) -> bool {
        match state {
            "loading" => {
                self.begin_load();
            }
            "refreshing" => {
                self.fake("list", now_ms);
                self.begin_load();
            }
            _ => {
                let Some(result) = fake_shared_with_me(state, now_ms) else { return false };
                let seq = self.begin_load();
                self.loaded(seq, result);
            }
        }
        true
    }
}

fn decode<T: serde::de::DeserializeOwned>(reply: serde_json::Value) -> Result<T, String> {
    // Not serde's message: it can quote what it couldn't read, addresses among them
    serde_json::from_value(reply).map_err(|_| UNREADABLE.to_string())
}

/// Everything shared with the account (GET /share/with-me).
pub fn list_at(socket: &Path) -> Result<Listing, String> {
    let reply = share::share_request_with_timeout_message(socket, "GET", "/share/with-me", None, SHARE_WRITE_TIMEOUT, LIST_TIMED_OUT)?;
    decode::<Listing>(reply).map(Listing::sorted)
}

fn change(socket: &Path, route: &str, body: serde_json::Value) -> Result<(), String> {
    share::share_request(socket, "POST", route, Some(&body), SHARE_WRITE_TIMEOUT).map(|_| ())
}

pub fn accept_at(socket: &Path, invitation_uid: &str) -> Result<(), String> {
    change(socket, "/share/with-me/accept", serde_json::json!({ "invitationUid": invitation_uid }))
}

pub fn decline_at(socket: &Path, invitation_uid: &str) -> Result<(), String> {
    change(socket, "/share/with-me/decline", serde_json::json!({ "invitationUid": invitation_uid }))
}

pub fn leave_at(socket: &Path, uid: &str) -> Result<(), String> {
    change(socket, "/share/with-me/leave", serde_json::json!({ "uid": uid }))
}

/// The address to open an item at on the web.
pub fn open_url_at(socket: &Path, uid: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Reply {
        url: String,
    }
    let body = serde_json::json!({ "uid": uid });
    let reply = share::share_request(socket, "POST", "/share/with-me/open-url", Some(&body), SHARE_READ_TIMEOUT)?;
    decode::<Reply>(reply).map(|r| r.url)
}

/// Downloads a file to the Downloads folder; the path it was saved at. A big file takes minutes, or hours: after
/// `DOWNLOAD_TIMEOUT` it is `STILL_DOWNLOADING`.
pub fn download_at(socket: &Path, uid: &str) -> Result<String, String> {
    download_at_with_timeout(socket, uid, DOWNLOAD_TIMEOUT)
}

fn download_at_with_timeout(socket: &Path, uid: &str, timeout: Duration) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Reply {
        path: String,
    }
    let body = serde_json::json!({ "uid": uid });
    let reply = share::share_request_with_timeout_message(socket, "POST", "/share/with-me/download", Some(&body), timeout, STILL_DOWNLOADING)?;
    decode::<Reply>(reply).map(|r| r.path)
}

/// Screenshot-only: `--fake-shared-with-me <state>`: the rows ("list"), none ("empty"), the daemon not answering
/// ("offline") or invitations with and without a verified sender ("invitations"); None for an unknown state.
pub fn fake_shared_with_me(state: &str, now_ms: i64) -> Option<Result<Listing, String>> {
    const DAY: i64 = 86_400_000;
    let invitation = |uid: &str, name: Option<&str>, kind, from: Option<&str>, from_verified, role| Invitation {
        invitation_uid: format!("fake~{uid}"),
        node_uid: format!("fake~{uid}~item"),
        name: name.map(String::from),
        kind,
        from: from.map(String::from),
        from_verified,
        role,
        invited_at: now_ms - DAY,
    };
    let item = |name: Option<&str>, kind, by: Option<&str>, days_ago: Option<i64>, role, can_leave| Item {
        uid: format!("fake~{}", name.unwrap_or("unreadable")),
        name: name.map(String::from),
        kind,
        shared_by: by.map(String::from),
        shared_by_verified: by.is_some(),
        shared_at: days_ago.map(|d| now_ms - d * DAY),
        role,
        can_leave,
        unreadable: None,
    };
    let invitations = vec![
        invitation("Trip photos", Some("Trip photos"), Kind::Folder, Some("sam@example.com"), true, Role::Viewer),
        invitation("Contract.pdf", Some("Contract.pdf"), Kind::File, Some("lee@example.com"), false, Role::Editor),
        invitation("hidden", None, Kind::File, None, false, Role::Viewer),
    ];
    Some(match state {
        "list" => {
            let mut unreadable = item(None, Kind::File, None, None, Role::Viewer, false);
            unreadable.unreadable = Some("Proton Drive couldn't load this item".into());
            Ok(Listing {
                invitations: vec![],
                items: vec![
                    item(Some("Budget.xlsx"), Kind::Sheet, Some("sam@example.com"), Some(2), Role::Editor, true),
                    item(Some("Design review"), Kind::Doc, Some("lee@example.com"), Some(9), Role::Viewer, true),
                    item(Some("Team photos"), Kind::Folder, Some("sam@example.com"), Some(30), Role::Admin, false),
                    item(Some("report.pdf"), Kind::File, Some("kim@example.com"), None, Role::Viewer, true),
                    unreadable,
                ],
            })
        }
        "empty" => Ok(Listing::default()),
        "offline" => Err(share::DAEMON_UNREACHABLE.to_string()),
        // The README's page: a healthy account, with the items Activity names (no unreadable row)
        "readme" => Ok(Listing {
            invitations: vec![invitation("Garden plans", Some("Garden plans"), Kind::Folder, Some("kim@example.com"), true, Role::Viewer)],
            items: vec![
                item(Some("Trip budget"), Kind::Sheet, Some("sam@example.com"), Some(1), Role::Editor, true),
                item(Some("Design review"), Kind::Doc, Some("lee@example.com"), Some(9), Role::Viewer, true),
                item(Some("Team photos"), Kind::Folder, Some("kim@example.com"), Some(30), Role::Viewer, true),
            ],
        }),
        "invitations" => Ok(Listing {
            invitations,
            items: vec![item(Some("Budget.xlsx"), Kind::Sheet, Some("sam@example.com"), Some(2), Role::Editor, true)],
        }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_readme_fake_is_healthy_and_fictional() {
        let listing = fake_shared_with_me("readme", NOW).unwrap().unwrap();
        assert!(!listing.items.is_empty());
        for i in &listing.items {
            assert!(i.unreadable.is_none() && i.name.is_some(), "an unreadable row");
            assert!(i.shared_by.as_deref().is_some_and(|a| a.ends_with("@example.com")));
        }
        for inv in &listing.invitations {
            assert!(inv.name.is_some() && inv.from_verified);
            assert!(inv.from.as_deref().is_some_and(|a| a.ends_with("@example.com")));
        }
    }

    const NOW: i64 = 1_793_750_400_000;

    fn inv(from: Option<&str>, verified: bool) -> Invitation {
        Invitation {
            invitation_uid: "v~i1".into(),
            node_uid: "v~n1".into(),
            name: Some("Trip".into()),
            kind: Kind::Folder,
            from: from.map(String::from),
            from_verified: verified,
            role: Role::Viewer,
            invited_at: NOW,
        }
    }

    fn item(name: Option<&str>, shared_at: Option<i64>) -> Item {
        Item {
            uid: format!("v~{}", name.unwrap_or("none")),
            name: name.map(String::from),
            kind: Kind::File,
            shared_by: None,
            shared_by_verified: false,
            shared_at,
            role: Role::Viewer,
            can_leave: true,
            unreadable: None,
        }
    }

    #[test]
    fn the_daemons_json_is_read_with_its_nulls() {
        let json = r#"{
          "invitations": [
            { "invitationUid": "v~i1", "nodeUid": "v~n1", "name": "Trip photos", "kind": "folder", "from": "sam@proton.me", "fromVerified": true, "role": "viewer", "invitedAt": 1793750400000 },
            { "invitationUid": "v~i2", "nodeUid": "v~n2", "name": null, "kind": "album", "from": null, "fromVerified": false, "role": "editor", "invitedAt": 1793750500000 }
          ],
          "items": [
            { "uid": "v~1", "name": "Budget", "kind": "sheet", "sharedBy": "sam@proton.me", "sharedByVerified": true, "sharedAt": 1793750400000, "role": "admin", "canLeave": true },
            { "uid": "v~2", "name": null, "kind": "file", "sharedBy": null, "sharedByVerified": false, "sharedAt": null, "role": "viewer", "canLeave": false, "unreadable": "Proton Drive couldn't load this item" },
            { "uid": "v~3", "name": "Notes", "kind": "doc", "sharedBy": null, "sharedByVerified": false, "sharedAt": null, "role": "editor", "canLeave": false },
            { "uid": "v~4", "name": "Trip", "kind": "photo-album", "sharedBy": null, "sharedByVerified": false, "sharedAt": null, "role": "viewer", "canLeave": true }
          ]
        }"#;
        let l: Listing = serde_json::from_str(json).unwrap();
        assert_eq!(l.invitations.len(), 2);
        assert_eq!(l.invitations[0].invitation_uid, "v~i1");
        assert_eq!(l.invitations[0].kind, Kind::Folder);
        assert_eq!(l.invitations[0].from.as_deref(), Some("sam@proton.me"));
        assert!(l.invitations[0].from_verified);
        assert_eq!(l.invitations[0].invited_at, 1_793_750_400_000);
        assert_eq!((l.invitations[0].node_uid.as_str(), l.invitations[1].node_uid.as_str()), ("v~n1", "v~n2"));
        // A kind the app doesn't know yet doesn't fail the page
        assert_eq!((l.invitations[1].kind, l.items[3].kind), (Kind::Other, Kind::Other));
        assert_eq!((l.invitations[1].name.clone(), l.invitations[1].from.clone()), (None, None));
        assert_eq!(l.invitations[1].role, Role::Editor);
        assert_eq!(l.items[0].kind, Kind::Sheet);
        assert_eq!(l.items[0].role, Role::Admin);
        assert_eq!(l.items[0].shared_at, Some(1_793_750_400_000));
        assert!(l.items[0].can_leave && l.items[0].shared_by_verified);
        assert_eq!((l.items[1].name.clone(), l.items[1].shared_by.clone(), l.items[1].shared_at), (None, None, None));
        assert_eq!(l.items[1].unreadable.as_deref(), Some("Proton Drive couldn't load this item"));
        assert!(!l.items[1].can_leave);
        assert_eq!(l.items[2].kind, Kind::Doc);
        assert_eq!(l.items[2].unreadable, None);
    }

    #[test]
    fn the_accept_question_asks_only_for_an_unverified_sender() {
        assert_eq!(
            accept_question(&inv(Some("lee@example.com"), false)).unwrap(),
            "Proton couldn't verify that this invitation is from lee@example.com. Accept it only if you expected it."
        );
        let without = "Proton couldn't verify who sent this invitation. Accept it only if you expected it.";
        assert_eq!(accept_question(&inv(None, false)).unwrap(), without);
        let empty = accept_question(&inv(Some(""), false)).unwrap();
        assert_eq!(empty, without);
        for text in [&empty, &accept_question(&inv(None, false)).unwrap()] {
            assert!(!text.contains("null") && !text.contains("\"\""), "{text}");
        }
        assert_eq!(accept_question(&inv(Some("sam@proton.me"), true)), None);
        assert_eq!(accept_question(&inv(None, true)), None);
    }

    #[test]
    fn the_accept_dialog_names_the_invitations_item() {
        assert_eq!(accept_title(&inv(None, false)), "Accept the invitation to Trip?");
        assert_eq!(accept_title(&Invitation { name: None, ..inv(None, false) }), "Accept the invitation to An item?");
    }

    #[test]
    fn an_accepted_invitation_is_known_by_its_items_uid_not_by_its_name() {
        let accepted = Accepted { node_uid: "v~n1".into(), name: None, kind: Kind::File };
        let mut page = SharedWithMePage { accepted: vec![accepted.clone()], ..Default::default() };
        // An unreadable item of the same kind, unnamed too, is another item
        let mut other = item(None, None);
        other.unreadable = Some("Proton Drive couldn't load this item".into());
        let seq = page.begin_load();
        page.loaded(seq, Ok(Listing { invitations: vec![], items: vec![other.clone()] }));
        assert_eq!(page.accepted, vec![accepted]);
        // Its own item, whatever its name
        let mut mine = item(Some("Trip photos"), Some(5));
        mine.uid = "v~n1".into();
        let seq = page.begin_load();
        page.loaded(seq, Ok(Listing { invitations: vec![], items: vec![other, mine] }));
        assert!(page.accepted.is_empty());
    }

    #[test]
    fn a_read_clears_why_the_rows_actions_failed() {
        let mut page = SharedWithMePage::default();
        page.row_errors.insert("v~a".into(), "Proton Drive couldn't do that. Try again.".into());
        let seq = page.begin_load();
        page.loaded(seq, Ok(Listing::default()));
        assert!(page.row_errors.is_empty());
        // One that comes while the read is out was never seen: it stays
        let seq = page.begin_load();
        page.row_errors.insert("v~b".into(), "Proton Drive couldn't do that. Try again.".into());
        page.loaded(seq, Ok(Listing::default()));
        assert_eq!(page.row_errors.keys().collect::<Vec<_>>(), ["v~b"]);
    }

    #[test]
    fn a_download_that_outlasts_the_wait_keeps_its_row_busy_until_the_next_read() {
        let mut page = SharedWithMePage::default();
        page.working.insert("v~a".into());
        page.working.insert("v~b".into());
        page.still_downloading("v~a");
        assert_eq!(page.notes.get("v~a").map(String::as_str), Some(STILL_DOWNLOADING));
        assert!(page.working.contains("v~a") && page.row_errors.is_empty());
        let seq = page.begin_load();
        page.loaded(seq, Ok(Listing::default()));
        assert!(!page.working.contains("v~a") && !page.notes.contains_key("v~a"), "the read frees the row");
        assert!(page.working.contains("v~b"), "an action still waiting for its answer keeps its row busy");
    }

    #[test]
    fn the_leave_question_is_verbatim() {
        assert_eq!(
            leave_question(&item(Some("Budget.xlsx"), None)),
            "Leave Budget.xlsx? It will no longer be shared with you. Only the person who shared it can share it again."
        );
    }

    #[test]
    fn an_unnamed_item_is_an_item() {
        assert_eq!(display_name(&None), "An item");
        assert_eq!(display_name(&Some(String::new())), "An item");
        assert_eq!(display_name(&Some("a.txt".into())), "a.txt");
    }

    #[test]
    fn roles_are_worded() {
        assert_eq!([Role::Viewer, Role::Editor, Role::Admin].map(Role::label), ["Viewer", "Editor", "Admin"]);
    }

    #[test]
    fn items_sort_dated_newest_first_then_undated_then_by_name() {
        let l = Listing {
            invitations: vec![],
            items: vec![item(Some("zed"), None), item(Some("old"), Some(1)), item(None, None), item(Some("Alpha"), None), item(Some("new"), Some(9))],
        }
        .sorted();
        let names: Vec<_> = l.items.iter().map(|i| display_name(&i.name)).collect();
        assert_eq!(names, ["new", "old", "Alpha", "An item", "zed"]);
    }

    #[test]
    fn the_fakes_cover_each_state() {
        let list = fake_shared_with_me("list", NOW).unwrap().unwrap();
        assert!(list.invitations.is_empty());
        assert!(list.items.iter().any(|i| i.unreadable.is_some() && i.name.is_none() && !i.can_leave));
        assert!(list.items.iter().any(|i| !i.can_leave && i.unreadable.is_none()));
        assert!(list.items.iter().any(|i| i.shared_at.is_none() && i.unreadable.is_none()));
        for kind in [Kind::File, Kind::Folder, Kind::Doc, Kind::Sheet] {
            assert!(list.items.iter().any(|i| i.kind == kind), "{kind:?}");
        }
        for role in [Role::Viewer, Role::Editor, Role::Admin] {
            assert!(list.items.iter().any(|i| i.role == role), "{role:?}");
        }
        assert!(fake_shared_with_me("empty", NOW).unwrap().unwrap().is_empty());
        assert_eq!(fake_shared_with_me("offline", NOW).unwrap().unwrap_err(), share::DAEMON_UNREACHABLE);
        let inv = fake_shared_with_me("invitations", NOW).unwrap().unwrap();
        assert!(inv.invitations.iter().any(|i| i.from_verified));
        assert!(inv.invitations.iter().any(|i| !i.from_verified && i.from.is_some()));
        assert!(inv.invitations.iter().any(|i| !i.from_verified && i.from.is_none() && i.name.is_none()));
        assert!(!inv.items.is_empty());
        assert!(fake_shared_with_me("nope", NOW).is_none());
    }

    #[test]
    fn the_page_keeps_the_newest_read_and_drops_the_listing_on_a_failure() {
        let mut page = SharedWithMePage::default();
        let first = page.begin_load();
        let second = page.begin_load();
        page.loaded(first, Ok(Listing::default()));
        assert!(page.loading && page.listing.is_none(), "an older read's answer is ignored");
        page.loaded(second, Ok(Listing { invitations: vec![inv(None, true)], items: vec![] }));
        assert!(!page.loading && page.has_rows());
        let third = page.begin_load();
        assert!(page.has_rows(), "the rows stay while it is read again");
        page.loaded(third, Err("offline".into()));
        assert!(page.listing.is_none() && page.error.as_deref() == Some("offline"));
        assert!(page.fake("empty", NOW) && !page.has_rows() && page.error.is_none());
        assert!(page.fake("refreshing", NOW) && page.loading && page.has_rows());
        assert!(!page.fake("nope", NOW));
    }

    /// Serves one canned HTTP reply on a fresh socket; returns the socket path and the request it saw.
    fn serve_once(name: &str, reply: &'static [u8]) -> (std::path::PathBuf, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pd-gui-swm-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = dir.join("c.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let handle = std::thread::spawn(move || {
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

    const OK_EMPTY: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";

    #[test]
    fn list_at_asks_the_route_and_sorts() {
        let body = br#"{"invitations":[],"items":[{"uid":"a","name":"b","kind":"file","sharedBy":null,"sharedByVerified":false,"sharedAt":null,"role":"viewer","canLeave":true},{"uid":"c","name":"d","kind":"file","sharedBy":null,"sharedByVerified":false,"sharedAt":5,"role":"viewer","canLeave":true}]}"#;
        let reply: &'static [u8] =
            Box::leak(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), String::from_utf8_lossy(body)).into_bytes().into_boxed_slice());
        let (sock, server) = serve_once("list", reply);
        let l = list_at(&sock).unwrap();
        assert!(server.join().unwrap().starts_with("GET /share/with-me HTTP/1.1\r\n"));
        assert_eq!(l.items.iter().map(|i| i.uid.as_str()).collect::<Vec<_>>(), ["c", "a"]);
    }

    #[test]
    fn the_changes_post_their_bodies() {
        type Call = fn(&Path, &str) -> Result<(), String>;
        let calls: [(&str, Call, &str, &str); 3] = [
            ("accept", accept_at, "/share/with-me/accept", r#"{"invitationUid":"u1"}"#),
            ("decline", decline_at, "/share/with-me/decline", r#"{"invitationUid":"u1"}"#),
            ("leave", leave_at, "/share/with-me/leave", r#"{"uid":"u1"}"#),
        ];
        for (name, call, route, body) in calls {
            let (sock, server) = serve_once(name, OK_EMPTY);
            call(&sock, "u1").unwrap();
            let request = server.join().unwrap();
            assert!(request.starts_with(&format!("POST {route} HTTP/1.1\r\n")), "{request}");
            assert!(request.ends_with(body), "{request}");
        }
    }

    #[test]
    fn open_url_and_download_read_their_answers() {
        let url: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 29\r\n\r\n{\"url\":\"https://drive.x/a/b\"}";
        let (sock, server) = serve_once("url", url);
        assert_eq!(open_url_at(&sock, "u1").unwrap(), "https://drive.x/a/b");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /share/with-me/open-url HTTP/1.1\r\n") && request.ends_with(r#"{"uid":"u1"}"#), "{request}");
        let path: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 23\r\n\r\n{\"path\":\"/d/Notes.txt\"}";
        let (sock, server) = serve_once("dl", path);
        assert_eq!(download_at(&sock, "u1").unwrap(), "/d/Notes.txt");
        assert!(server.join().unwrap().starts_with("POST /share/with-me/download HTTP/1.1\r\n"));
    }

    #[test]
    fn a_download_waits_hours_and_then_says_it_goes_on_in_the_background() {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(DOWNLOAD_TIMEOUT, Duration::from_secs(6 * 3600));
        let dir = std::env::temp_dir().join(format!("pd-gui-swm-{}-slow", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = dir.join("c.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let _ = done_rx.recv();
            drop(conn);
        });
        assert_eq!(download_at_with_timeout(&sock, "u1", Duration::from_millis(50)).unwrap_err(), STILL_DOWNLOADING);
        drop(done_tx);
        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn a_refusal_comes_back_as_the_daemon_words_it_and_junk_is_unreadable() {
        let refused: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 29\r\n\r\n{\"error\":\"Can't leave this.\"}";
        let (sock, server) = serve_once("refused", refused);
        assert_eq!(leave_at(&sock, "u1").unwrap_err(), "Can't leave this.");
        server.join().unwrap();
        let junk: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let (sock, server) = serve_once("junk", junk);
        assert_eq!(open_url_at(&sock, "u1").unwrap_err(), UNREADABLE);
        server.join().unwrap();
    }
}
