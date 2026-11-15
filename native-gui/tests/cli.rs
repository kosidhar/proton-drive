//! The command line, as the app's binary reads it.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::process::Command;

// #216: Files hands the app a file's name as the file system has it, and a name needn't be UTF-8. Reading the arguments
// mustn't panic on one (the app would then exit without a word). --screenshot keeps the run away from the running app
// and the user's settings, and --version, read last, ends it once every argument before it was read.
#[test]
fn a_share_path_that_isnt_utf8_is_read_without_a_panic() {
    let out = Command::new(env!("CARGO_BIN_EXE_protondrive-gui"))
        .arg("--share")
        .arg(OsStr::from_bytes(b"/home/u/ProtonDrive/caf\xe9.txt"))
        .args(["--screenshot", "/nonexistent/never-written.png", "--version"])
        .output()
        .expect("the binary runs");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{:?}: {stderr}", out.status);
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("protondrive-gui "), "--version was reached");
}
