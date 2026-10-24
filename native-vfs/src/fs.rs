// The drive as the kernel sees it: the backing store's files plus the cloud's online-only ones, with an online-only
// file downloaded when a real app opens it. Read side only: anything that would change the drive is refused for now.

use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::fs::{File, Metadata};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags, KernelConfig,
    LockOwner, Notifier, OpenAccMode, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry,
    ReplyOpen, ReplyStatfs, Request,
};

use crate::daemon::DaemonClient;
use crate::inodes::{Inodes, ROOT_INO};
use crate::listing::{self, Entry, Kind, VOLUME_INFO_CONTENT, VOLUME_INFO_NAME};
use crate::readers::{classify_open, opener_interrupted, process_comm, Reader};

/// How long the kernel may keep an entry or its attributes.
const TTL: Duration = Duration::from_secs(1);
/// How long a folder's merged listing serves lookups, getattrs and readdirs.
const LISTING_TTL: Duration = Duration::from_secs(1);

pub struct DriveFs {
    state: Arc<State>,
}

impl DriveFs {
    pub fn new(backing: PathBuf, daemon: DaemonClient) -> Self {
        DriveFs {
            state: Arc::new(State {
                backing,
                daemon,
                inodes: Mutex::new(Inodes::new()),
                listings: Mutex::new(HashMap::new()),
                fetching: Mutex::new(HashSet::new()),
                fetched: Condvar::new(),
                handles: Mutex::new(HashMap::new()),
                notifier: Arc::new(OnceLock::new()),
                next_fh: AtomicU64::new(1),
                uid: unsafe { libc::getuid() },
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

/// Shared with the threads that wait for downloads.
struct State {
    backing: PathBuf,
    daemon: DaemonClient,
    inodes: Mutex<Inodes>,
    listings: Mutex<HashMap<PathBuf, CachedListing>>,
    /// Folders whose listing is being fetched, and the signal that one fetch is done
    fetching: Mutex<HashSet<PathBuf>>,
    fetched: Condvar,
    handles: Mutex<HashMap<u64, Handle>>,
    notifier: Arc<OnceLock<Notifier>>,
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

enum Handle {
    File(Arc<File>),
    VolumeInfo,
    /// The folder's rows as opendir saw them, so readdir's offsets stay valid while the folder changes.
    Dir(Arc<Vec<DirRow>>),
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

/// A backing file, opened read-only; a symlink there isn't part of the drive, so it isn't followed.
fn open_backing(path: &Path) -> std::io::Result<File> {
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)
}

fn unix_time(secs: i64, nsecs: i64) -> SystemTime {
    let at = if secs >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_secs(secs.unsigned_abs()))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_secs(secs.unsigned_abs()))
    };
    at.and_then(|t| t.checked_add(Duration::from_nanos(nsecs.max(0) as u64))).unwrap_or(UNIX_EPOCH)
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
        let local = listing::read_local(&self.backing.join(rel));
        // A path that isn't UTF-8 can't be asked about, and the cloud has nothing under it anyway
        let remote = rel.to_str().map(|r| self.daemon.children_or_empty(r)).unwrap_or_default();
        let merged = Arc::new(Listing::new(listing::merge_listing(local, remote, is_root(rel))));
        let mut listings = lock(&self.listings);
        listings.retain(|_, c| c.at.elapsed() < LISTING_TTL);
        listings.insert(rel.to_path_buf(), CachedListing { at: Instant::now(), listing: merged.clone() });
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
        lock(&self.listings).remove(rel);
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
        }
    }

    /// Runs on its own thread: waits for the daemon's download, then opens the file it placed in the backing store.
    /// `tid` is the opener's thread: killed or interrupted meanwhile, it is let go at once with EINTR (the daemon keeps
    /// downloading, so the next open finds the file here).
    fn hydrate_and_open(&self, ino: u64, tid: u32, rel: PathBuf, reply: ReplyOpen) {
        // An online-only entry came from a UTF-8 listing, so its path is UTF-8
        let Some(rel_str) = rel.to_str() else { return reply.error(Errno::EIO) };
        if let Err(err) = self.daemon.hydrate(rel_str, &|| opener_interrupted(tid)) {
            if err.errno == libc::EINTR {
                eprintln!("protondrive-vfs: stopped waiting for {rel_str:?}: the app opening it gave up");
                return reply.error(Errno::EINTR);
            }
            eprintln!("protondrive-vfs: couldn't download {rel_str:?} to open it: {}", err.message);
            // Only what open(2) can sensibly report from a download
            let errno = if matches!(err.errno, libc::ENOENT | libc::EACCES) { err.errno } else { libc::EIO };
            return reply.error(Errno::from_i32(errno));
        }
        if let Some(parent) = rel.parent() {
            self.forget_listing(parent); // it is local now
        }
        match open_backing(&self.backing.join(&rel)) {
            Ok(file) => {
                // The kernel still holds the listed size, which can be short of the file (0 when the cloud claims
                // none), and would cut the first read to it: drop its attributes (offset -1 leaves the pages alone)
                if let Some(notifier) = self.notifier.get() {
                    let _ = notifier.inval_inode(INodeNo(ino), -1, 0);
                }
                reply.opened(self.add_handle(Handle::File(Arc::new(file))), FopenFlags::empty())
            }
            Err(err) => {
                eprintln!("protondrive-vfs: {rel_str:?} was downloaded but won't open: {err}");
                reply.error(Errno::EIO)
            }
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

impl Filesystem for DriveFs {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        // Lookups and readdirs in one folder needn't wait for each other; a kernel without it still works
        let _ = config.add_capabilities(InitFlags::FUSE_PARALLEL_DIROPS);
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

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let s = &self.state;
        match s.path_of(ino).and_then(|rel| s.resolve(&rel)) {
            Some(node) => reply.attr(&TTL, &s.attr(ino.0, &node)),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn open(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let s = &self.state;
        let Some(rel) = s.path_of(ino) else { return reply.error(Errno::ENOENT) };
        if flags.acc_mode() != OpenAccMode::O_RDONLY {
            return reply.error(Errno::EROFS); // writing through the drive isn't supported yet
        }
        if is_volume_info(&rel) {
            return reply.opened(s.add_handle(Handle::VolumeInfo), FopenFlags::empty());
        }
        // Whatever the listing said a moment ago, a backing file opens as it is
        match open_backing(&s.backing.join(&rel)) {
            Ok(file) => return reply.opened(s.add_handle(Handle::File(Arc::new(file))), FopenFlags::empty()),
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return reply.error(err.into()),
            Err(_) => {}
        }
        let (Some(parent), Some(name)) = (rel.parent(), rel.file_name()) else { return reply.error(Errno::ENOENT) };
        // Who is opening comes first: a background reader or a sniff mustn't even refresh the listing. An opener whose
        // comm can't be read counts as an app
        let comm = process_comm(req.pid()).unwrap_or_default();
        match classify_open(&comm, flags.0) {
            Reader::Background | Reader::Sniff => {
                // The cached listing, however old, says whether the file is there at all; without one, it is
                // refused all the same
                let online_file = |l: &Listing| l.get(name).is_some_and(|e| !e.local && e.kind == Kind::File);
                let gone = s.cached_listing(parent).is_some_and(|l| !online_file(&l));
                reply.error(if gone { Errno::ENOENT } else { Errno::EACCES })
            }
            Reader::App => {
                // With the daemon down and the listing expired, the cloud's entries are gone from the listing: the
                // file is then ENOENT, as the local-only listing the user sees says, rather than EIO
                if !s.online_entry(parent, name).is_some_and(|e| e.kind == Kind::File) {
                    return reply.error(Errno::ENOENT);
                }
                // Never on a session thread: the download can take minutes. If the thread can't start, the dropped
                // reply answers EIO
                let (state, tid) = (self.state.clone(), req.pid());
                let _ = std::thread::Builder::new()
                    .name("hydrate".into())
                    .spawn(move || state.hydrate_and_open(ino.0, tid, rel, reply));
            }
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
        let file = match lock(&self.state.handles).get(&fh.0) {
            Some(Handle::File(file)) => file.clone(),
            Some(Handle::VolumeInfo) => {
                let start = (offset as usize).min(VOLUME_INFO_CONTENT.len());
                let end = start.saturating_add(size as usize).min(VOLUME_INFO_CONTENT.len());
                return reply.data(&VOLUME_INFO_CONTENT[start..end]);
            }
            _ => return reply.error(Errno::EBADF),
        };
        let mut buf = vec![0u8; size as usize];
        match read_full_at(&file, &mut buf, offset) {
            Ok(n) => reply.data(&buf[..n]),
            Err(err) => reply.error(err.into()),
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
        lock(&self.state.handles).remove(&fh.0);
        reply.ok();
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let s = &self.state;
        let Some(rel) = s.path_of(ino) else { return reply.error(Errno::ENOENT) };
        let listing = s.listing(&rel);
        let parent_ino = rel.parent().map_or(ROOT_INO, |p| s.ino_of(p));
        let mut rows = vec![
            DirRow { ino: ino.0, kind: FileType::Directory, name: ".".into() },
            DirRow { ino: parent_ino, kind: FileType::Directory, name: "..".into() },
        ];
        let mut inodes = lock(&s.inodes);
        rows.extend(listing.entries.iter().map(|e| DirRow {
            ino: inodes.ino_of(&rel.join(&e.name)),
            kind: if e.kind == Kind::Folder { FileType::Directory } else { FileType::RegularFile },
            name: e.name.clone(),
        }));
        drop(inodes);
        reply.opened(s.add_handle(Handle::Dir(Arc::new(rows))), FopenFlags::empty());
    }

    fn readdir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let rows = match lock(&self.state.handles).get(&fh.0) {
            Some(Handle::Dir(rows)) => rows.clone(),
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

    #[test]
    fn lookups_in_one_folder_share_a_single_listing_fetch() {
        let root = std::env::temp_dir().join(format!("protondrive-vfs-fs-{}", std::process::id()));
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
        let drive = DriveFs::new(root.join("backing"), DaemonClient::new(socket));
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
}
