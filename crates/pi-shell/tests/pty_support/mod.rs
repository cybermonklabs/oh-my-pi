//! Drive a shell on a pseudo-terminal (Unix): obash under any name (`zsh`,
//! `bash`, `sh`) or the real zsh ([`crate::zsh_oracle`]) for differential
//! runs.
//!
//! [`Spawn`] describes the process: program, `argv[0]`, arguments, a
//! hermetic environment (`PATH` of the runner, `HOME` and `ZDOTDIR` a fresh
//! temporary directory, `TERM=xterm-256color`, `LANG=en_US.UTF-8`), startup
//! files written into that home ([`Spawn::rc_file`]) and the window size.
//! [`Spawn::spawn`] starts it as the leader of a new session whose
//! controlling terminal is the pty (fds 0–2 on its terminal side).
//!
//! [`Pty`] is the terminal side a test drives: [`Pty::write`] keys,
//! [`Pty::read_until`] a pattern in the output, [`Pty::wait_screen`] a
//! condition on the rendered screen ([`vt::Screen`], a small VT model that
//! also answers cursor position requests), [`Pty::resize`] (the kernel
//! sends `SIGWINCH`), [`Pty::signal`], [`Pty::wait`] for the exit status.
//! Every wait is bounded; a timeout reports the output so far. Dropping a
//! [`Pty`] kills the session's process group.
//!
//! [`Pty::settle`] guesses that a shell is done when its output pauses; a
//! zsh-like shell can say so instead: [`Spawn::zle_sync`] adds a `zle -F`
//! handler script ([`ZLE_SYNC_SCRIPT`], sourced by the test), and
//! [`Pty::zle_sync`] returns once the line editor has handled every key
//! typed and waits for the next one.
//!
//! ```ignore
//! mod pty_support;
//! use pty_support::{Spawn, TIMEOUT};
//!
//! let mut zsh = Spawn::zsh().args(["-f", "-c", "read x; print got:$x"]).spawn()?;
//! zsh.write("abc\r")?;
//! zsh.read_until("got:abc", TIMEOUT)?;
//! assert!(zsh.wait(TIMEOUT)?.success());
//! ```

#![allow(dead_code, reason = "each test crate uses a subset")]

pub mod vt;

use std::{
	ffi::{CString, OsStr, OsString},
	fs,
	io::{self, Read, Write},
	os::{
		fd::{AsRawFd, OwnedFd},
		unix::{ffi::OsStrExt, fs::OpenOptionsExt, process::CommandExt},
	},
	path::{Path, PathBuf},
	process::{Child, Command, ExitStatus, Stdio},
	sync::{Arc, Condvar, Mutex},
	thread,
	time::{Duration, Instant},
};

use pi_shell::{
	bash::{TermFlag, TtyInfo},
	sys::tty,
};

pub use self::vt::Screen;

/// The default bound of every wait.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// A wait with no deadline of its own, for [`Pty::read_until`],
/// [`Pty::read_some`], [`Pty::wait_screen`] and [`Pty::zle_sync`]: it ends
/// when its event comes, and the test runner's timeout is its only bound.
pub const NO_DEADLINE: Duration = Duration::MAX;

/// The script [`Spawn::zle_sync`] writes into the home directory; a
/// zsh-like shell (obash as `zsh`, the real zsh) sources it
/// (`. ~/.zle-sync`) to answer [`Pty::zle_sync`]. It opens a FIFO and
/// installs a `zle -F` handler on it that answers each request (a line
/// `N`) with `ESC ] 9999;zle-sync N BEL`, an OSC string terminals (and
/// [`Screen`]) ignore.
pub const ZLE_SYNC_SCRIPT: &str = ".zle-sync";

/// The FIFO [`Pty::zle_sync`] writes its requests to, in the home directory.
const ZLE_SYNC_FIFO: &str = ".zle-sync.fifo";

/// The answer to a [`Pty::zle_sync`] request: `ESC`, this, the request's
/// number, `BEL`.
const ZLE_SYNC_TAG: &str = "]9999;zle-sync ";

/// The obash binary under test.
#[must_use]
pub fn obash() -> &'static str {
	env!("CARGO_BIN_EXE_obash")
}

/// Whether the real zsh exists here; differential tests compare nothing
/// without it, and say so ([`crate::zsh_oracle::exists`]).
#[must_use]
pub fn have_real_zsh() -> bool {
	crate::zsh_oracle::exists()
}

/// A shell process to start on a pty.
pub struct Spawn {
	program: PathBuf,
	argv0:   Option<OsString>,
	args:    Vec<OsString>,
	env:     Vec<(OsString, OsString)>,
	rows:    u16,
	cols:    u16,
	cwd:     Option<PathBuf>,
	home:    tempfile::TempDir,
	rc:      Vec<(String, Vec<u8>)>,
	sync:    bool,
}

impl Spawn {
	/// `program` with the hermetic environment (see the module docs), 24 ×
	/// 80.
	///
	/// # Panics
	///
	/// When the temporary home cannot be created.
	#[must_use]
	pub fn new(program: impl Into<PathBuf>) -> Self {
		let home = tempfile::tempdir().expect("temporary HOME");
		let mut env = vec![
			(OsString::from("HOME"), home.path().as_os_str().to_owned()),
			(OsString::from("ZDOTDIR"), home.path().as_os_str().to_owned()),
			(OsString::from("TERM"), OsString::from("xterm-256color")),
			(OsString::from("LANG"), OsString::from("en_US.UTF-8")),
		];
		if let Some(path) = std::env::var_os("PATH") {
			env.push((OsString::from("PATH"), path));
		}
		Self {
			program: program.into(),
			argv0: None,
			args: Vec::new(),
			env,
			rows: 24,
			cols: 80,
			cwd: None,
			home,
			rc: Vec::new(),
			sync: false,
		}
	}

	/// obash invoked as `name` (`zsh`, `bash`, `sh`).
	#[must_use]
	pub fn obash_as(name: &str) -> Self {
		Self::new(obash()).argv0(name)
	}

	/// obash invoked as `zsh`.
	#[must_use]
	pub fn zsh() -> Self {
		Self::obash_as("zsh")
	}

	/// The real zsh ([`crate::zsh_oracle::path`]), invoked as `zsh`.
	#[must_use]
	pub fn real_zsh() -> Self {
		Self::new(crate::zsh_oracle::path()).argv0("zsh")
	}

	/// `argv[0]` (default: the program path).
	#[must_use]
	pub fn argv0(mut self, name: impl Into<OsString>) -> Self {
		self.argv0 = Some(name.into());
		self
	}

	/// One more argument.
	#[must_use]
	pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
		self.args.push(arg.into());
		self
	}

	/// More arguments.
	#[must_use]
	pub fn args<I: IntoIterator<Item = S>, S: Into<OsString>>(mut self, args: I) -> Self {
		self.args.extend(args.into_iter().map(Into::into));
		self
	}

	/// Set (or replace) an environment variable.
	#[must_use]
	pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
		let key = key.as_ref().to_owned();
		self.env.retain(|(k, _)| *k != key);
		self.env.push((key, value.as_ref().to_owned()));
		self
	}

	/// Remove an environment variable.
	#[must_use]
	pub fn env_remove(mut self, key: impl AsRef<OsStr>) -> Self {
		self.env.retain(|(k, _)| k != key.as_ref());
		self
	}

	/// The window size.
	#[must_use]
	pub fn size(mut self, rows: u16, cols: u16) -> Self {
		self.rows = rows;
		self.cols = cols;
		self
	}

	/// The working directory (default: the runner's).
	#[must_use]
	pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
		self.cwd = Some(dir.into());
		self
	}

	/// A file written into the home directory (also `ZDOTDIR`) before the
	/// shell starts: `.zshrc`, `.zshenv`, `.bashrc`, `.profile`, a script.
	#[must_use]
	pub fn rc_file(mut self, name: &str, text: impl AsRef<[u8]>) -> Self {
		self.rc.push((name.to_owned(), text.as_ref().to_vec()));
		self
	}

	/// Have [`Self::spawn`] create the FIFO and write the
	/// [`ZLE_SYNC_SCRIPT`] that [`Pty::zle_sync`] needs.
	#[must_use]
	pub fn zle_sync(mut self) -> Self {
		self.sync = true;
		self
	}

	/// The home directory.
	#[must_use]
	pub fn home(&self) -> &Path {
		self.home.path()
	}

	/// Start the process (see the module docs).
	///
	/// # Errors
	///
	/// When the pty cannot be opened, a startup file written, or the
	/// program started.
	pub fn spawn(self) -> io::Result<Pty> {
		for (name, text) in &self.rc {
			fs::write(self.home.path().join(name), text)?;
		}
		let sync = if self.sync {
			let fifo = self.home.path().join(ZLE_SYNC_FIFO);
			let c_fifo = CString::new(fifo.as_os_str().as_bytes())?;
			// SAFETY: mkfifo reads a NUL-terminated path.
			if unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) } == -1 {
				return Err(io::Error::last_os_error());
			}
			// Opened read-write, the FIFO never waits for a writer nor
			// reads as end of file. The handler reads one request, answers
			// it on the terminal and leaves the display alone.
			let quoted = fifo.to_string_lossy().replace('\'', r"'\''");
			let script = format!(
				"exec {{_zle_sync_fd}}<>'{quoted}'\n_zle_sync() {{ local n; read -r -u $1 n; print \
				 -rn -- $'\\e{ZLE_SYNC_TAG}'$n$'\\a'; }}\nzle -F $_zle_sync_fd _zle_sync\n"
			);
			fs::write(self.home.path().join(ZLE_SYNC_SCRIPT), script)?;
			Some(fifo)
		} else {
			None
		};
		let (master, slave, tty_name) =
			tty::open_pty(Some(TtyInfo { rows: self.rows, cols: self.cols }))?;
		let mut cmd = Command::new(&self.program);
		if let Some(argv0) = &self.argv0 {
			cmd.arg0(argv0);
		}
		cmd.args(&self.args)
			.env_clear()
			.envs(self.env.iter().map(|(k, v)| (k, v)));
		if let Some(dir) = &self.cwd {
			cmd.current_dir(dir);
		}
		cmd.stdin(Stdio::from(slave.try_clone()?))
			.stdout(Stdio::from(slave.try_clone()?))
			.stderr(Stdio::from(slave));
		// SAFETY: the hook only makes async-signal-safe calls (setsid,
		// ioctl) between fork and exec.
		unsafe {
			cmd.pre_exec(|| {
				if libc::setsid() == -1 {
					return Err(io::Error::last_os_error());
				}
				// The ioctl request's integer type differs between platforms.
				let tiocsctty = libc::TIOCSCTTY as _;
				if libc::ioctl(0, tiocsctty, 0) == -1 {
					return Err(io::Error::last_os_error());
				}
				Ok(())
			});
		}
		let child = cmd.spawn()?;
		drop(cmd);
		let shared = Arc::new(Shared::default());
		let reader = fs::File::from(master.try_clone()?);
		let sink = Arc::clone(&shared);
		thread::Builder::new()
			.name("pty-reader".into())
			.spawn(move || read_loop(reader, &sink))?;
		Ok(Pty {
			master: fs::File::from(master),
			tty: PathBuf::from(OsStr::from_bytes(&tty_name)),
			child,
			shared,
			fed: 0,
			mark: 0,
			screen: Screen::new(self.rows, self.cols),
			status: None,
			sync,
			syncs: 0,
			_home: self.home,
		})
	}
}

/// Output collected by the reader thread.
#[derive(Default)]
struct Shared {
	/// Every byte read so far, and whether the terminal hung up.
	state: Mutex<(Vec<u8>, bool)>,
	more:  Condvar,
}

fn read_loop(mut master: fs::File, shared: &Shared) {
	let mut buf = [0u8; 8192];
	loop {
		match master.read(&mut buf) {
			Ok(0) | Err(_) => break,
			Ok(n) => {
				shared.state.lock().unwrap().0.extend_from_slice(&buf[..n]);
				shared.more.notify_all();
			},
		}
	}
	// Linux reports the hang-up of the last terminal-side descriptor as
	// EIO, macOS as end of file.
	shared.state.lock().unwrap().1 = true;
	shared.more.notify_all();
}

/// A running shell on a pty (see the module docs).
pub struct Pty {
	master: fs::File,
	/// The terminal side's device.
	tty:    PathBuf,
	child:  Child,
	shared: Arc<Shared>,
	/// Output bytes fed to the screen.
	fed:    usize,
	/// Output bytes [`Self::read_until`] consumed.
	mark:   usize,
	screen: Screen,
	status: Option<ExitStatus>,
	/// The [`Spawn::zle_sync`] FIFO.
	sync:   Option<PathBuf>,
	/// [`Self::zle_sync`] requests so far.
	syncs:  u64,
	_home:  tempfile::TempDir,
}

impl Pty {
	/// The process id (also its process group and session).
	#[must_use]
	pub fn pid(&self) -> i32 {
		i32::try_from(self.child.id()).unwrap_or(i32::MAX)
	}

	/// Type `bytes` (keys: `"\r"` is Enter, `"\x03"` Ctrl-C).
	///
	/// # Errors
	///
	/// When the terminal cannot be written.
	pub fn write(&mut self, bytes: impl AsRef<[u8]>) -> io::Result<()> {
		self.master.write_all(bytes.as_ref())?;
		self.master.flush()
	}

	/// Type `keys` one byte at a time, `delay` apart (a typist, for readers
	/// that must see keys arrive separately).
	///
	/// # Errors
	///
	/// When the terminal cannot be written.
	pub fn type_keys(&mut self, keys: impl AsRef<[u8]>, delay: Duration) -> io::Result<()> {
		for &b in keys.as_ref() {
			self.write([b])?;
			thread::sleep(delay);
			self.pump()?;
		}
		Ok(())
	}

	/// Feed new output to the screen and answer its requests.
	fn pump(&mut self) -> io::Result<()> {
		let fresh = {
			let state = self.shared.state.lock().unwrap();
			state.0[self.fed..].to_vec()
		};
		self.fed += fresh.len();
		self.screen.feed(&fresh);
		let replies = self.screen.take_replies();
		if !replies.is_empty() {
			self.write(replies)?;
		}
		Ok(())
	}

	/// Wait until `done` holds for the output so far and the hang-up flag,
	/// or `timeout`; feeds the screen meanwhile.
	fn wait_output(
		&mut self,
		timeout: Duration,
		mut done: impl FnMut(&[u8], bool, &Screen) -> bool,
	) -> io::Result<()> {
		// `NO_DEADLINE` overflows the addition: no deadline.
		let deadline = Instant::now().checked_add(timeout);
		loop {
			self.pump()?;
			{
				let state = self.shared.state.lock().unwrap();
				if done(&state.0, state.1, &self.screen) {
					return Ok(());
				}
				let now = Instant::now();
				if deadline.is_some_and(|d| now >= d) {
					drop(state);
					return Err(self.timeout("output"));
				}
				// Wake on new output, or every 20 ms for the screen.
				let poll = Duration::from_millis(20);
				let wait = deadline.map_or(poll, |d| (d - now).min(poll));
				let _ = self.shared.more.wait_timeout(state, wait).unwrap();
			}
		}
	}

	fn timeout(&self, what: &str) -> io::Error {
		io::Error::new(
			io::ErrorKind::TimedOut,
			format!(
				"timed out waiting for {what}\n--- output ---\n{}\n--- screen ---\n{}",
				self.output(),
				self.screen.contents()
			),
		)
	}

	/// Wait for `pattern` in the output after what earlier calls consumed;
	/// the output up to and including it (consumed).
	///
	/// # Errors
	///
	/// `TimedOut` (with the output so far) when it does not appear in time.
	pub fn read_until(
		&mut self,
		pattern: impl AsRef<[u8]>,
		timeout: Duration,
	) -> io::Result<String> {
		let pattern = pattern.as_ref();
		let mark = self.mark;
		let mut end = None;
		self
			.wait_output(timeout, |out, _, _| {
				end = out[mark.min(out.len())..]
					.windows(pattern.len().max(1))
					.position(|w| w == pattern)
					.map(|i| mark + i + pattern.len());
				end.is_some()
			})
			.map_err(|_| self.timeout(&format!("{:?}", String::from_utf8_lossy(pattern))))?;
		let end = end.unwrap_or(mark);
		self.mark = end;
		let state = self.shared.state.lock().unwrap();
		Ok(String::from_utf8_lossy(&state.0[mark..end]).into_owned())
	}

	/// Wait for any output after what earlier calls consumed; that output
	/// (consumed).
	///
	/// # Errors
	///
	/// `TimedOut` (with the output so far) when none comes in time.
	pub fn read_some(&mut self, timeout: Duration) -> io::Result<String> {
		let mark = self.mark;
		let mut end = mark;
		self
			.wait_output(timeout, |out, _, _| {
				end = out.len();
				end > mark
			})
			.map_err(|_| self.timeout("output after the last read"))?;
		self.mark = end;
		let state = self.shared.state.lock().unwrap();
		Ok(String::from_utf8_lossy(&state.0[mark..end]).into_owned())
	}

	/// Wait until the rendered screen satisfies `cond`.
	///
	/// # Errors
	///
	/// `TimedOut` (with the output and screen) when it does not in time.
	pub fn wait_screen(
		&mut self,
		timeout: Duration,
		mut cond: impl FnMut(&Screen) -> bool,
	) -> io::Result<()> {
		self.wait_output(timeout, |_, _, screen| cond(screen))
	}

	/// Wait until the screen shows `text` somewhere.
	///
	/// # Errors
	///
	/// As [`Self::wait_screen`].
	pub fn wait_screen_contains(&mut self, text: &str, timeout: Duration) -> io::Result<()> {
		self.wait_screen(timeout, |s| s.contents().contains(text))
	}

	/// Wait until no output arrives for `quiet` (bounded by `timeout`).
	///
	/// # Errors
	///
	/// `TimedOut` when output keeps arriving.
	pub fn settle(&mut self, quiet: Duration, timeout: Duration) -> io::Result<()> {
		let mut last = (usize::MAX, Instant::now());
		self.wait_output(timeout, |out, hung_up, _| {
			if out.len() != last.0 {
				last = (out.len(), Instant::now());
			}
			hung_up || last.1.elapsed() >= quiet
		})
	}

	/// Wait until the program has disabled canonical mode and echo: a line
	/// editor, rather than the kernel's line discipline, handles the keys.
	///
	/// # Errors
	///
	/// When the terminal's modes cannot be read, or `TimedOut` (with the
	/// output so far).
	pub fn wait_raw(&mut self, timeout: Duration) -> io::Result<()> {
		let term = self.open_tty()?;
		let deadline = Instant::now() + timeout;
		loop {
			self.pump()?;
			// The terminal side's modes: a pty's other side has its own on
			// Linux.
			let attrs = tty::attrs(term.as_raw_fd())?;
			if !attrs.get(TermFlag::Icanon) && !attrs.get(TermFlag::Echo) {
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Err(self.timeout("non-canonical mode with echo disabled"));
			}
			thread::sleep(Duration::from_millis(5));
		}
	}

	/// Wait until the shell has handled every key typed so far and its line
	/// editor waits for the next one, the display up to date (needs
	/// [`Spawn::zle_sync`] and the shell to have sourced
	/// [`ZLE_SYNC_SCRIPT`]).
	///
	/// Once the shell has read the keys, a request goes to the FIFO. ZLE
	/// serves `zle -F` handlers only while it waits for a key and none is
	/// typed, so the answer comes after the work the keys started (a
	/// completion function, a command line) and its output. The terminal
	/// modes are the shell's own business then: zsh 5.9 waits for the key
	/// after a listing longer than the screen in cooked, echoing mode.
	///
	/// # Errors
	///
	/// When there is no FIFO or no shell has it open, or `TimedOut` (with
	/// the output so far) when the answer does not come in time.
	pub fn zle_sync(&mut self, timeout: Duration) -> io::Result<()> {
		let Some(fifo) = self.sync.clone() else {
			return Err(io::Error::other("zle_sync needs Spawn::zle_sync"));
		};
		let deadline = Instant::now().checked_add(timeout);
		// The shell reads each key before its next wait: were keys still
		// queued, it could see the request before them.
		let term = self.open_tty()?;
		loop {
			self.pump()?;
			if unread(&term)? == 0 {
				break;
			}
			if deadline.is_some_and(|d| Instant::now() >= d) {
				return Err(self.timeout("the shell to read the keys"));
			}
			thread::sleep(Duration::from_millis(5));
		}
		drop(term);
		self.syncs += 1;
		let mut request = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&fifo)
			.map_err(|e| {
				io::Error::new(
					e.kind(),
					format!("{}: {e} (is ~/{ZLE_SYNC_SCRIPT} sourced?)", fifo.display()),
				)
			})?;
		request.write_all(format!("{}\n", self.syncs).as_bytes())?;
		drop(request);
		let answer = format!("\x1b{ZLE_SYNC_TAG}{}\x07", self.syncs);
		let left = deadline.map_or(NO_DEADLINE, |d| d.saturating_duration_since(Instant::now()));
		self.read_until(answer, left).map(drop)
	}

	/// The terminal side, opened anew (not as a controlling terminal) to
	/// query it.
	fn open_tty(&self) -> io::Result<fs::File> {
		fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
			.open(&self.tty)
	}

	/// The screen, with all output so far.
	///
	/// # Panics
	///
	/// When an answer to the program cannot be written.
	pub fn screen(&mut self) -> &Screen {
		self.pump().expect("answering the terminal");
		&self.screen
	}

	/// Every output byte so far, lossily decoded.
	#[must_use]
	pub fn output(&self) -> String {
		String::from_utf8_lossy(&self.shared.state.lock().unwrap().0).into_owned()
	}

	/// Resize the screen model, then the terminal (the kernel sends
	/// `SIGWINCH` to its foreground process group): what the shell draws
	/// for the new size meets a model of that size. Call it when the shell
	/// waits with all its output read ([`Self::zle_sync`]): output written
	/// before the resize and read after it would be drawn at the new size.
	/// (Resizing the terminal first let a fast shell's redraw for the new
	/// size be fed to the model at the old one.)
	///
	/// # Errors
	///
	/// When the size cannot be set.
	pub fn resize(&mut self, rows: u16, cols: u16) -> io::Result<()> {
		self.pump()?;
		self.screen.resize(rows, cols);
		tty::set_window_size(self.master.as_raw_fd(), TtyInfo { rows, cols })
	}

	/// Send `signal` to the shell's process.
	///
	/// # Errors
	///
	/// When `kill` fails.
	pub fn signal(&self, signal: i32) -> io::Result<()> {
		// SAFETY: kill takes integer ids.
		if unsafe { libc::kill(self.pid(), signal) } == -1 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	/// Send `signal` to the terminal's foreground process group (what the
	/// line discipline does for `^C`, `^\`, `^Z` with `ISIG`).
	///
	/// # Errors
	///
	/// When the group cannot be read or signalled.
	pub fn signal_foreground(&self, signal: i32) -> io::Result<()> {
		let pgid = tty::foreground(self.master.as_raw_fd())?;
		// SAFETY: kill takes integer ids.
		if unsafe { libc::kill(-pgid, signal) } == -1 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	/// Wait until `programs` all run in the terminal's foreground process
	/// group, a job's and not the shell's: the command just typed has
	/// started every process the keys `^Z` and `^C` are meant to signal.
	///
	/// Where the foreground group cannot be read ([`foreground_group`]),
	/// the wait is for `programs` all running, not stopped, in one group
	/// that is not the shell's. That is the same fact there: a job-control
	/// shell gives a job a group of its own, and each of the job's
	/// processes makes that group the terminal's foreground before it
	/// execs (zsh's `entersubsh`, obash's spawner), so a process that runs
	/// its program already has the terminal.
	///
	/// # Errors
	///
	/// When the group cannot be read, or `TimedOut` (with the output so
	/// far).
	pub fn wait_job_running(&mut self, programs: &[&str], timeout: Duration) -> io::Result<()> {
		let what = format!("{programs:?} running in the terminal's foreground");
		let shell = self.pid();
		self.wait_processes(timeout, &what, |fg, procs| {
			let running_in = |group: i32| {
				group != shell
					&& programs.iter().all(|p| {
						procs
							.iter()
							.any(|q| q.pgid == group && !q.stopped && q.comm == *p)
					})
			};
			match fg {
				Some(fg) => running_in(fg),
				None => procs.iter().any(|q| running_in(q.pgid)),
			}
		})
	}

	/// Wait until no process the shell started is left (dead processes the
	/// shell has not reaped yet are still listed, as zombies).
	///
	/// # Errors
	///
	/// `TimedOut` (with the output so far).
	pub fn wait_processes_gone(&mut self, timeout: Duration) -> io::Result<()> {
		self.wait_processes(timeout, "every process the shell started to be reaped", |_, procs| {
			procs.is_empty()
		})
	}

	/// Wait until `done` holds for the terminal's foreground process group
	/// (`None` where it cannot be read: [`foreground_group`]) and the
	/// processes the shell started (its descendants).
	fn wait_processes(
		&mut self,
		timeout: Duration,
		what: &str,
		mut done: impl FnMut(Option<i32>, &[Proc]) -> bool,
	) -> io::Result<()> {
		let deadline = Instant::now() + timeout;
		loop {
			self.pump()?;
			let fg = foreground_group(&self.master)?;
			if done(fg, &descendants(self.pid())?) {
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Err(self.timeout(what));
			}
			thread::sleep(Duration::from_millis(5));
		}
	}

	/// The terminal's modes now (as the shell left them).
	///
	/// # Errors
	///
	/// When they cannot be read.
	pub fn termios(&self) -> io::Result<pi_shell::bash::Termios> {
		tty::attrs(self.master.as_raw_fd())
	}

	/// Wait for the shell to exit (its output is fed to the screen).
	///
	/// # Errors
	///
	/// `TimedOut` (with the output so far) when it is still running.
	pub fn wait(&mut self, timeout: Duration) -> io::Result<ExitStatus> {
		let deadline = Instant::now() + timeout;
		loop {
			self.pump()?;
			if let Some(status) = self.status {
				return Ok(status);
			}
			if let Some(status) = self.child.try_wait()? {
				self.status = Some(status);
				// Let the reader drain what the shell wrote last.
				let _ = self.wait_output(Duration::from_millis(500), |_, hung_up, _| hung_up);
				self.pump()?;
				return Ok(status);
			}
			if Instant::now() >= deadline {
				return Err(self.timeout("the exit"));
			}
			thread::sleep(Duration::from_millis(10));
		}
	}
}

impl Drop for Pty {
	fn drop(&mut self) {
		if self.status.is_none() {
			// SAFETY: kill takes integer ids; the group is the session the
			// child leads.
			unsafe { libc::kill(-self.pid(), libc::SIGKILL) };
			let _ = self.child.wait();
		}
	}
}

/// The foreground process group of the terminal whose master is `master`
/// (`tcgetpgrp`), or `None` where the master does not answer: gVisor (GKE
/// Sandbox) gives `ENOTTY` for `TIOCGPGRP` on any descriptor of a terminal
/// that is not the caller's controlling terminal, the master included
/// (`ThreadGroup::ForegroundProcessGroup`,
/// `pkg/sentry/kernel/thread_group.go`), where Linux answers on the master to
/// anyone holding it.
fn foreground_group(master: &fs::File) -> io::Result<Option<i32>> {
	match tty::foreground(master.as_raw_fd()) {
		Ok(group) => Ok(Some(group)),
		Err(e) if e.raw_os_error() == Some(libc::ENOTTY) => Ok(None),
		Err(e) => Err(e),
	}
}

/// A process a shell started ([`descendants`]).
#[derive(Debug)]
struct Proc {
	/// Its process group.
	pgid:    i32,
	/// Stopped (by a signal).
	stopped: bool,
	/// Its command name (the program file's name, at most 15 bytes).
	comm:    String,
}

/// The processes below `pid`: its children, theirs, and so on. Linux lists
/// each thread's children in `/proc/PID/task/TID/children`; where the
/// kernel has no such file for `pid`, every process's parent is read from
/// its `/proc/PID/stat` instead.
///
/// # Errors
///
/// When `pid`'s children cannot be read: an empty list would read as
/// "nothing left".
#[cfg(target_os = "linux")]
fn descendants(pid: i32) -> io::Result<Vec<Proc>> {
	match fs::metadata(format!("/proc/{pid}/task/{pid}/children")) {
		Ok(_) => {},
		Err(e) if e.kind() == io::ErrorKind::NotFound => return descendants_by_parent(pid),
		Err(e) => return Err(e),
	}
	let mut out = Vec::new();
	let mut todo = vec![pid];
	while let Some(p) = todo.pop() {
		// A process below the shell may have exited meanwhile, and so may a
		// thread of any of them; of the shell's own, one must be read.
		let Ok(tasks) = fs::read_dir(format!("/proc/{p}/task")) else {
			continue;
		};
		let mut read_one = false;
		for task in tasks.flatten() {
			let Ok(kids) = fs::read_to_string(task.path().join("children")) else {
				continue;
			};
			read_one = true;
			for kid in kids
				.split_whitespace()
				.filter_map(|k| k.parse::<i32>().ok())
			{
				if let Some((proc, _)) = proc_stat(kid) {
					out.push(proc);
					todo.push(kid);
				}
			}
		}
		if p == pid && !read_one && fs::metadata(format!("/proc/{pid}")).is_ok() {
			return Err(io::Error::other(format!("no /proc/{pid}/task/*/children could be read")));
		}
	}
	Ok(out)
}

/// [`descendants`] from every process's parent (`/proc/PID/stat`).
#[cfg(target_os = "linux")]
fn descendants_by_parent(pid: i32) -> io::Result<Vec<Proc>> {
	let mut by_parent: std::collections::HashMap<i32, Vec<(i32, Proc)>> =
		std::collections::HashMap::new();
	for entry in fs::read_dir("/proc")?.flatten() {
		let Some(p) = entry
			.file_name()
			.to_str()
			.and_then(|n| n.parse::<i32>().ok())
		else {
			continue;
		};
		if let Some((proc, parent)) = proc_stat(p) {
			by_parent.entry(parent).or_default().push((p, proc));
		}
	}
	let mut out = Vec::new();
	let mut todo = vec![pid];
	while let Some(p) = todo.pop() {
		for (kid, proc) in by_parent.remove(&p).unwrap_or_default() {
			out.push(proc);
			todo.push(kid);
		}
	}
	Ok(out)
}

/// Process `pid` as `/proc/PID/stat` gives it, and its parent; `None` when
/// it is gone.
#[cfg(target_os = "linux")]
fn proc_stat(pid: i32) -> Option<(Proc, i32)> {
	// `PID (COMM) STATE PPID PGRP …`; COMM may hold spaces.
	let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
	let (open, close) = (stat.find('(')?, stat.rfind(')')?);
	let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
	let state = rest.first()?;
	let parent = rest.get(1)?.parse().ok()?;
	let pgid = rest.get(2)?.parse().ok()?;
	Some((Proc { pgid, stopped: *state == "T", comm: stat[open + 1..close].to_owned() }, parent))
}

/// The processes below `pid`: its children, theirs, and so on
/// (`proc_listchildpids`, `proc_pidinfo`).
///
/// # Errors
///
/// None here; the Linux version's signature.
#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps, reason = "the Linux version can fail")]
fn descendants(pid: i32) -> io::Result<Vec<Proc>> {
	/// `SSTOP` of `<sys/proc.h>`: stopped.
	const SSTOP: u32 = 4;
	let mut out = Vec::new();
	let mut todo = vec![pid];
	while let Some(p) = todo.pop() {
		let mut kids = vec![0 as libc::pid_t; 256];
		let size =
			libc::c_int::try_from(kids.len() * std::mem::size_of::<libc::pid_t>()).unwrap_or(0);
		// SAFETY: `kids` has room for `size` bytes.
		let n = unsafe { libc::proc_listchildpids(p, kids.as_mut_ptr().cast(), size) };
		let n = usize::try_from(n).unwrap_or(0).min(kids.len());
		for &kid in &kids[..n] {
			let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
			let want = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).unwrap_or(0);
			// SAFETY: `info` has room for one `proc_bsdinfo`.
			let got = unsafe {
				libc::proc_pidinfo(kid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), want)
			};
			if got != want {
				continue;
			}
			// SAFETY: proc_pidinfo filled it.
			let info = unsafe { info.assume_init() };
			let comm: Vec<u8> = info
				.pbi_comm
				.iter()
				.take_while(|&&c| c != 0)
				.map(|&c| c as u8)
				.collect();
			out.push(Proc {
				pgid:    i32::try_from(info.pbi_pgid).unwrap_or(-1),
				stopped: info.pbi_status == SSTOP,
				comm:    String::from_utf8_lossy(&comm).into_owned(),
			});
			todo.push(kid);
		}
	}
	Ok(out)
}

/// Run the same session against obash and the real zsh: `drive` gets each
/// [`Pty`] in turn; the final screens, obash's first.
///
/// # Errors
///
/// The first failure of either run.
pub fn differential(
	obash: Spawn,
	zsh: Spawn,
	mut drive: impl FnMut(&mut Pty) -> io::Result<()>,
) -> io::Result<(String, String)> {
	let mut screens = Vec::with_capacity(2);
	for spawn in [obash, zsh] {
		let mut pty = spawn.spawn()?;
		drive(&mut pty)?;
		screens.push(pty.screen().contents());
	}
	let zsh = screens.pop().unwrap_or_default();
	let obash = screens.pop().unwrap_or_default();
	Ok((obash, zsh))
}

/// Bytes typed on terminal `tty` that no reader has taken yet.
fn unread(tty: &fs::File) -> io::Result<usize> {
	let mut n: libc::c_int = 0;
	// The ioctl request's integer type differs between platforms.
	let fionread = libc::FIONREAD as _;
	// SAFETY: FIONREAD stores an int through the pointer.
	if unsafe { libc::ioctl(tty.as_raw_fd(), fionread, &raw mut n) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(usize::try_from(n).unwrap_or(0))
}

/// The terminal side of a fresh pty, for tests that need a bare one.
///
/// # Errors
///
/// When no pty can be opened.
pub fn open_pty(rows: u16, cols: u16) -> io::Result<(OwnedFd, OwnedFd)> {
	let (master, slave, _) = tty::open_pty(Some(TtyInfo { rows, cols }))?;
	Ok((master, slave))
}
