//! Asynchronous standard-stream plumbing for async utilities.
//!
//! An async utility body runs as a task on the runtime, so it must never make
//! a blocking call on a descriptor or a virtual filesystem provider. Output
//! therefore lands in an in-memory buffer ([`AsyncOut`]) that the host drains
//! at unit boundaries, and input is read through a [`Source`]. Both reach
//! native descriptors through readiness-driven I/O:
//!
//! - A descriptor inherited from the shell (stdin, stdout, stderr) shares its
//!   open file description with the shell and with other pipeline stages, so
//!   `O_NONBLOCK` is never set on it. A private duplicate is registered with
//!   the reactor instead, and every syscall on it is preceded by a zero-timeout
//!   readiness check, so it cannot block.
//! - A descriptor this module opens itself (a FIFO operand) owns its
//!   description: it is opened `O_NONBLOCK` and read until `WouldBlock`.
//! - Regular files, never-blocking devices and in-process streams are read and
//!   written inline: no readiness exists for them and they never wait for
//!   another process.
//! - Off unix, where anonymous pipes have no readiness API, Windows pipes run
//!   their reads and writes on the blocking pool behind the same async API.

// The module is API consumed by the feature-gated utility modules; a build with
// no utility features enabled legitimately uses none of it.
#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

#[cfg(unix)]
use std::os::fd::{AsFd, OwnedFd};
use std::{
	io::{self, Read, Write},
	path::Path,
	sync::Arc,
};

use parking_lot::Mutex;

use crate::{host::OutputGate, openfile::OpenFile};

/// Pending bytes at which a regular-file destination is drained before the
/// utility ends.
const FILE_DRAIN_THRESHOLD: usize = 64 * 1024;

/// Largest buffer a drained batch hands back for reuse.
const RECYCLED_CAPACITY: usize = 1024 * 1024;

/// Largest read [`Source::read_to_end`] makes at once.
const READ_CHUNK: usize = 64 * 1024;

/// Memory-backed output of an async utility: `Write` appends to a buffer that
/// never touches the descriptor, and the host delivers it with
/// [`AsyncOut::drain`].
///
/// Clones share the buffer, so handles for stdout and stderr onto one
/// destination (`2>&1`) keep write order. The emulated-SIGPIPE and
/// cancellation rules of the descriptor-backed writers hold: once the command
/// is cancelled, writes and pending bytes are dropped; once a drain hit a
/// closed reader, stderr output is discarded and stdout writes fail.
#[derive(Clone)]
pub(crate) struct AsyncOut {
	shared: Arc<Shared>,
}

struct Shared {
	pending:      Mutex<Vec<u8>>,
	sink:         Sink,
	/// The destination as a plain file, for duplicating and terminal checks
	/// without waiting on a drain in progress.
	handle:       OpenFile,
	regular_file: bool,
	gate:         OutputGate,
}

enum Sink {
	/// A provider file, written through its async API; the lock keeps
	/// concurrent drains in order.
	Provider(tokio::sync::Mutex<()>),
	/// A descriptor or in-process stream, opened on the first drain; the lock
	/// keeps concurrent drains in order.
	Native(tokio::sync::Mutex<Native>),
}

/// How a native destination is written, decided on the first drain.
enum Native {
	/// Not classified yet.
	Unopened,
	/// A regular file, never-blocking device or in-process stream, written
	/// inline.
	Inline(OpenFile),
	/// A descriptor written once the reactor reports it writable.
	#[cfg(unix)]
	Descriptor(descriptor::Descriptor),
	/// A pipe written on the blocking pool: every Windows pipe, and a Unix
	/// descriptor that can block but could not be registered.
	#[cfg(any(unix, windows))]
	Blocking(OpenFile),
}

impl Native {
	/// Classifies `handle`: inline for a regular file, a device that never
	/// blocks or an in-process stream; otherwise a reactor-driven descriptor,
	/// or the blocking pool where none can be registered (every Windows pipe;
	/// a failed dup or registration on Unix). Needs a runtime to register
	/// with.
	fn open(handle: &OpenFile, regular_file: bool) -> Self {
		#[cfg(unix)]
		{
			if !regular_file
				&& let Ok(fd) = handle.try_borrow_as_fd()
				&& pi_vfs::fd_reads_can_block(fd)
			{
				// A write that can wait never runs inline on the worker.
				#[cfg(test)]
				let owned = if descriptor::OPEN_DUP_FAILS.get() {
					Err(io::Error::from_raw_os_error(libc::EMFILE))
				} else {
					fd.try_clone_to_owned()
				};
				#[cfg(not(test))]
				let owned = fd.try_clone_to_owned();
				return match owned.map(descriptor::Descriptor::gated) {
					Ok(Ok(descriptor)) => Self::Descriptor(descriptor),
					Ok(Err(_)) | Err(_) => Self::Blocking(handle.clone()),
				};
			}
			Self::Inline(handle.clone())
		}
		#[cfg(windows)]
		{
			if regular_file { Self::Inline(handle.clone()) } else { Self::Blocking(handle.clone()) }
		}
		#[cfg(not(any(unix, windows)))]
		{
			let _ = regular_file;
			Self::Inline(handle.clone())
		}
	}

	/// Writes all of `bytes`; hands them back for reuse.
	async fn write_all(&mut self, bytes: Vec<u8>) -> (Vec<u8>, io::Result<()>) {
		match self {
			Self::Unopened => (bytes, Ok(())),
			Self::Inline(file) => {
				let result = file.write_all(&bytes).and_then(|()| file.flush());
				(bytes, result)
			},
			#[cfg(unix)]
			Self::Descriptor(descriptor) => {
				let result = descriptor.write_all(&bytes).await;
				(bytes, result)
			},
			#[cfg(any(unix, windows))]
			Self::Blocking(file) => {
				let mut file = file.clone();
				match tokio::task::spawn_blocking(move || {
					let result = file.write_all(&bytes).and_then(|()| file.flush());
					(bytes, result)
				})
				.await
				{
					Ok(done) => done,
					Err(error) => (Vec::new(), Err(io::Error::other(error))),
				}
			},
		}
	}
}

impl AsyncOut {
	/// Output delivered to a provider file through its async API.
	pub fn provider(file: Arc<pi_vfs::File>, gate: OutputGate) -> Self {
		Self::new(Sink::Provider(tokio::sync::Mutex::new(())), OpenFile::Vfs(file), false, gate)
	}

	/// Output delivered to `handle`, a native descriptor or in-process stream.
	pub fn native(handle: OpenFile, regular_file: bool, gate: OutputGate) -> Self {
		Self::new(Sink::Native(tokio::sync::Mutex::new(Native::Unopened)), handle, regular_file, gate)
	}

	fn new(sink: Sink, handle: OpenFile, regular_file: bool, gate: OutputGate) -> Self {
		Self {
			shared: Arc::new(Shared { pending: Mutex::default(), sink, handle, regular_file, gate }),
		}
	}

	/// Whether `self` and `other` are handles onto one buffer.
	pub fn same_as(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.shared, &other.shared)
	}

	/// Duplicates the destination as a raw [`OpenFile`]; pending bytes are not
	/// carried over.
	pub fn dup_file(&self) -> OpenFile {
		self.shared.handle.clone()
	}

	/// Whether the destination is a terminal.
	pub fn is_terminal(&self) -> bool {
		self.shared.handle.is_terminal()
	}

	/// Delivers the pending bytes: all of them when `full` or when the
	/// destination is not a regular file, else only once 64 KiB are pending.
	/// Returns at once when nothing is due.
	///
	/// A closed reader surfaces as [`io::ErrorKind::BrokenPipe`] and flips the
	/// SIGPIPE state; a cancelled command drops the bytes silently.
	pub async fn drain(&self, full: bool) -> io::Result<()> {
		if !self.shared.due(full) {
			return Ok(());
		}
		match &self.shared.sink {
			Sink::Provider(order) => self.shared.drain_provider(order).await,
			Sink::Native(native) => self.shared.drain_native(native).await,
		}
	}
}

impl Shared {
	fn due(&self, full: bool) -> bool {
		let pending = self.pending.lock().len();
		pending > 0 && (full || !self.regular_file || pending >= FILE_DRAIN_THRESHOLD)
	}

	fn append(&self, buf: &[u8]) -> io::Result<()> {
		if self.gate.discards() {
			return Ok(());
		}
		if self.gate.fails() {
			return Err(io::ErrorKind::BrokenPipe.into());
		}
		self.pending.lock().extend_from_slice(buf);
		Ok(())
	}

	/// Hands a delivered batch's allocation back for the next one.
	fn recycle(&self, mut bytes: Vec<u8>) {
		if bytes.capacity() > RECYCLED_CAPACITY {
			return;
		}
		let mut pending = self.pending.lock();
		if pending.is_empty() && pending.capacity() < bytes.capacity() {
			bytes.clear();
			*pending = bytes;
		}
	}

	async fn drain_provider(&self, order: &tokio::sync::Mutex<()>) -> io::Result<()> {
		let _order = order.lock().await;
		let bytes = std::mem::take(&mut *self.pending.lock());
		let Some(file) = self.handle.as_vfs() else {
			return Ok(());
		};
		if bytes.is_empty() || self.gate.discards() {
			self.recycle(bytes);
			return Ok(());
		}
		let result = async {
			file.write_all_async(&bytes).await?;
			file.flush_async().await
		}
		.await;
		if let Err(error) = &result {
			self.gate.record(error);
		}
		self.recycle(bytes);
		result
	}

	async fn drain_native(&self, native: &tokio::sync::Mutex<Native>) -> io::Result<()> {
		let mut native = native.lock().await;
		let bytes = std::mem::take(&mut *self.pending.lock());
		if bytes.is_empty() {
			return Ok(());
		}
		if self.gate.discards() {
			self.recycle(bytes);
			return Ok(());
		}
		if matches!(*native, Native::Unopened) {
			*native = Native::open(&self.handle, self.regular_file);
		}
		let (bytes, result) = native.write_all(bytes).await;
		if let Err(error) = &result {
			self.gate.record(error);
		}
		self.recycle(bytes);
		result
	}
}

impl Write for AsyncOut {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.shared.append(buf)?;
		Ok(buf.len())
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		self.shared.append(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// An input read without blocking the runtime: a provider file, a native descriptor (readiness-driven), a regular file (inline reads), or an in-process stream.
///
/// Dropping the future of a pending read cancels it; nothing is left running.
pub(crate) struct Source {
	repr:     Repr,
	metadata: Option<pi_vfs::Metadata>,
}

enum Repr {
	/// A provider file, or a native regular file, read through the file's
	/// async API.
	File(pi_vfs::File),
	/// A never-blocking native descriptor or an in-process stream, read
	/// inline.
	Inline(OpenFile),
	/// A descriptor read once the reactor reports it readable.
	#[cfg(unix)]
	Descriptor(descriptor::Descriptor),
	/// A pipe read on the blocking pool.
	#[cfg(windows)]
	Blocking(Blocking),
}

impl Source {
	fn new(repr: Repr, metadata: Option<pi_vfs::Metadata>) -> Self {
		Self { repr, metadata }
	}

	/// Opens `path` on `fs` for reading (FIFOs open without waiting for a writer).
	///
	/// # Errors
	///
	/// The open error.
	pub async fn open(fs: &pi_vfs::Fs, path: &Path) -> io::Result<Self> {
		if !fs.is_native_local(path) {
			let file = fs.open(path).await?;
			let metadata = file.metadata_async().await.ok();
			return Ok(Self::new(Repr::File(file), metadata));
		}
		let metadata = fs.metadata(path).await.ok();
		let special = metadata
			.as_ref()
			.map(pi_vfs::Metadata::file_type)
			.filter(|kind| !kind.is_file() && !kind.is_dir());
		match special {
			Some(kind) => Self::open_special(fs, path, kind.is_fifo(), metadata).await,
			None => Ok(Self::new(Repr::File(fs.open(path).await?), metadata)),
		}
	}

	/// Opens a native path that is neither a regular file nor a directory.
	async fn open_special(
		fs: &pi_vfs::Fs,
		path: &Path,
		fifo: bool,
		metadata: Option<pi_vfs::Metadata>,
	) -> io::Result<Self> {
		#[cfg(unix)]
		{
			// A FIFO opened `O_NONBLOCK` does not wait for a writer. Where the
			// path is an alias of a descriptor the shell passed, opening it
			// duplicates that descriptor instead of making a new description,
			// and `O_NONBLOCK` would leak to the shell.
			let owned_description = fifo && !aliases_descriptor(path);
			let file = if owned_description {
				let mut options = pi_vfs::OpenOptions::new();
				options.read(true).custom_flags(libc::O_NONBLOCK);
				fs.open_with(path, &options).await?
			} else {
				fs.open(path).await?
			};
			let file = file
				.into_native()
				.map_err(|_| io::Error::from(io::ErrorKind::Unsupported))?;
			let fd = OwnedFd::from(file);
			let descriptor = if owned_description {
				descriptor::Descriptor::nonblocking(fd)
			} else if pi_vfs::fd_reads_can_block(fd.as_fd()) {
				descriptor::Descriptor::gated(fd)
			} else {
				Err(fd)
			};
			let repr = match descriptor {
				Ok(descriptor) => Repr::Descriptor(descriptor),
				Err(fd) => Repr::Inline(OpenFile::from(std::fs::File::from(fd))),
			};
			Ok(Self::new(repr, metadata))
		}
		#[cfg(not(unix))]
		{
			let _ = fifo;
			let file = fs.open(path).await?;
			#[cfg(windows)]
			{
				let native = file
					.into_native()
					.map_err(|_| io::Error::from(io::ErrorKind::Unsupported))?;
				return Ok(Self::new(Repr::Blocking(Blocking::new(OpenFile::from(native))), metadata));
			}
			#[cfg(not(windows))]
			{
				Ok(Self::new(Repr::File(file), metadata))
			}
		}
	}

	/// Reads a descriptor handed in by the shell (stdin): a provider file
	/// through its async API, a descriptor that can block through the
	/// reactor on a private duplicate (the shared description's flags stay
	/// untouched), anything else inline. A descriptor that can block needs a
	/// runtime to register with.
	///
	/// # Errors
	///
	/// The error of duplicating the file.
	pub fn inherited(file: &OpenFile) -> io::Result<Self> {
		if let Some(file) = file.as_vfs() {
			return Ok(Self::new(Repr::File(file.try_clone()?), None));
		}
		#[cfg(unix)]
		if let Ok(fd) = file.try_borrow_as_fd()
			&& pi_vfs::fd_reads_can_block(fd)
			&& let Ok(descriptor) = descriptor::Descriptor::gated(fd.try_clone_to_owned()?)
		{
			return Ok(Self::new(Repr::Descriptor(descriptor), None));
		}
		#[cfg(windows)]
		if !matches!(file, OpenFile::Stream(_))
			&& !matches!(file, OpenFile::File(native) if native.metadata().is_ok_and(|meta| meta.is_file()))
		{
			return Ok(Self::new(Repr::Blocking(Blocking::new(file.try_clone()?)), None));
		}
		Ok(Self::new(Repr::Inline(file.try_clone()?), None))
	}

	/// Reads up to `buf.len()` bytes; 0 at end of input.
	///
	/// # Errors
	///
	/// The read error.
	pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		// File and inline reads never suspend: spend the task's coop budget so
		// a long read loop still yields and its cancellation takes effect.
		tokio::task::coop::consume_budget().await;
		match &mut self.repr {
			Repr::File(file) => file.read_async(buf).await,
			Repr::Inline(file) => loop {
				match file.read(buf) {
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					result => return result,
				}
			},
			#[cfg(unix)]
			Repr::Descriptor(descriptor) => descriptor.read(buf).await,
			#[cfg(windows)]
			Repr::Blocking(pipe) => pipe.read(buf).await,
		}
	}

	/// Reads the rest into `buf`; `io::ErrorKind::OutOfMemory` past `limit` bytes.
	///
	/// Returns the bytes appended. On an error, or when the future is dropped,
	/// `buf` keeps what was read within the limit.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::OutOfMemory`] past `limit`, else the read error.
	pub async fn read_to_end(&mut self, buf: &mut Vec<u8>, limit: usize) -> io::Result<usize> {
		let hint = self
			.metadata
			.as_ref()
			.map_or(0, |meta| usize::try_from(meta.len()).unwrap_or(usize::MAX))
			.min(limit);
		buf.try_reserve(hint)
			.map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
		let mut chunk = vec![0; READ_CHUNK.min(limit.saturating_add(1))];
		let mut total = 0;
		loop {
			let count = self.read(&mut chunk).await?;
			if count == 0 {
				return Ok(total);
			}
			let room = limit - total;
			if count > room {
				buf.extend_from_slice(&chunk[..room]);
				return Err(io::Error::new(io::ErrorKind::OutOfMemory, "input exceeds the size limit"));
			}
			buf.extend_from_slice(&chunk[..count]);
			total += count;
		}
	}

	/// Size and type reported at open, when known.
	pub fn metadata(&self) -> Option<&pi_vfs::Metadata> {
		self.metadata.as_ref()
	}
}

/// Whether `path` names one of the shell's descriptors in a way that opening
/// it duplicates the descriptor rather than reopening the object (macOS and
/// the BSDs; Linux reopens through `/proc`).
#[cfg(unix)]
fn aliases_descriptor(path: &Path) -> bool {
	!cfg!(any(target_os = "linux", target_os = "android"))
		&& ["/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"]
			.iter()
			.any(|alias| path.starts_with(alias))
}

/// A pipe read on the blocking pool, where the platform has no readiness API.
#[cfg(windows)]
struct Blocking {
	file:    Option<OpenFile>,
	scratch: Vec<u8>,
}

#[cfg(windows)]
impl Blocking {
	fn new(file: OpenFile) -> Self {
		Self { file: Some(file), scratch: Vec::new() }
	}

	async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let Some(mut file) = self.file.take() else {
			return Err(io::Error::other("input lost to an abandoned read"));
		};
		let mut scratch = std::mem::take(&mut self.scratch);
		scratch.resize(buf.len().min(READ_CHUNK), 0);
		let (file, scratch, result) = tokio::task::spawn_blocking(move || {
			let result = file.read(&mut scratch);
			(file, scratch, result)
		})
		.await
		.map_err(io::Error::other)?;
		self.file = Some(file);
		let count = result?;
		buf[..count].copy_from_slice(&scratch[..count]);
		self.scratch = scratch;
		Ok(count)
	}
}

#[cfg(unix)]
mod descriptor {
	//! Readiness-driven I/O on native descriptors.

	use std::{
		io,
		os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd},
		sync::Arc,
		time::Duration,
	};
	#[cfg(target_os = "linux")]
	use std::{ffi::CString, os::fd::FromRawFd};

	use tokio::io::unix::AsyncFd;

	/// The most one write on the blocking pool carries.
	const BLOCKING_WRITE_CHUNK: usize = 64 << 10;

	/// How often a read waiting on a named FIFO rechecks it on Apple
	/// platforms, whose kqueue never reports that a FIFO's last writer closed
	/// (`EVFILT_READ` stays silent; `poll` sees it).
	#[cfg(target_vendor = "apple")]
	const FIFO_EOF_RECHECK: Duration = Duration::from_millis(25);

	/// A descriptor registered with the reactor.
	pub(super) struct Descriptor {
		afd:            AsyncFd<OwnedFd>,
		/// The open file description is shared (or left blocking): every
		/// read syscall is preceded by a zero-timeout readiness check.
		gated:          bool,
		/// Writes go on Tokio's blocking pool, where a write may wait in the
		/// kernel without holding a runtime worker: the description could not
		/// be reopened privately (Darwin, a terminal, or a reopen that failed).
		blocking_writes: bool,
		/// The dup those writes use, made by the first one; a failed dup is
		/// that write's error.
		blocking:       std::sync::OnceLock<Arc<std::fs::File>>,
		/// The reactor never reports this descriptor's end of input (a named
		/// FIFO on an Apple platform); waits recheck it periodically.
		eof_unreported: bool,
	}

	#[cfg(test)]
	thread_local! {
		/// Test only: in this thread, [`Descriptor::gated`] skips the private
		/// reopen.
		pub(super) static NO_REOPEN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
		/// Test only: in this thread, the dup for blocking writes fails with
		/// `EMFILE`.
		pub(super) static DUP_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
		/// Test only: in this thread, the dup `Native::open` makes to register
		/// a descriptor fails with `EMFILE`.
		pub(super) static OPEN_DUP_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
	}

	impl Descriptor {
		/// Registers `fd`, whose description may be shared with other
		/// processes. On Linux a pipe or FIFO is reopened through procfs into
		/// a private non-blocking description; anything else (a terminal or
		/// another device, whose open has side effects), Darwin, and a reopen
		/// that fails write on the blocking pool.
		pub fn gated(fd: OwnedFd) -> Result<Self, OwnedFd> {
			#[cfg(all(target_os = "linux", test))]
			let reopen = !NO_REOPEN.get();
			#[cfg(all(target_os = "linux", not(test)))]
			let reopen = true;
			#[cfg(target_os = "linux")]
			if reopen
				&& is_fifo(fd.as_fd())
				&& let Ok(private) = reopen_nonblocking(fd.as_fd())
			{
				return Self::register(private, false, false);
			}
			Self::register(fd, true, true)
		}

		/// [`Self::gated`] as when the reopen fails: writes on the blocking
		/// pool, also for a pipe on Linux.
		#[cfg(test)]
		pub fn gated_without_reopen(fd: OwnedFd) -> Result<Self, OwnedFd> {
			Self::register(fd, true, true)
		}

		/// The descriptor this holds, for tests to ask what it refers to.
		#[cfg(all(test, target_os = "linux"))]
		pub fn as_fd(&self) -> BorrowedFd<'_> {
			self.afd.get_ref().as_fd()
		}

		/// Registers `fd`, whose description this process opened `O_NONBLOCK`.
		pub fn nonblocking(fd: OwnedFd) -> Result<Self, OwnedFd> {
			Self::register(fd, false, false)
		}

		fn register(fd: OwnedFd, gated: bool, blocking_writes: bool) -> Result<Self, OwnedFd> {
			let eof_unreported = is_named_fifo(fd.as_fd());
			match AsyncFd::try_new(fd) {
				Ok(afd) => Ok(Self {
					afd,
					gated,
					blocking_writes,
					blocking: std::sync::OnceLock::new(),
					eof_unreported,
				}),
				Err(error) => Err(error.into_parts().0),
			}
		}

		/// The dup blocking writes use, made on the first one.
		fn blocking_file(&self) -> io::Result<Arc<std::fs::File>> {
			if let Some(file) = self.blocking.get() {
				return Ok(Arc::clone(file));
			}
			#[cfg(test)]
			if DUP_FAILS.get() {
				return Err(io::Error::from_raw_os_error(libc::EMFILE));
			}
			let dup = Arc::new(std::fs::File::from(self.afd.get_ref().try_clone()?));
			Ok(Arc::clone(self.blocking.get_or_init(|| dup)))
		}

		/// Reads up to `buf.len()` bytes, waiting for readiness.
		pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
			loop {
				let mut guard = if self.eof_unreported {
					match self.readable_or_recheck().await? {
						Some(guard) => guard,
						None => {
							if readable_now(self.afd.get_ref().as_fd())? {
								match sys_read(self.afd.get_ref().as_raw_fd(), buf) {
									Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
									Err(error) if error.kind() == io::ErrorKind::WouldBlock => {},
									result => return result,
								}
							}
							continue;
						},
					}
				} else {
					self.afd.readable().await?
				};
				if self.gated && !readable_now(self.afd.get_ref().as_fd())? {
					guard.clear_ready();
					continue;
				}
				match guard.try_io(|afd| sys_read(afd.get_ref().as_raw_fd(), buf)) {
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(result) => return result,
					Err(_would_block) => {},
				}
			}
		}

		/// Readiness, or `None` once the recheck interval passed without it.
		#[cfg(target_vendor = "apple")]
		async fn readable_or_recheck(
			&self,
		) -> io::Result<Option<tokio::io::unix::AsyncFdReadyGuard<'_, OwnedFd>>> {
			tokio::select! {
				guard = self.afd.readable() => guard.map(Some),
				() = tokio::time::sleep(FIFO_EOF_RECHECK) => Ok(None),
			}
		}

		/// Readiness; every other platform's reactor reports end of input.
		#[cfg(not(target_vendor = "apple"))]
		async fn readable_or_recheck(
			&self,
		) -> io::Result<Option<tokio::io::unix::AsyncFdReadyGuard<'_, OwnedFd>>> {
			self.afd.readable().await.map(Some)
		}

		/// Writes all of `buf`, waiting for room. A private non-blocking
		/// description waits for readiness and takes what fits; a blocking
		/// one writes on the blocking pool, never on a runtime worker, and
		/// without any readiness: after a write that took the room, an
		/// edge-triggered wait may get no new edge while the reader keeps up.
		pub async fn write_all(&self, mut buf: &[u8]) -> io::Result<()> {
			if self.blocking_writes {
				let file = self.blocking_file()?;
				while !buf.is_empty() {
					let chunk = buf.len().min(BLOCKING_WRITE_CHUNK);
					let (file, bytes) = (Arc::clone(&file), buf[..chunk].to_vec());
					tokio::task::spawn_blocking(move || {
						use std::io::Write as _;
						(&*file).write_all(&bytes)
					})
					.await
					.map_err(io::Error::other)??;
					buf = &buf[chunk..];
				}
				return Ok(());
			}
			while !buf.is_empty() {
				let mut guard = self.afd.writable().await?;
				match guard.try_io(|afd| sys_write(afd.get_ref().as_raw_fd(), buf)) {
					Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
					Ok(Ok(written)) => buf = &buf[written..],
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(Err(error)) => return Err(error),
					Err(_would_block) => {},
				}
			}
			Ok(())
		}
	}

	fn sys_read(fd: i32, buf: &mut [u8]) -> io::Result<usize> {
		// SAFETY: `buf` is valid for writes of `buf.len()` bytes and `fd` is a
		// live descriptor owned by the caller's `AsyncFd` for the call.
		let count = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
		usize::try_from(count).map_err(|_| io::Error::last_os_error())
	}

	fn sys_write(fd: i32, buf: &[u8]) -> io::Result<usize> {
		// SAFETY: `buf` is valid for reads of `buf.len()` bytes and `fd` is a
		// live descriptor owned by the caller's `AsyncFd` for the call.
		let count = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
		usize::try_from(count).map_err(|_| io::Error::last_os_error())
	}

	/// A Linux procfs fd link opens a fresh description, so setting
	/// `O_NONBLOCK` cannot leak to an external that inherited `fd`.
	#[cfg(target_os = "linux")]
	fn reopen_nonblocking(fd: BorrowedFd<'_>) -> io::Result<OwnedFd> {
		let path = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).expect("fd path has no NUL");
		// SAFETY: `F_GETFL` only inspects the original descriptor.
		let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
		if flags < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `path` is NUL-terminated. `open` returns an owned fd on
		// success and does not change the original description's flags.
		let reopened = unsafe {
			libc::open(
				path.as_ptr(),
				(flags & libc::O_ACCMODE) | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY,
			)
		};
		if reopened < 0 {
			Err(io::Error::last_os_error())
		} else {
			// SAFETY: `open` returned one fresh descriptor.
			Ok(unsafe { OwnedFd::from_raw_fd(reopened) })
		}
	}

	/// Whether `fd` is a pipe or FIFO: the only kind whose reopen has no side
	/// effects (a device's open runs again: `/dev/ptmx` makes a new pty).
	#[cfg(target_os = "linux")]
	fn is_fifo(fd: BorrowedFd<'_>) -> bool {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` is valid for writes of one `struct stat`; `fd` is
		// borrowed from a live descriptor for the call.
		if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
			return false;
		}
		// SAFETY: a successful `fstat` filled the whole struct.
		let stat = unsafe { stat.assume_init() };
		stat.st_mode & libc::S_IFMT == libc::S_IFIFO
	}

	/// Whether `fd` is a FIFO with a name on an Apple platform (an anonymous
	/// pipe has no links), whose writer's close kqueue never reports.
	#[cfg(target_vendor = "apple")]
	fn is_named_fifo(fd: BorrowedFd<'_>) -> bool {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` is valid for writes of one `struct stat`; `fd` is
		// borrowed from a live descriptor for the call.
		if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
			return false;
		}
		// SAFETY: a successful `fstat` filled the whole struct.
		let stat = unsafe { stat.assume_init() };
		stat.st_mode & libc::S_IFMT == libc::S_IFIFO && stat.st_nlink > 0
	}

	/// Every other platform's reactor reports a FIFO's end of input.
	#[cfg(not(target_vendor = "apple"))]
	const fn is_named_fifo(_fd: BorrowedFd<'_>) -> bool {
		false
	}

	/// Whether a read of `fd` would not block (data, end of input or an error
	/// is pending), checked without waiting.
	fn readable_now(fd: BorrowedFd<'_>) -> io::Result<bool> {
		loop {
			match pi_vfs::readable_within(fd, Duration::ZERO) {
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				result => return result,
			}
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::*;

	/// Reading a pipe on a current-thread runtime waits for its writer
	/// without holding the only thread.
	#[tokio::test(flavor = "current_thread")]
	async fn pipe_read_to_end_waits_for_a_later_writer() {
		let (reader, mut writer) = std::io::pipe().unwrap();
		let mut source = Source::inherited(&OpenFile::from(reader)).unwrap();
		let mut bytes = Vec::new();
		let read = source.read_to_end(&mut bytes, usize::MAX);
		let write = async {
			tokio::task::yield_now().await;
			writer.write_all(b"late").unwrap();
			drop(writer);
		};
		let (count, ()) = tokio::join!(read, write);
		assert_eq!(count.unwrap(), 4);
		assert_eq!(bytes, b"late");
	}

	/// Past the limit the read fails and keeps what fits.
	#[tokio::test(flavor = "current_thread")]
	async fn read_to_end_stops_at_the_limit() {
		let (reader, mut writer) = std::io::pipe().unwrap();
		writer.write_all(b"abcdef").unwrap();
		drop(writer);
		let mut source = Source::inherited(&OpenFile::from(reader)).unwrap();
		let mut bytes = Vec::new();
		let error = source.read_to_end(&mut bytes, 4).await.unwrap_err();
		assert_eq!(error.kind(), io::ErrorKind::OutOfMemory);
		assert_eq!(bytes, b"abcd");
	}

	/// A FIFO opens without a writer and reads what one sends later.
	#[tokio::test(flavor = "current_thread")]
	async fn fifo_opens_without_waiting_for_a_writer() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("fifo");
		let fs = pi_vfs::Fs::native();
		fs.make_node(&path, pi_vfs::NodeKind::Fifo, 0o600).await.unwrap();
		let mut source = Source::open(&fs, &path).await.unwrap();
		let mut bytes = Vec::new();
		let read = source.read_to_end(&mut bytes, usize::MAX);
		let write = async {
			tokio::task::yield_now().await;
			let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
			writer.write_all(b"fifo").unwrap();
		};
		let (count, ()) = tokio::join!(read, write);
		assert_eq!(count.unwrap(), 4);
		assert_eq!(bytes, b"fifo");
	}

	/// A gated write to a pipe takes no more than a writable pipe is sure to
	/// take, and waits for room for the rest. Here a page and one byte were
	/// read from a full pipe, which then has 4,097 bytes free, and the write
	/// is of 4,098. Linux counts room in pages: the pipe takes 4,096 (the
	/// second page stays until it is read to its end). gVisor counts bytes:
	/// it takes 4,097 and refuses the rest. On both, what is left waits for
	/// room, and a blocking write of all 4,098 would wait for it on the
	/// runtime's only thread, which the reader below needs. The reader reads
	/// once the write put bytes in the pipe (`FIONREAD` above what the fill
	/// left). The bound runs on a thread of its own.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	#[test]
	fn a_gated_write_takes_no_more_than_a_writable_pipe_takes() {
		use std::{
			os::fd::AsRawFd,
			sync::mpsc::{RecvTimeoutError, channel},
			time::{Duration, Instant},
		};

		/// The bytes in the pipe `reader` reads.
		fn queued(reader: &std::io::PipeReader) -> usize {
			let mut queued: libc::c_int = 0;
			// SAFETY: `FIONREAD` writes one `c_int` through the pointer, which
			// is valid for the call; `reader` owns the fd.
			let status = unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &raw mut queued) };
			assert_eq!(status, 0, "FIONREAD: {}", std::io::Error::last_os_error());
			usize::try_from(queued).expect("FIONREAD counted fewer than no bytes")
		}

		let (mut reader, writer) = std::io::pipe().unwrap();
		let writer = OwnedFd::from(writer);
		// SAFETY: `F_GETPIPE_SZ` takes no argument; `writer` owns the fd.
		let capacity = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETPIPE_SZ) };
		let capacity = usize::try_from(capacity).expect("F_GETPIPE_SZ");
		assert!(capacity >= 2 * 4096, "a pipe of {capacity} bytes holds no second page");
		std::fs::File::from(writer.try_clone().unwrap())
			.write_all(&vec![b'q'; capacity])
			.unwrap();
		reader.read_exact(&mut [0; 4097]).unwrap();
		let (done, finished) = channel::<()>();
		std::thread::spawn(move || {
			if finished.recv_timeout(Duration::from_secs(5)) == Err(RecvTimeoutError::Timeout) {
				// Straight to fd 2: libtest's capture takes `eprintln!`
				// in this thread too, and `exit` drops what it took.
				let line = format!(
					"DEADLINE fired: the gated write to a pipe of {capacity} bytes did not finish within 5s\n"
				);
				let _ = std::io::stderr().write_all(line.as_bytes());
				std::process::exit(1);
			}
		});
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		runtime.block_on(async {
			let descriptor = descriptor::Descriptor::gated(writer).unwrap();
			let write = descriptor.write_all(&[b'x'; 4098]);
			let drain = async {
				let start = Instant::now();
				while queued(&reader) <= capacity - 4097 {
					assert!(start.elapsed() < Duration::from_secs(4), "the write put nothing in the pipe");
					tokio::time::sleep(Duration::from_millis(1)).await;
				}
				// Only what the fill left, which is in the pipe whatever the
				// write did: this read does not wait.
				reader.read_exact(&mut vec![0; capacity - 4097]).unwrap();
			};
			let (written, ()) = tokio::join!(write, drain);
			written.unwrap();
		});
		drop(done);
	}

	/// A descriptor whose private reopen failed (a pipe of another user, no
	/// `/proc`, a socket) writes on the blocking pool. A drain of many
	/// chunks must finish while the reader keeps up: a wait for an
	/// edge-triggered writability edge after each write would depend on an
	/// edge the kernel need not send. The bound runs on a thread of its own.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drain_without_a_private_reopen_finishes_while_the_reader_keeps_up() {
		use std::{
			sync::mpsc::{RecvTimeoutError, channel},
			time::Duration,
		};

		const TOTAL: usize = 64 * 4096;
		let (mut reader, writer) = std::io::pipe().unwrap();
		let reading = std::thread::spawn(move || {
			let mut all = Vec::new();
			reader.read_to_end(&mut all).unwrap();
			all.len()
		});
		let (done, finished) = channel::<()>();
		std::thread::spawn(move || {
			if finished.recv_timeout(Duration::from_secs(10)) == Err(RecvTimeoutError::Timeout) {
				// Straight to fd 2, past libtest's capture (see above).
				let line = "DEADLINE fired: a drain without a private reopen did not finish within 10s\n";
				let _ = std::io::stderr().write_all(line.as_bytes());
				std::process::exit(1);
			}
		});
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		runtime.block_on(async {
			let descriptor = descriptor::Descriptor::gated_without_reopen(OwnedFd::from(writer)).unwrap();
			for chunk in vec![b'x'; TOTAL].chunks(4096) {
				descriptor.write_all(chunk).await.unwrap();
			}
		});
		drop(runtime);
		assert_eq!(reading.join().unwrap(), TOTAL);
		drop(done);
	}

	/// Only a pipe or FIFO is reopened through `/proc/self/fd`: a device's
	/// open runs again on a reopen, and `/dev/ptmx` then makes a new pty
	/// pair. So the descriptor `Descriptor::gated` registers for a pty
	/// master must be that master's own pty (`TIOCGPTN` gives the same
	/// number); a reopen holds a new one.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_terminal_descriptor_is_not_reopened() {
		use std::os::fd::{AsFd as _, AsRawFd as _, BorrowedFd, FromRawFd};

		let number = |fd: BorrowedFd<'_>| {
			let mut number: libc::c_uint = 0;
			// SAFETY: `TIOCGPTN` writes one `c_uint` through the pointer, which
			// is valid for the call; `fd` is borrowed from a live descriptor.
			let status = unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCGPTN, &raw mut number) };
			assert_eq!(status, 0, "TIOCGPTN: {}", io::Error::last_os_error());
			number
		};
		// SAFETY: plain call; returns a new fd or -1, checked below.
		let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
		assert!(master >= 0, "posix_openpt: {}", io::Error::last_os_error());
		// SAFETY: `master` is a fresh fd this test owns from here on.
		let master = unsafe { OwnedFd::from_raw_fd(master) };
		let pty = number(master.as_fd());
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		let descriptor = runtime
			.block_on(async { descriptor::Descriptor::gated(master) })
			.unwrap_or_else(|_| panic!("a pty master registers with the reactor"));
		assert_eq!(
			number(descriptor.as_fd()),
			pty,
			"Descriptor::gated reopened the pty master: it holds a new pty"
		);
	}

	/// A dup that fails (`EMFILE` near the descriptor limit) for a
	/// descriptor whose writes go on the blocking pool is that write's
	/// error: the write never falls back to a blocking write on the
	/// runtime's thread. The pipe is full and nothing reads it, so such a
	/// write would never return. The bound runs on the calling thread.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_failed_dup_for_blocking_writes_is_the_writes_error() {
		use std::{
			os::fd::AsRawFd as _,
			sync::mpsc::{RecvTimeoutError, channel},
			time::Duration,
		};

		let (reader, writer) = std::io::pipe().unwrap();
		// SAFETY: `F_GETPIPE_SZ` takes no argument; `writer` owns the fd.
		let capacity = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETPIPE_SZ) };
		let capacity = usize::try_from(capacity).expect("F_GETPIPE_SZ");
		std::fs::File::from(OwnedFd::from(writer.try_clone().unwrap()))
			.write_all(&vec![b'q'; capacity])
			.unwrap();
		let (tx, rx) = channel();
		std::thread::spawn(move || {
			descriptor::NO_REOPEN.set(true);
			descriptor::DUP_FAILS.set(true);
			let runtime = tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.unwrap();
			let result = runtime.block_on(async {
				let file = OpenFile::from(std::fs::File::from(OwnedFd::from(writer)));
				let mut native = Native::open(&file, false);
				native.write_all(b"x".to_vec()).await.1
			});
			let _ = tx.send(result);
		});
		match rx.recv_timeout(Duration::from_secs(5)) {
			Ok(result) => assert_eq!(
				result.as_ref().err().and_then(io::Error::raw_os_error),
				Some(libc::EMFILE),
				"{result:?}"
			),
			Err(RecvTimeoutError::Timeout) => {
				panic!("DEADLINE fired: the write waited in the kernel on the runtime's thread")
			},
			Err(e) => panic!("{e}"),
		}
		drop(reader);
	}

	/// A descriptor that can block but cannot be duplicated to register it
	/// (`EMFILE`) writes on the blocking pool: on a current-thread runtime a
	/// write to a full pipe nothing reads leaves the runtime's thread free
	/// (its timers fire while the pool's thread is seen asleep in that write),
	/// and ends with the pipe's error once the reader leaves. A write on the
	/// runtime's thread would hold it for good; the bound runs on the calling
	/// thread.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_descriptor_that_cannot_be_registered_writes_on_the_blocking_pool() {
		use std::{
			os::fd::AsRawFd as _,
			sync::mpsc::{RecvTimeoutError, channel},
			time::{Duration, Instant},
		};

		/// The name of the runtime's blocking-pool threads.
		const POOL: &str = "unregistered-wr";

		/// Whether a blocking-pool thread of this test's runtime is asleep
		/// (`S` in procfs), with its tid.
		fn pool_thread_asleep() -> Option<String> {
			std::fs::read_dir("/proc/self/task").expect("/proc/self/task").flatten().find_map(|task| {
				let comm = std::fs::read_to_string(task.path().join("comm")).ok()?;
				let stat = std::fs::read_to_string(task.path().join("stat")).ok()?;
				let state = stat.rsplit_once(") ")?.1.split(' ').next()?;
				(comm.trim() == POOL && state == "S").then(|| task.file_name().to_string_lossy().into_owned())
			})
		}

		/// Until the pool's thread is seen asleep on two polls in a row: the
		/// write is its only work, so it sleeps in that write to the full
		/// pipe. Polled on the runtime's own thread, whose timers fire only
		/// while the write leaves that thread free.
		async fn asleep_in_the_write() {
			let start = Instant::now();
			let mut asleep = None;
			loop {
				let now = pool_thread_asleep();
				if now.is_some() && now == asleep {
					return;
				}
				asleep = now;
				assert!(
					start.elapsed() < Duration::from_secs(8),
					"the write was never seen waiting on the blocking pool"
				);
				tokio::time::sleep(Duration::from_millis(1)).await;
			}
		}

		let (reader, writer) = std::io::pipe().unwrap();
		// SAFETY: `F_GETPIPE_SZ` takes no argument; `writer` owns the fd.
		let capacity = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETPIPE_SZ) };
		let capacity = usize::try_from(capacity).expect("F_GETPIPE_SZ");
		std::fs::File::from(OwnedFd::from(writer.try_clone().unwrap()))
			.write_all(&vec![b'q'; capacity])
			.unwrap();
		let (tx, rx) = channel();
		std::thread::spawn(move || {
			descriptor::OPEN_DUP_FAILS.set(true);
			let runtime = tokio::runtime::Builder::new_current_thread()
				.thread_name(POOL)
				.enable_all()
				.build()
				.unwrap();
			let result = runtime.block_on(async {
				let file = OpenFile::from(std::fs::File::from(OwnedFd::from(writer)));
				let mut native = Native::open(&file, false);
				assert!(matches!(native, Native::Blocking(_)), "not the blocking-pool route");
				let write = native.write_all(b"x".to_vec());
				tokio::pin!(write);
				tokio::select! {
					_ = &mut write => panic!("a write to a full pipe nothing reads returned"),
					() = asleep_in_the_write() => {},
				}
				drop(reader);
				write.await.1
			});
			let _ = tx.send(result);
		});
		match rx.recv_timeout(Duration::from_secs(10)) {
			Ok(result) => assert_eq!(
				result.as_ref().err().map(io::Error::kind),
				Some(io::ErrorKind::BrokenPipe),
				"{result:?}"
			),
			Err(RecvTimeoutError::Timeout) => {
				panic!("DEADLINE fired: the write waited in the kernel on the runtime's thread")
			},
			Err(RecvTimeoutError::Disconnected) => {
				panic!("the runtime's thread panicked before it sent the write's result; its message is above")
			},
		}
	}
}

