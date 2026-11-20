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
	proc::{FrameKind, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	diag::Diag,
	event::NodeKind,
	ids::Dialect,
	ir::{NodeInfo, Op, RedirTargetIr, Unit},
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
/// runs with `exec` and no fork ([`no_fork`]), outside a subshell, a
/// pipeline stage and an interactive shell. The real shell's process is
/// then the command: a signal sent to the shell is the command's, and the
/// shell ends as the command does.
pub(super) fn in_place(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
	!vp.frames.iter().any(|f| f.kind == FrameKind::Stage)
		&& no_fork(k, cx, vp, op)
		&& misc_is(cx, vp, MiscKey::RunOrigin, b"c")
		&& !misc_is(cx, vp, MiscKey::Interactive, b"1")
		&& !nested::in_subshell(cx.store, vp)
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

/// Whether the real shell runs the command with `exec` and no fork: it is
/// the last of the `-c` string (nothing is left to parse), run at its top
/// level (no function, `eval`, `source` or trap), as the last command of
/// the complete command ([`last_of_chain`]), while no trap that counts is
/// set ([`counts_a_trap`]). bash (`evalstring.c` `should_suppress_fork`,
/// `can_optimize_connection`) also wants no redirection; zsh (`exec.c`
/// `execcmd_exec`) takes one.
fn no_fork(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
	let Some(f) = vp.frames.last() else {
		return false;
	};
	let (FrameKind::Script { src, pos, aux, what: ScriptKind::Run, stdin: false }, Some(u)) =
		(&f.kind, f.unit.as_ref())
	else {
		return false;
	};
	if (pos.0 as usize) < src.len() || aux.as_ref().is_some_and(|a| a.pending.is_some()) {
		return false;
	}
	let Some(cmd) = u.cmds.get(op.a as usize) else {
		return false;
	};
	let bash = vp.mode.dialect() == Dialect::Bash;
	if (bash && cmd.redirs.is_some()) || !last_of_chain(u, op.node, bash) {
		return false;
	}
	!counts_a_trap(k, cx, vp, bash).unwrap_or(true)
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

/// Whether simple command `node` of the complete command `u` is the last
/// command the real shell runs: a pipeline of its own (no `!`, `time` or
/// second stage) that ends its and-or list, itself the last of its list.
/// bash: the complete command's own list, after a top-level `;` only alone
/// ([`top_level_last`]). zsh passes `last1` on into the body of an `if`, a
/// `{ }` and a `;;` arm of a `case` that is itself the last command
/// (`execif`, `execcursh`, `execcase`; [`ends_body`]).
fn last_of_chain(u: &Unit, node: u32, bash: bool) -> bool {
	let Some(n) = u.nodes.get(node as usize) else {
		return false;
	};
	let mut span = (n.lo, n.hi);
	loop {
		let around = |kind: NodeKind| {
			u.nodes
				.iter()
				.filter(|m| m.kind == kind && m.lo <= span.0 && span.1 <= m.hi)
				.min_by_key(|m| m.hi - m.lo)
		};
		let (Some(p), Some(ao)) = (around(NodeKind::Pipeline), around(NodeKind::AndOr)) else {
			return false;
		};
		if (p.lo, p.hi) != span || ao.hi != span.1 {
			return false;
		}
		// The compound command whose list holds the and-or list.
		let outer = u
			.nodes
			.iter()
			.filter(|m| {
				compound(m) && m.lo <= ao.lo && ao.hi <= m.hi && (m.lo, m.hi) != (ao.lo, ao.hi)
			})
			.min_by_key(|m| m.hi - m.lo);
		match outer {
			None => return top_level_last(u, ao, span, bash),
			Some(m) if !bash && ends_body(u, ao.hi, m) => span = (m.lo, m.hi),
			Some(_) => return false,
		}
	}
}

/// Whether `m` is a compound command (not a part of a simple one).
const fn compound(m: &NodeInfo) -> bool {
	!matches!(
		m.kind,
		NodeKind::AndOr | NodeKind::Pipeline | NodeKind::Simple | NodeKind::Assign | NodeKind::Word
	)
}

/// Whether the top-level and-or list `ao`, which the command spanning
/// `span` ends, is the last item of the complete command. After another
/// item, bash's tree is `connection(earlier, this, sep)`, optimized only
/// for `;` and a simple command as its second part; zsh's last list item
/// gets `last1` whatever comes before it.
fn top_level_last(u: &Unit, ao: &NodeInfo, span: (u32, u32), bash: bool) -> bool {
	if u
		.nodes
		.iter()
		.any(|m| m.kind == NodeKind::AndOr && m.lo >= ao.hi)
	{
		return false;
	}
	let earlier = u
		.nodes
		.iter()
		.filter(|m| m.kind == NodeKind::AndOr && m.hi <= ao.lo)
		.map(|m| m.hi)
		.max();
	match earlier {
		Some(end) if bash => {
			let sep = u
				.source
				.get(end as usize..ao.lo as usize)
				.unwrap_or_default();
			!sep.contains(&b'&') && (ao.lo, ao.hi) == span
		},
		_ => true,
	}
}

/// zsh: whether the list item ending at `from` is the last of the body of
/// compound command `m` that zsh runs with `last1`: what follows it, past
/// blanks, newlines, comments and a `;`, ends the body: the `}` of a `{ }`
/// (not a `{ } always { }`) or of an `if`'s short form; the `fi`, `else` or
/// `elif` of an `if` (a condition is followed by `then`); the `;;` or
/// `esac` of a `case` arm (`;&` and `;|` run on, so zsh forks).
fn ends_body(u: &Unit, from: u32, m: &NodeInfo) -> bool {
	let rest = skip_separators(
		u.source
			.get(from as usize..m.hi as usize)
			.unwrap_or_default(),
	);
	let word = |w: &[u8]| {
		rest.starts_with(w)
			&& !rest
				.get(w.len())
				.is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_')
	};
	match m.kind {
		NodeKind::Brace => {
			rest.starts_with(b"}") && !skip_separators(&rest[1..]).starts_with(b"always")
		},
		NodeKind::If => rest.starts_with(b"}") || word(b"fi") || word(b"else") || word(b"elif"),
		NodeKind::Case => rest.starts_with(b";;") || word(b"esac"),
		_ => false,
	}
}

/// `s` past blanks, newlines (escaped ones too), comments and `;`
/// separators; a `;;`, `;&` or `;|` stays.
fn skip_separators(mut s: &[u8]) -> &[u8] {
	loop {
		match s {
			[b' ' | b'\t' | b'\r' | b'\n', rest @ ..] | [b'\\', b'\n', rest @ ..] => s = rest,
			[b';', b';' | b'&' | b'|', ..] => return s,
			[b';', rest @ ..] => s = rest,
			[b'#', ..] => s = &s[s.iter().position(|&b| b == b'\n').unwrap_or(s.len())..],
			_ => return s,
		}
	}
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
