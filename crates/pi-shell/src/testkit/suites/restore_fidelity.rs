//! Restore fidelity: state that lives in a vproc between ops
//! survives a snapshot taken there.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell, SigSet, Signal,
		SpawnSpec,
	},
	testkit::{
		FakeHost, Fault,
		fault::skeleton_init,
		run::{Stop, advance},
		run_script,
	},
};

fn same_under_snapshots(src: &[u8]) -> (Vec<u8>, Vec<u8>) {
	let base = run_script(FakeHost::new(), src, &[], Fault::None);
	let hit = run_script(FakeHost::new(), src, &[], Fault::Snapshot { every: 1 });
	assert!(hit.snapshots > 0, "no snapshot landed");
	assert_eq!(
		(&hit.stdout, &hit.stderr, hit.status),
		(&base.stdout, &base.stderr, base.status),
		"differs under snapshots"
	);
	(base.stdout, base.stderr)
}

/// `read` takes a pipe's bytes one at a time; the bytes it holds while the
/// writer runs on are part of the image, not lost.
#[test]
fn a_partial_read_survives_a_snapshot() {
	let (out, _) = same_under_snapshots(
		b"{ printf ab; :; :; :; :; printf 'c\\n'; } | { read x; echo \"got $x\"; }",
	);
	assert_eq!(out, b"got abc\n");
}

/// `select` prints its prompt when its read starts; a restored shell
/// continues that read instead of prompting again.
#[test]
fn a_waiting_select_does_not_prompt_twice() {
	let (out, err) = same_under_snapshots(
		b"{ :; :; :; :; echo 1; } | { select x in a b; do echo \"$x\"; break; done; }",
	);
	assert_eq!((out.as_slice(), err.as_slice()), (&b"a\n"[..], &b"1) a\n2) b\n#? "[..]));
}

/// `BASH_COMMAND` inside a trap action names the trapped command, also
/// when the action continues in a restored shell.
#[test]
fn bash_command_survives_a_snapshot_inside_a_trap() {
	let (out, _) = same_under_snapshots(b"trap ': x; echo \"[$BASH_COMMAND]\"' DEBUG; echo one");
	assert_eq!(out, b"[echo one]\none\n");
}

/// The signal sets the programs `src` starts are spawned with ignored
/// (each spawn fails: 127, nothing runs), and the snapshots taken.
fn spawn_masks(src: &[u8], fault: Fault) -> (Vec<SigSet>, u32) {
	let seen = Arc::new(Mutex::new(Vec::new()));
	let masks = Arc::clone(&seen);
	let host = FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
		masks.lock().push(spec.sigmask_ign);
		Err(std::io::ErrorKind::NotFound.into())
	}));
	let out = run_script(host, src, &[], fault);
	let masks = seen.lock().clone();
	(masks, out.snapshots)
}

/// A background subshell without job control ignores `INT` and `QUIT`
/// (bash 5.3's asynchronous ignore, a field of the vproc in the frames
/// image) also when restored after it started: a `kill -INT` of itself or
/// of its fork does nothing, and its programs, and its fork's, start with
/// both ignored. A trap it set keeps running and keeps `INT` at its default
/// for its programs; after `trap CMD INT; trap - INT` its fork acts on
/// `INT` itself, while the fork's programs ignore it. Goldens: bash 5.3.20
/// (`SigIgn` 6 for `INT` and `QUIT`, 4 for `QUIT` alone).
#[test]
fn an_asynchronous_commands_ignored_signals_survive_a_snapshot() {
	let rows: [(&[u8], &[u8]); 4] = [
		(b"( :; :; kill -INT $BASHPID; echo alive ) & wait; echo st=$?", b"alive\nst=0\n"),
		(b"( :; :; ( kill -INT $BASHPID; echo alive ); echo st=$? ) & wait", b"alive\nst=0\n"),
		(b"( trap 'echo got' INT; :; :; kill -INT $BASHPID; echo after ) & wait", b"got\nafter\n"),
		(
			b"( trap 'echo x' INT; trap - INT; :; :; ( kill -INT $BASHPID; echo alive ); echo st=$? ) & wait",
			b"st=130\n",
		),
	];
	for (src, want) in rows {
		let (out, err) = same_under_snapshots(src);
		assert_eq!(
			String::from_utf8_lossy(&out),
			String::from_utf8_lossy(want),
			"{} (stderr {:?})",
			String::from_utf8_lossy(src),
			String::from_utf8_lossy(&err)
		);
	}
	let both = SigSet::EMPTY.with(Signal::Int).with(Signal::Quit);
	let quit = SigSet::EMPTY.with(Signal::Quit);
	let spawns: [(&[u8], SigSet); 4] = [
		(b"( :; :; /x/p ) & wait", both),
		(b"( :; :; ( /x/p ) ) & wait", both),
		(b"( trap 'echo x' INT; :; :; /x/p ) & wait", quit),
		(b"( trap 'echo x' INT; trap - INT; :; :; ( /x/p ) ) & wait", both),
	];
	for (src, want) in spawns {
		let text = String::from_utf8_lossy(src);
		assert_eq!(spawn_masks(src, Fault::None), (vec![want], 0), "{text}");
		let (masks, snapshots) = spawn_masks(src, Fault::Snapshot { every: 1 });
		assert!(snapshots > 0, "no snapshot landed: {text}");
		assert_eq!(masks, vec![want], "{text} under snapshots");
	}
}

/// The foreground jobs a function substitution keeps (bash makes each fork
/// a job, and deletes none while the list is frozen) survive a snapshot as
/// foreground jobs: the root's through its store records (the job's
/// foreground fact), a subshell's through the frames image. `jobs` lists
/// none of them but one a signal killed, `%N` names each, `wait %N` returns
/// its status, and the next job takes the number after them (read through
/// a command substitution's copy of the list: a `jobs >/dev/null` that
/// takes in a background job's end loses its redirection across a snapshot,
/// at the base too). Goldens: bash 5.3.20.
#[test]
fn a_frozen_foreground_job_survives_a_snapshot() {
	let rows: [(&[u8], &[u8]); 3] = [
		(
			b"y=${ ( exit 3 ); ( exit 4 ); jobs; jobs %2; echo \"st=$?\"; wait %1; echo \"w=$?\"; wait %2; \
			  echo \"w2=$?\"; : & x=$(jobs %3); echo \"n=$?\"; wait; }; echo \"$y\"",
			b"st=0\nw=3\nw2=4\nn=0\n",
		),
		(
			b"( y=${ ( exit 3 ); jobs; wait %1; echo \"w=$?\"; ( exit 5 ); jobs %2; echo \"st=$?\"; }; echo \"$y\" )",
			b"w=3\nst=0\n",
		),
		(b"y=${ ( kill -TERM $BASHPID ); jobs; }; echo \"$y\"", b"[1]   Terminated                 ( kill -TERM $BASHPID )\n"),
	];
	for (src, want) in rows {
		let (out, err) = same_under_snapshots(src);
		assert_eq!(
			String::from_utf8_lossy(&out),
			String::from_utf8_lossy(want),
			"{} (stderr {:?})",
			String::from_utf8_lossy(src),
			String::from_utf8_lossy(&err)
		);
	}
}

/// The root's job table reaches the store only as it changes (the sync
/// compares the jobs from the first one that changed, [`JobList`]), so a
/// snapshot at every op sees each change: a job added, one that ended (an
/// early one, after later ones were added), one `wait` deleted, many kept
/// while the list is frozen and deleted after it, and one `disown` deleted
/// among others. Each row's output is the same with and without snapshots,
/// and is bash 5.3.20's (measured, `-c` and from a script file).
///
/// [`JobList`]: crate::bash::vm::proc::JobList
#[test]
fn each_job_change_reaches_a_snapshot() {
	let count = "n=0; for p in $(jobs -p); do n=$((n+1)); done; echo \"n=$n\"";
	let rows: [(String, &str); 6] = [
		(format!(": & wait; {count}; jobs; echo end"), "n=0\nend\n"),
		(
			format!(
				"( exit 3 ) & ( exit 4 ) & wait %1; echo \"a=$?\"; {count}; wait %2; echo \"b=$?\"; \
				 {count}"
			),
			"a=3\nn=1\nb=4\nn=0\n",
		),
		(
			"( exit 7 ) & p=$!; for i in 1 2 3 4; do ( exit $i ) & done; wait $p; echo \"a=$?\"; \
			 wait $!; echo \"b=$?\"; wait; echo end"
				.to_owned(),
			"a=7\nb=4\nend\n",
		),
		(
			"for i in 1 2 3 4 5; do ( exit $i ) & done; wait $!; echo \"c=$?\"; wait; echo \"w=$?\""
				.to_owned(),
			"c=5\nw=0\n",
		),
		(
			format!(
				"y=${{ for i in 1 2 3 4 5 6; do ( exit $i ); done; wait %4; echo \"d=$?\"; ( exit 9 ) \
				 & {count}; wait %7; echo \"e=$?\"; }}; echo \"$y\"; {count}"
			),
			"d=4\nn=1\ne=9\nn=0\n",
		),
		(
			"( exit 1 ) & ( exit 2 ) & ( exit 3 ) & disown %2; x=$(jobs %2); echo \"j=$?\"; wait %3; \
			 echo \"f=$?\"; wait %1; echo \"g=$?\""
				.to_owned(),
			"j=1\nf=3\ng=1\n",
		),
	];
	for (src, want) in rows {
		let (out, err) = same_under_snapshots(src.as_bytes());
		assert_eq!(
			String::from_utf8_lossy(&out),
			want,
			"{src} (stderr {:?})",
			String::from_utf8_lossy(&err)
		);
	}
}

/// A foreground job a function substitution keeps whose command still runs
/// goes with the frames: restored without them (`drop_frames`), the job is
/// done as a lost vproc is (137), so it is reported once at most and then
/// deleted, and a second `jobs` lists nothing.
#[test]
fn a_running_foreground_job_ends_when_the_frames_are_lost() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"y=${ ( while :; do :; done ); }"[..]));
	let small = Budget { max_ops: 200, max_ns: u64::MAX };
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, small), Stop::Yield);
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
	let next = shell.submit(Script::command(&b"jobs >/dev/null; jobs; echo end"[..]));
	let budget = Budget::default();
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, budget), Stop::Done(255));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, budget), Stop::Done(0));
	assert_eq!(String::from_utf8_lossy(&host.stdout.bytes()), "end\n");
}
