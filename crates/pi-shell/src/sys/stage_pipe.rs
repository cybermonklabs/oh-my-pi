//! The OS pipe a pipeline's memory pipe becomes once an external takes one of
//! its ends ([`Host::os_pipe`](crate::bash::Host::os_pipe)), so two external
//! stages share one kernel pipe, as bash's and zsh's do.
//!
//! Linux only. The pipe's two descriptors are ordinary blocking ones, and the
//! externals inherit them. The shell never reads or writes through them: each
//! engine handle of an end reopens it through `/proc/self/fd/N`, which makes a
//! new open file description of the same pipe, and sets that one non-blocking.
//! A stage of shell code then takes what the pipe holds or has room for and is
//! woken by the readiness thread for the rest, never waiting in the kernel,
//! while the descriptions the externals share stay blocking (`O_NONBLOCK`
//! belongs to the description). Each handle has its own description and its
//! own readiness wait, so handles polled by different tasks do not take each
//! other's wakeups.
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
		task::{Context, Poll},
	};

	use crate::{
		bash::{File, FileKind, OsHandle, Stat},
		sys::ready,
	};

	pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
		let (r, w) = io::pipe().ok()?;
		let (read, write) =
			(Shared::new(OwnedFd::from(r), false), Shared::new(OwnedFd::from(w), true));
		if !prefill.is_empty() {
			// The only reader is ours, so a write that does not fit would wait
			// forever: the private end takes what fits, and anything left over
			// means this pipe cannot hold what the memory pipe had.
			let mut ours = private(write.file.as_raw_fd(), true).ok()?;
			let mut done = 0;
			while done < prefill.len() {
				match ours.write(&prefill[done..]) {
					Ok(n) if n > 0 => done += n,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					_ => return None,
				}
			}
		}
		Some((Box::new(read), Box::new(write)))
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

	/// One end of the pipe as the shell holds it for the externals: its
	/// blocking descriptor ([`File::os_handle`]). Each [`File::dup`] is a
	/// [`Private`] end; I/O on this end itself goes through one too.
	struct Shared {
		file:  fs::File,
		write: bool,
		/// The private end this one's own I/O uses, opened on first use.
		own:   Option<Private>,
	}

	impl Shared {
		fn new(fd: OwnedFd, write: bool) -> Self {
			Self { file: fs::File::from(fd), write, own: None }
		}

		fn own(&mut self) -> io::Result<&mut Private> {
			if self.own.is_none() {
				self.own = Some(Private::open(self.file.as_raw_fd(), self.write)?);
			}
			Ok(self.own.as_mut().expect("opened above"))
		}
	}

	impl File for Shared {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			if self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			match self.own() {
				Ok(own) => own.poll_read(cx, buf),
				Err(e) => Poll::Ready(Err(e)),
			}
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			if !self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			match self.own() {
				Ok(own) => own.poll_write(cx, buf),
				Err(e) => Poll::Ready(Err(e)),
			}
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

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Private::open(self.file.as_raw_fd(), self.write)?))
		}
	}

	/// An engine handle's own end: a private non-blocking description of the
	/// pipe. Its I/O takes what is there and returns `Pending` for the rest,
	/// with this handle's waker registered on the readiness thread.
	struct Private {
		/// Declared first: forgotten by the readiness thread before the
		/// descriptor closes.
		watch: Option<ready::Watch>,
		file:  fs::File,
		write: bool,
	}

	impl Private {
		fn open(fd: RawFd, write: bool) -> io::Result<Self> {
			Ok(Self { watch: None, file: private(fd, write)?, write })
		}

		/// `op` on the non-blocking descriptor; on `WouldBlock` the waker is
		/// registered for `events` (replacing the earlier wait) and `op` tried
		/// once more, as readiness may have come before the registration.
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
						self.watch = None;
						return Poll::Ready(r);
					},
				}
				if registered {
					return Poll::Pending;
				}
				self.watch = None;
				match ready::watch(self.file.as_raw_fd(), events, cx.waker()) {
					Ok(w) => self.watch = Some(w),
					Err(e) => return Poll::Ready(Err(e)),
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
				// A zero-length read asks whether the pipe is readable (`read
				// -t 0`, `zselect`): a non-blocking `read(2)` of nothing returns
				// at once, so readiness answers instead, as for a memory pipe.
				let fd = self.file.as_raw_fd();
				return match ready::now(fd, ready::READ) {
					Ok(true) => {
						self.watch = None;
						Poll::Ready(Ok(0))
					},
					Ok(false) => {
						self.watch = None;
						match ready::watch(fd, ready::READ, cx.waker()) {
							Ok(w) => self.watch = Some(w),
							Err(e) => return Poll::Ready(Err(e)),
						}
						match ready::now(fd, ready::READ) {
							Ok(true) => Poll::Ready(Ok(0)),
							Ok(false) => Poll::Pending,
							Err(e) => Poll::Ready(Err(e)),
						}
					},
					Err(e) => Poll::Ready(Err(e)),
				};
			}
			self.poll_io(cx, ready::READ, |mut f| f.read(buf))
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			if !self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if buf.is_empty() {
				return Poll::Ready(Ok(0));
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
			Ok(Box::new(Self::open(self.file.as_raw_fd(), self.write)?))
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
			while !flag.0.load(Ordering::SeqCst) {
				std::thread::yield_now();
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
	}
}
