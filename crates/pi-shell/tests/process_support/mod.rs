//! Run obash, bash and zsh as processes and compare how they end: the
//! signals they start with, their core size limit, the real bash the
//! comparisons need ([`real_bash`], [`real_bash_golden`]), and a signal sent
//! from outside once the command a shell waits for has started
//! ([`Run::go_signalled`]).

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::{OsStr, OsString},
	fmt,
	os::unix::process::{CommandExt, ExitStatusExt},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	time::{Duration, Instant},
};

use crate::{
	pty_support::{every_signal_at_its_default, wait_blocked, wait_until_it_waits},
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

/// One run of a shell: `program` named `name` (`argv[0]`; through a link
/// named so under a wrapper, which runs it by its path), with `ZDOTDIR`
/// unset, every signal at its default ([`every_signal_at_its_default`]) and a
/// core size limit of 1 byte on entry, unless set otherwise. A pipe
/// `core_pattern` (systemd-coredump, apport) ignores a limit of 0 and dumps
/// anyway (the kernel's `fs/coredump.c` refuses a pipe dump only at 1), and a
/// file dump needs more than 1 byte: no command a run starts dumps a core.
pub struct Run {
	program: PathBuf,
	name:    &'static str,
	args:    Vec<OsString>,
	ignored: Vec<libc::c_int>,
	cores:   bool,
	dir:     Option<PathBuf>,
	wrap:    Vec<&'static str>,
	env:     Vec<(&'static str, Option<OsString>)>,
	/// In a process group of its own (so a signal can go to the group).
	group:   bool,
	/// [`Self::go_signalled`] signals only once the shell has blocked
	/// ([`Self::when_blocked`]).
	blocked: bool,
	/// [`Self::go_signalled`] signals only once the shell waits for the
	/// copies of itself it forked ([`Self::when_it_waits`]).
	forks:   bool,
	/// The file its standard input reads ([`Self::input`]); else the test's.
	input:   Option<PathBuf>,
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
			blocked: false,
			forks: false,
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

	/// [`Self::go_signalled`] sends its signal only once the shell waits for
	/// the copies of itself it forked ([`wait_until_it_waits`]), whatever
	/// they run: for a command of shell code that never blocks, which
	/// [`Self::when_blocked`] would wait for in vain. A shell that runs that
	/// code in its own process (obash) gets it at once.
	#[must_use]
	pub const fn when_it_waits(mut self) -> Self {
		self.forks = true;
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
		// SAFETY: signal, setpgid, getrlimit and setrlimit are
		// async-signal-safe and change only the child; nothing here allocates.
		unsafe {
			cmd.pre_exec(move || {
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
	/// `group` ([`Self::own_group`]), else to the shell alone. Then release
	/// both marks of the signal having been sent, so a command waiting for
	/// one goes on however late the signal is; and wait for the shell to
	/// end. A shell that ends before the file exists fails the test;
	/// nextest's own timeout bounds one that never makes it.
	///
	/// The marks: `started` with the extension `sent` (`$F.sent`), which a
	/// command polls for; and the FIFO `started` with the extension `fifo`
	/// (`$F.fifo`), made before the shell starts and held open here until
	/// the signal is sent, which a command blocks on and cannot end by
	/// itself (a poll is a forked `/bin/sleep` of its own, and a shell that
	/// waits for one reads the signal as that child's business:
	/// process_signals' `SENT`). A command still running once the mark is
	/// released reads the end of the FIFO and ends, so a row it fails ends
	/// at once rather than at a timeout.
	pub fn go_signalled(&self, started: &Path, sig: libc::c_int, group: bool) -> Outcome {
		let t0 = Instant::now();
		let stage = std::sync::Arc::new(std::sync::Mutex::new(String::from("spawn")));
		let shell_pid = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(0));
		let what = format!(
			"{} as {} {:?} sig {sig} group {group} blocked {} forks {}",
			self.program.display(),
			self.name,
			self.args,
			self.blocked,
			self.forks
		);
		eprintln!("PROBE case: {what}");
		let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
		let watchdog = {
			let (stage, shell_pid, what) = (stage.clone(), shell_pid.clone(), what.clone());
			std::thread::spawn(move || {
				for wait in [15, 30] {
					if done_rx.recv_timeout(Duration::from_secs(wait)).is_ok() {
						return;
					}
					let st = stage.lock().unwrap().clone();
					eprintln!(
						"PROBE HANG after {:?} at stage {st}: {what}",
						t0.elapsed()
					);
					probe_dump(shell_pid.load(std::sync::atomic::Ordering::SeqCst));
				}
			})
		};
		let set = |s: &str| {
			eprintln!("PROBE {:>8.3}s {s}", t0.elapsed().as_secs_f64());
			*stage.lock().unwrap() = s.to_owned();
		};
		let fifo = make_fifo(&started.with_extension("fifo"));
		let (mut cmd, _link_dir) = self.command();
		let mut child = cmd
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("start the shell");
		shell_pid.store(child.id() as i32, std::sync::atomic::Ordering::SeqCst);
		set(&format!("spawned shell {}; waiting for $F", child.id()));
		while !started.exists() {
			if let Some(status) = child.try_wait().expect("look at the shell") {
				let out = child.wait_with_output().expect("read the shell's output");
				panic!("the shell ended ({status}) before {} existed: {out:?}", started.display());
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		let pid = libc::pid_t::try_from(child.id()).expect("a pid");
		set("$F exists; gate");
		// The shell blocked waiting for the command ([`Self::when_blocked`]),
		// or for the copies of itself it forked ([`Self::when_it_waits`]).
		if self.blocked {
			wait_blocked(pid);
		} else if self.forks {
			wait_until_it_waits(pid);
		}
		set("gate passed; kill");
		// SAFETY: kill takes integer ids; the child is not reaped yet.
		let sent = unsafe { libc::kill(if group { -pid } else { pid }, sig) };
		assert_eq!(sent, 0, "signal the shell: {}", std::io::Error::last_os_error());
		std::fs::File::create(started.with_extension("sent")).expect("mark the signal sent");
		drop(fifo);
		set("signal sent, marks released; wait_with_output");
		let out = outcome(child.wait_with_output().expect("wait for the shell"));
		set(&format!("done: {out:?}"));
		let _ = done_tx.send(());
		let _ = watchdog.join();
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

/// Make the FIFO `path` and hold it open: a command that reads it blocks
/// at once (this end is open, so its own open does not wait) and can end
/// only by a signal, until the returned handle is dropped, which gives
/// the end of the file to a reader that has it open by then. One that
/// opens it later waits for the next writer, so the caller releases the
/// mark only once the command it waits for has blocked
/// ([`Run::go_signalled`]).
fn make_fifo(path: &Path) -> std::fs::File {
	use std::os::unix::ffi::OsStrExt as _;
	let name = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path with no NUL");
	// SAFETY: `name` is a NUL-terminated path that lives across the call.
	let made = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
	assert_eq!(made, 0, "make the FIFO {}: {}", path.display(), std::io::Error::last_os_error());
	// Read and write, so that opening it here does not wait for the other
	// end and dropping it gives a reader the end of the file.
	std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(path)
		.expect("open the FIFO")
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

/// Diagnostic only (scratch/caught-signal-hang-probe): every process below
/// this test, and every process whose command names `child-done` with
/// those below it, as `ps` lists them; for each shell among them its
/// threads' stacks (`sample` on macOS) and its open pipes (`lsof`).
fn probe_dump(shell: i32) {
	let me = i32::try_from(std::process::id()).unwrap_or(0);
	let Ok(out) = Command::new("ps")
		.args(["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,etime=,command="])
		.output()
	else {
		eprintln!("PROBE ps: could not run");
		return;
	};
	let text = String::from_utf8_lossy(&out.stdout).into_owned();
	let rows: Vec<(i32, i32, &str)> = text
		.lines()
		.filter_map(|l| {
			let mut f = l.split_whitespace();
			let pid = f.next()?.parse().ok()?;
			let ppid = f.next()?.parse().ok()?;
			Some((pid, ppid, l))
		})
		.collect();
	let mut keep: Vec<i32> = rows
		.iter()
		.filter(|(pid, _, l)| *pid == me || *pid == shell || l.contains("child-done"))
		.map(|r| r.0)
		.collect();
	loop {
		let more: Vec<i32> = rows
			.iter()
			.filter(|(pid, ppid, _)| keep.contains(ppid) && !keep.contains(pid))
			.map(|r| r.0)
			.collect();
		if more.is_empty() {
			break;
		}
		keep.extend(more);
	}
	eprintln!("PROBE me {me} shell {shell}; ps (pid ppid pgid stat etime command):");
	for (pid, _, l) in &rows {
		if keep.contains(pid) {
			eprintln!("PROBE ps {l}");
		}
	}
	for (pid, _, l) in &rows {
		if !keep.contains(pid) || *pid == me || l.contains(" ps -A") {
			continue;
		}
		let p = pid.to_string();
		if let Ok(o) = Command::new("lsof").args(["-n", "-P", "-p", p.as_str()]).output() {
			for line in String::from_utf8_lossy(&o.stdout).lines() {
				if line.contains("PIPE") || line.contains("FIFO") || line.contains(" 0u") || line.contains(" 1u") || line.contains(" 2u") || line.contains(" 1w") || line.contains(" 2w") || line.contains(" 0r") {
					eprintln!("PROBE lsof {pid}: {line}");
				}
			}
		}
		if cfg!(target_os = "macos") && !l.contains("/bin/sleep") {
			let file = std::env::temp_dir().join(format!("probe-sample-{pid}.txt"));
			let ok = Command::new("/usr/bin/sample")
				.args([p.as_str(), "1", "-mayDie", "-file"])
				.arg(&file)
				.output()
				.is_ok();
			let report = std::fs::read_to_string(&file).unwrap_or_default();
			eprintln!("PROBE sample {pid} (ran {ok}, {} lines):", report.lines().count());
			for line in report
				.lines()
				.skip_while(|l| !l.starts_with("Call graph"))
				.take_while(|l| !l.starts_with("Total number in stack"))
				.take(120)
			{
				eprintln!("PROBE sample {pid}: {line}");
			}
		}
	}
}
