//! The session contracts of background jobs that no single script's output
//! shows: dropping the shell stops its loops, and a job one run reported is
//! forgotten by the next run of the same shell. The rows of Bash-oracle
//! scripts are in `bash_rows.rs`.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs `command` in `shell`, returning its exit status and output. The
/// bound is for a script that hangs: a loaded host takes seconds for a
/// script that waits on processes, and nextest ends a test of its own after
/// 240 s.
async fn run_in(shell: &Shell, command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: command.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

/// Whether something appends to `path` within 300 ms.
fn still_written(path: &std::path::Path) -> bool {
	let before = std::fs::metadata(path).map_or(0, |meta| meta.len());
	std::thread::sleep(std::time::Duration::from_millis(300));
	std::fs::metadata(path).map_or(0, |meta| meta.len()) > before
}

/// Dropping the shell stops a background loop of builtins within a bound,
/// plain or `disown`ed. Such a loop never yields, so the abort a dropped task
/// handle requests never lands; on main the loop kept running after its
/// shell was gone. The shell runs on its own runtime, shut down without
/// waiting, so a loop that does not stop fails this test instead of hanging
/// it.
#[test]
fn dropping_the_shell_stops_its_background_loops() {
	for suffix in ["", " disown"] {
		let dir = tempfile::tempdir().expect("temporary directory");
		let output = dir.path().join("out");
		let script = format!("(while :; do echo x >> '{}'; done) &{suffix}", output.display());
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(2)
			.enable_all()
			.build()
			.expect("runtime");
		let shell = runtime.block_on(async {
			let shell = Shell::new(None);
			shell
				.run(
					ShellRunOptions { command: script, ..Default::default() },
					None,
					CancelToken::default(),
				)
				.await
				.expect("run");
			shell
		});
		assert!(still_written(&output), "`{suffix}`: the loop never started");
		runtime.block_on(async move { drop(shell) });
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
		let mut stopped = false;
		while std::time::Instant::now() < deadline {
			if !still_written(&output) {
				stopped = true;
				break;
			}
		}
		runtime.shutdown_background();
		assert!(stopped, "`{suffix}`: the loop kept running 5 s after its shell was dropped");
	}
}

/// Starts an external job that exits with status 1 and waits until it has
/// exited, setting `$p` to its pid. Nothing has reported the job yet. A
/// foreground process waits for the exit, so the shell's runtime learns of it
/// no later than of the foreground process's own.
#[cfg(target_os = "linux")]
const ENDED_EXTERNAL_JOB: &str = r#"/bin/sh -c 'exit 1' & p=$!; /bin/sh -c 'until [ ! -e "/proc/$1" ] || [ "$(cut -d " " -f 3 "/proc/$1/stat" 2>/dev/null)" = Z ]; do :; done' sh "$p"; "#;

/// The same for a job the shell runs itself. A `sleep` in the loop that
/// waits for it lets the job's task run.
#[cfg(target_os = "linux")]
const ENDED_IN_PROCESS_JOB: &str =
	r#"f(){ return 1; }; f & p=$!; while kill -0 "$p" 2>/dev/null; do sleep 0.01; done; "#;

/// Each run of a persistent shell starts a new input line, so it no longer
/// finds a job a listing in an earlier run reported, while the job's pid keeps
/// its status for `wait`. Bash 5.3.20 and 5.2.21 give the same for both runs
/// as one `bash -c` script, the second run on its own line.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_new_shell_input_forgets_a_job_jobs_reported() {
	for job in [ENDED_IN_PROCESS_JOB, ENDED_EXTERNAL_JOB] {
		let shell = Shell::new(None);
		assert_eq!(run_in(&shell, &format!("{job}jobs >/dev/null")).await, (Some(0), String::new()));
		assert_eq!(
			run_in(&shell, r#"wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#).await,
			(Some(0), "job=127\npid=1\n".to_owned())
		);
	}
}

/// With output filtering on, the bash tool runs the commands of a `;`/`&&`
/// chain one at a time, and each chain gives what `bash -c` gives for the
/// whole chain run after the job's: a job `jobs` reported is gone for the
/// next command, on the same line or the next, so `wait %1` returns 127
/// (Bash 5.3.20 and 5.2.21 alike).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_chain_run_a_command_at_a_time_forgets_a_reported_job_per_line() {
	use pi_shell::{
		ShellOptions,
		minimizer::{MinimizerConfig, MinimizerOptions, engine},
	};

	let options = MinimizerOptions { enabled: Some(true), ..Default::default() };
	for (chain, output) in [
		(r#"jobs >/dev/null; wait %1 2>/dev/null; echo "job=$?""#, "job=127\n"),
		("jobs >/dev/null\nwait %1 2>/dev/null; echo \"job=$?\"", "job=127\n"),
	] {
		assert_eq!(
			engine::mode_for(chain, &MinimizerConfig::from_options(&options)),
			engine::MinimizerMode::SegmentedChain,
			"`{chain}` must run a command at a time"
		);
		for job in [ENDED_EXTERNAL_JOB, ENDED_IN_PROCESS_JOB] {
			let shell = Shell::new(Some(ShellOptions {
				minimizer: Some(options.clone()),
				..Default::default()
			}));
			assert_eq!(run_in(&shell, job).await, (Some(0), String::new()));
			assert_eq!(run_in(&shell, chain).await, (Some(0), output.to_owned()), "`{chain}`");
		}
	}
}
