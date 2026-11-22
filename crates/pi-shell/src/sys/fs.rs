//! `Fs` and `File` over `std::fs`.
//!
//! Every operation is a local syscall and returns `Ready`, except opening a
//! FIFO for reading or for writing only: that waits for the other end, so it
//! returns `Pending` and a helper thread performs the open (dropping the
//! pending open releases the helper).
//!
//! Reads and writes on pipes, FIFOs, sockets and terminals never wait in the
//! kernel on a scheduler thread on Unix: the other end may be a vproc of the
//! same engine (a FIFO, a `/dev/fd/N` of a process substitution), and a
//! terminal read must not stop the scheduler (`read -t` timers, other
//! vprocs). [`StdFile`] checks readiness first and returns `Pending` with
//! the waker registered on the shared readiness thread (`ready`); the
//! descriptor's flags stay untouched, since externals inherit them. A write
//! goes through a private non-blocking description of the pipe (Linux,
//! reopened through `/proc/self/fd`), or else to a writer thread of the
//! descriptor's own ([`BlockingWriter`]). On Windows every write that is not
//! to a regular file goes to such a writer thread too; Windows reads of pipes
//! and consoles still block (anonymous pipes cannot be polled).
//!
//! Windows specifics: `test -x` holds for directories, files with a
//! `PATHEXT` extension and files starting with `#!`; process substitution
//! uses a named pipe `\\.\pipe\obash-<pid>-<n>` (a regular temp file when
//! the engine asks for [`TempPurpose::HereDoc`], e.g. for a consumer that
//! must seek).

#[cfg(target_os = "linux")]
use std::time::Duration;
use std::{
	cell::RefCell,
	fs::{self, OpenOptions},
	io::{self, IsTerminal, Read, Seek, Write},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	task::{Context, Poll, Waker},
	time::UNIX_EPOCH,
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	DirEntry, DirIter, File, FileKind, Fs, FsPoll, Mark, OpenFlags, OsHandle, Stat, StdFd,
	fs::{Access, StatKind, TempNode, TempPurpose},
};

/// `Fs` over the host filesystem.
#[derive(Clone, Copy, Debug, Default)]
pub struct StdFs {
	/// The process's file-creation mask, when nothing changes it while this
	/// filesystem is in use (obash reads it once at startup; an embedding
	/// process may change its mask at any time and leaves this `None`). A
	/// create whose mode the mask leaves intact then takes a single `open`
	/// instead of an exclusive-create probe first ([`create_with_mode`]).
	pub umask: Option<u32>,
}

/// A host file, pipe or terminal as an engine [`File`].
#[derive(Debug)]
pub struct StdFile {
	/// Pending readiness waits (pipes, sockets, terminals), one for reading
	/// and one for writing: a terminal the line editor reads keys from is
	/// written to meanwhile (job notices, the display), which must not
	/// drop the read wait. Declared first so they are dropped, and
	/// forgotten by the waiting thread, before `file` closes.
	#[cfg(unix)]
	watch:          [Option<crate::sys::ready::Watch>; 2],
	/// Writes for a descriptor with no private non-blocking description,
	/// started on the first such write.
	writer:         Option<BlockingWriter>,
	/// Linux only: a fresh non-blocking open file description of a pipe's
	/// write end. Externals keep the blocking description they inherited.
	#[cfg(target_os = "linux")]
	private_writer: Option<fs::File>,
	/// Test only: runs after the readiness check and before the write.
	#[cfg(all(test, unix))]
	before_write:   Option<TestHook>,
	file:           fs::File,
	kind:           FileKind,
	/// Access mode of the open file description (`O_ACCMODE` bits of
	/// `F_GETFL`; `None` when unknown).
	#[cfg(unix)]
	access:         Option<libc::c_int>,
	/// The null device: a write is complete without a syscall.
	null:           bool,
	/// Read-ahead of a regular file this engine opened for reading only
	/// ([`StdFile::opened`]); `None` for every other file and once the
	/// descriptor was handed out ([`File::os_handle`], [`File::dup`]).
	ahead:          RefCell<Option<Ahead>>,
}

/// Bytes of a regular file read from the kernel beyond what the engine
/// consumed. `read` takes a chunk and gives back what follows its line
/// (`SeekFrom::Current(-n)`): with these at hand that is a move of `pos`, not
/// an `lseek`, and the next line needs no `read`. Only the kernel offset is
/// ahead of the engine's, and nothing else sees it until the descriptor is
/// handed out, which first [syncs](Ahead::sync) it.
#[derive(Debug, Default)]
struct Ahead {
	/// Allocated on the first read.
	buf:    Box<[u8]>,
	filled: usize,
	/// Next byte the engine reads.
	pos:    usize,
	/// The kernel offset: the file offset of `buf[filled]`.
	end:    u64,
}

/// Bytes an [`Ahead`] reads per `read`.
const AHEAD: usize = 32 << 10;

impl Ahead {
	fn read(&mut self, file: &mut fs::File, out: &mut [u8]) -> io::Result<usize> {
		if out.is_empty() {
			return Ok(0);
		}
		if self.pos == self.filled {
			if self.buf.is_empty() {
				self.buf = vec![0; AHEAD].into_boxed_slice();
			}
			let n = loop {
				match file.read(&mut self.buf) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					got => break got?,
				}
			};
			self.filled = n;
			self.pos = 0;
			self.end += n as u64;
		}
		let n = out.len().min(self.filled - self.pos);
		out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
		self.pos += n;
		Ok(n)
	}

	/// Move the kernel offset back to the engine's and drop the bytes ahead.
	fn sync(&mut self, mut file: &fs::File) -> io::Result<()> {
		let ahead = self.filled - self.pos;
		if ahead > 0 {
			self.end = file.seek(io::SeekFrom::Current(-(ahead as i64)))?;
		}
		self.filled = 0;
		self.pos = 0;
		Ok(())
	}

	fn seek(&mut self, file: &mut fs::File, pos: io::SeekFrom) -> io::Result<u64> {
		if let io::SeekFrom::Current(back @ ..=0) = pos
			&& let Some(pos) = self.pos.checked_sub(back.unsigned_abs() as usize)
		{
			self.pos = pos;
			return Ok(self.end - (self.filled - self.pos) as u64);
		}
		self.sync(file)?;
		self.end = file.seek(pos)?;
		Ok(self.end)
	}
}

/// How long a write waits before it tries again when the pipe polls
/// writable but took nothing: a readiness watch would fire at once.
#[cfg(target_os = "linux")]
const WRITE_RETRY: Duration = Duration::from_millis(5);

/// The most one hand-off to a [`BlockingWriter`] copies; a status record
/// ([`StdFile::poll_write_atomic`]) is kept within it, so it is one chunk.
pub(crate) const BLOCKING_WRITE_CHUNK: usize = 64 << 10;

/// The write for a descriptor whose writes may wait in the kernel and that
/// has no private non-blocking description: every Darwin pipe, FIFO and
/// terminal; every Windows write that is not to a regular file; on Linux a
/// terminal, a socket, or a pipe whose reopen failed. One thread of its own
/// writes each chunk whole, in order, so the wait is never on a scheduler
/// thread.
///
/// A write is taken, and `Ready` with its length, when its chunk is handed
/// to the idle thread; while the thread still writes an earlier chunk, a
/// write is `Pending` and hands nothing off. Nothing is matched to a write
/// afterwards: a write whose future is dropped while `Pending` handed
/// nothing off, and one that returned `Ready` is the thread's to finish.
/// A settle ([`File::poll_settle`]) waits until the thread is idle: every
/// engine writer settles before it counts its bytes as out, so whatever
/// runs next (an external that inherits the descriptor, another writer on
/// the same pipe) comes after them.
///
/// Each chunk handed off gets a [`Mark`], which keeps the chunk's result.
/// A writer that hands chunks off ([`File::poll_write_marked`]) holds their
/// marks and takes its chunks' errors by settling with them
/// ([`File::poll_settle_marked`]); an engine writer settles a chunk before
/// it hands off the next one to the same object, so it stops at its first
/// failed chunk, as a writer stops at its first failed `write(2)`, and never
/// has more than one mark in flight. A chunk's error reaches no other writer,
/// settle or flush: a plain write ([`File::poll_write`]) drops its mark and
/// with it the chunk's error, and every engine writer whose bytes can reach
/// this thread writes with marks. Every later write is made, as every later
/// `write(2)` is (a FIFO whose reader came back takes it).
#[derive(Debug)]
struct BlockingWriter {
	jobs:  std::sync::mpsc::Sender<(Mark, Vec<u8>)>,
	state: Arc<parking_lot::Mutex<WriterState>>,
}

#[derive(Debug, Default)]
struct WriterState {
	/// The thread is writing a chunk.
	busy:   bool,
	/// Writers and settles to wake when the thread is idle again.
	wakers: Vec<Waker>,
}

impl BlockingWriter {
	fn start(file: &fs::File) -> io::Result<Self> {
		let mut file = file.try_clone()?;
		let (jobs, queue) = std::sync::mpsc::channel::<(Mark, Vec<u8>)>();
		let state = Arc::new(parking_lot::Mutex::new(WriterState::default()));
		let shared = Arc::clone(&state);
		std::thread::Builder::new()
			.name("obash-write".into())
			.stack_size(64 << 10)
			.spawn(move || {
				// Ends once the `StdFile` is dropped and the last chunk is done.
				while let Ok((mark, bytes)) = queue.recv() {
					#[cfg(all(test, target_os = "linux"))]
					wait_while_held();
					let result = write_all_waiting(&mut file, &bytes);
					#[cfg(all(test, target_os = "linux"))]
					if result.is_err() {
						CHUNKS_FAILED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
					}
					let wakers = {
						let mut s = shared.lock();
						// Under the lock a settle checks the mark under, so no
						// settle misses the wake.
						mark.finish(result);
						s.busy = false;
						std::mem::take(&mut s.wakers)
					};
					for waker in wakers {
						waker.wake();
					}
				}
			})?;
		Ok(Self { jobs, state })
	}

	/// Hands off a chunk of `buf`: `Ready` with its length and its mark.
	fn poll_write(&self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<(usize, Mark)>> {
		let mut s = self.state.lock();
		if s.busy {
			register(&mut s.wakers, cx);
			return Poll::Pending;
		}
		let chunk = &buf[..buf.len().min(BLOCKING_WRITE_CHUNK)];
		let mark = Mark::new();
		if self.jobs.send((mark.clone(), chunk.to_vec())).is_err() {
			return Poll::Ready(Err(io::Error::other("the writer thread stopped")));
		}
		s.busy = true;
		Poll::Ready(Ok((chunk.len(), mark)))
	}

	/// `Ready` once every chunk handed off is in the kernel or failed. Takes
	/// no error.
	fn poll_settle(&self, cx: &Context<'_>) -> Poll<()> {
		let mut s = self.state.lock();
		if s.busy {
			register(&mut s.wakers, cx);
			return Poll::Pending;
		}
		Poll::Ready(())
	}

	/// `Ready` once the chunks of `marks` are done, with the first of their
	/// errors; it takes all of them.
	fn poll_settle_marked(&self, cx: &Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>> {
		{
			let mut s = self.state.lock();
			if marks.iter().any(|mark| !mark.is_done()) {
				register(&mut s.wakers, cx);
				return Poll::Pending;
			}
		}
		let mut first = Ok(());
		for mark in marks {
			let result = mark.take_error();
			if first.is_ok() {
				first = result;
			}
		}
		Poll::Ready(first)
	}

	/// Test only: whether no chunk is being written.
	#[cfg(all(test, target_os = "linux"))]
	fn idle(&self) -> bool {
		!self.state.lock().busy
	}
}

fn register(wakers: &mut Vec<Waker>, cx: &Context<'_>) {
	if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
		wakers.push(cx.waker().clone());
	}
}

/// Writes all of `bytes` with blocking writes, on a writer thread. A
/// descriptor someone else set non-blocking (a socket given as a run's
/// stdio) refuses a write with `WouldBlock` when full; that waits until it
/// is writable and writes again, rather than ending the chunk.
fn write_all_waiting(file: &mut fs::File, mut bytes: &[u8]) -> io::Result<()> {
	while !bytes.is_empty() {
		match file.write(bytes) {
			Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
			Ok(n) => bytes = &bytes[n..],
			Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
				#[cfg(all(test, target_os = "linux"))]
				WOULD_BLOCK_SEEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
				wait_writable(file)?;
			},
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

/// Test only: how many times a writer thread met `WouldBlock`, so a test
/// can drain only after the retry branch has run.
#[cfg(all(test, target_os = "linux"))]
pub(crate) static WOULD_BLOCK_SEEN: std::sync::atomic::AtomicUsize =
	std::sync::atomic::AtomicUsize::new(0);

/// Test only: how many chunks writer threads failed to write, so a test
/// can tell how many chunks a writer handed off after its first failed one.
#[cfg(all(test, target_os = "linux"))]
pub(crate) static CHUNKS_FAILED: std::sync::atomic::AtomicUsize =
	std::sync::atomic::AtomicUsize::new(0);

/// Waits, on the writer thread, until a non-blocking descriptor may take a
/// write.
#[cfg(unix)]
fn wait_writable(file: &fs::File) -> io::Result<()> {
	use std::os::fd::AsRawFd;

	let mut pfd = libc::pollfd { fd: file.as_raw_fd(), events: libc::POLLOUT, revents: 0 };
	loop {
		// SAFETY: `pfd` is one valid `pollfd` for a live descriptor; no timeout.
		match unsafe { libc::poll(&raw mut pfd, 1, -1) } {
			-1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => {},
			-1 => return Err(io::Error::last_os_error()),
			// Writable, or an error the next write reports.
			_ => return Ok(()),
		}
	}
}

/// Waits, on the writer thread, before a non-blocking pipe (`PIPE_NOWAIT`)
/// is written again: Windows offers no readiness wait for it.
#[cfg(not(unix))]
fn wait_writable(_file: &fs::File) -> io::Result<()> {
	std::thread::sleep(std::time::Duration::from_millis(1));
	Ok(())
}

/// A test's callback in the write path.
#[cfg(all(test, unix))]
pub(crate) struct TestHook(pub(crate) Box<dyn FnMut() + Send>);

#[cfg(all(test, unix))]
impl std::fmt::Debug for TestHook {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str("TestHook")
	}
}

/// Set in a test's child process: every `StdFile` there takes the
/// [`BlockingWriter`] route, the only one Darwin has, on Linux too.
#[cfg(all(test, target_os = "linux"))]
const FORCE_BLOCKING_WRITER_ENV: &str = "PI_SHELL_TEST_FORCE_BLOCKING_WRITER";

#[cfg(all(test, target_os = "linux"))]
static FORCE_BLOCKING_WRITER: std::sync::LazyLock<bool> =
	std::sync::LazyLock::new(|| std::env::var_os(FORCE_BLOCKING_WRITER_ENV).is_some());

/// Runs `body` in a child process of this test binary where every
/// `StdFile` takes the [`BlockingWriter`] route. `test` is the test's full
/// path (`module_path!()` and its name): the child runs exactly that test,
/// which then runs `body`. A process of its own keeps the route from
/// reaching the tests that run beside it in one process.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn in_blocking_writer_process(test: &str, body: impl FnOnce()) {
	if *FORCE_BLOCKING_WRITER {
		body();
		return;
	}
	let name = test.split_once("::").map_or(test, |(_, rest)| rest);
	let out = std::process::Command::new(std::env::current_exe().expect("the test binary"))
		.args([name, "--exact", "--nocapture", "--test-threads=1"])
		.env(FORCE_BLOCKING_WRITER_ENV, "1")
		.output()
		.expect("run the test in a child process");
	let stdout = String::from_utf8_lossy(&out.stdout);
	assert!(
		out.status.success() && stdout.contains("1 passed"),
		"the child run of {name} failed ({}):\n{stdout}\n{}",
		out.status,
		String::from_utf8_lossy(&out.stderr)
	);
}

/// Test only: while held ([`hold_writers`]), a writer thread has taken its
/// chunk (it is busy) but does not write it, so a test finds the thread
/// busy for as long as it likes, without racing it.
#[cfg(all(test, target_os = "linux"))]
static HELD: (std::sync::Mutex<bool>, std::sync::Condvar) =
	(std::sync::Mutex::new(false), std::sync::Condvar::new());

/// Test only: every writer thread of this process holds the chunk it takes
/// until the guard is dropped. Process-wide: a test that holds runs in a
/// process of its own ([`in_blocking_writer_process`]).
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn hold_writers() -> WritersHeld {
	*HELD.0.lock().unwrap() = true;
	WritersHeld(())
}

/// The hold of [`hold_writers`]; dropping it lets the writer threads go on.
#[cfg(all(test, target_os = "linux"))]
pub(crate) struct WritersHeld(());

#[cfg(all(test, target_os = "linux"))]
impl Drop for WritersHeld {
	fn drop(&mut self) {
		*HELD.0.lock().unwrap() = false;
		HELD.1.notify_all();
	}
}

#[cfg(all(test, target_os = "linux"))]
fn wait_while_held() {
	let mut held = HELD.0.lock().unwrap();
	while *held {
		held = HELD.1.wait(held).unwrap();
	}
}

/// Test only: socket and descriptor probes for the engine's tests, whose
/// module forbids `unsafe`.
#[cfg(all(test, target_os = "linux"))]
pub(crate) mod test_probe {
	use std::os::fd::{AsRawFd, RawFd};

	/// `SIOCATMARK` (Linux `asm-generic/sockios.h`).
	const SIOCATMARK: libc::c_ulong = 0x8905;

	/// Whether this system carries TCP urgent data (`MSG_OOB`) end to end: a
	/// control on a connection of its own, whose other end must see it
	/// (`POLLPRI`) within a second. gVisor sends it but never signals it.
	pub(crate) fn urgent_data_is_carried() -> bool {
		let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
		let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
		let (server, _) = listener.accept().unwrap();
		// SAFETY: a valid one-byte buffer.
		let sent =
			unsafe { libc::send(client.as_raw_fd(), b"!".as_ptr().cast(), 1, libc::MSG_OOB) == 1 };
		sent && urgent_arrives(&server, 1_000)
	}

	/// Whether urgent data arrives at `fd` within `ms` milliseconds
	/// (`POLLPRI`).
	pub(crate) fn urgent_arrives(fd: &impl AsRawFd, ms: i32) -> bool {
		let mut p = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLPRI, revents: 0 };
		// SAFETY: one `pollfd`, valid for the call.
		let n = unsafe { libc::poll(&raw mut p, 1, ms) };
		n == 1 && p.revents & libc::POLLPRI != 0
	}

	/// Whether `fd`'s read position is at the urgent mark (`SIOCATMARK`).
	pub(crate) fn at_mark(fd: &impl AsRawFd) -> bool {
		let mut at: libc::c_int = 0;
		// SAFETY: `SIOCATMARK` writes one `c_int`.
		let r = unsafe { libc::ioctl(fd.as_raw_fd(), SIOCATMARK, &raw mut at) };
		assert_eq!(r, 0, "SIOCATMARK: {}", std::io::Error::last_os_error());
		at != 0
	}

	/// The bytes queued to read at `fd` (`FIONREAD`).
	pub(crate) fn queued(fd: RawFd) -> usize {
		let mut n: libc::c_int = 0;
		// SAFETY: `FIONREAD` writes one `c_int`.
		let r = unsafe { libc::ioctl(fd, libc::FIONREAD, &raw mut n) };
		assert_eq!(r, 0, "FIONREAD: {}", std::io::Error::last_os_error());
		usize::try_from(n).unwrap()
	}

	/// Make `fd` non-blocking.
	pub(crate) fn set_nonblocking(fd: &impl AsRawFd) {
		// SAFETY: `F_SETFL` on a valid descriptor.
		let r = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
		assert_eq!(r, 0, "F_SETFL: {}", std::io::Error::last_os_error());
	}
}

/// Reopen a Linux pipe through procfs, producing a distinct non-blocking open
/// file description. `dup` would share the flags with an external child.
#[cfg(target_os = "linux")]
fn private_nonblocking_writer(file: &fs::File) -> io::Result<fs::File> {
	use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};

	OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY)
		.open(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

/// One write, again on `EINTR`.
#[cfg(target_os = "linux")]
fn write_once(mut file: &fs::File, buf: &[u8]) -> io::Result<usize> {
	loop {
		match file.write(buf) {
			Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
			result => return result,
		}
	}
}

impl StdFile {
	/// Wrap an open file, classifying it.
	pub fn new(file: fs::File) -> Self {
		let (kind, null) = classify(&file);
		Self::with_kind(file, kind, null)
	}

	/// Wrap a file this engine opened with `flags`. A regular file opened
	/// for reading only gets a read-ahead: its open file description is the
	/// engine's own until handed out.
	fn opened(file: fs::File, flags: OpenFlags) -> Self {
		let new = Self::new(file);
		if new.kind == FileKind::Regular && !flags.contains(OpenFlags::WRITE) {
			new.ahead.replace(Some(Ahead::default()));
		}
		new
	}

	/// Sync and drop the read-ahead: the descriptor is about to be shared.
	fn hand_out(&self) {
		if let Some(mut ahead) = self.ahead.take() {
			// A regular file seeks back within what it read; were that to
			// fail, the receiver could only see a later offset.
			let _ = ahead.sync(&self.file);
		}
	}

	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "reads the access mode with fcntl on Unix")
	)]
	fn with_kind(file: fs::File, kind: FileKind, null: bool) -> Self {
		// Only a descriptor that waits for readiness consults its access
		// mode ([`Self::gated`]); a regular file or device skips the `fcntl`.
		#[cfg(unix)]
		let access = waits(kind)
			.then(|| {
				use std::os::fd::AsRawFd;
				// SAFETY: F_GETFL only reads the flags of our open descriptor.
				let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
				(flags >= 0).then_some(flags & libc::O_ACCMODE)
			})
			.flatten();
		#[cfg(all(target_os = "linux", test))]
		let force_blocking_writer = *FORCE_BLOCKING_WRITER;
		#[cfg(all(target_os = "linux", not(test)))]
		let force_blocking_writer = false;
		#[cfg(target_os = "linux")]
		let private_writer = (!force_blocking_writer
			&& kind == FileKind::Pipe
			&& access.is_none_or(|access| access == libc::O_WRONLY || access == libc::O_RDWR))
		.then(|| private_nonblocking_writer(&file).ok())
		.flatten();
		Self {
			file,
			kind,
			#[cfg(unix)]
			watch: [None, None],
			writer: None,
			#[cfg(target_os = "linux")]
			private_writer,
			#[cfg(all(test, unix))]
			before_write: None,
			#[cfg(unix)]
			access,
			null,
			ahead: RefCell::new(None),
		}
	}

	/// Test only: run `hook` in every write, after the readiness check and
	/// before the `write(2)`.
	#[cfg(all(test, target_os = "linux"))]
	pub(crate) fn set_before_write(&mut self, hook: impl FnMut() + Send + 'static) {
		self.before_write = Some(TestHook(Box::new(hook)));
	}

	/// Whether writes go through a private non-blocking description.
	#[cfg(all(test, target_os = "linux"))]
	pub(crate) const fn has_private_writer(&self) -> bool {
		self.private_writer.is_some()
	}

	/// Whether I/O in this direction must wait for readiness instead of
	/// blocking. A direction the descriptor was not opened for is never
	/// gated: the syscall fails at once with `EBADF`, while readiness would
	/// never come (`poll` on a pipe's read end never reports `POLLOUT`).
	#[cfg(unix)]
	fn gated(&self, write: bool) -> bool {
		let wanted = if write {
			libc::O_WRONLY
		} else {
			libc::O_RDONLY
		};
		let allowed = self
			.access
			.is_none_or(|acc| acc == libc::O_RDWR || acc == wanted);
		allowed && waits(self.kind)
	}

	/// `Ready` when `events` are ready now; else registers `cx`'s waker.
	#[cfg(unix)]
	fn ready(&mut self, cx: &Context<'_>, events: i16) -> Poll<io::Result<()>> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		let fd = self.file.as_raw_fd();
		let slot = usize::from(events != ready::READ);
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				return Poll::Ready(Ok(()));
			},
			Ok(false) => {},
			Err(e) => return Poll::Ready(Err(e)),
		}
		// Replace any earlier watch of this direction, so only the latest
		// waker is kept.
		self.watch[slot] = None;
		match ready::watch(fd, events, cx.waker()) {
			Ok(w) => self.watch[slot] = Some(w),
			Err(e) => return Poll::Ready(Err(e)),
		}
		// It may have become ready before the watch was registered; the
		// poller would see that too, this only saves a round trip.
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				Poll::Ready(Ok(()))
			},
			Ok(false) => Poll::Pending,
			Err(e) => Poll::Ready(Err(e)),
		}
	}

	/// Waits after a write that took nothing. A competing writer that took
	/// the room leaves the pipe unwritable: wait for readiness. A pipe that
	/// still polls writable (gVisor, with less free than the write needs)
	/// would wake a watch at once, so try again after [`WRITE_RETRY`].
	/// `Ok` means `Pending`, with a wake registered.
	#[cfg(target_os = "linux")]
	fn wait_for_room(&mut self, cx: &Context<'_>) -> io::Result<()> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		if ready::now(self.file.as_raw_fd(), ready::WRITE)? {
			return ready::wake_after(cx.waker(), WRITE_RETRY);
		}
		match self.ready(cx, ready::WRITE) {
			// It drained since the check: try again at once.
			Poll::Ready(Ok(())) => {
				cx.waker().wake_by_ref();
				Ok(())
			},
			Poll::Ready(Err(e)) => Err(e),
			Poll::Pending => Ok(()),
		}
	}

	/// A write on the private non-blocking description: as much of `buf` as
	/// the pipe takes, or `Pending` with nothing written. gVisor fails a
	/// write larger than the free space with `EAGAIN` while the pipe polls
	/// writable, so a write that took nothing is tried once more with what
	/// [`write_room`](crate::sys::ready::write_room) measures.
	#[cfg(target_os = "linux")]
	fn poll_private_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		if let Err(e) = std::task::ready!(self.ready(cx, ready::WRITE)) {
			return Poll::Ready(Err(e));
		}
		#[cfg(test)]
		if let Some(hook) = self.before_write.as_mut() {
			(hook.0)();
		}
		let Some(writer) = self.private_writer.as_ref() else {
			return Poll::Ready(Err(io::Error::other("no private writer")));
		};
		match write_once(writer, buf) {
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
			done => return Poll::Ready(done),
		}
		let room = ready::write_room(self.file.as_raw_fd());
		if room > 0 && room < buf.len() {
			match write_once(writer, &buf[..room]) {
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
				done => return Poll::Ready(done),
			}
		}
		match self.wait_for_room(cx) {
			Ok(()) => Poll::Pending,
			Err(e) => Poll::Ready(Err(e)),
		}
	}

	/// A write handed to this descriptor's [`BlockingWriter`], started on
	/// the first one: its length and its chunk's mark.
	fn poll_blocking_write(
		&mut self,
		cx: &Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Mark)>> {
		if self.writer.is_none() {
			match BlockingWriter::start(&self.file) {
				Ok(writer) => self.writer = Some(writer),
				Err(e) => return Poll::Ready(Err(e)),
			}
		}
		#[cfg(all(test, unix))]
		if let Some(hook) = self.before_write.as_mut() {
			(hook.0)();
		}
		match &self.writer {
			Some(writer) => writer.poll_write(cx, buf),
			None => Poll::Ready(Err(io::Error::other("no writer thread"))),
		}
	}

	/// Test only: whether this file's writer thread, if it has one, writes
	/// no chunk.
	#[cfg(all(test, target_os = "linux"))]
	pub(crate) fn writer_idle(&self) -> bool {
		self.writer.as_ref().is_none_or(BlockingWriter::idle)
	}

	/// Writes `buf` as one atomic pipe record, or waits without writing
	/// anything. The caller keeps `buf` at most `PIPE_BUF`
	/// ([`WRITE_CHUNK`](crate::sys::ready::WRITE_CHUNK)), which a pipe takes
	/// whole or not at all; this is for status lines, which must not be left
	/// as fragments.
	#[cfg(unix)]
	pub(crate) fn poll_write_atomic(
		&mut self,
		cx: &Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<Option<Mark>>> {
		if buf.len() > crate::sys::ready::WRITE_CHUNK {
			return Poll::Ready(Err(io::ErrorKind::InvalidInput.into()));
		}
		if !self.gated(true) || buf.is_empty() {
			return Poll::Ready(self.file.write_all(buf).map(|()| None));
		}
		#[cfg(target_os = "linux")]
		if self.private_writer.is_some() {
			use std::os::fd::AsRawFd;

			use crate::sys::ready;
			if let Err(e) = std::task::ready!(self.ready(cx, ready::WRITE)) {
				return Poll::Ready(Err(e));
			}
			if ready::write_room(self.file.as_raw_fd()) >= buf.len()
				&& let Some(writer) = self.private_writer.as_ref()
			{
				match write_once(writer, buf) {
					Ok(n) if n == buf.len() => return Poll::Ready(Ok(None)),
					Ok(_) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
					Err(e) => return Poll::Ready(Err(e)),
				}
			}
			return match self.wait_for_room(cx) {
				Ok(()) => Poll::Pending,
				Err(e) => Poll::Ready(Err(e)),
			};
		}
		match self.poll_blocking_write(cx, buf) {
			Poll::Ready(Ok((n, mark))) if n == buf.len() => Poll::Ready(Ok(Some(mark))),
			Poll::Ready(Ok(_)) => Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
			Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
			Poll::Pending => Poll::Pending,
		}
	}

	/// Writes `buf`, a status line, whole: through the writer thread for
	/// anything but a regular file, so a full pipe never holds a scheduler
	/// thread. The caller keeps `buf` within one hand-off
	/// ([`BLOCKING_WRITE_CHUNK`]), so the record is one chunk.
	#[cfg(not(unix))]
	pub(crate) fn poll_write_atomic(
		&mut self,
		cx: &Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<Option<Mark>>> {
		if buf.len() > BLOCKING_WRITE_CHUNK {
			return Poll::Ready(Err(io::ErrorKind::InvalidInput.into()));
		}
		if self.kind == FileKind::Regular || buf.is_empty() {
			return Poll::Ready(self.file.write_all(buf).map(|()| None));
		}
		match self.poll_blocking_write(cx, buf) {
			Poll::Ready(Ok((n, mark))) if n == buf.len() => Poll::Ready(Ok(Some(mark))),
			Poll::Ready(Ok(_)) => Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
			Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
			Poll::Pending => Poll::Pending,
		}
	}
}

/// Whether I/O on a descriptor of `kind` waits for readiness instead of
/// blocking ([`StdFile::gated`]).
#[cfg(unix)]
const fn waits(kind: FileKind) -> bool {
	matches!(kind, FileKind::Pipe | FileKind::Socket | FileKind::Tty)
}

/// The file's kind, and whether it is the null device. Only a character
/// device (or a handle `fstat` cannot read) can be a terminal, so a regular
/// file, pipe or socket costs one `fstat` and no terminal probe.
#[cfg(unix)]
fn classify(file: &fs::File) -> (FileKind, bool) {
	use std::{
		os::unix::fs::{FileTypeExt, MetadataExt},
		sync::LazyLock,
	};
	let Ok(meta) = file.metadata() else {
		return if file.is_terminal() {
			(FileKind::Tty, false)
		} else {
			(FileKind::Device, false)
		};
	};
	let ft = meta.file_type();
	if ft.is_file() {
		return (FileKind::Regular, false);
	}
	if ft.is_fifo() {
		return (FileKind::Pipe, false);
	}
	if ft.is_socket() {
		return (FileKind::Socket, false);
	}
	if ft.is_char_device() && file.is_terminal() {
		return (FileKind::Tty, false);
	}
	/// `/dev/null`'s device number.
	static NULL: LazyLock<Option<u64>> =
		LazyLock::new(|| fs::metadata("/dev/null").ok().map(|m| m.rdev()));
	if ft.is_char_device() && Some(meta.rdev()) == *NULL {
		return (FileKind::Device, true);
	}
	(FileKind::Device, false)
}

/// The file's kind (the null device is not told apart). The handle's type
/// decides, not its metadata: `GetFileInformationByHandle` can succeed on
/// a pipe and report a plain file, which made the line reader read ahead
/// on a pipe and lose what it could not seek back over.
#[cfg(windows)]
fn classify(file: &fs::File) -> (FileKind, bool) {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_TYPE_CHAR, FILE_TYPE_DISK, FILE_TYPE_PIPE, GetFileType,
	};
	// SAFETY: `GetFileType` only inspects the handle `file` owns.
	let kind = match unsafe { GetFileType(file.as_raw_handle()) } {
		FILE_TYPE_DISK => FileKind::Regular,
		FILE_TYPE_PIPE => FileKind::Pipe,
		// A console; `NUL` and serial ports are character devices too.
		FILE_TYPE_CHAR if file.is_terminal() => FileKind::Tty,
		_ => FileKind::Device,
	};
	(kind, false)
}

/// How long a console read that ended with nothing read waits for the
/// console's control handler (it runs on a thread of its own) to report a
/// Ctrl-C before the read counts as end of input.
#[cfg(windows)]
const CTRL_C_GRACE: std::time::Duration = std::time::Duration::from_millis(100);

/// A read of a console in line mode. Ctrl-C ends it with nothing read,
/// which is no end of input: as a terminal read interrupted by `SIGINT`
/// (`EINTR`), the shell takes the signal (its trap runs, or it ends) and
/// reads on. The console reports it as `ERROR_OPERATION_ABORTED`, a
/// pseudoconsole not at all, so a Ctrl-C the shell's handler claimed
/// ([`console::ctrl_c_since`](crate::sys::console::ctrl_c_since)) counts
/// too. `ReadFile` itself: the standard library reads through
/// `NtReadFile`, which sets no last error.
#[cfg(windows)]
fn console_read(
	file: &fs::File,
	cx: &std::task::Context<'_>,
	buf: &mut [u8],
) -> Poll<io::Result<usize>> {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::{
		Foundation::{ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED, GetLastError, SetLastError},
		Storage::FileSystem::ReadFile,
	};

	use crate::sys::console;
	let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
	let mut got = 0u32;
	let before = console::ctrl_c_count();
	// SAFETY: `buf` holds at least `len` bytes; a synchronous read of the
	// handle `file` owns; the last-error value is the calling thread's.
	let (ok, err) = unsafe {
		SetLastError(0);
		let ok =
			ReadFile(file.as_raw_handle(), buf.as_mut_ptr(), len, &raw mut got, std::ptr::null_mut());
		(ok != 0, GetLastError())
	};
	if got != 0 {
		return Poll::Ready(Ok(got as usize));
	}
	let claimed = console::ctrl_c_since(before, CTRL_C_GRACE);
	if !claimed && err != ERROR_OPERATION_ABORTED {
		return Poll::Ready(if ok || err == ERROR_BROKEN_PIPE {
			Ok(0)
		} else {
			Err(io::Error::from_raw_os_error(err as i32))
		});
	}
	// The handler has posted the signal: the shell takes it before it
	// polls this read again.
	cx.waker().wake_by_ref();
	Poll::Pending
}

/// The process's own standard stream `fd` (a duplicate of it), `None` when
/// it is closed.
pub fn std_stream(fd: StdFd) -> Option<Box<dyn File>> {
	#[cfg(unix)]
	let owned = {
		use std::os::fd::AsFd;
		match fd {
			StdFd::Stdin => io::stdin().as_fd().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_fd().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_fd().try_clone_to_owned(),
		}
	};
	#[cfg(windows)]
	let owned = {
		use std::os::windows::io::AsHandle;
		match fd {
			StdFd::Stdin => io::stdin().as_handle().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_handle().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_handle().try_clone_to_owned(),
		}
	};
	owned
		.ok()
		.map(|h| Box::new(StdFile::new(fs::File::from(h))) as Box<dyn File>)
}

impl File for StdFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if let Some(ahead) = self.ahead.get_mut() {
			return Poll::Ready(ahead.read(&mut self.file, buf));
		}
		#[cfg(unix)]
		if self.gated(false) {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::READ)) {
				return Poll::Ready(Err(e));
			}
			// Readable (or hung up): this read returns without waiting.
			return Poll::Ready(self.file.read(buf));
		}
		#[cfg(windows)]
		if self.kind == FileKind::Tty && !buf.is_empty() {
			return console_read(&self.file, cx, buf);
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.read(buf))
	}

	/// A plain write: a chunk handed to the writer thread is the write's
	/// mark's alone, and this drops it, so the chunk's error is lost. Every
	/// engine writer whose bytes can reach the thread writes with marks.
	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.poll_write_marked(cx, buf).map_ok(|(n, _)| n)
	}

	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		if self.null {
			return Poll::Ready(Ok((buf.len(), None)));
		}
		#[cfg(unix)]
		if self.gated(true) && !buf.is_empty() {
			#[cfg(target_os = "linux")]
			if self.private_writer.is_some() {
				return self.poll_private_write(cx, buf).map_ok(|n| (n, None));
			}
			// No readiness check first: the writer thread waits instead.
			return self
				.poll_blocking_write(cx, buf)
				.map_ok(|(n, mark)| (n, Some(mark)));
		}
		// Windows: anonymous pipes and consoles cannot be polled, so every
		// write that may wait goes to the writer thread.
		#[cfg(not(unix))]
		if self.kind != FileKind::Regular && !buf.is_empty() {
			return self
				.poll_blocking_write(cx, buf)
				.map_ok(|(n, mark)| (n, Some(mark)));
		}
		Poll::Ready(self.file.write(buf).map(|n| (n, None)))
	}

	/// Waits for the writer thread. It takes no chunk's error: each is the
	/// error of the writer that holds the chunk's mark.
	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		if let Some(writer) = &self.writer {
			std::task::ready!(writer.poll_settle(cx));
		}
		Poll::Ready(self.file.flush())
	}

	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match &self.writer {
			Some(writer) => writer.poll_settle(cx).map(Ok),
			None => Poll::Ready(Ok(())),
		}
	}

	fn poll_settle_marked(&mut self, cx: &mut Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>> {
		match &self.writer {
			Some(writer) => writer.poll_settle_marked(cx, marks),
			None => Poll::Ready(Ok(())),
		}
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		match self.ahead.get_mut() {
			Some(ahead) => ahead.seek(&mut self.file, pos),
			None => self.file.seek(pos),
		}
	}

	fn kind(&self) -> FileKind {
		self.kind
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.hand_out();
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			u64::try_from(self.file.as_raw_fd()).ok().map(OsHandle)
		}
		#[cfg(windows)]
		{
			use std::os::windows::io::AsRawHandle;
			Some(OsHandle(self.file.as_raw_handle().addr() as u64))
		}
	}

	fn stat(&self) -> io::Result<Stat> {
		self.file.metadata().map(|m| stat_of(&m))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.hand_out();
		Ok(Box::new(Self::with_kind(self.file.try_clone()?, self.kind, self.null)))
	}
}

/// Engine path → host path (UTF-8 required on Windows). A URL path
/// ([`crate::bash::fs::url_root_len`]) names no host file: `NotFound`, rather
/// than a lookup relative to the process's working directory. On Windows,
/// `/dev/null` is the null device `NUL` (else `\dev\null` on the current
/// drive, which does not exist).
pub fn host_path(p: &[u8]) -> io::Result<&Path> {
	if crate::bash::fs::url_root_len(p).is_some() {
		return Err(io::Error::from(io::ErrorKind::NotFound));
	}
	if cfg!(windows) && p == b"/dev/null" {
		return Ok(Path::new("NUL"));
	}
	p.to_path()
		.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// Host path → engine bytes.
fn engine_path(p: &Path) -> BString {
	BString::from(p.as_os_str().as_encoded_bytes())
}

fn kind_of(ft: fs::FileType) -> StatKind {
	if ft.is_dir() {
		return StatKind::Dir;
	}
	if ft.is_symlink() {
		return StatKind::Symlink;
	}
	if ft.is_file() {
		return StatKind::File;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		if ft.is_fifo() {
			return StatKind::Fifo;
		}
		if ft.is_socket() {
			return StatKind::Socket;
		}
		if ft.is_block_device() {
			return StatKind::BlockDev;
		}
	}
	StatKind::CharDev
}

fn stat_of(meta: &fs::Metadata) -> Stat {
	let kind = kind_of(meta.file_type());
	let since_epoch = |t: io::Result<std::time::SystemTime>| {
		t.ok()
			.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
			.map_or(0, |d| d.as_nanos() as i64)
	};
	let mtime_ns = since_epoch(meta.modified());
	let atime_ns = since_epoch(meta.accessed());
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		Stat {
			kind,
			mode: meta.mode() & 0o7777,
			size: meta.size(),
			uid: meta.uid(),
			gid: meta.gid(),
			dev: meta.dev(),
			ino: meta.ino(),
			nlink: meta.nlink(),
			mtime_ns,
			atime_ns,
			ctime_ns: meta
				.ctime()
				.saturating_mul(1_000_000_000)
				.saturating_add(meta.ctime_nsec()),
			blocks: meta.blocks(),
			rdev: meta.rdev(),
			blksize: meta.blksize(),
		}
	}
	#[cfg(windows)]
	{
		let mode = match (kind, meta.permissions().readonly()) {
			(StatKind::Dir, _) => 0o755,
			(_, true) => 0o444,
			(_, false) => 0o644,
		};
		let (uid, gid) = crate::sys::user::owner();
		Stat {
			kind,
			mode,
			size: meta.len(),
			uid,
			gid,
			dev: 0,
			ino: 0,
			nlink: 1,
			mtime_ns,
			atime_ns,
			// Windows has no status-change time: the creation time stands in.
			ctime_ns: since_epoch(meta.created()),
			blocks: meta.len().div_ceil(512),
			rdev: 0,
			blksize: 4096,
		}
	}
}

fn open(path: &BStr, flags: OpenFlags, mode: u32, umask: Option<u32>) -> io::Result<Box<dyn File>> {
	#[cfg(windows)]
	if let Some(server) = pipe::take(path, flags) {
		return server;
	}
	let path = host_path(path)?;
	Ok(Box::new(StdFile::opened(create_with_mode(path, flags, mode, umask, false)?, flags)))
}

/// [`open`] for writing only, without waiting for a FIFO's reader: the
/// caller has sent a FIFO to the helper thread already, and one made since
/// (no reader yet) fails at once with `ENXIO` for the caller to send there
/// too. The descriptor is left blocking, as a plain open leaves it, since
/// externals inherit its flags.
#[cfg(unix)]
fn open_for_writing(
	path: &BStr,
	flags: OpenFlags,
	mode: u32,
	umask: Option<u32>,
) -> io::Result<Box<dyn File>> {
	use std::os::fd::AsRawFd;
	let file = create_with_mode(host_path(path)?, flags, mode, umask, true)?;
	let mut status = if flags.contains(OpenFlags::APPEND) {
		libc::O_APPEND
	} else {
		0
	};
	if flags.contains(OpenFlags::NONBLOCK) {
		status |= libc::O_NONBLOCK;
	}
	// SAFETY: F_SETFL sets the status flags of our own open descriptor.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, status) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(Box::new(StdFile::opened(file, flags)))
}

/// Opens `path`, giving a file the open creates exactly `mode`.
///
/// The engine passes `0o666 & !umask` with the shell's own umask, but the
/// kernel still applies the process umask (`process_umask`) on creation, so
/// a looser shell mask (`umask 000`) would lose the bits the process mask
/// clears. When the process mask is known and clears none of `mode`, a plain
/// open already creates exactly `mode`. Otherwise only an exclusive create
/// proves the file is new (an existing file keeps its mode), so a plain
/// `O_CREAT` open tries one first and falls back on `EEXIST`.
fn create_with_mode(
	path: &std::path::Path,
	flags: OpenFlags,
	mode: u32,
	process_umask: Option<u32>,
	nonblock: bool,
) -> io::Result<fs::File> {
	let options = || {
		#[cfg_attr(not(unix), expect(unused_mut, reason = "custom flags are Unix's"))]
		let mut o = options(flags, mode);
		#[cfg(unix)]
		if nonblock {
			use std::os::unix::fs::OpenOptionsExt;
			// `custom_flags` replaces the earlier ones.
			o.custom_flags(libc::O_NONBLOCK | custom_flags(flags));
		}
		#[cfg(not(unix))]
		let _ = nonblock;
		o
	};
	#[cfg(not(unix))]
	let _ = process_umask;
	#[cfg(unix)]
	if flags.contains(OpenFlags::CREATE) && process_umask.is_none_or(|mask| mode & mask != 0) {
		use std::os::unix::fs::PermissionsExt as _;
		let mut exclusive = options();
		exclusive.create_new(true);
		match exclusive.open(path) {
			Ok(file) => {
				// Best effort: without it the file keeps the stricter mode
				// the process umask left.
				let _ = file.set_permissions(fs::Permissions::from_mode(mode & 0o7777));
				return Ok(file);
			},
			Err(err)
				if err.kind() == io::ErrorKind::AlreadyExists && !flags.contains(OpenFlags::EXCL) => {},
			Err(err) => return Err(err),
		}
	}
	options().open(path)
}

fn options(flags: OpenFlags, mode: u32) -> OpenOptions {
	let mut o = OpenOptions::new();
	// `OpenOptions` refuses append with truncate, which `open(2)` takes
	// (zsh `sysopen -a -o trunc`): on Unix the append flag then goes in as
	// a custom flag ([`custom_flags`]).
	let append_trunc =
		cfg!(unix) && flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC);
	o.read(flags.contains(OpenFlags::READ))
		.write(flags.contains(OpenFlags::WRITE) || append_trunc)
		.append(flags.contains(OpenFlags::APPEND) && !append_trunc)
		.truncate(flags.contains(OpenFlags::TRUNC))
		.create(flags.contains(OpenFlags::CREATE));
	if flags.contains(OpenFlags::EXCL) {
		o.create_new(true);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		o.mode(mode);
		let custom = custom_flags(flags);
		if custom != 0 {
			o.custom_flags(custom);
		}
	}
	#[cfg(windows)]
	let _ = mode;
	o
}

/// The `open(2)` flags of `flags` that [`OpenOptions`] has no setter for.
#[cfg(unix)]
const fn custom_flags(flags: OpenFlags) -> libc::c_int {
	let mut custom = 0;
	if flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC) {
		custom |= libc::O_APPEND;
	}
	if flags.contains(OpenFlags::NOFOLLOW) {
		custom |= libc::O_NOFOLLOW;
	}
	if flags.contains(OpenFlags::SYNC) {
		custom |= libc::O_SYNC;
	}
	#[cfg(any(target_os = "linux", target_os = "android"))]
	if flags.contains(OpenFlags::NOATIME) {
		custom |= libc::O_NOATIME;
	}
	if flags.contains(OpenFlags::NONBLOCK) {
		custom |= libc::O_NONBLOCK;
	}
	custom
}

/// Opening a FIFO in one direction blocks until the other end opens; it runs
/// on a helper thread ([`pi_vfs::FifoOpen`], which also says what a dropped
/// open leaves) and completes as a pending fs op.
#[cfg(unix)]
mod fifo {
	use std::{
		fs, io,
		os::unix::fs::{FileTypeExt, OpenOptionsExt},
		task::{Context, Poll},
	};
	#[cfg(test)]
	use std::{fs::OpenOptions, path::Path};

	use bstr::BStr;
	use pi_vfs::FifoOpen;

	use super::{StdFile, custom_flags, host_path, options};
	use crate::bash::{File, FsPending, OpenFlags};

	/// A FIFO open in flight.
	struct Pending(FifoOpen<fs::File>);

	/// `Some` when `path` is a FIFO opened for reading only or writing only
	/// (`O_RDWR` never blocks on a FIFO).
	pub fn pending(
		path: &BStr,
		flags: OpenFlags,
		mode: u32,
	) -> Option<Box<dyn FsPending<Box<dyn File>>>> {
		let write = flags.contains(OpenFlags::WRITE);
		if flags.contains(OpenFlags::READ) == write {
			return None;
		}
		let host = host_path(path).ok()?;
		let meta = fs::metadata(host).ok()?;
		if !meta.file_type().is_fifo() {
			return None;
		}
		let mut opts = options(flags, mode);
		let nofollow = flags.contains(OpenFlags::NOFOLLOW);
		let open = FifoOpen::start(host, &meta, nofollow, move |path, pinned| {
			// A pin is checked not to be a symbolic link already, and its
			// `/proc/self/fd/N` always is one.
			if pinned {
				opts.custom_flags(custom_flags(flags) & !libc::O_NOFOLLOW);
			}
			opts.open(path)
		});
		Some(Box::new(Pending(open)))
	}

	impl FsPending<Box<dyn File>> for Pending {
		fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Box<dyn File>>> {
			self
				.0
				.poll(cx)
				.map(|r| r.map(|f| Box::new(StdFile::new(f)) as Box<dyn File>))
		}

		/// Cancelling releases the helper by briefly holding both ends of the
		/// FIFO, which the real other end can observe (a writer that comes
		/// and goes reads as end of file).
		fn reissuable(&self) -> bool {
			false
		}
	}

	/// Whether the FIFO at `path` has a reader: a write-only open that does
	/// not wait fails with ENXIO when it has none.
	#[cfg(test)]
	pub(super) fn has_reader(path: &Path) -> bool {
		match OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
		{
			Ok(_) => true,
			Err(e) if e.raw_os_error() == Some(libc::ENXIO) => false,
			Err(e) => panic!("{e}"),
		}
	}

	/// Whether the FIFO at `path` has a writer: a reader that does not wait
	/// reads end of file when it has none, and would block when it has one.
	#[cfg(test)]
	pub(super) fn has_writer(path: &Path) -> bool {
		use std::io::Read;
		let mut reader = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap();
		match reader.read(&mut [0; 1]) {
			Ok(0) => false,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => true,
			other => panic!("{other:?}"),
		}
	}

	#[cfg(test)]
	mod tests {
		use std::{os::unix::ffi::OsStrExt, task::Waker, thread};

		use super::*;

		/// The open's result, polling it as the engine does; while it has
		/// none, `connect` runs.
		fn result(
			open: &mut dyn FsPending<Box<dyn File>>,
			mut connect: impl FnMut(),
		) -> io::Result<Box<dyn File>> {
			loop {
				if let Poll::Ready(r) = open.poll(&mut Context::from_waker(Waker::noop())) {
					return r;
				}
				connect();
				thread::yield_now();
			}
		}

		/// With NOFOLLOW, a FIFO opens (on Linux its pin is checked not to be
		/// a symbolic link, and the pin's `/proc/self/fd/N`, which is one, is
		/// opened without the flag), and a symbolic link to a FIFO is refused
		/// with ELOOP, as `open(2)` refuses it.
		#[test]
		fn nofollow_opens_a_fifo_and_refuses_a_symbolic_link_to_one() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("f");
			let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
			// SAFETY: `c` is a NUL-terminated string that outlives the call.
			assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
			let flags = OpenFlags::READ.with(OpenFlags::NOFOLLOW);
			let start = |p: &Path| pending(BStr::new(p.as_os_str().as_bytes()), flags, 0).unwrap();

			let mut open = start(&path);
			// Be the writer the helper waits for, once it waits.
			let mut writer = None;
			let opened = result(&mut *open, || {
				if writer.is_none() {
					writer = OpenOptions::new()
						.write(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&path)
						.ok();
				}
			});
			assert!(opened.is_ok(), "the FIFO did not open: {:?}", opened.err());

			let link = dir.path().join("l");
			std::os::unix::fs::symlink(&path, &link).unwrap();
			let mut open = start(&link);
			match result(&mut *open, || {}) {
				Err(e) => assert_eq!(e.raw_os_error(), Some(libc::ELOOP), "{e}"),
				Ok(_) => panic!("the symbolic link was followed"),
			}
		}
	}
}

fn access(path: &BStr, mode: Access) -> io::Result<()> {
	#[cfg(unix)]
	{
		let c = std::ffi::CString::new(path.as_bytes())
			.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
		let mut m = libc::F_OK;
		if mode.contains(Access::READ) {
			m |= libc::R_OK;
		}
		if mode.contains(Access::WRITE) {
			m |= libc::W_OK;
		}
		if mode.contains(Access::EXEC) {
			m |= libc::X_OK;
		}
		// SAFETY: `c` is a valid NUL-terminated string for the duration of the
		// call.
		if unsafe { libc::access(c.as_ptr(), m) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
	#[cfg(windows)]
	{
		if path.as_bytes() == b"/dev/null" {
			// The null device takes reads and writes; it runs nothing.
			return if mode.contains(Access::EXEC) {
				Err(io::ErrorKind::PermissionDenied.into())
			} else {
				Ok(())
			};
		}
		let p = host_path(path)?;
		let meta = fs::metadata(p)?;
		if mode.contains(Access::WRITE) && meta.permissions().readonly() {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		if mode.contains(Access::EXEC)
			&& !meta.is_dir()
			&& !crate::sys::pathext::Pathext::from_env().has_executable_extension(p)
			&& !crate::sys::shebang::has_shebang(p)
		{
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		Ok(())
	}
}

/// Directory listing collected up front (a local readdir).
struct StdDir(std::vec::IntoIter<io::Result<DirEntry>>);

impl DirIter for StdDir {
	fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>> {
		Poll::Ready(self.0.next())
	}
}

fn read_dir(path: &BStr) -> io::Result<Box<dyn DirIter>> {
	let entries: Vec<io::Result<DirEntry>> = fs::read_dir(host_path(path)?)?
		.map(|e| {
			e.map(|e| DirEntry {
				name: BString::from(e.file_name().as_encoded_bytes()),
				kind: e.file_type().ok().map(kind_of),
			})
		})
		.collect();
	Ok(Box::new(StdDir(entries.into_iter())))
}

/// Temp names within this process: `obash-<pid>-<seq>`.
static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

/// A new FIFO (process substitution on Unix) or empty file in the temp
/// directory. A name that exists already is skipped: an earlier process
/// with this pid (one killed, or a test that failed, before it removed its
/// nodes) can have left it.
fn temp(purpose: TempPurpose) -> io::Result<TempNode> {
	temp_in(&TEMP_SEQ, purpose)
}

/// [`temp`], with the name's number drawn from `seq_from`.
fn temp_in(seq_from: &AtomicU32, purpose: TempPurpose) -> io::Result<TempNode> {
	loop {
		let seq = seq_from.fetch_add(1, Ordering::Relaxed);
		#[cfg(windows)]
		if let TempPurpose::ProcSub { output } = purpose {
			return pipe::create(output, seq);
		}
		let path = std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
		let fifo = matches!(purpose, TempPurpose::ProcSub { .. }) && cfg!(unix);
		match make_temp(&path, fifo) {
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
			Ok(()) => return Ok(TempNode { path: engine_path(&path), fifo }),
		}
	}
}

/// Creates the FIFO or the empty file at `path`, failing when it exists.
fn make_temp(path: &std::path::Path, fifo: bool) -> io::Result<()> {
	if fifo {
		#[cfg(unix)]
		{
			let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
				.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
			// SAFETY: `c` is a valid NUL-terminated path for the duration of the
			// call.
			if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
				return Err(io::Error::last_os_error());
			}
		}
	} else {
		fs::File::create_new(path)?;
	}
	Ok(())
}

fn chdir_check(path: &BStr) -> io::Result<()> {
	if !fs::metadata(host_path(path)?)?.is_dir() {
		return Err(io::ErrorKind::NotADirectory.into());
	}
	access(path, Access::EXEC)
}

/// Named pipes for process substitution on Windows.
///
/// [`pipe::create`] makes the server end and parks it; the producer side of
/// the substitution takes it with [`Fs::open`] in its direction (write for
/// `<( )`, read for `>( )`), the consumer opens the path as a client. The
/// server end is overlapped ([`OsPipe::server`](crate::sys::pump::os::OsPipe)):
/// it connects on first I/O, which stays `Pending` until the consumer has
/// opened the path, and its reads and writes never wait either. It reports
/// no OS handle, so an external producer is fed through a pump.
#[cfg(windows)]
mod pipe {
	use std::{
		collections::HashMap,
		io,
		os::windows::io::{FromRawHandle, OwnedHandle},
		ptr,
		sync::{Arc, LazyLock},
		task::{Context, Poll},
	};

	use bstr::{BStr, BString};
	use parking_lot::Mutex;
	use windows_sys::Win32::{
		Storage::FileSystem::{
			FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_INBOUND,
			PIPE_ACCESS_OUTBOUND,
		},
		System::Pipes::{
			CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
			PIPE_WAIT,
		},
	};

	use crate::{
		bash::{File, FileKind, OpenFlags, OsHandle, fs::TempNode},
		sys::pump::os::OsPipe,
	};

	/// Server ends not yet taken, by path; `true` when the server writes.
	static PENDING: LazyLock<Mutex<HashMap<BString, (OwnedHandle, bool)>>> =
		LazyLock::new(|| Mutex::new(HashMap::new()));

	const BUF: u32 = 64 << 10;

	/// Create the pipe for a `<( )` (`output == false`: we write, the
	/// consumer reads) or `>( )` substitution.
	pub fn create(output: bool, seq: u32) -> io::Result<TempNode> {
		let name = format!(r"\\.\pipe\obash-{}-{seq}", std::process::id());
		let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
		let access = if output {
			PIPE_ACCESS_INBOUND
		} else {
			PIPE_ACCESS_OUTBOUND
		};
		// SAFETY: `wide` is NUL-terminated; null security attributes.
		let h = unsafe {
			CreateNamedPipeW(
				wide.as_ptr(),
				access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
				PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
				1,
				BUF,
				BUF,
				0,
				ptr::null(),
			)
		};
		if h.is_null() || h as isize == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh handle we own.
		let h = unsafe { OwnedHandle::from_raw_handle(h.cast()) };
		let path = BString::from(name);
		PENDING.lock().insert(path.clone(), (h, !output));
		Ok(TempNode { path, fifo: true })
	}

	/// The parked server end of `path`, when `flags` open it in the server's
	/// direction; `None` leaves the open to the client path.
	pub fn take(path: &BStr, flags: OpenFlags) -> Option<io::Result<Box<dyn File>>> {
		let mut pending = PENDING.lock();
		let &(_, writes) = pending.get(path)?;
		if flags.contains(OpenFlags::WRITE) != writes {
			return None;
		}
		let (h, _) = pending.remove(path)?;
		Some(OsPipe::server(h).map(|pipe| {
			Box::new(Server(Arc::new(Mutex::new(ServerEnd { pipe, connected: false }))))
				as Box<dyn File>
		}))
	}

	/// Server end of a substitution pipe. Duplicates share it, as the
	/// duplicates of one open file do.
	struct Server(Arc<Mutex<ServerEnd>>);

	struct ServerEnd {
		pipe:      OsPipe,
		connected: bool,
	}

	impl ServerEnd {
		/// Ready once the consumer has connected (`Pending` until it opens
		/// the path, like opening a FIFO, without waiting).
		fn poll_connected(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			if !self.connected {
				std::task::ready!(self.pipe.poll_connect(cx))?;
				self.connected = true;
			}
			Poll::Ready(Ok(()))
		}
	}

	impl File for Server {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_read(cx, buf)
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_write(cx, buf)
		}

		fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			let mut end = self.0.lock();
			if !end.connected {
				return Poll::Ready(Ok(()));
			}
			end.pipe.poll_flush(cx)
		}

		fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			self.poll_flush(cx)
		}

		fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::NotSeekable.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			// Externals would write before the consumer connects: pump instead.
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}
}

impl Fs for StdFs {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		// The console, as `/dev/tty` is the controlling terminal on Unix.
		#[cfg(windows)]
		if path.as_bytes() == b"/dev/tty" {
			return FsPoll::Ready(crate::sys::console::open_tty());
		}
		// A FIFO opened one way goes to the helper thread, which may wait for
		// the other end, before the write-only open below tries `O_NONBLOCK`:
		// under gVisor before google/gvisor@d6786915 that open, failing with
		// `ENXIO` for want of a reader, counts as a writer for a moment, and a
		// reader then inside a blocking open of the FIFO returns with no writer
		// and reads end of file, while this writer waits for a reader for ever.
		#[cfg(unix)]
		if let Some(pending) = fifo::pending(path, flags, mode) {
			return FsPoll::Pending(pending);
		}
		#[cfg(unix)]
		if flags.contains(OpenFlags::WRITE) && !flags.contains(OpenFlags::READ) {
			match open_for_writing(path, flags, mode, self.umask) {
				// A FIFO made since the check above, with no reader yet (or no
				// FIFO at all: `pending` tells).
				Err(err) if err.raw_os_error() == Some(libc::ENXIO) => {
					if let Some(pending) = fifo::pending(path, flags, mode) {
						return FsPoll::Pending(pending);
					}
				},
				opened => return FsPoll::Ready(opened),
			}
		}
		FsPoll::Ready(open(path, flags, mode, self.umask))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		// `NUL` has no metadata on Windows (`GetFileAttributesEx` fails):
		// answer as Unix does for `/dev/null`, a world-writable character
		// device.
		#[cfg(windows)]
		if path.as_bytes() == b"/dev/null" {
			return FsPoll::Ready(Ok(Stat {
				kind:     StatKind::CharDev,
				mode:     0o666,
				size:     0,
				uid:      0,
				gid:      0,
				dev:      0,
				ino:      0,
				nlink:    1,
				mtime_ns: 0,
				atime_ns: 0,
				ctime_ns: 0,
				blocks:   0,
				rdev:     0,
				blksize:  4096,
			}));
		}
		FsPoll::Ready(
			host_path(path)
				.and_then(|p| {
					if follow {
						fs::metadata(p)
					} else {
						fs::symlink_metadata(p)
					}
				})
				.map(|m| stat_of(&m)),
		)
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		FsPoll::Ready(access(path, mode))
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		FsPoll::Ready(read_dir(path))
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(
			host_path(path)
				.and_then(fs::read_link)
				.map(|p| engine_path(&p)),
		)
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(host_path(path).and_then(fs::canonicalize).map(|p| {
			// `C:\x`, not `\\?\C:\x`, where both name the file.
			let p = engine_path(&p);
			if cfg!(windows) {
				BString::from(crate::bash::fs::plain_windows_path(&p).into_owned())
			} else {
				p
			}
		}))
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		FsPoll::Ready(temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(chdir_check(path))
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_file))
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::rename(f, host_path(to)?)))
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		#[cfg(unix)]
		let res = host_path(path).and_then(|p| std::os::unix::fs::symlink(host_path(target)?, p));
		#[cfg(not(unix))]
		let res = {
			let _ = (target, path);
			Err(io::ErrorKind::Unsupported.into())
		};
		FsPoll::Ready(res)
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::hard_link(f, host_path(to)?)))
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		FsPoll::Ready(lock_file(path))
	}

	fn lock_fd(&mut self, file: OsHandle, lock: crate::bash::fs::FdLock) -> FsPoll<()> {
		FsPoll::Ready(lock_fd(file, lock))
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::mkdir(p, mode, self.umask)))
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_dir))
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chmod(p, mode)))
	}

	fn chown(
		&mut self,
		path: &BStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chown(p, uid, gid, follow)))
	}

	fn sync(&mut self) -> FsPoll<()> {
		super::fs_ops::sync();
		FsPoll::Ready(Ok(()))
	}

	fn getxattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<BString> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::getxattr(p, name, follow)))
	}

	fn setxattr(&mut self, path: &BStr, name: &BStr, value: &[u8], follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::setxattr(p, name, value, follow)))
	}

	fn removexattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::removexattr(p, name, follow)))
	}

	fn listxattr(&mut self, path: &BStr, follow: bool) -> FsPoll<Vec<BString>> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::listxattr(p, follow)))
	}

	fn user_db(
		&mut self,
		query: &crate::bash::fs::PwQuery,
	) -> FsPoll<Vec<crate::bash::fs::PwEntry>> {
		FsPoll::Ready(super::fs_ops::user_db(query))
	}
}

/// `fcntl(F_SETLK)` of a whole-file lock on descriptor `file`
/// ([`Fs::lock_fd`]): `WouldBlock` on contention.
#[cfg(unix)]
fn lock_fd(file: OsHandle, lock: crate::bash::fs::FdLock) -> io::Result<()> {
	use crate::bash::fs::FdLock;
	let fd = libc::c_int::try_from(file.0).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
	// SAFETY: `flock` is plain data; all-zero is a valid value.
	let mut lck: libc::flock = unsafe { std::mem::zeroed() };
	lck.l_type = (match lock {
		FdLock::Shared => libc::F_RDLCK,
		FdLock::Exclusive => libc::F_WRLCK,
		FdLock::Unlock => libc::F_UNLCK,
	}) as _;
	lck.l_whence = libc::SEEK_SET as _;
	loop {
		// SAFETY: `fcntl` on a caller-supplied descriptor with a valid
		// `flock`; a stale descriptor fails with `EBADF`.
		if unsafe { libc::fcntl(fd, libc::F_SETLK, &lck) } != -1 {
			return Ok(());
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINTR) => {},
			Some(libc::EAGAIN | libc::EACCES) => return Err(io::ErrorKind::WouldBlock.into()),
			_ => return Err(err),
		}
	}
}

/// Record locks on descriptors need `fcntl` ([`Fs::lock_fd`]).
#[cfg(not(unix))]
fn lock_fd(_file: OsHandle, _lock: crate::bash::fs::FdLock) -> io::Result<()> {
	Err(io::ErrorKind::Unsupported.into())
}

/// [`Fs::lock`]: open `path` read-write and take a non-waiting `F_WRLCK`
/// record lock on the whole file.
fn lock_file(path: &BStr) -> io::Result<Box<dyn File>> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.open(host_path(path)?)?;
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		// SAFETY: `flock` is plain data; all-zero is a valid value.
		let mut lck: libc::flock = unsafe { std::mem::zeroed() };
		lck.l_type = libc::F_WRLCK as _;
		lck.l_whence = libc::SEEK_SET as _;
		// SAFETY: a valid open descriptor and a valid `flock`.
		if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lck) } == -1 {
			let err = io::Error::last_os_error();
			return Err(match err.raw_os_error() {
				Some(libc::EAGAIN | libc::EACCES) => io::ErrorKind::WouldBlock.into(),
				_ => err,
			});
		}
	}
	#[cfg(not(unix))]
	file.try_lock().map_err(|e| match e {
		fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
		fs::TryLockError::Error(e) => e,
	})?;
	Ok(Box::new(StdFile::new(file)))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ready<T>(p: FsPoll<T>) -> io::Result<T> {
		match p {
			FsPoll::Ready(r) => r,
			FsPoll::Pending(_) => panic!("StdFs never pends"),
		}
	}

	/// A temp name is this process's pid and a counter, so a node an earlier
	/// process with the same pid left (one killed before its cleanup; pids
	/// are reused within minutes on a busy machine) holds a name this
	/// process would take: the next free name is taken instead of failing
	/// with `EEXIST`. Both kinds: a file, and on Unix the FIFO of a process
	/// substitution (Windows makes a named pipe there).
	#[test]
	fn a_temp_node_skips_names_another_process_left() {
		let purposes: &[TempPurpose] = if cfg!(unix) {
			&[TempPurpose::HereDoc, TempPurpose::ProcSub { output: false }]
		} else {
			&[TempPurpose::HereDoc]
		};
		for &purpose in purposes {
			// Other tests of this process (Bazel runs them all in one) take
			// names too, so one of this window can be held already: by them,
			// or by a node an earlier process left. Either serves, and only
			// the names this test made are its to remove.
			let next = TEMP_SEQ.load(Ordering::Relaxed);
			let mine: Vec<_> = (next..next + 4)
				.filter_map(|seq| {
					let path = std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
					match fs::File::create_new(&path) {
						Ok(_) => Some(path),
						Err(e) if e.kind() == io::ErrorKind::AlreadyExists => None,
						Err(e) => panic!("{path:?}: {e}"),
					}
				})
				.collect();
			let node = temp(purpose);
			for path in &mine {
				fs::remove_file(path).unwrap();
			}
			let node = node.unwrap_or_else(|e| panic!("{purpose:?}: {e}"));
			let path = host_path(node.path.as_ref()).unwrap().to_path_buf();
			assert!(!mine.contains(&path), "{purpose:?} took a name already held: {path:?}");
			fs::remove_file(&path).unwrap();
		}
	}

	#[test]
	fn stat_and_access_distinguish_files_dirs_and_missing_paths() {
		let dir = std::env::temp_dir();
		let mut fs = StdFs::default();
		let dir_bytes = engine_path(&dir);
		assert_eq!(ready(fs.stat(dir_bytes.as_bstr(), true)).unwrap().kind, StatKind::Dir);
		let missing = ready(fs.stat(b"/definitely/not/here".as_bstr(), true)).unwrap_err();
		assert_eq!(missing.kind(), io::ErrorKind::NotFound);
		assert!(ready(fs.chdir_check(dir_bytes.as_bstr())).is_ok());
	}

	#[cfg(unix)]
	mod fifos {
		use std::{
			io::{Read, Write},
			os::unix::fs::OpenOptionsExt,
			sync::Arc,
			task::{Wake, Waker},
			thread,
			time::{Duration, Instant},
		};

		use super::*;

		struct Unpark(thread::Thread);

		impl Wake for Unpark {
			fn wake(self: Arc<Self>) {
				self.0.unpark();
			}
		}

		fn fifo() -> BString {
			let node =
				ready(StdFs::default().mkfifo_or_temp(TempPurpose::ProcSub { output: false })).unwrap();
			assert!(node.fifo);
			node.path
		}

		/// Dropping a test's last copy of a pipe or FIFO end is not yet the
		/// last close of it: while a sibling test of this process starts a
		/// child (as `in_blocking_writer_process` does), the child shares
		/// every descriptor of the process until its `exec` closes them. A
		/// test that needs the end closed waits for the effect itself, here
		/// the end of file: the verdict is the event; the 10 s bound only
		/// ends a test that never sees it.
		fn read_to_end_of_file(reader: &mut fs::File) -> Vec<u8> {
			let deadline = Instant::now() + Duration::from_secs(10);
			let mut got = Vec::new();
			let mut buf = [0u8; 4096];
			loop {
				match reader.read(&mut buf) {
					Ok(0) => return got,
					Ok(n) => got.extend_from_slice(&buf[..n]),
					// A write end is still open somewhere.
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
						assert!(Instant::now() < deadline, "DEADLINE: no end of file within 10 s");
						thread::sleep(Duration::from_millis(5));
					},
					Err(e) => panic!("reading the FIFO: {e}"),
				}
			}
		}

		fn pending(p: FsPoll<Box<dyn File>>) -> Box<dyn crate::bash::FsPending<Box<dyn File>>> {
			match p {
				FsPoll::Pending(p) => p,
				FsPoll::Ready(_) => {
					panic!("a one-way FIFO open with no other end must not complete synchronously")
				},
			}
		}

		fn finish(p: &mut Box<dyn crate::bash::FsPending<Box<dyn File>>>) -> Box<dyn File> {
			let waker = Waker::from(Arc::new(Unpark(thread::current())));
			let mut cx = Context::from_waker(&waker);
			// An open that never completes hangs the test until the runner's
			// bound.
			loop {
				if let Poll::Ready(r) = p.poll(&mut cx) {
					return r.unwrap();
				}
				thread::park_timeout(Duration::from_millis(100));
			}
		}

		#[test]
		fn reading_a_fifo_is_pending_until_a_writer_opens() {
			let path = fifo();
			let mut p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			let host = host_path(&path).unwrap().to_path_buf();
			let writer = thread::spawn(move || {
				thread::sleep(Duration::from_millis(50));
				fs::OpenOptions::new()
					.write(true)
					.open(host)
					.unwrap()
					.write_all(b"x")
					.unwrap();
			});
			let mut f = finish(&mut p);
			writer.join().unwrap();
			let waker = Waker::noop();
			let mut buf = [0; 4];
			let n = match f.poll_read(&mut Context::from_waker(waker), &mut buf) {
				Poll::Ready(r) => r.unwrap(),
				Poll::Pending => panic!("StdFile reads are ready"),
			};
			assert_eq!(&buf[..n], b"x");
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		#[test]
		fn writing_a_fifo_is_pending_until_a_reader_opens() {
			let path = fifo();
			let mut p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let host = host_path(&path).unwrap().to_path_buf();
			let reader = thread::spawn(move || {
				let mut s = String::new();
				fs::File::open(host)
					.unwrap()
					.read_to_string(&mut s)
					.unwrap();
				s
			});
			let mut f = finish(&mut p);
			assert!(matches!(
				f.poll_write(&mut Context::from_waker(Waker::noop()), b"hi"),
				Poll::Ready(Ok(2))
			));
			drop(f);
			assert_eq!(reader.join().unwrap(), "hi");
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		/// A FIFO opened for writing only goes to the helper thread even when
		/// a reader has it open, so no `O_NONBLOCK` writer open is tried on a
		/// FIFO that exists when the open starts: under gVisor before
		/// google/gvisor@d6786915 one that fails with `ENXIO` (no reader yet)
		/// counts as a writer for a moment, and a reader then inside a blocking
		/// open of the FIFO returns with no writer and reads end of file, while
		/// the shell's real writer waits for a reader for ever.
		#[test]
		fn writing_a_fifo_is_left_to_the_helper_even_with_a_reader() {
			let path = fifo();
			let host = host_path(&path).unwrap().to_path_buf();
			let mut reader = fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&host)
				.unwrap();
			let mut w = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let mut writer = finish(&mut w);
			let waker = Waker::noop();
			assert!(matches!(
				writer.poll_write(&mut Context::from_waker(waker), b"x"),
				Poll::Ready(Ok(1))
			));
			drop(writer);
			let got = read_to_end_of_file(&mut reader);
			assert_eq!(got, b"x");
			fs::remove_file(&host).unwrap();
		}

		/// `mkfifo f; echo x > f & . f` in one engine thread: both ends live
		/// on this thread, so neither read nor write may wait in the kernel.
		/// The writer opens first, as the background `echo` does; each open
		/// is pending, as every one-way FIFO open is.
		#[test]
		fn both_ends_of_a_fifo_on_one_thread_never_block() {
			let path = fifo();
			let mut w = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let mut r = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			let mut reader = finish(&mut r);
			let mut writer = finish(&mut w);
			assert_eq!(reader.kind(), FileKind::Pipe);
			// The reader and the writer each have a waker of their own, so a
			// wait for one never takes the other's wake.
			let read_flag = Arc::new(Flag::default());
			let read_waker = Waker::from(Arc::clone(&read_flag));
			let mut rcx = Context::from_waker(&read_waker);
			let write_flag = Arc::new(Flag::default());
			let write_waker = Waker::from(Arc::clone(&write_flag));
			let mut wcx = Context::from_waker(&write_waker);
			let mut buf = [0u8; 8192];
			assert!(
				reader.poll_read(&mut rcx, &mut buf).is_pending(),
				"no data yet: Pending, not a wait"
			);
			assert!(matches!(writer.poll_write(&mut wcx, b"echo four - OK\n"), Poll::Ready(Ok(15))));
			read_flag.wait("reader woken by the write");
			let Poll::Ready(Ok(n)) = reader.poll_read(&mut rcx, &mut buf) else {
				panic!("readable after the write");
			};
			assert_eq!(&buf[..n], b"echo four - OK\n");

			// Fill the pipe: the writer gets Pending instead of waiting. A
			// write that is `Ready` is taken: in the pipe, or, where writes go
			// through a writer thread of the descriptor's own, handed to that
			// thread, whose bytes reach the pipe as the reader makes room.
			let chunk = vec![b'z'; 1 << 16];
			let mut written = 0usize;
			loop {
				match writer.poll_write(&mut wcx, &chunk) {
					Poll::Ready(Ok(n)) => written += n,
					Poll::Ready(Err(e)) => panic!("{e}"),
					Poll::Pending => break,
				}
				assert!(written < 64 << 20, "the pipe never filled");
			}
			// Read it all back. A read that finds the pipe empty while a
			// writer thread still holds bytes is `Pending`, and the reader is
			// woken when they arrive.
			let mut read = 0usize;
			while read < written {
				match reader.poll_read(&mut rcx, &mut buf) {
					Poll::Ready(Ok(n)) => read += n,
					Poll::Pending => read_flag.wait("reader woken as the written bytes arrive"),
					other => panic!("data is buffered: {other:?}"),
				}
			}
			write_flag.wait("writer woken once space freed up");
			drop(writer);
			end_of_file(&mut reader, &mut rcx, &read_flag, || {});
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		/// Ends the test process, naming `what`, unless the returned sender
		/// is dropped within `limit`. The clock runs on a thread of its own:
		/// the call it bounds may wait in the kernel on the test's thread.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		fn deadline(what: &'static str, limit: Duration) -> std::sync::mpsc::Sender<()> {
			let (done, finished) = std::sync::mpsc::channel::<()>();
			thread::spawn(move || {
				if finished.recv_timeout(limit) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
					eprintln!("DEADLINE fired: {what} did not return within {limit:?}");
					std::process::exit(1);
				}
			});
			done
		}

		/// A pipe's write end, wrapped, and its read end, with all but `free`
		/// bytes of the pipe's capacity queued.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		fn pipe_with_free(free: usize) -> (StdFile, io::PipeReader) {
			use std::os::fd::AsRawFd;

			let (r, w) = io::pipe().unwrap();
			let mut fill = fs::File::from(std::os::fd::OwnedFd::from(w));
			// SAFETY: `F_GETPIPE_SZ` takes no argument; `fill` owns the fd.
			let capacity = unsafe { libc::fcntl(fill.as_raw_fd(), libc::F_GETPIPE_SZ) };
			let capacity = usize::try_from(capacity).expect("F_GETPIPE_SZ");
			fill.write_all(&vec![b'q'; capacity - free]).unwrap();
			let mut queued: libc::c_int = 0;
			// SAFETY: `FIONREAD` writes one `c_int` through the pointer; `r`
			// owns the fd.
			assert_eq!(unsafe { libc::ioctl(r.as_raw_fd(), libc::FIONREAD as _, &raw mut queued) }, 0);
			assert_eq!(
				usize::try_from(queued).unwrap(),
				capacity - free,
				"all but {free} bytes queued"
			);
			let writer = StdFile::new(fill);
			assert_eq!(writer.kind(), FileKind::Pipe);
			(writer, r)
		}

		/// The room query itself is a Linux control: it is independent of
		/// readiness and fails if `write_room` is replaced by `PIPE_BUF`.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		#[test]
		fn write_room_reports_free_full_and_reader_gone_pipes() {
			use std::os::fd::AsRawFd;

			let (writer, reader) = pipe_with_free(100);
			assert_eq!(crate::sys::ready::write_room(writer.file.as_raw_fd()), 100);
			drop(reader);

			let (writer, reader) = pipe_with_free(0);
			assert_eq!(crate::sys::ready::write_room(writer.file.as_raw_fd()), 0);
			drop(reader);

			let (writer, reader) = pipe_with_free(0);
			drop(reader);
			// The reader is gone once no copy of the read end is left, which
			// a child that a sibling test is starting can hold for a moment
			// ([`read_to_end_of_file`]): the write end reports `POLLERR` then.
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				let mut p = libc::pollfd { fd: writer.file.as_raw_fd(), events: 0, revents: 0 };
				// SAFETY: one `pollfd`, valid for the call.
				let n = unsafe { libc::poll(&raw mut p, 1, 100) };
				if n < 0 {
					// A signal ended the wait: the loop waits again.
					let e = io::Error::last_os_error();
					assert_eq!(e.kind(), io::ErrorKind::Interrupted, "poll: {e}");
				} else if p.revents & libc::POLLERR != 0 {
					break;
				}
				assert!(Instant::now() < deadline, "DEADLINE: the read end was not gone within 10 s");
			}
			assert_eq!(
				crate::sys::ready::write_room(writer.file.as_raw_fd()),
				crate::sys::ready::WRITE_CHUNK
			);
		}

		/// Linux output pipes get a fresh non-blocking description; setting a
		/// flag on `dup` would leak it to the original description externals
		/// inherit.
		#[cfg(target_os = "linux")]
		#[test]
		fn pipe_writer_has_a_private_nonblocking_description() {
			use std::os::fd::AsRawFd;

			let (_reader, writer) = io::pipe().unwrap();
			let writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(writer)));
			let private = writer
				.private_writer
				.as_ref()
				.expect("reopen /proc/self/fd pipe writer");
			// SAFETY: F_GETFL only reads this live inherited descriptor.
			let inherited = unsafe { libc::fcntl(writer.file.as_raw_fd(), libc::F_GETFL) };
			// SAFETY: F_GETFL only reads this live private descriptor.
			let private = unsafe { libc::fcntl(private.as_raw_fd(), libc::F_GETFL) };
			assert_eq!(inherited & libc::O_NONBLOCK, 0, "externals keep blocking stdout");
			assert_ne!(private & libc::O_NONBLOCK, 0, "shell's private writer is nonblocking");
		}

		/// A rival writer can take the room after `POLLOUT` and before this
		/// writer's `write(2)`. The write goes through the private
		/// non-blocking description, so it is `Pending` with nothing written,
		/// not a wait in the kernel. Drives `poll_write`; a write through the
		/// inherited blocking description waits here until the deadline.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_rival_that_takes_the_room_after_the_poll_leaves_the_write_pending() {
			use std::os::fd::AsRawFd;

			let (mut writer, reader) = pipe_with_free(libc::PIPE_BUF);
			assert!(writer.has_private_writer(), "the pipe was reopened");
			let mut rival = writer.file.try_clone().unwrap();
			writer.set_before_write(move || rival.write_all(&[b'c'; libc::PIPE_BUF]).unwrap());
			let finished =
				deadline("poll_write after a rival filled the pipe", Duration::from_secs(2));
			let wrote = writer.poll_write(&mut Context::from_waker(Waker::noop()), b"x");
			drop(finished);
			assert!(wrote.is_pending(), "{wrote:?}");
			let mut queued: libc::c_int = 0;
			// SAFETY: `FIONREAD` writes one `c_int` through the pointer; `reader`
			// owns the fd.
			let status =
				unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD as _, &raw mut queued) };
			assert_eq!(status, 0);
			// SAFETY: `F_GETPIPE_SZ` takes no argument; `writer` owns the fd.
			let capacity = unsafe { libc::fcntl(writer.file.as_raw_fd(), libc::F_GETPIPE_SZ) };
			assert_eq!(queued, capacity, "only the rival's bytes are in the pipe");
			drop(reader);
		}

		/// `F_SETPIPE_SZ` can grow a pipe after its writer was wrapped. A write
		/// then has the new room: a capacity measured before would see the
		/// old capacity queued, find no room, and wake itself while the pipe
		/// polls writable.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_pipe_grown_after_wrapping_takes_a_write_into_its_new_room() {
			use std::os::fd::AsRawFd;

			let (reader, w) = io::pipe().unwrap();
			let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
			let fd = writer.file.as_raw_fd();
			// SAFETY: `F_GETPIPE_SZ` takes no argument; `writer` owns the fd.
			let old = unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) };
			// SAFETY: `F_SETPIPE_SZ` takes an int; `writer` owns the fd.
			let grown = unsafe { libc::fcntl(fd, libc::F_SETPIPE_SZ, 2 * old) };
			assert!(grown >= 2 * old, "F_SETPIPE_SZ: {grown}: {}", io::Error::last_os_error());
			let queued = vec![b'q'; usize::try_from(old).unwrap()];
			writer.file.try_clone().unwrap().write_all(&queued).unwrap();
			let finished = deadline("poll_write into a grown pipe", Duration::from_secs(2));
			let wrote = writer.poll_write(&mut Context::from_waker(Waker::noop()), b"x");
			drop(finished);
			assert!(matches!(wrote, Poll::Ready(Ok(1))), "{wrote:?}");
			drop(reader);
		}

		/// A pipe with less than `PIPE_BUF` bytes free can still poll
		/// writable (gVisor reports `POLLOUT` with one byte free), and a
		/// blocking write of at most `PIPE_BUF` bytes then waits until all of
		/// it fits. Nothing reads this pipe, so such a wait never ends:
		/// `poll_write` must write at most the free space, or be `Pending`.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_write_to_a_pipe_with_less_than_pipe_buf_free_never_waits() {
			write_into_less_than_pipe_buf_free(true);
		}

		/// The same through the writer thread, Darwin's only route, which this
		/// test's child process forces on Linux.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_write_to_a_pipe_with_less_than_pipe_buf_free_through_the_writer_thread_never_waits() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_write_to_a_pipe_with_less_than_pipe_buf_free_through_the_writer_thread_never_waits"
				),
				|| write_into_less_than_pipe_buf_free(false),
			);
		}

		#[cfg(target_os = "linux")]
		fn write_into_less_than_pipe_buf_free(private: bool) {
			let free = libc::PIPE_BUF - 1;
			let (mut writer, reader) = pipe_with_free(free);
			assert_eq!(writer.has_private_writer(), private);
			let buf = vec![b'x'; 2 * libc::PIPE_BUF];
			let finished = deadline("poll_write with PIPE_BUF - 1 bytes free", Duration::from_secs(1));
			let wrote = writer.poll_write(&mut Context::from_waker(Waker::noop()), &buf);
			drop(finished);
			match wrote {
				Poll::Pending => {},
				Poll::Ready(Ok(n)) if private => {
					assert!((1..=free).contains(&n), "wrote {n} with {free} bytes free");
				},
				// The writer thread takes the chunk whole and waits for room.
				Poll::Ready(Ok(n)) => assert_eq!(n, buf.len(), "the writer thread took {n}"),
				Poll::Ready(Err(e)) => panic!("{e}"),
			}
			drop(reader);
		}

		/// Two writers that share one descriptor (`echo AAAA & echo BBBB`)
		/// each get their own write through the writer thread, once and in
		/// order. A is taken when it is handed off. B polls only once A's
		/// line is in the pipe and the thread is idle, so B's poll is a hand-off
		/// of its own every run: no result of A's is left for B to take.
		#[cfg(target_os = "linux")]
		#[test]
		fn writers_sharing_the_writer_thread_each_get_their_own_write() {
			in_blocking_writer_process(
				concat!(module_path!(), "::writers_sharing_the_writer_thread_each_get_their_own_write"),
				|| {
					let (mut reader, w) = io::pipe().unwrap();
					let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished =
						deadline("two writers through the writer thread", Duration::from_secs(5));
					let a = writer.poll_write(&mut cx, b"AAAA\n");
					assert!(matches!(a, Poll::Ready(Ok(5))), "A is taken when handed off: {a:?}");
					let mut first = [0u8; 5];
					reader.read_exact(&mut first).unwrap();
					assert_eq!(&first, b"AAAA\n");
					flush(&mut writer, &flag, &mut cx);
					assert!(writer.writer_idle());
					let b = writer.poll_write(&mut cx, b"BBBB\n");
					assert!(matches!(b, Poll::Ready(Ok(5))), "B is a hand-off of its own: {b:?}");
					drop(writer);
					let mut rest = Vec::new();
					reader.read_to_end(&mut rest).unwrap();
					drop(finished);
					assert_eq!(rest, b"BBBB\n", "after A's line, only B's line, once");
				},
			);
		}

		/// A write whose future is dropped while it waits is not taken by a
		/// later write of the same bytes (`timeout 1 sh -c 'while :; do echo
		/// y; done'; echo y`): the later write reaches the pipe. The first
		/// write goes to the writer thread while the pipe is full, and is
		/// never polled again.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_later_identical_write_after_a_dropped_one_is_written() {
			in_blocking_writer_process(
				concat!(module_path!(), "::a_later_identical_write_after_a_dropped_one_is_written"),
				|| {
					let (mut writer, mut reader) = pipe_with_free(0);
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished =
						deadline("a write after a dropped identical one", Duration::from_secs(5));
					let dropped = writer.poll_write(&mut cx, b"y\n");
					assert!(!matches!(dropped, Poll::Ready(Err(_))), "{dropped:?}");
					let mut fill = vec![0u8; pipe_capacity(&reader)];
					reader.read_exact(&mut fill).unwrap();
					let mut line = [0u8; 2];
					reader.read_exact(&mut line).unwrap();
					assert_eq!(&line, b"y\n", "the first write's line");
					flush(&mut writer, &flag, &mut cx);
					let mut later = writer.poll_write(&mut cx, b"y\n");
					while later.is_pending() {
						flag.wait("the writer thread finished the first write");
						later = writer.poll_write(&mut cx, b"y\n");
					}
					assert!(matches!(later, Poll::Ready(Ok(2))), "{later:?}");
					drop(writer);
					let mut rest = Vec::new();
					reader.read_to_end(&mut rest).unwrap();
					drop(finished);
					assert_eq!(rest, b"y\n", "the later write's line reached the pipe");
				},
			);
		}

		/// A descriptor someone set non-blocking (a socket handed in as a
		/// run's stdio) refuses a write to it when full with `EAGAIN`; the
		/// writer thread waits until it is writable and writes again, so the
		/// write neither fails nor loses its bytes.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_full_nonblocking_descriptor_waits_for_room_through_the_writer_thread() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_full_nonblocking_descriptor_waits_for_room_through_the_writer_thread"
				),
				|| {
					use std::os::fd::AsRawFd;

					let (mut writer, mut reader) = pipe_with_free(0);
					assert!(!writer.has_private_writer());
					let fd = writer.file.as_raw_fd();
					// SAFETY: F_GETFL and F_SETFL on a descriptor `writer` owns.
					unsafe {
						let flags = libc::fcntl(fd, libc::F_GETFL);
						assert!(flags >= 0);
						assert_eq!(libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK), 0);
					}
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished =
						deadline("a write to a full non-blocking pipe", Duration::from_secs(5));
					let mut wrote = writer.poll_write(&mut cx, b"z");
					while wrote.is_pending() {
						flag.wait("the writer thread finished");
						wrote = writer.poll_write(&mut cx, b"z");
					}
					assert!(matches!(wrote, Poll::Ready(Ok(1))), "{wrote:?}");
					// The thread has met `EAGAIN` on the full pipe before anything
					// drains it, so the byte read below comes from the retry.
					while WOULD_BLOCK_SEEN.load(std::sync::atomic::Ordering::SeqCst) == 0 {
						std::thread::yield_now();
					}
					let mut fill = vec![0u8; pipe_capacity(&reader)];
					reader.read_exact(&mut fill).unwrap();
					let mut z = [0u8; 1];
					reader.read_exact(&mut z).unwrap();
					assert_eq!(&z, b"z");
					flush(&mut writer, &flag, &mut cx);
					drop(finished);
				},
			);
		}

		/// The writer thread holds one chunk at a time: while it waits for
		/// room, a second write is `Pending` and hands nothing off, which
		/// bounds what the shell holds and is the backpressure; once room
		/// comes, the two arrive in the order written.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_second_write_waits_while_the_first_is_in_flight_and_both_arrive_in_order() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_second_write_waits_while_the_first_is_in_flight_and_both_arrive_in_order"
				),
				|| {
					let (mut writer, mut reader) = pipe_with_free(0);
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished =
						deadline("two writes through a busy writer thread", Duration::from_secs(5));
					let first = writer.poll_write(&mut cx, b"first\n");
					assert!(matches!(first, Poll::Ready(Ok(6))), "{first:?}");
					let second = writer.poll_write(&mut cx, b"second\n");
					assert!(second.is_pending(), "the thread still holds the first: {second:?}");
					assert!(!writer.writer_idle());
					let mut fill = vec![0u8; pipe_capacity(&reader)];
					reader.read_exact(&mut fill).unwrap();
					let mut line = [0u8; 6];
					reader.read_exact(&mut line).unwrap();
					assert_eq!(&line, b"first\n");
					let mut second = second;
					while second.is_pending() {
						flag.wait("the writer thread finished the first write");
						second = writer.poll_write(&mut cx, b"second\n");
					}
					assert!(matches!(second, Poll::Ready(Ok(7))), "{second:?}");
					drop(writer);
					let mut rest = Vec::new();
					reader.read_to_end(&mut rest).unwrap();
					drop(finished);
					assert_eq!(rest, b"second\n");
				},
			);
		}

		/// A chunk that fails is the failure of the writer that handed it off,
		/// and of no other (`trap '' PIPE; echo a & echo b`). A's chunk is in
		/// the kernel; B's fails when the reader leaves. B's settle with its
		/// own mark gets the error; A's settle with its own mark gets none,
		/// though B's failure is newer than A's hand-off.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_failed_chunk_is_reported_to_the_writer_that_handed_it_off() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_failed_chunk_is_reported_to_the_writer_that_handed_it_off"
				),
				|| {
					let (mut writer, reader) = pipe_with_free(2);
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished = deadline("two writers and a failed chunk", Duration::from_secs(5));
					// Writer A hands off its line; it fills the pipe's last room.
					let a = write_marked(&mut writer, &mut cx, b"a\n");
					let Poll::Ready(Ok((2, Some(a_mark)))) = a else {
						panic!("A: {a:?}")
					};
					settled(&mut writer, &flag, &mut cx, std::slice::from_ref(&a_mark))
						.expect("A's chunk is out");
					// Writer B hands off its line; the pipe is full, so it waits.
					let b = write_marked(&mut writer, &mut cx, b"b\n");
					let Poll::Ready(Ok((2, Some(b_mark)))) = b else {
						panic!("B: {b:?}")
					};
					// Nothing reads, so B's line cannot go out; the reader leaves
					// and B's chunk fails, whether its write started yet or not.
					drop(reader);
					let b_done = settled(&mut writer, &flag, &mut cx, &[b_mark]);
					let a_done = settled(&mut writer, &flag, &mut cx, &[a_mark]);
					drop(finished);
					assert!(
						matches!(&b_done, Err(e) if e.kind() == io::ErrorKind::BrokenPipe),
						"B's chunk failed, and B's settle found no error: {b_done:?}"
					);
					assert!(
						a_done.is_ok(),
						"A's chunk was out, and A's settle got an error: {a_done:?}"
					);
				},
			);
		}

		/// A failed chunk's error does not outlive its writer: a FIFO whose
		/// reader left and came back takes the next write again (`exec
		/// 3>fifo`, the reader leaves, `echo a >&3` fails with `EPIPE`, a new
		/// reader opens the FIFO, `echo b >&3` goes out), as `write(2)` on the
		/// same descriptor does.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_fifo_whose_reader_comes_back_takes_the_next_write() {
			in_blocking_writer_process(
				concat!(module_path!(), "::a_fifo_whose_reader_comes_back_takes_the_next_write"),
				|| {
					let dir = tempfile::tempdir().unwrap();
					let path = dir.path().join("fifo");
					let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
					// SAFETY: `c` is a NUL-terminated path.
					assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
					let first = fs::OpenOptions::new()
						.read(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&path)
						.unwrap();
					let mut writer =
						StdFile::new(fs::OpenOptions::new().write(true).open(&path).unwrap());
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished = deadline("a FIFO whose reader comes back", Duration::from_secs(5));
					drop(first);
					let a = write_marked(&mut writer, &mut cx, b"a\n");
					let Poll::Ready(Ok((2, Some(a_mark)))) = a else {
						panic!("a: {a:?}")
					};
					let a_done = settled(&mut writer, &flag, &mut cx, &[a_mark]);
					assert!(
						matches!(&a_done, Err(e) if e.kind() == io::ErrorKind::BrokenPipe),
						"`a` had no reader: {a_done:?}"
					);
					let mut second = fs::OpenOptions::new()
						.read(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&path)
						.unwrap();
					let b = write_marked(&mut writer, &mut cx, b"b\n");
					let Poll::Ready(Ok((2, Some(b_mark)))) = b else {
						panic!("`b` after a new reader opened the FIFO: {b:?}")
					};
					settled(&mut writer, &flag, &mut cx, &[b_mark]).expect("`b` went out");
					let mut line = [0u8; 2];
					second.read_exact(&mut line).unwrap();
					drop(finished);
					assert_eq!(&line, b"b\n");
				},
			);
		}

		/// A plain write never takes a marked writer's error: A (marked) fails
		/// and has not settled; the plain write after it hands off its own
		/// chunk, and A's settle still finds A's error.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_plain_write_never_takes_a_marked_writers_error() {
			in_blocking_writer_process(
				concat!(module_path!(), "::a_plain_write_never_takes_a_marked_writers_error"),
				|| {
					let (reader, w) = io::pipe().unwrap();
					let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
					drop(reader);
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished = deadline("a plain write beside a marked one", Duration::from_secs(5));
					let Poll::Ready(Ok((2, Some(a)))) = write_marked(&mut writer, &mut cx, b"a\n")
					else {
						panic!("A was not handed off")
					};
					let plain = loop {
						match writer.poll_write(&mut cx, b"p\n") {
							Poll::Pending => flag.wait("the writer thread finished A's chunk"),
							done => break done,
						}
					};
					let a_done = settled(&mut writer, &flag, &mut cx, &[a]);
					drop(finished);
					assert!(
						matches!(plain, Poll::Ready(Ok(2))),
						"the plain write took A's error: {plain:?}"
					);
					assert!(
						matches!(&a_done, Err(e) if e.kind() == io::ErrorKind::BrokenPipe),
						"A's settle lost A's error: {a_done:?}"
					);
				},
			);
		}

		/// A failed chunk's error waits for its writer however many chunks of
		/// other writers fail before it settles: nothing evicts it. A's chunk
		/// fails; a hundred other writers' chunks fail and none of them has
		/// settled yet; A's settle finds A's error.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_failed_chunks_error_waits_for_its_writer_however_many_chunks_fail_after_it() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_failed_chunks_error_waits_for_its_writer_however_many_chunks_fail_after_it"
				),
				|| {
					let (reader, w) = io::pipe().unwrap();
					let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
					drop(reader);
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished = deadline("a hundred failed chunks", Duration::from_secs(20));
					let Poll::Ready(Ok((2, Some(a)))) = write_marked(&mut writer, &mut cx, b"a\n")
					else {
						panic!("A was not handed off")
					};
					let mut others = Vec::new();
					while others.len() < 100 {
						match write_marked(&mut writer, &mut cx, b"o\n") {
							Poll::Ready(Ok((2, Some(mark)))) => others.push(mark),
							Poll::Pending => flag.wait("the writer thread finished a chunk"),
							other => panic!("another writer's chunk: {other:?}"),
						}
					}
					// Every chunk is done before A settles.
					while writer.poll_settle(&mut cx).is_pending() {
						flag.wait("the writer thread finished the last chunk");
					}
					let failed = CHUNKS_FAILED.load(std::sync::atomic::Ordering::SeqCst);
					let a_done = settled(&mut writer, &flag, &mut cx, &[a]);
					drop(finished);
					assert_eq!(failed, 101, "every chunk had no reader");
					assert!(
						matches!(&a_done, Err(e) if e.kind() == io::ErrorKind::BrokenPipe),
						"A's error was dropped before A settled: {a_done:?}"
					);
					for mark in &others {
						assert!(
							settled(&mut writer, &flag, &mut cx, std::slice::from_ref(mark)).is_err()
						);
					}
				},
			);
		}

		/// A flush takes no marked writer's error: when a tee flushes fd 3
		/// before a background `printf a >&3` settles, `printf` keeps its own
		/// failure.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_flush_takes_no_marked_writers_error() {
			in_blocking_writer_process(
				concat!(module_path!(), "::a_flush_takes_no_marked_writers_error"),
				|| {
					let (reader, w) = io::pipe().unwrap();
					let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
					drop(reader);
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished = deadline("a flush beside a marked writer", Duration::from_secs(5));
					let Poll::Ready(Ok((2, Some(a)))) = write_marked(&mut writer, &mut cx, b"a\n")
					else {
						panic!("A was not handed off")
					};
					let flushed = loop {
						match writer.poll_flush(&mut cx) {
							Poll::Ready(result) => break result,
							Poll::Pending => flag.wait("the writer thread went idle"),
						}
					};
					let a_done = settled(&mut writer, &flag, &mut cx, &[a]);
					drop(finished);
					assert!(flushed.is_ok(), "the flush took A's error: {flushed:?}");
					assert!(
						matches!(&a_done, Err(e) if e.kind() == io::ErrorKind::BrokenPipe),
						"A's settle lost A's error to the flush: {a_done:?}"
					);
				},
			);
		}

		/// Hands `buf` to `writer`: what it took and its chunk's mark.
		#[cfg(target_os = "linux")]
		fn write_marked(
			writer: &mut StdFile,
			cx: &mut Context<'_>,
			buf: &[u8],
		) -> Poll<io::Result<(usize, Option<Mark>)>> {
			writer.poll_write_marked(cx, buf)
		}

		/// Settles `writer` for `marks`, waiting for its writer thread.
		#[cfg(target_os = "linux")]
		fn settled(
			writer: &mut StdFile,
			flag: &Flag,
			cx: &mut Context<'_>,
			marks: &[Mark],
		) -> io::Result<()> {
			loop {
				match writer.poll_settle_marked(cx, marks) {
					Poll::Ready(result) => return result,
					Poll::Pending => flag.wait("the writer thread finished the chunk"),
				}
			}
		}

		/// Flushes `writer`, waiting for its writer thread; panics on an error.
		#[cfg(target_os = "linux")]
		fn flush(writer: &mut StdFile, flag: &Flag, cx: &mut Context<'_>) {
			loop {
				match writer.poll_flush(cx) {
					Poll::Ready(result) => return result.unwrap(),
					Poll::Pending => flag.wait("the writer thread went idle"),
				}
			}
		}

		/// The capacity of the pipe `reader` reads.
		#[cfg(target_os = "linux")]
		fn pipe_capacity(reader: &io::PipeReader) -> usize {
			use std::os::fd::AsRawFd;

			// SAFETY: `F_GETPIPE_SZ` takes no argument; `reader` owns the fd.
			let capacity = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETPIPE_SZ) };
			usize::try_from(capacity).expect("F_GETPIPE_SZ")
		}

		/// A write through the writer thread that fills the pipe is taken at
		/// once, with nothing left to collect while the pipe is full.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_write_that_fills_the_pipe_is_collected_while_the_pipe_is_full() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::a_write_that_fills_the_pipe_is_collected_while_the_pipe_is_full"
				),
				|| {
					let (mut writer, reader) = pipe_with_free(libc::PIPE_BUF);
					assert!(!writer.has_private_writer());
					let flag = Arc::new(Flag::default());
					let waker = Waker::from(Arc::clone(&flag));
					let mut cx = Context::from_waker(&waker);
					let finished =
						deadline("collecting a write that filled the pipe", Duration::from_secs(5));
					let buf = vec![b'x'; libc::PIPE_BUF];
					let mut wrote = writer.poll_write(&mut cx, &buf);
					while wrote.is_pending() {
						flag.wait("the writer thread finished");
						wrote = writer.poll_write(&mut cx, &buf);
					}
					drop(finished);
					assert!(matches!(wrote, Poll::Ready(Ok(n)) if n == libc::PIPE_BUF), "{wrote:?}");
					drop(reader);
				},
			);
		}

		/// A pipe that polls writable with less room than an atomic record
		/// needs (gVisor reports `POLLOUT` with one byte free) is tried again
		/// after a pause, not in a loop that wakes itself at once.
		#[cfg(target_os = "linux")]
		#[test]
		fn an_atomic_record_that_does_not_fit_waits_without_spinning() {
			let (mut writer, reader) = pipe_with_free(10);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let cx = Context::from_waker(&waker);
			let record = [b'r'; 20];
			let start = Instant::now();
			let mut polls = 0;
			while start.elapsed() < Duration::from_millis(200) {
				polls += 1;
				let wrote = writer.poll_write_atomic(&cx, &record);
				assert!(wrote.is_pending(), "{wrote:?}");
				flag.wait_for(Duration::from_millis(200).saturating_sub(start.elapsed()));
			}
			assert!(polls < 100, "{polls} polls in 200 ms: the write wakes itself in a loop");
			drop(reader);
		}

		/// A full pipe whose reader left has no room, yet a write to it does
		/// not wait: it fails with `EPIPE` at once, and must not poll again
		/// forever for room that never comes.
		///
		/// A process that another test of this process forks holds a copy of
		/// every descriptor until its exec, this pipe's read end too, and the
		/// write then still sees a reader. So the test runs in a process of its
		/// own, where no other test runs.
		#[cfg(target_os = "linux")]
		#[test]
		fn a_write_to_a_full_pipe_whose_reader_left_fails_at_once() {
			const NAME: &str =
				"sys::fs::tests::fifos::a_write_to_a_full_pipe_whose_reader_left_fails_at_once";
			const ALONE: &str = "PI_SHELL_TEST_ALONE";
			if std::env::var_os(ALONE).is_none_or(|name| name != NAME) {
				let output = std::process::Command::new(std::env::current_exe().unwrap())
					.args(["--exact", NAME, "--nocapture", "--test-threads=1"])
					.env(ALONE, NAME)
					.output()
					.unwrap();
				let (out, err) =
					(String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
				assert!(output.status.success(), "the run of its own failed:\n{out}\n{err}");
				assert!(out.contains("1 passed"), "the run of its own ran no test:\n{out}\n{err}");
				return;
			}

			let (mut writer, reader) = pipe_with_free(0);
			drop(reader);
			let finished =
				deadline("poll_write to a full pipe with no reader", Duration::from_secs(10));
			let wrote = writer.poll_write(&mut Context::from_waker(Waker::noop()), b"x");
			drop(finished);
			assert!(
				matches!(&wrote, Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::BrokenPipe),
				"{wrote:?}"
			);
		}

		/// `exec 3</etc/passwd; echo foo >&3` (and the same on a pipe's read
		/// end): writing in a direction the fd was not opened for fails at once
		/// with EBADF, as in bash; readiness for it would never come.
		#[test]
		fn the_wrong_direction_fails_with_ebadf_instead_of_waiting() {
			let (r, w) = io::pipe().unwrap();
			let mut reader = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(r)));
			let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
			assert_eq!(reader.kind(), FileKind::Pipe);
			let mut cx = Context::from_waker(Waker::noop());
			let ebadf = |p: Poll<io::Result<usize>>| match p {
				Poll::Ready(Err(e)) => e.raw_os_error() == Some(libc::EBADF),
				_ => false,
			};
			assert!(ebadf(reader.poll_write(&mut cx, b"foo\n")), "write to a read end");
			assert!(ebadf(writer.poll_read(&mut cx, &mut [0; 4])), "read from a write end");
			let file = fs::File::open("/etc/passwd").unwrap();
			let mut regular = StdFile::new(file);
			assert!(ebadf(regular.poll_write(&mut cx, b"foo\n")), "write to a read-only file");
		}

		/// The same through the writer thread, Darwin's only route, which this
		/// test's child process forces on Linux.
		#[cfg(target_os = "linux")]
		#[test]
		fn both_ends_of_a_fifo_on_one_thread_never_block_through_the_writer_thread() {
			in_blocking_writer_process(
				concat!(
					module_path!(),
					"::both_ends_of_a_fifo_on_one_thread_never_block_through_the_writer_thread"
				),
				both_ends_of_a_fifo_on_one_thread_never_block,
			);
		}

		/// Reads `reader` to its end of file, which the test's own close of
		/// the write end (just before) may not give at once: while a sibling
		/// test of this process starts a child (`sys/spawn/unix.rs`: `fork`,
		/// `Command::pre_exec`, `posix_spawn`), the child holds a copy of
		/// every descriptor of the process until its `exec` closes them, and
		/// a writer thread of the descriptor's own, where writes go through
		/// one, holds a copy until it ends. The end of file comes with the
		/// last close, so it is awaited as the event it is, the reader's wake
		/// through `flag`; `pending` runs at each `Pending`, before the wait.
		/// The verdict is the event; the 10 s bound only ends a test that
		/// never sees it.
		fn end_of_file(
			reader: &mut Box<dyn File>,
			cx: &mut Context<'_>,
			flag: &Flag,
			mut pending: impl FnMut(),
		) {
			let deadline = Instant::now() + Duration::from_secs(10);
			let mut buf = [0u8; 64];
			loop {
				match reader.poll_read(cx, &mut buf) {
					Poll::Ready(Ok(0)) => return,
					Poll::Pending => {
						assert!(Instant::now() < deadline, "no end of file within 10 s of the close");
						pending();
						flag.wait("reader woken when the last write end closed");
					},
					other => panic!("end of file after the writer closed: {other:?}"),
				}
			}
		}

		/// The end of file comes once the last copy of the write end is
		/// closed. Here a copy outlives the test's own close, as a sibling
		/// test's child holds one until its `exec`, and another thread closes
		/// it only once the wait for the end of file has begun: a read made
		/// once after the test's close gets `Pending`, every time.
		#[test]
		fn the_end_of_file_waits_for_the_last_copy_of_the_write_end() {
			use std::os::fd::{AsFd, OwnedFd};

			let path = fifo();
			let host = host_path(&path).unwrap().to_path_buf();
			let mut r = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			// The read open's helper waits in `open(2)` until this open.
			let writer = fs::OpenOptions::new().write(true).open(&host).unwrap();
			let mut reader = finish(&mut r);
			let copy: OwnedFd = writer.as_fd().try_clone_to_owned().unwrap();
			drop(writer);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let (release, released) = std::sync::mpsc::channel::<()>();
			let closer = thread::spawn(move || {
				// Ends with the test: a send, or the sender dropped.
				let _ = released.recv();
				drop(copy);
			});
			let mut release = Some(release);
			end_of_file(&mut reader, &mut cx, &flag, || {
				if let Some(release) = release.take() {
					release.send(()).unwrap();
				}
			});
			assert!(release.is_none(), "the end of file came while a copy of the write end was open");
			closer.join().unwrap();
			fs::remove_file(&host).unwrap();
		}

		/// `read -t 0.00001 var` with a terminal on stdin: the terminal read
		/// must not wait in the kernel, or the `read -t` timer and every other
		/// vproc stall.
		#[test]
		fn terminal_reads_are_pending_until_input_arrives() {
			use std::{
				ffi::CStr,
				os::fd::{AsRawFd, FromRawFd},
			};

			// SAFETY: plain call; returns a new fd we own (checked below).
			let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
			assert!(master >= 0, "posix_openpt: {}", io::Error::last_os_error());
			// SAFETY: `master` is a valid fd we own from here on.
			let mut master = unsafe { fs::File::from_raw_fd(master) };
			let fd = master.as_raw_fd();
			// SAFETY: plain calls on our master fd; `ptsname` returns a static
			// buffer read at once (each nextest test is its own process).
			let name = unsafe {
				assert_eq!(libc::grantpt(fd), 0);
				assert_eq!(libc::unlockpt(fd), 0);
				CStr::from_ptr(libc::ptsname(fd))
					.to_str()
					.unwrap()
					.to_owned()
			};
			let slave = fs::OpenOptions::new()
				.read(true)
				.write(true)
				.custom_flags(libc::O_NOCTTY)
				.open(&name)
				.unwrap();
			let mut tty = StdFile::new(slave);
			assert_eq!(tty.kind(), FileKind::Tty);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let mut buf = [0u8; 64];
			assert!(tty.poll_read(&mut cx, &mut buf).is_pending(), "no input: Pending, not a wait");
			master.write_all(b"typed\n").unwrap();
			flag.wait("terminal reader woken by input");
			let Poll::Ready(Ok(n)) = tty.poll_read(&mut cx, &mut buf) else {
				panic!("a line is available");
			};
			assert_eq!(&buf[..n], b"typed\n");
			let mut write = tty.poll_write(&mut cx, b"out\n");
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				match write {
					Poll::Ready(result) => {
						assert_eq!(result.unwrap(), 4, "terminal output fits");
						break;
					},
					Poll::Pending => {
						flag.wait("terminal writer finished off the scheduler worker");
						assert!(Instant::now() < deadline, "terminal writer stayed pending");
						write = tty.poll_write(&mut cx, b"out\n");
					},
				}
			}
		}

		/// A waker that records being woken.
		#[derive(Default)]
		struct Flag(std::sync::atomic::AtomicBool);

		impl Wake for Flag {
			fn wake(self: Arc<Self>) {
				self.0.store(true, std::sync::atomic::Ordering::SeqCst);
			}
		}

		impl Flag {
			/// Waits for the wake `_what` names; one that never comes hangs the
			/// test until the runner's bound fails it.
			fn wait(&self, _what: &str) {
				while !self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
					thread::sleep(Duration::from_millis(5));
				}
			}

			/// Waits up to `limit` for a wake; whether one came.
			#[cfg(target_os = "linux")]
			fn wait_for(&self, limit: Duration) -> bool {
				let deadline = Instant::now() + limit;
				loop {
					if self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
						return true;
					}
					if Instant::now() >= deadline {
						return false;
					}
					thread::sleep(Duration::from_millis(1));
				}
			}
		}

		/// Dropped opens leave no end of the FIFO behind, through
		/// `StdFs::open` as the engine opens them: each round drops a read
		/// and a write as soon as they start (in most rounds before their
		/// helpers run), and a helper any round leaves behind fails a later
		/// check, or makes a later write open complete at once. A helper the
		/// drop came before used to enter `open(2)` afterwards and stay on the
		/// FIFO, so the next writer's data went to it. The tests in `fifo`
		/// hold each point of the helper's start in turn.
		///
		/// A process that another test of this process forks holds a copy of
		/// every descriptor until its exec, a helper's end of this FIFO too,
		/// and the checks see that copy as an end the drop left behind. So the
		/// rounds run in a process of their own, where no other test runs.
		#[test]
		fn dropping_a_pending_fifo_open_releases_the_helper() {
			const NAME: &str =
				"sys::fs::tests::fifos::dropping_a_pending_fifo_open_releases_the_helper";
			const ALONE: &str = "PI_SHELL_TEST_ALONE";
			if std::env::var_os(ALONE).is_none_or(|name| name != NAME) {
				let output = std::process::Command::new(std::env::current_exe().unwrap())
					.args(["--exact", NAME, "--nocapture", "--test-threads=1"])
					.env(ALONE, NAME)
					.output()
					.unwrap();
				let (out, err) =
					(String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
				assert!(output.status.success(), "the run of its own failed:\n{out}\n{err}");
				assert!(out.contains("1 passed"), "the run of its own ran no test:\n{out}\n{err}");
				return;
			}

			let path = fifo();
			let host = host_path(&path).unwrap().to_path_buf();
			for round in 0..200 {
				drop(pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0)));
				assert!(!fifo::has_reader(&host), "round {round}: a reader is left on the FIFO");
				drop(pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0)));
				assert!(!fifo::has_writer(&host), "round {round}: a writer is left on the FIFO");
			}
			fs::remove_file(&host).unwrap();
		}

		#[test]
		fn read_write_fifo_opens_and_regular_files_stay_ready() {
			let path = fifo();
			let both = OpenFlags::READ.with(OpenFlags::WRITE);
			assert!(
				ready(StdFs::default().open(path.as_bstr(), both, 0)).is_ok(),
				"O_RDWR never blocks"
			);
			fs::remove_file(host_path(&path).unwrap()).unwrap();
			let node = ready(StdFs::default().mkfifo_or_temp(TempPurpose::HereDoc)).unwrap();
			assert!(ready(StdFs::default().open(node.path.as_bstr(), OpenFlags::READ, 0)).is_ok());
			fs::remove_file(host_path(&node.path).unwrap()).unwrap();
		}
	}

	#[test]
	fn exclusive_open_refuses_an_existing_file() {
		let mut fs = StdFs::default();
		let node = ready(fs.mkfifo_or_temp(TempPurpose::HereDoc)).unwrap();
		assert!(!node.fifo);
		let flags = OpenFlags::WRITE
			.with(OpenFlags::CREATE)
			.with(OpenFlags::EXCL);
		let err = ready(fs.open(node.path.as_bstr(), flags, 0o600))
			.err()
			.unwrap();
		assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
		std::fs::remove_file(host_path(&node.path).unwrap()).unwrap();
	}

	/// A temp name that an earlier process with this pid left in the temp
	/// directory (`obash-<pid>-<n>`, kept by a test or a shell that failed or
	/// was killed before it removed it) is skipped, instead of failing the
	/// process substitution or the here-document with EEXIST. Each purpose
	/// draws from a counter of its own, whose next four names exist.
	#[cfg(unix)]
	#[test]
	fn a_temp_name_left_behind_is_skipped() {
		/// Removes the names this test made, also when it fails.
		struct Made(Vec<std::path::PathBuf>);
		impl Drop for Made {
			fn drop(&mut self) {
				for path in &self.0 {
					let _ = fs::remove_file(path);
				}
			}
		}
		let name =
			|seq: u32| std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
		let mut made = Made(Vec::new());
		let (fifo_base, file_base) = (1 << 31, (1 << 31) + 64);
		let mut got = Vec::new();
		for (base, purpose) in
			[(fifo_base, TempPurpose::ProcSub { output: false }), (file_base, TempPurpose::HereDoc)]
		{
			for seq in base..base + 4 {
				if fs::File::create_new(name(seq)).is_ok() {
					made.0.push(name(seq));
				}
			}
			let node = temp_in(&AtomicU32::new(base), purpose).map(|node| {
				let host = host_path(&node.path).unwrap().to_path_buf();
				made.0.push(host.clone());
				(host, node.fifo)
			});
			got.push(node.map_err(|e| e.kind()));
		}
		assert_eq!(got, [Ok((name(fifo_base + 4), true)), Ok((name(file_base + 4), false))]);
	}

	/// A Windows pipe classified as a regular file made the line reader read
	/// ahead and seek back, which a pipe cannot: `printf 'a\nb\n' | zsh` ran
	/// only `a`.
	#[cfg(windows)]
	#[test]
	fn windows_pipes_files_and_nul_get_their_own_kinds() {
		use std::os::windows::io::OwnedHandle;
		let (r, _w) = io::pipe().unwrap();
		let pipe = StdFile::new(fs::File::from(OwnedHandle::from(r)));
		assert_eq!(pipe.kind(), FileKind::Pipe);
		let path = std::env::temp_dir().join(format!("pi-shell-classify-{}", std::process::id()));
		let regular = StdFile::new(fs::File::create(&path).unwrap());
		assert_eq!(regular.kind(), FileKind::Regular);
		drop(regular);
		fs::remove_file(&path).unwrap();
		let nul = StdFile::new(fs::OpenOptions::new().write(true).open("NUL").unwrap());
		assert_eq!(nul.kind(), FileKind::Device);
	}
}

#[cfg(all(test, windows))]
mod windows_devices {
	use super::*;

	/// `>/dev/null` failed with "The system cannot find the path
	/// specified" (`\dev\null` on the current drive); `[[ -c /dev/null ]]`
	/// and `-w` hold as on Unix.
	#[test]
	fn dev_null_is_the_null_device() {
		let mut fs = StdFs::default();
		let both = OpenFlags::READ.with(OpenFlags::WRITE);
		let FsPoll::Ready(Ok(mut f)) = fs.open(b"/dev/null".as_bstr(), both, 0) else {
			panic!("open /dev/null");
		};
		let mut cx = Context::from_waker(std::task::Waker::noop());
		assert!(matches!(f.poll_write(&mut cx, b"x"), Poll::Ready(Ok(1))));
		let FsPoll::Ready(stat) = fs.stat(b"/dev/null".as_bstr(), true) else {
			unreachable!()
		};
		assert_eq!(stat.unwrap().kind, StatKind::CharDev);
		let FsPoll::Ready(access) = fs.access(b"/dev/null".as_bstr(), Access::WRITE) else {
			unreachable!()
		};
		access.unwrap();
	}

	/// `cd ..` left `$PWD` as `\\?\F:\…`: `realpath` must answer with the
	/// drive path a user writes.
	#[test]
	fn realpath_has_no_verbatim_prefix() {
		let dir = std::env::temp_dir();
		let FsPoll::Ready(real) = StdFs::default().realpath(engine_path(&dir).as_bstr()) else {
			unreachable!()
		};
		let real = real.unwrap();
		assert!(!real.starts_with(br"\\?\"), "{real}");
		assert!(real.get(1) == Some(&b':'), "{real}");
	}
}
