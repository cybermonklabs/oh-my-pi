//! Pumps between OS pipes and engine fd objects, for externals whose stdio
//! is an in-memory pipe or a host file without an OS handle.
//!
//! A pump is not a thread: it is a polled state machine, driven by the
//! `ExtProc` of the external it serves (its `poll_wait` polls the
//! [`Pumps`] before the [`Tracker`], and again once the tracker reports
//! the exit, [`Pumps::poll_exit`]) with the polling task's waker. Neither
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
//!   cancel wakes the poller, which drops the input work, at the latest in the
//!   poll that reports the exit.
//! - **Feed** (engine fd object → children): input from an engine fd object
//!   goes through one OS pipe per object, shared by every external and fd it is
//!   handed to ([`Feed`]), as bash shares one kernel pipe. A pump per handoff
//!   would race the others for the same bytes and lose whatever it took into a
//!   pipe its child never reads (`cat < <(…)` holds the procsub on fd 0 and fd
//!   63; in `diff <(a) <(b)`, `b` inherits `a`'s fd 63). Every external holding
//!   a feed advances it when polled. The shell's own reads of the object come
//!   through its feeds first, so they take the bytes the pump already moved, in
//!   order ([`FeedRead`]); bytes in a feed nobody consumed go back to the
//!   engine object when its last external is done (see [`Feed`]).
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
	task::{Context, Poll, Waker},
};

use parking_lot::Mutex;

use self::os::OsPipe;
#[cfg(unix)]
use crate::bash::ProcEvent;
use crate::{
	bash::{ExitStatus, FdRef, FeedRead, File, Mark},
	sys::{WaitKey, Wakers, lifecycle::Tracker},
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
			// The pump's own read: past the object's feeds, this one among them.
			Self::Fd(f) => f.poll_read_direct(cx, buf),
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
			Self::In { dst, src, chunk } => {
				// A `<(…)` bridge listens for the child's opens before the
				// producer has written anything.
				dst.poll_listening(cx);
				chunk.poll_copy(cx, src, dst)
			},
			Self::Out { src, dst, chunk, .. } => {
				// A child gone without opening its named pipe (a `>(…)` it
				// never wrote to) gives no end of file: nothing more comes. A
				// client that connected is read first: it may have written and
				// left.
				if cancelled && src.poll_unopened(cx) {
					return Poll::Ready(());
				}
				chunk.poll_copy(cx, src, dst)
			},
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
	tasks:      Vec<Task>,
	/// Shared input feeds the child holds: kept open while this lives and
	/// advanced by every poll, each with this holder's wait on it.
	feeds:      Vec<(Arc<Feed>, WaitKey)>,
	/// This holder's wait on the retained [`orphan`] work.
	orphan_key: WaitKey,
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
		let feeds = feeds.into_iter().map(|f| (f, WaitKey::default())).collect();
		Self { tasks, feeds, orphan_key: WaitKey::default() }
	}

	/// Move what can move now; every side that cannot go on has registered
	/// `cx`'s waker. Input pumps are dropped once `tracker` cancelled them.
	/// Also advances retained [`orphan`] work. The exit polls
	/// ([`Pumps::poll_exit`], and `poll_event` on Unix) call it before and
	/// after the tracker reports the exit.
	pub fn poll(&mut self, cx: &mut Context<'_>, tracker: &Tracker) {
		if !self.tasks.is_empty() {
			let cancelled = tracker.pumps_cancelled(cx.waker());
			self
				.tasks
				.retain_mut(|t| t.poll(cx, cancelled).is_pending());
		}
		for (feed, key) in &mut self.feeds {
			feed.poll(cx, key);
		}
		orphan::poll(cx, &mut self.orphan_key);
	}

	/// `ExtProc::poll_wait`: [`Pumps::poll`], then the exit `tracker`
	/// reports once the process exited and its output drained. The input
	/// work, and the engine objects it reads, is gone when the exit is
	/// reported: a waiter thread can record the exit while the first poll
	/// runs, after it read the cancel, but it cancels the input work before
	/// it records the exit ([`Tracker::exited`]), so the poll after the exit
	/// drops it.
	pub fn poll_exit(&mut self, cx: &mut Context<'_>, tracker: &Tracker) -> Poll<ExitStatus> {
		self.poll(cx, tracker);
		let status = std::task::ready!(tracker.poll(cx));
		self.poll(cx, tracker);
		Poll::Ready(status)
	}

	/// `ExtProc::poll_event`: an exit as [`Pumps::poll_exit`] reports it, and
	/// the tracker's stop and continue events as they come.
	#[cfg(unix)]
	pub fn poll_event(&mut self, cx: &mut Context<'_>, tracker: &Tracker) -> Poll<ProcEvent> {
		self.poll(cx, tracker);
		let event = std::task::ready!(tracker.poll_event(cx));
		if matches!(event, ProcEvent::Exited(_)) {
			self.poll(cx, tracker);
		}
		Poll::Ready(event)
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
/// end (the pipe's only one), then puts the bytes still in the OS pipe,
/// followed by those the pump took from the engine object but had not
/// written yet, in front of the object's unread data ([`FdRef::unread`]).
/// With the feed's drain the pipe is emptied through it without waiting
/// (a process another thread forked can hold a copy of our write end until
/// its exec, so end of file may not come yet); without one, the child's end
/// is read to end of file ([`os::reclaim`]). `f(){ date; cat "$1"; }; f
/// <(echo x)` and `exec 4< <(echo x); /bin/echo; read v <&4` then see `x`,
/// as with bash's one kernel pipe. (A grandchild still holding the read end
/// may race the drain for bytes, as two readers of one pipe do.)
///
/// While holders live, the shell's own reads of the object come through a
/// feed with a drain ([`FeedRead`]): through its [`os::Drain`], a private
/// non-blocking read description of the pipe, they take what the pipe holds
/// first, then what the pump holds, then the object's next bytes, as
/// readers of one kernel pipe do. A feed without a drain (Windows, Linux
/// without `/proc`, macOS where the FIFO cannot be made) is not read through:
/// the shell takes the object's bytes only, and what the pump moved comes
/// back at the drop.
pub struct Feed {
	/// The child's end.
	read:   fs::File,
	/// The private read description of the pipe, where one can be opened.
	drain:  Option<Arc<os::Drain>>,
	/// Engine object it is fed from (identity for sharing).
	fd:     FdRef,
	/// The pump. Holders poll it under the lock, which is never held across
	/// a `Pending`.
	state:  Mutex<FeedState>,
	/// The holders' waits, one per holder's key, woken through `waker` (the
	/// one the engine object and the OS side keep).
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

impl Feed {
	/// A feed of a new OS pipe, filled from `fd`.
	pub fn new(fd: FdRef) -> io::Result<Self> {
		let (mut pipe, read, drain) = os::feed_pipe()?;
		let drain = drain.map(Arc::new);
		pipe.for_reclaim(drain.clone());
		let wakers = Arc::new(Wakers::default());
		let waker = Waker::from(Arc::clone(&wakers));
		Ok(Self {
			read,
			drain,
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

	/// Whether the shell's own reads can come through this feed: it has a
	/// drain ([`os::Drain`]).
	pub const fn reads_through(&self) -> bool {
		self.drain.is_some()
	}

	/// Advance the pump; `cx`'s task, waiting by its holder's `key`, is woken
	/// when it can go on.
	fn poll(&self, cx: &Context<'_>, key: &mut WaitKey) {
		// Whether no holder waited does not matter: the pump is polled below.
		let _ = self.wakers.wait(key, cx.waker());
		self.advance(&mut self.state.lock());
	}

	/// Move what the pump can, woken through the feed's own waker.
	fn advance(&self, st: &mut FeedState) {
		let mut fcx = Context::from_waker(&self.waker);
		let FeedState { pipe, src, chunk } = st;
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

impl FeedRead for Feed {
	fn poll_read_through(
		&self,
		cx: &mut Context<'_>,
		buf: &mut [u8],
		next: &mut crate::bash::ReadOn<'_>,
	) -> Poll<io::Result<usize>> {
		let Some(drain) = self.drain.as_ref() else {
			return next(cx, buf);
		};
		let mut st = self.state.lock();
		if buf.is_empty() {
			// Readiness (`read -t 0`, `zselect`, a zle watch): ready while the
			// pipe or the pump holds bytes, as one kernel pipe holding them is.
			if drain.available() == 0 && !st.chunk.pending().is_empty() {
				self.advance(&mut st);
			}
			if drain.available() > 0 || !st.chunk.pending().is_empty() {
				return Poll::Ready(Ok(0));
			}
			// The feed holds nothing: the object's own check answers, and
			// registers `cx` where it says not ready.
			return next(cx, buf);
		}
		// What the pipe holds, without a readiness wait: a read that finds the
		// feed empty goes on to `next`, whose own wait wakes it.
		match drain.read_now(buf) {
			Ok(0) => {},
			Ok(n) => return Poll::Ready(Ok(n)),
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
			Err(e) => return Poll::Ready(Err(e)),
		}
		if st.chunk.pending().is_empty() {
			// The pump holds nothing: the object's next bytes are its own, read
			// under this lock, so no holder's poll of the pump, on any thread,
			// moves them first.
			return next(cx, buf);
		}
		// The pump took bytes it has not written (a write in hand, or one the
		// pipe had no room for): they come before the object's. Its write
		// lands in the pipe, which this read or the drain's wait finds.
		self.advance(&mut st);
		match drain.poll_read(cx, buf) {
			Poll::Ready(Ok(0)) | Poll::Pending => Poll::Pending,
			read => read,
		}
	}
}

impl Drop for Feed {
	fn drop(&mut self) {
		let st = self.state.get_mut();
		// What the pipe holds, read without waiting, then what the pump took
		// but the pipe never did ([`os::reclaim`]).
		let back = os::reclaim(st.pipe.take(), &self.read, st.chunk.pending(), self.drain.as_deref());
		if !back.is_empty() {
			// An object that cannot take them back loses them.
			let _ = self.fd.unread(&back);
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{io::Read, task::Wake};

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
		// The copy of the write end that a process another test of this
		// process forks holds until its exec.
		let forked = child_out.try_clone().unwrap();
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
		assert_eq!(
			tracker.lock().draining(),
			4,
			"no end of file while a forked child holds the pipe"
		);
		// That process execs while the pumps are polled.
		let exec = std::thread::spawn(move || {
			std::thread::sleep(std::time::Duration::from_millis(10));
			drop(forked);
		});
		// End of file comes once every holder of the write end has closed it. A
		// process another test of this process forks holds a copy until its
		// exec, which delays end of file and never holds it off
		// ([`crate::testkit::child::Gate`]): poll until the drain is reported.
		// The deadline only names a hang: the slowest measured loaded run took
		// 0.1 s, and one with a fork holding the write end 300 ms still passed.
		let hang = std::time::Instant::now() + std::time::Duration::from_secs(30);
		while tracker.lock().draining() > 3 {
			assert!(
				std::time::Instant::now() < hang,
				"end of file never drained the half within 30 s: some holder kept the write end open"
			);
			pumps.poll(&mut cx, &tracker);
			std::thread::yield_now();
		}
		exec.join().unwrap();
		pumps.poll(&mut cx, &tracker);
		assert_eq!(tracker.lock().draining(), 3, "end of file drained one half, once");
		drop(pumps);
		let mut key = WaitKey::default();
		orphan::poll(&cx, &mut key);
		assert_eq!(tracker.lock().draining(), 3, "adopted halves run on");
		drop((child_open, child_duplex));
		// Another test of this process may be polling the retained work.
		// Halves that never drain hang the test until the runner's bound.
		while tracker.lock().draining() > 1 {
			orphan::poll(&cx, &mut key);
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
	// The destination is a full FIFO, so the writer thread's write of the
	// first chunk waits in the kernel, and the source holds four chunks and
	// its end before the pump starts, so it never makes the pump wait. The
	// pump is known to wait on that chunk before the FIFO's reader leaves and
	// the chunk fails, and it is polled again only once its waker was woken:
	// the chunk's settle is its only wake, so a settle that registers no
	// waker fails here.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_pump_stops_at_the_first_chunk_its_destination_failed() {
		use std::os::unix::fs::OpenOptionsExt;

		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_pump_stops_at_the_first_chunk_its_destination_failed"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = dir.path().join("dst");
				let made = std::process::Command::new("mkfifo")
					.arg(&path)
					.status()
					.unwrap();
				assert!(made.success(), "mkfifo: {made}");
				let held = fs::OpenOptions::new()
					.read(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&path)
					.unwrap();
				let mut filler = fs::OpenOptions::new()
					.write(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&path)
					.unwrap();
				// Full to the byte: page writes, then single bytes.
				for size in [4096, 1] {
					loop {
						match std::io::Write::write(&mut filler, &vec![b'F'; size]) {
							Ok(_) => {},
							Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
							Err(e) => panic!("filling the FIFO: {e}"),
						}
					}
				}
				let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
				let mut dst = End::File(Box::new(crate::sys::StdFile::new(file)));
				// Four chunks' worth and then the stream's end, all there before
				// the pump starts: the source never makes the pump wait, so the
				// settle of the destination's chunk is its only wake.
				let mut src = End::File(Box::new(Preloaded(vec![b'x'; 4 * BUF], 0)));
				let mut chunk = Chunk::new();
				let woken =
					Arc::new(Unparks(std::sync::atomic::AtomicBool::new(false), std::thread::current()));
				let waker = Waker::from(Arc::clone(&woken));
				let mut cx = Context::from_waker(&waker);
				// The first poll hands the first chunk to the destination's
				// writer thread, which waits on the full FIFO, reads the second
				// chunk, and waits on the first one's mark.
				assert!(
					chunk.poll_copy(&mut cx, &mut src, &mut dst).is_pending(),
					"the pump ended with its destination full"
				);
				assert!(
					chunk.mark.as_ref().is_some_and(|mark| !mark.is_done()),
					"the pump does not wait on its first chunk"
				);
				woken.0.store(false, std::sync::atomic::Ordering::SeqCst);
				drop(held);
				let start = std::time::Instant::now();
				let wait_for_wake = |what: &str| {
					while !woken.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
						assert!(
							start.elapsed() < std::time::Duration::from_secs(10),
							"the pump was not woken {what}"
						);
						std::thread::park_timeout(std::time::Duration::from_millis(50));
					}
				};
				wait_for_wake("when its chunk failed");
				while chunk.poll_copy(&mut cx, &mut src, &mut dst).is_pending() {
					wait_for_wake("to take its destination's refusal");
				}
				drop(src);
				drop(filler);
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

	/// Records a wake and unparks the test thread.
	#[cfg(target_os = "linux")]
	struct Unparks(std::sync::atomic::AtomicBool, std::thread::Thread);

	#[cfg(target_os = "linux")]
	impl Wake for Unparks {
		fn wake(self: Arc<Self>) {
			self.0.store(true, std::sync::atomic::Ordering::SeqCst);
			self.1.unpark();
		}
	}

	/// A source whose bytes are all there: every read is ready, and the
	/// stream ends after the last byte.
	#[cfg(target_os = "linux")]
	struct Preloaded(Vec<u8>, usize);

	#[cfg(target_os = "linux")]
	impl File for Preloaded {
		fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let rest = &self.0[self.1..];
			let n = rest.len().min(buf.len());
			buf[..n].copy_from_slice(&rest[..n]);
			self.1 += n;
			Poll::Ready(Ok(n))
		}

		fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
			Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _pos: std::io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> crate::bash::FileKind {
			crate::bash::FileKind::Pipe
		}

		fn os_handle(&self) -> Option<crate::bash::OsHandle> {
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	// Failure mode: while the feed's pump holds bytes it took from the engine
	// pipe and has not written (the OS pipe had no room), the shell's read of
	// the engine pipe takes the bytes after them, so a reader sees them out of
	// order. The room's thread is refused here, so the pump's write that would
	// wait stays its own until the pump is polled again (as on macOS, and on
	// Linux where no thread can be made): the held bytes outlive an empty
	// OS pipe.
	#[test]
	fn a_read_through_a_feed_takes_the_bytes_its_pump_holds_before_the_next_ones() {
		// Each 4-byte word is its own index: any byte out of order shows.
		const WORDS: u32 = 80 << 10;
		let (read, write) = FdRef::engine_pipe();
		let feed = Arc::new(Feed::new(read.clone()).expect("a feed"));
		let weak: std::sync::Weak<dyn FeedRead> = Arc::downgrade(&feed) as _;
		read.attach_feed(weak);
		let mut cx = Context::from_waker(Waker::noop());
		let bytes: Vec<u8> = (0..WORDS).flat_map(u32::to_be_bytes).collect();
		// The writer: as much as the engine pipe (64 KiB) has room for; it
		// closes once everything is written.
		let mut writer = Some(write);
		let mut put = 0;
		let mut fill = |cx: &mut Context<'_>| {
			while let Some(w) = writer.as_ref() {
				if put == bytes.len() {
					writer = None;
					break;
				}
				match w.poll_write(cx, &bytes[put..]) {
					Poll::Ready(Ok(n)) if n > 0 => put += n,
					Poll::Pending => break,
					other => panic!("engine pipe write: {other:?}"),
				}
			}
		};
		#[cfg(any(target_os = "linux", target_os = "android"))]
		crate::sys::room::no_thread_on_this_thread(true);
		let mut key = WaitKey::default();
		// The pump fills the OS pipe and holds what does not fit.
		for _ in 0..8 {
			fill(&mut cx);
			feed.poll(&cx, &mut key);
		}
		fill(&mut cx);
		assert!(
			!feed.state.lock().chunk.pending().is_empty(),
			"the pump holds bytes the pipe had no room for"
		);
		let mut got = Vec::with_capacity(bytes.len());
		let mut buf = [0u8; 4096];
		let mut idle = 0;
		while got.len() < bytes.len() {
			match read.poll_read(&mut cx, &mut buf) {
				Poll::Ready(Ok(0)) => break,
				Poll::Ready(Ok(n)) => {
					got.extend_from_slice(&buf[..n]);
					idle = 0;
				},
				Poll::Ready(Err(e)) => panic!("read: {e}"),
				Poll::Pending => {
					// What a holder's poll does: move the pump on.
					feed.poll(&cx, &mut key);
					idle += 1;
					assert!(idle < 10_000, "no progress at {} of {} bytes", got.len(), bytes.len());
				},
			}
			fill(&mut cx);
		}
		#[cfg(any(target_os = "linux", target_os = "android"))]
		crate::sys::room::no_thread_on_this_thread(false);
		assert_eq!(got.len(), bytes.len(), "every byte");
		let first_wrong = got
			.chunks(4)
			.zip(0u32..)
			.find(|(w, i)| *w != i.to_be_bytes());
		assert!(first_wrong.is_none(), "out of order at word {:?}", first_wrong.map(|(_, i)| i));
	}

	/// A feed with a drain of a new engine pipe, attached to its read end:
	/// the read end, the write end and the feed.
	fn fed_engine_pipe() -> (FdRef, FdRef, Arc<Feed>) {
		let (read, write) = FdRef::engine_pipe();
		let feed = Arc::new(Feed::new(read.clone()).expect("a feed"));
		assert!(feed.reads_through(), "Linux with /proc and macOS give a feed its drain");
		let weak: std::sync::Weak<dyn FeedRead> = Arc::downgrade(&feed) as _;
		read.attach_feed(weak);
		(read, write, feed)
	}

	// Failure mode: a zero-length read (`read -t 0`, `zselect`, a zle watch)
	// says "not ready" while the pump holds bytes it took and the OS pipe is
	// empty (its child emptied it before the feed was polled again), where
	// bash's one pipe holds those bytes and answers ready; and with nothing
	// held anywhere it must say "not ready" and wake the reader once bytes
	// come.
	#[test]
	fn a_zero_length_read_is_ready_while_the_pump_holds_bytes() {
		let (read, write, feed) = fed_engine_pipe();
		let woken = Arc::new(Woken::default());
		let waker = Waker::from(Arc::clone(&woken));
		let mut cx = Context::from_waker(&waker);
		assert!(read.poll_read(&mut cx, &mut []).is_pending(), "nothing anywhere: not ready");
		assert!(matches!(write.poll_write(&mut cx, b"x"), Poll::Ready(Ok(1))));
		assert!(
			woken.0.load(std::sync::atomic::Ordering::SeqCst),
			"a byte in the engine pipe wakes the reader"
		);
		let mut one = [0u8; 1];
		assert!(matches!(read.poll_read(&mut cx, &mut one), Poll::Ready(Ok(1))));
		// The pump fills the OS pipe and holds what does not fit; the room's
		// thread is refused, so the held write stays the pump's own.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		crate::sys::room::no_thread_on_this_thread(true);
		let chunk = vec![b'y'; 16 << 10];
		let mut key = WaitKey::default();
		for _ in 0..16 {
			let _ = write.poll_write(&mut cx, &chunk);
			feed.poll(&cx, &mut key);
		}
		#[cfg(any(target_os = "linux", target_os = "android"))]
		crate::sys::room::no_thread_on_this_thread(false);
		assert!(
			!feed.state.lock().chunk.pending().is_empty(),
			"the pump holds bytes the pipe had no room for"
		);
		// The engine pipe's own bytes are taken past the feed (its writer stays
		// open, so it is empty, not at end of file; a zero-length read of a
		// pipe holding bytes is ready whatever the feed holds), and the
		// children empty the OS pipe: only the pump holds bytes.
		let mut big = vec![0u8; 64 << 10];
		while let Poll::Ready(Ok(n)) = read.poll_read_direct(&mut cx, &mut big) {
			assert!(n > 0, "the engine pipe's writer is open");
		}
		assert!(
			read.poll_read_direct(&mut cx, &mut []).is_pending(),
			"the engine pipe is empty: not ready by itself"
		);
		let drain = feed.drain.as_ref().expect("a drain");
		let mut child = feed.child_end().unwrap();
		let mut emptied = vec![0u8; drain.available()];
		child.read_exact(&mut emptied).unwrap();
		assert_eq!(drain.available(), 0, "the OS pipe is empty");
		assert!(!feed.state.lock().chunk.pending().is_empty(), "the pump still holds bytes");
		assert!(
			matches!(read.poll_read(&mut cx, &mut []), Poll::Ready(Ok(0))),
			"the pump holds bytes: ready"
		);
	}

	// Failure mode: a read that finds the feed empty reads the engine pipe
	// after letting the feed's lock go, so a holder's poll of the pump on
	// another thread (the pi bash tool's extras read on tokio tasks of their
	// own) moves the engine pipe's next bytes into the OS pipe in between, and
	// the read takes the bytes after them. A hook runs such a poll at that
	// point, then more bytes arrive in the engine pipe: the read must still
	// take the first bytes, and every byte must come once, in order.
	#[test]
	fn a_holders_poll_on_another_thread_moves_no_byte_past_a_read_of_the_engine_pipe() {
		const WORDS: u32 = 4 << 10;
		let (read, write, feed) = fed_engine_pipe();
		let mut cx = Context::from_waker(Waker::noop());
		let bytes: Vec<u8> = (0..WORDS).flat_map(u32::to_be_bytes).collect();
		let half = bytes.len() / 2;
		assert!(matches!(write.poll_write(&mut cx, &bytes[..half]), Poll::Ready(Ok(n)) if n == half));
		// The other holder: one poll of the pump on its own thread, when asked.
		let (go, polls) = std::sync::mpsc::channel::<()>();
		let (polled, done) = std::sync::mpsc::channel::<()>();
		let holder = {
			let feed = Arc::clone(&feed);
			std::thread::spawn(move || {
				let cx = Context::from_waker(Waker::noop());
				let mut key = WaitKey::default();
				while polls.recv().is_ok() {
					feed.poll(&cx, &mut key);
					let _ = polled.send(());
				}
			})
		};
		let more = write.clone();
		let rest = bytes[half..].to_vec();
		let mut fired = false;
		crate::bash::BEFORE_DIRECT_READ.with_borrow_mut(|hook| {
			*hook = Some(Box::new(move || {
				if std::mem::replace(&mut fired, true) {
					return;
				}
				go.send(()).unwrap();
				// Done at once where nothing holds the feed's lock; where this
				// read holds it, the poll waits for the read.
				let _ = done.recv_timeout(std::time::Duration::from_secs(2));
				let mut cx = Context::from_waker(Waker::noop());
				assert!(
					matches!(more.poll_write(&mut cx, &rest), Poll::Ready(Ok(n)) if n == rest.len())
				);
			}));
		});
		let mut got = Vec::with_capacity(bytes.len());
		let mut buf = [0u8; 4096];
		let mut key = WaitKey::default();
		let mut idle = 0;
		while got.len() < bytes.len() {
			match read.poll_read(&mut cx, &mut buf) {
				Poll::Ready(Ok(n)) if n > 0 => {
					got.extend_from_slice(&buf[..n]);
					idle = 0;
				},
				Poll::Ready(other) => panic!("read: {other:?}"),
				Poll::Pending => {
					feed.poll(&cx, &mut key);
					idle += 1;
					assert!(idle < 10_000, "no progress at {} of {} bytes", got.len(), bytes.len());
				},
			}
		}
		// Dropping the hook drops `go`: the holder's thread ends.
		crate::bash::BEFORE_DIRECT_READ.with_borrow_mut(|hook| *hook = None);
		holder.join().unwrap();
		let first_wrong = got
			.chunks(4)
			.zip(0u32..)
			.find(|(w, i)| *w != i.to_be_bytes());
		assert!(first_wrong.is_none(), "out of order at word {:?}", first_wrong.map(|(_, i)| i));
	}

	/// Read `want` bytes through `read`, moving `feeds` on whenever the read
	/// waits, as their holders' polls do; fails after 30 s.
	fn read_all(read: &FdRef, feeds: &[&Arc<Feed>], want: usize) -> Vec<u8> {
		let mut cx = Context::from_waker(Waker::noop());
		let mut key = WaitKey::default();
		let mut got = Vec::with_capacity(want);
		let mut buf = [0u8; 4096];
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
		while got.len() < want {
			match read.poll_read(&mut cx, &mut buf) {
				Poll::Ready(Ok(n)) if n > 0 => got.extend_from_slice(&buf[..n]),
				Poll::Ready(other) => panic!("read: {other:?} at {} of {want} bytes", got.len()),
				Poll::Pending => {
					assert!(
						std::time::Instant::now() < deadline,
						"no progress at {} of {want} bytes",
						got.len()
					);
					for feed in feeds {
						feed.poll(&cx, &mut key);
					}
					std::thread::sleep(std::time::Duration::from_millis(1));
				},
			}
		}
		got
	}

	// Failure mode: while the pump's write is in hand (on Linux the room's
	// thread has it and has not run yet) and the OS pipe is empty, a read
	// answers end of file, or a zero-length read takes readiness from the OS
	// pipe alone; one kernel pipe holding those bytes answers "not yet" to
	// the read and "ready" to the zero-length one. The pump's write is held
	// here, so the state stays while the shell reads.
	#[test]
	fn a_read_while_the_pumps_write_is_in_hand_waits_for_it_and_is_ready() {
		let (read, write, feed) = fed_engine_pipe();
		let mut cx = Context::from_waker(Waker::noop());
		let bytes = b"bytes the pump holds\n";
		assert!(matches!(write.poll_write(&mut cx, bytes), Poll::Ready(Ok(n)) if n == bytes.len()));
		feed
			.state
			.lock()
			.pipe
			.as_mut()
			.expect("the pump's end")
			.hold_writes(true);
		let mut key = WaitKey::default();
		feed.poll(&cx, &mut key);
		assert_eq!(feed.state.lock().chunk.pending(), bytes, "the pump holds the bytes");
		assert_eq!(feed.drain.as_ref().expect("a drain").available(), 0, "the OS pipe is empty");
		assert!(
			read.poll_read_direct(&mut cx, &mut []).is_pending(),
			"the engine pipe is empty, its writer open"
		);
		assert!(
			matches!(read.poll_read(&mut cx, &mut []), Poll::Ready(Ok(0))),
			"the pump holds bytes: ready"
		);
		let mut buf = [0u8; 64];
		assert!(
			read.poll_read(&mut cx, &mut buf).is_pending(),
			"not end of file: the pump's bytes come"
		);
		feed
			.state
			.lock()
			.pipe
			.as_mut()
			.expect("the pump's end")
			.hold_writes(false);
		assert_eq!(read_all(&read, &[&feed], bytes.len()), bytes, "the pump's bytes, once");
	}

	// Failure mode: a read asks only the pipe's first feed. When another fd
	// object of the pipe (a `/dev/fd/N` copy handed to another external) has
	// a feed of its own holding the next bytes, the read takes the engine
	// pipe's bytes after them.
	#[test]
	fn a_read_asks_every_feed_of_the_pipe() {
		const WORDS: u32 = 1024;
		let (read, write) = FdRef::engine_pipe();
		let first = Arc::new(Feed::new(read.clone()).expect("a feed"));
		let second = Arc::new(Feed::new(read.clone()).expect("a feed"));
		assert!(first.reads_through() && second.reads_through(), "both have a drain");
		for feed in [&first, &second] {
			let weak: std::sync::Weak<dyn FeedRead> = Arc::downgrade(feed) as _;
			read.attach_feed(weak);
		}
		let mut cx = Context::from_waker(Waker::noop());
		let bytes: Vec<u8> = (0..WORDS).flat_map(u32::to_be_bytes).collect();
		let half = bytes.len() / 2;
		assert!(matches!(write.poll_write(&mut cx, &bytes[..half]), Poll::Ready(Ok(n)) if n == half));
		// The second feed's pump takes the first half into its OS pipe.
		second.poll(&cx, &mut WaitKey::default());
		assert_eq!(
			second.drain.as_ref().expect("a drain").available(),
			half,
			"the second feed holds the first half"
		);
		assert!(matches!(write.poll_write(&mut cx, &bytes[half..]), Poll::Ready(Ok(n)) if n == half));
		let got = read_all(&read, &[&first, &second], bytes.len());
		let first_wrong = got
			.chunks(4)
			.zip(0u32..)
			.find(|(w, i)| *w != i.to_be_bytes());
		assert!(first_wrong.is_none(), "out of order at word {:?}", first_wrong.map(|(_, i)| i));
	}
}
