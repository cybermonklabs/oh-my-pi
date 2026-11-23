//! A run keeps the output its command wrote however late the reader that
//! takes it runs. Once the command has ended, the run waits for more output
//! only until the pipe has been quiet for 250 ms (2 s at most), because a job
//! the command left running may hold the pipe open for ever; that wait's end
//! must not drop what the pipe already holds.
//!
//! The clock is paused, so a consumer that takes the output only 10 s after
//! the command (well past the wait) holds the reader there without any real
//! time passing: no verdict here depends on the machine's speed.

use std::time::Duration;

#[cfg(unix)]
use bytes::Bytes;
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
#[cfg(unix)]
use pi_shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams};

/// `one`, then, once the reader has taken `one` (the in-process `sleep`
/// lets it run), `two`: the pipe holds `two` when the post-exit wait ends,
/// while the reader still waits for the consumer to take `one`.
const COMMAND: &str = "echo one; sleep 1; echo two";
const WRITTEN: &str = "one\ntwo\n";

/// When the consumer starts taking output: well past the post-exit wait.
const CONSUMER_LATE: Duration = Duration::from_secs(10);

/// The run's own bound, far past everything else here.
fn cancel() -> CancelToken {
	CancelToken::new(Some(600_000))
}

/// `Shell::run`'s reader, parked on a consumer that takes its first chunk
/// after the post-exit wait, still delivers all the command wrote.
#[tokio::test(start_paused = true)]
async fn a_run_keeps_what_a_late_consumer_takes() {
	// No room in the channel: every chunk waits for the consumer.
	let (tx, rx) = flume::bounded::<String>(0);
	let consumer = tokio::spawn(async move {
		tokio::time::sleep(CONSUMER_LATE).await;
		let mut taken = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			taken.push_str(&chunk);
		}
		taken
	});
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: COMMAND.to_owned(), ..Default::default() },
			Some(tx),
			cancel(),
		)
		.await
		.expect("run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(consumer.await.expect("consumer"), WRITTEN);
}

/// `execute_shell_streams`' stdout reader, parked on a sink whose consumer
/// takes its first chunk after the post-exit wait, still delivers all the
/// command wrote.
///
/// Unix only: on Windows the readers' reads run on tokio's blocking pool, and
/// the stderr reader's read in flight (its pipe stays empty until the command
/// ends) keeps the paused clock from moving, so `sleep 1` never ends there.
/// The Windows byte reader's stop is `output_drain`'s.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn streams_keep_what_a_late_consumer_takes() {
	let (tx, rx) = flume::bounded::<Bytes>(0);
	let consumer = tokio::spawn(async move {
		tokio::time::sleep(CONSUMER_LATE).await;
		let mut taken = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			taken.extend_from_slice(&chunk);
		}
		taken
	});
	let result = execute_shell_streams(
		ShellExecuteOptions { command: COMMAND.to_owned(), ..Default::default() },
		StreamSinks { stdout: Some(tx), stderr: None },
		cancel(),
	)
	.await
	.expect("execute");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(consumer.await.expect("consumer"), WRITTEN.as_bytes());
}
