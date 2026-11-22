//! bash's notices of a command or a job that a signal killed (`jobs.c`
//! `notify_of_job_status`), for a non-interactive bash-mode shell, as bash
//! 5.3 prints them, and the commands the real shell runs in place of itself
//! ([`in_place`]): the last command of a `-c` string, run with `exec` and no
//! fork (bash `CMD_NO_FORK`, zsh `execcmd_exec`'s `last1`). Such a command
//! prints no notice: the shell's own process is the command, and dies of
//! the signal with it.
//!
//! bash 5.3 is built with `DONT_REPORT_SIGTERM` and `DONT_REPORT_SIGPIPE`
//! (`config-top.h`): `INT` and `PIPE` say nothing. A foreground command
//! ([`killed`]) that `TERM`, or a signal the shell traps (`trap '' SIG`
//! too), killed prints the signal's description padded to
//! [`LONGEST_SIGNAL_DESC`] columns and the command (`print_pipeline`); any
//! other signal prints `NAME: line N: `, the pid, the description padded so
//! and the command as bash prints it. bash writes it to its own standard
//! error, never through the command's redirections, and names the line it
//! has reached when it waits; a subshell, an asynchronous one or a
//! pipeline's stage reports its own foreground commands, and a foreground
//! subshell a signal killed is reported as a command ([`subshell_ended`]).
//! A background job that such another signal
//! killed gets that long notice, with `  (wd: DIR)` when the shell's
//! directory changed since the job started, at these points of bash 5.3.20
//! (each a `notify_and_cleanup` call), and only these:
//! - when `wait` waits for it ([`waited`]: through `wait`'s own redirections,
//!   naming its line, as soon as it has reaped that job, before it waits for
//!   the next);
//! - before the shell reads its next line of input ([`line_read`], naming that
//!   line);
//! - as it expands a `$( )`, `${ ;}`, `<( )` or `>( )`, which bash re-parses
//!   through the same reader (`xparse_dolparen`; a backquote not), also one in
//!   the operand of a `${x:-…}`, `${x:=…}`, `${x:+…}` or `${x:?…}` it does not
//!   expand ([`expanded`]): naming the command's line plus one, plus the
//!   newlines of the substitution's source in an assignment's value or a `[[
//!   ]]` operand;
//! - as it expands a compound array assignment, `a=( … )`, `a+=( … )` or a
//!   declaration builtin's (`parse_string_to_word_list`), naming the command's
//!   line ([`reparsed`]);
//! - at the end of `jobs` without `-r`, `-s` or `-x`, for the jobs it did not
//!   list ([`jobs_ended`], through its redirections).
//!
//! Nothing reports while the job list is frozen: in a `CHLD` trap the
//! `wait` builtin runs (not in posix mode, where the trap ends the `wait`),
//! and an `INT` trap bash runs as the forked foreground job it waited for
//! ends ([`Vproc::jobs_frozen`]); a finished job stays in the table then.
//! `TERM` and a trapped signal there say nothing. A posix `-c` shell prints
//! neither notice. No notice comes from a command or process substitution's
//! own process (one comes from a `( … )`, `&` or pipeline stage forked from
//! it), nor from a posix shell's fork of a substitution ([`Comsub`]). zsh
//! prints nothing in any of these cases.

use bstr::BString;
use strum::IntoEnumIterator as _;

use super::{
	Cx, Kernel,
	builtins::{dirstack, trap},
	exec, nested,
	proc::{Comsub, FrameKind, JobState, LoopKind, LoopRec, PendingWrite, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	diag::Diag,
	event::NodeKind,
	ids::{Dialect, Vpid},
	ir::{Op, RedirTargetIr, Unit},
	signal::Signal,
	store::{Key, KeyBuf, MiscKey, OptId, Record, StoreError, TrapKey},
};

/// bash's `LONGEST_SIGNAL_DESC` (`jobs.h`; 27 in bash 5.3): the column a
/// notice pads a signal's description to. C's `%*s` with a negative width
/// pads to its absolute value: a longer description gets the difference.
const LONGEST_SIGNAL_DESC: usize = 27;

/// The spaces after the description `desc` ([`LONGEST_SIGNAL_DESC`]).
const fn padding(desc: &str) -> usize {
	LONGEST_SIGNAL_DESC.abs_diff(desc.len())
}

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
	// bash runs a subshell's last simple command with `exec` and no fork
	// (`execute_in_subshell`'s `CMD_NO_FORK`): the subshell's process dies
	// of the signal, and its parent reports the subshell ([`subshell_ended`]).
	if subshell_tail(k, cx, vp, op, sig) {
		return Killed { notice: None, no_fork: true };
	}
	// A subshell whose process is the external (`cmd &`, `( cmd )`, a
	// stage): the external's end is the subshell's, which its parent
	// reports.
	if vp.parent.is_some() && super::transparent(vp, false) == Some(true) {
		return quiet;
	}
	let Some(unit) = vp.frames.last().and_then(|f| f.unit.clone()) else {
		return quiet;
	};
	Killed { notice: notice(k, cx, vp, &unit, op, pid, sig).map(BString::from), no_fork: false }
}

/// The notice of the foreground command of `op` in `unit`, process `pid`,
/// that `sig` killed in `vp` (bash `notify_of_job_status` for a foreground
/// job): `TERM` and a trapped signal print the description and the command,
/// any other signal but `INT` and `PIPE` the long notice ([`long_notice`]).
/// From any bash process, a subshell, an asynchronous one or a pipeline's
/// stage too (bash 5.3.20: `( sh -c 'kill -KILL $$'; echo after )`), on its
/// own standard error, but as for a background job ([`reports_jobs`]) not
/// from a command or process substitution's own process, nor in posix mode
/// from a `-c` shell or a fork of a substitution (`startup_state` 2). None
/// either in an interactive shell, for the stage a pipeline runs in the
/// shell itself, and in zsh.
fn notice(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	unit: &Unit,
	op: Op,
	pid: u32,
	sig: Signal,
) -> Option<Vec<u8>> {
	if misc_is(cx, vp, MiscKey::Interactive, b"1")
		|| vp.frames.iter().any(|f| f.kind == FrameKind::Stage)
		|| vp.jobs.comsub == Comsub::Own
	{
		return None;
	}
	let c_string = misc_is(cx, vp, MiscKey::RunOrigin, b"c");
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	if vp.mode.dialect() != Dialect::Bash
		|| (posix && (c_string || vp.jobs.comsub == Comsub::Fork))
		|| matches!(sig, Signal::Int | Signal::Pipe)
	{
		return None;
	}
	let desc = sig.description(k.engine.config().platform);
	let text = command_text(k, cx, vp, unit, op);
	Some(if sig == Signal::Term || trapped(cx, vp, sig) {
		// `print_pipeline` of the job, `JLIST_STANDARD`.
		let mut bytes = format!("{desc}{:w$}", "", w = padding(&desc)).into_bytes();
		bytes.extend_from_slice(&text);
		bytes.push(b'\n');
		bytes
	} else {
		long_notice(k, cx, vp, wait_line(vp, op.node), pid, &desc, &text)
	})
}

/// Whether bash runs the command of `op`, an external a subshell `vp`
/// starts, with `exec` in the subshell's process: its last simple command
/// ([`Unit::tails`]) at the subshell's top level, while no trap that counts
/// is set ([`counts_a_trap`]).
fn subshell_tail(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op, sig: Signal) -> bool {
	let [f] = vp.frames.as_slice() else {
		return false;
	};
	// `INT` and `PIPE` print no notice, and the held `INT` keeps its rules.
	!matches!(sig, Signal::Int | Signal::Pipe)
		&& vp.mode.dialect() == Dialect::Bash
		&& vp.parent.is_some()
		&& vp.jobs.comsub != Comsub::Own
		&& f.kind == FrameKind::Subshell
		&& f
			.unit
			.as_ref()
			.is_some_and(|u| u.tails.binary_search(&op.node).is_ok())
		&& !counts_a_trap(k, cx, vp, true).unwrap_or(true)
}

/// A foreground subshell (`( … )`) of `vp`, vproc `child`, died of `sig`:
/// bash reports it as it reports a foreground command ([`notice`]), naming
/// the subshell's text, from a subshell too (bash 5.3.20:
/// `( ( kill -QUIT $BASHPID ); : )` prints the inner one's notice); queued
/// for the shell's own standard error. A pipeline's stage and a
/// substitution are no such child, and a substitution's own process says
/// nothing.
pub(super) fn subshell_ended(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	child: Vpid,
	sig: Signal,
) {
	let Some(f) = vp.frames.last() else {
		return;
	};
	let only = f.scratch.as_ref().is_some_and(|s| {
		s.inline.is_none() && matches!(s.children.as_slice(), [(v, _)] if *v == child)
	});
	let (true, Some(unit)) = (only, f.unit.clone()) else {
		return;
	};
	let Some(&op) = unit.ops.get(f.pc as usize) else {
		return;
	};
	// The `Spawn` of a `( … )`, not of a pipeline whose stage it was.
	if unit
		.spawns
		.get(op.a as usize)
		.is_none_or(|s| s.kind != crate::bash::ir::SpawnKind::Subshell)
	{
		return;
	}
	if let Some(bytes) = notice(k, cx, vp, &unit, op, child.0, sig) {
		vp.out
			.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	}
}

/// bash's long notice: `NAME: line N: ` at script line `line`, then
/// `pretty_print_job`'s `JLIST_NONINTERACTIVE` line: `pid` as `%5ld`, the
/// description `desc` padded ([`padding`]) and `tail` (the command, as
/// bytes: a diagnostic's text is UTF-8). The `Diag` event carries the whole
/// notice, the command too.
fn long_notice(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	line: u32,
	pid: u32,
	desc: &str,
	tail: &[u8],
) -> Vec<u8> {
	let msg = format!("{pid:>5} {desc}{:w$}", "", w = padding(desc));
	let diag = Diag::Warning { msg: msg.into() };
	let mut bytes = k.render_quiet(cx, vp, line, &diag);
	if bytes.last() == Some(&b'\n') {
		bytes.pop();
	}
	bytes.extend_from_slice(tail);
	bytes.push(b'\n');
	k.diag_event(cx, vp, &diag, tail);
	bytes
}

/// Whether `vp` reports the background jobs a signal killed (bash
/// `notify_of_job_status` for a dead job not in the foreground): a
/// non-interactive bash, outside a command or process substitution's own
/// process (`SUBSHELL_COMSUB`), and not in posix mode where bash's
/// `startup_state` is 2: a `-c` shell, or a fork of a substitution
/// ([`Comsub::Fork`]). Those mark the job reported instead. Nor while the
/// job list is frozen ([`Vproc::jobs_frozen`]: bash's `notify_and_cleanup`
/// returns at once then).
fn reports_jobs(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	vp.mode.dialect() == Dialect::Bash
		&& vp.jobs.comsub != Comsub::Own
		&& !vp.jobs_frozen()
		&& !misc_is(cx, vp, MiscKey::Interactive, b"1")
		&& ((vp.jobs.comsub == Comsub::No && !misc_is(cx, vp, MiscKey::RunOrigin, b"c"))
			|| !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false))
}

/// The signal that killed job `number` of `vp`, if bash reports it and has
/// not yet: the job is this shell's own, done, by a signal other than
/// `INT`, `TERM` and `PIPE` that the shell does not trap. bash leaves a job
/// another signal killed unreported, for `jobs`.
fn unreported(cx: &mut Cx<'_>, vp: &Vproc, number: u32) -> Option<Signal> {
	let job = vp.jobs.get(number)?;
	if job.inherited || job.notified || !matches!(job.state, JobState::Done(_)) {
		return None;
	}
	let sig = job.signal?;
	(!matches!(sig, Signal::Int | Signal::Term | Signal::Pipe) && !trapped(cx, vp, sig))
		.then_some(sig)
}

/// The long notice of job `number` of `vp`, which `sig` killed, at script
/// line `line`: the job's pid and command, `  (wd: DIR)` when the shell's
/// directory is not the one the job started in (bash
/// `polite_directory_format`). The job is reported now (`J_NOTIFIED`).
fn job_line(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	number: u32,
	sig: Signal,
	line: u32,
) -> Option<Vec<u8>> {
	let job = vp.jobs.get(number)?;
	let (pid, mut tail) = (job.pid(), job.text.to_vec());
	if job.wd != vp.cwd {
		let home = state::lookup(&k.root, cx.store, vp, b"HOME")
			.ok()
			.flatten()
			.and_then(|v| v.as_scalar().map(BString::from));
		tail.extend_from_slice(b"  (wd: ");
		let home = home.as_ref().map(|h| h.as_slice());
		tail.extend_from_slice(&dirstack::polite(home, &job.wd, false));
		tail.push(b')');
	}
	let desc = sig.description(k.engine.config().platform);
	let bytes = long_notice(k, cx, vp, line, pid, &desc, &tail);
	if let Some(job) = vp.jobs.get_mut(number) {
		job.notified = true;
	}
	Some(bytes)
}

/// `wait` (`wait`, `wait ID`, `wait -n`) waited for the job of vproc `vpid`
/// at script line `line` (bash `wait_for`'s `notify_and_cleanup (job)`,
/// `wait_for_any_job`): its notice, for the `wait` command's standard
/// error, when a signal bash reports killed it ([`unreported`]).
pub(super) fn waited(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	vpid: Vpid,
	line: u32,
) -> Option<Vec<u8>> {
	let number = vp.jobs.by_vpid(vpid)?.number;
	let sig = unreported(cx, vp, number)?;
	if !reports_jobs(k, cx, vp) {
		return None;
	}
	job_line(k, cx, vp, number, sig, line)
}

/// `vp` reads line `line` of its input next (bash `shell_getc`, which
/// first calls `notify_and_cleanup (-1)`): each background job a signal
/// bash reports killed ([`unreported`]) gets its notice on the shell's
/// standard error, in job order, and goes from the table
/// (`cleanup_dead_jobs`; `wait $!` still finds its status).
pub(super) fn line_read(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	if let Some(bytes) = report_all(k, cx, vp, line) {
		vp.out
			.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	}
}

/// bash re-parses text through `shell_getc` at run time (a substitution, a
/// compound array assignment) at script line `line` of `vp`: it reports as
/// [`line_read`] does, naming `line`. Written at once, before the text
/// runs and before the command's redirections move standard error (what
/// would block waits in `vp.out`).
pub(super) fn reparsed(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	line_read(k, cx, vp, line);
	if !vp.out.is_empty() {
		let _ = exec::flush_out(k, vp);
	}
}

/// The shell expands a `$( )`, `${ ;}`, `<( )` or `>( )` (not a
/// backquote) of the command at script line `line`, or one in an operand
/// it does not expand: [`reparsed`] naming `line + 1 + lines` (`lines`: the
/// newlines of its source in an assignment's value or a `[[ ]]` operand,
/// else 0; [`crate::bash::ir::Part::Comsub`]).
pub(super) fn expanded(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, lines: u32) {
	reparsed(k, cx, vp, line.saturating_add(1).saturating_add(lines));
}

/// `jobs` ends at script line `line` (bash's `notify_and_cleanup (-1)` at
/// the end of `jobs_builtin`): the notices of the background jobs a signal
/// killed that it did not list, for its own standard error, in job order;
/// those jobs go from the table.
pub(super) fn jobs_ended(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
) -> Option<Vec<u8>> {
	report_all(k, cx, vp, line)
}

/// bash's `notify_and_cleanup (-1)` at script line `line`: the notices of
/// the background jobs a signal bash reports killed ([`unreported`]), in
/// job order, which go from the table; `None` when nothing is reported.
fn report_all(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<Vec<u8>> {
	let done: Vec<u32> = vp
		.jobs
		.iter()
		.filter(|j| j.signal.is_some() && !j.notified && !j.inherited)
		.map(|j| j.number)
		.collect();
	if done.is_empty() || !reports_jobs(k, cx, vp) {
		return None;
	}
	let mut out = Vec::new();
	for number in done {
		let Some(sig) = unreported(cx, vp, number) else {
			continue;
		};
		if let Some(bytes) = job_line(k, cx, vp, number, sig, line) {
			out.extend_from_slice(&bytes);
		}
		vp.jobs.remove(number);
	}
	(!out.is_empty()).then_some(out)
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
/// ([`counts_a_trap`]), as the parse tree records ([`Unit::tails`]): bash's
/// simple command with no redirection (`evalstring.c`
/// `should_suppress_fork`, `can_optimize_connection`); zsh's `last1`, which
/// it passes into compound commands, into a `for` body only on the loop's
/// last word (`execfor`: `do_exec && args && empty(args)`).
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
	let last =
		u.tails.binary_search(&op.node).is_ok() && (bash || f.loops.iter().all(zsh_last_pass));
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
		// A subshell keeps the line its parent's parser reached when it
		// forked: the last line of its outermost `( … )`.
		FrameKind::Subshell => {
			let Some(n) = u.nodes.get(node as usize) else {
				return exec::line_of(vp, node);
			};
			let outer = u
				.nodes
				.iter()
				.filter(|m| m.kind == NodeKind::Subshell && m.lo <= n.lo && n.hi <= m.hi)
				.max_by_key(|m| m.hi - m.lo);
			let Some(m) = outer else {
				return exec::line_of(vp, node);
			};
			#[expect(clippy::naive_bytecount, reason = "a short command's text")]
			let newlines = u
				.source
				.get(m.lo as usize..m.hi as usize)
				.map_or(0, |s| s.iter().filter(|&&b| b == b'\n').count());
			(u.line + m.line + u32::try_from(newlines).unwrap_or(u32::MAX))
				.saturating_sub(f.line_shift)
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
