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
use std::sync::{Arc, Mutex};
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

/// What the fake daemon answers: listings from a map, and hydrate copying FIXTURE into the backing store after a
/// delay (200 ms unless told otherwise), through a staging file as the daemon does, or refusing with a code. Renames
/// and deletes are recorded with their bodies and, unless refused, applied to the map and the backing store as the
/// daemon would.
struct Fake {
    children: Mutex<HashMap<String, Vec<Value>>>,
    hydrate_delay: Duration,
    refusals: HashMap<String, &'static str>,
    rename_refusals: HashMap<String, &'static str>,
}

impl Fake {
    fn new(children: HashMap<&str, Vec<Value>>) -> Fake {
        Fake {
            children: Mutex::new(children.into_iter().map(|(k, v)| (k.to_string(), v)).collect()),
            hydrate_delay: Duration::from_millis(200),
            refusals: HashMap::new(),
            rename_refusals: HashMap::new(),
        }
    }

    fn slow(mut self, delay: Duration) -> Fake {
        self.hydrate_delay = delay;
        self
    }

    fn refusing(mut self, path: &str, code: &'static str) -> Fake {
        self.refusals.insert(path.to_string(), code);
        self
    }

    /// Renames from `from` are refused with `code` (after the daemon's own noReplace check, as the daemon does).
    fn refusing_rename(mut self, from: &str, code: &'static str) -> Fake {
        self.rename_refusals.insert(from.to_string(), code);
        self
    }
}

#[derive(Default)]
struct Calls {
    children: AtomicUsize,
    hydrates: AtomicUsize,
    renames: Mutex<Vec<Value>>,
    deletes: Mutex<Vec<Value>>,
}

struct FakeDaemon {
    socket: PathBuf,
    calls: Arc<Calls>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeDaemon {
    fn start(socket: &Path, backing: &Path, fake: Fake) -> FakeDaemon {
        let listener = UnixListener::bind(socket).unwrap();
        let calls = Arc::new(Calls::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (backing, fake, counted, stopping) = (backing.to_path_buf(), Arc::new(fake), calls.clone(), stop.clone());
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let (backing, fake, counted) = (backing.clone(), fake.clone(), counted.clone());
                thread::spawn(move || serve(stream, &backing, &fake, &counted));
            }
        });
        FakeDaemon { socket: socket.to_path_buf(), calls, stop, thread: Some(thread) }
    }

    fn hydrate_calls(&self) -> usize {
        self.calls.hydrates.load(Ordering::SeqCst)
    }

    fn children_calls(&self) -> usize {
        self.calls.children.load(Ordering::SeqCst)
    }

    fn renames(&self) -> Vec<Value> {
        self.calls.renames.lock().unwrap().clone()
    }

    fn deletes(&self) -> Vec<Value> {
        self.calls.deletes.lock().unwrap().clone()
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

fn serve(mut stream: UnixStream, backing: &Path, fake: &Fake, calls: &Calls) {
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
            calls.children.fetch_add(1, Ordering::SeqCst);
            let path = query.strip_prefix("path=").map(query_decode).unwrap_or_default();
            (200, json!({ "entries": fake.children.lock().unwrap().get(&path).cloned().unwrap_or_default() }))
        }
        ("POST", None) if target == "/vfs/rename" => {
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            calls.renames.lock().unwrap().push(body.clone());
            let (from, to) = (body["from"].as_str().unwrap_or(""), body["to"].as_str().unwrap_or(""));
            match fake_rename(backing, fake, from, to, body["noReplace"] == json!(true)) {
                Ok(()) => (200, json!({ "ok": true })),
                Err(code) => (400, json!({ "error": "Refused", "code": code })),
            }
        }
        ("POST", None) if target == "/vfs/delete" => {
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            calls.deletes.lock().unwrap().push(body.clone());
            match fake_delete(backing, fake, body["path"].as_str().unwrap_or(""), body["onlyIfEmpty"] == json!(true)) {
                Ok(()) => (200, json!({ "ok": true })),
                Err(code) => (400, json!({ "error": "Refused", "code": code })),
            }
        }
        ("POST", None) if target == "/vfs/hydrate" => {
            let n = calls.hydrates.fetch_add(1, Ordering::SeqCst);
            let path = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b["path"].as_str().map(String::from));
            thread::sleep(fake.hydrate_delay);
            match path {
                Some(path) if fake.refusals.contains_key(&path) => {
                    (400, json!({ "error": "Refused", "code": fake.refusals[&path] }))
                }
                Some(path) => {
                    // The test may be over by now (a slow download outlives a killed opener): no unwraps here
                    let staging = backing.join(format!(".proton-drive-tmp-hydrate-{n}"));
                    let placed = std::fs::write(&staging, FIXTURE).and_then(|_| std::fs::rename(&staging, backing.join(&path)));
                    match placed {
                        Ok(()) => (200, json!({ "ok": true })),
                        Err(err) => (400, json!({ "error": err.to_string(), "code": "EIO" })),
                    }
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

fn split_path(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

/// Whether the fake's listings or the backing store have something at `path`.
fn fake_has(backing: &Path, children: &HashMap<String, Vec<Value>>, path: &str) -> bool {
    let (parent, name) = split_path(path);
    backing.join(path).symlink_metadata().is_ok()
        || children.get(parent).is_some_and(|entries| entries.iter().any(|e| e["name"] == name))
}

// The daemon's rename as far as the tests need it: the local copy moves, and so does the listing entry
fn fake_rename(backing: &Path, fake: &Fake, from: &str, to: &str, no_replace: bool) -> Result<(), &'static str> {
    let mut children = fake.children.lock().unwrap();
    if !fake_has(backing, &children, from) {
        return Err("ENOENT");
    }
    if no_replace && fake_has(backing, &children, to) {
        return Err("EEXIST");
    }
    if let Some(code) = fake.rename_refusals.get(from) {
        return Err(code);
    }
    if backing.join(from).symlink_metadata().is_ok() {
        let target = backing.join(to);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|_| "EIO")?;
        std::fs::rename(backing.join(from), target).map_err(|_| "EIO")?;
    }
    let ((from_parent, from_name), (to_parent, to_name)) = (split_path(from), split_path(to));
    let moved = children.get_mut(from_parent).and_then(|entries| {
        let at = entries.iter().position(|e| e["name"] == from_name)?;
        Some(entries.remove(at))
    });
    if let Some(mut entry) = moved {
        entry["name"] = json!(to_name);
        let entries = children.entry(to_parent.to_string()).or_default();
        entries.retain(|e| e["name"] != to_name);
        entries.push(entry);
    }
    let under: Vec<String> =
        children.keys().filter(|k| k.starts_with(&format!("{from}/")) || *k == from).cloned().collect();
    for key in under {
        let entries = children.remove(&key).unwrap();
        children.insert(format!("{to}{}", &key[from.len()..]), entries);
    }
    Ok(())
}

// The daemon's delete: the local copy and the listing entry go; with onlyIfEmpty, only a folder holding nothing
fn fake_delete(backing: &Path, fake: &Fake, path: &str, only_if_empty: bool) -> Result<(), &'static str> {
    let mut children = fake.children.lock().unwrap();
    if !fake_has(backing, &children, path) {
        return Err("ENOENT");
    }
    let local = backing.join(path);
    if only_if_empty {
        let local_items = std::fs::read_dir(&local).map(|d| d.count()).unwrap_or(0);
        if local_items > 0 || children.get(path).is_some_and(|entries| !entries.is_empty()) {
            return Err("ENOTEMPTY");
        }
    }
    let removed = match local.symlink_metadata() {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&local),
        Ok(_) => std::fs::remove_file(&local),
        Err(_) => Ok(()),
    };
    removed.map_err(|_| "EIO")?;
    let (parent, name) = split_path(path);
    if let Some(entries) = children.get_mut(parent) {
        entries.retain(|e| e["name"] != name);
    }
    children.retain(|k, _| k != path && !k.starts_with(&format!("{path}/")));
    Ok(())
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
        self.start_fake(Fake::new(children));
    }

    fn start_fake(&mut self, fake: Fake) {
        self.daemon = Some(FakeDaemon::start(&self.socket, &self.backing, fake));
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
        for _ in 0..5 {
            if !mounted(&self.mountpoint) {
                break;
            }
            if !fusermount(&["-u"], &self.mountpoint) {
                fusermount(&["-u", "-z"], &self.mountpoint);
            }
            thread::sleep(Duration::from_millis(100));
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
    for temp in [".proton-drive-tmp-hydrate-1234", "Shared/.proton-drive-tmp-99-1-x"] {
        let missing = std::fs::metadata(h.path(temp)).unwrap_err();
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound, "{temp}");
    }
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

#[test]
fn a_download_bigger_than_its_listed_size_reads_whole_the_first_time() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    // The daemon lists a file without a claimed size as 0
    h.start_daemon(HashMap::from([("", vec![file("zero.txt", 0), file("short.txt", 5)])]));
    h.mount();

    for name in ["zero.txt", "short.txt"] {
        // The kernel now holds the listed size
        assert!(std::fs::metadata(h.path(name)).unwrap().len() < FIXTURE.len() as u64);
        let first = run(Command::new("cat").arg(h.path(name)));
        assert_eq!(String::from_utf8_lossy(&first.stdout), String::from_utf8_lossy(FIXTURE), "{name}");
    }
}

#[test]
fn an_opener_killed_while_its_file_downloads_is_let_go() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_fake(Fake::new(HashMap::from([("", vec![file("big.iso", 29)])])).slow(Duration::from_secs(10)));
    h.mount();

    let mut opener =
        Command::new("cat").arg(h.path("big.iso")).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let started = Instant::now();
    while h.daemon().hydrate_calls() == 0 {
        assert!(started.elapsed() < Duration::from_secs(5), "the open never asked for a download");
        thread::sleep(Duration::from_millis(20));
    }
    thread::sleep(Duration::from_secs(1));
    opener.kill().unwrap();
    let killed = Instant::now();
    while opener.try_wait().unwrap().is_none() {
        assert!(killed.elapsed() < Duration::from_secs(2), "the killed opener is still stuck in open");
        thread::sleep(Duration::from_millis(20));
    }
    // The mount still answers
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "big.iso"]);
}

#[test]
fn a_sniff_open_never_contacts_the_daemon() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("photo.jpg", 123_456)])]));
    h.mount();

    // A readdir fetches the listing without making entries in the kernel. A lookup 0.7 s later is answered from that
    // listing, and the kernel trusts the entry for 1 s. At 1.2 s the helper's listing has expired but the kernel's
    // entry hasn't, so the open reaches the helper with no lookup in front of it
    assert_eq!(std::fs::read_dir(&h.mountpoint).unwrap().count(), 2);
    thread::sleep(Duration::from_millis(700));
    std::fs::metadata(h.path("photo.jpg")).unwrap();
    thread::sleep(Duration::from_millis(500));
    let before = h.daemon().children_calls();
    assert_eq!(errno_of_open(&h.path("photo.jpg"), libc::O_RDONLY | libc::O_NOATIME), Some(libc::EACCES));
    assert_eq!(h.daemon().children_calls(), before, "the sniff refreshed the listing");
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn a_refused_download_reaches_the_app_as_enoent_eacces_or_eio() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    let names = ["gone.txt", "hidden.txt", "odd.txt"];
    h.start_fake(
        Fake::new(HashMap::from([("", names.iter().map(|n| file(n, 5)).collect())]))
            .refusing("gone.txt", "ENOENT")
            .refusing("hidden.txt", "EACCES")
            .refusing("odd.txt", "EXDEV"),
    );
    h.mount();

    assert_eq!(errno_of_open(&h.path("gone.txt"), libc::O_RDONLY), Some(libc::ENOENT));
    assert_eq!(errno_of_open(&h.path("hidden.txt"), libc::O_RDONLY), Some(libc::EACCES));
    assert_eq!(errno_of_open(&h.path("odd.txt"), libc::O_RDONLY), Some(libc::EIO), "only ENOENT, EACCES and EIO pass");
}

/// Runs a shell script with the paths as $1, $2, ...
fn sh(script: &str, args: &[&Path]) -> Output {
    run(Command::new("sh").arg("-c").arg(script).arg("sh").args(args))
}

fn assert_ok(output: &Output, what: &str) {
    assert!(output.status.success(), "{what}: {}", String::from_utf8_lossy(&output.stderr));
}

fn c_path(path: &Path) -> CString {
    CString::new(path.as_os_str().as_bytes()).unwrap()
}

/// The errno a syscall's -1 left, or None when it returned 0 or more.
fn errno_of(result: i32) -> Option<i32> {
    (result < 0).then(|| std::io::Error::last_os_error().raw_os_error().unwrap())
}

fn renameat2(from: &Path, to: &Path, flags: u32) -> Option<i32> {
    let (from, to) = (c_path(from), c_path(to));
    errno_of(unsafe { libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), flags) })
}

fn trash_name() -> String {
    format!(".Trash-{}", unsafe { libc::getuid() })
}

#[test]
fn writing_a_new_file_puts_it_in_the_backing_store() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::new());
    h.mount();

    assert_ok(&sh("umask 027; echo hi > \"$1\"", &[&h.path("new.txt")]), "echo");
    assert_eq!(std::fs::read(h.backing.join("new.txt")).unwrap(), b"hi\n");
    // With the app's umask, and only that
    assert_eq!(std::fs::metadata(h.backing.join("new.txt")).unwrap().mode() & 0o777, 0o640);
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "new.txt"]);
    assert_eq!(run(Command::new("cat").arg(h.path("new.txt"))).stdout, b"hi\n");
    assert_ok(&run(Command::new("mkdir").arg(h.path("Made"))), "mkdir");
    assert!(h.backing.join("Made").is_dir());
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "Made", "new.txt"]);
    assert_eq!(h.daemon().hydrate_calls(), 0);
    assert_eq!((h.daemon().renames(), h.daemon().deletes()), (vec![], vec![]));
}

#[test]
fn truncating_an_online_only_file_empties_it_here_without_a_download() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    let online = |name: &str| file(name, FIXTURE.len() as u64);
    let names = ["online.txt", "redirected.txt", "opened.txt", "cut.txt"];
    h.start_daemon(HashMap::from([("", names.iter().map(|n| online(n)).collect())]));
    h.mount();

    // truncate(1) opens for writing without O_TRUNC, then ftruncates
    assert_ok(&run(Command::new("truncate").args(["-s", "0"]).arg(h.path("online.txt"))), "truncate");
    assert_eq!(std::fs::metadata(h.backing.join("online.txt")).unwrap().len(), 0);
    assert_eq!(std::fs::metadata(h.path("online.txt")).unwrap().len(), 0);
    // A shell redirect opens with O_TRUNC
    assert_ok(&sh(": > \"$1\"", &[&h.path("redirected.txt")]), "redirect");
    assert_eq!(std::fs::metadata(h.backing.join("redirected.txt")).unwrap().len(), 0);
    // Opened for writing and closed untouched: nothing to download
    assert_ok(&sh("exec 3<> \"$1\"", &[&h.path("opened.txt")]), "open read-write");
    assert!(!h.backing.join("opened.txt").exists());
    assert_eq!(h.daemon().hydrate_calls(), 0);
    // Cut to a size short of what it is: that part has to come from the cloud first
    assert_ok(&run(Command::new("truncate").args(["-s", "4"]).arg(h.path("cut.txt"))), "truncate -s 4");
    assert_eq!(h.daemon().hydrate_calls(), 1);
    assert_eq!(std::fs::read(h.backing.join("cut.txt")).unwrap(), &FIXTURE[..4]);
}

#[test]
fn appending_to_an_online_only_file_downloads_it_first() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("log.txt", FIXTURE.len() as u64)])]));
    h.mount();

    assert_ok(&sh("echo more >> \"$1\"", &[&h.path("log.txt")]), "append");
    assert_eq!(h.daemon().hydrate_calls(), 1);
    let expected = [FIXTURE, b"more\n"].concat();
    let appended = std::fs::read(h.backing.join("log.txt")).unwrap();
    assert_eq!(String::from_utf8_lossy(&appended), String::from_utf8_lossy(&expected));
}

#[test]
fn mv_renames_through_the_daemon_and_ls_shows_it_at_once() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    let names = ["a.txt", "other.txt", "raced.txt", "taken.txt"];
    // raced.txt: a rename whose target the cloud has taken since the kernel looked
    let listing = HashMap::from([("", names.iter().map(|n| file(n, 5)).collect())]);
    h.start_fake(Fake::new(listing).refusing_rename("raced.txt", "EEXIST"));
    h.mount();
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "a.txt", "other.txt", "raced.txt", "taken.txt"]);

    assert_ok(&run(Command::new("mv").arg(h.path("a.txt")).arg(h.path("b.txt"))), "mv");
    let last = h.daemon().renames().last().cloned().unwrap();
    assert_eq!((&last["from"], &last["to"]), (&json!("a.txt"), &json!("b.txt")), "{last}");
    // At once, though the listing was cached a moment ago
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "b.txt", "other.txt", "raced.txt", "taken.txt"]);
    assert_eq!(std::fs::metadata(h.path("a.txt")).unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert_eq!(std::fs::metadata(h.path("b.txt")).unwrap().len(), 5);

    // mv -n onto an existing name: the kernel knows the name is taken and refuses it without asking, and nothing moves
    let before = h.daemon().renames().len();
    let _ = run(Command::new("mv").arg("-n").arg(h.path("other.txt")).arg(h.path("taken.txt")));
    assert_eq!(renameat2(&h.path("other.txt"), &h.path("taken.txt"), libc::RENAME_NOREPLACE), Some(libc::EEXIST));
    assert_eq!(h.daemon().renames().len(), before);
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "b.txt", "other.txt", "raced.txt", "taken.txt"]);
    // The daemon's own EEXIST for a no-replace rename reaches the app
    assert_eq!(renameat2(&h.path("raced.txt"), &h.path("new.txt"), libc::RENAME_NOREPLACE), Some(libc::EEXIST));
    assert_eq!(h.daemon().renames().last(), Some(&json!({ "from": "raced.txt", "to": "new.txt", "noReplace": true })));
    // An exchange can't be done
    let before = h.daemon().renames().len();
    assert_eq!(renameat2(&h.path("other.txt"), &h.path("taken.txt"), libc::RENAME_EXCHANGE), Some(libc::EINVAL));
    assert_eq!(h.daemon().renames().len(), before);
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn rm_deletes_through_the_daemon_without_a_download() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("online.txt", 5), file("keep.txt", 1)])]));
    h.mount();
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "keep.txt", "online.txt"]);

    assert_ok(&run(Command::new("rm").arg(h.path("online.txt"))), "rm");
    assert_eq!(h.daemon().deletes(), [json!({ "path": "online.txt" })]);
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "keep.txt"]);
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn rmdir_deletes_only_an_empty_folder_and_rm_r_empties_one_first() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([
        ("", vec![folder("Full"), folder("Empty"), folder("Tree")]),
        ("Full", vec![file("x.txt", 1)]),
        ("Tree", vec![file("a.txt", 1), folder("sub")]),
        ("Tree/sub", vec![file("b.txt", 1)]),
    ]));
    h.mount();

    let full = run(Command::new("rmdir").arg(h.path("Full")));
    assert!(!full.status.success());
    assert!(String::from_utf8_lossy(&full.stderr).contains("not empty"), "{}", String::from_utf8_lossy(&full.stderr));
    assert_eq!(h.daemon().deletes(), [json!({ "path": "Full", "onlyIfEmpty": true })]);
    assert_ok(&run(Command::new("rmdir").arg(h.path("Empty"))), "rmdir");
    assert_eq!(h.daemon().deletes().last(), Some(&json!({ "path": "Empty", "onlyIfEmpty": true })));

    assert_ok(&run(Command::new("rm").arg("-r").arg(h.path("Tree"))), "rm -r");
    let mut tree: Vec<String> = h.daemon().deletes()[2..].iter().map(|d| d.to_string()).collect();
    tree.sort();
    let mut expected: Vec<String> = [
        json!({ "path": "Tree/a.txt" }),
        json!({ "path": "Tree/sub/b.txt" }),
        json!({ "path": "Tree/sub", "onlyIfEmpty": true }),
        json!({ "path": "Tree", "onlyIfEmpty": true }),
    ]
    .iter()
    .map(|d| d.to_string())
    .collect();
    expected.sort();
    assert_eq!(tree, expected);
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "Full"]);
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn an_atomic_save_over_an_online_only_file_renames_onto_it() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([("", vec![file("doc.txt", 100)])]));
    h.mount();

    assert_ok(&sh("printf new > \"$1\"", &[&h.path("doc.txt.tmp")]), "write the temp file");
    assert_ok(&run(Command::new("mv").arg(h.path("doc.txt.tmp")).arg(h.path("doc.txt"))), "mv");
    // mv's first, no-replace try is refused by the kernel, which knows doc.txt is there: only the plain rename comes
    assert_eq!(h.daemon().renames(), [json!({ "from": "doc.txt.tmp", "to": "doc.txt" })]);
    assert_eq!(std::fs::read(h.backing.join("doc.txt")).unwrap(), b"new");
    assert_eq!(run(Command::new("cat").arg(h.path("doc.txt"))).stdout, b"new");
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "doc.txt"]);
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn saving_into_an_online_only_folder_makes_that_folder_here() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([
        ("", vec![folder("Online"), folder("Deep")]),
        ("Online", vec![file("old.txt", 5)]),
        ("Deep", vec![folder("Er")]),
    ]));
    h.mount();

    assert_ok(&sh("echo hi > \"$1\"", &[&h.path("Online/new.txt")]), "echo");
    assert_eq!(std::fs::read(h.backing.join("Online/new.txt")).unwrap(), b"hi\n");
    assert_eq!(std::fs::read_dir(h.backing.join("Online")).unwrap().count(), 1, "only the new file is here");
    assert_eq!(ls(&h.path("Online")), ["new.txt", "old.txt"]);
    assert_ok(&run(Command::new("mkdir").arg(h.path("Deep/Er/New"))), "mkdir");
    assert!(h.backing.join("Deep/Er/New").is_dir());
    assert_eq!(h.daemon().hydrate_calls(), 0);
}

#[test]
fn a_rename_the_daemon_answers_exdev_falls_back_to_copy_and_delete() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_fake(
        Fake::new(HashMap::from([("", vec![file("a.txt", FIXTURE.len() as u64), file("b.txt", 3)])]))
            .refusing_rename("a.txt", "EXDEV"),
    );
    h.mount();

    let mv = run(Command::new("mv").arg(h.path("a.txt")).arg(h.path("b.txt")));
    assert_ok(&mv, "mv");
    assert_eq!(h.daemon().renames(), [json!({ "from": "a.txt", "to": "b.txt" })]);
    // mv deleted the target, copied the file over (downloading it), and deleted the original
    assert_eq!(h.daemon().deletes(), [json!({ "path": "b.txt" }), json!({ "path": "a.txt" })]);
    assert_eq!(std::fs::read(h.backing.join("b.txt")).unwrap(), FIXTURE);
    assert_eq!(h.daemon().hydrate_calls(), 1);
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "b.txt"]);
}

#[test]
fn links_and_special_files_are_refused() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    std::fs::write(h.backing.join("x"), b"x").unwrap();
    h.start_daemon(HashMap::new());
    h.mount();

    // ln's message doesn't tell EPERM from EACCES, the syscall does
    assert!(!run(Command::new("ln").arg("-s").arg("x").arg(h.path("y"))).status.success());
    let (x, y) = (c_path(&h.path("x")), c_path(&h.path("y")));
    assert_eq!(errno_of(unsafe { libc::symlink(x.as_ptr(), y.as_ptr()) }), Some(libc::EPERM));
    assert_eq!(errno_of(unsafe { libc::link(x.as_ptr(), y.as_ptr()) }), Some(libc::EPERM));
    assert_eq!(errno_of(unsafe { libc::mkfifo(y.as_ptr(), 0o644) }), Some(libc::EPERM));
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info", "x"]);
}

#[test]
fn the_drives_own_names_cant_be_changed() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    std::fs::write(h.backing.join("a.txt"), b"a").unwrap();
    h.start_daemon(HashMap::new());
    h.mount();
    let trash = h.path(&trash_name());

    assert_eq!(renameat2(&h.path(".xdg-volume-info"), &h.path("v"), 0), Some(libc::EPERM));
    assert_eq!(renameat2(&h.path("a.txt"), &h.path(".xdg-volume-info"), 0), Some(libc::EPERM));
    assert_eq!(errno_of(unsafe { libc::unlink(c_path(&h.path(".xdg-volume-info")).as_ptr()) }), Some(libc::EPERM));
    assert_eq!(renameat2(&trash, &h.path("t"), 0), Some(libc::EPERM));
    assert_eq!(renameat2(&trash.join("info"), &h.path("t"), 0), Some(libc::EPERM));
    assert_eq!(errno_of(unsafe { libc::rmdir(c_path(&trash.join("files")).as_ptr()) }), Some(libc::EPERM));
    assert_eq!(errno_of(unsafe { libc::rmdir(c_path(&trash).as_ptr()) }), Some(libc::EPERM));
    assert_eq!(errno_of_open(&h.path(".proton-drive-tmp-x"), libc::O_CREAT | libc::O_WRONLY), Some(libc::EPERM));
    let temp_folder = c_path(&h.path(".proton-drive-tmp-y"));
    assert_eq!(errno_of(unsafe { libc::mkdir(temp_folder.as_ptr(), 0o755) }), Some(libc::EPERM));
    std::fs::write(h.backing.join(".proton-drive-tmp-z"), b"z").unwrap();
    assert_eq!(renameat2(&h.path(".proton-drive-tmp-z"), &h.path("z"), 0), Some(libc::ENOENT));
    assert_eq!((h.daemon().renames(), h.daemon().deletes()), (vec![], vec![]));
}

/// st_dev of a path, following symlinks.
fn device_of(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().dev()
}

#[test]
fn gio_trash_deletes_through_the_daemon_and_leaves_the_trash_empty() {
    if !enabled() {
        return;
    }
    let mut h = Harness::new();
    h.start_daemon(HashMap::from([
        ("", vec![file("online.txt", 5), folder("Folder")]),
        ("Folder", vec![file("in.txt", 1)]),
    ]));
    h.mount();
    let trash = h.path(&trash_name());
    let meta = std::fs::symlink_metadata(&trash).unwrap();
    assert!(meta.is_dir());
    assert_eq!((meta.mode() & 0o7777, meta.uid()), (0o700, unsafe { libc::getuid() }));

    // gio trash must only ever see paths of this mount: anywhere else it could use the desktop's own trash
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    for name in ["online.txt", "Folder"] {
        let target = h.path(name);
        assert!(mounted(&h.mountpoint));
        assert_ne!(device_of(&h.mountpoint), device_of(&home), "the mount must be its own file system");
        assert_eq!(device_of(target.parent().unwrap()), device_of(&h.mountpoint), "{target:?} must be in the mount");
        let trashed = run(Command::new("gio")
            .arg("trash")
            .arg(&target)
            .env("GIO_USE_VFS", "local")
            .env_remove("GTK_USE_PORTAL")
            .env_remove("GIO_USE_PORTALS"));
        assert_ok(&trashed, "gio trash");
    }
    assert_eq!(h.daemon().deletes(), [json!({ "path": "online.txt" }), json!({ "path": "Folder" })]);
    assert_eq!(h.daemon().hydrate_calls(), 0);
    assert_eq!(h.daemon().renames(), Vec::<Value>::new());
    assert_eq!(ls(&trash.join("info")), Vec::<String>::new());
    assert_eq!(ls(&trash.join("files")), Vec::<String>::new());
    assert_eq!(ls(&h.mountpoint), [".xdg-volume-info"]);
    let list = run(Command::new("gio").args(["trash", "--list"]));
    let listed = String::from_utf8_lossy(&list.stdout);
    assert!(!listed.contains(h.mountpoint.to_str().unwrap()), "{listed}");
}
