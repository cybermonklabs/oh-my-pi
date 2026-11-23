//! Engine file descriptors: refcounted fd objects shared by `dup`, subshell
//! fd tables and host callouts.

use std::{
	fmt, io,
	sync::{
		Arc,
		atomic::{AtomicU8, Ordering},
	},
	task::{Context, Poll},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::{File, FileKind, Mark},
	host::{OsHandle, StdFd},
	mem::MemFile,
};

/// Shared handle to one engine fd object.
///
/// Handed to hosts in [`ToolCall::stdio`](crate::bash::ToolCall::stdio) and
/// [`Invocation::stdio`](crate::bash::Invocation::stdio) so a callout or native
/// task reads and writes the same object the shell does (a pipe, a redirected
/// file, the shell's own stdout). Every operation is non-blocking; poll with
/// the waker of the task doing the I/O. `Send + Sync`.
#[derive(Clone)]
pub struct FdRef(Arc<FdObj>);

const _: () = assert!(size_of::<FdRef>() == size_of::<usize>(), "FdRef must remain one thin Arc");

/// Internal flag: a trace-only wrapper, never a persisted descriptor flag.
const OUTPUT_TAGGED: u8 = 1 << 7;

pub struct FdObj {
	state:  Mutex<FdState>,
	origin: FdOrigin,
	/// [`FdFlags`] bits.
	flags:  AtomicU8,
}

/// Per-descriptor flags of an fd object ([`FdRef::flags`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FdFlags(u8);

impl FdFlags {
	/// Close on exec (`FD_CLOEXEC`): externals do not inherit it (zsh
	/// `sysopen -o cloexec`, `zsystem flock` without `-e`).
	pub const CLOEXEC: Self = Self(1);
	/// Holds a `zsystem flock` lock (zsh `FDT_FLOCK`): `zsystem flock -u`
	/// closes only such fds.
	pub const FLOCK: Self = Self(1 << 1);
	/// No flag.
	pub const NONE: Self = Self(0);

	/// Union of two flag sets.
	#[must_use]
	pub const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Whether every flag of `other` is set.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}
}

enum FdState {
	Open(Box<dyn File>),
	/// Allocated only for an observed final-capture handle. Neither the
	/// ordinary fd object nor its thin public handle carries an inline tag.
	Tagged(Box<TaggedOutput>),
	/// An engine memory object (pipe end, document, capture): it keeps its
	/// type so externalize can image it and restore rebuild it.
	Mem(MemFile),
	/// The object could not survive a restore: reads hit EOF, writes `EBADF`.
	Lost,
	Closed,
}

/// Where an fd object came from; decides how it is rebuilt by `restore`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FdOrigin {
	/// The shell's own standard stream, re-acquired with
	/// [`Host::stdio`](crate::bash::Host::stdio).
	Std(StdFd),
	/// A host-supplied file (per-run stdio, a redirection target); lost on
	/// restore.
	Host,
	/// An in-memory object (pipe, here-document, capture); imaged by
	/// externalize and rebuilt by restore.
	Mem,
	/// No object.
	Closed,
}

/// Error of I/O on a closed or lost fd (`EBADF`).
#[derive(Debug, thiserror::Error)]
#[error("Bad file descriptor")]
pub struct BadFd;

fn bad_fd() -> io::Error {
	io::Error::other(BadFd)
}

impl FdState {
	fn file(&mut self) -> Option<&mut dyn File> {
		match self {
			Self::Open(f) => Some(f.as_mut()),
			Self::Tagged(f) => Some(f.as_mut()),
			Self::Mem(m) => Some(m as &mut dyn File),
			Self::Lost | Self::Closed => None,
		}
	}

	fn file_ref(&self) -> Option<&dyn File> {
		match self {
			Self::Open(f) => Some(f.as_ref()),
			Self::Tagged(f) => Some(f.as_ref()),
			Self::Mem(m) => Some(m as &dyn File),
			Self::Lost | Self::Closed => None,
		}
	}
}

impl FdRef {
	pub(crate) fn open(file: Box<dyn File>, origin: FdOrigin) -> Self {
		Self(Arc::new(FdObj {
			state: Mutex::new(FdState::Open(file)),
			origin,
			flags: AtomicU8::new(0),
		}))
	}

	/// An fd for an engine memory object.
	pub(crate) fn mem(file: impl Into<MemFile>) -> Self {
		Self(Arc::new(FdObj {
			state:  Mutex::new(FdState::Mem(file.into())),
			origin: FdOrigin::Mem,
			flags:  AtomicU8::new(0),
		}))
	}

	/// Identity of the fd object (shared by every slot holding this handle).
	pub(crate) fn key(&self) -> usize {
		if self.is_tagged() {
			return self.untagged().key();
		}
		Arc::as_ptr(&self.0).addr()
	}

	/// `f` applied to the memory object this fd holds, if it holds one.
	pub(crate) fn with_mem<R>(&self, f: impl FnOnce(&MemFile) -> R) -> Option<R> {
		match &*self.0.state.lock() {
			FdState::Mem(m) => Some(f(m)),
			FdState::Open(_) | FdState::Tagged(_) | FdState::Lost | FdState::Closed => None,
		}
	}

	/// A handle on a host file outside any shell, for tests that hand engine
	/// objects to a host directly (the sys spawner's pump tests).
	pub fn from_file(file: Box<dyn File>) -> Self {
		Self::open(file, FdOrigin::Host)
	}

	pub(crate) fn closed() -> Self {
		Self(Arc::new(FdObj {
			state:  Mutex::new(FdState::Closed),
			origin: FdOrigin::Closed,
			flags:  AtomicU8::new(0),
		}))
	}

	pub(crate) fn lost(origin: FdOrigin) -> Self {
		Self(Arc::new(FdObj { state: Mutex::new(FdState::Lost), origin, flags: AtomicU8::new(0) }))
	}

	/// A handle that does not keep the object alive: whether some fd still
	/// holds it ([`FdWeak::is_alive`]).
	pub(crate) fn downgrade(&self) -> FdWeak {
		if self.is_tagged() {
			return self.untagged().downgrade();
		}
		FdWeak(Arc::downgrade(&self.0))
	}

	/// The descriptor flags ([`FdFlags`]); none unless set with
	/// [`Self::set_flags`].
	pub fn flags(&self) -> FdFlags {
		let flags = self.0.flags.load(Ordering::Relaxed);
		if flags & OUTPUT_TAGGED != 0 {
			return self.untagged().flags();
		}
		FdFlags(flags)
	}

	/// Replace the descriptor flags.
	pub fn set_flags(&self, flags: FdFlags) {
		if self.is_tagged() {
			self.untagged().set_flags(flags);
		} else {
			self.0.flags.store(flags.0, Ordering::Relaxed);
		}
	}

	pub(crate) fn origin(&self) -> FdOrigin {
		self.0.origin
	}

	/// Reposition (`read` gives back what it over-read on seekable files).
	pub fn seek(&self, pos: crate::bash::fs::SeekFrom) -> io::Result<u64> {
		match self.0.state.lock().file() {
			Some(f) => f.seek(pos),
			None => Err(bad_fd()),
		}
	}

	/// Put `bytes` back in front of this object's unread data: a host read
	/// them out for an external that exited without consuming them
	/// (`crate::sys`'s shared input feeds), so the next reader (another
	/// external, a builtin) sees them as with one kernel pipe. A memory
	/// pipe's read end pushes them ahead of what it buffers (beyond its
	/// capacity if need be) and wakes its waiters; another seekable object
	/// seeks back by their length.
	///
	/// # Errors
	///
	/// `Unsupported` (or the object's seek error) for any other object, and
	/// `EBADF` for a closed or lost one: the bytes are lost.
	pub fn unread(&self, bytes: &[u8]) -> io::Result<()> {
		if bytes.is_empty() {
			return Ok(());
		}
		let mut state = self.0.state.lock();
		if let FdState::Mem(MemFile::PipeRead(r)) = &*state {
			r.unread(bytes);
			return Ok(());
		}
		let back =
			i64::try_from(bytes.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		match state.file() {
			Some(f) => f.seek(crate::bash::fs::SeekFrom::Current(-back)).map(drop),
			None => Err(bad_fd()),
		}
	}

	/// A new handle to a duplicate of the underlying object (a pipe end
	/// keeps the pipe open while any duplicate lives).
	pub fn dup(&self) -> io::Result<Self> {
		match &*self.0.state.lock() {
			FdState::Open(f) => Ok(Self::open(f.dup()?, self.0.origin)),
			FdState::Tagged(f) => Ok(f.base.dup()?.with_tag(f.tag)),
			FdState::Mem(m) => Ok(Self::mem(m.dup_end())),
			FdState::Lost | FdState::Closed => Err(bad_fd()),
		}
	}

	/// Whether two handles refer to the same fd object.
	pub fn same(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
			|| ((self.is_tagged() || other.is_tagged()) && self.key() == other.key())
	}

	/// Read into `buf`; `Ok(0)` at end of file (also for closed or lost fds).
	pub fn poll_read(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_read(cx, buf),
			None => Poll::Ready(Ok(0)),
		}
	}

	/// Write a prefix of `buf`; closed and lost fds fail with "Bad file
	/// descriptor".
	pub fn poll_write(&self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_write(cx, buf),
			None => Poll::Ready(Err(bad_fd())),
		}
	}

	/// [`Self::poll_read`] for a host task that may wait beside the engine
	/// and other tasks on this object: `key`, which the task's future holds,
	/// keeps its wait apart ([`File::poll_read_keyed`]).
	pub fn poll_read_keyed(
		&self,
		cx: &mut Context<'_>,
		buf: &mut [u8],
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_read_keyed(cx, buf, key),
			None => Poll::Ready(Ok(0)),
		}
	}

	/// [`Self::poll_write`] for a writer that may wait beside others, as
	/// [`Self::poll_read_keyed`]. A chunk a writer thread took is not
	/// settled here: a writer that needs its error writes with
	/// [`Self::poll_write_out_keyed`].
	pub fn poll_write_keyed(
		&self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<usize>> {
		self
			.poll_write_marked_keyed(cx, bytes, key)
			.map_ok(|(n, _)| n)
	}

	/// [`Self::poll_write_keyed`] with the mark of the chunk a writer thread
	/// took ([`File::poll_write_keyed`]); the caller settles it.
	pub fn poll_write_marked_keyed(
		&self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		self.write_keyed(cx, bytes, None, key)
	}

	/// [`Self::poll_write_marked_keyed`] attributed to `tag`.
	fn write_keyed(
		&self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		tag: Option<crate::bash::ids::CmdTag>,
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_write_keyed(cx, bytes, tag, key),
			None => Poll::Ready(Err(bad_fd())),
		}
	}

	/// Attribute successful visible writes to `tag` using a trace-only heap
	/// wrapper. Non-observed handles are returned unchanged; retagging
	/// replaces rather than nests wrappers. Shared-description identity,
	/// flags and contents remain those of the underlying capture.
	#[must_use]
	pub fn with_tag(self, tag: crate::bash::ids::CmdTag) -> Self {
		if self.is_tagged() {
			let base = {
				let state = self.0.state.lock();
				let FdState::Tagged(output) = &*state else {
					unreachable!("tagged fd state")
				};
				if output.tag == tag {
					return self.clone();
				}
				output.base.clone()
			};
			return base.with_tag(tag);
		}
		if !self.observes_output() {
			return self;
		}
		let origin = self.0.origin;
		Self(Arc::new(FdObj {
			state: Mutex::new(FdState::Tagged(Box::new(TaggedOutput { base: self, tag }))),
			origin,
			flags: AtomicU8::new(OUTPUT_TAGGED),
		}))
	}

	fn is_tagged(&self) -> bool {
		self.0.flags.load(Ordering::Relaxed) & OUTPUT_TAGGED != 0
	}

	fn untagged(&self) -> Self {
		if !self.is_tagged() {
			return self.clone();
		}
		let state = self.0.state.lock();
		let FdState::Tagged(output) = &*state else {
			unreachable!("tagged fd state")
		};
		output.base.clone()
	}

	/// [`Self::poll_write_marked`] with a known execution identity, without
	/// allocating a handle.
	pub fn poll_write_tagged(
		&self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		tag: crate::bash::ids::CmdTag,
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		match self.0.state.lock().file() {
			Some(file) => file.poll_write_tagged(cx, bytes, Some(tag)),
			None => Poll::Ready(Err(bad_fd())),
		}
	}

	/// Whether this descriptor leads to an observed visible run stream.
	pub fn observes_output(&self) -> bool {
		self
			.0
			.state
			.lock()
			.file_ref()
			.is_some_and(File::observes_output)
	}

	/// Opaque identity of the final visible output stream, when observed.
	pub fn output_key(&self) -> Option<(usize, i32)> {
		self.0.state.lock().file_ref().and_then(File::output_key)
	}

	/// Flush buffered writes.
	pub fn poll_flush(&self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_flush(cx),
			None => Poll::Ready(Ok(())),
		}
	}

	/// Wait until the writes the file took are out ([`File::poll_settle`]).
	pub fn poll_settle(&self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_settle(cx),
			None => Poll::Ready(Ok(())),
		}
	}

	/// Write a prefix of `buf`, with its chunk's [`Mark`]
	/// ([`File::poll_write_marked`]).
	pub fn poll_write_marked(
		&self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_write_marked(cx, buf),
			None => Poll::Ready(Err(bad_fd())),
		}
	}

	/// Wait until this writer's chunks are out, with their first error
	/// ([`File::poll_settle_marked`]).
	pub fn poll_settle_marked(&self, cx: &mut Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_settle_marked(cx, marks),
			None => Poll::Ready(Ok(())),
		}
	}

	/// A write that is done only once its bytes are out of the shell: in the
	/// kernel, or failed with the write's error. It is
	/// [`Self::poll_write_marked`], then [`Self::poll_settle_marked`] of the
	/// chunk a writer thread took, which `unsettled` keeps while it is
	/// `Pending`; the caller polls again through this fd from the same
	/// offset (it counts nothing written), and the chunk is settled and
	/// counted before anything else goes. For a writer that polls a write to
	/// its end: each chunk is out before the next one goes, and the last one
	/// before the write is done, so what runs next comes after it.
	pub fn poll_write_out(
		&self,
		cx: &mut Context<'_>,
		buf: &[u8],
		unsettled: &mut Unsettled,
	) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => unsettled.poll_write_file(f, cx, buf),
			// Closed since its chunk was taken: that chunk is the thread's.
			None => Poll::Ready(unsettled.0.take().map(|(n, _)| n).ok_or_else(bad_fd)),
		}
	}

	/// [`Self::poll_write_out`] as the writer `key` names
	/// ([`File::poll_write_keyed`]): a write part way keeps its progress by
	/// its key (a provider file), and the write is done only once its bytes
	/// are out of the shell.
	pub fn poll_write_out_keyed(
		&self,
		cx: &mut Context<'_>,
		buf: &[u8],
		unsettled: &mut Unsettled,
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => unsettled.poll_write_file_keyed(f, cx, buf, key),
			// Closed since its chunk was taken: that chunk is the thread's.
			None => Poll::Ready(unsettled.0.take().map(|(n, _)| n).ok_or_else(bad_fd)),
		}
	}

	/// [`Self::poll_flush`] for a host task that may wait beside others, as
	/// [`Self::poll_read_keyed`] ([`File::poll_flush_keyed`]).
	pub fn poll_flush_keyed(
		&self,
		cx: &mut Context<'_>,
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<()>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_flush_keyed(cx, key),
			None => Poll::Ready(Ok(())),
		}
	}

	/// Kind of the underlying object; `None` when closed or lost.
	pub fn kind(&self) -> Option<FileKind> {
		self.0.state.lock().file_ref().map(File::kind)
	}

	/// `fstat(2)` of the underlying object ([`File::stat`]); `None` when
	/// closed, lost or an engine-memory object.
	pub fn stat(&self) -> Option<io::Result<crate::bash::fs::Stat>> {
		self.0.state.lock().file_ref().map(File::stat)
	}

	/// OS handle an external can inherit directly.
	pub fn os_handle(&self) -> Option<OsHandle> {
		self.inheritable(|f| f.os_handle())
	}

	/// [`Self::os_handle`] for an external's output
	/// ([`File::os_output_handle`]).
	pub fn os_output_handle(&self) -> Option<OsHandle> {
		self.inheritable(|f| f.os_output_handle())
	}

	/// `handle` of the object, unless the engine observes its output.
	fn inheritable(&self, handle: impl FnOnce(&dyn File) -> Option<OsHandle>) -> Option<OsHandle> {
		self.0.state.lock().file_ref().and_then(
			|f| {
				if f.observes_output() { None } else { handle(f) }
			},
		)
	}

	/// Whether the object is a command substitution's capture, whose bytes
	/// the engine takes as shell text.
	pub fn is_capture(&self) -> bool {
		matches!(&*self.0.state.lock(), FdState::Mem(MemFile::Capture(_)))
	}

	/// Whether the object is usable (not closed, not lost).
	pub fn is_open(&self) -> bool {
		matches!(&*self.0.state.lock(), FdState::Open(_) | FdState::Tagged(_) | FdState::Mem(_))
	}
}

/// The chunk of a [`FdRef::poll_write_out`] that a writer thread took and
/// that has not settled yet: its length and its [`Mark`]. Live state of one
/// host file: not saved, and not part of any value it sits in.
#[derive(Clone, Debug, Default)]
pub struct Unsettled(Option<(usize, Mark)>);

impl PartialEq for Unsettled {
	fn eq(&self, _: &Self) -> bool {
		true
	}
}

impl Eq for Unsettled {}

impl Unsettled {
	/// Give up the chunk a writer thread took, with its length: the thread
	/// still writes it, in order, before anything else handed to it, but its
	/// result is no longer this writer's to settle. A writer that hands what
	/// is left of its bytes to another writer drops the front this many
	/// bytes first, which the thread has.
	pub fn forget(&mut self) -> usize {
		self.0.take().map_or(0, |(n, _)| n)
	}

	/// [`FdRef::poll_write_out`] for a file not in the fd table (a history
	/// file the `history` builtin opened): the chunk `file`'s writer thread
	/// took is settled, with its error, before it is counted.
	pub fn poll_write_file(
		&mut self,
		file: &mut dyn File,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<usize>> {
		self.poll_with(file, cx, |file, cx| file.poll_write_marked(cx, buf))
	}

	/// [`Self::poll_write_file`] as the writer `key` names
	/// ([`File::poll_write_keyed`]).
	pub fn poll_write_file_keyed(
		&mut self,
		file: &mut dyn File,
		cx: &mut Context<'_>,
		buf: &[u8],
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<usize>> {
		self.poll_with(file, cx, |file, cx| file.poll_write_keyed(cx, buf, None, key))
	}

	/// Write with `write` unless a chunk is still unsettled, then settle the
	/// chunk a writer thread took, with its error, before it is counted.
	fn poll_with(
		&mut self,
		file: &mut dyn File,
		cx: &mut Context<'_>,
		write: impl FnOnce(&mut dyn File, &mut Context<'_>) -> Poll<io::Result<(usize, Option<Mark>)>>,
	) -> Poll<io::Result<usize>> {
		if self.0.is_none() {
			match std::task::ready!(write(file, cx)) {
				Ok((n, Some(mark))) => self.0 = Some((n, mark)),
				other => return Poll::Ready(other.map(|(n, _)| n)),
			}
		}
		let (n, mark) = self.0.as_ref().expect("set above");
		let settled = std::task::ready!(file.poll_settle_marked(cx, std::slice::from_ref(mark)));
		let n = *n;
		self.0 = None;
		Poll::Ready(settled.map(|()| n))
	}
}

/// Trace-only forwarding descriptor. Its base is always an unwrapped
/// visible capture, so retagging cannot build a chain of wrappers.
struct TaggedOutput {
	base: FdRef,
	tag:  crate::bash::ids::CmdTag,
}

impl File for TaggedOutput {
	fn poll_read(&mut self, cx: &mut Context<'_>, bytes: &mut [u8]) -> Poll<io::Result<usize>> {
		self.base.poll_read(cx, bytes)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
		self.poll_write_marked(cx, bytes).map_ok(|(n, _)| n)
	}

	/// The base's tagged write: the chunk's mark is the base's, which the
	/// writer settles through this fd.
	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		bytes: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		self.base.poll_write_tagged(cx, bytes, self.tag)
	}

	fn poll_write_tagged(
		&mut self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		tag: Option<crate::bash::ids::CmdTag>,
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		self
			.base
			.poll_write_tagged(cx, bytes, tag.unwrap_or(self.tag))
	}

	fn poll_read_keyed(
		&mut self,
		cx: &mut Context<'_>,
		bytes: &mut [u8],
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<usize>> {
		self.base.poll_read_keyed(cx, bytes, key)
	}

	fn poll_write_keyed(
		&mut self,
		cx: &mut Context<'_>,
		bytes: &[u8],
		tag: Option<crate::bash::ids::CmdTag>,
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		self
			.base
			.write_keyed(cx, bytes, Some(tag.unwrap_or(self.tag)), key)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.base.poll_flush(cx)
	}

	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.base.poll_settle(cx)
	}

	fn poll_settle_marked(&mut self, cx: &mut Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>> {
		self.base.poll_settle_marked(cx, marks)
	}

	fn poll_flush_keyed(
		&mut self,
		cx: &mut Context<'_>,
		key: &mut crate::sys::WaitKey,
	) -> Poll<io::Result<()>> {
		self.base.poll_flush_keyed(cx, key)
	}

	fn seek(&mut self, pos: crate::bash::fs::SeekFrom) -> io::Result<u64> {
		self.base.seek(pos)
	}

	fn kind(&self) -> FileKind {
		self.base.kind().unwrap_or(FileKind::Device)
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn stat(&self) -> io::Result<crate::bash::fs::Stat> {
		self
			.base
			.stat()
			.unwrap_or_else(|| Err(io::ErrorKind::Unsupported.into()))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self { base: self.base.dup()?, tag: self.tag }))
	}

	fn observes_output(&self) -> bool {
		true
	}

	fn output_key(&self) -> Option<(usize, i32)> {
		self.base.output_key()
	}
}

/// A non-owning [`FdRef`] ([`FdRef::downgrade`]).
#[derive(Clone)]
pub struct FdWeak(std::sync::Weak<FdObj>);

impl FdWeak {
	/// Whether any fd table (or other holder) still has the object.
	pub fn is_alive(&self) -> bool {
		self.0.strong_count() > 0
	}

	/// Whether it is a handle to the same object as `r`.
	pub fn is(&self, r: &FdRef) -> bool {
		self.0.as_ptr().addr() == r.key()
	}
}

impl fmt::Debug for FdRef {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("FdRef")
			.field("origin", &self.0.origin)
			.field("open", &self.is_open())
			.finish()
	}
}

/// Per-vproc fd table.
#[derive(Clone, Debug, Default)]
pub struct FdTable {
	slots: Vec<Option<FdRef>>,
}

const _: () = assert!(
	size_of::<FdTable>() == size_of::<Vec<Option<FdRef>>>(),
	"FdTable must not inline tracing state"
);

impl FdTable {
	/// Bind only observed final-capture slots to this execution. Tags live
	/// in trace-only heap wrappers, never inline in an idle vproc/table.
	pub(crate) fn set_command_tag(&mut self, tag: Option<crate::bash::ids::CmdTag>) {
		for slot in self.slots.iter_mut().flatten() {
			if let Some(tag) = tag {
				if slot.observes_output() {
					*slot = slot.clone().with_tag(tag);
				}
			} else if slot.is_tagged() {
				*slot = slot.untagged();
			}
		}
	}

	pub(crate) fn get(&self, fd: i32) -> Option<&FdRef> {
		usize::try_from(fd)
			.ok()
			.and_then(|i| self.slots.get(i))
			.and_then(Option::as_ref)
	}

	/// The handle for `fd`, or a closed handle.
	pub(crate) fn handle(&self, fd: i32) -> FdRef {
		self.get(fd).cloned().unwrap_or_else(FdRef::closed)
	}

	pub(crate) fn set(&mut self, fd: i32, r: Option<FdRef>) {
		let Ok(i) = usize::try_from(fd) else {
			return;
		};
		if self.slots.len() <= i {
			self.slots.resize(i + 1, None);
		}
		self.slots[i] = r;
	}

	/// Every slot, for the frames blob.
	pub(crate) fn slots(&self) -> &[Option<FdRef>] {
		&self.slots
	}

	/// The lowest closed fd ≥ `from` (`{var}>` allocates from 10).
	pub(crate) fn lowest_free(&self, from: i32) -> i32 {
		(from..i32::MAX)
			.find(|&fd| self.get(fd).is_none())
			.unwrap_or(from)
	}

	pub(crate) fn iter(&self) -> impl Iterator<Item = (i32, &FdRef)> {
		self
			.slots
			.iter()
			.enumerate()
			.filter_map(|(i, s)| s.as_ref().map(|r| (i as i32, r)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{bash::fs::test_files::FlushProbe, sys::WaitKey};

	// Failure mode: a native extra closing its handle of a traced run's
	// output flushed with its key, and the trace wrapper flushed its base
	// without it, as the engine.
	#[test]
	fn a_tagged_output_flushes_with_the_callers_key() {
		use crate::bash::ids::{RunId, Vpid};
		let probe = FlushProbe::default();
		let base = FdRef::from_file(Box::new(probe.clone()));
		let tag = crate::bash::ids::CmdTag { run: RunId(1), vpid: Vpid(1), seq: 1 };
		let mut tagged = TaggedOutput { base, tag };
		let mut key = WaitKey::default();
		let cx = &mut Context::from_waker(std::task::Waker::noop());
		assert!(matches!(tagged.poll_flush_keyed(cx, &mut key), Poll::Ready(Ok(()))));
		assert!(probe.reached_by(&key), "the base was flushed without the caller's key");
		assert_eq!(probe.keyless(), 0);
	}
}
