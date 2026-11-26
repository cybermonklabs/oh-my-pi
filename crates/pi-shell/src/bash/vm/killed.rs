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
//! At the same points bash marks reported, with no notice, each finished
//! job it gives no notice of ([`mark_unreported`]), and the cleanup deletes
//! it, its status kept for `wait PID`: in a `( … )`, a background job or a
//! pipeline's stage of a `-c` shell, every one, `$!`'s too; in a command or
//! process substitution's own process, and in posix mode in any fork of a
//! `-c` shell, every one but `$!`'s; in a posix `-c` shell itself, each one a
//! signal killed but `$!`'s. Never one a SIGINT, SIGTERM or SIGPIPE killed,
//! nor one a signal the shell traps killed. So `( a & b & …; x=$(jobs);
//! jobs )` lists no finished job, where the `-c` shell itself keeps them, and
//! so does a script file's shell, or a fork of it outside a substitution.
//!
//! Each of these points, the end of a `wait`, each fork (`stop_pipeline`) and
//! each loop iteration (`REAP`: also when `break` or `continue` ends the
//! body; not at a `return`) deletes the finished jobs already reported
//! ([`cleanup_dead_jobs`]). Nothing reports and nothing is deleted while the
//! job list is frozen: in a `CHLD` trap the `wait` builtin runs (not in posix
//! mode, where the trap ends the `wait`), in an `INT` trap bash runs as the
//! forked foreground job it waited for ends, and in a pipeline's last stage
//! the shell runs itself (`lastpipe`) ([`Vproc::jobs_frozen`]); in a function
//! substitution (`${ …; }`) jobs are reported but none deleted
//! ([`Vproc::jobs_kept`]). The next cleanup point outside deletes what was
//! reported meanwhile. `TERM` and a trapped signal there say nothing. A posix
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
		Comsub, FrameKind, JobProc, JobProcs, JobState, LoopKind, LoopRec, PendingWrite, ProcState,
		ScriptKind, Vproc,
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

/// The spaces after the description `desc` ([`LONGEST_SIGNAL_DESC`]): a
/// notice's, and `jobs`'s after a job's status.
pub(super) const fn padding(desc: &str) -> usize {
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
	if vp.frames.last().and_then(|f| f.unit.as_ref()).is_none() {
		return quiet;
	}
	let text = external_text(k, cx, vp, op);
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
			let shown = |end| ended_text(end, posix, platform);
			let Some((pid, ended, lines)) = process_lines(&procs, shown, b"") else {
				return;
			};
			long_notice(k, cx, vp, wait_line(vp, node), pid, &ended, &lines)
		},
	};
	vp.out.push_back(PendingWrite::new(2, bytes.into()));
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
pub(super) fn short_notice(status: &str, text: &[u8]) -> Vec<u8> {
	let mut bytes = format!("{status}{:w$}", "", w = padding(status)).into_bytes();
	bytes.extend_from_slice(text);
	bytes.push(b'\n');
	bytes
}

/// How a process of a job shows once it is not running (bash
/// `printable_job_status` of a dead or stopped job): the description of the
/// signal that killed or stopped it, `Done` for an exit with 0, else `Exit N`
/// (in posix mode `Done(N)`). Read from how it ended, never from a status:
/// an exit with 137 is `Exit 137`.
pub(super) fn ended_text(state: ProcState, posix: bool, platform: Platform) -> String {
	match state {
		ProcState::Killed(sig) | ProcState::Stopped(sig) => sig.description(platform),
		ProcState::Exited(0) => String::from("Done"),
		ProcState::Exited(status) if posix => format!("Done({status})"),
		ProcState::Exited(status) => format!("Exit {status}"),
		ProcState::Running => String::from("Running"),
	}
}

/// What bash prints of a job of processes `procs` (`print_pipeline` with
/// `JLIST_LONG`: `jobs -l`, and the long notice [`long_notice`] of
/// `pretty_print_job` with `JLIST_NONINTERACTIVE`), `tail` after the last
/// command: the first process's pid, how it shows (`shown` of its state),
/// and its command, then a line for each other process: five spaces, its
/// pid as `%5ld`, how it shows (nothing where its state is the first's,
/// which pads as `| `'s two columns) padded ([`padding`]), `| ` and its
/// command. `None` without processes.
pub(super) fn process_lines(
	procs: &[JobProc],
	shown: impl Fn(ProcState) -> String,
	tail: &[u8],
) -> Option<(u32, String, Vec<u8>)> {
	let (first, rest) = procs.split_first()?;
	let mut lines = first.text.to_vec();
	for p in rest {
		let status = if p.state == first.state {
			String::new()
		} else {
			shown(p.state)
		};
		let w = padding(if status.is_empty() { "| " } else { &status });
		lines.extend_from_slice(format!("\n     {:>5} {status}{:w$}| ", p.pid(), "").as_bytes());
		lines.extend_from_slice(&p.text);
	}
	lines.extend_from_slice(tail);
	Some((first.pid(), shown(first.state), lines))
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
pub(super) fn subshell_exec(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> bool {
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
				|| (u.tails.binary_search(&op.node).is_ok()
					&& !forks_for_traps(k, cx, vp).unwrap_or(true))
		},
		Some((s, i)) if matches!(s.kind, SpawnKind::Background | SpawnKind::Pipeline) => {
			s.stages[i].entry == f.pc
		},
		_ => true,
	}
}

/// Whether a trap makes bash fork a `( … )`'s last command
/// (`should_optimize_fork`): a signal trap with an action set in the
/// subshell (an inherited one is reset there, an ignoring one does not
/// count), its own EXIT trap, the ERR trap if it set it or `errtrace` is on,
/// and in a function the RETURN trap if it set it or `functrace` is on.
fn forks_for_traps(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Result<bool, StoreError> {
	let set = |cx: &mut Cx<'_>, key| -> Result<bool, StoreError> {
		Ok(matches!(
			state::record(cx.store, vp, Key::Trap(key))?,
			Some(Record::Trap { action, .. }) if !action.is_empty()
		))
	};
	let runs = |k: &mut Kernel, cx: &mut Cx<'_>, key, opt| -> Result<bool, StoreError> {
		Ok(set(cx, key)? && (vp.own_traps.has(key) || state::option(&mut k.root, cx.store, vp, opt)?))
	};
	if (vp.own_traps.has(TrapKey::Exit) && set(cx, TrapKey::Exit)?)
		|| runs(k, cx, TrapKey::Err, OptId::Errtrace)?
		|| (!vp.calls.is_empty() && runs(k, cx, TrapKey::Return, OptId::Functrace)?)
	{
		return Ok(true);
	}
	for sig in Signal::iter() {
		if set(cx, TrapKey::Signal(sig))? {
			return Ok(true);
		}
	}
	Ok(false)
}

/// A foreground subshell (`( … )`) of `vp`, vproc `child`, died of `sig`:
/// bash reports it as it reports a foreground command ([`notice`]), naming
/// the subshell's text (with its `!`), from a subshell too (bash 5.3.20:
/// `( ( kill -QUIT $BASHPID ); : )` prints the inner one's notice), on the
/// shell's own standard error: once the `( … )`'s own redirections are
/// undone ([`Kernel::held_notices`], written by its `PopRedir`), at once
/// without any. A pipeline's stage and a substitution are no such child,
/// and a substitution's own process says nothing.
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
	// but not one that is the whole command of a subshell `vp` is: bash runs
	// that `!` as the subshell's own (`execute_in_subshell` takes
	// `CMD_INVERT_RETURN` off the command it runs).
	let mut end = spawn.end + 1;
	if redir.is_some() {
		end += 1;
	}
	let whole = vp.frames.len() == 1
		&& vp.parent.is_some()
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
	if redir.is_some() {
		let depth = u32::try_from(vp.frames.len()).unwrap_or(u32::MAX);
		k.held_notices.push((vp.vpid, depth, BString::from(bytes)));
	} else {
		vp.out.push_back(PendingWrite::new(2, bytes.into()));
	}
}

/// `vp` undid the redirections of a command of its frame at depth `depth`
/// (`PopRedir`): a notice [`subshell_ended`] held for it goes to the
/// shell's own standard error now.
pub(super) fn redirections_undone(k: &mut Kernel, vp: &mut Vproc, depth: u32) {
	if k.held_notices.is_empty() {
		return;
	}
	let vpid = vp.vpid;
	let mut i = 0;
	while i < k.held_notices.len() {
		let (v, d, _) = &k.held_notices[i];
		if *v == vpid && *d == depth {
			let (_, _, bytes) = k.held_notices.remove(i);
			vp.out.push_back(PendingWrite::new(2, bytes));
		} else {
			i += 1;
		}
	}
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
/// not yet: the job is this shell's own background job, done, by a signal
/// other than `INT`, `TERM` and `PIPE` that the shell does not trap. bash
/// leaves a job another signal killed unreported, for `jobs`.
fn unreported(cx: &mut Cx<'_>, vp: &Vproc, number: u32) -> Option<Signal> {
	let job = vp.jobs.get(number)?;
	if job.inherited || job.foreground || job.notified || !matches!(job.state, JobState::Done(_)) {
		return None;
	}
	let sig = job.signal?;
	(!matches!(sig, Signal::Int | Signal::Term | Signal::Pipe) && !trapped(cx, vp, sig))
		.then_some(sig)
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
	let wd = wd_note(k, cx, vp, &job.wd);
	let platform = k.engine.config().platform;
	let (pid, desc, tail) = match job.procs.as_deref() {
		None => (job.pid(), sig.description(platform), [job.text.as_slice(), &wd].concat()),
		Some(procs) => {
			let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
			process_lines(&procs.list, |end| ended_text(end, posix, platform), &wd)?
		},
	};
	let bytes = long_notice(k, cx, vp, line, pid, &desc, &tail);
	if let Some(job) = vp.jobs.get_mut(number) {
		job.notified = true;
	}
	Some(bytes)
}

/// `  (wd: DIR)` when the shell's directory is not `wd`, the one a job
/// started in (bash `polite_directory_format`), else nothing.
fn wd_note(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, wd: &[u8]) -> Vec<u8> {
	let mut note = Vec::new();
	if wd != vp.cwd.as_slice() {
		let home = state::lookup(&k.root, cx.store, vp, b"HOME")
			.ok()
			.flatten()
			.and_then(|v| v.as_scalar().map(BString::from));
		note.extend_from_slice(b"  (wd: ");
		let home = home.as_ref().map(|h| h.as_slice());
		note.extend_from_slice(&dirstack::polite(home, wd, false));
		note.push(b')');
	}
	note
}

/// bash's line for job `number` of `vp`, the one `fg` resumed, that a
/// signal killed (`notify_of_job_status` for a foreground job:
/// `print_pipeline` with `JLIST_STANDARD`): how its last process ended,
/// padded, its command and the `  (wd: DIR)` note ([`short_notice`],
/// [`wd_note`]). `None` for a job that has not ended.
pub(super) fn fg_job_line(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	number: u32,
) -> Option<Vec<u8>> {
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let platform = k.engine.config().platform;
	let job = vp.jobs.get(number)?;
	let JobState::Done(status) = job.state else {
		return None;
	};
	let last = job.procs.as_deref().and_then(|procs| procs.list.last());
	let end = last.map_or_else(|| ProcState::ended(status, job.signal), |p| p.state);
	let text = [job.text.as_slice(), &wd_note(k, cx, vp, &job.wd)].concat();
	Some(short_notice(&ended_text(end, posix, platform), &text))
}

/// `wait` (`wait`, `wait ID`, `wait -n`) waited for the job of vproc `vpid`
/// at script line `line` (bash `wait_for`'s `notify_and_cleanup (job)`,
/// `wait_for_any_job`): its notice, for the `wait` command's standard
/// error, when a signal bash reports killed it ([`unreported`]); for a
/// foreground job ([`super::proc::Job::foreground`]) a signal killed while
/// the list was frozen, its own notice ([`foreground_line`]).
pub(super) fn waited(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	vpid: Vpid,
	line: u32,
) -> Option<Vec<u8>> {
	if let Some(job) = vp.jobs.foreground(vpid) {
		let number = job.number;
		if job.notified || job.signal.is_none() || vp.jobs_frozen() {
			return None;
		}
		return foreground_line(k, cx, vp, number, line);
	}
	let number = vp.jobs.by_vpid(vpid)?.number;
	let sig = unreported(cx, vp, number)?;
	if !reports_jobs(k, cx, vp) {
		return None;
	}
	job_line(k, cx, vp, number, sig, line)
}

/// bash's notice of foreground job `number` of `vp`
/// ([`super::proc::Job::foreground`]) that a signal killed while the job
/// list was frozen (a command of a `lastpipe` stage), at script line `line`:
/// `notify_of_job_status` gives it at the first report point outside, as
/// [`notice_form`] decides for any foreground command: the long one as a
/// background job's ([`job_line`]), the short one how it ended and its
/// command (`print_pipeline`). The job is reported now, with a notice or
/// without one.
fn foreground_line(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	number: u32,
	line: u32,
) -> Option<Vec<u8>> {
	let job = vp.jobs.get(number)?;
	let sig = job.signal?;
	let last = job
		.procs
		.as_deref()
		.and_then(|p| p.list.last())
		.map(|p| p.state);
	let text = job.text.clone();
	let bytes = match notice_form(k, cx, vp, sig) {
		Some(Form::Long) => return job_line(k, cx, vp, number, sig, line),
		Some(Form::Short) => {
			let platform = k.engine.config().platform;
			let desc = match last {
				Some(state) => {
					let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
					ended_text(state, posix, platform)
				},
				None => sig.description(platform),
			};
			Some(short_notice(&desc, &text))
		},
		None => None,
	};
	if let Some(job) = vp.jobs.get_mut(number) {
		job.notified = true;
	}
	bytes
}

/// `vp` reads line `line` of its input next (bash `shell_getc`, which
/// first calls `notify_and_cleanup (-1)`): each background job a signal
/// bash reports killed ([`unreported`]) gets its notice on the shell's
/// standard error, in job order, and goes from the table
/// (`cleanup_dead_jobs`; `wait $!` still finds its status).
pub(super) fn line_read(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	if let Some(bytes) = report_all(k, cx, vp, line) {
		vp.out.push_back(PendingWrite::new(2, bytes.into()));
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
/// backquote) of the command at script line `line` (where its syntax node
/// starts), or one of a `${ … }` it does not expand: bash re-parses its text
/// ([`reparsed`]) with its parser at the line after the command's first
/// word, or after a `[[ ]]` or `(( ))` (bash's `line_number` at
/// `make_simple_command`, `make_cond_command`, `make_arith_command`), what
/// the notice names ([`reparse_lines`]).
pub(super) fn expanded(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) {
	if reports_due(vp) {
		let line = line.saturating_add(1).saturating_add(reparse_lines(vp));
		reparsed(k, cx, vp, line);
	}
}

/// Whether a report point has work in `vp`: a finished job to report, or a
/// reported one to delete ([`report_all`]), or in a bash fork or
/// substitution's process any finished job, which it may mark reported
/// without a notice ([`mark_unreported`]; the shell itself marks only one a
/// signal killed).
pub(super) fn reports_due(vp: &Vproc) -> bool {
	let forked =
		vp.mode.dialect() == Dialect::Bash && (vp.image.is_some() || vp.jobs.comsub != Comsub::No);
	let due = |j: &super::proc::Job| forked || j.notified || j.signal.is_some();
	vp.jobs
		.iter()
		.any(|j| matches!(j.state, JobState::Done(_)) && due(j))
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
/// the background jobs a signal bash reports killed ([`unreported`]) and of
/// the foreground ones a signal killed while the list was frozen
/// ([`foreground_line`]), in job order, marked reported, the other finished
/// jobs bash marks reported without a notice ([`mark_unreported`]) and every
/// finished foreground job ([`super::proc::Job::foreground`]:
/// `notify_of_job_status` marks each one it reaches), then the finished jobs
/// reported go ([`cleanup_dead_jobs`]); `None` when nothing is reported.
fn report_all(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<Vec<u8>> {
	let done: Vec<(u32, bool)> = vp
		.jobs
		.iter()
		.filter(|j| j.signal.is_some() && !j.notified && !j.inherited)
		.map(|j| (j.number, j.foreground))
		.collect();
	let mut out = Vec::new();
	if !done.is_empty() {
		let reports = reports_jobs(k, cx, vp);
		let frozen = vp.jobs_frozen();
		for (number, foreground) in done {
			let bytes = if foreground {
				if frozen {
					continue;
				}
				foreground_line(k, cx, vp, number, line)
			} else {
				let Some(sig) = unreported(cx, vp, number).filter(|_| reports) else {
					continue;
				};
				job_line(k, cx, vp, number, sig, line)
			};
			if let Some(bytes) = bytes {
				out.extend_from_slice(&bytes);
			}
		}
	}
	mark_unreported(k, cx, vp);
	if vp.mode.dialect() == Dialect::Bash && !vp.jobs_frozen() {
		vp.jobs.foreground_done_reported();
	}
	cleanup_dead_jobs(vp);
	(!out.is_empty()).then_some(out)
}

/// bash's `notify_of_job_status` (`jobs.c:4565-4687`, a non-interactive
/// shell without job control) for the finished jobs of `vp` it marks
/// reported with no notice, which the cleanup after deletes, each with its
/// status kept for `wait PID` (`delete_job`'s `bgp_add`). Never one a
/// SIGINT, SIGTERM or SIGPIPE killed, nor one a signal the shell traps
/// killed (`4587-4596`, [`trapped_here`]). bash's `startup_state` is 2 in a
/// `-c` shell and in a command or process substitution's process and its
/// forks; in a script file's shell and its other forks it is 0, and that
/// keeps every one a signal did not kill (`4580`), as the `-c` shell itself
/// does (`subshell_environment` 0, `4599`). Then a substitution's own
/// process (`SUBSHELL_COMSUB`), and in posix mode any shell, marks every one
/// but the job `$!` names (`4611-4620`); any other fork marks each one a
/// signal did not kill, `$!`'s too (the catch-all, `4683-4687`), and reports
/// the others ([`unreported`]). None while the job list is frozen
/// ([`Vproc::jobs_frozen`]: `notify_and_cleanup` returns at once); where
/// it only marks (a function substitution, or a fork of a shell running
/// one, [`super::proc::Freeze::Marks`]) bash marks them, and the first
/// cleanup outside deletes them ([`cleanup_dead_jobs`]). None in an
/// interactive shell, nor in zsh.
fn mark_unreported(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	let open = |j: &super::proc::Job| !j.notified && matches!(j.state, JobState::Done(_));
	// The scan of the table last: a frozen list keeps thousands of jobs.
	if vp.mode.dialect() != Dialect::Bash
		|| vp.jobs_frozen()
		|| (vp.jobs.comsub == Comsub::No && !misc_is(cx, vp, MiscKey::RunOrigin, b"c"))
		|| misc_is(cx, vp, MiscKey::Interactive, b"1")
		|| !vp.jobs.iter().rev().any(open)
	{
		return;
	}
	let fork = nested::in_subshell(cx.store, vp);
	let all_but_bang = vp.jobs.comsub == Comsub::Own
		|| state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let shell: &Vproc = vp;
	let mut marks = |j: &super::proc::Job| {
		let quiet = |sig: Signal| matches!(sig, Signal::Int | Signal::Term | Signal::Pipe);
		if j.foreground
			|| j
				.signal
				.is_some_and(|sig| quiet(sig) || trapped_here(cx, shell, sig))
		{
			return false;
		}
		if all_but_bang {
			(fork || j.signal.is_some()) && !shell.last_bg.is(j.vpid)
		} else {
			fork && j.signal.is_none()
		}
	};
	let marked: Vec<(u32, Vpid, u32, i32)> = shell
		.jobs
		.iter()
		.filter_map(|j| match j.state {
			JobState::Done(status) if !j.notified && marks(j) => {
				Some((j.number, j.vpid, j.pid(), status))
			},
			_ => None,
		})
		.collect();
	for (number, vpid, pid, status) in marked {
		if let Some(job) = vp.jobs.get_mut(number) {
			job.notified = true;
		}
		state::save_status(&mut k.root, cx.store, vp, vpid, pid, status);
	}
}

/// bash's `cleanup_dead_jobs`: the finished jobs of `vp` already reported
/// (`J_NOTIFIED`: listed, waited for while the job list was frozen) go from
/// the table, and so does each finished foreground job
/// ([`super::proc::Job::foreground`]) but one a signal bash reports killed
/// that is not reported yet ([`deletable`]), but none while no job may be
/// deleted ([`Vproc::jobs_kept`]: `jobs.c:1310`). A `wait PID` still finds
/// a status `wait` collected ([`super::proc::JobTable::bgp`]) or the
/// process's own. bash only: zsh deletes a job as it reports it. bash calls
/// it at each of its cleanup points: the report points ([`report_all`]),
/// `jobs`, the end of a `wait`, each fork (`stop_pipeline`, `jobs.c:572`)
/// and each loop iteration (`REAP`, `execute_cmd.c:3105`, `3267`, `3606`,
/// `3838`, also as `break` or `continue` ends the body:
/// `exec::break_loops`).
pub(super) fn cleanup_dead_jobs(vp: &mut Vproc) {
	// The scan of the table last: a list no job may leave keeps thousands.
	if vp.mode.dialect() == Dialect::Bash && !vp.jobs_kept() && vp.jobs.iter().any(deletable) {
		vp.jobs.remove_where(deletable);
	}
}

/// Whether bash's `cleanup_dead_jobs` deletes `job` (`jobs.c:1328-1333`):
/// it finished, and it was reported, or it ran in the foreground and no
/// signal bash reports killed it ([`super::proc::Job::killed_reported`]).
pub(super) const fn deletable(job: &super::proc::Job) -> bool {
	matches!(job.state, JobState::Done(_))
		&& (job.notified || (job.foreground && !job.killed_reported()))
}

/// Whether bash's `stop_pipeline` makes a job of a command `vp` forks and
/// waits for (an external, a `( … )`, a pipeline) that outlives the wait:
/// bash makes a job of each, and deletes it as the wait ends
/// (`notify_and_cleanup`), but not while no job may be deleted
/// ([`Vproc::jobs_kept`]). Then `vp` gets that job ([`foreground_job`]).
/// bash only.
pub(super) fn keeps_foreground(vp: &Vproc) -> bool {
	vp.mode.dialect() == Dialect::Bash && vp.jobs_kept()
}

/// The job of a foreground command of `vp` ([`keeps_foreground`]; for a
/// `lastpipe` pipeline's forked stages always, as bash freezes the list
/// before it makes their job): job `id`, vproc `vpid` (a `( … )`'s, a
/// pipeline's first stage, or a fresh one for an external), the command
/// `text` and a pipeline's processes `procs`, each named by its vproc.
/// It takes the next number; `%N` names it, and `jobs` hides it while the
/// list is frozen ([`super::proc::Job::listed_while_frozen`]). It is done as
/// the shell takes in the command's end
/// ([`super::proc::JobTable::foreground_reaped`],
/// [`super::proc::JobTable::external_ended`]).
pub(super) fn foreground_job(
	vp: &mut Vproc,
	id: crate::bash::ids::JobId,
	vpid: Vpid,
	text: BString,
	procs: Option<JobProcs>,
) {
	let cwd = vp.cwd.clone();
	vp.jobs.add_foreground(id, vpid, text, cwd, procs);
}

/// The command of `op`, an external `vp` runs, as bash prints it for its
/// job and its notice (`jobs`, [`killed`]).
pub(super) fn external_text(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, op: Op) -> BString {
	let Some(unit) = vp.frames.last().and_then(|f| f.unit.clone()) else {
		return BString::default();
	};
	let redirs = unit.cmds.get(op.a as usize).and_then(|c| c.redirs);
	BString::from(command_text(k, cx, vp, &unit, op.node, redirs))
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

/// bash `signal_is_trapped` in `vp` itself: in a fork (a subshell, a job, a
/// stage, a substitution's process: bash's `subshell_environment`,
/// [`nested::in_subshell`]), `reset_signal_handlers` (`trap.c:1448-1456`)
/// took off every trap but one that ignores its signal, so there only such a
/// trap counts, or one the fork set itself
/// ([`super::proc::Vproc::own_traps`]); in the shell itself (a nested
/// shell's too) every trap counts ([`trapped`]).
fn trapped_here(cx: &mut Cx<'_>, vp: &Vproc, sig: Signal) -> bool {
	let key = TrapKey::Signal(sig);
	let shell = !nested::in_subshell(cx.store, vp);
	matches!(
		state::record(cx.store, vp, Key::Trap(key)),
		Ok(Some(Record::Trap { action, .. }))
			if shell || action.is_empty() || vp.own_traps.has(key)
	) && !cx.host.ignored_signals().contains(sig)
}

/// bash `signal_is_trapped` in a command substitution's process for `sig`,
/// as `vp` starts it: the child's `reset_signal_handlers` (`trap.c:1448-1456`)
/// takes off every trap but one that ignores its signal (`trap '' SIG`), so
/// only `vp`'s trap with an empty action counts there, unless the signal was
/// ignored when the shell started ([`trapped`]).
pub(super) fn ignored_by_trap(cx: &mut Cx<'_>, vp: &Vproc, sig: Signal) -> bool {
	matches!(
		state::record(cx.store, vp, Key::Trap(TrapKey::Signal(sig))),
		Ok(Some(Record::Trap { action, .. })) if action.is_empty()
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
/// ([`super::proc::Frame::fork_line`]); else the line the parser reached
/// reading the complete command (its last line, after any here-document
/// bodies).
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
		FrameKind::Script { src, pos, .. } => {
			// The parser's line is that of the next byte; the newline that
			// ended the command (a virtual one at the end of the input)
			// still counts as its line.
			let at = pos.0 as usize;
			let ended_line = at >= src.len() || (at > 0 && src.get(at - 1) == Some(&b'\n'));
			(pos.1 - u32::from(ended_line)).saturating_sub(f.line_shift)
		},
		FrameKind::Subshell => f.fork_line.unwrap_or_else(|| exec::line_of(vp, node)),
		_ => exec::line_of(vp, node),
	}
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
/// `node`, inside node `within` when given (a forked process's command).
fn header_around(u: &Unit, node: u32, within: Option<u32>) -> Option<u32> {
	let n = u.nodes.get(node as usize)?;
	let (lo, hi) = within
		.and_then(|w| u.nodes.get(w as usize))
		.map_or((0, u32::MAX), |w| (w.lo, w.hi));
	u.nodes
		.iter()
		.enumerate()
		.filter(|(_, m)| {
			matches!(m.kind, NodeKind::For | NodeKind::Select | NodeKind::Case | NodeKind::ArithFor)
				&& m.lo <= n.lo
				&& n.hi <= m.hi
				&& lo <= m.lo
				&& m.hi <= hi
		})
		.max_by_key(|(_, m)| m.lo)
		.and_then(|(i, _)| u32::try_from(i).ok())
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
