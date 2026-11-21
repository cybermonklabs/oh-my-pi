//! The `sleep` builtin, moved from `pi-shell`.

use std::{future::Future, io::Write, time::Duration};

use clap::Parser;
use tokio::time;

use crate::{
	duration::parse_duration,
	host::{INTERRUPTED_EXIT_CODE, ProcContext, Process},
};

/// Pause execution for the sum of the requested durations.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct SleepCommand {
	// GNU reports `sleep -1` as an invalid time interval (exit 1), not as an
	// unknown option; let hyphenated operands through to `parse_duration`.
	#[arg(required = true, allow_hyphen_values = true)]
	durations: Vec<String>,
}

impl SleepCommand {
	/// The time `durations` ask for: their sum, saturating (`infinity` parses
	/// as `Duration::MAX`), or the first that is not a time interval.
	fn total(durations: &[String]) -> Result<Duration, &str> {
		let mut total = Duration::ZERO;
		for duration in durations {
			let parsed = parse_duration(duration).ok_or(duration.as_str())?;
			total = total.saturating_add(parsed);
		}
		Ok(total)
	}
}

impl Process for SleepCommand {
	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		let durations = &self.durations;
		async move {
			if context.is_cancelled() {
				return Ok(INTERRUPTED_EXIT_CODE);
			}
			let total = match Self::total(durations) {
				Ok(total) => total,
				Err(duration) => {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(1);
				},
			};
			context.flush_output().await?;
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(0),
					() = cancel_token.cancelled() => Ok(INTERRUPTED_EXIT_CODE),
				}
			} else {
				sleep.await;
				Ok(0)
			}
		}
	}
}

#[cfg(test)]
mod tests {
	// No verdict here depends on the wall clock, which a loaded host
	// stretches past any bound: a time is checked in `SleepCommand::total`,
	// and a cancel by the exit code. `HANG` only names a sleep that never
	// returns, rather than leaving it to the runner's timeout.
	use std::{future::Future, time::Duration};

	use tokio_util::sync::CancellationToken;

	use super::SleepCommand;
	use crate::{duration::parse_duration, host::run_proc};

	/// Far above any correct run: a loaded host took over 100 ms for a 2 ms
	/// sleep, not seconds.
	const HANG: Duration = Duration::from_secs(30);

	async fn returns<T>(what: &str, run: impl Future<Output = T>) -> T {
		tokio::time::timeout(HANG, run)
			.await
			.unwrap_or_else(|_| panic!("{what} did not return within {HANG:?}"))
	}

	#[tokio::test]
	async fn valid_durations_parse_and_short_sleep_completes() {
		assert_eq!(parse_duration("0.001"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001s"), Some(Duration::from_millis(1)));
		assert_eq!(parse_duration("0.001m"), Some(Duration::from_millis(60)));
		// Sub-millisecond precision must survive: GNU sleep honors 100µs.
		assert_eq!(parse_duration("0.0001"), Some(Duration::from_micros(100)));
		assert_eq!(parse_duration("0.000001h"), Some(Duration::from_micros(3600)));
		assert_eq!(parse_duration("0.00000001d"), Some(Duration::from_micros(864)));

		let operands = ["0.001", "0.001s"].map(String::from);
		assert_eq!(SleepCommand::total(&operands), Ok(Duration::from_millis(2)), "the operands sum");
		let (code, ..) = returns("sleep 0.001 0.001s", run_proc::<SleepCommand>(&["sleep", "0.001", "0.001s"], None)).await;
		assert_eq!(code, 0);
	}

	#[tokio::test]
	async fn infinity_operand_parses_and_sleep_is_cancellable() {
		// GNU accepts `inf`/`infinity`, any case, with an optional `+` sign.
		for spec in ["infinity", "inf", "INFINITY", "Inf", "+infinity", "+inf"] {
			assert_eq!(parse_duration(spec), Some(Duration::MAX), "spec {spec:?}");
		}
		assert_eq!(parse_duration("nan"), None);
		assert_eq!(parse_duration("-inf"), None);

		// `sleep infinity` must block until cancelled rather than erroring out.
		let token = CancellationToken::new();
		let ((code, ..), ()) = returns(
			"a cancelled sleep infinity",
			async {
				tokio::join!(run_proc::<SleepCommand>(&["sleep", "infinity"], Some(token.clone())), async {
					tokio::task::yield_now().await;
					token.cancel();
				})
			},
		)
		.await;
		assert_eq!(code, 130);
	}

	#[tokio::test]
	async fn hyphenated_operand_is_an_invalid_interval_not_an_unknown_flag() {
		// `sleep -1` must not die in clap with an unknown-option error; GNU
		// reports an invalid time interval and exits 1.
		let (code, _, stderr) = run_proc::<SleepCommand>(&["sleep", "-1"], None).await;
		assert_eq!(code, 1);
		assert_eq!(stderr, "sleep: invalid time interval '-1'\n");
	}

	#[tokio::test]
	async fn invalid_duration_reports_original_diagnostic_and_exit_code() {
		let (code, _, stderr) = run_proc::<SleepCommand>(&["sleep", "not-a-duration"], None).await;
		assert_eq!(code, 1);
		assert_eq!(stderr, "sleep: invalid time interval 'not-a-duration'\n");
	}

	#[tokio::test]
	async fn cancelled_invocation_returns_promptly() {
		// An hour, so the cancel always comes first: a sleep that ignored it
		// fails at `HANG`, and one that ended first would exit 0.
		let token = CancellationToken::new();
		let ((code, ..), ()) = returns("a cancelled sleep 3600", async {
			tokio::join!(run_proc::<SleepCommand>(&["sleep", "3600"], Some(token.clone())), async {
				tokio::task::yield_now().await;
				token.cancel();
			})
		})
		.await;
		assert_eq!(code, 130);
	}
}
