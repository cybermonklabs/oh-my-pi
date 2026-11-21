//! Pipelines of obash compared with bash 5.2 and zsh 5.9 run as processes.
//!
//! bash and zsh give two external stages one kernel pipe. obash joined every
//! pair of stages with an in-memory pipe and pumped each external's end
//! through its own process, so when obash died, the stage before lost its
//! reader and the stage after read end of file. A pipe between stages now
//! becomes an OS pipe once an external takes one of its ends (Linux), and a
//! stage of shell code reads and writes that pipe itself.
//!
//! Each case runs its script under obash (`bash -c` or `zsh -f -c` by
//! `argv[0]`) and under the real shell where this machine has it
//! (`PI_TEST_REAL_BASH` or `/bin/bash`, 5.2 or later; `PI_TEST_REAL_ZSH` or
//! `/bin/zsh`, 5.9), and both must print the case's output. Without the real
//! shell the case is compared with the output those shells give, measured
//! with bash 5.2.21 and zsh 5.9, and prints `UNCOMPARED:`.
//!
//! A signal is sent to the shell's pid alone, once every stage of the
//! pipeline runs (each makes a file first). A stage that outlives the shell
//! writes only once the shell is a zombie or gone, so what it writes can reach
//! the output only through a pipe the shell does not hold. The run's output is
//! read to its end, which comes once every process holding it has ended.

#![cfg(unix)]

use std::{
	os::unix::process::{CommandExt, ExitStatusExt},
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
	Exit(i32),
	Signal(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dialect {
	Bash,
	Zsh,
}

impl Dialect {
	const fn name(self) -> &'static str {
		match self {
			Self::Bash => "bash",
			Self::Zsh => "zsh",
		}
	}

	const fn flags(self) -> &'static [&'static str] {
		match self {
			Self::Bash => &["-c"],
			Self::Zsh => &["-f", "-c"],
		}
	}
}

/// The signals a case sends, at their defaults in every run whatever the test
/// runner's are.
const SENT: [libc::c_int; 4] = [libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGPIPE];

/// A stage that makes `$F`, waits until the shell (its `$$`, as `$1`) is a
/// zombie or gone, then prints `child-done`. This and the next three are
/// Linux's: they read `/proc`, and only Linux shares the pipe.
#[cfg(target_os = "linux")]
const CHILD: &str = "/bin/sh -c ': > \"$F\"; while read -r x1 x2 st x4 < /proc/$1/stat && [ \
                     \"$st\" != Z ]; do sleep 0.05; done; echo child-done' sh $$";

/// The same, printing `late`: a background holder of a pipe's write end.
#[cfg(target_os = "linux")]
const LATE: &str = "/bin/sh -c ': > \"$F\"; while read -r x1 x2 st x4 < /proc/$1/stat && [ \
                    \"$st\" != Z ]; do sleep 0.05; done; echo late' sh $$";

/// `cat`, once it has made `$F.cat`.
#[cfg(target_os = "linux")]
const CAT: &str = "/bin/sh -c ': > \"$F.cat\"; exec cat'";

/// Two external stages print the pipe their stdout and stdin are
/// (`/proc/PID/fd`, read in a command substitution because dash opens a
/// simple command's redirections in its own process), and the script says
/// whether they are one pipe.
#[cfg(target_os = "linux")]
const ONE_PIPE: &str = "w=$(/bin/mktemp -d); /bin/sh -c 'x=$(readlink /proc/$$/fd/1); printf \
                        \"%s\\n\" \"$x\" > \"$1/w\"' sh \"$w\" | /bin/sh -c 'x=$(readlink \
                        /proc/$$/fd/0); printf \"%s\\n\" \"$x\" > \"$1/r\"' sh \"$w\"; if [ \
                        \"$(/bin/cat \"$w/w\")\" = \"$(/bin/cat \"$w/r\")\" ]; then echo \
                        one-pipe; else echo two-pipes; fi; /bin/rm -rf \"$w\"";

/// The real shell of `dialect`, or why there is none to compare with.
fn real(dialect: Dialect) -> Result<PathBuf, String> {
	let (var, default, accept): (&str, &str, fn(&str) -> bool) = match dialect {
		Dialect::Bash => ("PI_TEST_REAL_BASH", "/bin/bash", |v| {
			v.split("version ")
				.nth(1)
				.and_then(|rest| {
					let mut parts = rest.split(['.', '(']);
					Some((parts.next()?.parse::<u32>().ok()?, parts.next()?.parse::<u32>().ok()?))
				})
				.is_some_and(|version| version >= (5, 2))
		}),
		Dialect::Zsh => ("PI_TEST_REAL_ZSH", "/bin/zsh", |v| v.starts_with("zsh 5.9")),
	};
	let path = std::env::var_os(var)
		.filter(|p| !p.is_empty())
		.map_or_else(|| PathBuf::from(default), PathBuf::from);
	let out = Command::new(&path)
		.arg("--version")
		.output()
		.map_err(|e| format!("{}: {e}", path.display()))?;
	let line = String::from_utf8_lossy(&out.stdout)
		.lines()
		.next()
		.unwrap_or_default()
		.to_owned();
	if accept(&line) {
		Ok(path)
	} else {
		Err(format!("{} is not the shell the cases were measured with ({line})", path.display()))
	}
}

/// One run of `script` by `program` as `dialect`, signalled with `signal`
/// once every stage runs: its stdout and how it ended.
fn run(
	program: &Path,
	dialect: Dialect,
	script: &str,
	signal: Option<libc::c_int>,
) -> (Vec<u8>, End) {
	let dir = tempfile::tempdir().expect("a directory for the stages' files");
	let started = dir.path().join("F");
	let cat = started.with_extension("cat");
	let mut cmd = Command::new(program);
	cmd.arg0(dialect.name())
		.args(dialect.flags())
		.arg(script)
		.env("F", &started)
		.env_remove("ZDOTDIR")
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	// SAFETY: signal is async-signal-safe, changes only the child and
	// allocates nothing.
	unsafe {
		cmd.pre_exec(|| {
			for sig in SENT {
				libc::signal(sig, libc::SIG_DFL);
			}
			Ok(())
		});
	}
	let mut child = cmd.spawn().expect("start the shell");
	if let Some(signal) = signal {
		let wait_cat = script.contains("$F.cat");
		while !(started.exists() && (!wait_cat || cat.exists())) {
			if let Some(status) = child.try_wait().expect("look at the shell") {
				let out = child.wait_with_output().expect("read the shell's output");
				panic!("{script}: the shell ended ({status}) before its stages ran: {out:?}");
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
		let pid = libc::pid_t::try_from(child.id()).expect("a pid");
		// SAFETY: kill takes integer ids; the child is not reaped yet.
		assert_eq!(unsafe { libc::kill(pid, signal) }, 0, "signal the shell");
	}
	let out = child.wait_with_output().expect("wait for the shell");
	let end = out
		.status
		.code()
		.map_or_else(|| End::Signal(out.status.signal().unwrap_or(0)), End::Exit);
	(out.stdout, end)
}

struct Case {
	dialect: Dialect,
	script:  String,
	signal:  Option<libc::c_int>,
	stdout:  &'static str,
	/// How the shell ends, where obash and the real shell must agree; `None`
	/// where only the output is this file's to compare (zsh's exit status
	/// after a `HUP` follows its own signal rules, not the pipe's).
	end:     Option<End>,
}

impl Case {
	fn new(dialect: Dialect, script: impl Into<String>, stdout: &'static str) -> Self {
		Self { dialect, script: script.into(), signal: None, stdout, end: Some(End::Exit(0)) }
	}

	#[cfg(target_os = "linux")]
	const fn signalled(mut self, signal: libc::c_int, end: Option<End>) -> Self {
		self.signal = Some(signal);
		self.end = end;
		self
	}
}

/// Every case under obash and under the real shell where there is one.
fn check(test: &str, cases: &[Case]) {
	let obash = PathBuf::from(env!("CARGO_BIN_EXE_obash"));
	for case in cases {
		let real = real(case.dialect);
		if let Err(why) = &real {
			println!("UNCOMPARED: {test}: {why}");
		}
		let shells = std::iter::once(("obash", Ok(obash.clone())))
			.chain(std::iter::once(("the real shell", real)));
		for (who, program) in shells {
			let Ok(program) = program else { continue };
			let (stdout, end) = run(&program, case.dialect, &case.script, case.signal);
			assert_eq!(
				String::from_utf8_lossy(&stdout),
				case.stdout,
				"{who} ({}): {}",
				case.dialect.name(),
				case.script
			);
			if let Some(want) = case.end {
				assert_eq!(end, want, "{who} ({}): {}", case.dialect.name(), case.script);
			}
		}
	}
}

/// `CHILD | cat` outlives the shell's death, by an uncaught `TERM` (bash),
/// by `HUP` (zsh) and by `KILL`: the stages share one kernel pipe, so what
/// CHILD writes after the shell is gone still reaches `cat`. A background
/// holder of the write end keeps the pipe open the same way.
#[cfg(target_os = "linux")]
#[test]
fn external_stages_outlive_the_shell() {
	use Dialect::{Bash, Zsh};
	check("external_stages_outlive_the_shell", &[
		Case::new(Bash, format!("{CHILD} | {CAT}; echo after"), "child-done\n")
			.signalled(libc::SIGTERM, Some(End::Signal(libc::SIGTERM))),
		Case::new(Bash, format!("{CHILD} | {CAT}"), "child-done\n")
			.signalled(libc::SIGKILL, Some(End::Signal(libc::SIGKILL))),
		Case::new(Zsh, format!("{CHILD} | {CAT}; print after"), "child-done\n")
			.signalled(libc::SIGHUP, None),
		Case::new(Zsh, format!("{CHILD} | {CAT}"), "child-done\n")
			.signalled(libc::SIGKILL, Some(End::Signal(libc::SIGKILL))),
		Case::new(Bash, format!("{{ echo early; {LATE} & }} | {CAT}"), "early\nlate\n")
			.signalled(libc::SIGKILL, Some(End::Signal(libc::SIGKILL))),
	]);
}

/// The control: two external stages see one pipe, as in bash and zsh. On the
/// pumped path each external had a pipe of its own to the shell, and this
/// prints `two-pipes`.
#[cfg(target_os = "linux")]
#[test]
fn two_external_stages_are_one_pipe() {
	check("two_external_stages_are_one_pipe", &[
		Case::new(Dialect::Bash, ONE_PIPE, "one-pipe\n"),
		Case::new(Dialect::Zsh, ONE_PIPE, "one-pipe\n"),
	]);
}

/// With no `/proc` mounted the shell cannot open its own ends of an OS pipe,
/// so the pipe between stages stays in memory, pumped, and a stage of shell
/// code between two externals still gets every byte. `/proc` is hidden in a
/// user and mount namespace; where `unshare` cannot make one, the test prints
/// `skipped:` and checks nothing.
#[cfg(target_os = "linux")]
#[test]
fn shell_code_stages_without_proc() {
	let hide = "mount -t tmpfs none /proc && exec \"$0\" -c \"$1\"";
	let probe = Command::new("unshare")
		.args(["-rm", "sh", "-c", "mount -t tmpfs none /proc && test ! -e /proc/self", "-"])
		.output();
	match probe {
		Ok(out) if out.status.success() => {},
		other => {
			println!("skipped: no user and mount namespace to hide /proc: {other:?}");
			return;
		},
	}
	let script = "/usr/bin/printf 'a\\nb\\n' | while read -r l; do echo \"got $l\"; done | /bin/cat";
	let out = Command::new("unshare")
		.args(["-rm", "sh", "-c", hide, env!("CARGO_BIN_EXE_obash"), script])
		.stdin(Stdio::null())
		.output()
		.expect("run obash with /proc hidden");
	assert_eq!(
		(
			out.status.code(),
			String::from_utf8_lossy(&out.stdout),
			String::from_utf8_lossy(&out.stderr)
		),
		(Some(0), "got a\ngot b\n".into(), "".into()),
		"obash with /proc hidden: status, stdout, stderr"
	);
}

/// A stage of shell code between externals reads and writes the OS pipe
/// itself: the output and every stage's status are bash's and zsh's, a line
/// `read` takes leaves the rest to the external after it, more than a pipe's
/// capacity crosses in each direction, and a writer whose reader left gets
/// `SIGPIPE` (141).
#[test]
fn shell_code_stages_between_externals() {
	use Dialect::{Bash, Zsh};
	check("shell_code_stages_between_externals", &[
		Case::new(
			Bash,
			"/usr/bin/printf 'a\\nb\\nc\\n' | while read -r l; do echo \"got $l\"; done | /bin/cat; \
			 echo \"${PIPESTATUS[*]}\"",
			"got a\ngot b\ngot c\n0 0 0\n",
		),
		Case::new(
			Bash,
			"f() { while read -r l; do echo \"f:$l\"; done; return 3; }; /usr/bin/printf 'x\\ny\\n' \
			 | f | /bin/cat; echo \"${PIPESTATUS[*]}\"",
			"f:x\nf:y\n0 3 0\n",
		),
		Case::new(
			Bash,
			"/usr/bin/printf 'one\\ntwo\\nthree\\n' | { read -r a; echo \"a=$a\"; /bin/cat; }",
			"a=one\ntwo\nthree\n",
		),
		Case::new(
			Bash,
			"i=0; while [ $i -lt 20000 ]; do echo \"line $i\"; i=$((i + 1)); done | /usr/bin/awk \
			 'END { print NR }'",
			"20000\n",
		),
		Case::new(
			Bash,
			"/usr/bin/seq 1 20000 | { n=0; while read -r l; do n=$((n + 1)); done; echo $n; }",
			"20000\n",
		),
		Case::new(
			Bash,
			"/bin/sh -c 'echo x; exit 3' | { /bin/cat; exit 4; } | /bin/sh -c 'cat; exit 5'; echo \
			 \"${PIPESTATUS[*]}\"",
			"x\n3 4 5\n",
		),
		Case::new(
			Bash,
			"while :; do echo y; done | /usr/bin/head -n 1; echo \"${PIPESTATUS[*]}\"",
			"y\n141 0\n",
		),
		Case::new(
			Bash,
			"/usr/bin/yes | /usr/bin/head -n 2; echo \"${PIPESTATUS[*]}\"",
			"y\ny\n141 0\n",
		),
		Case::new(
			Zsh,
			"/usr/bin/printf 'a\\nb\\n' | while read l; do print \"got $l\"; done | /bin/cat; print \
			 $pipestatus",
			"got a\ngot b\n0 0 0\n",
		),
	]);
}

/// End of file waits for every holder of the write end: a background
/// external, and the stage's own shell code after its first external ended.
#[test]
fn end_of_file_waits_for_every_writer() {
	use Dialect::Bash;
	check("end_of_file_waits_for_every_writer", &[
		Case::new(
			Bash,
			// The background writer waits for the file the other stage makes
			// after it wrote `early` (`$F`, a path in a fresh directory), so
			// the order does not depend on how fast either one starts. The
			// wait gives up after 3000 rounds, and the order is then wrong.
			"{ /bin/sh -c 'i=0; while [ ! -e \"$F\" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i + \
			 1)); done; echo late' & /bin/sh -c 'echo early; : > \"$F\"'; } | /bin/cat; echo after",
			"early\nlate\nafter\n",
		),
		Case::new(
			Bash,
			"{ /bin/echo x; /bin/sleep 0.2; echo y; } | /bin/cat; echo after",
			"x\ny\nafter\n",
		),
	]);
}

/// Two vprocs of shell code write to one shared pipe end while a slow
/// external reads it, so the pipe fills over and over and the two writers
/// park and resume on the one engine waker. A wait one writer's progress drops
/// without a wake leaves the other parked for good: the run hangs and the
/// harness's bound reports it. The reader is `sh`'s `read`, which takes the
/// pipe a byte at a time.
#[test]
fn two_shell_code_writers_share_one_end() {
	check("two_shell_code_writers_share_one_end", &[Case::new(
		Dialect::Bash,
		"big=$(printf '%0600d' 0); w() { i=0; while [ $i -lt 300 ]; do echo \"$1$big\"; i=$((i + \
		 1)); done; }; { w a & w b; wait; } | /bin/sh -c 'n=0; while IFS= read -r l; do n=$((n + \
		 1)); done; echo $n'",
		"600\n",
	)]);
}
