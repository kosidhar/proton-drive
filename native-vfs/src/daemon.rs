// The daemon's drive routes, over HTTP/1.1 on its user-only control socket (the same client shape as the GUI's
// control_request): GET /vfs/children for listings, POST /vfs/hydrate to download a file an app opened.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Deserialize;

use crate::listing::{Entry, Kind};

/// A listing answers fast; a lookup waits no longer than this when the daemon is stuck.
pub const CHILDREN_TIMEOUT: Duration = Duration::from_secs(3);
/// A download for an open completes or fails within 30 minutes.
pub const HYDRATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Problems reaching the daemon go to stderr at most this often.
const LOG_EVERY: Duration = Duration::from_secs(60);

/// What a route failed with: the errno to give the kernel, and why.
#[derive(Debug, PartialEq, Eq)]
pub struct DaemonError {
    pub errno: i32,
    pub message: String,
}

impl DaemonError {
    fn eio(message: impl Into<String>) -> Self {
        DaemonError { errno: libc::EIO, message: message.into() }
    }
}

pub struct DaemonClient {
    socket: PathBuf,
    last_logged: Mutex<Option<Instant>>,
}

impl DaemonClient {
    pub fn new(socket: PathBuf) -> Self {
        DaemonClient { socket, last_logged: Mutex::new(None) }
    }

    /// The cloud's entries of a folder (relPath inside My files, '' for the top), downloaded ones included.
    pub fn children(&self, rel: &str) -> Result<Vec<Entry>, DaemonError> {
        let target = format!("/vfs/children?path={}", encode_query_value(rel));
        parse_children(self.request("GET", &target, None, CHILDREN_TIMEOUT)?)
    }

    /// The cloud's entries, or none when the daemon can't say: the backing store's entries still show.
    pub fn children_or_empty(&self, rel: &str) -> Vec<Entry> {
        self.children(rel).unwrap_or_else(|err| {
            self.log(&format!("can't list {rel:?} from the daemon, showing local files only: {}", err.message));
            Vec::new()
        })
    }

    /// Waits for the daemon to download the file into the backing store.
    pub fn hydrate(&self, rel: &str) -> Result<(), DaemonError> {
        let body = serde_json::json!({ "path": rel });
        self.request("POST", "/vfs/hydrate", Some(&body), HYDRATE_TIMEOUT).map(|_| ())
    }

    pub fn log(&self, message: &str) {
        let mut last = self.last_logged.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_none_or(|at| at.elapsed() >= LOG_EVERY) {
            *last = Some(Instant::now());
            eprintln!("protondrive-vfs: {message}");
        }
    }

    fn request(
        &self,
        method: &str,
        target: &str,
        body: Option<&serde_json::Value>,
        timeout: Duration,
    ) -> Result<serde_json::Value, DaemonError> {
        let deadline = Instant::now() + timeout;
        let unreachable = |e: std::io::Error| DaemonError::eio(format!("can't reach the daemon ({e})"));
        let mut stream = UnixStream::connect(&self.socket).map_err(unreachable)?;
        stream.set_write_timeout(Some(WRITE_TIMEOUT)).map_err(unreachable)?;

        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut request = format!("{method} {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n");
        if body.is_some() {
            request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
        }
        request.push_str("\r\n");
        request.push_str(&payload);
        stream.write_all(request.as_bytes()).map_err(unreachable)?;

        // Read until EOF (Connection: close) or the whole Content-Length, whichever comes first, within the deadline:
        // a daemon killed or stuck mid-request fails the call instead of holding a FUSE thread
        let mut raw = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        let mut head_end = None;
        let mut full_length = None; // head and body, once the head is in and gives a Content-Length
        while full_length.is_none_or(|len| raw.len() < len) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(DaemonError::eio(format!("the daemon didn't answer within {timeout:?}")));
            }
            stream.set_read_timeout(Some(left)).map_err(unreachable)?;
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    return Err(DaemonError::eio(format!("the daemon didn't answer within {timeout:?}")));
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
        assert_eq!(parse_reply(refused).unwrap_err(), DaemonError { errno: libc::EACCES, message: "Hidden: a".into() });
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
        let reply = client.request("POST", "/vfs/hydrate", None, Duration::from_secs(5));
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
        let reply = client.request("GET", "/vfs/children?path=", None, Duration::from_millis(300));
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
        let reply = client.hydrate("a.txt");
        let _ = std::fs::remove_file(&client.socket);
        assert_eq!(reply.unwrap_err(), DaemonError::eio("the daemon closed the connection without answering"));
    }

    #[test]
    fn an_unreachable_daemon_is_eio() {
        let client = DaemonClient::new(std::env::temp_dir().join("protondrive-vfs-no-such.sock"));
        assert_eq!(client.children("").unwrap_err().errno, libc::EIO);
        assert_eq!(client.hydrate("a.txt").unwrap_err().errno, libc::EIO);
    }
}
