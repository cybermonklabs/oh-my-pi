//! What the shell does with a signal it has no trap for, and the OS
//! disposition the root asks the host for. `deliver` matches one answer
//! ([`decide`]); every disposition goes through [`ask_host`]: at startup
//! ([`init`]), after a restore in a new process ([`reinstall`]) and at each
//! trap change.
//!
//! - The interactive root: its own handlers ([`jobctl::untrapped`]) for the
//!   signals its table disposes of ([`jobctl::interactive_disposition`]).
//! - The signals the root holds ignored while untrapped
//!   ([`MiscKey::HeldIgnored`]): `QUIT` (bash "in all cases", zsh's
//!   `init_signals`) and, in zsh, the signals ignored on entry, until a trap
//!   for one is set or removed ([`release`]).
//! - zsh's `HUP` handler (`zhandler`: `zexit(SIGHUP)`, status 1 after the EXIT
//!   trap in effect, at once), interactive or not: caught unless `HUP` was
//!   ignored on entry (`init_signals`), and again after `trap - HUP`
//!   (`removetrap`).
//! - bash with an EXIT trap, interactive or not: once one is set its
//!   `terminating_signals` are caught (`set_signal` →
//!   `initialize_terminating_signals`), and one of them runs the trap, then
//!   kills the shell (`termsig_handler`). A host embedded in a runtime lets the
//!   shell catch only the signals it hands over
//!   ([`crate::bash::Host::may_catch`]): the runtime's fault handlers stay.
//! - Else the signal's default action.

use std::io;

use bstr::{BStr, BString};
use strum::IntoEnumIterator as _;

use super::{Cx, Kernel, builtins::trap, jobctl, proc::Vproc, state};
use crate::bash::{
	ids::{Dialect, ModeId},
	signal::{SigSet, Signal},
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError, TrapKey},
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
/// trap): the trap's own; else the interactive shell's handler for a signal
/// its table disposes of ([`jobctl::interactive_disposition`]); else ignored
/// while the root holds it so ([`MiscKey::HeldIgnored`]); else caught for
/// zsh's `HUP` handler or bash's EXIT trap (module doc), where the host lets
/// the shell catch it; else the default.
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
	if jobctl::interactive(k)
		&& let Some(own) = jobctl::interactive_disposition(k, sig)
	{
		return Ok(Some(own));
	}
	if names_hold(cx.store, vp, MiscKey::HeldIgnored, sig)? {
		return Ok(Some(BStr::new(b"")));
	}
	let caught = match vp.mode.dialect() {
		Dialect::Zsh => sig == Signal::Hup,
		Dialect::Bash => {
			BASH_FATAL.contains(&sig)
				&& !cx.host.ignored_signals().contains(sig)
				&& bash_exit_trap(cx.store, vp)?
		},
	};
	Ok((caught && cx.host.may_catch(sig)).then(|| BStr::new(CATCH)))
}

/// Whether the root asks the host for `sig`'s disposition: not a subshell,
/// whose traps change no disposition of the process, and not `KILL`,
/// `STOP` or `CHLD` (which comes from the engine, one per reaped child, not
/// from the OS).
const fn asks(vp: &Vproc, sig: Signal) -> bool {
	vp.overlay.is_none() && !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
}

/// Ask the host for the root shell's OS disposition of `sig` once its trap
/// is `action` (`None`: removed). `None` when the shell asks nothing
/// ([`asks`]). Else the host's answer: `Ok(false)` when the signal stays
/// ignored as it was on entry, and the caller then records the trap as
/// ignored.
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
	if !asks(vp, sig) {
		return Ok(None);
	}
	let disposition = disposition(k, cx, vp, sig, action)?;
	Ok(Some(cx.host.set_signal_trap(sig, disposition)))
}

/// bash `set_signal` for `EXIT` (`initialize_terminating_signals`): the
/// root asks the host again for each of its terminating signals that has no
/// trap ([`disposition`] catches it). They stay caught: an EXIT trap removed
/// later leaves each to kill the shell, as its default would.
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
			let _ = ask_host(k, cx, vp, sig, None)?;
		}
	}
	Ok(())
}

/// The root's signal state at startup (bash `initialize_signals`, zsh
/// `init_signals`), shell mode `mode`: the signals it holds ignored
/// ([`MiscKey::HeldIgnored`]: `QUIT`, and in zsh those ignored on entry),
/// the `trap ''` records of the signals ignored on entry (zsh: `QUIT` alone,
/// [`MiscKey::ZshEntryIgnored`]; any of them may be trapped), then their
/// dispositions and zsh's `HUP` catch ([`reinstall_these`]). Commands get
/// `QUIT` at its default. An interactive shell's own handlers follow
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
	let own = if zsh { held.with(Signal::Hup) } else { held };
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

/// [`reinstall`] for `signals`; one the shell leaves at its default is not
/// asked for.
fn reinstall_these(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	signals: impl Iterator<Item = Signal>,
) -> Result<Result<(), (Signal, io::Error)>, StoreError> {
	let platform = k.engine.config().platform;
	for sig in signals.filter(|&sig| asks(vp, sig)) {
		let key = TrapKey::Signal(sig);
		let action = match state::record(cx.store, vp, Key::Trap(key))? {
			Some(Record::Trap { action, .. }) => Some(action.clone()),
			_ if vp.mode.dialect() == Dialect::Zsh => {
				trap::find_func_trap(cx.store, vp, key, platform, |name, _| name)?
			},
			_ => None,
		};
		let Some(disposition) = disposition(k, cx, vp, sig, action.as_ref().map(BStr::new))? else {
			continue;
		};
		if let Err(err) = cx.host.set_signal_trap(sig, Some(disposition)) {
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
