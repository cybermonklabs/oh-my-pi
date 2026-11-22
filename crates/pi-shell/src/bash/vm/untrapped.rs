//! What the shell does with a signal it has no trap for, and the OS
//! disposition the root asks the host for. One classification, [`own`],
//! holds the shell's own rules; `deliver` maps it to what to do when a
//! signal comes ([`decide`]), and every disposition the root asks the host
//! for maps it to the OS disposition ([`disposition`], through [`ask_host`]
//! or [`reinstall_these`]): at startup ([`init`], then
//! [`jobctl::init_io`]), after a restore in a new process ([`reinstall`]),
//! when job control starts or comes back ([`jobctl::enable_monitor`],
//! [`jobctl::suspend_shell`]), around a program run in place
//! ([`program_in_place`]) and at each trap change.
//!
//! - While the root's process runs a program in place of the shell (`exec`, or
//!   the last command of a `-c` string), each signal that would end the process
//!   is caught and forwarded to the program, and one the shell holds ignored
//!   for itself (`QUIT`) too ([`Own::Program`]).
//! - The interactive root catches `INT`, `WINCH` and `ALRM` for its own
//!   handlers ([`jobctl::catches`]) and ignores `QUIT` and `TERM`; a root doing
//!   job control ignores `TSTP`, `TTIN` and `TTOU` ([`jobctl::ignores`]).
//! - The signals the root holds ignored while untrapped
//!   ([`MiscKey::HeldIgnored`]): `QUIT` (bash "in all cases", zsh's
//!   `init_signals`) and, in zsh, the signals ignored on entry, until a trap
//!   for one is set or removed ([`release`]). A bash subshell holds them once
//!   it ran `trap - SIG` itself.
//! - zsh's `HUP` handler (`zhandler`: `zexit(SIGHUP)`, status 1 after the EXIT
//!   trap in effect, at once), interactive or not: caught unless `HUP` was
//!   ignored on entry (`init_signals`), and again after `trap - HUP`
//!   (`removetrap`).
//! - bash with an EXIT trap, interactive or not: once one is set its
//!   `terminating_signals` are caught (`set_signal` →
//!   `initialize_terminating_signals`), unless ignored on entry, and one of
//!   them runs the trap, then kills the shell (`termsig_handler`).
//! - bash catches `INT` for each wait without job control (`jobs.c`
//!   `wait_for`'s `wait_sigint_handler`), EXIT trap or not: a shell, or a
//!   subshell, that waits for its foreground job notes it, and acts on it once
//!   the job has ended, only if the last process of the job to end died of
//!   `SIGINT` (`child_caught_sigint`, which `waitchld` sets again for each
//!   child it reaps; [`Untrapped::Held`]); else it goes on. Each bash process,
//!   the root or a subshell, with job control or without, holds it while it
//!   reads a command substitution (`command_substitute` blocks `SIGINT` around
//!   `read_comsub`) and acts once the read ends. One that runs shell code
//!   meanwhile acts at once. obash catches it for that ([`Own::BashInt`]), and
//!   gives the kernel's `INT` to each process of the foreground command bash
//!   would run in the shell's process group (`Shell::int_to_foreground`). A
//!   host embedded in a runtime lets the shell catch only the signals it hands
//!   over ([`crate::bash::Host::may_catch`]): the runtime's fault handlers
//!   stay.
//! - Else the signal's default action.

use std::io;

use bstr::{BStr, BString};
use strum::IntoEnumIterator as _;

use super::{Cx, Kernel, builtins::trap, jobctl, proc::Vproc, state};
use crate::bash::{
	ids::{Dialect, ModeId},
	signal::{DefaultAction, SigSet, Signal},
	store::{Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, TrapKey},
};

/// The action text handed to [`crate::bash::Host::set_signal_trap`] for a
/// signal the shell catches by its own rules (any non-empty action catches;
/// the text is not run).
pub(super) const CATCH: &[u8] = b"caught";

/// bash's `terminating_signals` (`sig.c`): the fatal signals it catches,
/// to run its EXIT trap first, once one is set. `PROF`, `STKFLT` and `PWR`
/// are not among them (measured with bash 5.2.21).
const BASH_FATAL: [Signal; 18] = [
	Signal::Hup,
	Signal::Int,
	Signal::Ill,
	Signal::Trap,
	Signal::Abrt,
	Signal::Emt,
	Signal::Fpe,
	Signal::Bus,
	Signal::Segv,
	Signal::Sys,
	Signal::Pipe,
	Signal::Alrm,
	Signal::Term,
	Signal::Xcpu,
	Signal::Xfsz,
	Signal::Vtalrm,
	Signal::Usr1,
	Signal::Usr2,
];

/// What a vproc does with a signal it has no trap for.
pub(super) enum Untrapped {
	/// The interactive root's own handler took it.
	Handled,
	/// The root holds it ignored.
	Ignored,
	/// zsh: exit with status 1 now, after the EXIT trap in effect.
	ZshHupExit,
	/// bash: run the EXIT trap, then die of the signal.
	BashExitTrapThenDie,
	/// bash, `INT` while the vproc waits without job control for what
	/// [`super::HeldInt`] says: noted, to act on once the wait ends
	/// ([`super::Kernel::int_notes`]).
	Held(super::HeldInt),
	/// The signal's default action.
	Default,
}

/// The shell's own rule for a signal it has no trap for (module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Own {
	/// The interactive root catches it for its own handler.
	Caught,
	/// The root ignores it.
	Ignored,
	/// zsh's `HUP` handler.
	ZshHup,
	/// bash's catch of a terminating signal once an EXIT trap is set.
	BashExitTrap,
	/// bash's catch of `INT` without an EXIT trap, for its waits without job
	/// control (`wait_sigint_handler`): held while it waits, else at its
	/// default.
	BashInt,
	/// Caught to be forwarded to the program the root's process runs in
	/// place of the shell ([`program_in_place`]).
	Program,
	/// The signal's default action.
	Default,
}

/// [`Own`] for `sig`, which `vp` has no trap for.
fn own(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, sig: Signal) -> Result<Own, StoreError> {
	// The root's process: the root, or a zsh `( … )` it runs in place.
	let root_process = vp.parent.is_none() || vp.in_place();
	// The program the process runs gets what would end it, and what the
	// shell holds ignored for itself (`QUIT`): the program starts with it at
	// its default. One ignored on entry it inherits ignored while the shell
	// holds it so: bash always (it cannot reset one), zsh until a trap for it
	// is set or removed (`trap - TERM`, [`release`]), which resets it.
	if root_process
		&& k.program_in_place
		&& sig.default_action() == DefaultAction::Terminate
		&& sig != Signal::Kill
		&& !(cx.host.ignored_signals().contains(sig)
			&& (vp.mode.dialect() != Dialect::Zsh
				|| names_hold(cx.store, vp, MiscKey::HeldIgnored, sig)?))
	{
		return Ok(Own::Program);
	}
	if vp.parent.is_none() {
		if jobctl::catches(k, sig) {
			return Ok(Own::Caught);
		}
		if jobctl::ignores(k, sig) {
			return Ok(Own::Ignored);
		}
	}
	// A bash subshell holds them again once it ran `trap - SIG` itself:
	// `restore_default_signal` puts the shell's own disposition back (bash
	// 5.3.20: `( trap - QUIT; kill -QUIT $BASHPID; echo alive )` prints
	// `alive`); one that did not dies of `QUIT`.
	let reset = vp.mode.dialect() == Dialect::Bash && vp.own_traps.has(TrapKey::Signal(sig));
	if (root_process || reset) && names_hold(cx.store, vp, MiscKey::HeldIgnored, sig)? {
		return Ok(Own::Ignored);
	}
	Ok(match vp.mode.dialect() {
		Dialect::Zsh if sig == Signal::Hup => Own::ZshHup,
		Dialect::Bash
			if BASH_FATAL.contains(&sig)
				&& !cx.host.ignored_signals().contains(sig)
				&& bash_exit_trap(cx.store, vp)? =>
		{
			Own::BashExitTrap
		},
		Dialect::Bash if sig == Signal::Int && !cx.host.ignored_signals().contains(sig) => {
			Own::BashInt
		},
		_ => Own::Default,
	})
}

/// [`Untrapped`] for `sig`, which `vp` has no trap for ([`own`]); `waits`:
/// what `vp` waits for (the engine's `Shell::waits`), for bash's `INT`
/// hold: a subshell always has it; the root has it for a substitution it
/// reads, and for its foreground job only without job control (`set -m`).
///
/// # Errors
///
/// A store failure reading the held set, an option or the EXIT trap.
pub(super) fn decide(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sig: Signal,
	waits: Option<super::HeldInt>,
) -> Result<Untrapped, StoreError> {
	let own = own(k, cx, vp, sig)?;
	let held = if sig == Signal::Int && matches!(own, Own::BashExitTrap | Own::BashInt) {
		let monitor =
			vp.parent.is_none() && state::option(&mut k.root, cx.store, vp, OptId::Monitor)?;
		waits.filter(|&held| !monitor || held == super::HeldInt::Comsub)
	} else {
		None
	};
	Ok(match own {
		// `WINCH` has no handler to run here: its default ignores it.
		Own::Caught if jobctl::untrapped(k, cx, vp, sig) => Untrapped::Handled,
		Own::Caught | Own::Program | Own::Default => Untrapped::Default,
		Own::Ignored => Untrapped::Ignored,
		Own::ZshHup => Untrapped::ZshHupExit,
		Own::BashInt => held.map_or(Untrapped::Default, Untrapped::Held),
		Own::BashExitTrap => held.map_or(Untrapped::BashExitTrapThenDie, Untrapped::Held),
	})
}

/// Whether `vp` runs a bash EXIT trap of its own when it ends: the root's,
/// or one a subshell set itself.
fn bash_exit_trap(store: &mut dyn StateStore, vp: &Vproc) -> Result<bool, StoreError> {
	if vp.parent.is_some() && !vp.own_traps.has(TrapKey::Exit) {
		return Ok(false);
	}
	Ok(matches!(
		state::record(store, vp, Key::Trap(TrapKey::Exit))?,
		Some(Record::Trap { action, .. }) if !action.is_empty()
	))
}

/// The root's OS disposition of `sig` once its trap is `action` (`None`: no
/// trap): the trap's own, else [`own`]'s: caught, ignored, or caught for
/// zsh's `HUP` handler, bash's EXIT trap, bash's `INT` for its waits or a
/// program run in place, where the host lets the shell catch it; else the
/// default.
fn disposition<'a>(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sig: Signal,
	action: Option<&'a BStr>,
) -> Result<Option<&'a BStr>, StoreError> {
	if action.is_some() {
		return Ok(action);
	}
	Ok(match own(k, cx, vp, sig)? {
		Own::Caught => Some(BStr::new(CATCH)),
		Own::Ignored => Some(BStr::new(b"")),
		Own::ZshHup | Own::BashExitTrap | Own::BashInt | Own::Program => {
			cx.host.may_catch(sig).then(|| BStr::new(CATCH))
		},
		Own::Default => None,
	})
}

/// The root's process becomes the program `vp`'s innermost frame `exec`s or
/// runs without a fork (`running`), or is the shell's own again
/// ([`program_ended`]): the root asks the host again for each signal whose
/// default action ends the process and that has no trap. While the program
/// runs each is caught ([`Own::Program`]) and forwarded to it, as the real
/// shell's process, the program, would get it; one the shell ignores stays
/// ignored, as the program inherits it, and a trapped one keeps its trap's
/// disposition (it is forwarded too). `vp` is the root, or the zsh `( … )`
/// it runs in place, whose traps are the process's. Asked before the spawn,
/// so the program starts with the default of each (a handler does not
/// survive `exec`).
pub(super) fn program_in_place(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, running: bool) {
	k.program_in_place = running;
	let platform = k.engine.config().platform;
	let ends = |sig: Signal| {
		sig.default_action() == DefaultAction::Terminate
			&& sig != Signal::Kill
			&& sig.number(platform) != 0
	};
	for sig in Signal::iter().filter(|&sig| ends(sig)) {
		let key = TrapKey::Signal(sig);
		let recorded = state::record(cx.store, vp, Key::Trap(key)).map(|trap| trap.is_some());
		let trapped = recorded.and_then(|recorded| {
			Ok(recorded
				|| (vp.mode.dialect() == Dialect::Zsh
					&& trap::find_func_trap(cx.store, vp, key, platform, |_, _| ())?.is_some()))
		});
		let asked = match trapped {
			Ok(true) => continue,
			Ok(false) => disposition(k, cx, vp, sig, None),
			Err(err) => Err(err),
		};
		match asked {
			Ok(disposition) => {
				let _ = cx.host.set_signal_trap(sig, disposition);
			},
			Err(err) => {
				k.fail(err);
				return;
			},
		}
	}
}

/// The program the root's process ran in place of the shell has ended, or
/// never runs: reaped (`command`'s `await_`), its spawn failed, or a cancel
/// or the root's own end took the frames that ran it (`Shell`'s
/// `apply_requests` and `end`). The process is the shell's own again, with
/// the shell's signal rules ([`program_in_place`] with `running` false; a
/// session runs its next command), and the signals kept for a program
/// still being spawned go ([`Kernel::forward`]). `vp`: the root, or the zsh
/// `( … )` that ran the program.
pub(super) fn program_ended(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) {
	k.forward = crate::bash::SigSet::EMPTY;
	if k.program_in_place {
		program_in_place(k, cx, vp, false);
	}
}

/// Whether the root asks the host for `sig`'s disposition: the root's
/// process (the root, or the zsh `( … )` it runs in place, whose traps are
/// the process's), not another subshell, whose traps change no disposition
/// of the process; not a signal the platform lacks (number 0: `EMT` on
/// Linux); and not `KILL`, `STOP` or `CHLD` (which comes from the engine, one
/// per reaped child, not from the OS).
fn asks(k: &Kernel, vp: &Vproc, sig: Signal) -> bool {
	(vp.parent.is_none() || vp.in_place())
		&& sig.number(k.engine.config().platform) != 0
		&& !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
}

/// When [`ask`] asks the host for a disposition.
#[derive(Clone, Copy, PartialEq, Eq)]
enum When {
	/// Always: a trap changed, and the disposition it leaves must replace
	/// the old one.
	Always,
	/// Only for one other than the default: the process holds the default
	/// (a new one, after a restore), so asking for it changes nothing.
	NotDefault,
}

/// Ask the host for the root shell's OS disposition of `sig` once its trap
/// is `action` (`None`: none), [`disposition`]'s, `when` says so. `None`
/// when the shell asks nothing ([`asks`]). Else the host's answer:
/// `Ok(false)` when the signal stays ignored as it was on entry.
fn ask(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sig: Signal,
	action: Option<&BStr>,
	when: When,
) -> Result<Option<io::Result<bool>>, StoreError> {
	if !asks(k, vp, sig) {
		return Ok(None);
	}
	let disposition = disposition(k, cx, vp, sig, action)?;
	if disposition.is_none() && when == When::NotDefault {
		return Ok(None);
	}
	Ok(Some(cx.host.set_signal_trap(sig, disposition)))
}

/// [`ask`] for a trap of `sig` set to `action` or removed (`None`), at
/// once. `Ok(false)` inside: the signal stays ignored as it was on entry,
/// and the caller records the trap as ignored.
///
/// # Errors
///
/// A store failure reading the EXIT trap.
pub(super) fn ask_host(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sig: Signal,
	action: Option<&BStr>,
) -> Result<Option<io::Result<bool>>, StoreError> {
	ask(k, cx, vp, sig, action, When::Always)
}

/// bash `set_signal` for `EXIT` (`initialize_terminating_signals`): the
/// root asks the host again for each of its terminating signals that has no
/// trap ([`disposition`] catches it; one the host does not let it catch is
/// not asked for). They stay caught: an EXIT trap removed later leaves each
/// to kill the shell, as its default would.
///
/// # Errors
///
/// A store failure reading the signals' traps.
pub(super) fn bash_exit_trap_set(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<(), StoreError> {
	if vp.mode.dialect() != Dialect::Bash {
		return Ok(());
	}
	for sig in BASH_FATAL {
		if state::record(cx.store, vp, Key::Trap(TrapKey::Signal(sig)))?.is_none() {
			let _ = ask(k, cx, vp, sig, None, When::NotDefault)?;
		}
	}
	Ok(())
}

/// The root's signal state at startup (bash `initialize_signals`, zsh
/// `init_signals`), shell mode `mode`: the signals it holds ignored
/// ([`MiscKey::HeldIgnored`]: `QUIT`, and in zsh those ignored on entry),
/// the `trap ''` records of the signals ignored on entry (zsh: `QUIT` alone,
/// [`MiscKey::ZshEntryIgnored`]; any of them may be trapped), then their
/// dispositions, zsh's `HUP` catch and bash's `INT` catch for its waits
/// ([`Own::BashInt`]; [`reinstall_these`]). Commands get `QUIT` at its
/// default. An interactive shell's own handlers follow
/// ([`jobctl::init_io`]).
///
/// # Errors
///
/// A store failure reading the records back.
pub(super) fn init(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	mode: ModeId,
) -> Result<(), StoreError> {
	let zsh = mode.dialect() == Dialect::Zsh;
	let ignored = cx.host.ignored_signals();
	let held = (if zsh { ignored } else { SigSet::EMPTY }).with(Signal::Quit);
	let names = |set: SigSet| {
		set.iter()
			.map(|sig| BString::from(sig.to_string()))
			.collect()
	};
	k.root.set_record(
		cx.store,
		KeyBuf::Misc(MiscKey::HeldIgnored),
		Some(Record::Words(names(held))),
	);
	for sig in ignored.iter() {
		if zsh {
			cx.host.forget_ignored(sig);
			if sig != Signal::Quit {
				continue;
			}
			k.root.set_record(
				cx.store,
				KeyBuf::Misc(MiscKey::ZshEntryIgnored),
				Some(Record::Words(names(SigSet::EMPTY.with(sig)))),
			);
		}
		k.root.set_record(
			cx.store,
			KeyBuf::Trap(TrapKey::Signal(sig)),
			Some(Record::Trap { mode, action: BString::default() }),
		);
	}
	let own = if zsh {
		held.with(Signal::Hup)
	} else {
		held.with(Signal::Int)
	};
	// A refusal leaves the disposition the process started with.
	let _ = reinstall_these(k, cx, vp, own.iter())?;
	Ok(())
}

/// Ask the host for the root's disposition of every signal ([`ask_host`]):
/// its trap's, its zsh trap function's, or its own rules' (module doc). A
/// restore in a new process runs this: it starts with default dispositions
/// (handlers do not survive `exec`).
///
/// # Errors
///
/// A store failure reading the traps; inside, the first signal the host
/// refused, with its error.
pub(super) fn reinstall(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<Result<(), (Signal, io::Error)>, StoreError> {
	reinstall_these(k, cx, vp, Signal::iter())
}

/// [`reinstall`] for `signals`, which the process holds at their default:
/// one the shell leaves at its default is not asked for.
///
/// # Errors
///
/// A store failure reading the traps; inside, the first signal the host
/// refused, with its error.
pub(super) fn reinstall_these(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	signals: impl Iterator<Item = Signal>,
) -> Result<Result<(), (Signal, io::Error)>, StoreError> {
	reask(k, cx, vp, signals, When::NotDefault)
}

/// The zsh `( … )` that `vp`'s process ran in place of itself has ended: its
/// traps were the process's ([`asks`]), and the process is `vp`'s again (a
/// session's root runs its next command). `vp` asks the host again for the
/// disposition of every signal, its default too.
pub(super) fn in_place_ended(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) {
	if let Err(err) = reask(k, cx, vp, Signal::iter(), When::Always) {
		k.fail(err);
	}
}

/// Ask the host for `vp`'s disposition of each of `signals` ([`ask`]): its
/// trap's, its zsh trap function's, or its own rules'.
fn reask(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	signals: impl Iterator<Item = Signal>,
	when: When,
) -> Result<Result<(), (Signal, io::Error)>, StoreError> {
	let platform = k.engine.config().platform;
	for sig in signals {
		let key = TrapKey::Signal(sig);
		let action = match state::record(cx.store, vp, Key::Trap(key))? {
			Some(Record::Trap { action, .. }) => Some(action.clone()),
			_ if vp.mode.dialect() == Dialect::Zsh => {
				trap::find_func_trap(cx.store, vp, key, platform, |name, _| name)?
			},
			_ => None,
		};
		let asked = ask(k, cx, vp, sig, action.as_ref().map(BStr::new), when)?;
		if let Some(Err(err)) = asked {
			return Ok(Err((sig, err)));
		}
	}
	Ok(Ok(()))
}

/// A zsh trap for `sig` is set or removed: the root holds it ignored no
/// more (`settrap` gives it a handler, `removetrap` its default), and the
/// ignored-on-entry `QUIT` record goes ([`MiscKey::ZshEntryIgnored`]).
///
/// # Errors
///
/// A store failure reading the records.
pub(super) fn release(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	sig: Signal,
) -> Result<(), StoreError> {
	names_remove(root, store, vp, MiscKey::HeldIgnored, sig)?;
	names_remove(root, store, vp, MiscKey::ZshEntryIgnored, sig)
}

/// Whether the record `key` (`Record::Words` of signal names) names `sig`.
///
/// # Errors
///
/// A store failure reading the record.
pub(super) fn names_hold(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: MiscKey,
	sig: Signal,
) -> Result<bool, StoreError> {
	let name = sig.to_string();
	Ok(matches!(
		state::record(store, vp, Key::Misc(key))?,
		Some(Record::Words(names)) if names.iter().any(|n| n.as_slice() == name.as_bytes())
	))
}

/// Take `sig` out of the record `key` (`Record::Words` of signal names);
/// the record goes once empty.
fn names_remove(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: MiscKey,
	sig: Signal,
) -> Result<(), StoreError> {
	let name = sig.to_string();
	let Some(Record::Words(names)) = state::record(store, vp, Key::Misc(key))? else {
		return Ok(());
	};
	if !names.iter().any(|n| n.as_slice() == name.as_bytes()) {
		return Ok(());
	}
	let rest: Vec<BString> = names
		.iter()
		.filter(|n| n.as_slice() != name.as_bytes())
		.cloned()
		.collect();
	let record = (!rest.is_empty()).then_some(Record::Words(rest));
	state::store_record(root, store, vp, KeyBuf::Misc(key), record);
	Ok(())
}
