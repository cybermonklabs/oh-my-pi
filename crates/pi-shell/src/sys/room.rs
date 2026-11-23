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
//! key and bytes, it gets the result. Where no thread can be made
//! (`pthread_create` fails at the process's thread limit), [`Room::poll_write`]
//! says so, and the caller waits for the end to poll writable as it did before.
//!
//! **Whose result.** A result goes to the poll with its writer's key
//! ([`WaitKey`]) and its bytes. The key tells writers apart: every vproc
//! writes with a key of its own (`Vproc::write_key`), and a trap with one of
//! its own while it runs, as a zsh multios tee and a provider file tell their
//! writers apart. The engine polls every vproc with its one waker, so the
//! waker cannot, and the bytes alone cannot either: two vprocs writing the
//! same bytes at once (two background `echo x` into one pipe) would take each
//! other's result, one finishing before its own write is made and the
//! other's write made twice. The bytes tell one key's writes apart, so the
//! room holds the rule by itself: a second write under a key whose first
//! write is in hand or not yet taken (writers that share the end's own key, a
//! trap's write under its vproc's key) never takes the first's result; it
//! waits, then makes its own write. Two writes of the same bytes under one key
//! cannot be told from a write polled again, and one takes the other's
//! result, as by the bytes alone. A result is kept until a poll with its key
//! and bytes takes it, however many writes are made after it, so a live
//! task's write is never made twice; once its key is dropped (its vproc
//! killed) nobody can take it, and it goes at the next write the thread
//! makes. A result keeps its bytes (at most [`MOST`]) until it is taken.
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

use crate::sys::{WaitKey, Wakers};

/// Most bytes of one write the thread is handed; it makes a larger write in
/// part, as a write to a pipe may be made.
const MOST: usize = 1 << 16;

/// The thread of a pipe write end, and the write it has in hand: see the
/// module docs.
pub struct Room(Arc<Inner>);

struct Inner {
	/// A blocking description of the write end, the thread's own.
	file:  fs::File,
	state: Mutex<State>,
	/// The thread waits here for a write to make, or for the room to go.
	work:  Condvar,
	/// The tasks waiting for the write in hand to be made, one wait per
	/// task's key.
	tasks: Arc<Wakers>,
	/// The thread's id, for the tests that read its CPU time.
	#[cfg(test)]
	tid:   std::sync::atomic::AtomicI32,
}

#[derive(Default)]
struct State {
	/// A write is in hand.
	busy:   bool,
	/// The bytes of the write in hand.
	data:   Vec<u8>,
	/// The id of the key of the write in hand ([`WaitKey::id_in`]).
	key:    Option<u64>,
	/// Results of writes made, each until a poll with its key takes it or the
	/// key is dropped.
	done:   VecDeque<Done>,
	/// The thread runs.
	thread: bool,
	/// The room was dropped: the thread ends once it has no write in hand.
	closed: bool,
	/// Tests: the thread sleeps, waiting for a write to make.
	#[cfg(test)]
	asleep: bool,
}

/// A write made, whose task has not polled again.
struct Done {
	/// The id of the writer's key in the room's set ([`WaitKey::id_in`]).
	key:    u64,
	/// The bytes the writer handed over: with the key, whose result it is.
	data:   Vec<u8>,
	result: io::Result<usize>,
}

#[cfg(test)]
thread_local! {
	/// Tests: rooms polled on this thread fail to make their thread, as
	/// `pthread_create` does at the thread limit.
	static NO_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Tests: make every room polled on this thread fail to make its thread
/// (`on`), or stop.
#[cfg(test)]
pub fn no_thread_on_this_thread(on: bool) {
	NO_THREAD.with(|c| c.set(on));
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
			tasks: Arc::default(),
			#[cfg(test)]
			tid: std::sync::atomic::AtomicI32::new(0),
		})))
	}

	/// Write `buf`. While the thread has no write in hand, `now` tries it
	/// (a non-blocking write of the end); one that would wait is handed to
	/// the thread and the task waits by `key`, its own (module docs). The task
	/// polls again with the same key and bytes to learn the result. A write
	/// the thread has in hand keeps
	/// every other one waiting until it is made, so the end's writes keep their
	/// order. `None` where the write would wait and no thread can be made:
	/// the caller waits for the end to poll writable instead.
	pub fn poll_write(
		&self,
		cx: &Context<'_>,
		buf: &[u8],
		key: &mut WaitKey,
		mut now: impl FnMut(&[u8]) -> io::Result<usize>,
	) -> Option<Poll<io::Result<usize>>> {
		let take = &buf[..buf.len().min(MOST)];
		let mut st = self.0.state.lock();
		if let Some(id) = key.id_in(&self.0.tasks)
			&& let Some(i) = st
				.done
				.iter()
				.position(|d| d.key == id && d.data.as_slice() == take)
		{
			let done = st.done.remove(i).expect("found");
			return Some(Poll::Ready(done.result));
		}
		if st.busy {
			// This write or another one is in hand: wait for it.
			self.0.tasks.wait(key, cx.waker());
			return Some(Poll::Pending);
		}
		loop {
			match now(buf) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
				r => return Some(Poll::Ready(r)),
			}
		}
		if !st.thread {
			if spawn(Arc::clone(&self.0)).is_err() {
				// At the thread limit: the caller waits as it did before the
				// room, and the next write that waits tries again.
				return None;
			}
			st.thread = true;
		}
		// The task waits before the thread can finish, which takes the tasks
		// only once it holds the state again; the wait gives the key its id.
		self.0.tasks.wait(key, cx.waker());
		st.data.clear();
		st.data.extend_from_slice(take);
		st.key = key.id_in(&self.0.tasks);
		st.busy = true;
		self.0.work.notify_one();
		Some(Poll::Pending)
	}

	/// Whether the thread runs (tests).
	#[cfg(test)]
	fn thread_runs(&self) -> bool {
		self.0.state.lock().thread
	}

	/// How many results wait for their task (tests).
	#[cfg(test)]
	fn results(&self) -> usize {
		self.0.state.lock().done.len()
	}

	/// Tests: no write is in hand and the thread, if made, sleeps waiting for
	/// one, so nothing the room does wakes a task until another write waits.
	#[cfg(test)]
	fn idle(&self) -> bool {
		let st = self.0.state.lock();
		!st.busy && (!st.thread || st.asleep)
	}
}

/// Make the room's thread. Fails as `pthread_create` does at the thread limit
/// (`EAGAIN`), and in tests where [`no_thread_on_this_thread`] says so.
fn spawn(inner: Arc<Inner>) -> io::Result<()> {
	#[cfg(test)]
	{
		if NO_THREAD.with(std::cell::Cell::get) {
			return Err(io::ErrorKind::WouldBlock.into());
		}
	}
	std::thread::Builder::new()
		.name("obash-room".into())
		.stack_size(128 << 10)
		.spawn(move || run(&inner))
		.map(drop)
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
	#[cfg(test)]
	{
		// SAFETY: gettid takes nothing and only returns this thread's id.
		let tid = unsafe { libc::gettid() };
		inner.tid.store(tid, std::sync::atomic::Ordering::SeqCst);
	}
	let mut st = inner.state.lock();
	loop {
		while !st.busy && !st.closed {
			#[cfg(test)]
			{
				st.asleep = true;
			}
			inner.work.wait(&mut st);
			#[cfg(test)]
			{
				st.asleep = false;
			}
		}
		if !st.busy {
			break;
		}
		let data = std::mem::take(&mut st.data);
		let result = MutexGuard::unlocked(&mut st, || write_whole(&inner.file, &data));
		// Kept until a poll with its key takes it; the results of keys gone
		// (their vprocs killed) go now (module docs).
		let key = st.key.take().expect("a write in hand has its key");
		st.done.retain(|d| inner.tasks.holds(d.key));
		st.done.push_back(Done { key, data, result });
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

	// Failure mode (review of #111 at 483c9ea5; this room's share of it): a
	// second write under one key (a trap's write while its vproc's write
	// waits, or two writers that share the end's own key) takes the first's
	// result: it counts as written with none of its bytes made, and the
	// first, polled again, is made a second time.
	#[test]
	fn a_second_write_under_one_key_makes_its_own_bytes() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let mut key = WaitKey::default();
		let (first, second) = ([7u8; 100], [9u8; 3]);
		let write = |bytes: &[u8], key: &mut WaitKey| {
			room
				.poll_write(&cx, bytes, key, |x| (&w).write(x))
				.expect("a thread")
		};
		assert!(write(&first, &mut key).is_pending(), "the first write waits");
		assert!(write(&second, &mut key).is_pending(), "the second waits for the write in hand");
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		// The first write is made, and the pipe is full again before either
		// write is polled: no write can be made at once.
		fill(&w);
		let before = count.wakes();
		assert!(
			write(&second, &mut key).is_pending(),
			"none of the second's bytes are made yet: it waits"
		);
		read_until(&mut r, &mut seen, || count.wakes() > before);
		assert!(
			matches!(write(&second, &mut key), Poll::Ready(Ok(3))),
			"the second gets its own result"
		);
		assert!(matches!(write(&first, &mut key), Poll::Ready(Ok(100))), "the first gets its result");
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		let mut counts = [0usize; 256];
		for &b in &seen {
			counts[usize::from(b)] += 1;
		}
		assert_eq!((counts[7], counts[9]), (100, 3), "each write's bytes once");
	}

	// Failure mode: two tasks write the same bytes to one end at once (two
	// background `echo x` into one pipe). One task takes the result of the
	// other's write, which the room made for the other; the other, polling
	// again, finds no result and makes its bytes once more, waiting for a
	// write that was already made.
	#[test]
	fn two_tasks_writing_the_same_bytes_each_get_their_own_result() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let (mut a, mut b) = (WaitKey::default(), WaitKey::default());
		let x = [7u8; 100];
		let write = |key: &mut WaitKey| {
			room
				.poll_write(&cx, &x, key, |y| (&w).write(y))
				.expect("a thread")
		};
		assert!(write(&mut a).is_pending(), "A's write waits");
		assert!(write(&mut b).is_pending(), "B waits for the write in hand");
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		// A's write is made. The pipe is full again before either task polls,
		// so no write can be made at once.
		fill(&w);
		let before = count.wakes();
		assert!(write(&mut b).is_pending(), "B's own write is not made yet: it waits");
		assert!(matches!(write(&mut a), Poll::Ready(Ok(100))), "A gets the result of its write");
		read_until(&mut r, &mut seen, || count.wakes() > before);
		assert!(matches!(write(&mut b), Poll::Ready(Ok(100))), "B gets the result of its write");
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, [7u8; 200], "each write once");
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
		let mut key = WaitKey::default();
		let line = [7u8; 300];
		assert!(
			room
				.poll_write(&cx, &line, &mut key, |b| (&w).write(b))
				.expect("a thread")
				.is_pending()
		);
		std::thread::sleep(Duration::from_millis(100));
		assert_eq!(count.wakes(), 0, "woken while the pipe is still full");
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		assert!(matches!(
			room
				.poll_write(&cx, &line, &mut key, |b| (&w).write(b))
				.expect("a thread"),
			Poll::Ready(Ok(300))
		));
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
		let mut key = WaitKey::default();
		let mut other = WaitKey::default();
		let (a, b) = ([1u8; 200], [2u8; 200]);
		assert!(
			room
				.poll_write(&cx, &a, &mut key, |x| (&w).write(x))
				.expect("a thread")
				.is_pending()
		);
		assert!(
			room
				.poll_write(&cx, &b, &mut other, |x| (&w).write(x))
				.expect("a thread")
				.is_pending(),
			"b waits for a"
		);
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		assert!(matches!(
			room
				.poll_write(&cx, &a, &mut key, |x| (&w).write(x))
				.expect("a thread"),
			Poll::Ready(Ok(200))
		));
		assert!(matches!(
			room
				.poll_write(&cx, &b, &mut other, |x| (&w).write(x))
				.expect("a thread"),
			Poll::Ready(Ok(200))
		));
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
		let mut key = WaitKey::default();
		let first = vec![9u8; 100];
		assert!(
			room
				.poll_write(&cx, &first, &mut key, |x| (&w).write(x))
				.expect("a thread")
				.is_pending()
		);
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		let copy = first.clone();
		drop(first);
		assert!(matches!(
			room
				.poll_write(&cx, &copy, &mut key, |x| (&w).write(x))
				.expect("a thread"),
			Poll::Ready(Ok(100))
		));
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, copy, "made once");
	}

	// Failure mode: a result no task took (its vproc was killed while it
	// waited, its key dropped) is taken by a later write of another task,
	// whose bytes are then never made; or it is kept for good.
	#[test]
	fn a_result_whose_key_is_gone_goes_to_nobody() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let mut killed = WaitKey::default();
		assert!(
			room
				.poll_write(&cx, &[4u8; 100], &mut killed, |x| (&w).write(x))
				.expect("a thread")
				.is_pending()
		);
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		drop(killed);
		assert_eq!(room.results(), 1, "the made write's result waits");
		// Another task's write, with a key of its own, waits and is made.
		fill(&w);
		let mut other = WaitKey::default();
		let write = |key: &mut WaitKey| {
			room
				.poll_write(&cx, &[6u8; 100], key, |x| (&w).write(x))
				.expect("a thread")
		};
		assert!(write(&mut other).is_pending(), "the other task's write is not made yet");
		read_until(&mut r, &mut seen, || count.wakes() > 1);
		assert_eq!(room.results(), 1, "the result of the gone key went when the next write was made");
		assert!(matches!(write(&mut other), Poll::Ready(Ok(100))));
		assert_eq!(room.results(), 0);
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
		let mut key = WaitKey::default();
		let line = [3u8; 100];
		assert!(
			room
				.poll_write(&cx, &line, &mut key, |x| (&w).write(x))
				.expect("a thread")
				.is_pending()
		);
		drop(r);
		let deadline = Instant::now() + Duration::from_secs(30);
		while count.wakes() == 0 {
			assert!(Instant::now() < deadline, "not woken within 30 s of the reader going");
			std::thread::sleep(Duration::from_millis(1));
		}
		let Poll::Ready(Err(e)) = room
			.poll_write(&cx, &line, &mut key, |x| (&w).write(x))
			.expect("a thread")
		else {
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
		let mut key = WaitKey::default();
		assert!(!room.thread_runs(), "no thread before a write waits");
		assert!(
			room
				.poll_write(&cx, &[5u8; 10], &mut key, |x| (&w).write(x))
				.expect("a thread")
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
		let mut key = WaitKey::default();
		assert!(
			room
				.poll_write(&cx, &[8u8; 100], &mut key, |x| (&w).write(x))
				.expect("a thread")
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

	/// Fill the non-blocking write end `w` until not even one more byte fits.
	fn fill(w: &fs::File) {
		let page = [0u8; 4096];
		while (&*w).write(&page).is_ok() {}
		while (&*w).write(&[0u8]).is_ok() {}
	}

	// Failure mode: a result is dropped while its task is alive and has not
	// polled again yet (the 17th result dropped the oldest), and the task's
	// next poll makes its bytes a second time.
	#[test]
	fn a_result_waits_for_its_task_however_many_writes_are_made_after_it() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let writes: Vec<[u8; 100]> = (1..=40u8).map(|v| [v; 100]).collect();
		let mut keys: Vec<WaitKey> = writes.iter().map(|_| WaitKey::default()).collect();
		let mut seen = Vec::new();
		for (i, bytes) in writes.iter().enumerate() {
			// The pipe full, so this write waits; then it is made.
			fill(&w);
			let before = count.wakes();
			assert!(
				room
					.poll_write(&cx, bytes, &mut keys[i], |x| (&w).write(x))
					.expect("a thread")
					.is_pending(),
				"write {i} waits"
			);
			read_until(&mut r, &mut seen, || count.wakes() > before);
		}
		for (i, bytes) in writes.iter().enumerate() {
			assert!(
				matches!(
					room
						.poll_write(&cx, bytes, &mut keys[i], |x| (&w).write(x))
						.expect("a thread"),
					Poll::Ready(Ok(100))
				),
				"write {i} gets its result"
			);
		}
		drop(room);
		drop(w);
		read_rest(&mut r, &mut seen);
		let mut counts = [0usize; 256];
		for &b in &seen {
			counts[usize::from(b)] += 1;
		}
		for v in 1..=40u8 {
			let n = counts[usize::from(v)];
			assert_eq!(n, 100, "write {v}: {n} bytes in the pipe, 100 expected");
		}
	}

	// Failure mode: where no thread can be made (`pthread_create` at the
	// thread limit) a write that would wait fails, where it waited before the
	// room. It must be left to the caller, made by nobody.
	#[test]
	fn a_write_that_would_wait_with_no_thread_is_left_to_the_caller() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let mut key = WaitKey::default();
		no_thread_on_this_thread(true);
		let got = room.poll_write(&cx, &[6u8; 100], &mut key, |x| (&w).write(x));
		no_thread_on_this_thread(false);
		assert!(got.is_none(), "no thread: the caller waits for the end itself");
		assert!(!room.thread_runs());
		// Nothing was handed over: once the pipe has room, the caller's own
		// write goes through, once.
		let mut sink = vec![0u8; 1 << 20];
		while r.read(&mut sink).is_ok_and(|n| n > 0) {}
		assert!(matches!(
			room
				.poll_write(&cx, &[6u8; 100], &mut key, |x| (&w).write(x))
				.expect("a thread"),
			Poll::Ready(Ok(100))
		));
		drop(room);
		drop(w);
		let mut seen = Vec::new();
		read_rest(&mut r, &mut seen);
		assert_eq!(seen, [6u8; 100], "made once, by the caller");
	}

	// Failure mode: the thread polls for work instead of sleeping between
	// writes, which costs a CPU for as long as its end lives once a write
	// waited.
	#[test]
	fn the_thread_uses_no_cpu_while_it_waits_for_work() {
		let (w, mut r) = full_pipe();
		let room = Room::new(w.as_raw_fd()).unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let cx = Context::from_waker(&waker);
		let mut key = WaitKey::default();
		assert!(
			room
				.poll_write(&cx, &[4u8; 100], &mut key, |x| (&w).write(x))
				.expect("a thread")
				.is_pending()
		);
		let mut seen = Vec::new();
		read_until(&mut r, &mut seen, || count.wakes() > 0);
		assert!(matches!(
			room
				.poll_write(&cx, &[4u8; 100], &mut key, |x| (&w).write(x))
				.expect("a thread"),
			Poll::Ready(Ok(100))
		));
		let tid = room.0.tid.load(Ordering::SeqCst);
		assert!(tid > 0, "the thread said its id");
		// Its user and system time, in clock ticks (fields 14 and 15).
		let ticks = || -> u64 {
			let stat = std::fs::read_to_string(format!("/proc/self/task/{tid}/stat"))
				.expect("the thread runs");
			let rest = stat.rsplit_once(')').expect("a stat line").1;
			let f: Vec<&str> = rest.split_whitespace().collect();
			f[11].parse::<u64>().unwrap() + f[12].parse::<u64>().unwrap()
		};
		let before = ticks();
		std::thread::sleep(Duration::from_secs(1));
		let used = ticks() - before;
		// SAFETY: sysconf only reads.
		let hz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).unwrap();
		assert!(used * 20 <= hz, "the thread used {used} ticks of {hz} in 1 s with no write in hand");
		assert!(room.thread_runs(), "it waits, it does not end, while its room lives");
	}

	/// A waker that notes that it woke and unparks the thread waiting on it.
	struct Unpark {
		woken:  std::sync::atomic::AtomicBool,
		thread: std::thread::Thread,
	}

	impl Wake for Unpark {
		fn wake(self: Arc<Self>) {
			self.woken.store(true, Ordering::SeqCst);
			self.thread.unpark();
		}
	}

	/// One writer of [`no_wake_is_lost_between_three_writers_and_the_thread`],
	/// as the test's monitor sees it.
	#[derive(Default)]
	struct Writer {
		/// [`RUNNING`], [`WAITING`] or [`FINISHED`].
		state: std::sync::atomic::AtomicU8,
		/// Set by the monitor: stop waiting and poll again.
		kick:  std::sync::atomic::AtomicBool,
		/// Polls that returned `Pending`.
		waits: std::sync::atomic::AtomicU64,
		/// The writer's waker, once its thread runs.
		wake:  Mutex<Option<Arc<Unpark>>>,
	}

	const RUNNING: u8 = 0;
	const WAITING: u8 = 1;
	const FINISHED: u8 = 2;

	// Failure mode (review of #115 at 5f3c243a): a poll that finds a write in
	// hand stores its wait after the thread has made that write and taken the
	// waits, so nothing wakes it until another write waits; once every other
	// writer is done or waiting too, nobody ever does. No other test holds the
	// order in which that wait is stored. Three writers with keys of their
	// own make 20,000 writes of 2,000 bytes each through one room, while a
	// reader takes the pipe 512 bytes at a time. A writer that waits unwoken
	// while the room is idle (no write in hand, its thread asleep or not
	// made) waits for a wake the room already gave out, or never will: every
	// wait is stored while a write is in hand, and the thread wakes them all
	// before it sleeps. The monitor counts each such wait, seen twice 50 ms
	// apart, and kicks its writer on so the test ends; the test fails if it
	// saw one. Each writer's records must also arrive once each and in order.
	#[test]
	fn no_wake_is_lost_between_three_writers_and_the_thread() {
		use std::sync::atomic::AtomicBool;
		const WRITERS: usize = 3;
		const WRITES: usize = 20_000;
		const LEN: usize = 2000;
		let (r, w) = io::pipe().unwrap();
		let (mut r, w) = (fs::File::from(OwnedFd::from(r)), fs::File::from(OwnedFd::from(w)));
		nonblocking(&w);
		let room = Room::new(w.as_raw_fd()).unwrap();
		// Checks each record as it arrives (writer, its sequence number, whole):
		// how many records each writer's came to, or the first wrong one.
		let reader = std::thread::spawn(move || -> Result<[usize; WRITERS], String> {
			let mut next = [0usize; WRITERS];
			let mut rec = Vec::with_capacity(LEN);
			let mut buf = [0u8; 512];
			loop {
				let n = match r.read(&mut buf) {
					Ok(0) => {
						return if rec.is_empty() {
							Ok(next)
						} else {
							Err("a part record at the end".into())
						};
					},
					Ok(n) => n,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
					Err(e) => panic!("read: {e}"),
				};
				for &byte in &buf[..n] {
					rec.push(byte);
					if rec.len() < LEN {
						continue;
					}
					let i = usize::try_from(u32::from_le_bytes(rec[..4].try_into().unwrap())).unwrap();
					let seq =
						usize::try_from(u32::from_le_bytes(rec[4..8].try_into().unwrap())).unwrap();
					if i >= WRITERS {
						return Err(format!("a record split or mixed with another: {:?}", &rec[..8]));
					}
					if seq != next[i] {
						return Err(format!("writer {i}: record {seq} where {} was next", next[i]));
					}
					if !rec[8..]
						.iter()
						.all(|&b| b == b'a' + u8::try_from(i).unwrap())
					{
						return Err(format!("writer {i}: record {seq} not whole"));
					}
					next[i] += 1;
					rec.clear();
				}
			}
		});
		let writers: [Writer; WRITERS] = Default::default();
		let mut lost = 0usize;
		std::thread::scope(|s| {
			for (i, me) in writers.iter().enumerate() {
				let (room, w) = (&room, &w);
				s.spawn(move || {
					let wake = Arc::new(Unpark {
						woken:  AtomicBool::new(false),
						thread: std::thread::current(),
					});
					*me.wake.lock() = Some(Arc::clone(&wake));
					let waker = Waker::from(Arc::clone(&wake));
					let cx = Context::from_waker(&waker);
					let mut key = WaitKey::default();
					let mut record = [0u8; LEN];
					record[..4].copy_from_slice(&u32::try_from(i).unwrap().to_le_bytes());
					record[8..].fill(b'a' + u8::try_from(i).unwrap());
					for seq in 0..WRITES {
						record[4..8].copy_from_slice(&u32::try_from(seq).unwrap().to_le_bytes());
						loop {
							wake.woken.store(false, Ordering::SeqCst);
							match room
								.poll_write(&cx, &record, &mut key, |b| (&*w).write(b))
								.expect("a thread")
							{
								Poll::Ready(Ok(n)) => {
									assert_eq!(n, LEN, "a pipe write of at most PIPE_BUF is made whole");
									break;
								},
								Poll::Ready(Err(e)) => panic!("writer {i}: {e}"),
								Poll::Pending => {
									me.waits.fetch_add(1, Ordering::SeqCst);
									me.state.store(WAITING, Ordering::SeqCst);
									while !wake.woken.load(Ordering::SeqCst)
										&& !me.kick.swap(false, Ordering::SeqCst)
									{
										std::thread::park();
									}
									me.state.store(RUNNING, Ordering::SeqCst);
								},
							}
						}
					}
					me.state.store(FINISHED, Ordering::SeqCst);
				});
			}
			// While the room is idle, each writer that waits unwoken: its count
			// of waits; `None` for any other writer, or for all of them while
			// the room is not idle.
			let unwoken = || -> [Option<u64>; WRITERS] {
				let mut waits = [None; WRITERS];
				for (i, me) in writers.iter().enumerate() {
					let waiting = me.state.load(Ordering::SeqCst) == WAITING
						&& me
							.wake
							.lock()
							.as_ref()
							.is_some_and(|u| !u.woken.load(Ordering::SeqCst));
					if waiting {
						waits[i] = Some(me.waits.load(Ordering::SeqCst));
					}
				}
				if room.idle() { waits } else { [None; WRITERS] }
			};
			let deadline = Instant::now() + Duration::from_secs(120);
			while writers
				.iter()
				.any(|me| me.state.load(Ordering::SeqCst) != FINISHED)
			{
				assert!(Instant::now() < deadline, "the writers did not finish within 120 s");
				std::thread::sleep(Duration::from_millis(20));
				let first = unwoken();
				if first.iter().all(Option::is_none) {
					continue;
				}
				std::thread::sleep(Duration::from_millis(50));
				let second = unwoken();
				for (i, me) in writers.iter().enumerate() {
					// The same wait, unwoken across 50 ms with the room idle at
					// both looks: its wake was lost.
					if first[i].is_some() && first[i] == second[i] {
						lost += 1;
						me.kick.store(true, Ordering::SeqCst);
						if let Some(u) = me.wake.lock().as_ref() {
							u.thread.unpark();
						}
					}
				}
			}
		});
		drop(room);
		drop(w);
		let checked = reader.join().unwrap();
		assert_eq!(
			lost, 0,
			"a poll that found a write in hand was never woken: a writer waited unwoken with the \
			 room idle, {lost} times"
		);
		assert_eq!(checked, Ok([WRITES; WRITERS]), "every writer's records, once each and in order");
	}
}
