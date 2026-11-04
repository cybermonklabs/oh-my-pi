//! Cancellation owns the process identities it started, including members
//! that leave a group on TERM and descendants of an already-reaped command.

use pi_builtins::{PinnedProcess, ProcessStatus};

use super::*;

const ACTOR: &str = r"import os, signal, sys, time
from pathlib import Path
root, shape = Path(sys.argv[1]), sys.argv[2]
def record(name):
    (root / (name + '.pid')).write_text(str(os.getpid()))
record('leader')
leader = os.getpid()
worker = os.fork()
if worker:
    if shape == 'orphan':
        while not (root / 'worker-ready').exists(): time.sleep(.005)
        os._exit(0)
    while True: time.sleep(1)
record('worker')
os.close(1)
os.close(2)
if shape == 'setsid':
    def term(*_):
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (root / 'term').touch()
    signal.signal(signal.SIGTERM, term)
if shape == 'orphan':
    (root / 'worker-ready').touch()
    while Path('/proc/' + str(leader)).exists(): time.sleep(.005)
    if os.fork() == 0:
        record('grandchild')
    else:
        while not (root / 'grandchild.pid').exists(): time.sleep(.005)
        (root / 'ready').touch()
else:
    (root / 'ready').touch()
while True: time.sleep(1)
";

/// End only the processes recorded by this fixture, even when an assertion
/// fails before the shell's cancellation finishes.
struct Cleanup(std::path::PathBuf);

impl Cleanup {
	fn pins(&self) -> Vec<PinnedProcess> {
		fs::read_dir(&self.0)
			.expect("fixture directory")
			.flatten()
			.filter(|entry| entry.path().extension().is_some_and(|ext| ext == "pid"))
			.filter_map(|entry| fs::read_to_string(entry.path()).ok()?.parse().ok())
			.filter_map(PinnedProcess::from_pid)
			.collect()
	}
}

impl Drop for Cleanup {
	fn drop(&mut self) {
		for pin in self.pins() {
			pin.kill(libc::SIGKILL);
		}
	}
}

async fn ownership_case(shape: &str, deadline: bool) {
	let root = tempfile::tempdir().expect("ownership fixture");
	let cleanup = Cleanup(root.path().to_path_buf());
	let script = root.path().join("actor.py");
	fs::write(&script, ACTOR).expect("write actor");
	let body = format!(
		"python3 {} {} {shape}; /bin/sleep 120",
		quote_arg(script.to_str().expect("script path")),
		quote_arg(root.path().to_str().expect("fixture path")),
	);
	let command = if deadline {
		format!("f() {{ {body}; }}; timeout -k .3 3 f")
	} else {
		body
	};
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let shell = Arc::new(Shell::new(None));
	let running = Arc::clone(&shell);
	let mut run = tokio::spawn(async move {
		running
			.run(ShellRunOptions { command, ..Default::default() }, None, cancel)
			.await
	});
	time::timeout(Duration::from_secs(20), async {
		while !root.path().join("ready").exists() {
			assert!(!run.is_finished(), "{shape}: run ended before fixture readiness");
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("fixture readiness");
	let pins = cleanup.pins();
	assert_eq!(pins.len(), 2, "the two live fixture processes must be pinned before cancellation");
	if !deadline {
		abort.abort(AbortReason::Signal);
	}
	let result = time::timeout(Duration::from_secs(20), &mut run)
		.await
		.expect("cancelled run must settle")
		.expect("run task")
		.expect("run result");
	if deadline {
		assert!(matches!(result.exit_code, Some(124 | 137)), "{result:?}");
	} else {
		assert!(result.cancelled, "{result:?}");
	}
	time::timeout(Duration::from_secs(5), async {
		while pins
			.iter()
			.any(|pin| pin.status() == ProcessStatus::Running)
		{
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.unwrap_or_else(|_| panic!("{shape}, deadline={deadline}: a recorded process survived"));
	if shape == "setsid" {
		assert!(root.path().join("term").exists(), "the TERM handler must run before KILL");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_stops_a_plain_background_member() {
	ownership_case("simple", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_stops_a_plain_background_member() {
	ownership_case("simple", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_stops_a_member_that_calls_setsid_on_term() {
	ownership_case("setsid", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_stops_a_member_that_calls_setsid_on_term() {
	ownership_case("setsid", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_stops_a_child_forked_after_the_leader_was_reaped() {
	ownership_case("orphan", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_stops_a_child_forked_after_the_leader_was_reaped() {
	ownership_case("orphan", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ownership_survives_without_kernel_group_signals() {
	if !crate::test_support::without_kernel_group_signal(
		module_path!(),
		"ownership_survives_without_kernel_group_signals",
	) {
		return;
	}
	for shape in ["simple", "setsid", "orphan"] {
		for deadline in [false, true] {
			ownership_case(shape, deadline).await;
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_queued_run_preserves_the_active_run_and_its_abort_handle() {
	for abort_active in [false, true] {
		let root = tempfile::tempdir().expect("queued run fixture");
		let ready = root.path().join("ready");
		let release = root.path().join("release");
		let shell = Arc::new(Shell::new(None));
		let running = Arc::clone(&shell);
		let mut first_cancel = CancelToken::default();
		let stop_first = first_cancel.emplace_abort_token();
		let body = format!(
			": > {}; while [ ! -e {} ]; do /bin/sleep .05; done",
			quote_arg(ready.to_str().unwrap()),
			quote_arg(release.to_str().unwrap())
		);
		let mut first = tokio::spawn(async move {
			running
				.run(
					ShellRunOptions {
						command: format!("KEEP=retained; /bin/sh -c {}", quote_arg(&body)),
						..Default::default()
					},
					None,
					first_cancel,
				)
				.await
		});
		time::timeout(Duration::from_secs(20), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("first run ready");
		let mut queued_cancel = CancelToken::default();
		queued_cancel
			.emplace_abort_token()
			.abort(AbortReason::Signal);
		let queued = shell
			.run(
				ShellRunOptions { command: "KEEP=overwritten".into(), ..Default::default() },
				None,
				queued_cancel,
			)
			.await
			.expect("queued result");
		let spared = !first.is_finished();
		if abort_active {
			shell.abort().await;
		} else {
			fs::write(&release, "").unwrap();
		}
		let completed = time::timeout(Duration::from_secs(10), &mut first).await;
		if completed.is_err() {
			stop_first.abort(AbortReason::Signal);
			let _ = first.await;
		}
		let active = completed
			.expect("queued cancellation must not clear the active abort handle")
			.expect("active task")
			.expect("active result");
		assert!(queued.cancelled && spared, "a queued cancel must not reach the active command");
		if abort_active {
			assert!(active.cancelled, "Shell::abort must still reach the active run");
		} else {
			assert_eq!(active.exit_code, Some(0));
			let (tx, rx) = flume::unbounded();
			shell
				.run(
					ShellRunOptions { command: "printf '%s' \"$KEEP\"".into(), ..Default::default() },
					Some(tx),
					CancelToken::default(),
				)
				.await
				.expect("read retained state");
			assert_eq!(rx.try_iter().collect::<String>(), "retained");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn an_engine_term_trap_can_start_its_cleanup_command() {
	let root = tempfile::tempdir().expect("engine trap fixture");
	let ready = root.path().join("ready");
	let done = root.path().join("done");
	let trap =
		format!("/bin/sleep .65; printf done > {}; exit 0", quote_arg(done.to_str().unwrap()));
	let command = format!(
		"trap {} TERM; : > {}; while :; do /bin/sleep 120; done",
		quote_arg(&trap),
		quote_arg(ready.to_str().unwrap())
	);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let run = tokio::spawn(async move {
		Shell::new(None)
			.run(ShellRunOptions { command, ..Default::default() }, None, cancel)
			.await
	});
	time::timeout(Duration::from_secs(20), async {
		while !ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("engine TERM trap ready");
	let started = std::time::Instant::now();
	abort.abort(AbortReason::Signal);
	let result = time::timeout(Duration::from_secs(20), run)
		.await
		.expect("trap cancellation completed")
		.expect("trap run task")
		.expect("trap run result");
	assert!(result.cancelled);
	assert_eq!(fs::read_to_string(done).expect("cleanup completed"), "done");
	assert!(
		started.elapsed() >= Duration::from_millis(600),
		"the cleanup sleep was interrupted instead of receiving its grace"
	);
}
