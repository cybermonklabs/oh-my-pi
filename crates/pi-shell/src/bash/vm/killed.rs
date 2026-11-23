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
//! has reached when it waits ([`wait_line`]: in a forked process, the line
//! bash had when it forked it). Who reports follows the processes bash
//! forks: a subshell, an asynchronous one or a pipeline's stage reports its
//! own foreground commands but the one it runs with `exec`
//! ([`subshell_exec`]); a `( … )`, job or stage whose whole command is a
//! `( … )` is one process with it; a foreground subshell a signal killed is
//! reported as a command ([`subshell_ended`]). A foreground pipeline is
//! reported as its processes ([`pipeline_ended`]), when a signal ended the
//! one whose end is its status (`raw_job_exit_status`: the last one, or
//! under `pipefail` the last one that did not succeed): the short notice
//! names how the last process ended and the pipeline, the long one lists
//! each process on its own line ([`process_lines`]).
//! A background job that such another signal
//! killed gets that long notice, with `  (wd: DIR)` when the shell's
//! directory changed since the job started, a pipeline's job one line per
//! process ([`super::proc::Job::procs`]), at these points of bash 5.3.20
//! (each a `notify_and_cleanup` call), and only these:
//! - when `wait` waits for it ([`waited`]: through `wait`'s own redirections,
//!   naming its line, as soon as it has reaped that job, before it waits for
//!   the next);
//! - before the shell reads its next line of input ([`line_read`], naming that
//!   line), and once a DEBUG trap ran (`run_debug_trap`, naming the line of the
//!   command it ran for; no other trap ends with one);
//! - as it expands a `$( )`, `${ ;}`, `<( )` or `>( )`, which bash re-parses
//!   through the same reader (`xparse_dolparen`; a backquote not), also one of
//!   a `${ … }` it does not expand, in `$(( ))` text too ([`expanded`]): naming
//!   the line where the command's first word ends (for `[[ ]]` and `(( ))` the
//!   line the construct ends on) plus one;
//! - as it expands a compound array assignment, `a=( … )`, `a+=( … )` or a
//!   declaration builtin's (`parse_string_to_word_list`), naming the command's
//!   line ([`reparsed`]);
//! - at the end of `jobs` without `-r`, `-s` or `-x`, for the jobs it did not
//!   list ([`jobs_ended`], through its redirections).
//!
//! Each of these points, the end of a `wait`, each fork (`stop_pipeline`) and
//! each loop iteration (`REAP`: also when `break` or `continue` ends the
//! body; not at a `return`; not in an interactive shell with job control,
//! which cleans up at each `;` of a list instead, [`connected`]) deletes the
//! finished jobs already reported ([`cleanup_dead_jobs`]). Nothing reports
//! and nothing is deleted while the job list is frozen: in a `CHLD` trap the
//! `wait` builtin runs (not in posix mode, where the trap ends the `wait`),
//! in an `INT` trap bash runs as the forked foreground job it waited for
//! ends, and in a pipeline's last stage the shell runs itself (`lastpipe`)
//! ([`Vproc::jobs_frozen`]); in a function substitution (`${ …; }`) jobs are
//! reported but none deleted ([`Vproc::jobs_kept`]). The next cleanup point
//! outside deletes what was reported meanwhile. `TERM` and a trapped signal
//! there say nothing. A posix
//! `-c` shell prints neither notice. No notice comes from a command or process
//! substitution's own process (one comes from a `( … )`, `&` or pipeline
//! stage forked from it), nor from a posix shell's fork of a substitution
//! ([`Comsub`]). zsh prints nothing in any of these cases.

use bstr::BString;
use strum::IntoEnumIterator as _;

use super::{
	Cx, Kernel,
	builtins::{dirstack, trap},
	exec, nested,
	proc::{
		Comsub, ForkAt, ForkLine, Frame, FrameKind, JobProc, JobProcs, JobState, LoopKind, LoopRec,
		PendingWrite, ProcState, ScriptKind, Vproc,
	},
	state,
};
use crate::bash::{
	Platform,
	diag::Diag,
	event::NodeKind,
	ids::{Dialect, Vpid},
	ir::{Op, Opcode, RedirTargetIr, SpawnIr, SpawnKind, Unit},
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
	// A subshell whose process is the external (bash `exec`ed it,
	// [`subshell_exec`]): the external's end is the subshell's, which its
	// parent reports ([`super::external_ended`]).
	if vp.parent.is_some() && super::transparent(vp, false) == Some(true) {
		return quiet;
	}
	let Some(unit) = vp.frames.last().and_then(|f| f.unit.clone()) else {
		return quiet;
	};
	let redirs = unit.cmds.get(op.a as usize).and_then(|c| c.redirs);
	let text = command_text(k, cx, vp, &unit, op.node, redirs);
	Killed {
		notice:  notice(k, cx, vp, &text, op.node, pid, sig).map(BString::from),
		no_fork: false,
	}
}

/// How bash reports a foreground command or pipeline a signal killed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
	/// How it ended and the command (`print_pipeline`, `JLIST_STANDARD`;
	/// [`short_notice`]).
	Short,
	/// `NAME: line N: ` and the job (`pretty_print_job`,
	/// `JLIST_NONINTERACTIVE`; [`long_notice`]).
	Long,
}

/// How `vp` reports a foreground command or pipeline that `sig` killed
/// (bash `notify_of_job_status` for a foreground job): `TERM` and a trapped
/// signal the short way, any other signal but `INT` and `PIPE` the long way.
/// From any bash process, a subshell, an asynchronous one or a pipeline's
/// stage too (bash 5.3.20: `( sh -c 'kill -KILL $$'; echo after )`), on its
/// own standard error, but as for a background job ([`reports_jobs`]) not
/// from a command or process substitution's own process, nor in posix mode
/// from a `-c` shell or a fork of a substitution (`startup_state` 2). None
/// either in an interactive shell, for the stage a pipeline runs in the
/// shell itself, and in zsh.
fn notice_form(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, sig: Signal) -> Option<Form> {
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
	Some(if sig == Signal::Term || trapped(cx, vp, sig) {
		Form::Short
	} else {
		Form::Long
	})
}

/// The notice of the foreground command `text` (syntax node `node`),
/// process `pid`, that `sig` killed in `vp`, as [`notice_form`] decides:
/// the short one its description and the command, the long one
/// ([`long_notice`]) its pid, its description and the command.
fn notice(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	text: &[u8],
	node: u32,
	pid: u32,
	sig: Signal,
) -> Option<Vec<u8>> {
	let form = notice_form(k, cx, vp, sig)?;
	let desc = sig.description(k.engine.config().platform);
	Some(match form {
		Form::Short => short_notice(&desc, text),
		Form::Long => long_notice(k, cx, vp, wait_line(vp, node), pid, &desc, text),
	})
}

/// The pipeline of `vp` the shell waited for (a `Spawn` of `info`, syntax
/// node `node`) ended, and `sig` ended the process whose end is its status
/// ([`JobProcs::status_process`]): bash's notice of that foreground job, as
/// [`notice_form`] decides, on the shell's own standard error. The short one
/// names how the last process ended and the pipeline (`print_pipeline`,
/// `JLIST_STANDARD`); the long one lists each process ([`process_lines`]),
/// as the notice of a background job does. `procs` are its processes
/// ([`super::proc::PipelineWait::procs`]), their commands not filled yet.
#[expect(clippy::too_many_arguments, reason = "the pipeline and what ended it")]
pub(super) fn pipeline_ended(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	unit: &Unit,
	info: &SpawnIr,
	node: u32,
	sig: Signal,
	JobProcs { list: mut procs, .. }: JobProcs,
) {
	let Some(form) = notice_form(k, cx, vp, sig) else {
		return;
	};
	for (i, p) in procs.iter_mut().enumerate() {
		p.text = stage_command(k, cx, vp, unit, info, i);
	}
	let platform = k.engine.config().platform;
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let bytes = match form {
		Form::Short => {
			let Some(last) = procs.last() else {
				return;
			};
			let texts: Vec<&[u8]> = procs.iter().map(|p| p.text.as_slice()).collect();
			short_notice(&ended_text(last.state, posix, platform), &texts.join(&b" | "[..]))
		},
		Form::Long => {
			let Some((pid, ended, lines)) = process_lines(&procs, posix, platform, b"") else {
				return;
			};
			long_notice(k, cx, vp, wait_line(vp, node), pid, &ended, &lines)
		},
	};
	vp.out
		.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
}

/// The command of stage `i` of pipeline `s` as bash prints it for that
/// process (`p->command`): with the `2>&1` bash's parser adds for a `|&`
/// after it.
pub(super) fn stage_command(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	unit: &Unit,
	s: &SpawnIr,
	i: usize,
) -> BString {
	let mut text = fork_node(unit, s, i)
		.map_or_else(BString::default, |node| exec::job_text(k, cx, vp, unit, node));
	if s.stages.get(i).is_some_and(|st| st.pipe_stderr) {
		text.extend_from_slice(b" 2>&1");
	}
	text
}

/// bash's short notice: `status` padded ([`padding`]), then `text`
/// (`print_pipeline` with `JLIST_STANDARD`).
fn short_notice(status: &str, text: &[u8]) -> Vec<u8> {
	let mut bytes = format!("{status}{:w$}", "", w = padding(status)).into_bytes();
	bytes.extend_from_slice(text);
	bytes.push(b'\n');
	bytes
}

/// How a process of a job that ended shows (bash `printable_job_status` of
/// a dead job): the description of the signal that killed it, `Done` for an
/// exit with 0, else `Exit N` (in posix mode `Done(N)`).
fn ended_text(state: ProcState, posix: bool, platform: Platform) -> String {
	match state {
		ProcState::Killed(sig) => sig.description(platform),
		ProcState::Exited(0) => String::from("Done"),
		ProcState::Exited(status) if posix => format!("Done({status})"),
		ProcState::Exited(status) => format!("Exit {status}"),
		ProcState::Running => String::from("Running"),
	}
}

/// What bash's long notice ([`long_notice`]) prints of a job of processes
/// `procs` that ended (`pretty_print_job` with `JLIST_NONINTERACTIVE`:
/// `print_pipeline` with `JLIST_LONG`), `tail` after the last command: the
/// first process's pid, how it ended ([`ended_text`]), and its command,
/// then a line for each other process: five spaces, its pid as `%5ld`, how
/// it ended (nothing where the first ended so, which pads as `| `'s two
/// columns) padded ([`padding`]), `| ` and its command. `None` without
/// processes.
fn process_lines(
	procs: &[JobProc],
	posix: bool,
	platform: Platform,
	tail: &[u8],
) -> Option<(u32, String, Vec<u8>)> {
	let (first, rest) = procs.split_first()?;
	let mut lines = first.text.to_vec();
	for p in rest {
		let ended = if p.state == first.state {
			String::new()
		} else {
			ended_text(p.state, posix, platform)
		};
		let w = padding(if ended.is_empty() { "| " } else { &ended });
		lines.extend_from_slice(format!("\n     {:>5} {ended}{:w$}| ", p.pid(), "").as_bytes());
		lines.extend_from_slice(&p.text);
	}
	lines.extend_from_slice(tail);
	Some((first.pid(), ended_text(first.state, posix, platform), lines))
}

/// Whether bash runs the external of `op` (an `Exec` in `vp`'s base frame
/// that ends the code of a subshell, a job or a pipeline stage) with `exec`
/// in that process, so that the process dies with it (`CMD_NO_FORK`): the
/// whole command of a `( … )` (whatever its redirections,
/// `execute_in_subshell`), of a background job or of a stage (bash forks
/// such a simple command as the process itself); or the simple command with
/// no redirection that ends a `( … )`'s `;`, `&&` or `||` list
/// ([`Unit::tails`]) while no trap counts (`optimize_subshell_command`,
/// `should_optimize_fork`: a signal trap with an action, an EXIT trap of the
/// subshell's own, an ERR trap it runs, or in a function a RETURN trap it
/// runs). A job's or a stage's list (`a && cmd &`) forks it. The last
/// command of a substitution's or a coprocess's own code keeps the rule it
/// had (it ends the code). Decided as the external starts
/// ([`super::proc::ExecState`]'s `subshell_exec`). bash only.
pub(super) fn subshell_exec(cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
	let [f] = vp.frames.as_slice() else {
		return false;
	};
	let Some(u) = f.unit.as_deref() else {
		return false;
	};
	let code = |pc: u32| u.ops.get(pc as usize).map(|o| o.code);
	if vp.mode.dialect() != Dialect::Bash
		|| vp.parent.is_none()
		|| f.kind != FrameKind::Subshell
		|| code(f.pc + 1) != Some(Opcode::SubExit)
	{
		return false;
	}
	match base_spawn(u, f.pc) {
		_ if vp.jobs.comsub == Comsub::Own => true,
		Some((s, _)) if s.kind == SpawnKind::Subshell => {
			s.stages[0].entry == f.pc
				|| (u.tails.binary_search(&op.node).is_ok() && !forks_for_traps(cx, vp).unwrap_or(true))
		},
		Some((s, i)) if matches!(s.kind, SpawnKind::Background | SpawnKind::Pipeline) => {
			s.stages[i].entry == f.pc
		},
		_ => true,
	}
}

/// Whether a trap makes bash fork a `( … )`'s last command
/// (`should_optimize_fork`, `evalstring.c:108-116`): `signal_is_trapped`
/// of the EXIT, ERR and RETURN traps, which an empty action
/// (`trap '' ERR`) sets too (`trap.c:994-996`), and `any_signals_trapped`,
/// which an ignored signal does not answer for. An inherited EXIT trap is
/// reset in the subshell; the ERR trap reaches it only with `errtrace`,
/// and in a function the RETURN trap only with `functrace`, as they were
/// at the fork ([`super::proc::Traced`]).
fn forks_for_traps(cx: &mut Cx<'_>, vp: &Vproc) -> Result<bool, StoreError> {
	let set = |cx: &mut Cx<'_>, key| -> Result<bool, StoreError> {
		Ok(matches!(state::record(cx.store, vp, Key::Trap(key))?, Some(Record::Trap { .. })))
	};
	let action = |cx: &mut Cx<'_>, key| -> Result<bool, StoreError> {
		Ok(matches!(
			state::record(cx.store, vp, Key::Trap(key))?,
			Some(Record::Trap { action, .. }) if !action.is_empty()
		))
	};
	// The fork's record is on the vproc's base frame.
	let traced = vp
		.frames
		.first()
		.map_or(super::proc::Traced::ROOT, |f| f.traced);
	let runs = |cx: &mut Cx<'_>, key| -> Result<bool, StoreError> {
		Ok(set(cx, key)? && (vp.own_traps.has(key) || traced.keeps(key)))
	};
	if (vp.own_traps.has(TrapKey::Exit) && set(cx, TrapKey::Exit)?)
		|| runs(cx, TrapKey::Err)?
		|| (!vp.calls.is_empty() && runs(cx, TrapKey::Return)?)
	{
		return Ok(true);
	}
	for sig in Signal::iter() {
		if action(cx, TrapKey::Signal(sig))? {
			return Ok(true);
		}
	}
	Ok(false)
}

/// A foreground subshell (`( … )`) of `vp`, vproc `child`, died of `sig`:
/// bash reports it as it reports a foreground command ([`notice`]), naming
/// the subshell's text (with its `!`), from a subshell too (bash 5.3.20:
/// `( ( kill -QUIT $BASHPID ); : )` prints the inner one's notice), on the
/// shell's own standard error, at the reap: the fd 2 that the `( … )`'s own
/// `Redir` saved, else fd 2 as it is. A pipeline's stage and a substitution
/// are no such child, and a substitution's own process says nothing.
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
		s.inline().is_none() && matches!(s.children.as_slice(), [(v, _)] if *v == child)
	});
	let (true, Some(unit)) = (only, f.unit.clone()) else {
		return;
	};
	let pc = f.pc;
	let Some(&op) = unit.ops.get(pc as usize) else {
		return;
	};
	// The `Spawn` of a `( … )`, not of a pipeline whose stage it was.
	let Some(spawn) = unit
		.spawns
		.get(op.a as usize)
		.filter(|s| s.kind == crate::bash::ir::SpawnKind::Subshell)
	else {
		return;
	};
	// `Redir; Enter; Spawn`: the `( … )`'s own redirections.
	let at = |pc: Option<u32>| {
		pc.and_then(|pc| unit.ops.get(pc as usize))
			.filter(|o| o.node == op.node)
	};
	let redir = at(pc.checked_sub(2)).filter(|o| {
		o.code == Opcode::Redir && at(pc.checked_sub(1)).is_some_and(|e| e.code == Opcode::Enter)
	});
	// After its `Leave` (and `PopRedir`), a `Not` names the `!` pipeline,
	// but not one that is the whole command of a subshell `vp` is: bash
	// takes `CMD_INVERT_RETURN` off the command the subshell runs, and only
	// off that one (`execute_in_subshell`, `execute_cmd.c:1808-1809`). So
	// the `!` must start where `vp`'s own code does, as [`transparent`]
	// requires of the command it runs in place.
	let mut end = spawn.end + 1;
	if redir.is_some() {
		end += 1;
	}
	let start = pc
		.checked_sub(1)
		.map(|enter| if redir.is_some() { enter - 1 } else { enter });
	let whole = vp.frames.len() == 1
		&& vp.parent.is_some()
		&& start.is_some_and(|start| {
			base_spawn(&unit, pc).is_some_and(|(s, i)| s.stages[i].entry == start)
		})
		&& unit
			.ops
			.get(end as usize + 1)
			.is_some_and(|o| o.code == Opcode::SubExit);
	let node = unit
		.ops
		.get(end as usize)
		.filter(|o| o.code == Opcode::Not && !whole)
		.map_or(op.node, |o| o.node);
	let text = command_text(k, cx, vp, &unit, node, redir.map(|r| r.a));
	let Some(bytes) = notice(k, cx, vp, &text, op.node, child.0, sig) else {
		return;
	};
	// bash forks before it applies a `( … )`'s redirections, so the notice
	// goes to the shell's own standard error; obash applies them in the
	// shell, so the notice goes to the fd 2 the `( … )`'s `Redir` saved.
	// Written here, at the reap: errexit, the ERR trap and the shell's exit
	// all act before the `PopRedir` that puts fd 2 back.
	let saved = redir.and_then(|_| {
		let f = vp.frames.last()?;
		let s = f.redirs.last()?.iter().find(|s| s.fd == 2)?;
		Some(s.prev.clone())
	});
	let Some(saved) = saved else {
		vp.out
			.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
		return;
	};
	// What was queued belongs to the fd 2 the `( … )` redirected.
	let _ = exec::flush_out(k, vp);
	let current = vp.fds.get(2).cloned();
	vp.fds.set(2, saved);
	vp.out
		.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	let _ = exec::flush_out(k, vp);
	vp.fds.set(2, current);
}

/// bash's long notice: `NAME: line N: ` at script line `line`, then
/// `pretty_print_job`'s `JLIST_NONINTERACTIVE` lines: `pid` as `%5ld`, the
/// description `desc` padded ([`padding`]) and `tail` (the command and the
/// lines of the job's other processes, [`process_lines`], as bytes: a
/// diagnostic's text is UTF-8). The `Diag` event carries the whole notice,
/// the command too.
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
/// not yet: the job is this shell's own ([`reports_on`]), done, by a signal
/// other than `INT`, `TERM` and `PIPE` that the shell does not trap. bash
/// leaves a job another signal killed unreported, for `jobs`.
fn unreported(cx: &mut Cx<'_>, vp: &Vproc, number: u32) -> Option<Signal> {
	let job = vp.jobs.get(number)?;
	if !reports_on(vp, job) || job.notified || !matches!(job.state, JobState::Done(_)) {
		return None;
	}
	let sig = job.signal?;
	(!matches!(sig, Signal::Int | Signal::Term | Signal::Pipe) && !trapped(cx, vp, sig))
		.then_some(sig)
}

/// Whether `vp` reports job `job` of its table: one of its own, or one of
/// the parent's it holds while it expands the simple command bash forked
/// it for ([`super::proc::Copied`]), not a copy it only lists.
fn reports_on(vp: &Vproc, job: &super::proc::Job) -> bool {
	!job.inherited || vp.jobs.copied != super::proc::Copied::No
}

/// The long notice of job `number` of `vp`, which `sig` killed, at script
/// line `line`: the job's pid and command, or the lines of its processes
/// ([`super::proc::Job::procs`], [`process_lines`]), `  (wd: DIR)` after
/// the last command when the shell's directory is not the one the job
/// started in (bash `polite_directory_format`). The job is reported now
/// (`J_NOTIFIED`).
fn job_line(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	number: u32,
	sig: Signal,
	line: u32,
) -> Option<Vec<u8>> {
	let job = vp.jobs.get(number)?;
	let mut wd = Vec::new();
	if job.wd != vp.cwd {
		let home = state::lookup(&k.root, cx.store, vp, b"HOME")
			.ok()
			.flatten()
			.and_then(|v| v.as_scalar().map(BString::from));
		wd.extend_from_slice(b"  (wd: ");
		let home = home.as_ref().map(|h| h.as_slice());
		wd.extend_from_slice(&dirstack::polite(home, &job.wd, false));
		wd.push(b')');
	}
	let platform = k.engine.config().platform;
	let (pid, desc, tail) = match job.procs.as_deref() {
		None => (job.pid(), sig.description(platform), [job.text.as_slice(), &wd].concat()),
		Some(procs) => {
			let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
			process_lines(&procs.list, posix, platform, &wd)?
		},
	};
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

/// Whether `vp` is an interactive shell (bash's `interactive_shell`).
pub(super) fn interactive(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	misc_is(cx, vp, MiscKey::Interactive, b"1")
}

/// bash re-parses text through `shell_getc` at run time (a substitution, a
/// compound array assignment) at script line `line` of `vp`: it reports as
/// [`line_read`] does, naming `line`. Written at once, before the text
/// runs and before the command's redirections move standard error (what
/// would block waits in `vp.out`). Not in an interactive shell, which
/// prompts for no such text (`interactive_shell == 0 || SHOULD_PROMPT ()`,
/// `parse.y:2526`).
pub(super) fn reparsed(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	if interactive(cx, vp) {
		return;
	}
	line_read(k, cx, vp, line);
	if !vp.out.is_empty() {
		let _ = exec::flush_out(k, vp);
	}
}

/// The script line bash holds for the command `vp` runs (its top frame's
/// op): where its first word ends, or where a `[[ ]]` or `(( ))` ends
/// (bash's `line_number` at `make_simple_command`, `make_cond_command`,
/// `make_arith_command`), which a notice names at the end of a DEBUG trap
/// (`run_debug_trap`). The parser is one line further as it re-parses a
/// substitution of the command ([`expanded`]).
pub(super) fn command_line(vp: &Vproc) -> u32 {
	let node = vp
		.frames
		.last()
		.and_then(|f| f.unit.as_ref()?.ops.get(f.pc as usize).map(|o| o.node));
	node
		.map_or(0, |node| exec::line_of(vp, node))
		.saturating_add(reparse_lines(vp))
}

/// The shell expands a `$( )`, `${ ;}`, `<( )` or `>( )` (not a
/// backquote) of the command at script line `line` (where its syntax node
/// starts), or one of a `${ … }` it does not expand: bash re-parses its text
/// ([`reparsed`]) with its parser at the line after the command's first
/// word, or after a `[[ ]]` or `(( ))` ([`command_line`]), what the notice
/// names.
pub(super) fn expanded(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	if reports_due(vp) {
		let line = line.saturating_add(1).saturating_add(reparse_lines(vp));
		reparsed(k, cx, vp, line);
	}
}

/// Whether a report point has work in `vp`: a finished job to report, or a
/// reported one to delete ([`report_all`]).
pub(super) fn reports_due(vp: &Vproc) -> bool {
	vp.jobs
		.iter()
		.any(|j| matches!(j.state, JobState::Done(_)) && (j.notified || j.signal.is_some()))
}

/// The newlines bash's parser passed after the start of the command `vp`
/// runs (its top frame's op) before it re-parses a substitution of it: to
/// the end of a simple command's first word (an assignment, a word or a
/// redirection), to the end of a `[[ ]]` or `(( ))`; none for any other
/// command (`for`, `case`: their own line).
fn reparse_lines(vp: &Vproc) -> u32 {
	let Some(f) = vp.frames.last() else {
		return 0;
	};
	let Some(u) = f.unit.as_deref() else {
		return 0;
	};
	let Some(op) = u.ops.get(f.pc as usize) else {
		return 0;
	};
	let Some(cmd) = u.nodes.get(op.node as usize) else {
		return 0;
	};
	let end = match cmd.kind {
		NodeKind::Cond | NodeKind::Arith => cmd.hi,
		NodeKind::Simple if op.code == Opcode::Exec => {
			let Some(c) = u.cmds.get(op.a as usize) else {
				return 0;
			};
			let words = u.lists.get(c.words as usize).into_iter().flatten();
			let targets = c
				.redirs
				.and_then(|r| u.redirs.get(r as usize))
				.into_iter()
				.flatten()
				.filter_map(|r| match r.target {
					RedirTargetIr::Word(w) => Some(w),
					RedirTargetIr::HereDoc { .. } => None,
				});
			let nodes = c.assigns.iter().map(|a| a.node).chain(
				words
					.copied()
					.chain(targets)
					.filter_map(|w| u.words.get(w as usize).map(|w| w.node)),
			);
			match nodes
				.filter_map(|n| u.nodes.get(n as usize))
				.filter(|n| n.lo >= cmd.lo && n.hi <= cmd.hi)
				.min_by_key(|n| n.lo)
			{
				Some(first) => first.hi,
				None => return 0,
			}
		},
		_ => return 0,
	};
	#[expect(clippy::naive_bytecount, reason = "a command's first word")]
	let newlines = u
		.source
		.get(cmd.lo as usize..end as usize)
		.map_or(0, |s| s.iter().filter(|&&b| b == b'\n').count());
	u32::try_from(newlines).unwrap_or(u32::MAX)
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
/// job order, marked reported, then the finished jobs reported go
/// ([`cleanup_dead_jobs`]); `None` when nothing is reported.
fn report_all(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<Vec<u8>> {
	let done: Vec<u32> = vp
		.jobs
		.iter()
		.filter(|j| j.signal.is_some() && !j.notified && reports_on(vp, j))
		.map(|j| j.number)
		.collect();
	let mut out = Vec::new();
	if !done.is_empty() && reports_jobs(k, cx, vp) {
		for number in done {
			let Some(sig) = unreported(cx, vp, number) else {
				continue;
			};
			if let Some(bytes) = job_line(k, cx, vp, number, sig, line) {
				out.extend_from_slice(&bytes);
			}
		}
	}
	cleanup_dead_jobs(k, cx, vp);
	(!out.is_empty()).then_some(out)
}

/// bash's `cleanup_dead_jobs`: the finished jobs of `vp` already reported
/// (`J_NOTIFIED`: listed, waited for) go from the table, but none while no
/// job may be deleted ([`Vproc::jobs_kept`]: `jobs.c:1310`). Each one's
/// status is kept for a later `wait PID`
/// ([`super::proc::JobTable::bgp`]; bash `delete_job` adds every
/// asynchronous job it deletes to bgpids, `jobs.c:1501-1505`). bash only:
/// zsh deletes a job as it reports it. bash calls it at each of its
/// cleanup points: the report points ([`report_all`]), `jobs`, the end of
/// a `wait`, each fork (`stop_pipeline`, `jobs.c:572`) and each loop
/// iteration (`REAP`, `execute_cmd.c:3105`, `3267`, `3606`, `3838`, also
/// as `break` or `continue` ends the body: `exec::break_loops`).
pub(super) fn cleanup_dead_jobs(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if !vp.jobs.iter().any(reported) || vp.mode.dialect() != Dialect::Bash || vp.jobs_kept() {
		return;
	}
	let gone: Vec<(Vpid, u32, i32, bool)> = vp
		.jobs
		.iter()
		.filter(|j| reported(j))
		.filter_map(|j| match j.state {
			JobState::Done(status) => Some((j.vpid, j.pid(), status, j.inherited)),
			_ => None,
		})
		.collect();
	vp.jobs.remove_where(reported);
	for (vpid, pid, status, inherited) in gone {
		state::save_status(&mut k.root, cx.store, vp, vpid, pid, status);
		// The kept list answers `wait PID` for it from now on, and stops once
		// it forgets the status: the child's own record, which would answer
		// too, goes. A command substitution's copy of its parent's job is no
		// child of `vp`: its record stays the parent's.
		if !inherited {
			let _ = k.proc_collect(cx.store, vpid);
		}
	}
}

/// A finished job that was reported (`J_NOTIFIED`): [`cleanup_dead_jobs`]
/// deletes it.
const fn reported(j: &super::proc::Job) -> bool {
	j.notified && matches!(j.state, JobState::Done(_))
}

/// bash's `REAP` (`execute_cmd.c:2979-2985`) as a loop body ends, or an
/// arithmetic `for` evaluated its test: [`cleanup_dead_jobs`], unless
/// `vp` is an interactive shell with job control, which deletes the
/// finished jobs reported only at its notify points (the `;` of a list,
/// [`connected`]).
pub(super) fn reap(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if !vp.jobs.iter().any(reported)
		|| (exec::job_control(k, cx, vp) && misc_is(cx, vp, MiscKey::Interactive, b"1"))
	{
		return;
	}
	cleanup_dead_jobs(k, cx, vp);
}

/// `vp` starts the second command of a `;` connection ([`Unit::semis`]):
/// an interactive shell with job control, outside posix mode, calls
/// `notify_and_cleanup (-1)` there (`execute_cmd.c:2883-2884`), which
/// deletes the finished jobs reported ([`cleanup_dead_jobs`]). bash's
/// `interactive` is off in a subshell and in a trap (`SEVAL_NONINT`); a
/// function substitution deletes no job ([`Vproc::jobs_kept`]).
///
/// [`Unit::semis`]: crate::bash::ir::Unit::semis
pub(super) fn connected(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if !vp.jobs.iter().any(reported)
		|| vp.mode.dialect() != Dialect::Bash
		|| vp.parent.is_some()
		|| vp.trap_frames != 0
		|| !exec::job_control(k, cx, vp)
		|| !misc_is(cx, vp, MiscKey::Interactive, b"1")
		|| state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false)
	{
		return;
	}
	cleanup_dead_jobs(k, cx, vp);
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
/// of the innermost `for`, `select`, `case` or arithmetic `for` around it
/// (in a forked process's own code); else, in a function, the line its body
/// starts on; in a forked process, the line bash had as it forked it
/// ([`fork_line`]); else the line the parser reached reading the complete
/// command (its last line, after any here-document bodies).
pub(super) fn wait_line(vp: &Vproc, node: u32) -> u32 {
	let Some(fi) = vp.frames.len().checked_sub(1) else {
		return 0;
	};
	let f = &vp.frames[fi];
	let Some(u) = f.unit.as_ref() else {
		return exec::line_of(vp, node);
	};
	let within = if f.kind == FrameKind::Subshell {
		base_spawn(u, f.pc).and_then(|(s, i)| fork_node(u, s, i))
	} else {
		None
	};
	if let Some(header) = header_around(u, node, within) {
		return exec::line_in(vp, fi, header);
	}
	match &f.kind {
		FrameKind::Function { .. } => body_start(u)
			.map_or_else(|| u.line.saturating_sub(f.line_shift), |body| exec::line_in(vp, fi, body)),
		FrameKind::Script { .. } => script_line(f).unwrap_or(0),
		FrameKind::Subshell => fork_line(f).unwrap_or_else(|| exec::line_of(vp, node)),
		_ => exec::line_of(vp, node),
	}
}

/// The line the parser of script frame `f` reached reading its complete
/// command: that of the next byte, but the newline that ended the command
/// (a virtual one at the end of the input) still counts as its line.
fn script_line(f: &Frame) -> Option<u32> {
	let FrameKind::Script { src, pos, .. } = &f.kind else {
		return None;
	};
	let at = pos.0 as usize;
	let ended_line = at >= src.len() || (at > 0 && src.get(at - 1) == Some(&b'\n'));
	Some((pos.1 - u32::from(ended_line)).saturating_sub(f.line_shift))
}

/// What the base frame of a fork `vp` starts now, running `unit`, records
/// as its line ([`ForkLine`]): [`wait_line`] of `vp`'s command, resolved
/// at once where that needs no search of the unit's syntax nodes, else
/// where `vp` is, for [`fork_line`]. A fork of a fork reads the parent's
/// own line, which it resolves into the parent once (one search for all
/// the parent's forks).
pub(super) fn fork_at(vp: &mut Vproc, unit: &Unit) -> ForkLine {
	let Some(fi) = vp.frames.len().checked_sub(1) else {
		return ForkLine::new(ForkAt::Line(0));
	};
	if vp.frames[fi].kind == FrameKind::Subshell
		&& let Some(line) = fork_line(&vp.frames[fi])
	{
		vp.frames[fi].fork_line = ForkLine::new(ForkAt::Line(line));
	}
	let f = &vp.frames[fi];
	let Some(u) = f.unit.as_deref() else {
		return ForkLine::new(ForkAt::Line(exec::line_of(vp, 0)));
	};
	let node = u.ops.get(f.pc as usize).map_or(0, |op| op.node);
	// Another unit (a stopped zsh job's), zsh's caller's line, or an op past
	// what a record holds: found now.
	if !std::ptr::eq(u, unit) || (fi > 0 && exec::keeps_caller_line(f)) || f.pc > ForkLine::MAX_PC {
		return ForkLine::new(ForkAt::Line(wait_line(vp, node)));
	}
	let pc = f.pc;
	let at = |then, within| ForkLine::new(ForkAt::At { pc, then, within });
	match (&f.kind, f.fork_line.get()) {
		(FrameKind::Function { .. }, _) => ForkLine::new(ForkAt::InFunction { pc }),
		(FrameKind::Script { .. }, _) => at(script_line(f).unwrap_or(0), false),
		(FrameKind::Subshell, ForkAt::Line(line)) => at(line, true),
		(FrameKind::Subshell, _) => at(exec::line_of(vp, node), true),
		_ => at(exec::line_of(vp, node), false),
	}
}

/// The line bash had as it forked the process whose base frame is `f`
/// ([`super::proc::Frame::fork_line`]), found now; `None` for a frame that
/// is no fork's. A line the record names is numbered with `f`'s line shift,
/// its parent's.
pub(super) fn fork_line(f: &Frame) -> Option<u32> {
	let (pc, within, then) = match f.fork_line.get() {
		ForkAt::None => return None,
		ForkAt::Line(line) => return Some(line),
		ForkAt::At { pc, then, within } => (pc, within, Some(then)),
		ForkAt::InFunction { pc } => (pc, false, None),
	};
	let Some(u) = f.unit.as_deref() else {
		return then;
	};
	let shift = f.line_shift;
	let line =
		|node: u32| (u.line + u.nodes.get(node as usize).map_or(0, |n| n.line)).saturating_sub(shift);
	let node = u.ops.get(pc as usize).map_or(0, |op| op.node);
	let within = if within {
		base_spawn(u, pc).and_then(|(s, i)| fork_node(u, s, i))
	} else {
		None
	};
	Some(
		header_around(u, node, within)
			.map(line)
			.or(then)
			.unwrap_or_else(|| body_start(u).map_or_else(|| u.line.saturating_sub(shift), line)),
	)
}

/// bash's `line_number` as the base frame of a fork runs the redirections
/// of compound command `node` (the line an error of them names): the line
/// of a `for`, `select`, `case` or arithmetic `for` around it inside the
/// fork's own command, else the line bash had as it forked the process
/// ([`wait_line`]; a simple command's own line does not outlast it). The
/// fork's line, once found, stays in the frame; no header is searched for
/// while the frame runs no loop and no `case`. `None` outside such a frame,
/// in a substitution's own process and in zsh.
pub(super) fn compound_fork_line(vp: &mut Vproc, node: u32) -> Option<u32> {
	let f = vp.frames.last_mut()?;
	if f.kind != FrameKind::Subshell
		|| vp.jobs.comsub == Comsub::Own
		|| f
			.unit
			.as_deref()
			.is_none_or(|u| u.mode.dialect() != Dialect::Bash)
	{
		return None;
	}
	if let Some(line) = fork_line(f) {
		f.fork_line = ForkLine::new(ForkAt::Line(line));
	}
	let f = vp.frames.last()?;
	if f.loops.is_empty() && f.cases.is_empty() {
		return Some(fork_line(f).unwrap_or_else(|| exec::line_of(vp, node)));
	}
	Some(wait_line(vp, node))
}

/// The subshell, background job, pipeline stage or coprocess whose code
/// holds `pc`, the innermost one (a child vproc's base frame runs its own
/// code, not that of a nested one), with the stage's index.
pub(super) fn base_spawn(u: &Unit, pc: u32) -> Option<(&SpawnIr, usize)> {
	u.spawns
		.iter()
		.flat_map(|s| {
			s.stages.iter().enumerate().filter_map(move |(i, st)| {
				let end = s.stages.get(i + 1).map_or(s.end, |next| next.entry);
				(st.entry <= pc && pc < end).then_some((s, i, st.entry))
			})
		})
		.max_by_key(|&(.., entry)| entry)
		.map(|(s, i, _)| (s, i))
}

/// The syntax node of stage `i` of `s`: a pipeline's stage (the node of the
/// `SubExit` ending its code), else the whole command (the `Spawn`'s: the
/// `( … )`, the job's list).
pub(super) fn fork_node(u: &Unit, s: &SpawnIr, i: usize) -> Option<u32> {
	let pc = if s.kind == SpawnKind::Pipeline {
		s.stages.get(i + 1).map_or(s.end, |next| next.entry)
	} else {
		s.stages.first()?.entry
	};
	Some(u.ops.get(pc.checked_sub(1)? as usize)?.node)
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
/// `node` (not `node` itself: a loop's own redirections are applied before
/// it runs), inside node `within` when given (a forked process's command).
fn header_around(u: &Unit, node: u32, within: Option<u32>) -> Option<u32> {
	#[cfg(test)]
	HEADER_SEARCHES.with(|n| n.set(n.get() + 1));
	let n = u.nodes.get(node as usize)?;
	let (lo, hi) = within
		.and_then(|w| u.nodes.get(w as usize))
		.map_or((0, u32::MAX), |w| (w.lo, w.hi));
	u.nodes
		.iter()
		.enumerate()
		.filter(|&(i, m)| {
			matches!(m.kind, NodeKind::For | NodeKind::Select | NodeKind::Case | NodeKind::ArithFor)
				&& i != node as usize
				&& m.lo <= n.lo
				&& n.hi <= m.hi
				&& lo <= m.lo
				&& m.hi <= hi
		})
		.max_by_key(|(_, m)| m.lo)
		.and_then(|(i, _)| u32::try_from(i).ok())
}

#[cfg(test)]
thread_local! {
	/// The searches [`header_around`] made on this thread.
	static HEADER_SEARCHES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The command of node `node` as bash prints it in the notice, the bodies
/// of the here-documents of its redirections `redirs` (a `redirs` index)
/// included. The node's text holds none (they follow its line), so
/// [`exec::job_text`] prints each document empty: its delimiter lines end
/// the text, and the bodies the IR keeps go before them.
fn command_text(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	u: &Unit,
	node: u32,
	redirs: Option<u32>,
) -> Vec<u8> {
	let printed = exec::job_text(k, cx, vp, u, node);
	let bodies: Vec<&[u8]> =
		redirs
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

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::HEADER_SEARCHES;
	use crate::testkit::{FakeHost, Fault, run_script};

	/// `src` run in-process: its standard output and error, and how many
	/// searches of a unit's syntax nodes it made ([`super::header_around`]).
	fn searches(src: &str) -> (String, String, u64) {
		HEADER_SEARCHES.with(|n| n.set(0));
		let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
		let made = HEADER_SEARCHES.with(Cell::get);
		(
			String::from_utf8_lossy(&out.stdout).into_owned(),
			String::from_utf8_lossy(&out.stderr).into_owned(),
			made,
		)
	}

	/// The fourth review's measurement in small: a function of many
	/// commands whose loop forks a pipeline's two stages again and again. A
	/// fork records where its parent was, and searches the unit's syntax
	/// nodes for its line only when a notice or an error names it
	/// ([`super::fork_line`]): here never (each of the 600 stage forks
	/// searched before). A stage's `( … )` that `QUIT` kills names its line
	/// (the `for` header's, as bash 5.3.20 does): the search happens then.
	#[test]
	fn a_fork_searches_for_its_line_only_when_a_notice_names_it() {
		let body = ":\n".repeat(2_000);
		let quiet = format!("f() {{\n{body}for ((i=0;i<300;i++)); do : | :; done; echo end; }}; f");
		assert_eq!(searches(&quiet), ("end\n".to_owned(), String::new(), 0));
		let killed = format!(
			"f() {{\n{body}for i in 1\ndo : | {{ ( kill -QUIT $BASHPID ); echo a; }}; done; }}; f"
		);
		let (out, err, made) = searches(&killed);
		assert_eq!(out, "a\n");
		assert!(err.starts_with("bash: line 2002: "), "{err:?}");
		assert!(made > 0, "the notice's line is searched for");
	}
}
