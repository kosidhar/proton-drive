// What a folder of the drive shows: what the backing store has, plus what the cloud has that isn't downloaded here.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Folder,
}

/// One name in a folder of the drive. Names are OsString because a backing name needn't be UTF-8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: OsString,
    pub kind: Kind,
    pub size: u64,
    pub mtime: SystemTime,
    /// In the backing store (or served by the helper itself) rather than online-only
    pub local: bool,
}

/// The file GNOME reads the sidebar name from; the helper serves it read-only at the root.
pub const VOLUME_INFO_NAME: &str = ".xdg-volume-info";
pub const VOLUME_INFO_CONTENT: &[u8] = b"[Volume Info]\nName=Proton Drive\n";

/// The daemon's downloads in progress and other temporary files: never shown, at any level.
pub fn is_hidden_name(name: &OsStr) -> bool {
    name.as_bytes().starts_with(b".proton-drive-tmp-")
}

/// The backing folder's files and folders (nothing else: a symlink isn't part of the drive).
pub fn read_local(dir: &Path) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.filter_map(|item| {
        let item = item.ok()?;
        let meta = item.metadata().ok()?; // lstat: a symlink stays a symlink
        let kind = if meta.is_file() {
            Kind::File
        } else if meta.is_dir() {
            Kind::Folder
        } else {
            return None;
        };
        Some(Entry {
            name: item.file_name(),
            kind,
            size: meta.len(),
            mtime: meta.modified().unwrap_or(UNIX_EPOCH),
            local: true,
        })
    })
    .collect()
}

/// Local wins by exact name; temporary files go; at the root, the helper's `.xdg-volume-info` replaces any other.
pub fn merge_listing(local: Vec<Entry>, remote: Vec<Entry>, is_root: bool) -> Vec<Entry> {
    let mut seen = HashSet::new();
    let mut merged: Vec<Entry> = local
        .into_iter()
        .chain(remote) // after local, so a local name is seen first and wins
        .filter(|e| !is_hidden_name(&e.name) && !(is_root && e.name == VOLUME_INFO_NAME))
        .filter(|e| seen.insert(e.name.clone()))
        .collect();
    if is_root {
        merged.push(Entry {
            name: VOLUME_INFO_NAME.into(),
            kind: Kind::File,
            size: VOLUME_INFO_CONTENT.len() as u64,
            mtime: UNIX_EPOCH,
            local: true,
        });
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size: u64, local: bool) -> Entry {
        Entry { name: name.into(), kind: Kind::File, size, mtime: UNIX_EPOCH, local }
    }

    fn folder(name: &str, local: bool) -> Entry {
        Entry { name: name.into(), kind: Kind::Folder, size: 0, mtime: UNIX_EPOCH, local }
    }

    fn names(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.to_str().unwrap()).collect()
    }

    #[test]
    fn local_wins_by_exact_name() {
        let local = vec![file("a.txt", 5, true), folder("Docs", true)];
        let remote = vec![file("a.txt", 999, false), file("Docs", 10, false), file("b.txt", 7, false), file("A.txt", 1, false)];
        let merged = merge_listing(local, remote, false);
        assert_eq!(names(&merged), ["a.txt", "Docs", "b.txt", "A.txt"]);
        assert_eq!(merged[0], file("a.txt", 5, true));
        assert_eq!(merged[1], folder("Docs", true));
        assert_eq!(merged[2], file("b.txt", 7, false));
    }

    #[test]
    fn temp_files_are_dropped() {
        let local = vec![file(".proton-drive-tmp-hydrate-1234", 1, true), file("keep.txt", 1, true)];
        let remote = vec![file(".proton-drive-tmp-x", 1, false), file("r.txt", 1, false)];
        assert_eq!(names(&merge_listing(local.clone(), remote.clone(), false)), ["keep.txt", "r.txt"]);
        assert_eq!(names(&merge_listing(local, remote, true)), ["keep.txt", "r.txt", VOLUME_INFO_NAME]);
        assert!(is_hidden_name(OsStr::new(".proton-drive-tmp-")));
        assert!(!is_hidden_name(OsStr::new("proton-drive-tmp-x")));
    }

    #[test]
    fn volume_info_appears_only_at_the_root() {
        let at_root = merge_listing(vec![file("a", 1, true)], vec![], true);
        let info: Vec<_> = at_root.iter().filter(|e| e.name == VOLUME_INFO_NAME).collect();
        assert_eq!(info.len(), 1);
        assert_eq!(info[0].kind, Kind::File);
        assert_eq!(info[0].size, VOLUME_INFO_CONTENT.len() as u64);
        assert!(merge_listing(vec![file("a", 1, true)], vec![], false).iter().all(|e| e.name != VOLUME_INFO_NAME));
    }

    #[test]
    fn the_helpers_volume_info_replaces_a_real_one_at_the_root_only() {
        let real = || vec![file(VOLUME_INFO_NAME, 3, true)];
        let at_root = merge_listing(real(), vec![file(VOLUME_INFO_NAME, 4, false)], true);
        assert_eq!(at_root.len(), 1);
        assert_eq!(at_root[0].size, VOLUME_INFO_CONTENT.len() as u64);
        assert_eq!(merge_listing(real(), vec![], false), real());
    }

    #[test]
    fn a_name_the_cloud_lists_twice_shows_once() {
        let merged = merge_listing(vec![], vec![file("x", 1, false), folder("x", false)], false);
        assert_eq!(merged, [file("x", 1, false)]);
    }

    #[test]
    fn read_local_lists_files_and_folders_only() {
        let dir = std::env::temp_dir().join(format!("protondrive-vfs-listing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("f.txt"), b"hello").unwrap();
        std::os::unix::fs::symlink("f.txt", dir.join("link")).unwrap();
        let mut entries = read_local(&dir);
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(names(&entries), ["f.txt", "sub"]);
        assert_eq!((entries[0].kind, entries[0].size, entries[0].local), (Kind::File, 5, true));
        assert_eq!(entries[1].kind, Kind::Folder);
        assert!(read_local(&dir).is_empty());
    }
}
