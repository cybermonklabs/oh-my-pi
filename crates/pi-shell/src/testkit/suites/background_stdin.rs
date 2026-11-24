//! A background command's stdin through the engine's own paths: the
//! `/dev/null` bash gives it is opened through the host's filesystem (an
//! open answered later parks the job's start), a failed open keeps the
//! shell's stdin with bash's message, and bash's `stdin_redir` survives a
//! snapshot. The rows against real bash and zsh are
//! `tests/background_job_stdin.rs`.

use crate::{
	bash::Script,
	testkit::{FakeHost, Fault, FaultKind, MemFs, Rig, fault::skeleton_init, run_script},
};

/// The job's `/dev/null` open goes through the filesystem, and an answer
/// that comes later parks the `&` until it does: the first job reads end
/// of file, the second (its own `<&0`) the shell's stdin.
#[test]
fn a_jobs_dev_null_open_answered_later_parks_its_start() {
	let fs = MemFs::with_latency(7, 1.0, 1);
	let probe = fs.clone();
	let host = FakeHost::new().with_fs(fs).with_stdin(b"hi\n");
	let src = b"{ read -r x; echo \"a[$x]\"; } & wait; { read -r y; echo \"b[$y]\"; } <&0 & wait";
	let out = run_script(host, src, &[], Fault::None);
	assert_eq!(
		(String::from_utf8_lossy(&out.stdout).as_ref(), out.status),
		("a[]\nb[hi]\n", 0),
		"stderr: {}",
		String::from_utf8_lossy(&out.stderr)
	);
	assert!(probe.pending_count() > 0, "no filesystem answer was pending: /dev/null was not opened");
}

/// bash (`async_redirect_stdin`): when `/dev/null` cannot be opened the
/// job reports it and reads the shell's stdin.
#[test]
fn a_failed_dev_null_open_keeps_the_shells_stdin_with_bashs_message() {
	let fs = MemFs::new().with_faults(1.0, &[FaultKind::Eio]);
	let host = FakeHost::new().with_fs(fs).with_stdin(b"hi\n");
	let out = run_script(host, b"{ read -r x; echo \"[$x]\"; } & wait", &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "[hi]\n");
	assert_eq!(
		String::from_utf8_lossy(&out.stderr),
		"bash: line 1: cannot redirect standard input from /dev/null: Input/output error\n"
	);
}

/// bash's `stdin_redir`, set by a compound command's stdin redirection,
/// is imaged with the vproc: with a snapshot and restore at every op the
/// later job still keeps the shell's stdin.
#[test]
fn stdin_redir_survives_a_snapshot() {
	let src = b"{ :; } </dev/null; { read -r x; echo \"[$x]\"; } & wait";
	for fault in [Fault::None, Fault::Snapshot { every: 1 }] {
		let out = run_script(FakeHost::new().with_stdin(b"hi\n"), src, &[], fault);
		assert_eq!(String::from_utf8_lossy(&out.stdout), "[hi]\n", "{fault:?}");
		if matches!(fault, Fault::Snapshot { .. }) {
			assert!(out.snapshots > 0, "no snapshot landed");
		}
	}
}

/// Each run is a command read anew (bash's `reader_loop` clears
/// `stdin_redir` before it): a stdin redirection in one tool command does
/// not keep a later command's job on the shell's stdin.
#[test]
fn each_run_starts_with_stdin_redir_clear() {
	let mut rig = Rig::new(FakeHost::new().with_stdin(b"hi\n"), skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(&b"{ :; } </dev/null"[..]), Fault::None), 0);
	assert_eq!(
		rig.run(Script::command(&b"{ read -r x; echo \"[$x]\"; } & wait"[..]), Fault::None),
		0
	);
	assert_eq!(String::from_utf8_lossy(&rig.host.stdout.bytes()), "[]\n");
}
