//! `set -x` (xtrace): bash's trace of each command after expansion, one
//! line per command on `BASH_XTRACEFD` (else stderr), after `PS4` with
//! its first character repeated once per nesting level.

use bstr::BString;

use super::{
	Cx, Kernel, TextKind,
	builtins::zsh_quote::{Charset, quotedzputs},
	expand::{Expander, Stop},
	locale,
	proc::{AssignValue, FrameKind, PendingWrite, Saved, ScriptKind, Slot, Vproc},
	quote, state,
};
use crate::bash::{diag::Diag, store::OptId, zshopt::ZshOpt};

/// bash's `indirection_level` in `vp`: 1 at the top, one more per `eval`,
/// `.` file, trap action and `${ ;}` / `${| ;}` running (each a
/// `parse_and_execute`), plus the level the vproc started at
/// ([`Vproc::trace_base`]: its parent's, and one more in a command
/// substitution). An EXIT trap runs once the commands it ends have unwound
/// (bash's `exit_shell`): the frames still below its own here do not count,
/// and in the shell itself and in a command substitution, whose commands
/// bash runs in a `parse_and_execute` that has returned by then
/// ([`TRACE_SUB`]), it is one level less than its frame makes it: the
/// shell's at the top level, a substitution's at its commands' level, a
/// subshell's one below its commands.
pub fn level(vp: &Vproc) -> u32 {
	let base = vp.trace_base & !TRACE_SUB;
	let sub = vp.trace_base & TRACE_SUB != 0;
	let counts = |f: &&super::proc::Frame| {
		matches!(
			f.kind,
			FrameKind::NoFork
				| FrameKind::Script {
					what: ScriptKind::Eval | ScriptKind::Source | ScriptKind::Trap { .. },
					..
				}
		)
	};
	let exit_trap = |f: &super::proc::Frame| {
		matches!(f.kind, FrameKind::Script {
			what: ScriptKind::Trap { key: crate::bash::store::TrapKey::Exit, .. },
			..
		})
	};
	let (from, left) = match vp.frames.iter().rposition(exit_trap) {
		Some(i) => (i, u32::from(vp.parent.is_none() || sub)),
		None => (0, 0),
	};
	let nested = vp.frames[from..].iter().filter(counts).count();
	1u32
		.saturating_add(base)
		.saturating_add(u32::try_from(nested).unwrap_or(u32::MAX))
		.saturating_sub(left)
}

/// The bit of [`Vproc::trace_base`] that marks a command substitution's
/// child whose base counts the substitution's own level (bash's
/// `parse_and_execute` of its text): its EXIT trap, which bash runs after
/// that has returned, does not ([`level`]). A bit of the level, not a
/// field: the vproc has no room for one (idle vproc ≤ 2 KiB), and no level
/// comes near it.
pub const TRACE_SUB: u32 = 1 << 31;

/// Whether `set -x` is on.
#[inline]
pub fn on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	// The call the line editor makes of a hook or widget function is not
	// a command line (zsh calls the function directly): never traced.
	if matches!(
		vp.frames.last().map(|f| &f.kind),
		Some(FrameKind::Script { what: ScriptKind::Hook, .. })
	) {
		return false;
	}
	state::option(&mut k.root, cx.store, vp, OptId::Xtrace).unwrap_or(false)
}

/// Whether words are quoted for a UTF-8 locale.
pub fn utf8(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	locale::is_utf8(k, cx.store, vp)
}

/// Append `w` as bash's `xtrace_print_word_list` shows a word: `''` when
/// empty, `$'…'` with control or unprintable characters, single quotes
/// with shell metacharacters, else as it is.
pub fn push_word(out: &mut Vec<u8>, w: &[u8], utf8: bool) {
	if w.is_empty() {
		out.extend_from_slice(b"''");
	} else {
		out.extend_from_slice(&quote::printable_filename(w, utf8, true));
	}
}

/// Append the words of a command, space-separated.
pub fn push_words<W: AsRef<[u8]>>(out: &mut Vec<u8>, words: &[W], utf8: bool) {
	for (i, w) in words.iter().enumerate() {
		if i > 0 {
			out.push(b' ');
		}
		push_word(out, w.as_ref(), utf8);
	}
}

/// Append an assignment as bash's `xtrace_print_assignment` shows it:
/// `name[index]+=value`, the value quoted like a word but empty as
/// nothing; a compound value as `(…)` of its elements.
pub fn push_assign(
	out: &mut Vec<u8>,
	name: &[u8],
	index: Option<&[u8]>,
	append: bool,
	value: &AssignValue,
	utf8: bool,
) {
	out.extend_from_slice(name);
	if let Some(index) = index {
		out.push(b'[');
		out.extend_from_slice(index);
		out.push(b']');
	}
	out.extend_from_slice(if append { b"+=" } else { b"=" });
	match value {
		AssignValue::Scalar(v) if v.is_empty() => {},
		AssignValue::Scalar(v) => out.extend_from_slice(&quote::printable_filename(v, utf8, true)),
		AssignValue::Array(items) => {
			out.push(b'(');
			for (i, (key, plus, v)) in items.iter().enumerate() {
				if i > 0 {
					out.push(b' ');
				}
				if let Some(key) = key {
					out.push(b'[');
					out.extend_from_slice(key);
					out.extend_from_slice(if *plus { b"]+=" } else { b"]=" });
					out.extend_from_slice(&quote::printable_filename(v, utf8, true));
				} else {
					push_word(out, v, utf8);
				}
			}
			out.push(b')');
		},
	}
}

/// The body of one `[[ … ]]` primary's trace line as bash's
/// `xtrace_print_cond_term` writes it: `[[ op arg ]]`, `[[ lhs op rhs ]]`
/// (a lone word as `-n word`), each expanded term as it is, an empty one
/// as `''`. The caller queues it through [`Expander::trace_once`] inside
/// the primary's recorded pass, so a file-test probe that re-enters the op
/// does not trace it again.
pub fn cond_body(terms: &[&[u8]]) -> Vec<u8> {
	let mut body = b"[[".to_vec();
	for t in terms {
		body.push(b' ');
		if t.is_empty() {
			body.extend_from_slice(b"''");
		} else {
			body.extend_from_slice(t);
		}
	}
	body.extend_from_slice(b" ]]");
	body
}

/// A bash trace line's prefix ([`ps4_in`], [`prefixes`]): `PS4` expanded,
/// or as it is written when its expansion failed, and that error (with the
/// line it is reported at), which bash prints before the trace line.
#[derive(Default)]
pub struct Prefix {
	pub text:  Vec<u8>,
	pub error: Option<(u32, Diag)>,
}

/// Queue one trace line: `prefix` (the expanded `PS4`: [`prefixes`],
/// [`ps4_in`]; the error its expansion met first), `body`, a newline. It
/// goes out with the shell's other diagnostics, before the command's
/// redirections.
pub fn line_out(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, prefix: Prefix, body: &[u8]) {
	let Prefix { mut text, error } = prefix;
	if let Some((line, d)) = error {
		k.diag(cx, vp, line, d);
	}
	text.extend_from_slice(body);
	text.push(b'\n');
	write(k, cx, vp, text);
}

/// A trace line a builtin writes as it runs (bash's `export` and
/// `readonly` trace each `name=value` operand as they assign it): the
/// descriptor it goes to, as the builtin's redirections left them, and
/// `prefix` (the expanded `PS4`, a builtin's
/// [`Ctx::trace_prefixes`](super::builtins::Ctx::trace_prefixes)),
/// `body`, a newline. The caller queues the two with `Ctx::trace_line`,
/// which marks the write a trace: a failed write of it is dropped, as
/// bash's unchecked `fprintf` to the trace stream drops it
/// (`print_cmd.c` `xtrace_print_assignment`), not reported as the
/// builtin's own write error.
pub fn builtin_line(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	mut prefix: Vec<u8>,
	body: &[u8],
) -> (i32, Vec<u8>) {
	prefix.extend_from_slice(body);
	prefix.push(b'\n');
	(trace_fd(k, cx, vp), prefix)
}

/// Queue `bytes` (a whole trace line, or zsh's pieces of one) for the
/// trace output.
pub fn write(k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, bytes: Vec<u8>) {
	let fd = trace_fd(k, cx, vp);
	vp.out
		.push_back(PendingWrite::new(fd, BString::from(bytes)));
}

/// The trace prefix for a command on `line`: `PS4` expanded (zsh
/// `printprompt4`), as far as it needs no command to run.
pub fn ps4(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Vec<u8> {
	prefix(k, cx, vp, line)
}

/// Whether a bash trace prefix may need a command to run first: `set -x`
/// on and a `PS4` with a substitution in it (`$( )`, a backquote, `${ ;}`,
/// `${| ;}`; any `$` counts, as the expansion is what tells). An op that
/// traces records its expansion then ([`super::exec::expanding`]'s
/// `record`), so that a substitution started for `PS4` replays.
pub fn ps4_parks(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	ps4_has(k, cx, vp, |s| s.iter().any(|&c| matches!(c, b'$' | b'`')))
}

/// Whether `PS4` may run a command when it expands (bash, `set -x` on):
/// its text has a `$( )` (not `$(( ))`), a backquote, a `${ ;}` or a
/// `${| ;}`, or a `${…@P}` transform, which expands a value as a prompt and
/// runs the substitutions in that value. Those are every way this engine's
/// expansion of `PS4` runs a command, so a `PS4` this says no to expands
/// without parking.
pub fn ps4_runs_commands(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	ps4_has(k, cx, vp, |s| {
		s.iter().enumerate().any(|(i, &c)| {
			c == b'`'
				|| (c == b'$'
					&& match s.get(i + 1) {
						Some(b'(') => s.get(i + 2) != Some(&b'('),
						Some(b'{') => matches!(s.get(i + 2), Some(b' ' | b'\t' | b'\n' | b'|')),
						_ => false,
					})
				|| (c == b'@' && s.get(i + 1) == Some(&b'P') && s.get(i + 2) == Some(&b'}'))
		})
	})
}

/// Whether bash's `set -x` is on in `vp` with a `PS4` whose text `test`
/// accepts.
fn ps4_has(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, test: impl FnOnce(&[u8]) -> bool) -> bool {
	vp.mode.dialect() != crate::bash::ids::Dialect::Zsh
		&& on(k, cx, vp)
		&& state::lookup(&k.root, cx.store, vp, b"PS4")
			.ok()
			.flatten()
			.and_then(|v| v.as_scalar().map(test))
			.unwrap_or(false)
}

/// The trace prefix for a command on `line` inside the op's expansion `ex`
/// (bash `indirection_level_string`): `PS4` expanded as a prompt, its
/// command substitutions run with `set -x` off (a stop to park on,
/// replayed when the op runs again: one per call, so each trace line runs
/// its own), its first character repeated to the nesting [`level`]. An
/// expansion error leaves `PS4` as it is written, the error kept to be
/// printed before the line. zsh: [`ps4`].
pub fn ps4_in(ex: &mut Expander<'_, '_>, line: u32) -> Result<Prefix, Stop> {
	if ex.vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return Ok(Prefix { text: prefix(ex.k, ex.cx, ex.vp, line), error: None });
	}
	let ps4 = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"PS4")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	if ps4.is_empty() {
		return Ok(Prefix::default());
	}
	let mut error = None;
	let expanded = if ps4.iter().any(|c| matches!(c, b'$' | b'`' | b'\\')) {
		let mode = super::exec::mode_of(ex.vp);
		let observed = ex
			.k
			.mask
			.contains(crate::bash::event::EventKind::UnitCompiled);
		match ex
			.k
			.engine
			.text_unit(b"${PS4@P}", TextKind::HereDoc, mode, observed)
		{
			Ok(tunit) => match tunit.words.last().cloned() {
				Some(w) => match ex.scalar(&tunit, &w) {
					Ok(v) => v,
					Err(Stop::Sub { unit, entry, form, text, .. }) => {
						return Err(Stop::Sub { unit, entry, form, text, untraced: true });
					},
					Err(
						stop @ (Stop::ZshSub { .. } | Stop::MathCall(_) | Stop::Probe(_) | Stop::Wait(_)),
					) => return Err(stop),
					Err(Stop::Fail(d) | Stop::Fatal(d)) => {
						error = Some((line, d));
						ps4
					},
					Err(Stop::Store(err)) => {
						ex.k.fail(err);
						ps4
					},
				},
				None => ps4,
			},
			Err(_) => ps4,
		}
	} else {
		ps4
	};
	Ok(Prefix { text: repeated(ex.k, ex.cx, ex.vp, &expanded), error })
}

/// The prefixes of `n` trace lines of the current op (bash), each `PS4`
/// expanded by itself ([`ps4_in`]), in one expansion of the op's
/// [`Slot::Builtin`] log, which is free while the op traces and is emptied
/// once they are all made; the flow to park on while a substitution runs.
pub fn prefixes(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	n: usize,
) -> Result<Vec<Prefix>, super::exec::Flow> {
	if !ps4_parks(k, cx, vp) {
		return Ok((0..n)
			.map(|_| Prefix { text: prefix(k, cx, vp, line), error: None })
			.collect());
	}
	let made = super::exec::expanding(k, vp, cx, Slot::Builtin, true, line, |ex| {
		(0..n)
			.map(|_| ps4_in(ex, line))
			.collect::<Result<Vec<_>, _>>()
	})?;
	super::exec::scratch(vp).logs[Slot::Builtin as usize].clear();
	Ok(made)
}

/// zsh's quoting of traced words: `quotedzputs` under the shell's
/// `RC_QUOTES`, `MULTIBYTE` (in a UTF-8 locale) and `PRINT_EIGHT_BIT`.
#[derive(Clone, Copy)]
pub struct ZshQuote {
	rc: bool,
	cs: Charset,
}

impl ZshQuote {
	/// The settings in effect in `vp`.
	pub fn of(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Self {
		let mut opt = |o| state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or(false);
		let (rc, mb, eight) =
			(opt(ZshOpt::Rcquotes), opt(ZshOpt::Multibyte), opt(ZshOpt::Printeightbit));
		let utf8 = mb && locale::is_utf8(k, cx.store, vp);
		let (bang, bang_special) =
			crate::bash::vm::zsh::params::bang_quoting(&mut k.root, cx.store, vp);
		Self { rc, cs: Charset { utf8, print_eight: eight, bang, bang_special } }
	}

	/// Append `w` quoted.
	pub fn push(self, out: &mut Vec<u8>, w: &[u8]) {
		out.extend_from_slice(&quotedzputs(w, self.rc, self.cs));
	}
}

/// zsh `quote_tokenized_output`: a pattern operand of `[[ = ]]` as the
/// trace shows it, its active tokens as their characters, other pattern
/// characters (and a leading `=`) backslash-quoted, tab, newline and
/// carriage return as `$'…'`.
pub fn quote_tokenized(s: &[u8]) -> Vec<u8> {
	use crate::bash::syntax::zsh::tok::{META, NULARG, is_tok, tok_char};
	let mut out = Vec::with_capacity(s.len() + 4);
	let mut i = 0;
	while let Some(&c) = s.get(i) {
		i += 1;
		match c {
			META => {
				if let Some(&d) = s.get(i) {
					out.push(d ^ 32);
					i += 1;
				}
				continue;
			},
			NULARG => continue,
			b'\\' | b'<' | b'>' | b'(' | b'|' | b')' | b'^' | b'#' | b'~' | b'[' | b']' | b'*'
			| b'?' | b'$' | b' ' => out.push(b'\\'),
			b'\t' => {
				out.extend_from_slice(b"$'\\t'");
				continue;
			},
			b'\n' => {
				out.extend_from_slice(b"$'\\n'");
				continue;
			},
			b'\r' => {
				out.extend_from_slice(b"$'\\r'");
				continue;
			},
			b'=' if i == 1 => out.push(b'\\'),
			_ if is_tok(c) => {
				if let Some(t) = tok_char(c) {
					out.push(t);
				}
				continue;
			},
			_ => {},
		}
		out.push(c);
	}
	out
}

/// Where trace output goes. bash: `BASH_XTRACEFD` when it names an open
/// descriptor, else 2. zsh ([`zsh_trace_fd`]): the standard error the
/// command running a `.`/`eval` had before its redirections.
fn trace_fd(k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> i32 {
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_trace_fd(vp);
	}
	state::lookup(&k.root, cx.store, vp, b"BASH_XTRACEFD")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar())
		.and_then(|s| std::str::from_utf8(s).ok()?.parse::<i32>().ok())
		.filter(|&fd| fd >= 0 && vp.fds.get(fd).is_some_and(|h| h.is_open()))
		.unwrap_or(2)
}

/// zsh's `xtrerr`: a simple command run with redirections keeps a copy of
/// the standard error it had before them for the trace of what it runs
/// (`.`, `eval`), the outermost such command since the innermost function
/// call (`execshfunc` resets it to the standard error). The copy is put at
/// a free descriptor ≥ 10 (zsh `movefd`, `FDT_XTRACE`), closed with the
/// command's own redirections.
fn zsh_trace_fd(vp: &mut Vproc) -> i32 {
	let mut found = None;
	for i in (0..vp.frames.len().saturating_sub(1)).rev() {
		if matches!(vp.frames[i + 1].kind, FrameKind::Function { .. }) {
			break;
		}
		let saves_stderr = vp.frames[i]
			.scratch
			.as_ref()
			.and_then(|sc| sc.io.as_ref())
			.is_some_and(|io| io.saved.iter().any(|s| s.fd == 2));
		if saves_stderr {
			found = Some(i);
		}
	}
	let Some(io) = found.and_then(|i| vp.frames[i].scratch.as_mut()?.io.as_mut()) else {
		return 2;
	};
	// Closed before the redirections: the trace goes nowhere.
	let Some(prev) = io
		.saved
		.iter()
		.find(|s| s.fd == 2)
		.and_then(|s| s.prev.clone())
	else {
		return -1;
	};
	if let Some(s) = io
		.saved
		.iter()
		.find(|s| s.fd >= 10 && s.prev.is_none() && vp.fds.get(s.fd).is_some_and(|h| h.same(&prev)))
	{
		return s.fd;
	}
	let fd = vp.fds.lowest_free(10);
	vp.fds.set(fd, Some(prev));
	io.saved.push(Saved { fd, prev: None });
	fd
}

/// `PS4` expanded as a prompt (`${PS4@P}`; as it is when the expansion
/// would need a command substitution: [`ps4_in`] runs them), its first
/// character repeated to the nesting [`level`] ([`repeated`]). Unset or
/// empty: no prefix.
fn prefix(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Vec<u8> {
	let ps4 = state::lookup(&k.root, cx.store, vp, b"PS4")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	if ps4.is_empty() {
		return Vec::new();
	}
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_prefix(k, cx, vp, line, &ps4).unwrap_or_else(|| ps4.to_vec());
	}
	let expanded = if ps4.iter().any(|c| matches!(c, b'$' | b'`' | b'\\')) {
		expand_ps4(k, cx, vp, line).unwrap_or(ps4)
	} else {
		ps4
	};
	repeated(k, cx, vp, &expanded)
}

/// `expanded` (`PS4`) after its first character (as many bytes as the
/// locale's `mblen` makes it, as bash's `indirection_level_string` takes
/// it) repeated to the nesting [`level`] less one.
fn repeated(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, expanded: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(expanded.len() + 4);
	let level = level(vp);
	if level > 1 && !expanded.is_empty() {
		let cs = locale::charset(k, cx.store, vp);
		let first = &expanded[..locale::char_len(cs, expanded, false).unwrap_or(1)];
		for _ in 1..level {
			out.extend_from_slice(first);
		}
	}
	out.extend_from_slice(expanded);
	out
}

/// zsh's trace prefix: `PS4` through `promptexpand` (`%N`, `%i`, …; its
/// substitutions too with `PROMPT_SUBST`), not repeated per level. `None`
/// when the state cannot be read or a substitution would need to run a
/// command.
fn zsh_prefix(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	ps4: &[u8],
) -> Option<Vec<u8>> {
	use crate::bash::{vm::builtins::zsh_print, zshopt::ZshOpt};
	let mut opt = |o| state::zsh_option(&mut k.root, cx.store, vp, o).ok();
	let (percent, bang, subst) =
		(opt(ZshOpt::Promptpercent)?, opt(ZshOpt::Promptbang)?, opt(ZshOpt::Promptsubst)?);
	let stack = zsh_cmdstack(vp);
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	zsh_print::expand_prompt_in(&mut ex, ps4, Some((percent, bang, subst)), false, stack).ok()
}

/// zsh's command stack while the top frame runs (`cmdpush` in `execif`,
/// `execwhile`, `execfor`, `execrepeat`, `execselect`, `execcase`,
/// `execcursh`, `exectry`), outermost first, for `%_` in `PS4`: from the
/// compound commands the frame is in ([`super::proc::Frame::enters`]); an `if`
/// is `if`/`elif` in a condition, `then`/`elif-then` in a branch, `else` after
/// them.
fn zsh_cmdstack(vp: &Vproc) -> Vec<&'static str> {
	use crate::bash::{
		event::{Construct, NodeKind},
		ir::Opcode,
		syntax::zsh::{
			CS_ALWAYS, CS_CASE, CS_CURSH, CS_ELIF, CS_ELIFTHEN, CS_ELSE, CS_FOR, CS_IF, CS_IFTHEN,
			CS_REPEAT, CS_SELECT, CS_UNTIL, CS_WHILE, cmdname,
		},
	};
	let Some(f) = vp.frames.last() else {
		return Vec::new();
	};
	let Some(unit) = f.unit.as_ref() else {
		return Vec::new();
	};
	let pc = f.pc;
	let ops_of = |node: u32| {
		unit
			.ops
			.iter()
			.enumerate()
			.filter(move |(_, op)| op.node == node)
	};
	let mut out = Vec::with_capacity(f.enters.len());
	for &(node, _) in &f.enters {
		let Some(kind) = unit.nodes.get(node as usize).map(|n| n.kind) else {
			continue;
		};
		let cs = match kind {
			NodeKind::If => {
				let mut cs = CS_ELSE;
				for (at, op) in ops_of(node) {
					let arm = match (op.code, Construct::from_u32(op.b)) {
						(Opcode::BrFail, Construct::If) => (CS_IF, CS_IFTHEN),
						(Opcode::BrFail, Construct::Elif) => (CS_ELIF, CS_ELIFTHEN),
						_ => continue,
					};
					if pc < at as u32 {
						cs = arm.0;
						break;
					}
					if pc < op.a {
						cs = arm.1;
						break;
					}
				}
				cs
			},
			NodeKind::While if ops_of(node).any(|(_, op)| op.code == Opcode::Repeat) => CS_REPEAT,
			NodeKind::While => CS_WHILE,
			NodeKind::Until => CS_UNTIL,
			NodeKind::For | NodeKind::ArithFor => CS_FOR,
			NodeKind::Select => CS_SELECT,
			NodeKind::Case => CS_CASE,
			NodeKind::Brace => match ops_of(node).find(|(_, op)| op.code == Opcode::AlwaysEnter) {
				Some((at, _)) if pc >= at as u32 => CS_ALWAYS,
				_ => CS_CURSH,
			},
			// `[[ ]]` and `(( ))` trace their line before they push `cond`
			// and `math`, and run nothing else traced in this frame.
			_ => continue,
		};
		out.push(cmdname(cs));
	}
	out
}

fn expand_ps4(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<BString> {
	let mode = super::exec::mode_of(vp);
	let tunit = k
		.engine
		.text_unit(
			b"${PS4@P}",
			TextKind::HereDoc,
			mode,
			k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
		)
		.ok()?;
	let w = tunit.words.last().cloned()?;
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	ex.scalar(&tunit, &w).ok()
}
