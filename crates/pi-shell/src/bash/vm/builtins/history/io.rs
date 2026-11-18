//! The filesystem steps of history file operations (zsh `readhistfile`,
//! `savehistfile`, `lockhistfile`; bash `history -a -n -r -w`).
//!
//! A history operation is written as a pure function of the answers to the
//! steps it asked for so far ([`Steps`]): it runs from the start each time
//! a step is answered, like a pollable builtin, and commits its result only
//! once every step it needs has an answer. Each step is a
//! [`Probe::Hist`] carrying its position in the sequence, so asking for the
//! same operation twice (a lock retried after a sleep) is two probes.
//! [`perform`] carries a step out through the pollable [`Fs`] and the host
//! clock without blocking.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::{
	Unsettled, diag,
	fs::{FsPoll, OpenFlags, Stat},
	host::Deadline,
	vm::{
		Cx,
		proc::{Live, Probe, ProbeResult, Scratch},
	},
};

/// One filesystem or clock step of a history operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistOp {
	/// `stat` (`follow`) or `lstat`.
	Stat {
		/// Absolute path.
		path:   BString,
		/// Follow a final symbolic link.
		follow: bool,
	},
	/// The whole contents of a file.
	Read {
		/// Absolute path.
		path: BString,
	},
	/// Write `data` to a file opened as `how` says, with `mode` for a new
	/// file.
	Write {
		/// Absolute path.
		path: BString,
		/// The bytes.
		data: BString,
		/// How the file is opened.
		how:  WriteHow,
		/// Permission bits of a created file.
		mode: u32,
	},
	/// `unlink`.
	Unlink {
		/// Absolute path.
		path: BString,
	},
	/// `rename`.
	Rename {
		/// Absolute path renamed.
		from: BString,
		/// Absolute path replaced.
		to:   BString,
	},
	/// `symlink(target, path)`.
	Symlink {
		/// Link contents.
		target: BString,
		/// Absolute path created.
		path:   BString,
	},
	/// `link(from, to)`.
	Link {
		/// Existing file.
		from: BString,
		/// Absolute path created.
		to:   BString,
	},
	/// Take an `fcntl` record lock on the file (zsh `histfcntllock`), held
	/// until [`HistOp::Unlock`] or the end of the operation.
	Lock {
		/// Absolute path.
		path: BString,
	},
	/// Release the [`HistOp::Lock`] lock.
	Unlock,
	/// The canonical physical path ([`HistOut::Bytes`]).
	RealPath {
		/// Absolute path.
		path: BString,
	},
	/// Wait (the lock backoff of `zsleep_random`).
	Sleep {
		/// Nanoseconds.
		ns: u64,
	},
	/// The wall clock, whole seconds since the epoch.
	Now,
}

impl HistOp {
	/// The path the step works on (empty for clock steps), for the wait key.
	pub fn path(&self) -> BString {
		match self {
			Self::Stat { path, .. }
			| Self::Read { path }
			| Self::Write { path, .. }
			| Self::Unlink { path }
			| Self::Symlink { path, .. }
			| Self::Lock { path }
			| Self::RealPath { path } => path.clone(),
			Self::Rename { to, .. } | Self::Link { to, .. } => to.clone(),
			Self::Unlock | Self::Sleep { .. } | Self::Now => BString::default(),
		}
	}
}

/// How a [`HistOp::Write`] opens its file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteHow {
	/// `O_CREAT | O_TRUNC`.
	Trunc,
	/// `O_CREAT | O_APPEND`.
	Append,
	/// `O_CREAT | O_EXCL`.
	Excl,
}

/// What a successful step gives back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistOut {
	/// Done, nothing to report.
	Done,
	/// File metadata.
	Stat(Stat),
	/// File contents.
	Bytes(BString),
	/// Seconds since the epoch.
	Now(i64),
}

/// The class of a failed step's error, as the history code tests it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrKind {
	/// `ENOENT`.
	NotFound,
	/// `EEXIST`.
	Exists,
	/// The lock is held elsewhere.
	WouldBlock,
	/// Anything else.
	Other,
}

/// A failed step: its class and its `strerror` text (`%e`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistErr {
	/// Class.
	pub kind: ErrKind,
	/// `strerror` text.
	pub msg:  BString,
}

impl HistErr {
	fn of(e: &io::Error) -> Self {
		let kind = match e.kind() {
			io::ErrorKind::NotFound => ErrKind::NotFound,
			io::ErrorKind::AlreadyExists => ErrKind::Exists,
			io::ErrorKind::WouldBlock => ErrKind::WouldBlock,
			_ => ErrKind::Other,
		};
		let msg = match kind {
			ErrKind::NotFound => BString::from("no such file or directory"),
			ErrKind::Exists => BString::from("file exists"),
			_ => lower_first(&diag::strerror(e)),
		};
		Self { kind, msg }
	}
}

/// zsh's `%e`: the `strerror` text with its first letter lowered.
fn lower_first(s: &str) -> BString {
	let mut b = BString::from(s);
	if let Some(c) = b.first_mut() {
		c.make_ascii_lowercase();
	}
	b
}

/// The answer to one step.
pub type HistAnswer = Result<HistOut, HistErr>;

/// A step still to be answered: the probe to perform.
#[derive(Debug)]
pub struct Pending(pub Probe);

/// The answers a [`Steps`] reads: a builtin's or the reader's probe cache.
pub type Lookup<'a> = &'a dyn Fn(&Probe) -> Option<ProbeResult>;

/// The steps of one history operation, answered from the op's probe cache.
pub struct Steps<'a> {
	answers: Lookup<'a>,
	seq:     u32,
}

impl<'a> Steps<'a> {
	/// Steps answered by `answers`, numbered from `base + 1` (operations
	/// sharing one probe cache use distinct bases).
	pub fn new(answers: Lookup<'a>, base: u32) -> Self {
		Self { answers, seq: base }
	}

	/// The answer to the next step `op`, or the probe that gets it.
	///
	/// # Errors
	/// [`Pending`] while the step has no answer yet.
	pub fn ask(&mut self, op: HistOp) -> Result<HistAnswer, Pending> {
		self.seq += 1;
		let probe = Probe::Hist { seq: self.seq, op: Box::new(op) };
		match (self.answers)(&probe) {
			Some(ProbeResult::Hist(a)) => Ok(*a),
			_ => Err(Pending(probe)),
		}
	}

	/// The wall clock (one step).
	///
	/// # Errors
	/// [`Pending`] while unanswered.
	pub fn now(&mut self) -> Result<i64, Pending> {
		Ok(match self.ask(HistOp::Now)? {
			Ok(HistOut::Now(t)) => t,
			_ => 0,
		})
	}
}

/// Poll a just-started fs operation once, parking it in `live` (wrapped by
/// `wrap`) while pending.
fn ready<T>(
	p: FsPoll<T>,
	live: &mut Live,
	wrap: impl FnOnce(Box<dyn crate::bash::fs::FsPending<T>>) -> Live,
	tcx: &mut Context<'_>,
) -> Poll<io::Result<T>> {
	match p {
		FsPoll::Ready(r) => Poll::Ready(r),
		FsPoll::Pending(mut fut) => {
			let polled = fut.poll(tcx);
			if polled.is_pending() {
				*live = wrap(fut);
			}
			polled
		},
	}
}

/// Poll a unit fs operation started by `start` (kept in `sc.live` while
/// pending).
fn unit_op(
	tcx: &mut Context<'_>,
	sc: &mut Scratch,
	start: impl FnOnce() -> FsPoll<()>,
) -> Poll<HistAnswer> {
	let polled = match &mut sc.live {
		Live::Access(fut) => fut.poll(tcx),
		live => ready(start(), live, Live::Access, tcx),
	};
	polled.map(|r| r.map(|()| HistOut::Done).map_err(|e| HistErr::of(&e)))
}

/// Carry out step `op` of the probe in flight in `sc`; `Pending` parks
/// the caller (the fs or timer wakes the engine).
pub fn perform(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	op: &HistOp,
) -> Poll<HistAnswer> {
	match op {
		HistOp::Now => {
			let secs = cx.host.wall().secs;
			Poll::Ready(Ok(HistOut::Now(secs)))
		},
		HistOp::Stat { path, follow } => {
			let polled = match &mut sc.live {
				Live::Stat(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().stat(BStr::new(path), *follow);
					ready(started, live, Live::Stat, tcx)
				},
			};
			polled.map(|r| r.map(HistOut::Stat).map_err(|e| HistErr::of(&e)))
		},
		HistOp::Unlink { path } => unit_op(tcx, sc, || cx.host.fs().unlink(BStr::new(path))),
		HistOp::Rename { from, to } => {
			unit_op(tcx, sc, || cx.host.fs().rename(BStr::new(from), BStr::new(to)))
		},
		HistOp::Symlink { target, path } => {
			unit_op(tcx, sc, || cx.host.fs().symlink(BStr::new(target), BStr::new(path)))
		},
		HistOp::Link { from, to } => {
			unit_op(tcx, sc, || cx.host.fs().link(BStr::new(from), BStr::new(to)))
		},
		HistOp::Sleep { ns } => {
			if !matches!(sc.live, Live::Timer(_)) {
				let at = Deadline(cx.host.now_ns().saturating_add(*ns));
				sc.live = Live::Timer(cx.host.timer(at));
			}
			if let Live::Timer(timer) = &mut sc.live
				&& timer.poll(tcx).is_pending()
			{
				return Poll::Pending;
			}
			Poll::Ready(Ok(HistOut::Done))
		},
		HistOp::Unlock => {
			sc.io().zsh().hist_lock = None;
			Poll::Ready(Ok(HistOut::Done))
		},
		HistOp::Lock { path } => {
			let polled = match &mut sc.live {
				Live::Open(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().lock(BStr::new(path));
					ready(started, live, Live::Open, tcx)
				},
			};
			match polled {
				Poll::Pending => Poll::Pending,
				Poll::Ready(Ok(file)) => {
					sc.io().zsh().hist_lock = Some(file);
					Poll::Ready(Ok(HistOut::Done))
				},
				Poll::Ready(Err(e)) => Poll::Ready(Err(HistErr::of(&e))),
			}
		},
		HistOp::RealPath { path } => {
			let polled = match &mut sc.live {
				Live::Path(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().realpath(BStr::new(path));
					ready(started, live, Live::Path, tcx)
				},
			};
			polled.map(|r| r.map(HistOut::Bytes).map_err(|e| HistErr::of(&e)))
		},
		HistOp::Read { path } => read(tcx, cx, sc, path),
		HistOp::Write { path, data, how, mode } => write(tcx, cx, sc, path, data, *how, *mode),
	}
}

/// [`HistOp::Read`]: the file's bytes, read in chunks into the scratch.
fn read(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
) -> Poll<HistAnswer> {
	// The bytes so far, beside `sc.live` (the file).
	let input = &mut sc.io.get_or_insert_with(Box::default).input;
	loop {
		match &mut sc.live {
			Live::None => match cx.host.fs().open(BStr::new(path), OpenFlags::READ, 0) {
				FsPoll::Ready(Ok(f)) => sc.live = Live::File(f),
				FsPoll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				FsPoll::Pending(f) => sc.live = Live::Open(f),
			},
			Live::Open(f) => match f.poll(tcx) {
				Poll::Ready(Ok(file)) => sc.live = Live::File(file),
				Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				Poll::Pending => return Poll::Pending,
			},
			Live::File(f) => {
				let mut buf = [0u8; 16384];
				match f.poll_read(tcx, &mut buf) {
					Poll::Ready(Ok(0)) => {
						let data = std::mem::take(input);
						return Poll::Ready(Ok(HistOut::Bytes(BString::from(data))));
					},
					Poll::Ready(Ok(n)) => input.extend_from_slice(&buf[..n]),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
					Poll::Pending => return Poll::Pending,
				}
			},
			_ => sc.live = Live::None,
		}
	}
}

/// [`HistOp::Write`]: open, then write `data`. How much is written is a
/// count, kept as 8 bytes in the scratch's input buffer, which
/// [`crate::bash::vm::probe::begin`] empties when the probe begins; never
/// the file's position, which a FIFO, a pipe or a socket does not have (the
/// seek fails, and the whole history would go out again on every poll).
/// A chunk the file's writer thread took (a terminal or socket path) is
/// out, or its error is the write's, before the next one goes, as with the
/// release's `write(2)`.
fn write(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
	data: &BString,
	how: WriteHow,
	mode: u32,
) -> Poll<HistAnswer> {
	let flags = OpenFlags::WRITE.with(OpenFlags::CREATE).with(match how {
		WriteHow::Trunc => OpenFlags::TRUNC,
		WriteHow::Append => OpenFlags::APPEND,
		WriteHow::Excl => OpenFlags::EXCL,
	});
	// The count of bytes written, beside `sc.live` (the file, and what its
	// writer thread took and has not written yet).
	let input = &mut sc.io.get_or_insert_with(Box::default).input;
	loop {
		match &mut sc.live {
			Live::None => match cx.host.fs().open(BStr::new(path), flags, mode) {
				FsPoll::Ready(Ok(f)) => sc.live = Live::Write(Box::new((f, Unsettled::default()))),
				FsPoll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				FsPoll::Pending(f) => sc.live = Live::Open(f),
			},
			Live::Open(f) => match f.poll(tcx) {
				Poll::Ready(Ok(file)) => sc.live = Live::Write(Box::new((file, Unsettled::default()))),
				Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				Poll::Pending => return Poll::Pending,
			},
			Live::Write(w) => {
				let (f, unsettled) = &mut **w;
				let done = input
					.get(..8)
					.map_or(0, |b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8])));
				let done = usize::try_from(done).unwrap_or(usize::MAX);
				let rest = data.get(done..).unwrap_or_default();
				if rest.is_empty() {
					return match f.poll_flush(tcx) {
						Poll::Ready(Ok(())) => Poll::Ready(Ok(HistOut::Done)),
						Poll::Ready(Err(e)) => Poll::Ready(Err(HistErr::of(&e))),
						Poll::Pending => Poll::Pending,
					};
				}
				match unsettled.poll_write_file(f.as_mut(), tcx, rest) {
					Poll::Ready(Ok(0)) => {
						let e = io::Error::from(io::ErrorKind::WriteZero);
						return Poll::Ready(Err(HistErr::of(&e)));
					},
					Poll::Ready(Ok(n)) => {
						let total = u64::try_from(done.saturating_add(n)).unwrap_or(u64::MAX);
						input.clear();
						input.extend_from_slice(&total.to_le_bytes());
					},
					Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
					Poll::Pending => return Poll::Pending,
				}
			},
			_ => sc.live = Live::None,
		}
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::{
		os::unix::fs::OpenOptionsExt as _,
		time::{Duration, Instant},
	};

	use bstr::ByteSlice as _;

	use super::*;
	use crate::bash::{MemStore, signal::SigSet};

	/// `history -w` to a FIFO whose chunk the writer thread took, and whose
	/// reader is gone before the thread writes it: the write fails with that
	/// error (`EPIPE`), as the release's `write(2)` did. A plain write handed
	/// the chunk to the thread and counted it written, and the error was
	/// lost: the history write reported success. The writer thread is forced
	/// in this test's own process, as Darwin always uses it.
	#[test]
	fn history_write_reports_a_chunk_that_fails_after_its_hand_off() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::history_write_reports_a_chunk_that_fails_after_its_hand_off"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let fifo = dir.path().join("hist");
				let made = std::process::Command::new("mkfifo")
					.arg(&fifo)
					.status()
					.unwrap();
				assert!(made.success(), "mkfifo: {made}");
				// The reader is open first, so the write's open does not wait.
				let reader = std::fs::OpenOptions::new()
					.read(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&fifo)
					.unwrap();
				let mut store = MemStore::new();
				let mut host = crate::process::NativeHost::new(
					None,
					false,
					Vec::new(),
					SigSet::default(),
					0,
					false,
				);
				let mut cx = Cx { host: &mut host, store: &mut store };
				let mut sc = Scratch::default();
				let op = HistOp::Write {
					path: BString::from(fifo.to_str().unwrap()),
					data: BString::from("first\nsecond\n"),
					how:  WriteHow::Trunc,
					mode: 0o600,
				};
				let waker = std::task::Waker::noop();
				let mut tcx = Context::from_waker(waker);
				let held = crate::sys::hold_writers();
				// Poll until the file is open and one write went to the thread,
				// which holds it.
				let deadline = Instant::now() + Duration::from_secs(10);
				loop {
					let polled = perform(&mut tcx, &mut cx, &mut sc, &op);
					assert!(polled.is_pending(), "the write was done while the thread held its chunk");
					if matches!(sc.live, Live::Write(_)) {
						let again = perform(&mut tcx, &mut cx, &mut sc, &op);
						assert!(again.is_pending(), "the write was done while the thread held its chunk");
						break;
					}
					assert!(Instant::now() < deadline, "DEADLINE: the file was not open within 10 s");
					std::thread::sleep(Duration::from_millis(5));
				}
				drop(reader);
				drop(held);
				let deadline = Instant::now() + Duration::from_secs(10);
				let answer = loop {
					if let Poll::Ready(answer) = perform(&mut tcx, &mut cx, &mut sc, &op) {
						break answer;
					}
					assert!(Instant::now() < deadline, "DEADLINE: no answer within 10 s");
					std::thread::sleep(Duration::from_millis(5));
				};
				let err = answer.expect_err("the chunk's error was lost: the write reported success");
				assert!(
					err.msg
						.to_str_lossy()
						.to_lowercase()
						.contains("broken pipe"),
					"the error: {:?}",
					err.msg
				);
			},
		);
	}

	/// `history -w` to a FIFO through the writer thread, with a reader that
	/// drains it as it goes: each chunk the thread takes settles OK, the
	/// count of bytes written goes on past it, and `first\nsecond\n` arrives
	/// once; the write succeeds. Counted by the file's position, the count
	/// stays at nothing on a FIFO, which cannot seek, and the whole history
	/// goes out again on every poll. The writer thread is forced in this
	/// test's own process, as Darwin always uses it.
	#[test]
	fn history_write_through_the_writer_thread_sends_each_byte_once() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::history_write_through_the_writer_thread_sends_each_byte_once"),
			|| {
				use std::io::Read as _;

				let dir = tempfile::tempdir().unwrap();
				let fifo = dir.path().join("hist");
				let made = std::process::Command::new("mkfifo")
					.arg(&fifo)
					.status()
					.unwrap();
				assert!(made.success(), "mkfifo: {made}");
				// The reader is open first, so the write's open does not wait.
				let mut reader = std::fs::OpenOptions::new()
					.read(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&fifo)
					.unwrap();
				let mut store = MemStore::new();
				let mut host = crate::process::NativeHost::new(
					None,
					false,
					Vec::new(),
					SigSet::default(),
					0,
					false,
				);
				let mut cx = Cx { host: &mut host, store: &mut store };
				let mut sc = Scratch::default();
				let op = HistOp::Write {
					path: BString::from(fifo.to_str().unwrap()),
					data: BString::from("first\nsecond\n"),
					how:  WriteHow::Trunc,
					mode: 0o600,
				};
				let waker = std::task::Waker::noop();
				let mut tcx = Context::from_waker(waker);
				let mut got = Vec::new();
				let mut drain = |got: &mut Vec<u8>| {
					let mut buf = [0u8; 4096];
					loop {
						match reader.read(&mut buf) {
							Ok(0) => break,
							Ok(n) => got.extend_from_slice(&buf[..n]),
							Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
							Err(e) => panic!("reading the FIFO: {e}"),
						}
					}
				};
				let deadline = Instant::now() + Duration::from_secs(10);
				let answer = loop {
					let polled = perform(&mut tcx, &mut cx, &mut sc, &op);
					drain(&mut got);
					if let Poll::Ready(answer) = polled {
						break answer;
					}
					assert!(
						Instant::now() < deadline,
						"DEADLINE: no answer within 10 s; the reader got {} bytes, starting {:?}",
						got.len(),
						got.get(..64.min(got.len())).unwrap_or_default().as_bstr()
					);
					std::thread::sleep(Duration::from_millis(5));
				};
				if let Err(err) = answer {
					panic!("the write failed: {:?}", err.msg);
				}
				// The last chunk may still be in the writer thread's write.
				let deadline = Instant::now() + Duration::from_secs(10);
				while got.len() < b"first\nsecond\n".len() && Instant::now() < deadline {
					drain(&mut got);
					std::thread::sleep(Duration::from_millis(5));
				}
				drain(&mut got);
				assert_eq!(got.as_bstr(), b"first\nsecond\n".as_bstr());
			},
		);
	}
}
