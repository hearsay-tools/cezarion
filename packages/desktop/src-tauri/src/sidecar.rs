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
/// Decided under the child lock, which is also where a supervisor publishes a starting cockpit
/// and decides whether to go round again, so no request falls between the two.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterNewVersion {
    /// A cockpit runs, or is starting, on the old version: stop it; its supervisor relaunches.
    RestartRunning,
    /// Nothing runs and nothing supervises (the launcher, or after a start or server failure):
    /// start a supervisor, or the splash would wait forever.
    StartSupervisor,
    /// A supervisor is alive without a cockpit (installing, between two cockpits, or cleaning up a
    /// failed start): flag the restart, and it relaunches at its next decision instead of stopping.
    AskSupervisor,
}

pub fn after_new_version(cockpit_running: bool, supervising: bool) -> AfterNewVersion {
    match (cockpit_running, supervising) {
        (true, _) => AfterNewVersion::RestartRunning,
        (false, false) => AfterNewVersion::StartSupervisor,
        (false, true) => AfterNewVersion::AskSupervisor,
    }
}

/// What a supervisor does when its cockpit is gone or never came up.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// The app is quitting: start nothing new.
    Quit,
    /// A restart was asked for (a new version, or the cockpit exited 75): start the current one.
    Relaunch,
    /// Nothing asked for another cockpit: stop supervising.
    Stop,
}

pub fn supervisor_next(quitting: bool, relaunch: bool) -> Next {
    match (quitting, relaunch) {
        (true, _) => Next::Quit,
        (false, true) => Next::Relaunch,
        (false, false) => Next::Stop,
    }
}

/// One step of stopping a cockpit that stays published in the shell's slot while it stops, so a
/// quit in the meantime still finds it (and installs nothing until it is gone).
#[derive(Debug, PartialEq, Eq)]
pub enum StopStep {
    /// The slot no longer holds it: quit took it and stops it itself. Touch nothing.
    LeftToQuit,
    /// It exited: clear the slot.
    Exited,
    /// Still running past the grace period: force-kill it, then wait for the exit.
    Kill,
    /// Still running inside the grace period: wait.
    Wait,
}

pub fn published_stop_step(owned: bool, exited: bool, past_deadline: bool) -> StopStep {
    match (owned, exited, past_deadline) {
        (false, _, _) => StopStep::LeftToQuit,
        (true, true, _) => StopStep::Exited,
        (true, false, true) => StopStep::Kill,
        (true, false, false) => StopStep::Wait,
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

    // A cockpit is published before its health wait, so one that is still starting counts as
    // running: it is stopped and relaunched on the new version, not left on the old one.
    #[test]
    fn a_new_version_while_a_cockpit_starts_restarts_it() {
        assert_eq!(after_new_version(true, true), AfterNewVersion::RestartRunning);
    }

    // The first install runs inside `supervise`, and a failed start is cleaned up there: the
    // supervisor is asked to go round again rather than the request being dropped.
    #[test]
    fn a_new_version_during_an_install_or_a_failed_start_asks_the_supervisor() {
        assert_eq!(after_new_version(false, true), AfterNewVersion::AskSupervisor);
    }

    #[test]
    fn a_supervisor_relaunches_on_request() {
        assert_eq!(supervisor_next(false, true), Next::Relaunch);
    }

    #[test]
    fn a_supervisor_with_nothing_asked_stops() {
        assert_eq!(supervisor_next(false, false), Next::Stop);
    }

    // Quit wins: a restart asked for during quit, or a cockpit that exited 75, starts nothing.
    #[test]
    fn a_quitting_app_starts_no_new_cockpit() {
        assert_eq!(supervisor_next(true, true), Next::Quit);
        assert_eq!(supervisor_next(true, false), Next::Quit);
    }

    // Quit during a failed start's stop: quit took the cockpit from the slot and stops it
    // itself, so the failed start leaves it alone; before, the stopper held it outside the slot
    // and quit installed the shell update while it still ran.
    #[test]
    fn a_failed_start_stop_leaves_a_cockpit_quit_took() {
        assert_eq!(published_stop_step(false, false, false), StopStep::LeftToQuit);
        assert_eq!(published_stop_step(false, false, true), StopStep::LeftToQuit);
    }

    #[test]
    fn a_failed_start_stop_waits_kills_then_clears_the_slot() {
        assert_eq!(published_stop_step(true, false, false), StopStep::Wait);
        assert_eq!(published_stop_step(true, false, true), StopStep::Kill);
        assert_eq!(published_stop_step(true, true, false), StopStep::Exited);
        assert_eq!(published_stop_step(true, true, true), StopStep::Exited);
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
