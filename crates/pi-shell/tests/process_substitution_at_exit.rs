//! A process substitution still running when the shell ends. bash's are
//! processes of their own, which its exit leaves running with the
//! descriptors they hold: their output still comes (`cmd > >(slow-reader)`,
//! `exec > >(tee log)`), and a command substitution reads until they close
//! its output. obash runs them in its own process, so the process stays
//! until they end; the bash tool keeps a command's output open for them.
//!
//! Every expectation was measured against bash 5.3.20 and 5.2.21, as `-c`
//! and as a script file; the two agree on every row.
#![cfg(unix)]

use std::{
	io::Read,
	os::unix::process::CommandExt,
	process::{Command, Stdio},
	sync::mpsc,
	time::Duration,
};

use pi_shell::{Shell, ShellExecuteOptions, ShellRunOptions, cancel::CancelToken, execute_shell};

/// Longest a row may keep its output open: far beyond any row's own
/// delays, so only a substitution that never ends reaches it.
const LIMIT: Duration = Duration::from_secs(20);

/// obash as `name` (`bash` or `zsh`) running `code` (`-c`, or as a script
/// file) in a fresh directory, stdin `/dev/null`, no startup files: its
/// status, and its stdout read to end of file. Panics when the output is
/// still open after [`LIMIT`].
fn obash(name: &str, code: &str, script: bool) -> (Option<i32>, String) {
	let dir = tempfile::tempdir().expect("tempdir");
	let mut command = Command::new(env!("CARGO_BIN_EXE_obash"));
	command.arg0(name);
	if name == "zsh" {
		command.arg("-f");
	} else {
		command.args(["--noprofile", "--norc"]);
	}
	if script {
		let path = dir.path().join("s.sh");
		std::fs::write(&path, code).expect("write the script");
		command.arg(path);
	} else {
		command.args(["-c", code]);
	}
	let mut child = command
		.current_dir(dir.path())
		.env_remove("BASH_ENV")
		.env_remove("ENV")
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.expect("start obash");
	let mut stdout = child.stdout.take().expect("stdout");
	let (tx, rx) = mpsc::channel();
	std::thread::spawn(move || {
		let mut out = String::new();
		stdout.read_to_string(&mut out).expect("read stdout");
		let _ = tx.send(out);
	});
	let Ok(out) = rx.recv_timeout(LIMIT) else {
		let _ = child.kill();
		panic!("{name} {code:?} (script: {script}): output still open after {LIMIT:?}");
	};
	let status = child.wait().expect("wait for obash");
	(status.code(), out)
}

/// Each row's status and stdout under obash as `name`, as `-c` and as a
/// script.
fn check_as(name: &str, rows: &[(&str, i32, &str)]) {
	for &(code, status, stdout) in rows {
		for script in [false, true] {
			assert_eq!(
				obash(name, code, script),
				(Some(status), stdout.to_owned()),
				"{name} {code:?} (script: {script})"
			);
		}
	}
}

/// [`check_as`] `bash`.
fn check(rows: &[(&str, i32, &str)]) {
	check_as("bash", rows);
}

/// What a `>(…)` writes after the shell's last command still comes, in
/// bash's order; the shell's status is its own.
#[test]
fn a_process_substitution_outlives_the_shell() {
	check(&[
		("/bin/echo hi > >(sleep 0.2; /bin/cat); echo after", 0, "after\nhi\n"),
		("echo hi > >(sleep 0.2; /bin/cat); echo after", 0, "after\nhi\n"),
		("/bin/echo hi > >(sleep 0.2; /bin/cat); exit 3", 3, "hi\n"),
		("/bin/echo hi > >(sleep 0.2; read l; echo \"got $l\"); echo after", 0, "after\ngot hi\n"),
		(
			"trap \"echo T\" EXIT; /bin/echo hi > >(sleep 0.2; /bin/cat); echo after",
			0,
			"after\nT\nhi\n",
		),
		("set -e; /bin/echo hi > >(sleep 0.2; /bin/cat); false; echo no", 1, "hi\n"),
		("( /bin/echo hi > >(sleep 0.2; /bin/cat); echo in ); echo after", 0, "in\nafter\nhi\n"),
		(
			"/bin/echo hi > >(sleep 0.1; /bin/cat > >(sleep 0.1; /bin/cat)); echo after",
			0,
			"after\nhi\n",
		),
		// The reader runs two subshells under the substitution: the exit
		// spares what descends from it at any depth.
		("/bin/echo hi > >( ( (sleep 0.3; /bin/cat); : ); : ); echo after", 0, "after\nhi\n"),
		(": > >(sleep 1; echo late); echo after", 0, "after\nlate\n"),
	]);
}

/// The shell's exit closes its own descriptors: a `>(…)` reading what the
/// shell wrote sees end of file, and its output ends with it.
#[test]
fn the_exit_closes_what_a_process_substitution_reads() {
	check(&[
		("exec > >(/usr/bin/tee out); echo hi; echo after", 0, "hi\nafter\n"),
		("exec > >(sleep 0.2; /bin/sed s/h/H/); echo hi", 0, "Hi\n"),
		("exec 3> >(sleep 0.2; /bin/cat); echo to3 >&3; echo after", 0, "after\nto3\n"),
	]);
}

/// A command substitution reads its output until the process
/// substitutions its body started have closed it too.
#[test]
fn a_command_substitution_reads_until_its_process_substitutions_end() {
	check(&[
		("x=$(/bin/echo hi > >(sleep 0.2; /bin/cat)); echo \"[$x]\"", 0, "[hi]\n"),
		("x=$(echo hi > >(sleep 0.2; /bin/cat)); echo \"[$x]\"", 0, "[hi]\n"),
		("x=$( ( /bin/echo hi > >(sleep 0.2; /bin/cat) ) ); echo \"[$x]\"", 0, "[hi]\n"),
		(
			"x=$(/bin/echo hi > >(sleep 0.1; /bin/cat > >(sleep 0.1; /bin/cat))); echo \"[$x]\"",
			0,
			"[hi]\n",
		),
		("x=$(: > >(sleep 1; echo late)); echo \"[$x]\"", 0, "[late]\n"),
	]);
}

/// `wait $!` and `wait` right after a builtin's `>(…)`: `$!` names the
/// substitution, which bash waits for.
#[test]
fn wait_waits_for_a_builtins_process_substitution() {
	check(&[
		("echo hi > >(sleep 0.2; /bin/cat); wait $!; echo \"after $?\"", 0, "hi\nafter 0\n"),
		("echo hi > >(sleep 0.2; /bin/cat); wait; echo \"after $?\"", 0, "hi\nafter 0\n"),
	]);
}

/// zsh's process substitutions outlive the shell too (zsh 5.9's output).
#[test]
fn a_zsh_process_substitution_outlives_the_shell() {
	check_as("zsh", &[
		("/bin/echo hi > >(sleep 0.2; /bin/cat); echo after", 0, "after\nhi\n"),
		("/bin/echo hi > >(sleep 0.2; /bin/cat); exit 3", 3, "hi\n"),
		("x=$(/bin/echo hi > >(sleep 0.2; /bin/cat)); echo \"[$x]\"", 0, "[hi]\n"),
		("exec > >(/usr/bin/tee out); echo hi; echo after", 0, "hi\nafter\n"),
	]);
}

/// The bash tool's two paths: a one-shot `execute_shell` and a retained
/// `Shell`. Nothing reaches the retained shell's next command.
#[tokio::test(flavor = "multi_thread")]
async fn the_bash_tool_keeps_a_process_substitutions_output() {
	let row = "/bin/echo hi > >(sleep 0.05; /bin/cat); echo after";
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions { command: row.to_owned(), ..Default::default() },
		Some(tx),
		CancelToken::new(Some(20_000)),
	)
	.await
	.expect("execute_shell");
	assert_eq!(
		(result.exit_code, rx.drain().collect::<String>()),
		(Some(0), "after\nhi\n".to_owned())
	);

	let shell = Shell::new(None);
	for (command, expected) in [(row, "after\nhi\n"), ("echo next", "next\n")] {
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions { command: command.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		assert_eq!(
			(result.exit_code, rx.drain().collect::<String>()),
			(Some(0), expected.to_owned()),
			"{command}"
		);
	}
}

/// The bash tool's one-shot path: `row`'s status, output and duration.
async fn one_shot(row: &str) -> (Option<i32>, String, Duration) {
	let (tx, rx) = flume::unbounded::<String>();
	let start = std::time::Instant::now();
	let result = execute_shell(
		ShellExecuteOptions { command: row.to_owned(), ..Default::default() },
		Some(tx),
		CancelToken::new(Some(20_000)),
	)
	.await
	.expect("execute_shell");
	(result.exit_code, rx.drain().collect(), start.elapsed())
}

/// While a substitution holds the command's output, the tool waits for its
/// end of file rather than for 250 ms without output: what it writes 0.5 s
/// and 1.5 s after the command arrives.
#[tokio::test(flavor = "multi_thread")]
async fn the_bash_tool_waits_for_a_substitution_that_writes_late() {
	for delay in ["0.5", "1.5"] {
		let row = format!("/bin/echo hi > >(sleep {delay}; /bin/cat); echo after");
		let (status, output, _) = one_shot(&row).await;
		assert_eq!((status, output.as_str()), (Some(0), "after\nhi\n"), "{row}");
	}
}

/// A substitution that never ends holds the tool for its 2 s cap, then the
/// command's own output comes back.
#[tokio::test(flavor = "multi_thread")]
async fn the_bash_tool_stops_waiting_for_a_substitution_at_its_cap() {
	let (status, output, took) = one_shot(": > >(sleep 30); echo after").await;
	assert_eq!((status, output.as_str()), (Some(0), "after\n"));
	assert!(
		(Duration::from_millis(1900)..Duration::from_secs(10)).contains(&took),
		"returned after {took:?}, not at the 2 s cap"
	);
}
