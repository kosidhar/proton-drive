// The drive as the kernel sees it: the backing store's files plus the cloud's online-only ones, with an online-only
// file downloaded when a real app opens it. What apps write goes straight to the backing store, where the daemon's
// watcher picks it up; renames and deletes go to the daemon, which carries each out whole; and Move to Trash goes
// through the drive's own .Trash-<uid> (see trash.rs).

use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::fs::{File, Metadata, OpenOptions, Permissions};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    BsdFileFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags,
    KernelConfig, LockOwner, Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData,
    ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};

use crate::daemon::{DaemonClient, DaemonError};
use crate::inodes::{Inodes, ROOT_INO};
use crate::listing::{self, Entry, Kind, VOLUME_INFO_CONTENT, VOLUME_INFO_NAME};
use crate::readers::{classify_open, opener_interrupted, process_comm, Reader};
use crate::trash::{TrashArea, TrashNode};

/// How long the kernel may keep an entry or its attributes.
const TTL: Duration = Duration::from_secs(1);
/// How long a folder's merged listing serves lookups, getattrs and readdirs.
const LISTING_TTL: Duration = Duration::from_secs(1);

pub struct DriveFs {
    state: Arc<State>,
}

impl DriveFs {
    pub fn new(backing: PathBuf, daemon: DaemonClient) -> Self {
        let notifier = Arc::new(OnceLock::new());
        let uid = unsafe { libc::getuid() };
        DriveFs {
            state: Arc::new(State {
                backing,
                daemon,
                inodes: Mutex::new(Inodes::new()),
                listings: Mutex::new(HashMap::new()),
                listing_epoch: AtomicU64::new(0),
                fetching: Mutex::new(HashSet::new()),
                fetched: Condvar::new(),
                handles: Mutex::new(HashMap::new()),
                invalidations: start_invalidator(notifier.clone()),
                notifier,
                trash: TrashArea::new(uid),
                next_fh: AtomicU64::new(1),
                uid,
                gid: unsafe { libc::getgid() },
                started: SystemTime::now(),
            }),
        }
    }

    /// Where main puts the session's notifier, once the session exists, before it runs.
    pub fn notifier_slot(&self) -> Arc<OnceLock<Notifier>> {
        self.state.notifier.clone()
    }
}

/// Shared with the threads that wait for the daemon.
struct State {
    backing: PathBuf,
    daemon: DaemonClient,
    inodes: Mutex<Inodes>,
    listings: Mutex<HashMap<PathBuf, CachedListing>>,
    /// Moves on with every change through the drive: a listing read while one happened isn't kept
    listing_epoch: AtomicU64,
    /// Folders whose listing is being fetched, and the signal that one fetch is done
    fetching: Mutex<HashSet<PathBuf>>,
    fetched: Condvar,
    handles: Mutex<HashMap<u64, Handle>>,
    notifier: Arc<OnceLock<Notifier>>,
    /// Kernel entries to drop, as (folder, name), for the thread that tells the kernel
    invalidations: Sender<(u64, OsString)>,
    trash: TrashArea,
    next_fh: AtomicU64,
    uid: u32,
    gid: u32,
    started: SystemTime,
}

struct CachedListing {
    at: Instant,
    listing: Arc<Listing>,
}

/// A folder's merged entries, indexed by name for the getattrs of a big folder.
struct Listing {
    entries: Vec<Entry>,
    by_name: HashMap<OsString, usize>,
}

impl Listing {
    fn new(entries: Vec<Entry>) -> Self {
        let by_name = entries.iter().enumerate().map(|(i, e)| (e.name.clone(), i)).collect();
        Listing { entries, by_name }
    }

    fn get(&self, name: &OsStr) -> Option<&Entry> {
        self.by_name.get(name).map(|&i| &self.entries[i])
    }
}

#[derive(Clone)]
enum Handle {
    File(Arc<File>),
    /// An online-only file opened write-only, not downloaded until something writes through it
    Deferred(Arc<Deferred>),
    VolumeInfo,
    /// A .trashinfo in the trash folder's info/
    TrashInfo(u64),
    /// The folder's rows as opendir saw them, so readdir's offsets stay valid while the folder changes.
    Dir(Arc<Vec<DirRow>>),
}

/// An online-only file opened write-only. It is downloaded only when something first writes through it (or cuts it to
/// a size short of what it is): truncate(1) opens write-only and then cuts the file to nothing, which needs nothing
/// from the cloud. A write-only open never reads, so the kernel's stale idea of the size can't cut a read short.
struct Deferred {
    ino: u64,
    flags: i32,
    state: Mutex<Settling>,
    settled: Condvar,
}

enum Settling {
    Pending,
    /// Being downloaded (or made empty) for one use; the others wait for it
    Busy,
    Open(Arc<File>),
    Failed(Errno),
}

struct DirRow {
    ino: u64,
    kind: FileType,
    name: OsString,
}

/// What a path of the drive is.
enum Node {
    Local(Metadata),
    Online(Entry),
    VolumeInfo,
    Trash(TrashNode),
}

/// What a setattr changes in the backing store (owner and group stay the user's).
#[derive(Clone, Copy)]
struct AttrChange {
    mode: Option<u32>,
    size: Option<u64>,
    atime: Option<TimeOrNow>,
    mtime: Option<TimeOrNow>,
}

// A panic in one request mustn't make every later one fail on a poisoned lock
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_root(rel: &Path) -> bool {
    rel.as_os_str().is_empty()
}

fn is_volume_info(rel: &Path) -> bool {
    rel == Path::new(VOLUME_INFO_NAME)
}

/// A backing file, opened as the app asked: its access mode, O_TRUNC, and O_APPEND (so an append lands at the end
/// even when the kernel's idea of the size is stale). A symlink there isn't part of the drive, so it isn't followed.
fn open_backing(path: &Path, flags: i32) -> std::io::Result<File> {
    let access = flags & libc::O_ACCMODE;
    OpenOptions::new()
        .read(access != libc::O_WRONLY)
        .write(access != libc::O_RDONLY)
        .custom_flags(libc::O_NOFOLLOW | (flags & (libc::O_TRUNC | libc::O_APPEND)))
        .open(path)
}

fn unix_time(secs: i64, nsecs: i64) -> SystemTime {
    let at = if secs >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_secs(secs.unsigned_abs()))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_secs(secs.unsigned_abs()))
    };
    at.and_then(|t| t.checked_add(Duration::from_nanos(nsecs.max(0) as u64))).unwrap_or(UNIX_EPOCH)
}

fn time_spec(time: Option<TimeOrNow>) -> libc::timespec {
    let (tv_sec, tv_nsec) = match time {
        None => (0, libc::UTIME_OMIT),
        Some(TimeOrNow::Now) => (0, libc::UTIME_NOW),
        Some(TimeOrNow::SpecificTime(at)) => match at.duration_since(UNIX_EPOCH) {
            Ok(d) => (d.as_secs() as i64, i64::from(d.subsec_nanos())),
            Err(before) => {
                let d = before.duration();
                match d.subsec_nanos() {
                    0 => (-(d.as_secs() as i64), 0),
                    n => (-(d.as_secs() as i64) - 1, 1_000_000_000 - i64::from(n)),
                }
            }
        },
    };
    libc::timespec { tv_sec: tv_sec as libc::time_t, tv_nsec: tv_nsec as _ }
}

/// Applies a setattr to a backing file or folder, through the app's open file when there is one (its path may have
/// moved on).
fn apply_change(path: &Path, file: Option<&File>, change: &AttrChange) -> std::io::Result<()> {
    if let Some(size) = change.size {
        match file {
            Some(file) => file.set_len(size)?,
            None => OpenOptions::new().write(true).custom_flags(libc::O_NOFOLLOW).open(path)?.set_len(size)?,
        }
    }
    if let Some(mode) = change.mode {
        let permissions = Permissions::from_mode(mode & 0o7777);
        match file {
            Some(file) => file.set_permissions(permissions)?,
            None => std::fs::set_permissions(path, permissions)?,
        }
    }
    if change.atime.is_some() || change.mtime.is_some() {
        let times = [time_spec(change.atime), time_spec(change.mtime)];
        let done = match file {
            Some(file) => unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
            None => {
                let path = CString::new(path.as_os_str().as_bytes())?;
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) }
            }
        };
        if done != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The thread that drops kernel entries. An invalidation waits for the folder's lock in the kernel, which the request
/// that changed the folder holds until its reply is in; so it is never sent from a thread whose reply is pending, and
/// this thread holds no lock of ours while it waits.
fn start_invalidator(notifier: Arc<OnceLock<Notifier>>) -> Sender<(u64, OsString)> {
    let (tx, rx) = mpsc::channel::<(u64, OsString)>();
    let _ = std::thread::Builder::new().name("invalidate".into()).spawn(move || {
        for (parent, name) in rx {
            if let Some(notifier) = notifier.get() {
                let _ = notifier.inval_entry(INodeNo(parent), &name);
            }
        }
    });
    tx
}

impl State {
    fn path_of(&self, ino: INodeNo) -> Option<PathBuf> {
        lock(&self.inodes).path_of(ino.0)
    }

    fn ino_of(&self, rel: &Path) -> u64 {
        lock(&self.inodes).ino_of(rel)
    }

    fn add_handle(&self, handle: Handle) -> FileHandle {
        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        lock(&self.handles).insert(fh, handle);
        FileHandle(fh)
    }

    fn handle(&self, fh: FileHandle) -> Option<Handle> {
        lock(&self.handles).get(&fh.0).cloned()
    }

    fn is_trash_path(&self, rel: &Path) -> bool {
        self.trash.is_trash_path(&rel.to_string_lossy())
    }

    /// The folder's merged listing: backing entries plus the daemon's, cached for a second. One fetch per folder at a
    /// time: other lookups there wait for its result rather than asking the daemon again.
    fn listing(&self, rel: &Path) -> Arc<Listing> {
        let mut fetching = lock(&self.fetching);
        loop {
            if let Some(fresh) = self.fresh_listing(rel) {
                return fresh;
            }
            if fetching.insert(rel.to_path_buf()) {
                break;
            }
            fetching = self.fetched.wait(fetching).unwrap_or_else(|e| e.into_inner());
        }
        drop(fetching);
        let _done = FetchDone { state: self, rel };
        let epoch = self.listing_epoch.load(Ordering::SeqCst);
        let local = listing::read_local(&self.backing.join(rel));
        // A path that isn't UTF-8 can't be asked about, and the cloud has nothing under it anyway
        let remote = rel.to_str().map(|r| self.daemon.children_or_empty(r)).unwrap_or_default();
        let mut entries = listing::merge_listing(local, remote, is_root(rel));
        if is_root(rel) {
            // The drive's own trash folder stands in for anything of that name, and isn't listed
            entries.retain(|e| e.name.as_os_str() != OsStr::new(self.trash.name()));
        }
        let merged = Arc::new(Listing::new(entries));
        let mut listings = lock(&self.listings);
        listings.retain(|_, c| c.at.elapsed() < LISTING_TTL);
        // Something changed through the drive while this was read: it answers this once, but isn't kept
        if self.listing_epoch.load(Ordering::SeqCst) == epoch {
            listings.insert(rel.to_path_buf(), CachedListing { at: Instant::now(), listing: merged.clone() });
        }
        merged
    }

    /// The folder's last listing, however old, without fetching one.
    fn cached_listing(&self, rel: &Path) -> Option<Arc<Listing>> {
        lock(&self.listings).get(rel).map(|c| c.listing.clone())
    }

    fn fresh_listing(&self, rel: &Path) -> Option<Arc<Listing>> {
        lock(&self.listings).get(rel).filter(|c| c.at.elapsed() < LISTING_TTL).map(|c| c.listing.clone())
    }

    fn forget_listing(&self, rel: &Path) {
        self.listing_epoch.fetch_add(1, Ordering::SeqCst);
        lock(&self.listings).remove(rel);
    }

    /// After a rename or delete: the listings of the folders these paths were in, and of the paths themselves and
    /// everything under them, are stale.
    fn forget_listings(&self, paths: &[&Path]) {
        self.listing_epoch.fetch_add(1, Ordering::SeqCst);
        lock(&self.listings)
            .retain(|folder, _| !paths.iter().any(|p| folder.starts_with(p) || p.parent() == Some(folder.as_path())));
    }

    /// Whether the folder's cached listing has an online-only entry under that name (no fetch: the kernel's lookup
    /// of the name has just refreshed it).
    fn listed_online(&self, parent: &Path, name: &OsStr) -> bool {
        self.cached_listing(parent).is_some_and(|l| l.get(name).is_some_and(|e| !e.local))
    }

    /// The online-only entry the folder's listing has under that name.
    fn online_entry(&self, parent: &Path, name: &OsStr) -> Option<Entry> {
        self.listing(parent).get(name).filter(|e| !e.local).cloned()
    }

    /// Local wins, as in the merged listing, so a backing file or folder answers without asking the daemon: local
    /// entries keep working at full speed when the daemon is down or stuck.
    fn resolve(&self, rel: &Path) -> Option<Node> {
        if is_root(rel) {
            return std::fs::metadata(&self.backing).ok().map(Node::Local);
        }
        if self.is_trash_path(rel) {
            return self.trash.node(rel).map(Node::Trash);
        }
        let (parent, name) = (rel.parent()?, rel.file_name()?);
        if listing::is_hidden_name(name) {
            return None;
        }
        if is_volume_info(rel) {
            return Some(Node::VolumeInfo);
        }
        if let Ok(meta) = std::fs::symlink_metadata(self.backing.join(rel)) {
            if meta.is_file() || meta.is_dir() {
                return Some(Node::Local(meta));
            }
        }
        self.online_entry(parent, name).map(Node::Online)
    }

    fn attr(&self, ino: u64, node: &Node) -> FileAttr {
        let virtual_attr = |kind: FileType, perm: u16, size: u64, mtime: SystemTime| FileAttr {
            ino: INodeNo(ino),
            size,
            blocks: 0,
            atime: mtime,
            mtime,
            ctime: mtime,
            crtime: mtime,
            kind,
            perm,
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        };
        match node {
            Node::Local(meta) => {
                let mtime = unix_time(meta.mtime(), meta.mtime_nsec());
                FileAttr {
                    ino: INodeNo(ino),
                    size: meta.len(),
                    blocks: meta.blocks(),
                    atime: unix_time(meta.atime(), meta.atime_nsec()),
                    mtime,
                    ctime: unix_time(meta.ctime(), meta.ctime_nsec()),
                    crtime: mtime,
                    kind: if meta.is_dir() { FileType::Directory } else { FileType::RegularFile },
                    perm: (meta.mode() & 0o7777) as u16,
                    // 1 for folders too: their backing link count misses online-only subfolders, and 1 tells find
                    // not to count on it
                    nlink: 1,
                    uid: self.uid,
                    gid: self.gid,
                    rdev: 0,
                    blksize: meta.blksize() as u32,
                    flags: 0,
                }
            }
            Node::Online(entry) => match entry.kind {
                Kind::File => virtual_attr(FileType::RegularFile, 0o644, entry.size, entry.mtime),
                Kind::Folder => virtual_attr(FileType::Directory, 0o755, 0, entry.mtime),
            },
            Node::VolumeInfo => {
                virtual_attr(FileType::RegularFile, 0o444, VOLUME_INFO_CONTENT.len() as u64, self.started)
            }
            // GIO takes the trash folder only as a folder of the user's own; 0700 as it would make it
            Node::Trash(TrashNode::InfoFile { size, mtime, .. }) => {
                virtual_attr(FileType::RegularFile, 0o600, *size, *mtime)
            }
            Node::Trash(_) => virtual_attr(FileType::Directory, 0o700, 0, self.started),
        }
    }

    /// Asks the daemon to download an online-only file into the backing store, giving up with EINTR as soon as
    /// thread `tid` (the app waiting for it) does: the daemon keeps downloading, so a later use finds the file here.
    fn hydrate(&self, tid: u32, rel: &Path) -> Result<(), Errno> {
        // An online-only entry came from a UTF-8 listing, so its path is UTF-8
        let Some(rel_str) = rel.to_str() else { return Err(Errno::EIO) };
        if let Err(err) = self.daemon.hydrate(rel_str, &|| opener_interrupted(tid)) {
            if err.errno == libc::EINTR {
                eprintln!("protondrive-vfs: stopped waiting for {rel_str:?}: the app waiting for it gave up");
                return Err(Errno::EINTR);
            }
            eprintln!("protondrive-vfs: couldn't download {rel_str:?}: {}", err.message);
            // Only what open(2) can sensibly report from a download
            let errno = if matches!(err.errno, libc::ENOENT | libc::EACCES) { err.errno } else { libc::EIO };
            return Err(Errno::from_i32(errno));
        }
        if let Some(parent) = rel.parent() {
            self.forget_listing(parent); // it is local now
        }
        Ok(())
    }

    /// The kernel still holds the listed size of a file just downloaded, which can be short of it (0 when the cloud
    /// claims none), and would cut the first read to it: drop its attributes (offset -1 leaves the pages alone).
    fn refresh_size(&self, ino: u64) {
        if let Some(notifier) = self.notifier.get() {
            let _ = notifier.inval_inode(INodeNo(ino), -1, 0);
        }
    }

    /// Runs on its own thread: waits for the daemon's download, then opens the file it placed in the backing store as
    /// the app asked (read-only, or read-write).
    fn hydrate_and_open(&self, ino: u64, tid: u32, rel: PathBuf, flags: i32, reply: ReplyOpen) {
        if let Err(errno) = self.hydrate(tid, &rel) {
            return reply.error(errno);
        }
        match open_backing(&self.backing.join(&rel), flags) {
            Ok(file) => {
                self.refresh_size(ino);
                reply.opened(self.add_handle(Handle::File(Arc::new(file))), FopenFlags::empty())
            }
            Err(err) => {
                eprintln!("protondrive-vfs: {rel:?} was downloaded but won't open: {err}");
                reply.error(Errno::EIO)
            }
        }
    }

    /// The backing folder for `rel`, made (with any missing above it, 0755) when only the cloud has it: a file saved
    /// into an online-only folder needs somewhere to go. The daemon takes such a folder for the cloud's own.
    fn backing_folder(&self, rel: &Path) -> Result<(), Errno> {
        match self.resolve(rel) {
            Some(Node::Local(meta)) if meta.is_dir() => Ok(()),
            Some(Node::Online(entry)) if entry.kind == Kind::Folder => {
                std::fs::DirBuilder::new().recursive(true).mode(0o755).create(self.backing.join(rel))?;
                if let Some(parent) = rel.parent() {
                    self.forget_listing(parent);
                }
                Ok(())
            }
            Some(Node::Trash(_)) => Err(Errno::EPERM),
            Some(_) => Err(Errno::ENOTDIR),
            None => Err(Errno::ENOENT),
        }
    }

    /// An online-only file about to be cut to nothing: an empty file here stands for it, with nothing from the cloud.
    /// One already here is left as it is.
    fn make_empty(&self, rel: &Path) -> Result<(), Errno> {
        let parent = rel.parent().ok_or(Errno::ENOENT)?;
        self.backing_folder(parent)?;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o644)
            .open(self.backing.join(rel))?;
        self.forget_listing(parent);
        Ok(())
    }

    /// The backing file behind a deferred open, put there now: downloaded, or made empty when it is about to be cut
    /// to nothing anyway. Uses that come at once wait for the first; a failed download fails every later use too, but
    /// an app that gave up waiting leaves it for the next use to try again. Never on a session thread.
    fn settle(&self, fh: FileHandle, deferred: &Deferred, tid: u32, empty: bool) -> Result<Arc<File>, Errno> {
        let mut state = lock(&deferred.state);
        loop {
            match &*state {
                Settling::Open(file) => return Ok(file.clone()),
                Settling::Failed(errno) => return Err(*errno),
                Settling::Busy => state = deferred.settled.wait(state).unwrap_or_else(|e| e.into_inner()),
                Settling::Pending => break,
            }
        }
        *state = Settling::Busy;
        drop(state);
        let outcome = self.settle_now(deferred, tid, empty);
        let mut state = lock(&deferred.state);
        *state = match &outcome {
            Ok(file) => Settling::Open(file.clone()),
            Err(errno) if *errno == Errno::EINTR => Settling::Pending,
            Err(errno) => Settling::Failed(*errno),
        };
        deferred.settled.notify_all();
        drop(state);
        if let Ok(file) = &outcome {
            // Later uses of this open go straight to the file
            if let Some(handle) = lock(&self.handles).get_mut(&fh.0) {
                *handle = Handle::File(file.clone());
            }
        }
        outcome
    }

    fn settle_now(&self, deferred: &Deferred, tid: u32, empty: bool) -> Result<Arc<File>, Errno> {
        // Where the file is now: a rename meanwhile took its number along
        let rel = self.path_of(INodeNo(deferred.ino)).ok_or(Errno::ENOENT)?;
        let path = self.backing.join(&rel);
        // Something else may have put it here meanwhile
        match open_backing(&path, deferred.flags) {
            Ok(file) => return Ok(Arc::new(file)),
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
            Err(_) => {}
        }
        if empty {
            self.make_empty(&rel)?;
        } else {
            self.hydrate(tid, &rel)?;
        }
        let file = open_backing(&path, deferred.flags).map_err(|err| {
            eprintln!("protondrive-vfs: {rel:?} is here now but won't open: {err}");
            Errno::EIO
        })?;
        if !empty {
            self.refresh_size(deferred.ino);
        }
        Ok(Arc::new(file))
    }

    /// Applies a setattr to the backing store and answers with the attributes that result.
    fn reply_after_change(&self, ino: INodeNo, file: Option<&File>, change: &AttrChange, reply: ReplyAttr) {
        let Some(rel) = self.path_of(ino) else { return reply.error(Errno::ENOENT) };
        let path = self.backing.join(&rel);
        let meta = apply_change(&path, file, change).and_then(|()| match file {
            Some(file) => file.metadata(),
            None => std::fs::symlink_metadata(&path),
        });
        match meta {
            Ok(meta) => reply.attr(&TTL, &self.attr(ino.0, &Node::Local(meta))),
            Err(err) => reply.error(err.into()),
        }
    }

    /// Runs `work` on a thread of its own, for a call to the daemon that can take a while: never on a session thread.
    /// If the thread can't start, the reply that `work` holds is dropped, which answers EIO.
    fn on_worker(self: &Arc<Self>, name: &str, work: impl FnOnce(&State) + Send + 'static) {
        let state = self.clone();
        let _ = std::thread::Builder::new().name(name.into()).spawn(move || work(&state));
    }

    /// The errno for a rename or delete the daemon refused: its own, when it is one this call can give.
    fn refused(&self, what: &str, err: DaemonError, allowed: &[i32]) -> Errno {
        let errno = if allowed.contains(&err.errno) { err.errno } else { libc::EIO };
        if errno == libc::EIO {
            eprintln!("protondrive-vfs: couldn't {what}: {}", err.message);
        }
        Errno::from_i32(errno)
    }

    /// After a rename through the drive: its numbers follow it, and the listings it was in or under are stale.
    fn moved(&self, from: &Path, to: &Path) {
        lock(&self.inodes).rename(from, to);
        self.forget_listings(&[from, to]);
    }

    /// After a delete through the drive: its numbers go stale, and so do the listings it was in or under.
    fn removed(&self, rel: &Path) {
        lock(&self.inodes).remove(rel);
        self.forget_listings(&[rel]);
    }

    /// Unlink and rmdir: the daemon deletes the item (rmdir only an empty folder), here and later in the cloud.
    fn delete(self: &Arc<Self>, rel: PathBuf, only_if_empty: bool, reply: ReplyEmpty) {
        // The daemon's paths are UTF-8: one that isn't can't be synced, renamed or deleted through the drive
        let Some(rel_str) = rel.to_str().map(String::from) else { return reply.error(Errno::EILSEQ) };
        self.on_worker("delete", move |s| match s.daemon.delete(&rel_str, only_if_empty) {
            Ok(()) => {
                s.removed(&rel);
                reply.ok()
            }
            Err(err) => {
                let allowed: &[i32] = if only_if_empty {
                    &[libc::ENOENT, libc::EACCES, libc::ENOTEMPTY, libc::EIO]
                } else {
                    &[libc::ENOENT, libc::EACCES, libc::EIO]
                };
                reply.error(s.refused(&format!("delete {rel_str:?}"), err, allowed))
            }
        });
    }

    /// GIO's Move to Trash: the item it moves into the trash folder's files/ is deleted through the daemon, which
    /// keeps it in the cloud's trash. files/ stays empty.
    fn trash_item(self: &Arc<Self>, from: PathBuf, files_ino: u64, name: OsString, reply: ReplyEmpty) {
        let Some(from_str) = from.to_str().map(String::from) else { return reply.error(Errno::EILSEQ) };
        self.on_worker("trash", move |s| match s.daemon.delete(&from_str, false) {
            Ok(()) => {
                s.removed(&from);
                let dropped = s.trash.trashed(&name);
                reply.ok();
                // The kernel has moved the item's entry into files/, which holds nothing
                s.invalidate(files_ino, name);
                if let Some(info) = dropped {
                    s.info_dropped(info);
                }
            }
            Err(err) => {
                let allowed = [libc::ENOENT, libc::EACCES, libc::EIO];
                reply.error(s.refused(&format!("move {from_str:?} to the trash"), err, &allowed))
            }
        });
    }

    fn trash_info_dir(&self) -> PathBuf {
        Path::new(self.trash.name()).join("info")
    }

    /// Asks the kernel to drop its entry for `name` in folder `parent`. Only once the reply that changed it is sent.
    fn invalidate(&self, parent: u64, name: OsString) {
        let _ = self.invalidations.send((parent, name));
    }

    /// A .trashinfo that has gone: its number goes stale, and the kernel's entry for it goes.
    fn info_dropped(&self, name: OsString) {
        let dir = self.trash_info_dir();
        lock(&self.inodes).remove(&dir.join(&name));
        self.invalidate(self.ino_of(&dir), name);
    }
}

/// Ends a listing fetch, even one that panics: the folder is no longer being fetched, and its waiters wake.
struct FetchDone<'a> {
    state: &'a State,
    rel: &'a Path,
}

impl Drop for FetchDone<'_> {
    fn drop(&mut self) {
        lock(&self.state.fetching).remove(self.rel);
        self.state.fetched.notify_all();
    }
}

/// pread until the buffer is full or the file ends.
fn read_full_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    let mut done = 0;
    while done < buf.len() {
        match file.read_at(&mut buf[done..], offset + done as u64) {
            Ok(0) => break,
            Ok(n) => done += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(done)
}

fn reply_read(file: &File, offset: u64, size: u32, reply: ReplyData) {
    let mut buf = vec![0u8; size as usize];
    match read_full_at(file, &mut buf, offset) {
        Ok(n) => reply.data(&buf[..n]),
        Err(err) => reply.error(err.into()),
    }
}

fn reply_write(file: &File, offset: u64, data: &[u8], reply: ReplyWrite) {
    match file.write_all_at(data, offset) {
        Ok(()) => reply.written(data.len() as u32),
        Err(err) => reply.error(err.into()),
    }
}

impl Filesystem for DriveFs {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        // Lookups and readdirs in one folder needn't wait for each other; a kernel without it still works
        let _ = config.add_capabilities(InitFlags::FUSE_PARALLEL_DIROPS);
        // O_TRUNC comes with the open, so an online-only file opened to be overwritten isn't downloaded first
        let _ = config.add_capabilities(InitFlags::FUSE_ATOMIC_O_TRUNC);
        Ok(())
    }

    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        match s.resolve(&rel) {
            Some(node) => reply.entry(&TTL, &s.attr(s.ino_of(&rel), &node), Generation(0)),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, fh: Option<FileHandle>, reply: ReplyAttr) {
        let s = &self.state;
        // An open file answers for itself, wherever its path went
        if let Some(Handle::File(file)) = fh.and_then(|fh| s.handle(fh)) {
            if let Ok(meta) = file.metadata() {
                return reply.attr(&TTL, &s.attr(ino.0, &Node::Local(meta)));
            }
        }
        match s.path_of(ino).and_then(|rel| s.resolve(&rel)) {
            Some(node) => reply.attr(&TTL, &s.attr(ino.0, &node)),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn setattr(
        &self,
        req: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let s = &self.state;
        let Some(rel) = s.path_of(ino) else { return reply.error(Errno::ENOENT) };
        // Everything in the drive is the user's: owner and group can only be "changed" to what they are
        if uid.is_some_and(|u| u != s.uid) || gid.is_some_and(|g| g != s.gid) {
            return reply.error(Errno::EPERM);
        }
        if s.is_trash_path(&rel) {
            // GIO sets a .trashinfo's owner and mode as it writes one: only a size means anything there
            let resized = match (s.trash.info_name(&rel), size) {
                (Some(name), Some(size)) => s.trash.resize_info(name, size),
                (None, Some(_)) => Err(Errno::EPERM),
                _ => Ok(()),
            };
            return match resized.and_then(|()| s.resolve(&rel).ok_or(Errno::ENOENT)) {
                Ok(node) => reply.attr(&TTL, &s.attr(ino.0, &node)),
                Err(errno) => reply.error(errno),
            };
        }
        if is_volume_info(&rel) {
            return reply.error(Errno::EPERM);
        }
        let change = AttrChange { mode, size, atime, mtime };
        // Through the app's open file (ftruncate)
        match fh.map(|fh| (fh, s.handle(fh))) {
            Some((_, Some(Handle::File(file)))) => return s.reply_after_change(ino, Some(&file), &change, reply),
            Some((fh, Some(Handle::Deferred(deferred)))) => {
                let tid = req.pid();
                return s.on_worker("download", move |s| match s.settle(fh, &deferred, tid, size == Some(0)) {
                    Ok(file) => s.reply_after_change(ino, Some(&file), &change, reply),
                    Err(errno) => reply.error(errno),
                });
            }
            _ => {}
        }
        match s.resolve(&rel) {
            Some(Node::Local(_)) => s.reply_after_change(ino, None, &change, reply),
            // Made here to take the change, as when a file is saved into it
            Some(Node::Online(entry)) if entry.kind == Kind::Folder => match s.backing_folder(&rel) {
                Ok(()) => s.reply_after_change(ino, None, &change, reply),
                Err(errno) => reply.error(errno),
            },
            Some(Node::Online(_)) if size == Some(0) => match s.make_empty(&rel) {
                Ok(()) => s.reply_after_change(ino, None, &change, reply),
                Err(errno) => reply.error(errno),
            },
            // Anything else changes the file as it is in the cloud, which must be here first
            Some(Node::Online(_)) => {
                if classify_open(&process_comm(req.pid()).unwrap_or_default(), 0) == Reader::Background {
                    return reply.error(Errno::EACCES);
                }
                let tid = req.pid();
                s.on_worker("download", move |s| match s.hydrate(tid, &rel) {
                    Ok(()) => s.reply_after_change(ino, None, &change, reply),
                    Err(errno) => reply.error(errno),
                });
            }
            _ => reply.error(Errno::ENOENT),
        }
    }

    // Only files and folders sync
    fn mknod(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        _rdev: u32,
        reply: ReplyEntry,
    ) {
        reply.error(Errno::EPERM);
    }

    fn symlink(&self, _req: &Request, _parent: INodeNo, _link_name: &OsStr, _target: &Path, reply: ReplyEntry) {
        reply.error(Errno::EPERM);
    }

    fn link(&self, _req: &Request, _ino: INodeNo, _newparent: INodeNo, _newname: &OsStr, reply: ReplyEntry) {
        reply.error(Errno::EPERM);
    }

    fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, _umask: u32, reply: ReplyEntry) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::EPERM); // the daemon's own names
        }
        if s.is_trash_path(&rel) {
            // GIO makes files/ and info/ if they are missing, and they never are
            return reply.error(if s.trash.node(&rel).is_some() { Errno::EEXIST } else { Errno::EPERM });
        }
        if is_volume_info(&rel) || s.listed_online(&parent_rel, name) {
            return reply.error(Errno::EEXIST);
        }
        if name.to_str().is_none() {
            return reply.error(Errno::EILSEQ); // the daemon couldn't sync it, or rename or delete it later
        }
        if let Err(errno) = s.backing_folder(&parent_rel) {
            return reply.error(errno);
        }
        let path = s.backing.join(&rel);
        let made = std::fs::DirBuilder::new().mode(mode & 0o7777).create(&path);
        match made.and_then(|()| std::fs::symlink_metadata(&path)) {
            Ok(meta) => {
                s.forget_listing(&parent_rel);
                reply.entry(&TTL, &s.attr(s.ino_of(&rel), &Node::Local(meta)), Generation(0))
            }
            Err(err) => reply.error(err.into()),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::ENOENT);
        }
        if s.is_trash_path(&rel) {
            return match s.trash.info_name(&rel) {
                // GIO takes back the .trashinfo of an item it failed to trash
                Some(info) => match s.trash.remove_info(info) {
                    Ok(()) => {
                        lock(&s.inodes).remove(&rel);
                        reply.ok()
                    }
                    Err(errno) => reply.error(errno),
                },
                None if s.trash.node(&rel).is_some() => reply.error(Errno::EPERM),
                None => reply.error(Errno::ENOENT),
            };
        }
        if is_volume_info(&rel) {
            return reply.error(Errno::EPERM);
        }
        s.delete(rel, false, reply);
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::ENOENT);
        }
        if s.is_trash_path(&rel) {
            return reply.error(if s.trash.node(&rel).is_some() { Errno::EPERM } else { Errno::ENOENT });
        }
        if is_volume_info(&rel) {
            return reply.error(Errno::EPERM);
        }
        s.delete(rel, true, reply);
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let s = &self.state;
        // No exchange, and nothing else this drive doesn't know
        if !flags.difference(RenameFlags::RENAME_NOREPLACE).is_empty() {
            return reply.error(Errno::EINVAL);
        }
        let no_replace = flags.contains(RenameFlags::RENAME_NOREPLACE);
        let (Some(from_parent), Some(to_parent)) = (s.path_of(parent), s.path_of(newparent)) else {
            return reply.error(Errno::ENOENT);
        };
        let (from, to) = (from_parent.join(name), to_parent.join(newname));
        if listing::is_hidden_name(name) {
            return reply.error(Errno::ENOENT);
        }
        if listing::is_hidden_name(newname) {
            return reply.error(Errno::EPERM); // the daemon's own names
        }
        let from_trash = s.is_trash_path(&from);
        if !from_trash && s.trash.trashed_source(&to.to_string_lossy()) {
            if is_volume_info(&from) {
                return reply.error(Errno::EPERM);
            }
            return s.trash_item(from, newparent.0, newname.to_os_string(), reply);
        }
        if from_trash && s.trash.node(&from).is_none() {
            return reply.error(Errno::ENOENT); // files/ never holds anything to move out
        }
        if from_trash || s.is_trash_path(&to) {
            // Only GIO putting a .trashinfo's content in place, inside info/
            let (Some(info_from), Some(info_to)) = (s.trash.info_name(&from), s.trash.info_name(&to)) else {
                return reply.error(Errno::EPERM);
            };
            return match s.trash.rename_info(info_from, info_to, no_replace) {
                Ok(dropped) => {
                    lock(&s.inodes).rename(&from, &to);
                    reply.ok();
                    if let Some(info) = dropped {
                        s.info_dropped(info);
                    }
                }
                Err(errno) => reply.error(errno),
            };
        }
        if is_volume_info(&from) || is_volume_info(&to) {
            return reply.error(Errno::EPERM);
        }
        let (Some(from_str), Some(to_str)) = (from.to_str().map(String::from), to.to_str().map(String::from)) else {
            return reply.error(Errno::EILSEQ); // the daemon's paths are UTF-8
        };
        s.on_worker("rename", move |s| match s.daemon.rename(&from_str, &to_str, no_replace) {
            Ok(()) => {
                s.moved(&from, &to);
                reply.ok()
            }
            Err(err) => {
                let allowed = [libc::ENOENT, libc::EEXIST, libc::EACCES, libc::EXDEV, libc::EIO];
                reply.error(s.refused(&format!("rename {from_str:?} to {to_str:?}"), err, &allowed))
            }
        });
    }

    fn open(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let s = &self.state;
        let Some(rel) = s.path_of(ino) else { return reply.error(Errno::ENOENT) };
        let writing = flags.acc_mode() != OpenAccMode::O_RDONLY;
        let truncate = flags.0 & libc::O_TRUNC != 0;
        if s.is_trash_path(&rel) {
            return match s.trash.node(&rel) {
                Some(TrashNode::InfoFile { id, .. }) => {
                    if let (true, Some(name)) = (truncate, rel.file_name()) {
                        let _ = s.trash.resize_info(name, 0);
                    }
                    reply.opened(s.add_handle(Handle::TrashInfo(id)), FopenFlags::empty())
                }
                Some(_) => reply.error(Errno::EISDIR),
                None => reply.error(Errno::ENOENT),
            };
        }
        if is_volume_info(&rel) {
            if writing || truncate {
                return reply.error(Errno::EACCES);
            }
            return reply.opened(s.add_handle(Handle::VolumeInfo), FopenFlags::empty());
        }
        let path = s.backing.join(&rel);
        // Whatever the listing said a moment ago, a backing file opens as it is
        match open_backing(&path, flags.0) {
            Ok(file) => return reply.opened(s.add_handle(Handle::File(Arc::new(file))), FopenFlags::empty()),
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return reply.error(err.into()),
            Err(_) => {}
        }
        let (Some(parent), Some(name)) = (rel.parent(), rel.file_name()) else { return reply.error(Errno::ENOENT) };
        let online_file = |l: &Listing| l.get(name).is_some_and(|e| !e.local && e.kind == Kind::File);
        if truncate {
            // Overwritten from the start: an empty file here does, with nothing from the cloud
            if !s.online_entry(parent, name).is_some_and(|e| e.kind == Kind::File) {
                return reply.error(Errno::ENOENT);
            }
            return match s.make_empty(&rel).and_then(|()| open_backing(&path, flags.0).map_err(Errno::from)) {
                Ok(file) => reply.opened(s.add_handle(Handle::File(Arc::new(file))), FopenFlags::empty()),
                Err(errno) => reply.error(errno),
            };
        }
        // Who is opening comes first: a background reader or a sniff mustn't even refresh the listing. An opener whose
        // comm can't be read counts as an app
        let comm = process_comm(req.pid()).unwrap_or_default();
        match classify_open(&comm, flags.0) {
            Reader::Background | Reader::Sniff => {
                // The cached listing, however old, says whether the file is there at all; without one, it is
                // refused all the same
                let gone = s.cached_listing(parent).is_some_and(|l| !online_file(&l));
                reply.error(if gone { Errno::ENOENT } else { Errno::EACCES })
            }
            Reader::App => {
                // With the daemon down and the listing expired, the cloud's entries are gone from the listing: the
                // file is then ENOENT, as the local-only listing the user sees says, rather than EIO
                if !s.online_entry(parent, name).is_some_and(|e| e.kind == Kind::File) {
                    return reply.error(Errno::ENOENT);
                }
                if flags.acc_mode() == OpenAccMode::O_WRONLY {
                    // Downloaded by the first write through it, if one comes (see Deferred)
                    let deferred = Deferred {
                        ino: ino.0,
                        flags: flags.0,
                        state: Mutex::new(Settling::Pending),
                        settled: Condvar::new(),
                    };
                    return reply.opened(s.add_handle(Handle::Deferred(Arc::new(deferred))), FopenFlags::empty());
                }
                // Read-only or read-write, it is downloaded as it opens, so the first read sees all of it. Never on a
                // session thread: the download can take minutes. If the thread can't start, the dropped reply answers
                // EIO
                let (state, tid) = (self.state.clone(), req.pid());
                let _ = std::thread::Builder::new()
                    .name("hydrate".into())
                    .spawn(move || state.hydrate_and_open(ino.0, tid, rel, flags.0, reply));
            }
        }
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::EPERM); // the daemon's own names
        }
        let (exclusive, truncate) = (flags & libc::O_EXCL != 0, flags & libc::O_TRUNC != 0);
        if s.is_trash_path(&rel) {
            // Only GIO's .trashinfo files, in info/
            let Some(info) = s.trash.info_name(&rel) else {
                return reply.error(if s.trash.node(&rel).is_some() { Errno::EEXIST } else { Errno::EPERM });
            };
            let created = s.trash.create_info(info, exclusive, truncate).and_then(|id| match s.resolve(&rel) {
                Some(node) => Ok((id, node)),
                None => Err(Errno::EIO),
            });
            return match created {
                Ok((id, node)) => {
                    let attr = s.attr(s.ino_of(&rel), &node);
                    reply.created(&TTL, &attr, Generation(0), s.add_handle(Handle::TrashInfo(id)), FopenFlags::empty())
                }
                Err(errno) => reply.error(errno),
            };
        }
        if is_volume_info(&rel) || (exclusive && s.listed_online(&parent_rel, name)) {
            return reply.error(Errno::EEXIST);
        }
        if name.to_str().is_none() {
            return reply.error(Errno::EILSEQ); // the daemon couldn't sync it, or rename or delete it later
        }
        if let Err(errno) = s.backing_folder(&parent_rel) {
            return reply.error(errno);
        }
        let access = flags & libc::O_ACCMODE;
        let opened = OpenOptions::new()
            .read(access != libc::O_WRONLY)
            .write(access != libc::O_RDONLY)
            .custom_flags(libc::O_CREAT | libc::O_NOFOLLOW | (flags & (libc::O_EXCL | libc::O_TRUNC | libc::O_APPEND)))
            .mode(mode & 0o7777)
            .open(s.backing.join(&rel));
        match opened.and_then(|file| file.metadata().map(|meta| (file, meta))) {
            Ok((file, meta)) => {
                s.forget_listing(&parent_rel);
                let attr = s.attr(s.ino_of(&rel), &Node::Local(meta));
                let fh = s.add_handle(Handle::File(Arc::new(file)));
                reply.created(&TTL, &attr, Generation(0), fh, FopenFlags::empty())
            }
            Err(err) => reply.error(err.into()),
        }
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let s = &self.state;
        match s.handle(fh) {
            Some(Handle::File(file)) => reply_read(&file, offset, size, reply),
            Some(Handle::VolumeInfo) => {
                let start = (offset as usize).min(VOLUME_INFO_CONTENT.len());
                let end = start.saturating_add(size as usize).min(VOLUME_INFO_CONTENT.len());
                reply.data(&VOLUME_INFO_CONTENT[start..end])
            }
            Some(Handle::TrashInfo(id)) => reply.data(&s.trash.read_info(id, offset, size)),
            // A deferred open is write-only
            _ => reply.error(Errno::EBADF),
        }
    }

    fn write(
        &self,
        req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let s = &self.state;
        match s.handle(fh) {
            Some(Handle::File(file)) => reply_write(&file, offset, data, reply),
            Some(Handle::TrashInfo(id)) => match s.trash.write_info(id, offset, data) {
                Ok(()) => reply.written(data.len() as u32),
                Err(errno) => reply.error(errno),
            },
            Some(Handle::Deferred(deferred)) => {
                let (tid, data) = (req.pid(), data.to_vec());
                s.on_worker("download", move |s| match s.settle(fh, &deferred, tid, false) {
                    Ok(file) => reply_write(&file, offset, &data, reply),
                    Err(errno) => reply.error(errno),
                });
            }
            _ => reply.error(Errno::EBADF),
        }
    }

    // Writes go straight to the backing file: nothing is held back to flush
    fn flush(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
        reply.ok();
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, datasync: bool, reply: ReplyEmpty) {
        match self.state.handle(fh) {
            Some(Handle::File(file)) => match if datasync { file.sync_data() } else { file.sync_all() } {
                Ok(()) => reply.ok(),
                Err(err) => reply.error(err.into()),
            },
            Some(_) => reply.ok(), // nothing on disk of its own
            None => reply.error(Errno::EBADF),
        }
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let s = &self.state;
        let closed = lock(&s.handles).remove(&fh.0);
        let dropped = match closed {
            Some(Handle::TrashInfo(id)) => s.trash.close_info(id),
            _ => None,
        };
        reply.ok();
        if let Some(info) = dropped {
            s.info_dropped(info);
        }
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let s = &self.state;
        let Some(rel) = s.path_of(ino) else { return reply.error(Errno::ENOENT) };
        let entries: Vec<(OsString, FileType)> = if s.is_trash_path(&rel) {
            if !matches!(s.trash.node(&rel), Some(TrashNode::Root | TrashNode::Files | TrashNode::Info)) {
                return reply.error(Errno::ENOTDIR);
            }
            let kind = |folder: bool| if folder { FileType::Directory } else { FileType::RegularFile };
            s.trash.list(&rel).into_iter().map(|(name, folder)| (name, kind(folder))).collect()
        } else {
            let kind = |e: &Entry| if e.kind == Kind::Folder { FileType::Directory } else { FileType::RegularFile };
            s.listing(&rel).entries.iter().map(|e| (e.name.clone(), kind(e))).collect()
        };
        let parent_ino = rel.parent().map_or(ROOT_INO, |p| s.ino_of(p));
        let mut rows = vec![
            DirRow { ino: ino.0, kind: FileType::Directory, name: ".".into() },
            DirRow { ino: parent_ino, kind: FileType::Directory, name: "..".into() },
        ];
        let mut inodes = lock(&s.inodes);
        for (name, kind) in entries {
            rows.push(DirRow { ino: inodes.ino_of(&rel.join(&name)), kind, name });
        }
        drop(inodes);
        reply.opened(s.add_handle(Handle::Dir(Arc::new(rows))), FopenFlags::empty());
    }

    fn readdir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let rows = match self.state.handle(fh) {
            Some(Handle::Dir(rows)) => rows,
            _ => return reply.error(Errno::EBADF),
        };
        for (i, row) in rows.iter().enumerate().skip(offset as usize) {
            // Each row's offset is where the next readdir starts
            if reply.add(INodeNo(row.ino), (i + 1) as u64, row.kind, &row.name) {
                break;
            }
        }
        reply.ok();
    }

    fn releasedir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags, reply: ReplyEmpty) {
        lock(&self.state.handles).remove(&fh.0);
        reply.ok();
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let Ok(path) = CString::new(self.state.backing.as_os_str().as_bytes()) else {
            return reply.error(Errno::EIO);
        };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut st) } != 0 {
            return reply.error(std::io::Error::last_os_error().into());
        }
        reply.statfs(
            st.f_blocks,
            st.f_bfree,
            st.f_bavail,
            st.f_files,
            st.f_ffree,
            st.f_bsize as u32,
            st.f_namemax as u32,
            st.f_frsize as u32,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;

    // A drive over a temp backing dir, with a daemon that takes 300 ms to list `a.txt` in any folder and counts the
    // listings it is asked for
    fn drive_with_slow_daemon(name: &str) -> (DriveFs, PathBuf, Arc<AtomicUsize>) {
        let root = std::env::temp_dir().join(format!("protondrive-vfs-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("backing")).unwrap();
        let socket = root.join("d.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let fetches = Arc::new(AtomicUsize::new(0));
        let counted = fetches.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let _ = stream.read(&mut [0u8; 4096]);
                    std::thread::sleep(Duration::from_millis(300)); // a slow listing
                    let body = r#"{"entries":[{"name":"a.txt","type":"file","size":1,"mtimeMs":0}]}"#;
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                });
            }
        });
        (DriveFs::new(root.join("backing"), DaemonClient::new(socket)), root, fetches)
    }

    #[test]
    fn lookups_in_one_folder_share_a_single_listing_fetch() {
        let (drive, root, fetches) = drive_with_slow_daemon("shared");
        let lookups: Vec<_> = (0..4)
            .map(|_| {
                let state = drive.state.clone();
                std::thread::spawn(move || state.listing(Path::new("")).get(OsStr::new("a.txt")).is_some())
            })
            .collect();
        let found: Vec<bool> = lookups.into_iter().map(|t| t.join().unwrap()).collect();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found, [true; 4]);
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_listing_read_while_the_drive_changed_isnt_kept() {
        let (drive, root, fetches) = drive_with_slow_daemon("epoch");
        let state = drive.state.clone();
        let fetch = std::thread::spawn(move || state.listing(Path::new("")).get(OsStr::new("a.txt")).is_some());
        std::thread::sleep(Duration::from_millis(100)); // the fetch is waiting for the daemon
        drive.state.forget_listings(&[Path::new("a.txt")]);
        let answered = fetch.join().unwrap();
        let kept = drive.state.fresh_listing(Path::new("")).is_some();
        drive.state.listing(Path::new(""));
        let kept_next = drive.state.fresh_listing(Path::new("")).is_some();
        let _ = std::fs::remove_dir_all(&root);
        assert!(answered, "the fetch still answers its own caller");
        assert!(!kept, "but what it read may predate the change");
        assert!(kept_next);
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn setattr_times_become_timespecs() {
        assert_eq!(time_spec(None).tv_nsec, libc::UTIME_OMIT);
        assert_eq!(time_spec(Some(TimeOrNow::Now)).tv_nsec, libc::UTIME_NOW);
        let after = time_spec(Some(TimeOrNow::SpecificTime(UNIX_EPOCH + Duration::from_millis(1500))));
        assert_eq!((after.tv_sec, after.tv_nsec), (1, 500_000_000));
        let before = time_spec(Some(TimeOrNow::SpecificTime(UNIX_EPOCH - Duration::from_millis(1200))));
        assert_eq!((before.tv_sec, before.tv_nsec), (-2, 800_000_000));
    }
}
