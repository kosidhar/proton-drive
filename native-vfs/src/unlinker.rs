// The unlinks through the mount of what the trash drops (#236) are made by a small child process that never holds
// /dev/fuse. Such an unlink can wait on the kernel's lock of the trash folder for as long as the next rename into it
// holds it, which is as long as the daemon takes to delete, and nothing can interrupt that wait. A thread of the helper
// in it would keep a stopped helper from ever finishing its exit and closing /dev/fuse, the one thing that ends the
// wait: the app's rename and the helper would wait on each other forever. However the helper ends, its /dev/fuse
// closes, the kernel aborts the connection, and the child's unlink fails instead.
//
// The helper writes each request to the child's stdin and reads one byte back from its stdout, 1 when the name was
// unlinked. A request is the mount's device and the folder's number, then the folder's path and the name, each as its
// length and its bytes, so any name gets through. The child ends at the end of its stdin, or when the helper dies.

use std::ffi::{CString, OsStr, OsString};
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// How the helper runs as the unlinker: `protondrive-vfs --trash-unlinker <the helper's pid>`
pub const SUBCOMMAND: &str = "--trash-unlinker";
/// More than any path the kernel takes
const FIELD_MAX: usize = 64 * 1024;

/// An unlink of `name` in folder `dir`, which must be on device `dev` and have number `folder`.
#[derive(Debug, PartialEq)]
struct Request {
    dev: u64,
    folder: u64,
    dir: PathBuf,
    name: OsString,
}

fn encode(dev: u64, folder: u64, dir: &Path, name: &OsStr) -> Vec<u8> {
    let (dir, name) = (dir.as_os_str().as_bytes(), name.as_bytes());
    let mut out = Vec::with_capacity(24 + dir.len() + name.len());
    out.extend_from_slice(&dev.to_ne_bytes());
    out.extend_from_slice(&folder.to_ne_bytes());
    for field in [dir, name] {
        out.extend_from_slice(&(field.len() as u32).to_ne_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// The next request, or None at the end of the input.
fn read_request(input: &mut impl Read) -> io::Result<Option<Request>> {
    // The end only between requests: one cut short is an error
    let (mut dev, mut got) = ([0u8; 8], 0);
    while got < dev.len() {
        match input.read(&mut dev[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    let mut folder = [0u8; 8];
    input.read_exact(&mut folder)?;
    let mut field = || -> io::Result<Vec<u8>> {
        let mut len = [0u8; 4];
        input.read_exact(&mut len)?;
        let len = u32::from_ne_bytes(len) as usize;
        if len > FIELD_MAX {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a request too long"));
        }
        let mut bytes = vec![0u8; len];
        input.read_exact(&mut bytes)?;
        Ok(bytes)
    };
    let (dir, name) = (field()?, field()?);
    Ok(Some(Request {
        dev: u64::from_ne_bytes(dev),
        folder: u64::from_ne_bytes(folder),
        dir: PathBuf::from(OsString::from_vec(dir)),
        name: OsString::from_vec(name),
    }))
}

/// The helper's end of the child.
pub struct Unlinker {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}

impl Unlinker {
    /// Starts the child: the helper's own executable, as it is running even if replaced since. Before the session opens
    /// /dev/fuse, so that the child never holds it.
    pub fn start() -> io::Result<Unlinker> {
        let mut child = Command::new("/proc/self/exe")
            .arg0("protondrive-vfs")
            .arg(SUBCOMMAND)
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .current_dir("/")
            .spawn()?;
        let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(io::Error::other("no pipes to the child"));
        };
        Ok(Unlinker { child, input, output })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Has the child unlink `name` in folder `dir` (see unlink_in): whether it did. An error when the child is gone.
    pub fn unlink(&mut self, dev: u64, folder: u64, dir: &Path, name: &OsStr) -> io::Result<bool> {
        self.input.write_all(&encode(dev, folder, dir, name))?;
        let mut answer = [0u8];
        self.output.read_exact(&mut answer)?;
        Ok(answer[0] == 1)
    }

    /// Done with a child that stopped answering: it is killed if it isn't gone yet, and reaped if it is, never waited
    /// for (it may be stuck in an unlink).
    pub fn end(mut self) {
        let _ = self.child.kill();
        let _ = self.child.try_wait();
    }
}

/// The child's life: unlinks what the helper asks until the helper is gone. Its exit code.
pub fn serve(parent: Option<&OsStr>) -> i32 {
    // Killed when the helper dies, however it does; a helper gone already left another process as its parent
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
    // Named for what it is in ps and top, rather than "exe"
    unsafe { libc::prctl(libc::PR_SET_NAME, c"trash-unlinker".as_ptr()) };
    let parent: Option<i32> = parent.and_then(OsStr::to_str).and_then(|p| p.parse().ok());
    if parent != Some(unsafe { libc::getppid() }) {
        return 1;
    }
    serve_on(&mut io::stdin().lock(), &mut io::stdout().lock(), unlink_in)
}

fn serve_on(input: &mut impl Read, output: &mut impl Write, unlink: impl Fn(&Request) -> bool) -> i32 {
    loop {
        match read_request(input) {
            Ok(Some(request)) => {
                let answer = [u8::from(unlink(&request))];
                if output.write_all(&answer).and_then(|()| output.flush()).is_err() {
                    return 1;
                }
            }
            Ok(None) => return 0,
            Err(_) => return 1,
        }
    }
}

/// Unlinks the name in the folder, which must have the request's device and number: nothing is unlinked once the drive
/// is unmounted, or wherever else the path leads. The unlink is made in the folder opened, so it can't move meanwhile.
fn unlink_in(request: &Request) -> bool {
    let Ok(name) = CString::new(request.name.as_bytes()) else { return false };
    // O_PATH: the folder isn't opened as such (no opendir), only held to unlink in
    let opened = OpenOptions::new().read(true).custom_flags(libc::O_PATH | libc::O_DIRECTORY).open(&request.dir);
    let Ok(folder) = opened else { return false };
    if !folder.metadata().is_ok_and(|meta| meta.dev() == request.dev && meta.ino() == request.folder) {
        return false;
    }
    // An item dropped from files/ is a file to a lookup, but still a folder to an entry the kernel holds of it
    for flags in [0, libc::AT_REMOVEDIR, 0] {
        if unsafe { libc::unlinkat(folder.as_raw_fd(), name.as_ptr(), flags) } == 0 {
            return true;
        }
        if !matches!(io::Error::last_os_error().raw_os_error(), Some(libc::EISDIR | libc::ENOTDIR)) {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn any_name_gets_through_whole() {
        let names = [OsStr::new("a\nb"), OsStr::from_bytes(b"\xff\xfe not UTF-8"), OsStr::new("")];
        let mut stream = Vec::new();
        for (i, name) in names.iter().enumerate() {
            stream.extend(encode(7, i as u64, Path::new("/mnt/my drive/.Trash-1000/files"), name));
        }
        let mut input = stream.as_slice();
        for (i, name) in names.iter().enumerate() {
            let request = read_request(&mut input).unwrap().unwrap();
            let dir = PathBuf::from("/mnt/my drive/.Trash-1000/files");
            assert_eq!(request, Request { dev: 7, folder: i as u64, dir, name: name.to_os_string() });
        }
        assert_eq!(read_request(&mut input).unwrap(), None, "the end of the input");
        let cut = &encode(7, 1, Path::new("/d"), OsStr::new("name"))[..20];
        assert!(read_request(&mut &cut[..]).is_err(), "a request cut short");
    }

    #[test]
    fn the_child_answers_each_request_and_ends_with_its_input() {
        let mut stream = encode(1, 2, Path::new("/d"), OsStr::new("yes"));
        stream.extend(encode(1, 2, Path::new("/d"), OsStr::new("no")));
        let mut answers = Vec::new();
        let code = serve_on(&mut stream.as_slice(), &mut answers, |r| r.name == "yes");
        assert_eq!((code, answers), (0, vec![1, 0]));
        let mut answers = Vec::new();
        assert_eq!(serve_on(&mut &[1u8, 2, 3][..], &mut answers, |_| true), 1, "garbage ends it");
    }

    #[test]
    fn nothing_is_unlinked_in_a_folder_other_than_the_one_asked() {
        let dir = std::env::temp_dir().join(format!("protondrive-vfs-unlinker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a"), b"a").unwrap();
        let meta = std::fs::metadata(&dir).unwrap();
        let request = |dev: u64, folder: u64, name: &str| Request { dev, folder, dir: dir.clone(), name: name.into() };
        assert!(!unlink_in(&request(meta.dev() + 1, meta.ino(), "a")), "another device");
        assert!(!unlink_in(&request(meta.dev(), meta.ino() + 1, "a")), "another folder");
        assert!(dir.join("a").exists());
        assert!(unlink_in(&request(meta.dev(), meta.ino(), "a")));
        assert!(!dir.join("a").exists());
        assert!(unlink_in(&request(meta.dev(), meta.ino(), "sub")), "a folder, with rmdir");
        assert!(!unlink_in(&request(meta.dev(), meta.ino(), "a")), "nothing left to unlink");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
