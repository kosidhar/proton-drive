//! The Shared page's model and wording: what the daemon's GET /share/list gives, and how a row says where the item is,
//! what it exposes (in words and in marks) and what stopping the sharing costs.

use serde::Deserialize;

use crate::icons;
use crate::share::{self, date_text, local_day, Role, ShareLink};

/// Where a shared item is, as the daemon words it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Place {
    MyFiles,
    Hidden,
    Elsewhere,
}

/// Whether a shared item is a file or a folder, as the daemon gives it (#282).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    File,
    Folder,
}

fn deserialize_kind<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ItemKind>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)?.as_str() {
        Some("file") => Some(ItemKind::File),
        Some("folder") => Some(ItemKind::Folder),
        _ => None,
    })
}

/// One row of the Shared page.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    /// The node uid the daemon listed: stopping sharing sends it, so it acts on this item and not on what is at its path later (#260)
    pub uid: String,
    pub name: String,
    /// File or folder from the daemon; None when an older daemon didn't say or the node couldn't be loaded (#282)
    #[serde(default, deserialize_with = "deserialize_kind")]
    pub kind: Option<ItemKind>,
    /// Where it is in the Proton Drive folder; None for an item not on this computer
    pub rel_path: Option<String>,
    #[serde(rename = "where")]
    pub place: Place,
    pub link: Option<ShareLink>,
    pub people: u32,
    /// Why its sharing can't be read now, in words to show as is
    #[serde(default)]
    pub unreadable: Option<String>,
}

pub const WEB_SHARED_URL: &str = "https://drive.proton.me/shared";
pub const LOADING: &str = "Loading what you've shared…";
/// Under the list: the daemon never asks for Photos shares (#256)
pub const PHOTOS_NOTE: &str = "Photos and albums you share from Photos may not be listed here.";
pub const PHOTOS_LINK: &str = "See them on drive.proton.me";
/// The empty page's heading, and the one line of how
pub const EMPTY_TITLE: &str = "Nothing shared yet";
pub const EMPTY_HOW: &str = "Right-click a file or folder in Files and choose Share…";
/// The empty page's lead-in to `PHOTOS_LINK`
pub const EMPTY_PHOTOS: &str = "Shared from Photos?";

/// The folder an item is in, and whether it is hidden or not here.
pub fn folder_text(item: &SharedItem) -> String {
    if item.place == Place::Elsewhere {
        return "Not on this computer".to_string();
    }
    let folder = match item.rel_path.as_deref().and_then(|p| p.rsplit_once('/')) {
        Some((folder, _)) => folder,
        None => "(top level)",
    };
    match item.place {
        Place::Hidden => format!("{folder} · Hidden from this computer"),
        _ => folder.to_string(),
    }
}

/// The Location column: the folder in My files, or where the item is instead. A hidden item's folder is in the hover
/// text (`folder_text`).
pub fn location_text(item: &SharedItem) -> String {
    match item.place {
        Place::MyFiles => folder_text(item),
        Place::Hidden => "Hidden from this computer".to_string(),
        Place::Elsewhere => "Not on this computer".to_string(),
    }
}

/// The Sharing column's marks, in order: the link (broken once expired), its password, its expiry while it is ahead,
/// and the people. An item whose sharing couldn't be read has none: the row says why instead.
pub fn sharing_marks(item: &SharedItem, now_ms: i64) -> Vec<&'static str> {
    let mut marks = Vec::new();
    if item.unreadable.is_some() {
        return marks;
    }
    if let Some(link) = &item.link {
        let expired = link.expires_at.is_some_and(|at| at <= now_ms);
        marks.push(if expired { icons::LINK_BROKEN } else { icons::LINK });
        if link.has_password {
            marks.push(icons::LOCK);
        }
        if link.expires_at.is_some() && !expired {
            marks.push(icons::CLOCK);
        }
    }
    if item.people > 0 {
        marks.push(icons::PEOPLE);
    }
    marks
}

/// The icon before an item's name: from the daemon's `kind` when given, falling back to the name only when an older
/// daemon didn't say or the node couldn't be loaded (#282).
pub fn item_icon(item: &SharedItem) -> &'static str {
    match item.kind {
        Some(ItemKind::File) => icons::FILE,
        Some(ItemKind::Folder) => icons::FOLDER,
        None => name_icon(&item.name),
    }
}

/// Fallback icon when `kind` isn't given: a name without an extension is shown as a folder.
pub fn name_icon(name: &str) -> &'static str {
    if std::path::Path::new(name).extension().is_some() {
        icons::FILE
    } else {
        icons::FOLDER
    }
}

/// What an item exposes, in one line: its link, and who else has it.
pub fn exposure_text(item: &SharedItem, now_ms: i64, offset_at: impl Fn(i64) -> i64) -> String {
    if let Some(text) = &item.unreadable {
        return text.clone();
    }
    let people = match item.people {
        0 => None,
        1 => Some("1 person".to_string()),
        n => Some(format!("{n} people")),
    };
    let Some(link) = &item.link else {
        return people.map_or_else(|| "Not shared".to_string(), |p| format!("{p} · no link"));
    };
    let expired = link.expires_at.is_some_and(|at| at <= now_ms);
    let date = |at: i64| date_text(local_day(at, &offset_at));
    let mut text = match link.expires_at {
        Some(at) if expired => format!("Link expired {}", date(at)),
        _ => "Link".to_string(),
    };
    if link.has_password {
        text.push_str(" · password");
    }
    if let Some(at) = link.expires_at.filter(|_| !expired) {
        text.push_str(&format!(" · expires {}", date(at)));
    }
    match people {
        Some(p) => format!("{text} · {p}"),
        None => format!("{text} · anyone with it can {}", if link.role == Role::Editor { "edit" } else { "view" }),
    }
}

/// Whether Copy link applies: the item is in My files, its sharing is readable and its link is live.
pub fn can_copy(item: &SharedItem, now_ms: i64) -> bool {
    item.place == Place::MyFiles
        && item.unreadable.is_none()
        && item.link.as_ref().is_some_and(|l| l.expires_at.is_none_or(|at| at > now_ms))
}

/// The question before stopping all sharing of an item, naming only what is lost.
pub fn stop_question(item: &SharedItem, now_ms: i64) -> String {
    let mut lost = Vec::new();
    if let Some(link) = &item.link {
        let expired = link.expires_at.is_some_and(|at| at <= now_ms);
        lost.push(if expired { "The expired link is removed" } else { "The link stops working" }.to_string());
    }
    match item.people {
        0 => {}
        1 => lost.push("1 person loses access".to_string()),
        n => lost.push(format!("{n} people lose access")),
    }
    if lost.is_empty() {
        format!("Stop sharing {}?", item.name)
    } else {
        format!("Stop sharing {}? {}.", item.name, lost.join(" and "))
    }
}

/// Screenshot-only: `--fake-shared <state>`, the page's rows ("list"), none ("empty") or the daemon not answering
/// ("offline"); None for an unknown state.
pub fn fake_shared(state: &str, now_ms: i64) -> Option<Result<Vec<SharedItem>, String>> {
    const DAY: i64 = 86_400_000;
    let link = |has_password: bool, expires_at: Option<i64>| ShareLink {
        url: "https://drive.proton.me/urls/7XK2M9QD4A#aB3dE5fG7hJ9".into(),
        has_password,
        expires_at,
        role: Role::Viewer,
    };
    let item = |name: &str, kind, rel_path: Option<&str>, place, link, people| SharedItem {
        uid: format!("fake~{name}"),
        name: name.into(),
        kind: Some(kind),
        rel_path: rel_path.map(String::from),
        place,
        link,
        people,
        unreadable: None,
    };
    Some(match state {
        "list" => {
            let mut catching_up = item("Budget.xlsx", ItemKind::File, Some("Finance/Budget.xlsx"), Place::MyFiles, None, 1);
            catching_up.unreadable = Some("Proton Drive is still catching up with this item: refresh in a moment".into());
            Ok(vec![
                item("report.pdf", ItemKind::File, Some("Documents/report.pdf"), Place::MyFiles, Some(link(true, Some(now_ms + 7 * DAY))), 2),
                item("Icons", ItemKind::Folder, Some("Icons"), Place::MyFiles, None, 2),
                item("old-notes.txt", ItemKind::File, Some("Documents/old-notes.txt"), Place::MyFiles, Some(link(false, Some(now_ms - DAY))), 1),
                item("Taxes", ItemKind::Folder, Some("Private/Taxes"), Place::Hidden, Some(link(false, None)), 0),
                item("holiday.jpg", ItemKind::File, None, Place::Elsewhere, Some(link(false, None)), 0),
                catching_up,
            ])
        }
        "empty" => Ok(vec![]),
        "offline" => Err(share::DAEMON_UNREACHABLE.to_string()),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-04 at 00:00 UTC, in epoch ms
    const NOV_4_UTC: i64 = 1_793_750_400_000;
    const DAY: i64 = 86_400_000;
    /// 2026-11-15 at 12:00 UTC
    const NOW: i64 = NOV_4_UTC + 11 * DAY + 12 * 3_600_000;
    fn utc(_: i64) -> i64 {
        0
    }

    fn link(has_password: bool, expires_at: Option<i64>, role: Role) -> ShareLink {
        ShareLink { url: "https://drive.proton.me/urls/ABC#abc".into(), has_password, expires_at, role }
    }

    fn item(name: &str, rel_path: Option<&str>, place: Place, link: Option<ShareLink>, people: u32) -> SharedItem {
        SharedItem { uid: format!("vol~{name}"), name: name.into(), kind: None, rel_path: rel_path.map(String::from), place, link, people, unreadable: None }
    }

    #[test]
    fn a_list_reply_is_read_each_kind_of_item() {
        let json = r#"{ "items": [
            { "uid": "v~1", "name": "report.pdf", "kind": "file", "relPath": "Documents/report.pdf", "where": "my-files",
              "link": { "url": "https://drive.proton.me/urls/A#a", "hasPassword": true, "expiresAt": 1800000000000, "role": "viewer" }, "people": 2 },
            { "uid": "v~2", "name": "Secret", "kind": "folder", "relPath": "Secret", "where": "hidden", "link": null, "people": 1 },
            { "uid": "v~3", "name": "holiday.jpg", "relPath": null, "where": "elsewhere", "link": null, "people": 0 },
            { "uid": "v~4", "name": "x", "kind": "album", "relPath": "x", "where": "my-files", "link": null, "people": 0, "unreadable": "Still catching up" },
            { "uid": "v~5", "name": "null-kind", "kind": null, "relPath": "null-kind", "where": "my-files", "link": null, "people": 0 },
            { "uid": "v~6", "name": "weird-kind", "kind": 42, "relPath": "weird-kind", "where": "my-files", "link": null, "people": 0 }
        ] }"#;
        #[derive(Deserialize)]
        struct Reply {
            items: Vec<SharedItem>,
        }
        let items = serde_json::from_str::<Reply>(json).unwrap().items;
        assert_eq!(items.len(), 6);
        assert_eq!(items.iter().map(|i| i.uid.as_str()).collect::<Vec<_>>(), ["v~1", "v~2", "v~3", "v~4", "v~5", "v~6"]);
        assert_eq!(items[0].kind, Some(ItemKind::File));
        assert_eq!(items[1].kind, Some(ItemKind::Folder));
        assert_eq!(items[2].kind, None);
        assert_eq!(items[3].kind, None);
        assert_eq!(items[4].kind, None);
        assert_eq!(items[5].kind, None);
        assert_eq!(items[0].place, Place::MyFiles);
        assert_eq!(items[0].link.as_ref().unwrap().expires_at, Some(1_800_000_000_000));
        assert_eq!(items[1].place, Place::Hidden);
        assert_eq!(items[2].place, Place::Elsewhere);
        assert_eq!(items[2].rel_path, None);
        assert_eq!(items[0].unreadable, None);
        assert_eq!(items[3].unreadable.as_deref(), Some("Still catching up"));
    }

    #[test]
    fn folder_text_says_where_each_item_is() {
        let i = |path: Option<&str>, place| item("a.txt", path, place, None, 0);
        assert_eq!(folder_text(&i(Some("Documents/Work/a.txt"), Place::MyFiles)), "Documents/Work");
        assert_eq!(folder_text(&i(Some("Icons"), Place::MyFiles)), "(top level)");
        assert_eq!(folder_text(&i(Some("Documents/a.txt"), Place::Hidden)), "Documents · Hidden from this computer");
        assert_eq!(folder_text(&i(Some("a.txt"), Place::Hidden)), "(top level) · Hidden from this computer");
        assert_eq!(folder_text(&i(None, Place::Elsewhere)), "Not on this computer");
    }

    #[test]
    fn exposure_text_says_what_each_item_exposes() {
        let nov_30 = NOV_4_UTC + 26 * DAY + 12 * 3_600_000;
        let nov_1 = NOV_4_UTC - 3 * DAY + 12 * 3_600_000;
        let text = |l: Option<ShareLink>, people| exposure_text(&item("a", Some("a"), Place::MyFiles, l, people), NOW, utc);
        assert_eq!(text(Some(link(true, Some(nov_30), Role::Viewer)), 2), "Link · password · expires 2026-11-30 · 2 people");
        assert_eq!(text(None, 2), "2 people · no link");
        assert_eq!(text(Some(link(false, None, Role::Viewer)), 0), "Link · anyone with it can view");
        assert_eq!(text(Some(link(false, None, Role::Editor)), 0), "Link · anyone with it can edit");
        assert_eq!(text(Some(link(false, Some(nov_1), Role::Viewer)), 1), "Link expired 2026-11-01 · 1 person");
        assert_eq!(text(Some(link(true, Some(nov_1), Role::Viewer)), 1), "Link expired 2026-11-01 · password · 1 person");
        let mut unreadable = item("a", Some("a"), Place::MyFiles, Some(link(false, None, Role::Viewer)), 3);
        unreadable.unreadable = Some("Proton Drive is still catching up with this item: refresh in a moment".into());
        assert_eq!(exposure_text(&unreadable, NOW, utc), "Proton Drive is still catching up with this item: refresh in a moment");
    }

    #[test]
    fn copy_link_only_for_a_live_link_in_my_files() {
        let live = || Some(link(false, Some(NOW + DAY), Role::Viewer));
        assert!(can_copy(&item("a", Some("a"), Place::MyFiles, live(), 0), NOW));
        assert!(can_copy(&item("a", Some("a"), Place::MyFiles, Some(link(false, None, Role::Viewer)), 0), NOW));
        assert!(!can_copy(&item("a", Some("a"), Place::MyFiles, Some(link(false, Some(NOW), Role::Viewer)), 0), NOW));
        assert!(!can_copy(&item("a", Some("a"), Place::MyFiles, Some(link(false, Some(NOW - DAY), Role::Viewer)), 0), NOW));
        assert!(!can_copy(&item("a", Some("a"), Place::MyFiles, None, 2), NOW));
        assert!(!can_copy(&item("a", Some("a"), Place::Hidden, live(), 0), NOW));
        assert!(!can_copy(&item("a", None, Place::Elsewhere, live(), 0), NOW));
        let mut unreadable = item("a", Some("a"), Place::MyFiles, live(), 0);
        unreadable.unreadable = Some("x".into());
        assert!(!can_copy(&unreadable, NOW));
    }

    #[test]
    fn the_stop_question_names_only_what_is_lost() {
        let l = || Some(link(false, None, Role::Viewer));
        assert_eq!(
            stop_question(&item("report.pdf", Some("report.pdf"), Place::MyFiles, l(), 2), NOW),
            "Stop sharing report.pdf? The link stops working and 2 people lose access."
        );
        assert_eq!(stop_question(&item("Icons", Some("Icons"), Place::MyFiles, None, 1), NOW), "Stop sharing Icons? 1 person loses access.");
        assert_eq!(stop_question(&item("a.txt", Some("a.txt"), Place::MyFiles, l(), 0), NOW), "Stop sharing a.txt? The link stops working.");
        assert_eq!(stop_question(&item("a.txt", Some("a.txt"), Place::MyFiles, None, 0), NOW), "Stop sharing a.txt?");
        let expired = Some(link(false, Some(NOW - DAY), Role::Viewer));
        assert_eq!(
            stop_question(&item("old-notes.txt", Some("old-notes.txt"), Place::MyFiles, expired, 1), NOW),
            "Stop sharing old-notes.txt? The expired link is removed and 1 person loses access."
        );
    }

    #[test]
    fn sharing_marks_for_each_kind() {
        use crate::icons::{CLOCK, LINK, LINK_BROKEN, LOCK, PEOPLE};
        let rows = fake_shared("list", NOW).unwrap().unwrap();
        let marks = |name: &str| sharing_marks(rows.iter().find(|i| i.name == name).unwrap(), NOW);
        assert_eq!(marks("report.pdf"), [LINK, LOCK, CLOCK, PEOPLE]);
        assert_eq!(marks("Icons"), [PEOPLE]);
        assert_eq!(marks("old-notes.txt"), [LINK_BROKEN, PEOPLE]);
        assert_eq!(marks("Taxes"), [LINK]);
        assert_eq!(marks("holiday.jpg"), [LINK]);
        // Its sharing wasn't read: nothing to mark (the row says why instead)
        assert_eq!(marks("Budget.xlsx"), Vec::<&str>::new());
        let one = |l: Option<ShareLink>, people| sharing_marks(&item("a", Some("a"), Place::MyFiles, l, people), NOW);
        assert_eq!(one(Some(link(true, Some(NOW - DAY), Role::Viewer)), 0), [LINK_BROKEN, LOCK], "an expired link keeps its password");
        assert_eq!(one(Some(link(false, Some(NOW), Role::Viewer)), 0), [LINK_BROKEN], "it expires the moment it reaches its date");
        assert_eq!(one(Some(link(false, Some(NOW + DAY), Role::Editor)), 3), [LINK, CLOCK, PEOPLE]);
        assert_eq!(one(None, 0), Vec::<&str>::new());
    }

    #[test]
    fn location_text_for_each_place() {
        let i = |path: Option<&str>, place| item("a.txt", path, place, None, 0);
        assert_eq!(location_text(&i(Some("Documents/Work/a.txt"), Place::MyFiles)), "Documents/Work");
        assert_eq!(location_text(&i(Some("Icons"), Place::MyFiles)), "(top level)");
        assert_eq!(location_text(&i(Some("Documents/a.txt"), Place::Hidden)), "Hidden from this computer");
        assert_eq!(location_text(&i(Some("a.txt"), Place::Hidden)), "Hidden from this computer");
        assert_eq!(location_text(&i(None, Place::Elsewhere)), "Not on this computer");
    }

    // Fallback when the daemon doesn't say which items are folders: a name without an extension is shown as one
    #[test]
    fn a_name_without_an_extension_is_shown_as_a_folder() {
        use crate::icons::{FILE, FOLDER};
        assert_eq!(name_icon("Icons"), FOLDER);
        assert_eq!(name_icon("Tax returns 2026"), FOLDER);
        assert_eq!(name_icon("report.pdf"), FILE);
        assert_eq!(name_icon("archive.tar.gz"), FILE);
    }

    // #282: item_icon trusts the daemon's kind and falls back to the name only when kind is absent
    #[test]
    fn item_icon_uses_kind_and_falls_back_to_name() {
        use crate::icons::{FILE, FOLDER};
        let with_kind = |name: &str, kind: Option<ItemKind>| {
            let mut it = item(name, Some(name), Place::MyFiles, None, 1);
            it.kind = kind;
            it
        };
        assert_eq!(item_icon(&with_kind("v1.2 notes", Some(ItemKind::Folder))), FOLDER);
        assert_eq!(item_icon(&with_kind("photos.2026", Some(ItemKind::Folder))), FOLDER);
        assert_eq!(item_icon(&with_kind("Makefile", Some(ItemKind::File))), FILE);
        assert_eq!(item_icon(&with_kind(".bashrc", Some(ItemKind::File))), FILE);
        // Older daemon or unreadable item with no kind falls back to name_icon
        assert_eq!(item_icon(&with_kind("report.pdf", None)), FILE);
        assert_eq!(item_icon(&with_kind("Icons", None)), FOLDER);
    }

    #[test]
    fn the_fakes_cover_every_kind_of_row() {
        let items = fake_shared("list", NOW).unwrap().unwrap();
        for place in [Place::MyFiles, Place::Hidden, Place::Elsewhere] {
            assert!(items.iter().any(|i| i.place == place), "{place:?}");
        }
        assert!(items.iter().any(|i| i.unreadable.is_some()));
        assert!(items.iter().any(|i| i.link.as_ref().is_some_and(|l| l.expires_at.is_some_and(|at| at <= NOW))));
        let report = items.iter().find(|i| i.name == "report.pdf").unwrap();
        assert_eq!(report.rel_path.as_deref(), Some("Documents/report.pdf"));
        assert_eq!(report.people, 2);
        assert!(report.link.as_ref().is_some_and(|l| l.has_password && l.expires_at.is_some_and(|at| at > NOW)));
        let icons = items.iter().find(|i| i.name == "Icons").unwrap();
        assert_eq!((icons.rel_path.as_deref(), icons.link.is_none(), icons.people), (Some("Icons"), true, 2));
        assert_eq!(items.iter().find(|i| i.name == "holiday.jpg").unwrap().rel_path, None);
        assert!(items.iter().any(|i| i.name == "old-notes.txt" && i.rel_path.as_deref() == Some("Documents/old-notes.txt")));
        assert!(items.iter().any(|i| i.place == Place::Hidden && i.rel_path.is_some()));
        assert_eq!(fake_shared("empty", NOW), Some(Ok(vec![])));
        assert_eq!(fake_shared("offline", NOW), Some(Err(share::DAEMON_UNREACHABLE.to_string())));
        assert_eq!(fake_shared("bogus", NOW), None);
    }
}

/// What the Shared section shows: the list as last read (kept while the next read is out), whether one is out, and why
/// the last one failed. Each read has a number; only the newest one's answer counts, since answers can arrive in any
/// order.
#[derive(Default)]
pub struct SharedPage {
    pub items: Option<Vec<SharedItem>>,
    pub loading: bool,
    pub error: Option<String>,
    /// The number of the newest read
    pub seq: u64,
    /// The rel_path whose sharing is being stopped: its buttons wait for the answer
    pub stopping: Option<String>,
    /// The rel_path whose link was just copied, until the next read
    pub copied: Option<String>,
    /// Why the last Stop sharing failed, shown above the list (which stays)
    pub stop_error: Option<String>,
}

impl SharedPage {
    /// A read goes out: the rows shown stay until it answers. Returns its number.
    pub fn begin_load(&mut self) -> u64 {
        self.seq += 1;
        self.loading = true;
        self.error = None;
        self.copied = None;
        self.stop_error = None;
        self.seq
    }

    /// A read answered. One that isn't the newest is ignored. A failure drops the list: it can't be known to be current.
    pub fn loaded(&mut self, seq: u64, result: Result<Vec<SharedItem>, String>) {
        if seq != self.seq {
            return;
        }
        self.loading = false;
        match result {
            Ok(items) => {
                self.items = Some(items);
                self.error = None;
            }
            Err(message) => {
                self.items = None;
                self.error = Some(message);
            }
        }
    }
}
