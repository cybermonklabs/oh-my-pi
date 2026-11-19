//! Trap actions at the shell's virtual signal boundary.

use crate::testkit::{FakeHost, Fault, run_script};

#[test]
fn self_signal_runs_handler_and_preserves_status() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo caught' USR1; kill -USR1 $$; echo status=$?",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"caught\nstatus=0\n");
	assert_eq!(out.status, 0);
}

#[test]
fn signal_handler_return_unwinds_function() {
	let out = run_script(FakeHost::new(), b"f() { trap 'echo caught; return 123' USR1; kill -USR1 $$; echo unreachable; }; f; echo status=$?", &[], Fault::None);
	assert_eq!(out.stdout, b"caught\nstatus=123\n");
	assert_eq!(out.status, 0);
}

#[test]
fn ignore_reset_and_print() {
	let out = run_script(
		FakeHost::new(),
		b"trap '' USR1; kill -USR1 $$; trap -p USR1; trap - USR1; trap -p USR1; echo done",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"trap -- '' SIGUSR1\ndone\n");
	assert_eq!(out.status, 0);
}

#[test]
fn exit_handler_sees_and_preserves_status() {
	let out = run_script(FakeHost::new(), b"trap 'echo exit=$?' EXIT; false", &[], Fault::None);
	assert_eq!(out.stdout, b"exit=1\n");
	assert_eq!(out.status, 1);
}

#[test]
fn err_trap_excludes_conditional_commands() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo err=$?' ERR; false || echo handled; false; echo done",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"handled\nerr=1\ndone\n");
	assert_eq!(out.status, 0);
}

#[test]
fn debug_trap_runs_before_commands() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo debug' DEBUG; echo body; trap - DEBUG",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"debug\nbody\ndebug\n");
	assert_eq!(out.status, 0);
}

#[test]
fn return_trap_can_see_function_locals() {
	let out = run_script(
		FakeHost::new(),
		b"set -T; trap 'echo return=$x' RETURN; f() { local x=visible; return 7; }; f; echo status=$?",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"return=visible\nstatus=7\n");
	assert_eq!(out.status, 0);
}

#[test]
fn return_trap_requires_trace_inheritance() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo unexpected' RETURN; f() { return 7; }; f; echo status=$?",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"status=7\n");
}

#[test]
fn trap_signal_is_scoped_and_visible_in_command_substitution() {
	let out = run_script(
		FakeHost::new(),
		b"BASH_TRAPSIG=prior; trap 'echo signal=$(kill -l \"$BASH_TRAPSIG\"); BASH_TRAPSIG=changed; echo inner=$BASH_TRAPSIG' USR1; kill -USR1 $$; echo outer=$BASH_TRAPSIG",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"signal=USR1\ninner=changed\nouter=prior\n");
	assert_eq!(out.status, 0);
}

#[test]
fn bare_return_in_signal_handler_uses_interrupted_status() {
	let out = run_script(
		FakeHost::new(),
		b"f() { trap 'false; return' USR1; kill -USR1 $$; echo unreachable; }; f; echo status=$?",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"status=0\n");
	assert_eq!(out.status, 0);
}

#[test]
fn err_trace_is_inherited_only_when_enabled() {
	let plain =
		run_script(FakeHost::new(), b"trap 'echo ERR' ERR; f() { false; }; f", &[], Fault::None);
	assert_eq!(plain.stdout, b"ERR\n");
	let traced = run_script(
		FakeHost::new(),
		b"set -E; trap 'echo ERR' ERR; f() { false; }; f",
		&[],
		Fault::None,
	);
	assert_eq!(traced.stdout, b"ERR\nERR\n");
}

#[test]
fn debug_trace_is_inherited_only_when_enabled() {
	let plain = run_script(
		FakeHost::new(),
		b"f() { echo inside; }; trap 'echo DEBUG' DEBUG; f; trap - DEBUG",
		&[],
		Fault::None,
	);
	assert_eq!(plain.stdout, b"DEBUG\ninside\nDEBUG\n");
	let traced = run_script(
		FakeHost::new(),
		b"f() { echo inside; }; set -T; trap 'echo DEBUG' DEBUG; f; trap - DEBUG",
		&[],
		Fault::None,
	);
	assert!(
		traced
			.stdout
			.windows(b"DEBUG\ninside\n".len())
			.any(|w| w == b"DEBUG\ninside\n")
	);
	assert!(
		traced
			.stdout
			.windows(b"DEBUG\n".len())
			.filter(|w| *w == b"DEBUG\n")
			.count()
			>= 3
	);
}

#[test]
fn err_trap_runs_once_for_failing_pipeline() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo ERR' ERR; false | false; echo done",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"ERR\ndone\n");
	assert_eq!(out.status, 0);
}

#[test]
fn trap_survives_snapshot() {
	let src = b"trap 'echo caught' USR1; kill -USR1 $$; echo done";
	let out = run_script(FakeHost::new(), src, &[], Fault::Snapshot { every: 2 });
	assert_eq!(out.stdout, b"caught\ndone\n");
	assert_eq!(out.status, 0);
}

// The kernel's "no DEBUG/ERR/RETURN trap set" shortcut must see a
// trap set late, inside a function, after many trap-free commands, and a
// reset one must stop running. Golden: bash 5.3.20.
#[test]
fn debug_trap_set_in_function_after_trap_free_loop() {
	let out = run_script(
		FakeHost::new(),
		b"f() { trap 'echo D' DEBUG; }; i=0; while [ $i -lt 3 ]; do i=$((i+1)); done; f; echo after; trap - DEBUG; echo gone",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"D\nafter\nD\ngone\n");
	assert_eq!(out.status, 0);
}

// A trap a subshell sets (its overlay, not the root) runs there and
// does not leak into the parent; also across snapshots, where the
// restored overlay holds it. Golden: bash 5.3.20.
#[test]
fn debug_trap_set_in_subshell_runs_there_only() {
	let src = b"( trap 'echo D' DEBUG; echo in ); echo out";
	for fault in [Fault::None, Fault::Snapshot { every: 1 }, Fault::Snapshot { every: 3 }] {
		let out = run_script(FakeHost::new(), src, &[], fault);
		assert_eq!(out.stdout, b"D\nin\nout\n");
		assert_eq!(out.status, 0);
	}
	let out = run_script(
		FakeHost::new(),
		b"x() { ( trap 'echo E' ERR; false; echo in ); false; echo out; }; x",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"E\nin\nout\n");
}

// RETURN traps set after earlier trap-free returns, set inside the
// returning function, and reset. Golden: bash 5.3.20.
#[test]
fn return_trap_set_late_and_reset() {
	let src = b"set -T; g() { :; }; g; trap 'echo R' RETURN; g; trap - RETURN; g; echo end";
	for fault in [Fault::None, Fault::Snapshot { every: 2 }] {
		let out = run_script(FakeHost::new(), src, &[], fault);
		assert_eq!(out.stdout, b"R\nend\n");
	}
	let out =
		run_script(FakeHost::new(), b"f() { trap 'echo R' RETURN; }; f; echo x", &[], Fault::None);
	assert_eq!(out.stdout, b"R\nx\n");
}

// The trap-frame count gates the `BASH_COMMAND` update: inside a signal
// trap it keeps the trapped command, after the trap it moves on again.
// Golden: bash 5.3.20.
#[test]
fn bash_command_kept_inside_trap_and_resumed_after() {
	let out = run_script(
		FakeHost::new(),
		b"trap 'echo \"usr1 $BASH_COMMAND\"' USR1; f() { kill -USR1 $$; echo \"after $BASH_COMMAND\"; }; f",
		&[],
		Fault::None,
	);
	assert_eq!(out.stdout, b"usr1 kill -USR1 $$\nafter echo \"after $BASH_COMMAND\"\n");
	assert_eq!(out.status, 0);
}

/// A signal whose disposition the host cannot change (as for one ignored
/// on entry) has its trap recorded as ignored, whatever sets it: bash's
/// `trap`, zsh's `trap`, or a zsh `TRAPNAL` function, which stays defined.
#[test]
fn a_signal_the_host_keeps_ignored_has_its_trap_recorded_as_ignored() {
	use crate::{
		bash::{ModeId, Script, ShellInit, SigSet, Signal},
		testkit::Rig,
	};
	let run = |zsh: bool, src: &str| {
		let mut host = FakeHost::new();
		host.fixed = SigSet::EMPTY.with(Signal::Usr1);
		let init = if zsh {
			ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..ShellInit::default() }
		} else {
			ShellInit::default()
		};
		let mut rig = Rig::new(host, init);
		rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned()
	};
	assert_eq!(
		run(false, "trap 'echo caught' USR1; kill -USR1 $$; trap -p USR1; echo done"),
		"trap -- '' SIGUSR1\ndone\n"
	);
	assert_eq!(
		run(true, "trap 'print caught' USR1; kill -USR1 $$; trap; print done"),
		"trap -- '' USR1\ndone\n"
	);
	assert_eq!(
		run(true, "TRAPUSR1() { print caught }; kill -USR1 $$; whence -w TRAPUSR1; print done"),
		"TRAPUSR1: function\ndone\n"
	);
}
