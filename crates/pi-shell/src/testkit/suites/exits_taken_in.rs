//! A builtin that reports or decides by a job's state takes in the exits
//! already available first, as bash's job states follow its children's
//! exits at once (its `SIGCHLD` handler's `waitchld`). Here `/x/held` is a
//! background program that `/x/release` ends: reading `$!` waits until the
//! job has started it, and once `/x/release` returned the held program has
//! exited, though the host has not told the shell and the shell's own slice
//! goes on to the next command. A running job is not waited for. And the
//! end of a pipeline's last stage climbs to its job before the shell runs
//! on, so a command substitution's copy of the job table sees the job done.
//! References: bash 5.3.20 and zsh 5.9 (`-c`) with real programs in their
//! place (`/bin/sh -c 'exit 7'` for the held one).

use std::{
	io,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	task::{Context, Poll, Waker},
};

use parking_lot::Mutex;

use crate::{
	bash::{ExitStatus, ExtProc, ModeId, Script, ShellInit, Signal, SpawnSpec},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// First OS pid the fake spawner hands out.
const FIRST: u32 = 7001;

/// The held program's end, shared by `/x/held` and `/x/release`.
#[derive(Default)]
struct Held {
	/// Its exit status once `/x/release` ran.
	status: Option<ExitStatus>,
	/// The waker of the held program's last poll.
	waker:  Option<Waker>,
}

/// The fake externals: `/x/held` runs until `/x/release` or `/x/quiet` runs
/// (it then exits 7) or a terminating signal ends it. `/x/release` wakes the
/// shell, as a host reports an exit; `/x/quiet` does not, as an exit the
/// host has not reported yet (a later signal wakes it). `/x/true`,
/// `/x/release` and `/x/quiet` exit 0 at once. Every signal delivered is
/// logged.
#[derive(Clone, Default)]
struct World {
	next:    Arc<AtomicU32>,
	held:    Arc<Mutex<Held>>,
	signals: Arc<Mutex<Vec<(u32, Signal)>>>,
}

impl World {
	fn new() -> Self {
		let w = Self::default();
		w.next.store(FIRST, Ordering::SeqCst);
		w
	}

	fn host(&self) -> FakeHost {
		let world = self.clone();
		FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
			let pid = world.next.fetch_add(1, Ordering::SeqCst);
			let held = match spec.argv[0].as_slice() {
				b"/x/held" => true,
				name @ (b"/x/release" | b"/x/quiet") => {
					let mut h = world.held.lock();
					h.status = Some(ExitStatus::Exited(7));
					if name == b"/x/release"
						&& let Some(waker) = h.waker.take()
					{
						waker.wake();
					}
					false
				},
				_ => false,
			};
			let fake = Fake {
				pid,
				held: held.then(|| Arc::clone(&world.held)),
				signals: Arc::clone(&world.signals),
			};
			Ok(Box::new(fake) as Box<dyn ExtProc>)
		}))
	}

	/// The signals pid `pid` got.
	fn got(&self, pid: u32) -> Vec<Signal> {
		self
			.signals
			.lock()
			.iter()
			.filter(|(p, _)| *p == pid)
			.map(|(_, sig)| *sig)
			.collect()
	}
}

/// A fake external process: the held one, or one that exits 0 at once.
struct Fake {
	pid:     u32,
	held:    Option<Arc<Mutex<Held>>>,
	signals: Arc<Mutex<Vec<(u32, Signal)>>>,
}

impl ExtProc for Fake {
	fn pid(&self) -> u32 {
		self.pid
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		let Some(held) = &self.held else {
			return Poll::Ready(ExitStatus::Exited(0));
		};
		let mut h = held.lock();
		if let Some(status) = h.status {
			Poll::Ready(status)
		} else {
			h.waker = Some(cx.waker().clone());
			Poll::Pending
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.signals.lock().push((self.pid, sig));
		if let Some(held) = &self.held {
			let mut h = held.lock();
			if matches!(sig, Signal::Term | Signal::Kill) && h.status.is_none() {
				h.status = Some(ExitStatus::Signaled(sig));
			}
			if let Some(waker) = h.waker.take() {
				waker.wake();
			}
		}
		Ok(())
	}

	fn stop(&mut self) -> io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Run `src` as `bash -c src` (`zsh`: `zsh -c src`) over `world`'s host:
/// stdout, stderr, status.
fn run(world: &World, src: &str, zsh: bool) -> (String, String, i32) {
	let init = if zsh {
		ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) }
	} else {
		skeleton_init(&[])
	};
	let mut rig = Rig::new(world.host(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	let (shell, host, store) = rig.parts();
	let out = (
		String::from_utf8_lossy(&host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&host.stderr.bytes()).into_owned(),
		status,
	);
	host.assert_no_leaks(shell, store);
	out
}

// Failure mode: `jobs` waits for a job that runs on (bash lists it
// `Running` at once).
#[test]
fn jobs_does_not_wait_for_a_running_job() {
	let world = World::new();
	let (out, err, _) =
		run(&world, "/x/held & p=$!; jobs; echo mid; /x/release; wait; echo end", false);
	assert_eq!(out, "[1]+  Running                    /x/held &\nmid\nend\n");
	assert_eq!(err, "");
}

// Failure mode: `jobs` reads the held job's entry before its vproc ran
// again, so it lists the job running (bash: `Exit 7`), and `jobs -r`
// lists it too (bash: nothing). With `/x/quiet` only the wake the take-in
// gives every parked vproc makes the held job poll its program again.
#[test]
fn jobs_takes_in_the_exits_first() {
	let world = World::new();
	let (out, err, _) = run(&world, "/x/held & p=$!; /x/release; jobs; echo end", false);
	assert_eq!(out, "[1]+  Exit 7                     /x/held\nend\n");
	assert_eq!(err, "");
	let world = World::new();
	let (out, err, _) = run(&world, "/x/held & p=$!; /x/release; jobs -r; echo end", false);
	assert_eq!(out, "end\n");
	assert_eq!(err, "");
	let world = World::new();
	let (out, err, _) =
		run(&world, "/x/held & p=$!; /x/quiet; jobs; echo end; kill %1 2>/dev/null; wait", false);
	assert_eq!(out, "[1]+  Exit 7                     /x/held\nend\n", "quiet");
	assert_eq!(err, "");
}

// Failure mode: `fg` prints the held job and waits for it (bash: `fg: job
// has terminated`, status 1); `bg` says it is already in the background
// (bash: `bg: job has terminated`, status 1).
#[test]
fn fg_and_bg_take_in_the_exits_first() {
	for (verb, want) in [("fg", "fg: job has terminated"), ("bg", "bg: job has terminated")] {
		let world = World::new();
		let (out, err, _) = run(
			&world,
			&format!("set -m; /x/held & p=$!; /x/release; {verb} %1; echo \"st=$?\""),
			false,
		);
		assert_eq!(out, "st=1\n", "{verb}");
		assert_eq!(err, format!("bash: line 1: {want}\n"), "{verb}");
	}
}

// Failure mode: `disown -r` drops the held job as running, so `jobs %1`
// finds no such job (bash: a job that ended is not running, so it stays).
// The job's line is not compared: bash's `disown -r` also clears the
// current job, which obash does not.
#[test]
fn disown_r_takes_in_the_exits_first() {
	let world = World::new();
	let (out, err, _) = run(
		&world,
		"/x/held & p=$!; /x/release; disown -r; jobs %1 >/dev/null; echo \"st=$?\"",
		false,
	);
	assert_eq!(out, "st=0\n");
	assert_eq!(err, "");
}

// Failure mode: `kill %1` signals the held job (bash 5.3 without job
// control signals none of a finished job's processes, and succeeds).
#[test]
fn kill_takes_in_the_exits_first() {
	let world = World::new();
	let (out, err, _) = run(&world, "/x/held & p=$!; /x/release; kill %1; echo \"st=$?\"", false);
	assert_eq!(out, "st=0\n");
	assert_eq!(err, "");
	assert!(world.got(FIRST).is_empty(), "the held job ended before `kill %1`");
}

// Failure mode: zsh's `jobs` lists the held job running (zsh 5.9 without
// job control forgets a finished job: nothing), and zsh's `kill %1`
// signals it (zsh 5.9 finds no such job, status 1; obash words it as the
// failed signal).
#[test]
fn zsh_jobs_and_kill_take_in_the_exits_first() {
	let world = World::new();
	let (out, err, _) = run(&world, "/x/held & p=$!; /x/release; jobs; echo end", true);
	assert_eq!(out, "end\n");
	assert_eq!(err, "");
	let world = World::new();
	let (out, err, _) = run(&world, "/x/held & p=$!; /x/release; kill %1; echo \"st=$?\"", true);
	assert_eq!(out, "st=1\n");
	assert_eq!(err, "zsh:kill:1: kill %1 failed: no such process\n");
	assert!(world.got(FIRST).is_empty(), "the held job ended before `kill %1`");
}

// Failure mode: once `kill -0 $!` finds a pipeline's last program gone, the
// shell runs on before the job's vproc took the end in, so `$(jobs)` copies
// the job as running (bash 5.3: done).
#[test]
fn a_command_substitution_copies_a_pipeline_job_done_once_its_stages_ended() {
	let world = World::new();
	let (out, err, _) = run(
		&world,
		"/x/true | /x/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); echo \
		 \"[$x]\"",
		false,
	);
	assert_eq!(out, "[[1]+  Done                       /x/true | /x/true]\n");
	assert_eq!(err, "");
}
