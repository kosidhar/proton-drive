// The helper's stderr is the daemon's vfs.log: a full disk, or a log that can't be written for any other reason, must
// never take the helper down (eprintln! panics then, and a panic on a session thread ends the drive). No mount needed.

use std::fs::OpenOptions;
use std::process::{Command, Stdio};

#[test]
fn an_unwritable_stderr_never_makes_the_helper_panic() {
    let full = OpenOptions::new().write(true).open("/dev/full").expect("/dev/full");
    // A usage error: the helper says why on stderr and exits 1
    let status = Command::new(env!("CARGO_BIN_EXE_protondrive-vfs"))
        .arg("--no-such-flag")
        .stdout(Stdio::null())
        .stderr(full)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1), "a panic exits 101: {status}");
}

#[test]
fn a_missing_backing_store_with_an_unwritable_stderr_still_exits_1() {
    let full = OpenOptions::new().write(true).open("/dev/full").expect("/dev/full");
    let status = Command::new(env!("CARGO_BIN_EXE_protondrive-vfs"))
        .args(["--mountpoint", "/nonexistent-mnt", "--backing", "/nonexistent-backing", "--socket", "/nonexistent.sock"])
        .stdout(Stdio::null())
        .stderr(full)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1), "a panic exits 101: {status}");
}
