//! Pumps between OS pipes and engine fd objects, for externals whose stdio
//! is an in-memory pipe or a host file without an OS handle.
//!
//! A pump is not a thread: it is a polled state machine, driven by the
//! `ExtProc` of the external it serves (its `poll_wait` polls the
//! [`Pumps`] before the [`Tracker`]) with the polling task's waker. Neither
//! side ever waits: the engine side through its pollable I/O, the OS side
//! through our private, non-blocking (Unix) or overlapped (Windows) pipe end
//! ([`os::OsPipe`]). One poll moves a bounded burst and then yields, waking
//! itself, so an endless stream cannot hold the engine.
//!
//! - **Output** (child → engine) runs until end of file, i.e. until every
//!   holder of the pipe's write end (the child and anything it forked) has
//!   closed it. If the engine side refuses the bytes (`EPIPE`: the reader is
//!   gone), the pump closes the OS read end so the child's next write gets
//!   `SIGPIPE`, exactly as with a real pipe. Each output half reports its drain
//!   to the [`Tracker`] once, at end of file, on refusal, or when dropped: the
//!   command completes only once its output is delivered and flushed. An output
//!   pump still running when its `ExtProc` is dropped (a detached or abandoned
//!   external, or a leftover it forked holding the pipe) goes on to its end of
//!   file as adopted work ([`orphan`]).
//! - **Input** (engine → child) runs until the engine side reaches end of file
//!   (then flushed), the child closes its end (`EPIPE`), or the tracker cancels
//!   it (the child exited, the spawn failed or the `ExtProc` was dropped); a
//!   cancel wakes the poller, which drops the input work.
//! - **Feed** (engine fd object → children): input from an engine fd object
//!   goes through one OS pipe per object, shared by every external and fd it is
//!   handed to ([`Feed`]), as bash shares one kernel pipe. A pump per handoff
//!   would race the others for the same bytes and lose whatever it took into a
//!   pipe its child never reads (`cat < <(…)` holds the procsub on fd 0 and fd
//!   63; in `diff <(a) <(b)`, `b` inherits `a`'s fd 63). Every external holding
//!   a feed advances it when polled. Bytes in a feed nobody consumed go back to
//!   the engine object when its last external is done (see [`Feed`]).
//! - **Duplex** (Unix, extra fds whose direction the spec does not say): one
//!   end of a socket pair, pumped both ways.

pub(super) mod orphan;
pub(super) mod os;

use std::{
	fs,
	future::Future,
	io,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
};

use parking_lot::Mutex;

use self::os::OsPipe;
use crate::{
	bash::{FdRef, File, Mark},
	sys::lifecycle::Tracker,
};

/// Engine side of a pump.
pub enum End {
	/// An engine fd object (in-memory pipe end, VFS file).
	Fd(FdRef),
	/// A host file without an OS handle.
	File(Box<dyn File>),
}

impl End {
	/// Which ways the engine object can move bytes: `(readable, writable)`.
	///
	/// [`SpawnSpec::extra_fds`](crate::bash::SpawnSpec::extra_fds) carries no
	/// direction, so it is probed with zero-length I/O, which transfers
	/// nothing and which the wrong direction refuses, as `read(2)`/`write(2)`
	/// on an fd opened the other way do (`EBADF`; the engine's pipe ends answer
	/// `Unsupported`). `Pending` counts as capable (a full or empty pipe).
	/// The child must get a pipe in that direction rather than a socket:
	/// Linux cannot reopen a socket through `/dev/fd/N` (`cat <(…)`, ENXIO).
	#[cfg(unix)]
	pub fn direction(&mut self) -> (bool, bool) {
		let mut cx = Context::from_waker(Waker::noop());
		let readable = !matches!(self.poll_read(&mut cx, &mut []), Poll::Ready(Err(_)));
		let writable = !matches!(self.poll_write_marked(&mut cx, &[]), Poll::Ready(Err(_)));
		(readable, writable)
	}
}

/// Pollable I/O on either side of a pump.
pub(super) trait PollIo {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>>;
	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>>;
	/// A write, with the mark of the chunk a writer thread took
	/// ([`File::poll_write_marked`]; `None` when it wrote as it took).
	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>>;
	/// Ready once the chunks of `marks` are out, with their first error
	/// ([`File::poll_settle_marked`]).
	fn poll_settle_marked(&mut self, cx: &mut Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>>;
	/// Moves on what this side took and has not written out yet (a zsh
	/// multios tee moves its queue only when polled): `Ready` once it is out.
	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>>;
}

impl PollIo for End {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		match self {
			Self::Fd(f) => f.poll_read(cx, buf),
			Self::File(f) => f.poll_read(cx, buf),
		}
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match self {
			Self::Fd(f) => f.poll_flush(cx),
			Self::File(f) => f.poll_flush(cx),
		}
	}

	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		match self {
			Self::Fd(f) => f.poll_write_marked(cx, buf),
			Self::File(f) => f.poll_write_marked(cx, buf),
		}
	}

	fn poll_settle_marked(&mut self, cx: &mut Context<'_>, marks: &[Mark]) -> Poll<io::Result<()>> {
		match self {
			Self::Fd(f) => f.poll_settle_marked(cx, marks),
			Self::File(f) => f.poll_settle_marked(cx, marks),
		}
	}

	/// Ready once the writes this end took are out ([`File::poll_settle`]).
	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match self {
			Self::Fd(f) => f.poll_settle(cx),
			Self::File(f) => f.poll_settle(cx),
		}
	}
}

impl PollIo for OsPipe {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Self::poll_read(self, cx, buf)
	}

	/// Our end of an OS pipe writes as it takes: no mark.
	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<io::Result<(usize, Option<Mark>)>> {
		Self::poll_write(self, cx, buf).map_ok(|n| (n, None))
	}

	fn poll_settle_marked(
		&mut self,
		_cx: &mut Context<'_>,
		_marks: &[Mark],
	) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Self::poll_flush(self, cx)
	}

	/// Our end of an OS pipe writes as it takes, or its own in-flight
	/// write goes on by itself.
	fn poll_settle(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}
}

/// Bytes one pump read moves at most.
pub(super) const BUF: usize = 64 << 10;
/// Reads plus writes one poll of a pump does at most before it yields.
pub(super) const BURST: usize = 32;

/// Bytes read from one side and not yet all written to the other.
struct Chunk {
	buf:   Box<[u8]>,
	start: usize,
	end:   usize,
	/// The source ended (end of file or an error): flush, then done.
	eof:   bool,
	/// The chunk a writer thread of `dst` took last: settled before the next
	/// one goes, and its failure is `dst`'s refusal.
	mark:  Option<Mark>,
}

impl Chunk {
	fn new() -> Self {
		Self { buf: vec![0; BUF].into_boxed_slice(), start: 0, end: 0, eof: false, mark: None }
	}

	/// Read but not written yet.
	fn pending(&self) -> &[u8] {
		&self.buf[self.start..self.end]
	}

	/// Settles the chunk `dst` took last, if any: `Ready(false)` when it
	/// failed.
	fn settle(&mut self, cx: &mut Context<'_>, dst: &mut impl PollIo) -> Poll<bool> {
		let Some(mark) = &self.mark else {
			return Poll::Ready(true);
		};
		let settled = std::task::ready!(dst.poll_settle_marked(cx, std::slice::from_ref(mark)));
		self.mark = None;
		Poll::Ready(settled.is_ok())
	}

	/// Copy `src` into `dst`. Ready once done: `src` ended and `dst` was
	/// flushed, or `dst` refused bytes (`EPIPE`, a failed object, a chunk a
	/// writer thread of `dst` failed). The chunk `dst` took last settles
	/// before the next one goes. Yields after [`BURST`] steps.
	fn poll_copy(
		&mut self,
		cx: &mut Context<'_>,
		src: &mut impl PollIo,
		dst: &mut impl PollIo,
	) -> Poll<()> {
		for _ in 0..BURST {
			if self.start == self.end {
				if self.eof {
					let _ = std::task::ready!(self.settle(cx, dst));
					let _ = std::task::ready!(dst.poll_flush(cx));
					return Poll::Ready(());
				}
				let read = match src.poll_read(cx, &mut self.buf) {
					Poll::Ready(read) => read,
					Poll::Pending => {
						// Nothing to copy now: what `dst` took moves on out
						// meanwhile (a tee moves its queue only when polled).
						if self.settle(cx, dst) == Poll::Ready(false) {
							return Poll::Ready(());
						}
						let _ = dst.poll_settle(cx);
						return Poll::Pending;
					},
				};
				match read {
					Ok(0) => self.eof = true,
					Ok(n) => {
						self.start = 0;
						self.end = n;
					},
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					Err(_) => self.eof = true,
				}
				continue;
			}
			if !std::task::ready!(self.settle(cx, dst)) {
				return Poll::Ready(());
			}
			match std::task::ready!(dst.poll_write_marked(cx, &self.buf[self.start..self.end])) {
				Ok((n, mark)) if n > 0 => {
					self.start += n;
					self.mark = mark;
				},
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				// The reader is gone (EPIPE) or the object failed.
				_ => return Poll::Ready(()),
			}
		}
		// A burst moved: let the engine run, then go on.
		cx.waker().wake_by_ref();
		Poll::Pending
	}
}

/// Reports one output half drained to its tracker when dropped: at end of
/// file, on refusal, or with its pump (`ExtProc` dropped, unwinding).
struct Drained(Arc<Tracker>);

impl Drop for Drained {
	fn drop(&mut self) {
		self.0.drained();
	}
}

/// A pump as set up for a spawn, before the child exists.
pub enum Pump {
	/// Engine → child stdin, over our write end.
	In(End, OsPipe),
	/// Child output → engine, from our read end.
	Out(OsPipe, End),
	/// Both ways over our end of a socket pair.
	#[cfg(unix)]
	Duplex(End, OsPipe),
}

impl Pump {
	/// How many output streams this pump delivers (each gates completion).
	pub const fn outputs(&self) -> usize {
		match self {
			Self::In(..) => 0,
			Self::Out(..) => 1,
			#[cfg(unix)]
			Self::Duplex(..) => 1,
		}
	}
}

/// One running pump.
enum Task {
	In {
		/// Our write end; dropping it gives the child end of file.
		dst:   OsPipe,
		src:   End,
		chunk: Chunk,
	},
	Out {
		/// Our read end; closed before the drain is reported (fields drop in
		/// order).
		src:      OsPipe,
		dst:      End,
		chunk:    Chunk,
		_drained: Drained,
	},
	#[cfg(unix)]
	Duplex(Box<Duplex>),
}

impl Task {
	/// Ready once the pump is done (drop it).
	fn poll(&mut self, cx: &mut Context<'_>, cancelled: bool) -> Poll<()> {
		match self {
			Self::In { .. } if cancelled => Poll::Ready(()),
			Self::In { dst, src, chunk } => chunk.poll_copy(cx, src, dst),
			Self::Out { src, dst, chunk, .. } => chunk.poll_copy(cx, src, dst),
			#[cfg(unix)]
			Self::Duplex(d) => d.poll(cx, cancelled),
		}
	}

	/// The output part of a pump whose `ExtProc` is gone; its input part
	/// ends here.
	fn into_output(self) -> Option<Self> {
		match self {
			Self::In { .. } => None,
			out @ Self::Out { .. } => Some(out),
			#[cfg(unix)]
			Self::Duplex(mut d) => {
				if d.inbound.take().is_some() {
					d.sock.shutdown(std::net::Shutdown::Write);
				}
				d.outbound.is_some().then_some(Self::Duplex(d))
			},
		}
	}
}

/// Output pumps that outlived their `ExtProc`, run to their ends as one
/// piece of adopted work.
struct Outputs(Vec<Task>);

impl Future for Outputs {
	type Output = ();

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
		self.0.retain_mut(|t| t.poll(cx, true).is_pending());
		if self.0.is_empty() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

/// Both halves of a duplex pump over one socket pair end and one engine
/// object.
#[cfg(unix)]
struct Duplex {
	sock:     OsPipe,
	end:      End,
	/// Engine → child; `None` once done (our end shut down for writing).
	inbound:  Option<Chunk>,
	/// Child → engine; `None` once drained (our end shut down for reading,
	/// the guard reported it).
	outbound: Option<(Chunk, Drained)>,
}

#[cfg(unix)]
impl Duplex {
	fn poll(&mut self, cx: &mut Context<'_>, cancelled: bool) -> Poll<()> {
		use std::net::Shutdown;

		if let Some((chunk, _)) = &mut self.outbound
			&& chunk
				.poll_copy(cx, &mut self.sock, &mut self.end)
				.is_ready()
		{
			self.sock.shutdown(Shutdown::Read);
			self.outbound = None;
		}
		if let Some(chunk) = &mut self.inbound
			&& (cancelled
				|| chunk
					.poll_copy(cx, &mut self.end, &mut self.sock)
					.is_ready())
		{
			self.sock.shutdown(Shutdown::Write);
			self.inbound = None;
		}
		if self.inbound.is_none() && self.outbound.is_none() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

/// The pumps of one external and the feeds it holds, polled by its
/// `ExtProc`.
pub struct Pumps {
	tasks: Vec<Task>,
	/// Shared input feeds the child holds: kept open while this lives and
	/// advanced by every poll.
	feeds: Vec<Arc<Feed>>,
}

impl Pumps {
	/// Run `pumps` (output halves report their drain to `tracker`) and hold
	/// `feeds`.
	pub fn new(pumps: Vec<Pump>, feeds: Vec<Arc<Feed>>, tracker: &Arc<Tracker>) -> Self {
		let tasks = pumps
			.into_iter()
			.map(|p| match p {
				Pump::In(src, dst) => Task::In { dst, src, chunk: Chunk::new() },
				Pump::Out(src, dst) => {
					Task::Out { src, dst, chunk: Chunk::new(), _drained: Drained(Arc::clone(tracker)) }
				},
				#[cfg(unix)]
				Pump::Duplex(end, sock) => Task::Duplex(Box::new(Duplex {
					sock,
					end,
					inbound: Some(Chunk::new()),
					outbound: Some((Chunk::new(), Drained(Arc::clone(tracker)))),
				})),
			})
			.collect();
		Self { tasks, feeds }
	}

	/// Move what can move now; every side that cannot go on has registered
	/// `cx`'s waker. Input pumps are dropped once `tracker` cancelled them.
	/// Also advances retained [`orphan`] work. Called by
	/// `ExtProc::poll_wait` before it polls the tracker.
	pub fn poll(&mut self, cx: &mut Context<'_>, tracker: &Tracker) {
		let cancelled = tracker.pumps_cancelled(cx.waker());
		self
			.tasks
			.retain_mut(|t| t.poll(cx, cancelled).is_pending());
		for feed in &self.feeds {
			feed.poll(cx);
		}
		orphan::poll(cx);
	}
}

impl Drop for Pumps {
	/// Input work ends with the `ExtProc`; output still running is adopted
	/// and delivered to its end of file. The feeds drop after this (fields
	/// drop after `drop`), giving back what no child read.
	fn drop(&mut self) {
		// An output whose stream has ended (a failed spawn, a child gone with
		// everything it forked) finishes here.
		let mut now = Context::from_waker(Waker::noop());
		let outputs: Vec<Task> = self
			.tasks
			.drain(..)
			.filter_map(Task::into_output)
			.filter_map(|mut t| t.poll(&mut now, true).is_pending().then_some(t))
			.collect();
		if !outputs.is_empty() {
			orphan::adopt(Outputs(outputs));
		}
	}
}

/// One engine fd object bridged into one OS pipe for every external it is
/// handed to: the child's end of the pipe, which children get duplicates of,
/// and the pump filling it from the engine object.
///
/// The `ExtProc` of every external holding a duplicate keeps the `Feed`
/// alive and advances its pump when polled; the feed wakes every holder
/// that polled it, so whichever runs next moves the bytes. When the last
/// holder is dropped, the drop gives back what no child consumed at once,
/// on the dropping thread, without waiting for any task: it closes our write
/// end (the pipe's only one) first, so reading the child's end ends at end
/// of file, then puts the bytes still in the OS pipe, followed by those the
/// pump took from the engine object but had not written yet, in front of the
/// object's unread data ([`FdRef::unread`]). `f(){ date; cat "$1"; }; f <(echo
/// x)` and `exec 4< <(echo x); /bin/echo; read v <&4` then see `x`, as with
/// bash's one kernel pipe. (A grandchild still holding the read end may race
/// the drain for bytes, as two readers of one pipe do.)
pub struct Feed {
	/// The child's end.
	read:   fs::File,
	/// Engine object it is fed from (identity for sharing).
	fd:     FdRef,
	/// The pump. Holders poll it under the lock, which is never held across
	/// a `Pending`.
	state:  Mutex<FeedState>,
	/// The holders' wakers, woken through `waker` (the one the engine object
	/// and the OS side keep).
	wakers: Arc<Wakers>,
	waker:  Waker,
}

/// The pump of a [`Feed`].
struct FeedState {
	/// Our write end, the pipe's only one; `None` once the pump ended (the
	/// children read end of file).
	pipe:  Option<OsPipe>,
	src:   End,
	/// Bytes taken from the engine object, not written into the pipe yet.
	chunk: Chunk,
}

/// Wakers of the holders of a feed: waking it wakes them all once.
#[derive(Default)]
struct Wakers(Mutex<Vec<Waker>>);

impl Wakers {
	fn add(&self, waker: &Waker) {
		let mut wakers = self.0.lock();
		if !wakers.iter().any(|w| w.will_wake(waker)) {
			wakers.push(waker.clone());
		}
	}

	/// Take them all (to wake or drop outside the lock).
	fn take(&self) -> Vec<Waker> {
		std::mem::take(&mut *self.0.lock())
	}
}

impl Wake for Wakers {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		for w in self.take() {
			w.wake();
		}
	}
}

impl Feed {
	/// A feed of a new OS pipe, filled from `fd`.
	pub fn new(fd: FdRef) -> io::Result<Self> {
		let (pipe, read) = os::pipe(true)?;
		let wakers = Arc::new(Wakers::default());
		let waker = Waker::from(Arc::clone(&wakers));
		Ok(Self {
			read,
			fd: fd.clone(),
			state: Mutex::new(FeedState {
				pipe:  Some(pipe),
				src:   End::Fd(fd),
				chunk: Chunk::new(),
			}),
			wakers,
			waker,
		})
	}

	/// Whether this feed is filled from the engine object `fd`.
	pub fn feeds(&self, fd: &FdRef) -> bool {
		self.fd.same(fd)
	}

	/// A duplicate of the child's end for one more child fd.
	pub fn child_end(&self) -> io::Result<fs::File> {
		self.read.try_clone()
	}

	/// Advance the pump; `cx`'s task is woken when it can go on.
	fn poll(&self, cx: &Context<'_>) {
		self.wakers.add(cx.waker());
		let mut fcx = Context::from_waker(&self.waker);
		let mut st = self.state.lock();
		let FeedState { pipe, src, chunk } = &mut *st;
		if let Some(p) = pipe
			&& chunk.poll_copy(&mut fcx, src, p).is_ready()
		{
			// End of the engine object (flushed): the children read end of
			// file. A refused write cannot happen while `read` is open; any
			// other failure keeps the unwritten bytes for the drop.
			*pipe = None;
		}
	}
}

impl Drop for Feed {
	fn drop(&mut self) {
		let st = self.state.get_mut();
		// What the pipe holds, read without waiting ([`os::reclaim`]: Unix
		// closes our write end first, so the read ends at end of file), then
		// what the pump took but had not written.
		let mut back = os::reclaim(st.pipe.take(), &self.read);
		back.extend_from_slice(st.chunk.pending());
		if !back.is_empty() {
			// An object that cannot take them back loses them.
			let _ = self.fd.unread(&back);
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::io::Read;

	use super::*;

	/// An engine source that never has bytes and counts its live copies.
	struct Never(Arc<()>);

	impl File for Never {
		fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
			Poll::Pending
		}

		fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
			Poll::Pending
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> crate::bash::FileKind {
			crate::bash::FileKind::Pipe
		}

		fn os_handle(&self) -> Option<crate::bash::OsHandle> {
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}

	/// Every output half reports its drain exactly once, however it ends: at
	/// end of file, or, dropped with its `ExtProc` while its child still
	/// holds the pipe, when the adopted rest reaches its end of file (not
	/// before: the output is not cut off).
	#[test]
	fn each_output_half_reports_its_drain_once() {
		// One drain more than there are halves: a half reporting twice would
		// reach zero.
		let tracker = Tracker::new(4);
		let (out_eof, child_out) = os::pipe(false).unwrap();
		let (out_open, child_open) = os::pipe(false).unwrap();
		let (duplex, child_duplex) = os::socket_pair().unwrap();
		let sink = || End::Fd(FdRef::from_file(Box::new(Never(Arc::new(())))));
		let mut pumps = Pumps::new(
			vec![
				Pump::Out(out_eof, sink()),
				Pump::Out(out_open, sink()),
				Pump::Duplex(sink(), duplex),
			],
			Vec::new(),
			&tracker,
		);
		drop(child_out);
		let mut cx = Context::from_waker(Waker::noop());
		pumps.poll(&mut cx, &tracker);
		pumps.poll(&mut cx, &tracker);
		assert_eq!(tracker.lock().draining(), 3, "end of file drained one half, once");
		drop(pumps);
		orphan::poll(&cx);
		assert_eq!(tracker.lock().draining(), 3, "adopted halves run on");
		drop((child_open, child_duplex));
		// Another test of this process may be polling the retained work.
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
		while tracker.lock().draining() > 1 {
			assert!(std::time::Instant::now() < deadline, "the adopted halves never drained");
			orphan::poll(&cx);
			std::thread::yield_now();
		}
		assert_eq!(tracker.lock().draining(), 1, "each drained once at its end of file");
	}

	/// An input pump waiting for engine bytes stops at the cancel: it is
	/// dropped at the next poll, releasing the engine object, and the cancel
	/// wakes the task that polls it even while output still drains.
	#[test]
	fn cancel_drops_input_waiting_on_the_engine() {
		let tracker = Tracker::new(1);
		let alive = Arc::new(());
		let src = End::File(Box::new(Never(Arc::clone(&alive))));
		let (ours, child) = os::pipe(true).unwrap();
		let mut pumps = Pumps::new(vec![Pump::In(src, ours)], Vec::new(), &tracker);
		let woken = Arc::new(Woken::default());
		let waker = Waker::from(Arc::clone(&woken));
		let mut cx = Context::from_waker(&waker);
		pumps.poll(&mut cx, &tracker);
		assert!(tracker.poll(&cx).is_pending(), "output still draining");
		assert_eq!(Arc::strong_count(&alive), 2, "the pump holds the source");
		tracker.cancel_pumps();
		assert!(woken.0.load(std::sync::atomic::Ordering::SeqCst), "the cancel wakes the poller");
		pumps.poll(&mut cx, &tracker);
		assert_eq!(Arc::strong_count(&alive), 1, "the input work is gone");
		let mut rest = Vec::new();
		(&child).read_to_end(&mut rest).unwrap();
		assert!(rest.is_empty(), "the child reads end of file");
	}

	// Failure mode: a pump into a host file whose writer thread failed a
	// chunk (its reader gone) wrote on with plain writes, which see no
	// hand-off error: it handed off chunk after chunk of the program's output
	// until the program ended. The pump writes with marks, settles the chunk
	// it handed off last before the next, and stops at the first failed one.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_pump_stops_at_the_first_chunk_its_destination_failed() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_pump_stops_at_the_first_chunk_its_destination_failed"),
			|| {
				let (reader, writer) = io::pipe().unwrap();
				drop(reader);
				let file = fs::File::from(std::os::fd::OwnedFd::from(writer));
				let mut dst = End::File(Box::new(crate::sys::StdFile::new(file)));
				let (mut src, program) = os::pipe(false).unwrap();
				let writes = std::thread::spawn(move || {
					// Four chunks' worth; the write ends once the pump stops
					// and our end of its pipe closes.
					let _ = std::io::Write::write_all(&mut &program, &vec![b'x'; 4 * BUF]);
				});
				let mut chunk = Chunk::new();
				let woken = Arc::new(Woken::default());
				let waker = Waker::from(Arc::clone(&woken));
				let mut cx = Context::from_waker(&waker);
				let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
				while chunk.poll_copy(&mut cx, &mut src, &mut dst).is_pending() {
					assert!(std::time::Instant::now() < deadline, "the pump never stopped");
					std::thread::sleep(std::time::Duration::from_millis(5));
				}
				drop(src);
				writes.join().unwrap();
				let failed = crate::sys::CHUNKS_FAILED.load(std::sync::atomic::Ordering::SeqCst);
				assert_eq!(failed, 1, "chunks handed off after the first one failed");
			},
		);
	}

	#[derive(Default)]
	struct Woken(std::sync::atomic::AtomicBool);

	impl Wake for Woken {
		fn wake(self: Arc<Self>) {
			self.0.store(true, std::sync::atomic::Ordering::SeqCst);
		}
	}
}
