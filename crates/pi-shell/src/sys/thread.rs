//! Helper threads that never take the shell's signals.
//!
//! A signal sent to the process is delivered to any thread that does not
//! block it. The shell's handlers only record a caught signal, and the run
//! loop forwards it to the engine; when a helper thread takes it, the
//! record can come after the main thread has already acted on something
//! that happened after the signal (a resize, then a key typed or a `zle
//! -F` file written). zsh is single-threaded: its handler has run before
//! it reads anything else. Every helper thread starts with all signals
//! blocked, so the main thread takes them.

use std::{io, thread};

/// Spawn `f` on a thread `builder` describes, with every signal blocked
/// there (the mask is set in the calling thread around the spawn, which
/// the new thread inherits, so no signal reaches it before it runs).
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
		let mut all: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: as above.
		let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: both sets are valid for the calls.
		unsafe {
			libc::sigfillset(&raw mut all);
			libc::pthread_sigmask(libc::SIG_BLOCK, &raw const all, &raw mut old);
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
