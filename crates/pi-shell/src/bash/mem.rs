//! In-memory fd objects: pipes between virtual processes, here-document
//! buffers and command-substitution captures.
//!
//! All are [`File`]s, so externals reach them through the host's pumps and
//! callouts through [`FdRef`](crate::bash::FdRef). None of them ever blocks: a
//! full pipe or an empty one returns `Pending` and wakes the waiters registered
//! by the other end.
//!
//! A pipe between two pipeline stages ([`stage_pipe`]) becomes an OS pipe the
//! moment an external takes one of its ends ([`MemFile::share_with_external`]):
//! two external stages then inherit the two ends of one kernel pipe, as bash's
//! and zsh's stages do, and keep exchanging bytes if the shell dies; a stage of
//! shell code reads and writes the same OS pipe through the shell's own end of
//! it, which never waits. A tapped pipe ([`tapped_pipe`]) stays in memory, so
//! its mirror sees every byte, and so does a pipe on a host without OS pipes
//! (or that declined to make one).
//!
//! An fd holds one as a [`MemFile`], which keeps its type: externalize
//! images the shared state once per object ([`MemImage`], contents inline:
//! a pipe holds at most [`PIPE_CAPACITY`] bytes) and restore rebuilds it
//! ([`MemObj`]) and hands out the ends the restored fds held. A pipe that
//! became an OS pipe has no image: its bytes are in the kernel and externals
//! hold its ends, so a snapshot reports it lost, as a host pipe.

use std::{
	collections::VecDeque,
	io,
	sync::Arc,
	task::{Context, Poll, Waker},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::{File, FileKind, SeekFrom},
	host::{OsHandle, PipeMirror},
};

/// Capacity of a [`pipe`] in bytes (bash and Linux use 64 KiB).
pub const PIPE_CAPACITY: usize = 64 << 10;

/// The shared state of a [`pipe`].
#[derive(Default)]
pub struct PipeState {
	buf:       VecDeque<u8>,
	readers:   usize,
	writers:   usize,
	/// Tasks waiting for data (readers) or room (writers).
	waiters:   Vec<Waker>,
	/// Gets a copy of every byte written ([`tapped_pipe`]); closed and
	/// dropped once the last writer or the last reader is gone. Not imaged:
	/// a restored pipe is untapped.
	mirror:    Option<Arc<dyn PipeMirror>>,
	/// A pipe between pipeline stages ([`stage_pipe`]), which an external
	/// taking one of its ends turns into an OS pipe.
	shareable: bool,
	/// The OS pipe this one became ([`MemFile::share_with_external`]): from
	/// then on `buf` holds only bytes given back to the pipe
	/// ([`PipeReader::unread`]: what a host feed held when its external
	/// ended), which come before what the OS pipe holds.
	os:        Option<OsEnds>,
	/// An external took the read end of the OS pipe while bytes waited in
	/// `buf`, so the host feeds it through a pump, which may hold bytes no
	/// later reader may overtake: from then on every external reader is fed
	/// too ([`File::os_handle`] stays `None`).
	fed:       bool,
}

/// The shell's two ends of the OS pipe a [`stage_pipe`] became
/// ([`Host::os_pipe`](crate::bash::Host::os_pipe)): each one's
/// [`File::os_handle`] is the descriptor externals inherit, and its reads and
/// writes go through a non-blocking end opened with the pipe, which every
/// engine handle of that end shares and which wakes every task waiting on it
/// once the end is ready. An end is closed with its last engine handle, so end
/// of file and `EPIPE` come from the kernel once no process holds the other
/// end, as for any pipe.
struct OsEnds {
	read:  Option<Box<dyn File>>,
	write: Option<Box<dyn File>>,
}

impl PipeState {
	/// The pipe stopped carrying bytes: no writer can add any, or no reader
	/// takes them.
	fn close_mirror(&mut self) {
		if let Some(mirror) = self.mirror.take() {
			mirror.close();
		}
	}

	fn wait(&mut self, w: &Waker) {
		if !self.waiters.iter().any(|x| x.will_wake(w)) {
			self.waiters.push(w.clone());
		}
	}

	fn wake_all(&mut self) {
		for w in self.waiters.drain(..) {
			w.wake();
		}
	}
}

/// Read end of a [`pipe`].
pub struct PipeReader(Arc<Mutex<PipeState>>);

/// Write end of a [`pipe`].
pub struct PipeWriter(Arc<Mutex<PipeState>>);

fn ends(state: PipeState) -> (PipeReader, PipeWriter) {
	let state = Arc::new(Mutex::new(PipeState { readers: 1, writers: 1, ..state }));
	(PipeReader(Arc::clone(&state)), PipeWriter(state))
}

/// A new in-memory pipe of [`PIPE_CAPACITY`] bytes.
///
/// Reads return EOF once every writer is gone; writes fail with
/// `BrokenPipe` once every reader is gone (the engine turns that into a
/// virtual `SIGPIPE`, status 141).
pub fn pipe() -> (PipeReader, PipeWriter) {
	ends(PipeState::default())
}

/// A [`pipe`] between two pipeline stages: an external that takes one of its
/// ends turns it into an OS pipe ([`MemFile::share_with_external`]).
pub fn stage_pipe() -> (PipeReader, PipeWriter) {
	ends(PipeState { shareable: true, ..PipeState::default() })
}

/// A [`pipe`] whose written bytes are also handed to `mirror`
/// ([`Host::pipe_tap`](crate::bash::Host::pipe_tap)), which is closed once the
/// last writer or the last reader is gone.
pub fn tapped_pipe(mirror: Arc<dyn PipeMirror>) -> (PipeReader, PipeWriter) {
	ends(PipeState { mirror: Some(mirror), ..PipeState::default() })
}

impl PipeReader {
	/// Push `bytes` back ahead of the buffered data (beyond the capacity if
	/// need be) and wake the waiters
	/// ([`FdRef::unread`](crate::bash::FdRef::unread), whose one caller is a
	/// host feed giving back what it held when its external ends). On a pipe
	/// that became an OS pipe they come before what the OS pipe holds, so an
	/// external that takes the read end while they wait is fed through the
	/// host's pump ([`File::os_handle`] is `None`).
	pub fn unread(&self, bytes: &[u8]) {
		let mut s = self.0.lock();
		for &b in bytes.iter().rev() {
			s.buf.push_front(b);
		}
		s.wake_all();
	}
}

impl Drop for PipeReader {
	fn drop(&mut self) {
		let mut s = self.0.lock();
		s.readers -= 1;
		if s.readers == 0 {
			s.close_mirror();
			if let Some(os) = &mut s.os {
				os.read = None;
			}
		}
		s.wake_all();
	}
}

impl Drop for PipeWriter {
	fn drop(&mut self) {
		let mut s = self.0.lock();
		s.writers -= 1;
		if s.writers == 0 {
			s.close_mirror();
			if let Some(os) = &mut s.os {
				os.write = None;
			}
		}
		s.wake_all();
	}
}

fn unsupported<T>() -> Poll<io::Result<T>> {
	Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
}

impl File for PipeReader {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		let mut s = self.0.lock();
		if s.buf.is_empty() {
			if let Some(os) = &mut s.os {
				// An OS pipe: what it holds, through the shell's end of it,
				// which stays while this handle holds the read end.
				return match &mut os.read {
					Some(end) => end.poll_read(cx, buf),
					None => Poll::Ready(Ok(0)),
				};
			}
			if s.writers == 0 {
				return Poll::Ready(Ok(0));
			}
			// A zero-length read too waits while a writer may still write:
			// it is how readiness is asked (`read -t 0`, `zselect`), and an
			// empty pipe is not ready.
			s.wait(cx.waker());
			return Poll::Pending;
		}
		let n = buf.len().min(s.buf.len());
		let (front, back) = s.buf.as_slices();
		let split = n.min(front.len());
		buf[..split].copy_from_slice(&front[..split]);
		buf[split..n].copy_from_slice(&back[..n - split]);
		s.buf.drain(..n);
		s.wake_all();
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		unsupported()
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::Error::from_raw_os_error(29))
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	/// The OS pipe's read end, once the pipe became one, unless bytes given
	/// back wait ahead of it or an earlier external reader is fed
	/// ([`PipeState::fed`]).
	fn os_handle(&self) -> Option<OsHandle> {
		let s = self.0.lock();
		if s.fed || !s.buf.is_empty() {
			return None;
		}
		s.os.as_ref()?.read.as_ref()?.os_handle()
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.0.lock().readers += 1;
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

impl File for PipeWriter {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		unsupported()
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let mut s = self.0.lock();
		if let Some(os) = &mut s.os {
			// An OS pipe: the kernel decides room and `EPIPE`, as other
			// processes may hold its read end.
			return match &mut os.write {
				Some(end) => end.poll_write(cx, buf),
				None => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
			};
		}
		if s.readers == 0 {
			return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
		}
		let room = PIPE_CAPACITY.saturating_sub(s.buf.len());
		if room == 0 {
			s.wait(cx.waker());
			return Poll::Pending;
		}
		let n = room.min(buf.len());
		s.buf.extend(&buf[..n]);
		if let Some(mirror) = &s.mirror {
			mirror.write(&buf[..n]);
		}
		s.wake_all();
		Poll::Ready(Ok(n))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::Error::from_raw_os_error(29))
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	/// The OS pipe's write end, once the pipe became one.
	fn os_handle(&self) -> Option<OsHandle> {
		self.0.lock().os.as_ref()?.write.as_ref()?.os_handle()
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.0.lock().writers += 1;
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

/// A read-only in-memory document (here-documents, here-strings) with a
/// shared read position, so duplicated fds and `read` see one offset.
pub struct MemBuf {
	data: Arc<[u8]>,
	pos:  Arc<Mutex<usize>>,
}

impl MemBuf {
	/// A document over `data`.
	pub fn new(data: impl Into<Arc<[u8]>>) -> Self {
		Self { data: data.into(), pos: Arc::new(Mutex::new(0)) }
	}
}

impl File for MemBuf {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		let mut pos = self.pos.lock();
		let rest = self.data.get(*pos..).unwrap_or_default();
		let n = rest.len().min(buf.len());
		buf[..n].copy_from_slice(&rest[..n]);
		*pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
		let mut pos = self.pos.lock();
		let len = self.data.len() as i64;
		let next = match to {
			SeekFrom::Start(n) => i64::try_from(n).unwrap_or(i64::MAX),
			SeekFrom::End(d) => len + d,
			SeekFrom::Current(d) => *pos as i64 + d,
		};
		*pos = usize::try_from(next).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		Ok(*pos as u64)
	}

	fn kind(&self) -> FileKind {
		FileKind::Regular
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self { data: Arc::clone(&self.data), pos: Arc::clone(&self.pos) }))
	}
}

/// A write-only growing buffer: the stdout of a command substitution.
#[derive(Clone, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
	/// Take everything written so far.
	pub fn take(&self) -> Vec<u8> {
		std::mem::take(&mut *self.0.lock())
	}

	/// Identity of the shared buffer.
	pub fn key(&self) -> usize {
		Arc::as_ptr(&self.0).addr()
	}

	/// Image of the shared buffer.
	pub fn image(&self) -> MemImage {
		MemImage::Capture { data: self.0.lock().clone() }
	}
}

/// One end of an engine memory object, as an fd holds it.
pub enum MemFile {
	/// Read end of a [`pipe`].
	PipeRead(PipeReader),
	/// Write end of a [`pipe`].
	PipeWrite(PipeWriter),
	/// A here-document.
	Buf(MemBuf),
	/// A command substitution's stdout.
	Capture(Capture),
}

/// Which end of a memory object an fd holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemEnd {
	/// A pipe's read end.
	Read,
	/// A pipe's write end.
	Write,
	/// The object itself (a document or a capture).
	Whole,
}

/// The shared state of a memory object, for the frames image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemImage {
	/// Unread pipe contents (at most [`PIPE_CAPACITY`] bytes).
	Pipe {
		/// Buffered bytes.
		buf:     Vec<u8>,
		/// A vproc waited on the pipe (for data or room): the restored pipe
		/// wakes the engine on its next change, as the original would have.
		waiting: bool,
	},
	/// A document and its shared read offset.
	Buf {
		/// The document.
		data: Vec<u8>,
		/// Read offset.
		pos:  usize,
	},
	/// Captured output so far.
	Capture {
		/// The bytes.
		data: Vec<u8>,
	},
}

impl MemFile {
	/// Identity of the shared state (equal for every end and duplicate of
	/// one object) and the end this is.
	pub fn key(&self) -> (usize, MemEnd) {
		match self {
			Self::PipeRead(r) => (Arc::as_ptr(&r.0).addr(), MemEnd::Read),
			Self::PipeWrite(w) => (Arc::as_ptr(&w.0).addr(), MemEnd::Write),
			Self::Buf(b) => (Arc::as_ptr(&b.pos).addr(), MemEnd::Whole),
			Self::Capture(c) => (c.key(), MemEnd::Whole),
		}
	}

	/// Image of the shared state; `None` for a pipe that became an OS pipe,
	/// whose bytes are in the kernel and whose ends externals hold.
	pub fn image(&self) -> Option<MemImage> {
		Some(match self {
			Self::PipeRead(PipeReader(state)) | Self::PipeWrite(PipeWriter(state)) => {
				let s = state.lock();
				if s.os.is_some() {
					return None;
				}
				MemImage::Pipe {
					buf:     s.buf.iter().copied().collect(),
					waiting: !s.waiters.is_empty(),
				}
			},
			Self::Buf(b) => MemImage::Buf { data: b.data.to_vec(), pos: *b.pos.lock() },
			Self::Capture(c) => c.image(),
		})
	}

	/// An external is about to take this end
	/// ([`FdRef::share_with_external`](crate::bash::FdRef::share_with_external)).
	/// A pipe between pipeline stages ([`stage_pipe`]) becomes the OS pipe
	/// `os_pipe` makes, holding first the bytes this pipe held
	/// ([`Host::os_pipe`](crate::bash::Host::os_pipe)), so the external
	/// inherits its end ([`File::os_handle`]) and every other end, external or
	/// engine, uses the same pipe from then on. Engine waiters are woken to
	/// poll it. Any other object, and a pipe already shared, stay as they are.
	///
	/// A pipe `os_pipe` declines stays in memory for good: the host pumps it to
	/// this external, whose feed may hold bytes, and a later OS pipe would let
	/// another external read past them. For the same reason an external that
	/// takes the read end of an OS pipe while bytes given back wait ahead of
	/// it makes every later external reader fed too ([`PipeState::fed`]).
	pub fn share_with_external(
		&self,
		os_pipe: impl FnOnce(&[u8]) -> Option<(Box<dyn File>, Box<dyn File>)>,
	) {
		let (state, reader) = match self {
			Self::PipeRead(PipeReader(state)) => (state, true),
			Self::PipeWrite(PipeWriter(state)) => (state, false),
			Self::Buf(_) | Self::Capture(_) => return,
		};
		let mut s = state.lock();
		if !s.shareable {
			return;
		}
		if s.os.is_none() {
			let Some((read, write)) = os_pipe(s.buf.make_contiguous()) else {
				s.shareable = false;
				return;
			};
			s.buf.clear();
			let os = OsEnds {
				read:  (s.readers > 0).then_some(read),
				write: (s.writers > 0).then_some(write),
			};
			s.os = Some(os);
			s.wake_all();
		}
		if reader && !s.buf.is_empty() {
			s.fed = true;
		}
	}

	/// Whether this is an end of a pipe that became an OS pipe.
	pub fn is_os_pipe(&self) -> bool {
		match self {
			Self::PipeRead(PipeReader(state)) | Self::PipeWrite(PipeWriter(state)) => {
				state.lock().os.is_some()
			},
			Self::Buf(_) | Self::Capture(_) => false,
		}
	}

	/// Another handle to the same end (a pipe end counts it).
	pub fn dup_end(&self) -> Self {
		match self {
			Self::PipeRead(r) => {
				r.0.lock().readers += 1;
				Self::PipeRead(PipeReader(Arc::clone(&r.0)))
			},
			Self::PipeWrite(w) => {
				w.0.lock().writers += 1;
				Self::PipeWrite(PipeWriter(Arc::clone(&w.0)))
			},
			Self::Buf(b) => Self::Buf(MemBuf { data: Arc::clone(&b.data), pos: Arc::clone(&b.pos) }),
			Self::Capture(c) => Self::Capture(c.clone()),
		}
	}

	fn file(&mut self) -> &mut dyn File {
		match self {
			Self::PipeRead(r) => r,
			Self::PipeWrite(w) => w,
			Self::Buf(b) => b,
			Self::Capture(c) => c,
		}
	}

	fn file_ref(&self) -> &dyn File {
		match self {
			Self::PipeRead(r) => r,
			Self::PipeWrite(w) => w,
			Self::Buf(b) => b,
			Self::Capture(c) => c,
		}
	}
}

impl File for MemFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.file().poll_read(cx, buf)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.file().poll_write(cx, buf)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.file().poll_flush(cx)
	}

	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		self.file().seek(pos)
	}

	fn kind(&self) -> FileKind {
		self.file_ref().kind()
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.file_ref().os_handle()
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.dup_end()))
	}
}

impl From<PipeReader> for MemFile {
	fn from(r: PipeReader) -> Self {
		Self::PipeRead(r)
	}
}

impl From<PipeWriter> for MemFile {
	fn from(w: PipeWriter) -> Self {
		Self::PipeWrite(w)
	}
}

impl From<MemBuf> for MemFile {
	fn from(b: MemBuf) -> Self {
		Self::Buf(b)
	}
}

impl From<Capture> for MemFile {
	fn from(c: Capture) -> Self {
		Self::Capture(c)
	}
}

/// A memory object rebuilt from its [`MemImage`]; hands out the ends the
/// restored fds held (a pipe counts its readers and writers from them).
pub enum MemObj {
	Pipe(Arc<Mutex<PipeState>>),
	Buf(MemBuf),
	Capture(Capture),
}

impl MemObj {
	/// Rebuild from an image; a pipe starts without ends, and in memory (a
	/// restored pipe is neither tapped nor shared with externals: their
	/// pumps connect it).
	pub fn rebuild(img: MemImage, engine: &Waker) -> Self {
		match img {
			MemImage::Pipe { buf, waiting } => {
				let waiters = if waiting {
					vec![engine.clone()]
				} else {
					Vec::new()
				};
				Self::Pipe(Arc::new(Mutex::new(PipeState {
					buf: buf.into(),
					waiters,
					..PipeState::default()
				})))
			},
			MemImage::Buf { data, pos } => {
				Self::Buf(MemBuf { data: data.into(), pos: Arc::new(Mutex::new(pos)) })
			},
			MemImage::Capture { data } => Self::Capture(Capture(Arc::new(Mutex::new(data)))),
		}
	}

	/// A new handle to `end`; `None` when the object has no such end.
	pub fn end(&self, end: MemEnd) -> Option<MemFile> {
		match (self, end) {
			(Self::Pipe(s), MemEnd::Read) => {
				s.lock().readers += 1;
				Some(MemFile::PipeRead(PipeReader(Arc::clone(s))))
			},
			(Self::Pipe(s), MemEnd::Write) => {
				s.lock().writers += 1;
				Some(MemFile::PipeWrite(PipeWriter(Arc::clone(s))))
			},
			(Self::Buf(b), MemEnd::Whole) => {
				Some(MemFile::Buf(MemBuf { data: Arc::clone(&b.data), pos: Arc::clone(&b.pos) }))
			},
			(Self::Capture(c), MemEnd::Whole) => Some(MemFile::Capture(c.clone())),
			_ => None,
		}
	}

	/// The capture this object is, if it is one.
	pub fn capture(&self) -> Option<Capture> {
		match self {
			Self::Capture(c) => Some(c.clone()),
			Self::Pipe(_) | Self::Buf(_) => None,
		}
	}
}

impl File for Capture {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.0.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::Error::from_raw_os_error(29))
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn cx() -> Context<'static> {
		Context::from_waker(Waker::noop())
	}

	#[test]
	fn pipe_eof_after_last_writer_and_epipe_after_last_reader() {
		let (mut r, mut w) = pipe();
		let w2 = w.dup().unwrap();
		assert!(matches!(w.poll_write(&mut cx(), b"ab"), Poll::Ready(Ok(2))));
		drop(w);
		let mut buf = [0; 4];
		assert!(matches!(r.poll_read(&mut cx(), &mut buf), Poll::Ready(Ok(2))));
		assert!(r.poll_read(&mut cx(), &mut buf).is_pending(), "a duplicated writer keeps it open");
		drop(w2);
		assert!(matches!(r.poll_read(&mut cx(), &mut buf), Poll::Ready(Ok(0))));
		let (r, mut w) = pipe();
		drop(r);
		let Poll::Ready(Err(err)) = w.poll_write(&mut cx(), b"x") else {
			panic!("expected EPIPE");
		};
		assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
	}

	#[test]
	fn full_pipe_pends_and_partially_writes() {
		let (_r, mut w) = pipe();
		let big = vec![7u8; PIPE_CAPACITY + 10];
		assert!(matches!(w.poll_write(&mut cx(), &big), Poll::Ready(Ok(n)) if n == PIPE_CAPACITY));
		assert!(w.poll_write(&mut cx(), b"x").is_pending());
	}

	#[test]
	fn membuf_dups_share_the_offset() {
		let mut a = MemBuf::new(&b"hello"[..]);
		let mut b = a.dup().unwrap();
		let mut buf = [0; 2];
		let _ = a.poll_read(&mut cx(), &mut buf);
		let _ = b.poll_read(&mut cx(), &mut buf);
		assert_eq!(&buf, b"ll");
		assert_eq!(a.seek(SeekFrom::Current(-1)).unwrap(), 3);
	}

	/// A stage pipe's conversion into the OS pipe of [`crate::sys::stage_pipe`]
	/// on the Unix hosts that have it (Windows', whose shell writes can wait
	/// on a worker, has its own tests there).
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
	mod shared {
		use std::io::{Read, Write};

		use super::*;

		fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
			crate::sys::stage_pipe::os_pipe(prefill)
		}

		/// What an external holds: a blocking descriptor of the same pipe end,
		/// opened anew through `/proc/self/fd`, or on macOS duplicated through
		/// `/dev/fd` (the engine forbids `unsafe`, so no `dup` here).
		fn external(end: &MemFile) -> std::fs::File {
			let fd = end.os_handle().expect("an OS end").0;
			let write = matches!(end, MemFile::PipeWrite(_));
			let dir = if cfg!(target_os = "macos") {
				"/dev/fd"
			} else {
				"/proc/self/fd"
			};
			std::fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.open(format!("{dir}/{fd}"))
				.expect("open the pipe end")
		}

		/// Everything `r` reads until it would wait or ends.
		fn drain(r: &mut MemFile) -> (Vec<u8>, bool) {
			let mut all = Vec::new();
			let mut buf = [0u8; 64];
			loop {
				match r.poll_read(&mut cx(), &mut buf) {
					Poll::Ready(Ok(0)) => return (all, true),
					Poll::Ready(Ok(n)) => all.extend_from_slice(&buf[..n]),
					Poll::Ready(Err(e)) => panic!("read: {e}"),
					Poll::Pending => return (all, false),
				}
			}
		}

		// Failure mode: what the pipe held before an external took an end is
		// lost, or comes after what the external writes; or the external is
		// given no descriptor and stays pumped.
		#[test]
		fn a_stage_pipe_becomes_an_os_pipe_and_keeps_its_bytes_first() {
			let (r, w) = stage_pipe();
			let (mut r, mut w) = (MemFile::from(r), MemFile::from(w));
			assert!(matches!(w.poll_write(&mut cx(), b"before "), Poll::Ready(Ok(7))));
			assert!(r.os_handle().is_none() && w.os_handle().is_none(), "in memory until shared");
			w.share_with_external(os_pipe);
			assert!(w.is_os_pipe() && r.is_os_pipe());
			assert!(w.image().is_none(), "an OS pipe has no image");
			external(&w).write_all(b"after").unwrap();
			assert!(matches!(w.poll_write(&mut cx(), b" and engine"), Poll::Ready(Ok(11))));
			assert_eq!(drain(&mut r), (b"before after and engine".to_vec(), false));
			let mut from_reader = external(&r);
			external(&w).write_all(b"!").unwrap();
			let mut one = [0u8; 1];
			from_reader.read_exact(&mut one).unwrap();
			assert_eq!(&one, b"!", "the external reader shares the same pipe");
		}

		// Failure mode: a tapped pipe, or a pipe that is not between stages
		// (process substitution, coprocess), becomes an OS pipe and its mirror
		// or its pump loses the bytes.
		#[test]
		fn only_untapped_stage_pipes_are_shared() {
			struct Mirror;
			impl PipeMirror for Mirror {
				fn write(&self, _bytes: &[u8]) {}

				fn close(&self) {}
			}
			let (tr, tw) = tapped_pipe(Arc::new(Mirror));
			let (pr, pw) = pipe();
			for end in [MemFile::from(tr), MemFile::from(tw), MemFile::from(pr), MemFile::from(pw)] {
				end.share_with_external(os_pipe);
				assert!(!end.is_os_pipe() && end.os_handle().is_none() && end.image().is_some());
			}
		}

		// Failure mode: bytes an engine reader gives back after the pipe became
		// an OS pipe are lost, come after the pipe's own, or an external takes
		// the OS end while they wait and never sees them.
		#[test]
		fn bytes_given_back_come_first_and_keep_externals_pumped_until_read() {
			let (r, w) = stage_pipe();
			let (mut r, w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			external(&w).write_all(b"abc").unwrap();
			let mut buf = [0u8; 3];
			assert!(matches!(r.poll_read(&mut cx(), &mut buf), Poll::Ready(Ok(3))));
			let MemFile::PipeRead(reader) = &r else {
				unreachable!()
			};
			reader.unread(b"bc");
			assert!(r.os_handle().is_none(), "an external must not skip the bytes given back");
			external(&w).write_all(b"d").unwrap();
			assert_eq!(drain(&mut r).0, b"bcd");
			assert!(r.os_handle().is_some());
		}

		// Failure mode: end of file comes while an external still holds the
		// write end (the shell closed the pipe under it), or never comes
		// (the shell keeps its own descriptor after its last writer is gone).
		#[test]
		fn end_of_file_comes_once_every_writer_is_gone() {
			let (r, w) = stage_pipe();
			let (mut r, w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			let outside = external(&w);
			drop(w);
			assert_eq!(drain(&mut r), (Vec::new(), false), "an external still holds the write end");
			drop(outside);
			assert_eq!(drain(&mut r), (Vec::new(), true));
		}

		// Failure mode: a write after every reader left waits or succeeds (the
		// shell kept its read end), instead of failing as `EPIPE`.
		#[test]
		fn a_write_fails_once_every_reader_is_gone() {
			let (r, w) = stage_pipe();
			let (r, mut w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			let outside = external(&r);
			drop(r);
			assert!(matches!(w.poll_write(&mut cx(), b"x"), Poll::Ready(Ok(1))), "an external reads");
			drop(outside);
			let Poll::Ready(Err(e)) = w.poll_write(&mut cx(), b"x") else {
				panic!("a write with no reader fails");
			};
			assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
		}

		/// A waker that counts its wakes.
		#[derive(Default)]
		struct Count(std::sync::atomic::AtomicUsize);

		impl std::task::Wake for Count {
			fn wake(self: Arc<Self>) {
				self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
			}
		}

		impl Count {
			fn woken(&self) -> bool {
				self.0.load(std::sync::atomic::Ordering::SeqCst) > 0
			}
		}

		/// Wait until `done`, failing the test after 30 s instead of hanging.
		fn until(what: &str, done: impl Fn() -> bool) {
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
			while !done() {
				assert!(std::time::Instant::now() < deadline, "{what}: not within 30 s");
				std::thread::sleep(std::time::Duration::from_millis(1));
			}
		}

		/// Write to `w` until the OS pipe is full (the write is `Pending`).
		fn fill(w: &mut MemFile, cx: &mut Context<'_>) {
			let chunk = [1u8; 4096];
			let mut put = 0usize;
			loop {
				match w.poll_write(cx, &chunk) {
					Poll::Ready(Ok(n)) => put += n,
					Poll::Ready(Err(e)) => panic!("write: {e}"),
					Poll::Pending => return,
				}
				assert!(put < 16 << 20, "the pipe never filled");
			}
		}

		// Failure mode (review finding 1): an empty write is how an extra asks
		// whether its reader is gone (`tail -f`, `reader_gone`) or the pipe has
		// room (`zselect -w`); on an OS pipe it answered `Ok(0)` always, where
		// the memory pipe says `Pending` when full and `BrokenPipe` when no
		// reader is left.
		#[test]
		fn an_empty_write_sees_a_full_pipe_and_a_gone_reader() {
			let (r, w) = stage_pipe();
			let (r, mut w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			assert!(matches!(w.poll_write(&mut cx(), b""), Poll::Ready(Ok(0))), "room and a reader");
			fill(&mut w, &mut cx());
			assert!(w.poll_write(&mut cx(), b"").is_pending(), "a full pipe has no room");
			drop(r);
			let Poll::Ready(Err(e)) = w.poll_write(&mut cx(), b"") else {
				panic!("an empty write with no reader left is a broken pipe");
			};
			assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
		}

		// Failure mode (review finding 2): two tasks poll one handle (two
		// extras holding clones of one fd, a host feed), each with its own
		// waker; the second wait replaced the first, so the first task was
		// never woken and kept the end open.
		#[test]
		fn every_task_waiting_on_one_handle_is_woken() {
			let (r, w) = stage_pipe();
			let (mut r, mut w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			let (a, b) = (Arc::new(Count::default()), Arc::new(Count::default()));
			let (wa, wb) = (Waker::from(Arc::clone(&a)), Waker::from(Arc::clone(&b)));
			fill(&mut w, &mut Context::from_waker(&wa));
			assert!(
				w.poll_write(&mut Context::from_waker(&wb), b"x")
					.is_pending()
			);
			drain(&mut r);
			until("both writers woken", || a.woken() && b.woken());
		}

		// Failure mode (review finding 3): an external took the read end while
		// bytes waited in the memory buffer, so the host feeds it through a
		// pump that may hold some of them; a later external got the OS end
		// and read past them.
		#[test]
		fn once_a_reader_is_fed_every_later_reader_is_fed() {
			let (r, w) = stage_pipe();
			let (mut r, w) = (MemFile::from(r), MemFile::from(w));
			w.share_with_external(os_pipe);
			let MemFile::PipeRead(reader) = &r else {
				unreachable!()
			};
			reader.unread(b"held");
			r.share_with_external(os_pipe);
			assert!(r.os_handle().is_none(), "the first external is fed");
			assert_eq!(drain(&mut r).0, b"held", "its feed took the bytes");
			r.share_with_external(os_pipe);
			assert!(r.os_handle().is_none(), "a later external is fed too");
		}

		// Failure mode (review finding 3): a pipe the host declined to make an
		// OS pipe is pumped to its externals, whose feeds may hold bytes;
		// turning it into an OS pipe later let a new external read past them.
		#[test]
		fn a_declined_pipe_stays_in_memory() {
			let (r, w) = stage_pipe();
			let (r, w) = (MemFile::from(r), MemFile::from(w));
			r.share_with_external(|_| None);
			assert!(!r.is_os_pipe());
			w.share_with_external(os_pipe);
			assert!(!w.is_os_pipe() && w.os_handle().is_none() && w.image().is_some());
		}
	}
}
