//! Helper threads that never take the shell's signals.
//!
//! A signal sent to the process is delivered to any thread that does not
//! block it. The shell's handlers only record a caught signal, and the run
//! loop forwards it to the engine; when a helper thread takes it, the
//! record can come after the main thread has already acted on something
//! that happened after the signal (a resize, then a key typed or a `zle
//! -F` file written). zsh is single-threaded: its handler has run before
//! it reads anything else. Every helper thread starts with the signals
//! blocked, so the main thread takes them, except those a fault raises in
//! the faulting thread itself ([`FAULTS`]).

use std::{io, thread};

/// The signals a fault raises in the thread that faults: never blocked on
/// a helper thread.
///
/// Linux delivers such a signal with its default action when the thread
/// blocks it, so the process would die without Rust's stack-overflow
/// report (these threads run on small stacks) or an embedding runtime's
/// crash handler.
#[cfg(unix)]
const FAULTS: [libc::c_int; 6] =
	[libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGFPE, libc::SIGTRAP, libc::SIGSYS];

/// Spawn `f` on a thread `builder` describes, with every signal but
/// [`FAULTS`] blocked there.
///
/// The mask is set in the calling thread around the spawn, which the new
/// thread inherits, so no signal reaches it before it runs.
///
/// # Errors
///
/// When the thread cannot be created.
pub fn spawn_helper<F, T>(builder: thread::Builder, f: F) -> io::Result<thread::JoinHandle<T>>
where
	F: FnOnce() -> T + Send + 'static,
	T: Send + 'static,
{
	#[cfg(unix)]
	{
		// SAFETY: plain data, initialized by sigfillset / pthread_sigmask.
		let mut blocked: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: as above.
		let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: both sets are valid for the calls, and each signal number
		// is a valid one.
		unsafe {
			libc::sigfillset(&raw mut blocked);
			for sig in FAULTS {
				libc::sigdelset(&raw mut blocked, sig);
			}
			libc::pthread_sigmask(libc::SIG_BLOCK, &raw const blocked, &raw mut old);
		}
		let spawned = builder.spawn(f);
		// SAFETY: restores the mask saved above.
		unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut()) };
		spawned
	}
	#[cfg(not(unix))]
	{
		builder.spawn(f)
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::*;

	/// A helper thread blocks the shell's signals and none a fault raises.
	#[test]
	fn a_helper_thread_blocks_the_shells_signals_but_not_the_fault_signals() {
		let mask = spawn_helper(thread::Builder::new(), || {
			// SAFETY: plain data, filled by pthread_sigmask.
			let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
			// SAFETY: a null new set only reads the thread's mask.
			unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &raw mut mask) };
			mask
		})
		.expect("spawn a helper thread")
		.join()
		.expect("the helper thread returns");
		// SAFETY: `mask` was filled by pthread_sigmask.
		let blocked = |sig| unsafe { libc::sigismember(&raw const mask, sig) } == 1;
		for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGWINCH, libc::SIGCHLD] {
			assert!(blocked(sig), "signal {sig} is not blocked");
		}
		for sig in FAULTS {
			assert!(!blocked(sig), "fault signal {sig} is blocked");
		}
	}
}
