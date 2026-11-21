//! Readiness of pipes and sockets without blocking the engine thread (Unix).
//!
//! The other end of a FIFO, a `/dev/fd/N` or a socket may be a vproc of the
//! same engine, so a `read(2)` or `write(2)` that waits in the kernel would
//! deadlock the scheduler. [`StdFile`](crate::sys::StdFile) therefore asks
//! [`now`] first and only does I/O that cannot wait; otherwise it registers
//! the engine waker with [`watch`] and returns `Pending`.
//!
//! The descriptor's flags are never changed: `O_NONBLOCK` lives on the open
//! file description, which externals inherit and other processes may share.
//!
//! One process-wide thread waits on the watched descriptors plus a wake pipe,
//! wakes each waker once its descriptor is ready (or failed, or hung up), and
//! forgets it. A watch whose file is dropped first is removed with
//! [`Watch`]'s `Drop`.
//!
//! The wait is `poll(2)`, except on macOS: there neither `poll` nor `kqueue`
//! reports a FIFO whose last writer closed (measured: `revents` 0, no
//! `EV_EOF`), so a reader would never see end of file; `select(2)` does, and
//! also handles terminals (macOS `poll` answers `POLLNVAL` for devices). Fds
//! at or above `FD_SETSIZE` fall back to `poll` there, rechecked every
//! 20 ms; a terminal that high reads as always ready, i.e. blocking.

use std::{
	io::{self, PipeReader, PipeWriter, Read, Write},
	os::fd::{AsRawFd, RawFd},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	task::Waker,
	thread,
	time::{Duration, Instant},
};

use parking_lot::Mutex;

/// Wait for input.
pub const READ: i16 = libc::POLLIN;
/// Wait for output space.
pub const WRITE: i16 = libc::POLLOUT;

/// The most a write carries after [`now`] reported `WRITE`: `PIPE_BUF`. A
/// Linux pipe polls writable only with a free page, which takes that much.
#[cfg(target_os = "linux")]
pub(crate) const WRITE_CHUNK: usize = libc::PIPE_BUF;
/// The most a write carries after [`now`] reported `WRITE`: `PIPE_BUF` of
/// `<sys/syslimits.h>` (POSIX: a pipe that polls writable takes this much).
#[cfg(not(target_os = "linux"))]
pub(crate) const WRITE_CHUNK: usize = 512;

/// Bytes a write to `fd` may carry without waiting once [`now`] reported
/// `WRITE`: at most [`WRITE_CHUNK`], and for a pipe no more than it has
/// free (its capacity less what it holds). A pipe can poll writable with
/// less than `PIPE_BUF` free: gVisor reports `POLLOUT` with one byte free,
/// and then fails a non-blocking write of more than the free space with
/// `EAGAIN`. 0 when a pipe that still has a reader is full. The capacity
/// is read on every call: `F_SETPIPE_SZ` can change it at any time.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn write_room(fd: RawFd) -> usize {
	// SAFETY: `F_GETPIPE_SZ` takes no argument; `fd` is the caller's open
	// descriptor.
	let capacity = unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) };
	let mut queued: libc::c_int = 0;
	// SAFETY: `FIONREAD` writes one `c_int` through the pointer, which is
	// valid for the call; `fd` is the caller's open descriptor.
	let status = unsafe { libc::ioctl(fd, libc::FIONREAD as _, &raw mut queued) };
	if capacity < 0 || status < 0 {
		// Not a pipe (a socket or a terminal).
		return WRITE_CHUNK;
	}
	match usize::try_from(capacity.saturating_sub(queued)).unwrap_or(0) {
		// A pipe whose reader left fails a write at once (`EPIPE`).
		0 if failed(fd) => WRITE_CHUNK,
		free => free.min(WRITE_CHUNK),
	}
}

/// Whether `fd` reports an error or a hang-up now (a pipe's write end whose
/// reader closed).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn failed(fd: RawFd) -> bool {
	let mut p = libc::pollfd { fd, events: 0, revents: 0 };
	// SAFETY: one valid pollfd; a zero timeout never waits.
	let n = unsafe { libc::poll(&raw mut p, 1, 0) };
	n > 0 && (p.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL)) != 0
}

/// Whether `fd` is ready for `events` right now (also when it hung up or
/// failed: the I/O then reports end of file or the error without waiting).
pub fn now(fd: RawFd, events: i16) -> io::Result<bool> {
	#[cfg(target_os = "macos")]
	if selectable(fd) {
		return select_now(fd, events);
	}
	poll_now(fd, events)
}

fn poll_now(fd: RawFd, events: i16) -> io::Result<bool> {
	let mut p = libc::pollfd { fd, events, revents: 0 };
	loop {
		// SAFETY: one valid pollfd; a zero timeout never waits.
		let n = unsafe { libc::poll(&raw mut p, 1, 0) };
		if n >= 0 {
			return Ok(n > 0 && p.revents != 0);
		}
		let e = io::Error::last_os_error();
		if e.kind() != io::ErrorKind::Interrupted {
			return Err(e);
		}
	}
}

/// A registered wait; dropping it forgets the registration.
#[derive(Debug)]
pub struct Watch(u64);

impl Drop for Watch {
	fn drop(&mut self) {
		POLLER.forget(self.0);
	}
}

/// Wake `waker` once `fd` is ready for `events`.
pub fn watch(fd: RawFd, events: i16, waker: &Waker) -> io::Result<Watch> {
	POLLER.add(fd, events, waker)
}

/// Wake `waker` once `after` has passed: the retry for a descriptor that
/// polls ready but took nothing, where a readiness watch would fire at once.
#[cfg(target_os = "linux")]
pub fn wake_after(waker: &Waker, after: Duration) -> io::Result<()> {
	POLLER.timer(Instant::now() + after, waker)
}

struct Entry {
	id:     u64,
	fd:     RawFd,
	events: i16,
	waker:  Waker,
}

struct Poller {
	entries: Mutex<Vec<Entry>>,
	/// One-shot timed wakes ([`wake_after`]).
	timers:  Mutex<Vec<(Instant, Waker)>>,
	next:    AtomicU64,
	/// Write end of the wake pipe; `None` when the thread could not start.
	wake:    Option<PipeWriter>,
}

static POLLER: LazyLock<Poller> = LazyLock::new(Poller::start);

impl Poller {
	fn start() -> Self {
		let started = io::pipe().and_then(|(r, w)| {
			set_nonblocking(w.as_raw_fd())?;
			thread::Builder::new()
				.name("obash-ready".into())
				.stack_size(64 << 10)
				.spawn(move || run(r))?;
			Ok(w)
		});
		Self {
			entries: Mutex::new(Vec::new()),
			timers:  Mutex::new(Vec::new()),
			next:    AtomicU64::new(1),
			wake:    started.ok(),
		}
	}

	fn add(&self, fd: RawFd, events: i16, waker: &Waker) -> io::Result<Watch> {
		let Some(wake) = &self.wake else {
			return Err(io::Error::other(PollerDown));
		};
		let id = self.next.fetch_add(1, Ordering::Relaxed);
		self
			.entries
			.lock()
			.push(Entry { id, fd, events, waker: waker.clone() });
		// A full wake pipe already guarantees a rescan.
		let _ = (&*wake).write(&[1]);
		Ok(Watch(id))
	}

	#[cfg(target_os = "linux")]
	fn timer(&self, at: Instant, waker: &Waker) -> io::Result<()> {
		let Some(wake) = &self.wake else {
			return Err(io::Error::other(PollerDown));
		};
		self.timers.lock().push((at, waker.clone()));
		// A full wake pipe already guarantees a rescan.
		let _ = (&*wake).write(&[1]);
		Ok(())
	}

	/// Forgets watch `id`. One dropped before it fired is mostly its file
	/// closing, and the thread's wait (`poll(2)`, `select(2)`) holds a
	/// reference to every file it waits on until it returns: the thread is
	/// woken, so it lets that file go now rather than at its next wake. A
	/// pipe whose last reader closed then fails its writer's next write.
	fn forget(&self, id: u64) {
		let removed = {
			let mut entries = self.entries.lock();
			let before = entries.len();
			entries.retain(|e| e.id != id);
			entries.len() != before
		};
		if removed && let Some(wake) = &self.wake {
			// A full wake pipe already guarantees a rescan.
			let _ = (&*wake).write(&[1]);
		}
	}
}

/// The readiness thread could not be started (no threads or no pipes left).
#[derive(Debug, thiserror::Error)]
#[error("readiness poller thread is not running")]
struct PollerDown;

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
	// SAFETY: fcntl on our own private pipe end.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	// SAFETY: as above.
	if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

/// One watched descriptor, as the waiting thread sees it.
#[derive(Clone, Copy)]
struct Watched {
	id:     u64,
	fd:     RawFd,
	events: i16,
}

/// Test only: the descriptors of the readiness thread's last wait, written
/// before it starts, and a count that is odd while the thread is in that
/// wait's `poll(2)` call and nothing else (made odd just before the call,
/// even as it returns). A test that reads the count odd, the descriptors,
/// the thread asleep, and the same count again knows the thread sleeps in
/// that `poll(2)` with those files: the call is its only way to sleep while
/// the count is odd.
#[cfg(all(test, not(target_os = "macos")))]
static IN_WAIT: Mutex<Vec<RawFd>> = Mutex::new(Vec::new());
#[cfg(all(test, not(target_os = "macos")))]
static IN_POLL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn run(mut wake: PipeReader) {
	let mut watched: Vec<Watched> = Vec::new();
	let mut drain = [0u8; 64];
	loop {
		watched.clear();
		watched.extend(POLLER.entries.lock().iter().map(|e| Watched {
			id:     e.id,
			fd:     e.fd,
			events: e.events,
		}));
		let timeout = POLLER
			.timers
			.lock()
			.iter()
			.map(|(at, _)| *at)
			.min()
			.map(|at| at.saturating_duration_since(Instant::now()));
		let (woke, ready) = wait(wake.as_raw_fd(), &watched, timeout);
		if woke {
			// Data is present, so this read returns at once.
			let _ = wake.read(&mut drain);
		}
		let mut woken = Vec::with_capacity(ready.len());
		let now = Instant::now();
		POLLER.timers.lock().retain(|(at, waker)| {
			if *at <= now {
				woken.push(waker.clone());
				false
			} else {
				true
			}
		});
		if !ready.is_empty() {
			POLLER.entries.lock().retain(|e| {
				if ready.contains(&e.id) {
					woken.push(e.waker.clone());
					false
				} else {
					true
				}
			});
		}
		for w in woken {
			w.wake();
		}
	}
}

/// `timeout` as `poll(2)` milliseconds, rounded up; `-1` waits for ever.
#[cfg(not(target_os = "macos"))]
fn poll_timeout(timeout: Option<Duration>) -> libc::c_int {
	timeout.map_or(-1, |d| {
		libc::c_int::try_from(d.as_micros().div_ceil(1000)).unwrap_or(libc::c_int::MAX)
	})
}

/// Wait until the wake pipe or a watched fd is ready, or `timeout` passed:
/// whether the wake pipe fired, and the ids that are ready.
#[cfg(not(target_os = "macos"))]
fn wait(wake: RawFd, watched: &[Watched], timeout: Option<Duration>) -> (bool, Vec<u64>) {
	let mut fds: Vec<libc::pollfd> = Vec::with_capacity(watched.len() + 1);
	fds.push(libc::pollfd { fd: wake, events: libc::POLLIN, revents: 0 });
	fds.extend(watched.iter().map(|w| libc::pollfd {
		fd:      w.fd,
		events:  w.events,
		revents: 0,
	}));
	#[cfg(test)]
	{
		*IN_WAIT.lock() = watched.iter().map(|w| w.fd).collect();
		IN_POLL.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
	}
	// SAFETY: `fds` holds `fds.len()` valid pollfds.
	let n =
		unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, poll_timeout(timeout)) };
	#[cfg(test)]
	IN_POLL.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
	if n < 0 {
		return (false, Vec::new());
	}
	let ready = fds[1..]
		.iter()
		.zip(watched)
		.filter(|(p, _)| p.revents != 0)
		.map(|(_, w)| w.id)
		.collect();
	(fds[0].revents != 0, ready)
}

/// Whether `select(2)` can take `fd`.
#[cfg(target_os = "macos")]
fn selectable(fd: RawFd) -> bool {
	usize::try_from(fd).is_ok_and(|fd| fd < libc::FD_SETSIZE)
}

/// An empty `fd_set`.
#[cfg(target_os = "macos")]
fn fd_set() -> libc::fd_set {
	// SAFETY: fd_set is plain data; FD_ZERO initializes it.
	let mut set: libc::fd_set = unsafe { std::mem::zeroed() };
	// SAFETY: `set` is a valid, writable fd_set.
	unsafe { libc::FD_ZERO(&raw mut set) };
	set
}

/// `select(2)` with a zero timeout on one fd (`fd < FD_SETSIZE`).
#[cfg(target_os = "macos")]
fn select_now(fd: RawFd, events: i16) -> io::Result<bool> {
	let mut set = fd_set();
	// SAFETY: `fd` is below FD_SETSIZE; `set` is valid.
	unsafe { libc::FD_SET(fd, &raw mut set) };
	let (rd, wr): (*mut libc::fd_set, *mut libc::fd_set) = if events & WRITE != 0 {
		(std::ptr::null_mut(), &raw mut set)
	} else {
		(&raw mut set, std::ptr::null_mut())
	};
	loop {
		let mut zero = libc::timeval { tv_sec: 0, tv_usec: 0 };
		// SAFETY: the set pointer is valid or null; a zero timeout never waits.
		let n = unsafe { libc::select(fd + 1, rd, wr, std::ptr::null_mut(), &raw mut zero) };
		if n >= 0 {
			return Ok(n > 0);
		}
		let e = io::Error::last_os_error();
		if e.kind() != io::ErrorKind::Interrupted {
			return Err(e);
		}
	}
}

/// Whether `fd` is still an open descriptor.
#[cfg(target_os = "macos")]
fn is_open(fd: RawFd) -> bool {
	// SAFETY: F_GETFD only inspects the descriptor table.
	unsafe { libc::fcntl(fd, libc::F_GETFD) >= 0 }
}

/// macOS: `select(2)` over the fds below `FD_SETSIZE`; others are polled
/// every 20 ms. A closed watched fd (`EBADF`) is reported ready, so its
/// owner sees the error instead of the thread spinning. `timeout` bounds
/// the wait for the timed wakes.
#[cfg(target_os = "macos")]
fn wait(wake: RawFd, watched: &[Watched], timeout: Option<Duration>) -> (bool, Vec<u64>) {
	let (mut rd, mut wr) = (fd_set(), fd_set());
	let mut nfds = 0;
	let mut add = |fd: RawFd, set: &mut libc::fd_set| {
		// SAFETY: callers pass fds below FD_SETSIZE; `set` is valid.
		unsafe { libc::FD_SET(fd, set) };
		nfds = nfds.max(fd + 1);
	};
	let wake_selectable = selectable(wake);
	if wake_selectable {
		add(wake, &mut rd);
	}
	let mut slow = !wake_selectable;
	for w in watched {
		if !selectable(w.fd) {
			slow = true;
		} else if w.events & WRITE != 0 {
			add(w.fd, &mut wr);
		} else {
			add(w.fd, &mut rd);
		}
	}
	let tick = if slow {
		Some(Duration::from_millis(20))
	} else {
		None
	};
	let limit = match (tick, timeout) {
		(Some(a), Some(b)) => Some(a.min(b)),
		(a, b) => a.or(b),
	};
	let mut tv = limit.map(|d| libc::timeval {
		tv_sec:  libc::time_t::try_from(d.as_secs()).unwrap_or(libc::time_t::MAX),
		tv_usec: libc::suseconds_t::try_from(d.subsec_micros()).unwrap_or(0),
	});
	let timeout = tv
		.as_mut()
		.map_or(std::ptr::null_mut(), |tv| std::ptr::from_mut(tv));
	// SAFETY: both sets are valid; the timeout is valid or null (wait).
	let n = unsafe { libc::select(nfds, &raw mut rd, &raw mut wr, std::ptr::null_mut(), timeout) };
	if n < 0 {
		if io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
			let gone = watched
				.iter()
				.filter(|w| !is_open(w.fd))
				.map(|w| w.id)
				.collect();
			return (false, gone);
		}
		return (false, Vec::new());
	}
	let woke = if wake_selectable {
		// SAFETY: `rd` is valid; `wake` is below FD_SETSIZE.
		unsafe { libc::FD_ISSET(wake, &raw const rd) }
	} else {
		poll_now(wake, READ).unwrap_or(false)
	};
	let ready = watched
		.iter()
		.filter(|w| {
			if !selectable(w.fd) {
				return poll_now(w.fd, w.events).unwrap_or(true);
			}
			let set = if w.events & WRITE != 0 {
				&raw const wr
			} else {
				&raw const rd
			};
			// SAFETY: `set` is valid; the fd is below FD_SETSIZE.
			unsafe { libc::FD_ISSET(w.fd, set) }
		})
		.map(|w| w.id)
		.collect();
	(woke, ready)
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		task::Wake,
		time::{Duration, Instant},
	};

	use super::*;

	struct Unpark(thread::Thread);

	impl Wake for Unpark {
		fn wake(self: Arc<Self>) {
			self.0.unpark();
		}
	}

	#[test]
	fn a_watch_wakes_once_the_pipe_becomes_readable() {
		let (r, mut w) = io::pipe().unwrap();
		assert!(!now(r.as_raw_fd(), READ).unwrap());
		assert!(now(w.as_raw_fd(), WRITE).unwrap());
		let waker = Waker::from(Arc::new(Unpark(thread::current())));
		let _watch = watch(r.as_raw_fd(), READ, &waker).unwrap();
		let writer = thread::spawn(move || {
			thread::sleep(Duration::from_millis(50));
			w.write_all(b"x").unwrap();
			w
		});
		let deadline = Instant::now() + Duration::from_secs(10);
		while !now(r.as_raw_fd(), READ).unwrap() {
			assert!(Instant::now() < deadline);
			thread::park_timeout(Duration::from_millis(100));
		}
		drop(writer.join().unwrap());
		assert!(now(r.as_raw_fd(), READ).unwrap(), "hang-up also counts as ready");
	}

	#[test]
	fn dropping_a_watch_forgets_it() {
		let (r, _w) = io::pipe().unwrap();
		let watch = watch(r.as_raw_fd(), READ, Waker::noop()).unwrap();
		let id = watch.0;
		drop(watch);
		assert!(!POLLER.entries.lock().iter().any(|e| e.id == id));
	}

	/// A watched read end that closes lets its pipe go at once: the waiting
	/// thread holds a reference to every file it waits on, so a watch
	/// dropped without waking it kept the pipe's reader alive until
	/// something else woke the thread, and the writer went on writing into
	/// a pipe nobody can read. In a process of its own, where nothing else
	/// wakes the thread. Before `r` closes, the thread is known to sleep in
	/// a `poll(2)` that holds `r`: the test reads `IN_POLL` odd, `IN_WAIT`
	/// with `r`, the thread asleep (`S`) in procfs, then `IN_POLL` unchanged
	/// (see `IN_POLL`). The writer side is read with a `poll(2)` for no
	/// event, which reports `POLLERR` once the pipe has no reader; no byte is
	/// written, since a byte would make `r` readable and wake the thread.
	#[cfg(target_os = "linux")]
	#[test]
	fn closing_a_watched_read_end_gives_its_writer_a_broken_pipe() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::closing_a_watched_read_end_gives_its_writer_a_broken_pipe"),
			|| {
				let (r, w) = io::pipe().unwrap();
				let watch = watch(r.as_raw_fd(), READ, Waker::noop()).unwrap();
				let rfd = r.as_raw_fd();
				// The readiness thread's scheduler state, from procfs.
				let state = || -> Option<String> {
					for task in std::fs::read_dir("/proc/self/task").ok()? {
						let dir = task.ok()?.path();
						let comm = std::fs::read_to_string(dir.join("comm")).ok()?;
						if comm.trim() == "obash-ready" {
							let stat = std::fs::read_to_string(dir.join("stat")).ok()?;
							let (_, rest) = stat.rsplit_once(") ")?;
							return rest.split(' ').next().map(str::to_owned);
						}
					}
					None
				};
				let deadline = Instant::now() + Duration::from_secs(10);
				loop {
					let before = IN_POLL.load(std::sync::atomic::Ordering::SeqCst);
					if before % 2 == 1 && IN_WAIT.lock().contains(&rfd) {
						let now = state().expect("the readiness thread's state in /proc/self/task");
						if now == "S" && IN_POLL.load(std::sync::atomic::Ordering::SeqCst) == before {
							break;
						}
					}
					assert!(Instant::now() < deadline, "the thread never slept in a poll on `r`");
					thread::sleep(Duration::from_millis(1));
				}
				drop(watch);
				drop(r);
				let mut pfd = libc::pollfd { fd: w.as_raw_fd(), events: 0, revents: 0 };
				// SAFETY: one valid pollfd for our open descriptor.
				let n = unsafe { libc::poll(&raw mut pfd, 1, 2000) };
				assert!(
					n == 1 && pfd.revents & libc::POLLERR != 0,
					"the pipe still had a reader 2 s after its only read end closed (poll {n}, revents \
					 {:#x})",
					pfd.revents
				);
			},
		);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn a_timed_wake_fires_after_its_delay() {
		let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
		struct Set(Arc<std::sync::atomic::AtomicBool>, thread::Thread);
		impl Wake for Set {
			fn wake(self: Arc<Self>) {
				self.0.store(true, std::sync::atomic::Ordering::SeqCst);
				self.1.unpark();
			}
		}
		let start = Instant::now();
		let waker = Waker::from(Arc::new(Set(Arc::clone(&flag), thread::current())));
		wake_after(&waker, Duration::from_millis(30)).unwrap();
		let deadline = start + Duration::from_secs(10);
		while !flag.load(std::sync::atomic::Ordering::SeqCst) {
			assert!(Instant::now() < deadline, "the timed wake never fired");
			thread::park_timeout(Duration::from_millis(100));
		}
		assert!(start.elapsed() >= Duration::from_millis(30), "{:?}", start.elapsed());
	}
}
