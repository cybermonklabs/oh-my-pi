//! Decoding relays for external programs' output on its way into shell text.
//!
//! Builtins write the shell's own text (UTF-8). A native Windows program may
//! write the ANSI code page to a pipe, and one program's output is one
//! encoding, but a stream several commands write into is not. So the encoding
//! is decided per program, here, rather than by whoever reads the mixed
//! stream.
//!
//! A host that can decode such output installs an [`OutputDecoding`]. Every
//! external whose stdout or stderr is a *text sink* — the run's capture pipe
//! and a command substitution's capture — then writes into a pipe of its own;
//! a relay decodes it with a fresh [`ByteDecoder`] and forwards the text into
//! the sink. Pipeline pipes and files are not text sinks: they carry the
//! program's bytes unchanged, so binary data stays intact.
//!
//! A relay is not a thread: the external's `ExtProc` ([`Relayed`]) polls it
//! with the polling task's waker. It reads what the program wrote from our
//! end of the pipe (non-blocking or overlapped, [`os::OsPipe`]), decodes it
//! and writes the text into the sink, returning `Pending` wherever it would
//! wait.
//!
//! A command's relays drain before its exit is reported, so its output
//! reaches the sink ahead of whatever the next command writes there. Only the
//! relay reads the pipe, and the task polling it is the one sizing the
//! drain, so at the exit what the relay has read and what the pipe holds are
//! one snapshot: everything the exited program wrote, and whatever another
//! process holding the pipe wrote by then. The exit is reported once the
//! relay has forwarded that much. A process the program left running may
//! keep the pipe open forever; the drain never waits for the end of the
//! stream beyond a short grace for a character the bytes end inside. Past
//! the grace the decoder releases those bytes once
//! ([`ByteDecoder::release`]) and the relay forwards them before the exit is
//! reported, so the next command's output does not overtake them. They need
//! not be the program's: a process it left running may have written them
//! before the exit, and a character that process finishes later then comes
//! out broken: its start as the release gave it, and its rest, as the
//! decoder reads the bytes that come next, dropped. The release does not end
//! the stream: the decoder decodes the bytes after that character as if it
//! had never been written. The relay itself goes on to the end of the
//! stream, as a plain pipe would carry that process's output: once the
//! `ExtProc` is dropped it runs as adopted work (`pump::orphan`), and
//! releases what the decoder holds at the end.

use std::{
	fs,
	future::Future,
	io,
	pin::Pin,
	task::{Context, Poll, Waker},
	time::Duration,
};

use crate::{
	bash::{ExitStatus, ExtProc, Mark, OsHandle, ProcEvent, Signal},
	sys::{
		WaitKey,
		pump::{
			BUF, BURST, End, PollIo, orphan,
			os::{self, OsPipe, Timer},
		},
	},
};

/// Hook decoding external programs' output into shell text.
pub trait OutputDecoding: Send + Sync {
	/// A decoder for the output stream of one external program.
	fn decoder(&self) -> Box<dyn ByteDecoder>;
}

/// Incremental decoder for one external program's output stream.
pub trait ByteDecoder: Send {
	/// Decode the next chunk; bytes of an incomplete character stay held.
	fn push(&mut self, bytes: &[u8]) -> String;
	/// Whether bytes are held back for more input or for [`Self::finish`].
	fn holds_bytes(&self) -> bool;
	/// Flush held bytes at the end of the stream.
	fn finish(&mut self) -> String;
	/// Give out the held bytes now, while the stream goes on (another
	/// process may still write into it). The held bytes come out once, as a
	/// replacement character or as the decoder's own reading of them. The
	/// bytes that come next and that the decoder reads as the rest of their
	/// character are dropped, and no others; the bytes after that character
	/// are decoded as if it had never been written. A relay calls it at most
	/// once, when its program has exited and the end of the stream has not
	/// come within a short grace.
	fn release(&mut self) -> String;
}

/// How long the drain waits for the end of the stream when the decoder holds
/// the start of a character, before it has the decoder release those bytes.
const HOLD_GRACE: Duration = Duration::from_millis(50);

/// The OS handle a spawned child's stdio can inherit for `writer`.
fn writer_handle(writer: &fs::File) -> OsHandle {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		OsHandle(writer.as_raw_fd() as u64)
	}
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		OsHandle(writer.as_raw_handle().addr() as u64)
	}
}

/// Where a relay is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
	/// Forwarding what the program writes.
	Reading,
	/// The stream ended (or the relay was ended): release what the decoder
	/// holds.
	Finish,
	/// Flush the sink.
	Flush,
	/// Nothing more to do.
	Done,
}

/// One relay: our end of a program's pipe, its decoder and the text sink.
struct Relay {
	/// `None` once the stream ended, the sink refused text or the relay was
	/// ended at its program's exit.
	pipe:     Option<OsPipe>,
	decoder:  Option<Box<dyn ByteDecoder>>,
	sink:     End,
	buf:      Box<[u8]>,
	/// Decoded text, written into the sink up to `sent`.
	text:     Vec<u8>,
	sent:     usize,
	/// Raw bytes pending in `buf`, without a copy through `text`.
	raw_len:  usize,
	/// The chunk a sink's writer thread took last
	/// ([`End::poll_write_marked`]): settled before the next one goes, and
	/// its failure is the sink's refusal.
	mark:     Option<Mark>,
	/// Bytes read from the program so far.
	consumed: u64,
	phase:    Phase,
	/// Bytes the pipe had carried at the program's exit, once sized: what it
	/// wrote, and what any other process holding the pipe wrote by then.
	target:   Option<u64>,
	/// The hold grace, once the drain waits on a held character.
	grace:    Option<Timer>,
	/// The grace ended and the decoder released what it held: the drain no
	/// longer waits on held bytes.
	released: bool,
	/// The relay's wait on its sink, which the engine may wait on too.
	key:      WaitKey,
}

impl Relay {
	fn new(pipe: OsPipe, decoder: Option<Box<dyn ByteDecoder>>, sink: End) -> Self {
		Self {
			pipe: Some(pipe),
			decoder,
			sink,
			buf: vec![0; BUF].into_boxed_slice(),
			text: Vec::new(),
			sent: 0,
			raw_len: 0,
			mark: None,
			consumed: 0,
			phase: Phase::Reading,
			target: None,
			grace: None,
			released: false,
			key: WaitKey::default(),
		}
	}

	/// Forward what can move now; ready once done. Yields after a burst.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		for _ in 0..BURST {
			// Raw bytes when there is no decoder, else decoded text.
			let pending = if self.decoder.is_some() {
				self.text.len()
			} else {
				self.raw_len
			};
			// The chunk the sink's writer thread took last is out before the
			// next bytes go, or the flush: its failure is a refusal. While it
			// is written the relay goes on reading.
			match self.settle(cx) {
				Poll::Ready(Ok(())) => {},
				Poll::Ready(Err(_)) => return self.refused(),
				Poll::Pending if self.sent < pending || self.phase == Phase::Flush => {
					return Poll::Pending;
				},
				Poll::Pending => {},
			}
			if self.sent < pending {
				let bytes = if self.decoder.is_some() {
					&self.text[..]
				} else {
					&self.buf[..self.raw_len]
				};
				match std::task::ready!(self.sink.poll_write_marked(
					cx,
					&bytes[self.sent..],
					&mut self.key
				)) {
					Ok((n, mark)) if n > 0 => {
						self.sent += n;
						self.mark = mark;
					},
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					_ => return self.refused(),
				}
				continue;
			}
			self.text.clear();
			self.raw_len = 0;
			self.sent = 0;
			match self.phase {
				Phase::Reading => {
					let read = match &mut self.pipe {
						Some(pipe) => std::task::ready!(pipe.poll_read(cx, &mut self.buf)),
						None => Ok(0),
					};
					match read {
						Ok(n) if n > 0 => {
							self.consumed += n as u64;
							if let Some(decoder) = &mut self.decoder {
								self.text = decoder.push(&self.buf[..n]).into_bytes();
							} else {
								self.raw_len = n;
							}
						},
						// End of file, or a failed pipe.
						_ => self.end(),
					}
				},
				Phase::Finish => {
					if let Some(decoder) = &mut self.decoder {
						self.text = decoder.finish().into_bytes();
					}
					self.phase = Phase::Flush;
				},
				Phase::Flush => {
					let _ = std::task::ready!(self.sink.poll_flush(cx));
					self.phase = Phase::Done;
				},
				Phase::Done => return Poll::Ready(()),
			}
		}
		// A burst moved: let the engine run, then go on.
		cx.waker().wake_by_ref();
		Poll::Pending
	}

	/// Settles the chunk the sink's writer thread took last, if any.
	fn settle(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		let Some(mark) = &self.mark else {
			return Poll::Ready(Ok(()));
		};
		let result = std::task::ready!(self.sink.poll_settle_marked(cx, std::slice::from_ref(mark)));
		self.mark = None;
		Poll::Ready(result)
	}

	/// The sink refused bytes (its reader is gone) or failed: closing our
	/// end makes that visible to the program, whose next write fails as on a
	/// pipe whose reader is gone. Nothing more reaches the sink.
	fn refused(&mut self) -> Poll<()> {
		self.pipe = None;
		self.text.clear();
		self.raw_len = 0;
		self.sent = 0;
		self.mark = None;
		self.phase = Phase::Done;
		Poll::Ready(())
	}

	/// The stream ended: our end of the pipe closes first, then the decoder
	/// releases what it holds and the sink is flushed.
	fn end(&mut self) {
		self.pipe = None;
		if self.phase == Phase::Reading {
			self.phase = Phase::Finish;
		}
	}

	/// After the program's exit: whether everything the pipe carried by then
	/// has been forwarded. The relay itself goes on to the end of the stream,
	/// which a process the program left running may hold open.
	fn drained(&mut self, cx: &Context<'_>) -> bool {
		match self.phase {
			Phase::Done => return true,
			// The stream ended: drained once its rest is out and flushed.
			Phase::Finish | Phase::Flush => return false,
			Phase::Reading => {},
		}
		if self.target.is_none() {
			// Nothing but this relay reads the pipe, and this task polls it:
			// what it read and what the pipe holds now are one snapshot. A
			// pipe that cannot say is forwarded to its end.
			let waiting = self.pipe.as_mut().map_or(Ok(0), OsPipe::available);
			self.target = waiting.ok().map(|n| self.consumed + n as u64);
		}
		let Some(target) = self.target else {
			return false;
		};
		if self.consumed < target || self.sent < self.text.len().max(self.raw_len) {
			return false;
		}
		// What was handed to the sink is out of the shell: a host file's
		// writer thread takes bytes at once and writes them later, and the
		// next command must come after them. A failed chunk is the sink's
		// refusal.
		let mut tcx = Context::from_waker(cx.waker());
		match self.settle(&mut tcx) {
			Poll::Ready(Ok(())) => {},
			Poll::Ready(Err(_)) => {
				let _ = self.refused();
				return true;
			},
			Poll::Pending => return false,
		}
		if self.sink.poll_settle(&mut tcx).is_pending() {
			return false;
		}
		if self.released {
			// What the release gave out is in the sink. The decoder may still
			// hold bytes: the released ones until what comes next shows where
			// their character ends, and what came after them.
			return true;
		}
		let Some(decoder) = self
			.decoder
			.as_mut()
			.filter(|decoder| decoder.holds_bytes())
		else {
			return true;
		};
		if self
			.grace
			.get_or_insert_with(|| Timer::after(HOLD_GRACE))
			.poll(cx)
			.is_pending()
		{
			return false;
		}
		// The end of the stream did not come within the grace: another
		// process holds the pipe. Whose the held bytes are is unknown (the
		// program's, or what that process wrote before the exit), but the
		// next command's output must not overtake them: they go into the
		// sink now, ahead of the exit, once. The stream goes on: the decoder
		// drops the rest of the released character when it comes and
		// decodes the bytes after it as if that character had never been
		// written.
		self.released = true;
		self.text = decoder.release().into_bytes();
		self.sent = 0;
		if self.text.is_empty() {
			return true;
		}
		// The next poll writes them and settles them, then reports the exit.
		cx.waker().wake_by_ref();
		false
	}
}

/// Relays that outlived their `Relayed`, forwarding to the ends of their
/// streams as one piece of adopted work.
struct Forward(Vec<Relay>);

impl Future for Forward {
	type Output = ();

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
		self.0.retain_mut(|r| r.poll(cx).is_pending());
		if self.0.is_empty() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

/// The relays being set up for one spawn.
///
/// Each [`Relays::attach`] sets up a relay and returns the handle the
/// child's stdout or stderr inherits. The parent's copies of those handles
/// close when the set is wrapped around the spawned child ([`Relays::wrap`]),
/// which then polls the relays, or dropped with the relays (the spawn
/// failed).
pub(crate) struct Relays<'a> {
	decoding: Option<&'a dyn OutputDecoding>,
	writers:  Vec<fs::File>,
	set:      Vec<Relay>,
}

impl<'a> Relays<'a> {
	pub(crate) fn new(decoding: Option<&'a dyn OutputDecoding>) -> Self {
		Self { decoding, writers: Vec::new(), set: Vec::new() }
	}

	/// Set up a relay into `sink`, decoding only explicitly designated text
	/// sinks. Returns the OS handle the program writes to.
	pub(crate) fn attach(&mut self, sink: End, text: bool) -> io::Result<OsHandle> {
		let (pipe, writer) = os::pipe(false)?;
		self.set.push(Relay::new(
			pipe,
			self
				.decoding
				.filter(|_| text)
				.map(|decoding| decoding.decoder()),
			sink,
		));
		let os = writer_handle(&writer);
		self.writers.push(writer);
		Ok(os)
	}

	/// The spawned `child`, reporting its exit once the relays drained.
	pub(crate) fn wrap(self, child: Box<dyn ExtProc>) -> Box<dyn ExtProc> {
		if self.set.is_empty() {
			return child;
		}
		Box::new(Relayed { child, relays: self.set, status: None, orphan_key: WaitKey::default() })
	}
}

/// An external whose output runs through relays, which its `poll_wait`
/// drives: its exit is reported once they have forwarded everything it
/// wrote.
struct Relayed {
	child:      Box<dyn ExtProc>,
	relays:     Vec<Relay>,
	status:     Option<ExitStatus>,
	/// This poller's wait on the retained [`orphan`] work.
	orphan_key: WaitKey,
}

impl ExtProc for Relayed {
	fn pid(&self) -> u32 {
		self.child.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		loop {
			match std::task::ready!(self.poll_event(cx)) {
				ProcEvent::Exited(status) => return Poll::Ready(status),
				ProcEvent::Stopped(_) | ProcEvent::Continued => {},
			}
		}
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		for relay in &mut self.relays {
			let _ = relay.poll(cx);
		}
		let status = if let Some(status) = self.status {
			status
		} else {
			match std::task::ready!(self.child.poll_event(cx)) {
				ProcEvent::Exited(status) => {
					self.status = Some(status);
					status
				},
				change => return Poll::Ready(change),
			}
		};
		let mut drained = true;
		for relay in &mut self.relays {
			drained &= relay.drained(cx);
		}
		orphan::poll(cx, &mut self.orphan_key);
		if drained {
			Poll::Ready(ProcEvent::Exited(status))
		} else {
			Poll::Pending
		}
	}

	fn pgid(&self) -> Option<u32> {
		self.child.pgid()
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.child.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.child.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.child.cont()
	}
}

impl Drop for Relayed {
	/// Relays still forwarding (the program runs on, or a process it left
	/// running holds the pipe) go on to the ends of their streams as adopted
	/// work, as the program's output would through a plain pipe.
	fn drop(&mut self) {
		// Usually the stream has ended with the program: its end of file is
		// already readable and the relay finishes here.
		let mut now = Context::from_waker(Waker::noop());
		let open: Vec<Relay> = self
			.relays
			.drain(..)
			.filter_map(|mut r| r.poll(&mut now).is_pending().then_some(r))
			.collect();
		if !open.is_empty() {
			orphan::adopt(Forward(open));
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		os::{fd::OwnedFd, unix::ffi::OsStrExt},
		path::Path,
		sync::Arc,
	};

	use bstr::BString;
	use tokio::{io::AsyncReadExt, net::unix::pipe::Receiver};
	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::{
		session::{RunOptions, RunStdio, Session, SessionConfig},
		sys::StdFs,
	};

	/// Decodes each byte as Latin-1; `hold` keeps the last byte of every read
	/// back, as a decoder does for a character cut by the read.
	struct Latin1 {
		hold: bool,
	}

	impl OutputDecoding for Latin1 {
		fn decoder(&self) -> Box<dyn ByteDecoder> {
			Box::new(Latin1Decoder { hold: self.hold, held: None })
		}
	}

	struct Latin1Decoder {
		hold: bool,
		held: Option<u8>,
	}

	impl ByteDecoder for Latin1Decoder {
		fn push(&mut self, bytes: &[u8]) -> String {
			let mut text: String = self.held.take().into_iter().map(char::from).collect();
			let body = match bytes.split_last() {
				Some((&last, rest)) if self.hold => {
					self.held = Some(last);
					rest
				},
				_ => bytes,
			};
			text.extend(body.iter().copied().map(char::from));
			text
		}

		fn holds_bytes(&self) -> bool {
			self.held.is_some()
		}

		fn finish(&mut self) -> String {
			self.held.take().map(char::from).into_iter().collect()
		}

		fn release(&mut self) -> String {
			self.finish()
		}
	}

	/// An observation-only relay forwards the original read buffer, even
	/// when its host has a decoder configured for other text sinks.
	#[tokio::test]
	async fn raw_relay_preserves_non_utf8_bytes() {
		use std::io::{Read, Seek, Write};

		let mut output = tempfile::tempfile().unwrap();
		let decoding = Latin1 { hold: true };
		let mut relays = Relays::new(Some(&decoding));
		relays
			.attach(
				End::File(Box::new(super::super::StdFile::new(output.try_clone().unwrap()))),
				false,
			)
			.unwrap();
		relays.writers[0].write_all(b"\xff\xc3\0").unwrap();
		relays.writers.clear();
		std::future::poll_fn(|cx| relays.set[0].poll(cx)).await;
		output.rewind().unwrap();
		let mut bytes = Vec::new();
		output.read_to_end(&mut bytes).unwrap();
		assert_eq!(bytes, b"\xff\xc3\0");
	}

	/// An external that has exited.
	struct Exited;

	impl ExtProc for Exited {
		fn pid(&self) -> u32 {
			0
		}

		fn poll_wait(&mut self, _cx: &mut Context<'_>) -> Poll<ExitStatus> {
			Poll::Ready(ExitStatus::Exited(0))
		}

		fn signal(&mut self, _sig: Signal) -> io::Result<()> {
			Ok(())
		}

		fn stop(&mut self) -> io::Result<()> {
			Ok(())
		}

		fn cont(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// The crate's own decoder, UTF-8 only (an invalid or unfinished sequence
	/// becomes U+FFFD), on any host.
	struct Utf8;

	impl OutputDecoding for Utf8 {
		fn decoder(&self) -> Box<dyn ByteDecoder> {
			Box::new(crate::output_decode::OutputDecoder::utf8())
		}
	}

	/// The program's output ends inside a character (Latin-1 `é`, a UTF-8
	/// lead byte), and another process holds a copy of its write end past the
	/// hold grace, as a fork of this process does until its exec: the
	/// decoder's verdict on that character is in the sink when the exit is
	/// reported, so ahead of anything the next command writes there (`caf`
	/// alone is the exit reported with the byte held). The relay then reads
	/// on: what the copy writes later follows, once.
	#[tokio::test]
	async fn an_unfinished_character_is_out_before_the_exit_while_a_copy_holds_the_pipe() {
		use std::io::{Read, Seek, Write};

		let mut output = tempfile::tempfile().unwrap();
		let read = |output: &mut fs::File| {
			output.rewind().unwrap();
			let mut bytes = Vec::new();
			output.read_to_end(&mut bytes).unwrap();
			bytes
		};
		let mut relays = Relays::new(Some(&Utf8));
		relays
			.attach(End::File(Box::new(super::super::StdFile::new(output.try_clone().unwrap()))), true)
			.unwrap();
		relays.writers[0].write_all(b"caf\xe9").unwrap();
		let mut copy = relays.writers[0].try_clone().unwrap();
		let mut child = relays.wrap(Box::new(Exited));
		let status = std::future::poll_fn(|cx| child.poll_wait(cx)).await;
		assert_eq!(status, ExitStatus::Exited(0));
		assert_eq!(read(&mut output), "caf\u{FFFD}".as_bytes());
		copy.write_all(b"!").unwrap();
		drop(copy);
		// What the copy wrote is readable now, so the dropped `ExtProc`
		// forwards it at once (the end of the stream can come later: another
		// fork of this test process may still hold the pipe).
		drop(child);
		assert_eq!(read(&mut output), "caf\u{FFFD}!".as_bytes());
	}

	/// A relay with the crate's UTF-8 decoder into a temporary file, around an
	/// external that has exited after `wrote` went into its pipe; and a copy
	/// of the pipe's write end, held as a process the program left running
	/// holds it.
	fn exited_with_a_copy(wrote: &[u8]) -> (fs::File, fs::File, Relayed) {
		use std::io::Write;

		let output = tempfile::tempfile().unwrap();
		let mut relays = Relays::new(Some(&Utf8));
		relays
			.attach(End::File(Box::new(super::super::StdFile::new(output.try_clone().unwrap()))), true)
			.unwrap();
		relays.writers[0].write_all(wrote).unwrap();
		let copy = relays.writers[0].try_clone().unwrap();
		let Relays { set, writers, .. } = relays;
		drop(writers);
		(output, copy, Relayed {
			child:      Box::new(Exited),
			relays:     set,
			status:     None,
			orphan_key: WaitKey::default(),
		})
	}

	/// What is in the temporary file `output`.
	fn contents(output: &mut fs::File) -> Vec<u8> {
		use std::io::{Read, Seek};

		output.rewind().unwrap();
		let mut bytes = Vec::new();
		output.read_to_end(&mut bytes).unwrap();
		bytes
	}

	/// The release happens once. Between it and the next poll the other
	/// process writes `!` and the start of 中 (E4), then the rest of 中
	/// (B8 AD): 中 comes out whole, as a plain pipe would carry it. Released
	/// again, the start of 中 would be a U+FFFD and its rest two more.
	#[tokio::test]
	async fn a_character_written_after_the_release_comes_out_whole() {
		use std::io::Write;

		let (mut output, mut copy, mut relayed) = exited_with_a_copy(b"caf\xe9");
		let mut wrote = false;
		let status = std::future::poll_fn(|cx| {
			let polled = relayed.poll_wait(cx);
			// The grace released the held byte, which the next poll writes;
			// the other process's bytes are in the pipe by then.
			if polled.is_pending() && !wrote && !relayed.relays[0].text.is_empty() {
				copy.write_all(b"!\xe4").unwrap();
				wrote = true;
			}
			polled
		})
		.await;
		assert_eq!(status, ExitStatus::Exited(0));
		assert!(wrote, "the grace never released the held byte");
		copy.write_all(b"\xb8\xad").unwrap();
		drop(copy);
		// What the copy wrote is readable now, so the dropped `ExtProc`
		// forwards it at once (the end of the stream can come later).
		drop(relayed);
		assert_eq!(contents(&mut output), "caf\u{FFFD}!中".as_bytes());
	}

	/// A process that ends each of its writes inside a character, one write
	/// per poll, does not hold the exit back: the release happens once, and
	/// the exit is reported at the poll after it, with what that process
	/// wrote since still held. (Released at every poll, the exit would wait
	/// until that process stopped writing, here after 100 writes.)
	#[tokio::test]
	async fn a_writer_ending_every_write_inside_a_character_does_not_hold_the_exit() {
		use std::io::Write;

		let (mut output, mut copy, mut relayed) = exited_with_a_copy(b"caf\xe9");
		let mut writes = 0;
		let status = std::future::poll_fn(|cx| {
			let polled = relayed.poll_wait(cx);
			if polled.is_pending()
				&& (writes > 0 || !relayed.relays[0].text.is_empty())
				&& writes < 100
			{
				copy.write_all(&[0xe4]).unwrap();
				writes += 1;
			}
			polled
		})
		.await;
		assert_eq!(status, ExitStatus::Exited(0));
		assert_eq!(writes, 1);
		assert_eq!(contents(&mut output), "caf\u{FFFD}".as_bytes());
		// The decoder held the start of 中 after the release: its rest
		// finishes it. Readable now, so the dropped `ExtProc` forwards it at
		// once (the end of the stream can come later).
		copy.write_all(&[0xb8, 0xad]).unwrap();
		drop(copy);
		drop(relayed);
		assert_eq!(contents(&mut output), "caf\u{FFFD}中".as_bytes());
	}

	/// The held bytes need not be the program's. Here the program wrote
	/// `done\n`, and a process it left running wrote E6 97, the start of 日,
	/// before the exit; it writes the rest of 日 (A5) and `本` after the
	/// grace. The release cannot tell the two apart: 日 is one U+FFFD, out
	/// before the exit; its rest is dropped with it, and `本` comes out whole.
	#[tokio::test]
	async fn a_character_split_across_the_grace_is_one_replacement() {
		use std::io::Write;

		let (mut output, mut copy, mut relayed) = exited_with_a_copy(b"done\n\xe6\x97");
		let status = std::future::poll_fn(|cx| relayed.poll_wait(cx)).await;
		assert_eq!(status, ExitStatus::Exited(0));
		assert_eq!(contents(&mut output), "done\n\u{FFFD}".as_bytes());
		copy.write_all(b"\xa5").unwrap();
		copy.write_all("本\n".as_bytes()).unwrap();
		drop(copy);
		drop(relayed);
		assert_eq!(contents(&mut output), "done\n\u{FFFD}本\n".as_bytes());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn extra_output_alias_shares_the_text_relay() {
		let out =
			run(&mut session(false), "exec 3>&1; /bin/sh -c 'printf a; printf b >&3; printf c'", true)
				.await;
		assert_eq!(out, b"abc");
	}

	/// Latin-1 `café\n`, as a program writing a legacy code page emits it.
	const LEGACY: &[u8] = b"caf\xe9\n";

	fn session(hold: bool) -> Session {
		session_with(Some(Arc::new(Latin1 { hold })))
	}

	fn session_with(output_decoding: Option<Arc<dyn OutputDecoding>>) -> Session {
		let env = std::env::vars_os()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		let cwd = std::env::current_dir().unwrap();
		Session::new(SessionConfig {
			env,
			cwd: BString::from(cwd.as_os_str().as_bytes()),
			fs: Box::new(StdFs::default()),
			vfs: None,
			runtime: tokio::runtime::Handle::current(),
			output_decoding,
			term_grace: crate::host::TERM_GRACE,
		})
		.unwrap()
	}

	/// The bytes `command` writes to stdout and stderr, which share one pipe
	/// read concurrently on the test's own task; `text` makes that pipe a
	/// text capture.
	async fn run(session: &mut Session, command: &str, text: bool) -> Vec<u8> {
		run_with(session, command, text, Stdin::Null).await
	}

	/// The run's stdin in [`run_with`].
	enum Stdin {
		/// `/dev/null`.
		Null,
		/// The read end of a [`Gate`](crate::testkit::child::Gate), which the
		/// test opens once the run has returned.
		Gated,
	}

	/// A leftover `sh` keeps the pipe open with: it reads fd 3, its copy of
	/// the run's stdin, to end of file, then runs `then` (and ends). Under
	/// [`run_with`] with [`Stdin::Gated`], that stdin is a pipe whose only
	/// write end the test holds, so the leftover ends when the test lets it
	/// go, or when the test process ends however it ends: the kernel closes
	/// the write end then. (fd 3, because an asynchronous list's own stdin is
	/// `/dev/null`.)
	fn leftover(then: &str) -> String {
		format!("exec 3<&0; (while read -r _; do :; done <&3; {then}) &")
	}

	/// [`run`] with `stdin`. With [`Stdin::Gated`], the test opens the gate
	/// once the run has returned, while the reader still reads: a
	/// [`leftover`] waiting for the gate holds the pipe past the run's end,
	/// whatever the host's speed. A run that waited for the leftover would
	/// never return, and the test hangs until the runner's timeout; the
	/// runner's kill closes the gate, and the leftover ends.
	async fn run_with(session: &mut Session, command: &str, text: bool, stdin: Stdin) -> Vec<u8> {
		let (reader, writer) = io::pipe().unwrap();
		let mut reader = Receiver::from_owned_fd(OwnedFd::from(reader)).unwrap();
		let gate = matches!(stdin, Stdin::Gated).then(crate::testkit::child::Gate::new);
		let stdin = match &gate {
			Some(gate) => gate.reader(),
			None => std::fs::File::open("/dev/null").unwrap(),
		};
		let stdio = RunStdio {
			stdin:  Some(stdin),
			stderr: Some(std::fs::File::from(OwnedFd::from(writer.try_clone().unwrap()))),
			stdout: Some(std::fs::File::from(OwnedFd::from(writer))),
		};
		let mut options = RunOptions::new(command);
		options.text_capture = text;
		let read = async {
			let mut bytes = Vec::new();
			reader.read_to_end(&mut bytes).await.unwrap();
			bytes
		};
		let run = async {
			session
				.run_with(options, stdio, CancellationToken::new())
				.await
				.unwrap();
			drop(gate);
		};
		tokio::join!(read, run).0
	}

	fn legacy_file(dir: &Path) -> String {
		let path = dir.join("legacy.txt");
		std::fs::write(&path, LEGACY).unwrap();
		path.display().to_string()
	}

	/// A program's output lands decoded, between what the builtins wrote
	/// before and after it. Fails as mojibake (raw `E9`), or as `b` ahead of
	/// the program's text when its exit is reported before its relay drained.
	#[tokio::test(flavor = "multi_thread")]
	async fn program_output_is_decoded_in_order() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out =
			run(&mut session(false), &format!("printf 'a\\n'; /bin/cat {file}; printf 'b\\n'"), true)
				.await;
		assert_eq!(out, "a\ncafé\nb\n".as_bytes());
	}

	/// Output into a pipe that is not a text capture keeps its bytes.
	#[tokio::test(flavor = "multi_thread")]
	async fn output_outside_a_text_capture_stays_raw() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out = run(&mut session(false), &format!("/bin/cat {file}"), false).await;
		assert_eq!(out, LEGACY);
	}

	/// Pipeline pipes and files carry a program's bytes: `wc` counts the one
	/// raw byte of `é`, and the redirected file holds it.
	#[tokio::test(flavor = "multi_thread")]
	async fn pipes_and_files_keep_program_bytes() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let copy = dir.path().join("copy.txt");
		let out = run(
			&mut session(false),
			&format!(
				"/bin/cat {file} | /usr/bin/wc -c | /usr/bin/tr -d ' \\n'; /bin/cat {file} > {}",
				copy.display()
			),
			true,
		)
		.await;
		assert_eq!(out, b"5");
		assert_eq!(std::fs::read(copy).unwrap(), LEGACY);
	}

	/// A command substitution takes a program's output as shell text, whatever
	/// reads the run's output: `é` is two bytes there, one in the raw file.
	#[tokio::test(flavor = "multi_thread")]
	async fn command_substitution_takes_decoded_text() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out = run(
			&mut session(false),
			&format!("printf %s \"$(/bin/cat {file})\" | /usr/bin/wc -c | /usr/bin/tr -d ' \\n'"),
			false,
		)
		.await;
		assert_eq!(out, b"5");
	}

	/// A program's stdout and stderr share one relay, so their interleaving
	/// is the order it wrote them in.
	#[tokio::test(flavor = "multi_thread")]
	async fn stdout_and_stderr_keep_their_order() {
		let script = "echo a; echo b >&2; echo c; echo d >&2; echo e";
		let out = run(&mut session(false), &format!("/bin/sh -c '{script}'"), true).await;
		assert_eq!(out, b"a\nb\nc\nd\ne\n");
	}

	/// A character the program ended inside is released at the end of its
	/// stream, ahead of the next command's output.
	///
	/// The stream ends once every copy of the pipe's write end is closed, and
	/// the drain waits for that only the short hold grace. A process that
	/// another test of this process forks holds a copy of every descriptor
	/// until its exec, so `X` came before `c` whenever such a copy outlived
	/// the grace. So the test runs in a process of its own, where no other
	/// test runs.
	#[tokio::test(flavor = "multi_thread")]
	async fn held_bytes_are_flushed_before_the_next_command() {
		const NAME: &str = "sys::relay::tests::held_bytes_are_flushed_before_the_next_command";
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
		let out = run(&mut session(true), "/bin/sh -c 'printf abc'; printf X", true).await;
		assert_eq!(out, b"abcX");
	}

	/// A leftover keeps the pipe open while the decoder holds the character
	/// the program ended inside: after the short hold grace (a timer wakes
	/// the drain, nothing else would) the held byte is released into the
	/// capture, and then the exit is reported, so the next command's output
	/// still comes after it. The leftover ends only once the run returned:
	/// `X` before `c` is the exit reported with the byte held.
	#[tokio::test(flavor = "current_thread")]
	async fn held_bytes_come_before_the_next_command_while_a_leftover_holds_the_pipe() {
		let command = format!("/bin/sh -c 'printf abc; {}'; printf X", leftover(":"));
		let out = run_with(&mut session(true), &command, true, Stdin::Gated).await;
		assert_eq!(out, b"abcX");
	}

	/// What a process the program left running writes after the program's
	/// exit was reported (and its `ExtProc` dropped) still reaches the
	/// capture, through the relay adopted on the session's runtime, as it
	/// would through a plain pipe. It writes only once the run returned.
	#[tokio::test(flavor = "current_thread")]
	async fn late_output_of_a_leftover_reaches_the_capture() {
		let command = format!("/bin/sh -c 'echo early; {}'; echo done", leftover("echo late"));
		let out = run_with(&mut session(false), &command, true, Stdin::Gated).await;
		assert_eq!(out, b"early\ndone\nlate\n");
	}

	/// Relays, input feeds and output pumps are polled by their externals'
	/// `ExtProc`s on the session's task. On a current-thread runtime, which
	/// also runs the reader of the capture, a command substitution's output
	/// (relayed) goes back through an engine pipe into a program whose output
	/// is relayed into the capture: every byte arrives in order, the full
	/// pipes on the way never blocking the one thread.
	#[tokio::test(flavor = "current_thread")]
	async fn relays_and_pumps_run_on_a_current_thread_runtime() {
		let on_path = crate::testkit::child::on_path;
		let script = format!(
			"big=$({} 0123456789 | {} -n 20000); printf '%s\\n' \"$big\" | {}",
			on_path("yes"),
			on_path("head"),
			on_path("cat")
		);
		// A block of the runtime's only thread hangs the test until the
		// runner's bound.
		let out = run(&mut session(false), &script, true).await;
		assert_eq!(out, "0123456789\n".repeat(20_000).into_bytes());
	}

	/// A procsub handed to externals that exit without reading it, also as
	/// fd 0 and fd 4 at once: each external's feed moves bytes from the
	/// engine pipe into its OS pipe (more than the OS pipe holds, so some wait
	/// in the feed), and its drop gives them back, OS pipe first, ahead of the
	/// rest. The last reader gets every byte once, in order, while the
	/// substitution still writes.
	#[tokio::test(flavor = "current_thread")]
	async fn procsub_bytes_a_feed_took_go_back_once_in_order() {
		let (yes, head) =
			(crate::testkit::child::on_path("yes"), crate::testkit::child::on_path("head"));
		let script = format!(
			"exec 4< <({yes} 0123456789 | {head} -n 30000)\n/bin/sh -c : <&4\n/bin/sh -c 'exit \
			 0'\nx=$({} <&4)\ny=$({yes} 0123456789 | {head} -n 30000)\n[ \"$x\" = \"$y\" ] && echo \
			 same || echo \"differ ${{#x}} ${{#y}}\"",
			crate::testkit::child::on_path("cat")
		);
		// A feed that blocked the runtime's only thread would hang the test
		// until the runner's bound.
		let out = run(&mut session_with(None), &script, false).await;
		assert_eq!(String::from_utf8_lossy(&out), "same\n");
	}

	/// A process the program left running keeps the relay's pipe open: the
	/// program's exit is still reported, with its output, while it runs (it
	/// ends only once the run returned).
	#[tokio::test(flavor = "multi_thread")]
	async fn exit_is_reported_while_a_leftover_holds_the_pipe() {
		let command = format!("/bin/sh -c 'echo hi; {}'; echo done", leftover(":"));
		let out = run_with(&mut session(false), &command, true, Stdin::Gated).await;
		assert_eq!(out, b"hi\ndone\n");
	}

	/// A sink that takes every write at once and has it out only once
	/// `released`, as a host file's writer thread holds a chunk it took.
	struct Held(Arc<std::sync::atomic::AtomicBool>);

	impl crate::bash::File for Held {
		fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
			Poll::Ready(Ok(0))
		}

		fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			Poll::Ready(Ok(buf.len()))
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn poll_settle(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			if self.0.load(std::sync::atomic::Ordering::SeqCst) {
				Poll::Ready(Ok(()))
			} else {
				Poll::Pending
			}
		}

		fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> crate::bash::FileKind {
			crate::bash::FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			None
		}

		fn dup(&self) -> io::Result<Box<dyn crate::bash::File>> {
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	// Failure mode: a relay counted the text it handed to its sink as
	// forwarded, so the program's exit was reported, and the next command
	// ran, while the sink's writer thread still held the text. The program
	// has exited (its pipe stays open, as a process it left running holds
	// it) and every byte it wrote is read and handed off: the relay is
	// drained only once the sink has its text out.
	#[test]
	fn a_relay_is_drained_only_once_its_sink_has_settled() {
		let (pipe, mut program) = os::pipe(false).unwrap();
		std::io::Write::write_all(&mut program, b"abc").unwrap();
		let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
		let sink = End::File(Box::new(Held(Arc::clone(&released))));
		let mut relay = Relay::new(pipe, Some(Latin1 { hold: false }.decoder()), sink);
		let mut cx = Context::from_waker(Waker::noop());
		// The text is read and handed to the sink; the pipe stays open.
		assert!(relay.poll(&mut cx).is_pending());
		assert_eq!(relay.consumed, 3);
		assert!(!relay.drained(&cx), "drained while the sink still held the text");
		released.store(true, std::sync::atomic::Ordering::SeqCst);
		assert!(relay.drained(&cx), "not drained once the sink had the text out");
		drop(program);
	}
}

/// A relay into a sink whose writer thread fails the text it took: Windows
/// takes that route for every pipe; Linux does in the test's own process.
#[cfg(all(test, any(target_os = "linux", windows)))]
mod refusal_tests {
	use std::{
		io::Write as _,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		task::Wake,
		time::{Duration, Instant},
	};

	use super::*;
	use crate::sys::StdFile;

	/// Passes bytes through as text.
	struct Bytes;

	impl ByteDecoder for Bytes {
		fn push(&mut self, bytes: &[u8]) -> String {
			String::from_utf8_lossy(bytes).into_owned()
		}

		fn holds_bytes(&self) -> bool {
			false
		}

		fn finish(&mut self) -> String {
			String::new()
		}

		fn release(&mut self) -> String {
			String::new()
		}
	}

	/// Records a wake and unparks the test thread.
	struct Woken(AtomicBool, std::thread::Thread);

	impl Wake for Woken {
		fn wake(self: Arc<Self>) {
			self.0.store(true, Ordering::SeqCst);
			self.1.unpark();
		}
	}

	/// The write end of a pipe whose reader is gone, as a host file.
	fn readerless_sink() -> End {
		let (reader, writer) = io::pipe().unwrap();
		drop(reader);
		#[cfg(unix)]
		let file = fs::File::from(std::os::fd::OwnedFd::from(writer));
		#[cfg(windows)]
		let file = fs::File::from(std::os::windows::io::OwnedHandle::from(writer));
		End::File(Box::new(StdFile::new(file)))
	}

	/// Runs `body` where every `StdFile` writes through its writer thread.
	fn on_the_writer_thread(test: &str, body: impl FnOnce()) {
		#[cfg(target_os = "linux")]
		crate::sys::in_blocking_writer_process(test, body);
		#[cfg(windows)]
		{
			let _ = test;
			body();
		}
	}

	// Failure mode: the sink's writer thread took the relay's text and then
	// failed to write it (the capture's reader is gone, as when the host
	// stops draining a background program's output), and the relay went on:
	// the program never got its broken pipe, and it and its relay ran on. The
	// relay settles the chunk it handed off, takes the failure as the sink's
	// refusal and closes our end of the program's pipe, so the program's next
	// write fails as one straight into the capture would.
	#[test]
	fn a_relay_whose_sink_fails_a_chunk_closes_the_programs_pipe() {
		on_the_writer_thread(
			concat!(module_path!(), "::a_relay_whose_sink_fails_a_chunk_closes_the_programs_pipe"),
			|| {
				let (pipe, mut program) = os::pipe(false).unwrap();
				program.write_all(b"abc").unwrap();
				let mut relay = Relay::new(pipe, Some(Box::new(Bytes)), readerless_sink());
				// Polled again only once its waker was woken, so a relay that
				// waits on its sink's settle without a wake registered fails.
				let woken = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
				let waker = Waker::from(Arc::clone(&woken));
				let mut cx = Context::from_waker(&waker);
				let start = Instant::now();
				while relay.poll(&mut cx).is_pending() {
					while !woken.0.swap(false, Ordering::SeqCst) {
						assert!(
							start.elapsed() < Duration::from_secs(5),
							"the relay was not woken to take the sink's refusal: {} bytes read, its pipe \
							 {}",
							relay.consumed,
							if relay.pipe.is_some() {
								"open"
							} else {
								"closed"
							}
						);
						std::thread::park_timeout(Duration::from_millis(50));
					}
				}
				assert_eq!(relay.consumed, 3);
				assert!(relay.pipe.is_none(), "the relay ended with the program's pipe open");
				// The readiness thread lets our end go once it wakes from its
				// wait, which the end's drop asks for.
				let start = Instant::now();
				loop {
					match program.write(b"d") {
						Err(e) if e.kind() == io::ErrorKind::BrokenPipe => break,
						Ok(_) => assert!(
							start.elapsed() < Duration::from_secs(2),
							"the program still wrote 2 s after the refusal"
						),
						Err(e) => panic!("the program's write after the refusal: {e}"),
					}
					std::thread::sleep(Duration::from_millis(5));
				}
			},
		);
	}

	// Failure mode: the relay handed text to its sink's writer thread, which
	// waited on a full pipe, and then the pipe's reader left: the thread's
	// write failed, and nothing woke the relay to settle it, so it slept with
	// the program's pipe open. Here the relay is known to have handed that
	// chunk off (`Pending` with the program's three bytes read: it hands off
	// what it reads in the same poll, to a writer thread that is idle) while
	// the pipe has no room for it, before the reader leaves, and it is polled
	// again only once its waker was woken.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_relay_waiting_on_its_sinks_chunk_is_woken_when_the_chunk_fails() {
		use std::os::unix::fs::OpenOptionsExt;

		on_the_writer_thread(
			concat!(
				module_path!(),
				"::a_relay_waiting_on_its_sinks_chunk_is_woken_when_the_chunk_fails"
			),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = dir.path().join("sink");
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
				// Full to the byte: 4096-byte writes, then single bytes, until
				// the pipe takes none.
				for size in [4096, 1] {
					loop {
						match filler.write(&vec![b'F'; size]) {
							Ok(_) => {},
							Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
							Err(e) => panic!("filling the sink: {e}"),
						}
					}
				}
				let sink = fs::OpenOptions::new().write(true).open(&path).unwrap();
				let (pipe, mut program) = os::pipe(false).unwrap();
				program.write_all(b"abc").unwrap();
				let mut relay =
					Relay::new(pipe, Some(Box::new(Bytes)), End::File(Box::new(StdFile::new(sink))));
				let woken = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
				let waker = Waker::from(Arc::clone(&woken));
				let mut cx = Context::from_waker(&waker);
				let wait_for_wake = |what: &str| {
					let start = Instant::now();
					while !woken.0.swap(false, Ordering::SeqCst) {
						assert!(
							start.elapsed() < Duration::from_secs(5),
							"the relay was not woken: {what}"
						);
						std::thread::park_timeout(Duration::from_millis(50));
					}
				};
				// Until the program's text is with the writer thread, which
				// waits on the full pipe.
				loop {
					assert!(relay.poll(&mut cx).is_pending(), "the relay ended with its sink full");
					if relay.consumed == 3 {
						break;
					}
					wait_for_wake("for the program's text");
				}
				woken.0.store(false, Ordering::SeqCst);
				drop(held);
				wait_for_wake("when its sink's chunk failed");
				while relay.poll(&mut cx).is_pending() {
					wait_for_wake("to take the sink's refusal");
				}
				assert!(relay.pipe.is_none(), "the relay ended with the program's pipe open");
				drop(filler);
			},
		);
	}

	// Failure mode (review of #111 at 3b9fe7ab): no test covered the relay's
	// key. A relay writing a program's output into an engine object that the
	// engine writes too waits there with its own key; with a key dropped
	// after each poll, its wait went with it and the drain woke only the
	// engine.
	#[test]
	fn a_relay_and_the_engine_waiting_for_room_are_both_woken() {
		use std::io::Write;

		use crate::sys::test_fifos::{Flag, FullFifo, drain};
		let FullFifo { writer, mut reader } = FullFifo::new();
		let sink = crate::bash::FdRef::from_file(Box::new(writer));
		let (pipe, mut program) = os::pipe(false).unwrap();
		program.write_all(b"x").unwrap();
		let mut relay = Relay::new(pipe, None, End::Fd(sink.clone()));
		let (relayed, engine) = (Arc::new(Flag::default()), Arc::new(Flag::default()));
		let (rw, ew) = (Waker::from(Arc::clone(&relayed)), Waker::from(Arc::clone(&engine)));
		assert!(relay.poll(&mut Context::from_waker(&rw)).is_pending(), "no room");
		assert_eq!(relay.raw_len, 1, "the byte read waits for room");
		assert!(
			sink
				.poll_write(&mut Context::from_waker(&ew), b"y")
				.is_pending(),
			"no room"
		);
		drain(&mut reader);
		relayed.wait("the relay, waiting for room, woken by the drain");
		engine.wait("the engine, waiting for room in the same object, woken by the same drain");
	}
}
