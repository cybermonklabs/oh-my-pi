//! The OS pipe a pipeline's memory pipe becomes once an external takes one of
//! its ends ([`Host::os_pipe`](crate::bash::Host::os_pipe)), so two external
//! stages share one kernel pipe, as bash's and zsh's do.
//!
//! Linux only. The pipe's two descriptors are ordinary blocking ones, and the
//! externals inherit them. The shell never reads or writes through them: when
//! the pipe is made it reopens each end once through `/proc/self/fd/N`, which
//! makes a new open file description of the same pipe, and sets that one
//! non-blocking. Every engine handle of an end shares that description. A
//! stage of shell code then takes what the pipe holds or has room for and is
//! woken by the readiness thread for the rest, never waiting in the kernel,
//! while the descriptions the externals share stay blocking (`O_NONBLOCK`
//! belongs to the description). Each task waiting on an end keeps a readiness
//! wait of its own, so tasks polling one end with their own wakers (the
//! engine, an extra's fd, a host feed) do not take each other's wakeups.
//!
//! Where the private ends cannot be opened (no `/proc` mounted) no OS pipe is
//! made, and the memory pipe stays, pumped.
//!
//! Elsewhere there is no such private description: macOS's `/dev/fd/N` and the
//! BSDs' duplicate the descriptor and share its description, and Windows'
//! anonymous pipes cannot be polled. Those hosts keep the memory pipe, which
//! their pumps connect to each external: the stages then exchange bytes
//! through the shell's process, and lose them when it dies.

use crate::bash::File;

/// A new OS pipe already holding `prefill`: `(read, write)`.
///
/// See [`Host::os_pipe`](crate::bash::Host::os_pipe) for what the two ends
/// give. `None` when the pipe cannot be made, a private end cannot be opened,
/// or `prefill` does not fit in it.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	imp::os_pipe(prefill)
}

/// No OS pipe here (see the module docs): the memory pipe stays.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub fn os_pipe(_prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	None
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
	use std::{
		fs,
		io::{self, Read, SeekFrom, Write},
		os::{
			fd::{AsRawFd, OwnedFd, RawFd},
			unix::fs::OpenOptionsExt,
		},
		ptr,
		task::{Context, Poll, Waker},
	};

	use crate::{
		bash::{File, FileKind, OsHandle, Stat},
		sys::ready,
	};

	pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
		os_pipe_with(prefill, private)
	}

	/// [`os_pipe`] with the opener of private ends given, so a test can refuse
	/// them.
	fn os_pipe_with(
		prefill: &[u8],
		open: impl Fn(RawFd, bool) -> io::Result<fs::File>,
	) -> Option<(Box<dyn File>, Box<dyn File>)> {
		let (r, w) = io::pipe().ok()?;
		let (r, w) = (fs::File::from(OwnedFd::from(r)), fs::File::from(OwnedFd::from(w)));
		// The shell's private end of each, opened now, once: nothing is
		// opened later, so a stage of shell code cannot meet `EMFILE` midway.
		// Where they cannot be opened (no `/proc` mounted), the pipe stays in
		// memory, pumped: shared, it would fail the shell's own stages.
		let reads = Private::new(open(r.as_raw_fd(), false).ok()?, false);
		let writes = Private::new(open(w.as_raw_fd(), true).ok()?, true);
		// The only reader is ours, so a write that does not fit would wait
		// forever: the private end takes what fits, and anything left over
		// means this pipe cannot hold what the memory pipe had.
		let mut done = 0;
		while done < prefill.len() {
			match (&writes.file).write(&prefill[done..]) {
				Ok(n) if n > 0 => done += n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				_ => return None,
			}
		}
		Some((Box::new(Shared { file: r, own: reads }), Box::new(Shared { file: w, own: writes })))
	}

	/// The `revents` of `fd` for `events` right now (`poll(2)`, zero
	/// timeout); `POLLERR` and `POLLHUP` come whatever `events` asks.
	fn revents(fd: RawFd, events: i16) -> io::Result<i16> {
		let mut p = libc::pollfd { fd, events, revents: 0 };
		loop {
			// SAFETY: one valid pollfd; a zero timeout never waits.
			let n = unsafe { libc::poll(&raw mut p, 1, 0) };
			if n >= 0 {
				return Ok(if n > 0 { p.revents } else { 0 });
			}
			let e = io::Error::last_os_error();
			if e.kind() != io::ErrorKind::Interrupted {
				return Err(e);
			}
		}
	}

	/// `write(2)` of `buf` to `file`, reporting a pipe whose readers are all
	/// gone as `BrokenPipe` without raising `SIGPIPE`. The engine turns the
	/// error into the writing stage's own `SIGPIPE` (status 141), as bash's
	/// stage, a process of its own, dies of the real one; raised here it would
	/// end the whole shell, whose process the stage shares. `SIGPIPE` is
	/// blocked in this thread for the write, and the one an `EPIPE` raised is
	/// taken back unless one was already pending.
	fn write_quietly(mut file: &fs::File, buf: &[u8]) -> io::Result<usize> {
		// SAFETY: the sets are valid, zero-initialised `sigset_t`s filled by
		// the libc calls; the mask is restored before returning.
		unsafe {
			let mut pipe: libc::sigset_t = std::mem::zeroed();
			libc::sigemptyset(&raw mut pipe);
			libc::sigaddset(&raw mut pipe, libc::SIGPIPE);
			let mut pending: libc::sigset_t = std::mem::zeroed();
			libc::sigemptyset(&raw mut pending);
			let already = libc::sigpending(&raw mut pending) == 0
				&& libc::sigismember(&raw const pending, libc::SIGPIPE) == 1;
			let mut old: libc::sigset_t = std::mem::zeroed();
			libc::pthread_sigmask(libc::SIG_BLOCK, &raw const pipe, &raw mut old);
			let written = file.write(buf);
			if !already
				&& written
					.as_ref()
					.is_err_and(|e| e.raw_os_error() == Some(libc::EPIPE))
			{
				let now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
				while libc::sigtimedwait(&raw const pipe, ptr::null_mut(), &raw const now) < 0
					&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
				{}
			}
			libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, ptr::null_mut());
			written
		}
	}

	/// A new open file description of the pipe end `fd`, non-blocking and
	/// close-on-exec. Linux opens an anonymous pipe's write end even when no
	/// reader holds the pipe (its first write then fails with `EPIPE`); a
	/// kernel that refuses that open with `ENXIO`, as `open(2)` refuses it for
	/// a FIFO, gets `BrokenPipe`, which the write would have given.
	fn private(fd: RawFd, write: bool) -> io::Result<fs::File> {
		fs::OpenOptions::new()
			.read(!write)
			.write(write)
			.custom_flags(libc::O_NONBLOCK)
			.open(format!("/proc/self/fd/{fd}"))
			.map_err(|e| {
				if write && e.raw_os_error() == Some(libc::ENXIO) {
					io::ErrorKind::BrokenPipe.into()
				} else {
					e
				}
			})
	}

	/// One end of the pipe as the shell holds it: its blocking descriptor,
	/// which externals inherit ([`File::os_handle`]), and the private end
	/// opened with it, through which the shell reads or writes.
	struct Shared {
		file: fs::File,
		own:  Private,
	}

	impl File for Shared {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			self.own.poll_read(cx, buf)
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			self.own.poll_write(cx, buf)
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
			Err(io::Error::from_raw_os_error(libc::ESPIPE))
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			u64::try_from(self.file.as_raw_fd()).ok().map(OsHandle)
		}

		fn stat(&self) -> io::Result<Stat> {
			self.file.metadata().map(|m| crate::sys::fs::stat_of(&m))
		}

		/// Another private end, opened now (it can fail, `EMFILE`). The engine
		/// never asks: its handles of an end share this one's.
		fn dup(&self) -> io::Result<Box<dyn File>> {
			let write = self.own.write;
			Ok(Box::new(Private::new(private(self.file.as_raw_fd(), write)?, write)))
		}
	}

	/// A private non-blocking description of one end. Its I/O takes what is
	/// there and returns `Pending` for the rest, with the polling task's waker
	/// registered on the readiness thread.
	struct Private {
		/// One readiness wait per task waiting on this end, with its waker;
		/// declared first: forgotten by the readiness thread before the
		/// descriptor closes.
		waits: Vec<(Waker, ready::Watch)>,
		file:  fs::File,
		write: bool,
	}

	impl Private {
		const fn new(file: fs::File, write: bool) -> Self {
			Self { waits: Vec::new(), file, write }
		}

		/// Register `waker` for `events`, replacing only that task's earlier
		/// wait: every task waiting on this end keeps a wait of its own, as
		/// the memory pipe keeps every waiter.
		fn wait(&mut self, waker: &Waker, events: i16) -> io::Result<()> {
			self.waits.retain(|(w, _)| !w.will_wake(waker));
			let watch = ready::watch(self.file.as_raw_fd(), events, waker)?;
			self.waits.push((waker.clone(), watch));
			Ok(())
		}

		/// Bytes moved or the end failed: every other waiting task is woken to
		/// poll again (a needless wake costs one poll), and the waits are
		/// forgotten, as the memory pipe wakes all its waiters.
		fn wake_others(&mut self, waker: &Waker) {
			for (w, _watch) in self.waits.drain(..) {
				if !w.will_wake(waker) {
					w.wake();
				}
			}
		}

		/// `op` on the non-blocking descriptor; on `WouldBlock` the task's
		/// waker is registered for `events` and `op` tried once more, as
		/// readiness may have come before the registration.
		fn poll_io(
			&mut self,
			cx: &Context<'_>,
			events: i16,
			mut op: impl FnMut(&fs::File) -> io::Result<usize>,
		) -> Poll<io::Result<usize>> {
			let mut registered = false;
			loop {
				match op(&self.file) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
					r => {
						self.wake_others(cx.waker());
						return Poll::Ready(r);
					},
				}
				if registered {
					return Poll::Pending;
				}
				if let Err(e) = self.wait(cx.waker(), events) {
					return Poll::Ready(Err(e));
				}
				registered = true;
			}
		}

		/// A zero-length read or write asks whether the end is ready (`read -t
		/// 0`, `zselect`, an extra's empty write: `tail -f` and `reader_gone`
		/// ask whether the reader is gone): a non-blocking `read(2)` or
		/// `write(2)` of nothing returns at once, so `poll(2)` answers instead,
		/// as the memory pipe does: `Ok(0)` when ready, `Pending` (the task's
		/// waker registered) when not, and on the write end `BrokenPipe` once
		/// no reader is left (`POLLERR`).
		fn poll_ready(&mut self, cx: &Context<'_>, events: i16) -> Poll<io::Result<usize>> {
			let mut registered = false;
			loop {
				let revents = match revents(self.file.as_raw_fd(), events) {
					Ok(r) => r,
					Err(e) => return Poll::Ready(Err(e)),
				};
				if revents != 0 {
					self.waits.retain(|(w, _)| !w.will_wake(cx.waker()));
					if self.write && revents & libc::POLLERR != 0 {
						return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
					}
					return Poll::Ready(Ok(0));
				}
				if registered {
					return Poll::Pending;
				}
				if let Err(e) = self.wait(cx.waker(), events) {
					return Poll::Ready(Err(e));
				}
				registered = true;
			}
		}
	}

	impl File for Private {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			if self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if buf.is_empty() {
				return self.poll_ready(cx, ready::READ);
			}
			self.poll_io(cx, ready::READ, |mut f| f.read(buf))
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			if !self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if buf.is_empty() {
				return self.poll_ready(cx, ready::WRITE);
			}
			self.poll_io(cx, ready::WRITE, |f| write_quietly(f, buf))
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
			Err(io::Error::from_raw_os_error(libc::ESPIPE))
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		/// The external gets the blocking [`Shared`] descriptor, never this
		/// non-blocking one.
		fn os_handle(&self) -> Option<OsHandle> {
			None
		}

		fn stat(&self) -> io::Result<Stat> {
			self.file.metadata().map(|m| crate::sys::fs::stat_of(&m))
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self::new(private(self.file.as_raw_fd(), self.write)?, self.write)))
		}
	}

	#[cfg(test)]
	mod tests {
		use std::{
			io::{Read, Write},
			os::fd::FromRawFd,
			sync::{
				Arc,
				atomic::{AtomicBool, Ordering},
			},
			task::{Wake, Waker},
		};

		use super::*;

		fn noop() -> Context<'static> {
			Context::from_waker(Waker::noop())
		}

		fn nonblocking(file: &dyn File) -> bool {
			let fd = RawFd::try_from(file.os_handle().expect("a descriptor").0).unwrap();
			// SAFETY: F_GETFL only reads the flags of a descriptor the file owns.
			let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
			assert!(flags >= 0, "F_GETFL: {}", io::Error::last_os_error());
			flags & libc::O_NONBLOCK != 0
		}

		/// A borrowed copy of the descriptor an external would inherit.
		fn external(file: &dyn File) -> fs::File {
			let fd = RawFd::try_from(file.os_handle().expect("a descriptor").0).unwrap();
			// SAFETY: `dup` of a descriptor the file owns gives one we own.
			fs::File::from(unsafe { OwnedFd::from_raw_fd(libc::dup(fd)) })
		}

		#[derive(Default)]
		struct Flag(AtomicBool);

		impl Wake for Flag {
			fn wake(self: Arc<Self>) {
				self.0.store(true, Ordering::SeqCst);
			}
		}

		// Failure mode: the shell's own end shares the externals' open file
		// description, so making it non-blocking would make theirs
		// non-blocking too, or the shell's end blocks.
		#[test]
		fn the_shells_ends_are_nonblocking_and_the_externals_stay_blocking() {
			let (r, w) = os_pipe(b"").unwrap();
			let (mut rd, mut wd) = (r.dup().unwrap(), w.dup().unwrap());
			assert!(!nonblocking(r.as_ref()) && !nonblocking(w.as_ref()));
			// Fill the pipe through the shell's end: it takes what fits, then
			// waits without blocking this thread.
			let chunk = [7u8; 4096];
			let mut put = 0;
			while let Poll::Ready(n) = wd.poll_write(&mut noop(), &chunk) {
				put += n.unwrap();
				assert!(put < 16 << 20, "the pipe never filled");
			}
			assert!(put > 0);
			assert!(!nonblocking(r.as_ref()) && !nonblocking(w.as_ref()));
			// An external's read of the same pipe sees what the shell wrote.
			let mut got = vec![0u8; put];
			external(r.as_ref()).read_exact(&mut got).unwrap();
			assert!(got.iter().all(|&b| b == 7));
			// And the shell's read end sees what an external writes.
			external(w.as_ref()).write_all(b"from outside").unwrap();
			let mut buf = [0u8; 64];
			let Poll::Ready(Ok(n)) = rd.poll_read(&mut noop(), &mut buf) else {
				panic!("the bytes an external wrote are readable");
			};
			assert_eq!(&buf[..n], b"from outside");
		}

		// Failure mode: an empty pipe's read blocks the shell, or a
		// zero-length read reports end of file while a writer holds the pipe.
		#[test]
		fn an_empty_read_waits_and_wakes_once_bytes_come() {
			let (r, w) = os_pipe(b"").unwrap();
			let mut rd = r.dup().unwrap();
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let mut buf = [0u8; 8];
			assert!(rd.poll_read(&mut cx, &mut buf).is_pending());
			assert!(rd.poll_read(&mut cx, &mut []).is_pending(), "zero-length: not readable yet");
			external(w.as_ref()).write_all(b"x").unwrap();
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
			while !flag.0.load(Ordering::SeqCst) {
				assert!(std::time::Instant::now() < deadline, "the reader was not woken within 30 s");
				std::thread::sleep(std::time::Duration::from_millis(1));
			}
			assert!(matches!(rd.poll_read(&mut cx, &mut []), Poll::Ready(Ok(0))));
			assert!(matches!(rd.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(1))));
			drop(w);
			assert!(matches!(rd.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(0))), "end of file");
		}

		// Failure mode: bytes the memory pipe held are lost or reordered when
		// it becomes an OS pipe, or a prefill that does not fit blocks.
		#[test]
		fn the_prefill_comes_first_and_one_that_does_not_fit_is_refused() {
			let (r, w) = os_pipe(b"held ").unwrap();
			external(w.as_ref()).write_all(b"then more").unwrap();
			drop(w);
			let mut all = Vec::new();
			external(r.as_ref()).read_to_end(&mut all).unwrap();
			assert_eq!(all, b"held then more");
			let huge = vec![1u8; 16 << 20];
			assert!(os_pipe(&huge).is_none(), "16 MiB does not fit in a pipe");
		}

		// Failure mode: a shell write to a pipe nobody reads any more waits,
		// or succeeds, instead of failing as `EPIPE`.
		#[test]
		fn a_write_with_no_reader_left_is_a_broken_pipe() {
			let (r, w) = os_pipe(b"").unwrap();
			let mut wd = w.dup().unwrap();
			drop(r);
			let Poll::Ready(Err(e)) = wd.poll_write(&mut noop(), b"x") else {
				panic!("a write with no reader fails");
			};
			assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
			// A handle opened now finds no reader either way: the kernel may
			// refuse the open, or open it and fail the write.
			let late = match w.dup() {
				Ok(mut late) => match late.poll_write(&mut noop(), b"x") {
					Poll::Ready(Err(e)) => e.kind(),
					other => panic!("a late handle's write with no reader: {other:?}"),
				},
				Err(e) => e.kind(),
			};
			assert_eq!(late, io::ErrorKind::BrokenPipe);
		}

		/// Whether a `SIGPIPE` is pending for this thread; takes it if so.
		fn take_sigpipe() -> bool {
			// SAFETY: valid zeroed sets filled by libc; a zero timeout only
			// takes a signal already pending.
			unsafe {
				let mut set: libc::sigset_t = std::mem::zeroed();
				libc::sigemptyset(&raw mut set);
				libc::sigaddset(&raw mut set, libc::SIGPIPE);
				let now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
				libc::sigtimedwait(&raw const set, ptr::null_mut(), &raw const now) == libc::SIGPIPE
			}
		}

		// Failure mode: the write raises a real `SIGPIPE`, which would end the
		// whole shell (a stage of shell code shares its process) where bash's
		// stage alone dies of it. This thread blocks `SIGPIPE`, so one raised
		// here stays pending for it whatever the disposition (Linux queues a
		// blocked signal even when ignored), and other tests' writes cannot
		// raise it on this thread.
		#[test]
		fn a_broken_pipe_raises_no_sigpipe() {
			// SAFETY: valid sets; only this test thread's mask changes, and it
			// is restored below.
			let old = unsafe {
				let mut set: libc::sigset_t = std::mem::zeroed();
				libc::sigemptyset(&raw mut set);
				libc::sigaddset(&raw mut set, libc::SIGPIPE);
				let mut old: libc::sigset_t = std::mem::zeroed();
				libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, &raw mut old);
				old
			};
			let (r, w) = os_pipe(b"").unwrap();
			let fd = RawFd::try_from(w.os_handle().unwrap().0).unwrap();
			let plain = private(fd, true).unwrap();
			let mut wd = w.dup().unwrap();
			drop(r);
			assert!(!take_sigpipe(), "nothing pending before");
			// The control: a plain write raises one.
			assert_eq!((&plain).write(b"x").unwrap_err().raw_os_error(), Some(libc::EPIPE));
			assert!(take_sigpipe(), "a plain write to a pipe with no reader raises SIGPIPE");
			let Poll::Ready(Err(e)) = wd.poll_write(&mut noop(), b"x") else {
				panic!("a write with no reader fails");
			};
			assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
			let raised = take_sigpipe();
			// SAFETY: restores this thread's mask saved above.
			unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, ptr::null_mut()) };
			assert!(!raised, "the shell's write raised SIGPIPE");
		}

		// Failure mode: with no `/proc` the private ends cannot be opened, yet
		// the pipe is shared, and the shell's own stages then fail to read or
		// write it (an empty prefill opened no private end before the pipe was
		// handed out).
		#[test]
		fn no_private_ends_means_no_os_pipe() {
			let refuse =
				|_: RawFd, _: bool| -> io::Result<fs::File> { Err(io::ErrorKind::NotFound.into()) };
			assert!(os_pipe_with(b"", refuse).is_none(), "an empty prefill");
			assert!(os_pipe_with(b"x", refuse).is_none(), "a prefill");
			let refuse_reads = |fd: RawFd, write: bool| {
				if write {
					private(fd, write)
				} else {
					Err(io::ErrorKind::NotFound.into())
				}
			};
			assert!(os_pipe_with(b"", refuse_reads).is_none(), "only the write end opens");
		}
	}
}
