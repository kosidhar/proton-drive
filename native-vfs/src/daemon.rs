// The daemon's drive routes, over HTTP/1.1 on its user-only control socket (the same client shape as the GUI's
// control_request): GET /vfs/children for listings, POST /vfs/hydrate to download a file an app opened, POST
// /vfs/truncate to make an online-only file an empty local one, and POST /vfs/rename and /vfs/delete for renames and
// deletes through the drive, which the daemon carries out whole.

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Deserialize;

use crate::listing::{Entry, Kind};

/// A listing answers fast; a lookup waits no longer than this when the daemon is stuck.
pub const CHILDREN_TIMEOUT: Duration = Duration::from_secs(3);
/// A download for an open completes or fails within 30 minutes.
pub const HYDRATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A rename, delete or truncate waits its turn in the daemon's queue, but changes only this computer: no network. One
/// that takes longer still happens in the daemon afterwards (nothing cancels it), though the app has been told EIO.
pub const CHANGE_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// A daemon whose connection backlog stays full this long isn't serving.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a waiting request asks whether to give up (a hydrate: whether its opener did).
const INTERRUPT_CHECK: Duration = Duration::from_millis(500);
/// After a listing finds the daemon stuck, listings go without it this long.
const LISTING_BACKOFF: Duration = Duration::from_secs(5);
/// Listing problems go to stderr at most this often.
const LOG_EVERY: Duration = Duration::from_secs(60);

/// What a delete through the drive is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    Unlink,
    /// Only a folder that holds nothing, here or in the cloud
    Rmdir,
    /// A Move to Trash: what exists only on this computer goes to the desktop Trash rather than away
    Trash,
}

/// What a route failed with: the errno to give the kernel, and why.
#[derive(Debug, PartialEq, Eq)]
pub struct DaemonError {
    pub errno: i32,
    pub message: String,
    /// The daemon is there but didn't take or answer the request in time, as opposed to gone or refusing
    pub stuck: bool,
}

impl DaemonError {
    fn eio(message: impl Into<String>) -> Self {
        DaemonError { errno: libc::EIO, message: message.into(), stuck: false }
    }

    fn stuck(message: impl Into<String>) -> Self {
        DaemonError { errno: libc::EIO, message: message.into(), stuck: true }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct DaemonClient {
    socket: PathBuf,
    children_timeout: Duration,
    listing_backoff_until: Mutex<Option<Instant>>,
    last_logged: Mutex<Option<Instant>>,
}

impl DaemonClient {
    pub fn new(socket: PathBuf) -> Self {
        DaemonClient {
            socket,
            children_timeout: CHILDREN_TIMEOUT,
            listing_backoff_until: Mutex::new(None),
            last_logged: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn with_children_timeout(mut self, timeout: Duration) -> Self {
        self.children_timeout = timeout;
        self
    }

    /// The cloud's entries of a folder (relPath inside My files, '' for the top), downloaded ones included.
    pub fn children(&self, rel: &str) -> Result<Vec<Entry>, DaemonError> {
        let target = format!("/vfs/children?path={}", encode_query_value(rel));
        parse_children(self.request("GET", &target, None, self.children_timeout, &|| false)?)
    }

    /// The cloud's entries, or none when the daemon can't say: the backing store's entries still show. Once the
    /// daemon is found stuck, listings skip it for a few seconds, so a hung daemon doesn't cost every lookup the
    /// whole timeout (a daemon that is gone fails at once, and is asked again next time).
    pub fn children_or_empty(&self, rel: &str) -> Vec<Entry> {
        if lock(&self.listing_backoff_until).is_some_and(|until| Instant::now() < until) {
            return Vec::new();
        }
        self.children(rel).unwrap_or_else(|err| {
            if err.stuck {
                *lock(&self.listing_backoff_until) = Some(Instant::now() + LISTING_BACKOFF);
            }
            let mut last = lock(&self.last_logged);
            if last.is_none_or(|at| at.elapsed() >= LOG_EVERY) {
                *last = Some(Instant::now());
                eprintln!("protondrive-vfs: can't list {rel:?} from the daemon, showing local files only: {}", err.message);
            }
            Vec::new()
        })
    }

    /// Waits for the daemon to download the file into the backing store, giving up with EINTR as soon as
    /// `interrupted` says so (it is asked every half second).
    pub fn hydrate(&self, rel: &str, interrupted: &dyn Fn() -> bool) -> Result<(), DaemonError> {
        let body = serde_json::json!({ "path": rel });
        self.request("POST", "/vfs/hydrate", Some(&body), HYDRATE_TIMEOUT, interrupted).map(|_| ())
    }

    /// Renames or moves an item of the drive: the daemon does all of it (the local copy, its records, the listing, and
    /// the cloud's later on). With `no_replace`, anything at `to` refuses it with EEXIST.
    pub fn rename(&self, from: &str, to: &str, no_replace: bool) -> Result<(), DaemonError> {
        let mut body = serde_json::json!({ "from": from, "to": to });
        if no_replace {
            body["noReplace"] = serde_json::Value::Bool(true);
        }
        self.request("POST", "/vfs/rename", Some(&body), CHANGE_TIMEOUT, &|| false).map(|_| ())
    }

    /// Deletes an item of the drive, everything in it included, and moves it to the cloud's trash later on. An rmdir
    /// of a folder holding anything, here or in the cloud, is refused with ENOTEMPTY.
    pub fn delete(&self, rel: &str, removal: Removal) -> Result<(), DaemonError> {
        let mut body = serde_json::json!({ "path": rel });
        match removal {
            Removal::Unlink => {}
            Removal::Rmdir => body["onlyIfEmpty"] = serde_json::Value::Bool(true),
            Removal::Trash => body["trash"] = serde_json::Value::Bool(true),
        }
        self.request("POST", "/vfs/delete", Some(&body), CHANGE_TIMEOUT, &|| false).map(|_| ())
    }

    /// Makes an online-only file an empty local one, with nothing downloaded; the daemon keeps what the drive showed
    /// of it as what its new content is an edit of. EEXIST when it is on this computer already.
    pub fn truncate(&self, rel: &str) -> Result<(), DaemonError> {
        let body = serde_json::json!({ "path": rel });
        self.request("POST", "/vfs/truncate", Some(&body), CHANGE_TIMEOUT, &|| false).map(|_| ())
    }

    fn request(
        &self,
        method: &str,
        target: &str,
        body: Option<&serde_json::Value>,
        timeout: Duration,
        interrupted: &dyn Fn() -> bool,
    ) -> Result<serde_json::Value, DaemonError> {
        let deadline = Instant::now() + timeout;
        let unreachable = |e: std::io::Error| DaemonError::eio(format!("can't reach the daemon ({e})"));
        let mut stream = match connect_within(&self.socket, CONNECT_TIMEOUT.min(timeout)) {
            Ok(stream) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.raw_os_error() == Some(libc::ETIMEDOUT) => {
                return Err(DaemonError::stuck("the daemon isn't taking requests"));
            }
            Err(e) => return Err(unreachable(e)),
        };
        stream.set_write_timeout(Some(WRITE_TIMEOUT.min(timeout))).map_err(unreachable)?;

        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut request = format!("{method} {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n");
        if body.is_some() {
            request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
        }
        request.push_str("\r\n");
        request.push_str(&payload);
        stream.write_all(request.as_bytes()).map_err(unreachable)?;

        // Read until EOF (Connection: close) or the whole Content-Length, whichever comes first, within the deadline:
        // a daemon killed or stuck mid-request fails the call instead of holding a FUSE thread. The reads wake every
        // half second to ask whether to give up
        let mut raw = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        let mut head_end = None;
        let mut full_length = None; // head and body, once the head is in and gives a Content-Length
        while full_length.is_none_or(|len| raw.len() < len) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(DaemonError::stuck(format!("the daemon didn't answer within {timeout:?}")));
            }
            stream.set_read_timeout(Some(left.min(INTERRUPT_CHECK))).map_err(unreachable)?;
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    if interrupted() {
                        let message = "the opener stopped waiting".to_string();
                        return Err(DaemonError { errno: libc::EINTR, message, stuck: false });
                    }
                    continue;
                }
                Err(e) => return Err(unreachable(e)),
            }
            if head_end.is_none() {
                head_end = find_head_end(&raw);
                if let Some(end) = head_end {
                    full_length = content_length(&String::from_utf8_lossy(&raw[..end])).map(|len| end + 4 + len);
                }
            }
        }
        if raw.is_empty() {
            return Err(DaemonError::eio("the daemon closed the connection without answering"));
        }
        parse_reply(&raw)
    }
}

/// Percent-encodes every byte but the unreserved ones: the daemon reads the query with URLSearchParams, which turns
/// a bare `+` into a space.
pub fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn errno_of_code(code: Option<&str>) -> i32 {
    match code {
        Some("ENOENT") => libc::ENOENT,
        Some("EEXIST") => libc::EEXIST,
        Some("EACCES") => libc::EACCES,
        Some("EXDEV") => libc::EXDEV,
        Some("ENOTEMPTY") => libc::ENOTEMPTY,
        _ => libc::EIO,
    }
}

#[derive(Deserialize)]
struct WireChildren {
    entries: Vec<WireEntry>,
}

#[derive(Deserialize)]
struct WireEntry {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    size: f64,
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
}

fn parse_children(body: serde_json::Value) -> Result<Vec<Entry>, DaemonError> {
    let wire: WireChildren =
        serde_json::from_value(body).map_err(|e| DaemonError::eio(format!("unreadable listing from the daemon ({e})")))?;
    Ok(wire
        .entries
        .into_iter()
        .filter_map(|e| {
            let kind = match e.kind.as_str() {
                "file" => Kind::File,
                "folder" => Kind::Folder,
                _ => return None,
            };
            // A name the kernel could never ask for, or one that would climb out of its folder
            if e.name.is_empty() || e.name == "." || e.name == ".." || e.name.contains(['/', '\0']) {
                return None;
            }
            // `as` saturates: a negative or NaN number is 0
            let mtime = UNIX_EPOCH + Duration::from_millis(e.mtime_ms as u64);
            Some(Entry { name: e.name.into(), kind, size: e.size as u64, mtime, local: false })
        })
        .collect())
}

/// A connection to the Unix socket, or an error once `timeout` passes: a connect to a full backlog (a daemon that is
/// alive but not accepting) otherwise waits for SO_SNDTIMEO, which std leaves unlimited. A timeout is WouldBlock.
fn connect_within(path: &Path, timeout: Duration) -> std::io::Result<UnixStream> {
    let (addr, len) = unix_addr(path)?;
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let timeout = timeout.max(Duration::from_millis(1)); // zero would mean no limit
    let limit = libc::timeval {
        tv_sec: timeout.as_secs() as libc::time_t,
        tv_usec: timeout.subsec_micros() as libc::suseconds_t,
    };
    let size = std::mem::size_of::<libc::timeval>() as libc::socklen_t;
    let set = unsafe { libc::setsockopt(fd.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDTIMEO, (&raw const limit).cast(), size) };
    if set != 0 || unsafe { libc::connect(fd.as_raw_fd(), (&raw const addr).cast(), len) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(UnixStream::from(fd))
}

/// The address of a Unix socket path, for connect(2).
fn unix_addr(path: &Path) -> std::io::Result<(libc::sockaddr_un, libc::socklen_t)> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= addr.sun_path.len() {
        return Err(std::io::Error::from_raw_os_error(libc::ENAMETOOLONG));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (dst, &src) in addr.sun_path.iter_mut().zip(bytes) {
        *dst = src as libc::c_char;
    }
    let len = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    Ok((addr, len as libc::socklen_t))
}

fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length(head: &str) -> Option<usize> {
    head.lines().skip(1).find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok())?
    })
}

fn parse_reply(raw: &[u8]) -> Result<serde_json::Value, DaemonError> {
    const MALFORMED: &str = "malformed reply from the daemon";
    let split = find_head_end(raw).ok_or_else(|| DaemonError::eio(MALFORMED))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| DaemonError::eio(MALFORMED))?;
    let mut body = &raw[split + 4..];
    if let Some(len) = content_length(&head).filter(|len| *len <= body.len()) {
        body = &body[..len];
    }
    let json: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    if (200..300).contains(&status) {
        return json.ok_or_else(|| DaemonError::eio("unreadable reply from the daemon"));
    }
    let field = |name: &str| json.as_ref().and_then(|j| j.get(name)).and_then(|v| v.as_str());
    Err(DaemonError {
        errno: errno_of_code(field("code")),
        message: field("error").map(String::from).unwrap_or_else(|| format!("the daemon answered {status}")),
        stuck: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // What URLSearchParams does to a query value: `+` is a space, %XX is a byte, the bytes are UTF-8
    fn url_search_params_decode(value: &str) -> String {
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

    #[test]
    fn a_query_value_round_trips_through_url_search_params() {
        let original = "a+b/c%d é";
        let encoded = encode_query_value(original);
        assert_eq!(encoded, "a%2Bb%2Fc%25d%20%C3%A9");
        assert_eq!(url_search_params_decode(&encoded), original);
        assert_eq!(encode_query_value("AZaz09-._~"), "AZaz09-._~");
        assert_eq!(encode_query_value(""), "");
    }

    #[test]
    fn children_json_maps_to_online_entries() {
        let body = serde_json::json!({ "entries": [
            { "name": "photo.jpg", "type": "file", "size": 1234, "mtimeMs": 1_700_000_000_500u64 },
            { "name": "Docs", "type": "folder", "size": 0, "mtimeMs": 0 },
        ] });
        let entries = parse_children(body).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "photo.jpg");
        assert_eq!(entries[0].kind, Kind::File);
        assert_eq!(entries[0].size, 1234);
        assert_eq!(entries[0].mtime, UNIX_EPOCH + Duration::from_millis(1_700_000_000_500));
        assert!(!entries[0].local);
        assert_eq!((entries[1].kind, entries[1].mtime), (Kind::Folder, UNIX_EPOCH));
    }

    #[test]
    fn children_entries_that_cant_be_names_are_skipped() {
        let body = serde_json::json!({ "entries": [
            { "name": "a/b", "type": "file", "size": 1, "mtimeMs": 0 },
            { "name": "..", "type": "folder", "size": 0, "mtimeMs": 0 },
            { "name": "", "type": "file", "size": 1, "mtimeMs": 0 },
            { "name": "x", "type": "symlink", "size": 1, "mtimeMs": 0 },
            { "name": "ok", "type": "file", "size": -5, "mtimeMs": -10 },
        ] });
        let entries = parse_children(body).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].size, entries[0].mtime), (0, UNIX_EPOCH));
        assert_eq!(parse_children(serde_json::json!({ "nope": [] })).unwrap_err().errno, libc::EIO);
    }

    #[test]
    fn error_codes_map_to_errnos() {
        assert_eq!(errno_of_code(Some("ENOENT")), libc::ENOENT);
        assert_eq!(errno_of_code(Some("EEXIST")), libc::EEXIST);
        assert_eq!(errno_of_code(Some("EACCES")), libc::EACCES);
        assert_eq!(errno_of_code(Some("EIO")), libc::EIO);
        assert_eq!(errno_of_code(Some("EXDEV")), libc::EXDEV);
        assert_eq!(errno_of_code(Some("ENOTEMPTY")), libc::ENOTEMPTY);
        assert_eq!(errno_of_code(Some("EWHAT")), libc::EIO);
        assert_eq!(errno_of_code(None), libc::EIO);
    }

    #[test]
    fn replies_parse_to_json_or_an_errno() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}trailing";
        assert_eq!(parse_reply(ok).unwrap(), serde_json::json!({ "ok": true }));
        let refused = b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"Hidden: a\",\"code\":\"EACCES\"}";
        let hidden = DaemonError { errno: libc::EACCES, message: "Hidden: a".into(), stuck: false };
        assert_eq!(parse_reply(refused).unwrap_err(), hidden);
        assert_eq!(parse_reply(b"HTTP/1.1 500 Oops\r\n\r\nnot json").unwrap_err().errno, libc::EIO);
        assert_eq!(parse_reply(b"HTTP/1.1 200 OK\r\n\r\nnot json").unwrap_err().errno, libc::EIO);
        assert_eq!(parse_reply(b"garbage").unwrap_err().errno, libc::EIO);
    }

    // A one-connection server on a temp socket that runs `answer` on the request's stream
    fn serve_once(name: &str, answer: impl FnOnce(UnixStream) + Send + 'static) -> DaemonClient {
        let socket = std::env::temp_dir().join(format!("protondrive-vfs-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                answer(stream);
            }
        });
        DaemonClient::new(socket)
    }

    #[test]
    fn a_reply_ends_at_its_content_length_even_if_the_connection_stays_open() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let client = serve_once("open", move |mut stream| {
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\"");
            std::thread::sleep(Duration::from_millis(50));
            let _ = stream.write_all(b":true}");
            let _ = rx.recv(); // holds the connection open until the test ends
        });
        let started = Instant::now();
        let reply = client.request("POST", "/vfs/hydrate", None, Duration::from_secs(5), &|| false);
        let _ = std::fs::remove_file(&client.socket);
        assert_eq!(reply.unwrap(), serde_json::json!({ "ok": true }));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(tx);
    }

    #[test]
    fn a_daemon_that_never_answers_fails_at_the_deadline() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let client = serve_once("stuck", move |_stream| {
            let _ = rx.recv();
        });
        let started = Instant::now();
        let reply = client.request("GET", "/vfs/children?path=", None, Duration::from_millis(300), &|| false);
        let _ = std::fs::remove_file(&client.socket);
        assert_eq!(reply.unwrap_err().errno, libc::EIO);
        assert!(started.elapsed() >= Duration::from_millis(300) && started.elapsed() < Duration::from_secs(2));
        drop(tx);
    }

    #[test]
    fn a_connection_closed_without_an_answer_is_eio() {
        // Reads the request first: closing with it unread would reset the connection instead (EIO all the same)
        let client = serve_once("closed", |mut stream| {
            let _ = stream.read(&mut [0u8; 4096]);
        });
        let reply = client.hydrate("a.txt", &|| false);
        let _ = std::fs::remove_file(&client.socket);
        assert_eq!(reply.unwrap_err(), DaemonError::eio("the daemon closed the connection without answering"));
    }

    // A server that answers `reply` to every connection and hands each request's body to the test
    fn serve_recording(name: &str, reply: &'static str) -> (DaemonClient, std::sync::mpsc::Receiver<serde_json::Value>) {
        let socket = std::env::temp_dir().join(format!("protondrive-vfs-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                // Until the request's body is in
                while let Ok(n @ 1..) = stream.read(&mut buf) {
                    raw.extend_from_slice(&buf[..n]);
                    let Some(end) = find_head_end(&raw) else { continue };
                    let len = content_length(&String::from_utf8_lossy(&raw[..end])).unwrap_or(0);
                    if raw.len() >= end + 4 + len {
                        let _ = tx.send(serde_json::from_slice(&raw[end + 4..]).unwrap_or(serde_json::Value::Null));
                        break;
                    }
                }
                let _ = write!(stream, "{reply}");
            }
        });
        (DaemonClient::new(socket), rx)
    }

    #[test]
    fn renames_and_deletes_send_their_flags_only_when_set() {
        let (client, bodies) = serve_recording("changes", "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}");
        assert_eq!(client.rename("a.txt", "Docs/b.txt", false), Ok(()));
        assert_eq!(client.rename("a.txt", "b.txt", true), Ok(()));
        assert_eq!(client.delete("Docs", Removal::Unlink), Ok(()));
        assert_eq!(client.delete("Docs", Removal::Rmdir), Ok(()));
        assert_eq!(client.delete("Docs", Removal::Trash), Ok(()));
        assert_eq!(client.truncate("Docs/a.txt"), Ok(()));
        let _ = std::fs::remove_file(&client.socket);
        let got: Vec<serde_json::Value> = bodies.try_iter().collect();
        assert_eq!(
            got,
            [
                serde_json::json!({ "from": "a.txt", "to": "Docs/b.txt" }),
                serde_json::json!({ "from": "a.txt", "to": "b.txt", "noReplace": true }),
                serde_json::json!({ "path": "Docs" }),
                serde_json::json!({ "path": "Docs", "onlyIfEmpty": true }),
                serde_json::json!({ "path": "Docs", "trash": true }),
                serde_json::json!({ "path": "Docs/a.txt" }),
            ]
        );
    }

    #[test]
    fn a_refused_rename_or_delete_gives_the_daemons_errno() {
        let reply = "HTTP/1.1 400 Bad Request\r\nContent-Length: 42\r\n\r\n{\"error\":\"Can't replace b\",\"code\":\"EXDEV\"}";
        let (client, _) = serve_recording("refused", reply);
        let refused = client.rename("a", "b", false).unwrap_err();
        assert_eq!((refused.errno, refused.message.as_str()), (libc::EXDEV, "Can't replace b"));
        assert_eq!(client.delete("Docs", Removal::Rmdir).unwrap_err().errno, libc::EXDEV);
        let _ = std::fs::remove_file(&client.socket);
    }

    #[test]
    fn an_unreachable_daemon_is_eio() {
        let client = DaemonClient::new(std::env::temp_dir().join("protondrive-vfs-no-such.sock"));
        assert_eq!(client.children("").unwrap_err().errno, libc::EIO);
        assert_eq!(client.hydrate("a.txt", &|| false).unwrap_err().errno, libc::EIO);
        assert_eq!(client.rename("a.txt", "b.txt", false).unwrap_err().errno, libc::EIO);
        assert_eq!(client.delete("a.txt", Removal::Unlink).unwrap_err().errno, libc::EIO);
        assert_eq!(client.truncate("a.txt").unwrap_err().errno, libc::EIO);
    }

    // Runs `call` on its own thread and gives its result, or None if it is still blocked after `limit`
    fn within<T: Send + 'static>(limit: Duration, call: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(call());
        });
        rx.recv_timeout(limit).ok()
    }

    #[test]
    fn a_daemon_whose_backlog_is_full_fails_within_the_deadline() {
        let socket = std::env::temp_dir().join(format!("protondrive-vfs-backlog-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        // Never accepted, with the smallest backlog, filled by connections that never get answered
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
        let (addr, len) = unix_addr(&socket).unwrap();
        let mut queued = Vec::new();
        for _ in 0..64 {
            let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0) };
            assert!(fd >= 0);
            let fd = unsafe { OwnedFd::from_raw_fd(fd) };
            if unsafe { libc::connect(fd.as_raw_fd(), (&raw const addr).cast(), len) } != 0 {
                break; // EAGAIN: the backlog is full
            }
            queued.push(fd);
        }
        let client = DaemonClient::new(socket.clone()).with_children_timeout(Duration::from_millis(300));
        let outcome = within(Duration::from_secs(3), move || {
            let started = Instant::now();
            (client.children("").map_err(|e| e.errno), started.elapsed())
        });
        let _ = std::fs::remove_file(&socket);
        let (reply, took) = outcome.expect("children() blocked on the full backlog");
        assert_eq!(reply.unwrap_err(), libc::EIO);
        assert!(took < Duration::from_secs(1), "took {took:?}");
        drop((queued, listener));
    }

    #[test]
    fn a_listing_that_fails_slowly_backs_off_the_next_ones() {
        let socket = std::env::temp_dir().join(format!("protondrive-vfs-backoff-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = connections.clone();
        std::thread::spawn(move || {
            let mut held = Vec::new(); // accepted, never answered
            for stream in listener.incoming() {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                held.push(stream);
            }
        });
        let client = DaemonClient::new(socket.clone()).with_children_timeout(Duration::from_millis(300));
        let started = Instant::now();
        assert!(client.children_or_empty("").is_empty());
        assert!(client.children_or_empty("Docs").is_empty());
        let took = started.elapsed();
        std::thread::sleep(Duration::from_millis(50));
        let _ = std::fs::remove_file(&socket);
        assert!(took < Duration::from_millis(900), "the second listing waited too: {took:?}");
        assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_hydrate_stops_waiting_once_the_opener_is_interrupted() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let client = serve_once("interrupted", move |_stream| {
            let _ = rx.recv(); // the download goes on and on
        });
        let socket = client.socket.clone();
        let outcome = within(Duration::from_secs(5), move || {
            let started = Instant::now();
            let reply = client.hydrate("a.txt", &|| started.elapsed() > Duration::from_millis(300));
            (reply.map_err(|e| e.errno), started.elapsed())
        });
        let _ = std::fs::remove_file(&socket);
        drop(tx);
        let (reply, took) = outcome.expect("hydrate kept waiting for an interrupted opener");
        assert_eq!(reply.unwrap_err(), libc::EINTR);
        assert!(took < Duration::from_secs(2), "took {took:?}");
    }
}
