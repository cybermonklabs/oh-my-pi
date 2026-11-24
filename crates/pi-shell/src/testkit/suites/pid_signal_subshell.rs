//! A signal sent to the pid of a `( list ) &` job (`kill $!`). bash forks
//! once for it, and that one process is the subshell, so the signal ends
//! (or traps in) the list. The engine runs the job as a vproc that only
//! waits for the vproc of its `( … )`; the signal has to reach that
//! subshell, as `kill %1` reaches it. bash runs `( list ) >file &` and a
//! `( … )` that is a subshell's whole body (`( ( list ) ) &`) in that one
//! process too, but forks again for a `( … )` after another command
//! (`( :; ( list ) ) &`): there the signal ends the outer subshell only.

use std::time::{Duration, Instant};

use crate::{
	bash::{Budget, Cx, EventMask, Script, Step},
	testkit::{
		FakeHost, Rig,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

/// Bound on a run: each runs in milliseconds.
const RUN_BOUND: Duration = Duration::from_secs(60);

/// Runs `src` in a new rig; its output once the run is done and the shell
/// has nothing left to run (the subshell ended with the job). A run past
/// [`RUN_BOUND`], or work left after it, fails the test. Events are off:
/// the tests read none, and a subshell left running (the failure) would
/// fill the host's event list with its loop's commands for as long as the
/// test steps it.
fn killed(src: &str) -> String {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	let (shell, host, store) = rig.parts();
	shell.set_event_mask(EventMask::NONE);
	let id = shell.submit(Script::command(src.as_bytes()));
	let t0 = Instant::now();
	loop {
		match advance(shell, host, store, id, Budget::default()) {
			Stop::Done(_) => break,
			Stop::Yield => assert!(
				t0.elapsed() < RUN_BOUND,
				"the killed subshell still runs: `{src}` did not finish within {RUN_BOUND:?} (out so \
				 far: {:?})",
				String::from_utf8_lossy(&host.stdout.bytes())
			),
			other => panic!("`{src}` stopped: {other:?}"),
		}
	}
	let out = String::from_utf8_lossy(&host.stdout.bytes()).into_owned();
	for _ in 0..1_000 {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Idle => return out,
			Step::Yield | Step::Done { .. } => {},
			other => panic!("{other:?} after `{src}`"),
		}
	}
	panic!(
		"the killed subshell still runs: the shell has work 1000 steps after `{src}` (out: {out:?})"
	);
}

/// The subshell's loop, once it has said it runs (the file `/r`).
const LOOP: &str = ": > /r; while :; do :; done";

/// Until the subshell has started its loop.
const STARTED: &str = "until [ -e /r ]; do :; done";

// Failure mode: `kill $b` killed only the vproc that waits for the `( … )`,
// and the subshell's loop ran on for the life of the shell: `wait $b`
// answered at once with that vproc's status, and the host's leak check
// found the loop still running.
#[test]
fn a_signal_to_the_pid_of_a_subshell_job_ends_the_subshell() {
	for (sig, status) in [("", 143), ("-TERM", 143), ("-KILL", 137), ("-s HUP", 129)] {
		let src = format!("( {LOOP} ) & b=$!; {STARTED}; kill {sig} $b; wait $b; echo st=$?");
		assert_eq!(killed(&src), format!("st={status}\n"), "{src}");
	}
	// The case as reported: one turn of a subshell, and `kill -0` as the
	// end of the job.
	let src = "( while :; do :; done ) & b=$!; (:); kill $b; while kill -0 $b 2>/dev/null; do :; \
	           done; echo end";
	assert_eq!(killed(src), "end\n", "{src}");
}

// Failure mode: the subshell's own `TERM` trap never ran; the vproc that
// waits for it died in its place, with status 143.
#[test]
fn the_subshell_of_a_subshell_job_traps_a_signal_to_its_pid() {
	let src = format!(
		"( trap 'echo t; exit 3' TERM; {LOOP} ) & b=$!; {STARTED}; kill $b; wait $b; echo st=$?"
	);
	assert_eq!(killed(&src), "t\nst=3\n", "{src}");
}

// Failure mode: in `( ( list ) ) &`, which bash also runs as one process,
// the signal stopped at the outer subshell.
#[test]
fn a_signal_to_the_pid_of_a_nested_subshell_job_ends_the_inner_subshell() {
	let src = format!("( ( {LOOP} ) ) & b=$!; {STARTED}; kill $b; wait $b; echo st=$?");
	assert_eq!(killed(&src), "st=143\n", "{src}");
}

/// The inner subshell's loop, once it has written its `$BASHPID` (`/p`)
/// and said it runs (`/r`).
const INNER: &str = "echo $BASHPID > /p; : > /r; while :; do :; done";

// Failure mode: the signal also followed a `( … )` that is not the whole
// body of its subshell (`( :; ( list ) )`, `true && ( list )`), where bash
// forks a second process: the inner loop ended with the outer subshell,
// where bash leaves it running.
#[test]
fn a_signal_to_the_pid_of_a_subshell_job_spares_a_subshell_after_a_command() {
	for job in [format!("( :; ( {INNER} ) )"), format!("true && ( {INNER} )")] {
		let src = format!(
			"{job} & b=$!; {STARTED}; read -r i < /p; kill $b; wait $b; echo st=$?; kill -0 $i && \
			 echo running; kill $i"
		);
		assert_eq!(killed(&src), "st=143\nrunning\n", "{src}");
	}
}

// Failure mode: as above, and the outer subshell's `TERM` trap ran (`o`)
// once the inner loop had ended; bash keeps that trap waiting for the inner
// subshell, which runs on, and `kill -KILL` ends the outer one without it.
#[test]
fn a_signal_to_the_pid_of_a_subshell_job_waits_in_its_trap_for_an_inner_subshell() {
	let src = format!(
		"( trap 'echo o' TERM; ( {INNER} ) ) & b=$!; {STARTED}; read -r i < /p; kill $b; kill -0 $i \
		 && echo running; kill -KILL $b; wait $b; echo st=$?; kill $i"
	);
	assert_eq!(killed(&src), "running\nst=137\n", "{src}");
}

// Failure mode: a `( … )` with redirections (`( list ) >file &`, the usual
// way to start background work) was not reached: the job vproc waits for
// it between a `Redir` and a `PopRedir`, so the signal ended that vproc
// alone and the loop ran on; with `kill %1` the subshell's trap ran, but
// `wait` answered 143, the job vproc's own status.
#[test]
fn a_signal_to_the_pid_of_a_redirected_subshell_job_ends_the_subshell() {
	for job in [
		format!("( {LOOP} ) >/dev/null"),
		format!("( {LOOP} ) 2>&1"),
		format!("( ( {LOOP} ) >/dev/null )"),
	] {
		let src = format!("{job} & b=$!; {STARTED}; kill $b; wait $b; echo st=$?");
		assert_eq!(killed(&src), "st=143\n", "{src}");
	}
	for kill in ["kill $b", "kill %1"] {
		let src = format!(
			"( trap 'echo t; exit 3' TERM; {LOOP} ) 2>/dev/null & b=$!; {STARTED}; {kill}; wait $b; \
			 echo st=$?"
		);
		assert_eq!(killed(&src), "t\nst=3\n", "{src}");
	}
}

// Failure mode: `kill -STOP $!` stopped the job vproc only and the
// subshell's loop ran on (its counter `/c` moved while the shell ran more
// than a turn of ops); `kill -CONT $!` then had nothing to continue.
#[test]
fn stop_and_cont_to_the_pid_of_a_subshell_job_reach_the_subshell() {
	let src = "( : > /r; n=0; while :; do n=$((n+1)); echo $n > /c; done ) & b=$!; until [ -e /r ] \
	           && read -r a < /c; do :; done; kill -STOP $b; read -r a < /c; k=0; until [ $k = \
	           1000 ]; do k=$((k+1)); done; read -r c < /c; [ \"$a\" = \"$c\" ] && echo stopped; \
	           kill -CONT $b; until read -r d < /c && [ \"$d\" != \"$c\" ]; do :; done; echo \
	           running; kill $b; wait $b; echo st=$?";
	assert_eq!(killed(src), "stopped\nrunning\nst=143\n", "{src}");
}

// Controls, which ended the loop before: the job's spec, a brace group the
// job vproc runs itself, and a kill before the subshell exists.
#[test]
fn a_job_spec_a_group_and_an_early_kill_end_the_loop_as_before() {
	for src in [
		format!("( {LOOP} ) & b=$!; {STARTED}; kill %1; wait $b; echo st=$?"),
		format!("{{ {LOOP}; }} & b=$!; {STARTED}; kill $b; wait $b; echo st=$?"),
		format!("( {LOOP} ) & b=$!; kill $b; wait $b; echo st=$?"),
	] {
		assert_eq!(killed(&src), "st=143\n", "{src}");
	}
}
