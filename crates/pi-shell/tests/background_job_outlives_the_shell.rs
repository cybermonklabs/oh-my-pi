//! The process shell (`obash -c`, a script) leaves a background job that is
//! just its program running when it exits, as bash leaves its children
//! running: `cmd &`, `nohup cmd &`. In-engine work still ends with the
//! shell, and with it the programs it started: a background function, a
//! subshell with more to run than its program, a pipeline.
//!
//! Each case starts a job that waits 0.5 s and then writes a marker file;
//! obash's own end is read first (the marker must not exist yet), then the
//! marker is awaited for 5 s.
#![cfg(unix)]

mod obash_support;

use std::{
	process::Stdio,
	thread,
	time::{Duration, Instant},
};

use crate::obash_support::{kill_all, obash};

/// The job: wait, then write the marker (`MARKER` in a case's script).
const JOB: &str = r#"/bin/sh -c "sleep 0.5; echo out > MARKER""#;

/// Run `script` (`JOB` in it replaced by [`JOB`]) with `obash -c`: whether
/// the marker appeared after obash had exited.
fn outlives(script: &str) -> bool {
	let tmp = tempfile::tempdir().unwrap();
	let marker = tmp.path().join("marker");
	let code = script
		.replace("JOB", JOB)
		.replace("MARKER", marker.to_str().unwrap());
	let mut child = obash()
		.args(["-c", &code])
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.unwrap();
	let deadline = Instant::now() + Duration::from_secs(10);
	let status = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break status;
		}
		assert!(Instant::now() < deadline, "obash did not exit: {code:?}");
		thread::sleep(Duration::from_millis(5));
	};
	assert!(status.success(), "{code:?}: {status:?}");
	assert!(!marker.exists(), "the job ended before obash did: {code:?}");
	let until = Instant::now() + Duration::from_secs(5);
	let mut seen = false;
	while !seen && Instant::now() < until {
		thread::sleep(Duration::from_millis(50));
		seen = marker.exists();
	}
	kill_all(&mut child);
	seen
}

#[test]
fn a_background_program_outlives_the_shell() {
	assert!(outlives("JOB & echo after"));
	assert!(outlives("JOB & exit 0"));
}

#[test]
fn a_nohup_background_program_outlives_the_shell() {
	assert!(outlives("nohup JOB > /dev/null 2>&1 & echo after"));
}

/// Controls: in-engine work ends with the shell, and the programs it started
/// with it.
#[test]
fn in_engine_background_work_ends_with_the_shell() {
	assert!(!outlives("f() { JOB; }; f & echo after"));
	assert!(!outlives("( JOB; : ) & echo after"));
	assert!(!outlives("JOB | cat & echo after"));
}
