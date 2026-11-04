//! The home screen's plain-language status line.

use crate::DaemonStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Busy,
    Paused,
    Attention,
    Offline,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusSummary {
    pub headline: String,
    pub detail: Option<String>,
    pub tone: Tone,
}

fn summary(headline: impl Into<String>, detail: Option<String>, tone: Tone) -> StatusSummary {
    StatusSummary { headline: headline.into(), detail, tone }
}

/// What the app says about the sync in a sentence, in the user's terms. Never echoes the daemon's own wording.
/// Precedence: unreachable, paused, syncing, needs attention, up to date.
pub fn status_summary(status: &DaemonStatus, daemon_online: bool, attention: usize, now_ms: i64) -> StatusSummary {
    if !daemon_online {
        return summary("Can't reach Proton Drive's background service", None, Tone::Offline);
    }
    if status.state == "paused" || status.settings.paused {
        return summary("Paused", None, Tone::Paused);
    }
    if status.state == "syncing" {
        return summary(syncing_headline(status), None, Tone::Busy);
    }
    if attention > 0 {
        let headline = if attention == 1 {
            "1 problem needs you".to_string()
        } else {
            format!("{attention} problems need you")
        };
        return summary(headline, Some("See Needs attention below".to_string()), Tone::Attention);
    }
    let detail = status.last_sync_at.map(|at| format!("Last synced {}", ago(now_ms - at)));
    summary("Up to date", detail, Tone::Ok)
}

fn syncing_headline(status: &DaemonStatus) -> String {
    let transfers = &status.active_transfers;
    let uploads = transfers.iter().filter(|t| t.direction == "upload").count();
    let downloads = transfers.len() - uploads;
    match (uploads, downloads) {
        (0, 0) => "Checking for changes…".to_string(),
        (_, 0) | (0, _) => {
            let verb = if downloads == 0 { "Uploading" } else { "Downloading" };
            if transfers.len() == 1 {
                let name = transfers[0].rel_path.rsplit('/').next().unwrap_or("");
                format!("{verb} {name}")
            } else {
                format!("{verb} {} files", transfers.len())
            }
        }
        _ => format!("Syncing {} files", transfers.len()),
    }
}

/// "just now", "2 min ago", "2 h ago", "3 days ago"; a negative (future) time reads as "just now".
pub fn ago(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        "just now".to_string()
    } else if secs < 3600 {
        format!("{} min ago", secs / 60)
    } else if secs < 86_400 {
        format!("{} h ago", secs / 3600)
    } else if secs / 86_400 == 1 {
        "1 day ago".to_string()
    } else {
        format!("{} days ago", secs / 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActiveTransfer, DaemonStatus};

    const NOW: i64 = 1_800_000_000_000;

    fn transfer(direction: &str, path: &str) -> ActiveTransfer {
        ActiveTransfer {
            id: path.to_string(),
            direction: direction.to_string(),
            rel_path: path.to_string(),
            bytes_transferred: 0,
            total_bytes: 10,
        }
    }

    fn status(state: &str, transfers: Vec<ActiveTransfer>, paused: bool) -> DaemonStatus {
        let mut s = DaemonStatus {
            state: state.to_string(),
            active_transfers: transfers,
            ..Default::default()
        };
        s.settings.paused = paused;
        s
    }

    #[test]
    fn summary_when_up_to_date() {
        let mut s = status("idle", vec![], false);
        s.last_sync_at = Some(NOW - 120_000);
        let r = status_summary(&s, true, 0, NOW);
        assert_eq!(r.headline, "Up to date");
        assert_eq!(r.detail.as_deref(), Some("Last synced 2 min ago"));
        assert_eq!(r.tone, Tone::Ok);
        s.last_sync_at = None;
        assert_eq!(status_summary(&s, true, 0, NOW).detail, None);
    }

    #[test]
    fn summary_names_what_moves() {
        let up = |n: usize| (0..n).map(|i| transfer("upload", &format!("a{i}.txt"))).collect::<Vec<_>>();
        let cases = [
            (up(3), "Uploading 3 files"),
            (vec![up(1).remove(0)], "Uploading a0.txt"),
            (vec![transfer("download", "docs/report.pdf")], "Downloading report.pdf"),
            (
                vec![transfer("upload", "a"), transfer("upload", "b"), transfer("download", "c")],
                "Syncing 3 files",
            ),
            (vec![transfer("download", "a"), transfer("download", "b")], "Downloading 2 files"),
            (vec![], "Checking for changes…"),
        ];
        for (transfers, want) in cases {
            let r = status_summary(&status("syncing", transfers, false), true, 0, NOW);
            assert_eq!(r.headline, want);
            assert_eq!(r.tone, Tone::Busy);
            assert_eq!(r.detail, None);
        }
    }

    #[test]
    fn summary_never_shows_engine_text() {
        let mut s = status("syncing", vec![], false);
        s.current_action = Some("Listing /my-files/deployment".to_string());
        let r = status_summary(&s, true, 0, NOW);
        let all = format!("{} {}", r.headline, r.detail.unwrap_or_default());
        assert!(!all.contains("/my-files") && !all.contains("Listing"));
    }

    #[test]
    fn summary_reads_paused_from_either_field() {
        for s in [status("paused", vec![], false), status("idle", vec![], true)] {
            let r = status_summary(&s, true, 0, NOW);
            assert_eq!(r.headline, "Paused");
            assert_eq!(r.tone, Tone::Paused);
        }
    }

    #[test]
    fn summary_when_something_needs_the_user() {
        let s = status("idle", vec![], false);
        let one = status_summary(&s, true, 1, NOW);
        assert_eq!(one.headline, "1 problem needs you");
        assert_eq!(one.detail.as_deref(), Some("See Needs attention below"));
        assert_eq!(one.tone, Tone::Attention);
        assert_eq!(status_summary(&s, true, 3, NOW).headline, "3 problems need you");
    }

    #[test]
    fn summary_when_the_daemon_is_unreachable() {
        for s in [status("idle", vec![], false), status("paused", vec![], true)] {
            let r = status_summary(&s, false, 2, NOW);
            assert_eq!(r.headline, "Can't reach Proton Drive's background service");
            assert_eq!(r.tone, Tone::Offline);
        }
    }

    #[test]
    fn ago_in_plain_words() {
        assert_eq!(ago(30_000), "just now");
        assert_eq!(ago(120_000), "2 min ago");
        assert_eq!(ago(2 * 3_600_000), "2 h ago");
        assert_eq!(ago(3 * 86_400_000), "3 days ago");
        assert_eq!(ago(86_400_000), "1 day ago");
        assert_eq!(ago(-5_000), "just now");
    }
}
