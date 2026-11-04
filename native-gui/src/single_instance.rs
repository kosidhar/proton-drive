//! One app window per user (#129). The first GUI holds a lock file and listens on a socket beside it; a later start
//! (from the tray, the launcher or a terminal) finds the lock taken, asks the running GUI to show itself and exits.
//!
//! The lock decides who is first, not the socket: a socket left by a crashed GUI is just removed by the next one to
//! get the lock, and two starts at once can't both become the primary, since only one gets the lock.

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

/// The request a later start sends: `show`, or `show <section>` to open the running app on that section (#203).
fn show_message(section: Option<&str>) -> String {
    match section.filter(|s| !s.is_empty() && s.len() <= MAX_SECTION && s.bytes().all(|b| b.is_ascii_lowercase())) {
        Some(section) => format!("{SHOW} {section}\n"),
        None => format!("{SHOW}\n"),
    }
}

/// What a request asks: to show the window (Some(None)), on a section (Some(Some(name))), or nothing it knows (None).
fn parse_show(line: &str) -> Option<Option<String>> {
    let mut words = line.split_whitespace();
    if words.next() != Some(SHOW) {
        return None;
    }
    match (words.next(), words.next()) {
        (None, _) => Some(None),
        (Some(section), None) => Some(Some(section.to_string())),
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

fn send_show(socket: &Path, message: &str) -> Sent {
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

/// Asks the GUI listening at `socket` to show itself, on `section` if one is named. True once it has said it will. An
/// app from before sections were passed on knows only `show`: it closes the connection on `show <section>` without a
/// word, so the plain request follows at once and the window still comes to the front. One that doesn't answer at all
/// is hung, and isn't asked twice.
pub fn signal_show(socket: &Path, section: Option<&str>) -> bool {
    let message = show_message(section);
    match send_show(socket, &message) {
        Sent::Answered => true,
        Sent::Closed if message != show_message(None) => send_show(socket, &show_message(None)) == Sent::Answered,
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
    section: Option<&str>,
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
                if signal_show(&paths.socket, section) {
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

/// Answers later starts on `listener`, calling `on_show` with the section asked for (None: just show the window) for
/// each request. Runs until the listener fails; a request it doesn't know is ignored, unanswered.
pub fn serve(listener: UnixListener, on_show: impl Fn(Option<String>) + Send + 'static) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut line = String::new();
        // A request is one short line: never read more than that
        if BufReader::new(&stream).take(256).read_line(&mut line).is_err() {
            continue;
        }
        if let Some(section) = parse_show(&line) {
            on_show(section);
            let _ = stream.write_all(b"ok\n");
        }
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
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), None).unwrap() else {
            panic!("the first start must be the primary");
        };
        let shown = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = shown.clone();
        std::thread::spawn(move || serve(listener, move |section| seen.lock().unwrap().push(section)));
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(2), None).unwrap(), Claim::Signalled));
        // #203: a start that names a section passes it on, so the running app opens there
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(2), Some("home")).unwrap(), Claim::Signalled));
        assert_eq!(*shown.lock().unwrap(), vec![None, Some("home".to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_section_name_that_isnt_a_plain_word_is_not_passed_on() {
        assert_eq!(show_message(Some("home")), "show home\n");
        assert_eq!(show_message(None), "show\n");
        for odd in ["", "home settings", "home\nshow", "../x", "a".repeat(33).as_str()] {
            assert_eq!(show_message(Some(odd)), "show\n", "{odd:?}");
        }
        assert_eq!(parse_show("show"), Some(None));
        assert_eq!(parse_show("show activity"), Some(Some("activity".to_string())));
        assert_eq!(parse_show("show a b"), None);
        assert_eq!(parse_show("hello"), None);
    }

    #[test]
    fn a_running_app_that_only_knows_show_is_still_shown() {
        // An app from before #203, during an upgrade: it answers "show" and nothing else
        let dir = temp_dir("old");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), None).unwrap() else {
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
        assert!(matches!(claim(&paths, uid(), true, Duration::from_secs(5), Some("home")).unwrap(), Claim::Signalled));
        assert_eq!(shown.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_secs(2), "it fell back at once, not after the wait");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hung_app_is_asked_once_per_try_not_again_with_the_plain_request() {
        let dir = temp_dir("hung");
        let paths = paths_in(&dir);
        let Claim::Primary { lock: _lock, listener } = claim(&paths, uid(), true, Duration::from_secs(2), None).unwrap() else {
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
        assert!(matches!(claim(&paths, uid(), true, Duration::ZERO, Some("home")).unwrap(), Claim::Signalled));
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
        let claimed = claim(&paths, uid(), true, Duration::from_millis(300), None).unwrap();
        assert!(matches!(claimed, Claim::Primary { .. }));
        drop(claimed);
        // Once the primary has gone (lock released), the next start is the primary again
        assert!(matches!(claim(&paths, uid(), true, Duration::from_millis(300), None).unwrap(), Claim::Primary { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn starts_at_once_give_exactly_one_primary() {
        let dir = temp_dir("race");
        let paths = paths_in(&dir);
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let paths = paths.clone();
                std::thread::spawn(move || match claim(&paths, uid(), true, Duration::from_secs(3), None).unwrap() {
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
        assert!(matches!(claim(&paths, uid(), false, Duration::from_millis(100), None).unwrap(), Claim::Primary { .. }));
        let folder = paths.lock.parent().unwrap();
        assert_eq!(std::fs::metadata(folder).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(claim(&paths, uid(), false, Duration::from_millis(100), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
