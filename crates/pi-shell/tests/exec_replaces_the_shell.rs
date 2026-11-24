//! `exec` with a command replaces the shell (bash's `exec_builtin`): the
//! shell it replaces runs no EXIT trap, whether its program ran or failed to
//! start (bash reset the trapped signals first), and a program that dies of
//! a signal takes the shell with it. A name `exec` does not find keeps the
//! trap, and so does `execfail`, under which the shell goes on. `exec`
//! names its program by the full path.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job. bash 5.2.21 agrees, but
//! when exec fails on a directory, a file that is not executable or a binary
//! file it prints a second `cannot execute` line. Each row runs as `-c` and
//! as a script file, in a directory of its own: in the expected stderr `PFX`
//! is the messages' prefix (the shell's name under `-c`, `D/s.sh` from the
//! script) and `D` the row's directory.
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::ExitStatusExt};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

use crate::obash_support::{obash, output};

/// How a row's shell ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
	Status(i32),
	Signal(i32),
}

/// A row: the script, its stdout, its stderr (`PFX` and `D` as above) and
/// how the shell ends.
type Row = (&'static str, &'static str, &'static str, End);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = env!("CARGO_BIN_EXE_obash");
	let mut out = Vec::new();
	for &(code, want_out, want_err, want_end) in rows {
		for script in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let dir = fs::canonicalize(tmp.path()).unwrap();
			let d = dir.to_str().unwrap().to_owned();
			let mut cmd = obash();
			cmd.current_dir(&dir)
				.env("PATH", "/usr/bin:/bin")
				.env("LC_ALL", "C");
			let prefix = if script {
				let file = dir.join("s.sh");
				fs::write(&file, code).unwrap();
				cmd.arg(&file);
				"D/s.sh"
			} else {
				cmd.args(["-c", code]);
				"SH"
			};
			let o = output(&mut cmd);
			let norm = |b: &[u8]| {
				String::from_utf8_lossy(b)
					.replace(sh, "SH")
					.replace(&d, "D")
			};
			let end = match (o.status.code(), o.status.signal()) {
				(Some(c), _) => End::Status(c),
				(None, Some(s)) => End::Signal(s),
				(None, None) => panic!("{code:?}: neither a status nor a signal"),
			};
			let got = (norm(&o.stdout), norm(&o.stderr), end);
			let want = (want_out.to_owned(), want_err.replace("PFX", prefix), want_end);
			if got != want {
				let how = if script { "script" } else { "-c" };
				out.push(format!("{code:?} ({how}): got {got:?}, want {want:?}"));
			}
		}
	}
	out
}

fn check(rows: &[Row]) {
	let wrong = mismatches(rows);
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn exec_of_a_program_runs_no_exit_trap() {
	check(&[
		(r#"trap "echo T" EXIT; exec /bin/true"#, "", "", End::Status(0)),
		(r#"trap "echo T" EXIT; exec /bin/false"#, "", "", End::Status(1)),
		(r#"trap "echo T" EXIT; exec /bin/sh -c "exit 3""#, "", "", End::Status(3)),
		(
			r#"printf "echo s\n" > s; chmod +x s; trap "echo T" EXIT; exec ./s"#,
			"s\n",
			"",
			End::Status(0),
		),
		(r#"f() { exec /bin/echo x; }; trap "echo T" EXIT; f; echo no"#, "x\n", "", End::Status(0)),
		(
			r#"f() { trap "echo R" RETURN; exec /bin/echo x; }; set -T; trap "echo T" EXIT; f"#,
			"x\n",
			"",
			End::Status(0),
		),
		(r#"trap "echo T" EXIT; exec -a foo /bin/sh -c "echo \$0""#, "foo\n", "", End::Status(0)),
		(r#"trap "echo T" EXIT; exec echo hi"#, "hi\n", "", End::Status(0)),
		(r#"trap "echo E" ERR; trap "echo T" EXIT; exec /bin/false"#, "", "", End::Status(1)),
	]);
}

#[test]
fn exec_that_fails_to_start_runs_no_exit_trap() {
	check(&[
		(
			r#"trap "echo T" EXIT; exec /nonexistent"#,
			"",
			"PFX: line 1: /nonexistent: No such file or directory\n",
			End::Status(127),
		),
		(r#"trap "echo T" EXIT; exec 2>/dev/null /nonexistent"#, "", "", End::Status(127)),
		(
			r#"set -o posix; trap "echo T" EXIT; exec /nonexistent"#,
			"",
			"PFX: line 1: /nonexistent: No such file or directory\n",
			End::Status(127),
		),
	]);
}

#[test]
fn exec_in_a_subshell_runs_no_exit_trap() {
	check(&[
		(
			r#"( trap "echo T" EXIT; exec /bin/true ); echo "after $?""#,
			"after 0\n",
			"",
			End::Status(0),
		),
		(
			r#"( trap "echo T" EXIT; exec /nonexistent ); echo "after $?""#,
			"after 127\n",
			"PFX: line 1: /nonexistent: No such file or directory\n",
			End::Status(0),
		),
		(
			r#"trap "echo T" EXIT; x=$(trap "echo C" EXIT; exec /bin/echo in); echo "[$x]""#,
			"[in]\nT\n",
			"",
			End::Status(0),
		),
		(
			r#"trap "echo T" EXIT; ( trap "echo B" EXIT; exec /bin/echo bg ) & wait; echo done"#,
			"bg\ndone\nT\n",
			"",
			End::Status(0),
		),
		(
			r#"trap "echo T" EXIT; exec /bin/echo a | cat; echo "b ${PIPESTATUS[*]}""#,
			"a\nb 0 0\nT\n",
			"",
			End::Status(0),
		),
		(
			r#"( exec /bin/sh -c "kill -TERM \$\$" ) & wait $!; echo "after $?""#,
			"after 143\n",
			"",
			End::Status(0),
		),
	]);
}

/// Controls: where bash keeps the EXIT trap, so must we.
#[test]
fn exec_of_a_name_not_found_keeps_the_exit_trap() {
	check(&[
		(
			r#"trap "echo T" EXIT; exec nosuchcmd"#,
			"T\n",
			"PFX: line 1: exec: nosuchcmd: not found\n",
			End::Status(127),
		),
		(
			r#"f() { echo fn; }; trap "echo T" EXIT; exec f"#,
			"T\n",
			"PFX: line 1: exec: f: not found\n",
			End::Status(127),
		),
		(
			r#"mkdir zz; trap "echo T" EXIT; exec zz"#,
			"T\n",
			"PFX: line 1: exec: zz: cannot execute: Is a directory\n",
			End::Status(126),
		),
		(
			r#"shopt -s execfail; trap "echo T" EXIT; exec /nonexistent; echo "on $?""#,
			"on 127\nT\n",
			"PFX: line 1: /nonexistent: No such file or directory\n",
			End::Status(0),
		),
		(
			r#"shopt -s execfail; trap "echo T" EXIT; exec ./nope; exit 4"#,
			"T\n",
			"PFX: line 1: D/nope: No such file or directory\n",
			End::Status(4),
		),
		(r#"trap "echo T" EXIT; exec 3>/dev/null; echo on"#, "on\nT\n", "", End::Status(0)),
	]);
}

/// A command still sets `$?` and `PIPESTATUS` as it finishes (the step
/// the change touches): an external, which finishes through it (a plain
/// builtin such as `false` sets them on a path of its own).
#[test]
fn a_finished_command_sets_pipestatus() {
	check(&[
		(r#"false | true; /bin/false; echo "${PIPESTATUS[*]}""#, "1\n", "", End::Status(0)),
		(
			r#"exec 3>/dev/null; true | false; /bin/true; echo "${PIPESTATUS[*]}""#,
			"0\n",
			"",
			End::Status(0),
		),
	]);
}

#[test]
fn exec_dies_of_the_signal_its_program_died_of() {
	check(&[
		(r#"trap "echo T" EXIT; exec /bin/sh -c "kill -TERM \$\$""#, "", "", End::Signal(15)),
		(r#"trap "echo T" EXIT; exec /bin/sh -c "kill -INT \$\$""#, "", "", End::Signal(2)),
		(r#"trap "echo T" EXIT; exec /bin/sh -c "kill -PIPE \$\$""#, "", "", End::Signal(13)),
	]);
}

#[test]
fn exec_names_its_program_by_the_full_path() {
	check(&[
		(
			r#"mkdir dd; trap "echo T" EXIT; exec ./dd"#,
			"",
			"PFX: line 1: D/dd: Is a directory\n",
			End::Status(126),
		),
		(
			r#"mkdir q; trap "echo T" EXIT; exec ././q"#,
			"",
			"PFX: line 1: D/./q: Is a directory\n",
			End::Status(126),
		),
		(
			r#": > f; trap "echo T" EXIT; exec ./f"#,
			"",
			"PFX: line 1: D/f: Permission denied\n",
			End::Status(126),
		),
		(
			r#"printf "a\0b\n" > bin; chmod +x bin; trap "echo T" EXIT; exec ./bin"#,
			"",
			"PFX: line 1: D/bin: cannot execute binary file: Exec format error\n",
			End::Status(126),
		),
		(
			r#"mkdir d2; cd d2; trap "echo T" EXIT; exec ../nonexistent"#,
			"",
			"PFX: line 1: D/d2/../nonexistent: No such file or directory\n",
			End::Status(127),
		),
		(
			r#"printf "echo \$0\n" > s2; chmod +x s2; trap "echo T" EXIT; exec ./s2"#,
			"D/s2\n",
			"",
			End::Status(0),
		),
	]);
}

/// The bash tool's retained shell: each command is a run of its own. A run
/// that `exec` ended runs no EXIT trap, and the trap does not come back at
/// the end of the next run (the replaced shell took it along), as a trap
/// the run fired does not.
#[tokio::test(flavor = "multi_thread")]
async fn a_retained_shell_drops_the_exit_trap_exec_skipped() {
	let shell = Shell::new(None);
	let mut outputs = Vec::new();
	for command in [r#"trap "echo T" EXIT; exec /bin/true"#, "echo next", "echo again"] {
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions { command: command.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(30_000)),
			)
			.await
			.expect("run");
		outputs.push((result.exit_code, rx.drain().collect::<String>()));
	}
	assert_eq!(outputs, [
		(Some(0), String::new()),
		(Some(0), "next\n".to_owned()),
		(Some(0), "again\n".to_owned()),
	]);
}
