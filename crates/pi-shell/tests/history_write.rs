//! `history -w` and `history -a` writing the history file, through the obash
//! binary run as `bash -c SCRIPT`. The expected results are bash 5.2.21's on
//! Linux. To a FIFO or a pipe, bash opens it once, writes `first\nsecond\n`
//! once, and `history` exits 0: such a file cannot seek, so the write cannot
//! measure its progress by the file's position.

#![cfg(target_os = "linux")]

mod obash_support;

use std::{
	ffi::CString,
	io::{self, Read as _},
	os::unix::{ffi::OsStrExt as _, fs::OpenOptionsExt as _, process::CommandExt as _},
	path::Path,
	process::Output,
	time::{Duration, Instant},
};

use crate::obash_support::{finish, obash};

/// Runs `script` as `bash -c script` in `dir`, bounded at 20 s.
fn bash(dir: &Path, script: &str) -> Output {
	let mut cmd = obash();
	cmd.arg0("bash").current_dir(dir).args(["-c", script]);
	finish(cmd.spawn().unwrap(), Duration::from_secs(20))
}

/// Runs `history -s first; history -s second; history VERB hist; echo
/// status=$?` with `hist` a FIFO and a reader on it for 5 s: what the reader
/// got, and the shell's stdout and stderr.
fn history_to_a_fifo(verb: &str) -> (Vec<u8>, String, String) {
	let dir = tempfile::tempdir().unwrap();
	let fifo = dir.path().join("hist");
	let path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
	// SAFETY: `path` is a NUL-terminated path.
	assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
	// The reader is open before the shell starts, so the shell's open does
	// not wait for one.
	let mut reader = std::fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo)
		.unwrap();
	let read = std::thread::spawn(move || {
		let mut got = Vec::new();
		let mut buf = [0u8; 4096];
		let deadline = Instant::now() + Duration::from_secs(5);
		while Instant::now() < deadline && got.len() < 1 << 20 {
			match reader.read(&mut buf) {
				// 0: no writer has the FIFO open now.
				Ok(n) => got.extend_from_slice(&buf[..n]),
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
				Err(e) => panic!("reading the FIFO: {e}"),
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		got
	});
	let out = bash(
		dir.path(),
		&format!("history -s first; history -s second; history {verb} hist; echo \"status=$?\""),
	);
	(
		read.join().unwrap(),
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

#[test]
fn history_write_to_a_fifo_writes_the_history_once() {
	let (got, out, err) = history_to_a_fifo("-w");
	assert_eq!(
		String::from_utf8_lossy(&got),
		"first\nsecond\n",
		"{} bytes read; stdout {out:?}, stderr {err:?}",
		got.len()
	);
	assert_eq!(out, "status=0\n", "stderr {err:?}");
}

#[test]
fn history_append_to_a_fifo_writes_the_history_once() {
	let (got, out, err) = history_to_a_fifo("-a");
	assert_eq!(
		String::from_utf8_lossy(&got),
		"first\nsecond\n",
		"{} bytes read; stdout {out:?}, stderr {err:?}",
		got.len()
	);
	assert_eq!(out, "status=0\n", "stderr {err:?}");
}

/// A second write of the same file in the same shell counts its own bytes,
/// from 0: `-w` truncates the file and writes the whole history again.
#[test]
fn a_second_history_write_in_one_shell_writes_the_whole_history() {
	let dir = tempfile::tempdir().unwrap();
	let out = bash(
		dir.path(),
		"history -s first; history -s second; history -w hist; history -w hist; echo \"status=$?\"",
	);
	assert_eq!(
		String::from_utf8_lossy(&out.stdout),
		"status=0\n",
		"stderr {:?}",
		String::from_utf8_lossy(&out.stderr)
	);
	assert_eq!(std::fs::read_to_string(dir.path().join("hist")).unwrap(), "first\nsecond\n");
}

/// `history -w /dev/stdout` with standard output a pipe (the test's).
#[test]
fn history_write_to_a_pipe_writes_the_history_once() {
	let dir = tempfile::tempdir().unwrap();
	let out = bash(
		dir.path(),
		"history -s first; history -s second; history -w /dev/stdout; echo \"status=$?\" >&2",
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "first\nsecond\n");
	assert_eq!(String::from_utf8_lossy(&out.stderr), "status=0\n");
}
