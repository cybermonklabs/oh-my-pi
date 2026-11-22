//! Control, restore and store-failure behaviour of the shell.

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, ModeId, RestoreError,
		RestoreOpts, Script, Shell, ShellInit, SigTarget, Signal, StateStore, Step, store::BlobSlot,
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

/// A zsh shell running `-c` strings: zsh keeps its own input at fd 10, so
/// the fds it hands out start at 11.
fn zsh_init() -> ShellInit {
	ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) }
}

/// A zsh shell with a process substitution's reader parked on its pipe
/// (`exec {w}> >(…)`), snapshot to the store: the reader allocates `{a}`
/// once it reads a line, writing `child $a` to `/tmp/psn/out`.
fn zsh_with_a_parked_procsub(
	engine: &std::sync::Arc<Engine>,
	host: &mut FakeHost,
	store: &mut MemStore,
) {
	host.fs.add_dir("/tmp/psn");
	let mut shell =
		Shell::create(engine, &mut Cx { host: &mut *host, store: &mut *store }, zsh_init()).unwrap();
	let id = shell.submit(Script::command(
		&br#"kept=yes; exec {w}> >(read -r x; exec {a}</dev/null; print -r -- "child $a" > /tmp/psn/out)"#[..],
	));
	assert_eq!(advance(&mut shell, host, store, id, Budget::default()), Stop::Done(0));
	shell
		.externalize(&mut Cx { host: &mut *host, store: &mut *store })
		.unwrap();
}

/// A process substitution's commands start without zsh's own fds (zsh
/// `getproc`'s `closem`), and keep that across a snapshot: the restored
/// reader's `{a}` is 10 where the shell's own `{b}` is 11, as zsh 5.9 gives
/// under `-c`.
#[test]
fn a_process_substitution_keeps_zsh_s_own_fds_closed_across_a_restore() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	zsh_with_a_parked_procsub(&engine, &mut host, &mut store);
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	let id = shell.submit(Script::command(
		&br#"print go >&$w; exec {w}>&-; while [[ ! -s /tmp/psn/out ]]; do :; done; exec {b}</dev/null; print -r -- "$(</tmp/psn/out) parent $b""#[..],
	));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(0));
	assert_eq!(String::from_utf8_lossy(&host.stdout.bytes()), "child 10 parent 11\n");
}

/// Frames written under the previous frames version, holding a process
/// substitution's reader (whose closed fds the image now records), are
/// refused as another build's and never migrated. With `drop_frames` they
/// are discarded: the root store state stays.
#[test]
fn restore_refuses_previous_version_frames_holding_a_process_substitution() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	zsh_with_a_parked_procsub(&engine, &mut host, &mut store);
	let mut blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	// The postcard header: the magic, then the IR and frames versions, each
	// one varint byte below 128.
	assert_eq!(&blob[..4], b"OBF1");
	assert_eq!(u32::from(blob[4]), crate::bash::ir::IR_VERSION);
	let version = blob[5];
	assert!((1..0x80).contains(&version), "frames version byte {version}");
	blob[5] = version - 1;
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(
		matches!(err, Some(RestoreError::Incompatible { why: Incompatibility::Build })),
		"frames of version {} are refused: {err:?}",
		version - 1
	);
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_some(), "a refused restore keeps the blob");
	let (mut shell, _) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..RestoreOpts::default()
		})
		.unwrap();
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none(), "restore consumes the blob");
	let next = shell.submit(Script::command(&b"echo \"kept=$kept\""[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, Budget::default()), Stop::Done(0));
	assert!(
		host.stdout.bytes().ends_with(b"kept=yes\n"),
		"the root store state stays: {:?}",
		String::from_utf8_lossy(&host.stdout.bytes())
	);
}
