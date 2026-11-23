//! A builtin's failed read or write, through the `obash` binary on the
//! host's own descriptors: bash's `read` and `select` report a failed
//! read(2) (`read: FD: read error: TEXT`, status 1, nothing assigned), and a
//! builtin's write to a read-only descriptor fails (`NAME: write error:
//! TEXT`, status 1), the null device too.
//!
//! Every expectation is bash 5.3.20's output for the same text run as
//! `bash -c TEXT bash` (stdout and stderr apart), and zsh 5.9's for the zsh
//! rows (`zsh -f -c TEXT`). bash 5.2.21 puts the descriptor after the words
//! (`read: read error: 0: Bad file descriptor`); these follow 5.3.20.
#![cfg(unix)]

mod obash_support;

use std::os::unix::process::CommandExt;

use crate::obash_support::{obash, output};

/// `(text, stdout, stderr, exit status)`: one run of `obash -c TEXT bash`.
type Row = (&'static str, &'static str, &'static str, i32);

fn check_bash(rows: &[Row]) {
	for &(text, stdout, stderr, status) in rows {
		let out = output(obash().args(["-c", text, "bash"]));
		assert_eq!(
			(
				String::from_utf8_lossy(&out.stdout),
				String::from_utf8_lossy(&out.stderr),
				out.status.code()
			),
			(stdout.into(), stderr.into(), Some(status)),
			"{text}"
		);
	}
}

const EBADF: &str = "Bad file descriptor";

#[test]
fn read_reports_a_failed_read_as_bash() {
	check_bash(&[
		(
			"exec 4>/dev/null; read x <&4; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\n",
			0,
		),
		(
			"exec 4>/dev/null; read -r -u 4 x; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: read: 4: read error: Bad file descriptor\n",
			0,
		),
		(
			"x=old; y=old; exec 4>/dev/null; read x y <&4; echo \"r=$? x=$x y=$y\"",
			"r=1 x=old y=old\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\n",
			0,
		),
		(
			"REPLY=old; a=(1 2); exec 4>/dev/null; read <&4; read -a a <&4; echo \"[$REPLY] \
			 ${#a[@]}\"",
			"[old] 2\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\nbash: line 1: read: 0: read \
			 error: Bad file descriptor\n",
			0,
		),
		(
			"exec 4>/dev/null; read -n 2 x <&4; read -t 5 x <&4; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\nbash: line 1: read: 0: read \
			 error: Bad file descriptor\n",
			0,
		),
		(
			"exec 4>/dev/null; while read l; do echo \"[$l]\"; done <&4; echo \"r=$?\"",
			"r=0\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\n",
			0,
		),
		(
			"set -e; exec 4>/dev/null; read x <&4; echo notreached",
			"",
			"bash: line 1: read: 0: read error: Bad file descriptor\n",
			1,
		),
		// A closed descriptor: the read fails as read(2) does.
		(
			"exec 0<&-; read x; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: read: 0: read error: Bad file descriptor\n",
			0,
		),
		(
			"exec 4<.; read -u 4 x; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: read: 4: read error: Is a directory\n",
			0,
		),
		// Controls: end of input is not an error, and mapfile does not
		// report a failed read.
		("x=old; read x </dev/null; echo \"r=$? [$x]\"", "r=1 []\n", "", 0),
		("exec 4>/dev/null; mapfile -u 4 a; echo \"r=$? ${#a[@]}\"", "r=0 0\n", "", 0),
	]);
}

/// A script names itself in the message, as bash does.
#[test]
fn read_error_in_a_script_names_the_script() {
	let dir = tempfile::tempdir().unwrap();
	let script = dir.path().join("s.sh");
	std::fs::write(&script, "exec 4>/dev/null\nread x <&4\necho \"r=$?\"\n").unwrap();
	let out = output(obash().arg(&script));
	assert_eq!(String::from_utf8_lossy(&out.stdout), "r=1\n");
	assert_eq!(
		String::from_utf8_lossy(&out.stderr),
		format!("{}: line 2: read: 0: read error: {EBADF}\n", script.display())
	);
	assert_eq!(out.status.code(), Some(0));
}

#[test]
fn select_reports_a_failed_read_as_bash() {
	check_bash(&[(
		"exec 0>/dev/null; select x in a b; do echo \"[$x]\"; done; echo \"r=$?\"",
		"\nr=1\n",
		"1) a\n2) b\n#? bash: line 1: 0: read error: Bad file descriptor\n",
		0,
	)]);
}

#[test]
fn a_builtin_write_to_a_read_only_descriptor_fails_as_bash() {
	check_bash(&[
		(
			"exec 4</dev/null; echo x >&4; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: echo: write error: Bad file descriptor\n",
			0,
		),
		(
			"exec 4</dev/null; printf x >&4; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: printf: write error: Bad file descriptor\n",
			0,
		),
		(
			"x=1; exec 4</dev/null; pwd >&4; declare -p x >&4; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: pwd: write error: Bad file descriptor\nbash: line 1: declare: write \
			 error: Bad file descriptor\n",
			0,
		),
		(
			"exec 0</dev/null; echo x >&0; echo \"r=$?\"",
			"r=1\n",
			"bash: line 1: echo: write error: Bad file descriptor\n",
			0,
		),
		(
			"exec 1</dev/null; echo x; echo \"r=$?\" >&2",
			"",
			"bash: line 1: echo: write error: Bad file descriptor\nr=1\n",
			0,
		),
		(
			"set -e; exec 4</dev/null; echo x >&4; echo notreached",
			"",
			"bash: line 1: echo: write error: Bad file descriptor\n",
			1,
		),
		// Controls: the null device opened for writing takes the write.
		("echo x >/dev/null; exec 4<>/dev/null; echo y >&4; echo \"r=$?\"", "r=0\n", "", 0),
	]);
}

/// zsh's `read` takes a failed read as the end of its input, and its
/// `echo` ignores `EBADF` on its standard output; only the shell's own check
/// of an unredirected standard output reports it.
#[test]
fn zsh_mode_keeps_zsh_on_failed_reads_and_writes() {
	let rows: &[Row] = &[
		("exec 4>/dev/null; read x <&4; echo \"r=$?\"", "r=1\n", "", 0),
		("exec 0<&-; read x; echo \"r=$?\"", "r=1\n", "", 0),
		("exec 4</dev/null; echo x >&4; print x >&4; echo \"r=$?\"", "r=0\n", "", 0),
		(
			"exec 1</dev/null; echo x; echo \"r=$?\" >&2",
			"",
			"zsh:1: write error: bad file descriptor\nr=0\n",
			0,
		),
	];
	for &(text, stdout, stderr, status) in rows {
		let out = output(obash().arg0("zsh").args(["-c", text]));
		assert_eq!(
			(
				String::from_utf8_lossy(&out.stdout),
				String::from_utf8_lossy(&out.stderr),
				out.status.code()
			),
			(stdout.into(), stderr.into(), Some(status)),
			"{text}"
		);
	}
}
