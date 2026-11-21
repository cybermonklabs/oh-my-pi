//! Windows: an anonymous pipe both externals inherit, as the children of
//! `cmd` or bash get one.
//!
//! Its ends are synchronous handles: a program reads and writes its stdio
//! with plain `ReadFile` and `WriteFile`, which an overlapped handle fails.
//! A pipe end has no second file object to open (`ReOpenFile` and a second
//! client open are refused, and overlapped I/O is a property of the file
//! object), so the shell's own I/O uses the same synchronous file objects, in
//! a way that does not wait on the engine's thread:
//!
//! - A read takes only what `PeekNamedPipe` says the pipe holds. With nothing
//!   there, the end's worker thread waits with a zero-byte `ReadFile`, which
//!   returns once the pipe holds bytes or every writer is gone and takes
//!   nothing, and wakes every waiting task. No byte is read for the shell
//!   unless a task asks for it then, so an external that takes the read end
//!   later reads everything after what the shell read.
//! - A write goes straight to the pipe when it has room for it
//!   (`WriteQuotaAvailable`), which never waits. Otherwise the bytes are
//!   queued, and the worker writes them, waiting while the pipe is full; the
//!   end has no OS handle for an external while bytes wait there, so an
//!   external that takes it then is pumped behind them, in order. A write the
//!   worker could not make (the reader is gone) fails the next write or flush.
//! - An empty write asks whether the reader is gone (`BrokenPipe`, from the
//!   pipe's state). Room is reported whenever the queue has some: Windows tells
//!   a full pipe from one whose reader waits with a large read only by writing,
//!   and a write never waits on the engine anyway.
//!
//! Synchronous I/O on one file object is serialized: while the worker waits,
//! an external reading the same end waits for it, until bytes come. The
//! engine's own peek, read, query and write of an end happen with no call of
//! that end's worker in flight; they can wait only behind an external that
//! reads or writes the same end at that moment, as two readers or writers of
//! one pipe race anyway.
//!
//! Dropping the end cancels its worker's wait (`CancelSynchronousIo`; a
//! cancelled zero-byte read took nothing), and lets the worker finish writing
//! what was queued. A worker caught between taking its wait and entering the
//! call, where no cancel reaches it, is cancelled by a reaper thread once it
//! is in the call.

use std::{
	collections::VecDeque,
	ffi::c_void,
	fs,
	io::{self, SeekFrom},
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr,
	sync::Arc,
	task::{Context, Poll, Waker},
	thread,
	time::Duration,
};

use parking_lot::{Condvar, Mutex};
use windows_sys::Win32::{
	Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED, HANDLE, NTSTATUS},
	Storage::FileSystem::{ReadFile, WriteFile},
	System::{
		IO::CancelSynchronousIo,
		Pipes::{CreatePipe, PeekNamedPipe},
	},
};

use crate::{
	bash::{File, FileKind, OsHandle, Stat},
	sys::fs::stat_of,
};

/// The pipe's buffer. A reader waiting in `ReadFile` takes its read's size
/// off the room a writer sees (`WriteQuotaAvailable`), so the buffer is
/// larger than any read a program waits with, and the shell's writes find
/// room and go straight to the pipe.
const PIPE_SIZE: u32 = 1 << 20;

/// Most bytes queued for the worker, and the most one of its writes moves.
const QUEUE_MAX: usize = 64 << 10;

/// Stack of an end's worker thread: it only calls the OS.
const WORKER_STACK: usize = 64 << 10;

/// [`super::os_pipe`] on Windows.
pub fn os_pipe(prefill: &[u8]) -> Option<(Box<dyn File>, Box<dyn File>)> {
	let (read, write) = ends(prefill)?;
	Some((Box::new(read), Box::new(write)))
}

/// The pipe's two ends, `(read, write)`.
fn ends(prefill: &[u8]) -> Option<(Shared, Shared)> {
	let (mut r, mut w): (HANDLE, HANDLE) = (ptr::null_mut(), ptr::null_mut());
	// SAFETY: out-pointers to two handles; no security attributes, so
	// neither end is inheritable (the spawner gives a child a duplicate).
	if unsafe { CreatePipe(&raw mut r, &raw mut w, ptr::null(), PIPE_SIZE) } == 0 {
		return None;
	}
	// SAFETY: two fresh handles nobody else owns.
	let (read, write) =
		unsafe { (OwnedHandle::from_raw_handle(r), OwnedHandle::from_raw_handle(w)) };
	let (read, write) = (fs::File::from(read), fs::File::from(write));
	if !prefill.is_empty() {
		// Nobody reads yet, so a write that does not fit would wait forever:
		// a prefill larger than the room means this pipe cannot hold what the
		// memory pipe had.
		let room = pipe_info(&write).ok()?.write_quota_available as usize;
		if prefill.len() > room || write_once(&write, prefill).ok()? != prefill.len() {
			return None;
		}
	}
	let own = |file: &fs::File, write| file.try_clone().map(|f| Private::new(f, write)).ok();
	let (reads, writes) = (own(&read, false)?, own(&write, true)?);
	Some((Shared { file: read, own: reads }, Shared { file: write, own: writes }))
}

/// `FILE_PIPE_LOCAL_INFORMATION`.
#[repr(C)]
#[derive(Default)]
struct PipeInfo {
	named_pipe_type:          u32,
	named_pipe_configuration: u32,
	maximum_instances:        u32,
	current_instances:        u32,
	inbound_quota:            u32,
	read_data_available:      u32,
	outbound_quota:           u32,
	write_quota_available:    u32,
	named_pipe_state:         u32,
	named_pipe_end:           u32,
}

/// `FilePipeLocalInformation`.
const FILE_PIPE_LOCAL_INFORMATION: u32 = 24;
/// `FILE_PIPE_CLOSING_STATE`: the other end is closed.
const FILE_PIPE_CLOSING_STATE: u32 = 4;

#[link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")]
unsafe extern "system" {
	/// Documented in the WDK; `windows-sys` has it only with WDK features.
	fn NtQueryInformationFile(
		file: HANDLE,
		status: *mut [usize; 2],
		info: *mut c_void,
		len: u32,
		class: u32,
	) -> NTSTATUS;
	/// The Win32 error code of an `NTSTATUS`.
	fn RtlNtStatusToDosError(status: NTSTATUS) -> u32;
}

fn raw(file: &fs::File) -> HANDLE {
	file.as_raw_handle()
}

/// The pipe's state as `file`'s end sees it (`FILE_READ_ATTRIBUTES`, which
/// both ends of an anonymous pipe have).
fn pipe_info(file: &fs::File) -> io::Result<PipeInfo> {
	let mut status = [0usize; 2];
	let mut info = PipeInfo::default();
	// SAFETY: valid out-pointers, sized for the class asked.
	let st = unsafe {
		NtQueryInformationFile(
			raw(file),
			&raw mut status,
			(&raw mut info).cast(),
			size_of::<PipeInfo>() as u32,
			FILE_PIPE_LOCAL_INFORMATION,
		)
	};
	if st < 0 {
		// SAFETY: a plain conversion of a status code.
		return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(st) } as i32));
	}
	Ok(info)
}

/// Every writer is gone (a read) or every reader is (a write).
fn hung_up(e: &io::Error) -> bool {
	[ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED]
		.iter()
		.any(|&code| e.raw_os_error() == Some(code as i32))
}

/// What the pipe holds, without waiting (`Err` with [`hung_up`] when it is
/// empty and every writer is gone).
fn peek(file: &fs::File) -> io::Result<usize> {
	let mut held = 0u32;
	// SAFETY: a zero-size peek takes no buffer and reports the bytes held.
	let ok = unsafe {
		PeekNamedPipe(raw(file), ptr::null_mut(), 0, ptr::null_mut(), &raw mut held, ptr::null_mut())
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(held as usize)
}

/// One synchronous `ReadFile` into `buf` (zero-size: wait for bytes).
fn read_once(file: &fs::File, buf: &mut [u8]) -> io::Result<usize> {
	let mut got = 0u32;
	// SAFETY: `buf` is valid for its length; a synchronous call.
	let ok = unsafe {
		ReadFile(raw(file), buf.as_mut_ptr(), buf.len() as u32, &raw mut got, ptr::null_mut())
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(got as usize)
}

/// One synchronous `WriteFile` of `buf`, never empty; a gone reader is
/// `BrokenPipe`.
fn write_once(file: &fs::File, buf: &[u8]) -> io::Result<usize> {
	let mut put = 0u32;
	// SAFETY: `buf` is valid for its length; a synchronous call.
	let ok = unsafe {
		WriteFile(raw(file), buf.as_ptr(), buf.len() as u32, &raw mut put, ptr::null_mut())
	};
	if ok == 0 {
		let e = io::Error::last_os_error();
		return Err(if hung_up(&e) {
			io::ErrorKind::BrokenPipe.into()
		} else {
			e
		});
	}
	Ok(put as usize)
}

/// One end of the pipe as the shell holds it: the handle externals inherit
/// ([`File::os_handle`]), and the private end made with it, through which
/// every engine handle of the end reads or writes.
struct Shared {
	file: fs::File,
	own:  Private,
}

impl File for Shared {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.own.poll_read(cx, buf)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.own.poll_write(cx, buf)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.own.poll_flush(cx)
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::NotSeekable.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	/// The handle externals inherit; none while bytes the shell wrote wait
	/// for the worker, so an external that takes the end then is pumped
	/// behind them.
	fn os_handle(&self) -> Option<OsHandle> {
		let st = self.own.work.st.lock();
		(st.queue.is_empty() && !st.writing)
			.then(|| OsHandle(self.file.as_raw_handle().addr() as u64))
	}

	fn stat(&self) -> io::Result<Stat> {
		self.file.metadata().map(|m| stat_of(&m))
	}

	/// Another private end on a handle of its own (it can fail). The engine
	/// never asks: its handles of an end share this one's.
	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Private::new(self.file.try_clone()?, self.own.write)))
	}
}

#[derive(Default)]
struct WorkState {
	/// A zero-byte read is asked for or in flight.
	waiting: bool,
	/// Bytes accepted from the engine, not yet in the pipe.
	queue:   VecDeque<u8>,
	/// The worker is writing the queue's head.
	writing: bool,
	/// A queued write failed: reported to the next write or flush.
	failed:  Option<io::ErrorKind>,
	/// Every task waiting on the end: all are woken on progress, and a task
	/// is only ever forgotten by waking it (one waker can stand for several
	/// engine vprocs).
	wakers:  Vec<Waker>,
	/// The worker is in a call `CancelSynchronousIo` can end.
	busy:    bool,
	/// The end is gone: the worker finishes the queue and ends.
	quit:    bool,
}

/// Most wakers one end keeps at once. Past it, every stored waker is woken
/// and forgotten: a live task polls again and waits anew, and the waker of a
/// task dropped while it waited goes.
const MAX_WAITERS: usize = 64;

impl WorkState {
	/// Store `waker` among the tasks waiting on the end, once (an equal waker
	/// is not repeated).
	fn wait_with(&mut self, waker: &Waker) {
		if self.wakers.iter().any(|w| w.will_wake(waker)) {
			return;
		}
		if self.wakers.len() >= MAX_WAITERS {
			self.wake_all();
		}
		self.wakers.push(waker.clone());
	}

	fn wake_all(&mut self) {
		for w in self.wakers.drain(..) {
			w.wake();
		}
	}
}

/// What an end shares with its worker thread.
struct Work {
	/// The end's own handle (the same file object as the externals'); it
	/// keeps the end open until the worker is done with it.
	file: fs::File,
	st:   Mutex<WorkState>,
	cv:   Condvar,
}

/// The shell's end of one side: its I/O never waits on the engine thread.
struct Private {
	write:  bool,
	work:   Arc<Work>,
	/// Started with the first wait or queued write.
	worker: Option<thread::JoinHandle<()>>,
}

impl Private {
	fn new(file: fs::File, write: bool) -> Self {
		Self {
			write,
			work: Arc::new(Work { file, st: Mutex::default(), cv: Condvar::new() }),
			worker: None,
		}
	}

	/// Start the worker if it is not running, and tell it there is work.
	fn kick(&mut self) -> io::Result<()> {
		if self.worker.is_none() {
			let work = Arc::clone(&self.work);
			self.worker = Some(
				thread::Builder::new()
					.name("obash-stage-pipe".into())
					.stack_size(WORKER_STACK)
					.spawn(move || run(&work))?,
			);
		}
		self.work.cv.notify_one();
		Ok(())
	}

	/// Ask the worker to wait for bytes; `Pending` once asked.
	fn wait_readable(&mut self, cx: &Context<'_>) -> Poll<io::Result<usize>> {
		{
			let mut st = self.work.st.lock();
			st.waiting = true;
			st.wait_with(cx.waker());
		}
		match self.kick() {
			Ok(()) => Poll::Pending,
			Err(e) => {
				self.work.st.lock().waiting = false;
				Poll::Ready(Err(e))
			},
		}
	}

	/// Queue what fits of `buf` for the worker.
	fn queue(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let n = {
			let mut st = self.work.st.lock();
			let n = buf.len().min(QUEUE_MAX.saturating_sub(st.queue.len()));
			if n == 0 {
				st.wait_with(cx.waker());
				return Poll::Pending;
			}
			st.queue.extend(&buf[..n]);
			n
		};
		self.kick().map(|()| n).into()
	}
}

/// A worker: waits for bytes and writes the queue, until its end is gone
/// and the queue written.
fn run(work: &Work) {
	let mut st = work.st.lock();
	loop {
		if st.waiting && !st.quit {
			st.busy = true;
			drop(st);
			// Returns once there are bytes (taking none), every writer is gone,
			// or the end is dropped (cancelled).
			let _ = read_once(&work.file, &mut []);
			st = work.st.lock();
			st.busy = false;
			st.waiting = false;
			st.wake_all();
			continue;
		}
		if !st.queue.is_empty() && st.failed.is_none() {
			let chunk: Vec<u8> = st.queue.iter().take(QUEUE_MAX).copied().collect();
			st.writing = true;
			drop(st);
			let r = write_once(&work.file, &chunk);
			st = work.st.lock();
			st.writing = false;
			match r {
				Ok(n) => {
					let n = n.min(st.queue.len());
					st.queue.drain(..n);
				},
				Err(e) => {
					st.failed = Some(e.kind());
					st.queue.clear();
				},
			}
			st.wake_all();
			continue;
		}
		if st.quit {
			return;
		}
		work.cv.wait(&mut st);
	}
}

impl File for Private {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if self.write {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		{
			let mut st = self.work.st.lock();
			if st.waiting {
				st.wait_with(cx.waker());
				return Poll::Pending;
			}
		}
		match peek(&self.work.file) {
			Err(e) if hung_up(&e) => Poll::Ready(Ok(0)),
			Err(e) => Poll::Ready(Err(e)),
			Ok(0) => self.wait_readable(cx),
			// A zero-length read asks whether the pipe is readable.
			Ok(_) if buf.is_empty() => Poll::Ready(Ok(0)),
			Ok(held) => {
				let n = buf.len().min(held);
				Poll::Ready(match read_once(&self.work.file, &mut buf[..n]) {
					Err(e) if hung_up(&e) => Ok(0),
					r => r,
				})
			},
		}
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if !self.write {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		{
			let mut st = self.work.st.lock();
			if let Some(kind) = st.failed {
				return Poll::Ready(Err(kind.into()));
			}
			if !st.queue.is_empty() || st.writing {
				if buf.is_empty() {
					// Room in the queue is room for a write.
					if st.queue.len() < QUEUE_MAX {
						return Poll::Ready(Ok(0));
					}
					st.wait_with(cx.waker());
					return Poll::Pending;
				}
				drop(st);
				return self.queue(cx, buf);
			}
		}
		// The worker is idle: nothing of ours holds the file object.
		let info = match pipe_info(&self.work.file) {
			Ok(info) => info,
			Err(e) => return Poll::Ready(Err(e)),
		};
		if info.named_pipe_state == FILE_PIPE_CLOSING_STATE {
			return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
		}
		if buf.is_empty() {
			return Poll::Ready(Ok(0));
		}
		let room = info.write_quota_available as usize;
		if room == 0 {
			return self.queue(cx, buf);
		}
		// It fits, so the write does not wait.
		Poll::Ready(write_once(&self.work.file, &buf[..buf.len().min(room)]))
	}

	/// Ready once every byte queued is in the pipe; then a write the worker
	/// could not make fails it.
	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		let mut st = self.work.st.lock();
		if !st.queue.is_empty() || st.writing {
			st.wait_with(cx.waker());
			return Poll::Pending;
		}
		Poll::Ready(st.failed.map_or(Ok(()), |kind| Err(kind.into())))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::NotSeekable.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	/// The external gets the [`Shared`] handle, never this one.
	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn stat(&self) -> io::Result<Stat> {
		self.work.file.metadata().map(|m| stat_of(&m))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self::new(self.work.file.try_clone()?, self.write)))
	}
}

/// Cancel the worker's zero-byte read. `true` once nothing is left to cancel:
/// the worker is not in its wait, has ended, or the cancel reached its call.
/// `false` while the worker has taken the wait but is not in `ReadFile` yet
/// (or waits for the file object behind an external's read), where
/// `CancelSynchronousIo` finds nothing.
fn cancel_wait(work: &Work, worker: &thread::JoinHandle<()>) -> bool {
	{
		let st = work.st.lock();
		if !(st.busy && st.waiting) || worker.is_finished() {
			return true;
		}
	}
	// SAFETY: the worker's thread handle, open while `worker` lives.
	unsafe { CancelSynchronousIo(worker.as_raw_handle()) != 0 }
}

/// How often a reaper tries again to cancel a worker that is not in its call.
const CANCEL_RETRY: Duration = Duration::from_millis(1);

impl Drop for Private {
	/// Never waits: a wait in flight is cancelled; queued bytes are left to
	/// the worker, which writes them and ends. A worker that has taken its
	/// wait but is not in the call yet is left to a reaper thread, which
	/// cancels the call once the worker is in it.
	fn drop(&mut self) {
		let Some(worker) = self.worker.take() else {
			return;
		};
		self.work.st.lock().quit = true;
		self.work.cv.notify_all();
		if cancel_wait(&self.work, &worker) {
			return;
		}
		let work = Arc::clone(&self.work);
		// A reaper that cannot start leaves the worker waiting until bytes or
		// end of file come.
		let _ = thread::Builder::new()
			.name("obash-stage-pipe-reaper".into())
			.stack_size(WORKER_STACK)
			.spawn(move || {
				while !cancel_wait(&work, &worker) {
					thread::sleep(CANCEL_RETRY);
				}
			});
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Write},
		os::windows::io::BorrowedHandle,
		sync::atomic::{AtomicUsize, Ordering},
		task::Wake,
	};

	use super::*;

	fn noop() -> Context<'static> {
		Context::from_waker(Waker::noop())
	}

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

	/// Wait until `done`, failing the test after 30 s instead of hanging.
	fn until(what: &str, mut done: impl FnMut() -> bool) {
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
		while !done() {
			assert!(std::time::Instant::now() < deadline, "{what}: not within 30 s");
			thread::sleep(std::time::Duration::from_millis(1));
		}
	}

	/// What an external holds: a duplicate of the end's handle (synchronous).
	fn external(end: &dyn File) -> fs::File {
		let handle = end.os_handle().expect("an OS handle");
		let raw = ptr::with_exposed_provenance_mut::<c_void>(handle.0 as usize);
		// SAFETY: `end` owns the handle and outlives this borrow; the
		// duplicate is ours.
		let borrowed = unsafe { BorrowedHandle::borrow_raw(raw) };
		fs::File::from(borrowed.try_clone_to_owned().expect("duplicate the handle"))
	}

	// Failure mode: the shell's read of an empty pipe waits in `ReadFile` on
	// the engine's thread, or its worker's wait takes bytes an external that
	// reads the end next should get, or end of file never comes.
	#[test]
	fn an_empty_read_waits_on_the_worker_and_takes_nothing() {
		let (mut r, w) = ends(b"").unwrap();
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		let mut cx = Context::from_waker(&waker);
		let mut buf = [0u8; 8];
		assert!(r.poll_read(&mut cx, &mut buf).is_pending(), "nothing to read yet");
		assert!(r.poll_read(&mut cx, &mut []).is_pending(), "zero-length: not readable yet");
		external(&w).write_all(b"abc").unwrap();
		until("the reader is woken", || count.wakes() > 0);
		assert_eq!(peek(&r.file).unwrap(), 3, "the worker's wait took none of the bytes");
		assert!(matches!(r.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(3))));
		assert_eq!(&buf[..3], b"abc");
		assert!(r.poll_read(&mut cx, &mut buf).is_pending(), "empty again");
		external(&w).write_all(b"d").unwrap();
		until("the reader is woken again", || count.wakes() > 1);
		assert!(matches!(r.poll_read(&mut cx, &mut []), Poll::Ready(Ok(0))), "readable");
		assert!(matches!(r.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(1))));
		drop(w);
		assert!(matches!(r.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(0))), "end of file");
	}

	// Failure mode: a write the pipe has room for waits for a worker (an
	// external spawned next would be pumped), a write to a full pipe waits on
	// the engine's thread, queued bytes come out of order, or an external
	// takes the end while the shell's bytes wait and writes ahead of them.
	#[test]
	fn writes_go_straight_or_are_queued_in_order() {
		let (r, mut w) = ends(b"").unwrap();
		assert!(matches!(w.poll_write(&mut noop(), b"first "), Poll::Ready(Ok(6))));
		assert!(w.own.worker.is_none(), "a write the pipe has room for goes straight to it");
		assert!(w.os_handle().is_some(), "nothing waits: externals share the end");
		let chunk = vec![7u8; 64 << 10];
		let mut put = 6;
		while w.os_handle().is_some() {
			match w.poll_write(&mut noop(), &chunk) {
				Poll::Ready(Ok(n)) => put += n,
				other => panic!("a write before the queue fills: {other:?}"),
			}
			assert!(put < 64 << 20, "the pipe never filled");
		}
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		loop {
			match w.poll_write(&mut Context::from_waker(&waker), &chunk) {
				Poll::Ready(Ok(n)) => put += n,
				Poll::Pending => break,
				Poll::Ready(Err(e)) => panic!("write: {e}"),
			}
		}
		assert!(w.os_handle().is_none(), "queued bytes keep the end from externals");
		let mut all = vec![0u8; put];
		external(&r).read_exact(&mut all).unwrap();
		assert_eq!(&all[..6], b"first ");
		assert!(all[6..].iter().all(|&b| b == 7));
		until("the queue is written", || w.os_handle().is_some());
		assert!(count.wakes() > 0, "the waiting writer was woken");
		assert!(matches!(w.poll_flush(&mut noop()), Poll::Ready(Ok(()))));
	}

	// Failure mode: a write, or an empty write asking for the reader, to a
	// pipe nobody reads any more succeeds instead of failing as `EPIPE`; or
	// a queued write that failed is never reported.
	#[test]
	fn a_gone_reader_is_a_broken_pipe() {
		let (r, mut w) = os_pipe(b"").unwrap();
		assert!(matches!(w.poll_write(&mut noop(), b""), Poll::Ready(Ok(0))), "a reader");
		drop(r);
		for buf in [&b""[..], b"x"] {
			let Poll::Ready(Err(e)) = w.poll_write(&mut noop(), buf) else {
				panic!("a write of {buf:?} with no reader fails");
			};
			assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
		}
		let (r, mut w) = os_pipe(b"").unwrap();
		let chunk = vec![1u8; 64 << 10];
		let count = Arc::new(Count::default());
		let waker = Waker::from(Arc::clone(&count));
		while w
			.poll_write(&mut Context::from_waker(&waker), &chunk)
			.is_ready()
		{}
		drop(r);
		until("the worker sees the reader gone", || count.wakes() > 0);
		let Poll::Ready(Err(e)) = w.poll_write(&mut noop(), b"x") else {
			panic!("a write after a queued one failed");
		};
		assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
	}

	// Failure mode: bytes the memory pipe held are lost or reordered, or a
	// prefill larger than the pipe waits forever.
	#[test]
	fn the_prefill_comes_first_and_one_that_does_not_fit_is_refused() {
		let (r, w) = os_pipe(b"held ").unwrap();
		external(w.as_ref()).write_all(b"then more").unwrap();
		drop(w);
		let mut all = Vec::new();
		external(r.as_ref()).read_to_end(&mut all).unwrap();
		assert_eq!(all, b"held then more");
		assert!(os_pipe(&vec![1u8; 2 << 20]).is_none(), "2 MiB does not fit in the pipe");
	}

	// Failure mode: a dropped reader's worker goes on waiting with its handle
	// of the read end open, so a writer never learns its reader is gone. The
	// drop comes once the worker has taken its wait: one dropped before never
	// starts it, and would pass without any cancel.
	#[test]
	fn dropping_a_waiting_reader_closes_its_end() {
		let (mut r, mut w) = ends(b"").unwrap();
		assert!(r.poll_read(&mut noop(), &mut [0u8; 8]).is_pending(), "the worker waits");
		until("the worker takes its wait", || r.own.work.st.lock().busy);
		drop(r);
		until("the writer sees the reader gone", || {
			matches!(w.poll_write(&mut noop(), b""), Poll::Ready(Err(_)))
		});
	}

	// Failure mode: a drop while the worker has taken its wait but is not in
	// `ReadFile` yet finds nothing to cancel, and the worker then waits in the
	// call for good, holding the read end open. The worker here is held
	// before its call until the end is dropped.
	#[test]
	fn a_worker_not_yet_in_its_call_is_cancelled_once_it_is() {
		let (r, _w) = ends(b"").unwrap();
		let st = WorkState { waiting: true, busy: true, ..WorkState::default() };
		let work = Arc::new(Work {
			file: r.file.try_clone().unwrap(),
			st:   Mutex::new(st),
			cv:   Condvar::new(),
		});
		let (go, held) = std::sync::mpsc::channel::<()>();
		let cancelled = Arc::new(AtomicUsize::new(0));
		let worker = {
			let (work, cancelled) = (Arc::clone(&work), Arc::clone(&cancelled));
			thread::spawn(move || {
				held.recv().unwrap();
				let read = read_once(&work.file, &mut []);
				work.st.lock().busy = false;
				cancelled.store(if read.is_err() { 1 } else { 2 }, Ordering::SeqCst);
			})
		};
		drop(Private { write: false, work, worker: Some(worker) });
		go.send(()).unwrap();
		until("the worker's call is cancelled", || cancelled.load(Ordering::SeqCst) == 1);
	}

	// Failure mode: every task dropped while it waited on an idle end keeps
	// its waker stored for good, or a cap forgets a waiting task without
	// waking it, or a task whose waker equals another's (the engine's vprocs
	// share one) loses its wait to the other's progress.
	#[test]
	fn tasks_waiting_on_an_idle_end_stay_bounded_and_are_all_woken() {
		let (mut r, w) = ends(b"").unwrap();
		let counts: Vec<Arc<Count>> = (0..200).map(|_| Arc::default()).collect();
		let mut buf = [0u8; 8];
		for count in &counts {
			let waker = Waker::from(Arc::clone(count));
			assert!(
				r.poll_read(&mut Context::from_waker(&waker), &mut buf)
					.is_pending()
			);
			assert!(
				r.own.work.st.lock().wakers.len() <= MAX_WAITERS,
				"the stored wakers stay bounded"
			);
		}
		external(&w).write_all(b"x").unwrap();
		until("every waiting task is woken", || counts.iter().all(|c| c.wakes() > 0));
	}
}
