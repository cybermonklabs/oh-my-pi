//! A builtin that reports or decides by a job's state takes in the exits
//! already available first, as bash's job states follow its children's
//! exits at once (its `SIGCHLD` handler's `waitchld`). Here `/x/held` is a
//! background program that `/x/release` ends: reading `$!` waits until the
//! job has started it, and once `/x/release` returned the held program has
//! exited, though the host has not told the shell and the shell's own slice
//! goes on to the next command. A running job is not waited for, and the
//! take-in runs nothing out of turn. A job `disown` dropped is no child of
//! the shell, and a job that left the table keeps its status for `wait
//! PID` as bash's bgp list does. References: bash 5.3.20 and zsh 5.9
//! (`-c`) with real programs in their place (`/bin/sh -c 'exit 7'` for the
//! held one).

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
	bash::{Budget, ExitStatus, ExtProc, ModeId, Script, ShellInit, Signal, SpawnSpec},
	testkit::{
		FakeHost, Fault, Rig,
		fault::skeleton_init,
		run::{Stop, advance_or_blocked},
	},
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

/// The shell `zsh` names: `zsh -c` (`zsh`) or `bash -c`.
fn init(zsh: bool) -> ShellInit {
	if zsh {
		ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) }
	} else {
		skeleton_init(&[])
	}
}

/// Run `src` as `bash -c src` (`zsh`: `zsh -c src`) over `world`'s host:
/// stdout, stderr, status.
fn run(world: &World, src: &str, zsh: bool) -> (String, String, i32) {
	run_with(world, src, zsh, Fault::None)
}

/// [`run`] under `fault`.
fn run_with(world: &World, src: &str, zsh: bool, fault: Fault) -> (String, String, i32) {
	let mut rig = Rig::new(world.host(), init(zsh));
	let status = rig.run(Script::command(src.as_bytes().to_vec()), fault);
	let (shell, host, store) = rig.parts();
	let out = (
		String::from_utf8_lossy(&host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&host.stderr.bytes()).into_owned(),
		status,
	);
	host.assert_no_leaks(shell, store);
	out
}

/// [`run`], but a shell that blocks with nothing left to wake it (every
/// vproc waits, no timer is due: here a `wait` for the held program, which
/// only a later `/x/release` of the script ends) is `Err`, with its stdout
/// so far. A hang is read from the shell's own state, not from a clock.
fn run_or_hang(world: &World, src: &str, zsh: bool) -> Result<(String, String, i32), String> {
	let mut rig = Rig::new(world.host(), init(zsh));
	let id = rig.shell().submit(Script::command(src.as_bytes().to_vec()));
	let budget = Budget { max_ops: 20_000, max_ns: u64::MAX };
	let status = loop {
		let (shell, host, store) = rig.parts();
		match advance_or_blocked(shell, host, store, id, budget) {
			Stop::Done(status) => break status,
			Stop::Yield => {},
			Stop::Paused => shell.control().resume(),
			Stop::Blocked => {
				if !host.fire_next_timer() {
					return Err(String::from_utf8_lossy(&host.stdout.bytes()).into_owned());
				}
			},
		}
	};
	let (shell, host, store) = rig.parts();
	let out = (
		String::from_utf8_lossy(&host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&host.stderr.bytes()).into_owned(),
		status,
	);
	host.assert_no_leaks(shell, store);
	Ok(out)
}

/// Two background loops that each start 300 subshells, then `rest`.
const LOOPS: &str = "( i=0; while [ $i -lt 300 ]; do (:); i=$((i+1)); done; echo A-done ) & ( \
                     i=0; while [ $i -lt 300 ]; do (:); i=$((i+1)); done; echo B-done ) & ";

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

// Failure mode: the take-in answered at the asker's next turn, and a reap
// during the round sends the round back to the shell first: with two
// released jobs, the first one's end let `jobs` run before the second had
// taken its program's exit in (`Running`); with a pipeline, its last
// stage's end let `jobs` run before the job's own vproc took that end in
// (`Running`). bash 5.3.20 lists each `Exit 7`. A take-in owes each vproc
// it saw a turn, and the parent of one that ended one more.
#[test]
fn jobs_waits_for_a_turn_of_each_vproc_it_saw() {
	for (jobs, want) in [
		(
			"/x/held & /x/held & p=$!",
			"[1]-  Exit 7                     /x/held\n[2]+  Exit 7                     /x/held\n",
		),
		("/x/true | /x/held & p=$!", "[1]+  Exit 7                     /x/true | /x/held\n"),
	] {
		let world = World::new();
		let (out, err, _) = run(&world, &format!("{jobs}; /x/release; jobs; echo end"), false);
		assert_eq!(out, format!("{want}end\n"), "{jobs}");
		assert_eq!(err, "", "{jobs}");
	}
}

// Failure mode: the end of a child gave its parent the next turn and moved
// the round to it, so two background loops that start subshells kept the
// round between them, and the shell's own foreground loop ran on only once
// both had ended (bash and zsh: the foreground loop ends first, as it did
// before the take-in). With loops that never end it never ran again.
#[test]
fn a_child_s_end_gives_no_turn_out_of_turn() {
	for zsh in [false, true] {
		let world = World::new();
		let script = format!(
			"{LOOPS}i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done; echo fg-done; wait; echo end"
		);
		let (out, err, _) = run(&world, &script, zsh);
		assert!(out.starts_with("fg-done\n"), "zsh={zsh}: {out}");
		assert!(
			out.ends_with("end\n") && out.contains("A-done\n") && out.contains("B-done\n"),
			"{out}"
		);
		assert_eq!(err, "", "zsh={zsh}");
	}
}

// Failure mode: a take-in that waited for the jobs it saw to park or end
// answered `jobs` beside two busy jobs only once both had ended, listing
// them done (bash lists them `Running` at once). Its take-in waits for one
// turn of each, not for their end. The loops start no command, so they
// never park; while the shell waits for the subshell `(:)`, each has a
// turn, so the take-in of `jobs` sees them. A job's text is its command as
// the shell prints it back, over three lines.
#[test]
fn jobs_answers_while_busy_jobs_run_on() {
	let world = World::new();
	let busy =
		|name: &str| format!("( i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; echo {name} ) & ");
	let script =
		format!("{}{}(:); jobs; echo after-jobs; wait; echo end", busy("A-done"), busy("B-done"));
	let (out, err, _) = run(&world, &script, false);
	let job = |n: &str, mark: char, name: &str| {
		format!(
			"[{n}]{mark}  Running                    ( i=0; while [ $i -lt 20000 ]; do\n    \
			 i=$((i+1));\ndone; echo {name} ) &\n"
		)
	};
	let listed = format!("{}{}after-jobs\n", job("1", '-', "A-done"), job("2", '+', "B-done"));
	let Some(rest) = out.strip_prefix(&listed) else {
		panic!("both jobs listed running before `after-jobs`: {out}");
	};
	let mut ends: Vec<&str> = rest.lines().collect();
	ends.sort_unstable();
	assert_eq!(ends, ["A-done", "B-done", "end"], "{out}");
	assert!(rest.ends_with("end\n"), "{out}");
	assert_eq!(err, "");
}

// Failure mode: `disown` parked for its take-in, so the job had started
// before it was dropped, and `wait` then waited for the job `$!` names:
// one that never ends hung it (bash 5.2 and 5.3: `wait` returns at once,
// 0). With any operand, and with a pipeline.
#[test]
fn wait_does_not_wait_for_a_disowned_job() {
	for form in [
		"/x/held & disown",
		"/x/held & disown %1",
		"/x/held & disown -a",
		"/x/held & disown -r",
		"set -m; /x/held & disown %1",
		"/x/true | /x/held & disown -a",
	] {
		let world = World::new();
		let script = format!(
			"{form}; p=$!; wait; echo \"st=$?\"; /x/release; while kill -0 $p 2>/dev/null; do :; done"
		);
		assert_eq!(
			run_or_hang(&world, &script, false),
			Ok(("st=0\n".into(), String::new(), 0)),
			"{form}"
		);
	}
}

// Failure mode: `wait $!` of a disowned job waited for it (bash 5.3: at
// once; `disown` and `disown %1` keep its status then, 0 while it runs,
// `-a` and `-r` none: not a child, also once it ended).
#[test]
fn wait_for_a_disowned_job_answers_at_once() {
	let not_a_child = "bash: line 1: wait: pid 7001 is not a child of this shell\n";
	for (form, out, err) in [
		("disown", "st=0\n", ""),
		("disown %1", "st=0\n", ""),
		("disown -a", "st=127\n", not_a_child),
		("disown -r", "st=127\n", not_a_child),
	] {
		let world = World::new();
		let script = format!(
			"/x/held & p=$!; {form}; wait $p; echo \"st=$?\"; /x/release; while kill -0 $p \
			 2>/dev/null; do :; done"
		);
		assert_eq!(run_or_hang(&world, &script, false), Ok((out.into(), err.into(), 0)), "{form}");
	}
	let world = World::new();
	let script = "/x/held & p=$!; disown -a; /x/release; while kill -0 $p 2>/dev/null; do :; done; \
	              wait $p; echo \"st=$?\"";
	assert_eq!(
		run_or_hang(&world, script, false),
		Ok(("st=127\n".into(), not_a_child.into(), 0)),
		"ended"
	);
}

// Failure mode: `wait -n PID` of a disowned job waited for it (bash 5.3:
// the status `disown` kept, 0, at once; after `disown -a` no status is
// kept: not a pid or valid job spec, 127), and of a job `jobs` forgot it
// returns the kept status each time.
#[test]
fn wait_n_answers_from_the_kept_statuses() {
	for (script, out, err) in [
		("/x/held & p=$!; disown; wait -n $p; echo \"st=$?\"", "st=0\n", ""),
		(
			"/x/held & p=$!; disown -a; wait -n $p; echo \"st=$?\"",
			"st=127\n",
			"bash: line 1: wait: `7001': not a pid or valid job spec\n",
		),
	] {
		let world = World::new();
		let script = format!("{script}; /x/release; while kill -0 $p 2>/dev/null; do :; done");
		assert_eq!(run_or_hang(&world, &script, false), Ok((out.into(), err.into(), 0)), "{script}");
	}
	let world = World::new();
	let (out, err, _) = run(
		&world,
		"/x/held & p=$!; /x/true & /x/release; jobs >/dev/null; wait -n $p; echo \"st=$?\"; wait -n \
		 $p; echo \"st=$?\"",
		false,
	);
	assert_eq!((out.as_str(), err.as_str()), ("st=7\nst=7\n", ""));
}

// Failure mode: once `jobs` reported a finished job and forgot it, `wait
// PID` of it said `not a child` (127): bash keeps the status of each job
// it deletes (its bgp list) and returns it, again and again; a posix
// shell forgets it once returned, a plain `wait` forgets them all, and so
// does `disown -a` (not `-r`).
#[test]
fn wait_finds_the_status_of_a_job_jobs_forgot() {
	let not_a_child = "bash: line 1: wait: pid $P is not a child of this shell\n";
	for (rest, out, err) in [
		("wait $p; echo \"st=$?\"; wait $p; echo \"st=$?\"", "st=7\nst=7\n", ""),
		(
			"set -o posix; wait $p; echo \"st=$?\"; wait $p; echo \"st=$?\"",
			"st=7\nst=127\n",
			not_a_child,
		),
		("wait; wait $p; echo \"st=$?\"", "st=127\n", not_a_child),
		("/x/true & disown -a; wait $p; echo \"st=$?\"", "st=127\n", not_a_child),
		("/x/true & disown -r; wait $p; echo \"st=$?\"", "st=7\n", ""),
	] {
		for job in ["/x/held", "/x/true | /x/held"] {
			let world = World::new();
			let script = format!("{job} & p=$!; /x/true & /x/release; jobs >/dev/null; {rest}");
			let (got, got_err, _) = run(&world, &script, false);
			// `$!` names the held program: the first spawned, or the second.
			let pid = if job.contains('|') { FIRST + 1 } else { FIRST };
			let err = err.replace("$P", &pid.to_string());
			assert_eq!((got.as_str(), got_err.as_str()), (out, err.as_str()), "{job}; {rest}");
		}
	}
}

// Failure mode: a command substitution's copy of the job table found no
// status kept for a job `jobs` forgot (`not a child`); bash 5.2.21 and
// 5.3.20 copy the list into a command substitution, not into a `( )`
// subshell, whose `wait` says `not a child`.
#[test]
fn a_command_substitution_finds_a_kept_status() {
	let world = World::new();
	let (out, err, _) = run(
		&world,
		"/x/held & p=$!; /x/true & /x/release; jobs >/dev/null; x=$(wait $p; echo \"st=$?\"); echo \
		 \"$x\"; ( wait $p 2>/dev/null; echo \"sub=$?\" )",
		false,
	);
	assert_eq!((out.as_str(), err.as_str()), ("st=7\nsub=127\n", ""));
}

// Failure mode: `kill %1` left the job's notified mark, so a second `jobs
// -n` listed nothing (bash `kill_pid`: the job's state is news again).
#[test]
fn kill_of_a_job_makes_its_state_news_again() {
	let world = World::new();
	let (out, err, _) = run(
		&world,
		"/x/held & jobs -n; kill -0 %1; jobs -n; echo two; kill -0 $!; jobs -n; echo end; \
		 /x/release; wait",
		false,
	);
	let line = "[1]+  Running                    /x/held &\n";
	assert_eq!(out, format!("{line}{line}two\nend\n"));
	assert_eq!(err, "");
}

// Failure mode: once the last program of a pipeline ended and the host
// reported it (`/x/release`), `kill -0 $!` judged the stage's vproc before
// it ran again and found the program (bash 5.3: gone, once its `SIGCHLD`
// handler reaped it). `kill` takes in the exits already available first,
// as it does for `%n`. Control: while the last program runs, it is found.
#[test]
fn kill_of_a_job_pid_takes_in_the_exits_first() {
	for zsh in [false, true] {
		let world = World::new();
		let (out, err, _) = run(
			&world,
			"/x/true | /x/held & p=$!; /x/release; kill -0 $p 2>/dev/null; echo \"alive=$?\"; wait",
			zsh,
		);
		assert_eq!(out, "alive=1\n", "zsh={zsh}");
		assert_eq!(err, "", "zsh={zsh}");
		let world = World::new();
		let (out, err, _) = run(
			&world,
			"/x/true | /x/held & p=$!; kill -0 $p; echo \"alive=$?\"; /x/release; wait",
			zsh,
		);
		assert_eq!(out, "alive=0\n", "control zsh={zsh}");
		assert_eq!(err, "", "control zsh={zsh}");
	}
}

// Failure mode: a builtin parked for its take-in was still in its command,
// with the command's redirections, and the `CHLD` trap the take-in's reap
// owed started there: the trap's stderr went to the builtin's
// `2>/dev/null`, and `jobs` listed the job after the trap's output. bash
// runs a trap between commands (5.3.20 with `/bin/sh -c 'exit 7'` for the
// held program: `chld` on stderr). The trap runs once the builtin's
// command is over, before the next command. In bash mode the foreground
// `/x/quiet` runs the trap once first; zsh runs it for background jobs
// only.
#[test]
fn a_trap_waits_until_the_builtin_that_took_the_exit_in_is_done() {
	let kill = "/x/held & p=$!; /x/quiet; kill -0 $p 2>/dev/null; echo \"k=$?\"";
	for (zsh, err) in [(false, "chld\nchld\n"), (true, "chld\n")] {
		let world = World::new();
		let script = format!("trap 'echo chld >&2' CHLD; {kill}");
		let (out, got, _) = run(&world, &script, zsh);
		assert_eq!((out.as_str(), got.as_str()), ("k=1\n", err), "zsh={zsh}");
	}
	let world = World::new();
	let (out, err, _) =
		run(&world, "trap 'echo chld' CHLD; /x/held & p=$!; /x/quiet; jobs; echo end", false);
	assert_eq!(out, "chld\n[1]+  Exit 7                     /x/held\nchld\nend\n");
	assert_eq!(err, "");
}

// Failure mode: a builtin run again before its answer, once every job of
// its own had ended, went on and left its ask behind: no trap started in
// the shell until that ask was answered and a later take-in used the
// answer up, so `end` came before the trap of the job `jobs` took in, and
// that later builtin skipped its own take-in. The subshell `(:)` gives the
// held job and a disowned loop their first turn, so the take-in of `jobs`
// owes each a turn; the held job's end sends the round back to the shell
// before the loop's turn, and `jobs`, run again, finds its only job done.
// It withdraws its ask (`Kernel::withdraw_exits`), and the trap runs
// before `echo end`. Without the withdrawal `end` comes first; before the
// trap waited for the builtin, the trap ran inside `jobs >/dev/null`. The
// `chld` lines: the subshell, `/x/quiet`, the held job, then the loop,
// which runs on for many turns and ends by itself.
#[test]
fn a_builtin_that_goes_on_unanswered_withdraws_its_ask() {
	let (out, err, _) = run_bounded(
		"trap 'echo chld' CHLD; /x/held & ( i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done ) & \
		 b=$!; disown %2; (:); /x/quiet; jobs >/dev/null; echo end; while kill -0 $b 2>/dev/null; \
		 do :; done",
		false,
		Fault::None,
		"no fault",
	);
	assert_eq!(out, "chld\nchld\nchld\nend\nchld\n");
	assert_eq!(err, "");
}

/// [`run_with`] on a world of its own, in a thread of its own: a run that
/// has not finished after 30 s fails the test (`what` names the fault). The
/// thread of a run that never ends spins on until the test process exits.
fn run_bounded(src: &'static str, zsh: bool, fault: Fault, what: &str) -> (String, String, i32) {
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let _ = tx.send(run_with(&World::new(), src, zsh, fault));
	});
	rx.recv_timeout(std::time::Duration::from_secs(30))
		.unwrap_or_else(|_| panic!("`{src}` (zsh={zsh}) did not finish within 30 s with {what}"))
}

// Failure mode: a snapshot taken while a builtin waited for the answer to
// its ask (`Kernel::ask_exits`) lost the ask: the restored builtin stayed
// parked on its job for ever, so `kill` of a running in-engine job never
// sent, in the root and in a subshell. Each script runs with a snapshot
// every 1, 2, 3, 5 and 8 ops (`Fault::Snapshot`) and with a pause in the
// same places (`Fault::PauseResume`: the same steps, no image), and the two
// runs agree. The long jobs make the answer's turns matter: a restored
// shell must answer an ask as the shell without the snapshot does, after
// the same turns, and no other.
#[test]
fn an_ask_outlives_a_snapshot() {
	let rows: [(&'static str, bool); 14] = [
		(
			"trap 'echo chld >&2' CHLD; { exit 3; } & p=$!; :; kill -0 $p 2>/dev/null; echo \
			 alive=$?; wait",
			false,
		),
		("{ while :; do :; done; } & kill -KILL $!; wait $!; echo st=$?", false),
		("( { while :; do :; done; } & kill -KILL $!; wait $!; echo st=$? )", false),
		("{ while :; do :; done; } & jobs; kill %1; wait; echo end", false),
		("{ exit 3; } & { exit 4; } & :; jobs; wait; echo end", false),
		("{ { exit 5; } & wait $!; exit $?; } & :; :; jobs; wait $!; echo st=$?", false),
		("( { exit 3; } & :; jobs )", false),
		("{ exit 3; } & p=$!; :; kill -0 $p; echo alive=$?; wait", false),
		("{ while :; do :; done; } & kill -KILL $!; wait $!; echo st=$?", true),
		("{ exit 3; } & { exit 4; } & :; jobs; wait; echo end", true),
		(
			concat!(
				"{ :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; exit 3; }",
				" & :; :; :; jobs; wait; echo end"
			),
			false,
		),
		(
			concat!(
				"{ :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; exit 3; }",
				" & p=$!; :; :; kill -0 $p; echo alive=$?; wait"
			),
			false,
		),
		(
			concat!(
				"{ :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; exit 3; }",
				" & :; :; :; :; :; :; jobs; jobs; wait; echo end"
			),
			false,
		),
		(
			concat!(
				"{ :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; :; exit 3; }",
				" & :; :; :; jobs; wait; echo end"
			),
			true,
		),
	];
	for (src, zsh) in rows {
		for every in [1, 2, 3, 5, 8] {
			let paused = run_bounded(src, zsh, Fault::PauseResume { every }, "a pause every few ops");
			let snap = run_bounded(src, zsh, Fault::Snapshot { every }, "a snapshot every few ops");
			assert_eq!(snap, paused, "`{src}` (zsh={zsh}), every {every} ops");
		}
	}
}
