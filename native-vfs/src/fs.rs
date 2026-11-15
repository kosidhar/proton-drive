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
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    BsdFileFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags,
    KernelConfig, LockOwner, Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData,
    ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};

use crate::daemon::{DaemonClient, DaemonError, Removal, Space};
use crate::inodes::{Inodes, ROOT_INO};
use crate::listing::{self, Entry, Kind, VOLUME_INFO_CONTENT, VOLUME_INFO_NAME};
use crate::readers::{classify_open, opener_interrupted, process_comm, Reader};
use crate::trash::{TrashArea, TrashNode};
use crate::unlinker::Unlinker;

/// How long the kernel may keep an entry or its attributes.
const TTL: Duration = Duration::from_secs(1);
/// How long a folder's merged listing serves lookups, getattrs and readdirs.
const LISTING_TTL: Duration = Duration::from_secs(1);
/// How often the drive asks the daemon for the account's storage, and how soon again while it can't say (#181).
const SPACE_REFRESH: Duration = Duration::from_secs(120);
const SPACE_RETRY: Duration = Duration::from_secs(10);
/// How often a use of a deferred open that waits for another asks whether its own app gave up.
const SETTLE_CHECK: Duration = Duration::from_millis(500);

pub struct DriveFs {
    state: Arc<State>,
}

impl DriveFs {
    pub fn new(backing: PathBuf, daemon: DaemonClient) -> Self {
        let uid = unsafe { libc::getuid() };
        let (drops, dropped) = mpsc::channel();
        let state = Arc::new(State {
            backing,
            daemon,
            inodes: Mutex::new(Inodes::new()),
            listings: Mutex::new(HashMap::new()),
            listing_epoch: AtomicU64::new(0),
            fetching: Mutex::new(HashSet::new()),
            fetched: Condvar::new(),
            handles: Mutex::new(HashMap::new()),
            notifier: Arc::new(OnceLock::new()),
            mount: Arc::new(OnceLock::new()),
            unlinker: Mutex::new(None),
            unlinker_pid: AtomicU32::new(0),
            drops,
            trash: TrashArea::new(uid),
            next_fh: AtomicU64::new(1),
            uid,
            gid: unsafe { libc::getgid() },
            started: SystemTime::now(),
            space: Mutex::new(None),
        });
        start_unlinker(Arc::downgrade(&state), dropped);
        DriveFs { state }
    }

    /// Keeps the account's storage up to date for statfs, on a thread of its own: statfs never waits on the daemon,
    /// let alone the network (#181).
    pub fn start_space_refresh(&self) {
        let state = Arc::downgrade(&self.state);
        std::thread::spawn(move || loop {
            let Some(state) = state.upgrade() else { return };
            let wait = match state.daemon.space() {
                Ok(space) => {
                    *lock(&state.space) = space;
                    if space.is_some() { SPACE_REFRESH } else { SPACE_RETRY }
                }
                // Not reachable for now: what it said last stays
                Err(_) => SPACE_RETRY,
            };
            drop(state);
            std::thread::sleep(wait);
        });
    }

    /// Where main puts the session's notifier, once the session exists, before it runs.
    pub fn notifier_slot(&self) -> Arc<OnceLock<Notifier>> {
        self.state.notifier.clone()
    }

    /// Where main puts the drive's mount, once the session exists, before it runs.
    pub fn mount_slot(&self) -> Arc<OnceLock<Mount>> {
        self.state.mount.clone()
    }

    /// Hands the drive the child that unlinks what the trash drops (see unlinker.rs). Before the session runs.
    pub fn use_unlinker(&self, unlinker: Unlinker) {
        self.state.unlinker_pid.store(unlinker.pid(), Ordering::SeqCst);
        *lock(&self.state.unlinker) = Some(unlinker);
    }
}

/// The drive as mounted: its mount point, and the device its files have there.
pub struct Mount {
    pub path: PathBuf,
    pub dev: u64,
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
    /// Each open's inode number and what it is
    handles: Mutex<HashMap<u64, (u64, Handle)>>,
    notifier: Arc<OnceLock<Notifier>>,
    mount: Arc<OnceLock<Mount>>,
    /// The child that unlinks what the trash drops, until the thread that talks to it takes it; and its pid, 0 once
    /// it is gone
    unlinker: Mutex<Option<Unlinker>>,
    unlinker_pid: AtomicU32,
    /// Names the trash dropped, for the thread that has them unlinked through the mount
    drops: Sender<Dropped>,
    trash: TrashArea,
    next_fh: AtomicU64,
    uid: u32,
    gid: u32,
    started: SystemTime,
    /// The account's storage, as the daemon said last; None until it has (statfs then reports the local disk)
    space: Mutex<Option<Space>>,
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

/// A failed call to the daemon: the errno for the app, and the line for the log, written once the app has its reply.
struct Failure {
    errno: Errno,
    line: Option<String>,
}

/// The daemon's refusal of an app the user blocked: EACCES, and no log line, since a blocked tool walking a big
/// folder would otherwise write one for every file it tries.
fn blocked_refusal(err: &DaemonError) -> Option<Failure> {
    (err.errno == libc::EACCES && err.message.starts_with("Blocked:")).then_some(Failure { errno: Errno::EACCES, line: None })
}

impl Failure {
    fn log(&self) {
        if let Some(line) = &self.line {
            log!("{line}");
        }
    }
}

/// The errno for a change the daemon refused: its own, when it is one this call can give, else EIO, which is logged.
fn refusal(what: &str, err: DaemonError, allowed: &[i32]) -> Failure {
    let errno = if allowed.contains(&err.errno) { err.errno } else { libc::EIO };
    let line = (errno == libc::EIO).then(|| format!("protondrive-vfs: couldn't {what}: {}", err.message));
    Failure { errno: Errno::from_i32(errno), line }
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

/// What a setattr is applied to: an open file (whose path may have moved on), or a backing path.
enum Target<'a> {
    File(&'a File),
    Path(&'a Path),
}

/// Applies a setattr to a backing file or folder.
fn apply_change(target: Target, change: &AttrChange) -> std::io::Result<()> {
    if let Some(size) = change.size {
        match target {
            Target::File(file) => file.set_len(size)?,
            Target::Path(path) => {
                OpenOptions::new().write(true).custom_flags(libc::O_NOFOLLOW).open(path)?.set_len(size)?;
            }
        }
    }
    if let Some(mode) = change.mode {
        let permissions = Permissions::from_mode(mode & 0o7777);
        match target {
            Target::File(file) => file.set_permissions(permissions)?,
            Target::Path(path) => std::fs::set_permissions(path, permissions)?,
        }
    }
    if change.atime.is_some() || change.mtime.is_some() {
        let times = [time_spec(change.atime), time_spec(change.mtime)];
        let done = match target {
            Target::File(file) => unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
            Target::Path(path) => {
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

/// A name the trash dropped from one of its folders: the folder's number and path, and the name.
struct Dropped {
    folder: u64,
    dir: PathBuf,
    name: OsString,
}

/// The thread that has the names the trash drops from files/ and info/ unlinked through the drive's own mount: the
/// kernel tells its inotify watchers of an unlink, which gvfsd-trash counts the trash's items by, and of nothing FUSE
/// can send (#236). The unlinker child makes the unlink (see unlinker.rs), which waits for the folder's lock in the
/// kernel: held by the request that dropped the name until its reply is in, so asked only once that reply is sent,
/// and by any rename into the folder after it. This thread only waits for the child's answer, which a signal ends.
///
/// When the child couldn't unlink, the name goes all the same (see after_unlink). Without a child, the kernel's entry
/// goes with it, without a word to its watchers: that invalidation waits for the folder's lock in this thread (#247).
fn start_unlinker(state: Weak<State>, dropped: Receiver<Dropped>) {
    let _ = std::thread::Builder::new().name("trash-unlink".into()).spawn(move || {
        let mut child: Option<Unlinker> = None;
        let mut started = false;
        for Dropped { folder, dir, name } in dropped {
            let Some(state) = state.upgrade() else { return };
            // Handed over before any request is served, so there by the first drop if it ever is
            if !started {
                child = lock(&state.unlinker).take();
                started = true;
            }
            let asked = match (child.as_mut(), state.mount.get()) {
                (Some(unlinker), Some(mount)) => {
                    Some(unlinker.unlink(mount.dev, folder, &mount.path.join(&dir), &name))
                }
                _ => None,
            };
            if let Some(Err(_)) = asked {
                log!("protondrive-vfs: the trash's unlinker stopped: Files may count trashed items from now on");
                // Forgotten before it is reaped, when its pid is free for another process
                state.unlinker_pid.store(0, Ordering::SeqCst);
                if let Some(gone) = child.take() {
                    gone.end();
                }
            }
            if state.after_unlink(asked.as_ref(), &dir.join(&name)) {
                // Set before any request is served, so never missing here
                if let Some(notifier) = state.notifier.get() {
                    let _ = notifier.inval_entry(INodeNo(folder), &name);
                }
            }
        }
    });
}

impl State {
    fn path_of(&self, ino: INodeNo) -> Option<PathBuf> {
        lock(&self.inodes).path_of(ino.0)
    }

    fn ino_of(&self, rel: &Path) -> u64 {
        lock(&self.inodes).ino_of(rel)
    }

    fn add_handle(&self, ino: u64, handle: Handle) -> FileHandle {
        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        lock(&self.handles).insert(fh, (ino, handle));
        FileHandle(fh)
    }

    fn handle(&self, fh: FileHandle) -> Option<Handle> {
        lock(&self.handles).get(&fh.0).map(|(_, handle)| handle.clone())
    }

    /// A file an app still has open under that number: what a change by number reaches once the item's path has gone
    /// (deleted or replaced through the drive)
    fn open_file_of(&self, ino: u64) -> Option<Arc<File>> {
        lock(&self.handles).values().find_map(|(of, handle)| match handle {
            Handle::File(file) if *of == ino => Some(file.clone()),
            _ => None,
        })
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
            Node::Trash(TrashNode::Gone) => virtual_attr(FileType::RegularFile, 0o600, 0, self.started),
            Node::Trash(_) => virtual_attr(FileType::Directory, 0o700, 0, self.started),
        }
    }

    /// Asks the daemon to download an online-only file into the backing store, giving up with EINTR as soon as
    /// thread `tid` (the app waiting for it) does: the daemon keeps downloading, so a later use finds the file here.
    fn hydrate(&self, tid: u32, rel: &Path) -> Result<(), Errno> {
        self.hydrate_unlogged(tid, rel).map_err(|failure| {
            failure.log();
            failure.errno
        })
    }

    /// hydrate, leaving the failure for the caller to log once it has replied.
    fn hydrate_unlogged(&self, tid: u32, rel: &Path) -> Result<(), Failure> {
        // An online-only entry came from a UTF-8 listing, so its path is UTF-8
        let Some(rel_str) = rel.to_str() else { return Err(Failure { errno: Errno::EIO, line: None }) };
        let opener = if tid == 0 { None } else { process_comm(tid) };
        if let Err(err) = self.daemon.hydrate(rel_str, opener.as_deref(), &|| opener_interrupted(tid)) {
            if let Some(failure) = blocked_refusal(&err) {
                return Err(failure);
            }
            if err.errno == libc::EINTR {
                let line = format!("protondrive-vfs: stopped waiting for {rel_str:?}: the app waiting for it gave up");
                return Err(Failure { errno: Errno::EINTR, line: Some(line) });
            }
            // Only what open(2) can sensibly report from a download
            let errno = if matches!(err.errno, libc::ENOENT | libc::EACCES) { err.errno } else { libc::EIO };
            let line = format!("protondrive-vfs: couldn't download {rel_str:?}: {}", err.message);
            return Err(Failure { errno: Errno::from_i32(errno), line: Some(line) });
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
        if let Err(failure) = self.hydrate_unlogged(tid, &rel) {
            reply.error(failure.errno);
            return failure.log();
        }
        match open_backing(&self.backing.join(&rel), flags) {
            Ok(file) => {
                self.refresh_size(ino);
                reply.opened(self.add_handle(ino, Handle::File(Arc::new(file))), FopenFlags::empty())
            }
            Err(err) => {
                reply.error(Errno::EIO);
                log!("protondrive-vfs: {rel:?} was downloaded but won't open: {err}");
            }
        }
    }

    /// The backing folder for `rel`, made (with any missing above it, 0755) when only the cloud has it: a file saved
    /// into an online-only folder needs somewhere to go. The daemon takes such a folder for the cloud's own.
    fn backing_folder(&self, rel: &Path) -> Result<(), Errno> {
        match self.resolve(rel) {
            Some(Node::Local(meta)) if meta.is_dir() => Ok(()),
            Some(Node::Online(entry)) if entry.kind == Kind::Folder => {
                let missing = self.missing_backing_folders(rel);
                std::fs::DirBuilder::new().recursive(true).mode(0o755).create(self.backing.join(rel))?;
                // Each folder made changes the listing it is in
                for made in missing {
                    self.forget_listing(made.parent().unwrap_or(Path::new("")));
                }
                Ok(())
            }
            Some(Node::Trash(_)) => Err(Errno::EPERM),
            Some(_) => Err(Errno::ENOTDIR),
            None => Err(Errno::ENOENT),
        }
    }

    /// An online-only file about to be cut to nothing: the daemon puts an empty file in its place, with nothing from
    /// the cloud, and keeps what the drive showed of it as what its new content is an edit of. One already here (a
    /// download that finished meanwhile, say) is the file that gets cut. Never on a session thread.
    fn make_empty(&self, rel: &Path) -> Result<(), Errno> {
        // An online-only entry came from a UTF-8 listing, so its path is UTF-8
        let Some(rel_str) = rel.to_str() else { return Err(Errno::EIO) };
        let missing = self.missing_backing_folders(rel.parent().unwrap_or(Path::new("")));
        match self.daemon.truncate(rel_str) {
            Ok(()) => {}
            Err(err) if err.errno == libc::EEXIST => {}
            Err(err) => {
                let allowed = [libc::ENOENT, libc::EACCES, libc::EIO];
                return Err(self.refused(&format!("empty {rel_str:?}"), err, &allowed));
            }
        }
        // It is local now, and so is each folder the daemon made to hold it
        self.forget_listing(rel.parent().unwrap_or(Path::new("")));
        for made in missing {
            self.forget_listing(made.parent().unwrap_or(Path::new("")));
        }
        Ok(())
    }

    /// The folders of `rel` (itself included) missing from the backing store, deepest first, down from the nearest one
    /// that is there.
    fn missing_backing_folders<'a>(&self, rel: &'a Path) -> Vec<&'a Path> {
        let missing = |p: &&Path| !is_root(p) && std::fs::symlink_metadata(self.backing.join(p)).is_err();
        rel.ancestors().take_while(missing).collect()
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
                Settling::Pending => break,
                // Another use is settling it: this one gives up as soon as its own app does
                Settling::Busy if opener_interrupted(tid) => return Err(Errno::EINTR),
                Settling::Busy => {
                    state = match deferred.settled.wait_timeout(state, SETTLE_CHECK) {
                        Ok((state, _)) => state,
                        Err(poisoned) => poisoned.into_inner().0,
                    };
                }
            }
        }
        *state = Settling::Busy;
        drop(state);
        let guard = SettleGuard { deferred };
        let outcome = self.settle_now(deferred, tid, empty);
        std::mem::forget(guard);
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
            if let Some((_, handle)) = lock(&self.handles).get_mut(&fh.0) {
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
            log!("protondrive-vfs: {rel:?} is here now but won't open: {err}");
            Errno::EIO
        })?;
        if !empty {
            self.refresh_size(deferred.ino);
        }
        Ok(Arc::new(file))
    }

    /// Applies a setattr to the backing store and answers with the attributes that result: through the app's open
    /// file when the kernel names one, otherwise by path; and once the path has gone (the item deleted or replaced
    /// through the drive), through a file the app still has open under that number.
    fn reply_after_change(&self, ino: INodeNo, file: Option<&File>, change: &AttrChange, reply: ReplyAttr) {
        let meta = match (file, self.path_of(ino)) {
            (Some(file), _) => apply_change(Target::File(file), change).and_then(|()| file.metadata()),
            (None, Some(rel)) => {
                let path = self.backing.join(rel);
                apply_change(Target::Path(&path), change).and_then(|()| std::fs::symlink_metadata(&path))
            }
            (None, None) => match self.open_file_of(ino.0) {
                Some(file) => apply_change(Target::File(&file), change).and_then(|()| file.metadata()),
                None => return reply.error(Errno::ENOENT),
            },
        };
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

    /// The errno for a rename, delete or truncate the daemon refused: its own, when it is one this call can give. A
    /// daemon that didn't answer in time gives EIO here; the deadline sent with the call makes it refuse the change
    /// if its turn comes after that, so nothing happens behind the app's back.
    fn refused(&self, what: &str, err: DaemonError, allowed: &[i32]) -> Errno {
        let failure = refusal(what, err, allowed);
        failure.log();
        failure.errno
    }

    /// refused, answering the app first: the reply never waits for the log.
    fn reply_refused(&self, reply: ReplyEmpty, what: &str, err: DaemonError, allowed: &[i32]) {
        let failure = refusal(what, err, allowed);
        reply.error(failure.errno);
        failure.log();
    }

    /// A rename through the drive, which the daemon carries out whole. Never on a session thread.
    fn rename_through_daemon(
        &self,
        from: &Path,
        from_str: &str,
        to: &Path,
        to_str: &str,
        no_replace: bool,
        tid: u32,
    ) -> Result<(), Errno> {
        let mut renamed = self.daemon.rename(from_str, to_str, no_replace);
        // An online-only file can't take another's place without its content here, and mv would answer EXDEV by
        // deleting the target before copying, which loses it if the copy then fails: downloaded first, the rename
        // keeps the target's identity (a new revision of it). Tried on any EXDEV, whatever this helper's listing says
        // (it may be backing off): the daemon refuses a download that doesn't apply, and that is the answer then
        if renamed.as_ref().is_err_and(|err| err.errno == libc::EXDEV) {
            self.hydrate(tid, from)?;
            renamed = self.daemon.rename(from_str, to_str, no_replace);
        }
        match renamed {
            Ok(()) => {
                self.moved(from, to);
                Ok(())
            }
            Err(err) => {
                let allowed = [libc::ENOENT, libc::EEXIST, libc::EACCES, libc::EXDEV, libc::EIO];
                Err(self.refused(&format!("rename {from_str:?} to {to_str:?}"), err, &allowed))
            }
        }
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
    fn delete(self: &Arc<Self>, rel: PathBuf, removal: Removal, reply: ReplyEmpty) {
        // The daemon's paths are UTF-8: one that isn't can't be synced, renamed or deleted through the drive
        let Some(rel_str) = rel.to_str().map(String::from) else { return reply.error(Errno::EILSEQ) };
        self.on_worker("delete", move |s| match s.daemon.delete(&rel_str, removal) {
            Ok(()) => {
                s.removed(&rel);
                reply.ok()
            }
            Err(err) => {
                let allowed: &[i32] = if removal == Removal::Rmdir {
                    &[libc::ENOENT, libc::EACCES, libc::ENOTEMPTY, libc::EIO]
                } else {
                    &[libc::ENOENT, libc::EACCES, libc::EIO]
                };
                s.reply_refused(reply, &format!("delete {rel_str:?}"), err, allowed)
            }
        });
    }

    /// GIO's Move to Trash: the item it moves into the trash folder's files/ is deleted through the daemon, which
    /// keeps it in the cloud's trash and moves what exists only on this computer to the desktop Trash. files/ stays
    /// empty.
    fn trash_item(self: &Arc<Self>, from: PathBuf, files_ino: u64, name: OsString, reply: ReplyEmpty) {
        let Some(from_str) = from.to_str().map(String::from) else { return reply.error(Errno::EILSEQ) };
        self.on_worker("trash", move |s| match s.daemon.delete(&from_str, Removal::Trash) {
            Ok(()) => {
                s.removed(&from);
                let dropped = s.trash.trashed(&name);
                reply.ok();
                // The kernel has moved the item's entry into files/, which holds nothing
                s.dropped(files_ino, s.trash_files_dir(), name);
                if let Some(info) = dropped {
                    s.info_dropped(info);
                }
            }
            Err(err) => {
                let allowed = [libc::ENOENT, libc::EACCES, libc::EIO];
                s.reply_refused(reply, &format!("move {from_str:?} to the trash"), err, &allowed)
            }
        });
    }

    fn trash_files_dir(&self) -> PathBuf {
        Path::new(self.trash.name()).join("files")
    }

    fn trash_info_dir(&self) -> PathBuf {
        Path::new(self.trash.name()).join("info")
    }

    /// Has `name`, which the trash dropped from folder `dir` (number `folder`), unlinked through the mount. Only once
    /// the reply that dropped it is sent.
    fn dropped(&self, folder: u64, dir: PathBuf, name: OsString) {
        let _ = self.drops.send(Dropped { folder, dir, name });
    }

    /// A .trashinfo that has gone: its number goes stale, and it is unlinked through the mount.
    fn info_dropped(&self, name: OsString) {
        let dir = self.trash_info_dir();
        lock(&self.inodes).remove(&dir.join(&name));
        self.dropped(self.ino_of(&dir), dir, name);
    }

    /// The unlink of a name the trash dropped: it is no longer found, and the number a lookup gave it goes stale.
    /// Nothing else happens, here or in the cloud. Whether it was one.
    fn take_gone(&self, rel: &Path) -> bool {
        let was = self.trash.take_gone(rel);
        if was {
            lock(&self.inodes).remove(rel);
        }
        was
    }

    /// What is left to do about dropped name `rel` once the child was asked to unlink it (`asked`; None: no child to
    /// ask). Whether the kernel's entry must still be dropped from here.
    fn after_unlink(&self, asked: Option<&std::io::Result<bool>>, rel: &Path) -> bool {
        match asked {
            Some(Ok(true)) => false,
            // It couldn't: the name went meanwhile (expired while the child waited behind a slow rename, or unlinked by
            // someone else), or the folder wasn't the mount's. The name goes, and the kernel's entry expires of itself:
            // dropping it from here would wait on the folder's lock in the helper, which a stop can't interrupt (#247)
            Some(Ok(false)) => {
                self.take_gone(rel);
                false
            }
            // No child to ask, or none any more: the name goes, and the kernel's entry with it
            Some(Err(_)) | None => {
                self.take_gone(rel);
                true
            }
        }
    }

    /// An unlink or rmdir by process `pid` answered here, without the daemon: in the trash folder, of the volume info,
    /// or by the unlinker anywhere else, which it never has any business in. None for one the daemon carries out.
    fn remove_here(&self, rel: &Path, removal: Removal, pid: u32) -> Option<Result<(), Errno>> {
        if self.is_trash_path(rel) {
            return Some(self.remove_in_trash(rel, removal, pid));
        }
        if is_volume_info(rel) || self.is_unlinker(pid) {
            return Some(Err(Errno::EPERM));
        }
        None
    }

    /// Whether process `pid` is the unlinker child (see unlinker.rs).
    fn is_unlinker(&self, pid: u32) -> bool {
        pid != 0 && self.unlinker_pid.load(Ordering::SeqCst) == pid
    }

    /// An unlink or rmdir in the trash folder by process `pid`. A name the trash dropped goes (see take_gone). The
    /// unlinker's never reaches anything else: the name it was sent may have gone since (expired, or unlinked by
    /// someone else), and a new .trashinfo taken it. Anyone else's goes as it always has.
    fn remove_in_trash(&self, rel: &Path, removal: Removal, pid: u32) -> Result<(), Errno> {
        if self.take_gone(rel) {
            return Ok(());
        }
        if self.is_unlinker(pid) {
            return Err(Errno::ENOENT);
        }
        match (removal, self.trash.info_name(rel)) {
            // GIO takes back the .trashinfo of an item it failed to trash
            (Removal::Unlink, Some(info)) => {
                self.trash.remove_info(info)?;
                lock(&self.inodes).remove(rel);
                Ok(())
            }
            _ if self.trash.node(rel).is_some() => Err(Errno::EPERM),
            _ => Err(Errno::ENOENT),
        }
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

/// Gives a deferred open back to the next use if settling it stops short (a panic): it is no longer busy, and its
/// waiters wake.
struct SettleGuard<'a> {
    deferred: &'a Deferred,
}

impl Drop for SettleGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.deferred.state) = Settling::Pending;
        self.deferred.settled.notify_all();
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
        // Everything in the drive is the user's: owner and group can only be "changed" to what they are
        if uid.is_some_and(|u| u != s.uid) || gid.is_some_and(|g| g != s.gid) {
            return reply.error(Errno::EPERM);
        }
        let change = AttrChange { mode, size, atime, mtime };
        // Through the app's open file (ftruncate), whatever became of its path
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
        // Deleted or replaced through the drive: still changed through a file the app has open (fchmod, say)
        let Some(rel) = s.path_of(ino) else { return s.reply_after_change(ino, None, &change, reply) };
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
        match s.resolve(&rel) {
            Some(Node::Local(_)) => s.reply_after_change(ino, None, &change, reply),
            // Made here to take the change, as when a file is saved into it
            Some(Node::Online(entry)) if entry.kind == Kind::Folder => match s.backing_folder(&rel) {
                Ok(()) => s.reply_after_change(ino, None, &change, reply),
                Err(errno) => reply.error(errno),
            },
            Some(Node::Online(_)) if size == Some(0) => {
                s.on_worker("truncate", move |s| match s.make_empty(&rel) {
                    Ok(()) => s.reply_after_change(ino, None, &change, reply),
                    Err(errno) => reply.error(errno),
                });
            }
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

    fn unlink(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::ENOENT);
        }
        match s.remove_here(&rel, Removal::Unlink, req.pid()) {
            Some(Ok(())) => reply.ok(),
            Some(Err(errno)) => reply.error(errno),
            None => s.delete(rel, Removal::Unlink, reply),
        }
    }

    fn rmdir(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let s = &self.state;
        let Some(parent_rel) = s.path_of(parent) else { return reply.error(Errno::ENOENT) };
        let rel = parent_rel.join(name);
        if listing::is_hidden_name(name) {
            return reply.error(Errno::ENOENT);
        }
        match s.remove_here(&rel, Removal::Rmdir, req.pid()) {
            Some(Ok(())) => reply.ok(),
            Some(Err(errno)) => reply.error(errno),
            None => s.delete(rel, Removal::Rmdir, reply),
        }
    }

    fn rename(
        &self,
        req: &Request,
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
        let tid = req.pid();
        s.on_worker("rename", move |s| match s.rename_through_daemon(&from, &from_str, &to, &to_str, no_replace, tid) {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
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
                    reply.opened(s.add_handle(ino.0, Handle::TrashInfo(id)), FopenFlags::empty())
                }
                Some(TrashNode::Gone) | None => reply.error(Errno::ENOENT),
                Some(_) => reply.error(Errno::EISDIR),
            };
        }
        if is_volume_info(&rel) {
            if writing || truncate {
                return reply.error(Errno::EACCES);
            }
            return reply.opened(s.add_handle(ino.0, Handle::VolumeInfo), FopenFlags::empty());
        }
        let path = s.backing.join(&rel);
        // Whatever the listing said a moment ago, a backing file opens as it is
        match open_backing(&path, flags.0) {
            Ok(file) => return reply.opened(s.add_handle(ino.0, Handle::File(Arc::new(file))), FopenFlags::empty()),
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
            return s.on_worker("truncate", move |s| {
                match s.make_empty(&rel).and_then(|()| open_backing(&path, flags.0).map_err(Errno::from)) {
                    Ok(file) => reply.opened(s.add_handle(ino.0, Handle::File(Arc::new(file))), FopenFlags::empty()),
                    Err(errno) => reply.error(errno),
                }
            });
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
                    return reply.opened(s.add_handle(ino.0, Handle::Deferred(Arc::new(deferred))), FopenFlags::empty());
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
                    let ino = s.ino_of(&rel);
                    let attr = s.attr(ino, &node);
                    let fh = s.add_handle(ino, Handle::TrashInfo(id));
                    reply.created(&TTL, &attr, Generation(0), fh, FopenFlags::empty())
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
                let ino = s.ino_of(&rel);
                let attr = s.attr(ino, &Node::Local(meta));
                let fh = s.add_handle(ino, Handle::File(Arc::new(file)));
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
            Some((_, Handle::TrashInfo(id))) => s.trash.close_info(id),
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
        reply.opened(s.add_handle(ino.0, Handle::Dir(Arc::new(rows))), FopenFlags::empty());
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
        let local = DiskSize { blocks: st.f_blocks, free: st.f_bfree, available: st.f_bavail, block: st.f_frsize };
        let size = drive_size(local, *lock(&self.state.space));
        reply.statfs(
            size.blocks,
            size.free,
            size.available,
            st.f_files,
            st.f_ffree,
            st.f_bsize as u32,
            st.f_namemax as u32,
            st.f_frsize as u32,
        );
    }
}

/// A file system's size in blocks of `block` bytes, as statvfs gives it: free is what root may use, available what
/// anyone may.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DiskSize {
    blocks: u64,
    free: u64,
    available: u64,
    block: u64,
}

/// What the drive reports as its size (#181): the Proton account's storage, so that Disk Usage and df show it rather
/// than the local disk the backing store is on. Anything written through the drive lands in the backing store first
/// and uploads later, so what is available for writing is never more than the local disk has: a copy Files lets
/// through on the drive's word must fit. Until the storage is known, the local disk's own numbers.
fn drive_size(local: DiskSize, space: Option<Space>) -> DiskSize {
    let Some(space) = space else { return local };
    let block = local.block.max(1);
    let cloud_free = space.max.saturating_sub(space.used) / block;
    DiskSize {
        blocks: space.max / block,
        // Used (blocks - free) is what the account uses
        free: cloud_free,
        available: cloud_free.min(local.available),
        block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn the_drive_reports_the_accounts_storage_with_no_more_room_than_the_local_disk() {
        const GB: u64 = 1_000_000_000;
        let block = 4096;
        // The user's machine: 118.6 GB free of a 1 TB disk, 13.57 GB used of 510 GB in Proton Drive
        let local = DiskSize { blocks: 1000 * GB / block, free: 130 * GB / block, available: 1186 * GB / 10 / block, block };
        let space = Space { used: 1357 * GB / 100, max: 510 * GB };
        let size = drive_size(local, Some(space));
        let near = |bytes: u64, want: u64| bytes.abs_diff(want) < block; // to the block, rounded down
        assert!(near(size.blocks * block, 510 * GB));
        assert!(near((size.blocks - size.free) * block, space.used)); // used: the account's
        assert_eq!(size.available, local.available); // the local disk has less room than the cloud
        // Plenty of room here, little left in the cloud: the cloud's
        let roomy = DiskSize { available: 900 * GB / block, ..local };
        let nearly_full = Space { used: 509 * GB, max: 510 * GB };
        assert!(near(drive_size(roomy, Some(nearly_full)).available * block, GB));
        // Over quota: nothing free, never a wrap-around
        let over = drive_size(local, Some(Space { used: 600 * GB, max: 510 * GB }));
        assert_eq!((over.free, over.available), (0, 0));
        // Not known yet: the local disk's numbers as they are
        assert_eq!(drive_size(local, None), local);
    }
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_blocked_app_is_refused_quietly_and_nothing_else_is() {
        let err = |errno: i32, message: &str| DaemonError { errno, message: message.into(), stuck: false };
        let blocked = blocked_refusal(&err(libc::EACCES, "Blocked: rg")).expect("a blocked app is refused");
        assert_eq!(blocked.errno, Errno::EACCES);
        assert!(blocked.line.is_none());
        assert!(blocked_refusal(&err(libc::EACCES, "Hidden: Docs/a.txt")).is_none());
        assert!(blocked_refusal(&err(libc::EIO, "Blocked: rg")).is_none());
    }

    /// A daemon on a temp socket that holds every request until the gate opens, then lists `a.txt` in any folder, or
    /// downloads a file by writing it into the backing store. It counts listings and downloads.
    struct Gated {
        drive: DriveFs,
        root: PathBuf,
        listings: Arc<AtomicUsize>,
        downloads: Arc<AtomicUsize>,
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Gated {
        fn new(name: &str) -> Gated {
            let root = std::env::temp_dir().join(format!("protondrive-vfs-fs-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let backing = root.join("backing");
            std::fs::create_dir_all(&backing).unwrap();
            let socket = root.join("d.sock");
            let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            let (listings, downloads) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
            let gate = Arc::new((Mutex::new(false), Condvar::new()));
            let (counted_listings, counted_downloads, gated, placed) =
                (listings.clone(), downloads.clone(), gate.clone(), backing.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let (listings, downloads, gate, backing) =
                        (counted_listings.clone(), counted_downloads.clone(), gated.clone(), placed.clone());
                    std::thread::spawn(move || {
                        let mut raw = Vec::new();
                        let mut buf = [0u8; 4096];
                        while let Ok(n @ 1..) = stream.read(&mut buf) {
                            raw.extend_from_slice(&buf[..n]);
                            let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                            let head = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok()))
                                .unwrap_or(0);
                            if raw.len() >= end + 4 + len {
                                break;
                            }
                        }
                        let request = String::from_utf8_lossy(&raw).to_string();
                        let download = request.starts_with("POST /vfs/hydrate");
                        (if download { &downloads } else { &listings }).fetch_add(1, Ordering::SeqCst);
                        let (open, opened) = &*gate;
                        let mut is_open = open.lock().unwrap();
                        while !*is_open {
                            is_open = opened.wait(is_open).unwrap();
                        }
                        drop(is_open);
                        let body = if download {
                            let path = request.split("\"path\":\"").nth(1).and_then(|r| r.split('"').next());
                            let path = path.unwrap_or("");
                            let _ = std::fs::write(backing.join(path), b"downloaded");
                            r#"{"ok":true}"#.to_string()
                        } else {
                            r#"{"entries":[{"name":"a.txt","type":"file","size":1,"mtimeMs":0}]}"#.to_string()
                        };
                        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                    });
                }
            });
            Gated { drive: DriveFs::new(backing, DaemonClient::new(socket)), root, listings, downloads, gate }
        }

        fn open(&self) {
            let (open, opened) = &*self.gate;
            *open.lock().unwrap() = true;
            opened.notify_all();
        }

        // Until `count` reaches `n`: the requests have reached the daemon and wait at the gate
        fn until(&self, count: &AtomicUsize, n: usize) {
            let started = Instant::now();
            while count.load(Ordering::SeqCst) < n {
                assert!(started.elapsed() < Duration::from_secs(5), "the request never came");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn deferred(&self, rel: &str) -> Arc<Deferred> {
            let ino = self.drive.state.ino_of(Path::new(rel));
            let state = Mutex::new(Settling::Pending);
            Arc::new(Deferred { ino, flags: libc::O_WRONLY, state, settled: Condvar::new() })
        }
    }

    impl Drop for Gated {
        fn drop(&mut self) {
            self.open();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    // Runs `call` on its own thread and gives its result, or None if it is still blocked after `limit`
    fn within<T: Send + 'static>(limit: Duration, call: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(call());
        });
        rx.recv_timeout(limit).ok()
    }

    #[test]
    fn lookups_in_one_folder_share_a_single_listing_fetch() {
        let g = Gated::new("shared");
        let lookups: Vec<_> = (0..4)
            .map(|_| {
                let state = g.drive.state.clone();
                std::thread::spawn(move || state.listing(Path::new("")).get(OsStr::new("a.txt")).is_some())
            })
            .collect();
        g.until(&g.listings, 1);
        g.open();
        let found: Vec<bool> = lookups.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(found, [true; 4]);
        assert_eq!(g.listings.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_listing_read_while_the_drive_changed_isnt_kept() {
        let g = Gated::new("epoch");
        let state = g.drive.state.clone();
        let fetch = std::thread::spawn(move || state.listing(Path::new("")).get(OsStr::new("a.txt")).is_some());
        g.until(&g.listings, 1); // the fetch is waiting for the daemon
        g.drive.state.forget_listings(&[Path::new("a.txt")]);
        g.open();
        assert!(fetch.join().unwrap(), "the fetch still answers its own caller");
        assert!(g.drive.state.fresh_listing(Path::new("")).is_none(), "but what it read may predate the change");
        g.drive.state.listing(Path::new(""));
        assert!(g.drive.state.fresh_listing(Path::new("")).is_some());
        assert_eq!(g.listings.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn uses_of_a_deferred_open_that_come_at_once_download_it_once() {
        let g = Gated::new("settle-once");
        let deferred = g.deferred("a.txt");
        let uses: Vec<_> = (0..2)
            .map(|_| {
                let (state, deferred) = (g.drive.state.clone(), deferred.clone());
                std::thread::spawn(move || state.settle(FileHandle(0), &deferred, 0, false).is_ok())
            })
            .collect();
        g.until(&g.downloads, 1);
        g.open();
        let settled: Vec<bool> = uses.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(settled, [true, true]);
        assert_eq!(g.downloads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_use_waiting_on_another_gives_up_as_soon_as_its_own_app_does() {
        let g = Gated::new("settle-interrupted");
        let deferred = g.deferred("a.txt");
        let (state, first_use) = (g.drive.state.clone(), deferred.clone());
        let first = std::thread::spawn(move || state.settle(FileHandle(0), &first_use, 0, false).is_ok());
        g.until(&g.downloads, 1);
        // A thread that is gone counts as an app that gave up
        let (state, second_use) = (g.drive.state.clone(), deferred.clone());
        let started = Instant::now();
        let second =
            within(Duration::from_secs(5), move || state.settle(FileHandle(0), &second_use, u32::MAX, false).err());
        assert_eq!(second, Some(Some(Errno::EINTR)), "the waiting use stayed stuck");
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
        g.open();
        assert!(first.join().unwrap());
    }

    // A queued unlink can outlive its drop (expired, or unlinked by someone else) while a new .trashinfo takes the
    // name: the unlinker's own unlink only ever takes a dropped name. Anyone else's goes as it always has
    #[test]
    fn the_unlinkers_unlink_only_takes_what_the_trash_dropped() {
        let g = Gated::new("trash-unlink");
        let s = &g.drive.state;
        let unlinker = 4242;
        s.unlinker_pid.store(unlinker, Ordering::SeqCst);
        let (files, info) = (s.trash_files_dir(), s.trash_info_dir().join("a.trashinfo"));
        s.trash.create_info(OsStr::new("a.trashinfo"), true, false).unwrap();
        assert_eq!(s.remove_in_trash(&info, Removal::Unlink, unlinker), Err(Errno::ENOENT));
        assert!(matches!(s.trash.node(&info), Some(TrashNode::InfoFile { .. })), "the new .trashinfo stays");
        assert_eq!(s.trash.trashed(OsStr::new("x")), None);
        assert_eq!(s.remove_in_trash(&files.join("x"), Removal::Unlink, unlinker), Ok(()));
        assert_eq!(s.remove_in_trash(&files.join("x"), Removal::Unlink, unlinker), Err(Errno::ENOENT), "once");
        assert_eq!(s.trash.trashed(OsStr::new("Folder")), None);
        assert_eq!(s.remove_in_trash(&files.join("Folder"), Removal::Rmdir, unlinker), Ok(()));
        assert_eq!(s.remove_in_trash(&files, Removal::Rmdir, unlinker), Err(Errno::ENOENT));
        // Anyone else: GIO takes back a .trashinfo, and can't remove the trash's own folders
        assert_eq!(s.trash.trashed(OsStr::new("y")), None);
        assert_eq!(s.remove_in_trash(&files.join("y"), Removal::Unlink, 1), Ok(()), "a dropped name, all the same");
        assert_eq!(s.remove_in_trash(&info, Removal::Unlink, 1), Ok(()));
        assert_eq!(s.trash.node(&info), None);
        assert_eq!(s.remove_in_trash(&files, Removal::Rmdir, 1), Err(Errno::EPERM));
        assert_eq!(s.remove_in_trash(&files.join("z"), Removal::Unlink, 1), Err(Errno::ENOENT));
    }

    // Dropping the kernel's entry from the helper waits on the folder's lock, which a stop can't interrupt (#247): only
    // without a child to ask is it done. A child that couldn't unlink (the name went meanwhile) leaves it to expire
    #[test]
    fn only_a_missing_unlinker_leaves_the_kernels_entry_to_the_helper() {
        let g = Gated::new("after-unlink");
        let s = &g.drive.state;
        let item = s.trash_files_dir().join("x");
        let answers: [fn() -> Option<std::io::Result<bool>>; 3] =
            [|| Some(Ok(false)), || Some(Err(std::io::ErrorKind::BrokenPipe.into())), || None];
        for (answer, invalidate) in answers.into_iter().zip([false, true, true]) {
            assert_eq!(s.trash.trashed(OsStr::new("x")), None);
            let answer = answer();
            assert_eq!(s.after_unlink(answer.as_ref(), &item), invalidate, "{answer:?}");
            assert_eq!(s.trash.node(&item), None, "the name goes all the same: {answer:?}");
        }
        // Unlinked: the child's unlink took the name, and nothing is left to do
        assert_eq!(s.trash.trashed(OsStr::new("x")), None);
        assert!(!s.after_unlink(Some(&Ok(true)), &item));
    }

    // The unlinker only ever removes in the trash: anything else it asks is refused here, never sent to the daemon
    #[test]
    fn nothing_the_unlinker_removes_outside_the_trash_reaches_the_daemon() {
        let g = Gated::new("unlinker-outside");
        g.open();
        let s = &g.drive.state;
        let unlinker = 4242;
        s.unlinker_pid.store(unlinker, Ordering::SeqCst);
        for removal in [Removal::Unlink, Removal::Rmdir] {
            for rel in ["a.txt", "Docs", "Docs/a.txt", VOLUME_INFO_NAME] {
                assert_eq!(s.remove_here(Path::new(rel), removal, unlinker), Some(Err(Errno::EPERM)), "{rel}");
            }
            assert_eq!(s.remove_here(Path::new("a.txt"), removal, 1), None, "anyone else's goes to the daemon");
        }
        assert_eq!(s.remove_here(Path::new(VOLUME_INFO_NAME), Removal::Unlink, 1), Some(Err(Errno::EPERM)));
        assert_eq!(s.trash.trashed(OsStr::new("x")), None);
        let item = s.trash_files_dir().join("x");
        assert_eq!(s.remove_here(&item, Removal::Unlink, unlinker), Some(Ok(())), "a dropped name, in the trash");
        assert_eq!(g.listings.load(Ordering::SeqCst), 0, "nothing reached the daemon");
    }

    #[test]
    fn a_settle_cut_short_leaves_the_open_to_the_next_use() {
        let ino = 7;
        let state = Mutex::new(Settling::Busy);
        let deferred = Deferred { ino, flags: libc::O_WRONLY, state, settled: Condvar::new() };
        drop(SettleGuard { deferred: &deferred }); // as a panic in settle_now would
        assert!(matches!(*lock(&deferred.state), Settling::Pending));
    }

    // A daemon on a temp socket answering each request with `answer` (the request line and the JSON body)
    fn scripted(
        name: &str,
        answer: impl Fn(&str, &serde_json::Value) -> (u16, String) + Send + Sync + 'static,
    ) -> Gated {
        let root = std::env::temp_dir().join(format!("protondrive-vfs-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("backing")).unwrap();
        let socket = root.join("d.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let answer = Arc::new(answer);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let answer = answer.clone();
                std::thread::spawn(move || {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    let mut body_at = None;
                    while let Ok(n @ 1..) = stream.read(&mut buf) {
                        raw.extend_from_slice(&buf[..n]);
                        let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                        let head = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok()))
                            .unwrap_or(0);
                        if raw.len() >= end + 4 + len {
                            body_at = Some(end + 4);
                            break;
                        }
                    }
                    let Some(at) = body_at else { return };
                    let line = String::from_utf8_lossy(&raw).lines().next().unwrap_or("").to_string();
                    let body = serde_json::from_slice(&raw[at..]).unwrap_or(serde_json::Value::Null);
                    let (status, reply) = answer(&line, &body);
                    let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n\r\n{reply}", reply.len());
                });
            }
        });
        let gate = Arc::new((Mutex::new(true), Condvar::new()));
        let none = || Arc::new(AtomicUsize::new(0));
        let drive = DriveFs::new(root.join("backing"), DaemonClient::new(socket));
        Gated { drive, root, listings: none(), downloads: none(), gate }
    }

    // Review N3: an EXDEV is tried with the download whatever the helper's own listing says (here: nothing at all, as
    // when listings are backing off from a stuck daemon)
    #[test]
    fn any_exdev_rename_downloads_the_source_and_tries_once_more() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let root = std::env::temp_dir().join(format!("protondrive-vfs-fs-exdev-{}", std::process::id()));
        let backing = root.join("backing");
        let g = scripted("exdev", move |line, body| {
            seen.lock().unwrap().push(line.split(' ').nth(1).unwrap_or("").to_string());
            if line.starts_with("GET /vfs/children") {
                return (200, r#"{"entries":[]}"#.into());
            }
            if line.starts_with("POST /vfs/hydrate") {
                let _ = std::fs::write(backing.join(body["path"].as_str().unwrap_or("x")), b"downloaded");
                return (200, r#"{"ok":true}"#.into());
            }
            // An online-only file can't replace another: EXDEV while it has no local copy
            if backing.join("a.txt").exists() {
                (200, r#"{"ok":true}"#.into())
            } else {
                (400, r#"{"error":"Not on this computer","code":"EXDEV"}"#.into())
            }
        });
        let (from, to) = (Path::new("a.txt"), Path::new("b.txt"));
        assert_eq!(g.drive.state.rename_through_daemon(from, "a.txt", to, "b.txt", false, 0), Ok(()));
        let calls: Vec<String> =
            calls.lock().unwrap().iter().filter(|c| !c.starts_with("/vfs/children")).cloned().collect();
        assert_eq!(calls, ["/vfs/rename", "/vfs/hydrate", "/vfs/rename"]);
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
