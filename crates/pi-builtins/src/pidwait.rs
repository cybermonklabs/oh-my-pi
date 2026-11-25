//! `pidwait` process-waiting builtin, moved from `pi-shell`.

use clap::Parser;

use crate::{
	host::{ProcContext, Process},
	proc_match,
};

/// Waits for processes selected by process attributes or a name pattern.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PidwaitCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for PidwaitCommand {
	const USES_PATHS: bool = true;

	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Wait, &self.argv, context)
	}
}

#[cfg(test)]
mod tests {
	use std::{process::Command as ProcessCommand, time::Duration};

	use super::PidwaitCommand;
	use crate::host::run_proc;

	async fn execute_bounded(argv: &[&str]) -> i32 {
		let argv: Vec<&str> = std::iter::once("pidwait").chain(argv.iter().copied()).collect();
		tokio::time::timeout(Duration::from_secs(2), run_proc::<PidwaitCommand>(&argv, None))
			.await
			.expect("pidwait exceeded its two-second test bound")
			.0
	}

	#[tokio::test]
	async fn exits_one_when_nothing_matches() {
		assert_eq!(execute_bounded(&["-p", &i32::MAX.to_string()]).await, 1);
	}

	#[tokio::test]
	async fn already_exited_pid_returns_promptly() -> anyhow::Result<()> {
		#[cfg(unix)]
		let mut child = ProcessCommand::new("sh").args(["-c", "exit 0"]).spawn()?;
		#[cfg(windows)]
		let mut child = ProcessCommand::new("cmd").args(["/C", "exit 0"]).spawn()?;
		let pid = child.id();

		// Leave the child unreaped so it remains visible in the process snapshot,
		// and wait until it has exited: `WNOWAIT` sees the exit without reaping.
		// The wait blocks in `waitid` on a thread of its own: the runtime's
		// shutdown would wait for a blocking-pool thread, and the timeout would
		// not end the test.
		#[cfg(target_os = "linux")]
		{
			use nix::{
				errno::Errno,
				sys::wait::{Id, WaitPidFlag, waitid},
				unistd::Pid,
			};
			let child_pid = Pid::from_raw(i32::try_from(pid)?);
			let (sender, exited) = tokio::sync::oneshot::channel();
			std::thread::spawn(move || {
				let done = loop {
					match waitid(Id::Pid(child_pid), WaitPidFlag::WEXITED | WaitPidFlag::WNOWAIT) {
						Err(Errno::EINTR) => {},
						done => break done,
					}
				};
				let _ = sender.send(done);
			});
			let Ok(exited) = tokio::time::timeout(Duration::from_secs(10), exited).await else {
				let _ = child.kill();
				anyhow::bail!("the child did not exit");
			};
			exited??;
		}
		// Elsewhere, give the trivial command time to reach its exited state.
		#[cfg(not(target_os = "linux"))]
		tokio::time::sleep(Duration::from_millis(100)).await;
		let code = execute_bounded(&["-p", &pid.to_string()]).await;
		let _ = child.kill();
		let _ = child.wait();

		assert!(code == 0 || code == 1, "status {code}");
		Ok(())
	}

	/// Set by [`LeaderGone::start`] for its child: `leader_exits_first` does
	/// nothing without it, so `--include-ignored` cannot end the leader of
	/// the test runner itself.
	#[cfg(target_os = "linux")]
	const HELPER: &str = "PI_BUILTINS_LEADER_EXIT_HELPER";

	/// The child process of [`LeaderGone`]: its leader thread exits, from a
	/// SIGUSR1 handler this test body sends it, while this thread runs on.
	/// libtest runs the body on a thread of its own, so the leader is free.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by LeaderGone::start"]
	fn leader_exits_first() {
		extern "C" fn end_this_thread(_: libc::c_int) {
			// SAFETY: ends the calling thread alone; the process runs on.
			unsafe { libc::syscall(libc::SYS_exit, 0) };
		}
		if std::env::var_os(HELPER).is_none() {
			return;
		}
		// SAFETY: a handler for a signal only this process sends itself.
		unsafe { libc::signal(libc::SIGUSR1, end_this_thread as *const () as libc::sighandler_t) };
		let me = std::process::id() as i32;
		// SAFETY: plain syscall; the leader's thread id is the process id.
		unsafe { libc::syscall(libc::SYS_tgkill, me, me, libc::SIGUSR1) };
		loop {
			std::thread::park();
		}
	}

	/// A child process whose leader thread has exited while another thread
	/// runs; killed and reaped on drop.
	#[cfg(target_os = "linux")]
	struct LeaderGone(std::process::Child);

	#[cfg(target_os = "linux")]
	impl LeaderGone {
		fn start() -> Self {
			let child = ProcessCommand::new(std::env::current_exe().unwrap())
				.args(["--ignored", "--exact", "pidwait::tests::leader_exits_first"])
				.env(HELPER, "1")
				.stdout(std::process::Stdio::null())
				.stderr(std::process::Stdio::null())
				.spawn()
				.unwrap();
			let gone = Self(child);
			// The helper's leader exits within milliseconds of its start; the
			// bound only keeps a broken helper from hanging the suite.
			let deadline = std::time::Instant::now() + Duration::from_secs(30);
			while std::fs::read_to_string(format!("/proc/{}/stat", gone.0.id()))
				.ok()
				.and_then(|stat| crate::proc_snapshot::sys::stat_fields(&stat)?.next().map(str::to_owned))
				.as_deref()
				!= Some("Z")
			{
				assert!(std::time::Instant::now() < deadline, "the helper's leader did not exit in 30 s");
				std::thread::sleep(Duration::from_millis(1));
			}
			let status = std::fs::read_to_string(format!("/proc/{}/status", gone.0.id())).unwrap();
			assert!(
				status.lines().any(|l| l
					.strip_prefix("Threads:")
					.is_some_and(|n| n.trim().parse::<u32>().is_ok_and(|n| n > 1))),
				"the helper kept no live thread (did --exact select leader_exits_first?): {status}"
			);
			gone
		}

		/// Kills the child without reaping it, and returns once every thread
		/// of it has exited: its pidfd turns readable then.
		fn kill_unreaped(&mut self) {
			self.0.kill().unwrap();
			// SAFETY: pidfd_open takes scalar arguments; the child is unreaped,
			// so its pid names it.
			let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, self.0.id(), 0) } as libc::c_int;
			assert!(fd >= 0, "pidfd_open: {}", std::io::Error::last_os_error());
			let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
			// SAFETY: one valid pollfd for the call; 30 s only bounds a hang.
			let ready = unsafe { libc::poll(&raw mut poll, 1, 30_000) };
			// SAFETY: the pidfd is ours to close.
			unsafe { libc::close(fd) };
			assert_eq!(ready, 1, "the killed child's threads did not all exit in 30 s");
		}
	}

	#[cfg(target_os = "linux")]
	impl Drop for LeaderGone {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	/// `pidwait` waits for a process whose leader thread exited while another
	/// thread runs: `/proc/<pid>/stat` shows it `Z`, yet it runs until killed.
	/// The two seconds are how long the test looks for an early return; on a
	/// tree that takes the `Z` for an exit, `pidwait` returns within
	/// milliseconds.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn waits_for_a_process_whose_leader_has_exited() {
		let mut gone = LeaderGone::start();
		let pid = gone.0.id().to_string();
		let argv = ["pidwait", "-p", &pid];
		let wait = run_proc::<PidwaitCommand>(&argv, None);
		tokio::pin!(wait);
		tokio::select! {
			(code, ..) = &mut wait => panic!("pidwait returned {code} while the process runs"),
			() = tokio::time::sleep(Duration::from_secs(2)) => {},
		}
		gone.0.kill().unwrap();
		let (code, ..) = tokio::time::timeout(Duration::from_secs(30), wait)
			.await
			.expect("pidwait returns once the process is killed");
		assert_eq!(code, 0);
	}

	/// The controls, on `status()` itself (a `pidwait` of a zombie returns on
	/// its readable pidfd whatever `status()` says): a process with nothing
	/// but its exited leader left has exited, whether it had one thread or
	/// several, though nobody reaped it yet.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_process_with_only_its_exited_leader_left_has_exited() {
		let mut child = ProcessCommand::new("/bin/sleep").arg("0.2").spawn().unwrap();
		let process = crate::proc_snapshot::ProcInfo::all()
			.into_iter()
			.find(|process| process.pid() == child.id() as i32)
			.expect("sleep is listed");
		let deadline = std::time::Instant::now() + Duration::from_secs(30);
		while std::fs::read_to_string(format!("/proc/{}/stat", child.id()))
			.ok()
			.and_then(|stat| crate::proc_snapshot::sys::stat_fields(&stat)?.next().map(str::to_owned))
			.as_deref()
			!= Some("Z")
		{
			assert!(std::time::Instant::now() < deadline, "sleep did not exit in 30 s");
			std::thread::sleep(Duration::from_millis(1));
		}
		assert_eq!(process.status(), crate::proc_snapshot::ProcessStatus::Exited);
		assert!(child.wait().unwrap().success());
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn a_killed_process_whose_leader_had_exited_has_exited() {
		let mut gone = LeaderGone::start();
		let process = crate::proc_snapshot::ProcInfo::all()
			.into_iter()
			.find(|process| process.pid() == gone.0.id() as i32)
			.expect("the helper is listed");
		gone.kill_unreaped();
		assert_eq!(process.status(), crate::proc_snapshot::ProcessStatus::Exited);
	}

	/// A waiting `pidwait` must not hold a blocking-pool thread: hosts cap that
	/// pool (eight threads in pi-natives on Windows) and run every utility
	/// builtin on it, so a few long waits would stall unrelated commands.
	#[test]
	fn waiting_holds_no_blocking_pool_thread() -> anyhow::Result<()> {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.max_blocking_threads(1)
			.enable_all()
			.build()?;
		runtime.block_on(async {
			#[cfg(unix)]
			let mut child = ProcessCommand::new("sleep").arg("30").spawn()?;
			#[cfg(windows)]
			let mut child = ProcessCommand::new("ping")
				.args(["-n", "30", "127.0.0.1"])
				.stdout(std::process::Stdio::null())
				.spawn()?;
			let pid = child.id().to_string();
			let argv = ["pidwait", "-p", &pid];
			let mut pidwait = std::pin::pin!(run_proc::<PidwaitCommand>(&argv, None));
			// `None`: pidwait returned while its process was still running.
			let probed = if futures::poll!(pidwait.as_mut()).is_pending() {
				// Pending: pidwait selected the process and waits for its exit,
				// its first await. Only now does a blocking task show whether
				// that wait holds the pool's one thread.
				let probe = tokio::task::spawn_blocking(|| {});
				tokio::select! {
					_ = pidwait => None,
					probed = tokio::time::timeout(Duration::from_secs(5), probe) => Some(probed),
				}
			} else {
				None
			};
			let _ = child.kill();
			let _ = child.wait();

			let probed = probed.expect("pidwait returned while its process was running");
			assert!(
				matches!(probed, Ok(Ok(()))),
				"a blocking task could not run while pidwait was waiting"
			);
			Ok(())
		})
	}
}
