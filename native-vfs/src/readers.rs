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
}
