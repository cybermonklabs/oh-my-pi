//! A cancelled run leaves no command substitution or blocked writer behind.
//! Each body runs in a child with a bounded descriptor limit and deadline, so
//! a regression cannot hang the suite or consume the host's pipe quota.

#![cfg(target_os = "linux")]

use std::{
	io::{self, Read as _},
	os::unix::{fs::OpenOptionsExt as _, process::CommandExt as _},
	time::{Duration, Instant},
};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

#[path = "obash_support/mod.rs"]
mod support;

/// Set only in the child process that runs the test body.
const CHILD: &str = "PI_SHELL_TEST_RAISED_NOFILE_CHILD";
/// Raise the soft limit to the hard limit, with an explicit upper bound so
/// even an unusually configured host cannot give this child unlimited fds.
const NOFILE: libc::rlim_t = 1 << 20;
const RUN_TIMEOUT_MS: u32 = 1000;
const RETURN_BUDGET: Duration = Duration::from_millis(3500);
const RECURSIVE_TIMEOUT_MS: u32 = 12_000;
const RECURSIVE_RETURN_BUDGET: Duration = Duration::from_millis(14_500);

fn in_raised_limit_child(name: &str, budget: Duration) -> bool {
	if std::env::var_os(CHILD).is_some() {
		return true;
	}
	let mut command = support::command(std::env::current_exe().expect("test binary"));
	command
		.args(["--exact", name, "--nocapture"])
		.env(CHILD, "1");
	// SAFETY: runs before exec in the forked child; these syscalls allocate
	// nothing and change only the child process's limits.
	unsafe {
		command.pre_exec(|| {
			let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			if libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) != 0 {
				return Err(io::Error::last_os_error());
			}
			lim.rlim_cur = NOFILE.min(lim.rlim_max);
			if libc::setrlimit(libc::RLIMIT_NOFILE, &raw const lim) != 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let output = support::finish(command.spawn().expect("child test process"), budget);
	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		output.status.success() && stdout.contains("1 passed"),
		"child test {name} with at most {NOFILE} descriptors: \
		 {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
		output.status
	);
	// Keep resource measurements visible with --nocapture.
	eprint!("{stderr}");
	false
}

fn open_descriptors() -> usize {
	std::fs::read_dir("/proc/self/fd")
		.expect("descriptors")
		.count()
}

fn peak_rss_kib() -> libc::c_long {
	let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
	// SAFETY: getrusage fills usage on success.
	assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) }, 0);
	unsafe { usage.assume_init() }.ru_maxrss
}

fn runtime() -> tokio::runtime::Runtime {
	tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.enable_all()
		.build()
		.expect("tokio runtime")
}

async fn warmup(shell: &Shell) {
	let result = shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("warmup run");
	assert_eq!(result.exit_code, Some(0));
}

async fn still_usable(shell: &Shell) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: "printf RECOVERED".into(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(RUN_TIMEOUT_MS)),
		)
		.await
		.expect("run after cancellation");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>(), "RECOVERED");
}

/// Bash also recurses when PS4 explicitly enables tracing again. Cancellation
/// must unwind the entire tree, not only the root's waiting expansion.
#[test]
fn a_timed_out_run_returns_after_its_substitutions_are_gone() {
	if !in_raised_limit_child(
		"a_timed_out_run_returns_after_its_substitutions_are_gone",
		Duration::from_secs(50),
	) {
		return;
	}
	runtime().block_on(async {
		let shell = Shell::new(None);
		warmup(&shell).await;
		let baseline = open_descriptors();
		for repeat in 0..3 {
			let start = Instant::now();
			let result = shell
				.run(
					ShellRunOptions {
						command: "PS4='$(set -x; printf P)+ '; set -x; :".into(),
						..Default::default()
					},
					None,
					CancelToken::new(Some(RECURSIVE_TIMEOUT_MS)),
				)
				.await
				.expect("run");
			let elapsed = start.elapsed();
			let at_return = open_descriptors();
			eprintln!(
				"recursive PS4 repeat={repeat} elapsed={elapsed:?} fd={baseline}->{at_return} \
				 peak_rss_kib={}",
				peak_rss_kib()
			);
			assert!(result.timed_out, "repeat {repeat}: {result:?}");
			assert!(elapsed <= RECURSIVE_RETURN_BUDGET, "repeat {repeat}: returned after {elapsed:?}");
			assert!(
				at_return <= baseline,
				"repeat {repeat}: {at_return} descriptors open when run returned, {baseline} before"
			);
			still_usable(&shell).await;
		}
	});
}

fn drain_fifo(fifo: &mut std::fs::File) -> usize {
	let mut bytes = [0; 8192];
	let mut total = 0;
	loop {
		match fifo.read(&mut bytes) {
			Ok(0) => return total,
			Ok(n) => total += n,
			Err(err) if err.kind() == io::ErrorKind::WouldBlock => return total,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => panic!("read FIFO: {err}"),
		}
	}
}

/// A substitution blocked on a full FIFO cannot keep writing after timeout,
/// resume the parent command, or poison the next run of the same Shell.
#[test]
fn a_timed_out_substitution_stops_writing_to_a_full_fifo() {
	if !in_raised_limit_child(
		"a_timed_out_substitution_stops_writing_to_a_full_fifo",
		Duration::from_secs(25),
	) {
		return;
	}
	let dir = tempfile::tempdir().expect("tempdir");
	let fifo_path = dir.path().join("fifo");
	let fifo_name = std::ffi::CString::new(fifo_path.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: fifo_name is NUL-terminated; the path is in our temp directory.
	assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
	let mut fifo = std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo_path)
		.expect("hold FIFO open without reading");
	let late = dir.path().join("late");
	let command = format!("x=$(printf '%s' '{}' >fifo); printf BAD >late", "X".repeat(256 * 1024));
	runtime().block_on(async {
		let shell = Shell::new(None);
		warmup(&shell).await;
		let baseline = open_descriptors();
		for repeat in 0..5 {
			let start = Instant::now();
			let result = shell
				.run(
					ShellRunOptions {
						command: command.clone(),
						cwd: Some(dir.path().to_string_lossy().into_owned()),
						..Default::default()
					},
					None,
					CancelToken::new(Some(RUN_TIMEOUT_MS)),
				)
				.await
				.expect("blocked FIFO run");
			let elapsed = start.elapsed();
			let at_return = open_descriptors();
			eprintln!("full FIFO repeat={repeat} elapsed={elapsed:?} fd={baseline}->{at_return}");
			assert!(result.timed_out, "repeat {repeat}: {result:?}");
			assert!(elapsed <= RETURN_BUDGET, "repeat {repeat}: returned after {elapsed:?}");
			assert!(at_return <= baseline, "repeat {repeat}: fd {baseline}->{at_return}");
			assert!(!late.exists(), "repeat {repeat}: parent continued after cancellation");
			let queued = drain_fifo(&mut fifo);
			assert!(queued > 0 && queued < 256 * 1024, "repeat {repeat}: FIFO held {queued} bytes");
			tokio::time::sleep(Duration::from_millis(200)).await;
			assert_eq!(drain_fifo(&mut fifo), 0, "repeat {repeat}: writer survived run return");
			assert!(!late.exists(), "repeat {repeat}: parent resumed when FIFO was drained");
			still_usable(&shell).await;
		}
	});
}
