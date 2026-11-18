//! The cancel gate with real processes, end to end through the
//! engine's cancel path: a [`Shell`] over a [`FakeHost`] whose externals come
//! from a [`NativeSpawner`] runs `/bin/sh` jobs with grandchildren; the host
//! calls `cancel(TERM)`; the engine signals each external and drops it while
//! unwinding, and the spawner's abandon escalation (sys S3) does the rest.
//!
//! With the default [`SpawnConfig`] ([`Sessions::Detach`]) every external
//! leads its own session, so:
//! - TERM reaches the whole group (child and grandchildren): a group that does
//!   not ignore TERM is gone before KILL is due;
//! - a group that ignores TERM is killed once the grace
//!   ([`SpawnConfig::DEFAULT_GRACE`], 2 s) is over, including a grandchild that
//!   outlived its leader (the session sweep);
//! - afterwards nothing is left: the spawner's leftovers and a process-table
//!   scan of the session are empty, and the idle shell holds no external handle
//!   ([`FakeHost::assert_no_leaks`]).
//!
//! Under [`Sessions::Inherit`] (`obash`, a standalone shell) externals stay
//! in the host's process group, so the same cancel reaches only the
//! external's own pid: TERM, then KILL after the grace; its children are
//! outside the engine's reach, as they are outside bash's.
//!
//! The cases assert on what the escalation recorded
//! ([`NativeSpawner::escalations`]): when its KILL step ran against the drop,
//! by the spawner's own clock; which processes (pid and start) were still
//! alive then; whether KILL went to the scope; what the sweep after it
//! reached. Not on how long a process took to go, which a loaded host
//! stretches past any bound: on a host with 18,000 processes one scan of the
//! process table takes seconds, and the escalation makes two. So `until`
//! has no deadline either; it waits for an event the fixture cannot produce
//! by itself, and a case whose event never comes is failed by the test
//! runner (`.config/nextest.toml`: 4 minutes). The jobs' `sleep 600`
//! ([`crate::testkit::child::LIFETIME`]) outlives that bound, so it never
//! ends by itself while a case runs (a `sleep 30` did, on a host slow
//! enough that the case outlasted it); each case's cleanup kills what is
//! left.
//!
//! Run: `cargo test -p pi-shell --lib sys::suites::cancel_externals --
//! --nocapture --test-threads 1`. Each test prints what the escalation took.

#![cfg(unix)]

use std::{
	thread,
	time::{Duration, Instant},
};

use bstr::ByteSlice;

use crate::{
	bash::{Budget, Cx, Engine, EngineConfig, MemStore, RunId, Script, Shell, Signal, SpawnSpec},
	sys::{
		NativeSpawner, Sessions, SpawnConfig,
		proc::{self, ProcInfo, ProcState},
		spawn::Escalation,
	},
	testkit::{
		FakeHost,
		fault::skeleton_init,
		run::{Stop, advance, advance_or_blocked},
	},
};

/// After how long `until` says what it still waits for (once; it goes on
/// waiting).
const SLOW: Duration = Duration::from_secs(60);

/// Poll `cond` until it holds, however long that takes.
fn until(what: &str, mut cond: impl FnMut() -> bool) {
	let start = Instant::now();
	let mut told = false;
	while !cond() {
		if !told && start.elapsed() >= SLOW {
			eprintln!("still waiting for {what} after {SLOW:?}");
			told = true;
		}
		thread::sleep(Duration::from_millis(5));
	}
}

/// Live (non-zombie) members of session `sid`.
fn live_session(sid: i32) -> Vec<ProcInfo> {
	let mut m = proc::session_members(sid).unwrap();
	m.retain(|p| p.state != ProcState::Zombie);
	m
}

/// The identity (pid and start) of each of `procs`, whatever its state.
fn ids(procs: &[ProcInfo]) -> Vec<(i32, u64)> {
	let mut ids: Vec<_> = procs.iter().map(|p| (p.pid, p.start)).collect();
	ids.sort_unstable();
	ids
}

/// Kills what a case left behind, even when it fails: the spawner's
/// leftovers and the stray processes it registered.
struct Cleanup {
	spawner: NativeSpawner,
	strays:  Vec<ProcInfo>,
}

impl Drop for Cleanup {
	fn drop(&mut self) {
		let _ = self.spawner.kill_leftovers();
		for p in &self.strays {
			let _ = proc::signal_pinned(p, Signal::Kill);
		}
	}
}

/// A shell running `src`, stopped while it waits for its external.
struct Case {
	shell:   Shell,
	host:    FakeHost,
	store:   MemStore,
	run:     RunId,
	cleanup: Cleanup,
}

impl Case {
	/// Start `src` under `sessions` with the default grace; returns once the
	/// shell is blocked on the external and the spawner's scopes hold
	/// `procs` processes, `sleeps` of them already `sleep`.
	fn start(sessions: Sessions, src: &str, procs: usize, sleeps: usize) -> Self {
		let spawner = NativeSpawner::new(SpawnConfig { sessions, ..SpawnConfig::default() });
		let hook = spawner.clone();
		let mut host =
			FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| hook.spawn(spec)));
		let mut store = MemStore::new();
		let engine = Engine::new(EngineConfig::default());
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.unwrap();
		let run = shell.submit(Script::command(src.as_bytes().to_vec()));
		loop {
			match advance_or_blocked(&mut shell, &mut host, &mut store, run, Budget::default()) {
				Stop::Blocked => break,
				Stop::Yield => {},
				other => panic!("{other:?} before the external ran"),
			}
		}
		assert_eq!(host.live_externals(), 1, "the shell waits for one external");
		until("the job's processes", || {
			let left = spawner.leftovers().unwrap();
			left.len() == procs && left.iter().filter(|l| l.name == "sleep").count() == sleeps
		});
		Self { shell, host, store, run, cleanup: Cleanup { spawner, strays: Vec::new() } }
	}

	/// The external's pid (its session and group under `Detach`).
	fn leader(&self) -> i32 {
		let left = self.cleanup.spawner.leftovers().unwrap();
		left
			.iter()
			.find(|l| l.pid == l.group)
			.map(|l| l.pid as i32)
			.expect("the external leads its scope")
	}

	/// `cancel(TERM)` and step to the run's end: its status and the time
	/// from the cancel to `Done` (for the log). The shell is then checked
	/// for leaked vprocs and external handles.
	fn cancel(&mut self) -> (i32, Duration) {
		let t0 = Instant::now();
		self.shell.control().cancel(Signal::Term);
		let status = loop {
			let (shell, host, store) = (&mut self.shell, &mut self.host, &mut self.store);
			match advance(shell, host, store, self.run, Budget::default()) {
				Stop::Done(status) => break status,
				Stop::Yield => {},
				other => panic!("unexpected {other:?} after cancel"),
			}
		};
		let done = t0.elapsed();
		self.host.assert_no_leaks(&mut self.shell, &mut self.store);
		(status, done)
	}

	/// The record of the escalation of the shell's one external, once both
	/// its KILL step and the sweep after it ran.
	fn escalation(&self) -> Escalation {
		let mut done = None;
		until("the escalation's KILL step and sweep", || {
			let all = self.cleanup.spawner.escalations();
			assert!(all.len() <= 1, "one external, one escalation: {all:?}");
			done = all
				.into_iter()
				.find(|e| e.fired.as_ref().is_some_and(|f| f.swept.is_some()));
			done.is_some()
		});
		done.expect("the escalation ran")
	}

	fn stdout(&self) -> String {
		self.host.stdout.bytes().to_str_lossy().into_owned()
	}

	/// Nothing is left in the spawner's scopes or in session `sid`.
	fn assert_clean(&self, sid: i32) {
		until("no leftovers", || self.cleanup.spawner.leftovers().unwrap().is_empty());
		assert!(live_session(sid).is_empty(), "session {sid}: {:?}", live_session(sid));
	}
}

/// What escalation `e` of the external whose scope is `scope` recorded: the
/// KILL step was due exactly the default grace after the cancel's drop (the
/// schedule itself, whatever the host's speed) and ran no earlier; `alive`
/// are the processes still alive then (what TERM left); `killed` whether
/// KILL went to the scope; and the sweep after it reached `swept` when given
/// (and, always, nothing but processes alive at the KILL step). Whether the
/// external still ran at the drop is not asserted: one that TERM ended
/// before it is an exit the engine did not collect, swept the same way.
/// Returns how long after the drop the KILL step ran, for the log.
fn assert_escalation(
	e: &Escalation,
	scope: i32,
	alive: &[ProcInfo],
	killed: bool,
	swept: Option<&[ProcInfo]>,
) -> Duration {
	assert_eq!(e.scope, scope, "{e:?}");
	let fired = e.fired.as_ref().expect("the KILL step ran");
	let grace = SpawnConfig::DEFAULT_GRACE;
	let due = fired.due.duration_since(e.abandoned);
	assert_eq!(fired.due, e.abandoned + grace, "KILL was due {due:?} after the drop, not {grace:?}");
	assert!(fired.at >= fired.due, "the KILL step ran before it was due: {e:?}");
	let after = fired.at.duration_since(e.abandoned);
	let found = fired.alive.as_deref().expect("the scope was read");
	assert_eq!(ids(found), ids(alive), "alive when KILL was due: {found:?}");
	assert_eq!(fired.killed, killed, "KILL to the scope");
	let reached = fired
		.swept
		.as_ref()
		.expect("the sweep ran")
		.as_deref()
		.expect("the sweep read the process table");
	assert!(
		ids(reached).iter().all(|id| ids(found).contains(id)),
		"the sweep reached a process not alive at the KILL step: {reached:?}"
	);
	if let Some(swept) = swept {
		assert_eq!(ids(reached), ids(swept), "the sweep's KILL: {reached:?}");
	}
	after
}

/// The TERM-ignoring processes `group` of `case`'s external (session
/// `sid`) all still ran when KILL was due, a grace after the cancel; KILL
/// went to the session, and then nothing was left. How long after the drop
/// the KILL step ran.
fn assert_killed_after_the_grace(case: &Case, sid: i32, group: &[ProcInfo]) -> Duration {
	let e = case.escalation();
	assert!(e.running, "the external ran when the cancel dropped it: {e:?}");
	let after = assert_escalation(&e, sid, group, true, None);
	case.assert_clean(sid);
	after
}

#[test]
fn cancel_term_reaches_the_externals_whole_group_at_once() {
	// `sh` does not forward TERM to its children: they die only if the
	// signal goes to the group.
	let mut case =
		Case::start(Sessions::Detach, "/bin/sh -c '/bin/sleep 600 & /bin/sleep 600; wait'", 3, 2);
	let sid = case.leader();
	let (status, done) = case.cancel();
	assert_eq!(status, 143);
	// TERM left nothing for KILL: no process of the session was alive when
	// KILL was due, so KILL went nowhere.
	let after = assert_escalation(&case.escalation(), sid, &[], false, Some(&[]));
	eprintln!("detach, TERM honoured: cancel→Done {done:?}, KILL step {after:?} after the drop");
	case.assert_clean(sid);
}

#[test]
fn cancel_term_kills_a_group_ignoring_term_after_the_default_grace() {
	let mut case = Case::start(
		Sessions::Detach,
		"/bin/sh -c 'trap \"\" TERM; /bin/sleep 600 & /bin/sleep 600; wait'",
		3,
		2,
	);
	let sid = case.leader();
	let group = live_session(sid);
	assert_eq!(group.len(), 3, "{group:?}");
	let (status, done) = case.cancel();
	assert_eq!(status, 143);
	let after = assert_killed_after_the_grace(&case, sid, &group);
	eprintln!("detach, TERM ignored: cancel→Done {done:?}, KILL step {after:?} after the drop");
}

/// The shell's own TERM trap runs once; the external still gets TERM (it
/// ignores it) and KILL after the grace.
#[test]
fn cancel_term_with_a_shell_trap_runs_it_and_still_kills_the_external_group() {
	let mut case = Case::start(
		Sessions::Detach,
		"trap 'echo trapped' TERM\n/bin/sh -c 'trap \"\" TERM; /bin/sleep 600 & /bin/sleep 600; \
		 wait'",
		3,
		2,
	);
	let sid = case.leader();
	let group = live_session(sid);
	assert_eq!(group.len(), 3, "{group:?}");
	let (status, done) = case.cancel();
	assert_eq!(status, 143);
	assert_eq!(case.stdout(), "trapped\n", "the trap runs exactly once");
	let after = assert_killed_after_the_grace(&case, sid, &group);
	eprintln!("detach, shell trap: cancel→Done {done:?}, KILL step {after:?} after the drop");
}

/// The leader dies of TERM; its grandchild ignores TERM, outlives it, and
/// is swept from the session when the grace is over.
#[test]
fn cancel_term_sweeps_a_grandchild_that_outlives_its_leader() {
	let mut case = Case::start(
		Sessions::Detach,
		"/bin/sh -c '(trap \"\" TERM; exec /bin/sleep 600) & wait'",
		2,
		1,
	);
	let sid = case.leader();
	let grandchild: Vec<ProcInfo> = live_session(sid)
		.into_iter()
		.filter(|p| p.pid != sid)
		.collect();
	assert_eq!(grandchild.len(), 1, "{grandchild:?}");
	let (status, done) = case.cancel();
	assert_eq!(status, 143);
	// When KILL was due only the grandchild was alive: TERM had ended the
	// leader, so KILL did not go to the session (its leader had exited),
	// and the sweep's identity-pinned KILL reached the grandchild.
	let after = assert_escalation(&case.escalation(), sid, &grandchild, false, Some(&grandchild));
	assert!(proc::ended(sid), "the leader is gone");
	case.assert_clean(sid);
	eprintln!(
		"detach, orphaned grandchild: cancel→Done {done:?}, KILL step {after:?} after the drop"
	);
}

/// `obash`'s layout: the external shares the host's group, so cancel reaches
/// its pid only (TERM, then KILL after the grace) and its children survive
/// it.
#[test]
fn inherit_cancel_reaches_only_the_external_itself() {
	let mut case = Case::start(
		Sessions::Inherit,
		"/bin/sh -c 'trap \"\" TERM; /bin/sleep 600 & /bin/sleep 600; wait'",
		1,
		0,
	);
	let pid = case.leader();
	let external = proc::read(pid).unwrap().expect("the external runs");
	let mut children = Vec::new();
	until("both sleeps started", || {
		children = proc::list()
			.unwrap()
			.into_iter()
			.filter(|p| p.ppid == pid && p.name == "sleep")
			.collect();
		children.len() == 2
	});
	case.cleanup.strays.clone_from(&children);
	let (status, done) = case.cancel();
	assert_eq!(status, 143);
	// TERM is ignored: the external alone still ran when KILL was due, and
	// KILL went to its pid (a process scope sweeps nothing).
	let alive = std::slice::from_ref(&external);
	let e = case.escalation();
	assert!(e.running, "the external ran when the cancel dropped it: {e:?}");
	let after = assert_escalation(&e, pid, alive, true, Some(&[]));
	until("the external killed", || proc::ended(pid));
	until("no leftovers", || case.cleanup.spawner.leftovers().unwrap().is_empty());
	for child in &children {
		assert!(proc::running(child.pid), "the external's children are outside the cancel's reach");
	}
	for child in &children {
		assert!(proc::signal_pinned(child, Signal::Kill).unwrap());
	}
	until("the children gone", || children.iter().all(|c| proc::ended(c.pid)));
	eprintln!("inherit: cancel→Done {done:?}, KILL step {after:?} after the drop");
}
