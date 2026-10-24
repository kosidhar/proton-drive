// Inode numbers for the paths of the drive. A number stays with its path for the life of the mount and is never
// given to another path, so the kernel's forget needs no bookkeeping here.

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

    pub fn path_of(&self, ino: u64) -> Option<PathBuf> {
        self.by_ino.get(&ino).cloned()
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
}
