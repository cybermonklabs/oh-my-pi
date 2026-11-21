//! Programs a test writes and then runs: rcopy's stand-in `git` and
//! overlayfs's stand-in `fusermount3`.
//!
//! The test binary runs its tests as threads of one process. While this
//! process holds a file open for writing, every child another thread forks
//! gets a copy of that descriptor and keeps it until the child execs or
//! exits, and the kernel refuses to run a file someone holds open for writing
//! (`ETXTBSY`, "Text file busy"). So this process never opens a program for
//! writing: a child writes it, and no fork of this process can inherit a
//! descriptor that was never here.

use std::{cell::Cell, path::Path, process::Command};

thread_local! {
	/// Make [`write`] fork a child in the middle of its write, as a fork by
	/// another thread would, that keeps a copy of every descriptor this
	/// process then holds until [`end_lingering`].
	pub(crate) static LINGER: Cell<bool> = const { Cell::new(false) };

	/// The child [`LINGER`] made, if any.
	pub(crate) static LINGERING: Cell<Option<libc::pid_t>> = const { Cell::new(None) };
}

/// Writes `text` to `path`, mode 0755, through a child `sh`.
pub(crate) fn write(path: &Path, text: &str) {
	let mut writer = Command::new("/bin/sh")
		.args(["-c", "printf '%s' \"$2\" > \"$1\" && chmod 755 \"$1\"", "sh"])
		.arg(path)
		.arg(text)
		.spawn()
		.unwrap_or_else(|error| panic!("writing {}: {error}", path.display()));
	linger();
	let status = writer.wait().unwrap();
	assert!(status.success(), "writing {}: {status}", path.display());
}

/// With [`LINGER`] set on this thread, forks the child it asks for.
fn linger() {
	if !LINGER.get() {
		return;
	}
	// SAFETY: the child calls only `pause`, which is async-signal-safe, until
	// `end_lingering` kills it.
	let pid = unsafe { libc::fork() };
	assert!(pid >= 0, "fork: {}", std::io::Error::last_os_error());
	if pid == 0 {
		loop {
			// SAFETY: as above.
			unsafe { libc::pause() };
		}
	}
	LINGERING.set(Some(pid));
}

/// Kills and reaps the child [`LINGER`] made.
pub(crate) fn end_lingering() {
	if let Some(pid) = LINGERING.take() {
		// SAFETY: `pid` is this thread's own child, not yet reaped.
		unsafe {
			libc::kill(pid, libc::SIGKILL);
			libc::waitpid(pid, std::ptr::null_mut(), 0);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A program written while another thread forks still runs: the child
	/// forked in the middle of the write keeps every descriptor this process
	/// holds, and this process never held one on the program.
	#[test]
	fn a_child_forked_while_the_program_is_written_leaves_it_runnable() {
		let dir = std::env::temp_dir().join(format!("pi-iso-testprog-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).expect("create the program's directory");
		let program = dir.join("forked-while-written");
		LINGER.set(true);
		write(&program, "#!/bin/sh\nexit 7\n");
		LINGER.set(false);
		assert!(LINGERING.get().is_some(), "a child was forked during the write");
		let status = Command::new(&program).status();
		end_lingering();
		let _ = std::fs::remove_dir_all(&dir);
		assert_eq!(status.expect("run the program").code(), Some(7));
	}
}
