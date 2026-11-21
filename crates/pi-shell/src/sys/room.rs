//! A write a pipe cannot take now, made by a thread that waits for it in the
//! kernel (Linux).
//!
//! A non-blocking write of at most `PIPE_BUF` bytes to a pipe is atomic: all
//! of it fits, or it fails with `EAGAIN`. A writer that waits for the pipe to
//! poll writable and tries again does not fit that: gVisor polls a pipe
//! writable whenever any byte fits, so such a writer woke, failed and waited
//! again at once, spinning a CPU for as long as the reader left less room than
//! it needed. Waiting instead for an edge each time the reader takes bytes,
//! and checking the room on each one, spun as well against a reader that takes
//! the pipe a byte at a time (`sh`'s `read`): each byte it took was one edge
//! and a few system calls, close to a CPU under gVisor. bash's writer has
//! neither cost: its blocking `write(2)` sleeps in the kernel until the write
//! fits.
//!
//! So a write that would wait is made the same way: through a blocking
//! description of the same pipe end, by a thread of the end's own, which the
//! kernel wakes only once the write fits (a write of at most `PIPE_BUF` bytes
//! whole, a larger one as the reader takes it) or once no reader is left. The
//! task that asked waits, and is woken once the thread is done, with every
//! other task waiting on the end ([`Wakers`]); polled again with the same
//! bytes, it gets the result.
//!
//! **Whose result.** The engine polls every vproc with its one waker, and a
//! poll carries nothing but the bytes, so the bytes say whose result it is.
//! Not the buffer's address: a vproc killed while it waited leaves a result
//! nobody takes, and a later write of other bytes in a buffer the allocator
//! hands out again at that address would take it, and its bytes would never
//! be made. A later write of the same bytes may take it: the pipe then holds
//! those bytes once, which is what it holds when the killed vproc's write is
//! not made, as in bash.
//!
//! **Bounds.** One [`Room`] per open description of a pipe's write end that
//! the shell writes through (one per shared pipe end: the engine's handles of
//! an end share it), and at most one thread per room. The thread is made at
//! the end's first write that waits, sleeps on a condition variable between
//! such writes, uses no CPU while it waits, has a 128 KiB stack, and ends once
//! the room is dropped and it has no write in hand. So a process has at most
//! as many of these threads as it has shared pipe write ends that ever had to
//! wait, plus those still finishing a write after their end was dropped.
//!
//! **Cancellation.** A write the thread has in hand cannot be called back:
//! nothing ends a blocking `write(2)` early short of a signal handler, which
//! a library may not install. A write whose task was dropped while it waited
//! (its vproc killed) is still made once it fits, or fails once the pipe's
//! last reader is gone, and the thread then ends; until then it holds the
//! pipe's write end open. A reader that holds the pipe without ever reading
//! keeps the thread blocked for as long; in bash the killed writer's process
//! ends at once. The shell's own exit ends the thread with the process when
//! the shell is a process of its own. Bytes the memory pipe this replaces
//! had taken reached their reader the same way, through the pump, after
//! their writer was gone.

use std::{
	collections::VecDeque,
	fs,
	io::{self, Write},
	os::{
		fd::{AsRawFd, RawFd},
		unix::fs::OpenOptionsExt,
	},
	ptr,
	sync::Arc,
	task::{Context, Poll},
};

use parking_lot::{Condvar, Mutex, MutexGuard};

use crate::sys::wakers::Wakers;

/// Most bytes of one write the thread is handed; it makes a larger write in
/// part, as a write to a pipe may be made.
const MOST: usize = 1 << 16;

/// Most results kept for tasks that have not polled again; past it the
/// oldest goes (its task was dropped).
const KEPT: usize = 16;

/// The thread of a pipe write end, and the write it has in hand: see the
/// module docs.
pub struct Room(Arc<Inner>);

struct Inner {
	/// A blocking description of the write end, the thread's own.
	file:  fs::File,
	state: Mutex<State>,
	/// The thread waits here for a write to make, or for the room to go.
	work:  Condvar,
	/// The tasks waiting for the write in hand to be made.
	tasks: Wakers,
}

#[derive(Default)]
struct State {
	/// A write is in hand.
	busy:   bool,
	/// The bytes of the write in hand.
	data:   Vec<u8>,
	/// Results of writes made, until the task that asked polls again.
	done:   VecDeque<Done>,
	/// The thread runs.
	thread: bool,
	/// The room was dropped: the thread ends once it has no write in hand.
	closed: bool,
}

/// A write made, whose task has not polled again.
struct Done {
	data:   Vec<u8>,
	result: io::Result<usize>,
}

impl Room {
	/// A room for the pipe write end `fd`. Fails where `fd` is not a pipe (a
	/// socket's writes take what fits, so its `POLLOUT` means what it says)
	/// or where no description of it can be opened (no `/proc` mounted).
	pub fn new(fd: RawFd) -> io::Result<Self> {
		// SAFETY: F_GETPIPE_SZ only reads; it fails on anything but a pipe.
		if unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) } < 0 {
			return Err(io::Error::last_os_error());
		}
		// A description of its own: opened non-blocking, so the open never
		// waits for a reader, then made blocking.
		let file = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(format!("/proc/self/fd/{fd}"))
			.map_err(|e| {
				if e.raw_os_error() == Some(libc::ENXIO) {
					io::ErrorKind::BrokenPipe.into()
				} else {
					e
				}
			})?;
		let own = file.as_raw_fd();
		// SAFETY: F_GETFL on a descriptor this room owns.
		let flags = unsafe { libc::fcntl(own, libc::F_GETFL) };
		// SAFETY: F_SETFL on the same descriptor, which no one else holds.
		if flags < 0 || unsafe { libc::fcntl(own, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(Self(Arc::new(Inner {
			file,
			state: Mutex::default(),
			work: Condvar::new(),
			tasks: Wakers::default(),
		})))
	}

	/// Write `buf`. While the thread has no write in hand, `now` tries it
	/// (a non-blocking write of the end); one that would wait is handed to
	/// the thread and the task waits. The task polls again with the same
	/// bytes to learn the result. A write the thread has in hand keeps every
	/// other one waiting until it is made, so the end's writes keep their
	/// order.
	pub fn poll_write(
		&self,
		cx: &Context<'_>,
		buf: &[u8],
		mut now: impl FnMut(&[u8]) -> io::Result<usize>,
	) -> Poll<io::Result<usize>> {
		let take = buf.len().min(MOST);
		let mut st = self.0.state.lock();
		if let Some(i) = st
			.done
			.iter()
			.position(|d| d.data.as_slice() == &buf[..take])
		{
			let done = st.done.remove(i).expect("found");
			return Poll::Ready(done.result);
		}
		if st.busy {
			// This write or another one is in hand: wait for it.
			self.0.tasks.add(cx.waker());
			return Poll::Pending;
		}
		loop {
			match now(buf) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
				r => return Poll::Ready(r),
			}
		}
		if !st.thread {
			let inner = Arc::clone(&self.0);
			let spawned = std::thread::Builder::new()
				.name("obash-room".into())
				.stack_size(128 << 10)
				.spawn(move || run(&inner));
			if let Err(e) = spawned {
				return Poll::Ready(Err(e));
			}
			st.thread = true;
		}
		st.data.clear();
		st.data.extend_from_slice(&buf[..take]);
		st.busy = true;
		// Stored before the thread can finish: it takes the tasks only once it
		// holds the state again.
		self.0.tasks.add(cx.waker());
		self.0.work.notify_one();
		Poll::Pending
	}

	/// Whether the thread runs (tests).
	#[cfg(test)]
	fn thread_runs(&self) -> bool {
		self.0.state.lock().thread
	}
}

impl Drop for Room {
	fn drop(&mut self) {
		self.0.state.lock().closed = true;
		self.0.work.notify_one();
	}
}

/// The thread: make each write handed to it, until the room is dropped and no
/// write is in hand.
fn run(inner: &Inner) {
	block_signals();
	let mut st = inner.state.lock();
	loop {
		while !st.busy && !st.closed {
			inner.work.wait(&mut st);
		}
		if !st.busy {
			break;
		}
		let data = std::mem::take(&mut st.data);
		let result = MutexGuard::unlocked(&mut st, || write_whole(&inner.file, &data));
		if st.done.len() == KEPT {
			st.done.pop_front();
		}
		st.done.push_back(Done { data, result });
		st.busy = false;
		let tasks = inner.tasks.take();
		MutexGuard::unlocked(&mut st, || {
			for w in tasks {
				w.wake();
			}
		});
	}
	st.thread = false;
}

/// Block every signal in this thread: it makes blocking writes and nothing
/// else, and a signal meant for the shell must not land here. A `SIGPIPE`
/// its write raises stays pending on it and is taken back.
fn block_signals() {
	// SAFETY: a valid set filled by libc, applied to this thread only.
	unsafe {
		let mut all: libc::sigset_t = std::mem::zeroed();
		libc::sigfillset(&raw mut all);
		libc::pthread_sigmask(libc::SIG_SETMASK, &raw const all, ptr::null_mut());
	}
}

/// Write all of `data` to the blocking `file`, waiting in the kernel for
/// room; the bytes written, or the error if none was.
fn write_whole(mut file: &fs::File, data: &[u8]) -> io::Result<usize> {
	let mut off = 0;
	while off < data.len() {
		match file.write(&data[off..]) {
			Ok(0) => break,
			Ok(n) => off += n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
			Err(e) => {
				if e.raw_os_error() == Some(libc::EPIPE) {
					take_sigpipe();
				}
				return if off > 0 { Ok(off) } else { Err(e) };
			},
		}
	}
	Ok(off)
}

/// Take the `SIGPIPE` an `EPIPE` raised on this thread, where it is blocked.
fn take_sigpipe() {
	// SAFETY: a valid set; a zero timeout only takes a pending signal.
	unsafe {
		let mut pipe: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&raw mut pipe);
		libc::sigaddset(&raw mut pipe, libc::SIGPIPE);
		let now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
		while libc::sigtimedwait(&raw const pipe, ptr::null_mut(), &raw const now) < 0
			&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
		{}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::Read,
		os::fd::OwnedFd,
		sync::atomic::{AtomicUsize, Ordering},
		task::{Wake, Waker},
		time::{Duration, Instant},
	};

	use super::*;

	/// A waker that counts its wakes.
	#[derive(Default)]
	struct Count(AtomicUsize);

	impl Wake for Count {
		fn wake(self: Arc<Self>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
	}

	impl Count {
		fn wakes(&self) -> usize {
			self.0.load(Ordering::SeqCst)
		}
	}

	fn nonblocking(f: &fs::File) {
		// SAFETY: F_GETFL and F_SETFL on a descriptor this test owns.
		unsafe {
			let flags = libc::fcntl(f.as_raw_fd(), libc::F_GETFL);
			libc::fcntl(f.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
		}
	}

	/// A pipe whose ends are both non-blocking, filled with zeros until a page
	/// does not fit: the write end and the reader.
	fn full_pipe() -> (fs::File, fs::File) {
		let (r, w) = io::pipe().unwrap();
		let (r, w) = (fs::File::from(OwnedFd::from(r)), fs::File::from(OwnedFd::from(w)));
		nonblocking(&w);
		nonblocking(&r);
		let page = [0u8; 4096];
		while (&w).write(&page).is_ok() {}
		(w, r)
	}

	/// Read what the pipe holds until `done`, keeping the bytes that are not
	/// the zeros it was filled with; fails after 30 s.
	fn read_until(r: &mut fs::File, seen: &mut Vec<u8>, done: impl Fn() -> bool) {
		let deadline = Instant::now() + Duration::from_secs(30);
		let mut sink = vec![0u8; 1 << 20];
		while !done() {
			assert!(Instant::now() < deadline, "not done within 30 s");
			match r.read(&mut sink) {
				Ok(n) => seen.extend(sink[..n].iter().copied().filter(|&b| b != 0)),
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					std::thread::sleep(Duration::from_millis(1));
				},
				Err(e) => panic!("read: {e}"),
			}
		}
	}

	/// Everything left once every writer is gone.
	fn read_rest(r: &mut fs::File, seen: &mut Vec<u8>) {
		let mut sink = vec![0u8; 1 << 20];
		loop {
			match r.read(&mut sink) {
				Ok(0) => return,
				Ok(n) => seen.extend(sink[..n].iter().copied().filter(|&b| b != 0)),
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					std::thread::sleep(Duration::from_millis(1));
				},
				Err(e) => panic!("read: {e}"),
			}
		}
	}

	// Failure mode: a write that does not fit is lost, made twice, or its task
	// is never woken; or the task is woken while the write still waits.
	#[test]
	fn a_write_that_does_not_fit_is_made_once_it_fits() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let line = [7u8; 300];
		assert!(room.poll_write(&cx, &line, |b| (&w).write(b)).is_pending());
		std::thread::sleep(Duration::from_millis(100));
		assert_eq!(count.wakes(), 0, "woken while the pipe is still full");
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		assert!(matches!(room.poll_write(&cx, &line, |b| (&w).write(b)), Poll::Ready(Ok(300))));
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, line, "made once, whole");
	}

	// Failure mode: a second write is made before the one in hand (the end's
	// writes reordered), or its task is not woken when the first is done.
	#[test]
	fn a_write_waits_for_the_one_in_hand() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let (a, b) = ([1u8; 200], [2u8; 200]);
		assert!(room.poll_write(&cx, &a, |x| (&w).write(x)).is_pending());
		assert!(room.poll_write(&cx, &b, |x| (&w).write(x)).is_pending(), "b waits for a");
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		assert!(matches!(room.poll_write(&cx, &a, |x| (&w).write(x)), Poll::Ready(Ok(200))));
		assert!(matches!(room.poll_write(&cx, &b, |x| (&w).write(x)), Poll::Ready(Ok(200))));
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, [a.as_slice(), b.as_slice()].concat(), "a, then b");
	}

	// Failure mode: a task that polls again with a buffer of the same bytes at
	// another address (a retry that copied its bytes) makes the write twice.
	#[test]
	fn a_buffer_with_the_same_bytes_takes_the_write_made() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let first = vec![9u8; 100];
		assert!(room.poll_write(&cx, &first, |x| (&w).write(x)).is_pending());
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		let copy = first.clone();
		drop(first);
		assert!(matches!(room.poll_write(&cx, &copy, |x| (&w).write(x)), Poll::Ready(Ok(100))));
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, copy, "made once");
	}

	// Failure mode: a result no task took (its vproc was killed while it
	// waited) is taken by a later write of other bytes at the same address (a
	// buffer the allocator handed out again), whose bytes are then never
	// made.
	#[test]
	fn other_bytes_at_the_address_of_a_result_not_taken_are_made() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let mut buf = [4u8; 100];
		assert!(room.poll_write(&cx, &buf, |x| (&w).write(x)).is_pending());
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		buf.fill(6);
		assert!(matches!(room.poll_write(&cx, &buf, |x| (&w).write(x)), Poll::Ready(Ok(100))));
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, [[4u8; 100], [6u8; 100]].concat(), "the 4s made by the thread, then the 6s");
	}

	// Failure mode: with no reader left the write waits for good, or the
	// `SIGPIPE` it raises is left pending or delivered (it would end the
	// shell).
	#[test]
	fn a_write_with_no_reader_left_fails_as_a_broken_pipe() {
		let (w, r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let line = [3u8; 100];
		assert!(room.poll_write(&cx, &line, |x| (&w).write(x)).is_pending());
		drop(r);
		let deadline = Instant::now() + Duration::from_secs(30);
		while count.wakes() == 0 {
			assert!(Instant::now() < deadline, "not woken within 30 s of the reader going");
			std::thread::sleep(Duration::from_millis(1));
		}
		let Poll::Ready(Err(e)) = room.poll_write(&cx, &line, |x| (&w).write(x)) else {
			panic!("a write with no reader fails");
		};
		assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
	}

	// Failure mode: the thread outlives its room (one thread leaked per pipe
	// end that ever waited), or is made before any write waits.
	#[test]
	fn the_thread_ends_with_its_room() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		assert!(!room.thread_runs(), "no thread before a write waits");
		assert!(
			room
				.poll_write(&cx, &[5u8; 10], |x| (&w).write(x))
				.is_pending()
		);
		assert!(room.thread_runs());
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		let inner = Arc::clone(&room.0);
		drop(room);
		let deadline = Instant::now() + Duration::from_secs(30);
		while Arc::strong_count(&inner) > 1 || inner.state.lock().thread {
			assert!(Instant::now() < deadline, "the thread still runs 30 s after its room went");
			std::thread::sleep(Duration::from_millis(1));
		}
	}

	// Failure mode: a write that waits on a full pipe nobody reads, whose task
	// is gone (its vproc killed: the room dropped, the end closed), keeps the
	// thread blocked in the kernel after the pipe's last reader went.
	#[test]
	fn a_write_nobody_reads_ends_its_thread_once_the_last_reader_goes() {
		let (w, r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		assert!(
			room
				.poll_write(&cx, &[8u8; 100], |x| (&w).write(x))
				.is_pending()
		);
		let inner = Arc::clone(&room.0);
		drop(room);
		drop(w);
		std::thread::sleep(Duration::from_millis(200));
		assert!(
			inner.state.lock().thread,
			"the write waits in the kernel while the reader holds the pipe"
		);
		drop(r);
		let deadline = Instant::now() + Duration::from_secs(30);
		while Arc::strong_count(&inner) > 1 || inner.state.lock().thread {
			assert!(
				Instant::now() < deadline,
				"the thread still runs 30 s after the last reader went"
			);
			std::thread::sleep(Duration::from_millis(1));
		}
	}
}
