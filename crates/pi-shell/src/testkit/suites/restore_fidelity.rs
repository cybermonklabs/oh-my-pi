//! Restore fidelity: state that lives in a vproc between ops
//! survives a snapshot taken there.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::{
	bash::{SigSet, Signal, SpawnSpec},
	testkit::{FakeHost, Fault, run_script},
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

/// A vproc's rarely used state ([`crate::bash::vm::proc::VprocRare`]) is in
/// the frames image, so a snapshot taken while it is set does not lose it.
/// What it holds is not an answer the shell prints, so each row reads it
/// through what the shell does next: the process-substitution fds an op
/// closes when it ends, which the next substitution then gets back, and the
/// coprocess `wait` reaps, which unsets `COPROC` and `COPROC_PID`. Goldens:
/// the uninterrupted run, which matches bash 5.3.20 (`/dev/fd` numbers are
/// this shell's own, counted down from 63).
#[test]
fn a_vprocs_rare_state_survives_a_snapshot() {
	// The two substitutions of the first command are closed when it ends, so
	// the third gets 63 back. Without the vproc's list the op closes
	// nothing, and the third would be 61.
	let (out, _) = same_under_snapshots(b"echo <(:) <(:); :; :; echo <(:)");
	assert_eq!(out, b"/dev/fd/63 /dev/fd/62\n/dev/fd/63\n");
	// A coprocess keeps its fds and its name across the snapshot: the
	// redirection writes its input, `read -u` reads its output, and the
	// `wait` reaps it, which unsets both its variables.
	let (out, _) = same_under_snapshots(
		b"coproc { read x; echo \"got $x\"; }; :; :; echo hi >&${COPROC[1]}; read -u \
		  ${COPROC[0]} y; echo \"co $y\"; wait \"$COPROC_PID\"; echo \"end $? \
		  [${COPROC-unset}] [${COPROC_PID-unset}]\"",
	);
	assert_eq!(out, b"co got hi\nend 0 [unset] [unset]\n");
	// `local -` in a function: the shell's `set -o` states come back when
	// the function returns, also when a snapshot lands inside it.
	let (out, _) = same_under_snapshots(
		b"set +u; f() { local -; set -u; :; :; :; case $- in *u*) echo 'in: u';; *) echo 'in: \
		  none';; esac; }; f; case $- in *u*) echo 'out: u';; *) echo 'out: none';; esac",
	);
	assert_eq!(out, b"in: u\nout: none\n");
}
