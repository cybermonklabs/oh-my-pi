//! Pipelines of obash on Windows whose external stages share one pipe.
//!
//! bash and zsh give two external stages one kernel pipe. obash joined every
//! pair of stages with an in-memory pipe and pumped each external's end
//! through its own process, so when obash was terminated, the stage before
//! lost its reader and the stage after read end of file. A pipe between
//! stages now becomes an OS pipe once an external takes one of its ends, and a
//! stage of shell code reads and writes that pipe itself.
//!
//! The externals are obash itself (`$OB`) running scripts of its own
//! builtins, so the tests need no other program. No real shell is compared:
//! each case's output is what bash 5.2 prints for the same pipeline on Unix.
//!
//! A case that terminates the shell waits until its first external has made
//! `$F` and its last `$F.cat`, terminates the shell (`TerminateProcess`) and
//! waits for its exit, and only then writes a line to the shell's stdin. The
//! first external inherited that stdin and waits for the line, so what it
//! prints after it can reach the output only through a pipe the shell does
//! not hold. The run's output is read to its end, which comes once every
//! process holding it has ended.

#![cfg(windows)]

use std::{
	io::{Read, Write},
	path::Path,
	process::{Command, Stdio},
	thread,
};

/// The first external of a case that terminates the shell: it makes `$F`,
/// waits for a line on its stdin (the shell's, inherited), then prints
/// `child-done`.
const CHILD: &str = ": > \"$F\"; IFS= read -r go; echo child-done";

/// `cat` of builtins, once it has made `$F.cat`.
const CAT: &str = ": > \"$F.cat\"; while IFS= read -r l; do printf '%s\\n' \"$l\"; done";

/// `cat` of builtins.
const COPY: &str = "while IFS= read -r l; do printf '%s\\n' \"$l\"; done";

/// Counts the lines it reads.
const COUNT: &str = "n=0; while IFS= read -r l; do n=$((n + 1)); done; echo $n";

/// Prints 20000 lines.
const LINES: &str = "i=0; while [ $i -lt 20000 ]; do echo \"line $i\"; i=$((i + 1)); done";

/// A path as obash's scripts take it: forward slashes.
fn slashed(path: &Path) -> String {
	path.to_str().expect("a UTF-8 path").replace('\\', "/")
}

/// A command running `script` under obash with the scripts above in its
/// environment (`$OB`, `$CHILD`, `$CAT`, `$COPY`, `$COUNT`, `$LINES`) and
/// `$F` naming a file in `dir`.
fn obash(script: &str, dir: &Path) -> Command {
	let obash = env!("CARGO_BIN_EXE_obash");
	let mut cmd = Command::new(obash);
	cmd.args(["-c", script])
		.env("OB", slashed(Path::new(obash)))
		.env("F", slashed(&dir.join("F")))
		.env("CHILD", CHILD)
		.env("CAT", CAT)
		.env("COPY", COPY)
		.env("COUNT", COUNT)
		.env("LINES", LINES)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	cmd
}

/// Everything `from` gives until its end, read on a thread of its own.
fn drain(mut from: impl Read + Send + 'static) -> thread::JoinHandle<String> {
	thread::spawn(move || {
		let mut all = Vec::new();
		from.read_to_end(&mut all).expect("read the shell's output");
		String::from_utf8_lossy(&all).into_owned()
	})
}

/// `script` run to its end: its stdout and stderr.
fn run(script: &str) -> (String, String) {
	let dir = tempfile::tempdir().expect("a directory for the stages' files");
	let out = obash(script, dir.path())
		.stdin(Stdio::null())
		.output()
		.expect("run obash");
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

/// `script` with the shell terminated once both `$F` and `$F.cat` exist, and
/// a line written to the shell's stdin once it has exited: the run's whole
/// stdout and stderr.
fn run_terminated(script: &str) -> (String, String) {
	let dir = tempfile::tempdir().expect("a directory for the stages' files");
	let started = dir.path().join("F");
	let cat = dir.path().join("F.cat");
	let mut child = obash(script, dir.path())
		.stdin(Stdio::piped())
		.spawn()
		.expect("start obash");
	let mut stdin = child.stdin.take().expect("the shell's stdin");
	let stdout = drain(child.stdout.take().expect("the shell's stdout"));
	let stderr = drain(child.stderr.take().expect("the shell's stderr"));
	while !(started.exists() && cat.exists()) {
		if let Some(status) = child.try_wait().expect("look at the shell") {
			drop(stdin);
			panic!(
				"{script}: the shell ended ({status}) before its stages ran: {:?} {:?}",
				stdout.join().unwrap(),
				stderr.join().unwrap()
			);
		}
		thread::sleep(std::time::Duration::from_millis(5));
	}
	child.kill().expect("terminate the shell");
	child.wait().expect("wait for the shell");
	stdin.write_all(b"go\n").expect("release the first stage");
	drop(stdin);
	(stdout.join().unwrap(), stderr.join().unwrap())
}

/// `CHILD | cat` outlives the shell's termination: the stages share one
/// pipe, so what CHILD writes after the shell is gone still reaches `cat`.
/// So does a stage that runs shell code before its external: the shell's
/// own write and the external's arrive in order.
#[test]
fn external_stages_outlive_the_shell() {
	for (script, want) in [
		("\"$OB\" -c \"$CHILD\" | \"$OB\" -c \"$CAT\"", "child-done\n"),
		("{ echo early; \"$OB\" -c \"$CHILD\"; } | \"$OB\" -c \"$CAT\"", "early\nchild-done\n"),
	] {
		let (stdout, stderr) = run_terminated(script);
		assert_eq!(stdout, want, "{script}: stderr {stderr:?}");
	}
}

/// A stage of shell code between externals reads and writes the pipe itself:
/// the output and every stage's status are bash's, a line `read` takes leaves
/// the rest to the external after it, more than a pipe's capacity crosses in
/// each direction, and a writer whose reader left gets `SIGPIPE` (141).
#[test]
fn shell_code_stages_between_externals() {
	for (script, want) in [
		(
			"\"$OB\" -c \"printf 'a\\nb\\nc\\n'\" | while read -r l; do echo \"got $l\"; done | \
			 \"$OB\" -c \"$COPY\"; echo \"${PIPESTATUS[*]}\"",
			"got a\ngot b\ngot c\n0 0 0\n",
		),
		(
			"\"$OB\" -c \"printf 'one\\ntwo\\nthree\\n'\" | { read -r a; echo \"a=$a\"; \"$OB\" -c \
			 \"$COPY\"; }",
			"a=one\ntwo\nthree\n",
		),
		("eval \"$LINES\" | \"$OB\" -c \"$COUNT\"", "20000\n"),
		("\"$OB\" -c \"$LINES\" | { eval \"$COUNT\"; }", "20000\n"),
		(
			"\"$OB\" -c 'echo x; exit 3' | { \"$OB\" -c \"$COPY\"; exit 4; } | \"$OB\" -c \"$COPY; \
			 exit 5\"; echo \"${PIPESTATUS[*]}\"",
			"x\n3 4 5\n",
		),
		(
			"while :; do echo y; done | \"$OB\" -c 'IFS= read -r l; echo \"$l\"'; echo \
			 \"${PIPESTATUS[*]}\"",
			"y\n141 0\n",
		),
	] {
		let (stdout, stderr) = run(script);
		assert_eq!(stdout, want, "{script}: stderr {stderr:?}");
	}
}

/// End of file waits for every holder of the write end: the stage's own
/// shell code after its first external ended.
#[test]
fn end_of_file_waits_for_every_writer() {
	let script = "{ \"$OB\" -c 'echo x'; echo y; } | \"$OB\" -c \"$COPY\"; echo after";
	let (stdout, stderr) = run(script);
	assert_eq!(stdout, "x\ny\nafter\n", "{script}: stderr {stderr:?}");
}
