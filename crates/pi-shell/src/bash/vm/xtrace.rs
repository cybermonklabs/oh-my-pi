//! `set -x` (xtrace): bash's trace of each command after expansion, one
//! line per command on `BASH_XTRACEFD` (else stderr), after `PS4` with
//! its first character repeated once per nesting level.

use bstr::BString;

use super::{
	Cx, Kernel, TextKind, command,
	exec::{self, Flow},
	expand::{Expander, Stop},
	locale,
	proc::{
		AssignValue, Atom, FrameKind, PendingSub, PendingWrite, Scratch, ScriptKind, Slot, Vproc,
	},
	quote, state,
};
use crate::bash::{
	ir::ComsubForm,
	store::{KeyBuf, OptId, Record, StateStore},
};

/// Bash's trace indirection: one at the top, one per active eval, source,
/// trap or no-fork substitution, plus the inherited level of a forked
/// vproc. No-fork frames affect this count, not `$BASH_SUBSHELL`.
pub fn level(vp: &Vproc) -> u32 {
	let nested = vp
		.frames
		.iter()
		.filter(|f| {
			matches!(f.kind, FrameKind::NoFork | FrameKind::Script {
				what: ScriptKind::Eval | ScriptKind::Source | ScriptKind::Trap { .. },
				..
			})
		})
		.count();
	1u32
		.saturating_add(vp.trace_base)
		.saturating_add(u32::try_from(nested).unwrap_or(u32::MAX))
}

/// Whether `set -x` is on.
pub fn on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
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

/// Trace one `[[ … ]]` primary as bash's `xtrace_print_cond_term` does:
/// `[[ op arg ]]`, `[[ lhs op rhs ]]` (a lone word as `-n word`), each
/// expanded term as it is, an empty one as `''`.
pub fn cond(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, terms: &[&[u8]]) {
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
	emit(k, cx, vp, line, &body);
}

/// A trace line whose prompt may park on command substitutions. It belongs
/// to one frame depth, so a no-fork prompt substitution can run above it.
pub struct Pending {
	pub fd:           i32,
	pub body:         BString,
	pub ps4:          BString,
	pub line:         u32,
	pub depth:        usize,
	pub level:        u32,
	pub log:          Vec<Atom>,
	pub sub:          Option<PendingSub>,
	pub saved_xtrace: Option<bool>,
	/// A no-fork prompt body hid the command's temporary environment.
	pub restore_env:  bool,
	/// An assignment list inside a no-fork body clears Bash's temporary-
	/// environment lookup phase for the remainder of the outer prompt.
	pub resume_env:   bool,
	pub status:       i32,
}

/// Queue one trace line before the command's redirections. Literal prefixes
/// stay on the direct path; only a prompt expansion needs scheduler state.
pub fn emit(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, body: &[u8]) {
	let ps4 = state::lookup(&k.root, cx.store, vp, b"PS4")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	let fd = trace_fd(k, cx, vp);
	if vp.mode.dialect() == crate::bash::ids::Dialect::Bash
		&& ps4.iter().any(|c| matches!(c, b'$' | b'`' | b'\\'))
	{
		let body = BString::from(body);
		vp.traces.push_back(Pending {
			fd,
			body,
			ps4,
			line,
			depth: vp.frames.len(),
			level: level(vp),
			log: Vec::new(),
			sub: None,
			saved_xtrace: None,
			restore_env: false,
			resume_env: true,
			status: vp.status,
		});
		return;
	}
	let prefix = if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		zsh_prefix(k, cx, vp, line, &ps4).unwrap_or_else(|| ps4.to_vec())
	} else {
		repeated(&ps4, level(vp))
	};
	let bytes = trace_line(prefix, body);
	vp.queue_output(PendingWrite { fd, bytes, off: 0 });
}

fn trace_line(mut prefix: Vec<u8>, body: &[u8]) -> BString {
	prefix.extend_from_slice(body);
	prefix.push(b'\n');
	BString::from(prefix)
}

/// Advance a pending prefix, or let a no-fork substitution's newer frame
/// run. `Call` means retry the scheduler (including its output flush).
pub fn poll(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<Flow> {
	let depth = vp.frames.len();
	let index = vp.traces.iter().position(|p| p.depth == depth)?;
	let mut p = vp.traces.remove(index).expect("trace index");
	if p.saved_xtrace.is_none() {
		p.saved_xtrace = Some(on(k, cx, vp));
		set_xtrace(k, cx, vp, false);
	}
	let nofork = matches!(p.sub.as_ref(), Some(PendingSub::NoFork { .. }));
	let mut scratch = Scratch { sub: p.sub.take(), ..Scratch::default() };
	scratch.logs[Slot::Words as usize] = std::mem::take(&mut p.log);
	let flow = if let Some(flow) = exec::settle_sub(k, vp, cx, &mut scratch, Slot::Words) {
		Some(flow)
	} else {
		if nofork
			&& p.restore_env
			&& (p.resume_env
				|| super::nested::in_subshell(cx.store, vp)
				|| command::builtin_context(vp))
		{
			command::restore_env(k, vp, cx);
			p.restore_env = false;
		}
		let mode = exec::mode_of(vp);
		let result = k
			.engine
			.text_unit(b"${PS4@P}", TextKind::HereDoc, mode)
			.ok()
			.and_then(|unit| unit.words.last().cloned().map(|word| (unit, word)))
			.map(|(unit, word)| {
				let mut ex =
					Expander::new(k, cx, vp, &mut scratch.logs[Slot::Words as usize], true, p.line);
				ex.scalar(&unit, &word)
			});
		match result {
			Some(Err(Stop::Sub { unit, entry, form, text })) => {
				// A fork inherits prefix assignments even when the parent prompt
				// expands outside them. A no-fork body runs in the outer shell;
				// its remaining prompt expansion stays outside that environment.
				let inherited = form == ComsubForm::Fork && command::restore_env(k, vp, cx);
				if form != ComsubForm::Fork && command::hide_env(k, vp, cx) {
					p.restore_env = true;
				}
				let flow = exec::start_sub(k, vp, cx, &mut scratch, exec::Sub {
					unit,
					entry,
					form,
					text,
					line: p.line,
				});
				if inherited {
					command::hide_env(k, vp, cx);
				}
				Some(flow)
			},
			Some(Err(Stop::Wait(key))) => Some(Flow::Block(key)),
			result => {
				let expanded = result.and_then(Result::ok).unwrap_or_else(|| p.ps4.clone());
				if p.restore_env {
					command::restore_env(k, vp, cx);
				}
				// PS4 may close or replace this descriptor itself. Resolve and
				// pin its current object only after those side effects finish,
				// still before the traced command's own redirections run.
				let bytes = trace_line(repeated(&expanded, p.level), &p.body);
				vp.queue_output(PendingWrite { fd: p.fd, bytes, off: 0 });
				if p.saved_xtrace == Some(true) {
					set_xtrace(k, cx, vp, true);
				}
				vp.status = p.status;
				return Some(Flow::Call);
			},
		}
	};
	p.sub = scratch.sub.take();
	p.log = std::mem::take(&mut scratch.logs[Slot::Words as usize]);
	vp.traces.insert(index, p);
	flow
}

/// Bash's assignment-list executor clears `assigning_in_environment`.
/// A no-fork prompt body does not save that flag, unlike its environment,
/// so completing a real assignment list affects the outer prompt's reads.
pub fn assignment_done(vp: &mut Vproc) {
	let depth = vp.frames.len();
	for pending in &mut vp.traces {
		if pending.restore_env && pending.depth < depth {
			pending.resume_env = false;
		}
	}
}

fn set_xtrace(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, enabled: bool) {
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Opt(OptId::Xtrace),
		Some(Record::Opt(enabled)),
	);
	if let Err(err) = state::sync_option_vars(&mut k.root, cx.store, vp) {
		k.fail(err);
	}
}

/// Drop prefixes owned by frames that were abandoned. Restoring the flag
/// here also covers a control transfer out of a no-fork PS4 substitution.
pub fn unwind(root: &mut state::Root, store: &mut dyn StateStore, vp: &mut Vproc, keep: usize) {
	while let Some(index) = vp.traces.iter().rposition(|p| p.depth > keep) {
		let pending = vp.traces.remove(index).expect("trace index");
		if pending.saved_xtrace == Some(true) {
			state::store_record(root, store, vp, KeyBuf::Opt(OptId::Xtrace), Some(Record::Opt(true)));
			if let Err(err) = state::sync_option_vars(root, store, vp) {
				root.fail(err);
			}
		}
	}
}

/// `BASH_XTRACEFD` when it names an open descriptor, else 2.
fn trace_fd(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> i32 {
	state::lookup(&k.root, cx.store, vp, b"BASH_XTRACEFD")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar())
		.and_then(|s| std::str::from_utf8(s).ok()?.parse::<i32>().ok())
		.filter(|&fd| fd >= 0 && vp.fds.get(fd).is_some_and(|h| h.is_open()))
		.unwrap_or(2)
}

/// Repeat the first prompt byte per indirection level.
fn repeated(expanded: &[u8], level: u32) -> Vec<u8> {
	let mut out = Vec::with_capacity(expanded.len() + 4);
	if let Some(&first) = expanded.first() {
		for _ in 1..level {
			out.push(first);
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
	let site = k.zsh_site(cx, vp, line);
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	let text = if subst {
		zsh_print::prompt_subst(&mut ex, ps4).ok()?
	} else {
		ps4.to_vec()
	};
	let env = zsh_print::prompt_env_ex(&mut ex, site, percent, bang).ok()?;
	Some(crate::bash::vm::builtins::zsh_prompt::promptexpand(&text, &env))
}
