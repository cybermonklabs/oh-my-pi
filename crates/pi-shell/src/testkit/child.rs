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
