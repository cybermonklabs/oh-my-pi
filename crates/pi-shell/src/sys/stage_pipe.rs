//! The OS pipe a pipeline's memory pipe becomes once an external takes one of
//! its ends ([`Host::os_pipe`](crate::bash::Host::os_pipe)), so two external
//! stages share one kernel pipe, as bash's and zsh's do.
//!
//! Linux and macOS: the pipe's two descriptors are ordinary blocking ones, and
//! the externals inherit them. The shell never reads or writes through them:
//! when the pipe is made it opens a second, non-blocking open file
//! description of each end, and every engine handle of an end shares that
//! description. A stage of shell code reads what the pipe holds and is woken
//! by the readiness thread for the rest, never waiting in the kernel on the
//! engine's thread, while the descriptions the externals share stay blocking
//! (`O_NONBLOCK` belongs to the description). All the tasks waiting for an
//! end to poll ready (the engine's vprocs, which share one waker, an extra's
//! fd, a host feed) are woken together, as the memory pipe wakes all its
//! waiters, and a waiting task is only ever forgotten by waking it. On Linux
//! a write the pipe cannot take now is made by the write end's own thread
//! through a blocking description, which the kernel wakes only once the
//! write fits (`sys::room`): polling writable does not mean that under
//! gVisor, and waking for each byte a slow reader frees costs a CPU there.
//! macOS has no such thread (no second description of its unlinked FIFO can
//! be opened): there a write the pipe cannot take now waits for the end to
//! select writable.
//!
//! - Linux: an anonymous pipe, whose ends are reopened once through
//!   `/proc/self/fd/N`. Where they cannot be (no `/proc` mounted) no OS pipe is
//!   made, and the memory pipe stays, pumped.
//! - macOS: `/dev/fd/N` there duplicates the descriptor and shares its
//!   description, so the pipe is a FIFO, made in a private directory under the
//!   temporary directory and opened twice per end (the externals' blocking
//!   descriptions and the shell's non-blocking ones), then unlinked with its
//!   directory before anyone gets an end. Where it cannot be made, the memory
//!   pipe stays. The shell's write description has `F_SETNOSIGPIPE`, as macOS
//!   sends a write's `SIGPIPE` to the whole process.
//! - Windows: see [`windows`].
//!
//! Elsewhere (the BSDs) there is no such private description: those hosts
//! keep the memory pipe, which their pumps connect to each external. The
//! stages then exchange bytes through the shell's process, and lose them when
//! it dies.

use crate::bash::File;

#[cfg(windows)]
mod windows;

/// A new OS pipe already holding `prefill`: `(read, write)`.
///
/// See [`Host::os_pipe`](crate::bash::Host::os_pipe) for what the two ends
/// give. `None` when the pipe cannot be made, a private end cannot be opened,
/// or `prefill` does not fit in it.
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	imp::os_pipe(prefill)
}

/// A new OS pipe already holding `prefill` (see [`windows`]).
#[cfg(windows)]
pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	windows::os_pipe(prefill)
}

/// No OS pipe here (see the module docs): the memory pipe stays.
#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
pub fn os_pipe(_prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	None
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
mod imp {
	use std::{
		fs,
		io::{self, Read, SeekFrom, Write},
		os::{
			fd::{AsRawFd, OwnedFd, RawFd},
			unix::fs::OpenOptionsExt,
		},
		ptr,
		sync::Arc,
		task::{Context, Poll, Waker},
	};

	#[cfg(any(target_os = "linux", target_os = "android"))]
	use crate::sys::room::Room;
	use crate::{
		bash::{File, FileKind, OsHandle, Stat},
		sys::{ready, wakers::Wakers},
	};

	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
		os_pipe_with(prefill, private)
	}

	#[cfg(target_os = "macos")]
	pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
		fifo_pipe(&std::env::temp_dir(), prefill)
	}

	/// [`os_pipe`] with the opener of private ends given, so a test can refuse
	/// them.
	#[cfg(any(target_os = "linux", target_os = "android"))]
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

	/// macOS: the pipe is a FIFO made in a private directory under `tmp`
	/// (see the module docs). `None` when it cannot be made or opened, or
	/// `prefill` does not fit in it (a FIFO holds 8 KiB there).
	#[cfg(target_os = "macos")]
	fn fifo_pipe(tmp: &std::path::Path, prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
		let [ours_read, ours_write, theirs_read, theirs_write] = fifo_descriptions(tmp).ok()?;
		// SAFETY: fcntl on a descriptor we own; the flag is its
		// description's, which only the shell's ends share.
		if unsafe { libc::fcntl(ours_write.as_raw_fd(), libc::F_SETNOSIGPIPE, 1) } < 0 {
			return None;
		}
		// The only reader is ours, so a write that does not fit would wait
		// forever: the private end takes what fits, and anything left over
		// means this pipe cannot hold what the memory pipe had.
		let mut done = 0;
		while done < prefill.len() {
			match (&ours_write).write(&prefill[done..]) {
				Ok(n) if n > 0 => done += n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				_ => return None,
			}
		}
		let reads = Private::new(ours_read, false);
		let writes = Private::new(ours_write, true);
		Some((
			Box::new(Shared { file: theirs_read, own: reads }),
			Box::new(Shared { file: theirs_write, own: writes }),
		))
	}

	/// Four open file descriptions of a new FIFO: the shell's non-blocking
	/// read and write ones, then the externals' blocking read and write ones.
	/// The FIFO and its directory (mode 0700, under `tmp`) are removed before
	/// this returns, whatever the outcome; the pipe lives on in its open
	/// descriptions, all close-on-exec.
	#[cfg(target_os = "macos")]
	fn fifo_descriptions(tmp: &std::path::Path) -> io::Result<[fs::File; 4]> {
		use std::{
			ffi::{CString, OsString},
			os::unix::ffi::{OsStrExt, OsStringExt},
			path::PathBuf,
		};
		let template = CString::new(tmp.join("obash-pipe.XXXXXX").as_os_str().as_bytes())?;
		let mut name = template.into_bytes_with_nul();
		// SAFETY: `name` is a NUL-terminated template that `mkdtemp` fills in
		// place.
		if unsafe { libc::mkdtemp(name.as_mut_ptr().cast()) }.is_null() {
			return Err(io::Error::last_os_error());
		}
		name.pop();
		let dir = PathBuf::from(OsString::from_vec(name));
		let fifo = dir.join("pipe");
		let opened = (|| {
			let path = CString::new(fifo.as_os_str().as_bytes())?;
			// SAFETY: a NUL-terminated path.
			if unsafe { libc::mkfifo(path.as_ptr(), 0o600) } < 0 {
				return Err(io::Error::last_os_error());
			}
			let open = |write: bool| {
				fs::OpenOptions::new()
					.read(!write)
					.write(write)
					.custom_flags(libc::O_NONBLOCK)
					.open(&fifo)
			};
			// The shell's read end first: a FIFO's non-blocking read open
			// needs no writer, and every write open after it finds a reader
			// (one with none fails with `ENXIO`).
			let ours_read = open(false)?;
			let ours_write = open(true)?;
			let theirs_read = blocking(open(false)?)?;
			let theirs_write = blocking(open(true)?)?;
			Ok([ours_read, ours_write, theirs_read, theirs_write])
		})();
		let _ = fs::remove_file(&fifo);
		let _ = fs::remove_dir(&dir);
		opened
	}

	/// `file` with `O_NONBLOCK` cleared on its description.
	#[cfg(target_os = "macos")]
	fn blocking(file: fs::File) -> io::Result<fs::File> {
		let fd = file.as_raw_fd();
		// SAFETY: fcntl on a descriptor we own, of a description only it has.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		// SAFETY: as above.
		if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(file)
	}

	/// The `revents` of `fd` for `events` right now (`poll(2)`, zero
	/// timeout); `POLLERR` and `POLLHUP` come whatever `events` asks.
	#[cfg(any(target_os = "linux", target_os = "android"))]
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

	/// The `revents` of `fd` for `events` right now. macOS `poll(2)` reports
	/// neither a FIFO's end of file nor a gone reader (measured), so readiness
	/// is `select(2)`'s ([`ready::now`]), and an empty `write(2)` tells a gone
	/// reader (`POLLERR`): on the shell's write description, which has
	/// `F_SETNOSIGPIPE`, it fails with `EPIPE` and raises no signal.
	#[cfg(target_os = "macos")]
	fn revents(fd: RawFd, events: i16) -> io::Result<i16> {
		if events == ready::WRITE {
			// SAFETY: a write of no bytes from no buffer.
			if unsafe { libc::write(fd, ptr::null(), 0) } < 0 {
				let e = io::Error::last_os_error();
				if e.raw_os_error() == Some(libc::EPIPE) {
					return Ok(libc::POLLERR);
				}
				if !matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) {
					return Err(e);
				}
			}
		}
		Ok(if ready::now(fd, events)? { events } else { 0 })
	}

	/// `write(2)` of `buf` to `file`, reporting a pipe whose readers are all
	/// gone as `BrokenPipe` without raising `SIGPIPE`. The engine turns the
	/// error into the writing stage's own `SIGPIPE` (status 141), as bash's
	/// stage, a process of its own, dies of the real one; raised here it would
	/// end the whole shell, whose process the stage shares. `SIGPIPE` is
	/// blocked in this thread for the write, and the one an `EPIPE` raised is
	/// taken back unless one was already pending.
	#[cfg(any(target_os = "linux", target_os = "android"))]
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

	/// `write(2)` of `buf` to `file`, the shell's write description, which has
	/// `F_SETNOSIGPIPE` ([`fifo_pipe`]): a pipe whose readers are all gone
	/// reports `EPIPE` (`BrokenPipe`) and raises no `SIGPIPE`, which macOS
	/// would send to the whole process. The engine turns the error into the
	/// writing stage's own `SIGPIPE` (status 141).
	#[cfg(target_os = "macos")]
	fn write_quietly(mut file: &fs::File, buf: &[u8]) -> io::Result<usize> {
		file.write(buf)
	}

	/// A new open file description of the pipe end `fd`, non-blocking and
	/// close-on-exec. Linux opens an anonymous pipe's write end even when no
	/// reader holds the pipe (its first write then fails with `EPIPE`); a
	/// kernel that refuses that open with `ENXIO`, as `open(2)` refuses it for
	/// a FIFO, gets `BrokenPipe`, which the write would have given.
	#[cfg(any(target_os = "linux", target_os = "android"))]
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

	/// Another descriptor of the shell's own non-blocking description `fd` of
	/// a pipe end, close-on-exec: macOS cannot open a second description of
	/// an unlinked FIFO.
	#[cfg(target_os = "macos")]
	fn private(fd: RawFd, _write: bool) -> io::Result<fs::File> {
		use std::os::fd::FromRawFd;
		// SAFETY: duplicates a descriptor the caller holds open.
		let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
		if new < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		Ok(fs::File::from(unsafe { OwnedFd::from_raw_fd(new) }))
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
			// Linux opens it from the externals' descriptor; macOS duplicates
			// the shell's own.
			let from = if cfg!(target_os = "macos") {
				&self.own.file
			} else {
				&self.file
			};
			Ok(Box::new(Private::new(private(from.as_raw_fd(), write)?, write)))
		}
	}

	/// A private non-blocking description of one end. Its reads take what is
	/// there and return `Pending` for the rest, with the polling task's waker
	/// stored until the end is readable; on Linux a write that would wait is
	/// made by the end's `Room` thread, which the kernel wakes once it fits,
	/// and on macOS it waits for the end to select writable.
	struct Private {
		/// Declared first: the readiness thread forgets its watch before the
		/// descriptor closes.
		ready: Ready,
		/// A write end's thread for writes that would wait; `None` on a read
		/// end, or where none could be made (the write then waits for the end
		/// to poll writable).
		#[cfg(any(target_os = "linux", target_os = "android"))]
		room:  Option<Room>,
		file:  fs::File,
		write: bool,
		/// macOS: a read of this end met end of file. A FIFO there stops
		/// selecting readable once one has (measured), and no writer can come
		/// back to an unlinked FIFO whose writers are all gone.
		#[cfg(target_os = "macos")]
		ended: bool,
	}

	/// The tasks waiting for a private end to poll ready, all woken together,
	/// as the memory pipe wakes all its waiters ([`Wakers`]: a task is only
	/// ever forgotten by being woken, so the engine's one waker, which stands
	/// for every engine vproc, never loses one of their waits). One readiness
	/// watch, registered when the first task is stored, wakes them.
	#[derive(Default)]
	struct Ready {
		tasks: Arc<Wakers>,
		watch: Option<ready::Watch>,
	}

	impl Private {
		fn new(file: fs::File, write: bool) -> Self {
			#[cfg(any(target_os = "linux", target_os = "android"))]
			let room = if write {
				Room::new(file.as_raw_fd()).ok()
			} else {
				None
			};
			Self {
				ready: Ready::default(),
				#[cfg(any(target_os = "linux", target_os = "android"))]
				room,
				file,
				write,
				#[cfg(target_os = "macos")]
				ended: false,
			}
		}

		/// Store `waker` among the tasks waiting for this end to poll ready:
		/// readable, or writable (or no reader left) on the write end.
		fn wait(&mut self, waker: &Waker) -> io::Result<()> {
			let Ready { tasks, watch } = &mut self.ready;
			if tasks.add(waker) {
				// Nothing watches the end: the last watch fired, or there was
				// none.
				*watch = None;
				let events = if self.write {
					ready::WRITE
				} else {
					ready::READ
				};
				match ready::watch(self.file.as_raw_fd(), events, &Waker::from(Arc::clone(tasks))) {
					Ok(w) => *watch = Some(w),
					Err(e) => {
						// No wait can be registered: every stored task polls
						// again and meets the error itself.
						for w in tasks.take() {
							w.wake();
						}
						return Err(e);
					},
				}
			}
			Ok(())
		}

		/// `op` on the non-blocking descriptor; on `WouldBlock` the task's
		/// waker is stored and `op` tried once more, as the end may have become
		/// ready before the wait was registered. Success removes no waiter: a
		/// task that waited and then went on gets one spurious wake.
		fn poll_io(
			&mut self,
			cx: &Context<'_>,
			mut op: impl FnMut(&fs::File) -> io::Result<usize>,
		) -> Poll<io::Result<usize>> {
			let mut registered = false;
			loop {
				match op(&self.file) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
					r => return Poll::Ready(r),
				}
				if registered {
					return Poll::Pending;
				}
				if let Err(e) = self.wait(cx.waker()) {
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
		/// waker stored) when not, and on the write end `BrokenPipe` once no
		/// reader is left (`POLLERR`).
		fn poll_ready(&mut self, cx: &Context<'_>) -> Poll<io::Result<usize>> {
			#[cfg(target_os = "macos")]
			if self.ended {
				return Poll::Ready(Ok(0));
			}
			let events = if self.write {
				ready::WRITE
			} else {
				ready::READ
			};
			let mut registered = false;
			loop {
				let revents = match revents(self.file.as_raw_fd(), events) {
					Ok(r) => r,
					Err(e) => return Poll::Ready(Err(e)),
				};
				if revents != 0 {
					if self.write && revents & libc::POLLERR != 0 {
						return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
					}
					return Poll::Ready(Ok(0));
				}
				if registered {
					return Poll::Pending;
				}
				if let Err(e) = self.wait(cx.waker()) {
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
				return self.poll_ready(cx);
			}
			let read = self.poll_io(cx, |mut f| f.read(buf));
			#[cfg(target_os = "macos")]
			if matches!(read, Poll::Ready(Ok(0))) {
				self.ended = true;
			}
			read
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			if !self.write {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if buf.is_empty() {
				return self.poll_ready(cx);
			}
			// A write that would wait is made by the end's thread, which the
			// kernel wakes once it fits (`sys::room`); on macOS it waits for
			// the end to select writable.
			#[cfg(any(target_os = "linux", target_os = "android"))]
			if let Some(room) = &self.room {
				let file = &self.file;
				return room.poll_write(cx, buf, |b| write_quietly(file, b));
			}
			self.poll_io(cx, |f| write_quietly(f, buf))
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
			// On Linux the write that waited is made by the end's thread once
			// the reader takes the rest, so the reader sees it here too; on
			// macOS it waits for the shell to poll again, and the reader takes
			// it after that.
			#[cfg(any(target_os = "linux", target_os = "android"))]
			let waited = chunk.len();
			#[cfg(target_os = "macos")]
			let waited = 0;
			let mut got = vec![0u8; put + waited];
			external(r.as_ref()).read_exact(&mut got).unwrap();
			assert!(got.iter().all(|&b| b == 7));
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
			loop {
				match wd.poll_write(&mut noop(), &chunk) {
					Poll::Ready(Ok(n)) => break assert_eq!(n, chunk.len()),
					Poll::Ready(Err(e)) => panic!("the write that waited: {e}"),
					Poll::Pending => {
						assert!(std::time::Instant::now() < deadline, "its result not within 30 s");
						std::thread::sleep(std::time::Duration::from_millis(1));
					},
				}
			}
			let mut rest = vec![0u8; chunk.len() - waited];
			external(r.as_ref()).read_exact(&mut rest).unwrap();
			assert!(rest.iter().all(|&b| b == 7));
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

		// Failure mode: once a read met end of file, an empty read (`read -t
		// 0`) waits instead of answering at once (a macOS FIFO stops selecting
		// readable after that read).
		#[test]
		fn an_empty_read_after_end_of_file_is_ready() {
			let (mut r, w) = os_pipe(b"x").unwrap();
			drop(w);
			let mut buf = [0u8; 8];
			assert!(matches!(r.poll_read(&mut noop(), &mut buf), Poll::Ready(Ok(1))));
			assert!(matches!(r.poll_read(&mut noop(), &mut buf), Poll::Ready(Ok(0))), "end of file");
			assert!(
				matches!(r.poll_read(&mut noop(), &mut []), Poll::Ready(Ok(0))),
				"an empty read after end of file is ready"
			);
		}

		// Failure mode (review round 2, finding 1): every engine vproc polls
		// with the engine's one waker. Vproc V1 parks on a full pipe; vproc
		// V2 then writes a little, with the same waker, and that success
		// dropped V1's wait without waking anyone, so V1 was never woken once
		// the pipe had room. With every page of the pipe in use and the last
		// one partly full, a 4096-byte write waits while a 1-byte write would
		// still fit. V1's page is now made by the end's thread, and V2 waits
		// for it, so the end's writes keep their order; once the reader
		// empties the pipe the engine is woken, V1 learns its page was
		// written, and V2 writes. Linux: `F_GETPIPE_SZ`, and the end's thread.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		#[test]
		fn a_vproc_that_writes_keeps_the_wait_of_another_vproc_with_its_waker() {
			let (r, mut w) = os_pipe(b"").unwrap();
			let fd = RawFd::try_from(w.os_handle().unwrap().0).unwrap();
			// SAFETY: F_GETPIPE_SZ and sysconf only read.
			let (size, page) =
				unsafe { (libc::fcntl(fd, libc::F_GETPIPE_SZ), libc::sysconf(libc::_SC_PAGESIZE)) };
			let (size, page) = (usize::try_from(size).unwrap(), usize::try_from(page).unwrap());
			let engine = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&engine));
			let mut cx = Context::from_waker(&waker);
			let full_page = vec![1u8; page];
			for _ in 1..size / page {
				assert!(matches!(w.poll_write(&mut cx, &full_page), Poll::Ready(Ok(n)) if n == page));
			}
			assert!(matches!(w.poll_write(&mut cx, &[2u8; 100]), Poll::Ready(Ok(100))));
			// V1 parks.
			assert!(w.poll_write(&mut cx, &full_page).is_pending(), "a page does not fit");
			// V2, same waker, waits for V1's page.
			assert!(w.poll_write(&mut cx, b"3").is_pending(), "V2 waits for the write in hand");
			// The reader empties the pipe: the engine must be woken.
			let mut all = vec![0u8; (size / page - 1) * page + 100];
			external(r.as_ref()).read_exact(&mut all).unwrap();
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
			while !engine.0.load(Ordering::SeqCst) {
				assert!(
					std::time::Instant::now() < deadline,
					"the parked vprocs were not woken within 30 s of the pipe having room"
				);
				std::thread::sleep(std::time::Duration::from_millis(1));
			}
			assert!(matches!(w.poll_write(&mut cx, &full_page), Poll::Ready(Ok(n)) if n == page));
			assert!(matches!(w.poll_write(&mut cx, b"3"), Poll::Ready(Ok(1))));
			let mut rest = vec![0u8; page + 1];
			external(r.as_ref()).read_exact(&mut rest).unwrap();
			assert!(
				rest[..page].iter().all(|&b| b == 1) && rest[page] == b'3',
				"V1's page, then V2's byte"
			);
		}

		// Failure mode (review round 2, finding 3): a task dropped while it
		// waited on an idle end kept its own registration on the readiness
		// thread, so each short-lived extra cancelled there added one
		// descriptor to the thread's poll set; or a full set forgets a waiter
		// without waking it. (That live tasks past the cap settle is
		// `wakers::tests::live_tasks_past_the_cap_settle`.)
		#[test]
		fn two_hundred_tasks_waiting_on_an_idle_end_are_all_woken() {
			let (r, w) = io::pipe().unwrap();
			// macOS's `private` shares the description: make it non-blocking,
			// as Linux's own reopening is.
			#[cfg(target_os = "macos")]
			// SAFETY: fcntl on a descriptor this test owns.
			unsafe {
				libc::fcntl(r.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
			}
			let mut end = Private::new(private(r.as_raw_fd(), false).unwrap(), false);
			let flags: Vec<Arc<Flag>> = (0..200).map(|_| Arc::default()).collect();
			let mut buf = [0u8; 8];
			for flag in &flags {
				let waker = Waker::from(Arc::clone(flag));
				assert!(
					end.poll_read(&mut Context::from_waker(&waker), &mut buf)
						.is_pending()
				);
			}
			// A waiter the full set forgot was woken then; the rest wake once
			// a byte comes.
			(&w).write_all(b"x").unwrap();
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
			while !flags.iter().all(|f| f.0.load(Ordering::SeqCst)) {
				assert!(
					std::time::Instant::now() < deadline,
					"a waiting task was not woken within 30 s"
				);
				std::thread::sleep(std::time::Duration::from_millis(1));
			}
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
		#[cfg(any(target_os = "linux", target_os = "android"))]
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
		#[cfg(any(target_os = "linux", target_os = "android"))]
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
		#[cfg(any(target_os = "linux", target_os = "android"))]
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

		/// `f` in a forked child with `SIGPIPE` at its default action: its
		/// exit status, or the signal that ended it. The child runs only `f`
		/// and `_exit`.
		#[cfg(target_os = "macos")]
		fn in_child(f: impl FnOnce() -> i32) -> Result<i32, i32> {
			// SAFETY: the child changes its own disposition, runs `f` (a
			// `write(2)` and no allocation or lock) and exits without
			// unwinding; the parent waits for exactly that pid.
			unsafe {
				let pid = libc::fork();
				assert!(pid >= 0, "fork: {}", io::Error::last_os_error());
				if pid == 0 {
					libc::signal(libc::SIGPIPE, libc::SIG_DFL);
					libc::_exit(f());
				}
				let mut status = 0;
				assert_eq!(libc::waitpid(pid, &raw mut status, 0), pid);
				if libc::WIFSIGNALED(status) {
					Err(libc::WTERMSIG(status))
				} else {
					Ok(libc::WEXITSTATUS(status))
				}
			}
		}

		// Failure mode: the shell's write raises a real `SIGPIPE`, which on
		// macOS goes to the whole process and would end the shell, where
		// bash's stage alone dies of it. Each write runs in a child whose
		// `SIGPIPE` is at its default action, so a raised one ends it.
		#[cfg(target_os = "macos")]
		#[test]
		fn a_broken_pipe_raises_no_sigpipe() {
			let (r, w) = os_pipe(b"").unwrap();
			let mut wd = w.dup().unwrap();
			let theirs = RawFd::try_from(w.os_handle().unwrap().0).unwrap();
			drop(r);
			// The control: a plain write on the externals' description.
			let plain = in_child(|| {
				// SAFETY: a one-byte write from a static buffer.
				unsafe { libc::write(theirs, b"x".as_ptr().cast(), 1) };
				4
			});
			assert_eq!(
				plain,
				Err(libc::SIGPIPE),
				"a plain write to a pipe with no reader raises SIGPIPE"
			);
			let shells = in_child(|| match wd.poll_write(&mut noop(), b"x") {
				Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::BrokenPipe => 3,
				_ => 4,
			});
			assert_eq!(
				shells,
				Ok(3),
				"the shell's write fails as a broken pipe and raises no SIGPIPE"
			);
		}

		// Failure mode: a FIFO that cannot be made is shared anyway (or the
		// shell fails), or the FIFO or its directory stays behind.
		#[cfg(target_os = "macos")]
		#[test]
		fn the_fifo_leaves_nothing_behind_and_none_means_no_os_pipe() {
			let tmp = tempfile::tempdir().unwrap();
			let left = || std::fs::read_dir(tmp.path()).unwrap().count();
			let (r, w) = fifo_pipe(tmp.path(), b"x").expect("a FIFO pipe");
			assert_eq!(left(), 0, "the FIFO and its directory are unlinked at once");
			let mut got = [0u8; 1];
			drop(w);
			let mut from = r.dup().unwrap();
			assert!(matches!(from.poll_read(&mut noop(), &mut got), Poll::Ready(Ok(1))));
			assert!(fifo_pipe(tmp.path(), &vec![1u8; 1 << 20]).is_none(), "1 MiB does not fit");
			assert_eq!(left(), 0, "a refused prefill leaves nothing either");
			assert!(fifo_pipe(&tmp.path().join("missing"), b"").is_none(), "no directory, no pipe");
		}
	}
}
