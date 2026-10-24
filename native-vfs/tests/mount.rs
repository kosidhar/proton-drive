// Real mounts of the built helper over temp dirs, with a fake daemon on a temp socket. They run only with
// PROTONDRIVE_VFS_MOUNT_TESTS=1, and always unmount, even when an assertion fails.

use std::collections::HashMap;
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const FIXTURE: &[u8] = b"downloaded from Proton Drive\n";
const LIMIT: Duration = Duration::from_secs(20);

fn enabled() -> bool {
    std::env::var("PROTONDRIVE_VFS_MOUNT_TESTS").as_deref() == Ok("1")
}

fn file(name: &str, size: u64) -> Value {
    json!({ "name": name, "type": "file", "size": size, "mtimeMs": 1_700_000_000_000u64 })
}

fn folder(name: &str) -> Value {
    json!({ "name": name, "type": "folder", "size": 0, "mtimeMs": 1_700_000_000_000u64 })
}

/// The daemon's drive routes, as far as the helper's read side uses them: listings from a map, and hydrate copying
/// FIXTURE into the backing store after 200 ms, through a staging file as the daemon does.
struct FakeDaemon {
    socket: PathBuf,
    hydrates: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeDaemon {
    fn start(socket: &Path, backing: &Path, children: HashMap<&str, Vec<Value>>) -> FakeDaemon {
        let listener = UnixListener::bind(socket).unwrap();
        let hydrates = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let children: Arc<HashMap<String, Vec<Value>>> =
            Arc::new(children.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
        let (backing, count, stopping) = (backing.to_path_buf(), hydrates.clone(), stop.clone());
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let (backing, children, count) = (backing.clone(), children.clone(), count.clone());
                thread::spawn(move || serve(stream, &backing, &children, &count));
            }
        });
        FakeDaemon { socket: socket.to_path_buf(), hydrates, stop, thread: Some(thread) }
    }

    fn hydrate_calls(&self) -> usize {
        self.hydrates.load(Ordering::SeqCst)
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&self.socket); // wakes the accept loop
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// URLSearchParams' decoding, which is what the daemon does to the query
fn query_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                out.push(u8::from_str_radix(&value[i + 1..i + 3], 16).unwrap());
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

fn serve(mut stream: UnixStream, backing: &Path, children: &HashMap<String, Vec<Value>>, hydrates: &AtomicUsize) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let (head, body) = loop {
        let Ok(n) = stream.read(&mut buf) else { return };
        if n == 0 {
            return;
        }
        raw.extend_from_slice(&buf[..n]);
        let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let length = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: ").and_then(|v| v.trim().parse::<usize>().ok()))
            .unwrap_or(0);
        if raw.len() >= split + 4 + length {
            break (head, raw[split + 4..split + 4 + length].to_vec());
        }
    };
    let mut request_line = head.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (request_line.next().unwrap_or(""), request_line.next().unwrap_or(""));
    let (status, reply) = match (method, target.split_once('?')) {
        ("GET", Some(("/vfs/children", query))) => {
            let path = query.strip_prefix("path=").map(query_decode).unwrap_or_default();
            (200, json!({ "entries": children.get(&path).cloned().unwrap_or_default() }))
        }
        ("POST", None) if target == "/vfs/hydrate" => {
            hydrates.fetch_add(1, Ordering::SeqCst);
            let path = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b["path"].as_str().map(String::from));
            thread::sleep(Duration::from_millis(200));
            match path {
                Some(path) => {
                    let staging = backing.join(".proton-drive-tmp-hydrate-test");
                    std::fs::write(&staging, FIXTURE).unwrap();
                    std::fs::rename(&staging, backing.join(&path)).unwrap();
                    (200, json!({ "ok": true }))
                }
                None => (400, json!({ "error": "Missing path", "code": "EIO" })),
            }
        }
        _ => (404, json!({ "error": "Not found" })),
    };
    let payload = reply.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
}

fn mounted(mountpoint: &Path) -> bool {
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let wanted = mountpoint.to_str().unwrap();
    mounts.lines().any(|l| l.split(' ').nth(1) == Some(wanted))
}

fn fusermount(args: &[&str], mountpoint: &Path) -> bool {
    Command::new("fusermount3")
        .args(args)
        .arg(mountpoint)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// One test's temp dirs, fake daemon and mounted helper. Dropping it unmounts (lazily if it must), reaps the helper
/// and removes the temp dirs, but never while anything is still mounted there.
struct Harness {
    root: PathBuf,
    mountpoint: PathBuf,
    backing: PathBuf,
    socket: PathBuf,
    daemon: Option<FakeDaemon>,
    helper: Option<Child>,
}

impl Harness {
    fn new() -> Harness {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir()
            .join(format!("protondrive-vfs-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&root);
        let (mountpoint, backing) = (root.join("mnt"), root.join("backing"));
        std::fs::create_dir_all(&mountpoint).unwrap();
        std::fs::create_dir_all(&backing).unwrap();
        Harness { socket: root.join("control.sock"), root, mountpoint, backing, daemon: None, helper: None }
    }

    fn start_daemon(&mut self, children: HashMap<&str, Vec<Value>>) {
        self.daemon = Some(FakeDaemon::start(&self.socket, &self.backing, children));
    }

    fn daemon(&self) -> &FakeDaemon {
        self.daemon.as_ref().unwrap()
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(self.root.join("helper.log")).unwrap_or_default()
    }

    fn mount(&mut self) {
        let log = std::fs::File::create(self.root.join("helper.log")).unwrap();
        let helper = Command::new(env!("CARGO_BIN_EXE_protondrive-vfs"))
            .arg("--mountpoint")
            .arg(&self.mountpoint)
            .arg("--backing")
            .arg(&self.backing)
            .arg("--socket")
            .arg(&self.socket)
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
        self.helper = Some(helper);
        let started = Instant::now();
        while !mounted(&self.mountpoint) {
            if let Some(status) = self.helper.as_mut().unwrap().try_wait().unwrap() {
                panic!("the helper exited with {status} before mounting: {}", self.stderr());
            }
            assert!(started.elapsed() < LIMIT, "the helper never mounted: {}", self.stderr());
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.mountpoint.join(rel)
    }

    /// Unmounts as the user's eject does, and gives the helper's exit status.
    fn eject(&mut self) -> ExitStatus {
        assert!(fusermount(&["-u"], &self.mountpoint), "fusermount3 -u failed");
        let helper = self.helper.as_mut().unwrap();
        let started = Instant::now();
        loop {
            if let Some(status) = helper.try_wait().unwrap() {
                self.helper = None;
                return status;
            }
            assert!(started.elapsed() < LIMIT, "the helper didn't exit after the unmount");
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if mounted(&self.mountpoint) && !fusermount(&["-u"], &self.mountpoint) {
            fusermount(&["-u", "-z"], &self.mountpoint);
        }
        if let Some(mut helper) = self.helper.take() {
            let started = Instant::now();
            while helper.try_wait().ok().flatten().is_none() && started.elapsed() < Duration::from_secs(5) {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = helper.kill();
            let _ = helper.wait();
        }
        self.daemon = None;
        if !mounted(&self.mountpoint) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

/// Runs a command with a time limit, so a hung mount fails the test instead of hanging it.
fn run(command: &mut Command) -> Output {
    let child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(LIMIT) {
        Ok(output) => output.unwrap(),
        Err(_) => {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            panic!("{command:?} took over {LIMIT:?}");
        }
    }
}

fn ls(dir: &Path) -> Vec<String> {
    let output = run(Command::new("ls").arg("-A").arg(dir));
    assert!(output.status.success(), "ls {dir:?}: {}", String::from_utf8_lossy(&output.stderr));
    let mut names: Vec<String> = String::from_utf8(output.stdout).unwrap().lines().map(String::from).collect();
    names.sort();
    names
}

fn errno_of_open(path: &Path, flags: i32) -> Option<i32> {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let fd = unsafe { libc::open(path.as_ptr(), flags) };
    if fd >= 0 {
        unsafe { libc::close(fd) };
        return None;
    }
    std::io::Error::last_os_error().raw_os_error()
}

#[test]
fn ls_shows_local_and_online_only_entries_without_temp_files() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    std::fs::write(h.backing.join("local.txt"), b"local").unwrap();
    std::fs::write(h.backing.join(".proton-drive-tmp-hydrate-1234"), b"partial").unwrap();
    std::fs::create_dir(h.backing.join("Shared")).unwrap();
    std::fs::write(h.backing.join("Shared/inner.txt"), b"inner").unwrap();
    std::fs::write(h.backing.join("Shared/.proton-drive-tmp-99-1-x"), b"partial").unwrap();
    h.start_daemon(HashMap::from([
        (
            "",
            vec![
                file("local.txt", 999),
                file("photo.jpg", 123_456),
                folder("Docs"),
                folder("Shared"),
                folder("a+b é"),
                file(".proton-drive-tmp-remote", 1),
            ],
        ),
        ("Shared", vec![file("more.pdf", 10), file("inner.txt", 77)]),
        ("a+b é", vec![file("deep.txt", 5)]),
    ]));
    h.mount();

    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "Docs", "Shared", "a+b é", "local.txt", "photo.jpg"]);
    assert_eq!(ls(&h.path("Shared")), ["inner.txt", "more.pdf"]);
    assert_eq!(ls(&h.path("a+b é")), ["deep.txt"]);
    assert_eq!(std::fs::metadata(h.path("local.txt")).unwrap().len(), 5, "the local copy wins");
    let missing = std::fs::metadata(h.path(".proton-drive-tmp-hydrate-1234")).unwrap_err();
    assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
    let info = run(Command::new("cat").arg(h.path(".xdg-volume-info")));
    assert_eq!(info.stdout, b"[Volume Info]\nName=Proton Drive\n");
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn stat_of_an_online_only_file_shows_its_remote_size() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("photo.jpg", 123_456), folder("Docs")])]));
    h.mount();

    let photo = std::fs::metadata(h.path("photo.jpg")).unwrap();
    assert!(photo.is_file());
    assert_eq!(photo.len(), 123_456);
    assert_eq!(photo.blocks(), 0);
    assert_eq!(photo.mode() & 0o777, 0o644);
    assert_eq!(photo.uid(), unsafe { libc::getuid() });
    let docs = std::fs::metadata(h.path("Docs")).unwrap();
    assert!(docs.is_dir());
    assert_eq!(docs.mode() & 0o777, 0o755);
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn cat_of_an_online_only_file_downloads_it_once() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("report.txt", FIXTURE.len() as u64)])]));
    h.mount();

    let first = run(Command::new("cat").arg(h.path("report.txt")));
    assert!(first.status.success(), "cat: {}", String::from_utf8_lossy(&first.stderr));
    assert_eq!(first.stdout, FIXTURE);
    assert_eq!(h.daemon().hydrate_calls(), 1);
    assert_eq!(std::fs::read(h.backing.join("report.txt")).unwrap(), FIXTURE);
    // Now it is local: it opens without another download
    assert_eq!(run(Command::new("cat").arg(h.path("report.txt"))).stdout, FIXTURE);
    assert_eq!(h.daemon().hydrate_calls(), 1);
}

#[test]
fn a_noatime_open_of_an_online_only_file_is_refused_without_a_download() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("photo.jpg", 123_456)])]));
    h.mount();

    assert_eq!(errno_of_open(&h.path("photo.jpg"), libc::O_RDONLY | libc::O_NOATIME), Some(libc::EACCES));
    // A thumbnailer is refused too: a shell exec'd under a thumbnailer's name (comm comes from the name it is run by)
    // opens the file itself. Not cat, which may be a multicall binary that won't run under another name, and a
    // symlink rather than a copy, which a parallel test's fork could hold open for writing (ETXTBSY)
    let thumbnailer = h.root.join("gnome-thumbnail-factory");
    std::os::unix::fs::symlink(std::fs::canonicalize("/bin/sh").unwrap(), &thumbnailer).unwrap();
    let refused = run(Command::new(&thumbnailer).args(["-c", "exec 3< \"$1\"", "sh"]).arg(h.path("photo.jpg")));
    assert!(!refused.status.success());
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(stderr.contains("Permission denied"), "{stderr}");
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn unmounting_ends_the_helper_with_exit_code_0() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::new());
    h.mount();

    let status = h.eject();
    assert_eq!(status.code(), Some(0), "helper stderr: {}", h.stderr());
    assert!(!mounted(&h.mountpoint));
}

#[test]
fn mounts_as_protondrive_with_the_drives_options() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.mount();

    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap();
    let wanted = h.mountpoint.to_str().unwrap();
    let line = mounts.lines().find(|l| l.split(' ').nth(1) == Some(wanted)).unwrap();
    let fields: Vec<&str> = line.split(' ').collect();
    assert_eq!((fields[0], fields[2]), ("protondrive", "fuse.protondrive"), "{line}");
    let options: Vec<&str> = fields[3].split(',').collect();
    assert!(options.contains(&"noatime") && options.contains(&"default_permissions"), "{line}");
    assert!(!options.contains(&"allow_other"), "{line}");
    // Free space is the backing store's
    let (drive, backing) = (statvfs(&h.mountpoint), statvfs(&h.backing));
    assert_eq!((drive.f_blocks, drive.f_bsize, drive.f_frsize), (backing.f_blocks, backing.f_bsize, backing.f_frsize));
}

fn statvfs(path: &Path) -> libc::statvfs {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::statvfs(path.as_ptr(), &mut st) }, 0);
    st
}

#[test]
fn a_mount_that_fails_exits_with_code_2() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    let (backing, socket) = (h.backing.clone(), h.socket.clone());
    let helper = |mountpoint: &Path| {
        run(Command::new(env!("CARGO_BIN_EXE_protondrive-vfs"))
            .arg("--mountpoint")
            .arg(mountpoint)
            .arg("--backing")
            .arg(&backing)
            .arg("--socket")
            .arg(&socket))
    };
    assert_eq!(helper(&h.root.join("missing")).status.code(), Some(2));
    h.mount();
    let second = helper(&h.mountpoint);
    assert_eq!(second.status.code(), Some(2), "{}", String::from_utf8_lossy(&second.stderr));
    assert!(h.helper.as_mut().unwrap().try_wait().unwrap().is_none(), "the first helper keeps serving");
}

#[test]
fn without_the_daemon_local_entries_keep_working() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    std::fs::write(h.backing.join("local.txt"), b"local").unwrap();
    h.mount();

    let started = Instant::now();
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "local.txt"]);
    assert_eq!(run(Command::new("cat").arg(h.path("local.txt"))).stdout, b"local");
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
}
