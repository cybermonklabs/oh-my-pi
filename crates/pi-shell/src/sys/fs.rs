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
	DirEntry, DirIter, File, FileKind, Fs, FsPoll, OpenFlags, OsHandle, Stat, StdFd,
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
	/// Pending readiness wait (pipes and sockets). Declared first so it is
	/// dropped, and forgotten by the waiting thread, before `file` closes.
	#[cfg(unix)]
	watch:          Option<crate::sys::ready::Watch>,
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
/// Each chunk handed off gets the next mark. A chunk that fails keeps its
/// error under its mark until the writer that handed it off takes it, by
/// settling with the marks of its own chunks ([`File::poll_settle_marked`]);
/// a flush, which the engine makes before it closes the descriptor, takes
/// what no writer took. No other write sees it: every later write is made,
/// as every later `write(2)` is (a FIFO whose reader came back takes it), and
/// a writer gets the errors of its own chunks only.
#[derive(Debug)]
struct BlockingWriter {
	jobs:  std::sync::mpsc::Sender<(u64, Vec<u8>)>,
	state: Arc<parking_lot::Mutex<WriterState>>,
}

/// The most failed chunks whose errors are kept for their writers; past it
/// the oldest is dropped (its writer never settled).
const KEPT_ERRORS: usize = 64;

#[derive(Debug, Default)]
struct WriterState {
	/// The thread is writing a chunk.
	busy:   bool,
	/// Chunks handed off so far: the mark of the latest.
	handed: u64,
	/// Errors of failed chunks that no writer took yet, by mark.
	failed: std::collections::BTreeMap<u64, io::Error>,
	/// Writers and settles to wake when the thread is idle again.
	wakers: Vec<Waker>,
}

impl BlockingWriter {
	fn start(file: &fs::File) -> io::Result<Self> {
		let mut file = file.try_clone()?;
		let (jobs, queue) = std::sync::mpsc::channel::<(u64, Vec<u8>)>();
		let state = Arc::new(parking_lot::Mutex::new(WriterState::default()));
		let shared = Arc::clone(&state);
		std::thread::Builder::new()
			.name("obash-write".into())
			.stack_size(64 << 10)
			.spawn(move || {
				// Ends once the `StdFile` is dropped and the last chunk is done.
				while let Ok((mark, bytes)) = queue.recv() {
					let result = write_all_waiting(&mut file, &bytes);
					let wakers = {
						let mut s = shared.lock();
						s.busy = false;
						if let Err(e) = result {
							s.failed.insert(mark, e);
							while s.failed.len() > KEPT_ERRORS {
								s.failed.pop_first();
							}
						}
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
	fn poll_write(&self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<(usize, u64)>> {
		let mut s = self.state.lock();
		if s.busy {
			register(&mut s.wakers, cx);
			return Poll::Pending;
		}
		let chunk = &buf[..buf.len().min(BLOCKING_WRITE_CHUNK)];
		let mark = s.handed + 1;
		if self.jobs.send((mark, chunk.to_vec())).is_err() {
			return Poll::Ready(Err(io::Error::other("the writer thread stopped")));
		}
		s.handed = mark;
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

	/// `Ready` once every chunk up to the last of `marks` is done, with the
	/// error of the first of these chunks that failed, which it takes.
	fn poll_settle_marked(&self, cx: &Context<'_>, marks: &[u64]) -> Poll<io::Result<()>> {
		let mut s = self.state.lock();
		let done = s.handed - u64::from(s.busy);
		if marks.iter().any(|&mark| mark > done) {
			register(&mut s.wakers, cx);
			return Poll::Pending;
		}
		let mut first = None;
		for mark in marks {
			if let Some(e) = s.failed.remove(mark)
				&& first.is_none()
			{
				first = Some(e);
			}
		}
		Poll::Ready(first.map_or(Ok(()), Err))
	}

	/// `Ready` once the thread is idle, with the first error no writer took
	/// (all of them are taken).
	fn poll_drain(&self, cx: &Context<'_>) -> Poll<io::Result<()>> {
		let mut s = self.state.lock();
		if s.busy {
			register(&mut s.wakers, cx);
			return Poll::Pending;
		}
		let first = s.failed.pop_first().map(|(_, e)| e);
		s.failed.clear();
		Poll::Ready(first.map_or(Ok(()), Err))
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
		let kind = classify(&file);
		Self::with_kind(file, kind)
	}

	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "reads the access mode with fcntl on Unix")
	)]
	fn with_kind(file: fs::File, kind: FileKind) -> Self {
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
			watch: None,
			writer: None,
			#[cfg(target_os = "linux")]
			private_writer,
			#[cfg(all(test, unix))]
			before_write: None,
			#[cfg(unix)]
			access,
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
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch = None;
				return Poll::Ready(Ok(()));
			},
			Ok(false) => {},
			Err(e) => return Poll::Ready(Err(e)),
		}
		// Replace any earlier watch, so only the latest waker is kept.
		self.watch = None;
		match ready::watch(fd, events, cx.waker()) {
			Ok(w) => self.watch = Some(w),
			Err(e) => return Poll::Ready(Err(e)),
		}
		// It may have become ready before the watch was registered; the
		// poller would see that too, this only saves a round trip.
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch = None;
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
	) -> Poll<io::Result<(usize, u64)>> {
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
	) -> Poll<io::Result<Option<u64>>> {
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
	) -> Poll<io::Result<Option<u64>>> {
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

/// Only a character device (or a handle `fstat` cannot read) can be a
/// terminal, so a regular file, pipe or socket costs one `fstat` and no
/// terminal probe.
fn classify(file: &fs::File) -> FileKind {
	let Ok(meta) = file.metadata() else {
		return if file.is_terminal() {
			FileKind::Tty
		} else {
			FileKind::Device
		};
	};
	let ft = meta.file_type();
	if ft.is_file() {
		return FileKind::Regular;
	}
	if file.is_terminal() {
		return FileKind::Tty;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		if ft.is_fifo() {
			return FileKind::Pipe;
		}
		if ft.is_socket() {
			return FileKind::Socket;
		}
	}
	FileKind::Device
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
		#[cfg(unix)]
		if self.gated(false) {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::READ)) {
				return Poll::Ready(Err(e));
			}
			// Readable (or hung up): this read returns without waiting.
			return Poll::Ready(self.file.read(buf));
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.read(buf))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.poll_write_marked(cx, buf).map_ok(|(n, _)| n)
	}

	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<u64>)>> {
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

	/// Waits for the writer thread, and gives the first error of a chunk no
	/// writer took: the engine flushes before it closes the descriptor, so a
	/// failure of the last write before the close is reported there.
	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		if let Some(writer) = &self.writer
			&& let Err(e) = std::task::ready!(writer.poll_drain(cx))
		{
			return Poll::Ready(Err(e));
		}
		Poll::Ready(self.file.flush())
	}

	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match &self.writer {
			Some(writer) => writer.poll_settle(cx).map(Ok),
			None => Poll::Ready(Ok(())),
		}
	}

	fn poll_settle_marked(&mut self, cx: &mut Context<'_>, marks: &[u64]) -> Poll<io::Result<()>> {
		match &self.writer {
			Some(writer) => writer.poll_settle_marked(cx, marks),
			None => Poll::Ready(Ok(())),
		}
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		self.file.seek(pos)
	}

	fn kind(&self) -> FileKind {
		self.kind
	}

	fn os_handle(&self) -> Option<OsHandle> {
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

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self::with_kind(self.file.try_clone()?, self.kind)))
	}
}

/// Engine path → host path (UTF-8 required on Windows). A URL path
/// ([`crate::bash::fs::url_root_len`]) names no host file: `NotFound`, rather
/// than a lookup relative to the process's working directory.
pub fn host_path(p: &[u8]) -> io::Result<&Path> {
	if crate::bash::fs::url_root_len(p).is_some() {
		return Err(io::Error::from(io::ErrorKind::NotFound));
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
		}
	}
	#[cfg(windows)]
	{
		let mode = match (kind, meta.permissions().readonly()) {
			(StatKind::Dir, _) => 0o755,
			(_, true) => 0o444,
			(_, false) => 0o644,
		};
		Stat {
			kind,
			mode,
			size: meta.len(),
			uid: 0,
			gid: 0,
			dev: 0,
			ino: 0,
			nlink: 1,
			mtime_ns,
			atime_ns,
			// Windows has no status-change time: the creation time stands in.
			ctime_ns: since_epoch(meta.created()),
			blocks: meta.len().div_ceil(512),
		}
	}
}

fn open(path: &BStr, flags: OpenFlags, mode: u32, umask: Option<u32>) -> io::Result<Box<dyn File>> {
	#[cfg(windows)]
	if let Some(server) = pipe::take(path, flags) {
		return server;
	}
	let path = host_path(path)?;
	Ok(Box::new(StdFile::new(create_with_mode(path, flags, mode, umask)?)))
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
) -> io::Result<fs::File> {
	#[cfg(unix)]
	if flags.contains(OpenFlags::CREATE) && process_umask.is_none_or(|mask| mode & mask != 0) {
		use std::os::unix::fs::PermissionsExt as _;
		let mut exclusive = options(flags, mode);
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
	options(flags, mode).open(path)
}

fn options(flags: OpenFlags, mode: u32) -> OpenOptions {
	let mut o = OpenOptions::new();
	o.read(flags.contains(OpenFlags::READ))
		.write(flags.contains(OpenFlags::WRITE))
		.append(flags.contains(OpenFlags::APPEND))
		.truncate(flags.contains(OpenFlags::TRUNC))
		.create(flags.contains(OpenFlags::CREATE));
	if flags.contains(OpenFlags::EXCL) {
		o.create_new(true);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		o.mode(mode);
	}
	#[cfg(windows)]
	let _ = mode;
	o
}

/// Opening a FIFO in one direction blocks until the other end opens; it runs
/// on a helper thread and completes as a pending fs op.
#[cfg(unix)]
mod fifo {
	use std::{
		fs::{self, OpenOptions},
		io,
		os::unix::fs::{FileTypeExt, OpenOptionsExt},
		path::PathBuf,
		sync::Arc,
		task::{Context, Poll, Waker},
		thread,
	};

	use bstr::BStr;
	use parking_lot::Mutex;

	use super::{StdFile, host_path, options};
	use crate::bash::{File, FsPending, OpenFlags};

	/// Result slot shared with the helper thread.
	#[derive(Default)]
	struct Slot {
		result:    Option<io::Result<fs::File>>,
		waker:     Option<Waker>,
		/// The result was handed to the engine.
		finished:  bool,
		/// The engine dropped the open: the helper closes what it gets.
		cancelled: bool,
	}

	/// A FIFO open in flight.
	struct FifoOpen {
		slot:  Arc<Mutex<Slot>>,
		path:  PathBuf,
		write: bool,
	}

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
		if !fs::metadata(host).ok()?.file_type().is_fifo() {
			return None;
		}
		let slot = Arc::new(Mutex::new(Slot::default()));
		let (opts, target, helper) = (options(flags, mode), host.to_path_buf(), Arc::clone(&slot));
		let spawned = thread::Builder::new()
			.name("obash-fifo".into())
			.stack_size(64 << 10)
			.spawn(move || {
				let opened = opts.open(&target);
				let mut s = helper.lock();
				if s.cancelled {
					return;
				}
				s.result = Some(opened);
				let waker = s.waker.take();
				drop(s);
				if let Some(w) = waker {
					w.wake();
				}
			});
		if let Err(e) = spawned {
			slot.lock().result = Some(Err(e));
		}
		Some(Box::new(FifoOpen { slot, path: host.to_path_buf(), write }))
	}

	impl FsPending<Box<dyn File>> for FifoOpen {
		fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Box<dyn File>>> {
			let mut s = self.slot.lock();
			if let Some(r) = s.result.take() {
				s.finished = true;
				return Poll::Ready(r.map(|f| Box::new(StdFile::new(f)) as Box<dyn File>));
			}
			if !s.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
				s.waker = Some(cx.waker().clone());
			}
			Poll::Pending
		}

		/// Cancelling releases the helper by briefly opening the other end,
		/// which the real other end can observe (a writer that comes and
		/// goes reads as end of file).
		fn reissuable(&self) -> bool {
			false
		}
	}

	impl Drop for FifoOpen {
		fn drop(&mut self) {
			{
				let mut s = self.slot.lock();
				if s.finished || s.result.is_some() {
					return;
				}
				s.cancelled = true;
			}
			// Release the helper blocked in open(2): be the other end for a
			// moment, without blocking ourselves.
			let mut other = OpenOptions::new();
			if self.write {
				other.read(true);
			} else {
				other.write(true);
			}
			other.custom_flags(libc::O_NONBLOCK);
			let _ = other.open(&self.path);
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

/// Unique temp names within this process.
static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn temp(purpose: TempPurpose) -> io::Result<TempNode> {
	let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
	#[cfg(windows)]
	if let TempPurpose::ProcSub { output } = purpose {
		return pipe::create(output, seq);
	}
	let path = std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
	let fifo = matches!(purpose, TempPurpose::ProcSub { .. }) && cfg!(unix);
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
		fs::File::create_new(&path)?;
	}
	Ok(TempNode { path: engine_path(&path), fifo })
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
		#[cfg(unix)]
		if let Some(pending) = fifo::pending(path, flags, mode) {
			return FsPoll::Pending(pending);
		}
		FsPoll::Ready(open(path, flags, mode, self.umask))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
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
		FsPoll::Ready(
			host_path(path)
				.and_then(fs::canonicalize)
				.map(|p| engine_path(&p)),
		)
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		FsPoll::Ready(temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(chdir_check(path))
	}
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

		fn pending(p: FsPoll<Box<dyn File>>) -> Box<dyn crate::bash::FsPending<Box<dyn File>>> {
			match p {
				FsPoll::Pending(p) => p,
				FsPoll::Ready(_) => panic!("a one-way FIFO open must not complete synchronously"),
			}
		}

		fn finish(p: &mut Box<dyn crate::bash::FsPending<Box<dyn File>>>) -> Box<dyn File> {
			let waker = Waker::from(Arc::new(Unpark(thread::current())));
			let mut cx = Context::from_waker(&waker);
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				if let Poll::Ready(r) = p.poll(&mut cx) {
					return r.unwrap();
				}
				assert!(Instant::now() < deadline, "open never completed");
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

		/// `mkfifo f; echo x > f & . f` in one engine thread: both ends live
		/// on this thread, so neither read nor write may wait in the kernel.
		#[test]
		fn both_ends_of_a_fifo_on_one_thread_never_block() {
			let path = fifo();
			let mut r = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			let mut w = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let mut reader = finish(&mut r);
			let mut writer = finish(&mut w);
			assert_eq!(reader.kind(), FileKind::Pipe);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let mut buf = [0u8; 8192];
			assert!(
				reader.poll_read(&mut cx, &mut buf).is_pending(),
				"no data yet: Pending, not a wait"
			);
			assert!(matches!(writer.poll_write(&mut cx, b"echo four - OK\n"), Poll::Ready(Ok(15))));
			flag.wait("reader woken by the write");
			let Poll::Ready(Ok(n)) = reader.poll_read(&mut cx, &mut buf) else {
				panic!("readable after the write");
			};
			assert_eq!(&buf[..n], b"echo four - OK\n");

			// Fill the pipe: the writer gets Pending instead of waiting.
			let chunk = vec![b'z'; 1 << 16];
			let mut written = 0usize;
			loop {
				match writer.poll_write(&mut cx, &chunk) {
					Poll::Ready(Ok(n)) => written += n,
					Poll::Ready(Err(e)) => panic!("{e}"),
					Poll::Pending => break,
				}
				assert!(written < 64 << 20, "the pipe never filled");
			}
			let mut read = 0usize;
			while read < written {
				match reader.poll_read(&mut cx, &mut buf) {
					Poll::Ready(Ok(n)) => read += n,
					other => panic!("data is buffered: {other:?}"),
				}
			}
			flag.wait("writer woken once space freed up");
			drop(writer);
			assert!(
				matches!(reader.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(0))),
				"end of file after the writer closed"
			);
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
					settled(&mut writer, &flag, &mut cx, &[a_mark]).expect("A's chunk is out");
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

		/// Hands `buf` to `writer`: what it took and its chunk's mark.
		#[cfg(target_os = "linux")]
		fn write_marked(
			writer: &mut StdFile,
			cx: &mut Context<'_>,
			buf: &[u8],
		) -> Poll<io::Result<(usize, Option<u64>)>> {
			writer.poll_write_marked(cx, buf)
		}

		/// Settles `writer` for `marks`, waiting for its writer thread.
		#[cfg(target_os = "linux")]
		fn settled(
			writer: &mut StdFile,
			flag: &Flag,
			cx: &mut Context<'_>,
			marks: &[u64],
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
			fn wait(&self, what: &str) {
				let deadline = Instant::now() + Duration::from_secs(10);
				while !self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
					assert!(Instant::now() < deadline, "not woken: {what}");
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

		#[test]
		fn dropping_a_pending_fifo_open_releases_the_helper() {
			let path = fifo();
			let host = host_path(&path).unwrap().to_path_buf();
			let p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			drop(p);
			// Once the helper's read end is closed, no reader is left: a
			// non-blocking write open fails with ENXIO.
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				let r = fs::OpenOptions::new()
					.write(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&host);
				if r.as_ref().err().and_then(io::Error::raw_os_error) == Some(libc::ENXIO) {
					break;
				}
				assert!(Instant::now() < deadline, "helper still holds the FIFO");
				thread::sleep(Duration::from_millis(10));
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
}
