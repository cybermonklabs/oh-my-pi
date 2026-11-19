//! Fixture processes of a test: children that must still run when the test
//! looks at them, and must not outlive it.
//!
//! A test of what ends a process waits for that end, with no bound of its
//! own: a loaded host makes any bound wrong (`.config/nextest.toml`, which
//! fails a test whose event never comes after 4 minutes). So a fixture must
//! not end by itself while the test runs — [`LIFETIME`] is past that bound —
//! and must not survive the test, whether it passed, failed or was killed:
//! [`dies_with_this_process`] ends a direct child of the test with it, as
//! `kill_on_drop` cannot when the test process is killed.

use std::time::Duration;

/// How long a fixture process runs when nothing ends it.
///
/// Past the 4 minutes after which the test runner fails a test whose event
/// never came, and well inside the hour a stray process would otherwise sit
/// on a shared host.
pub const LIFETIME: Duration = Duration::from_secs(600);

/// Ends `command`'s child when this process ends, however it ends (Linux's
/// `PR_SET_PDEATHSIG`; on other Unixes the child is left to its own
/// [`LIFETIME`]).
///
/// The signal arrives when the *thread* that forked ends, so spawn from a
/// thread that lives as long as the test (any Tokio worker, or the test's
/// own thread).
#[cfg(unix)]
pub fn dies_with_this_process(command: &mut std::process::Command) -> &mut std::process::Command {
	use std::os::unix::process::CommandExt as _;

	// SAFETY: `pre_exec` runs in the forked child before its exec. `prctl`
	// is a plain syscall without pointer arguments, and async-signal-safe.
	unsafe {
		command.pre_exec(|| {
			set_pdeathsig();
			Ok(())
		})
	}
}

/// [`dies_with_this_process`] for a Tokio command.
#[cfg(unix)]
pub fn tokio_dies_with_this_process(
	command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
	// SAFETY: as for `dies_with_this_process`.
	unsafe {
		command.pre_exec(|| {
			set_pdeathsig();
			Ok(())
		})
	}
}

/// The first executable `name` on this process's `PATH`, as an absolute path.
///
/// A fixture's external program, wherever the machine keeps it (`/usr/bin`
/// on Debian, `/run/current-system/sw/bin` on NixOS), for a shell command
/// where the bare name would run the shell's builtin.
#[cfg(unix)]
pub fn on_path(name: &str) -> String {
	use std::os::unix::fs::PermissionsExt as _;

	let path = std::env::var_os("PATH").unwrap_or_default();
	std::env::split_paths(&path)
		.map(|dir| dir.join(name))
		.find(|file| {
			file.is_absolute()
				&& std::fs::metadata(file)
					.is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
		})
		.unwrap_or_else(|| panic!("no executable {name} on PATH"))
		.display()
		.to_string()
}

/// `sh` text that waits until the [`Gate`] on its fd 3 opens: it reads fd 3
/// to end of file. `sh` runs a TERM trap during the read.
#[cfg(unix)]
pub const AWAIT_GATE: &str = "while read -r _; do :; done <&3";

/// A gate a fixture process waits on ([`AWAIT_GATE`]).
///
/// A pipe whose write end only the test holds. The fixture reads the read
/// end to end of file, which comes when the test opens the gate
/// ([`Gate::open`]), or when the test process ends, however it ends: the
/// kernel closes the write end then. A fixture that waits for a file, or
/// loops, instead lives on after a killed test, as nothing ends a process
/// the shell started in a session of its own.
#[cfg(unix)]
#[derive(Debug)]
pub struct Gate {
	reader: std::fs::File,
	writer: Option<std::io::PipeWriter>,
}

#[cfg(unix)]
impl Gate {
	/// A closed gate.
	pub fn new() -> Self {
		let (reader, writer) = std::io::pipe().expect("the gate's pipe");
		Self { reader: std::fs::File::from(std::os::fd::OwnedFd::from(reader)), writer: Some(writer) }
	}

	/// A symlink at `path` to the read end (`/dev/fd/N` of this process),
	/// for a redirection the shell opens in this process: `sh x.sh 3< gate`.
	/// The shell takes `/dev/fd/N` itself for its own fd `N`, but opens the
	/// symlink on the host.
	pub fn link(&self, path: &std::path::Path) {
		use std::os::fd::AsRawFd as _;
		std::os::unix::fs::symlink(format!("/dev/fd/{}", self.reader.as_raw_fd()), path)
			.expect("the gate's symlink");
	}

	/// A copy of the read end, for a child's stdin.
	pub fn reader(&self) -> std::fs::File {
		self
			.reader
			.try_clone()
			.expect("a copy of the gate's read end")
	}

	/// Lets every fixture waiting on the gate go on.
	pub fn open(&mut self) {
		self.writer = None;
	}
}

#[cfg(unix)]
impl Default for Gate {
	fn default() -> Self {
		Self::new()
	}
}

/// Ask for `SIGKILL` when this child's parent thread ends (Linux only).
#[cfg(unix)]
#[cfg_attr(
	not(target_os = "linux"),
	expect(clippy::missing_const_for_fn, reason = "a syscall on Linux, nothing elsewhere")
)]
fn set_pdeathsig() {
	#[cfg(target_os = "linux")]
	// SAFETY: plain syscall without pointer arguments.
	unsafe {
		libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
	}
}
