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

/// Whether the opener has given up waiting: its thread has a signal pending that it doesn't block, or it is gone.
/// The kernel would say so with FUSE_INTERRUPT, but fuser can't receive it; and once an open is with the helper, even
/// SIGKILL waits for its answer. A fatal signal shows up as SIGKILL pending on each of the process's threads.
pub fn opener_interrupted(tid: u32) -> bool {
    if tid == 0 {
        return false; // a request the kernel made itself has no opener to watch
    }
    match std::fs::read_to_string(format!("/proc/{tid}/status")) {
        Ok(status) => unblocked_signal_pending(&status),
        Err(_) => true,
    }
}

/// From /proc/<tid>/status: (SigPnd | ShdPnd) & !SigBlk, each a hex mask.
fn unblocked_signal_pending(status: &str) -> bool {
    let mask = |field: &str| {
        let value = status.lines().find_map(|l| l.strip_prefix(field))?;
        u64::from_str_radix(value.trim(), 16).ok()
    };
    match (mask("SigPnd:"), mask("ShdPnd:"), mask("SigBlk:")) {
        (Some(own), Some(shared), Some(blocked)) => (own | shared) & !blocked != 0,
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
