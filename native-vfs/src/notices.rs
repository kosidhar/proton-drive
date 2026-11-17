// What the drive tells the daemon about apps writing through it (#64): a file open for writing, and its last writer
// closing it. The posts go out from a queue, in order, on one thread of their own: no request of the drive ever waits
// on the daemon, and a daemon that is down or slow only delays them.
//
// They are best effort: a full queue drops the oldest, and one the daemon fails isn't sent again. The daemon falls back
// on watching the backing store, as for anything written there directly. A close that says a write was refused is
// the exception: the file may be cut short, and the daemon mustn't upload it as it is (#300). That one is never
// dropped, and is sent again until the daemon takes it, with what came after it waiting behind it.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::daemon::DaemonError;

/// How many best-effort notices wait at most; past that, the oldest one goes.
pub const NOTICE_QUEUE_MAX: usize = 1024;
/// How soon a refused close the daemon didn't take is sent again.
pub const NOTICE_RETRY: Duration = Duration::from_secs(2);

/// One post to the daemon. Paths are relative to the drive's top, as in /vfs/rename.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    /// An app opened the file for writing (the first of its writers), or its writers' session turned replacing (see
    /// fs.rs's WriteSession); and a replacing one again every KEEPALIVE_EVERY while it lasts
    Writing { path: String, replacing: bool },
    /// The file's last writer closed it: `refused` when a write or growth to it was refused for room (so it may be cut
    /// short), `replaced` when the session replaced it
    Closed { path: String, refused: bool, replaced: bool },
    /// The guard refused a write for lack of room on the system disk (#299)
    #[allow(dead_code)] // sent once the guard reports its refusals (#299)
    Refused { needed: u64, available: u64 },
}

impl Notice {
    pub fn route(&self) -> &'static str {
        match self {
            Notice::Writing { .. } => "/vfs/writing",
            Notice::Closed { .. } => "/vfs/closed",
            Notice::Refused { .. } => "/vfs/refused",
        }
    }

    pub fn body(&self) -> serde_json::Value {
        match self {
            Notice::Writing { path, replacing } => serde_json::json!({ "path": path, "replacing": replacing }),
            Notice::Closed { path, refused, replaced } => {
                serde_json::json!({ "path": path, "refused": refused, "replaced": replaced })
            }
            Notice::Refused { needed, available } => serde_json::json!({ "needed": needed, "available": available }),
        }
    }

    /// A close after a refused write: the daemon must hear of it, so it is never dropped.
    fn never_dropped(&self) -> bool {
        matches!(self, Notice::Closed { refused: true, .. })
    }
}

// A panic in one thread mustn't make every later use fail on a poisoned lock
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

struct Queue {
    notices: VecDeque<Notice>,
    /// How many of them are best effort
    best_effort: usize,
    /// The last Notices is gone: the sender stops
    ended: bool,
}

/// The queue, shared by Notices and its sender's thread, and the signal that it changed.
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
}

/// The queue of notices, and the thread that sends them. The thread ends when the last Arc<Notices> goes.
pub struct Notices {
    shared: Arc<Shared>,
}

impl Notices {
    /// Starts the sender, which posts each notice through `send`.
    pub fn start(send: impl Fn(&Notice) -> Result<(), DaemonError> + Send + 'static) -> Arc<Notices> {
        Notices::start_retrying_every(NOTICE_RETRY, send)
    }

    /// start, with refused closes sent again every `retry` (a test's, shorter than NOTICE_RETRY).
    fn start_retrying_every(
        retry: Duration,
        send: impl Fn(&Notice) -> Result<(), DaemonError> + Send + 'static,
    ) -> Arc<Notices> {
        let queue = Queue { notices: VecDeque::new(), best_effort: 0, ended: false };
        let shared = Arc::new(Shared { queue: Mutex::new(queue), changed: Condvar::new() });
        let sending = shared.clone();
        let started = std::thread::Builder::new().name("notices".into()).spawn(move || sending.run(retry, send));
        if let Err(err) = started {
            log!("protondrive-vfs: couldn't start telling the daemon about writes ({err}): it watches files instead");
        }
        Arc::new(Notices { shared })
    }

    /// Queues `notice` for the daemon. Never waits on the daemon: it only takes the queue's lock, which the sender
    /// holds only to take a notice off it or put one back.
    pub fn send(&self, notice: Notice) {
        let mut queue = lock(&self.shared.queue);
        if !notice.never_dropped() {
            if queue.best_effort >= NOTICE_QUEUE_MAX {
                if let Some(oldest) = queue.notices.iter().position(|n| !n.never_dropped()) {
                    queue.notices.remove(oldest);
                    queue.best_effort -= 1;
                }
            }
            queue.best_effort += 1;
        }
        queue.notices.push_back(notice);
        drop(queue);
        self.shared.changed.notify_all();
    }
}

impl Drop for Notices {
    fn drop(&mut self) {
        lock(&self.shared.queue).ended = true;
        self.shared.changed.notify_all();
    }
}

impl Shared {
    /// The sender's thread: each notice in turn, until the last Notices goes. A refused close the daemon didn't take
    /// goes back to the head of the queue, and is sent again after `retry`.
    fn run(&self, retry: Duration, send: impl Fn(&Notice) -> Result<(), DaemonError>) {
        // Whether the refused close at the head has failed before: logged the first time, not at every try
        let mut retrying = false;
        while let Some(notice) = self.next() {
            // Sent without the queue's lock: queueing never waits on the daemon
            match send(&notice) {
                Ok(()) => retrying = false,
                Err(_) if !notice.never_dropped() => {}
                Err(err) => {
                    if let (false, Notice::Closed { path, .. }) = (retrying, &notice) {
                        let message = err.message;
                        log!("protondrive-vfs: couldn't tell the daemon a write to {path:?} was refused: {message}");
                    }
                    retrying = true;
                    self.put_back(notice);
                    if !self.wait(retry) {
                        return;
                    }
                }
            }
        }
    }

    /// The notice at the head of the queue, taken off it, once there is one; None once the last Notices has gone.
    fn next(&self) -> Option<Notice> {
        let mut queue = lock(&self.queue);
        loop {
            if queue.ended {
                return None;
            }
            if let Some(notice) = queue.notices.pop_front() {
                if !notice.never_dropped() {
                    queue.best_effort -= 1;
                }
                return Some(notice);
            }
            queue = self.changed.wait(queue).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// A refused close, back at the head of the queue: what was queued behind it stays behind it.
    fn put_back(&self, notice: Notice) {
        lock(&self.queue).notices.push_front(notice);
    }

    /// Waits `retry`, whatever is queued meanwhile; false if the last Notices goes first.
    fn wait(&self, retry: Duration) -> bool {
        let until = Instant::now() + retry;
        let mut queue = lock(&self.queue);
        loop {
            if queue.ended {
                return false;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            queue = match self.changed.wait_timeout(queue, left) {
                Ok((queue, _)) => queue,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn writing(path: &str) -> Notice {
        Notice::Writing { path: path.into(), replacing: false }
    }

    fn refused_close(path: &str) -> Notice {
        Notice::Closed { path: path.into(), refused: true, replaced: false }
    }

    fn failed() -> DaemonError {
        DaemonError { errno: libc::EIO, message: "can't reach the daemon".into(), stuck: false }
    }

    /// Until `done` says so, at most 10 s.
    fn until(what: &str, done: impl Fn() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(started.elapsed() < Duration::from_secs(10), "{what} never happened");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// What reached the daemon, in order.
    type Delivered = Arc<Mutex<Vec<Notice>>>;

    fn delivered(sent: &Delivered) -> Vec<Notice> {
        sent.lock().unwrap().clone()
    }

    /// A send that holds the first notice it gets until the gate opens, and records each notice as delivered.
    struct Gate {
        held: Arc<(Mutex<(bool, bool)>, Condvar)>,
    }

    impl Gate {
        fn new() -> Gate {
            Gate { held: Arc::new((Mutex::new((false, false)), Condvar::new())) }
        }

        fn send(&self, sent: Delivered) -> impl Fn(&Notice) -> Result<(), DaemonError> + Send + 'static {
            let held = self.held.clone();
            move |notice| {
                let (state, changed) = &*held;
                let mut state = state.lock().unwrap();
                state.0 = true; // the sender is in
                changed.notify_all();
                while !state.1 {
                    state = changed.wait(state).unwrap();
                }
                sent.lock().unwrap().push(notice.clone());
                Ok(())
            }
        }

        /// Until the sender has a notice in hand and waits at the gate.
        fn until_held(&self) {
            let (state, changed) = &*self.held;
            let started = Instant::now();
            let mut state = state.lock().unwrap();
            while !state.0 {
                assert!(started.elapsed() < Duration::from_secs(10), "the sender never took a notice");
                state = changed.wait_timeout(state, Duration::from_millis(50)).unwrap().0;
            }
        }

        fn open(&self) {
            let (state, changed) = &*self.held;
            state.lock().unwrap().1 = true;
            changed.notify_all();
        }
    }

    #[test]
    fn each_notice_posts_its_route_and_body() {
        let posts = [
            (Notice::Writing { path: "Docs/a b.txt".into(), replacing: true }, "/vfs/writing"),
            (Notice::Closed { path: "Docs/a b.txt".into(), refused: false, replaced: true }, "/vfs/closed"),
            (Notice::Refused { needed: 10, available: 4_000_000_000 }, "/vfs/refused"),
        ];
        let bodies = [
            serde_json::json!({ "path": "Docs/a b.txt", "replacing": true }),
            serde_json::json!({ "path": "Docs/a b.txt", "refused": false, "replaced": true }),
            serde_json::json!({ "needed": 10, "available": 4_000_000_000u64 }),
        ];
        for ((notice, route), body) in posts.into_iter().zip(bodies) {
            assert_eq!((notice.route(), notice.body()), (route, body));
        }
    }

    #[test]
    fn notices_go_out_in_order() {
        let sent: Delivered = Arc::default();
        let (recorded, threads) = (sent.clone(), Arc::new(Mutex::new(Vec::new())));
        let named = threads.clone();
        let notices = Notices::start(move |notice| {
            named.lock().unwrap().push(std::thread::current().name().map(String::from));
            recorded.lock().unwrap().push(notice.clone());
            Ok(())
        });
        let closed = Notice::Closed { path: "a.txt".into(), refused: false, replaced: true };
        let all = [writing("a.txt"), closed, writing("b")];
        for notice in all.clone() {
            notices.send(notice);
        }
        until("the three notices going out", || delivered(&sent).len() == 3);
        assert_eq!(delivered(&sent), all);
        assert!(threads.lock().unwrap().iter().all(|t| t.as_deref() == Some("notices")), "{threads:?}");
    }

    #[test]
    fn sending_never_waits_for_the_daemon() {
        let gate = Gate::new();
        let notices = Notices::start(gate.send(Arc::default()));
        notices.send(writing("held"));
        gate.until_held();
        // The sender is stuck on the daemon: queueing still returns at once
        let started = Instant::now();
        for i in 0..2000 {
            notices.send(writing(&i.to_string()));
            notices.send(refused_close(&i.to_string()));
        }
        assert!(started.elapsed() < Duration::from_secs(1), "took {:?}", started.elapsed());
        gate.open();
    }

    #[test]
    fn a_full_queue_drops_the_oldest_best_effort_notice() {
        let (gate, sent) = (Gate::new(), Delivered::default());
        let notices = Notices::start(gate.send(sent.clone()));
        notices.send(writing("held"));
        gate.until_held();
        for i in 0..1030 {
            notices.send(writing(&i.to_string()));
        }
        // Never dropped, and drops nothing: a marker for the end
        notices.send(refused_close("end"));
        gate.open();
        until("the queue draining", || delivered(&sent).last() == Some(&refused_close("end")));
        let mut expected = vec![writing("held")];
        expected.extend((6..1030).map(|i| writing(&i.to_string())));
        expected.push(refused_close("end"));
        assert_eq!(delivered(&sent).len(), 1 + NOTICE_QUEUE_MAX + 1);
        assert_eq!(delivered(&sent), expected, "the first six are the ones gone");
    }

    #[test]
    fn a_failed_best_effort_notice_is_dropped() {
        let (sent, tries) = (Delivered::default(), Arc::new(Mutex::new(Vec::new())));
        let (recorded, tried) = (sent.clone(), tries.clone());
        // A close that wasn't refused is best effort too
        let lost_close = Notice::Closed { path: "lost".into(), refused: false, replaced: true };
        let failing = [writing("lost"), lost_close.clone()];
        let notices = Notices::start_retrying_every(Duration::from_millis(10), move |notice| {
            tried.lock().unwrap().push(notice.clone());
            if failing.contains(notice) {
                return Err(failed());
            }
            recorded.lock().unwrap().push(notice.clone());
            Ok(())
        });
        for notice in [writing("lost"), lost_close.clone(), writing("next")] {
            notices.send(notice);
        }
        until("the next notice going out", || delivered(&sent) == [writing("next")]);
        assert_eq!(*tries.lock().unwrap(), [writing("lost"), lost_close, writing("next")], "each tried once");
    }

    #[test]
    fn refused_closes_are_never_dropped_and_retry_in_order() {
        assert_eq!(NOTICE_RETRY, Duration::from_secs(2));
        // The daemon fails the refused close twice, then takes it; what was queued behind it waits
        let (sent, tries) = (Delivered::default(), Arc::new(Mutex::new(Vec::<(Notice, Instant)>::new())));
        let (recorded, tried) = (sent.clone(), tries.clone());
        let retry = Duration::from_millis(50);
        let notices = Notices::start_retrying_every(retry, move |notice| {
            let mut tried = tried.lock().unwrap();
            tried.push((notice.clone(), Instant::now()));
            if *notice == refused_close("cut.bin") && tried.len() <= 2 {
                return Err(failed());
            }
            recorded.lock().unwrap().push(notice.clone());
            Ok(())
        });
        notices.send(refused_close("cut.bin"));
        notices.send(writing("after.txt"));
        until("both going out", || delivered(&sent).len() == 2);
        assert_eq!(delivered(&sent), [refused_close("cut.bin"), writing("after.txt")], "delivered once, in order");
        let tries = tries.lock().unwrap();
        let tried: Vec<&Notice> = tries.iter().map(|(n, _)| n).collect();
        let cut = refused_close("cut.bin");
        assert_eq!(tried, [&cut, &cut, &cut, &writing("after.txt")]);
        for pair in tries.windows(2).take(2) {
            let waited = pair[1].1 - pair[0].1;
            assert!(waited >= retry, "tried again after {waited:?}");
        }

        // 2000 refused closes behind a full queue of best-effort notices: every one gets there, in order
        let (gate, sent) = (Gate::new(), Delivered::default());
        let notices = Notices::start(gate.send(sent.clone()));
        notices.send(writing("held"));
        gate.until_held();
        for i in 0..NOTICE_QUEUE_MAX {
            notices.send(writing(&i.to_string()));
        }
        for i in 0..2000 {
            notices.send(refused_close(&i.to_string()));
        }
        notices.send(writing("last")); // drops the oldest best-effort one, never a refused close
        gate.open();
        until("the queue draining", || delivered(&sent).last() == Some(&writing("last")));
        let closes: Vec<Notice> = delivered(&sent).into_iter().filter(|n| matches!(n, Notice::Closed { .. })).collect();
        assert_eq!(closes, (0..2000).map(|i| refused_close(&i.to_string())).collect::<Vec<_>>());
        let best_effort = delivered(&sent).len() - 2000;
        assert_eq!(best_effort, 1 + NOTICE_QUEUE_MAX, "the held one, and a full queue");
        assert!(!delivered(&sent).contains(&writing("0")), "the oldest went");
    }

    #[test]
    fn the_sender_ends_with_the_last_handle() {
        let (alive, ended) = mpsc::channel::<()>();
        let notices = Notices::start(move |_| {
            let _ = &alive; // held by the sender's thread, and let go when it ends
            Ok(())
        });
        let other = notices.clone();
        drop(notices);
        assert_eq!(ended.recv_timeout(Duration::from_millis(300)), Err(mpsc::RecvTimeoutError::Timeout), "one is left");
        drop(other);
        assert_eq!(ended.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
    }
}
