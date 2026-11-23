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
//!
//! A run that has not ended after [`RUN_BOUND`] fails, naming the processes
//! of its shell's group that still run, and they are killed: `cargo test`
//! puts no bound on a test, and a regression here hangs.

#![cfg(unix)]

use std::{
	io::Read,
	os::unix::process::{CommandExt, ExitStatusExt},
	path::{Path, PathBuf},
	process::{Child, Command, Output, Stdio},
	time::{Duration, Instant},
};

/// How long one run may take before it fails as a hang. The longest correct
/// run measured took 6.33 s: the byte-at-a-time reader of
/// `a_shell_code_writer_into_a_byte_at_a_time_reader_uses_no_more_cpu_than_into_cat`,
/// under gVisor in a pod limited to 1952m CPU (`nproc` 2); the bound is more
/// than twice that. nextest's `ci` profile ends a whole test at 240 s, and
/// this ends one run first, naming what is stuck.
const RUN_BOUND: Duration = Duration::from_secs(60);

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
	cmd.process_group(0);
	let mut child = cmd.spawn().expect("start the shell");
	if let Some(signal) = signal {
		let wait_cat = script.contains("$F.cat");
		while !(started.exists() && (!wait_cat || cat.exists())) {
			if let Some(status) = child.try_wait().expect("look at the shell") {
				let out = child.wait_with_output().expect("read the shell's output");
				panic!("{script}: the shell ended ({status}) before its stages ran: {out:?}");
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		let pid = libc::pid_t::try_from(child.id()).expect("a pid");
		// SAFETY: kill takes integer ids; the child is not reaped yet.
		assert_eq!(unsafe { libc::kill(pid, signal) }, 0, "signal the shell");
	}
	let out = finish(child, script, |_| {});
	let end = out
		.status
		.code()
		.map_or_else(|| End::Signal(out.status.signal().unwrap_or(0)), End::Exit);
	(out.stdout, end)
}

/// Wait for `child` (spawned as a process group of its own, stdout and
/// stderr piped) to end and for its output to end, calling `tick` with its
/// pid about every 10 ms while it runs, and once more when it has ended but
/// is not reaped yet (its `/proc/PID/stat` then holds all of its CPU time).
/// Past [`RUN_BOUND`] the run fails: the message names the processes of the
/// child's group that still run (`ps`), and the group is killed.
fn finish(mut child: Child, script: &str, mut tick: impl FnMut(libc::pid_t)) -> Output {
	let pid = libc::pid_t::try_from(child.id()).expect("a pid");
	let drain = |r: Option<Box<dyn Read + Send>>| {
		std::thread::spawn(move || {
			let mut all = Vec::new();
			if let Some(mut r) = r {
				r.read_to_end(&mut all).expect("read the run's output");
			}
			all
		})
	};
	let stdout = drain(
		child
			.stdout
			.take()
			.map(|r| Box::new(r) as Box<dyn Read + Send>),
	);
	let stderr = drain(
		child
			.stderr
			.take()
			.map(|r| Box::new(r) as Box<dyn Read + Send>),
	);
	let deadline = Instant::now() + RUN_BOUND;
	let mut status = None;
	while status.is_none() || !stdout.is_finished() || !stderr.is_finished() {
		if status.is_none() {
			// Ended? Without reaping it (`WNOWAIT`), so `tick` still reads it.
			// SAFETY: a zeroed siginfo filled by waitid for our own child.
			let ended = unsafe {
				let mut info: libc::siginfo_t = std::mem::zeroed();
				libc::waitid(
					libc::P_PID,
					libc::id_t::try_from(pid).expect("a pid"),
					&raw mut info,
					libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
				) == 0
					&& info.si_pid() != 0
			};
			tick(pid);
			if ended {
				status = Some(child.wait().expect("reap the shell"));
			}
		}
		if Instant::now() >= deadline {
			let group = pid.to_string();
			let left = Command::new("ps")
				.args(["-A", "-o", "pgid=,pid=,ppid=,stat=,args="])
				.output()
				.map_or_else(
					|e| format!("(ps: {e})"),
					|o| {
						String::from_utf8_lossy(&o.stdout)
							.lines()
							.filter(|l| l.split_whitespace().next() == Some(group.as_str()))
							.fold(String::new(), |all, l| all + l + "\n")
					},
				);
			// SAFETY: kill takes integer ids; the group is the run's own.
			unsafe { libc::kill(-pid, libc::SIGKILL) };
			let _ = child.wait();
			panic!(
				"{script}: still running after {RUN_BOUND:?} (shell {pid}, ended: {status:?}); its \
				 group:\n{left}"
			);
		}
		std::thread::sleep(Duration::from_millis(10));
	}
	Output {
		status: status.expect("ended"),
		stdout: stdout.join().expect("the output reader"),
		stderr: stderr.join().expect("the error reader"),
	}
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
/// park and resume on the one engine waker. This is coverage of two writers
/// on one shared end; the regression test of a wait one writer's progress
/// drops is `sys::stage_pipe`'s
/// `a_vproc_that_writes_keeps_the_wait_of_another_vproc_with_its_waker`,
/// which is deterministic where this needs a race (b73c49b0's code passed
/// it 10 of 10 on runc and hung once in 10 on gVisor). A hang fails at
/// [`RUN_BOUND`], naming what still runs. The reader is `sh`'s `read`, which
/// takes the pipe a byte at a time.
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

/// obash running `script` as bash: its output, its own CPU time (user and
/// system, all its threads, from `/proc/PID/stat`, read until it ends) and
/// the run's wall time, in seconds, and the most write threads of shared pipe
/// ends (`obash-room`) it had at once.
#[cfg(target_os = "linux")]
fn cpu_of(script: &str) -> (Output, f64, f64, usize) {
	// SAFETY: sysconf only reads.
	let tick = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
	let started = Instant::now();
	let mut cmd = Command::new(env!("CARGO_BIN_EXE_obash"));
	cmd.arg0("bash")
		.args(["-c", script])
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.process_group(0);
	let child = cmd.spawn().expect("start obash");
	// obash's own user and system time so far, in ticks (fields 14 and 15).
	let mut used = 0u64;
	let mut rooms = 0;
	let out = finish(child, script, |pid| {
		rooms = rooms.max(room_threads(u32::try_from(pid).expect("a pid")));
		if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
			let fields: Vec<&str> = stat
				.rsplit_once(')')
				.map_or(Vec::new(), |(_, rest)| rest.split_whitespace().collect());
			if let (Some(u), Some(s)) = (fields.get(11), fields.get(12)) {
				used = u.parse::<u64>().unwrap_or(0) + s.parse::<u64>().unwrap_or(0);
			}
		}
	});
	(out, used as f64 / tick, started.elapsed().as_secs_f64(), rooms)
}

/// A shell-code writer that waits on a full shared pipe uses no CPU while it
/// waits: 100 lines of 3001 bytes into a reader that takes one line, then
/// sleeps 10 ms. obash's own CPU time must stay under a quarter of the run's
/// wall time. gVisor polls a pipe writable whenever any byte fits, while a
/// write of at most `PIPE_BUF` bytes needs room for all of it; a writer that
/// waited for the first spun 70 to 90 % of a CPU there. On the Linux
/// kernel's pipes it never did.
#[cfg(target_os = "linux")]
#[test]
fn a_shell_code_writer_waiting_on_a_full_pipe_uses_no_cpu() {
	let script = "l=$(printf '%03000d' 0); i=0; while [ $i -lt 100 ]; do echo \"$l\"; i=$((i + \
	              1)); done | /bin/sh -c 'i=0; while [ $i -lt 100 ]; do /usr/bin/head -c 3001 > \
	              /dev/null; /bin/sleep 0.01; i=$((i + 1)); done; echo read'";
	let (out, cpu, wall, _) = cpu_of(script);
	assert_eq!(
		(out.status.code(), String::from_utf8_lossy(&out.stdout)),
		(Some(0), "read\n".into()),
		"{script}: {out:?}"
	);
	println!("obash CPU {cpu:.2} s over {wall:.2} s");
	assert!(wall >= 1.0, "the reader sleeps 100 x 10 ms, so the run takes 1 s: {wall:.2} s");
	assert!(cpu <= wall / 4.0, "obash used {cpu:.2} s of CPU over {wall:.2} s while it waited");
}

/// A write end whose write waited uses no CPU while it then stays open and
/// idle: one `printf` of 100 KB, made once the reader runs (so the pipe is
/// already shared), waits on a reader that starts reading after 0.5 s, is
/// made by the end's thread, and the end then idles for 2 s while `sleep`
/// runs. The thread waits for its next write without polling for it: one that
/// polled cost a CPU for those 2 s (the review measured 1.97 to 2.00 s). The
/// run must have made the thread, or it shows nothing.
#[cfg(target_os = "linux")]
#[test]
fn a_write_end_whose_write_waited_uses_no_cpu_while_it_idles() {
	let script = "{ /bin/sleep 0.2; printf '%0100000d\\n' 0; /bin/sleep 2; } | /bin/sh -c \
	              '/bin/sleep 0.5; cat > /dev/null; echo idle'";
	let (out, cpu, wall, rooms) = cpu_of(script);
	assert_eq!(
		(out.status.code(), String::from_utf8_lossy(&out.stdout)),
		(Some(0), "idle\n".into()),
		"{script}: {out:?}"
	);
	println!("obash CPU {cpu:.2} s over {wall:.2} s, {rooms} write thread(s)");
	assert!(rooms >= 1, "the write did not wait, so no write thread was made: {script}");
	assert!(wall >= 2.2, "the end idles for 2 s: {wall:.2} s");
	assert!(
		cpu <= (wall / 10.0).max(0.25),
		"obash used {cpu:.2} s of CPU over {wall:.2} s, 2 s of it with its end idle"
	);
}

/// A shell-code writer into a reader that takes the pipe a byte at a time
/// (`sh`'s `read`) uses no more CPU than into `cat`, which takes it in large
/// reads: what obash spends on its own shell code is the same either way, and
/// only waiting differs. Each byte `read` takes frees one byte of room, which
/// under gVisor is one edge, and a writer whose wait was checked on each one
/// cost obash close to a CPU for the whole run (the review measured 3.04 to
/// 3.68 s over 3.45 to 4.09 s for 1000 lines of 1000 bytes, and bash 0.00 to
/// 0.01 s for 3000 lines of 200 bytes): a cost per byte read. A write handed
/// to the end's thread costs a few system calls and two thread switches per
/// write instead, so the writers here make few, large writes over 1 MB: one
/// `echo` per 4000-byte line, each a write of at most `PIPE_BUF` bytes, which
/// needs room for all of it; and one `printf`, whose larger writes take what
/// fits. The allowance (a tenth of the run's wall time, 0.25 s at least)
/// leaves room for that cost on a loaded machine.
#[cfg(target_os = "linux")]
#[test]
fn a_shell_code_writer_into_a_byte_at_a_time_reader_uses_no_more_cpu_than_into_cat() {
	let writers = [
		(
			"l=$(printf '%03999d' 0); i=0; while [ $i -lt 250 ]; do echo \"$l\"; i=$((i + 1)); done",
			"250",
		),
		("printf '%03999d\\n' $(/usr/bin/seq 250)", "250"),
	];
	for (writer, lines) in writers {
		let bytes =
			format!("{writer} | /bin/sh -c 'n=0; while read -r x; do n=$((n + 1)); done; echo $n'");
		let cat = format!("{writer} | /bin/sh -c 'cat > /dev/null; echo {lines}'");
		let mut cpu = [0.0; 2];
		let mut wall = 0.0;
		for (i, script) in [&bytes, &cat].into_iter().enumerate() {
			let (out, used, took, _) = cpu_of(script);
			assert_eq!(
				(out.status.code(), String::from_utf8_lossy(&out.stdout)),
				(Some(0), format!("{lines}\n").into()),
				"{script}: {out:?}"
			);
			cpu[i] = used;
			if i == 0 {
				wall = took;
			}
		}
		println!(
			"obash CPU {:.2} s over {wall:.2} s into read, {:.2} s into cat: {writer}",
			cpu[0], cpu[1]
		);
		assert!(
			cpu[0] - cpu[1] <= (wall / 10.0).max(0.25),
			"obash used {:.2} s of CPU over {wall:.2} s into a byte-at-a-time reader, {:.2} s into \
			 cat: {writer}",
			cpu[0],
			cpu[1]
		);
	}
}

/// The threads of process `pid` named `obash-room`: the threads that make a
/// shared pipe's writes that would wait.
#[cfg(target_os = "linux")]
fn room_threads(pid: u32) -> usize {
	std::fs::read_dir(format!("/proc/{pid}/task")).map_or(0, |tasks| {
		tasks
			.filter_map(Result::ok)
			.filter(|t| {
				std::fs::read_to_string(t.path().join("comm"))
					.is_ok_and(|c| c.trim_end() == "obash-room")
			})
			.count()
	})
}

/// Wait up to [`RUN_BOUND`] for `done`, failing with `what`.
#[cfg(target_os = "linux")]
fn until(what: &str, mut done: impl FnMut() -> bool) {
	let deadline = Instant::now() + RUN_BOUND;
	while !done() {
		assert!(Instant::now() < deadline, "{what}: not within {RUN_BOUND:?}");
		std::thread::sleep(Duration::from_millis(10));
	}
}

/// A `CHLD` trap owed while a stage of shell code's write waits on a full
/// shared pipe runs after the write, as bash 5.2/5.3 and zsh 5.9 run it: the
/// reader gets the 262,144 '0's, then the trap's 10 'T's. The write is four
/// times what the end's thread takes at once (64 KiB), so a trap that ran
/// before the write ended would put its bytes between two of the write's.
/// Failure modes (the review of #111 at 483c9ea5, through this PR's room): the
/// trap started while the write waited and wrote under the same key, so its
/// write took the waiting write's result and the room made that write again
/// (more '0's and no 'T'); or, under a key of its own, its 'T's came in the
/// middle of the '0's. The test checks the write waits on the end's thread
/// when the trap is owed (else it shows nothing).
#[cfg(target_os = "linux")]
#[test]
fn a_chld_trap_owed_during_a_write_through_a_pipe_runs_after_it() {
	let dir = tempfile::tempdir().expect("a directory for the markers");
	let f = dir.path().join("F");
	let mark = |ext: &str| f.with_extension(ext);
	let script = "{ trap 'printf %s TTTTTTTTTT' CHLD
	                { while [ ! -e \"$F.go\" ]; do :; done; : > \"$F.done\"; } &
	                printf %0262144d 0
	                s=$?; wait; exit $s; } | /bin/sh -c 'while [ ! -e \"$F.read\" ]; do sleep 0.01; \
	              done; exec cat'";
	let mut child = Command::new(env!("CARGO_BIN_EXE_obash"))
		.arg0("bash")
		.args(["-c", script])
		.env("F", &f)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.process_group(0)
		.spawn()
		.expect("start obash");
	let pid = child.id();
	// Kill the run's group on any failure below, so no stage outlives the test.
	struct Group(i32);
	impl Drop for Group {
		fn drop(&mut self) {
			// SAFETY: kill takes integer ids; the group is the run's own.
			unsafe { libc::kill(-self.0, libc::SIGKILL) };
		}
	}
	let _group = Group(i32::try_from(pid).expect("a pid"));
	let mut out = child.stdout.take().expect("stdout");
	let reader = std::thread::spawn(move || {
		let mut got = Vec::new();
		let _ = out.read_to_end(&mut got);
		got
	});
	until("printf's write waits on the end's thread", || room_threads(pid) == 1);
	std::fs::write(mark("go"), "").unwrap();
	until("the background job ended", || mark("done").exists());
	// The job's end owes the trap at once (both are the one shell's).
	std::thread::sleep(Duration::from_millis(300));
	assert_eq!(room_threads(pid), 1, "printf's write still waits when the trap is owed");
	std::fs::write(mark("read"), "").unwrap();
	until("obash ended", || child.try_wait().is_ok_and(|s| s.is_some()));
	let mut err = String::new();
	if let Some(mut e) = child.stderr.take() {
		let _ = e.read_to_string(&mut err);
	}
	assert_eq!(child.wait().expect("reap obash").code(), Some(0), "{err}");
	let got = reader.join().expect("the reader");
	let mut counts = [0usize; 256];
	for &b in &got {
		counts[usize::from(b)] += 1;
	}
	assert_eq!(
		(
			counts[usize::from(b'0')],
			counts[usize::from(b'T')],
			got.len(),
			got.iter().position(|&b| b == b'T')
		),
		(262_144, 10, 262_154, Some(262_144)),
		"('0's, 'T's, bytes, first 'T' at)"
	);
}

/// A writer of shell code killed while its write waits on a full pipe that
/// its reader, an external, holds but does not read: the write is the end's
/// thread's, blocked in the kernel, and nothing calls it back. The thread must
/// end once the pipe's last reader goes (its write then fails as a broken
/// pipe) instead of staying blocked for the shell's life. The test checks the
/// thread first waits (else it shows nothing), then that it ends.
#[cfg(target_os = "linux")]
#[test]
fn a_killed_writers_thread_ends_once_the_pipes_last_reader_goes() {
	let dir = tempfile::tempdir().expect("a directory for the markers");
	let f = dir.path().join("F");
	let mark = |ext: &str| f.with_extension(ext);
	let script = "( echo $BASHPID > \"$F.w\"; l=$(printf '%0999d' 0); while :; do echo \"$l\"; \
	              done ) | /bin/sh -c 'while [ ! -e \"$F.drop\" ]; do sleep 0.01; done' &
	              while [ ! -e \"$F.go\" ]; do sleep 0.01; done
	              kill \"$(cat \"$F.w\")\"
	              : > \"$F.killed\"
	              wait
	              : > \"$F.done\"
	              while [ ! -e \"$F.end\" ]; do sleep 0.01; done";
	let mut child = Command::new(env!("CARGO_BIN_EXE_obash"))
		.arg0("bash")
		.args(["-c", script])
		.env("F", &f)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.process_group(0)
		.spawn()
		.expect("start obash");
	let pid = child.id();
	// Kill the run's group on any failure below, so no stage outlives the test.
	struct Group(i32);
	impl Drop for Group {
		fn drop(&mut self) {
			// SAFETY: kill takes integer ids; the group is the run's own.
			unsafe { libc::kill(-self.0, libc::SIGKILL) };
		}
	}
	let _group = Group(i32::try_from(pid).expect("a pid"));
	until("the writer's write waits on the end's thread", || room_threads(pid) == 1);
	std::fs::write(mark("go"), "").unwrap();
	until("the writer killed", || mark("killed").exists());
	std::thread::sleep(Duration::from_millis(200));
	assert_eq!(
		room_threads(pid),
		1,
		"the killed writer's write waits in the kernel while the reader holds the pipe"
	);
	std::fs::write(mark("drop"), "").unwrap();
	until("the pipeline ended", || mark("done").exists());
	until("the thread ended once the last reader went", || room_threads(pid) == 0);
	std::fs::write(mark("end"), "").unwrap();
	until("obash ended", || child.try_wait().is_ok_and(|s| s.is_some()));
	let mut err = String::new();
	if let Some(mut e) = child.stderr.take() {
		let _ = e.read_to_string(&mut err);
	}
	assert_eq!(child.wait().expect("reap obash").code(), Some(0), "{err}");
}
