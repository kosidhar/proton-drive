//! One app window per user (#129). The first GUI holds a lock file and listens on a socket beside it; a later start
//! (from the tray, the launcher or a terminal) finds the lock taken, asks the running GUI to show itself and exits.
//!
//! The lock decides who is first, not the socket: a socket left by a crashed GUI is just removed by the next one to
//! get the lock, and two starts at once can't both become the primary, since only one gets the lock.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SHOW: &str = "show";

/// Where the lock file and the socket live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstancePaths {
    pub lock: PathBuf,
    pub socket: PathBuf,
}

/// `$XDG_RUNTIME_DIR` (private to the user by definition), else a 0700 folder of the user's in the temp dir.
pub fn instance_paths(xdg_runtime_dir: Option<std::ffi::OsString>, tmp: PathBuf, uid: u32) -> InstancePaths {
    let dir = match xdg_runtime_dir.filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => tmp.join(format!("protondrive-gui-{uid}")),
    };
    InstancePaths { lock: dir.join("protondrive-gui.lock"), socket: dir.join("protondrive-gui.sock") }
}

/// What starting the GUI found.
pub enum Claim {
    /// This is the only GUI: keep `lock` open for as long as the app runs, and answer `listener`.
    Primary { lock: std::fs::File, listener: UnixListener },
    /// Another GUI runs and was asked to show itself: exit.
    Signalled,
}

/// Makes the folder for the fallback paths: the user's own, 0700, not a link. A runtime dir is used as it is.
fn ensure_private_dir(dir: &Path, uid: u32) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new().mode(0o700).create(dir)?;
        }
        Err(e) => return Err(e),
        Ok(_) => {}
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} isn't a private folder of the user's", dir.display()),
        ));
    }
    Ok(())
}

/// A section name is passed on only as one plain lowercase word; anything else asks just to show the window.
const MAX_SECTION: usize = 32;

/// The longest absolute path a share request carries (Linux's PATH_MAX)
const MAX_SHARE_PATH: usize = 4096;
const SHARE: &str = "share";
const SHARE_REFUSED: &str = "share-refused";
/// The most of a path a refusal carries, only to show it
const MAX_SHOWN: usize = 1024;

/// What a later start asks of the running app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Show the window, on a section if one is named (#203)
    Show(Option<String>),
    /// Show the window with the share window open for this absolute path (#216)
    Share(String),
    /// Show the window with the share window saying why the path a start named can't be shared (#216). `shown` is
    /// that path made fit to show (see `showable`): it is never used as a path.
    ShareRefused { shown: String, problem: PathProblem },
}

/// Why a path given to share can't be shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathProblem {
    /// Not a full path (it doesn't start with /)
    NotAbsolute,
    /// Longer than any path on Linux
    TooLong,
    /// It has a line break (or a NUL) in it, which can't travel on the request's one line
    LineBreak,
    /// It isn't UTF-8 text, which the request and the daemon's routes are
    NotUtf8,
}

impl PathProblem {
    /// As a refusal carries it
    fn code(self) -> &'static str {
        match self {
            PathProblem::NotAbsolute => "not-absolute",
            PathProblem::TooLong => "too-long",
            PathProblem::LineBreak => "line-break",
            PathProblem::NotUtf8 => "not-utf8",
        }
    }

    fn from_code(code: &str) -> Option<Self> {
        [PathProblem::NotAbsolute, PathProblem::TooLong, PathProblem::LineBreak, PathProblem::NotUtf8]
            .into_iter()
            .find(|p| p.code() == code)
    }
}

/// A path travels on one line: absolute, within the limit, and with nothing that ends or breaks the line.
pub fn is_shareable_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= MAX_SHARE_PATH && !path.contains(['\n', '\0'])
}

/// What a start's `--share <path>` asks, from the path as the file system has it: to share it, or, for a path that
/// can't be shared, to say why.
pub fn share_request(path: &OsStr) -> Request {
    let problem = match path.to_str() {
        Some(text) if is_shareable_path(text) => return Request::Share(text.to_string()),
        Some(text) if text.contains(['\n', '\0']) => PathProblem::LineBreak,
        Some(text) if !text.starts_with('/') => PathProblem::NotAbsolute,
        Some(_) => PathProblem::TooLong,
        None => PathProblem::NotUtf8,
    };
    Request::ShareRefused { shown: showable(&path.to_string_lossy()), problem }
}

/// A path made fit to show on one line: what would break the line shown as U+FFFD (as a byte that isn't UTF-8 already
/// is), and only its end when it is long, since the end names the item.
fn showable(path: &str) -> String {
    let line: String = path.chars().map(|c| if c.is_control() { '\u{fffd}' } else { c }).collect();
    if line.len() <= MAX_SHOWN {
        return line;
    }
    let mut start = line.len() - (MAX_SHOWN - '\u{2026}'.len_utf8());
    while !line.is_char_boundary(start) {
        start += 1;
    }
    format!("\u{2026}{}", &line[start..])
}

/// The request a later start sends: `show`, `show <section>` to open the running app on that section (#203),
/// `share <absolute path>` (everything after `share ` up to the newline is the path), or
/// `share-refused <why> <the path as shown>` for a path that can't be shared (#216). A section that isn't one plain
/// lowercase word isn't sent: the request is just `show`.
fn request_message(request: &Request) -> String {
    match request {
        Request::Show(Some(section))
            if !section.is_empty() && section.len() <= MAX_SECTION && section.bytes().all(|b| b.is_ascii_lowercase()) =>
        {
            format!("{SHOW} {section}\n")
        }
        Request::Show(_) => format!("{SHOW}\n"),
        Request::Share(path) if is_shareable_path(path) => format!("{SHARE} {path}\n"),
        Request::Share(path) => request_message(&share_request(OsStr::new(path))),
        Request::ShareRefused { shown, problem } => format!("{SHARE_REFUSED} {} {}\n", problem.code(), showable(shown)),
    }
}

/// What a request line asks, or None for one this app doesn't know.
fn parse_request(line: &str) -> Option<Request> {
    if let Some(path) = line.strip_prefix("share ") {
        // A path is whole only with its newline: a line cut at the read limit is not one
        let path = path.strip_suffix('\n')?;
        return is_shareable_path(path).then(|| Request::Share(path.to_string()));
    }
    if let Some(refusal) = line.strip_prefix("share-refused ") {
        let (code, shown) = refusal.strip_suffix('\n')?.split_once(' ')?;
        return Some(Request::ShareRefused { shown: showable(shown), problem: PathProblem::from_code(code)? });
    }
    let mut words = line.split_whitespace();
    if words.next() != Some(SHOW) {
        return None;
    }
    match (words.next(), words.next()) {
        (None, _) => Some(Request::Show(None)),
        (Some(section), None) => Some(Request::Show(Some(section.to_string()))),
        _ => None,
    }
}

/// How a request went: answered, turned down by closing (an app that doesn't know it), or not answered at all.
#[derive(Debug, PartialEq, Eq)]
enum Sent {
    Answered,
    Closed,
    NoAnswer,
}

fn send_message(socket: &Path, message: &str) -> Sent {
    let Ok(mut stream) = UnixStream::connect(socket) else { return Sent::NoAnswer };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(message.as_bytes()).is_err() {
        return Sent::NoAnswer;
    }
    let mut reply = String::new();
    match BufReader::new(stream).take(64).read_line(&mut reply) {
        Ok(_) if reply.trim() == "ok" => Sent::Answered,
        Ok(_) => Sent::Closed,
        Err(_) => Sent::NoAnswer, // timed out: hung, not an older app
    }
}

/// Asks the GUI listening at `socket` to do `request`. True once it has said it will. An app from before sections
/// (or shares) were passed on knows only `show`: it closes the connection on anything else without a word, so the
/// plain request follows at once and the window still comes to the front. One that doesn't answer at all is hung,
/// and isn't asked twice.
pub fn signal(socket: &Path, request: &Request) -> bool {
    let message = request_message(request);
    let plain = request_message(&Request::Show(None));
    match send_message(socket, &message) {
        Sent::Answered => true,
        Sent::Closed if message != plain => send_message(socket, &plain) == Sent::Answered,
        _ => false,
    }
}

/// Becomes the one GUI, or asks the one that runs to show itself (on `section`, if named). `wait` bounds how long a later start keeps trying
/// to reach a first GUI that holds the lock but isn't listening yet (it is still starting). An error means the
/// check itself couldn't run; the caller then just starts, as before this check existed.
pub fn claim(
    paths: &InstancePaths,
    uid: u32,
    in_runtime_dir: bool,
    wait: Duration,
    request: &Request,
) -> std::io::Result<Claim> {
    if let Some(dir) = paths.lock.parent() {
        if !in_runtime_dir {
            ensure_private_dir(dir, uid)?;
        }
    }
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&paths.lock)?;
    match lock.try_lock() {
        Ok(()) => {
            // Only the lock's holder touches the socket: one left behind by a GUI that crashed is removed
            if let Ok(meta) = std::fs::symlink_metadata(&paths.socket) {
                if meta.file_type().is_socket() {
                    std::fs::remove_file(&paths.socket)?;
                }
            }
            let listener = UnixListener::bind(&paths.socket)?;
            Ok(Claim::Primary { lock, listener })
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let deadline = Instant::now() + wait;
            loop {
                if signal(&paths.socket, request) {
                    return Ok(Claim::Signalled);
                }
                if Instant::now() >= deadline {
                    // It holds the lock but never answered (hung): don't open a second window anyway
                    return Ok(Claim::Signalled);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// How long one client has to send its whole request line before the listener drops it (#225).
const REQUEST_DEADLINE: Duration = Duration::from_secs(2);
/// Cap on simultaneous connection handler threads so slow clients cannot spawn unbounded threads (#225).
const MAX_CONCURRENT_CONNECTIONS: usize = 16;
/// A request is one line, at most `share ` + a path + the newline (a refusal is shorter): never read more.
const MAX_REQUEST_LINE: usize = MAX_SHARE_PATH + 7;

/// Reads one request line from `stream`, bounded in both size (`MAX_REQUEST_LINE`) and total elapsed time (`deadline`),
/// so a client that trickles bytes slowly cannot hold a connection past `deadline` (#225).
fn read_request_line(stream: &mut UnixStream, deadline: Instant) -> Option<String> {
    let mut bytes = Vec::new();
    let mut buf = [0u8; 512];
    while bytes.len() < MAX_REQUEST_LINE {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        // Clamp above zero: on Linux, a 0-microsecond SO_RCVTIMEO means no timeout at all
        let _ = stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))));
        let want = (MAX_REQUEST_LINE - bytes.len()).min(buf.len());
        match stream.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(nl) = buf[..n].iter().position(|&b| b == b'\n') {
                    bytes.extend_from_slice(&buf[..=nl]);
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    String::from_utf8(bytes).ok()
}

fn handle_connection(mut stream: UnixStream, deadline: Instant, on_request: &(impl Fn(Request) + ?Sized)) {
    let _ = stream.set_write_timeout(Some(REQUEST_DEADLINE));
    let Some(line) = read_request_line(&mut stream, deadline) else {
        return;
    };
    if let Some(request) = parse_request(&line) {
        on_request(request);
        let _ = stream.write_all(b"ok\n");
    }
}

/// Answers later starts on `listener`, calling `on_request` with what each asks. Runs until the listener fails; a request it doesn't know is ignored, unanswered.
/// Each connection runs on its own bounded worker thread with a total deadline so a slow client cannot block later starts (#225).
pub fn serve(listener: UnixListener, on_request: impl Fn(Request) + Send + Sync + 'static) {
    serve_with_deadline(listener, REQUEST_DEADLINE, on_request);
}

fn serve_with_deadline(listener: UnixListener, deadline: Duration, on_request: impl Fn(Request) + Send + Sync + 'static) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct Slot(Arc<AtomicUsize>);
    impl Drop for Slot {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    let on_request = Arc::new(on_request);
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let mut current = active.load(Ordering::SeqCst);
        let reserved = loop {
            if current >= MAX_CONCURRENT_CONNECTIONS {
                break false;
            }
            match active.compare_exchange_weak(current, current + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => break true,
                Err(actual) => current = actual,
            }
        };
        if !reserved {
            drop(stream);
            continue;
        }
        let slot = Slot(active.clone());
        let on_request = on_request.clone();
        let _ = std::thread::Builder::new().spawn(move || {
            let _slot = slot;
            handle_connection(stream, Instant::now() + deadline, &*on_request);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pd-gui-instance-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new().mode(0o700).recursive(true).create(&dir).unwrap();
        dir
    }

    fn paths_in(dir: &Path) -> InstancePaths {
        instance_paths(Some(dir.as_os_str().to_owned()), PathBuf::from("/unused"), 0)
    }

    fn uid() -> u32 {
        std::fs::metadata("/proc/self").unwrap().uid()
    }

    #[test]
    fn paths_use_the_runtime_dir_else_a_folder_of_the_users_in_tmp() {
        let p = instance_paths(Some("/run/user/7".into()), PathBuf::from("/tmp"), 7);
        assert_eq!(p.socket, PathBuf::from("/run/user/7/protondrive-gui.sock"));
        assert_eq!(p.lock, PathBuf::from("/run/user/7/protondrive-gui.lock"));
        let p = instance_paths(Some("".into()), PathBuf::from("/tmp"), 7);
        assert_eq!(p.socket, PathBuf::from("/tmp/protondrive-gui-7/protondrive-gui.sock"));
        let p = instance_paths(None, PathBuf::from("/var/tmp"), 9);
        assert_eq!(p.lock, PathBuf::from("/var/tmp/protondrive-gui-9/protondrive-gui.lock"));
    }

    #[test]
    fn a_second_start_asks_the_first_to_show_itself_and_does_not_become_primary() {
        let dir = temp_dir("second");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let shown = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = shown.clone();
        std::thread::spawn(move || serve(listener, move |request| seen.lock().unwrap().push(request)));
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap(), Claim::Signalled));
        // #203: a start that names a section passes it on, so the running app opens there
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(Some("home".into()))).unwrap(), Claim::Signalled));
        assert_eq!(*shown.lock().unwrap(), vec![Request::Show(None), Request::Show(Some("home".to_string()))]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn show(section: &str) -> Request {
        Request::Show(Some(section.to_string()))
    }

    #[test]
    fn a_section_name_that_isnt_a_plain_word_is_not_passed_on() {
        assert_eq!(request_message(&show("home")), "show home\n");
        assert_eq!(request_message(&Request::Show(None)), "show\n");
        for odd in ["", "home settings", "home\nshow", "../x", "a".repeat(33).as_str()] {
            assert_eq!(request_message(&show(odd)), "show\n", "{odd:?}");
        }
        assert_eq!(parse_request("show"), Some(Request::Show(None)));
        assert_eq!(parse_request("show activity"), Some(show("activity")));
        assert_eq!(parse_request("show a b"), None);
        assert_eq!(parse_request("hello"), None);
    }

    #[test]
    fn a_share_request_carries_a_path_with_spaces_and_unicode() {
        for path in ["/home/u/ProtonDrive/My Docs/r\u{e9}sum\u{e9} (v2).pdf", "/home/u/ProtonDrive/-dash"] {
            let message = request_message(&Request::Share(path.to_string()));
            assert_eq!(message, format!("share {path}\n"));
            assert_eq!(parse_request(&message), Some(Request::Share(path.to_string())));
        }
    }

    #[test]
    fn a_share_path_that_isnt_absolute_or_is_too_long_is_not_sent_as_a_share() {
        assert_eq!(parse_request("share relative\n"), None);
        assert_eq!(parse_request("share \n"), None);
        let long = format!("/{}", "a".repeat(5000));
        assert_eq!(parse_request(&format!("share {long}\n")), None);
        let longest = format!("/{}", "a".repeat(MAX_SHARE_PATH - 1));
        assert_eq!(parse_request(&format!("share {longest}\n")), Some(Request::Share(longest.clone())));
        // Nothing that breaks the line, and no line cut short
        assert_eq!(parse_request("share /a\0b\n"), None);
        assert_eq!(parse_request("share /a/b"), None);
        // What can't be sent as a share goes as a refusal saying why, for the running app to show (#216)
        assert_eq!(request_message(&Request::Share("relative".into())), "share-refused not-absolute relative\n");
        assert_eq!(request_message(&Request::Share("/a\nb".into())), "share-refused line-break /a\u{fffd}b\n");
        assert_eq!(request_message(&Request::Share("/a\0b".into())), "share-refused line-break /a\u{fffd}b\n");
        assert!(request_message(&Request::Share(long)).starts_with("share-refused too-long \u{2026}aaa"));
    }

    // #216: a later start's --share as the file system has it: a path that can't be shared becomes a refusal saying
    // why, never a share of some other path, and the running app shows it
    #[test]
    fn a_share_path_that_cant_be_shared_becomes_a_refusal_saying_why() {
        use std::os::unix::ffi::OsStrExt;
        let refused = |shown: &str, problem| Request::ShareRefused { shown: shown.to_string(), problem };
        assert_eq!(share_request(OsStr::new("/home/u/ProtonDrive/a b.pdf")), Request::Share("/home/u/ProtonDrive/a b.pdf".into()));
        assert_eq!(share_request(OsStr::from_bytes(b"/d/caf\xe9.txt")), refused("/d/caf\u{fffd}.txt", PathProblem::NotUtf8));
        assert_eq!(share_request(OsStr::new("/d/two\nlines.txt")), refused("/d/two\u{fffd}lines.txt", PathProblem::LineBreak));
        assert_eq!(share_request(OsStr::new("Docs/a.pdf")), refused("Docs/a.pdf", PathProblem::NotAbsolute));
        assert_eq!(share_request(OsStr::new("")), refused("", PathProblem::NotAbsolute));
        // A path too long to travel: its end (which names the item) is shown, within the limit
        let long = format!("/{}/end.pdf", "a".repeat(MAX_SHARE_PATH));
        let Request::ShareRefused { shown, problem: PathProblem::TooLong } = share_request(OsStr::new(&long)) else {
            panic!("too long");
        };
        assert!(shown.starts_with('\u{2026}') && shown.ends_with("aaa/end.pdf") && shown.len() <= MAX_SHOWN, "{shown}");
        // A name that is too long and not UTF-8 is cut at a character's edge
        let mut bytes = b"/".to_vec();
        bytes.extend("\u{e9}".repeat(MAX_SHOWN).as_bytes());
        bytes.push(0xff);
        let Request::ShareRefused { shown, problem: PathProblem::NotUtf8 } = share_request(OsStr::from_bytes(&bytes)) else {
            panic!("not UTF-8");
        };
        assert!(shown.len() <= MAX_SHOWN && shown.ends_with("\u{e9}\u{fffd}"), "{shown}");
    }

    #[test]
    fn a_share_refusal_travels_on_one_line() {
        for problem in [PathProblem::NotAbsolute, PathProblem::TooLong, PathProblem::LineBreak, PathProblem::NotUtf8] {
            let request = Request::ShareRefused { shown: "/d/r\u{e9}sum\u{e9} 2.pdf".into(), problem };
            let message = request_message(&request);
            assert_eq!(message.matches('\n').count(), 1, "{message:?}");
            assert_eq!(parse_request(&message), Some(request));
        }
        // Even one made with a line break in it: it is shown on one line
        let made = Request::ShareRefused { shown: "/d/a\nb".into(), problem: PathProblem::LineBreak };
        assert_eq!(request_message(&made), "share-refused line-break /d/a\u{fffd}b\n");
        assert_eq!(parse_request("share-refused not-absolute \n"), Some(Request::ShareRefused { shown: String::new(), problem: PathProblem::NotAbsolute }));
        // An unknown reason, or a line cut short, isn't one
        assert_eq!(parse_request("share-refused upside-down /a\n"), None);
        assert_eq!(parse_request("share-refused line-break /a"), None);
        assert_eq!(parse_request("share-refused\n"), None);
    }

    #[test]
    fn a_running_app_gets_a_share_request_with_the_longest_path() {
        let dir = temp_dir("share");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || serve(listener, move |request| sink.lock().unwrap().push(request)));
        let longest = format!("/{}", "a".repeat(MAX_SHARE_PATH - 1));
        for path in ["/home/u/ProtonDrive/My Docs/a.pdf", longest.as_str(), "Docs/a.pdf"] {
            assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(2), &Request::Share(path.to_string())).unwrap(), Claim::Signalled));
        }
        let refused = Request::ShareRefused { shown: "Docs/a.pdf".into(), problem: PathProblem::NotAbsolute };
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Request::Share("/home/u/ProtonDrive/My Docs/a.pdf".to_string()), Request::Share(longest), refused]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_running_app_that_only_knows_show_is_still_shown_on_a_share() {
        let dir = temp_dir("oldshare");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let shown = Arc::new(AtomicUsize::new(0));
        let counter = shown.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_ok() && line.trim() == "show" {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(b"ok\n");
                }
            }
        });
        let started = Instant::now();
        let share = Request::Share("/home/u/ProtonDrive/a.pdf".to_string());
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(5), &share).unwrap(), Claim::Signalled));
        assert_eq!(shown.load(Ordering::SeqCst), 1);
        // A refusal too
        let refused = Request::ShareRefused { shown: "a.pdf".into(), problem: PathProblem::NotAbsolute };
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(5), &refused).unwrap(), Claim::Signalled));
        assert_eq!(shown.load(Ordering::SeqCst), 2);
        assert!(started.elapsed() < Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_running_app_that_only_knows_show_is_still_shown() {
        // An app from before #203, during an upgrade: it answers "show" and nothing else
        let dir = temp_dir("old");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let shown = Arc::new(AtomicUsize::new(0));
        let counter = shown.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_ok() && line.trim() == "show" {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(b"ok\n");
                }
            }
        });
        let started = Instant::now();
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(5), &Request::Show(Some("home".into()))).unwrap(), Claim::Signalled));
        assert_eq!(shown.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_secs(2), "it fell back at once, not after the wait");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hung_app_is_asked_once_per_try_not_again_with_the_plain_request() {
        let dir = temp_dir("hung");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        std::thread::spawn(move || {
            let mut held = Vec::new(); // never answered, never closed: a hung app
            for stream in listener.incoming().flatten() {
                counter.fetch_add(1, Ordering::SeqCst);
                held.push(stream);
            }
        });
        // No wait beyond one try: one request, and no fallback after its timeout
        assert!(matches!(claim(&paths, uid(), true, Duration::ZERO, &Request::Show(Some("home".into()))).unwrap(), Claim::Signalled));
        assert_eq!(connections.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_socket_left_by_a_crashed_gui_does_not_block_the_next_start() {
        let dir = temp_dir("stale");
        let paths = paths_in(&dir);
        // A socket file nobody listens on, and no lock held: what a crash leaves
        drop(UnixListener::bind(&paths.socket).unwrap());
        assert!(paths.socket.exists());
        let claimed = claim(&paths, uid(), true, Duration::from_millis(300), &Request::Show(None)).unwrap();
        assert!(matches!(claimed, Claim::Primary { .. }));
        drop(claimed);
        // Once the primary has gone (lock released), the next start is the primary again
        assert!(matches!(claim(&paths, uid(), true, Duration::from_millis(300), &Request::Show(None)).unwrap(), Claim::Primary { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn starts_at_once_give_exactly_one_primary() {
        let dir = temp_dir("race");
        let paths = paths_in(&dir);
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let paths = paths.clone();
                std::thread::spawn(move || match claim(&paths, uid(), true, Duration::from_secs(3), &Request::Show(None)).unwrap() {
                    Claim::Primary { lock, listener } => {
                        std::thread::spawn(move || serve(listener, |_| {}));
                        // Hold the lock until every other start has finished
                        std::thread::sleep(Duration::from_millis(1500));
                        drop(lock);
                        1
                    }
                    Claim::Signalled => 0,
                })
            })
            .collect();
        let primaries: i32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(primaries, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_fallback_folder_is_made_private_and_a_shared_one_is_refused() {
        let dir = temp_dir("fallback");
        let paths = instance_paths(None, dir.clone(), uid());
        assert!(matches!(claim(&paths, uid(), false, Duration::from_millis(100), &Request::Show(None)).unwrap(), Claim::Primary { .. }));
        let folder = paths.lock.parent().unwrap();
        assert_eq!(std::fs::metadata(folder).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(claim(&paths, uid(), false, Duration::from_millis(100), &Request::Show(None)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #225: a same-user client that trickles bytes slowly must not hold up later requests
    #[test]
    fn a_slow_client_trickling_bytes_does_not_block_another_request() {
        let dir = temp_dir("slow");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || serve(listener, move |request| sink.lock().unwrap().push(request)));

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let sock = paths.socket.clone();
        let trickler = std::thread::spawn(move || {
            let mut stream = UnixStream::connect(&sock).unwrap();
            let _ = stream.write_all(b"share /");
            let _ = started_tx.send(());
            for _ in 0..30 {
                if stop_rx.recv_timeout(Duration::from_millis(120)).is_ok() {
                    break;
                }
                if stream.write_all(b"a").is_err() {
                    break;
                }
            }
        });

        started_rx.recv().unwrap();
        // Give serve a moment to enter read() on the trickling connection
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        assert!(signal(&paths.socket, &Request::Show(Some("home".into()))), "second request should be answered");
        assert!(started.elapsed() < Duration::from_secs(1), "second request waited {:?}", started.elapsed());
        assert_eq!(*seen.lock().unwrap(), vec![Request::Show(Some("home".to_string()))]);

        let _ = stop_tx.send(());
        trickler.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #225: a trickling client hits the total deadline even though every individual read returns quickly
    #[test]
    fn a_slow_client_trickling_bytes_hits_the_total_deadline() {
        let dir = temp_dir("slow-deadline");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), &Request::Show(None)).unwrap() else {
            panic!("the first start must be the primary");
        };
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || serve_with_deadline(listener, Duration::from_millis(200), move |request| sink.lock().unwrap().push(request)));

        let mut stream = UnixStream::connect(&paths.socket).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let started = Instant::now();
        let _ = stream.write_all(b"share /");
        // Trickle 1 byte every 35 ms (well below the 200 ms deadline): the server must cut off at the total deadline
        let mut closed = false;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(35));
            if stream.write_all(b"a").is_err() {
                closed = true;
                break;
            }
            // Check whether the peer closed (EOF on read without blocking)
            stream.set_nonblocking(true).unwrap();
            let mut probe = [0u8; 16];
            match stream.read(&mut probe) {
                Ok(0) => {
                    closed = true;
                    break;
                }
                Ok(n) => panic!("unexpected reply from server: {:?}", &probe[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    closed = true;
                    break;
                }
            }
            stream.set_nonblocking(false).unwrap();
        }
        assert!(closed, "server must close a trickling client at its total deadline");
        assert!(started.elapsed() < Duration::from_secs(1), "took too long to close: {:?}", started.elapsed());
        assert!(seen.lock().unwrap().is_empty());
        // A normal request still works afterwards
        assert!(signal(&paths.socket, &Request::Show(None)));
        assert_eq!(*seen.lock().unwrap(), vec![Request::Show(None)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
