//! The OS side of pumps and relays: our private end of a pipe (or, on Unix,
//! of a socket pair) as pollable I/O, and a one-shot timer, both waking the
//! polling task without blocking it.
//!
//! - **Unix**: our end is non-blocking (it is ours alone: close-on-exec and
//!   never handed to a child, so `O_NONBLOCK` on its open file description
//!   affects nobody else). I/O that would wait registers the task's waker with
//!   the process-wide readiness poller ([`ready::watch`]); on Linux a write to
//!   a pipe that would wait is made by the end's own thread instead ([`Room`]),
//!   which the kernel wakes once it fits, since a pipe that polls writable need
//!   not have room for it. The timer is a `timerfd` (Linux) or a kqueue timer
//!   (BSD, macOS), watched the same way.
//! - **Windows**: anonymous pipes cannot do overlapped I/O, so a pump pipe is a
//!   private named-pipe instance: our server end is overlapped, the child's
//!   client end is an ordinary synchronous handle. Our end is bound to the
//!   system thread pool (`CreateThreadpoolIo`); one read, write or connect is
//!   in flight at a time. Its OVERLAPPED and buffer live in a shared allocation
//!   the completion callback holds a reference to, so dropping the end never
//!   waits: it cancels the operation, closes the handle, and the completion
//!   (which only records the result and wakes the stored waker) frees the rest.
//!   The timer is a thread-pool timer whose callback likewise only wakes, and
//!   frees the timer once its owner is gone. No engine future is polled outside
//!   the task polling it.
//!
//! [`ready::watch`]: crate::sys::ready::watch
//! [`Room`]: crate::sys::room::Room

use std::{
	fs, io,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant},
};

#[cfg(unix)]
pub use self::imp::socket_pair;
pub use self::imp::{Drain, OsPipe, Timer, feed_pipe, reclaim};

/// A pipe between a pump and a child: our end, and the child's end (`true`
/// = the child reads).
pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
	imp::pipe(child_reads)
}

/// A named pipe the child opens by path (a process substitution's
/// `/dev/fd/N` on Windows, where no fd is inherited): our server end, which
/// waits for the child's open ([`imp::Bridge`]), and the path.
#[cfg(windows)]
pub fn named_pipe(child_reads: bool) -> io::Result<(OsPipe, String)> {
	imp::named_pipe(child_reads)
}

impl OsPipe {
	/// Read into `buf`; `Ok(0)` at end of file (every writer closed).
	pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.0.poll_read(cx, buf)
	}

	/// Write a prefix of `buf`; fails once the child's end is closed.
	pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.0.poll_write(cx, buf)
	}

	/// Tests, Unix: while `hold` is set, a write waits without writing, as
	/// one the room's thread has in hand while the pipe has room (the thread
	/// not yet run); letting go wakes the task that asked.
	#[cfg(all(test, unix))]
	pub fn hold_writes(&mut self, hold: bool) {
		self.0.hold_writes(hold);
	}

	/// Ready once every byte accepted by [`OsPipe::poll_write`] is in the
	/// pipe (Windows completes writes in the background; Unix writes are
	/// immediate).
	#[cfg_attr(
		unix,
		allow(clippy::missing_const_for_fn, reason = "Windows waits for its write in flight")
	)]
	pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
		self.0.poll_flush(cx)
	}

	/// Bytes waiting to be read: in the pipe, plus (Windows) those a
	/// finished read holds for the next [`OsPipe::poll_read`].
	#[cfg_attr(
		unix,
		allow(clippy::needless_pass_by_ref_mut, reason = "Windows collects a finished read")
	)]
	pub fn available(&mut self) -> io::Result<usize> {
		self.0.available()
	}

	/// Our end of a feed's pipe, which [`reclaim`] reads back through the
	/// feed's `drain` ([`Drain`]), or through the child's end where it has
	/// none. Linux: a write that would wait is made by the end's room thread
	/// only where the feed has a drain, through which [`reclaim`] empties the
	/// pipe while it finishes that write; else the write waits for the pipe to
	/// poll writable.
	#[cfg_attr(
		not(any(target_os = "linux", target_os = "android")),
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			clippy::needless_pass_by_ref_mut,
			clippy::needless_pass_by_value,
			reason = "only Linux makes a room thread"
		)
	)]
	pub fn for_reclaim(&mut self, drain: Option<Arc<Drain>>) {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		self.0.for_reclaim(drain);
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let _ = drain;
	}

	/// Our end of a [`named_pipe`] the child reads, before there is data
	/// for it: keep it listening (spares, and instances whose client left),
	/// so the child's opens find an instance however slow the producer is.
	#[cfg_attr(
		unix,
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			clippy::needless_pass_by_ref_mut,
			reason = "Unix pipes are connected"
		)
	)]
	pub fn poll_listening(&mut self, cx: &Context<'_>) {
		#[cfg(windows)]
		self.0.poll_listening(cx);
		#[cfg(unix)]
		let _ = cx;
	}

	/// Our end of a [`named_pipe`] no client holds: the child never opened
	/// it, or left without writing (no end of file comes from it).
	#[cfg_attr(
		unix,
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			clippy::needless_pass_by_ref_mut,
			reason = "Unix pipes are connected"
		)
	)]
	pub fn poll_unopened(&mut self, cx: &Context<'_>) -> bool {
		#[cfg(windows)]
		{
			self.0.poll_unopened(cx)
		}
		#[cfg(unix)]
		{
			let _ = cx;
			false
		}
	}
}

impl Timer {
	/// A timer due `after` from now.
	pub fn after(after: Duration) -> Self {
		Self(imp::TimerImp::new(Instant::now() + after))
	}

	/// Ready once due. A timer the OS cannot arm is due at once, so a wait
	/// bounded by it ends early rather than never.
	pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
		self.0.poll(cx)
	}
}

#[cfg(unix)]
mod imp {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use std::sync::Arc;
	use std::{
		fs,
		io::{self, Read, Write},
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		task::{Context, Poll},
		time::{Duration, Instant},
	};

	use parking_lot::Mutex;

	use crate::sys::ready;
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use crate::sys::room::Room;

	/// Our non-blocking end of a pump pipe or socket pair.
	pub struct OsPipe(pub(super) UnixEnd);

	/// A one-shot timer.
	pub struct Timer(pub(super) TimerImp);

	/// A feed's private read description of its pipe: non-blocking, the
	/// shell's alone (the children's description stays blocking, as
	/// `O_NONBLOCK` belongs to the description), close-on-exec. The shell's
	/// own reads of the engine object take what the pipe holds through it, and
	/// [`reclaim`] empties the pipe through it without waiting for end of file.
	pub struct Drain {
		/// Declared first: forgotten by the readiness thread before the
		/// descriptor closes.
		watch: Mutex<Option<ready::Watch>>,
		file:  fs::File,
	}

	impl Drain {
		/// Linux: the child's end `read` opened again through
		/// `/proc/self/fd/N`, which makes a new open file description of the
		/// same pipe. `None` where it cannot be (no `/proc` mounted), and on
		/// other systems, where `/dev/fd/N` shares the description.
		pub fn of(read: &fs::File) -> Option<Self> {
			#[cfg(any(target_os = "linux", target_os = "android"))]
			{
				use std::os::unix::fs::OpenOptionsExt;
				fs::OpenOptions::new()
					.read(true)
					.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
					.open(format!("/proc/self/fd/{}", read.as_raw_fd()))
					.ok()
					.map(|file| Self { watch: Mutex::new(None), file })
			}
			#[cfg(not(any(target_os = "linux", target_os = "android")))]
			{
				let _ = read;
				None
			}
		}

		/// Read what the pipe holds; `Pending` while it holds nothing and a
		/// writer may still write (`cx` woken once it does), `Ok(0)` at end of
		/// file.
		pub fn poll_read(&self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let mut watch = self.watch.lock();
			let file = &self.file;
			poll_io(cx, file.as_raw_fd(), ready::READ, &mut watch, || (&*file).read(buf))
		}

		/// Read what the pipe holds now, without a readiness wait:
		/// `WouldBlock` while it holds nothing and a writer may still write,
		/// `Ok(0)` at end of file.
		pub fn read_now(&self, buf: &mut [u8]) -> io::Result<usize> {
			loop {
				match (&self.file).read(buf) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					read => return read,
				}
			}
		}

		/// How many bytes the pipe holds now.
		pub fn available(&self) -> usize {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD stores the byte count into `n` for our open
			// descriptor.
			if unsafe { libc::ioctl(self.file.as_raw_fd(), libc::FIONREAD as _, &raw mut n) } < 0 {
				return 0;
			}
			usize::try_from(n).unwrap_or(0)
		}

		/// Append what the pipe holds now to `back`, without waiting; how
		/// many bytes that was.
		fn take_now(&self, back: &mut Vec<u8>, buf: &mut [u8]) -> usize {
			let mut took = 0;
			loop {
				match (&self.file).read(buf) {
					Ok(n) if n > 0 => {
						back.extend_from_slice(&buf[..n]);
						took += n;
					},
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					_ => return took,
				}
			}
		}
	}

	pub struct UnixEnd {
		/// Readiness waits, one per direction (a socket pair end is pumped
		/// both ways). Declared first: forgotten by the readiness thread
		/// before the descriptor closes.
		read_watch:  Option<ready::Watch>,
		write_watch: Option<ready::Watch>,
		/// Linux: the thread a write to a pipe that would wait is handed to,
		/// made at the first such write.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		room:        RoomSlot,
		/// Linux: the pump's wait on its room, the end's only writer's.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		room_key:    crate::sys::WaitKey,
		/// Linux, a feed's end: the feed's [`Drain`], through which
		/// [`reclaim`] empties the pipe while the room thread finishes its
		/// write.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		drain:       Option<Arc<Drain>>,
		file:        fs::File,
		/// Tests: writes wait as one in hand on the room's thread waits, and
		/// the task that asked is woken once they are let go
		/// ([`super::OsPipe::hold_writes`]).
		#[cfg(test)]
		held:        bool,
		/// Tests: the task a held write left waiting, woken when the hold goes.
		#[cfg(test)]
		held_waker:  Option<std::task::Waker>,
	}

	/// A write end's [`Room`], once a write waited.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	enum RoomSlot {
		Unmade,
		Made(Room),
		/// Not a pipe (a socket pair end, whose writes take what fits, so
		/// `POLLOUT` means what it says there), no room could be made, or a
		/// feed's end whose pipe [`reclaim`] could not drain.
		None,
	}

	pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
		let (r, w) = io::pipe()?;
		let (ours, theirs) = if child_reads {
			(OwnedFd::from(w), OwnedFd::from(r))
		} else {
			(OwnedFd::from(r), OwnedFd::from(w))
		};
		Ok((OsPipe(UnixEnd::new(ours)?), fs::File::from(theirs)))
	}

	/// A feed's pipe: our write end, the children's read end and, where one
	/// can be made, the feed's private read description ([`Drain`]).
	///
	/// - Linux: an anonymous pipe; the drain is the children's end opened again
	///   ([`Drain::of`]).
	/// - macOS: `/dev/fd/N` shares the description, so the pipe is a FIFO made
	///   in a private directory under the temporary directory and opened four
	///   times ([`fifo_descriptions`]): the pump writes through the shell's
	///   write description, the children read the externals' read one, the drain
	///   is the shell's read one, and the externals' write one is closed. The
	///   FIFO and its directory are removed before any end is handed out, so
	///   neither a drop nor a crash leaves anything behind. Where it cannot be
	///   made, an anonymous pipe without a drain.
	///
	/// [`fifo_descriptions`]: crate::sys::fifo_pair::fifo_descriptions
	pub fn feed_pipe() -> io::Result<(OsPipe, fs::File, Option<Drain>)> {
		#[cfg(target_os = "macos")]
		if let Ok([ours_read, ours_write, theirs_read, theirs_write]) =
			crate::sys::fifo_pair::fifo_descriptions(&std::env::temp_dir())
		{
			drop(theirs_write);
			let ours = OsPipe(UnixEnd::new(OwnedFd::from(ours_write))?);
			let drain = Drain { watch: Mutex::new(None), file: ours_read };
			return Ok((ours, theirs_read, Some(drain)));
		}
		let (ours, read) = pipe(true)?;
		let drain = Drain::of(&read);
		Ok((ours, read, drain))
	}

	/// A socket pair for a duplex pump: our end, and the child's.
	pub fn socket_pair() -> io::Result<(OsPipe, fs::File)> {
		let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
		Ok((OsPipe(UnixEnd::new(OwnedFd::from(ours))?), fs::File::from(OwnedFd::from(theirs))))
	}

	impl OsPipe {
		/// Shut down one direction of a socket pair end (`shutdown(2)`):
		/// the child reads end of file, or its writes fail.
		pub fn shutdown(&self, how: std::net::Shutdown) {
			let how = match how {
				std::net::Shutdown::Read => libc::SHUT_RD,
				std::net::Shutdown::Write => libc::SHUT_WR,
				std::net::Shutdown::Both => libc::SHUT_RDWR,
			};
			// SAFETY: plain syscall on our open descriptor.
			unsafe { libc::shutdown(self.0.file.as_raw_fd(), how) };
		}
	}

	impl UnixEnd {
		fn new(fd: OwnedFd) -> io::Result<Self> {
			let raw = fd.as_raw_fd();
			// SAFETY: fcntl on a descriptor we own. Its open file description
			// is ours alone (close-on-exec, never handed to a child).
			let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
			// SAFETY: as above.
			if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(Self {
				read_watch: None,
				write_watch: None,
				#[cfg(any(target_os = "linux", target_os = "android"))]
				room: RoomSlot::Unmade,
				#[cfg(any(target_os = "linux", target_os = "android"))]
				room_key: crate::sys::WaitKey::default(),
				#[cfg(any(target_os = "linux", target_os = "android"))]
				drain: None,
				file: fs::File::from(fd),
				#[cfg(test)]
				held: false,
				#[cfg(test)]
				held_waker: None,
			})
		}

		pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let Self { read_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::READ, read_watch, || (&*file).read(buf))
		}

		/// See [`super::OsPipe::hold_writes`].
		#[cfg(test)]
		pub fn hold_writes(&mut self, hold: bool) {
			self.held = hold;
			if !hold && let Some(waker) = self.held_waker.take() {
				waker.wake();
			}
		}

		pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			#[cfg(test)]
			if self.held {
				self.held_waker = Some(cx.waker().clone());
				return Poll::Pending;
			}
			#[cfg(any(target_os = "linux", target_os = "android"))]
			if let Some(r) = self.poll_write_pipe(cx, buf) {
				return r;
			}
			let Self { write_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::WRITE, write_watch, || (&*file).write(buf))
		}

		/// Linux: a write to a pipe. One that would wait is made by the end's
		/// room thread, which the kernel wakes once it fits: gVisor polls a
		/// pipe writable whenever any byte fits, while a write of at most
		/// `PIPE_BUF` bytes is atomic and fails with `EAGAIN` unless all of
		/// it does, so a writer that waited for `POLLOUT` woke and failed over
		/// and over. `None` where the end has no room, or its room can make no
		/// thread now (the thread limit): the write then waits for `POLLOUT`.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		fn poll_write_pipe(
			&mut self,
			cx: &Context<'_>,
			buf: &[u8],
		) -> Option<Poll<io::Result<usize>>> {
			if matches!(self.room, RoomSlot::Unmade) {
				// Made at the end's first write that would wait.
				loop {
					match (&self.file).write(buf) {
						Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
						Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
						r => return Some(Poll::Ready(r)),
					}
				}
				self.room = Room::new(self.file.as_raw_fd()).map_or(RoomSlot::None, RoomSlot::Made);
			}
			let RoomSlot::Made(room) = &self.room else {
				return None;
			};
			let file = &self.file;
			room.poll_write(cx, buf, &mut self.room_key, |b| (&*file).write(b))
		}

		/// See [`super::OsPipe::for_reclaim`].
		#[cfg(any(target_os = "linux", target_os = "android"))]
		pub fn for_reclaim(&mut self, drain: Option<Arc<Drain>>) {
			if drain.is_none() {
				self.room = RoomSlot::None;
			}
			self.drain = drain;
		}

		/// Linux: finish the write of `held` the room thread may have in
		/// hand, reading what the pipe holds into `back` meanwhile through
		/// the drain, since that write is made only as the pipe empties; how
		/// many bytes of `held` the thread made. It asks with the pump's own
		/// key, which the write in hand, or its result, belongs to. With no
		/// write in hand and no result, the thread makes one of `held` now,
		/// the same way, which changes nothing for the bytes given back;
		/// where it can make no thread, nothing was in hand and none of
		/// `held` was made.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		fn settle(&mut self, held: &[u8], back: &mut Vec<u8>) -> usize {
			let Self { room, drain, room_key, .. } = self;
			let (RoomSlot::Made(room), Some(drain)) = (&*room, drain.as_ref()) else {
				return 0;
			};
			if held.is_empty() {
				return 0;
			}
			let waker = std::task::Waker::from(std::sync::Arc::new(Unpark(std::thread::current())));
			let cx = Context::from_waker(&waker);
			let mut buf = vec![0u8; 64 << 10];
			loop {
				match room.poll_write(&cx, held, room_key, |_| Err(io::ErrorKind::WouldBlock.into())) {
					Some(Poll::Ready(r)) => return r.map_or(0, |n| n.min(held.len())),
					Some(Poll::Pending) => {},
					None => return 0,
				}
				if drain.take_now(back, &mut buf) == 0 {
					// Woken by the thread once the write is made.
					std::thread::park_timeout(Duration::from_millis(10));
				}
			}
		}

		#[allow(
			clippy::unused_self,
			clippy::needless_pass_by_ref_mut,
			reason = "same shape as the Windows end, which writes behind"
		)]
		pub const fn poll_flush(&mut self, _cx: &Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		pub fn available(&self) -> io::Result<usize> {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD stores the byte count into `n` for our open
			// descriptor.
			if unsafe { libc::ioctl(self.file.as_raw_fd(), libc::FIONREAD as _, &raw mut n) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(usize::try_from(n).unwrap_or(0))
		}
	}

	/// What a feed's pipe still holds once our write end `pipe` is closed,
	/// then the bytes of `held` (taken from the engine object for the pipe)
	/// the pipe never took. Linux: a write of `held` the end's room thread may
	/// have in hand is finished first ([`UnixEnd::settle`]), so the bytes it
	/// made come back from the pipe, once and in order. With the feed's
	/// `drain`, the pipe is emptied without waiting: once our write end, its
	/// only writer, is closed and the write in hand is made, nothing more
	/// comes, while its end of file may (a process another thread forked holds
	/// a copy of the write end until its exec). Without one, the child's end
	/// `read` is read to end of file.
	pub fn reclaim(
		pipe: Option<OsPipe>,
		mut read: &fs::File,
		held: &[u8],
		drain: Option<&Drain>,
	) -> Vec<u8> {
		let mut back = Vec::new();
		// Our write end is closed (dropped) before the read below.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let made = {
			let mut pipe = pipe;
			pipe.as_mut().map_or(0, |p| p.0.settle(held, &mut back))
		};
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let made = {
			drop(pipe);
			0
		};
		match drain {
			Some(drain) => {
				drain.take_now(&mut back, &mut vec![0u8; 64 << 10]);
			},
			None => {
				let _ = read.read_to_end(&mut back);
			},
		}
		back.extend_from_slice(&held[made..]);
		back
	}

	/// Linux: a waker that unparks the thread that made it.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	struct Unpark(std::thread::Thread);

	#[cfg(any(target_os = "linux", target_os = "android"))]
	impl std::task::Wake for Unpark {
		fn wake(self: std::sync::Arc<Self>) {
			self.0.unpark();
		}
	}

	/// Run `op` on the non-blocking `fd`; on `WouldBlock` register the
	/// waker for `events` (replacing the earlier wait, so only the latest
	/// waker is kept) and try once more, as readiness may have come before
	/// the registration did.
	fn poll_io(
		cx: &Context<'_>,
		fd: RawFd,
		events: i16,
		watch: &mut Option<ready::Watch>,
		mut op: impl FnMut() -> io::Result<usize>,
	) -> Poll<io::Result<usize>> {
		let mut registered = false;
		loop {
			match op() {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
				r => {
					*watch = None;
					return Poll::Ready(r);
				},
			}
			if registered {
				return Poll::Pending;
			}
			*watch = None;
			match ready::watch(fd, events, cx.waker()) {
				Ok(w) => *watch = Some(w),
				Err(e) => return Poll::Ready(Err(e)),
			}
			registered = true;
		}
	}

	pub struct TimerImp {
		/// Declared first: forgotten before the timer descriptor closes.
		watch:    Option<ready::Watch>,
		fd:       Option<OwnedFd>,
		deadline: Instant,
	}

	impl TimerImp {
		pub const fn new(deadline: Instant) -> Self {
			Self { watch: None, fd: None, deadline }
		}

		pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
			if Instant::now() >= self.deadline {
				self.watch = None;
				return Poll::Ready(());
			}
			if self.fd.is_none() {
				match arm(self.deadline) {
					Ok(fd) => self.fd = Some(fd),
					Err(_) => return Poll::Ready(()),
				}
			}
			let Some(fd) = self.fd.as_ref().map(AsRawFd::as_raw_fd) else {
				return Poll::Ready(());
			};
			self.watch = None;
			match ready::watch(fd, ready::READ, cx.waker()) {
				Ok(w) => self.watch = Some(w),
				Err(_) => return Poll::Ready(()),
			}
			if Instant::now() >= self.deadline {
				Poll::Ready(())
			} else {
				Poll::Pending
			}
		}
	}

	/// Time left until `deadline`, rounded up so the OS timer never fires
	/// before the [`Instant`] check agrees.
	fn left(deadline: Instant) -> Duration {
		deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1)
	}

	/// A descriptor that turns readable at `deadline` (`timerfd`).
	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let fd = unsafe {
			libc::timerfd_create(libc::CLOCK_MONOTONIC, libc::TFD_CLOEXEC | libc::TFD_NONBLOCK)
		};
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let fd = unsafe { OwnedFd::from_raw_fd(fd) };
		let spec = libc::itimerspec {
			it_interval: libc::timespec { tv_sec: 0, tv_nsec: 0 },
			it_value:    libc::timespec {
				tv_sec:  left.as_secs() as _,
				tv_nsec: left.subsec_nanos() as _,
			},
		};
		// SAFETY: `spec` is valid; the old value is not wanted.
		if unsafe { libc::timerfd_settime(fd.as_raw_fd(), 0, &raw const spec, ptr::null_mut()) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(fd)
	}

	/// A descriptor that turns readable at `deadline`: a kqueue holding one
	/// timer event (a kqueue polls readable while it has pending events).
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let kq = unsafe { libc::kqueue() };
		if kq < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let kq = unsafe { OwnedFd::from_raw_fd(kq) };
		// SAFETY: fcntl on our descriptor (a kqueue is not inherited by a fork;
		// close-on-exec keeps it out of an exec'd child as well).
		unsafe { libc::fcntl(kq.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
		// SAFETY: `kevent` is plain data; zero is a valid value of every field.
		let mut ev: libc::kevent = unsafe { std::mem::zeroed() };
		ev.ident = 1;
		ev.filter = libc::EVFILT_TIMER;
		ev.flags = libc::EV_ADD | libc::EV_ONESHOT;
		// Milliseconds, the default unit.
		ev.data = left.as_millis().min(i32::MAX as u128) as _;
		// SAFETY: one valid change, no event list, no timeout.
		if unsafe { libc::kevent(kq.as_raw_fd(), &raw const ev, 1, ptr::null_mut(), 0, ptr::null()) }
			< 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(kq)
	}

	/// No pollable timer here: the timer is due at once.
	#[cfg(not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	)))]
	fn arm(_deadline: Instant) -> io::Result<OwnedFd> {
		Err(io::ErrorKind::Unsupported.into())
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		cell::UnsafeCell,
		ffi::c_void,
		fs,
		io::{self, Read},
		os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
		ptr,
		sync::{
			Arc,
			atomic::{AtomicU32, Ordering},
		},
		task::{Context, Poll, Waker},
		time::Instant,
	};

	use parking_lot::Mutex;
	use windows_sys::Win32::{
		Foundation::{
			ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
			ERROR_PIPE_NOT_CONNECTED, FILETIME, GENERIC_READ, GENERIC_WRITE, HANDLE,
			INVALID_HANDLE_VALUE, STATUS_PENDING,
		},
		Storage::FileSystem::{
			CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES,
			FILE_WRITE_ATTRIBUTES, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, ReadFile,
			WriteFile,
		},
		System::{
			IO::{CancelIoEx, OVERLAPPED},
			Pipes::{
				ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
				PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
				PeekNamedPipe,
			},
			Threading::{
				CancelThreadpoolIo, CloseThreadpoolIo, CloseThreadpoolTimer, CreateThreadpoolIo,
				CreateThreadpoolTimer, PTP_CALLBACK_INSTANCE, PTP_IO, PTP_TIMER, SetThreadpoolTimer,
				StartThreadpoolIo,
			},
		},
	};

	/// Pipe buffer size, and the size of one read or write in flight.
	const BUF: usize = 64 << 10;

	/// Our overlapped end of a pump pipe (or the instances of a
	/// [`named_pipe`] still choosing it).
	pub struct OsPipe(pub(super) WinPipe);

	/// A one-shot timer.
	pub struct Timer(pub(super) TimerImp);

	fn owned(h: HANDLE) -> io::Result<OwnedHandle> {
		if h.is_null() || h == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh, valid handle nobody else owns.
		Ok(unsafe { OwnedHandle::from_raw_handle(h.cast()) })
	}

	fn raw(h: &OwnedHandle) -> HANDLE {
		h.as_raw_handle().cast()
	}

	fn is_os(e: &io::Error, code: u32) -> bool {
		e.raw_os_error() == Some(code as i32)
	}

	/// The writer is gone: end of file for a reader.
	fn hung_up(e: &io::Error) -> bool {
		is_os(e, ERROR_BROKEN_PIPE) || is_os(e, ERROR_PIPE_NOT_CONNECTED)
	}

	/// A fresh pipe name `\\.\pipe\obash-pump-<pid>-<n>` (NUL-terminated
	/// UTF-16 beside it).
	fn pipe_name() -> (String, Vec<u16>) {
		static SEQ: AtomicU32 = AtomicU32::new(0);
		let name = format!(
			r"\\.\pipe\obash-pump-{}-{}",
			std::process::id(),
			SEQ.fetch_add(1, Ordering::Relaxed)
		);
		let wide = name.encode_utf16().chain([0]).collect();
		(name, wide)
	}

	/// An overlapped server instance of pipe `wide` (the first creates it),
	/// of at most `max` instances; ours, not inheritable.
	fn instance(wide: &[u16], child_reads: bool, first: bool, max: u32) -> io::Result<OwnedHandle> {
		let access = if child_reads {
			PIPE_ACCESS_OUTBOUND
		} else {
			PIPE_ACCESS_INBOUND
		};
		let first = if first {
			FILE_FLAG_FIRST_PIPE_INSTANCE
		} else {
			0
		};
		// SAFETY: `wide` is NUL-terminated; null security attributes.
		owned(unsafe {
			CreateNamedPipeW(
				wide.as_ptr(),
				access | first | FILE_FLAG_OVERLAPPED,
				PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
				max,
				BUF as u32,
				BUF as u32,
				0,
				ptr::null(),
			)
		})
	}

	pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
		let (_, wide) = pipe_name();
		let server = instance(&wide, child_reads, true, 1)?;
		// The access `CreatePipe` gives its ends: the child can query and set
		// the pipe state of its own end.
		let desired = if child_reads {
			GENERIC_READ | FILE_WRITE_ATTRIBUTES
		} else {
			GENERIC_WRITE | FILE_READ_ATTRIBUTES
		};
		// SAFETY: opens the client end of the instance just created,
		// synchronous (no FILE_FLAG_OVERLAPPED), as children expect.
		let client = owned(unsafe {
			CreateFileW(wide.as_ptr(), desired, 0, ptr::null(), OPEN_EXISTING, 0, ptr::null_mut())
		})?;
		Ok((OsPipe(WinPipe::End(WinEnd::new(server)?)), fs::File::from(client)))
	}

	pub fn named_pipe(child_reads: bool) -> io::Result<(OsPipe, String)> {
		let (name, wide) = pipe_name();
		let first = WinEnd::new(instance(&wide, child_reads, true, PIPE_UNLIMITED_INSTANCES)?)?;
		let bridge = Bridge {
			wide,
			child_reads,
			listeners: vec![Listener { end: first, since: None }],
			chosen: None,
			timer: None,
		};
		Ok((OsPipe(WinPipe::Bridge(Box::new(bridge))), name))
	}

	/// Our side of a pump pipe: one end, or a [`Bridge`] still choosing it.
	pub enum WinPipe {
		End(WinEnd),
		Bridge(Box<Bridge>),
	}

	impl WinPipe {
		pub fn poll_read(&mut self, cx: &Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
			match self {
				Self::End(e) => e.poll_read(cx, out),
				Self::Bridge(b) => b.poll_read(cx, out),
			}
		}

		pub fn poll_write(&mut self, cx: &Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
			match self {
				Self::End(e) => e.poll_write(cx, data),
				Self::Bridge(b) => b.poll_write(cx, data),
			}
		}

		pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			match self {
				Self::End(e) => e.poll_flush(cx),
				Self::Bridge(b) => b
					.chosen
					.as_mut()
					.map_or(Poll::Ready(Ok(())), |e| e.poll_flush(cx)),
			}
		}

		pub fn available(&mut self) -> io::Result<usize> {
			match self {
				Self::End(e) => e.available(),
				Self::Bridge(b) => b.chosen.as_mut().map_or(Ok(0), WinEnd::available),
			}
		}

		/// [`OsPipe::poll_listening`].
		pub fn poll_listening(&mut self, cx: &Context<'_>) {
			if let Self::Bridge(b) = self
				&& b.child_reads
				&& b.chosen.is_none()
				&& b.poll_listen(cx).is_ok()
			{
				for l in &mut b.listeners {
					if l.since.is_some() && l.end.inflight == Inflight::Idle && !l.end.client_open() {
						if l.end.inflight == Inflight::Idle {
							l.end.relisten();
						}
						l.since = None;
					}
				}
				let _ = b.poll_listen(cx);
			}
		}

		/// [`OsPipe::poll_unopened`]: the connects that completed taken first.
		pub fn poll_unopened(&mut self, cx: &Context<'_>) -> bool {
			match self {
				Self::Bridge(b) if b.chosen.is_none() => {
					b.poll_listen(cx).is_err() || b.listeners.iter().all(|l| l.since.is_none())
				},
				_ => false,
			}
		}

		fn close(self) -> Vec<u8> {
			match self {
				Self::End(e) => e.close(),
				Self::Bridge(b) => b.chosen.map_or_else(Vec::new, WinEnd::close),
			}
		}
	}

	/// How long a connection must last before the child's reading takes it
	/// for its real open: programs open a path once just to look at it
	/// (`cmd`'s `type`, the MSYS runtime's `stat`) and close it at once.
	const SETTLE: std::time::Duration = std::time::Duration::from_millis(30);

	/// Server instances kept listening while a [`Bridge`] chooses.
	const SPARE: usize = 2;

	/// At most this many instances (connections) while choosing.
	const MAX_INSTANCES: usize = 16;

	/// A named pipe a child opens by path ([`named_pipe`]). A probing open
	/// would take a single instance for good (the real open then finds every
	/// instance busy), so instances keep listening until the connection the
	/// child uses is known: for its reading, the newest still open once it
	/// settled ([`SETTLE`]); for its writing, the first that delivers bytes.
	/// The others close.
	pub struct Bridge {
		wide:        Vec<u16>,
		child_reads: bool,
		listeners:   Vec<Listener>,
		chosen:      Option<WinEnd>,
		timer:       Option<TimerImp>,
	}

	struct Listener {
		end:   WinEnd,
		/// When its client connected; `None` while listening.
		since: Option<Instant>,
	}

	impl Bridge {
		/// Drive the instances' connects, keeping [`SPARE`] listening.
		fn poll_listen(&mut self, cx: &Context<'_>) -> io::Result<()> {
			loop {
				let mut i = 0;
				while i < self.listeners.len() {
					let l = &mut self.listeners[i];
					if l.since.is_none() {
						match l.end.poll_connect(cx) {
							Poll::Ready(Ok(())) => l.since = Some(Instant::now()),
							Poll::Ready(Err(e)) => {
								if self.listeners.len() == 1 {
									return Err(e);
								}
								self.listeners.swap_remove(i);
								continue;
							},
							Poll::Pending => {},
						}
					}
					i += 1;
				}
				let waiting = self.listeners.iter().filter(|l| l.since.is_none()).count();
				if waiting >= SPARE || self.listeners.len() >= MAX_INSTANCES {
					return Ok(());
				}
				let end = WinEnd::new(instance(
					&self.wide,
					self.child_reads,
					false,
					PIPE_UNLIMITED_INSTANCES,
				)?)?;
				self.listeners.push(Listener { end, since: None });
			}
		}

		/// The child reads: the newest connection still open once settled.
		fn poll_write(&mut self, cx: &Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
			loop {
				if let Some(end) = &mut self.chosen {
					return end.poll_write(cx, data);
				}
				if let Err(e) = self.poll_listen(cx) {
					return Poll::Ready(Err(e));
				}
				let newest = self
					.listeners
					.iter()
					.enumerate()
					.filter_map(|(i, l)| l.since.map(|t| (i, t)))
					.max_by_key(|&(_, t)| t);
				let Some((i, since)) = newest else {
					return Poll::Pending;
				};
				let settled = since + SETTLE;
				if Instant::now() < settled {
					let timer = self.timer.get_or_insert_with(|| TimerImp::new(settled));
					if timer.poll(cx).is_pending() {
						return Poll::Pending;
					}
					self.timer = None;
					continue;
				}
				if self.listeners[i].end.client_open() {
					self.chosen = Some(self.listeners.swap_remove(i).end);
					self.listeners.clear();
				} else {
					let l = &mut self.listeners[i];
					if l.end.inflight == Inflight::Idle {
						l.end.relisten();
					}
					l.since = None;
				}
			}
		}

		/// The child writes: the first connection that delivers bytes.
		fn poll_read(&mut self, cx: &Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
			if let Some(end) = &mut self.chosen {
				return end.poll_read(cx, out);
			}
			if out.is_empty() {
				return Poll::Ready(Ok(0));
			}
			if let Err(e) = self.poll_listen(cx) {
				return Poll::Ready(Err(e));
			}
			for i in 0..self.listeners.len() {
				if self.listeners[i].since.is_none() {
					continue;
				}
				match self.listeners[i].end.poll_read(cx, out) {
					Poll::Ready(Ok(n)) if n > 0 => {
						self.chosen = Some(self.listeners.swap_remove(i).end);
						self.listeners.clear();
						return Poll::Ready(Ok(n));
					},
					// A client gone without writing (a probe, or a child that
					// wrote nothing): listen again.
					Poll::Ready(_) => {
						let l = &mut self.listeners[i];
						l.end.relisten();
						l.since = None;
						cx.waker().wake_by_ref();
					},
					Poll::Pending => {},
				}
			}
			Poll::Pending
		}
	}

	/// A feed's private read description of its pipe: Windows has none (a
	/// feed's pipe is a single-instance named pipe, whose child end refuses a
	/// second opening), so a feed there has no drain and the shell's reads take
	/// the engine object only.
	pub enum Drain {}

	/// A feed's pipe: our write end and the children's read end; no drain
	/// (see [`Drain`]).
	pub fn feed_pipe() -> io::Result<(OsPipe, fs::File, Option<Drain>)> {
		let (ours, read) = pipe(true)?;
		Ok((ours, read, None))
	}

	impl Drain {
		pub const fn poll_read(&self, _cx: &Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
			match *self {}
		}

		pub const fn read_now(&self, _buf: &mut [u8]) -> io::Result<usize> {
			match *self {}
		}

		pub const fn available(&self) -> usize {
			match *self {}
		}
	}

	/// What a feed's pipe still holds, read through the child's end `read`
	/// once our write end `pipe` is closed (at once: its write in flight is
	/// cancelled, see [`WinEnd::close`]), followed by the part of that write
	/// the pipe never took, then the bytes of `held` (taken from the engine
	/// object for the pipe, never written). With our end closed the read ends
	/// at end of file instead of waiting.
	pub fn reclaim(
		pipe: Option<OsPipe>,
		mut read: &fs::File,
		held: &[u8],
		_drain: Option<&Drain>,
	) -> Vec<u8> {
		let unsent = pipe.map_or_else(Vec::new, |p| p.0.close());
		let mut back = Vec::new();
		let _ = read.read_to_end(&mut back);
		back.extend_from_slice(&unsent);
		back.extend_from_slice(held);
		back
	}

	impl OsPipe {
		/// Our overlapped server end of a named pipe (a process
		/// substitution's), not connected yet.
		pub fn server(handle: OwnedHandle) -> io::Result<Self> {
			WinEnd::new(handle).map(|e| Self(WinPipe::End(e)))
		}

		/// Ready once a client connected (also when it already left: the I/O
		/// then reports end of file or a broken pipe).
		pub fn poll_connect(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			match &mut self.0 {
				WinPipe::End(e) => e.poll_connect(cx),
				WinPipe::Bridge(_) => Poll::Ready(Ok(())),
			}
		}
	}

	/// The completion side of an end: the OVERLAPPED of the operation in
	/// flight (first, so the completion's OVERLAPPED pointer is this
	/// allocation's), its buffer, and what the owner learns. The kernel and
	/// the owner take turns on `ov` and `buf`: the owner touches them only
	/// with no operation in flight.
	#[repr(C)]
	struct Op {
		ov:    UnsafeCell<OVERLAPPED>,
		buf:   UnsafeCell<Box<[u8]>>,
		state: Mutex<OpState>,
	}

	#[derive(Default)]
	struct OpState {
		/// The finished operation: its Win32 error (0: success) and the bytes
		/// it moved.
		done:   Option<(u32, usize)>,
		waker:  Option<Waker>,
		/// The owner is gone while the operation ran: the completion closes
		/// the I/O object (the handle is closed already).
		orphan: Option<PTP_IO>,
	}

	#[allow(
		clippy::non_send_fields_in_send_ty,
		reason = "the OVERLAPPED's raw handle is only touched by the kernel or the owner, never both"
	)]
	// SAFETY: `ov` and `buf` are used by the kernel during an operation and
	// by the owner between operations, never both; `state` is locked.
	unsafe impl Send for Op {}
	// SAFETY: as above.
	unsafe impl Sync for Op {}

	/// Thread-pool completion of an operation on an end: record the result,
	/// wake the owner's task, release the operation's reference (freeing the
	/// buffer once the owner is gone) and, for a gone owner, the I/O object.
	/// It never polls anything.
	unsafe extern "system" fn on_complete(
		_instance: PTP_CALLBACK_INSTANCE,
		_context: *mut c_void,
		overlapped: *mut c_void,
		result: u32,
		moved: usize,
		_io: PTP_IO,
	) {
		if overlapped.is_null() {
			return;
		}
		// SAFETY: `overlapped` is the `ov` of an `Op`, its first field, whose
		// reference `WinEnd::start` handed to this completion.
		let op = unsafe { Arc::from_raw(overlapped.cast::<Op>().cast_const()) };
		let (waker, orphan) = {
			let mut st = op.state.lock();
			st.done = Some((result, moved));
			(st.waker.take(), st.orphan.take())
		};
		if let Some(tp) = orphan {
			// SAFETY: handed over by the gone owner, its handle closed and
			// nothing in flight any more; freed once this callback returns.
			unsafe { CloseThreadpoolIo(tp) };
		}
		if let Some(w) = waker {
			w.wake();
		}
	}

	/// The operation in flight on a [`WinEnd`].
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum Inflight {
		Idle,
		Connecting,
		Reading,
		/// A write of the first `len` bytes of the buffer.
		Writing {
			len: usize,
		},
	}

	/// An operation to start.
	#[derive(Clone, Copy)]
	enum Kind {
		Connect,
		Read,
		Write(usize),
	}

	pub struct WinEnd {
		/// Our end; `None` only while dropping.
		handle:   Option<OwnedHandle>,
		/// The thread-pool I/O object our handle is bound to.
		tp:       PTP_IO,
		op:       Arc<Op>,
		inflight: Inflight,
		/// A finished read's bytes not handed out yet: `buf[start..end]`.
		start:    usize,
		end:      usize,
		eof:      bool,
	}

	impl WinEnd {
		fn new(handle: OwnedHandle) -> io::Result<Self> {
			// SAFETY: binds our overlapped handle to the default thread pool;
			// completions come to `on_complete`.
			let tp = unsafe {
				CreateThreadpoolIo(raw(&handle), Some(on_complete), ptr::null_mut(), ptr::null())
			};
			if tp == 0 {
				return Err(io::Error::last_os_error());
			}
			let op = Arc::new(Op {
				ov:    UnsafeCell::new(OVERLAPPED::default()),
				buf:   UnsafeCell::new(vec![0; BUF].into_boxed_slice()),
				state: Mutex::default(),
			});
			Ok(Self {
				handle: Some(handle),
				tp,
				op,
				inflight: Inflight::Idle,
				start: 0,
				end: 0,
				eof: false,
			})
		}

		fn raw(&self) -> HANDLE {
			self.handle.as_ref().map_or(INVALID_HANDLE_VALUE, raw)
		}

		/// The buffer, between operations.
		fn buf(&mut self) -> &mut [u8] {
			// SAFETY: no operation is in flight (callers check `inflight`), so
			// the kernel does not use it.
			unsafe { &mut *self.op.buf.get() }
		}

		/// Start an operation; on `Ok` its completion comes (also for one
		/// that finished at once: our handle is not set to skip completion
		/// packets on success).
		fn start(&mut self, kind: Kind) -> io::Result<()> {
			self.op.state.lock().done = None;
			let ov = self.op.ov.get();
			// SAFETY: no operation is in flight: only we touch `ov`.
			unsafe { *ov = OVERLAPPED::default() };
			let reference = Arc::into_raw(Arc::clone(&self.op));
			let h = self.raw();
			// SAFETY: announces the operation started below to the thread pool.
			unsafe { StartThreadpoolIo(self.tp) };
			// SAFETY: `ov` and the buffer live in `op`, which the completion
			// keeps alive through `reference`; nothing else touches them
			// until it came.
			let ok = unsafe {
				let buf = &mut *self.op.buf.get();
				match kind {
					Kind::Connect => ConnectNamedPipe(h, ov),
					Kind::Read => ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, ptr::null_mut(), ov),
					Kind::Write(len) => WriteFile(h, buf.as_ptr(), len as u32, ptr::null_mut(), ov),
				}
			};
			if ok == 0 {
				let e = io::Error::last_os_error();
				if !is_os(&e, ERROR_IO_PENDING) {
					// A call that failed at once queues no completion.
					// SAFETY: undoes the `StartThreadpoolIo` above.
					unsafe { CancelThreadpoolIo(self.tp) };
					// SAFETY: the reference made above, never handed out.
					drop(unsafe { Arc::from_raw(reference) });
					return Err(e);
				}
			}
			self.inflight = match kind {
				Kind::Connect => Inflight::Connecting,
				Kind::Read => Inflight::Reading,
				Kind::Write(len) => Inflight::Writing { len },
			};
			Ok(())
		}

		/// The result of the operation in flight once it completed; else
		/// `cx`'s task is woken by the completion.
		fn poll_op(&mut self, cx: &Context<'_>) -> Poll<io::Result<usize>> {
			let mut st = self.op.state.lock();
			if let Some((code, moved)) = st.done.take() {
				drop(st);
				self.inflight = Inflight::Idle;
				return Poll::Ready(if code == 0 {
					Ok(moved)
				} else {
					Err(io::Error::from_raw_os_error(code as i32))
				});
			}
			if !st.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
				st.waker = Some(cx.waker().clone());
			}
			Poll::Pending
		}

		/// Take a finished read's result into `start..end` / `eof`.
		fn took(&mut self, r: io::Result<usize>) -> io::Result<()> {
			match r {
				// A zero-byte write on the other end completes a read with
				// nothing: not the end of the stream.
				Ok(n) => {
					self.start = 0;
					self.end = n;
					Ok(())
				},
				Err(e) if hung_up(&e) => {
					self.eof = true;
					Ok(())
				},
				Err(e) => Err(e),
			}
		}

		fn poll_connect(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			let r = match self.inflight {
				Inflight::Idle => match self.start(Kind::Connect) {
					Ok(()) => return self.poll_connect(cx),
					Err(e) => Err(e),
				},
				Inflight::Connecting => std::task::ready!(self.poll_op(cx)).map(drop),
				Inflight::Reading | Inflight::Writing { .. } => Ok(()),
			};
			Poll::Ready(match r {
				// Connected before we asked, or connected and gone already.
				Err(e) if is_os(&e, ERROR_PIPE_CONNECTED) || is_os(&e, ERROR_NO_DATA) => Ok(()),
				r => r,
			})
		}

		/// After its client left (a [`Bridge`] instance a probing open took):
		/// disconnect and listen again, the next [`Self::poll_connect`]
		/// waiting for a new client. Only with no operation in flight.
		fn relisten(&mut self) {
			// SAFETY: our own server handle; nothing is in flight on it.
			unsafe { DisconnectNamedPipe(self.raw()) };
			self.inflight = Inflight::Idle;
			self.start = 0;
			self.end = 0;
			self.eof = false;
		}

		/// Whether the connected client still holds its end: asking to
		/// connect again fails with `ERROR_PIPE_CONNECTED` then, and with
		/// `ERROR_NO_DATA` once it closed. Nothing reaches the client (a
		/// write, even of zero bytes, could end its pending read with
		/// nothing, which it takes for end of file). Only with no operation
		/// in flight; a connect that waits (the instance listens again)
		/// stays in flight, and the client counts as gone.
		fn client_open(&mut self) -> bool {
			match self.start(Kind::Connect) {
				Err(e) => is_os(&e, ERROR_PIPE_CONNECTED),
				Ok(()) => false,
			}
		}

		pub fn poll_read(&mut self, cx: &Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
			loop {
				if self.start < self.end {
					let n = out.len().min(self.end - self.start);
					let (start, end) = (self.start, self.start + n);
					out[..n].copy_from_slice(&self.buf()[start..end]);
					self.start = end;
					return Poll::Ready(Ok(n));
				}
				if self.eof || out.is_empty() {
					return Poll::Ready(Ok(0));
				}
				let r = match self.inflight {
					Inflight::Idle => match self.start(Kind::Read) {
						Ok(()) => continue,
						Err(e) => Err(e),
					},
					Inflight::Reading => std::task::ready!(self.poll_op(cx)),
					Inflight::Connecting | Inflight::Writing { .. } => {
						return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
					},
				};
				if let Err(e) = self.took(r) {
					return Poll::Ready(Err(e));
				}
			}
		}

		/// Wait for the write in flight; a partial one is resubmitted.
		fn poll_settle(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			loop {
				let Inflight::Writing { len } = self.inflight else {
					return Poll::Ready(Ok(()));
				};
				let n = match std::task::ready!(self.poll_op(cx)) {
					Ok(n) => n,
					Err(e) => return Poll::Ready(Err(e)),
				};
				if n >= len {
					return Poll::Ready(Ok(()));
				}
				self.buf().copy_within(n..len, 0);
				if let Err(e) = self.start(Kind::Write(len - n)) {
					return Poll::Ready(Err(e));
				}
			}
		}

		/// Write behind: the bytes are copied and accepted once the operation
		/// is started, and the next write (or flush) waits for them to be in
		/// the pipe.
		pub fn poll_write(&mut self, cx: &Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
			if let Err(e) = std::task::ready!(self.poll_settle(cx)) {
				return Poll::Ready(Err(e));
			}
			if self.inflight != Inflight::Idle {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if data.is_empty() {
				return Poll::Ready(Ok(0));
			}
			let n = data.len().min(BUF);
			self.buf()[..n].copy_from_slice(&data[..n]);
			Poll::Ready(self.start(Kind::Write(n)).map(|()| n))
		}

		pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			self.poll_settle(cx)
		}

		pub fn available(&mut self) -> io::Result<usize> {
			if self.inflight == Inflight::Reading {
				let done = self.op.state.lock().done.take();
				if let Some((code, moved)) = done {
					self.inflight = Inflight::Idle;
					let r = if code == 0 {
						Ok(moved)
					} else {
						Err(io::Error::from_raw_os_error(code as i32))
					};
					self.took(r)?;
				}
			}
			let mut waiting = 0u32;
			// SAFETY: a zero-size peek on our open pipe handle takes no buffer
			// and reports the bytes waiting.
			let ok = unsafe {
				PeekNamedPipe(
					self.raw(),
					ptr::null_mut(),
					0,
					ptr::null_mut(),
					&raw mut waiting,
					ptr::null_mut(),
				)
			};
			if ok == 0 {
				let e = io::Error::last_os_error();
				if !hung_up(&e) {
					return Err(e);
				}
				waiting = 0;
			}
			Ok(self.end - self.start + waiting as usize)
		}

		/// Close at once (see `Drop`); the part of a write in flight the pipe
		/// never took, when its cancellation completed at once (the usual
		/// case for a pipe: the pipe completes a cancelled operation inside
		/// `CancelIoEx`); else nothing.
		fn close(self) -> Vec<u8> {
			let Inflight::Writing { len } = self.inflight else {
				return Vec::new();
			};
			let h = self.raw();
			// SAFETY: the operation in flight on our open handle.
			unsafe { CancelIoEx(h, self.op.ov.get()) };
			let ov = self.op.ov.get();
			// SAFETY: reads the status the kernel writes into the OVERLAPPED
			// at completion (`HasOverlappedIoCompleted`); volatile, as the
			// kernel may write it concurrently.
			let status = unsafe { ptr::read_volatile(&raw const (*ov).Internal) };
			if status == STATUS_PENDING as usize {
				return Vec::new();
			}
			// SAFETY: the operation completed, so the kernel wrote the byte
			// count before the status read above.
			let sent = unsafe { ptr::read_volatile(&raw const (*ov).InternalHigh) }.min(len);
			// SAFETY: the operation completed: the kernel is done with the
			// buffer (the completion callback never touches it).
			let buf = unsafe { &*self.op.buf.get() };
			buf[sent..len].to_vec()
		}
	}

	impl Drop for WinEnd {
		/// Never waits. With an operation in flight it is cancelled and our
		/// handle closed; the completion that still comes owns the buffer
		/// (through its reference) and closes the I/O object.
		fn drop(&mut self) {
			let Some(handle) = self.handle.take() else {
				return;
			};
			let mut st = self.op.state.lock();
			if self.inflight != Inflight::Idle && st.done.is_none() {
				// Under the lock: the completion cannot close the I/O object
				// before the handle is closed, as the thread pool asks.
				// SAFETY: the operation in flight on our open handle.
				unsafe { CancelIoEx(raw(&handle), self.op.ov.get()) };
				drop(handle);
				st.orphan = Some(self.tp);
				return;
			}
			drop(st);
			drop(handle);
			// SAFETY: nothing is in flight on it; a completion callback still
			// returning keeps it alive until it has.
			unsafe { CloseThreadpoolIo(self.tp) };
		}
	}

	/// What a timer and its thread-pool callback share.
	struct TimerShared {
		state: Mutex<TimerState>,
	}

	struct TimerState {
		waker:      Option<Waker>,
		fired:      bool,
		/// The owner is gone before the callback: it closes the timer.
		owner_gone: bool,
		timer:      PTP_TIMER,
	}

	/// Thread-pool timer callback (runs once): wake the owner's task, or
	/// close the timer when the owner is gone. It never polls anything.
	unsafe extern "system" fn on_timer(
		_instance: PTP_CALLBACK_INSTANCE,
		context: *mut c_void,
		_timer: PTP_TIMER,
	) {
		// SAFETY: the reference `TimerImp::arm` handed to this one-shot
		// callback.
		let shared = unsafe { Arc::from_raw(context.cast::<TimerShared>().cast_const()) };
		let (waker, close) = {
			let mut st = shared.state.lock();
			st.fired = true;
			(st.waker.take(), st.owner_gone.then_some(st.timer))
		};
		if let Some(timer) = close {
			// SAFETY: its owner is gone; freed once this callback returns.
			unsafe { CloseThreadpoolTimer(timer) };
		}
		if let Some(w) = waker {
			w.wake();
		}
	}

	pub struct TimerImp {
		deadline: Instant,
		armed:    Option<Arc<TimerShared>>,
	}

	impl TimerImp {
		pub const fn new(deadline: Instant) -> Self {
			Self { deadline, armed: None }
		}

		/// A thread-pool timer due at the deadline (rounded up to the next
		/// 100 ns tick past it).
		fn arm(&self, waker: &Waker) -> io::Result<Arc<TimerShared>> {
			let shared = Arc::new(TimerShared {
				state: Mutex::new(TimerState {
					waker:      Some(waker.clone()),
					fired:      false,
					owner_gone: false,
					timer:      0,
				}),
			});
			let context = Arc::into_raw(Arc::clone(&shared));
			// SAFETY: `context` stays valid until the callback, which always
			// runs once the timer is set, reclaims it.
			let timer = unsafe {
				CreateThreadpoolTimer(Some(on_timer), context.cast_mut().cast(), ptr::null())
			};
			if timer == 0 {
				let e = io::Error::last_os_error();
				// SAFETY: the reference made above, never handed out.
				drop(unsafe { Arc::from_raw(context) });
				return Err(e);
			}
			shared.state.lock().timer = timer;
			let left = self.deadline.saturating_duration_since(Instant::now());
			// Relative due times are negative, in 100 ns units.
			let due = -i64::try_from(left.as_nanos() / 100 + 1).unwrap_or(i64::MAX);
			let due = FILETIME { dwLowDateTime: due as u32, dwHighDateTime: (due >> 32) as u32 };
			// SAFETY: our timer; a one-shot due time.
			unsafe { SetThreadpoolTimer(timer, &raw const due, 0, 0) };
			Ok(shared)
		}

		pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
			if Instant::now() >= self.deadline {
				return Poll::Ready(());
			}
			match &self.armed {
				Some(shared) => {
					let mut st = shared.state.lock();
					if !st.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
						st.waker = Some(cx.waker().clone());
					}
				},
				None => match self.arm(cx.waker()) {
					Ok(shared) => self.armed = Some(shared),
					Err(_) => return Poll::Ready(()),
				},
			}
			if Instant::now() >= self.deadline {
				Poll::Ready(())
			} else {
				Poll::Pending
			}
		}
	}

	impl Drop for TimerImp {
		/// Never waits: a timer that has fired is closed here, one that has
		/// not is left to its callback, which runs once at the deadline.
		fn drop(&mut self) {
			let Some(shared) = self.armed.take() else {
				return;
			};
			let mut st = shared.state.lock();
			if st.fired {
				let timer = st.timer;
				drop(st);
				// SAFETY: fired, so nothing will start its callback again; a
				// callback still returning keeps it alive until it has.
				unsafe { CloseThreadpoolTimer(timer) };
			} else {
				st.owner_gone = true;
			}
		}
	}
}

#[cfg(all(test, any(target_os = "linux", target_os = "android")))]
mod write_wait_tests {
	use std::{
		io::Read,
		os::fd::AsRawFd,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		task::{Context, Poll, Wake, Waker},
		time::{Duration, Instant},
	};

	use super::{Drain, pipe, reclaim};

	/// A waker that counts its wakes.
	#[derive(Default)]
	struct Count(AtomicUsize);

	impl Wake for Count {
		fn wake(self: Arc<Self>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
	}

	// Failure mode: a pump write of at most `PIPE_BUF` bytes (atomic: all of
	// it or `EAGAIN`) into a pipe with less room than that was woken as soon
	// as the pipe polled writable. gVisor polls a pipe writable whenever any
	// byte fits, so the pump retried, got `EAGAIN` and waited again at once,
	// spinning a CPU for as long as the reader left less room than the write
	// needed. The write must be made, and its task woken, only once it fits.
	// The Linux kernel polls a pipe writable only when a page is free, so
	// there the old wait did not wake early either.
	#[test]
	fn a_pump_write_that_does_not_fit_is_woken_only_once_its_room_comes() {
		let (mut ours, mut theirs) = pipe(true).expect("a pump pipe the child reads");
		// SAFETY: F_GETPIPE_SZ and sysconf only read.
		let (size, page) = unsafe {
			(libc::fcntl(theirs.as_raw_fd(), libc::F_GETPIPE_SZ), libc::sysconf(libc::_SC_PAGESIZE))
		};
		let (size, page) = (usize::try_from(size).unwrap(), usize::try_from(page).unwrap());
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		// Every page in use, the last one 100 bytes full.
		for _ in 1..size / page {
			assert!(matches!(ours.poll_write(&cx, &vec![1u8; page]), Poll::Ready(Ok(n)) if n == page));
		}
		assert!(matches!(ours.poll_write(&cx, &[2u8; 100]), Poll::Ready(Ok(100))));
		// A page-sized write does not fit, and waits.
		let line = vec![3u8; page];
		assert!(ours.poll_write(&cx, &line).is_pending(), "a page does not fit");
		// The reader takes 50 bytes: room for page - 50 bytes, still not
		// the page. Nothing may wake the write for this.
		let mut some = [0u8; 50];
		theirs.read_exact(&mut some).unwrap();
		std::thread::sleep(Duration::from_millis(300));
		assert_eq!(count.0.load(Ordering::SeqCst), 0, "woken before the room for the page came");
		// The reader takes the rest of the first page: now it fits.
		let mut rest = vec![0u8; page - 50];
		theirs.read_exact(&mut rest).unwrap();
		let deadline = Instant::now() + Duration::from_secs(30);
		while count.0.load(Ordering::SeqCst) == 0 {
			assert!(Instant::now() < deadline, "not woken within 30 s of the room coming");
			std::thread::sleep(Duration::from_millis(1));
		}
		assert!(matches!(ours.poll_write(&cx, &line), Poll::Ready(Ok(n)) if n == page));
	}

	// Failure mode: a feed given back while the end's room thread has a write
	// of its held bytes in hand gives those bytes back twice: the thread makes
	// them into the pipe as the give-back drains it, and they come back again
	// as bytes the pipe never took.
	#[test]
	fn a_feed_given_back_with_a_write_in_hand_gives_each_byte_back_once() {
		let (mut ours, theirs) = pipe(true).expect("a pump pipe the child reads");
		let drain = Drain::of(&theirs).map(Arc::new);
		ours.for_reclaim(drain.clone());
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		// Whole pages until one does not fit: that one is in the thread's
		// hand, and the pump holds it.
		let mut expected = Vec::new();
		let mut held = None;
		for i in 0..1024u32 {
			let page = vec![u8::try_from(i % 250).unwrap() + 1; 4096];
			match ours.poll_write(&cx, &page) {
				Poll::Ready(Ok(4096)) => expected.extend_from_slice(&page),
				Poll::Pending => {
					held = Some(page);
					break;
				},
				other => panic!("a page write: {other:?}"),
			}
		}
		let held = held.expect("the pipe filled");
		std::thread::sleep(Duration::from_millis(100));
		assert_eq!(count.0.load(Ordering::SeqCst), 0, "the page was made with the pipe full");
		let back = reclaim(Some(ours), &theirs, &held, drain.as_deref());
		expected.extend_from_slice(&held);
		assert_eq!(back.len(), expected.len(), "each byte once");
		assert!(back == expected, "in order");
	}

	// Failure mode: the give-back reads the pipe to end of file, which a
	// process another thread forked holds off until its exec (or its end):
	// the dropping thread waits that long, the shell's own thread when the
	// last holder's `ExtProc` is dropped there. It must take what the pipe
	// holds and return while such a copy of the write end lives.
	#[test]
	fn a_feed_given_back_while_a_forked_copy_of_its_write_end_lives_returns_with_every_byte() {
		let (mut ours, theirs) = pipe(true).expect("a pump pipe the child reads");
		let drain = Drain::of(&theirs).map(Arc::new);
		assert!(drain.is_some(), "Linux with /proc gives a feed its drain");
		ours.for_reclaim(drain.clone());
		let cx = Context::from_waker(Waker::noop());
		assert!(matches!(ours.poll_write(&cx, b"held line\n"), Poll::Ready(Ok(10))));
		// A process forked now holds a copy of every descriptor, our write end
		// among them, until it reads a byte from `hold` (or `hold` closes).
		let (hold_r, mut hold_w) = std::io::pipe().unwrap();
		// SAFETY: the child only reads one byte and exits, both
		// async-signal-safe.
		let pid = unsafe { libc::fork() };
		if pid == 0 {
			let mut byte = 0u8;
			// SAFETY: reads one byte into a local from a descriptor it holds.
			unsafe {
				libc::read(hold_r.as_raw_fd(), (&raw mut byte).cast(), 1);
				libc::_exit(0);
			}
		}
		assert!(pid > 0, "fork: {}", std::io::Error::last_os_error());
		drop(hold_r);
		let (tx, done) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let _ = tx.send(reclaim(Some(ours), &theirs, b"", drain.as_deref()));
		});
		// The wait only names a hang: the give-back returns at once or never.
		let back = done.recv_timeout(Duration::from_secs(30));
		let mut status = 0;
		// SAFETY: a non-blocking wait for our own child.
		let gone = unsafe { libc::waitpid(pid, &raw mut status, libc::WNOHANG) };
		std::io::Write::write_all(&mut hold_w, b"x").unwrap();
		drop(hold_w);
		// SAFETY: as above, now waiting for it to end.
		unsafe { libc::waitpid(pid, &raw mut status, 0) };
		assert_eq!(gone, 0, "the forked copy was still open when the give-back returned");
		assert_eq!(
			back.as_deref(),
			Ok(&b"held line\n"[..]),
			"every byte, without waiting for the copy"
		);
	}

	// Failure mode: where no room thread can be made (`pthread_create` at
	// the thread limit) a pump write that would wait fails, where the base
	// waited. It must wait for the pipe to poll writable instead, and be made
	// once, by the end itself.
	#[test]
	fn a_pump_write_waits_for_pollout_where_no_thread_can_be_made() {
		let (mut ours, mut theirs) = pipe(true).expect("a pump pipe the child reads");
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		crate::sys::room::no_thread_on_this_thread(true);
		let page = [5u8; 4096];
		let mut put = 0;
		loop {
			match ours.poll_write(&cx, &page) {
				Poll::Ready(Ok(n)) => put += n,
				Poll::Ready(Err(e)) => panic!("a pump write that waits fails: {e}"),
				Poll::Pending => break,
			}
			assert!(put < 16 << 20, "the pipe never filled");
		}
		let mut got = vec![0u8; put];
		theirs
			.read_exact(&mut got)
			.expect("read what the pipe holds");
		let deadline = Instant::now() + Duration::from_secs(30);
		let n = loop {
			match ours.poll_write(&cx, &page) {
				Poll::Ready(Ok(n)) => break n,
				Poll::Ready(Err(e)) => panic!("the write that waited: {e}"),
				Poll::Pending => {
					assert!(Instant::now() < deadline, "not written within 30 s");
					std::thread::sleep(Duration::from_millis(1));
				},
			}
		};
		crate::sys::room::no_thread_on_this_thread(false);
		assert_eq!(n, page.len());
		drop(ours);
		let mut last = Vec::new();
		theirs.read_to_end(&mut last).expect("read the rest");
		assert_eq!(last, page, "written by the end itself, once");
	}
}
