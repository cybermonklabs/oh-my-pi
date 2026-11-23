//! Run obash, bash and zsh as processes and compare how they end: the
//! signals they start with, their core size limit, the real bash the
//! comparisons need ([`real_bash`], [`real_bash_golden`]), and a signal sent
//! from outside once the command a shell waits for has started
//! ([`Run::go_signalled`]).
//!
//! A run's processes end with the test, however it ends: on Linux each
//! shell dies with the thread that started it (`PR_SET_PDEATHSIG`); a
//! signalled run's shell is killed (its process group, in a group of its
//! own) if the test panics before it ended ([`Reaper`]); and what it runs
//! waits for the signal on a pipe only the test writes ([`GATE_FD`]), which
//! the kernel closes when the test ends.

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::{OsStr, OsString},
	fmt,
	os::{
		fd::{AsRawFd, RawFd},
		unix::process::{CommandExt, ExitStatusExt},
	},
	path::{Path, PathBuf},
	process::{Child, Command, ExitStatus, Stdio},
	time::{Duration, Instant},
};

use crate::{
	pty_support::{every_signal_at_its_default, wait_blocked},
	zsh_oracle,
};

/// What a shell run gave.
#[derive(Clone, PartialEq, Eq)]
pub struct Outcome {
	pub stdout: Vec<u8>,
	pub stderr: Vec<u8>,
	/// The exit status; `None` when a signal ended the shell.
	pub code:   Option<i32>,
	/// The signal that ended the shell.
	pub signal: Option<i32>,
	/// Whether it dumped a core.
	pub core:   bool,
}

impl fmt::Debug for Outcome {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Outcome")
			.field("stdout", &String::from_utf8_lossy(&self.stdout))
			.field("stderr", &String::from_utf8_lossy(&self.stderr))
			.field("code", &self.code)
			.field("signal", &self.signal)
			.field("core", &self.core)
			.finish()
	}
}

impl Outcome {
	/// How the run ended.
	#[must_use]
	pub const fn end(&self) -> Option<End> {
		match (self.code, self.signal) {
			(Some(code), _) => Some(End::Exit(code)),
			(None, Some(sig)) => Some(End::Signal(sig)),
			(None, None) => None,
		}
	}
}

/// How a shell run ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
	/// An exit with this status.
	Exit(i32),
	/// Death by this signal.
	Signal(i32),
}

/// The fd on which a signalled run's shell, and all it starts, reads the
/// gate ([`Run::go_signalled`]): a pipe whose only write end the test holds
/// (close-on-exec), closed once the signal is sent, or by the kernel when
/// the test ends. `read -r x <&9` waits for it. Not 3, which rows use
/// (`exec 3>&1`).
pub const GATE_FD: RawFd = 9;

/// How long [`Run::go_signalled`] waits for the command to make its start
/// file before it kills the shell and fails.
const START_LIMIT: Duration = Duration::from_secs(60);

/// One run of a shell: `program` named `name` (`argv[0]`; through a link
/// named so under a wrapper, which runs it by its path), with `ZDOTDIR`
/// unset, every signal at its default ([`every_signal_at_its_default`]) and a
/// core size limit of 1 byte on entry, unless set otherwise. A pipe
/// `core_pattern` (systemd-coredump, apport) ignores a limit of 0 and dumps
/// anyway (the kernel's `fs/coredump.c` refuses a pipe dump only at 1), and a
/// file dump needs more than 1 byte: no command a run starts dumps a core.
pub struct Run {
	program:   PathBuf,
	name:      &'static str,
	args:      Vec<OsString>,
	ignored:   Vec<libc::c_int>,
	cores:     bool,
	dir:       Option<PathBuf>,
	wrap:      Vec<&'static str>,
	env:       Vec<(&'static str, Option<OsString>)>,
	/// In a process group of its own (so a signal can go to the group).
	group:     bool,
	/// [`Self::go_signalled`] kills what the shell left in its group once it
	/// has ended ([`Self::ending_its_group`]).
	end_group: bool,
	/// [`Self::go_signalled`] signals only once the shell has blocked
	/// ([`Self::when_blocked`]).
	blocked:   bool,
	/// The file its standard input reads ([`Self::input`]); else the test's.
	input:     Option<PathBuf>,
}

impl Run {
	pub fn new(program: impl AsRef<OsStr>, name: &'static str, args: &[impl AsRef<OsStr>]) -> Self {
		Self {
			program: absolute(Path::new(program.as_ref())),
			name,
			args: args.iter().map(|a| a.as_ref().to_owned()).collect(),
			ignored: Vec::new(),
			cores: false,
			dir: None,
			wrap: Vec::new(),
			env: Vec::new(),
			group: false,
			end_group: false,
			blocked: false,
			input: None,
		}
	}

	/// obash as `name`.
	pub fn obash(name: &'static str, args: &[impl AsRef<OsStr>]) -> Self {
		Self::new(env!("CARGO_BIN_EXE_obash"), name, args)
	}

	/// `script` as `name` runs a `-c` string: `zsh -f -c` or `bash -c`.
	pub fn script(
		program: impl AsRef<OsStr>,
		name: &'static str,
		script: impl AsRef<OsStr>,
	) -> Self {
		let flags: &[&str] = if name == "zsh" {
			&["-f", "-c"]
		} else {
			&["-c"]
		};
		let mut args: Vec<OsString> = flags.iter().map(OsString::from).collect();
		args.push(script.as_ref().to_owned());
		Self::new(program, name, &args)
	}

	/// These signals ignored on entry.
	#[must_use]
	pub fn ignoring(mut self, signals: &[libc::c_int]) -> Self {
		self.ignored.extend_from_slice(signals);
		self
	}

	/// Run in `dir`, with the core size limit raised to its hard limit.
	#[must_use]
	pub fn dumping_in(mut self, dir: &Path) -> Self {
		self.cores = true;
		self.dir = Some(dir.to_owned());
		self
	}

	/// Run under `wrap`, a command and its arguments.
	#[must_use]
	pub fn under(mut self, wrap: &[&'static str]) -> Self {
		self.wrap = wrap.to_vec();
		self
	}

	/// Set the variable `key` to `value`.
	#[must_use]
	pub fn env(mut self, key: &'static str, value: impl AsRef<OsStr>) -> Self {
		self.env.push((key, Some(value.as_ref().to_owned())));
		self
	}

	/// Unset the variable `key`.
	#[must_use]
	pub fn env_remove(mut self, key: &'static str) -> Self {
		self.env.push((key, None));
		self
	}

	/// Run in a process group of its own.
	#[must_use]
	pub const fn own_group(mut self) -> Self {
		self.group = true;
		self
	}

	/// Run in a process group of its own, which [`Self::go_signalled`] ends
	/// once the shell has: what the shell left running in it is killed then,
	/// so none of it outlives the run.
	#[must_use]
	pub const fn ending_its_group(mut self) -> Self {
		self.group = true;
		self.end_group = true;
		self
	}

	/// [`Self::go_signalled`] sends its signal only once the shell and all it
	/// runs have also blocked ([`wait_blocked`]): bash acts on a signal that
	/// comes before it blocks in `waitpid` only once the command has ended,
	/// or at once, and obash takes one it learns of before its wait began as
	/// come while it ran shell code. Not for a shell that runs shell code
	/// which never blocks (obash runs a subshell's code in its own process).
	#[must_use]
	pub const fn when_blocked(mut self) -> Self {
		self.blocked = true;
		self
	}

	/// Read standard input from the file `path`.
	#[must_use]
	pub fn input(mut self, path: &Path) -> Self {
		self.input = Some(path.to_owned());
		self
	}

	/// The command, and the directory of the shell's link it needs alive.
	fn command(&self) -> (Command, tempfile::TempDir) {
		self.command_with(None)
	}

	/// [`Self::command`], with `gate`, a pipe's read end, as the shell's fd
	/// [`GATE_FD`]. On Linux the shell dies with the thread that starts it
	/// (`PR_SET_PDEATHSIG`), so a killed test leaves no shell behind.
	fn command_with(&self, gate: Option<RawFd>) -> (Command, tempfile::TempDir) {
		let link_dir = tempfile::tempdir().expect("a directory for the shell's link");
		let mut cmd = if let Some((first, rest)) = self.wrap.split_first() {
			let link = link_dir.path().join(self.name);
			std::os::unix::fs::symlink(&self.program, &link).expect("link the shell");
			let mut cmd = Command::new(first);
			cmd.args(rest).arg(link);
			cmd
		} else {
			let mut cmd = Command::new(&self.program);
			cmd.arg0(self.name);
			cmd
		};
		cmd.args(&self.args).env_remove("ZDOTDIR");
		if let Some(path) = &self.input {
			cmd.stdin(std::fs::File::open(path).expect("open the shell's input"));
		}
		for (key, value) in &self.env {
			match value {
				Some(value) => cmd.env(key, value),
				None => cmd.env_remove(key),
			};
		}
		if let Some(dir) = &self.dir {
			cmd.current_dir(dir);
		}
		let (ignored, cores, group) = (self.ignored.clone(), self.cores, self.group);
		#[cfg(target_os = "linux")]
		let test = libc::pid_t::try_from(std::process::id()).expect("a pid");
		// SAFETY: prctl, getppid, dup2, fcntl, signal, setpgid, getrlimit and
		// setrlimit are async-signal-safe and change only the child; nothing
		// here allocates.
		unsafe {
			cmd.pre_exec(move || {
				#[cfg(target_os = "linux")]
				{
					if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
						return Err(std::io::Error::last_os_error());
					}
					// The test ended between the fork and the prctl: no signal
					// comes.
					if libc::getppid() != test {
						return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
					}
				}
				if let Some(fd) = gate {
					if libc::dup2(fd, GATE_FD) == -1 {
						return Err(std::io::Error::last_os_error());
					}
					// A `dup2` onto itself keeps the close-on-exec flag.
					if fd == GATE_FD && libc::fcntl(GATE_FD, libc::F_SETFD, 0) == -1 {
						return Err(std::io::Error::last_os_error());
					}
				}
				every_signal_at_its_default();
				for &sig in &ignored {
					libc::signal(sig, libc::SIG_IGN);
				}
				if group {
					libc::setpgid(0, 0);
				}
				let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
				if libc::getrlimit(libc::RLIMIT_CORE, &raw mut limit) == 0 {
					limit.rlim_cur = if cores {
						limit.rlim_max
					} else {
						limit.rlim_max.min(1)
					};
					libc::setrlimit(libc::RLIMIT_CORE, &raw const limit);
				}
				Ok(())
			});
		}
		(cmd, link_dir)
	}

	pub fn go(&self) -> Outcome {
		let (mut cmd, _link_dir) = self.command();
		outcome(cmd.output().expect("start the shell"))
	}

	/// Run it and send it `sig` once `started` exists (the file the command
	/// it waits for makes when it has started): to its process group when
	/// `group` ([`Self::own_group`]), else to the shell alone. Then make
	/// `started` with the extension `sent` (`$F.sent`, for shell code that
	/// must not block) and close the gate ([`GATE_FD`]), which a command
	/// waits on to go on, so the signal comes while it runs however late it
	/// is sent; and wait for the shell to end. A shell that ends before the
	/// file exists, or does not make it within [`START_LIMIT`], fails the
	/// test; so does a command that found no gate (it makes `started` with
	/// the extension `nogate`). A test that fails or is killed leaves no
	/// process of the run behind ([`Reaper`], the gate); with
	/// [`Self::ending_its_group`], neither does one that passes.
	pub fn go_signalled(&self, started: &Path, sig: libc::c_int, group: bool) -> Outcome {
		let (gate, gate_writer) = std::io::pipe().expect("a pipe for the gate");
		let (mut cmd, _link_dir) = self.command_with(Some(gate.as_raw_fd()));
		let child = cmd
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("start the shell");
		drop(gate);
		let mut child = Reaper { child: Some(child), group };
		let deadline = Instant::now() + START_LIMIT;
		while !started.exists() {
			if let Some(status) = child.try_wait() {
				let out = child.wait_with_output();
				panic!("the shell ended ({status}) before {} existed: {out:?}", started.display());
			}
			assert!(
				Instant::now() < deadline,
				"{} did not exist after {START_LIMIT:?}",
				started.display()
			);
			std::thread::sleep(Duration::from_millis(5));
		}
		let pid = child.pid();
		// The shell blocked waiting for the command ([`Self::when_blocked`]).
		if self.blocked {
			wait_blocked(pid);
		}
		// SAFETY: kill takes integer ids; the child is not reaped yet.
		let sent = unsafe { libc::kill(if group { -pid } else { pid }, sig) };
		assert_eq!(sent, 0, "signal the shell: {}", std::io::Error::last_os_error());
		std::fs::File::create(started.with_extension("sent")).expect("mark the signal sent");
		drop(gate_writer);
		let out = if self.end_group {
			child.wait_ending_group()
		} else {
			child.wait_with_output()
		};
		assert!(
			!started.with_extension("nogate").exists(),
			"a command of the run found no gate on fd {GATE_FD}: {out:?}"
		);
		out
	}

	/// Start it with its standard output and error piped, for a caller that
	/// acts on it while it runs ([`Started`]).
	pub fn spawn(&self) -> Started {
		let (mut cmd, link_dir) = self.command();
		let child = cmd
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("start the shell");
		Started { child, group: self.group, _link_dir: link_dir }
	}
}

/// The shell of a signalled run ([`Run::go_signalled`]): dropped before it
/// was waited for, as when the test panics, it is killed with `SIGKILL`,
/// its process group too with `group` ([`Run::own_group`]), and reaped.
struct Reaper {
	child: Option<Child>,
	group: bool,
}

impl Reaper {
	/// The shell's pid.
	fn pid(&self) -> libc::pid_t {
		let child = self.child.as_ref().expect("the shell not waited for yet");
		libc::pid_t::try_from(child.id()).expect("a pid")
	}

	/// How the shell ended, once it has.
	fn try_wait(&mut self) -> Option<ExitStatus> {
		let child = self.child.as_mut().expect("the shell not waited for yet");
		child.try_wait().expect("look at the shell")
	}

	/// Wait for the shell to end and read what it wrote.
	fn wait_with_output(mut self) -> Outcome {
		let child = self.child.take().expect("the shell not waited for yet");
		outcome(child.wait_with_output().expect("wait for the shell"))
	}

	/// [`Self::wait_with_output`] for a shell that leads its own process
	/// group ([`Run::own_group`]): once it has exited, and before it is
	/// reaped (its pid, which names the group, stays its own until then),
	/// what is left in its group is killed, so no process of the run
	/// outlives it.
	fn wait_ending_group(mut self) -> Outcome {
		let mut child = self.child.take().expect("the shell not waited for yet");
		let pid = libc::pid_t::try_from(child.id()).expect("a pid");
		let stdout = read_all(child.stdout.take());
		let stderr = read_all(child.stderr.take());
		loop {
			// SAFETY: a zeroed `siginfo_t` is valid; `waitid` writes it.
			let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
			// SAFETY: waits for this child without reaping it (`WNOWAIT`).
			let rc = unsafe {
				libc::waitid(
					libc::P_PID,
					pid.unsigned_abs(),
					&raw mut info,
					libc::WEXITED | libc::WNOWAIT,
				)
			};
			if rc == 0 {
				break;
			}
			let err = std::io::Error::last_os_error();
			assert_eq!(err.kind(), std::io::ErrorKind::Interrupted, "wait for the shell: {err}");
		}
		// SAFETY: kill takes integer ids; the leader is a zombie, not reaped.
		unsafe { libc::kill(-pid, libc::SIGKILL) };
		let stdout = stdout.join().expect("the output's reader");
		let stderr = stderr.join().expect("the error output's reader");
		let status = child.wait().expect("reap the shell");
		outcome(std::process::Output { status, stdout, stderr })
	}
}

/// Read `pipe` to its end on a thread of its own.
fn read_all<R: std::io::Read + Send + 'static>(
	pipe: Option<R>,
) -> std::thread::JoinHandle<Vec<u8>> {
	std::thread::spawn(move || {
		let mut bytes = Vec::new();
		if let Some(mut pipe) = pipe {
			pipe
				.read_to_end(&mut bytes)
				.expect("read the shell's output");
		}
		bytes
	})
}

impl Drop for Reaper {
	fn drop(&mut self) {
		let Some(child) = self.child.as_mut() else {
			return;
		};
		let Ok(pid) = libc::pid_t::try_from(child.id()) else {
			return;
		};
		// Not reaped yet, so the pid is still this shell's; a group that
		// outlives its leader is still the run's.
		let running = matches!(child.try_wait(), Ok(None));
		if running || self.group {
			// SAFETY: kill takes integer ids.
			unsafe { libc::kill(if self.group { -pid } else { pid }, libc::SIGKILL) };
		}
		let _ = child.wait();
	}
}

/// A shell [`Run::spawn`] started, still running.
pub struct Started {
	/// The shell's process.
	pub child: std::process::Child,
	/// In a process group of its own ([`Run::own_group`]).
	group:     bool,
	/// The directory of the shell's link, alive while it runs.
	_link_dir: tempfile::TempDir,
}

impl Started {
	/// Wait for the shell to end, for at most `limit`: then kill it (its
	/// process group, with [`Run::own_group`]) with `SIGKILL` and fail,
	/// naming `what`. For a shell that writes little to its standard
	/// output and error, which are read once it has ended.
	pub fn end_within(self, limit: Duration, what: &str) -> Outcome {
		self.ended_within(limit).unwrap_or_else(|out| {
			panic!("{what}: the shell still ran after {limit:?}, killed: {out:?}")
		})
	}

	/// As [`Self::end_within`], but a shell still running after `limit` is
	/// an `Err` of what it wrote before `SIGKILL` killed it, for a test that
	/// counts it as one failing row among others.
	pub fn ended_within(mut self, limit: Duration) -> Result<Outcome, Outcome> {
		let deadline = Instant::now() + limit;
		while self.child.try_wait().expect("look at the shell").is_none() {
			if Instant::now() >= deadline {
				let pid = libc::pid_t::try_from(self.child.id()).expect("a pid");
				// SAFETY: kill takes integer ids; the child is not reaped yet.
				unsafe { libc::kill(if self.group { -pid } else { pid }, libc::SIGKILL) };
				return Err(outcome(self.child.wait_with_output().expect("wait for the shell")));
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		Ok(outcome(
			self
				.child
				.wait_with_output()
				.expect("read the shell's output"),
		))
	}
}

/// `program` as a path that names it from any directory: a relative one
/// with a directory part, as the obash under test is under Bazel (its
/// runfiles path, `crates/pi-shell/obash`), is taken from the current
/// directory, so that a run in another directory ([`Run::dumping_in`]) and
/// a link in a temporary one ([`Run::under`]) still reach it. A bare name
/// stays a `PATH` search.
#[must_use]
pub fn absolute(program: &Path) -> PathBuf {
	if program.is_relative() && program.components().count() > 1 {
		std::path::absolute(program).expect("the current directory")
	} else {
		program.to_owned()
	}
}

fn outcome(out: std::process::Output) -> Outcome {
	Outcome {
		stdout: out.stdout,
		stderr: out.stderr,
		code:   out.status.code(),
		signal: out.status.signal(),
		core:   out.status.core_dumped(),
	}
}

/// Whether the real zsh exists (it reports the test uncompared when not).
pub fn have_zsh() -> bool {
	zsh_oracle::exists()
}

/// The oldest bash the bash cases compare with: they were measured with
/// bash 5.2. bash 5.1 forks the last command of `-c` after `trap '' SIG`
/// and prints its notice; bash 5.0 names the first line of a multi-line
/// command in the notice, where 5.2 names the last.
pub const BASH_OLDEST: (u32, u32) = (5, 2);

/// The major and minor version of a bash whose `--version` says `line`
/// first (`GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)`).
#[must_use]
pub fn bash_version(line: &str) -> Option<(u32, u32)> {
	let mut numbers = line
		.split("version ")
		.nth(1)?
		.split(|c: char| !c.is_ascii_digit());
	let major = numbers.next()?.parse().ok()?;
	let minor = numbers.next()?.parse().ok()?;
	Some((major, minor))
}

/// `path` if it is bash [`BASH_OLDEST`] or later; else why not, naming the
/// version it found.
///
/// # Errors
///
/// The refusal: `path` is an older bash, or no bash.
pub fn bash_at(path: PathBuf) -> Result<PathBuf, String> {
	let version = Command::new(&path).arg("--version").output();
	let first = version.as_ref().ok().and_then(|out| {
		String::from_utf8_lossy(&out.stdout)
			.lines()
			.next()
			.map(str::to_owned)
	});
	if first
		.as_deref()
		.and_then(bash_version)
		.is_some_and(|v| v >= BASH_OLDEST)
	{
		return Ok(path);
	}
	Err(format!(
		"{} is not bash {}.{} or later ({}), so nothing is compared with bash",
		path.display(),
		BASH_OLDEST.0,
		BASH_OLDEST.1,
		first.unwrap_or_else(|| format!("{version:?}"))
	))
}

/// The real bash: `$PI_TEST_REAL_BASH`, or `/bin/bash`, if it is bash 5.2
/// or later ([`bash_at`]); else `None`, and the test reported
/// [`zsh_oracle::uncompared`] with the refusal.
pub fn real_bash() -> Option<PathBuf> {
	bash_at(real_bash_path())
		.map_err(|refusal| zsh_oracle::uncompared(&refusal))
		.ok()
}

/// `$PI_TEST_REAL_BASH`, or `/bin/bash`.
fn real_bash_path() -> PathBuf {
	std::env::var_os("PI_TEST_REAL_BASH")
		.filter(|p| !p.is_empty())
		.map_or_else(|| PathBuf::from("/bin/bash"), PathBuf::from)
}

/// The bash the checked-in goldens of bash's job notices were measured
/// with: 5.3.20, the version obash declares (`BASH_VERSION`).
pub const BASH_GOLDEN: (u32, u32) = (5, 3);

/// The real bash ([`real_bash_path`]) when it is bash [`BASH_GOLDEN`] or
/// later: an extra local check of a case whose expected output is a
/// checked-in golden. `None` for any other bash, or none, and nothing is
/// reported: the golden is the comparison, so nothing goes uncompared.
pub fn real_bash_golden() -> Option<PathBuf> {
	let path = real_bash_path();
	let out = Command::new(&path).arg("--version").output().ok()?;
	let first = String::from_utf8_lossy(&out.stdout)
		.lines()
		.next()?
		.to_owned();
	(bash_version(&first)? >= BASH_GOLDEN).then_some(path)
}

/// The real shell `name` (`zsh` or `bash`) the case compares with, or
/// `None` and the test reported uncompared.
pub fn real(name: &str) -> Option<PathBuf> {
	if name == "zsh" {
		have_zsh().then(zsh_oracle::path)
	} else {
		real_bash()
	}
}
