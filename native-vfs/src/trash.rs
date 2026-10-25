// The drive's own trash folder, .Trash-<uid> at its top: on a mount of its own, that is where GIO's Move to Trash
// goes. An item moved into its files/ is deleted through the daemon (the cloud keeps it in its own trash), so files/
// always lists empty. The .trashinfo files GIO writes in info/ along the way live in memory only, and go once their
// item is in files/ and they are complete, or after a minute when a trasher never finishes.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use fuser::Errno;

/// A .trashinfo whose trasher never finished goes after this long.
const INFO_TTL: Duration = Duration::from_secs(60);
/// More than any .trashinfo needs (an escaped path and a date): what is in info/ is kept in memory.
const INFO_MAX: u64 = 64 * 1024;
const INFO_SUFFIX: &[u8] = b".trashinfo";

/// What a path of the trash folder is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrashNode {
    Root,
    Files,
    Info,
    InfoFile { id: u64, size: u64, mtime: SystemTime },
}

pub struct TrashArea {
    name: String,
    ttl: Duration,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    infos: HashMap<OsString, InfoFile>,
    /// Items moved into files/, by their name there, whose .trashinfo isn't complete yet
    trashed: HashMap<OsString, Instant>,
}

struct InfoFile {
    id: u64,
    data: Vec<u8>,
    created: Instant,
    mtime: SystemTime,
    /// Its content is final: something with content was renamed onto it, or it was closed with content in it
    complete: bool,
}

/// Where a path is in the trash folder.
enum Place<'a> {
    Outside,
    Root,
    Files,
    Info,
    InFiles,
    InInfo(&'a OsStr),
    /// Any other name in the trash folder, or deeper down: nothing is ever there
    Nowhere,
}

/// The .trashinfo that goes with an item of files/.
fn info_name_of(trashed: &OsStr) -> OsString {
    let mut name = trashed.as_bytes().to_vec();
    name.extend_from_slice(INFO_SUFFIX);
    OsString::from_vec(name)
}

/// The item of files/ that a .trashinfo goes with.
fn trashed_name_of(info: &OsStr) -> Option<&OsStr> {
    info.as_bytes().strip_suffix(INFO_SUFFIX).filter(|n| !n.is_empty()).map(OsStr::from_bytes)
}

impl Inner {
    fn id_named(&self, id: u64) -> Option<OsString> {
        self.infos.iter().find(|(_, info)| info.id == id).map(|(name, _)| name.clone())
    }

    /// Once an item is in files/ and its .trashinfo is complete, the .trashinfo goes: the name it had, if so.
    fn settle(&mut self, trashed: &OsStr) -> Option<OsString> {
        let info_name = info_name_of(trashed);
        if !self.trashed.contains_key(trashed) || !self.infos.get(&info_name).is_some_and(|i| i.complete) {
            return None;
        }
        self.trashed.remove(trashed);
        self.infos.remove(&info_name);
        Some(info_name)
    }
}

impl TrashArea {
    pub fn new(uid: u32) -> Self {
        TrashArea { name: format!(".Trash-{uid}"), ttl: INFO_TTL, inner: Mutex::new(Inner::default()) }
    }

    #[cfg(test)]
    fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    /// The trash folder's name at the top of the drive.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_trash_path(&self, rel: &str) -> bool {
        !matches!(self.place(Path::new(rel)), Place::Outside)
    }

    /// True when rename_to is under .Trash-<uid>/files/
    pub fn trashed_source(&self, rename_to: &str) -> bool {
        matches!(self.place(Path::new(rename_to)), Place::InFiles)
    }

    fn place<'a>(&self, rel: &'a Path) -> Place<'a> {
        let mut parts = rel.components();
        match parts.next() {
            Some(Component::Normal(top)) if top == OsStr::new(&self.name) => {}
            _ => return Place::Outside,
        }
        let name = |c: Option<Component<'a>>| match c {
            Some(Component::Normal(n)) => Some(n),
            _ => None,
        };
        match (parts.next(), name(parts.next()), parts.next()) {
            (None, ..) => Place::Root,
            (Some(dir), None, None) if dir.as_os_str() == "files" => Place::Files,
            (Some(dir), None, None) if dir.as_os_str() == "info" => Place::Info,
            (Some(dir), Some(_), None) if dir.as_os_str() == "files" => Place::InFiles,
            (Some(dir), Some(n), None) if dir.as_os_str() == "info" => Place::InInfo(n),
            _ => Place::Nowhere,
        }
    }

    // A trasher that never finished leaves nothing behind for long
    fn inner(&self) -> MutexGuard<'_, Inner> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let ttl = self.ttl;
        inner.infos.retain(|_, info| info.created.elapsed() < ttl);
        inner.trashed.retain(|_, at| at.elapsed() < ttl);
        inner
    }

    /// What is at a path of the trash folder, if anything.
    pub fn node(&self, rel: &Path) -> Option<TrashNode> {
        match self.place(rel) {
            Place::Root => Some(TrashNode::Root),
            Place::Files => Some(TrashNode::Files),
            Place::Info => Some(TrashNode::Info),
            Place::InInfo(name) => self.inner().infos.get(name).map(|info| TrashNode::InfoFile {
                id: info.id,
                size: info.data.len() as u64,
                mtime: info.mtime,
            }),
            Place::Outside | Place::InFiles | Place::Nowhere => None,
        }
    }

    /// The names in a folder of the trash, each with whether it is a folder.
    pub fn list(&self, rel: &Path) -> Vec<(OsString, bool)> {
        match self.place(rel) {
            Place::Root => vec![("files".into(), true), ("info".into(), true)],
            Place::Info => self.inner().infos.keys().map(|name| (name.clone(), false)).collect(),
            _ => Vec::new(),
        }
    }

    /// Whether `rel` is a .trashinfo's place, info/<name>: the name, if so.
    pub fn info_name<'a>(&self, rel: &'a Path) -> Option<&'a OsStr> {
        match self.place(rel) {
            Place::InInfo(name) => Some(name),
            _ => None,
        }
    }

    /// Creates a .trashinfo in info/ (O_EXCL refuses one that is there), or opens the one there.
    pub fn create_info(&self, name: &OsStr, exclusive: bool, truncate: bool) -> Result<u64, Errno> {
        let mut inner = self.inner();
        if let Some(info) = inner.infos.get_mut(name) {
            if exclusive {
                return Err(Errno::EEXIST);
            }
            if truncate {
                info.data.clear();
                info.mtime = SystemTime::now();
            }
            return Ok(info.id);
        }
        inner.next_id += 1;
        let id = inner.next_id;
        let (created, mtime) = (Instant::now(), SystemTime::now());
        inner.infos.insert(name.to_os_string(), InfoFile { id, data: Vec::new(), created, mtime, complete: false });
        Ok(id)
    }

    /// Reads a .trashinfo; one that has gone reads as empty.
    pub fn read_info(&self, id: u64, offset: u64, size: u32) -> Vec<u8> {
        let inner = self.inner();
        let Some(info) = inner.infos.values().find(|i| i.id == id) else { return Vec::new() };
        let start = (offset.min(info.data.len() as u64)) as usize;
        let end = start.saturating_add(size as usize).min(info.data.len());
        info.data[start..end].to_vec()
    }

    /// Writes into a .trashinfo; what is written to one that has gone goes nowhere.
    pub fn write_info(&self, id: u64, offset: u64, data: &[u8]) -> Result<(), Errno> {
        let end = offset.saturating_add(data.len() as u64);
        if end > INFO_MAX {
            return Err(Errno::EFBIG);
        }
        let mut inner = self.inner();
        let Some(info) = inner.infos.values_mut().find(|i| i.id == id) else { return Ok(()) };
        if info.data.len() < end as usize {
            info.data.resize(end as usize, 0);
        }
        info.data[offset as usize..end as usize].copy_from_slice(data);
        info.mtime = SystemTime::now();
        Ok(())
    }

    pub fn resize_info(&self, name: &OsStr, size: u64) -> Result<(), Errno> {
        if size > INFO_MAX {
            return Err(Errno::EFBIG);
        }
        let mut inner = self.inner();
        let info = inner.infos.get_mut(name).ok_or(Errno::ENOENT)?;
        info.data.resize(size as usize, 0);
        info.mtime = SystemTime::now();
        Ok(())
    }

    /// A .trashinfo was closed: with content in it, it is complete. Gives the name of the .trashinfo dropped as a
    /// result, if its item was already in files/.
    pub fn close_info(&self, id: u64) -> Option<OsString> {
        let mut inner = self.inner();
        let name = inner.id_named(id)?;
        let info = inner.infos.get_mut(&name)?;
        if info.data.is_empty() {
            return None;
        }
        info.complete = true;
        inner.settle(trashed_name_of(&name)?)
    }

    pub fn remove_info(&self, name: &OsStr) -> Result<(), Errno> {
        self.inner().infos.remove(name).map(|_| ()).ok_or(Errno::ENOENT)
    }

    /// A rename inside info/, as GIO puts a .trashinfo's content in place: what it lands on is complete, if it has
    /// content. Gives the name of the .trashinfo dropped as a result, if its item was already in files/.
    pub fn rename_info(&self, from: &OsStr, to: &OsStr, no_replace: bool) -> Result<Option<OsString>, Errno> {
        let mut inner = self.inner();
        if !inner.infos.contains_key(from) {
            return Err(Errno::ENOENT);
        }
        if from == to {
            return Ok(None);
        }
        if no_replace && inner.infos.contains_key(to) {
            return Err(Errno::EEXIST);
        }
        let Some(mut info) = inner.infos.remove(from) else { return Err(Errno::ENOENT) };
        // GLib 2.88 puts an empty one in place first, then the real one
        info.complete = !info.data.is_empty();
        inner.infos.insert(to.to_os_string(), info);
        Ok(trashed_name_of(to).and_then(|trashed| inner.settle(trashed)))
    }

    /// An item was moved into files/ under `name` (and deleted). Gives the name of its .trashinfo if that is complete,
    /// which is then dropped.
    pub fn trashed(&self, name: &OsStr) -> Option<OsString> {
        let mut inner = self.inner();
        inner.trashed.insert(name.to_os_string(), Instant::now());
        inner.settle(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(name: &str) -> &OsStr {
        OsStr::new(name)
    }

    fn info_names(trash: &TrashArea) -> Vec<String> {
        let mut names: Vec<String> =
            trash.list(Path::new(".Trash-1000/info")).into_iter().map(|(n, _)| n.into_string().unwrap()).collect();
        names.sort();
        names
    }

    #[test]
    fn its_paths_are_the_folder_files_and_info() {
        let trash = TrashArea::new(1000);
        assert_eq!(trash.name(), ".Trash-1000");
        for rel in [".Trash-1000", ".Trash-1000/files", ".Trash-1000/info/a.trashinfo", ".Trash-1000/other/deep"] {
            assert!(trash.is_trash_path(rel), "{rel}");
        }
        for rel in ["", ".Trash-1000x", ".Trash-1001/files", "Docs/.Trash-1000", ".Trash"] {
            assert!(!trash.is_trash_path(rel), "{rel}");
        }
        assert!(trash.trashed_source(".Trash-1000/files/report.pdf"));
        for rel in [".Trash-1000/files", ".Trash-1000/files/a/b", ".Trash-1000/info/a", "files/a"] {
            assert!(!trash.trashed_source(rel), "{rel}");
        }
        assert_eq!(trash.node(Path::new(".Trash-1000")), Some(TrashNode::Root));
        assert_eq!(trash.node(Path::new(".Trash-1000/files")), Some(TrashNode::Files));
        assert_eq!(trash.node(Path::new(".Trash-1000/info")), Some(TrashNode::Info));
        assert_eq!(trash.node(Path::new(".Trash-1000/files/a")), None);
        assert_eq!(trash.node(Path::new(".Trash-1000/other")), None);
        let root: Vec<(OsString, bool)> = trash.list(Path::new(".Trash-1000"));
        assert_eq!(root, [("files".into(), true), ("info".into(), true)]);
        assert!(trash.list(Path::new(".Trash-1000/files")).is_empty());
    }

    // What GLib 2.88's gio trash does on the mount (seen with strace): an empty placeholder made with O_EXCL, an empty
    // temp file renamed over it, then a temp file with the content renamed over it, then the item moved into files/
    #[test]
    fn gios_sequence_leaves_info_empty_once_the_item_is_in_files() {
        let trash = TrashArea::new(1000);
        let placeholder = trash.create_info(os("a.txt.trashinfo"), true, false).unwrap();
        assert_eq!(trash.close_info(placeholder), None);
        let empty = trash.create_info(os("a.txt.trashinfo.0VNPX3"), true, false).unwrap();
        assert_eq!(trash.close_info(empty), None);
        assert_eq!(trash.rename_info(os("a.txt.trashinfo.0VNPX3"), os("a.txt.trashinfo"), false), Ok(None));
        let temp = trash.create_info(os("a.txt.trashinfo.CJNPX3"), true, false).unwrap();
        trash.write_info(temp, 0, b"[Trash Info]\nPath=a.txt\n").unwrap();
        assert_eq!(trash.close_info(temp), None);
        assert_eq!(trash.rename_info(os("a.txt.trashinfo.CJNPX3"), os("a.txt.trashinfo"), false), Ok(None));
        assert_eq!(info_names(&trash), ["a.txt.trashinfo"]);
        let node = trash.node(Path::new(".Trash-1000/info/a.txt.trashinfo"));
        assert!(matches!(node, Some(TrashNode::InfoFile { size: 24, .. })), "{node:?}");
        assert_eq!(trash.trashed(os("a.txt")), Some("a.txt.trashinfo".into()));
        assert!(info_names(&trash).is_empty());
    }

    // The other order: the item moved into files/ first, the content after
    #[test]
    fn content_arriving_after_the_item_drops_the_info_at_its_rename() {
        let trash = TrashArea::new(1000);
        let placeholder = trash.create_info(os("b.txt.trashinfo"), true, false).unwrap();
        assert_eq!(trash.close_info(placeholder), None);
        assert_eq!(trash.trashed(os("b.txt")), None, "its .trashinfo isn't complete yet");
        trash.create_info(os("b.txt.trashinfo.000000"), true, false).unwrap();
        let empty_rename = trash.rename_info(os("b.txt.trashinfo.000000"), os("b.txt.trashinfo"), false);
        assert_eq!(empty_rename, Ok(None), "an empty one isn't complete");
        let temp = trash.create_info(os("b.txt.trashinfo.ABCDEF"), true, false).unwrap();
        trash.write_info(temp, 0, b"[Trash Info]\n").unwrap();
        assert_eq!(trash.close_info(temp), None, "a temp name goes with no item");
        let dropped = trash.rename_info(os("b.txt.trashinfo.ABCDEF"), os("b.txt.trashinfo"), false);
        assert_eq!(dropped, Ok(Some("b.txt.trashinfo".into())));
        assert!(info_names(&trash).is_empty());
    }

    // A trasher that writes the .trashinfo itself and closes it, then moves the item
    #[test]
    fn a_trashinfo_closed_with_content_is_complete() {
        let trash = TrashArea::new(1000);
        let id = trash.create_info(os("c.trashinfo"), true, false).unwrap();
        trash.write_info(id, 0, b"[Trash Info]\n").unwrap();
        assert_eq!(trash.read_info(id, 1, 5), b"Trash");
        assert_eq!(trash.close_info(id), None);
        assert_eq!(trash.trashed(os("c")), Some("c.trashinfo".into()));
        assert!(info_names(&trash).is_empty());
    }

    #[test]
    fn exclusive_creates_and_no_replace_renames_refuse_a_name_in_use() {
        let trash = TrashArea::new(1000);
        let id = trash.create_info(os("d.trashinfo"), true, false).unwrap();
        trash.write_info(id, 0, b"x").unwrap();
        assert_eq!(trash.create_info(os("d.trashinfo"), true, false), Err(Errno::EEXIST));
        assert_eq!(trash.create_info(os("d.trashinfo"), false, false), Ok(id));
        let size = || match trash.node(Path::new(".Trash-1000/info/d.trashinfo")) {
            Some(TrashNode::InfoFile { size, .. }) => Some(size),
            _ => None,
        };
        assert_eq!(size(), Some(1));
        assert_eq!(trash.create_info(os("d.trashinfo"), false, true), Ok(id));
        assert_eq!(size(), Some(0));
        trash.create_info(os("e.trashinfo"), true, false).unwrap();
        assert_eq!(trash.rename_info(os("e.trashinfo"), os("d.trashinfo"), true), Err(Errno::EEXIST));
        assert_eq!(trash.rename_info(os("nope"), os("d.trashinfo"), false), Err(Errno::ENOENT));
        assert_eq!(trash.remove_info(os("e.trashinfo")), Ok(()));
        assert_eq!(trash.remove_info(os("e.trashinfo")), Err(Errno::ENOENT));
        assert_eq!(info_names(&trash), ["d.trashinfo"]);
    }

    #[test]
    fn a_trashinfo_can_only_grow_so_far() {
        let trash = TrashArea::new(1000);
        let id = trash.create_info(os("f.trashinfo"), true, false).unwrap();
        assert_eq!(trash.write_info(id, INFO_MAX, b"x"), Err(Errno::EFBIG));
        assert_eq!(trash.resize_info(os("f.trashinfo"), INFO_MAX + 1), Err(Errno::EFBIG));
        assert_eq!(trash.resize_info(os("f.trashinfo"), 3), Ok(()));
        assert_eq!(trash.read_info(id, 0, 10), [0, 0, 0]);
        assert_eq!(trash.resize_info(os("g.trashinfo"), 3), Err(Errno::ENOENT));
    }

    #[test]
    fn what_a_trasher_leaves_behind_expires() {
        let trash = TrashArea::new(1000).with_ttl(Duration::from_millis(30));
        trash.create_info(os("h.trashinfo"), true, false).unwrap();
        assert_eq!(trash.trashed(os("i")), None);
        assert_eq!(info_names(&trash), ["h.trashinfo"]);
        std::thread::sleep(Duration::from_millis(60));
        assert!(info_names(&trash).is_empty());
        assert!(trash.inner().trashed.is_empty());
    }
}
