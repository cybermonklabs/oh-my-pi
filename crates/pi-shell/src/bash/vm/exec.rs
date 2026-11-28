//! The dispatch loop (the single place for safepoints and op events), the
//! per-op semantics, and frame control (calls, returns, unwinding).

use std::{
	collections::HashMap,
	fmt::NumBuffer,
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, assign_scope, builtins, command,
	expand::{self, Expander, Stop},
	is_ident, probe,
	proc::{
		AssignValue, Atom, Bang, BangStage, CommandName, Coproc, DebugSkip, Depths, Frame, FrameKind,
		InlineStage, JobProc, JobProcs, LastBg, LoopKind, LoopRec, ParseLevel, ParseSnapshot,
		PendingBreak, PendingSub, PendingWrite, Prefix, Probe, ProbeResult, Run, Saved, Saves,
		Scratch, ScriptKind, Slot, Target, TryEnd, Vproc,
	},
	redir,
	state::{self, Level, Root, Scope, Var, VarMap},
};
use crate::bash::{
	diag::Diag,
	event::{CompiledUnit, Construct, EventData, NodeKind, Origin, WaitKey, assign_preview},
	fd::FdRef,
	fs::FsOp,
	host::{ResolveCtx, Resolved, Via},
	ids::{Dialect, IntrinsicId, ModeId, UnitId, Vpid},
	ir::{self, ComsubForm, Op, Opcode, SpawnKind, Unit},
	mem::{self, Capture},
	pattern::PatOpts,
	signal::SigSet,
	store::{Attrs, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, TrapKey},
	syntax::{CompleteCommand, Features, ParseError, ParseErrorKind, Parser, Pos, Resume},
	zshopt::ZshOpt,
};

/// Result of one op.
pub enum Flow {
	Next,
	Jump(u32),
	/// Park the vproc, keep the pc; the op resumes from its scratch.
	Block(WaitKey),
	/// A frame was pushed; the op resumes (from its scratch) when it pops.
	Call,
	/// The current frame's unit ended.
	EndUnit,
	/// A syntax error or unsupported construct: abandon the innermost script.
	Abort(i32),
	/// `return n`.
	Return(i32),
	/// `break n` / `continue n`.
	Break {
		n:    u32,
		cont: bool,
	},
	/// `exit n` (also a fatal expansion error), by this jump ([`Jump`]).
	Exit(i32, Jump),
	/// An expansion or arithmetic error: abandon the current top-level command.
	Discard(i32),
	/// bash's `top_level_cleanup` then `jump_to_top_level (DISCARD)` (a
	/// builtin's `no_args`, an arithmetic subscript error): every `eval`, `.`
	/// and trap action is left too, then a `-c` string ends and a script
	/// drops the rest of its line and goes on with the next one.
	DiscardTop(i32),
}

/// Run vproc `vp` for up to `slice` ops; stops early when it parks, a
/// script finishes, a control request arrives or a store fault is pending.
pub fn run_slice(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, slice: u32, ops: &mut u32) {
	let mut n = 0u32;
	// The running unit, held across ops: consecutive ops of one unit reuse
	// it instead of an `Arc` increment and decrement per op (xeon profile:
	// `run_slice` self 6–15 % on loop/func/dbl_bracket).
	let mut held: Option<Arc<Unit>> = None;
	// A job that has ended (no run and no frame left) still deciding its pid,
	// with signals `kill` held for it, writes nothing it queued: the shell's
	// reap gives it the signals first (`Shell::adopt`), as bash's child took
	// them before it traced or reported anything.
	if vp.runs.is_empty() && vp.frames.is_empty() && !k.bangs.is_empty() && k.holds(vp.vpid) {
		return;
	}
	// Time passed since the last turn (`Kernel::clock`).
	k.clock_stale();
	// An ended vproc (no run, no frame) gets turns only to finish writing
	// what it queued ([`Vproc::has_work`]): its last message, which a writer
	// thread may still hold. Nothing else runs in it: no trap, no suspend.
	if !vp.has_code() {
		if !k.root.has_fault() {
			let at = k.ctl.wakes();
			match flush_out(k, vp) {
				Some(fd) => park(k, cx, vp, WaitKey::Write { fd }, at),
				None => unblock(k, cx, vp),
			}
		}
		return;
	}
	// A process of the shell's foreground job stopped while it waited for
	// something else: the job is suspended before anything else runs.
	if k.jobctl.has_fg_stop() {
		super::jobctl::pending_suspend(k, cx, vp);
	}
	loop {
		if k.root.has_fault() {
			return;
		}
		// A job deciding its pid that holds signals `kill` sent it writes
		// nothing before it takes them (`Kernel::take_held`): bash's child
		// had them before it traced or reported anything.
		if !vp.out.is_empty() && (k.bangs.is_empty() || !k.holds(vp.vpid)) {
			let at = k.ctl.wakes();
			match flush_out(k, vp) {
				Some(fd) => return park(k, cx, vp, WaitKey::Write { fd }, at),
				None => unblock(k, cx, vp),
			}
		}
		// A builtin parked on its take-in (`Kernel::asking`) is still in its
		// command, with the command's redirections: a trap waits until the
		// command is over, as bash runs a trap between commands.
		if vp.pending_traps != crate::bash::signal::SigSet::EMPTY
			&& !vp.waiting_foreground()
			&& !k.asking(vp.vpid)
		{
			let pending = vp.pending_traps.iter().find(|sig| {
				!vp.frames.iter().any(|frame| {
					matches!(frame.kind, FrameKind::Script {
						what: ScriptKind::Trap { key: TrapKey::Signal(active), .. },
						..
					} if active == *sig)
				})
			});
			if let Some(sig) = pending {
				vp.pending_traps = vp.pending_traps.without(sig);
				// One run per finished child (bash `run_sigchld_trap`): the next
				// waits until this one is done. zsh's run is its job's.
				if sig == crate::bash::signal::Signal::Chld {
					vp.jobs.chld = vp.jobs.chld.saturating_sub(1);
					if vp.jobs.chld > 0 {
						vp.pending_traps = vp.pending_traps.with(sig);
					}
					if let Some(z) = vp.zsh.as_mut() {
						z.chld_own = z.chld_jobs.pop_front();
					}
				}
				let started = start_trap(k, vp, cx, TrapKey::Signal(sig));
				// The mark is the trap run's (it took it if it started).
				if sig == crate::bash::signal::Signal::Int {
					k.frozen_ints.retain(|v| *v != vp.vpid);
				}
				if started {
					continue;
				}
			}
		}
		if let Some(rare) = vp.rare.as_deref_mut()
			&& !rare.restore_opts.is_empty()
		{
			for saved in std::mem::take(&mut rare.restore_opts) {
				if let Err(err) = state::restore_set_options(&mut k.root, cx.store, vp, &saved) {
					k.fail(err);
				}
			}
			continue;
		}
		let Some(top) = vp.frames.last() else {
			if !run_boundary(k, vp, cx) {
				return;
			}
			continue;
		};
		if top.unit.is_none() {
			// Reading and parsing the next command take time.
			k.clock_stale();
			let at = k.ctl.wakes();
			// zsh `zexit`: its base frame is on top; the next hook runs.
			if vp.zsh.is_some() && super::zsh::zexit::at_base(vp) {
				match super::zsh::zexit::advance(k, cx, vp) {
					Some(key) => return park(k, cx, vp, key, at),
					None => unblock(k, cx, vp),
				}
				continue;
			}
			match next_command(k, vp, cx) {
				Some(key) => return park(k, cx, vp, key, at),
				None => unblock(k, cx, vp),
			}
			continue;
		}
		// The safepoint: one relaxed load of the control word per op.
		// `no-safepoint-check` (measurement only, off by default)
		// compiles it out for the overhead comparison; `Shell::step` still
		// checks once per slice.
		if (cfg!(not(feature = "no-safepoint-check")) && k.ctl.word() != 0) || n >= slice {
			return;
		}
		n += 1;
		*ops += 1;
		let at = k.ctl.wakes();
		let frame = vp.frames.last().expect("checked above");
		// A suspended job's base frame ends where the shell's pipeline did.
		if let FrameKind::Job { stop_at } = frame.kind
			&& stop_at == frame.pc
		{
			end_unit(k, vp, cx);
			continue;
		}
		let current = frame.unit.as_ref().expect("checked above");
		if !held.as_ref().is_some_and(|u| Arc::ptr_eq(u, current)) {
			announce(k, cx, vp.vpid, vp.runs.front(), current, current.line);
			held = Some(Arc::clone(current));
		}
		let unit = held.as_ref().expect("just set");
		let op = unit.ops[frame.pc as usize];
		let fi = vp.frames.len() - 1;
		// A `break` or `continue` that ran inside `${ }` or `${| }` waits
		// for a loop (bash's `breaking`): the command holding it has
		// finished, and no other command runs before a loop takes it.
		if vp.pending_break.is_some()
			&& vp.frames[fi].scratch.is_none()
			&& unit.mode.dialect() == Dialect::Bash
			&& pending_break(k, vp, cx)
		{
			continue;
		}
		// Control flow of a bash unit: it starts no command, cannot fail as
		// one or block, and keeps the clock, so none of the bookkeeping
		// below applies to it.
		if unit.mode.dialect() == Dialect::Bash
			&& vp.frames[fi].scratch.is_none()
			&& let Some(flow) = control_flow(k, cx, vp, unit, op)
		{
			vp.frames[fi].debug_pc = None;
			unblock(k, cx, vp);
			if !vp.procsubs().is_empty() {
				close_procsubs(vp, fi);
			}
			let frame = top_frame(vp);
			frame.pc = match flow {
				Flow::Jump(target) => target,
				_ => frame.pc + 1,
			};
			continue;
		}
		// A zsh list marker: the DEBUG trap point before or after a list.
		if op.code == Opcode::Nop && unit.mode.dialect() == Dialect::Zsh {
			let ran = vp.frames[fi].debug_pc == Some(vp.frames[fi].pc);
			if !ran && zsh_debug_trap(k, vp, cx, unit, op) {
				continue;
			}
			unblock(k, cx, vp);
			let frame = top_frame(vp);
			frame.debug_pc = None;
			frame.pc += 1;
			continue;
		}
		// bash runs the DEBUG trap of a background simple command, and of
		// each simple stage of a pipeline (also a background one), in the
		// shell before it forks: every stage's trap first, then the fork
		// ([`spawn`] marks each stage's command as having run it).
		if op.code == Opcode::Spawn
			&& unit.mode.dialect() == Dialect::Bash
			&& vp.frames[fi].scratch.is_none()
			&& vp.frames[fi].debug_pc != Some(vp.frames[fi].pc)
			&& pseudo_trap_maybe(k, cx, TrapKey::Debug)
		{
			let done = spawn_debug_done(vp.frames[fi].debug_pc);
			// A new run of this Spawn's stage traps: a skip list this vproc
			// left at this frame or deeper (its `Spawn` never ran, as after
			// a trap's `return`) is stale, and bash keeps a skip only for the
			// command whose trap failed. Dropped also when this Spawn has no
			// simple stage (each stage compound, no trap runs here), whose
			// `Spawn` would otherwise take that list; kept for the pipeline a
			// background job is, which takes the list the shell recorded for
			// it ([`shell_ran_stage_traps`]). This runs also once the trap is
			// gone: `pseudo_trap_maybe` keeps answering yes after a DEBUG
			// trap was set, and no skip list exists before one was.
			if done == 0 && !shell_ran_stage_traps(k, vp, unit, op, vp.frames[fi].pc) {
				drop_debug_skips(k, vp.vpid, fi);
			}
			let next = shell_debug_stages(k, vp, unit, op, vp.frames[fi].pc)
				.into_iter()
				.enumerate()
				.nth(done);
			if let Some((i, entry)) = next {
				vp.frames[fi].debug_pc = Some(SPAWN_DEBUG - u32::try_from(i + 1).unwrap_or(MAX_STAGES));
				// The stage's `Exec`, past its words' substitution bodies.
				let stage_op = unit.ops[skip_blocks(unit, entry) as usize];
				note_command(vp, unit, stage_op);
				let line = line_of(vp, stage_op.node);
				if start_trap(k, vp, cx, TrapKey::Debug) {
					set_trap_line(vp, line);
				}
				continue;
			}
			vp.frames[fi].debug_pc = Some(vp.frames[fi].pc);
		}
		let starts = starts_command(unit, op);
		let fresh = vp.frames[fi].scratch.is_none();
		if fresh && starts {
			note_command(vp, unit, op);
		}
		// bash's DEBUG trap: before a simple command, `[[ ]]`, `(( ))`, each
		// arith-for expression, a `case` or `select` command and each `for`
		// iteration that assigns a word. zsh's runs at its list markers.
		let debug_point = unit.mode.dialect() == Dialect::Bash
			&& (starts
				|| match op.code {
					Opcode::Arith => unit
						.nodes
						.get(op.node as usize)
						.is_some_and(|n| n.kind == NodeKind::ArithFor),
					Opcode::CaseWord => true,
					Opcode::ForIn => op.flags & Op::SELECT != 0,
					Opcode::ForNext => vp.frames[fi].loops.last().is_some_and(
						|r| matches!(&r.kind, LoopKind::For { items, next, .. } if (*next as usize) < items.len()),
					),
					_ => false,
				});
		if debug_point && vp.frames[fi].debug_pc != Some(vp.frames[fi].pc) {
			vp.frames[fi].debug_pc = Some(vp.frames[fi].pc);
			if pseudo_trap_maybe(k, cx, TrapKey::Debug) {
				let line = line_of(vp, op.node);
				if start_trap(k, vp, cx, TrapKey::Debug) {
					set_trap_line(vp, line);
					continue;
				}
			}
		}
		if fresh && starts {
			vp.frames[fi].err_reported = false;
		}
		// A cancel trap is a trap frame: none on the stack, no scan.
		let cancellation = if vp.trap_frames == 0 {
			None
		} else {
			vp.frames.iter().rev().find_map(|f| match f.kind {
				FrameKind::Script { what: ScriptKind::Trap { cancel: Some(status), .. }, .. } => {
					Some(status)
				},
				_ => None,
			})
		};
		if k.clock.is_some() && !keeps_clock(op.code) {
			k.clock_stale();
		}
		// The hottest ops straight to their handlers, past `dispatch`'s
		// frame.
		let bash = unit.mode.dialect() == Dialect::Bash;
		let flow = if bash && op.code == Opcode::Exec {
			command::exec(k, vp, cx, unit, op, line_of(vp, op.node))
		} else if bash
			&& op.code == Opcode::Arith
			&& let Some(flow) = plain_arith(k, vp, cx, unit, op)
		{
			flow
		} else {
			dispatch(k, vp, cx, unit, op)
		};
		// A glob's shell-code qualifier (`(e:…:)`) runs its code above the
		// op once the op has put its state back ([`VprocZsh::glob_hook`]);
		// an op that did not pass the call on drops it.
		if let Some(z) = vp.zsh.as_deref_mut()
			&& let Some((src, hook_line)) = z.glob_hook.take()
			&& matches!(flow, Flow::Call)
		{
			push_script(vp, &src, hook_line, ScriptKind::Hook);
		}
		// Nothing failed and control goes on: no ERR trap, errexit or
		// transfer to decide (every check below starts from a failure or a
		// transfer), only the op's state to drop.
		if vp.status == 0 && matches!(flow, Flow::Next | Flow::Jump(_)) {
			if let Some(frame) = vp.frames.get_mut(fi) {
				frame.debug_pc = None;
			}
			unblock(k, cx, vp);
			end_op(k, cx, vp, fi);
			let frame = top_frame(vp);
			frame.pc = match flow {
				Flow::Jump(target) => target,
				_ => frame.pc + 1,
			};
			continue;
		}
		let ignore_errexit =
			op.flags & Op::COND != 0 || vp.frames.get(fi).is_some_and(|frame| frame.ignore_errexit);
		if matches!(flow, Flow::Call) && ignore_errexit {
			// Frames the op pushed (function, `eval`, `source`, `${ ;}`)
			// run in its context.
			for frame in vp.frames.iter_mut().skip(fi + 1) {
				frame.ignore_errexit = true;
			}
		}
		// An `exit N` in the cancel trap is `exit_shell`'s (the EXIT trap, then
		// status N, as bash).
		let cancel_transfer = cancellation.is_some()
			&& matches!(
				flow,
				Flow::Return(_) | Flow::Abort(_) | Flow::Discard(_) | Flow::DiscardTop(_)
			);
		let failing = !ignore_errexit && vp.status != 0 && matches!(flow, Flow::Next | Flow::Jump(_));
		let failed_command = failing
			&& match op.code {
				Opcode::Spawn => true,
				// zsh: a call whose body already ran the ZERR trap does not
				// run it again (`donetrap`).
				Opcode::Exec => {
					unit.mode.dialect() == Dialect::Bash
						|| !vp.frames.get(fi).is_some_and(|frame| frame.err_reported)
				},
				Opcode::CallAnon => !vp.frames.get(fi).is_some_and(|frame| frame.err_reported),
				Opcode::Redir => matches!(flow, Flow::Jump(_)),
				Opcode::Leave | Opcode::Arith | Opcode::CondTest => {
					!vp.frames.get(fi).is_some_and(|frame| frame.err_reported)
				},
				_ => false,
			};
		// `set -e` exits on a failed simple command, subshell, pipeline,
		// compound redirection, `[[ ]]` or `(( ))`; not on other compound
		// commands, whose status comes from a command already judged.
		let zsh_unit = unit.mode.dialect() == Dialect::Zsh;
		let judged = (failing || (zsh_unit && vp.status != 0))
			&& match op.code {
				Opcode::Exec | Opcode::Spawn | Opcode::CallAnon => true,
				Opcode::Redir => matches!(flow, Flow::Jump(_)),
				Opcode::Leave => unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| matches!(n.kind, NodeKind::Cond | NodeKind::Arith)),
				_ => false,
			};
		let errexit_failed = failing && judged;
		// zsh `doshfunc` resets `NOERREXIT_RETURN`: `ERR_RETURN` applies in
		// a function called from a condition (`f || …`), unlike `ERR_EXIT`.
		let errreturn_failed = errexit_failed
			|| (judged
				&& zsh_unit
				&& op.flags & Op::COND == 0
				&& matches!(flow, Flow::Next | Flow::Jump(_))
				&& vp
					.frames
					.get(fi)
					.is_some_and(|f| !f.ignore_errexit || matches!(f.kind, FrameKind::Function { .. })));
		let err_line = if failed_command {
			line_of(vp, op.node)
		} else {
			0
		};
		if !matches!(flow, Flow::Block(_) | Flow::Call)
			&& let Some(frame) = vp.frames.get_mut(fi)
		{
			frame.debug_pc = None;
		}
		if !matches!(flow, Flow::Block(_)) {
			unblock(k, cx, vp);
		}
		// The op is over unless it parks or called a frame: drop its scratch
		// and close its process substitutions.
		if !matches!(flow, Flow::Block(_) | Flow::Call) {
			end_op(k, cx, vp, fi);
		}
		match flow {
			Flow::Next => top_frame(vp).pc += 1,
			Flow::Jump(target) => top_frame(vp).pc = target,
			Flow::Block(key) => return park(k, cx, vp, key, at),
			Flow::Call => {},
			Flow::EndUnit => end_unit(k, vp, cx),
			Flow::Abort(status) => {
				k.top_level_cleanup = false;
				// Abandon the innermost script (the run's, `eval`'s, `source`'s).
				vp.status = status;
				let i = script_frame(vp).unwrap_or(0);
				// zsh: a parse error is status 1; `.` of a file with one is 126
				// (`bin_dot`'s `SOURCE_ERROR`). bash: the messages queued go out
				// through the redirections in effect at the jump.
				if unit.mode.dialect() == Dialect::Zsh {
					vp.status = match vp.frames.get(i).map(|f| &f.kind) {
						Some(FrameKind::Script { what: ScriptKind::Source, .. }) => 126,
						_ => 1,
					};
				} else {
					written_before_the_unwind(k, vp);
				}
				// An interactive shell's own input goes on: the command is
				// dropped and the next one read (zsh `loop`, bash
				// `reader_loop`).
				unwind(&mut k.root, cx.store, vp, i + 1);
				if super::zle::reader::applies(cx, vp) {
					top_frame(vp).unit = None;
				} else {
					unwind(&mut k.root, cx.store, vp, i);
				}
			},
			Flow::Return(status) if unit.mode.dialect() == Dialect::Zsh => {
				zsh_return_flow(k, vp, cx, op, status, ignore_errexit);
			},
			Flow::Return(status) => {
				// bash's `return` sets only `return_catch_value`: `$?` stays
				// as it was until the function or `.` file has returned, so
				// its RETURN trap runs with that `$?` ([`return_trap`]).
				// `${ ;}` ends like a function; a subshell of a function
				// (`( return )`, `$( return )`) exits.
				let target = vp.frames.iter().rposition(|f| {
					matches!(
						f.kind,
						FrameKind::Function { .. }
							| FrameKind::NoFork
							| FrameKind::Script { what: ScriptKind::Source, .. }
					)
				});
				if let Some(i) = target {
					if vp.frames[i].kind == FrameKind::NoFork || !return_trap(k, vp, cx, i, status) {
						vp.status = status;
						unwind(&mut k.root, cx.store, vp, i);
					}
				} else if vp.parent.is_some() && in_function_scope(k, cx, vp) {
					exit_shell(k, vp, cx, status, Jump::Other);
				} else {
					let line = line_of(vp, op.node);
					let diag =
						Diag::Usage { msg: "can only `return' from a function or sourced script".into() };
					k.diag(cx, vp, line, diag.by("return"));
					vp.status = 2;
					top_frame(vp).pc += 1;
				}
			},
			Flow::Break { n, cont } if unit.mode.dialect() == Dialect::Zsh => {
				zsh_break(k, vp, cx, n, cont);
			},
			Flow::Break { n, cont } => break_loops(k, vp, cx, n, cont),
			Flow::Exit(status, _) if unit.mode.dialect() == Dialect::Zsh => {
				zsh_exit(k, vp, cx, status);
			},
			Flow::Exit(status, jump) => {
				report_jump(k, vp, cx, 0, jump);
				exit_shell(k, vp, cx, status, jump);
				k.top_level_cleanup = false;
			},
			Flow::Discard(status) if unit.mode.dialect() == Dialect::Zsh => {
				zsh_discard(k, vp, cx, status);
			},
			Flow::Discard(status) => {
				vp.status = status;
				let cleanup = std::mem::take(&mut k.top_level_cleanup);
				// bash's `parse_and_execute` (the script, `-c`, `eval`, `.`,
				// a trap action) catches the jump: the innermost script goes
				// on with its next command. In a subshell it passes the jump
				// on (`subshell_environment`) to the next catch: a running
				// EXIT trap's `run_exit_trap`, which ends the action, else the
				// subshell's top level, which exits.
				let subshell = super::nested::in_subshell(cx.store, vp);
				let catch = if subshell {
					exit_trap_frame(vp)
				} else {
					script_frame(vp)
				};
				if let Some(i) = catch {
					report_jump(k, vp, cx, i, Jump::Other);
					unwind(&mut k.root, cx.store, vp, i + 1);
					clear_scratch(&mut k.root, cx.store, vp);
					truncate(vp, Depths::default());
					let f = top_frame(vp);
					f.unit = None;
					f.loops.clear();
					if subshell && let FrameKind::Script { src, pos, aux, .. } = &mut f.kind {
						*pos = (src.len() as u32, pos.1);
						if let Some(a) = aux {
							a.pending = None;
						}
					}
				} else {
					report_jump(k, vp, cx, 0, Jump::Other);
					// A subshell's top level exits (bash's
					// `execute_in_subshell`, `command_substitute`) and runs
					// its EXIT trap, in the function context the jump left
					// ([`leave_functions`]): after `top_level_cleanup` (an
					// arithmetic subscript error, an integer variable's bad
					// value, a script's own command) none ([`Jump::Cleanup`]).
					if subshell {
						let jump = if cleanup { Jump::Cleanup } else { Jump::Other };
						exit_shell(k, vp, cx, status, jump);
					} else {
						unwind(&mut k.root, cx.store, vp, 0);
					}
				}
			},
			Flow::DiscardTop(status) => {
				discard_top(k, vp, cx, status);
				k.top_level_cleanup = false;
			},
		}
		if cancel_transfer {
			finish_cancel(&mut k.root, cx.store, vp, cancellation.expect("checked"));
			continue;
		}
		let errexit = errexit_failed
			&& (errexit_on(k, cx, vp)
				|| (unit.mode.dialect() == Dialect::Zsh && zsh_errreturn_exits(k, cx, vp)));
		if failed_command && start_trap(k, vp, cx, TrapKey::Err) {
			set_trap_line(vp, err_line);
			for frame in &mut vp.frames[..fi.saturating_add(1)] {
				frame.err_reported = true;
			}
			if errexit {
				mark_trap_exit(vp);
			}
		} else if errexit {
			let status = vp.status;
			report_jump(k, vp, cx, 0, Jump::Errexit);
			exit_shell(k, vp, cx, status, Jump::Errexit);
		} else if errreturn_failed && unit.mode.dialect() == Dialect::Zsh && zsh_errreturn(k, cx, vp)
		{
			// zsh `ERR_RETURN`: a failed command returns from the function
			// (or `.` file) it runs in.
			let status = vp.status;
			zsh_return(k, vp, cx, status);
		}
	}
}

/// `Flow::Return` of an op of a zsh unit: zsh `bin_break` with `retflag`
/// and `execlist`'s `errexit` handling. Out of line: the bash `run_slice`
/// path does not carry it.
#[inline(never)]
fn zsh_return_flow(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	status: i32,
	ignore_errexit: bool,
) {
	vp.status = status;
	// `${ ;}` ends like a function.
	let target = vp.frames.iter().rposition(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	if status != 0 && !ignore_errexit && errexit_on(k, cx, vp) {
		// zsh `execlist` after `return N` (N ≠ 0) under `errexit`: the ZERR
		// trap runs inside the function, then the shell exits.
		if start_trap(k, vp, cx, TrapKey::Err) {
			set_trap_line(vp, line_of(vp, op.node));
			mark_trap_exit(vp);
		} else {
			exit_shell(k, vp, cx, status, Jump::Other);
		}
	} else if run_always(k, vp, cx, target.unwrap_or(0), TryEnd::Return(status)) {
		// The always-list runs first; it resumes the return.
	} else if let Some(i) = target {
		mark_trap_return(vp, i);
		zsh_leave(k, vp, cx, i);
	} else if let Some(i) = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }))
		.filter(|&i| super::zle::reader::input_frame(cx, vp, i))
	{
		// zsh `bin_break`: under `INTERACTIVE` and `SHINSTDIN` it sets
		// `retflag`, which `loop` clears: the rest of the command line (and
		// a list trap that ran it, p10k's `return 130` on ^C) is dropped and
		// the shell reads its next one.
		unwind(&mut k.root, cx.store, vp, i + 1);
		clear_scratch(&mut k.root, cx.store, vp);
		truncate(vp, Depths::default());
		let f = top_frame(vp);
		f.unit = None;
		f.loops.clear();
		vp.status = status;
		// A trap that ran while the line editor waited for a key: zsh's
		// `getbyte` sees `retflag` and ends the line, as on an untrapped ^C.
		if let Some(ed) = vp.zle.as_deref_mut().and_then(|z| z.ed.as_deref_mut()) {
			ed.aborted = true;
			ed.interrupted = true;
		}
	} else {
		// zsh `bin_break`: `return` outside a function or `.` file leaves
		// a non-interactive shell (`zexit`).
		exit_shell(k, vp, cx, status, Jump::Other);
	}
}

/// zsh `return` from function frame `target`: when a `TRAPNAL` function's
/// trap frame is just below it, that frame records the `return`
/// ([`ScriptKind::Trap`]'s `returned`), so a non-zero status ends the
/// interrupted code.
fn mark_trap_return(vp: &mut Vproc, target: usize) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { returned, .. }, .. },
		..
	}) = target
		.checked_sub(1)
		.and_then(|below| vp.frames.get_mut(below))
	{
		*returned = true;
	}
}

/// The trap just started exits the shell when it ends (`set -e` after the
/// ERR trap): its frame is the innermost trap frame (a zsh `TRAPZERR`
/// function runs above it).
fn mark_trap_exit(vp: &mut Vproc) {
	let trap = vp.frames.iter_mut().rev().find_map(|f| match &mut f.kind {
		FrameKind::Script { what: ScriptKind::Trap { exit, .. }, .. } => Some(exit),
		_ => None,
	});
	if let Some(exit) = trap {
		*exit = true;
	}
}

/// `$LINENO` in a DEBUG or ERR trap action is the line of the trapped
/// command: start the freshly pushed trap script there.
pub fn set_trap_line(vp: &mut Vproc, line: u32) {
	if let Some(Frame { kind: FrameKind::Script { pos, .. }, .. }) = vp.frames.last_mut() {
		pos.1 = line;
	}
}

/// Record the command `op` starts (a simple command, `[[ ]]` or `(( ))`:
/// the caller checked [`starts_command`]) as `BASH_COMMAND`; not while a
/// trap action runs, nor in a DEBUG trap action's command substitution
/// (bash keeps the trapped command).
fn note_command(vp: &mut Vproc, unit: &Arc<Unit>, op: Op) {
	if !runs_no_debug_trap(vp)
		&& (vp.trap_frames == 0
			|| !vp
				.frames
				.iter()
				.any(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. })))
	{
		if let Some((u, node)) = &mut vp.command
			&& Arc::ptr_eq(u, unit)
		{
			*node = op.node;
		} else {
			vp.command = Some((Arc::clone(unit), op.node));
		}
	}
}

/// Whether `op` starts a command bash reports on its own (`BASH_COMMAND`,
/// the ERR trap): a simple command, `[[ ]]` or `(( ))`. The `< file` of a
/// `$(< file)` ([`Op::CAT`]) is none: bash reads the file without running
/// a command (no DEBUG trap, `BASH_COMMAND` stays the outer command's).
fn starts_command(unit: &Unit, op: Op) -> bool {
	match op.code {
		Opcode::Exec => op.flags & Op::CAT == 0,
		Opcode::Enter => unit
			.nodes
			.get(op.node as usize)
			.is_some_and(|n| matches!(n.kind, NodeKind::Cond | NodeKind::Arith)),
		_ => false,
	}
}

/// Whether `vp` runs in a function scope (a store failure reads as no and
/// is kept).
fn in_function_scope(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::in_function(&k.root, cx.store, vp).unwrap_or_else(|err| {
		k.fail(err);
		false
	})
}

/// Whether `set -e` is ignored for the op frame `f` is at: the op is a
/// condition (an `if`/`while`/`until` condition, a `&&`/`||` list except
/// its last command, a `!` pipeline), or the frame runs in one.
pub(super) fn errexit_ignored(f: &Frame) -> bool {
	f.ignore_errexit
		|| f
			.unit
			.as_ref()
			.and_then(|u| u.ops.get(f.pc as usize))
			.is_some_and(|op| op.flags & Op::COND != 0)
}

/// Whether `set -e` is on for `vp`.
fn errexit_on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	match state::option(&mut k.root, cx.store, vp, OptId::Errexit) {
		Ok(on) => on,
		Err(err) => {
			k.fail(err);
			false
		},
	}
}

/// Leave the shell with `status` after `jump` (`exit`, `set -e`, a fatal
/// error): unwind every frame; a subshell runs its EXIT trap here, the root
/// at the run boundary. An `exit` inside a function runs the root's trap
/// first, above the function's frames: bash's trap sees its `FUNCNAME` and
/// locals. After `set -e` left a function bash may have reset the function
/// context first ([`contexts_reset`]): the trap then runs outside it.
fn exit_shell(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32, jump: Jump) {
	// zsh `zexit` while its hooks run: the hook calls end, the status is the
	// new one.
	if vp.zsh.is_some()
		&& let Some(keep) = super::zsh::zexit::exit_in_hooks(vp, status)
	{
		vp.status = status;
		unwind(&mut k.root, cx.store, vp, keep);
		return;
	}
	let in_exit_trap = vp.frames.iter().any(|f| {
		matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { key: TrapKey::Exit, .. }, .. })
	});
	vp.status = status;
	let outside_functions = !in_exit_trap && contexts_reset(k, cx, vp, jump);
	if !in_exit_trap {
		leave_functions(k, cx, vp, jump);
	}
	if vp.parent.is_none()
		&& let Some(run) = vp.runs.front()
	{
		k.exited = Some(run.id);
	}
	if !in_exit_trap
		&& vp
			.frames
			.iter()
			.any(|f| matches!(f.kind, FrameKind::Function { .. }))
		&& match vp.runs.front() {
			Some(r) => r.started && !r.exit_trap_started,
			// A forked subshell has no run: it is its own exit, and its
			// own flag is what keeps the trap from starting twice.
			None => vp.transient && vp.exit_trap_due,
		}
		&& start_exit_trap_once(k, vp, cx)
	{
		if let Some(run) = vp.runs.front_mut() {
			run.exit_trap_started = true;
		}
		// The trap's end exits with `status` (its saved `$?`).
		mark_exit_trap(vp, true, outside_functions);
		return;
	}
	let kept = kept_level(vp);
	unwind(&mut k.root, cx.store, vp, 0);
	// zsh `exit` in a subshell is its `zexit`: the hooks run after its EXIT
	// trap (pushed below them).
	if vp.parent.is_some() && vp.runs.is_empty() && vp.mode.dialect() == Dialect::Zsh {
		super::zsh::zexit::start(k, cx, vp);
	}
	if !in_exit_trap && vp.transient && vp.runs.is_empty() && exit_trap_keeps_level(k, vp, cx, kept)
	{
		mark_exit_trap(vp, false, outside_functions);
	}
}

/// No vpid is left for a command that needs `needed` ([`Kernel::vpids_left`];
/// none is given past [`Vpid::CEILING`] and none twice): the command fails
/// before it builds anything ([`fork_failure`]). `None`: there is room.
pub(super) fn fork_failed(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	needed: u32,
	line: u32,
) -> Option<Flow> {
	(k.vpids_left() < needed).then(|| fork_failure(k, vp, cx, line))
}

/// A command needed a vpid and none is left: what follows when bash cannot
/// fork. bash prints `fork: Resource temporarily unavailable` and leaves
/// as `exit 254` does (the EXIT trap runs; in a subshell only the subshell
/// ends); an interactive shell drops the command instead (bash
/// `throw_to_top_level`). zsh prints `fork failed: …` with its line and
/// abandons the script or subshell with 1 ([`zsh_discard`]), and its EXIT
/// trap does not run, unlike after other errors (zsh 5.9 under `ulimit -u
/// 1`; a `${x:?}` error does run it).
pub(super) fn fork_failure(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Flow {
	fork_message(k, vp, cx, line);
	if vp.mode.dialect() == Dialect::Zsh {
		if let Some(run) = vp.runs.front_mut() {
			run.exit_trap_started = true;
		}
		if vp.transient {
			vp.exit_trap_due = false;
		}
		return Flow::Discard(1);
	}
	let interactive = vp.parent.is_none()
		&& matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		);
	if interactive {
		Flow::Discard(254)
	} else {
		// bash's `throw_to_top_level` runs what `top_level_cleanup` runs
		// (sig.c) before its jump: a jump after it ([`Jump::Cleanup`]).
		Flow::Exit(254, Jump::Cleanup)
	}
}

/// The message of [`fork_failure`] alone, in the vproc's dialect: bash's
/// `fork: Resource temporarily unavailable` (no line), zsh's `fork failed:
/// resource temporarily unavailable` (with its line where zsh prints one).
pub(crate) fn fork_message(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) {
	let diag = if vp.mode.dialect() == Dialect::Zsh {
		Diag::ZshForkFailed
	} else {
		Diag::ForkFailed
	};
	k.diag(cx, vp, line, diag);
}

/// Whether the expansion stopped at `stop` for a substitution that needs a
/// vproc, and no vpid is left for one ([`Kernel::vpids_left`]): a `$( )`
/// that forks (not a `$(< file)`, which [`start_sub`] reads in the shell), a
/// zsh `$(…)` that is not a hook call run in the shell, or a process
/// substitution that already found none ([`Stop::ForkFailed`]). The
/// interactive reader fails such a prompt expansion instead of starting it
/// ([`super::zle::reader`]).
pub(crate) fn no_vpid_for(k: &Kernel, stop: &Stop) -> bool {
	match stop {
		Stop::ForkFailed => true,
		Stop::Sub { form: ComsubForm::Fork, unit, entry, .. } => {
			unit.cat_exec(*entry).is_none() && k.vpids_left() == 0
		},
		Stop::ZshSub { here: false, .. } => k.vpids_left() == 0,
		_ => false,
	}
}

/// zsh `zhandler` for a `HUP` without a trap, `zexit(SIGHUP)`, from the
/// signal itself: the shell exits with status 1 now, after the EXIT trap
/// in effect, and runs no other. It does not wait for the command it runs,
/// which it leaves to the signal. Inside a function that is the
/// function's own EXIT trap, if any: zsh's `starttrapscope` keeps the
/// shell's away while a function runs, and unlike `exit` the signal does
/// not wait for the function to return.
pub fn zsh_hup_exit(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let in_function = vp
		.frames
		.iter()
		.any(|f| matches!(f.kind, FrameKind::Function { .. }));
	release_externals(vp);
	exit_shell(k, vp, cx, 1, Jump::Direct);
	vp.blocked = None;
	vp.stopped = false;
	if in_function {
		spend_exit_trap(vp);
	}
}

/// Let the externals `vp`'s frames wait for outlive it: the shell's own end
/// after a signal it caught leaves its foreground command running, as bash's
/// `termsig_handler` and zsh's `zexit` do ([`crate::bash::ExtProc::release`]);
/// so do the vprocs of that command (`Shell::release_foreground`). Every
/// other end of a vproc (cancel, a host's stop) still ends them.
pub(super) fn release_externals(vp: &mut Vproc) {
	for frame in &mut vp.frames {
		if let Some(sc) = frame.scratch.as_mut()
			&& let super::proc::Live::Ext(ext) = &mut sc.live
		{
			let _ = ext;
		}
	}
}

/// Mark `vp`'s EXIT trap as run: its run's flag, or a forked subshell's
/// own (it has no run). Also the end of a program the shell `exec`ed: the
/// shell's process was the program, so no trap of the shell's is left.
pub(super) fn spend_exit_trap(vp: &mut Vproc) {
	if let Some(run) = vp.runs.front_mut() {
		run.exit_trap_started = true;
	}
	if vp.transient {
		vp.exit_trap_due = false;
	}
}

/// zsh's traps in a new subshell `child` of a zsh shell
/// ([`builtins::trap::zsh_enter_subshell`]): `keep` for a pipeline stage.
fn zsh_subshell_traps(k: &mut Kernel, cx: &mut Cx<'_>, child: &mut Vproc, keep: bool) {
	if child.mode.dialect() == Dialect::Zsh
		&& let Err(err) = builtins::trap::zsh_enter_subshell(&mut k.root, cx.store, child, keep)
	{
		k.fail(err);
	}
}
/// The EXIT trap [`exit_shell`] just started (the top frame): the shell
/// exits when it ends (`exit`; a trap started on the unwound frames ends
/// the vproc anyway), and it runs outside the function context when bash
/// reset it ([`contexts_reset`]).
fn mark_exit_trap(vp: &mut Vproc, exits: bool, outside: bool) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { exit, outside_functions, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*exit |= exits;
		*outside_functions = outside;
	}
}

/// Whether the EXIT trap after `jump` runs with no function context (bash's
/// `variable_context` 0). [`Jump::Cleanup`] comes after bash's
/// `top_level_cleanup`, which sets it to 0 (sig.c:401); `report_error`'s
/// exit and the other exits that are no jump keep it, and so does `exit`,
/// which keeps every level's functions while the trap is set. For the other
/// jumps each `parse_and_execute` level the jump passes (an `eval`, `.` or
/// trap action, a command or process substitution's text, the root's `-c`
/// string), innermost first, keeps its redirections or undoes them, which
/// runs the `pop_context` of each function called inside it
/// (variables.c:5575). Under `set -e` a level that finds the context set
/// keeps them and resets it (`reset_local_contexts`, evalstring.c:388), and
/// one that finds it 0 undoes, which leaves it non-zero (negative) again
/// when a function was called inside it; a script's `reader_loop` then
/// resets it outside posix mode (eval.c:102), while a subshell's
/// `execute_in_subshell` and the `-c` string's `run_one_command` leave it
/// as it is. Every other jump (a posix special builtin's `ERREXIT` without
/// `set -e` too) undoes at every level: the context is 0 when no function
/// was called outside them, nor in the shell the vproc forked from.
fn contexts_reset(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, jump: Jump) -> bool {
	if vp.mode.dialect() == Dialect::Zsh || !function_context(k, cx, vp) {
		return false;
	}
	let errexit = match jump {
		Jump::Cleanup => return true,
		Jump::Exit | Jump::Direct => return false,
		Jump::Errexit => errexit_on(k, cx, vp),
		Jump::Other => false,
	};
	let root = !vp.runs.is_empty();
	let command = runs_command_string(cx, vp);
	let level = |i: usize, f: &Frame| is_parse_level(command, i, f);
	let function = |f: &Frame| matches!(f.kind, FrameKind::Function { .. });
	if !errexit {
		let Some(outer) = outer_parse_level(cx, vp) else {
			return false;
		};
		let inherited = vp
			.calls
			.iter()
			.any(|c| c.depth == 0 && matches!(c.kind, super::callstack::CallKind::Function { .. }));
		return !inherited && !vp.frames[..outer].iter().any(function);
	}
	let mut context = true;
	let mut inner = vp.frames.len();
	for i in (0..vp.frames.len())
		.rev()
		.filter(|&i| level(i, &vp.frames[i]))
	{
		context = !context && vp.frames[i..inner].iter().any(function);
		inner = i;
	}
	if context
		&& root
		&& !command
		&& !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false)
	{
		context = false;
	}
	!context
}

/// Whether `vp` is the root running a `-c` string, whose text bash runs
/// with `parse_and_execute`.
fn runs_command_string(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	!vp.runs.is_empty()
		&& matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
			Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
		)
}

/// Whether frame `i`, `f`, is one of bash's `parse_and_execute` levels: an
/// `eval`, `.` or trap action, a command or process substitution's text,
/// the root's `-c` string (`command`, [`runs_command_string`]).
fn is_parse_level(command: bool, i: usize, f: &Frame) -> bool {
	match f.kind {
		FrameKind::Script { what: ScriptKind::Run, .. } => command && i == 0,
		FrameKind::Script { .. } => true,
		_ => f.flags.parse_level() == ParseLevel::Substitution,
	}
}

/// The outermost `parse_and_execute` level among `vp`'s frames
/// ([`is_parse_level`]).
fn outer_parse_level(cx: &mut Cx<'_>, vp: &Vproc) -> Option<usize> {
	let command = runs_command_string(cx, vp);
	(0..vp.frames.len()).find(|&i| is_parse_level(command, i, &vp.frames[i]))
}

/// The function context bash's jump leaves before the EXIT trap, as
/// frames: each `parse_and_execute` level the jump passes runs its
/// `pe_dispose` unwind frame, which pops the functions called inside it
/// (evalstring.c:398, :425), so for [`Jump::Other`] the frames above the
/// outermost level go. The level's own frame stays: the `eval` or `.`
/// command around the text keeps its redirections, and `.` its `source`
/// on `FUNCNAME`, until the shell exits. `top_level_cleanup` runs every
/// unwind-protect (sig.c:396), so after [`Jump::Cleanup`] every function
/// goes, also those the shell a subshell forked from was running, with
/// their locals. The other jumps keep them (`exit`, no jump; `set -e`,
/// [`contexts_reset`]).
fn leave_functions(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, jump: Jump) {
	if vp.mode.dialect() == Dialect::Zsh {
		return;
	}
	match jump {
		Jump::Other => {
			if let Some(outer) = outer_parse_level(cx, vp) {
				unwind(&mut k.root, cx.store, vp, outer + 1);
			}
		},
		Jump::Cleanup => {
			unwind(&mut k.root, cx.store, vp, vp.frames.len().min(1));
			vp.calls.retain(|c| {
				c.depth > 0
					|| !matches!(
						c.kind,
						super::callstack::CallKind::Function { .. }
							| super::callstack::CallKind::Source { .. }
					)
			});
			while state::drop_scope(&mut k.root, cx.store, vp) {}
		},
		Jump::Exit | Jump::Direct | Jump::Errexit => {},
	}
}

/// Whether a function runs for bash's jumps (`variable_context`): its
/// scope, unless the innermost EXIT trap runs outside the function context
/// ([`contexts_reset`]) and calls none.
fn function_context(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	for f in vp.frames.iter().rev() {
		match f.kind {
			FrameKind::Function { .. } => break,
			FrameKind::Script {
				what: ScriptKind::Trap { key: TrapKey::Exit, outside_functions, .. },
				..
			} => {
				if outside_functions {
					return false;
				}
				break;
			},
			_ => {},
		}
	}
	in_function_scope(k, cx, vp)
}

/// Start this vproc's EXIT trap, at most once for a forked subshell: it has
/// no [`Run`](super::proc::Run) to keep `exit_trap_started` on, and
/// `own_traps`, `trap_frames` and the frame scans all return to their
/// pre-trap values when the trap's frame is popped. A root vproc is
/// unaffected: its guard is its run's own flag, one per shell invocation.
/// A fork bash ends with `sh_exit` runs no trap at all
/// ([`Vproc::exit_trap_due`]).
fn start_exit_trap_once(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> bool {
	if vp.transient {
		if !vp.exit_trap_due {
			return false;
		}
		vp.exit_trap_due = false;
	}
	start_trap(k, vp, cx, TrapKey::Exit)
}

fn top_frame(vp: &mut Vproc) -> &mut Frame {
	vp.frames.last_mut().expect("ops run in a frame")
}

/// Start the next run or finish the current one; `false` when idle.
fn run_boundary(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> bool {
	let Some(run) = vp.runs.front_mut() else {
		return false;
	};
	if run.started && !run.exit_trap_started {
		run.exit_trap_started = true;
		if start_trap(k, vp, cx, TrapKey::Exit) {
			return true;
		}
	}
	// zsh `zexit` after the EXIT trap: the root's script, `-c` string or
	// input ends.
	if vp.parent.is_none()
		&& vp.mode.dialect() == Dialect::Zsh
		&& vp.runs.front().is_some_and(|r| r.started)
		&& super::zsh::zexit::start(k, cx, vp)
	{
		return true;
	}
	let run = vp.runs.front_mut().expect("present");
	if run.started {
		super::zsh::zexit::reset(vp);
		let run = vp.runs.pop_front().expect("present");
		// A run's explicit mode ends with it.
		if let Some(mode) = run.restore_mode {
			super::mode::set_mode(&mut k.root, cx.store, vp, mode);
		}
		end_run(k, vp, cx, &run);
		return false;
	}
	run.started = true;
	if run.explicit_mode {
		run.restore_mode = Some(vp.mode);
		let mode = run.mode;
		super::mode::set_mode(&mut k.root, cx.store, vp, mode);
	}
	if vp.parent.is_none() {
		k.note_prior_jobs(vp);
	}
	let run = vp.runs.front_mut().expect("present");
	if vp.image.is_none() {
		if let Some(args) = run.args.take() {
			k.root.set_positional(cx.store, args);
		}
		if let Some(cwd) = run.cwd.take() {
			if !matches!(state::root_misc(cx.store, MiscKey::Cwd), Ok(Some(v)) if v == cwd.as_slice())
			{
				k.root.set_misc(cx.store, MiscKey::Cwd, cwd.clone());
			}
			set_root_global(k, cx.store, b"PWD", Var::scalar(cwd.clone(), Attrs::EXPORT));
			vp.cwd = cwd;
		}
		for (name, value) in std::mem::take(&mut run.env) {
			if is_ident(&name) {
				set_root_global(k, cx.store, &name, Var::scalar(value, Attrs::EXPORT));
			}
		}
		// `$-` shows `c` for a `-c` string, `s` for a script on stdin.
		let flag = match run.chain.links[0].origin {
			Origin::Command => "c",
			Origin::Stdin => "s",
			_ => "",
		};
		// Unchanged (the common case): no write, so the forks that share the
		// root's records keep sharing them.
		if !matches!(state::root_misc(cx.store, MiscKey::RunOrigin), Ok(Some(v)) if v == flag.as_bytes())
		{
			k.root.set_misc(cx.store, MiscKey::RunOrigin, flag);
		}
	}
	let from_stdin = matches!(run.chain.links[0].origin, Origin::Stdin);
	let mut kind = FrameKind::script(&run.src, Pos::START, ScriptKind::Run);
	if let FrameKind::Script { stdin, .. } = &mut kind {
		*stdin = from_stdin;
	}
	let mut frame = Frame::new(None, 0, kind);
	// A callout's subshell stands for an external program: no DEBUG trap.
	frame.flags.set_no_debug_trap(run.callout);
	vp.frames.push(frame);
	// zsh `parseargs`: commands read from standard input set `shinstdin`.
	if from_stdin
		&& vp.image.is_none()
		&& vp.mode.dialect() == Dialect::Zsh
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Shinstdin, true)
	{
		k.fail(err);
	}
	let run = vp.runs.front().expect("present");
	let tag = run.tag;
	let origin = &run.chain.links[0].origin;
	k.emit(cx, (vp.vpid, vp.mode), Some(run), EventData::RunStart { tag, origin });
	// The shell's startup files (`BASH_ENV`, a login shell's profiles) run
	// as `.` files before its first script, as bash's `run_startup_files`.
	if vp.parent.is_none() && !k.startup.is_empty() {
		let startup = std::mem::take(&mut k.startup);
		for (path, _) in &startup {
			k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::SourceEnter {
				path: path.as_bstr(),
			});
		}
		for (_, text) in startup.iter().rev() {
			push_script(vp, text, 1, ScriptKind::Source);
		}
	}
	true
}

fn end_run(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, run: &super::proc::Run) {
	let status = vp.status;
	k.emit(cx, (vp.vpid, vp.mode), Some(run), EventData::RunEnd { status });
	k.trace_sources.remove(&vp.vpid);
	k.trace_unit_origins.remove(&vp.vpid);
	k.done.push_back((run.id, status));
}

/// Park `vp` on `key` (emitting `Blocked` when the key changes).
fn park(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, key: WaitKey, at: u64) {
	if vp.blocked.as_ref().is_none_or(|b| b.key != key) {
		k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Blocked { key: &key });
	}
	vp.blocked = Some(super::proc::Blocked { key, at });
}

/// Clear the park of `vp` (emitting `Unblocked`). After every op: the
/// common case, a vproc that was not parked, is one inlined test.
#[inline]
fn unblock(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if vp.blocked.is_some() {
		unpark(k, cx, vp);
	}
}

/// [`unblock`] of a parked vproc.
#[inline(never)]
fn unpark(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if let Some(b) = vp.blocked.take() {
		k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Unblocked { key: &b.key });
	}
}

/// Write queued diagnostics (`Kernel::diag`, xtrace lines, `fc -s`'s echo);
/// the fd that would block, if any. An entry is done once it is written and
/// the object that took its bytes has settled them
/// ([`crate::bash::File::poll_settle_marked`], the entry's
/// [`HandedOff`](super::proc::HandedOff)), so a command that runs next (an
/// external that inherits the fd, a builtin writing to another fd of the
/// same pipe) comes after it. That object, not whatever the fd names by
/// then: a failed compound redirection restores the fds between the write
/// and the settle. The chunk handed off last settles before the next one
/// goes, and an entry stops at its first failed chunk; write errors on a
/// diagnostic stream are dropped, as bash does.
pub fn flush_out(k: &mut Kernel, vp: &mut Vproc) -> Option<i32> {
	// The shell's job notices still going out to its terminal come first
	// ([`jobctl::notice`]): zsh wrote them with blocking writes.
	if super::jobctl::shout_waits(k, vp) {
		return Some(super::zle::tty::FD);
	}
	flush_queued(k, vp)
}

/// Whether [`flush_out`] would wait now, without writing anything: the
/// shell's job notices still going out to its terminal, the editor's
/// display bytes not out (queued, or taken by the terminal's writer thread
/// and not settled), or diagnostics queued in `vp.out`. A writer that goes
/// around the staged output (the fast path's `write_now` in
/// [`super::command`]) writes only when this is false: written at once on
/// another writer thread, its bytes could reach the terminal first.
pub fn output_waits(k: &Kernel, vp: &Vproc) -> bool {
	super::jobctl::shout_pending(k, vp)
		|| vp
			.zle
			.as_deref()
			.and_then(|z| z.tty.as_ref())
			.is_some_and(super::zle::tty::Tty::pending)
		|| !vp.out.is_empty()
}

/// [`flush_out`] without waiting for the shell's job notices: for a
/// failed compound redirection's message, which belongs on the fd 2 its
/// redirections left. The `Redir` op restores the fds in the same step,
/// right after this ([`clear_scratch`]), and cannot wait in between: an op
/// that waits runs again, which would try the failed redirection again and
/// print its message twice. No notice can be pending there: the op's wait
/// on entry returns only with the notices out and the editor's bytes
/// written, and nothing between it and the failure (`redir::apply`)
/// queues a notice. So this does what [`flush_out`] would; it is kept so
/// that a notice a later change queues there still leaves the message on
/// the redirected fd 2.
fn flush_queued(k: &mut Kernel, vp: &mut Vproc) -> Option<i32> {
	use super::zle::tty;
	// The editor's display bytes still pending were queued before any output
	// in `vp.out` (later ones wait in it, as `tty::FD` entries; a hold there
	// writes nothing): the terminal gets them first, as zsh's blocking writes
	// order them.
	if let Some(t) = vp.zle.as_deref_mut().and_then(|z| z.tty.as_mut())
		&& t.flush(k).is_some()
	{
		return Some(tty::FD);
	}
	if vp.out.is_empty() {
		return None;
	}
	let waker = k.waker.clone();
	let mut cx = Context::from_waker(&waker);
	while let Some(w) = vp.out.front_mut() {
		if w.fd == tty::FD {
			if let Some(t) = vp.zle.as_deref_mut().and_then(|z| z.tty.as_mut()) {
				t.put(&w.bytes[w.off..]);
				pop_out(k, vp);
				if vp
					.zle
					.as_deref_mut()
					.and_then(|z| z.tty.as_mut())
					.is_some_and(|t| t.flush(k).is_some())
				{
					return Some(tty::FD);
				}
				continue;
			}
			// No editor any more: its fallback, standard error.
			w.fd = 2;
		}
		let handle = vp.fds.handle(w.fd);
		let done = w.off >= w.bytes.len();
		// The chunk handed off last is out before the next one goes; what
		// another object took (the fd was restored in between) is out there
		// before the rest goes to this one.
		if let Some(held) = &w.handed.file
			&& (done || !held.same(&handle) || w.handed.mark.is_some())
		{
			let Poll::Ready(settled) = held.poll_settle_marked(&mut cx, w.handed.mark.as_slice())
			else {
				return Some(w.fd);
			};
			w.handed = super::proc::HandedOff::default();
			if settled.is_err() {
				pop_out(k, vp);
				continue;
			}
		}
		if done {
			pop_out(k, vp);
			continue;
		}
		match handle.poll_write_marked(&mut cx, &w.bytes[w.off..]) {
			Poll::Ready(Ok((n, mark))) if n > 0 => {
				w.off += n;
				w.handed.mark = mark;
				w.handed.file.get_or_insert(handle);
			},
			Poll::Ready(_) => {
				pop_out(k, vp);
			},
			Poll::Pending => return Some(w.fd),
		}
	}
	None
}

/// The front of `vp.out` is out (written and settled, or dropped): pop it,
/// and continue the job it held back ([`PendingWrite::then_continue`]).
fn pop_out(k: &mut Kernel, vp: &mut Vproc) {
	if let Some(w) = vp.out.pop_front()
		&& let Some(id) = w.cont
	{
		super::jobctl::continue_job(k, id);
	}
}

/// Grammar switches from the current options (also `zpty`'s parse of its
/// command text).
pub(super) fn features(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Features, StoreError> {
	let mut f = Features::NONE;
	if state::option(&mut k.root, store, vp, OptId::Extglob)? {
		f = f | Features::EXTGLOB;
	}
	if state::option(&mut k.root, store, vp, OptId::Posix)? {
		f = f | Features::POSIX;
	}
	// Charsets whose trailing bytes can be `\`, `` ` `` or `|`: the lexer
	// reads whole characters.
	if let super::locale::Charset::Encoding(e) = super::locale::charset(k, store, vp) {
		if e == encoding_rs::BIG5 || e == encoding_rs::GBK {
			f = f | Features::DOUBLE_BYTE;
		} else if e == encoding_rs::GB18030 {
			f = f | Features::GB18030;
		} else if e == encoding_rs::SHIFT_JIS {
			f = f | Features::SHIFT_JIS;
		}
	}
	let f = super::mode::features(&mut k.root, store, vp, f)?;
	// zsh `gettok`: without `interactivecomments` an interactive shell
	// reads `#` as a word only in its standard input (`SHINSTDIN`, which
	// `source` turns off; a string, `-c` or `eval`, is not).
	if vp.mode.dialect() == Dialect::Zsh {
		let stdin = vp
			.frames
			.last()
			.is_some_and(|fr| matches!(fr.kind, FrameKind::Script { stdin: true, .. }));
		if !stdin {
			return Ok(f | Features::ZSH_INTERACTIVE_COMMENTS);
		}
	}
	Ok(f)
}

/// Parse and compile the next command of the top script frame; pop the
/// frame at end of input. A script read from stdin first reads lines until
/// the command is complete; `Some` is the wait key while fd 0 has none.
fn next_command(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> Option<WaitKey> {
	let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
	let depth = vp.frames.len();
	if observed {
		if let Some(origins) = k.trace_sources.get_mut(&vp.vpid) {
			origins.retain(|at, _| *at <= depth);
		}
		if let Some(Frame { kind: FrameKind::Script { src, pos, what: ScriptKind::Eval, .. }, .. }) = vp.frames.last()
			&& pos.0 == 0
			&& let Some(origin) = literal_script_origin(vp, src, false)
		{
			if k.trace_sources.len() < crate::bash::trace::history::HISTORY_EVENTS {
				k.trace_sources.entry(vp.vpid).or_default().insert(depth, origin);
			}
		} else if vp.frames.last().is_some_and(|frame| matches!(&frame.kind, FrameKind::Script { pos, what: ScriptKind::Eval, .. } if pos.0 == 0))
			&& let Some(origins) = k.trace_sources.get_mut(&vp.vpid) { origins.remove(&depth); }
	}
	// bash reads its next line (`shell_getc`): it reports the background
	// jobs a signal killed first.
	if let Some(line) = line_to_read(cx, vp) {
		super::killed::line_read(k, cx, vp, line);
	}
	let source_origin = observed
		.then(|| {
			k.trace_sources
				.get(&vp.vpid)
				.and_then(|origins| origins.get(&depth))
				.copied()
		})
		.flatten();
	// zsh `parse_string`: a string (`eval`, a trap, `-c`) parses whole
	// before it runs; its first command takes the snapshot the rest reuse.
	let (snapped, snapshot) = match vp.frames.last().map(|f| &f.kind) {
		_ if vp.mode.dialect() != Dialect::Zsh => (false, false),
		Some(FrameKind::Script { aux: Some(a), .. }) if a.parse.is_some() => (true, false),
		Some(FrameKind::Script { pos, what, stdin: false, .. }) if pos.0 == 0 => {
			let string = match what {
				ScriptKind::Eval | ScriptKind::Trap { .. } | ScriptKind::Hook | ScriptKind::Code(_) => {
					true
				},
				ScriptKind::Source => false,
				ScriptKind::Run => matches!(
					state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
					Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
				),
			};
			(false, string)
		},
		_ => (false, false),
	};
	let (feat, mut aliases) = if snapped {
		(Features::NONE, None)
	} else {
		let feat = match features(k, cx.store, vp) {
			Ok(f) => f,
			Err(err) => {
				k.fail(err);
				return None;
			},
		};
		match builtins::alias_table(k, cx, vp) {
			Ok(a) => (feat, a),
			Err(err) => {
				k.fail(err);
				return None;
			},
		}
	};
	let mode = vp.mode;
	// `set -o history` (zsh: interactive on stdin): the shell's input lines
	// (not `eval`, `.` or trap text) join the history as they are read.
	let history = matches!(top_frame(vp).kind, FrameKind::Script { what: ScriptKind::Run, .. })
		&& builtins::history::recording(&mut k.root, cx.store, vp).unwrap_or(false);
	// zsh: each event read goes through `hbegin`, history expansion and
	// `hend` (`builtins::history::zsh`).
	let zhist = history && vp.mode.dialect() == Dialect::Zsh;
	// The zsh root shell, whose history is saved as its input ends.
	let zsh_root = vp.mode.dialect() == Dialect::Zsh && vp.parent.is_none();
	// `set -n`: a non-interactive shell reads its commands (reporting syntax
	// errors) without running them.
	let noexec = state::option(&mut k.root, cx.store, vp, OptId::Noexec).unwrap_or(false)
		&& !matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		);
	// An interactive shell's own input: the line editor reads it, and
	// `preexec` runs before each event ([`super::zle::reader`]).
	let reader = super::zle::reader::applies(cx, vp);
	let gate = if reader {
		super::zle::reader::gate(vp)
	} else {
		None
	};
	let frame = top_frame(vp);
	let FrameKind::Script { src, pos, aux, stdin, .. } = &mut frame.kind else {
		// Function and subshell frames never run out of code.
		frame.unit = None;
		vp.frames.pop();
		return None;
	};
	if snapshot {
		aux.get_or_insert_with(Box::default).parse =
			Some(ParseSnapshot { features: feat.bits(), aliases: aliases.take() });
	}
	let (feat, aliases) = match aux.as_deref().and_then(|a| a.parse.as_ref()) {
		Some(p) => (Features::from_bits(p.features), p.aliases.as_ref()),
		None => (feat, aliases.as_ref()),
	};
	let pending = aux.as_deref().and_then(|a| a.pending.as_ref());
	// Text read to its end has no command left: no parser needed (each
	// `eval` would otherwise build one just to see the end).
	let at_end = !*stdin && pending.is_none() && pos.0 as usize >= src.len();
	let resume_from = Resume {
		pos:     Pos { offset: pos.0, line: pos.1 },
		pending: pending.map_or_default(|p| p.0.to_vec()),
		active:  pending.map_or_default(|p| p.1.iter().map(|a| a.to_vec()).collect()),
	};
	let mut parser = (!at_end).then(|| {
		let mut p = match aliases {
			Some(a) => Parser::new(src, feat, a),
			None => Parser::new(src, feat, crate::bash::syntax::NO_ALIASES),
		}
		.with_resume(&resume_from);
		p.recycle(core::mem::take(&mut k.spare_tree));
		p
	});
	let res = parser.as_mut().and_then(Parser::next_command);
	if res.is_none()
		&& let Some(p) = &mut parser
	{
		k.keep_spare_tree(p.take_tree());
	}
	// zsh: the input ran out with a construct open (`a ||`, `a &&` parse as
	// complete commands here; interactive zsh's lexer reads another line).
	if *stdin
		&& let Some(p) = &parser
		&& (needs_more_input(src, res.as_ref(), p.resume().pos)
			|| p.zsh_cmdstack().is_some_and(|s| !s.is_empty()))
	{
		if reader {
			// A command left open continues on a `PS2` line; `%_` shows
			// what is open.
			let cont = res.is_some();
			let cmdstack = if cont {
				p.zsh_cmdstack().unwrap_or_default()
			} else {
				Vec::new()
			};
			drop(parser);
			return super::zle::reader::read_line(k, vp, cx, cont, cmdstack);
		}
		drop(parser);
		// An interactive shell reports changed jobs before it reads its
		// next line (zsh `preprompt`), once per line.
		if super::jobctl::interactive(k) && vp.parent.is_none() && top_frame(vp).scratch.is_none() {
			if let Some(job) = super::jobctl::announce_wait(k) {
				return Some(WaitKey::Proc(job));
			}
			super::jobctl::notices_before_prompt(k, cx, vp);
		}
		// So does bash before each line it reads, once per line.
		if top_frame(vp).scratch.is_none()
			&& let Some(line) = stdin_line_to_read(vp)
		{
			super::killed::line_read(k, cx, vp, line);
		}
		return read_script_line(k, vp, cx, zhist);
	}
	let Some(res) = res else {
		let empty_src = src.is_empty();
		// `eval` or `source` text without a command (empty, blanks,
		// comments) ends with status 0, as bash's `parse_and_execute` and
		// zsh's `LOOP_EMPTY` do: no command was ever parsed, so the position
		// never moved. Until a first command runs, `$?` is the caller's.
		let no_command = pos.0 == 0;
		// zsh `zexit`: an interactive shell saves its history as its input
		// ends.
		if zsh_root && matches!(frame.kind, FrameKind::Script { what: ScriptKind::Run, .. }) {
			let mut sc = frame.scratch.take().unwrap_or_default();
			if let Err(key) = builtins::history::zsh::exit_save(k, cx, vp, &mut sc) {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			}
		}
		let frame = top_frame(vp);
		let (status, source, cancel, return_target, exit, returned) = match frame.kind {
			FrameKind::Script {
				what: ScriptKind::Trap { status, cancel, return_target, exit, returned, .. },
				..
			} => (Some(status), false, cancel, return_target, exit, returned),
			FrameKind::Script { what: ScriptKind::Source, .. } => {
				(None, true, None, None, false, false)
			},
			_ => (None, false, None, None, false, false),
		};
		let debug = matches!(frame.kind, FrameKind::Script {
			what: ScriptKind::Trap { key: TrapKey::Debug, .. },
			..
		});
		let eval = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Eval, .. });
		// zsh `execode` of empty code (`zstyle -e`, `zregexparse`) leaves 0.
		let code = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Code(_), .. });
		// bash's `wait_for` goes on to `notify_and_cleanup` once the `INT`
		// trap it ran with the job list frozen is over.
		let frozen_int = matches!(frame.kind, FrameKind::Script {
			what: ScriptKind::Trap {
				key: TrapKey::Signal(crate::bash::signal::Signal::Int),
				frozen: true,
				..
			},
			..
		});
		// A zsh function trap (`TRAPZERR`, …) runs above a trap frame
		// without text.
		let func_trap = status.is_some() && empty_src;
		let trap_status = vp.status;
		let top = vp.frames.len() - 1;
		// The text of a zsh command substitution (`child_text`) ends its
		// child: the child's own EXIT trap runs.
		let sub_end = eval && top == 0 && vp.parent.is_some() && mode.dialect() == Dialect::Zsh;
		let returns = vp.status;
		if source && return_trap(k, vp, cx, top, returns) {
			return None;
		}
		pop_frame(&mut k.root, cx.store, vp);
		if frozen_int {
			super::killed::cleanup_dead_jobs(vp);
		}
		if debug && !vp.frames.is_empty() {
			zsh_debug_done(k, vp, cx);
			// bash's `run_debug_trap` ends with `notify_and_cleanup (-1)`
			// (`trap.c:1304`), naming the line of the command it ran for.
			if mode.dialect() == Dialect::Bash {
				let node = vp
					.frames
					.last()
					.and_then(|f| f.unit.as_ref()?.ops.get(f.pc as usize).map(|o| o.node));
				let line = node.map_or(0, |node| line_of(vp, node));
				super::killed::line_read(k, cx, vp, line);
			}
		}
		if (source || eval || code) && no_command {
			vp.status = 0;
		}
		if sub_end {
			start_exit_trap_once(k, vp, cx);
			return None;
		}
		if let Some(cancel) = cancel {
			finish_cancel(&mut k.root, cx.store, vp, cancel);
		} else if let Some(status) = status
			&& exit
		{
			// `set -e` after the ERR trap: bash's errexit jump comes once
			// the trap ran, and `time_command` reports it.
			report_jump(k, vp, cx, 0, Jump::Errexit);
			exit_shell(k, vp, cx, status, Jump::Errexit);
		} else if func_trap && returned && trap_status != 0 && vp.mode.dialect() == Dialect::Zsh {
			// zsh `dotrapargs`: a function trap that `return`s non-zero
			// forces a return from the interrupted code, with the error flag
			// set; one that falls off its end with a non-zero status does
			// not (`trapreturn` is set only by `return`).
			zsh_discard(k, vp, cx, trap_status);
		} else if let Some(status) = status {
			vp.status = status;
			if let Some((target, returns)) = return_target {
				vp.status = returns;
				unwind(&mut k.root, cx.store, vp, target as usize);
			} else if debug
				&& trap_status != 0
				&& state::option(&mut k.root, cx.store, vp, OptId::Extdebug).unwrap_or(false)
			{
				// `extdebug`: a failing DEBUG trap skips the command; at a
				// function's entry, the whole body (and its RETURN trap).
				let f = top_frame(vp);
				let at = f
					.unit
					.as_ref()
					.and_then(|u| Some((u.ops.get(f.pc as usize).copied()?, u)));
				let skippable = at.is_some_and(|(op, _)| {
					!matches!(op.code, Opcode::ForIn | Opcode::ForNext | Opcode::CaseWord)
				});
				// A stage's trap run in the shell before the fork, as bash's: a
				// lone background command's skips the job (no job, `$!` and
				// `PIPESTATUS` as they were), with status 0, or 1 for `! cmd &`;
				// a pipeline stage's skips that stage alone (bash forks no
				// process for it, [`DebugSkip`]), also in the pipeline a
				// background job is.
				let done = spawn_debug_done(f.debug_pc);
				let spawn_skip = at
					.filter(|(op, _)| op.code == Opcode::Spawn && done != 0)
					.map(|(op, u)| {
						let (entries, lone) = debug_stage_entries(u, op);
						let entry = entries.get(done - 1).copied();
						// `! cmd &`: the job's code has no `Not` (bash's
						// asynchronous child does not invert its status), so
						// the `Spawn` says the job had one ([`Op::NEGATED`]):
						// a job skipped here is not forked, and the shell
						// inverts, as bash's parent does.
						let negated = op.flags & Op::NEGATED != 0;
						(lone.then_some(u.spawns[op.a as usize].end), entry, negated)
					});
				if f.debug_pc == Some(ENTRY_DEBUG) {
					pop_frame(&mut k.root, cx.store, vp);
					vp.status = trap_status;
				} else if let Some((end, entry, negated)) = spawn_skip {
					if let Some(end) = end {
						f.pc = end;
						f.debug_pc = None;
						vp.status = i32::from(negated);
					} else if let Some(entry) = entry {
						note_debug_skip(k, vp, entry);
					}
				} else if f.debug_pc == Some(f.pc) && skippable {
					f.pc += 1;
					f.debug_pc = None;
				}
			}
		}
		return None;
	};
	let from_stdin = *stdin;
	// A command came, so a parser read it.
	let resume = parser.as_ref().expect("a command was parsed").resume();
	let next = resume.pos;
	let read = (history && !zhist).then(|| input_lines(src, pos.0 as usize, next.offset as usize));
	// zsh `hend`: the event joins the history; `:p` and `histverify` keep
	// it from running, an expansion shows the line first.
	let mut run = true;
	if zhist {
		// zsh `hend`'s `zshaddhistory` hooks (the interactive reader runs
		// them as frames): the first non-zero status decides.
		let mut hookret = 0;
		if reader && from_stdin {
			let at = pos.0;
			match super::zle::reader::addhistory(k, vp, cx, at) {
				Ok(r) => hookret = r,
				Err(key) => return key,
			}
		}
		let frame = top_frame(vp);
		let FrameKind::Script { src, .. } = &frame.kind else {
			return None;
		};
		let prog = res
			.as_ref()
			.ok()
			.map(|cc| builtins::history::zsh::prog_info(cc, src));
		let mut sc = frame.scratch.take().unwrap_or_default();
		match builtins::history::zsh::hend(k, cx, vp, &mut sc, prog.as_ref(), hookret) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(out) => hend_output(k, cx, vp, out, &mut run),
		}
	}
	// zsh `loop()`: an event that runs gets `preexec` first, with the
	// history line `hend` stored, the one-line job text and the full text.
	if reader
		&& from_stdin
		&& run
		&& !noexec
		&& let Ok(cc) = &res
	{
		let frame = top_frame(vp);
		let at = match &frame.kind {
			FrameKind::Script { pos, .. } => pos.0,
			_ => 0,
		};
		if gate != Some(at) {
			let hist = if zhist {
				builtins::history::zsh::latest_text(&k.root, cx.store, vp).unwrap_or_default()
			} else {
				match &top_frame(vp).kind {
					FrameKind::Script { src, pos, .. } => src
						.get(pos.0 as usize..next.offset as usize)
						.map_or_default(|t| BString::from(t.strip_suffix(b"\n").unwrap_or(t))),
					_ => BString::default(),
				}
			};
			let list = cc.list();
			let jobtext = BString::from(crate::bash::syntax::zsh::getjobtext(list));
			let permtext = BString::from(crate::bash::syntax::zsh::getpermtext(list, 0));
			return super::zle::reader::before_run(k, vp, cx, at, [hist, jobtext, permtext]);
		}
	}
	let frame = top_frame(vp);
	let FrameKind::Script { src, pos, aux, .. } = &mut frame.kind else {
		return None;
	};
	*pos = (next.offset, next.line);
	if !resume.pending.is_empty() {
		aux.get_or_insert_with(Box::default).pending = Some((
			BString::from(resume.pending),
			resume.active.into_iter().map(BString::from).collect(),
		));
	} else if let Some(a) = aux {
		a.pending = None;
		if a.parse.is_none() && !a.no_line {
			*aux = None;
		}
	}
	let (unit, line) = match res {
		Ok(_) if noexec || !run => return None,
		Ok(cc) => {
			let line = cc.line;
			let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
			let (unit, tree) = k.engine.compile(cc, src, mode, feat, observed);
			if let Some(tree) = tree {
				k.keep_spare_tree(tree);
			}
			(unit, line)
		},
		Err(e) => {
			// bash abandons the rest of a script after a syntax error,
			// except one it recovers from (the parser resumes after it).
			if !e.recovered {
				*pos = (src.len() as u32, next.line);
				if let Some(a) = aux {
					a.pending = None;
				}
			}
			let line = e.line;
			let unit = k.engine.intern(ir::syntax_unit(&e, src, mode, feat));
			(unit, line)
		},
	};
	frame.unit = Some(Arc::clone(&unit));
	frame.pc = 0;
	let top_level = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Run, .. });
	if top_level && vp.parent.is_none() {
		super::jobctl::command_read(k);
	}
	if let Some(lines) = read {
		let now = cx.host.wall().secs;
		builtins::history::remember(k, cx.store, vp, lines, now);
	}
	announce_at(k, cx, vp.vpid, vp.runs.front(), &unit, line, source_origin.as_ref());
	None
}

/// The line bash's `shell_getc` reads next as the top script frame of `vp`
/// needs its next command, if it reads one (not standard input, which
/// [`stdin_line_to_read`] counts as it reads it): the frame is at the start
/// of a line, nothing pushed back (`aux.pending`), with text left; or a
/// script file at its end (bash's `reader_loop` reads until it finds the
/// end, where `parse_and_execute`, which runs a `-c` string, an `eval`'s, a
/// trap's or a sourced file's text, stops before).
fn line_to_read(cx: &mut Cx<'_>, vp: &Vproc) -> Option<u32> {
	if vp.mode.dialect() != Dialect::Bash || vp.jobs.is_empty() {
		return None;
	}
	let Some(Frame { kind: FrameKind::Script { src, pos, aux, what, stdin: false }, .. }) =
		vp.frames.last()
	else {
		return None;
	};
	if aux
		.as_ref()
		.is_some_and(|a| a.pending.is_some() || a.no_line)
	{
		return None;
	}
	let at = pos.0 as usize;
	let start = at == 0 || src.get(at - 1) == Some(&b'\n');
	if at < src.len() {
		return start.then_some(pos.1);
	}
	let file = matches!(what, ScriptKind::Run)
		&& !matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
			Ok(Some(Record::Misc(origin))) if matches!(origin.as_slice(), b"c" | b"s")
		);
	// Its last line read without a newline: bash's count is past it.
	file.then_some(if start { pos.1 } else { pos.1 + 1 })
}

/// The line a stdin script frame of `vp` reads next, bash's `shell_getc`
/// count: the line after the text read so far, when that ends a line.
fn stdin_line_to_read(vp: &Vproc) -> Option<u32> {
	if vp.mode.dialect() != Dialect::Bash || vp.jobs.is_empty() {
		return None;
	}
	let Some(Frame { kind: FrameKind::Script { src, pos, .. }, .. }) = vp.frames.last() else {
		return None;
	};
	let rest = src.get(pos.0 as usize..).unwrap_or_default();
	if !(src.is_empty() || src.ends_with(b"\n")) {
		return None;
	}
	#[expect(
		clippy::naive_bytecount,
		reason = "the stdin text read so far; no bytecount dependency"
	)]
	let lines = rest.iter().filter(|&&c| c == b'\n').count();
	Some(pos.1 + u32::try_from(lines).unwrap_or(u32::MAX))
}

/// The literal argument that actually entered a native script. IR word ids
/// are canonical parser ids; fixed-word proof rules out expansion/split drift.
pub(super) fn literal_script_origin(
	vp: &Vproc,
	source: &[u8],
	shell: bool,
) -> Option<crate::bash::event::SourceOrigin> {
	let (unit, node) = vp.command.as_ref()?;
	let op = unit
		.ops
		.iter()
		.find(|op| op.code == Opcode::Exec && op.node == *node)?;
	let command = unit.cmds.get(op.a as usize)?;
	let words = unit.lists.get(command.words as usize)?;
	let literal = |index: usize| -> Option<Vec<u8>> {
		let word = unit.words.get(*words.get(index)? as usize)?;
		if !word.fixed || !word.noglob {
			return None;
		}
		let mut text = Vec::new();
		for part in &word.parts {
			match part {
				ir::Part::Lit(bytes) | ir::Part::Quoted(bytes) => text.extend_from_slice(bytes),
				_ => return None,
			}
		}
		Some(text)
	};
	let index = if shell {
		let mut executable = None;
		for i in 0..words.len() {
			let text = literal(i)?;
			let name = text.rsplit(|byte| *byte == b'/').next()?;
			if matches!(name, b"bash" | b"sh" | b"zsh" | b"dash" | b"ksh") {
				executable = Some(i);
				break;
			}
		}
		let mut body = None;
		for i in executable? + 1..words.len() {
			let flag = literal(i)?;
			if flag.starts_with(b"-") && !flag.starts_with(b"--") && flag[1..].contains(&b'c') {
				body = Some(i + 1);
				break;
			}
		}
		body?
	} else {
		if words.len() != 2 || literal(0)?.as_slice() != b"eval" {
			return None;
		}
		1
	};
	if literal(index)?.as_slice() != source {
		return None;
	}
	let word = unit.words.get(*words.get(index)? as usize)?;
	let span = unit.nodes.get(word.node as usize)?;
	Some(crate::bash::event::SourceOrigin {
		vpid: vp.vpid,
		node: word.node,
		span: crate::bash::event::SpanOwned {
			unit: unit.id,
			lo:   span.lo,
			hi:   span.hi,
			line: unit.line + span.line,
			col:  span.col,
		},
	})
}

/// Announce `unit` with `UnitCompiled`, deduplicated within a bounded
/// observer-generation cache (eviction may safely reannounce a unit).
/// (`line`: the script line of its first byte), before events naming it.
/// Parsed commands announce immediately; cached/restored frames announce
/// only when executed. No store scan or parsing ahead is needed.
pub fn announce(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vpid: Vpid,
	run: Option<&Run>,
	unit: &Unit,
	line: u32,
) {
	if !k.mask.contains(crate::bash::event::EventKind::UnitCompiled) {
		return;
	}
	let origin = k
		.trace_unit_origins
		.get(&vpid)
		.and_then(|origins| origins.get(&unit.id))
		.copied();
	announce_at(k, cx, vpid, run, unit, line, origin.as_ref());
}

fn announce_at(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vpid: crate::bash::ids::Vpid,
	run: Option<&Run>,
	unit: &Unit,
	line: u32,
	parent: Option<&crate::bash::event::SourceOrigin>,
) {
	if k.mask.contains(crate::bash::event::EventKind::UnitCompiled) && !unit.nodes.is_empty() {
		let key = (vpid, unit.id, parent.copied());
		if let Some(parent) = parent {
			record_source_origin(k, unit, vpid, *parent);
		} else {
			clear_source_origin(k, unit, vpid);
		}
		// Vpids keep advancing in long-running pipeline/background loops.
		// Reannouncements are safe; an already-known key needs no eviction.
		if k.announced.len() >= 20_000 && !k.announced.contains(&key) {
			k.announced.clear();
		}
		if k.announced.insert(key) {
			if unit.trace_syntax.get().is_none()
				&& let Some(syntax) = crate::bash::trace::syntax::UnitSyntax::restore(unit)
			{
				let _ = unit.trace_syntax.set(Arc::new(syntax));
			}
			k.emit(
				cx,
				(vpid, unit.mode),
				run,
				EventData::UnitCompiled(CompiledUnit { unit, line, parent }),
			);
		}
	}
}

fn clear_source_origin(k: &mut Kernel, unit: &Unit, vpid: crate::bash::ids::Vpid) {
	if let Some(origins) = k.trace_unit_origins.get_mut(&vpid) {
		if origins.contains_key(&unit.id) {
			Arc::make_mut(origins).remove(&unit.id);
		}
		for function in &unit.funcs {
			clear_source_origin(k, &function.body, vpid);
		}
	}
}

fn record_source_origin(
	k: &mut Kernel,
	unit: &Unit,
	vpid: crate::bash::ids::Vpid,
	origin: crate::bash::event::SourceOrigin,
) {
	if k.trace_unit_origins.len() >= crate::bash::trace::history::HISTORY_EVENTS {
		return;
	}
	let origins = k.trace_unit_origins.entry(vpid).or_default();
	if origins.get(&unit.id) == Some(&origin) {
		return;
	}
	Arc::make_mut(origins).insert(unit.id, origin);
	for function in &unit.funcs {
		record_source_origin(k, &function.body, vpid, origin);
	}
}

/// The input lines the parser finished reading while it moved from `from`
/// to `to` in `src` (newlines stripped): each line whose newline lies in
/// between, and an unterminated last line at the end of the input.
fn input_lines(src: &[u8], from: usize, to: usize) -> Vec<BString> {
	let to = to.min(src.len());
	let mut lines = Vec::new();
	let mut start = src[..from.min(to)]
		.iter()
		.rposition(|&c| c == b'\n')
		.map_or(0, |i| i + 1);
	for (i, &c) in src.iter().enumerate().take(to).skip(from) {
		if c == b'\n' {
			lines.push(BString::from(&src[start..i]));
			start = i + 1;
		}
	}
	if to == src.len() && start < to && from < to {
		lines.push(BString::from(&src[start..to]));
	}
	lines
}

/// Whether a script read from stdin must read another line before running
/// what `src` holds from the frame's position: the input ran out (`None`),
/// a syntax error sits at the end of the input (an open quote, compound
/// command or `[[`), or the command ends at the end of the input with a
/// here-document cut short or a trailing `\`-newline. bash reads the same
/// way: line by line, until the parser has a complete command.
fn needs_more_input(
	src: &[u8],
	res: Option<&Result<CompleteCommand, ParseError>>,
	next: Pos,
) -> bool {
	let at_end = next.offset as usize >= src.len();
	match res {
		None => true,
		Some(Err(e)) => {
			matches!(e.kind, ParseErrorKind::UnexpectedEof { .. } | ParseErrorKind::Unmatched(_))
				|| e.span.lo as usize >= src.len()
		},
		Some(Ok(cc)) => {
			let continued = src
				.strip_suffix(b"\n")
				.is_some_and(|line| line.iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1);
			at_end && (!cc.warnings.is_empty() || continued)
		},
	}
}

/// What zsh's `hend` leaves to the reader: the expanded line shown on the
/// terminal output (standard error here), messages, and whether the event
/// runs (`histverify` puts the line back in the editor instead; without
/// one it is dropped).
pub(crate) fn hend_output(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	out: builtins::history::zsh::Hend,
	run: &mut bool,
) {
	for m in out.msgs {
		k.diag(cx, vp, 0, Diag::Usage { msg: m.to_str_lossy().into_owned().into() });
	}
	if let Some(mut line) = out.print {
		line.push(b'\n');
		vp.out.push_back(PendingWrite::new(2, line));
	}
	*run = out.run;
}

/// Append the next line of fd 0 to the top (stdin) script frame's source;
/// at end of file the frame stops reading. `Some` while the line is
/// pending; the partial read waits in the frame's scratch. `zhist`: zsh
/// history is on (an event begins with `hbegin`, each line goes through
/// history expansion; a failed expansion abandons the event, whose `hend`
/// runs before the next line is read).
fn read_script_line(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	zhist: bool,
) -> Option<WaitKey> {
	use builtins::history::zsh as hz;
	let mut sc = top_frame(vp).scratch.take().unwrap_or_default();
	if zhist {
		match hz::before_line(k, cx, vp, &mut sc) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(Some(out)) => {
				let failed = out.failed;
				let mut run = true;
				hend_output(k, cx, vp, out, &mut run);
				// zsh `loop`: a line that did not parse sets `$?` to 1.
				if failed && vp.status == 0 {
					vp.status = 1;
				}
			},
			Ok(None) => {},
		}
	}
	let input = Probe::Input {
		fd:         0,
		delim:      Some(b'\n'),
		lines:      1,
		nchars:     None,
		part:       0,
		timeout_ns: None,
	};
	let answer = match probe::cached(&sc, &input).cloned() {
		Some(answer) => answer,
		None => match probe::perform(k, cx, vp, &mut sc, &input) {
			Ok(answer) => answer,
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
		},
	};
	let ProbeResult::Input { data, eof, .. } = answer else {
		return None;
	};
	let mut text = data;
	if zhist && !text.is_empty() {
		match hz::expand(k, cx, vp, &mut sc, &text) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(hz::Expanded::Line(t)) => text = t,
			Ok(hz::Expanded::Failed(d)) => {
				if let Some(d) = d {
					k.diag(cx, vp, 0, d);
				}
				text = BString::default();
				// The event's earlier lines go with it.
				if let FrameKind::Script { src, pos, aux, .. } = &mut top_frame(vp).kind {
					let skipped = src[(pos.0 as usize).min(src.len())..]
						.split(|&c| c == b'\n')
						.count()
						- 1;
					*pos = (src.len() as u32, pos.1 + skipped as u32 + 1);
					if let Some(a) = aux {
						a.pending = None;
					}
				}
			},
		}
	}
	if let FrameKind::Script { src, stdin, .. } = &mut top_frame(vp).kind {
		src.extend_from_slice(&text);
		*stdin = !eof;
	}
	None
}

/// The top frame's unit reached `End`.
fn end_unit(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let frame = top_frame(vp);
	match frame.kind {
		FrameKind::Script { .. } => frame.unit = None,
		FrameKind::Function { .. }
			if frame
				.unit
				.as_ref()
				.is_some_and(|u| u.mode.dialect() == Dialect::Zsh) =>
		{
			let target = vp.frames.len() - 1;
			zsh_leave(k, vp, cx, target);
		},
		FrameKind::Function { .. } => {
			let target = vp.frames.len() - 1;
			let returns = vp.status;
			if !return_trap(k, vp, cx, target, returns) {
				pop_frame(&mut k.root, cx.store, vp);
			}
		},
		FrameKind::NoFork | FrameKind::Stage | FrameKind::Cat { .. } => {
			pop_frame(&mut k.root, cx.store, vp);
		},
		FrameKind::Subshell | FrameKind::Job { .. } => {
			let kept = kept_level(vp);
			unwind(&mut k.root, cx.store, vp, 0);
			exit_trap_keeps_level(k, vp, cx, kept);
		},
	}
}

/// Pop the top frame, restoring the fds its redirections saved and the
/// scope of a function call or `${ ;}`. A store failure is kept on `root`.
pub fn pop_frame(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
	let Some(mut f) = vp.frames.pop() else {
		return;
	};
	if matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. }) {
		vp.trap_frames = vp.trap_frames.saturating_sub(1);
	}
	if let Some(sc) = f.scratch.take() {
		drop_scratch(root, store, vp, sc);
	}
	while let Some(saves) = f.redirs.pop() {
		restore(vp, saves.fds);
	}
	let keep = vp.frames.len();
	close_procsubs(vp, keep);
	super::callstack::truncate(root, store, vp, keep);
	if f.kind == FrameKind::NoFork {
		pass_reply(root, store, vp);
	}
	// A zsh function's caller gets its `OPTIND` back without
	// `POSIX_BUILTINS`, decided before the function's options go (zsh
	// `doshfunc`), restored once its locals have.
	let zsh_body = matches!(f.kind, FrameKind::Function { .. })
		&& f
			.unit
			.as_ref()
			.is_some_and(|u| u.mode.dialect() == crate::bash::ids::Dialect::Zsh);
	let zsh_optind = if zsh_body {
		match state::zsh_option(root, store, vp, crate::bash::zshopt::ZshOpt::Posixbuiltins) {
			Ok(posix) => (!posix).then(|| f.getopts.take()),
			Err(err) => {
				root.fail(err);
				None
			},
		}
	} else {
		None
	};
	// The function's scope, read before it goes.
	let top = state::scope_count(root, vp).checked_sub(1);
	if matches!(f.kind, FrameKind::Function { .. })
		&& let Some(top) = top
		&& state::scope_may_bind(root, vp, top)
	{
		match state::scope_var(store, vp, top, b"-") {
			// `local -`: the function's `set -o` changes end with it.
			Ok(Some(Some(saved))) => {
				vp.rare_mut()
					.restore_opts
					.push(BString::from(saved.as_scalar().unwrap_or_default()));
			},
			Ok(_) => {},
			Err(err) => root.fail(err),
		}
		match state::scope_binds(store, vp, top, b"OPTIND") {
			// A local `OPTIND`: the caller's getopts scan resumes where it
			// was.
			Ok(true) if !zsh_body => vp.set_getopts(f.getopts.take().map_or_default(|g| *g)),
			Ok(_) => {},
			Err(err) => root.fail(err),
		}
	}
	// A zsh-dialect or mode-switching call, or a frame with zsh state to
	// restore: a bash frame of a bash vproc has neither.
	if matches!(f.kind, FrameKind::Function { zsh: true, .. }) || vp.zsh.is_some() {
		zsh_pop(root, store, vp, &f, top, keep);
	}
	if matches!(
		f.kind,
		FrameKind::Function { .. }
			| FrameKind::NoFork
			| FrameKind::Script { what: ScriptKind::Trap { .. }, .. }
	) {
		state::drop_scope(root, store, vp);
	}
	if let Some(saved) = zsh_optind
		&& let Err(err) = super::builtins::zsh_vars::optind_leave(root, store, vp, saved)
	{
		root.fail(err);
	}
}

/// The zsh part of [`pop_frame`] for frame `f` (popped; `keep` frames
/// remain, `top` is the scope it may own): the options, mode and sticky
/// emulation a zsh-dialect or mode-switching call restores (zsh
/// `doshfunc`), then the state the end of `emulate … -c CMD` or of a trap
/// run in another mode restores. Out of line, off the bash path.
#[inline(never)]
fn zsh_pop(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	f: &Frame,
	top: Option<usize>,
	keep: usize,
) {
	if matches!(f.kind, FrameKind::Function { zsh: true, .. })
		&& let Some(top) = top
	{
		let zsh_body = f
			.unit
			.as_ref()
			.is_some_and(|u| u.mode.dialect() == crate::bash::ids::Dialect::Zsh);
		let res = state::scope_zsh(store, vp, top).and_then(|saved| match saved {
			Some(mut saved) => {
				let traps = std::mem::take(&mut saved.traps);
				super::mode::leave_call(root, store, vp, *saved, zsh_body)?;
				// zsh `endtrapscope`: the traps the function replaced.
				if zsh_body {
					super::builtins::trap::end_scope(root, store, vp, traps)?;
				}
				Ok(())
			},
			None => Ok(()),
		});
		if let Err(err) = res {
			root.fail(err);
		}
	}
	if vp.zsh.is_some()
		&& let Some(saved) = vp.take_restore(u32::try_from(keep + 1).unwrap_or(u32::MAX))
		&& let Err(err) = super::mode::leave_call(root, store, vp, saved, true)
	{
		root.fail(err);
	}
}

/// A `${| …; }` ends: hand the value of its local `REPLY` to the capture
/// of the op waiting for it (the scope is popped next).
fn pass_reply(root: &mut Root, store: &mut dyn StateStore, vp: &Vproc) {
	let reply = match state::scope_count(root, vp).checked_sub(1) {
		Some(top) => match state::scope_var(store, vp, top, b"REPLY") {
			Ok(var) => var
				.flatten()
				.and_then(|v| v.as_scalar().map(<[u8]>::to_vec))
				.unwrap_or_default(),
			Err(err) => {
				root.fail(err);
				Vec::new()
			},
		},
		None => Vec::new(),
	};
	if let Some(PendingSub::NoFork { capture, value: true }) = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.sub.as_ref())
	{
		let mut capture = capture.clone();
		let _ = crate::bash::fs::File::poll_write(
			&mut capture,
			&mut Context::from_waker(std::task::Waker::noop()),
			&reply,
		);
	}
}

/// Abandon an op's scratch: pop the temporary scope of a builtin and
/// restore the fds its redirections replaced.
pub fn drop_scratch(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	mut sc: Box<Scratch>,
) {
	if sc.exec.as_ref().is_some_and(|e| e.scoped) {
		state::drop_scope(root, store, vp);
	}
	if let Some(io) = sc.io.as_mut() {
		for s in io.saved.drain(..).rev() {
			vp.fds.set(s.fd, s.prev);
		}
	}
	// Keep it cleared for a next op: a function call's op holds its own
	// while the body runs, so one spare per level saves a scratch (and
	// all its buffers) per call.
	if vp.spare.len() < SPARE_SCRATCH {
		sc.recycle();
		vp.spare.push(sc);
	}
}

/// Most cleared scratches a vproc keeps ([`Vproc::spare`]): enough for a
/// few nested calls, small for an idle vproc's memory.
const SPARE_SCRATCH: usize = 4;

/// Drop the top frame's scratch of an op that is over (recycled).
pub fn clear_scratch(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
	if let Some(sc) = top_frame(vp).scratch.take() {
		drop_scratch(root, store, vp, sc);
	}
}

/// Take the top frame's scratch, or a cleared one (the vproc's spare).
pub fn take_scratch(vp: &mut Vproc) -> Box<Scratch> {
	let sc = vp.frames.last_mut().and_then(|f| f.scratch.take());
	sc.unwrap_or_else(|| vp.spare.pop().unwrap_or_else(new_scratch))
}

/// Pop frames until `keep` remain.
pub fn unwind(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, keep: usize) {
	while vp.frames.len() > keep {
		pop_frame(root, store, vp);
	}
}

/// Restore saved fds (latest first).
pub fn restore(vp: &mut Vproc, saves: Vec<Saved>) {
	for s in saves.into_iter().rev() {
		vp.fds.set(s.fd, s.prev);
	}
}

/// Current script line of `node` in the top frame.
pub fn line_of(vp: &Vproc, node: u32) -> u32 {
	vp.frames
		.len()
		.checked_sub(1)
		.map_or(0, |fi| line_in(vp, fi, node))
}

/// [`line_of`] in frame `fi`. zsh numbers no lines in a function body
/// that is a lone command without braces (`f() cmd`, `() cmd`): `lineno`
/// stays the caller's.
pub(super) fn line_in(vp: &Vproc, fi: usize, node: u32) -> u32 {
	let f = &vp.frames[fi];
	let Some(u) = f.unit.as_ref() else {
		return 0;
	};
	if fi > 0 && keeps_caller_line(f) {
		let caller = &vp.frames[fi - 1];
		if let Some(op) = caller
			.unit
			.as_ref()
			.and_then(|cu| cu.ops.get(caller.pc as usize))
		{
			return line_in(vp, fi - 1, op.node);
		}
	}
	(u.line + u.nodes.get(node as usize).map_or(0, |n| n.line)).saturating_sub(f.line_shift)
}

/// Whether `f` is the call of a zsh function whose body is a lone command
/// without braces: its commands are on the caller's line (zsh numbers no
/// lines in it), and diagnostics count from the caller's base.
pub(super) fn keeps_caller_line(f: &Frame) -> bool {
	matches!(f.kind, FrameKind::Function { .. })
		&& f.unit.as_ref().is_some_and(|u| {
			u.mode.dialect() == Dialect::Zsh
				&& u
					.ops
					.first()
					.is_some_and(|op| matches!(op.code, Opcode::Exec | Opcode::Spawn))
		})
}

/// Unit-relative line of the last byte of syntax node `node`.
#[expect(clippy::naive_bytecount, reason = "one node's text; no bytecount dependency")]
pub fn end_line(unit: &Unit, node: u32) -> u32 {
	unit.nodes.get(node as usize).map_or(0, |n| {
		let text = unit
			.source
			.get(n.lo as usize..n.hi as usize)
			.unwrap_or_default();
		n.line + text.iter().filter(|&&c| c == b'\n').count() as u32
	})
}

/// The line bash reports for an error of a compound command (a failed
/// redirection, a rejected function definition): in the base frame of a
/// `( … )` child the subshell's last line ([`Frame::fork_line`]), else
/// `line`.
fn compound_line(vp: &Vproc, line: u32) -> u32 {
	vp.frames
		.last()
		.filter(|f| {
			f.kind == FrameKind::Subshell
				&& vp.jobs.comsub != super::proc::Comsub::Own
				&& f.unit.as_deref().is_some_and(|u| {
					super::killed::base_spawn(u, f.pc)
						.is_some_and(|(s, _)| s.kind == SpawnKind::Subshell)
				})
		})
		.and_then(|f| f.fork_line)
		.unwrap_or(line)
}

const fn depths(f: &Frame) -> Depths {
	Depths {
		enters: f.enters.len() as u32,
		cases:  f.cases.len() as u32,
		times:  f.times.len() as u32,
		redirs: f.redirs.len() as u32,
	}
}

/// Truncate a frame's stacks to `d`, restoring redirections.
fn truncate(vp: &mut Vproc, d: Depths) {
	let f = top_frame(vp);
	f.enters.truncate(d.enters as usize);
	f.cases.truncate(d.cases as usize);
	f.times.truncate(d.times as usize);
	let mut saves = Vec::new();
	while f.redirs.len() > d.redirs as usize {
		saves.push(f.redirs.pop().expect("checked"));
	}
	for s in saves {
		restore(vp, s.fds);
	}
}

/// Whether a bash `break`/`continue` reaches through a frame of `kind` to
/// the loops below it in the same vproc: `eval`, `${ ;}`, a `lastpipe`
/// stage and `$(< file)` run inside their caller's loops. Any other frame
/// stops it (a function call: bash zeroes `loop_level` there), as does a
/// vproc's first frame, below which come the forking shell's loops.
const fn bash_loop_frame(kind: &FrameKind) -> bool {
	matches!(
		kind,
		FrameKind::Script { what: ScriptKind::Eval, .. }
			| FrameKind::NoFork
			| FrameKind::Stage
			| FrameKind::Cat { .. }
	)
}

/// The loops a bash `break`/`continue` in `vp` may leave (bash's
/// `loop_level`): those of its frames from the top down through the ones
/// [`bash_loop_frame`] passes and, when that reaches the vproc's first
/// frame, its forking shell's ([`Vproc::outer_loops`]). A `${ }` or
/// `$(< file)` in a `( … )`'s own redirection stops it there too
/// ([`subshell_redirection`]).
pub fn bash_loop_count(vp: &Vproc) -> u32 {
	let mut n = 0u32;
	for (i, f) in vp.frames.iter().enumerate().rev() {
		n = n.saturating_add(u32::try_from(f.loops.len()).unwrap_or(u32::MAX));
		if i == 0 {
			return n.saturating_add(u32::from(vp.outer_loops));
		}
		if !bash_loop_frame(&f.kind) || subshell_redirection(&vp.frames[i - 1]) {
			break;
		}
	}
	n
}

/// Whether frame `f` is applying a `( … )`'s own redirections: its op is
/// the `Redir` that [`ir`] lowers just before the subshell's `Enter` and
/// `Spawn`. bash expands those words in the forked child, after
/// `execute_in_subshell` zeroes `loop_level`, so a `break` there, or in a
/// substitution started there, sees no loop; this shell expands them in
/// the parent, before the `Spawn`.
pub(super) fn subshell_redirection(f: &Frame) -> bool {
	f.unit
		.as_deref()
		.is_some_and(|unit| subshell_redirection_at(unit, f.pc))
}

/// Whether the op at `at` is a `( … )`'s own `Redir`: the subshell's
/// `Enter` and `Spawn` follow it.
fn subshell_redirection_at(unit: &Unit, at: u32) -> bool {
	let op = |at: u32| unit.ops.get(at as usize);
	op(at).is_some_and(|r| r.code == Opcode::Redir)
		&& op(at + 1).is_some_and(|e| e.code == Opcode::Enter)
		&& op(at + 2).is_some_and(|s| {
			s.code == Opcode::Spawn
				&& unit
					.spawns
					.get(s.a as usize)
					.is_some_and(|info| info.kind == SpawnKind::Subshell)
		})
}

/// Whether the op at frame `f`'s pc starts a `( … )` that has its own
/// redirection (its `Enter` or `Spawn`, after that `Redir` is applied):
/// bash expands the redirection in the forked child, so a trap that a
/// `kill $$` there sets off waits for the child, not for these ops.
pub(super) fn redirected_subshell_starts(f: &Frame) -> bool {
	let Some(unit) = f.unit.as_deref() else {
		return false;
	};
	let redir = match unit.ops.get(f.pc as usize).map(|op| op.code) {
		Some(Opcode::Enter) => f.pc.checked_sub(1),
		Some(Opcode::Spawn) => f.pc.checked_sub(2),
		_ => None,
	};
	redir.is_some_and(|at| subshell_redirection_at(unit, at))
}

/// The loops a child forked from `vp` runs inside ([`Vproc::outer_loops`]):
/// a zsh fork keeps all of them (zsh's `loops`); bash keeps them
/// (`loop_level`) only when `keeps`, a fork made without
/// `execute_in_subshell`: a simple command run as a pipeline element or a
/// job of one pipeline, a command or process substitution. bash zeroes the
/// level for `( … )`, a compound element, an and-or, compound or timed job
/// and a coprocess, and so for a substitution in a `( … )`'s own
/// redirection, which bash forks from that child ([`subshell_redirection`]).
pub fn fork_loops(vp: &Vproc, keeps: bool) -> u16 {
	let n = if vp.mode.dialect() == Dialect::Zsh {
		zsh_loop_count(vp)
	} else if keeps && !vp.frames.last().is_some_and(subshell_redirection) {
		bash_loop_count(vp)
	} else {
		0
	};
	// Past `u16::MAX` loops the count saturates ([`Vproc::outer_loops`]).
	u16::try_from(n).unwrap_or(u16::MAX)
}

/// The first op at or after `at` that is not the jump over a command or
/// process substitution's body: [`ir`] lowers a `$( )`, backtick or
/// `<( )` word's body in place, ahead of its command's own op, as a `Jmp`
/// to just past the body's `SubExit` (a child of its own runs it).
fn skip_blocks(unit: &Unit, mut at: u32) -> u32 {
	while let Some(op) = unit.ops.get(at as usize)
		&& op.code == Opcode::Jmp
		&& op.a > at
		&& unit
			.ops
			.get(op.a as usize - 1)
			.is_some_and(|end| end.code == Opcode::SubExit)
	{
		at = op.a;
	}
	at
}

/// Whether bash forks the job whose body starts at `entry` without
/// `execute_in_subshell`, so that it keeps the loop level ([`fork_loops`]):
/// a body of one pipeline, with or without `!`, whose simple commands bash
/// forks from the shell itself. An and-or list, a compound command or a
/// timed pipeline is run as a subshell (`CMD_FORCE_SUBSHELL`).
fn bash_job_keeps(unit: &Unit, entry: u32) -> bool {
	let entry = skip_blocks(unit, entry);
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let after = match unit.ops.get(entry as usize) {
		Some(op) if op.code == Opcode::Exec => entry + 1,
		Some(op) if op.code == Opcode::Spawn => match unit.spawns.get(op.a as usize) {
			Some(s) if s.kind == SpawnKind::Pipeline => s.end,
			_ => return false,
		},
		_ => return false,
	};
	let after = if code(after) == Some(Opcode::Not) {
		after + 1
	} else {
		after
	};
	code(after) == Some(Opcode::SubExit)
}

/// A `break`/`continue` that leaves this vproc's own loops for its forking
/// shell's ([`Vproc::outer_loops`]): as bash's `breaking` and zsh's
/// `breaks` skip the rest of a forked child's code, the vproc ends as at
/// the end of its code, with the builtin's status. zsh runs its EXIT trap
/// then (`zsh`); bash starts it too, but `breaking`, still set, skips each
/// of its commands, so it does nothing.
fn leave_outer_loop(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, zsh: bool) {
	unwind(&mut k.root, cx.store, vp, 0);
	if zsh {
		start_exit_trap_once(k, vp, cx);
	}
}

/// bash `break N` / `continue N`: leave N - 1 loops, at most as many as
/// [`bash_loop_count`] reaches (bash caps N at `loop_level`), then break
/// or continue the next; an `eval`, `lastpipe` stage or `$(< file)` in the
/// way is left with them, a `${ }` ends and holds the rest
/// ([`pending_break`]), and past the vproc's own loops it ends
/// ([`leave_outer_loop`]). The builtin answers a `break` with no loop in
/// reach itself and transfers nothing, so a loop is always in reach here.
/// bash's `break` is no jump: each command it leaves returns, so its
/// redirections are undone and its `time` reports as it ends
/// ([`end_left_commands`]), the frames above the loop's first.
fn break_loops(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, n: u32, cont: bool) {
	let reach = bash_loop_count(vp);
	debug_assert!(reach > 0, "`break_` transfers only with a loop in reach");
	let mut remaining = n.min(reach).max(1);
	// bash's `REAP` as the body of a loop it leaves or continues ends.
	let mut reap = false;
	let end = time_mark(&*cx.host);
	let line = vp
		.frames
		.last()
		.and_then(|f| f.unit.as_deref().and_then(|u| u.ops.get(f.pc as usize)))
		.map_or(0, |op| line_of(vp, op.node));
	loop {
		let f = top_frame(vp);
		let loops = f.loops.len();
		if remaining as usize <= loops {
			// A loop of this frame takes it; the loops inside that one end
			// with it.
			let keep = loops - remaining as usize;
			reap |= if let Some(unit) = f.unit.as_deref() {
				f.loops[keep..]
					.iter()
					.any(|rec| reaps_on_break(unit, rec, f.pc))
			} else {
				false
			};
			f.loops.truncate(keep + 1);
			let rec = f.loops[keep].clone();
			end_left_commands(k, vp, cx, rec.depth, end, line);
			// The status is the builtin's: 0, or 1 for `break 0` (which
			// leaves every loop); for a `break` that waited in a `${ }`,
			// the status of the command that held it.
			let status = vp.status;
			let f = top_frame(vp);
			// `continue` ends the body with its status too: the loop's
			// status if no other body command runs.
			if let Some(r) = f.loops.last_mut() {
				r.status = status;
			}
			f.pc = if cont { rec.cont } else { rec.exit };
			if reap {
				super::killed::cleanup_dead_jobs(vp);
			}
			return;
		}
		// Levels beyond this frame's loops: they all end, with the rest of
		// the frame's commands, and the next one out goes on with the count.
		reap |= if let Some(unit) = f.unit.as_deref() {
			f.loops.iter().any(|rec| reaps_on_break(unit, rec, f.pc))
		} else {
			false
		};
		remaining -= loops as u32;
		let no_fork = f.kind == FrameKind::NoFork;
		let passes = bash_loop_frame(&f.kind);
		let stage = matches!(f.kind, FrameKind::Stage);
		end_left_commands(k, vp, cx, Depths::default(), end, line);
		if no_fork {
			// bash's `break` only sets `breaking`: the body of `${ }` or
			// `${| }` ends here as at its end (`REPLY` passed on), the
			// command holding it runs, and a loop takes the levels left
			// after it ([`pending_break`]).
			pop_frame(&mut k.root, cx.store, vp);
			let depth = vp
				.frames
				.iter()
				.rposition(|f| !matches!(f.kind, FrameKind::Cat { .. }))
				.map_or(0, |i| i + 1);
			// A `${ }` in a redirection word or here-document of the command
			// now on top (see `PendingBreak::redir`).
			let in_redir = vp
				.frames
				.last()
				.and_then(|f| f.scratch.as_ref())
				.and_then(|s| s.exec.as_deref())
				.is_some_and(|e| e.stage == super::proc::Stage::Redirect);
			let redir = if in_redir { vp.frames.len() as u32 } else { 0 };
			vp.pending_break =
				Some(Box::new(PendingBreak { levels: remaining, cont, depth: depth as u32, redir }));
			return;
		}
		if passes && vp.frames.len() > 1 {
			if stage {
				lastpipe_stage_left(k, vp);
			}
			pop_frame(&mut k.root, cx.store, vp);
			// The caller's op (`eval`) is abandoned with the loop.
			clear_scratch(&mut k.root, cx.store, vp);
			continue;
		}
		break;
	}
	leave_outer_loop(k, vp, cx, false);
}

/// End, as they would end had they run to their end, the commands of the
/// top frame that a `break` or `continue` leaves, down to the frame's
/// stacks at `d`: in the order of the pending ops after its pc, each
/// `PopRedir` undoes its redirections (what is queued goes out first) and
/// each `TimeEnd` reports its `time` (`time -p`'s format for a `-p` one);
/// pairs that start after the pc are skipped. What is left is truncated.
fn end_left_commands(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	d: Depths,
	end: super::proc::TimeMark,
	line: u32,
) {
	if let Some(unit) = top_frame(vp).unit.clone() {
		let (mut timed, mut redirected) = (0u32, 0u32);
		for op in unit.ops.iter().skip(top_frame(vp).pc as usize) {
			let f = top_frame(vp);
			if f.times.len() <= d.times as usize && f.redirs.len() <= d.redirs as usize {
				break;
			}
			match op.code {
				Opcode::TimeStart => timed += 1,
				Opcode::TimeEnd if timed > 0 => timed -= 1,
				Opcode::TimeEnd => {
					if f.times.len() > d.times as usize
						&& let Some(start) = f.times.pop()
					{
						bash_time_report(k, vp, cx, op.b == 1, false, elapsed(start, end), line);
					}
				},
				Opcode::Redir => redirected += 1,
				Opcode::PopRedir if redirected > 0 => redirected -= 1,
				Opcode::PopRedir => {
					if f.redirs.len() > d.redirs as usize
						&& let Some(saves) = f.redirs.pop()
					{
						written_before_the_unwind(k, vp);
						restore(vp, saves.fds);
					}
				},
				_ => {},
			}
		}
	}
	written_before_the_unwind(k, vp);
	truncate(vp, d);
}

/// bash's `breaking` ([`Vproc::pending_break`]) at an op that would start:
/// `true` when it moved control (a loop took it, or a frame the waiting
/// command entered ended), `false` to run the op.
fn pending_break(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> bool {
	let Some(p) = vp.pending_break.as_deref().copied() else {
		return false;
	};
	let top = vp.frames.len() - 1;
	if vp.frames.len() > p.depth as usize {
		let kind = &vp.frames[top].kind;
		if matches!(kind, FrameKind::Cat { .. }) {
			// The command's own `$(< file)`: it reads its file and ends, and
			// the command finishes with its value.
			return false;
		}
		if matches!(kind, FrameKind::Function { .. }) {
			// A function the command called runs none of its commands (nor
			// its RETURN trap).
			unwind(&mut k.root, cx.store, vp, top);
			return true;
		}
		let frame = &mut vp.frames[top];
		if let FrameKind::Script { src, pos, stdin, .. } = &mut frame.kind {
			// Nor does an `eval` or `.` it started: its text ends here.
			pos.0 = src.len() as u32;
			*stdin = false;
			frame.unit = None;
			return true;
		}
		vp.pending_break = None;
		return false;
	}
	if vp.frames.len() == p.depth as usize {
		match own_loop(&vp.frames[top]) {
			OwnLoop::None => {},
			OwnLoop::Header => return false,
			OwnLoop::Test { until } => return own_loop_takes(k, vp, cx, p, Some(until)),
			OwnLoop::ArithTest => return own_loop_takes(k, vp, cx, p, None),
		}
	}
	vp.pending_break = None;
	if bash_loop_count(vp) > 0 {
		break_loops(k, vp, cx, p.levels, p.cont);
		return true;
	}
	// No loop is left to take it (a `return` carried it out of every
	// loop): bash would skip each command after it; this shell goes on.
	false
}

/// Where the op on top of frame `f` stands in a loop command whose own
/// redirection held a waiting `break` or `continue` ([`pending_break`]).
/// bash expands a compound command's redirections before it runs the
/// command, and a loop counts itself in `loop_level` only as it starts
/// (`execute_while_or_until` and its siblings), so the break waits through
/// the loop's header and the loop takes it: one level, with its first test
/// or body skipped.
#[derive(Clone, Copy)]
enum OwnLoop {
	/// Not such a loop's header, nor where it takes the break.
	None,
	/// The loop's header, which runs first: its `Enter`, record and words
	/// (a `for` binds its first word and a `select` reads its first line
	/// before bash's loop looks at `breaking`), and an arithmetic `for`'s
	/// first and test expressions. A `for` or `select` out of words or
	/// input at once ends without taking the break, which goes on out.
	Header,
	/// The first test of a `while` (`until`: true), which bash skips.
	Test { until: bool },
	/// The branch after an arithmetic `for`'s first test.
	ArithTest,
}

/// [`OwnLoop`] of the op at frame `f`'s pc, from the ops before it: only
/// the loop's own header lies between its `Redir` and the op, and a
/// waiting break reaches no op of it but through that `Redir`. A `for`'s
/// `ForNext` just after its `ForIn` runs too: a break in its words waits
/// for the first word as bash's does, as bash counts the loop before it
/// expands them. The bodies of the substitutions in a `for`'s or
/// `select`'s words lie in its header too ([`before_blocks`]); the jump
/// over one is the header's, and the break never runs one: [`start_sub`]
/// expands each to nothing, as bash runs no command while `breaking`.
fn own_loop(f: &Frame) -> OwnLoop {
	let Some(unit) = f.unit.as_deref() else {
		return OwnLoop::None;
	};
	let pc = f.pc;
	let Some(&op) = unit.ops.get(pc as usize) else {
		return OwnLoop::None;
	};
	if op.code == Opcode::LoopExit {
		return match f.loops.last() {
			Some(rec)
				if rec.exit == pc
					&& matches!(rec.kind, LoopKind::For { .. } | LoopKind::Select { .. }) =>
			{
				OwnLoop::Header
			},
			_ => OwnLoop::None,
		};
	}
	let Some(prev_at) = before_blocks(unit, pc) else {
		return OwnLoop::None;
	};
	let prev = unit.ops[prev_at as usize];
	if op.code == Opcode::ForNext && prev.code == Opcode::ForIn && prev.node == op.node {
		return OwnLoop::Header;
	}
	let node = prev.node;
	let mut at = prev_at;
	loop {
		let o = unit.ops[at as usize];
		if o.node != node {
			return OwnLoop::None;
		}
		match o.code {
			Opcode::Redir => break,
			Opcode::Enter | Opcode::Arith | Opcode::LoopEnter | Opcode::ForIn | Opcode::SetStatus => {
			},
			_ => return OwnLoop::None,
		}
		let Some(before) = before_blocks(unit, at) else {
			return OwnLoop::None;
		};
		at = before;
	}
	let ours = op.node == node;
	match unit.nodes.get(node as usize).map(|n| n.kind) {
		Some(NodeKind::While | NodeKind::Until)
			if ours && matches!(op.code, Opcode::Enter | Opcode::LoopEnter) =>
		{
			OwnLoop::Header
		},
		Some(kind @ (NodeKind::While | NodeKind::Until)) if prev.code == Opcode::LoopEnter => {
			OwnLoop::Test { until: kind == NodeKind::Until }
		},
		Some(NodeKind::For | NodeKind::Select)
			if (ours && matches!(op.code, Opcode::Enter | Opcode::ForIn)) || block_at(unit, pc) =>
		{
			OwnLoop::Header
		},
		Some(NodeKind::ArithFor)
			if ours
				&& matches!(
					op.code,
					Opcode::Enter | Opcode::Arith | Opcode::LoopEnter | Opcode::SetStatus
				) =>
		{
			OwnLoop::Header
		},
		Some(NodeKind::ArithFor) if ours && op.code == Opcode::BrFail => OwnLoop::ArithTest,
		_ => OwnLoop::None,
	}
}

/// Whether the op at `pc` is the jump over a substitution's body, as
/// [`ir`] lowers a `$( )`, `${ }`, `${| }` or `<( )` in a word (`block`):
/// a `Jmp` of node 0 to the op after the body's `SubExit`.
fn block_at(unit: &Unit, pc: u32) -> bool {
	unit.ops.get(pc as usize).is_some_and(|op| {
		op.code == Opcode::Jmp
			&& op.node == 0
			&& op.a > pc + 1
			&& unit
				.ops
				.get(op.a as usize - 1)
				.is_some_and(|end| end.code == Opcode::SubExit && end.node == 0)
	})
}

/// The pc of the op before `pc`, past the substitution bodies
/// ([`block_at`]) that end just before it, an outer body with the bodies
/// it holds; `None` at the unit's start.
fn before_blocks(unit: &Unit, pc: u32) -> Option<u32> {
	let mut at = pc.checked_sub(1)?;
	loop {
		let end = unit.ops[at as usize];
		if end.code != Opcode::SubExit || end.node != 0 {
			return Some(at);
		}
		let after = at + 1;
		let jump = (0..at)
			.rev()
			.find(|&j| block_at(unit, j) && unit.ops[j as usize].a == after)?;
		at = jump.checked_sub(1)?;
	}
}

/// The loop whose own redirection held the waiting break `p` takes it, as
/// bash's loop does on its first pass: a `while` (`until`: `Some(true)`)
/// at its first test, which bash skips with the status `$?` has; an
/// arithmetic `for` (`None`) after its first test. A `continue` of one
/// level lets the loop go on (a `while` whose skipped test succeeds, an
/// `until` whose skipped test fails: its body is skipped too; an
/// arithmetic `for`'s test decides, as on any pass); anything else ends
/// the loop, with the status bash's returns, and the levels left go to the
/// loops around it ([`break_loops`]).
fn own_loop_takes(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	p: PendingBreak,
	until: Option<bool>,
) -> bool {
	vp.pending_break = None;
	let skipped = vp.status;
	if p.cont && p.levels == 1 {
		match until {
			Some(until) if (skipped == 0) != until => {
				// The body bash skipped is the loop's last one so far.
				if let Some(rec) = top_frame(vp).loops.last_mut() {
					rec.status = skipped;
				}
				return false;
			},
			None => return false,
			Some(_) => {
				vp.status = 0;
				break_loops(k, vp, cx, 1, false);
				return true;
			},
		}
	}
	// An `until` returns its skipped body's status (the skipped test's when
	// that failed, 0 when it ended the loop); a `while` and an arithmetic
	// `for` return 0, no body having run.
	vp.status = if until == Some(true) { skipped } else { 0 };
	break_loops(k, vp, cx, p.levels, p.cont);
	true
}

/// A `break` or `continue` leaves the last stage of a `lastpipe` pipeline,
/// the top frame, with its status: bash's `execute_pipeline` still appends
/// the stage to the pipeline's job as it ends (`append_process`), as the
/// stage's normal end does ([`super::proc::JobTable::lastpipe_stage_ended`]),
/// before the loop goes.
fn lastpipe_stage_left(k: &Kernel, vp: &mut Vproc) {
	let n = vp.frames.len();
	let Some(first) = n
		.checked_sub(2)
		.and_then(|i| vp.frames.get(i))
		.and_then(|f| f.scratch.as_ref())
		.and_then(|sc| sc.children.first())
		.map(|&(v, _)| v)
	else {
		return;
	};
	let text = BString::from(vp.command_text());
	let platform = k.engine.config().platform;
	let (shell, status) = (vp.vpid, vp.status);
	vp.jobs
		.lastpipe_stage_ended(first, shell, text, status, platform);
}

/// Whether bash runs `REAP` as `break` or `continue` at `pc` ends the body
/// of loop `rec` (`execute_for_command`, `execute_select_command`,
/// `execute_while_or_until` reap before they look at `breaking`): a `for`,
/// `select` or `while` loop's body, or its condition (a `while` whose
/// condition `break` ends runs the rest of its body as nothing, then
/// reaps); an `until` loop's body, not its condition (`break` succeeds, so
/// the loop ends at once). An arithmetic `for` reaps only after its test.
fn reaps_on_break(unit: &Unit, rec: &super::proc::LoopRec, pc: u32) -> bool {
	let Some(node) = unit.ops.get(rec.exit as usize).map(|o| o.node) else {
		return false;
	};
	match unit.nodes.get(node as usize).map(|n| n.kind) {
		Some(NodeKind::For | NodeKind::Select | NodeKind::While) => true,
		Some(NodeKind::Until) => {
			// The condition runs from `rec.cont` to the `BrOk` that ends it.
			let test_end = (rec.cont..rec.exit).find(|&at| {
				unit
					.ops
					.get(at as usize)
					.is_some_and(|o| o.code == Opcode::BrOk && o.node == node)
			});
			!test_end.is_some_and(|end| rec.cont <= pc && pc < end)
		},
		_ => false,
	}
}

/// The top frame's scratch, created from the vproc's spare if absent.
/// Inlined: the staged ops call it for every field access (xeon profile:
/// `exec::scratch` 3 % self on loop/func); building a new one is cold.
#[inline]
pub fn scratch(vp: &mut Vproc) -> &mut Scratch {
	let spare = &mut vp.spare;
	vp.frames
		.last_mut()
		.expect("ops run in a frame")
		.scratch
		.get_or_insert_with(|| spare.pop().unwrap_or_else(new_scratch))
}

/// A fresh scratch, built in place on the heap; once per vproc in steady
/// state (the spare is reused).
#[cold]
#[inline(never)]
fn new_scratch() -> Box<Scratch> {
	Box::default()
}

/// Result of an expansion step of an op: `Ok` with the value, or the flow
/// that ends the op for now.
pub type Expanded<T> = Result<T, Flow>;

/// Run `f` as an expansion of the current op, with its replay log; start a
/// command substitution when one is needed and park until it is done.
pub fn expanding<T>(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	slot: Slot,
	record: bool,
	line: u32,
	f: impl FnOnce(&mut Expander<'_, '_>) -> Result<T, Stop>,
) -> Expanded<T> {
	let fi = vp.frames.len() - 1;
	let mut sc = take_scratch(vp);
	if let Some(flow) = settle_sub(k, vp, cx, &mut sc, slot) {
		top_frame(vp).scratch = Some(sc);
		return Err(flow);
	}
	let mut log = std::mem::take(&mut sc.logs[slot as usize]);
	// A word of redirections bash makes in a child: the pass runs on that
	// child's state, which the command's words share ([`redir::enter_child`]).
	// A substitution it stops for starts below, and settles above, with the
	// shell's own (a `$( )` forks from the child's: [`start_sub`]).
	let shell = k
		.redirs_in_child
		.then(|| redir::enter_child(k, vp, cx, &mut sc));
	let res = {
		let mut ex = Expander::new(k, cx, vp, &mut log, record, line);
		let r = super::zsh::subst::begin_pass(&mut ex).and_then(|()| f(&mut ex));
		let st = ex.sub_status;
		r.map(|v| (v, st))
	};
	if let Some(shell) = shell {
		redir::leave_child(k, vp, cx, &mut sc, shell);
	}
	// The slot still holds the empty `Vec` `take` left there (the scratch is
	// out of its frame meanwhile, nothing else fills it): put the log back
	// without a drop of that placeholder per expansion.
	let placeholder = std::mem::replace(&mut sc.logs[slot as usize], log);
	debug_assert_eq!(placeholder.capacity(), 0, "expansion log placeholder");
	std::mem::forget(placeholder);
	match res {
		Ok((v, sub)) => {
			if let (Some(status), Some(e)) = (sub, sc.exec.as_mut()) {
				e.sub_status = Some(status);
			}
			top_frame(vp).scratch = Some(sc);
			Ok(v)
		},
		Err(Stop::Sub { unit, entry, form, text }) => {
			// A no-fork substitution pushes its frame above this op's.
			let flow = start_sub(k, vp, cx, &mut sc, Sub { unit, entry, form, text, line });
			vp.frames[fi].scratch = Some(sc);
			Err(flow)
		},
		Err(stop) => Err(stopped(k, vp, cx, sc, slot, line, stop)),
	}
}

/// The flow of an [`expanding`] op whose expansion stopped other than for
/// a bash command substitution: a zsh one or an expansion probe (`=cmd`) to
/// run first, else an error ([`stop_flow`]). The scratch goes back to the
/// op's frame, still the top one. Out of line: one copy, not one per
/// [`expanding`] instance.
#[inline(never)]
fn stopped(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	mut sc: Box<Scratch>,
	slot: Slot,
	line: u32,
	stop: Stop,
) -> Flow {
	match stop {
		Stop::ZshSub { text, here } => {
			// A call run here pushes its frame above this op's.
			let fi = vp.frames.len() - 1;
			let flow = start_zsh_sub(k, vp, cx, &mut sc, &text, here, line);
			vp.frames[fi].scratch = Some(sc);
			flow
		},
		Stop::MathCall(call) => {
			// The function's frame goes above this op's.
			let fi = vp.frames.len() - 1;
			let flow = super::command::start_math_call(k, vp, cx, &mut sc, slot, &call, line);
			vp.frames[fi].scratch = Some(sc);
			flow
		},
		Stop::Probe(p) => {
			// Answered: log it and run the op again (it replays).
			let flow = match settle_probe(k, cx, vp, &mut sc, slot, &p) {
				Ok(()) => Flow::Call,
				// zsh's `$(< word)` reads the file in the shell: an open that
				// waits (a FIFO without its other end) decides the background
				// job this vproc decides on its virtual pid, as a zsh
				// redirection's does ([`redir::apply`]), so a reader of `$!`
				// never waits on that rendezvous, which may need the reader.
				Err(key @ WaitKey::Fs { op: FsOp::Open, .. })
					if matches!(p, Probe::Read { .. }) && !k.bangs.is_empty() =>
				{
					k.settle_bang(vp.vpid, None);
					Flow::Block(key)
				},
				Err(key) => Flow::Block(key),
			};
			top_frame(vp).scratch = Some(sc);
			flow
		},
		stop => {
			top_frame(vp).scratch = Some(sc);
			stop_flow(k, vp, cx, line, stop)
		},
	}
}

/// Expansion errors end the shell, as a syntax error in a compound value
/// given as a string does: posix mode, not interactive.
pub(super) fn posix_exits(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false)
		&& !matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		)
}

/// The status a fatal expansion error leaves when the EXIT trap is the
/// innermost trap action running: bash's EXIT trap keeps the status the
/// shell was exiting with (`last_command_exit_value` is saved across the
/// trap), so the shell leaves with that status and not with the constant
/// below. Only the EXIT trap does this, so a nested trap action of any
/// other kind answers `None` and keeps the constant.
///
/// The saved status is carried as the `i32` the frame holds, exactly as
/// every other reader of it does (`return` with no argument inside a
/// trap, the frame-pop restore); it is already a wait status in `0..=255`
/// on every path that arms a trap, and narrowing it here would be a
/// silent second opinion about a value this function does not own.
fn exit_trap_status(vp: &Vproc) -> Option<i32> {
	vp.frames.iter().rev().find_map(|frame| match frame.kind {
		FrameKind::Script { what: ScriptKind::Trap { key, status, .. }, .. } => {
			Some((key == TrapKey::Exit).then_some(status))
		},
		_ => None,
	})?
}

/// The flow for an expansion error (the diagnostic is printed).
pub fn stop_flow(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, stop: Stop) -> Flow {
	// A background job still deciding its pid takes the signals `kill` held for
	// it before an expansion error ends its command, as [`command::exec`]'s
	// expand block does for flows not routed through here, and as `Stop::Wait`
	// does: the op replays once the signals are taken, and a fatal one ends the
	// job before its diagnostic. The `Fail`/`Fatal` arms write that
	// diagnostic (`jump_out`) before the caller could truncate `vp.out`, so the
	// hold is taken here, ahead of the match.
	if matches!(stop, Stop::Fail(_) | Stop::Fatal(_)) && !k.bangs.is_empty() && k.take_held(vp.vpid)
	{
		return Flow::Block(WaitKey::Signal);
	}
	match stop {
		Stop::Sub { .. } | Stop::ZshSub { .. } => unreachable!("handled by the caller"),
		// An expansion that cannot park (a glob qualifier's) met a math
		// function.
		Stop::MathCall(call) => {
			let what = format!("a call of math function {} in this expansion", call.argzero);
			k.diag(cx, vp, line, Diag::Unsupported { what: what.into() });
			Flow::Discard(1)
		},
		// `$!` of a job still deciding on its pid: the op runs again (and
		// replays) once it has.
		Stop::Wait(key) => Flow::Block(key),
		// A process substitution found no vpid left.
		Stop::ForkFailed => fork_failure(k, vp, cx, line),
		// An expansion that cannot park (a glob qualifier's) met `=cmd`.
		Stop::Probe(_) => {
			k.diag(cx, vp, line, Diag::Unsupported { what: "`=cmd` in this expansion".into() });
			Flow::Discard(1)
		},
		// Under `set -e` bash's `report_error` exits the shell itself.
		Stop::Fail(d) | Stop::Fatal(d) if report_error_exits(k, cx, vp, &d) => {
			let status = report_error_status(vp, &d);
			k.diag(cx, vp, line, d);
			Flow::Exit(status, Jump::Direct)
		},
		// An arithmetic subscript error: bash's `array_expand_index` runs
		// `top_level_cleanup`, then jumps to the top level, in a posix shell
		// too.
		Stop::Fail(d) | Stop::Fatal(d) if cleanup_jump(vp, &d) => {
			k.diag(cx, vp, line, d);
			let flow = Flow::DiscardTop(1);
			jump_out(k, cx, vp, true, &flow);
			flow
		},
		// A non-interactive posix shell exits on an expansion error (bash's
		// `posixly_correct && !interactive_shell`), as on a fatal one.
		Stop::Fail(d) if !posix_exits(k, cx, vp) => {
			k.diag(cx, vp, line, d);
			let flow = Flow::Discard(1);
			jump_out(k, cx, vp, false, &flow);
			flow
		},
		Stop::Fail(d) | Stop::Fatal(d) => {
			// An arithmetic subscript error took the cleanup arm above.
			let jump = top_level_jump(cx, vp, false);
			k.diag(cx, vp, line, d);
			let flow = Flow::Exit(force_eof_status(k, cx, vp), jump);
			jump_out(k, cx, vp, false, &flow);
			flow
		},
		Stop::Store(err) => {
			k.fail(err);
			Flow::Discard(1)
		},
	}
}

/// The status a fatal error exits a non-interactive posix shell with
/// (bash's `jump_to_top_level (FORCE_EOF)`). The EXIT trap keeps the status
/// the shell was exiting with. Under `set -e` bash's `report_error` exits on
/// its own ([`report_error_exits`]); for the other errors bash reaches the
/// same rows through its own errexit jump, which is not modelled, so the
/// constant below stays whenever errexit is on.
pub(super) fn force_eof_status(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> i32 {
	if vp.mode.dialect() != Dialect::Zsh
		&& let Some(status) = exit_trap_status(vp)
		&& !errexit_on(k, cx, vp)
	{
		return status;
	}
	// bash exits 127 when the error reaches the command loop of a `-c`
	// string (`run_one_command`), 1 from a script and from a nearer
	// `top_level` ([`fatal_reaches_command_loop`]). Under `set -e` bash's
	// `report_error` exits at once with the failure status. zsh exits 1 from
	// any of them (`errflag` ends `loop` with 1).
	let command = vp.mode.dialect() != Dialect::Zsh
		&& fatal_reaches_command_loop(vp)
		&& !errexit_on(k, cx, vp)
		&& matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
			Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
		);
	if command { 127 } else { 1 }
}

/// Whether a fatal error here ends at bash's command loop rather than at a
/// nearer `top_level`: a subshell and a substitution set their own
/// (`execute_in_subshell`, `command_substitute`), and so does a builtin that
/// a forked simple command runs (`execute_subshell_builtin_or_function`). A
/// forked pipeline element's or async command's own expansion, and a
/// function it runs, reach the `top_level` its fork copied from its forking
/// shell ([`super::proc::FrameFlags::command_loop`] of its base frame, this
/// answer for the forking shell when it forked): the command loop only when the
/// forking shell's error would reach it too, so not for an element forked
/// inside `( … )`, `$( )` or `<( )`. So do a negated simple job (`! f &`) and
/// the own redirection of a compound that is a whole element or job
/// (`{ :; } 2>"$w" | cat`, `{ :; } 2>"$w" &`, a job's timed or negated
/// too: `time { :; } 2>"$w" &`): bash forks that compound itself
/// (`execute_command_internal`), and its child expands the compound's
/// redirections (`execute_in_subshell`) before it sets a `top_level` of its
/// own. Not a compound that is only the first command of a job's and-or
/// list (`{ :; } 2>"$w" && : &`, timed too): bash forks the whole list
/// (`execute_connection`), and that child sets its `top_level` before the
/// list runs the compound (1). A background job that is one async pipeline
/// passes its stored answer on: bash forks that pipeline's elements from
/// the shell itself ([`async_pipeline`]), so obash's job vproc stands for no
/// fork of bash's. A nested shell (depth 0) is its own shell.
pub fn fatal_reaches_command_loop(vp: &Vproc) -> bool {
	let Some(base) = vp.frames.first() else {
		return super::subshell_depth(vp) == 0;
	};
	if vp.parent.is_some()
		&& let Some(unit) = base.unit.as_deref()
	{
		let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
		let pc = base.pc;
		let forked_simple = simple_stage(unit, pc).is_some_and(|si| {
			matches!(unit.spawns[si].kind, SpawnKind::Pipeline | SpawnKind::Background)
		});
		// `! f &`: the job's simple command, then its `Not`.
		let negated_job = code(pc) == Some(Opcode::Exec)
			&& code(pc + 1) == Some(Opcode::Not)
			&& code(pc + 2) == Some(Opcode::SubExit)
			&& unit.spawns.iter().any(|s| {
				s.kind == SpawnKind::Background
					&& s
						.stages
						.first()
						.is_some_and(|st| stage_command(unit, st.entry) == pc)
			});
		if forked_simple || negated_job {
			return base.flags.command_loop()
				&& vp
					.frames
					.get(1)
					.is_none_or(|f| matches!(f.kind, FrameKind::Function { .. }));
		}
		// The stage's first op past its words' substitution bodies, and
		// past a `time` of the job's whole body (`[TimeStart] Redir Enter …`).
		let first = |entry: u32| {
			let at = skip_blocks(unit, entry);
			if code(at) == Some(Opcode::TimeStart) {
				skip_blocks(unit, at + 1)
			} else {
				at
			}
		};
		// The compound whose redirection is at `pc` must be the stage's whole
		// command ([`ends_stage`] past the `Redir`'s `b`, just past its
		// `PopRedir`), not the first command of an and-or list.
		let own_redir = vp.frames.len() == 1
			&& code(pc) == Some(Opcode::Redir)
			&& ends_stage(unit, unit.ops[pc as usize].b)
			&& unit.spawns.iter().any(|s| {
				matches!(s.kind, SpawnKind::Pipeline | SpawnKind::Background)
					&& s.stages.iter().any(|st| first(st.entry) == pc)
			});
		let async_job = vp.frames.len() == 1
			&& unit.ops.get(pc as usize).is_some_and(|op| {
				op.code == Opcode::Spawn
					&& unit
						.spawns
						.get(op.a as usize)
						.is_some_and(|s| s.kind == SpawnKind::Pipeline)
					&& async_pipeline(unit, op.a as usize)
			});
		if own_redir || async_job {
			return base.flags.command_loop();
		}
	}
	super::subshell_depth(vp) == 0
}

/// Answer the expansion probe `p` ([`Stop::Probe`]) of the op whose scratch
/// is `sc` and log the answer in `slot` ([`probe_atom`]) for the replay;
/// `Err` is the wait key while the probe is pending.
pub fn settle_probe(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	slot: Slot,
	p: &Probe,
) -> Result<(), WaitKey> {
	let answer = match super::probe::cached(sc, p) {
		Some(r) => r.clone(),
		None => super::probe::perform(k, cx, vp, sc, p)?,
	};
	sc.logs[slot as usize].push(probe_atom(answer));
	Ok(())
}

/// The logged form of an expansion probe's answer: a PATH search's path
/// (`None`: not found); an access check's success as an empty string; a
/// filesystem request's ([`super::fsprobe`]) bytes, names (a list), other
/// success (empty) or failure (`None`); a file read's contents, or its
/// failure's `strerror` text as a one-item list.
pub fn probe_atom(answer: ProbeResult) -> Atom {
	use super::fsprobe::FsAns;
	Atom::Str(match answer {
		ProbeResult::Path(p) => p,
		ProbeResult::Ok(ok) => ok.then(BString::default),
		ProbeResult::Fs(Ok(FsAns::Names(names))) => return Atom::List(names),
		// User database entries: name and home directory of each.
		ProbeResult::Fs(Ok(FsAns::Users(users))) => {
			return Atom::List(users.into_iter().flat_map(|u| [u.name, u.dir]).collect());
		},
		ProbeResult::Fs(Ok(FsAns::Bytes(b))) => Some(b),
		ProbeResult::Fs(Ok(_)) => Some(BString::default()),
		// A file read ([`Probe::Read`], zsh's `$(< word)`): its contents, or
		// the `strerror` text of the failure as a one-item list.
		ProbeResult::Bytes(Ok(b)) => Some(b),
		ProbeResult::Bytes(Err(err)) => return Atom::List(vec![err]),
		_ => None,
	})
}

/// A command substitution to start: its body and the line of the command
/// that runs it.
pub struct Sub {
	/// Unit holding the body.
	pub unit:  Arc<Unit>,
	/// Entry pc of the body.
	pub entry: u32,
	/// Syntax form.
	pub form:  ComsubForm,
	/// `strs` index of the body's source text.
	pub text:  Option<u32>,
	/// Line of the command running it.
	pub line:  u32,
}

/// Start a command substitution for the op whose scratch is `sc`.
pub fn start_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	sub: Sub,
) -> Flow {
	// bash's `breaking`: while a `break` in an earlier `${ }` or `${| }` of
	// the command waits for its loop, no later substitution runs a command
	// (`execute_command_internal` returns at once); each expands to nothing.
	if vp.pending_break.is_some() {
		sc.sub = Some(PendingSub::NoFork { capture: Capture::default(), value: false });
		return Flow::Call;
	}
	let Sub { unit, entry, form, text, line } = sub;
	let first = unit
		.ops
		.get(entry as usize)
		.and_then(|op| unit.nodes.get(op.node as usize))
		.map_or(line, |n| unit.line + n.line);
	// `line` is already shifted by this frame, so the difference is the
	// child's whole shift.
	let shift = first.saturating_sub(line);
	let capture = Capture::default();
	let out = FdRef::mem(capture.clone());
	// A command substitution runs without `set -e` unless `inherit_errexit`
	// (on in posix mode) is set.
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let inherit =
		posix || state::option(&mut k.root, cx.store, vp, OptId::InheritErrexit).unwrap_or(false);
	match form {
		// `$(< file)`: bash reads the file in the shell itself, with no
		// subshell (`optimize_cat_file`): the redirection's word expands as
		// the shell's own (`set -u` ends the shell; no DEBUG trap, xtrace or
		// ERR trap for the `< file`, which is no command bash runs). The body
		// runs here in a frame of its own ([`FrameKind::Cat`]) that holds the
		// capture; its `Exec` ([`ir::Op::CAT`]) appends the file to it. The
		// shell's fds are left alone, so what the word's expansion writes
		// (`${| cmd; }`) and an EXIT trap a fatal error in it runs write
		// where the shell does. A failure inside does not count for `set -e`.
		ComsubForm::Fork if unit.cat_exec(entry).is_some() => {
			let kind = FrameKind::Cat { capture: capture.clone() };
			let mut frame = Frame::new(Some(unit), entry, kind);
			frame.line_shift = shift;
			frame.ignore_errexit = true;
			vp.frames.push(frame);
			sc.sub = Some(PendingSub::NoFork { capture, value: false });
			Flow::Call
		},
		ComsubForm::Fork => {
			// The job deciding its pid takes the signals `kill` held for it
			// before it starts this child, as bash's forked job has them before
			// it forks a command substitution. Without one the child is the
			// job's kin ([`Kernel::bang_kin`]), below.
			if k.take_held(vp.vpid) {
				return Flow::Block(WaitKey::Signal);
			}
			if let Some(flow) = fork_failed(k, vp, cx, 1, line) {
				return flow;
			}
			let mut fds = vp.fds.clone();
			fds.set(1, Some(out));
			// Outside posix mode bash parses `$( )` without aliases and
			// re-parses its text with the aliases in effect when it runs,
			// numbering its lines from the line the shell is at: at top
			// level, where the whole command ends.
			let base = top_level_end_line(vp).unwrap_or(line);
			let reparse = text.and_then(|i| unit.strs.get(i as usize)).filter(|_| {
				!posix && (base != line || matches!(builtins::alias_table(k, cx, vp), Ok(Some(_))))
			});
			// A `$( )` in a word of redirections bash makes in a child forks
			// from that child, so it sees what the word wrote before it
			// ([`redir::enter_child`]).
			let shell = k.redirs_in_child.then(|| redir::enter_child(k, vp, cx, sc));
			let mut child = if let Some(src) = reparse {
				vp.child_text(k, cx.store, src, base, fds)
			} else {
				let mut child = vp.child(k, cx.store, Arc::clone(&unit), entry, fds);
				if let Some(f) = child.frames.last_mut() {
					f.line_shift = shift;
				}
				// A body without a command (`$()`, `$( )`, only comments)
				// exits 0, as bash's subshell does when it runs nothing; the
				// inherited `$?` matters only to a command that reads it. A
				// re-parsed body gets the same from its script frame's end.
				if unit
					.ops
					.get(entry as usize)
					.is_some_and(|op| op.code == Opcode::SubExit)
				{
					child.status = 0;
				}
				// A re-parsed one counts its `eval`-like frame instead.
				child.trace_base += 1;
				child
			};
			if let Some(shell) = shell {
				redir::leave_child(k, vp, cx, sc, shell);
			}
			k.bang_kin_add(vp.vpid, child.vpid);
			zsh_subshell_traps(k, cx, &mut child, false);
			// bash runs the text with `parse_and_execute` (`command_substitute`):
			// a level of its own unless the fork kept an older one.
			let level = child.frames[0].flags.parse_level().substitution_base();
			child.frames[0].flags.set_parse_level(level);
			// With `-e` already off in the parent the child sees it off and
			// `SHELLOPTS` is already right: nothing to reset.
			if !inherit && state::option(&mut k.root, cx.store, vp, OptId::Errexit).unwrap_or(true) {
				state::store_record(
					&mut k.root,
					cx.store,
					&mut child,
					KeyBuf::Opt(OptId::Errexit),
					Some(Record::Opt(false)),
				);
				if let Err(err) = state::sync_option_vars(&mut k.root, cx.store, &mut child) {
					k.fail(err);
				}
			}
			// bash keeps job control and the job list in `$( )`: `jobs`
			// lists the parent's jobs, `fg` finds no current job. bash 5.3
			// drops the finished jobs it would not report there first,
			// unless the parent's job list is frozen.
			child.jobs = inherited_jobs(vp, vp.jobs.subshell);
			// bash and zsh keep the loop level: a `break` ends the substitution.
			child.outer_loops = fork_loops(vp, true);
			sub_runs_no_debug_trap(vp, &mut child);
			child.jobs.comsub = super::proc::Comsub::Own;
			if child.mode.dialect() != Dialect::Zsh {
				drop_finished_jobs(k, cx, vp, &mut child);
			}
			// Its externals stay in the shell's process group.
			super::jobctl::set_leader(k, child.vpid, None);
			let vpid = child.vpid;
			k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
			k.spawned.push(Box::new(child));
			sc.sub = Some(PendingSub::Fork { vpid, capture });
			super::wait_starts(k, cx, vp);
			Flow::Block(WaitKey::Proc(vpid))
		},
		ComsubForm::NoFork | ComsubForm::Value => {
			// Its own scope for `local` (marked with an empty function name,
			// which `FUNCNAME` skips); `${| ;}` has a local `REPLY`. In a word
			// of redirections bash makes in a child, bash runs the body in that
			// child: it reads what the command's earlier words wrote there,
			// which this scope holds for it, so the shell sees none of it and a
			// write of one of those names stays in the body.
			let mut vars = VarMap::default();
			if k.redirs_in_child {
				redir::child_vars(sc, &mut vars);
			}
			if form == ComsubForm::Value {
				vars.insert(BString::from("REPLY"), None);
			}
			let scope = Scope {
				vars:       vars.into(),
				positional: None,
				func:       Some(BString::default()),
				zsh:        None,
			};
			state::push_scope(&mut k.root, cx.store, vp, scope);
			// Outside posix mode bash parses `${ ;}` without aliases and
			// re-parses its re-printed text when it runs, with the aliases
			// then in effect and lines counted from the command's line.
			let reparse = if posix {
				None
			} else {
				text.and_then(|i| {
					let t = unit.strs.get(i as usize)?;
					nofork_unit(k, cx, vp, (unit.id, i), t, line)
				})
			};
			let (unit, entry, shift) = match reparse {
				Some(u) => (u, 0, 0),
				None => (unit, entry, shift),
			};
			let mut frame = Frame::new(Some(unit), entry, FrameKind::NoFork);
			frame.line_shift = shift;
			// It shares the shell's options, so `-e` is ignored instead.
			frame.ignore_errexit = !inherit;
			let prev = vp.fds.get(1).cloned();
			if form == ComsubForm::NoFork {
				vp.fds.set(1, Some(out));
				frame.redirs.push(vec![Saved { fd: 1, prev }].into());
			}
			vp.frames.push(frame);
			sc.sub = Some(PendingSub::NoFork { capture, value: form == ComsubForm::Value });
			Flow::Call
		},
	}
}

/// Start a zsh command substitution: `text` (zsh source, the body of
/// `$(…)` or `` `…` ``) parsed in the vproc's mode and run in a forked
/// child vproc whose standard output is captured (zsh `getoutput`).
/// `here` ([`Stop::ZshSub::here`]): a hook function call zsh makes from an
/// expansion (`subst_string_by_func`) runs in the current shell instead,
/// above the op's frame, its output uncaptured; the logged substitution
/// is its status.
pub fn start_zsh_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	text: &[u8],
	here: bool,
	line: u32,
) -> Flow {
	if here {
		sc.sub = Some(PendingSub::Here { status: vp.status });
		push_script(vp, text, line, ScriptKind::Hook);
		return Flow::Call;
	}
	if let Some(flow) = fork_failed(k, vp, cx, 1, line) {
		return flow;
	}
	let capture = Capture::default();
	let mut fds = vp.fds.clone();
	fds.set(1, Some(FdRef::mem(capture.clone())));
	let mut child = vp.child_text(k, cx.store, text, line, fds);
	k.bang_kin_add(vp.vpid, child.vpid);
	zsh_subshell_traps(k, cx, &mut child, false);
	child.jobs = inherited_jobs(vp, vp.jobs.subshell);
	child.outer_loops = fork_loops(vp, true);
	sub_runs_no_debug_trap(vp, &mut child);
	// Its externals stay in the shell's process group (zsh
	// `ESUB_NOMONITOR`).
	super::jobctl::set_leader(k, child.vpid, None);
	let vpid = child.vpid;
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	sc.sub = Some(PendingSub::Fork { vpid, capture });
	Flow::Block(WaitKey::Proc(vpid))
}

/// The direction of a zsh process substitution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZshProcSub {
	/// `<(…)`: the shell reads what the body writes.
	Input,
	/// `>(…)`: the body reads what the shell writes.
	Output,
}

/// Start a zsh process substitution running `text` (zsh source) in a child
/// vproc; the `/dev/fd/N` path the command gets (as `start_procsub`).
/// `=(…)` is [`super::zsh::subst`]'s `getoutputfile`.
pub fn start_zsh_procsub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	text: &[u8],
	kind: ZshProcSub,
) -> Option<BString> {
	// `None`: no vpid is left ([`Stop::ForkFailed`]); nothing is built.
	if k.vpids_left() == 0 {
		return None;
	}
	let output = kind == ZshProcSub::Output;
	let (r, w) = mem::pipe();
	let (r, w) = (FdRef::mem(r), FdRef::mem(w));
	let (mine, theirs, their_fd) = if output { (w, r, 0) } else { (r, w, 1) };
	let fd = (3..64)
		.rev()
		.find(|&fd| vp.fds.get(fd).is_none_or(|h| !h.is_open()))
		.unwrap_or_else(|| vp.fds.lowest_free(64));
	// The other substitutions' fds stay open in the child (zsh `getproc`'s
	// `closem` spares `FDT_PROC_SUBST`): its words may name them.
	let mut fds = vp.fds.clone();
	fds.set(their_fd, Some(theirs));
	let line = line_of(vp, 0);
	let mut child = vp.child_text(k, cx.store, text, line, fds);
	child.outer_loops = fork_loops(vp, true);
	sub_runs_no_debug_trap(vp, &mut child);
	zsh_subshell_traps(k, cx, &mut child, false);
	if !job_control(k, cx, vp) {
		ignore_async_signals(k, cx, &mut child);
	}
	let vpid = child.vpid;
	// Not a job: its externals stay in the shell's group, without the
	// terminal (zsh `ESUB_ASYNC`).
	super::jobctl::set_leader(k, vpid, None);
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	vp.fds.set(fd, Some(mine));
	let depth = vp.frames.len() as u32;
	vp.rare_mut().procsubs.push((depth, fd));
	vp.last_bg = LastBg::new(vpid);
	// zsh's `procsubstpid` (`$sysparams[procsubstpid]`).
	let rec = Record::Misc(BString::from(vpid.0.to_string()));
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Misc(MiscKey::ZshProcsubstPid),
		Some(rec),
	);
	Some(BString::from(format!("/dev/fd/{fd}")))
}

/// `${ ;}` bodies re-parsed while no alias is defined, by the unit and
/// `strs` index of their text, first line, features and mode: without
/// aliases the same text always re-parses to the same unit, so a loop
/// running one substitution parses and compiles it once. Bounded; not
/// imaged.
pub type NoforkUnits = HashMap<(UnitId, u32, u32, Features, ModeId), Arc<Unit>>;

/// Entries [`NoforkUnits`] holds before it starts over.
const NOFORK_UNITS: usize = 256;

/// `${ ;}` text (`strs` entry `at.1` of unit `at.0`) re-parsed as `{ text }`
/// with the current aliases, its first line numbered `line`; `None` keeps
/// the compiled body.
fn nofork_unit(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	at: (UnitId, u32),
	text: &[u8],
	line: u32,
) -> Option<Arc<Unit>> {
	let (feat, aliases) =
		match features(k, cx.store, vp).and_then(|f| Ok((f, builtins::alias_table(k, cx, vp)?))) {
			Ok(v) => v,
			Err(err) => {
				k.fail(err);
				return None;
			},
		};
	let key = (at.0, at.1, line, feat, mode_of(vp));
	if aliases.is_none()
		&& let Some(unit) = k.nofork_units.get(&key)
	{
		return Some(Arc::clone(unit));
	}
	let mut src = Vec::with_capacity(text.len() + 2);
	src.push(b'{');
	// `${| ;}` text starts with its `|`.
	match text.split_first() {
		Some((b'|', rest)) => {
			src.push(b' ');
			src.extend_from_slice(rest);
		},
		_ => src.extend_from_slice(text),
	}
	src.push(b'}');
	let resume = Resume { pos: Pos { offset: 0, line }, ..Resume::default() };
	let cc = match &aliases {
		Some(a) => Parser::new(&src, feat, a)
			.with_resume(&resume)
			.next_command(),
		None => Parser::new(&src, feat, crate::bash::syntax::NO_ALIASES)
			.with_resume(&resume)
			.next_command(),
	}?
	.ok()?;
	let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
	let (unit, _) = k.engine.compile(cc, &src, key.4, feat, observed);
	announce(k, cx, vp.vpid, vp.runs.front(), &unit, line);
	if aliases.is_none() {
		if k.nofork_units.len() >= NOFORK_UNITS {
			k.nofork_units.clear();
		}
		k.nofork_units.insert(key, Arc::clone(&unit));
	}
	Some(unit)
}

/// The last line of the command the top frame runs, when that frame is the
/// shell's script (bash's `line_number` there is where the reader is).
fn top_level_end_line(vp: &Vproc) -> Option<u32> {
	let f = vp.frames.last()?;
	if !matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }) {
		return None;
	}
	let unit = f.unit.as_ref()?;
	// A here-document's body is read after its line: bash's line is not
	// the command's end then.
	let heredoc = unit
		.redirs
		.iter()
		.flatten()
		.any(|r| matches!(r.target, ir::RedirTargetIr::HereDoc { .. }));
	if heredoc {
		return None;
	}
	// Compound commands set the line themselves (`for`, `case`, …).
	let op = unit
		.ops
		.get(f.pc as usize)
		.filter(|op| op.code == Opcode::Exec)?;
	Some((unit.line + end_line(unit, op.node)).saturating_sub(f.line_shift))
}

/// Start the process substitution `<(…)` (`output`: `>(…)`) whose body is
/// at `entry` of `unit`: a child vproc joined to this one by an in-memory
/// pipe on the highest free fd below 64 (bash's `move_to_high_fd`). Returns
/// the word it expands to, `/dev/fd/N`: builtins and redirections reach
/// the pipe through the engine's fd table, externals inherit fd N. The fd
/// closes when the current op's command is over ([`close_procsubs`]).
pub fn start_procsub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	entry: u32,
	output: bool,
) -> Option<BString> {
	// `None`: no vpid is left ([`Stop::ForkFailed`]); nothing is built.
	if k.vpids_left() == 0 {
		return None;
	}
	let (r, w) = mem::pipe();
	let r = FdRef::mem(r);
	let w = FdRef::mem(w);
	let (mine, theirs, their_fd) = if output { (w, r, 0) } else { (r, w, 1) };
	let fd = (3..64)
		.rev()
		.find(|&fd| vp.fds.get(fd).is_none_or(|h| !h.is_open()))
		.unwrap_or_else(|| vp.fds.lowest_free(64));
	// The child gets the parent's fds before `fd` is set: it must not hold
	// the parent's end (a `>( )` reader would never see end of input).
	let mut fds = vp.fds.clone();
	fds.set(their_fd, Some(theirs));
	// Nor the ends of the substitutions before it (`diff <(a) <(b)`): an
	// external in `b` would get them as extra fds, and the host pumps an
	// in-memory pipe it is handed, so it would drain `a`'s output.
	for &(_, sibling) in vp.procsubs() {
		if sibling != their_fd {
			fds.set(sibling, None);
		}
	}
	let mut child = vp.child(k, cx.store, Arc::clone(unit), entry, fds);
	// bash keeps the loop level in a process substitution.
	child.outer_loops = fork_loops(vp, true);
	sub_runs_no_debug_trap(vp, &mut child);
	// bash's `process_substitute` sets `SUBSHELL_COMSUB` too: it reports no
	// job a signal killed ([`super::killed`]). Its process keeps the job
	// list (no `without_job_control`), and drops first the finished jobs a
	// command substitution drops: `cat <(jobs)` lists what `$(jobs)` lists.
	let bash = child.mode.dialect() != Dialect::Zsh;
	if bash {
		child.jobs = inherited_jobs(vp, true);
	}
	child.jobs.comsub = super::proc::Comsub::Own;
	if bash {
		drop_finished_jobs(k, cx, vp, &mut child);
	}
	zsh_subshell_traps(k, cx, &mut child, false);
	// bash's `process_substitute` calls `setup_async_signals` too: without
	// job control it ignores `INT` and `QUIT`.
	if !job_control(k, cx, vp) {
		ignore_async_signals(k, cx, &mut child);
	}
	// bash runs the text with `parse_and_execute` (`process_substitute`): a
	// level of its own unless the fork kept an older one. The fork keeps the
	// shell's `SUBSHELL_RESETTRAP` as it was (subst.c:6433 adds other flags
	// only).
	let level = child.frames[0].flags.parse_level().substitution_base();
	child.frames[0].flags.set_parse_level(level);
	child.own_traps = child
		.own_traps
		.with_reset_pending(vp.own_traps.reset_pending());
	let vpid = child.vpid;
	// Not a job: its externals stay in the shell's group, without the
	// terminal.
	super::jobctl::set_leader(k, vpid, None);
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	vp.fds.set(fd, Some(mine));
	let depth = vp.frames.len() as u32;
	vp.rare_mut().procsubs.push((depth, fd));
	// bash: a process substitution sets `$!` (`wait $!` waits for it).
	vp.last_bg = LastBg::new(vpid);
	Some(BString::from(format!("/dev/fd/{fd}")))
}

/// The op of frame `fi` is over: drop its scratch, close its process
/// substitutions and remove its `=(…)` files.
#[inline]
fn end_op(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, fi: usize) {
	if let Some(sc) = vp.frames.get_mut(fi).and_then(|f| f.scratch.take()) {
		drop_scratch(&mut k.root, cx.store, vp, sc);
	}
	if !vp.procsubs().is_empty() {
		close_procsubs(vp, fi);
	}
	if vp.zsh.as_ref().is_some_and(|z| !z.tempfiles.is_empty()) {
		remove_tempfiles(cx, vp, fi);
	}
}

/// Remove the files of zsh `=(…)` substitutions made by ops of frames
/// above the first `keep` (their commands are over; zsh `deletefilelist`).
/// The removal is not waited for: a failure is ignored, as zsh's.
fn remove_tempfiles(cx: &mut Cx<'_>, vp: &mut Vproc, keep: usize) {
	let Some(z) = vp.zsh.as_mut() else {
		return;
	};
	let fs = cx.host.fs();
	z.tempfiles.retain(|(depth, path)| {
		let over = *depth as usize > keep;
		if over {
			drop(fs.unlink(BStr::new(path)));
		}
		!over
	});
	vp.trim_zsh();
}

/// Close the process-substitution fds opened by ops of frames above the
/// first `keep` (their commands are over).
pub fn close_procsubs(vp: &mut Vproc, keep: usize) {
	let Some(rare) = vp.rare.as_deref_mut() else {
		return;
	};
	let fds = &mut vp.fds;
	rare.procsubs.retain(|&(depth, fd)| {
		let over = depth as usize > keep;
		if over {
			fds.set(fd, None);
		}
		!over
	});
}

/// If a substitution of this op finished, log its output; `Some` while it
/// is still running.
pub fn settle_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	slot: Slot,
) -> Option<Flow> {
	let pending = sc.sub.take()?;
	// A math function another expansion of the op called.
	if let PendingSub::Math { slot: theirs, .. } = pending
		&& theirs != slot
	{
		sc.sub = Some(pending);
		return None;
	}
	let (out, status, value) = match pending {
		PendingSub::Fork { vpid, capture } => {
			let Some(status) = k.proc_collect(cx.store, vpid) else {
				sc.sub = Some(PendingSub::Fork { vpid, capture });
				return Some(Flow::Block(WaitKey::Proc(vpid)));
			};
			// The vproc that read it acts now on an `INT` it held meanwhile:
			// while it read, or once the read was over, as for a job.
			super::end_held_sigint(k, vp, true);
			super::end_held_sigint(k, vp, false);
			// zsh's `readoutput` trims the output itself; `=(…)` keeps it.
			(capture.take(), status, vp.mode.dialect() == Dialect::Zsh)
		},
		// `${| ;}` left its `REPLY` in the capture (`pass_reply`).
		PendingSub::NoFork { capture, value } => (capture.take(), vp.status, value),
		// A zsh hook call: its status is logged, the caller's `$?` is back.
		PendingSub::Here { status } => (Vec::new(), std::mem::replace(&mut vp.status, status), true),
		// A math function's value goes with its status.
		PendingSub::Math { status, .. } => {
			let value = vp.zsh.as_ref().and_then(|z| z.last_math);
			let out = super::zsh::arith::encode_last(value);
			(out, std::mem::replace(&mut vp.status, status), true)
		},
	};
	let mut out = out;
	// zsh keeps NUL bytes (metafied in the word).
	if out.contains(&0) && vp.mode.dialect() != Dialect::Zsh {
		out.retain(|&c| c != 0);
		let line = line_of(vp, 0);
		k.diag(cx, vp, line, Diag::Warning {
			msg: "warning: command substitution: ignored null byte in input".into(),
		});
	}
	// `${| ;}` is `REPLY` as is; the output forms lose trailing newlines.
	while !value && out.last() == Some(&b'\n') {
		out.pop();
	}
	sc.logs[slot as usize].push(Atom::Sub { out: BString::from(out), status });
	None
}

/// Whether the last event clock reading stays current across `code`
/// (`Kernel::clock`): control flow, loop bookkeeping and a unit's `End`
/// (popping its frame and scope) take no time worth a reading; `Exec` and a
/// compound's `Enter`/`Leave` read or invalidate it themselves. Every other
/// op (expansions, tests, redirections, spawns) invalidates it.
const fn keeps_clock(code: Opcode) -> bool {
	matches!(
		code,
		Opcode::Nop
			| Opcode::Exec
			| Opcode::Jmp
			| Opcode::BrOk
			| Opcode::BrFail
			| Opcode::Not
			| Opcode::SetStatus
			| Opcode::Enter
			| Opcode::Leave
			| Opcode::LoopEnter
			| Opcode::LoopNote
			| Opcode::LoopBack
			| Opcode::LoopExit
			| Opcode::End
	)
}

/// The flow of an op [`run_slice`] runs without its bookkeeping: a jump,
/// an unreported branch, a loop's entry, iteration note or exit, the
/// entry of a compound command (unless a DEBUG trap may run there) and its
/// successful leave; `None` for any other op, or one whose event is on.
#[inline]
fn control_flow(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	unit: &Arc<Unit>,
	op: Op,
) -> Option<Flow> {
	match op.code {
		Opcode::Nop => Some(Flow::Next),
		Opcode::Jmp => Some(Flow::Jump(op.a)),
		Opcode::BrOk | Opcode::BrFail if !k.mask.any_op(op.ev) => {
			reap_after_arith_test(vp, unit, op);
			Some(branch(op, (vp.status == 0) == (op.code == Opcode::BrOk)))
		},
		Opcode::LoopNote | Opcode::LoopBack => Some(loop_note(vp, op)),
		Opcode::LoopEnter => Some(loop_enter(vp, op)),
		Opcode::LoopExit if !k.mask.any_op(op.ev) => {
			if let Some(rec) = top_frame(vp).loops.pop() {
				vp.status = rec.status;
			}
			Some(Flow::Next)
		},
		Opcode::Enter if !k.mask.any_op(op.ev) => {
			// `[[ ]]` and `(( ))` start a command: `BASH_COMMAND` and the
			// DEBUG trap point.
			let starts = starts_command(unit, op);
			if starts && pseudo_trap_maybe(k, cx, TrapKey::Debug) {
				return None;
			}
			if starts {
				note_command(vp, unit, op);
			}
			let f = top_frame(vp);
			if starts {
				f.err_reported = false;
			}
			f.enters.push((op.node, 0));
			Some(Flow::Next)
		},
		// A failed one may be an errexit or ERR-trap point.
		Opcode::Leave if !k.mask.any_op(op.ev) && vp.status == 0 => {
			top_frame(vp).enters.pop();
			Some(Flow::Next)
		},
		_ => None,
	}
}

/// `LoopEnter`: a `while`/`until` loop's record.
fn loop_enter(vp: &mut Vproc, op: Op) -> Flow {
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::While,
		status: 0,
		iterations: 0,
		exit: op.a,
		cont: op.b,
		depth,
	});
	Flow::Next
}

/// `((…))` (or an arith-`for` expression) of a bash unit with nothing to
/// expand ([`Op::LITERAL`]) or trace, evaluated in place
/// ([`expand::arith_command`]) with the errors mapped as
/// [`Expander::arith_eval`] and [`dispatch`] map them; `None` for any other
/// text, which [`dispatch`] runs through an expander.
fn plain_arith(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	op: Op,
) -> Option<Flow> {
	if op.b != Op::LITERAL || super::xtrace::on(k, cx, vp) {
		return None;
	}
	// bash's `this_command_name` ([`Vproc::command_name`]).
	vp.command_name = Some(CommandName::Arith);
	let text = &unit.ariths[op.a as usize];
	Some(match expand::arith_command(k, cx, vp, text) {
		Ok(v) => {
			clear_scratch(&mut k.root, cx.store, vp);
			vp.status = i32::from(v == 0);
			Flow::Next
		},
		Err(d @ (Diag::Arith { .. } | Diag::Readonly { .. })) => {
			clear_scratch(&mut k.root, cx.store, vp);
			let d = if matches!(d, Diag::Arith { .. }) {
				d.by("((")
			} else {
				d
			};
			let line = line_of(vp, op.node);
			// Under `set -e` bash's `report_error` exits the shell itself.
			if report_error_exits(k, cx, vp, &d) {
				let status = report_error_status(vp, &d);
				k.diag(cx, vp, line, d);
				return Some(Flow::Exit(status, Jump::Direct));
			}
			k.diag(cx, vp, line, d);
			vp.status = 1;
			// `((…))` continues; an arith-for header error leaves the loop.
			if unit
				.nodes
				.get(op.node as usize)
				.is_some_and(|n| n.kind == NodeKind::ArithFor)
			{
				arith_for_failed(vp, unit, op)
			} else {
				Flow::Next
			}
		},
		Err(d @ Diag::Unbound { .. }) => {
			let line = line_of(vp, op.node);
			stop_flow(k, vp, cx, line, Stop::Fatal(d))
		},
		Err(d) => {
			let line = line_of(vp, op.node);
			stop_flow(k, vp, cx, line, Stop::Fail(d))
		},
	})
}

/// The flow after an arith-`for` header expression failed (its message
/// shown, `$?` 1): bash's `execute_arith_for_command` leaves the loop with
/// status 1, and the commands after it run. A failed first expression ends
/// it before its record is pushed; a failed test or step drops the record.
/// A `break` or `continue` that waits for a loop
/// ([`Vproc::pending_break`], from the loop's own redirection or the
/// test's substitution) loses one level to the loop at a failed test, as
/// bash's loop checks `breaking` and `continuing` after the test; the
/// levels left go on to the loops around it. It is no ERR trap point
/// (the loop's status is no failed command's).
fn arith_for_failed(vp: &mut Vproc, unit: &Unit, op: Op) -> Flow {
	let frame = top_frame(vp);
	frame.err_reported = true;
	let pc = frame.pc;
	let next = unit
		.ops
		.get(pc as usize + 1)
		.copied()
		.filter(|n| n.node == op.node);
	if let Some(enter) = next.filter(|n| n.code == Opcode::LoopEnter) {
		// The first expression: `LoopEnter`'s target is the loop's
		// `LoopExit`, which would pop a record this loop has not pushed.
		return Flow::Jump(enter.a + 1);
	}
	let Some(rec) = top_frame(vp).loops.pop() else {
		// Every test and step runs with the loop's record pushed.
		return Flow::Next;
	};
	let test = next.is_some_and(|n| n.code == Opcode::BrFail);
	let depth = vp.frames.len();
	if test
		&& vp
			.pending_break
			.as_deref()
			.is_some_and(|p| p.depth as usize == depth)
	{
		let left = vp
			.pending_break
			.as_deref()
			.map_or(0, |p| p.levels.saturating_sub(1));
		match vp.pending_break.as_deref_mut() {
			Some(p) if left > 0 => p.levels = left,
			_ => vp.pending_break = None,
		}
	}
	Flow::Jump(rec.exit + 1)
}

/// Whether `op` (an `Enter`/`Leave`) brackets a zsh `[[ ]]` traced by
/// `set -x`.
fn zsh_cond_traced(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, unit: &Unit, op: Op) -> bool {
	unit.mode.dialect() == Dialect::Zsh
		&& unit
			.nodes
			.get(op.node as usize)
			.is_some_and(|n| n.kind == NodeKind::Cond)
		&& super::xtrace::on(k, cx, vp)
}

/// A branch op's flow: to its target when `jump`.
const fn branch(op: Op, jump: bool) -> Flow {
	if jump { Flow::Jump(op.a) } else { Flow::Next }
}

/// `LoopNote`/`LoopBack`: the innermost loop's status and iteration count;
/// `LoopBack` jumps back to the loop's test, after bash's `REAP` (the body
/// of a `for`, `select`, `while` or `until` loop ended: the finished jobs
/// reported go, `execute_cmd.c:3105`, `3606`, `3838`).
fn loop_note(vp: &mut Vproc, op: Op) -> Flow {
	let status = vp.status;
	if let Some(rec) = top_frame(vp).loops.last_mut() {
		rec.status = status;
		rec.iterations += 1;
	}
	if op.code == Opcode::LoopBack {
		super::killed::cleanup_dead_jobs(vp);
		Flow::Jump(op.a)
	} else {
		Flow::Next
	}
}

/// bash's `REAP` once an arithmetic `for` loop evaluated its test
/// (`execute_cmd.c:3267`), the `BrFail` after it: the finished jobs reported
/// go.
fn reap_after_arith_test(vp: &mut Vproc, unit: &Unit, op: Op) {
	if op.code == Opcode::BrFail
		&& !vp.jobs.list.is_empty()
		&& unit
			.nodes
			.get(op.node as usize)
			.is_some_and(|n| n.kind == NodeKind::ArithFor)
	{
		super::killed::cleanup_dead_jobs(vp);
	}
}

/// Execute one op.
fn dispatch(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Arc<Unit>, op: Op) -> Flow {
	let line = line_of(vp, op.node);
	match op.code {
		Opcode::Nop => Flow::Next,
		Opcode::Exec => command::exec(k, vp, cx, unit, op, line),
		Opcode::Jmp => Flow::Jump(op.a),
		Opcode::BrOk | Opcode::BrFail => {
			let status = vp.status;
			let jump = (status == 0) == (op.code == Opcode::BrOk);
			if k.mask.any_op(op.ev) {
				let data =
					EventData::Branch { construct: Construct::from_u32(op.b), taken: !jump, status };
				k.emit_op(cx, vp, op.node, data);
			}
			reap_after_arith_test(vp, unit, op);
			branch(op, jump)
		},
		Opcode::Not => {
			// zsh `evalcond` `COND_NOT`: a `[[ ]]` status 3 (an unknown
			// `-o` option) is not inverted. (Status 2 never gets here: it
			// abandons the command at the primary.)
			vp.status = if vp.status == 3
				&& unit.mode.dialect() == Dialect::Zsh
				&& unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| n.kind == NodeKind::Cond)
			{
				3
			} else {
				i32::from(vp.status == 0)
			};
			Flow::Next
		},
		Opcode::SetStatus => {
			vp.status = op.a as i32;
			Flow::Next
		},
		Opcode::Enter => {
			let on = k.mask.any_op(op.ev);
			// The clock only with events on: the `CmdStart` stamp (shared
			// with the previous event when only control flow ran since,
			// `Kernel::stamp`) starts the `CmdEnd` duration.
			let start = if on { k.stamp(cx) } else { 0 };
			top_frame(vp).enters.push((op.node, start));
			if on && let Some(node_kind) = unit.nodes.get(op.node as usize).map(|n| n.kind) {
				k.emit_op_at(cx, vp, op.node, EventData::CmdStart { node_kind }, start);
			}
			// zsh `execcond`: a traced `[[ ]]` is one line, its primaries
			// added as they are evaluated (`zsh::cond`).
			if zsh_cond_traced(k, vp, cx, unit, op) {
				let mut bytes = super::xtrace::ps4(k, cx, vp, line);
				bytes.extend_from_slice(b"[[");
				super::xtrace::write(k, cx, vp, bytes);
			}
			Flow::Next
		},
		Opcode::Leave => {
			if zsh_cond_traced(k, vp, cx, unit, op) {
				super::xtrace::write(k, cx, vp, b" ]]\n".to_vec());
			}
			let t0 = top_frame(vp).enters.pop().map_or(0, |(_, t)| t);
			if k.mask.any_op(op.ev) {
				// One fresh reading for the duration and the event's stamp;
				// what follows may share it.
				let end = k.read_clock(cx);
				let dur_ns = if t0 > 0 { end.saturating_sub(t0) } else { 0 };
				let status = vp.status;
				// Only a pipeline's `CmdEnd` carries `PIPESTATUS` (events golden).
				let pipeline = unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| n.kind == NodeKind::Pipeline);
				let pipestatus: &[i32] = if pipeline { &vp.pipestatus } else { &[] };
				let data = EventData::CmdEnd { status, dur_ns, pipestatus };
				k.emit_op_at(cx, vp, op.node, data, end);
			}
			Flow::Next
		},
		Opcode::LoopEnter => loop_enter(vp, op),
		// bash's `this_command_name` ([`Vproc::command_name`]) is cleared
		// when `select` starts and before each `for` item is assigned.
		Opcode::ForIn => {
			if op.flags & Op::SELECT != 0 {
				vp.command_name = None;
			}
			for_in(k, vp, cx, unit, op, line)
		},
		Opcode::ForNext => {
			if top_frame(vp).loops.last().is_some_and(
				|r| matches!(&r.kind, LoopKind::For { items, next, .. } if (*next as usize) < items.len()),
			) {
				vp.command_name = None;
			}
			for_next(k, vp, cx, op, line)
		},
		Opcode::LoopNote | Opcode::LoopBack => loop_note(vp, op),
		Opcode::LoopExit => {
			if let Some(rec) = top_frame(vp).loops.pop() {
				vp.status = rec.status;
				if k.mask.any_op(op.ev) {
					k.emit_op(cx, vp, op.node, EventData::LoopEnd { iterations: rec.iterations });
				}
			}
			Flow::Next
		},
		Opcode::Redir => {
			// The shell's output to its terminal goes first: its job notices
			// still going out and the editor's display bytes, as zsh's
			// blocking writes ordered them ([`flush_out`]; `vp.out` is empty
			// when an op starts, [`run_slice`]). Waited for on every entry,
			// before the list goes on: on the first, before any redirection
			// is applied, and after the op parked mid-way (on a substitution
			// in a target), for a notice queued meanwhile. No redirection
			// moves the terminal, so a failed redirection's message comes
			// after them and goes to the fd 2 the redirections left.
			if let Some(fd) = flush_out(k, vp) {
				return Flow::Block(WaitKey::Write { fd });
			}
			let pc = top_frame(vp).pc;
			// The own redirections of the command a fork was made for, and of
			// a `( … )`, are made in the fork without undo; a compound command's
			// in the shell are undone after it.
			let forked = vp.frames.len() == 1 && vp.fork().at_entry();
			if forked && vp.fork().ending() {
				// Its own redirections ended the fork, which waited for their
				// message (`run_slice` writes what is left before the op comes
				// back): it exits now, and they are not made again. bash made
				// them before it timed the command (`execute_in_subshell`), so
				// no `time` of the fork reports ([`Jump::Direct`]).
				return Flow::Exit(vp.status, Jump::Direct);
			}
			let subshell = matches!(
				unit.ops.get(pc as usize + 1..pc as usize + 3),
				Some([enter, spawn])
					if enter.code == Opcode::Enter
						&& spawn.code == Opcode::Spawn
						&& unit.spawns.get(spawn.a as usize).is_some_and(|s| s.kind == SpawnKind::Subshell)
			);
			// A bash `( … )`'s own `{var}`s are its fork's: the shell keeps
			// none (zsh code keeps its own rule).
			let fork = subshell && !forked && unit.mode.dialect() != Dialect::Zsh;
			let owner = redir::Owner::Compound { undo: !forked && !subshell, fork };
			let line = compound_line(vp, line);
			// A `( … )`'s own redirections made before its fork are the
			// child's in bash: a `$RANDOM` they expand draws from a copy of
			// the generator ([`redir::apply_in_child`]).
			let res = if subshell && !forked {
				redir::apply_in_child(k, vp, cx, unit, op.a, line, owner)
			} else {
				redir::apply(k, vp, cx, unit, op.a, line, owner)
			};
			if forked && !matches!(res, Err(redir::Halt::Flow(_))) {
				// Past the fork's own redirections, its body runs under bash's
				// `execute_in_subshell`, which catches its fatal errors.
				vp.set_fork(super::proc::Fork::CHILD);
			}
			match res {
				Ok(()) => {
					let saves = match top_frame(vp).scratch.take() {
						Some(mut sc) => {
							// The `{var}`s go with the saved fds to the `Spawn`.
							let saves = sc.io.as_mut().map_or_default(|io| Saves {
								fds:  std::mem::take(&mut io.saved),
								vars: io.var_fds.take(),
							});
							drop_scratch(&mut k.root, cx.store, vp, sc);
							saves
						},
						None => Saves::default(),
					};
					top_frame(vp).redirs.push(saves);
					Flow::Next
				},
				// A fatal expansion error in a `( … )`'s own redirections ends
				// its fork, which bash makes them in before the subshell's
				// catcher (`execute_in_subshell`): the subshell fails with the
				// status the fork exits with (127 from a `-c` string, else 1)
				// and the shell goes on, with none of its `{var}`s. (zsh code
				// keeps its own rule.)
				Err(redir::Halt::Flow(Flow::Exit(code, _) | Flow::Discard(code))) if fork => {
					redir::forget_var_fds(k, vp, cx);
					// The message goes to stderr as the redirections so far
					// left it (`2>/dev/null < ${x:?}` prints none), after a
					// queued notice, as in the failure path below.
					super::jobctl::drain_shout(k);
					let _ = flush_queued(k, vp);
					clear_scratch(&mut k.root, cx.store, vp);
					vp.status = code;
					// The fork is the pipeline bash waited for: `PIPESTATUS`
					// holds its status, not inverted under `!` (a fatal error
					// ends the fork before `execute_in_subshell`'s inversion).
					vp.pipestatus.clear();
					vp.pipestatus.push(code);
					Flow::Jump(op.b)
				},
				// In the job's own fork (an async compound command or pipeline
				// stage: `forked_for`) the fork is the command's: a fatal error
				// in the command's own redirections ends it with its status (127
				// or 1), an arithmetic error or a bad substitution with 1, and
				// nothing after the command runs (a `!` included). The fork ends
				// after its message is written to stderr as the redirections so
				// far left it (`2>/dev/null < ${x:?}` prints none), waiting for a
				// stream that is full. (zsh code keeps its own rule.)
				Err(redir::Halt::Flow(Flow::Exit(code, _) | Flow::Discard(code)))
					if forked && unit.mode.dialect() == Dialect::Bash =>
				{
					vp.status = code;
					vp.set_fork(vp.fork().end());
					match flush_out(k, vp) {
						Some(fd) => Flow::Block(WaitKey::Write { fd }),
						None => Flow::Exit(code, Jump::Direct),
					}
				},
				Err(redir::Halt::Flow(f)) => f,
				Err(redir::Halt::Failed) => {
					// A `( … )`'s own redirections are its fork's: the shell
					// keeps none of their `{var}`s.
					if fork {
						redir::forget_var_fds(k, vp, cx);
					}
					// The message goes to stderr as the redirections so far left
					// it; what would block is written after the restore. No notice
					// can be pending here: the wait on entry returned with the
					// notices out, and `redir::apply` queues none. The hand-off
					// ([`jobctl::drain_shout`]) and the write without the notice
					// gate ([`flush_queued`]) are kept for a notice a later change
					// queues in between: it goes to the terminal first, and the
					// message still goes to the fd 2 the redirections left, since
					// the restore follows in this step.
					super::jobctl::drain_shout(k);
					let _ = flush_queued(k, vp);
					clear_scratch(&mut k.root, cx.store, vp);
					// A negated bash compound whose own redirections fail ends
					// with 1: bash returns the failure before the command's `!`
					// applies (`execute_command_internal`), and a `( … )`'s fork
					// exits with it inverted, which the shell inverts back
					// (`exit (invert ? …)`, execute_cmd.c:1762). The `Not` just past
					// the compound inverts the 0 set here.
					let negated = unit.mode.dialect() == Dialect::Bash
						&& unit
							.ops
							.get(op.b as usize)
							.is_some_and(|o| o.code == Opcode::Not);
					vp.status = i32::from(!negated);
					// The `( … )`'s fork is the pipeline bash waited for:
					// `PIPESTATUS` holds its exit status. A compound command's own
					// redirections fail in the shell, which sets none.
					if fork {
						vp.pipestatus.clear();
						vp.pipestatus.push(vp.status);
					}
					Flow::Jump(op.b)
				},
			}
		},
		Opcode::PopRedir => {
			if let Some(saves) = top_frame(vp).redirs.pop() {
				restore(vp, saves.fds);
			}
			// A subshell's notice waited for its redirections to go.
			let depth = u32::try_from(vp.frames.len()).unwrap_or(u32::MAX);
			super::killed::redirections_undone(k, vp, depth);
			Flow::Next
		},
		Opcode::Spawn => spawn(k, vp, cx, unit, op),
		Opcode::SubExit => {
			if matches!(
				top_frame(vp).kind,
				FrameKind::NoFork | FrameKind::Stage | FrameKind::Cat { .. }
			) {
				pop_frame(&mut k.root, cx.store, vp);
			} else {
				// A subshell, pipeline stage or job ends: its EXIT trap runs.
				let kept = kept_level(vp);
				unwind(&mut k.root, cx.store, vp, 0);
				exit_trap_keeps_level(k, vp, cx, kept);
			}
			Flow::Call
		},
		Opcode::CaseWord => {
			let w = &unit.words[op.a as usize];
			let subject =
				match expanding(k, vp, cx, Slot::Words, w.parks, line, |ex| ex.scalar(unit, w)) {
					Ok(s) => s,
					Err(flow) => return flow,
				};
			clear_scratch(&mut k.root, cx.store, vp);
			if super::xtrace::on(k, cx, vp) {
				let mut body = b"case ".to_vec();
				body.extend_from_slice(word_source(unit, op.a));
				body.extend_from_slice(b" in");
				super::xtrace::emit(k, cx, vp, line, &body);
			}
			// `$?` stays the previous command's until an arm decides it.
			top_frame(vp).cases.push((subject, false));
			Flow::Next
		},
		Opcode::CaseArm => case_arm(k, vp, cx, unit, op, line),
		Opcode::CaseEnd => {
			top_frame(vp).cases.pop();
			Flow::Next
		},
		Opcode::Arith if unit.mode.dialect() == Dialect::Zsh => zsh_arith(k, vp, cx, unit, op, line),
		Opcode::Arith => {
			vp.command_name = Some(CommandName::Arith);
			let text = &unit.ariths[op.a as usize];
			let arith_for = unit
				.nodes
				.get(op.node as usize)
				.is_some_and(|n| n.kind == NodeKind::ArithFor);
			// One inlined pass (each `<[u8]>::contains` is a call).
			let record = text.iter().any(|&c| c == b'$' || c == b'`');
			let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
				// Warnings carry the command's name.
				ex.arith_cmd = Some("((");
				let expanded = ex.expand_text(text)?;
				// bash traces the expanded text before evaluating it (a
				// replay after a parked substitution gets here once).
				if super::xtrace::on(ex.k, ex.cx, ex.vp) {
					trace_arith(ex.k, ex.cx, ex.vp, line, &expanded, arith_for);
				}
				match ex.arith_eval(&expanded) {
					Ok(v) => Ok(Ok(v)),
					// An error in a subscript abandons the line (an expansion
					// failure).
					Err(Stop::Fail(d @ (Diag::Arith { .. } | Diag::Readonly { .. }))) => Ok(Err(d)),
					Err(stop) => Err(stop),
				}
			});
			match res {
				Ok(Ok(v)) => {
					clear_scratch(&mut k.root, cx.store, vp);
					vp.status = i32::from(v == 0);
					Flow::Next
				},
				Ok(Err(d)) => {
					clear_scratch(&mut k.root, cx.store, vp);
					let d = if matches!(d, Diag::Arith { .. }) {
						d.by("((")
					} else {
						d
					};
					// Under `set -e` bash's `report_error` exits the shell
					// itself.
					if report_error_exits(k, cx, vp, &d) {
						let status = report_error_status(vp, &d);
						k.diag(cx, vp, line, d);
						return Flow::Exit(status, Jump::Direct);
					}
					k.diag(cx, vp, line, d);
					vp.status = 1;
					// `((…))` continues; an arith-for header error leaves the
					// loop.
					if arith_for {
						arith_for_failed(vp, unit, op)
					} else {
						Flow::Next
					}
				},
				Err(flow) => flow,
			}
		},
		Opcode::CondTest if unit.mode.dialect() == Dialect::Zsh => {
			super::zsh::cond::cond_test(k, vp, cx, unit, op, line)
		},
		Opcode::CondTest => {
			vp.command_name = Some(CommandName::Cond);
			builtins::cond_test(k, vp, cx, unit, op, line)
		},
		Opcode::FuncDef => {
			let f = &unit.funcs[op.a as usize];
			// bash records a definition's line at its end.
			let end = (unit.line + end_line(unit, op.node)).saturating_sub(top_frame(vp).line_shift);
			let line = compound_line(vp, end);
			if op.b != 0 {
				return zsh_funcdef_expanded(k, vp, cx, unit, op, line);
			}
			if special_name(k, vp, cx, &f.name) {
				// POSIX interpretation 383: fatal in a non-interactive shell.
				let msg = format!("`{}': is a special builtin", f.name).into();
				k.diag(cx, vp, line, Diag::Usage { msg });
				return Flow::Exit(2, Jump::Other);
			}
			// zsh: defining `TRAPNAL` sets the trap (`localtraps` saves the
			// old one).
			if unit.mode.dialect() == Dialect::Zsh {
				zsh_trap_funcdef(k, cx, vp, &f.name);
				// zsh `execfuncdef`: a definition empties `$_`.
				state::store_record(&mut k.root, cx.store, vp, KeyBuf::Misc(MiscKey::LastArg), None);
			}
			builtins::define_function(k, vp, cx, f, line, op.flags & Op::TRACED != 0)
		},
		Opcode::TimeStart => {
			let reset_traps = vp.own_traps.reset_pending();
			let mark = super::proc::TimeMark { reset_traps, ..time_mark(&*cx.host) };
			top_frame(vp).times.push(mark);
			Flow::Next
		},
		Opcode::TimeEnd => {
			let start = top_frame(vp).times.pop().unwrap_or_default();
			time_end(k, vp, cx, unit, op, start, line);
			Flow::Next
		},
		Opcode::Warn => {
			let msg = unit.strs.get(op.a as usize).cloned().unwrap_or_default();
			let diag = if op.flags & Op::SYNTAX != 0 {
				Diag::Syntax { msg }
			} else {
				Diag::Warning { msg }
			};
			let in_eval = matches!(
				vp.frames.last().map(|f| &f.kind),
				Some(FrameKind::Script { what: ScriptKind::Eval, .. })
			);
			let wrap = |d: Diag| {
				if in_eval && op.flags & Op::SYNTAX != 0 {
					Diag::Eval { diag: Box::new(d) }
				} else {
					d
				}
			};
			k.diag(cx, vp, op.b, wrap(diag));
			if op.flags & Op::CONTEXT != 0 {
				// A recovered syntax error: the offending line follows.
				let text = unit
					.strs
					.get(op.a as usize + 1)
					.cloned()
					.unwrap_or_default();
				k.diag(cx, vp, op.b, wrap(Diag::SyntaxContext { text }));
			}
			Flow::Next
		},
		Opcode::Abort => {
			let msg = unit.strs.get(op.a as usize).cloned().unwrap_or_default();
			let diag = if op.flags & Op::SYNTAX != 0 {
				Diag::Syntax { msg }
			} else {
				Diag::Unsupported { what: String::from_utf8_lossy(&msg).into_owned().into() }
			};
			let in_eval = matches!(
				vp.frames.last().map(|f| &f.kind),
				Some(FrameKind::Script { what: ScriptKind::Eval, .. })
			);
			let wrap = |d: Diag| {
				if in_eval {
					Diag::Eval { diag: Box::new(d) }
				} else {
					d
				}
			};
			k.diag(cx, vp, op.node, wrap(diag));
			if op.flags & Op::CONTEXT != 0 {
				let text = unit
					.strs
					.get(op.a as usize + 1)
					.cloned()
					.unwrap_or_default();
				k.diag(cx, vp, op.node, wrap(Diag::SyntaxContext { text }));
			}
			Flow::Abort(op.b as i32)
		},
		Opcode::End => Flow::EndUnit,
		Opcode::Repeat => repeat(k, vp, cx, unit, op, line),
		Opcode::TryEnter => try_enter(vp, op),
		Opcode::AlwaysEnter => always_enter(vp),
		Opcode::AlwaysEnd => always_end(vp),
		Opcode::CallAnon => command::call_anon(k, vp, cx, unit, op, line),
	}
}

/// zsh `execfuncdef` of a definition whose names expand (`function f$$ {
/// … }`, word list `op.b - 1`): the names are expanded (globbed), then
/// each gets the body, its text naming it. An expansion error abandons the
/// definition. Out of line: zsh only.
#[inline(never)]
fn zsh_funcdef_expanded(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let words = &unit.lists[op.b as usize - 1];
	let record = words.iter().any(|&w| unit.words[w as usize].parks);
	let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut out = Vec::new();
		let mut globs = Vec::new();
		for &w in words {
			ex.fields_glob(unit, &unit.words[w as usize], &mut out, &mut globs)?;
		}
		Ok((out, globs))
	});
	let (mut names, globs) = match res {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	if !globs.is_empty()
		&& let Err(flow) = super::zsh::zglob::expand_globs(k, vp, cx, &mut names, &globs, line)
	{
		return flow;
	}
	clear_scratch(&mut k.root, cx.store, vp);
	let f = &unit.funcs[op.a as usize];
	vp.status = 0;
	// zsh `execfuncdef`: a definition empties `$_`.
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Misc(MiscKey::LastArg), None);
	for name in names {
		let one = ir::FuncIr { name, definition: f.definition.clone(), body: f.body.clone() };
		zsh_trap_funcdef(k, cx, vp, &one.name);
		let flow = builtins::define_function(k, vp, cx, &one, line, op.flags & Op::TRACED != 0);
		if !matches!(flow, Flow::Next) {
			return flow;
		}
	}
	Flow::Next
}

/// zsh: defining function `name` (`TRAPNAL`) sets that trap.
#[inline(never)]
fn zsh_trap_funcdef(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, name: &[u8]) {
	let defined = builtins::trap::FuncChange::Defined;
	if let Err(err) = builtins::trap::func_changing(k, cx, vp, name, defined) {
		k.fail(err);
	}
}

/// In posix mode: `name` is a special builtin.
fn special_name(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, name: &[u8]) -> bool {
	if !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
		return false;
	}
	let rctx = ResolveCtx { has_slash: false, via: Via::Plain };
	matches!(
		cx.host.resolve(BStr::new(name), mode_of(vp), rctx),
		Resolved::Intrinsic(id) if command::is_special(id)
	)
}

/// bash's `time -p` format.
const POSIX_TIMEFORMAT: &[u8] = b"real %2R\nuser %2U\nsys %2S";
/// bash's default `TIMEFORMAT`.
const BASH_TIMEFORMAT: &[u8] = b"\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS";

/// The clock and CPU times now (a host without CPU times counts none).
fn time_mark(host: &dyn crate::bash::host::Host) -> super::proc::TimeMark {
	let cpu = host.cpu_times().unwrap_or_default();
	super::proc::TimeMark {
		real:        host.now_ns(),
		user:        cpu.user_ns.saturating_add(cpu.child_user_ns),
		sys:         cpu.sys_ns.saturating_add(cpu.child_sys_ns),
		reset_traps: false,
	}
}

/// A `time`d pipeline ended (bash's `time_command`): report the times
/// since `start` on stderr in `TIMEFORMAT` (`time -p`: the POSIX format;
/// unset: bash's default; empty: nothing). In posix mode `time` without a
/// pipeline reports the shell's times since it started.
fn time_end(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	op: Op,
	start: super::proc::TimeMark,
	line: u32,
) {
	let end = time_mark(&*cx.host);
	let pc = vp.frames.last().map_or(0, |f| f.pc as usize);
	let null = time_null(unit, pc, op.node);
	if vp.mode.dialect() == Dialect::Zsh {
		let desc = (!null).then(|| node_text(unit, op.node));
		zsh_time_end(k, vp, cx, desc.as_deref().map(Vec::as_slice), start, end);
		return;
	}
	let posix = null && state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let start = if posix {
		super::proc::TimeMark { real: k.start_of(vp), ..Default::default() }
	} else {
		start
	};
	bash_time_report(k, vp, cx, op.b == 1, posix, elapsed(start, end), line);
}

/// The real, user and system times from `start` to `end`.
const fn elapsed(start: super::proc::TimeMark, end: super::proc::TimeMark) -> [u64; 3] {
	[
		end.real.saturating_sub(start.real),
		end.user.saturating_sub(start.user),
		end.sys.saturating_sub(start.sys),
	]
}

/// bash's report of a `time`d pipeline's `times` on stderr: `time -p`
/// (`dash_p`) in the POSIX format, else in `TIMEFORMAT` (unset: bash's
/// default, or in posix mode for `time` without a pipeline (`null_posix`)
/// the user and system times only; empty: nothing).
fn bash_time_report(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	dash_p: bool,
	null_posix: bool,
	times: [u64; 3],
	line: u32,
) {
	let format = if dash_p {
		BString::from(POSIX_TIMEFORMAT)
	} else {
		match state::lookup(&k.root, cx.store, vp, b"TIMEFORMAT") {
			Ok(Some(v)) => BString::from(v.as_scalar().unwrap_or_default()),
			Ok(None) if null_posix => BString::from("user\t%2lU\nsys\t%2lS"),
			Ok(None) => BString::from(BASH_TIMEFORMAT),
			Err(err) => {
				k.fail(err);
				return;
			},
		}
	};
	if format.is_empty() {
		return;
	}
	match time_report(&format, times) {
		Ok(text) => vp.out.push_back(PendingWrite::new(2, text.into())),
		Err(c) => {
			let msg = format!("TIMEFORMAT: `{}': invalid format character", char::from(c));
			k.diag(cx, vp, line, Diag::Usage { msg: msg.into() });
		},
	}
}

/// A jump out of the commands that run, as bash's `parse_and_execute` (an
/// `eval`, `.` or trap action) catches and passes it on: it decides whether
/// that level undoes its commands' redirections first ([`kept_redirections`])
/// and which `time`s report ([`report_jump`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Jump {
	/// The `exit` (or `logout`) builtin: bash's `EXITBLTIN`.
	Exit,
	/// `set -e`'s exit, also after the ERR trap, and a posix shell's exit
	/// on a special builtin's error (`execute_cmd.c`, lines 1005 and 4872):
	/// bash's `ERREXIT`.
	Errexit,
	/// A jump after bash's `top_level_cleanup` ([`jump_out`]): `break` or
	/// `continue` with a count that is not a number (`get_numeric_arg`), a
	/// fatal arithmetic subscript error, and a fatal expansion or assignment
	/// error outside every `parse_and_execute` (`exp_jump_to_top_level`):
	/// [`top_level_jump`].
	Cleanup,
	/// Any other: a fatal error and a discarded command (`FORCE_EOF`,
	/// `EXITPROG`, `DISCARD`).
	Other,
	/// No jump: under `set -e` bash's `report_error` calls `exit_shell`
	/// itself ([`report_error_exits`]), as a failed `exec` does, and a
	/// `SIGPIPE` ends the shell; no `time` reports.
	Direct,
}

/// bash's `time_command` catches a jump out of the timed command (`exit`,
/// `set -e`, a fatal expansion error, a discarded command): it reports the
/// times, then jumps on (`break` and `continue` are no jumps:
/// [`end_left_commands`]). `return` passes it (bash's `return_catch`),
/// `exec` replaces the shell, and a jump after `top_level_cleanup` drops
/// the marks started inside a `parse_and_execute` unreported
/// ([`jump_out`]). Report, innermost first, the `time` marks of frames
/// `frame` and up, and drop them; a mark started in a fork that has run
/// `trap` since goes unreported
/// ([`OwnTraps::reset_pending`](super::proc::OwnTraps::reset_pending)). A jump
/// that passes an `eval`, `.` or trap action (a `parse_and_execute`, which
/// undoes its commands' redirections as it passes the jump on, except
/// those [`kept_redirections`] leaves) reports the marks below it through
/// the redirections in effect outside it.
fn report_left_times(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, frame: usize, jump: Jump) {
	if vp.frames.iter().skip(frame).all(|f| f.times.is_empty()) {
		return;
	}
	// Each frame's marks with their `-p` flags, innermost first, less those
	// bash's `time_command` jumps on from without a report: it skips the
	// report when `subshell_environment` changed under it
	// (execute_cmd.c:1499), which in a fork is a `trap` call clearing
	// `SUBSHELL_RESETTRAP` (trap.def:208).
	let reset = vp.own_traps.reset_pending();
	let mut left: Vec<Vec<(super::proc::TimeMark, bool)>> = vp.frames[frame..]
		.iter_mut()
		.map(|f| {
			let ends = pending_time_ends(f, f.times.len());
			f.times
				.drain(..)
				.rev()
				.zip(ends)
				.filter(|(start, _)| reset || !start.reset_traps)
				.collect()
		})
		.collect();
	if left.iter().all(Vec::is_empty) {
		return;
	}
	let kept = kept_redirections(k, vp, cx, frame, jump);
	let end = time_mark(&*cx.host);
	let line = vp
		.frames
		.last()
		.and_then(|f| f.unit.as_deref().and_then(|u| u.ops.get(f.pc as usize)))
		.map_or(0, |op| line_of(vp, op.node));
	for i in (frame..vp.frames.len()).rev() {
		for (start, dash_p) in std::mem::take(&mut left[i - frame]) {
			bash_time_report(k, vp, cx, dash_p, false, elapsed(start, end), line);
		}
		if i > frame
			&& i < kept
			&& parse_and_execute(&vp.frames[i])
			&& left[..i - frame].iter().any(|l| !l.is_empty())
		{
			undo_redirections(k, vp, i, kept);
		}
	}
}

/// The first frame whose redirections a jump out of frames `frame` and up
/// leaves in effect (past the last frame when it leaves none). bash's
/// `parse_and_execute` runs its `pe_dispose` unwind frame, which undoes the
/// redirections of the commands it ran, for every jump but two while a
/// function runs (`variable_context`, also one called inside it): for
/// `exit` when an EXIT trap is set it discards that frame at every level,
/// so the reports and the trap go through them; for `ERREXIT` under `set
/// -e` it discards it at the innermost level only, which also leaves every
/// function context (`reset_local_contexts`), so the levels outside that
/// one undo theirs (a posix special builtin's `ERREXIT` without `set -e`
/// undoes everywhere).
fn kept_redirections(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	frame: usize,
	jump: Jump,
) -> usize {
	let none = vp.frames.len();
	match jump {
		Jump::Other | Jump::Cleanup => none,
		Jump::Direct => frame,
		Jump::Exit if function_context(k, cx, vp) && exit_trapped(k, cx, vp) => frame,
		Jump::Errexit if function_context(k, cx, vp) && errexit_on(k, cx, vp) => vp
			.frames
			.iter()
			.rposition(parse_and_execute)
			.unwrap_or(none),
		Jump::Exit | Jump::Errexit => none,
	}
}

/// Whether `vp` has an EXIT trap set (bash's `signal_is_trapped (0)`), also
/// one that ignores (`trap '' EXIT`); a subshell lists its parent's but has
/// none of its own, and none while its own runs until the action sets one
/// again ([`start_trap`]).
fn exit_trapped(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	if vp.parent.is_some() && !vp.own_traps.has(TrapKey::Exit) {
		return false;
	}
	match state::record(cx.store, vp, Key::Trap(TrapKey::Exit)) {
		Ok(rec) => matches!(rec, Some(Record::Trap { .. })),
		Err(err) => {
			k.fail(err);
			false
		},
	}
}

/// The `-p` flags of the `n` innermost `TimeEnd`s frame `f` has still to
/// reach (its pending `time` marks, innermost first): the first ones after
/// its pc that close no `time` started after it.
fn pending_time_ends(f: &super::proc::Frame, n: usize) -> Vec<bool> {
	let mut ends = Vec::with_capacity(n);
	if let Some(unit) = f.unit.as_deref() {
		let mut depth = 0u32;
		for op in unit.ops.iter().skip(f.pc as usize) {
			if ends.len() == n {
				break;
			}
			match op.code {
				Opcode::TimeStart => depth += 1,
				Opcode::TimeEnd if depth > 0 => depth -= 1,
				Opcode::TimeEnd => ends.push(op.b == 1),
				_ => {},
			}
		}
	}
	ends.resize(n, false);
	ends
}

/// A jump out of frames `frame` and up (`exit`, `set -e`, a discarded
/// command; `jump` says which): their `time` marks report
/// ([`report_left_times`]) and go out before the unwind
/// ([`written_before_the_unwind`]), as the message queued before it does.
/// bash's `top_level_cleanup` comes first for [`Jump::Cleanup`]
/// ([`jump_out`]); [`Jump::Direct`] is no jump, and its marks go
/// unreported. zsh mode keeps its own rules.
pub(super) fn report_jump(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	frame: usize,
	jump: Jump,
) {
	if vp.mode.dialect() == Dialect::Zsh {
		return;
	}
	match jump {
		Jump::Direct => {
			for f in vp.frames.iter_mut().skip(frame) {
				f.times.clear();
			}
		},
		Jump::Cleanup => jump_out(k, cx, vp, true, &Flow::Exit(vp.status, jump)),
		Jump::Exit | Jump::Errexit | Jump::Other => {},
	}
	report_left_times(k, vp, cx, frame, jump);
	written_before_the_unwind(k, vp);
}

/// bash writes a jump's reports and messages while the redirections in
/// effect at the jump still apply (`( time { exit 3; } 2>err )` reports
/// into `err`): what is queued goes out before the unwind undoes them; what
/// would block is written after it, as for a failed redirection.
fn written_before_the_unwind(k: &mut Kernel, vp: &mut Vproc) {
	if !vp.out.is_empty() {
		let _ = flush_out(k, vp);
	}
}

/// The innermost script frame (the run's, `eval`'s, `.`'s, a trap
/// action's): a discarded or aborted command leaves it and the frames above.
fn script_frame(vp: &Vproc) -> Option<usize> {
	vp.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { .. }))
}

/// The innermost running EXIT trap action: in a subshell, bash's
/// `run_exit_trap` is the only catch of a discarded command below the
/// top level (the `parse_and_execute` of an `eval`, `.` or other trap
/// action passes it on).
fn exit_trap_frame(vp: &Vproc) -> Option<usize> {
	vp.frames.iter().rposition(|f| {
		matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { key: TrapKey::Exit, .. }, .. })
	})
}

/// Drop every pending `time` mark without a report: `exec` replaced the
/// shell ([`report_left_times`]).
pub(super) fn drop_times(vp: &mut Vproc) {
	for f in &mut vp.frames {
		f.times.clear();
	}
}

/// An arithmetic error in a subscript or in an integer variable's value in
/// bash mode: bash's `array_expand_index` and `make_variable_value` run
/// `top_level_cleanup` before their jump ([`jump_out`]).
pub(super) fn cleanup_jump(vp: &Vproc, d: &Diag) -> bool {
	matches!(d, Diag::ArithSubscript { .. } | Diag::ArithValue { .. })
		&& vp.mode.dialect() != Dialect::Zsh
}

/// Whether `d` is one of bash's `report_error` messages (error.c:170): a
/// readonly variable assigned (`err_readonly`), an unbound one, `${x:?}`,
/// `${1:=x}`, a bad substitution or array subscript, an invalid indirect
/// expansion or variable name, a `failglob` miss, a list assigned to an
/// array element, a compound assignment's element without a key for an
/// associative array or with a non-numeric one for an indexed array, and
/// a file `.` cannot read (`file_error`). A builtin's own message
/// (`declare: r: readonly variable`) is `builtin_error`, which never exits.
/// Also bash's `parser_error` while it runs (error.c:324), which makes the
/// same check: a compound value given as a string that does not parse
/// ([`Diag::ArrayAssign`]).
const fn reports_error(d: &Diag) -> bool {
	matches!(
		d,
		Diag::Readonly { .. }
			| Diag::Unbound { .. }
			| Diag::ParamUnset { .. }
			| Diag::CannotAssign { .. }
			| Diag::BadSubst { .. }
			| Diag::BadSubscript { .. }
			| Diag::InvalidIndirect { .. }
			| Diag::InvalidVarName { .. }
			| Diag::NoMatch { .. }
			| Diag::ListToMember { .. }
			| Diag::AssocSubscript { .. }
			| Diag::NonNumericIndex { .. }
			| Diag::FileError { .. }
			| Diag::ArrayAssign { .. }
	)
}

/// Whether bash's `report_error` exits the shell for `d` ([`reports_error`],
/// error.c:182): under `set -e` it calls `exit_shell` itself, with no jump,
/// so no `time` reports ([`Jump::Direct`]). bash turns the flag off only
/// inside an `eval`, `.` or builtin run through `command` that a condition
/// runs (`execute_cmd.c`, line 5000), not for the condition's own commands:
/// a frame such a builtin pushed here (the builtin's own command, on the
/// frame below, says how it was run: [`errexit_off`]), the builtin itself
/// in `settle_builtin`.
pub(super) fn report_error_exits(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, d: &Diag) -> bool {
	reports_error(d)
		&& vp.mode.dialect() != Dialect::Zsh
		&& !vp.frames.iter().enumerate().any(|(i, f)| {
			f.ignore_errexit
				&& matches!(f.kind, FrameKind::Script {
					what: ScriptKind::Eval | ScriptKind::Source,
					..
				})
				&& i
					.checked_sub(1)
					.and_then(|below| vp.frames[below].scratch.as_ref())
					.and_then(|sc| sc.exec.as_ref())
					.is_none_or(|e| match e.target {
						Some(Target::Intrinsic(id)) => errexit_off(e.prefix, id),
						_ => true,
					})
		})
		&& errexit_on(k, cx, vp)
}

/// Whether bash's `execute_builtin` turns `set -e` off for builtin `id` run
/// with `prefix` in a condition (`execute_cmd.c`, line 5000): through
/// `command`, or `eval`, `.` and `source` named directly (not through
/// `builtin`, whose own run keeps the flag).
pub(super) const fn errexit_off(prefix: Prefix, id: IntrinsicId) -> bool {
	match prefix {
		Prefix::Command => true,
		Prefix::Builtin => false,
		Prefix::None => matches!(id, IntrinsicId::Eval | IntrinsicId::Dot | IntrinsicId::Source),
	}
}

/// The status [`report_error_exits`] leaves with: 1 for an error bash sets
/// the status for before the message, else `$?`, or 1 when that is 0; 2
/// for `parser_error`'s (`exit_shell (last_command_exit_value = 2)`).
pub(super) const fn report_error_status(vp: &Vproc, d: &Diag) -> i32 {
	match d {
		Diag::Readonly { .. }
		| Diag::BadSubscript { .. }
		| Diag::InvalidIndirect { .. }
		| Diag::InvalidVarName { .. }
		| Diag::ListToMember { .. }
		| Diag::FileError { .. }
			if vp.status != 0 =>
		{
			vp.status
		},
		Diag::ArrayAssign { .. } => 2,
		_ => 1,
	}
}

/// The first frame `flow` leaves: every frame for an exit, the innermost
/// script frame and up for a discarded or aborted command, the frames above
/// the top level ([`top_level_frame`]) for a discard to it; `None` for a
/// flow that leaves none.
fn left_frame(cx: &mut Cx<'_>, vp: &Vproc, flow: &Flow) -> Option<usize> {
	match flow {
		Flow::Exit(..) => Some(0),
		Flow::Discard(_) | Flow::Abort(_) => Some(script_frame(vp).unwrap_or(0)),
		Flow::DiscardTop(_) => Some(top_level_frame(cx, vp)),
		_ => None,
	}
}

/// Whether the run is a `-c` string (its subshells keep the origin).
fn runs_c(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	runs_c_in(cx.store, vp)
}

/// [`runs_c`] from the store alone.
fn runs_c_in(store: &mut dyn StateStore, vp: &Vproc) -> bool {
	matches!(
		state::record(store, vp, Key::Misc(MiscKey::RunOrigin)),
		Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
	)
}

/// The level a child forked from `vp` starts in ([`ParseLevel`]): the
/// outermost `parse_and_execute` level still running at the fork, whose
/// saved jump target bash's `top_level_cleanup` restores.
/// - A level `vp`'s own fork kept is older than any it runs itself.
/// - A substitution's text is a level while it runs; once the substitution's
///   EXIT trap runs, the text has ended.
/// - A subshell of a `-c` string kept the string's level from its fork. The
///   root's string runs until its EXIT trap starts: bash leaves it (`exit`,
///   `set -e` and a fatal error jump out of every level) before
///   `run_exit_trap`.
/// - Then a running EXIT trap action is the outermost level, as nothing below
///   it runs any more, and `top_level_cleanup` restores its own jump target
///   ([`ParseLevel::InExitTrap`]).
/// - Else any `eval`, `.` or trap action is ([`ParseLevel::Kept`]).
pub(super) fn fork_level(store: &mut dyn StateStore, vp: &Vproc) -> ParseLevel {
	let exit_trap = exit_trap_frame(vp).is_some();
	match vp
		.frames
		.first()
		.map_or(ParseLevel::Outside, |f| f.flags.parse_level())
	{
		base @ (ParseLevel::Kept | ParseLevel::InSubstitution | ParseLevel::InExitTrap) => {
			return base;
		},
		ParseLevel::Substitution if !exit_trap => return ParseLevel::InSubstitution,
		ParseLevel::Outside | ParseLevel::Substitution => {},
	}
	let level = vp.frames.iter().any(parse_and_execute);
	let command =
		runs_c_in(store, vp) && (vp.runs.is_empty() || (run_frame(vp).is_some() && !exit_trap));
	if exit_trap && !command {
		ParseLevel::InExitTrap
	} else if level {
		ParseLevel::Kept
	} else {
		ParseLevel::Outside
	}
}

/// The run's own script frame (`None` in a subshell, which has none).
fn run_frame(vp: &Vproc) -> Option<usize> {
	vp.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }))
}

/// The frame bash's `jump_to_top_level (DISCARD)` after `top_level_cleanup`
/// goes back to ([`Flow::DiscardTop`]): a script's own frame, where its
/// `reader_loop` drops the line; frame 0 when the run ends instead (a `-c`
/// string, whose `run_one_command` returns) or is the parent's (a
/// subshell, which exits).
fn top_level_frame(cx: &mut Cx<'_>, vp: &Vproc) -> usize {
	if runs_c(cx, vp) {
		return 0;
	}
	run_frame(vp).unwrap_or(0)
}

/// [`Flow::DiscardTop`] in bash mode: the `time`s [`jump_out`] kept (a
/// script's own) report, then a `-c` string ends with status 1 (its
/// `run_one_command` sets `EXECUTION_FAILURE`, also in its subshells), a
/// script drops the rest of its line and reads the next one with the status
/// given (its `reader_loop`), and a subshell exits with that status. A
/// command or process substitution exits with status 1 in a script too
/// (`command_substitute` and `process_substitute` set `EXECUTION_FAILURE`).
fn discard_top(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	// bash's `run_exit_trap` sets its own jump target: a discard inside a
	// running EXIT trap action ends the action, and the shell exits with
	// `trap_saved_exit_value` ([`Vproc::trap_saved`]), not the discard's. A
	// child whose fork kept an older running `parse_and_execute` (a `-c`
	// string, an `eval`, `.` or other trap action, a substitution's text) is
	// the exception: `top_level_cleanup` restores that level's jump target,
	// which ends the child below with the discard's status (1 under `-c` or
	// in a substitution's text).
	if let Some(i) = exit_trap_frame(vp)
		&& !(super::nested::in_subshell(cx.store, vp) && kept_parse_level(cx, vp))
	{
		report_jump(k, vp, cx, i, Jump::Cleanup);
		end_exit_trap(k, vp, cx, i);
		return;
	}
	// A child forked where an EXIT trap action was the outermost level:
	// `top_level_cleanup` restores that action's jump target, so the child
	// returns into the trap it was forked in (`run_exit_trap`), which ends
	// it with `trap_saved_exit_value`; the child's own EXIT trap does not
	// run, its `exit_shell` being the one that ran the trap.
	if vp
		.frames
		.first()
		.is_some_and(|f| f.flags.parse_level() == ParseLevel::InExitTrap)
		&& super::nested::in_subshell(cx.store, vp)
	{
		report_jump(k, vp, cx, 0, Jump::Cleanup);
		vp.exit_trap_due = false;
		let saved = vp.trap_saved;
		exit_shell(k, vp, cx, saved, Jump::Cleanup);
		return;
	}
	let command = runs_c(cx, vp);
	let substitution = vp
		.frames
		.first()
		.is_some_and(|f| f.flags.parse_level().substitution());
	vp.status = if command || substitution { 1 } else { status };
	match run_frame(vp) {
		// An interactive shell's own input goes on: the command is dropped
		// and the next one read.
		Some(i) if command => {
			report_jump(k, vp, cx, i, Jump::Other);
			unwind(&mut k.root, cx.store, vp, i + 1);
			if super::zle::reader::applies(cx, vp) {
				top_frame(vp).unit = None;
			} else {
				unwind(&mut k.root, cx.store, vp, i);
			}
		},
		Some(i) => {
			report_jump(k, vp, cx, i, Jump::Other);
			unwind(&mut k.root, cx.store, vp, i + 1);
			clear_scratch(&mut k.root, cx.store, vp);
			truncate(vp, Depths::default());
			let f = top_frame(vp);
			f.unit = None;
			f.loops.clear();
		},
		// A subshell exits and runs its EXIT trap (bash's `subshell_exit`).
		// `top_level_cleanup` came first: its `run_unwind_protects` has popped
		// every function, also those the shell the subshell forked from was
		// running, and `variable_context` is 0 (sig.c:401), so the trap runs
		// outside every function ([`Jump::Cleanup`]: [`exit_shell`]'s
		// [`leave_functions`] pops them).
		None => {
			report_jump(k, vp, cx, 0, Jump::Cleanup);
			if super::nested::in_subshell(cx.store, vp) {
				let status = vp.status;
				exit_shell(k, vp, cx, status, Jump::Cleanup);
			} else {
				unwind(&mut k.root, cx.store, vp, 0);
			}
		},
	}
}

/// Whether a child's fork kept a running `parse_and_execute` level of the
/// shell it forked from that is older than its own EXIT trap and no EXIT
/// trap action itself ([`fork_level`]): the run's `-c` string, or an
/// `eval`, `.`, other trap action or substitution's text
/// ([`ParseLevel::Kept`], [`ParseLevel::InSubstitution`]). The level is
/// read from the base frame, which is the trap's own once the child's
/// frames are gone ([`exit_trap_keeps_level`]). A command or process
/// substitution's own text has ended by the time its EXIT trap runs.
fn kept_parse_level(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	match vp
		.frames
		.first()
		.map_or(ParseLevel::Outside, |f| f.flags.parse_level())
	{
		ParseLevel::Kept | ParseLevel::InSubstitution => true,
		ParseLevel::InExitTrap => false,
		ParseLevel::Outside | ParseLevel::Substitution => runs_c(cx, vp),
	}
}

/// The level a child's fork kept ([`fork_level`]), read before its frames
/// unwind for its EXIT trap: bash's unwind-protects still hold that level
/// while the trap runs. A substitution's own text level has ended.
fn kept_level(vp: &Vproc) -> ParseLevel {
	match vp.frames.first().map(|f| f.flags.parse_level()) {
		Some(level @ (ParseLevel::Kept | ParseLevel::InSubstitution | ParseLevel::InExitTrap)) => {
			level
		},
		_ => ParseLevel::Outside,
	}
}

/// Start a child's EXIT trap once its frames are gone
/// ([`start_exit_trap_once`]); the trap's frame, now the base, takes over
/// `kept`, the level the child's fork kept ([`kept_level`]).
fn exit_trap_keeps_level(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	kept: ParseLevel,
) -> bool {
	let started = start_exit_trap_once(k, vp, cx);
	if started && let [frame] = vp.frames.as_mut_slice() {
		frame.flags.set_parse_level(kept);
	}
	started
}

/// End the EXIT trap action at frame `i` where bash's `run_exit_trap`
/// catches a jump: the frames above it go, and the action reads no more
/// commands, so it ends with `trap_saved_exit_value` then
/// ([`Vproc::trap_saved`]): its own saved `$?`, unless a trap that started
/// inside the action saved another.
fn end_exit_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, i: usize) {
	unwind(&mut k.root, cx.store, vp, i + 1);
	clear_scratch(&mut k.root, cx.store, vp);
	truncate(vp, Depths::default());
	let saved = vp.trap_saved;
	let f = top_frame(vp);
	f.unit = None;
	f.loops.clear();
	if let FrameKind::Script { src, pos, aux, what, .. } = &mut f.kind {
		*pos = (src.len() as u32, pos.1);
		if let Some(a) = aux {
			a.pending = None;
		}
		if let ScriptKind::Trap { status, .. } = what {
			*status = saved;
		}
	}
}

/// Whether `f` runs inside one of bash's `parse_and_execute` levels it
/// starts or keeps: `eval`, `.`, a trap action, the line editor's code (not
/// the run's own script), and the base frame of a child that runs inside
/// one from its start ([`super::proc::FrameFlags::parse_level`]).
pub(super) fn parse_and_execute(f: &Frame) -> bool {
	f.flags.parse_level() != ParseLevel::Outside
		|| matches!(f.kind, FrameKind::Script { what, .. } if what != ScriptKind::Run)
}

/// The first frame inside a `parse_and_execute`: frame 0 under `-c` (and in
/// its subshells, which inherit the level) and in a child that runs inside
/// one from its start (a subshell, job or pipeline stage forked inside an
/// `eval`, `.` or trap action; a command or process substitution), else the
/// first `eval`, `.` or trap action frame; past the last frame for a
/// script's own commands.
fn parse_and_execute_frame(cx: &mut Cx<'_>, vp: &Vproc) -> usize {
	if runs_c(cx, vp) {
		return 0;
	}
	vp.frames
		.iter()
		.position(parse_and_execute)
		.unwrap_or(vp.frames.len())
}

/// bash's `run_unwind_protects`: what is queued goes out through the
/// redirections in effect, then those of frames `from` up to `to` (not
/// included) are undone (each frame's running op's own, then its compound
/// commands', innermost first), so the reports that follow go to the fds
/// outside them.
fn undo_redirections(k: &mut Kernel, vp: &mut Vproc, from: usize, to: usize) {
	written_before_the_unwind(k, vp);
	let mut i = to.min(vp.frames.len());
	while i > from {
		i -= 1;
		let own = vp.frames[i]
			.scratch
			.as_mut()
			.and_then(|sc| sc.io.as_mut())
			.map(|io| std::mem::take(&mut io.saved));
		if let Some(saves) = own {
			restore(vp, saves);
		}
		while let Some(saves) = vp.frames[i].redirs.pop() {
			restore(vp, saves.fds);
		}
	}
}

/// A bash-mode jump to the top level for an error whose message is queued:
/// bash runs `top_level_cleanup` first for an arithmetic subscript error and
/// a builtin's `no_args` (`cleanup`), and `exp_jump_to_top_level` runs it
/// for an expansion error, a failed assignment or a `failglob` miss outside
/// every `parse_and_execute` (a script's own command). It undoes the
/// redirections the jump leaves, so the `time`s that catch the jump report
/// on the shell's own stderr; for `cleanup`, the marks started inside a
/// `parse_and_execute` are dropped unreported as well (their jump targets
/// are gone). Frames `flow` does not leave keep theirs: their commands go
/// on. Records on `k` whether bash ran `top_level_cleanup`
/// ([`top_level_jump`]), for the arm that takes `flow`.
pub(super) fn jump_out(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	cleanup: bool,
	flow: &Flow,
) {
	if vp.mode.dialect() == Dialect::Zsh {
		return;
	}
	let Some(leave) = left_frame(cx, vp, flow) else {
		return;
	};
	let inside = parse_and_execute_frame(cx, vp);
	let all = vp.frames.len();
	k.top_level_cleanup = cleanup || inside == all;
	if cleanup {
		undo_redirections(k, vp, leave, all);
		for f in vp.frames.iter_mut().skip(leave.max(inside)) {
			f.times.clear();
		}
	} else if inside == all {
		undo_redirections(k, vp, leave, all);
	}
}

/// The kind of the exit [`jump_out`] makes: [`Jump::Cleanup`] when bash runs
/// `top_level_cleanup` before it (`cleanup`, or outside every
/// `parse_and_execute`, where `exp_jump_to_top_level` runs it), else
/// [`Jump::Other`].
pub(super) fn top_level_jump(cx: &mut Cx<'_>, vp: &Vproc, cleanup: bool) -> Jump {
	if cleanup || parse_and_execute_frame(cx, vp) == vp.frames.len() {
		Jump::Cleanup
	} else {
		Jump::Other
	}
}

/// zsh's `time` report (`dumptime`, `shelltime`): the times of the
/// pipeline written `src` in `$TIMEFMT` (zsh's default when unset) on
/// stderr, `%J` being its text after `time`; `time` alone (`None`)
/// reports the shell's own times since it started (`shell`) and its
/// children's (`children`).
fn zsh_time_end(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	src: Option<&[u8]>,
	start: super::proc::TimeMark,
	end: super::proc::TimeMark,
) {
	let format = match state::lookup(&k.root, cx.store, vp, b"TIMEFMT") {
		Ok(Some(v)) => BString::from(v.as_scalar().unwrap_or_default()),
		Ok(None) => BString::from(ZSH_TIMEFMT),
		Err(err) => {
			k.fail(err);
			return;
		},
	};
	let text = if let Some(src) = src {
		let desc = src.strip_prefix(b"time").unwrap_or(src).trim_ascii_start();
		let times = [
			end.real.saturating_sub(start.real),
			end.user.saturating_sub(start.user),
			end.sys.saturating_sub(start.sys),
		];
		zsh_time_report(&format, desc, times)
	} else {
		let cpu = cx.host.cpu_times().unwrap_or_default();
		let real = end.real.saturating_sub(k.start_of(vp));
		let mut text = zsh_time_report(&format, b"shell", [real, cpu.user_ns, cpu.sys_ns]);
		let children = [real, cpu.child_user_ns, cpu.child_sys_ns];
		text.extend_from_slice(&zsh_time_report(&format, b"children", children));
		text
	};
	vp.out.push_back(PendingWrite::new(2, text.into()));
}

/// zsh's default `TIMEFMT` (`DEFAULT_TIMEFMT`).
const ZSH_TIMEFMT: &[u8] = b"%J  %U user %S system %P cpu %*E total";

/// zsh `printtime`: `format` for job text `desc` and `times` (real, user,
/// system; ns), plus a newline. `%E %U %S` as `0.00s`, `%mE`… in ms,
/// `%uE`… in µs, `%*E`… as `[h:]m:ss.ss` or `s.sss`, `%P` the CPU
/// percentage, `%J` the text, `%%`; resource-usage counts (`%M %F %R %I
/// %O %W %X %D %K %r %s %k %w %c`) are 0 (the host reports none); any
/// other `%c` prints as written.
fn zsh_time_report(format: &[u8], desc: &[u8], times: [u64; 3]) -> Vec<u8> {
	use std::io::Write as _;

	let secs = |ns: u64| ns as f64 / 1e9;
	let (elapsed, user, system) = (secs(times[0]), secs(times[1]), secs(times[2]));
	// zsh's `int percent` (0 for no elapsed time, where C divides by zero).
	let percent = if elapsed > 0.0 {
		(100.0 * (user + system) / elapsed) as i64
	} else {
		0
	};
	let pick = |c: u8| match c {
		b'E' => Some(elapsed),
		b'U' => Some(user),
		b'S' => Some(system),
		_ => None,
	};
	let mut out = Vec::with_capacity(format.len() + 32);
	let mut i = 0;
	while let Some(&c) = format.get(i) {
		i += 1;
		if c != b'%' {
			out.push(c);
			continue;
		}
		let Some(&d) = format.get(i) else {
			break;
		};
		i += 1;
		let w = &mut out;
		let r = match d {
			b'E' | b'U' | b'S' => write!(w, "{:4.2}s", pick(d).unwrap_or_default()),
			b'm' | b'u' | b'*' => match format.get(i).and_then(|&e| pick(e)) {
				Some(t) => {
					i += 1;
					match d {
						b'm' => write!(w, "{:.0}ms", t * 1000.0),
						b'u' => write!(w, "{:.0}us", t * 1_000_000.0),
						_ => print_hhmmss(w, t),
					}
				},
				None => write!(w, "%{}", char::from(d)),
			},
			b'P' => write!(w, "{percent}%"),
			b'W' | b'X' | b'D' | b'K' | b'M' | b'F' | b'R' | b'I' | b'O' | b'r' | b's' | b'k'
			| b'w' | b'c' => write!(w, "0"),
			b'J' => w.write_all(desc),
			b'%' => w.write_all(b"%"),
			_ => {
				w.push(b'%');
				w.push(d);
				Ok(())
			},
		};
		r.expect("writing to a Vec cannot fail");
	}
	out.push(b'\n');
	out
}

/// zsh `printhhmmss`: `h:mm:ss.ss`, `m:ss.ss` or `s.sss`.
fn print_hhmmss(out: &mut Vec<u8>, secs: f64) -> std::io::Result<()> {
	use std::io::Write as _;

	let mins = secs as i64 / 60;
	let hours = mins / 60;
	let secs = secs - (60 * mins) as f64;
	let mins = mins - 60 * hours;
	if hours != 0 {
		write!(out, "{hours}:{mins:02}:{secs:05.2}")
	} else if mins != 0 {
		write!(out, "{mins}:{secs:05.2}")
	} else {
		write!(out, "{secs:.3}")
	}
}

/// Whether the `time` ending at `op` timed no pipeline (`time`, `time !`):
/// only `!` and empty simple commands between its `TimeStart` (same
/// `node`) and `pc`.
fn time_null(unit: &Unit, pc: usize, node: u32) -> bool {
	unit.ops[..pc.min(unit.ops.len())]
		.iter()
		.rev()
		.take_while(|o| !(o.code == Opcode::TimeStart && o.node == node))
		.all(|o| match o.code {
			Opcode::Not => true,
			Opcode::Exec => unit.cmds.get(o.a as usize).is_some_and(|c| {
				c.assigns.is_empty()
					&& c.redirs.is_none()
					&& unit.lists.get(c.words as usize).is_none_or(Vec::is_empty)
			}),
			_ => false,
		})
}

/// bash's `print_formatted_time`: `format` with `%[p][l]R|U|S` (real, user
/// and system time of `times`, ns; `p` digits after the point, default 3;
/// `l` as `MmS.FFs`), `%P` (CPU percentage) and `%%`, plus a newline.
/// `Err` is an invalid format character (nothing is printed).
fn time_report(format: &[u8], times: [u64; 3]) -> Result<Vec<u8>, u8> {
	let mut out = Vec::with_capacity(format.len() + 16);
	let mut i = 0;
	while i < format.len() {
		let c = format[i];
		if c != b'%' || i + 1 == format.len() {
			out.push(c);
			i += 1;
			continue;
		}
		i += 1;
		match format[i] {
			b'%' => out.push(b'%'),
			b'P' => {
				let us = |ns: u64| u128::from(ns / 1000);
				let real = us(times[0]);
				let cpu = ((us(times[1]) + us(times[2])) * 10_000)
					.checked_div(real)
					.unwrap_or(0);
				let cpu = u64::try_from(cpu).unwrap_or(u64::MAX);
				push_time(&mut out, 2, false, cpu / 100, (cpu % 100) * 10_000);
			},
			_ => {
				let mut prec = 3;
				let mut long = false;
				if format[i].is_ascii_digit() {
					prec = usize::from(format[i] - b'0').min(6);
					i += 1;
				}
				if format.get(i) == Some(&b'l') {
					long = true;
					i += 1;
				}
				let ns = match format.get(i) {
					Some(b'R' | b'E') => times[0],
					Some(b'U') => times[1],
					Some(b'S') => times[2],
					Some(&c) => return Err(c),
					None => return Err(0),
				};
				push_time(&mut out, prec, long, ns / 1_000_000_000, (ns % 1_000_000_000) / 1000);
			},
		}
		i += 1;
	}
	out.push(b'\n');
	Ok(out)
}

/// bash's `mkfmt`: `secs` and `micros` with `prec` fraction digits
/// (rounded, without carrying into the seconds, as bash does); `long` as
/// `MmS.FFs`.
fn push_time(out: &mut Vec<u8>, prec: usize, long: bool, mut secs: u64, micros: u64) {
	const PRECS: [u64; 7] = [0, 100_000, 10_000, 1000, 100, 10, 1];
	const MAXVALS: [u64; 7] = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000];
	let mut buf = NumBuffer::new();
	if long {
		out.extend_from_slice((secs / 60).format_into(&mut buf).as_bytes());
		out.push(b'm');
		secs %= 60;
	}
	out.extend_from_slice(secs.format_into(&mut buf).as_bytes());
	if prec > 0 {
		let mut frac = micros;
		if prec < 6 {
			let maxval = MAXVALS[6 - prec];
			let mut f = frac / maxval;
			if frac % maxval >= maxval / 2 {
				f += 1;
			}
			frac = f * (1_000_000 / MAXVALS[prec]);
		}
		out.push(b'.');
		for p in &PRECS[1..=prec] {
			out.push(b'0'.wrapping_add((frac / p) as u8));
			frac %= p;
		}
	}
	if long {
		out.push(b's');
	}
}

fn for_in(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pc = top_frame(vp).pc;
	let exit = unit.ops.get(pc as usize + 1).map_or(pc + 1, |next| next.a);
	let var = unit.names[op.b as usize].clone();
	// The list is evaluated once per loop; it is logged because the op can
	// be re-entered (a comsub, or a glob whose fs answer is pending), so the
	// expansion's side effects run once.
	let record = op.a != Op::POSITIONAL;
	let (mut items, globs, sub) = match expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut globs = Vec::new();
		let items = if op.a == Op::POSITIONAL {
			state::positional(&ex.k.root, ex.cx.store, ex.vp)?
		} else {
			let mut items = Vec::new();
			for &w in &unit.lists[op.a as usize] {
				ex.fields_glob(unit, &unit.words[w as usize], &mut items, &mut globs)?;
			}
			items
		};
		Ok((items, globs, ex.sub_status))
	}) {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	if !globs.is_empty()
		&& let Err(flow) = if unit.mode.dialect() == Dialect::Zsh {
			super::zsh::zglob::expand_globs(k, vp, cx, &mut items, &globs, line)
		} else {
			super::glob::expand_globs(k, vp, cx, &mut items, &globs, line)
		} {
		return flow;
	}
	// zsh `execfor`: the list's substitutions set `$?` for the first pass.
	if let Some(sub) = sub
		&& unit.mode.dialect() == Dialect::Zsh
	{
		vp.status = sub;
	}
	let multi = op.flags & Op::MULTI != 0;
	// zsh `isident`: a positional parameter's number is a name too.
	let zsh = unit.mode.dialect() == Dialect::Zsh;
	// zsh `itype_end(…, IIDENT)`: multibyte letters too, as the parser
	// allowed.
	let wide = zsh && super::zsh::params::wide_idents_in(k, cx.store, vp).unwrap_or(false);
	let name_ok = |n: &[u8]| {
		is_ident(n)
			|| (zsh && !n.is_empty() && n.iter().all(u8::is_ascii_digit))
			|| (wide && super::zsh::params::isident(&crate::bash::syntax::zsh::tok::metafy(n), true))
	};
	let valid = if multi {
		var.split(|&c| c == b'\n').all(name_ok)
	} else {
		name_ok(&var)
	};
	let status = if valid {
		0
	} else {
		// bash checks a `select` name before it sets the line, so the
		// message carries the line in effect: in a function, its body's.
		let select = op.flags & Op::SELECT != 0;
		let shown = match (select, vp.frames.last()) {
			(true, Some(f)) if matches!(f.kind, FrameKind::Function { .. }) => unit
				.ops
				.first()
				.map_or(line, |first| line_of(vp, first.node)),
			_ => line,
		};
		k.diag(cx, vp, shown, Diag::InvalidIdent { name: var.clone() });
		if state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
			// Fatal to a posix shell.
			clear_scratch(&mut k.root, cx.store, vp);
			return Flow::Exit(1, Jump::Other);
		}
		items.clear();
		1
	};
	clear_scratch(&mut k.root, cx.store, vp);
	// `set -x`: bash shows a `select` header once, a `for` header per word.
	if op.flags & Op::SELECT != 0 && super::xtrace::on(k, cx, vp) {
		let body = loop_header(unit, op);
		super::xtrace::emit(k, cx, vp, line, &body);
	}
	let f = top_frame(vp);
	let depth = depths(f);
	let kind = if op.flags & Op::SELECT != 0 {
		LoopKind::Select { var, items, first: true, more: 0 }
	} else if multi {
		let vars = var.split(|&c| c == b'\n').map(BString::from).collect();
		LoopKind::ForMulti { vars, items, next: 0 }
	} else {
		LoopKind::For { var, items, next: 0 }
	};
	f.loops
		.push(LoopRec { kind, status, iterations: 0, exit, cont: pc + 1, depth });
	Flow::Next
}

fn for_next(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Flow {
	let Some(rec) = top_frame(vp).loops.last_mut() else {
		return Flow::Jump(op.a);
	};
	if matches!(rec.kind, LoopKind::Repeat { .. } | LoopKind::ForMulti { .. }) {
		return zsh_next(k, vp, cx, op, line).unwrap_or(Flow::Next);
	}
	let n = rec.iterations + 1;
	let header_pc = rec.cont.checked_sub(1);
	let (var, value) = if matches!(rec.kind, LoopKind::Select { .. }) {
		match builtins::select_next(k, vp, cx, line) {
			Ok(Some(pair)) => pair,
			Ok(None) => return Flow::Jump(op.a),
			Err(flow) => return flow,
		}
	} else {
		match &mut rec.kind {
			LoopKind::For { var, items, next } => {
				let Some(value) = items.get(*next as usize).cloned() else {
					return Flow::Jump(op.a);
				};
				*next += 1;
				(var.clone(), value)
			},
			LoopKind::Select { .. }
			| LoopKind::While
			| LoopKind::Repeat { .. }
			| LoopKind::ForMulti { .. }
			| LoopKind::Try { .. } => return Flow::Next,
		}
	};
	clear_scratch(&mut k.root, cx.store, vp);
	let select = top_frame(vp)
		.loops
		.last()
		.is_some_and(|r| matches!(r.kind, LoopKind::Select { .. }));
	// A `for` variable that is a nameref is retargeted to each word.
	let assigned = if select {
		builtins::assign(k, vp, cx, &var, value.clone(), Level::Dynamic)
	} else if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		builtins::assign_zsh_loop_var(k, vp, cx, &var, &value, line)
	} else {
		builtins::assign_loop_var(k, vp, cx, &var, value.clone())
	};
	if let Err(d) = assigned {
		// Under `set -e` bash's `report_error` exits the shell itself.
		if report_error_exits(k, cx, vp, &d) {
			let status = report_error_status(vp, &d);
			k.diag(cx, vp, line, d);
			return Flow::Exit(status, Jump::Direct);
		}
		// An integer variable's arithmetic error abandons the line (bash's
		// `make_variable_value`: `top_level_cleanup`, then the jump).
		if cleanup_jump(vp, &d) {
			k.diag(cx, vp, line, d);
			let flow = Flow::DiscardTop(1);
			jump_out(k, cx, vp, true, &flow);
			return flow;
		}
		k.diag(cx, vp, line, d);
		// An assignment error ends a posix shell.
		if state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
			return Flow::Exit(1, Jump::Other);
		}
		if let Some(rec) = top_frame(vp).loops.last_mut() {
			rec.status = 1;
		}
		return Flow::Jump(op.a);
	}
	if !select && super::xtrace::on(k, cx, vp) {
		let f = top_frame(vp);
		let header = f.unit.as_ref().and_then(|u| {
			let forin = *u.ops.get(header_pc? as usize)?;
			(forin.code == Opcode::ForIn).then(|| loop_header(u, forin))
		});
		if let Some(body) = header {
			super::xtrace::emit(k, cx, vp, line, &body);
		}
	}
	if k.mask.any_op(op.ev) {
		// Bash/select setters emit at their actual commit seam. The zsh
		// parameter setter has separate assignment semantics.
		if !select && vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let scope = assign_scope(vp);
			k.emit_op(cx, vp, op.node, EventData::Assign {
				name: BStr::new(&var),
				value: BStr::new(assign_preview(&value)),
				full_len: value.len(),
				scope,
			});
		}
		k.emit_op(cx, vp, op.node, EventData::IterStart {
			n,
			var: BStr::new(&var),
			value: BStr::new(&value),
		});
	}
	Flow::Next
}

fn case_arm(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pats = &unit.pats[op.a as usize];
	let record = pats.iter().any(|&w| unit.words[w as usize].parks);
	let subject = top_frame(vp).cases.last().map_or_default(|c| c.0.clone());
	let hit = if unit.mode.dialect() == Dialect::Zsh {
		zsh_case_hit(k, vp, cx, unit, pats, &subject, record, line)
	} else {
		bash_case_hit(k, vp, cx, unit, pats, &subject, record, line)
	};
	let hit = match hit {
		Ok(hit) => hit,
		Err(flow) => return flow,
	};
	if k.mask.contains(crate::bash::event::EventKind::Branch) {
		k.emit_op(cx, vp, op.node, EventData::Branch {
			construct: Construct::CaseArm,
			taken:     hit,
			status:    vp.status,
		});
	}
	// bash's `case` is 0 when no arm matches or the matching arm's body is
	// empty (its next op is the arm's terminator jump).
	let next = if hit {
		top_frame(vp).pc as usize + 1
	} else {
		op.b as usize
	};
	let next_code = unit.ops.get(next).map(|o| o.code);
	let f = top_frame(vp);
	let matched = f.cases.last().is_some_and(|c| c.1);
	if hit {
		if let Some(c) = f.cases.last_mut() {
			c.1 = true;
		}
		if next_code == Some(Opcode::Jmp) {
			vp.status = 0;
		}
	} else if !matched && next_code == Some(Opcode::CaseEnd) {
		vp.status = 0;
	}
	if hit { Flow::Next } else { Flow::Jump(op.b) }
}

/// Whether a zsh `case` arm's patterns match `subject` (zsh `execcase`:
/// each pattern substituted and tried in turn, up to the first match).
/// Out of line, off the bash `case` path.
#[inline(never)]
fn zsh_case_hit(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	pats: &[u32],
	subject: &[u8],
	record: bool,
	line: u32,
) -> Result<bool, Flow> {
	let hit = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		for &w in pats {
			let text = ex.pattern(unit, &unit.words[w as usize])?;
			let prog =
				super::zsh::zpattern::compile(ex, &text, crate::bash::pattern::zsh::PatFlags::NONE)?;
			if super::zsh::zpattern::matches(ex, &prog, subject)? {
				return Ok(true);
			}
		}
		Ok(false)
	})?;
	clear_scratch(&mut k.root, cx.store, vp);
	Ok(hit)
}

/// Whether a bash `case` arm's patterns match `subject`.
fn bash_case_hit(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	pats: &[u32],
	subject: &[u8],
	record: bool,
	line: u32,
) -> Result<bool, Flow> {
	let patterns = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut out = Vec::with_capacity(pats.len());
		for &w in pats {
			out.push(ex.pattern(unit, &unit.words[w as usize])?);
		}
		Ok(out)
	})?;
	clear_scratch(&mut k.root, cx.store, vp);
	let opts = match (
		state::option(&mut k.root, cx.store, vp, OptId::Extglob),
		state::option(&mut k.root, cx.store, vp, OptId::Nocasematch),
	) {
		(Ok(extglob), Ok(nocase)) => {
			PatOpts::shell(extglob, nocase, super::locale::is_utf8(k, cx.store, vp))
		},
		(Err(e), _) | (_, Err(e)) => {
			k.fail(e);
			return Err(Flow::Discard(1));
		},
	};
	Ok(patterns
		.iter()
		.any(|p| k.engine.patterns().get(p, opts).matches(subject)))
}

/// Mark `child`, forked by `vp` to run the job or stage at `entry` (an
/// async command, a pipeline stage), as bash's fork for it. When the job is
/// one command (bash's `execute_disk_command` or a compound's own fork:
/// the entry `Exec` or `Redir` leads straight to the job's end, as
/// [`bang_stage`]'s `Lone` test reads it) the child gets
/// [`super::proc::Fork::entry`]: that command's own redirections are made
/// without undo, and a fatal expansion error in them, or anywhere in a
/// simple command, reaches what `vp`'s reaches. So too a bash job that times
/// a compound with redirections of its own (`time { :; } 2>/dev/null < f &`):
/// bash forks the timed job as a subshell (`CMD_FORCE_SUBSHELL`) whose
/// `execute_in_subshell` makes the compound's redirections before it times
/// the compound, so they are the fork's (the time report goes where they
/// send stderr) and a fatal error in them ends it; a timed simple command
/// runs under that child's catcher. Any other job (an async `&&`/`||` list:
/// bash forks it as a subshell, `CMD_FORCE_SUBSHELL`) and a compound
/// without redirections of its own catch their own at once. The bodies of
/// the command's substitution words come first ([`skip_blocks`]).
pub(super) fn forked_for(child: &mut Vproc, vp: &Vproc, unit: &Unit, entry: u32) {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	// The job's end: its `SubExit`, after a `!`'s `Not`.
	let ends = |at: u32| match code(at) {
		Some(Opcode::SubExit) => true,
		Some(Opcode::Not) => code(at + 1) == Some(Opcode::SubExit),
		_ => false,
	};
	let at = skip_blocks(unit, entry);
	let whole = match unit.ops.get(at as usize) {
		Some(op) if op.code == Opcode::Exec => ends(at + 1),
		Some(op) if op.code == Opcode::Redir => ends(op.b),
		// `TimeStart Redir … PopRedir [Not] TimeEnd SubExit` ([`ends_stage`]).
		Some(op) if op.code == Opcode::TimeStart && unit.mode.dialect() == Dialect::Bash => {
			let at = skip_blocks(unit, at + 1);
			unit
				.ops
				.get(at as usize)
				.is_some_and(|op| op.code == Opcode::Redir && ends_stage(unit, op.b))
		},
		_ => false,
	};
	child.set_fork(if whole {
		super::proc::Fork::entry(vp.fork())
	} else {
		super::proc::Fork::CHILD
	});
}

/// bash's `subshell_level` step for a pipeline stage or (`background`) an
/// async command starting at `entry`: a `( … )` that is the stage's whole
/// command counts once, at its own `Spawn` (a job's `time` or `!` around it
/// too: bash forks the `( … )` as the job); a simple command in a pipeline
/// expands at the parent's level (bash's "not for pipes yet":
/// [`raise_element_level`] counts it when it runs a builtin or function);
/// anything else is one more, so too an and-or job that starts with a
/// `( … )`: bash forks the whole list (`execute_connection`) and the
/// `( … )` again. In `zsh`, `entersubsh` counts every element it forks, a
/// `( … )` that starts a job counts once however the job goes on, and a
/// timed `( … )` job twice. The bodies of its substitutions come first
/// ([`skip_blocks`]).
fn stage_level(unit: &Unit, entry: u32, background: bool, zsh: bool) -> u32 {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let mut at = skip_blocks(unit, entry);
	// A job's `time` of its whole body (`TimeStart … TimeEnd`).
	if background && !zsh && code(at) == Some(Opcode::TimeStart) {
		at = skip_blocks(unit, at + 1);
	}
	// Past a compound's own redirection: its `Redir`'s `b` is just past the
	// `PopRedir` that follows the compound.
	let (start, end) = match unit.ops.get(at as usize) {
		Some(op) if op.code == Opcode::Redir => (at + 1, Some(op.b)),
		_ => (at, None),
	};
	// A `( … )`, whose `Leave` is at its spawn's end.
	if code(start) == Some(Opcode::Enter)
		&& let Some(op) = unit.ops.get(start as usize + 1)
		&& op.code == Opcode::Spawn
		&& let Some(s) = unit.spawns.get(op.a as usize)
		&& s.kind == SpawnKind::Subshell
		&& (zsh || ends_stage(unit, end.unwrap_or(s.end + 1)))
	{
		return 0;
	}
	if code(start) == Some(Opcode::Exec) && !background {
		return u32::from(zsh);
	}
	1
}

/// Whether only its pipeline's `!` and a job's `time` (`Not`, `TimeEnd`)
/// come between `at`, just past a stage's first command, and the stage's
/// `SubExit`: that command is the stage's whole command, not the first of
/// an and-or list (`{ :; } 2>"$w" && : &`, a list bash forks whole).
fn ends_stage(unit: &Unit, mut at: u32) -> bool {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	for wrap in [Opcode::Not, Opcode::TimeEnd] {
		if code(at) == Some(wrap) {
			at += 1;
		}
	}
	code(at) == Some(Opcode::SubExit)
}

/// bash's `execute_subshell_builtin_or_function`: a forked pipeline
/// element that runs a builtin or a function is one subshell level down
/// once its words are expanded (at the parent's level, [`stage_level`]),
/// so a function, `eval`, `.` or a builtin's callback sees one more than
/// its parent's `$BASH_SUBSHELL`. Not for an element of an async pipeline,
/// which bash forks as an async command, counted at the fork
/// ([`async_pipeline`]). Called as the element's own simple command (the
/// vproc's only frame) starts a builtin or function.
pub fn raise_element_level(vp: &mut Vproc) {
	if vp.frames.len() != 1 || vp.parent.is_none() || vp.mode.dialect() != Dialect::Bash {
		return;
	}
	let f = &vp.frames[0];
	let Some(unit) = f.unit.as_deref() else {
		return;
	};
	let Some(si) = simple_stage(unit, f.pc) else {
		return;
	};
	if unit.spawns[si].kind == SpawnKind::Pipeline && !async_pipeline(unit, si) {
		let depth = super::subshell_depth(vp) + 1;
		super::set_subshell_depth(vp, depth);
	}
}

/// The spawn whose stage's own simple command is the op at `pc`: the op
/// before the stage's closing `SubExit`, after its words' substitution
/// bodies and a redirection ([`stage_command`]). `None` for an op in a
/// substitution's body (which ends at a `SubExit` of its own) or in a
/// compound stage.
///
/// The stage needs no end test: only a simple command lowers to an `Exec`
/// (a compound's first op is `Enter`, `Spawn`, `FuncDef` or `CallAnon`),
/// and its `Exec` is its last op. So when a stage's own command is the
/// `Exec` at `pc` and a `SubExit` follows it, that `SubExit` is the
/// stage's: the stage ends at `pc + 2`.
fn simple_stage(unit: &Unit, pc: u32) -> Option<usize> {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	if code(pc) != Some(Opcode::Exec) || code(pc + 1) != Some(Opcode::SubExit) {
		return None;
	}
	unit.spawns.iter().position(|s| {
		s.stages
			.iter()
			.any(|st| stage_command(unit, st.entry) == pc)
	})
}

/// The op of the stage starting at `entry` that runs its own command: past
/// its words' substitution bodies ([`skip_blocks`]) and a redirection.
fn stage_command(unit: &Unit, entry: u32) -> u32 {
	let at = skip_blocks(unit, entry);
	if unit
		.ops
		.get(at as usize)
		.is_some_and(|op| op.code == Opcode::Redir)
	{
		at + 1
	} else {
		at
	}
}

/// Whether pipeline spawn `si` is the whole body of a background job
/// (with or without `!`, [`bash_job_keeps`]): bash runs it as an async
/// pipeline and zsh forks it element by element, so the job's own fork
/// stands for each element's and every element, a compound or `( … )` one
/// too, sits at the job's subshell level.
fn async_pipeline(unit: &Unit, si: usize) -> bool {
	let Some(s) = unit.spawns.get(si) else {
		return false;
	};
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let after = if code(s.end) == Some(Opcode::Not) {
		s.end + 1
	} else {
		s.end
	};
	code(after) == Some(Opcode::SubExit)
		&& unit.spawns.iter().any(|b| {
			b.kind == SpawnKind::Background
				&& b.stages.first().is_some_and(|st| {
					unit
						.ops
						.get(skip_blocks(unit, st.entry) as usize)
						.is_some_and(|op| op.code == Opcode::Spawn && op.a as usize == si)
				})
		})
}

/// Whether the subshell `Spawn` at `at` is the `( … )` that an element of
/// an async pipeline runs as its own command ([`async_pipeline`]): forked
/// once, as the element.
fn async_element_subshell(unit: &Unit, at: u32) -> bool {
	at > 0
		&& unit
			.ops
			.get(at as usize - 1)
			.is_some_and(|op| op.code == Opcode::Enter)
		&& unit.spawns.iter().enumerate().any(|(si, s)| {
			s.kind == SpawnKind::Pipeline
				&& s
					.stages
					.iter()
					.any(|st| stage_command(unit, st.entry) + 1 == at)
				&& async_pipeline(unit, si)
		})
}

/// Whether the `( … )` whose `Spawn` is at `pc` is the last stage of a
/// pipeline that is a background job's whole command ([`job_pipeline`]):
/// its stage starts there, past a redirection and the `Enter`
/// ([`stage_level`]'s shape).
fn job_last_stage(unit: &Unit, pc: u32) -> bool {
	let starts_at = |entry: u32| {
		let op = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
		let enter = if op(entry) == Some(Opcode::Redir) {
			entry + 1
		} else {
			entry
		};
		op(enter) == Some(Opcode::Enter) && enter + 1 == pc
	};
	unit.ops.iter().enumerate().any(|(at, op)| {
		op.code == Opcode::Spawn
			&& unit.spawns.get(op.a as usize).is_some_and(|s| {
				s.kind == SpawnKind::Pipeline && s.stages.last().is_some_and(|st| starts_at(st.entry))
			})
			&& u32::try_from(at).is_ok_and(|at| job_pipeline(unit, at))
	})
}

/// Whether the background job whose body starts at `entry` may be known by
/// its program's OS pid ([`Bang`]): its body is one simple command
/// ([`BangStage::Lone`]), a group that `exec`s one (`{ exec cmd; }`,
/// [`BangStage::Exec`]), or a pipeline, whose last stage decides
/// ([`BangStage::Pipeline`], [`retarget_bang`]). Any other compound job
/// keeps its virtual pid at once: its readers never wait. The command's
/// words' substitution bodies come before its `Exec` ([`skip_blocks`]).
fn bang_stage(unit: &Unit, entry: u32) -> Option<BangStage> {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	if simple_body(unit, skip_blocks(unit, entry)) {
		return Some(BangStage::Lone);
	}
	if body_pipeline(unit, entry).is_some() {
		return Some(BangStage::Pipeline);
	}
	let at = skip_blocks(unit, entry + 1);
	let group = code(entry) == Some(Opcode::Enter)
		&& [Opcode::Exec, Opcode::Leave, Opcode::SubExit]
			.iter()
			.zip(at..)
			.all(|(&want, at)| code(at) == Some(want));
	let exec = unit
		.ops
		.get(at as usize)
		.and_then(|op| unit.cmds.get(op.a as usize))
		.and_then(|cmd| unit.lists.get(cmd.words as usize))
		.and_then(|words| words.first())
		.and_then(|&w| unit.words.get(w as usize))
		.is_some_and(
			|w| matches!(w.parts.as_slice(), [ir::Part::Lit(name)] if name.as_slice() == b"exec"),
		);
	(group && exec).then_some(BangStage::Exec)
}

/// A stage whose body is one simple command: an `Exec`, then the stage's
/// end.
fn simple_body(unit: &Unit, entry: u32) -> bool {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	code(entry) == Some(Opcode::Exec) && code(entry + 1) == Some(Opcode::SubExit)
}

/// A background job's body that is one simple command, maybe negated
/// (`cmd &`, `! cmd &`): past its words' substitution bodies
/// ([`skip_blocks`]), an `Exec`, `[Not]`, then the job's end. bash runs its
/// DEBUG trap in the shell before it forks.
fn lone_simple(unit: &Unit, entry: u32) -> bool {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let at = skip_blocks(unit, entry);
	code(at) == Some(Opcode::Exec)
		&& match code(at + 1) {
			Some(Opcode::SubExit) => true,
			Some(Opcode::Not) => code(at + 2) == Some(Opcode::SubExit),
			_ => false,
		}
}

/// The pipeline spawn (its index in [`Unit::spawns`]) a job body starting
/// at `entry` is: `time` and `!` wrap it as `[TimeStart] Spawn …
/// [Not] [TimeEnd]`, then the job's `SubExit`.
fn body_pipeline(unit: &Unit, entry: u32) -> Option<usize> {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let at = if code(entry) == Some(Opcode::TimeStart) {
		entry + 1
	} else {
		entry
	};
	let op = unit
		.ops
		.get(at as usize)
		.filter(|op| op.code == Opcode::Spawn)?;
	let spawn = unit
		.spawns
		.get(op.a as usize)
		.filter(|s| s.kind == SpawnKind::Pipeline)?;
	let mut end = spawn.end;
	for wrap in [Opcode::Not, Opcode::TimeEnd] {
		if code(end) == Some(wrap) {
			end += 1;
		}
	}
	(code(end) == Some(Opcode::SubExit)).then_some(op.a as usize)
}

/// The entries of the simple commands whose DEBUG trap bash runs in the
/// shell before spawn `op` forks, and whether they are a lone background
/// command's (one whose failing trap skips the whole job under
/// `extdebug`): a background job's lone command (`cmd &`, `! cmd &`), or
/// each simple stage of a pipeline, also of the pipeline a background job
/// is. bash forks a `time`d job first (`time a | b &`), and the job runs
/// those traps itself under `set -T`, as a `time`d pipeline in it does. A
/// stage's words' substitution bodies come before its `Exec`
/// ([`skip_blocks`]), whose command the trap is for.
fn debug_stage_entries(unit: &Unit, op: Op) -> (Vec<u32>, bool) {
	let simple = |spawn: usize| -> Vec<u32> {
		unit.spawns[spawn]
			.stages
			.iter()
			.map(|s| s.entry)
			.filter(|&entry| simple_body(unit, skip_blocks(unit, entry)))
			.collect()
	};
	let info = &unit.spawns[op.a as usize];
	match info.kind {
		SpawnKind::Background => {
			let entry = info.stages[0].entry;
			let timed = unit
				.ops
				.get(entry as usize)
				.is_some_and(|o| o.code == Opcode::TimeStart);
			if lone_simple(unit, entry) {
				(vec![entry], true)
			} else if timed {
				(Vec::new(), false)
			} else {
				(body_pipeline(unit, entry).map_or_else(Vec::new, simple), false)
			}
		},
		SpawnKind::Pipeline => (simple(op.a as usize), false),
		_ => (Vec::new(), false),
	}
}

/// [`debug_stage_entries`] the shell runs now: none for the pipeline a
/// background job is, whose traps the shell ran before it forked the job
/// ([`shell_ran_stage_traps`]).
fn shell_debug_stages(k: &Kernel, vp: &Vproc, unit: &Unit, op: Op, pc: u32) -> Vec<u32> {
	if shell_ran_stage_traps(k, vp, unit, op, pc) {
		return Vec::new();
	}
	debug_stage_entries(unit, op).0
}

/// Whether this `Spawn` is the pipeline a background job is, whose stage
/// traps the shell ran before it forked the job (its [`Bang`] still waits
/// on the pipeline), unless the job forked first for its `time` (the
/// `TimeStart` before `pc`). Such a job carries the skip list the shell
/// recorded for it ([`DebugSkip`]).
fn shell_ran_stage_traps(k: &Kernel, vp: &Vproc, unit: &Unit, op: Op, pc: u32) -> bool {
	let info = &unit.spawns[op.a as usize];
	let timed = pc
		.checked_sub(1)
		.and_then(|at| unit.ops.get(at as usize))
		.is_some_and(|o| o.code == Opcode::TimeStart);
	info.kind == SpawnKind::Pipeline
		&& !timed
		&& k
			.bangs
			.iter()
			.any(|b| b.vproc == vp.vpid && b.stage == BangStage::Pipeline)
}

/// The shell ran the DEBUG trap of the simple command a child starts with
/// at `entry` ([`shell_debug_stages`]): the child does not run it again at
/// its `Exec`. It starts there, past the jumps over its words' substitution
/// bodies ([`skip_blocks`]), which do nothing else and would drop the mark
/// (any op that goes on does). In zsh mode the mark is never read: only
/// bash's trap points (a command, a `Spawn`) compare `debug_pc` with an
/// `Exec`'s pc, and zsh's trap runs at its list markers (`Nop`), which
/// `lone_simple`'s `entry` never is.
fn mark_debug_done(unit: &Unit, frames: &mut [Frame], entry: u32) {
	if lone_simple(unit, entry)
		&& let Some(frame) = frames.last_mut()
	{
		let exec = skip_blocks(unit, entry);
		frame.pc = exec;
		frame.debug_pc = Some(exec);
	}
}

/// Whether the pipeline `Spawn` at `pc` is the whole command of a
/// background job (`a | b &`): bash runs that pipeline as the job
/// (`execute_pipeline`'s `asynchronous`), so its stages are the job's
/// processes ([`crate::bash::store::Job::procs`]). bash runs one of an `&&`
/// or `||` list, or one under `time`, in a subshell of its own; obash's
/// `!` follows the spawn (`Not`), so it counts none under `!` either.
pub(super) fn job_pipeline(unit: &Unit, pc: u32) -> bool {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	unit.ops.get(pc as usize).is_some_and(|op| {
		op.code == Opcode::Spawn
			&& unit
				.spawns
				.get(op.a as usize)
				.is_some_and(|s| s.kind == SpawnKind::Pipeline && code(s.end) == Some(Opcode::SubExit))
	}) && unit
		.spawns
		.iter()
		.any(|s| s.kind == SpawnKind::Background && s.stages.first().is_some_and(|st| st.entry == pc))
}

/// The processes of the background job of vproc `job` whose command starts
/// at `entry`, if that command is a pipeline ([`job_pipeline`]): bash forks
/// each stage as it starts the job, with the job's status taken under
/// `pipefail` then (`stop_pipeline`'s `J_PIPEFAIL`). When every stage vpid
/// fits, each gets one now, which its stage's vproc takes when the job's
/// vproc starts the stages ([`Kernel::stage_vpids`]); otherwise the child's
/// pipeline fork fails before it starts any stage, as the vpid check in
/// [`spawn`] makes it, and each remains named by the job's vproc. None for a
/// zsh job whose vproc runs the last stage itself (`last1`, outside sh
/// emulation, as [`spawn`] decides `lastpipe`).
fn pipeline_job(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	unit: &Unit,
	entry: u32,
	job: Vpid,
) -> Option<JobProcs> {
	let s = job_stage_spawn(vp, unit, entry)?;
	let reserve = u32::try_from(s.stages.len()).is_ok_and(|n| k.vpids_left() >= n);
	let vpids: Vec<Vpid> = if reserve {
		(0..s.stages.len()).map(|_| k.vpid(cx.store)).collect()
	} else {
		Vec::new()
	};
	let list = (0..s.stages.len())
		.map(|i| {
			let vpid = vpids.get(i).copied().unwrap_or(job);
			JobProc::started(vpid, super::killed::stage_command(k, cx, vp, unit, s, i))
		})
		.collect();
	if reserve {
		k.stage_vpids.push((job, vpids));
	}
	let pipefail = state::option(&mut k.root, cx.store, vp, OptId::Pipefail).unwrap_or(false);
	Some(JobProcs { list, pipefail })
}

/// The pipeline that is the whole command of the background job whose
/// command starts at `entry` ([`job_pipeline`]), whose stages
/// [`pipeline_job`] makes the job's processes; none for a zsh job whose
/// vproc runs the last stage itself (`last1`, outside sh emulation, as
/// [`spawn`] decides `lastpipe`).
fn job_stage_spawn<'u>(vp: &Vproc, unit: &'u Unit, entry: u32) -> Option<&'u ir::SpawnIr> {
	if !job_pipeline(unit, entry)
		|| (unit.mode.dialect() == Dialect::Zsh && vp.mode != ModeId::ZshSh)
	{
		return None;
	}
	unit.spawns.get(unit.ops.get(entry as usize)?.a as usize)
}

/// Whether the pipeline `vp` starts is the whole command of its background
/// job ([`job_pipeline`]), whose stages got their vpids as the job started
/// ([`pipeline_job`], [`Kernel::stage_vpids`]).
fn has_stage_vpids(k: &Kernel, vp: &Vproc, unit: &Unit) -> bool {
	vp.parent.is_some()
		&& vp.frames.last().is_some_and(|f| job_pipeline(unit, f.pc))
		&& k.stage_vpids.iter().any(|(job, _)| *job == vp.vpid)
}

/// The job bash makes of the forked stages `children` of the pipeline
/// `info` of `unit` that the shell waits for
/// ([`super::killed::foreground_job`]): its processes, each named by its vproc
/// with its command, the job's text theirs joined as bash prints them
/// (`print_pipeline`), its status taken under the `pipefail` on now
/// (`J_PIPEFAIL`). A `lastpipe` pipeline's job has the stages before the one
/// the shell runs.
fn pipeline_foreground_job(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	unit: &Unit,
	info: &ir::SpawnIr,
	children: &[Vpid],
) {
	let Some(&first) = children.first() else {
		return;
	};
	let list: Vec<JobProc> = children
		.iter()
		.enumerate()
		.map(|(i, &v)| JobProc::started(v, super::killed::stage_command(k, cx, vp, unit, info, i)))
		.collect();
	let text = BString::from(
		list
			.iter()
			.map(|p| p.text.as_slice())
			.collect::<Vec<_>>()
			.join(&b" | "[..]),
	);
	let pipefail = state::option(&mut k.root, cx.store, vp, OptId::Pipefail).unwrap_or(false);
	let id = k.job_id(cx.store);
	super::killed::foreground_job(vp, id, first, text, Some(JobProcs { list, pipefail }));
}

/// Whether the `( … )` that `info` spawns at `pc` is the whole body of a
/// background job (`( … ) &`): zsh runs that as one process, whose
/// `entersubsh` ran with the job's, so its traps are not unset again (they
/// hold the job's ignored `INT` and `QUIT` where it has no job control).
fn async_subshell_body(unit: &Unit, pc: u32, info: &crate::bash::ir::SpawnIr) -> bool {
	if info.kind != SpawnKind::Subshell {
		return false;
	}
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	let end = info.end + u32::from(code(info.end) == Some(Opcode::Leave));
	code(end) == Some(Opcode::SubExit)
		&& unit.spawns.iter().any(|s| {
			s.kind == SpawnKind::Background
				&& end + 1 == s.end
				&& s.stages.first().is_some_and(|st| {
					st.entry <= pc
						&& unit.ops[st.entry as usize..pc as usize]
							.iter()
							.all(|op| matches!(op.code, Opcode::Nop | Opcode::Enter))
				})
		})
}

/// The pipeline a background job's body is ([`BangStage::Pipeline`])
/// started `stages` (`(vproc, entry)`; the last one a child, or the job's
/// own vproc under `lastpipe`): its last stage decides the job's pid as a
/// job body of its own would (bash and zsh name the last process in `$!`).
/// While the job's `[n] pid…` line waits, every earlier stage decides the
/// pid that line shows for it the same way (zsh names each process). The
/// signals `kill` held for the job ([`Bang::held`]) are each stage's
/// before it runs, as each of bash's forks has them: one that decides
/// takes them at its decision, any other at once; under `lastpipe` the
/// job's own vproc takes them for all at its decision.
fn retarget_bang(k: &mut Kernel, job_vproc: Vpid, unit: &Unit, stages: &[(Vpid, u32)]) {
	let Some(i) = k
		.bangs
		.iter()
		.position(|b| b.vproc == job_vproc && b.stage == BangStage::Pipeline)
	else {
		return;
	};
	let Some(&(last, last_entry)) = stages.last() else {
		return;
	};
	let lone = |entry: u32| bang_stage(unit, entry).filter(|s| *s != BangStage::Pipeline);
	let announcing = super::jobctl::announcing(k, job_vproc);
	let held = if last == job_vproc {
		SigSet::EMPTY
	} else {
		k.bangs[i].held
	};
	if announcing || held != SigSet::EMPTY {
		let mut pids = Vec::with_capacity(stages.len());
		for &(stage, entry) in stages {
			let decides = lone(entry);
			if stage != last {
				if let Some(kind) = decides {
					k.bangs
						.push(Bang { vproc: stage, job: stage, stage: kind, held });
				} else {
					send_held(k, stage, held);
				}
			}
			pids.push((stage, decides.is_some()));
		}
		if announcing {
			super::jobctl::pipeline_started(k, job_vproc, &pids);
		}
	}
	if let Some(stage) = lone(last_entry) {
		let bang = &mut k.bangs[i];
		bang.vproc = last;
		bang.stage = stage;
	} else {
		if last != job_vproc {
			let held = std::mem::take(&mut k.bangs[i].held);
			send_held(k, last, held);
		}
		k.settle_bang(job_vproc, None);
	}
}

/// Queue the signals `held` for vproc `stage` alone (a stage of a job's
/// pipeline that has not run yet, [`retarget_bang`]).
fn send_held(k: &Kernel, stage: Vpid, held: SigSet) {
	for sig in held.iter() {
		super::ControlHandle(k.ctl.clone()).signal(crate::bash::SigTarget::Vpid(stage), sig);
	}
}

/// Source text of stage `i` of pipeline `info`, for a pipe tap: the node of
/// the `SubExit` that ends the stage's code (just before the next stage's
/// entry, or before the pipeline's end).
fn stage_text(unit: &Unit, info: &ir::SpawnIr, i: usize) -> BString {
	let end = info.stages.get(i + 1).map_or(info.end, |next| next.entry);
	end.checked_sub(1)
		.and_then(|pc| unit.ops.get(pc as usize))
		.filter(|op| op.code == Opcode::SubExit)
		.map_or_else(BString::default, |op| node_text(unit, op.node))
}

/// `Spawn`: start children; wait for subshells and pipelines.
fn spawn(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Arc<Unit>, op: Op) -> Flow {
	let info = &unit.spawns[op.a as usize];
	let started = top_frame(vp)
		.scratch
		.as_ref()
		.is_some_and(|s| !s.children.is_empty());
	if !started {
		// A job that forks (a subshell, pipeline, job or coprocess of its
		// own) before it decides its pid takes the signals `kill` held for
		// it first, known by its virtual pid ([`Kernel::take_held`]): bash's
		// child had them before it forked. The pipeline a job's body is
		// passes the decision to its last stage ([`retarget_bang`]).
		let own_pipeline = info.kind == SpawnKind::Pipeline
			&& k
				.bangs
				.iter()
				.any(|b| b.vproc == vp.vpid && b.stage == BangStage::Pipeline);
		if !k.bangs.is_empty() && !own_pipeline && k.take_held(vp.vpid) {
			return Flow::Block(WaitKey::Signal);
		}
		// Every child it starts needs a vpid: none is built unless all fit
		// (a pipeline counts each stage but one run in the shell itself).
		let here = info.kind == SpawnKind::Pipeline && last_stage_here(k, cx, vp, unit);
		let needed = match info.kind {
			SpawnKind::Pipeline if has_stage_vpids(k, vp, unit) => 0,
			_ => info.stages.len() - usize::from(here),
		};
		let needed = u32::try_from(needed).unwrap_or(u32::MAX);
		if let Some(flow) = fork_failed(k, vp, cx, needed, line_of(vp, op.node)) {
			return flow;
		}
		let mut children = Vec::with_capacity(info.stages.len());
		// bash's `stop_pipeline` (each fork it makes a job of) first deletes
		// the finished jobs reported (`jobs.c:572`); for a `lastpipe`
		// pipeline it runs with the job list frozen (`execute_pipeline`),
		// deleting none.
		if info.kind != SpawnKind::Pipeline {
			super::killed::cleanup_dead_jobs(vp);
		}
		match info.kind {
			SpawnKind::Subshell | SpawnKind::Background => {
				// `extdebug` skipped every stage of the pipeline a background job
				// is: no job, status 0, `$!` and `PIPESTATUS` as they were (bash).
				let skip = if info.kind == SpawnKind::Background {
					take_debug_skip(k, vp)
				} else {
					None
				};
				if skip
					.as_deref()
					.is_some_and(|s| skips_whole_pipeline(unit, info.stages[0].entry, s))
				{
					vp.status = 0;
					return Flow::Jump(info.end);
				}
				let mut fds = vp.fds.clone();
				let control = info.kind == SpawnKind::Background && job_control(k, cx, vp);
				// An async command reads `/dev/null` without job control, unless
				// an enclosing compound command redirected stdin (bash
				// `stdin_redir`, `CMD_STDIN_REDIR`)…
				// …or the shell runs as a pipeline element reading a pipe.
				let piped = vp.fds.get(0).is_some_and(|h| {
					h.origin() == crate::bash::fd::FdOrigin::Mem
						&& h.kind() == Some(crate::bash::fs::FileKind::Pipe)
				});
				if info.kind == SpawnKind::Background
					&& !control
					&& !piped
					&& !vp
						.frames
						.iter()
						.any(|f| f.redirs.iter().flat_map(|r| &r.fds).any(|s| s.fd == 0))
				{
					let null = k
						.null_input
						.get_or_insert_with(|| FdRef::mem(mem::MemBuf::new(Vec::new())));
					fds.set(0, Some(null.clone()));
				}
				// zsh's last `( … )` runs without a fork: the shell's process
				// is the subshell's, and its last command in turn the
				// subshell's ([`super::proc::VprocZsh::in_place`]).
				let in_place = info.kind == SpawnKind::Subshell
					&& vp.mode.dialect() == Dialect::Zsh
					&& super::killed::in_place(k, cx, vp, op);
				let mut child = vp.child(k, cx.store, Arc::clone(unit), info.stages[0].entry, fds);
				child.exit_trap_due = info.stages[0].exit_trap;
				let keeps =
					info.kind == SpawnKind::Background && bash_job_keeps(unit, info.stages[0].entry);
				child.outer_loops = fork_loops(vp, keeps);
				// The shell ran a background simple command's DEBUG trap, or
				// the traps of the pipeline the job is: under `extdebug` the
				// job's pipeline skips the stages whose trap failed.
				if info.kind == SpawnKind::Background {
					mark_debug_done(unit, &mut child.frames, info.stages[0].entry);
					if let Some(entries) = skip {
						let frame = child.frames.len().saturating_sub(1) as u32;
						k.debug_skips
							.push(DebugSkip { vproc: child.vpid, frame, entries });
					}
					forked_for(&mut child, vp, unit, info.stages[0].entry);
				}
				// bash forks a background pipeline's stages from the shell itself,
				// so a stage that expands its words sees the shell's job list
				// ([`super::proc::JobTable::stage_words`]). The job's vproc stands
				// between them here: it holds copies (which it neither reports
				// nor waits for) only to hand them to such a stage.
				if info.kind == SpawnKind::Background
					&& vp.mode.dialect() == Dialect::Bash
					&& !vp.jobs.is_empty()
					&& job_pipeline(unit, info.stages[0].entry)
				{
					let comsub = child.jobs.comsub;
					child.jobs = inherited_jobs(vp, true);
					child.jobs.comsub = comsub;
				}
				if in_place {
					child.zsh_state().in_place = true;
				}
				// zsh's job process runs its pipeline's last stage itself
				// (`last1`), and a `( … )` there runs in that process without a
				// fork: no level of its own (`true | ( echo $ZSH_SUBSHELL ) &`
				// prints 1, zsh 5.9).
				if info.kind == SpawnKind::Subshell
					&& vp.mode.dialect() == Dialect::Zsh
					&& vp.mode != ModeId::ZshSh
					&& vp.parent.is_some()
					&& job_last_stage(unit, top_frame(vp).pc)
				{
					super::set_subshell_depth(&mut child, super::subshell_depth(vp));
				}
				if child.mode.dialect() != Dialect::Zsh
					|| !async_subshell_body(unit, top_frame(vp).pc, info)
				{
					zsh_subshell_traps(k, cx, &mut child, false);
				}
				if info.kind == SpawnKind::Background && !control {
					ignore_async_signals(k, cx, &mut child);
				}
				// The `( … )` of an async pipeline's element: bash and zsh fork
				// it once, as the element ([`async_element_subshell`]).
				if info.kind == SpawnKind::Subshell && async_element_subshell(unit, top_frame(vp).pc) {
					super::set_subshell_depth(&mut child, super::subshell_depth(vp));
				}
				if info.kind == SpawnKind::Background {
					let zsh = unit.mode.dialect() == Dialect::Zsh;
					let level = stage_level(unit, info.stages[0].entry, true, zsh);
					super::set_subshell_depth(&mut child, super::subshell_depth(vp) + level);
					// A job of its own: its processes get their own group.
					super::jobctl::own_job(k, child.vpid);
				} else {
					k.bang_kin_add(vp.vpid, child.vpid);
				}
				// The `{var}`s of a subshell's own redirections are its fork's:
				// the child has them in the snapshot it starts from
				// (`state::fork_image`), the shell keeps none (below).
				let fork_vars = if info.kind == SpawnKind::Subshell {
					top_frame(vp).redirs.last_mut().and_then(|r| r.vars.take())
				} else {
					None
				};
				children.push(child.vpid);
				let vpid = child.vpid;
				k.spawned.push(Box::new(child));
				// The `( … )` the shell waits for is a job too, one that outlives
				// the wait while no job may be deleted.
				if info.kind == SpawnKind::Subshell && super::killed::keeps_foreground(vp) {
					let text = job_text(k, cx, vp, unit, op.node);
					let id = k.job_id(cx.store);
					super::killed::foreground_job(vp, id, vpid, text, None);
				}
				if info.kind == SpawnKind::Background {
					vp.last_bg = LastBg::new(vpid);
					// Known by its program's OS pid if the first command it runs
					// spawns it (bash's subshell `exec`s a lone simple command):
					// readers of the pid wait for that decision.
					if let Some(stage) = bang_stage(unit, info.stages[0].entry) {
						k.bangs
							.push(Bang { vproc: vpid, job: vpid, stage, held: SigSet::EMPTY });
					}
					let job = k.job_id(cx.store);
					// zsh `&|` / `&!`: disowned at once (no job entry).
					if op.flags & Op::DISOWN == 0 {
						let text = job_text(k, cx, vp, unit, op.node);
						let cwd = vp.cwd.clone();
						let procs = pipeline_job(k, cx, vp, unit, info.stages[0].entry, vpid);
						let number = vp.jobs.add(job, vpid, text, control, cwd);
						if let (Some(procs), Some(entry)) = (procs, vp.jobs.get_mut(number)) {
							entry.procs = Some(Box::new(procs));
						}
						if vp.parent.is_none() {
							super::jobctl::started(k, cx, vpid, number);
						}
					}
					k.emit_op(cx, vp, op.node, EventData::Background { job, pid: vpid });
					vp.status = 0;
					return Flow::Jump(info.end);
				}
				if let Some(vars) = fork_vars {
					redir::forget_vars(k, vp, cx, *vars);
				}
				k.emit_op(cx, vp, op.node, EventData::Subshell { child: vpid });
			},
			SpawnKind::Coproc { name } => {
				let name = unit.names[name as usize].clone();
				start_coproc(k, vp, cx, unit, op, info.stages[0].entry, name);
				return Flow::Jump(info.end);
			},
			SpawnKind::Pipeline => {
				let n = info.stages.len();
				let tap = cx.host.pipe_tap();
				// bash runs no stage of the pipeline a background job's vproc runs
				// as the job here ([`last_stage_here`]); it forks the others
				// (`stop_pipeline` first deletes the finished jobs reported).
				let lastpipe = last_stage_here(k, cx, vp, unit);
				// The pipeline a background job's vproc runs as the job: each
				// stage is a process of the job. Their vpids, reserved as the
				// job started ([`pipeline_job`]).
				let job_stages = vp.parent.is_some() && job_pipeline(unit, top_frame(vp).pc);
				let reserved = if job_stages {
					k.take_stage_vpids(vp.vpid)
				} else {
					Vec::new()
				};
				if !lastpipe {
					super::killed::cleanup_dead_jobs(vp);
				}
				// The pipeline a background job's vproc runs as the job: each
				// stage is a process of the job, which is no foreground job.
				let job_stages = vp.parent.is_some() && job_pipeline(unit, top_frame(vp).pc);
				let mut stdin = vp.fds.get(0).cloned();
				// An async pipeline's elements sit at the job's level.
				let async_elements = async_pipeline(unit, op.a as usize);
				let zsh = unit.mode.dialect() == Dialect::Zsh;
				// `extdebug`: a stage whose DEBUG trap failed in the shell is not
				// started, as bash forks no process for it: its input closes,
				// the next stage reads end of input, and `PIPESTATUS` has no
				// entry for it.
				let skip = take_debug_skip(k, vp);
				let skipped = |entry: u32| skip.as_ref().is_some_and(|s| s.contains(&entry));
				// The entry of each child's stage, for [`retarget_bang`].
				let mut entries = Vec::with_capacity(n);
				for (i, stage) in info.stages.iter().enumerate() {
					let skip_stage = unit.mode.dialect() == Dialect::Bash && skipped(stage.entry);
					if lastpipe && i + 1 == n && !skip_stage {
						if !k.bangs.is_empty() {
							let stages: Vec<(Vpid, u32)> = children
								.iter()
								.copied()
								.zip(entries.iter().copied())
								.chain([(vp.vpid, stage.entry)])
								.collect();
							retarget_bang(k, vp.vpid, unit, &stages);
						}
						// bash freezes the job list, then makes the forked stages a
						// job (`execute_pipeline`'s `freeze_jobs_list (1)` and
						// `stop_pipeline`): it outlives the pipeline.
						if vp.mode.dialect() == Dialect::Bash {
							pipeline_foreground_job(k, cx, vp, unit, info, &children);
						}
						k.emit_op(cx, vp, op.node, EventData::Pipeline { stages: &children });
						let line_shift = top_frame(vp).line_shift;
						let sc = scratch(vp);
						sc.children = children.into_iter().map(|v| (v, None)).collect();
						sc.pipeline().inline = Some(InlineStage::Running);
						let mut frame = Frame::new(Some(Arc::clone(unit)), stage.entry, FrameKind::Stage);
						// As [`mark_debug_done`]: at its `Exec`, past the jumps
						// over its words' substitution bodies.
						let exec = skip_blocks(unit, stage.entry);
						if unit.mode.dialect() == Dialect::Bash && simple_body(unit, exec) {
							frame.pc = exec;
							frame.debug_pc = Some(exec);
						}
						frame.line_shift = line_shift;
						let prev = vp.fds.get(0).cloned();
						vp.fds.set(0, stdin.take());
						frame.redirs.push(vec![Saved { fd: 0, prev }].into());
						vp.frames.push(frame);
						return Flow::Call;
					}
					let mut fds = vp.fds.clone();
					fds.set(0, stdin.take());
					if i + 1 < n {
						let mirror = tap.as_ref().and_then(|tap| {
							let producer = stage_text(unit, info, i);
							let consumer = stage_text(unit, info, i + 1);
							tap.open(BStr::new(&producer), BStr::new(&consumer))
						});
						let (r, w) = match mirror {
							Some(mirror) => mem::tapped_pipe(mirror),
							None => mem::pipe(),
						};
						let w = FdRef::mem(w);
						fds.set(1, Some(w.clone()));
						if stage.pipe_stderr {
							fds.set(2, Some(w));
						}
						stdin = Some(FdRef::mem(r));
					}
					if skip_stage {
						// Dropping `fds` closes this stage's ends of its pipes.
						continue;
					}
					let vpid = reserved.get(i).copied();
					let mut child = vp.child_as(k, cx.store, Arc::clone(unit), stage.entry, fds, vpid);
					child.exit_trap_due = stage.exit_trap;
					zsh_subshell_traps(k, cx, &mut child, true);
					// The shell ran a simple stage's DEBUG trap.
					mark_debug_done(unit, &mut child.frames, stage.entry);
					// bash keeps the loop level in a simple command it forks
					// (its words' substitution bodies come first).
					let simple = unit
						.ops
						.get(skip_blocks(unit, stage.entry) as usize)
						.is_some_and(|op| op.code == Opcode::Exec);
					child.outer_loops = fork_loops(vp, simple);
					forked_for(&mut child, vp, unit, stage.entry);
					let level = if async_elements {
						0
					} else {
						stage_level(unit, stage.entry, false, zsh)
					};
					super::set_subshell_depth(&mut child, super::subshell_depth(vp) + level);
					// bash forks a simple command's stage first and expands its
					// words in the child, which keeps the shell's job list until
					// it runs its command (`echo "$(jobs)" | cat`, `jobs -p |
					// xargs kill`; [`super::proc::JobTable::stage_words`]). Only
					// a substitution in its words or redirections, or the `jobs`
					// builtin itself (also by a name its expansion gives), can
					// read the list, so only such a stage gets a copy. zsh keeps
					// it only for a `jobs` builtin.
					let bash = vp.mode.dialect() == Dialect::Bash;
					if !vp.jobs.is_empty()
						&& (runs_jobs(unit, stage.entry) || bash && substituting_stage(unit, stage.entry))
					{
						child.jobs = inherited_jobs(vp, true);
						child.jobs.stage_words = bash;
					}
					k.bang_kin_add(vp.vpid, child.vpid);
					children.push(child.vpid);
					entries.push(stage.entry);
					k.spawned.push(Box::new(child));
				}
				if !job_stages && super::killed::keeps_foreground(vp) {
					pipeline_foreground_job(k, cx, vp, unit, info, &children);
				}
				if !k.bangs.is_empty() {
					let stages: Vec<(Vpid, u32)> = children
						.iter()
						.copied()
						.zip(entries.iter().copied())
						.collect();
					retarget_bang(k, vp.vpid, unit, &stages);
				}
				k.emit_op(cx, vp, op.node, EventData::Pipeline { stages: &children });
			},
		}
		// A pipeline's stages are the processes of the job the shell waits
		// for, of which a notice names each; those of a background job's
		// pipeline are that job's ([`pipeline_job`]).
		let waits = info.kind == SpawnKind::Pipeline
			&& !(vp.parent.is_some() && job_pipeline(unit, top_frame(vp).pc));
		let sc = scratch(vp);
		if waits {
			let started = children
				.iter()
				.map(|&v| JobProc::started(v, BString::default()));
			sc.pipeline().procs.list.extend(started);
		}
		sc.children = children.into_iter().map(|v| (v, None)).collect();
		super::wait_starts(k, cx, vp);
	}
	let status = vp.status;
	let sc = scratch(vp);
	if sc.inline() == Some(InlineStage::Running) {
		// Back from the last stage's frame.
		sc.pipeline().inline = Some(InlineStage::Done(status));
		// bash appends the stage to the pipeline's job, named by the last
		// command it ran ([`super::proc::JobTable::lastpipe_stage_ended`]).
		if let Some(first) = sc.children.first().map(|&(v, _)| v) {
			let text = BString::from(vp.command_text());
			let platform = k.engine.config().platform;
			vp.jobs
				.lastpipe_stage_ended(first, vp.vpid, text, status, platform);
		}
	}
	let sc = scratch(vp);
	for (vpid, status) in &mut sc.children {
		if status.is_none() {
			*status = k.proc_collect(cx.store, *vpid);
		}
	}
	if let Some((vpid, _)) = sc.children.iter().find(|(_, s)| s.is_none()) {
		return Flow::Block(WaitKey::Proc(*vpid));
	}
	let pipefail = state::option(&mut k.root, cx.store, vp, OptId::Pipefail).unwrap_or(false);
	let sc = scratch(vp);
	let mut statuses: Vec<i32> = sc.children.iter().map(|(_, s)| s.unwrap_or(0)).collect();
	if let Some(InlineStage::Done(last)) = sc.inline() {
		statuses.push(last);
	}
	// A signal ended the process whose end is the pipeline's status: its
	// processes, for the notice.
	let killed = sc.pipeline.as_deref_mut().and_then(|p| {
		p.procs.pipefail = pipefail;
		let sig = p.procs.signal()?;
		Some((sig, std::mem::take(&mut p.procs)))
	});
	clear_scratch(&mut k.root, cx.store, vp);
	// The job's end decides on an `INT` the vproc held for it.
	super::end_held_sigint(k, vp, false);
	if vp.parent.is_none() && k.jobctl.has_pgrp() {
		// bash reports its foreground pipeline a signal ended by how its last
		// process ended and each process's command (`print_pipeline`,
		// [`super::jobctl::fg_done`]); zsh's line names no pipeline.
		let bash = vp.mode.dialect() == Dialect::Bash;
		let (sig, text, shown) = match &killed {
			Some((sig, procs)) if bash => {
				let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
				let platform = k.engine.config().platform;
				let shown = procs
					.list
					.last()
					.map(|p| super::killed::ended_text(p.state, posix, platform));
				let texts: Vec<BString> = (0..procs.list.len())
					.map(|i| super::killed::stage_command(k, cx, vp, unit, info, i))
					.collect();
				(Some(*sig), bstr::join(" | ", texts), shown)
			},
			_ => (None, Vec::new(), None),
		};
		super::jobctl::fg_done(k, cx, vp, sig, &text, shown.as_deref());
	}
	vp.status = if pipefail {
		statuses
			.iter()
			.rev()
			.find(|&&s| s != 0)
			.copied()
			.unwrap_or(0)
	} else {
		statuses.last().copied().unwrap_or(0)
	};
	// Every stage skipped under `extdebug`: status 0, and `PIPESTATUS` as it
	// was (bash waited for no process).
	if !statuses.is_empty() {
		vp.pipestatus = statuses;
	}
	if let Some((sig, procs)) = killed {
		super::killed::pipeline_ended(k, cx, vp, unit, info, op.node, sig, procs);
	}
	Flow::Jump(info.end)
}

/// Source text of syntax node `node`.
fn node_text(unit: &Unit, node: u32) -> BString {
	unit
		.nodes
		.get(node as usize)
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.map_or_else(BString::default, BString::from)
}

/// The command of a job at `node` as bash prints it (`jobs`, `fg`, `bg`):
/// re-printed by bash's `make_command_string` (`( sleep 2; exit 4 )`, a
/// `while` body indented on its own lines), or as written when the text
/// does not parse alone. A zsh unit's job shows zsh's `getjobtext`
/// (`{ sleep 1; echo; }`, `f () { ... }`).
pub(super) fn job_text(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	unit: &Unit,
	node: u32,
) -> BString {
	let src = node_text(unit, node);
	let feat = features(k, cx.store, vp).unwrap_or(Features::NONE);
	if unit.mode.dialect() == Dialect::Zsh {
		let feat = feat | Features::ZSH;
		return match crate::bash::syntax::parse_all(&src, feat) {
			Ok(p) if p.commands.len() == 1 => {
				BString::from(crate::bash::syntax::zsh::getjobtext(p.commands[0].list()))
			},
			_ => src,
		};
	}
	match crate::bash::syntax::parse_all(&src, feat) {
		Ok(p) if p.commands.len() == 1 => {
			let list = p.commands[0].list();
			let text = BString::from(crate::bash::syntax::command_string(list));
			// bash 5.2.21 and 5.3.20 do not show the `!` of a job that is one
			// pipeline of simple commands (`! false &` is `false`, `! a | b
			// &` is `a | b`): it is a flag of those commands, which the
			// printed text leaves out. A lone compound command keeps it (`!
			// { false; }`, `! ( false )`, `! [[ … ]]`), and so does a timed
			// pipeline (`time ! false`), whose text starts with `time `, so
			// the `! ` prefix below is never there to take off.
			let hidden = list.items().one().is_some_and(|item| {
				let and_or = item.and_or();
				let p = and_or.first();
				and_or.rest().len() == 0
					&& p.bang()
					&& (p.stages().len() > 1
						|| p.stages().one().is_some_and(|c| {
							matches!(c.kind(), crate::bash::syntax::tree::CommandKind::Simple(_))
						}))
			});
			match text.strip_prefix(b"! ") {
				Some(rest) if hidden => BString::from(rest),
				_ => text,
			}
		},
		_ => src,
	}
}

/// Whether a pipeline's last stage runs in the shell itself: bash
/// `lastpipe` without job control, for a pipeline bash waits for
/// (`execute_cmd.c:2735`, `asynchronous == 0`): never for the pipeline a
/// background job's vproc runs as the job ([`job_pipeline`]), whose every
/// stage is a process of the job; zsh's always (the job's own process
/// too), but under sh emulation (`execcmd_exec`'s `last1 == 2 && input &&
/// EMULATION(EMULATE_SH)`).
fn last_stage_here(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, unit: &Unit) -> bool {
	if unit.mode.dialect() == Dialect::Zsh {
		vp.mode != ModeId::ZshSh
	} else {
		state::option(&mut k.root, cx.store, vp, OptId::Lastpipe).unwrap_or(false)
			&& !job_control(k, cx, vp)
			&& !(vp.parent.is_some() && vp.frames.last().is_some_and(|f| job_pipeline(unit, f.pc)))
	}
}

/// Whether job control is active in `vp` (bash `job_control`): `set -m`,
/// outside forked subshells. Decides job flags, async stdin and `lastpipe`.
pub fn job_control(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	!vp.jobs.subshell && state::option(&mut k.root, cx.store, vp, OptId::Monitor).unwrap_or(false)
}

/// Set root global `name` to `var` unless it already holds it: the forks
/// sharing the root's records keep sharing them, and a saved state stays
/// unchanged.
fn set_root_global(k: &mut Kernel, store: &mut dyn StateStore, name: &[u8], var: Var) {
	if !matches!(state::global(store, name), Ok(Some(v)) if *v == var) {
		k.root.set_var(store, name, Some(var));
	}
}

/// An asynchronous command without job control ignores `SIGINT` and
/// `SIGQUIT`.
///
/// bash 5.3 (`setup_async_signals`), on every platform: it marks them
/// ignored without a trap ([`Vproc::async_ignored`]), which `trap` does
/// not list and may replace or reset ([`async_ignored`]). Its programs
/// start with them ignored
/// ([`SpawnSpec::sigmask_ign`](crate::bash::SpawnSpec)): on Windows they lead
/// console groups of their own, out of the console's Ctrl-C.
///
/// zsh 5.9 (`entersubsh` with `ESUB_ASYNC`), on every platform: ignored
/// traps it lists (`trap -- '' INT`) and may replace or remove, in place
/// of the parent's trap functions (`settrap` removes `TRAPINT`); a `( … )`
/// inside it starts with them unset, as zsh's subshells unset their traps
/// (`zsh_subshell_traps`).
///
/// Every zsh asynchronous command forked from the same records gets the
/// same ones back: the first one's are kept ([`Kernel::async_ignored`]) and
/// shared by the next while one of them lives, rather than each copying its
/// parent's.
fn ignore_async_signals(k: &mut Kernel, cx: &mut Cx<'_>, child: &mut Vproc) {
	use crate::bash::Signal;
	if child.mode.dialect() != Dialect::Zsh {
		child.async_ignored = super::proc::AsyncIgnored::INT_QUIT;
		return;
	}
	let sigs = [Signal::Int, Signal::Quit];
	for sig in sigs {
		child.own_traps = child.own_traps.with(TrapKey::Signal(sig));
	}
	let Some(image) = child.image.as_mut() else {
		return;
	};
	if let Some((mode, from, to)) = &k.async_ignored
		&& *mode == child.mode
		&& image.shares_records(from)
		&& image.set_records(to)
	{
		return;
	}
	let from = image.records();
	for sig in sigs {
		let key = TrapKey::Signal(sig);
		// zsh's `settrap` removes the signal's trap function first
		// (`TRAPINT`, `TRAPQUIT`), as a `trap` command does.
		super::builtins::trap::remove_trap_funcs(&mut k.root, cx.store, child, key, None);
		let record = Record::Trap { mode: child.mode, action: BString::default() };
		state::store_record(&mut k.root, cx.store, child, KeyBuf::Trap(key), Some(record));
	}
	if let Some(image) = &child.image {
		k.async_ignored = Some((child.mode, from, image.records()));
	}
}

/// Whether `vp` ignores `sig` as an asynchronous command does
/// ([`Vproc::async_ignored`], bash 5.3 `SIG_ASYNCSIG`), for what it starts
/// (`started`: its programs, the forks it makes) or for itself: not while
/// a trap with an action it set itself replaces the ignore, and not for
/// itself once its own `trap` has named the signal (bash's subshell then
/// acts on the signal itself), or that of the vproc it forked from
/// ([`AsyncIgnored::trapped`](super::proc::AsyncIgnored::trapped)).
pub(super) fn async_ignored(
	store: &mut dyn StateStore,
	vp: &Vproc,
	sig: crate::bash::Signal,
	started: bool,
) -> Result<bool, StoreError> {
	let key = TrapKey::Signal(sig);
	if !vp.async_ignored.has(sig) {
		return Ok(false);
	}
	if !vp.own_traps.has(key) {
		return Ok(started || !vp.async_ignored.trapped(sig));
	}
	if !started {
		return Ok(false);
	}
	Ok(
		!matches!(state::record(store, vp, Key::Trap(key))?, Some(Record::Trap { action, .. }) if !action.is_empty()),
	)
}

/// `child`, a fork of `parent`, inherits `parent`'s asynchronous ignore
/// ([`Vproc::async_ignored`]), except for a signal `parent` trapped with an
/// action of its own (bash 5.3.20: the trap replaced the ignore, and the
/// fork resets the trap to the default; a `( … )` inside `( trap CMD INT;
/// … ) &` gets `INT` at its default). An `INT` that `parent` named in
/// `trap` otherwise (`trap - INT` after a trap, `trap '' INT`) stays
/// ignored for what `child` starts, but not for `child` itself: bash's fork
/// keeps its parent's own `INT` disposition (the default after `trap -
/// INT`, the ignoring trap it inherits after `trap '' INT`), while its
/// programs start with the ignore (bash 5.3.20: `( trap '' INT; trap - INT;
/// ( kill -INT $BASHPID; echo alive ) ) &` prints nothing). A `QUIT` stays
/// ignored for both: the fork's `QUIT` goes back to the ignore its parent
/// started with (`( trap 'echo x' QUIT; trap - QUIT; ( kill -QUIT
/// $BASHPID; echo alive ) ) &` prints `alive`).
pub(super) fn fork_async_ignored(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	parent: &Vproc,
	child: &mut Vproc,
) {
	use crate::bash::Signal;
	child.async_ignored = parent.async_ignored;
	for sig in [Signal::Int, Signal::Quit] {
		let key = TrapKey::Signal(sig);
		if !parent.async_ignored.has(sig) || !parent.own_traps.has(key) {
			continue;
		}
		match state::record(store, parent, Key::Trap(key)) {
			Ok(Some(Record::Trap { action, .. })) if !action.is_empty() => {
				child.async_ignored = child.async_ignored.without(sig);
			},
			Ok(_) if sig == Signal::Int => {
				child.async_ignored = child.async_ignored.with_trapped(sig);
			},
			Ok(_) => {},
			Err(err) => {
				k.fail(err);
				return;
			},
		}
	}
}

/// The job table a child that lists its parent's jobs starts with (a
/// command or process substitution, a `jobs` pipeline stage): copies of
/// them, which are not its children, and the statuses its parent kept,
/// which a `$( )` inherits (bash clears them in a `( … )`, not in a
/// substitution); `subshell` turns job control off. A fork keeps its
/// shell's `jobs_list_frozen` ([`Vproc::freeze`]), and the copies include
/// the foreground jobs kept while no job may be deleted
/// ([`super::proc::Job::foreground`]).
pub(super) fn inherited_jobs(vp: &Vproc, subshell: bool) -> super::proc::JobTable {
	let parent = &vp.jobs;
	let mut list = parent.list.to_vec();
	for job in &mut list {
		job.inherited = true;
	}
	super::proc::JobTable {
		list: list.into(),
		current: parent.current,
		previous: parent.previous,
		chld: 0,
		subshell,
		comsub: parent.comsub,
		freeze: vp.freeze(),
		stage_words: false,
		bgp: parent.bgp.clone(),
	}
}

/// bash 5.3 for the process of a command or process substitution of a shell
/// that is not interactive (`process_substitute` sets `SUBSHELL_COMSUB` and
/// `startup_state` 2 too): before the child reads its first command,
/// `shell_getc`'s `notify_and_cleanup` (parse.y) deletes each finished job
/// that `notify_of_job_status` marks notified there: every one but the job
/// `$!` names, and not one that a
/// SIGINT, SIGTERM or SIGPIPE killed, nor one that a signal the shell
/// ignores with `trap '' SIG` killed (the child's `signal_is_trapped`,
/// [`super::killed::ignored_by_trap`]); one that a signal the shell traps
/// with a command killed goes. bash judges that by how the job ended (its
/// wait status, [`crate::bash::store::Job::signal`]), not by its status: a
/// job that exited 130, 141 or 143 goes. Without job control a background
/// job starts with SIGINT ignored, so only one of a shell with job control
/// (`set -m`) dies of it. Each one deleted keeps its status for `wait PID`
/// (`delete_job`'s `bgp_add`), but a foreground one
/// ([`super::proc::Job::foreground`]), which goes however it ended
/// (`notify_of_job_status` marks it there: `4611-4620`, before the
/// background-only skips of `4580-4602` could keep it), keeps none;
/// and the current and previous jobs are chosen again as `delete_job` does.
/// `vp` dropped its own first, as it expanded the substitution
/// (`xparse_dolparen` re-parses it through `shell_getc` too,
/// [`super::killed::expanded`]): a `( … )`, job or stage forked from a `-c`
/// shell drops every finished job there, `$!`'s too, so the child gets none.
/// The child is a fork of `vp`, and keeps `vp`'s `jobs_list_frozen`
/// ([`Vproc::freeze`]: the last stage of a `lastpipe` pipeline, a function
/// substitution, a trap run with the list frozen, or the freeze `vp` itself
/// forked with, [`super::proc::JobTable::freeze`], which [`inherited_jobs`]
/// copied): while it is set, `notify_and_cleanup` returns before
/// `cleanup_dead_jobs`, and the child keeps every job. An interactive
/// shell's command substitution reads no line through that path, and keeps
/// every job too.
fn drop_finished_jobs(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, child: &mut Vproc) {
	if child.jobs.freeze != super::proc::Freeze::No || super::jobctl::interactive(k) {
		return;
	}
	let mut kept = |j: &super::proc::Job| {
		use crate::bash::Signal;
		if j.foreground {
			return false;
		}
		match j.signal {
			Some(Signal::Int | Signal::Term | Signal::Pipe) => true,
			Some(sig) => super::killed::ignored_by_trap(cx, vp, sig),
			None => false,
		}
	};
	let dropped: Vec<(u32, Vpid, u32, i32, bool)> = child
		.jobs
		.iter()
		.filter_map(|j| match j.state {
			super::proc::JobState::Done(status) if !kept(j) && !child.last_bg.is(j.vpid) => {
				Some((j.number, j.vpid, j.pid(), status, j.foreground))
			},
			_ => None,
		})
		.collect();
	for (number, vpid, pid, status, foreground) in dropped {
		child.jobs.remove(number);
		if !foreground {
			state::save_status(&mut k.root, cx.store, child, vpid, pid, status);
		}
	}
}

/// Whether the pipeline stage starting at `entry` may run the `jobs`
/// builtin, which keeps the job list. zsh keeps it only for a stage whose
/// text starts with the word `jobs`. bash decides on the stage's command
/// after its prefix assignments and redirections, and runs `command [-p |
/// --]… jobs` as the `jobs` builtin itself (`execute_simple_command` drops
/// the `command` word; measured: `2>/dev/null jobs | cat`, `x=1 jobs |
/// cat`, `command 'jobs' | cat`, `command -p -- jobs | cat` and `command
/// command jobs | cat` list the running job). A word only its expansion
/// names (`j=jobs; $j | cat` lists it too) may be `jobs`: such a stage
/// gets the list and drops it as it runs another command, which is never
/// on the fast path (`plain_statement` takes a literal name only).
fn runs_jobs(unit: &Unit, entry: u32) -> bool {
	if unit.mode.dialect() != Dialect::Bash {
		let Some(op) = unit.ops.get(skip_blocks(unit, entry) as usize) else {
			return false;
		};
		let text = node_text(unit, op.node);
		let text: &[u8] = &text;
		return text.strip_prefix(b"jobs").is_some_and(|rest| {
			rest
				.first()
				.is_none_or(|c| matches!(c, b' ' | b'\t' | b'\n' | b';' | b'|'))
		});
	}
	let Some(words) = stage_exec(unit, entry)
		.and_then(|(op, _)| unit.cmds.get(op.a as usize))
		.and_then(|cmd| unit.lists.get(cmd.words as usize))
	else {
		return false;
	};
	// Whether word `i` is the literal text `want`, quoted or not.
	let is = |i: usize, want: &[u8]| {
		let Some(word) = words.get(i).and_then(|&w| unit.words.get(w as usize)) else {
			return false;
		};
		let mut rest = want;
		word.parts.iter().all(|part| match part {
			ir::Part::Lit(text) | ir::Part::Quoted(text) => {
				rest.strip_prefix(text.as_slice()).is_some_and(|r| {
					rest = r;
					true
				})
			},
			_ => false,
		}) && rest.is_empty()
	};
	let expands = |i: usize| {
		words
			.get(i)
			.and_then(|&w| unit.words.get(w as usize))
			.is_some_and(|word| {
				word
					.parts
					.iter()
					.any(|part| !matches!(part, ir::Part::Lit(_) | ir::Part::Quoted(_)))
			})
	};
	let mut i = 0;
	while is(i, b"command") {
		i += 1;
		while is(i, b"-p") || is(i, b"--") {
			i += 1;
		}
	}
	is(i, b"jobs") || expands(i)
}

/// The `Exec` of the simple command the pipeline stage starting at `entry`
/// is, with the number of substitution bodies before it: past the
/// redirections the stage starts with ([`stage_level`]'s shape), the bodies
/// of the substitutions in the command's words and redirections sit before
/// the command, each jumped over (`Lower::block`).
fn stage_exec(unit: &Unit, entry: u32) -> Option<(&Op, usize)> {
	let mut pc = entry as usize;
	if unit.ops.get(pc).is_some_and(|op| op.code == Opcode::Redir) {
		pc += 1;
	}
	let mut bodies = 0;
	while let Some(op) = unit.ops.get(pc)
		&& op.code == Opcode::Jmp
		&& op.a as usize > pc
	{
		pc = op.a as usize;
		bodies += 1;
	}
	unit
		.ops
		.get(pc)
		.filter(|op| op.code == Opcode::Exec)
		.map(|op| (op, bodies))
}

/// Whether the pipeline stage starting at `entry` is a simple command whose
/// words or redirections hold a substitution ([`stage_exec`]). bash expands
/// the words in the stage's child, where such a substitution reads the list.
fn substituting_stage(unit: &Unit, entry: u32) -> bool {
	stage_exec(unit, entry).is_some_and(|(_, bodies)| bodies > 0)
}

/// `coproc NAME cmd`: run the body at `entry` as a background child whose
/// stdout the shell reads from `NAME[0]` and whose stdin it writes to
/// `NAME[1]`; `NAME_PID` and `$!` are its pid. As bash's `sh_openpipe`,
/// both pipes take the highest free fds below 64 in turn (the shell keeps
/// the first and the last).
fn start_coproc(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	entry: u32,
	name: BString,
) {
	let mut taken: Vec<i32> = Vec::with_capacity(4);
	while taken.len() < 4 {
		let fd = (3..64)
			.rev()
			.find(|fd| !taken.contains(fd) && vp.fds.get(*fd).is_none_or(|h| !h.is_open()))
			.unwrap_or_else(|| vp.fds.lowest_free(64) + taken.len() as i32);
		taken.push(fd);
	}
	let (read, write) = (taken[0], taken[3]);
	let (out_r, out_w) = mem::pipe();
	let (in_r, in_w) = mem::pipe();
	// The child gets the shell's fds before its ends are set: it holds
	// neither (`NAME[1]`'s reader would never see end of input).
	let mut fds = vp.fds.clone();
	fds.set(0, Some(FdRef::mem(in_r)));
	fds.set(1, Some(FdRef::mem(out_w)));
	let mut child = vp.child(k, cx.store, Arc::clone(unit), entry, fds);
	child.exit_trap_due = unit.spawns[op.a as usize].stages[0].exit_trap;
	child.outer_loops = fork_loops(vp, false);
	zsh_subshell_traps(k, cx, &mut child, false);
	if !job_control(k, cx, vp) {
		ignore_async_signals(k, cx, &mut child);
	}
	// A job of its own under job control (never in the foreground).
	super::jobctl::own_job(k, child.vpid);
	let vpid = child.vpid;
	k.spawned.push(Box::new(child));
	vp.fds.set(read, Some(FdRef::mem(out_r)));
	vp.fds.set(write, Some(FdRef::mem(in_w)));
	vp.last_bg = LastBg::new(vpid);
	let job = k.job_id(cx.store);
	let text = job_text(k, cx, vp, unit, op.node);
	let control = job_control(k, cx, vp);
	let cwd = vp.cwd.clone();
	vp.jobs.add(job, vpid, text, control, cwd);
	k.emit_op(cx, vp, op.node, EventData::Background { job, pid: vpid });
	let line = line_of(vp, op.node);
	let fds = AssignValue::Array(vec![
		(None, false, BString::from(read.to_string())),
		(None, false, BString::from(write.to_string())),
	]);
	let mut pid_name = name.clone();
	pid_name.extend_from_slice(b"_PID");
	let pid = AssignValue::Scalar(BString::from(vpid.0.to_string()));
	for (var, value) in [(&name, fds), (&pid_name, pid)] {
		let diag = if is_ident(var) {
			let lhs = builtins::Lhs { name: var, index: None, append: false };
			builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic).err()
		} else {
			Some(Diag::InvalidIdent { name: var.clone() })
		};
		if let Some(d) = diag {
			k.diag(cx, vp, line, d);
			// bash's coproc_setvars returns at the first failure: no NAME_PID.
			break;
		}
	}
	vp.rare_mut()
		.coprocs
		.push(Coproc { vpid, name, read, write });
	vp.status = 0;
}

/// The coprocess `waited` (whose status `wait` just took): unset `NAME`
/// and `NAME_PID` and close the shell's ends, as bash does when it reaps
/// one. (bash reaps at its next child notification; the engine does so
/// when the coprocess is waited for, so its variables stay usable until
/// then.)
pub fn reap_coproc(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, waited: Vpid) {
	let mut i = 0;
	while i < vp.coprocs().len() {
		if vp.coprocs()[i].vpid != waited {
			i += 1;
			continue;
		}
		let co = vp.rare_mut().coprocs.remove(i);
		vp.fds.set(co.read, None);
		vp.fds.set(co.write, None);
		let mut pid_name = co.name.clone();
		pid_name.extend_from_slice(b"_PID");
		// bash's `coproc_unsetvars`: nothing for an invalid name;
		// `NAME_PID` itself goes, readonly or not (`unbind_variable_noref`);
		// `NAME` is unset through a reference, refusing a readonly one.
		if !is_ident(&co.name) {
			continue;
		}
		state::store_var(&mut k.root, cx.store, vp, &pid_name, None, Level::Dynamic);
		let var = match state::deref(&k.root, cx.store, vp, &co.name) {
			Ok(state::Deref::To { name, index: None }) => name,
			_ => co.name,
		};
		let readonly = state::lookup_declared(&k.root, cx.store, vp, &var)
			.ok()
			.flatten()
			.is_some_and(|v| v.attrs.contains(Attrs::READONLY));
		if readonly {
			let line = current_line(vp);
			k.diag(cx, vp, line, Diag::Usage {
				msg: format!("{}: cannot unset: readonly variable", var.as_bstr()).into(),
			});
		} else {
			state::store_var(&mut k.root, cx.store, vp, &var, None, Level::Dynamic);
		}
	}
}

/// A redirection closed or moved away shell fd `fd`: if it was a
/// coprocess's end, `NAME[0]`/`NAME[1]` becomes -1 (bash `coproc_checkfd`).
pub fn coproc_fd_closed(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, fd: i32) {
	let mut hits = Vec::new();
	for co in vp.rare.iter_mut().flat_map(|r| r.coprocs.iter_mut()) {
		if co.read == fd {
			co.read = -1;
			hits.push((co.name.clone(), b"0"));
		}
		if co.write == fd {
			co.write = -1;
			hits.push((co.name.clone(), b"1"));
		}
	}
	for (name, index) in hits {
		let lhs = builtins::Lhs { name: &name, index: Some(&index[..]), append: false };
		let value = AssignValue::Scalar(BString::from("-1"));
		if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
			let line = current_line(vp);
			k.diag(cx, vp, line, d);
		}
	}
}

/// `set -x` for `(( … ))` and an arith-for expression: `(( text ))` of the
/// expanded text (an arith-for one without its leading blanks, `1` when
/// empty).
/// Source text of word `w` of `unit` (bash's `set -x` shows compound
/// command headers and compound assignment values unexpanded; also
/// `command::trace`).
pub fn word_source(unit: &Unit, w: u32) -> &[u8] {
	unit
		.words
		.get(w as usize)
		.and_then(|word| unit.nodes.get(word.node as usize))
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.unwrap_or_default()
}

/// `for NAME in WORDS` / `select NAME in WORDS` of a `ForIn` op, as `set -x`
/// shows it (`"$@"` without a list).
fn loop_header(unit: &Unit, forin: Op) -> Vec<u8> {
	let mut body = Vec::new();
	body.extend_from_slice(if forin.flags & Op::SELECT != 0 {
		b"select "
	} else {
		b"for "
	});
	body.extend_from_slice(
		unit
			.names
			.get(forin.b as usize)
			.map_or_default(|n| n.as_slice()),
	);
	body.extend_from_slice(b" in");
	if forin.a == Op::POSITIONAL {
		body.extend_from_slice(b" \"$@\"");
	} else if let Some(list) = unit.lists.get(forin.a as usize) {
		for &w in list {
			body.push(b' ');
			body.extend_from_slice(word_source(unit, w));
		}
	}
	body
}

fn trace_arith(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	text: &[u8],
	arith_for: bool,
) {
	let text = if arith_for {
		let t = text.trim_ascii_start();
		if t.is_empty() { b"1".as_slice() } else { t }
	} else {
		text
	};
	let mut body = Vec::with_capacity(text.len() + 6);
	body.extend_from_slice(b"(( ");
	body.extend_from_slice(text);
	body.extend_from_slice(b" ))");
	super::xtrace::emit(k, cx, vp, line, &body);
}

/// Line of the op at the top frame's pc (for diagnostics raised outside an
/// op's own handler).
pub fn current_line(vp: &Vproc) -> u32 {
	vp.frames.last().map_or(0, |f| {
		f.unit
			.as_ref()
			.and_then(|u| u.ops.get(f.pc as usize))
			.map_or(0, |op| line_of(vp, op.node))
	})
}

/// The vproc's current mode: what its code parses and runs in.
pub const fn mode_of(vp: &Vproc) -> ModeId {
	vp.mode
}

/// zsh `execlist`'s DEBUG trap at the list marker `op` (a `Nop`): before
/// the list under `DEBUG_BEFORE_CMD` (the default), after it otherwise;
/// never inside a trap. `ERR_EXIT` is off while it runs (set by the trap,
/// the list is skipped, [`zsh_debug_done`]); before the list
/// `$ZSH_DEBUG_CMD` holds its text. Whether the trap started.
fn zsh_debug_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Unit, op: Op) -> bool {
	if vp.trap_frames != 0 || !pseudo_trap_maybe(k, cx, TrapKey::Debug) {
		return false;
	}
	let opt = |k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, o| {
		state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or_else(|err| {
			k.fail(err);
			false
		})
	};
	let before = opt(k, cx, vp, ZshOpt::Debugbeforecmd);
	if (op.b == Op::LIST_START) != before {
		return false;
	}
	let errexit = opt(k, cx, vp, ZshOpt::Errexit);
	if errexit
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, false)
	{
		k.fail(err);
	}
	let line = line_of(vp, op.node);
	let frame = top_frame(vp);
	frame.debug_pc = Some(frame.pc);
	frame.debug_errexit = errexit;
	if !start_trap(k, vp, cx, TrapKey::Debug) {
		if errexit
			&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, true)
		{
			k.fail(err);
		}
		return false;
	}
	set_trap_line(vp, line);
	if before {
		// In the trap's own scope: gone when it ends (zsh unsets it).
		let text = unit
			.nodes
			.get(op.node as usize)
			.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
			.and_then(crate::bash::syntax::zsh::list_text)
			.unwrap_or_default();
		if let Some(top) = state::scope_count(&k.root, vp).checked_sub(1) {
			let var = Var::scalar(BString::from(text), Attrs::NONE);
			state::scope_set(&mut k.root, cx.store, vp, top, b"ZSH_DEBUG_CMD", Some(var));
		}
	}
	true
}

/// After a zsh DEBUG trap started at a list marker ([`zsh_debug_trap`]):
/// `ERR_EXIT` comes back; turned on by the trap before a list, the list is
/// skipped.
fn zsh_debug_done(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let f = top_frame(vp);
	let Some(op) = f
		.debug_pc
		.filter(|&pc| pc == f.pc)
		.and_then(|pc| f.unit.as_ref()?.ops.get(pc as usize).copied())
		.filter(|op| op.code == Opcode::Nop && op.b != 0)
	else {
		return;
	};
	let saved = f.debug_errexit;
	let now = state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit).unwrap_or(false);
	if now != saved
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, saved)
	{
		k.fail(err);
	}
	if op.b == Op::LIST_START && now {
		top_frame(vp).pc = op.a;
	}
}

/// Run a configured trap in the interrupted shell, without re-entering it.
pub fn start_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	// A DEBUG trap action's command substitution runs none, nor a host
	// callout's subshell, which stands for an external program.
	if key == TrapKey::Debug && runs_no_debug_trap(vp) {
		return false;
	}
	// bash's `breaking`: while a `break` from `${ }` waits for its loop, a
	// trap's action runs none of its commands (an EXIT trap too).
	if vp.pending_break.is_some() {
		return false;
	}
	// A subshell lists its parent's EXIT trap but runs only its own.
	if key == TrapKey::Exit && vp.parent.is_some() && !vp.own_traps.has(key) {
		return false;
	}
	// The check before every command (DEBUG) and function return (RETURN):
	// no action set anywhere, nothing to decide (xeon profile: `start_trap`
	// ~1 % self on func, plus its store lookups in `state::record`).
	if !pseudo_trap_maybe(k, cx, key) {
		return false;
	}
	// zsh has no `errtrace`/`functrace`: its ZERR and DEBUG traps run in
	// every function (`localtraps` scopes them instead).
	if matches!(key, TrapKey::Debug | TrapKey::Err | TrapKey::Return)
		&& vp.mode.dialect() == Dialect::Bash
	{
		// The innermost function (for DEBUG also `.` file) decides: a trap
		// it set itself runs, an inherited one only under `functrace` /
		// `errtrace` (or the function's trace attribute, set as local).
		let local = vp.frames.iter().rev().find_map(|frame| match frame.kind {
			FrameKind::Function { .. } => Some(match key {
				TrapKey::Debug => frame.debug_trap_local,
				TrapKey::Err => frame.err_trap_local,
				TrapKey::Return => frame.return_trap_local,
				_ => unreachable!(),
			}),
			FrameKind::Script { what: ScriptKind::Source, .. } if key == TrapKey::Debug => {
				Some(frame.debug_trap_local)
			},
			_ => None,
		});
		let child_inherited = vp.parent.is_some() && !vp.own_traps.has(key);
		if (local == Some(false) || child_inherited) && !local.unwrap_or(false) {
			let opt = if key == TrapKey::Err {
				OptId::Errtrace
			} else {
				OptId::Functrace
			};
			match state::option(&mut k.root, cx.store, vp, opt) {
				Ok(true) => {},
				Ok(false) => return false,
				Err(err) => {
					k.fail(err);
					return false;
				},
			}
		}
	}
	// No trap runs inside its own action; a function called from the
	// DEBUG trap loses the RETURN trap (bash's `execute_function`).
	if in_trap_action(vp, key) || (key == TrapKey::Return && in_trap_action(vp, TrapKey::Debug)) {
		return false;
	}
	let (action, trap_mode) = match state::record(cx.store, vp, Key::Trap(key)) {
		Ok(Some(Record::Trap { action, mode })) if !action.is_empty() => (action.clone(), *mode),
		// zsh: a `TRAPNAL` function is the trap (zsh `ZSIG_FUNC`).
		Ok(None) if vp.mode.dialect() == Dialect::Zsh => return start_func_trap(k, vp, cx, key),
		Ok(_) => return false,
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	let started = push_trap(k, vp, cx, key, &action, trap_mode);
	if started && key == TrapKey::Exit && vp.parent.is_none() && !vp.runs.is_empty() {
		// A root run is a shell invocation: consume its EXIT trap when it
		// fires, rather than carrying it into the next invocation.
		state::store_record(&mut k.root, cx.store, vp, KeyBuf::Trap(key), None);
	} else if started && key == TrapKey::Exit && vp.mode.dialect() == Dialect::Bash {
		// bash's `run_exit_trap` clears `SIG_TRAPPED` before the action
		// runs: a subshell's own trap counts no more ([`exit_trapped`])
		// until the action sets one again; `trap -p` still lists it.
		vp.own_traps = vp.own_traps.without(key);
	}
	started
}

/// Whether `vp` runs the action of its `key` trap (a frame of it is on
/// the stack).
fn in_trap_action(vp: &Vproc, key: TrapKey) -> bool {
	vp.trap_frames != 0
		&& vp.frames.iter().any(|f| {
			matches!(f.kind,
				FrameKind::Script { what: ScriptKind::Trap { key: active, .. }, .. } if active == key)
		})
}

/// Push the frame of trap `key` running `action` set in `trap_mode`
/// (empty for a zsh `TRAPNAL` function, whose call goes on top of it):
/// `BASH_TRAPSIG`, the interrupted status, the mode switch. Shared by
/// [`start_trap`] and zsh's function `EXIT` traps.
fn push_trap(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	key: TrapKey,
	action: &[u8],
	trap_mode: ModeId,
) -> bool {
	// A trap runs in the mode of the code that set it; the
	// interrupted code's mode and options come back after it.
	let restore = if trap_mode == vp.mode {
		None
	} else {
		match super::mode::save_for_emulate(&mut k.root, cx.store, vp) {
			Ok(saved) => Some(saved),
			Err(err) => {
				k.fail(err);
				return false;
			},
		}
	};
	let platform = k.engine.config().platform;
	let pseudo_base = if platform == crate::bash::Platform::MacOs {
		32
	} else {
		65
	};
	let number = match key {
		TrapKey::Signal(sig) => sig.number(platform),
		TrapKey::Exit => 0,
		TrapKey::Debug => pseudo_base,
		TrapKey::Err => pseudo_base + 1,
		TrapKey::Return => pseudo_base + 2,
	};
	let attrs = match state::lookup(&k.root, cx.store, vp, b"BASH_TRAPSIG") {
		Ok(var) => var.map_or(Attrs::NONE, |var| var.attrs),
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	let mut scope = state::Scope::default();
	scope.vars.insert(
		BString::from("BASH_TRAPSIG"),
		Some(Var::scalar(number.format_into(&mut NumBuffer::new()), attrs)),
	);
	state::push_scope(&mut k.root, cx.store, vp, scope);
	let status = vp.status;
	// bash's `trap_saved_exit_value`: every trap that starts saves `$?`
	// there (`run_exit_trap`, `run_pending_traps`, `_run_trap_internal`),
	// and nothing restores it when the trap ends.
	vp.trap_saved = status;
	vp.blocked = None;
	// bash runs a `CHLD` trap `wait` runs from `waitchld`, and an `INT`
	// trap from its `wait_for`, with the job list frozen; in posix mode the
	// `CHLD` trap ends the `wait` and runs after it (`jobs.c:4240-4250`).
	// zsh freezes nothing: the finished job is out of its table already.
	let bash = vp.mode.dialect() == Dialect::Bash;
	let frozen = match key {
		TrapKey::Signal(crate::bash::signal::Signal::Chld) => {
			bash
				&& vp.in_wait_builtin()
				&& !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false)
		},
		TrapKey::Signal(crate::bash::signal::Signal::Int) => {
			let at = k.frozen_ints.iter().position(|v| *v == vp.vpid);
			at.map(|i| k.frozen_ints.swap_remove(i)).is_some() && bash
		},
		_ => false,
	};
	push_script(vp, action, 1, ScriptKind::Trap {
		key,
		status,
		cancel: None,
		return_target: None,
		exit: false,
		returned: false,
		frozen,
		outside_functions: false,
	});
	if let Some(saved) = restore {
		super::mode::set_mode(&mut k.root, cx.store, vp, trap_mode);
		vp.push_restore(*saved);
	}
	k.emit_op(cx, vp, 0, EventData::Trap { trap: key });
	true
}

/// Which of the DEBUG, ERR and RETURN traps may have an action somewhere
/// (the store or a vproc's image). [`start_trap`] asks
/// before each command and each function return; with no such trap set
/// (the common case) it answers without frame scans, option reads or
/// store lookups. Bits are only ever set: `trap` sets the key's bit when
/// it installs an action, a restore sets all (restored images), and the
/// store's own records are read once per store epoch. A trap reset
/// later keeps its bit; the full check then decides, as before.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PseudoTraps {
	/// `1 << n` per key ([`Self::bit`]).
	bits:  u8,
	/// The store epoch ([`Root::epoch`]) whose records were read; `None`:
	/// not yet.
	epoch: Option<u64>,
}

impl PseudoTraps {
	const fn bit(key: TrapKey) -> u8 {
		match key {
			TrapKey::Debug => 1,
			TrapKey::Err => 2,
			TrapKey::Return => 4,
			TrapKey::Exit | TrapKey::Signal(_) => 0,
		}
	}

	/// `trap` installed an action for `key` (in the root or an image).
	pub const fn note(&mut self, key: TrapKey) {
		self.bits |= Self::bit(key);
	}

	/// Any pseudo-trap may be set (restored images are not inspected).
	pub const fn note_all(&mut self) {
		self.bits = 7;
	}
}

/// Whether `key` may have an action: always for EXIT and signals; for
/// DEBUG/ERR/RETURN per [`PseudoTraps`]. A store read error answers yes
/// (the full check reports it).
#[inline]
fn pseudo_trap_maybe(k: &mut Kernel, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	let bit = PseudoTraps::bit(key);
	if bit == 0 || k.pseudo_traps.bits & bit != 0 {
		return true;
	}
	if k.pseudo_traps.epoch != Some(k.root.epoch()) {
		note_pseudo_traps(k, cx);
	}
	k.pseudo_traps.bits & bit != 0
}

/// Read which pseudo-traps the store holds into [`PseudoTraps`], at the
/// store's current epoch.
#[inline(never)]
fn note_pseudo_traps(k: &mut Kernel, cx: &mut Cx<'_>) {
	k.pseudo_traps.epoch = Some(k.root.epoch());
	for pseudo in [TrapKey::Debug, TrapKey::Err, TrapKey::Return] {
		let set = match cx.store.get(Key::Trap(pseudo)) {
			Ok(Some(Record::Trap { action, .. })) => !action.is_empty(),
			Ok(_) => false,
			Err(_) => true,
		};
		if set {
			k.pseudo_traps.note(pseudo);
		}
	}
}

/// [`Frame::debug_pc`] of a function frame whose DEBUG trap at entry is
/// running: under `extdebug` a failing trap skips the whole body.
pub const ENTRY_DEBUG: u32 = u32::MAX;

/// [`Frame::debug_pc`] of a `Spawn` while the shell runs the DEBUG traps
/// of its simple stages ([`shell_debug_stages`]): `SPAWN_DEBUG - n` once
/// the first `n` have run (`Some(pc)` once all have). Far above any pc,
/// and below [`ENTRY_DEBUG`].
pub const SPAWN_DEBUG: u32 = u32::MAX - 1;

/// More stages than a [`SPAWN_DEBUG`] count holds.
const MAX_STAGES: u32 = 1 << 16;

/// How many stages' DEBUG traps a `Spawn` whose frame has `debug_pc` has
/// run ([`SPAWN_DEBUG`]).
fn spawn_debug_done(debug_pc: Option<u32>) -> usize {
	match debug_pc {
		Some(at) if (SPAWN_DEBUG - MAX_STAGES..SPAWN_DEBUG).contains(&at) => {
			(SPAWN_DEBUG - at) as usize
		},
		_ => 0,
	}
}

/// `vp` runs no DEBUG trap ([`super::proc::FrameFlags::no_debug_trap`] of its
/// base frame).
fn runs_no_debug_trap(vp: &Vproc) -> bool {
	vp.frames.first().is_some_and(|f| f.flags.no_debug_trap())
}

/// A command or process substitution (bash's or zsh's) a DEBUG trap action
/// starts runs no DEBUG trap and keeps `BASH_COMMAND`, as bash's and zsh's
/// do (they run no trap inside a trap), so a trap that substitutes does not
/// run itself again; nor does one a vproc that runs none starts. A subshell
/// the action starts runs the trap again, in bash too.
fn sub_runs_no_debug_trap(vp: &Vproc, child: &mut Vproc) {
	if (runs_no_debug_trap(vp) || in_trap_action(vp, TrapKey::Debug))
		&& let Some(base) = child.frames.first_mut()
	{
		base.flags.set_no_debug_trap(true);
	}
}

/// `extdebug`: drop the skip lists `vpid` left at frame `from` or deeper,
/// whose `Spawn` never ran ([`note_debug_skip`]).
fn drop_debug_skips(k: &mut Kernel, vpid: Vpid, from: usize) {
	k.debug_skips
		.retain(|s| !(s.vproc == vpid && s.frame as usize >= from));
}

/// `extdebug`: the DEBUG trap the shell ran for the pipeline stage at
/// `entry`, before the `Spawn` of `vp`'s top frame forks it, failed: that
/// stage is not started ([`DebugSkip`]). Each frame keeps a list of its
/// own: a pipeline a later stage's trap action runs (a frame deeper) takes
/// none of it.
fn note_debug_skip(k: &mut Kernel, vp: &Vproc, entry: u32) {
	let frame = vp.frames.len().saturating_sub(1) as u32;
	match k
		.debug_skips
		.iter_mut()
		.find(|s| s.vproc == vp.vpid && s.frame == frame)
	{
		Some(skip) => skip.entries.push(entry),
		None => k
			.debug_skips
			.push(DebugSkip { vproc: vp.vpid, frame, entries: vec![entry] }),
	}
}

/// The stages `vp`'s top-frame `Spawn` skips ([`note_debug_skip`]), taken;
/// another frame's list stays.
fn take_debug_skip(k: &mut Kernel, vp: &Vproc) -> Option<Vec<u32>> {
	let frame = vp.frames.len().saturating_sub(1) as u32;
	let i = k
		.debug_skips
		.iter()
		.position(|s| s.vproc == vp.vpid && s.frame == frame)?;
	Some(k.debug_skips.swap_remove(i).entries)
}

/// Whether `skip` names every stage of the pipeline a background job's
/// body at `entry` is: `extdebug` skipped them all, and bash starts no job.
fn skips_whole_pipeline(unit: &Unit, entry: u32, skip: &[u32]) -> bool {
	body_pipeline(unit, entry).is_some_and(|spawn| {
		unit.spawns[spawn]
			.stages
			.iter()
			.all(|s| skip.contains(&s.entry))
	})
}

/// Start the RETURN trap of function or `.` frame `target`, the frames
/// above it to unwind when it ends, when `returns` is the status that
/// returns. The action runs with `$?` as it was before the return, and
/// leaves `returns` ([`ScriptKind::Trap::return_target`]). Its `$LINENO`
/// is the function body's line, or the line of the `.` command, whose level
/// of the call-stack arrays has already ended (bash runs it after
/// `_evalfile`). `false` when no trap runs.
fn return_trap(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	target: usize,
	returns: i32,
) -> bool {
	let body = match &vp.frames[target] {
		Frame { kind: FrameKind::Function { .. }, unit: Some(unit), .. } => {
			Some(super::callstack::body_line(unit))
		},
		_ => None,
	};
	let line = body.or_else(|| {
		let line = super::callstack::source_line(vp, target + 1);
		super::callstack::truncate(&mut k.root, cx.store, vp, target);
		line
	});
	if !start_trap(k, vp, cx, TrapKey::Return) {
		return false;
	}
	if let Some(line) = line {
		set_trap_line(vp, line);
	}
	mark_return(vp, target, returns);
	true
}

fn mark_return(vp: &mut Vproc, target: usize, returns: i32) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { return_target, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*return_target = Some((target as u32, returns));
	}
}

/// Mark a freshly started trap as the last action of a cancellation.
pub fn mark_cancel(vp: &mut Vproc, status: i32) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { cancel, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*cancel = Some(status);
	}
}

/// End a cancelled vproc (after its signal trap, or at once when it has
/// none; `Shell::apply_requests`): unwind everything with `status`. The
/// started run still runs its EXIT trap, as bash does when a signal ends
/// the shell; scripts queued behind it end unstarted.
pub fn finish_cancel(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, status: i32) {
	unwind(root, store, vp, 0);
	vp.status = status;
	vp.blocked = None;
	for (i, run) in vp.runs.iter_mut().enumerate() {
		if i > 0 || !run.started {
			run.started = true;
			run.exit_trap_started = true;
		}
	}
}

/// bash `termsig_handler` for vproc `vp`, which has an EXIT trap of its own
/// ([`super::untrapped`]: bash catches its `terminating_signals` once one
/// is set): its frames go, the EXIT trap runs with `$?` as it was, and when
/// the trap ends the vproc exits with `status` (128 + the signal's number).
pub fn bash_termsig(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	release_externals(vp);
	unwind(&mut k.root, cx.store, vp, 0);
	vp.blocked = None;
	vp.stopped = false;
	spend_exit_trap(vp);
	if !start_trap(k, vp, cx, TrapKey::Exit) {
		vp.status = status;
		return;
	}
	// The trap's end exits with `status`; the trap itself sees `$?`.
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { status: end, exit, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*end = status;
		*exit = true;
	}
}

/// Whether `vp` runs the EXIT trap a terminating signal began
/// ([`bash_termsig`]: bash's `termsig_handler` is under way).
pub fn terminating(vp: &Vproc) -> bool {
	vp.frames.iter().any(|f| {
		matches!(f.kind, FrameKind::Script {
			what: ScriptKind::Trap { key: TrapKey::Exit, exit: true, .. },
			..
		})
	})
}

/// Push a script frame running `src` (`eval`, `source`).
pub fn push_script(vp: &mut Vproc, src: &[u8], line: u32, what: ScriptKind) {
	if matches!(what, ScriptKind::Trap { .. }) {
		vp.trap_frames += 1;
	}
	vp.frames
		.push(Frame::new(None, 0, FrameKind::script(src, Pos { offset: 0, line }, what)));
}

/// The script frame on top of `vp` runs a command a builtin built (`jobs
/// -x`), which bash runs with `execute_command`: reading it is no read of
/// an input line, and reports no job ([`line_to_read`]).
pub fn script_reads_no_line(vp: &mut Vproc) {
	if let Some(Frame { kind: FrameKind::Script { aux, .. }, .. }) = vp.frames.last_mut() {
		aux.get_or_insert_with(Box::default).no_line = true;
	}
}

// zsh control flow (zsh-dialect units only). Ported from zsh 5.9 (MIT-style
// licence, Copyright (c) 1992-1997 Paul Falstad and the zsh development
// group): `loop.c` `execrepeat`/`exectry`/`execfor`, `exec.c`
// `doshfunc`'s return and exit handling, `builtin.c` `bin_break`,
// `signals.c` `endtrapscope`/`dotrapargs`.

/// zsh `execrepeat`: expand the count word once and evaluate it
/// arithmetically; `$?` is 0 before the first pass (`repeat 0` resets it).
#[inline(never)]
fn repeat(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pc = top_frame(vp).pc;
	let exit = unit.ops.get(pc as usize + 1).map_or(pc + 1, |next| next.a);
	let w = &unit.words[op.a as usize];
	let count = match expanding(k, vp, cx, Slot::Words, true, line, |ex| {
		let text = ex.scalar(unit, w)?;
		super::zsh::arith::mathevali(ex, &text)
	}) {
		Ok(n) => n,
		Err(flow) => return flow,
	};
	clear_scratch(&mut k.root, cx.store, vp);
	vp.status = 0;
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::Repeat { left: count },
		status: 0,
		iterations: 0,
		exit,
		cont: pc + 1,
		depth,
	});
	Flow::Next
}

/// zsh `execarith` (`((…))` and the arithmetic `for` header): the token
/// text substituted, then evaluated by zsh's math; `$?` is 0 for a
/// non-zero value, 1 for zero, 2 after an error (reported, the line goes
/// on: zsh clears `ERRFLAG_ERROR`).
#[inline(never)]
fn zsh_arith(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let text = &unit.ariths[op.a as usize];
	let record = crate::bash::syntax::zsh::tok::has_token(text);
	let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| match ex.zsh_arith(text) {
		Ok(v) => Ok(Ok(v)),
		Err(Stop::Fail(d)) => Ok(Err(d)),
		Err(stop) => Err(stop),
	});
	match res {
		Ok(v) => {
			clear_scratch(&mut k.root, cx.store, vp);
			vp.status = match v {
				Ok(super::zsh::math::Number::Int(i)) => i32::from(i == 0),
				Ok(super::zsh::math::Number::Float(f)) => i32::from(f == 0.0),
				Err(d) => {
					k.diag(cx, vp, line, d);
					2
				},
			};
			Flow::Next
		},
		Err(flow) => flow,
	}
}

/// `ForNext` of a zsh `repeat` (count a pass) or a zsh `for a b … in`
/// (zsh `execfor`: each variable takes the next word, missing ones are
/// empty); `None` for the other loops.
#[inline(never)]
fn zsh_next(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Option<Flow> {
	let rec = top_frame(vp).loops.last_mut()?;
	match &mut rec.kind {
		LoopKind::Repeat { left } => {
			if *left <= 0 {
				return Some(Flow::Jump(op.a));
			}
			*left -= 1;
			Some(Flow::Next)
		},
		LoopKind::ForMulti { vars, items, next } => {
			let start = *next as usize;
			if start >= items.len() {
				return Some(Flow::Jump(op.a));
			}
			*next = u32::try_from(start + vars.len()).unwrap_or(u32::MAX);
			let pairs: Vec<(BString, BString)> = vars
				.iter()
				.enumerate()
				.map(|(i, v)| (v.clone(), items.get(start + i).cloned().unwrap_or_default()))
				.collect();
			clear_scratch(&mut k.root, cx.store, vp);
			for (var, value) in pairs {
				if let Err(d) = builtins::assign_zsh_loop_var(k, vp, cx, &var, &value, line) {
					k.diag(cx, vp, line, d);
					if let Some(rec) = top_frame(vp).loops.last_mut() {
						rec.status = 1;
					}
					return Some(Flow::Jump(op.a));
				}
			}
			Some(Flow::Next)
		},
		_ => None,
	}
}

/// zsh `exectry` starts the try-list `op` opens: a try record (`op.a` is
/// the pc of the always-list, `op.b` the pc after it).
#[inline(never)]
fn try_enter(vp: &mut Vproc, op: Op) -> Flow {
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::Try { always: false, pending: None },
		status: 0,
		iterations: 0,
		exit: op.a,
		cont: op.b,
		depth,
	});
	Flow::Next
}

/// zsh `exectry` reaches the always-list: the try-list's status is kept
/// for after it.
#[inline(never)]
fn always_enter(vp: &mut Vproc) -> Flow {
	let status = vp.status;
	if let Some(rec) = top_frame(vp).loops.last_mut()
		&& let LoopKind::Try { always, .. } = &mut rec.kind
	{
		*always = true;
		rec.status = status;
	}
	Flow::Next
}

/// zsh `exectry` after the always-list: pop the try record, `$?` is the
/// try-list's status, and what ended the try-list early resumes.
#[inline(never)]
fn always_end(vp: &mut Vproc) -> Flow {
	let f = top_frame(vp);
	if !matches!(f.loops.last(), Some(LoopRec { kind: LoopKind::Try { .. }, .. })) {
		return Flow::Next;
	}
	let Some(rec) = f.loops.pop() else {
		return Flow::Next;
	};
	vp.status = rec.status;
	let LoopKind::Try { pending, .. } = rec.kind else {
		return Flow::Next;
	};
	match pending {
		None => Flow::Next,
		Some(TryEnd::Error) => Flow::Discard(if rec.status == 0 { 1 } else { rec.status }),
		Some(TryEnd::Return(n)) => Flow::Return(n),
		Some(TryEnd::Break { n, cont }) => Flow::Break { n, cont },
		Some(TryEnd::Exit(n)) => Flow::Exit(n, Jump::Other),
	}
}

/// zsh `exectry`: control is leaving the frames from the top down to
/// frame `floor` (inclusive) because of `end`. The innermost try-list it
/// leaves (a try record whose always-list has not started) runs its
/// always-list first: the frames above are popped, the try record keeps
/// `end` to resume, and its frame jumps to the always-list. An always-list
/// being left is abandoned. `false` when no try-list is in the way.
#[inline(never)]
fn run_always(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, floor: usize, end: TryEnd) -> bool {
	let found = vp
		.frames
		.iter()
		.enumerate()
		.skip(floor)
		.rev()
		.find_map(|(fi, f)| {
			f.loops
				.iter()
				.rposition(|r| matches!(r.kind, LoopKind::Try { always: false, .. }))
				.map(|ri| (fi, ri))
		});
	let Some((fi, ri)) = found else {
		return false;
	};
	unwind(&mut k.root, cx.store, vp, fi + 1);
	// The op of that frame (a call, the op that ended the list) is over.
	clear_scratch(&mut k.root, cx.store, vp);
	let f = top_frame(vp);
	f.loops.truncate(ri + 1);
	let Some(rec) = f.loops.last_mut() else {
		return false;
	};
	if let LoopKind::Try { pending, .. } = &mut rec.kind {
		*pending = Some(end);
	}
	let (depth, always) = (rec.depth, rec.exit);
	truncate(vp, depth);
	top_frame(vp).pc = always;
	true
}

/// zsh `ERR_RETURN` (`execlist`'s `retflag` after a failed command): leave
/// the innermost function, `${ ;}` or `.` file, running the always-lists in
/// the way; outside any, leave the shell (`zexit`). An explicit `return`
/// goes through [`zsh_return_flow`]; this one does not mark a trap frame
/// below ([`mark_trap_return`]): in zsh only an explicit `return N` from a
/// `TRAPNAL` function ends the code the trap interrupted.
#[inline(never)]
pub fn zsh_return(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let target = vp.frames.iter().rposition(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	if run_always(k, vp, cx, target.unwrap_or(0), TryEnd::Return(status)) {
		return;
	}
	if let Some(i) = target {
		zsh_leave(k, vp, cx, i);
	} else {
		exit_shell(k, vp, cx, status, Jump::Other);
	}
}

/// Leave frame `target` (a function, `${ ;}` or `.` file) and the frames
/// above it. A zsh function's scope ends as zsh `doshfunc` ends it: its
/// options come back, the traps it saved are restored, and the `EXIT`
/// trap it set runs afterwards in its caller (zsh `endtrapscope`).
#[inline(never)]
fn zsh_leave(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, target: usize) {
	unwind(&mut k.root, cx.store, vp, target + 1);
	let zsh_function = vp.trap_frames == 0
		&& matches!(
			vp.frames.get(target),
			Some(Frame { kind: FrameKind::Function { zsh: true, .. }, .. })
		);
	let exit = if zsh_function {
		match builtins::trap::take_scope_exit(k, cx, vp) {
			Ok(exit) => exit,
			Err(err) => {
				k.fail(err);
				None
			},
		}
	} else {
		None
	};
	if matches!(
		vp.frames.get(target),
		Some(Frame { kind: FrameKind::Function { zsh: true, .. }, .. })
	) {
		restore_local_specials(k, vp, cx);
	}
	pop_frame(&mut k.root, cx.store, vp);
	match exit {
		Some(builtins::trap::ScopeExit::Text { action, mode }) => {
			push_trap(k, vp, cx, TrapKey::Exit, &action, mode);
		},
		Some(builtins::trap::ScopeExit::Func(rec)) => {
			run_func_trap(k, vp, cx, TrapKey::Exit, BString::from("TRAPEXIT"), rec);
		},
		None => {},
	}
}

/// zsh `scanendscope` for a zsh function's scope, before it goes: the
/// computed specials it made local get their values back
/// ([`super::zsh::specials::restore_locals`]).
fn restore_local_specials(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let mut log = Vec::new();
	let res = {
		let mut ex = super::expand::Expander::new(k, cx, vp, &mut log, false, 0);
		super::zsh::specials::restore_locals(&mut ex)
	};
	if let Err(super::expand::Stop::Store(err)) = res {
		k.fail(err);
	}
}

/// The loops a zsh `break`/`continue` may leave (zsh's `loops`): every
/// loop running in this vproc, across function calls and `eval`, up to the
/// `.` file, trap action or script that runs them (which start at zero),
/// and, when that reaches the vproc's first frame, its forking shell's
/// ([`Vproc::outer_loops`]: a zsh fork keeps `loops`).
pub fn zsh_loop_count(vp: &Vproc) -> u32 {
	let mut n = 0u32;
	for (i, f) in vp.frames.iter().enumerate().rev() {
		let here = f
			.loops
			.iter()
			.filter(|r| !matches!(r.kind, LoopKind::Try { .. }))
			.count();
		n = n.saturating_add(u32::try_from(here).unwrap_or(u32::MAX));
		if i == 0 {
			return n.saturating_add(u32::from(vp.outer_loops));
		}
		if !matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Stage
				| FrameKind::Script { what: ScriptKind::Eval, .. }
		) {
			break;
		}
	}
	n
}

/// zsh `break N` / `continue N` (`bin_break`, the loops' `breaks`
/// handling): leave N loops (at most as many as run), across function
/// calls unless `localloops` is set when the function returns; a try-list
/// in the way runs its always-list first; past the vproc's own loops it
/// ends ([`leave_outer_loop`]).
#[inline(never)]
fn zsh_break(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, n: u32, cont: bool) {
	let mut remaining = n.min(zsh_loop_count(vp)).max(1);
	loop {
		let f = top_frame(vp);
		if let Some(rec) = f.loops.last().cloned() {
			match rec.kind {
				LoopKind::Try { always: false, .. } => {
					if let Some(LoopRec { kind: LoopKind::Try { pending, .. }, .. }) = f.loops.last_mut()
					{
						*pending = Some(TryEnd::Break { n: remaining, cont });
					}
					truncate(vp, rec.depth);
					top_frame(vp).pc = rec.exit;
					return;
				},
				LoopKind::Try { always: true, .. } => {
					f.loops.pop();
					truncate(vp, rec.depth);
					continue;
				},
				_ if remaining > 1 => {
					f.loops.pop();
					truncate(vp, rec.depth);
					remaining -= 1;
					continue;
				},
				_ => {
					truncate(vp, rec.depth);
					let status = vp.status;
					let f = top_frame(vp);
					// `continue` ends the body with its status too: the loop's
					// status if no other body command runs.
					if let Some(r) = f.loops.last_mut() {
						r.status = status;
					}
					f.pc = if cont { rec.cont } else { rec.exit };
					return;
				},
			}
		}
		let function = matches!(f.kind, FrameKind::Function { .. });
		let crossable = function
			|| matches!(
				f.kind,
				FrameKind::Script { what: ScriptKind::Eval, .. } | FrameKind::NoFork | FrameKind::Stage
			);
		if !crossable || vp.frames.len() < 2 {
			break;
		}
		pop_frame(&mut k.root, cx.store, vp);
		// zsh `doshfunc`: with `localloops` (as restored on return) the
		// break ends with the function; the call completes.
		if function
			&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Localloops).unwrap_or(false)
		{
			let what = if cont { "continue" } else { "break" };
			let msg = format!("`{what}' active at end of function scope").into();
			let line = current_line(vp);
			k.diag(cx, vp, line, Diag::Usage { msg });
			return;
		}
		// The caller's op (the call, `eval`) is abandoned with the loop.
		clear_scratch(&mut k.root, cx.store, vp);
	}
	// Past this vproc's own loops: the rest are its forking shell's.
	if vp.frames.len() == 1 && vp.outer_loops > 0 {
		leave_outer_loop(k, vp, cx, true);
	} else {
		top_frame(vp).pc += 1;
	}
}

/// zsh `exit N` (`bin_break`): inside a function the functions return one
/// by one (always-lists and their `EXIT` traps run, zsh `exit_pending`),
/// then the shell exits; elsewhere it exits at once (`zexit`).
#[inline(never)]
fn zsh_exit(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let in_function = vp
		.frames
		.iter()
		.any(|f| matches!(f.kind, FrameKind::Function { .. }));
	if !in_function {
		if let Some(z) = vp.zsh.as_mut()
			&& z.exit_pending.take().is_some()
		{
			z.exit_from_function = true;
		}
		exit_shell(k, vp, cx, status, Jump::Other);
		return;
	}
	let level = vp
		.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count();
	let level = u32::try_from(level).unwrap_or(u32::MAX);
	vp.zsh.get_or_insert_with(Box::default).exit_pending = Some((status, level));
	if run_always(k, vp, cx, 0, TryEnd::Exit(status)) {
		return;
	}
	let target = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Function { .. }))
		.unwrap_or(0);
	zsh_leave(k, vp, cx, target);
}

/// The status a pending zsh `exit` (inside functions) leaves with, taken
/// when a call returns to its caller: the caller exits in turn if the
/// `exit` ran at its depth or deeper (zsh `doshfunc`'s `exit_level >=
/// locallevel+1`; a call an `always` list makes meanwhile returns
/// normally).
pub fn zsh_exit_pending(vp: &Vproc) -> Option<i32> {
	let (status, level) = vp.zsh.as_ref()?.exit_pending?;
	let depth = vp
		.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count();
	(level as usize > depth).then_some(status)
}

/// zsh `errflag`: an error abandons everything up to the innermost `eval`,
/// `.` file or trap action (which clear it), or the whole script or
/// subshell, running the always-lists in the way (`TRY_BLOCK_ERROR` is 1
/// there).
#[inline(never)]
fn zsh_discard(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let catcher = vp.frames.iter().rposition(|f| {
		matches!(f.kind, FrameKind::Script {
			what: ScriptKind::Eval
				| ScriptKind::Source
				| ScriptKind::Trap { .. }
				| ScriptKind::Code(_)
				// The line editor's widget or hook call: the editor goes on
				// (zsh `execzlefunc`/`callhookfunc` after `doshfunc`).
				| ScriptKind::Hook,
			..
		})
	});
	if run_always(k, vp, cx, catcher.unwrap_or(0), TryEnd::Error) {
		return;
	}
	// zsh `loop`: under `continueonerror` the script goes on with its next
	// command.
	let run = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }));
	if let Some(i) = catcher {
		// Code a builtin runs (`ScriptKind::Code`): the builtin learns of
		// the error (zsh's `errflag` after `execode`) when it runs again.
		let code = matches!(vp.frames[i].kind, FrameKind::Script { what: ScriptKind::Code(_), .. });
		unwind(&mut k.root, cx.store, vp, i);
		if code {
			state::store_record(
				&mut k.root,
				cx.store,
				vp,
				KeyBuf::Misc(MiscKey::ZshCodeError),
				Some(Record::Misc(BString::from("1"))),
			);
		}
		vp.status = status;
	} else if let Some(i) = run
		&& (state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Continueonerror).unwrap_or(false)
			|| super::zle::reader::input_frame(cx, vp, i))
	{
		unwind(&mut k.root, cx.store, vp, i + 1);
		clear_scratch(&mut k.root, cx.store, vp);
		truncate(vp, Depths::default());
		let f = top_frame(vp);
		f.unit = None;
		f.loops.clear();
		vp.status = status;
	} else {
		unwind(&mut k.root, cx.store, vp, 0);
		exit_shell(k, vp, cx, status, Jump::Other);
	}
}

/// zsh `ERR_RETURN` applies (`execlist`): set, and in a function or `.`
/// file.
#[inline(never)]
fn zsh_errreturn(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errreturn).unwrap_or(false)
		&& vp.frames.iter().any(|f| {
			matches!(
				f.kind,
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. }
			)
		})
}

/// zsh `execlist`'s `errexit = … || (ERRRETURN && !errreturn)`: `ERR_RETURN`
/// outside any function or `.` file of a non-interactive shell exits.
#[inline(never)]
fn zsh_errreturn_exits(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	let nested = vp.frames.iter().any(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	!nested
		&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errreturn).unwrap_or(false)
		&& !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Interactive).unwrap_or(false)
}

/// zsh `TRY_BLOCK_ERROR`: 1 while an always-list runs after an error in its
/// try-list, 0 in another always-list, -1 outside any. Read by the zsh
/// parameter code.
pub fn try_block_error(vp: &Vproc) -> i64 {
	vp.frames
		.iter()
		.rev()
		.flat_map(|f| f.loops.iter().rev())
		.find_map(|r| match r.kind {
			LoopKind::Try { always: true, pending } => Some(i64::from(pending == Some(TryEnd::Error))),
			_ => None,
		})
		.unwrap_or(-1)
}

/// Assign zsh `TRY_BLOCK_ERROR` in the innermost running always-list: 0
/// forgets the try-list's error (execution goes on after the always-list),
/// non-zero makes it one. `false` outside any always-list (nothing set).
pub fn set_try_block_error(vp: &mut Vproc, value: i64) -> bool {
	let rec = vp
		.frames
		.iter_mut()
		.rev()
		.flat_map(|f| f.loops.iter_mut().rev())
		.find(|r| matches!(r.kind, LoopKind::Try { always: true, .. }));
	let Some(LoopRec { kind: LoopKind::Try { pending, .. }, .. }) = rec else {
		return false;
	};
	if value == 0 {
		if *pending == Some(TryEnd::Error) {
			*pending = None;
		}
	} else if pending.is_none() {
		*pending = Some(TryEnd::Error);
	}
	true
}

/// Start zsh's function trap for `key` (`TRAPINT`, `TRAPZERR`, `TRAPEXIT`,
/// …: zsh `ZSIG_FUNC`), if that function is defined under one of the
/// signal's names ([`builtins::trap::find_func_trap`]).
#[inline(never)]
fn start_func_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	let platform = k.engine.config().platform;
	match builtins::trap::find_func_trap(cx.store, vp, key, platform, |name, rec| {
		(name, rec.clone())
	}) {
		Ok(Some((name, rec))) => run_func_trap(k, vp, cx, key, name, rec),
		Ok(None) => false,
		Err(err) => {
			k.fail(err);
			false
		},
	}
}

/// zsh `dotrapargs` for a function trap: a trap frame without text, and
/// on top of it the call of `rec` (function `name`) with the signal number
/// as `$1`. A non-zero return forces a return from the interrupted code
/// (handled when the trap frame ends).
fn run_func_trap(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	key: TrapKey,
	name: BString,
	rec: Record,
) -> bool {
	let mode = vp.mode;
	if !push_trap(k, vp, cx, key, b"", mode) {
		return false;
	}
	let number = builtins::trap::zsh_number(key, k.engine.config().platform);
	let line = current_line(vp);
	// A lost body leaves the empty trap frame, which ends at once.
	command::call_record(k, vp, cx, name, &rec, vec![BString::from(number.to_string())], line);
	true
}

#[cfg(test)]
mod tests {
	use super::{BASH_TIMEFORMAT, POSIX_TIMEFORMAT, time_report};

	// Golden: bash 5.3.20 `time -p` and the default format.
	#[test]
	fn time_p_is_posix_format() {
		let t = [1_234_000_000, 5_000_000, 0];
		assert_eq!(time_report(POSIX_TIMEFORMAT, t).unwrap(), b"real 1.23\nuser 0.01\nsys 0.00\n");
		let t = [61_500_000_000, 0, 1_000_000];
		assert_eq!(
			time_report(BASH_TIMEFORMAT, t).unwrap(),
			b"\nreal\t1m1.500s\nuser\t0m0.000s\nsys\t0m0.001s\n"
		);
	}

	// bash `print_formatted_time`: precision 0 has no point, `%%` is a
	// percent sign, `%P` the CPU share, an unknown letter is an error.
	#[test]
	fn timeformat_precision_percent_and_errors() {
		let t = [2_000_000_000, 500_000_000, 500_000_000];
		assert_eq!(time_report(b"%0R %%%P %1lU", t).unwrap(), b"2 %50.00 0m0.5s\n");
		assert_eq!(time_report(b"%3x", t), Err(b'x'));
		assert_eq!(time_report(b"", t).unwrap(), b"\n");
	}
}
