//! The `kill` builtin: virtual processes stay on the shell's signal bus;
//! other pids go to
//! [`Host::signal_process`](crate::bash::Host::signal_process).

use std::fmt::Write as _;

use bstr::{BString, ByteSlice};
use strum::IntoEnumIterator;

use super::{Ctx, R, done};
use crate::bash::{
	ControlHandle, Platform, SigTarget, Signal, Vpid,
	diag::Diag,
	vm::proc::{JobLookup, JobState},
};

/// What `kill` sends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Send {
	/// Signal 0: check that the target exists, deliver nothing.
	Probe,
	/// A signal.
	Signal(Signal),
}

impl Send {
	pub(super) const fn signal(self) -> Option<Signal> {
		match self {
			Self::Probe => None,
			Self::Signal(sig) => Some(sig),
		}
	}
}

/// A signal operand: a number (0 probes) or a name with or without `SIG`.
fn parse_signal(spec: &[u8], platform: Platform) -> Option<Send> {
	if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) && spec.iter().all(|&c| c == b'0') {
		return Some(Send::Probe);
	}
	Signal::parse_spec(spec, platform).map(Send::Signal)
}

/// Why a target could not be signalled.
pub(super) enum TargetError {
	/// `%n` names no live job (zsh), or no job (bash).
	NoSuchJob,
	/// bash: `%n` names a finished job started under job control, whose
	/// process group (this pid) is gone (bash's `killpg` fails with
	/// `ESRCH`).
	GroupGone(u32),
	/// zsh `getjob` already reported the bad spec.
	Reported,
	/// Neither a number nor a job spec.
	NotAnId,
	/// A vpid that is not a child of this shell.
	NoSuchProcess,
	/// The host refused or failed.
	Host(std::io::Error),
}

/// `kill [-s sig | -n num | -sig] pid|%job …`, `kill -l [sig …]`.
pub fn kill(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	let mut send = Send::Signal(Signal::Term);
	let mut i = 0;
	if let Some(first) = args.first() {
		let first = first.as_slice();
		if first == b"-l" || first == b"-L" {
			return list(ctx, &args[1..]);
		}
		if first == b"--" {
			i = 1;
		} else if first.starts_with(b"-s") || first.starts_with(b"-n") {
			let attached = &first[2..];
			let spec = if attached.is_empty() {
				let Some(spec) = args.get(1) else {
					ctx.usage(format!("{}: option requires an argument", first.as_bstr()));
					return done(2);
				};
				i = 2;
				spec.as_slice()
			} else {
				i = 1;
				attached
			};
			let numeric = first[1] == b'n';
			let parsed = if numeric && !spec.iter().all(u8::is_ascii_digit) {
				None
			} else {
				parse_signal(spec, platform)
			};
			let Some(parsed) = parsed else {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.into() });
				return done(1);
			};
			send = parsed;
			if args.get(i).is_some_and(|a| a.as_slice() == b"--") {
				i += 1;
			}
		} else if first.starts_with(b"-") && first.len() > 1 {
			let Some(parsed) = parse_signal(&first[1..], platform) else {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: first[1..].into() });
				return done(1);
			};
			send = parsed;
			i = 1;
			if args.get(i).is_some_and(|a| a.as_slice() == b"--") {
				i += 1;
			}
		}
	}
	if i == args.len() {
		ctx.builtin_usage();
		return done(2);
	}
	let mut status = 0;
	// The job a `%n` names is judged by its state, and a pid by whether that
	// process ended: the exits already available count first, as in bash,
	// whose job states follow its children's exits at once. A program's
	// process is gone only once its vproc took its exit in (the waiter does
	// not reap it), so a pid `kill` finds gone is one whose end the job's
	// vprocs take in now: also a pipeline's first program, whose stage
	// vproc has ended and no longer names it.
	if args[i..].iter().any(|a| a.starts_with(b"%") || is_pid(a)) {
		super::jobs::take_in_exits(ctx)?;
	}
	// A job is signalled as the process bash forked for it at `&`. One whose
	// pid is still to be settled (obash spawns its program lazily,
	// [`crate::bash::vm::proc::Bang`]) has no process yet: its signal waits
	// for that decision ([`held`]), and `kill` goes on. It reaches the
	// program the job spawns, whose pid the notice names, as bash's does; or,
	// when the job spawns none (a builtin, a command not found, a program
	// that cannot run), the job before it runs its command, as bash's child
	// has it before it `exec`s or fails to.
	for arg in &args[i..] {
		if held(ctx, arg, send) {
			continue;
		}
		match target(ctx, arg, send, None) {
			Ok(Some(target)) => {
				if let Some(sig) = send.signal() {
					ControlHandle(ctx.k.ctl.clone()).signal(target, sig);
				}
			},
			Ok(None) => {},
			Err(err) => {
				let msg = match err {
					TargetError::Reported => {
						status = 1;
						continue;
					},
					TargetError::NoSuchJob => format!("{}: no such job", arg.as_bstr()),
					TargetError::NotAnId => {
						// bash `sh_badpid`.
						format!("`{}': not a pid or valid job spec", arg.as_bstr())
					},
					TargetError::NoSuchProcess => format!("({}) - No such process", arg.as_bstr()),
					TargetError::GroupGone(pid) => format!("({pid}) - No such process"),
					TargetError::Host(e) => {
						format!("({}) - {}", arg.as_bstr(), crate::bash::diag::strerror(&e))
					},
				};
				ctx.usage(msg);
				status = 1;
			},
		}
	}
	done(status)
}

/// Whether `arg` is a pid operand (digits, with a leading `-` for a process
/// group): `kill` takes in the exits already available before it signals
/// one.
fn is_pid(arg: &[u8]) -> bool {
	let digits = arg.strip_prefix(b"-").unwrap_or(arg);
	!digits.is_empty() && digits.iter().all(u8::is_ascii_digit)
}

/// Resolve one operand: a virtual process to signal on the bus
/// (`Ok(Some)`), an OS process the host signalled itself (`Ok(None)`), or
/// an error. `zsh`: zsh dialect, with `POSIX_BUILTINS`.
pub(super) fn target(
	ctx: &mut Ctx<'_, '_>,
	arg: &[u8],
	send: Send,
	zsh: Option<bool>,
) -> Result<Option<SigTarget>, TargetError> {
	if arg.starts_with(b"%") {
		let number = match zsh {
			Some(posix) => super::zsh_jobs::getjob(ctx, arg, posix).ok_or(TargetError::Reported)?,
			None => super::jobs::spec(ctx, arg).map_err(|_| TargetError::NoSuchJob)?,
		};
		let job = ctx.vp.jobs.get_mut(number).ok_or(TargetError::NoSuchJob)?;
		// bash `kill_pid`: the job's state is news again (`jobs -n` lists
		// it).
		if zsh.is_none() {
			job.notified = false;
		}
		// A foreground job's processes are the shell's children, and its
		// vproc names only the first of them: its state alone says it ended.
		if matches!(job.state, JobState::Done(_))
			|| (!job.foreground
				&& matches!(
					ctx.k.proc_state(ctx.cx.store, job.vpid),
					Some(crate::bash::vm::ProcState::Exited(_))
				)) {
			// bash's `kill` finds the job gone only once it reaped it: its
			// zombies take the signal. With job control `killpg` then finds
			// no process group, and a zsh `kill` no job, which the script
			// sees; without job control bash's `kill` succeeds whether it
			// reaped the job or not, so this one tells nothing of a reap
			// (three `kill -0 %1` before a plain `wait`, which bash's `wait`
			// still reports).
			if zsh.is_some() || job.control {
				job.unreaped = false;
			}
			if zsh.is_some() {
				return Err(TargetError::NoSuchJob);
			}
			// bash 5.3 `kill_pid` of a finished job still listed: without job
			// control it signals none of its processes (all gone) and
			// succeeds; with it `killpg` finds no process group.
			return if job.control {
				Err(TargetError::GroupGone(job.pid()))
			} else {
				Ok(None)
			};
		}
		// bash `kill_pid`: continuing a stopped job by `kill` acts like `bg`
		// (the job runs, the current job stays).
		if send == Send::Signal(Signal::Cont) && matches!(job.state, JobState::Stopped(_)) {
			job.set_running();
			job.notified = true;
		}
		let unreaped = ends(send) && !has_program(job);
		if unreaped {
			job.unreaped = true;
		}
		let id = job.id;
		if unreaped {
			ctx.vp.jobs.unreaped_marked();
		}
		return Ok(Some(SigTarget::Job(id)));
	}
	let pid = std::str::from_utf8(arg)
		.ok()
		.and_then(|s| s.parse::<i32>().ok())
		.ok_or(TargetError::NotAnId)?;
	let base = ctx.k.engine.config().vpid_base;
	// A job's (or `$!`'s) program OS pid names the job's vproc: the signal
	// reaches the program through it, and the job's state follows. A
	// pipeline's `$!` names its last program, run by that stage's vproc.
	let named = u32::try_from(pid)
		.ok()
		.filter(|&p| p > 0)
		.map(|p| ctx.k.pid_owner(p).unwrap_or_else(|| ctx.vp.vpid_of(p)));
	let live = named.filter(|&v| {
		let st = ctx.k.proc_state(ctx.cx.store, v);
		// `$!` of a job the scheduler has not adopted yet (one `disown`
		// dropped in the same turn) has no record yet. Once adopted, a
		// child with no record is gone: its status was collected (`wait`)
		// or kept for `wait PID` when its job left the table.
		(ctx.vp.jobs.by_vpid(v).is_some()
			|| st == Some(crate::bash::vm::ProcState::Running)
			|| (st.is_none() && ctx.vp.last_bg.is(v) && ctx.k.spawned.iter().any(|p| p.vpid == v)))
			&& !matches!(st, Some(crate::bash::vm::ProcState::Exited(_)))
	});
	// The job `kill` names ([`crate::bash::store::Job::unreaped`]): one
	// it ends that has no program yet, or one it finds gone, which bash's
	// `kill` (that still finds a zombie) finds gone only once it reaped it.
	if let Some(job) = named.and_then(|v| ctx.vp.jobs.by_vpid_mut(v)) {
		match live {
			Some(_) if ends(send) && !has_program(job) => {
				job.unreaped = true;
				ctx.vp.jobs.unreaped_marked();
			},
			Some(_) => {},
			None => job.unreaped = false,
		}
	}
	match u32::try_from(pid) {
		Ok(p) if p > 0 && p == ctx.k.shell_pid => Ok(Some(SigTarget::Vpid(Vpid(base)))),
		Ok(p) if p > 0 && p == ctx.vp.vpid.0 => Ok(Some(SigTarget::Vpid(ctx.vp.vpid))),
		Ok(_) if live.is_some() => Ok(live.map(SigTarget::Vpid)),
		// A finished job's program pid may already name another process.
		Ok(p) if p >= base || named.is_some_and(|v| v.0 != p) => Err(TargetError::NoSuchProcess),
		_ => ctx
			.cx
			.host
			.signal_process(pid, send.signal())
			.map(|()| None)
			.map_err(TargetError::Host),
	}
}

/// Leave `send` for the decision of the job `arg` names, when it is a
/// `%job` whose pid is still to be settled
/// ([`crate::bash::vm::Kernel::hold_signal`]). Not for a job stopped or done
/// undecided, which runs to no decision, nor for a pid operand, which names
/// a job by a pid the shell showed: `$!` and `jobs -l` settle it first.
/// Whether it did; `kill -0` leaves nothing (the job exists).
fn held(ctx: &mut Ctx<'_, '_>, arg: &[u8], send: Send) -> bool {
	let Some(rest) = arg.strip_prefix(b"%") else {
		return false;
	};
	let JobLookup::Job(number) = ctx.vp.jobs.lookup(rest) else {
		return false;
	};
	let Some(job) = ctx.vp.jobs.get_mut(number) else {
		return false;
	};
	if job.os_pid.is_some()
		|| !ctx.k.bang_pending(job.vpid)
		|| matches!(job.state, JobState::Stopped(_) | JobState::Done(_))
	{
		return false;
	}
	let (vpid, control) = (job.vpid, job.control);
	let Some(sig) = send.signal() else {
		return true;
	};
	ctx.k.hold_signal(vpid, sig);
	if ends(send) {
		// Ended in obash's kernel if it spawns no program; one it spawns ends
		// as the host reaps it, which may come after the next foreground
		// command, where bash reaped it ([`crate::bash::store::Job::doomed`]).
		// The table is told, as at `target`'s marks, so that that command
		// reaps it also when one ran before this `kill`
		// ([`crate::bash::vm::proc::JobTable::all_reaped`]).
		let doomed = dooms(ctx, sig, control);
		if let Some(job) = ctx.vp.jobs.get_mut(number) {
			job.unreaped = true;
			job.doomed |= doomed;
		}
		ctx.vp.jobs.unreaped_marked();
	}
	true
}

/// Whether `send` ends a process that neither traps nor ignores it
/// ([`crate::bash::store::Job::unreaped`]).
fn ends(send: Send) -> bool {
	matches!(send, Send::Signal(sig) if sig.default_action() == crate::bash::signal::DefaultAction::Terminate)
}

/// Whether `sig`, a signal that ends a process ([`ends`]), held for the
/// pid decision of a job started with job control on or off (`control`)
/// ends the job whatever it runs ([`crate::bash::store::Job::doomed`]):
/// `KILL`, or one the job does not inherit ignored: no `trap '' SIG` here
/// and not ignored when the shell started. `INT` only for a job started
/// with job control, which has no asynchronous command's ignore unless this
/// shell ignores it for what it starts
/// ([`crate::bash::vm::exec::async_ignored`]); without job control bash's
/// child dies of it before it sets the ignore on some hosts and not on
/// others. Never `QUIT`: bash 5.3.20's job outlives it with job control
/// too.
fn dooms(ctx: &mut Ctx<'_, '_>, sig: Signal, control: bool) -> bool {
	if sig == Signal::Kill {
		return true;
	}
	if sig == Signal::Quit
		|| ctx.cx.host.ignored_signals().contains(sig)
		|| crate::bash::vm::killed::ignored_by_trap(ctx.cx, ctx.vp, sig)
	{
		return false;
	}
	sig != Signal::Int
		|| (control
			&& matches!(
				crate::bash::vm::exec::async_ignored(ctx.cx.store, ctx.vp, sig, true),
				Ok(false)
			))
}

/// Whether each process of `job` is a program obash spawned (its OS pid
/// known): a signal reaches it there and the job ends as the host reaps
/// it. Else `kill` ends the job's vproc, or a stage's, at once, with no OS
/// status to reap ([`crate::bash::store::Job::unreaped`]).
fn has_program(job: &crate::bash::store::Job) -> bool {
	match job.procs.as_deref() {
		Some(procs) => procs.list.iter().all(|p| p.os_pid.is_some()),
		None => job.os_pid.is_some(),
	}
}

/// `kill -l [sig …]`: the signal table, or names for numbers (statuses
/// above 128 map to their signal) and numbers for names.
pub fn list(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	if args.is_empty() {
		let mut signals: Vec<_> = Signal::iter().filter(|s| s.number(platform) != 0).collect();
		signals.sort_by_key(|s| s.number(platform));
		// bash `display_signal_list`: five `N) SIGNAME` per line, tab
		// separated; POSIX mode lists bare names on one line.
		let posix = ctx.option(crate::bash::store::OptId::Posix)?;
		let mut text = String::new();
		if posix {
			let names: Vec<String> = signals.iter().map(ToString::to_string).collect();
			text.push_str(&names.join(" "));
			text.push('\n');
		} else {
			for (i, s) in signals.iter().enumerate() {
				let _ = write!(text, "{:2}) SIG{s}", s.number(platform));
				text.push(if (i + 1).is_multiple_of(5) {
					'\n'
				} else {
					'\t'
				});
			}
			if !signals.len().is_multiple_of(5) {
				text.push('\n');
			}
		}
		ctx.out(text.as_bytes());
		return done(0);
	}
	let mut status = 0;
	for spec in args {
		let number = std::str::from_utf8(spec)
			.ok()
			.and_then(|s| s.parse::<u16>().ok());
		let sig = match number {
			Some(n) => {
				let n = if n > 128 { n - 128 } else { n };
				u8::try_from(n)
					.ok()
					.and_then(|n| Signal::from_number(n, platform))
			},
			None => Signal::parse_spec(spec, platform),
		};
		match sig {
			Some(sig) if number.is_some() => ctx.out(format!("{sig}\n").as_bytes()),
			Some(sig) => ctx.out(format!("{}\n", sig.number(platform)).as_bytes()),
			None => {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.clone() });
				status = 1;
			},
		}
	}
	done(status)
}
