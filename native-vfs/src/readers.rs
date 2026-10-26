// Who is opening an online-only file: only a real app should start a download.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
    /// A thumbnailer or desktop search indexer
    Background,
    /// GIO sniffing the content type, which it does with O_NOATIME
    Sniff,
    App,
}

/// Thumbnailers and indexers, by the start of their comm (which the kernel cuts to 15 bytes).
const BACKGROUND_COMMS: [&str; 15] = [
    "glycin-thumbnai",
    "gdk-pixbuf-thum",
    "gst-video-thumb",
    "gst-audio-thumb",
    "papers-thumbnai",
    "evince-thumbnai",
    "totem-video-thu",
    "ffmpegthumbnail",
    "gnome-thumbnail",
    "heif-thumbnail",
    "gnome-epub-thum",
    "localsearch-3",
    "localsearch-ext",
    "tracker-miner-f",
    "tracker-extract",
];

pub fn classify_open(comm: &str, flags: i32) -> Reader {
    if flags & libc::O_NOATIME != 0 {
        Reader::Sniff
    } else if BACKGROUND_COMMS.iter().any(|prefix| comm.starts_with(prefix)) {
        Reader::Background
    } else {
        Reader::App
    }
}

/// The comm of the process a thread belongs to: the kernel gives the opener's thread id, and a thread's own comm can
/// be anything (a thumbnailer's worker threads are named after their job).
pub fn process_comm(tid: u32) -> Option<String> {
    let status = std::fs::read_to_string(format!("/proc/{tid}/status")).ok()?;
    let tgid: u32 = status.lines().find_map(|l| l.strip_prefix("Tgid:"))?.trim().parse().ok()?;
    let comm = std::fs::read_to_string(format!("/proc/{tgid}/comm")).ok()?;
    Some(comm.trim_end_matches('\n').to_string())
}

/// Whether the opener has given up waiting: its thread has a signal pending, unblocked, that ends it or makes it stop
/// waiting (see GIVING_UP), or it is gone. The kernel would say so with FUSE_INTERRUPT, but fuser can't receive it;
/// and once an open is with the helper, even SIGKILL waits for its answer. A fatal signal shows up as SIGKILL pending on
/// each of the process's threads.
pub fn opener_interrupted(tid: u32) -> bool {
    if tid == 0 {
        return false; // a request the kernel made itself has no opener to watch
    }
    match std::fs::read_to_string(format!("/proc/{tid}/status")) {
        Ok(status) => unblocked_signal_pending(&status),
        Err(err) => gone(&err),
    }
}

/// Whether reading a thread's /proc status failed because the thread is gone. Anything else (out of file
/// descriptors, say) says nothing about the app, which is left waiting.
fn gone(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound || err.raw_os_error() == Some(libc::ESRCH)
}

/// The signals that mean the opener gave up: SIGKILL (what any fatal signal becomes for each thread), and SIGHUP,
/// SIGINT, SIGQUIT and SIGTERM. Others (a job-control stop, SIGCHLD, SIGURG, SIGWINCH...) would only cost the app a
/// spurious EINTR. Bit n-1 of a mask is signal n.
const GIVING_UP: u64 = bit(libc::SIGHUP) | bit(libc::SIGINT) | bit(libc::SIGQUIT) | bit(libc::SIGKILL) | bit(libc::SIGTERM);

const fn bit(signal: i32) -> u64 {
    1 << (signal - 1)
}

/// From /proc/<tid>/status: (SigPnd | ShdPnd) & GIVING_UP & !SigBlk, each a hex mask.
fn unblocked_signal_pending(status: &str) -> bool {
    let mask = |field: &str| {
        let value = status.lines().find_map(|l| l.strip_prefix(field))?;
        u64::from_str_radix(value.trim(), 16).ok()
    };
    match (mask("SigPnd:"), mask("ShdPnd:"), mask("SigBlk:")) {
        (Some(own), Some(shared), Some(blocked)) => (own | shared) & GIVING_UP & !blocked != 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnailers_and_indexers_are_background_readers() {
        assert_eq!(classify_open("glycin-thumbnai", libc::O_RDONLY), Reader::Background);
        assert_eq!(classify_open("localsearch-3", libc::O_RDONLY), Reader::Background);
        assert_eq!(classify_open("tracker-extract", libc::O_RDONLY), Reader::Background);
    }

    #[test]
    fn an_open_with_noatime_is_a_sniff() {
        assert_eq!(classify_open("gedit", libc::O_RDONLY | libc::O_NOATIME), Reader::Sniff);
    }

    #[test]
    fn anything_else_is_an_app() {
        assert_eq!(classify_open("nautilus", libc::O_RDONLY), Reader::App);
        assert_eq!(classify_open("", libc::O_RDONLY), Reader::App);
    }

    // The kernel truncates comm to 15 bytes of the executable's name
    fn own_comm() -> String {
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_str().unwrap();
        name.chars().take(15).collect()
    }

    #[test]
    fn process_comm_reads_the_process_name() {
        assert_eq!(process_comm(std::process::id()).as_deref(), Some(own_comm().as_str()));
    }

    #[test]
    fn process_comm_of_a_thread_is_its_process_name() {
        // This test's thread has its own comm (the test's name); the answer must be the process's
        let tid = unsafe { libc::gettid() } as u32;
        assert_ne!(tid, std::process::id());
        assert_eq!(process_comm(tid).as_deref(), Some(own_comm().as_str()));
    }

    #[test]
    fn process_comm_of_a_missing_thread_is_none() {
        assert_eq!(process_comm(u32::MAX), None);
    }

    fn status(pending: &str, shared: &str, blocked: &str) -> String {
        format!("Name:\tcat\nSigQ:\t0/63419\nSigPnd:\t{pending}\nShdPnd:\t{shared}\nSigBlk:\t{blocked}\nSigIgn:\t0000000000000000\n")
    }

    #[test]
    fn a_pending_signal_counts_unless_it_is_blocked() {
        const NONE: &str = "0000000000000000";
        assert!(!unblocked_signal_pending(&status(NONE, NONE, NONE)));
        // SIGKILL (bit 8), which a fatal signal becomes for each thread, can't be blocked
        assert!(unblocked_signal_pending(&status("0000000000000100", NONE, "fffffffffffbfeff")));
        // SIGINT (bit 1) for the whole process: counts unless the thread blocks it
        assert!(unblocked_signal_pending(&status(NONE, "0000000000000002", "0000000000000004")));
        assert!(!unblocked_signal_pending(&status(NONE, "0000000000000002", "0000000000000002")));
        assert!(!unblocked_signal_pending("Name:\tcat\n"));
    }

    // Final review M-2: only a signal that ends the opener or makes it stop waiting is a reason to give up; a job-control
    // stop, SIGCHLD from a child, SIGURG, SIGWINCH and the like came with a spurious EINTR to the app
    #[test]
    fn only_kill_int_term_hup_and_quit_count() {
        const NONE: &str = "0000000000000000";
        let mask = |sig: i32| format!("{:016x}", 1u64 << (sig - 1));
        for sig in [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGKILL, libc::SIGTERM] {
            assert!(unblocked_signal_pending(&status(&mask(sig), NONE, NONE)), "signal {sig} for the thread");
            assert!(unblocked_signal_pending(&status(NONE, &mask(sig), NONE)), "signal {sig} for the process");
        }
        for sig in [
            libc::SIGTSTP,
            libc::SIGTTIN,
            libc::SIGTTOU,
            libc::SIGCONT,
            libc::SIGCHLD,
            libc::SIGURG,
            libc::SIGWINCH,
            libc::SIGUSR1,
            libc::SIGUSR2,
            libc::SIGALRM,
            libc::SIGPIPE,
            libc::SIGIO,
            libc::SIGPROF,
        ] {
            assert!(!unblocked_signal_pending(&status(&mask(sig), NONE, NONE)), "signal {sig} for the thread");
            assert!(!unblocked_signal_pending(&status(NONE, &mask(sig), NONE)), "signal {sig} for the process");
        }
        // One that counts among others that don't still counts, unless it is blocked
        let mixed = format!("{:016x}", (1u64 << (libc::SIGCHLD - 1)) | (1u64 << (libc::SIGTERM - 1)));
        assert!(unblocked_signal_pending(&status(&mixed, NONE, NONE)));
        assert!(!unblocked_signal_pending(&status(&mixed, NONE, &mask(libc::SIGTERM))));
    }

    #[test]
    fn only_a_thread_that_is_gone_counts_when_its_status_cant_be_read() {
        use std::io::{Error, ErrorKind};
        assert!(gone(&Error::from(ErrorKind::NotFound)));
        assert!(gone(&Error::from_raw_os_error(libc::ENOENT)));
        assert!(gone(&Error::from_raw_os_error(libc::ESRCH)));
        // Out of file descriptors, say: nothing says the app gave up
        for errno in [libc::EMFILE, libc::ENFILE, libc::EACCES, libc::EIO, libc::ENOMEM] {
            assert!(!gone(&Error::from_raw_os_error(errno)), "errno {errno}");
        }
    }

    #[test]
    fn a_thread_that_is_gone_is_interrupted_and_a_calm_one_is_not() {
        assert!(opener_interrupted(u32::MAX));
        assert!(!opener_interrupted(unsafe { libc::gettid() } as u32));
        assert!(!opener_interrupted(0), "a kernel-made request has no opener to watch");
    }

    #[test]
    fn a_signal_the_thread_blocks_doesnt_count() {
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGUSR2);
            libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
            let tid = libc::gettid();
            libc::syscall(libc::SYS_tgkill, libc::getpid(), tid, libc::SIGUSR2);
            let status = std::fs::read_to_string(format!("/proc/{tid}/status")).unwrap();
            let interrupted = opener_interrupted(tid as u32);
            // Take the signal back before unblocking it
            let now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            assert_eq!(libc::sigtimedwait(&set, std::ptr::null_mut(), &now), libc::SIGUSR2);
            libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
            assert!(status.lines().any(|l| l.starts_with("SigPnd:") && l.trim_end().ends_with("800")), "{status}");
            assert!(!interrupted);
        }
    }
}
