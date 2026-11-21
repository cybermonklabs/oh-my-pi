//! bash's notice of a foreground command that a signal killed (`jobs.c`
//! `notify_of_job_status`), for a non-interactive bash-mode shell, and the
//! commands the real shell runs in place of itself ([`in_place`]): the last
//! command of a `-c` string, run with `exec` and no fork (bash
//! `CMD_NO_FORK`, zsh `execcmd_exec`'s `last1`). Such a command prints no
//! notice: the shell's own process is the command, and dies of the signal
//! with it.
//!
//! bash 5.2.21 is built with `DONT_REPORT_SIGTERM` and `DONT_REPORT_SIGPIPE`
//! (`config-top.h`): `INT` and `PIPE` say nothing; `TERM`, or a signal the
//! shell traps (`trap '' SIG` too), prints the signal's description; any
//! other prints `NAME: line N: `, the pid, the description padded to
//! `LONGEST_SIGNAL_DESC` (24) columns and the command as bash prints it.
//! bash writes it to its own standard error, never through the command's
//! redirections, and names the line it has reached when it waits. A posix
//! `-c` shell prints nothing. zsh prints nothing in any of these cases.

use bstr::BString;
use strum::IntoEnumIterator as _;

use super::{
	Cx, Kernel,
	builtins::trap,
	exec, nested,
	proc::{FrameKind, LoopKind, LoopRec, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	diag::Diag,
	event::NodeKind,
	ids::Dialect,
	ir::{Op, RedirTargetIr, Unit},
	signal::Signal,
	store::{Key, KeyBuf, MiscKey, OptId, Record, StoreError, TrapKey},
};

/// What the end of a foreground external command that `sig` killed means
/// for the shell.
pub(super) struct Killed {
	/// The notice, for the shell's own standard error.
	pub notice:  Option<BString>,
	/// The real shell would have run the command with `exec` and no fork:
	/// its process ends by the same signal.
	pub no_fork: bool,
}

/// [`Killed`] for the command of `op`, external process `pid`, that `sig`
/// killed in `vp`; `in_place` is what [`in_place`] said when it started.
pub(super) fn killed(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	op: Op,
	pid: u32,
	sig: Signal,
	in_place: bool,
) -> Killed {
	let quiet = Killed { notice: None, no_fork: false };
	if in_place {
		return Killed { notice: None, no_fork: true };
	}
	if nested::in_subshell(cx.store, vp)
		|| misc_is(cx, vp, MiscKey::Interactive, b"1")
		|| vp.frames.iter().any(|f| f.kind == FrameKind::Stage)
	{
		return quiet;
	}
	let c_string = misc_is(cx, vp, MiscKey::RunOrigin, b"c");
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	if vp.mode.dialect() != Dialect::Bash
		|| (c_string && posix)
		|| matches!(sig, Signal::Int | Signal::Pipe)
	{
		return quiet;
	}
	let desc = sig.description(k.engine.config().platform);
	if sig == Signal::Term || trapped(cx, vp, sig) {
		return Killed { notice: Some(BString::from(format!("{desc}\n"))), no_fork: false };
	}
	let Some(unit) = vp.frames.last().and_then(|f| f.unit.clone()) else {
		return quiet;
	};
	let text = command_text(k, cx, vp, &unit, op);
	// C's `%*s` with a negative width pads to its absolute value.
	let pad = (24 - i64::try_from(desc.len()).unwrap_or(24)).unsigned_abs();
	let msg = format!("{pid:>5} {desc}{:w$}", "", w = usize::try_from(pad).unwrap_or(0));
	let line = wait_line(vp, op.node);
	let diag = Diag::Warning { msg: msg.into() };
	let mut bytes = k.render_quiet(cx, vp, line, &diag);
	// The command text goes in as bytes: a diagnostic's text is UTF-8. The
	// `Diag` event carries the whole notice, the command too.
	if bytes.last() == Some(&b'\n') {
		bytes.pop();
	}
	bytes.extend_from_slice(&text);
	bytes.push(b'\n');
	k.diag_event(cx, vp, &diag, &text);
	Killed { notice: Some(BString::from(bytes)), no_fork: false }
}

/// Whether the real shell runs the command of `op`, an external `vp`
/// starts, in place of itself: the last command of a `-c` string, which it
/// runs with `exec` and no fork ([`no_fork`]), outside a pipeline stage and
/// an interactive shell, and outside a subshell but one the root runs in
/// place of itself ([`super::proc::VprocZsh::in_place`]: zsh's last `( … )`,
/// whose `op` is its `Spawn`). The real shell's process is then the command: a
/// signal sent to the shell is the command's, and the shell ends as the command
/// does.
pub(super) fn in_place(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
	!vp.frames.iter().any(|f| f.kind == FrameKind::Stage)
		&& no_fork(k, cx, vp, op)
		&& misc_is(cx, vp, MiscKey::RunOrigin, b"c")
		&& !misc_is(cx, vp, MiscKey::Interactive, b"1")
		&& (vp.in_place() || !nested::in_subshell(cx.store, vp))
}

/// Whether the misc record `key` of `vp` is `value`.
fn misc_is(cx: &mut Cx<'_>, vp: &Vproc, key: MiscKey, value: &[u8]) -> bool {
	matches!(
		state::record(cx.store, vp, Key::Misc(key)),
		Ok(Some(Record::Misc(v))) if v.as_slice() == value
	)
}

/// bash `signal_is_trapped`: a trap is set for `sig`, `trap '' SIG` too, and
/// the signal was not ignored when the shell started (bash keeps such a
/// signal ignored and sets no trap for it).
fn trapped(cx: &mut Cx<'_>, vp: &Vproc, sig: Signal) -> bool {
	matches!(
		state::record(cx.store, vp, Key::Trap(TrapKey::Signal(sig))),
		Ok(Some(Record::Trap { .. }))
	) && !cx.host.ignored_signals().contains(sig)
}

/// Whether the real shell runs the command of `op` with `exec` and no fork:
/// it is the last of the `-c` string (nothing is left to parse), run at its
/// top level (no function, `eval`, `source` or trap) or at the top of a
/// subshell the root runs in place ([`super::proc::VprocZsh::in_place`]), as
/// the last command of the complete command, while no trap that counts is set
/// ([`counts_a_trap`]), as the parse tree records ([`Unit::tails`]). bash
/// (`evalstring.c` `should_suppress_fork`, `can_optimize_connection`) wants
/// a simple command with no redirection that ends the complete command;
/// zsh takes one, and passes `last1` into compound commands, into a `for`
/// body only on the loop's last word (`execfor`: `do_exec && args &&
/// empty(args)`).
fn no_fork(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
	let Some(f) = vp.frames.last() else {
		return false;
	};
	let Some(u) = f.unit.as_ref() else {
		return false;
	};
	let bash = vp.mode.dialect() == Dialect::Bash;
	let at_end = match &f.kind {
		FrameKind::Script { src, pos, aux, what: ScriptKind::Run, stdin: false } => {
			(pos.0 as usize) >= src.len() && aux.as_ref().is_none_or(|a| a.pending.is_none())
		},
		FrameKind::Subshell => !bash && vp.in_place() && vp.frames.len() == 1,
		_ => false,
	};
	let last = u.tails.binary_search(&op.node).is_ok()
		&& if bash {
			u.cmds
				.get(op.a as usize)
				.is_some_and(|cmd| cmd.redirs.is_none())
		} else {
			f.loops.iter().all(zsh_last_pass)
		};
	at_end && last && !counts_a_trap(k, cx, vp, bash).unwrap_or(true)
}

/// Whether loop record `rec`, around a command zsh may run in place
/// ([`Unit::tails`]), passes `last1` on: a `for` on its last word (its
/// variables took the last), and a `try`'s always-list. A tail is only ever
/// in those.
const fn zsh_last_pass(rec: &LoopRec) -> bool {
	match &rec.kind {
		LoopKind::For { items, next, .. } | LoopKind::ForMulti { items, next, .. } => {
			*next as usize >= items.len()
		},
		LoopKind::Try { .. } => true,
		LoopKind::While | LoopKind::Select { .. } | LoopKind::Repeat { .. } => false,
	}
}

/// Whether a trap is set that makes the real shell fork its last command.
/// bash: an EXIT or ERR trap, or a signal trap that is not ignored (`trap
/// '' SIG`). zsh (`nsigtrapped`, which `settrap` counts): a trap with an
/// action (`trap '' SIG` is `ZSIG_IGNORED`, not counted) or a trap function
/// (`TRAPNAL`, `ZSIG_FUNC`), of a signal, `EXIT`, `ZERR` or `DEBUG`.
fn counts_a_trap(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, bash: bool) -> Result<bool, StoreError> {
	let traps = state::listed_traps(&k.root, cx.store, vp)?;
	let counted = traps.iter().any(|(key, rec)| match (key, rec) {
		(KeyBuf::Trap(TrapKey::Exit | TrapKey::Err), _) if bash => true,
		(KeyBuf::Trap(TrapKey::Signal(_)), Record::Trap { action, .. }) if bash => !action.is_empty(),
		(KeyBuf::Trap(_), Record::Trap { action, .. }) if !bash => !action.is_empty(),
		_ => false,
	});
	if counted || bash {
		return Ok(counted);
	}
	let platform = k.engine.config().platform;
	let keys = [TrapKey::Exit, TrapKey::Err, TrapKey::Debug]
		.into_iter()
		.chain(Signal::iter().map(TrapKey::Signal));
	for key in keys {
		if trap::find_func_trap(cx.store, vp, key, platform, |_, _| ())?.is_some() {
			return Ok(true);
		}
	}
	Ok(false)
}

/// bash's `line_number` when it waits for the command
/// (`execute_command_internal` puts it back before `wait_for`): the header line
/// of the innermost `for`, `select`, `case` or arithmetic `for` around it;
/// else, in a function, the line its body starts on; else the line the parser
/// reached reading the complete command (its last line, after any here-document
/// bodies).
fn wait_line(vp: &Vproc, node: u32) -> u32 {
	let Some(fi) = vp.frames.len().checked_sub(1) else {
		return 0;
	};
	let f = &vp.frames[fi];
	let Some(u) = f.unit.as_ref() else {
		return exec::line_of(vp, node);
	};
	if let Some(header) = header_around(u, node) {
		return exec::line_in(vp, fi, header);
	}
	match &f.kind {
		FrameKind::Function { .. } => body_start(u)
			.map_or_else(|| u.line.saturating_sub(f.line_shift), |body| exec::line_in(vp, fi, body)),
		FrameKind::Script { src, pos, .. } => {
			// The parser's line is that of the next byte; the newline that
			// ended the command (a virtual one at the end of the input)
			// still counts as its line.
			let at = pos.0 as usize;
			let ended_line = at >= src.len() || (at > 0 && src.get(at - 1) == Some(&b'\n'));
			(pos.1 - u32::from(ended_line)).saturating_sub(f.line_shift)
		},
		_ => exec::line_of(vp, node),
	}
}

/// The node of a function's body: bash's `function_line_number` is the
/// line of the compound command after `name ()`.
fn body_start(u: &Unit) -> Option<u32> {
	u.nodes
		.iter()
		.enumerate()
		.filter(|(_, m)| {
			!matches!(
				m.kind,
				NodeKind::FuncDef
					| NodeKind::Word
					| NodeKind::AndOr
					| NodeKind::Pipeline
					| NodeKind::Assign
			)
		})
		.min_by_key(|(_, m)| m.lo)
		.and_then(|(i, _)| u32::try_from(i).ok())
}

/// The innermost `for`, `select`, `case` or arithmetic `for` of `u` around
/// `node`.
fn header_around(u: &Unit, node: u32) -> Option<u32> {
	let n = u.nodes.get(node as usize)?;
	u.nodes
		.iter()
		.enumerate()
		.filter(|(_, m)| {
			matches!(m.kind, NodeKind::For | NodeKind::Select | NodeKind::Case | NodeKind::ArithFor)
				&& m.lo <= n.lo
				&& n.hi <= m.hi
		})
		.max_by_key(|(_, m)| m.lo)
		.and_then(|(i, _)| u32::try_from(i).ok())
}

/// The command as bash prints it in the notice, here-document bodies
/// included. The node's text holds none (they follow its line), so
/// [`exec::job_text`] prints each document empty: its delimiter lines end
/// the text, and the bodies the IR keeps go before them.
fn command_text(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, u: &Unit, op: Op) -> Vec<u8> {
	let printed = exec::job_text(k, cx, vp, u, op.node);
	let bodies: Vec<&[u8]> = u
		.cmds
		.get(op.a as usize)
		.and_then(|c| c.redirs)
		.and_then(|i| u.redirs.get(i as usize))
		.map_or_else(Vec::new, |rs| {
			rs.iter()
				.filter_map(|r| match &r.target {
					RedirTargetIr::HereDoc { text, .. } => Some(text.as_slice()),
					RedirTargetIr::Word(_) => None,
				})
				.collect()
		});
	let lines: Vec<&[u8]> = printed.split_inclusive(|&b| b == b'\n').collect();
	if bodies.is_empty() || lines.len() <= bodies.len() {
		return printed.into();
	}
	let (head, delims) = lines.split_at(lines.len() - bodies.len());
	let mut out = head.concat();
	for (body, delim) in bodies.iter().zip(delims) {
		out.extend_from_slice(body);
		out.extend_from_slice(delim);
	}
	out
}
