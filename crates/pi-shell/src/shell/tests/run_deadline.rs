//! A run's deadline bounds its command, not the reading of what the command
//! wrote (`RunDeadline`). A command that ended before the deadline keeps its
//! status however slowly its output is taken; past the deadline, a consumer
//! that takes nothing for `DRAIN_STALL` ends the drain, and the run says the
//! output was dropped (`output_dropped`); a command still running at the
//! deadline, or not yet started, times out.
//!
//! The clock is paused, so every time below is the runtime's, not the
//! machine's, and each line of output is read as a chunk of its own
//! (`READ_LEN`), so the drain's length does not depend on how the pipe's
//! bytes happen to be read. The close tests at the end are the exception
//! (see there).

use super::*;

/// Ten lines of seven bytes each.
#[cfg(target_os = "linux")]
const TEN_LINES: &str = "for i in 0 1 2 3 4 5 6 7 8 9; do echo chunk$i; done";
#[cfg(target_os = "linux")]
const LINE_LEN: usize = "chunk0\n".len();

/// The deadline of every run here.
const DEADLINE: Duration = Duration::from_millis(1500);

fn deadline() -> CancelToken {
	CancelToken::with_timeout(Some(DEADLINE))
}

/// Reads of this thread's output pipes take one line each while it lives.
#[cfg(target_os = "linux")]
struct OneReadPerLine;

#[cfg(target_os = "linux")]
impl OneReadPerLine {
	fn new() -> Self {
		READ_LEN.set(LINE_LEN);
		Self
	}
}

#[cfg(target_os = "linux")]
impl Drop for OneReadPerLine {
	fn drop(&mut self) {
		READ_LEN.set(usize::MAX);
	}
}

/// A consumer that takes a chunk, then works on it for a second.
#[cfg(target_os = "linux")]
fn slow_consumer<T: Send + 'static>(rx: flume::Receiver<T>) -> tokio::task::JoinHandle<Vec<T>> {
	tokio::spawn(async move {
		let mut taken = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			taken.push(chunk);
			time::sleep(Duration::from_secs(1)).await;
		}
		taken
	})
}

#[cfg(target_os = "linux")]
fn ten_chunks() -> Vec<String> {
	(0..10).map(|i| format!("chunk{i}\n")).collect()
}

/// The reviewer's case: a command that ends at once, a 1.5 s deadline, and a
/// consumer that takes its ten chunks a second apart. The drain outlasts the
/// deadline; the run reports the command's status and every chunk.
///
/// Linux only: on macOS and Windows each write to the run's output pipe goes
/// to the descriptor's writer thread (`sys::fs::BlockingWriter`), a thread
/// the paused clock does not wait for. While the shell waits for it to write
/// a line, every task may be waiting, and the runtime then moves its clock
/// on to the next timer: the deadline comes before the command has ended,
/// and the run reads as timed out.
#[cfg(target_os = "linux")]
#[tokio::test(start_paused = true)]
async fn a_slow_consumer_past_the_deadline_keeps_the_status_and_every_chunk() {
	let _lines = OneReadPerLine::new();
	let (tx, rx) = flume::bounded::<String>(0);
	let consumer = slow_consumer(rx);
	let started = time::Instant::now();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: TEN_LINES.into(), ..Default::default() },
			Some(tx),
			deadline(),
		)
		.await
		.expect("run");
	let ran = started.elapsed();
	assert_eq!(
		(result.exit_code, result.timed_out, result.cancelled, result.output_dropped),
		(Some(0), false, false, false)
	);
	assert_eq!(consumer.await.expect("consumer"), ten_chunks());
	// The tenth chunk was taken 9 s in: the drain went on past the deadline.
	assert!(ran >= Duration::from_secs(9), "the run ended after {ran:?}");
}

/// The same through `execute_shell_streams`' byte readers. Linux only, as
/// above; on Windows, too, the stderr reader's blocking read of its empty
/// pipe stays in flight, and the paused clock does not move while it does.
#[cfg(target_os = "linux")]
#[tokio::test(start_paused = true)]
async fn streams_with_a_slow_consumer_past_the_deadline_keep_the_status_and_every_chunk() {
	let _lines = OneReadPerLine::new();
	let (tx, rx) = flume::bounded::<Bytes>(0);
	let consumer = slow_consumer(rx);
	let result = execute_shell_streams(
		ShellExecuteOptions { command: TEN_LINES.into(), ..Default::default() },
		StreamSinks { stdout: Some(tx), stderr: None },
		deadline(),
	)
	.await
	.expect("execute");
	assert_eq!(
		(result.exit_code, result.timed_out, result.cancelled, result.output_dropped),
		(Some(0), false, false, false)
	);
	let taken: Vec<String> = consumer
		.await
		.expect("consumer")
		.iter()
		.map(|chunk| String::from_utf8_lossy(chunk).into_owned())
		.collect();
	assert_eq!(taken, ten_chunks());
}

/// Past the deadline, a consumer that takes nothing ends the drain after
/// `DRAIN_STALL`: the run reports the command's status and that the output
/// it did not take was dropped.
#[tokio::test(start_paused = true)]
async fn past_the_deadline_a_consumer_that_takes_nothing_ends_the_drain_after_drain_stall() {
	let (tx, rx) = flume::bounded::<String>(0);
	let started = time::Instant::now();
	// The runtime's clock moves only to timers: with no bound on the drain
	// this one would be the next, and the test fails instead of waiting.
	let shell = Shell::new(None);
	let run = shell.run(
		ShellRunOptions { command: "echo one".into(), ..Default::default() },
		Some(tx),
		deadline(),
	);
	let result = time::timeout(Duration::from_secs(60), run)
		.await
		.expect("the drain ended past the deadline")
		.expect("run");
	let ran = started.elapsed();
	assert_eq!(
		(result.exit_code, result.timed_out, result.cancelled, result.output_dropped),
		(Some(0), false, false, true)
	);
	assert!(
		ran >= DEADLINE + DRAIN_STALL && ran < DEADLINE + DRAIN_STALL + Duration::from_millis(250),
		"the run ended after {ran:?}"
	);
	assert!(rx.try_recv().is_err(), "the chunk nobody took is dropped");
}

/// A command still running at the deadline times out. Unix only: on
/// Windows the reader's blocking read of the pipe the sleeping command
/// holds stays in flight, and the paused clock does not move while it does.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_command_running_at_the_deadline_times_out() {
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: "echo one; sleep 10; echo two".into(), ..Default::default() },
			Some(tx),
			deadline(),
		)
		.await
		.expect("run");
	assert_eq!((result.exit_code, result.timed_out), (None, true));
	assert!(!rx.drain().any(|chunk| chunk.contains("two")));
}

/// A chain's next segment does not start once the deadline has passed in
/// the drain of the segment before it: the chain times out.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_chain_segment_after_the_deadline_does_not_start() {
	let root = unique_temp_dir("run-deadline-chain");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let shell = Shell::new(Some(ShellOptions { minimizer: Some(minimizer), ..Default::default() }));
	let marker = root.join("second-segment-ran");
	let command = format!("printf 'one\\n'; : > '{}'", marker.display());
	// Nobody takes the first segment's output: its drain is still waiting
	// when the deadline passes.
	let (tx, _rx) = flume::bounded::<String>(0);
	let result = shell
		.run(ShellRunOptions { command, ..Default::default() }, Some(tx), deadline())
		.await
		.expect("run");
	let ran = marker.exists();
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!((result.exit_code, result.timed_out), (None, true));
	assert!(!ran, "the second segment started after the deadline");
}

/// Closing a file the command dropped is part of the command: a provider
/// whose close takes `SLOW_CLOSE` keeps the command from ending, so a
/// deadline that passes during the close stops the run, which times out.
///
/// The clock is paused, as above: the shell runs on the test's runtime, so
/// no time passes until it waits, and the first wait after the command's
/// work is the close. The deadline then comes first however slow the
/// machine is, and the file has been written by then. Unix only: on Windows
/// the reader's blocking read of the still-open pipe is in flight during
/// the close, and the paused clock does not move while it does.
#[cfg(unix)]
mod slow_close {
	use std::{io::SeekFrom, path::Path};

	use async_trait::async_trait;
	use parking_lot::Mutex;

	use super::*;

	const CLOSE_DEADLINE: Duration = Duration::from_secs(1);
	const SLOW_CLOSE: Duration = Duration::from_secs(10);
	const COMMAND: &str = "echo x > slow://f; echo done";

	/// `slow://`: a directory whose files take what is written to them and
	/// close after `SLOW_CLOSE`.
	#[derive(Debug, Default)]
	struct SlowClose {
		written: Arc<Mutex<Vec<u8>>>,
	}

	#[derive(Debug)]
	struct SlowHandle {
		written: Arc<Mutex<Vec<u8>>>,
	}

	fn file_meta(len: u64) -> pi_vfs::Metadata {
		pi_vfs::Metadata::new(
			pi_vfs::FileType::from_kind(pi_vfs::FileKind::File),
			len,
			pi_vfs::Permissions::from_mode(0o644),
		)
	}

	#[async_trait]
	impl pi_vfs::FileHandle for SlowHandle {
		async fn read(&self, _buf: &mut [u8]) -> io::Result<usize> {
			Ok(0)
		}

		async fn write(&self, buf: &[u8]) -> io::Result<usize> {
			self.written.lock().extend_from_slice(buf);
			Ok(buf.len())
		}

		async fn seek(&self, _pos: SeekFrom) -> io::Result<u64> {
			Ok(self.written.lock().len() as u64)
		}

		async fn metadata(&self) -> io::Result<pi_vfs::Metadata> {
			Ok(file_meta(self.written.lock().len() as u64))
		}

		async fn close(&self) -> io::Result<()> {
			time::sleep(SLOW_CLOSE).await;
			Ok(())
		}
	}

	#[async_trait]
	impl pi_vfs::FileSystem for SlowClose {
		async fn open(
			&self,
			path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> io::Result<pi_vfs::File> {
			if path == Path::new("slow://") {
				return Err(io::ErrorKind::IsADirectory.into());
			}
			Ok(pi_vfs::File::from_handle(SlowHandle { written: self.written.clone() }))
		}

		async fn metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
			if path == Path::new("slow://") {
				return Ok(pi_vfs::Metadata::new(
					pi_vfs::FileType::from_kind(pi_vfs::FileKind::Dir),
					0,
					pi_vfs::Permissions::from_mode(0o755),
				));
			}
			Ok(file_meta(self.written.lock().len() as u64))
		}

		async fn read_dir(&self, _path: &Path) -> io::Result<pi_vfs::ReadDir> {
			Ok(pi_vfs::ReadDir::from_entries(Vec::new()))
		}
	}

	/// The provider, and what was written to it.
	fn slow_close() -> (pi_vfs::Fs, Arc<Mutex<Vec<u8>>>) {
		let provider = SlowClose::default();
		let written = provider.written.clone();
		(pi_vfs::Fs::new(Arc::new(provider)), written)
	}

	/// A run that times out at the deadline: the file was written, and the
	/// run did not wait for its close.
	fn assert_timed_out_at_the_deadline(
		(exit_code, timed_out): (Option<i32>, bool),
		ran: Duration,
		written: &Mutex<Vec<u8>>,
	) {
		assert_eq!((exit_code, timed_out), (None, true), "after {ran:?}");
		assert!(ran < SLOW_CLOSE, "the run waited {ran:?} for the file's close");
		assert_eq!(written.lock().as_slice(), b"x\n");
	}

	#[tokio::test(start_paused = true)]
	async fn the_deadline_stops_shell_run_while_a_dropped_file_closes() {
		let (filesystem, written) = slow_close();
		let (tx, _rx) = flume::unbounded::<String>();
		let started = time::Instant::now();
		let result = Shell::new(Some(ShellOptions { filesystem, ..Default::default() }))
			.run(
				ShellRunOptions { command: COMMAND.into(), ..Default::default() },
				Some(tx),
				CancelToken::with_timeout(Some(CLOSE_DEADLINE)),
			)
			.await
			.expect("run");
		assert_timed_out_at_the_deadline(
			(result.exit_code, result.timed_out),
			started.elapsed(),
			&written,
		);
	}

	#[tokio::test(start_paused = true)]
	async fn the_deadline_stops_execute_shell_while_a_dropped_file_closes() {
		let (filesystem, written) = slow_close();
		let (tx, _rx) = flume::unbounded::<String>();
		let started = time::Instant::now();
		let result = execute_shell(
			ShellExecuteOptions { command: COMMAND.into(), filesystem, ..Default::default() },
			Some(tx),
			CancelToken::with_timeout(Some(CLOSE_DEADLINE)),
		)
		.await
		.expect("execute");
		assert_timed_out_at_the_deadline(
			(result.exit_code, result.timed_out),
			started.elapsed(),
			&written,
		);
	}

	#[tokio::test(start_paused = true)]
	async fn the_deadline_stops_execute_shell_streams_while_a_dropped_file_closes() {
		let (filesystem, written) = slow_close();
		let (tx, _rx) = flume::unbounded::<Bytes>();
		let started = time::Instant::now();
		let result = execute_shell_streams(
			ShellExecuteOptions { command: COMMAND.into(), filesystem, ..Default::default() },
			StreamSinks { stdout: Some(tx), stderr: None },
			CancelToken::with_timeout(Some(CLOSE_DEADLINE)),
		)
		.await
		.expect("execute");
		assert_timed_out_at_the_deadline(
			(result.exit_code, result.timed_out),
			started.elapsed(),
			&written,
		);
	}
}
