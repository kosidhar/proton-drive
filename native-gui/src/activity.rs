//! The Activity list's rows: what each entry is (by its action, and for entries from before the daemon told them
//! apart, by its details), the filter, and where its item is on this computer, to show it in Files or open it (#94).

use std::path::{Path, PathBuf};

/// What an activity entry is, as the list shows it
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActivityKind {
    Uploaded,
    Downloaded,
    FolderCreated,
    /// Free up space: the local copies went, the items are still in Proton Drive and in Files, online-only
    FreedUp,
    /// Hidden from this computer: the local copy went, the item is still in Proton Drive
    Hidden,
    /// A real removal from this computer: deleted here, or following a delete in Proton Drive
    RemovedLocally,
    MovedToCloudTrash,
    Conflict,
    Failed,
    Other,
}

/// The kind of an entry. Free up space and Hide were logged as delete-local before the daemon gave them their own
/// actions: those older entries are told apart by what their details begin with.
pub(crate) fn activity_kind(action: &str, details: &str) -> ActivityKind {
    match action {
        "upload" => ActivityKind::Uploaded,
        "download" => ActivityKind::Downloaded,
        "mkdir" => ActivityKind::FolderCreated,
        "free-up" => ActivityKind::FreedUp,
        "hide" => ActivityKind::Hidden,
        "delete-local" if details.starts_with("Freed up space") => ActivityKind::FreedUp,
        "delete-local" if details.starts_with("Hidden from this computer") => ActivityKind::Hidden,
        "delete-local" => ActivityKind::RemovedLocally,
        "delete-remote" | "trash-remote" => ActivityKind::MovedToCloudTrash,
        "conflict" => ActivityKind::Conflict,
        "error" => ActivityKind::Failed,
        _ => ActivityKind::Other,
    }
}

/// The label of a kind's pill
pub(crate) fn kind_label(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::Uploaded => "↑ Uploaded",
        ActivityKind::Downloaded => "↓ Downloaded",
        ActivityKind::FolderCreated => "+ Folder created",
        ActivityKind::FreedUp => "Freed up space",
        ActivityKind::Hidden => "Hidden here",
        ActivityKind::RemovedLocally => "− Removed locally",
        ActivityKind::MovedToCloudTrash => "Trash (Cloud)",
        ActivityKind::Conflict => "! Conflict",
        ActivityKind::Failed => "✕ Failed",
        ActivityKind::Other => "• Synced",
    }
}

/// Whether a kind's pill carries a cloud: the item is still in Proton Drive, online-only
pub(crate) fn shows_cloud(kind: ActivityKind) -> bool {
    matches!(kind, ActivityKind::FreedUp | ActivityKind::Hidden)
}

/// The Activity filter
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ActivityFilter {
    #[default]
    All,
    Uploads,
    Downloads,
    /// Conflicts and failures
    Problems,
}

pub(crate) const FILTERS: [(ActivityFilter, &str); 4] = [
    (ActivityFilter::All, "All"),
    (ActivityFilter::Uploads, "Uploads"),
    (ActivityFilter::Downloads, "Downloads"),
    (ActivityFilter::Problems, "Problems"),
];

pub(crate) fn in_filter(kind: ActivityKind, filter: ActivityFilter) -> bool {
    match filter {
        ActivityFilter::All => true,
        ActivityFilter::Uploads => kind == ActivityKind::Uploaded,
        ActivityFilter::Downloads => kind == ActivityKind::Downloaded,
        ActivityFilter::Problems => matches!(kind, ActivityKind::Conflict | ActivityKind::Failed),
    }
}

/// Where an entry's item is in the sync folder: "/" or "" is the folder itself. None without a sync folder, or for a
/// path that would leave it.
pub(crate) fn local_path(sync_dir: &str, rel_path: &str) -> Option<PathBuf> {
    if sync_dir.trim().is_empty() {
        return None;
    }
    let rel = rel_path.trim_matches('/');
    if rel.split('/').any(|part| part == "..") {
        return None;
    }
    let root = Path::new(sync_dir);
    Some(if rel.is_empty() { root.to_path_buf() } else { root.join(rel) })
}

/// What Show in Files shows for an item: the item itself while it is there, else the nearest folder above it that is
/// (an item since deleted or moved is shown quietly by where it was), never above the sync folder. None when not even
/// the sync folder is there.
pub(crate) fn show_target(sync_dir: &str, rel_path: &str) -> Option<PathBuf> {
    let root = PathBuf::from(sync_dir);
    let mut at = local_path(sync_dir, rel_path)?;
    loop {
        if at.symlink_metadata().is_ok() {
            return Some(at);
        }
        if at == root || !at.pop() || !at.starts_with(&root) {
            return None;
        }
    }
}

/// What Open opens: the item, when it is a file there now (opening an online-only one in the virtual drive downloads
/// it, as opening it in Files does). None otherwise, so a path that is gone offers no Open.
pub(crate) fn open_target(sync_dir: &str, rel_path: &str) -> Option<PathBuf> {
    let path = local_path(sync_dir, rel_path)?;
    path.metadata().ok().filter(|m| m.is_file()).map(|_| path)
}

/// A file:// URI for a path, as the file manager's ShowItems takes it
pub(crate) fn file_uri(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_up_and_hide_never_read_as_a_delete_old_entries_included() {
        assert_eq!(activity_kind("free-up", "Freed up space (removed the local copies; kept in Proton Drive)"), ActivityKind::FreedUp);
        assert_eq!(activity_kind("hide", "Hidden from this computer (removed the local copy; kept in Proton Drive)"), ActivityKind::Hidden);
        // As the daemon logged them before
        assert_eq!(activity_kind("delete-local", "Freed up space (removed the local copies; kept in Proton Drive)"), ActivityKind::FreedUp);
        assert_eq!(activity_kind("delete-local", "Hidden from this computer (removed the local copy; kept in Proton Drive)"), ActivityKind::Hidden);
        // Real removals keep their label
        for details in ["Deleted on this computer", "Removed local item after it was deleted on Proton Drive"] {
            assert_eq!(activity_kind("delete-local", details), ActivityKind::RemovedLocally);
        }
        assert_eq!(kind_label(ActivityKind::FreedUp), "Freed up space");
        assert_eq!(kind_label(ActivityKind::RemovedLocally), "− Removed locally");
        assert!(shows_cloud(ActivityKind::FreedUp) && shows_cloud(ActivityKind::Hidden));
        assert!(!shows_cloud(ActivityKind::RemovedLocally));
        for (action, kind) in [
            ("upload", ActivityKind::Uploaded),
            ("download", ActivityKind::Downloaded),
            ("mkdir", ActivityKind::FolderCreated),
            ("trash-remote", ActivityKind::MovedToCloudTrash),
            ("conflict", ActivityKind::Conflict),
            ("error", ActivityKind::Failed),
            ("sync", ActivityKind::Other),
            ("auth", ActivityKind::Other),
        ] {
            assert_eq!(activity_kind(action, ""), kind, "{action}");
        }
    }

    #[test]
    fn the_filter_keeps_uploads_downloads_or_conflicts_and_failures() {
        use ActivityKind::*;
        let kinds = [Uploaded, Downloaded, FolderCreated, FreedUp, Hidden, RemovedLocally, MovedToCloudTrash, Conflict, Failed, Other];
        let kept = |f| kinds.iter().copied().filter(|k| in_filter(*k, f)).collect::<Vec<_>>();
        assert_eq!(kept(ActivityFilter::All), kinds.to_vec());
        assert_eq!(kept(ActivityFilter::Uploads), vec![Uploaded]);
        assert_eq!(kept(ActivityFilter::Downloads), vec![Downloaded]);
        assert_eq!(kept(ActivityFilter::Problems), vec![Conflict, Failed]);
    }

    #[test]
    fn show_and_open_find_the_item_or_quietly_where_it_was() {
        let dir = std::env::temp_dir().join(format!("pd-activity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Docs")).unwrap();
        std::fs::write(dir.join("Docs/a.txt"), "a").unwrap();
        let root = dir.to_str().unwrap();

        assert_eq!(show_target(root, "Docs/a.txt"), Some(dir.join("Docs/a.txt")));
        assert_eq!(open_target(root, "Docs/a.txt"), Some(dir.join("Docs/a.txt")));
        // Gone: shown by the folder it was in, and no Open
        assert_eq!(show_target(root, "Docs/Gone/b.txt"), Some(dir.join("Docs")));
        assert_eq!(open_target(root, "Docs/Gone/b.txt"), None);
        // A folder is shown, not opened as a file; the whole drive is the folder itself
        assert_eq!(open_target(root, "Docs"), None);
        assert_eq!(show_target(root, "/"), Some(dir.clone()));
        // Never outside the sync folder, and nothing without one
        assert_eq!(show_target(root, "../etc/passwd"), None);
        assert_eq!(show_target("", "Docs/a.txt"), None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(show_target(root, "Docs/a.txt"), None, "not even the sync folder is there");
    }

    #[test]
    fn file_uris_escape_what_a_uri_cannot_hold() {
        assert_eq!(file_uri(Path::new("/home/u/ProtonDrive/My file #1.txt")), "file:///home/u/ProtonDrive/My%20file%20%231.txt");
        assert_eq!(file_uri(Path::new("/home/u/é")), "file:///home/u/%C3%A9");
    }
}
