// Inode numbers for the paths of the drive. A number stays with its item for the life of the mount, following it when
// it is renamed through the drive, and is never given to another item, so the kernel's forget needs no bookkeeping
// here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const ROOT_INO: u64 = 1;

/// Paths are relative to the drive's top, which is the empty path.
pub struct Inodes {
    by_path: HashMap<PathBuf, u64>,
    by_ino: HashMap<u64, PathBuf>,
    next: u64,
}

impl Inodes {
    pub fn new() -> Self {
        Inodes {
            by_path: HashMap::from([(PathBuf::new(), ROOT_INO)]),
            by_ino: HashMap::from([(ROOT_INO, PathBuf::new())]),
            next: ROOT_INO + 1,
        }
    }

    /// The path's number, given it now if it has none.
    pub fn ino_of(&mut self, rel: &Path) -> u64 {
        if let Some(&ino) = self.by_path.get(rel) {
            return ino;
        }
        let ino = self.next;
        self.next += 1;
        self.by_path.insert(rel.to_path_buf(), ino);
        self.by_ino.insert(ino, rel.to_path_buf());
        ino
    }

    /// The path's number, if one has already been assigned (without assigning a new one).
    pub fn existing_ino(&self, rel: &Path) -> Option<u64> {
        self.by_path.get(rel).copied()
    }

    pub fn path_of(&self, ino: u64) -> Option<PathBuf> {
        self.by_ino.get(&ino).cloned()
    }

    /// `from` and everything under it now live at `to`, keeping their numbers; whatever had `to`'s numbers was
    /// replaced, and its numbers go stale.
    pub fn rename(&mut self, from: &Path, to: &Path) {
        self.remove(to);
        let moving: Vec<(PathBuf, u64)> =
            self.by_path.iter().filter(|(p, _)| p.starts_with(from)).map(|(p, &ino)| (p.clone(), ino)).collect();
        for (old, ino) in moving {
            let Ok(rest) = old.strip_prefix(from) else { continue };
            let new = if rest.as_os_str().is_empty() { to.to_path_buf() } else { to.join(rest) };
            self.by_path.remove(&old);
            self.by_path.insert(new.clone(), ino);
            self.by_ino.insert(ino, new);
        }
    }

    /// `rel` and everything under it are gone: their numbers go stale, and an item made there later gets new ones.
    pub fn remove(&mut self, rel: &Path) {
        if rel.as_os_str().is_empty() {
            return; // the root stays
        }
        let gone: Vec<PathBuf> = self.by_path.keys().filter(|p| p.starts_with(rel)).cloned().collect();
        for path in gone {
            if let Some(ino) = self.by_path.remove(&path) {
                self.by_ino.remove(&ino);
            }
        }
    }

    /// Removes `rel` and its subtree only if `rel` still maps to `expected_ino` (so a fallback cleanup cannot remove
    /// an inode allocated for a newly created item at the same path).
    pub fn remove_if_ino(&mut self, rel: &Path, expected_ino: u64) {
        if self.by_path.get(rel) == Some(&expected_ino) {
            self.remove(rel);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_one() {
        let mut inodes = Inodes::new();
        assert_eq!(inodes.ino_of(Path::new("")), ROOT_INO);
        assert_eq!(inodes.path_of(ROOT_INO), Some(PathBuf::new()));
    }

    #[test]
    fn a_path_keeps_its_number_and_no_two_paths_share_one() {
        let mut inodes = Inodes::new();
        let a = inodes.ino_of(Path::new("Docs"));
        let b = inodes.ino_of(Path::new("Docs/a.txt"));
        assert_ne!(a, ROOT_INO);
        assert_ne!(a, b);
        assert_eq!(inodes.ino_of(Path::new("Docs")), a);
        assert_eq!(inodes.path_of(b), Some(PathBuf::from("Docs/a.txt")));
    }

    #[test]
    fn an_unknown_number_has_no_path() {
        assert_eq!(Inodes::new().path_of(42), None);
    }

    #[test]
    fn a_rename_carries_the_numbers_of_everything_under_it() {
        let mut inodes = Inodes::new();
        let docs = inodes.ino_of(Path::new("Docs"));
        let deep = inodes.ino_of(Path::new("Docs/Sub/a.txt"));
        let neighbour = inodes.ino_of(Path::new("Docsx"));
        inodes.rename(Path::new("Docs"), Path::new("Work"));
        assert_eq!(inodes.path_of(docs), Some(PathBuf::from("Work")));
        assert_eq!(inodes.path_of(deep), Some(PathBuf::from("Work/Sub/a.txt")));
        assert_eq!(inodes.ino_of(Path::new("Work/Sub/a.txt")), deep);
        assert_eq!(inodes.path_of(neighbour), Some(PathBuf::from("Docsx")), "only whole path components match");
        assert_ne!(inodes.ino_of(Path::new("Docs")), docs, "the old path is free for a new item");
    }

    #[test]
    fn a_replaced_target_and_a_removed_item_go_stale() {
        let mut inodes = Inodes::new();
        let tmp = inodes.ino_of(Path::new("doc.txt.tmp"));
        let doc = inodes.ino_of(Path::new("doc.txt"));
        inodes.rename(Path::new("doc.txt.tmp"), Path::new("doc.txt"));
        assert_eq!(inodes.path_of(tmp), Some(PathBuf::from("doc.txt")));
        assert_eq!(inodes.path_of(doc), None);
        let sub = inodes.ino_of(Path::new("Docs/a.txt"));
        inodes.remove(Path::new("Docs"));
        assert_eq!(inodes.path_of(sub), None);
        let again = inodes.ino_of(Path::new("Docs/a.txt"));
        assert!(again != sub && again != doc && again != tmp, "numbers are never reused");
        inodes.remove(Path::new(""));
        assert_eq!(inodes.path_of(ROOT_INO), Some(PathBuf::new()));
    }
}
