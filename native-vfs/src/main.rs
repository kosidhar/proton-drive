// protondrive-vfs: mounts the Proton Drive folder as a FUSE view of the daemon's backing store plus the cloud's
// online-only files, which download when an app opens them.
//
// protondrive-vfs --mountpoint <dir> --backing <dir> --socket <path>
// Exit 0: the session ended because the drive was unmounted (eject). 2: the mount failed. 1: any other error.

/// A line on stderr, which is the daemon's vfs.log: a write that fails (a full disk, say) is dropped, never a panic as
/// with eprintln!, which on a session thread would end the drive.
macro_rules! log {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

mod daemon;
mod fs;
mod inodes;
mod listing;
mod readers;
mod trash;

use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use fuser::{Config, MountOption, Session};

const USAGE: &str = "usage: protondrive-vfs --mountpoint <dir> --backing <dir> --socket <path>";

#[derive(Debug, PartialEq)]
struct Args {
    mountpoint: PathBuf,
    backing: PathBuf,
    socket: PathBuf,
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Args, String> {
    let (mut mountpoint, mut backing, mut socket) = (None, None, None);
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let slot = match flag.to_str() {
            Some("--mountpoint") => &mut mountpoint,
            Some("--backing") => &mut backing,
            Some("--socket") => &mut socket,
            _ => return Err(format!("unknown argument {flag:?}")),
        };
        let value = args.next().ok_or_else(|| format!("{} needs a value", flag.to_string_lossy()))?;
        *slot = Some(PathBuf::from(value));
    }
    match (mountpoint, backing, socket) {
        (Some(mountpoint), Some(backing), Some(socket)) => Ok(Args { mountpoint, backing, socket }),
        _ => Err("--mountpoint, --backing and --socket are all required".into()),
    }
}

/// A mount point in /proc/self/mountinfo, with its octal escapes (`\040` for a space) undone.
fn unescape_mount_point(field: &str) -> Vec<u8> {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes.get(i + 1..i + 4).and_then(|d| u8::from_str_radix(std::str::from_utf8(d).ok()?, 8).ok());
        match (bytes[i], octal) {
            (b'\\', Some(b)) => {
                out.push(b);
                i += 4;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// The device of the drive's mount at `mountpoint` in mountinfo: the topmost one of its type there.
fn mount_device(mountinfo: &str, mountpoint: &Path) -> Option<u64> {
    let wanted = mountpoint.as_os_str().as_bytes();
    let device = |line: &str| {
        let fields: Vec<&str> = line.split(' ').collect();
        let fs_type = line.split(" - ").nth(1)?.split(' ').next()?;
        if fs_type != "fuse.protondrive" || fields.get(4).is_none_or(|f| unescape_mount_point(f) != wanted) {
            return None;
        }
        let (major, minor) = fields.get(2)?.split_once(':')?;
        Some(libc::makedev(major.parse().ok()?, minor.parse().ok()?))
    };
    mountinfo.lines().rev().find_map(device)
}

/// fusermount3 would stack a second mount on our own, hiding the first; refuse instead.
fn already_mounted(mountinfo: &str, mountpoint: &Path) -> bool {
    let wanted = mountpoint.as_os_str().as_bytes();
    mountinfo.lines().any(|l| l.split(' ').nth(4).is_some_and(|f| unescape_mount_point(f) == wanted))
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args = match parse_args(std::env::args_os().skip(1)) {
        Ok(args) => args,
        Err(msg) => {
            log!("protondrive-vfs: {msg}\n{USAGE}");
            return 1;
        }
    };
    if !args.backing.is_dir() {
        log!("protondrive-vfs: the backing store {} isn't a folder", args.backing.display());
        return 1;
    }
    // Missing, or a dead mount ("Transport endpoint is not connected"), fails here
    let mountpoint = match args.mountpoint.canonicalize() {
        Ok(path) => path,
        Err(err) => {
            log!("protondrive-vfs: can't mount on {}: {err}", args.mountpoint.display());
            return 2;
        }
    };
    if already_mounted(&std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default(), &mountpoint) {
        log!("protondrive-vfs: {} is already mounted", mountpoint.display());
        return 2;
    }

    // The kernel has already applied the app's umask to what it creates; the helper's own mustn't apply on top
    unsafe { libc::umask(0) };
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("protondrive".into()),
        MountOption::Subtype("protondrive".into()),
        MountOption::DefaultPermissions,
        MountOption::NoAtime,
    ];
    config.n_threads = Some(4);
    let drive = fs::DriveFs::new(args.backing, daemon::DaemonClient::new(args.socket));
    drive.start_space_refresh();
    let (notifier, mount) = (drive.notifier_slot(), drive.mount_slot());
    let session = match Session::new(drive, &mountpoint, &config) {
        Ok(session) => session,
        Err(err) => {
            // fusermount3's own message ends with a newline
            log!("protondrive-vfs: can't mount on {}: {}", mountpoint.display(), err.to_string().trim_end());
            return 2;
        }
    };
    // Set before any request is served, so a download's open can always refresh the kernel's attributes
    let _ = notifier.set(session.notifier());
    // And so can what the trash drops be unlinked through this mount, and only this one (#236)
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    if let Some(dev) = mount_device(&mountinfo, &mountpoint) {
        let _ = mount.set(fs::Mount { path: mountpoint.clone(), dev });
    }
    // Returns once the kernel ends the session, which an unmount does
    match session.run() {
        Ok(()) => 0,
        Err(err) => {
            log!("protondrive-vfs: the drive stopped: {err}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_the_three_paths() {
        let parsed = parse_args(args(&["--socket", "/s", "--mountpoint", "/m", "--backing", "/b"])).unwrap();
        assert_eq!(parsed, Args { mountpoint: "/m".into(), backing: "/b".into(), socket: "/s".into() });
    }

    #[test]
    fn refuses_missing_or_unknown_arguments() {
        assert!(parse_args(args(&["--mountpoint", "/m", "--backing", "/b"])).is_err());
        assert!(parse_args(args(&["--mountpoint"])).is_err());
        assert!(parse_args(args(&["--mountpoint", "/m", "--backing", "/b", "--socket", "/s", "--x", "1"])).is_err());
    }

    #[test]
    fn finds_a_mount_point_in_mountinfo_escapes_and_all() {
        let mountinfo = "36 35 98:0 / /mnt/my\\040drive rw,noatime master:1 - fuse.protondrive protondrive rw\n\
                         37 35 98:0 / /home/u/other rw - ext4 /dev/sda1 rw\n";
        assert!(already_mounted(mountinfo, Path::new("/mnt/my drive")));
        assert!(already_mounted(mountinfo, Path::new("/home/u/other")));
        assert!(!already_mounted(mountinfo, Path::new("/mnt/my")));
    }

    #[test]
    fn finds_the_device_of_the_drives_own_mount() {
        let mountinfo = "36 35 0:52 / /mnt/my\\040drive rw,noatime master:1 - fuse.protondrive protondrive rw\n\
                         37 35 8:1 / /mnt/my\\040drive rw - ext4 /dev/sda1 rw\n\
                         38 35 0:61 / /home/u/other rw - fuse.sshfs host: rw\n";
        assert_eq!(mount_device(mountinfo, Path::new("/mnt/my drive")), Some(libc::makedev(0, 52)));
        assert_eq!(mount_device(mountinfo, Path::new("/home/u/other")), None, "another file system's");
        assert_eq!(mount_device(mountinfo, Path::new("/mnt/my")), None);
        // Mounted again over the first: the topmost
        let again = format!("{mountinfo}39 36 0:70 / /mnt/my\\040drive rw - fuse.protondrive protondrive rw\n");
        assert_eq!(mount_device(&again, Path::new("/mnt/my drive")), Some(libc::makedev(0, 70)));
    }
}
