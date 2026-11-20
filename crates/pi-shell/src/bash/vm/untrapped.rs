//! What the shell does with a signal it has no trap for, and the OS
//! disposition its traps ask the host for. `deliver` matches one answer
//! ([`decide`]); every trap change asks the host through [`ask_host`].
//!
//! - The interactive root: zsh's own handlers ([`jobctl::untrapped`]).
//! - The signals the root holds ignored while untrapped
//!   ([`MiscKey::HeldIgnored`]): `QUIT` (bash "in all cases", zsh's
//!   `init_signals`) and, in zsh, the signals ignored on entry, until a trap
//!   for one is set or removed ([`release`]).
//! - zsh's `HUP` handler (`zhandler`: `zexit(SIGHUP)`, status 1 after the EXIT
//!   trap in effect, at once): caught unless `HUP` was ignored on entry
//!   (`init_signals`), and again after `trap - HUP` (`removetrap`).
//! - bash with an EXIT trap: once one is set its `terminating_signals` are
//!   caught (`set_signal` → `initialize_terminating_signals`), and one of them
//!   runs the trap, then kills the shell (`termsig_handler`).
//! - Else the signal's default action.

use bstr::{BStr, BString};

/// The action text that makes the host catch a signal and hand it to the
/// engine (the text is not run).
pub(super) use super::jobctl::CATCH;
use super::{Cx, Kernel, jobctl, proc::Vproc, state};
use crate::bash::{
	ids::Dialect,
	signal::Signal,
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError, TrapKey},
};

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
	/// The signal's default action.
	Default,
}

/// [`Untrapped`] for `sig`, which `vp` has no trap for.
///
/// # Errors
///
/// A store failure reading the held set or the EXIT trap.
pub(super) fn decide(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sig: Signal,
) -> Result<Untrapped, StoreError> {
	if vp.parent.is_none() {
		if jobctl::untrapped(k, cx, vp, sig) {
			return Ok(Untrapped::Handled);
		}
		if names_hold(cx.store, vp, MiscKey::HeldIgnored, sig)? {
			return Ok(Untrapped::Ignored);
		}
	}
	Ok(match vp.mode.dialect() {
		Dialect::Zsh if sig == Signal::Hup => Untrapped::ZshHupExit,
		Dialect::Bash if BASH_FATAL.contains(&sig) && bash_exit_trap(cx.store, vp)? => {
			Untrapped::BashExitTrapThenDie
		},
		_ => Untrapped::Default,
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
/// trap): the trap's own; the interactive shell's handlers
/// ([`jobctl::interactive_disposition`]); else, with no trap, the shell's own
/// disposition (module doc), or the default.
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
	if k.jobctl.interactive {
		return Ok(jobctl::interactive_disposition(k, sig));
	}
	Ok(match vp.mode.dialect() {
		Dialect::Bash if sig == Signal::Quit => Some(BStr::new(b"")),
		Dialect::Bash
			if BASH_FATAL.contains(&sig)
				&& !cx.host.ignored_signals().contains(sig)
				&& bash_exit_trap(cx.store, vp)? =>
		{
			Some(BStr::new(CATCH))
		},
		Dialect::Zsh if sig == Signal::Hup => Some(BStr::new(CATCH)),
		_ => None,
	})
}

/// Ask the host for the root shell's OS disposition of `sig` once its trap
/// is `action` (`None`: removed). `None` when the shell asks nothing: in a
/// subshell, whose traps change no disposition of the process, and for
/// `KILL`, `STOP` and `CHLD` (which comes from the engine, one per reaped
/// child, not from the OS). Else the host's answer: `Ok(false)` when the
/// signal stays ignored as it was on entry, and the caller then records the
/// trap as ignored.
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
) -> Result<Option<std::io::Result<bool>>, StoreError> {
	if vp.overlay.is_some() || matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld) {
		return Ok(None);
	}
	let disposition = disposition(k, cx, vp, sig, action)?;
	Ok(Some(cx.host.set_signal_trap(sig, disposition)))
}

/// bash `set_signal` for `EXIT` in a non-interactive shell
/// (`initialize_terminating_signals`): the root starts catching each of its
/// terminating signals that has no trap and was not ignored on entry. They
/// stay caught: an EXIT trap removed later leaves each to kill the shell,
/// as its default would.
///
/// # Errors
///
/// A store failure reading the signals' traps.
pub(super) fn bash_exit_trap_set(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<(), StoreError> {
	if vp.overlay.is_some() || k.jobctl.interactive || vp.mode.dialect() != Dialect::Bash {
		return Ok(());
	}
	for sig in BASH_FATAL {
		if cx.host.ignored_signals().contains(sig)
			|| state::record(cx.store, vp, Key::Trap(TrapKey::Signal(sig)))?.is_some()
		{
			continue;
		}
		let _ = cx.host.set_signal_trap(sig, Some(BStr::new(CATCH)));
	}
	Ok(())
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
