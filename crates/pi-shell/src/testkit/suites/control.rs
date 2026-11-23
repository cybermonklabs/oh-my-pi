//! Control, restore and store-failure behaviour of the shell.

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		RunId, Script, Shell, SigTarget, Signal, StateStore, Step, ir::IR_VERSION, store::BlobSlot,
	},
	testkit::{
		FakeHost, Fault, Rig,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

fn rig() -> Rig {
	Rig::new(FakeHost::new(), skeleton_init(&[]))
}

#[test]
fn cancel_kill_ends_every_run_and_the_shell_stays_usable() {
	let mut r = rig();
	let busy = r
		.shell()
		.submit(Script::command(&b"while true; do :; done"[..]));
	let small = Budget { max_ops: 50, max_ns: u64::MAX };
	let (shell, host, store) = r.parts();
	assert_eq!(advance(shell, host, store, busy, small), Stop::Yield);
	shell.control().cancel(Signal::Kill);
	assert_eq!(advance(shell, host, store, busy, small), Stop::Done(137));
	assert_eq!(r.run(Script::command(&b"echo after"[..]), Fault::None), 0);
	assert_eq!(r.host.stdout.bytes(), b"after\n");
}

#[test]
fn virtual_term_signal_to_all_kills_like_bash() {
	let mut r = rig();
	let id = r
		.shell()
		.submit(Script::command(&b"while :; do :; done"[..]));
	let small = Budget { max_ops: 10, max_ns: u64::MAX };
	let (shell, host, store) = r.parts();
	assert_eq!(advance(shell, host, store, id, small), Stop::Yield);
	shell.control().signal(SigTarget::All, Signal::Term);
	assert_eq!(advance(shell, host, store, id, small), Stop::Done(143));
}

#[test]
fn pause_holds_until_resume() {
	let mut r = rig();
	let id = r.shell().submit(Script::command(&b"echo a; echo b"[..]));
	let (shell, host, store) = r.parts();
	shell.control().pause();
	for _ in 0..3 {
		let step = shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default());
		assert!(matches!(step, Step::Paused));
	}
	assert!(host.stdout.bytes().is_empty(), "nothing runs while paused");
	shell.control().resume();
	assert_eq!(advance(shell, host, store, id, Budget::default()), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"a\nb\n");
}

#[test]
fn root_state_persists_across_runs_and_snapshots() {
	let mut r = rig();
	r.run(Script::command(&b"x=1; y=keep"[..]), Fault::None);
	r.snapshot();
	r.run(Script::command(&b"x+=2; echo $x $y; false"[..]), Fault::None);
	r.snapshot();
	r.run(Script::command(&b"echo $?"[..]), Fault::None);
	assert_eq!(r.host.stdout.bytes(), b"12 keep\n1\n");
}

#[test]
fn subshell_runs_do_not_leak_into_the_root() {
	let mut r = rig();
	r.run(Script::command(&b"x=root"[..]), Fault::None);
	let sub = Script {
		vproc: crate::bash::VprocSel::NewSubshell,
		env: vec![("E".into(), "env".into())],
		args: Some(vec!["p1".into()]),
		..Script::command(&b"x=sub; echo $x $E $1"[..])
	};
	r.run(sub, Fault::Snapshot { every: 2 });
	r.run(Script::command(&b"echo $x $E $1"[..]), Fault::None);
	assert_eq!(r.host.stdout.bytes(), b"sub env p1\nroot\n");
}

#[test]
fn restore_rejects_corrupt_and_foreign_frames_and_can_drop_them() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"for i in 1 2 3; do echo $i; done"[..]));
	assert_eq!(
		advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 4, max_ns: u64::MAX }),
		Stop::Yield
	);
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	let mut blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();

	blob[0] ^= 0xff;
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(
		matches!(err, Some(RestoreError::Incompatible { why: Incompatibility::Magic })),
		"a foreign blob is refused: {err:?}"
	);

	blob[0] ^= 0xff;
	blob.truncate(blob.len() - 3);
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(matches!(err, Some(RestoreError::Corrupt(_))), "a truncated blob is corrupt: {err:?}");

	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..RestoreOpts::default()
		})
		.unwrap();
	assert_eq!(report.abandoned, [id], "the header still names the abandoned run");
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none(), "restore consumes the blob");
	let next = shell.submit(Script::command(&b"echo fresh"[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(255));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, Budget::default()), Stop::Done(0));
	assert!(host.stdout.bytes().ends_with(b"fresh\n"));
}

#[test]
fn restore_drop_frames_abandons_the_running_script_with_255() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"while :; do :; done"[..]));
	assert_eq!(
		advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 9, max_ns: u64::MAX }),
		Stop::Yield
	);
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..RestoreOpts::default()
		})
		.unwrap();
	assert_eq!(report.abandoned, [id]);
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::Done { run, status: 255 } if run == id
	));
}

/// A store (`MemStore::to_bytes`) whose frames blob the engine of `c55f78f6`
/// (IR version 17, frames layout 31: no `Job::signal`, no
/// `JobTable::comsub`) externalized while run 1, `x=kept; ( { while :; do
/// :; done; } & jobs; wait $! ); echo after`, had its `( … )` waiting for
/// its running background job.
const OLD_LAYOUT_STORE: &[u8] = include_bytes!("../fixtures/frames/c55f78f6_subshell_job.store");

/// The IR version of the engine that wrote the `c55f78f6` fixtures.
const OLD_IR: u32 = 17;

/// Frames of an older engine are refused (the IR and layout versions are in
/// the header, and the build id), never decoded as this one's; with
/// `drop_frames` the store they came with restores, its run abandoned and
/// the root's state kept. (A blob of this IR but an older layout is
/// refused as another build's: `frames.rs`'
/// `the_header_check_refuses_another_layout`.)
#[test]
fn restore_refuses_frames_of_an_older_layout_and_keeps_their_store() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(OLD_LAYOUT_STORE).expect("the old store decodes");
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_some(), "the old store holds frames");
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	let older = Incompatibility::IrVersion { found: OLD_IR, expected: IR_VERSION };
	assert!(
		matches!(err, Some(RestoreError::Incompatible { why }) if why == older),
		"an older engine's frames are refused: {err:?}"
	);

	let mut store = MemStore::from_bytes(OLD_LAYOUT_STORE).expect("the old store decodes");
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..RestoreOpts::default()
		})
		.unwrap();
	assert_eq!(report.abandoned, [RunId(1)]);
	let next = shell.submit(Script::command(&b"echo \"$x\"; jobs; echo end"[..]));
	let budget = Budget::default();
	assert_eq!(advance(&mut shell, &mut host, &mut store, RunId(1), budget), Stop::Done(255));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, budget), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"kept\nend\n");
}

/// A store the engine of `c55f78f6` (`store::Job` as it was before the
/// job's signal was kept) wrote while run 1, `x=kept; { while :; do :;
/// done; } & { while :; do :; done; } & kill -KILL $!; wait %1; echo
/// after`, waited for job 1: the root's job table holds job 1 running and
/// job 2, which `KILL` ended, done with 137.
const OLD_ROOT_JOBS_STORE: &[u8] = include_bytes!("../fixtures/frames/c55f78f6_root_jobs.store");

/// A store from before the job's signal was kept decodes: its root's jobs
/// are in the store's own records, which keep their layout (what came later
/// is a record of its own, [`crate::bash::store::Record::JobFacts`]). Its
/// frames are refused; with `drop_frames` it restores, the run abandoned,
/// the variable kept, job 1 lost (137) and job 2 listed as `KILL` ended it.
#[test]
fn an_older_store_whose_root_has_jobs_restores() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(OLD_ROOT_JOBS_STORE).expect("the old store decodes");
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	let older = Incompatibility::IrVersion { found: OLD_IR, expected: IR_VERSION };
	assert!(
		matches!(err, Some(RestoreError::Incompatible { why }) if why == older),
		"an older engine's frames are refused: {err:?}"
	);
	let mut store = MemStore::from_bytes(OLD_ROOT_JOBS_STORE).expect("the old store decodes");
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..RestoreOpts::default()
		})
		.unwrap();
	assert_eq!(report.abandoned, [RunId(1)]);
	let next = shell.submit(Script::command(&b"echo \"$x\"; jobs; echo end"[..]));
	let budget = Budget::default();
	assert_eq!(advance(&mut shell, &mut host, &mut store, RunId(1), budget), Stop::Done(255));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, budget), Stop::Done(0));
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	let text = "{ while :; do\n    :;\ndone; }";
	assert_eq!(
		String::from_utf8_lossy(&host.stdout.bytes()),
		format!("kept\n[1]-  {killed:<27}{text}\n[2]+  {killed:<27}{text}\nend\n")
	);
}

/// The signal that ended a root job outlives a store image
/// (`MemStore::to_bytes`, `from_bytes`) and a restore: the next run's first
/// line reports the job as the shell would have.
#[test]
fn a_root_jobs_signal_outlives_a_store_image() {
	let mut r = rig();
	r.run(Script::command(&b"{ while :; do :; done; } & kill -KILL $!"[..]), Fault::None);
	assert_eq!(r.host.stderr.bytes(), b"", "nothing reports in the first run");
	r.snapshot();
	assert_eq!(r.run(Script::command(&b"echo next"[..]), Fault::None), 0);
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	let err = String::from_utf8_lossy(&r.host.stderr.bytes()).into_owned();
	let tail = format!(" {killed:<27}{{ while :; do\n    :;\ndone; }}\n");
	let pid = err
		.strip_prefix("bash: line 1: ")
		.and_then(|e| e.strip_suffix(tail.as_str()));
	assert!(pid.is_some_and(|p| p.trim().parse::<u32>().is_ok()), "{err:?}");
	assert_eq!(r.host.stdout.bytes(), b"next\n");
}

/// The signal that ended a subshell's job outlives every snapshot of a run
/// (a subshell's job table is in the frames image, its jobs' signals beside
/// it): under `Fault::Snapshot { every: 1 }` the subshell's `wait` prints the
/// notice the uninterrupted run prints.
#[test]
fn a_subshells_killed_job_keeps_its_signal_across_snapshots() {
	let src = b"( { while :; do :; done; } & kill -KILL $!; wait $!; echo st=$? )";
	let run = |fault| {
		let mut r = rig();
		let status = r.run(Script::command(&src[..]), fault);
		(status, r.host.stdout.bytes(), r.host.stderr.bytes())
	};
	let plain = run(Fault::None);
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	assert!(
		plain.1 == b"st=137\n" && String::from_utf8_lossy(&plain.2).contains(&*killed),
		"the uninterrupted run: {plain:?}"
	);
	assert_eq!(run(Fault::Snapshot { every: 1 }), plain);
}

/// An external that a `KILL` has ended by the time it is waited for.
struct KilledAtOnce;

impl crate::bash::ExtProc for KilledAtOnce {
	fn pid(&self) -> u32 {
		77
	}

	fn poll_wait(
		&mut self,
		_: &mut std::task::Context<'_>,
	) -> std::task::Poll<crate::bash::ExitStatus> {
		std::task::Poll::Ready(crate::bash::ExitStatus::Signaled(Signal::Kill))
	}

	fn signal(&mut self, _: Signal) -> std::io::Result<()> {
		Ok(())
	}

	fn stop(&mut self) -> std::io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}

/// A subshell vproc that dies of the signal its external died of (bash ran
/// the external with `exec` in the subshell's process: the last command of a
/// `( … )`, a background job's) is reaped after its external ended: the
/// signal waits for the reap in [`crate::bash::vm::Kernel::deaths`], which the
/// frames image holds. Under `Fault::Snapshot { every: 1 }` each run prints
/// the notice and status of the run without a snapshot: an external killed
/// in a foreground subshell, in a background job, and in a subshell's job.
#[test]
fn a_killed_externals_death_outlives_every_snapshot() {
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	for (src, stdout) in [
		(&b"( : ; /x/k ); echo st=$?"[..], &b"st=137\n"[..]),
		(b"/x/k & wait $!; echo st=$?", b"st=137\n"),
		(b"( /x/k & wait $!; echo st=$? )", b"st=137\n"),
	] {
		let run = |fault| {
			let host = FakeHost::new().with_spawner(Box::new(|_: crate::bash::SpawnSpec<'_>| {
				Ok(Box::new(KilledAtOnce) as Box<dyn crate::bash::ExtProc>)
			}));
			let mut r = Rig::new(host, skeleton_init(&[]));
			let status = r.run(Script::command(src), fault);
			(status, r.host.stdout.bytes(), r.host.stderr.bytes())
		};
		let plain = run(Fault::None);
		let shown = String::from_utf8_lossy(src);
		assert!(
			plain.1 == stdout && String::from_utf8_lossy(&plain.2).contains(&*killed),
			"{shown}: the uninterrupted run: {plain:?}"
		);
		assert_eq!(run(Fault::Snapshot { every: 1 }), plain, "{shown}");
	}
}

/// The processes of a root pipeline job ([`crate::bash::store::Job::procs`])
/// outlive a store image (`MemStore::to_bytes`, `from_bytes`) and a
/// restore: the next run's first line reports the job as the run without
/// the image does, a line for each process `kill %1` ended. Those the job's
/// vproc started (`$!` waits for that) are named by their own vprocs; those
/// it had not started yet ended with it, and name it. The first run ends
/// once `jobs -r` lists no running job (`GONE`: builtins only, which report
/// nothing; `/tmp` is the test host's in-memory one): `kill -0 %1`
/// succeeds for a finished job still listed, in bash 5.3.20 and 5.2.21 too,
/// so a loop on it never ends there. The loop stops after 100,000 passes,
/// and says so on standard error.
#[test]
fn a_root_pipeline_jobs_processes_outlive_a_store_image() {
	const GONE: &str = "n=0; while jobs -r >/tmp/running; [ -s /tmp/running ]; do n=$((n+1)); [ $n \
	                    -le 100000 ] || { echo still running >&2; exit 97; }; done";
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	let text = "{ while :; do\n    :;\ndone; }";
	for (start, started) in [(": $!; ", true), ("", false)] {
		let run = |snapshot: bool| {
			let mut r = rig();
			let job = format!("{text} | {text} & {start}kill -KILL %1; {GONE}");
			r.run(Script::command(job.as_bytes()), Fault::None);
			assert_eq!(r.host.stderr.bytes(), b"", "nothing reports in the first run");
			if snapshot {
				r.snapshot();
			}
			let status = r.run(Script::command(&b"echo next"[..]), Fault::None);
			let out = |b: Vec<u8>| String::from_utf8_lossy(&b).into_owned();
			(status, out(r.host.stdout.bytes()), out(r.host.stderr.bytes()))
		};
		let plain = run(false);
		let lines: Vec<&str> = plain.2.lines().collect();
		let pid = |line: Option<&&str>, before: &str, after: &str| {
			line
				.and_then(|l| l.strip_prefix(before))
				.and_then(|l| l.strip_suffix(after))
				.and_then(|p| p.trim().parse::<u32>().ok())
		};
		let first = pid(lines.first(), "bash: line 1: ", &format!(" {killed:<27}{{ while :; do"));
		let second = pid(lines.get(3), "     ", &format!(" {:<25}| {{ while :; do", ""));
		assert!(
			plain.1 == "next\n"
				&& lines.len() == 6
				&& first.zip(second).is_some_and(|(a, b)| (a != b) == started),
			"{start}without an image: {plain:?}"
		);
		assert_eq!(run(true), plain, "{start}");
	}
}

/// How each process of a pipeline ended ([`crate::bash::store::JobProc`])
/// outlives every snapshot of a run: of a root job (its record in the
/// store, written as each process ends while the job runs), of one under
/// `lastpipe` (which is for a pipeline bash waits for, not a job's), of a
/// subshell's job (the frames image, beside the subshell's job table) and
/// of a pipeline the shell waits for (the frames image, the `Spawn`'s
/// scratch). Under `pipefail` the first process, killed before the last
/// one ends, is the one the notice is for: under `Fault::Snapshot { every:
/// 1 }` each run prints the notice and status of the run without a
/// snapshot.
#[test]
fn a_pipelines_processes_outlive_every_snapshot() {
	const BUSY: &str = "{ i=0; while [ $i -lt 50 ]; do i=$((i+1)); done; }";
	let killed = Signal::Kill.description(EngineConfig::default().platform);
	for src in [
		format!("set -o pipefail; {{ kill -KILL $BASHPID; }} | {BUSY} & wait %1; echo st=$?"),
		format!(
			"shopt -s lastpipe; set -o pipefail; {{ kill -KILL $BASHPID; }} | {BUSY} & wait %1; echo \
			 st=$?"
		),
		format!("( set -o pipefail; {{ kill -KILL $BASHPID; }} | {BUSY} & wait %1; echo st=$? )"),
		format!("set -o pipefail; {{ kill -KILL $BASHPID; }} | {BUSY}; echo st=$?"),
	] {
		let run = |fault| {
			let mut r = rig();
			let status = r.run(Script::command(src.as_bytes()), fault);
			let out = |b: Vec<u8>| String::from_utf8_lossy(&b).into_owned();
			(status, out(r.host.stdout.bytes()), out(r.host.stderr.bytes()))
		};
		let plain = run(Fault::None);
		let first = format!(" {killed:<27}{{ kill -KILL $BASHPID; }}\n     ");
		let second = format!(" {:<27}| {{ i=0;", "Done");
		assert!(
			plain.1 == "st=137\n"
				&& plain.2.starts_with("bash: line 1: ")
				&& plain.2.contains(&first)
				&& plain.2.contains(&second),
			"{src}: the uninterrupted run: {plain:?}"
		);
		assert_eq!(run(Fault::Snapshot { every: 1 }), plain, "{src}");
	}
}

/// Every stage of a background job's pipeline is one subshell level below
/// the shell that started the job (bash forks each as an asynchronous
/// command), a group or a `( … )` stage too, and a lastpipe job's last
/// stage, under `!` too (bash drops the `!` of an asynchronous pipeline,
/// `execute_cmd.c:1119-1120`); a pipeline inside a job's group counts the
/// group's level. Goldens: bash 5.3.20 and 5.2.21, the same; zsh 5.9's
/// `$ZSH_SUBSHELL` the same for the first three.
#[test]
fn each_stage_of_a_jobs_pipeline_is_one_subshell_level_down() {
	let mut wrong = Vec::new();
	// The reading stage, `{ read l; echo "$l"; }`, stands for `cat` (the fake
	// host has no programs).
	const CAT: &str = "{ read l; echo \"$l\"; }";
	for (src, want) in [
		(format!("{{ echo g=$BASH_SUBSHELL; }} | {CAT} & wait"), "g=1\n"),
		("true | ( echo p=$BASH_SUBSHELL ) & wait".into(), "p=1\n"),
		(format!("echo s=$BASH_SUBSHELL | {CAT} & wait"), "s=1\n"),
		("true | { echo l=$BASH_SUBSHELL; } & wait".into(), "l=1\n"),
		(format!("true | {{ echo f=$BASH_SUBSHELL; }} | {CAT} & wait"), "f=1\n"),
		("true | ( ( echo pp=$BASH_SUBSHELL ) ) & wait".into(), "pp=2\n"),
		("shopt -s lastpipe; echo a | { read x; echo lp=$BASH_SUBSHELL; } & wait".into(), "lp=1\n"),
		("{ true | { echo n=$BASH_SUBSHELL; }; } & wait".into(), "n=2\n"),
		("( true | { echo m=$BASH_SUBSHELL; } ) & wait".into(), "m=2\n"),
		(format!("{{ echo fg=$BASH_SUBSHELL; }} | {CAT}"), "fg=1\n"),
		("! true | { echo bl=$BASH_SUBSHELL; } & wait".into(), "bl=1\n"),
		("! true | ( echo bp=$BASH_SUBSHELL ) & wait".into(), "bp=1\n"),
		(format!("! {{ echo bg=$BASH_SUBSHELL; }} | {CAT} & wait"), "bg=1\n"),
	] {
		let mut r = rig();
		r.run(Script::command(src.as_bytes()), Fault::None);
		let out = String::from_utf8_lossy(&r.host.stdout.bytes()).into_owned();
		if out != want {
			wrong.push(format!("{src:?}: got {out:?}, want {want:?}"));
		}
	}
	assert!(wrong.is_empty(), "{} of the rows differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// The status a `wait` collected outlives the job's entry and a store image
/// (bash's bgp list): a later run's `wait PID` returns it, with and without
/// a snapshot between the runs.
#[test]
fn a_waited_status_outlives_a_store_image() {
	for snapshot in [false, true] {
		let mut r = rig();
		r.run(Script::command(&b"{ exit 3; } & p=$!; wait $p; echo a=$?"[..]), Fault::None);
		if snapshot {
			r.snapshot();
		}
		assert_eq!(r.run(Script::command(&b"wait $p; echo b=$?"[..]), Fault::None), 0);
		assert_eq!(r.host.stdout.bytes(), b"a=3\nb=3\n", "snapshot: {snapshot}");
		assert_eq!(r.host.stderr.bytes(), b"", "snapshot: {snapshot}");
	}
}
