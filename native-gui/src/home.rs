//! The home screen's plain-language status line.

use crate::{drive_status_line, offers_mount_again, ConflictRecord, DaemonStatus};

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

/// One thing that needs the user, in the order the home screen lists them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attention {
    Conflict { id: u64, rel_path: String },
    FilesMissing,
    DriveNotMounted { message: String, can_mount: bool },
    StoppedMove,
    FailedItems(u64),
    LastError(String),
}

/// Every problem the user can act on, each once: files missing, stopped move, drive not mounted, unresolved
/// conflicts by id, failed items, last error (only when no files are missing, which explains it).
pub fn attention_items(status: &DaemonStatus, conflicts: &[ConflictRecord]) -> Vec<Attention> {
    let mut items = Vec::new();
    if status.files_missing.is_some() {
        items.push(Attention::FilesMissing);
    }
    if let Some(v) = &status.vfs {
        match v.reason.as_deref() {
            Some("move-failed") => items.push(Attention::StoppedMove),
            Some("starting" | "moving") => {}
            _ if v.mode == "virtual" && !v.mounted => items.push(Attention::DriveNotMounted {
                message: drive_status_line(v, &status.sync_dir),
                can_mount: offers_mount_again(v),
            }),
            _ => {}
        }
    }
    let mut open: Vec<&ConflictRecord> = conflicts.iter().filter(|c| c.resolved == 0).collect();
    open.sort_by_key(|c| c.id);
    items.extend(open.into_iter().map(|c| Attention::Conflict { id: c.id, rel_path: c.local_rel_path.clone() }));
    if status.stats.error_items > 0 {
        items.push(Attention::FailedItems(status.stats.error_items));
    }
    if status.files_missing.is_none() {
        if let Some(e) = status.last_error.as_deref().filter(|e| !e.trim().is_empty()) {
            items.push(Attention::LastError(e.to_string()));
        }
    }
    items
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

    fn conflict(id: u64, path: &str, resolved: u8) -> ConflictRecord {
        ConflictRecord { id, local_rel_path: path.to_string(), resolved, ..Default::default() }
    }

    fn vfs(mode: &str, mounted: bool, reason: Option<&str>) -> crate::VfsStatus {
        crate::VfsStatus { mode: mode.into(), mounted, reason: reason.map(String::from), ..Default::default() }
    }

    fn missing() -> crate::FilesMissing {
        crate::FilesMissing { root: "/r".into(), names: vec!["Docs".into()], items: 1, message: "m".into() }
    }

    #[test]
    fn attention_lists_each_problem_once_in_order() {
        let mut s = status("idle", vec![], false);
        s.files_missing = Some(missing());
        s.vfs = Some(vfs("virtual", false, Some("move-failed")));
        s.stats.error_items = 3;
        s.last_error = Some("boom".into());
        let all = attention_items(&s, &[conflict(9, "b", 0), conflict(2, "a", 0)]);
        assert_eq!(
            all,
            vec![
                Attention::FilesMissing,
                Attention::StoppedMove,
                Attention::Conflict { id: 2, rel_path: "a".into() },
                Attention::Conflict { id: 9, rel_path: "b".into() },
                Attention::FailedItems(3),
            ]
        );
        s.files_missing = None;
        s.vfs = Some(vfs("virtual", false, Some("ejected")));
        let all = attention_items(&s, &[conflict(1, "a", 0)]);
        assert_eq!(
            all,
            vec![
                Attention::DriveNotMounted { message: "Virtual drive: ejected".into(), can_mount: true },
                Attention::Conflict { id: 1, rel_path: "a".into() },
                Attention::FailedItems(3),
                Attention::LastError("boom".into()),
            ]
        );
    }

    #[test]
    fn no_attention_when_all_is_well() {
        assert!(attention_items(&status("idle", vec![], false), &[]).is_empty());
        let mut s = status("idle", vec![], false);
        s.vfs = Some(vfs("virtual", true, None));
        s.last_error = Some("  ".into());
        assert!(attention_items(&s, &[]).is_empty());
    }

    #[test]
    fn resolved_conflicts_are_not_listed() {
        let s = status("idle", vec![], false);
        assert!(attention_items(&s, &[conflict(1, "a", 1), conflict(2, "b", 2)]).is_empty());
    }

    #[test]
    fn no_mount_attention_for_a_plain_folder_or_an_old_daemon() {
        let mut s = status("idle", vec![], false);
        s.vfs = None;
        assert!(attention_items(&s, &[]).is_empty());
        s.vfs = Some(vfs("plain", false, Some("switched-off")));
        assert!(attention_items(&s, &[]).is_empty());
        for r in ["starting", "moving"] {
            s.vfs = Some(vfs("virtual", false, Some(r)));
            assert!(attention_items(&s, &[]).is_empty());
        }
    }

    #[test]
    fn a_stopped_move_is_attention_not_a_mount_problem() {
        let mut s = status("idle", vec![], false);
        let mut v = vfs("virtual", false, Some("move-failed"));
        v.drive_move = Some(crate::DriveMove { actions: vec!["retry".into()], ..Default::default() });
        s.vfs = Some(v);
        assert_eq!(attention_items(&s, &[]), vec![Attention::StoppedMove]);
    }

    #[test]
    fn last_error_is_listed_only_when_files_are_not_missing() {
        let mut s = status("idle", vec![], false);
        s.last_error = Some("boom".into());
        assert_eq!(attention_items(&s, &[]), vec![Attention::LastError("boom".into())]);
        s.files_missing = Some(missing());
        assert_eq!(attention_items(&s, &[]), vec![Attention::FilesMissing]);
    }

    #[test]
    fn failed_items_come_from_stats() {
        let mut s = status("idle", vec![], false);
        s.stats.error_items = 2;
        assert_eq!(attention_items(&s, &[]), vec![Attention::FailedItems(2)]);
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
