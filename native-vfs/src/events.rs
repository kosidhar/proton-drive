// Follows the daemon's GET /fm/events stream on the control socket (#408) so protondrive-vfs hears when items are
// hidden, unhidden, or added/removed remotely outside FUSE.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

/// The daemon sends a ping every 30 s; twice that without any line means the connection is dead.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Cap a single header/event line so a malformed stream can't grow unboundedly.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum DriveEvent {
    Changed { paths: Vec<PathBuf>, subtrees: Vec<PathBuf> },
    Reset,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEvent {
    #[serde(rename = "type")]
    kind: String,
    sync_dir: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    subtrees: Vec<String>,
}

/// Converts an absolute path from `/fm/events` under `sync_dir` into a drive-relative `PathBuf` (`""` for the root).
pub fn rel_from_abs(sync_dir: &str, abs: &str) -> Option<PathBuf> {
    let root = sync_dir.trim_end_matches('/');
    if root.is_empty() {
        return None;
    }
    if abs == root {
        return Some(PathBuf::new());
    }
    let rest = abs.strip_prefix(root)?.strip_prefix('/')?.trim_start_matches('/');
    Some(PathBuf::from(rest))
}

fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> io::Result<usize> {
    buf.clear();
    let mut total = 0;
    loop {
        let avail = match reader.fill_buf() {
            Ok(avail) => avail,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if avail.is_empty() {
            return Ok(total);
        }
        let (take, done) = match avail.iter().position(|&b| b == b'\n') {
            Some(pos) => (pos + 1, true),
            None => (avail.len(), false),
        };
        if total + take > MAX_LINE_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "event line too long"));
        }
        buf.extend_from_slice(&avail[..take]);
        reader.consume(take);
        total += take;
        if done {
            return Ok(total);
        }
    }
}

/// Reads an HTTP/1.1 response header block and returns whether `Transfer-Encoding: chunked` is set.
fn read_headers<R: BufRead>(reader: &mut R) -> io::Result<bool> {
    let mut line = Vec::new();
    let n = read_line_capped(reader, &mut line)?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "empty response"));
    }
    let status_line = std::str::from_utf8(&line).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad status"))?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing status"))?;
    if status != 200 {
        return Err(io::Error::other(format!("HTTP {status}")));
    }
    let mut chunked = false;
    loop {
        let n = read_line_capped(reader, &mut line)?;
        if n == 0 || line == b"\r\n" || line == b"\n" {
            break;
        }
        if let Ok(text) = std::str::from_utf8(&line) {
            if let Some((k, v)) = text.split_once(':') {
                if k.trim().eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked") {
                    chunked = true;
                }
            }
        }
    }
    Ok(chunked)
}

/// Reads one NDJSON stream (chunked or plain) from `reader` and hands parsed `DriveEvent`s to `on_event`.
/// Sets `*got_any = true` as soon as any valid event arrives (so callers know the session was established even if the
/// stream later fails with `ECONNRESET` or timeout). When `reset_on_hello` is true, emits `DriveEvent::Reset` as soon
/// as `hello` arrives so changes missed while disconnected (or before the daemon came up) are reconciled immediately.
pub fn read_stream<R: BufRead>(
    reader: &mut R,
    reset_on_hello: bool,
    got_any: &mut bool,
    mut on_event: impl FnMut(DriveEvent),
    should_stop: &impl Fn() -> bool,
) -> io::Result<()> {
    let chunked = read_headers(reader)?;
    let mut sync_dir = String::new();
    let mut pending_reset = reset_on_hello;
    let mut pending = Vec::new();
    let mut line = Vec::new();

    let mut handle_line = |raw: &[u8]| {
        let text = match std::str::from_utf8(raw) {
            Ok(t) => t.trim(),
            Err(_) => return,
        };
        if text.is_empty() {
            return;
        }
        let Ok(ev) = serde_json::from_str::<RawEvent>(text) else { return };
        *got_any = true;
        match ev.kind.as_str() {
            "hello" => {
                if let Some(dir) = ev.sync_dir {
                    sync_dir = dir;
                }
                if pending_reset {
                    pending_reset = false;
                    on_event(DriveEvent::Reset);
                }
            }
            "reset" => {
                if let Some(dir) = ev.sync_dir {
                    sync_dir = dir;
                }
                pending_reset = false;
                on_event(DriveEvent::Reset);
            }
            "changed" => {
                if pending_reset {
                    pending_reset = false;
                    on_event(DriveEvent::Reset);
                }
                let paths = ev.paths.iter().filter_map(|p| rel_from_abs(&sync_dir, p)).collect();
                let subtrees = ev.subtrees.iter().filter_map(|p| rel_from_abs(&sync_dir, p)).collect();
                on_event(DriveEvent::Changed { paths, subtrees });
            }
            _ => {}
        }
    };

    if chunked {
        loop {
            if should_stop() {
                return Ok(());
            }
            let n = read_line_capped(reader, &mut line)?;
            if n == 0 {
                break;
            }
            let size_str = std::str::from_utf8(&line)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk header"))?
                .trim();
            let size_hex = size_str.split(';').next().unwrap_or("").trim();
            if size_hex.is_empty() {
                continue;
            }
            let size = usize::from_str_radix(size_hex, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))?;
            if size == 0 {
                break;
            }
            if size > MAX_LINE_BYTES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "chunk too large"));
            }
            let start = pending.len();
            if start + size > MAX_LINE_BYTES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "buffered event too large"));
            }
            pending.resize(start + size, 0);
            reader.read_exact(&mut pending[start..])?;
            // Trailing CRLF after chunk payload
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf)?;
            if crlf != *b"\r\n" {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "bad chunk trailer"));
            }
            while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                handle_line(&pending[..pos]);
                pending.drain(..=pos);
            }
        }
    } else {
        loop {
            if should_stop() {
                return Ok(());
            }
            let n = read_line_capped(reader, &mut line)?;
            if n == 0 {
                break;
            }
            handle_line(&line);
        }
    }
    Ok(())
}

/// Connects to `GET /fm/events` on `socket`, reconnecting with exponential backoff until `should_stop()` returns true.
pub fn follow_events(socket: &Path, mut on_event: impl FnMut(DriveEvent), should_stop: impl Fn() -> bool) {
    let mut backoff = INITIAL_BACKOFF;
    while !should_stop() {
        let mut got_any = false;
        // Always reconcile tracked folders on `hello`: a no-op on normal startup when no folder has been opened yet,
        // and recovers missed changes both after a daemon disconnect/error and if the helper mounted before the daemon.
        let _ = connect_and_read(socket, true, &mut got_any, &mut on_event, &should_stop);
        if should_stop() {
            break;
        }
        backoff = if got_any { INITIAL_BACKOFF } else { (backoff * 2).min(MAX_BACKOFF) };
        // Sleep in small slices so shutdown ends promptly
        let steps = (backoff.as_millis() / 100).max(1);
        for _ in 0..steps {
            if should_stop() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn connect_and_read(
    socket: &Path,
    reset_on_hello: bool,
    got_any: &mut bool,
    on_event: &mut impl FnMut(DriveEvent),
    should_stop: &impl Fn() -> bool,
) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = stream.set_read_timeout(Some(STREAM_READ_TIMEOUT));
    stream.write_all(b"GET /fm/events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    read_stream(&mut reader, reset_on_hello, got_any, on_event, should_stop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunked(lines: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for line in lines {
            let payload = format!("{line}\n");
            out.extend_from_slice(format!("{:x}\r\n{}\r\n", payload.len(), payload).as_bytes());
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    #[test]
    fn rel_from_abs_strips_sync_dir_prefix() {
        assert_eq!(rel_from_abs("/home/u/ProtonDrive", "/home/u/ProtonDrive"), Some(PathBuf::new()));
        assert_eq!(rel_from_abs("/home/u/ProtonDrive/", "/home/u/ProtonDrive"), Some(PathBuf::new()));
        assert_eq!(rel_from_abs("/home/u/ProtonDrive/", "/home/u/ProtonDrive//xyz"), Some(PathBuf::from("xyz")));
        assert_eq!(rel_from_abs("/home/u/ProtonDrive", "/home/u/ProtonDrive/xyz"), Some(PathBuf::from("xyz")));
        assert_eq!(rel_from_abs("/home/u/ProtonDrive", "/home/u/ProtonDrive/a/b.txt"), Some(PathBuf::from("a/b.txt")));
        assert_eq!(rel_from_abs("/home/u/ProtonDrive", "/home/u/ProtonDrive2/a"), None);
        assert_eq!(rel_from_abs("", "/home/u/ProtonDrive/a"), None);
    }

    #[test]
    fn reads_chunked_ndjson_events_and_ignores_pings() {
        let mut raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        raw.extend_from_slice(&chunked(&[
            r#"{"type":"hello","syncDir":"/home/u/ProtonDrive","mode":"virtual"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"changed","paths":["/home/u/ProtonDrive","/home/u/ProtonDrive/xyz"],"subtrees":["/home/u/ProtonDrive/xyz"]}"#,
            r#"{"type":"reset","syncDir":"/home/u/ProtonDrive","mode":"virtual"}"#,
        ]));
        let mut seen = Vec::new();
        let mut got_any = false;
        read_stream(&mut BufReader::new(raw.as_slice()), false, &mut got_any, |ev| seen.push(ev), &|| false).unwrap();
        assert!(got_any);
        assert_eq!(
            seen,
            vec![
                DriveEvent::Changed {
                    paths: vec![PathBuf::new(), PathBuf::from("xyz")],
                    subtrees: vec![PathBuf::from("xyz")],
                },
                DriveEvent::Reset,
            ]
        );
    }

    #[test]
    fn reconnect_emits_reset_immediately_on_hello_and_tracks_established_session_on_error() {
        // Truncated second chunk simulates a mid-stream disconnect after `hello`
        let hello = "{\"type\":\"hello\",\"syncDir\":\"/home/u/ProtonDrive\",\"mode\":\"virtual\"}\n";
        let mut raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        raw.extend_from_slice(format!("{:x}\r\n{}\r\n20\r\ntrunc", hello.len(), hello).as_bytes());
        let mut seen = Vec::new();
        let mut got_any = false;
        let err = read_stream(&mut BufReader::new(raw.as_slice()), true, &mut got_any, |ev| seen.push(ev), &|| false);
        assert!(err.is_err(), "truncated chunk should return an error");
        assert!(got_any, "got_any must remain true after hello even when the stream later errors");
        assert_eq!(seen, vec![DriveEvent::Reset]);
    }

    #[test]
    fn rejects_non_200_responses() {
        let raw = b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}";
        let mut got_any = false;
        let err = read_stream(&mut BufReader::new(raw.as_slice()), false, &mut got_any, |_| {}, &|| false).unwrap_err();
        assert!(err.to_string().contains("404"));
        assert!(!got_any);
    }
}
