//! Cancelling a run reaches the in-process background jobs it started, so a
//! run cancelled while it `wait`s on one ends at once and reports why (its
//! result says it timed out; like bash killed by a signal, the shell prints
//! nothing).
#![cfg(unix)]

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken, testkit};

/// Each `&` job had a token of its own that the run's token did not reach, so
/// the cancelled run sat in `wait` until the host's grace aborted it.
///
/// The shell's cancel grace is widened past the test runner's own bound
/// ([`ShellOptions::cancel_grace`]), so the run can only end through the
/// cancel reaching its background job: a run that still waits for the grace
/// never returns, and the runner fails the test rather than a wall-clock
/// assertion that a loaded host beats. The jobs outlive that bound too.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_run_stops_waiting_on_its_background_job() {
	let secs = testkit::child::LIFETIME.as_secs();
	for script in [
		format!("sleep {secs} & wait; echo after"),
		format!("{{ sleep {secs}; }} & wait %1; echo after"),
	] {
		let (tx, rx) = flume::unbounded::<String>();
		let shell = Shell::new(Some(ShellOptions {
			cancel_grace: Some(testkit::child::LIFETIME),
			..Default::default()
		}));
		let result = shell
			.run(
				ShellRunOptions { command: script.clone(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(300)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();

		assert!(!output.contains("after"), "`{script}` kept running: {output:?}");
		assert_eq!((result.exit_code, result.timed_out), (None, true), "`{script}`");
	}
}
