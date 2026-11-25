//! A subshell, command substitution, background job or pipeline stage whose
//! last op both queues a message and ends it (a fatal expansion error) ends
//! with bash's status, whatever obash's stderr is. On Linux `StdFile`
//! reopens a pipe through `/proc/self/fd/N` and writes through the
//! `BlockingWriter` thread when that open fails, and always for a terminal or
//! socket; on Darwin it never tries the reopen and every pipe, socket and
//! terminal write goes through the thread. The message was handed to the
//! thread and the frames unwound in one op; the vproc, with no frame left,
//! got no turn to see the thread settle the message, so it never ended and
//! the shell waited for it for ever. Here stderr is each of a pipe (on Linux
//! obash reopens it, on Darwin it takes the thread), a socket and a terminal
//! (the thread everywhere), so the condition needs no second user.
//!
//! `( echo e >&2 )`, whose write is not its last op, ended before and must
//! still: the control that an ended subshell is kept only until its message
//! is out, and that its message still comes first.

#![cfg(unix)]

mod obash_support;

use std::{
	io::Read,
	os::{
		fd::OwnedFd,
		unix::{net::UnixStream, process::CommandExt as _},
	},
	process::{Command, Output, Stdio},
	thread::{self, JoinHandle},
};

use obash_support::{LIMIT, finish, obash};

/// What obash's stderr is.
#[derive(Clone, Copy, Debug)]
enum Stderr {
	/// A pipe the test made.
	Pipe,
	/// One end of a socket pair.
	Socket,
	/// The terminal side of a new pty.
	Terminal,
}

const STDERRS: [Stderr; 3] = [Stderr::Pipe, Stderr::Socket, Stderr::Terminal];

/// `(id, script, bash's stdout, bash's stderr)`; bash 5.3.20 exits 0 from
/// each, by `-c` under the name `bash`. The last two are `h-bg-fn` and
/// `r2-bg-fn-eval` of `forked_redirection_errors.rs`'s bash 5.3 rows.
const FATAL: &[(&str, &str, &str, &str)] = &[
	("subshell", "( : ${x:?u} ); echo \"st=$?\"", "st=1\n", "bash: line 1: x: u\n"),
	("substitution", "v=$(: ${x:?u}); echo \"st=$?\"", "st=1\n", "bash: line 1: x: u\n"),
	("background", "( : ${x:?u} ) & wait $!; echo \"st=$?\"", "st=1\n", "bash: line 1: x: u\n"),
	("stage", ": ${x:?u} | cat; echo \"st=$?\"", "st=0\n", "bash: line 1: x: u\n"),
	(
		"bg-fn",
		"f() { echo ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"bg-fn-eval",
		"f() { eval 'echo ${x:?u}'; }; f & wait $!; echo \"s=$?\"",
		"s=127\n",
		"bash: line 1: x: u\n",
	),
];

/// Read `from` to its end on a thread. A terminal's side ends in `EIO` once
/// the last process holding the other side has closed it.
fn drain(mut from: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
	thread::spawn(move || {
		let mut bytes = Vec::new();
		let mut buf = [0u8; 4096];
		loop {
			match from.read(&mut buf) {
				Ok(0) | Err(_) => return bytes,
				Ok(n) => bytes.extend_from_slice(&buf[..n]),
			}
		}
	})
}

/// `script` by `-c` under the name `bash`, with `stderr` as its fd 2, to its
/// end within [`LIMIT`] (past it, `finish` kills it and panics). A terminal
/// turns each newline into `\r\n`; that is undone.
fn run(script: &str, stderr: Stderr) -> Output {
	let mut cmd: Command = obash();
	cmd.arg0("bash").arg("-c").arg(script);
	let err = match stderr {
		Stderr::Pipe => None,
		Stderr::Socket => {
			let (ours, theirs) = UnixStream::pair().unwrap();
			cmd.stderr(Stdio::from(OwnedFd::from(theirs)));
			Some(drain(ours))
		},
		Stderr::Terminal => {
			let (master, slave, _) = pi_shell::sys::tty::open_pty(None).unwrap();
			cmd.stderr(Stdio::from(slave));
			Some(drain(std::fs::File::from(master)))
		},
	};
	let child = cmd.spawn().unwrap();
	// The parent's copy of the child's stderr end goes with `cmd`, so the
	// reader sees the end once the child's copies are closed.
	drop(cmd);
	let mut out = finish(child, LIMIT);
	if let Some(err) = err {
		let bytes = err.join().unwrap();
		out.stderr = String::from_utf8_lossy(&bytes)
			.replace("\r\n", "\n")
			.into_bytes();
	}
	out
}

/// How `script` differs from bash's `(0, out, err)` with `stderr` as fd 2,
/// if it does.
fn differs(id: &str, script: &str, out: &str, err: &str, stderr: Stderr) -> Option<String> {
	let Ok(got) = std::panic::catch_unwind(|| run(script, stderr)) else {
		return Some(format!(
			"{id} ({stderr:?}): `{script}`\n  bash: 0 {out:?} {err:?}\n  got:  no end within \
			 {LIMIT:?}"
		));
	};
	let got = (
		got.status.code(),
		String::from_utf8_lossy(&got.stdout).into_owned(),
		String::from_utf8_lossy(&got.stderr).into_owned(),
	);
	(got != (Some(0), out.to_owned(), err.to_owned())).then(|| {
		format!(
			"{id} ({stderr:?}): `{script}`\n  bash: 0 {out:?} {err:?}\n  got:  {:?} {:?} {:?}",
			got.0, got.1, got.2
		)
	})
}

/// Every row with every stderr, at once (a row that does not end costs
/// [`LIMIT`]); each one that is not bash's is reported.
fn check(rows: &[(&str, &str, &str, &str)]) {
	let failures = thread::scope(|scope| {
		let workers: Vec<_> = rows
			.iter()
			.flat_map(|&(id, script, out, err)| {
				STDERRS.map(|stderr| scope.spawn(move || differs(id, script, out, err, stderr)))
			})
			.collect();
		workers
			.into_iter()
			.filter_map(|w| w.join().unwrap())
			.collect::<Vec<_>>()
	});
	assert!(
		failures.is_empty(),
		"{} of {} runs differ from bash:\n{}",
		failures.len(),
		rows.len() * STDERRS.len(),
		failures.join("\n")
	);
}

#[test]
fn a_fatal_error_that_ends_a_subshell_ends_it_whatever_its_stderr() {
	check(FATAL);
}

#[test]
fn a_subshells_write_that_is_not_its_last_op_ends_it_whatever_its_stderr() {
	check(&[("echo", "( echo e >&2 ); echo \"st=$?\"", "st=0\n", "e\n")]);
}
