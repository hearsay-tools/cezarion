//! Stopping the owned cockpit and deciding what follows a new version. Std-only, so its tests
//! run without a window system.
//!
//! The shell starts cezar with a piped stdin and `CEZ_SUPERVISOR_STDIN=1`. Closing that pipe is
//! the stop request: cezar runs its own shutdown (store flush, preview host and delegation
//! cleanup) and exits. A pipe closes the same way on every platform, which a signal does not.
//! A cezar older than that request ignores it, so every stop ends in a bounded force-kill.

use std::process::Child;
use std::time::{Duration, Instant};

/// How long a cockpit gets to shut down on its own before the shell force-kills it.
pub const STOP_GRACE: Duration = Duration::from_secs(10);

/// Ask the cockpit to shut down by closing its stdin. Returns at once.
pub fn request_stop(child: &mut Child) {
    drop(child.stdin.take());
}

#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The cockpit exited within the grace period.
    Exited,
    /// The cockpit was still running at the deadline and was force-killed.
    Killed,
}

/// Request a stop, wait up to `grace` for the exit, then force-kill.
pub fn stop(child: &mut Child, grace: Duration) -> Stopped {
    request_stop(child);
    if wait_until(child, Instant::now() + grace) {
        return Stopped::Exited;
    }
    let _ = child.kill();
    let _ = child.wait();
    Stopped::Killed
}

/// Poll until the child exits or `deadline` passes. True when it exited, or when it can no
/// longer be waited on (nothing is left to stop).
pub fn wait_until(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) if Instant::now() >= deadline => return false,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// What the shell does once a new cezar version is current (an install, an update or a switch).
#[derive(Debug, PartialEq, Eq)]
pub enum AfterNewVersion {
    /// A cockpit runs the old version: stop it; its supervisor relaunches the current one.
    RestartRunning,
    /// Nothing runs and nothing supervises (the launcher, or after a start or server failure):
    /// start a supervisor, or the splash would wait forever.
    StartSupervisor,
    /// A supervisor is alive without a running cockpit: it is the one that asked for the
    /// install (first launch) or it is starting a cockpit, and it carries on by itself.
    LeaveToSupervisor,
}

pub fn after_new_version(cockpit_running: bool, supervising: bool) -> AfterNewVersion {
    match (cockpit_running, supervising) {
        (true, _) => AfterNewVersion::RestartRunning,
        (false, false) => AfterNewVersion::StartSupervisor,
        (false, true) => AfterNewVersion::LeaveToSupervisor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_version_restarts_a_running_cockpit() {
        assert_eq!(after_new_version(true, true), AfterNewVersion::RestartRunning);
    }

    // The launcher and a failed start leave no supervisor: without a new one the splash stays
    // on "Updating cezar" forever.
    #[test]
    fn a_new_version_with_no_supervisor_starts_one() {
        assert_eq!(after_new_version(false, false), AfterNewVersion::StartSupervisor);
    }

    // The first install runs inside `supervise`, which starts the cockpit itself afterwards.
    #[test]
    fn a_new_version_during_the_first_install_leaves_the_supervisor_alone() {
        assert_eq!(after_new_version(false, true), AfterNewVersion::LeaveToSupervisor);
    }

    #[cfg(unix)]
    fn piped(script: &str) -> Child {
        std::process::Command::new("sh")
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("sh starts")
    }

    // A cezar that watches its stdin exits on the request, well inside the grace period.
    #[cfg(unix)]
    #[test]
    fn a_cockpit_that_honours_the_request_exits_without_a_kill() {
        let mut child = piped("cat >/dev/null; exit 0");
        let started = Instant::now();
        assert_eq!(stop(&mut child, Duration::from_secs(10)), Stopped::Exited);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(child.wait().unwrap().code(), Some(0));
    }

    // An older cezar ignores its stdin: the stop still ends, by force, at the deadline.
    #[cfg(unix)]
    #[test]
    fn a_cockpit_that_ignores_the_request_is_killed_at_the_deadline() {
        let mut child = piped("exec sleep 30");
        let started = Instant::now();
        assert_eq!(stop(&mut child, Duration::from_millis(300)), Stopped::Killed);
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(child.try_wait().unwrap().is_some());
    }
}
