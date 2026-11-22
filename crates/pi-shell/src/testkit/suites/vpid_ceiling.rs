//! The last vpid ([`Vpid::CEILING`], `i32::MAX`): no vpid is given past it
//! and none twice. A command that needs one when none is left fails as when
//! bash cannot fork (bash 5.2.21 and 5.3.20 under `ulimit -u 1`): `bash:
//! fork: Resource temporarily unavailable` without a line, and the shell
//! leaves as `exit 254` does (its EXIT trap runs; a subshell's failure ends
//! only the subshell). zsh 5.9 prints `zsh:1: fork failed: resource
//! temporarily unavailable` and leaves with 1, without `TRAPEXIT`. Nothing
//! half-built is left: the next run of the shell works.

use std::sync::Arc;

use bstr::BString;

use crate::{
	bash::{
		Budget, CallOutcome, Cx, ModeId, RestoreOpts, Script, ShellApi, ShellInit, Step, Vpid,
		VprocSel,
	},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

const MESSAGE: &str = "bash: fork: Resource temporarily unavailable\n";

/// A bash rig whose next vpid is `next`.
fn rig_at(next: u32) -> Rig {
	let mut host = FakeHost::new();
	host.tool(
		"wrap",
		Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| -> CallOutcome { CallOutcome::Exit(0) }),
	);
	let mut r = Rig::new(host, skeleton_init(&[]));
	r.set_next_vpid(next);
	r
}

/// A zsh rig whose next vpid is `next`.
fn zsh_rig_at(next: u32) -> Rig {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut r = Rig::new(FakeHost::new(), init);
	r.set_next_vpid(next);
	r
}

const ZSH_MESSAGE: &str = "zsh:1: fork failed: resource temporarily unavailable\n";

/// Run `src` on `r`: stdout, stderr and status of this run alone.
fn run(r: &mut Rig, src: &str) -> (String, String, i32) {
	let out0 = r.host.stdout.bytes().len();
	let err0 = r.host.stderr.bytes().len();
	let status = r.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	let out = String::from_utf8_lossy(&r.host.stdout.bytes()[out0..]).into_owned();
	let err = String::from_utf8_lossy(&r.host.stderr.bytes()[err0..]).into_owned();
	(out, err, status)
}

/// With no vpid left, each kind of command that needs one fails before it
/// builds anything, prints bash's message and ends the run with 254; the
/// next run's builtin (which needs no vpid) works.
#[test]
fn every_kind_of_child_fails_as_a_fork_at_the_ceiling() {
	let rows = [
		("subshell", "( echo in ); echo after"),
		("command substitution", "x=$(echo y); echo after"),
		("pipeline", "echo a | cat; echo after"),
		("background job", "echo in & echo after"),
		("process substitution", "cat <(echo a); echo after"),
		("nested shell", "bash -c 'echo in'; echo after"),
		("callout", "wrap echo in; echo after"),
		("coprocess", "coproc { echo in; }; echo after"),
		(
			"command-not-found handler",
			"command_not_found_handle() { echo handled; }; no-such-command-q; echo after",
		),
	];
	let mut mismatches = Vec::new();
	for (kind, src) in rows {
		let mut r = rig_at(Vpid::CEILING + 1);
		let got = run(&mut r, src);
		if got != (String::new(), MESSAGE.to_owned(), 254) {
			mismatches.push(format!("{kind}: `{src}` gave {got:?}"));
		}
		let next = run(&mut r, "echo next");
		if next != ("next\n".to_owned(), String::new(), 0) {
			mismatches.push(format!("{kind}: the next run gave {next:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// The failure leaves as `exit 254` does: the EXIT trap runs.
#[test]
fn the_exit_trap_runs_after_the_failure() {
	let mut r = rig_at(Vpid::CEILING + 1);
	let got = run(&mut r, "trap 'echo exit-trap' EXIT; ( : ); echo after");
	assert_eq!(got, ("exit-trap\n".to_owned(), MESSAGE.to_owned(), 254));
}

/// The last vpid is given: a subshell gets `$BASHPID` 2147483647, and the
/// next child fails. A subshell's own failure ends only the subshell.
#[test]
fn the_last_vpid_is_given_and_then_none() {
	let mut r = rig_at(Vpid::CEILING);
	let got = run(&mut r, "( echo $BASHPID; ( : ); echo in ); echo \"out st=$?\"");
	assert_eq!(got, ("2147483647\nout st=254\n".to_owned(), MESSAGE.to_owned(), 0));
	let got = run(&mut r, "( : ); echo after");
	assert_eq!(got, (String::new(), MESSAGE.to_owned(), 254));
}

/// A pipeline whose stages do not all fit builds none of them.
#[test]
fn a_pipeline_that_does_not_fit_builds_no_stage() {
	let mut r = rig_at(Vpid::CEILING);
	let got = run(&mut r, "echo a | cat; echo after");
	assert_eq!(got, (String::new(), MESSAGE.to_owned(), 254));
	// The one vpid left is still there.
	let got = run(&mut r, "( echo $BASHPID )");
	assert_eq!(got, ("2147483647\n".to_owned(), String::new(), 0));
}

/// A callout that asks for a second subshell when none is left is refused
/// (`None`), and nothing is built; its first subshell runs.
#[test]
fn a_callout_is_refused_a_subshell_when_none_is_left() {
	let mut r = rig_at(Vpid::CEILING);
	let (shell, host, store) = r.parts();
	let main = shell.submit(Script::command(&b"wrap echo in; echo \"st=$?\""[..]));
	let mut first = None;
	let mut refused = None;
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { run, status } if run == main => {
				assert_eq!(status, 0);
				break;
			},
			Step::Done { run, status } => {
				if Some(run) == first.map(|(_, r)| r) {
					let (id, _) = first.expect("the first subshell");
					shell.complete(id, CallOutcome::Exit(status));
				}
			},
			Step::Call { id, call } => {
				let mut cx = Cx { host: &mut *host, store: &mut *store };
				let mut api = shell.api(&mut cx, id).expect("call is outstanding");
				let command = || {
					let mut script = Script::command(&b"\"$@\""[..]);
					script.args = Some(call.argv[1..].to_vec());
					script
				};
				let run = api.run_subshell(command()).expect("the last vpid");
				refused = Some(api.run_subshell(command()).is_none());
				first = Some((id, run));
			},
			Step::Yield | Step::Blocked => {},
			other => panic!("{other:?}"),
		}
	}
	assert_eq!(refused, Some(true), "the second subshell is refused");
	assert_eq!(String::from_utf8_lossy(&host.stdout.bytes()), "in\nst=0\n");
}

/// zsh: its own message with the line, status 1, no `TRAPEXIT` (zsh runs
/// it after other errors, not after this one); a subshell's failure ends
/// only the subshell.
#[test]
fn zsh_fails_with_its_own_message() {
	let mut r = zsh_rig_at(Vpid::CEILING + 1);
	let got = run(&mut r, "TRAPEXIT() { print exit-trap }; ( : ); print after");
	assert_eq!(got, (String::new(), ZSH_MESSAGE.to_owned(), 1));
	let mut r = zsh_rig_at(Vpid::CEILING);
	let got = run(&mut r, "( ( : ); print in ); print \"out st=$?\"");
	assert_eq!(got, ("out st=1\n".to_owned(), ZSH_MESSAGE.to_owned(), 0));
}

/// zsh's command substitution and both process substitutions fail as its
/// fork does (zsh 5.9 under `ulimit -u 1`: `zsh:1: fork failed: …`, status
/// 1); the next run works.
#[test]
fn zsh_substitutions_fail_as_a_fork() {
	let rows = [
		("command substitution", "x=$(print y); print after"),
		("input process substitution", "cat <(print a); print after"),
		("output process substitution", "print a > >(cat); print after"),
	];
	let mut mismatches = Vec::new();
	for (kind, src) in rows {
		let mut r = zsh_rig_at(Vpid::CEILING + 1);
		let got = run(&mut r, src);
		if got != (String::new(), ZSH_MESSAGE.to_owned(), 1) {
			mismatches.push(format!("{kind}: `{src}` gave {got:?}"));
		}
		let next = run(&mut r, "print next");
		if next != ("next\n".to_owned(), String::new(), 0) {
			mismatches.push(format!("{kind}: the next run gave {next:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// zsh's `zpty` starts its command in a subshell: with no vpid left it
/// fails as zsh's fork does there (zsh 5.9 under `ulimit -u 1`: `can't
/// create pty command NAME: resource temporarily unavailable`, under the
/// name `(zpty)` while `evallineno` is on, else `zsh`), status 1, and the
/// shell goes on. It is checked before the pty opens, so a host without
/// one reports the same.
#[test]
fn zpty_fails_as_a_fork() {
	let mut r = zsh_rig_at(Vpid::CEILING + 1);
	let got = run(&mut r, "zmodload zsh/zpty; zpty z 'print hi'; print \"st=$?\"");
	let message = "(zpty):zpty:1: can't create pty command z: resource temporarily unavailable\n";
	assert_eq!(got, ("st=1\n".to_owned(), message.to_owned(), 0));
	let got =
		run(&mut r, "setopt noevallineno; zmodload zsh/zpty; zpty z 'print hi'; print \"st=$?\"");
	let message = "zsh:zpty:1: can't create pty command z: resource temporarily unavailable\n";
	assert_eq!(got, ("st=1\n".to_owned(), message.to_owned(), 0));
}

/// A pipeline whose last stage runs in the shell (bash `lastpipe` without
/// job control, every zsh pipeline) needs one vpid less: with one left,
/// `echo a | read x` runs; one more stage than fits still builds nothing.
#[test]
fn a_last_stage_in_the_shell_needs_no_vpid() {
	let mut r = rig_at(Vpid::CEILING);
	let got = run(&mut r, "shopt -s lastpipe; echo a | read x; echo \"x=$x\"");
	assert_eq!(got, ("x=a\n".to_owned(), String::new(), 0));
	let mut r = rig_at(Vpid::CEILING);
	let got = run(&mut r, "shopt -s lastpipe; echo a | cat | read x; echo \"x=$x\"");
	assert_eq!(got, (String::new(), MESSAGE.to_owned(), 254));
	let mut r = zsh_rig_at(Vpid::CEILING);
	let got = run(&mut r, "print a | read x; print x=$x");
	assert_eq!(got, ("x=a\n".to_owned(), String::new(), 0));
}

/// A host's run in a new subshell when no vpid is left ends at once with
/// 254, as a fork failure does, and prints nothing; the shell goes on.
#[test]
fn a_host_subshell_run_with_no_vpid_left_ends_with_254() {
	let mut r = rig_at(Vpid::CEILING + 1);
	let sub = Script { vproc: VprocSel::NewSubshell, ..Script::command(&b"echo in"[..]) };
	let status = r.run(sub, Fault::None);
	assert_eq!(status, 254);
	assert_eq!(r.host.stdout.bytes(), b"");
	assert_eq!(r.host.stderr.bytes(), b"");
	let next = run(&mut r, "echo next");
	assert_eq!(next, ("next\n".to_owned(), String::new(), 0));
}

/// A stored next vpid at or below the base cannot come from this engine
/// (`create` stores base + 1 and the counter only grows; only an older
/// engine's wrapped counter or a damaged store has one): `restore` starts
/// above the base, so no vpid is a number an OS pid can take. Both ways a
/// host restores: with the frames, and from the store's records alone.
#[test]
fn a_stored_next_vpid_below_the_base_is_not_used() {
	let base = Vpid::BASE;
	let mut r = rig_at(5);
	let got = run(&mut r, "( echo $BASHPID )");
	assert_eq!(got, (format!("{}\n", base + 1), String::new(), 0));
	let mut r = rig_at(Vpid::BASE + 1);
	r.set_next_vpid_with(5, RestoreOpts { drop_frames: true, ..RestoreOpts::default() });
	let got = run(&mut r, "( echo $BASHPID )");
	assert_eq!(got, (format!("{}\n", base + 1), String::new(), 0), "restored without frames");
}

/// The restored counter also starts above every vproc the image brings
/// back, so no vpid is given twice: a background job still running across a
/// restore whose stored counter was below the base keeps its vpid, and the
/// next child gets a new one.
#[test]
fn a_restored_counter_starts_above_the_live_vprocs() {
	let mut r = rig_at(Vpid::BASE + 1);
	let job = Vpid::BASE + 1;
	let got = run(&mut r, "while :; do :; done & echo $!");
	assert_eq!(got, (format!("{job}\n"), String::new(), 0));
	r.set_next_vpid(5);
	let got = run(&mut r, &format!("( echo $BASHPID ); kill {job}; echo \"st=$?\""));
	assert_eq!(got, (format!("{}\nst=0\n", job + 1), String::new(), 0));
}
