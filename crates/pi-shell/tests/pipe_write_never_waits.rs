//! A write to a pipe that nothing reads never waits on the thread that polls
//! it, on every platform: on Linux through a private non-blocking reopen of
//! the pipe, elsewhere (Darwin, Windows) through a writer thread of the
//! descriptor's own. Windows anonymous pipes cannot be polled, so a write
//! there that ran on the polling thread waited in the kernel until a reader
//! made room, which here never happens.

use std::{
	io,
	sync::mpsc::{RecvTimeoutError, channel},
	task::{Context, Poll, Waker},
	thread,
	time::Duration,
};

use pi_shell::{bash::File as _, sys::StdFile};

/// Ends the test process, naming `what`, unless the returned sender is
/// dropped within `limit`. The clock runs on a thread of its own: the call it
/// bounds may wait in the kernel on the test's thread.
fn deadline(what: &'static str, limit: Duration) -> std::sync::mpsc::Sender<()> {
	let (done, finished) = channel::<()>();
	thread::spawn(move || {
		if finished.recv_timeout(limit) == Err(RecvTimeoutError::Timeout) {
			eprintln!("DEADLINE fired: {what} did not return within {limit:?}");
			std::process::exit(1);
		}
	});
	done
}

#[cfg(unix)]
fn host_file(writer: io::PipeWriter) -> std::fs::File {
	std::fs::File::from(std::os::fd::OwnedFd::from(writer))
}

#[cfg(windows)]
fn host_file(writer: io::PipeWriter) -> std::fs::File {
	std::fs::File::from(std::os::windows::io::OwnedHandle::from(writer))
}

#[test]
fn a_write_to_a_pipe_nothing_reads_returns_pending_instead_of_waiting() {
	let (reader, writer) = io::pipe().expect("a pipe");
	let mut file = StdFile::new(host_file(writer));
	let mut cx = Context::from_waker(Waker::noop());
	let chunk = vec![b'x'; 64 << 10];
	let finished = deadline("a write to a pipe nothing reads", Duration::from_secs(10));
	let mut written = 0usize;
	loop {
		match file.poll_write(&mut cx, &chunk) {
			Poll::Ready(Ok(n)) => written += n,
			Poll::Ready(Err(e)) => panic!("a write to a pipe nothing reads failed: {e}"),
			Poll::Pending => break,
		}
		assert!(written < 64 << 20, "{written} bytes taken and never Pending");
	}
	drop(finished);
	drop(reader);
}
