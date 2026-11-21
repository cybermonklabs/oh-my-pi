//! Run obash, bash and zsh as processes and compare how they end: the
//! signals they start with, their core size limit, the real bash the
//! comparisons need ([`real_bash`]), and a signal sent from outside once the
//! command a shell waits for has started ([`Run::go_signalled`]).

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::{OsStr, OsString},
	fmt,
	os::unix::process::{CommandExt, ExitStatusExt},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	time::Duration,
};

use crate::{pty_support::wait_blocked, zsh_oracle};

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

/// The signals the tests send. Each run starts with them at their
/// defaults, whatever the test runner's are (a terminal, `nohup` or a CI
/// runner starts children with some ignored).
const SENT: [libc::c_int; 8] = [
	libc::SIGHUP,
	libc::SIGINT,
	libc::SIGQUIT,
	libc::SIGTERM,
	libc::SIGUSR1,
	libc::SIGUSR2,
	libc::SIGALRM,
	libc::SIGPIPE,
];

/// One run of a shell: `program` named `name` (`argv[0]`; through a link
/// named so under a wrapper, which runs it by its path), with `ZDOTDIR`
/// unset, the signals in [`SENT`] at their defaults and a core size limit
/// of 1 byte on entry, unless set otherwise. A pipe `core_pattern`
/// (systemd-coredump, apport) ignores a limit of 0 and dumps anyway (the
/// kernel's `fs/coredump.c` refuses a pipe dump only at 1), and a file dump
/// needs more than 1 byte: no command a run starts dumps a core.
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

	/// [`Self::go_signalled`] sends its signal only once the shell has also
	/// blocked ([`wait_blocked`]): for the real bash, which acts on a signal
	/// that comes before it blocks in `waitpid` only once the command has
	/// ended, or at once. Not for obash, which runs a subshell's code in its
	/// own process, so it can stay running while it waits.
	#[must_use]
	pub const fn when_blocked(mut self) -> Self {
		self.blocked = true;
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
				for sig in SENT {
					libc::signal(sig, libc::SIG_DFL);
				}
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
	/// `group` ([`Self::own_group`]), else to the shell alone. Then wait for
	/// it to end. A shell that ends before the file exists fails the test;
	/// nextest's own timeout bounds one that never makes it.
	pub fn go_signalled(&self, started: &Path, sig: libc::c_int, group: bool) -> Outcome {
		let (mut cmd, _link_dir) = self.command();
		let mut child = cmd
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("start the shell");
		while !started.exists() {
			if let Some(status) = child.try_wait().expect("look at the shell") {
				let out = child.wait_with_output().expect("read the shell's output");
				panic!("the shell ended ({status}) before {} existed: {out:?}", started.display());
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		let pid = libc::pid_t::try_from(child.id()).expect("a pid");
		// The real bash blocked waiting for the command ([`Self::when_blocked`]).
		if self.blocked {
			wait_blocked(pid);
		}
		// SAFETY: kill takes integer ids; the child is not reaped yet.
		let sent = unsafe { libc::kill(if group { -pid } else { pid }, sig) };
		assert_eq!(sent, 0, "signal the shell: {}", std::io::Error::last_os_error());
		outcome(child.wait_with_output().expect("wait for the shell"))
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
	let path = std::env::var_os("PI_TEST_REAL_BASH")
		.filter(|p| !p.is_empty())
		.map_or_else(|| PathBuf::from("/bin/bash"), PathBuf::from);
	bash_at(path)
		.map_err(|refusal| zsh_oracle::uncompared(&refusal))
		.ok()
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
